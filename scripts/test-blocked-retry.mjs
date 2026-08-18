#!/usr/bin/env node
// test-blocked-retry.mjs - a blocked item can actually be retried.
//
// The defect: state-machine.mjs had a rule that let a transition ENTER
// 'blocked' (ingest-proposals.mjs, on a policy-block verdict from the
// ensemble's own review) but none that let one LEAVE it. An item the
// ensemble refused was permanent regardless of what an operator wanted.
//
// These tests assert the whole loop closes, the same way test-gate2-rework.mjs
// asserts the changes-requested loop closes: the retry is recorded, a real
// successor revision exists, generate-briefs.mjs's existing crash-recovery
// query picks the retried item back up with no changes of its own, and the
// refusal reason reaches the drafter so the same mistake is not repeated
// blind.
//
// EVERY fixture is built through openStateStore on the real migrated schema
// and walked to its state through the lifecycle's own transitions.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRetry } from "./apply-blocked-retry.mjs";
import { generateBriefs, buildPrompt, parseBlockedRetryNote, blockedNoteFor, BLOCKED_RETRY_PREFIX, ROLE_JOBS } from "./generate-briefs.mjs";
import { generateUuidV7 } from "./lib/identity.mjs";
import { estate, seedGateItems, walkTo, cleanupFixtures } from "./test-fixtures.mjs";

let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };

async function blockedFixture(term = "blocked-subject") {
  const { store, runId, dbPath } = await estate();
  const [id] = await seedGateItems(store, runId, [term]);
  await walkTo(store, runId, id, "executing");
  await store.recordTransition({
    schema_version: "1.0.0",
    transition_id: generateUuidV7(),
    run_id: runId,
    item_id: id,
    item_revision: 1,
    from_state: "executing",
    to_state: "blocked",
    cause: "policy-block",
    reason: "the adversary found an unsupported claim in paragraph 2",
    actor: "orchard/run-authoring",
    occurred_at: "2026-08-15T00:00:00.000Z",
    correlation_id: generateUuidV7(),
  });
  return { store, runId, id, dbPath };
}

const stateOf = (store, id) =>
  store.db.prepare("SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?").get(id);

// --- a blocked item can be retried, and a real successor revision exists ---
{
  const { store, id } = await blockedFixture();
  const r = await applyRetry(store, { item: id });
  ok(r.retried === 1 && r.errors.length === 0, "the retry is recorded");
  ok(r.revision === 2, "the retry reports the new revision number");
  const row = stateOf(store, id);
  ok(row.current_state === "executing", "the item is back in executing");
  ok(Number(row.current_revision) === 2, "the item's current revision advanced");
  const revisionRow = store.db.prepare(
    "SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = 2",
  ).get(id);
  ok(revisionRow !== undefined, "revision 2 is actually persisted, not just referenced");
  const revisionRecord = JSON.parse(revisionRow.record_json);
  ok(revisionRecord.state === "executing", "the persisted revision 2 record says executing");
  ok(revisionRecord.artifact_digest === null, "the retried revision starts with no artifact, honestly");

  const link1 = store.db.prepare(
    "SELECT external_key, external_id FROM external_link WHERE item_id = ? AND item_revision = 1 AND provider = 'ado'",
  ).get(id);
  const link2 = store.db.prepare(
    "SELECT external_key, external_id FROM external_link WHERE item_id = ? AND item_revision = 2 AND provider = 'ado'",
  ).get(id);
  ok(link1 !== undefined, "sanity: the fixture's own walk to executing left an ADO link on revision 1");
  ok(link2 !== undefined,
    "the retry carries the ADO link forward onto the new revision -- without this, gate2-prep's exact-revision lookup holds forever with 'no persisted ADO link'");
  ok(link2 && link2.external_id === link1.external_id,
    "the carried-forward link points at the SAME ADO work item id, not a freshly created one -- a retry is a re-draft of the same requirement, not a new one");
  ok(link2 && link2.external_key !== link1.external_key && link2.external_key.endsWith(":r2"),
    "the external_key is still revision-scoped (orchard:track:item:rN), since (provider, external_key) is unique per row");
  store.close();
}

// --- the ensemble's refusal reason reaches the brief, same as a Gate 2 rework does ---
{
  const { store, id } = await blockedFixture();
  await applyRetry(store, { item: id });
  const note = blockedNoteFor(store.db, id);
  ok(note === `${BLOCKED_RETRY_PREFIX}the adversary found an unsupported claim in paragraph 2`,
    "the brief generator reads the ensemble's refusal back off the recorded transition");
  ok(parseBlockedRetryNote(note) === "the adversary found an unsupported claim in paragraph 2",
    "the retry marker is parsed back out");
  ok(parseBlockedRetryNote("claimed by engine-123") === null,
    "an unrelated operator note is NOT treated as a refusal reason");

  const item = { kind: "needs-creating", surface: "learning", title: "Item A", note };
  const prompt = buildPrompt(item, null, null, {});
  ok(prompt.includes("THIS IS A RETRY"), "the brief announces it is a retry");
  ok(prompt.includes("unsupported claim in paragraph 2"), "the brief carries the refusal reason verbatim");
  ok(prompt.indexOf("THIS IS A RETRY") < prompt.indexOf("Constraints:"),
    "the retry reason appears before the standing constraints, not buried at the end");
  store.close();
}

// --- generate-briefs.mjs's EXISTING crash-recovery query picks the retry up, unmodified ---
{
  const { store, id, dbPath } = await blockedFixture("retry-reaches-briefs");
  const r = await applyRetry(store, { item: id });
  ok(r.retried === 1, "the retry is recorded before generating briefs");
  store.close();

  const root = mkdtempSync(join(tmpdir(), "orchard-blocked-retry-"));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    "model-a": { name: "A", format: "VendorOne" },
    "model-b": { name: "B", format: "VendorTwo" },
    "model-c": { name: "C", format: "VendorThree" },
    "model-d": { name: "D", format: "VendorFour" },
  }));
  const mapPath = join(root, "map.json");
  writeFileSync(mapPath, JSON.stringify({
    jobs: Object.fromEntries(Object.entries({
      [ROLE_JOBS.researcher]: "model-a", [ROLE_JOBS.drafter]: "model-a",
      [ROLE_JOBS.verifier]: "model-b", [ROLE_JOBS.adversary]: "model-c",
      [ROLE_JOBS.arbiter]: "model-d", [ROLE_JOBS.finalizer]: "model-d",
    }).map(([job, model]) => [job, { model }])),
  }));
  const targetsPath = join(root, "targets.json");
  writeFileSync(targetsPath, JSON.stringify({
    repository: "example/content",
    surfaces: { learn: { pathTemplates: ["content/modules/{topic}/"], suffix: "-learn" } },
  }));

  const result = await generateBriefs({ dbPath, mapPath, targetsPath, inventoryPath, limit: 10 });
  ok(result.briefs.some((b) => b.subjectId === id),
    "a retried item is picked up by the SAME query that already recovers a crashed executing item -- no eligibility change needed");
  const brief = result.briefs.find((b) => b.subjectId === id);
  ok(brief.prompt.includes("THIS IS A RETRY") && brief.prompt.includes("unsupported claim in paragraph 2"),
    "the brief actually generated for the retried item carries the refusal reason");
}

// --- a retry is refused unless the item is actually blocked ---
{
  const { store, id } = await blockedFixture("not-blocked");
  await applyRetry(store, { item: id });
  const stillBlocked = store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id);
  ok(stillBlocked.current_state === "executing", "sanity: the item is now executing after the first retry");
  const r = await applyRetry(store, { item: id });
  ok(r.retried === 0 && r.errors[0].includes("cannot be retried"),
    "an item that is not blocked cannot be retried again");
  store.close();
}

// --- an unknown item is refused ---
{
  const { store } = await estate();
  const r = await applyRetry(store, { item: "no-such-item" });
  ok(r.retried === 0 && r.errors[0].includes("no workflow item matches"), "an unknown item is refused");
  store.close();
}

// --- a gate2-ready item with no evidence has the identical dead end blocked
// had, and the identical recovery. Found live 2026-08-17: Track 1 had 11 such
// items, none of which could ever reach a Gate 2 announcement. ---
{
  const { store, runId } = await estate();
  const [id] = await seedGateItems(store, runId, ["gate2-ready-subject"]);
  await walkTo(store, runId, id, "gate2-ready");
  const before = stateOf(store, id);
  ok(before.current_state === "gate2-ready", "sanity: the fixture actually reaches gate2-ready");

  const r = await applyRetry(store, { item: id });
  ok(r.retried === 1 && r.errors.length === 0, "a gate2-ready item can be retried, the same as a blocked one");
  ok(r.revision === 2, "the retry reports the new revision number");
  const row = stateOf(store, id);
  ok(row.current_state === "executing", "the item is back in executing, ready for authoring to produce real evidence this time");
  ok(Number(row.current_revision) === 2, "the item's current revision advanced");

  const link1 = store.db.prepare(
    "SELECT external_id FROM external_link WHERE item_id = ? AND item_revision = 1 AND provider = 'ado'",
  ).get(id);
  const link2 = store.db.prepare(
    "SELECT external_id FROM external_link WHERE item_id = ? AND item_revision = 2 AND provider = 'ado'",
  ).get(id);
  ok(link1 !== undefined && link2 !== undefined && link1.external_id === link2.external_id,
    "the ADO link carries forward here too -- gate2-ready items already passed ado-sync on the way to executing");

  const transition = store.db.prepare(
    "SELECT from_state FROM state_transition_event WHERE item_id = ? AND to_state = 'executing' ORDER BY occurred_at DESC LIMIT 1",
  ).get(id);
  ok(transition.from_state === "gate2-ready", "the recorded transition names its real origin state, not a hardcoded 'blocked'");
  store.close();
}

// --- a denied item (a real human/operator gate-2 decision, not a stalled
// attempt) can also be retried, once a real deny decision_event is on
// record -- state-machine.mjs's denied -> executing rule requires
// predecessor_decision_event_id, proof an actual decision authorized the
// retry. Found live 2026-08-17: run-authoring.mjs was committing the
// finalizer's review narrative instead of the drafter's content; every item
// that had already reached gate2-pending under that defect needed a real
// deny recorded before it could be retried through the fix. ---
// --- a denied item with NO recorded deny decision_event is refused, not silently retried ---
{
  const { store, runId } = await estate();
  const [id] = await seedGateItems(store, runId, ["denied-no-decision-subject"]);
  await walkTo(store, runId, id, "gate2-pending");
  await store.recordTransition({
    schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 1,
    from_state: "gate2-pending", to_state: "denied", cause: "decision-denied",
    reason: "content is the finalizer review stage output, not the lesson",
    actor: "orchard/apply-gate-decisions", occurred_at: "2026-08-15T00:01:00.000Z", correlation_id: generateUuidV7(),
  });
  const r = await applyRetry(store, { item: id });
  ok(r.retried === 0, "a denied item with no recorded deny decision_event must be refused, not retried on an operator's say-so alone");
  ok(r.errors[0].includes("no recorded gate-2 deny decision_event"), "the refusal names exactly why");
  store.close();
}

// --- a denied item WITH a real deny decision_event retries cleanly, carrying the decision forward ---
{
  const { store, runId } = await estate();
  const [id] = await seedGateItems(store, runId, ["denied-with-decision-subject"]);
  await walkTo(store, runId, id, "gate2-pending");
  const eventId = generateUuidV7();
  store.db.prepare(
    `INSERT INTO decision_event
      (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
       actor_immutable_id, source_repository, source_issue_number, source_comment_id,
       correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
      VALUES (?, 'gate-2', ?, ?, 1, 'sha256:test', 'deny', 'github', 'test-user',
              'o/r', 1, 2, ?, NULL, ?, '2026-08-15T00:00:00.000Z', '{}')`,
  ).run(eventId, runId, id, generateUuidV7(), `test-idempotency2:${eventId}`);
  await store.recordTransition({
    schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 1,
    from_state: "gate2-pending", to_state: "denied", cause: "decision-denied",
    reason: "content is the finalizer review stage output, not the lesson",
    actor: "orchard/apply-gate-decisions", occurred_at: "2026-08-15T00:01:00.000Z", correlation_id: generateUuidV7(),
  });

  const r = await applyRetry(store, { item: id });
  ok(r.retried === 1 && r.errors.length === 0, "a denied item WITH a recorded deny decision_event can be retried");
  ok(r.revision === 2, "the retry reports the new revision number");
  const row = stateOf(store, id);
  ok(row.current_state === "executing", "the item is back in executing for a fresh authoring attempt");

  const transitionRow = store.db.prepare(
    "SELECT from_state, record_json FROM state_transition_event WHERE item_id = ? AND to_state = 'executing' ORDER BY occurred_at DESC LIMIT 1",
  ).get(id);
  const transition = JSON.parse(transitionRow.record_json);
  ok(transitionRow.from_state === "denied", "the recorded transition names its real origin state");
  ok(transition.predecessor_decision_event_id === eventId, "the retry carries the exact deny decision_event id that authorized it, not a placeholder");
  store.close();
}

// --- a retried gate2-ready item is picked up by the same crash-recovery query, unmodified ---
{
  const { store, runId, dbPath } = await estate();
  const [id] = await seedGateItems(store, runId, ["gate2-ready-reaches-briefs"]);
  await walkTo(store, runId, id, "gate2-ready");
  const r = await applyRetry(store, { item: id });
  ok(r.retried === 1, "the gate2-ready retry is recorded before generating briefs");
  store.close();

  const root = mkdtempSync(join(tmpdir(), "orchard-gate2ready-retry-"));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    "model-a": { name: "A", format: "VendorOne" },
    "model-b": { name: "B", format: "VendorTwo" },
    "model-c": { name: "C", format: "VendorThree" },
    "model-d": { name: "D", format: "VendorFour" },
  }));
  const mapPath = join(root, "map.json");
  writeFileSync(mapPath, JSON.stringify({
    jobs: Object.fromEntries(Object.entries({
      [ROLE_JOBS.researcher]: "model-a", [ROLE_JOBS.drafter]: "model-a",
      [ROLE_JOBS.verifier]: "model-b", [ROLE_JOBS.adversary]: "model-c",
      [ROLE_JOBS.arbiter]: "model-d", [ROLE_JOBS.finalizer]: "model-d",
    }).map(([job, model]) => [job, { model }])),
  }));
  const targetsPath = join(root, "targets.json");
  writeFileSync(targetsPath, JSON.stringify({
    repository: "example/content",
    surfaces: { learn: { pathTemplates: ["content/modules/{topic}/"], suffix: "-learn" } },
  }));

  const result = await generateBriefs({ dbPath, mapPath, targetsPath, inventoryPath, limit: 10 });
  ok(result.briefs.some((b) => b.subjectId === id),
    "a retried gate2-ready item is picked up by the same query that recovers a crashed executing item -- this is what actually closes Track 1's real 11-item Gate 2 gap");
}

cleanupFixtures();

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on the blocked-retry loop: a blocked item can be retried and the refusal reaches the drafter.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
