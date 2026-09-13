import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    announceReleaseSummary,
    announceRunSummary,
    coverageLine,
    isZeroDeltaRun,
    releaseSummaryMarker,
    renderRunSummary,
    runSummaryMarker,
    runSummaryTitle,
    runVerdict,
} from "../scripts/lib/run-summary.mjs";
import { loadApprovedSourceRegistry, runTrack1 } from "../scripts/lib/track-1-controller.mjs";
import { runTrack2 } from "../scripts/lib/track-2-controller.mjs";
import { explainControllerError } from "../scripts/orchard-production-runtime.mjs";

// WHAT THESE TESTS HOLD.
//
// The owner judges a scheduled run by the issue that arrives and what it says.
// Coverage, silent sources and the retired list were all computed correctly and
// reached him only through an exit code and a structured log, so a run that
// surveyed two thirds of its approved list could still post a summary reading
// like a quiet week.
//
// So every assertion below is on the RENDERED TEXT, from a verdict extracted
// from a REAL controller result that has been through JSON.
// The reason is specific and has happened here: the zero-delta summary once
// checked field names announceGates() never produced, so it never fired in
// production while its own isolated unit tests all passed. A test that asserts
// a function was called proves nothing about what the reader receives.

// ---------------------------------------------------------------- Track 1 ---

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
                ? { approval: "retired", statusReason: `retired on the owner's instruction: ${id}` }
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
    return { registryVersion: "2026-09-06", approvedSources };
}

function plantedAdapter(plan) {
    return async function fetchAdapter(source) {
        const planted = plan[source.id];
        if (planted) return { redirects: 0, bytes: 0, durationMs: 1, ...planted };
        return { kind: "success", status: 200, finalUrl: source.url, redirects: 0, bytes: 120, durationMs: 1, body: "<html>ok</html>" };
    };
}

// The controller output the runtime reads is a JSON FILE. Round-tripping it is
// the point: a verdict that only works against a live in-memory object would
// not survive the one hop that actually happens in production.
async function track1Output({ count = 60, plan = {}, retiredIds = [] } = {}) {
    const source = registry(count, { retiredIds });
    const result = await runTrack1({
        mode: "full",
        registry: source,
        registryDigest: loadApprovedSourceRegistry(source, { requirePolicyReview: true }).digest,
        allowLegacyMetadata: false,
        requirePolicyReview: true,
        contentCommit: "0".repeat(40),
        fetchAdapter: plantedAdapter(plan),
        now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    return JSON.parse(JSON.stringify({ ...result, outcomes: result.outcomes.map(({ body, ...rest }) => rest), candidates: [] }));
}

const SILENT_PLAN = {
    "source-000": { kind: "failed", reason: "host-moved", status: 301 },
    "source-001": { kind: "blocked", reason: "over-byte-cap", status: 200 },
    "source-002": { kind: "failed", reason: "not-found", status: 404 },
    "source-003": { kind: "failed", reason: "forbidden", status: 403 },
    "source-004": { kind: "rate-limited", reason: "too-many-requests", status: 429 },
    "source-005": { kind: "failed", reason: "host-moved", status: 301 },
    "source-006": { kind: "blocked", reason: "over-byte-cap", status: 200 },
};

test("a run with silent sources renders every one of them, by name, with its cause", async () => {
    const output = await track1Output({ plan: SILENT_PLAN, retiredIds: ["source-050", "source-051"] });
    assert.equal(output.attribution.coverage.met, false, "the fixture is a genuinely below-threshold run");

    const verdict = runVerdict({ track: "track-1", output });
    const body = renderRunSummary({
        track: "track-1",
        runId: "01912345-6789-7abc-def0-123456789abc",
        executionName: "caj-p42orch-t1-man-prod-eus-01-148zqf6",
        verdict,
        announced: [{ gate: "gate-1", action: "empty", count: 0 }, { gate: "gate-2", action: "empty", count: 0 }],
        now: "2026-09-06T00:00:00.000Z",
    });

    // Named individually, never summed into a count alone.
    for (const id of Object.keys(SILENT_PLAN)) {
        assert.ok(body.includes(`\`${id}\``), `${id} is named in the issue body`);
    }
    // The measured reason, not a generic "produced nothing".
    for (const reason of ["host-moved", "over-byte-cap", "not-found", "forbidden", "too-many-requests"]) {
        assert.ok(body.includes(reason), `the measured reason ${reason} reaches the reader`);
    }
    assert.ok(body.includes("HTTP 404"), "the measured status reaches the reader");

    // Coverage as a figure: attempted, evaluated, and the percentage.
    assert.ok(body.includes("`51` of `58` approved sources"), `coverage figure is present:\n${body}`);
    assert.ok(body.includes("87.9%"), "the percentage is present");
    assert.ok(body.includes("Attempted: `58`"), "attempted is present");

    // A shrinking denominator can never quietly flatter the percentage.
    assert.ok(body.includes("`source-050`") && body.includes("`source-051`"), "retired sources are named");
    assert.ok(body.includes("**retired**"), "a retired source is labelled retired, not merely disabled");

    // The below-threshold verdict is at the top, before any finding.
    const banner = body.indexOf("is BELOW the");
    assert.notEqual(banner, -1, "the below-threshold case is stated plainly");
    assert.ok(banner < body.indexOf("### What this run covered"), "the banner precedes the run detail");
    assert.ok(banner < body.indexOf("### Silent"), "the banner precedes the silent list");
});

test("the title carries the verdict rather than reading like a quiet week", async () => {
    const output = await track1Output({ plan: SILENT_PLAN });
    const verdict = runVerdict({ track: "track-1", output });
    const title = runSummaryTitle({ track: "track-1", verdict, announced: [] });
    assert.match(title, /BELOW/);
    assert.match(title, /coverage 8[0-9]\.[0-9]%/);
});

test("a clean run still states coverage, so its absence can never mean nothing happened", async () => {
    const output = await track1Output({ count: 10 });
    const verdict = runVerdict({ track: "track-1", output });
    assert.equal(verdict.met, true);
    const body = renderRunSummary({
        track: "track-1", runId: "run-clean", verdict,
        announced: [{ gate: "gate-1", action: "empty", count: 0 }],
        now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.includes("**100.0%**"), `a clean run reports its coverage figure too:\n${body}`);
    assert.ok(body.includes("`10` of `10` approved sources"));
    assert.ok(body.includes("Silent approved sources (0)"), "the silent section is present and says none");
    assert.equal(body.includes("BELOW"), false, "no false alarm on a clean run");
    assert.match(runSummaryTitle({ track: "track-1", verdict, announced: [] }), /coverage 100\.0%/);
});

test("a gate announcement that failed is named in the summary, not swallowed", () => {
    const body = renderRunSummary({
        track: "track-1", runId: "run-1", verdict: null,
        announced: [
            { gate: "gate-1", action: "created", count: 3, number: 42 },
            { gate: "gate-2", action: "failed", count: 0, reason: "GitHub returned 502" },
        ],
        now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.includes("`3` item"), "held work is stated");
    assert.ok(body.includes("issues/42"), "the gate issue is linked");
    assert.ok(body.includes("the announcement FAILED: GitHub returned 502"));
    assert.ok(body.includes("no issue was opened for it"));
});

test("duplicate gate issues that were closed are counted in the summary, so the list shrinking is explained rather than alarming", () => {
    // 2026-09-12: one evening left 53 open Gate 2 issues, 24 generations of the
    // same growing item set, because issue identity was derived from
    // membership. The reconciliation in announce-gates.mjs closes the
    // duplicates -- and 27 issues disappearing from the owner's list with the
    // summary silent about it reads exactly like work that went missing. Each
    // closure comments on its own issue; this is the count.
    const body = renderRunSummary({
        track: "track-2", runId: "run-1", verdict: null,
        announced: [
            { gate: "gate-2", action: "updated", count: 3, number: 190 },
            { gate: "gate-2", action: "closed", number: 185, count: 0 },
            { gate: "gate-2", action: "closed", number: 186, count: 0 },
            { gate: "gate-2", action: "close-held-back", number: 187, count: 0 },
        ],
        now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.includes("`2` duplicate gate issue"), "the number of closures must be stated");
    assert.ok(/no item was decided by this/i.test(body), "and it must say plainly that closing decided nothing");
    assert.ok(body.includes("`1` issue"), "an issue kept open despite looking redundant is stated too");
    assert.ok(body.includes("announced nowhere"), "with the reason it was kept");
});

test("a pass that only closed duplicates still reports them, rather than saying nothing is happening", () => {
    const body = renderRunSummary({
        track: "track-2", runId: "run-2", verdict: null,
        announced: [{ gate: "gate-2", action: "closed", number: 185, count: 0 }],
        now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.includes("`1` duplicate gate issue"), "the closure must survive the no-work-held early return");
});

// THE CASE THE RUNTIME ACTUALLY SENDS. Exit 4 IS the below-threshold verdict,
// and runController turns any non-zero exit into a throw, so a real
// below-coverage run arrives here with a controllerError AND a met:false
// verdict. If the failure branch wins, the owner reads "RUN FAILED" and the
// coverage statement is demoted into the detail -- the exact burial this change
// exists to prevent.
test("a below-threshold run leads with the coverage verdict even though it also failed", async () => {
    const output = await track1Output({ plan: SILENT_PLAN });
    const verdict = runVerdict({ track: "track-1", output });
    const controllerError = "the run surveyed less of its approved list than the coverage threshold allows (exit code 4).";

    assert.match(runSummaryTitle({ track: "track-1", verdict, announced: [], controllerError }), /BELOW/);

    const body = renderRunSummary({
        track: "track-1", runId: "run-below", verdict, announced: [], controllerError,
        now: "2026-09-06T00:00:00.000Z",
    });
    const coverage = body.indexOf("is BELOW the");
    const failure = body.indexOf("did not complete");
    assert.notEqual(coverage, -1);
    assert.notEqual(failure, -1);
    assert.ok(coverage < failure, "the coverage verdict leads; the raw failure follows it as detail");
    assert.ok(failure < body.indexOf("### What this run covered"), "both are above the detail");
    assert.ok(body.includes("`source-000`"), "a failed run still names its silent sources");
    assert.equal(body.includes("exit code 4"), true, "the raw cause is still there, as detail");
});

test("the exit code the runtime throws is translated into something a reader can act on", () => {
    assert.equal(
        explainControllerError(new Error("controller set exit code 4")),
        "the run surveyed less of its approved list than the coverage threshold allows (exit code 4).",
    );
    assert.equal(explainControllerError(null), null);
    assert.equal(explainControllerError(new Error("ENOENT")), "ENOENT", "an unmapped failure is passed through unchanged");
});

test("a run that died before finishing still announces, with the failure at the top", () => {
    const title = runSummaryTitle({ track: "track-1", verdict: null, announced: [], controllerError: "controller set exit code 4" });
    assert.equal(title, "Orchard Run Summary: Discovery (track-1) — RUN FAILED");
    const body = renderRunSummary({
        track: "track-1", runId: "run-1", verdict: null, announced: [],
        controllerError: "controller set exit code 4", now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.startsWith(runSummaryMarker({ track: "track-1", runId: "run-1" })));
    assert.ok(body.indexOf("This run did not complete") < body.indexOf("### What this run covered"));
    assert.ok(body.includes("no controller output"), "a summary with nothing measured says so rather than implying zero");
});

test("coverageLine never renders an empty measurement as a clean one", () => {
    assert.match(coverageLine(null), /no controller output/);
});

// ---------------------------------------------------------------- Track 2 ---

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function platformFixture(t) {
    const root = mkdtempSync(join(tmpdir(), "orchard-summary-platform-"));
    for (const directory of ["content/modules", "content/resources", "content/diagrams"]) mkdirSync(join(root, directory), { recursive: true });
    writeJson(join(root, "content/catalog.json"), {
        schemaVersion: "1.0.0", contentVersion: "test",
        paths: [{ id: "path-a", title: "A" }],
        modules: [{ id: "module-a", title: "Module" }],
        resources: [{ id: "resource-a", title: "Resource" }],
    });
    writeJson(join(root, "content/modules/module-a.json"), { id: "module-a", body: "canonical module" });
    writeJson(join(root, "content/resources/resource-a.json"), { id: "resource-a", body: "canonical resource" });
    writeJson(join(root, "content/diagrams/catalogue.json"), {
        $schemaVersion: "1.0.0", renderer: "mermaid", diagrams: [{ id: "diagram-a", source: "diagram-a.mmd" }],
    });
    writeFileSync(join(root, "content/diagrams/diagram-a.mmd"), "graph TD; A-->B;\n", "utf8");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

const TRACK_2_COMMIT = "3".repeat(40);

async function track2Output(t, { failIds = [] } = {}) {
    const root = platformFixture(t);
    const result = await runTrack2({
        mode: "full",
        platformRoot: root,
        contentCommit: TRACK_2_COMMIT,
        commitVerifier: (_root, commit) => commit,
        expectedCanonicalItems: 6,
        inspector: async (item) => {
            if (failIds.includes(item.stableId)) throw new Error("inspection produced no usable answer");
            return { classification: "evidence-backed-no-change", evidence: [`digest:${item.digest}`] };
        },
    });
    return JSON.parse(JSON.stringify(result));
}

test("a currency run announces its own verdict: what was inspected, what it found", async (t) => {
    const output = await track2Output(t);
    const verdict = runVerdict({ track: "track-2", output });
    const body = renderRunSummary({
        track: "track-2", runId: "run-t2", verdict,
        announced: [{ gate: "gate-1", action: "empty", count: 0 }],
        now: "2026-09-06T00:00:00.000Z",
    });
    assert.ok(body.includes("Orchard run summary: Currency"));
    assert.ok(body.includes(`\`${verdict.expected}\` of \`${verdict.expected}\` published items`), `Track 2 states its own coverage:\n${body}`);
    assert.ok(body.includes("**100.0%**"));
    assert.ok(body.includes("Currency findings held:"), "how many published items produced findings");
    assert.ok(body.includes("Silent published items (0)"));
    assert.equal(body.includes("Approved Sources Surveyed"), false, "Track 2 never describes canonical items as approved sources");
});

test("a currency run names every item that failed silently", async (t) => {
    const output = await track2Output(t, { failIds: ["guide-diagram:diagram-a"] });
    const verdict = runVerdict({ track: "track-2", output });
    assert.equal(verdict.met, false, "an item that produced no classification is not covered");
    const body = renderRunSummary({ track: "track-2", runId: "run-t2", verdict, announced: [], now: "2026-09-06T00:00:00.000Z" });
    assert.ok(body.includes("`guide-diagram:diagram-a`"), `the failed item is named:\n${body}`);
    assert.ok(body.includes("inspection produced no usable answer"), "with the reason it produced nothing");
    assert.ok(body.indexOf("is BELOW the") < body.indexOf("### Silent"), "the shortfall is stated at the top");
});

// ------------------------------------------------------------- the wiring ---

// Regression coverage for the shape announceGates() actually returns
// ({ gate, action, count }, with an empty gate as action: "empty"). The
// summary trigger previously checked a.items and a.action === "none" -- fields
// announceGates() never produces -- so it silently never fired in production
// even after the feature was deployed and even though its isolated unit tests
// all passed.
test("isZeroDeltaRun is true when every gate is empty", () => {
    assert.equal(isZeroDeltaRun([
        { gate: "gate-1", action: "empty", count: 0 },
        { gate: "gate-2", action: "empty", count: 0 },
    ]), true);
});

test("isZeroDeltaRun is true for no announcements at all", () => {
    assert.equal(isZeroDeltaRun([]), true);
    assert.equal(isZeroDeltaRun(null), true);
    assert.equal(isZeroDeltaRun(undefined), true);
});

test("isZeroDeltaRun is false when any gate actually announced work", () => {
    assert.equal(isZeroDeltaRun([
        { gate: "gate-1", action: "empty", count: 0 },
        { gate: "gate-2", action: "created", count: 3, number: 42 },
    ]), false);
});

test("runSummaryMarker creates deterministic marker", () => {
    const marker = runSummaryMarker({ track: "track-1", runId: "01912345-6789-7abc-def0-123456789abc" });
    assert.equal(marker, "<!-- orchard:summary track=track-1 run=01912345-6789-7abc-def0-123456789abc type=run -->");
});

test("releaseSummaryMarker creates deterministic marker", () => {
    const marker = releaseSummaryMarker({ version: "0.85.0" });
    assert.equal(marker, "<!-- orchard:summary release=v0.85.0 -->");
});

test("announceRunSummary posts the rendered verdict, not a placeholder", async () => {
    const calls = [];
    const mockFetch = async (url, options) => {
        calls.push({ url, options });
        if (url.includes("/issues?state=open")) return { ok: true, text: async () => JSON.stringify([]) };
        if (url.includes("/user/")) return { ok: true, text: async () => JSON.stringify({ login: "kristurner" }) };
        if (url.includes("/issues")) {
            return { ok: true, text: async () => JSON.stringify({ number: 106, html_url: "https://github.com/project42dev/orchard/issues/106" }) };
        }
        return { ok: true, text: async () => "{}" };
    };

    const output = await track1Output({ plan: SILENT_PLAN });
    const res = await announceRunSummary({
        repo: "project42dev/orchard",
        track: "track-1",
        runId: "01912345-6789-7abc-def0-123456789abc",
        executionName: "caj-p42orch-t1-man-prod-eus-01-148zqf6",
        verdict: runVerdict({ track: "track-1", output }),
        announced: [{ gate: "gate-1", action: "empty", count: 0 }],
        token: "mock-token",
        assigneeIds: ["13710532"],
        fetchImpl: mockFetch,
    });

    assert.equal(res.number, 106);
    const createCall = calls.find((c) => c.options?.method === "POST" && c.url.endsWith("/issues"));
    assert.ok(createCall);
    const body = JSON.parse(createCall.options.body);
    assert.match(body.title, /BELOW/);
    assert.ok(body.body.includes("`source-000`"), "the posted body names the silent sources");
    assert.ok(body.body.includes("Coverage:"), "the posted body states coverage");
    assert.deepEqual(body.labels, ["orchard:summary", "track:track-1"]);
});

test("announceReleaseSummary creates issue with expected content", async () => {
    const calls = [];
    const mockFetch = async (url, options) => {
        calls.push({ url, options });
        if (url.includes("/issues?state=open")) {
            return { ok: true, text: async () => JSON.stringify([]) };
        }
        if (url.includes("/issues")) {
            return {
                ok: true,
                text: async () => JSON.stringify({ number: 107, html_url: "https://github.com/project42dev/orchard/issues/107" }),
            };
        }
        if (url.includes("/user/")) {
            return { ok: true, text: async () => JSON.stringify({ login: "kristurner" }) };
        }
        return { ok: true, text: async () => "{}" };
    };

    const res = await announceReleaseSummary({
        repo: "project42dev/orchard",
        version: "0.85.0",
        sitesBumped: ["project42dev/learn.project-42.dev"],
        newestTag: "v0.84.0",
        token: "mock-token",
        assigneeIds: ["13710532"],
        fetchImpl: mockFetch,
    });

    assert.equal(res.number, 107);
    assert.equal(res.url, "https://github.com/project42dev/orchard/issues/107");
    const createCall = calls.find((c) => c.options?.method === "POST" && c.url.endsWith("/issues"));
    assert.ok(createCall);
    const body = JSON.parse(createCall.options.body);
    assert.equal(body.title, "Orchard Run Summary: Production Release v0.85.0 Deployed");
    assert.ok(body.body.includes("project42dev/learn.project-42.dev"));
});
