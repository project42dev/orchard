#!/usr/bin/env node
// gate2-review.mjs - Gate 2: approval binds to the EXACT artifact being published.
//
// What this replaces: a workflow step that ran
//
//     grep -qiE '^\s*approved\s*$'
//
// on the comment body. One bare word authorised a commit to the content
// platform, with no binding to which item, which revision, or which bytes. An
// edited proposal stayed approvable, and a stale approval could not be
// detected. ADR-0025 rejects exactly that shape.
//
// The grammar now binds the decision to the artifact:
//
//   /orchard gate2 approve item=<id> digest=<sha256-of-the-artifact>
//   /orchard gate2 deny    item=<id> reason="<reason>"
//   /orchard gate2 request-changes item=<id> reason="<reason>"
//
// An approval is honoured ONLY when the digest in the command equals the digest
// of the artifact on disk right now. Change the artifact and every prior
// approval stops applying, which is the property a bare Approved can never have.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The digest covers the exact bytes that would be published. Proposal files are
// JSON, so they are hashed as read, not re-serialised: re-serialising would let
// a formatting change slip past an approval.
export function artifactDigest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export function readProposal(dir, itemId) {
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("proposal-") && f.endsWith(".json") && f.includes(itemId),
  );
  if (files.length === 0) return { error: `no proposal artifact found for ${itemId}` };
  if (files.length > 1) return { error: `ambiguous: ${files.length} proposals match ${itemId}` };
  const path = join(dir, files[0]);
  const bytes = readFileSync(path);
  return { path, bytes, digest: artifactDigest(bytes) };
}

const COMMAND =
  /^\/orchard\s+gate2\s+(approve|deny|request-changes)\s+item=([A-Za-z0-9:_.-]+)(?:\s+digest=(sha256:[a-f0-9]{64}))?(?:\s+reason="([^"\r\n]+)")?\s*$/;

export function parseDecision(text) {
  const out = { decisions: [], errors: [] };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith("/orchard")) continue;
    const m = COMMAND.exec(line);
    if (!m) { out.errors.push(`not a valid Gate 2 command: ${line}`); continue; }
    const [, decision, item, digest, reason] = m;
    if (decision === "approve" && !digest) {
      out.errors.push(`approve requires digest=<sha256>: ${line}`);
      continue;
    }
    if (decision !== "approve" && !reason) {
      out.errors.push(`${decision} requires reason="...": ${line}`);
      continue;
    }
    out.decisions.push({ decision, item, digest: digest ?? null, reason: reason ?? null });
  }
  return out;
}

// A bare "Approved" is explicitly NOT a decision. This is the whole point.
export function isBareApproval(text) {
  return /^\s*(approved|denied)\s*$/i.test(String(text));
}

export function evaluate({ text, proposalDir, allowedActors = [], actor = null }) {
  const result = { authorised: false, decision: null, item: null, errors: [], warnings: [] };

  if (isBareApproval(text)) {
    result.errors.push(
      'a bare "Approved" or "Denied" is not a Gate 2 decision. Use: /orchard gate2 approve item=<id> digest=<sha256>',
    );
    return result;
  }

  const allow = new Set(allowedActors.map((a) => String(a).toLowerCase()));
  if (allow.size > 0 && (!actor || !allow.has(String(actor).toLowerCase()))) {
    result.errors.push(`actor ${actor ?? "unknown"} is not authorised to decide Gate 2`);
    return result;
  }

  const parsed = parseDecision(text);
  result.errors.push(...parsed.errors);
  if (parsed.decisions.length === 0) return result;
  if (parsed.decisions.length > 1) {
    result.errors.push("one comment carries more than one Gate 2 decision; issue them separately");
    return result;
  }

  const d = parsed.decisions[0];
  result.decision = d.decision;
  result.item = d.item;

  if (d.decision !== "approve") {
    result.authorised = true;
    result.reason = d.reason;
    return result;
  }

  const art = readProposal(proposalDir, d.item);
  if (art.error) { result.errors.push(art.error); return result; }
  if (art.digest !== d.digest) {
    result.errors.push(
      `STALE APPROVAL REFUSED. The approval names ${d.digest} but the artifact on disk is ${art.digest}. ` +
        "The content changed after the approval was written.",
    );
    return result;
  }
  result.authorised = true;
  result.digest = art.digest;
  result.path = art.path;
  return result;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "gate2-review.mjs";
if (invokedDirectly) {
  // The comment body arrives through the environment, never through the command
  // line or a shell interpolation, so its contents cannot be executed.
  const text = process.env.ORCHARD_COMMENT_BODY ?? arg("text", "");
  const allowed = (process.env.ORCHARD_GATE2_ACTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const res = evaluate({
    text,
    proposalDir: arg("proposals", "delivery/proposals"),
    allowedActors: allowed,
    actor: process.env.ORCHARD_COMMENT_ACTOR ?? null,
  });
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    // The existing workflow steps branch on 'approved' and 'denied', so the
    // decision is mapped to those values rather than renaming every downstream
    // condition. An unauthorised comment emits 'ignore', which matches no
    // branch, so nothing runs. Failing closed is the point.
    const LEGACY = { approve: "approved", deny: "denied", "request-changes": "changes-requested" };
    const emitted = res.authorised ? (LEGACY[res.decision] ?? "ignore") : "ignore";
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${emitted}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `item=${res.item ?? ""}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `authorised=${res.authorised}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `digest=${res.digest ?? ""}\n`);
  }
  process.exitCode = res.errors.length > 0 && !res.authorised ? 2 : 0;
}
