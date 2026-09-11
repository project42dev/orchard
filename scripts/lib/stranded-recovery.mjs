// Recover items stranded at gate2-ready, automatically and boundedly.
//
// WHY THEY ARE STRANDED, exactly. `gate2.prep.no-evidence` appeared 114 times
// in the run logs and it is a symptom, not a cause. Three facts together make it
// structurally guaranteed, on every run, for every stranded item:
//
//   1. run-authoring.mjs's attemptGate2Evidence only looks at items THIS run
//      just moved to gate2-ready (`applied.filter(entry => entry.to ===
//      "gate2-ready")`). An item that reached gate2-ready in an earlier
//      execution is never looked at again by the stage that could prepare it.
//   2. The evidence document it writes goes to ORCHARD_EVIDENCE_ROOT, and the
//      winning proposal it reads lives under PROPOSAL_ROOT. Neither is set in
//      the deployed job definitions and infra/orchard.bicep mounts no volume on
//      any job, so both resolve to the ephemeral disk of the container that
//      produced them and are destroyed when that execution ends.
//   3. run-gate2-prep.mjs runs as a SEPARATE Container Apps job with its own
//      filesystem, and looks for exactly those files. It can never find one.
//
// So this is not a missing input to supply and not a path the content-repository
// repoint moved. The inputs existed and were thrown away with the container. The
// only honest recovery is a fresh authoring attempt, which is precisely what
// apply-blocked-retry.mjs's gate2-ready path already does -- one item at a time,
// named by an operator, driven by nobody. This drives it.
//
// WHAT IT COSTS, SAID OUT LOUD. A recovered item returns to 'executing' and the
// same run's generate-briefs pass claims it, so recovery spends Foundry credit
// per item. That is why it is bounded twice over: at most MAX_ITEMS items are
// recovered per run, and an item that has already been recovered automatically
// MAX_ATTEMPTS times is never retried again -- it is named, every run, as
// needing a human. Silent unbounded retrying of an item that cannot succeed is
// how a budget disappears.
//
// WHAT IS NOT STRANDED, SINCE 2026-09-11. The authoring stage now persists each
// item's Gate 2 evidence to the state store before it tries to prepare the item
// (run-gate2-prep.mjs persistGate2Evidence), and gate2-prep reads it back from
// there. A gate2-ready row that HAS that evidence for its current revision is
// therefore not stranded: gate2-prep prepares it for nothing. Re-authoring it
// here would spend to throw real, preparable work away, so it is named and
// left for gate2-prep. The backlog this sweep exists for -- items whose
// evidence died with a container -- has no such record and is unaffected.

import { applyRetry } from "../apply-blocked-retry.mjs";
import { gate2EvidenceReference } from "../run-gate2-prep.mjs";
import { PUBLICATION_REPOSITORY } from "./publication.mjs";

export const STRANDED_ACTOR = "orchard/stranded-recovery";
export const RECOVERY_EVENT = "gate2.stranded";

// Deliberately small. Every recovered item is re-authored by the ensemble, so
// this is a spend cap wearing a different hat. An operator raises it knowing
// that; nothing raises it on its own.
export const DEFAULT_MAX_ITEMS = 5;
export const DEFAULT_MAX_ATTEMPTS = 2;

function positiveInteger(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveRecoveryBounds(env = process.env) {
    return {
        maxItems: positiveInteger(env.ORCHARD_STRANDED_RECOVERY_MAX_ITEMS, DEFAULT_MAX_ITEMS),
        maxAttempts: positiveInteger(env.ORCHARD_STRANDED_RECOVERY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    };
}

/**
 * How many times this item has already been recovered automatically. Counted
 * from the recovery transitions themselves rather than a counter column: the
 * transitions are append-only and are the record, and a counter would be a
 * second version of the truth that could drift from it.
 */
function automaticAttempts(db, itemId) {
    return Number(db.prepare(
        `SELECT count(*) AS n FROM state_transition_event
          WHERE item_id = ? AND to_state = 'executing' AND cause = 'revision-created'
            AND json_extract(record_json, '$.actor') = ?`,
    ).get(itemId, STRANDED_ACTOR).n);
}

function hasStoredGate2Evidence(db, row) {
    return Boolean(db.prepare(
        `SELECT 1 FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ? LIMIT 1`,
    ).get(row.item_id, Number(row.current_revision), gate2EvidenceReference(row.item_id, row.current_revision)));
}

/**
 * Reopen the oldest stranded gate2-ready items, up to the run's cap, and report
 * everything: what was recovered, what was refused and why, and how much is
 * still waiting.
 *
 * @param {object} options
 * @param {Set<string>|string[]} [options.exclude] items this run just moved to
 *   gate2-ready. They have not been stranded yet -- their evidence attempt is
 *   this run's, and retrying them here would spend twice for one item.
 */
export async function recoverStrandedItems({
    store, track = null, now = null, exclude = [], env = process.env,
    log = () => { }, retry = applyRetry,
} = {}) {
    const { maxItems, maxAttempts } = resolveRecoveryBounds(env);
    const skipIds = exclude instanceof Set ? exclude : new Set(exclude);
    const summary = { stranded: 0, recovered: [], refused: [], remaining: 0, maxItems, maxAttempts };

    const rows = store.db.prepare(
        `SELECT w.item_id, w.track, w.current_revision, r.target_repository
           FROM workflow_item w
           JOIN item_revision r ON r.item_id = w.item_id AND r.item_revision = w.current_revision
          WHERE w.current_state = 'gate2-ready' AND (? IS NULL OR w.track = ?)
          ORDER BY w.updated_at, w.item_id`,
    ).all(track, track);

    const candidates = rows.filter((row) => !skipIds.has(row.item_id));
    summary.stranded = candidates.length;
    if (candidates.length === 0) {
        log("info", `${RECOVERY_EVENT}.none`, { track, effect: "no item is waiting at gate2-ready from an earlier run" });
        return summary;
    }

    const refuse = (row, reason) => {
        summary.refused.push({ item: row.item_id, reason });
        log("warn", `${RECOVERY_EVENT}.refused`, {
            item: row.item_id, track: row.track, reason,
            effect: "the item stays at gate2-ready and is named again on the next run; nothing is retried blind",
        });
    };

    for (const row of candidates) {
        if (summary.recovered.length >= maxItems) break;

        // A recovered item is re-authored and then prepared against its
        // recorded target. An item still pointing at the old repository would
        // be re-authored into the product repo -- the exact drift the
        // publication refusal exists to stop -- so it is refused here and
        // reported by the target migration's own pass instead.
        if (row.target_repository !== PUBLICATION_REPOSITORY) {
            refuse(row, `the recorded publication target is ${row.target_repository}, not ${PUBLICATION_REPOSITORY}; it must be repointed before it is worth re-authoring`);
            continue;
        }

        // Checked before the attempt cap, and it spends nothing: the evidence
        // for this exact revision is durable, so gate2-prep is the path.
        if (hasStoredGate2Evidence(store.db, row)) {
            refuse(row, "its Gate 2 evidence for this revision is in the state store; gate2-prep prepares it without re-authoring, so nothing is spent on it here");
            continue;
        }

        const attempts = automaticAttempts(store.db, row.item_id);
        if (attempts >= maxAttempts) {
            refuse(row, `already recovered automatically ${attempts} time(s); a human has to look at why it will not prepare, because retrying it again only spends`);
            continue;
        }

        const result = await retry(store, { item: row.item_id, now, actor: STRANDED_ACTOR });
        if (result.retried !== 1) {
            refuse(row, result.errors.join("; ") || "the recovery was refused without a reason");
            continue;
        }
        summary.recovered.push({ item: row.item_id, track: row.track, revision: result.revision, attempt: attempts + 1 });
        log("info", `${RECOVERY_EVENT}.recovered`, {
            item: row.item_id, track: row.track, revision: result.revision, attempt: attempts + 1,
            effect: "reopened at executing; this run's authoring pass re-drafts it, which spends",
        });
    }

    summary.remaining = summary.stranded - summary.recovered.length;
    // Loud on purpose, even when everything worked: a backlog being worked off
    // five at a time is information the owner needs every run, not once.
    log(summary.remaining > 0 ? "warn" : "info", `${RECOVERY_EVENT}.summary`, {
        track,
        stranded: summary.stranded,
        recovered: summary.recovered.length,
        refused: summary.refused.length,
        remaining: summary.remaining,
        maxItems,
        maxAttempts,
        refusals: summary.refused.map((entry) => `${entry.item}: ${entry.reason}`),
    });
    return summary;
}
