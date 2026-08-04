#!/usr/bin/env node
// Turn the work queue into briefs the authoring ensemble can actually run.
//
// This closes the first of the three broken handoffs. Before it, the content
// database held a queue of items needing work and the delivery platform read a
// hand-written brief file, and the two lists had no relationship at all:
// nothing in the queue could ever be picked up, and work was chosen by whoever
// last edited the brief file.
//
// THE RULE THAT CLOSES IT: a brief must carry the subject id of the queue item
// it serves. The proposal the platform writes is named after the brief, and the
// brief id is the only thing that survives the round trip through the run
// record. So the subject id is encoded in the brief id, and this generator
// refuses to emit a brief whose id would not survive that trip intact.
//
// What this does NOT do, on purpose:
//   - It never invents a destination. A surface with no declared target is
//     reported and skipped, because the platform itself refuses to emit a
//     proposal that cannot name a repository and paths.
//   - It never substitutes a model. A job mapped to a model nobody deployed
//     stops the run and names both, the same rule the model map validator uses.
//   - It never marks work done. Under --apply it moves a queued item to
//     'claimed', which is what "a worker picked this up" means. Nothing else.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAP_PATH = resolve(HERE, '..', 'config', 'model-map.json');
export const DEFAULT_TARGETS_PATH = resolve(HERE, '..', 'config', 'surface-targets.json');
// This operator's instance registry, and the same fallback validate-model-map.mjs
// uses. An adopter passes --inventory or sets MODEL_INVENTORY_PATH.
export const DEFAULT_INVENTORY_PATH = resolve(
  HERE, '..', '..', '..', 'hybrid-solutions-cloud', 'my-homestead-foundry', 'production', 'models', 'registry.json',
);

// Which model map job staffs which ensemble role. The platform's role names are
// fixed; the map's job names are the operator's vocabulary.
export const ROLE_JOBS = {
  drafter: 'drafting',
  verifier: 'verification',
  adversary: 'adversary',
  arbiter: 'arbiter',
};

export const KIND_TAG = {
  'needs-creating': 'create',
  'needs-updating': 'update',
};

export const BRIEF_ID_PREFIX = 'p42';

// A reasoning deployment bills its reasoning tokens against this budget, so a
// value that looks generous for prose can be consumed entirely before a word of
// it is written, returning HTTP 200 with empty content. 4096 did exactly that
// on the first hosted run. It is raised PER ROLE here and never globally,
// because the global default feeds the pre-flight cost projection and a global
// raise prices every request at worst case and aborts the run on the spend
// ceiling before request one.
export const ROLE_TOKEN_BUDGET = {
  drafter: 8192,
  verifier: 8192,
  adversary: 8192,
  arbiter: 8192,
};

export class BriefGenerationError extends Error {
  constructor(problems) {
    super(`brief generation failed with ${problems.length} problem(s)`);
    this.name = 'BriefGenerationError';
    this.problems = problems;
  }
}

// The delivery platform normalizes a brief id into a filename slug before it
// writes the proposal, and the ingest recovers the brief id from that filename.
// Anything the normalizer changes is information lost on the round trip, so
// this is mirrored here in order to REFUSE ids that would not survive it,
// rather than to repair them quietly.
//
// Mirror of Get-Project42StableId in Project42FoundryExecution.psm1.
export function normalizeStableId(value) {
  let s = String(value).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  s = s.replace(/^[^a-z0-9]+/, '');
  if (!s) return null;
  while (s.length < 3) s += '0';
  if (s.length > 128) s = s.slice(0, 128);
  return /^[a-z0-9][a-z0-9._-]{2,127}$/.test(s) ? s : null;
}

export function briefIdFor(kind, subjectId) {
  const tag = KIND_TAG[kind];
  if (!tag) return null;
  return `${BRIEF_ID_PREFIX}-${tag}-${subjectId}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The deployed set, in the operator's own file. Accepts the alias-keyed catalog
// shape and the array shape the model map validator accepts, so one inventory
// serves both tools.
export function loadInventory(inventoryPath) {
  if (!inventoryPath || !existsSync(inventoryPath)) {
    throw new BriefGenerationError([{
      kind: 'inventory-missing',
      detail: `no model inventory at ${inventoryPath}`,
      fix: 'pass --inventory, or set MODEL_INVENTORY_PATH, pointing at your deployed model registry',
    }]);
  }
  const doc = readJson(inventoryPath);
  const out = new Map();
  const rows = Array.isArray(doc) ? doc : (doc.models ?? doc.deployments ?? doc.entries ?? null);
  if (rows) {
    for (const m of rows) {
      if (m && m.id) out.set(String(m.id), { family: m.format ?? m.provider ?? m.providerFamily ?? null });
    }
    return out;
  }
  for (const [alias, entry] of Object.entries(doc)) {
    if (!entry || typeof entry !== 'object') continue;
    out.set(alias, { family: entry.format ?? entry.provider ?? entry.providerFamily ?? null });
  }
  return out;
}

// Staff the four roles from the model map, and refuse on anything that would
// make the ensemble meaningless.
//
// The independence rule is the platform's, not this tool's: it throws at run
// time when the verifier and the drafter share a provider family, after the
// drafter has already been paid for. Catching it here costs nothing and catches
// it before the money is spent.
export function resolveRoles(modelMap, inventory) {
  const problems = [];
  const roles = {};

  for (const [role, job] of Object.entries(ROLE_JOBS)) {
    const assignment = modelMap.jobs?.[job];
    if (!assignment?.model) {
      problems.push({
        kind: 'job-unmapped',
        role,
        detail: `the model map has no job "${job}", so the ${role} has no model`,
        fix: `add jobs.${job} to the model map`,
      });
      continue;
    }
    const deployed = inventory.get(assignment.model);
    if (!deployed) {
      problems.push({
        kind: 'model-not-deployed',
        role,
        detail: `job "${job}" wants model "${assignment.model}" for the ${role}, and it is not in the deployed set`,
        fix: `deploy "${assignment.model}", or remap jobs.${job} to something you have`,
      });
      continue;
    }
    if (!deployed.family) {
      problems.push({
        kind: 'family-undeclared',
        role,
        detail: `the inventory does not declare a provider family for "${assignment.model}"`,
        fix: 'add a format/provider field to that inventory entry; family independence cannot be checked without it',
      });
      continue;
    }
    roles[role] = {
      deployment: assignment.model,
      providerFamily: deployed.family,
      maxCompletionTokens: ROLE_TOKEN_BUDGET[role],
    };
  }

  if (roles.drafter && roles.verifier
      && roles.drafter.providerFamily === roles.verifier.providerFamily) {
    problems.push({
      kind: 'family-collision',
      detail: `drafter (${roles.drafter.deployment}) and verifier (${roles.verifier.deployment}) are both `
        + `${roles.drafter.providerFamily}. The delivery platform refuses this at run time: two arms of one `
        + 'family agree for reasons that have nothing to do with whether the content is right.',
      fix: `remap jobs.${ROLE_JOBS.verifier} to a deployment from a different provider family`,
    });
  }
  if (roles.verifier && roles.adversary
      && roles.verifier.providerFamily === roles.adversary.providerFamily) {
    problems.push({
      kind: 'family-collision',
      detail: `verifier (${roles.verifier.deployment}) and adversary (${roles.adversary.deployment}) are both `
        + `${roles.verifier.providerFamily}. The adversary exists to attack what the verifier accepted.`,
      fix: `remap jobs.${ROLE_JOBS.adversary} to a deployment from a different provider family`,
    });
  }
  if (roles.arbiter && roles.drafter
      && roles.arbiter.deployment === roles.drafter.deployment) {
    problems.push({
      kind: 'arbiter-judges-itself',
      detail: `the arbiter and the drafter are the same deployment (${roles.arbiter.deployment}).`,
      fix: `remap jobs.${ROLE_JOBS.arbiter} to a deployment that did not write the draft`,
    });
  }

  if (problems.length) throw new BriefGenerationError(problems);
  return roles;
}

// Strip the surface suffix to get the topic slug the destination directory is
// named for. The suffix is declared per surface, never guessed off the end of
// the string.
export function topicSlug(subjectId, suffix) {
  if (suffix && subjectId.endsWith(suffix)) return subjectId.slice(0, -suffix.length);
  return subjectId;
}

export function resolveTarget(item, targets) {
  const surface = targets.surfaces?.[item.surface];
  if (!surface) {
    return { error: `surface "${item.surface}" is not declared in the surface target map` };
  }
  // pathTemplate (singular) is the older single-path form and is still honoured.
  const templates = surface.pathTemplates ?? (surface.pathTemplate ? [surface.pathTemplate] : []);
  if (!templates.length) {
    return { error: `surface "${item.surface}" has no pathTemplates, so a proposal for it could not say where it applies` };
  }
  const topic = topicSlug(item.subject_id, surface.suffix);
  return {
    target: {
      // A surface may live in a different repository from the others. Visual
      // guides do, and defaulting them to the content platform is what made
      // them look like they had no home at all.
      repository: surface.repository ?? targets.repository,
      pathPrefixes: templates.map((t) => t.replace('{topic}', topic).replace('{subject}', item.subject_id)),
    },
  };
}

// Evidence, read from the discovery list rather than restated from the queue.
//
// The queue is authoritative for STATE and carries a title and a surface. The
// discovery list is authoritative for EVIDENCE: what was measured, where the
// demand signal came from, and which sources suggested it. A drafter handed a
// title alone can only restate its brief, which is exactly the weakness the
// missing researcher role is there to fix; handing over the measured evidence
// is the part that can be done without one.
export function loadCandidateEvidence(registryPath) {
  const out = new Map();
  if (!registryPath || !existsSync(registryPath)) return out;
  const doc = readJson(registryPath);
  for (const c of doc.opportunities ?? doc.candidates ?? doc.entries ?? []) {
    if (!c?.id) continue;
    out.set(String(c.id), c);
  }
  return out;
}

function citationEvidence(db, itemId) {
  try {
    return db.prepare(
      `SELECT c.url, c.title, c.last_verified, s.publisher, s.review_cadence_days
       FROM citation c LEFT JOIN source s ON s.id = c.source_id
       WHERE c.item_id = ? ORDER BY c.last_verified`,
    ).all(itemId);
  } catch {
    return [];
  }
}

const STANDING_CONSTRAINTS = [
  'Do not invent tool names, version numbers, product names, or configuration keys. If the supplied material does not establish one, say so rather than guessing it.',
  'Cite only sources whose URLs resolve directly over https. Do not cite a DOI, a paywalled identifier, or anything a reader cannot open.',
  'If a claim cannot be supported by a resolvable source, mark it UNKNOWN and omit it rather than citing something unreachable.',
  'Write for the stated level. Do not assume knowledge the level does not imply, and do not pad the piece to reach a length.',
];

// A visual guide is not an article. Its deliverable is a Mermaid source file
// plus a catalogue entry, and a drafter handed the generic prose instruction
// will write prose, which cannot be published on that surface at all.
const FORM_INSTRUCTIONS = {
  mermaid: [
    '',
    'FORM. The deliverable is not prose. Produce two things:',
    '1. A Mermaid diagram source, valid on its own, that renders without a legend explaining it.',
    '2. A catalogue entry carrying: title, category, summary, description, altText, caption, and takeaways.',
    '',
    'The altText must describe the flow in words for a reader who cannot see the image, naming the nodes and the direction of travel. It is not a repeat of the caption. The takeaways are what a reader should hold on to after the image is gone, not a list of the boxes in it.',
    'Do not produce an SVG. The rendered image is generated from the source, and hand-authoring one puts the two out of step.',
  ],
};

export function buildPrompt(item, evidence, citations, surfaceConfig) {
  const lines = [];
  const level = evidence?.level ?? item.level ?? 'intermediate';

  if (item.kind === 'needs-creating') {
    lines.push(
      `Write the ${item.surface} content for "${item.title}", at ${level} level.`,
      '',
      'This topic was selected because a discovery pass measured a gap between what the market teaches and what this estate covers. The evidence for that gap follows. Treat it as the reason the piece exists, not as material to quote.',
    );
    if (evidence?.gapEvidence) lines.push('', `Measured gap: ${evidence.gapEvidence}`);
    if (evidence?.marketSignal) lines.push(`Demand signal: ${evidence.marketSignal}`);
    const suggestedBy = evidence?.provenance?.suggestedBy;
    if (Array.isArray(suggestedBy) && suggestedBy.length) {
      lines.push(`Surveyed sources carrying this topic: ${suggestedBy.join(', ')}.`);
    }
  } else {
    lines.push(
      `Correct and bring current the existing ${item.surface} content "${item.title}".`,
      '',
      'This is an update, not a rewrite. The trigger is that a cited source moved or passed its review cadence. State what changed and correct what the change affects. Leave correct material alone: a rewrite destroys review history and makes the diff unreadable.',
    );
    if (citations?.length) {
      lines.push('', 'Cited sources on the existing item, oldest verification first:');
      for (const c of citations.slice(0, 12)) {
        const when = c.last_verified ? `last verified ${c.last_verified}` : 'never verified';
        lines.push(`  - ${c.url} (${c.publisher ?? 'unregistered publisher'}, ${when})`);
      }
    }
  }

  const form = FORM_INSTRUCTIONS[surfaceConfig?.form];
  if (form) lines.push(...form);

  lines.push('', 'Constraints:');
  for (const c of STANDING_CONSTRAINTS) lines.push(`- ${c}`);
  return lines.join('\n');
}

const SURFACE_CRITERIA = {
  learn: [
    'The module states what a learner can do after it that they could not do before.',
    'Every knowledge check is answerable from the material in the module itself, with one unambiguously correct answer.',
    'The module declares its level and does not assume knowledge above that level without saying so.',
  ],
  'field-guide': [
    'The piece answers a question a practitioner arrives with, and answers it before it explains itself.',
    'Every procedure step that can fail carries a remediation path. A step that can fail with no stated next action strands the reader.',
  ],
  'visual-guide': [
    'The Mermaid source is syntactically valid and renders on its own, without a legend explaining what the shapes mean.',
    'The catalogue entry carries a title, category, summary, description, altText, caption, and at least two takeaways.',
    'The altText describes the flow for a reader who cannot see the image, naming the nodes and the direction of travel, and is not a repeat of the caption.',
    'The diagram is provider-neutral. No vendor is named unless the subject of the diagram is that vendor.',
    'No SVG is authored by hand. The rendered image is generated from the source.',
  ],
};

export function buildAcceptanceCriteria(item, evidence) {
  const criteria = [
    'Every source is listed at the end of the piece, with a URL that resolves over https.',
    'No tool name, version number, or configuration key appears that the supplied material does not establish.',
    'Any claim the supplied material cannot support is marked UNKNOWN and omitted rather than asserted.',
    `The piece is written for ${evidence?.level ?? item.level ?? 'intermediate'} level and says so.`,
  ];
  criteria.push(...(SURFACE_CRITERIA[item.surface] ?? []));
  if (item.kind === 'needs-updating') {
    criteria.push(
      'The update states which cited source changed and what that change affected.',
      'Material unaffected by the change is left as it was, so the diff shows the correction and nothing else.',
    );
  }
  return criteria;
}

// Build one brief for one queue item, and refuse if the link back to that item
// would not survive the round trip through the delivery platform.
export function briefFor({ item, roles, targets, evidence, citations }) {
  const briefId = briefIdFor(item.kind, item.subject_id);
  if (!briefId) {
    return { error: `work item kind "${item.kind}" has no brief id form` };
  }

  const normalized = normalizeStableId(briefId);
  if (normalized !== briefId) {
    // The platform lowercases and rewrites anything outside [a-z0-9._-] on its
    // way to a filename. If that changes the id, the subject id cannot be
    // recovered from the proposal and the loop silently reopens.
    return {
      error: `subject id "${item.subject_id}" produces brief id "${briefId}", which the delivery platform `
        + `would rewrite to "${normalized}". The link back to the queue would be lost. `
        + 'Subject ids must be lowercase and limited to a-z, 0-9, dot, underscore and hyphen.',
    };
  }

  const resolved = resolveTarget(item, targets);
  if (resolved.error) return { error: resolved.error };
  const surfaceConfig = targets.surfaces?.[item.surface];

  return {
    brief: {
      id: briefId,
      // Redundant with the id by design. The id is the channel that survives
      // the platform round trip; this is the one a human reads.
      subjectId: item.subject_id,
      workItemId: item.id,
      kind: item.kind,
      surface: item.surface,
      title: item.title,
      prompt: buildPrompt(item, evidence, citations, surfaceConfig),
      acceptanceCriteria: buildAcceptanceCriteria(item, evidence),
      roles,
      targets: [resolved.target],
    },
  };
}

export function generateBriefs({
  dbPath,
  mapPath = DEFAULT_MAP_PATH,
  targetsPath = DEFAULT_TARGETS_PATH,
  inventoryPath,
  registryPath = null,
  limit = 3,
  kinds = null,
  surfaces = null,
  subjects = null,
  claimedBy = 'orchard/generate-briefs',
  apply = false,
  now = new Date().toISOString(),
}) {
  const modelMap = readJson(mapPath);
  const targets = readJson(targetsPath);
  const inventory = loadInventory(inventoryPath);
  const roles = resolveRoles(modelMap, inventory);
  const evidenceById = loadCandidateEvidence(registryPath);

  const db = new DatabaseSync(dbPath);

  // Only queued work is eligible. A claimed or in-progress item already has a
  // brief somewhere, and re-issuing one produces two proposals racing for the
  // same subject id.
  const rows = db.prepare(
    `SELECT id, kind, subject_id, surface, title, state, priority
     FROM work_item WHERE state = 'queued'
     ORDER BY priority DESC NULLS LAST, first_seen, subject_id`,
  ).all();

  const eligible = rows.filter((r) => (
    (!kinds || kinds.includes(r.kind))
    && (!surfaces || surfaces.includes(r.surface))
    && (!subjects || subjects.includes(r.subject_id))
  ));

  const briefs = [];
  const skipped = [];
  const claimed = [];

  const claim = db.prepare(
    "UPDATE work_item SET state = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ? "
    + "WHERE subject_id = ? AND kind = ? AND state = 'queued'",
  );

  // EVERY eligible item is evaluated, and only the emitting is capped.
  //
  // Breaking out of the loop at the limit was the first shape of this and it
  // was another silent measurement: with --limit 2 it reported one stranded
  // visual-guide item when eight were stranded, because it stopped looking. A
  // count that depends on how far a loop happened to get is not a count.
  let notReached = 0;
  for (const item of eligible) {
    const built = briefFor({
      item,
      roles,
      targets,
      evidence: evidenceById.get(item.subject_id),
      citations: item.kind === 'needs-updating' ? citationEvidence(db, item.subject_id) : [],
    });
    if (built.error) {
      skipped.push({ subjectId: item.subject_id, surface: item.surface, reason: built.error });
      continue;
    }
    if (briefs.length >= limit) { notReached += 1; continue; }
    briefs.push(built.brief);
    if (apply) {
      claim.run(claimedBy, now, now, item.subject_id, item.kind);
      claimed.push(item.subject_id);
    }
  }

  db.close();
  return { briefs, skipped, claimed, roles, queued: rows.length, eligible: eligible.length, notReached };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      if (args[key] === undefined) args[key] = next;
      else args[key] = [].concat(args[key], next);
      i += 1;
    }
  }
  return args;
}

function list(value) {
  if (value === undefined || value === true) return null;
  return [].concat(value);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.out) {
    console.error('usage: generate-briefs.mjs --db <content.db> --out <briefs.json>');
    console.error('       [--inventory <deployed-models.json>] [--registry <opportunity-registry.json>]');
    console.error('       [--limit N] [--kind needs-creating] [--surface learn] [--subject <id>] [--apply]');
    process.exit(2);
  }

  // Same resolution order as validate-model-map.mjs. The two tools must agree
  // on what "deployed" means, or the map validates against one set and the
  // briefs are staffed from another.
  const inventoryPath = args.inventory === undefined || args.inventory === true
    ? (process.env.MODEL_INVENTORY_PATH ?? DEFAULT_INVENTORY_PATH)
    : args.inventory;

  let result;
  try {
    result = generateBriefs({
      dbPath: resolve(args.db),
      mapPath: args.map ? resolve(args.map) : DEFAULT_MAP_PATH,
      targetsPath: args.targets ? resolve(args.targets) : DEFAULT_TARGETS_PATH,
      inventoryPath: inventoryPath ? resolve(inventoryPath) : inventoryPath,
      registryPath: args.registry ? resolve(args.registry) : null,
      limit: args.limit ? Number(args.limit) : 3,
      kinds: list(args.kind),
      surfaces: list(args.surface),
      subjects: list(args.subject),
      apply: Boolean(args.apply),
    });
  } catch (err) {
    if (err instanceof BriefGenerationError) {
      console.error(`REFUSING TO GENERATE. ${err.problems.length} problem(s):\n`);
      for (const p of err.problems) {
        console.error(`  [${p.kind}] ${p.detail}`);
        console.error(`    fix: ${p.fix}`);
      }
      process.exit(1);
    }
    throw err;
  }

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result.briefs, null, 2)}\n`);

  console.log(`queue        ${result.queued} item(s) in state 'queued', ${result.eligible} matching the filters`);
  console.log(`briefs       ${result.briefs.length} written to ${outPath}`);
  for (const b of result.briefs) console.log(`  ${b.id}  (subject ${b.subjectId}, ${b.surface})`);

  console.log('\nensemble, staffed from the model map:');
  for (const [role, cfg] of Object.entries(result.roles)) {
    console.log(`  ${role.padEnd(10)} ${cfg.deployment} (${cfg.providerFamily}), max ${cfg.maxCompletionTokens} completion tokens`);
  }

  if (result.claimed.length) {
    console.log(`\n${result.claimed.length} work item(s) moved queued -> claimed. A second run will not re-issue them.`);
  } else if (!args.apply) {
    console.log('\nDRY RUN for the queue: the brief file was written, but nothing was claimed. Pass --apply to claim.');
  }

  if (result.notReached) {
    console.log(`\n${result.notReached} eligible item(s) not reached, because --limit is ${args.limit ?? 3}. The queue is not empty.`);
  }

  if (result.skipped.length) {
    console.log(`\n${result.skipped.length} item(s) SKIPPED, and nothing was generated for them:`);
    const bySurface = new Map();
    for (const s of result.skipped) {
      if (!bySurface.has(s.surface)) bySurface.set(s.surface, []);
      bySurface.get(s.surface).push(s);
    }
    for (const [surface, items] of bySurface) {
      console.log(`  ${surface}: ${items.length} item(s). ${items[0].reason}`);
    }
    console.log('  These are stranded, not deferred. Nothing will pick them up until the reason is fixed.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
