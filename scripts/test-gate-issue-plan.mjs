#!/usr/bin/env node
// A growing set of held items must not grow a set of issues.
//
// WHAT HAPPENED. On 2026-09-12 Track 2 discovered findings one at a time all
// evening. Each discovery re-chunked the whole pending set, every batch after
// the insertion point changed its digest, the markers stopped matching, and
// openOrUpdateGateIssue opened a fresh issue for each. 53 open Gate 2 issues,
// 24 distinct generations of the same set, 1 comment on any of them, and an
// owner who would not read another one. The gate was working perfectly and was
// unusable, which is the same thing as not working.
//
// WHAT THESE TESTS PROTECT. Two properties, and they pull in opposite
// directions, which is why they are tested together and not separately:
//
//   NOTHING IS SILENTLY DROPPED. Every pending item is named by some open issue
//   at all times. A tidier set of issues that stops mentioning held work is a
//   worse failure than the sprawl, because the sprawl at least says everything
//   out loud.
//
//   NOTHING IS SILENTLY WIDENED. An issue's item set never grows after it
//   exists, and an item is matched by its whole announced triple (id, revision,
//   decision digest) rather than by id. A bare `approve` names no item and is
//   re-read every run, so ANY item that appears on an issue after the owner
//   read it is an item a bare approve would decide unseen.
//
// Nothing here decides anything. These tests assert which issues exist and
// which are closed, never what an item's outcome is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { announceGates, pendingForGate } from './announce-gates.mjs';
import { announcedTriple, closureComment, planGateIssues, rankIssue } from './lib/gate-issue-plan.mjs';
import { generateGateManifests, sizedBatches } from './lib/gates.mjs';
import { heldSetDigest, persistDiscoveryItems } from './lib/gate-queue.mjs';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { protectedAdapterDigest } from './lib/protected-adapter.mjs';
import { adapterIdentity } from './adapters/github-gate/adapter.mjs';
import { applyGateDecisions, currentStateOf } from './apply-gate-decisions.mjs';

const DIGEST = `sha256:${'0'.repeat(64)}`;
const SHA = '0'.repeat(40);
const REPO = 'project42dev/orchard';
const OWNER_ID = 4242;
const ADAPTER = resolve('scripts/adapters/github-gate/adapter.mjs');
const POLICY = Object.freeze({ schema_version: '1.0.0', provider: 'github', repository: REPO, authorized_actor_ids: [String(OWNER_ID)] });
const temporaries = [];

// ---------------------------------------------------------------------------
// The planner, which is pure. These fixtures are deliberately the smallest
// thing manifestFromIssueBody will accept, because the planner's job is about
// WHICH issue holds an item and not about what a manifest means.
// ---------------------------------------------------------------------------

const item = (id, revision = 1, digestSeed = id) => ({
  item_id: id, item_revision: revision,
  proposal_digest: sha256Digest(`proposal:${digestSeed}:${revision}`),
  artifact_digest: sha256Digest(`artifact:${digestSeed}:${revision}`),
  target: { repository: 'project42dev/project42-content', path: `modules/x/${id}.json` },
});

function issueBody(gate, items) {
  const manifest = {
    schema_version: '1.0.0', gate, run_id: '018f0000-0000-7000-8000-000000000000', track: 'track-2',
    batch: { ordinal: 1, count: 1, item_count: items.length, total_item_count: items.length, maximum_size: 20 },
    full_manifest_digest: DIGEST, batch_digest: DIGEST, idempotency_key: `github:${gate}:x:y`, items,
  };
  return [
    `<!-- orchard:gate track=track-2 gate=${gate} batch=${heldSetDigest(gate, items)} -->`,
    '', '<details>', '', '```json', JSON.stringify(manifest), '```', '', '</details>',
  ].join('\n');
}

function openIssue(number, items, { gate = 'gate-2', comments = 0, updated = '2026-09-12T20:00:00Z', body } = {}) {
  return { number, comments, updated_at: updated, body: body ?? issueBody(gate, items) };
}

test('a growing set updates the issues it already has and opens ONE issue for what is new -- it does not open a new generation', () => {
  // The exact shape of the 2026-09-12 incident, reduced: three items are
  // announced on two issues, a fourth is discovered, and the old behaviour
  // re-chunked everything and reopened all of it.
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => item(id));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a, b]), openIssue(102, [c])],
    pendingItems: [a, b, c, d],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [101, 102, null],
    'the two existing issues must be kept and updated; only the new item may open an issue');
  assert.deepEqual(plan.groups[0].items.map((entry) => entry.item_id), ['a', 'b']);
  assert.deepEqual(plan.groups[1].items.map((entry) => entry.item_id), ['c']);
  assert.deepEqual(plan.groups[2].items.map((entry) => entry.item_id), ['d'], 'the fresh item gets its own issue');
  assert.deepEqual(plan.close, [], 'nothing is finished, so nothing is closed');
});

test('EVERY pending item is named by some issue in the plan -- a plan that drops one is refused outright', () => {
  // The invariant that outranks tidiness. Driven over a set large enough that
  // an off-by-one in the anchoring or the chunking cannot hide.
  const items = Array.from({ length: 37 }, (_, index) => item(`item-${String(index).padStart(2, '0')}`));
  // Overlapping generations, exactly as the live repository had them: each
  // "generation" announces a growing prefix of the set, in several issues.
  const openIssues = [];
  let number = 200;
  for (const size of [3, 9, 20, 31]) {
    for (const batch of sizedBatches(items.slice(0, size))) openIssues.push(openIssue(number += 1, batch));
  }
  const plan = planGateIssues({ gate: 'gate-2', openIssues, pendingItems: items, chunk: sizedBatches });
  const planned = plan.groups.flatMap((group) => group.items.map((entry) => entry.item_id));
  assert.equal(planned.length, items.length, 'each pending item appears exactly once across the plan');
  assert.deepEqual([...planned].sort(), items.map((entry) => entry.item_id).sort(), 'no pending item is dropped from announcement');
  for (const entry of plan.close) {
    for (const triple of entry.pendingTriples) {
      assert.ok(planned.includes(triple.split(':')[0]), `#${entry.issueNumber} may not be closed while it still holds unannounced work`);
    }
  }
  assert.ok(plan.close.length > 0, 'the superseded generations must actually be closed, or this proves nothing about the fix');
});

test('an issue NEVER closes while it is the sole announcement of a still-pending item', () => {
  // The guard, stated directly. Two issues, disjoint item sets: neither is
  // redundant, so neither may be closed however tidy that would be.
  const [a, b] = ['a', 'b'].map((id) => item(id));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a]), openIssue(102, [b], { updated: '2026-09-12T23:00:00Z' })],
    pendingItems: [a, b],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.close, [], 'an issue that is the only place an item is announced must stay open');
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [101, 102]);
});

test('an issue whose items are all announced elsewhere is closed, naming the issue that supersedes it', () => {
  const [a, b] = ['a', 'b'].map((id) => item(id));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a, b]), openIssue(102, [a, b], { updated: '2026-09-12T23:00:00Z' })],
    pendingItems: [a, b],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [102], 'the duplicate collapses onto one issue');
  assert.equal(plan.close.length, 1);
  assert.equal(plan.close[0].issueNumber, 101);
  assert.deepEqual(plan.close[0].supersededBy, [102]);
  const comment = closureComment({ ...plan.close[0], states: {} });
  assert.ok(comment.includes('#102'), 'the closure must name where the work went');
  assert.ok(/no decision was made/i.test(comment), 'the closure must say plainly that it decided nothing');
});

test('an issue whose items are no longer pending is closed, and says what became of them', () => {
  const [a, b] = ['a', 'b'].map((id) => item(id));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a]), openIssue(102, [b])],
    pendingItems: [b],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [102]);
  assert.equal(plan.close.length, 1);
  assert.equal(plan.close[0].issueNumber, 101);
  assert.deepEqual(plan.close[0].moved, [], 'nothing moved: the item simply left the gate');
  assert.equal(plan.close[0].settled.length, 1);
  const comment = closureComment({ ...plan.close[0], states: { a: 'changes-requested' } });
  assert.ok(comment.includes('changes-requested'), 'the closure must say what the item is now, not just that it left');
  assert.ok(comment.includes('announced again'), 'and that it will be announced afresh if it comes back');
});

test('an item that comes back at a NEW REVISION is a new item: it gets a new issue, never the old one', () => {
  // The binding property, enforced at the level of which issue exists. A bare
  // `approve` is expanded over whatever is pending on its issue, so if a
  // reworked item were placed back onto the issue it was announced on at the
  // previous revision, an old bare approve would decide a revision the owner
  // never saw.
  const first = item('a', 1);
  const reworked = item('a', 2);
  assert.notEqual(announcedTriple('gate-2', first), announcedTriple('gate-2', reworked));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [first])],
    pendingItems: [reworked],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [null],
    'revision 2 must not be added to the issue that announced revision 1');
  assert.deepEqual(plan.groups[0].items.map((entry) => entry.item_revision), [2]);
  assert.deepEqual(plan.close.map((entry) => entry.issueNumber), [101],
    'the issue that announced the superseded revision is finished, and is closed rather than silently rewritten');
});

test('an item whose DIGEST changed at the same revision is also a new item', () => {
  const first = item('a', 1, 'original');
  const changed = item('a', 1, 'rewritten');
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [first])],
    pendingItems: [changed],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [null],
    'the decision digest is part of what was announced; a different one was never on that page');
});

test('a fresh item never joins an issue that already exists, even when that issue has room', () => {
  // Packing would look like an optimisation and is the bare-approve widening
  // in disguise. An existing group may only ever shrink.
  const existing = Array.from({ length: 3 }, (_, index) => item(`old-${index}`));
  const fresh = item('new-0');
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, existing)],
    pendingItems: [...existing, fresh],
    chunk: sizedBatches,
  });
  const onExisting = plan.groups.find((group) => group.issueNumber === 101);
  assert.deepEqual(onExisting.items.map((entry) => entry.item_id), existing.map((entry) => entry.item_id),
    'issue #101 must carry exactly what it already carried, and nothing more');
  assert.ok(plan.groups.some((group) => group.issueNumber === null && group.items.length === 1),
    'the fresh item must get its own issue rather than being packed into the half-empty one');
});

test('a decided item leaves its issue, and the issue keeps the rest -- a group may shrink', () => {
  const [a, b] = ['a', 'b'].map((id) => item(id));
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a, b])],
    pendingItems: [b],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [101]);
  assert.deepEqual(plan.groups[0].items.map((entry) => entry.item_id), ['b']);
  assert.deepEqual(plan.close, []);
});

test('when several issues offer the same item, one that has been commented on keeps it', () => {
  // A decision comment is the entire point of the gate. Collapsing duplicates
  // onto the issue nobody has written on would strand it.
  const a = item('a');
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [
      openIssue(101, [a], { comments: 1, updated: '2026-09-12T20:00:00Z' }),
      openIssue(102, [a], { updated: '2026-09-12T23:59:00Z' }),
    ],
    pendingItems: [a],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.groups.map((group) => group.issueNumber), [101], 'the commented issue keeps the item');
  assert.deepEqual(plan.close.map((entry) => entry.issueNumber), [102]);
  assert.ok(rankIssue({ number: 1, comments: 1, updated_at: '2020-01-01T00:00:00Z' })[0]
    > rankIssue({ number: 999, comments: 0, updated_at: '2030-01-01T00:00:00Z' })[0]);
});

test('an issue whose body carries no readable manifest is left alone, never closed', () => {
  // An issue whose contents cannot be read is one whose contents cannot be
  // proven finished either, and closing it would be a guess.
  const a = item('a');
  const plan = planGateIssues({
    gate: 'gate-2',
    openIssues: [openIssue(101, [a]), openIssue(102, [], { body: '<!-- orchard:gate track=track-2 gate=gate-2 batch=x -->\nno manifest here' })],
    pendingItems: [a],
    chunk: sizedBatches,
  });
  assert.deepEqual(plan.close, [], 'an unreadable issue must not be closed on an assumption');
  assert.deepEqual(plan.unreadable.map((entry) => entry.issueNumber), [102]);
});

test('a gate holding nothing closes every issue it left behind', () => {
  const [a, b] = ['a', 'b'].map((id) => item(id));
  const plan = planGateIssues({ gate: 'gate-2', openIssues: [openIssue(101, [a]), openIssue(102, [b])], pendingItems: [], chunk: sizedBatches });
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.close.map((entry) => entry.issueNumber), [101, 102]);
  for (const entry of plan.close) assert.deepEqual(entry.pendingTriples, [], 'nothing is pending, so nothing can be stranded');
});

test('the plan is stable: running it again over its own result changes nothing', () => {
  // The steady state is what stops the sprawl coming back. Once the open
  // issues partition the pending set, a further pass must be a no-op.
  const items = Array.from({ length: 11 }, (_, index) => item(`item-${index}`));
  const first = planGateIssues({ gate: 'gate-2', openIssues: [], pendingItems: items, chunk: sizedBatches });
  const opened = first.groups.map((group, index) => openIssue(300 + index, group.items));
  const second = planGateIssues({ gate: 'gate-2', openIssues: opened, pendingItems: items, chunk: sizedBatches });
  assert.deepEqual(second.groups.map((group) => group.issueNumber), opened.map((issue) => issue.number),
    'a second pass must update exactly the issues the first opened');
  assert.deepEqual(second.close, [], 'and must close none of them');
  assert.ok(second.groups.every((group) => group.marker !== null), 'each existing issue keeps the marker it already carries');
});

// ---------------------------------------------------------------------------
// The announcement, end to end, against the real migrated schema.
// ---------------------------------------------------------------------------

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

function candidate(term) {
  const subject = `Teaching ${term}`;
  return {
    subject, surface: 'learning', pathId: 'agentic-systems-and-mcp', outcome: `teach ${subject}`,
    scope: 'content', title: `How to teach ${term}`, term, level: 'intermediate',
    demandOccurrences: 12, demandSourceCount: 3, evidence: ['a:4'],
    evidenceRefs: [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
    observedAt: '2026-08-15T00:00:00.000Z', sourceLabels: ['Example'],
    semanticIdentity: `sid:v1:${sha256Digest(term).slice(7)}`,
  };
}

async function estate(terms, { anchored = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orchard-plan-'));
  temporaries.push(directory);
  const store = openStateStore(join(directory, 'state.db'));
  const runId = generateUuidV7();
  await store.recordRun(runManifest(runId));
  await persistDiscoveryItems({ store, runId, candidates: terms.map(candidate), now: '2026-08-15T00:05:00.000Z' });
  if (anchored) {
    store.provisionTrustAnchor({
      scope: 'gate', adapter_identity: adapterIdentity,
      adapter_digest: await protectedAdapterDigest(ADAPTER), adapter_path: ADAPTER,
      policy_digest: sha256Digest(POLICY), policy: POLICY,
      provisioned_at: '2026-08-15T00:00:00.000Z',
    });
  }
  return { store, runId };
}

/** A real Gate 1 issue body for a subset of the held items, as an earlier run would have left it. */
async function announcedIssue(store, runId, number, itemIds, extras = {}) {
  const held = pendingForGate(store.db, 'gate-1', 'track-1')
    .filter((entry) => itemIds.includes(entry.item_id))
    .map(({ track: _t, ...entry }) => entry);
  const [manifest] = await generateGateManifests({ gate: 'gate-1', runId, track: 'track-1', items: held });
  const marker = `<!-- orchard:gate track=track-1 gate=gate-1 batch=${heldSetDigest('gate-1', manifest.items)} -->`;
  return {
    number, comments: 0, updated_at: '2026-09-12T20:00:00Z',
    body: [marker, '', '<details>', '', '```json', JSON.stringify(manifest), '```', '', '</details>'].join('\n'),
    ...extras,
  };
}

function githubFor(openIssues, { failWriteTo = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const path = String(url);
    const method = options?.method ?? 'GET';
    calls.push({ path, method, body: options?.body ? JSON.parse(options.body) : null });
    if (/\/issues\?state=open/.test(path)) return { ok: true, status: 200, text: async () => JSON.stringify(openIssues) };
    const numbered = /\/issues\/(\d+)$/.exec(path);
    if (numbered && failWriteTo !== null && Number(numbered[1]) === failWriteTo && method === 'PATCH' && options?.body?.includes('"body"')) {
      return { ok: false, status: 503, text: async () => 'down' };
    }
    if (numbered) return { ok: true, status: 200, text: async () => JSON.stringify({ number: Number(numbered[1]), html_url: 'u', state: 'closed' }) };
    if (/\/issues\/\d+\/comments$/.test(path)) return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1, html_url: 'u' }) };
    if (/\/issues$/.test(path) && method === 'POST') return { ok: true, status: 201, text: async () => JSON.stringify({ number: 999, html_url: 'u' }) };
    return { ok: true, status: 200, text: async () => '[]' };
  };
  return { impl, calls };
}

test('announcing a grown set patches the issue that exists and posts exactly one new one', async () => {
  const { store, runId } = await estate(['alpha', 'beta', 'gamma']);
  const ids = pendingForGate(store.db, 'gate-1', 'track-1').map((entry) => entry.item_id);
  const existing = await announcedIssue(store, runId, 101, [ids[0]]);
  const { impl, calls } = githubFor([existing]);
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  const creates = calls.filter((call) => call.method === 'POST' && /\/issues$/.test(call.path));
  const patches = calls.filter((call) => call.method === 'PATCH');
  assert.equal(creates.length, 1, 'only the items that were on no open issue may open one');
  assert.equal(patches.length, 1, 'the issue that already announces work is updated in place');
  assert.ok(patches[0].path.endsWith('/issues/101'), 'updated by number, not by searching for a marker');
  assert.deepEqual(results.filter((entry) => entry.gate === 'gate-1').map((entry) => entry.action), ['updated', 'created']);
  store.close();
});

test('announcing closes the superseded duplicate, with a comment, and never closes the live one', async () => {
  const { store, runId } = await estate(['alpha', 'beta']);
  const ids = pendingForGate(store.db, 'gate-1', 'track-1').map((entry) => entry.item_id);
  const older = await announcedIssue(store, runId, 101, ids);
  const newer = await announcedIssue(store, runId, 102, ids, { updated_at: '2026-09-12T23:00:00Z' });
  const { impl, calls } = githubFor([older, newer]);
  const events = [];
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: (_l, event) => events.push(event), fetchImpl: impl,
  });
  const closed = calls.filter((call) => call.method === 'PATCH' && call.body?.state === 'closed');
  assert.deepEqual(closed.map((call) => call.path.split('/').pop()), ['101'], 'exactly the redundant issue is closed');
  const closureNote = calls.find((call) => /\/issues\/101\/comments$/.test(call.path));
  assert.ok(closureNote, 'a closure is never silent');
  assert.ok(closureNote.body.body.includes('#102'), 'the comment must name the issue that supersedes it');
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.path.endsWith('/issues/102') && call.body?.body),
    'the surviving issue is updated with the current manifest');
  assert.ok(events.includes('gate.reconcile.closed'));
  assert.ok(results.some((entry) => entry.action === 'closed' && entry.number === 101));
  store.close();
});

test('a write that failed holds back the close of the issue that announced those items', async () => {
  // The IO half of the sole-announcement guard. The plan says #101 is
  // redundant because #102 now announces everything -- but if the write to
  // #102 did not land, closing #101 would leave the work announced nowhere.
  const { store, runId } = await estate(['alpha', 'beta']);
  const ids = pendingForGate(store.db, 'gate-1', 'track-1').map((entry) => entry.item_id);
  const older = await announcedIssue(store, runId, 101, ids);
  const newer = await announcedIssue(store, runId, 102, ids, { updated_at: '2026-09-12T23:00:00Z' });
  const { impl, calls } = githubFor([older, newer], { failWriteTo: 102 });
  const events = [];
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: (_l, event) => events.push(event), fetchImpl: impl,
  });
  assert.ok(events.includes('gate.announce.batch-failed'), 'the failed write must be reported');
  assert.deepEqual(calls.filter((call) => call.method === 'PATCH' && call.body?.state === 'closed'), [],
    'nothing may be closed on the strength of an announcement that did not happen');
  assert.ok(events.includes('gate.reconcile.close-held-back'));
  assert.ok(results.some((entry) => entry.action === 'close-held-back' && entry.number === 101));
  store.close();
});

test('an issue is NOT closed when its items are invisible to the announcement but still held at the gate', async () => {
  // The other way the sole-announcement guard can be defeated, and the one
  // that is not hypothetical. heldAtGate INNER JOINs item_revision on the
  // item's current revision; an item whose current revision has no revision
  // row is still `gate1-pending` in workflow_item and simply stops being
  // returned. Every such item then looks "no longer pending" to the plan, its
  // issue looks finished, and closing it would take away the only place that
  // work is named. workflow_item.current_state is the authority on what is
  // pending, so it overrides the join here.
  const { store, runId } = await estate(['alpha']);
  const ids = pendingForGate(store.db, 'gate-1', 'track-1').map((entry) => entry.item_id);
  const stale = await announcedIssue(store, runId, 101, ids);
  // Exactly the shape above: still gate1-pending, no revision row to join to.
  store.db.prepare('UPDATE workflow_item SET current_revision = 2 WHERE item_id = ?').run(ids[0]);
  assert.equal(pendingForGate(store.db, 'gate-1', 'track-1').length, 0, 'the fixture must actually make the item invisible to the announcement');
  assert.equal(currentStateOf(store.db, ids[0]), 'gate1-pending', 'and the item must still be held at the gate');
  const { impl, calls } = githubFor([stale]);
  const events = [];
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: (_l, event) => events.push(event), fetchImpl: impl,
  });
  assert.deepEqual(calls.filter((call) => call.method === 'PATCH' && call.body?.state === 'closed'), [],
    'the only issue naming a still-held item must stay open, however finished it looks');
  assert.ok(events.includes('gate.reconcile.close-held-back-unannounced'),
    'and the mismatch must be named, because a silently unannounced held item is the failure this whole file is about');
  assert.ok(results.some((entry) => entry.action === 'close-held-back'));
  store.close();
});

test('a gate that holds nothing closes the issues it left behind, and writes no new one', async () => {
  const { store, runId } = await estate(['alpha']);
  const ids = pendingForGate(store.db, 'gate-1', 'track-1').map((entry) => entry.item_id);
  const stale = await announcedIssue(store, runId, 101, ids);
  // Gate 2 holds nothing at all, and the stale issue is a Gate 1 one, so the
  // Gate 2 pass must leave it completely alone.
  const { impl, calls } = githubFor([stale]);
  await announceGates({ db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl });
  assert.deepEqual(calls.filter((call) => call.method === 'PATCH' && call.body?.state === 'closed'), [],
    'an item still held keeps its issue open');
  store.close();
});

test('the listing is read once per gate, not once per batch', async () => {
  // Economy, and the reason it matters: the old path paged every open issue
  // once per batch to find a marker. At 53 open issues and 25 batches that is
  // 25 redundant listings on a token that had already been rate limited.
  const { store, runId } = await estate(['alpha', 'beta', 'gamma', 'delta']);
  const { impl, calls } = githubFor([]);
  await announceGates({ db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl });
  const listings = calls.filter((call) => /\/issues\?state=open/.test(call.path));
  assert.equal(listings.length, 2, 'one listing for Gate 1 and one for Gate 2, and no more');
  store.close();
});

test('when the listing fails the announcement still happens -- it degrades to the marker search, it does not go silent', async () => {
  const { store, runId } = await estate(['alpha']);
  const calls = [];
  const impl = async (url, options) => {
    const path = String(url);
    const method = options?.method ?? 'GET';
    calls.push({ path, method });
    if (/\/issues\?state=open/.test(path) && method === 'GET' && calls.filter((c) => /state=open/.test(c.path)).length === 1) {
      return { ok: false, status: 503, text: async () => 'down' };
    }
    if (/\/issues\?state=open/.test(path)) return { ok: true, status: 200, text: async () => '[]' };
    if (/\/issues$/.test(path) && method === 'POST') return { ok: true, status: 201, text: async () => JSON.stringify({ number: 7, html_url: 'u' }) };
    return { ok: true, status: 200, text: async () => '[]' };
  };
  const events = [];
  const results = await announceGates({
    db: store.db, track: 'track-1', runId, repo: 'o/r', token: 't', log: (_l, event) => events.push(event), fetchImpl: impl,
  });
  assert.ok(events.includes('gate.reconcile.issues-unreadable'));
  assert.ok(results.some((entry) => entry.gate === 'gate-1' && entry.action === 'created'),
    'a held item must still be announced when the reconciliation cannot run');
  store.close();
});

// ---------------------------------------------------------------------------
// The binding, which must not loosen because an issue's identity changed.
// ---------------------------------------------------------------------------

function comment(body, id = 555, issueNumber = 101) {
  return {
    id, body, user: { id: OWNER_ID, login: 'countrycloudboy' },
    created_at: '2026-08-15T12:00:00Z', updated_at: '2026-08-15T12:00:00Z',
    issue_url: `https://api.github.com/repos/${REPO}/issues/${issueNumber}`,
  };
}

async function pinnedAdapter(store) {
  const anchor = store.getTrustAnchor('gate');
  const module = await import('./adapters/github-gate/adapter.mjs');
  return {
    fetchVerifiedEvent: module.fetchVerifiedEvent,
    adapterIdentity: anchor.adapter_identity,
    adapterDigest: anchor.adapter_digest,
    policyDigest: anchor.policy_digest,
  };
}

test('a decision still binds to the exact item, revision and digest the issue offered -- shrinking an issue in place does not loosen it', async () => {
  // The issue is updated in place, as the reconciliation now does, and one of
  // the two items it used to announce is gone from its manifest. A comment
  // naming the removed item must be refused; a comment naming the item that is
  // still on the issue must still work. The binding is checked against the
  // manifest embedded in the body at the moment the comment is read, so it
  // does not care which issue number carries it -- and that is what makes
  // moving announcements between issues safe.
  const { store, runId } = await estate(['alpha', 'beta'], { anchored: true });
  const held = pendingForGate(store.db, 'gate-1', 'track-1').map(({ track: _t, ...entry }) => entry);
  const [kept, removed] = held;
  const [shrunk] = await generateGateManifests({ gate: 'gate-1', runId, track: 'track-1', items: [kept] });
  const issue = {
    number: 101, comments: 2, updated_at: '2026-09-12T23:00:00Z',
    body: [`<!-- orchard:gate track=track-1 gate=gate-1 batch=${heldSetDigest('gate-1', [kept])} -->`,
      '', '<details>', '', '```json', JSON.stringify(shrunk), '```', '', '</details>'].join('\n'),
  };
  const comments = [
    comment(`/orchard gate1 deny item=${removed.item_id} revision=1 digest=${removed.proposal_digest} reason="stale"`, 551),
    comment(`/orchard gate1 deny item=${kept.item_id} revision=1 digest=${kept.proposal_digest} reason="not a real gap"`, 552),
  ];
  const fetchImpl = async (url) => {
    const path = String(url);
    let payload = null;
    if (/\/issues\?state=open/.test(path)) payload = [issue];
    else if (/\/issues\/\d+\/comments/.test(path)) payload = comments;
    else if (/\/issues\/comments\/(\d+)$/.test(path)) payload = comments.find((entry) => path.endsWith(String(entry.id)));
    else if (/\/issues\/\d+$/.test(path)) payload = issue;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const events = [];
  const summary = await applyGateDecisions({
    store, track: 'track-1', repo: REPO, token: 't', fetchImpl,
    adapter: await pinnedAdapter(store), policy: POLICY,
    log: (_l, event, detail) => events.push([event, detail?.code ?? null]),
  });
  assert.equal(currentStateOf(store.db, kept.item_id), 'denied', 'the item the issue still offers is decided normally');
  assert.equal(currentStateOf(store.db, removed.item_id), 'gate1-pending',
    'a command for an item this issue no longer offers must change nothing');
  assert.ok(events.some(([event, code]) => event === 'gate.apply.refused' && code === 'binding.item'),
    'the refusal must be the binding refusal, named, not a silent skip');
  assert.equal(summary.applied, 1);
  store.close();
});

test('a stale-revision approval is still refused -- the reconciliation does not weaken the revision check', async () => {
  // The reworked-item case, all the way through. The item is at revision 2 in
  // the database; an issue still carries revision 1 in its manifest. Even a
  // bare `approve`, which is expanded from the issue's own manifest, must not
  // decide revision 2.
  const { store, runId } = await estate(['alpha'], { anchored: true });
  const held = pendingForGate(store.db, 'gate-1', 'track-1').map(({ track: _t, ...entry }) => entry);
  const [stale] = await generateGateManifests({ gate: 'gate-1', runId, track: 'track-1', items: held });
  store.db.prepare('UPDATE workflow_item SET current_revision = 2 WHERE item_id = ?').run(held[0].item_id);
  const issue = {
    number: 101, comments: 1, updated_at: '2026-09-12T23:00:00Z',
    body: [`<!-- orchard:gate track=track-1 gate=gate-1 batch=${heldSetDigest('gate-1', held)} -->`,
      '', '<details>', '', '```json', JSON.stringify(stale), '```', '', '</details>'].join('\n'),
  };
  const comments = [comment('approve', 553)];
  const fetchImpl = async (url) => {
    const path = String(url);
    let payload = null;
    if (/\/issues\?state=open/.test(path)) payload = [issue];
    else if (/\/issues\/\d+\/comments/.test(path)) payload = comments;
    else if (/\/issues\/comments\/(\d+)$/.test(path)) payload = comments.find((entry) => path.endsWith(String(entry.id)));
    else if (/\/issues\/\d+$/.test(path)) payload = issue;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const summary = await applyGateDecisions({
    store, track: 'track-1', repo: REPO, token: 't', fetchImpl,
    adapter: await pinnedAdapter(store), policy: POLICY, log: () => { },
  });
  assert.equal(summary.applied, 0, 'no decision may be recorded against a revision the issue never showed');
  assert.equal(currentStateOf(store.db, held[0].item_id), 'gate1-pending');
  store.close();
});

test.after(() => {
  for (const directory of temporaries) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
  }
});
