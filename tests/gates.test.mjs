import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateGateManifests, verifyGateManifestDigests, decisionCommand, applyGateIssues } from '../scripts/lib/gates.mjs';
import { captureGateDecision, parseDecisionCommand } from '../scripts/capture-gate-decision.mjs';
import { validateDispatchAuthority } from '../scripts/generate-briefs.mjs';
import { createAgentHandoff, validateHandoffChain } from '../scripts/lib/handoffs.mjs';
import { FakeGitHubAdapter } from '../scripts/adapters/fake-github-adapter.mjs';
import { FakeAdoAdapter } from '../scripts/adapters/fake-ado-adapter.mjs';
import { sha256Digest } from '../scripts/lib/identity.mjs';
import { loadProtectedAdapterModule, protectedAdapterDigest, verifyProtectedAdapterArtifact } from '../scripts/lib/protected-adapter.mjs';
import { reconcileApprovedItem } from '../scripts/lib/ado-reconciliation.mjs';
import { StateStore } from '../scripts/lib/state-store.mjs';

const runId = '018f0d20-7b9a-7cc3-8a5d-112233445566';
const itemId = '018f0d20-7b9b-7cc3-8a5d-112233445566';
const eventId = '018f0d20-7b9c-7cc3-8a5d-112233445566';
const digest = (character) => `sha256:${character.repeat(64)}`;
const item = (ordinal = 0) => ({
  item_id: `018f0d20-${(0x7b9b + ordinal).toString(16)}-7cc3-8a5d-112233445566`, item_revision: 1,
  proposal_digest: digest(((ordinal % 6) + 1).toString()), category: 'addition', title: `Item ${ordinal}`,
  rationale: 'Evidence supports review.', evidence_refs: [`evidence/${ordinal}`], score: { formula_version: '1.0.0', value: ordinal },
  target: { repository: 'project42dev/project42-platform', path: `content/item-${ordinal}.md` }, risks: [],
  estimated_cost: { currency: 'USD', amount: 0 }, decision_state: 'pending',
});
const gate1Input = (items = [item()]) => ({ gate: 'gate-1', run_id: runId, track: 'track-1', items });
const source = { repository: 'project42dev/orchard', issue_number: 42, comment_id: '100' };
const actor = { provider: 'github', immutable_id: '123', display_name: 'Owner' };

let captureSequence = 0;
async function runCaptureCli(root, input, overrides = {}) {
  const directory = join(root, String(captureSequence++));
  mkdirSync(directory, { recursive: true });
  const inputPath = join(directory, 'capture.json');
  const adapterPath = join(directory, 'provider-adapter.mjs');
  const dbPath = join(directory, 'content.db');
  const policy = { provider: 'github', repository: source.repository, authorized_actor_ids: ['123'] };
  const adapterText = overrides.adapterText ?? 'export const missingContract = true;\n';
  writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  writeFileSync(adapterPath, adapterText);
  const store = new StateStore(dbPath);
  if (!overrides.missingTrust) store.provisionTrustAnchor({
    scope: 'gate', adapter_identity: overrides.adapterIdentity ?? 'test:gate-provider:v1',
    adapter_digest: overrides.adapterDigest ?? await protectedAdapterDigest(adapterPath), adapter_path: adapterPath,
    policy_digest: sha256Digest(policy), policy, provisioned_at: '2026-08-01T00:00:00.000Z'
  });
  store.close();
  return spawnSync(process.execPath, [resolve('scripts/capture-gate-decision.mjs'), '--input', inputPath, '--db', dbPath], {
    cwd: resolve('.'), env: process.env, encoding: 'utf8'
  });
}

test('gate capture CLI fails closed when protected trust configuration is missing or invalid', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-gate-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = await runCaptureCli(root, {}, { missingTrust: true });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /trust\.configuration/);

  const adapterMismatch = await runCaptureCli(root, {}, { adapterDigest: digest('f') });
  assert.notEqual(adapterMismatch.status, 0);
  assert.match(adapterMismatch.stderr, /source\.adapter-digest/);

  const missingContract = await runCaptureCli(root, {});
  assert.notEqual(missingContract.status, 0);
  assert.match(missingContract.stderr, /source\.adapter-contract/);

  const selfAsserted = await runCaptureCli(root, { event: { actor: { immutable_id: '123' } } });
  assert.notEqual(selfAsserted.status, 0);
  assert.match(selfAsserted.stderr, /source\.self-asserted/);
});

test('protected adapter digest covers transitive local dependencies', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-protected-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, 'entry.mjs');
  const helper = join(root, 'helper.mjs');
  writeFileSync(entry, "import { value } from './helper.mjs';\nexport const adapterIdentity = value;\n");
  writeFileSync(helper, "export const value = 'trusted';\n");
  const expected = await protectedAdapterDigest(entry);
  await verifyProtectedAdapterArtifact(entry, expected);
  writeFileSync(helper, "export const value = 'mutated';\n");
  await assert.rejects(verifyProtectedAdapterArtifact(entry, expected), /does not match/);
});

test('protected gate adapter executes only the verified snapshot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-protected-gate-adapter-'));
  const entry = join(root, 'entry.mjs');
  const dbPath = join(root, 'content.db');
  writeFileSync(entry, "export const adapterIdentity = 'test:gate:v1';\nexport const fetchVerifiedEvent = () => 'trusted';\n");
  const store = new StateStore(dbPath);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.provisionTrustAnchor({
    scope: 'gate', adapter_identity: 'test:gate:v1', adapter_digest: await protectedAdapterDigest(entry),
    adapter_path: entry, policy_digest: sha256Digest({}), policy: {}, provisioned_at: '2026-08-01T00:00:00.000Z'
  });
  const { loaded } = await loadProtectedAdapterModule(store, 'gate');
  writeFileSync(entry, "export const adapterIdentity = 'test:gate:v1';\nexport const fetchVerifiedEvent = () => 'mutated';\n");
  assert.equal(await loaded.fetchVerifiedEvent(), 'trusted');
});

test('gate manifests isolate items and batch deterministically at twenty', async () => {
  const allItems = Array.from({ length: 21 }, (_, index) => item(index));
  const manifests = await generateGateManifests(gate1Input(allItems));
  assert.deepEqual(manifests.map((manifest) => manifest.items.length), [20, 1]);
  assert.deepEqual(manifests.map((manifest) => manifest.batch.ordinal), [1, 2]);
  assert.equal(new Set(manifests.flatMap((manifest) => manifest.items.map((entry) => entry.item_id))).size, 21);
  assert.deepEqual(manifests, await generateGateManifests(gate1Input(Array.from({ length: 21 }, (_, index) => item(index)))));
  const sortedItems = structuredClone(allItems).sort((a, b) => a.item_id.localeCompare(b.item_id));
  for (const manifest of manifests) verifyGateManifestDigests(manifest, sortedItems);
  assert.throws(() => verifyGateManifestDigests(manifests[0]), /complete full-manifest/i);
});

test('digest verification rejects proposal, target, and batch mutation', async () => {
  const [manifest] = await generateGateManifests(gate1Input());
  for (const mutate of [
    (copy) => { copy.items[0].proposal_digest = digest('f'); },
    (copy) => { copy.items[0].target.path = 'content/other.md'; },
    (copy) => { copy.batch.item_count = 2; },
  ]) {
    const copy = structuredClone(manifest); mutate(copy);
    assert.throws(() => verifyGateManifestDigests(copy), /digest|batch/i);
  }
});

test('strict parser accepts one exact line and rejects issue prose or multiple commands', () => {
  const command = `/orchard gate1 approve item=${itemId} revision=1 digest=${digest('a')}`;
  assert.equal(parseDecisionCommand(command).decision, 'approve');
  for (const invalid of [`Please ${command}`, `${command}\nthanks`, `${command}\n${command}`]) {
    assert.throws(() => parseDecisionCommand(invalid));
  }
});

test('decision capture is per-item, authorized, immutable, replay-safe, and rejects edits/stale revisions', async () => {
  const [manifest] = await generateGateManifests(gate1Input([item(), item(1)]));
  const commandText = decisionCommand(manifest, manifest.items[0]);
  const providerEvent = (overrides = {}) => ({
    body: commandText, action: 'created', actor, repository: source.repository,
    issue_number: source.issue_number, comment_id: source.comment_id, occurred_at: '2026-01-01T00:00:00.000Z', current_state: 'gate1-pending',
    issue: {
      repository: source.repository, number: source.issue_number, manifest_digest: sha256Digest(manifest),
      idempotency_key: manifest.idempotency_key, batch_digest: manifest.batch_digest, gate: manifest.gate,
      run_id: manifest.run_id, track: manifest.track, target: manifest.items[0].target
    }, ...overrides
  });
  const authorizationPolicy = { provider: 'github', repository: source.repository, authorized_actor_ids: ['123'] };
  const result = await captureGateDecision({ manifest, verifiedEvent: providerEvent(), authorizationPolicy, currentItem: manifest.items[0], eventId, correlationId: runId });
  assert.equal(result.event.item_id, manifest.items[0].item_id);
  assert.equal(manifest.items[1].decision_state, 'pending');
  const replay = await captureGateDecision({ manifest, verifiedEvent: providerEvent(), authorizationPolicy, currentItem: manifest.items[0], existingEvents: [result.event] });
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.event_id, result.event.event_id);
  await assert.rejects(captureGateDecision({ manifest, verifiedEvent: providerEvent({ actor: { ...actor, immutable_id: '999' }, comment_id: '101' }), authorizationPolicy }), /not authorized/i);
  await assert.rejects(captureGateDecision({ manifest, verifiedEvent: providerEvent({ edited: true, comment_id: '102' }), authorizationPolicy }), /edited/i);
  await assert.rejects(captureGateDecision({ manifest, verifiedEvent: providerEvent({ comment_id: '104' }), authorizationPolicy: { ...authorizationPolicy, repository: 'other/repository' } }), /policy.*bind/i);
  const stale = commandText.replace('revision=1', 'revision=2');
  await assert.rejects(captureGateDecision({ manifest, verifiedEvent: providerEvent({ body: stale, comment_id: '103' }), authorizationPolicy }), /revision/i);
});

test('gate issue application is dry-run by default and idempotent through adapter reconciliation', async () => {
  const manifests = await generateGateManifests(gate1Input());
  const adapter = new FakeGitHubAdapter();
  const dryRun = await applyGateIssues({ manifests, repository: 'project42dev/orchard', githubAdapter: adapter });
  assert.equal(dryRun[0].operation, 'dry-run');
  assert.equal(adapter.fakeClient.issues.length, 0);
  const created = await applyGateIssues({ manifests, repository: 'project42dev/orchard', githubAdapter: adapter, apply: true });
  const repeated = await applyGateIssues({ manifests, repository: 'project42dev/orchard', githubAdapter: adapter, apply: true });
  assert.equal(created[0].operation, 'created');
  assert.equal(repeated[0].operation, 'reconciled');
  assert.equal(adapter.fakeClient.issues.length, 1);
});

test('dispatch accepts only immutable queue and persisted Gate 1 references', async () => {
  const queueItem = { id: 77 };
  const reference = { queue_work_item_id: 77, gate1_decision_event_id: eventId };
  const persistedBinding = { ...reference, ado_work_item_id: 5001 };
  const authorityStore = {
    getDispatchBinding(candidate) {
      if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(['gate1_decision_event_id', 'queue_work_item_id'])) {
        throw new Error('immutable references only');
      }
      if (candidate.queue_work_item_id !== 77 || candidate.gate1_decision_event_id !== eventId) throw new Error('not found');
      return persistedBinding;
    }
  };
  const validated = validateDispatchAuthority(queueItem, reference, authorityStore);
  assert.equal(validated.binding.ado_work_item_id, 5001);
  assert.ok(validateDispatchAuthority(queueItem, { ...reference, decision: {} }, authorityStore).error);
  assert.ok(validateDispatchAuthority(queueItem, { ...reference, queue_work_item_id: 78 }, authorityStore).error);
  assert.ok(validateDispatchAuthority(queueItem, reference).error);
});

test('ADO is reconciled only after exact Gate 1 approval and persisted before dispatch eligibility', async () => {
  const [manifest] = await generateGateManifests(gate1Input());
  const commandText = decisionCommand(manifest, manifest.items[0]);
  const event = {
    body: commandText, action: 'created', actor, repository: source.repository, issue_number: source.issue_number,
    comment_id: source.comment_id, occurred_at: '2026-01-01T00:00:00.000Z', current_state: 'gate1-pending',
    issue: {
      repository: source.repository, number: source.issue_number, manifest_digest: sha256Digest(manifest),
      idempotency_key: manifest.idempotency_key, batch_digest: manifest.batch_digest, gate: manifest.gate,
      run_id: manifest.run_id, track: manifest.track, target: manifest.items[0].target
    }
  };
  const { event: decision } = await captureGateDecision({ manifest, verifiedEvent: event, authorizationPolicy: { provider: 'github', repository: source.repository, authorized_actor_ids: ['123'] }, currentItem: manifest.items[0], eventId, correlationId: runId });
  const adapter = new FakeAdoAdapter();
  const persisted = [];
  const result = await reconcileApprovedItem({
    manifest, decision, currentItem: manifest.items[0], featureId: 99,
    adoAdapter: adapter, organization: 'org', project: 'project', persistLink: async (binding) => persisted.push(binding), apply: true
  });
  assert.equal(result.dispatchEligible, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].ado_work_item_id, result.object.id);

  for (const invalidDecision of [
    { ...decision, decision: 'deny', reason: 'Not approved', next_state: 'denied' },
    { ...decision, item_revision: 2 },
    { ...decision, digest: digest('f') },
  ]) {
    const isolatedAdapter = new FakeAdoAdapter();
    await assert.rejects(reconcileApprovedItem({
      manifest, decision: invalidDecision, currentItem: manifest.items[0], featureId: 99,
      adoAdapter: isolatedAdapter, persistLink: async () => { }, apply: true
    }));
    assert.equal(isolatedAdapter.fakeClient.calls.length, 0);
  }
});

const lifecycleBinding = {
  run_id: runId, track: 'track-1', item_id: itemId, item_revision: 1, proposal_digest: digest('a'),
  gate1_decision_event_id: eventId, ado_external_key: `orchard:track-1:${itemId}:r1`, ado_work_item_id: 5001,
  target: { repository: 'project42dev/project42-platform', path: 'content/item.md' }
};
function handoffInput(overrides = {}) {
  return {
    binding: lifecycleBinding, role: 'writer',
    model: { identity: 'offline-model', provider_family: 'test', qualification_digest: digest('b') }, promptVersion: '1.0.0',
    input: { brief: 'exact' }, output: { artifact: 'exact' }, predecessor: null, status: 'passed', findings: [],
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', ...overrides
  };
}

test('legacy handoff chains cannot reach Gate 2 without explicit delivery policy inputs', async () => {
  const first = await createAgentHandoff(handoffInput());
  const second = await createAgentHandoff(handoffInput({ role: 'final-reviewer', input: { prior: first.output_digest }, output: { final: true }, predecessor: first }));
  await assert.rejects(validateHandoffChain({ binding: lifecycleBinding, handoffs: [first, second] }), /explicit delivery policy/i);
});
