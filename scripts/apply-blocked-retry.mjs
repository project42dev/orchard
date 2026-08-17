#!/usr/bin/env node
// apply-blocked-retry.mjs - give a stalled item a second attempt.
//
// Two dead-end states share the identical recovery shape, so one tool
// handles both:
//
// A 'blocked' item was refused by the ensemble's OWN internal review (verifier
// or adversary), not by a human at a gate. Gate 1 already approved the
// underlying proposal; the authoring attempt is what failed. Before this tool,
// state-machine.mjs had a rule that let a transition ENTER 'blocked' but none
// that let one LEAVE it, so a blocked item was permanent regardless of what an
// operator wanted -- the lifecycle could record a verdict but never act on a
// decision to retry it.
//
// A 'gate2-ready' item with no evidence file is the same dead end for a
// different reason: gate2-prep.mjs (or authoring's own inline evidence step)
// held it there, honestly, when no evidence document could be found to
// advance it to gate2-pending, rather than fabricate a review. Found live
// 2026-08-17: Track 1 had 11 such items, some old enough to predate the
// authoring role itself being deployed, and none of them could ever reach a
// Gate 2 announcement -- gate2-ready has no more of a way out than blocked
// did before this tool existed.
//
// This mirrors apply-gate2-rework.mjs's shape: find the live item, refuse
// unless it is actually in a recoverable state, then record the recovery
// transition. The difference is WHAT the recovery transition does. Gate 2
// rework only records a decision -- the successor revision is created later,
// when authoring picks the rework up. Neither blocked nor gate2-ready has a
// future "pick up" step to defer to: nothing about either is under review,
// and 'executing' is where generate-briefs.mjs's own crash-recovery query
// (current_state = 'executing' AND NOT EXISTS an artifact_binding for
// current_revision) already looks. So this tool creates the successor
// revision itself, as a copy of the stalled revision's content with a new
// revision number, and records the recovery transition in the same call.
// That is enough for the very next generate-briefs.mjs pass to pick the item
// back up through a path that already exists and is already tested.
//
// The reason the item stalled is not repeated here -- it is already
// permanent on the state_transition_event that recorded blocked or the
// gate2.prep.no-evidence log line, and generate-briefs.mjs reads it back from
// the transition the same way it reads a Gate 2 rework reason back, so an
// operator retrying an item does not need to (and cannot accidentally)
// restate or overwrite it.

import { openStateStore } from "./lib/state-store.mjs";
import { generateUuidV7 } from "./lib/identity.mjs";

export const DEFAULT_ACTOR = "orchard/apply-blocked-retry";
const RECOVERABLE = new Set(["blocked", "gate2-ready"]);

function findItem(db, item) {
  // Same lookup as apply-gate2-rework.mjs: a semantic identity can match a
  // live item plus closed predecessors since migration 006, so the live one
  // (never 'closed') sorts first and wins.
  return db.prepare(
    `SELECT item_id, current_state, current_revision, origin_run_id, track, semantic_identity
       FROM workflow_item WHERE item_id = ? OR semantic_identity = ?
      ORDER BY CASE WHEN current_state = 'closed' THEN 1 ELSE 0 END, updated_at DESC, item_id DESC
      LIMIT 1`,
  ).get(item, item) ?? null;
}

function currentRevisionRecord(db, itemId, revision) {
  const row = db.prepare(
    "SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?",
  ).get(itemId, revision);
  return row ? JSON.parse(row.record_json) : null;
}

export async function applyRetry(store, { item, now = null, actor = DEFAULT_ACTOR }) {
  const stamp = now ?? new Date().toISOString();
  const result = { retried: 0, errors: [] };

  if (!item) { result.errors.push("item is required"); return result; }

  const row = findItem(store.db, item);
  if (!row) { result.errors.push(`no workflow item matches ${item}`); return result; }
  if (!RECOVERABLE.has(row.current_state)) {
    result.errors.push(`${row.item_id} is in state ${row.current_state}, which cannot be retried; only ${[...RECOVERABLE].join(" or ")} have a stalled attempt to reopen`);
    return result;
  }

  const currentRevision = Number(row.current_revision);
  const priorRecord = currentRevisionRecord(store.db, row.item_id, currentRevision);
  if (!priorRecord) {
    result.errors.push(`${row.item_id} has no persisted revision ${currentRevision} to retry from`);
    return result;
  }

  const successorRevision = currentRevision + 1;

  try {
    // The successor revision must exist before the transition that recovers
    // into it commits (state-store.mjs enforces this for every
    // revision-created cause, not just this one). Its content is the blocked
    // revision's content unchanged: nothing about what was proposed and
    // approved at Gate 1 is different, only the authoring attempt is being
    // retried.
    await store.recordItem({
      schema_version: "1.0.0",
      item_id: row.item_id,
      run_id: row.origin_run_id,
      track: row.track,
      item_revision: successorRevision,
      semantic_identity: row.semantic_identity,
      canonical_content_id: priorRecord.canonical_content_id ?? null,
      surface: priorRecord.surface,
      outcome: priorRecord.outcome,
      state: "executing",
      proposal_digest: priorRecord.proposal_digest,
      artifact_digest: null,
      target: priorRecord.target,
      evidence: priorRecord.evidence,
      supersedes_item_id: priorRecord.supersedes_item_id ?? null,
      created_at: stamp,
      updated_at: stamp,
    });

    // Every OTHER path into 'executing' goes through the ado-linked
    // transition, which requires (and therefore always leaves behind) an
    // external_link row for that exact revision -- run-authoring.mjs reads
    // gate2-prep evidence eligibility off that exact-revision link
    // (scripts/run-authoring.mjs:189-190). This recovery path is the only
    // one that reaches 'executing' directly from an exception state, so it
    // is the only one that has to make that link exist itself, or evidence
    // prep holds forever with "no persisted ADO link" -- found live tonight,
    // first real item ever to reach this far. The ADO work item itself does
    // not change on a retry (same requirement, being re-drafted), so this
    // copies the most recent link forward onto the new revision rather than
    // creating a second ADO work item for the same content.
    const priorLink = store.db.prepare(
      `SELECT external_id FROM external_link
        WHERE item_id = ? AND provider = 'ado' AND operation = 'ado-link'
        ORDER BY item_revision DESC, linked_at DESC LIMIT 1`,
    ).get(row.item_id);
    if (priorLink) {
      store.recordExternalLink({
        link_id: generateUuidV7(),
        run_id: row.origin_run_id,
        item_id: row.item_id,
        item_revision: successorRevision,
        provider: "ado",
        operation: "ado-link",
        // external_key is Orchard's own revision-scoped lookup key
        // (ado-sync.mjs's adoExternalKey: orchard:track:item_id:r{revision}),
        // not the ADO ticket identity -- (provider, external_key) is unique
        // per row, so a new revision needs its own key. external_id is the
        // actual ADO work item number, unchanged: retrying re-drafts the
        // same requirement, it does not open a second ticket for it.
        external_key: `orchard:${row.track}:${row.item_id}:r${successorRevision}`,
        external_id: priorLink.external_id,
        linked_at: stamp,
      });
    }

    await store.recordTransition({
      schema_version: "1.0.0",
      transition_id: generateUuidV7(),
      run_id: row.origin_run_id,
      item_id: row.item_id,
      item_revision: currentRevision,
      from_state: row.current_state,
      to_state: "executing",
      cause: "revision-created",
      recovery_gate: "gate-2",
      successor_revision: successorRevision,
      actor,
      occurred_at: stamp,
      correlation_id: generateUuidV7(),
    });

    result.retried = 1;
    result.id = row.item_id;
    result.revision = successorRevision;
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
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "apply-blocked-retry.mjs";
if (invokedDirectly) {
  const store = openStateStore(arg("db", "content.db"));
  try {
    const payload = { item: arg("item"), actor: arg("actor", DEFAULT_ACTOR) };
    const res = await applyRetry(store, payload);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (res.errors.length) process.exitCode = 2;
  } finally {
    store.close();
  }
}
