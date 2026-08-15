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
import { heldAtGate, heldSetDigest } from "./lib/gate-queue.mjs";
import { generateGateManifests, renderGateIssueBody } from "./lib/gates.mjs";
import { sha256Digest } from "./lib/identity.mjs";

const GATES = Object.freeze({
    "gate-1": {
        state: "gate1-pending",
        title: (track, n) => `Orchard Gate 1: ${n} item${n === 1 ? "" : "s"} awaiting approval (${track})`,
        lead: "These items are held **before any model is called**. Nothing has been spent on them yet, and nothing will be until they are approved.",
    },
    "gate-2": {
        state: "gate2-pending",
        title: (track, n) => `Orchard Gate 2: ${n} item${n === 1 ? "" : "s"} awaiting publication (${track})`,
        lead: "These items have been written and are held **before publication**. Approval is bound to the exact artifact digest, so an approval stops applying if the artifact changes.",
    },
});

export function pendingForGate(db, gate, track = null) {
    return heldAtGate(db, gate, track);
}

/**
 * The issue body: the lead, then the normative manifest rendering.
 *
 * The decision grammar is NOT written here. renderGateIssueBody emits the exact
 * command for each item, bound to its id, revision and digest, from
 * lib/gates.mjs, which is the one place the grammar is defined. The earlier
 * version of this file invented its own shorter grammar, and a command that a
 * reader can copy but the engine will not parse is worse than no command.
 */
export function renderGateIssue({ gate, track, items, marker, runId, manifest }) {
    const head = [
        marker,
        "",
        `## ${items.length} item${items.length === 1 ? "" : "s"} waiting`,
        "",
        GATES[gate].lead,
        "",
        renderGateIssueBody(manifest),
        "",
        `Run \`${runId}\`, track \`${track}\`. Nothing proceeds until a decision is recorded, and no decision is inferred from silence.`,
    ].join("\n");

    // The exact manifest, machine readable, folded away.
    //
    // A decision is captured by comparing the comment against the manifest the
    // issue actually offered. Without the manifest ON the issue, that check can
    // only compare the caller's copy against itself, and an issue whose
    // rendered text has drifted from the manifest behind it would still accept
    // decisions. The rendered tables above are for the human; this is what the
    // capture reads.
    const embedded = [
        "",
        "<details>",
        `<summary>Manifest (machine readable, digest <code>${sha256Digest(manifest)}</code>)</summary>`,
        "",
        "```json",
        JSON.stringify(manifest),
        "```",
        "",
        "</details>",
    ].join("\n");

    // GitHub refuses a body over 65536 characters. A gate that cannot post
    // because its manifest is long must still post: the human rendering is what
    // makes the decision possible, and the omission is stated rather than
    // silently dropped.
    if (head.length + embedded.length > 60_000) {
        return `${head}\n\n> The machine-readable manifest is omitted from this issue: it would exceed GitHub's body limit. Batch digest \`${manifest.batch_digest}\` still binds every decision below.`;
    }
    return head + embedded;
}

/**
 * Announce every gate that currently holds work.
 *
 * Returns one record per gate so a caller can log what happened. A gate with
 * nothing waiting is reported as "empty" rather than skipped silently: on the
 * first run of a new estate that is the expected answer, and it needs to be
 * distinguishable from "we never looked".
 *
 * A gate holding more than twenty items produces more than one manifest, and
 * each batch gets its own issue. The batch size is normative, not a display
 * choice: a decision is bound to a batch digest, and one issue per batch is
 * what makes that binding checkable.
 */
export async function announceGates({ db, track, runId, repo, token, log, fetchImpl = fetch }) {
    const results = [];
    for (const gate of Object.keys(GATES)) {
        // Each gate is announced independently. One gate that cannot render is
        // not allowed to silence the other, and it must say WHICH gate failed
        // and why: a single catch around both would have reported "announcing
        // failed" for a fault in a gate that was holding nothing.
        try {
            const items = pendingForGate(db, gate, track);
            if (items.length === 0) {
                log("info", "gate.announce.empty", { gate, track, state: GATES[gate].state });
                results.push({ gate, action: "empty", count: 0 });
                continue;
            }
            const manifests = await generateGateManifests({
                gate,
                runId,
                track,
                items: items.map(({ track: _track, ...entry }) => entry),
            });
            for (const manifest of manifests) {
                const marker = gateMarker({ track, gate, runId, batchDigest: heldSetDigest(gate, manifest.items) });
                const issue = await openOrUpdateGateIssue({
                    repo,
                    marker,
                    title: `${GATES[gate].title(track, items.length)} batch ${manifest.batch.ordinal}/${manifest.batch.count}`,
                    body: renderGateIssue({ gate, track, items: manifest.items, marker, runId, manifest }),
                    labels: ["orchard", `orchard-${gate}`],
                    token,
                    fetchImpl,
                });
                log("info", "gate.announced", {
                    gate,
                    track,
                    count: manifest.items.length,
                    batch: `${manifest.batch.ordinal}/${manifest.batch.count}`,
                    batchDigest: manifest.batch_digest,
                    action: issue.action,
                    issue: issue.number,
                });
                results.push({ gate, ...issue, count: manifest.items.length, batch: manifest.batch.ordinal });
            }
        } catch (error) {
            log("warn", "gate.announce.gate-failed", {
                gate,
                track,
                status: error.status ?? null,
                reason: error.message,
                effect: "this gate still holds its work; nobody was told about it",
            });
            results.push({ gate, action: "failed", count: 0, reason: error.message });
        }
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
