// A FINDING WITH NOWHERE TO PUBLISH IT IS STILL A FINDING. IT IS NOT A PROPOSAL.
//
// FOUND 2026-09-12, by execution against the pinned corpus. Track 2 enumerates
// 212 canonical items from the platform checkout, and 29 of them have no
// publishable artifact at all:
//
//   catalogue:content          the catalogue itself       -> catalog.json
//   catalogue:guide-diagrams   the diagram catalogue      -> diagrams/catalogue.json
//   learning-path:* (14)       a catalog `paths[]` entry  -> catalog.json
//   learning-module:* (6)      a catalog `modules[]` entry with no backing file
//   guide:* (7)                a catalog `resources[]` entry with no backing file
//
// Every one of them is a real thing to inspect -- a learning path whose
// description has gone stale is exactly the kind of rot currency exists to
// find -- and every one of them has the SAME sourcePath: the catalogue that
// declares it. contentRepositoryPathFor maps that to `catalog.json` (or
// `diagrams/catalogue.json`), and no surface publishes to either:
// surfaceForTargetPath refuses `catalog.json` with
// registration.unrecognized-target, and diagramIdForTarget refuses
// `diagrams/catalogue.json` with registration.unrecognized-diagram-path.
//
// So Track 2 emitted a PUBLISHABLE Gate 1 item for a finding that can never be
// published. It passed Gate 1 on a human's approval, spent Foundry credit on
// authoring, reached the identical structural hold, and sat there. a069ece
// stopped the spending (permanentTargetRefusal, below) but left the item in the
// backlog forever, and the finding itself -- the thing a human actually needed
// to hear -- went nowhere.
//
// WHY THE FIX IS "DO NOT PROPOSE IT", NOT "TEACH PUBLICATION TO EDIT A REGISTRY".
//
//   1. contracts/schemas/item-record.schema.json and
//      gate-1-issue-manifest.schema.json are closed: additionalProperties
//      false, `surface` a three-value enum, `outcome` and `category` fixed
//      enums. A "registry-edit" finding kind is a contract change in a
//      repository whose own comment on TARGET_REPOSITORY says these are
//      "fixed by contract, not by configuration".
//   2. Publication is ONE blob at ONE path plus that surface's registry entry
//      (lib/registration.mjs, and item_revision.target_path is a single
//      scalar). A registry-only edit has no blob, so it needs a second
//      lifecycle branch through authoring, Gate 2 and prepareRealCommit that
//      does not exist and would be entered by nothing else.
//   3. The item that IS publishable for most of these findings already exists
//      and is separately inspected. A stale learning-path description is a
//      catalog edit; a catalog entry pointing at a file that is not there is a
//      catalog edit. Neither is content this pipeline authors.
//
// AND WHY IT IS NOT A SILENT DROP. A real finding that disappears is its own
// defect, and a worse one, because nothing measures it. So the refusal is
// carried out of the controller as data (runTrack2's findings.unroutable), said
// in the run log, and printed in the Track 2 run summary issue -- the thing the
// owner actually reads -- naming the item, the classification, the evidence,
// the target that has no surface, and the refusal code. See lib/run-summary.mjs.

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
        if (surface === "guide-diagram") diagramIdForTarget(targetPath);
        if (surface === "learning") learningPathIdForTarget(targetPath);
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
        `SELECT r.item_id, r.item_revision, r.target_repository, r.target_path, w.track, w.current_state
           FROM item_revision r
           JOIN workflow_item w ON w.item_id = r.item_id
          WHERE r.item_revision = w.current_revision
            AND w.current_state NOT IN (${TERMINAL_STATES.map(() => "?").join(", ")})
          ORDER BY r.item_id`,
    ).all(...TERMINAL_STATES);

    const summary = { scanned: rows.length, unpublishable: [] };
    for (const row of rows) {
        const refusal = publishableTargetRefusal(row.target_path);
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
