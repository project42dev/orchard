#!/usr/bin/env node
// The authoring role: pick up Gate 1 approved, ADO-linked work and run the
// PROVEN PowerShell authoring ensemble on it. Remediation plan T19.
//
// ARCHITECTURE. Two runtimes exist and they stay separate, by explicit
// decision rather than accident:
//
//   delivery/Dockerfile             the eight-phase PowerShell engine image.
//                                   Proven working (verifier PASS, real
//                                   authoring proposals) and never deployed
//                                   until T19.
//   delivery/Dockerfile.two-track   the lean Node runtime that runs the five
//                                   deployed survey and seed jobs.
//
// This file is the thin Node wrapper that bridges them. It runs INSIDE the
// engine image, which carries Node 22 and these scripts alongside pwsh, and it
// shells out to Invoke-Project42Delivery.ps1 with -Execute for the ensemble
// itself, which is exactly how the engine's own phase 6 invokes it. The two
// stacks hand off purely through the shared workflow_item state store; no code
// is shared, no image is merged, and the proven engine is not rewritten.
//
// WHAT ONE RUN DOES, in lifecycle terms:
//   1. Refuses to start unless the spend fits under the authoring cap.
//   2. generate-briefs claims eligible ado-linked items: each records the
//      `execution-started` transition to `executing` and gets a brief that
//      carries its item id, the only identifier that survives the platform's
//      filename round trip.
//   3. The PowerShell ensemble authors, reviews, and disposes each brief,
//      writing run records under the run-record root.
//   4. ingest-proposals reads the verdicts back and records the one legal
//      transition out of `executing`: `gate2-ready` on a pass, `blocked` on a
//      refusal. An item whose run died before a verdict stays `executing` and
//      the next authoring run's ingest picks its records up.
//   5. Each applied verdict is also recorded as observation evidence, so a
//      later job on a different machine can read what was produced without
//      needing this container's local disk.
//
// SPEND CEILING. The plan (T16/T19) requires the authoring job to carry its
// own Foundry spend ceiling. ORCHARD_MAX_AUTHORING_SPEND_USD is required, has
// no default, and is enforced BEFORE any model is called by shrinking the
// number of items claimed this run; the delivery platform's own
// MAX_SPEND_USD_PER_RUN preflight then enforces it again per request inside
// the run. Two independent brakes, matching Track 2's pattern.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { openStateStore } from "./lib/state-store.mjs";
import { estimatedItemCostUsd } from "./lib/gate-queue.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { generateBriefs } from "./generate-briefs.mjs";
import { ingest } from "./ingest-proposals.mjs";

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

/**
 * How many items this run may claim, bounded by money before anything runs.
 *
 * The cap is required with no default: an authoring job with no ceiling is an
 * unbounded grant, which is finding T16. The per-item estimate is the same one
 * the Gate 1 issue shows the owner, so the number approved and the number
 * enforced are the same number.
 */
export function resolveAuthoringBudget(env = process.env) {
    const raw = env.ORCHARD_MAX_AUTHORING_SPEND_USD;
    const cap = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(cap) || cap <= 0) {
        fail("ERR_ORCHARD_CONFIGURATION", "ORCHARD_MAX_AUTHORING_SPEND_USD is required and must be a positive number");
    }
    const requestedRaw = env.ORCHARD_MAX_AUTHORING_ITEMS ?? "3";
    const requested = Number(requestedRaw);
    if (!Number.isSafeInteger(requested) || requested < 1) {
        fail("ERR_ORCHARD_CONFIGURATION", "ORCHARD_MAX_AUTHORING_ITEMS must be a positive integer");
    }
    const perItemUsd = estimatedItemCostUsd(env);
    const affordable = perItemUsd === 0 ? requested : Math.floor(cap / perItemUsd);
    const limit = Math.min(requested, affordable);
    if (limit < 1) {
        fail("ERR_ORCHARD_AUTHORING_SPEND_CAP",
            `authoring spend cap USD ${cap.toFixed(2)} cannot cover one item at estimated USD ${perItemUsd.toFixed(2)}`);
    }
    return { limit, perItemUsd, capUsd: cap, estimatedUsd: limit * perItemUsd };
}

/**
 * The exact invocation of the proven engine. ORCHARD_DELIVERY_COMMAND (a JSON
 * array) exists so a test can substitute a deterministic stand-in; production
 * never sets it and gets the same pwsh invocation the engine's phase 6 uses.
 */
export function deliveryCommand(env = process.env) {
    if (env.ORCHARD_DELIVERY_COMMAND) {
        const parts = JSON.parse(env.ORCHARD_DELIVERY_COMMAND);
        if (!Array.isArray(parts) || parts.length === 0 || parts.some((part) => typeof part !== "string")) {
            fail("ERR_ORCHARD_CONFIGURATION", "ORCHARD_DELIVERY_COMMAND must be a non-empty JSON array of strings");
        }
        return parts;
    }
    const entrypoint = env.ORCHARD_DELIVERY_ENTRYPOINT ?? "/app/Invoke-Project42Delivery.ps1";
    return ["pwsh", "-NoProfile", "-File", entrypoint, "-Execute"];
}

/**
 * Record each applied verdict as observation evidence bound to the item.
 *
 * The run records live on this container's local disk and die with it; the
 * state database is what travels. A later gate2-prep job on another machine
 * needs to know which run produced which proposal with which digest, so that
 * link is persisted here as evidence rather than assumed recoverable.
 */
export function recordAuthoringEvidence({ store, applied, runRecordDir, now }) {
    for (const entry of applied) {
        const item = store.db.prepare(
            "SELECT origin_run_id, current_revision FROM workflow_item WHERE item_id = ?",
        ).get(entry.subjectId);
        if (!item) continue;
        const evidence = {
            kind: "authoring-result",
            item_id: entry.subjectId,
            item_revision: Number(item.current_revision),
            from_state: entry.from,
            to_state: entry.to,
            proposal_file: entry.file,
            run_record_dir: runRecordDir,
            recorded_at: now,
        };
        store.recordObservation({
            observation_id: generateUuidV7(),
            run_id: item.origin_run_id,
            item_id: entry.subjectId,
            item_revision: Number(item.current_revision),
            evidence_reference: `orchard/authoring-result/${entry.subjectId}:r${Number(item.current_revision)}`,
            evidence_digest: sha256Digest(evidence),
            observed_at: now,
            authoring_result: evidence,
        });
    }
}

export async function main(argv = process.argv.slice(2), { log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })), env = process.env, spawn = spawnSync } = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) fail("ERR_ORCHARD_CONFIGURATION", "run-authoring requires --state-db");
    const now = new Date().toISOString();
    const budget = resolveAuthoringBudget(env);
    log("info", "authoring.budget.accepted", budget);

    const workRoot = env.ORCHARD_AUTHORING_WORK_ROOT ?? join(tmpdir(), `orchard-authoring-${process.pid}`);
    const runRecordDir = env.RUN_RECORD_ROOT ?? join(workRoot, "run-records");
    const proposalRoot = env.PROPOSAL_ROOT ?? join(runRecordDir, "proposals");
    for (const directory of [workRoot, runRecordDir, proposalRoot]) mkdirSync(directory, { recursive: true });

    // Claim work. Each brief records ado-linked -> executing, so a crash after
    // this point leaves items visibly executing rather than silently unclaimed,
    // and the ingest below (this run or the next) is what moves them on.
    const briefs = await generateBriefs({
        dbPath: resolve(dbPath),
        mapPath: env.ORCHARD_MODEL_MAP_PATH ?? undefined,
        targetsPath: env.ORCHARD_SURFACE_TARGETS_PATH ?? undefined,
        inventoryPath: env.MODEL_INVENTORY_PATH ?? env.ORCHARD_INVENTORY_PATH,
        registryPath: env.ORCHARD_REGISTRY_PATH ?? null,
        limit: budget.limit,
        claimedBy: "orchard/run-authoring",
        apply: true,
        now,
    });
    log("info", "authoring.briefs.generated", {
        briefs: briefs.briefs.length, claimed: briefs.claimed.length,
        queued: briefs.queued, skipped: briefs.skipped.length, notReached: briefs.notReached,
    });
    for (const skipped of briefs.skipped) log("warn", "authoring.brief.skipped", skipped);

    if (briefs.briefs.length > 0) {
        const briefPath = join(workRoot, "briefs.json");
        writeFileSync(briefPath, `${JSON.stringify(briefs.briefs, null, 2)}\n`);
        const command = deliveryCommand(env);
        log("info", "authoring.delivery.starting", { briefs: briefs.briefs.length, executable: command[0] });
        const result = spawn(command[0], command.slice(1), {
            stdio: "inherit",
            env: {
                ...env,
                BRIEF_PATH: briefPath,
                RUN_RECORD_ROOT: runRecordDir,
                PROPOSAL_ROOT: proposalRoot,
                // "harness" is the only correct value here: this call is
                // always a one-shot run against a just-written brief file,
                // exactly what the engine's own docstring calls "harness"
                // mode ("runs once against a named brief"), never "engine"
                // mode (its scheduled watched-sources trigger). The engine's
                // own ValidateSet('harness','engine') rejects anything else,
                // including the "content-proposal" value this used to send.
                DELIVERY_MODE: "harness",
                MAX_SPEND_USD_PER_RUN: String(budget.capUsd),
            },
        });
        if (result.error) fail("ERR_ORCHARD_DELIVERY_FAILED", `the delivery engine could not start: ${result.error.message}`);
        if (result.status !== 0) {
            // The claimed items stay executing on purpose: the run records the
            // engine did manage to write are still ingested below, and items
            // with no verdict are picked up by the next run's ingest.
            log("error", "authoring.delivery.failed", { exitCode: result.status });
        } else {
            log("info", "authoring.delivery.completed");
        }
    } else {
        log("info", "authoring.nothing-claimed", { effect: "no approved ado-linked work is waiting; the ensemble is not invoked and nothing is spent" });
    }

    // Read the verdicts back. This also settles items claimed by an EARLIER
    // run that died between authoring and ingest, which is what "pick up an
    // item at executing" means operationally.
    const ingested = await ingest({ dbPath: resolve(dbPath), runRecordDir, apply: true, now, actor: "orchard/run-authoring" });
    log("info", "authoring.ingest.completed", {
        applied: ingested.applied.length,
        unmatched: ingested.unmatched.length,
        protected: ingested.protectedItems.length,
        unknownDisposition: ingested.unknownDisposition.length,
    });
    for (const entry of ingested.applied) log("info", "authoring.item.moved", entry);
    for (const entry of ingested.unmatched) log("warn", "authoring.proposal.unmatched", entry);

    if (ingested.applied.length > 0) {
        const store = openStateStore(resolve(dbPath));
        try {
            recordAuthoringEvidence({ store, applied: ingested.applied, runRecordDir, now });
        } finally {
            store.close();
        }
    }
    return { briefs: briefs.briefs.length, applied: ingested.applied.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
