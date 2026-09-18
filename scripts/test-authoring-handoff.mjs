import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffAfterRole } from "./orchard-production-runtime.mjs";

test("an engine failure with claimed work does not start another paid authoring run", async () => {
    let continuations = 0;
    let downstream = 0;
    const events = [];
    await handoffAfterRole({
        role: "authoring",
        roleResult: { briefs: 3, applied: 0, deliveryFailed: true, freshQueue: { remaining: 26, claimed: 3 } },
        adapter: { peekStateCounts: async () => ({ "ado-linked": 26 }) }, track: "track-2",
        continueAuthoring: async () => { continuations++; return true; },
        chain: async () => { downstream++; },
        log: (_level, event) => events.push(event),
    });
    assert.equal(continuations, 0);
    assert.equal(downstream, 0);
    assert.ok(events.includes("chain.continue.stopped"));
});

test("a targeted authoring run can hand off Gate 2 without starting the unrestricted queue", async () => {
    const previous = process.env.ORCHARD_AUTHORING_ITEM_IDS;
    process.env.ORCHARD_AUTHORING_ITEM_IDS = "01a0affb-3aa8-73f1-b500-124693d10524";
    try {
        let continuations = 0;
        let chainEnv;
        await handoffAfterRole({
            role: "authoring", roleResult: { briefs: 1, applied: 1 },
            adapter: { peekStateCounts: async () => ({ "ado-linked": 28, "gate2-ready": 1 }) }, track: "track-2",
            continueAuthoring: async () => { continuations++; return true; },
            chain: async ({ env }) => { chainEnv = env; },
            log: () => {},
        });
        assert.equal(continuations, 0);
        assert.equal(chainEnv.ORCHARD_CHAIN_AUTHORING_JOB_ID, "");
    } finally {
        if (previous === undefined) delete process.env.ORCHARD_AUTHORING_ITEM_IDS;
        else process.env.ORCHARD_AUTHORING_ITEM_IDS = previous;
    }
});
