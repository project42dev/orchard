#!/usr/bin/env node
// Record that a human accepted a proposal and the content landed.
//
// This closes the third broken handoff. The ensemble writes a proposal, a
// person reads it and commits the content, and until now nothing anywhere
// recorded which run produced what. Git shows who committed a file; it cannot
// say which ensemble run wrote it, under which brief, or what its reviewers
// concluded. So the day a model is found to be producing bad content there is
// no list of what to re-check, and the day a reviewer asks where a claim came
// from the answer is a hunt through a file share.
//
// THIS IS A HUMAN'S TOOL, and the shape of it says so:
//   - --accepted-by is required and has no default. A publication with no named
//     accepter is an automated publication, and this pipeline does not do those
//     (ADR-0004: it proposes only).
//   - It moves the work item to 'done', which is a terminal state a build may
//     never write. That is exactly why a person runs this and a build does not.
//   - It refuses an item a person already moved to 'rejected'. Reversing that
//     is a decision, not a bookkeeping step.

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readProposals, matchToWorkItem } from './ingest-proposals.mjs';

export class PublicationError extends Error {
  constructor(detail, fix) {
    super(detail);
    this.name = 'PublicationError';
    this.detail = detail;
    this.fix = fix;
  }
}

// The proposal that produced this subject's content, newest last so a re-run
// supersedes an earlier attempt.
export function findProposalFor(subjectId, runRecordDir) {
  const set = new Set([subjectId]);
  let found = null;
  for (const p of readProposals(runRecordDir)) {
    const match = matchToWorkItem(p, set);
    if (match?.subjectId === subjectId) found = p;
  }
  return found;
}

export function recordPublication({
  dbPath,
  subjectId,
  acceptedBy,
  runRecordDir = null,
  itemId = null,
  kind = null,
  note = null,
  now = new Date().toISOString(),
  apply = false,
}) {
  if (!acceptedBy) {
    throw new PublicationError(
      'no --accepted-by',
      'name the person who accepted the proposal. An unattributed publication is an automated one.',
    );
  }

  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id, kind, state, title FROM work_item WHERE subject_id = ?')
      .all(subjectId)
      .filter((r) => !kind || r.kind === kind);
    if (!rows.length) {
      throw new PublicationError(
        `no work item with subject id "${subjectId}"${kind ? ` and kind "${kind}"` : ''}`,
        'check the id against v_queue. A publication is recorded against the queue item it closes.',
      );
    }
    // One subject can carry a completed creation and an open update at the same
    // time. Closing the wrong one marks work done that nobody did.
    if (rows.length > 1) {
      throw new PublicationError(
        `subject "${subjectId}" has ${rows.length} work items (${rows.map((r) => r.kind).join(', ')})`,
        'pass --kind needs-creating or --kind needs-updating to say which one this publication closes.',
      );
    }
    const item = rows[0];
    if (item.state === 'rejected') {
      throw new PublicationError(
        `work item "${subjectId}" is rejected, which is terminal`,
        'a person rejected this. Reversing it is a decision, not a bookkeeping step, and this tool will not make it.',
      );
    }

    const proposal = runRecordDir ? findProposalFor(subjectId, runRecordDir) : null;

    // A publication with no proposal behind it is legitimate: content written
    // by hand still deserves a provenance row saying so, and saying that no
    // ensemble ran is more useful than leaving a gap that reads the same as
    // "we never looked".
    const row = {
      subject_id: subjectId,
      item_id: itemId,
      run_id: proposal?.runId ?? null,
      brief_id: proposal?.doc?.briefId ?? null,
      proposal_file: proposal?.file ?? null,
      proposal_digest: proposal?.doc?.proposalDigest ?? null,
      disposition: proposal?.doc?.disposition ?? null,
      accepted_by: acceptedBy,
      published_at: now,
      note: note ?? (proposal ? null : 'no ensemble proposal found; recorded as hand-authored'),
    };

    if (apply) {
      db.prepare(
        `INSERT INTO publication
           (subject_id, item_id, run_id, brief_id, proposal_file, proposal_digest,
            disposition, accepted_by, published_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject_id, run_id, proposal_file) DO UPDATE SET
           item_id = excluded.item_id,
           accepted_by = excluded.accepted_by,
           published_at = excluded.published_at,
           note = excluded.note`,
      ).run(
        row.subject_id, row.item_id, row.run_id, row.brief_id, row.proposal_file,
        row.proposal_digest, row.disposition, row.accepted_by, row.published_at, row.note,
      );
      db.prepare(
        "UPDATE work_item SET state = 'done', note = ?, updated_at = ? WHERE id = ?",
      ).run(`published by ${acceptedBy}${row.run_id ? `, from run ${row.run_id}` : ''}`, now, item.id);
    }

    return { row, workItem: item, from: item.state, to: 'done', proposal };
  } finally {
    db.close();
  }
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.subject || !args['accepted-by']) {
    console.error('usage: record-publication.mjs --db <content.db> --subject <subject-id> --accepted-by <name>');
    console.error('       [--run-records <dir>] [--item-id <id>] [--kind needs-creating|needs-updating]');
    console.error('       [--note <text>] [--apply]');
    process.exit(2);
  }

  let r;
  try {
    r = recordPublication({
      dbPath: resolve(args.db),
      subjectId: args.subject,
      acceptedBy: args['accepted-by'] === true ? null : args['accepted-by'],
      runRecordDir: args['run-records'] && args['run-records'] !== true ? resolve(args['run-records']) : null,
      itemId: args['item-id'] && args['item-id'] !== true ? args['item-id'] : null,
      kind: args.kind && args.kind !== true ? args.kind : null,
      note: args.note && args.note !== true ? args.note : null,
      apply: Boolean(args.apply),
    });
  } catch (err) {
    if (err instanceof PublicationError) {
      console.error(`REFUSING. ${err.detail}`);
      console.error(`  ${err.fix}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`${r.workItem.title}`);
  console.log(`  subject     ${r.row.subject_id}`);
  console.log(`  work item   ${r.from} -> ${r.to}`);
  if (r.proposal) {
    console.log(`  run         ${r.row.run_id}`);
    console.log(`  proposal    ${r.row.proposal_file} (${r.row.disposition})`);
  } else {
    console.log('  proposal    none found. Recorded as hand-authored, which is a fact worth having.');
  }
  console.log(`  accepted by ${r.row.accepted_by}`);

  if (r.row.disposition === 'blocked') {
    console.log('\nNOTE: the ensemble\'s own reviewers BLOCKED this proposal, and a human is publishing it');
    console.log('anyway. That is allowed and it is recorded. The disposition is kept as it was.');
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
