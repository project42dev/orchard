#!/usr/bin/env node
// apply-gate2-rework.mjs - close the denial loop.
//
// Gate 2 `request-changes` used to end the conversation: the workflow recorded
// a generic rejection, closed the issue, and passed nothing back. The reviewer's
// reason went nowhere, so a returned item either died or was rewritten blind.
//
// This re-queues the item with the reason attached, in the exact form
// generate-briefs.mjs reads (`gate2 changes-requested: <reason>`), so the next
// authoring pass is told what was wrong before it writes anything.
//
// Deny is NOT rework. A denial is terminal for that revision and leaves the
// item in gate2-denied. Only request-changes returns work.

import { DatabaseSync } from "node:sqlite";

export const REWORK_PREFIX = "gate2 changes-requested: ";

// Only these states may be returned to the queue. An item that never reached
// review, or one already published, must not be resurrected by a stray comment.
const RETURNABLE = new Set(["claimed", "in-progress", "gate2-denied", "blocked"]);

export function applyRework(db, { item, reason, now = null }) {
  const stamp = now ?? new Date().toISOString();
  const result = { requeued: 0, errors: [] };

  if (!item) { result.errors.push("item is required"); return result; }
  if (!reason || !String(reason).trim()) {
    result.errors.push("request-changes requires a reason; without one the rework brief cannot say what was wrong");
    return result;
  }

  const row = db.prepare("SELECT id, state FROM work_item WHERE id = ? OR subject_id = ?").get(item, item);
  if (!row) { result.errors.push(`no work item matches ${item}`); return result; }
  if (row.state === "done") {
    result.errors.push(`${row.id} is already done; reopening published work needs a new item, not a rework`);
    return result;
  }
  if (!RETURNABLE.has(row.state)) {
    result.errors.push(`${row.id} is in state ${row.state}, which cannot be returned for rework`);
    return result;
  }

  const r = db
    .prepare("UPDATE work_item SET state = 'queued', note = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?")
    .run(`${REWORK_PREFIX}${String(reason).trim()}`, stamp, row.id);
  result.requeued = r.changes;
  result.id = row.id;
  return result;
}

// Recording a terminal denial. Kept here so both outcomes of a Gate 2 decision
// live in one place and neither can be forgotten.
export function applyDenial(db, { item, reason, now = null }) {
  const stamp = now ?? new Date().toISOString();
  const result = { denied: 0, errors: [] };
  if (!reason || !String(reason).trim()) {
    result.errors.push("deny requires a reason");
    return result;
  }
  const row = db.prepare("SELECT id, state FROM work_item WHERE id = ? OR subject_id = ?").get(item, item);
  if (!row) { result.errors.push(`no work item matches ${item}`); return result; }
  const r = db
    .prepare("UPDATE work_item SET state = 'gate2-denied', note = ?, updated_at = ? WHERE id = ?")
    .run(`gate2 denied: ${String(reason).trim()}`, stamp, row.id);
  result.denied = r.changes;
  result.id = row.id;
  return result;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "apply-gate2-rework.mjs";
if (invokedDirectly) {
  const db = new DatabaseSync(arg("db", "content.db"));
  try {
    const decision = arg("decision", "request-changes");
    const payload = { item: arg("item"), reason: arg("reason") ?? process.env.ORCHARD_DECISION_REASON };
    const res = decision === "deny" ? applyDenial(db, payload) : applyRework(db, payload);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (res.errors.length) process.exitCode = 2;
  } finally {
    db.close();
  }
}
