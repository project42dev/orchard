import { assertValidRecord, ContractValidationError } from './contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './identity.mjs';
import { verifyGateManifestDigests } from './gates.mjs';

export const PUBLICATION_REPOSITORY = 'project42dev/project42-platform';
export const PROTECTED_BRANCH = 'main';

export class PublicationAuthorityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PublicationAuthorityError';
        this.code = code;
    }
}

function fail(code, message) { throw new PublicationAuthorityError(code, message); }
function exact(actual, expected, code, label) {
    if (canonicalJson(actual) !== canonicalJson(expected)) fail(code, `${label} mismatch`);
}
function requireGitCommit(value, label) {
    if (!/^[a-f0-9]{40}$/.test(value ?? '')) fail('publication.git-commit', `${label} must be an exact lowercase 40-character Git commit`);
    return value;
}

export function publicationIdempotencyKey({ track, item_id: itemId, item_revision: revision, artifact_digest: artifactDigest }) {
    if (!['track-1', 'track-2'].includes(track)) fail('publication.track', 'track must be track-1 or track-2');
    return `publication:${track}:${itemId}:r${revision}:${artifactDigest}`;
}

export function publicationBranchName(binding) {
    const suffix = binding.artifact_digest.replace('sha256:', '').slice(0, 16);
    return `orchard/publication/${binding.track}/${binding.item_id}/r${binding.item_revision}-${suffix}`;
}

export async function validateGate2PublicationAuthority({ manifest, full_manifest_items: fullManifestItems, decision, current_item: currentItem }) {
    await assertValidRecord('gate-2-issue-manifest', manifest);
    await assertValidRecord('decision-event', decision);
    if (!Array.isArray(fullManifestItems) || fullManifestItems.length !== manifest.batch.total_item_count) {
        fail('authority.full-manifest', 'the complete Gate 2 full-manifest item collection is required');
    }
    const sortedItems = structuredClone(fullManifestItems).sort((left, right) => left.item_id.localeCompare(right.item_id));
    if (new Set(sortedItems.map((item) => item.item_id)).size !== sortedItems.length) {
        fail('authority.full-manifest-duplicate', 'the Gate 2 full-manifest collection must contain each item exactly once');
    }
    verifyGateManifestDigests(manifest, sortedItems);
    const matches = manifest.items.filter((item) => item.item_id === decision.item_id);
    if (matches.length !== 1) fail('authority.item', 'the Gate 2 manifest must contain the approved item exactly once');
    const item = matches[0];
    exact(currentItem, item, 'authority.current-item', 'current item and Gate 2 reviewed item');
    if (decision.gate !== 'gate-2' || decision.decision !== 'approve' || decision.actor?.authorized !== true
        || decision.previous_state !== 'gate2-pending' || decision.next_state !== 'gate2-approved') {
        fail('authority.decision', 'publication requires an authorized approve transition from gate2-pending to gate2-approved');
    }
    if (decision.run_id !== manifest.run_id || decision.item_id !== item.item_id
        || decision.item_revision !== item.item_revision || decision.digest !== item.artifact_digest) {
        fail('authority.decision-binding', 'Gate 2 decision does not exactly bind the manifest item, revision, and artifact');
    }
    if (item.target.repository !== PUBLICATION_REPOSITORY) fail('authority.repository', `publication target must be ${PUBLICATION_REPOSITORY}`);
    const expectedAdoKey = `orchard:${manifest.track}:${item.item_id}:r${item.item_revision}`;
    if (item.ado_external_key !== expectedAdoKey) fail('authority.ado-binding', 'Gate 2 ADO external key does not match the exact item revision');
    if (!/^sha256:[a-f0-9]{64}$/.test(item.handoff_chain_digest)) fail('authority.handoff-binding', 'Gate 2 handoff chain digest is invalid');
    requireGitCommit(item.base_commit, 'Gate 2 base commit');
    return Object.freeze({
        schema_version: '1.0.0', run_id: manifest.run_id, track: manifest.track,
        item_id: item.item_id, item_revision: item.item_revision, artifact_digest: item.artifact_digest,
        proposal_digest: item.proposal_digest, displayed_diff_digest: item.displayed_diff_digest,
        prepared_tree_digest: item.prepared_tree_digest, base_commit: item.base_commit,
        target: structuredClone(item.target), ado_external_key: item.ado_external_key,
        handoff_chain_digest: item.handoff_chain_digest, gate2_decision_event_id: decision.event_id,
        full_manifest_digest: manifest.full_manifest_digest, batch_digest: manifest.batch_digest,
    });
}

function immutableTransactionMatches(transaction, binding) {
    const expected = {
        run_id: binding.run_id, item_id: binding.item_id, item_revision: binding.item_revision,
        gate2_decision_event_id: binding.gate2_decision_event_id, artifact_digest: binding.artifact_digest,
        proposal_digest: binding.proposal_digest, ado_external_key: binding.ado_external_key,
        handoff_chain_digest: binding.handoff_chain_digest, full_manifest_digest: binding.full_manifest_digest,
        gate2_batch_digest: binding.batch_digest,
        displayed_diff_digest: binding.displayed_diff_digest, prepared_tree_digest: binding.prepared_tree_digest,
        target: { ...binding.target, protected_branch: PROTECTED_BRANCH, branch: publicationBranchName(binding) },
        base_commit: binding.base_commit,
    };
    for (const [field, value] of Object.entries(expected)) exact(transaction[field], value, 'publication.idempotency-conflict', `replayed publication ${field}`);
}

function eventKey(transactionId, phase, kind) { return `publication:${transactionId}:${phase}:${kind}`; }
function eventId(transactionId, phase, kind) { return `${transactionId}:${phase}:${kind}`; }

function persistEvent(store, transaction, phase, kind, state, now, details = {}) {
    const key = eventKey(transaction.transaction_id, phase, kind);
    const existing = store.findPublicationEvent(key);
    if (existing) {
        if (existing.transaction_id !== transaction.transaction_id || existing.phase !== phase
            || existing.intent_or_result !== kind || existing.state !== state) {
            fail('publication.event-idempotency-conflict', 'publication event idempotency key was reused for a different phase or state');
        }
        const comparableDetails = Object.fromEntries(Object.entries(details).filter(([field]) => field !== 'operation'));
        for (const [field, value] of Object.entries(comparableDetails)) {
            exact(existing[field], value, 'publication.event-idempotency-conflict', `replayed publication event ${field}`);
        }
        return existing;
    }
    const record = {
        event_id: eventId(transaction.transaction_id, phase, kind), transaction_id: transaction.transaction_id,
        phase, state, intent_or_result: kind, correlation_id: transaction.transaction_id,
        evidence_digest: sha256Digest(details), idempotency_key: key, occurred_at: now(), ...details,
    };
    return store.recordPublicationEvent(record);
}

function publicationRequests(transaction, binding, preparedCommit) {
    const branch = transaction.target.branch;
    const externalKey = transaction.idempotency_key;
    const branchExpected = { repository: PUBLICATION_REPOSITORY, name: branch, commit: preparedCommit, preparedTreeDigest: binding.prepared_tree_digest };
    const title = `[Orchard] Publish ${binding.item_id} revision ${binding.item_revision}`;
    const body = canonicalJson({
        publication_idempotency_key: externalKey, artifact_digest: binding.artifact_digest,
        proposal_digest: binding.proposal_digest, displayed_diff_digest: binding.displayed_diff_digest,
        prepared_tree_digest: binding.prepared_tree_digest, base_commit: binding.base_commit,
        target: binding.target, ado_external_key: binding.ado_external_key, handoff_chain_digest: binding.handoff_chain_digest
    });
    const pullExpected = {
        repository: PUBLICATION_REPOSITORY, externalKey, title, body,
        headBranch: branch, headCommit: preparedCommit, baseBranch: PROTECTED_BRANCH, baseCommit: binding.base_commit,
        preparedTreeDigest: binding.prepared_tree_digest, displayedDiffDigest: binding.displayed_diff_digest, state: 'open'
    };
    return { branchExpected, pullExpected };
}

async function ensureBaseUnchanged(adapter, binding) {
    const result = await adapter.reconcileProtectedMain({ repository: PUBLICATION_REPOSITORY, branch: PROTECTED_BRANCH, expectedCommit: binding.base_commit });
    if (result.classification !== 'exact') fail('publication.base-missing', 'protected main could not be reconciled to the approved base commit');
    return result.object;
}

export async function publishApprovedItem({ authorityReference, preparedCommit, adapter, store, apply = false, merge = false,
    transactionId = generateUuidV7(), now = () => new Date().toISOString() }) {
    if (!store || typeof store.getGateDecisionAuthority !== 'function') {
        fail('publication.authority-store', 'publication requires the protected Orchard authority store');
    }
    const keys = Object.keys(authorityReference ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['gate2_decision_event_id'])) {
        fail('publication.authority-reference', 'publication authority must contain only the immutable Gate 2 decision reference');
    }
    const authority = store.getGateDecisionAuthority(authorityReference.gate2_decision_event_id);
    if (!authority) fail('publication.authority-reference', 'protected Gate 2 authority evidence was not found');
    const binding = await validateGate2PublicationAuthority(authority);
    requireGitCommit(preparedCommit, 'prepared head commit');
    const idempotencyKey = publicationIdempotencyKey(binding);
    const branch = publicationBranchName(binding);
    if (branch === PROTECTED_BRANCH) fail('publication.direct-main', 'direct pushes to protected main are forbidden');
    const plan = {
        idempotency_key: idempotencyKey, repository: PUBLICATION_REPOSITORY, protected_branch: PROTECTED_BRANCH,
        head_branch: branch, base_commit: binding.base_commit, prepared_commit: preparedCommit, merge_requested: merge
    };
    if (!apply) return { operation: 'dry-run', binding, plan };
    const publicationTrust = store.requirePublicationAdapter(adapter);

    let transaction = store.getPublicationTransaction(idempotencyKey);
    if (transaction) immutableTransactionMatches(transaction, binding);
    else {
        const timestamp = now();
        transaction = {
            schema_version: '1.0.0', transaction_id: transactionId, idempotency_key: idempotencyKey,
            run_id: binding.run_id, item_id: binding.item_id, item_revision: binding.item_revision,
            gate2_decision_event_id: binding.gate2_decision_event_id, artifact_digest: binding.artifact_digest,
            proposal_digest: binding.proposal_digest, ado_external_key: binding.ado_external_key,
            handoff_chain_digest: binding.handoff_chain_digest, full_manifest_digest: binding.full_manifest_digest,
            gate2_batch_digest: binding.batch_digest,
            displayed_diff_digest: binding.displayed_diff_digest, prepared_tree_digest: binding.prepared_tree_digest,
            target: { ...binding.target, protected_branch: PROTECTED_BRANCH, branch }, base_commit: binding.base_commit,
            pull_request: null, result_commit: null, push_acknowledgement: null, state: 'created',
            history: [{ state: 'created', occurred_at: timestamp, actor: 'orchard', correlation_id: transactionId }],
            created_at: timestamp, updated_at: timestamp,
        };
        await store.recordPublicationTransaction(transaction, { track: binding.track });
    }
    store.recordPublicationAuthority(transaction.transaction_id, publicationTrust);

    const requests = publicationRequests(transaction, binding, preparedCommit);
    await ensureBaseUnchanged(adapter, binding);
    persistEvent(store, transaction, 'prepare', 'intent', 'preparing', now, { operation: 'create-branch', request_digest: sha256Digest(requests.branchExpected) });
    const branchResult = await adapter.reconcileBeforeCreateBranch({
        repository: PUBLICATION_REPOSITORY, branch,
        expected: requests.branchExpected, create: { commit: preparedCommit, preparedTreeDigest: binding.prepared_tree_digest }
    });
    persistEvent(store, transaction, 'prepare', 'result', 'validating', now, { operation: branchResult.operation, branch: branchResult.object });

    persistEvent(store, transaction, 'pr-open', 'intent', 'pr-open', now, { operation: 'create-pull-request', request_digest: sha256Digest(requests.pullExpected) });
    const pullResult = await adapter.reconcileBeforeCreatePullRequest({
        repository: PUBLICATION_REPOSITORY, externalKey: idempotencyKey,
        expected: requests.pullExpected, create: requests.pullExpected
    });
    persistEvent(store, transaction, 'pr-open', 'result', 'merge-pending', now, { operation: pullResult.operation, pull_request: pullResult.object });
    if (!merge) return { operation: 'merge-pending', binding, transaction, branch: branchResult.object, pull_request: pullResult.object };

    await ensureBaseUnchanged(adapter, binding);
    const reconciledPull = await adapter.reconcilePullRequest({ repository: PUBLICATION_REPOSITORY, externalKey: idempotencyKey, expected: requests.pullExpected });
    if (reconciledPull.classification !== 'exact') fail('publication.pr-missing', 'the exact approved pull request no longer exists');
    persistEvent(store, transaction, 'merge', 'intent', 'merging', now, {
        operation: 'merge-pull-request', pull_number: pullResult.object.number,
        approved_bindings_digest: sha256Digest(requests.pullExpected)
    });
    const mergeExpected = { ...requests.pullExpected, number: pullResult.object.number, state: 'merged' };
    const mergeResult = await adapter.reconcileBeforeMerge({
        repository: PUBLICATION_REPOSITORY, externalKey: idempotencyKey,
        pullNumber: pullResult.object.number, expected: mergeExpected,
        merge: { baseBranch: PROTECTED_BRANCH, headBranch: branch, expectedHeadCommit: preparedCommit, expectedBaseCommit: binding.base_commit }
    });
    requireGitCommit(mergeResult.object.mergeCommit, 'merge result commit');
    persistEvent(store, transaction, 'merge', 'result', 'acknowledging', now, {
        operation: mergeResult.operation,
        pull_request: mergeResult.object, result_commit: mergeResult.object.mergeCommit
    });
    return { operation: 'acknowledging', binding, transaction, pull_request: mergeResult.object, result_commit: mergeResult.object.mergeCommit };
}

export async function acknowledgePublication({ idempotencyKey, adapter, store, now = () => new Date().toISOString() }) {
    if (!adapter || !store) throw new TypeError('acknowledgement requires an explicit adapter and StateStore');
    const publicationTrust = store.requirePublicationAdapter(adapter);
    const current = store.getPublicationState(idempotencyKey);
    if (!current) fail('publication.not-found', 'publication transaction does not exist');
    if (current.state === 'published') return current;
    if (!current.result_commit) fail('publication.merge-not-reconciled', 'publication has no reconciled merge result commit');
    const transaction = current.transaction;
    store.recordPublicationAuthority(transaction.transaction_id, publicationTrust);
    persistEvent(store, transaction, 'acknowledge', 'intent', 'acknowledging', now, { operation: 'observe-protected-main', result_commit: current.result_commit });
    const acknowledgement = await adapter.reconcileProtectedMain({ repository: PUBLICATION_REPOSITORY, branch: PROTECTED_BRANCH, expectedCommit: current.result_commit });
    if (acknowledgement.classification !== 'exact') fail('publication.main-not-acknowledged', 'protected main has not acknowledged the exact merge result commit');
    const pushAcknowledgement = {
        repository: PUBLICATION_REPOSITORY, branch: PROTECTED_BRANCH, commit: current.result_commit,
        status: 'succeeded', acknowledged_at: now()
    };
    persistEvent(store, transaction, 'acknowledge', 'result', 'published', now, {
        operation: 'protected-main-acknowledged',
        result_commit: current.result_commit, push_acknowledgement: pushAcknowledgement
    });
    return store.getPublicationState(idempotencyKey);
}

export function isPublicationContractError(error) {
    return error instanceof PublicationAuthorityError || error instanceof ContractValidationError;
}
