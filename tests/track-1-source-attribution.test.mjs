import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DEFAULT_MIN_COVERAGE,
    coverageVerdict,
    runTrack1,
    silentOutcomes,
} from "../scripts/lib/track-1-controller.mjs";
import { loadApprovedSourceRegistry } from "../scripts/lib/track-1-controller.mjs";
import { exitCodeFor, reportCoverage } from "../scripts/discover-approved-sources.mjs";

// A run that surveys 78 approved sources, gets a usable answer from 54, and
// exits reporting success is a failed run wearing a success. These tests hold
// that line: coverage is measured every run, every source that produced
// nothing is named, and a planted failure drops the run below the threshold.

function registry(count, { silentIds = [], retiredIds = [] } = {}) {
    const approvedSources = Array.from({ length: count }, (_, index) => {
        const id = `source-${String(index).padStart(3, "0")}`;
        const retired = retiredIds.includes(id);
        return {
            id,
            enabled: !retired,
            url: `https://${id}.example.test/feed`,
            label: `Source ${index}`,
            policy: retired
                ? { approval: "retired", statusReason: `retired for the test: ${id}` }
                : {
                    approval: "approved",
                    approvalReference: `approval:${id}`,
                    owner: "source-policy-owner",
                    licenseTermsReview: "reviewed",
                    robotsPolicy: "honoured",
                    ratePolicy: "one request per 30 seconds",
                    evidenceRetentionClass: "public-listing-metadata",
                    reviewedAt: "2026-09-06",
                    reviewCadenceDays: 180,
                    allowedHosts: [`${id}.example.test`],
                },
        };
    });
    return { registryVersion: "2026-09-06", approvedSources, silentIds };
}

// The planted failure. Named sources answer nothing; everything else answers.
function plantedAdapter(silentIds, kind = "failed", reason = "planted-outage") {
    return async function fetchAdapter(source) {
        if (silentIds.includes(source.id)) {
            return { kind, reason, status: kind === "blocked" ? 200 : 503, redirects: 0, bytes: 0, durationMs: 1 };
        }
        return { kind: "success", status: 200, finalUrl: source.url, redirects: 0, bytes: 120, durationMs: 1, body: "<html>ok</html>" };
    };
}

async function survey(count, options = {}) {
    const { silentIds = [], retiredIds = [], kind, reason, minCoverage } = options;
    const source = registry(count, { silentIds, retiredIds });
    return runTrack1({
        mode: "full",
        registry: source,
        registryDigest: loadApprovedSourceRegistry(source, { requirePolicyReview: true }).digest,
        allowLegacyMetadata: false,
        requirePolicyReview: true,
        contentCommit: "0".repeat(40),
        minCoverage,
        fetchAdapter: plantedAdapter(silentIds, kind, reason),
        now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
}

test("the default coverage threshold is 90% of enabled sources", () => {
    assert.equal(DEFAULT_MIN_COVERAGE, 0.9);
});

test("coverageVerdict measures evaluated against enabled, not against attempted", () => {
    const verdict = coverageVerdict(
        { approved_enabled_source_count: 78, attempted: 78, successfully_evaluated: 54 },
        0.9
    );
    assert.equal(verdict.expected, 78);
    assert.equal(verdict.evaluated, 54);
    assert.ok(Math.abs(verdict.ratio - 54 / 78) < 1e-9);
    assert.equal(verdict.met, false, "78 attempted and 54 evaluated is not a covered run");
});

test("a blocked source counts as silent even though it never counts as a failure", () => {
    const silent = silentOutcomes([
        { sourceId: "a", outcome: "success" },
        { sourceId: "b", outcome: "blocked", reason: "byte-cap" },
        { sourceId: "c", outcome: "failed" },
        { sourceId: "d", outcome: "rate-limited" },
        { sourceId: "e", outcome: "unevaluated" },
        { sourceId: "f", outcome: "redirected" },
    ]);
    assert.deepEqual(silent.map((entry) => entry.sourceId), ["b", "c", "d", "e"]);
});

test("every run reports attempted against successfully evaluated", async () => {
    const result = await survey(60, { silentIds: ["source-000", "source-001"] });
    assert.equal(result.run.coverage.approved_enabled_source_count, 60);
    assert.equal(result.run.coverage.attempted, 60);
    assert.equal(result.run.coverage.successfully_evaluated, 58);
    assert.equal(result.run.coverage.silent, 2);
    assert.equal(result.run.coverage.retired, 0);
});

test("every source that produced nothing is named, with its reason", async () => {
    const result = await survey(60, { silentIds: ["source-007", "source-042"] });
    const named = result.attribution.silent.map((entry) => entry.sourceId);
    assert.deepEqual(named, ["source-007", "source-042"]);
    for (const entry of result.attribution.silent) {
        assert.equal(entry.outcome, "failed");
        assert.equal(entry.reason, "planted-outage");
        assert.equal(entry.label, `Source ${Number.parseInt(entry.sourceId.slice(-3), 10)}`);
        assert.ok(entry.url.includes(entry.sourceId), "a named source carries the URL that produced nothing");
    }
    assert.deepEqual(result.attribution.causes, { "failed/planted-outage": 2 });
});

// The proof the task asks for: plant a failing source and watch the threshold trip.
test("a planted failing source below the threshold stops the run reporting success", async () => {
    // 60 sources, 6 planted silent: 54/60 = 90% exactly, which passes.
    const atThreshold = await survey(60, { silentIds: Array.from({ length: 6 }, (_, i) => `source-${String(i).padStart(3, "0")}`) });
    assert.equal(atThreshold.attribution.coverage.met, true, "exactly at the threshold is met");
    assert.equal(atThreshold.status, "completed");

    // One more planted failure: 53/60 = 88.3%, which does not.
    const belowThreshold = await survey(60, { silentIds: Array.from({ length: 7 }, (_, i) => `source-${String(i).padStart(3, "0")}`) });
    assert.equal(belowThreshold.attribution.coverage.met, false);
    assert.notEqual(belowThreshold.status, "completed", "a run under the coverage threshold is not completed");
    assert.equal(belowThreshold.run.status, belowThreshold.status, "the recorded manifest carries the same verdict");
    assert.equal(belowThreshold.attribution.silent.length, 7);
    assert.deepEqual(
        belowThreshold.attribution.silent.map((entry) => entry.sourceId),
        ["source-000", "source-001", "source-002", "source-003", "source-004", "source-005", "source-006"],
        "the planted sources are named individually, not summed into a counter"
    );
});

// The specific regression: blocked sources never counted against a run, so a
// run could block a third of its list and still report completed.
test("blocked sources trip the threshold even though they never trip the failure cap", async () => {
    const result = await survey(60, {
        kind: "blocked",
        reason: "byte-cap",
        silentIds: Array.from({ length: 20 }, (_, i) => `source-${String(i).padStart(3, "0")}`),
    });
    assert.equal(result.run.coverage.failed, 0, "blocked is not failed");
    assert.equal(result.run.coverage.blocked, 20);
    assert.equal(result.attribution.coverage.met, false);
    assert.notEqual(result.status, "completed", "40 of 60 evaluated is not a successful run");
    assert.deepEqual(result.attribution.causes, { "blocked/byte-cap": 20 });
});

test("retirement is reported beside coverage so it cannot quietly lift the ratio", async () => {
    const retiredIds = Array.from({ length: 10 }, (_, i) => `source-${String(i).padStart(3, "0")}`);
    const result = await survey(70, { retiredIds });
    assert.equal(result.run.coverage.approved_enabled_source_count, 60);
    assert.equal(result.run.coverage.retired, 10);
    assert.equal(result.attribution.retired.length, 10);
    for (const entry of result.attribution.retired) {
        assert.match(entry.reason, /retired for the test/, "a retired source states why");
    }
    assert.equal(result.attribution.coverage.met, true);
});

test("the threshold is configurable and a stricter one rejects what the default accepts", async () => {
    const silentIds = Array.from({ length: 5 }, (_, i) => `source-${String(i).padStart(3, "0")}`);
    const lenient = await survey(60, { silentIds });
    assert.equal(lenient.attribution.coverage.met, true, "55/60 clears the 90% default");
    const strict = await survey(60, { silentIds, minCoverage: 0.99 });
    assert.equal(strict.attribution.coverage.met, false, "55/60 does not clear 99%");
    assert.equal(strict.attribution.coverage.minCoverage, 0.99);
});

// Loudness: the run must SAY all this, on every run, through the log and the
// exit code. A verdict computed and never emitted is the same silence.
test("the run names every silent source in its log, threshold met or not", async () => {
    const result = await survey(60, { silentIds: ["source-003", "source-011"] });
    const events = [];
    const verdict = reportCoverage(result, (level, event, fields) => events.push({ level, event, fields }));

    const coverage = events.find((entry) => entry.event === "track1.coverage");
    assert.ok(coverage, "coverage is reported every run");
    assert.equal(coverage.fields.enabled, 60);
    assert.equal(coverage.fields.attempted, 60);
    assert.equal(coverage.fields.successfullyEvaluated, 58);
    assert.equal(coverage.fields.silent, 2);
    assert.equal(coverage.fields.threshold, DEFAULT_MIN_COVERAGE);
    assert.equal(coverage.fields.met, true);

    const named = events.filter((entry) => entry.event === "track1.source.silent").map((entry) => entry.fields.sourceId);
    assert.deepEqual(named, ["source-003", "source-011"], "each silent source gets its own log line");
    assert.equal(verdict.met, true);
});

test("falling below the threshold is logged as an error and named", async () => {
    const silentIds = Array.from({ length: 20 }, (_, i) => `source-${String(i).padStart(3, "0")}`);
    const result = await survey(60, { silentIds });
    const events = [];
    reportCoverage(result, (level, event, fields) => events.push({ level, event, fields }));

    const breach = events.find((entry) => entry.event === "track1.coverage.below-threshold");
    assert.ok(breach, "the breach is stated in its own event, not left to be inferred");
    assert.equal(breach.level, "error");
    assert.equal(breach.fields.evaluated, 40);
    assert.equal(breach.fields.enabled, 60);
    assert.equal(breach.fields.threshold, 0.9);
    assert.equal(events.filter((entry) => entry.event === "track1.source.silent").length, 20);
    for (const entry of events.filter((e) => e.event === "track1.source.silent")) {
        assert.equal(entry.level, "error", "under threshold, a silent source is an error not a warning");
    }
});

test("a run under the coverage threshold exits non-zero", async () => {
    const covered = await survey(60, { silentIds: ["source-000"] });
    assert.equal(exitCodeFor(covered, "full"), 0, "a covered run exits clean");

    const uncovered = await survey(60, { silentIds: Array.from({ length: 20 }, (_, i) => `source-${String(i).padStart(3, "0")}`) });
    assert.equal(exitCodeFor(uncovered, "full"), 4, "40 of 60 evaluated must not exit 0");
    assert.equal(exitCodeFor(uncovered, "subset"), 4, "a subset run is held to the same coverage verdict");
    assert.equal(exitCodeFor(uncovered, "dry-run"), 0, "a dry run evaluates nothing by design and is exempt");
});
