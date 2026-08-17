import assert from "node:assert/strict";
import { test } from "node:test";
import { chainNextRoles, startJob } from "../scripts/lib/job-chain.mjs";

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
