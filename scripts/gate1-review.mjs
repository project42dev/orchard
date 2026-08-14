#!/usr/bin/env node
// gate1-review.mjs - Gate 1: the owner decides what gets written, BEFORE it is written.
//
// Two modes.
//
//   --notify   Lists every work item sitting at 'gate1-pending' with its score
//              and estimated cost, and writes a GitHub issue body to stdout or
//              to --out. One issue per run.
//
//   --apply    Reads decision commands and moves approved items to 'queued',
//              which is the only state generate-briefs.mjs will author. Denied
//              items go to 'gate1-denied' with the reason recorded. Nothing
//              else can move an item into authoring.
//
// Why this exists: before Gate 1, build-content-db queued every non-retired
// candidate on sight and the engine authored all of them against Foundry before
// the owner ever saw an issue. Declining an item was only possible after paying
// to write it. Gate 1 puts the decision first.
//
// Decision grammar, one command per line, matching the design's per-item form:
//
//   /orchard gate1 approve item=<work_item_id>
//   /orchard gate1 deny    item=<work_item_id> reason="<reason>"
//   /orchard gate1 approve all              (batch, see --allow-batch)
//
// A batch approval is refused unless --allow-batch is passed AND the digest
// supplied with --batch-digest matches the digest of the pending set, so an
// approval cannot silently apply to items that appeared after it was written.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const PENDING = "gate1-pending";
const APPROVED = "queued";
const DENIED = "gate1-denied";

export function pendingItems(db) {
  return db
    .prepare(
      `SELECT w.id, w.kind, w.subject_id, w.surface, w.title, w.state,
              c.score, c.level, c.gap_label
         FROM work_item w
         LEFT JOIN candidate c ON c.id = w.subject_id
        WHERE w.state = ?
        ORDER BY COALESCE(c.score, 0) DESC, w.id`,
    )
    .all(PENDING);
}

// The digest binds a batch approval to an exact set of items and revisions.
// If the pending set changes, a previously written batch command stops applying.
export function batchDigest(items) {
  const canonical = items.map((i) => `${i.id}:${i.state}`).sort().join("\n");
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
    "| Item | Kind | Surface | Score | Gap |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const i of items) {
    lines.push(
      `| \`${i.id}\` | ${i.kind} | ${i.surface ?? "unknown"} | ${i.score ?? "unscored"} | ${i.gap_label ?? ""} |`,
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

export function applyDecisions(db, parsed, { allowBatch = false, now = null } = {}) {
  const stamp = now ?? new Date().toISOString();
  const pending = pendingItems(db);
  const pendingIds = new Set(pending.map((p) => p.id));
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

  const update = db.prepare(
    "UPDATE work_item SET state = ?, note = ?, updated_at = ? WHERE id = ? AND state = ?",
  );

  for (const d of parsed.items) {
    if (!pendingIds.has(d.id)) {
      result.skipped.push(`${d.id} is not pending`);
      continue;
    }
    if (d.decision === "approve") { toApprove.add(d.id); continue; }
    const r = update.run(DENIED, `gate1 denied: ${d.reason}`, stamp, d.id, PENDING);
    if (r.changes === 1) result.denied += 1;
  }

  for (const id of toApprove) {
    const r = update.run(APPROVED, null, stamp, id, PENDING);
    if (r.changes === 1) result.approved += 1;
  }
  return result;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const dbPath = arg("db", "content.db");
  const db = new DatabaseSync(dbPath);
  try {
    if (process.argv.includes("--notify")) {
      const items = pendingItems(db);
      const body = renderIssue(items, batchDigest(items));
      const out = arg("out");
      if (out) writeFileSync(out, body, "utf8");
      else process.stdout.write(body);
      process.stderr.write(`gate1: ${items.length} pending\n`);
      process.exitCode = items.length === 0 ? 0 : 0;
    } else if (process.argv.includes("--apply")) {
      const commentPath = arg("comment");
      const text = commentPath
        ? (await import("node:fs")).readFileSync(commentPath, "utf8")
        : arg("text", "");
      const parsed = parseDecisions(text);
      const res = applyDecisions(db, parsed, { allowBatch: process.argv.includes("--allow-batch") });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      if (res.errors.length) process.exitCode = 2;
    } else {
      process.stderr.write("usage: gate1-review.mjs --db <content.db> (--notify [--out f] | --apply --comment <f> [--allow-batch])\n");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
