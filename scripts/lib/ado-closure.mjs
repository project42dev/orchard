import { assertValidRecord, closurePacketDigest } from './contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './identity.mjs';
import { assertAccountingReady, parseCanonicalUtcInstant } from './delivery-policy.mjs';
import { verifyGateManifestDigests } from './gates.mjs';
import { validateHandoffChain } from './handoffs.mjs';
import { PROTECTED_BRANCH, PUBLICATION_REPOSITORY } from './publication.mjs';

export class AdoClosureError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AdoClosureError';
        this.code = code;
    }
}

function fail(code, message) { throw new AdoClosureError(code, message); }
function exact(actual, expected, code, label) {
    if (canonicalJson(actual) !== canonicalJson(expected)) fail(code, `${label} mismatch`);
}
function positive(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) fail('closure.ado-id', `${label} must be a positive integer`);
    return number;
}
function boundItem(manifest, itemId) {
    const matches = manifest.items.filter((entry) => entry.item_id === itemId);
    if (matches.length !== 1) fail('closure.manifest-item', `${manifest.gate} must contain the item exactly once`);
    return matches[0];
}
function assertDecision(decision, gate, run, item, digest) {
    if (decision.gate !== gate || decision.decision !== 'approve' || decision.actor?.authorized !== true
        || decision.run_id !== run.run_id || decision.item_id !== item.item_id
        || decision.item_revision !== item.item_revision || decision.digest !== digest) {
        fail('closure.decision-binding', `${gate} decision is not the exact authorized approval`);
    }
}
function pullRequestFromPublication(publicationState) {
    const merged = [...publicationState.events].reverse().find((event) => event.phase === 'merge'
        && event.intent_or_result === 'result' && event.pull_request?.state === 'merged');
    const pull = merged?.pull_request;
    positive(pull?.number, 'pull request number');
    return pull;
}

export async function buildClosurePacket({ run, item, gate1Manifest, gate1Decision, handoffs, gate2Manifest,
    gate2Decision, adoBinding, artifact, artifactBinding, reviewedScopeDigest, publicationState,
    policy, qualificationRegistry, scope, roleEvidence, accounting, asOf, residualRisks = [],
    rollbackReference, packetId = generateUuidV7(), preparedAt = new Date().toISOString() }) {
    await assertValidRecord('run-manifest', run);
    await assertValidRecord('item-record', item);
    await assertValidRecord('gate-1-issue-manifest', gate1Manifest);
    await assertValidRecord('decision-event', gate1Decision);
    await assertValidRecord('gate-2-issue-manifest', gate2Manifest);
    await assertValidRecord('decision-event', gate2Decision);
    if (run.status !== 'completed') fail('closure.run', 'closure requires a completed run');
    verifyGateManifestDigests(gate1Manifest, gate1Manifest.items);
    verifyGateManifestDigests(gate2Manifest, gate2Manifest.items);
    const gate1Item = boundItem(gate1Manifest, item.item_id);
    const gate2Item = boundItem(gate2Manifest, item.item_id);
    for (const manifest of [gate1Manifest, gate2Manifest]) {
        if (manifest.run_id !== run.run_id || manifest.track !== run.track) fail('closure.run-binding', `${manifest.gate} run or track changed`);
    }
    for (const reviewed of [gate1Item, gate2Item]) {
        if (reviewed.item_revision !== item.item_revision || reviewed.proposal_digest !== item.proposal_digest) fail('closure.item-binding', 'reviewed item revision or proposal changed');
        exact(reviewed.target, item.target, 'closure.target-binding', 'reviewed canonical target');
    }
    if (item.run_id !== run.run_id || item.track !== run.track) fail('closure.item-binding', 'item run or track changed');
    assertDecision(gate1Decision, 'gate-1', run, item, item.proposal_digest);
    assertDecision(gate2Decision, 'gate-2', run, item, gate2Item.artifact_digest);
    if (!Array.isArray(handoffs) || handoffs.length === 0) fail('closure.handoffs', 'the complete handoff chain is required');
    for (let index = 0; index < handoffs.length; index += 1) {
        const handoff = handoffs[index];
        await assertValidRecord('agent-handoff', handoff);
        for (const key of ['run_id', 'item_id', 'item_revision', 'proposal_digest', 'gate1_decision_event_id', 'ado_external_key', 'ado_work_item_id']) {
            const expected = key === 'gate1_decision_event_id' ? gate1Decision.event_id : key in adoBinding ? adoBinding[key] : item[key];
            if (handoff[key] !== expected) fail('closure.handoff-binding', `handoff ${index} ${key} changed`);
        }
        const predecessor = index === 0 ? null : handoffs[index - 1].output_digest;
        if (handoff.predecessor_handoff_digest !== predecessor || handoff.status !== 'passed') fail('closure.handoff-binding', `handoff ${index} is not an exact passed chain member`);
    }
    const chain = await validateHandoffChain({ binding: adoBinding, handoffs, policy, qualificationRegistry, scope, roleEvidence, asOf });
    assertAccountingReady({ policy, accounting, itemId: item.item_id, handoffs });
    if (chain.handoff_chain_digest !== gate2Item.handoff_chain_digest) fail('closure.handoff-binding', 'recomputed handoff chain digest does not match Gate 2');
    if (handoffs.at(-1).output_digest !== gate2Item.artifact_digest) fail('closure.artifact-binding', 'final handoff output does not match the reviewed artifact');
    for (const key of ['proposal_digest', 'artifact_digest', 'displayed_diff_digest', 'prepared_tree_digest', 'base_commit']) {
        if (artifact[key] !== gate2Item[key]) fail('closure.artifact-binding', `artifact ${key} changed after Gate 2`);
    }
    exact(artifact.target, gate2Item.target, 'closure.artifact-binding', 'artifact target');
    exact(artifact.tests, gate2Item.tests, 'closure.review-binding', 'test evidence');
    exact(artifact.factual_review, gate2Item.factual_review, 'closure.review-binding', 'factual evidence');
    exact(artifact.accessibility_review, gate2Item.accessibility_review, 'closure.review-binding', 'accessibility evidence');
    if (artifact.scope_digest !== reviewedScopeDigest || !/^sha256:[a-f0-9]{64}$/.test(reviewedScopeDigest ?? '')) {
        fail('closure.scope-binding', 'reviewed scope digest does not match the artifact scope digest');
    }
    const expectedArtifactBinding = {
        run_id: run.run_id, item_id: item.item_id, item_revision: item.item_revision,
        artifact_digest: artifact.artifact_digest, final_handoff_id: handoffs.at(-1).handoff_id,
        final_handoff_digest: handoffs.at(-1).output_digest, scope_digest: reviewedScopeDigest,
    };
    if (!artifactBinding?.binding_id || !artifactBinding.idempotency_key) fail('closure.artifact-binding', 'persisted artifact binding is required');
    for (const [key, value] of Object.entries(expectedArtifactBinding)) {
        if (artifactBinding[key] !== value) fail('closure.artifact-binding', `artifact binding ${key} changed`);
    }
    if (gate2Item.tests.some((test) => test.status !== 'passed') || gate2Item.factual_review.status !== 'passed'
        || gate2Item.accessibility_review.status !== 'passed') fail('closure.review-binding', 'all tests and reviews must pass');
    const expectedAdoKey = `orchard:${run.track}:${item.item_id}:r${item.item_revision}`;
    if (adoBinding.ado_external_key !== expectedAdoKey || positive(adoBinding.ado_work_item_id, 'ADO work item ID') !== adoBinding.ado_work_item_id
        || gate2Item.ado_external_key !== expectedAdoKey) fail('closure.ado-binding', 'ADO binding changed');

    if (publicationState?.state !== 'published' || publicationState.push_acknowledgement?.status !== 'succeeded') {
        fail('closure.publication-state', 'exact protected-main publication acknowledgement is required');
    }
    const transaction = publicationState.transaction;
    const transactionExpected = {
        run_id: run.run_id, item_id: item.item_id, item_revision: item.item_revision,
        proposal_digest: item.proposal_digest, artifact_digest: gate2Item.artifact_digest,
        displayed_diff_digest: gate2Item.displayed_diff_digest, prepared_tree_digest: gate2Item.prepared_tree_digest,
        ado_external_key: expectedAdoKey, handoff_chain_digest: gate2Item.handoff_chain_digest,
        full_manifest_digest: gate2Manifest.full_manifest_digest, gate2_batch_digest: gate2Manifest.batch_digest,
        gate2_decision_event_id: gate2Decision.event_id,
    };
    for (const [key, value] of Object.entries(transactionExpected)) {
        if (transaction?.[key] !== value) fail('closure.publication-binding', `publication transaction ${key} changed`);
    }
    exact({ repository: transaction.target.repository, path: transaction.target.path }, item.target,
        'closure.publication-binding', 'publication target');
    if (transaction.target.protected_branch !== PROTECTED_BRANCH || transaction.target.repository !== PUBLICATION_REPOSITORY) {
        fail('closure.publication-binding', 'publication did not target protected main');
    }
    const pull = pullRequestFromPublication(publicationState);
    if (pull.repository !== PUBLICATION_REPOSITORY || pull.baseBranch !== PROTECTED_BRANCH
        || pull.displayedDiffDigest !== gate2Item.displayed_diff_digest || pull.preparedTreeDigest !== gate2Item.prepared_tree_digest
        || pull.mergeCommit !== publicationState.result_commit) fail('closure.pull-request-binding', 'merged pull request changed');
    exact(publicationState.push_acknowledgement, {
        repository: PUBLICATION_REPOSITORY, branch: PROTECTED_BRANCH, commit: publicationState.result_commit,
        status: 'succeeded', acknowledged_at: publicationState.push_acknowledgement.acknowledged_at,
    }, 'closure.push-binding', 'protected-main acknowledgement');
    if (!Array.isArray(residualRisks) || residualRisks.some((risk) => typeof risk !== 'string' || !risk)) fail('closure.residual-risks', 'residual risks must be an array of non-empty strings');
    if (!rollbackReference) fail('closure.rollback', 'rollback reference is required');

    const gate1At = parseCanonicalUtcInstant(gate1Decision.occurred_at, 'Gate 1 decision occurred_at');
    let previous = gate1At;
    for (const [index, handoff] of handoffs.entries()) {
        const started = parseCanonicalUtcInstant(handoff.started_at, `handoff ${index} started_at`);
        const completed = parseCanonicalUtcInstant(handoff.completed_at, `handoff ${index} completed_at`);
        if (started < previous || completed < started) fail('closure.timestamp-order', 'handoff timestamps are not canonical and ordered after Gate 1');
        previous = completed;
    }
    const bindingAt = parseCanonicalUtcInstant(artifactBinding.occurred_at, 'artifact binding occurred_at');
    const gate2At = parseCanonicalUtcInstant(gate2Decision.occurred_at, 'Gate 2 decision occurred_at');
    const acknowledgedAt = parseCanonicalUtcInstant(publicationState.push_acknowledgement.acknowledged_at, 'publication acknowledged_at');
    const prepared = parseCanonicalUtcInstant(preparedAt, 'closure packet prepared_at');
    if (bindingAt < previous || gate2At < bindingAt || acknowledgedAt < gate2At || prepared < acknowledgedAt) {
        fail('closure.timestamp-order', 'closure evidence timestamps are not in lifecycle order');
    }

    const packet = {
        schema_version: '1.0.0', packet_id: packetId, run_id: run.run_id, track: run.track,
        item_id: item.item_id, item_revision: item.item_revision, proposal_digest: item.proposal_digest,
        artifact_digest: gate2Item.artifact_digest, scope_digest: reviewedScopeDigest,
        handoff_chain_digest: gate2Item.handoff_chain_digest, handoff_ids: handoffs.map((handoff) => handoff.handoff_id),
        displayed_diff_digest: gate2Item.displayed_diff_digest, prepared_tree_digest: gate2Item.prepared_tree_digest,
        base_commit: gate2Item.base_commit, artifact_binding: structuredClone(artifactBinding),
        gate_1: {
            event_id: gate1Decision.event_id, digest: gate1Decision.digest,
            full_manifest_digest: gate1Manifest.full_manifest_digest, batch_digest: gate1Manifest.batch_digest
        },
        gate_2: {
            event_id: gate2Decision.event_id, digest: gate2Decision.digest,
            full_manifest_digest: gate2Manifest.full_manifest_digest, batch_digest: gate2Manifest.batch_digest
        },
        ado: { external_key: expectedAdoKey, work_item_id: adoBinding.ado_work_item_id },
        tests: structuredClone(gate2Item.tests), factual_evidence: structuredClone(gate2Item.factual_review),
        accessibility_evidence: structuredClone(gate2Item.accessibility_review),
        canonical_target: { ...structuredClone(item.target), protected_branch: PROTECTED_BRANCH },
        pull_request: { number: pull.number, url: `https://github.com/${PUBLICATION_REPOSITORY}/pull/${pull.number}` },
        publication_transaction_id: transaction.transaction_id, protected_main_commit: publicationState.result_commit,
        push_acknowledgement: structuredClone(publicationState.push_acknowledgement),
        residual_risks: [...residualRisks], rollback_reference: rollbackReference, prepared_at: preparedAt,
    };
    packet.packet_digest = closurePacketDigest(packet);
    await assertValidRecord('closure-evidence-packet', packet);
    return packet;
}

export function closureCompletionNotes(packet) {
    return canonicalJson({
        closure_packet_digest: packet.packet_digest,
        publication_transaction_id: packet.publication_transaction_id,
        protected_main_commit: packet.protected_main_commit,
        pull_request: packet.pull_request,
        tests: packet.tests,
        factual_evidence: packet.factual_evidence,
        accessibility_evidence: packet.accessibility_evidence,
        residual_risks: packet.residual_risks,
        rollback_reference: packet.rollback_reference,
    });
}

function assertAdoBinding(packet, workItem, expectedState) {
    if (workItem?.externalKey !== packet.ado.external_key || positive(workItem?.id, 'ADO work item ID') !== packet.ado.work_item_id) {
        fail('closure.ado-binding', 'ADO work item does not match the closure packet');
    }
    if (workItem.state !== expectedState) fail('closure.ado-state', `ADO work item must be ${expectedState}`);
}

function closureAdoEvent(packet, state, result, occurredAt) {
    return {
        schema_version: '1.0.0', event_id: `closure-ado:${packet.packet_id}:${state}`,
        packet_digest: packet.packet_digest, state, ado_work_item_id: packet.ado.work_item_id,
        ado_external_key: packet.ado.external_key, result_digest: sha256Digest(result), occurred_at: occurredAt,
        idempotency_key: `closure-ado:${packet.packet_digest}:${state}`, result: structuredClone(result),
    };
}

function recordReconciledClosureEvent(store, packet, state, result, occurredAt) {
    const existing = store.listClosureAdoEvents(packet.packet_digest).find((event) => event.state === state);
    if (existing) exact(result, existing.result, 'closure.ado-replay', `${state} ADO result`);
    return store.recordClosureAdoEvent(existing ?? closureAdoEvent(packet, state, result, occurredAt));
}

export async function prepareAdoResolved({ packet, adoWorkItem, adoAdapter, store, organization, project, apply = false,
    now = () => new Date().toISOString() }) {
    await assertValidRecord('closure-evidence-packet', packet);
    assertAdoBinding(packet, adoWorkItem, 'New');
    const notes = closureCompletionNotes(packet);
    const expectedUpdated = { ...structuredClone(adoWorkItem), state: 'Resolved', completionNotes: notes, closurePacketDigest: packet.packet_digest };
    const request = {
        externalKey: packet.ado.external_key, expectedCurrent: adoWorkItem, expectedUpdated,
        update: { fields: { state: 'Resolved', completionNotes: notes, closurePacketDigest: packet.packet_digest } }, organization, project
    };
    if (!apply) return { operation: 'dry-run', request, closureReady: false };
    if (!adoAdapter || !store) fail('closure.apply', 'apply requires injected ADO adapter and persistence');
    await store.recordClosurePacket(packet);
    const result = await adoAdapter.reconcileBeforeUpdate(request);
    recordReconciledClosureEvent(store, packet, 'Resolved', result.object, now());
    return { ...result, packet, closureReady: true };
}

export async function acceptAdoClosure({ packet, acceptanceAuthority, adoWorkItem, adoAdapter, store,
    organization, project, apply = false, now = () => new Date().toISOString() }) {
    await assertValidRecord('closure-evidence-packet', packet);
    if (!store) fail('closure.acceptance-authority', 'closure acceptance requires the protected Orchard authority store');
    const { record: acceptance } = store.validateClosureAcceptanceAuthority(acceptanceAuthority);
    if (!acceptance || acceptance.packet_digest !== packet.packet_digest) fail('closure.acceptance-binding', 'acceptance does not bind the current packet digest');
    if (!acceptance.acceptance_id || !acceptance.accepted_at
        || parseCanonicalUtcInstant(acceptance.accepted_at, 'acceptance accepted_at') < parseCanonicalUtcInstant(packet.prepared_at, 'packet prepared_at')
        || !acceptance.source?.provider || !acceptance.source?.reference || !/^sha256:[a-f0-9]{64}$/.test(acceptance.source?.evidence_digest ?? '')) {
        fail('closure.acceptance-evidence', 'acceptance is stale or lacks exact source evidence');
    }
    assertAdoBinding(packet, adoWorkItem, 'Resolved');
    if (adoWorkItem.closurePacketDigest !== packet.packet_digest || adoWorkItem.completionNotes !== closureCompletionNotes(packet)) {
        fail('closure.acceptance-stale', 'resolved ADO evidence does not match the accepted packet');
    }
    const acceptanceDigest = sha256Digest(acceptance);
    const expectedUpdated = { ...structuredClone(adoWorkItem), state: 'Closed', closureAcceptanceDigest: acceptanceDigest };
    const request = {
        externalKey: packet.ado.external_key, expectedCurrent: adoWorkItem, expectedUpdated,
        update: { fields: { state: 'Closed', closureAcceptanceDigest: acceptanceDigest } }, organization, project
    };
    if (!apply) return { operation: 'dry-run', request, accepted: false };
    if (!adoAdapter) fail('closure.apply', 'apply requires injected ADO adapter and persistence');
    const persistedPacket = store.getClosurePacket(packet.packet_digest);
    if (!persistedPacket || canonicalJson(persistedPacket) !== canonicalJson(packet)) fail('closure.acceptance-stale', 'current closure packet is not durably persisted');
    store.recordVerifiedClosureAcceptance(acceptanceAuthority);
    const result = await adoAdapter.reconcileBeforeUpdate(request);
    recordReconciledClosureEvent(store, packet, 'Closed', result.object, now());
    return { ...result, acceptance, accepted: true };
}
