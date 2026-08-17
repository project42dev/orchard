import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
    reconstructStageContent, buildHandoffsFromProposal, prepareRealCommit, buildEvidenceDocument, Gate2EvidenceError,
} from "../scripts/lib/prepare-gate2-evidence.mjs";
import { generateUuidV7, sha256Digest } from "../scripts/lib/identity.mjs";

function bareSha256(text) {
    return createHash("sha256").update(text).digest("hex");
}

function stage(overrides = {}) {
    return {
        stage: "release-proposal",
        deploymentAlias: "gpt-5-6-luna",
        providerFamily: "openai",
        modelVersion: "2026-06-01",
        contractVersion: "1.0.0",
        temperature: 1,
        maxOutputTokens: 4000,
        inputEvidenceDigest: bareSha256("input"),
        outputDigest: bareSha256("the final module text"),
        latencyMs: 1200,
        costUsd: 0.42,
        status: "passed",
        findings: ["the final module text"],
        ...overrides,
    };
}

function sixStageProposal(overrides = {}) {
    const stages = [
        { stage: "evidence-research", role: "researcher" },
        { stage: "curriculum-writing", role: "writer" },
        { stage: "factual-verification", role: "factual" },
        { stage: "assessment-review", role: "assessment" },
        { stage: "accessibility-review", role: "accessibility" },
        { stage: "release-proposal", role: "final" },
    ].map(({ stage: id }) => stage({
        stage: id,
        outputDigest: bareSha256(`output for ${id}`),
        findings: [`output for ${id}`],
        status: id === "factual-verification" || id === "accessibility-review" ? "human-review" : "passed",
    }));
    return { modelStages: stages, ...overrides };
}

function binding() {
    return {
        run_id: generateUuidV7(), item_id: generateUuidV7(), item_revision: 1, track: "track-1",
        proposal_digest: sha256Digest("proposal"), gate1_decision_event_id: generateUuidV7(),
        ado_external_key: null, ado_work_item_id: 42,
    };
}

test("reconstructStageContent rejoins findings and confirms the digest when the output was not truncated", () => {
    const text = "a real authored module, short enough to fit in one finding";
    const s = stage({ outputDigest: bareSha256(text), findings: [text] });
    const result = reconstructStageContent(s);
    assert.equal(result.content, text);
    assert.equal(result.complete, true);
});

test("reconstructStageContent refuses to treat a truncated output as complete", () => {
    const s = stage({
        outputDigest: bareSha256("the full 30000-character text this does not reproduce"),
        findings: ["only the first chunk", "Output truncated after 20000 characters; 8412 characters are not reproduced here. The outputDigest covers the whole output, so the truncation is detectable."],
    });
    const result = reconstructStageContent(s);
    assert.equal(result.complete, false);
});

test("reconstructStageContent refuses when the rejoined chunks simply do not hash to the declared digest", () => {
    const s = stage({ outputDigest: bareSha256("something else entirely"), findings: ["not that"] });
    assert.equal(reconstructStageContent(s).complete, false);
});

test("reconstructStageContent excludes ORCHARD_NOTE_ findings from the reconstructed content", () => {
    // Found live 2026-08-17: Format-Project42ModelStage prepends ExtraFindings
    // (e.g. "Finalizer package review.") and a temperature-disclosure note to
    // findings BEFORE the $Output chunks -- every release-proposal stage that
    // carries either one corrupted reconstruction 100% of the time, because
    // nothing here told a note apart from a content chunk. outputDigest is
    // computed over $Output alone, so a real stage's findings look exactly
    // like this: a note first, then the actual content chunks.
    const text = "a real authored module, short enough to fit in one finding";
    const s = stage({
        outputDigest: bareSha256(text),
        findings: [
            "ORCHARD_NOTE: Finalizer package review.",
            "ORCHARD_NOTE: Temperature was not set on the request, so the service default applied.",
            text,
        ],
    });
    const result = reconstructStageContent(s);
    assert.equal(result.content, text, "the notes must not appear in the reconstructed content");
    assert.equal(result.complete, true, "a stage with notes plus its full content must still reconstruct as complete");
});

test("reconstructStageContent does not accidentally exclude real content that merely mentions the note prefix mid-string", () => {
    const text = "the model discussed ORCHARD_NOTE: as a labeling convention in passing";
    const s = stage({ outputDigest: bareSha256(text), findings: [text] });
    const result = reconstructStageContent(s);
    assert.equal(result.content, text, "only a finding that STARTS with the marker is excluded, not one that merely contains it");
    assert.equal(result.complete, true);
});

test("buildHandoffsFromProposal builds one real handoff per stage, chained, in stage order", async () => {
    const proposal = sixStageProposal();
    const b = binding();
    b.ado_external_key = `orchard:${b.track}:${b.item_id}:r${b.item_revision}`;
    const handoffs = await buildHandoffsFromProposal({ proposal, binding: b, runStartedAt: new Date().toISOString() });
    assert.equal(handoffs.length, 6);
    assert.equal(handoffs[0].role, "evidence-researcher");
    assert.equal(handoffs.at(-1).role, "final-reviewer");
    for (let i = 1; i < handoffs.length; i += 1) {
        assert.equal(handoffs[i].predecessor_handoff_digest, handoffs[i - 1].output_digest);
    }
    assert.equal(handoffs[0].predecessor_handoff_digest, null);
    // The two stages this deployed engine never runs with a dedicated agent
    // are honestly "human-review", never fabricated as passed.
    assert.equal(handoffs[2].role, "factual-verifier");
    assert.equal(handoffs[2].status, "human-review");
    assert.equal(handoffs[4].role, "accessibility-reviewer");
    assert.equal(handoffs[4].status, "human-review");
});

test("buildHandoffsFromProposal refuses a proposal missing a required stage", async () => {
    const proposal = { modelStages: sixStageProposal().modelStages.slice(0, 5) };
    const b = binding();
    b.ado_external_key = `orchard:${b.track}:${b.item_id}:r${b.item_revision}`;
    await assert.rejects(
        () => buildHandoffsFromProposal({ proposal, binding: b, runStartedAt: new Date().toISOString() }),
        Gate2EvidenceError,
    );
});

test("prepareRealCommit creates a blob, tree, and commit with a matching trailer, and no ref", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "a".repeat(40) } });
        if (url.includes("/git/commits/") && options.method === "GET") return json({ tree: { sha: "b".repeat(40) } });
        if (url.endsWith("/git/blobs")) return json({ sha: "c".repeat(40) });
        if (url.endsWith("/git/trees")) return json({ sha: "d".repeat(40) });
        if (url.endsWith("/git/commits")) return json({ sha: "e".repeat(40) });
        throw new Error(`unexpected call ${url}`);
    };
    const result = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: "docs/learn/example.md",
        content: "new content", token: "tok", fetchImpl,
    });
    assert.equal(result.baseCommit, "a".repeat(40));
    assert.equal(result.preparedCommit, "e".repeat(40));
    assert.match(result.preparedTreeDigest, /^sha256:[a-f0-9]{64}$/);
    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST");
    assert.ok(commitCall.body.message.includes(`Orchard-Prepared-Tree-Digest: ${result.preparedTreeDigest}`));
    assert.deepEqual(commitCall.body.parents, [result.baseCommit]);
    assert.equal(calls.some((c) => c.url.includes("/git/refs") && c.method === "POST"), false, "must never create a ref/branch here");
});

test("prepareRealCommit surfaces a real GitHub error instead of swallowing it", async () => {
    const fetchImpl = async (url) => {
        if (url.endsWith("/git/ref/heads/main")) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "Not Found" }) };
        throw new Error("unexpected call");
    };
    await assert.rejects(
        () => prepareRealCommit({ repository: "project42dev/project42-platform", path: "x.md", content: "x", token: "tok", fetchImpl }),
        Gate2EvidenceError,
    );
});

test("buildEvidenceDocument marks reviews human-review, not passed, when no dedicated review agent ran", async () => {
    const proposal = sixStageProposal();
    const b = binding();
    b.ado_external_key = `orchard:${b.track}:${b.item_id}:r${b.item_revision}`;
    const handoffs = await buildHandoffsFromProposal({ proposal, binding: b, runStartedAt: new Date().toISOString() });
    const target = { repository: "project42dev/project42-platform", path: "docs/learn/example.md" };
    const commit = { baseCommit: "a".repeat(40), preparedCommit: "e".repeat(40), preparedTreeDigest: sha256Digest("tree") };
    const evidence = buildEvidenceDocument({ handoffs, binding: b, target, commit, proposal });
    assert.equal(evidence.manifest.factual_review.status, "human-review");
    assert.equal(evidence.manifest.accessibility_review.status, "human-review");
    assert.equal(evidence.manifest.base_commit, commit.baseCommit);
    assert.equal(evidence.manifest.prepared_tree_digest, commit.preparedTreeDigest);
    assert.equal(evidence.artifact_binding.artifact_digest, handoffs.at(-1).output_digest);
    assert.equal(evidence.artifact_binding.final_handoff_id, handoffs.at(-1).handoff_id);
    const expectedCost = proposal.modelStages.reduce((sum, s) => sum + s.costUsd, 0);
    assert.ok(Math.abs(evidence.manifest.cost.amount - expectedCost) < 1e-9);
});

function json(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
