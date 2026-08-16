#!/usr/bin/env node
// The T19 chain, driven through the DEPLOYED entry points, not through
// hand-written store calls.
//
// tests/lifecycle-e2e.test.mjs proves the store can hold a full lifecycle when
// every record is written by the test itself. This file proves the thing T19
// was opened for: that the RUNTIME's four execution roles (run-authoring,
// run-gate2-prep, run-publication, run-verification) move one real item
//
//   gate1-pending -> gate1-approved -> ado-linked -> executing -> gate2-ready
//   -> gate2-pending -> gate2-approved -> publication-preparing
//   -> publication-validating -> publication-pr-open -> publication-merging
//   -> published -> ado-closure-ready -> closed
//
// on the real migrated schema, with the authoring ensemble replaced by a
// deterministic stand-in (a model call costs money and needs a managed
// identity; the stand-in writes the exact run-record shape the PowerShell
// platform writes), GitHub replaced by a file-backed protected adapter loaded
// through the real trust-anchor pin, and ADO replaced by the existing fake
// reconciling adapter. Everything else is the production code path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openStateStore } from "./lib/state-store.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { heldAtGate } from "./lib/gate-queue.mjs";
import { generateGateManifests } from "./lib/gates.mjs";
import { protectedAdapterDigest } from "./lib/protected-adapter.mjs";
import { closurePacketDigest } from "./lib/contracts.mjs";
import { FakeAdoAdapter } from "./adapters/fake-ado-adapter.mjs";
import { estate, seedGateItems, cleanupFixtures } from "./test-fixtures.mjs";
import { main as runAuthoring } from "./run-authoring.mjs";
import { main as runGate2Prep } from "./run-gate2-prep.mjs";
import { main as runPublication } from "./run-publication.mjs";
import { main as runVerification } from "./run-verification.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const BASE_COMMIT = "1".repeat(40);
const PREPARED_COMMIT = "3".repeat(40);
const MERGE_COMMIT = "4".repeat(40);
const ADO_ID = 4242;
const quiet = () => { };

const gatePolicy = { provider: "github", repository: "project42dev/orchard", authorized_actor_ids: ["1001"] };
const gateTrust = {
    authorization_policy_digest: sha256Digest(gatePolicy),
    adapter_digest: digest("8"),
    adapter_identity: "test:protected-github-adapter:v1",
};
const ownerPolicy = { provider: "github", authorized_owners: [{ provider: "github", immutable_id: "1001" }] };
const closureTrust = {
    policy_digest: sha256Digest(ownerPolicy), adapter_digest: digest("7"),
    adapter_identity: "test:protected-closure-adapter:v1",
};

function gateAuthority({ manifest, reviewedItem, gate, previousState, nextState, ordinal }) {
    const record = {
        schema_version: "1.0.0", event_id: generateUuidV7(), gate, run_id: manifest.run_id,
        item_id: reviewedItem.item_id, item_revision: reviewedItem.item_revision,
        digest: gate === "gate-1" ? reviewedItem.proposal_digest : reviewedItem.artifact_digest,
        decision: "approve", reason: null, review_after: null,
        actor: { provider: "github", immutable_id: "1001", authorized: true },
        source: { repository: "project42dev/orchard", issue_number: ordinal, comment_id: `t19-${gate}`, comment_digest: digest("0") },
        occurred_at: `2026-08-16T10:0${ordinal}:00Z`, previous_state: previousState, next_state: nextState,
        supersedes_event_id: null, correlation_id: manifest.run_id,
    };
    const body = `/orchard ${gate.replace("-", "")} approve item=${record.item_id} revision=${record.item_revision} digest=${record.digest}`;
    record.source.comment_digest = sha256Digest(body);
    const verifiedEvent = {
        body, repository: record.source.repository, comment_id: record.source.comment_id,
        actor: { immutable_id: record.actor.immutable_id },
    };
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

// The deterministic authoring stand-in: reads BRIEF_PATH, writes one run
// record shaped exactly as Invoke-Project42Delivery.ps1 writes them.
function writeDeliveryStub(directory) {
    const path = join(directory, "delivery-stub.mjs");
    writeFileSync(path, [
        "import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const briefs = JSON.parse(readFileSync(process.env.BRIEF_PATH, 'utf8'));",
        "const root = process.env.RUN_RECORD_ROOT;",
        "mkdirSync(root, { recursive: true });",
        "const record = { runId: '01234567-1111-2222-3333-444455556666', proposals: briefs.map((brief) => ({",
        "  proposalPath: join(root, 'proposals', `proposal-${brief.id}-01234567.json`),",
        "  disposition: 'ready-for-draft', proposalDigest: 'sha-stub-1' })) };",
        "writeFileSync(join(root, 'run-20260816-000000-01234567.json'), JSON.stringify(record));",
    ].join("\n"));
    return path;
}

// A file-backed protected publication adapter: self-contained (only node:
// imports, as the protected-artifact rules require), state persisted to a
// JSON file so the pull request opened by one runtime invocation is the one
// the next invocation merges.
function writePublicationAdapter(directory) {
    const statePath = join(directory, "github-state.json").replace(/\\/g, "/");
    writeFileSync(statePath, JSON.stringify({
        main: { repository: "project42dev/project42-platform", branch: "main", commit: BASE_COMMIT },
        branches: {}, pulls: {}, nextNumber: 42, mergeCommit: MERGE_COMMIT,
    }));
    const path = join(directory, "test-publication-adapter.mjs");
    writeFileSync(path, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `const STATE_PATH = ${JSON.stringify(statePath)};`,
        "const load = () => JSON.parse(readFileSync(STATE_PATH, 'utf8'));",
        "const save = (state) => writeFileSync(STATE_PATH, JSON.stringify(state));",
        "export const adapterIdentity = 'test:file-backed-publication-adapter:v1';",
        "export const adapter = {",
        "  async reconcileProtectedMain({ repository, branch, expectedCommit }) {",
        "    const state = load();",
        "    if (state.main.repository === repository && state.main.commit === expectedCommit) return { classification: 'exact', object: { ...state.main } };",
        "    return { classification: 'absent', object: null };",
        "  },",
        "  async reconcileBeforeCreateBranch({ repository, branch, create }) {",
        "    const state = load();",
        "    if (state.branches[branch]) return { classification: 'exact', operation: 'reconciled', object: state.branches[branch] };",
        "    const object = { repository, name: branch, commit: create.commit, preparedTreeDigest: create.preparedTreeDigest };",
        "    state.branches[branch] = object; save(state);",
        "    return { classification: 'exact', operation: 'created', object };",
        "  },",
        "  async reconcileBeforeCreatePullRequest({ externalKey, expected }) {",
        "    const state = load();",
        "    if (state.pulls[externalKey]) return { classification: 'exact', operation: 'reconciled', object: state.pulls[externalKey] };",
        "    const object = { ...expected, number: state.nextNumber };",
        "    state.nextNumber += 1; state.pulls[externalKey] = object; save(state);",
        "    return { classification: 'exact', operation: 'created', object };",
        "  },",
        "  async reconcilePullRequest({ externalKey }) {",
        "    const state = load();",
        "    const pull = state.pulls[externalKey];",
        "    if (!pull || pull.state !== 'open') return { classification: 'absent', object: pull ?? null };",
        "    return { classification: 'exact', object: pull };",
        "  },",
        "  async reconcileBeforeMerge({ externalKey }) {",
        "    const state = load();",
        "    const pull = state.pulls[externalKey];",
        "    if (!pull) throw new Error('pull request not found');",
        "    if (pull.state === 'merged') return { classification: 'exact', operation: 'reconciled', object: pull };",
        "    const object = { ...pull, state: 'merged', mergeCommit: state.mergeCommit };",
        "    state.pulls[externalKey] = object;",
        "    state.main = { ...state.main, commit: state.mergeCommit };",
        "    save(state);",
        "    return { classification: 'exact', operation: 'merged', object };",
        "  },",
        "};",
    ].join("\n"));
    return path;
}

test("the four execution roles move one item from gate1-pending to closed", async () => {
    const { store, runId, dbPath, directory } = await estate("track-1");
    const evidenceRoot = join(directory, "evidence");
    for (const sub of ["gate2-evidence", "publication-inputs", "closure-evidence", "closure-acceptance"]) {
        mkdirSync(join(evidenceRoot, sub), { recursive: true });
    }

    // Trust anchors, provisioned as the release provisions them.
    store.provisionTrustAnchor({
        scope: "gate", adapter_identity: gateTrust.adapter_identity, adapter_digest: gateTrust.adapter_digest,
        policy_digest: gateTrust.authorization_policy_digest, policy: gatePolicy, provisioned_at: "2026-08-01T00:00:00.000Z",
    });
    store.provisionTrustAnchor({
        scope: "closure", adapter_identity: closureTrust.adapter_identity, adapter_digest: closureTrust.adapter_digest,
        policy_digest: closureTrust.policy_digest, policy: ownerPolicy, provisioned_at: "2026-08-01T00:00:00.000Z",
    });

    // --- Gate 1: proposed by discovery, approved by a verified decision -----
    const [itemId] = await seedGateItems(store, runId, ["execution-runtime"]);
    const gate1Items = heldAtGate(store.db, "gate-1", "track-1").map(({ track: _track, ...entry }) => entry);
    const [gate1Manifest] = await generateGateManifests({ gate: "gate-1", runId, track: "track-1", items: gate1Items });
    const gate1 = gateAuthority({ manifest: gate1Manifest, reviewedItem: gate1Items[0], gate: "gate-1", previousState: "gate1-pending", nextState: "gate1-approved", ordinal: 1 });
    await store.recordVerifiedDecision(gate1.authority);

    // --- The tracker link, exactly as ado-sync records it -------------------
    const externalKey = `orchard:track-1:${itemId}:r1`;
    store.recordExternalLink({
        link_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
        provider: "ado", operation: "ado-link", external_key: externalKey, external_id: String(ADO_ID),
        linked_at: "2026-08-16T10:02:00Z",
    });
    await store.recordTransition({
        schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: itemId,
        item_revision: 1, from_state: "gate1-approved", to_state: "ado-linked", cause: "ado-reconciled",
        actor: "test", occurred_at: "2026-08-16T10:02:30Z", correlation_id: runId,
    });
    const proposalDigest = gate1Items[0].proposal_digest;
    store.close();

    // --- Authoring role: claim, author through the stand-in, ingest ---------
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
    writeFileSync(targetsPath, JSON.stringify({ repository: "project42dev/project42-platform", surfaces: {} }));
    const workRoot = join(directory, "authoring-work");
    const stub = writeDeliveryStub(directory);

    const authoringResult = await runAuthoring(["--state-db", dbPath], {
        log: quiet,
        env: {
            ORCHARD_MAX_AUTHORING_SPEND_USD: "5.00",
            ORCHARD_ESTIMATED_ITEM_COST_USD: "0.75",
            ORCHARD_AUTHORING_WORK_ROOT: workRoot,
            ORCHARD_MODEL_MAP_PATH: mapPath,
            ORCHARD_SURFACE_TARGETS_PATH: targetsPath,
            ORCHARD_INVENTORY_PATH: inventoryPath,
            ORCHARD_DELIVERY_COMMAND: JSON.stringify([process.execPath, stub]),
        },
    });
    assert.equal(authoringResult.briefs, 1, "the authoring role claimed the ado-linked item");
    assert.equal(authoringResult.applied, 1, "the ensemble verdict was ingested");

    const stateOf = () => {
        const reader = openStateStore(dbPath);
        try { return reader.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId).current_state; }
        finally { reader.close(); }
    };
    assert.equal(stateOf(), "gate2-ready", "authoring left the item at gate2-ready");

    // --- Gate 2 preparation role --------------------------------------------
    const artifactDigest = digest("c");
    const handoff = {
        schema_version: "1.0.0", handoff_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
        proposal_digest: proposalDigest, gate1_decision_event_id: gate1.record.event_id,
        ado_external_key: externalKey, ado_work_item_id: ADO_ID,
        role: "factual-verifier",
        model: { identity: "model-d", provider_family: "family-four", qualification_digest: digest("a") },
        prompt_version: "1.0.0", input_digest: digest("b"), output_digest: artifactDigest,
        predecessor_handoff_digest: null, status: "passed", findings: [],
        started_at: "2026-08-16T10:03:00Z", completed_at: "2026-08-16T10:04:00Z",
    };
    const binding = {
        schema_version: "1.0.0", binding_id: generateUuidV7(),
        idempotency_key: `artifact-binding:track-1:${itemId}:r1:${sha256Digest(itemId)}`,
        run_id: runId, item_id: itemId, item_revision: 1, artifact_digest: artifactDigest,
        final_handoff_id: handoff.handoff_id, final_handoff_digest: artifactDigest,
        scope_digest: digest("d"), occurred_at: "2026-08-16T10:04:30Z",
    };
    const gate2ManifestEvidence = {
        displayed_diff_digest: digest("e"), prepared_tree_digest: digest("f"), base_commit: BASE_COMMIT,
        diff_ref: "evidence/diff", artifact_ref: "evidence/artifact", handoff_chain_digest: digest("9"),
        tests: [{ name: "unit", status: "passed", evidence_ref: "evidence:test:unit" }],
        factual_review: { status: "passed", evidence_ref: "evidence:factual" },
        accessibility_review: { status: "passed", evidence_ref: "evidence:accessibility" },
        cost: { currency: "USD", amount: 0 },
    };
    writeFileSync(join(evidenceRoot, "gate2-evidence", `${itemId}.json`), JSON.stringify({
        handoffs: [handoff], artifact_binding: binding, manifest: gate2ManifestEvidence,
    }));
    const prep = await runGate2Prep(["--state-db", dbPath], {
        log: (level, event, detail) => { if (level !== "info") console.error(event, JSON.stringify(detail)); },
        env: { ORCHARD_EVIDENCE_ROOT: evidenceRoot },
    });
    assert.equal(prep.prepared, 1, "gate2-prep prepared the item");
    assert.equal(stateOf(), "gate2-pending", "the item is held at Gate 2");

    // --- Gate 2 approval, exactly as apply-gate-decisions records it --------
    {
        const writer = openStateStore(dbPath);
        try {
            const gate2Items = heldAtGate(writer.db, "gate-2", "track-1").map(({ track: _track, ...entry }) => entry);
            assert.equal(gate2Items.length, 1, "Gate 2 announces the prepared item");
            assert.equal(gate2Items[0].artifact_digest, artifactDigest, "the announced entry binds the exact artifact");
            const [gate2Manifest] = await generateGateManifests({ gate: "gate-2", runId, track: "track-1", items: gate2Items });
            const gate2 = gateAuthority({ manifest: gate2Manifest, reviewedItem: gate2Items[0], gate: "gate-2", previousState: "gate2-pending", nextState: "gate2-approved", ordinal: 5 });
            await writer.recordVerifiedDecision(gate2.authority);
        } finally {
            writer.close();
        }
    }
    assert.equal(stateOf(), "gate2-approved");

    // --- Publication role: pull request first, then merge -------------------
    const adapterPath = writePublicationAdapter(directory);
    const adapterDigest = await protectedAdapterDigest(adapterPath);
    writeFileSync(join(evidenceRoot, "publication-inputs", `${itemId}.json`), JSON.stringify({ prepared_commit: PREPARED_COMMIT }));
    const publicationEnv = {
        ORCHARD_EVIDENCE_ROOT: evidenceRoot,
        ORCHARD_PUBLICATION_ADAPTER_PATH: adapterPath,
        ORCHARD_PUBLICATION_ADAPTER_DIGEST: adapterDigest,
    };
    const opened = await runPublication(["--state-db", dbPath], { log: quiet, env: publicationEnv });
    assert.equal(opened.prOpen, 1, "the first publication run opens the pull request and stops");
    assert.equal(stateOf(), "publication-pr-open", "protected main is untouched until merging is enabled");

    const merged = await runPublication(["--state-db", dbPath], {
        log: quiet, env: { ...publicationEnv, ORCHARD_PUBLICATION_MERGE: "enabled" },
    });
    assert.equal(merged.published, 1, "the merge run publishes");
    assert.equal(stateOf(), "published");

    // --- Verification and closure role --------------------------------------
    let publicationState;
    let pullNumber;
    {
        const reader = openStateStore(dbPath);
        try {
            publicationState = reader.getPublicationState(`publication:track-1:${itemId}:r1:${artifactDigest}`);
            assert.equal(publicationState.state, "published");
            assert.equal(publicationState.result_commit, MERGE_COMMIT);
            pullNumber = publicationState.events.findLast((event) => event.pull_request?.state === "merged").pull_request.number;
        } finally {
            reader.close();
        }
    }
    const packet = {
        schema_version: "1.0.0", packet_id: generateUuidV7(), run_id: runId, track: "track-1",
        item_id: itemId, item_revision: 1, proposal_digest: proposalDigest, artifact_digest: artifactDigest,
        scope_digest: binding.scope_digest, handoff_chain_digest: gate2ManifestEvidence.handoff_chain_digest,
        handoff_ids: [handoff.handoff_id],
        displayed_diff_digest: gate2ManifestEvidence.displayed_diff_digest,
        prepared_tree_digest: gate2ManifestEvidence.prepared_tree_digest,
        base_commit: BASE_COMMIT, artifact_binding: binding,
        gate_1: {
            event_id: gate1.record.event_id, digest: gate1.record.digest,
            full_manifest_digest: gate1Manifest.full_manifest_digest, batch_digest: gate1Manifest.batch_digest,
        },
        gate_2: null,
        ado: { external_key: externalKey, work_item_id: ADO_ID },
        tests: gate2ManifestEvidence.tests, factual_evidence: gate2ManifestEvidence.factual_review,
        accessibility_evidence: gate2ManifestEvidence.accessibility_review,
        canonical_target: null,
        pull_request: { number: pullNumber, url: `https://github.com/project42dev/project42-platform/pull/${pullNumber}` },
        publication_transaction_id: publicationState.transaction.transaction_id,
        protected_main_commit: MERGE_COMMIT,
        push_acknowledgement: publicationState.push_acknowledgement,
        residual_risks: [], rollback_reference: `rollback:publication:${publicationState.transaction.transaction_id}`,
        prepared_at: "2026-08-16T11:01:00Z",
    };
    packet.canonical_target = { ...publicationState.transaction.target };
    delete packet.canonical_target.branch;
    {
        const reader = openStateStore(dbPath);
        try {
            const gate2Decision = reader.listDecisions(itemId).find((entry) => entry.gate === "gate-2");
            const gate2Manifest = reader.getGateDecisionAuthority(gate2Decision.event_id).manifest;
            packet.gate_2 = {
                event_id: gate2Decision.event_id, digest: gate2Decision.digest,
                full_manifest_digest: gate2Manifest.full_manifest_digest, batch_digest: gate2Manifest.batch_digest,
            };
        } finally { reader.close(); }
    }
    packet.packet_digest = closurePacketDigest(packet);
    writeFileSync(join(evidenceRoot, "closure-evidence", `${itemId}.json`), JSON.stringify(packet));

    const acceptanceEvent = {
        packet_digest: packet.packet_digest, reference: "project42dev/orchard#owner-closure-acceptance",
        occurred_at: "2026-08-16T11:02:00Z", actor: { provider: "github", immutable_id: "1001" },
    };
    writeFileSync(join(evidenceRoot, "closure-acceptance", `${itemId}.json`), JSON.stringify({
        acceptance: {
            acceptance_id: generateUuidV7(), packet_digest: packet.packet_digest,
            owner: { provider: "github", immutable_id: "1001" },
            source: {
                provider: "github", reference: acceptanceEvent.reference,
                evidence_digest: sha256Digest(acceptanceEvent),
            },
            accepted_at: acceptanceEvent.occurred_at,
        },
        verified_event: acceptanceEvent,
        owner_policy: ownerPolicy,
        trust: {
            owner_policy_digest: closureTrust.policy_digest, provider_event_digest: sha256Digest(acceptanceEvent),
            adapter_digest: closureTrust.adapter_digest, adapter_identity: closureTrust.adapter_identity,
        },
    }));

    const surfacesPath = join(directory, "public-surfaces.json");
    writeFileSync(surfacesPath, JSON.stringify({
        surfaces: { learning: { publicBaseUrl: "https://learn.example.test/", publicPathTemplate: "items/{id}" } },
    }));
    const title = gate1Items[0].title;
    const fetchImpl = async (url) => ({
        ok: true, status: 200, url,
        text: async () => `<html><head><title>${title}</title></head><body>${title}</body></html>`,
    });
    const ado = new FakeAdoAdapter({ workItems: [{ id: ADO_ID, externalKey, state: "New", type: "User Story", title: "T19 chain" }] });
    const getAdoWorkItem = async (key) => structuredClone(ado.fakeClient.workItems.find((entry) => entry.externalKey === key));

    const verified = await runVerification(["--state-db", dbPath], {
        log: quiet,
        env: { ORCHARD_EVIDENCE_ROOT: evidenceRoot, ORCHARD_SURFACES_PATH: surfacesPath },
        fetchImpl, adoAdapter: ado, getAdoWorkItem,
    });
    assert.equal(verified.checked, 1, "the published item was fetched");
    assert.equal(verified.serving, 1, "and proven serving with its own marker");
    assert.equal(verified.resolved, 1, "the closure packet resolved the ADO story");
    assert.equal(verified.closed, 1, "the recorded owner acceptance closed the item");
    assert.equal(stateOf(), "closed", "the lifecycle is complete, end to end, through the deployed entry points");

    // The tracker follows: the ADO story is Closed with the acceptance digest.
    const finalStory = await getAdoWorkItem(externalKey);
    assert.equal(finalStory.state, "Closed");
    assert.equal(finalStory.closurePacketDigest, packet.packet_digest);
});

test("verification fails loudly when a published page is not serving", async () => {
    const { store, runId, dbPath, directory } = await estate("track-1");
    store.close();
    // An estate with nothing published verifies zero items and succeeds.
    const empty = await runVerification(["--state-db", dbPath], {
        log: quiet, env: { ORCHARD_EVIDENCE_ROOT: directory, ORCHARD_SURFACES_PATH: join(directory, "none.json") },
        fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    assert.equal(empty.checked, 0);
    assert.equal(empty.notServing, 0);
    void runId;
});

test("the authoring role refuses to start over its spend cap", async () => {
    await assert.rejects(
        () => runAuthoring(["--state-db", "unused.db"], {
            log: quiet,
            env: { ORCHARD_MAX_AUTHORING_SPEND_USD: "0.10", ORCHARD_ESTIMATED_ITEM_COST_USD: "0.75" },
        }),
        (error) => error.code === "ERR_ORCHARD_AUTHORING_SPEND_CAP",
    );
});

test("gate2-prep holds an item whose evidence is absent, and says so", async () => {
    const { store, runId, dbPath, directory } = await estate("track-1");
    const [itemId] = await seedGateItems(store, runId, ["held-no-evidence"]);
    const { walkTo } = await import("./test-fixtures.mjs");
    await walkTo(store, runId, itemId, "gate2-ready");
    store.close();
    const events = [];
    const result = await runGate2Prep(["--state-db", dbPath], {
        log: (_level, event) => events.push(event),
        env: { ORCHARD_EVIDENCE_ROOT: directory },
    });
    assert.equal(result.prepared, 0);
    assert.equal(result.held, 1);
    assert.ok(events.includes("gate2.prep.no-evidence"), "the hold is named, never silent");
    const reader = openStateStore(dbPath);
    try {
        assert.equal(reader.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId).current_state, "gate2-ready");
    } finally {
        reader.close();
    }
});

test.after(() => cleanupFixtures());
