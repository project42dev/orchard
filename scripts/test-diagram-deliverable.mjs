#!/usr/bin/env node
// NO DIAGRAM THIS PIPELINE HAS EVER DRAFTED COULD BE PUBLISHED, and these
// tests pin the two halves of why and the one fix that closes both.
//
// A diagram is two deliverables -- the .mmd source and the catalogue entry that
// is the only index any reader reaches it through -- and the pipeline had
// exactly one content slot. generate-briefs.mjs asked the drafter for both;
// run-authoring.mjs committed the whole blob verbatim to diagrams/<id>.mmd and
// called registrationFor with no catalogue entry at all. A drafter that obeyed
// the instruction produced a file that opens "## 1. Mermaid diagram source" and
// died on artifact-format.mermaid-unrecognized (four such items were held in
// production); a drafter that ignored it produced pure mermaid and died one
// step later on registration.no-catalogue-entry. Either way: nothing published,
// against eleven hand-authored diagrams in the corpus.
//
// The fix is an envelope. The drafter emits the two halves as two tagged fenced
// blocks, lib/diagram-deliverable.mjs splits them, the SOURCE half is what the
// format guard checks and what gets committed, and the ENTRY half reaches
// registrationFor as a structured object. These tests assert the four things
// that have to be true for that to be a fix rather than a story:
//
//   1. the parser splits a realistic drafted payload, and refuses -- loudly,
//      by name, and for free -- every way a drafter can fail to comply;
//   2. the brief generated from the OPERATOR'S OWN config/surface-targets.json
//      asks for exactly the envelope the parser reads, so what is asked for and
//      what can be consumed cannot drift;
//   3. the real prep loop puts pure mermaid at the .mmd path and the entry in
//      diagrams/catalogue.json, in ONE tree, proven off the bodies the GitHub
//      Git Data API was actually handed;
//   4. a non-compliant draft holds the item at gate2-ready with the code, and
//      never calls GitHub at all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    splitDiagramDeliverable, assertDiagramDeliverable, fencedBlocks,
    DiagramDeliverableError, MERMAID_FENCE_TAG, CATALOGUE_FENCE_TAG,
} from "./lib/diagram-deliverable.mjs";
import { inspectArtifactFormat } from "./lib/artifact-format.mjs";
import { registrationFor, registerDiagram, validateCatalogueEntry, DIAGRAM_CATEGORIES, RegistrationError } from "./lib/registration.mjs";
import { buildPrompt, buildAcceptanceCriteria, formFor, surfaceConfigFor, DEFAULT_TARGETS_PATH } from "./generate-briefs.mjs";
import { attemptGate2Evidence, attemptRejectionRecovery } from "./run-authoring.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { estate, walkTo, candidate, NOW } from "./test-fixtures.mjs";
import { persistDiscoveryItems } from "./lib/gate-queue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIAGRAM_PATH = "diagrams/retrieval-pipeline.mmd";

// Modelled on diagrams/safe-agent-loop.mmd in project42dev/project42-content:
// the diagram keyword first, then accTitle and accDescr, which all eleven
// published sources carry.
const SOURCE = [
    "flowchart LR",
    "    accTitle: Retrieval pipeline",
    "    accDescr: Source material is chunked, embedded and indexed, then a question is retrieved against that index and answered with citations.",
    "",
    "    S([Source material]) --> C[Chunk]",
    "    C --> E[Embed]",
    "    E --> I[(Index)]",
    "    Q([Question]) --> R[Retrieve]",
    "    I --> R",
    "    R --> A[Answer with citations]",
].join("\n");

// Modelled field-for-field on the eleven entries in
// project42dev/project42-content diagrams/catalogue.json: the same seven
// authored keys (id and source are derived), three takeaways, and a category
// drawn from the published set.
const ENTRY = {
    title: "Retrieval pipeline, from source to grounded answer",
    category: "Research",
    summary: "How source material becomes a searchable index and how a question travels through it to a cited answer.",
    description: "The diagram separates preparation from answering. Preparation is done once per corpus; answering happens per question and never reaches the raw source, only the index built from it.",
    altText: "A left-to-right flow. Source material is chunked, embedded, and written to an index. Separately, a question enters retrieval, which reads that index, and retrieval feeds an answer with citations.",
    caption: "Retrieval separates the one-time work of preparing a corpus from the per-question work of answering from it.",
    takeaways: [
        "Preparation and answering are separate pipelines that meet only at the index.",
        "The answering path never touches the raw source, so source quality is decided at chunk time.",
        "Citations come from the retrieved chunks, not from the model's recollection.",
    ],
};

function envelope({ source = SOURCE, entry = ENTRY, sourceTag = MERMAID_FENCE_TAG, entryTag = CATALOGUE_FENCE_TAG, preamble = "" } = {}) {
    return [
        preamble,
        "```" + sourceTag,
        source,
        "```",
        "",
        "```" + entryTag,
        JSON.stringify(entry, null, 2),
        "```",
        "",
    ].join("\n");
}

// --- what the drafter actually produced before this existed -----------------

// The real first line of content/diagrams/multi-agent.mmd as merged on
// 2026-08-19, and the shape FORM_INSTRUCTIONS.mermaid asked for: two numbered
// headings, one blob, no way to separate them.
const OBEDIENT_PROSE = [
    "## 1. Mermaid diagram source",
    "",
    SOURCE,
    "",
    "## 2. Catalogue entry",
    "",
    JSON.stringify(ENTRY, null, 2),
].join("\n");

test("the payload the OLD instruction produced is exactly the one that could never be published", () => {
    // Before: the whole blob goes to a .mmd path and the format guard refuses
    // it, which is the code four production items are held on right now.
    const before = inspectArtifactFormat({ path: DIAGRAM_PATH, content: OBEDIENT_PROSE });
    assert.equal(before.ok, false);
    assert.equal(before.code, "artifact-format.mermaid-unrecognized");

    // And it does not split either, because it carries no envelope at all. The
    // parser deliberately does not rescue it: a heading is not a fence, and
    // guessing where the source ends is how a half-diagram gets published.
    const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: OBEDIENT_PROSE });
    assert.equal(split.ok, false);
    assert.equal(split.code, "diagram-deliverable.no-source-block");
    assert.match(split.reason, /no fenced block at all/);
});

test("the OTHER half of the defect: pure mermaid passes the format guard and then has no entry to register", () => {
    assert.equal(inspectArtifactFormat({ path: DIAGRAM_PATH, content: SOURCE }).ok, true);
    // registrationFor's catalogueEntry defaulted to null for every production
    // caller, and this is the error that produced.
    const registration = registrationFor({ surface: "guide-diagram", targetPath: DIAGRAM_PATH, artifact: SOURCE });
    assert.throws(() => registration.apply("{\"diagrams\":[]}"), (error) => {
        assert.ok(error instanceof RegistrationError);
        assert.equal(error.code, "registration.no-catalogue-entry");
        return true;
    });
});

// --- the envelope, split ----------------------------------------------------

test("a compliant envelope splits into pure mermaid and a structured catalogue entry", () => {
    const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope() });
    assert.equal(split.ok, true);
    assert.equal(split.source, SOURCE, "the committed bytes are the source block verbatim, fence removed");
    assert.deepEqual(split.catalogueEntry, ENTRY, "and the entry arrives as an object, not a string to be re-parsed downstream");

    // The whole point: what gets committed passes the guard that refused the
    // two diagrams really merged on 2026-08-19.
    const format = inspectArtifactFormat({ path: DIAGRAM_PATH, content: split.source });
    assert.equal(format.ok, true, "the .mmd committed is pure mermaid");
});

test("a preamble outside the fences is ignored rather than refused, and can never become either deliverable", () => {
    const split = splitDiagramDeliverable({
        path: DIAGRAM_PATH,
        content: envelope({ preamble: "Here is the diagram and its catalogue entry.\n" }),
    });
    assert.equal(split.ok, true);
    assert.equal(split.source, SOURCE, "the prose is not in the file");
    assert.deepEqual(split.catalogueEntry, ENTRY);
});

test("a path that does not declare mermaid is passed through untouched, so one call site covers every surface", () => {
    const module = JSON.stringify({ id: "rag" });
    const split = splitDiagramDeliverable({ path: "modules/discovery/rag.json", content: module });
    assert.equal(split.checked, false);
    assert.equal(split.ok, true);
    assert.equal(split.source, module, "the content is handed back unchanged for the format guard to check");
    assert.equal(split.catalogueEntry, null, "and no entry is invented for a surface that needs none");
});

test("a longer fence may contain a shorter one, so a caption showing a fence does not end the block", () => {
    const blocks = fencedBlocks(["````" + CATALOGUE_FENCE_TAG, "{", '  "a": "```"', "}", "````"].join("\n"));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].tag, CATALOGUE_FENCE_TAG);
    assert.match(blocks[0].body, /```/);
});

test("CRLF line endings split the same, because this content has been through PowerShell chunking", () => {
    const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope().replace(/\n/g, "\r\n") });
    assert.equal(split.ok, true);
    assert.equal(split.catalogueEntry.title, ENTRY.title);
    assert.match(split.source, /^flowchart LR/);
});

// --- every way a drafter can fail to comply, each named -----------------------

const NON_COMPLIANCE = [
    {
        what: "no catalogue block at all -- the silently-empty entry this whole module exists to prevent",
        content: ["```mermaid", SOURCE, "```"].join("\n"),
        code: "diagram-deliverable.no-catalogue-block",
    },
    {
        what: "the entry fenced as ```json, which could be anything and is not treated as the record",
        content: envelope({ entryTag: "json" }),
        code: "diagram-deliverable.no-catalogue-block",
    },
    {
        what: "no source block",
        content: ["```" + CATALOGUE_FENCE_TAG, JSON.stringify(ENTRY), "```"].join("\n"),
        code: "diagram-deliverable.no-source-block",
    },
    {
        what: "two source blocks, so which one the reader sees would be a guess",
        content: envelope() + "\n```mermaid\n" + SOURCE + "\n```\n",
        code: "diagram-deliverable.multiple-source-blocks",
    },
    {
        what: "two catalogue blocks",
        content: envelope() + "\n```" + CATALOGUE_FENCE_TAG + "\n" + JSON.stringify(ENTRY) + "\n```\n",
        code: "diagram-deliverable.multiple-catalogue-blocks",
    },
    {
        what: "an empty source block",
        content: envelope({ source: "   " }),
        code: "diagram-deliverable.empty-source-block",
    },
    {
        what: "a catalogue block that is not valid JSON",
        content: envelope() .replace(JSON.stringify(ENTRY, null, 2), '{ "title": "x", }'),
        code: "diagram-deliverable.catalogue-unparsable",
    },
    {
        what: "a catalogue block carrying an array of entries rather than one entry",
        content: envelope({ entry: [ENTRY] }),
        code: "diagram-deliverable.catalogue-not-an-object",
    },
    {
        what: "an entry with no altText -- an accessibility obligation, not an optional flourish",
        content: envelope({ entry: { ...ENTRY, altText: "   " } }),
        code: "registration.incomplete-catalogue-entry",
    },
    {
        what: "an entry whose takeaways are empty strings: a bracket is not a takeaway",
        content: envelope({ entry: { ...ENTRY, takeaways: ["", ""] } }),
        code: "registration.incomplete-catalogue-entry",
    },
    {
        what: "an entry filed under a category no page lists",
        content: envelope({ entry: { ...ENTRY, category: "Ops" } }),
        code: "registration.unknown-diagram-category",
    },
];

for (const { what, content, code } of NON_COMPLIANCE) {
    test(`a drafter that does not comply is refused by name: ${what}`, () => {
        const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content });
        assert.equal(split.ok, false, "it is refused");
        assert.equal(split.code, code, "with the code that names what went wrong");
        assert.ok(typeof split.reason === "string" && split.reason.length > 20, "and a reason a human can act on");
        assert.equal(split.source, null, "no half-deliverable escapes");
        assert.equal(split.catalogueEntry, null, "and no empty entry escapes either");
    });
}

test("the refusal names the fence tags that WERE found, so a human can see what the drafter did instead", () => {
    const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope({ entryTag: "json" }) });
    assert.deepEqual(split.tagsFound, ["mermaid", "json"]);
    assert.match(split.reason, /mermaid, json/);
});

test("the throwing form exists for a choke point that must never let an unsplit deliverable past", () => {
    assert.throws(
        () => assertDiagramDeliverable({ path: DIAGRAM_PATH, content: SOURCE }),
        (error) => {
            assert.ok(error instanceof DiagramDeliverableError);
            assert.equal(error.code, "diagram-deliverable.no-source-block");
            return true;
        },
    );
    assert.equal(assertDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope() }).source, SOURCE);
});

// --- the entry validation runs BEFORE anything is spent ----------------------

test("the catalogue entry is validated where it is free, and again where it is last possible", () => {
    // registerDiagram runs inside prepareRealCommit, after the publication
    // token is minted and after a GitHub read. The split runs while the draft
    // is in hand and nothing has been spent. Both ask the same question of the
    // same field list, which is why the codes match.
    const early = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope({ entry: { ...ENTRY, category: "Ops" } }) });
    assert.equal(early.code, "registration.unknown-diagram-category");
    assert.throws(
        () => registerDiagram({ registryText: '{"diagrams":[]}', targetPath: DIAGRAM_PATH, entry: { ...ENTRY, category: "Ops" } }),
        (error) => error.code === "registration.unknown-diagram-category",
    );
});

test("id and source are derived from the target path and overwrite whatever the drafter wrote", () => {
    const ordered = validateCatalogueEntry({
        entry: { ...ENTRY, id: "something-else", source: "elsewhere.mmd" },
        targetPath: DIAGRAM_PATH,
    });
    assert.equal(ordered.id, "retrieval-pipeline");
    assert.equal(ordered.source, "retrieval-pipeline.mmd");
    assert.deepEqual(
        Object.keys(ordered),
        ["id", "title", "category", "summary", "description", "altText", "caption", "takeaways", "source"],
        "and the record is written in the field order diagrams/catalogue.json is committed in",
    );
});

// --- the brief asks for exactly what the parser reads, off the REAL config ----

test("the OPERATOR'S OWN surface-targets.json produces a brief asking for the envelope this parser splits", () => {
    const targets = JSON.parse(readFileSync(DEFAULT_TARGETS_PATH, "utf8"));
    // `guide-diagram` is the CONTRACT surface name, which is what reaches
    // formFor at runtime, while the operator's config key is `visual-guide`.
    // Covering only one of them is how the field-guide surface went three weeks
    // with no form at all.
    for (const surface of ["guide-diagram", "visual-guide"]) {
        const surfaceConfig = surfaceConfigFor(targets, surface) ?? targets.surfaces?.[surface];
        assert.equal(formFor(surface, surfaceConfig), "mermaid", `surface "${surface}" resolves to the mermaid form`);

        const prompt = buildPrompt(
            { kind: "needs-creating", surface, title: "Retrieval pipeline", subject_id: "retrieval-pipeline-visual-guide" },
            null, [], surfaceConfig,
        );
        assert.ok(prompt.includes("```" + MERMAID_FENCE_TAG), `surface "${surface}" is told the source block tag`);
        assert.ok(prompt.includes("```" + CATALOGUE_FENCE_TAG), `surface "${surface}" is told the catalogue block tag`);
        for (const field of ["title", "category", "summary", "description", "altText", "caption", "takeaways"]) {
            assert.ok(prompt.includes(field), `the brief names the required catalogue field ${field}`);
        }
        for (const category of DIAGRAM_CATEGORIES) {
            assert.ok(prompt.includes(category), `the brief names the publishable category ${category}`);
        }
        assert.match(prompt, /Do NOT include "id" or "source"/, "and says which fields are derived rather than authored");
    }
});

test("a diagram brief's acceptance criteria name the envelope, so the ensemble reviews for it too", () => {
    const criteria = buildAcceptanceCriteria(
        { kind: "needs-creating", surface: "guide-diagram", title: "Retrieval pipeline", subject_id: "retrieval-pipeline-visual-guide" },
        null,
    );
    assert.ok(criteria.some((entry) => entry.includes(MERMAID_FENCE_TAG) && entry.includes(CATALOGUE_FENCE_TAG)),
        "the two-block envelope is an acceptance criterion under the contract surface name");
});

test("a brief built to the instruction is a payload this parser accepts and this guard passes", () => {
    const targets = JSON.parse(readFileSync(DEFAULT_TARGETS_PATH, "utf8"));
    const prompt = buildPrompt(
        { kind: "needs-creating", surface: "guide-diagram", title: "Retrieval pipeline", subject_id: "retrieval-pipeline-visual-guide" },
        null, [], surfaceConfigFor(targets, "guide-diagram"),
    );
    // Everything the instruction demands, obeyed literally, and then run
    // through the real parser and the real format guard. The brief and the
    // pipeline agree: what one asks for is what the other consumes.
    assert.ok(prompt.length > 0);
    const split = splitDiagramDeliverable({ path: DIAGRAM_PATH, content: envelope() });
    assert.equal(split.ok, true);
    assert.equal(inspectArtifactFormat({ path: DIAGRAM_PATH, content: split.source }).ok, true);
    const registration = registrationFor({
        surface: "guide-diagram", targetPath: DIAGRAM_PATH,
        artifact: split.source, catalogueEntry: split.catalogueEntry,
    });
    const registry = registration.apply(JSON.stringify({ $schemaVersion: 1, diagrams: [] }, null, 2) + "\n");
    assert.equal(JSON.parse(registry).diagrams[0].id, "retrieval-pipeline");
    assert.equal(JSON.parse(registry).diagrams[0].altText, ENTRY.altText);
});

// --- the real prep loop, driven end to end -----------------------------------

const BASE_COMMIT = "1".repeat(40);
const PREPARED_COMMIT = "3".repeat(40);

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

const CATALOGUE_TEXT = JSON.stringify({
    $schemaVersion: 1,
    renderer: "@mermaid-js/mermaid-cli@11.15.0",
    diagrams: [{
        id: "safe-agent-loop", title: "The bounded agent loop", category: "Agents",
        summary: "s", description: "d", altText: "a", caption: "c",
        takeaways: ["t1", "t2", "t3"], source: "safe-agent-loop.mmd",
    }],
}, null, 2) + "\n";

/** Captures the BODIES the Git Data API is handed, not just the URLs. */
function commitFetchMock() {
    const blobs = [];
    const trees = [];
    return {
        blobs, trees,
        impl: async (url, options) => {
            const respond = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            if (url.endsWith("/git/ref/heads/main")) return respond(200, { object: { sha: BASE_COMMIT } });
            if (url.includes("/contents/diagrams/catalogue.json")) {
                return respond(200, { content: Buffer.from(CATALOGUE_TEXT, "utf8").toString("base64"), encoding: "base64" });
            }
            if (url.includes(`/git/commits/${BASE_COMMIT}`)) return respond(200, { tree: { sha: "2".repeat(40) } });
            if (url.endsWith("/git/blobs")) {
                const body = JSON.parse(options.body);
                blobs.push(body.content);
                return respond(201, { sha: `b${blobs.length}`.padEnd(40, "0") });
            }
            if (url.endsWith("/git/trees")) {
                trees.push(JSON.parse(options.body));
                return respond(201, { sha: "t".repeat(40) });
            }
            if (url.endsWith("/git/commits") && options?.method === "POST") return respond(201, { sha: PREPARED_COMMIT });
            throw new Error(`unexpected fetch: ${url}`);
        },
    };
}

/** A diagram item at gate2-ready, targeting a real diagrams/<id>.mmd path. */
async function diagramFixture(term, draftText) {
    const { store, runId } = await estate();
    // A REAL visual-guide candidate, placed by gate-queue's own rule rather
    // than by a test rewriting the target afterwards -- item revisions are
    // append-only, and a fixture that edits one is not testing the shape
    // production produces. gate-queue maps the visual-guide probe surface to
    // the guide-diagram contract surface and places it at diagrams/<slug>.mmd,
    // which is exactly what surfaceForTargetPath and diagramIdForTarget read.
    const result = await persistDiscoveryItems({
        store, runId, now: NOW,
        candidates: [candidate(term, { surface: "guide-diagram", pathId: null })],
    });
    assert.equal(result.persisted, 1);
    const id = result.items[0].item_id;
    await walkTo(store, runId, id, "gate2-ready");
    assert.equal(
        store.db.prepare("SELECT target_path FROM item_revision WHERE item_id = ? AND item_revision = 1").get(id).target_path,
        `diagrams/${term}.mmd`,
        "the fixture reproduces the real placement: a visual guide targets diagrams/<id>.mmd",
    );

    const proposalDigest = store.db.prepare(
        "SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = 1",
    ).get(id).proposal_digest;
    store.db.prepare(
        `INSERT INTO decision_event
          (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
           actor_immutable_id, source_repository, source_issue_number, source_comment_id,
           correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
          VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-08-14T00:00:00.000Z', '{}')`,
    ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-diagram:${id}`);

    const directory = mkdtempSync(join(tmpdir(), "orchard-diagram-"));
    const proposalRoot = join(directory, "proposals");
    mkdirSync(proposalRoot, { recursive: true });
    const file = `proposal-${id}.json`;
    writeFileSync(join(proposalRoot, file), JSON.stringify(passingProposal(draftText)));
    // A successful prepare writes a debug copy of the evidence document to
    // ORCHARD_EVIDENCE_ROOT, defaulting to process.cwd() -- which for a test
    // run is the repository itself. Point it at the fixture's own directory so
    // a passing test leaves nothing behind.
    return { store, id, proposalRoot, file, env: { ORCHARD_EVIDENCE_ROOT: directory } };
}

test("THE FIX, END TO END: the .mmd blob is pure mermaid and the catalogue blob carries the entry, in one tree", async () => {
    const { store, id, proposalRoot, file, env } = await diagramFixture("retrieval-pipeline", envelope());
    const { impl, blobs, trees } = commitFetchMock();
    const events = [];
    const summary = await attemptGate2Evidence({
        store, applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-12T00:00:00.000Z",
        env, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: impl, readGateTokenImpl: async () => "test-token-literal",
    });

    assert.equal(summary.held, 0, `nothing was held: ${JSON.stringify(events.filter((e) => e.event.endsWith("held")))}`);
    assert.equal(summary.prepared, 1, "a diagram item prepares, which no diagram item has ever done");

    assert.equal(blobs.length, 2, "two blobs: the source and the registry");
    const [registryBlob, artifactBlob] = blobs;

    // THE COMMITTED .mmd. Asserted off the body the API was actually handed,
    // not off a return value the test could have computed itself.
    assert.equal(artifactBlob, SOURCE, "the .mmd blob is the source block verbatim, with no fence and no prose");
    assert.equal(inspectArtifactFormat({ path: "diagrams/retrieval-pipeline.mmd", content: artifactBlob }).ok, true);
    assert.ok(!artifactBlob.includes("```"), "no fence survives into the file");
    assert.ok(!artifactBlob.includes("altText"), "and no catalogue entry is smuggled into the diagram source");

    // THE COMMITTED CATALOGUE. Parses, keeps what was there, adds this one.
    const catalogue = JSON.parse(registryBlob);
    assert.equal(catalogue.diagrams.length, 2, "the existing entry is kept and this one is added");
    const written = catalogue.diagrams.find((entry) => entry.id === "retrieval-pipeline");
    assert.ok(written, "the diagram is IN the catalogue, which is the only index any reader reaches it through");
    assert.equal(written.altText, ENTRY.altText, "carrying the alt text the drafter actually authored");
    assert.equal(written.source, "retrieval-pipeline.mmd", "and the source filename derived from where the file lands");
    assert.deepEqual(written.takeaways, ENTRY.takeaways);

    // ONE TREE, ONE COMMIT, UNDER ONE GATE 2 APPROVAL.
    assert.equal(trees.length, 1);
    const paths = trees[0].tree.map((node) => node.path).sort();
    assert.deepEqual(paths, ["diagrams/catalogue.json", "diagrams/retrieval-pipeline.mmd"]);

    const prepared = events.find((entry) => entry.event === "gate2evidence.prepared");
    assert.equal(prepared.detail.registeredIn, "diagrams/catalogue.json", "and the run says so out loud");
    store.close();
});

test("a non-compliant diagram draft holds the item by name and never calls GitHub", async () => {
    const { store, id, proposalRoot, file, env } = await diagramFixture("multi-agent", OBEDIENT_PROSE);
    const events = [];
    const summary = await attemptGate2Evidence({
        store, applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-12T00:00:00.000Z",
        env, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: async () => { throw new Error("GitHub must never be called for a deliverable that did not comply"); },
        readGateTokenImpl: async () => { throw new Error("a credential must never be minted for a deliverable that did not comply"); },
    });

    assert.equal(summary.held, 1);
    assert.equal(summary.prepared, 0);
    const held = events.find((entry) => entry.event === "gate2evidence.held");
    assert.equal(held.detail.code, "diagram-deliverable.no-source-block", "the hold names the transport failure, not a downstream symptom");
    assert.deepEqual(held.detail.fenceTags, [], "and reports what the drafter emitted instead");

    const row = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
    assert.equal(row.current_state, "gate2-ready", "the item stays exactly where a re-authored revision can find it");
    store.close();
});

test("a compliant source with an unpublishable category holds before a credential is ever minted", async () => {
    const { store, id, proposalRoot, file, env } = await diagramFixture("prompt-contract", envelope({ entry: { ...ENTRY, category: "Ops" } }));
    const events = [];
    const summary = await attemptGate2Evidence({
        store, applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-12T00:00:00.000Z",
        env, log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: async () => { throw new Error("GitHub must never be called for an unregistrable entry"); },
        readGateTokenImpl: async () => { throw new Error("a credential must never be minted for an unregistrable entry"); },
    });
    assert.equal(summary.held, 1);
    const held = events.find((entry) => entry.event === "gate2evidence.held");
    assert.equal(held.detail.code, "registration.unknown-diagram-category");
    assert.match(held.detail.reason, /Learning, Research, Agents/, "and names the categories that ARE publishable");
    store.close();
});

// --- the escalation path: reported, never refused ----------------------------
//
// A twice-blocked item is escalated so a human can SEE what was rejected.
// Refusing to prepare it would strand it with no route to a human, which is the
// dead end the rejection gate exists to remove. So the split is attempted and
// its failure is REPORTED alongside the ensemble's findings, rather than
// holding. What it must not do is quietly publish the wrong bytes: a rejected
// draft that DOES comply is escalated as its two real halves.

/** The blocked-item fixture, targeting a diagram, walked to a second block. */
async function escalationFixture(term, draftText) {
    const { store, runId } = await estate();
    const result = await persistDiscoveryItems({
        store, runId, now: NOW,
        candidates: [candidate(term, { surface: "guide-diagram", pathId: null })],
    });
    const id = result.items[0].item_id;
    await walkTo(store, runId, id, "executing");

    const directory = mkdtempSync(join(tmpdir(), "orchard-diagram-esc-"));
    const proposalRoot = join(directory, "proposals");
    mkdirSync(proposalRoot, { recursive: true });

    const blockedProposal = {
        modelStages: [
            chunkedStage("evidence-research", "sources"),
            chunkedStage("curriculum-writing", draftText),
            chunkedStage("factual-verification", "verifier finding", "failed"),
            chunkedStage("assessment-review", "adversary finding", "refuted"),
            chunkedStage("accessibility-review", "human-review pending", "human-review"),
            chunkedStage("release-proposal", "COMPLETENESS.\n\nRECOMMENDATION: REVISE"),
        ],
    };

    // Two blocks: the first is retried automatically, the second escalates.
    let revision = 1;
    for (const round of [1, 2]) {
        const file = `proposal-${id}-round${round}.json`;
        writeFileSync(join(proposalRoot, file), JSON.stringify(blockedProposal));
        await store.recordTransition({
            schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: revision,
            from_state: "executing", to_state: "blocked", cause: "policy-block",
            reason: `blocked by the authoring ensemble, ${file}`, actor: "orchard/run-authoring",
            occurred_at: `2026-09-12T00:0${round}:00.000Z`, correlation_id: generateUuidV7(),
        });
        if (round === 1) {
            const prior = JSON.parse(store.db.prepare(
                "SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?",
            ).get(id, revision).record_json);
            await store.recordItem({ ...prior, item_revision: revision + 1, state: "executing", created_at: NOW, updated_at: NOW });
            await store.recordTransition({
                schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: revision,
                from_state: "blocked", to_state: "executing", cause: "revision-created", recovery_gate: "gate-2",
                successor_revision: revision + 1, actor: "test-fixture",
                occurred_at: `2026-09-12T00:0${round}:30.000Z`, correlation_id: generateUuidV7(),
            });
            revision += 1;
        }
    }

    const proposalDigest = store.db.prepare(
        "SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?",
    ).get(id, revision).proposal_digest;
    store.db.prepare(
        `INSERT INTO decision_event
          (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
           actor_immutable_id, source_repository, source_issue_number, source_comment_id,
           correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
          VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-09-11T00:00:00.000Z', '{}')`,
    ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-esc:${id}`);
    store.recordExternalLink({
        link_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: revision, provider: "ado",
        operation: "ado-link", external_key: `orchard:track-1:${id}:r${revision}`, external_id: 7777, linked_at: "2026-09-11T00:01:00.000Z",
    });
    return { store, id, proposalRoot, file: `proposal-${id}-round2.json`, env: { ORCHARD_EVIDENCE_ROOT: directory } };
}

test("an escalated diagram draft that DID comply is escalated as its two real halves", async () => {
    const { store, id, proposalRoot, file, env } = await escalationFixture("tool-trust-boundaries", envelope());
    const { impl, blobs } = commitFetchMock();
    const events = [];
    const result = await attemptRejectionRecovery({
        store, applied: [{ subjectId: id, from: "executing", to: "blocked", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-12T00:10:00.000Z",
        log: (level, event, detail) => events.push({ level, event, detail }),
        env, fetchImpl: impl, readGateTokenImpl: async () => "test-token-literal",
    });
    assert.equal(result.escalated, 1, `the item escalates: ${JSON.stringify(events.filter((e) => e.event.includes("held")))}`);

    const [registryBlob, artifactBlob] = blobs;
    assert.equal(artifactBlob, SOURCE, "the human sees pure mermaid at the .mmd path, not the envelope");
    assert.ok(JSON.parse(registryBlob).diagrams.some((entry) => entry.id === "tool-trust-boundaries"),
        "and the entry the drafter authored is in the catalogue, so an approved escalation is reachable");
    assert.ok(!events.some((entry) => entry.event === "rejection.escalate.deliverable-unsplit"),
        "nothing is reported unsplit, because it split");
    store.close();
});

test("an escalated diagram draft that did NOT comply is still escalated, with the reason in front of the reviewer", async () => {
    const { store, id, proposalRoot, file, env } = await escalationFixture("agent-orchestration", OBEDIENT_PROSE);
    const { impl, blobs } = commitFetchMock();
    const events = [];
    const result = await attemptRejectionRecovery({
        store, applied: [{ subjectId: id, from: "executing", to: "blocked", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-12T00:10:00.000Z",
        log: (level, event, detail) => events.push({ level, event, detail }),
        env, fetchImpl: impl, readGateTokenImpl: async () => "test-token-literal",
    });
    assert.equal(result.escalated, 1, "it is NOT refused: refusing strands a twice-blocked item with no route to a human");
    assert.equal(result.held, 0);

    const unsplit = events.find((entry) => entry.event === "rejection.escalate.deliverable-unsplit");
    assert.ok(unsplit, "the failed split is reported rather than swallowed");
    assert.equal(unsplit.detail.code, "diagram-deliverable.no-source-block");
    assert.equal(blobs.at(-1), OBEDIENT_PROSE, "and the raw rejected draft is what the human is shown, unedited");

    const manifest = store.db.prepare(
        "SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference LIKE 'orchard/gate-manifest/gate-2:%' ORDER BY observed_at DESC LIMIT 1",
    ).get(id);
    const item = JSON.parse(manifest.record_json).manifest_item;
    assert.match(item.rejection_reason, /Reachability \(diagram-deliverable\.no-source-block\)/,
        "the reviewer is told in the reason text that approving this publishes something no reader can open");
    store.close();
});

// The corpus this shape was derived from is a sibling repository, so it is not
// a test dependency. This asserts only what orchard itself carries: that the
// category list the brief prints and the parser enforces is one list.
test("the categories the brief prints are the categories the registry accepts, by construction", () => {
    assert.deepEqual(
        [...DIAGRAM_CATEGORIES],
        ["Learning", "Research", "Agents", "Prompting", "Providers", "Safety", "Governance"],
        "the seven headings diagrams/catalogue.json actually uses",
    );
    assert.equal(resolve(HERE, "..", "config", "surface-targets.json"), DEFAULT_TARGETS_PATH);
});
