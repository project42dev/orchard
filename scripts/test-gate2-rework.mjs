#!/usr/bin/env node
// test-gate2-rework.mjs - the denial loop actually closes.
//
// The defect: request-changes recorded a generic rejection, closed the issue,
// and passed nothing back. The reviewer's reason went nowhere. These tests
// assert the reason reaches the BRIEF, because that is the only place it can
// change what gets written. A rework that re-queues an item without telling the
// drafter what was wrong asks for the same piece again.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyRework, applyDenial, REWORK_PREFIX } from "./apply-gate2-rework.mjs";
import { buildPrompt, parseReworkNote } from "./generate-briefs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };

function fresh(state = "claimed") {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "..", "schema", "content-db.sql"), "utf8"));
  db.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, first_seen, updated_at)
     VALUES ('create:a','needs-creating','a','learn','Item A',?, 'x','x')`,
  ).run(state);
  return db;
}
const stateOf = (db) => db.prepare("SELECT state FROM work_item WHERE id='create:a'").get().state;
const noteOf = (db) => db.prepare("SELECT note FROM work_item WHERE id='create:a'").get().note;

// --- request-changes returns the item to authorable WITH the reason ---
{
  const db = fresh("claimed");
  const r = applyRework(db, { item: "create:a", reason: "the cost figures are wrong" });
  ok(r.requeued === 1 && r.errors.length === 0, "request-changes re-queues the item");
  ok(stateOf(db) === "queued", "a returned item is authorable again");
  ok(noteOf(db) === `${REWORK_PREFIX}the cost figures are wrong`, "the reason is stored in the form briefs read");
  ok(db.prepare("SELECT claimed_by FROM work_item WHERE id='create:a'").get().claimed_by === null,
     "the stale claim is cleared so the item can be picked up again");
  db.close();
}

// --- a rework with no reason is refused. This is the whole defect. ---
{
  const db = fresh("claimed");
  for (const bad of [undefined, "", "   "]) {
    const r = applyRework(db, { item: "create:a", reason: bad });
    ok(r.requeued === 0 && r.errors.length === 1, `a rework with reason=${JSON.stringify(bad)} is refused`);
  }
  ok(stateOf(db) === "claimed", "a refused rework changes nothing");
  db.close();
}

// --- the reason reaches the BRIEF, which is the only thing that matters ---
{
  ok(parseReworkNote(`${REWORK_PREFIX}fix the pricing table`) === "fix the pricing table",
     "the rework marker is parsed back out");
  ok(parseReworkNote("claimed by engine-123") === null,
     "an unrelated operator note is NOT treated as a reviewer reason");
  ok(parseReworkNote(null) === null, "a null note is safe");

  const item = { kind: "needs-creating", surface: "learn", title: "Item A", note: `${REWORK_PREFIX}the cost figures are wrong` };
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
  const db = fresh("claimed");
  const r = applyDenial(db, { item: "create:a", reason: "not a real gap" });
  ok(r.denied === 1 && stateOf(db) === "gate2-denied", "deny moves the item to gate2-denied");
  ok(noteOf(db).includes("not a real gap"), "the denial reason is retained");
  ok(applyDenial(db, { item: "create:a" }).errors.length === 1, "deny without a reason is refused");
  db.close();
}

// --- published work is never resurrected by a stray comment ---
{
  const db = fresh("done");
  const r = applyRework(db, { item: "create:a", reason: "actually change it" });
  ok(r.requeued === 0 && r.errors[0].includes("already done"), "a done item cannot be re-queued by rework");
  ok(stateOf(db) === "done", "the done item is untouched");
  db.close();
}

// --- an unknown item is refused ---
{
  const db = fresh();
  ok(applyRework(db, { item: "create:nope", reason: "x" }).errors[0].includes("no work item matches"),
     "an unknown item is refused");
  db.close();
}

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on the rework loop: a denial reason reaches the drafter.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
