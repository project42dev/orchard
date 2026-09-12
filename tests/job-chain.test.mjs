import assert from "node:assert/strict";
import { test } from "node:test";
import { chainNextRoles, continueAuthoringChain, startJob } from "../scripts/lib/job-chain.mjs";

function fakeToken(value = "fake-token") {
    return async () => value;
}

test("startJob posts to the ARM start endpoint with a bearer token", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ name: "exec-1" }) };
    };
    const result = await startJob({
        jobResourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/jobs/caj-auth",
        tokenProvider: fakeToken("abc123"),
        fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/jobs/caj-auth/start?api-version=2024-03-01");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "Bearer abc123");
    assert.deepEqual(result, { name: "exec-1" });
});

test("startJob throws with the response body on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden detail" });
    await assert.rejects(
        () => startJob({ jobResourceId: "/x", tokenProvider: fakeToken(), fetchImpl }),
        /HTTP 403.*forbidden detail/s,
    );
});

test("startJob's thrown error carries the ARM status code as a property, not only in the message", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden detail" });
    try {
        await startJob({ jobResourceId: "/x", tokenProvider: fakeToken(), fetchImpl });
        assert.fail("startJob should have thrown");
    } catch (error) {
        assert.equal(error.statusCode, 403);
    }
});

test("chainNextRoles triggers exactly the hops with waiting work and a configured job id", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const env = {
        ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth",
        ORCHARD_CHAIN_GATE2PREP_JOB_ID: "/jobs/caj-g2p",
        // publication hop deliberately left unconfigured
    };
    const logs = [];
    const triggered = await chainNextRoles({
        counts: { "ado-linked": 3, "gate2-ready": 0, "gate2-approved": 5 },
        env,
        tokenProvider: fakeToken(),
        fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    // authoring: ado-linked=3, configured -> triggered.
    // gate2-prep: gate2-ready=0 -> not triggered even though configured.
    // publication: gate2-approved=5, NOT configured -> not triggered.
    assert.deepEqual(triggered, ["authoring"]);
    assert.equal(started.length, 1);
    assert.match(started[0], /caj-auth\/start/);
    assert.ok(logs.some((l) => l.event === "chain.triggered" && l.detail.role === "authoring"));
});

test("chainNextRoles keeps trying remaining hops when one hop's trigger fails", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ name: "exec" }) });
    let call = 0;
    const tokenProvider = async () => { call += 1; if (call === 1) throw new Error("token acquisition failed"); return "ok"; };
    const env = {
        ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth",
        ORCHARD_CHAIN_GATE2PREP_JOB_ID: "/jobs/caj-g2p",
    };
    const logs = [];
    const triggered = await chainNextRoles({
        counts: { "ado-linked": 1, "gate2-ready": 1 },
        env,
        tokenProvider,
        fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    // authoring's token fetch throws first and is caught+logged; gate2-prep's
    // own hop still runs and succeeds independently.
    assert.deepEqual(triggered, ["gate2-prep"]);
    assert.ok(logs.some((l) => l.event === "chain.trigger-failed" && l.detail.role === "authoring" && /token acquisition failed/.test(l.detail.error)));
    assert.ok(logs.some((l) => l.event === "chain.triggered" && l.detail.role === "gate2-prep"));
});

test("chainNextRoles does nothing when no hop is configured", async () => {
    const triggered = await chainNextRoles({ counts: { "ado-linked": 99 }, env: {}, tokenProvider: fakeToken() });
    assert.deepEqual(triggered, []);
});

test("chainNextRoles never triggers a role's own hop, even with real waiting work -- reproduces the live self-trigger loop", async () => {
    // Live incident, 2026-08-16: gate2-prep held an item for missing evidence,
    // its own post-run check saw the same gate2-ready count unchanged, and
    // re-triggered itself -- an unbounded loop, only stopped by patching the
    // job's env var directly in production. This is the regression test for
    // the actual fix: currentRole must exclude a role from triggering itself.
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const env = { ORCHARD_CHAIN_GATE2PREP_JOB_ID: "/jobs/caj-g2p" };
    const triggered = await chainNextRoles({
        counts: { "gate2-ready": 1 }, env, tokenProvider: fakeToken(), fetchImpl, currentRole: "gate2-prep",
    });
    assert.deepEqual(triggered, []);
    assert.equal(started.length, 0);
});

test("chainNextRoles still lets a DIFFERENT role trigger the hop currentRole would have been excluded from", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ name: "exec" }) });
    const env = { ORCHARD_CHAIN_GATE2PREP_JOB_ID: "/jobs/caj-g2p" };
    const triggered = await chainNextRoles({
        counts: { "gate2-ready": 1 }, env, tokenProvider: fakeToken(), fetchImpl, currentRole: "authoring",
    });
    assert.deepEqual(triggered, ["gate2-prep"]);
});

test("the authoring hop counts ado-linked and authoring-recoverable work together", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    // ado-linked alone is 0, but authoring-recoverable (the crashed-run
    // backlog generateBriefs.mjs also picks up) is not -- must still fire.
    const triggered = await chainNextRoles({
        counts: { "ado-linked": 0, "authoring-recoverable": 11 }, env, tokenProvider: fakeToken(), fetchImpl,
    });
    assert.deepEqual(triggered, ["authoring"]);
    assert.equal(started.length, 1);
});

test("chainNextRoles logs a failed hop start at error level with the ARM status code, never swallowed", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "the identity lacks Microsoft.App/jobs/start/action" });
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    const logs = [];
    const triggered = await chainNextRoles({
        counts: { "ado-linked": 1 }, env, tokenProvider: fakeToken(), fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    assert.deepEqual(triggered, []);
    const failure = logs.find((l) => l.event === "chain.trigger-failed");
    assert.ok(failure, "a failed start must be logged, not swallowed");
    assert.equal(failure.level, "error");
    assert.equal(failure.detail.statusCode, 403);
});

// continueAuthoringChain: authoring's OWN continuation while its
// stranded-recovery sweep still has a backlog only THIS role can drain --
// proven live 2026-09-11/12 to never fire on its own, because chainNextRoles'
// currentRole guard (tested above) correctly refuses authoring's cross-role
// "ado-linked" hop from re-triggering itself, and no hop was ever watching
// the stranded gate2-ready backlog at all.

test("continueAuthoringChain starts another authoring run while stranded work remains and progress was made", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec-2" }) }; };
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    const logs = [];
    const triggered = await continueAuthoringChain({
        strandedRecovery: { stranded: 96, recovered: [{ item: "i1" }, { item: "i2" }], refused: [], remaining: 91 },
        env, tokenProvider: fakeToken(), fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    assert.equal(triggered, true);
    assert.equal(started.length, 1);
    assert.match(started[0], /caj-auth\/start/);
    assert.ok(logs.some((l) => l.event === "chain.continue.triggered" && l.detail.remaining === 91 && l.detail.recovered === 2));
});

test("continueAuthoringChain stops, and says why, when a run recovers 0 items", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    const logs = [];
    const triggered = await continueAuthoringChain({
        strandedRecovery: { stranded: 91, recovered: [], refused: [{ item: "i3", reason: "already recovered automatically 2 time(s)" }], remaining: 91 },
        env, tokenProvider: fakeToken(), fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    assert.equal(triggered, false);
    assert.equal(started.length, 0, "a run that made no progress must not spend another execution rediscovering the same backlog");
    const stop = logs.find((l) => l.event === "chain.continue.stopped");
    assert.ok(stop, "the deliberate stop must be logged, not silent");
    assert.equal(stop.level, "warn");
    assert.equal(stop.detail.remaining, 91);
    assert.match(stop.detail.reason, /recovered 0 items/);
});

test("continueAuthoringChain does nothing once the stranded backlog is drained", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    const triggered = await continueAuthoringChain({
        strandedRecovery: { stranded: 2, recovered: [{ item: "i1" }, { item: "i2" }], refused: [], remaining: 0 },
        env, tokenProvider: fakeToken(), fetchImpl,
    });
    assert.equal(triggered, false);
    assert.equal(started.length, 0);
});

test("continueAuthoringChain is off by default: no configured job id means no attempt at all", async () => {
    const started = [];
    const fetchImpl = async (url) => { started.push(url); return { ok: true, json: async () => ({ name: "exec" }) }; };
    const triggered = await continueAuthoringChain({
        strandedRecovery: { stranded: 5, recovered: [{ item: "i1" }], refused: [], remaining: 4 },
        env: {}, tokenProvider: fakeToken(), fetchImpl,
    });
    assert.equal(triggered, false);
    assert.equal(started.length, 0);
});

test("continueAuthoringChain logs a failed restart at error level with the ARM status code, never swallowed", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "the identity lacks Microsoft.App/jobs/start/action" });
    const env = { ORCHARD_CHAIN_AUTHORING_JOB_ID: "/jobs/caj-auth" };
    const logs = [];
    const triggered = await continueAuthoringChain({
        strandedRecovery: { stranded: 91, recovered: [{ item: "i1" }], refused: [], remaining: 90 },
        env, tokenProvider: fakeToken(), fetchImpl,
        log: (level, event, detail) => logs.push({ level, event, detail }),
    });
    assert.equal(triggered, false);
    const failure = logs.find((l) => l.event === "chain.continue.trigger-failed");
    assert.ok(failure, "a failed restart must be logged, not swallowed");
    assert.equal(failure.level, "error");
    assert.equal(failure.detail.statusCode, 403);
});
