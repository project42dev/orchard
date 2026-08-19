#!/usr/bin/env node
// Found live 2026-08-19, on the only nine items this pipeline has ever
// published to project42dev/project42-platform (merged pull requests #153
// through #161): every one of the nine carried the wrong format for its own
// target path.
//
//   seven Markdown files at content/modules/discovery/*.json, rag.json
//   opening "# Retrieval-augmented generation, embeddings, and vector search"
//   two Markdown-wrapped files at content/diagrams/*.mmd, opening
//   "## 1. Mermaid diagram source" and "```mermaid"
//
// The platform's scripts/load-catalog.mjs JSON.parse's every .json under
// content/modules, so the seven do not fail alone: the catalog cannot build
// at all and nothing renders on learn.project-42.dev.
//
// These tests pin the two halves of the fix. The guard: an artifact whose
// content does not match the format its path declares is refused before any
// GitHub write, and the item HOLDS rather than the run crashing. The cause:
// the learning surface now tells the drafter to emit LearningModule JSON,
// which it never did, which is why it returned Markdown.
//
// The literal content heads below are the REAL bytes from those nine
// published files, not invented examples.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ArtifactFormatError, MERMAID_DIAGRAM_KEYWORDS, SKIP_ARTIFACT_FORMAT_CHECK,
    assertArtifactFormat, declaredFormatFor, firstDiagramLine, inspectArtifactFormat,
} from "./lib/artifact-format.mjs";
import { prepareRealCommit } from "./lib/prepare-gate2-evidence.mjs";
import { attemptGate2Evidence } from "./run-authoring.mjs";
import { buildAcceptanceCriteria, buildPrompt, formFor, surfaceCriteriaFor } from "./generate-briefs.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { estate, seedGateItems, walkTo } from "./test-fixtures.mjs";

const MODULE_PATH = "content/modules/discovery/rag.json";
const DIAGRAM_PATH = "content/diagrams/retrieval-pipeline.mmd";

// The real first lines of content/modules/discovery/rag.json on main.
const PUBLISHED_MARKDOWN = [
    "# Retrieval-augmented generation, embeddings, and vector search",
    "",
    "**Level: Intermediate**",
    "",
    "## Learning objectives",
].join("\n");

// The real first lines of content/diagrams/multi-agent.mmd on main.
const PUBLISHED_FENCED_DIAGRAM = [
    "## 1. Mermaid diagram source",
    "",
    "```mermaid",
    "flowchart TB",
    "    R[\"INTERMEDIATE TRACE EXERCISE\"]",
    "```",
].join("\n");

// The minimum LearningModule the platform schema accepts, field for field.
function learningModule(overrides = {}) {
    return {
        id: "rag",
        title: "Retrieval-augmented generation",
        summary: "Trace a query through embedding, retrieval, and generation.",
        level: "intermediate",
        providers: ["provider-neutral"],
        estimatedMinutes: 40,
        objectives: ["Explain how retrieval-augmented generation differs from generation alone."],
        prerequisites: [],
        sections: [{ id: "rag-what-it-does", title: "What it does", paragraphs: ["A retrieval step conditions generation on found text."] }],
        knowledgeCheck: {
            passPercent: 80,
            questions: [{
                id: "q-rag-1", prompt: "What does retrieval add?",
                choices: ["Nothing", "External text the generator is conditioned on"],
                answerIndex: 1, explanation: "Retrieval supplies non-parametric memory.",
            }],
        },
        sources: [{ title: "Example", url: "https://example.invalid/rag", publisher: "Example", lastVerified: "2026-08-19" }],
        reviewCadenceDays: 30,
        lastVerified: "2026-08-19",
        ...overrides,
    };
}

// --- the rule: content must match the format its own path declares ----------

test("the Markdown that was really published to a .json module path is refused, with the named error", () => {
    const inspection = inspectArtifactFormat({ path: MODULE_PATH, content: PUBLISHED_MARKDOWN });
    assert.equal(inspection.ok, false, "raw Markdown at a .json path is not publishable");
    assert.equal(inspection.code, "artifact-format.json-unparsable", "the refusal carries its own named code");
    assert.equal(inspection.format, "json", "the format the PATH declared is named, not guessed");
    assert.match(inspection.contentHead, /^# Retrieval-augmented generation/, "the log carries what it actually got, so nobody has to re-run to find out");

    assert.throws(
        () => assertArtifactFormat({ path: MODULE_PATH, content: PUBLISHED_MARKDOWN }),
        (error) => {
            assert.ok(error instanceof ArtifactFormatError, "the throwing form raises its own named error type");
            assert.equal(error.code, "artifact-format.json-unparsable");
            assert.equal(error.path, MODULE_PATH, "the error names the path, so one refusal in a batch of nine is identifiable");
            return true;
        },
    );
});

test("a real LearningModule object bound for a .json path passes", () => {
    const inspection = inspectArtifactFormat({ path: MODULE_PATH, content: JSON.stringify(learningModule(), null, 2) });
    assert.equal(inspection.ok, true);
    assert.equal(inspection.format, "json");
    assert.doesNotThrow(() => assertArtifactFormat({ path: MODULE_PATH, content: JSON.stringify(learningModule()) }));
});

test("JSON that parses to a bare scalar is still refused -- the platform would spread it into a silently wrong catalog", () => {
    const inspection = inspectArtifactFormat({ path: MODULE_PATH, content: "\"just a string\"" });
    assert.equal(inspection.ok, false);
    assert.equal(inspection.code, "artifact-format.json-not-an-object");
});

test("empty content is refused for both declared formats, rather than parsed as nothing", () => {
    assert.equal(inspectArtifactFormat({ path: MODULE_PATH, content: "" }).code, "artifact-format.empty");
    assert.equal(inspectArtifactFormat({ path: DIAGRAM_PATH, content: "   \n\n  " }).code, "artifact-format.empty");
});

test("the Markdown-wrapped diagram that was really published to a .mmd path is refused", () => {
    const heading = inspectArtifactFormat({ path: DIAGRAM_PATH, content: PUBLISHED_FENCED_DIAGRAM });
    assert.equal(heading.ok, false, "a Markdown heading is not a diagram");
    assert.equal(heading.code, "artifact-format.mermaid-unrecognized");

    const fenceFirst = inspectArtifactFormat({ path: DIAGRAM_PATH, content: "```mermaid\nflowchart LR\n  A --> B\n```" });
    assert.equal(fenceFirst.ok, false, "a fence is still Markdown even when the diagram inside it is valid");
    assert.equal(fenceFirst.code, "artifact-format.mermaid-unrecognized");
});

test("prose that merely contains a diagram word is refused -- the keyword must open the line", () => {
    const inspection = inspectArtifactFormat({ path: DIAGRAM_PATH, content: "Graphs are useful when the flow branches." });
    assert.equal(inspection.ok, false, "\"Graphs\" must not satisfy the \"graph\" keyword");
    assert.equal(inspection.code, "artifact-format.mermaid-unrecognized");
});

test("real mermaid source passes, including comments, an init directive, and YAML frontmatter", () => {
    assert.equal(inspectArtifactFormat({
        path: DIAGRAM_PATH,
        content: "flowchart LR\n    A[\"Source material\"] --> B[\"Extract usable content\"]\n",
    }).ok, true);

    assert.equal(inspectArtifactFormat({
        path: DIAGRAM_PATH,
        content: "%% authored by the ensemble\n%%{init: {'theme':'neutral'}}%%\n\nsequenceDiagram\n    A->>B: ask\n",
    }).ok, true, "comments and init directives legally precede the keyword");

    assert.equal(inspectArtifactFormat({
        path: DIAGRAM_PATH,
        content: "---\ntitle: Retrieval pipeline\n---\nstateDiagram-v2\n    [*] --> Prepare\n",
    }).ok, true, "frontmatter is mermaid's own documented configuration block, so refusing it would refuse valid mermaid");
});

test("every keyword the guard recognizes really does open a document it accepts", () => {
    for (const keyword of MERMAID_DIAGRAM_KEYWORDS) {
        const inspection = inspectArtifactFormat({ path: DIAGRAM_PATH, content: `${keyword} TD\n    A --> B\n` });
        assert.equal(inspection.ok, true, `${keyword} must be accepted; a missing keyword is a false refusal that strands real work`);
    }
});

test("a path whose extension declares no checkable format is passed through, never guessed at", () => {
    const inspection = inspectArtifactFormat({ path: "docs/notes/rag.md", content: PUBLISHED_MARKDOWN });
    assert.equal(inspection.checked, false, "a .md path is not something this guard can rule on");
    assert.equal(inspection.ok, true);
    assert.equal(declaredFormatFor("README"), null, "and neither is a path with no extension at all");
    assert.equal(declaredFormatFor("content/modules/discovery/rag.JSON"), "json", "extension matching is case-insensitive");
    assert.equal(firstDiagramLine("\n\n%% only comments\n"), null);
});

// --- the choke point: nothing reaches GitHub before the check --------------

const BASE_COMMIT = "1".repeat(40);
const PREPARED_COMMIT = "3".repeat(40);

// prepareRealCommit's real Git Data API sequence: GET ref, GET base commit,
// POST blob, POST tree, POST commit.
function commitFetchMock() {
    const calls = [];
    return {
        calls,
        impl: async (url, options) => {
            calls.push(url);
            const respond = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            if (url.endsWith("/git/ref/heads/main")) return respond(200, { object: { sha: BASE_COMMIT } });
            if (url.includes(`/git/commits/${BASE_COMMIT}`)) return respond(200, { tree: { sha: "2".repeat(40) } });
            if (url.endsWith("/git/blobs")) return respond(201, { sha: "b".repeat(40) });
            if (url.endsWith("/git/trees")) return respond(201, { sha: "t".repeat(40) });
            if (url.endsWith("/git/commits") && options?.method === "POST") return respond(201, { sha: PREPARED_COMMIT });
            throw new Error(`unexpected fetch: ${url}`);
        },
    };
}

test("prepareRealCommit refuses malformed content before the first API call, leaving no blob behind", async () => {
    const { impl, calls } = commitFetchMock();
    await assert.rejects(
        () => prepareRealCommit({
            repository: "project42dev/project42-platform", path: MODULE_PATH,
            content: PUBLISHED_MARKDOWN, token: "test-token-literal", fetchImpl: impl,
        }),
        (error) => error instanceof ArtifactFormatError && error.code === "artifact-format.json-unparsable",
    );
    assert.equal(calls.length, 0, "no ref read, no blob, no tree, no commit object: the refusal costs nothing");
});

test("prepareRealCommit still prepares a real commit when the content matches its path", async () => {
    const { impl, calls } = commitFetchMock();
    const commit = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: MODULE_PATH,
        content: JSON.stringify(learningModule(), null, 2), token: "test-token-literal", fetchImpl: impl,
    });
    assert.equal(commit.preparedCommit, PREPARED_COMMIT);
    assert.equal(commit.baseCommit, BASE_COMMIT);
    assert.equal(calls.length, 5, "the whole Git Data sequence still runs for a well-formed artifact");
});

test("the escalation path's opt-out is honoured, and is the only way past the guard", async () => {
    const { impl, calls } = commitFetchMock();
    const commit = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: MODULE_PATH,
        content: "draft the ensemble already rejected", token: "test-token-literal", fetchImpl: impl,
        validateFormat: SKIP_ARTIFACT_FORMAT_CHECK,
    });
    assert.equal(commit.preparedCommit, PREPARED_COMMIT, "a twice-blocked item still reaches a human at Gate 2");
    assert.equal(calls.length, 5);
});

// --- the lifecycle: a mismatch holds the item, it does not crash the run ----

function chunkedStage(stage, text, status = "passed") {
    const chunks = [];
    for (let index = 0; index < text.length; index += 2000) chunks.push(text.slice(index, index + 2000));
    return {
        stage, findings: chunks, outputDigest: sha256Digest(text).slice("sha256:".length), status,
        latencyMs: 500, deploymentAlias: "a", modelVersion: "v1", providerFamily: "openai",
        contractVersion: "1.0.0", inputEvidenceDigest: "0".repeat(64), costUsd: 0.01,
    };
}

function passingProposal(draftText) {
    return {
        modelStages: [
            chunkedStage("evidence-research", "sources"),
            chunkedStage("curriculum-writing", draftText),
            chunkedStage("factual-verification", "verifier: PASS"),
            chunkedStage("assessment-review", "adversary: PASS"),
            chunkedStage("accessibility-review", "human-review pending", "human-review"),
            chunkedStage("release-proposal", "COMPLETENESS.\n\nRECOMMENDATION: PUBLISH"),
        ],
    };
}

/** An item walked to gate2-ready with the Gate 1 approval a real one carries. */
async function gate2ReadyFixture(term, draftText) {
    const { store, runId } = await estate();
    const [id] = await seedGateItems(store, runId, [term]);
    await walkTo(store, runId, id, "gate2-ready");

    const proposalDigest = store.db.prepare(
        "SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = 1",
    ).get(id).proposal_digest;
    store.db.prepare(
        `INSERT INTO decision_event
          (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
           actor_immutable_id, source_repository, source_issue_number, source_comment_id,
           correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
          VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-08-14T00:00:00.000Z', '{}')`,
    ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-format:${id}`);

    const directory = mkdtempSync(join(tmpdir(), "orchard-format-"));
    const proposalRoot = join(directory, "proposals");
    mkdirSync(proposalRoot, { recursive: true });
    const file = `proposal-${id}.json`;
    writeFileSync(join(proposalRoot, file), JSON.stringify(passingProposal(draftText)));
    return { store, id, proposalRoot, file };
}

test("a Markdown draft bound for a .json module path holds the item and never touches GitHub", async () => {
    const { store, id, proposalRoot, file } = await gate2ReadyFixture("rag", PUBLISHED_MARKDOWN);
    const target = store.db.prepare("SELECT target_path FROM item_revision WHERE item_id = ? AND item_revision = 1").get(id).target_path;
    assert.match(target, /\.json$/, "the fixture reproduces the real placement: a learning item targets a .json path");

    const events = [];
    const summary = await attemptGate2Evidence({
        store, applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-08-19T00:00:00.000Z",
        env: {}, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: async () => { throw new Error("GitHub must never be called for a malformed artifact"); },
    });

    assert.equal(summary.held, 1, "the item is held");
    assert.equal(summary.prepared, 0, "and nothing is prepared for it");

    const held = events.find((entry) => entry.event === "gate2evidence.held");
    assert.ok(held, "the hold is a structured log event, not a silent skip");
    assert.equal(held.detail.code, "artifact-format.json-unparsable", "carrying the named error code");
    assert.equal(held.detail.declaredFormat, "json");
    assert.match(held.detail.contentHead, /^# Retrieval-augmented generation/, "and what the artifact actually was");

    const row = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
    assert.equal(row.current_state, "gate2-ready", "the item stays exactly where a re-authored revision can still find it");
    store.close();
});

test("one malformed item does not stop the run, and the others are still evaluated", async () => {
    const { store, id, proposalRoot, file } = await gate2ReadyFixture("vector", PUBLISHED_MARKDOWN);
    const events = [];
    const summary = await attemptGate2Evidence({
        store,
        applied: [
            { subjectId: id, from: "executing", to: "gate2-ready", file },
            { subjectId: id, from: "executing", to: "gate2-ready", file },
        ],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-08-19T00:00:00.000Z",
        env: {}, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: async () => { throw new Error("GitHub must never be called for a malformed artifact"); },
    });
    assert.equal(summary.held, 2, "both entries were evaluated; the first refusal did not abort the loop");
    store.close();
});

test("a well-formed draft gets past the format guard, and holds later for a different, honest reason", async () => {
    const { store, id, proposalRoot, file } = await gate2ReadyFixture("evaluation", JSON.stringify(learningModule({ id: "evaluation" }), null, 2));
    const events = [];
    // env is empty, so the very next precondition (a publication credential)
    // is what holds it. That is the proof the format check passed: the reason
    // moved on.
    const summary = await attemptGate2Evidence({
        store, applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-08-19T00:00:00.000Z",
        env: {}, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: async () => { throw new Error("no credential means no GitHub call"); },
    });
    assert.equal(summary.held, 1);
    const held = events.find((entry) => entry.event === "gate2evidence.held");
    assert.equal(held.detail.code, undefined, "the hold is not a format refusal");
    assert.match(held.detail.reason, /publication GitHub credential/, "it is the next precondition in line");
    store.close();
});

// --- the cause: the learning brief now asks for JSON -----------------------

const LEARNING_ITEM = { kind: "needs-creating", surface: "learning", title: "Retrieval-augmented generation", subject_id: "rag", level: "intermediate" };

test("a learning brief instructs the drafter to return one JSON object and nothing else", () => {
    const prompt = buildPrompt(LEARNING_ITEM, null, [], { pathTemplates: ["content/modules/{topic}/"], suffix: "-learn" });
    assert.match(prompt, /Return exactly ONE JSON object and nothing else/, "the instruction the surface never carried");
    assert.match(prompt, /not prose and it is not Markdown/);
    assert.match(prompt, /LearningModule schema/, "and names the schema it must conform to");
    assert.match(prompt, /no code fence, no heading, no preamble/, "which is exactly how the nine published files went wrong");
});

test("the brief names every required LearningModule field, derived from the platform schema", () => {
    const prompt = buildPrompt(LEARNING_ITEM, null, [], {});
    for (const field of [
        "id", "title", "summary", "level", "providers", "estimatedMinutes",
        "objectives", "prerequisites", "sections", "knowledgeCheck", "sources",
    ]) {
        assert.match(prompt, new RegExp(`\\b${field}\\b`), `the brief must name the required field ${field}`);
    }
    assert.match(prompt, /"beginner", "intermediate", "advanced"/, "the level enum is stated, not left to be guessed");
    assert.match(prompt, /answerIndex/, "and the knowledge check's own required shape");
    assert.match(prompt, /Omit "activity", "comparisonMatrix", "instructorScript" and "capstone"/,
        "the optional objects are validated in full when present, so a partial one is worse than none");
});

test("the learning form resolves even when the operator's surface config declares none", () => {
    assert.equal(formFor("learning", {}), "learning-module-json", "the contract surface name resolves");
    assert.equal(formFor("learn", undefined), "learning-module-json", "and so does the operator config key");
    assert.equal(formFor("guide-diagram", { form: "mermaid" }), "mermaid", "a declared form always wins");
    assert.equal(formFor("field-guide", {}), null, "a surface with no form and no default gets no form instruction");
});

test("the mermaid brief is untouched, and a visual guide still gets its own form", () => {
    const prompt = buildPrompt(
        { kind: "needs-creating", surface: "guide-diagram", title: "Retrieval pipeline", subject_id: "retrieval-pipeline" },
        null, [], { form: "mermaid" },
    );
    assert.match(prompt, /A Mermaid diagram source, valid on its own/);
    assert.doesNotMatch(prompt, /LearningModule/, "the two form instructions do not bleed into each other");
});

test("the learning acceptance criteria actually reach a learning item, under either surface spelling", () => {
    for (const surface of ["learning", "learn"]) {
        const criteria = buildAcceptanceCriteria({ ...LEARNING_ITEM, surface }, null);
        assert.ok(
            criteria.some((entry) => entry.includes("JSON.parse accepts on the first attempt")),
            `surface "${surface}" must carry the JSON criterion`,
        );
        assert.ok(
            criteria.some((entry) => entry.includes("Every required LearningModule field is present")),
            `surface "${surface}" must carry the required-field criterion`,
        );
    }
    assert.equal(surfaceCriteriaFor("nonsense").length, 0, "an unknown surface gets no criteria rather than a guess");
});

test("a module built to exactly what the brief demands passes the guard that refused the published nine", () => {
    const prompt = buildPrompt(LEARNING_ITEM, null, [], {});
    const built = learningModule();
    for (const field of Object.keys(built)) assert.match(prompt, new RegExp(`\\b${field}\\b`), `${field} is asked for`);
    assert.equal(
        inspectArtifactFormat({ path: MODULE_PATH, content: JSON.stringify(built, null, 2) }).ok,
        true,
        "the brief and the guard agree: what one asks for is what the other accepts",
    );
});
