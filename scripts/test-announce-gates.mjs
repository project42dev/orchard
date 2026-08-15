#!/usr/bin/env node
// The gate announcement must be impossible to get wrong in the direction that
// matters: it may never fail a run, and it may never be silent about being
// unable to announce.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { announceGates, pendingForGate, renderGateIssue } from './announce-gates.mjs';
import { gateMarker } from './lib/github-issues.mjs';

function db(rows = []) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE work_item (id TEXT PRIMARY KEY, kind TEXT, subject_id TEXT, surface TEXT, title TEXT, state TEXT)');
  const insert = database.prepare('INSERT INTO work_item (id, kind, subject_id, surface, title, state) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, 'authoring', row.id, row.surface ?? 'learn', row.title ?? row.id, row.state);
  return database;
}

function recordingFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url, method: options?.method ?? 'GET' });
      const next = responses.shift() ?? { ok: true, status: 200, body: '[]' };
      return { ok: next.ok, status: next.status, text: async () => next.body };
    },
  };
}

test('a gate holding nothing is reported empty, not skipped in silence', async () => {
  const events = [];
  const results = await announceGates({
    db: db(), track: 'track-1', runId: 'r1', repo: 'o/r', token: 't',
    log: (_l, e) => events.push(e), fetchImpl: async () => { throw new Error('must not call GitHub'); },
  });
  assert.deepEqual(results.map((r) => r.action), ['empty', 'empty']);
  assert.deepEqual(events, ['gate.announce.empty', 'gate.announce.empty']);
});

test('both gates are announced, and only the ones holding work', async () => {
  const { impl, calls } = recordingFetch([
    { ok: true, status: 200, body: '[]' },
    { ok: true, status: 201, body: JSON.stringify({ number: 7, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: db([{ id: 'w1', state: 'gate1-pending' }, { id: 'w2', state: 'queued' }]),
    track: 'track-1', runId: 'r1', repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  assert.deepEqual(results.map((r) => [r.gate, r.action]), [['gate-1', 'created'], ['gate-2', 'empty']]);
  assert.equal(calls.at(-1).method, 'POST');
});

test('a second run updates the same issue instead of opening another', async () => {
  const marker = gateMarker({ track: 'track-1', gate: 'gate-1', runId: 'r1' });
  const { impl } = recordingFetch([
    { ok: true, status: 200, body: JSON.stringify([{ number: 7, body: `${marker}\nold` }]) },
    { ok: true, status: 200, body: JSON.stringify({ number: 7, html_url: 'u' }) },
  ]);
  const results = await announceGates({
    db: db([{ id: 'w1', state: 'gate1-pending' }]),
    track: 'track-1', runId: 'r1', repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  });
  assert.equal(results[0].action, 'updated');
  assert.equal(results[0].number, 7);
});

test('the body carries its marker and every held item', () => {
  const marker = gateMarker({ track: 'track-2', gate: 'gate-2', runId: 'r9' });
  const body = renderGateIssue({
    gate: 'gate-2', track: 'track-2', runId: 'r9', marker,
    items: [{ id: 'w1', surface: 'learn', title: 'A | piped title' }, { id: 'w2', surface: 'field-guide', title: 'B' }],
  });
  assert.ok(body.startsWith(marker), 'the marker must lead, it is how the issue is found again');
  assert.ok(body.includes('`w1`') && body.includes('`w2`'));
  assert.ok(body.includes('A \\| piped title'), 'a pipe in a title must not break the table');
  assert.ok(body.includes('/orchard gate2 approve'));
});

test('pendingForGate reads only the state it was asked for', () => {
  const database = db([
    { id: 'a', state: 'gate1-pending' }, { id: 'b', state: 'gate2-pending' }, { id: 'c', state: 'queued' },
  ]);
  assert.deepEqual(pendingForGate(database, 'gate1-pending').map((r) => r.id), ['a']);
  assert.deepEqual(pendingForGate(database, 'gate2-pending').map((r) => r.id), ['b']);
});

test('a GitHub failure propagates to the caller rather than being swallowed here', async () => {
  const { impl } = recordingFetch([{ ok: false, status: 503, body: 'down' }]);
  await assert.rejects(() => announceGates({
    db: db([{ id: 'w1', state: 'gate1-pending' }]),
    track: 'track-1', runId: 'r1', repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
  }), /503/);
});
