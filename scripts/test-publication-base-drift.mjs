#!/usr/bin/env node
// Found live 2026-08-19, on the first run that ever merged anything: nine
// owner-approved items all carried the same base_commit, the first one
// merged, main advanced, and the remaining eight were refused forever with
//   protected-main:<old> does not exactly match: commit: expected <old>,
//   observed <new>
// The pipeline could publish exactly one item per run and then hard-block --
// and after that first merge, re-running published nothing at all, because no
// pending item could match the new main either.
//
// These tests pin the behaviour that fixes it: main advancing is observed and
// tolerated, main disappearing is still fatal, and any other adapter failure
// still propagates untouched rather than being swallowed as "drift".

import assert from "node:assert/strict";
import { test } from "node:test";
import { observeProtectedMain } from "./lib/publication.mjs";

const OLD_MAIN = "6".repeat(40);
const NEW_MAIN = "8".repeat(40);
const binding = { base_commit: OLD_MAIN };

// The real adapter's shape: a PublicationProviderError carrying code
// 'provider.mismatch' and a message naming both commits. Reproduced here
// rather than imported, so this test keeps passing against the pinned
// artifact's real error text without importing the pinned artifact.
function mismatchError(expected, observed) {
    const error = new Error(`protected-main:${expected} does not exactly match the requested fields: commit: expected "${expected}", observed "${observed}"`);
    error.code = "provider.mismatch";
    return error;
}

test("main that has advanced past the approved base is observed, not refused -- the exact case that blocked eight approved items", async () => {
    const adapter = {
        async reconcileProtectedMain() { throw mismatchError(OLD_MAIN, NEW_MAIN); },
    };
    const observed = await observeProtectedMain(adapter, binding);
    assert.equal(observed.drifted, true, "a moved main is reported as drift rather than thrown");
    assert.equal(observed.observedCommit, NEW_MAIN, "the commit main actually sits at is read back out of the refusal");
    assert.equal(observed.object.commit, NEW_MAIN);
    assert.equal(observed.object.branch, "main");
});

test("main sitting exactly at the approved base still reconciles clean, with no drift reported", async () => {
    const adapter = {
        async reconcileProtectedMain({ expectedCommit }) {
            return { classification: "exact", object: { repository: "project42dev/project42-platform", branch: "main", commit: expectedCommit } };
        },
    };
    const observed = await observeProtectedMain(adapter, binding);
    assert.equal(observed.drifted, false);
    assert.equal(observed.observedCommit, OLD_MAIN);
});

test("protected main that does not exist is still fatal -- there is nothing to publish onto", async () => {
    const adapter = {
        async reconcileProtectedMain() { return { classification: "absent", object: null }; },
    };
    await assert.rejects(() => observeProtectedMain(adapter, binding), /protected main does not exist to publish onto/);
});

test("any failure that is not a commit mismatch propagates untouched, never swallowed as drift", async () => {
    const transport = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    const adapter = { async reconcileProtectedMain() { throw transport; } };
    await assert.rejects(() => observeProtectedMain(adapter, binding), /ECONNRESET/);
});

test("a mismatch whose message carries no readable commit is refused rather than guessed at", async () => {
    const vague = Object.assign(new Error("protected-main refused for reasons it did not name"), { code: "provider.mismatch" });
    const adapter = { async reconcileProtectedMain() { throw vague; } };
    await assert.rejects(() => observeProtectedMain(adapter, binding), /did not name/);
});

// --- acknowledgement, after main has moved past our own merge commit -------
// Found live 2026-08-19 in the SAME run that merged all nine items: every
// item except the last was left at publication-merging forever, because each
// later merge advanced main past the earlier item's result commit before its
// acknowledgement was read. Tip equality asked about whoever committed last;
// what matters is whether the provider still reports OUR pull request merged
// at OUR exact commit.

import { acknowledgePublication } from "./lib/publication.mjs";

const RESULT_COMMIT = "a".repeat(40);
const LATER_MAIN = "b".repeat(40);
const MERGED_PULL = { number: 153, state: "merged", mergeCommit: RESULT_COMMIT };

function ackStore({ state = "acknowledging", events = [] } = {}) {
    let publishedEvent = null;
    return {
        requirePublicationAdapter: () => ({ adapter_digest: "sha256:" + "0".repeat(64), adapter_identity: "test" }),
        recordPublicationAuthority: () => {},
        findPublicationEvent: () => null,
        recordPublicationEvent: (record) => { if (record.state === "published") publishedEvent = record; return record; },
        getPublicationState: () => publishedEvent
            ? { state: "published", transaction: { transaction_id: "t1" }, events, result_commit: RESULT_COMMIT, push_acknowledgement: publishedEvent.push_acknowledgement }
            : { state, transaction: { transaction_id: "t1" }, events, result_commit: RESULT_COMMIT, push_acknowledgement: null },
    };
}

test("a publication whose merge commit main has already moved past is still acknowledged, on the provider's own report of the merge", async () => {
    const adapter = {
        async reconcileProtectedMain() { throw mismatchError(RESULT_COMMIT, LATER_MAIN); },
        async reconcileMerge({ pullNumber }) {
            assert.equal(pullNumber, 153, "the recorded merged pull request is the one re-checked");
            return { classification: "exact", object: MERGED_PULL };
        },
    };
    const result = await acknowledgePublication({
        idempotencyKey: "publication:track-1:item:r1:sha256:x", adapter,
        store: ackStore({ events: [{ intent_or_result: "result", pull_request: MERGED_PULL }] }),
        now: () => "2026-08-19T00:00:00.000Z",
    });
    assert.equal(result.state, "published", "the item reaches published rather than stranding at publication-merging");
});

test("main moving past a merge commit with no recorded merged pull request is refused, never assumed published", async () => {
    const adapter = {
        async reconcileProtectedMain() { throw mismatchError(RESULT_COMMIT, LATER_MAIN); },
        async reconcileMerge() { throw new Error("must not be reached"); },
    };
    await assert.rejects(() => acknowledgePublication({
        idempotencyKey: "k", adapter, store: ackStore({ events: [] }), now: () => "2026-08-19T00:00:00.000Z",
    }), /no merged pull request was recorded/);
});

test("a provider that reports a different merge commit than the one recorded is refused", async () => {
    const adapter = {
        async reconcileProtectedMain() { throw mismatchError(RESULT_COMMIT, LATER_MAIN); },
        async reconcileMerge() { return { classification: "exact", object: { ...MERGED_PULL, mergeCommit: "c".repeat(40) } }; },
    };
    await assert.rejects(() => acknowledgePublication({
        idempotencyKey: "k", adapter,
        store: ackStore({ events: [{ intent_or_result: "result", pull_request: MERGED_PULL }] }),
        now: () => "2026-08-19T00:00:00.000Z",
    }), /merged at the exact recorded commit/);
});
