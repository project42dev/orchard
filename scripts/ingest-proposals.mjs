#!/usr/bin/env node
// Close the loop: take what the authoring ensemble produced and move the work
// item that asked for it.
//
// Without this, the lifecycle is not a cycle. The queue proposes work, the
// ensemble writes and reviews it, and the result lands in a directory nobody
// reads. The queue never learns that anything happened, so the same item stays
// 'queued' forever and a human has to reconcile two lists by hand.
//
// What this does NOT do, on purpose:
//   - It never publishes. A proposal is inert until a human accepts it
//     (ADR-0004). This only records that a proposal exists and what its
//     reviewers concluded.
//   - It never overrides a human. A work item a person moved to 'rejected' or
//     'done' stays there. Automation may propose a state change and may not
//     perform one.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A reviewer's verdict maps to a queue state. 'blocked' is the interesting one:
// the ensemble did the work and its own reviewers refused it, which is a
// different situation from nobody having tried, and the queue has to be able to
// tell those apart or the same item is picked up again identically.
//
// 'ready-for-draft' is the ONLY pass disposition the delivery platform emits;
// it and 'blocked' are the two branches of a single ternary in
// Invoke-Project42Delivery.ps1. This map was written without it, so the first
// proposal the ensemble ever passed would have been reported as an unknown
// disposition and the item left queued. That is the failure this whole file
// exists to prevent, reintroduced on the happy path. The remaining keys are
// aliases kept for run records written by other tooling.
export const DISPOSITION_STATE = {
  blocked: 'blocked',
  'ready-for-draft': 'in-progress',
  ready: 'in-progress',
  'ready-for-review': 'in-progress',
  accepted: 'in-progress',
};

// States a human owns. A build or an ingest may never move an item out of one.
export const TERMINAL_STATES = new Set(['rejected', 'done']);

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

// A proposal names the brief it came from, not a queue row. Matching is by the
// brief id, so a brief authored for a queue item must carry that item's id.
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
  // A brief id that embeds a subject id, e.g. p42-create-<subject>.
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

// A subject id is not, on its own, a queue row.
//
// One subject can carry two work items at once, and routinely does: a module is
// created (needs-creating, done) and later a cited source moves and the same
// module is queued again (needs-updating). The table's own unique key is
// (kind, subject_id) and says so. Updating by subject id alone moved BOTH rows,
// so an update proposal reopened the completed creation, and the terminal-state
// guard read whichever row SQLite returned first.
//
// The brief id carries which kind it serves, because the generator puts it
// there. When it does not, and the subject has more than one open work item,
// the proposal is reported rather than applied to a guess.
export const KIND_MARKERS = [
  { marker: '-create-', kind: 'needs-creating' },
  { marker: '-update-', kind: 'needs-updating' },
];

export function resolveWorkItemRow(proposal, rows) {
  if (rows.length === 1) return { row: rows[0] };
  const ids = proposalIdentifiers(proposal);
  for (const { marker, kind } of KIND_MARKERS) {
    if (!ids.some((c) => c.includes(marker))) continue;
    const matched = rows.filter((r) => r.kind === kind);
    if (matched.length === 1) return { row: matched[0] };
  }
  return {
    ambiguous: `subject has ${rows.length} work items (${rows.map((r) => r.kind).join(', ')}) `
      + 'and the brief id does not say which one it serves',
  };
}

export function ingest({ dbPath, runRecordDir, now = new Date().toISOString(), apply = false }) {
  const db = new DatabaseSync(dbPath);
  const subjectIds = new Set(
    db.prepare('SELECT DISTINCT subject_id FROM work_item').all().map((r) => r.subject_id),
  );

  const getRows = db.prepare('SELECT id, kind, state, subject_id FROM work_item WHERE subject_id = ?');
  const update = db.prepare(
    'UPDATE work_item SET state = ?, note = ?, updated_at = ? WHERE id = ?',
  );

  const applied = [];
  const unmatched = [];
  const protectedItems = [];
  const unknownDisposition = [];

  for (const p of readProposals(runRecordDir)) {
    const disposition = p.doc?.disposition ?? p.doc?.status;
    const match = matchToWorkItem(p, subjectIds);

    if (!match) { unmatched.push({ file: p.file, disposition }); continue; }

    const next = DISPOSITION_STATE[disposition];
    if (!next) { unknownDisposition.push({ file: p.file, disposition }); continue; }

    const resolved = resolveWorkItemRow(p, getRows.all(match.subjectId));
    if (resolved.ambiguous) {
      unmatched.push({ file: p.file, disposition, reason: resolved.ambiguous });
      continue;
    }
    const { row } = resolved;

    if (TERMINAL_STATES.has(row.state)) {
      protectedItems.push({ subjectId: row.subject_id, kind: row.kind, state: row.state, file: p.file });
      continue;
    }

    const note = `${disposition} by the authoring ensemble, ${p.file}`;
    if (apply) update.run(next, note, now, row.id);
    applied.push({
      subjectId: match.subjectId, kind: row.kind, from: row.state, to: next, via: match.via, file: p.file,
    });
  }

  db.close();
  return { applied, unmatched, protectedItems, unknownDisposition };
}

// ---------------------------------------------------------------------------
// ADO state sync: after ingest moves work items, push state changes to ADO.
// Called from main() when --ado-sync is passed.
// ---------------------------------------------------------------------------
function syncAdoStates({ dbPath, org, project, applied, apply }) {
  if (applied.length === 0) return;

  const adoIds = [];
  const db2 = new DatabaseSync(dbPath);
  try {
    for (const a of applied) {
      const row = db2.prepare('SELECT ado_id FROM work_item WHERE id = ?').get(a.subjectId)
        || db2.prepare('SELECT ado_id FROM work_item WHERE subject_id = ?').get(a.subjectId);
      if (row?.ado_id) adoIds.push({ adoId: row.ado_id, subjectId: a.subjectId, to: a.to });
    }
  } finally {
    db2.close();
  }

  if (adoIds.length === 0) {
    console.log('  (no ADO IDs to sync — items may not have been mirrored yet)');
    return;
  }

  console.log(`  ADO sync: updating ${adoIds.length} work item(s)...`);
  for (const { adoId, subjectId, to } of adoIds) {
    const adoState = { queued: 'New', claimed: 'Active', 'in-progress': 'Active', blocked: 'Active' }[to] || 'Active';
    try {
      if (apply) {
        execSync(
          `az boards work-item update --id ${adoId} --org "https://dev.azure.com/${org}" --state "${adoState}" --output json`,
          { encoding: 'utf-8', timeout: 15_000 }
        );
      }
      console.log(`    ${apply ? '✅' : '[DRY RUN]'} ${subjectId} (ADO #${adoId}) -> ${adoState}`);
    } catch (err) {
      console.error(`    ❌ ${subjectId} (ADO #${adoId}): ${err.stderr || err.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args['run-records']) {
    console.error('usage: ingest-proposals.mjs --db <content.db> --run-records <dir> [--apply]');
    process.exit(2);
  }
  const r = ingest({
    dbPath: resolve(args.db),
    runRecordDir: resolve(args['run-records']),
    apply: Boolean(args.apply),
  });

  console.log(`${r.applied.length} work item(s) ${args.apply ? 'moved' : 'would move'}`);
  for (const a of r.applied) console.log(`  ${a.subjectId} [${a.kind}]: ${a.from} -> ${a.to} (${a.via})`);

  if (r.protectedItems.length) {
    console.log(`\n${r.protectedItems.length} left alone, because a human already decided:`);
    for (const p of r.protectedItems) console.log(`  ${p.subjectId} [${p.kind}] is ${p.state}`);
  }
  if (r.unknownDisposition.length) {
    console.log(`\n${r.unknownDisposition.length} proposal(s) with a disposition this tool does not know:`);
    for (const u of r.unknownDisposition) console.log(`  ${u.file}: "${u.disposition}"`);
  }
  if (r.unmatched.length) {
    console.log(`\n${r.unmatched.length} proposal(s) NOT MATCHED to any queue item, so nothing was recorded for them:`);
    for (const u of r.unmatched) console.log(`  ${u.file}${u.reason ? `: ${u.reason}` : ''}`);
    console.log('  A brief written for a queue item must carry that item\'s subject id, or');
    console.log('  the loop stays open and a human reconciles two lists by hand.');
    console.log('  scripts/generate-briefs.mjs writes briefs that carry it.');
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');

  // Sync ADO states if requested
  if (args['ado-sync'] && r.applied.length > 0) {
    const org = args['ado-org'] || 'hybridcloudsolutions';
    const project = args['ado-project'] || 'Project 42';
    syncAdoStates({
      dbPath: resolve(args.db),
      org,
      project,
      applied: r.applied,
      apply: Boolean(args.apply),
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
