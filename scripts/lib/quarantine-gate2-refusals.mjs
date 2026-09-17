// Older authoring runs put drafter refusals at Gate 2 as if they were drafts.
// A decision guard prevents publication, but cannot remove those stale gate
// requests. Move only a refusal proven by the persisted manifest back to the
// lifecycle's blocked state. This is a policy block, never a human decision.
import { heldAtGate } from "./gate-queue.mjs";
import { manifestItemRefusal, recordDrafterRefusal } from "./drafter-refusal.mjs";

export async function quarantineGate2Refusals({ store, track, log = () => {}, now = new Date().toISOString() }) {
    const summary = { scanned: 0, blocked: 0, errors: 0 };
    for (const item of heldAtGate(store.db, "gate-2", track)) {
        summary.scanned += 1;
        const refusal = manifestItemRefusal(item);
        if (!refusal) continue;
        const row = store.db.prepare(
            `SELECT w.current_state, w.current_revision, r.run_id, r.target_repository, r.target_path
               FROM workflow_item w JOIN item_revision r
                 ON r.item_id = w.item_id AND r.item_revision = w.current_revision
              WHERE w.item_id = ?`,
        ).get(item.item_id);
        // Gate 2 preparation persists the immutable digest in artifact_binding.
        // Historical item_revision rows legitimately have artifact_digest NULL.
        const binding = store.getArtifactBinding(item.item_id, item.item_revision);
        if (row?.current_state !== "gate2-pending"
            || Number(row.current_revision) !== Number(item.item_revision)
            || binding?.artifact_digest !== item.artifact_digest
            || binding?.run_id !== row.run_id
            || row.target_repository !== item.target?.repository
            || row.target_path !== item.target?.path) {
            summary.errors += 1;
            log("warn", "gate.refusal.binding-mismatch", { item: item.item_id, effect: "left at Gate 2 for investigation" });
            continue;
        }
        try {
            await recordDrafterRefusal({
                store, itemId: item.item_id, revision: item.item_revision, runId: row.run_id,
                fromState: "gate2-pending", refusal,
                target: { repository: row.target_repository, path: row.target_path },
                now, actor: "orchard/legacy-gate2-refusal-quarantine",
            });
            summary.blocked += 1;
            log("warn", "gate.refusal.quarantined", {
                item: item.item_id, revision: item.item_revision, reason: refusal.reason,
                effect: "removed from Gate 2 without recording approval or publishing; held blocked for a fresh draft",
            });
        } catch (error) {
            summary.errors += 1;
            log("warn", "gate.refusal.quarantine-failed", { item: item.item_id, reason: error.message });
        }
    }
    log(summary.errors ? "warn" : "info", "gate.refusal.quarantine-summary", summary);
    return summary;
}
