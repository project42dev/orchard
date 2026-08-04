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
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A reviewer's verdict maps to a queue state. 'blocked' is the interesting one:
// the ensemble did the work and its own reviewers refused it, which is a
// different situation from nobody having tried, and the queue has to be able to
// tell those apart or the same item is picked up again identically.
export const DISPOSITION_STATE = {
  blocked: 'blocked',
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
          briefId: basename(p.proposalPath ?? '')
            .replace(/^proposal-/, '')
            .replace(/-[0-9a-f]{8}\.json$/, ''),
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
export function matchToWorkItem(proposal, subjectIds) {
  const candidates = [
    proposal.doc?.workItemId,
    proposal.doc?.briefId,
    proposal.doc?.id,
    proposal.doc?.subjectId,
  ].filter((v) => typeof v === 'string');

  for (const c of candidates) {
    if (subjectIds.has(c)) return { subjectId: c, via: 'exact' };
  }
  // A brief id that embeds a subject id, e.g. p42-content-5112-<subject>.
  for (const c of candidates) {
    for (const s of subjectIds) {
      if (c.endsWith(s)) return { subjectId: s, via: 'suffix' };
    }
  }
  return null;
}

export function ingest({ dbPath, runRecordDir, now = new Date().toISOString(), apply = false }) {
  const db = new DatabaseSync(dbPath);
  const subjectIds = new Set(
    db.prepare('SELECT DISTINCT subject_id FROM work_item').all().map((r) => r.subject_id),
  );

  const getItem = db.prepare('SELECT id, state, subject_id FROM work_item WHERE subject_id = ?');
  const update = db.prepare(
    'UPDATE work_item SET state = ?, note = ?, updated_at = ? WHERE subject_id = ?',
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

    const row = getItem.get(match.subjectId);
    if (TERMINAL_STATES.has(row.state)) {
      protectedItems.push({ subjectId: row.subject_id, state: row.state, file: p.file });
      continue;
    }

    const note = `${disposition} by the authoring ensemble, ${p.file}`;
    if (apply) update.run(next, note, now, match.subjectId);
    applied.push({ subjectId: match.subjectId, from: row.state, to: next, via: match.via, file: p.file });
  }

  db.close();
  return { applied, unmatched, protectedItems, unknownDisposition };
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
  for (const a of r.applied) console.log(`  ${a.subjectId}: ${a.from} -> ${a.to} (${a.via})`);

  if (r.protectedItems.length) {
    console.log(`\n${r.protectedItems.length} left alone, because a human already decided:`);
    for (const p of r.protectedItems) console.log(`  ${p.subjectId} is ${p.state}`);
  }
  if (r.unknownDisposition.length) {
    console.log(`\n${r.unknownDisposition.length} proposal(s) with a disposition this tool does not know:`);
    for (const u of r.unknownDisposition) console.log(`  ${u.file}: "${u.disposition}"`);
  }
  if (r.unmatched.length) {
    console.log(`\n${r.unmatched.length} proposal(s) NOT MATCHED to any queue item, so nothing was recorded for them:`);
    for (const u of r.unmatched) console.log(`  ${u.file}`);
    console.log('  A brief written for a queue item must carry that item\'s subject id, or');
    console.log('  the loop stays open and a human reconciles two lists by hand.');
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
