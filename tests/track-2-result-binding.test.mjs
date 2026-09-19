import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createValidatedResultInspector } from "../scripts/lib/built-in-inspector.mjs";
import { sha256Digest } from "../scripts/lib/identity.mjs";
import { enumerateCanonicalCorpus, runTrack2 } from "../scripts/lib/track-2-controller.mjs";

const CONTENT_COMMIT = "a".repeat(40);
const INSPECTOR_DIGEST = `sha256:${"b".repeat(64)}`;
const BASELINE_PATH_COUNT = 211;
const BASELINE_ITEM_COUNT = 213;

function pathsFor(count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `path-${String(index).padStart(3, "0")}`,
        title: `Path ${index}`,
    }));
}

function writeJson(path, value, spacing) {
    writeFileSync(path, `${JSON.stringify(value, null, spacing)}\n`, "utf8");
}

function writeCatalog(root, pathCount = BASELINE_PATH_COUNT, spacing) {
    writeJson(join(root, "content", "catalog.json"), {
        paths: pathsFor(pathCount),
        modules: [],
        resources: [],
    }, spacing);
}

function createCorpus() {
    const root = mkdtempSync(join(tmpdir(), "orchard-track-2-binding-"));
    mkdirSync(join(root, "content", "modules"), { recursive: true });
    mkdirSync(join(root, "content", "resources"), { recursive: true });
    mkdirSync(join(root, "content", "diagrams"), { recursive: true });
    writeCatalog(root);
    writeJson(join(root, "content", "diagrams", "catalogue.json"), { diagrams: [] });
    return root;
}

function removeCorpus(root) {
    rmSync(root, { recursive: true, force: true });
}

function resultFor(item) {
    return {
        stableId: item.stableId,
        itemDigest: item.digest,
        sourceDigest: item.sourceDigest,
        inspectorDigest: INSPECTOR_DIGEST,
        classification: "evidence-backed-no-change",
        evidence: [`checked:${item.stableId}`],
    };
}

function writeResults(root, items, transform = (results) => results) {
    const resultPath = join(root, "inspection-results.json");
    const results = transform(items.map(resultFor));
    writeJson(resultPath, results);
    return resultPath;
}

function validatedInspector(resultPath, items, options = {}) {
    return createValidatedResultInspector({
        resultPath,
        expectedStableIds: items.map((item) => item.stableId),
        ...options,
    });
}

async function runFull(root, inspector) {
    return runTrack2({
        mode: "full",
        platformRoot: root,
        contentCommit: CONTENT_COMMIT,
        commitVerifier: () => CONTENT_COMMIT,
        expectedCanonicalItems: enumerateCanonicalCorpus(root).length,
        partitionSize: 50,
        concurrency: 4,
        inspector,
    });
}

test("unchanged results bind successfully to all 213 enumerated canonical items", async () => {
    const root = createCorpus();
    try {
        const preflightItems = enumerateCanonicalCorpus(root);
        assert.equal(preflightItems.length, BASELINE_ITEM_COUNT);

        const resultPath = writeResults(root, preflightItems);
        const controllerItems = enumerateCanonicalCorpus(root);
        assert.equal(controllerItems.length, BASELINE_ITEM_COUNT);

        const result = await runFull(
            root,
            validatedInspector(resultPath, controllerItems),
        );

        assert.equal(result.status, "completed");
        assert.deepEqual(result.coverage, {
            expected: BASELINE_ITEM_COUNT,
            enumerated: BASELINE_ITEM_COUNT,
            inspected: BASELINE_ITEM_COUNT,
            gaps: 0,
        });
        assert.equal(result.reconciliation.ok, true);
        assert.equal(result.inspectionFailed, false);
        assert.equal(result.outcomes.length, BASELINE_ITEM_COUNT);
        assert.ok(result.outcomes.every((outcome) =>
            outcome.classification === "evidence-backed-no-change"));
    } finally {
        removeCorpus(root);
    }
});

test("an item added after the 213-item result set is rejected as a missing exact identity", async () => {
    const root = createCorpus();
    try {
        const preflightItems = enumerateCanonicalCorpus(root);
        assert.equal(preflightItems.length, BASELINE_ITEM_COUNT);
        const resultPath = writeResults(root, preflightItems);

        writeCatalog(root, BASELINE_PATH_COUNT + 1);
        const controllerItems = enumerateCanonicalCorpus(root);
        assert.equal(controllerItems.length, BASELINE_ITEM_COUNT + 1);
        assert.ok(controllerItems.some((item) =>
            item.stableId === "learning-path:path-211"));

        const result = await runFull(
            root,
            validatedInspector(resultPath, controllerItems),
        );

        assert.equal(result.status, "failed");
        assert.equal(result.inspectionFailed, true);
        const addedOutcome = result.outcomes.find((outcome) =>
            outcome.stableId === "learning-path:path-211");
        assert.ok(addedOutcome);
        assert.equal(addedOutcome.outcome, "failed");
        assert.match(addedOutcome.error, /inspection result is missing: learning-path:path-211/);
    } finally {
        removeCorpus(root);
    }
});

test("an item removed after the 213-item result set is rejected before inspection", () => {
    const root = createCorpus();
    try {
        const preflightItems = enumerateCanonicalCorpus(root);
        assert.equal(preflightItems.length, BASELINE_ITEM_COUNT);
        const resultPath = writeResults(root, preflightItems);

        writeCatalog(root, BASELINE_PATH_COUNT - 1);
        const controllerItems = enumerateCanonicalCorpus(root);
        assert.equal(controllerItems.length, BASELINE_ITEM_COUNT - 1);
        assert.ok(!controllerItems.some((item) =>
            item.stableId === "learning-path:path-210"));

        assert.throws(
            () => validatedInspector(resultPath, controllerItems),
            /inspection result file exceeds its result-count bound/,
        );

        writeResults(root, preflightItems, (results) => results.filter((result) =>
            result.stableId !== "learning-path:path-209"));
        assert.throws(
            () => validatedInspector(resultPath, controllerItems),
            /unexpected inspection result: learning-path:path-210/,
        );
    } finally {
        removeCorpus(root);
    }
});

test("source-byte drift after a 213-item enumeration is rejected by the inspector", async () => {
    const root = createCorpus();
    try {
        const items = enumerateCanonicalCorpus(root);
        assert.equal(items.length, BASELINE_ITEM_COUNT);
        const resultPath = writeResults(root, items);
        const inspector = validatedInspector(resultPath, items);
        const catalogue = items.find((item) => item.stableId === "catalogue:content");
        assert.ok(catalogue);

        writeCatalog(root, BASELINE_PATH_COUNT, 2);

        await assert.rejects(
            inspector(catalogue, { platformRoot: root }),
            /canonical source digest changed: catalogue:content/,
        );
    } finally {
        removeCorpus(root);
    }
});

test("a changed item digest in a 213-item result set makes the controller run fail", async () => {
    const root = createCorpus();
    try {
        const items = enumerateCanonicalCorpus(root);
        assert.equal(items.length, BASELINE_ITEM_COUNT);
        const targetId = "learning-path:path-000";
        const resultPath = writeResults(root, items, (results) => results.map((result) =>
            result.stableId === targetId
                ? { ...result, itemDigest: sha256Digest("different-item-value") }
                : result));

        const result = await runFull(root, validatedInspector(resultPath, items));

        assert.equal(result.status, "failed");
        assert.equal(result.inspectionFailed, true);
        const targetOutcome = result.outcomes.find((outcome) =>
            outcome.stableId === targetId);
        assert.ok(targetOutcome);
        assert.equal(targetOutcome.outcome, "failed");
        assert.match(targetOutcome.error, /inspection result does not bind canonical bytes: learning-path:path-000/);
    } finally {
        removeCorpus(root);
    }
});

test("a source digest from the old 213-item snapshot does not bind newly enumerated source bytes", async () => {
    const root = createCorpus();
    try {
        const preflightItems = enumerateCanonicalCorpus(root);
        assert.equal(preflightItems.length, BASELINE_ITEM_COUNT);
        const resultPath = writeResults(root, preflightItems);

        writeCatalog(root, BASELINE_PATH_COUNT, 2);
        const controllerItems = enumerateCanonicalCorpus(root);
        assert.equal(controllerItems.length, BASELINE_ITEM_COUNT);

        const result = await runFull(
            root,
            validatedInspector(resultPath, controllerItems),
        );

        assert.equal(result.status, "failed");
        assert.equal(result.inspectionFailed, true);
        const catalogueOutcome = result.outcomes.find((outcome) =>
            outcome.stableId === "catalogue:content");
        assert.ok(catalogueOutcome);
        assert.equal(catalogueOutcome.outcome, "failed");
        assert.match(catalogueOutcome.error, /inspection result does not bind canonical bytes: catalogue:content/);
    } finally {
        removeCorpus(root);
    }
});

test("a missing result from an otherwise unchanged 213-item enumeration fails coverage", async () => {
    const root = createCorpus();
    try {
        const items = enumerateCanonicalCorpus(root);
        assert.equal(items.length, BASELINE_ITEM_COUNT);
        const missingId = "learning-path:path-100";
        const resultPath = writeResults(root, items, (results) => results.filter((result) =>
            result.stableId !== missingId));

        const result = await runFull(root, validatedInspector(resultPath, items));

        assert.equal(result.status, "failed");
        assert.equal(result.inspectionFailed, true);
        assert.equal(result.coverage.expected, BASELINE_ITEM_COUNT);
        assert.equal(result.coverage.inspected, BASELINE_ITEM_COUNT - 1);
        assert.equal(result.coverage.gaps, 1);
        const missingOutcome = result.outcomes.find((outcome) =>
            outcome.stableId === missingId);
        assert.ok(missingOutcome);
        assert.equal(missingOutcome.outcome, "failed");
        assert.match(missingOutcome.error, /inspection result is missing: learning-path:path-100/);
    } finally {
        removeCorpus(root);
    }
});
