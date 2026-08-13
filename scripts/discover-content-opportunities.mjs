#!/usr/bin/env node
/**
 * Discovery pass: survey a watch list, measure existing coverage, emit
 * proposals. The other half of the live opportunity registry.
 *
 * This does NOT write the registry. It emits a proposals file for
 * merge-opportunity-proposals.mjs, which enforces the rules that protect human
 * decisions. Discovery proposes; a human merges.
 *
 * Generic and parameterized. The watch list comes from the registry, the
 * corpus and the probe list come from the caller. Nothing here names a
 * publisher, a tenant, or a content layout.
 *
 * HOW A CANDIDATE IS JUSTIFIED, and why it is measured rather than asserted:
 *
 *   demand   a probe term actually appears in surveyed market text
 *   supply   the same term is counted in the local corpus, word-boundary only
 *   gap      demand present and supply at or below --gap-threshold
 *
 * A term nobody teaches is not an opportunity, and a term already covered is
 * not a gap. Both halves are recorded on the entry so a later pass can
 * re-measure instead of trusting this one.
 *
 * WORD BOUNDARIES ARE NOT OPTIONAL. A naive substring probe for "rag" matches
 * "storage" and "average" and reported 769 occurrences of a topic the corpus
 * did not contain at all. Every probe is anchored.
 *
 * Usage:
 *   node discover-content-opportunities.mjs \
 *     --registry <path> --corpus <dir> --probes <path> --out <path> \
 *     [--gap-threshold 0] [--surface learn] --offline
 *
 * --offline skips the network survey and measures the corpus only. Legacy
 * network survey mode is disabled; use --track track-1 for approved, bounded,
 * SSRF-resistant source discovery.
 *
 * Exit codes: 0 proposals emitted, 1 usage or read error, 3 survey reached no
 * source at all (measurement still written, but demand is unverified).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeControllerResult } from './lib/controller-output.mjs';
import { openStateStore } from './lib/state-store.mjs';
import { runTrack1 } from './lib/track-1-controller.mjs';

const TRACK_1_HELP = `Track 1 new-content discovery

usage: discover-content-opportunities.mjs --track track-1 --mode <full|subset|dry-run>
  --source-registry <path> [--source-ids id,id] [--state-db <path>]
  [--registry-digest sha256:...] [--content-commit SHA] [--implementation-commit SHA]
  [--trigger-type weekly|manual|replay] [--trigger-reference <text>]
  [--actor-kind scheduler|operator] [--actor-reference <text>]
  [--max-sources N] [--max-failures N] [--max-redirects N]
  [--max-bytes N] [--timeout-ms N] [--max-retries N] [--out <path>]

dry-run validates and deterministically selects sources without fetching, opening
the state store, writing an output file, or invoking any external integration.

Legacy proposal measurement remains available without --track; use --legacy-help.`;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: discover-content-opportunities.mjs --registry <path> --corpus <dir> --probes <path> --out <path>\n' +
    '       [--gap-threshold N] [--surface NAME] --offline'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { offline: false, 'gap-threshold': '0', surface: 'learn', timeout: '30' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--offline') { args.offline = true; continue; }
    if (!key.startsWith('--')) usage(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${key} needs a value`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function parseTrackArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new TypeError(`unexpected argument ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new TypeError(`${key} needs a value`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function track1Main(argv) {
  const args = parseTrackArgs(argv);
  if (args.track !== 'track-1') throw new TypeError('--track must be track-1');
  if (!['full', 'subset', 'dry-run'].includes(args.mode)) throw new TypeError('--mode must be full, subset, or dry-run');
  if (args['trigger-type'] && !['weekly', 'manual', 'replay'].includes(args['trigger-type'])) throw new TypeError('--trigger-type must be weekly, manual, or replay');
  if (args['actor-kind'] && !['scheduler', 'operator'].includes(args['actor-kind'])) throw new TypeError('--actor-kind must be scheduler or operator');
  if (!args['source-registry']) throw new TypeError('--source-registry is required');
  if (args.mode !== 'dry-run' && !args['state-db']) throw new TypeError('--state-db is required except in dry-run mode');
  if (args.mode !== 'dry-run' && !args.out) throw new TypeError('--out is required except in dry-run mode');
  const registry = JSON.parse(readFileSync(args['source-registry'], 'utf8'));
  const integer = (name, fallback) => args[name] === undefined ? fallback : Number.parseInt(args[name], 10);
  const store = args.mode === 'dry-run' ? null : openStateStore(args['state-db']);
  try {
    const result = await runTrack1({
      mode: args.mode,
      registry,
      registryDigest: args['registry-digest'],
      allowLegacyMetadata: false,
      requirePolicyReview: true,
      subsetIds: (args['source-ids'] ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      stateStore: store,
      contentCommit: args['content-commit'],
      implementationCommit: args['implementation-commit'],
      triggerType: args['trigger-type'],
      triggerReference: args['trigger-reference'],
      actorKind: args['actor-kind'],
      actorReference: args['actor-reference'],
      limits: {
        maxSources: integer('max-sources', Number.MAX_SAFE_INTEGER),
        maxFailures: integer('max-failures', Number.MAX_SAFE_INTEGER),
        maxRedirects: integer('max-redirects', 3),
        maxBytes: integer('max-bytes', 1_000_000),
        timeoutMs: integer('timeout-ms', 15_000),
        maxRetries: integer('max-retries', 1),
      },
    });
    writeControllerResult({ result, mode: args.mode, outputPath: args.out });
    if (result.status === 'failed') process.exitCode = 2;
    else if (args.mode !== 'dry-run' && result.status !== 'completed') process.exitCode = 3;
  } finally {
    store?.close();
  }
}

/**
 * Every text-bearing file under a directory, read once and concatenated.
 *
 * `exclude` is not a convenience. The registry and the probe file both NAME
 * every topic being measured, so leaving either in the corpus makes the corpus
 * appear to cover everything it is being tested for. Measured live: the whole
 * 3.2 million character corpus reported one occurrence of RAG, and that single
 * occurrence was the registry entry describing RAG as absent. Discovery found
 * zero gaps and looked entirely healthy doing it.
 */
export function readCorpus(root, { extensions = ['.json', '.md', '.mdx', '.txt', '.mmd', '.drawio', '.svg'], exclude = [] } = {}) {
  const excluded = new Set(exclude.map((name) => name.toLowerCase()));
  const parts = [];
  let skipped = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) { walk(path); continue; }
      if (!extensions.includes(extname(name))) continue;
      if (excluded.has(name.toLowerCase())) { skipped += 1; continue; }
      parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return { text: parts.join('\n'), skipped };
}

/**
 * Count a probe with word boundaries on both ends.
 *
 * A probe may carry its own regex (for multi-word or hyphen-variant terms).
 * Anything else is escaped and anchored, so a caller cannot accidentally
 * introduce a substring match by writing a bare word.
 */
export function countProbe(text, probe) {
  const pattern = probe.regex
    ? new RegExp(probe.regex, 'gi')
    : new RegExp(`\\b${probe.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return (text.match(pattern) ?? []).length;
}

/** Strip markup so a demand count measures prose, not attribute soup. */
export function toPlainText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Measure each surface separately, because they are separate products.
 *
 * A topic can be thoroughly taught in the Learn corpus and entirely absent from
 * the Field Guide, and vice versa. Measuring one merged corpus hides exactly
 * that, and the merged view reports "covered" for a surface that covers
 * nothing. Every surface a caller declares gets its own count and its own
 * candidate.
 */
export function buildProposalsPerSurface({ probes, surfaces, surveyed, gapThreshold, now }) {
  const proposals = [];
  for (const surface of surfaces) {
    const forSurface = buildProposals({
      // A probe declares which kinds it applies to. A probe about diagram
      // legibility has no meaning against a prose corpus, and a probe about
      // citation practice has none against a diagram set.
      probes: probes.filter((p) => !p.kinds || p.kinds.includes(surface.kind)),
      corpusText: surface.text,
      surveyed,
      gapThreshold,
      surface: surface.id,
      now,
    });
    // Surface-qualified ids, so a Learn gap and a Field Guide gap in the same
    // topic are two entries with two lifecycles rather than one that hides the
    // other.
    for (const proposal of forSurface) {
      proposals.push({
        ...proposal,
        id: `${proposal.id}-${surface.id}`,
        title: `${proposal.title} (${surface.label})`,
        kind: surface.kind,
        gapEvidence: `${surface.label} corpus: ${proposal.gapEvidence}`,
      });
    }
  }
  return proposals;
}

export function buildProposals({ probes, corpusText, surveyed, gapThreshold, surface, now }) {
  const proposals = [];
  for (const probe of probes) {
    const supply = countProbe(corpusText, probe);

    const suggestedBy = [];
    let demand = 0;
    for (const source of surveyed) {
      if (!source.text) continue;
      const hits = countProbe(source.text, probe);
      if (hits > 0) { demand += hits; suggestedBy.push(source.id); }
    }

    // A gap needs BOTH halves. Demand with no survey coverage is unproven, and
    // is emitted only when the survey reached nothing at all, so an offline or
    // fully-blocked run still produces measurable coverage findings.
    const demandProven = surveyed.some((s) => s.text);
    const isGap = supply <= gapThreshold && (!demandProven || demand > 0);
    if (!isGap) continue;

    proposals.push({
      id: probe.id,
      title: probe.title,
      surface: probe.surface ?? surface,
      level: probe.level,
      gapEvidence:
        `${supply} word-boundary occurrence(s) of ${probe.regex ?? probe.term} in the measured corpus` +
        (demandProven ? `; ${demand} occurrence(s) across ${suggestedBy.length} surveyed source(s)` : '; demand unverified, no source was reachable'),
      gapMeasurement: {
        probe: probe.regex ?? `\\b${probe.term}\\b`,
        occurrences: supply,
        measuredOn: now,
      },
      marketSignal: demandProven
        ? `Present in ${suggestedBy.length} of ${surveyed.length} surveyed sources.`
        : 'Not established: the survey reached no source.',
      // The same facts as marketSignal and gapEvidence, as numbers. Scoring must
      // never parse prose: a regex over a sentence that later gets reworded
      // fails silently and produces a plausible wrong number, which is worse
      // than no number. sourcesReachable is recorded because it is the ceiling
      // on sourceCount, and a score read without it looks like a verdict on the
      // topic when it is partly a verdict on who let us in that day.
      marketMeasurement: {
        occurrences: demand,
        sourceCount: suggestedBy.length,
        sourcesSurveyed: surveyed.length,
        sourcesReachable: surveyed.filter((s) => s.text).length,
        measuredOn: now,
      },
      provenance: { suggestedBy, firstSeen: now, lastConfirmed: now },
    });
  }
  return proposals;
}

async function legacyMain(argv) {
  const args = parseArgs(argv);
  for (const required of ['registry', 'corpus', 'probes', 'out']) {
    if (!args[required]) usage(`--${required} is required`);
  }
  if (!args.offline) {
    usage('legacy network survey mode is disabled; use --track track-1 or pass --offline');
  }

  let registry;
  let probes;
  try {
    registry = JSON.parse(readFileSync(args.registry, 'utf8'));
    probes = JSON.parse(readFileSync(args.probes, 'utf8'));
  } catch (error) {
    usage(`could not read input: ${error.message}`);
  }
  if (!Array.isArray(probes?.probes)) usage('probes file needs a "probes" array');

  // The registry and the probe file both name every topic under measurement.
  // Either one left in the corpus makes the corpus look like it already covers
  // whatever is being tested for.
  const selfNames = [basename(args.registry), basename(args.probes)];
  const extraExcludes = (args.exclude ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const { text: corpusText, skipped } = readCorpus(args.corpus, {
    exclude: [...selfNames, ...extraExcludes],
  });
  console.log(
    `corpus: ${corpusText.length} characters from ${args.corpus} ` +
    `(${skipped} file(s) excluded: ${[...selfNames, ...extraExcludes].join(', ')})`
  );

  const surveyed = [];
  console.log('offline: skipping the survey, measuring corpus coverage only');

  // --surfaces id:subdir[:Label],... measures each publishing surface against
  // its own subtree. Without it everything is measured as one corpus and every
  // proposal is attributed to a single surface, which was the original defect:
  // Field Guide gaps were invisible because Learn coverage masked them.
  // id|path|Label|kind, pipe separated so a Windows drive letter in the path
  // does not collide with the field separator. The path may be relative to
  // --corpus or absolute: visual guides commonly live in a different repository
  // from the written content, and a surface that cannot point outside the
  // corpus root simply cannot be measured.
  const surfaces = [];
  if (args.surfaces) {
    for (const spec of args.surfaces.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [id, dir, label, kind] = spec.split('|');
      if (!id || !dir) usage(`--surfaces entry "${spec}" must be id|path[|Label][|kind]`);
      const root = isAbsolute(dir) ? dir : join(args.corpus, dir);
      if (!existsSync(root)) {
        console.log(`  surface ${id}: SKIPPED, ${root} does not exist`);
        continue;
      }
      const { text } = readCorpus(root, { exclude: [...selfNames, ...extraExcludes] });
      surfaces.push({ id, label: label || id, kind: kind || id, text });
      console.log(`  surface ${id} (kind ${kind || id}): ${text.length} characters from ${root}`);
    }
  }

  // Number.parseInt(undefined, 10) is NaN, and `supply <= NaN` is false for
  // every value, so omitting --gap-threshold used to make EVERY probe fail the
  // gap test. The run then wrote an empty proposal set, printed "proposed 0
  // opportunities" and exited 0, which is indistinguishable from a corpus with
  // no gaps in it. Default explicitly instead.
  const gapThreshold = Number.isInteger(Number.parseInt(args['gap-threshold'], 10))
    ? Number.parseInt(args['gap-threshold'], 10)
    : 0;
  console.log(`  gap threshold: ${gapThreshold} occurrence(s)`);

  const now = new Date().toISOString();
  const proposals = surfaces.length
    ? buildProposalsPerSurface({ probes: probes.probes, surfaces, surveyed, gapThreshold, now })
    : buildProposals({
      probes: probes.probes,
      corpusText,
      surveyed,
      gapThreshold,
      surface: args.surface,
      now,
    });

  writeFileSync(args.out, `${JSON.stringify({ generatedOn: now, opportunities: proposals }, null, 2)}\n`, 'utf8');
  console.log(`\nproposed ${proposals.length} opportunit${proposals.length === 1 ? 'y' : 'ies'} -> ${args.out}`);
  for (const proposal of proposals) console.log(`  ${proposal.id}: ${proposal.gapEvidence}`);
  console.log('\nNothing was written to the registry. Merge with merge-opportunity-proposals.mjs.');

}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) console.log(TRACK_1_HELP);
  else if (argv.includes('--legacy-help')) usage();
  else if (argv.includes('--track')) await track1Main(argv);
  else await legacyMain(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
