import test from "node:test";
import assert from "node:assert/strict";
import { handoffAfterRole } from "../scripts/orchard-production-runtime.mjs";

test("authoring continuation defers the Gate 2 hop so successors do not race for the lease", async () => {
    const calls = [];
    await handoffAfterRole({
        role: "authoring", roleResult: { freshQueue: { remaining: 40, claimed: 3 } }, track: "track-2",
        adapter: { peekStateCounts: async () => { calls.push("peek"); return {}; } },
        continueAuthoring: async () => { calls.push("continue"); return true; },
        chain: async () => calls.push("downstream"),
        log: () => {},
    });
    assert.deepEqual(calls, ["continue"]);
});

test("last authoring batch hands off to Gate 2 preparation", async () => {
    const calls = [];
    await handoffAfterRole({
        role: "authoring", roleResult: { freshQueue: { remaining: 0, claimed: 3 } }, track: "track-2",
        adapter: { peekStateCounts: async () => { calls.push("peek"); return { "gate2-ready": 3 }; } },
        continueAuthoring: async () => { calls.push("continue"); return false; },
        chain: async ({ counts }) => { assert.equal(counts["gate2-ready"], 3); calls.push("downstream"); },
        log: () => {},
    });
    assert.deepEqual(calls, ["continue", "peek", "downstream"]);
});
