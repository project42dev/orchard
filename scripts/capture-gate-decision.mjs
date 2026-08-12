#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertValidRecord } from './lib/contracts.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { verifyGateManifestDigests } from './lib/gates.mjs';
import { openStateStore } from './lib/state-store.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const DIGEST = 'sha256:[a-f0-9]{64}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const BASE = `\\/orchard (gate1|gate2) (approve|deny|defer|request-changes) item=(${UUID}) revision=([1-9][0-9]*) digest=(${DIGEST})`;
const COMMAND = new RegExp(`^${BASE}(?: reason="([^"\\r\\n]+)")?(?: review-after=(${DATE}))?$`);
const NEXT_STATE = Object.freeze({
    'gate-1': Object.freeze({ approve: 'gate1-approved', deny: 'denied', defer: 'deferred', 'request-changes': 'changes-requested' }),
    'gate-2': Object.freeze({ approve: 'gate2-approved', deny: 'denied', defer: 'deferred', 'request-changes': 'changes-requested' }),
});

export class GateDecisionError extends Error {
    constructor(code, message) { super(message); this.name = 'GateDecisionError'; this.code = code; }
}
const fail = (code, message) => { throw new GateDecisionError(code, message); };

export function parseDecisionCommand(text) {
    if (typeof text !== 'string') fail('command.type', 'comment body must be a string');
    const match = COMMAND.exec(text);
    if (!match) fail('command.grammar', 'comment is not one exact Orchard item decision command');
    const [, gateToken, decision, itemId, revision, digest, reason, reviewAfter] = match;
    if (decision === 'approve' && (reason || reviewAfter)) fail('command.approve-extra', 'approve accepts no reason or review-after');
    if (['deny', 'defer', 'request-changes'].includes(decision) && !reason) fail('command.reason-required', `${decision} requires reason="..."`);
    if (decision === 'defer' && !reviewAfter) fail('command.review-after-required', 'defer requires review-after=YYYY-MM-DD');
    if (decision !== 'defer' && reviewAfter) fail('command.review-after-forbidden', 'review-after is valid only for defer');
    if (reviewAfter && Number.isNaN(Date.parse(`${reviewAfter}T00:00:00Z`))) fail('command.review-after-invalid', 'review-after is not a real date');
    return { gate: gateToken === 'gate1' ? 'gate-1' : 'gate-2', decision, item_id: itemId, item_revision: Number(revision), digest, reason: reason ?? null, review_after: reviewAfter ?? null };
}

function exact(actual, expected, code, label) {
    if (canonicalJson(actual) !== canonicalJson(expected)) fail(code, `${label} mismatch`);
}

export async function captureGateDecision({
    manifest, fullManifestItems, verifiedEvent: event, authorizationPolicy, currentItem, existingEvents = [],
    eventId = generateUuidV7(), correlationId = generateUuidV7(), supersedesEventId = null,
}) {
    const authorizedActorIds = authorizationPolicy?.authorized_actor_ids;
    if (!Array.isArray(authorizedActorIds) || authorizedActorIds.some((id) => !/^[1-9][0-9]*$/.test(String(id)))) fail('actor.allowlist-invalid', 'authorized actor allowlist must contain immutable numeric GitHub IDs');
    if (authorizationPolicy.provider !== 'github' || authorizationPolicy.repository !== event.repository) fail('actor.policy-binding', 'authorization policy does not bind this provider and repository');
    const allowlist = new Set(authorizedActorIds.map(String));
    if (event.action && event.action !== 'created') fail('source.edited-or-deleted', 'edited or deleted comments cannot create decisions');
    if (event.edited === true || event.deleted === true) fail('source.edited-or-deleted', 'edited or deleted comments cannot create decisions');
    if (!allowlist.has(String(event.actor?.immutable_id))) fail('actor.unauthorized', 'GitHub actor immutable ID is not authorized');
    const command = parseDecisionCommand(event.body);
    await assertValidRecord(manifest.gate === 'gate-1' ? 'gate-1-issue-manifest' : 'gate-2-issue-manifest', manifest);
    verifyGateManifestDigests(manifest, fullManifestItems);
    if (event.repository !== event.issue?.repository || event.issue_number !== event.issue?.number) fail('source.issue-binding', 'comment and issue metadata do not match');
    if (event.issue?.manifest_digest !== sha256Digest(manifest)) fail('source.manifest-binding', 'issue manifest digest does not match exact manifest');
    if (event.issue?.idempotency_key !== manifest.idempotency_key || event.issue?.batch_digest !== manifest.batch_digest) fail('source.batch-binding', 'issue batch binding does not match manifest');
    if (command.gate !== manifest.gate || event.issue?.gate !== manifest.gate) fail('binding.gate', 'gate mismatch');
    if (event.issue?.run_id !== manifest.run_id || event.issue?.track !== manifest.track) fail('binding.run-track', 'run or track mismatch');
    const matches = manifest.items.filter((item) => item.item_id === command.item_id);
    if (matches.length !== 1) fail('binding.item', 'command must identify exactly one item in this issue');
    const item = matches[0];
    const digestField = command.gate === 'gate-1' ? 'proposal_digest' : 'artifact_digest';
    if (item.item_revision !== command.item_revision) fail('binding.stale-revision', 'command revision is stale or mismatched');
    if (item[digestField] !== command.digest) fail('binding.digest', 'command digest does not match reviewed item');
    if (item.decision_state !== 'pending') fail('binding.not-pending', 'item is not pending at this gate');
    exact(event.issue.target, item.target, 'binding.target', 'target');
    if (command.gate === 'gate-2' && event.issue.base_commit !== item.base_commit) fail('binding.base', 'base commit mismatch');
    if (currentItem) exact(currentItem, item, 'binding.material-change', 'current item and reviewed item');
    const previousState = command.gate === 'gate-1' ? 'gate1-pending' : 'gate2-pending';
    if (event.current_state !== previousState) fail('binding.state', `current state must be ${previousState}`);
    const commentDigest = sha256Digest(event.body);
    const prior = existingEvents.find((entry) => entry.source?.repository === event.repository && String(entry.source?.comment_id) === String(event.comment_id));
    if (prior) {
        if (prior.source.comment_digest !== commentDigest) fail('replay.comment-mismatch', 'replayed comment metadata differs from captured immutable event');
        if (prior.item_id !== command.item_id || prior.item_revision !== command.item_revision || prior.digest !== command.digest || prior.decision !== command.decision) fail('replay.decision-mismatch', 'replayed command differs from captured immutable event');
        return { event: prior, replayed: true };
    }
    const decisionEvent = {
        schema_version: '1.0.0', event_id: eventId, gate: command.gate, run_id: manifest.run_id,
        item_id: command.item_id, item_revision: command.item_revision, digest: command.digest, decision: command.decision,
        reason: command.reason, review_after: command.review_after,
        actor: { provider: 'github', immutable_id: String(event.actor.immutable_id), ...(event.actor.display_name ? { display_name: event.actor.display_name } : {}), authorized: true },
        source: { repository: event.repository, issue_number: event.issue_number, comment_id: String(event.comment_id), comment_digest: commentDigest },
        occurred_at: event.occurred_at, previous_state: previousState, next_state: NEXT_STATE[command.gate][command.decision],
        supersedes_event_id: supersedesEventId, correlation_id: correlationId,
    };
    await assertValidRecord('decision-event', decisionEvent);
    return { event: decisionEvent, replayed: false };
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2), options: {
            input: { type: 'string' }, db: { type: 'string' }, apply: { type: 'boolean', default: false },
        }
    });
    if (!values.input || !values.db) {
        throw new Error('usage: capture-gate-decision.mjs --input <capture.json> --db <content.db> [--apply]');
    }
    const store = openStateStore(resolve(values.db));
    try {
        const trust = store.getTrustAnchor('gate');
        if (!trust?.adapter_path || !trust?.policy) {
            fail('trust.configuration', 'gate capture requires an administrator-provisioned database trust anchor');
        }
        const input = JSON.parse(readFileSync(resolve(values.input), 'utf8'));
        if ('event' in input || 'verifiedEvent' in input || 'authorizationPolicy' in input || 'authorizedActorIds' in input) fail('source.self-asserted', 'capture input cannot supply provider evidence or authorization policy');
        const policy = trust.policy;
        if (sha256Digest(policy) !== trust.policy_digest) fail('actor.policy-digest', 'authorization policy digest does not match the trusted pin');
        const adapterPath = resolve(trust.adapter_path);
        if (sha256Digest(readFileSync(adapterPath, 'utf8')) !== trust.adapter_digest) fail('source.adapter-digest', 'provider adapter digest does not match the trusted pin');
        const adapter = await import(pathToFileURL(adapterPath).href);
        if (typeof adapter.fetchVerifiedEvent !== 'function') fail('source.adapter-contract', 'provider adapter must export fetchVerifiedEvent(reference)');
        if (typeof adapter.adapterIdentity !== 'string' || !adapter.adapterIdentity) fail('source.adapter-identity', 'provider adapter must export a stable adapterIdentity');
        if (adapter.adapterIdentity !== trust.adapter_identity) fail('source.adapter-identity', 'provider adapter identity does not match the trusted pin');
        const verifiedEvent = await adapter.fetchVerifiedEvent(input.eventReference);
        const result = await captureGateDecision({ ...input, verifiedEvent, authorizationPolicy: policy, existingEvents: [] });
        const authority = {
            schema_version: '1.0.0', queue_work_item_id: input.queue_work_item_id ?? null,
            decision: result.event, manifest: input.manifest,
            full_manifest_items: input.fullManifestItems ?? input.full_manifest_items,
            current_item: input.currentItem ?? input.current_item,
            verified_event: verifiedEvent, authorization_policy: policy,
            trust: {
                provider_event_digest: sha256Digest(verifiedEvent), authorization_policy_digest: trust.policy_digest,
                adapter_digest: trust.adapter_digest, adapter_identity: adapter.adapterIdentity,
            }
        };
        let persistedAuthority = null;
        if (values.apply) {
            await store.recordVerifiedDecision(authority);
            persistedAuthority = store.getGateDecisionAuthority(result.event.event_id);
            if (!persistedAuthority?.evidence_digest) fail('authority.persistence', 'persisted authority evidence could not be reconciled');
        }
        result.authority_reference = persistedAuthority ? {
            queue_work_item_id: authority.queue_work_item_id,
            gate1_decision_event_id: result.event.gate === 'gate-1' ? result.event.event_id : undefined,
            gate2_decision_event_id: result.event.gate === 'gate-2' ? result.event.event_id : undefined,
            evidence_digest: persistedAuthority.evidence_digest,
        } : null;
        console.log(JSON.stringify(result, null, 2));
        if (!values.apply) console.error('DRY RUN. Decision event and protected authority evidence were validated but not persisted.');
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; });
