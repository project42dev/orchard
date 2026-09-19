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

function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function createCorpus({ pathCount = 0, duplicatePathId = false, missingDiagramSource = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), "orchard-track-2-"));
    mkdirSync(join(root, "content", "modules"), { recursive: true });
    mkdirSync(join(root, "content", "resources"), { recursive: true });
    mkdirSync(join(root, "content", "diagrams"), { recursive: true });

    const paths = Array.from({ length: pathCount }, (_, index) => ({
        id: `path-${String(index).padStart(3, "0")}`,
        title: `Path ${index}`,
    }));
    if (duplicatePathId) paths.push({ id: paths[0].id, title: "Duplicate path" });

    writeJson(join(root, "content", "catalog.json"), {
        paths,
        modules: [],
        resources: [],
    });

    const diagrams = missingDiagramSource
        ? [{ id: "missing-diagram", source: "missing-diagram.json" }]
        : [];
    writeJson(join(root, "content", "diagrams", "catalogue.json"), { diagrams });

    return root;
}

function removeCorpus(root) {
    rmSync(root, { recursive: true, force: true });
}

test("full Track 2 inspects every stable ID after the corpus grows to 213 items", async () => {
    const root = createCorpus({ pathCount: 211 });
    try {
        const enumerated = enumerateCanonicalCorpus(root);
        assert.equal(enumerated.length, 213);

        const inspected = [];
        const result = await runTrack2({
            mode: "full",
            platformRoot: root,
            contentCommit: CONTENT_COMMIT,
            commitVerifier: () => CONTENT_COMMIT,
            partitionSize: 50,
            concurrency: 4,
            inspector: async (item) => {
                inspected.push(item.stableId);
                return {
                    classification: "evidence-backed-no-change",
                    evidence: [`checked:${item.stableId}`],
                };
            },
        });

        assert.equal(result.status, "completed");
        assert.deepEqual(result.coverage, {
            expected: 213,
            enumerated: 213,
            inspected: 213,
            gaps: 0,
        });
        assert.equal(result.reconciliation.ok, true);
        assert.equal(inspected.length, 213);
        assert.deepEqual(new Set(inspected), new Set(enumerated.map((item) => item.stableId)));
    } finally {
        removeCorpus(root);
    }
});

test("an explicitly supplied wrong expected count remains fail-closed", async () => {
    const root = createCorpus({ pathCount: 211 });
    try {
        await assert.rejects(
            runTrack2({
                mode: "full",
                platformRoot: root,
                contentCommit: CONTENT_COMMIT,
                expectedCanonicalItems: 212,
                commitVerifier: () => CONTENT_COMMIT,
                inspector: async () => ({
                    classification: "evidence-backed-no-change",
                    evidence: ["checked"],
                }),
            }),
            /full Track 2 requires exactly 212 canonical items; enumerated 213/,
        );
    } finally {
        removeCorpus(root);
    }
});

test("enumeration still rejects a missing canonical source", () => {
    const root = createCorpus({ missingDiagramSource: true });
    try {
        assert.throws(
            () => enumerateCanonicalCorpus(root),
            /canonical item source is missing: guide-diagram:missing-diagram/,
        );
    } finally {
        removeCorpus(root);
    }
});

test("enumeration still rejects duplicate canonical stable IDs", () => {
    const root = createCorpus({ pathCount: 1, duplicatePathId: true });
    try {
        assert.throws(
            () => enumerateCanonicalCorpus(root),
            /duplicate canonical item: learning-path:path-000/,
        );
    } finally {
        removeCorpus(root);
    }
});

test("the built-in inspector derives its default result bound from all expected stable IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "orchard-track-2-results-"));
    try {
        mkdirSync(join(root, "content"), { recursive: true });
        const sourcePath = join(root, "content", "shared.json");
        writeJson(sourcePath, { source: "shared" });
        const sourceDigest = sha256Digest(Buffer.from(`${JSON.stringify({ source: "shared" })}\n`, "utf8"));
        const items = Array.from({ length: 213 }, (_, index) => {
            const stableId = `learning-path:path-${String(index).padStart(3, "0")}`;
            return {
                stableId,
                sourcePath: "content/shared.json",
                sourceDigest,
                digest: sha256Digest({ index }),
            };
        });
        const resultPath = join(root, "inspection-results.json");
        writeJson(resultPath, items.map((item) => ({
            stableId: item.stableId,
            itemDigest: item.digest,
            sourceDigest: item.sourceDigest,
            inspectorDigest: INSPECTOR_DIGEST,
            classification: "evidence-backed-no-change",
            evidence: [`checked:${item.stableId}`],
        })));

        const inspector = createValidatedResultInspector({
            resultPath,
            expectedStableIds: items.map((item) => item.stableId),
        });
        const inspected = await Promise.all(items.map((item) => inspector(item, { platformRoot: root })));

        assert.equal(inspected.length, 213);
        assert.ok(inspected.every((result) => result.classification === "evidence-backed-no-change"));
    } finally {
        removeCorpus(root);
    }
});
