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
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { openStateStore } from "./lib/state-store.mjs";
import { estimatedItemCostUsd } from "./lib/gate-queue.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { generateBriefs } from "./generate-briefs.mjs";
import { ingest, readProposals } from "./ingest-proposals.mjs";
import { buildHandoffsFromProposal, reconstructStageContent, selectContentStage, buildRejectionEvidence, prepareRealCommit, buildEvidenceDocument, Gate2EvidenceError } from "./lib/prepare-gate2-evidence.mjs";
import { inspectArtifactFormat, SKIP_ARTIFACT_FORMAT_CHECK } from "./lib/artifact-format.mjs";
import { applyRetry } from "./apply-blocked-retry.mjs";
import { prepareItem as prepareGate2Item, evidencePathFor } from "./run-gate2-prep.mjs";
import { readGateToken } from "./announce-gates.mjs";

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

/**
 * For each item this run just moved to gate2-ready, try to prepare real
 * Gate 2 evidence NOW, in this same execution, while the winning proposal
 * still exists on local disk and the run that produced it is still in
 * scope. See lib/prepare-gate2-evidence.mjs for what "real" means here.
 *
 * This is deliberately best-effort per item: any missing precondition (no
 * GitHub token configured, no persisted target, a proposal whose final
 * output could not be reconstructed intact) holds that one item at
 * gate2-ready with the reason logged, exactly like run-gate2-prep.mjs's own
 * no-evidence hold -- never a fabricated pass. An item held here is not
 * stuck: it is exactly where every item has always started, and a later
 * gate2-prep run (or a future improvement to this function) can still try
 * again if a real evidence file is ever supplied for it by other means.
 */
export async function attemptGate2Evidence({ store, applied, runRecordDir, proposalRoot, now, env = process.env, log, fetchImpl = fetch }) {
    const gate2Ready = applied.filter((entry) => entry.to === "gate2-ready");
    if (gate2Ready.length === 0) return { prepared: 0, held: 0 };

    const runProposals = readProposals(runRecordDir);
    const summary = { prepared: 0, held: 0 };
    let token;

    for (const entry of gate2Ready) {
        const itemId = entry.subjectId;
        try {
            const row = store.db.prepare(
                "SELECT item_id, track, current_state, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?",
            ).get(itemId);
            const revision = store.db.prepare(
                "SELECT run_id, proposal_digest, target_repository, target_path FROM item_revision WHERE item_id = ? AND item_revision = ?",
            ).get(itemId, Number(row.current_revision));
            if (!revision?.target_repository || !revision?.target_path) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "item_revision carries no persisted publication target" });
                continue;
            }
            const link = store.db.prepare(
                `SELECT external_key, external_id FROM external_link
                  WHERE provider = 'ado' AND item_id = ? AND item_revision = ? ORDER BY linked_at DESC LIMIT 1`,
            ).get(itemId, Number(row.current_revision));
            if (!link) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "no persisted ADO link" });
                continue;
            }
            // Matched on digest, not item_revision. A blocked-item retry (or
            // any other exception-state recovery) reaches 'executing'
            // directly, without going back through Gate 1 -- deliberately:
            // Gate 1 approved the PROPOSAL, and a retry's successor revision
            // carries that exact same proposal_digest forward unchanged
            // (apply-blocked-retry.mjs never edits it, only the authoring
            // attempt is retried). Requiring the approval to sit on the exact
            // current item_revision, found live tonight on the second real
            // item ever to reach gate2-ready, held it forever: the approval
            // that already covers this content is real and on record, just
            // on an earlier revision row. Matching by digest is the same
            // proof the exact-revision match was trying to establish
            // (a human approved THIS content), without requiring a second,
            // redundant Gate 1 review of a proposal that did not change.
            const gate1 = store.db.prepare(
                `SELECT event_id FROM decision_event
                  WHERE item_id = ? AND gate = 'gate-1' AND decision = 'approve' AND digest = ?
                  ORDER BY occurred_at DESC LIMIT 1`,
            ).get(itemId, revision.proposal_digest);
            if (!gate1) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "no recorded Gate 1 approval decision event for this exact proposal digest" });
                continue;
            }

            const proposalMatch = runProposals.find((p) => p.file === entry.file);
            const proposalPath = join(proposalRoot, entry.file);
            const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
            // The artifact to publish is the DRAFTER's output ("curriculum-writing",
            // STAGE_ROLE "writer"), not the finalizer's ("release-proposal",
            // STAGE_ROLE "final-reviewer"). Found live 2026-08-17: every real item
            // that reached this point had the finalizer's own review narrative
            // ("COMPLETENESS.", "CONSISTENCY.", "DEFECTS.", "SUMMARY.",
            // "RECOMMENDATION: ...") committed and gated for publication instead of
            // the lesson content -- confirmed by reading delivery-prompts/finalizer.md,
            // whose own instructions say "You do not re-draft... Do not propose
            // edits to the artifact", and produce exactly that five-section review
            // format for a HUMAN to read, never content for a learner. The finalizer
            // stage stays in the handoff chain for its actual purpose -- the
            // completeness/consistency check the human sees in the evidence record --
            // it is simply never the source of what gets committed to the repo.
            const contentStage = selectContentStage(proposal);
            if (!contentStage) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "proposal carries no curriculum-writing stage" });
                continue;
            }
            const reconstructed = reconstructStageContent(contentStage);
            if (!reconstructed.complete) {
                summary.held += 1;
                // Diagnostic breakdown, not just the fact of failure: found
                // live tonight, twice in a row, on the first two real items
                // ever to get this far -- distinguishing "the PS1 side really
                // did truncate past its own 200000-char chunk cap" from "the
                // findings rejoin exactly but do not hash to outputDigest"
                // (an encoding mismatch between PowerShell's and Node's
                // hashing, or a chunking bug that reorders/drops content
                // without triggering the truncation-notice path) needs to be
                // visible without another live run to guess between them.
                const truncationNoticePresent = (contentStage.findings ?? []).some(
                    (entry) => /^Output truncated after \d+ characters;/.test(entry),
                );
                log("warn", "gate2evidence.held", {
                    item: itemId,
                    reason: "curriculum-writing output could not be reconstructed intact from its findings",
                    rejoinedLength: reconstructed.content.length,
                    findingCount: (contentStage.findings ?? []).length,
                    truncationNoticePresent,
                    rejoinedDigest: reconstructed.digest,
                    recordedDigest: contentStage.outputDigest,
                });
                continue;
            }

            // FORMAT. The content is known here, nothing has touched GitHub
            // yet, and the target path is the only thing that says what the
            // consumer will do with those bytes -- which makes this the last
            // place a malformed artifact can be stopped for free.
            //
            // Found live 2026-08-19: all nine items this pipeline has ever
            // published carried the wrong format for their own target path.
            // Seven Markdown files sit at content/modules/discovery/*.json,
            // where project42-platform's scripts/load-catalog.mjs JSON.parse's
            // every .json it finds, so the catalog cannot build and the entire
            // learn surface renders nothing. Two more sit at .mmd diagram
            // paths wrapped in Markdown fences. See lib/artifact-format.mjs
            // for the full evidence.
            //
            // A mismatch HOLDS the item at gate2-ready, exactly like every
            // other missing precondition above: the draft is not destroyed,
            // the run is not stopped, the other items in this batch still
            // proceed, and a re-authored revision can carry the work forward.
            // prepareRealCommit re-asserts the same rule as a throwing choke
            // point, so no future caller can reach GitHub around this.
            const target = { repository: revision.target_repository, path: revision.target_path };
            const format = inspectArtifactFormat({ path: target.path, content: reconstructed.content });
            if (!format.ok) {
                summary.held += 1;
                log("warn", "gate2evidence.held", {
                    item: itemId,
                    reason: format.reason,
                    code: format.code,
                    target: target.path,
                    declaredFormat: format.format,
                    contentLength: reconstructed.content.length,
                    contentHead: format.contentHead,
                });
                continue;
            }

            token ??= await readGateToken({
                log, env, prefix: "commitprep",
                vaultUrlVar: "ORCHARD_PUBLICATION_VAULT_URL", repoVar: "ORCHARD_PUBLICATION_GITHUB_REPO",
                appIdVar: "ORCHARD_PUBLICATION_APP_ID_SECRET", installationIdVar: "ORCHARD_PUBLICATION_INSTALLATION_ID_SECRET",
                appKeyVar: "ORCHARD_PUBLICATION_APP_KEY_SECRET", tokenVar: "ORCHARD_PUBLICATION_TOKEN_SECRET",
            });
            if (!token) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "no publication GitHub credential is configured on this job" });
                continue;
            }

            const commit = await prepareRealCommit({ repository: target.repository, path: target.path, content: reconstructed.content, token, fetchImpl });

            const rawProposalDigest = revision.proposal_digest ?? proposalMatch?.doc?.proposalDigest ?? null;
            if (!rawProposalDigest) {
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: "no proposal digest is available from either item_revision or the run record" });
                continue;
            }
            const binding = {
                run_id: revision.run_id ?? row.origin_run_id,
                item_id: itemId,
                item_revision: Number(row.current_revision),
                track: row.track,
                proposal_digest: rawProposalDigest.startsWith("sha256:") ? rawProposalDigest : `sha256:${rawProposalDigest}`,
                gate1_decision_event_id: gate1.event_id,
                ado_external_key: link.external_key,
                ado_work_item_id: Number(link.external_id),
            };

            const handoffs = await buildHandoffsFromProposal({ proposal, binding, runStartedAt: now });
            const evidence = buildEvidenceDocument({ handoffs, binding, target, commit, proposal });

            const evidenceRoot = env.ORCHARD_EVIDENCE_ROOT ?? env.RUN_RECORD_ROOT ?? process.cwd();
            const evidencePath = evidencePathFor(evidenceRoot, itemId);
            mkdirSync(join(evidencePath, ".."), { recursive: true });
            writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

            // Found live 2026-08-18, on a CLEAN item this time, not a
            // flagged one: "passed every review" plus a wall of digests is
            // still nothing to actually review -- the owner has never once
            // been shown the artifact itself, only cryptographic proof one
            // exists. Every Gate 2 item now carries its own content, the
            // same way an escalated item's rejected draft already does.
            await prepareGate2Item({
                store, row, evidence, now, actor: "orchard/run-authoring/gate2-evidence",
                extra: { content: reconstructed.content },
            });
            summary.prepared += 1;
            log("info", "gate2evidence.prepared", { item: itemId, state: "gate2-pending", preparedCommit: commit.preparedCommit, target });
        } catch (error) {
            summary.held += 1;
            log("warn", "gate2evidence.refused", {
                item: itemId,
                code: error instanceof Gate2EvidenceError ? error.code : (error.code ?? null),
                reason: error.message,
            });
        }
    }
    return summary;
}

/**
 * Rejection gate (owner request 2026-08-18, docs/design/rejection-gate.md):
 * an item the ensemble just blocked gets ONE automatic retry (the same
 * recovery apply-blocked-retry.mjs already offers an operator, called here
 * inline instead of waiting for one), and on a SECOND block is escalated
 * straight to a human at Gate 2 with the real rejection reason and the
 * actual rejected draft, rather than retried a third time blind. Real
 * rejection evidence -- the verifier's and adversary's own finding text,
 * plus the draft itself -- is recorded as a durable observation on EVERY
 * block, not only an escalated one, because the ADO audit trail this was
 * built for needs it on the first block too.
 */
export async function attemptRejectionRecovery({ store, applied, runRecordDir, proposalRoot, now, env = process.env, log, fetchImpl = fetch, readGateTokenImpl = readGateToken }) {
    const blocked = applied.filter((entry) => entry.to === "blocked");
    const summary = { retried: 0, escalated: 0, held: 0 };
    if (blocked.length === 0) return summary;

    const runProposals = readProposals(runRecordDir);
    let token;

    for (const entry of blocked) {
        const itemId = entry.subjectId;
        try {
            const row = store.db.prepare(
                "SELECT item_id, track, current_state, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?",
            ).get(itemId);
            if (!row || row.current_state !== "blocked") {
                log("info", "rejection.recovery.skipped", { item: itemId, reason: "item is no longer blocked, another path already moved it" });
                continue;
            }
            const revision = Number(row.current_revision);

            const proposalMatch = runProposals.find((p) => p.file === entry.file);
            const proposalPath = join(proposalRoot, entry.file);
            const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
            const rejection = buildRejectionEvidence(proposal);

            await store.recordObservation({
                observation_id: generateUuidV7(),
                run_id: row.origin_run_id,
                item_id: itemId,
                item_revision: revision,
                evidence_reference: `orchard/rejection-evidence/${itemId}:r${revision}`,
                evidence_digest: sha256Digest(rejection),
                observed_at: now,
                rejection_evidence: rejection,
            });

            const priorBlocks = Number(store.db.prepare(
                "SELECT COUNT(*) AS n FROM state_transition_event WHERE item_id = ? AND to_state = 'blocked'",
            ).get(itemId).n);
            log("info", "rejection.evidence.recorded", { item: itemId, priorBlocks, verifierVerdict: rejection.verifierVerdict, adversaryVerdict: rejection.adversaryVerdict });

            if (priorBlocks <= 1) {
                const result = await applyRetry(store, { item: itemId, actor: "orchard/auto-retry-blocked", now });
                if (result.errors.length) {
                    summary.held += 1;
                    log("warn", "rejection.auto-retry.refused", { item: itemId, errors: result.errors });
                } else {
                    summary.retried += 1;
                    log("info", "rejection.auto-retry.applied", result);
                }
                continue;
            }

            // Second block: escalate. blocked -> gate2-ready first (a pure
            // state move, the content under review is not changing), then
            // the SAME evidence pipeline a passing item uses -- on the
            // rejected draft, which is why factual_review naturally comes
            // back "failed" below: it is the ensemble's own real verdict,
            // not something this path has to fake.
            const link = store.db.prepare(
                `SELECT external_key, external_id FROM external_link
                  WHERE provider = 'ado' AND item_id = ? AND item_revision = ? ORDER BY linked_at DESC LIMIT 1`,
            ).get(itemId, revision);
            if (!link) {
                summary.held += 1;
                log("warn", "rejection.escalate.held", { item: itemId, reason: "no persisted ADO link" });
                continue;
            }
            const gate1 = store.db.prepare(
                `SELECT event_id FROM decision_event
                  WHERE item_id = ? AND gate = 'gate-1' AND decision = 'approve' AND digest = ?
                  ORDER BY occurred_at DESC LIMIT 1`,
            ).get(itemId, store.db.prepare("SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?").get(itemId, revision).proposal_digest);
            if (!gate1) {
                summary.held += 1;
                log("warn", "rejection.escalate.held", { item: itemId, reason: "no recorded Gate 1 approval decision event for this exact proposal digest" });
                continue;
            }

            token ??= await readGateTokenImpl({
                log, env, prefix: "commitprep",
                vaultUrlVar: "ORCHARD_PUBLICATION_VAULT_URL", repoVar: "ORCHARD_PUBLICATION_GITHUB_REPO",
                appIdVar: "ORCHARD_PUBLICATION_APP_ID_SECRET", installationIdVar: "ORCHARD_PUBLICATION_INSTALLATION_ID_SECRET",
                appKeyVar: "ORCHARD_PUBLICATION_APP_KEY_SECRET", tokenVar: "ORCHARD_PUBLICATION_TOKEN_SECRET",
            });
            if (!token) {
                summary.held += 1;
                log("warn", "rejection.escalate.held", { item: itemId, reason: "no publication GitHub credential is configured on this job" });
                continue;
            }

            const revisionRecord = store.db.prepare(
                "SELECT proposal_digest, target_repository, target_path FROM item_revision WHERE item_id = ? AND item_revision = ?",
            ).get(itemId, revision);
            const target = { repository: revisionRecord.target_repository, path: revisionRecord.target_path };
            if (!rejection.draft) {
                summary.held += 1;
                log("warn", "rejection.escalate.held", { item: itemId, reason: "rejected draft could not be reconstructed intact from its findings" });
                continue;
            }
            // FORMAT, ON THE ESCALATION PATH, IS REPORTED AND NOT REFUSED.
            // This draft was already rejected by the ensemble's own review;
            // the commit exists so a human can SEE what was rejected, not so
            // it can be published. Refusing to prepare it would strand a
            // twice-blocked item with no route to a human at all, which is
            // the dead end the rejection gate was built to remove. So the
            // check still runs, the opt-out is named rather than implied, and
            // the mismatch goes into the reason the reviewer reads.
            const draftFormat = inspectArtifactFormat({ path: target.path, content: rejection.draft });
            if (!draftFormat.ok) {
                log("warn", "rejection.escalate.format-mismatch", {
                    item: itemId, code: draftFormat.code, target: target.path,
                    declaredFormat: draftFormat.format, reason: draftFormat.reason,
                });
            }
            const commit = await prepareRealCommit({
                repository: target.repository, path: target.path, content: rejection.draft,
                token, fetchImpl, validateFormat: SKIP_ARTIFACT_FORMAT_CHECK,
            });

            const rawProposalDigest = revisionRecord.proposal_digest ?? proposalMatch?.doc?.proposalDigest ?? null;
            if (!rawProposalDigest) {
                summary.held += 1;
                log("warn", "rejection.escalate.held", { item: itemId, reason: "no proposal digest is available from either item_revision or the run record" });
                continue;
            }
            const binding = {
                run_id: row.origin_run_id,
                item_id: itemId,
                item_revision: revision,
                track: row.track,
                proposal_digest: rawProposalDigest.startsWith("sha256:") ? rawProposalDigest : `sha256:${rawProposalDigest}`,
                gate1_decision_event_id: gate1.event_id,
                ado_external_key: link.external_key,
                ado_work_item_id: Number(link.external_id),
            };
            const handoffs = await buildHandoffsFromProposal({ proposal, binding, runStartedAt: now });
            const evidence = buildEvidenceDocument({ handoffs, binding, target, commit, proposal });

            await store.recordTransition({
                schema_version: "1.0.0",
                transition_id: generateUuidV7(),
                run_id: row.origin_run_id,
                item_id: itemId,
                item_revision: revision,
                from_state: "blocked",
                to_state: "gate2-ready",
                cause: "escalated-for-human-review",
                actor: "orchard/rejection-gate",
                occurred_at: now,
                correlation_id: generateUuidV7(),
            });

            const rejectionReason = [
                rejection.verifierVerdict ? `Verifier (${rejection.verifierVerdict}): ${rejection.verifierFinding ?? "(no finding text reconstructed)"}` : null,
                rejection.adversaryVerdict ? `Adversary (${rejection.adversaryVerdict}): ${rejection.adversaryFinding ?? "(no finding text reconstructed)"}` : null,
                draftFormat.ok ? null : `Artifact format (${draftFormat.code}): ${draftFormat.reason}`,
            ].filter(Boolean).join("\n\n") || "(the ensemble blocked this item twice; no finding text could be reconstructed)";

            await prepareGate2Item({
                store,
                row: { item_id: itemId, current_revision: revision, origin_run_id: row.origin_run_id },
                evidence, now, actor: "orchard/rejection-gate",
                extra: { escalated: true, rejection_reason: rejectionReason, rejected_draft: rejection.draft },
            });
            summary.escalated += 1;
            log("info", "rejection.escalated", { item: itemId, state: "gate2-pending", preparedCommit: commit.preparedCommit, target });
        } catch (error) {
            summary.held += 1;
            log("warn", "rejection.recovery.failed", { item: itemId, reason: error.message });
        }
    }
    return summary;
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

    let gate2Evidence = { prepared: 0, held: 0 };
    let rejectionRecovery = { retried: 0, escalated: 0, held: 0 };
    if (ingested.applied.length > 0) {
        const store = openStateStore(resolve(dbPath));
        try {
            recordAuthoringEvidence({ store, applied: ingested.applied, runRecordDir, now });
            gate2Evidence = await attemptGate2Evidence({ store, applied: ingested.applied, runRecordDir, proposalRoot, now, env, log });
            log("info", "gate2evidence.finished", gate2Evidence);
            rejectionRecovery = await attemptRejectionRecovery({ store, applied: ingested.applied, runRecordDir, proposalRoot, now, env, log });
            log("info", "rejection.recovery.finished", rejectionRecovery);
        } finally {
            store.close();
        }
    }
    return { briefs: briefs.briefs.length, applied: ingested.applied.length, gate2Evidence, rejectionRecovery };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
