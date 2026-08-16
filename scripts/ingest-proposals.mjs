#!/usr/bin/env node
// Close the loop: take what the authoring ensemble produced and move the
// lifecycle item that asked for it.
//
// Without this, the lifecycle is not a cycle. The queue proposes work, the
// ensemble writes and reviews it, and the result lands in a directory nobody
// reads. The queue never learns that anything happened, so the same item stays
// 'executing' forever and a human has to reconcile two lists by hand.
//
// SCHEMA. This tool targets workflow_item from schema/migrations/002, the ONLY
// item table the deployed database has. The first version targeted work_item
// from schema/content-db.sql, which no migration ever applies, so the ingest
// would have failed `no such table` on first contact with production data.
//
// What this does NOT do, on purpose:
//   - It never publishes. A proposal is inert until a human accepts it
//     (ADR-0004). This only records that a proposal exists and what its
//     reviewers concluded.
//   - It never overrides a human. An item at a terminal or human-owned state
//     stays there. Automation may propose a state change and may not
//     perform one outside the lifecycle's legal transitions.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

// A reviewer's verdict maps to a lifecycle transition out of 'executing'.
// 'blocked' is the interesting one: the ensemble did the work and its own
// reviewers refused it, which is a different situation from nobody having
// tried, and the lifecycle has to be able to tell those apart or the same item
// is picked up again identically.
//
// 'ready-for-draft' is the ONLY pass disposition the delivery platform emits;
// it and 'blocked' are the two branches of a single ternary in
// Invoke-Project42Delivery.ps1. This map was written without it, so the first
// proposal the ensemble ever passed would have been reported as an unknown
// disposition and the item left executing. That is the failure this whole file
// exists to prevent, reintroduced on the happy path. The remaining keys are
// aliases kept for run records written by other tooling.
export const DISPOSITION_STATE = {
  blocked: 'blocked',
  'ready-for-draft': 'gate2-ready',
  ready: 'gate2-ready',
  'ready-for-review': 'gate2-ready',
  accepted: 'gate2-ready',
};

const TRANSITION_CAUSE = {
  'gate2-ready': 'artifact-ready',
  // The reviewers' refusal is a policy judgement about the content, which is
  // the closest of the four block causes the lifecycle defines.
  blocked: 'policy-block',
};

// States a human or the publication engine owns. An ingest may never move an
// item out of one.
export const TERMINAL_STATES = new Set(['published', 'closed', 'denied', 'superseded']);

// The only state an authoring result can legally arrive at.
const AUTHORING_STATE = 'executing';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

// The DISPOSITION lives in the run record, not in the proposal.
//
// That is deliberate on the platform's side and worth preserving: a proposal is
// an inert document about content, and whether the ensemble's reviewers accepted
// it is a fact about the RUN. Reading dispositions from run records also means a
// proposal file rewritten by a later run cannot retroactively change what an
// earlier run concluded.
//
// Run records are read newest last, so the most recent verdict wins.
export function readProposals(runRecordDir) {
  if (!existsSync(runRecordDir)) return [];
  const out = [];
  for (const f of readdirSync(runRecordDir).filter((n) => n.startsWith('run-') && n.endsWith('.json')).sort()) {
    let run;
    try { run = JSON.parse(readFileSync(join(runRecordDir, f), 'utf8')); } catch { continue; }
    for (const p of run.proposals ?? []) {
      out.push({
        file: basename(p.proposalPath ?? ''),
        runRecord: f,
        runId: run.runId,
        doc: {
          // The brief id is embedded in the proposal filename the platform
          // wrote, which is the only link back to what asked for the work.
          // When the run record carries an explicit briefId or workItemId
          // (e.g. local delivery runs), prefer those over the filename.
          briefId: p.briefId
            ?? basename(p.proposalPath ?? '')
              .replace(/^proposal-/, '')
              .replace(/-[0-9a-f]{8}\.json$/, ''),
          workItemId: p.workItemId,
          disposition: p.disposition,
          proposalDigest: p.proposalDigest,
        },
      });
    }
  }
  return out;
}

// A proposal names the brief it came from, not a lifecycle row. Matching is by
// the brief id, so a brief authored for an item must carry that item's id.
// When it does not, the proposal is reported as unmatched rather than guessed
// at: a wrong match writes a real state change onto the wrong content.
//
// Suffix matching takes the LONGEST match. Taking the first match out of a Set
// meant the answer depended on insertion order: given both 'embeddings-learn'
// and 'vector-embeddings-learn', a brief for the second resolved to whichever
// was inserted first. That is exactly the wrong-content state change the
// unmatched report exists to avoid, arrived at silently.
//
// The longest match is unique and needs no tie-break. Two different strings
// that are both suffixes of one string cannot be the same length.
export function matchToWorkItem(proposal, subjectIds) {
  const candidates = proposalIdentifiers(proposal);

  for (const c of candidates) {
    if (subjectIds.has(c)) return { subjectId: c, via: 'exact' };
  }
  // A brief id that embeds an item id, e.g. p42-create-<item_id>.
  for (const c of candidates) {
    let best = null;
    for (const s of subjectIds) {
      if (!c.endsWith(s)) continue;
      if (best === null || s.length > best.length) best = s;
    }
    if (best !== null) return { subjectId: best, via: 'suffix' };
  }
  return null;
}

function proposalIdentifiers(proposal) {
  return [
    proposal.doc?.workItemId,
    proposal.doc?.briefId,
    proposal.doc?.id,
    proposal.doc?.subjectId,
  ].filter((v) => typeof v === 'string');
}

export async function ingest({ dbPath, runRecordDir, now = new Date().toISOString(), apply = false, actor = 'orchard/ingest-proposals' }) {
  const store = openStateStore(dbPath);
  try {
    const db = store.db;
    const itemIds = new Set(
      db.prepare('SELECT item_id FROM workflow_item').all().map((r) => r.item_id),
    );

    const getRow = db.prepare(
      `SELECT item_id, outcome, current_state, current_revision, origin_run_id
         FROM workflow_item WHERE item_id = ?`,
    );

    const applied = [];
    const unmatched = [];
    const protectedItems = [];
    const unknownDisposition = [];

    // Run records are read newest last, so the most recent verdict per item
    // wins. Applying every verdict in order would also be wrong mechanically:
    // the lifecycle accepts exactly one transition out of 'executing', so the
    // second verdict for one item would fail its compare-and-swap.
    const verdicts = new Map();
    for (const p of readProposals(runRecordDir)) {
      const disposition = p.doc?.disposition ?? p.doc?.status;
      const match = matchToWorkItem(p, itemIds);

      if (!match) { unmatched.push({ file: p.file, disposition }); continue; }

      const next = DISPOSITION_STATE[disposition];
      if (!next) { unknownDisposition.push({ file: p.file, disposition }); continue; }

      verdicts.set(match.subjectId, { p, disposition, match, next });
    }

    for (const { p, disposition, match, next } of verdicts.values()) {
      const row = getRow.get(match.subjectId);

      if (TERMINAL_STATES.has(row.current_state)) {
        protectedItems.push({ subjectId: row.item_id, outcome: row.outcome, state: row.current_state, file: p.file });
        continue;
      }
      if (row.current_state !== AUTHORING_STATE) {
        unmatched.push({
          file: p.file, disposition,
          reason: `${row.item_id} is in state ${row.current_state}; only an ${AUTHORING_STATE} item can accept an authoring result`,
        });
        continue;
      }

      const note = `${disposition} by the authoring ensemble, ${p.file}`;
      if (apply) {
        const transition = {
          schema_version: '1.0.0',
          transition_id: generateUuidV7(),
          run_id: row.origin_run_id,
          item_id: row.item_id,
          item_revision: Number(row.current_revision),
          from_state: AUTHORING_STATE,
          to_state: next,
          cause: TRANSITION_CAUSE[next],
          actor,
          occurred_at: now,
          correlation_id: generateUuidV7(),
        };
        if (next === 'blocked') transition.reason = note;
        await store.recordTransition(transition);
      }
      applied.push({
        subjectId: match.subjectId, outcome: row.outcome, from: row.current_state, to: next, via: match.via, file: p.file,
      });
    }

    return { applied, unmatched, protectedItems, unknownDisposition };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// ADO state sync: after ingest moves items, push state changes to ADO.
// Called from main() when --ado-sync is passed. The ADO id lives in
// external_link, never on the item row.
// ---------------------------------------------------------------------------
function syncAdoStates({ dbPath, org, applied, apply }) {
  if (applied.length === 0) return;

  const adoIds = [];
  const store = openStateStore(dbPath);
  try {
    const link = store.db.prepare(
      `SELECT external_id FROM external_link
        WHERE provider = 'ado' AND item_id = ?
        ORDER BY item_revision DESC, linked_at DESC LIMIT 1`,
    );
    for (const a of applied) {
      const row = link.get(a.subjectId);
      if (row?.external_id) adoIds.push({ adoId: row.external_id, subjectId: a.subjectId, to: a.to });
    }
  } finally {
    store.close();
  }

  if (adoIds.length === 0) {
    console.log('  (no ADO links to sync, items may not have been mirrored yet)');
    return;
  }

  console.log(`  ADO sync: updating ${adoIds.length} work item(s)...`);
  for (const { adoId, subjectId, to } of adoIds) {
    const adoState = { 'gate2-ready': 'Active', blocked: 'Active' }[to] || 'Active';
    try {
      if (apply) {
        execSync(
          `az boards work-item update --id ${adoId} --org "https://dev.azure.com/${org}" --state "${adoState}" --output json`,
          { encoding: 'utf-8', timeout: 15_000 }
        );
      }
      console.log(`    ${apply ? 'updated' : '[DRY RUN]'} ${subjectId} (ADO #${adoId}) -> ${adoState}`);
    } catch (err) {
      console.error(`    FAILED ${subjectId} (ADO #${adoId}): ${err.stderr || err.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args['run-records']) {
    console.error('usage: ingest-proposals.mjs --db <state.db> --run-records <dir> [--apply]');
    process.exit(2);
  }
  const r = await ingest({
    dbPath: resolve(args.db),
    runRecordDir: resolve(args['run-records']),
    apply: Boolean(args.apply),
  });

  console.log(`${r.applied.length} item(s) ${args.apply ? 'moved' : 'would move'}`);
  for (const a of r.applied) console.log(`  ${a.subjectId} [${a.outcome}]: ${a.from} -> ${a.to} (${a.via})`);

  if (r.protectedItems.length) {
    console.log(`\n${r.protectedItems.length} left alone, because that state is human- or engine-owned:`);
    for (const p of r.protectedItems) console.log(`  ${p.subjectId} [${p.outcome}] is ${p.state}`);
  }
  if (r.unknownDisposition.length) {
    console.log(`\n${r.unknownDisposition.length} proposal(s) with a disposition this tool does not know:`);
    for (const u of r.unknownDisposition) console.log(`  ${u.file}: "${u.disposition}"`);
  }
  if (r.unmatched.length) {
    console.log(`\n${r.unmatched.length} proposal(s) NOT MATCHED to an executing item, so nothing was recorded for them:`);
    for (const u of r.unmatched) console.log(`  ${u.file}${u.reason ? `: ${u.reason}` : ''}`);
    console.log('  A brief written for a lifecycle item must carry that item\'s id, or');
    console.log('  the loop stays open and a human reconciles two lists by hand.');
    console.log('  scripts/generate-briefs.mjs writes briefs that carry it.');
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');

  // Sync ADO states if requested
  if (args['ado-sync'] && r.applied.length > 0) {
    const org = args['ado-org'] || 'hybridcloudsolutions';
    syncAdoStates({
      dbPath: resolve(args.db),
      org,
      applied: r.applied,
      apply: Boolean(args.apply),
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
