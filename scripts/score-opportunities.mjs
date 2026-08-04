#!/usr/bin/env node
/**
 * Score and rank the candidates in an opportunity registry.
 *
 * The score exists to order the queue a human reads. It does NOT decide
 * anything, it does not filter, and it never changes a registry. Every
 * candidate is scored and every candidate is printed, including the ones that
 * score near zero.
 *
 * WHY THERE IS NO CUTOFF
 *
 * A cutoff would be a permanent policy built from a temporary measurement.
 * Breadth is capped by which sources allowed automated access on the day of the
 * run, and depth is read from one catalogue page per source, so both inputs
 * understate a real topic and neither can tell "rarely taught" apart from "we
 * could not see it". Excluding a topic on that basis bakes today's blind spots
 * into a decision nobody will revisit. Ranking is reversible; exclusion is not.
 *
 * THE INPUTS, and what each is actually evidence of:
 *
 *   Breadth   how many surveyed sources teach it. Independent agreement. One
 *             source is an anecdote; several teaching the same thing is a
 *             pattern. Weighted highest, and read from the PEAK ever recorded
 *             rather than the latest run, so a source outage cannot quietly
 *             downgrade a real opportunity.
 *   Depth     total occurrences across those sources. Separates a passing
 *             mention from a taught subject. Weighted low: one source repeating
 *             a word is not agreement.
 *   Gap       occurrences in our own corpus. The only input measured on data we
 *             control, and therefore the only one that is not directional.
 *   Spread    how many of our surfaces lack it. Absent from every surface is a
 *             bigger hole than absent from one.
 *   Strategic an explicit owner-set multiplier, default 1. The only subjective
 *             input, and it is subjective on purpose and on the record.
 *
 * Usage:
 *   node score-opportunities.mjs --registry <path> [--weights <path>]
 *                                [--json <path>] [--all]
 *
 * --all also scores non-candidates (delivered, retired, rejected), which is how
 * you check that a rejection still looks right rather than taking it on trust.
 *
 * Exit codes: 0 always, unless arguments are unusable. Scoring cannot fail in a
 * way that should stop a pipeline; a bad score is a reading-order problem.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Defaults, all overridable with --weights. They are declared here rather than
 * buried in the formula so a deployer can disagree with them in one place.
 *
 * points.* sum to 100 before the strategic multiplier.
 * breadthFull/depthFull are the saturation points: the reading at which an
 * input has said everything it can. Beyond them more evidence adds nothing,
 * because the difference between eight sources and eighty is not eight times
 * the confidence.
 */
export const DEFAULT_WEIGHTS = {
  points: { breadth: 35, depth: 15, gap: 30, spread: 20 },
  breadthFull: 8,
  depthFull: 20,
  // Supply tiers. First match wins, so order matters.
  gapTiers: [
    { maxOccurrences: 0, fraction: 1.0, label: 'absent' },
    { maxOccurrences: 5, fraction: 0.67, label: 'mentioned, not taught' },
    { maxOccurrences: 20, fraction: 0.33, label: 'thin' },
    { maxOccurrences: Infinity, fraction: 0, label: 'covered' },
  ],
  // Reading tiers. These order attention. They never gate eligibility.
  attentionTiers: [
    { minSources: 3, label: 'strong' },
    { minSources: 2, label: 'worth a look' },
    { minSources: 1, label: 'idea' },
    { minSources: 0, label: 'unmeasured' },
  ],
};

const ACTIVE_STATUSES = new Set(['candidate', 'selected', 'in-progress']);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: score-opportunities.mjs --registry <path> [--weights <path>] [--json <path>] [--all]'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--all') { args.all = true; continue; }
    if (!key.startsWith('--')) usage(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${key} needs a value`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

/** Saturating 0..1. Anything past `full` has said all it can say. */
const saturate = (value, full) => (full <= 0 ? 0 : Math.min(1, Math.max(0, value / full)));

/**
 * The topic behind a surface-qualified entry. Discovery mints ids as
 * `<topic>-<surface>` so one topic missing from three surfaces is three
 * entries with three lifecycles. Spread needs them back together.
 */
export function topicKeyOf(entry) {
  for (const suffix of [entry.kind, entry.surface]) {
    if (suffix && entry.id.endsWith(`-${suffix}`)) {
      return entry.id.slice(0, -(suffix.length + 1));
    }
  }
  return entry.id;
}

/**
 * Demand, as numbers rather than prose.
 *
 * Prefers the structured marketMeasurement discovery now emits. Older entries
 * predate it and carry the same facts only inside an English sentence, so there
 * is a documented fallback that parses it. The fallback reports itself: a
 * number recovered from prose is a number one rewording away from being wrong,
 * and a score built on one silently must never look like a score built on data.
 */
export function readDemand(entry) {
  const measured = entry.marketMeasurement;
  if (measured && typeof measured.occurrences === 'number') {
    return {
      occurrences: measured.occurrences,
      sourceCount: measured.sourceCount ?? (entry.provenance?.suggestedBy ?? []).length,
      sourcesReachable: measured.sourcesReachable ?? null,
      derivedFrom: 'measurement',
    };
  }

  const match = /(\d+)\s+occurrence\(s\)\s+across\s+(\d+)\s+surveyed source/.exec(
    entry.gapEvidence ?? ''
  );
  if (match) {
    return {
      occurrences: Number.parseInt(match[1], 10),
      sourceCount: Number.parseInt(match[2], 10),
      sourcesReachable: null,
      derivedFrom: 'legacy prose',
    };
  }

  return {
    occurrences: 0,
    sourceCount: (entry.provenance?.suggestedBy ?? []).length,
    sourcesReachable: null,
    derivedFrom: 'provenance only',
  };
}

function gapTierFor(occurrences, weights) {
  return weights.gapTiers.find((t) => occurrences <= t.maxOccurrences)
    ?? weights.gapTiers[weights.gapTiers.length - 1];
}

function attentionTierFor(sourceCount, weights) {
  return weights.attentionTiers.find((t) => sourceCount >= t.minSources)
    ?? weights.attentionTiers[weights.attentionTiers.length - 1];
}

export function scoreRegistry(registry, { weights = DEFAULT_WEIGHTS, includeAll = false } = {}) {
  const all = registry.opportunities ?? [];
  const scoped = includeAll ? all : all.filter((e) => ACTIVE_STATUSES.has(e.status));

  // Surfaces the registry actually knows about, not a hardcoded three. A
  // deployer with two surfaces must not have every topic capped at two thirds.
  const surfacesTotal = new Set(all.map((e) => e.kind ?? e.surface).filter(Boolean)).size || 1;

  // Spread is a property of the topic, so it is counted across the scored set:
  // a topic missing from three surfaces has three open entries here.
  const spreadByTopic = new Map();
  for (const entry of scoped) {
    const key = topicKeyOf(entry);
    if (!spreadByTopic.has(key)) spreadByTopic.set(key, new Set());
    spreadByTopic.get(key).add(entry.kind ?? entry.surface ?? entry.id);
  }

  const rows = scoped.map((entry) => {
    const demand = readDemand(entry);

    // Peak, never latest. Rule 5 of the merge: a topic is not judged on its
    // worst day, and a run that read fewer sources is a fact about the run.
    const sourceCount = Math.max(
      demand.sourceCount,
      entry.provenance?.peakSourceCount ?? 0
    );

    const supply = entry.gapMeasurement?.occurrences ?? 0;
    const gapTier = gapTierFor(supply, weights);
    const surfacesMissing = spreadByTopic.get(topicKeyOf(entry)).size;
    const strategic = entry.strategicWeight ?? 1;

    const parts = {
      breadth: weights.points.breadth * saturate(sourceCount, weights.breadthFull),
      depth: weights.points.depth * saturate(demand.occurrences, weights.depthFull),
      gap: weights.points.gap * gapTier.fraction,
      spread: weights.points.spread * (surfacesMissing / surfacesTotal),
    };
    const subtotal = parts.breadth + parts.depth + parts.gap + parts.spread;

    return {
      id: entry.id,
      title: entry.title,
      topic: topicKeyOf(entry),
      kind: entry.kind ?? entry.surface ?? null,
      status: entry.status,
      score: Math.round(subtotal * strategic * 10) / 10,
      parts: Object.fromEntries(
        Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])
      ),
      sourceCount,
      occurrences: demand.occurrences,
      supply,
      supplyLabel: gapTier.label,
      surfacesMissing,
      surfacesTotal,
      strategicWeight: strategic,
      attention: attentionTierFor(sourceCount, weights).label,
      demandDerivedFrom: demand.derivedFrom,
      sourcesReachable: demand.sourcesReachable,
    };
  });

  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Topic view. One decision usually covers every surface of a topic, so this
  // is the list an owner actually triages; the per-entry rows are what the
  // decision expands into.
  const topics = [...spreadByTopic.keys()].map((key) => {
    const members = rows.filter((r) => r.topic === key);
    return {
      topic: key,
      title: (members[0]?.title ?? key).replace(/\s*\([^)]*\)\s*$/, ''),
      score: members.length ? Math.max(...members.map((r) => r.score)) : 0,
      surfaces: members.map((r) => r.kind).filter(Boolean),
      sourceCount: members.length ? Math.max(...members.map((r) => r.sourceCount)) : 0,
      occurrences: members.length ? Math.max(...members.map((r) => r.occurrences)) : 0,
      attention: members[0]?.attention ?? 'unmeasured',
      entryCount: members.length,
    };
  }).sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));

  return { rows, topics, surfacesTotal, scoredCount: rows.length, totalCount: all.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.registry) usage('--registry is required');

  let registry;
  try {
    registry = JSON.parse(readFileSync(args.registry, 'utf8'));
  } catch (error) {
    usage(`could not read registry at ${args.registry}: ${error.message}`);
  }

  let weights = DEFAULT_WEIGHTS;
  if (args.weights) {
    try {
      weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(readFileSync(args.weights, 'utf8')) };
    } catch (error) {
      usage(`could not read weights at ${args.weights}: ${error.message}`);
    }
  }

  const result = scoreRegistry(registry, { weights, includeAll: args.all });

  const pad = (value, width) => String(value).padEnd(width);

  console.log(`Registry ${args.registry}`);
  console.log(
    `  version ${registry.registryVersion ?? '?'}, ` +
    `${result.scoredCount} scored of ${result.totalCount} entries, ` +
    `${result.surfacesTotal} surfaces`
  );
  console.log('');

  console.log('BY TOPIC, which is how a decision is usually made:');
  console.log(`  ${pad('#', 3)}${pad('score', 7)}${pad('attention', 15)}${pad('src', 5)}${pad('occ', 5)}${pad('surfaces', 10)}topic`);
  result.topics.forEach((t, i) => {
    console.log(
      `  ${pad(i + 1, 3)}${pad(t.score.toFixed(1), 7)}${pad(t.attention, 15)}` +
      `${pad(t.sourceCount, 5)}${pad(t.occurrences, 5)}${pad(t.entryCount, 10)}${t.title}`
    );
  });
  console.log('');

  console.log('BY ENTRY, which is what a decision expands into:');
  console.log(`  ${pad('#', 3)}${pad('score', 7)}${pad('br', 6)}${pad('dp', 6)}${pad('gap', 6)}${pad('spr', 6)}${pad('supply', 22)}id`);
  result.rows.forEach((r, i) => {
    console.log(
      `  ${pad(i + 1, 3)}${pad(r.score.toFixed(1), 7)}` +
      `${pad(r.parts.breadth.toFixed(1), 6)}${pad(r.parts.depth.toFixed(1), 6)}` +
      `${pad(r.parts.gap.toFixed(1), 6)}${pad(r.parts.spread.toFixed(1), 6)}` +
      `${pad(`${r.supply} (${r.supplyLabel})`, 22)}${r.id}`
    );
  });
  console.log('');

  const legacy = result.rows.filter((r) => r.demandDerivedFrom !== 'measurement');
  if (legacy.length) {
    console.log(
      `NOTE: ${legacy.length} entr${legacy.length === 1 ? 'y' : 'ies'} predate structured ` +
      'demand measurement; their demand was recovered from prose and will be replaced ' +
      'by measured values on the next discovery run.'
    );
  }
  console.log('NOTE: nothing was excluded. The score orders reading, it does not gate.');
  console.log(
    'NOTE: breadth is a floor. A source that refuses automated access contributes ' +
    'nothing, so a low score can mean "rarely taught" or "we could not see it".'
  );

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`\nWritten ${args.json}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
