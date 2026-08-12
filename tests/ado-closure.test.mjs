import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdoAdapter } from '../scripts/adapters/fake-ado-adapter.mjs';
import { buildClosurePacket, prepareAdoResolved, acceptAdoClosure, closureCompletionNotes } from '../scripts/lib/ado-closure.mjs';
import { closurePacketDigest, loadJson, validateRecord } from '../scripts/lib/contracts.mjs';
import {
    checkBeforeDispatch, createDeliveryAccounting, deliveryScopeDigest, factualInventoryDigest,
    qualificationDigest, recordDispatchResult, requiredDeliveryRoles
} from '../scripts/lib/delivery-policy.mjs';
import { generateGateManifests } from '../scripts/lib/gates.mjs';
import { createAgentHandoff, createArtifactBinding, validateHandoffChain } from '../scripts/lib/handoffs.mjs';
import { StateStore, IdempotencyConflictError } from '../scripts/lib/state-store.mjs';
import { sha256Digest } from '../scripts/lib/identity.mjs';

const FIXTURES = new URL('../contracts/fixtures/', import.meta.url);
const digest = (character) => `sha256:${character.repeat(64)}`;
const policy = JSON.parse(await readFile(new URL('../config/delivery-policy.example.json', import.meta.url), 'utf8'));
const providers = {
    'evidence-researcher': 'provider-a', writer: 'provider-a', editor: 'provider-b',
    'factual-verifier': 'provider-b', 'accessibility-reviewer': 'provider-a', 'final-reviewer': 'provider-c'
};
const scope = { assessments_changed: false, diagrams_changed: false, human_assistive_review_required: true };
const accessibilityChecks = ['structure', 'keyboard', 'captions', 'transcripts', 'text-alternatives', 'color-independence', 'zoom', 'reduced-motion'];
const roleEvidence = {
    'factual-verifier': {
        inventory: { complete: true, volatile_claim_ids: ['claim-1'], inventory_digest: factualInventoryDigest(['claim-1']) },
        claims: [{
            claim_id: 'claim-1', status: 'supported',
            source: { primary: true, current: true, verified_at: '2026-08-12T10:00:00Z', evidence_ref: 'evidence/source/primary-1' }
        }]
    },
    'accessibility-reviewer': {
        checks: accessibilityChecks.map((name) => ({ name, applicable: true, status: 'passed', evidence_ref: `evidence/a11y/${name}` })),
        human_review: { required: true, status: 'passed', evidence_ref: 'evidence/a11y/assistive-technology' }
    }
};
const ownerPolicy = { provider: 'github', authorized_owners: [{ provider: 'github', immutable_id: '1001' }] };
const closureTrust = {
    policy_digest: sha256Digest(ownerPolicy), adapter_digest: digest('8'),
    adapter_identity: 'test:protected-closure-adapter:v1'
};
const publicationTrust = {
    scope: 'publication', adapter_identity: 'test:protected-publication-adapter:v1',
    adapter_digest: digest('6'), provisioned_at: '2026-08-01T00:00:00.000Z'
};

async function fixture(name) { return structuredClone(await loadJson(new URL(name, FIXTURES))); }

function qualificationEntry(role) {
    const entry = {
        model_identity: `${role}-model`, provider_family: providers[role], role,
        qualified_at: '2026-08-01T00:00:00Z', expires_at: '2026-10-30T00:00:00Z', status: 'qualified',
        prompt_version: '1.0.0',
        criteria: policy.qualification.required_criteria.map((name) => ({
            name, measured_value: 1, threshold: 1, passed: true, evidence_ref: `qualification/${name}`
        }))
    };
    return { ...entry, qualification_digest: qualificationDigest(entry) };
}

async function completeDelivery(binding) {
    const handoffs = [];
    const outputs = ['1', '2', '3', '4', '5', 'c'];
    for (const [index, role] of requiredDeliveryRoles(policy, scope).entries()) {
        const qualification = qualificationEntry(role);
        handoffs.push(await createAgentHandoff({
            binding, role,
            model: {
                identity: qualification.model_identity, provider_family: qualification.provider_family,
                qualification_digest: qualification.qualification_digest
            },
            promptVersion: '1.0.0', input: { role }, output: digest(outputs[index]),
            predecessor: handoffs.at(-1) ?? null, status: 'passed', findings: [],
            startedAt: `2026-08-12T10:0${index + 1}:00Z`, completedAt: `2026-08-12T10:0${index + 1}:30Z`
        }));
    }
    const qualificationRegistry = { schema_version: '1.0.0', entries: handoffs.map((handoff) => qualificationEntry(handoff.role)) };
    let accounting = createDeliveryAccounting(policy);
    for (const [index, handoff] of handoffs.entries()) {
        const usage = {
            requests: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5, duration_ms: 30000,
            retries: 0, source_fetches: 1, item_count: index === 0 ? 1 : 0, concurrency: 1, usd_spend: 0.1
        };
        const dispatch = checkBeforeDispatch({
            policy, accounting, operation: { handoff_id: handoff.handoff_id, item_id: handoff.item_id, role: handoff.role },
            expectedUsage: usage
        });
        assert.equal(dispatch.allowed, true);
        accounting = recordDispatchResult({
            policy, accounting: dispatch.accounting, dispatchId: dispatch.dispatch_id, actualUsage: usage
        }).accounting;
    }
    return { handoffs, qualificationRegistry, accounting };
}

async function buildInputs() {
    const run = await fixture('track-1-run.valid.json');
    const item = await fixture('track-1-item.valid.json');
    item.artifact_digest = digest('c');
    item.state = 'published';
    const gate1Item = {
        item_id: item.item_id, item_revision: 1, proposal_digest: item.proposal_digest, category: item.outcome,
        title: 'Closure test', rationale: 'Deterministic evidence', evidence_refs: ['evidence/source/example'],
        score: { formula_version: '1.0.0', value: 80 }, target: item.target, risks: [],
        estimated_cost: { currency: 'USD', amount: 1 }, decision_state: 'pending',
    };
    const [gate1Manifest] = await generateGateManifests({ gate: 'gate-1', runId: run.run_id, track: run.track, items: [gate1Item] });
    const decision = (gate, eventId, approvedDigest) => ({
        schema_version: '1.0.0', event_id: eventId, gate, run_id: run.run_id, item_id: item.item_id,
        item_revision: 1, digest: approvedDigest, decision: 'approve', reason: null, review_after: null,
        actor: { provider: 'github', immutable_id: '1001', authorized: true },
        source: {
            repository: 'project42dev/orchard', issue_number: gate === 'gate-1' ? 1 : 2,
            comment_id: `${gate}-comment`, comment_digest: digest('9')
        },
        occurred_at: gate === 'gate-1' ? '2026-08-12T10:00:00Z' : '2026-08-12T10:20:00Z',
        previous_state: gate === 'gate-1' ? 'gate1-pending' : 'gate2-pending',
        next_state: gate === 'gate-1' ? 'gate1-approved' : 'gate2-approved', supersedes_event_id: null,
        correlation_id: run.run_id,
    });
    const gate1Decision = decision('gate-1', '018f3000-0000-7000-8000-000000000001', item.proposal_digest);
    const adoBinding = {
        run_id: run.run_id, item_id: item.item_id, item_revision: 1,
        track: run.track,
        proposal_digest: item.proposal_digest, gate1_decision_event_id: gate1Decision.event_id,
        ado_external_key: `orchard:track-1:${item.item_id}:r1`, ado_work_item_id: 5101, target: item.target
    };
    const { handoffs, qualificationRegistry, accounting } = await completeDelivery(adoBinding);
    const chain = await validateHandoffChain({
        binding: adoBinding, handoffs, policy, qualificationRegistry, scope, roleEvidence,
        asOf: '2026-08-12T10:10:00Z'
    });
    const scopeDigest = deliveryScopeDigest(scope);
    const gate2Item = {
        item_id: item.item_id, item_revision: 1, artifact_digest: item.artifact_digest,
        proposal_digest: item.proposal_digest, displayed_diff_digest: digest('d'), prepared_tree_digest: digest('e'),
        target: item.target, base_commit: '1'.repeat(40), diff_ref: 'evidence/diff', artifact_ref: 'evidence/artifact',
        ado_external_key: adoBinding.ado_external_key, handoff_chain_digest: chain.handoff_chain_digest,
        tests: [{ name: 'unit', status: 'passed', evidence_ref: 'evidence/test' }],
        factual_review: { status: 'passed', evidence_ref: 'evidence/factual' },
        accessibility_review: { status: 'passed', evidence_ref: 'evidence/a11y' },
        cost: { currency: 'USD', amount: 0.6 }, decision_state: 'pending',
    };
    const [gate2Manifest] = await generateGateManifests({ gate: 'gate-2', runId: run.run_id, track: run.track, items: [gate2Item] });
    const gate2Decision = decision('gate-2', '018f3000-0000-7000-8000-000000000002', item.artifact_digest);
    const artifact = { ...gate2Item, scope_digest: scopeDigest };
    const artifactBinding = createArtifactBinding({
        binding: adoBinding, finalHandoff: handoffs.at(-1), artifact,
        bindingId: '018f2500-0000-7000-8000-000000000001', occurredAt: '2026-08-12T10:10:00Z'
    });
    const transactionId = '018f4000-0000-7000-8000-000000000002';
    const resultCommit = '2'.repeat(40);
    const pull = {
        number: 42, repository: item.target.repository, baseBranch: 'main', state: 'merged',
        displayedDiffDigest: gate2Item.displayed_diff_digest, preparedTreeDigest: gate2Item.prepared_tree_digest,
        mergeCommit: resultCommit
    };
    const publicationState = {
        state: 'published', result_commit: resultCommit,
        push_acknowledgement: {
            repository: item.target.repository, branch: 'main', commit: resultCommit,
            status: 'succeeded', acknowledged_at: '2026-08-12T11:00:00Z'
        },
        transaction: {
            schema_version: '1.0.0', idempotency_key: `publication:track-1:${item.item_id}:r1:${item.artifact_digest}`,
            transaction_id: transactionId, run_id: run.run_id, item_id: item.item_id, item_revision: 1,
            proposal_digest: item.proposal_digest, artifact_digest: item.artifact_digest,
            displayed_diff_digest: gate2Item.displayed_diff_digest, prepared_tree_digest: gate2Item.prepared_tree_digest,
            ado_external_key: gate2Item.ado_external_key, handoff_chain_digest: gate2Item.handoff_chain_digest,
            full_manifest_digest: gate2Manifest.full_manifest_digest, gate2_batch_digest: gate2Manifest.batch_digest,
            gate2_decision_event_id: gate2Decision.event_id, target: { ...item.target, protected_branch: 'main' },
            base_commit: gate2Item.base_commit, state: 'created', created_at: '2026-08-12T10:21:00Z'
        },
        events: [
            {
                event_id: '018f8000-0000-7000-8000-000000000001', transaction_id: transactionId,
                phase: 'merge', state: 'publication-merging', intent_or_result: 'result',
                correlation_id: run.run_id, occurred_at: '2026-08-12T10:30:00Z', pull_request: pull
            },
            {
                event_id: '018f8000-0000-7000-8000-000000000002', transaction_id: transactionId,
                phase: 'acknowledge', state: 'published', intent_or_result: 'result', correlation_id: run.run_id,
                occurred_at: '2026-08-12T11:00:00Z', result_commit: resultCommit,
                push_acknowledgement: {
                    repository: item.target.repository, branch: 'main', commit: resultCommit,
                    status: 'succeeded', acknowledged_at: '2026-08-12T11:00:00Z'
                }
            }
        ],
    };
    return {
        run, item, gate1Manifest, gate1Decision, handoffs, gate2Manifest, gate2Decision, adoBinding,
        artifact, artifactBinding, reviewedScopeDigest: scopeDigest, publicationState,
        policy, qualificationRegistry, scope, roleEvidence, accounting, asOf: '2026-08-12T10:10:00Z', residualRisks: [],
        rollbackReference: `rollback:${transactionId}`, packetId: '018f4000-0000-7000-8000-000000000001',
        preparedAt: '2026-08-12T11:01:00Z'
    };
}

function seedStore(t, packet, input) {
    const root = mkdtempSync(join(tmpdir(), 'orchard-closure-'));
    const store = new StateStore(join(root, 'content.db'));
    store.provisionTrustAnchor({
        scope: 'closure', adapter_identity: closureTrust.adapter_identity,
        adapter_digest: closureTrust.adapter_digest, policy_digest: closureTrust.policy_digest,
        policy: ownerPolicy, provisioned_at: '2026-08-01T00:00:00.000Z'
    });
    store.provisionTrustAnchor(publicationTrust);
    t.after(() => { if (store.db) store.close(); rmSync(root, { recursive: true, force: true }); });
    const db = store.db;
    db.prepare(`INSERT INTO workflow_run (run_id, track, trigger_type, scope_mode, status, manifest_digest,
        idempotency_key, started_at, record_json, created_at) VALUES (?, ?, 'manual', 'full', 'completed', ?, ?, ?, '{}', ?)`)
        .run(packet.run_id, packet.track, digest('1'), `run:${packet.run_id}`, packet.prepared_at, packet.prepared_at);
    db.prepare(`INSERT INTO workflow_item (item_id, origin_run_id, track, semantic_identity, surface, outcome,
        current_revision, current_state, created_at, updated_at) VALUES (?, ?, ?, 'closure:test', 'learning', 'new-module', 1, 'published', ?, ?)`)
        .run(packet.item_id, packet.run_id, packet.track, packet.prepared_at, packet.prepared_at);
    db.prepare(`INSERT INTO item_revision (item_id, item_revision, run_id, proposal_digest, artifact_digest,
        target_repository, target_path, lifecycle_key, record_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, '{}', ?)`)
        .run(packet.item_id, packet.run_id, packet.proposal_digest, packet.artifact_digest,
            packet.canonical_target.repository, packet.canonical_target.path, `${packet.track}:${packet.item_id}:r1:revision`, packet.prepared_at);
    for (const [gate, evidence, issue] of [['gate-1', packet.gate_1, 1], ['gate-2', packet.gate_2, 2]]) {
        db.prepare(`INSERT INTO decision_event (event_id, gate, run_id, item_id, item_revision, digest, decision,
            actor_provider, actor_immutable_id, source_repository, source_issue_number, source_comment_id,
            correlation_id, idempotency_key, occurred_at, record_json) VALUES (?, ?, ?, ?, 1, ?, 'approve',
            'github', '1001', 'project42dev/orchard', ?, ?, ?, ?, ?, '{}')`)
            .run(evidence.event_id, gate, packet.run_id, packet.item_id, evidence.digest, issue, `${gate}-comment`,
                packet.run_id, `decision:${gate}`, packet.prepared_at);
    }
    db.prepare(`INSERT INTO external_link (link_id, run_id, item_id, item_revision, provider, operation,
        external_key, external_id, lifecycle_key, idempotency_key, linked_at, record_json)
        VALUES ('link-1', ?, ?, 1, 'ado', 'user-story', ?, ?, ?, ?, ?, '{}')`)
        .run(packet.run_id, packet.item_id, packet.ado.external_key, String(packet.ado.work_item_id),
            `${packet.ado.external_key}:ado-link`, `ado-link:${packet.ado.external_key}`, packet.prepared_at);
    for (const handoff of input.handoffs) {
        db.prepare(`INSERT INTO agent_handoff (handoff_id, run_id, item_id, item_revision, role, input_digest,
            output_digest, predecessor_handoff_digest, idempotency_key, status, completed_at, record_json)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(handoff.handoff_id, handoff.run_id, handoff.item_id, handoff.role, handoff.input_digest,
                handoff.output_digest, handoff.predecessor_handoff_digest, `handoff:${handoff.handoff_id}`,
                handoff.status, handoff.completed_at, JSON.stringify(handoff));
    }
    store.recordArtifactBinding(input.artifactBinding);
    db.prepare(`INSERT INTO publication_transaction (transaction_id, idempotency_key, run_id, item_id,
        item_revision, gate2_decision_event_id, artifact_digest, proposal_digest, displayed_diff_digest,
        prepared_tree_digest, ado_external_key, handoff_chain_digest, full_manifest_digest, gate2_batch_digest,
        target_repository, target_path, base_commit, initial_state, record_json, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`)
        .run(packet.publication_transaction_id, input.publicationState.transaction.idempotency_key,
            packet.run_id, packet.item_id, packet.gate_2.event_id, packet.artifact_digest, packet.proposal_digest,
            packet.displayed_diff_digest, packet.prepared_tree_digest, packet.ado.external_key, packet.handoff_chain_digest,
            packet.gate_2.full_manifest_digest, packet.gate_2.batch_digest, packet.canonical_target.repository,
            packet.canonical_target.path, packet.base_commit, JSON.stringify(input.publicationState.transaction), packet.prepared_at);
    for (const event of input.publicationState.events) store.recordPublicationEvent(event);
    store.recordPublicationAuthority(packet.publication_transaction_id, store.getTrustAnchor('publication'));
    return store;
}

function acceptanceAuthority(packet, overrides = {}) {
    const record = {
        acceptance_id: '018f5000-0000-7000-8000-000000000001', packet_digest: packet.packet_digest,
        owner: { provider: 'github', immutable_id: '1001' },
        source: { provider: 'github', reference: 'project42dev/orchard#closure-comment-1' },
        accepted_at: '2026-08-12T11:02:00Z', ...(overrides.acceptance ?? {})
    };
    const verifiedEvent = {
        packet_digest: record.packet_digest, reference: record.source.reference, occurred_at: record.accepted_at,
        actor: { provider: record.owner.provider, immutable_id: record.owner.immutable_id },
        ...overrides.verified_event
    };
    record.source.evidence_digest = sha256Digest(verifiedEvent);
    return {
        acceptance: record, verified_event: verifiedEvent, owner_policy: overrides.owner_policy ?? ownerPolicy,
        trust: {
            owner_policy_digest: closureTrust.policy_digest, provider_event_digest: sha256Digest(verifiedEvent),
            adapter_digest: closureTrust.adapter_digest, adapter_identity: closureTrust.adapter_identity,
            ...overrides.trust
        }
    };
}

test('closure packet validates and fails closed on digest and lifecycle mutations', async () => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    assert.deepEqual(await validateRecord('closure-evidence-packet', packet), { valid: true, errors: [] });
    const changed = structuredClone(input); changed.artifact.scope_digest = digest('0');
    await assert.rejects(buildClosurePacket(changed), /scope digest/);
    const changedPublication = structuredClone(input); changedPublication.publicationState.push_acknowledgement.commit = '9'.repeat(40);
    await assert.rejects(buildClosurePacket(changedPublication), /acknowledgement|push/i);
});

test('Resolved preparation is dry-run by default and never auto-closes or auto-accepts', async (t) => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    const workItem = { id: 5101, externalKey: packet.ado.external_key, state: 'New', title: 'story' };
    const ado = new FakeAdoAdapter({ workItems: [workItem] });
    const store = seedStore(t, packet, input);
    const result = await prepareAdoResolved({ packet, adoWorkItem: workItem, adoAdapter: ado, store });
    assert.equal(result.operation, 'dry-run');
    assert.equal(ado.fakeClient.calls.length, 0);
    assert.equal(store.getClosurePacket(packet.packet_digest), null);
    assert.equal(store.getClosureAcceptance(packet.packet_digest), null);
});

test('Resolved update is exact, persists evidence, and timeout replay is idempotent', async (t) => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    const workItem = { id: 5101, externalKey: packet.ado.external_key, state: 'New', title: 'story' };
    const ado = new FakeAdoAdapter({ workItems: [workItem], scenarios: [{ operation: 'update', type: 'timeout-after' }] });
    const store = seedStore(t, packet, input);
    const result = await prepareAdoResolved({ packet, adoWorkItem: workItem, adoAdapter: ado, store, apply: true });
    assert.equal(result.closureReady, true);
    assert.equal(result.object.state, 'Resolved');
    assert.equal(result.object.completionNotes, closureCompletionNotes(packet));
    assert.equal(result.object.closurePacketDigest, packet.packet_digest);
    assert.deepEqual(store.getClosurePacket(packet.packet_digest), packet);
    const replay = await prepareAdoResolved({ packet, adoWorkItem: workItem, adoAdapter: ado, store, apply: true });
    assert.equal(replay.operation, 'already-updated');
    assert.equal(ado.fakeClient.calls.filter((call) => call.operation === 'update').length, 1);
});

test('closure requires explicit authorized current acceptance and reconciles Closed exactly once', async (t) => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    const initial = { id: 5101, externalKey: packet.ado.external_key, state: 'New', title: 'story' };
    const ado = new FakeAdoAdapter({ workItems: [initial], scenarios: [{ operation: 'update', type: 'timeout-after' }] });
    const store = seedStore(t, packet, input);
    const resolved = await prepareAdoResolved({ packet, adoWorkItem: initial, adoAdapter: ado, store, apply: true });
    const authority = acceptanceAuthority(packet);
    const explicit = authority.acceptance;
    const closed = await acceptAdoClosure({
        packet, acceptanceAuthority: authority, adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    });
    assert.equal(closed.object.state, 'Closed');
    assert.deepEqual(store.getClosureAcceptance(packet.packet_digest), explicit);
    const replay = await acceptAdoClosure({
        packet, acceptanceAuthority: authority, adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    });
    assert.equal(replay.operation, 'already-updated');
    assert.equal(ado.fakeClient.calls.filter((call) => call.operation === 'update').length, 2);
});

test('unauthorized, stale, and mismatched acceptance fail before Closed writes', async (t) => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    const initial = { id: 5101, externalKey: packet.ado.external_key, state: 'New' };
    const ado = new FakeAdoAdapter({ workItems: [initial] });
    const store = seedStore(t, packet, input);
    const resolved = await prepareAdoResolved({ packet, adoWorkItem: initial, adoAdapter: ado, store, apply: true });
    await assert.rejects(acceptAdoClosure({
        packet, acceptanceAuthority: acceptanceAuthority(packet, { owner_policy: { provider: 'github', authorized_owners: [{ provider: 'github', immutable_id: '9999' }] } }),
        adoWorkItem: resolved.object, adoAdapter: ado, store, apply: true
    }), /protected trust pins|authorized/);
    await assert.rejects(acceptAdoClosure({
        packet, acceptanceAuthority: acceptanceAuthority(packet, { acceptance: { accepted_at: '2026-08-12T10:00:00Z' } }),
        adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    }), /stale/);
    await assert.rejects(acceptAdoClosure({
        packet, acceptanceAuthority: acceptanceAuthority(packet, { acceptance: { packet_digest: digest('0') } }),
        adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    }), /bind/);
    assert.equal(ado.fakeClient.calls.filter((call) => call.operation === 'update').length, 1);
});

test('closure packet and acceptance persistence is exact replay-safe and append-only', async (t) => {
    const input = await buildInputs();
    const packet = await buildClosurePacket(input);
    const store = seedStore(t, packet, input);
    await store.recordClosurePacket(packet);
    await store.recordClosurePacket(packet);
    const authority = acceptanceAuthority(packet);
    const explicit = authority.acceptance;
    assert.throws(() => store.recordClosureAcceptance(explicit), /raw closure acceptance persistence is forbidden/);
    store.recordVerifiedClosureAcceptance(authority);
    store.recordVerifiedClosureAcceptance(authority);
    const conflictingPacket = { ...packet, packet_id: '018f4000-0000-7000-8000-000000000099', rollback_reference: 'changed' };
    conflictingPacket.packet_digest = closurePacketDigest(conflictingPacket);
    await assert.rejects(store.recordClosurePacket(conflictingPacket), IdempotencyConflictError);
    assert.throws(() => store.recordVerifiedClosureAcceptance(acceptanceAuthority(packet, {
        acceptance: { accepted_at: '2026-08-12T11:03:00Z' }
    })), IdempotencyConflictError);
    assert.throws(() => store.recordVerifiedClosureAcceptance(acceptanceAuthority(packet, {
        acceptance: {
            acceptance_id: '018f5000-0000-7000-8000-000000000099',
            owner: { provider: 'github', immutable_id: '1002', authorized: true }
        }
    })), /self-asserted owner authorization/);
    assert.throws(() => store.db.prepare('UPDATE closure_packet SET prepared_at = prepared_at').run(), /append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM closure_acceptance').run(), /append-only/);
    assert.equal(store.verify().ok, true);
});
