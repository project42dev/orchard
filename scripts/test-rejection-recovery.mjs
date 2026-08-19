#!/usr/bin/env node
// docs/design/rejection-gate.md, owner request 2026-08-18: an item the
// ensemble blocks gets one automatic retry, and a second block escalates
// straight to Gate 2 with the real rejection reason and the actual
// rejected draft, instead of a third blind retry or a permanent dead end.
//
// These tests drive attemptRejectionRecovery directly against the real
// migrated schema (estate/seedGateItems/walkTo from test-fixtures.mjs),
// with a controlled fetchImpl standing in for the GitHub Git Data API
// calls prepareRealCommit makes -- the same shape run-authoring.mjs's own
// passing-item path already uses in production, just never previously
// exercised by a test at this level (only the full end-to-end harness in
// test-execution-runtime.mjs reaches it, and only for a passing item).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptRejectionRecovery } from "./run-authoring.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { estate, seedGateItems, walkTo } from "./test-fixtures.mjs";

const BASE_COMMIT = "1".repeat(40);
const PREPARED_COMMIT = "3".repeat(40);

function chunkedStage(stage, text, status = "passed") {
  const chunks = [];
  for (let index = 0; index < text.length; index += 2000) chunks.push(text.slice(index, index + 2000));
  return { stage, findings: chunks, outputDigest: sha256Digest(text).slice("sha256:".length), status, latencyMs: 500, deploymentAlias: "a", modelVersion: "v1", providerFamily: "openai", contractVersion: "1.0.0", inputEvidenceDigest: "0".repeat(64) };
}

function blockedProposal({ draftText, verifierText, verifierStatus, adversaryText, adversaryStatus }) {
  return {
    modelStages: [
      chunkedStage("evidence-research", "sources"),
      chunkedStage("curriculum-writing", draftText),
      chunkedStage("factual-verification", verifierText, verifierStatus),
      chunkedStage("assessment-review", adversaryText, adversaryStatus),
      chunkedStage("accessibility-review", "human-review pending", "human-review"),
      chunkedStage("release-proposal", "COMPLETENESS.\n\nRECOMMENDATION: REVISE"),
    ],
  };
}

// Fetch mock for prepareRealCommit's real GitHub Git Data API sequence:
// GET ref -> GET base commit -> POST blob -> POST tree -> POST commit.
function commitFetchMock() {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push(url);
      const respond = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
      if (url.endsWith("/git/ref/heads/main")) return respond(200, { object: { sha: BASE_COMMIT } });
      // Publishing a module now also registers it in the learning catalog, in
      // the same tree, so preparing a commit reads the catalog off the base
      // commit first. See lib/registration.mjs.
      if (url.includes("/contents/content/catalog.json")) {
        const catalog = JSON.stringify({ paths: [{ id: "discovery", moduleIds: [] }], modules: [] }, null, 2);
        return respond(200, { content: Buffer.from(catalog, "utf8").toString("base64"), encoding: "base64" });
      }
      if (url.includes(`/git/commits/${BASE_COMMIT}`)) return respond(200, { tree: { sha: "2".repeat(40) } });
      if (url.endsWith("/git/blobs")) return respond(201, { sha: "b".repeat(40) });
      if (url.endsWith("/git/trees")) return respond(201, { sha: "t".repeat(40) });
      if (url.endsWith("/git/commits") && options?.method === "POST") return respond(201, { sha: PREPARED_COMMIT });
      throw new Error(`unexpected fetch: ${url}`);
    },
  };
}

async function blockedFixture({ term, verifierStatus, adversaryStatus, priorBlocks }) {
  const { store, runId } = await estate();
  const [id] = await seedGateItems(store, runId, [term]);
  await walkTo(store, runId, id, "executing");
  const directory = mkdtempSync(join(tmpdir(), "orchard-rejection-"));
  const proposalRoot = join(directory, "proposals");
  mkdirSync(proposalRoot, { recursive: true });

  let currentRevision = 1;
  for (let round = 1; round <= priorBlocks; round += 1) {
    const proposal = blockedProposal({
      draftText: `draft attempt ${round}`, verifierText: `verifier finding ${round}`, verifierStatus,
      adversaryText: `adversary finding ${round}`, adversaryStatus,
    });
    const file = `proposal-${id}-round${round}.json`;
    writeFileSync(join(proposalRoot, file), JSON.stringify(proposal));
    await store.recordTransition({
      schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: currentRevision,
      from_state: "executing", to_state: "blocked", cause: "policy-block",
      reason: `blocked by the authoring ensemble, ${file}`, actor: "orchard/run-authoring",
      occurred_at: `2026-08-15T00:0${round}:00.000Z`, correlation_id: generateUuidV7(),
    });
    if (round < priorBlocks) {
      // Between blocks the item goes back to executing, same shape a real
      // retry (auto or admin) produces -- irrelevant to these tests' own
      // assertions but needed so the NEXT blocked transition is legal. The
      // successor revision must be persisted before the transition that
      // recovers into it, same rule apply-blocked-retry.mjs itself follows.
      const successorRevision = currentRevision + 1;
      const priorItemRow = store.db.prepare("SELECT semantic_identity FROM workflow_item WHERE item_id = ?").get(id);
      const priorRevisionRecord = JSON.parse(store.db.prepare("SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?").get(id, currentRevision).record_json);
      await store.recordItem({
        schema_version: "1.0.0", item_id: id, run_id: runId, track: "track-1", item_revision: successorRevision,
        semantic_identity: priorItemRow.semantic_identity, canonical_content_id: null, surface: "learning", outcome: "new-module",
        state: "executing", proposal_digest: sha256Digest(`proposal:${id}`), artifact_digest: null,
        target: { repository: "project42dev/project42-platform", path: `content/modules/discovery/${term}.json` },
        evidence: priorRevisionRecord.evidence, supersedes_item_id: null, created_at: `2026-08-15T00:0${round}:30.000Z`, updated_at: `2026-08-15T00:0${round}:30.000Z`,
      });
      await store.recordTransition({
        schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: currentRevision,
        from_state: "blocked", to_state: "executing", cause: "revision-created", recovery_gate: "gate-2",
        successor_revision: successorRevision, actor: "test-fixture", occurred_at: `2026-08-15T00:0${round}:30.000Z`, correlation_id: generateUuidV7(),
      });
      currentRevision = successorRevision;
    }
  }
  const finalFile = `proposal-${id}-round${priorBlocks}.json`;
  return { store, runId, id, proposalRoot, finalFile };
}

test("a first block gets one automatic retry, and its real rejection evidence is recorded, not the generic one-liner", async () => {
  const { store, id, proposalRoot, finalFile } = await blockedFixture({ term: "first-block", verifierStatus: "failed", adversaryStatus: "refuted", priorBlocks: 1 });
  const { impl } = commitFetchMock();
  const result = await attemptRejectionRecovery({
    store, applied: [{ subjectId: id, from: "executing", to: "blocked", file: finalFile }],
    runRecordDir: proposalRoot, proposalRoot, now: "2026-08-15T00:05:00.000Z", log: () => { }, fetchImpl: impl,
  });
  assert.ok(result.retried === 1 && result.escalated === 0, "the first block is retried automatically, not escalated");
  const row = store.db.prepare("SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?").get(id);
  assert.ok(row.current_state === "executing", "the item is back in executing for a fresh authoring attempt");

  const observation = store.db.prepare(
    "SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference LIKE 'orchard/rejection-evidence/%' ORDER BY observed_at DESC LIMIT 1",
  ).get(id);
  assert.ok(observation !== undefined, "the real rejection evidence is persisted as a durable observation, not just the one-line note");
  const evidence = JSON.parse(observation.record_json).rejection_evidence;
  assert.ok(evidence.verifierFinding === "verifier finding 1", "the ACTUAL verifier finding text is captured, not just the verdict");
  assert.ok(evidence.adversaryFinding === "adversary finding 1", "the ACTUAL adversary finding text is captured, not just the verdict");
  assert.ok(evidence.draft === "draft attempt 1", "the rejected draft itself is captured on the FIRST block too, not only an escalated one");
  store.close();
});

test("a second block escalates straight to Gate 2 with the real reason and the rejected draft, no third retry", async () => {
  const { store, id, runId, proposalRoot, finalFile } = await blockedFixture({ term: "second-block", verifierStatus: "failed", adversaryStatus: "refuted", priorBlocks: 2 });
  // Escalation needs the normal prerequisites a passing item already has:
  // a Gate 1 approval decision_event and an ADO link on this revision.
  const revision = store.db.prepare("SELECT current_revision FROM workflow_item WHERE item_id = ?").get(id).current_revision;
  const proposalDigest = store.db.prepare("SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?").get(id, revision).proposal_digest;
  store.db.prepare(
    `INSERT INTO decision_event
      (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
       actor_immutable_id, source_repository, source_issue_number, source_comment_id,
       correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
      VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-08-14T00:00:00.000Z', '{}')`,
  ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve:${id}`);
  store.recordExternalLink({
    link_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: Number(revision), provider: "ado",
    operation: "ado-link", external_key: `orchard:track-1:${id}:r${revision}`, external_id: 5555, linked_at: "2026-08-14T00:01:00.000Z",
  });

  const { impl, calls } = commitFetchMock();
  const result = await attemptRejectionRecovery({
    store, applied: [{ subjectId: id, from: "executing", to: "blocked", file: finalFile }],
    runRecordDir: proposalRoot, proposalRoot, now: "2026-08-15T00:10:00.000Z", log: () => { },
    env: {}, fetchImpl: impl, readGateTokenImpl: async () => "test-token-literal",
  });
  assert.ok(result.escalated === 1 && result.retried === 0, "the second block escalates, it does not retry a third time");
  assert.ok(calls.some((u) => u.endsWith("/git/commits") === false && u.includes("/git/commits/")), "a real commit lookup happened, this is not faked");

  const row = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
  assert.ok(row.current_state === "gate2-pending", "the escalated item reaches gate2-pending through the SAME gate2-ready -> gate2-pending path any passing item uses");

  const manifestObservation = store.db.prepare(
    "SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference LIKE 'orchard/gate-manifest/gate-2:%' ORDER BY observed_at DESC LIMIT 1",
  ).get(id);
  const manifestItem = JSON.parse(manifestObservation.record_json).manifest_item;
  assert.ok(manifestItem.escalated === true, "the manifest item is marked escalated so the render picks the distinct badge and title");
  assert.ok(manifestItem.rejected_draft === "draft attempt 2", "the manifest carries the actual rejected draft, ready to render in full");
  assert.ok(manifestItem.rejection_reason.includes("verifier finding 2") && manifestItem.rejection_reason.includes("adversary finding 2"),
    "the manifest carries the real reason text, not a generic note");
  assert.ok(manifestItem.factual_review.status === "failed", "factual_review is genuinely failed -- the ensemble's own real verdict, not fabricated for this path");

  const transition = store.db.prepare(
    "SELECT from_state, cause FROM state_transition_event WHERE item_id = ? AND to_state = 'gate2-ready' ORDER BY occurred_at DESC LIMIT 1",
  ).get(id);
  assert.ok(transition.from_state === "blocked" && transition.cause === "escalated-for-human-review", "the recorded transition names its real origin and cause, not a borrowed one");
  store.close();
});

test("a second block with no publication credential holds rather than escalating on a partial write", async () => {
  const { store, id, runId, proposalRoot, finalFile } = await blockedFixture({ term: "no-token", verifierStatus: "failed", adversaryStatus: "refuted", priorBlocks: 2 });
  const revision = store.db.prepare("SELECT current_revision FROM workflow_item WHERE item_id = ?").get(id).current_revision;
  const proposalDigest = store.db.prepare("SELECT proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?").get(id, revision).proposal_digest;
  store.db.prepare(
    `INSERT INTO decision_event
      (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
       actor_immutable_id, source_repository, source_issue_number, source_comment_id,
       correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
      VALUES (?, 'gate-1', ?, ?, 1, ?, 'approve', 'github', 'test-user', 'o/r', 1, 1, ?, NULL, ?, '2026-08-14T00:00:00.000Z', '{}')`,
  ).run(generateUuidV7(), runId, id, proposalDigest, generateUuidV7(), `gate1-approve-notoken:${id}`);
  store.recordExternalLink({
    link_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: Number(revision), provider: "ado",
    operation: "ado-link", external_key: `orchard:track-1:${id}:r${revision}`, external_id: 5556, linked_at: "2026-08-14T00:01:00.000Z",
  });

  const result = await attemptRejectionRecovery({
    store, applied: [{ subjectId: id, from: "executing", to: "blocked", file: finalFile }],
    runRecordDir: proposalRoot, proposalRoot, now: "2026-08-15T00:10:00.000Z", log: () => { },
    env: {}, fetchImpl: async () => { throw new Error("must not call GitHub with no token"); },
  });
  assert.ok(result.held === 1 && result.escalated === 0, "escalation refuses cleanly rather than half-writing when no publication credential is configured");
  const row = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
  assert.ok(row.current_state === "blocked", "the item stays blocked, exactly where a real retry can still find it later");
  store.close();
});
