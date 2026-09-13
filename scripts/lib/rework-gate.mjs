// Which gate returned an item that now sits at changes-requested or
// stale-approval. Deliberately import-free: apply-blocked-retry.mjs and
// lib/rework-recovery.mjs both need it, and rework-recovery already imports
// apply-blocked-retry.
//
// WHY THE GATE MATTERS. Both states are reachable from EITHER gate
// (state-machine.mjs: request-changes from gate1-pending or gate2-pending;
// approval-stale from gate1-approved or gate2-approved), and the legal way back
// differs. A Gate 2 return re-authors from 'executing', because Gate 1 already
// approved the proposal. A Gate 1 return goes back to the proposal
// ('proposed'/'gate1-pending'); moving it to 'executing' would author work no
// human approved and that has no Azure DevOps item. The state machine alone does
// not stop that -- it allows changes-requested -> executing whenever
// recovery_gate says gate-2, whichever gate actually spoke -- so the caller has
// to establish the gate from the record before it claims one.
//
// WHERE THE RECORD IS. Two writers produce changes-requested, and they leave
// different evidence:
//   * store.recordVerifiedDecision (the production path: a GitHub comment read
//     by apply-gate-decisions.mjs) writes a decision_event and updates
//     workflow_item in place. It writes NO state_transition_event.
//   * apply-gate2-rework.mjs (operator tool) writes a state_transition_event
//     and no decision_event.
// Both are read, restricted to the item's CURRENT revision (neither decision
// bumps the revision, so the one that put the item where it is sits there), and
// the newer wins.

export const REWORK_STATES = Object.freeze(["changes-requested", "stale-approval"]);

const GATE_OF_FROM_STATE = Object.freeze({
    "gate1-pending": "gate-1",
    "gate2-pending": "gate-2",
    "gate1-approved": "gate-1",
    "gate2-approved": "gate-2",
});

function newer(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    return String(b.occurred_at) > String(a.occurred_at) ? b : a;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ item_id: string, current_state: string, current_revision: number|string }} row
 * @returns {{ gate: "gate-1"|"gate-2", decisionEventId: string|null } | null}
 *   null when nothing on record says which gate returned the item.
 */
export function reworkGateOf(db, row) {
    const itemId = row.item_id;
    const revision = Number(row.current_revision);
    const state = row.current_state;
    if (!REWORK_STATES.includes(state)) return null;

    const transitionRow = db.prepare(
        `SELECT occurred_at, record_json FROM state_transition_event
          WHERE item_id = ? AND item_revision = ? AND to_state = ?
          ORDER BY occurred_at DESC, transition_id DESC LIMIT 1`,
    ).get(itemId, revision, state);
    const transition = transitionRow
        ? { occurred_at: transitionRow.occurred_at, gate: GATE_OF_FROM_STATE[JSON.parse(transitionRow.record_json).from_state] ?? null, decisionEventId: null }
        : null;

    // Only request-changes is ever a decision event; nothing records
    // approval-stale as a decision.
    const decisionRow = state === "changes-requested"
        ? db.prepare(
            `SELECT event_id, gate, occurred_at FROM decision_event
              WHERE item_id = ? AND item_revision = ? AND decision = 'request-changes'
              ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
        ).get(itemId, revision)
        : null;
    const decision = decisionRow
        ? { occurred_at: decisionRow.occurred_at, gate: decisionRow.gate, decisionEventId: decisionRow.event_id }
        : null;

    const winner = newer(transition, decision);
    if (!winner?.gate) return null;
    return { gate: winner.gate, decisionEventId: winner.decisionEventId };
}
