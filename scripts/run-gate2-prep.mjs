#!/usr/bin/env node
// The Gate 2 preparation role: turn an authored item into something a human
// can actually decide on. Remediation plan T19.
//
// THE GAP THIS CLOSES. The state machine has always allowed
// gate2-ready -> gate2-pending (cause proposal-ready), and NOTHING in the
// deployed system ever recorded that transition: an authored item reached
// gate2-ready and sat there, unannounced, forever. The transition existed only
// in tests.
//
// WHAT PREPARATION MEANS, concretely. A Gate 2 decision binds to the exact
// artifact: its digest, its handoff chain, its prepared tree, its base commit,
// its review evidence. So before an item may be held pending, this role:
//   1. records the agent handoff chain that produced the artifact (each
//      handoff is contract-validated by the store),
//   2. records the immutable artifact binding, which the store refuses unless
//      it matches the exact final handoff,
//   3. records the Gate 2 manifest entry as observation evidence, the same
//      mechanism Gate 1 uses, so announce-gates renders the full binding table
//      for the owner,
//   4. records the gate2-ready -> gate2-pending transition.
// The runtime then announces Gate 2 exactly as it announces Gate 1.
//
// EVIDENCE ARRIVES, IT IS NEVER FABRICATED. The evidence for one item is a
// JSON document at <evidence root>/gate2-evidence/<item_id>.json carrying the
// handoff records, the artifact binding, and the manifest fields the authoring
// stage can attest (diff and tree digests, base commit, review outcomes). An
// item with no evidence, or evidence the store's contracts reject, is HELD at
// gate2-ready with the reason logged. Holding honestly beats inventing a
// review result, which is the defect class Gate 2 exists to prevent.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStore } from "./lib/state-store.mjs";
import { GATE_MANIFEST_REFERENCE_PREFIX } from "./lib/gate-queue.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

export function evidencePathFor(evidenceRoot, itemId) {
    return join(evidenceRoot, "gate2-evidence", `${itemId}.json`);
}

const MANIFEST_FIELDS = ["displayed_diff_digest", "prepared_tree_digest", "base_commit", "diff_ref", "artifact_ref"];
const REVIEW_FIELDS = ["tests", "factual_review", "accessibility_review", "cost"];

/**
 * Prepare one gate2-ready item from its evidence document. Throws on any
 * refusal so the caller can hold the item and log exactly why.
 */
export async function prepareItem({ store, row, evidence, now, actor = "orchard/run-gate2-prep", extra = {} }) {
    if (!Array.isArray(evidence.handoffs) || evidence.handoffs.length === 0) {
        throw new Error("evidence carries no handoff chain");
    }
    if (!evidence.artifact_binding) throw new Error("evidence carries no artifact binding");
    for (const field of [...MANIFEST_FIELDS, ...REVIEW_FIELDS]) {
        if (evidence.manifest?.[field] === undefined) throw new Error(`evidence manifest is missing ${field}`);
    }
    const revision = Number(row.current_revision);
    const revisionRecord = store.db.prepare(
        "SELECT proposal_digest, target_repository, target_path FROM item_revision WHERE item_id = ? AND item_revision = ?",
    ).get(row.item_id, revision);
    const link = store.db.prepare(
        `SELECT external_key FROM external_link
          WHERE provider = 'ado' AND item_id = ? AND item_revision = ?
          ORDER BY linked_at DESC LIMIT 1`,
    ).get(row.item_id, revision);
    if (!link) throw new Error("no persisted ADO link; Gate 2 binds the tracker item and cannot proceed without it");

    // The store validates every record. A handoff that names the wrong item,
    // a binding whose digest is not the final handoff's output: each throws
    // here, before any state moves.
    for (const handoff of evidence.handoffs) await store.recordHandoff(handoff);
    const binding = store.recordArtifactBinding(evidence.artifact_binding);
    if (binding.item_id !== row.item_id || Number(binding.item_revision) !== revision) {
        throw new Error("artifact binding does not name this item revision");
    }

    const manifestItem = {
        item_id: row.item_id,
        item_revision: revision,
        artifact_digest: binding.artifact_digest,
        proposal_digest: revisionRecord.proposal_digest,
        displayed_diff_digest: evidence.manifest.displayed_diff_digest,
        prepared_tree_digest: evidence.manifest.prepared_tree_digest,
        target: { repository: revisionRecord.target_repository, path: revisionRecord.target_path },
        base_commit: evidence.manifest.base_commit,
        diff_ref: evidence.manifest.diff_ref,
        artifact_ref: evidence.manifest.artifact_ref,
        ado_external_key: link.external_key,
        handoff_chain_digest: evidence.manifest.handoff_chain_digest
            ?? sha256Digest({ handoffs: evidence.handoffs.map((handoff) => sha256Digest(handoff)) }),
        tests: evidence.manifest.tests,
        factual_review: evidence.manifest.factual_review,
        accessibility_review: evidence.manifest.accessibility_review,
        cost: evidence.manifest.cost,
        decision_state: "pending",
        // Rejection-gate escalation (docs/design/rejection-gate.md) is the
        // only caller that ever passes `extra` -- the normal path's default
        // {} spreads to nothing, so an ordinary item's manifest is byte-for-
        // byte what it always was.
        ...extra,
    };
    store.recordObservation({
        observation_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: revision,
        evidence_reference: `${GATE_MANIFEST_REFERENCE_PREFIX}gate-2:${row.item_id}`,
        evidence_digest: sha256Digest(manifestItem),
        observed_at: now,
        gate: "gate-2",
        manifest_item: manifestItem,
    });
    await store.recordTransition({
        schema_version: "1.0.0",
        transition_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: revision,
        from_state: "gate2-ready",
        to_state: "gate2-pending",
        cause: "proposal-ready",
        actor,
        occurred_at: now,
        correlation_id: generateUuidV7(),
    });
    return manifestItem;
}

export async function main(argv = process.argv.slice(2), { log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })), env = process.env } = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) throw Object.assign(new Error("run-gate2-prep requires --state-db"), { code: "ERR_ORCHARD_CONFIGURATION" });
    const evidenceRoot = env.ORCHARD_EVIDENCE_ROOT ?? env.RUN_RECORD_ROOT ?? process.cwd();
    const now = new Date().toISOString();
    const store = openStateStore(resolve(dbPath));
    const summary = { prepared: 0, held: 0 };
    try {
        const rows = store.db.prepare(
            `SELECT item_id, track, current_revision, origin_run_id FROM workflow_item
              WHERE current_state = 'gate2-ready' ORDER BY updated_at, item_id`,
        ).all();
        if (rows.length === 0) {
            log("info", "gate2.prep.nothing-ready", { effect: "no authored item is waiting for Gate 2 preparation" });
            return summary;
        }
        for (const row of rows) {
            const path = evidencePathFor(evidenceRoot, row.item_id);
            if (!existsSync(path)) {
                summary.held += 1;
                log("warn", "gate2.prep.no-evidence", {
                    item: row.item_id, path,
                    effect: "the item stays gate2-ready; evidence is supplied, never fabricated",
                });
                continue;
            }
            try {
                const evidence = JSON.parse(readFileSync(path, "utf8"));
                await prepareItem({ store, row, evidence, now });
                summary.prepared += 1;
                log("info", "gate2.prep.pending", { item: row.item_id, state: "gate2-pending" });
            } catch (error) {
                summary.held += 1;
                log("warn", "gate2.prep.refused", {
                    item: row.item_id, code: error.code ?? null, reason: error.message,
                    effect: "the item stays gate2-ready",
                });
            }
        }
        log("info", "gate2.prep.finished", summary);
        return summary;
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
