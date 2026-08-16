#!/usr/bin/env node
// The live verification and closure role: prove published content actually
// serves, then walk the item to closure with evidence. Remediation plan T19.
//
// Three things, in order, each independently honest:
//
//   1. LIVE VERIFICATION. Every recorded publication transaction is fetched at
//      its expected public URL and checked for a marker drawn from the item
//      itself (verify-published-live.mjs). A push is not a publication; a 200
//      is not proof. Every result is recorded as observation evidence, and a
//      published item that is NOT serving fails this run loudly.
//
//   2. CLOSURE PREPARATION. An item at `published` whose closure evidence
//      packet is supplied moves to `ado-closure-ready`: the packet is recorded
//      (the store cross-checks it against every persisted fact it names), and
//      the ADO work item is reconciled to Resolved with the completion notes.
//      The state machine refuses the transition without both.
//
//   3. CLOSURE ACCEPTANCE. An item at `ado-closure-ready` whose owner
//      acceptance evidence is supplied moves to `closed`: the acceptance is
//      verified against the protected closure trust anchor, the ADO work item
//      is reconciled to Closed, and the transition is recorded. Silence never
//      closes anything.
//
// Evidence arrives as files under the evidence root
// (closure-evidence/<item_id>.json, closure-acceptance/<item_id>.json) and the
// ADO adapter is injected. Where either is absent the item HOLDS with the
// reason logged; this role fabricates nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStateStore } from "./lib/state-store.mjs";
import { verifyAll, PUBLISHED_ITEMS_SQL, ITEM_TITLE_SQL } from "./verify-published-live.mjs";
import { GATE_MANIFEST_REFERENCE_PREFIX } from "./lib/gate-queue.mjs";
import { prepareAdoResolved, acceptAdoClosure } from "./lib/ado-closure.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

function readEvidence(evidenceRoot, kind, itemId) {
    const path = join(evidenceRoot, kind, `${itemId}.json`);
    if (!existsSync(path)) return { path, document: null };
    return { path, document: JSON.parse(readFileSync(path, "utf8")) };
}

async function advance(store, row, from, to, cause, now) {
    await store.recordTransition({
        schema_version: "1.0.0",
        transition_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: Number(row.current_revision),
        from_state: from,
        to_state: to,
        cause,
        actor: "orchard/run-verification",
        occurred_at: now,
        correlation_id: generateUuidV7(),
    });
}

export async function verifyLive({ store, surfaces, fetchImpl, now, log }) {
    const titleFor = store.db.prepare(ITEM_TITLE_SQL);
    const rows = store.db.prepare(PUBLISHED_ITEMS_SQL).all(null, null).map((row) => {
        const observed = titleFor.get(row.id, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${row.id}`);
        const manifest = observed ? JSON.parse(observed.record_json).manifest_item ?? null : null;
        return { ...row, title: manifest?.title ?? null };
    });
    if (rows.length === 0) {
        log("info", "verification.live.nothing-published", { effect: "no publication transaction exists to verify" });
        return { checked: 0, serving: 0, failed: [] };
    }
    const outcome = await verifyAll(rows, surfaces, fetchImpl ? { fetchImpl } : {});
    for (const result of outcome.results) {
        const item = store.db.prepare("SELECT origin_run_id, current_revision FROM workflow_item WHERE item_id = ?").get(result.id);
        if (!item) continue;
        const evidence = { kind: "live-verification", item_id: result.id, serving: result.serving, url: result.url ?? null, status: result.status ?? null, reasons: result.reasons, verified_at: now };
        store.recordObservation({
            observation_id: generateUuidV7(),
            run_id: item.origin_run_id,
            item_id: result.id,
            item_revision: Number(item.current_revision),
            evidence_reference: `orchard/live-verification/${result.id}:${now}`,
            evidence_digest: sha256Digest(evidence),
            observed_at: now,
            live_verification: evidence,
        });
        log(result.serving ? "info" : "error", "verification.live.result", { item: result.id, serving: result.serving, url: result.url ?? null, reasons: result.reasons });
    }
    return outcome;
}

export async function main(argv = process.argv.slice(2), {
    log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })),
    env = process.env,
    fetchImpl = undefined,
    adoAdapter = null,
    getAdoWorkItem = null,
} = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) throw Object.assign(new Error("run-verification requires --state-db"), { code: "ERR_ORCHARD_CONFIGURATION" });
    const evidenceRoot = env.ORCHARD_EVIDENCE_ROOT ?? env.RUN_RECORD_ROOT ?? process.cwd();
    const surfacesPath = env.ORCHARD_SURFACES_PATH ?? resolve(HERE, "..", "config", "surface-targets.json");
    const now = new Date().toISOString();
    const store = openStateStore(resolve(dbPath));
    const summary = { checked: 0, serving: 0, notServing: 0, resolved: 0, closed: 0, held: 0 };
    try {
        const surfaces = existsSync(surfacesPath) ? JSON.parse(readFileSync(surfacesPath, "utf8")).surfaces ?? {} : {};
        const live = await verifyLive({ store, surfaces, fetchImpl, now, log });
        summary.checked = live.checked;
        summary.serving = live.serving;
        summary.notServing = live.failed.length;

        // Closure work proceeds even when some OTHER item fails its live
        // check; the failure still fails the run at the end. An item only
        // advances toward closure when its own page is proven serving.
        const servingIds = new Set(live.results?.filter((result) => result.serving).map((result) => result.id) ?? []);

        const publishedRows = store.db.prepare(
            "SELECT item_id, track, current_revision, origin_run_id FROM workflow_item WHERE current_state = 'published' ORDER BY updated_at, item_id",
        ).all();
        for (const row of publishedRows) {
            if (!servingIds.has(row.item_id)) {
                summary.held += 1;
                log("warn", "verification.closure.not-serving", { item: row.item_id, effect: "closure needs the page proven live first; the item stays published" });
                continue;
            }
            const { path, document: packet } = readEvidence(evidenceRoot, "closure-evidence", row.item_id);
            if (!packet) {
                summary.held += 1;
                log("info", "verification.closure.no-packet", { item: row.item_id, path, effect: "the item stays published until its closure evidence packet is supplied" });
                continue;
            }
            if (!adoAdapter || !getAdoWorkItem) {
                summary.held += 1;
                log("warn", "verification.closure.no-ado-adapter", { item: row.item_id, effect: "no reconciling ADO adapter is available; the item stays published" });
                continue;
            }
            try {
                const workItem = await getAdoWorkItem(packet.ado.external_key);
                await prepareAdoResolved({ packet, adoWorkItem: workItem, adoAdapter, store, apply: true });
                await advance(store, row, "published", "ado-closure-ready", "closure-evidence-ready", now);
                summary.resolved += 1;
                log("info", "verification.closure.resolved", { item: row.item_id, adoId: packet.ado.work_item_id, state: "ado-closure-ready" });
            } catch (error) {
                summary.held += 1;
                log("warn", "verification.closure.refused", { item: row.item_id, code: error.code ?? null, reason: error.message, effect: "the item stays published" });
            }
        }

        const readyRows = store.db.prepare(
            "SELECT item_id, track, current_revision, origin_run_id FROM workflow_item WHERE current_state = 'ado-closure-ready' ORDER BY updated_at, item_id",
        ).all();
        for (const row of readyRows) {
            const packetRow = store.db.prepare(
                "SELECT record_json FROM closure_packet WHERE item_id = ? AND item_revision = ?",
            ).get(row.item_id, Number(row.current_revision));
            if (!packetRow) {
                summary.held += 1;
                log("warn", "verification.acceptance.no-packet", { item: row.item_id, effect: "no persisted closure packet; the item holds" });
                continue;
            }
            const packet = JSON.parse(packetRow.record_json);
            const { path, document: acceptanceAuthority } = readEvidence(evidenceRoot, "closure-acceptance", row.item_id);
            if (!acceptanceAuthority) {
                summary.held += 1;
                log("info", "verification.acceptance.waiting", { item: row.item_id, path, effect: "closure waits for the owner's recorded acceptance; silence closes nothing" });
                continue;
            }
            if (!adoAdapter || !getAdoWorkItem) {
                summary.held += 1;
                log("warn", "verification.acceptance.no-ado-adapter", { item: row.item_id, effect: "no reconciling ADO adapter is available; the item holds" });
                continue;
            }
            try {
                const workItem = await getAdoWorkItem(packet.ado.external_key);
                await acceptAdoClosure({ packet, acceptanceAuthority, adoWorkItem: workItem, adoAdapter, store, apply: true });
                await advance(store, row, "ado-closure-ready", "closed", "closure-accepted", now);
                summary.closed += 1;
                log("info", "verification.acceptance.closed", { item: row.item_id, adoId: packet.ado.work_item_id, state: "closed" });
            } catch (error) {
                summary.held += 1;
                log("warn", "verification.acceptance.refused", { item: row.item_id, code: error.code ?? null, reason: error.message, effect: "the item holds at ado-closure-ready" });
            }
        }

        log("info", "verification.finished", summary);
        if (summary.notServing > 0) {
            throw Object.assign(
                new Error(`${summary.notServing} published item(s) are not serving`),
                { code: "ERR_ORCHARD_VERIFICATION_FAILED" },
            );
        }
        return summary;
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
