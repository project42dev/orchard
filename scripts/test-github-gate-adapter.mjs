#!/usr/bin/env node
// The adapter is the only thing allowed to say who approved something, so
// these tests are about what it refuses, not about the happy path alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterIdentity, fetchVerifiedEvent, manifestFromIssueBody } from './adapters/github-gate/adapter.mjs';
import { canonicalJson as adapterCanonical, sha256Digest as adapterDigest } from './adapters/github-gate/canonical.mjs';
import { canonicalJson, sha256Digest } from './lib/identity.mjs';
import { protectedAdapterDigest } from './lib/protected-adapter.mjs';
import { generateGateManifests } from './lib/gates.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

const ENV = { ORCHARD_GATE_GITHUB_TOKEN: 'token' };

async function fixture() {
    const itemId = generateUuidV7();
    const runId = generateUuidV7();
    const [manifest] = await generateGateManifests({
        gate: 'gate-1', runId, track: 'track-1',
        items: [{
            item_id: itemId, item_revision: 1, proposal_digest: `sha256:${'1'.repeat(64)}`,
            category: 'new-module', title: 'A proposal', rationale: 'Because the sources say so',
            evidence_refs: ['source-a:4'], score: { formula_version: '1.0.0', value: 30 },
            target: { repository: 'project42dev/project42-platform', path: 'content/modules/discovery/a.json' },
            risks: [], estimated_cost: { currency: 'USD', amount: 0.75 }, decision_state: 'pending',
        }],
    });
    const body = ['# issue', '', '<details>', '', '```json', JSON.stringify(manifest), '```', '', '</details>'].join('\n');
    return { itemId, runId, manifest, body };
}

function responder({ comment, issue }) {
    return async (url) => {
        const payload = url.includes('/issues/comments/') ? comment : issue;
        if (payload.__status) return { ok: false, status: payload.__status, text: async () => 'no' };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
}

function commentOn(itemId, overrides = {}) {
    return {
        id: 555,
        body: `/orchard gate1 approve item=${itemId} revision=1 digest=sha256:${'1'.repeat(64)}`,
        user: { id: 4242, login: 'countrycloudboy' },
        created_at: '2026-08-15T12:00:00Z',
        updated_at: '2026-08-15T12:00:00Z',
        issue_url: 'https://api.github.com/repos/project42dev/orchard/issues/9',
        ...overrides,
    };
}

const reference = { repository: 'project42dev/orchard', issue_number: 9, comment_id: 555, current_state: 'gate1-pending' };

test('the canonical digest copy has not drifted from lib/identity.mjs', () => {
    // The adapter cannot import lib, so canonical.mjs is a deliberate copy.
    // This is the check that stops the copy quietly disagreeing.
    for (const value of [
        {}, { a: 1, b: [1, 2, 3] }, { z: null, a: 'x' }, [1, 'two', { three: true }],
        { nested: { deep: { deeper: [1, { k: 'v' }] } } }, 'a plain string', { negativeZero: -0 },
    ]) {
        assert.equal(adapterCanonical(value), canonicalJson(value));
        assert.equal(adapterDigest(value), sha256Digest(value));
    }
});

test('the adapter artifact hashes, which is what the trust anchor pins', async () => {
    const digest = await protectedAdapterDigest('scripts/adapters/github-gate/adapter.mjs');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(await protectedAdapterDigest('scripts/adapters/github-gate/adapter.mjs'), digest, 'the digest must be stable');
    assert.equal(adapterIdentity, 'orchard.github-gate-adapter.v1');
});

test('a real comment yields the facts capture needs, and only provable ones', async () => {
    const { itemId, manifest, body } = await fixture();
    const event = await fetchVerifiedEvent(reference, {
        env: ENV, fetchImpl: responder({ comment: commentOn(itemId), issue: { number: 9, body } }),
    });
    assert.equal(event.actor.immutable_id, '4242', 'the actor is the immutable id, never the display name');
    assert.equal(event.action, 'created');
    assert.equal(event.edited, false);
    assert.equal(event.issue.manifest_digest, sha256Digest(manifest), 'the digest must be of the manifest ON the issue');
    assert.equal(event.issue.batch_digest, manifest.batch_digest);
    assert.equal(event.issue.idempotency_key, manifest.idempotency_key);
    assert.deepEqual(event.issue.target, manifest.items[0].target);
    assert.equal(event.current_state, 'gate1-pending');
});

test('an edited comment is reported as edited, which capture refuses', async () => {
    const { itemId, body } = await fixture();
    const event = await fetchVerifiedEvent(reference, {
        env: ENV,
        fetchImpl: responder({ comment: commentOn(itemId, { updated_at: '2026-08-15T13:00:00Z' }), issue: { number: 9, body } }),
    });
    assert.equal(event.edited, true);
    assert.equal(event.action, 'edited', 'the text on screen is not the text that was posted');
});

test('a bare approve comment synthesizes the exact per-item command for the item the caller names', async () => {
    const { itemId, manifest, body } = await fixture();
    const event = await fetchVerifiedEvent({ ...reference, expected_item_id: itemId }, {
        env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { body: 'approve' }), issue: { number: 9, body } }),
    });
    assert.equal(event.body, `/orchard gate1 approve item=${itemId} revision=1 digest=sha256:${'1'.repeat(64)}`);
    assert.equal(event.issue.manifest_digest, sha256Digest(manifest));
});

test('bare approve is case-insensitive and tolerates surrounding whitespace', async () => {
    const { itemId, body } = await fixture();
    for (const raw of ['Approve', 'APPROVED', '  approved  \n']) {
        const event = await fetchVerifiedEvent({ ...reference, expected_item_id: itemId }, {
            env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { body: raw }), issue: { number: 9, body } }),
        });
        assert.match(event.body, /^\/orchard gate1 approve item=/);
    }
});

test('a bare deny comment synthesizes an honest reason, since no human typed one', async () => {
    const { itemId, body } = await fixture();
    const event = await fetchVerifiedEvent({ ...reference, expected_item_id: itemId }, {
        env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { body: 'deny' }), issue: { number: 9, body } }),
    });
    assert.equal(event.body, `/orchard gate1 deny item=${itemId} revision=1 digest=sha256:${'1'.repeat(64)} reason="denied via whole-issue bare deny comment"`);
});

test('a bare decision without expected_item_id is refused, since the comment names nothing', async () => {
    const { itemId, body } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { body: 'approve' }), issue: { number: 9, body } }) }),
        /requires reference.expected_item_id/,
    );
});

test('a bare decision naming an item this issue does not offer is refused', async () => {
    const { itemId, body } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent({ ...reference, expected_item_id: generateUuidV7() }, {
            env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { body: 'approve' }), issue: { number: 9, body } }),
        }),
        /expected_item_id names an item this issue did not offer/,
    );
});

test('an edited bare approve comment is still reported as edited, which capture refuses', async () => {
    const { itemId, body } = await fixture();
    const event = await fetchVerifiedEvent({ ...reference, expected_item_id: itemId }, {
        env: ENV,
        fetchImpl: responder({ comment: commentOn(itemId, { body: 'approve', updated_at: '2026-08-16T13:00:00Z' }), issue: { number: 9, body } }),
    });
    assert.equal(event.edited, true);
    assert.equal(event.action, 'edited');
});

test('an issue with no machine-readable manifest can bind no decision', async () => {
    const { itemId } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: ENV, fetchImpl: responder({ comment: commentOn(itemId), issue: { number: 9, body: '# just prose' } }) }),
        /carries no machine-readable manifest/,
    );
});

test('a comment naming an item the issue never offered is refused', async () => {
    const { body } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: ENV, fetchImpl: responder({ comment: commentOn(generateUuidV7()), issue: { number: 9, body } }) }),
        /names an item this issue did not offer/,
    );
});

test('a comment belonging to another issue is refused', async () => {
    const { itemId, body } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent(reference, {
            env: ENV,
            fetchImpl: responder({
                comment: commentOn(itemId, { issue_url: 'https://api.github.com/repos/project42dev/orchard/issues/12' }),
                issue: { number: 9, body },
            }),
        }),
        /does not belong to the issue/,
    );
});

test('a comment with no immutable user id is refused', async () => {
    const { itemId, body } = await fixture();
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: ENV, fetchImpl: responder({ comment: commentOn(itemId, { user: { login: 'ghost' } }), issue: { number: 9, body } }) }),
        /no immutable GitHub user id/,
    );
});

test('a missing token stops the lookup rather than producing an unverified event', async () => {
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: {}, fetchImpl: async () => { throw new Error('must not call GitHub'); } }),
        /ORCHARD_GATE_GITHUB_TOKEN is not set/,
    );
});

test('a GitHub error surfaces its status and never the token', async () => {
    await assert.rejects(
        () => fetchVerifiedEvent(reference, { env: ENV, fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Bad credentials for token abcdef' }) }),
        (error) => error.message.includes('403') && !error.message.includes('abcdef'),
    );
});

test('the reference must identify exactly one comment on one issue', async () => {
    for (const bad of [
        { ...reference, repository: 'not-a-repo' },
        { ...reference, issue_number: 0 },
        { ...reference, comment_id: '' },
        { ...reference, current_state: '' },
    ]) {
        await assert.rejects(() => fetchVerifiedEvent(bad, { env: ENV, fetchImpl: async () => { throw new Error('must not call GitHub'); } }));
    }
});

test('manifestFromIssueBody reads the fence and nothing around it', () => {
    const manifest = { gate: 'gate-1', run_id: 'r', track: 'track-1', batch_digest: 'b', idempotency_key: 'k', items: [{ item_id: 'i' }] };
    assert.deepEqual(manifestFromIssueBody(`prose\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\`\nmore prose`), manifest);
    assert.throws(() => manifestFromIssueBody('```json\n{not json}\n```'), /not valid JSON/);
    assert.throws(() => manifestFromIssueBody('```json\n{"gate":"gate-1"}\n```'), /has no run_id/);
    assert.throws(() => manifestFromIssueBody(null), /issue body is not text/);
});
