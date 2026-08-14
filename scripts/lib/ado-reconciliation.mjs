import { DatabaseSync } from 'node:sqlite';
import { assertValidRecord } from './contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './identity.mjs';
import { verifyGateManifestDigests } from './gates.mjs';

export function adoExternalKey(track, itemId, revision) {
    if (!['track-1', 'track-2'].includes(track)) throw new TypeError('track must be track-1 or track-2');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision must be positive');
    return `orchard:${track}:${itemId}:r${revision}`;
}

function fail(message) { throw new Error(`ADO reconciliation refused: ${message}`); }

export async function assertCurrentGate1Approval({ manifest, fullManifestItems, decision, currentItem }) {
    await assertValidRecord('gate-1-issue-manifest', manifest);
    verifyGateManifestDigests(manifest, fullManifestItems);
    await assertValidRecord('decision-event', decision);
    if (decision.gate !== 'gate-1' || decision.decision !== 'approve' || decision.previous_state !== 'gate1-pending' || decision.next_state !== 'gate1-approved') fail('an exact positive Gate 1 approval is required');
    if (decision.run_id !== manifest.run_id) fail('decision run does not match manifest');
    const matches = manifest.items.filter((item) => item.item_id === decision.item_id);
    if (matches.length !== 1) fail('approved item does not occur exactly once in manifest');
    const item = matches[0];
    if (item.decision_state !== 'pending') fail('reviewed manifest item was not pending');
    if (decision.item_revision !== item.item_revision) fail('approval revision is stale');
    if (decision.digest !== item.proposal_digest) fail('approval digest mismatch');
    if (decision.actor.authorized !== true) fail('decision actor is unauthorized');
    if (currentItem && canonicalJson(currentItem) !== canonicalJson(item)) fail('material item fields changed after approval');
    return item;
}

export function adoWorkItemFields({ manifest, decision, item, featureId }) {
    const externalKey = adoExternalKey(manifest.track, item.item_id, item.item_revision);
    return {
        externalKey,
        title: `[Orchard] ${item.title}`,
        type: 'User Story',
        state: 'New',
        parentFeatureId: featureId,
        bindings: {
            run_id: manifest.run_id, track: manifest.track, item_id: item.item_id, item_revision: item.item_revision,
            proposal_digest: item.proposal_digest, target: item.target, gate1_decision_event_id: decision.event_id,
        },
    };
}

export async function reconcileApprovedItem({ manifest, fullManifestItems, decision, currentItem, featureId, adoAdapter, organization, project, persistLink, apply = false }) {
    const item = await assertCurrentGate1Approval({ manifest, fullManifestItems, decision, currentItem });
    if (!Number.isSafeInteger(Number(featureId)) || Number(featureId) < 1) fail('a positive track Feature ID is required');
    const fields = adoWorkItemFields({ manifest, decision, item, featureId: Number(featureId) });
    const request = { externalKey: fields.externalKey, expected: fields, create: { fields }, organization, project };
    if (!apply) return { operation: 'dry-run', request, dispatchEligible: false };
    if (!adoAdapter) fail('--apply requires an injected authenticated ADO adapter');
    if (typeof persistLink !== 'function') fail('--apply requires durable external-link persistence');
    const reconciled = await adoAdapter.reconcileBeforeCreate(request);
    const adoId = Number(reconciled.object?.id);
    if (!Number.isSafeInteger(adoId) || adoId < 1) fail('ADO did not return a positive work item ID');
    const binding = {
        run_id: manifest.run_id, track: manifest.track, item_id: item.item_id, item_revision: item.item_revision,
        proposal_digest: item.proposal_digest, gate1_decision_event_id: decision.event_id, ado_external_key: fields.externalKey, ado_work_item_id: adoId,
        target: item.target
    };
    await persistLink(binding);
    return { ...reconciled, binding, dispatchEligible: true };
}

export function createSqliteExternalLinkPersister({ dbPath, now = () => new Date().toISOString(), idFactory = () => generateUuidV7() }) {
    return async (binding) => {
        const db = new DatabaseSync(dbPath);
        try {
            const existing = db.prepare("SELECT external_id, record_json FROM external_link WHERE provider = 'ado' AND external_key = ?").get(binding.ado_external_key);
            if (existing) {
                const record = JSON.parse(existing.record_json);
                if (Number(existing.external_id) !== binding.ado_work_item_id || canonicalJson(record.binding) !== canonicalJson(binding)) fail('stored ADO external link mismatches current exact binding');
                return record;
            }
            const linkedAt = now();
            const record = { binding, linked_at: linkedAt };
            db.prepare(`INSERT INTO external_link
        (link_id, run_id, item_id, item_revision, provider, operation, external_key, external_id,
         manifest_digest, artifact_digest, lifecycle_key, idempotency_key, linked_at, record_json)
        VALUES (?, ?, ?, ?, 'ado', 'user-story', ?, ?, ?, NULL, ?, ?, ?, ?)`)
                .run(idFactory(), binding.run_id, binding.item_id, binding.item_revision, binding.ado_external_key,
                    String(binding.ado_work_item_id), binding.proposal_digest, `${binding.ado_external_key}:ado-link`,
                    `ado-link:${sha256Digest(binding)}`, linkedAt, JSON.stringify(record));
            return record;
        } finally { db.close(); }
    };
}
