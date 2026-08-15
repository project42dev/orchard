#!/usr/bin/env node
// The gate announcement must be impossible to get wrong in the direction that
// matters: it may never fail a run, and it may never be silent about being
// unable to announce.
//
// THESE TESTS BUILD THE PRODUCTION SCHEMA, and that is the point of the file.
// The first version hand-created a `work_item` table with `database.exec` and
// passed every assertion. No deployed database has that table: it lives in
// content-db.sql, which only a local build ever runs. So the tests certified
// code that could not execute one statement in production, and would have kept
// certifying it. Every fixture here goes through migrateContentDb and
// openStateStore, which is exactly what the container does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { announceGates, pendingForGate, renderGateIssue } from './announce-gates.mjs';
import { gateMarker } from './lib/github-issues.mjs';
import { openStateStore } from './lib/state-store.mjs';
import { heldSetDigest, persistDiscoveryItems } from './lib/gate-queue.mjs';
import { generateGateManifests } from './lib/gates.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';

const DIGEST = `sha256:${'0'.repeat(64)}`;
const SHA = '0'.repeat(40);
const temporaries = [];

function runManifest(runId, status = 'running') {
  const record = {
    schema_version: '1.0.0',
    run_id: runId,
    track: 'track-1',
    trigger: { type: 'manual', reference: 'test' },
    status,
    configuration_digest: DIGEST,
    source_registry_digest: DIGEST,
    content_commit: SHA,
    implementation_commit: SHA,
    model_role_map_digest: DIGEST,
    started_at: '2026-08-15T00:00:00.000Z',
    completed_at: status === 'running' ? null : '2026-08-15T00:10:00.000Z',
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

function candidate(term, sources = 3) {
  const subject = `Teaching ${term}`;
  return {
    subject,
    surface: 'learning',
    outcome: `teach ${subject}`,
    scope: 'content',
    title: `How to teach ${term}`,
    term,
    level: 'intermediate',
    demandOccurrences: sources * 4,
    demandSourceCount: sources,
    evidence: Array.from({ length: sources }, (_, index) => `source-${index}:4`),
    evidenceRefs: [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
    observedAt: '2026-08-15T00:00:00.000Z',
    sourceLabels: ['Example Publisher'],
    semanticIdentity: `sid:v1:${sha256Digest(term).slice(7)}`,
  };
}

/** A state database with the exact schema the container migrates to. */
async function estate(candidates = []) {
  const directory = mkdtempSync(join(tmpdir(), 'orchard-gate-'));
  temporaries.push(directory);
  const store = openStateStore(join(directory, 'state.db'));
  const runId = generateUuidV7();
  await store.recordRun(runManifest(runId));
  const result = candidates.length
    ? await persistDiscoveryItems({ store, runId, candidates, now: '2026-08-15T00:05:00.000Z' })
    : { persisted: 0, items: [] };
  return { store, db: store.db, runId, result };
}

function recordingFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url, method: options?.method ?? 'GET', body: options?.body });
      const next = responses.shift() ?? { ok: true, status: 200, body: '[]' };
      return { ok: next.ok, status: next.status, text: async () => next.body };
    },
  };
}

test('a gate holding nothing is reported empty, not skipped in silence', async () => {
  const { store, runId } = await estate();
  const events = [];
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't',
    log: (_l, e) => events.push(e), fetchImpl: async () => { throw new Error('must not call GitHub'); },
  });
  assert.deepEqual(results.map((r) => r.action), ['empty', 'empty']);
  assert.deepEqual(events, ['gate.announce.empty', 'gate.announce.empty']);
  store.close();
});

test('a candidate persisted by discovery is what Gate 1 announces', async () => {
  const { store, runId, result } = await estate([candidate('vector-search')]);
  assert.equal(result.persisted, 1);
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: '[]' },
    { ok: true, status: 201, body: JSON.stringify({ number: 7, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  assert.deepEqual(results.map((r) => [r.gate, r.action]), [['gate-1', 'created'], ['gate-2', 'empty']]);
  assert.equal(calls.at(-1).method, 'POST');
  const posted = JSON.parse(calls.at(-1).body);
  assert.ok(posted.body.includes('How to teach vector-search'), 'the issue must name what is being decided');
  assert.ok(posted.body.includes('/orchard gate1 approve item='), 'the issue must carry the exact decision command');
  assert.ok(posted.body.includes('project42dev/project42-platform'), 'the issue must show where the content would land');
  store.close();
});

test('the same held set updates its issue rather than opening a second one', async () => {
  const { store, runId } = await estate([candidate('prompt-injection')]);
  const items = pendingForGate(store.db, 'gate-1', 'track-1');
  const [manifest] = await generateGateManifests({
    gate: 'gate-1', runId, track: 'track-1', items: items.map(({ track: _t, ...entry }) => entry),
  });
  const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId, batchDigest: heldSetDigest('gate-1', manifest.items) });
  const { impl } = recordingFetch([
    { ok: true, status: 200, body: JSON.stringify([{ number: 7, body: `${marker}\nold` }]) },
    { ok: true, status: 200, body: JSON.stringify({ number: 7, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId: generateUuidV7(), repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  assert.equal(results[0].action, 'updated', 'a later run must find the issue by the held set, not by its own run id');
  assert.equal(results[0].number, 7);
  store.close();
});

test('the marker keys on the batch digest so a changed set gets a new issue', () => {
  const first = gateMarker({ track: 'track-1', gate: 'gate-1', runId: 'r1', batchDigest: `sha256:${'a'.repeat(64)}` });
  const second = gateMarker({ track: 'track-1', gate: 'gate-1', runId: 'r2', batchDigest: `sha256:${'a'.repeat(64)}` });
  const third = gateMarker({ track: 'track-1', gate: 'gate-1', runId: 'r1', batchDigest: `sha256:${'b'.repeat(64)}` });
  assert.equal(first, second, 'the run id must not change the marker');
  assert.notEqual(first, third, 'a different held set must be a different issue');
  assert.throws(() => gateMarker({ track: 'track-1', gate: 'gate-1', runId: 'r1', batchDigest: 'nope' }));
});

test('the body carries its marker and the normative decision grammar', async () => {
  const { store, runId } = await estate([candidate('agent-evaluation')]);
  const items = pendingForGate(store.db, 'gate-1', 'track-1');
  const [manifest] = await generateGateManifests({
    gate: 'gate-1', runId, track: 'track-1', items: items.map(({ track: _t, ...entry }) => entry),
  });
  const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId, batchDigest: heldSetDigest('gate-1', manifest.items) });
  const body = renderGateIssue({ gate: 'gate-1', track: 'track-1', runId, marker, items: manifest.items, manifest });
  assert.ok(body.startsWith(marker), 'the marker must lead, it is how the issue is found again');
  assert.ok(body.includes(manifest.items[0].item_id));
  assert.ok(body.includes(manifest.items[0].proposal_digest), 'a Gate 1 decision binds to the proposal digest');
  assert.ok(body.includes(`revision=${manifest.items[0].item_revision}`));
  store.close();
});

test('pendingForGate reads the lifecycle table, and only the state it was asked for', async () => {
  const { store } = await estate([candidate('rag-evaluation')]);
  assert.equal(pendingForGate(store.db, 'gate-1', 'track-1').length, 1);
  assert.equal(pendingForGate(store.db, 'gate-2', 'track-1').length, 0);
  assert.equal(pendingForGate(store.db, 'gate-1', 'track-2').length, 0, 'a track must not announce the other track\'s work');
  assert.throws(() => pendingForGate(store.db, 'gate-3'));
  store.close();
});

test('a GitHub failure names the gate it happened to and leaves the other alone', async () => {
  const { store, runId } = await estate([candidate('tool-use-safety')]);
  const events = [];
  const { impl } = recordingFetch([{ ok: false, status: 503, body: 'down' }]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't',
    log: (_l, event, detail) => events.push([event, detail?.gate]), fetchImpl: impl,
  });
  assert.deepEqual(results.map((r) => [r.gate, r.action]), [['gate-1', 'failed'], ['gate-2', 'empty']]);
  assert.deepEqual(events, [['gate.announce.gate-failed', 'gate-1'], ['gate.announce.empty', 'gate-2']]);
  store.close();
});

test.after(() => {
  // Windows keeps a handle on a just-closed SQLite file for a moment. A failed
  // cleanup is a temp directory, not a test result, so it must never turn a
  // passing suite red.
  for (const directory of temporaries) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
  }
});
