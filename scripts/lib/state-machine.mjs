import { assertValidRecord } from "./contracts.mjs";

const directTransitions = [
    ["observed", "proposed", "observation-recorded"],
    ["proposed", "gate1-pending", "proposal-ready"],
    ["gate1-pending", "gate1-approved", "decision-approved"],
    ["gate1-approved", "ado-linked", "ado-reconciled"],
    ["ado-linked", "executing", "execution-started"],
    ["executing", "gate2-ready", "artifact-ready"],
    ["gate2-ready", "gate2-pending", "proposal-ready"],
    ["gate2-pending", "gate2-approved", "decision-approved"],
    ["gate2-approved", "publication-preparing", "publication-started"],
    ["publication-preparing", "publication-validating", "validation-passed"],
    ["publication-validating", "publication-pr-open", "pr-reconciled"],
    ["publication-pr-open", "publication-merging", "merge-started"],
    ["publication-merging", "published", "publication-acknowledged"],
    ["published", "ado-closure-ready", "closure-evidence-ready"],
    ["ado-closure-ready", "closed", "closure-accepted"],
    ["observed", "closed", "no-change-reviewed"]
];

export const ALLOWED_LIFECYCLE_TRANSITIONS = Object.freeze(directTransitions.map(Object.freeze));

// States reachable only through the exception rules in isTransitionAllowed
// below, never through the direct transition table.
const exceptionStates = ["denied", "deferred", "changes-requested", "stale-approval", "blocked", "superseded"];

// The complete current_state vocabulary, derived from the transition table
// plus the exception states, so it cannot drift from the machine itself.
// This list is the one authoritative documentation of the vocabulary. Two
// copies exist and are held in lockstep by scripts/test-state-vocabulary.mjs:
// the $defs/state enum in contracts/schemas/state-transition.schema.json and
// the CHECK constraint on workflow_item.current_state
// (schema/migrations/007-workflow-item-state-check.sql). Adding a state means
// changing all three, and the test fails until they agree.
export const LIFECYCLE_STATES = Object.freeze([...new Set([
    ...directTransitions.flatMap(([from, to]) => [from, to]),
    ...exceptionStates
])]);

const directKeys = new Set(directTransitions.map((entry) => entry.join("\0")));
const pendingStates = new Set(["gate1-pending", "gate2-pending"]);
const blockCauses = new Set(["policy-block", "integrity-block", "security-block", "cost-block"]);

export class LifecycleError extends Error {
    constructor(message, code = "lifecycle.invalid") {
        super(message);
        this.name = "LifecycleError";
        this.code = code;
    }
}

function expectedRecoveryState(gate, early, late) {
    if (gate === "gate-1") return early;
    if (gate === "gate-2") return late;
    throw new LifecycleError("recovery_gate must be gate-1 or gate-2", "lifecycle.recovery-gate");
}

export function isTransitionAllowed(transition) {
    const { from_state: from, to_state: to, cause } = transition;
    if (directKeys.has([from, to, cause].join("\0"))) return true;
    if (pendingStates.has(from) && cause === "decision-denied" && to === "denied") return true;
    if (pendingStates.has(from) && cause === "decision-deferred" && to === "deferred") return true;
    if (pendingStates.has(from) && cause === "decision-requested-changes" && to === "changes-requested") return true;
    if (["gate1-approved", "gate2-approved"].includes(from) && cause === "approval-stale" && to === "stale-approval") return true;
    if (!["closed", "denied", "superseded"].includes(from) && blockCauses.has(cause) && to === "blocked") return true;
    if (!["closed", "superseded"].includes(from) && cause === "superseded" && to === "superseded" && transition.superseding_item_id) return true;
    if (from === "deferred" && cause === "review-resumed") {
        return to === expectedRecoveryState(transition.recovery_gate, "gate1-pending", "gate2-pending");
    }
    if (from === "denied" && cause === "revision-created") {
        return to === expectedRecoveryState(transition.recovery_gate, "proposed", "executing")
            && Boolean(transition.predecessor_decision_event_id);
    }
    if (["changes-requested", "stale-approval"].includes(from) && cause === "revision-created") {
        const allowed = transition.recovery_gate === "gate-1"
            ? ["proposed", "gate1-pending"]
            : transition.recovery_gate === "gate-2"
                ? ["executing", "gate2-ready", "gate2-pending"]
                : [];
        return allowed.includes(to);
    }
    // A blocked item was refused by the ensemble's own internal review, not by
    // a human gate decision, and it always leaves that review from 'executing'
    // (ingest-proposals.mjs is the only writer of policy-block/etc against a
    // real proposal run). So unlike changes-requested/stale-approval, which can
    // be resumed at several points depending which gate went stale, a blocked
    // item has exactly one legal way back in: a fresh revision re-attempts
    // authoring from 'executing'. Gate 1's approval already covers the
    // underlying proposal, so recovery_gate is always gate-2 here.
    if (from === "blocked" && cause === "revision-created") {
        return transition.recovery_gate === "gate-2" && to === "executing";
    }
    // A gate2-ready item with no evidence file has the identical dead end
    // 'blocked' had: state-machine.mjs allowed executing -> gate2-ready but
    // nothing ever allowed a way back out when gate2-prep or authoring's own
    // inline evidence step could not find evidence to advance it to
    // gate2-pending (gate2-prep.mjs holds it there, honestly, rather than
    // fabricate a review). Found live 2026-08-17: Track 1 had 11 such items,
    // some old enough to predate the authoring role even being deployed, and
    // zero of them could ever reach a Gate 2 announcement. Same recovery
    // shape as 'blocked': a fresh revision re-attempts authoring from
    // 'executing', so a real evidence document can be produced this time.
    if (from === "gate2-ready" && cause === "revision-created") {
        return transition.recovery_gate === "gate-2" && to === "executing";
    }
    // Rejection gate (owner request 2026-08-18, docs/design/rejection-gate.md):
    // a SECOND ensemble block on the same item is not retried a third time
    // automatically -- the pipeline escalates the SAME rejected content
    // straight to a human at Gate 2 instead, carrying the real rejection
    // reason and the rejected draft itself. No new revision here: the
    // content under review did not change, only who is allowed to decide on
    // it did, so this moves directly to 'gate2-ready' rather than looping
    // back through 'executing'. The caller (attemptRejectionRecovery in
    // run-authoring.mjs) is the one place that counts prior blocks before
    // ever recording this cause -- the state machine only enforces the
    // shape of the transition, not the business rule for when it applies,
    // matching every other cause in this file.
    if (from === "blocked" && cause === "escalated-for-human-review") {
        return to === "gate2-ready";
    }
    return false;
}

export async function assertTransitionAllowed(transition, current = {}) {
    await assertValidRecord("state-transition", transition);
    if (!isTransitionAllowed(transition)) throw new LifecycleError("transition is not in the normative lifecycle", "lifecycle.transition-not-allowed");
    if (current.itemId !== undefined && transition.item_id !== current.itemId) throw new LifecycleError("transition item does not match the current item", "lifecycle.stale-item");
    if (current.state !== undefined && transition.from_state !== current.state) throw new LifecycleError(`stale state: expected ${current.state}, received ${transition.from_state}`, "lifecycle.stale-state");
    if (current.revision !== undefined && transition.item_revision !== current.revision) throw new LifecycleError(`stale revision: expected ${current.revision}, received ${transition.item_revision}`, "lifecycle.stale-revision");
    if (transition.cause === "revision-created") {
        if (transition.successor_revision !== transition.item_revision + 1) throw new LifecycleError("a successor revision must increment exactly once", "lifecycle.revision-gap");
    } else if (transition.successor_revision !== undefined) {
        throw new LifecycleError("successor_revision is only valid for revision-created", "lifecycle.unexpected-successor");
    }
    if (transition.cause === "superseded") {
        if (transition.superseding_item_id === transition.item_id) throw new LifecycleError("an item cannot supersede itself", "lifecycle.self-supersession");
        if (current.supersededByItemId) throw new LifecycleError("the item is already superseded", "lifecycle.already-superseded");
    }
    return transition;
}

export function assertApprovalCurrent({ gate, approvalRevision, currentRevision, approvedDigest, currentDigest }) {
    if (gate !== "gate-1" && gate !== "gate-2") throw new LifecycleError("gate must be gate-1 or gate-2", "lifecycle.gate");
    if (approvalRevision !== currentRevision) throw new LifecycleError("approval belongs to a stale item revision", "lifecycle.stale-revision");
    if (approvedDigest !== currentDigest) throw new LifecycleError("approval digest is stale", "lifecycle.stale-approval");
    return true;
}

export function isApprovalStale({ approvalRevision, currentRevision, approvedDigest, currentDigest }) {
    return approvalRevision !== currentRevision || approvedDigest !== currentDigest;
}

export function reviewResumptionTarget(gate) {
    return expectedRecoveryState(gate, "gate1-pending", "gate2-pending");
}

export function revisionRecoveryTargets(fromState, gate) {
    if (fromState === "denied") return [expectedRecoveryState(gate, "proposed", "executing")];
    if (fromState === "blocked") return gate === "gate-2" ? ["executing"] : [];
    if (fromState === "gate2-ready") return gate === "gate-2" ? ["executing"] : [];
    if (!["changes-requested", "stale-approval"].includes(fromState)) return [];
    return gate === "gate-1" ? ["proposed", "gate1-pending"] : gate === "gate-2" ? ["executing", "gate2-ready", "gate2-pending"] : [];
}
