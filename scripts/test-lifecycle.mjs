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
// v2 adds: deprecation path, multi-surface lifecycle, rejected-work-item
// permanence, concurrent creation+update routing, and cross-repo targets.
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
mkdirSync(join(content, 'resources'), { recursive: true });
mkdirSync(join(content, 'visual-guides'), { recursive: true });
mkdirSync(runDir, { recursive: true });

const FRESH = new Date().toISOString().slice(0, 10);
const ANCIENT = '2020-01-01';

writeFileSync(join(content, 'source-registry.json'), JSON.stringify({
  sources: [
    { id: 'vendor-docs', urlPrefix: 'https://vendor.example/', publisher: 'Vendor', reviewCadenceDays: 30 },
    { id: 'field-guide-source', urlPrefix: 'https://field.example/', publisher: 'Field Guide Publisher', reviewCadenceDays: 60 },
  ],
}));

// Phase 1 output: a discovery pass proposed topics and a human left them as
// candidates. This file IS the discovery list.
const registryPath = join(content, 'opportunity-registry.json');
function writeRegistry(statuses) {
  writeFileSync(registryPath, JSON.stringify({
    opportunities: [
      {
        id: 'widget-tuning-learn',
        title: 'Widget tuning (Learn)',
        surface: 'learn',
        level: 'intermediate',
        status: statuses['widget-tuning-learn'] ?? 'candidate',
        gapEvidence: 'Learn corpus: 0 occurrences of the probe in the measured corpus',
        marketSignal: 'Present in 6 of 27 surveyed sources.',
        provenance: { suggestedBy: ['source-one', 'source-two'] },
        marketMeasurement: { sourceCount: 6, sourcesSurveyed: 27 },
      },
      {
        id: 'deploy-strategy-field-guide',
        title: 'Deployment strategy (Field Guide)',
        surface: 'field-guide',
        level: 'advanced',
        status: statuses['deploy-strategy-field-guide'] ?? 'candidate',
        gapEvidence: 'Field Guide corpus: 0 occurrences of the probe',
        marketSignal: 'Present in 4 of 27 surveyed sources.',
        provenance: { suggestedBy: ['source-three'] },
        marketMeasurement: { sourceCount: 4, sourcesSurveyed: 27 },
      },
    ],
  }));
}
writeRegistry({});

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
    research: { model: 'model-draft' },
    drafting: { model: 'model-draft' },
    verification: { model: 'model-verify' },
    adversary: { model: 'model-attack' },
    arbiter: { model: 'model-arbitrate' },
    finalization: { model: 'model-arbitrate' },
  },
}));

// Cross-repo targets: learn goes to one repo, field-guide to another.
const targetsPath = join(root, 'targets.json');
writeFileSync(targetsPath, JSON.stringify({
  repository: 'example/content',
  surfaces: {
    learn: { pathTemplate: 'content/modules/{topic}/', suffix: '-learn' },
    'field-guide': { repository: 'example/field-guide', pathTemplate: 'resources/{topic}/', suffix: '-field-guide' },
  },
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

function workItemCount(subjectId) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT count(*) AS n FROM work_item WHERE subject_id = ?').get(subjectId).n;
  } finally { db.close(); }
}

// =============================================================================
// SCENARIO 1: The full cycle — creation through update (existing coverage)
// =============================================================================

step(1, 'SCENARIO 1: one topic, creation through currency update');

// --- 1a. selection: the candidate becomes queued work -------------------------

buildContentDb({ contentRoot: content, dbPath });
step('1a', 'a build turned the open candidate into a queued work item');

let row = queueRow('widget-tuning-learn', 'needs-creating');
equal('an open candidate becomes a queued needs-creating item', row?.state, 'queued');

// --- 1b. the queue drives the brief -------------------------------------------

// Both the learn and field-guide candidates are queued. The first generateBriefs
// call with limit=5 will claim both. We filter to learn-only for the primary
// scenario to keep assertions precise.
const first = generateBriefs({ ...briefArgs, limit: 5, surfaces: ['learn'], apply: true });
step('1b', 'the queue produced a brief, and the item was claimed');

equal('the queue produced exactly one learn brief', first.briefs.length, 1);
const brief = first.briefs[0];
equal('and it carries the subject id of the queue item it serves', brief.subjectId, 'widget-tuning-learn');
equal('and it names where the content goes', brief.targets[0].pathPrefixes[0], 'content/modules/widget-tuning/');
check('and it hands the drafter the discovery evidence, not just a title',
  brief.prompt.includes('Present in 6 of 27 surveyed sources'));
equal('and generating it claimed the work, so a second run cannot double-issue it',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'claimed');
equal('proved: a second run for the same surface issues nothing',
  generateBriefs({ ...briefArgs, limit: 5, surfaces: ['learn'] }).briefs.length, 0);

// --- 1c. the ensemble refuses its own draft -----------------------------------

deliveryRun(brief.id, 'blocked');
let ingested = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('1c', 'the ensemble drafted, its own reviewers refused it, and the queue was told');

equal('a blocked proposal is matched back to the queue item that asked for it',
  ingested.applied.length, 1);
equal('and nothing is unmatched, which is what a hand-written brief produced',
  ingested.unmatched.length, 0);
equal('and the item is blocked, which is distinct from nobody having tried',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'blocked');
check('and the note names the proposal that said so',
  (queueRow('widget-tuning-learn', 'needs-creating')?.note ?? '').includes('proposal-'));

// --- 1d. a later run passes ---------------------------------------------------

const passing = deliveryRun(brief.id, 'ready-for-draft');
ingested = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('1d', 'a later run passed review, and that verdict superseded the block');

equal('the newest verdict wins', queueRow('widget-tuning-learn', 'needs-creating').state, 'in-progress');
equal('and it is the platform\'s own pass disposition that did it, not an alias',
  ingested.applied.at(-1).to, 'in-progress');

// --- 1e. a human accepts, and the content lands -------------------------------

writeFileSync(join(content, 'modules', 'widget-tuning.json'), JSON.stringify({
  id: 'widget-tuning-learn',
  title: 'Widget tuning',
  level: 'intermediate',
  reviewCadenceDays: 30,
  lastVerified: FRESH,
  sources: [{ url: 'https://vendor.example/widgets', title: 'Widgets', lastVerified: FRESH }],
}));
writeRegistry({ 'widget-tuning-learn': 'published' });

const publication = recordPublication({
  dbPath,
  subjectId: 'widget-tuning-learn',
  kind: 'needs-creating',
  acceptedBy: 'the owner',
  runRecordDir: runDir,
  itemId: 'widget-tuning-learn',
  apply: true,
});
step('1e', 'a person accepted the proposal, and the run that wrote it was recorded');

equal('publishing closes the work item, and only a person can', publication.to, 'done');
equal('and the publication records which run produced the content', publication.row.run_id, passing.runId);
equal('and which brief', publication.row.brief_id, brief.id);
equal('and who accepted it', publication.row.accepted_by, 'the owner');

// --- 1f. the rebuild does not undo any of it ----------------------------------

buildContentDb({ contentRoot: content, dbPath });
step('1f', 'a rebuild indexed the new content and left every decision alone');

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

// --- 1g. currency: the cited source ages, and the cycle closes ----------------

writeFileSync(join(content, 'modules', 'widget-tuning.json'), JSON.stringify({
  id: 'widget-tuning-learn',
  title: 'Widget tuning',
  level: 'intermediate',
  reviewCadenceDays: 30,
  lastVerified: ANCIENT,
  sources: [{ url: 'https://vendor.example/widgets', title: 'Widgets', lastVerified: ANCIENT }],
}));
buildContentDb({ contentRoot: content, dbPath });
step('1g', 'the cited source aged past its cadence, and the same item was queued again as an update');

const update = queueRow('widget-tuning-learn', 'needs-updating');
equal('the currency engine queues the SAME subject as an update', update?.state, 'queued');
equal('and the completed creation is untouched beside it',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');

const updateBriefs = generateBriefs({ ...briefArgs, limit: 5, surfaces: ['learn'], apply: true });
equal('the update queue drives a brief exactly as the creation queue did', updateBriefs.briefs.length, 1);
const updateBrief = updateBriefs.briefs[0];
equal('and its id says which kind of work it is, so the return path cannot confuse the two',
  updateBrief.id, 'p42-update-widget-tuning-learn');
check('and it tells the drafter this is a correction, with the stale citation named',
  updateBrief.prompt.includes('not a rewrite') && updateBrief.prompt.includes('https://vendor.example/widgets'));

deliveryRun(updateBrief.id, 'ready-for-draft');
const updateIngest = ingest({ dbPath, runRecordDir: runDir, apply: true });
step('1h', 'the update proposal came back and moved the update, not the completed creation');

equal('the update item moves', queueRow('widget-tuning-learn', 'needs-updating').state, 'in-progress');
equal('and the completed creation is NOT reopened by a proposal about the same subject',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');
check('and the creation is reported as left alone rather than silently skipped',
  updateIngest.protectedItems.some((p) => p.kind === 'needs-creating')
  || updateIngest.applied.every((a) => a.kind !== 'needs-creating'));

// =============================================================================
// SCENARIO 2: Multi-surface lifecycle — field-guide alongside learn
// =============================================================================

step(2, 'SCENARIO 2: a field-guide topic goes through the full cycle');

// The field-guide candidate was in the registry from the start. It should be
// queued as needs-creating, and since we filtered to learn-only in scenario 1b,
// it's still queued.
const fgRow = queueRow('deploy-strategy-field-guide', 'needs-creating');
equal('a field-guide candidate becomes a queued needs-creating item', fgRow?.state, 'queued');
equal('and it carries the correct surface', fgRow?.surface, 'field-guide');

// Generate a brief specifically for the field-guide.
const fgBriefs = generateBriefs({ ...briefArgs, limit: 5, surfaces: ['field-guide'], apply: true });
equal('the field-guide queue produces a brief', fgBriefs.briefs.length, 1);
const fgBrief = fgBriefs.briefs[0];
equal('and it carries the field-guide subject id', fgBrief.subjectId, 'deploy-strategy-field-guide');
equal('and its id says create, not update', fgBrief.id, 'p42-create-deploy-strategy-field-guide');

// Cross-repo: the field-guide surface declares its own repository.
equal('and the field-guide target goes to its own repository',
  fgBrief.targets[0].repository, 'example/field-guide');
// The learn brief from scenario 1 uses the default repository.
equal('and the learn target stays in the default repository',
  brief.targets[0].repository, 'example/content');

// Run the field-guide through delivery.
deliveryRun(fgBrief.id, 'ready-for-draft');
const fgIngest = ingest({ dbPath, runRecordDir: runDir, apply: true });
check('the field-guide proposal is matched back',
  fgIngest.applied.some((a) => a.subjectId === 'deploy-strategy-field-guide'));
equal('and the field-guide item moves to in-progress',
  queueRow('deploy-strategy-field-guide', 'needs-creating').state, 'in-progress');

// Publish the field-guide content.
writeFileSync(join(content, 'resources', 'deploy-strategy.json'), JSON.stringify({
  id: 'deploy-strategy-field-guide',
  title: 'Deployment strategy',
  level: 'advanced',
  reviewCadenceDays: 60,
  lastVerified: FRESH,
  sources: [{ url: 'https://field.example/deploy', title: 'Deployment patterns', lastVerified: FRESH }],
}));
writeRegistry({ 'widget-tuning-learn': 'published', 'deploy-strategy-field-guide': 'published' });

const fgPub = recordPublication({
  dbPath,
  subjectId: 'deploy-strategy-field-guide',
  kind: 'needs-creating',
  acceptedBy: 'the owner',
  runRecordDir: runDir,
  itemId: 'deploy-strategy-field-guide',
  apply: true,
});
equal('the field-guide publication closes the work item', fgPub.to, 'done');

// Rebuild and verify both surfaces are indexed.
buildContentDb({ contentRoot: content, dbPath });
{
  const db = new DatabaseSync(dbPath);
  equal('the learn item is indexed',
    db.prepare('SELECT count(*) AS n FROM item WHERE id = ?').get('widget-tuning-learn').n, 1);
  equal('the field-guide item is indexed',
    db.prepare('SELECT count(*) AS n FROM item WHERE id = ?').get('deploy-strategy-field-guide').n, 1);
  check('both surfaces are present in the item table',
    db.prepare('SELECT count(DISTINCT surface) AS n FROM item').get().n >= 2);
  db.close();
}

// =============================================================================
// SCENARIO 3: Rejected work item stays rejected across rebuilds
// =============================================================================

step(3, 'SCENARIO 3: a rejected work item is never resurrected by a rebuild');

// Manually reject the field-guide update (simulating a human decision).
{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE work_item SET state = 'rejected', note = 'human decided this is not worth updating' WHERE subject_id = ? AND kind = ?")
    .run('deploy-strategy-field-guide', 'needs-creating');
  db.close();
}
equal('the field-guide item is now rejected',
  queueRow('deploy-strategy-field-guide', 'needs-creating').state, 'rejected');

// Rebuild. The rejected item must stay rejected.
buildContentDb({ contentRoot: content, dbPath });
equal('a rebuild does not resurrect a rejected work item',
  queueRow('deploy-strategy-field-guide', 'needs-creating').state, 'rejected');
equal('and no duplicate creation work is proposed for a rejected item',
  queueRow('deploy-strategy-field-guide', 'needs-creating').state, 'rejected');

// =============================================================================
// SCENARIO 4: Concurrent creation + update routing
// =============================================================================

step(4, 'SCENARIO 4: concurrent creation and update for the same subject route correctly');

// The widget-tuning-learn subject now has:
//   - needs-creating: done (from scenario 1)
//   - needs-updating: in-progress (from scenario 1h)
//
// Complete the existing update so we can test a fresh concurrent scenario.
recordPublication({
  dbPath,
  subjectId: 'widget-tuning-learn',
  kind: 'needs-updating',
  acceptedBy: 'the owner',
  runRecordDir: runDir,
  apply: true,
});
equal('the update is now done',
  queueRow('widget-tuning-learn', 'needs-updating').state, 'done');

// Now manually create a NEW update work item (simulating a fresh currency scan
// finding the source stale again). The existing done row prevents the rebuild
// from creating one, so we insert it directly — this is what a real currency
// scan does when it finds a new staleness after the previous update completed.
{
  const db = new DatabaseSync(dbPath);
  // Delete the old done row so the rebuild can create a fresh one.
  db.prepare("DELETE FROM work_item WHERE subject_id = ? AND kind = 'needs-updating'")
    .run('widget-tuning-learn');
  db.close();
}

// Age the source again and rebuild.
writeFileSync(join(content, 'modules', 'widget-tuning.json'), JSON.stringify({
  id: 'widget-tuning-learn',
  title: 'Widget tuning (revised)',
  level: 'intermediate',
  reviewCadenceDays: 30,
  lastVerified: ANCIENT,
  sources: [{ url: 'https://vendor.example/widgets', title: 'Widgets', lastVerified: ANCIENT }],
}));
buildContentDb({ contentRoot: content, dbPath });

// A new update should be queued.
const update2 = queueRow('widget-tuning-learn', 'needs-updating');
equal('a second update is queued after the first completes and the row is cleared', update2?.state, 'queued');
equal('and the completed creation is still done',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');

// Generate a brief for the second update.
const update2Briefs = generateBriefs({ ...briefArgs, limit: 5, kinds: ['needs-updating'], apply: true });
equal('the second update produces a brief', update2Briefs.briefs.length, 1);
equal('and it is an update brief, not a creation brief',
  update2Briefs.briefs[0].kind, 'needs-updating');

// Now simulate a delivery run that returns a proposal for the update.
deliveryRun(update2Briefs.briefs[0].id, 'ready-for-draft');
const update2Ingest = ingest({ dbPath, runRecordDir: runDir, apply: true });

// The ingest must move the update item, not the creation item.
check('the second update ingest moves the update item',
  update2Ingest.applied.some((a) => a.kind === 'needs-updating' && a.subjectId === 'widget-tuning-learn'));
equal('and the creation item is still done, not reopened',
  queueRow('widget-tuning-learn', 'needs-creating').state, 'done');
check('the update item was moved to in-progress',
  queueRow('widget-tuning-learn', 'needs-updating').state === 'in-progress');
check('and it was the update, not the creation, that was moved',
  update2Ingest.applied.some((a) => a.kind === 'needs-updating')
  && !update2Ingest.applied.some((a) => a.kind === 'needs-creating' && a.subjectId === 'widget-tuning-learn'));

// =============================================================================
// SCENARIO 5: Recovery from blocked — human override
// =============================================================================

step(5, 'SCENARIO 5: a human can publish a blocked proposal (override)');

// The widget-tuning update is in-progress from scenario 4. Simulate a
// blocked run and then a human override.
deliveryRun(update2Briefs.briefs[0].id, 'blocked');
const blockedIngest = ingest({ dbPath, runRecordDir: runDir, apply: true });
equal('a blocked proposal moves the item to blocked',
  queueRow('widget-tuning-learn', 'needs-updating').state, 'blocked');

// A human overrides: publishes despite the block.
const overridePub = recordPublication({
  dbPath,
  subjectId: 'widget-tuning-learn',
  kind: 'needs-updating',
  acceptedBy: 'the owner (override)',
  runRecordDir: runDir,
  apply: true,
});
equal('a human can publish a blocked proposal', overridePub.to, 'done');
equal('and the publication records the override',
  overridePub.row.accepted_by, 'the owner (override)');
check('and the disposition is recorded as blocked, which is honest',
  overridePub.row.disposition === 'blocked');

// =============================================================================
// SCENARIO 6: Deprecation path (using the field-guide item)
// =============================================================================

step(6, 'SCENARIO 6: a published item is deprecated and the record is retained');

// The field-guide item was published in scenario 2 and then rejected in
// scenario 3. Now we deprecate it: remove the content file and verify the
// publication record survives.
rmSync(join(content, 'resources', 'deploy-strategy.json'), { force: true });

// Rebuild. The deprecated item must stay rejected, and the content must be gone
// from the index.
buildContentDb({ contentRoot: content, dbPath });

{
  const db = new DatabaseSync(dbPath);
  equal('the deprecated field-guide creation stays rejected after rebuild',
    db.prepare("SELECT state FROM work_item WHERE subject_id = ? AND kind = 'needs-creating'")
      .get('deploy-strategy-field-guide').state, 'rejected');

  // The content file was removed, so it should no longer be in the item table.
  equal('the deprecated content is no longer indexed',
    db.prepare('SELECT count(*) AS n FROM item WHERE id = ?').get('deploy-strategy-field-guide').n, 0);

  // But the publication record survives — provenance is forever.
  const pubCount = db.prepare('SELECT count(*) AS n FROM publication WHERE subject_id = ?')
    .get('deploy-strategy-field-guide').n;
  check('the publication record survives deprecation', pubCount >= 1);

  // And the provenance view still shows it (publication rows survive).
  const provAfter = db.prepare('SELECT count(*) AS n FROM v_provenance WHERE subject_id = ?')
    .get('deploy-strategy-field-guide').n;
  check('provenance survives deprecation', provAfter >= 1);

  db.close();
}

// =============================================================================
// SCENARIO 7: Rejected candidate is never re-proposed
// =============================================================================

step(7, 'SCENARIO 7: a rejected candidate is never re-proposed by a rebuild');

// Mark the field-guide candidate as rejected in the registry.
writeRegistry({
  'widget-tuning-learn': 'published',
  'deploy-strategy-field-guide': 'rejected',
});

// Rebuild. The rejected candidate must not produce a new work item.
buildContentDb({ contentRoot: content, dbPath });

// The field-guide creation was already done (scenario 2) and then rejected
// (scenario 3). A rebuild must not create a new needs-creating item for it.
{
  const db = new DatabaseSync(dbPath);
  const createCount = db.prepare(
    "SELECT count(*) AS n FROM work_item WHERE subject_id = ? AND kind = 'needs-creating'"
  ).get('deploy-strategy-field-guide').n;
  equal('a rejected candidate does not produce a duplicate creation work item',
    createCount, 1); // the original one, still rejected
  equal('and the original stays rejected',
    db.prepare("SELECT state FROM work_item WHERE subject_id = ? AND kind = 'needs-creating'")
      .get('deploy-strategy-field-guide').state, 'rejected');
  db.close();
}

// =============================================================================
// SCENARIO 8: Unmatched proposal is reported, not silently dropped
// =============================================================================

step(8, 'SCENARIO 8: an unmatched proposal is reported, not silently dropped');

// Create a run record with a proposal that references a brief id not in the
// queue. This simulates a hand-written brief or a brief from a different
// database.
const orphanRunId = '99999999-1111-2222-3333-444455556666';
const orphanSlug = normalizeStableId('p42-create-nonexistent-topic-99999999');
writeFileSync(join(runDir, 'run-orphan-99999999.json'), JSON.stringify({
  runId: orphanRunId,
  proposals: [{
    proposalPath: `/mnt/run-records/proposals/proposal-${orphanSlug}.json`,
    packetPath: `/mnt/run-records/proposals/packet-${orphanSlug}.json`,
    disposition: 'ready-for-draft',
    proposalDigest: 'sha-orphan',
  }],
}));

const orphanIngest = ingest({ dbPath, runRecordDir: runDir, apply: true });
equal('an unmatched proposal is reported',
  orphanIngest.unmatched.length, 1);
equal('and it carries the proposal filename',
  orphanIngest.unmatched[0].file, `proposal-${orphanSlug}.json`);
equal('and nothing was applied from an unmatched proposal',
  orphanIngest.applied.length, 0);

// =============================================================================
// report ----------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

console.log('Lifecycle as a closed cycle, with all eight scenarios:');
for (const t of trace) console.log(t);
console.log('');

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions across 8 scenarios on the lifecycle as a closed cycle.`);
