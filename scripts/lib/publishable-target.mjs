// A finding that cannot be scoped to a publishable change remains visible.
// Track 2 now routes individual path/module/resource records in catalog.json
// through the normal two-gate lifecycle. catalogue-deliverable.mjs limits each
// prepared commit to one selected record and binds it to the inspected digest.
// The two catalogue-wide inspection subjects aggregate defects across several
// records, so they remain report-only until split into individual decisions.
// Legacy approvals recorded before entry selectors existed are reported and
// superseded by fresh scoped Gate 1 proposals, never silently carried over.

import {
    RegistrationError, surfaceForTargetPath, diagramIdForTarget, learningPathIdForTarget,
} from "./registration.mjs";

export const UNPUBLISHABLE_TARGET_CODE = "currency.unpublishable-target";

export const UNPUBLISHABLE_TARGET_EVENT = "publication.unpublishable-target";

// Where an item was actually published, or where a closed or superseded item
// once pointed, is a fact about the past, not stranded work. The same exclusion
// reportUnmappedPublicationTargets makes, for the same reason.
const TERMINAL_STATES = Object.freeze(["published", "closed", "superseded"]);

/**
 * Thrown where a target path is decided, by the code that decides it.
 *
 * Distinct from RegistrationError so a caller can catch exactly this -- a
 * candidate that cannot be routed -- without swallowing a registration failure
 * raised for some other reason further down. It carries the registration code
 * that produced it, because "registration.unrecognized-target" is the fact a
 * human needs and "currency.unpublishable-target" is only the layer that noticed.
 */
export class UnpublishableTargetError extends Error {
    constructor(targetPath, registrationCode, detail) {
        super(`no surface publishes to ${targetPath}, so this finding has no artifact to author (${registrationCode}: ${detail})`);
        this.name = "UnpublishableTargetError";
        this.code = UNPUBLISHABLE_TARGET_CODE;
        this.registrationCode = registrationCode;
        this.targetPath = targetPath;
        this.detail = detail;
    }
}

/**
 * The reason this target path can never be prepared, or null if nothing about
 * the path ALONE decides that.
 *
 * These are exactly the checks run-authoring.mjs runs at prepare time
 * (lib/registration.mjs), run against a recorded or proposed path before
 * anything is spent. They need no network, no draft and no state. A path that
 * passes them is not thereby preparable -- registerLearningModule can still
 * refuse a path catalog.json does not declare, and that needs a registry read
 * nobody here does -- so this refuses only what the path decides on its own,
 * exactly like lib/artifact-format.mjs.
 *
 * Extracted from stranded-recovery.mjs on 2026-09-12 so the spend guard and the
 * Track 2 emitter cannot disagree about what "publishable" means. Two copies of
 * this predicate would be the same class of defect as SURFACE_CRITERIA being
 * keyed by config names while the lifecycle records contract names.
 *
 * @returns {{ code: string, message: string, targetPath: string } | null}
 */
export function publishableTargetRefusal(targetPath) {
    try {
        const surface = surfaceForTargetPath(targetPath);
        if (surface === "guide-diagram" && targetPath !== "diagrams/catalogue.json") diagramIdForTarget(targetPath);
        if (surface === "learning" && targetPath !== "catalog.json") learningPathIdForTarget(targetPath);
        return null;
    } catch (error) {
        if (!(error instanceof RegistrationError)) throw error;
        return { code: error.code, message: error.message, targetPath: String(targetPath ?? "") };
    }
}

/** The same check, as a throw, for the place that builds the target. */
export function assertPublishableTarget(targetPath) {
    const refusal = publishableTargetRefusal(targetPath);
    if (refusal) throw new UnpublishableTargetError(refusal.targetPath, refusal.code, refusal.message);
    return targetPath;
}

/**
 * What the state store is still holding that can never be published, named on
 * every run. Read-only.
 *
 * THE OTHER HALF OF THE FIX. Refusing to emit a new unroutable item does
 * nothing for the ones already in the backlog: they passed Gate 1 on a human's
 * approval and are sitting at gate1-pending, executing or gate2-ready pointing
 * at `catalog.json`. They are not migrated and they are not closed here, for
 * the reason migration 011's report does not close what it cannot map: there is
 * no path to repoint them TO, and a machine may not undo a human's Gate 1
 * approval. So they are named, with the state they are in and the move that is
 * open from it, every run, until a human acts -- the same shape as
 * reportUnmappedPublicationTargets.
 *
 * @returns {{ scanned: number, unpublishable: Array<object> }}
 */
export function reportUnpublishableTargets({ store, log = () => { } } = {}) {
    if (!store?.db) throw new TypeError("reportUnpublishableTargets requires an open state store");
    const rows = store.db.prepare(
        `SELECT r.item_id, r.item_revision, r.target_repository, r.target_path, r.record_json, w.track, w.current_state
           FROM item_revision r
           JOIN workflow_item w ON w.item_id = r.item_id
          WHERE r.item_revision = w.current_revision
            AND w.current_state NOT IN (${TERMINAL_STATES.map(() => "?").join(", ")})
          ORDER BY r.item_id`,
    ).all(...TERMINAL_STATES);

    const summary = { scanned: rows.length, unpublishable: [] };
    for (const row of rows) {
        const selector = JSON.parse(row.record_json).canonical_content_id;
        const refusal = (row.target_path === "catalog.json" || row.target_path === "diagrams/catalogue.json") && !selector
            ? { code: "catalogue.selector-missing", message: "legacy catalogue item has no canonical entry selector" }
            : publishableTargetRefusal(row.target_path);
        if (!refusal) continue;
        const entry = {
            item: row.item_id,
            revision: Number(row.item_revision),
            track: row.track,
            state: row.current_state,
            repository: row.target_repository,
            path: row.target_path,
            code: refusal.code,
            reason: refusal.message,
            action: openMoveFor(row.current_state),
        };
        summary.unpublishable.push(entry);
        log("warn", `${UNPUBLISHABLE_TARGET_EVENT}.held`, {
            ...entry,
            effect: "the item can never reach publication on this target and is named every run; nothing is retried and nothing is closed on its behalf",
        });
    }

    if (summary.unpublishable.length === 0) {
        log("info", `${UNPUBLISHABLE_TARGET_EVENT}.clear`, {
            scanned: summary.scanned,
            effect: "every live item revision targets a path some surface publishes to",
        });
        return summary;
    }
    log("warn", `${UNPUBLISHABLE_TARGET_EVENT}.summary`, {
        scanned: summary.scanned,
        unpublishable: summary.unpublishable.length,
        items: summary.unpublishable.map((entry) => `${entry.item}@r${entry.revision} (${entry.state}) -> ${entry.path}: ${entry.code}`),
    });
    return summary;
}

/**
 * The move a human actually has from this state, said plainly.
 *
 * Said plainly because it is NOT the same from every state and one of them is
 * a gap. lib/state-machine.mjs allows gate1-pending -> denied on a recorded
 * decision, so a Gate 1 item is closable by the owner today. It allows NOTHING
 * terminal out of gate2-ready: the legal moves are gate2-pending (which needs
 * evidence that will never exist for this target), executing (a fresh revision
 * against the same target, which is the loop a069ece stopped paying for),
 * blocked (whose only writer is ingest-proposals.mjs, the ensemble's own
 * review) and superseded (which needs a successor item). Telling the owner to
 * "deny it" there would be advice that does not work, so this says what is
 * true instead.
 */
function openMoveFor(state) {
    if (state === "gate1-pending") {
        return "deny it at Gate 1; the finding itself is reported by the Track 2 run summary and does not need this item to survive";
    }
    if (state === "gate2-pending") {
        return "deny it at Gate 2; re-authoring cannot change the target path, so requesting changes returns it to the same hold";
    }
    if (state === "gate2-ready") {
        return "no terminal transition exists out of gate2-ready in lib/state-machine.mjs, so this item cannot currently be closed by an operator tool; it is held, refused before any spend by lib/stranded-recovery.mjs, and needs a lifecycle decision";
    }
    return `it is at ${state}; it must reach a gate before a human can decide on it, and it will hold when it gets there`;
}
