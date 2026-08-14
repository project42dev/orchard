#!/usr/bin/env node
// test-gate1-review.mjs - the Gate 1 contract.
//
// The property that matters most is negative: an item the owner has NOT
// approved must be unreachable by the authoring path. generate-briefs.mjs
// selects `WHERE state = 'queued'`, so these tests assert on that exact state
// rather than on the gate script's own return value. A gate that reported
// success while leaving an item authorable would be worse than no gate.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  pendingItems, batchDigest, renderIssue, parseDecisions, applyDecisions,
} from "./gate1-review.mjs";
import { migrate, needsMigration } from "./migrate-gate1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let assertions = 0;
let failures = 0;

function ok(cond, msg) {
  assertions += 1;
  if (!cond) { failures += 1; console.error(`FAIL: ${msg}`); }
}

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "..", "schema", "content-db.sql"), "utf8"));
  const now = "2026-08-14T00:00:00.000Z";
  const ins = db.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, first_seen, updated_at)
     VALUES (?, 'needs-creating', ?, 'learn', ?, 'gate1-pending', ?, ?)`,
  );
  for (const n of ["a", "b", "c"]) ins.run(`create:${n}`, n, `Item ${n}`, now, now);
  return db;
}

const authorable = (db) =>
  db.prepare("SELECT count(*) c FROM work_item WHERE state = 'queued'").get().c;

// --- the schema itself must default to the gate, not to authorable ---
{
  const db = fresh();
  ok(authorable(db) === 0, "new work must not be authorable before approval");
  ok(pendingItems(db).length === 3, "three items pending");
  const col = db.prepare("SELECT sql FROM sqlite_master WHERE name='work_item'").get().sql;
  ok(col.includes("DEFAULT 'gate1-pending'"), "schema default must be gate1-pending");
  db.close();
}

// --- deny requires a reason, and a denial is recorded ---
{
  const db = fresh();
  let r = applyDecisions(db, parseDecisions("/orchard gate1 deny item=create:a"), {});
  ok(r.errors.length === 1 && r.denied === 0, "deny without a reason is refused");
  r = applyDecisions(db, parseDecisions('/orchard gate1 deny item=create:a reason="not a gap"'), {});
  ok(r.denied === 1, "deny with a reason is applied");
  const note = db.prepare("SELECT note FROM work_item WHERE id='create:a'").get().note;
  ok(note.includes("not a gap"), "the denial reason is retained");
  ok(authorable(db) === 0, "a denied item is never authorable");
  db.close();
}

// --- approval is the ONLY route into authoring ---
{
  const db = fresh();
  applyDecisions(db, parseDecisions("/orchard gate1 approve item=create:b"), {});
  ok(authorable(db) === 1, "only the approved item becomes authorable");
  const which = db.prepare("SELECT id FROM work_item WHERE state='queued'").get().id;
  ok(which === "create:b", "the authorable item is the one that was approved");
  db.close();
}

// --- batch approval is refused unless explicitly allowed AND digest-bound ---
{
  const db = fresh();
  const digest = batchDigest(pendingItems(db));
  let r = applyDecisions(db, parseDecisions(`/orchard gate1 approve all digest=${digest}`), {});
  ok(r.approved === 0 && authorable(db) === 0, "batch is refused without --allow-batch");

  r = applyDecisions(db, parseDecisions(`/orchard gate1 approve all digest=sha256:${"0".repeat(64)}`), { allowBatch: true });
  ok(r.approved === 0 && authorable(db) === 0, "batch is refused on a digest mismatch");

  r = applyDecisions(db, parseDecisions(`/orchard gate1 approve all digest=${digest}`), { allowBatch: true });
  ok(r.approved === 3 && authorable(db) === 3, "batch applies with the correct digest and flag");
  db.close();
}

// --- a digest stops applying once the pending set changes ---
{
  const db = fresh();
  const stale = batchDigest(pendingItems(db));
  db.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, first_seen, updated_at)
     VALUES ('create:d','needs-creating','d','learn','Item d','gate1-pending','x','x')`,
  ).run();
  const r = applyDecisions(db, parseDecisions(`/orchard gate1 approve all digest=${stale}`), { allowBatch: true });
  ok(r.approved === 0 && authorable(db) === 0, "a stale batch digest cannot approve a changed set");
  db.close();
}

// --- unknown and malformed commands never silently approve ---
{
  const db = fresh();
  const r = applyDecisions(db, parseDecisions("Approved\nlooks good to me\n/orchard gate1 bless item=create:a"), {});
  ok(r.approved === 0 && authorable(db) === 0, "prose and unknown verbs approve nothing");
  ok(parseDecisions("Approved").items.length === 0, "a bare Approved is not a decision");
  db.close();
}

// --- decisions only apply to pending items ---
{
  const db = fresh();
  applyDecisions(db, parseDecisions("/orchard gate1 approve item=create:a"), {});
  const r = applyDecisions(db, parseDecisions('/orchard gate1 deny item=create:a reason="changed my mind"'), {});
  ok(r.denied === 0 && r.skipped.length === 1, "an already-approved item is not re-decided");
  db.close();
}

// --- the rendered issue carries the digest and every pending item ---
{
  const db = fresh();
  const items = pendingItems(db);
  const body = renderIssue(items, batchDigest(items));
  ok(body.includes(batchDigest(items)), "the issue body carries the batch digest");
  for (const i of items) ok(body.includes(i.id), `the issue lists ${i.id}`);
  ok(renderIssue([], batchDigest([])).includes("Nothing is waiting"), "an empty gate renders cleanly");
  db.close();
}

// --- migration preserves every row and is idempotent ---
{
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_item (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('needs-creating','needs-updating')),
    subject_id TEXT NOT NULL, surface TEXT NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued','claimed','in-progress','blocked','done','rejected')),
    priority REAL, claimed_by TEXT, claimed_at TEXT, note TEXT,
    first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, ado_id TEXT,
    UNIQUE (kind, subject_id))`);
  db.prepare(
    `INSERT INTO work_item (id,kind,subject_id,surface,title,state,first_seen,updated_at,ado_id)
     VALUES ('create:z','needs-creating','z','learn','Z','queued','x','x','7777')`,
  ).run();
  ok(needsMigration(db) === true, "an old schema needs migration");
  const r = migrate(db);
  ok(r.migrated === true && r.rows === 1, "migration preserves the row");
  const row = db.prepare("SELECT state, ado_id FROM work_item WHERE id='create:z'").get();
  ok(row.state === "queued", "an already-queued item is NOT moved backwards");
  ok(row.ado_id === "7777", "the ADO id survives migration");
  ok(needsMigration(db) === false, "migration is idempotent");
  db.close();
}

// --- only an authorised actor may decide ---
{
  const { selectAuthorised } = await import("./gate1-review.mjs");
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

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on Gate 1: the owner decides before anything is written.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;

