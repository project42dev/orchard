// Pick up Gate 2 rework: the successor revision nobody was creating.
//
// THE DEFECT, measured 2026-09-13. A Gate 2 `request-changes` moves an item to
// 'changes-requested', and apply-gate2-rework.mjs's header said the successor
// revision back to 'executing' "is created by the authoring runtime when it
// picks the rework up". Nothing did. generate-briefs.mjs selects only
// 'ado-linked' and binding-free 'executing' items, run-authoring.mjs never
// mentioned 'changes-requested', and job-chain.mjs counted nothing in that state,
// so no job was ever started for it either. Executed against a fixture on
// f39cd6b: after applyRework the brief generator reported queued 0, eligible 0,
// and the chain's authoring count was 0. In production, item
// 01a024de-1918-7baf-985c-252d89570314 was returned at 2026-09-12 23:29 UTC and
// three authoring runs later (00:38-00:55 UTC) had not been redrafted.
//
// WHAT THIS DOES. Each authoring run, before briefs are claimed, reopens the
// items a human returned at Gate 2 through the SAME recovery
// apply-blocked-retry.mjs already performs for blocked and stranded items: a
// successor item_revision carrying the approved proposal unchanged, the ADO link
// and Gate 1 manifest copied forward onto it, and the one legal transition
// (revision-created, recovery_gate gate-2) to 'executing'. From there the
// unchanged generate-briefs recovery query claims it in the same run, and
// reworkNoteFor puts the reviewer's reason at the top of the brief.
//
// WHAT IT REFUSES, and names every run:
//   * a Gate 1 return. It goes back to the proposal, not to authoring; see
//     lib/rework-gate.mjs.
//   * an item whose recorded target repository is not the publication
//     repository, or whose target path no surface publishes to -- the same two
//     permanent refusals stranded-recovery.mjs applies, for the same reason:
//     re-authoring cannot change the target, so drafting only pays to reach the
//     identical hold.
//
// WHAT IT DELIBERATELY DOES NOT COPY FROM stranded-recovery.mjs:
//   * the stored-Gate-2-evidence refusal. Every item a human returned from
//     gate2-pending was prepared from stored evidence for its current revision,
//     so that check would refuse every single rework. Stored evidence is the
//     thing the reviewer rejected; it is not a reason to skip the redraft.
//   * the lifetime automatic-attempt cap. A stranded item can be recovered with
//     no human involved, so it needs one. A rework item cannot come back here
//     without a human deciding request-changes again on a new revision: this
//     sweep moves it to 'executing', and the only way back to
//     'changes-requested' is through gate2-pending and another decision. Each
//     pickup consumes exactly one human decision, so there is no loop to cap.
//
// SPEND. A recovered item is re-drafted, which spends. The per-run cap below
// bounds that, and run-authoring passes the run's own affordable item count so
// this sweep never reopens more than the run can draft; anything reopened but
// not drafted stays 'executing' without a binding, which the next run's briefs
// claim and the chain counts as authoring-recoverable.

import { applyRetry } from "../apply-blocked-retry.mjs";
import { PUBLICATION_REPOSITORY } from "./publication.mjs";
import { publishableTargetRefusal } from "./publishable-target.mjs";
import { reworkGateOf } from "./rework-gate.mjs";

export const REWORK_ACTOR = "orchard/rework-recovery";
export const REWORK_EVENT = "gate2.rework";
export const DEFAULT_MAX_REWORK_ITEMS = 5;

export function resolveReworkBounds(env = process.env) {
    const raw = env.ORCHARD_REWORK_RECOVERY_MAX_ITEMS;
    if (raw === undefined || raw === null || raw === "") return { maxItems: DEFAULT_MAX_REWORK_ITEMS };
    const parsed = Number(raw);
    return { maxItems: Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_REWORK_ITEMS };
}

/**
 * Every item sitting in a rework state, split into the ones this sweep would
 * reopen and the ones it refuses, with the reason. Pure: it writes nothing, so
 * the chain trigger's lease-free peek (BlobStateAdapter.peekStateCounts) counts
 * with the exact predicate the sweep acts on. Counting a refused item there
 * would start authoring for work authoring will not touch.
 */
export function classifyReworkItems(db, { track = null } = {}) {
    const rows = db.prepare(
        `SELECT w.item_id, w.track, w.current_state, w.current_revision, r.target_repository, r.target_path, r.record_json
           FROM workflow_item w
           JOIN item_revision r ON r.item_id = w.item_id AND r.item_revision = w.current_revision
          WHERE w.current_state IN ('changes-requested', 'stale-approval') AND (? IS NULL OR w.track = ?)
          ORDER BY w.updated_at, w.item_id`,
    ).all(track, track);

    const eligible = [];
    const refused = [];
    for (const row of rows) {
        const origin = reworkGateOf(db, row);
        if (origin?.gate !== "gate-2") {
            refused.push({
                item: row.item_id, state: row.current_state,
                reason: origin
                    ? `it was returned at ${origin.gate}; a Gate 1 return goes back to the proposal, not to authoring`
                    : `nothing on record says which gate returned it to ${row.current_state}, so no recovery gate can be claimed for it`,
            });
            continue;
        }
        if (row.target_repository !== PUBLICATION_REPOSITORY) {
            refused.push({
                item: row.item_id, state: row.current_state,
                reason: `the recorded publication target is ${row.target_repository}, not ${PUBLICATION_REPOSITORY}; it must be repointed before it is worth re-authoring`,
            });
            continue;
        }
        const missingSelector = (row.target_path === "catalog.json" || row.target_path === "diagrams/catalogue.json")
            && !JSON.parse(row.record_json).canonical_content_id;
        const targetRefusal = missingSelector
            ? { code: "catalogue.selector-missing", message: "legacy catalogue item has no canonical entry selector" }
            : publishableTargetRefusal(row.target_path);
        if (targetRefusal) {
            refused.push({
                item: row.item_id, state: row.current_state,
                reason: `its recorded target path ${row.target_path} is refused before any draft exists (${targetRefusal.code}: ${targetRefusal.message}); re-authoring cannot change the target`,
            });
            continue;
        }
        eligible.push({ ...row, decisionEventId: origin.decisionEventId });
    }
    return { eligible, refused };
}

/** The chain trigger's count: exactly the items recoverReworkItems would reopen. */
export function countRecoverableRework(db) {
    return classifyReworkItems(db).eligible.length;
}

/**
 * Reopen Gate 2 rework at 'executing', oldest first, up to the cap.
 *
 * @param {object} options
 * @param {number} [options.limit] a tighter cap from the caller (run-authoring
 *   passes the number of items its spend ceiling can draft this run).
 */
export async function recoverReworkItems({
    store, track = null, now = null, env = process.env, limit = null,
    log = () => { }, retry = applyRetry,
} = {}) {
    const bounds = resolveReworkBounds(env);
    const maxItems = Number.isInteger(limit) && limit >= 0 ? Math.min(bounds.maxItems, limit) : bounds.maxItems;
    const { eligible, refused } = classifyReworkItems(store.db, { track });
    const summary = { waiting: eligible.length + refused.length, recovered: [], refused: [], remaining: 0, maxItems };

    const refuse = (entry) => {
        summary.refused.push({ item: entry.item, reason: entry.reason });
        log("warn", `${REWORK_EVENT}.refused`, {
            item: entry.item, state: entry.state, track, reason: entry.reason,
            effect: "the item stays where it is and is named again on the next run; nothing is re-drafted blind",
        });
    };
    for (const entry of refused) refuse(entry);

    let failed = 0;
    for (const row of eligible) {
        if (summary.recovered.length >= maxItems) break;
        const result = await retry(store, { item: row.item_id, now, actor: REWORK_ACTOR });
        if (result.retried !== 1) {
            failed += 1;
            refuse({ item: row.item_id, state: row.current_state, reason: result.errors.join("; ") || "the recovery was refused without a reason" });
            continue;
        }
        summary.recovered.push({ item: row.item_id, track: row.track, from: row.current_state, revision: result.revision });
        log("info", `${REWORK_EVENT}.recovered`, {
            item: row.item_id, track: row.track, from: row.current_state, revision: result.revision,
            effect: "reopened at executing with the reviewer's reason on the brief; this run's authoring pass re-drafts it, which spends",
        });
    }

    // Only eligible work counts as remaining. A deterministic refusal is not a
    // backlog another authoring run can drain, and continueAuthoringChain reads
    // this number to decide whether to start one.
    summary.remaining = Math.max(0, eligible.length - summary.recovered.length - failed);
    log(summary.remaining > 0 || summary.refused.length > 0 ? "warn" : "info", `${REWORK_EVENT}.summary`, {
        track,
        waiting: summary.waiting,
        recovered: summary.recovered.length,
        refused: summary.refused.length,
        remaining: summary.remaining,
        maxItems,
        refusals: summary.refused.map((entry) => `${entry.item}: ${entry.reason}`),
    });
    return summary;
}
