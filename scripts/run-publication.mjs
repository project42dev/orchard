#!/usr/bin/env node
// The publication role: take a Gate 2 approved item through branch, pull
// request, merge, and acknowledgement, entirely as recorded engine evidence.
// Remediation plan T19.
//
// AUTHORITY. The only input that authorizes anything is the immutable Gate 2
// decision reference. lib/publication.mjs re-derives everything else from the
// protected authority evidence the store persisted when the owner's approval
// comment was verified, and refuses on any drift. This file adds no authority
// of its own; it schedules the engine and records the lifecycle transitions
// the state machine defines for publication:
//
//   gate2-approved          -> publication-preparing   (publication-started)
//   publication-preparing   -> publication-validating  (validation-passed)
//   publication-validating  -> publication-pr-open     (pr-reconciled)
//   publication-pr-open     -> publication-merging     (merge-started)
//   publication-merging     -> published               (publication-acknowledged)
//
// MERGING IS A DEPLOYER SETTING. With ORCHARD_PUBLICATION_MERGE unset the role
// stops at publication-pr-open: the pull request exists, protected main is
// untouched, and a human merges. Set to 'enabled', the role merges and
// acknowledges in the same run. Either way `published` is recorded only after
// protected main is observed at the exact merge commit.
//
// THE ADAPTER IS PINNED. GitHub writes go through the protected publication
// adapter: an administrator-provisioned trust anchor pins the adapter artifact
// digest, the store refuses publication evidence from any other module, and
// this role provisions the anchor from release configuration exactly the way
// the gate anchor is provisioned (the container never chooses its own pin).
//
// THE PREPARED COMMIT ARRIVES AS INPUT. Publication needs the 40-character
// commit of the prepared tree in the target repository, produced by whatever
// prepared the content. It is read from
// <evidence root>/publication-inputs/<item_id>.json and cross-checked by the
// engine against the prepared tree digest Gate 2 approved. No input file, no
// publication: the item holds at its current state with the reason logged.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStore } from "./lib/state-store.mjs";
import { publishApprovedItem, acknowledgePublication } from "./lib/publication.mjs";
import { loadProtectedAdapter, protectedAdapterDigest } from "./lib/protected-adapter.mjs";
import { generateUuidV7 } from "./lib/identity.mjs";

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

export function publicationInputPathFor(evidenceRoot, itemId) {
    return join(evidenceRoot, "publication-inputs", `${itemId}.json`);
}

/**
 * Provision the publication trust anchor from the release, once, if absent.
 * The administrator is the deployment: the digest is computed at release time
 * from the artifact in the image and bound through the template. Recomputed on
 * disk and compared before anything is written, so the container can never
 * choose its own pin. Immutable once set.
 */
export async function ensurePublicationTrustAnchor({ store, log, env = process.env }) {
    const existing = store.getTrustAnchor("publication");
    if (existing) return existing;
    const adapterPath = env.ORCHARD_PUBLICATION_ADAPTER_PATH;
    const boundDigest = env.ORCHARD_PUBLICATION_ADAPTER_DIGEST;
    if (!adapterPath || !boundDigest) {
        log("warn", "publication.anchor.unconfigured", { effect: "nothing can be published; approved work stays where it is" });
        return null;
    }
    try {
        const onDisk = await protectedAdapterDigest(adapterPath);
        if (onDisk !== boundDigest) {
            log("warn", "publication.anchor.adapter-mismatch", { effect: "the adapter in the image is not the one the release bound; nothing is provisioned" });
            return null;
        }
        const module = await import(pathToFileURL(resolve(adapterPath)).href);
        const anchor = store.provisionTrustAnchor({
            scope: "publication",
            adapter_identity: module.adapterIdentity,
            adapter_digest: onDisk,
            adapter_path: resolve(adapterPath),
            provisioned_at: new Date().toISOString(),
        });
        log("info", "publication.anchor.provisioned", { identity: module.adapterIdentity });
        return anchor;
    } catch (error) {
        log("warn", "publication.anchor.failed", { reason: error.message, effect: "nothing can be published" });
        return null;
    }
}

const PUBLISHABLE_STATES = Object.freeze([
    "gate2-approved", "publication-preparing", "publication-validating", "publication-pr-open", "publication-merging",
]);

async function advance(store, row, from, to, cause, now) {
    const current = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(row.item_id);
    if (current.current_state !== from) return current.current_state;
    await store.recordTransition({
        schema_version: "1.0.0",
        transition_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: Number(row.current_revision),
        from_state: from,
        to_state: to,
        cause,
        actor: "orchard/run-publication",
        occurred_at: now,
        correlation_id: generateUuidV7(),
    });
    return to;
}

export async function publishOne({ store, adapter, row, preparedCommit, merge, now, log }) {
    const decision = store.db.prepare(
        `SELECT event_id FROM decision_event
          WHERE item_id = ? AND item_revision = ? AND gate = 'gate-2' AND decision = 'approve'
          ORDER BY occurred_at DESC LIMIT 1`,
    ).get(row.item_id, Number(row.current_revision));
    if (!decision) throw new Error("no recorded Gate 2 approval decision event; publication has no authority to act on");
    const authorityReference = { gate2_decision_event_id: decision.event_id };

    let state = row.current_state;
    if (state === "gate2-approved") state = await advance(store, row, "gate2-approved", "publication-preparing", "publication-started", now);

    // Branch and pull request. Idempotent: a replayed transaction is compared
    // field by field against the persisted one and reconciled, never redone.
    const opened = await publishApprovedItem({ authorityReference, preparedCommit, adapter, store, apply: true, merge: false });
    state = await advance(store, row, "publication-preparing", "publication-validating", "validation-passed", now);
    state = await advance(store, row, "publication-validating", "publication-pr-open", "pr-reconciled", now);
    log("info", "publication.pr-open", { item: row.item_id, pull: opened.pull_request?.number ?? null, branch: opened.transaction?.target?.branch ?? null });
    if (!merge) return { state, operation: "merge-pending", pull_request: opened.pull_request };

    state = await advance(store, row, "publication-pr-open", "publication-merging", "merge-started", now);
    const merged = await publishApprovedItem({ authorityReference, preparedCommit, adapter, store, apply: true, merge: true });
    const acknowledged = await acknowledgePublication({ idempotencyKey: merged.transaction.idempotency_key, adapter, store });
    if (acknowledged.state !== "published") throw new Error(`publication engine state is ${acknowledged.state}, not published`);
    state = await advance(store, row, "publication-merging", "published", "publication-acknowledged", now);
    log("info", "publication.published", { item: row.item_id, resultCommit: acknowledged.result_commit });
    return { state, operation: "published", result_commit: acknowledged.result_commit };
}

export async function main(argv = process.argv.slice(2), { log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })), env = process.env } = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) throw Object.assign(new Error("run-publication requires --state-db"), { code: "ERR_ORCHARD_CONFIGURATION" });
    const evidenceRoot = env.ORCHARD_EVIDENCE_ROOT ?? env.RUN_RECORD_ROOT ?? process.cwd();
    const merge = env.ORCHARD_PUBLICATION_MERGE === "enabled";
    const now = new Date().toISOString();
    const store = openStateStore(resolve(dbPath));
    const summary = { published: 0, prOpen: 0, held: 0 };
    try {
        const placeholders = PUBLISHABLE_STATES.map(() => "?").join(", ");
        const rows = store.db.prepare(
            `SELECT item_id, track, current_state, current_revision, origin_run_id FROM workflow_item
              WHERE current_state IN (${placeholders}) ORDER BY updated_at, item_id`,
        ).all(...PUBLISHABLE_STATES);
        if (rows.length === 0) {
            log("info", "publication.nothing-approved", { effect: "no Gate 2 approved item is waiting" });
            return summary;
        }
        const anchor = await ensurePublicationTrustAnchor({ store, log, env });
        if (!anchor) {
            summary.held = rows.length;
            return summary;
        }
        const adapter = await loadProtectedAdapter(store, "publication", "reconcileBeforeCreateBranch");
        for (const row of rows) {
            const inputPath = publicationInputPathFor(evidenceRoot, row.item_id);
            if (!existsSync(inputPath)) {
                summary.held += 1;
                log("warn", "publication.no-input", {
                    item: row.item_id, state: row.current_state, path: inputPath,
                    effect: "the item holds; publication needs the prepared commit for its approved tree",
                });
                continue;
            }
            try {
                const input = JSON.parse(readFileSync(inputPath, "utf8"));
                const result = await publishOne({ store, adapter, row, preparedCommit: input.prepared_commit, merge, now, log });
                if (result.operation === "published") summary.published += 1;
                else summary.prOpen += 1;
            } catch (error) {
                summary.held += 1;
                log("warn", "publication.refused", {
                    item: row.item_id, code: error.code ?? null, reason: error.message,
                    effect: "the item stays where it is; nothing partial was recorded as published",
                });
            }
        }
        log("info", "publication.finished", summary);
        return summary;
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
