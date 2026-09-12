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
  buildPrompt, formFor, FORM_INSTRUCTIONS, SURFACE_DEFAULT_FORM, DEFAULT_TARGETS_PATH,
  isResolvableCitation, evidenceCitations,
} from './generate-briefs.mjs';
import { inspectArtifactFormat } from './lib/artifact-format.mjs';
import { surfaceForTargetPath, registrationFor, DIAGRAM_CATEGORIES } from './lib/registration.mjs';
import { splitDiagramDeliverable, MERMAID_FENCE_TAG, CATALOGUE_FENCE_TAG } from './lib/diagram-deliverable.mjs';
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
    target: { repository: 'project42dev/project42-content', path: `modules/discovery/${term}.json` },
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
// One removal. It is not authorable prose and it is not stranded either: it
// is composed deterministically and handed back as a removal directive.
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
    learn: { pathTemplates: ['modules/{topic}/'], suffix: '-learn' },
    'field-guide': { pathTemplate: 'resources/{topic}/', suffix: '-field-guide' },
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

  // The declared learning path, not a placeholder directory. Until 2026-09-06
  // this read modules/discovery/, and "discovery" is a path catalog.json has
  // never declared, so every module briefed here was destined for a location
  // that registration refuses and that serves a 404 if it gets through.
  equal('a brief names where the content goes, from the RECORDED item target',
    alpha.targets[0].pathPrefixes[0], 'modules/agentic-systems-and-mcp/alpha.json');
  equal('and which repository', alpha.targets[0].repository, 'project42dev/project42-content');

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

  // Was: "an outcome with no brief form is stranded and says so". A removal
  // used to have no brief form and was reported stranded on every pass,
  // forever. It has one now, and it never reaches the ensemble.
  check('a removal is claimed as a removal directive, never sent to the ensemble',
    r.skipped.length === 0 && r.removals.length === 1 && r.removals[0].subjectId === removalId
    && r.removals[0].target.path === `modules/discovery/obsolete-topic.json`
    && !r.briefs.some((b) => b.subjectId === removalId));
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
  equal('nothing is stranded now that removal has a form', r.skipped.length, 0);
  equal('and the removal is emitted on its own channel, under its own cap', r.removals.length, 1);
  equal('and the rest are reported as not reached rather than silently dropped', r.notReached, 4);
  equal('emitted plus removals plus stranded plus not-reached accounts for every eligible item',
    r.briefs.length + r.removals.length + r.skipped.length + r.notReached, r.eligible);
}

// --- claiming -----------------------------------------------------------------

{
  // Restricted to the ado-linked items only (excludes the orphaned recovery
  // item), so this block's counts stay exactly what they were before the
  // recovery case existed.
  const claimSubjects = [alphaId, betaId, gammaId, removalId, updateId];
  const r = await generateBriefs({ ...base, subjects: claimSubjects, limit: 2, apply: true, now: NOW, claimedBy: 'tester' });
  // Three, not two: the two briefs the limit allows plus the removal, which
  // is claimed the same way so a crash leaves it visibly executing.
  equal('under --apply the emitted items are moved to executing', r.claimed.length, 3);

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
    // Either channel: a removal is re-emitted as a removal directive, a
    // drafted item as a brief. Both are unbound work and both stay retriable.
    r.claimed.every((id) => after.briefs.some((b) => b.subjectId === id) || after.removals.some((entry) => entry.subjectId === id)));
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
  equal('and a removal maps to its own deterministic form', OUTCOME_KIND.removal, 'needs-removing');

  const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
  check('the contract surface name finds the operator\'s older config key',
    surfaceConfigFor(targets, 'guide-diagram')?.form === 'mermaid');
  check('and a surface with no config resolves to nothing rather than a guess',
    surfaceConfigFor(targets, 'nonsense') === null);
}

// --- the form every surface's deliverable takes -------------------------------
//
// Read against the OPERATOR'S REAL config, not the fixture above. The fixture
// declares `field-guide` with no form, which is precisely the blind spot that
// let 64 of 66 held Track 2 items be drafted as Markdown at a .json path: a
// test carrying its own convenient config can only ever prove the code works
// on a config nobody runs.

{
  const real = JSON.parse(readFileSync(DEFAULT_TARGETS_PATH, 'utf8'));

  // A form value and a FORM_INSTRUCTIONS key that differ by one character read
  // as a declared form and push nothing, silently. Every declared form is
  // checked, so a new surface cannot be added with a name that resolves to air.
  for (const [name, config] of Object.entries(real.surfaces)) {
    if (!config.form) continue;
    check(`the operator's "${name}" surface declares a form that exists: ${config.form}`,
      Array.isArray(FORM_INSTRUCTIONS[config.form]));
  }

  // The operator's own config declares every form EXPLICITLY, and is asserted
  // to, because SURFACE_DEFAULT_FORM would otherwise cover the deletion
  // silently: a config line removed here would change nothing a test can see,
  // and the default is meant to be a net for an adopter's older config, not
  // this estate's way of declaring a form.
  for (const [name, config] of Object.entries(real.surfaces)) {
    check(`the operator's "${name}" surface declares its form rather than leaning on the default`,
      typeof config.form === 'string' && config.form !== '');
  }

  // The three contract surface names, which are what reaches formFor. The
  // config is keyed by the operator's older spellings, so this is the join that
  // was missing for `guide`.
  for (const surface of ['learning', 'guide', 'guide-diagram']) {
    const form = formFor(surface, surfaceConfigFor(real, surface));
    check(`the ${surface} surface resolves to a form instruction the drafter can follow`,
      Boolean(form) && Array.isArray(FORM_INSTRUCTIONS[form]));
    check(`and ${surface} still resolves to one when an adopter's config predates the fix`,
      Array.isArray(FORM_INSTRUCTIONS[SURFACE_DEFAULT_FORM[surface]]));
  }

  // END TO END, against a real published resource path. A Track 2 currency
  // finding keeps the canonical item's own source path, so
  // resources/<pack>/<id>.json is exactly what those 64 items carry.
  const target = 'resources/coding-agents/ai-assisted-code-review-checklist.json';
  equal('a resources/ path is the guide surface, which is what picks the form',
    surfaceForTargetPath(target), 'guide');

  const prompt = buildPrompt(
    { subject_id: 'ai-assisted-code-review-checklist-field-guide', surface: 'guide', kind: 'needs-updating', title: 'AI-Assisted Code Review Checklist', level: 'intermediate' },
    { level: 'intermediate' }, [], surfaceConfigFor(real, 'guide'),
  );
  check('the guide brief now carries a FORM block, where it used to say only "write the guide content"',
    prompt.includes('FORM. The deliverable is not prose and it is not Markdown.'));
  check('and it names the schema of record rather than describing a shape of its own',
    prompt.includes('platform Resource schema'));
  check('and it says a resource is not a module, because a drafter reading both bleeds them',
    prompt.includes('A RESOURCE IS NOT A LEARNING MODULE'));

  // What the drafter produced with no FORM block. This is the defect, reproduced.
  const markdownDraft = '# AI-Assisted Code Review Checklist\n\nReview AI-assisted changes for correctness and scope.\n';
  const before = inspectArtifactFormat({ path: target, content: markdownDraft });
  equal('the prose a formless brief produces is held, exactly as production held it',
    before.code, 'artifact-format.json-unparsable');

  // What the FORM block asks for, with every field taken from the instruction.
  const shapedDraft = JSON.stringify({
    id: 'ai-assisted-code-review-checklist',
    slug: 'ai-assisted-code-review-checklist',
    title: 'AI-Assisted Code Review Checklist',
    summary: 'Review AI-assisted changes for correctness, security, evidence, and scope.',
    category: 'AI coding agents',
    format: 'checklist',
    audience: ['developer', 'operator'],
    level: 'intermediate',
    providers: ['provider-neutral'],
    prerequisites: ['A reviewable change set'],
    owner: 'project42-editorial',
    reviewCadenceDays: 30,
    lastVerified: '2026-09-11',
    tags: ['coding-agents', 'code-review'],
    sections: [{
      id: 'verify-review',
      title: 'Expected evidence and verification',
      paragraphs: ['An independent review tied to an immutable revision, with reproducible findings and an explicit decision.'],
    }],
    sources: [{
      title: 'Pull request reviews',
      url: 'https://docs.github.com/en/pull-requests/reference/pull-request-reviews',
      publisher: 'GitHub',
      lastVerified: '2026-09-11',
    }],
  }, null, 2);
  const after = inspectArtifactFormat({ path: target, content: shapedDraft });
  check(`a draft in the form the brief now asks for passes the same check (${after.reason ?? 'no reason'})`, after.ok);
}

// --- the diagram surface: two deliverables, one content slot -------------------
//
// Same test, same real config, for the surface where the mismatch was total
// rather than partial. FORM_INSTRUCTIONS.mermaid asked for "two things" and the
// pipeline had one content slot, so a compliant drafter's output was held on
// artifact-format.mermaid-unrecognized (four items in production) and a
// non-compliant one's on registration.no-catalogue-entry. Nothing is asserted
// here against a fixture config: the brief is built from the operator's own
// visual-guide surface and run through the real parser, the real format guard
// and the real registry writer.

{
  const real = JSON.parse(readFileSync(DEFAULT_TARGETS_PATH, 'utf8'));
  const target = 'diagrams/retrieval-pipeline.mmd';
  equal('a diagrams/ path is the guide-diagram surface, which is what picks the form',
    surfaceForTargetPath(target), 'guide-diagram');

  // `guide-diagram` is the CONTRACT surface name and what reaches formFor at
  // runtime; `visual-guide` is the operator's config key. Both are exercised,
  // because covering one spelling is how the field-guide surface went three
  // weeks with no form at all.
  for (const surface of ['guide-diagram', 'visual-guide']) {
    const prompt = buildPrompt(
      { subject_id: 'retrieval-pipeline-visual-guide', surface, kind: 'needs-creating', title: 'Retrieval pipeline', level: 'intermediate' },
      { level: 'intermediate' }, [], surfaceConfigFor(real, surface) ?? real.surfaces[surface],
    );
    check(`the ${surface} brief names the source block tag the parser splits on`,
      prompt.includes('```' + MERMAID_FENCE_TAG));
    check(`the ${surface} brief names the catalogue block tag the parser splits on`,
      prompt.includes('```' + CATALOGUE_FENCE_TAG));
    check(`the ${surface} brief names every category a page actually lists`,
      DIAGRAM_CATEGORIES.every((category) => prompt.includes(category)));
    check(`the ${surface} brief says id and source are derived, not authored`,
      prompt.includes('Do NOT include "id" or "source"'));
    check(`the ${surface} brief asks for the altText obligation by name`,
      prompt.includes('altText'));
  }

  const source = 'flowchart LR\n    accTitle: Retrieval pipeline\n    accDescr: Chunk, embed, index, retrieve, answer.\n\n    S([Source]) --> C[Chunk] --> E[Embed] --> I[(Index)] --> R[Retrieve] --> A[Answer]';
  const entry = {
    title: 'Retrieval pipeline, from source to grounded answer',
    category: 'Research',
    summary: 'How source material becomes a searchable index and how a question travels through it to a cited answer.',
    description: 'Preparation is done once per corpus; answering happens per question and reads only the index.',
    altText: 'A left-to-right flow from Source through Chunk, Embed and Index, joined by Retrieve, ending at Answer.',
    caption: 'Retrieval separates preparing a corpus from answering from it.',
    takeaways: ['Preparation and answering meet only at the index.', 'The answering path never reads the raw source.', 'Citations come from retrieved chunks.'],
  };

  // WHAT THE OLD INSTRUCTION PRODUCED. "Produce two things: 1. ... 2. ..." in
  // one blob, committed verbatim to a .mmd path. This is the defect, reproduced.
  const obedient = `## 1. Mermaid diagram source\n\n${source}\n\n## 2. Catalogue entry\n\n${JSON.stringify(entry, null, 2)}`;
  equal('the blob the OLD instruction produced is held, exactly as production held it',
    inspectArtifactFormat({ path: target, content: obedient }).code, 'artifact-format.mermaid-unrecognized');
  equal('and it does not split either, because a heading is not a fence and guessing publishes half a diagram',
    splitDiagramDeliverable({ path: target, content: obedient }).code, 'diagram-deliverable.no-source-block');

  // WHAT THE NEW INSTRUCTION ASKS FOR, obeyed literally, through the real path.
  const drafted = ['```' + MERMAID_FENCE_TAG, source, '```', '', '```' + CATALOGUE_FENCE_TAG, JSON.stringify(entry, null, 2), '```', ''].join('\n');
  const split = splitDiagramDeliverable({ path: target, content: drafted });
  check(`a draft in the form the brief now asks for splits (${split.reason ?? 'no reason'})`, split.ok);
  check('and what gets committed is pure mermaid, which is what the guard that held four items checks',
    inspectArtifactFormat({ path: target, content: split.source }).ok);
  equal('and the .mmd carries no fence', split.source.includes('```'), false);

  const registryText = JSON.stringify({ $schemaVersion: 1, diagrams: [] }, null, 2) + '\n';
  const registration = registrationFor({
    surface: 'guide-diagram', targetPath: target,
    artifact: split.source, catalogueEntry: split.catalogueEntry,
  });
  const written = JSON.parse(registration.apply(registryText)).diagrams[0];
  equal('and the catalogue entry the drafter authored reaches the registry, which is the whole defect',
    written.id, 'retrieval-pipeline');
  equal('carrying the alt text a reader who cannot see the image depends on', written.altText, entry.altText);
  equal('and the source filename derived from where the file lands', written.source, 'retrieval-pipeline.mmd');
}

// --- what an update brief is allowed to call a cited source -------------------
//
// Gate 2 issues #190-#216, read 2026-09-12: 49 Track 2 currency items, 33
// failed the automated factual review, and 15 of the 16 that "passed" are
// refusal documents rather than resources. One input explains nearly all of
// it. track-2-controller.mjs records the corpus path of the file being
// corrected as the item's evidence reference; evidenceCitations turned that
// into a citation; buildPrompt rendered it as "the cited source on the
// existing item" -- directly under a standing constraint telling the drafter
// to cite only what resolves over https. The drafter refused, correctly, and
// the reviewer failed it for the refusal, also correctly.
{
  const corpusPath = 'content/resources/setup-quick-reference/agent-configuration-layering-reference.json';

  check('a corpus path is not a citation, whatever else it is',
    !isResolvableCitation(corpusPath));
  check('and neither is a bare slug, a DOI, or an empty reference',
    !isResolvableCitation('agent-configuration-layering-reference')
    && !isResolvableCitation('doi:10.1000/182')
    && !isResolvableCitation(''));
  check('an https URL still is one', isResolvableCitation('https://12factor.net/'));

  const item = {
    subject_id: 'agent-configuration-layering-reference-field-guide',
    id: '01a024de-1b76-723d-ac6c-6c705ea4e8b5',
    surface: 'guide',
    kind: 'needs-updating',
    title: 'Agent Configuration Layering Reference',
    level: 'intermediate',
    recordedTarget: {
      repository: 'project42dev/project42-content',
      path: 'resources/setup-quick-reference/agent-configuration-layering-reference.json',
    },
    // The shape track-2-controller.mjs actually records: the item's own
    // corpus path, as its one and only evidence reference.
    record: { evidence: [{ reference: corpusPath, digest: `sha256:${'0'.repeat(64)}` }] },
    currencyFindings: ['The cited https://12factor.net/ entry passed its 90-day review cadence on 2026-08-30 and was not re-verified.'],
  };
  const real = loadInventory(DEFAULT_TARGETS_PATH);
  const roles = { drafter: 'drafter' };

  // The conversion that produced the defect, driven on the record shape
  // track-2-controller.mjs actually writes. This is the assertion that bites
  // if the filter is ever relaxed back to `entry?.reference`.
  equal('a corpus-path evidence reference produces no citation at all',
    evidenceCitations(item.record).length, 0);
  equal('while an https evidence reference still produces one',
    evidenceCitations({ evidence: [{ reference: 'https://12factor.net/', digest: `sha256:${'0'.repeat(64)}` }] }).length, 1);
  check('and a record carrying both keeps only the one a reader can open',
    evidenceCitations({
      evidence: [
        { reference: corpusPath, digest: `sha256:${'0'.repeat(64)}` },
        { reference: 'https://12factor.net/', digest: `sha256:${'1'.repeat(64)}` },
      ],
    }).map((c) => c.url).join() === 'https://12factor.net/');

  const built = briefFor({
    item, roles, targets: real, evidence: null,
    citations: evidenceCitations(item.record), findings: item.currencyFindings,
  });
  check(`an update brief still builds when its only evidence reference is a corpus path (${built.error ?? 'built'})`,
    Boolean(built.brief));

  const prompt = built.brief.prompt;
  check('the resource\'s own repository path is never offered to the drafter as a cited source',
    !prompt.includes(`  - ${corpusPath} (`));
  check('and the brief says out loud that no resolvable source survives, rather than listing none silently',
    prompt.includes('carries no cited source that resolves over https'));
  check('and it names the failure mode the corpus saw: an invented substitute citation',
    prompt.includes('Do not invent one'));
  check('the currency inspection\'s own finding reaches the drafter, which is the only thing that says WHAT changed',
    prompt.includes('What the currency inspection found, verbatim:')
    && prompt.includes('passed its 90-day review cadence on 2026-08-30'));

  // A resolvable source is still rendered exactly as before. The fix is a
  // filter on what counts, not a removal of the section.
  const withSource = buildPrompt(
    item, null,
    [{ url: 'https://12factor.net/', publisher: null, last_verified: '2026-05-30' }],
    surfaceConfigFor(real, 'guide'), item.currencyFindings,
  );
  check('a citation that does resolve over https is still listed for the drafter',
    withSource.includes('Cited sources on the existing item')
    && withSource.includes('  - https://12factor.net/ (unregistered publisher, last verified 2026-05-30)'));
  check('and the no-source notice is not also emitted when there IS a source',
    !withSource.includes('carries no cited source that resolves over https'));

  // REFUSE BEFORE ANYTHING IS SPENT. An update brief naming neither a finding
  // nor a source names nothing to correct, and the ensemble costs roughly USD
  // 0.52 to discover that and write it down.
  const empty = briefFor({
    item: { ...item, currencyFindings: [] },
    roles, targets: real, evidence: null, citations: [], findings: [],
  });
  check('an update brief with neither a finding nor a resolvable source is refused, not authored',
    Boolean(empty.error) && !empty.brief);
  check('and the refusal says what would have to be true to brief it',
    typeof empty.error === 'string' && empty.error.includes('Re-run the currency inspection'));

  // A needs-creating item is untouched by all of this: it has no existing
  // content and no cited sources by definition, and refusing one would stop
  // Track 1 dead.
  const creating = briefFor({
    item: { ...item, kind: 'needs-creating', currencyFindings: [] },
    roles, targets: real, evidence: { level: 'intermediate' }, citations: [], findings: [],
  });
  check(`a needs-creating brief is unaffected by the update-brief guard (${creating.error ?? 'built'})`,
    Boolean(creating.brief));
}

// --- the currency finding has to survive a rework ----------------------------
//
// END TO END, through the real store, because the two halves of the fix meet
// here and a unit test on either one alone proves nothing about production.
// gate-queue.mjs records the Gate 1 manifest ONCE, with a hardcoded
// item_revision: 1, and that manifest is where the currency inspector's own
// findings live. generate-briefs pinned its read of that observation to the
// item's CURRENT revision, so the moment an item was reworked or retried past
// revision 1 the lookup silently returned nothing. Of the 49 Track 2 items in
// Gate 2 issues #190-#216, 46 are at revision 4, two at 3 and one at 2: the
// finding was unreachable for every one of them, and the title fell back to
// the raw semantic identity.
{
  const { store: s2, runId: r2, dbPath: db2 } = await estate();
  const finding = 'The cited https://12factor.net/ entry passed its 90-day review cadence on 2026-08-30 and was not re-verified.';
  const corpusPath = 'content/resources/setup-quick-reference/agent-configuration-layering-reference.json';

  const staleId = await seedItemWithOutcome(s2, r2, 'stale-guide', 'update', {
    surface: 'guide',
    evidence: [{ reference: corpusPath, digest: sha256Digest(corpusPath) }],
  });
  // The manifest, recorded exactly where gate-queue.mjs puts it: revision 1.
  await s2.recordObservation({
    observation_id: generateUuidV7(), run_id: r2, item_id: staleId, item_revision: 1,
    evidence_reference: `orchard/gate-manifest/gate-1:${staleId}`,
    evidence_digest: sha256Digest(finding), observed_at: NOW, gate: 'gate-1',
    manifest_item: { item_id: staleId, item_revision: 1, title: 'Agent Configuration Layering Reference', evidence_refs: [finding], score: { value: 7 } },
  });
  await walkTo(s2, r2, staleId, 'ado-linked');

  // Now rework it, the way a Gate 2 request-changes does: a new contiguous
  // revision, with the manifest observation left where it was.
  const prior = JSON.parse(s2.db.prepare(
    'SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = 1',
  ).get(staleId).record_json);
  await s2.recordItem({ ...prior, item_revision: 2, state: 'ado-linked', created_at: NOW, updated_at: NOW });
  s2.db.prepare('UPDATE workflow_item SET current_revision = 2 WHERE item_id = ?').run(staleId);
  s2.close();

  const r = await generateBriefs({ ...base, dbPath: db2, limit: 10 });
  const brief = r.briefs.find((b) => b.subjectId === staleId);
  check(`a reworked update item is briefed rather than stranded (${JSON.stringify(r.skipped)})`, Boolean(brief));
  if (brief) {
    check('the currency finding reaches the drafter even though the item is past revision 1',
      brief.prompt.includes(finding));
    check('and the manifest title survives the rework instead of falling back to the semantic identity',
      brief.title === 'Agent Configuration Layering Reference');
    check('and the corpus path is still never offered as a cited source',
      !brief.prompt.includes(`  - ${corpusPath} (`));
  }
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
