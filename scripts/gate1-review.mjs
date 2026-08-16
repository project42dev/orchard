#!/usr/bin/env node
// gate1-review.mjs - Gate 1: the owner decides what gets written, BEFORE it is written.
//
// Two modes.
//
//   --notify   Lists every lifecycle item sitting at 'gate1-pending' with its
//              score and estimated cost, and writes a GitHub issue body to
//              stdout or to --out. One issue per run.
//
//   --apply    Reads decision commands and records the lifecycle transitions:
//              an approval moves the item to 'gate1-approved', which is the
//              only state ado-sync.mjs will link and advance towards authoring.
//              A denial moves it to 'denied' with the reason recorded on the
//              transition. Nothing else can move an item past the gate.
//
// SCHEMA. This tool targets workflow_item in schema/migrations/002, which is
// the ONLY item table the deployed database has. The first version targeted
// work_item from schema/content-db.sql, a developer-local schema no migration
// ever applies, so every query would have failed `no such table` in
// production. See lib/gate-queue.mjs for the two-queue trap in full.
//
// EVIDENCE SCOPE. Decisions applied here are recorded as state transitions
// through the state store, so the lifecycle is walked, never jumped. They do
// NOT carry the protected decision-event evidence chain (decision_event +
// gate_decision_authority); that path requires the digest-pinned provider
// adapter and is what apply-gate-decisions.mjs and the T3 tracker work use.
// This is the owner's local tool.
//
// Decision grammar, one command per line, matching the design's per-item form:
//
//   /orchard gate1 approve item=<item_id>
//   /orchard gate1 deny    item=<item_id> reason="<reason>"
//   /orchard gate1 approve all              (batch, see --allow-batch)
//
// A batch approval is refused unless --allow-batch is passed AND the digest
// supplied with --batch-digest matches the digest of the pending set, so an
// approval cannot silently apply to items that appeared after it was written.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { openStateStore } from "./lib/state-store.mjs";
import { heldAtGate } from "./lib/gate-queue.mjs";
import { generateUuidV7 } from "./lib/identity.mjs";

const PENDING = "gate1-pending";
const APPROVED = "gate1-approved";
const DENIED = "denied";

export const DEFAULT_ACTOR = "orchard/gate1-review";

/**
 * Everything held at Gate 1, described well enough to decide on.
 *
 * The lifecycle row carries state and identity; the recorded gate manifest
 * observation carries the human-facing detail (title, score, rationale, cost),
 * exactly as lib/gate-queue.mjs recorded it when the item was proposed.
 */
export function pendingItems(db) {
  const rows = db.prepare(
    `SELECT item_id, track, surface, semantic_identity, current_revision, origin_run_id
       FROM workflow_item
      WHERE current_state = ?
      ORDER BY item_id`,
  ).all(PENDING);
  const detail = new Map(heldAtGate(db, "gate-1").map((entry) => [entry.item_id, entry]));
  return rows
    .map((row) => {
      const entry = detail.get(row.item_id) ?? {};
      return {
        id: row.item_id,
        track: row.track,
        surface: row.surface,
        semantic_identity: row.semantic_identity,
        item_revision: Number(row.current_revision),
        origin_run_id: row.origin_run_id,
        state: PENDING,
        title: entry.title ?? row.semantic_identity,
        category: entry.category ?? null,
        score: entry.score?.value ?? null,
        proposal_digest: entry.proposal_digest ?? null,
        estimated_cost: entry.estimated_cost ?? null,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.id < b.id ? -1 : 1));
}

// The digest binds a batch approval to an exact set of items, revisions and
// proposal digests. If the pending set changes, a previously written batch
// command stops applying.
export function batchDigest(items) {
  const canonical = items
    .map((i) => `${i.id}:r${i.item_revision}:${i.proposal_digest ?? i.state}`)
    .sort()
    .join("\n");
  return "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function renderIssue(items, digest) {
  if (items.length === 0) {
    return "# Orchard Gate 1\n\nNothing is waiting for a decision.\n";
  }
  const lines = [
    "# Orchard Gate 1: approve what gets written",
    "",
    `**${items.length} item${items.length === 1 ? "" : "s"} are waiting.** Nothing below has been authored yet.`,
    "Approving an item is what authorises spending model time on it.",
    "",
    `Batch digest: \`${digest}\``,
    "",
    "| Item | Title | Category | Surface | Score |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const i of items) {
    lines.push(
      `| \`${i.id}\` | ${i.title} | ${i.category ?? "unknown"} | ${i.surface ?? "unknown"} | ${i.score ?? "unscored"} |`,
    );
  }
  lines.push(
    "",
    "## How to decide",
    "",
    "Comment one command per line. Approve only what you want written.",
    "",
    "```",
    ...items.slice(0, 3).map((i) => `/orchard gate1 approve item=${i.id}`),
    `/orchard gate1 deny item=${items[0].id} reason="not a real gap"`,
    "```",
    "",
    "To approve every item listed above, and only these items:",
    "",
    "```",
    `/orchard gate1 approve all digest=${digest}`,
    "```",
    "",
    "The digest binds that batch command to exactly the set shown here. If the",
    "pending set changes before you comment, the batch command stops applying and",
    "a fresh issue is raised. Items you neither approve nor deny stay pending and",
    "cost nothing.",
  );
  return lines.join("\n") + "\n";
}

const COMMAND =
  /^\/orchard\s+gate1\s+(approve|deny)\s+item=([A-Za-z0-9:_.-]+)(?:\s+reason="([^"\r\n]+)")?\s*$/;
const BATCH = /^\/orchard\s+gate1\s+approve\s+all\s+digest=(sha256:[a-f0-9]{64})\s*$/;

export function parseDecisions(text) {
  const out = { items: [], batch: null, errors: [] };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("/orchard")) continue;
    const b = BATCH.exec(line);
    if (b) { out.batch = b[1]; continue; }
    const m = COMMAND.exec(line);
    if (!m) { out.errors.push(`unrecognised command: ${line}`); continue; }
    const [, decision, id, reason] = m;
    if (decision === "deny" && !reason) {
      out.errors.push(`deny requires reason="...": ${line}`);
      continue;
    }
    out.items.push({ decision, id, reason: reason ?? null });
  }
  return out;
}

async function transitionDecision(store, item, toState, cause, reason, actor, stamp) {
  const record = {
    schema_version: "1.0.0",
    transition_id: generateUuidV7(),
    run_id: item.origin_run_id,
    item_id: item.id,
    item_revision: item.item_revision,
    from_state: PENDING,
    to_state: toState,
    cause,
    actor,
    occurred_at: stamp,
    correlation_id: generateUuidV7(),
  };
  if (reason != null) record.reason = reason;
  await store.recordTransition(record);
}

export async function applyDecisions(store, parsed, { allowBatch = false, now = null, actor = DEFAULT_ACTOR } = {}) {
  const stamp = now ?? new Date().toISOString();
  const pending = pendingItems(store.db);
  const byId = new Map(pending.map((p) => [p.id, p]));
  const result = { approved: 0, denied: 0, skipped: [], errors: [...parsed.errors] };

  const toApprove = new Set();
  if (parsed.batch) {
    if (!allowBatch) {
      result.errors.push("batch approval refused: --allow-batch was not passed");
    } else if (parsed.batch !== batchDigest(pending)) {
      result.errors.push(
        "batch approval refused: digest does not match the current pending set, so the set changed after the command was written",
      );
    } else {
      for (const p of pending) toApprove.add(p.id);
    }
  }

  for (const d of parsed.items) {
    if (!byId.has(d.id)) {
      result.skipped.push(`${d.id} is not pending`);
      continue;
    }
    if (d.decision === "approve") { toApprove.add(d.id); continue; }
    try {
      await transitionDecision(store, byId.get(d.id), DENIED, "decision-denied", `gate1 denied: ${d.reason}`, actor, stamp);
      result.denied += 1;
    } catch (error) {
      result.errors.push(`${d.id}: ${error.message}`);
    }
  }

  for (const id of toApprove) {
    try {
      await transitionDecision(store, byId.get(id), APPROVED, "decision-approved", null, actor, stamp);
      result.approved += 1;
    } catch (error) {
      result.errors.push(`${id}: ${error.message}`);
    }
  }
  return result;
}

// Decisions are applied INSIDE the container, not by a GitHub workflow.
//
// The workflow database lives on the Azure file share the job mounts, so a
// GitHub Actions runner cannot reach it. Instead the engine, on its next run,
// reads the comments on the open Gate 1 issue and applies them before it
// authors anything. That keeps the database single-writer and means an
// approval cannot be applied by anything that is not the engine itself.
export async function fetchIssueComments({ repo, issue, token, fetchImpl = fetch }) {
  if (!repo || !issue) throw new TypeError("repo and issue are required");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orchard-gate1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`GitHub comments fetch failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

// Only comments from an authorised login may decide. An unauthorised comment is
// reported, never silently ignored, so a decision that did not apply is visible.
export function selectAuthorised(comments, allowed) {
  const set = new Set((allowed ?? []).map((a) => String(a).toLowerCase()));
  const taken = [];
  const refused = [];
  for (const c of comments) {
    const login = c?.user?.login ? String(c.user.login).toLowerCase() : "";
    const text = String(c?.body ?? "");
    if (!text.includes("/orchard gate1")) continue;
    if (set.size > 0 && !set.has(login)) { refused.push(login || "unknown"); continue; }
    taken.push(text);
  }
  return { taken, refused };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const dbPath = arg("db", "content.db");
  const store = openStateStore(dbPath);
  try {
    if (process.argv.includes("--notify")) {
      const items = pendingItems(store.db);
      const body = renderIssue(items, batchDigest(items));
      const out = arg("out");
      if (out) writeFileSync(out, body, "utf8");
      else process.stdout.write(body);
      process.stderr.write(`gate1: ${items.length} pending\n`);
      process.exitCode = 0;
    } else if (process.argv.includes("--apply")) {
      const commentPath = arg("comment");
      const issue = arg("issue");
      let text;
      if (issue) {
        const comments = await fetchIssueComments({
          repo: arg("repo", process.env.ORCHARD_GITHUB_REPO),
          issue,
          token: process.env.GITHUB_TOKEN ?? process.env.ORCHARD_GITHUB_TOKEN,
        });
        const allowed = (arg("allowed", process.env.ORCHARD_GATE1_ACTORS) ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        const sel = selectAuthorised(comments, allowed);
        for (const r of sel.refused) {
          process.stderr.write(`gate1: refused a decision from unauthorised actor ${r}\n`);
        }
        text = sel.taken.join("\n");
      } else {
        text = commentPath
          ? (await import("node:fs")).readFileSync(commentPath, "utf8")
          : arg("text", "");
      }
      const parsed = parseDecisions(text);
      const res = await applyDecisions(store, parsed, {
        allowBatch: process.argv.includes("--allow-batch"),
        actor: arg("actor", DEFAULT_ACTOR),
      });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      if (res.errors.length) process.exitCode = 2;
    } else {
      process.stderr.write("usage: gate1-review.mjs --db <state.db> (--notify [--out f] | --apply --comment <f> [--allow-batch])\n");
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}
