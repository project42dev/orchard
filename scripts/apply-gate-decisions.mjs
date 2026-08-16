// Read the owner's answer back out of the gate issue, and apply it.
//
// THE HALF THAT WAS MISSING. Orchard could hold work and announce it, and had
// no way to hear a reply. The issue was a one-way notification: a gate that
// stops a run and cannot be answered is a stall, not a gate.
//
// THIS RUNS AT THE START OF A TRACK, before any work, because the answer to
// the last run is what decides whether this run may spend anything. It runs
// inside the container for the same reason the announcement does: the state
// database is behind a private endpoint and a GitHub runner cannot reach it,
// so the engine reads its own decisions and stays the single writer.
//
// NOTHING HERE CAN FAIL A RUN. No trust anchor, no token, GitHub unreachable,
// a malformed comment: each logs a distinct event and returns. Work stays held
// either way, because holding is the state machine's job. The one thing that
// must never happen is silence: a decision that did not apply has to be
// visible, so every refusal names the comment and the reason.
//
// AN APPROVAL RECORDS WITHOUT A TRACKER ITEM, because the tracker item is
// created after approval, never before. The approval moves the item to
// gate1-approved; ado-sync.mjs then creates the Azure DevOps work item,
// records the external link, and advances the item to ado-linked, which is
// the state that proves the tracker item exists.

import { captureGateDecision } from "./capture-gate-decision.mjs";
import { manifestFromIssueBody } from "./adapters/github-gate/adapter.mjs";
import { listIssueComments, listOpenGateIssues, closeIssue } from "./lib/github-issues.mjs";
import { pathToFileURL } from "node:url";
import { loadProtectedAdapterModule, protectedAdapterDigest } from "./lib/protected-adapter.mjs";
import { sha256Digest } from "./lib/identity.mjs";
import { LIFECYCLE_STATES } from "./lib/state-machine.mjs";

const GATES = Object.freeze(["gate-1", "gate-2"]);
const PENDING = Object.freeze({ "gate-1": "gate1-pending", "gate-2": "gate2-pending" });

// The state each gate's approval path must reach before its issue is done:
// proof that the NEXT process took the item, not just that it was approved.
// Gate 1 hands to ado-sync.mjs, which creates the tracker item (ado-linked).
// Gate 2 hands to the publication pipeline, which starts at
// publication-preparing. Anything at or past that point on the direct
// lifecycle chain, all the way to closed, still counts: once the next
// process has the item, this issue's job is done regardless of what happens
// to the item afterward.
const HANDOFF_THRESHOLD = Object.freeze({ "gate-1": "ado-linked", "gate-2": "publication-preparing" });
// denied and superseded are reached from *-pending directly and need no
// further hand-off: the decision itself was the last step for this issue.
// deferred, changes-requested, blocked, and stale-approval are deliberately
// excluded, because each of those means the conversation on this issue is
// not finished, not that it is.
const TERMINAL_WITHOUT_HANDOFF = new Set(["denied", "superseded"]);
const HANDOFF_INDEX = Object.freeze({
    "gate-1": LIFECYCLE_STATES.indexOf(HANDOFF_THRESHOLD["gate-1"]),
    "gate-2": LIFECYCLE_STATES.indexOf(HANDOFF_THRESHOLD["gate-2"]),
});
const CLOSED_INDEX = LIFECYCLE_STATES.indexOf("closed");

/** Has this item left the gate's own issue behind, one way or another? */
export function itemHandedOff(gate, state) {
    if (TERMINAL_WITHOUT_HANDOFF.has(state)) return true;
    const stateIndex = LIFECYCLE_STATES.indexOf(state);
    return stateIndex >= HANDOFF_INDEX[gate] && stateIndex <= CLOSED_INDEX;
}

/** Who may decide. An empty allowlist means nobody, never everybody. */
export function authorisedActorIds(policy) {
    const ids = policy?.authorized_actor_ids;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
}

/**
 * The current state of the item a command names, read from the database.
 *
 * The adapter cannot see the state database, so this is the one field the
 * caller supplies. recordVerifiedDecision re-checks it against the persisted
 * item before writing, so a wrong value here fails the write rather than
 * slipping through.
 */
export function currentStateOf(db, itemId) {
    return db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId)?.current_state ?? null;
}

const ITEM_IN_COMMAND = /\/orchard gate[12] (?:approve|deny|defer|request-changes) item=([0-9a-f-]{36})\b/;

/**
 * Every batch manifest belonging to one full manifest, gathered across issues.
 *
 * A gate holding more than twenty items produces several issues, and
 * verifyGateManifestDigests needs every item in the full manifest to check a
 * single batch. Gathering them by full_manifest_digest is what lets a decision
 * on batch two be verified without trusting batch two's own account of the
 * whole.
 */
export function fullManifestItemsFor(manifest, allManifests) {
    const siblings = allManifests.filter((entry) => entry.full_manifest_digest === manifest.full_manifest_digest);
    const items = siblings.flatMap((entry) => entry.items);
    const unique = new Map(items.map((item) => [item.item_id, item]));
    if (unique.size !== manifest.batch.total_item_count) return null;
    return [...unique.values()].sort((left, right) => left.item_id.localeCompare(right.item_id));
}

/**
 * Apply every authorised decision waiting on this track's gate issues.
 *
 * Returns a summary rather than throwing, so a caller can log it and carry on.
 */
export async function applyGateDecisions({ store, track, repo, token, log = () => { }, fetchImpl = fetch, adapter, policy }) {
    const summary = { applied: 0, blocked: 0, refused: 0, unchanged: 0, errors: 0, closed: 0 };
    const allowed = authorisedActorIds(policy);
    if (allowed.size === 0) {
        log("warn", "gate.apply.no-authorised-actors", { effect: "no comment can decide anything; work stays held" });
        return summary;
    }

    for (const gate of GATES) {
        let issues;
        try {
            issues = await listOpenGateIssues({ repo, gate, track, token, fetchImpl });
        } catch (error) {
            summary.errors += 1;
            log("warn", "gate.apply.issues-unreadable", { gate, track, status: error.status ?? null, reason: error.message });
            continue;
        }
        if (issues.length === 0) {
            log("info", "gate.apply.no-issues", { gate, track });
            continue;
        }

        const manifests = [];
        for (const issue of issues) {
            try {
                manifests.push({ issue, manifest: manifestFromIssueBody(issue.body) });
            } catch (error) {
                summary.errors += 1;
                log("warn", "gate.apply.issue-unbound", { gate, issue: issue.number, code: error.code ?? null, reason: error.message });
            }
        }
        const allManifests = manifests.map((entry) => entry.manifest);

        for (const { issue, manifest } of manifests) {
            let comments;
            try {
                comments = await listIssueComments({ repo, issueNumber: issue.number, token, fetchImpl });
            } catch (error) {
                summary.errors += 1;
                log("warn", "gate.apply.comments-unreadable", { gate, issue: issue.number, status: error.status ?? null });
                continue;
            }

            // One item decision, start to finish: verify through the pinned
            // adapter, capture, and record. Shared by the structured
            // single-item path and the bare-approve per-item expansion below,
            // so a bare approve goes through exactly the same trust chain as
            // a typed command, once per item, never a shortcut around it.
            const applyOneItem = async (comment, itemId, currentState, expectedItemId) => {
                const fullManifestItems = fullManifestItemsFor(manifest, allManifests);
                if (!fullManifestItems) {
                    summary.blocked += 1;
                    log("warn", "gate.apply.manifest-incomplete", {
                        gate, issue: issue.number,
                        expected: manifest.batch.total_item_count,
                        effect: "a sibling batch issue is missing, so this batch cannot be verified",
                    });
                    return;
                }
                try {
                    // The token is handed to the adapter rather than left in
                    // process.env: the adapter is pinned code loaded from a
                    // snapshot, and the fewer ambient things it depends on the
                    // smaller the surface its digest has to cover.
                    const verifiedEvent = await adapter.fetchVerifiedEvent(
                        { repository: repo, issue_number: issue.number, comment_id: comment.id, current_state: currentState, ...(expectedItemId ? { expected_item_id: expectedItemId } : {}) },
                        { fetchImpl, env: { ORCHARD_GATE_GITHUB_TOKEN: token } },
                    );
                    const item = manifest.items.find((entry) => entry.item_id === itemId);
                    const captured = await captureGateDecision({
                        manifest, fullManifestItems, verifiedEvent, authorizationPolicy: policy, currentItem: item,
                    });
                    const decision = captured.event;

                    // A Gate 1 approval records with no queue work item id:
                    // the ADO work item does not exist yet, because approval
                    // is what causes it to be created. ado-sync.mjs creates
                    // it next and binds it on the external_link row.
                    await store.recordVerifiedDecision({
                        schema_version: "1.0.0",
                        queue_work_item_id: null,
                        decision, manifest, full_manifest_items: fullManifestItems, current_item: item,
                        verified_event: verifiedEvent, authorization_policy: policy,
                        trust: {
                            provider_event_digest: sha256Digest(verifiedEvent),
                            authorization_policy_digest: adapter.policyDigest,
                            adapter_digest: adapter.adapterDigest,
                            adapter_identity: adapter.adapterIdentity,
                        },
                    });
                    summary.applied += 1;
                    log("info", "gate.apply.decided", {
                        gate, item: decision.item_id, decision: decision.decision,
                        from: decision.previous_state, to: decision.next_state, comment: comment.id,
                        via: expectedItemId ? "bare" : "structured",
                    });
                } catch (error) {
                    summary.errors += 1;
                    log("warn", "gate.apply.refused", {
                        gate, issue: issue.number, comment: comment.id,
                        code: error.code ?? error.name ?? null, reason: error.message,
                        effect: "the item stays where it was",
                    });
                }
            };

            for (const comment of comments) {
                const text = String(comment.body ?? "");
                const structured = /\/orchard gate[12] /.test(text);
                // ADR-0025, amendment 2026-08-16. Checked BEFORE the actor
                // allowlist look-up shares its own log lines with the
                // structured path below.
                const bareMatch = !structured ? /^(approve|approved|deny|denied)$/i.exec(text.trim()) : null;
                const bareDecision = bareMatch ? (/^approve/i.test(bareMatch[1]) ? "approve" : "deny") : null;
                if (!structured && !bareDecision) continue;

                const actorId = comment.user?.id === undefined ? null : String(comment.user.id);
                if (!actorId || !allowed.has(actorId)) {
                    // Named, never silently dropped. Someone who thinks they
                    // decided something has to be able to find out they did not.
                    summary.refused += 1;
                    log("warn", "gate.apply.actor-unauthorised", {
                        gate, issue: issue.number, comment: comment.id,
                        actor: comment.user?.login ?? "unknown",
                        effect: "the comment was read and changed nothing",
                    });
                    continue;
                }

                if (bareDecision) {
                    // Every item this issue offers that is still pending,
                    // read fresh per item so a decision applied earlier in
                    // THIS SAME pass (an individual structured command that
                    // appears before this one) is already reflected: a bare
                    // decision only ever acts on what is still pending at the
                    // moment it is evaluated, which is what makes
                    // structured-first ordering produce mixed outcomes
                    // correctly (deny a few individually, then bare-approve
                    // the rest, or the reverse).
                    const pending = manifest.items.filter((item) => currentStateOf(store.db, item.item_id) === PENDING[gate]);
                    if (pending.length === 0) {
                        summary.unchanged += 1;
                        log("info", "gate.apply.bare-decision-nothing-pending", { gate, issue: issue.number, comment: comment.id, decision: bareDecision });
                        continue;
                    }
                    for (const item of pending) {
                        await applyOneItem(comment, item.item_id, PENDING[gate], item.item_id);
                    }
                    continue;
                }

                const named = ITEM_IN_COMMAND.exec(text);
                if (!named) {
                    summary.refused += 1;
                    log("warn", "gate.apply.command-unparsed", { gate, issue: issue.number, comment: comment.id, effect: "no item named" });
                    continue;
                }
                const currentState = currentStateOf(store.db, named[1]);
                if (currentState === null) {
                    summary.refused += 1;
                    log("warn", "gate.apply.item-unknown", { gate, issue: issue.number, comment: comment.id, item: named[1] });
                    continue;
                }
                if (currentState !== PENDING[gate]) {
                    // Already decided on an earlier run, or moved on. Not an
                    // error: re-reading the same issue every run is how this
                    // works, so most comments will be in this state.
                    summary.unchanged += 1;
                    log("info", "gate.apply.already-decided", { gate, item: named[1], state: currentState });
                    continue;
                }
                await applyOneItem(comment, named[1], currentState, null);
            }

            // Not only when this pass just decided something: a batch whose
            // last item was handed off on an earlier run, before this
            // capability existed, or after a transient close failure, is
            // caught here too, on the very next time this issue is read.
            const stillOpen = manifest.items.some((item) => !itemHandedOff(gate, currentStateOf(store.db, item.item_id)));
            if (!stillOpen) {
                try {
                    const note = gate === "gate-1"
                        ? `Every item in this batch has been decided. Approved items now have Azure DevOps work items open; denied or superseded items need nothing further here. Closing, since this issue has been handed to the next process.`
                        : `Every item in this batch has been decided. Approved items have moved into the publication pipeline; denied or superseded items need nothing further here. Closing, since this issue has been handed to the next process.`;
                    await closeIssue({ repo, issueNumber: issue.number, comment: note, token, fetchImpl });
                    summary.closed += 1;
                    log("info", "gate.apply.issue-closed", { gate, issue: issue.number, items: manifest.items.length });
                } catch (error) {
                    summary.errors += 1;
                    log("warn", "gate.apply.issue-close-failed", {
                        gate, issue: issue.number, status: error.status ?? null, reason: error.message,
                        effect: "every item is handed off, but the issue itself stays open; retried next run",
                    });
                }
            }
        }
    }

    log("info", "gate.apply.finished", { track, ...summary });
    return summary;
}

/**
 * Provision the gate trust anchor from the release, once, if it is absent.
 *
 * THE ANCHOR IS AN ADMINISTRATOR ACT and this does not change that. The
 * administrator is the deployment: the adapter digest is computed at release
 * time from the artifact that goes into the image and passed in through the
 * template, and the actor allowlist is a deployer setting. The container is
 * never allowed to choose its own pin, which is why the digest on disk is
 * recomputed and compared to the one the release bound before anything is
 * written.
 *
 * It is done here rather than by an operator because the state database sits
 * behind a private endpoint with no bastion and no VPN. An anchor provisioned
 * by hand is an operational step nobody can perform, which is the same defect
 * as the artifact seeding gap.
 *
 * Immutable once set: provisionTrustAnchor refuses to replace a different
 * anchor, so a later release with a different adapter cannot silently take
 * over the authority to say who approved something.
 */
export async function ensureGateTrustAnchor({ store, log, env = process.env }) {
    const existing = store.getTrustAnchor("gate");
    if (existing) return existing;
    const adapterPath = env.ORCHARD_GATE_ADAPTER_PATH;
    const boundDigest = env.ORCHARD_GATE_ADAPTER_DIGEST;
    const repository = env.ORCHARD_GITHUB_REPO;
    const actors = String(env.ORCHARD_GATE_ACTORS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!adapterPath || !boundDigest || !repository) {
        log("warn", "gate.anchor.unconfigured", { effect: "no decision can be verified; work stays held" });
        return null;
    }
    if (actors.length === 0) {
        log("warn", "gate.anchor.no-actors", {
            effect: "no decision can be verified; set the numeric GitHub IDs allowed to decide",
        });
        return null;
    }
    if (actors.some((id) => !/^[1-9][0-9]*$/.test(id))) {
        log("warn", "gate.anchor.actors-invalid", {
            effect: "actors must be immutable numeric GitHub IDs, not logins, because a login can be reassigned",
        });
        return null;
    }
    try {
        const onDisk = await protectedAdapterDigest(adapterPath);
        if (onDisk !== boundDigest) {
            log("warn", "gate.anchor.adapter-mismatch", {
                effect: "the adapter in the image is not the one the release bound; nothing is provisioned",
            });
            return null;
        }
        const module = await import(pathToFileURL(adapterPath).href);
        const policy = {
            schema_version: "1.0.0",
            provider: "github",
            repository,
            authorized_actor_ids: [...actors].sort(),
        };
        const anchor = store.provisionTrustAnchor({
            scope: "gate",
            adapter_identity: module.adapterIdentity,
            adapter_digest: onDisk,
            adapter_path: adapterPath,
            policy_digest: sha256Digest(policy),
            policy,
            provisioned_at: new Date().toISOString(),
        });
        log("info", "gate.anchor.provisioned", { identity: module.adapterIdentity, actors: actors.length });
        return anchor;
    } catch (error) {
        log("warn", "gate.anchor.failed", { reason: error.message, effect: "no decision can be verified; work stays held" });
        return null;
    }
}

/**
 * The entry point the runtime calls before a controller starts.
 *
 * Never throws, for the same reason announceGatesForRun never throws: a run
 * that cannot read its decisions is a run that does no new work, not a run
 * that fails.
 */
export async function applyGateDecisionsForRun({ store, track, log, env = process.env, token, fetchImpl = fetch }) {
    const repo = env.ORCHARD_GITHUB_REPO;
    if (!repo) {
        log("warn", "gate.apply.unconfigured", { effect: "gates hold as designed; no decision can be read" });
        return null;
    }
    if (!token) {
        log("warn", "gate.apply.no-token", { effect: "gates hold as designed; no decision can be read" });
        return null;
    }
    let anchor;
    let module;
    try {
        anchor = await ensureGateTrustAnchor({ store, log, env });
        if (!anchor?.policy) throw new Error("no administrator-provisioned gate trust anchor");
        ({ loaded: module } = await loadProtectedAdapterModule(store, "gate"));
        if (typeof module.fetchVerifiedEvent !== "function") throw new Error("the pinned gate adapter exports no fetchVerifiedEvent");
    } catch (error) {
        log("warn", "gate.apply.no-trust-anchor", {
            reason: error.message,
            effect: "no decision can be verified, so none is applied; work stays held",
        });
        return null;
    }
    const adapter = {
        fetchVerifiedEvent: (reference, options) => module.fetchVerifiedEvent(reference, options),
        adapterIdentity: anchor.adapter_identity,
        adapterDigest: anchor.adapter_digest,
        policyDigest: anchor.policy_digest,
    };
    try {
        return await applyGateDecisions({ store, track, repo, token, log, fetchImpl, adapter, policy: anchor.policy });
    } catch (error) {
        log("warn", "gate.apply.failed", { reason: error.message, effect: "work stays held; no decision was applied" });
        return null;
    }
}
