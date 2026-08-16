#!/usr/bin/env node
// test-gate1-review.mjs - the Gate 1 contract.
//
// The property that matters most is negative: an item the owner has NOT
// approved must be unreachable by the authoring path. generate-briefs.mjs
// authors only items at 'ado-linked', and nothing reaches 'ado-linked' except
// through 'gate1-approved', so these tests assert on the recorded lifecycle
// states rather than on the gate script's own return value. A gate that
// reported success while leaving an item authorable would be worse than no
// gate.
//
// EVERY fixture is built through openStateStore on the real migrated schema.
// The previous version of this file hand-applied schema/content-db.sql, a
// schema production does not have, which is exactly how the script it tests
// shipped unable to run.

import {
  pendingItems, batchDigest, renderIssue, parseDecisions, applyDecisions, selectAuthorised,
} from "./gate1-review.mjs";
import { estate, seedGateItems, cleanupFixtures } from "./test-fixtures.mjs";

let assertions = 0;
let failures = 0;

function ok(cond, msg) {
  assertions += 1;
  if (!cond) { failures += 1; console.error(`FAIL: ${msg}`); }
}

async function fresh(terms = ["alpha", "beta", "gamma"]) {
  const { store, runId } = await estate();
  const ids = await seedGateItems(store, runId, terms);
  return { store, runId, ids };
}

const stateOf = (store, id) =>
  store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(id).current_state;

// Authorable means reachable by generate-briefs.mjs: 'ado-linked', or already
// picked up at 'executing'. Approval alone must never put an item there; only
// ado-sync.mjs advances an approved item to ado-linked.
const authorable = (store) =>
  store.db.prepare("SELECT count(*) c FROM workflow_item WHERE current_state IN ('ado-linked','executing')").get().c;

// --- new work holds at the gate, and is described well enough to decide on ---
{
  const { store } = await fresh();
  ok(authorable(store) === 0, "new work must not be authorable before approval");
  const items = pendingItems(store.db);
  ok(items.length === 3, "three items pending");
  ok(items.every((i) => i.title.startsWith("How to teach")), "the recorded manifest title reaches the reviewer");
  ok(items.every((i) => typeof i.score === "number"), "the recorded score reaches the reviewer");
  ok(items.every((i) => /^sha256:/.test(i.proposal_digest)), "each pending item carries the digest an approval binds to");
  store.close();
}

// --- deny requires a reason, and a denial is recorded on the lifecycle ---
{
  const { store, ids } = await fresh();
  let r = await applyDecisions(store, parseDecisions(`/orchard gate1 deny item=${ids[0]}`), {});
  ok(r.errors.length === 1 && r.denied === 0, "deny without a reason is refused");
  r = await applyDecisions(store, parseDecisions(`/orchard gate1 deny item=${ids[0]} reason="not a gap"`), {});
  ok(r.denied === 1, "deny with a reason is applied");
  ok(stateOf(store, ids[0]) === "denied", "a denied item is in the lifecycle's denied state");
  const transitions = store.listTransitions(ids[0]);
  const denial = transitions.find((t) => t.to_state === "denied");
  ok(denial && denial.reason.includes("not a gap"), "the denial reason is retained on the recorded transition");
  ok(authorable(store) === 0, "a denied item is never authorable");
  store.close();
}

// --- approval moves the item to gate1-approved, and ONLY approval does ---
{
  const { store, ids } = await fresh();
  await applyDecisions(store, parseDecisions(`/orchard gate1 approve item=${ids[1]}`), {});
  ok(stateOf(store, ids[1]) === "gate1-approved", "the approved item is gate1-approved");
  ok(stateOf(store, ids[0]) === "gate1-pending" && stateOf(store, ids[2]) === "gate1-pending",
    "the items the owner did not decide stay pending and cost nothing");
  ok(authorable(store) === 0,
    "approval alone is still not authorable: ado-sync must link the work item first");
  store.close();
}

// --- batch approval is refused unless explicitly allowed AND digest-bound ---
{
  const { store } = await fresh();
  const digest = batchDigest(pendingItems(store.db));
  let r = await applyDecisions(store, parseDecisions(`/orchard gate1 approve all digest=${digest}`), {});
  ok(r.approved === 0, "batch is refused without --allow-batch");

  r = await applyDecisions(store, parseDecisions(`/orchard gate1 approve all digest=sha256:${"0".repeat(64)}`), { allowBatch: true });
  ok(r.approved === 0, "batch is refused on a digest mismatch");

  r = await applyDecisions(store, parseDecisions(`/orchard gate1 approve all digest=${digest}`), { allowBatch: true });
  ok(r.approved === 3, "batch applies with the correct digest and flag");
  ok(pendingItems(store.db).length === 0, "nothing is left pending after the batch");
  store.close();
}

// --- a digest stops applying once the pending set changes ---
{
  const { store, runId } = await fresh();
  const stale = batchDigest(pendingItems(store.db));
  await seedGateItems(store, runId, ["delta"]);
  const r = await applyDecisions(store, parseDecisions(`/orchard gate1 approve all digest=${stale}`), { allowBatch: true });
  ok(r.approved === 0, "a stale batch digest cannot approve a changed set");
  ok(pendingItems(store.db).length === 4, "every item is still pending");
  store.close();
}

// --- unknown and malformed commands never silently approve ---
{
  const { store, ids } = await fresh();
  const r = await applyDecisions(store, parseDecisions(`Approved\nlooks good to me\n/orchard gate1 bless item=${ids[0]}`), {});
  ok(r.approved === 0, "prose and unknown verbs approve nothing");
  ok(pendingItems(store.db).length === 3, "the pending set is untouched");
  ok(parseDecisions("Approved").items.length === 0, "a bare Approved is not a decision");
  store.close();
}

// --- decisions only apply to pending items ---
{
  const { store, ids } = await fresh();
  await applyDecisions(store, parseDecisions(`/orchard gate1 approve item=${ids[0]}`), {});
  const r = await applyDecisions(store, parseDecisions(`/orchard gate1 deny item=${ids[0]} reason="changed my mind"`), {});
  ok(r.denied === 0 && r.skipped.length === 1, "an already-approved item is not re-decided");
  ok(stateOf(store, ids[0]) === "gate1-approved", "the earlier decision stands");
  store.close();
}

// --- the rendered issue carries the digest and every pending item ---
{
  const { store } = await fresh();
  const items = pendingItems(store.db);
  const body = renderIssue(items, batchDigest(items));
  ok(body.includes(batchDigest(items)), "the issue body carries the batch digest");
  for (const i of items) ok(body.includes(i.id), `the issue lists ${i.id}`);
  ok(renderIssue([], batchDigest([])).includes("Nothing is waiting"), "an empty gate renders cleanly");
  store.close();
}

// --- only an authorised actor may decide ---
{
  const comments = [
    { user: { login: "Owner" }, body: "/orchard gate1 approve item=create:a" },
    { user: { login: "drive-by" }, body: "/orchard gate1 approve item=create:b" },
    { user: { login: "Owner" }, body: "looks fine" },
  ];
  const s = selectAuthorised(comments, ["owner"]);
  ok(s.taken.length === 1, "only the authorised actor's decision is taken");
  ok(s.refused.length === 1 && s.refused[0] === "drive-by", "an unauthorised decision is reported, not silently dropped");
  ok(selectAuthorised(comments, []).taken.length === 2, "an empty allowlist takes every decision comment");
  ok(selectAuthorised([{ user: { login: "owner" }, body: "Approved" }], ["owner"]).taken.length === 0,
    "a bare Approved is still not a Gate 1 decision");
}

cleanupFixtures();

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on Gate 1: the owner decides before anything is written.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
