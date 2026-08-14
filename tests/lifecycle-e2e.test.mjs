import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdoAdapter } from '../scripts/adapters/fake-ado-adapter.mjs';
import { acceptAdoClosure, closureCompletionNotes, prepareAdoResolved } from '../scripts/lib/ado-closure.mjs';
import { closurePacketDigest, loadJson } from '../scripts/lib/contracts.mjs';
import { generateGateManifests } from '../scripts/lib/gates.mjs';
import { sha256Digest } from '../scripts/lib/identity.mjs';
import { runTrack1 } from '../scripts/lib/track-1-controller.mjs';
import { StateStore } from '../scripts/lib/state-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const gatePolicy = { provider: 'github', repository: 'project42dev/orchard', authorized_actor_ids: ['1001'] };
const gateTrust = {
    authorization_policy_digest: sha256Digest(gatePolicy), adapter_digest: digest('8'),
    adapter_identity: 'test:protected-github-adapter:v1'
};
const ownerPolicy = { provider: 'github', authorized_owners: [{ provider: 'github', immutable_id: '1001' }] };
const closureTrust = {
    policy_digest: sha256Digest(ownerPolicy), adapter_digest: digest('7'),
    adapter_identity: 'test:protected-closure-adapter:v1'
};
const publicationTrust = {
    scope: 'publication', adapter_identity: 'test:protected-publication-adapter:v1',
    adapter_digest: digest('6'), provisioned_at: '2026-08-01T00:00:00.000Z'
};

function transition(packet, ordinal, from, to, cause) {
    return {
        schema_version: '1.0.0', transition_id: `018f6000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`,
        run_id: packet.run_id, item_id: packet.item_id, item_revision: 1, from_state: from, to_state: to,
        cause, actor: 'lifecycle-e2e', occurred_at: `2026-08-12T10:${String(ordinal).padStart(2, '0')}:00Z`,
        correlation_id: packet.run_id,
    };
}

function decision(packet, gate, previousState, nextState, ordinal) {
    const evidence = gate === 'gate-1' ? packet.gate_1 : packet.gate_2;
    return {
        schema_version: '1.0.0', event_id: evidence.event_id, gate, run_id: packet.run_id,
        item_id: packet.item_id, item_revision: 1, digest: evidence.digest, decision: 'approve', reason: null,
        review_after: null, actor: { provider: 'github', immutable_id: '1001', authorized: true },
        source: {
            repository: 'project42dev/orchard', issue_number: ordinal,
            comment_id: `closure-e2e-${gate}`, comment_digest: digest(String(ordinal))
        },
        occurred_at: `2026-08-12T10:${String(ordinal).padStart(2, '0')}:00Z`, previous_state: previousState,
        next_state: nextState, supersedes_event_id: null, correlation_id: packet.run_id,
    };
}

function gateAuthority(packet, manifest, reviewedItem, gate, previousState, nextState, ordinal) {
    const record = decision(packet, gate, previousState, nextState, ordinal);
    const body = `/orchard ${gate.replace('-', '')} approve item=${packet.item_id} revision=1 digest=${record.digest}`;
    record.source.comment_digest = sha256Digest(body);
    const verifiedEvent = {
        body, repository: record.source.repository, comment_id: record.source.comment_id,
        actor: { immutable_id: record.actor.immutable_id }
    };
    return {
        schema_version: '1.0.0', queue_work_item_id: gate === 'gate-1' ? 77 : null,
        manifest, full_manifest_items: [structuredClone(reviewedItem)], current_item: structuredClone(reviewedItem),
        decision: record, verified_event: verifiedEvent, authorization_policy: gatePolicy,
        trust: { ...gateTrust, provider_event_digest: sha256Digest(verifiedEvent) }
    };
}

function closureAcceptanceAuthority(packet) {
    const acceptance = {
        acceptance_id: '018f9000-0000-7000-8000-000000000001', packet_digest: packet.packet_digest,
        owner: { provider: 'github', immutable_id: '1001' },
        source: { provider: 'github', reference: 'project42dev/orchard#owner-closure-acceptance' },
        accepted_at: '2026-08-12T11:02:00Z'
    };
    const verifiedEvent = {
        packet_digest: acceptance.packet_digest, reference: acceptance.source.reference,
        occurred_at: acceptance.accepted_at, actor: structuredClone(acceptance.owner)
    };
    acceptance.source.evidence_digest = sha256Digest(verifiedEvent);
    return {
        acceptance, verified_event: verifiedEvent, owner_policy: ownerPolicy,
        trust: {
            owner_policy_digest: closureTrust.policy_digest, provider_event_digest: sha256Digest(verifiedEvent),
            adapter_digest: closureTrust.adapter_digest, adapter_identity: closureTrust.adapter_identity
        }
    };
}

test('full Track 1 closes only after exact publication evidence and explicit owner-accepted ADO closure', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'orchard-lifecycle-e2e-'));
    const store = new StateStore(join(root, 'content.db'));
    store.provisionTrustAnchor({
        scope: 'gate', adapter_identity: gateTrust.adapter_identity, adapter_digest: gateTrust.adapter_digest,
        policy_digest: gateTrust.authorization_policy_digest, policy: gatePolicy,
        provisioned_at: '2026-08-01T00:00:00.000Z'
    });
    store.provisionTrustAnchor(publicationTrust);
    store.provisionTrustAnchor({
        scope: 'closure', adapter_identity: closureTrust.adapter_identity, adapter_digest: closureTrust.adapter_digest,
        policy_digest: closureTrust.policy_digest, policy: ownerPolicy,
        provisioned_at: '2026-08-01T00:00:00.000Z'
    });
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    const packet = structuredClone(await loadJson(new URL('../contracts/fixtures/closure-evidence-packet.valid.json', import.meta.url)));
    const sources = Array.from({ length: 50 }, (_, index) => ({
        id: `source-${String(index + 1).padStart(2, '0')}`, enabled: true,
        url: `https://source-${String(index + 1).padStart(2, '0')}.example.test/`,
        policy: { approval: 'versioned-registry-entry', allowedHosts: [`source-${String(index + 1).padStart(2, '0')}.example.test`] },
    }));
    let tick = 0;
    const track1 = await runTrack1({
        mode: 'full', runId: packet.run_id, registry: { registryVersion: '1.0.0', approvedSources: sources },
        stateStore: store, now: () => new Date(Date.UTC(2026, 7, 12, 8, 0, tick++)),
        fetchAdapter: async (source) => ({
            kind: 'success', status: 200, finalUrl: source.url,
            redirects: 0, bytes: 2, durationMs: 1, body: 'ok'
        }),
        limits: { maxSources: 50, maxFailures: 1, maxBytes: 100, timeoutMs: 100 },
        contentCommit: '1'.repeat(40), implementationCommit: '2'.repeat(40),
    });
    assert.equal(track1.status, 'completed');
    assert.equal(track1.run.coverage.approved_enabled_source_count, 50);
    assert.equal(track1.run.coverage.attempted, 50);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run_outcome WHERE run_id = ?').get(packet.run_id).n, 50);

    const item = {
        schema_version: '1.0.0', item_id: packet.item_id, run_id: packet.run_id, track: 'track-1', item_revision: 1,
        semantic_identity: `sid:v1:${'a'.repeat(64)}`, canonical_content_id: null, surface: 'learning', outcome: 'new-module',
        state: 'gate1-pending', proposal_digest: packet.proposal_digest, artifact_digest: packet.artifact_digest,
        target: { repository: packet.canonical_target.repository, path: packet.canonical_target.path },
        evidence: [{ reference: 'evidence/source/full-track-1', digest: digest('a') }], supersedes_item_id: null,
        superseded_by_item_id: null, created_at: '2026-08-12T09:00:00Z', updated_at: '2026-08-12T09:00:00Z',
    };
    await store.recordItem(item);
    const gate1Item = {
        item_id: item.item_id, item_revision: 1, proposal_digest: item.proposal_digest, category: 'addition',
        title: 'Lifecycle proposal', rationale: 'Exact end-to-end authority evidence',
        evidence_refs: ['evidence/source/full-track-1'], score: { formula_version: '1.0.0', value: 1 },
        target: item.target, risks: [], estimated_cost: { currency: 'USD', amount: 0 }, decision_state: 'pending'
    };
    const [gate1Manifest] = await generateGateManifests({ gate: 'gate-1', runId: packet.run_id, track: 'track-1', items: [gate1Item] });
    packet.gate_1.full_manifest_digest = gate1Manifest.full_manifest_digest;
    packet.gate_1.batch_digest = gate1Manifest.batch_digest;
    await store.recordVerifiedDecision(gateAuthority(packet, gate1Manifest, gate1Item, 'gate-1', 'gate1-pending', 'gate1-approved', 1));

    const link = {
        link_id: '018f7000-0000-7000-8000-000000000001', run_id: packet.run_id,
        item_id: packet.item_id, item_revision: 1, provider: 'ado', operation: 'user-story',
        external_key: packet.ado.external_key, external_id: packet.ado.work_item_id,
        linked_at: '2026-08-12T10:02:00Z'
    };
    store.recordExternalLink(link);
    store.recordExternalLink(link);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM external_link WHERE provider = 'ado'").get().n, 1);
    await store.recordTransition(transition(packet, 2, 'gate1-approved', 'ado-linked', 'ado-reconciled'));
    await store.recordTransition(transition(packet, 3, 'ado-linked', 'executing', 'execution-started'));

    const handoff = structuredClone(await loadJson(new URL('../contracts/fixtures/agent-handoff.valid.json', import.meta.url)));
    Object.assign(handoff, {
        run_id: packet.run_id, item_id: packet.item_id, item_revision: 1,
        proposal_digest: packet.proposal_digest, gate1_decision_event_id: packet.gate_1.event_id,
        ado_external_key: packet.ado.external_key, ado_work_item_id: packet.ado.work_item_id,
        predecessor_handoff_digest: null, output_digest: packet.artifact_digest
    });
    await store.recordHandoff(handoff);
    await store.recordArtifactBinding(packet.artifact_binding);
    await store.recordTransition(transition(packet, 4, 'executing', 'gate2-ready', 'artifact-ready'));
    await store.recordTransition(transition(packet, 5, 'gate2-ready', 'gate2-pending', 'proposal-ready'));
    const gate2Item = {
        item_id: item.item_id, item_revision: 1, artifact_digest: item.artifact_digest,
        proposal_digest: item.proposal_digest, displayed_diff_digest: packet.displayed_diff_digest,
        prepared_tree_digest: packet.prepared_tree_digest, target: item.target, base_commit: packet.base_commit,
        diff_ref: 'evidence/diff', artifact_ref: 'evidence/artifact', ado_external_key: packet.ado.external_key,
        handoff_chain_digest: packet.handoff_chain_digest,
        tests: packet.tests, factual_review: packet.factual_evidence, accessibility_review: packet.accessibility_evidence,
        cost: { currency: 'USD', amount: 0 }, decision_state: 'pending'
    };
    const [gate2Manifest] = await generateGateManifests({ gate: 'gate-2', runId: packet.run_id, track: 'track-1', items: [gate2Item] });
    packet.gate_2.full_manifest_digest = gate2Manifest.full_manifest_digest;
    packet.gate_2.batch_digest = gate2Manifest.batch_digest;
    packet.packet_digest = closurePacketDigest(packet);
    await store.recordVerifiedDecision(gateAuthority(packet, gate2Manifest, gate2Item, 'gate-2', 'gate2-pending', 'gate2-approved', 2));

    const publicationIdempotencyKey = `publication:track-1:${packet.item_id}:r1:${packet.artifact_digest}`;
    const branch = `orchard/publication/track-1/${packet.item_id}/r1-${packet.artifact_digest.slice(7, 23)}`;
    const publicationRecord = {
        schema_version: '1.0.0', transaction_id: packet.publication_transaction_id,
        idempotency_key: publicationIdempotencyKey, run_id: packet.run_id, item_id: packet.item_id,
        item_revision: 1, gate2_decision_event_id: packet.gate_2.event_id,
        artifact_digest: packet.artifact_digest, proposal_digest: packet.proposal_digest,
        displayed_diff_digest: packet.displayed_diff_digest, prepared_tree_digest: packet.prepared_tree_digest,
        ado_external_key: packet.ado.external_key, handoff_chain_digest: packet.handoff_chain_digest,
        full_manifest_digest: packet.gate_2.full_manifest_digest, gate2_batch_digest: packet.gate_2.batch_digest,
        target: { repository: packet.canonical_target.repository, path: packet.canonical_target.path, protected_branch: 'main', branch },
        base_commit: packet.base_commit, pull_request: null, result_commit: null, push_acknowledgement: null,
        state: 'created', history: [{ state: 'created', occurred_at: '2026-08-12T10:06:00Z', actor: 'orchard', correlation_id: packet.publication_transaction_id }],
        created_at: '2026-08-12T10:06:00Z', updated_at: '2026-08-12T10:06:00Z'
    };
    await store.recordPublicationTransaction(publicationRecord);
    store.recordPublicationAuthority(packet.publication_transaction_id, store.getTrustAnchor('publication'));
    for (const [ordinal, from, to, cause] of [
        [6, 'gate2-approved', 'publication-preparing', 'publication-started'],
        [7, 'publication-preparing', 'publication-validating', 'validation-passed'],
        [8, 'publication-validating', 'publication-pr-open', 'pr-reconciled'],
        [9, 'publication-pr-open', 'publication-merging', 'merge-started'],
        [10, 'publication-merging', 'published', 'publication-acknowledged'],
    ]) await store.recordTransition(transition(packet, ordinal, from, to, cause));
    store.recordPublicationEvent({
        event_id: '018f8000-0000-7000-8000-000000000001',
        transaction_id: packet.publication_transaction_id, phase: 'merge', state: 'publication-merging',
        intent_or_result: 'result', correlation_id: packet.run_id, occurred_at: '2026-08-12T10:09:00Z',
        pull_request: {
            number: 42, repository: packet.canonical_target.repository, baseBranch: 'main',
            state: 'merged', mergeCommit: packet.protected_main_commit
        }
    });
    store.recordPublicationEvent({
        event_id: '018f8000-0000-7000-8000-000000000002',
        transaction_id: packet.publication_transaction_id, phase: 'acknowledge', state: 'published',
        intent_or_result: 'result', correlation_id: packet.run_id, occurred_at: '2026-08-12T11:00:00Z',
        result_commit: packet.protected_main_commit, push_acknowledgement: packet.push_acknowledgement
    });
    const publication = store.getPublicationState(publicationIdempotencyKey);
    assert.equal(publication.state, 'published');
    assert.equal(publication.result_commit, packet.protected_main_commit);
    assert.equal(publication.push_acknowledgement.branch, 'main');

    const initialAdo = {
        id: packet.ado.work_item_id, externalKey: packet.ado.external_key,
        state: 'New', type: 'User Story', title: 'Deterministic lifecycle'
    };
    const ado = new FakeAdoAdapter({ workItems: [initialAdo] });
    const resolved = await prepareAdoResolved({ packet, adoWorkItem: initialAdo, adoAdapter: ado, store, apply: true });
    assert.equal(resolved.object.state, 'Resolved');
    assert.equal(resolved.object.closurePacketDigest, packet.packet_digest);
    assert.equal(resolved.object.completionNotes, closureCompletionNotes(packet));
    assert.equal(store.getClosureAcceptance(packet.packet_digest), null);
    assert.notEqual(resolved.object.state, 'Closed');
    await store.recordTransition(transition(packet, 11, 'published', 'ado-closure-ready', 'closure-evidence-ready'));

    const acceptanceAuthority = closureAcceptanceAuthority(packet);
    const acceptance = acceptanceAuthority.acceptance;
    const closed = await acceptAdoClosure({
        packet, acceptanceAuthority, adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    });
    assert.equal(closed.object.state, 'Closed');
    await store.recordTransition(transition(packet, 12, 'ado-closure-ready', 'closed', 'closure-accepted'));
    assert.equal(store.getItem(packet.item_id).state, 'closed');
    assert.deepEqual(store.getClosureAcceptance(packet.packet_digest), acceptance);
    assert.equal(store.verify().ok, true);

    const replay = await acceptAdoClosure({
        packet, acceptanceAuthority, adoWorkItem: resolved.object,
        adoAdapter: ado, store, apply: true
    });
    assert.equal(replay.operation, 'already-updated');
    assert.equal(ado.fakeClient.calls.filter((call) => call.operation === 'update').length, 2);
});
