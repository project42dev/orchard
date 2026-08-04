#!/usr/bin/env node
/**
 * Assertions on the scorer. The properties worth protecting are not the
 * arithmetic, they are the promises: nothing is filtered, a topic is judged on
 * its best reading rather than its latest, and a score never touches state.
 *
 * Run: node scripts/test-score-opportunities.mjs
 */

import { scoreRegistry, topicKeyOf, readDemand, DEFAULT_WEIGHTS } from './score-opportunities.mjs';

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}

const entry = (over = {}) => ({
  id: 'topic-learn',
  title: 'Topic (Learn)',
  kind: 'learn',
  surface: 'learn',
  status: 'candidate',
  gapMeasurement: { occurrences: 0 },
  marketMeasurement: { occurrences: 10, sourceCount: 4, sourcesReachable: 22 },
  provenance: { suggestedBy: ['a', 'b', 'c', 'd'] },
  ...over,
});

// --- topic key ---------------------------------------------------------------
check('strips the kind suffix', topicKeyOf(entry()) === 'topic');
check(
  'strips the surface suffix when kind is absent',
  topicKeyOf({ id: 'topic-field-guide', surface: 'field-guide' }) === 'topic'
);
check(
  'leaves an unqualified id alone',
  topicKeyOf({ id: 'standalone', kind: 'learn' }) === 'standalone'
);
check(
  'does not strip a kind that only appears mid-id',
  topicKeyOf({ id: 'learn-to-fly', kind: 'learn' }) === 'learn-to-fly'
);

// --- demand reading ----------------------------------------------------------
check('prefers structured measurement', readDemand(entry()).derivedFrom === 'measurement');
check('reads structured occurrences', readDemand(entry()).occurrences === 10);

const legacy = readDemand({
  gapEvidence: 'Learn corpus: 0 word-boundary occurrence(s) of \\bX\\b in the measured corpus; 17 occurrence(s) across 6 surveyed source(s)',
  provenance: { suggestedBy: [] },
});
check('falls back to prose', legacy.derivedFrom === 'legacy prose');
check('recovers occurrences from prose', legacy.occurrences === 17);
check('recovers source count from prose', legacy.sourceCount === 6);

const noEvidence = readDemand({ provenance: { suggestedBy: ['a', 'b'] } });
check('falls back to provenance', noEvidence.derivedFrom === 'provenance only');
check('provenance fallback counts sources', noEvidence.sourceCount === 2);

// --- the promises ------------------------------------------------------------
const registry = {
  opportunities: [
    entry({ id: 'wide-learn', marketMeasurement: { occurrences: 17, sourceCount: 6 }, provenance: { suggestedBy: [] } }),
    entry({ id: 'wide-field-guide', kind: 'field-guide', surface: 'field-guide', marketMeasurement: { occurrences: 17, sourceCount: 6 }, provenance: { suggestedBy: [] } }),
    entry({ id: 'narrow-learn', marketMeasurement: { occurrences: 2, sourceCount: 1 }, provenance: { suggestedBy: [] } }),
    entry({ id: 'rejected-learn', status: 'rejected', marketMeasurement: { occurrences: 99, sourceCount: 8 }, provenance: { suggestedBy: [] } }),
    entry({ id: 'retired-learn', status: 'retired', marketMeasurement: { occurrences: 99, sourceCount: 8 }, provenance: { suggestedBy: [] } }),
  ],
};

const before = JSON.stringify(registry);
const result = scoreRegistry(registry);
check('the registry is not mutated', JSON.stringify(registry) === before);

check('every active entry is scored', result.rows.length === 3);
check('nothing active is dropped', result.rows.every((r) => r.score >= 0));
check(
  'a one-source candidate is still on the list',
  result.rows.some((r) => r.id === 'narrow-learn')
);
check(
  'rejected and retired are excluded by default',
  !result.rows.some((r) => r.status === 'rejected' || r.status === 'retired')
);
check(
  '--all includes them',
  scoreRegistry(registry, { includeAll: true }).rows.length === 5
);

check('ranked descending', result.rows[0].score >= result.rows[result.rows.length - 1].score);
check('broad evidence outranks narrow', result.rows[0].id.startsWith('wide'));

// --- peak, never latest ------------------------------------------------------
const dipped = scoreRegistry({
  opportunities: [entry({
    id: 'dipped-learn',
    marketMeasurement: { occurrences: 1, sourceCount: 1 },
    provenance: { suggestedBy: ['a'], peakSourceCount: 6 },
  })],
});
check('a bad run cannot lower breadth below the recorded peak', dipped.rows[0].sourceCount === 6);
check(
  'the peak drives the breadth points',
  dipped.rows[0].parts.breadth === Math.round(DEFAULT_WEIGHTS.points.breadth * (6 / 8) * 10) / 10
);

// --- spread ------------------------------------------------------------------
const wide = result.rows.find((r) => r.id === 'wide-learn');
const narrow = result.rows.find((r) => r.id === 'narrow-learn');
check('spread counts every surface missing the topic', wide.surfacesMissing === 2);
check('a single-surface gap scores less spread', narrow.parts.spread < wide.parts.spread);
check('surfaces total is derived from the registry', result.surfacesTotal === 2);

// --- supply tiers ------------------------------------------------------------
const supplyTiers = scoreRegistry({
  opportunities: [
    entry({ id: 'absent-learn', gapMeasurement: { occurrences: 0 } }),
    entry({ id: 'mention-learn', gapMeasurement: { occurrences: 3 } }),
    entry({ id: 'thin-learn', gapMeasurement: { occurrences: 12 } }),
    entry({ id: 'covered-learn', gapMeasurement: { occurrences: 400 } }),
  ],
});
const byId = Object.fromEntries(supplyTiers.rows.map((r) => [r.id, r]));
check('absent scores the full gap', byId['absent-learn'].parts.gap === DEFAULT_WEIGHTS.points.gap);
check('a mention scores less than absent', byId['mention-learn'].parts.gap < byId['absent-learn'].parts.gap);
check('thin scores less than a mention', byId['thin-learn'].parts.gap < byId['mention-learn'].parts.gap);
check('covered scores no gap', byId['covered-learn'].parts.gap === 0);
check('a covered topic is still listed', byId['covered-learn'] !== undefined);

// --- strategic weight --------------------------------------------------------
const weighted = scoreRegistry({
  opportunities: [
    entry({ id: 'plain-learn' }),
    entry({ id: 'weighted-learn', strategicWeight: 2 }),
  ],
});
const plainScore = weighted.rows.find((r) => r.id === 'plain-learn').score;
const weightedScore = weighted.rows.find((r) => r.id === 'weighted-learn').score;
check('the strategic multiplier applies', Math.abs(weightedScore - plainScore * 2) < 0.2);
check('default strategic weight is 1', weighted.rows.find((r) => r.id === 'plain-learn').strategicWeight === 1);

// --- attention tiers never gate ---------------------------------------------
check('three sources reads strong', result.rows.find((r) => r.id === 'wide-learn').attention === 'strong');
check('one source reads idea', narrow.attention === 'idea');
check('an idea still has a score and a rank', typeof narrow.score === 'number');

// --- topic rollup ------------------------------------------------------------
check('topics roll up entries', result.topics.length === 2);
check('the topic title drops the surface suffix', !result.topics[0].title.includes('('));
check('topic order matches entry order', result.topics[0].score >= result.topics[1].score);

// --- empty registry ----------------------------------------------------------
const empty = scoreRegistry({ opportunities: [] });
check('an empty registry scores cleanly', empty.rows.length === 0 && empty.surfacesTotal === 1);

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on opportunity scoring.`);
