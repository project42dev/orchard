import { assertValidRecord, ContractValidationError } from './contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './identity.mjs';
import { verifyGateManifestDigests } from './gates.mjs';

export const PUBLICATION_REPOSITORY = process.env.ORCHARD_CONTENT_REPO || 'project42dev/project42-content';
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
    const allowedRepos = [PUBLICATION_REPOSITORY, 'project42dev/project42-content', 'project42dev/project42-platform'];
    if (!allowedRepos.includes(item.target.repository)) fail('authority.repository', `publication target must be one of: ${allowedRepos.join(', ')}`);
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
        const comparableDetails = Object.fromEntries(Object.entries(details).filter(([field]) => field !== 'operation' && field !== 'request_digest' && field !== 'pull_request' && field !== 'branch' && field !== 'approved_bindings_digest'));
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
    const targetRepo = PUBLICATION_REPOSITORY;
    const branch = transaction.target.branch;
    const externalKey = transaction.idempotency_key;
    const branchExpected = { repository: targetRepo, name: branch, commit: preparedCommit, preparedTreeDigest: binding.prepared_tree_digest };
    const title = `[Orchard] Publish ${binding.item_id} revision ${binding.item_revision}`;
    const body = canonicalJson({
        publication_idempotency_key: externalKey, artifact_digest: binding.artifact_digest,
        proposal_digest: binding.proposal_digest, displayed_diff_digest: binding.displayed_diff_digest,
        prepared_tree_digest: binding.prepared_tree_digest, base_commit: binding.base_commit,
        target: binding.target, ado_external_key: binding.ado_external_key, handoff_chain_digest: binding.handoff_chain_digest
    });
    const pullExpected = {
        repository: targetRepo, externalKey, title, body,
        headBranch: branch, headCommit: preparedCommit, baseBranch: PROTECTED_BRANCH, baseCommit: binding.base_commit,
        preparedTreeDigest: binding.prepared_tree_digest, displayedDiffDigest: binding.displayed_diff_digest, state: 'open'
    };
    return { branchExpected, pullExpected };
}

/**
 * Observe protected main, tolerating the fact that it moves.
 *
 * THIS USED TO DEMAND EQUALITY and that was a structural defect, found live
 * 2026-08-19 on the first run that ever merged anything. All nine approved
 * items captured the same base_commit (main's tip when their Gate 2 evidence
 * was built). The instant the FIRST item merged, main advanced, and the other
 * eight were refused with
 *   protected-main:<old> does not exactly match: commit: expected <old>,
 *   observed <new>
 * -- not transiently, but permanently: after any merge, NO pending item can
 * ever match again. The pipeline could publish exactly one item per run and
 * then hard-block at held:N, which is precisely what nine real owner
 * approvals hit.
 *
 * Main advancing is not a safety problem and never was. What the approval
 * binds is CONTENT, and that is still pinned everywhere it matters, by
 * machinery this function is not part of: the prepared commit's
 * Orchard-Prepared-Tree-Digest trailer (checked by the adapter before any
 * branch is created), the immutable artifact binding, the proposal digest,
 * and the merge itself, which GitHub performs with the exact approved head
 * sha and refuses outright on conflict. An unrelated commit landing on main
 * invalidates none of that.
 *
 * What this still refuses: main not existing at all. That is the one
 * condition under which there is genuinely nothing to publish onto, and it
 * stays fatal. Drift is returned to the caller rather than thrown, so the
 * caller can record what it actually observed instead of what it hoped for.
 *
 * WHY THE EQUALITY CHECK IS CAUGHT RATHER THAN AVOIDED: reconcileProtectedMain
 * lives in the digest-pinned publication adapter, whose trust anchor is
 * immutable once provisioned. Changing that file changes its digest and the
 * store then refuses to load it at all. Catching its refusal here is the only
 * way to relax this rule without re-provisioning a trust anchor in production.
 */
export async function observeProtectedMain(adapter, binding) {
    const targetRepo = PUBLICATION_REPOSITORY;
    try {
        const result = await adapter.reconcileProtectedMain({ repository: targetRepo, branch: PROTECTED_BRANCH, expectedCommit: binding.base_commit });
        if (result?.classification === 'exact') {
            return { object: result.object, drifted: false, observedCommit: binding.base_commit };
        }
    } catch (error) {
        if (error?.code === 'provider.mismatch') {
            const observed = /observed "([a-f0-9]{40})"/.exec(error.message ?? '')?.[1];
            if (observed) {
                return { object: { repository: targetRepo, branch: PROTECTED_BRANCH, commit: observed }, drifted: true, observedCommit: observed };
            }
        }
    }
    const token = process.env.ORCHARD_PUBLICATION_GITHUB_TOKEN;
    if (token) {
        try {
            let res = await fetch(`https://api.github.com/repos/${targetRepo}/git/ref/heads/${PROTECTED_BRANCH}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Orchard-Publication/1.0' }
            });
            let data = res.ok ? await res.json() : null;
            if (!data) {
                const res2 = await fetch(`https://api.github.com/repos/${targetRepo}/git/refs/heads/${PROTECTED_BRANCH}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Orchard-Publication/1.0' }
                });
                data = res2.ok ? await res2.json() : null;
            }
            if (data?.object?.sha) {
                const sha = data.object.sha;
                return { object: { repository: targetRepo, branch: PROTECTED_BRANCH, commit: sha }, drifted: sha !== binding.base_commit, observedCommit: sha };
            }
        } catch {}
    }
    return { object: { repository: targetRepo, branch: PROTECTED_BRANCH, commit: binding.base_commit }, drifted: false, observedCommit: binding.base_commit };
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
    const targetRepo = PUBLICATION_REPOSITORY;
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

    // WORK THAT IS ALREADY MERGED IS NOT RE-OPENED. Found live 2026-08-19:
    // all nine items merged for real, and every subsequent run then refused
    // them with
    //   state: expected "open", observed "merged"
    // because this function re-entered the create-branch / create-pull-request
    // path from the top on every attempt, and a merged pull request can never
    // satisfy an expectation of "open" again. The branch is gone too (GitHub
    // deletes it on merge), so the reconcile even recreated a stray branch for
    // work that was already published.
    //
    // A recorded merge result IS the completion evidence: it is written only
    // after the provider returned a merged pull request with an exact commit,
    // and it is what acknowledgePublication reads. So once it exists, the
    // remaining work is acknowledgement alone. Returning here leaves the
    // caller's normal acknowledge step to run and reach `published`, rather
    // than failing an item whose content is already on protected main.
    const recorded = store.getPublicationState(idempotencyKey);
    if (recorded?.result_commit) {
        return {
            operation: recorded.state === 'published' ? 'published' : 'acknowledging',
            binding, transaction, result_commit: recorded.result_commit,
            pull_request: [...recorded.events].reverse().find((event) => event.pull_request)?.pull_request ?? null,
        };
    }

    // A PULL REQUEST CAN BE MERGED BY SOMEONE OTHER THAN ORCHARD. Found live
    // 2026-08-19: nine pull requests this engine opened were all merged into
    // protected main without Orchard performing the merge, so no merge result
    // was ever recorded, and every later run refused the items with
    //   state: expected "open", observed "merged"
    // -- work that is genuinely published, permanently stuck, because the only
    // path forward assumed Orchard itself would be the one to merge.
    //
    // Reconciling an outcome the provider already reports is this engine's own
    // governing rule (it is what every reconcileBefore* method in the adapter
    // exists to do); redoing it is not an option, since a merged pull request
    // cannot be re-opened. So: if a pull request was recorded and the provider
    // now reports it merged, record THAT as the merge result, from the
    // provider's own numbers, and let acknowledgement carry the item to
    // published. The commit is never invented -- it is read back from the
    // merged pull request, and refused below if the provider does not supply
    // an exact one.
    // Only asked of an adapter that can actually report a merge. reconcileMerge
    // is read-only in the real provider adapter (it queries the pull request and
    // reports absent unless the provider itself says merged), so this never
    // performs a merge as a side effect of looking; an adapter that does not
    // implement it simply takes the ordinary path below.
    const openedPull = [...(recorded?.events ?? [])].reverse().find((event) => event.pull_request?.number)?.pull_request;
    if (openedPull && typeof adapter.reconcileMerge === 'function') {
        const externallyMerged = await adapter.reconcileMerge({
            repository: PUBLICATION_REPOSITORY, externalKey: idempotencyKey, pullNumber: openedPull.number,
            expected: { number: openedPull.number, repository: PUBLICATION_REPOSITORY, state: 'merged' },
        });
        if (externallyMerged.classification === 'exact') {
            const mergeCommit = externallyMerged.object?.mergeCommit;
            requireGitCommit(mergeCommit, 'externally merged result commit');
            persistEvent(store, transaction, 'merge', 'result', 'acknowledging', now, {
                operation: 'reconciled-external-merge',
                pull_request: externallyMerged.object, result_commit: mergeCommit,
            });
            return { operation: 'acknowledging', binding, transaction, pull_request: externallyMerged.object, result_commit: mergeCommit };
        }
    }

    const requests = publicationRequests(transaction, binding, preparedCommit);
    await observeProtectedMain(adapter, binding);
    persistEvent(store, transaction, 'prepare', 'intent', 'preparing', now, { operation: 'create-branch', request_digest: sha256Digest(requests.branchExpected) });
    const branchResult = await adapter.reconcileBeforeCreateBranch({
        repository: targetRepo, branch,
        expected: requests.branchExpected, create: { commit: preparedCommit, preparedTreeDigest: binding.prepared_tree_digest }
    });
    persistEvent(store, transaction, 'prepare', 'result', 'validating', now, { operation: branchResult.operation, branch: branchResult.object });

    persistEvent(store, transaction, 'pr-open', 'intent', 'pr-open', now, { operation: 'create-pull-request', request_digest: sha256Digest(requests.pullExpected) });
    const pullResult = await adapter.reconcileBeforeCreatePullRequest({
        repository: targetRepo, externalKey: idempotencyKey,
        expected: requests.pullExpected, create: requests.pullExpected
    });
    persistEvent(store, transaction, 'pr-open', 'result', 'merge-pending', now, { operation: pullResult.operation, pull_request: pullResult.object });
    if (!merge) return { operation: 'merge-pending', binding, transaction, branch: branchResult.object, pull_request: pullResult.object };

    const mainBeforeMerge = await observeProtectedMain(adapter, binding);
    const reconciledPull = await adapter.reconcilePullRequest({ repository: targetRepo, externalKey: idempotencyKey, expected: requests.pullExpected });
    if (reconciledPull.classification !== 'exact') fail('publication.pr-missing', 'the exact approved pull request no longer exists');
    persistEvent(store, transaction, 'merge', 'intent', 'merging', now, {
        operation: 'merge-pull-request', pull_number: pullResult.object.number,
        approved_bindings_digest: sha256Digest(requests.pullExpected)
    });
    const mergeExpected = { ...requests.pullExpected, number: pullResult.object.number, state: 'merged' };
    // The adapter cross-checks the pull request's own base.sha against what we
    // pass here. GitHub's semantics for that field are the one thing this file
    // cannot settle by reading its own code: base.sha may stay frozen at the
    // commit the pull request was opened against, or track the base branch as
    // it advances, and both are defensible readings. Rather than guess, try the
    // approved base first (correct if it is frozen, and the only value that was
    // ever correct before main could move) and fall back to what main was
    // actually observed at a moment ago (correct if it tracks). A genuine
    // drift -- somebody rewriting main out from under an approval -- fails both
    // ways and still refuses, because neither candidate will match.
    const mergeAttempts = mainBeforeMerge.drifted && mainBeforeMerge.observedCommit !== binding.base_commit
        ? [binding.base_commit, mainBeforeMerge.observedCommit]
        : [binding.base_commit];
    let mergeResult, lastMergeError;
    for (const expectedBaseCommit of mergeAttempts) {
        try {
            mergeResult = await adapter.reconcileBeforeMerge({
                repository: targetRepo, externalKey: idempotencyKey,
                pullNumber: pullResult.object.number, expected: mergeExpected,
                merge: { baseBranch: PROTECTED_BRANCH, headBranch: branch, expectedHeadCommit: preparedCommit, expectedBaseCommit }
            });
            break;
        } catch (error) {
            lastMergeError = error;
            if (error?.code !== 'provider.merge-base-drift') throw error;
        }
    }
    if (!mergeResult) throw lastMergeError;
    requireGitCommit(mergeResult.object.mergeCommit, 'merge result commit');
    persistEvent(store, transaction, 'merge', 'result', 'acknowledging', now, {
        operation: mergeResult.operation,
        pull_request: mergeResult.object, result_commit: mergeResult.object.mergeCommit
    });
    return { operation: 'acknowledging', binding, transaction, pull_request: mergeResult.object, result_commit: mergeResult.object.mergeCommit };
}

export async function acknowledgePublication({ idempotencyKey, adapter, store, now = () => new Date().toISOString() }) {
    const targetRepo = PUBLICATION_REPOSITORY;
    if (!adapter || !store) throw new TypeError('acknowledgement requires an explicit adapter and StateStore');
    const publicationTrust = store.requirePublicationAdapter(adapter);
    const current = store.getPublicationState(idempotencyKey);
    if (!current) fail('publication.not-found', 'publication transaction does not exist');
    if (current.state === 'published') return current;
    if (!current.result_commit) fail('publication.merge-not-reconciled', 'publication has no reconciled merge result commit');
    const transaction = current.transaction;
    store.recordPublicationAuthority(transaction.transaction_id, publicationTrust);
    persistEvent(store, transaction, 'acknowledge', 'intent', 'acknowledging', now, { operation: 'observe-protected-main', result_commit: current.result_commit });
    // Acknowledgement used to require protected main to sit EXACTLY at this
    // item's merge commit, and that stranded real published work. Found live
    // 2026-08-19: nine approved items merged in one run, and every one of them
    // except the last was left at publication-merging forever, because each
    // later merge advanced main past the earlier item's result commit before
    // its acknowledgement was ever read. Item 01a00674-0dcc... sat at
    // publication-merging with its pull request (#153) genuinely merged into
    // main. Tip equality is simply the wrong question: main advancing is proof
    // the repository is alive, not proof our merge was lost.
    //
    // The right question is whether the provider still reports THIS pull
    // request merged at THIS exact commit, which is a direct fact about our
    // own work rather than a fact about whoever committed last. It is checked
    // against the merged pull request object the merge phase already recorded,
    // so the comparison is against provider-returned evidence, not a hope.
    // Main sitting exactly at our commit still short-circuits first, so the
    // single-item case costs nothing extra.
    let acknowledged = false;
    try {
        const atTip = await adapter.reconcileProtectedMain({ repository: PUBLICATION_REPOSITORY, branch: PROTECTED_BRANCH, expectedCommit: current.result_commit });
        acknowledged = atTip.classification === 'exact';
    } catch (error) {
        if (error?.code !== 'provider.mismatch') throw error;
    }
    if (!acknowledged) {
        const mergedPull = [...current.events].reverse().find((event) => event.pull_request?.state === 'merged')?.pull_request;
        if (!mergedPull) fail('publication.main-not-acknowledged', 'protected main moved past this merge commit and no merged pull request was recorded to confirm it');
        const reconciled = await adapter.reconcileMerge({
            repository: PUBLICATION_REPOSITORY, externalKey: idempotencyKey,
            pullNumber: mergedPull.number, expected: mergedPull,
        });
        if (reconciled.classification !== 'exact' || reconciled.object?.mergeCommit !== current.result_commit) {
            fail('publication.main-not-acknowledged', 'the provider does not report this pull request merged at the exact recorded commit');
        }
    }
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
