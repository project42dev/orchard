// Gate 2 evidence lives in the state store, not on one container's disk.
//
// THE DEFECT. The authoring job wrote each item's Gate 2 evidence to its own
// ephemeral disk and the gate2-prep job -- a different Container Apps job,
// with a different disk -- looked for that file on its own. It could never
// find one, so every item that missed the authoring run's single in-process
// window stranded at gate2-ready until it was re-authored, which spends
// (project42dev-ops pmo/plans/orchard-gate2-ready-stranding-analysis-2026-09-10.md).
//
// THE GUARD. recordObservation validates no payload -- there is no observation
// schema -- so nothing but these tests stops a malformed or lossy evidence
// record from being written. They prove: a real-shaped evidence document
// survives the store and still satisfies prepareItem; gate2-prep prepares an
// item whose evidence exists ONLY in the store; an inline preparation that
// fails after the evidence is persisted is finished later by gate2-prep, with
// the store's exact-replay checks on the already-recorded handoffs and binding
// passing on the round-tripped copy; the stranded-item sweep does not spend on
// such an item; and evidence for any other revision is never applied.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "../scripts/lib/state-store.mjs";
import { generateUuidV7, sha256Digest } from "../scripts/lib/identity.mjs";
import { GATE_MANIFEST_REFERENCE_PREFIX, persistDiscoveryItems } from "../scripts/lib/gate-queue.mjs";
import { buildHandoffsFromProposal, buildEvidenceDocument } from "../scripts/lib/prepare-gate2-evidence.mjs";
import {
    prepareItem, main as runGate2Prep, persistGate2Evidence, loadGate2Evidence,
    gate2EvidenceReference, evidencePathFor,
} from "../scripts/run-gate2-prep.mjs";
import { attemptGate2Evidence } from "../scripts/run-authoring.mjs";
import { recoverStrandedItems } from "../scripts/lib/stranded-recovery.mjs";
import { applyRetry } from "../scripts/apply-blocked-retry.mjs";
import { estate, candidate, walkTo, cleanupFixtures, NOW } from "../scripts/test-fixtures.mjs";

const PREPARED_AT = "2026-08-19T00:00:00.000Z";
const quiet = () => { };
const scratch = [];

after(() => {
    cleanupFixtures();
    for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function scratchDir(label) {
    const directory = mkdtempSync(join(tmpdir(), `orchard-${label}-`));
    scratch.push(directory);
    return directory;
}

// A guide resource: JSON, and its surface has no registry, so preparing its
// commit needs no catalogue read.
const DRAFT = JSON.stringify({ id: "stored-evidence", title: "Evidence that outlives its container", body: "real authored text" }, null, 2);

function chunkedStage(stage, text, status = "passed") {
    const chunks = [];
    for (let index = 0; index < text.length; index += 2000) chunks.push(text.slice(index, index + 2000));
    return {
        stage, findings: chunks, outputDigest: sha256Digest(text).slice("sha256:".length), status,
        latencyMs: 500, deploymentAlias: "a", modelVersion: "v1", providerFamily: "openai",
        contractVersion: "1.0.0", inputEvidenceDigest: "0".repeat(64), costUsd: 0.01,
    };
}

function passingProposal(draftText) {
    return {
        modelStages: [
            chunkedStage("evidence-research", "sources"),
            chunkedStage("curriculum-writing", draftText),
            chunkedStage("factual-verification", "verifier: PASS"),
            chunkedStage("assessment-review", "adversary: PASS"),
            chunkedStage("accessibility-review", "human-review pending", "human-review"),
            chunkedStage("release-proposal", "COMPLETENESS.\n\nRECOMMENDATION: PUBLISH"),
        ],
    };
}

/** An item walked to gate2-ready, carrying the ADO link and Gate 1 approval a real one has. */
async function gate2ReadyItem(term) {
    const { store, runId, dbPath } = await estate();
    const result = await persistDiscoveryItems({ store, runId, candidates: [candidate(term, { surface: "guide" })], now: NOW });
    const id = result.items[0].item_id;
    await walkTo(store, runId, id, "gate2-ready");
    const proposalDigest = store.db.prepare(
        "SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = 1",
    ).get(id).proposal_digest;
    store.db.prepare(
        `INSERT INTO decision_event
          (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
           actor_immutable_id, source_repository, source_issue_number, source_comment_id,
           correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
          VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-08-14T00:00:00.000Z', '{}')`,
    ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-store:${id}`);
    return { store, runId, dbPath, id };
}

function rowOf(store, id) {
    return store.db.prepare(
        "SELECT item_id, track, current_state, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?",
    ).get(id);
}

function stateOf(dbPath, id) {
    const reader = openStateStore(dbPath);
    try { return reader.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id).current_state; }
    finally { reader.close(); }
}

function latestGate2Manifest(dbPath, id) {
    const reader = openStateStore(dbPath);
    try {
        const observed = reader.db.prepare(
            `SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference = ?
              ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
        ).get(id, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-2:${id}`);
        return observed ? JSON.parse(observed.record_json).manifest_item : null;
    } finally {
        reader.close();
    }
}

function handoffCount(store, id) {
    return Number(store.db.prepare("SELECT count(*) AS n FROM agent_handoff WHERE item_id = ?").get(id).n);
}

/**
 * The evidence document exactly as attemptGate2Evidence builds it in
 * production: real handoffs from a six-stage proposal, a real binding, a real
 * manifest. Only the GitHub commit identifiers are fixed.
 */
async function realEvidence(store, row) {
    const revision = Number(row.current_revision);
    const record = store.db.prepare(
        "SELECT run_id, proposal_digest, target_repository, target_path FROM item_revision WHERE item_id = ? AND item_revision = ?",
    ).get(row.item_id, revision);
    const link = store.db.prepare(
        "SELECT external_key, external_id FROM external_link WHERE provider = 'ado' AND item_id = ? AND item_revision = ?",
    ).get(row.item_id, revision);
    const gate1 = store.db.prepare(
        "SELECT event_id FROM decision_event WHERE item_id = ? AND gate = 'gate-1' AND decision = 'approve'",
    ).get(row.item_id);
    const binding = {
        run_id: record.run_id ?? row.origin_run_id,
        item_id: row.item_id,
        item_revision: revision,
        track: row.track,
        proposal_digest: record.proposal_digest.startsWith("sha256:") ? record.proposal_digest : `sha256:${record.proposal_digest}`,
        gate1_decision_event_id: gate1.event_id,
        ado_external_key: link.external_key,
        ado_work_item_id: Number(link.external_id),
    };
    const proposal = passingProposal(DRAFT);
    const handoffs = await buildHandoffsFromProposal({ proposal, binding, runStartedAt: PREPARED_AT });
    const target = { repository: record.target_repository, path: record.target_path };
    const commit = { baseCommit: "a".repeat(40), preparedCommit: "e".repeat(40), preparedTreeDigest: sha256Digest("tree") };
    return buildEvidenceDocument({ handoffs, binding, target, commit, proposal });
}

/** GitHub's Git Data API, as prepareRealCommit calls it for a registry-free surface. */
function githubStub() {
    const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    return async (url, options = {}) => {
        const method = options.method ?? "GET";
        if (url.endsWith("/git/ref/heads/main")) return reply({ object: { sha: "a".repeat(40) } });
        if (url.includes("/git/commits/") && method === "GET") return reply({ tree: { sha: "b".repeat(40) } });
        if (url.endsWith("/git/blobs")) return reply({ sha: "c".repeat(40) });
        if (url.endsWith("/git/trees")) return reply({ sha: "d".repeat(40) });
        if (url.endsWith("/git/commits")) return reply({ sha: "e".repeat(40) });
        throw new Error(`unexpected GitHub call ${method} ${url}`);
    };
}

test("a real evidence document round-trips through the state store and back into prepareItem", async () => {
    const { store, dbPath, id } = await gate2ReadyItem("store-roundtrip");
    const row = rowOf(store, id);
    const evidence = await realEvidence(store, row);
    const extra = { content: DRAFT };

    const reference = persistGate2Evidence({ store, row, evidence, now: PREPARED_AT, extra });
    assert.equal(reference, gate2EvidenceReference(id, 1));
    assert.equal(reference, `orchard/gate2-evidence/${id}:r1`);

    // No evidence root at all: the store is the only place this can come from.
    const loaded = loadGate2Evidence({ store, row, evidenceRoot: null });
    assert.equal(loaded.source, "state-store");
    assert.notEqual(loaded.evidence, evidence, "a copy read back from the store, not the object in memory");
    assert.deepEqual(loaded.evidence, evidence, "the document survives the store unchanged");
    assert.deepEqual(loaded.extra, extra, "and so does what the manifest shows the owner");

    await prepareItem({ store, row, evidence: loaded.evidence, now: PREPARED_AT, extra: loaded.extra });
    assert.equal(handoffCount(store, id), 6, "every handoff in the chain was accepted by the store's contracts");
    assert.ok(store.getArtifactBinding(id, 1), "the binding was accepted against the persisted final handoff");
    store.close();

    assert.equal(stateOf(dbPath, id), "gate2-pending");
    const manifest = latestGate2Manifest(dbPath, id);
    assert.equal(manifest.artifact_digest, evidence.artifact_binding.artifact_digest);
    assert.equal(manifest.content, DRAFT, "the owner still sees the artifact, not only its digests");
});

test("gate2-prep prepares an item whose evidence exists only in the state store -- a different container, no file", async () => {
    const { store, dbPath, id } = await gate2ReadyItem("store-only");
    const row = rowOf(store, id);
    persistGate2Evidence({ store, row, evidence: await realEvidence(store, row), now: PREPARED_AT, extra: { content: DRAFT } });
    store.close();

    // The gate2-prep container's own disk: empty. This is exactly the
    // production shape that made gate2.prep.no-evidence a certainty.
    const otherContainer = scratchDir("gate2prep-disk");
    assert.equal(existsSync(evidencePathFor(otherContainer, id)), false);

    const events = [];
    const summary = await runGate2Prep(["--state-db", dbPath], {
        log: (level, event, detail) => events.push({ level, event, detail }),
        env: { ORCHARD_EVIDENCE_ROOT: otherContainer },
    });

    assert.deepEqual(summary, { prepared: 1, held: 0 }, JSON.stringify(events.filter((e) => e.level !== "info")));
    assert.equal(stateOf(dbPath, id), "gate2-pending");
    const pending = events.find((entry) => entry.event === "gate2.prep.pending");
    assert.equal(pending.detail.evidenceSource, "state-store");
    assert.equal(events.some((entry) => entry.event === "gate2.prep.no-evidence"), false);
    assert.equal(latestGate2Manifest(dbPath, id).content, DRAFT, "a store-backed retry shows the owner the same content the inline path would");
});

test("an inline preparation that fails after the evidence is persisted is finished by gate2-prep, and the sweep spends nothing on it", async () => {
    const { store, dbPath, id } = await gate2ReadyItem("store-inline-failure");
    const authoringDisk = scratchDir("authoring-disk");
    const proposalRoot = join(authoringDisk, "proposals");
    mkdirSync(proposalRoot, { recursive: true });
    const file = `proposal-${id}.json`;
    writeFileSync(join(proposalRoot, file), JSON.stringify(passingProposal(DRAFT)));

    // The authoring container dies (or the store write blips) at the very last
    // step: handoffs, binding and manifest observation are already written,
    // the transition is not. Every other store method is the real one.
    const flaky = Object.create(store);
    flaky.recordTransition = async () => { throw new Error("simulated: the authoring container stopped mid-preparation"); };

    const events = [];
    const inline = await attemptGate2Evidence({
        store: flaky,
        applied: [{ subjectId: id, from: "executing", to: "gate2-ready", file }],
        runRecordDir: proposalRoot, proposalRoot, now: PREPARED_AT,
        env: { ORCHARD_EVIDENCE_ROOT: authoringDisk },
        log: (level, event, detail) => events.push({ level, event, detail }),
        fetchImpl: githubStub(),
        readGateTokenImpl: async () => "test-token-literal",
    });
    assert.deepEqual(inline, { prepared: 0, held: 1 });
    assert.match(events.find((entry) => entry.event === "gate2evidence.refused").detail.reason, /simulated/);
    assert.equal(rowOf(store, id).current_state, "gate2-ready");
    assert.equal(handoffCount(store, id), 6, "the partial preparation really did write the handoffs");
    assert.ok(
        store.db.prepare("SELECT 1 FROM observation_event WHERE item_id = ? AND item_revision = 1 AND evidence_reference = ?")
            .get(id, gate2EvidenceReference(id, 1)),
        "the evidence was persisted before the preparation was attempted",
    );

    // The next authoring run's sweep must not re-author (and pay for) an item
    // gate2-prep can finish for free.
    const sweep = await recoverStrandedItems({ store, now: PREPARED_AT, log: quiet });
    assert.equal(sweep.recovered.length, 0);
    assert.equal(sweep.refused.length, 1);
    assert.match(sweep.refused[0].reason, /in the state store; gate2-prep prepares it without re-authoring/);
    assert.equal(Number(rowOf(store, id).current_revision), 1, "no new revision, so nothing was re-drafted");
    store.close();

    // A different container, whose disk never saw the authoring run's file.
    const gate2PrepDisk = scratchDir("gate2prep-disk");
    const prepEvents = [];
    const prep = await runGate2Prep(["--state-db", dbPath], {
        log: (level, event, detail) => prepEvents.push({ level, event, detail }),
        env: { ORCHARD_EVIDENCE_ROOT: gate2PrepDisk },
    });
    // Re-recording the six handoffs and the binding from the round-tripped
    // copy is an exact replay only if the store changed nothing canonical; any
    // drift throws IdempotencyConflictError here and the item would hold.
    assert.deepEqual(prep, { prepared: 1, held: 0 }, JSON.stringify(prepEvents.filter((e) => e.level !== "info")));
    assert.equal(stateOf(dbPath, id), "gate2-pending");
    assert.equal(latestGate2Manifest(dbPath, id).content, DRAFT);
});

test("evidence for another revision is never applied, from the store or from a stale file", async () => {
    const { store, runId, dbPath, id } = await gate2ReadyItem("store-stale-revision");
    const staleEvidence = await realEvidence(store, rowOf(store, id));
    persistGate2Evidence({ store, row: rowOf(store, id), evidence: staleEvidence, now: PREPARED_AT, extra: { content: DRAFT } });

    // Re-authored: revision 2, back at gate2-ready with no evidence of its own.
    const retried = await applyRetry(store, { item: id, now: PREPARED_AT, actor: "test/re-author" });
    assert.equal(retried.retried, 1, JSON.stringify(retried.errors));
    await walkTo(store, runId, id, "gate2-ready", { now: PREPARED_AT });
    assert.equal(Number(rowOf(store, id).current_revision), 2);
    assert.equal(loadGate2Evidence({ store, row: rowOf(store, id), evidenceRoot: null }), null, "revision 1's record is not revision 2's evidence");
    const handoffsBefore = handoffCount(store, id);
    store.close();

    const emptyDisk = scratchDir("gate2prep-empty");
    const events = [];
    const heldForNothing = await runGate2Prep(["--state-db", dbPath], { log: (l, event, detail) => events.push({ event, detail }), env: { ORCHARD_EVIDENCE_ROOT: emptyDisk } });
    assert.deepEqual(heldForNothing, { prepared: 0, held: 1 });
    assert.equal(events.find((entry) => entry.event === "gate2.prep.no-evidence").detail.reference, `orchard/gate2-evidence/${id}:r2`);

    // A leftover file carrying revision 1's evidence: refused whole, before
    // prepareItem could record a single handoff for the wrong revision.
    const staleDisk = scratchDir("gate2prep-stale");
    mkdirSync(join(staleDisk, "gate2-evidence"), { recursive: true });
    writeFileSync(evidencePathFor(staleDisk, id), JSON.stringify(staleEvidence));
    const refusedEvents = [];
    const refused = await runGate2Prep(["--state-db", dbPath], { log: (l, event, detail) => refusedEvents.push({ event, detail }), env: { ORCHARD_EVIDENCE_ROOT: staleDisk } });
    assert.deepEqual(refused, { prepared: 0, held: 1 });
    assert.equal(refusedEvents.find((entry) => entry.event === "gate2.prep.refused").detail.code, "ERR_ORCHARD_STALE_EVIDENCE");

    const reader = openStateStore(dbPath);
    try {
        assert.equal(handoffCount(reader, id), handoffsBefore, "nothing was recorded against the wrong revision");
        assert.equal(rowOf(reader, id).current_state, "gate2-ready");
    } finally {
        reader.close();
    }
});
