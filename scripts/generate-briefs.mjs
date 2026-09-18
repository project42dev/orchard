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
import { resolve, dirname, join, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { isoDateOf, isFalseFutureDateClaim } from './lib/inspection-dates.mjs';
// The fence tags the drafter is instructed to emit and the parser splits on are
// ONE pair of constants, imported here rather than spelled again. An
// instruction that asks for a tag the parser does not read is the same class of
// defect as the one this import exists to close: what the brief asks for and
// what the pipeline can consume have to be the same thing by construction.
import { MERMAID_FENCE_TAG, CATALOGUE_FENCE_TAG } from './lib/diagram-deliverable.mjs';
import { DIAGRAM_CATEGORIES } from './lib/registration.mjs';
import { isCatalogueTarget, selectedCatalogueContent, CatalogueDeliverableError } from './lib/catalogue-deliverable.mjs';

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
  'needs-removing': 'remove',
};

// The lifecycle outcome vocabulary (item-record contract) collapsed onto the
// brief forms.
//
// removal is here now. It used to be deliberately absent, alongside no-change,
// on the grounds that neither is an authorable piece of prose. That was true
// and it was not a reason to have no answer: an approved removal finding
// reached this queue and was reported as stranded at every pass, forever.
//
// It has its own form now. needs-removing is composed deterministically by
// lib/removal.mjs and never reaches the ensemble, because what goes, which
// catalogue entry goes with it, what still points at it and which URL stops
// resolving are all computable from the target path and the repository tree.
// Sending that to six models would spend real money to be told what a regular
// expression already knows.
//
// no-change stays absent, correctly: there is nothing to publish.
export const OUTCOME_KIND = {
  'new-course': 'needs-creating',
  'new-module': 'needs-creating',
  addition: 'needs-creating',
  update: 'needs-updating',
  correction: 'needs-updating',
  replacement: 'needs-updating',
  removal: 'needs-removing',
};

// A Track 2 "addition" to a selected registry entry adds material to an
// existing record. The delivery engine must see that record and use its update
// contract; otherwise it drafts a new skeleton and drops every existing field.
export function authoringKindFor(outcome, targetPath) {
  return outcome === 'addition' && isCatalogueTarget(targetPath)
    ? 'needs-updating'
    : OUTCOME_KIND[outcome] ?? null;
}

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

// A cited source is something a reader can open. Only http(s) qualifies.
//
// Found live 2026-09-12, on the 49 Track 2 currency items in Gate 2 issues
// #190-#216: 33 of them failed the automated factual review and 15 of the 16
// that "passed" are refusal documents rather than content. The single sentence
// they keep repeating -- "the existing item identifies only a local content
// path, labels its publisher unregistered, and says it has never been
// verified" -- is this function's output, read back. track-2-controller.mjs
// records `evidenceRefs: [{ reference: item.sourcePath, ... }]`, and
// item.sourcePath is the corpus path of the file being corrected
// (content/resources/<pack>/<id>.json). That is the item's own identity, not a
// source it cites. Rendered through buildPrompt's update branch it reached the
// drafter as the one and only "cited source on the existing item", under a
// STANDING_CONSTRAINT that says to cite only what resolves over https -- so
// the drafter correctly refused to treat it as a source, said so in the
// artifact, and the factual reviewer correctly failed the artifact for saying
// it. Three honest stages, one bad input.
export function isResolvableCitation(url) {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// The evidence recorded ON the item revision itself, in citation shape.
//
// The developer-local schema had citation and source tables; the deployed
// schema records evidence references on the item record (item-record contract,
// `evidence: [{reference, digest}]`), which is what an update brief hands the
// drafter. The reference is the URL-shaped thing a reader can follow -- and a
// reference that is NOT one is dropped here rather than dressed up as a source
// downstream. Dropping it is not information loss: the corpus path is already
// the item's target, which the brief carries in full.
export function evidenceCitations(record) {
  return (record?.evidence ?? [])
    .filter((entry) => isResolvableCitation(entry?.reference))
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
//
// NOR IS A FIELD GUIDE RESOURCE. Measured 2026-09-12 over two days of
// production logs: of the 66 Track 2 items that would not prepare, 64 held on
// artifact-format.json-unparsable against a resources/ target. The 2026-08-19
// fix above was never wired to this surface -- `field-guide` declared no form
// and SURFACE_DEFAULT_FORM knew only the two learning spellings, so
// formFor('guide', ...) returned null, buildPrompt pushed no FORM block, and
// the drafter was asked in prose to "write the guide content" for a path
// ending .json. One defect, one surface, sixty-four items.
export const FORM_INSTRUCTIONS = {
  // A DIAGRAM IS TWO DELIVERABLES AND THE PIPELINE HAS ONE CONTENT SLOT, so
  // the two halves travel in one string as two tagged fenced blocks and
  // lib/diagram-deliverable.mjs splits them. Until 2026-09-12 this instruction
  // asked for two things and the pipeline could carry one: the whole blob went
  // verbatim to diagrams/<id>.mmd and registrationFor was called with no
  // catalogue entry at all, so a compliant drafter's work died on
  // artifact-format.mermaid-unrecognized (a .mmd file that opens "## 1. Mermaid
  // diagram source" is not mermaid) and a non-compliant one's died on
  // registration.no-catalogue-entry. Four diagram items were held on the first
  // of those in production and no diagram has ever been published by this
  // pipeline. Asking for the envelope is what makes the two halves separable;
  // the parser is the guard for when it is ignored.
  //
  // Every catalogue field named below is taken from the 11 entries in
  // project42dev/project42-content diagrams/catalogue.json, which all carry
  // exactly the same nine keys and exactly three takeaways, and from
  // CATALOGUE_ENTRY_FIELDS and DIAGRAM_CATEGORIES in lib/registration.mjs,
  // which is what refuses an entry that does not. The accessibility directives
  // are taken from the .mmd files themselves: all 11 open with accTitle and
  // accDescr. Nothing here is invented, and the category list is imported
  // rather than retyped so it cannot drift from the one that validates.
  mermaid: [
    '',
    'FORM. The deliverable is not prose, and it is not one thing. A published diagram is TWO artifacts: the Mermaid source file, and the catalogue entry that is the only reason any reader can find it. Return them as exactly two fenced blocks, in this order, and nothing else that matters:',
    '',
    `\`\`\`${MERMAID_FENCE_TAG}`,
    '<the diagram source, and nothing else>',
    '```',
    '',
    `\`\`\`${CATALOGUE_FENCE_TAG}`,
    '{ ... one JSON object ... }',
    '```',
    '',
    `The block tagged ${MERMAID_FENCE_TAG} is committed as the .mmd file exactly as you write it, with the fence removed. Put nothing inside it but Mermaid: no heading, no "here is the diagram", no commentary. It must be valid on its own and render without a legend explaining what the shapes mean.`,
    'Open it with the diagram keyword (flowchart, sequenceDiagram, stateDiagram-v2, and so on), and give it accTitle and accDescr lines immediately after: every published diagram in this estate carries both, and they are what a screen reader reads.',
    'Do not produce an SVG. The rendered image is generated from the source, and hand-authoring one puts the two out of step.',
    '',
    `The block tagged ${CATALOGUE_FENCE_TAG} must contain exactly ONE JSON object and nothing else, no comments and no trailing prose. It is the catalogue record, and a diagram absent from the catalogue is published to nobody. Every one of these fields is REQUIRED:`,
    '  title        one line of plain text, the name a reader sees.',
    `  category     the heading this diagram is grouped under, exactly as spelled, one of: ${DIAGRAM_CATEGORIES.join(', ')}. A new heading is a product decision, and one invented here files the diagram under a heading no page lists.`,
    '  summary      one sentence saying what the diagram shows.',
    '  description  two or three sentences of context: what the reader is looking at and why the flow is shaped that way. It is not a longer summary.',
    '  altText      the flow described in words for a reader who cannot see the image, naming the nodes and the direction of travel, including where it branches and where it ends. It is not a repeat of the caption, and it is an accessibility obligation rather than a nicety.',
    '  caption      one sentence printed under the image.',
    '  takeaways    an array of exactly three non-empty strings: what a reader should still hold after the image is gone. They are not a list of the boxes in it.',
    '',
    'Do NOT include "id" or "source". Both are derived from the path this diagram is published to and anything you write there is overwritten.',
    'If this is an update, still return the COMPLETE envelope: both blocks, in full. Whole files are committed, so a fragment or a description of what changed publishes a fragment.',
    'An output missing either block, carrying two of either, or whose catalogue block is not one complete JSON object is refused before it reaches a reviewer, and the item is held rather than published half-finished.',
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
    'For a NEW module, omit "activity", "comparisonMatrix", "instructorScript" and "capstone" unless you can supply each included component completely and validly. For an UPDATE, preserve every existing component, including "activity", "comparisonMatrix", "instructorScript" and "capstone"; correct only fields supported by the findings. The publication gate rejects an update that removes an existing activity or instructorScript.',
    'Do not nest the module under a wrapper key, do not return an array, and do not write Markdown inside the strings either: a paragraph is prose, not a heading, a bullet list, or a fenced block.',
  ],
  // Every field below is taken from the Resource interface in
  // project42-platform src/schema.ts and the validateCatalog rules that read
  // it, and cross-checked against all 84 published resource files in
  // project42dev/project42-content (resources/<pack>/<id>.json, measured
  // 2026-09-12). Nothing here is invented. Where the corpus is narrower than
  // the validator the corpus value is the instruction -- owner is
  // "project42-editorial" on all 84, and category is one of fifteen headings
  // the packs already use -- because a record that validates into a heading no
  // page groups is the reachability defect lib/registration.mjs exists for,
  // wearing a different hat.
  'field-guide-resource-json': [
    '',
    'FORM. The deliverable is not prose and it is not Markdown. Return exactly ONE JSON object and nothing else: no code fence, no heading, no preamble, no commentary before or after it. The first character of your output must be { and the last must be }.',
    'The file is committed verbatim to a .json path under resources/, and the Field Guide catalogue loader JSON.parse\'s every .json it finds there. A single character outside the object does not damage one resource, it stops the catalogue from building and takes every other resource down with it.',
    '',
    'The object must conform to the platform Resource schema. A RESOURCE IS NOT A LEARNING MODULE: it has no objectives, no estimatedMinutes, no knowledgeCheck, and its prerequisites are prose, not ids. Every one of these fields is REQUIRED, and the schema has no optional ones:',
    '  id                 kebab-case slug, matching the file name of the target path without its .json extension. It must be unique across the whole catalogue, which resources, modules and learning paths all share.',
    '  slug               identical to id. The two are separate fields and all 84 published resources set them the same; a slug that differs from the id is a second name for one thing.',
    '  title              one line of plain text.',
    '  summary            one or two sentences saying what the resource lets a reader do.',
    '  category           the reader-facing heading this resource is grouped under. Use the one that already fits, exactly as spelled: "AI coding agents", "AI coding tools", "AI service operations", "Context", "Evaluation and safety", "MCP and orchestration", "Models and providers", "Practical workflows", "Prompting", "Provider workflows", "Research", "Self-hosted model operations", "Setup and quick reference", "Troubleshooting and operations", "Verification". A new heading is a product decision, and one invented here files the resource under a heading no page lists.',
    '  format             exactly one of "reference", "how-to", "template", "checklist", "command", "decision-path", "playbook", "troubleshooting". It describes the SHAPE of the piece, and the piece has to be that shape: a "checklist" whose body is three essays is mis-declared.',
    '  audience           array of at least one, with no repeats, of "learner", "practitioner", "developer", "operator", "leader", "educator".',
    '  level              exactly one of "beginner", "intermediate", "advanced".',
    '  providers          array of one or more of "provider-neutral", "anthropic", "openai", "google". Use ["provider-neutral"] unless the subject is one named provider.',
    '  prerequisites      array of PLAIN-ENGLISH strings naming what a reader needs in hand before starting, each non-empty and none repeated, and [] when there is nothing. These are not ids and nothing resolves them, which is the opposite of how a learning module declares its prerequisites.',
    '  owner              "project42-editorial". It is the editorial owner of record for every resource in this estate, not the author of the piece.',
    '  reviewCadenceDays  integer from 1 to 365, how often this resource must be re-checked. The published corpus uses only 30, 45, 60 and 90: 30 for fast-moving tool and provider material, 90 for stable reference.',
    '  lastVerified       plain YYYY-MM-DD date, the day the sources were checked. It may not be a date in the future: nothing was reviewed on a day that has not happened.',
    '  tags               array of at least one kebab-case tag, no repeats. Four or five is the working range in the published corpus.',
    '  sections           array of at least one object: { "id": kebab-case and unique within this resource, "title": string, "paragraphs": array of at least one non-empty string }. A section may also carry "callout" (one string) and "code" ({ "language", "label", "code" }, all three non-empty), both optional.',
    '  sources            array of at least one { "title", "url", "publisher", "lastVerified" }. Every url must resolve over https, and each lastVerified is a plain YYYY-MM-DD date that is not in the future.',
    '',
    'Follow the published shape: all 84 resources carry exactly THREE sections, the last of which states the expected evidence and how a reader verifies they got it ("Expected evidence and verification", or "Expected result and verification" where the piece produces an output). A resource that tells a reader what to do and never says how they would know it worked is half a resource.',
    'Do not nest the resource under a wrapper key, do not return an array, and do not write Markdown inside the strings either: a paragraph is prose, not a heading, a bullet list, or a fenced block. Fenced code belongs in a section\'s "code" object, where the language and label are carried beside it.',
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
//
// EVERY SURFACE, IN BOTH SPELLINGS, on purpose. This map is keyed by the value
// that reaches formFor, which is the CONTRACT surface name (`guide`), while an
// operator's config key is the older one (`field-guide`). Covering only some of
// them is how the field-guide surface went three weeks with no form: the
// 2026-08-19 fix added `learning` and `learn` and stopped there, and nothing
// keyed `guide` existed at all until 2026-09-12. `guide-diagram` is here for
// the same reason and not because anything failed on it -- this operator's own
// config declares form: "mermaid" explicitly, so the entry changes nothing for
// this estate and closes the same hole for an adopter whose config does not.
export const SURFACE_DEFAULT_FORM = Object.freeze({
  learning: 'learning-module-json',
  learn: 'learning-module-json',
  guide: 'field-guide-resource-json',
  'field-guide': 'field-guide-resource-json',
  'guide-diagram': 'mermaid',
  'visual-guide': 'mermaid',
});

export function formFor(surface, surfaceConfig) {
  return surfaceConfig?.form ?? SURFACE_DEFAULT_FORM[surface] ?? null;
}

// THE FILE BEING CORRECTED, IN THE BRIEF.
//
// Found live 2026-09-13 on item 01a024de-1918-7baf-985c-252d89570314. A Track 2
// currency update is a correction order against one published file, and the
// deliverable is that whole file, corrected. Until this existed the brief
// carried the inspection's findings and a target on the brief object that the
// prompt text never named, and nothing else: not the file, not its filename
// (so not its id or slug, which the form rules require to match it), not its
// source records, not the date. The drafter correctly refused -- "The existing
// resource, exact target filename, three source records, and at least one
// relevant source with a resolving https URL were not supplied" -- and that
// refusal reached Gate 2 as an item to approve.
//
// WHERE THE BYTES COME FROM. Not main, and not GitHub. The Track 2 inspection
// read a corpus snapshot pinned to a commit, and recorded on the item the
// corpus path it read and the sha256 of those exact bytes
// (track-2-controller.mjs currencyCandidateFor: evidenceRefs). The authoring
// role materializes the same snapshot binding (orchard-production-runtime.mjs)
// and this reads the file back from it and checks the digest, so the drafter
// is shown the bytes that were inspected, or told plainly that they differ.
//
// SIZE. Resources run to about 4 KB; the largest published module is about
// 37 KB. Up to MAX_EXISTING_CONTENT_BYTES the file goes in whole. Beyond it the
// brief carries every field except the section bodies, the full body of any
// section the findings name, and the JSON path of every section it left out,
// and says that it did so.
export const MAX_EXISTING_CONTENT_BYTES = 40_000;
export const CORPUS_MANIFEST_NAME = '.orchard-corpus-manifest.json';

/** The corpus path and digest the currency inspection recorded on the item, if it recorded one. */
export function corpusEvidenceOf(record) {
  return (record?.evidence ?? []).find((entry) => typeof entry?.reference === 'string'
    && entry.reference.startsWith('content/')) ?? null;
}

/** The corpus commit the item's originating inspection run was pinned to, from its run manifest. */
export function inspectionCommitFor(db, runId) {
  if (!runId) return null;
  const row = db.prepare('SELECT record_json FROM workflow_run WHERE run_id = ?').get(runId);
  if (!row) return null;
  try { return JSON.parse(row.record_json).content_commit ?? null; } catch { return null; }
}

function unavailable(base, reason) {
  return { ...base, status: 'unavailable', reason };
}

function partialRendering(parsed, findings, maxBytes) {
  const haystack = findings.join('\n').toLowerCase();
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const omittedPaths = [];
  const excerpt = { ...parsed };
  excerpt.sections = sections.map((section, index) => {
    const named = [section?.id, section?.title].some((value) => typeof value === 'string' && value && haystack.includes(value.toLowerCase()));
    if (named) return section;
    omittedPaths.push(`$.sections[${index}] (id "${section?.id ?? ''}", title "${section?.title ?? ''}")`);
    return { id: section?.id, title: section?.title, omitted: `body omitted from this brief; it is at $.sections[${index}] in the published file and must be carried through unchanged` };
  });
  let content = JSON.stringify(excerpt, null, 2);
  if (Buffer.byteLength(content) > maxBytes) {
    // Even the named sections do not fit: fall back to ids and titles only.
    excerpt.sections = sections.map((section, index) => ({ id: section?.id, title: section?.title, omitted: `$.sections[${index}]` }));
    omittedPaths.length = 0;
    sections.forEach((section, index) => omittedPaths.push(`$.sections[${index}] (id "${section?.id ?? ''}")`));
    content = JSON.stringify(excerpt, null, 2);
  }
  return { content, omittedPaths };
}

/**
 * The existing file for a corpus-backed update, read from the materialized
 * corpus snapshot and bound to what the inspection read.
 *
 * Returns null for an item whose record names no corpus path (a Track 1 update
 * carries URLs, not a corpus file), otherwise
 *   { required: true, status: 'supplied' | 'unavailable', ... }.
 */
export function existingContentFor({ corpusRoot, record, inspectionCommit = null, findings = [], maxBytes = MAX_EXISTING_CONTENT_BYTES }) {
  const evidence = corpusEvidenceOf(record);
  if (!evidence) return null;
  const base = { required: true, sourcePath: evidence.reference, recordedDigest: evidence.digest ?? null, inspectionCommit };
  if (!corpusRoot) {
    return unavailable(base, 'no corpus snapshot was materialized for this authoring run (ORCHARD_CORPUS_ROOT is unset)');
  }
  const root = resolve(corpusRoot);
  const file = resolve(root, evidence.reference);
  if (!file.startsWith(`${root}${sep}`)) return unavailable(base, `the recorded corpus path ${evidence.reference} escapes the snapshot root`);
  if (!existsSync(file)) return unavailable(base, `the corpus snapshot has no ${evidence.reference}`);
  const bytes = readFileSync(file);
  const digest = sha256Digest(bytes);
  let snapshotCommit = null;
  try { snapshotCommit = JSON.parse(readFileSync(join(root, CORPUS_MANIFEST_NAME), 'utf8')).commit ?? null; } catch { /* a local checkout carries no manifest */ }
  const text = bytes.toString('utf8');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: a diagram source, quoted as text */ }
  let content = text;
  let omittedPaths = [];
  const partial = bytes.byteLength > maxBytes;
  if (partial) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ({ content, omittedPaths } = partialRendering(parsed, findings, maxBytes));
    else content = text.slice(0, maxBytes);
  }
  return {
    ...base,
    status: 'supplied',
    digest,
    digestMatches: base.recordedDigest ? digest === base.recordedDigest : null,
    snapshotCommit,
    byteLength: bytes.byteLength,
    partial,
    omittedPaths,
    content,
    parsed: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null,
  };
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || !Number.isFinite(days)) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The https sources the existing file itself cites, in citation shape. */
export function existingFileCitations(existing) {
  const sources = Array.isArray(existing?.parsed?.sources) ? existing.parsed.sources : [];
  return sources
    .filter((source) => isResolvableCitation(source?.url))
    .map((source) => ({ url: source.url, title: source.title ?? null, publisher: source.publisher ?? null, last_verified: source.lastVerified ?? null }))
    .sort((a, b) => String(a.last_verified ?? '').localeCompare(String(b.last_verified ?? '')));
}

function selectedExistingCatalogue(existing, targetPath, canonicalId) {
  if (!existing || existing.status !== 'supplied') return existing;
  try {
    const entry = selectedCatalogueContent({ path: targetPath, canonicalId, registry: existing.parsed });
    return { ...existing, catalogueEntry: true, canonicalId, content: JSON.stringify(entry, null, 2), parsed: entry, partial: false, omittedPaths: [] };
  } catch (error) {
    if (!(error instanceof CatalogueDeliverableError)) throw error;
    return unavailable(existing, error.message);
  }
}

function existingContentLines(existing, target, today) {
  const lines = [];
  if (existing?.catalogueEntry) {
    lines.push('', `THE EXISTING ${existing.canonicalId} ENTRY from ${existing.sourcePath} at inspection commit ${existing.inspectionCommit ?? 'unknown'}:`,
      'Return one complete corrected JSON object for this entry only. Preserve its id and every existing field. Orchard will replace only this entry in the current protected-main registry and will show that exact diff at Gate 2.',
      '````json', existing.content, '````');
    return lines;
  }
  if (target?.path) {
    const id = basename(target.path).replace(/\.[^.]+$/, '');
    lines.push('', `The file to correct is ${target.repository ? `${target.repository}/` : ''}${target.path}. Its id and slug are "${id}", taken from that filename; keep them exactly.`);
  }
  if (!existing) return lines;
  if (existing.status !== 'supplied') {
    lines.push('', `The existing file could not be supplied: ${existing.reason}.`);
    return lines;
  }
  const provenance = [
    `read from the corpus snapshot${existing.snapshotCommit ? ` at commit ${existing.snapshotCommit}` : ''}`,
    existing.inspectionCommit ? `the currency inspection ran against commit ${existing.inspectionCommit}` : null,
    existing.digestMatches === true
      ? `its sha256 (${existing.digest}) matches the bytes the inspection read`
      : existing.digestMatches === false
        ? `its sha256 (${existing.digest}) DIFFERS from the ${existing.recordedDigest} the inspection read, so the file has changed since the findings above were made; correct only what the findings still describe`
        : `sha256 ${existing.digest}`,
  ].filter(Boolean).join('; ');
  lines.push(
    '',
    `THE EXISTING FILE (${existing.sourcePath}, ${existing.byteLength} bytes; ${provenance}).`,
    'Return the COMPLETE corrected file: every field, every section and every source, changed only where the findings require. It is supplied here in full, so do not refuse for want of it and do not rebuild it from memory.',
  );
  if (existing.partial) {
    lines.push(
      `It is larger than the ${MAX_EXISTING_CONTENT_BYTES}-byte brief limit, so what follows is PARTIAL: every field except the bodies of the sections listed below, which are omitted here and must be carried through from the published file unchanged:`,
      ...existing.omittedPaths.map((path) => `  - ${path}`),
    );
  }
  lines.push('````json', existing.content, '````');

  const parsed = existing.parsed;
  if (parsed) {
    const cadence = Number(parsed.reviewCadenceDays);
    if (typeof parsed.lastVerified === 'string') {
      const due = addDays(parsed.lastVerified, cadence);
      lines.push('', `Dated review record: the file was last verified ${parsed.lastVerified}${Number.isFinite(cadence) ? ` on a ${cadence}-day review cadence, so it fell due for review on ${due}${due && today ? (due <= today ? `, which has passed (today is ${today})` : `, which has not yet arrived (today is ${today})`) : ''}` : ''}.`);
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    if (sources.length) {
      lines.push('', `Its ${sources.length} source record${sources.length === 1 ? '' : 's'}, verbatim, with what each one's own date says about the cadence:`);
      for (const source of sources) {
        const due = typeof source?.lastVerified === 'string' ? addDays(source.lastVerified, cadence) : null;
        const status = due && today ? (due <= today ? `past its review cadence since ${due}` : `within cadence until ${due}`) : 'no dated verification';
        lines.push(`  - "${source?.title ?? ''}" ${source?.url ?? '(no url)'} (${source?.publisher ?? 'no publisher'}, lastVerified ${source?.lastVerified ?? 'none'}; ${status})`);
      }
    }
  }
  return lines;
}

export function buildPrompt(item, evidence, citations, surfaceConfig, findings = [], context = {}) {
  const lines = [];
  const level = evidence?.level ?? item.level ?? 'intermediate';
  const today = context.today ?? null;

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
    // WHAT THE CURRENCY PASS ACTUALLY FOUND. The inspector produces one to
    // eight bounded evidence strings saying why this item is stale
    // (foundry-inspection-producer.mjs RESPONSE_SCHEMA), and they ride through
    // to the Gate 1 manifest item as `evidence_refs`. Until 2026-09-12 they
    // stopped there: buildPrompt read `evidence` only on the needs-creating
    // branch, so an update brief asserted "a cited source moved or passed its
    // review cadence" and never said which source or what moved. A drafter
    // told to correct what a change affects, and not told what changed, has
    // one honest move left, which is to write UNKNOWN -- and 26 of the 49
    // items in Gate 2 issues #190-#216 did exactly that.
    // THE DATE. The drafter's system prompt states it too; it is repeated
    // here because the findings below are dated claims, and a finding that
    // calls a date on or before today "future" is wrong on its face. Those
    // are also removed before they get here (see generateBriefs), and this
    // line is what tells the drafter why one it can still see is not a fact.
    if (today) {
      lines.push('', `Today's date is ${today} (UTC). A date on or before today is not in the future; do not treat one as future-dated, and do not act on any finding that says it is.`);
    }
    if (findings?.length) {
      lines.push('', 'What the currency inspection found, verbatim:');
      for (const f of findings.slice(0, 8)) lines.push(`  - ${f}`);
    }
    lines.push(...existingContentLines(context.existing ?? null, context.target ?? null, today));
    if (citations?.length) {
      lines.push('', 'Cited sources on the existing item, oldest verification first:');
      for (const c of citations.slice(0, 12)) {
        const when = c.last_verified ? `last verified ${c.last_verified}` : 'never verified';
        lines.push(`  - ${c.url} (${c.publisher ?? 'unregistered publisher'}, ${when})`);
      }
    } else {
      // Said out loud, not left as an absent section. A brief that names a
      // source trigger and then silently lists no sources invites the drafter
      // to go looking for one, and one of the 49 did: bug-from-stack-trace
      // substituted an unrelated arXiv URL for the corpus path it was handed.
      // Naming the gap is what stops an invented citation being the fix.
      lines.push('', 'This item carries no cited source that resolves over https. Do not invent one, and do not cite the resource\'s own repository path as its source: a local path is an identifier, not a source a reader can open. Correct what the finding above establishes and leave every claim you cannot source alone.');
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

  if (isCatalogueTarget(item.recordedTarget?.path)) {
    const canonicalId = item.record?.canonical_content_id ?? "";
    const selectedId = canonicalId.startsWith("catalogue:") ? null : canonicalId.split(":").slice(1).join(":");
    lines.push('', 'FORM. Return exactly one JSON object for the selected catalogue record. No fence, wrapper, prose, or whole-registry rewrite.',
      `The selected record is ${canonicalId || '(missing selector)'} in ${item.recordedTarget.path}.`,
      ...(selectedId ? [`Its top-level "id" field MUST be exactly ${JSON.stringify(selectedId)}. Copy that field unchanged from THE EXISTING entry below. A missing or different id prevents publication.`] : []),
      'Return the full existing record shape, including every existing key and nested value. Change only fields the inspection finding supports.',
      'For a catalogue-wide finding, return only the existing non-array top-level metadata keys; Orchard preserves every array unchanged.');
  } else {
    const form = FORM_INSTRUCTIONS[formFor(item.surface, surfaceConfig)];
    if (form) lines.push(...form);
  }

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
// TWO WRITERS, TWO RECORDS. apply-gate2-rework.mjs (the operator tool) records
// a `changes-requested` transition carrying the reason. The PRODUCTION path does
// not: a request-changes comment is applied by apply-gate-decisions.mjs through
// store.recordVerifiedDecision, which writes a decision_event carrying the
// reason and updates workflow_item in place, with no state_transition_event at
// all. Reading only transitions -- the only thing this read until 2026-09-13 --
// meant every reviewer's reason that arrived through GitHub reached no brief.
// Both are read and the newest reason wins, rendered in the exact `note` form
// buildPrompt already reads, so an item with no rework history costs nothing.
export function reworkNoteFor(db, itemId) {
  const transition = db.prepare(
    `SELECT occurred_at, record_json FROM state_transition_event
      WHERE item_id = ? AND to_state = 'changes-requested'
      ORDER BY occurred_at DESC, transition_id DESC LIMIT 1`,
  ).get(itemId);
  const decision = db.prepare(
    `SELECT occurred_at, record_json FROM decision_event
      WHERE item_id = ? AND gate = 'gate-2' AND decision = 'request-changes'
      ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
  ).get(itemId);
  const newestFirst = [transition, decision].filter(Boolean)
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  for (const row of newestFirst) {
    const reason = JSON.parse(row.record_json).reason;
    if (typeof reason !== 'string' || !reason) continue;
    return reason.startsWith(REWORK_PREFIX) ? reason : `${REWORK_PREFIX}${reason}`;
  }
  return null;
}

// apply-blocked-retry.mjs does not repeat the ensemble's refusal reason --
// it is already permanent on the state_transition_event that recorded the
// block (ingest-proposals.mjs sets `reason` to the reviewer's note at the
// moment it blocks the item). This reads it back the same way reworkNoteFor
// reads a Gate 2 reviewer's reason back, so a retried item's brief still
// says why the last attempt failed instead of asking the ensemble to repeat
// its own mistake blind.
export const BLOCKED_RETRY_PREFIX = 'blocked retry: ';
export function failedReviewNoteFor(db, itemId, currentRevision) {
  const rows = db.prepare(
    `SELECT role, record_json FROM agent_handoff
      WHERE item_id = ? AND item_revision = ? AND status = 'failed'
        AND role IN ('factual-verifier', 'assessment-reviewer', 'accessibility-reviewer')
      ORDER BY completed_at DESC`,
  ).all(itemId, currentRevision - 1);
  const findings = rows.map((row) => {
    const summary = JSON.parse(row.record_json).findings?.[0]?.summary;
    return typeof summary === 'string' && summary.trim() ? `${row.role}: ${summary.trim()}` : null;
  }).filter(Boolean);
  if (!findings.length) {
    const held = db.prepare(
      `SELECT record_json FROM observation_event
        WHERE item_id = ? AND item_revision = ?
          AND evidence_reference LIKE 'orchard/rejection-evidence/%'
        ORDER BY observed_at DESC LIMIT 1`,
    ).get(itemId, currentRevision - 1);
    if (held) {
      const rejection = JSON.parse(held.record_json).rejection_evidence;
      if (rejection?.verifierVerdict === 'failed' && rejection.verifierFinding) findings.push(`factual-verifier: ${rejection.verifierFinding}`);
      if (rejection?.adversaryVerdict === 'failed' && rejection.adversaryFinding) findings.push(`assessment-reviewer: ${rejection.adversaryFinding}`);
    }
  }
  if (!findings.length) return null;
  return `${BLOCKED_RETRY_PREFIX}Previous authoring review findings:\n${findings.join('\n').slice(0, 8000)}`;
}
export function blockedNoteFor(db, itemId) {
  const row = db.prepare(
    `SELECT record_json FROM state_transition_event
      WHERE item_id = ? AND to_state = 'blocked'
      ORDER BY occurred_at DESC, transition_id DESC LIMIT 1`,
  ).get(itemId);
  if (!row) return null;
  let reason = JSON.parse(row.record_json).reason;
  if (typeof reason !== 'string' || !reason) return null;
  const reviewRow = db.prepare(
    `SELECT record_json FROM observation_event
      WHERE item_id = ? AND evidence_reference = ?
      ORDER BY item_revision DESC, observed_at DESC LIMIT 1`,
  ).get(itemId, `orchard/gate-manifest/gate-2:${itemId}`);
  if (reviewRow) {
    const manifest = JSON.parse(reviewRow.record_json).manifest_item;
    const findings = ['factual_review', 'accessibility_review']
      .filter((name) => manifest?.[name]?.status === 'failed' && manifest[name].finding)
      .map((name) => `${name}: ${manifest[name].finding}`);
    if (findings.length) reason += `\nPrevious Gate 2 review findings:\n${findings.join('\n').slice(0, 8000)}`;
  }
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
    'The deliverable is a single JSON object that JSON.parse accepts on the first attempt, with no Markdown, code fence, heading, or commentary anywhere outside it.',
    'Every required Resource field is present: id, slug, title, summary, category, format, audience, level, providers, prerequisites, owner, reviewCadenceDays, lastVerified, tags, sections, sources. A resource missing one of them is refused by the platform catalogue.',
    'The resource id is kebab-case, slug matches id exactly, and both match the target file name without its .json extension.',
    'The resource carries exactly three sections, and the last section states the expected evidence or result and how a reader verifies it.',
    'The piece answers a question a practitioner arrives with, and answers it before it explains itself.',
    'Every procedure step that can fail carries a remediation path. A step that can fail with no stated next action strands the reader.',
  ],
  'visual-guide': [
    `The output is exactly two fenced blocks, one tagged ${MERMAID_FENCE_TAG} carrying only the diagram source and one tagged ${CATALOGUE_FENCE_TAG} carrying only the catalogue entry object. An output that runs the two together, or omits either, cannot be published at all.`,
    'The Mermaid source is syntactically valid and renders on its own, without a legend explaining what the shapes mean, and carries accTitle and accDescr.',
    `The catalogue entry carries a title, a category drawn from the published list (${DIAGRAM_CATEGORIES.join(', ')}), summary, description, altText, caption, and three takeaways, and declares neither id nor source.`,
    'The altText describes the flow for a reader who cannot see the image, naming the nodes and the direction of travel, and is not a repeat of the caption.',
    'Vendor names appear only where they identify a real component of the depicted system or the subject itself.',
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
  if (isCatalogueTarget(item.recordedTarget?.path)) return [
    'The output is exactly one valid JSON object for the selected catalogue record.',
    'Its id and all existing fields remain present, and only findings supported by evidence are corrected.',
    'No unrelated catalogue entry or registry array is rewritten.',
  ];
  const criteria = [
    ['visual-guide', 'guide-diagram'].includes(item.surface)
      ? 'The two required fenced blocks contain the complete diagram deliverable; do not add a third source-list block.'
      : 'Every source is listed in the JSON sources array, with a URL that resolves over https.',
    'No tool name, version number, or configuration key appears that the supplied material does not establish.',
    'Any claim the supplied material cannot support is marked UNKNOWN and omitted rather than asserted.',
    `The piece is written for ${evidence?.level ?? item.level ?? 'intermediate'} level and says so.`,
  ];
  criteria.push(...surfaceCriteriaFor(item.surface));
  if (item.kind === 'needs-updating') {
    criteria.push(
      'If a cited source changed, the update identifies it and corrects only claims that the source supports.',
      'Existing teaching components and fields remain present in the corrected artifact.',
    );
  }
  return criteria;
}

// Build one brief for one queue item, and refuse if the link back to that item
// would not survive the round trip through the delivery platform.
export function briefFor({ item, roles, targets, evidence, citations, findings = [], existing = null, today = null }) {
  const briefId = briefIdFor(item.kind, item.subject_id);
  if (!briefId) {
    return { error: `work item kind "${item.kind}" has no brief id form` };
  }

  // REFUSE BEFORE ANYTHING IS SPENT, AGAIN. A corpus-backed update asks for the
  // whole corrected file back, and a drafter that cannot see the file can only
  // invent it or refuse. Measured 2026-09-13: it refused, at full ensemble
  // cost, and the refusal reached Gate 2. When the file cannot be supplied the
  // outcome is knowable in advance, so nothing is sent.
  if (item.kind === 'needs-updating' && existing?.required && existing.status !== 'supplied') {
    return {
      error: `a currency update against ${existing.sourcePath} cannot be briefed without the file it corrects: ${existing.reason}. `
        + 'Materialize the corpus snapshot for the authoring run (the track-2 job binds ORCHARD_CORPUS_ARCHIVE_BLOB) before briefing it.',
    };
  }

  // REFUSE BEFORE ANYTHING IS SPENT. An update brief is a correction order: it
  // says a cited source moved or a review cadence lapsed, and asks for the
  // affected material to be corrected. With neither the finding nor a
  // resolvable cited source there is nothing in the brief that names what to
  // correct, and the ensemble is being paid roughly USD 0.52 an item to
  // discover that and write it down. Measured on the 49 items in Gate 2
  // issues #190-#216: every one reached a human holding a document whose own
  // body says the baseline was never supplied. That is the same class of
  // defect stranded-recovery.mjs refuses for a deterministically-rejected
  // target -- spend nothing to reach a hold that is knowable in advance.
  if (item.kind === 'needs-updating' && !findings.length && !citations?.length) {
    return {
      error: 'a currency update brief carries neither an inspection finding nor a cited source that resolves over https, '
        + 'so it names nothing to correct. Authoring it can only produce a refusal. '
        + 'Re-run the currency inspection for this item, or record a resolvable cited source on the item revision, before briefing it.',
    };
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
      prompt: buildPrompt(item, evidence, citations, surfaceConfig, findings, {
        today,
        existing,
        target: item.kind === 'needs-updating' && item.recordedTarget ? item.recordedTarget : null,
      }),
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
  // A materialized corpus snapshot (the directory holding content/), from
  // which a corpus-backed update's existing file is read. See
  // existingContentFor.
  corpusRoot = null,
}) {
  const today = isoDateOf(now);
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
    // 'changes-requested' and 'stale-approval' are not selected here either,
    // for the same reason: lib/rework-recovery.mjs (called by run-authoring
    // before this) reopens a Gate 2 return at 'executing' with a fresh
    // revision, and this query claims it through the recovery case above.
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

    // THE GATE 1 MANIFEST IS RECORDED ONCE, AT REVISION 1, AND DESCRIBES THE
    // ITEM RATHER THAN A REVISION OF IT (gate-queue.mjs records it with a
    // hardcoded item_revision: 1, because an item held from an earlier run has
    // to announce itself just as well as one held from this run). Pinning the
    // read to the item's CURRENT revision therefore finds nothing the moment
    // an item is reworked or retried past revision 1 -- and the manifest is
    // where the item's title, its score, and the currency inspector's own
    // findings live. Measured 2026-09-12 on the 49 Track 2 items in Gate 2
    // issues #190-#216: 46 sit at revision 4, two at 3 and one at 2, so this
    // lookup returned null for every single one of them, silently, and the
    // brief fell back to titling the work by its raw semantic identity.
    // apply-blocked-retry.mjs, run-verification.mjs and verify-published-live.mjs
    // all read the same observation by item id alone, which is the idiom this
    // one had drifted from; apply-blocked-retry.mjs even carries the comment
    // describing this exact symptom on its own path.
    const manifestFor = db.prepare(
      `SELECT record_json FROM observation_event
        WHERE item_id = ? AND evidence_reference = ?
        ORDER BY item_revision DESC, observed_at DESC LIMIT 1`,
    );

    const queue = rows.map((row) => {
      const record = JSON.parse(row.record_json);
      const observed = manifestFor.get(
        row.item_id,
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
        kind: authoringKindFor(row.outcome, record.target?.path),
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
        note: reworkNoteFor(db, row.item_id)
          ?? failedReviewNoteFor(db, row.item_id, Number(row.current_revision))
          ?? blockedNoteFor(db, row.item_id),
        // The currency inspector's own words about this item, carried on the
        // Gate 1 manifest item as `evidence_refs` (gate-queue.mjs builds them
        // from the candidate's `evidence`, which for a Track 2 currency
        // candidate IS the inspection finding). Read only for an update,
        // because a Track 1 discovery candidate's evidence_refs are surveyed
        // source URLs rather than a finding about published content.
        currencyFindings: authoringKindFor(row.outcome, record.target?.path) === 'needs-updating'
          ? (manifest?.evidence_refs ?? []).filter((entry) => typeof entry === 'string' && entry.length > 0)
          : [],
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
    // A removal never reaches the ensemble: nothing is drafted, so nothing is
    // sent to the delivery engine and nothing is spent. It is claimed like any
    // other item (so a crash leaves it visibly executing) and handed back
    // separately, for run-authoring to compose and prepare deterministically.
    const removals = [];
    for (const item of eligible) {
      if (!item.kind) {
        skipped.push({
          subjectId: item.subject_id, surface: item.surface,
          reason: `outcome "${item.outcome}" is not an authorable brief form; removal and no-change are not written by the ensemble`,
        });
        continue;
      }
      if (item.kind === 'needs-removing') {
        if (!item.recordedTarget?.repository || !item.recordedTarget?.path) {
          skipped.push({ subjectId: item.subject_id, surface: item.surface, reason: 'a removal needs the publication target recorded at Gate 1, and this revision carries none' });
          continue;
        }
        if (isCatalogueTarget(item.recordedTarget.path)) {
          skipped.push({ subjectId: item.subject_id, surface: item.surface, reason: 'catalogue entry removal is not implemented; deleting this target would delete the whole registry' });
          continue;
        }
        if (removals.length >= limit) { notReached += 1; continue; }
        removals.push({
          subjectId: item.subject_id,
          itemId: item.id,
          track: item.track,
          surface: item.surface,
          itemRevision: item.item_revision,
          originRunId: item.origin_run_id,
          state: item.state,
          title: item.title,
          target: { repository: item.recordedTarget.repository, path: item.recordedTarget.path },
          // The reason comes off the item's own recorded evidence. A removal
          // states why the content should stop being published; inventing that
          // sentence here would be the pipeline arguing its own case.
          rationale: item.note ?? item.title,
          evidence: (evidenceById.get(item.subject_id) ?? evidenceById.get(item.semantic_identity))?.evidence ?? [],
        });
        if (apply) {
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
        continue;
      }
      // A finding that calls a date on or before today "future" is not a
      // finding (lib/inspection-dates.mjs). The inspector no longer produces
      // them; items approved at Gate 1 before it stopped still carry them, and
      // they do not reach a drafter.
      const findings = (item.currencyFindings ?? []).filter((finding) => !isFalseFutureDateClaim(finding, today));
      const inspectionCommit = item.kind === 'needs-updating' ? inspectionCommitFor(db, item.origin_run_id) : null;
      let existing = item.kind === 'needs-updating'
        ? existingContentFor({ corpusRoot, record: item.record, inspectionCommit, findings })
        : null;
      if (item.kind === 'needs-updating' && isCatalogueTarget(item.recordedTarget?.path)) {
        existing = selectedExistingCatalogue(existing, item.recordedTarget.path, item.record.canonical_content_id);
      }
      // For a corpus-backed update the sources ARE in the file: the item
      // record's only evidence is the corpus path, which is not a citation.
      const recordCitations = evidenceCitations(item.record);
      const updateCitations = recordCitations.length ? recordCitations : existingFileCitations(existing);
      const built = briefFor({
        item,
        roles,
        targets,
        evidence: evidenceById.get(item.subject_id) ?? evidenceById.get(item.semantic_identity),
        citations: item.kind === 'needs-updating' ? updateCitations : (recordCitations.length > 0 ? recordCitations : ((evidenceById.get(item.subject_id) ?? evidenceById.get(item.semantic_identity))?.evidenceRefs?.map(r => ({ url: r.reference, publisher: 'surveyed source' })).filter((c) => isResolvableCitation(c.url)) ?? [])),
        findings,
        existing,
        today,
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

    return { briefs, removals, skipped, claimed, roles, queued: queue.length, eligible: eligible.length, notReached };
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
