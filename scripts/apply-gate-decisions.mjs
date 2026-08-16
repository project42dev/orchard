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
import { listIssueComments, listOpenGateIssues } from "./lib/github-issues.mjs";
import { pathToFileURL } from "node:url";
import { loadProtectedAdapterModule, protectedAdapterDigest } from "./lib/protected-adapter.mjs";
import { sha256Digest } from "./lib/identity.mjs";

const GATES = Object.freeze(["gate-1", "gate-2"]);
const PENDING = Object.freeze({ "gate-1": "gate1-pending", "gate-2": "gate2-pending" });

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
    const summary = { applied: 0, blocked: 0, refused: 0, unchanged: 0, errors: 0 };
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

            for (const comment of comments) {
                const text = String(comment.body ?? "");
                if (!/\/orchard gate[12] /.test(text)) continue;
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

                const fullManifestItems = fullManifestItemsFor(manifest, allManifests);
                if (!fullManifestItems) {
                    summary.blocked += 1;
                    log("warn", "gate.apply.manifest-incomplete", {
                        gate, issue: issue.number,
                        expected: manifest.batch.total_item_count,
                        effect: "a sibling batch issue is missing, so this batch cannot be verified",
                    });
                    continue;
                }

                try {
                    // The token is handed to the adapter rather than left in
                    // process.env: the adapter is pinned code loaded from a
                    // snapshot, and the fewer ambient things it depends on the
                    // smaller the surface its digest has to cover.
                    const verifiedEvent = await adapter.fetchVerifiedEvent(
                        { repository: repo, issue_number: issue.number, comment_id: comment.id, current_state: currentState },
                        { fetchImpl, env: { ORCHARD_GATE_GITHUB_TOKEN: token } },
                    );
                    const item = manifest.items.find((entry) => entry.item_id === named[1]);
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
                    });
                } catch (error) {
                    summary.errors += 1;
                    log("warn", "gate.apply.refused", {
                        gate, issue: issue.number, comment: comment.id,
                        code: error.code ?? error.name ?? null, reason: error.message,
                        effect: "the item stays where it was",
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
