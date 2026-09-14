// Defect 3 of the 2026-09-13 authoring-brief fix: a drafter's
// {"status":"BLOCKED",...} refusal was announced at Gate 2 (issue #238) as an
// item to approve. See scripts/lib/drafter-refusal.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptGate2Evidence, attemptRejectionRecovery } from "../scripts/run-authoring.mjs";
import { main as gate2PrepMain, persistGate2Evidence } from "../scripts/run-gate2-prep.mjs";
import { blockedNoteFor } from "../scripts/generate-briefs.mjs";
import { renderGateIssueBody } from "../scripts/lib/gates.mjs";
import { inspectDrafterRefusal, manifestItemRefusal, MAX_REFUSAL_REASON_CHARS } from "../scripts/lib/drafter-refusal.mjs";
import { generateUuidV7, sha256Digest } from "../scripts/lib/identity.mjs";
import { openStateStore } from "../scripts/lib/state-store.mjs";
import { estate, seedGateItems, walkTo } from "../scripts/test-fixtures.mjs";

// The production refusal, verbatim in shape and in its key sentences.
const BLOCKED = JSON.stringify({
    status: "BLOCKED",
    workItem: "p42-update-01a024de-1918-7baf-985c-252d89570314",
    reason: "A schema-conforming correction cannot be produced from the supplied material without inventing required data or rewriting unseen accepted content. The existing resource, exact target filename, three source records, and at least one relevant source with a resolving https URL were not supplied.",
    unknowns: [
        "The required id and slug are UNKNOWN because the target filename was not supplied.",
        "The source that moved or passed its review cadence is UNKNOWN.",
    ],
    dateFinding: "The inspection's characterization of 2026-07-25 as a future date conflicts with the stated current date of 2026-09-13.",
    requiredInputs: [
        "The exact existing JSON resource and its target filename.",
        "All three existing source records.",
        "A relevant source URL confirmed to resolve over https.",
        "Dated review or source-check records.",
        "Evidence identifying which source moved or exceeded its review cadence and what content that change affected.",
    ],
});
const RESOURCE_PATH = "resources/research-verification/fact-verification-workflow.json";

function stage(name, text, status = "passed") {
    const findings = [];
    for (let index = 0; index < text.length; index += 2000) findings.push(text.slice(index, index + 2000));
    return { stage: name, findings, outputDigest: sha256Digest(text).slice("sha256:".length), status, latencyMs: 1, deploymentAlias: "a", modelVersion: "v1", providerFamily: "openai", contractVersion: "1.0.0", inputEvidenceDigest: "0".repeat(64), costUsd: 0.01 };
}

function proposalWith(draft, verifierStatus = "passed") {
    return { modelStages: [
        stage("evidence-research", "sources"), stage("curriculum-writing", draft),
        stage("factual-verification", "verifier finding", verifierStatus), stage("assessment-review", "adversary finding", verifierStatus === "passed" ? "passed" : "refuted"),
        stage("accessibility-review", "human-review pending", "human-review"), stage("release-proposal", "RECOMMENDATION: REVISE"),
    ] };
}

const neverGitHub = async () => { throw new Error("GitHub must never be called for a drafter refusal"); };

async function gate2ReadyWith(draft, term) {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, [term]);
    await walkTo(store, runId, id, "gate2-ready");
    // The Gate 1 approval a real gate2-ready item carries; the inline evidence
    // step checks it before it reads the draft.
    const proposalDigest = store.db.prepare("SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = 1").get(id).proposal_digest;
    store.db.prepare(
        `INSERT INTO decision_event
          (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
           actor_immutable_id, source_repository, source_issue_number, source_comment_id,
           correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
          VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-09-12T00:00:00.000Z', '{}')`,
    ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-refusal:${id}`);
    const directory = mkdtempSync(join(tmpdir(), "orchard-refusal-"));
    mkdirSync(join(directory, "proposals"), { recursive: true });
    const file = `proposal-${id}.json`;
    writeFileSync(join(directory, "proposals", file), JSON.stringify(proposalWith(draft)));
    return { store, runId, dbPath, id, proposalRoot: join(directory, "proposals"), file };
}

test("the production BLOCKED document is recognised as a refusal, with its reason and required inputs", () => {
    const refusal = inspectDrafterRefusal({ path: RESOURCE_PATH, content: BLOCKED });
    assert.equal(refusal.code, "drafter-refusal.status-blocked");
    assert.match(refusal.reason, /existing resource, exact target filename/);
    assert.equal(refusal.requiredInputs.length, 5);
    // It is a valid JSON object, which is exactly why the format check passed it.
    assert.equal(typeof JSON.parse(BLOCKED), "object");
});

test("a conforming artifact is not a refusal, a non-conforming resource is", () => {
    const resource = readFileSync(new URL("./fixtures/fact-verification-workflow.json", import.meta.url), "utf8");
    assert.equal(inspectDrafterRefusal({ path: RESOURCE_PATH, content: resource }), null);
    const partial = JSON.stringify({ id: "fact-verification-workflow", title: "Only a title" });
    assert.equal(inspectDrafterRefusal({ path: RESOURCE_PATH, content: partial }).code, "drafter-refusal.non-conforming");
    assert.equal(inspectDrafterRefusal({ path: RESOURCE_PATH, content: "READINESS: BLOCKED, the spec is missing" }).code, "drafter-refusal.status-blocked");
    assert.equal(inspectDrafterRefusal({ path: "diagrams/x.mmd", content: "flowchart TD\n  a --> b" }), null);
});

test("authoring routes a BLOCKED draft to blocked with the drafter's reason, and never toward Gate 2", async () => {
    const { store, id, proposalRoot, file } = await gate2ReadyWith(BLOCKED, "refused-inline");
    const events = [];
    const applied = [{ subjectId: id, from: "executing", to: "gate2-ready", file }];
    const summary = await attemptGate2Evidence({
        store, applied, runRecordDir: proposalRoot, proposalRoot, now: "2026-09-13T12:00:00.000Z",
        env: {}, log: (level, event, detail) => events.push({ level, event, detail }), fetchImpl: neverGitHub,
        readGateTokenImpl: async () => { throw new Error("no credential may be minted for a refusal"); },
    });
    assert.equal(summary.refused, 1, "the refusal is counted");
    assert.equal(summary.prepared, 0, "and nothing is prepared");
    assert.equal(summary.refusals[0].requiredInputs.length, 5, "the run summary names it, with what the drafter said it needs");
    assert.equal(applied[0].to, "blocked", "the entry is re-labelled so the rejection gate treats it as a block");

    const row = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
    assert.equal(row.current_state, "blocked", "the item is blocked, not gate2-pending");

    const transition = store.db.prepare("SELECT from_state, cause, record_json FROM state_transition_event WHERE item_id = ? AND to_state = 'blocked'").get(id);
    assert.equal(transition.from_state, "gate2-ready");
    assert.equal(transition.cause, "policy-block");
    const reason = JSON.parse(transition.record_json).reason;
    assert.ok(reason.length <= MAX_REFUSAL_REASON_CHARS);
    assert.match(reason, /^drafter refused: A schema-conforming correction/);
    assert.match(reason, /Required inputs: The exact existing JSON resource and its target filename\./);

    const note = blockedNoteFor(store.db, id);
    assert.match(note, /^blocked retry: drafter refused: /, "the existing blocked-retry path reads the drafter's reason back into the next brief");

    const observation = store.db.prepare("SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference LIKE 'orchard/drafter-refusal/%'").get(id);
    assert.equal(JSON.parse(observation.record_json).drafter_refusal.document.status, "BLOCKED", "the whole refusal document is on the record");
    assert.ok(!store.db.prepare("SELECT 1 FROM observation_event WHERE item_id = ? AND evidence_reference LIKE 'orchard/gate-manifest/gate-2:%'").get(id), "no Gate 2 manifest item exists for it");

    // The rejection gate then gives it its ONE retry, with the drafter's reason.
    const recovery = await attemptRejectionRecovery({
        store, applied, runRecordDir: proposalRoot, proposalRoot, now: "2026-09-13T12:01:00.000Z", log: () => { }, fetchImpl: neverGitHub,
    });
    assert.equal(recovery.retried, 1, "a first refusal is retried once");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM state_transition_event WHERE item_id = ? AND from_state = 'blocked' AND to_state = 'blocked'").get(id).n, 0,
        "the reason was already recorded inline, so it is not recorded twice");
    store.close();
});

test("a second refusal is never escalated to Gate 2; it stays blocked with the drafter's reason", async () => {
    const { store, runId } = await estate();
    const [id] = await seedGateItems(store, runId, ["refused-twice"]);
    await walkTo(store, runId, id, "executing");
    const directory = mkdtempSync(join(tmpdir(), "orchard-refusal-twice-"));
    const proposalRoot = join(directory, "proposals");
    mkdirSync(proposalRoot, { recursive: true });
    const file = `proposal-${id}.json`;
    writeFileSync(join(proposalRoot, file), JSON.stringify(proposalWith(BLOCKED, "failed")));

    // First block and retry, then the second block, exactly as the ingest records them.
    await store.recordTransition({ schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 1, from_state: "executing", to_state: "blocked", cause: "policy-block", reason: "blocked by the authoring ensemble, earlier.json", actor: "orchard/run-authoring", occurred_at: "2026-09-13T10:00:00.000Z", correlation_id: generateUuidV7() });
    const record = JSON.parse(store.db.prepare("SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = 1").get(id).record_json);
    await store.recordItem({ ...record, item_revision: 2, state: "executing", artifact_digest: null, created_at: "2026-09-13T10:30:00.000Z", updated_at: "2026-09-13T10:30:00.000Z" });
    await store.recordTransition({ schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 1, from_state: "blocked", to_state: "executing", cause: "revision-created", recovery_gate: "gate-2", successor_revision: 2, actor: "test", occurred_at: "2026-09-13T10:30:00.000Z", correlation_id: generateUuidV7() });
    await store.recordTransition({ schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 2, from_state: "executing", to_state: "blocked", cause: "policy-block", reason: `blocked by the authoring ensemble, ${file}`, actor: "orchard/run-authoring", occurred_at: "2026-09-13T11:00:00.000Z", correlation_id: generateUuidV7() });

    const events = [];
    const result = await attemptRejectionRecovery({
        store, applied: [{ subjectId: id, from: "executing", to: "blocked", file }],
        runRecordDir: proposalRoot, proposalRoot, now: "2026-09-13T12:00:00.000Z", env: {},
        log: (level, event, detail) => events.push({ level, event, detail }), fetchImpl: neverGitHub,
        readGateTokenImpl: async () => { throw new Error("no credential may be minted to escalate a refusal"); },
    });
    assert.equal(result.escalated, 0, "a refusal is not escalated");
    assert.equal(result.retried, 0, "and not retried a third time");
    assert.equal(result.refused, 1);
    assert.ok(events.some((entry) => entry.event === "rejection.escalate.drafter-refused"));
    assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id).current_state, "blocked");
    assert.match(blockedNoteFor(store.db, id), /drafter refused: .*Required inputs: /, "the drafter's reason replaces the ingest one-liner on the record");
    store.close();
});

test("gate2-prep blocks a refusal persisted by an earlier run instead of preparing it", async () => {
    const { store, id, dbPath } = await gate2ReadyWith(BLOCKED, "refused-persisted");
    const row = store.db.prepare("SELECT item_id, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?").get(id);
    persistGate2Evidence({ store, row, evidence: { handoffs: [], artifact_binding: null, manifest: {} }, now: "2026-09-13T11:00:00.000Z", extra: { content: BLOCKED } });
    store.close();

    const events = [];
    const summary = await gate2PrepMain(["--state-db", dbPath], { env: {}, log: (level, event, detail) => events.push({ level, event, detail }) });
    assert.equal(summary.refused, 1);
    assert.equal(summary.prepared, 0);
    const reopened = openStateStore(dbPath);
    try {
        assert.equal(reopened.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id).current_state, "blocked");
    } finally { reopened.close(); }
});

test("a Gate 2 issue never renders an approve command for a refusal", () => {
    const manifest = JSON.parse(readFileSync(new URL("../contracts/fixtures/gate-2-track-2.valid.json", import.meta.url), "utf8"));
    const clean = renderGateIssueBody(manifest);
    assert.match(clean, /\*\*Approve this item only:\*\*/, "the fixture renders an approve command when its content is a draft");

    const refused = structuredClone(manifest);
    refused.items[0].content = BLOCKED;
    assert.ok(manifestItemRefusal(refused.items[0]));
    const body = renderGateIssueBody(refused);
    assert.doesNotMatch(body, /\*\*Approve this item only:\*\*/, "no approve command for a refusal");
    assert.doesNotMatch(body, new RegExp(`approve item=${refused.items[0].item_id}`), "and no decision command naming it");
    assert.match(body, /NOT APPROVABLE -- the drafter refused/);
    assert.match(body, /The exact existing JSON resource and its target filename\./, "what the drafter said it needs is shown");
});
