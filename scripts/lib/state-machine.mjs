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
    if (!["changes-requested", "stale-approval"].includes(fromState)) return [];
    return gate === "gate-1" ? ["proposed", "gate1-pending"] : gate === "gate-2" ? ["executing", "gate2-ready", "gate2-pending"] : [];
}
