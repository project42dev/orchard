// An owner can withdraw an accidental Gate 2 approval after the comment has
// already been applied. Hold the exact current revision before a later
// publication pass can resume a prepared or closed PR.
import { generateUuidV7 } from "./identity.mjs";

const WITHDRAWABLE = new Set(["gate2-approved", "publication-preparing", "publication-validating", "publication-pr-open"]);
const STALE_PUBLICATION = new Set(["publication-pr-open"]);

async function holdApprovedRevisions({ store, items, states, reason, now, actor, skipIneligible = false }) {
    const held = [];
    const skipped = [];
    for (const { itemId, revision } of items) {
        const row = store.db.prepare(
            `SELECT w.current_state, w.current_revision, r.run_id FROM workflow_item w
             JOIN item_revision r ON r.item_id = w.item_id AND r.item_revision = w.current_revision
             WHERE w.item_id = ?`,
        ).get(itemId);
        if (!row || Number(row.current_revision) !== Number(revision) || !states.has(row.current_state)) {
            if (skipIneligible) { skipped.push({ itemId, revision, state: row?.current_state ?? null, reason: "revision or state is not an open publication PR" }); continue; }
            throw new Error(`${itemId} is not a holdable approval at revision ${revision}`);
        }
        const decision = store.db.prepare(
            `SELECT 1 FROM decision_event WHERE item_id = ? AND item_revision = ?
             AND gate = 'gate-2' AND decision = 'approve' LIMIT 1`,
        ).get(itemId, Number(revision));
        if (!decision) {
            if (skipIneligible) { skipped.push({ itemId, revision, state: row.current_state, reason: "no recorded Gate 2 approval" }); continue; }
            throw new Error(`${itemId} has no recorded Gate 2 approval at revision ${revision}`);
        }
        await store.recordTransition({
            schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: row.run_id,
            item_id: itemId, item_revision: Number(revision), from_state: row.current_state,
            to_state: "blocked", cause: "policy-block",
            reason,
            actor, occurred_at: now, correlation_id: generateUuidV7(),
        });
        held.push({ itemId, revision: Number(revision), previousState: row.current_state });
    }
    return { held, skipped };
}

export async function holdWithdrawnGate2Approvals({ store, items, now = new Date().toISOString(), actor = "orchard/admin-withdrawn-approval" }) {
    const result = await holdApprovedRevisions({ store, items, states: WITHDRAWABLE, now, actor,
        reason: "Owner withdrew blanket Gate 2 approval after factual-review failures; publication PR closed before merge" });
    return result.held;
}

export async function holdStalePublicationApprovals({ store, items, now = new Date().toISOString(), actor = "orchard/admin-stale-publication" }) {
    return holdApprovedRevisions({ store, items, states: STALE_PUBLICATION, now, actor, skipIneligible: true,
        reason: "Approved target changed on content main after the Gate 2 base; the conflicting publication PR was closed unmerged. Re-author against current main and obtain a new Gate 2 approval." });
}
