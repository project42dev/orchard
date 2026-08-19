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
//   - It never marks work done. Under --apply it records the 'executing'
//     transition on an ado-linked item, which is what "a worker picked this
//     up" means in the lifecycle. Nothing else.
//
// SCHEMA. This generator reads workflow_item from schema/migrations/002, the
// ONLY item table the deployed database has. The first version read work_item
// from schema/content-db.sql, a developer-local schema no migration ever
// applies, so the queue query would have failed `no such table` on every
// production run. Eligibility is current_state = 'ado-linked': Gate 1 has
// approved the item and the ADO work item exists, and 'executing' is the one
// legal next step. See lib/gate-queue.mjs for the two-queue trap in full.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

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
  researcher: 'research',
  drafter: 'drafting',
  verifier: 'verification',
  adversary: 'adversary',
  arbiter: 'arbiter',
  finalizer: 'finalization',
};

export const KIND_TAG = {
  'needs-creating': 'create',
  'needs-updating': 'update',
};

// The lifecycle outcome vocabulary (item-record contract) collapsed onto the
// two brief forms. removal and no-change are deliberately absent: neither is
// an authorable piece of prose, and an item carrying one is reported as
// stranded rather than written anyway.
export const OUTCOME_KIND = {
  'new-course': 'needs-creating',
  'new-module': 'needs-creating',
  addition: 'needs-creating',
  update: 'needs-updating',
  correction: 'needs-updating',
  replacement: 'needs-updating',
};

// The contract surface names (item-record schema) and the operator-config
// surface keys grew up separately. Both spellings are honoured so an adopter's
// existing surface-targets file keeps working.
const SURFACE_CONFIG_ALIASES = {
  learning: ['learning', 'learn'],
  guide: ['guide', 'field-guide'],
  'guide-diagram': ['guide-diagram', 'visual-guide'],
};

export function surfaceConfigFor(targets, surface) {
  for (const key of SURFACE_CONFIG_ALIASES[surface] ?? [surface]) {
    const config = targets?.surfaces?.[key];
    if (config) return config;
  }
  return null;
}

export const BRIEF_ID_PREFIX = 'p42';

// A reasoning deployment bills its reasoning tokens against this budget, so a
// value that looks generous for prose can be consumed entirely before a word of
// it is written, returning HTTP 200 with empty content. 4096 did exactly that
// on the first hosted run. It is raised PER ROLE here and never globally,
// because the global default feeds the pre-flight cost projection and a global
// raise prices every request at worst case and aborts the run on the spend
// ceiling before request one.
export const ROLE_TOKEN_BUDGET = {
  researcher: 4096,
  drafter: 8192,
  verifier: 8192,
  adversary: 8192,
  arbiter: 8192,
  finalizer: 4096,
};

export class BriefGenerationError extends Error {
  constructor(problems) {
    super(`brief generation failed with ${problems.length} problem(s)`);
    this.name = 'BriefGenerationError';
    this.problems = problems;
  }
}

// Dispatch-authority validation from the two-track lifecycle design. NOT yet
// wired into briefFor: the deployed engine authorizes work through Gate 1
// state ('queued' after owner approval), not through an authority store.
// Kept exported so the design's tests keep running against it until the
// two-track runtime is wired.
export function validateDispatchAuthority(queueItem, authorityReference, authorityStore) {
  if (!authorityStore || typeof authorityStore.getDispatchBinding !== 'function') {
    return { error: 'dispatch authority must be loaded from the Orchard authority store' };
  }
  if (!authorityReference || authorityReference.queue_work_item_id !== queueItem.id) {
    return { error: 'no exact dispatch authority reference for this queue work item' };
  }
  try { return { binding: authorityStore.getDispatchBinding(authorityReference) }; }
  catch (error) { return { error: error.message }; }
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

// The evidence recorded ON the item revision itself, in citation shape.
//
// The developer-local schema had citation and source tables; the deployed
// schema records evidence references on the item record (item-record contract,
// `evidence: [{reference, digest}]`), which is what an update brief hands the
// drafter. The reference is the URL-shaped thing a reader can follow.
function evidenceCitations(record) {
  return (record?.evidence ?? [])
    .filter((entry) => entry?.reference)
    .map((entry) => ({ url: entry.reference, title: null, publisher: null, last_verified: null }));
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
//
// NEITHER IS A LEARN MODULE. Found live 2026-08-19: the seven learning items
// this pipeline has ever published all landed at content/modules/discovery/
// *.json as raw Markdown, because `learn` declared no form at all and the
// generic instruction above says "Write the learning content", which is an
// instruction to write prose. project42-platform's scripts/load-catalog.mjs
// JSON.parse's every .json under content/modules, so those seven files stop
// the catalog building and the whole learn surface renders nothing. The
// refusal that now holds such an artifact is lib/artifact-format.mjs; this is
// the instruction that means there is nothing to hold.
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
  // Every field below is taken from the LearningModule interface in
  // project42-platform src/schema.ts and its validateCatalog rules, and
  // cross-checked against a real published module
  // (content/modules/ai-foundations/what-ai-does.json). Nothing here is
  // invented: a field this file names is a field that file has.
  'learning-module-json': [
    '',
    'FORM. The deliverable is not prose and it is not Markdown. Return exactly ONE JSON object and nothing else: no code fence, no heading, no preamble, no commentary before or after it. The first character of your output must be { and the last must be }.',
    'The file is committed verbatim to a .json path and the publishing platform runs JSON.parse over every module file it finds. A single character outside the object does not damage one module, it stops the entire catalogue from building and takes every other module down with it.',
    '',
    'The object must conform to the platform LearningModule schema. Every one of these fields is REQUIRED:',
    '  id                 kebab-case slug, matching the file name of the target path without its .json extension. It must be unique across the whole catalogue.',
    '  title              one line of plain text.',
    '  summary            one or two sentences saying what the module makes a learner able to do.',
    '  level              exactly one of "beginner", "intermediate", "advanced".',
    '  providers          array of one or more of "provider-neutral", "anthropic", "openai", "google". Use ["provider-neutral"] unless the subject is one named provider.',
    '  estimatedMinutes   integer, the realistic working time for the module.',
    '  objectives         array of at least one string, each stating something the learner can do afterwards.',
    '  prerequisites      array of module ids, and [] unless you are certain the module you name already exists. The platform refuses a prerequisite that does not resolve to a real module, and refuses a module that requires itself.',
    '  sections           array of at least one object: { "id": kebab-case and unique within this module, "title": string, "paragraphs": array of at least one non-empty string }. A section may also carry "callout" (one string) and "code" ({ "language", "label", "code" }, all three non-empty), both optional.',
    '  knowledgeCheck     { "passPercent": integer from 0 to 100, "questions": array of at least one { "id", "prompt", "choices" (at least two), "answerIndex" (0-based index into choices), "explanation" (non-empty) } }. Question ids are registered across the WHOLE catalogue, so prefix every one of them with this module id or they will collide with another module.',
    '  sources            array of at least one { "title", "url", "publisher", "lastVerified" }. Every url must resolve over https, and lastVerified is a plain YYYY-MM-DD date.',
    '',
    'Include these two as well. The schema treats them as optional; this estate needs them, because they are what tells the currency pass when the module is next due for review:',
    '  reviewCadenceDays  integer from 1 to 365.',
    '  lastVerified       plain YYYY-MM-DD date, the day the sources were checked.',
    '',
    'Omit "activity", "comparisonMatrix", "instructorScript" and "capstone" entirely. Each is optional, and the platform validates every one of them in full whenever it is present, so a partial one fails the whole module where an absent one costs nothing.',
    'Do not nest the module under a wrapper key, do not return an array, and do not write Markdown inside the strings either: a paragraph is prose, not a heading, a bullet list, or a fenced block.',
  ],
};

// The form a surface's deliverable takes when the operator's own surface
// config does not declare one.
//
// surface-targets.json declares form: "mermaid" on the visual-guide surface
// and declared nothing on any other, so a learning item reached the drafter
// with no form instruction at all and was asked, in prose, to "write the
// learning content" for a path ending .json. This default is the safety net
// for an adopter whose config predates the fix; this operator's own config
// now declares the form explicitly as well.
export const SURFACE_DEFAULT_FORM = Object.freeze({
  learning: 'learning-module-json',
  learn: 'learning-module-json',
});

export function formFor(surface, surfaceConfig) {
  return surfaceConfig?.form ?? SURFACE_DEFAULT_FORM[surface] ?? null;
}

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

  // REWORK. An item returned by Gate 2 with `request-changes` is re-queued
  // carrying the owner's reason in `note`. It goes near the TOP of the
  // instructions, before the form rules, because it is the only reason this
  // item is being written a second time. A rework brief that omits it asks the
  // drafter to produce the same piece again, which is how a denial loop burns
  // money without converging.
  const rework = parseReworkNote(item.note);
  if (rework) {
    lines.push(
      '',
      'THIS IS A REWORK. A previous version of this item was reviewed and returned.',
      `The reviewer's reason, verbatim: ${rework}`,
      'Address that reason specifically. Do not restate the previous version, and do not treat this as a fresh brief. If the reason names a factual error, correct it and say what changed. If it names an omission, add the missing material rather than rewriting what was already accepted.',
    );
  }

  // RETRY. An item returned by apply-blocked-retry.mjs was authored once
  // already and the ensemble's own internal review (verifier or adversary)
  // refused the result before it ever reached a human at Gate 2. Producing
  // the same content again gets it blocked again for the same reason, so the
  // refusal goes in front of the drafter exactly like a Gate 2 rework reason
  // does.
  const blockedRetry = parseBlockedRetryNote(item.note);
  if (blockedRetry) {
    lines.push(
      '',
      "THIS IS A RETRY. A previous attempt at this item was authored and this estate's own review refused it before Gate 2.",
      `The refusal, verbatim: ${blockedRetry}`,
      'Address that refusal specifically. Do not produce the same content again; it will be refused again for the same reason.',
    );
  }

  const form = FORM_INSTRUCTIONS[formFor(item.surface, surfaceConfig)];
  if (form) lines.push(...form);

  lines.push('', 'Constraints:');
  for (const c of STANDING_CONSTRAINTS) lines.push(`- ${c}`);
  return lines.join('\n');
}

// The note column carries operational text from several sources. Only a Gate 2
// rework marker becomes drafting instruction; anything else is left alone, so
// an unrelated operator note can never be mistaken for a reviewer's reason.
export const REWORK_PREFIX = 'gate2 changes-requested: ';
export function parseReworkNote(note) {
  if (typeof note !== 'string') return null;
  if (!note.startsWith(REWORK_PREFIX)) return null;
  const reason = note.slice(REWORK_PREFIX.length).trim();
  return reason.length > 0 ? reason : null;
}

// The reviewer's reason, read back from the lifecycle rather than a column.
//
// apply-gate2-rework.mjs records a `changes-requested` transition carrying the
// reason. The most recent one is the reason this item is being written again,
// and it is rendered in the exact `note` form buildPrompt already reads, so an
// item with no rework history costs nothing.
export function reworkNoteFor(db, itemId) {
  const row = db.prepare(
    `SELECT record_json FROM state_transition_event
      WHERE item_id = ? AND to_state = 'changes-requested'
      ORDER BY occurred_at DESC, transition_id DESC LIMIT 1`,
  ).get(itemId);
  if (!row) return null;
  const reason = JSON.parse(row.record_json).reason;
  if (typeof reason !== 'string' || !reason) return null;
  return reason.startsWith(REWORK_PREFIX) ? reason : `${REWORK_PREFIX}${reason}`;
}

// apply-blocked-retry.mjs does not repeat the ensemble's refusal reason --
// it is already permanent on the state_transition_event that recorded the
// block (ingest-proposals.mjs sets `reason` to the reviewer's note at the
// moment it blocks the item). This reads it back the same way reworkNoteFor
// reads a Gate 2 reviewer's reason back, so a retried item's brief still
// says why the last attempt failed instead of asking the ensemble to repeat
// its own mistake blind.
export const BLOCKED_RETRY_PREFIX = 'blocked retry: ';
export function blockedNoteFor(db, itemId) {
  const row = db.prepare(
    `SELECT record_json FROM state_transition_event
      WHERE item_id = ? AND to_state = 'blocked'
      ORDER BY occurred_at DESC, transition_id DESC LIMIT 1`,
  ).get(itemId);
  if (!row) return null;
  const reason = JSON.parse(row.record_json).reason;
  if (typeof reason !== 'string' || !reason) return null;
  return reason.startsWith(BLOCKED_RETRY_PREFIX) ? reason : `${BLOCKED_RETRY_PREFIX}${reason}`;
}
export function parseBlockedRetryNote(note) {
  if (typeof note !== 'string') return null;
  if (!note.startsWith(BLOCKED_RETRY_PREFIX)) return null;
  const reason = note.slice(BLOCKED_RETRY_PREFIX.length).trim();
  return reason.length > 0 ? reason : null;
}

const SURFACE_CRITERIA = {
  learn: [
    'The deliverable is a single JSON object that JSON.parse accepts on the first attempt, with no Markdown, code fence, heading, or commentary anywhere outside it.',
    'Every required LearningModule field is present: id, title, summary, level, providers, estimatedMinutes, objectives, prerequisites, sections, knowledgeCheck, sources. A module missing one of them is refused by the platform catalogue.',
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

// SURFACE_CRITERIA is keyed by the operator-config surface names, and the
// lifecycle records the CONTRACT surface names, so `learning` never matched
// the `learn` block and every learning brief ever generated carried the four
// generic criteria and none of its own. Resolved through the same alias table
// surfaceConfigFor already uses, so both spellings reach the same criteria.
export function surfaceCriteriaFor(surface) {
  for (const key of SURFACE_CONFIG_ALIASES[surface] ?? [surface]) {
    if (SURFACE_CRITERIA[key]) return SURFACE_CRITERIA[key];
  }
  return [];
}

export function buildAcceptanceCriteria(item, evidence) {
  const criteria = [
    'Every source is listed at the end of the piece, with a URL that resolves over https.',
    'No tool name, version number, or configuration key appears that the supplied material does not establish.',
    'Any claim the supplied material cannot support is marked UNKNOWN and omitted rather than asserted.',
    `The piece is written for ${evidence?.level ?? item.level ?? 'intermediate'} level and says so.`,
  ];
  criteria.push(...surfaceCriteriaFor(item.surface));
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

  // The item revision records where the content goes, decided at Gate 1. It is
  // authoritative when present; the surface templates remain the fallback for
  // callers that carry no recorded target.
  const resolved = item.recordedTarget
    ? { target: { repository: item.recordedTarget.repository, pathPrefixes: [item.recordedTarget.path] } }
    : resolveTarget(item, targets);
  if (resolved.error) return { error: resolved.error };
  const surfaceConfig = surfaceConfigFor(targets, item.surface) ?? targets.surfaces?.[item.surface];

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

export async function generateBriefs({
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

  const store = openStateStore(dbPath);
  const db = store.db;
  try {
    // Ado-linked work is eligible, plus one recovery case: an item already
    // 'executing' but with NO artifact_binding recorded for its current
    // revision. That combination only means one thing -- a PRIOR run claimed
    // it and then crashed before ever producing a real proposal for it, since
    // the only legal forward move out of 'executing' with a binding is
    // gate2-ready. Re-issuing a brief for that item is safe, not a duplicate:
    // there is no first proposal racing it, only an abandoned claim. (An item
    // 'executing' WITH a binding already has real work in flight or done and
    // is correctly excluded, same as before.) 'blocked' items are NEVER
    // included here directly: that state is a real verdict from the
    // ensemble's own review, not a crash to recover from silently. The only
    // way a blocked item re-enters this query is apply-blocked-retry.mjs
    // moving it to 'executing' with a fresh, binding-free revision -- an
    // explicit operator decision, not something this query does on its own.
    const rows = db.prepare(
      `SELECT i.item_id, i.track, i.surface, i.outcome, i.semantic_identity,
              i.current_revision, i.origin_run_id, r.record_json,
              i.current_state AS state
         FROM workflow_item i
         JOIN item_revision r ON r.item_id = i.item_id AND r.item_revision = i.current_revision
        WHERE i.current_state = 'ado-linked'
           OR (i.current_state = 'executing' AND NOT EXISTS (
                 SELECT 1 FROM artifact_binding b
                  WHERE b.item_id = i.item_id AND b.item_revision = i.current_revision
               ))
        ORDER BY i.created_at, i.item_id`,
    ).all();

    const manifestFor = db.prepare(
      `SELECT record_json FROM observation_event
        WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?
        ORDER BY observed_at DESC LIMIT 1`,
    );

    const queue = rows.map((row) => {
      const record = JSON.parse(row.record_json);
      const observed = manifestFor.get(
        row.item_id, Number(row.current_revision),
        `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${row.item_id}`,
      );
      const manifest = observed ? JSON.parse(observed.record_json).manifest_item ?? null : null;
      return {
        // The item id is the identifier that survives the delivery platform's
        // filename round trip: a UUID is already lowercase [a-z0-9-], so
        // normalizeStableId leaves it intact and the ingest recovers it.
        id: row.item_id,
        subject_id: row.item_id,
        track: row.track,
        kind: OUTCOME_KIND[row.outcome] ?? null,
        outcome: row.outcome,
        surface: row.surface,
        semantic_identity: row.semantic_identity,
        item_revision: Number(row.current_revision),
        origin_run_id: row.origin_run_id,
        state: row.state,
        title: manifest?.title ?? row.semantic_identity,
        priority: manifest?.score?.value ?? null,
        // REWORK. An item returned by Gate 2 with request-changes carries the
        // reviewer's reason on that recorded transition. It reaches the brief
        // or the denial loop burns money without converging.
        note: reworkNoteFor(db, row.item_id) ?? blockedNoteFor(db, row.item_id),
        recordedTarget: record.target ?? null,
        record,
      };
    }).sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || (a.id < b.id ? -1 : 1));

    const eligible = queue.filter((r) => (
      (!kinds || kinds.includes(r.kind))
      && (!surfaces || surfaces.includes(r.surface))
      && (!subjects || subjects.includes(r.subject_id) || subjects.includes(r.semantic_identity))
    ));

    const briefs = [];
    const skipped = [];
    const claimed = [];

    // EVERY eligible item is evaluated, and only the emitting is capped.
    //
    // Breaking out of the loop at the limit was the first shape of this and it
    // was another silent measurement: with --limit 2 it reported one stranded
    // visual-guide item when eight were stranded, because it stopped looking. A
    // count that depends on how far a loop happened to get is not a count.
    let notReached = 0;
    for (const item of eligible) {
      if (!item.kind) {
        skipped.push({
          subjectId: item.subject_id, surface: item.surface,
          reason: `outcome "${item.outcome}" is not an authorable brief form; removal and no-change are not written by the ensemble`,
        });
        continue;
      }
      const built = briefFor({
        item,
        roles,
        targets,
        evidence: evidenceById.get(item.subject_id) ?? evidenceById.get(item.semantic_identity),
        citations: item.kind === 'needs-updating' ? evidenceCitations(item.record) : [],
      });
      if (built.error) {
        skipped.push({ subjectId: item.subject_id, surface: item.surface, reason: built.error });
        continue;
      }
      if (briefs.length >= limit) { notReached += 1; continue; }
      briefs.push(built.brief);
      if (apply) {
        // Already-executing recovery items need no transition -- they are
        // already exactly there, correctly, from their original (crashed)
        // claim. Recording ado-linked -> executing again for one would be a
        // transition FROM a state the item is not in, which the store
        // rightly refuses.
        if (item.state !== 'executing') {
          await store.recordTransition({
            schema_version: '1.0.0',
            transition_id: generateUuidV7(),
            run_id: item.origin_run_id,
            item_id: item.id,
            item_revision: item.item_revision,
            from_state: 'ado-linked',
            to_state: 'executing',
            cause: 'execution-started',
            actor: claimedBy,
            occurred_at: now,
            correlation_id: generateUuidV7(),
          });
        }
        claimed.push(item.subject_id);
      }
    }

    return { briefs, skipped, claimed, roles, queued: queue.length, eligible: eligible.length, notReached };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.out) {
    console.error('usage: generate-briefs.mjs --db <state.db> --out <briefs.json>');
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
    result = await generateBriefs({
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

  console.log(`queue        ${result.queued} item(s) in state 'ado-linked', ${result.eligible} matching the filters`);
  console.log(`briefs       ${result.briefs.length} written to ${outPath}`);
  for (const b of result.briefs) console.log(`  ${b.id}  (subject ${b.subjectId}, ${b.surface})`);

  console.log('\nensemble, staffed from the model map:');
  for (const [role, cfg] of Object.entries(result.roles)) {
    console.log(`  ${role.padEnd(10)} ${cfg.deployment} (${cfg.providerFamily}), max ${cfg.maxCompletionTokens} completion tokens`);
  }

  if (result.claimed.length) {
    console.log(`\n${result.claimed.length} item(s) moved ado-linked -> executing. A second run will not re-issue them.`);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
