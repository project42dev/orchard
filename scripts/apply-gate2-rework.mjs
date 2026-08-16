#!/usr/bin/env node
// apply-gate2-rework.mjs - close the denial loop.
//
// Gate 2 `request-changes` used to end the conversation: the workflow recorded
// a generic rejection, closed the issue, and passed nothing back. The reviewer's
// reason went nowhere, so a returned item either died or was rewritten blind.
//
// This records the `changes-requested` lifecycle transition WITH the reason on
// it, which is where generate-briefs.mjs reads it back from, so the next
// authoring pass is told what was wrong before it writes anything.
//
// SCHEMA. This tool targets workflow_item in schema/migrations/002, the ONLY
// item table the deployed database has. The first version targeted work_item
// from schema/content-db.sql, which no migration ever applies, so it would
// have failed `no such table` on first contact with production data.
//
// LIFECYCLE. request-changes and deny are decisions on an item under review,
// so both apply only at 'gate2-pending'; the state machine allows nothing
// else. The successor revision that returns a changes-requested item to
// 'executing' (cause revision-created) is created by the authoring runtime
// when it picks the rework up, not here: this tool records the decision and
// its reason, and creating content revisions is not a decision.
//
// Deny is NOT rework. A denial is terminal for that revision and leaves the
// item in 'denied'. Only request-changes returns work.

import { openStateStore } from "./lib/state-store.mjs";
import { generateUuidV7 } from "./lib/identity.mjs";

export const REWORK_PREFIX = "gate2 changes-requested: ";
export const DEFAULT_ACTOR = "orchard/apply-gate2-rework";

// The only state a Gate 2 decision may act on. An item that never reached
// review, or one already published, must not be moved by a stray comment.
const DECIDABLE = "gate2-pending";

function findItem(db, item) {
  return db.prepare(
    `SELECT item_id, current_state, current_revision, origin_run_id
       FROM workflow_item WHERE item_id = ? OR semantic_identity = ?`,
  ).get(item, item) ?? null;
}

async function recordDecisionTransition(store, row, toState, cause, reason, actor, stamp) {
  await store.recordTransition({
    schema_version: "1.0.0",
    transition_id: generateUuidV7(),
    run_id: row.origin_run_id,
    item_id: row.item_id,
    item_revision: Number(row.current_revision),
    from_state: DECIDABLE,
    to_state: toState,
    cause,
    actor,
    reason,
    occurred_at: stamp,
    correlation_id: generateUuidV7(),
  });
}

export async function applyRework(store, { item, reason, now = null, actor = DEFAULT_ACTOR }) {
  const stamp = now ?? new Date().toISOString();
  const result = { requeued: 0, errors: [] };

  if (!item) { result.errors.push("item is required"); return result; }
  if (!reason || !String(reason).trim()) {
    result.errors.push("request-changes requires a reason; without one the rework brief cannot say what was wrong");
    return result;
  }

  const row = findItem(store.db, item);
  if (!row) { result.errors.push(`no workflow item matches ${item}`); return result; }
  if (["published", "closed"].includes(row.current_state)) {
    result.errors.push(`${row.item_id} is already ${row.current_state}; reopening published work needs a new item, not a rework`);
    return result;
  }
  if (row.current_state !== DECIDABLE) {
    result.errors.push(`${row.item_id} is in state ${row.current_state}, which cannot be returned for rework; only a ${DECIDABLE} item is under review`);
    return result;
  }

  try {
    await recordDecisionTransition(
      store, row, "changes-requested", "decision-requested-changes",
      `${REWORK_PREFIX}${String(reason).trim()}`, actor, stamp,
    );
    result.requeued = 1;
    result.id = row.item_id;
  } catch (error) {
    result.errors.push(`${row.item_id}: ${error.message}`);
  }
  return result;
}

// Recording a terminal denial. Kept here so both outcomes of a Gate 2 decision
// live in one place and neither can be forgotten.
export async function applyDenial(store, { item, reason, now = null, actor = DEFAULT_ACTOR }) {
  const stamp = now ?? new Date().toISOString();
  const result = { denied: 0, errors: [] };
  if (!reason || !String(reason).trim()) {
    result.errors.push("deny requires a reason");
    return result;
  }
  const row = findItem(store.db, item);
  if (!row) { result.errors.push(`no workflow item matches ${item}`); return result; }
  if (row.current_state !== DECIDABLE) {
    result.errors.push(`${row.item_id} is in state ${row.current_state}; only a ${DECIDABLE} item can be denied at Gate 2`);
    return result;
  }
  try {
    await recordDecisionTransition(
      store, row, "denied", "decision-denied",
      `gate2 denied: ${String(reason).trim()}`, actor, stamp,
    );
    result.denied = 1;
    result.id = row.item_id;
  } catch (error) {
    result.errors.push(`${row.item_id}: ${error.message}`);
  }
  return result;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "apply-gate2-rework.mjs";
if (invokedDirectly) {
  const store = openStateStore(arg("db", "content.db"));
  try {
    const decision = arg("decision", "request-changes");
    const payload = {
      item: arg("item"),
      reason: arg("reason") ?? process.env.ORCHARD_DECISION_REASON,
      actor: arg("actor", DEFAULT_ACTOR),
    };
    const res = decision === "deny" ? await applyDenial(store, payload) : await applyRework(store, payload);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (res.errors.length) process.exitCode = 2;
  } finally {
    store.close();
  }
}
