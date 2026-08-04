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
 *     [--gap-threshold 0] [--surface learn] [--timeout 30] [--offline]
 *
 * --offline skips the network survey and measures the corpus only, which is
 * how the coverage half is tested without depending on anyone's uptime.
 *
 * Exit codes: 0 proposals emitted, 1 usage or read error, 3 survey reached no
 * source at all (measurement still written, but demand is unverified).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: discover-content-opportunities.mjs --registry <path> --corpus <dir> --probes <path> --out <path>\n' +
    '       [--gap-threshold N] [--surface NAME] [--timeout SECONDS] [--offline]'
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

async function survey(watchList, timeoutSeconds) {
  const results = [];
  for (const source of watchList) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const response = await fetch(source.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // Identify honestly. A survey that disguises itself as a browser is
          // not a survey a publisher agreed to.
          'User-Agent': 'HomesteadFoundry-ContentDiscovery/1.0 (+read-only topic survey)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        },
      });
      const body = response.ok ? toPlainText(await response.text()) : '';
      results.push({ id: source.id, status: response.status, text: body, url: source.url });
    } catch (error) {
      results.push({ id: source.id, status: 0, text: '', url: source.url, error: error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['registry', 'corpus', 'probes', 'out']) {
    if (!args[required]) usage(`--${required} is required`);
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

  const watchList = registry.watchList ?? [];
  let surveyed = [];
  if (args.offline) {
    console.log('offline: skipping the survey, measuring corpus coverage only');
  } else {
    surveyed = await survey(watchList, Number.parseInt(args.timeout, 10));
    const reached = surveyed.filter((s) => s.text).length;
    console.log(`survey: ${reached} of ${surveyed.length} sources returned content`);
    for (const source of surveyed.filter((s) => !s.text)) {
      console.log(`  unreachable: ${source.id} -> HTTP ${source.status}${source.error ? ` (${source.error})` : ''}`);
    }
  }

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

  if (!args.offline && !surveyed.some((s) => s.text)) process.exit(3);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
