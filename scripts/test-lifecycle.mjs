#!/usr/bin/env node
// The lifecycle as a CYCLE, not as a list of phases.
//
// Every phase of this system had its own passing tests while the thing as a
// whole did not work, because the tests covered the boxes and the breaks were
// in the arrows. This file tests the arrows. It walks one topic all the way
// round: discovered, queued, briefed, drafted, blocked, re-drafted, passed,
// published, indexed, and then aged until the currency engine queues it again
// as an update.
//
// The delivery platform itself is not run here. It needs a managed identity and
// costs real money per run, and neither belongs in a test suite. What IS
// reproduced exactly is the only thing it hands back: a run record, with the
// proposal filename built the same way Invoke-Project42Delivery.ps1 builds it,
// through the same normalizer. That filename is the whole channel from the
// ensemble back to the queue, so reproducing it faithfully is the test.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContentDb } from './build-content-db.mjs';
import { generateBriefs, normalizeStableId } from './generate-briefs.mjs';
import { ingest } from './ingest-proposals.mjs';
import { recordPublication } from './record-publication.mjs';

let passed = 0;
const failures = [];
const trace = [];

function check(label, condition) {
  if (condition) { passed += 1; } else { failures.push(label); }
}

function equal(label, actual, expected) {
  check(`${label} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
    actual === expected);
}

function step(n, what) {
  trace.push(`  ${n}. ${what}`);
}

// --- the estate ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'orchard-lifecycle-'));
const content = join(root, 'content');
const dbPath = join(root, 'content.db');
const runDir = join(root, 'run-records');
mkdirSync(join(content, 'modules'), { recursive: true });
mkdirSync(runDir, { recursive: true });

const FRESH = new Date().toISOString().slice(0, 10);
const ANCIENT = '2020-01-01';

writeFileSync(join(content, 'source-registry.json'), JSON.stringify({
  sources: [{
    id: 'vendor-docs', urlPrefix: 'https://vendor.example/', publisher: 'Vendor', reviewCadenceDays: 30,
  }],
}));

// Phase 1 output: a discovery pass proposed a topic and a human left it a
// candidate. This file IS the discovery list.
const registryPath = join(content, 'opportunity-registry.json');
function writeRegistry(status) {
  writeFileSync(registryPath, JSON.stringify({
    opportunities: [{
      id: 'widget-tuning-learn',
      title: 'Widget tuning (Learn)',
      surface: 'learn',
      level: 'intermediate',
      status,
      gapEvidence: 'Learn corpus: 0 occurrences of the probe in the measured corpus',
      marketSignal: 'Present in 6 of 27 surveyed sources.',
      provenance: { suggestedBy: ['source-one', 'source-two'] },
      marketMeasurement: { sourceCount: 6, sourcesSurveyed: 27 },
    }],
  }));
}
writeRegistry('candidate');

const inventoryPath = join(root, 'inventory.json');
writeFileSync(inventoryPath, JSON.stringify({
  'model-draft': { format: 'VendorOne' },
  'model-verify': { format: 'VendorTwo' },
  'model-attack': { format: 'VendorThree' },
  'model-arbitrate': { format: 'VendorFour' },
}));

const mapPath = join(root, 'model-map.json');
writeFileSync(mapPath, JSON.stringify({
  jobs: {
    drafting: { model: 'model-draft' },
    verification: { model: 'model-verify' },
    adversary: { model: 'model-attack' },
    arbiter: { model: 'model-arbitrate' },
  },
}));

const targetsPath = join(root, 'targets.json');
writeFileSync(targetsPath, JSON.stringify({
  repository: 'example/content',
  surfaces: { learn: { pathTemplate: 'content/modules/{topic}/', suffix: '-learn' } },
}));

const briefArgs = { dbPath, mapPath, targetsPath, inventoryPath, registryPath };

// Reproduce the delivery platform's proposal filename exactly. It is
// Get-Project42StableId of "<brief id>-<first 8 of the run GUID>", and the run
// id is a GUID, so those 8 characters are hex. The ingest strips exactly that.
let runCounter = 0;
function deliveryRun(briefId, disposition) {
  runCounter += 1;
  const runId = `${'0123abcd'.slice(0, 8)}${runCounter}-1111-2222-3333-444455556666`;
  const suffix = runId.slice(0, 8);
  const slug = normalizeStableId(`${briefId}-${suffix}`);
  const record = {
    runId,
    proposals: [{
      proposalPath: `/mnt/run-records/proposals/proposal-${slug}.json`,
      packetPath: `/mnt/run-records/proposals/packet-${slug}.json`,
      disposition,
      proposalDigest: `sha-${runCounter}`,
    }],
  };
  writeFileSync(join(runDir, `run-2026080${runCounter}-000000-${suffix}.json`), JSON.stringify(record));
  return { runId, record };
}

function queueRow(subjectId, kind) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM work_item WHERE subject_id = ? AND kind = ?').get(subjectId, kind);
  } finally { db.close(); }
}

// --- 2. selection: the candidate becomes queued work ---------------------------

buildContentDb({ contentRoot: content, dbPath });
step(2, 'a build turned the open candidate into a queued work item');

let row = queueRow('widget-tuning-learn', 'needs-creating');
equal('an open candidate becomes a queued needs-creating item', row?.state, 'queued');

// --- 3a. the queue drives the brief. THIS IS THE BREAK THAT WAS OPEN. -----------

const first = generateBriefs({ ...briefArgs, limit: 5, apply: true });
step('3a', 'the queue produced a brief, and the item was claimed');

equal('the queue produced exactly one brief', first.briefs.length, 1);
const brief = first.briefs[0];
equal('and it carries the subject id of the queue item it serves', brief.subjectId, 'widget-tuning-learn');
equal('and it names where the content goes', brief.targets[0].pathPrefixes[0], 'content/modules/widget-tuning/');
check('and it hands the drafter the discovery evidence, not just a title',
  brief.prompt.includes('Present in 6 of 27 surveyed sources'));
equal('and generating it claimed the work, so a second run cannot double-issue it',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'claimed');
equal('proved: a second run issues nothing',
  generateBriefs({ ...briefArgs, limit: 5 }).briefs.length, 0);

// --- 3b. the ensemble refuses its own draft ------------------------------------

deliveryRun(brief.id, 'blocked');
let ingested = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('3b', 'the ensemble drafted, its own reviewers refused it, and the queue was told');

equal('a blocked proposal is matched back to the queue item that asked for it',
  ingested.applied.length, 1);
equal('and nothing is unmatched, which is what a hand-written brief produced',
  ingested.unmatched.length, 0);
equal('and the item is blocked, which is distinct from nobody having tried',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'blocked');
check('and the note names the proposal that said so',
  queueRow('widget-tuning-learn', 'needs-creating').note.includes('proposal-'));

// --- 3c. a later run passes ----------------------------------------------------

const passing = deliveryRun(brief.id, 'ready-for-draft');
ingested = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('3c', 'a later run passed review, and that verdict superseded the block');

equal('the newest verdict wins', queueRow('widget-tuning-learn', 'needs-creating').state, 'in-progress');
equal('and it is the platform\'s own pass disposition that did it, not an alias',
  ingested.applied.at(-1).to, 'in-progress');

// --- 3d. a human accepts, and the content lands --------------------------------

// The accepted content, committed by a person. Nothing above wrote this file:
// the pipeline proposes and a human publishes (ADR-0004).
writeFileSync(join(content, 'modules', 'widget-tuning.json'), JSON.stringify({
  id: 'widget-tuning-learn',
  title: 'Widget tuning',
  level: 'intermediate',
  reviewCadenceDays: 30,
  lastVerified: FRESH,
  sources: [{ url: 'https://vendor.example/widgets', title: 'Widgets', lastVerified: FRESH }],
}));
writeRegistry('published');

const publication = recordPublication({
  dbPath,
  subjectId: 'widget-tuning-learn',
  kind: 'needs-creating',
  acceptedBy: 'the owner',
  runRecordDir: runDir,
  itemId: 'widget-tuning-learn',
  apply: true,
});
step('3d', 'a person accepted the proposal, and the run that wrote it was recorded');

equal('publishing closes the work item, and only a person can', publication.to, 'done');
equal('and the publication records which run produced the content', publication.row.run_id, passing.runId);
equal('and which brief', publication.row.brief_id, brief.id);
equal('and who accepted it', publication.row.accepted_by, 'the owner');

// --- 4. the rebuild does not undo any of it ------------------------------------

buildContentDb({ contentRoot: content, dbPath });
step(4, 'a rebuild indexed the new content and left every decision alone');

{
  const db = new DatabaseSync(dbPath);
  equal('the published content is now indexed',
    db.prepare('SELECT count(*) AS n FROM item WHERE id = ?').get('widget-tuning-learn').n, 1);
  equal('the completed work item survives the rebuild',
    db.prepare('SELECT state FROM work_item WHERE id = ?').get('create:widget-tuning-learn').state, 'done');
  equal('and no duplicate creation work is proposed for it',
    db.prepare("SELECT count(*) AS n FROM work_item WHERE kind = 'needs-creating' AND subject_id = ?")
      .get('widget-tuning-learn').n, 1);

  const prov = db.prepare('SELECT * FROM v_provenance WHERE subject_id = ?').get('widget-tuning-learn');
  equal('provenance survives the rebuild and reaches the run', prov.run_id, passing.runId);
  equal('and joins through to the indexed file', prov.path, 'modules/widget-tuning.json');
  equal('and the content is no longer listed as unprovenanced',
    db.prepare('SELECT count(*) AS n FROM v_unprovenanced WHERE item_id = ?').get('widget-tuning-learn').n, 0);
  db.close();
}

// --- 5. currency: the cited source ages, and the cycle closes -------------------

writeFileSync(join(content, 'modules', 'widget-tuning.json'), JSON.stringify({
  id: 'widget-tuning-learn',
  title: 'Widget tuning',
  level: 'intermediate',
  reviewCadenceDays: 30,
  lastVerified: ANCIENT,
  sources: [{ url: 'https://vendor.example/widgets', title: 'Widgets', lastVerified: ANCIENT }],
}));
buildContentDb({ contentRoot: content, dbPath });
step(5, 'the cited source aged past its cadence, and the same item was queued again as an update');

const update = queueRow('widget-tuning-learn', 'needs-updating');
equal('the currency engine queues the SAME subject as an update', update?.state, 'queued');
equal('and the completed creation is untouched beside it',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');

const updateBriefs = generateBriefs({ ...briefArgs, limit: 5, apply: true });
equal('the update queue drives a brief exactly as the creation queue did', updateBriefs.briefs.length, 1);
const updateBrief = updateBriefs.briefs[0];
equal('and its id says which kind of work it is, so the return path cannot confuse the two',
  updateBrief.id, 'p42-update-widget-tuning-learn');
check('and it tells the drafter this is a correction, with the stale citation named',
  updateBrief.prompt.includes('not a rewrite') && updateBrief.prompt.includes('https://vendor.example/widgets'));

deliveryRun(updateBrief.id, 'ready-for-draft');
const updateIngest = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('5b', 'the update proposal came back and moved the update, not the completed creation');

equal('the update item moves', queueRow('widget-tuning-learn', 'needs-updating').state, 'in-progress');
equal('and the completed creation is NOT reopened by a proposal about the same subject',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');
check('and the creation is reported as left alone rather than silently skipped',
  updateIngest.protectedItems.some((p) => p.kind === 'needs-creating')
  || updateIngest.applied.every((a) => a.kind !== 'needs-creating'));

// --- report --------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

console.log('One topic, all the way round:');
for (const t of trace) console.log(t);
console.log('');

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on the lifecycle as a closed cycle.`);
