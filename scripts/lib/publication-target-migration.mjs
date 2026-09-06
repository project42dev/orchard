// What the historical-target repoint could NOT move, named on every run.
//
// THE DEFECT. lib/publication.mjs refuses to publish any item whose Gate 2
// manifest names a target repository other than project42-content. That refusal
// is right and is not weakened: Orchard writing into the platform repository is
// exactly the drift that made a published correction change nothing anybody
// could see. Its consequence was that every item recorded before the repoint
// carried the old repository and the platform's `content/` path layout, and was
// therefore permanently unpublishable.
//
// THE WRITE IS A MIGRATION, NOT THIS. item_revision is append-only, enforced by
// a trigger, because a revision is history. schema/migrations/011 is the one
// sanctioned place that rule is relaxed -- checksummed, applied once, backed up
// first -- and it repoints every historical revision it can map. It runs
// automatically: openStateStore migrates before it opens, so the first job to
// start after this deploys corrects the backlog with no operator involved.
//
// THIS IS THE OTHER HALF: the report. Migration 011 refuses, deliberately,
// anything it cannot map exactly, and a refusal expressed as a SQL WHERE clause
// is silent. This reads back whatever is still on the old target after the
// migration has run and says, in the run log, which item it is and exactly why
// it was left -- using contentRepositoryPathFor's own refusal message, the same
// function Track 2 maps a new finding with. It writes nothing, so it is safe to
// call inside every fenced session, and it keeps saying so on every run until a
// human acts.

import { contentRepositoryPathFor } from "./track-2-controller.mjs";
import { GATE_MANIFEST_REFERENCE_PREFIX } from "./gate-queue.mjs";
import { PUBLICATION_REPOSITORY } from "./publication.mjs";

export const MIGRATION_EVENT = "publication.target-migration";

// Where an item was actually published, or where a closed or superseded item
// once pointed, is a fact about the past. Migration 011 leaves those alone and
// so does this: they are not stranded work.
const TERMINAL_STATES = new Set(["published", "closed", "superseded"]);

/**
 * Report every live item revision still pointing away from the content
 * repository, with the reason migration 011 could not move it. Read-only.
 *
 * @returns {{ scanned: number, unmapped: Array<object> }}
 */
export function reportUnmappedPublicationTargets({ store, log = () => { } } = {}) {
    const rows = store.db.prepare(
        `SELECT r.item_id, r.item_revision, r.target_repository, r.target_path, r.record_json,
                w.current_state
           FROM item_revision r
           JOIN workflow_item w ON w.item_id = r.item_id
          WHERE r.target_repository <> ?
            AND r.item_revision = w.current_revision
            AND w.current_state NOT IN ('published', 'closed', 'superseded')
          ORDER BY r.item_id`,
    ).all(PUBLICATION_REPOSITORY);

    const summary = { scanned: rows.length, unmapped: [] };
    if (rows.length === 0) {
        log("info", `${MIGRATION_EVENT}.clear`, {
            repository: PUBLICATION_REPOSITORY,
            effect: "every live item revision targets the content repository and can reach publication",
        });
        return summary;
    }

    const manifestFor = store.db.prepare(
        `SELECT 1 FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?`,
    );

    for (const row of rows) {
        const revision = Number(row.item_revision);
        let reason;
        if (manifestFor.get(row.item_id, revision, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-2:${row.item_id}`)) {
            // The manifest, not the revision, is what publication authority
            // reads, and its evidence digest covers the target. Nothing may
            // rewrite it; a human reworks or denies the item instead.
            reason = "a Gate 2 manifest already binds this revision's target; it must be reworked or denied by a human, never repointed under the recorded evidence";
        } else {
            try {
                contentRepositoryPathFor(row.target_path);
                // Mappable, un-migrated, and not gate-bound: migration 011 has
                // not run against this database yet, which is itself worth
                // saying out loud rather than reporting the item as unmappable.
                reason = "mappable but not yet migrated; schema migration 011 has not been applied to this database";
            } catch (error) {
                reason = error.message;
            }
        }
        summary.unmapped.push({
            item: row.item_id,
            revision,
            state: row.current_state,
            repository: row.target_repository,
            path: row.target_path,
            reason,
        });
        log("warn", `${MIGRATION_EVENT}.unmapped`, {
            item: row.item_id, revision, state: row.current_state,
            repository: row.target_repository, path: row.target_path, reason,
            effect: "the item cannot reach publication and is reported every run; nothing is guessed at on its behalf",
        });
    }

    log("warn", `${MIGRATION_EVENT}.summary`, {
        scanned: summary.scanned,
        unmapped: summary.unmapped.length,
        items: summary.unmapped.map((entry) => `${entry.item}@r${entry.revision}: ${entry.reason}`),
    });
    return summary;
}
