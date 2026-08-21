import assert from "node:assert/strict";
import { test } from "node:test";
import {
    zeroDeltaMarker,
    releaseSummaryMarker,
    announceZeroDeltaSummary,
    announceReleaseSummary,
} from "../scripts/lib/run-summary.mjs";

test("zeroDeltaMarker creates deterministic marker", () => {
    const marker = zeroDeltaMarker({ track: "track-1", runId: "01912345-6789-7abc-def0-123456789abc" });
    assert.equal(marker, "<!-- orchard:summary track=track-1 run=01912345-6789-7abc-def0-123456789abc type=zero-delta -->");
});

test("releaseSummaryMarker creates deterministic marker", () => {
    const marker = releaseSummaryMarker({ version: "0.85.0" });
    assert.equal(marker, "<!-- orchard:summary release=v0.85.0 -->");
});

test("announceZeroDeltaSummary creates issue with expected content", async () => {
    const calls = [];
    const mockFetch = async (url, options) => {
        calls.push({ url, options });
        if (url.includes("/issues?state=open")) {
            return { ok: true, text: async () => JSON.stringify([]) };
        }
        if (url.includes("/issues")) {
            return {
                ok: true,
                text: async () => JSON.stringify({ number: 106, html_url: "https://github.com/project42dev/orchard/issues/106" }),
            };
        }
        if (url.includes("/user/")) {
            return { ok: true, text: async () => JSON.stringify({ login: "kristurner" }) };
        }
        return { ok: true, text: async () => "{}" };
    };

    const res = await announceZeroDeltaSummary({
        repo: "project42dev/orchard",
        track: "track-1",
        runId: "01912345-6789-7abc-def0-123456789abc",
        executionName: "caj-p42orch-t1-man-prod-eus-01-148zqf6",
        sourcesSurveyed: 23,
        probesChecked: 5,
        token: "mock-token",
        assigneeIds: ["13710532"],
        fetchImpl: mockFetch,
    });

    assert.equal(res.number, 106);
    assert.equal(res.url, "https://github.com/project42dev/orchard/issues/106");
    const createCall = calls.find((c) => c.options?.method === "POST" && c.url.endsWith("/issues"));
    assert.ok(createCall);
    const body = JSON.parse(createCall.options.body);
    assert.equal(body.title, "Orchard Run Summary: Discovery (track-1) — 0 New Opportunities (Catalog Up-to-Date)");
    assert.ok(body.body.includes("New Gaps Identified:"));
    assert.ok(body.body.includes("Approved Sources Surveyed:"));
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
