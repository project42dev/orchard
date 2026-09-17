// Gate 2 rework is actually re-drafted.
//
// Until 2026-09-13 a Gate 2 request-changes left the item at
// 'changes-requested' forever: generate-briefs.mjs does not select that state,
// run-authoring.mjs never mentioned it, and the job chain counted nothing in
// it. Worse, the reviewer's reason could not have reached the brief anyway,
// because the production decision path (store.recordVerifiedDecision) writes a
// decision_event and no state_transition_event, and reworkNoteFor read only
// transitions.
//
// The first test here is the only one that proves the loop, so it goes through
// the production write path end to end: a verified request-changes decision,
// then the authoring role's real main() with the ensemble replaced by a
// stand-in, then the brief the stand-in was handed. The rest pin each guard.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStateStore } from "./lib/state-store.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { heldAtGate } from "./lib/gate-queue.mjs";
import { generateGateManifests } from "./lib/gates.mjs";
import { applyRework, REWORK_PREFIX } from "./apply-gate2-rework.mjs";
import { applyRetry } from "./apply-blocked-retry.mjs";
import { generateBriefs } from "./generate-briefs.mjs";
import { persistGate2Evidence } from "./run-gate2-prep.mjs";
import { main as runAuthoring } from "./run-authoring.mjs";
import { main as runGate2Prep } from "./run-gate2-prep.mjs";
import {
    recoverReworkItems, classifyReworkItems, countRecoverableRework, resolveReworkBounds,
    REWORK_ACTOR, DEFAULT_MAX_REWORK_ITEMS,
} from "./lib/rework-recovery.mjs";
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from "./test-fixtures.mjs";

after(cleanupFixtures);

const digest = (character) => `sha256:${character.repeat(64)}`;
const quiet = () => { };
const REASON = "the cited vendor page does not exist; cite the real release notes";

function stateOf(dbPath, itemId) {
    const store = openStateStore(dbPath);
    try {
        return store.db.prepare("SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?").get(itemId);
    } finally {
        store.close();
    }
}

async function transition(store, runId, itemId, from, to, cause, extra = {}) {
    const row = store.db.prepare("SELECT current_revision FROM workflow_item WHERE item_id = ?").get(itemId);
    await store.recordTransition({
        schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: itemId,
        item_revision: Number(row.current_revision), from_state: from, to_state: to, cause,
        actor: "test", occurred_at: NOW, correlation_id: generateUuidV7(), ...extra,
    });
}

// Every item that reached gate2-pending in production since 2026-09-11 carries
// its Gate 2 evidence in the store for its current revision. The fixture walk
// does not write it, so it is written here: without it, a sweep that wrongly
// copied stranded-recovery's stored-evidence refusal would pass these tests.
function storeGate2Evidence(store, itemId) {
    const row = store.db.prepare("SELECT item_id, current_revision, origin_run_id FROM workflow_item WHERE item_id = ?").get(itemId);
    persistGate2Evidence({ store, row, evidence: { handoffs: [], artifact_binding: null, manifest: {} }, now: NOW });
}

async function returnedAtGate2(store, runId, term) {
    const [id] = await seedGateItems(store, runId, [term]);
    await walkTo(store, runId, id, "gate2-pending");
    storeGate2Evidence(store, id);
    const result = await applyRework(store, { item: id, reason: REASON });
    assert.equal(result.requeued, 1, result.errors.join("; "));
    return id;
}

function retarget(store, itemId, targetPath) {
    const revision = Number(store.db.prepare("SELECT current_revision FROM workflow_item WHERE item_id = ?").get(itemId).current_revision);
    store.db.exec("DROP TRIGGER IF EXISTS no_update_item_revision");
    store.db.prepare("UPDATE item_revision SET target_path = ? WHERE item_id = ? AND item_revision = ?").run(targetPath, itemId, revision);
    store.db.exec("CREATE TRIGGER IF NOT EXISTS no_update_item_revision BEFORE UPDATE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;");
}

function authoringInputs(directory) {
    const mapPath = join(directory, "model-map.json");
    writeFileSync(mapPath, JSON.stringify({
        jobs: {
            research: { model: "model-a" }, drafting: { model: "model-a" }, verification: { model: "model-b" },
            adversary: { model: "model-c" }, arbiter: { model: "model-d" }, finalization: { model: "model-d" },
        },
    }));
    const inventoryPath = join(directory, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
        "model-a": { format: "family-one" }, "model-b": { format: "family-two" },
        "model-c": { format: "family-three" }, "model-d": { format: "family-four" },
    }));
    const targetsPath = join(directory, "surface-targets.json");
    writeFileSync(targetsPath, JSON.stringify({ repository: "project42dev/project42-content", surfaces: {} }));
    return { mapPath, inventoryPath, targetsPath };
}

// --- the loop, through the production decision path ---------------------------

const gatePolicy = { provider: "github", repository: "project42dev/orchard", authorized_actor_ids: ["1001"] };
const gateTrust = { authorization_policy_digest: sha256Digest(gatePolicy), adapter_digest: digest("8"), adapter_identity: "test:protected-github-adapter:v1" };

function gateAuthority({ manifest, reviewedItem, gate, decision, reason, previousState, nextState, ordinal }) {
    const record = {
        schema_version: "1.0.0", event_id: generateUuidV7(), gate, run_id: manifest.run_id,
        item_id: reviewedItem.item_id, item_revision: reviewedItem.item_revision,
        digest: gate === "gate-1" ? reviewedItem.proposal_digest : reviewedItem.artifact_digest,
        decision, reason, review_after: null,
        actor: { provider: "github", immutable_id: "1001", authorized: true },
        source: { repository: "project42dev/orchard", issue_number: ordinal, comment_id: `rework-${gate}-${decision}`, comment_digest: digest("0") },
        occurred_at: `2026-08-16T10:0${ordinal}:00Z`, previous_state: previousState, next_state: nextState,
        supersedes_event_id: null, correlation_id: manifest.run_id,
    };
    const body = `/orchard ${gate.replace("-", "")} ${decision} item=${record.item_id} revision=${record.item_revision} digest=${record.digest}${reason ? ` reason="${reason}"` : ""}`;
    record.source.comment_digest = sha256Digest(body);
    const verifiedEvent = { body, repository: record.source.repository, comment_id: record.source.comment_id, actor: { immutable_id: record.actor.immutable_id } };
    return {
        record,
        authority: {
            schema_version: "1.0.0", queue_work_item_id: null,
            manifest, full_manifest_items: [structuredClone(reviewedItem)], current_item: structuredClone(reviewedItem),
            decision: record, verified_event: verifiedEvent, authorization_policy: gatePolicy,
            trust: { ...gateTrust, provider_event_digest: sha256Digest(verifiedEvent) },
        },
    };
}

// The ensemble stand-in, as in test-execution-runtime.mjs, plus one line: it
// keeps a copy of the briefs it was handed, because the brief is the only place
// a reviewer's reason can change what gets written.
function writeDeliveryStub(directory) {
    const path = join(directory, "delivery-stub.mjs");
    writeFileSync(path, [
        "import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const briefs = JSON.parse(readFileSync(process.env.BRIEF_PATH, 'utf8'));",
        "appendFileSync(process.env.TEST_BRIEF_CAPTURE, JSON.stringify(briefs) + '\\n');",
        "const root = process.env.RUN_RECORD_ROOT;",
        "mkdirSync(root, { recursive: true });",
        "const record = { runId: '01234567-1111-2222-3333-444455556666', proposals: briefs.map((brief) => ({",
        "  proposalPath: join(root, 'proposals', `proposal-${brief.id}-01234567.json`),",
        "  disposition: 'ready-for-draft', proposalDigest: 'sha-stub-1' })) };",
        "writeFileSync(join(root, 'run-20260816-000000-01234567.json'), JSON.stringify(record));",
    ].join("\n"));
    return path;
}

test("a Gate 2 request-changes decision is re-drafted by the next authoring run, with the reviewer's reason on the brief", async () => {
    const { store, runId, dbPath, directory } = await estate("track-1");
    store.provisionTrustAnchor({
        scope: "gate", adapter_identity: gateTrust.adapter_identity, adapter_digest: gateTrust.adapter_digest,
        policy_digest: gateTrust.authorization_policy_digest, policy: gatePolicy, provisioned_at: "2026-08-01T00:00:00.000Z",
    });

    // Gate 1 approved and linked, exactly as test-execution-runtime.mjs does.
    const [itemId] = await seedGateItems(store, runId, ["rework-end-to-end"]);
    const gate1Items = heldAtGate(store.db, "gate-1", "track-1").map(({ track: _track, ...entry }) => entry);
    const [gate1Manifest] = await generateGateManifests({ gate: "gate-1", runId, track: "track-1", items: gate1Items });
    const gate1 = gateAuthority({ manifest: gate1Manifest, reviewedItem: gate1Items[0], gate: "gate-1", decision: "approve", reason: null, previousState: "gate1-pending", nextState: "gate1-approved", ordinal: 1 });
    await store.recordVerifiedDecision(gate1.authority);
    const externalKey = `orchard:track-1:${itemId}:r1`;
    store.recordExternalLink({
        link_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
        provider: "ado", operation: "ado-link", external_key: externalKey, external_id: "4242", linked_at: "2026-08-16T10:02:00Z",
    });
    await transition(store, runId, itemId, "gate1-approved", "ado-linked", "ado-reconciled");
    const proposalDigest = gate1Items[0].proposal_digest;
    store.close();

    const inputs = authoringInputs(directory);
    const stub = writeDeliveryStub(directory);
    const capture = join(directory, "briefs-seen.jsonl");
    const authoringEnv = (workRoot) => ({
        ORCHARD_MAX_AUTHORING_SPEND_USD: "5.00", ORCHARD_ESTIMATED_ITEM_COST_USD: "0.75",
        ORCHARD_AUTHORING_WORK_ROOT: workRoot, ORCHARD_MODEL_MAP_PATH: inputs.mapPath,
        ORCHARD_SURFACE_TARGETS_PATH: inputs.targetsPath, ORCHARD_INVENTORY_PATH: inputs.inventoryPath,
        ORCHARD_DELIVERY_COMMAND: JSON.stringify([process.execPath, stub]), TEST_BRIEF_CAPTURE: capture,
    });

    // First draft, then Gate 2 preparation, as production runs them.
    const first = await runAuthoring(["--state-db", dbPath], { log: quiet, env: authoringEnv(join(directory, "authoring-1")) });
    assert.equal(first.briefs, 1);
    assert.equal(stateOf(dbPath, itemId).current_state, "gate2-ready");

    const evidenceRoot = join(directory, "evidence");
    mkdirSync(join(evidenceRoot, "gate2-evidence"), { recursive: true });
    const artifactDigest = digest("c");
    const handoff = {
        schema_version: "1.0.0", handoff_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
        proposal_digest: proposalDigest, gate1_decision_event_id: gate1.record.event_id,
        ado_external_key: externalKey, ado_work_item_id: 4242, role: "factual-verifier",
        model: { identity: "model-d", provider_family: "family-four", qualification_digest: digest("a") },
        prompt_version: "1.0.0", input_digest: digest("b"), output_digest: artifactDigest,
        predecessor_handoff_digest: null, status: "passed", findings: [],
        started_at: "2026-08-16T10:03:00Z", completed_at: "2026-08-16T10:04:00Z",
    };
    writeFileSync(join(evidenceRoot, "gate2-evidence", `${itemId}.json`), JSON.stringify({
        handoffs: [handoff],
        artifact_binding: {
            schema_version: "1.0.0", binding_id: generateUuidV7(),
            idempotency_key: `artifact-binding:track-1:${itemId}:r1:${sha256Digest(itemId)}`,
            run_id: runId, item_id: itemId, item_revision: 1, artifact_digest: artifactDigest,
            final_handoff_id: handoff.handoff_id, final_handoff_digest: artifactDigest,
            scope_digest: digest("d"), occurred_at: "2026-08-16T10:04:30Z",
        },
        manifest: {
            displayed_diff_digest: digest("e"), prepared_tree_digest: digest("f"), base_commit: "1".repeat(40),
            diff_ref: `github:commit:${"3".repeat(40)}:path:content/example.md`, artifact_ref: "evidence/artifact", handoff_chain_digest: digest("9"),
            tests: [{ name: "unit", status: "passed", evidence_ref: "evidence:test:unit" }],
            factual_review: { status: "passed", evidence_ref: "evidence:factual" },
            accessibility_review: { status: "passed", evidence_ref: "evidence:accessibility" },
            cost: { currency: "USD", amount: 0 },
        },
    }));
    const prep = await runGate2Prep(["--state-db", dbPath], { log: quiet, env: { ORCHARD_EVIDENCE_ROOT: evidenceRoot } });
    assert.equal(prep.prepared, 1);
    assert.equal(stateOf(dbPath, itemId).current_state, "gate2-pending");

    // The owner requests changes, through the same store call apply-gate-decisions.mjs makes.
    let decisionEventId;
    {
        const writer = openStateStore(dbPath);
        try {
            const gate2Items = heldAtGate(writer.db, "gate-2", "track-1").map(({ track: _track, ...entry }) => entry);
            const [gate2Manifest] = await generateGateManifests({ gate: "gate-2", runId, track: "track-1", items: gate2Items });
            const gate2 = gateAuthority({ manifest: gate2Manifest, reviewedItem: gate2Items[0], gate: "gate-2", decision: "request-changes", reason: REASON, previousState: "gate2-pending", nextState: "changes-requested", ordinal: 5 });
            await writer.recordVerifiedDecision(gate2.authority);
            decisionEventId = gate2.record.event_id;
            const transitions = writer.db.prepare("SELECT COUNT(*) AS n FROM state_transition_event WHERE item_id = ? AND to_state = 'changes-requested'").get(itemId).n;
            assert.equal(Number(transitions), 0, "the production decision path records no transition, which is why the reason has to be read off the decision event");
        } finally {
            writer.close();
        }
    }
    assert.equal(stateOf(dbPath, itemId).current_state, "changes-requested");

    // The next authoring run, and nothing else, picks it up.
    const second = await runAuthoring(["--state-db", dbPath], { log: quiet, env: authoringEnv(join(directory, "authoring-2")) });
    assert.equal(second.reworkRecovery.recovered.length, 1, "the authoring run reopened the returned item");
    assert.equal(second.reworkRecovery.remaining, 0);
    assert.equal(second.briefs, 1, "and drafted it in the same run");
    assert.equal(second.applied, 1);

    const after_ = stateOf(dbPath, itemId);
    assert.equal(after_.current_state, "gate2-ready", "the redraft is back on its way to Gate 2");
    assert.equal(Number(after_.current_revision), 2, "as a successor revision, never an edit of the rejected one");

    const briefsSeen = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(briefsSeen.length, 2);
    const redraft = briefsSeen[1].find((brief) => brief.subjectId === itemId);
    assert.ok(redraft, "the stand-in ensemble was handed the reworked item");
    assert.ok(redraft.prompt.includes("THIS IS A REWORK"), "the brief announces it is a rework");
    assert.ok(redraft.prompt.includes(REASON), "and carries the reviewer's reason verbatim");
    assert.ok(!briefsSeen[0][0].prompt.includes("THIS IS A REWORK"), "the first draft was not a rework");

    const verify = openStateStore(dbPath);
    try {
        const recovery = verify.listTransitions(itemId).find((entry) => entry.cause === "revision-created");
        assert.equal(recovery.from_state, "changes-requested");
        assert.equal(recovery.to_state, "executing");
        assert.equal(recovery.recovery_gate, "gate-2");
        assert.equal(recovery.successor_revision, 2);
        assert.equal(recovery.predecessor_decision_event_id, decisionEventId, "the successor revision names the decision it answers");
        assert.equal(recovery.actor, REWORK_ACTOR);
        const link = verify.db.prepare("SELECT external_id FROM external_link WHERE provider = 'ado' AND item_id = ? AND item_revision = 2").get(itemId);
        assert.equal(link?.external_id, "4242", "the ADO link is carried onto the successor revision, or Gate 2 evidence holds forever");
    } finally {
        verify.close();
    }
});

// --- guards --------------------------------------------------------------------

test("an item returned at Gate 2 is reopened at executing and briefed with the rework note", async () => {
    const { store, runId, dbPath, directory } = await estate();
    const id = await returnedAtGate2(store, runId, "rework-operator-path");
    assert.equal(countRecoverableRework(store.db), 1);

    const summary = await recoverReworkItems({ store, now: NOW });
    assert.equal(summary.recovered.length, 1, summary.refused.map((entry) => entry.reason).join("; "));
    assert.equal(summary.refused.length, 0, "stored Gate 2 evidence is what the reviewer rejected, not a reason to skip the redraft");
    assert.equal(countRecoverableRework(store.db), 0, "a reopened item is no longer counted, so the chain cannot keep restarting authoring for it");
    const manifest = store.db.prepare(
        "SELECT 1 FROM observation_event WHERE item_id = ? AND item_revision = 2 AND evidence_reference LIKE 'orchard/gate-manifest/gate-1:%'",
    ).get(id);
    store.close();
    assert.ok(manifest, "the Gate 1 title travels onto the successor revision");

    const after_ = stateOf(dbPath, id);
    assert.equal(after_.current_state, "executing");
    assert.equal(Number(after_.current_revision), 2);

    const inputs = authoringInputs(directory);
    const briefs = await generateBriefs({ dbPath, ...inputs, limit: 10 });
    const brief = briefs.briefs.find((entry) => entry.subjectId === id);
    assert.ok(brief, "the existing brief query claims the reopened item");
    assert.ok(brief.prompt.includes(REASON));
});

test("an item returned at Gate 1 is refused, named, and not counted", async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ["rework-gate-one"]);
    // Gate 1 request-changes: the item has no Gate 1 approval and no ADO item.
    // Moving it to executing would author work nobody approved.
    await transition(store, runId, id, "gate1-pending", "changes-requested", "decision-requested-changes", { reason: "narrow the scope" });

    assert.equal(countRecoverableRework(store.db), 0, "a Gate 1 return must not start an authoring run");
    const events = [];
    const summary = await recoverReworkItems({ store, now: NOW, log: (_l, event) => events.push(event) });
    const direct = await applyRetry(store, { item: id, now: NOW });
    store.close();

    assert.equal(summary.recovered.length, 0);
    assert.equal(summary.refused.length, 1);
    assert.match(summary.refused[0].reason, /gate-1/);
    assert.equal(summary.remaining, 0, "a refusal is not a backlog another run can drain");
    assert.ok(events.includes("gate2.rework.refused"));
    assert.equal(direct.retried, 0, "the retry tool refuses it too, so no operator path can claim gate-2 for it");
    assert.match(direct.errors[0], /Gate 1 return/);
    assert.equal(stateOf(dbPath, id).current_state, "changes-requested");
});

test("stale-approval is reopened only when Gate 2's approval went stale", async () => {
    const { store, runId, dbPath } = await estate();
    const [late, early] = await seedGateItems(store, runId, ["stale-at-gate-two", "stale-at-gate-one"]);
    await walkTo(store, runId, late, "gate2-approved");
    await transition(store, runId, late, "gate2-approved", "stale-approval", "approval-stale");
    await walkTo(store, runId, early, "gate1-approved");
    await transition(store, runId, early, "gate1-approved", "stale-approval", "approval-stale");

    assert.equal(countRecoverableRework(store.db), 1);
    const summary = await recoverReworkItems({ store, now: NOW });
    store.close();

    assert.deepEqual(summary.recovered.map((entry) => entry.item), [late]);
    assert.deepEqual(summary.refused.map((entry) => entry.item), [early]);
    assert.equal(stateOf(dbPath, late).current_state, "executing");
    assert.equal(stateOf(dbPath, early).current_state, "stale-approval");
});

test("the sweep is capped per run, counts only eligible work as remaining, and refuses an unpublishable target before spending", async () => {
    const { store, runId, dbPath } = await estate();
    const a = await returnedAtGate2(store, runId, "rework-cap-a");
    const b = await returnedAtGate2(store, runId, "rework-cap-b");
    const bad = await returnedAtGate2(store, runId, "rework-cap-untargetable");
    retarget(store, bad, "catalog.json");

    assert.equal(countRecoverableRework(store.db), 2, "the chain counts exactly what the sweep would reopen");
    assert.equal(classifyReworkItems(store.db).refused.length, 1);

    let spent = 0;
    const retry = async (s, options) => { spent += 1; return applyRetry(s, options); };
    const summary = await recoverReworkItems({ store, now: NOW, env: { ORCHARD_REWORK_RECOVERY_MAX_ITEMS: "1" }, retry });
    store.close();

    assert.equal(spent, 1, "the cap bounds spend, and the unpublishable item never reaches the drafter");
    assert.equal(summary.recovered.length, 1);
    assert.equal(summary.remaining, 1, "the one eligible item left is the backlog; the refused one is not");
    assert.match(summary.refused[0].reason, /catalogue\.selector-missing/);
    assert.equal(stateOf(dbPath, bad).current_state, "changes-requested");
    assert.equal([a, b].filter((id) => stateOf(dbPath, id).current_state === "executing").length, 1);

    // The caller's tighter limit wins, and the defaults are conservative.
    const second = await estate();
    await returnedAtGate2(second.store, second.runId, "rework-limit");
    const limited = await recoverReworkItems({ store: second.store, now: NOW, limit: 0 });
    second.store.close();
    assert.equal(limited.recovered.length, 0);
    assert.equal(limited.remaining, 1);
    assert.deepEqual(resolveReworkBounds({}), { maxItems: DEFAULT_MAX_REWORK_ITEMS });
    assert.deepEqual(resolveReworkBounds({ ORCHARD_REWORK_RECOVERY_MAX_ITEMS: "lots" }), { maxItems: DEFAULT_MAX_REWORK_ITEMS });
});

test("the reviewer's reason is read off the decision event when no transition carries it", async () => {
    const { store, runId } = await estate();
    const [id] = await seedGateItems(store, runId, ["rework-note-source"]);
    const { reworkNoteFor } = await import("./generate-briefs.mjs");
    assert.equal(reworkNoteFor(store.db, id), null, "no rework history costs nothing");
    store.db.prepare(
        `INSERT INTO decision_event (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
            actor_immutable_id, source_repository, source_issue_number, source_comment_id, correlation_id,
            supersedes_event_id, idempotency_key, occurred_at, record_json)
         VALUES (?, 'gate-2', ?, ?, 1, ?, 'request-changes', 'github', '1001', 'project42dev/orchard', 1, 'c1', ?, NULL, ?, ?, ?)`,
    ).run(generateUuidV7(), runId, id, digest("c"), runId, `k-${id}`, NOW, JSON.stringify({ reason: REASON }));
    const note = reworkNoteFor(store.db, id);
    store.close();
    assert.equal(note, `${REWORK_PREFIX}${REASON}`);
});
