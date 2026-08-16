#!/usr/bin/env node
// The publication adapter is the only thing in Orchard allowed to open a
// branch, a pull request, or a merge against the content repository's
// protected main. These tests are about what it refuses as much as what it
// does: a commit without the prepared-tree trailer must never become a
// branch, a merge whose head or base drifted since approval must never
// complete, and a replayed write must reconcile rather than repeat.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    adapterIdentity, createAdapter, GitHubPublicationAdapter, PublicationProviderError,
} from './adapters/github-publication/adapter.mjs';
import { protectedAdapterDigest } from './lib/protected-adapter.mjs';

const TRAILER = 'Orchard-Prepared-Tree-Digest';
const digestOf = (label) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const TREE_DIGEST = digestOf('prepared-tree');
const REPO = 'project42dev/project42-platform';

test('the adapter artifact is self-contained: its protected digest resolves and is stable', async () => {
    const digest = await protectedAdapterDigest('scripts/adapters/github-publication/adapter.mjs');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(await protectedAdapterDigest('scripts/adapters/github-publication/adapter.mjs'), digest, 'the digest must be stable');
});

test('createAdapter refuses to construct without ORCHARD_PUBLICATION_GITHUB_TOKEN', async () => {
    await assert.rejects(
        () => createAdapter({ env: {} }),
        (error) => { assert.equal(error.code, 'provider.token'); return true; },
    );
});

test('createAdapter builds a working adapter once a token is present', async () => {
    const adapter = await createAdapter({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 'ghs_fake' }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' }) });
    assert.equal(adapterIdentity, 'orchard.github-publication-adapter.v1');
    assert.equal(typeof adapter.reconcileBeforeCreateBranch, 'function');
});

// A minimal fake client for exercising the reconciliation engine in
// isolation from the real GitHub REST mapping, matching the same
// fake-client-under-a-real-adapter shape scripts/adapters/fake-github-adapter.mjs
// uses for the gate/issue side of publication.
function fakeClient(overrides = {}) {
    const calls = [];
    return {
        calls,
        queryBranch: overrides.queryBranch ?? (async () => null),
        createBranch: overrides.createBranch ?? (async (input) => { calls.push(['createBranch', input]); return { repository: input.repository, name: input.branch, commit: input.commit, preparedTreeDigest: input.preparedTreeDigest }; }),
        queryPullRequestsByExternalKey: overrides.queryPullRequestsByExternalKey ?? (async () => []),
        createPullRequest: overrides.createPullRequest ?? (async (input) => { calls.push(['createPullRequest', input]); return { number: 1, repository: input.repository, ...input }; }),
        queryPullRequest: overrides.queryPullRequest ?? (async () => null),
        mergePullRequest: overrides.mergePullRequest ?? (async (input) => { calls.push(['mergePullRequest', input]); return { number: input.pullNumber, state: 'merged', mergeCommit: COMMIT_B }; }),
        queryProtectedBranch: overrides.queryProtectedBranch ?? (async () => null),
    };
}

test('reconcileBeforeCreateBranch creates when absent and returns an exact object', async () => {
    const client = fakeClient();
    const adapter = new GitHubPublicationAdapter({ client });
    const expected = { repository: REPO, name: 'orchard/publication/track-1/x/r1-abc', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST };
    const result = await adapter.reconcileBeforeCreateBranch({
        repository: REPO, branch: expected.name, expected, create: { commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST },
    });
    assert.equal(result.operation, 'created');
    assert.deepEqual(result.object, expected);
    assert.equal(client.calls.length, 1);
});

test('reconcileBeforeCreateBranch reconciles without writing when the branch is already exact', async () => {
    const expected = { repository: REPO, name: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST };
    const client = fakeClient({ queryBranch: async () => ({ ...expected }) });
    const adapter = new GitHubPublicationAdapter({ client });
    const result = await adapter.reconcileBeforeCreateBranch({ repository: REPO, branch: 'b', expected, create: { commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST } });
    assert.equal(result.operation, 'reconciled');
    assert.equal(client.calls.length, 0, 'an already-exact branch must never be written again');
});

test('a branch that does not match what Orchard expects fails closed with a named field', async () => {
    const expected = { repository: REPO, name: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST };
    const client = fakeClient({ queryBranch: async () => ({ ...expected, commit: COMMIT_B }) });
    const adapter = new GitHubPublicationAdapter({ client });
    await assert.rejects(
        () => adapter.reconcileBeforeCreateBranch({ repository: REPO, branch: 'b', expected, create: { commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST } }),
        (error) => { assert.ok(error instanceof PublicationProviderError); assert.match(error.message, /commit: expected/); return true; },
    );
});

test('a write that times out is reconciled on retry rather than repeated', async () => {
    let queries = 0;
    const expected = { repository: REPO, name: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST };
    const client = fakeClient({
        queryBranch: async () => { queries += 1; return queries === 1 ? null : { ...expected }; },
        createBranch: async () => { const error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error; },
    });
    const adapter = new GitHubPublicationAdapter({ client });
    const result = await adapter.reconcileBeforeCreateBranch({ repository: REPO, branch: 'b', expected, create: { commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST } });
    assert.equal(result.operation, 'reconciled-after-unknown');
    assert.equal(queries, 2);
});

test('reconcileBeforeMerge refuses a merge that does not target protected main', async () => {
    const adapter = new GitHubPublicationAdapter({ client: fakeClient() });
    await assert.rejects(
        () => adapter.reconcileBeforeMerge({
            repository: REPO, externalKey: 'k', pullNumber: 1, expected: {},
            merge: { baseBranch: 'not-main', headBranch: 'b', expectedHeadCommit: COMMIT_A, expectedBaseCommit: COMMIT_B },
        }),
        (error) => { assert.equal(error.code, 'reference.base'); return true; },
    );
});

test('reconcilePullRequest refuses a base branch other than main', async () => {
    const adapter = new GitHubPublicationAdapter({ client: fakeClient() });
    await assert.rejects(
        () => adapter.reconcilePullRequest({ repository: REPO, externalKey: 'k', expected: { baseBranch: 'not-main' } }),
        (error) => { assert.equal(error.code, 'reference.base'); return true; },
    );
});

test('more than one open pull request for the same externalKey is refused as ambiguous, never picked from', async () => {
    const client = fakeClient({ queryPullRequestsByExternalKey: async () => [{ number: 1 }, { number: 2 }] });
    const adapter = new GitHubPublicationAdapter({ client });
    await assert.rejects(
        () => adapter.reconcilePullRequest({ repository: REPO, externalKey: 'k', expected: { baseBranch: 'main' } }),
        (error) => { assert.equal(error.code, 'provider.ambiguous'); return true; },
    );
});

// The real fetch-based client: exercised directly, without the reconciliation
// engine wrapped around it, against exactly the shapes GitHub's REST API
// returns.
async function importClientTestHooks() {
    const module = await import('./adapters/github-publication/adapter.mjs');
    return module;
}

function fetchRouter(routes) {
    return async (url, options = {}) => {
        const method = options.method ?? 'GET';
        const key = `${method} ${url.replace('https://api.github.com', '')}`;
        for (const [pattern, handler] of routes) {
            const match = typeof pattern === 'string' ? key === pattern : pattern.test(key);
            if (match) return handler(url, options);
        }
        throw new Error(`no fake route for ${key}`);
    };
}
function ok(body) { return { ok: true, status: 200, text: async () => JSON.stringify(body) }; }
function notFound() { return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) }; }

test('createBranch refuses a commit whose trailer does not match the digest it was told to publish', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    const fetchImpl = fetchRouter([
        [`GET /repos/${REPO}/git/commits/${COMMIT_A}`, () => ok({ message: `Prepare content\n\n${TRAILER}: ${digestOf('a different tree')}` })],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    await assert.rejects(
        () => adapter.client.createBranch({ repository: REPO, branch: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST }),
        (error) => { assert.equal(error.code, 'provider.trailer-mismatch'); return true; },
    );
});

test('createBranch publishes once the commit trailer matches exactly', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    let refCreated = null;
    const fetchImpl = fetchRouter([
        [`GET /repos/${REPO}/git/commits/${COMMIT_A}`, () => ok({ message: `Prepare content\n\n${TRAILER}: ${TREE_DIGEST}` })],
        [`POST /repos/${REPO}/git/refs`, (url, options) => { refCreated = JSON.parse(options.body); return ok({ ref: `refs/heads/b`, object: { sha: COMMIT_A } }); }],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    const result = await adapter.client.createBranch({ repository: REPO, branch: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST });
    assert.deepEqual(result, { repository: REPO, name: 'b', commit: COMMIT_A, preparedTreeDigest: TREE_DIGEST });
    assert.deepEqual(refCreated, { ref: 'refs/heads/b', sha: COMMIT_A });
});

test('queryBranch returns null on a branch that does not exist yet', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    const fetchImpl = fetchRouter([[/GET \/repos\/.*\/git\/ref\/heads\/b/, notFound]]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    assert.equal(await adapter.client.queryBranch({ repository: REPO, branch: 'b' }), null);
});

test('mergePullRequest refuses when the pull request head commit drifted since approval', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    const fetchImpl = fetchRouter([
        [`GET /repos/${REPO}/pulls/7`, () => ok({ number: 7, head: { sha: COMMIT_B }, base: { sha: COMMIT_A } })],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    await assert.rejects(
        () => adapter.client.mergePullRequest({ repository: REPO, pullNumber: 7, expectedHeadCommit: COMMIT_A, expectedBaseCommit: COMMIT_A }),
        (error) => { assert.equal(error.code, 'provider.merge-head-drift'); return true; },
    );
});

test('mergePullRequest refuses when the pull request base commit drifted since approval', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    const fetchImpl = fetchRouter([
        [`GET /repos/${REPO}/pulls/7`, () => ok({ number: 7, head: { sha: COMMIT_A }, base: { sha: COMMIT_B } })],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    await assert.rejects(
        () => adapter.client.mergePullRequest({ repository: REPO, pullNumber: 7, expectedHeadCommit: COMMIT_A, expectedBaseCommit: COMMIT_A }),
        (error) => { assert.equal(error.code, 'provider.merge-base-drift'); return true; },
    );
});

test('mergePullRequest merges when head and base exactly match what was approved', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    let mergeRequest = null;
    const fetchImpl = fetchRouter([
        [`GET /repos/${REPO}/pulls/7`, () => ok({ number: 7, head: { sha: COMMIT_A }, base: { sha: COMMIT_B }, body: JSON.stringify({}) })],
        [`PUT /repos/${REPO}/pulls/7/merge`, (url, options) => { mergeRequest = JSON.parse(options.body); return ok({ merged: true, sha: 'c'.repeat(40) }); }],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    const result = await adapter.client.mergePullRequest({ repository: REPO, pullNumber: 7, expectedHeadCommit: COMMIT_A, expectedBaseCommit: COMMIT_B });
    assert.equal(result.state, 'merged');
    assert.equal(mergeRequest.sha, COMMIT_A);
});

test('queryPullRequestsByExternalKey only matches a pull request whose own body names the exact idempotency key', async () => {
    const { createAdapter: build } = await importClientTestHooks();
    const fetchImpl = fetchRouter([
        [/GET \/repos\/.*\/pulls\?head=/, () => ok([
            { number: 1, head: { ref: 'b' }, base: { ref: 'main' }, state: 'open', title: 't', body: JSON.stringify({ publication_idempotency_key: 'other-key' }) },
            { number: 2, head: { ref: 'b' }, base: { ref: 'main' }, state: 'open', title: 't', body: JSON.stringify({ publication_idempotency_key: 'k', base_commit: COMMIT_A, prepared_tree_digest: TREE_DIGEST }) },
        ])],
    ]);
    const adapter = await build({ env: { ORCHARD_PUBLICATION_GITHUB_TOKEN: 't' }, fetchImpl });
    const matches = await adapter.client.queryPullRequestsByExternalKey({ repository: REPO, externalKey: 'k', headBranch: 'b' });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].number, 2);
    assert.equal(matches[0].preparedTreeDigest, TREE_DIGEST);
});
