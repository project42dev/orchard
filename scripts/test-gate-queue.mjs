#!/usr/bin/env node
// Turning a discovery candidate into work a gate holds is the step Orchard was
// missing, so these tests are about the properties that make it safe to run
// every month, not about whether one insert happens.
//
// Every fixture uses the real state store on the real migrated schema. A test
// that builds its own convenient tables is how the previous version of this
// step passed while being unable to execute in production.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import {
  TARGET_REPOSITORY, estimatedItemCostUsd, heldAtGate, heldSetDigest,
  persistDiscoveryItems, proposalFor, scoreCandidate, slugify, surfaceForProbe, targetForCandidate,
} from './lib/gate-queue.mjs';

const DIGEST = `sha256:${'0'.repeat(64)}`;
const SHA = '0'.repeat(40);
const temporaries = [];

function runManifest(runId) {
  const record = {
    schema_version: '1.0.0', run_id: runId, track: 'track-1',
    trigger: { type: 'manual', reference: 'test' }, status: 'running',
    configuration_digest: DIGEST, source_registry_digest: DIGEST,
    content_commit: SHA, implementation_commit: SHA, model_role_map_digest: DIGEST,
    started_at: '2026-08-15T00:00:00.000Z', completed_at: null,
    actor: { kind: 'operator', reference: 'test' },
    scope: { mode: 'full', expected_count: 1 },
    coverage: {
      approved_enabled_source_count: 1, attempted: 1, successfully_evaluated: 1,
      redirected: 0, rate_limited: 0, failed: 0, skipped: 0, blocked: 0,
      unevaluated: 0, stale: 0, exception_count: 0,
    },
    item_count: 0,
  };
  record.manifest_digest = sha256Digest(record);
  return record;
}

function candidate(term, overrides = {}) {
  const subject = `Teaching ${term}`;
  return {
    subject, surface: 'learning', outcome: `teach ${subject}`, scope: 'content',
    title: `How to teach ${term}`, term, level: 'intermediate',
    demandOccurrences: 12, demandSourceCount: 3,
    evidence: ['a:4', 'b:4', 'c:4'],
    evidenceRefs: [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
    observedAt: '2026-08-15T00:00:00.000Z', sourceLabels: ['Example Publisher'],
    semanticIdentity: `sid:v1:${sha256Digest(term).slice(7)}`,
    ...overrides,
  };
}

async function estate() {
  const directory = mkdtempSync(join(tmpdir(), 'orchard-queue-'));
  temporaries.push(directory);
  const store = openStateStore(join(directory, 'state.db'));
  const runId = generateUuidV7();
  await store.recordRun(runManifest(runId));
  return { store, runId };
}

test('a candidate becomes an item held at Gate 1, and not one step further', async () => {
  const { store, runId } = await estate();
  const result = await persistDiscoveryItems({ store, runId, candidates: [candidate('vector-search')] });
  assert.equal(result.persisted, 1);

  const row = store.db.prepare('SELECT * FROM workflow_item').get();
  assert.equal(row.current_state, 'gate1-pending', 'nothing may enter the lifecycle already approved');
  assert.equal(row.track, 'track-1');
  assert.equal(Number(row.current_revision), 1);

  const transitions = store.listTransitions(row.item_id);
  assert.deepEqual(transitions.map((t) => [t.from_state, t.to_state]), [
    ['observed', 'proposed'], ['proposed', 'gate1-pending'],
  ], 'the lifecycle must be walked, not jumped');
});

test('re-running discovery does not propose the same subject twice', async () => {
  const { store, runId } = await estate();
  const candidates = [candidate('prompt-injection')];
  const first = await persistDiscoveryItems({ store, runId, candidates });
  const second = await persistDiscoveryItems({ store, runId, candidates });
  assert.equal(first.persisted, 1);
  assert.equal(second.persisted, 0);
  assert.equal(second.skipped, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 1);
});

test('a denied subject is never resurrected by a later survey', async () => {
  const { store, runId } = await estate();
  const candidates = [candidate('deprecated-topic')];
  await persistDiscoveryItems({ store, runId, candidates });
  const row = store.db.prepare('SELECT item_id FROM workflow_item').get();
  // Stand in for the recorded human decision: the item is no longer pending.
  store.db.prepare("UPDATE workflow_item SET current_state = 'denied' WHERE item_id = ?").run(row.item_id);

  const events = [];
  const again = await persistDiscoveryItems({ store, runId, candidates, log: (_l, event, detail) => events.push([event, detail]) });
  assert.equal(again.persisted, 0);
  assert.deepEqual(again.existing, [{ semanticIdentity: candidates[0].semanticIdentity, state: 'denied' }]);
  assert.equal(events[0][0], 'gate1.item.known');
  assert.equal(events[0][1].effect, 'not re-proposed', 'a decision a machine can undo is not a decision');
  assert.equal(heldAtGate(store.db, 'gate-1').length, 0);
});

test('one bad candidate does not cost the run its other candidates', async () => {
  const { store, runId } = await estate();
  const events = [];
  const result = await persistDiscoveryItems({
    store, runId,
    candidates: [candidate('good-one'), candidate('bad-one', { surface: 'not-a-surface' }), candidate('good-two')],
    log: (_l, event) => events.push(event),
  });
  assert.equal(result.persisted, 2);
  assert.equal(result.failed, 1);
  assert.ok(events.includes('gate1.item.failed'), 'a candidate that was dropped must say so');
  assert.equal(heldAtGate(store.db, 'gate-1').length, 2);
});

test('what the gate reads back is what the gate issue needs', async () => {
  const { store, runId } = await estate();
  await persistDiscoveryItems({ store, runId, candidates: [candidate('agent-evaluation')] });
  const [item] = heldAtGate(store.db, 'gate-1', 'track-1');
  assert.equal(item.title, 'How to teach agent-evaluation');
  assert.equal(item.category, 'new-module');
  assert.equal(item.decision_state, 'pending');
  assert.equal(item.target.repository, TARGET_REPOSITORY);
  assert.match(item.proposal_digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(item.rationale.includes('3 of the surveyed approved sources'));
  assert.ok(item.estimated_cost.amount > 0, 'the gate must say what approving will spend');
});

test('the held set digest ignores the run and tracks the items', async () => {
  const { store, runId } = await estate();
  await persistDiscoveryItems({ store, runId, candidates: [candidate('a-topic')] });
  const before = heldSetDigest('gate-1', heldAtGate(store.db, 'gate-1'));
  await persistDiscoveryItems({ store, runId, candidates: [candidate('b-topic')] });
  const after = heldSetDigest('gate-1', heldAtGate(store.db, 'gate-1'));
  assert.notEqual(before, after, 'adding an item must change what the owner is being asked to decide');
  assert.equal(before, heldSetDigest('gate-1', [heldAtGate(store.db, 'gate-1').find((i) => i.title.includes('a-topic'))]));
});

test('probe kinds map onto the three contract surfaces and nothing else', () => {
  assert.equal(surfaceForProbe({}), 'learning');
  assert.equal(surfaceForProbe({ kinds: ['learn'] }), 'learning');
  assert.equal(surfaceForProbe({ kinds: ['visual-guide'] }), 'guide-diagram');
  assert.equal(surfaceForProbe({ kinds: ['field-guide'] }), 'guide');
  assert.equal(surfaceForProbe({ kinds: ['nonsense'] }), 'learning');
});

test('a target path is always one the platform repository can accept', () => {
  assert.equal(slugify('RAG & Vector Search!'), 'rag-vector-search');
  assert.throws(() => slugify('!!!'));
  const target = targetForCandidate(candidate('RAG & Vectors'));
  assert.equal(target.repository, TARGET_REPOSITORY);
  assert.match(target.path, /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/);
  assert.equal(targetForCandidate(candidate('x', { surface: 'guide-diagram' })).path, 'content/diagrams/x.mmd');
});

test('the score orders reading and cannot gate, and breadth outweighs repetition', () => {
  const broad = scoreCandidate({ demandSourceCount: 10, demandOccurrences: 10 });
  const deep = scoreCandidate({ demandSourceCount: 1, demandOccurrences: 100 });
  assert.ok(broad > deep, 'ten publishers mentioning it once is a market; one repeating it is a habit');
  assert.equal(scoreCandidate({}), 0, 'an unmeasured candidate scores zero and is still proposed');
});

test('the proposal digest binds the evidence, not just the wording', () => {
  const one = sha256Digest(proposalFor(candidate('x')));
  const two = sha256Digest(proposalFor(candidate('x', { evidence: ['a:4'] })));
  assert.notEqual(one, two, 'an approval must stop applying if the evidence behind it changes');
});

test('the cost estimate is a deployer setting with a stated default', () => {
  assert.equal(estimatedItemCostUsd({}), 0.75);
  assert.equal(estimatedItemCostUsd({ ORCHARD_ESTIMATED_ITEM_COST_USD: '2.5' }), 2.5);
  assert.throws(() => estimatedItemCostUsd({ ORCHARD_ESTIMATED_ITEM_COST_USD: 'free' }));
  assert.throws(() => estimatedItemCostUsd({ ORCHARD_ESTIMATED_ITEM_COST_USD: '-1' }));
});

test.after(() => {
  for (const directory of temporaries) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
  }
});
