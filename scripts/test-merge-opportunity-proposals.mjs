#!/usr/bin/env node
/**
 * Tests for the live-registry merge rules.
 *
 * These assert the properties that make the list safe to run repeatedly. The
 * one that matters most is rejection persistence: a discovery pass that
 * re-proposes declined work on every run trains its owner to ignore it.
 */

import { mergeProposals } from './merge-opportunity-proposals.mjs';

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}

const NOW = '2026-08-03T00:00:00.000Z';

function registryFixture() {
  return {
    schemaVersion: '1.0',
    registryVersion: '0.1.0',
    lastReviewed: '2026-08-01',
    watchList: [],
    opportunities: [
      {
        id: 'already-rejected',
        title: 'Something the owner declined',
        surface: 'learn',
        status: 'rejected',
        statusSetBy: 'human',
        rejectionReason: 'Out of scope for this product.',
      },
      {
        id: 'in-flight',
        title: 'Work a human already selected',
        surface: 'learn',
        status: 'in-progress',
        statusSetBy: 'human',
        gapEvidence: 'zero occurrences',
        gapMeasurement: { probe: '\\bthing\\b', occurrences: 0, measuredOn: '2026-07-01T00:00:00.000Z' },
        provenance: { firstSeen: '2026-07-01T00:00:00.000Z', lastConfirmed: '2026-07-01T00:00:00.000Z', confirmCount: 3 },
      },
    ],
  };
}

// 1. A rejected entry is never re-added, and the reason is surfaced.
{
  const registry = registryFixture();
  const report = mergeProposals(registry, {
    opportunities: [{ id: 'already-rejected', title: 'Something the owner declined', surface: 'learn' }],
  }, NOW);

  check('rejected entry is not re-added', registry.opportunities.filter((o) => o.id === 'already-rejected').length === 1);
  check('rejected entry keeps its status', registry.opportunities.find((o) => o.id === 'already-rejected').status === 'rejected');
  check('rejection is reported, not silent', report.blockedByRejection.length === 1);
  check('rejection reason is carried to the report', report.blockedByRejection[0].rejectionReason.includes('Out of scope'));
  check('rejected entry is not counted as added', report.added.length === 0);
}

// 2. Discovery cannot move a status a human set.
{
  const registry = registryFixture();
  mergeProposals(registry, {
    opportunities: [{ id: 'in-flight', title: 'Work a human already selected', surface: 'learn', status: 'candidate' }],
  }, NOW);

  const entry = registry.opportunities.find((o) => o.id === 'in-flight');
  check('human status survives a discovery pass', entry.status === 'in-progress');
  check('statusSetBy is not overwritten', entry.statusSetBy === 'human');
}

// 3. A new opportunity is created at candidate, never higher.
{
  const registry = registryFixture();
  mergeProposals(registry, {
    opportunities: [{ id: 'brand-new', title: 'A newly surfaced gap', surface: 'learn', status: 'delivered' }],
  }, NOW);

  const entry = registry.opportunities.find((o) => o.id === 'brand-new');
  check('new entry exists', Boolean(entry));
  check('new entry is forced to candidate', entry.status === 'candidate');
  check('new entry is attributed to discovery', entry.statusSetBy === 'discovery');
  check('new entry records firstSeen', entry.provenance.firstSeen === NOW);
}

// 4. A closed gap is flagged for review, never silently rewritten.
{
  const registry = registryFixture();
  const report = mergeProposals(registry, {
    opportunities: [{
      id: 'in-flight', title: 'Work a human already selected', surface: 'learn',
      gapMeasurement: { probe: '\\bthing\\b', occurrences: 42, measuredOn: NOW },
    }],
  }, NOW);

  check('closed gap is flagged', report.gapClosed.length === 1);
  check('closed gap reports both numbers', report.gapClosed[0].previous === 0 && report.gapClosed[0].current === 42);
  check('entry is not auto-retired', registry.opportunities.find((o) => o.id === 'in-flight').status === 'in-progress');
}

// 5. Ageing: confirmCount advances and nothing is deleted.
{
  const registry = registryFixture();
  const before = registry.opportunities.length;
  mergeProposals(registry, {
    opportunities: [{ id: 'in-flight', title: 'Work a human already selected', surface: 'learn' }],
  }, NOW);

  const entry = registry.opportunities.find((o) => o.id === 'in-flight');
  check('nothing is deleted', registry.opportunities.length === before);
  check('lastConfirmed advances', entry.provenance.lastConfirmed === NOW);
  check('confirmCount increments', entry.provenance.confirmCount === 4);
  check('firstSeen is preserved', entry.provenance.firstSeen === '2026-07-01T00:00:00.000Z');
}

// 6. An entry with no id is dropped rather than corrupting the registry.
{
  const registry = registryFixture();
  const before = registry.opportunities.length;
  const report = mergeProposals(registry, { opportunities: [{ title: 'no id here' }] }, NOW);
  check('invalid proposal is dropped', registry.opportunities.length === before);
  check('invalid proposal is reported', report.invalid.length === 1);
}

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`PASS. ${passed} assertions on the live-registry merge rules.`);
