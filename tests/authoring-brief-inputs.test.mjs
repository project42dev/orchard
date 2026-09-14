// Defect 1 of the 2026-09-13 authoring-brief fix: a Track 2 currency update
// brief never gave the drafter the file it was correcting, its filename, its
// source records or the date, and the drafter refused. See
// scripts/generate-briefs.mjs existingContentFor.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBriefs, existingContentFor, ROLE_JOBS, DEFAULT_TARGETS_PATH } from "../scripts/generate-briefs.mjs";
import { GATE_MANIFEST_REFERENCE_PREFIX } from "../scripts/lib/gate-queue.mjs";
import { generateUuidV7, sha256Digest } from "../scripts/lib/identity.mjs";
import { estate, walkTo, NOW } from "../scripts/test-fixtures.mjs";

const SOURCE_PATH = "content/resources/research-verification/fact-verification-workflow.json";
const TARGET_PATH = "resources/research-verification/fact-verification-workflow.json";
const RESOURCE = readFileSync(new URL("./fixtures/fact-verification-workflow.json", import.meta.url));
const SNAPSHOT_COMMIT = "a".repeat(40);
const FALSE_FINDING = "lastVerified is 2026-07-25, a future date, so the verification record cannot be trusted.";
const REAL_FINDING = "The NIST and Google sources were last verified 2026-07-25; the record-verification section's reproduction guidance should name the version checked.";

function corpus(bytes = RESOURCE) {
    const root = mkdtempSync(join(tmpdir(), "orchard-corpus-brief-"));
    mkdirSync(join(root, "content", "resources", "research-verification"), { recursive: true });
    writeFileSync(join(root, SOURCE_PATH), bytes);
    writeFileSync(join(root, ".orchard-corpus-manifest.json"), JSON.stringify({ commit: SNAPSHOT_COMMIT }));
    return root;
}

function staffing() {
    const directory = mkdtempSync(join(tmpdir(), "orchard-brief-staff-"));
    const inventoryPath = join(directory, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({ "model-a": { format: "VendorOne" }, "model-b": { format: "VendorTwo" }, "model-c": { format: "VendorThree" }, "model-d": { format: "VendorFour" } }));
    const mapPath = join(directory, "map.json");
    const models = { researcher: "model-a", drafter: "model-a", verifier: "model-b", adversary: "model-c", arbiter: "model-d", finalizer: "model-d" };
    writeFileSync(mapPath, JSON.stringify({ jobs: Object.fromEntries(Object.entries(models).map(([role, model]) => [ROLE_JOBS[role], { model }])) }));
    return { inventoryPath, mapPath };
}

/** A Track 2 currency correction exactly as currencyCandidateFor records one, walked to ado-linked. */
async function currencyItem() {
    // The fixture run manifest is Track 1 shaped; the item is Track 2's. Brief
    // generation reads the run only for its content_commit, which both carry.
    const { store, runId, dbPath } = await estate();
    const itemId = generateUuidV7();
    await store.recordItem({
        schema_version: "1.0.0", item_id: itemId, run_id: runId, track: "track-2", item_revision: 1,
        semantic_identity: `sid:v1:${sha256Digest("guide:fact-verification-workflow").slice(7)}`,
        surface: "guide", outcome: "correction", state: "observed",
        proposal_digest: sha256Digest("proposal"), artifact_digest: null,
        target: { repository: "project42dev/project42-content", path: TARGET_PATH },
        evidence: [{ reference: SOURCE_PATH, digest: sha256Digest(RESOURCE) }],
        created_at: NOW, updated_at: NOW,
    });
    for (const [from, to, cause] of [["observed", "proposed", "observation-recorded"], ["proposed", "gate1-pending", "proposal-ready"]]) {
        await store.recordTransition({ schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1, from_state: from, to_state: to, cause, actor: "test", occurred_at: NOW, correlation_id: generateUuidV7() });
    }
    await store.recordObservation({
        observation_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
        evidence_reference: `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${itemId}`, evidence_digest: sha256Digest("m"), observed_at: NOW, gate: "gate-1",
        manifest_item: { title: "correction: guide:fact-verification-workflow", evidence_refs: [FALSE_FINDING, REAL_FINDING] },
    });
    await walkTo(store, runId, itemId, "ado-linked");
    store.close();
    return { dbPath, itemId };
}

async function briefsFor(overrides) {
    const { dbPath, itemId } = await currencyItem();
    const { inventoryPath, mapPath } = staffing();
    const result = await generateBriefs({ dbPath, mapPath, targetsPath: DEFAULT_TARGETS_PATH, inventoryPath, limit: 5, now: "2026-09-13T12:00:00.000Z", ...overrides });
    return { result, itemId };
}

test("a currency update brief carries the file, its path, id and slug, its sources, the findings and the date", async () => {
    const { result, itemId } = await briefsFor({ corpusRoot: corpus() });
    assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
    const brief = result.briefs.find((entry) => entry.workItemId === itemId);
    assert.ok(brief, "the item is briefed");
    const prompt = brief.prompt;

    assert.match(prompt, /The file to correct is project42dev\/project42-content\/resources\/research-verification\/fact-verification-workflow\.json/);
    assert.match(prompt, /Its id and slug are "fact-verification-workflow"/);
    assert.ok(prompt.includes(RESOURCE.toString("utf8").trim()), "the existing file is quoted in full");
    assert.match(prompt, /matches the bytes the inspection read/, "and bound to the digest the inspection recorded");
    assert.match(prompt, new RegExp(`corpus snapshot at commit ${SNAPSHOT_COMMIT}`));
    assert.match(prompt, /the currency inspection ran against commit [0-9a-f]{40}/, "the inspection's own pin is named");
    assert.match(prompt, /Today's date is 2026-09-13 \(UTC\)/);
    assert.match(prompt, /last verified 2026-07-25 on a 90-day review cadence, so it fell due for review on 2026-10-23, which has not yet arrived/, "the dated review record is computed, not left to the drafter");
    assert.match(prompt, /Its 3 source records, verbatim/);
    assert.ok(prompt.includes("https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence (NIST, lastVerified 2026-07-25; within cadence until 2026-10-23)"),
        "each source record is listed with its own dated verification and what that says about cadence");
    assert.ok(prompt.includes(REAL_FINDING), "the real finding reaches the drafter");
    assert.ok(!prompt.includes(FALSE_FINDING), "the false future-date finding does not");
    assert.ok(!prompt.includes("carries no cited source that resolves over https"), "the file's own sources count as its cited sources");
});

test("without the corpus snapshot the update is refused before anything is spent, and says why", async () => {
    const { result, itemId } = await briefsFor({ corpusRoot: null });
    assert.equal(result.briefs.filter((entry) => entry.workItemId === itemId).length, 0, "no brief is sent to the drafter without the file");
    const skipped = result.skipped.find((entry) => entry.subjectId === itemId);
    assert.match(skipped.reason, /cannot be briefed without the file it corrects: no corpus snapshot was materialized/);
});

test("a file that changed since the inspection is still supplied, and the brief says it differs", async () => {
    const changed = Buffer.from(RESOURCE.toString("utf8").replace('"lastVerified": "2026-07-25",', '"lastVerified": "2026-08-01",'));
    const { result, itemId } = await briefsFor({ corpusRoot: corpus(changed) });
    const brief = result.briefs.find((entry) => entry.workItemId === itemId);
    assert.match(brief.prompt, /DIFFERS from the sha256:[0-9a-f]{64} the inspection read/);
});

test("an oversize file is passed as the named section in full plus the JSON path of everything left out", () => {
    const root = corpus();
    const existing = existingContentFor({
        corpusRoot: root,
        record: { evidence: [{ reference: SOURCE_PATH, digest: sha256Digest(RESOURCE) }] },
        findings: ["The record-verification section omits the model version."],
        // Just under the fixture's 3973 bytes, so the file is oversize and the
        // excerpt (two section bodies dropped) still fits.
        maxBytes: 3900,
    });
    assert.equal(existing.status, "supplied");
    assert.equal(existing.partial, true);
    assert.ok(existing.omittedPaths.some((path) => path.startsWith("$.sections[0]")), "the unnamed sections are listed by JSON path");
    assert.ok(!existing.omittedPaths.some((path) => path.startsWith("$.sections[1]")), "the named section is not omitted");
    assert.ok(existing.content.includes("Fact verification record"), "its body is carried in full");
    assert.ok(existing.content.includes('"sources"'), "and every non-section field is still there");
});
