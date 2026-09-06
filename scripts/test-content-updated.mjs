#!/usr/bin/env node
// The trigger Orchard never sent.
//
// project42-platform's content-sync.yml has listened for
// `repository_dispatch: types: [content_updated]` -- commented "Vector 3:
// Webhook from Orchard" -- since it was written. Nothing in Orchard has ever
// sent it, and project42dev/project42-content has no workflows directory to
// send it from. So a currency correction could be approved, published and
// merged, and the live site would not change until the following Sunday's
// cron. These tests hold the trigger to the two things that matter: it fires
// when a merge actually happened, and it can never fail the run that did the
// work.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_UPDATED_EVENT, DEFAULT_CONTENT_CONSUMER_REPO, notifyContentUpdated } from './lib/content-updated.mjs';

function recorder(response) {
    const calls = [];
    return {
        calls,
        impl: async (url, options) => {
            calls.push({ url, options });
            if (response instanceof Error) throw response;
            return response;
        },
    };
}

const noContent = { status: 204, text: async () => '' };

test('a merge triggers the platform to rebuild, naming what moved', async () => {
    const { impl, calls } = recorder(noContent);
    const result = await notifyContentUpdated({
        token: 'tkn',
        items: ['01a024de-2211-71e3-8cbb-3faafa4b6470'],
        commits: ['a'.repeat(40), 'a'.repeat(40)],
        fetchImpl: impl,
    });
    assert.deepEqual(result, { sent: true, status: 204 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.github.com/repos/${DEFAULT_CONTENT_CONSUMER_REPO}/dispatches`,
        'the dispatch goes to the repository that consumes the content, not the one that holds it');
    assert.equal(calls[0].options.method, 'POST');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.event_type, CONTENT_UPDATED_EVENT, 'the event type must be the one content-sync.yml listens for');
    assert.deepEqual(body.client_payload.items, ['01a024de-2211-71e3-8cbb-3faafa4b6470']);
    assert.deepEqual(body.client_payload.commits, ['a'.repeat(40)], 'the same commit twice is one commit');
    assert.equal(body.client_payload.source, 'orchard');
});

test('a refusal is reported with its status and never thrown', async () => {
    for (const response of [
        { status: 403, text: async () => 'API rate limit exceeded' },
        { status: 404, text: async () => 'Not Found' },
        { status: 401, text: async () => 'Bad credentials' },
    ]) {
        const { impl } = recorder(response);
        const result = await notifyContentUpdated({ token: 'tkn', fetchImpl: impl });
        assert.equal(result.sent, false);
        assert.equal(result.status, response.status, 'the caller must be able to tell a rate limit from a refusal');
        assert.ok(result.reason.length > 0, 'and must be told what GitHub actually said');
    }
});

test('a network failure and a missing credential both hold, never throw', async () => {
    const { impl } = recorder(new Error('socket hang up'));
    const failed = await notifyContentUpdated({ token: 'tkn', fetchImpl: impl });
    assert.deepEqual(failed, { sent: false, reason: 'socket hang up' });

    const { impl: unused, calls } = recorder(noContent);
    const noCredential = await notifyContentUpdated({ token: null, fetchImpl: unused });
    assert.equal(noCredential.sent, false);
    assert.equal(calls.length, 0, 'no credential means no call, not a call that fails');
});

test('a repository that is not owner/name is refused before any call', async () => {
    const { impl, calls } = recorder(noContent);
    const result = await notifyContentUpdated({ repo: 'https://github.com/o/r', token: 'tkn', fetchImpl: impl });
    assert.equal(result.sent, false);
    assert.equal(calls.length, 0);
});
