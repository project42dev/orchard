#!/usr/bin/env node
// The round trip: a candidate is held, announced, commented on, and the
// comment changes the item's state. Everything runs on the migrated schema
// with a real trust anchor and the real pinned adapter, because the only
// interesting failures in this path are the ones a convenient fixture hides.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStateStore } from './lib/state-store.mjs';
import { persistDiscoveryItems, heldAtGate } from './lib/gate-queue.mjs';
import { generateGateManifests } from './lib/gates.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { protectedAdapterDigest } from './lib/protected-adapter.mjs';
import { adapterIdentity } from './adapters/github-gate/adapter.mjs';
import { applyGateDecisions, applyGateDecisionsForRun, currentStateOf, ensureGateTrustAnchor, fullManifestItemsFor } from './apply-gate-decisions.mjs';

const REPO = 'project42dev/orchard';
const OWNER_ID = 4242;
const ADAPTER = resolve('scripts/adapters/github-gate/adapter.mjs');
const DIGEST = `sha256:${'0'.repeat(64)}`;
const SHA = '0'.repeat(40);
const temporaries = [];

const POLICY = Object.freeze({
    schema_version: '1.0.0', provider: 'github', repository: REPO,
    authorized_actor_ids: [String(OWNER_ID)],
});

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
        subject, surface: 'learning', outcome: `teach ${subject}`, scope: 'content',
        title: `How to teach ${term}`, term, level: 'intermediate',
        demandOccurrences: 12, demandSourceCount: 3, evidence: ['a:4'],
        evidenceRefs: [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
        observedAt: '2026-08-15T00:00:00.000Z', sourceLabels: ['Example'],
        semanticIdentity: `sid:v1:${sha256Digest(term).slice(7)}`,
    };
}

/** A held item, an announced issue carrying its manifest, and a provisioned anchor. */
async function estate({ anchored = true } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-apply-'));
    temporaries.push(directory);
    const store = openStateStore(join(directory, 'state.db'));
    const runId = generateUuidV7();
    await store.recordRun(runManifest(runId));
    await persistDiscoveryItems({ store, runId, candidates: [candidate('prompt-injection')] });
    const held = heldAtGate(store.db, 'gate-1', 'track-1');
    const [manifest] = await generateGateManifests({
        gate: 'gate-1', runId, track: 'track-1', items: held.map(({ track: _t, ...entry }) => entry),
    });
    const body = [
        `<!-- orchard:gate track=track-1 gate=gate-1 batch=sha256:${'a'.repeat(64)} -->`,
        '', '<details>', '', '```json', JSON.stringify(manifest), '```', '', '</details>',
    ].join('\n');
    if (anchored) {
        store.provisionTrustAnchor({
            scope: 'gate', adapter_identity: adapterIdentity,
            adapter_digest: await protectedAdapterDigest(ADAPTER), adapter_path: ADAPTER,
            policy_digest: sha256Digest(POLICY), policy: POLICY,
            provisioned_at: '2026-08-15T00:00:00.000Z',
        });
    }
    return { store, runId, manifest, item: manifest.items[0], issue: { number: 9, body } };
}

function github({ issue, comments }) {
    return async (url) => {
        const path = String(url);
        let payload;
        if (/\/issues\?state=open/.test(path)) payload = [issue];
        else if (/\/issues\/\d+\/comments/.test(path)) payload = comments;
        else if (/\/issues\/comments\/\d+$/.test(path)) payload = comments.find((c) => path.endsWith(String(c.id)));
        else if (/\/issues\/\d+$/.test(path)) payload = issue;
        else payload = null;
        return { ok: true, status: 200, text: async () => JSON.stringify(payload ?? null) };
    };
}

function comment(body, overrides = {}) {
    return {
        id: 555, body, user: { id: OWNER_ID, login: 'countrycloudboy' },
        created_at: '2026-08-15T12:00:00Z', updated_at: '2026-08-15T12:00:00Z',
        issue_url: `https://api.github.com/repos/${REPO}/issues/9`,
        ...overrides,
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

test('a denial comment moves the item out of the gate', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=${item.proposal_digest} reason="not a real gap"`;
    const events = [];
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        log: (_l, event, detail) => events.push([event, detail]),
        fetchImpl: github({ issue, comments: [comment(body)] }),
        adapter: await pinnedAdapter(store), policy: POLICY,
    });
    assert.equal(summary.applied, 1, JSON.stringify(events));
    assert.equal(currentStateOf(store.db, item.item_id), 'denied');
    assert.equal(heldAtGate(store.db, 'gate-1').length, 0);
    const decided = events.find(([event]) => event === 'gate.apply.decided');
    assert.equal(decided[1].decision, 'deny');
    store.close();
});

test('a Gate 1 approval is validated, reported blocked, and changes nothing', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 approve item=${item.item_id} revision=1 digest=${item.proposal_digest}`;
    const events = [];
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        log: (_l, event, detail) => events.push([event, detail]),
        fetchImpl: github({ issue, comments: [comment(body)] }),
        adapter: await pinnedAdapter(store), policy: POLICY,
    });
    assert.equal(summary.blocked, 1);
    assert.equal(summary.applied, 0);
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-pending', 'a blocked approval must leave the item held');
    assert.ok(events.some(([event]) => event === 'gate.apply.approval-needs-ado'), 'the reason must be stated, not inferred');
    store.close();
});

test('a comment from anyone not on the allowlist is named and changes nothing', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=${item.proposal_digest} reason="nope"`;
    const events = [];
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        log: (_l, event, detail) => events.push([event, detail]),
        fetchImpl: github({ issue, comments: [comment(body, { user: { id: 999, login: 'stranger' } })] }),
        adapter: await pinnedAdapter(store), policy: POLICY,
    });
    assert.equal(summary.refused, 1);
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-pending');
    const refusal = events.find(([event]) => event === 'gate.apply.actor-unauthorised');
    assert.equal(refusal[1].actor, 'stranger', 'a decision that did not apply must be visible');
    store.close();
});

test('a stale digest is refused, so an approval stops applying when the proposal changes', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=sha256:${'9'.repeat(64)} reason="x"`;
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        fetchImpl: github({ issue, comments: [comment(body)] }),
        adapter: await pinnedAdapter(store), policy: POLICY,
    });
    assert.equal(summary.errors, 1);
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-pending');
    store.close();
});

test('re-reading the same issue on a later run is quiet, not a second decision', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=${item.proposal_digest} reason="not a real gap"`;
    const run = () => applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        fetchImpl: github({ issue, comments: [comment(body)] }),
        adapter: pinned, policy: POLICY,
    });
    const pinned = await pinnedAdapter(store);
    assert.equal((await run()).applied, 1);
    const second = await run();
    assert.equal(second.applied, 0);
    assert.equal(second.unchanged, 1, 'every later run re-reads the issue; that must not be an error');
    store.close();
});

test('an empty allowlist means nobody decides, never everybody', async () => {
    const { store, item, issue } = await estate();
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=${item.proposal_digest} reason="x"`;
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        fetchImpl: github({ issue, comments: [comment(body)] }),
        adapter: await pinnedAdapter(store), policy: { ...POLICY, authorized_actor_ids: [] },
    });
    assert.equal(summary.applied, 0);
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-pending');
    store.close();
});

test('without a trust anchor nothing is applied and the run is not failed', async () => {
    const { store } = await estate({ anchored: false });
    const events = [];
    const result = await applyGateDecisionsForRun({
        store, track: 'track-1', token: 't', env: { ORCHARD_GITHUB_REPO: REPO },
        log: (_l, event) => events.push(event),
        fetchImpl: async () => { throw new Error('must not call GitHub'); },
    });
    assert.equal(result, null);
    assert.deepEqual(events, ['gate.anchor.unconfigured', 'gate.apply.no-trust-anchor'],
        'the run must say both that it could not provision and that it therefore verified nothing');
    store.close();
});

test('no repository and no token each say so distinctly', async () => {
    const { store } = await estate();
    const first = [];
    assert.equal(await applyGateDecisionsForRun({ store, track: 'track-1', token: 't', env: {}, log: (_l, e) => first.push(e) }), null);
    assert.deepEqual(first, ['gate.apply.unconfigured']);
    const second = [];
    assert.equal(await applyGateDecisionsForRun({ store, track: 'track-1', env: { ORCHARD_GITHUB_REPO: REPO }, log: (_l, e) => second.push(e) }), null);
    assert.deepEqual(second, ['gate.apply.no-token']);
    store.close();
});

test('the release provisions the anchor once, and cannot be talked into a different one', async () => {
    const { store } = await estate({ anchored: false });
    const env = {
        ORCHARD_GITHUB_REPO: REPO,
        ORCHARD_GATE_ADAPTER_PATH: ADAPTER,
        ORCHARD_GATE_ADAPTER_DIGEST: await protectedAdapterDigest(ADAPTER),
        ORCHARD_GATE_ACTORS: String(OWNER_ID),
    };
    const events = [];
    const log = (_l, event) => events.push(event);

    const anchor = await ensureGateTrustAnchor({ store, log, env });
    assert.equal(anchor.adapter_identity, adapterIdentity);
    assert.deepEqual(anchor.policy.authorized_actor_ids, [String(OWNER_ID)]);
    assert.equal(events.at(-1), 'gate.anchor.provisioned');

    // A second release with a different actor list must not be able to replace
    // the authority to say who approved something.
    const second = await ensureGateTrustAnchor({ store, log, env: { ...env, ORCHARD_GATE_ACTORS: '777' } });
    assert.equal(second.policy.authorized_actor_ids[0], String(OWNER_ID), 'the anchor is immutable once set');
    store.close();
});

test('the anchor refuses an adapter the release did not bind, and logins in place of IDs', async () => {
    const { store } = await estate({ anchored: false });
    const base = {
        ORCHARD_GITHUB_REPO: REPO,
        ORCHARD_GATE_ADAPTER_PATH: ADAPTER,
        ORCHARD_GATE_ADAPTER_DIGEST: await protectedAdapterDigest(ADAPTER),
        ORCHARD_GATE_ACTORS: String(OWNER_ID),
    };
    for (const [env, expected] of [
        [{ ...base, ORCHARD_GATE_ADAPTER_DIGEST: `sha256:${'b'.repeat(64)}` }, 'gate.anchor.adapter-mismatch'],
        [{ ...base, ORCHARD_GATE_ACTORS: 'countrycloudboy' }, 'gate.anchor.actors-invalid'],
        [{ ...base, ORCHARD_GATE_ACTORS: '' }, 'gate.anchor.no-actors'],
        [{ ...base, ORCHARD_GATE_ADAPTER_PATH: '' }, 'gate.anchor.unconfigured'],
    ]) {
        const events = [];
        assert.equal(await ensureGateTrustAnchor({ store, log: (_l, e) => events.push(e), env }), null);
        assert.deepEqual(events, [expected]);
        assert.equal(store.getTrustAnchor('gate'), null, 'nothing may be written when the pin does not hold');
    }
    store.close();
});

test('a batch cannot be verified while a sibling batch issue is missing', () => {
    const manifest = { full_manifest_digest: 'f', batch: { total_item_count: 3 }, items: [{ item_id: 'a' }, { item_id: 'b' }] };
    assert.equal(fullManifestItemsFor(manifest, [manifest]), null);
    const sibling = { full_manifest_digest: 'f', batch: { total_item_count: 3 }, items: [{ item_id: 'c' }] };
    assert.deepEqual(fullManifestItemsFor(manifest, [manifest, sibling]).map((i) => i.item_id), ['a', 'b', 'c']);
});

test.after(() => {
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
});
