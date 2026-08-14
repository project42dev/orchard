import { assertValidRecord } from './contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './identity.mjs';
import { assertAccountingReady, deliveryScopeDigest, parseCanonicalUtcInstant, validateDeliveryChain } from './delivery-policy.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(message) { throw new Error(`handoff binding refused: ${message}`); }

export async function createAgentHandoff({ binding, role, model, promptVersion, input, output, predecessor = null,
    status, findings = [], startedAt, completedAt, handoffId = generateUuidV7() }) {
    if (!binding || !Number.isSafeInteger(binding.ado_work_item_id) || binding.ado_work_item_id < 1) fail('positive reconciled ADO work item ID is required');
    const expectedKey = `orchard:${binding.track}:${binding.item_id}:r${binding.item_revision}`;
    if (binding.ado_external_key !== expectedKey) fail('ADO external key does not match item revision');
    if (predecessor && (predecessor.run_id !== binding.run_id || predecessor.item_id !== binding.item_id
        || predecessor.item_revision !== binding.item_revision || predecessor.proposal_digest !== binding.proposal_digest
        || predecessor.gate1_decision_event_id !== binding.gate1_decision_event_id
        || predecessor.ado_external_key !== binding.ado_external_key || predecessor.ado_work_item_id !== binding.ado_work_item_id)) {
        fail('predecessor belongs to a different lifecycle binding');
    }
    const started = parseCanonicalUtcInstant(startedAt, 'handoff started_at');
    const completed = parseCanonicalUtcInstant(completedAt, 'handoff completed_at');
    if (completed < started) fail('handoff completed_at must be at or after started_at');
    const record = {
        schema_version: '1.0.0', handoff_id: handoffId, run_id: binding.run_id, item_id: binding.item_id,
        item_revision: binding.item_revision, proposal_digest: binding.proposal_digest,
        gate1_decision_event_id: binding.gate1_decision_event_id, ado_external_key: binding.ado_external_key,
        ado_work_item_id: binding.ado_work_item_id, role, model, prompt_version: promptVersion,
        input_digest: DIGEST.test(input) ? input : sha256Digest(input), output_digest: DIGEST.test(output) ? output : sha256Digest(output),
        predecessor_handoff_digest: predecessor?.output_digest ?? null, status, findings, started_at: startedAt, completed_at: completedAt,
    };
    await assertValidRecord('agent-handoff', record);
    return record;
}

export async function validateHandoffChain({ binding, handoffs, policy, qualificationRegistry, scope, roleEvidence, asOf }) {
    if (!Array.isArray(handoffs) || handoffs.length === 0) fail('at least one handoff is required');
    const ids = new Set();
    for (let index = 0; index < handoffs.length; index += 1) {
        const handoff = handoffs[index];
        await assertValidRecord('agent-handoff', handoff);
        const started = parseCanonicalUtcInstant(handoff.started_at, `handoff ${index} started_at`);
        const completed = parseCanonicalUtcInstant(handoff.completed_at, `handoff ${index} completed_at`);
        if (completed < started) fail(`handoff ${index} completed_at must be at or after started_at`);
        if (ids.has(handoff.handoff_id)) fail('duplicate handoff ID');
        ids.add(handoff.handoff_id);
        for (const key of ['run_id', 'item_id', 'item_revision', 'proposal_digest', 'gate1_decision_event_id', 'ado_external_key', 'ado_work_item_id']) {
            if (handoff[key] !== binding[key]) fail(`${key} mismatch at handoff ${index}`);
        }
        const expectedPredecessor = index === 0 ? null : handoffs[index - 1].output_digest;
        if (handoff.predecessor_handoff_digest !== expectedPredecessor) fail(`predecessor digest mismatch at handoff ${index}`);
    }
    const delivery = await validateDeliveryChain({ policy, qualificationRegistry, handoffs, scope, roleEvidence, asOf });
    const handoff_chain_digest = sha256Digest({
        handoffs: handoffs.map((handoff) => sha256Digest(handoff)), scope: delivery.scope_digest,
        policy: sha256Digest(policy), qualifications: sha256Digest(qualificationRegistry), evidence: delivery.evidence_digest,
    });
    return { handoffs, handoff_chain_digest, delivery };
}

export function createArtifactBinding({ binding, finalHandoff, artifact, bindingId = generateUuidV7(), occurredAt = new Date().toISOString() }) {
    if (!finalHandoff || finalHandoff.run_id !== binding.run_id || finalHandoff.item_id !== binding.item_id
        || finalHandoff.item_revision !== binding.item_revision || finalHandoff.output_digest !== artifact.artifact_digest) {
        fail('artifact binding requires the exact producing final handoff');
    }
    const record = {
        schema_version: '1.0.0', binding_id: bindingId, run_id: binding.run_id, item_id: binding.item_id,
        item_revision: binding.item_revision, artifact_digest: artifact.artifact_digest,
        final_handoff_id: finalHandoff.handoff_id, final_handoff_digest: finalHandoff.output_digest,
        scope_digest: artifact.scope_digest, occurred_at: occurredAt,
    };
    record.idempotency_key = `artifact-binding:${binding.track}:${binding.item_id}:r${binding.item_revision}:${sha256Digest(record)}`;
    return record;
}

export async function prepareGate2Item({ binding, handoffs, artifact, policy, qualificationRegistry, scope, roleEvidence, accounting, asOf,
    store, artifactBindingId, artifactBindingOccurredAt }) {
    const chain = await validateHandoffChain({ binding, handoffs, policy, qualificationRegistry, scope, roleEvidence, asOf });
    assertAccountingReady({ policy, accounting, itemId: binding.item_id, handoffs });
    const last = handoffs.at(-1);
    if (last.status !== 'passed') fail('final handoff did not pass');
    if (artifact.proposal_digest !== binding.proposal_digest) fail('artifact proposal digest mismatch');
    if (artifact.scope_digest !== deliveryScopeDigest(scope)) fail('artifact scope digest mismatch');
    if (artifact.artifact_digest !== last.output_digest) fail('artifact digest must equal final handoff output digest');
    if (canonicalJson(artifact.target) !== canonicalJson(binding.target)) fail('artifact target changed after Gate 1');
    if (!Array.isArray(artifact.tests) || artifact.tests.length === 0 || artifact.tests.some((test) => test.status !== 'passed')) fail('all required tests must pass');
    if (artifact.factual_review?.status !== 'passed') fail('factual review must pass');
    if (artifact.accessibility_review?.status !== 'passed') fail('accessibility review must pass');
    if (artifact.cost?.currency !== 'USD'
        || Math.round(artifact.cost.amount * 1_000_000) !== Math.round(accounting.by_item[binding.item_id].usd_spend * 1_000_000)) {
        fail('artifact cost must equal deterministic item accounting');
    }
    const artifactBinding = createArtifactBinding({
        binding, finalHandoff: last, artifact,
        ...(artifactBindingId ? { bindingId: artifactBindingId } : {}),
        ...(artifactBindingOccurredAt ? { occurredAt: artifactBindingOccurredAt } : {})
    });
    if (store) await store.recordArtifactBinding(artifactBinding);
    return {
        item_id: binding.item_id, item_revision: binding.item_revision, artifact_digest: artifact.artifact_digest,
        proposal_digest: binding.proposal_digest, displayed_diff_digest: artifact.displayed_diff_digest,
        prepared_tree_digest: artifact.prepared_tree_digest, target: binding.target, base_commit: artifact.base_commit,
        diff_ref: artifact.diff_ref, artifact_ref: artifact.artifact_ref, ado_external_key: binding.ado_external_key,
        handoff_chain_digest: chain.handoff_chain_digest, tests: artifact.tests, factual_review: artifact.factual_review,
        accessibility_review: artifact.accessibility_review, cost: artifact.cost, decision_state: 'pending',
    };
}
