import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { loadJson } from "../scripts/lib/contracts.mjs";
import { generateGateManifests } from "../scripts/lib/gates.mjs";
import { sha256Digest } from "../scripts/lib/identity.mjs";
import { acquireLease, itemLeaseScope, releaseLease, renewLease, targetPathLeaseScope, trackRunLeaseScope } from "../scripts/lib/leases.mjs";
import { IdempotencyConflictError, StateStore } from "../scripts/lib/state-store.mjs";

const FIXTURES = new URL("../contracts/fixtures/", import.meta.url);
const DIGEST = `sha256:${"9".repeat(64)}`;
const GATE_POLICY = { provider: "github", repository: "project42dev/orchard", authorized_actor_ids: ["1000001"] };
const GATE_TRUST = {
    authorization_policy_digest: sha256Digest(GATE_POLICY), adapter_digest: `sha256:${"a".repeat(64)}`,
    adapter_identity: "test:protected-github-adapter:v1"
};

async function fixture(name) {
    return structuredClone(await loadJson(new URL(name, FIXTURES)));
}

async function storeFixture(t) {
    const root = mkdtempSync(join(tmpdir(), "orchard-state-"));
    const path = join(root, "state.db");
    const store = new StateStore(path);
    store.provisionTrustAnchor({
        scope: "gate", adapter_identity: GATE_TRUST.adapter_identity,
        adapter_digest: GATE_TRUST.adapter_digest, policy_digest: GATE_TRUST.authorization_policy_digest,
        policy: GATE_POLICY, provisioned_at: "2026-08-01T00:00:00.000Z"
    });
    t.after(() => store.close());
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const run = await fixture("track-1-run.valid.json");
    const item = await fixture("track-1-item.valid.json");
    await store.recordRun(run);
    await store.recordItem(item);
    return { root, path, store, run, item };
}

function gate1Decision(item) {
    return {
        schema_version: "1.0.0",
        event_id: "018f3000-0000-7000-8000-000000000001",
        gate: "gate-1",
        run_id: item.run_id,
        item_id: item.item_id,
        item_revision: item.item_revision,
        digest: item.proposal_digest,
        decision: "approve",
        reason: null,
        review_after: null,
        actor: { provider: "github", immutable_id: "1000001", display_name: "owner", authorized: true },
        source: {
            repository: "project42dev/orchard",
            issue_number: 101,
            comment_id: "gate-1-comment",
            comment_digest: `sha256:${"e".repeat(64)}`
        },
        occurred_at: "2026-08-12T10:00:00Z",
        previous_state: "gate1-pending",
        next_state: "gate1-approved",
        supersedes_event_id: null,
        correlation_id: "018f3000-0000-7000-8000-000000000002"
    };
}

async function gate1Authority(item, overrides = {}) {
    const reviewedItem = {
        item_id: item.item_id, item_revision: item.item_revision, proposal_digest: item.proposal_digest,
        category: "addition", title: "Protected authority test", rationale: "Authenticated evidence",
        evidence_refs: ["evidence/source/example"], score: { formula_version: "1.0.0", value: 1 },
        target: item.target, risks: [], estimated_cost: { currency: "USD", amount: 0 }, decision_state: "pending"
    };
    const [manifest] = await generateGateManifests({ gate: "gate-1", run_id: item.run_id, track: item.track, items: [reviewedItem] });
    const body = `/orchard gate1 approve item=${item.item_id} revision=1 digest=${item.proposal_digest}`;
    const decision = gate1Decision(item);
    decision.source.comment_digest = sha256Digest(body);
    const verifiedEvent = {
        body, repository: decision.source.repository, comment_id: decision.source.comment_id,
        actor: { immutable_id: decision.actor.immutable_id }
    };
    return {
        schema_version: "1.0.0", queue_work_item_id: 77, decision, manifest,
        full_manifest_items: [structuredClone(reviewedItem)], current_item: structuredClone(reviewedItem),
        verified_event: verifiedEvent, authorization_policy: GATE_POLICY,
        trust: { ...GATE_TRUST, provider_event_digest: sha256Digest(verifiedEvent) }, ...overrides
    };
}

function transition(item, overrides = {}) {
    return {
        schema_version: "1.0.0",
        transition_id: "018f5000-0000-7000-8000-000000000001",
        run_id: item.run_id,
        item_id: item.item_id,
        item_revision: item.item_revision,
        from_state: "gate1-approved",
        to_state: "ado-linked",
        cause: "ado-reconciled",
        actor: "test",
        reason: null,
        occurred_at: "2026-08-12T10:01:00Z",
        correlation_id: "018f5000-0000-7000-8000-000000000002",
        ...overrides
    };
}

test("run and item writes replay exactly and reject conflicting reuse", async (t) => {
    const { store, run, item } = await storeFixture(t);
    assert.deepEqual(await store.recordRun(run), run);
    assert.deepEqual(await store.recordItem(item), item);

    const changed = { ...item, proposal_digest: DIGEST };
    await assert.rejects(() => store.recordItem(changed), IdempotencyConflictError);
    assert.equal(store.verify().ok, true);
});

test("decisions are contract-validated, immutable, replay-safe, and advance current state", async (t) => {
    const { store, item } = await storeFixture(t);
    const authority = await gate1Authority(item);
    const decision = authority.decision;
    await assert.rejects(() => store.recordDecision(decision), /raw decision persistence is forbidden/);
    assert.deepEqual(await store.recordVerifiedDecision(authority), decision);
    assert.deepEqual(await store.recordVerifiedDecision(authority), decision);
    assert.equal(store.getItem(item.item_id).state, "gate1-approved");
    assert.equal(store.getGateDecisionAuthority(decision.event_id).evidence_digest.startsWith("sha256:"), true);

    const conflict = structuredClone(authority);
    conflict.decision.actor.display_name = "different";
    await assert.rejects(() => store.recordVerifiedDecision(conflict), /provider event|idempotency|evidence/i);
    const forgedStore = new StateStore(store.path);
    assert.throws(() => forgedStore.provisionTrustAnchor({
        scope: "gate", adapter_identity: GATE_TRUST.adapter_identity, adapter_digest: DIGEST,
        policy_digest: GATE_TRUST.authorization_policy_digest, policy: GATE_POLICY,
        provisioned_at: "2026-08-01T00:00:00.000Z"
    }), /already provisioned/);
    const forgedAuthority = structuredClone(authority);
    forgedAuthority.trust.adapter_digest = DIGEST;
    await assert.rejects(() => forgedStore.recordVerifiedDecision(forgedAuthority), /protected trust pins/);
    forgedStore.close();
    assert.throws(() => store.db.prepare("UPDATE decision_event SET decision = 'deny' WHERE event_id = ?").run(decision.event_id), /immutable/);
});

test("an approval records without a tracker item, and only an approval may ever carry one", async (t) => {
    // The tracker item is created AFTER approval, never before: the approval
    // is what causes the Azure DevOps work item to exist, so demanding its id
    // WITH the approval made an approval impossible to record at all. An
    // approval therefore records with a null queue work item id; the binding
    // is written later, on the external_link row. A denial dispatches
    // nothing, so it must still carry nothing.
    const { store, item } = await storeFixture(t);
    const approval = await gate1Authority(item);

    await assert.rejects(
        () => store.recordVerifiedDecision({ ...approval, queue_work_item_id: 0 }),
        /must be null or a positive integer/,
    );

    const denial = await gate1Authority(item);
    const body = `/orchard gate1 deny item=${item.item_id} revision=1 digest=${item.proposal_digest} reason="not a real gap"`;
    denial.decision.decision = "deny";
    denial.decision.reason = "not a real gap";
    denial.decision.next_state = "denied";
    denial.decision.source.comment_digest = sha256Digest(body);
    denial.verified_event = { ...denial.verified_event, body };
    denial.trust = { ...denial.trust, provider_event_digest: sha256Digest(denial.verified_event) };

    await assert.rejects(
        () => store.recordVerifiedDecision({ ...denial, queue_work_item_id: 77 }),
        /only a Gate 1 approval may claim queue dispatch ownership/,
    );

    assert.deepEqual(await store.recordVerifiedDecision({ ...approval, queue_work_item_id: null }), approval.decision);
    assert.equal(store.getItem(item.item_id).state, "gate1-approved");
    assert.equal(store.getGateDecisionAuthority(approval.decision.event_id).queue_work_item_id, null,
        "the queue binding is not on the decision; it lives on the external link");
});

test("dispatch binding is derived only from protected Gate 1 authority and exact persisted ADO evidence", async (t) => {
    const { store, item } = await storeFixture(t);
    // The approval carries no queue work item id, because the work item is
    // created after it. The id dispatch verifies is the one on the persisted
    // external link, written when the tracker item was created.
    const authority = await gate1Authority(item, { queue_work_item_id: null });
    await store.recordVerifiedDecision(authority);
    const binding = {
        queue_work_item_id: 5001, run_id: item.run_id, track: item.track, item_id: item.item_id,
        item_revision: 1, proposal_digest: item.proposal_digest, target: item.target,
        gate1_decision_event_id: authority.decision.event_id,
        ado_external_key: `orchard:${item.track}:${item.item_id}:r1`, ado_work_item_id: 5001
    };
    store.recordExternalLink({
        link_id: "018f7000-0000-7000-8000-000000000001", run_id: item.run_id, item_id: item.item_id,
        item_revision: 1, provider: "ado", operation: "user-story", external_key: binding.ado_external_key,
        external_id: 5001, linked_at: "2026-08-12T10:01:00Z", binding
    });
    const reference = { queue_work_item_id: 5001, gate1_decision_event_id: authority.decision.event_id };
    assert.deepEqual(store.getDispatchBinding(reference), binding);
    assert.throws(() => store.getDispatchBinding({ ...reference, manifest: authority.manifest }), /only immutable/);
    assert.throws(() => store.getDispatchBinding({ ...reference, queue_work_item_id: 78 }),
        /does not match the persisted ADO binding/,
        "a queue reference that names a different work item than the link recorded must be refused");
});

test("state transitions are legal, append-only, replay-safe, and fail on stale revisions", async (t) => {
    const { store, item } = await storeFixture(t);
    await store.recordVerifiedDecision(await gate1Authority(item));
    // ado-linked asserts the tracker item exists, so the link must be
    // persisted before the transition will record, exactly as in production.
    store.recordExternalLink({
        link_id: "018f7000-0000-7000-8000-000000000002", run_id: item.run_id, item_id: item.item_id,
        item_revision: 1, provider: "ado", operation: "ado-link",
        external_key: `orchard:${item.track}:${item.item_id}:r1`,
        external_id: 5001, linked_at: "2026-08-12T10:01:00Z"
    });
    const legal = transition(item);
    assert.deepEqual(await store.recordTransition(legal), legal);
    assert.deepEqual(await store.recordTransition(legal), legal);
    assert.equal(store.getItem(item.item_id).state, "ado-linked");
    assert.throws(() => store.db.prepare("DELETE FROM state_transition_event WHERE transition_id = ?").run(legal.transition_id), /append-only/);

    const stale = transition(item, {
        transition_id: "018f5000-0000-7000-8000-000000000003",
        item_revision: 2,
        from_state: "ado-linked",
        to_state: "executing",
        cause: "execution-started"
    });
    await assert.rejects(() => store.recordTransition(stale), /stale revision/);

    const illegal = transition(item, { transition_id: "018f5000-0000-7000-8000-000000000004", from_state: "ado-linked", to_state: "published", cause: "publication-acknowledged" });
    await assert.rejects(() => store.recordTransition(illegal), /contract validation failed|not in the normative lifecycle/);
});

test("observations are append-only and idempotency conflicts fail closed", async (t) => {
    const { store, item } = await storeFixture(t);
    const observation = {
        observation_id: "018f6000-0000-7000-8000-000000000001",
        run_id: item.run_id,
        item_id: item.item_id,
        item_revision: 1,
        evidence_reference: "source:test",
        evidence_digest: DIGEST,
        observed_at: "2026-08-12T09:00:00Z"
    };
    assert.deepEqual(store.recordObservation(observation), observation);
    assert.deepEqual(store.recordObservation(observation), observation);
    assert.throws(() => store.recordObservation({ ...observation, evidence_reference: "source:changed" }), IdempotencyConflictError);
    assert.throws(() => store.db.prepare("UPDATE observation_event SET evidence_reference = 'changed'").run(), /append-only/);
});

test("leases serialize scopes, permit expiry takeover, and protect renewal and release by token", async (t) => {
    const { path, store, item } = await storeFixture(t);
    const second = new DatabaseSync(path);
    second.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");

    assert.deepEqual(trackRunLeaseScope("track-1"), { scopeType: "track-run", scopeKey: "track-1" });
    assert.equal(itemLeaseScope(item.item_id).scopeType, "item");
    assert.equal(targetPathLeaseScope("project42dev/project42-platform", "content/learning/example.json").scopeType, "target-path");

    const scope = itemLeaseScope(item.item_id);
    const first = acquireLease(store.db, { ...scope, owner: "worker-a", ownerToken: "token-a", ttlMs: 1000, now: 1_000 });
    assert.ok(first);
    assert.equal(acquireLease(second, { ...scope, owner: "worker-b", ownerToken: "token-b", ttlMs: 1000, now: 1_500 }), null);
    assert.equal(renewLease(second, { ...scope, ownerToken: "wrong", ttlMs: 1000, now: 1_500 }), null);
    assert.equal(releaseLease(second, { ...scope, ownerToken: "wrong" }), false);

    const takeover = acquireLease(second, { ...scope, owner: "worker-b", ownerToken: "token-b", ttlMs: 1000, now: 2_000 });
    assert.equal(takeover.generation, 2);
    assert.equal(renewLease(store.db, { ...scope, ownerToken: "token-a", ttlMs: 1000, now: 2_100 }), null);
    assert.equal(releaseLease(store.db, { ...scope, ownerToken: "token-a" }), false);
    assert.ok(renewLease(second, { ...scope, ownerToken: "token-b", ttlMs: 1000, now: 2_100 }));
    assert.equal(releaseLease(second, { ...scope, ownerToken: "token-b" }), true);
    second.close();
});
