// Defect 2 of the 2026-09-13 authoring-brief fix: the Track 2 inspector called
// 2026-07-25 "a future date" while the inspection ran in September 2026,
// because nothing in its request said what today is. See
// scripts/lib/inspection-dates.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFoundryInspectionProducer, estimateFoundryInspectionCost } from "../scripts/lib/foundry-inspection-producer.mjs";
import { isFalseFutureDateClaim, withdrawFalseFutureDateEvidence, isoDateOf } from "../scripts/lib/inspection-dates.mjs";
import { sha256Digest } from "../scripts/lib/identity.mjs";

const TODAY = "2026-09-13";
const NOW = () => new Date("2026-09-13T15:04:05.000Z");
// The wording is the production finding's shape: a lastVerified date on or
// before today, described as the future.
const FALSE_FINDING = "lastVerified is 2026-07-25, a future date, so the verification record cannot be trusted.";
const REAL_FINDING = "The OpenAI evaluation guide source was last verified 2026-07-25 and has passed its 30-day review cadence.";

function fixture(sourceText) {
    const root = mkdtempSync(join(tmpdir(), "orchard-inspection-date-"));
    writeFileSync(join(root, "content.json"), sourceText);
    const item = { stableId: "guide:fact-verification-workflow", sourcePath: "content.json", digest: sha256Digest("item"), sourceDigest: sha256Digest(Buffer.from(sourceText)) };
    return { root, item };
}

function clientReturning(result, capture) {
    return {
        responses: {
            create: async (request) => {
                capture.request = request;
                return { id: "resp-1", status: "completed", usage: { input_tokens: 10, output_tokens: 10 }, output_text: JSON.stringify(result) };
            },
        },
    };
}

test("the exact production case: 2026-07-25 called future on 2026-09-13 is a false claim", () => {
    assert.equal(isFalseFutureDateClaim(FALSE_FINDING, TODAY), true);
    assert.equal(isFalseFutureDateClaim(REAL_FINDING, TODAY), false, "a cadence finding that says nothing about the future is left alone");
    assert.equal(isFalseFutureDateClaim("lastVerified 2026-12-01 is a future date", TODAY), false, "a date that really is later than today may be called future");
    assert.equal(isFalseFutureDateClaim("the record is future-dated", TODAY), false, "no date named means nothing to check, so nothing is dropped");
    assert.equal(isFalseFutureDateClaim("Checked 2026-09-13, which has not yet occurred.", TODAY), true, "today itself is not the future");
    assert.equal(isFalseFutureDateClaim("The inspection's characterization of 2026-07-25 as a future date is wrong.", TODAY), true, "the drafter's own phrasing of the production claim");
    assert.equal(isFalseFutureDateClaim("lastVerified 2026-07-25 is future-dated", TODAY), true);
    // Ordinary prose that merely contains the word must never be withdrawn:
    // these are real findings, and withdrawing them would hide real work.
    assert.equal(isFalseFutureDateClaim("The future-proofing guidance should name the version checked; lastVerified 2026-07-25.", TODAY), false, "future-proofing is not a date claim");
    assert.equal(isFalseFutureDateClaim("Future versions of the SDK rename this key; source last verified 2026-07-25.", TODAY), false, "future versions is not a date claim");
});

test("the inspector is told today's date in its instructions and its input", async () => {
    const { root, item } = fixture('{"lastVerified":"2026-07-25"}');
    const capture = {};
    try {
        const producer = createFoundryInspectionProducer({
            endpoint: "https://example.test/", deployment: "model", policy: "fixed policy", now: NOW,
            client: clientReturning({ classification: "evidence-backed-no-change", evidence: ["current"] }, capture),
        });
        await producer(item, root);
        assert.match(capture.request.instructions, /Today's date is 2026-09-13 \(UTC\)/, "the grounding names the date");
        assert.match(capture.request.instructions, /NEVER a future date/);
        assert.equal(JSON.parse(capture.request.input).current_date, TODAY, "and the structured input carries it as a field");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a correction built only on the false future-date claim produces no finding", async () => {
    const { root, item } = fixture('{"lastVerified":"2026-07-25"}');
    const capture = {};
    try {
        const producer = createFoundryInspectionProducer({
            endpoint: "https://example.test/", deployment: "model", policy: "fixed policy", now: NOW,
            client: clientReturning({ classification: "correction", evidence: [FALSE_FINDING] }, capture),
        });
        const result = await producer(item, root);
        assert.equal(result.classification, "evidence-backed-no-change", "no actionable classification survives a date error");
        assert.equal(result.evidence.length, 1);
        assert.match(result.evidence[0], /Withdrawn by Orchard: the inspection ran on 2026-09-13/);
        assert.deepEqual(result.withdrawnEvidence, [FALSE_FINDING], "what was withdrawn is kept on the result for audit");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a finding with real evidence beside the false claim keeps the real evidence only", async () => {
    const { root, item } = fixture('{"lastVerified":"2026-07-25"}');
    const capture = {};
    try {
        const producer = createFoundryInspectionProducer({
            endpoint: "https://example.test/", deployment: "model", policy: "fixed policy", now: NOW,
            client: clientReturning({ classification: "update", evidence: [FALSE_FINDING, REAL_FINDING] }, capture),
        });
        const result = await producer(item, root);
        assert.equal(result.classification, "update");
        assert.deepEqual(result.evidence, [REAL_FINDING]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the cost estimate reserves the grounding bytes it will actually send", () => {
    const { root, item } = fixture("x");
    try {
        const withDate = estimateFoundryInspectionCost({ items: [item], platformRoot: root, policy: "p", maxOutputTokens: 1, maxRequests: 1, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, now: NOW });
        assert.ok(withDate.inputTokenUpperBound > Buffer.byteLength("p") + 4000 + 200, "the estimate includes the grounding paragraph");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withdrawal and date helpers", () => {
    assert.equal(isoDateOf(NOW), TODAY);
    const kept = withdrawFalseFutureDateEvidence({ classification: "evidence-backed-no-change", evidence: ["fine"] }, TODAY);
    assert.deepEqual(kept.withdrawn, []);
    assert.deepEqual(kept.evidence, ["fine"]);
});
