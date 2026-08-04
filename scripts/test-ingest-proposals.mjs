#!/usr/bin/env node
// Tests for the two halves of the return path: what the ensemble concluded
// (ingest) and what a human then published (record-publication).
//
// The ingest shipped without tests, and the defect that hid there was the worst
// kind: it knew every disposition except the one the delivery platform actually
// emits when the ensemble PASSES. Everything worked on the failure path, so a
// run that blocked looked like proof the tool worked. The first proposal to
// pass would have been reported as an unknown disposition and its queue item
// left sitting in 'queued'. These tests exist so that cannot come back.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ingest, readProposals, matchToWorkItem, DISPOSITION_STATE, TERMINAL_STATES,
} from './ingest-proposals.mjs';
import { recordPublication, findProposalFor, PublicationError } from './record-publication.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'schema', 'content-db.sql');

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) { passed += 1; } else { failures.push(label); }
}

function equal(label, actual, expected) {
  check(`${label} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
    actual === expected);
}

const NOW = '2026-08-04T12:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'orchard-ingest-'));

function freshDb(name) {
  const path = join(root, `${name}.db`);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const insert = db.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, first_seen, updated_at)
     VALUES (?, 'needs-creating', ?, 'learn', ?, ?, ?, ?)`,
  );
  insert.run('create:alpha-learn', 'alpha-learn', 'Alpha', 'claimed', NOW, NOW);
  insert.run('create:beta-learn', 'beta-learn', 'Beta', 'claimed', NOW, NOW);
  insert.run('create:rejected-learn', 'rejected-learn', 'Rejected', 'rejected', NOW, NOW);
  insert.run('create:done-learn', 'done-learn', 'Done', 'done', NOW, NOW);
  db.close();
  return path;
}

function runRecords(name, records) {
  const dir = join(root, `runs-${name}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, doc] of Object.entries(records)) {
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
  return dir;
}

// --- the disposition the platform actually emits -------------------------------

{
  // Invoke-Project42Delivery.ps1 sets the packet disposition from a single
  // ternary: 'ready-for-draft' when the draft survives review, 'blocked' when
  // it does not. Those two strings are the entire vocabulary.
  equal('the platform\'s pass disposition is known, and moves the item to in-progress',
    DISPOSITION_STATE['ready-for-draft'], 'in-progress');
  equal('and its fail disposition is known, and is distinct from never having tried',
    DISPOSITION_STATE.blocked, 'blocked');

  const dbPath = freshDb('pass');
  const dir = runRecords('pass', {
    'run-20260804-000001-aaaa.json': {
      runId: 'run-20260804-000001-aaaa',
      proposals: [
        { proposalPath: '/x/proposal-p42-create-alpha-learn-1234abcd.json', disposition: 'ready-for-draft', proposalDigest: 'sha-a' },
        { proposalPath: '/x/proposal-p42-create-beta-learn-1234abcd.json', disposition: 'blocked', proposalDigest: 'sha-b' },
      ],
    },
  });

  const dry = ingest({ dbPath, runRecordDir: dir, now: NOW });
  equal('both proposals match their queue items', dry.applied.length, 2);
  equal('and nothing is an unknown disposition', dry.unknownDisposition.length, 0);
  equal('and nothing is unmatched', dry.unmatched.length, 0);

  const before = new DatabaseSync(dbPath);
  equal('a dry run writes nothing',
    before.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('alpha-learn').state, 'claimed');
  before.close();

  ingest({ dbPath, runRecordDir: dir, now: NOW, apply: true });
  const after = new DatabaseSync(dbPath);
  equal('a passed proposal moves its item to in-progress',
    after.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('alpha-learn').state, 'in-progress');
  equal('a blocked proposal moves its item to blocked, so it is not picked up again identically',
    after.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('beta-learn').state, 'blocked');
  check('and the note says which proposal said so',
    after.prepare('SELECT note FROM work_item WHERE subject_id = ?').get('beta-learn').note.includes('proposal-p42-create-beta-learn'));
  after.close();
}

// --- a human's decision is never overridden ------------------------------------

{
  check('rejected and done are the states a build may not write',
    TERMINAL_STATES.has('rejected') && TERMINAL_STATES.has('done'));

  const dbPath = freshDb('terminal');
  const dir = runRecords('terminal', {
    'run-1.json': {
      runId: 'run-1',
      proposals: [
        { proposalPath: '/x/proposal-p42-create-rejected-learn-1234abcd.json', disposition: 'ready-for-draft' },
        { proposalPath: '/x/proposal-p42-create-done-learn-1234abcd.json', disposition: 'blocked' },
      ],
    },
  });

  const r = ingest({ dbPath, runRecordDir: dir, now: NOW, apply: true });
  equal('nothing moves', r.applied.length, 0);
  equal('and both are reported as left alone because a person already decided', r.protectedItems.length, 2);

  const after = new DatabaseSync(dbPath);
  equal('a rejected item stays rejected even when the ensemble later passed it',
    after.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('rejected-learn').state, 'rejected');
  after.close();
}

// --- the newest verdict wins, and it is read from the run record ----------------

{
  const dbPath = freshDb('order');
  const dir = runRecords('order', {
    'run-20260804-000001-aaaa.json': {
      runId: 'first',
      proposals: [{ proposalPath: '/x/proposal-p42-create-alpha-learn-1111aaaa.json', disposition: 'blocked' }],
    },
    'run-20260804-000002-bbbb.json': {
      runId: 'second',
      proposals: [{ proposalPath: '/x/proposal-p42-create-alpha-learn-2222bbbb.json', disposition: 'ready-for-draft' }],
    },
  });

  ingest({ dbPath, runRecordDir: dir, now: NOW, apply: true });
  const after = new DatabaseSync(dbPath);
  equal('a later run supersedes an earlier verdict on the same subject',
    after.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('alpha-learn').state, 'in-progress');
  after.close();

  const proposals = readProposals(dir);
  equal('the disposition comes from the run record, so a rewritten proposal cannot change an old verdict',
    proposals[0].doc.disposition, 'blocked');
  equal('and the run id travels with it', proposals[1].runId, 'second');
}

// --- matching refuses to guess --------------------------------------------------

{
  const ids = new Set(['embeddings-learn', 'vector-embeddings-learn']);
  const ambiguous = matchToWorkItem({ doc: { briefId: 'p42-create-vector-embeddings-learn' } }, ids);
  equal('when a brief id ends with one subject id inside another, the longest wins',
    ambiguous?.subjectId, 'vector-embeddings-learn');

  const reversed = matchToWorkItem(
    { doc: { briefId: 'p42-create-vector-embeddings-learn' } },
    new Set([...ids].reverse()),
  );
  equal('and the answer does not depend on the order the subject ids were inserted',
    reversed?.subjectId, 'vector-embeddings-learn');
}

{
  const dbPath = freshDb('unmatched');
  const dir = runRecords('unmatched', {
    'run-1.json': {
      runId: 'run-1',
      proposals: [{ proposalPath: '/x/proposal-p42-content-5112-foundry-connect-guide-1234abcd.json', disposition: 'blocked' }],
    },
  });
  const r = ingest({ dbPath, runRecordDir: dir, now: NOW, apply: true });
  equal('a hand-written brief carrying no subject id matches nothing', r.applied.length, 0);
  equal('and is reported rather than guessed at', r.unmatched.length, 1);
}

// --- provenance ------------------------------------------------------------------

{
  const dbPath = freshDb('publish');
  const dir = runRecords('publish', {
    'run-1.json': {
      runId: 'run-20260804-061247-83e06e0b',
      proposals: [{
        proposalPath: '/x/proposal-p42-create-alpha-learn-1234abcd.json',
        disposition: 'ready-for-draft',
        proposalDigest: 'sha-alpha',
      }],
    },
  });

  const found = findProposalFor('alpha-learn', dir);
  equal('a subject id finds the proposal that was written for it', found?.doc?.briefId, 'p42-create-alpha-learn');

  const dry = recordPublication({ dbPath, subjectId: 'alpha-learn', acceptedBy: 'a person', runRecordDir: dir, now: NOW });
  equal('a dry run reports the move it would make', dry.to, 'done');
  const beforeDb = new DatabaseSync(dbPath);
  equal('and writes nothing', beforeDb.prepare('SELECT count(*) AS n FROM publication').get().n, 0);
  beforeDb.close();

  recordPublication({
    dbPath, subjectId: 'alpha-learn', acceptedBy: 'a person', runRecordDir: dir,
    itemId: 'alpha-learn', now: NOW, apply: true,
  });

  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT * FROM publication WHERE subject_id = ?').get('alpha-learn');
  equal('publishing records the run that produced it', row.run_id, 'run-20260804-061247-83e06e0b');
  equal('and the brief', row.brief_id, 'p42-create-alpha-learn');
  equal('and what the reviewers concluded', row.disposition, 'ready-for-draft');
  equal('and who accepted it', row.accepted_by, 'a person');
  equal('and the work item is closed by the person, not by a build',
    db.prepare('SELECT state FROM work_item WHERE subject_id = ?').get('alpha-learn').state, 'done');

  const prov = db.prepare('SELECT * FROM v_provenance WHERE subject_id = ?').get('alpha-learn');
  equal('and the provenance view answers the question in the direction it is asked',
    prov.run_id, 'run-20260804-061247-83e06e0b');

  // Idempotence: the same acceptance recorded twice is one publication.
  recordPublication({
    dbPath, subjectId: 'alpha-learn', acceptedBy: 'a person', runRecordDir: dir,
    itemId: 'alpha-learn', now: NOW, apply: true,
  });
  equal('recording the same acceptance twice leaves one row',
    db.prepare('SELECT count(*) AS n FROM publication WHERE subject_id = ?').get('alpha-learn').n, 1);
  db.close();

  // Content with no publication row is visible as unprovenanced, rather than
  // quietly absent from a provenance report that then looks complete.
  const d2 = new DatabaseSync(dbPath);
  d2.prepare(
    `INSERT INTO item (id, surface, path, title, content_sha256, indexed_at)
     VALUES ('hand-written', 'learn', 'modules/h.json', 'Hand written', 'abc', ?)`,
  ).run(NOW);
  equal('content with no provenance row is listed, not omitted',
    d2.prepare('SELECT count(*) AS n FROM v_unprovenanced').get().n, 1);
  d2.close();
}

{
  const dbPath = freshDb('refuse');
  let threw = null;
  try {
    recordPublication({ dbPath, subjectId: 'rejected-learn', acceptedBy: 'a person', apply: true });
  } catch (err) { threw = err; }
  check('publishing something a person rejected is refused',
    threw instanceof PublicationError && threw.detail.includes('terminal'));

  threw = null;
  try {
    recordPublication({ dbPath, subjectId: 'alpha-learn', acceptedBy: null, apply: true });
  } catch (err) { threw = err; }
  check('and a publication with nobody named on it is refused, because this pipeline does not publish itself',
    threw instanceof PublicationError && threw.detail.includes('accepted-by'));

  threw = null;
  try {
    recordPublication({ dbPath, subjectId: 'not-a-subject', acceptedBy: 'a person', apply: true });
  } catch (err) { threw = err; }
  check('and a subject with no queue item is refused', threw instanceof PublicationError);

  // Hand-authored content still earns a provenance row, saying so.
  recordPublication({ dbPath, subjectId: 'beta-learn', acceptedBy: 'a person', now: NOW, apply: true });
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT * FROM publication WHERE subject_id = ?').get('beta-learn');
  equal('content with no ensemble run behind it is recorded as hand-authored', row.run_id, null);
  check('and says so in the note', row.note.includes('hand-authored'));
  db.close();
}

// --- report --------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on proposal ingest and publication provenance.`);
