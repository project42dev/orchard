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
// SCHEMA. This tool targets workflow_item and publication_transaction from
// schema/migrations/002, the ONLY tables the deployed database has. The first
// version wrote into `publication` from schema/content-db.sql, which no
// migration ever applies, so it would have failed `no such table` on first
// use against production data.
//
// WHAT CHANGED WITH THE SCHEMA, and why. publication_transaction is immutable
// engine evidence: every row binds a protected Gate 2 approval, an artifact
// digest, and an ADO link, and the state store refuses a row without them.
// A human cannot hand-write one, by design. What a human CAN truthfully
// record is the acceptance itself, so this tool:
//   - reads the item's publication transactions and reports them
//   - records the named acceptance as immutable observation evidence bound to
//     the item revision (`orchard/manual-acceptance/...`)
//   - never moves lifecycle state: 'published' is reached only through the
//     publication engine's acknowledged transaction, and pretending otherwise
//     is exactly the push-equals-publication defect verify-published-live.mjs
//     exists to catch.
//
// THIS IS A HUMAN'S TOOL, and the shape of it says so:
//   - --accepted-by is required and has no default. A publication with no named
//     accepter is an automated publication, and this pipeline does not do those
//     (ADR-0004: it proposes only).
//   - It refuses an item at 'denied'. Reversing that is a decision, not a
//     bookkeeping step.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { readProposals, matchToWorkItem } from './ingest-proposals.mjs';

export class PublicationError extends Error {
  constructor(detail, fix) {
    super(detail);
    this.name = 'PublicationError';
    this.detail = detail;
    this.fix = fix;
  }
}

// The proposal that produced this item's content, newest last so a re-run
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

export async function recordPublication({
  dbPath,
  subjectId,
  acceptedBy,
  runRecordDir = null,
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

  const store = openStateStore(dbPath);
  try {
    const db = store.db;
    // A semantic identity can match several items since migration 006: at
    // most one live one plus any closed predecessors. A publication is
    // recorded against the live item, so closed matches sort last.
    const item = db.prepare(
      `SELECT item_id, track, outcome, current_state, current_revision, origin_run_id, semantic_identity
         FROM workflow_item WHERE item_id = ? OR semantic_identity = ?
        ORDER BY CASE WHEN current_state = 'closed' THEN 1 ELSE 0 END, updated_at DESC, item_id DESC
        LIMIT 1`,
    ).get(subjectId, subjectId);
    if (!item) {
      throw new PublicationError(
        `no workflow item matches "${subjectId}"`,
        'check the id against workflow_item. A publication is recorded against the lifecycle item it closes.',
      );
    }
    if (item.current_state === 'denied') {
      throw new PublicationError(
        `workflow item "${item.item_id}" is denied, which is terminal for this revision`,
        'a person denied this. Reversing it is a decision, not a bookkeeping step, and this tool will not make it.',
      );
    }

    const transactions = db.prepare(
      `SELECT transaction_id, item_revision, artifact_digest, target_repository, target_path, created_at
         FROM publication_transaction WHERE item_id = ? ORDER BY created_at DESC`,
    ).all(item.item_id);
    const transaction = transactions[0] ?? null;

    const proposal = runRecordDir ? findProposalFor(item.item_id, runRecordDir) : null;

    // An acceptance with no proposal behind it is legitimate: content written
    // by hand still deserves an evidence row saying so, and saying that no
    // ensemble ran is more useful than leaving a gap that reads the same as
    // "we never looked".
    const acceptance = {
      kind: 'manual-acceptance',
      item_id: item.item_id,
      item_revision: Number(item.current_revision),
      run_id: proposal?.runId ?? null,
      brief_id: proposal?.doc?.briefId ?? null,
      proposal_file: proposal?.file ?? null,
      proposal_digest: proposal?.doc?.proposalDigest ?? null,
      disposition: proposal?.doc?.disposition ?? null,
      publication_transaction_id: transaction?.transaction_id ?? null,
      accepted_by: acceptedBy,
      accepted_at: now,
      note: note ?? (proposal ? null : 'no ensemble proposal found; recorded as hand-authored'),
    };

    if (apply) {
      store.recordObservation({
        observation_id: generateUuidV7(),
        run_id: item.origin_run_id,
        item_id: item.item_id,
        item_revision: Number(item.current_revision),
        evidence_reference: `orchard/manual-acceptance/${item.item_id}:r${Number(item.current_revision)}`,
        evidence_digest: sha256Digest(acceptance),
        observed_at: now,
        acceptance,
      });
    }

    return { row: acceptance, workItem: item, state: item.current_state, proposal, transaction, transactions };
  } finally {
    store.close();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.subject || !args['accepted-by']) {
    console.error('usage: record-publication.mjs --db <state.db> --subject <item-id-or-semantic-identity> --accepted-by <name>');
    console.error('       [--run-records <dir>] [--note <text>] [--apply]');
    process.exit(2);
  }

  let r;
  try {
    r = await recordPublication({
      dbPath: resolve(args.db),
      subjectId: args.subject,
      acceptedBy: args['accepted-by'] === true ? null : args['accepted-by'],
      runRecordDir: args['run-records'] && args['run-records'] !== true ? resolve(args['run-records']) : null,
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

  console.log(`${r.workItem.item_id} [${r.workItem.outcome}]`);
  console.log(`  lifecycle    ${r.state}`);
  if (r.transaction) {
    console.log(`  transaction  ${r.transaction.transaction_id} -> ${r.transaction.target_repository}/${r.transaction.target_path}`);
  } else {
    console.log('  transaction  none. The publication engine has recorded nothing for this item;');
    console.log('               this acceptance is evidence of a hand publication, not a lifecycle change.');
  }
  if (r.proposal) {
    console.log(`  run          ${r.row.run_id}`);
    console.log(`  proposal     ${r.row.proposal_file} (${r.row.disposition})`);
  } else {
    console.log('  proposal     none found. Recorded as hand-authored, which is a fact worth having.');
  }
  console.log(`  accepted by  ${r.row.accepted_by}`);

  if (r.row.disposition === 'blocked') {
    console.log('\nNOTE: the ensemble\'s own reviewers BLOCKED this proposal, and a human is accepting it');
    console.log('anyway. That is allowed and it is recorded. The disposition is kept as it was.');
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
