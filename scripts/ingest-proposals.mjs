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
//   - It never publishes. A proposal is inert until both item-bound gates
//     approve the exact revision and artifact. This only records that a
//     proposal exists, what its reviewers concluded, and Gate 2 readiness.
//   - It never overrides a human. A work item a person moved to 'rejected' or
//     'done' stays there. Automation may propose a state change and may not
//     perform one.

import { DatabaseSync } from 'node:sqlite';
import { StateStore } from './lib/state-store.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './lib/identity.mjs';
import { prepareGate2Item } from './lib/handoffs.mjs';
import { validateDispatchAuthority } from './generate-briefs.mjs';

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
        runId: run.run_id ?? run.runId,
        binding: p.orchardBinding ?? p.binding,
        handoffs: p.handoffs,
        artifact: p.artifact,
        doc: {
          workItemId: p.workItemId,
          disposition: p.disposition,
        },
      });
    }
  }
  return out;
}

// A proposal must carry the exact queue work-item ID from its dispatch binding.
// Filenames, brief suffixes, and prose are evidence only and never authority.
export function matchToWorkItem(proposal, workItemIds) {
  const id = proposal.doc?.workItemId;
  return typeof id === 'string' && workItemIds.has(id) ? { workItemId: id, via: 'exact' } : null;
}

function proposalIdentifiers(proposal) {
  return [proposal.doc?.workItemId].filter((v) => typeof v === 'string');
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
  const matches = rows.filter((row) => row.id === proposal.doc?.workItemId);
  return matches.length === 1 ? { row: matches[0] } : { ambiguous: `exact work item ID resolved ${matches.length} rows` };
}

export async function ingest({ dbPath, runRecordDir, authorities = [], now = new Date().toISOString(), apply = false }) {
  const db = new DatabaseSync(dbPath);
  const authorityStore = new StateStore(db, { migrate: false });
  const workItemIds = new Set(
    db.prepare('SELECT id FROM work_item').all().map((r) => r.id),
  );
  const authorityByWorkItem = new Map(authorities.map((authority) => [authority.queue_work_item_id, authority]));
  const getRows = db.prepare('SELECT id, kind, state, subject_id FROM work_item WHERE id = ?');
  const update = db.prepare(
    'UPDATE work_item SET state = ?, note = ?, updated_at = ? WHERE id = ?',
  );

  const applied = [];
  const unmatched = [];
  const protectedItems = [];
  const unknownDisposition = [];
  const gate2Items = [];

  for (const p of readProposals(runRecordDir)) {
    const disposition = p.doc?.disposition ?? p.doc?.status;
    const match = matchToWorkItem(p, workItemIds);

    if (!match) { unmatched.push({ file: p.file, disposition }); continue; }

    const next = DISPOSITION_STATE[disposition];
    if (!next) { unknownDisposition.push({ file: p.file, disposition }); continue; }

    const resolved = resolveWorkItemRow(p, getRows.all(match.workItemId));
    if (resolved.ambiguous) {
      unmatched.push({ file: p.file, disposition, reason: resolved.ambiguous });
      continue;
    }
    const { row } = resolved;

    const authority = authorityByWorkItem.get(row.id);
    const authorized = validateDispatchAuthority(row, authority, authorityStore);
    if (authorized.error) { unmatched.push({ file: p.file, disposition, reason: authorized.error }); continue; }
    if (p.runId !== authorized.binding.run_id || canonicalJson(p.binding) !== canonicalJson(authorized.binding)) {
      unmatched.push({ file: p.file, disposition, reason: 'run or exact proposal binding mismatch' }); continue;
    }
    let gate2Item;
    try { gate2Item = await prepareGate2Item({ binding: authorized.binding, handoffs: p.handoffs, artifact: p.artifact }); }
    catch (error) { unmatched.push({ file: p.file, disposition, reason: error.message }); continue; }

    if (TERMINAL_STATES.has(row.state)) {
      protectedItems.push({ subjectId: row.subject_id, kind: row.kind, state: row.state, file: p.file });
      continue;
    }

    const note = `${disposition} by the authoring ensemble, ${p.file}`;
    if (apply) update.run(next, note, now, row.id);
    applied.push({
      workItemId: row.id, subjectId: row.subject_id, kind: row.kind, from: row.state, to: next, via: match.via, file: p.file,
    });
    gate2Items.push(gate2Item);
  }

  db.close();
  return { applied, unmatched, protectedItems, unknownDisposition, gate2Items };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args['run-records'] || !args.bindings) {
    console.error('usage: ingest-proposals.mjs --db <content.db> --run-records <dir> --bindings <approved-dispatch-bindings.json> [--apply]');
    process.exit(2);
  }
  const r = await ingest({
    dbPath: resolve(args.db),
    runRecordDir: resolve(args['run-records']),
    apply: Boolean(args.apply),
    authorities: args.bindings ? JSON.parse(readFileSync(resolve(args.bindings), 'utf8')) : [],
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

  console.log(`${r.gate2Items.length} exact item(s) prepared for Gate 2 manifest generation.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
