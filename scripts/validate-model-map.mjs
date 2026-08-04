#!/usr/bin/env node
// Refuse to run against a model that is not there.
//
// Orchard consumes deployed endpoints and never provisions. So when a job is
// mapped to a model nobody deployed, the only correct behaviour is to stop and
// say which model and which job, because the fix is a human action somewhere
// else entirely.
//
// A nearest-match fallback would be worse than useless. Content would be
// produced by an unintended model, output quality would drift, and the one
// signal saying an operator needs to act would be swallowed. Five separate
// defects in three days were silent successes. This is the place not to add a
// sixth.
//
// Voice is validated differently on purpose. Azure Speech voices are selected
// by SSML voice name and have no deployment, capacity, or quota row, so looking
// for them in the deployment list would fail every startup.

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAP_PATH = resolve(HERE, '..', 'config', 'model-map.json');

export const VALID_DIALECTS = new Set(['max_tokens', 'max_completion_tokens', 'n/a']);

// Avatars that Microsoft licenses from real actors. Access ends when the
// contract does, so a library fronted by one of them breaks on a date nobody
// controls.
export const WITHDRAWABLE_AVATARS = new Set(['Harry', 'Jeff', 'Lisa', 'Lori', 'Max', 'Meg']);

export class ModelMapError extends Error {
  constructor(problems) {
    super(`model map validation failed with ${problems.length} problem(s)`);
    this.name = 'ModelMapError';
    this.problems = problems;
  }
}

// The deployed set, read from whatever the operator points at. Accepts either a
// registry array or an object with a models array, so an adopter is not forced
// into one file layout.
export function loadDeployedModels(inventoryPath) {
  if (!existsSync(inventoryPath)) {
    throw new ModelMapError([{
      kind: 'inventory-missing',
      detail: `no model inventory at ${inventoryPath}`,
      fix: 'point MODEL_INVENTORY_PATH at your deployed model registry',
    }]);
  }
  const doc = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const rows = Array.isArray(doc) ? doc : (doc.models ?? doc.deployments ?? doc.entries ?? null);

  // An inventory keyed by alias, which is what a deployment catalogue naturally
  // looks like: { "gpt-5-6-sol": { name, version, format }, ... }.
  //
  // Missing this shape produced the worst possible failure for a fail-loudly
  // gate. The list shapes above yielded an EMPTY deployed set rather than an
  // error, so every job was reported as not deployed, including the ones that
  // plainly were. Thirteen jobs, thirteen identical problems, all wrong, and
  // the output was indistinguishable from a genuinely unprovisioned tenant. A
  // gate whose entire output is false positives is a gate nobody reads.
  if (rows === null) {
    return Object.entries(doc)
      .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
      .map(([alias, m]) => ({
        id: alias,
        status: m.status ?? 'unknown',
        kind: m.kind ?? m.format ?? null,
        deploymentName: m.deploymentName ?? m.name ?? null,
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      }));
  }

  return rows
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      status: m.status ?? 'unknown',
      kind: m.kind ?? null,
      deploymentName: m.deploymentName ?? null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    }));
}

export function validateModelMap({ map, deployed }) {
  const problems = [];
  // Not problems: jobs whose model is present but declares no readiness status.
  // Carried on the returned array as a property so every existing caller, which
  // treats the result as a list of problems, keeps working unchanged.
  const unchecked = [];
  const byId = new Map(deployed.map((m) => [m.id, m]));

  const jobs = map.jobs ?? {};
  if (Object.keys(jobs).length === 0) {
    problems.push({ kind: 'empty-map', detail: 'the map declares no jobs', fix: 'add at least one job' });
  }

  for (const [job, spec] of Object.entries(jobs)) {
    if (!spec || typeof spec !== 'object' || !spec.model) {
      problems.push({ kind: 'job-malformed', job, detail: `job "${job}" declares no model`, fix: 'give it a model id' });
      continue;
    }

    // The dialect is required, and required to be declared rather than guessed.
    // An unset dialect is a validation failure, not a default, because the two
    // wire dialects in this estate are mutually exclusive and a wrong guess is
    // an HTTP 400 or 422 at the worst possible moment.
    if (!spec.dialect) {
      problems.push({
        kind: 'dialect-missing', job, model: spec.model,
        detail: `job "${job}" does not declare a token parameter dialect`,
        fix: `set dialect to one of ${[...VALID_DIALECTS].join(', ')}`,
      });
    } else if (!VALID_DIALECTS.has(spec.dialect)) {
      problems.push({
        kind: 'dialect-unknown', job, model: spec.model,
        detail: `job "${job}" declares dialect "${spec.dialect}"`,
        fix: `use one of ${[...VALID_DIALECTS].join(', ')}`,
      });
    }

    if (!spec.why) {
      problems.push({
        kind: 'reason-missing', job, model: spec.model,
        detail: `job "${job}" gives no reason for its model choice`,
        fix: 'add why, so the next person can tell an intentional choice from an accident',
      });
    }

    const found = byId.get(spec.model);
    if (!found) {
      problems.push({
        kind: 'model-not-deployed', job, model: spec.model,
        detail: `job "${job}" is mapped to "${spec.model}", which is not in the deployed set`,
        fix: `deploy ${spec.model} in your model registry, or remap the job. Orchard will not substitute a similar model.`,
      });
      continue;
    }
    // An inventory that declares no status per entry is the common case: a
    // deployment catalogue lists what exists and says nothing about readiness.
    // Treating that silence as "not ready" refused every job on a perfectly
    // good inventory, which is the same false-positive failure as reading an
    // alias-keyed file as empty.
    //
    // So the two are kept apart. A DECLARED bad status is a problem. An absent
    // one is reported as a blind spot, in the same spirit as v_unmeasurable:
    // say what was not checked rather than pretending it passed or failed.
    if (found.status === 'unknown') {
      unchecked.push({ job, model: spec.model });
    } else if (found.status !== 'deployed') {
      problems.push({
        kind: 'model-not-ready', job, model: spec.model,
        detail: `job "${job}" is mapped to "${spec.model}", whose status is "${found.status}"`,
        fix: found.status === 'rejected'
          ? `${spec.model} was rejected for a recorded reason. Read it before remapping.`
          : `deploy ${spec.model}, or remap the job`,
      });
    }
  }

  // Voice: name only. There is nothing to look up, so the check is that a name
  // exists and is not the one model known to break downstream alignment.
  for (const [role, spec] of Object.entries(map.voices ?? {})) {
    if (!spec?.voice) {
      problems.push({ kind: 'voice-missing', role, detail: `voice role "${role}" declares no voice`, fix: 'name an SSML voice' });
      continue;
    }
    if (/mai-voice/i.test(spec.voice)) {
      problems.push({
        kind: 'voice-lacks-word-timing', role, detail: `voice role "${role}" uses ${spec.voice}`,
        fix: 'MAI-Voice-2 emits no WordBoundary events, so captions and lip sync cannot align to it. Use a standard or HD neural voice.',
      });
    }
  }

  const avatars = map.avatars ?? {};
  for (const name of avatars.roster ?? []) {
    if (WITHDRAWABLE_AVATARS.has(name)) {
      problems.push({
        kind: 'avatar-withdrawable', avatar: name,
        detail: `${name} is actor-licensed and can be withdrawn when the contract lapses`,
        fix: 'choose a talking head outside the actor-licensed set, or accept that every module fronted by this avatar needs re-rendering on a date you do not control',
      });
    }
  }
  if (avatars.default && avatars.roster && !avatars.roster.includes(avatars.default)) {
    problems.push({
      kind: 'avatar-default-not-in-roster', avatar: avatars.default,
      detail: `the default avatar ${avatars.default} is not in the roster`,
      fix: 'add it to the roster or change the default',
    });
  }

  problems.unchecked = unchecked;
  return problems;
}

export function assertModelMap({ mapPath = DEFAULT_MAP_PATH, inventoryPath }) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const deployed = loadDeployedModels(inventoryPath);
  const problems = validateModelMap({ map, deployed });
  if (problems.length) throw new ModelMapError(problems);
  return {
    map,
    deployed,
    jobs: Object.keys(map.jobs ?? {}).length,
    unchecked: problems.unchecked ?? [],
  };
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
  const mapPath = resolve(args.map ?? DEFAULT_MAP_PATH);
  const inventoryPath = resolve(
    args.inventory
    ?? process.env.MODEL_INVENTORY_PATH
    ?? join(HERE, '..', '..', '..', 'hybrid-solutions-cloud', 'my-homestead-foundry', 'production', 'models', 'registry.json'),
  );

  try {
    const r = assertModelMap({ mapPath, inventoryPath });
    console.log(`model map:  ${mapPath}`);
    console.log(`inventory:  ${inventoryPath}`);
    console.log(`OK. ${r.jobs} job(s) mapped, every model deployed, every dialect declared.`);
    if (r.unchecked.length) {
      // Never let a clean run imply more than it checked.
      console.log('');
      console.log(`READINESS WAS NOT CHECKED FOR ${r.unchecked.length} OF ${r.jobs} JOB(S).`);
      console.log('Your inventory lists these models but declares no status for them, so');
      console.log('"every model deployed" above means present in the inventory, not verified ready:');
      for (const u of r.unchecked) console.log(`  ${u.job}: ${u.model}`);
      console.log('Add a status field per entry if you want that checked.');
    }
  } catch (err) {
    if (!(err instanceof ModelMapError)) throw err;
    console.error(`model map:  ${mapPath}`);
    console.error(`inventory:  ${inventoryPath}`);
    console.error(`\nREFUSING TO START. ${err.problems.length} problem(s):\n`);
    for (const p of err.problems) {
      console.error(`  [${p.kind}] ${p.detail}`);
      console.error(`      fix: ${p.fix}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
