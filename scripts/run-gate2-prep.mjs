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
// document carrying the handoff records, the artifact binding, and the
// manifest fields the authoring stage can attest (diff and tree digests, base
// commit, review outcomes). An item with no evidence, or evidence the store's
// contracts reject, is HELD at gate2-ready with the reason logged. Holding
// honestly beats inventing a review result, which is the defect class Gate 2
// exists to prevent.
//
// WHERE THE EVIDENCE LIVES: THE STATE STORE, NEVER A LOCAL DISK. Every
// Container Apps job has its own ephemeral filesystem and no Orchard job
// mounts a volume. Until 2026-09-11 the authoring stage wrote the evidence to
// <evidence root>/gate2-evidence/<item_id>.json on ITS disk, and this role
// looked for that file on ITS OWN, different, disk -- so the check could only
// ever fail, and every item that missed the authoring run's one in-process
// window stranded at gate2-ready for good (project42dev-ops
// pmo/plans/orchard-gate2-ready-stranding-analysis-2026-09-10.md). The rule
// now: anything that must survive from one job to another belongs in the
// state store. persistGate2Evidence records the whole document as an
// observation (orchard/gate2-evidence/<item>:r<rev>) inside the SQLite file
// BlobStateAdapter publishes under its fencing lease, and loadGate2Evidence
// reads it back for the item's CURRENT revision. The file is still read as a
// fallback, but it is scratch space, not the contract.

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

export const GATE2_EVIDENCE_REFERENCE_PREFIX = "orchard/gate2-evidence/";

export function gate2EvidenceReference(itemId, revision) {
    return `${GATE2_EVIDENCE_REFERENCE_PREFIX}${itemId}:r${Number(revision)}`;
}

/**
 * Make one item revision's Gate 2 evidence durable, BEFORE anything tries to
 * prepare the item from it. `extra` is what the inline caller spreads into the
 * manifest (the artifact content, or an escalation's rejection reason and
 * draft); it travels with the evidence so a later retry shows the owner exactly
 * what the inline attempt would have.
 *
 * recordObservation validates no payload (there is no observation schema), so
 * tests/gate2-evidence-store.test.mjs is the guard that this record survives
 * the store and still satisfies prepareItem and the store's exact-replay
 * checks on the handoffs and the binding.
 */
export function persistGate2Evidence({ store, row, evidence, now, extra = {} }) {
    const revision = Number(row.current_revision);
    const payload = { gate2_evidence: evidence, gate2_manifest_extra: extra };
    store.recordObservation({
        observation_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: revision,
        evidence_reference: gate2EvidenceReference(row.item_id, revision),
        evidence_digest: sha256Digest(payload),
        observed_at: now,
        ...payload,
    });
    return gate2EvidenceReference(row.item_id, revision);
}

function evidenceNamesRevision(evidence, row) {
    const binding = evidence?.artifact_binding;
    return Boolean(binding) && binding.item_id === row.item_id
        && Number(binding.item_revision) === Number(row.current_revision);
}

/**
 * Find the evidence for a gate2-ready row: the most recent store observation
 * for its CURRENT revision first, the legacy file only as a fallback. Returns
 * null when neither exists.
 *
 * Revision-scoped on purpose. A re-authored item has a new revision, and the
 * previous revision's evidence must never be handed to prepareItem: it records
 * handoffs and a binding before it checks the revision, so stale evidence would
 * leave rows behind for a revision that is no longer the item's. The file name
 * carries no revision at all, so a file that names another revision is refused
 * here rather than half-applied.
 */
export function loadGate2Evidence({ store, row, evidenceRoot }) {
    const revision = Number(row.current_revision);
    const observed = store.db.prepare(
        `SELECT record_json FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?
          ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
    ).get(row.item_id, revision, gate2EvidenceReference(row.item_id, revision));
    if (observed) {
        const record = JSON.parse(observed.record_json);
        return { source: "state-store", evidence: record.gate2_evidence, extra: record.gate2_manifest_extra ?? {} };
    }
    if (!evidenceRoot) return null;
    const path = evidencePathFor(evidenceRoot, row.item_id);
    if (!existsSync(path)) return null;
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    if (!evidenceNamesRevision(evidence, row)) {
        throw Object.assign(
            new Error(`evidence file ${path} does not bind item ${row.item_id} revision ${revision}; refusing stale evidence`),
            { code: "ERR_ORCHARD_STALE_EVIDENCE" },
        );
    }
    return { source: "file", path, evidence, extra: {} };
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
            try {
                const found = loadGate2Evidence({ store, row, evidenceRoot });
                if (!found) {
                    summary.held += 1;
                    log("warn", "gate2.prep.no-evidence", {
                        item: row.item_id,
                        reference: gate2EvidenceReference(row.item_id, row.current_revision),
                        path: evidencePathFor(evidenceRoot, row.item_id),
                        effect: "the item stays gate2-ready; evidence is supplied, never fabricated",
                    });
                    continue;
                }
                await prepareItem({ store, row, evidence: found.evidence, now, extra: found.extra });
                summary.prepared += 1;
                log("info", "gate2.prep.pending", { item: row.item_id, state: "gate2-pending", evidenceSource: found.source });
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
