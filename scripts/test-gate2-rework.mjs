#!/usr/bin/env node
// test-gate2-rework.mjs - the denial loop actually closes.
//
// The defect: request-changes recorded a generic rejection, closed the issue,
// and passed nothing back. The reviewer's reason went nowhere. These tests
// assert the reason reaches the BRIEF, because that is the only place it can
// change what gets written. A rework that returns an item without telling the
// drafter what was wrong asks for the same piece again.
//
// EVERY fixture is built through openStateStore on the real migrated schema
// and walked to its state through the lifecycle's own transitions. The
// previous version hand-applied schema/content-db.sql, a schema production
// does not have, which is exactly how the script it tests shipped unable to
// run.

import { applyRework, applyDenial, REWORK_PREFIX } from "./apply-gate2-rework.mjs";
import { buildPrompt, parseReworkNote, reworkNoteFor } from "./generate-briefs.mjs";
import { estate, seedGateItems, walkTo, cleanupFixtures } from "./test-fixtures.mjs";

let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };

async function fresh(state = "gate2-pending") {
  const { store, runId } = await estate();
  const [id] = await seedGateItems(store, runId, ["rework-subject"]);
  await walkTo(store, runId, id, state);
  return { store, runId, id };
}

const stateOf = (store, id) =>
  store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id).current_state;
const reasonOf = (store, id, toState) =>
  store.listTransitions(id).findLast((t) => t.to_state === toState)?.reason ?? null;

// --- request-changes records the reason where the next brief reads it ---
{
  const { store, id } = await fresh("gate2-pending");
  const r = await applyRework(store, { item: id, reason: "the cost figures are wrong" });
  ok(r.requeued === 1 && r.errors.length === 0, "request-changes is recorded");
  ok(stateOf(store, id) === "changes-requested", "the item is in the lifecycle's changes-requested state");
  ok(reasonOf(store, id, "changes-requested") === `${REWORK_PREFIX}the cost figures are wrong`,
    "the reason is stored in the form briefs read");
  ok(reworkNoteFor(store.db, id) === `${REWORK_PREFIX}the cost figures are wrong`,
    "the brief generator reads the reason back off the recorded transition");
  store.close();
}

// --- a rework with no reason is refused. This is the whole defect. ---
{
  const { store, id } = await fresh("gate2-pending");
  for (const bad of [undefined, "", "   "]) {
    const r = await applyRework(store, { item: id, reason: bad });
    ok(r.requeued === 0 && r.errors.length === 1, `a rework with reason=${JSON.stringify(bad)} is refused`);
  }
  ok(stateOf(store, id) === "gate2-pending", "a refused rework changes nothing");
  store.close();
}

// --- the reason reaches the BRIEF, which is the only thing that matters ---
{
  ok(parseReworkNote(`${REWORK_PREFIX}fix the pricing table`) === "fix the pricing table",
    "the rework marker is parsed back out");
  ok(parseReworkNote("claimed by engine-123") === null,
    "an unrelated operator note is NOT treated as a reviewer reason");
  ok(parseReworkNote(null) === null, "a null note is safe");

  const item = { kind: "needs-creating", surface: "learning", title: "Item A", note: `${REWORK_PREFIX}the cost figures are wrong` };
  const prompt = buildPrompt(item, null, null, {});
  ok(prompt.includes("THIS IS A REWORK"), "the brief announces it is a rework");
  ok(prompt.includes("the cost figures are wrong"), "the brief carries the reviewer's reason verbatim");
  ok(prompt.indexOf("THIS IS A REWORK") < prompt.indexOf("Constraints:"),
    "the rework reason appears before the standing constraints, not buried at the end");

  const plain = buildPrompt({ ...item, note: null }, null, null, {});
  ok(!plain.includes("THIS IS A REWORK"), "a first-time brief carries no rework text");
}

// --- deny is terminal, and is NOT rework ---
{
  const { store, id } = await fresh("gate2-pending");
  const r = await applyDenial(store, { item: id, reason: "not a real gap" });
  ok(r.denied === 1 && stateOf(store, id) === "denied", "deny moves the item to denied");
  ok(reasonOf(store, id, "denied").includes("not a real gap"), "the denial reason is retained");
  ok((await applyDenial(store, { item: id })).errors.length === 1, "deny without a reason is refused");
  store.close();
}

// --- work that never reached review cannot be moved by a stray comment ---
{
  const { store, id } = await fresh("executing");
  const r = await applyRework(store, { item: id, reason: "premature" });
  ok(r.requeued === 0 && r.errors[0].includes("executing"), "an item not under review cannot be reworked");
  ok(stateOf(store, id) === "executing", "the item is untouched");
  store.close();
}

// --- published work is never resurrected by a stray comment ---
{
  const { store, id } = await fresh("published");
  const r = await applyRework(store, { item: id, reason: "actually change it" });
  ok(r.requeued === 0 && r.errors[0].includes("already published"), "a published item cannot be reworked");
  ok(stateOf(store, id) === "published", "the published item is untouched");
  store.close();
}

// --- an unknown item is refused ---
{
  const { store } = await fresh();
  ok((await applyRework(store, { item: "no-such-item", reason: "x" })).errors[0].includes("no workflow item matches"),
    "an unknown item is refused");
  store.close();
}

cleanupFixtures();

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on the rework loop: a denial reason reaches the drafter.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
