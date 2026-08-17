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
import { announceGates, gateAssignees, pendingForGate, renderGateIssue } from './announce-gates.mjs';
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
  const embedded = /```json\n(.*)\n```/s.exec(body);
  assert.ok(embedded, 'the issue must carry the exact manifest a capture can verify against');
  assert.equal(sha256Digest(JSON.parse(embedded[1])), sha256Digest(manifest));
  store.close();
});

test('a batch of items with real-world-heavy evidence splits below the body limit instead of losing its manifest', async () => {
  // Found live 2026-08-17: Track 2's 9 currency Gate 1 issues (20 items each,
  // the normative MAX_GATE_BATCH_SIZE) all hit the old overflow branch, which
  // dropped the embedded manifest and left only a claim that a batch digest
  // "still binds every decision below" -- nothing in apply-gate-decisions.mjs
  // ever reads a manifest any way but the fenced JSON block, so those 9
  // issues were permanently unapprovable. Root cause, not a hypothetical: a
  // currency item's evidence_refs can carry up to 50 entries at up to 1000
  // characters each (gate-queue.mjs slices to 50, track-2-controller.mjs
  // truncates each entry to 1000) -- 20 such items serialize well past
  // GitHub's 65536-character body limit before the human-readable rendering
  // even joins it. This reproduces that shape directly.
  const heavyEvidence = Array.from({ length: 20 }, (_, i) => `evidence entry ${i}: `.padEnd(1000, 'x'));
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    ...candidate(`overflow-term-${index}`, 20),
    evidence: heavyEvidence,
  }));
  const { store, runId } = await estate(candidates);
  const items = pendingForGate(store.db, 'gate-1', 'track-1');
  assert.equal(items.length, 20, 'the fixture must actually produce 20 pending items to reproduce the real batch size');
  const manifests = await generateGateManifests({
    gate: 'gate-1', runId, track: 'track-1', items: items.map(({ track: _t, ...entry }) => entry),
  });
  assert.ok(manifests.length > 1, 'a batch this heavy must actually split, or the fixture proves nothing about the fix');
  assert.equal(manifests.reduce((sum, m) => sum + m.items.length, 0), 20, 'splitting must not gain or lose an item');
  assert.equal(new Set(manifests.flatMap((m) => m.items.map((i) => i.item_id))).size, 20, 'no item may appear in two batches');

  for (const manifest of manifests) {
    const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId, batchDigest: heldSetDigest('gate-1', manifest.items) });
    const body = renderGateIssue({ gate: 'gate-1', track: 'track-1', runId, marker, items: manifest.items, manifest });
    assert.ok(body.length <= 65_536, `batch ${manifest.batch.ordinal}/${manifest.batch.count} must fit GitHub's body limit`);
    const embedded = /```json\n(.*)\n```/s.exec(body);
    assert.ok(embedded, `batch ${manifest.batch.ordinal}/${manifest.batch.count} must still carry its manifest -- the manifest is what makes a decision bindable at all`);
    assert.equal(sha256Digest(JSON.parse(embedded[1])), sha256Digest(manifest), 'the embedded manifest must be exact and unmodified');
  }
  store.close();
});

test('renderGateIssue falls back to the compact rendering, and never drops the manifest, when a single batch is still oversized', () => {
  // A safety net independent of generateGateManifests' own splitting above:
  // proves renderGateIssue itself never regresses to silently omitting the
  // manifest for an oversized batch, even one built by hand rather than
  // through the normal item-splitting path. 1500 characters of rationale
  // across 20 items is chosen because it reproduces exactly the case the
  // compact rendering exists for: the full human-readable table (which
  // duplicates every field a second time, in prose) pushes the body over
  // the limit on its own (measured ~84KB), while the raw JSON manifest alone
  // does not (~28KB) -- so dropping the duplicate table, not the manifest,
  // is what should fix it. A rationale near gate-queue.mjs's 4000-character
  // cap is deliberately NOT used here: at that size the raw JSON alone
  // already exceeds the body limit, which no amount of compacting the human
  // table can fix -- that case is what sizedBatches (generateGateManifests)
  // exists to prevent from ever reaching this function in the first place,
  // proven by the test above.
  const longRationale = 'x'.repeat(1500);
  const items = Array.from({ length: 20 }, (_, index) => ({
    item_id: generateUuidV7(), item_revision: 1, proposal_digest: DIGEST, category: 'new-module',
    title: `Overflow item ${index}`, rationale: longRationale, evidence_refs: [`https://example.invalid/${index}`],
    score: { value: 1, formula_version: 'v1' }, target: { repository: 'o/r', path: `docs/${index}.md` },
    risks: ['none'], estimated_cost: { currency: 'USD', amount: 1 }, decision_state: 'pending',
  }));
  const runId = generateUuidV7();
  const manifest = {
    schema_version: '1.0.0', gate: 'gate-1', run_id: runId, track: 'track-1',
    batch: { ordinal: 1, count: 1, item_count: 20, total_item_count: 20, maximum_size: 20 },
    full_manifest_digest: DIGEST, batch_digest: DIGEST, idempotency_key: 'github:gate-1:x:y', items,
  };
  const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId, batchDigest: heldSetDigest('gate-1', items) });
  const body = renderGateIssue({ gate: 'gate-1', track: 'track-1', runId, marker, items, manifest });
  assert.ok(body.length <= 65_536, 'GitHub refuses a body over 65536 characters');
  const embedded = /```json\n(.*)\n```/s.exec(body);
  assert.ok(embedded, 'an oversized single batch must still carry its manifest, compacted, never omitted');
  assert.equal(sha256Digest(JSON.parse(embedded[1])), sha256Digest(manifest), 'the compacted rendering must still carry the exact, unmodified manifest');
  assert.ok(body.includes(`revision=${items[0].item_revision}`), 'the decision command must still be present even in the compact rendering');
  const rationaleOccurrences = body.split(longRationale).length - 1;
  assert.equal(rationaleOccurrences, 20, 'the rationale must appear exactly once per item -- inside the embedded manifest -- not a second time duplicated into a human-readable table row');
  const head = body.slice(0, body.indexOf('```json'));
  assert.ok(!head.includes(longRationale), 'the compact human-readable portion must not duplicate the prose that caused the overflow');
});

test('a created gate issue assigns the owner, because assignment is what makes GitHub send the email', async () => {
  const { store, runId } = await estate([candidate('assignment-email')]);
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: '[]' },
    { ok: true, status: 201, body: JSON.stringify({ number: 9, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { },
    fetchImpl: impl, assignees: ['countrycloudboy'],
  });
  assert.equal(results[0].action, 'created');
  const posted = JSON.parse(calls.at(-1).body);
  assert.deepEqual(posted.assignees, ['countrycloudboy'], 'the create request must carry the assignee or no notification ever fires');
  store.close();
});

test('an update carries the assignee too, so issues opened before assignment existed still reach the owner', async () => {
  const { store, runId } = await estate([candidate('late-assignment')]);
  const items = pendingForGate(store.db, 'gate-1', 'track-1');
  const [manifest] = await generateGateManifests({
    gate: 'gate-1', runId, track: 'track-1', items: items.map(({ track: _t, ...entry }) => entry),
  });
  const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId, batchDigest: heldSetDigest('gate-1', manifest.items) });
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: JSON.stringify([{ number: 7, body: `${marker}\nold` }]) },
    { ok: true, status: 200, body: JSON.stringify({ number: 7, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { },
    fetchImpl: impl, assignees: ['countrycloudboy'],
  });
  assert.equal(results[0].action, 'updated');
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.deepEqual(JSON.parse(calls.at(-1).body).assignees, ['countrycloudboy']);
  store.close();
});

test('no assignee still creates the issue, and sends no assignees field at all', async () => {
  const { store, runId } = await estate([candidate('unassigned-gate')]);
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: '[]' },
    { ok: true, status: 201, body: JSON.stringify({ number: 11, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  assert.equal(results[0].action, 'created', 'notification config must never block the gate issue');
  assert.ok(!('assignees' in JSON.parse(calls.at(-1).body)), 'an empty list must not send an empty field');
  store.close();
});

test('gateAssignees resolves the numeric id to its current login, falling back to the gate actors', async () => {
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: JSON.stringify({ id: 4242, login: 'countrycloudboy' }) },
  ]);
  const logins = await gateAssignees({
    token: 't', log: () => { }, env: { ORCHARD_GATE_ACTORS: '4242' }, fetchImpl: impl,
  });
  assert.deepEqual(logins, ['countrycloudboy'], 'the id is config, the login is what the issues API accepts');
  assert.ok(calls[0].url.endsWith('/user/4242'), 'resolution must go through the immutable id, never a stored login');
});

test('the dedicated notify setting wins over the actor list', async () => {
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: JSON.stringify({ id: 31337, login: 'someone-else' }) },
  ]);
  const logins = await gateAssignees({
    token: 't', log: () => { },
    env: { ORCHARD_GATE_NOTIFY_GITHUB_USER_ID: '31337', ORCHARD_GATE_ACTORS: '4242' }, fetchImpl: impl,
  });
  assert.deepEqual(logins, ['someone-else']);
  assert.ok(calls[0].url.endsWith('/user/31337'));
});

test('gateAssignees never throws and never blocks: bad config and dead ids warn and are skipped', async () => {
  const events = [];
  const log = (_l, event) => events.push(event);
  assert.deepEqual(await gateAssignees({ token: 't', log, env: {} }), []);
  assert.deepEqual(
    await gateAssignees({
      token: 't', log, env: { ORCHARD_GATE_ACTORS: 'countrycloudboy' },
      fetchImpl: async () => { throw new Error('must not call GitHub for a login'); },
    }),
    [], 'a login is refused, not resolved: it can be reassigned out from under the config',
  );
  const { impl } = recordingFetch([{ ok: false, status: 404, body: JSON.stringify({ message: 'Not Found' }) }]);
  assert.deepEqual(await gateAssignees({ token: 't', log, env: { ORCHARD_GATE_ACTORS: '999999999' }, fetchImpl: impl }), []);
  assert.deepEqual(events, ['gate.assignee.unconfigured', 'gate.assignee.invalid', 'gate.assignee.unresolved']);
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

