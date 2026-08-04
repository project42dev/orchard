#!/usr/bin/env node
// Tests for the model map validator.
//
// A validator that passes is worth nothing on its own. What matters is that it
// FAILS on each thing it claims to catch, and that it fails loudly rather than
// quietly carrying on with a substitute. So most of these assert a refusal.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateModelMap, loadDeployedModels, assertModelMap, ModelMapError,
  VALID_DIALECTS, WITHDRAWABLE_AVATARS, DEFAULT_MAP_PATH,
} from './validate-model-map.mjs';

let passed = 0;
const failures = [];
const check = (label, ok) => { if (ok) passed += 1; else failures.push(label); };
const equal = (label, a, b) => check(`${label} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`, a === b);
const kinds = (problems) => problems.map((p) => p.kind);

const DEPLOYED = [
  { id: 'good-model', status: 'deployed' },
  { id: 'planned-model', status: 'planned' },
  { id: 'rejected-model', status: 'rejected' },
];

const validJob = { model: 'good-model', dialect: 'max_tokens', why: 'because' };

// --- the core refusal --------------------------------------------------------

{
  const p = validateModelMap({
    map: { jobs: { drafting: { model: 'nowhere-model', dialect: 'max_tokens', why: 'x' } } },
    deployed: DEPLOYED,
  });
  check('an undeployed model is refused', kinds(p).includes('model-not-deployed'));
  equal('and the refusal names the job', p[0].job, 'drafting');
  equal('and names the model', p[0].model, 'nowhere-model');
  check('and states plainly that no substitution will happen',
    /will not substitute/i.test(p[0].fix));
  check('and the refusal does not name a replacement model, because choosing one is not its job',
    !DEPLOYED.some((d) => p[0].fix.includes(d.id)));
}

{
  const p = validateModelMap({
    map: { jobs: { a: { ...validJob, model: 'planned-model' } } },
    deployed: DEPLOYED,
  });
  check('a model that is only PLANNED is refused, not treated as available',
    kinds(p).includes('model-not-ready'));
}

{
  const p = validateModelMap({
    map: { jobs: { a: { ...validJob, model: 'rejected-model' } } },
    deployed: DEPLOYED,
  });
  check('a REJECTED model is refused', kinds(p).includes('model-not-ready'));
  check('and the fix says to read why it was rejected before remapping',
    /rejected for a recorded reason/i.test(p[0].fix));
}

// --- the dialect, which is the thing a global setting cannot cover -----------

{
  const p = validateModelMap({
    map: { jobs: { a: { model: 'good-model', why: 'x' } } },
    deployed: DEPLOYED,
  });
  check('a missing dialect is a failure, NOT a default', kinds(p).includes('dialect-missing'));
  check('and the fix enumerates the legal values',
    [...VALID_DIALECTS].every((d) => p[0].fix.includes(d)));
}

{
  const p = validateModelMap({
    map: { jobs: { a: { model: 'good-model', dialect: 'maxTokens', why: 'x' } } },
    deployed: DEPLOYED,
  });
  check('a dialect that is nearly right is still refused', kinds(p).includes('dialect-unknown'));
}

check('both real wire dialects are accepted, because the estate contains both',
  VALID_DIALECTS.has('max_tokens') && VALID_DIALECTS.has('max_completion_tokens'));

// --- the reason -------------------------------------------------------------

{
  const p = validateModelMap({
    map: { jobs: { a: { model: 'good-model', dialect: 'n/a' } } },
    deployed: DEPLOYED,
  });
  check('a mapping with no stated reason is refused', kinds(p).includes('reason-missing'));
}

// --- voice is validated by a DIFFERENT rule ---------------------------------

{
  const p = validateModelMap({
    map: {
      jobs: { a: validJob },
      voices: { narration: { voice: 'en-US-Ava:DragonHDLatestNeural', why: 'x' } },
    },
    deployed: DEPLOYED,
  });
  equal('a voice is NOT looked for in the deployment list, or every startup would fail',
    p.length, 0);
}

{
  const p = validateModelMap({
    map: { jobs: { a: validJob }, voices: { narration: { voice: 'mai-voice-2' } } },
    deployed: DEPLOYED,
  });
  check('MAI-Voice-2 as a narrator is refused', kinds(p).includes('voice-lacks-word-timing'));
  check('and the fix says why: no WordBoundary events, so nothing can align to it',
    /WordBoundary/.test(p[0].fix));
}

// --- avatars that can be taken away -----------------------------------------

{
  const p = validateModelMap({
    map: { jobs: { a: validJob }, avatars: { roster: ['Clara', 'Jeff'] } },
    deployed: DEPLOYED,
  });
  check('an actor-licensed avatar in the roster is refused', kinds(p).includes('avatar-withdrawable'));
  equal('and it is named', p[0].avatar, 'Jeff');
}

check('the withdrawable set is exactly the six actor-licensed full-body avatars',
  [...WITHDRAWABLE_AVATARS].sort().join(',') === 'Harry,Jeff,Lisa,Lori,Max,Meg');

{
  const p = validateModelMap({
    map: { jobs: { a: validJob }, avatars: { default: 'Nobody', roster: ['Clara'] } },
    deployed: DEPLOYED,
  });
  check('a default avatar outside the roster is refused',
    kinds(p).includes('avatar-default-not-in-roster'));
}

// --- degenerate input --------------------------------------------------------

{
  const p = validateModelMap({ map: { jobs: {} }, deployed: DEPLOYED });
  check('an empty map is refused rather than passing vacuously', kinds(p).includes('empty-map'));
}

{
  const p = validateModelMap({ map: { jobs: { a: { dialect: 'n/a', why: 'x' } } }, deployed: DEPLOYED });
  check('a job with no model at all is refused', kinds(p).includes('job-malformed'));
}

// --- inventory loading -------------------------------------------------------

{
  let threw = null;
  try { loadDeployedModels(join(tmpdir(), 'definitely-not-here-9f3a.json')); }
  catch (e) { threw = e; }
  check('a missing inventory throws a typed error rather than crashing on undefined',
    threw instanceof ModelMapError);
  check('and tells the operator which variable to set',
    /MODEL_INVENTORY_PATH/.test(threw.problems[0].fix));
}

{
  const dir = mkdtempSync(join(tmpdir(), 'orchard-map-'));
  const bare = join(dir, 'array.json');
  writeFileSync(bare, JSON.stringify([{ id: 'x', status: 'deployed' }]));
  equal('a bare array inventory loads', loadDeployedModels(bare).length, 1);

  const wrapped = join(dir, 'wrapped.json');
  writeFileSync(wrapped, JSON.stringify({ models: [{ id: 'x', status: 'deployed' }] }));
  equal('a wrapped inventory loads too, so an adopter is not forced into one layout',
    loadDeployedModels(wrapped).length, 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- assertModelMap throws, it does not return a warning --------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'orchard-map2-'));
  const inv = join(dir, 'inv.json');
  writeFileSync(inv, JSON.stringify(DEPLOYED));
  const badMap = join(dir, 'map.json');
  writeFileSync(badMap, JSON.stringify({ jobs: { a: { model: 'nowhere', dialect: 'n/a', why: 'x' } } }));

  let threw = null;
  try { assertModelMap({ mapPath: badMap, inventoryPath: inv }); } catch (e) { threw = e; }
  check('assertModelMap THROWS on a bad map rather than returning it', threw instanceof ModelMapError);

  const goodMap = join(dir, 'good.json');
  writeFileSync(goodMap, JSON.stringify({ jobs: { a: validJob } }));
  const ok = assertModelMap({ mapPath: goodMap, inventoryPath: inv });
  equal('and returns the job count on a good map', ok.jobs, 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- the shipped map itself --------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'orchard-map3-'));
  const inv = join(dir, 'inv.json');
  // Deliberately NOT this operator's registry: the shipped map must be
  // structurally valid on its own terms, and must fail on a foreign estate with
  // a message that says which models are missing.
  writeFileSync(inv, JSON.stringify([{ id: 'someone-elses-model', status: 'deployed' }]));

  let threw = null;
  try { assertModelMap({ mapPath: DEFAULT_MAP_PATH, inventoryPath: inv }); } catch (e) { threw = e; }
  check('the shipped map fails against an estate that has none of its models', threw instanceof ModelMapError);
  check('and every failure is about a missing model, not a malformed map',
    threw.problems.every((p) => p.kind === 'model-not-deployed'));
  check('so an adopter is told exactly what to deploy, job by job',
    threw.problems.every((p) => p.job && p.model));
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on the model map validator.`);
