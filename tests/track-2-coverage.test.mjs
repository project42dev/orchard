import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StateStore } from "../scripts/lib/state-store.mjs";
import {
    enumerateCanonicalCorpus,
    mapWithConcurrency,
    partitionCanonicalItems,
    reconcileTrack2Outcomes,
    runTrack2,
} from "../scripts/lib/track-2-controller.mjs";

const COMMIT = "3".repeat(40);
const noChange = async (item) => ({ classification: "evidence-backed-no-change", evidence: [`digest:${item.digest}`] });
const verifyCommit = (_root, commit) => {
    if (commit !== COMMIT) throw new Error("pin mismatch");
    return commit;
};

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function platformFixture(t) {
    const root = mkdtempSync(join(tmpdir(), "orchard-platform-"));
    for (const directory of ["content/modules", "content/resources", "content/diagrams", "src/generated"]) mkdirSync(join(root, directory), { recursive: true });
    writeJson(join(root, "content/catalog.json"), {
        schemaVersion: "1.0.0",
        contentVersion: "test",
        paths: [{ id: "path-b", title: "B" }, { id: "path-a", title: "A" }],
        modules: [{ id: "module-a", title: "Module" }],
        resources: [{ id: "resource-a", title: "Resource" }],
    });
    writeJson(join(root, "content/modules/module-a.json"), { id: "module-a", body: "canonical module" });
    writeJson(join(root, "content/resources/resource-a.json"), { id: "resource-a", body: "canonical resource" });
    writeJson(join(root, "content/diagrams/catalogue.json"), {
        $schemaVersion: "1.0.0",
        renderer: "mermaid",
        diagrams: [{ id: "diagram-a", source: "diagram-a.mmd" }],
    });
    writeFileSync(join(root, "content/diagrams/diagram-a.mmd"), "graph TD; A-->B;\n", "utf8");
    writeJson(join(root, "src/generated/ignored.json"), { id: "must-not-be-enumerated" });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function options(root, mode = "full", extra = {}) {
    return { mode, platformRoot: root, contentCommit: COMMIT, commitVerifier: verifyCommit, inspector: noChange, ...extra };
}

test("canonical enumeration is deterministic, typed, and excludes generated content", (t) => {
    const root = platformFixture(t);
    const first = enumerateCanonicalCorpus(root);
    const second = enumerateCanonicalCorpus(root);
    assert.deepEqual(second, first);
    assert.deepEqual(first.map(({ stableId }) => stableId), [...first.map(({ stableId }) => stableId)].sort());
    assert.equal(first.length, 7);
    assert.equal(first.some(({ canonicalId }) => canonicalId === "must-not-be-enumerated"), false);
    assert.deepEqual(new Set(first.map(({ kind }) => kind)), new Set(["catalogue", "learning-item", "guide-item", "guide-diagram-item"]));
});

test("partitions are deterministic, no larger than 50, and reject duplicate stable IDs", () => {
    const items = Array.from({ length: 101 }, (_, index) => ({ stableId: `item:${String(100 - index).padStart(3, "0")}` }));
    const partitions = partitionCanonicalItems(items);
    assert.deepEqual(partitions.map((partition) => partition.length), [50, 50, 1]);
    assert.deepEqual(partitions.flat().map(({ stableId }) => stableId), [...items.map(({ stableId }) => stableId)].sort());
    assert.throws(() => partitionCanonicalItems([items[0], items[0]]), /duplicate canonical item/);
});

test("100 percent full inspection completes and persists one observation and outcome per canonical item", async (t) => {
    const root = platformFixture(t);
    const stateRoot = mkdtempSync(join(tmpdir(), "orchard-track2-state-"));
    const store = new StateStore(join(stateRoot, "state.db"));
    t.after(() => { store.close(); rmSync(stateRoot, { recursive: true, force: true }); });

    const result = await runTrack2(options(root, "full", { stateStore: store }));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.coverage, { expected: 7, enumerated: 7, inspected: 7, gaps: 0 });
    assert.equal(result.reconciliation.ok, true);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM observation_event WHERE run_id = ?").get(result.run.run_id).count, 7);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM run_outcome WHERE run_id = ?").get(result.run.run_id).count, 7);
});

test("subset inspection never qualifies as completed full coverage", async (t) => {
    const root = platformFixture(t);
    const result = await runTrack2(options(root, "subset", { subsetIds: ["learning-module:module-a"] }));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.coverage, { expected: 1, enumerated: 1, inspected: 1, gaps: 0 });
});

test("one missing or duplicate item fails exact reconciliation", () => {
    const missing = reconcileTrack2Outcomes(["a", "b"], [{ stableId: "a" }]);
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing, ["b"]);
    const duplicate = reconcileTrack2Outcomes(["a", "b"], [{ stableId: "a" }, { stableId: "a" }, { stableId: "b" }]);
    assert.equal(duplicate.ok, false);
    assert.deepEqual(duplicate.duplicates, ["a"]);
});

test("partition omission, duplicate output, and thrown partition failure fail closed", async (t) => {
    const root = platformFixture(t);
    const omitted = await runTrack2(options(root, "full", { partitionExecutor: async (partition, inspect) => Promise.all(partition.slice(1).map(inspect)) }));
    assert.equal(omitted.status, "failed");
    assert.equal(omitted.coverage.inspected, 0);

    const duplicated = await runTrack2(options(root, "full", {
        partitionExecutor: async (partition, inspect) => {
            const results = await Promise.all(partition.map(inspect));
            results[1] = results[0];
            return results;
        },
    }));
    assert.equal(duplicated.status, "failed");

    const thrown = await runTrack2(options(root, "full", { partitionExecutor: async () => { throw new Error("synthetic partition failure"); } }));
    assert.equal(thrown.status, "failed");
    assert.equal(thrown.outcomes.every(({ outcome }) => outcome === "failed"), true);
});

test("inspection concurrency never exceeds four", async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 4, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return value * 2;
    });
    assert.equal(peak, 4);
    assert.deepEqual(values, Array.from({ length: 20 }, (_, index) => index * 2));
    await assert.rejects(() => mapWithConcurrency([1], 5, async (value) => value), /concurrency/);
});

test("corpus drift during inspection fails closed", async (t) => {
    const root = platformFixture(t);
    let changed = false;
    const result = await runTrack2(options(root, "full", {
        inspector: async (item) => {
            if (!changed) {
                changed = true;
                const path = join(root, "content/catalog.json");
                const catalog = JSON.parse(readFileSync(path, "utf8"));
                catalog.contentVersion = "drifted";
                writeJson(path, catalog);
            }
            return noChange(item);
        },
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.drift, true);
});

test("dry-run validates and partitions without invoking the inspector", async (t) => {
    const root = platformFixture(t);
    let calls = 0;
    const result = await runTrack2(options(root, "dry-run", { inspector: async () => { calls += 1; return noChange({ digest: "x" }); } }));
    assert.equal(calls, 0);
    assert.equal(result.status, "incomplete");
    assert.equal(result.coverage.inspected, 0);
    assert.equal(result.coverage.gaps, 7);
});
