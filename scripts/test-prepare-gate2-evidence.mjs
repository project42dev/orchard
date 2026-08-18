#!/usr/bin/env node
// Found live 2026-08-17: every real item that ever reached Gate 2 had the
// FINALIZER's review narrative ("COMPLETENESS.", "CONSISTENCY.", "DEFECTS.",
// "SUMMARY.", "RECOMMENDATION: ...") committed and gated for human approval
// instead of the actual lesson content. This module's content selection
// (which of six model stages is "the artifact") had zero test coverage --
// that is how it shipped and stayed live through every gate-2-ready item
// ever produced. These tests exist so that gap cannot reopen silently.

import assert from "node:assert/strict";
import { test } from "node:test";
import { reconstructStageContent, selectContentStage, buildHandoffsFromProposal, CONTENT_STAGE, STAGE_ROLE } from "./lib/prepare-gate2-evidence.mjs";
import { sha256Digest } from "./lib/identity.mjs";

function sha256(text) {
    return sha256Digest(text).slice("sha256:".length);
}

// Format-Project42ModelStage's own documented chunking: 2000 characters per
// finding, content chunks are raw substrings, never prefixed.
function chunkedStage(stage, text) {
    const chunks = [];
    for (let index = 0; index < text.length; index += 2000) chunks.push(text.slice(index, index + 2000));
    return { stage, findings: chunks, outputDigest: sha256(text), status: "passed", latencyMs: 1000, deploymentAlias: "a", modelVersion: "v1", providerFamily: "openai", contractVersion: "1.0.0" };
}

const REAL_LESSON = "RAG combines retrieval with generation. A retriever selects passages, and a generator model conditions its output on them.";
const REVIEW_NARRATIVE = "**COMPLETENESS.** Every criterion is addressed.\n\n**CONSISTENCY.** No disagreement.\n\n**DEFECTS.** None.\n\n**SUMMARY.** Ready.\n\n**RECOMMENDATION: APPROVE**";

function realisticProposal() {
    return {
        modelStages: [
            chunkedStage("evidence-research", "Sources: rag paper, vendor docs."),
            chunkedStage("curriculum-writing", REAL_LESSON),
            chunkedStage("factual-verification", "All claims supported."),
            chunkedStage("assessment-review", "Assessment adequate."),
            chunkedStage("accessibility-review", "Needs human review."),
            chunkedStage("release-proposal", REVIEW_NARRATIVE),
        ],
    };
}

test("selectContentStage picks curriculum-writing, the only stage STAGE_ROLE maps to the writer", () => {
    assert.equal(CONTENT_STAGE, "curriculum-writing");
    assert.equal(STAGE_ROLE[CONTENT_STAGE], "writer");
    const stage = selectContentStage(realisticProposal());
    assert.equal(stage.stage, "curriculum-writing");
});

test("the reconstructed content to publish is the lesson, never the finalizer's review narrative -- the exact defect found live 2026-08-17", () => {
    const proposal = realisticProposal();
    const stage = selectContentStage(proposal);
    const reconstructed = reconstructStageContent(stage);
    assert.ok(reconstructed.complete, "a well-formed stage must reconstruct completely");
    assert.equal(reconstructed.content, REAL_LESSON);
    assert.ok(!reconstructed.content.includes("RECOMMENDATION"), "the published artifact must never carry the finalizer's review vocabulary");
    assert.ok(!reconstructed.content.includes("COMPLETENESS."), "the published artifact must never be the finalizer's five-section report");
});

test("a proposal with no curriculum-writing stage yields no content stage, not a silent fallback to another stage", () => {
    const proposal = realisticProposal();
    proposal.modelStages = proposal.modelStages.filter((stage) => stage.stage !== "curriculum-writing");
    assert.equal(selectContentStage(proposal), null);
});

test("reconstructStageContent excludes ORCHARD_NOTE_PREFIX entries and truncation notices, never folding them into the artifact", () => {
    const stage = chunkedStage("curriculum-writing", REAL_LESSON);
    stage.findings = ["ORCHARD_NOTE: Finalizer package review.", ...stage.findings, "Output truncated after 999999 characters; see run record."];
    const reconstructed = reconstructStageContent(stage);
    assert.equal(reconstructed.content, REAL_LESSON);
    assert.equal(reconstructed.complete, false, "a truncation notice present must mark the reconstruction incomplete even if the digest happens to match");
});

test("a handoff's captured finding is the real reasoning, not an ORCHARD_NOTE marker that happens to sort first", async () => {
    // Found live 2026-08-18: the owner asked "what am I reading" about a
    // factual_review.finding that turned out to be the literal string
    // "ORCHARD_NOTE: Verifier verdict: FAIL." -- a status restated as a
    // sentence, not a finding. buildHandoffsFromProposal's OWN raw
    // .slice(0, 1) had captured whichever entry happened to be first,
    // including a note Format-Project42ModelStage prepends before the
    // real content chunks.
    const proposal = realisticProposal();
    const verifierStage = proposal.modelStages.find((s) => s.stage === "factual-verification");
    verifierStage.status = "failed";
    verifierStage.findings = ["ORCHARD_NOTE: Verifier verdict: FAIL.", "The claim that the API is generally available is not supported by the cited source, which describes it as in preview."];
    const binding = {
        run_id: "01a00000-0000-7000-8000-000000000000", item_id: "01a00000-0000-7000-8000-000000000001", item_revision: 1,
        track: "track-1", ado_external_key: "orchard:track-1:01a00000-0000-7000-8000-000000000001:r1", ado_work_item_id: 4242,
        proposal_digest: "sha256:" + "1".repeat(64), gate1_decision_event_id: "01a00000-0000-7000-8000-0000000000aa",
    };
    const handoffs = await buildHandoffsFromProposal({ proposal, binding, runStartedAt: "2026-08-15T00:00:00.000Z" });
    const verifierHandoff = handoffs[2];
    assert.equal(verifierHandoff.findings[0].summary, "The claim that the API is generally available is not supported by the cited source, which describes it as in preview.",
        "the real reasoning must be captured, not the ORCHARD_NOTE marker that happened to be findings[0]");
});

test("a handoff falls back to the note itself when a stage produced nothing else -- never fewer findings than before, only a better first pick", async () => {
    const proposal = realisticProposal();
    const verifierStage = proposal.modelStages.find((s) => s.stage === "factual-verification");
    verifierStage.status = "failed";
    verifierStage.findings = ["ORCHARD_NOTE: Verifier verdict: FAIL."];
    const binding = {
        run_id: "01a00000-0000-7000-8000-000000000000", item_id: "01a00000-0000-7000-8000-000000000002", item_revision: 1,
        track: "track-1", ado_external_key: "orchard:track-1:01a00000-0000-7000-8000-000000000002:r1", ado_work_item_id: 4243,
        proposal_digest: "sha256:" + "2".repeat(64), gate1_decision_event_id: "01a00000-0000-7000-8000-0000000000bb",
    };
    const handoffs = await buildHandoffsFromProposal({ proposal, binding, runStartedAt: "2026-08-15T00:00:00.000Z" });
    assert.equal(handoffs[2].findings[0].summary, "ORCHARD_NOTE: Verifier verdict: FAIL.", "with nothing else to pick, the note is still shown rather than nothing at all");
});
