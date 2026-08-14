import assert from "node:assert/strict";
import { test } from "node:test";

import {
    compileSchema,
    loadJson,
    schemaRegistry,
    validateContractBindings,
    validateRecord
} from "../scripts/lib/contracts.mjs";

const FIXTURE_DIRECTORY = new URL("../contracts/fixtures/", import.meta.url);

const fixtureMap = Object.freeze({
    "agent-handoff.valid.json": "agent-handoff",
    "closure-evidence-packet.valid.json": "closure-evidence-packet",
    "decision-event.valid.json": "decision-event",
    "gate-1-track-1.valid.json": "gate-1-issue-manifest",
    "gate-1-track-2.valid.json": "gate-1-issue-manifest",
    "gate-2-track-1.valid.json": "gate-2-issue-manifest",
    "gate-2-track-2.valid.json": "gate-2-issue-manifest",
    "negative-transition.valid.json": "state-transition",
    "publication-transaction.valid.json": "publication-transaction",
    "supersession-transition.valid.json": "state-transition",
    "track-1-item.valid.json": "item-record",
    "track-1-run.valid.json": "run-manifest",
    "track-2-item.valid.json": "item-record",
    "track-2-run.valid.json": "run-manifest"
});

async function fixture(name) {
    return loadJson(new URL(name, FIXTURE_DIRECTORY));
}

function changedDigest(digest) {
    return `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
}

function assertHasCode(result, code, label = "validation") {
    assert.equal(result.valid, false, `${label} unexpectedly passed`);
    assert.ok(result.errors.some((entry) => entry.code === code), `${label}: expected error code ${code}; received ${JSON.stringify(result.errors)}`);
}

async function lifecycleRecords() {
    const [run, itemFixture, gate1, handoff, gate2, gate2Decision, publication] = await Promise.all([
        fixture("track-1-run.valid.json"),
        fixture("track-1-item.valid.json"),
        fixture("gate-1-track-1.valid.json"),
        fixture("agent-handoff.valid.json"),
        fixture("gate-2-track-1.valid.json"),
        fixture("decision-event.valid.json"),
        fixture("publication-transaction.valid.json")
    ]);
    const item = {
        ...itemFixture,
        state: "gate2-pending",
        artifact_digest: gate2.items[0].artifact_digest,
        updated_at: "2026-08-11T10:00:00Z"
    };
    const gate1Decision = {
        ...structuredClone(gate2Decision),
        event_id: handoff.gate1_decision_event_id,
        gate: "gate-1",
        digest: item.proposal_digest,
        previous_state: "gate1-pending",
        next_state: "gate1-approved"
    };
    return { run, item, gate1, gate1Decision, handoffs: [handoff], gate2, gate2Decision, publication };
}

test("all nine normative schemas compile in strict Draft 2020-12 mode", async () => {
    assert.equal(Object.keys(schemaRegistry).length, 9);
    for (const name of Object.keys(schemaRegistry)) {
        assert.equal(typeof await compileSchema(name), "function", name);
    }
});

test("all 14 normative positive fixtures validate against their mapped contracts", async () => {
    assert.equal(Object.keys(fixtureMap).length, 14);
    for (const [fileName, schemaName] of Object.entries(fixtureMap)) {
        const result = await validateRecord(schemaName, await fixture(fileName));
        assert.deepEqual(result, { valid: true, errors: [] }, `${fileName}: ${JSON.stringify(result.errors)}`);
    }
});

test("closure packet digest covers every immutable evidence field", async () => {
    const packet = await fixture("closure-evidence-packet.valid.json");
    assert.deepEqual(await validateRecord("closure-evidence-packet", packet), { valid: true, errors: [] });
    for (const mutate of [
        (copy) => { copy.scope_digest = changedDigest(copy.scope_digest); },
        (copy) => { copy.gate_2.event_id = "018f3000-0000-7000-8000-000000000099"; },
        (copy) => { copy.pull_request.number += 1; },
        (copy) => { copy.residual_risks.push("new residual risk"); }
    ]) {
        const changed = structuredClone(packet);
        mutate(changed);
        assertHasCode(await validateRecord("closure-evidence-packet", changed), "binding.mismatch");
    }
});

test("schema diagnostics are stable and structured", async () => {
    const record = await fixture("track-1-item.valid.json");
    record.schema_version = "2.0.0";
    delete record.item_id;

    const first = await validateRecord("item-record", record);
    const second = await validateRecord("item-record", record);
    assert.deepEqual(first, second);
    assertHasCode(first, "schema.required");
    assertHasCode(first, "schema.const");
    assert.ok(first.errors.every(({ code, path, message }) => code && path && message));
});

test("Track 1 completed full runs enforce thresholds and complete outcome accounting", async () => {
    const underThreshold = await fixture("track-1-run.valid.json");
    underThreshold.coverage.approved_enabled_source_count = 49;
    underThreshold.coverage.attempted = 45;
    underThreshold.coverage.successfully_evaluated = 43;
    underThreshold.coverage.skipped = 4;
    assert.equal((await validateRecord("run-manifest", underThreshold)).valid, false);

    const incompleteOutcomes = await fixture("track-1-run.valid.json");
    incompleteOutcomes.coverage.successfully_evaluated -= 1;
    assertHasCode(await validateRecord("run-manifest", incompleteOutcomes), "run.track1.attempt-accounting");

    const incompleteRegistry = await fixture("track-1-run.valid.json");
    incompleteRegistry.coverage.skipped -= 1;
    assertHasCode(await validateRecord("run-manifest", incompleteRegistry), "run.track1.registry-accounting");
});

test("Track 2 completed full runs require exact expected, enumerated, and inspected coverage with zero gaps", async () => {
    for (const property of ["enumerated", "inspected"]) {
        const mismatch = await fixture("track-2-run.valid.json");
        mismatch.coverage[property] -= 1;
        assertHasCode(await validateRecord("run-manifest", mismatch), "run.track2.coverage-mismatch");
    }

    const scopeMismatch = await fixture("track-2-run.valid.json");
    scopeMismatch.scope.expected_count += 1;
    assertHasCode(await validateRecord("run-manifest", scopeMismatch), "binding.mismatch");

    const gaps = await fixture("track-2-run.valid.json");
    gaps.coverage.gaps = 1;
    assert.equal((await validateRecord("run-manifest", gaps)).valid, false);
});

test("gate manifests enforce deterministic idempotency and batch accounting", async () => {
    const wrongKey = await fixture("gate-1-track-1.valid.json");
    wrongKey.idempotency_key = changedDigest(wrongKey.idempotency_key);
    assertHasCode(await validateRecord("gate-1-issue-manifest", wrongKey), "binding.mismatch");

    const wrongCount = await fixture("gate-2-track-1.valid.json");
    wrongCount.batch.item_count += 1;
    assertHasCode(await validateRecord("gate-2-issue-manifest", wrongCount), "binding.mismatch");

    const impossibleOrdinal = await fixture("gate-1-track-1.valid.json");
    impossibleOrdinal.batch.ordinal = 2;
    assertHasCode(await validateRecord("gate-1-issue-manifest", impossibleOrdinal), "gate.batch.ordinal");
});

test("revision-created transitions require monotonic successor revisions", async () => {
    const transition = await fixture("negative-transition.valid.json");
    transition.successor_revision = transition.item_revision;
    assertHasCode(await validateRecord("state-transition", transition), "transition.revision.monotonic");
});

test("a complete lifecycle with exact run, track, item, revision, decision, handoff, ADO, and publication bindings passes", async () => {
    assert.deepEqual(validateContractBindings(await lifecycleRecords()), { valid: true, errors: [] });
});

test("one-byte proposal and artifact digest changes fail closed", async () => {
    const proposalMismatch = await lifecycleRecords();
    proposalMismatch.gate1.items[0].proposal_digest = changedDigest(proposalMismatch.gate1.items[0].proposal_digest);
    assertHasCode(validateContractBindings(proposalMismatch), "binding.mismatch");

    const artifactMismatch = await lifecycleRecords();
    artifactMismatch.gate2.items[0].artifact_digest = changedDigest(artifactMismatch.gate2.items[0].artifact_digest);
    assertHasCode(validateContractBindings(artifactMismatch), "binding.mismatch");
});

test("stale Gate 1 and Gate 2 revisions cannot authorize the current item", async () => {
    for (const location of ["gate1", "gate1Decision", "gate2", "gate2Decision"]) {
        const records = await lifecycleRecords();
        if (location === "gate1" || location === "gate2") records[location].items[0].item_revision += 1;
        else records[location].item_revision += 1;
        assertHasCode(validateContractBindings(records), "binding.mismatch", `stale ${location} revision`);
    }
});

test("handoff identity, approval, predecessor, and ADO bindings are exact", async () => {
    for (const property of ["item_id", "item_revision", "proposal_digest", "gate1_decision_event_id", "ado_external_key"]) {
        const records = await lifecycleRecords();
        records.handoffs[0][property] = property === "item_revision"
            ? records.handoffs[0][property] + 1
            : `${records.handoffs[0][property]}-mismatch`;
        assertHasCode(validateContractBindings(records), "binding.mismatch", `handoff ${property}`);
    }

    const records = await lifecycleRecords();
    const successor = { ...structuredClone(records.handoffs[0]), handoff_id: "018f2000-0000-7000-8000-000000000002" };
    successor.predecessor_handoff_digest = changedDigest(records.handoffs[0].output_digest);
    records.handoffs.push(successor);
    assertHasCode(validateContractBindings(records), "binding.mismatch", "handoff predecessor digest");
});

test("publication is bound to the reviewed decision, artifact, diff, tree, base commit, target, and pull request", async () => {
    const mutations = [
        (records) => { records.publication.gate2_decision_event_id = "018f3000-0000-7000-8000-000000000099"; },
        (records) => { records.publication.artifact_digest = changedDigest(records.publication.artifact_digest); },
        (records) => { records.publication.displayed_diff_digest = changedDigest(records.publication.displayed_diff_digest); },
        (records) => { records.publication.prepared_tree_digest = changedDigest(records.publication.prepared_tree_digest); },
        (records) => { records.publication.base_commit = "0000000000000000000000000000000000000000"; },
        (records) => { records.publication.target.path = "content/learning/other-module.json"; },
        (records) => { records.publication.pull_request.displayed_diff_digest = changedDigest(records.publication.pull_request.displayed_diff_digest); }
    ];

    for (const [index, mutate] of mutations.entries()) {
        const records = await lifecycleRecords();
        mutate(records);
        assertHasCode(validateContractBindings(records), "binding.mismatch", `publication mutation ${index}`);
    }
});
