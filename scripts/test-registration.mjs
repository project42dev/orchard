#!/usr/bin/env node
// Found live 2026-08-19, on the first publication run that ever merged
// anything. Nine items reported published; every one of them was unreachable.
//
//   - Seven modules landed in content/modules/discovery/. A module page is
//     served at /learn/<pathId>/<moduleId>, and no learning path listed any of
//     them, so not one of the seven had a URL.
//   - Two diagrams landed in content/diagrams/. The sites read
//     content/diagrams/catalogue.json to know a diagram exists, and neither was
//     in it: 13 .mmd files on disk, 11 registered.
//
// Nothing in the pipeline had ever written a registry entry. These tests pin
// the rule that closes it: the registry entry rides in the same tree, in the
// same commit, under the same Gate 2 approval, and an item whose entry cannot
// be built holds with a reason instead of publishing half of itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    RegistrationError, registrationFor, surfaceForTargetPath, learningPathIdForTarget,
    diagramIdForTarget, registerLearningModule, registerDiagram, DIAGRAM_CATEGORIES,
} from "./lib/registration.mjs";
import { prepareRealCommit } from "./lib/prepare-gate2-evidence.mjs";

const MODULE_PATH = "content/modules/discovery/rag.json";
const DIAGRAM_PATH = "content/diagrams/retrieval-pipeline.mmd";

const CATALOG = JSON.stringify({
    schemaVersion: 1,
    paths: [
        { id: "ai-foundations", title: "AI Foundations", moduleIds: ["what-ai-does"] },
        { id: "discovery", title: "Newly Discovered Topics", moduleIds: [] },
    ],
    modules: [],
}, null, 2) + "\n";

const CATALOGUE = JSON.stringify({
    $schemaVersion: 1,
    renderer: "@mermaid-js/mermaid-cli@11.15.0",
    diagrams: [{ id: "safe-agent-loop", title: "The bounded agent loop", category: "Agents", source: "safe-agent-loop.mmd" }],
}, null, 2) + "\n";

const ENTRY = {
    title: "Retrieval pipeline, from source to grounded answer",
    category: "Research",
    summary: "How source material becomes searchable evidence and how a question moves through retrieval to a grounded answer.",
    description: "The diagram separates preparation from answering.",
    altText: "Flowchart moving from left to right through two sections.",
    caption: "A grounded answer is the end of a traceable evidence path.",
    takeaways: ["Retrieval and answer composition are distinct stages."],
};

const learningModule = (id = "rag") => JSON.stringify({ id, title: "Retrieval-augmented generation", level: "intermediate" });

// --- reading the surface off the path, rather than off a second column ------

test("the surface is read from the target path, so it cannot disagree with where the file lands", () => {
    assert.equal(surfaceForTargetPath(MODULE_PATH), "learning");
    assert.equal(surfaceForTargetPath("content/resources/discovery/prompt-injection.json"), "guide");
    assert.equal(surfaceForTargetPath(DIAGRAM_PATH), "guide-diagram");
    assert.throws(() => surfaceForTargetPath("docs/notes.md"), (error) => error.code === "registration.unrecognized-target");
});

test("the learning path is the directory the module is published into, which is the platform's own layout", () => {
    assert.equal(learningPathIdForTarget(MODULE_PATH), "discovery");
    assert.equal(learningPathIdForTarget("content/modules/ai-foundations/what-ai-does.json"), "ai-foundations");
    assert.throws(() => learningPathIdForTarget("content/modules/loose.json"), (error) => error.code === "registration.unrecognized-module-path");
});

test("the diagram id and its catalogue source both come from the one target path", () => {
    assert.deepEqual(diagramIdForTarget(DIAGRAM_PATH), { id: "retrieval-pipeline", source: "retrieval-pipeline.mmd" });
    assert.throws(() => diagramIdForTarget("content/diagrams/nested/x.mmd"), (error) => error.code === "registration.unrecognized-diagram-path");
});

// --- a module joins the path that gives it a URL ---------------------------

test("a module is added to the learning path it is published into, and the other paths are untouched", () => {
    const next = JSON.parse(registerLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, artifact: learningModule() }));
    assert.deepEqual(next.paths.find((p) => p.id === "discovery").moduleIds, ["rag"]);
    assert.deepEqual(next.paths.find((p) => p.id === "ai-foundations").moduleIds, ["what-ai-does"], "an unrelated path is not rewritten");
    assert.equal(next.schemaVersion, 1, "every other field of the catalog survives");
});

test("registering the same module twice returns the registry byte-for-byte unchanged", () => {
    const once = registerLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, artifact: learningModule() });
    const twice = registerLearningModule({ registryText: once, targetPath: MODULE_PATH, artifact: learningModule() });
    assert.equal(twice, once, "a re-prepared revision must not add a duplicate id or a spurious diff at Gate 2");
});

test("a module published into a path that does not exist is refused, and the refusal lists the paths that do", () => {
    assert.throws(
        () => registerLearningModule({ registryText: CATALOG, targetPath: "content/modules/nowhere/rag.json", artifact: learningModule() }),
        (error) => {
            assert.equal(error.code, "registration.no-such-path");
            assert.match(error.message, /ai-foundations, discovery/, "a reviewer should not have to go and look them up");
            return true;
        },
    );
});

test("a module with no id cannot be listed by anything, and says so", () => {
    assert.throws(
        () => registerLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, artifact: JSON.stringify({ title: "no id here" }) }),
        (error) => error.code === "registration.artifact-has-no-id",
    );
    assert.throws(
        () => registerLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, artifact: "# a markdown file, like the seven that shipped" }),
        (error) => error.code === "registration.artifact-unparsable",
    );
});

test("a catalog that is absent or unreadable on the base commit is refused rather than replaced", () => {
    assert.throws(
        () => registerLearningModule({ registryText: "", targetPath: MODULE_PATH, artifact: learningModule() }),
        (error) => error.code === "registration.registry-missing",
    );
    assert.throws(
        () => registerLearningModule({ registryText: "{ not json", targetPath: MODULE_PATH, artifact: learningModule() }),
        (error) => error.code === "registration.registry-unparsable",
    );
});

// --- a diagram joins the catalogue that makes it visible -------------------

test("a diagram with no authored catalogue entry holds, because a .mmd nobody lists reaches nobody", () => {
    assert.throws(
        () => registerDiagram({ registryText: CATALOGUE, targetPath: DIAGRAM_PATH, entry: null }),
        (error) => {
            assert.equal(error.code, "registration.no-catalogue-entry");
            assert.match(error.message, /retrieval-pipeline\.mmd/);
            return true;
        },
    );
});

test("a diagram entry is appended with its id and source taken from the target path", () => {
    const next = JSON.parse(registerDiagram({ registryText: CATALOGUE, targetPath: DIAGRAM_PATH, entry: ENTRY }));
    assert.equal(next.diagrams.length, 2);
    const added = next.diagrams.at(-1);
    assert.equal(added.id, "retrieval-pipeline");
    assert.equal(added.source, "retrieval-pipeline.mmd", "the entry points at the file actually being committed");
    assert.deepEqual(Object.keys(added), ["id", "title", "category", "summary", "description", "altText", "caption", "takeaways", "source"]);
    assert.equal(next.renderer, "@mermaid-js/mermaid-cli@11.15.0", "the catalogue's own fields survive");
});

test("re-publishing a diagram replaces its entry instead of adding a second one", () => {
    const once = registerDiagram({ registryText: CATALOGUE, targetPath: DIAGRAM_PATH, entry: ENTRY });
    const revised = JSON.parse(registerDiagram({ registryText: once, targetPath: DIAGRAM_PATH, entry: { ...ENTRY, caption: "A revised caption." } }));
    assert.equal(revised.diagrams.length, 2);
    assert.equal(revised.diagrams.at(-1).caption, "A revised caption.");
    assert.equal(registerDiagram({ registryText: once, targetPath: DIAGRAM_PATH, entry: ENTRY }), once, "an unchanged entry produces no diff");
});

test("an incomplete entry names every field it is missing, rather than publishing a half-described diagram", () => {
    const { altText, takeaways, ...partial } = ENTRY;
    assert.throws(
        () => registerDiagram({ registryText: CATALOGUE, targetPath: DIAGRAM_PATH, entry: partial }),
        (error) => {
            assert.equal(error.code, "registration.incomplete-catalogue-entry");
            assert.match(error.message, /altText/);
            assert.match(error.message, /takeaways/);
            return true;
        },
    );
});

test("a category no page lists is refused, and the refusal names the ones that exist", () => {
    // The live artifact set category to the literal string UNKNOWN, because its
    // brief supplied no taxonomy. Filing it under UNKNOWN would have hidden the
    // diagram just as completely as leaving it unregistered.
    assert.throws(
        () => registerDiagram({ registryText: CATALOGUE, targetPath: DIAGRAM_PATH, entry: { ...ENTRY, category: "UNKNOWN" } }),
        (error) => {
            assert.equal(error.code, "registration.unknown-diagram-category");
            for (const category of DIAGRAM_CATEGORIES) assert.match(error.message, new RegExp(category));
            return true;
        },
    );
});

// --- what the caller asks for ---------------------------------------------

test("a Field Guide resource needs no registration, because a resource indexes itself", () => {
    assert.equal(registrationFor({ surface: "guide", targetPath: "content/resources/discovery/x.json", artifact: "{}" }), null);
});

test("an undeclared surface is refused rather than silently skipping registration", () => {
    assert.throws(
        () => registrationFor({ surface: "podcast", targetPath: "content/podcasts/x.json", artifact: "{}" }),
        (error) => error.code === "registration.unknown-surface",
    );
});

// --- the prepared commit carries both halves -------------------------------

const BASE_COMMIT = "1".repeat(40);
const PREPARED_COMMIT = "9".repeat(40);

function commitFetchMock({ registryText = CATALOG } = {}) {
    const calls = [];
    const trees = [];
    const blobs = [];
    const commits = [];
    const impl = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        const body = options.body ? JSON.parse(options.body) : null;
        const respond = (status, payload) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
        if (url.includes("/git/ref/heads/")) return respond(200, { object: { sha: BASE_COMMIT } });
        if (url.includes(`/git/commits/${BASE_COMMIT}`)) return respond(200, { tree: { sha: "2".repeat(40) } });
        if (url.includes("/contents/")) {
            if (registryText === null) return respond(404, { message: "Not Found" });
            return respond(200, { content: Buffer.from(registryText, "utf8").toString("base64"), encoding: "base64" });
        }
        if (url.endsWith("/git/blobs")) {
            blobs.push(body.content);
            return respond(201, { sha: `b${blobs.length}`.padEnd(40, "0") });
        }
        if (url.endsWith("/git/trees")) {
            trees.push(body.tree);
            return respond(201, { sha: "t".repeat(40) });
        }
        if (url.endsWith("/git/commits") && options.method === "POST") {
            commits.push(body.message);
            return respond(201, { sha: PREPARED_COMMIT });
        }
        throw new Error(`unexpected fetch: ${url}`);
    };
    return { impl, calls, trees, blobs, commits };
}

test("a prepared commit carries the module and the catalog entry in one tree", async () => {
    const mock = commitFetchMock();
    const result = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: MODULE_PATH, content: learningModule(),
        registration: registrationFor({ surface: "learning", targetPath: MODULE_PATH, artifact: learningModule() }),
        token: "test-token-literal", fetchImpl: mock.impl,
    });
    assert.equal(mock.trees.length, 1, "one tree, so the artifact and its registration can only merge together");
    assert.deepEqual(mock.trees[0].map((entry) => entry.path), [MODULE_PATH, "content/catalog.json"]);
    assert.equal(result.registeredIn, "content/catalog.json");
    assert.match(mock.commits[0], /Prepare content\/modules\/discovery\/rag\.json and content\/catalog\.json/);
    assert.deepEqual(JSON.parse(mock.blobs[0]).paths.find((p) => p.id === "discovery").moduleIds, ["rag"]);
});

test("a registration that cannot be built costs no blob, no tree and no commit object", async () => {
    const mock = commitFetchMock({ registryText: CATALOG });
    await assert.rejects(
        () => prepareRealCommit({
            repository: "project42dev/project42-platform", path: "content/modules/nowhere/rag.json", content: learningModule(),
            registration: registrationFor({ surface: "learning", targetPath: "content/modules/nowhere/rag.json", artifact: learningModule() }),
            token: "test-token-literal", fetchImpl: mock.impl,
        }),
        (error) => error instanceof RegistrationError && error.code === "registration.no-such-path",
    );
    assert.equal(mock.blobs.length, 0, "the registry is resolved before the artifact blob is written");
    assert.equal(mock.trees.length, 0);
    assert.equal(mock.commits.length, 0);
});

test("a surface that needs no registration still prepares exactly the commit it always did", async () => {
    const mock = commitFetchMock();
    const result = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: "content/resources/discovery/x.json", content: "{}",
        registration: null, token: "test-token-literal", fetchImpl: mock.impl,
    });
    assert.deepEqual(mock.trees[0].map((entry) => entry.path), ["content/resources/discovery/x.json"]);
    assert.equal(result.registeredIn, null);
    assert.equal(mock.calls.filter((call) => call.url.includes("/contents/")).length, 0, "no registry is read for a surface that has none");
});

test("a module already listed adds no second blob, and the commit names only the artifact", async () => {
    const listed = registerLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, artifact: learningModule() });
    const mock = commitFetchMock({ registryText: listed });
    const result = await prepareRealCommit({
        repository: "project42dev/project42-platform", path: MODULE_PATH, content: learningModule(),
        registration: registrationFor({ surface: "learning", targetPath: MODULE_PATH, artifact: learningModule() }),
        token: "test-token-literal", fetchImpl: mock.impl,
    });
    assert.deepEqual(mock.trees[0].map((entry) => entry.path), [MODULE_PATH]);
    assert.equal(result.registeredIn, null, "nothing changed in the registry, so nothing is committed to it");
    assert.equal(mock.blobs.length, 1);
});
