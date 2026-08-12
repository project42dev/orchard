import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GitHubAdapter, AmbiguousExternalStateError, ExternalStateMismatchError, UnknownExternalOutcomeError } from '../scripts/adapters/github-adapter.mjs';
import { AdoAdapter } from '../scripts/adapters/ado-adapter.mjs';
import { FakeGitHubAdapter, FakeGitHubClient } from '../scripts/adapters/fake-github-adapter.mjs';
import { FakeAdoAdapter } from '../scripts/adapters/fake-ado-adapter.mjs';
import { classifyExternalState } from '../scripts/reconcile-external-state.mjs';

const githubRequest = {
  repository: 'project42dev/orchard', externalKey: 'github:gate-1:key',
  expected: { repository: 'project42dev/orchard', externalKey: 'github:gate-1:key', title: 'Gate', body: 'Exact', labels: ['gate'] },
  create: { title: 'Gate', body: 'Exact', labels: ['gate'] }
};
const adoExpected = { externalKey: 'orchard:track-1:item:r1', title: 'Story', type: 'User Story', state: 'New' };
const adoRequest = { externalKey: adoExpected.externalKey, expected: adoExpected, create: { fields: adoExpected }, organization: 'org', project: 'project' };

test('GitHub timeout after create reconciles without a duplicate create', async () => {
  const adapter = new FakeGitHubAdapter({ scenarios: [{ operation: 'create', type: 'timeout-after' }] });
  const result = await adapter.reconcileBeforeCreate(githubRequest);
  assert.equal(result.operation, 'reconciled-after-unknown');
  assert.equal(adapter.fakeClient.issues.length, 1);
  assert.equal(adapter.fakeClient.calls.filter((call) => call.operation === 'create').length, 1);
});

test('ADO timeout after create reconciles and returns a positive ID', async () => {
  const adapter = new FakeAdoAdapter({ scenarios: [{ operation: 'create', type: 'timeout-after' }] });
  const result = await adapter.reconcileBeforeCreate(adoRequest);
  assert.equal(result.operation, 'reconciled-after-unknown');
  assert.ok(result.object.id > 0);
  assert.equal(adapter.fakeClient.workItems.length, 1);
});

test('duplicates and exact mismatches fail closed before creation', async () => {
  const issue = { number: 1, ...githubRequest.expected };
  const duplicate = new FakeGitHubAdapter({ issues: [issue, { ...issue, number: 2 }] });
  await assert.rejects(duplicate.reconcileBeforeCreate(githubRequest), AmbiguousExternalStateError);
  assert.equal(duplicate.fakeClient.calls.some((call) => call.operation === 'create'), false);

  const mismatch = new FakeAdoAdapter({ workItems: [{ id: 5001, ...adoExpected, title: 'Wrong' }] });
  await assert.rejects(mismatch.reconcileBeforeCreate(adoRequest), ExternalStateMismatchError);
  assert.equal(mismatch.fakeClient.calls.some((call) => call.operation === 'create'), false);
});

test('bounded retries stop with unknown outcome', async () => {
  const adapter = new FakeGitHubAdapter({
    maxRetries: 1, scenarios: [
      { operation: 'create', type: 'timeout-before' }, { operation: 'create', type: 'timeout-before' },
    ]
  });
  await assert.rejects(adapter.reconcileBeforeCreate(githubRequest), UnknownExternalOutcomeError);
  assert.equal(adapter.fakeClient.calls.filter((call) => call.operation === 'create').length, 2);
});

test('unknown update outcome reconciles and already-updated objects do not write again', async () => {
  const current = { number: 1, ...githubRequest.expected };
  const updated = { ...githubRequest.expected, body: 'Updated' };
  const client = new FakeGitHubClient({ issues: [current], scenarios: [{ operation: 'update', type: 'timeout-after' }] });
  const adapter = new GitHubAdapter({ client });
  const first = await adapter.reconcileBeforeUpdate({
    repository: current.repository, externalKey: current.externalKey,
    expectedCurrent: githubRequest.expected, expectedUpdated: updated, update: { patch: { body: 'Updated' } }
  });
  assert.equal(first.operation, 'reconciled-after-unknown');
  const second = await adapter.reconcileBeforeUpdate({
    repository: current.repository, externalKey: current.externalKey,
    expectedCurrent: githubRequest.expected, expectedUpdated: updated, update: { patch: { body: 'Updated' } }
  });
  assert.equal(second.operation, 'already-updated');
  assert.equal(client.calls.filter((call) => call.operation === 'update').length, 1);
});

test('command runners receive structured executable, arguments, and input', async () => {
  const calls = [];
  const runner = async (request) => { calls.push(request); return []; };
  const github = new GitHubAdapter({ commandRunner: runner });
  const ado = new AdoAdapter({ commandRunner: runner });
  await github.queryByExternalKey(githubRequest);
  await ado.queryByExternalKey(adoRequest);
  assert.deepEqual(calls.map(({ executable, arguments: args }) => [executable, args]), [
    ['gh', ['issue', 'list']], ['az', ['boards', 'query']],
  ]);
  assert.ok(calls.every((call) => typeof call.input === 'object'));
});

test('external state classifier reports absent, duplicate, mismatch, and unknown exactly', async () => {
  const absent = await classifyExternalState({ provider: 'github', adapter: new FakeGitHubAdapter(), request: githubRequest });
  assert.equal(absent.classification, 'absent');
  const issue = { number: 1, ...githubRequest.expected };
  const duplicate = await classifyExternalState({ provider: 'github', adapter: new FakeGitHubAdapter({ issues: [issue, { ...issue, number: 2 }] }), request: githubRequest });
  assert.equal(duplicate.classification, 'duplicate');
  const mismatch = await classifyExternalState({ provider: 'github', adapter: new FakeGitHubAdapter({ issues: [{ ...issue, title: 'Wrong' }] }), request: githubRequest });
  assert.equal(mismatch.classification, 'mismatch');
  const unknown = await classifyExternalState({ provider: 'github', adapter: new FakeGitHubAdapter({ scenarios: [{ operation: 'query', type: 'timeout' }] }), request: githubRequest });
  assert.equal(unknown.classification, 'unknown');
});

test('adapter and CLI imports have no external side effects', async () => {
  const modules = ['../scripts/adapters/github-adapter.mjs', '../scripts/adapters/ado-adapter.mjs', '../scripts/notify-review-ready.mjs', '../scripts/ado-sync.mjs'];
  for (const module of modules) await import(`${pathToFileURL(resolve('tests', module)).href}?test=${Math.random()}`);
});
