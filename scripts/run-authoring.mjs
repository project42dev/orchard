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

import { spawn } from "node:child_process";

function runProcessAsync(executable, args, options) {
    return new Promise((resolve) => {
        const child = spawn(executable, args, options);
        child.on("error", (err) => resolve({ error: err, status: null }));
        child.on("close", (code) => resolve({ error: null, status: code }));
    });
}
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
import { registrationFor, surfaceForTargetPath, RegistrationError } from "./lib/registration.mjs";
import { splitDiagramDeliverable } from "./lib/diagram-deliverable.mjs";
import { applyRetry } from "./apply-blocked-retry.mjs";
import { prepareItem as prepareGate2Item, evidencePathFor, persistGate2Evidence } from "./run-gate2-prep.mjs";
import { recoverStrandedItems } from "./lib/stranded-recovery.mjs";
import { prepareRemovalCommit } from "./lib/prepare-gate2-evidence.mjs";
import { buildRemovalEvidence, buildRemovalRecord, deregistrationFor, inboundReferences, redirectFor, removedIdForTarget } from "./lib/removal.mjs";
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
 * The local evidence file is a debugging convenience, never the contract: the
 * state-store observation persistGate2Evidence writes is what another job
 * reads. So a disk that cannot take the file (read-only, full) is logged and
 * does not hold an item whose evidence is already durable.
 */
function writeEvidenceDebugCopy({ env, itemId, evidence, log }) {
    const evidenceRoot = env.ORCHARD_EVIDENCE_ROOT ?? env.RUN_RECORD_ROOT ?? process.cwd();
    const evidencePath = evidencePathFor(evidenceRoot, itemId);
    try {
        mkdirSync(join(evidencePath, ".."), { recursive: true });
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch (error) {
        log?.("warn", "gate2evidence.debug-copy-failed", {
            item: itemId, path: evidencePath, reason: error.message,
            effect: "none; the evidence is already in the state store",
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
 * no-evidence hold -- never a fabricated pass. Once the evidence document is
 * built it is persisted to the state store BEFORE the in-process preparation,
 * so an item whose preparation then fails is not stuck: any later gate2-prep
 * execution reads that evidence back from the store and prepares it, at no
 * cost and without re-authoring.
 */
export async function attemptGate2Evidence({ store, applied, runRecordDir, proposalRoot, now, env = process.env, log, fetchImpl = fetch, readGateTokenImpl = readGateToken }) {
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

            // TWO DELIVERABLES, ONE CONTENT SLOT. A diagram is a .mmd source
            // AND a catalogue entry, and until 2026-09-12 the pipeline could
            // carry only the first: the drafter was asked for both, the whole
            // blob was committed verbatim to diagrams/<id>.mmd, and
            // registrationFor was called with no catalogue entry at all, so
            // every diagram item held -- on
            // artifact-format.mermaid-unrecognized when the drafter obeyed the
            // instruction, and on registration.no-catalogue-entry when it did
            // not. The drafter now emits the two halves as two tagged fenced
            // blocks and this splits them, BEFORE the format check (the .mmd
            // that gets checked and committed is the source half, pure mermaid)
            // and before the publication credential is minted (a draft that did
            // not comply is knowable here and costs nothing to refuse here).
            // Non-mermaid targets pass through untouched. See
            // lib/diagram-deliverable.mjs.
            const deliverable = splitDiagramDeliverable({ path: target.path, content: reconstructed.content });
            if (!deliverable.ok) {
                summary.held += 1;
                log("warn", "gate2evidence.held", {
                    item: itemId,
                    reason: deliverable.reason,
                    code: deliverable.code,
                    target: target.path,
                    fenceTags: deliverable.tagsFound,
                    contentLength: reconstructed.content.length,
                    contentHead: deliverable.contentHead,
                });
                continue;
            }
            const publishable = deliverable.source;

            const format = inspectArtifactFormat({ path: target.path, content: publishable });
            if (!format.ok) {
                summary.held += 1;
                log("warn", "gate2evidence.held", {
                    item: itemId,
                    reason: format.reason,
                    code: format.code,
                    target: target.path,
                    declaredFormat: format.format,
                    contentLength: publishable.length,
                    contentHead: format.contentHead,
                });
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
                log("warn", "gate2evidence.held", { item: itemId, reason: "no publication GitHub credential is configured on this job" });
                continue;
            }

            // REACHABILITY. The artifact is well-formed by here; whether any
            // reader can get to it is a separate question, and until 2026-08-19
            // nothing asked it. Every one of the nine items merged that day was
            // published and unreachable: modules no learning path listed, so
            // they had no /learn/<pathId>/<moduleId> URL, and diagrams absent
            // from the diagram catalogue, which is the only index the sites
            // read. The registry entry now goes in the same tree, under the
            // same Gate 2 approval, and an item whose entry cannot be built
            // holds here with the reason rather than publishing half of itself.
            let registration;
            try {
                registration = registrationFor({
                    surface: surfaceForTargetPath(target.path),
                    targetPath: target.path,
                    artifact: publishable,
                    // The other half of the deliverable, carried from the split
                    // above. Before 2026-09-12 no production caller passed this
                    // and it defaulted to null, which is the whole defect.
                    catalogueEntry: deliverable.catalogueEntry,
                });
            } catch (error) {
                if (!(error instanceof RegistrationError)) throw error;
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: error.message, code: error.code, target: target.path });
                continue;
            }

            let commit;
            try {
                commit = await prepareRealCommit({ repository: target.repository, path: target.path, content: publishable, registration, token, fetchImpl });
            } catch (error) {
                if (!(error instanceof RegistrationError)) throw error;
                summary.held += 1;
                log("warn", "gate2evidence.held", { item: itemId, reason: error.message, code: error.code, target: target.path });
                continue;
            }
            log("info", "gate2evidence.prepared", { item: itemId, target: target.path, registeredIn: commit.registeredIn });

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
            // Found live 2026-08-18, on a CLEAN item this time, not a
            // flagged one: "passed every review" plus a wall of digests is
            // still nothing to actually review -- the owner has never once
            // been shown the artifact itself, only cryptographic proof one
            // exists. Every Gate 2 item now carries its own content, the
            // same way an escalated item's rejected draft already does.
            // BOTH HALVES, for a diagram. This is deliberately the WHOLE
            // reconstructed deliverable and not the `publishable` half: a
            // diagram's catalogue entry carries the alt text, which is an
            // accessibility obligation a human is supposed to read before
            // approving it, and showing only the mermaid source would put the
            // half nobody can review into the commit under the reviewer's
            // name. The envelope labels its own two blocks, so nothing is
            // ambiguous about which part lands at which path. (The gate-2
            // manifest item schema declares additionalProperties: false, so
            // the entry rides in `content` rather than a field of its own.)
            const extra = { content: reconstructed.content };

            // DURABLE FIRST. The evidence goes into the state store before
            // the in-process preparation is attempted, so if that attempt
            // fails for any reason, a later gate2-prep execution -- a
            // different container, with a different disk -- can still
            // prepare this exact revision at no cost instead of the item
            // stranding at gate2-ready until it is re-authored.
            persistGate2Evidence({ store, row, evidence, now, extra });
            writeEvidenceDebugCopy({ env, itemId, evidence, log });

            await prepareGate2Item({
                store, row, evidence, now, actor: "orchard/run-authoring/gate2-evidence", extra,
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
            //
            // THE DIAGRAM SPLIT IS ATTEMPTED THE SAME WAY. A rejected diagram
            // draft that DOES carry both halves is escalated as its two real
            // halves -- pure mermaid at the .mmd path, its catalogue entry in
            // the registry -- so the human sees the thing that would have been
            // published. One that does not is escalated as the raw draft it
            // was, unsplit and unedited, because the point of this path is to
            // show what was rejected; the failed split is reported alongside
            // the ensemble's findings rather than swallowed.
            const escalationSplit = splitDiagramDeliverable({ path: target.path, content: rejection.draft });
            if (!escalationSplit.ok) {
                log("warn", "rejection.escalate.deliverable-unsplit", {
                    item: itemId, code: escalationSplit.code, target: target.path,
                    fenceTags: escalationSplit.tagsFound, reason: escalationSplit.reason,
                });
            }
            const escalationContent = escalationSplit.ok ? escalationSplit.source : rejection.draft;
            const draftFormat = inspectArtifactFormat({ path: target.path, content: escalationContent });
            if (!draftFormat.ok) {
                log("warn", "rejection.escalate.format-mismatch", {
                    item: itemId, code: draftFormat.code, target: target.path,
                    declaredFormat: draftFormat.format, reason: draftFormat.reason,
                });
            }
            // REGISTRATION IS ATTEMPTED HERE, AND REPORTED RATHER THAN
            // ENFORCED, for the same reason the format check is: refusing a
            // twice-blocked item strands it with no route to a human, which is
            // the dead end this gate was built to remove. What it must not do
            // is hide the problem. A draft that cannot be registered cannot be
            // reached if it is approved, so the reviewer is told that in the
            // same reason text that carries the ensemble's findings and the
            // format mismatch. An escalated item whose draft IS registrable
            // still gets its registry entry in the prepared commit, exactly
            // like every other item.
            let escalationRegistration = null;
            let registrationProblem = escalationSplit.ok
                ? null
                : { code: escalationSplit.code, message: escalationSplit.reason };
            try {
                escalationRegistration = registrationFor({
                    surface: surfaceForTargetPath(target.path),
                    targetPath: target.path,
                    artifact: escalationContent,
                    catalogueEntry: escalationSplit.catalogueEntry,
                });
            } catch (error) {
                if (!(error instanceof RegistrationError)) throw error;
                registrationProblem = error;
                log("warn", "rejection.escalate.registration-failed", { item: itemId, code: error.code, reason: error.message, target: target.path });
            }

            let commit;
            try {
                commit = await prepareRealCommit({
                    repository: target.repository, path: target.path, content: escalationContent,
                    registration: escalationRegistration, token, fetchImpl, validateFormat: SKIP_ARTIFACT_FORMAT_CHECK,
                });
            } catch (error) {
                if (!(error instanceof RegistrationError)) throw error;
                registrationProblem = error;
                log("warn", "rejection.escalate.registration-failed", { item: itemId, code: error.code, reason: error.message, target: target.path });
                commit = await prepareRealCommit({
                    repository: target.repository, path: target.path, content: escalationContent,
                    token, fetchImpl, validateFormat: SKIP_ARTIFACT_FORMAT_CHECK,
                });
            }

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
                registrationProblem ? `Reachability (${registrationProblem.code}): ${registrationProblem.message}. If this is approved as it stands, the file will be committed and no reader will be able to open it.` : null,
            ].filter(Boolean).join("\n\n") || "(the ensemble blocked this item twice; no finding text could be reconstructed)";

            // The item is at gate2-ready from here on, so its evidence goes
            // into the state store first, exactly as attemptGate2Evidence
            // does: a failed preparation below leaves it preparable by a
            // later gate2-prep execution instead of stranded.
            const escalatedRow = { item_id: itemId, current_revision: revision, origin_run_id: row.origin_run_id };
            const escalationExtra = { escalated: true, rejection_reason: rejectionReason, rejected_draft: rejection.draft };
            persistGate2Evidence({ store, row: escalatedRow, evidence, now, extra: escalationExtra });
            await prepareGate2Item({
                store, row: escalatedRow, evidence, now, actor: "orchard/rejection-gate", extra: escalationExtra,
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

export async function main(argv = process.argv.slice(2), { log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })), env = process.env, spawn = runProcessAsync } = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) fail("ERR_ORCHARD_CONFIGURATION", "run-authoring requires --state-db");
    const now = new Date().toISOString();
    const budget = resolveAuthoringBudget(env);
    log("info", "authoring.budget.accepted", budget);

    const workRoot = env.ORCHARD_AUTHORING_WORK_ROOT ?? join(tmpdir(), `orchard-authoring-${process.pid}`);
    const runRecordDir = env.RUN_RECORD_ROOT ?? join(workRoot, "run-records");
    const proposalRoot = env.PROPOSAL_ROOT ?? join(runRecordDir, "proposals");
    for (const directory of [workRoot, runRecordDir, proposalRoot]) mkdirSync(directory, { recursive: true });

    // Reopen items stranded at gate2-ready by an EARLIER run, before briefs
    // are claimed, so the same run re-drafts them instead of the next one.
    //
    // attemptGate2Evidence below only ever looks at items this run just moved,
    // and the proposal and evidence it needs live on the ephemeral disk of the
    // container that produced them: no job mounts a volume. An item that fell
    // out of that one window can never be prepared in place, which is why
    // gate2.prep.no-evidence repeated for the same items on every run. Nothing
    // drove the recovery that already existed; this drives it, bounded and
    // reported, because every recovered item is re-drafted and that spends.
    let strandedRecovery = { stranded: 0, recovered: [], refused: [], remaining: 0 };
    {
        const recoveryStore = openStateStore(resolve(dbPath));
        try {
            strandedRecovery = await recoverStrandedItems({ store: recoveryStore, track: argOf(argv, "track", null), now, env, log });
        } finally {
            recoveryStore.close();
        }
    }

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
        briefs: briefs.briefs.length, removals: briefs.removals.length, claimed: briefs.claimed.length,
        queued: briefs.queued, skipped: briefs.skipped.length, notReached: briefs.notReached,
    });
    for (const skipped of briefs.skipped) log("warn", "authoring.brief.skipped", skipped);

    // Removals first, and never through the delivery engine. They are
    // composed deterministically, so they cost nothing and they must not be
    // written into briefs.json: the ensemble would try to draft a deletion.
    let removalSummary = { prepared: 0, held: 0 };
    if (briefs.removals.length > 0) {
        const removalStore = openStateStore(resolve(dbPath));
        try {
            removalSummary = await executeRemovals({ store: removalStore, removals: briefs.removals, now, env, log });
        } finally {
            removalStore.close();
        }
        log("info", "removal.finished", removalSummary);
    }

    if (briefs.briefs.length > 0) {
        const briefPath = join(workRoot, "briefs.json");
        writeFileSync(briefPath, `${JSON.stringify(briefs.briefs, null, 2)}\n`);
        const command = deliveryCommand(env);
        log("info", "authoring.delivery.starting", { briefs: briefs.briefs.length, executable: command[0] });
        const result = await spawn(command[0], command.slice(1), {
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
    return { briefs: briefs.briefs.length, applied: ingested.applied.length, gate2Evidence, rejectionRecovery, strandedRecovery, removals: removalSummary };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();


/**
 * Execute the removals this run claimed: compose the removal record, prepare
 * the deletion commit, record the item at gate2-ready and hold it pending for
 * the owner. No ensemble, no spend, and nothing drafted.
 *
 * Best-effort per item, exactly like attemptGate2Evidence: any missing
 * precondition holds that one removal with the reason logged. A removal is a
 * deletion from a live site, so every refusal here is a refusal to delete, and
 * refusing to delete is always the safe way to be wrong.
 */
export async function executeRemovals({ store, removals, now, env = process.env, log, fetchImpl = fetch, readGateTokenImpl = readGateToken }) {
    const summary = { prepared: 0, held: 0 };
    if (!removals || removals.length === 0) return summary;
    let token;

    for (const removal of removals) {
        try {
            const row = store.db.prepare(
                "SELECT item_id, track, current_state, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?",
            ).get(removal.itemId);
            const revision = store.db.prepare(
                "SELECT run_id, proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?",
            ).get(removal.itemId, Number(row.current_revision));
            const link = store.db.prepare(
                `SELECT external_key, external_id FROM external_link
                  WHERE provider = 'ado' AND item_id = ? AND item_revision = ? ORDER BY linked_at DESC LIMIT 1`,
            ).get(removal.itemId, Number(row.current_revision));
            if (!link) {
                summary.held += 1;
                log("warn", "removal.held", { item: removal.itemId, reason: "no persisted ADO link; Gate 2 binds the tracker item" });
                continue;
            }
            const gate1 = store.db.prepare(
                `SELECT event_id FROM decision_event
                  WHERE item_id = ? AND gate = 'gate-1' AND decision = 'approve' AND digest = ?
                  ORDER BY occurred_at DESC LIMIT 1`,
            ).get(removal.itemId, revision.proposal_digest);
            if (!gate1) {
                summary.held += 1;
                log("warn", "removal.held", { item: removal.itemId, reason: "no recorded Gate 1 approval decision event for this exact proposal digest" });
                continue;
            }

            token ??= await readGateTokenImpl({
                log, env, prefix: "removalprep",
                vaultUrlVar: "ORCHARD_PUBLICATION_VAULT_URL", repoVar: "ORCHARD_PUBLICATION_GITHUB_REPO",
                appIdVar: "ORCHARD_PUBLICATION_APP_ID_SECRET", installationIdVar: "ORCHARD_PUBLICATION_INSTALLATION_ID_SECRET",
                appKeyVar: "ORCHARD_PUBLICATION_APP_KEY_SECRET", tokenVar: "ORCHARD_PUBLICATION_TOKEN_SECRET",
            });
            if (!token) {
                summary.held += 1;
                log("warn", "removal.held", { item: removal.itemId, reason: "no publication GitHub credential is configured on this job" });
                continue;
            }

            const composed = await composeRemoval({ removal, token, fetchImpl, now });

            // A removal with something still pointing at it is a page that
            // works today about to 404. It holds, and the referrers are named.
            if (composed.record.record.inbound.found.length > 0) {
                summary.held += 1;
                log("warn", "removal.held", {
                    item: removal.itemId,
                    reason: "something still references this artifact, so removing it would break a page that works today",
                    referrers: composed.record.record.inbound.found.map((entry) => entry.reference),
                });
                continue;
            }
            if (composed.error) {
                summary.held += 1;
                log("warn", "removal.held", { item: removal.itemId, reason: composed.error, target: removal.target.path });
                continue;
            }

            const binding = {
                run_id: revision.run_id ?? row.origin_run_id,
                item_id: removal.itemId,
                item_revision: Number(row.current_revision),
                track: row.track,
                proposal_digest: revision.proposal_digest.startsWith("sha256:") ? revision.proposal_digest : `sha256:${revision.proposal_digest}`,
                gate1_decision_event_id: gate1.event_id,
                ado_external_key: link.external_key,
                ado_work_item_id: Number(link.external_id),
            };
            const evidence = await buildRemovalEvidence({
                binding, target: removal.target, removal: composed.record, commit: composed.commit, now,
            });

            // executing -> gate2-ready, the same transition the ingest records
            // for a drafted item, then straight into Gate 2 preparation. There
            // is no proposal to ingest because there was no ensemble.
            if (row.current_state === "executing") {
                await store.recordTransition({
                    schema_version: "1.0.0",
                    transition_id: generateUuidV7(),
                    run_id: row.origin_run_id,
                    item_id: removal.itemId,
                    item_revision: Number(row.current_revision),
                    from_state: "executing",
                    to_state: "gate2-ready",
                    cause: "artifact-ready",
                    actor: "orchard/run-authoring/removal",
                    occurred_at: now,
                    correlation_id: generateUuidV7(),
                });
            }
            const refreshed = store.db.prepare(
                "SELECT item_id, track, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?",
            ).get(removal.itemId);
            // The owner reads the removal record itself at Gate 2, not a
            // wall of digests about a file they cannot see being deleted.
            const removalExtra = { content: composed.record.content };
            // Durable before the preparation, as in attemptGate2Evidence: a
            // removal whose preparation fails is at gate2-ready now, and a
            // later gate2-prep execution can finish it from the store.
            persistGate2Evidence({ store, row: refreshed, evidence, now, extra: removalExtra });
            await prepareGate2Item({
                store, row: refreshed, evidence, now, actor: "orchard/run-authoring/removal", extra: removalExtra,
            });
            summary.prepared += 1;
            log("info", "removal.prepared", {
                item: removal.itemId, target: removal.target.path, state: "gate2-pending",
                preparedCommit: composed.commit.preparedCommit,
                deregisteredIn: composed.commit.registeredIn,
                redirectNeeded: composed.record.record.redirect.needed,
            });
        } catch (error) {
            summary.held += 1;
            log("warn", "removal.refused", { item: removal.itemId, code: error.code ?? null, reason: error.message });
        }
    }
    return summary;
}

/**
 * Read what the removal needs to know from the target repository, compose the
 * record, and prepare the deletion commit.
 *
 * Bounded on purpose: one catalogue read, the removed module's own directory,
 * and the commit. The publication account is rate limited and a removal is not
 * worth a repository-wide crawl; what was NOT read is recorded in the record so
 * "no inbound references" never reads as a clearance it is not.
 */
async function composeRemoval({ removal, token, fetchImpl, now }) {
    const surface = surfaceForTargetPath(removal.target.path);
    const removedId = removedIdForTarget(removal.target.path, surface);
    const deregistration = deregistrationFor({ surface, targetPath: removal.target.path, removedId });

    const read = async (path) => {
        const response = await fetchImpl(`https://api.github.com/repos/${removal.target.repository}/contents/${path}?ref=main`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Orchard-Removal/1.0",
            },
        });
        if (!response.ok) return null;
        const parsed = JSON.parse(await response.text());
        if (Array.isArray(parsed)) return parsed;
        return Buffer.from(parsed.content ?? "", parsed.encoding ?? "base64").toString("utf8");
    };

    const catalogText = surface === "learning" ? await read("catalog.json") : null;

    // Siblings in the SAME learning path only. A module's prerequisites name
    // modules, and the ones most likely to name this one are the ones beside
    // it.
    const siblings = [];
    if (surface === "learning") {
        const directory = removal.target.path.slice(0, removal.target.path.lastIndexOf("/"));
        const listing = await read(directory);
        if (Array.isArray(listing)) {
            for (const entry of listing) {
                if (entry?.type !== "file" || !entry.path?.endsWith(".json") || entry.path === removal.target.path) continue;
                const content = await read(entry.path);
                if (typeof content === "string") siblings.push({ path: entry.path, content });
            }
        }
    }

    // Scanned AFTER the deregistration, because the artifact's own catalogue
    // listing is what the deregistration removes. Counting it as an inbound
    // reference would make every removal hold on the entry it is deleting.
    const remainingCatalogText = deregistration && typeof catalogText === 'string'
        ? deregistration.apply(catalogText)
        : catalogText;
    const inbound = inboundReferences({ removedId, surface, catalogText: remainingCatalogText, siblings });
    const redirect = redirectFor({ surface, targetPath: removal.target.path });
    const record = buildRemovalRecord({
        item: { item_id: removal.itemId },
        target: removal.target,
        rationale: removal.rationale,
        evidence: removal.evidence,
        catalogue: {
            registry: deregistration?.path ?? null,
            entry: removedId,
            effect: deregistration
                ? `The entry for ${removedId} is removed from ${deregistration.path} in the same commit, so no listing survives the file.`
                : "This surface has no registry: the artifact indexes itself, so deleting the file is the whole removal.",
        },
        inbound,
        redirect,
        now,
    });

    try {
        // Nothing is written to GitHub for a removal that will not go ahead.
        // Same rule registrationFor follows on the way in: a precondition that
        // fails costs no blob, no tree and no commit object.
        if (record.record.inbound.found.length > 0) return { record };
        const commit = await prepareRemovalCommit({
            repository: removal.target.repository, path: removal.target.path,
            deregistration, token, fetchImpl,
        });
        return { record, commit };
    } catch (error) {
        return { error: error.message, record };
    }
}
