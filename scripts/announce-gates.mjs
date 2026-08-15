#!/usr/bin/env node
// Open the GitHub issue that a gate is waiting behind.
//
// THE REQUIREMENT, in the owner's words: "I don't run anything. It creates a
// GitHub issue and that notifies me." And: "Each gate. There should be 4. 2 for
// discovery and 2 for currency."
//
// Before this, both gates held work correctly and told nobody. Finding out
// meant running gate1-review.mjs --notify by hand, which is the opposite of a
// notification. A gate that stops a run and stays silent is not a gate, it is
// a stall.
//
// The token comes from Key Vault, read by the job's own managed identity at
// start. It is deliberately NOT a Container Apps secret reference: that puts
// the credential in the job definition, where `az rest` on the job shows its
// name and the platform holds the value. This way the only thing in the
// definition is a vault URL and a secret name, and the token exists in memory
// for the length of one run.
//
// Nothing here can fail a run. A gate that has already been announced, a
// missing token, an unreachable GitHub: all of them log and return. The work
// stays held either way, because holding is the state machine's job and
// announcing is only how a human hears about it.

import { DatabaseSync } from "node:sqlite";
import { ManagedIdentityCredential } from "@azure/identity";
import { gateMarker, openOrUpdateGateIssue } from "./lib/github-issues.mjs";

const GATES = Object.freeze({
    "gate-1": {
        state: "gate1-pending",
        title: (track, n) => `Orchard Gate 1: ${n} item${n === 1 ? "" : "s"} awaiting approval (${track})`,
        lead: "These items are held **before any model is called**. Nothing has been spent on them yet, and nothing will be until they are approved.",
        grammar: ["/orchard gate1 approve item=<work_item_id>", "/orchard gate1 deny    item=<work_item_id> reason=\"<why>\""],
    },
    "gate-2": {
        state: "gate2-pending",
        title: (track, n) => `Orchard Gate 2: ${n} item${n === 1 ? "" : "s"} awaiting publication (${track})`,
        lead: "These items have been written and are held **before publication**. Approval is bound to the exact artifact digest, so an approval stops applying if the artifact changes.",
        grammar: ["/orchard gate2 approve item=<work_item_id> digest=<sha256>", "/orchard gate2 deny    item=<work_item_id> reason=\"<why>\""],
    },
});

export function pendingForGate(db, state) {
    return db.prepare(
        `SELECT w.id, w.kind, w.subject_id, w.surface, w.title, w.state
           FROM work_item w
          WHERE w.state = ?
          ORDER BY w.id`,
    ).all(state);
}

export function renderGateIssue({ gate, track, items, marker, runId }) {
    const spec = GATES[gate];
    const lines = [
        marker,
        "",
        `## ${items.length} item${items.length === 1 ? "" : "s"} waiting`,
        "",
        spec.lead,
        "",
        "| Work item | Surface | Title |",
        "| --- | --- | --- |",
        ...items.map((item) => `| \`${item.id}\` | ${item.surface ?? "-"} | ${(item.title ?? "").replace(/\|/g, "\\|")} |`),
        "",
        "### How to decide",
        "",
        "Comment on this issue, one command per line:",
        "",
        "```",
        ...spec.grammar,
        "```",
        "",
        `Run \`${runId}\`, track \`${track}\`. Nothing proceeds until a decision is recorded, and no decision is inferred from silence.`,
    ];
    return lines.join("\n");
}

/**
 * Announce every gate that currently holds work.
 *
 * Returns one record per gate so a caller can log what happened. A gate with
 * nothing waiting is reported as "empty" rather than skipped silently: on the
 * first run of a new estate that is the expected answer, and it needs to be
 * distinguishable from "we never looked".
 */
export async function announceGates({ db, track, runId, repo, token, log, fetchImpl = fetch }) {
    const results = [];
    for (const [gate, spec] of Object.entries(GATES)) {
        const items = pendingForGate(db, spec.state);
        if (items.length === 0) {
            log("info", "gate.announce.empty", { gate, track, state: spec.state });
            results.push({ gate, action: "empty", count: 0 });
            continue;
        }
        const marker = gateMarker({ track, gate, runId });
        const issue = await openOrUpdateGateIssue({
            repo,
            marker,
            title: spec.title(track, items.length),
            body: renderGateIssue({ gate, track, items, marker, runId }),
            labels: ["orchard", `orchard-${gate}`],
            token,
            fetchImpl,
        });
        log("info", "gate.announced", { gate, track, count: items.length, action: issue.action, issue: issue.number });
        results.push({ gate, ...issue, count: items.length });
    }
    return results;
}

async function readVaultSecret({ vaultUrl, secretName, clientId, fetchImpl = fetch }) {
    const credential = new ManagedIdentityCredential(clientId);
    const { token } = await credential.getToken("https://vault.azure.net/.default");
    const url = `${vaultUrl.replace(/\/$/, "")}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
        const error = new Error(`vault returned ${response.status} for secret ${secretName}`);
        error.status = response.status;
        throw error;
    }
    return (await response.json()).value;
}

/**
 * The entry point the runtime calls after a controller finishes.
 *
 * Never throws. A failure to announce must not fail a run that otherwise
 * succeeded, and must not be silent either, so every path logs.
 */
export async function announceGatesForRun({ stateDbPath, track, runId, log, env = process.env }) {
    const repo = env.ORCHARD_GITHUB_REPO;
    const vaultUrl = env.ORCHARD_GATE_VAULT_URL;
    const secretName = env.ORCHARD_GATE_TOKEN_SECRET;
    if (!repo || !vaultUrl || !secretName) {
        log("warn", "gate.announce.unconfigured", { effect: "gates hold as designed but announce nothing" });
        return [];
    }
    let token;
    try {
        token = await readVaultSecret({ vaultUrl, secretName, clientId: env.AZURE_CLIENT_ID });
    } catch (error) {
        // A 404 means the vault exists and nobody has put a token in it yet,
        // which is the expected state until an operator does. Anything else is
        // a real fault worth separating.
        log("warn", error.status === 404 ? "gate.announce.no-token" : "gate.announce.token-unavailable", {
            secretName,
            status: error.status ?? null,
            effect: "gates hold as designed but announce nothing",
        });
        return [];
    }
    let db;
    try {
        db = new DatabaseSync(stateDbPath, { readOnly: true });
        return await announceGates({ db, track, runId, repo, token, log });
    } catch (error) {
        log("warn", "gate.announce.failed", { status: error.status ?? null, effect: "work stays held; nobody was told" });
        return [];
    } finally {
        db?.close();
    }
}
