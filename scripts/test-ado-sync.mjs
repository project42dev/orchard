#!/usr/bin/env node
// The tracker round trip on the migrated schema: an owner approval recorded
// through the real pinned adapter creates exactly one ADO work item, the
// external link carries the exact Gate 1 binding dispatch verifies, a re-run
// creates nothing, and the work item's state follows the item. Every fixture
// is built through openStateStore and the real gate queue; no test creates a
// table, because that is how the work_item defect survived once already.

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
import { applyGateDecisions, currentStateOf } from './apply-gate-decisions.mjs';
import { PARENT_EPIC_BY_TRACK } from './lib/ado-client.mjs';
import { ADO_STATE_MAP, runTrackerSyncForRun, syncCreate, syncUpdate, workItemDescription } from './ado-sync.mjs';

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

function github({ issue, comments, posted = [] }) {
    return async (url, init = {}) => {
        const path = String(url);
        if ((init.method ?? 'GET') === 'POST' && /\/issues\/\d+\/comments/.test(path)) {
            posted.push(JSON.parse(init.body));
            return { ok: true, status: 201, text: async () => JSON.stringify({ id: 777, html_url: 'https://github.invalid/c/777' }) };
        }
        let payload;
        if (/\/issues\?state=open/.test(path)) payload = [issue];
        else if (/\/issues\/\d+\/comments/.test(path)) payload = comments;
        else if (/\/issues\/comments\/\d+$/.test(path)) payload = comments.find((c) => path.endsWith(String(c.id)));
        else if (/\/issues\/\d+$/.test(path)) payload = issue;
        else payload = null;
        return { ok: true, status: 200, text: async () => JSON.stringify(payload ?? null) };
    };
}

function comment(body) {
    return {
        id: 555, body, user: { id: OWNER_ID, login: 'countrycloudboy' },
        created_at: '2026-08-15T12:00:00Z', updated_at: '2026-08-15T12:00:00Z',
        issue_url: `https://api.github.com/repos/${REPO}/issues/9`,
    };
}

/** A fake ADO client that records every call and never talks to a network. */
function fakeAdoClient({ nextId = 8801, failCreate = false } = {}) {
    const calls = { created: [], states: [], comments: [], reads: [] };
    const items = new Map();
    return {
        calls,
        items,
        async createWorkItem(request) {
            if (failCreate) { const error = new Error('ADO POST refused'); error.status = 503; throw error; }
            const id = nextId + calls.created.length;
            calls.created.push({ id, ...request });
            items.set(id, { id, state: 'New', title: request.title });
            return { id, url: `https://dev.azure.com/test/_workitems/edit/${id}` };
        },
        async getWorkItem(id) {
            calls.reads.push(Number(id));
            const item = items.get(Number(id));
            if (!item) { const error = new Error('work item does not exist'); error.status = 404; throw error; }
            return { ...item };
        },
        async updateWorkItemState(id, state) {
            calls.states.push({ id: Number(id), state });
            items.get(Number(id)).state = state;
            return state;
        },
        async addComment(id, text) {
            calls.comments.push({ id: Number(id), text });
            return { id: calls.comments.length };
        },
    };
}

/** One item taken all the way to a recorded Gate 1 approval, then the store closed. */
async function approvedEstate() {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-ado-sync-'));
    temporaries.push(directory);
    const dbPath = join(directory, 'state.db');
    const store = openStateStore(dbPath);
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
    store.provisionTrustAnchor({
        scope: 'gate', adapter_identity: adapterIdentity,
        adapter_digest: await protectedAdapterDigest(ADAPTER), adapter_path: ADAPTER,
        policy_digest: sha256Digest(POLICY), policy: POLICY,
        provisioned_at: '2026-08-15T00:00:00.000Z',
    });
    const item = manifest.items[0];
    const issue = { number: 9, body };
    const anchor = store.getTrustAnchor('gate');
    const module = await import('./adapters/github-gate/adapter.mjs');
    const adapter = {
        fetchVerifiedEvent: module.fetchVerifiedEvent,
        adapterIdentity: anchor.adapter_identity,
        adapterDigest: anchor.adapter_digest,
        policyDigest: anchor.policy_digest,
    };
    const approval = `/orchard gate1 approve item=${item.item_id} revision=1 digest=${item.proposal_digest}`;
    const summary = await applyGateDecisions({
        store, track: 'track-1', repo: REPO, token: 't',
        fetchImpl: github({ issue, comments: [comment(approval)] }),
        adapter, policy: POLICY,
    });
    assert.equal(summary.applied, 1, 'the estate requires a recorded approval');
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-approved');
    store.close();
    return { dbPath, item, issue };
}

test('an approval creates one work item, links both sides, and lands the item at ado-linked', async () => {
    const { dbPath, item } = await approvedEstate();
    const client = fakeAdoClient();
    const posted = [];
    const result = await syncCreate({
        dbPath, client, apply: true, githubToken: 'gh-token',
        fetchImpl: github({ issue: { number: 9, body: '' }, comments: [], posted }),
        log: () => { },
    });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 0);

    const [created] = client.calls.created;
    assert.equal(created.type, 'User Story');
    assert.match(created.title, /^\[Orchard\] /);
    assert.equal(created.parentId, PARENT_EPIC_BY_TRACK['track-1'], 'a discovery item parents under the learning delivery Epic');
    for (const required of ['Score', 'Semantic identity', 'track-1', item.item_id, 'issues/9', 'issuecomment-555']) {
        assert.ok(created.description.includes(required), `the description must carry ${required}`);
    }

    const store = openStateStore(dbPath);
    assert.equal(currentStateOf(store.db, item.item_id), 'ado-linked');
    const [link] = store.findExternalLinks(item.item_id, 1);
    assert.equal(link.provider, 'ado');
    assert.equal(Number(link.external_id), created.id);
    assert.equal(link.binding.proposal_digest, item.proposal_digest);
    assert.equal(link.binding.target.repository, item.target.repository);

    // The link the tracker wrote is the exact binding dispatch verifies.
    const binding = store.getDispatchBinding({
        gate1_decision_event_id: link.binding.gate1_decision_event_id,
        queue_work_item_id: created.id,
    });
    assert.equal(binding.ado_work_item_id, created.id);
    assert.equal(binding.item_id, item.item_id);

    // And the gate issue was told, so both sides link.
    assert.equal(posted.length, 1);
    assert.ok(posted[0].body.includes(`AB#${created.id}`), 'the issue comment must carry the ADO id');
    store.close();
});

test('a re-run creates no second work item for the same Orchard item', async () => {
    const { dbPath } = await approvedEstate();
    const client = fakeAdoClient();
    const first = await syncCreate({ dbPath, client, apply: true, log: () => { } });
    assert.equal(first.created, 1);
    const second = await syncCreate({ dbPath, client, apply: true, log: () => { } });
    assert.equal(second.created, 0, 'the external_link row is the duplicate guard');
    assert.equal(client.calls.created.length, 1);
});

test('ado-linked cannot be reached without a persisted ADO link', async () => {
    const { dbPath, item } = await approvedEstate();
    const store = openStateStore(dbPath);
    await assert.rejects(
        store.recordTransition({
            schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: generateUuidV7(),
            item_id: item.item_id, item_revision: 1,
            from_state: 'gate1-approved', to_state: 'ado-linked', cause: 'ado-reconciled',
            actor: 'test', occurred_at: new Date().toISOString(), correlation_id: generateUuidV7(),
        }),
        /persisted ADO external link/,
        'the external_link demand moved onto ado-linked and must hold there',
    );
    store.close();
});

test('the work item state follows the item, and an unchanged state writes nothing', async () => {
    const { dbPath, item } = await approvedEstate();
    const client = fakeAdoClient();
    await syncCreate({ dbPath, client, apply: true, log: () => { } });
    const adoId = client.calls.created[0].id;

    // ado-linked maps to New, which is where the fake starts: nothing to do.
    const idle = await syncUpdate({ dbPath, client, apply: true, log: () => { } });
    assert.equal(idle.updated, 0);
    assert.equal(idle.unchanged, 1);
    assert.equal(client.calls.states.length, 0, 'an aligned board is not rewritten');

    // The item starts executing; the story must move to Active with a comment.
    const store = openStateStore(dbPath);
    const [link] = store.findExternalLinks(item.item_id, 1);
    await store.recordTransition({
        schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: link.run_id,
        item_id: item.item_id, item_revision: 1,
        from_state: 'ado-linked', to_state: 'executing', cause: 'execution-started',
        actor: 'test', occurred_at: new Date().toISOString(), correlation_id: generateUuidV7(),
    });
    store.close();
    const moved = await syncUpdate({ dbPath, client, apply: true, log: () => { } });
    assert.equal(moved.updated, 1);
    assert.deepEqual(client.calls.states, [{ id: adoId, state: 'Active' }]);
    assert.equal(client.calls.comments.length, 1, 'a real move explains itself');
});

test('every lifecycle state that can follow a link has an ADO mapping', () => {
    // Part 3's table: started, awaiting review, approved, rework, published,
    // closed, failed and denied must all reflect on the board.
    for (const state of ['executing', 'gate2-ready', 'gate2-pending', 'gate2-approved',
        'changes-requested', 'blocked', 'published', 'ado-closure-ready', 'closed', 'denied', 'superseded']) {
        assert.ok(ADO_STATE_MAP[state], `${state} must map to an ADO state`);
    }
});

test('a tracker failure never fails the run', async () => {
    const { dbPath, item } = await approvedEstate();
    const failing = fakeAdoClient({ failCreate: true });
    const result = await syncCreate({ dbPath, client: failing, apply: true, log: () => { } });
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1, 'the failure is counted, not thrown');
    const store = openStateStore(dbPath);
    assert.equal(currentStateOf(store.db, item.item_id), 'gate1-approved', 'the item stays approved for the next run to retry');
    store.close();

    // And the runtime entry point cannot throw even when everything is down.
    const broken = {
        async createWorkItem() { throw new Error('network is a lie'); },
        async getWorkItem() { throw new Error('network is a lie'); },
        async updateWorkItemState() { throw new Error('network is a lie'); },
        async addComment() { throw new Error('network is a lie'); },
    };
    const events = [];
    const outcome = await runTrackerSyncForRun({
        stateDbPath: dbPath, client: broken,
        log: (_l, event) => events.push(event),
    });
    assert.notEqual(outcome, undefined, 'the entry point returns rather than throwing');
    assert.ok(events.includes('tracker.sync.finished') || events.includes('tracker.sync.failed'),
        'the outcome is logged either way');
});

test('the tracker can be disabled by configuration, and says so', async () => {
    const events = [];
    const outcome = await runTrackerSyncForRun({
        stateDbPath: 'unused', env: { ORCHARD_ADO_SYNC: 'disabled' },
        log: (_l, event) => events.push(event),
    });
    assert.equal(outcome, null);
    assert.deepEqual(events, ['tracker.sync.disabled']);
});

test('the description stands alone on the board', () => {
    const row = {
        item_id: 'fd1f7f7e-0000-7000-8000-000000000000', current_revision: 1,
        track: 'track-1', surface: 'learning', outcome: 'new-module',
        semantic_identity: 'sid:v1:abc', created_at: '2026-08-15T00:00:00.000Z',
    };
    const detail = {
        title: 'How to teach prompt-injection',
        rationale: '3 of the surveyed approved sources discuss it.',
        score: { formula_version: 'track1-demand-1.0.0', value: 36 },
        evidence_refs: ['https://example.invalid/a'],
        target: { repository: 'project42dev/project42-platform', path: 'content/modules/discovery/x.json' },
    };
    const decision = { source_repository: REPO, source_issue_number: 9, source_comment_id: '555' };
    const description = workItemDescription(row, detail, decision);
    for (const required of ['How to teach prompt-injection', '36', 'track1-demand-1.0.0',
        row.item_id, 'sid:v1:abc', 'track-1', 'https://example.invalid/a',
        `https://github.com/${REPO}/issues/9`, 'issuecomment-555']) {
        assert.ok(description.includes(String(required)), `description must carry ${required}`);
    }
});

test.after(() => {
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
});
