#!/usr/bin/env node
// Tests for the queue-to-brief generator.
//
// These assert the PROMISES that make the handoff a handoff. The arithmetic of
// building a prompt string does not matter much; what matters is that the link
// back to the queue survives, that the tool refuses rather than guesses, and
// that a count of stranded work is a real count and not an artefact of where a
// loop stopped.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateBriefs, resolveRoles, loadInventory, normalizeStableId, briefIdFor,
  briefFor, topicSlug, BriefGenerationError, ROLE_JOBS,
} from './generate-briefs.mjs';
import { matchToWorkItem } from './ingest-proposals.mjs';

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

function throws(label, fn, predicate) {
  try {
    fn();
    failures.push(`${label} (did not throw)`);
  } catch (err) {
    if (predicate(err)) passed += 1;
    else failures.push(`${label} (threw the wrong thing: ${err.message})`);
  }
}

// --- fixture -----------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'orchard-briefs-'));
const dbPath = join(root, 'content.db');

const db = new DatabaseSync(dbPath);
db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
const insert = db.prepare(
  `INSERT INTO work_item (id, kind, subject_id, surface, title, state, priority, first_seen, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const NOW = '2026-08-04T00:00:00.000Z';
insert.run('create:alpha-learn', 'needs-creating', 'alpha-learn', 'learn', 'Alpha', 'queued', 9, NOW, NOW);
insert.run('create:beta-learn', 'needs-creating', 'beta-learn', 'learn', 'Beta', 'queued', 5, NOW, NOW);
insert.run('create:gamma-field-guide', 'needs-creating', 'gamma-field-guide', 'field-guide', 'Gamma', 'queued', 1, NOW, NOW);
// Three on an unmapped surface, so a stranded count has something to be wrong about.
insert.run('create:d-visual-guide', 'needs-creating', 'd-visual-guide', 'visual-guide', 'D', 'queued', 4, NOW, NOW);
insert.run('create:e-visual-guide', 'needs-creating', 'e-visual-guide', 'visual-guide', 'E', 'queued', 3, NOW, NOW);
insert.run('create:f-visual-guide', 'needs-creating', 'f-visual-guide', 'visual-guide', 'F', 'queued', 2, NOW, NOW);
// Already picked up, and one a person finished. Neither may be re-issued.
insert.run('create:claimed-learn', 'needs-creating', 'claimed-learn', 'learn', 'Claimed', 'claimed', 8, NOW, NOW);
insert.run('create:done-learn', 'needs-creating', 'done-learn', 'learn', 'Done', 'done', 8, NOW, NOW);
db.close();

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
  [ROLE_JOBS.drafter]: 'model-a',
  [ROLE_JOBS.verifier]: 'model-b',
  [ROLE_JOBS.adversary]: 'model-c',
  [ROLE_JOBS.arbiter]: 'model-d',
});

const targetsPath = join(root, 'targets.json');
writeFileSync(targetsPath, JSON.stringify({
  repository: 'example/content',
  surfaces: {
    learn: { pathTemplate: 'content/modules/{topic}/', suffix: '-learn' },
    'field-guide': { pathTemplate: 'content/resources/{topic}/', suffix: '-field-guide' },
    'visual-guide': { pathTemplate: null, suffix: '-visual-guide' },
  },
}));

const registryPath = join(root, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  opportunities: [
    {
      id: 'alpha-learn', title: 'Alpha', surface: 'learn', level: 'advanced',
      gapEvidence: 'zero occurrences in the measured corpus',
      marketSignal: 'Present in 9 of 27 surveyed sources.',
      provenance: { suggestedBy: ['source-one', 'source-two'] },
    },
  ],
}));

const base = { dbPath, mapPath: goodMap, targetsPath, inventoryPath, registryPath };

// --- the link back to the queue ----------------------------------------------

{
  const r = generateBriefs({ ...base, limit: 10 });

  equal('only queued work is eligible; claimed and done are not', r.eligible, 6);
  equal('a brief is written for every eligible item on a mapped surface', r.briefs.length, 3);

  const alpha = r.briefs.find((b) => b.subjectId === 'alpha-learn');
  check('every brief carries the subject id of the queue item it serves', Boolean(alpha));
  equal('and the brief id ends with that subject id, which is the channel that survives the round trip',
    alpha.id, 'p42-create-alpha-learn');
  equal('and the brief also carries the work item id, for a human reading it',
    alpha.workItemId, 'create:alpha-learn');

  // The real proof: the ingest, given only what the delivery platform writes
  // into a proposal filename, gets back to the right queue row.
  const subjectIds = new Set(['alpha-learn', 'beta-learn', 'gamma-field-guide']);
  const match = matchToWorkItem({ doc: { briefId: alpha.id } }, subjectIds);
  equal('and the ingest recovers the subject from the brief id alone', match?.subjectId, 'alpha-learn');

  equal('a needs-creating brief names where the content goes',
    alpha.targets[0].pathPrefixes[0], 'content/modules/alpha/');
  equal('and which repository', alpha.targets[0].repository, 'example/content');

  check('evidence from the discovery list reaches the drafter, not just the title',
    alpha.prompt.includes('zero occurrences in the measured corpus')
    && alpha.prompt.includes('Present in 9 of 27 surveyed sources.')
    && alpha.prompt.includes('source-one, source-two'));
  check('and the level from the discovery list wins over the default',
    alpha.prompt.includes('at advanced level')
    && alpha.acceptanceCriteria.some((c) => c.includes('advanced level')));

  const beta = r.briefs.find((b) => b.subjectId === 'beta-learn');
  check('an item with no discovery evidence still gets a usable brief',
    beta.prompt.includes('Write the learn content') && beta.acceptanceCriteria.length > 0);

  check('every brief carries acceptance criteria, or nothing can verify it',
    r.briefs.every((b) => b.acceptanceCriteria.length >= 3));
  check('every role carries its own completion budget, never a global one',
    r.briefs.every((b) => Object.values(b.roles).every((role) => role.maxCompletionTokens > 4096)));
}

// --- stranded work is counted, not stopped at ---------------------------------

{
  const r = generateBriefs({ ...base, limit: 1 });
  equal('the limit caps what is EMITTED', r.briefs.length, 1);
  equal('and every stranded item is still counted, whatever the limit', r.skipped.length, 3);
  equal('and the rest are reported as not reached rather than silently dropped', r.notReached, 2);
  equal('emitted plus stranded plus not-reached accounts for every eligible item',
    r.briefs.length + r.skipped.length + r.notReached, r.eligible);
  check('and the reason names the surface and what is missing',
    r.skipped[0].reason.includes('visual-guide') && r.skipped[0].reason.includes('pathTemplate'));
}

// --- claiming -----------------------------------------------------------------

{
  const r = generateBriefs({ ...base, limit: 2, apply: true, now: NOW, claimedBy: 'tester' });
  equal('under --apply the emitted items are claimed', r.claimed.length, 2);

  const after = new DatabaseSync(dbPath);
  const states = after.prepare('SELECT subject_id, state, claimed_by FROM work_item WHERE state = ?').all('claimed');
  check('and the claim names who took it', states.every((s) => s.claimed_by === 'tester' || s.subject_id === 'claimed-learn'));

  const again = generateBriefs({ ...base, limit: 10 });
  check('so a second run does not re-issue them, which would race two proposals at one subject',
    !again.briefs.some((b) => r.claimed.includes(b.subjectId)));
  after.close();

  // Put them back for the remaining cases.
  const reset = new DatabaseSync(dbPath);
  reset.prepare("UPDATE work_item SET state = 'queued', claimed_by = NULL WHERE claimed_by = 'tester'").run();
  reset.close();
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

// --- needs-updating ------------------------------------------------------------

{
  const u = new DatabaseSync(dbPath);
  u.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, priority, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run('update:mod-x', 'needs-updating', 'mod-x', 'learn', 'Module X', 10, NOW, NOW);
  u.prepare('INSERT INTO source (id, url_prefix, publisher, review_cadence_days) VALUES (?, ?, ?, ?)')
    .run('vendor', 'https://vendor.example/', 'Vendor', 30);
  u.prepare(
    `INSERT INTO item (id, surface, path, title, content_sha256, indexed_at)
     VALUES ('mod-x', 'learn', 'modules/x.json', 'Module X', 'abc', ?)`,
  ).run(NOW);
  u.prepare('INSERT INTO citation (item_id, source_id, url, title, last_verified) VALUES (?, ?, ?, ?, ?)')
    .run('mod-x', 'vendor', 'https://vendor.example/page', 'Page', '2020-01-01');
  u.close();

  const r = generateBriefs({ ...base, limit: 1 });
  const brief = r.briefs[0];
  equal('a needs-updating item leads the queue and gets an update brief', brief.subjectId, 'mod-x');
  equal('with an id that says so', brief.id, 'p42-update-mod-x');
  check('the prompt tells the drafter this is a correction, not a rewrite',
    brief.prompt.includes('This is an update, not a rewrite'));
  check('and hands it the cited sources it has to check',
    brief.prompt.includes('https://vendor.example/page') && brief.prompt.includes('2020-01-01'));
  check('and the criteria require the diff to show the correction and nothing else',
    brief.acceptanceCriteria.some((c) => c.includes('left as it was')));
}

// --- report ------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on the queue-to-brief generator.`);
