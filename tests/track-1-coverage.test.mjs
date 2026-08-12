import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StateStore } from "../scripts/lib/state-store.mjs";
import {
    arePublicAddresses,
    createBoundedFetchAdapter,
    dedupeCandidates,
    isPublicIp,
    loadApprovedSourceRegistry,
    partitionCandidates,
    reconcileTrack1Outcomes,
    runTrack1,
    semanticCandidateIdentity,
} from "../scripts/lib/track-1-controller.mjs";

function registry(count, overrides = {}) {
    return {
        registryVersion: "2026-08-12",
        approvedSources: Array.from({ length: count }, (_, index) => {
            const id = `source-${String(count - index - 1).padStart(3, "0")}`;
            return {
                id,
                enabled: true,
                url: `https://${id}.example.test/feed`,
                label: id,
                policy: { approval: "owner-reviewed", allowedHosts: [`${id}.example.test`] },
                ...overrides[id],
            };
        }),
    };
}

const success = async (source) => ({ kind: "success", status: 200, finalUrl: source.url, bytes: 10, durationMs: 2, body: source.id });

function options(mode, count, extra = {}) {
    return {
        mode,
        registry: registry(count),
        fetchAdapter: success,
        contentCommit: "1".repeat(40),
        implementationCommit: "2".repeat(40),
        ...extra,
    };
}

test("legacy discovery rejects network mode before accessing registry URLs", (t) => {
    const root = mkdtempSync(join(tmpdir(), "orchard-legacy-discovery-"));
    const corpus = join(root, "corpus");
    const registryPath = join(root, "registry.json");
    const probesPath = join(root, "probes.json");
    const outputPath = join(root, "output.json");
    mkdirSync(corpus);
    writeFileSync(join(corpus, "content.md"), "safe corpus content\n", "utf8");
    writeFileSync(registryPath, JSON.stringify({ watchList: [{ id: "metadata", url: "http://169.254.169.254/latest/meta-data/" }] }), "utf8");
    writeFileSync(probesPath, JSON.stringify({ probes: [] }), "utf8");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts", "discover-content-opportunities.mjs"),
        "--registry", registryPath,
        "--corpus", corpus,
        "--probes", probesPath,
        "--out", outputPath,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy network survey mode is disabled/);
});

test("full Track 1 success attempts 50 distinct approved sources and persists exact durable outcomes", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orchard-track1-"));
    const store = new StateStore(join(root, "state.db"));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

    const result = await runTrack1(options("full", 50, { stateStore: store }));

    assert.equal(result.status, "completed");
    assert.equal(result.run.coverage.attempted, 50);
    assert.equal(result.run.coverage.successfully_evaluated, 50);
    assert.equal(result.reconciliation.ok, true);
    assert.deepEqual(result.sources.map(({ id }) => id), [...result.sources.map(({ id }) => id)].sort());
    assert.equal(new Set(result.outcomes.map(({ sourceId }) => sourceId)).size, 50);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM observation_event WHERE run_id = ?").get(result.run.run_id).count, 50);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM run_outcome WHERE run_id = ?").get(result.run.run_id).count, 50);
    assert.equal(store.getRun(result.run.run_id).status, "completed");
});

test("disabled registry history is outside run scope and produces no persisted outcome", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orchard-track1-disabled-"));
    const store = new StateStore(join(root, "state.db"));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    const disabledId = "source-050";
    const result = await runTrack1(options("full", 51, {
        registry: registry(51, { [disabledId]: { enabled: false } }), stateStore: store,
        limits: { maxSources: 50, maxFailures: 1 }
    }));

    assert.equal(result.status, "completed");
    assert.equal(result.run.coverage.approved_enabled_source_count, 50);
    assert.equal(result.run.coverage.attempted + result.run.coverage.skipped + result.run.coverage.unevaluated, 50);
    assert.equal(result.outcomes.some((outcome) => outcome.sourceId === disabledId), false);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM run_outcome WHERE run_id = ?").get(result.run.run_id).count, 50);
});

test("subset mode never qualifies as a completed full run", async () => {
    const result = await runTrack1(options("subset", 60, { subsetIds: Array.from({ length: 50 }, (_, index) => `source-${String(index).padStart(3, "0")}`) }));
    assert.equal(result.status, "incomplete");
    assert.equal(result.run.scope.mode, "subset");
    assert.equal(result.run.coverage.attempted, 50);
});

test("49 approved sources cannot satisfy the full-run threshold", async () => {
    const result = await runTrack1(options("full", 49));
    assert.equal(result.status, "incomplete");
    assert.equal(result.run.coverage.attempted, 49);
});

test("duplicate and missing source outcomes fail exact reconciliation", () => {
    const duplicate = reconcileTrack1Outcomes(["a", "b"], [
        { sourceId: "a", outcome: "success" },
        { sourceId: "a", outcome: "failed" },
    ]);
    assert.equal(duplicate.ok, false);
    assert.deepEqual(duplicate.duplicates, ["a"]);
    assert.deepEqual(duplicate.missing, ["b"]);
});

test("source and failure caps stop work and preserve partial truth", async () => {
    let calls = 0;
    const sourceCap = await runTrack1(options("full", 6, {
        limits: { maxSources: 2, maxFailures: 10 },
        fetchAdapter: async (source) => { calls += 1; return success(source); },
    }));
    assert.equal(calls, 2);
    assert.equal(sourceCap.status, "incomplete");
    assert.equal(sourceCap.run.coverage.attempted, 2);
    assert.equal(sourceCap.run.coverage.unevaluated, 4);
    assert.equal(sourceCap.outcomes.filter(({ reason }) => reason === "source-cap").length, 4);

    calls = 0;
    const failureCap = await runTrack1(options("full", 5, {
        limits: { maxSources: 5, maxFailures: 1 },
        fetchAdapter: async () => { calls += 1; return { kind: "failed", reason: "synthetic" }; },
    }));
    assert.equal(calls, 1);
    assert.equal(failureCap.run.coverage.failed, 1);
    assert.equal(failureCap.run.coverage.unevaluated, 4);
});

test("registry ordering, semantic dedupe, and maximum-20 candidate batching are deterministic", () => {
    const loaded = loadApprovedSourceRegistry(registry(3));
    assert.deepEqual(loaded.sources.map(({ id }) => id), ["source-000", "source-001", "source-002"]);

    const candidates = Array.from({ length: 22 }, (_, index) => ({
        subject: `Subject ${index}`,
        surface: "Guide",
        outcome: "addition",
        evidence: [`evidence-${index}`],
    }));
    candidates.push({ ...candidates[0], subject: "  subject 0 ", evidence: ["other"] });
    const unique = dedupeCandidates(candidates);
    const batches = partitionCandidates(candidates);
    assert.equal(unique.length, 22);
    assert.deepEqual(batches.map((batch) => batch.length), [20, 2]);
    assert.equal(unique[0].semanticIdentity <= unique.at(-1).semanticIdentity, true);
    assert.equal(semanticCandidateIdentity(candidates[0]), semanticCandidateIdentity({ ...candidates[0], subject: " SUBJECT 0 " }));
    assert.deepEqual(dedupeCandidates([...candidates].reverse()), unique);
});

test("dry-run performs no fetch or state mutation", async () => {
    let calls = 0;
    const result = await runTrack1(options("dry-run", 3, { fetchAdapter: async () => { calls += 1; return { kind: "success" }; } }));
    assert.equal(calls, 0);
    assert.equal(result.status, "incomplete");
    assert.equal(result.run.coverage.unevaluated, 3);
});

test("network classification rejects every tested special-purpose address family", () => {
    for (const address of [
        "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "192.0.2.1", "198.18.0.1",
        "::1", "fd00::1", "fe80::1", "fec0::1", "2001:db8::1", "64:ff9b::1", "64:ff9b:1::1",
        "100::1", "2002::1", "3fff::1", "5f00::1", "ff02::1",
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-address"
    ]) {
        assert.equal(isPublicIp(address), false, address);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
        assert.equal(isPublicIp(address), true, address);
    }
    assert.equal(arePublicAddresses([{ address: "1.1.1.1" }, { address: "10.0.0.1" }]), false, "mixed public/private DNS answers");
    assert.equal(arePublicAddresses([{ address: "1.1.1.1" }, { address: "2606:4700:4700::1111" }]), true, "all-public DNS answers");
    assert.equal(arePublicAddresses([]), false, "empty DNS answer");
});

test("bounded fetch rejects redirects outside the approved host before following them", async () => {
    let calls = 0;
    const adapter = createBoundedFetchAdapter({
        maxRetries: 0,
        fetchImpl: async () => {
            calls += 1;
            return { status: 302, ok: false, headers: new Headers({ location: "https://127.0.0.1/private" }), body: null };
        },
    });
    const source = loadApprovedSourceRegistry(registry(1)).sources[0];
    const result = await adapter(source);
    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "unapproved-redirect");
    assert.equal(calls, 1);
});

test("bounded fetch cancels a streaming body as soon as the byte cap is crossed", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(6));
            controller.enqueue(new Uint8Array(6));
        },
        cancel() { cancelled = true; },
    });
    const adapter = createBoundedFetchAdapter({
        maxBytes: 10,
        maxRetries: 0,
        fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers(), body: stream }),
    });
    const source = loadApprovedSourceRegistry(registry(1)).sources[0];
    const result = await adapter(source);
    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "byte-cap");
    assert.equal(cancelled, true);
});
