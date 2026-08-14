import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGateManifests } from '../scripts/lib/gates.mjs';
import { openStateStore, IdempotencyConflictError } from '../scripts/lib/state-store.mjs';
import { FakeGitHubAdapter } from '../scripts/adapters/fake-github-adapter.mjs';
import { AmbiguousExternalStateError, ExternalStateMismatchError } from '../scripts/adapters/github-adapter.mjs';
import {
  acknowledgePublication, publicationBranchName, publicationIdempotencyKey,
  publishApprovedItem, validateGate2PublicationAuthority,
} from '../scripts/lib/publication.mjs';
import { sha256Digest } from '../scripts/lib/identity.mjs';

const runId = '018f0d20-7b9a-7cc3-8a5d-112233445566';
const itemId = '018f0d20-7b9b-7cc3-8a5d-112233445566';
const decisionId = '018f0d20-7b9c-7cc3-8a5d-112233445566';
const transactionId = '018f0d20-7b9d-7cc3-8a5d-112233445566';
const digest = (character) => `sha256:${character.repeat(64)}`;
const baseCommit = 'a'.repeat(40);
const preparedCommit = 'b'.repeat(40);
const target = { repository: 'project42dev/project42-platform', path: 'content/item.md' };
const gatePolicy = { provider: 'github', repository: 'project42dev/orchard', authorized_actor_ids: ['123'] };
const gateTrust = {
  authorization_policy_digest: sha256Digest(gatePolicy), adapter_digest: digest('8'),
  adapter_identity: 'test:protected-github-adapter:v1'
};
const publicationTrust = {
  adapter_identity: 'test:protected-publication-adapter:v1', adapter_digest: digest('6')
};

async function fixture(overrides = {}) {
  const item = {
    item_id: itemId, item_revision: 1, artifact_digest: digest('c'), proposal_digest: digest('d'),
    displayed_diff_digest: digest('e'), prepared_tree_digest: digest('f'), target, base_commit: baseCommit,
    diff_ref: 'evidence/diff', artifact_ref: 'evidence/artifact',
    ado_external_key: `orchard:track-1:${itemId}:r1`, handoff_chain_digest: digest('1'),
    tests: [{ name: 'unit', status: 'passed', evidence_ref: 'evidence/test' }],
    factual_review: { status: 'passed', evidence_ref: 'evidence/factual' },
    accessibility_review: { status: 'passed', evidence_ref: 'evidence/a11y' },
    cost: { currency: 'USD', amount: 0 }, decision_state: 'pending', ...overrides,
  };
  const [manifest] = await generateGateManifests({ gate: 'gate-2', run_id: runId, track: 'track-1', items: [item] });
  const decision = {
    schema_version: '1.0.0', event_id: decisionId, gate: 'gate-2', run_id: runId, item_id: item.item_id,
    item_revision: item.item_revision, digest: item.artifact_digest, decision: 'approve', reason: null, review_after: null,
    actor: { provider: 'github', immutable_id: '123', authorized: true },
    source: { repository: 'project42dev/orchard', issue_number: 42, comment_id: '100', comment_digest: digest('2') },
    occurred_at: '2026-08-12T00:00:00.000Z', previous_state: 'gate2-pending', next_state: 'gate2-approved',
    supersedes_event_id: null, correlation_id: runId,
  };
  const body = `/orchard gate2 approve item=${item.item_id} revision=1 digest=${item.artifact_digest}`;
  decision.source.comment_digest = sha256Digest(body);
  const verifiedEvent = { body, repository: decision.source.repository, comment_id: decision.source.comment_id, actor: { immutable_id: decision.actor.immutable_id } };
  return {
    authority: {
      schema_version: '1.0.0', queue_work_item_id: null, manifest,
      full_manifest_items: [structuredClone(item)], decision, current_item: structuredClone(item),
      verified_event: verifiedEvent, authorization_policy: gatePolicy,
      trust: { ...gateTrust, provider_event_digest: sha256Digest(verifiedEvent) }
    }, item
  };
}

async function temporaryStore(t, authority) {
  const root = mkdtempSync(join(tmpdir(), 'orchard-publication-'));
  const store = openStateStore(join(root, 'content.db'));
  store.provisionTrustAnchor({
    scope: 'gate', adapter_identity: gateTrust.adapter_identity, adapter_digest: gateTrust.adapter_digest,
    policy_digest: gateTrust.authorization_policy_digest, policy: gatePolicy,
    provisioned_at: '2026-08-01T00:00:00.000Z'
  });
  store.provisionTrustAnchor({
    scope: 'publication', ...publicationTrust, provisioned_at: '2026-08-01T00:00:00.000Z'
  });
  t.after(() => {
    if (store.db) store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const { manifest, decision, current_item: item } = authority;
  const db = store.db;
  db.prepare(`INSERT INTO workflow_run (run_id, track, trigger_type, scope_mode, status, manifest_digest,
    idempotency_key, started_at, record_json, created_at) VALUES (?, ?, 'manual', 'subset', 'completed', ?, ?, ?, '{}', ?)`)
    .run(runId, manifest.track, digest('3'), `run:${runId}`, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
  db.prepare(`INSERT INTO workflow_item (item_id, origin_run_id, track, semantic_identity, surface, outcome,
    current_revision, current_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'docs', 'addition', 1, 'gate2-pending', ?, ?)`)
    .run(itemId, runId, manifest.track, 'content:item', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
  db.prepare(`INSERT INTO item_revision (item_id, item_revision, run_id, proposal_digest, artifact_digest,
    target_repository, target_path, lifecycle_key, record_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, '{}', ?)`)
    .run(itemId, runId, item.proposal_digest, item.artifact_digest, target.repository, target.path,
      `track-1:${itemId}:r1:revision`, '2026-08-12T00:00:00.000Z');
  const handoffId = '018f0d20-7b99-7cc3-8a5d-112233445566';
  db.prepare(`INSERT INTO agent_handoff (handoff_id, run_id, item_id, item_revision, role, input_digest,
    output_digest, predecessor_handoff_digest, idempotency_key, status, completed_at, record_json)
    VALUES (?, ?, ?, 1, 'final-reviewer', ?, ?, NULL, ?, 'passed', ?, '{}')`)
    .run(handoffId, runId, itemId, digest('7'), item.artifact_digest, `handoff:${handoffId}`, decision.occurred_at);
  const artifact = {
    binding_id: '018f0d20-7b98-7cc3-8a5d-112233445566', idempotency_key: `artifact:${itemId}:1`,
    run_id: runId, item_id: itemId, item_revision: 1, artifact_digest: item.artifact_digest,
    final_handoff_id: handoffId, final_handoff_digest: item.artifact_digest, scope_digest: digest('6'),
    occurred_at: decision.occurred_at
  };
  db.prepare(`INSERT INTO artifact_binding (binding_id, idempotency_key, run_id, item_id, item_revision,
    artifact_digest, final_handoff_id, final_handoff_digest, scope_digest, occurred_at, record_json)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(artifact.binding_id, artifact.idempotency_key, runId, itemId, item.artifact_digest, handoffId,
      item.artifact_digest, artifact.scope_digest, artifact.occurred_at, JSON.stringify(artifact));
  const link = {
    link_id: '018f0d20-7b97-7cc3-8a5d-112233445566', run_id: runId, item_id: itemId, item_revision: 1,
    provider: 'ado', operation: 'user-story', external_key: item.ado_external_key, external_id: 5001,
    linked_at: decision.occurred_at
  };
  store.recordExternalLink(link);
  await store.recordVerifiedDecision(authority);
  return store;
}

function adapter(options = {}) {
  return new FakeGitHubAdapter({
    protectedMain: { repository: target.repository, branch: 'main', commit: baseCommit },
    adapterIdentity: publicationTrust.adapter_identity, adapterDigest: publicationTrust.adapter_digest, ...options
  });
}

test('publication rejects caller-substituted adapter authority before provider access', async (t) => {
  const { authority } = await fixture();
  const store = await temporaryStore(t, authority);
  const substituted = adapter({ adapterIdentity: 'caller:substituted-adapter:v1', adapterDigest: digest('9') });
  await assert.rejects(publishApprovedItem({
    authorityReference: { gate2_decision_event_id: authority.decision.event_id }, preparedCommit,
    adapter: substituted, store, apply: true, transactionId
  }), /protected trust anchor/);
  assert.equal(substituted.fakeClient.calls.length, 0);
});

async function applyFixture(t, options = {}) {
  const { authority } = await fixture();
  const store = await temporaryStore(t, authority);
  const github = adapter(options);
  const result = await publishApprovedItem({
    authorityReference: { gate2_decision_event_id: authority.decision.event_id }, preparedCommit, adapter: github, store, apply: true,
    merge: options.merge ?? false, transactionId
  });
  return { authority, store, github, result };
}

test('Gate 2 authority is fail-closed for stale or mutated exact bindings', async () => {
  const { authority } = await fixture();
  await validateGate2PublicationAuthority(authority);
  const mutations = [
    (copy) => { copy.current_item.displayed_diff_digest = digest('9'); },
    (copy) => { copy.current_item.prepared_tree_digest = digest('9'); },
    (copy) => { copy.current_item.proposal_digest = digest('9'); },
    (copy) => { copy.current_item.base_commit = '9'.repeat(40); },
    (copy) => { copy.current_item.target.path = 'content/other.md'; },
    (copy) => { copy.current_item.ado_external_key = 'wrong'; },
    (copy) => { copy.current_item.handoff_chain_digest = digest('9'); },
    (copy) => { copy.decision.previous_state = 'gate2-approved'; },
    (copy) => { copy.full_manifest_items[0].artifact_digest = digest('9'); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(authority); mutate(copy);
    await assert.rejects(validateGate2PublicationAuthority(copy));
  }
});

test('publication identity and branch are deterministic and direct main is refused', async () => {
  const { authority } = await fixture();
  const binding = await validateGate2PublicationAuthority(authority);
  assert.equal(publicationIdempotencyKey(binding), `publication:track-1:${itemId}:r1:${digest('c')}`);
  assert.equal(publicationBranchName(binding), `orchard/publication/track-1/${itemId}/r1-${'c'.repeat(16)}`);
  const github = adapter();
  await assert.rejects(github.reconcileBeforeCreateBranch({ repository: target.repository, branch: 'main', expected: {}, create: {} }), /direct.*main/i);
  await assert.rejects(github.reconcileBeforeCreatePullRequest({
    repository: target.repository, externalKey: 'x',
    expected: { headBranch: 'main', baseBranch: 'main' }, create: {}
  }), /direct.*main/i);
});

test('branch and pull-request duplicates or mismatches fail before writes', async () => {
  const { authority } = await fixture();
  const binding = await validateGate2PublicationAuthority(authority);
  const branch = publicationBranchName(binding);
  const expectedBranch = { repository: target.repository, name: branch, commit: preparedCommit, preparedTreeDigest: digest('f') };
  const duplicate = adapter({ branches: [expectedBranch, expectedBranch] });
  await assert.rejects(duplicate.reconcileBeforeCreateBranch({ repository: target.repository, branch, expected: expectedBranch, create: expectedBranch }), AmbiguousExternalStateError);
  assert.equal(duplicate.fakeClient.calls.some((call) => call.operation === 'create-branch'), false);
  const mismatch = adapter({ branches: [{ ...expectedBranch, commit: '9'.repeat(40) }] });
  await assert.rejects(mismatch.reconcileBeforeCreateBranch({ repository: target.repository, branch, expected: expectedBranch, create: expectedBranch }), ExternalStateMismatchError);
  const pull = { number: 1, repository: target.repository, externalKey: 'key', headBranch: branch, baseBranch: 'main' };
  const duplicatePull = adapter({ pullRequests: [pull, { ...pull, number: 2 }] });
  await assert.rejects(duplicatePull.reconcileBeforeCreatePullRequest({ repository: target.repository, externalKey: 'key', expected: pull, create: pull }), AmbiguousExternalStateError);
});

test('timeouts after branch and pull-request writes reconcile without duplicate effects', async (t) => {
  const { github } = await applyFixture(t, {
    scenarios: [
      { operation: 'create-branch', type: 'timeout-after' }, { operation: 'create-pr', type: 'timeout-after' },
    ]
  });
  assert.equal(github.fakeClient.branches.length, 1);
  assert.equal(github.fakeClient.pullRequests.length, 1);
  assert.equal(github.fakeClient.calls.filter((call) => call.operation === 'create-branch').length, 1);
  assert.equal(github.fakeClient.calls.filter((call) => call.operation === 'create-pr').length, 1);
});

test('recovery reconciles an intent without a result', async (t) => {
  const { authority } = await fixture();
  const store = await temporaryStore(t, authority);
  const authorityReference = { gate2_decision_event_id: authority.decision.event_id };
  const failed = adapter({ maxRetries: 0, scenarios: [{ operation: 'create-branch', type: 'timeout-before' }] });
  await assert.rejects(publishApprovedItem({ authorityReference, preparedCommit, adapter: failed, store, apply: true, transactionId }));
  let state = store.getPublicationState(publicationIdempotencyKey({ track: 'track-1', ...authority.current_item }));
  assert.ok(state.events.some((event) => event.phase === 'prepare' && event.intent_or_result === 'intent'));
  assert.equal(state.events.some((event) => event.phase === 'prepare' && event.intent_or_result === 'result'), false);
  const recovered = adapter();
  const result = await publishApprovedItem({ authorityReference, preparedCommit, adapter: recovered, store, apply: true });
  assert.equal(result.operation, 'merge-pending');
  state = store.getPublicationState(result.transaction.idempotency_key);
  assert.equal(state.state, 'merge-pending');
});

test('changed PR head, tree, diff, and approved base drift all fail closed before merge', async (t) => {
  for (const patch of [{ headCommit: '9'.repeat(40) }, { preparedTreeDigest: digest('9') }, { displayedDiffDigest: digest('9') }]) {
    const applied = await applyFixture(t);
    Object.assign(applied.github.fakeClient.pullRequests[0], patch);
    await assert.rejects(publishApprovedItem({
      authorityReference: { gate2_decision_event_id: applied.authority.decision.event_id }, preparedCommit, adapter: applied.github,
      store: applied.store, apply: true, merge: true
    }), ExternalStateMismatchError);
    assert.equal(applied.github.fakeClient.calls.some((call) => call.operation === 'merge-pr'), false);
  }
  const drift = await applyFixture(t);
  drift.github.fakeClient.protectedMain.commit = '8'.repeat(40);
  await assert.rejects(publishApprovedItem({
    authorityReference: { gate2_decision_event_id: drift.authority.decision.event_id }, preparedCommit, adapter: drift.github,
    store: drift.store, apply: true, merge: true
  }), ExternalStateMismatchError);
});

test('timeout after merge reconciles once but merge response alone never marks published', async (t) => {
  const applied = await applyFixture(t, { merge: true, scenarios: [{ operation: 'merge-pr', type: 'timeout-after' }] });
  assert.equal(applied.result.operation, 'acknowledging');
  assert.equal(applied.github.fakeClient.calls.filter((call) => call.operation === 'merge-pr').length, 1);
  const state = applied.store.getPublicationState(applied.result.transaction.idempotency_key);
  assert.equal(state.state, 'acknowledging');
  assert.equal(state.push_acknowledgement, null);
});

test('wrong main commit is refused; exact protected-main acknowledgement is replay-safe', async (t) => {
  const applied = await applyFixture(t, { merge: true });
  await assert.rejects(acknowledgePublication({
    idempotencyKey: applied.result.transaction.idempotency_key,
    adapter: applied.github, store: applied.store
  }), ExternalStateMismatchError);
  assert.notEqual(applied.store.getPublicationState(applied.result.transaction.idempotency_key).state, 'published');
  applied.github.fakeClient.protectedMain.commit = applied.result.result_commit;
  const published = await acknowledgePublication({
    idempotencyKey: applied.result.transaction.idempotency_key,
    adapter: applied.github, store: applied.store
  });
  assert.equal(published.state, 'published');
  assert.equal(published.push_acknowledgement.commit, applied.result.result_commit);
  const eventCount = published.events.length;
  const replay = await acknowledgePublication({
    idempotencyKey: applied.result.transaction.idempotency_key,
    adapter: applied.github, store: applied.store
  });
  assert.equal(replay.events.length, eventCount);
  assert.deepEqual(replay.push_acknowledgement, published.push_acknowledgement);
});

test('transaction replay returns immutable records and conflicting idempotency reuse fails', async (t) => {
  const applied = await applyFixture(t);
  const replay = await publishApprovedItem({
    authorityReference: { gate2_decision_event_id: applied.authority.decision.event_id }, preparedCommit, adapter: applied.github,
    store: applied.store, apply: true
  });
  assert.equal(replay.transaction.transaction_id, transactionId);
  assert.equal(applied.github.fakeClient.branches.length, 1);
  assert.equal(applied.github.fakeClient.pullRequests.length, 1);

  await assert.rejects(publishApprovedItem({
    authorityReference: { gate2_decision_event_id: applied.authority.decision.event_id, manifest: {} },
    preparedCommit, adapter: applied.github, store: applied.store, apply: true
  }), /only the immutable Gate 2 decision reference/);

  const transaction = applied.result.transaction;
  const mutations = {
    run_id: runId.replace('566', '567'), item_id: itemId.replace('566', '567'), item_revision: 2,
    gate2_decision_event_id: decisionId.replace('566', '567'), artifact_digest: digest('9'),
    proposal_digest: digest('9'), displayed_diff_digest: digest('9'), prepared_tree_digest: digest('9'),
    ado_external_key: 'orchard:track-1:wrong:r1', handoff_chain_digest: digest('9'),
    full_manifest_digest: digest('9'), gate2_batch_digest: digest('9'), base_commit: '9'.repeat(40),
    target: { ...transaction.target, path: 'content/other.md' }
  };
  for (const [index, [field, value]] of Object.entries(mutations).entries()) {
    const changed = structuredClone(transaction);
    changed.transaction_id = `018f0d20-${(0x7c00 + index).toString(16)}-7cc3-8a5d-112233445566`;
    changed[field] = value;
    await assert.rejects(applied.store.recordPublicationTransaction(changed), /does not match|requires protected|idempotency key must match/);
  }

  const intent = applied.store.findPublicationEvent(`publication:${transactionId}:prepare:intent`);
  assert.throws(() => applied.store.recordPublicationEvent({ ...intent, evidence_digest: digest('9') }), IdempotencyConflictError);
});
