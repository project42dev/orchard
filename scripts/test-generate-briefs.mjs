#!/usr/bin/env node
// Tests for the queue-to-brief generator.
//
// These assert the PROMISES that make the handoff a handoff. The arithmetic of
// building a prompt string does not matter much; what matters is that the link
// back to the lifecycle survives, that the tool refuses rather than guesses,
// and that a count of stranded work is a real count and not an artefact of
// where a loop stopped.
//
// EVERY database fixture is built through openStateStore on the real migrated
// schema and walked to its state through the lifecycle's own transitions. The
// previous version hand-applied schema/content-db.sql, a schema production
// does not have, which is exactly how the generator shipped querying a table
// the deployed database lacks.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateBriefs, resolveRoles, loadInventory, normalizeStableId, briefIdFor,
  briefFor, topicSlug, BriefGenerationError, ROLE_JOBS, OUTCOME_KIND, surfaceConfigFor,
} from './generate-briefs.mjs';
import { matchToWorkItem } from './ingest-proposals.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW, candidate } from './test-fixtures.mjs';

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) { passed += 1; } else { failures.push(label); }
}

function equal(label, actual, expected) {
  check(`${label} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
    actual === expected);
}

function throws(label, fn, predicate) {
  try {
    fn();
    failures.push(`${label} (did not throw)`);
  } catch (err) {
    if (predicate(err)) passed += 1;
    else failures.push(`${label} (threw the wrong thing: ${err.message})`);
  }
}

/** An item recorded directly through the store, for outcomes discovery never proposes. */
async function seedItemWithOutcome(store, runId, term, outcome, { surface = 'learning', evidence } = {}) {
  const itemId = generateUuidV7();
  await store.recordItem({
    schema_version: '1.0.0',
    item_id: itemId,
    run_id: runId,
    track: 'track-1',
    item_revision: 1,
    semantic_identity: `sid:v1:${sha256Digest(`outcome:${term}`).slice(7)}`,
    surface,
    outcome,
    state: 'observed',
    proposal_digest: sha256Digest({ term, outcome }),
    artifact_digest: null,
    target: { repository: 'project42dev/project42-platform', path: `content/modules/discovery/${term}.json` },
    evidence: evidence ?? [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
    created_at: NOW,
    updated_at: NOW,
  });
  for (const [from, to, cause] of [['observed', 'proposed', 'observation-recorded'], ['proposed', 'gate1-pending', 'proposal-ready']]) {
    await store.recordTransition({
      schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: runId,
      item_id: itemId, item_revision: 1, from_state: from, to_state: to, cause,
      actor: 'test-fixture', occurred_at: NOW, correlation_id: generateUuidV7(),
    });
  }
  return itemId;
}

// --- fixture -----------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'orchard-briefs-'));

const { store, runId, dbPath } = await estate();

// Three discovery items approved and linked, so they are authorable.
const [alphaId, betaId, gammaId] = await seedGateItems(store, runId, ['alpha', 'beta', 'gamma']);
for (const id of [alphaId, betaId, gammaId]) await walkTo(store, runId, id, 'ado-linked');
// One the owner has not decided. It must be unreachable.
const [pendingId] = await seedGateItems(store, runId, ['undecided']);
// One already picked up, with no artifact_binding recorded -- exactly what a
// crashed run leaves behind. It IS eligible: this is the recovery case.
const [orphanedId] = await seedGateItems(store, runId, ['crashed-before-proposal']);
await walkTo(store, runId, orphanedId, 'executing');
// One with an outcome that is not an authorable brief form. It must be
// reported as stranded, not silently dropped and not written anyway.
const removalId = await seedItemWithOutcome(store, runId, 'obsolete-topic', 'removal');
await walkTo(store, runId, removalId, 'ado-linked');
// One update, carrying the evidence an update brief hands the drafter.
const updateId = await seedItemWithOutcome(store, runId, 'stale-topic', 'update', {
  evidence: [{ reference: 'https://vendor.example/page', digest: sha256Digest('page') }],
});
await walkTo(store, runId, updateId, 'ado-linked');

const alphaSemanticIdentity = candidate('alpha').semanticIdentity;
store.close();

const inventoryPath = join(root, 'inventory.json');
writeFileSync(inventoryPath, JSON.stringify({
  'model-a': { name: 'A', format: 'VendorOne' },
  'model-b': { name: 'B', format: 'VendorTwo' },
  'model-c': { name: 'C', format: 'VendorThree' },
  'model-d': { name: 'D', format: 'VendorFour' },
  'model-a2': { name: 'A2', format: 'VendorOne' },
  'model-nofamily': { name: 'N' },
}));

function mapWith(models) {
  const path = join(root, `map-${Object.values(models).join('-')}.json`);
  writeFileSync(path, JSON.stringify({
    jobs: Object.fromEntries(Object.entries(models).map(([job, model]) => [job, { model }])),
  }));
  return path;
}

const goodMap = mapWith({
  [ROLE_JOBS.researcher]: 'model-a',
  [ROLE_JOBS.drafter]: 'model-a',
  [ROLE_JOBS.verifier]: 'model-b',
  [ROLE_JOBS.adversary]: 'model-c',
  [ROLE_JOBS.arbiter]: 'model-d',
  [ROLE_JOBS.finalizer]: 'model-d',
});

// The operator's surface config, in the operator's own (older) key spelling,
// which the generator must keep honouring for the form instructions.
const targetsPath = join(root, 'targets.json');
writeFileSync(targetsPath, JSON.stringify({
  repository: 'example/content',
  surfaces: {
    learn: { pathTemplates: ['content/modules/{topic}/'], suffix: '-learn' },
    'field-guide': { pathTemplate: 'content/resources/{topic}/', suffix: '-field-guide' },
    'visual-guide': { pathTemplates: ['diagrams/{topic}.mmd'], suffix: '-visual-guide', form: 'mermaid' },
  },
}));

// Discovery evidence, keyed the way the registry knows the work: by semantic
// identity, because the lifecycle's item ids did not exist at discovery time.
const registryPath = join(root, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  opportunities: [
    {
      id: alphaSemanticIdentity, title: 'Alpha', surface: 'learning', level: 'advanced',
      gapEvidence: 'zero occurrences in the measured corpus',
      marketSignal: 'Present in 9 of 27 surveyed sources.',
      provenance: { suggestedBy: ['source-one', 'source-two'] },
    },
  ],
}));

const base = { dbPath, mapPath: goodMap, targetsPath, inventoryPath, registryPath };

// --- the link back to the lifecycle -------------------------------------------

{
  const r = await generateBriefs({ ...base, limit: 10 });

  equal('ado-linked work is eligible, pending is not, and so is an executing item with no artifact_binding',
    r.eligible, 6);
  equal('a brief is written for every eligible item with an authorable outcome', r.briefs.length, 5);
  check('the orphaned executing item (no binding) is picked up as a recovery candidate',
    r.briefs.some((b) => b.subjectId === orphanedId));

  const alpha = r.briefs.find((b) => b.subjectId === alphaId);
  check('every brief carries the item id of the lifecycle item it serves', Boolean(alpha));
  equal('and the brief id ends with that item id, which is the channel that survives the round trip',
    alpha.id, `p42-create-${alphaId}`);
  equal('and the brief also carries the work item id, for a human reading it',
    alpha.workItemId, alphaId);
  equal('and a lifecycle item id survives the platform filename normalizer intact',
    normalizeStableId(alpha.id), alpha.id);

  // The real proof: the ingest, given only what the delivery platform writes
  // into a proposal filename, gets back to the right lifecycle row.
  const itemIds = new Set([alphaId, betaId, gammaId]);
  const match = matchToWorkItem({ doc: { briefId: alpha.id } }, itemIds);
  equal('and the ingest recovers the item from the brief id alone', match?.subjectId, alphaId);

  equal('a brief names where the content goes, from the RECORDED item target',
    alpha.targets[0].pathPrefixes[0], 'content/modules/discovery/alpha.json');
  equal('and which repository', alpha.targets[0].repository, 'project42dev/project42-platform');

  check('the recorded Gate 1 manifest title reaches the brief',
    alpha.title === 'How to teach alpha');

  check('evidence from the discovery list reaches the drafter, not just the title',
    alpha.prompt.includes('zero occurrences in the measured corpus')
    && alpha.prompt.includes('Present in 9 of 27 surveyed sources.')
    && alpha.prompt.includes('source-one, source-two'));
  check('and the level from the discovery list wins over the default',
    alpha.prompt.includes('at advanced level')
    && alpha.acceptanceCriteria.some((c) => c.includes('advanced level')));

  const beta = r.briefs.find((b) => b.subjectId === betaId);
  check('an item with no discovery evidence still gets a usable brief',
    beta.prompt.includes('Write the learning content') && beta.acceptanceCriteria.length > 0);

  check('every brief carries acceptance criteria, or nothing can verify it',
    r.briefs.every((b) => b.acceptanceCriteria.length >= 3));
  check('every role carries its own completion budget, never a global one',
    r.briefs.every((b) => Object.values(b.roles).every((role) => role.maxCompletionTokens >= 4096)));

  check('an outcome with no brief form is stranded and says so',
    r.skipped.length === 1 && r.skipped[0].subjectId === removalId
    && r.skipped[0].reason.includes('removal'));
}

// --- needs-updating ------------------------------------------------------------

{
  const r = await generateBriefs({ ...base, limit: 10 });
  const update = r.briefs.find((b) => b.subjectId === updateId);
  check('an update outcome produces an update brief', Boolean(update));
  equal('with an id that says so', update.id, `p42-update-${updateId}`);
  check('the prompt tells the drafter this is a correction, not a rewrite',
    update.prompt.includes('This is an update, not a rewrite'));
  check('and hands it the recorded evidence references it has to check',
    update.prompt.includes('https://vendor.example/page'));
  check('and the criteria require the diff to show the correction and nothing else',
    update.acceptanceCriteria.some((c) => c.includes('left as it was')));
}

// --- stranded work is counted, not stopped at ---------------------------------

{
  const r = await generateBriefs({ ...base, limit: 1 });
  equal('the limit caps what is EMITTED', r.briefs.length, 1);
  equal('and every stranded item is still counted, whatever the limit', r.skipped.length, 1);
  equal('and the rest are reported as not reached rather than silently dropped', r.notReached, 4);
  equal('emitted plus stranded plus not-reached accounts for every eligible item',
    r.briefs.length + r.skipped.length + r.notReached, r.eligible);
}

// --- claiming -----------------------------------------------------------------

{
  // Restricted to the ado-linked items only (excludes the orphaned recovery
  // item), so this block's counts stay exactly what they were before the
  // recovery case existed.
  const claimSubjects = [alphaId, betaId, gammaId, removalId, updateId];
  const r = await generateBriefs({ ...base, subjects: claimSubjects, limit: 2, apply: true, now: NOW, claimedBy: 'tester' });
  equal('under --apply the emitted items are moved to executing', r.claimed.length, 2);

  // A plain claim with no completed run behind it -- exactly what this test
  // does, and NOT what generateBriefs alone can promise anymore, since the
  // recovery case above depends on being able to tell "claimed, still
  // waiting for a real attempt" apart from "claimed, gate1-approved item
  // that's now genuinely done." Only a real completed run tells them apart,
  // by recording an artifact_binding (ingest-proposals.mjs's job, not this
  // one) -- so a claimed-but-unbound item correctly stays eligible here.
  // That is what makes the recovery case above possible at all: it is the
  // exact same state a crashed run leaves behind.
  const after = await generateBriefs({ ...base, subjects: claimSubjects, limit: 10 });
  check('a claimed item with no completed run behind it is still eligible -- unbound work is always retriable',
    r.claimed.every((id) => after.briefs.some((b) => b.subjectId === id)));
  equal('the eligible count is unchanged: nothing has actually finished yet, only been claimed', after.eligible, 5);
}

// --- recovering a crashed claim ------------------------------------------------

{
  // The orphaned item (executing, no artifact_binding) claimed on its own,
  // isolated from the block above so its different re-issuance semantics
  // don't interact with it.
  const r = await generateBriefs({ ...base, subjects: [orphanedId], limit: 10, apply: true, now: NOW, claimedBy: 'tester' });
  equal('the orphaned item is claimed', JSON.stringify(r.claimed), JSON.stringify([orphanedId]));

  const after = await generateBriefs({ ...base, subjects: [orphanedId], limit: 10 });
  // Unlike an ado-linked claim, generateBriefs alone cannot make an orphaned
  // item stop being eligible: it was already 'executing' before this run and
  // still is after, since only a real completed proposal (recordArtifactBinding,
  // done by ingest-proposals.mjs, not here) removes it from this query. That is
  // correct: if THIS retry also crashes before producing a real proposal, the
  // NEXT run must still be able to pick it up. Once a real proposal ingests
  // successfully, its binding takes it out of eligibility for good.
  equal('so it stays eligible until a real proposal actually ingests, not merely because it was tried',
    after.eligible, 1);
}

// --- refusing rather than guessing --------------------------------------------

{
  const inventory = loadInventory(inventoryPath);

  throws('a model nobody deployed stops the run and names the model and the job',
    () => resolveRoles(JSON.parse(readFileSync(mapWith({
      [ROLE_JOBS.drafter]: 'model-missing',
      [ROLE_JOBS.verifier]: 'model-b',
      [ROLE_JOBS.adversary]: 'model-c',
      [ROLE_JOBS.arbiter]: 'model-d',
    }), 'utf8')), inventory),
    (e) => e instanceof BriefGenerationError
      && e.problems.some((p) => p.kind === 'model-not-deployed'
        && p.detail.includes('model-missing') && p.detail.includes('drafting')));

  throws('a drafter and verifier from one vendor family are refused before a request is paid for',
    () => resolveRoles(JSON.parse(readFileSync(mapWith({
      [ROLE_JOBS.drafter]: 'model-a',
      [ROLE_JOBS.verifier]: 'model-a2',
      [ROLE_JOBS.adversary]: 'model-c',
      [ROLE_JOBS.arbiter]: 'model-d',
    }), 'utf8')), inventory),
    (e) => e.problems.some((p) => p.kind === 'family-collision' && p.detail.includes('VendorOne')));

  throws('so are a verifier and adversary from one family, because the adversary attacks what the verifier accepted',
    () => resolveRoles(JSON.parse(readFileSync(mapWith({
      [ROLE_JOBS.drafter]: 'model-c',
      [ROLE_JOBS.verifier]: 'model-a',
      [ROLE_JOBS.adversary]: 'model-a2',
      [ROLE_JOBS.arbiter]: 'model-d',
    }), 'utf8')), inventory),
    (e) => e.problems.some((p) => p.kind === 'family-collision'));

  throws('an arbiter that is the drafter is refused, because it would judge its own output',
    () => resolveRoles(JSON.parse(readFileSync(mapWith({
      [ROLE_JOBS.drafter]: 'model-a',
      [ROLE_JOBS.verifier]: 'model-b',
      [ROLE_JOBS.adversary]: 'model-c',
      [ROLE_JOBS.arbiter]: 'model-a',
    }), 'utf8')), inventory),
    (e) => e.problems.some((p) => p.kind === 'arbiter-judges-itself'));

  throws('an inventory entry with no declared family is refused, because independence cannot be checked without it',
    () => resolveRoles(JSON.parse(readFileSync(mapWith({
      [ROLE_JOBS.drafter]: 'model-nofamily',
      [ROLE_JOBS.verifier]: 'model-b',
      [ROLE_JOBS.adversary]: 'model-c',
      [ROLE_JOBS.arbiter]: 'model-d',
    }), 'utf8')), inventory),
    (e) => e.problems.some((p) => p.kind === 'family-undeclared'));

  throws('a missing inventory is a refusal, not an empty deployed set',
    () => loadInventory(join(root, 'nope.json')),
    (e) => e instanceof BriefGenerationError);
}

// --- the id that would not survive the round trip -----------------------------

{
  equal('the normalizer mirrors the platform: uppercase is rewritten',
    normalizeStableId('P42-Create-Thing'), 'p42-create-thing');
  equal('and so is a slash', normalizeStableId('p42-create-learn/thing'), 'p42-create-learn-thing');
  equal('a clean id is left alone', normalizeStableId('p42-create-alpha-learn'), 'p42-create-alpha-learn');

  const built = briefFor({
    item: { id: 'create:Bad/Id', kind: 'needs-creating', subject_id: 'Bad/Id', surface: 'learn', title: 'B' },
    roles: {},
    targets: JSON.parse(readFileSync(targetsPath, 'utf8')),
  });
  check('a subject id the platform would rewrite is refused, because the link back would be lost',
    Boolean(built.error) && built.error.includes('link back to the queue would be lost'));

  equal('a kind with no brief form has no id', briefIdFor('something-else', 'x'), null);
  equal('the topic slug is the subject id with its declared surface suffix removed',
    topicSlug('alpha-learn', '-learn'), 'alpha');
  equal('and an id that does not carry the suffix is left whole',
    topicSlug('alpha', '-learn'), 'alpha');
}

// --- the outcome and surface vocabularies -------------------------------------

{
  equal('a discovery outcome maps to a creation brief', OUTCOME_KIND['new-module'], 'needs-creating');
  equal('a currency outcome maps to an update brief', OUTCOME_KIND.correction, 'needs-updating');
  equal('removal is deliberately unauthorable', OUTCOME_KIND.removal, undefined);

  const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
  check('the contract surface name finds the operator\'s older config key',
    surfaceConfigFor(targets, 'guide-diagram')?.form === 'mermaid');
  check('and a surface with no config resolves to nothing rather than a guess',
    surfaceConfigFor(targets, 'nonsense') === null);
}

// --- report ------------------------------------------------------------------

cleanupFixtures();
rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on the queue-to-brief generator.`);
