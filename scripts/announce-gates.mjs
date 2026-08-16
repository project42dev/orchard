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
import { gateMarker, openOrUpdateGateIssue, resolveUserLogin } from "./lib/github-issues.mjs";
import { heldAtGate, heldSetDigest } from "./lib/gate-queue.mjs";
import { generateGateManifests, renderGateIssueBody } from "./lib/gates.mjs";
import { sha256Digest } from "./lib/identity.mjs";
import { mintInstallationToken } from "./lib/github-app-auth.mjs";

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
 * The run id the manifest is built against.
 *
 * It must be a UUIDv7, because the gate manifest contract says so and the
 * capture path binds a decision to it. The runtime's own execution name is
 * `caj-orch-t1-man-prod-eus-01-tpjwgnh`, which is not a UUID at all, and
 * passing it produced a manifest that failed validation and an announcement
 * that logged a contract error while thirteen items sat held and unmentioned.
 *
 * The right value is the run that most recently touched this track, which is
 * the run whose work is being announced.
 */
export function manifestRunId(db, track, fallback) {
    const row = db.prepare("SELECT run_id FROM workflow_run WHERE track = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(track);
    return row?.run_id ?? fallback;
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
export async function announceGates({ db, track, runId, repo, token, log, fetchImpl = fetch, assignees = [] }) {
    const results = [];
    // The execution name the runtime passes is not a UUID, and the manifest
    // contract requires one. Resolve it to the run that produced the work.
    const manifestRun = manifestRunId(db, track, runId);
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
                runId: manifestRun,
                track,
                items: items.map(({ track: _track, ...entry }) => entry),
            });
            for (const manifest of manifests) {
                const marker = gateMarker({ track, gate, runId: manifestRun, batchDigest: heldSetDigest(gate, manifest.items) });
                const issue = await openOrUpdateGateIssue({
                    repo,
                    marker,
                    title: `${GATES[gate].title(track, items.length)} batch ${manifest.batch.ordinal}/${manifest.batch.count}`,
                    body: renderGateIssue({ gate, track, items: manifest.items, marker, runId: manifestRun, manifest }),
                    labels: ["orchard", `orchard-${gate}`],
                    assignees,
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
/**
 * The GitHub token both halves of the gate loop need, read once per run.
 *
 * Announcing and applying use the same credential, and reading the vault twice
 * per run is two chances to fail for one secret. Returns null rather than
 * throwing, with the reason logged, because neither half may fail a run.
 *
 * T5: a GitHub App installation token is preferred when the three App
 * secrets (app id, installation id, private key) are configured, because it
 * draws from the installation's own rate-limit bucket rather than sharing a
 * personal token holder's bucket with everything else they do. The old
 * personal-access-token path is the fallback for as long as
 * ORCHARD_GATE_TOKEN_SECRET is still configured, so a deployment mid
 * migration keeps working either way.
 */
export async function readGateToken({
    log, env = process.env, prefix = "gate",
    vaultUrlVar = "ORCHARD_GATE_VAULT_URL", repoVar = "ORCHARD_GITHUB_REPO",
    appIdVar = "ORCHARD_GATE_APP_ID_SECRET", installationIdVar = "ORCHARD_GATE_INSTALLATION_ID_SECRET",
    appKeyVar = "ORCHARD_GATE_APP_KEY_SECRET", tokenVar = "ORCHARD_GATE_TOKEN_SECRET",
}) {
    const vaultUrl = env[vaultUrlVar];
    if (!env[repoVar] || !vaultUrl) {
        log("warn", `${prefix}.token.unconfigured`, { effect: "gates hold as designed; nothing is announced and no decision is read" });
        return null;
    }

    const appIdSecret = env[appIdVar];
    const installationIdSecret = env[installationIdVar];
    const appKeySecret = env[appKeyVar];
    if (appIdSecret && installationIdSecret && appKeySecret) {
        try {
            const [appId, installationId, privateKeyPem] = await Promise.all([
                readVaultSecret({ vaultUrl, secretName: appIdSecret, clientId: env.AZURE_CLIENT_ID }),
                readVaultSecret({ vaultUrl, secretName: installationIdSecret, clientId: env.AZURE_CLIENT_ID }),
                readVaultSecret({ vaultUrl, secretName: appKeySecret, clientId: env.AZURE_CLIENT_ID }),
            ]);
            return await mintInstallationToken({ appId, installationId, privateKeyPem });
        } catch (error) {
            log("warn", error.status === 404 ? `${prefix}.token.app-absent` : `${prefix}.token.app-unavailable`, {
                status: error.status ?? null,
                effect: "gates hold as designed; nothing is announced and no decision is read",
            });
            return null;
        }
    }

    const secretName = env[tokenVar];
    if (!secretName) {
        log("warn", `${prefix}.token.unconfigured`, { effect: "gates hold as designed; nothing is announced and no decision is read" });
        return null;
    }
    try {
        return await readVaultSecret({ vaultUrl, secretName, clientId: env.AZURE_CLIENT_ID });
    } catch (error) {
        // A 404 means the vault exists and nobody has put a token in it yet,
        // which is the expected state until an operator does. Anything else is
        // a real fault worth separating.
        log("warn", error.status === 404 ? `${prefix}.token.absent` : `${prefix}.token.unavailable`, {
            secretName,
            status: error.status ?? null,
            effect: "gates hold as designed; nothing is announced and no decision is read",
        });
        return null;
    }
}

/**
 * Who a gate issue is assigned to, resolved to current logins.
 *
 * THE ALERT IS GITHUB'S OWN NOTIFICATION. The owner's decision on how a gate
 * should alert (plan T15, question Q3) is that GitHub already emails a user
 * when they are assigned an issue, and that mechanism is the alert. So the
 * whole notification design is: assign the owner at issue creation, and
 * GitHub does the rest. No custom alerting exists behind this.
 *
 * Configuration is ORCHARD_GATE_NOTIFY_GITHUB_USER_ID, comma separated
 * numeric GitHub user ids, and it falls back to ORCHARD_GATE_ACTORS: the
 * humans authorized to decide a gate are exactly the humans who need to hear
 * it is waiting, so the deployed estate needs no new setting for the email to
 * fire. Ids, never logins, because a login can be reassigned; each id is
 * resolved to its current login here, at the moment of use.
 *
 * Never throws and never blocks the announcement. A missing setting, a
 * non-numeric value, or an id GitHub cannot resolve each log a warning and
 * are skipped, because an unassigned issue that exists beats an assigned
 * issue that was never created.
 */
export async function gateAssignees({ token, log, env = process.env, fetchImpl = fetch }) {
    const raw = String(env.ORCHARD_GATE_NOTIFY_GITHUB_USER_ID || env.ORCHARD_GATE_ACTORS || "");
    const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) {
        log("warn", "gate.assignee.unconfigured", { effect: "gate issues are created unassigned, so GitHub sends no assignment email" });
        return [];
    }
    const logins = [];
    for (const id of ids) {
        if (!/^[1-9][0-9]*$/.test(id)) {
            log("warn", "gate.assignee.invalid", {
                id,
                effect: "skipped; assignees must be immutable numeric GitHub IDs, not logins, because a login can be reassigned",
            });
            continue;
        }
        try {
            logins.push(await resolveUserLogin({ userId: id, token, fetchImpl }));
        } catch (error) {
            log("warn", "gate.assignee.unresolved", {
                id,
                status: error.status ?? null,
                effect: "the issue is still created, just not assigned to this id",
            });
        }
    }
    return logins;
}

export async function announceGatesForRun({ stateDbPath, track, runId, log, env = process.env, token: suppliedToken }) {
    const repo = env.ORCHARD_GITHUB_REPO;
    if (!repo) {
        log("warn", "gate.announce.unconfigured", { effect: "gates hold as designed but announce nothing" });
        return [];
    }
    const token = suppliedToken ?? await readGateToken({ log, env, prefix: "gate.announce" });
    if (!token) {
        log("warn", "gate.announce.no-token", { effect: "gates hold as designed but announce nothing" });
        return [];
    }
    const assignees = await gateAssignees({ token, log, env });
    let db;
    try {
        db = new DatabaseSync(stateDbPath, { readOnly: true });
        return await announceGates({ db, track, runId, repo, token, log, assignees });
    } catch (error) {
        log("warn", "gate.announce.failed", { status: error.status ?? null, effect: "work stays held; nobody was told" });
        return [];
    } finally {
        db?.close();
    }
}
