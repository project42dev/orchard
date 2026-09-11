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
//
// SEVERAL DECISIONS IN ONE COMMENT (2026-09-11). The first version refused any
// comment carrying more than one decision. That refusal was never the guarantee
// -- the guarantee is that every approval names an exact item AND that item's
// exact artifact digest. Carrying twenty such bound lines in one comment does
// not loosen a single one of them; it only saves the owner twenty round trips.
// The re-authoring that sends 114 Track 2 items back through this gate is what
// made the difference between "drudgery" and "unusable". So N decisions are now
// accepted, each on its own line, each validated independently and reported
// independently -- and the comment is refused WHOLE if any one of them fails.
// See the comment on evaluate() for why whole-comment refusal, not partial
// application, is the only safe answer for THIS script's consumer.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// The cap on decisions per comment is the gate batch size, not a number of its
// own. A Gate 2 issue is one batch, a batch is at most MAX_GATE_BATCH_SIZE
// items (lib/gates.mjs enforces it as normative, never a display choice), so a
// comment carrying more decisions than that cannot be answering the issue it
// was posted on. Importing it means the two can never drift apart.
import { MAX_GATE_BATCH_SIZE } from "./lib/gates.mjs";

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
    // `line` is carried so every per-line outcome can quote the exact text the
    // owner wrote. A refusal that says "one of your lines was wrong" and does
    // not say which one is a refusal nobody can act on.
    out.decisions.push({ line, decision, item, digest: digest ?? null, reason: reason ?? null });
  }
  return out;
}

// A bare "Approved" is explicitly NOT a decision. This is the whole point.
export function isBareApproval(text) {
  return /^\s*(approved|denied)\s*$/i.test(String(text));
}

/**
 * One decision line, checked on its own terms.
 *
 * Returns the line's own outcome record. Nothing here consults the other lines:
 * a line is valid or not by itself, which is what "every decision is validated
 * independently" has to mean if it is to mean anything.
 */
function evaluateLine(d, proposalDir) {
  const outcome = {
    line: d.line,
    decision: d.decision,
    item: d.item,
    digest: null,
    path: null,
    reason: d.reason,
    ok: false,
    errors: [],
  };

  // deny and request-changes bind to the item, not to the bytes: they take
  // nothing away from the artifact and the grammar has already insisted on a
  // reason, so there is nothing further to check.
  if (d.decision !== "approve") {
    outcome.ok = true;
    return outcome;
  }

  // "An item not offered by this issue" is exactly this check. In this path the
  // proposals directory IS the offered set -- the workflow points --proposals
  // at the delivery/proposals the run produced -- so an item with no proposal
  // artifact is an item this gate is not holding, and readProposal refuses it.
  const art = readProposal(proposalDir, d.item);
  if (art.error) { outcome.errors.push(`${d.item}: ${art.error}`); return outcome; }
  if (art.digest !== d.digest) {
    outcome.errors.push(
      `STALE APPROVAL REFUSED for ${d.item}. The approval names ${d.digest} but the artifact on disk is ${art.digest}. ` +
        "The content changed after the approval was written.",
    );
    return outcome;
  }
  outcome.ok = true;
  outcome.digest = art.digest;
  outcome.path = art.path;
  return outcome;
}

/**
 * Evaluate one comment, which may carry up to MAX_GATE_BATCH_SIZE decisions.
 *
 * WHY THE WHOLE COMMENT IS REFUSED WHEN ANY LINE FAILS, rather than applying
 * the good lines and reporting the bad ones. It is not squeamishness, and it is
 * not the old one-decision-per-comment rule wearing a hat. It is this script's
 * consumer.
 *
 * .github/workflows/orchard-human-review.yml branches on ONE scalar output --
 * `decision` -- and its publish, record-publication and ado-sync steps then act
 * on every subject they can scrape out of the ISSUE BODY, not on the item the
 * command named. There is no per-item apply path on this side at all. So a
 * partial `decision=approved`, emitted because nineteen of twenty lines were
 * good, would hand that item-blind downstream a green light that includes the
 * twentieth item -- the one whose digest did not match. Partial application
 * here does not approve nineteen items; it publishes twenty, one of them
 * unapproved. That is precisely the unbound approval ADR-0025 exists to stop.
 *
 * The engine-side path is different and is deliberately left alone:
 * apply-gate-decisions.mjs records each item through its own protected-adapter
 * evidence chain (recordVerifiedDecision per item), so a per-item failure there
 * genuinely leaves the other items' records intact. Partial application is
 * consistent with THAT apply path. It is not consistent with this one.
 *
 * The cost of refusing whole is one repost of a corrected comment. The cost of
 * the alternative is publishing content nobody approved.
 *
 * Structural faults -- more decisions than a batch can hold, the same item
 * twice, two different kinds of decision in one comment -- are refused before
 * any line is evaluated, because they are faults of the comment rather than of
 * a line, and evaluating lines under them would report outcomes for a comment
 * whose meaning is already undefined.
 */
export function evaluate({ text, proposalDir, allowedActors = [], actor = null }) {
  const result = { authorised: false, decision: null, item: null, items: [], decisions: [], errors: [], warnings: [] };

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
  // A line that began with /orchard and did not parse is a bad line like any
  // other, and it refuses the comment along with the rest. Before this, one
  // good line alongside one garbled one still authorised, which is the "one bad
  // line silently passes the others" shape from the other direction.
  result.errors.push(...parsed.errors);
  if (parsed.decisions.length === 0) return result;

  result.items = parsed.decisions.map((d) => d.item);
  // Kept scalar for the workflow outputs and for every existing caller: with
  // one decision these mean exactly what they always meant, and with several
  // they name the first, which is the only thing a scalar can honestly say.
  result.decision = parsed.decisions[0].decision;
  result.item = parsed.decisions[0].item;

  if (parsed.decisions.length > MAX_GATE_BATCH_SIZE) {
    result.errors.push(
      `one comment carries ${parsed.decisions.length} Gate 2 decisions; the most a gate batch can hold is ` +
        `${MAX_GATE_BATCH_SIZE}, so this comment cannot be answering the issue it was posted on. ` +
        "Split it to match the batches you were actually offered.",
    );
    return result;
  }

  const seen = new Set();
  const repeated = new Set();
  for (const d of parsed.decisions) {
    if (seen.has(d.item)) repeated.add(d.item);
    seen.add(d.item);
  }
  if (repeated.size > 0) {
    result.errors.push(
      `one comment decides the same item more than once (${[...repeated].join(", ")}). There is no defined order of ` +
        "precedence between two decisions on one item, so neither is applied. Name each item once.",
    );
    return result;
  }

  const kinds = [...new Set(parsed.decisions.map((d) => d.decision))];
  if (kinds.length > 1) {
    result.errors.push(
      `one comment mixes ${kinds.join(" and ")} decisions. The review workflow branches once on the decision it is ` +
        "given, so it cannot act on two kinds from one comment. Post one comment per kind.",
    );
    return result;
  }

  result.decisions = parsed.decisions.map((d) => evaluateLine(d, proposalDir));
  for (const outcome of result.decisions) result.errors.push(...outcome.errors);

  // Every line good AND nothing unparsed. Anything less refuses the comment
  // whole; see the note above for why partial is not on offer here.
  if (result.errors.length > 0) return result;

  result.authorised = true;
  if (result.decision !== "approve") {
    result.reason = parsed.decisions[0].reason;
    return result;
  }
  result.digest = result.decisions[0].digest;
  result.path = result.decisions[0].path;
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
    // `item` and `digest` stay scalar and keep naming the first decision, so
    // nothing that already reads them changes meaning. `items` and
    // `decisions_json` are what a step must read to act on ALL of them --
    // `decisions_json` is a single line of JSON (item ids are [A-Za-z0-9:_.-]
    // and reasons cannot contain a newline by grammar, so it cannot break the
    // key=value framing) and it is emitted ONLY when the whole comment was
    // authorised, so no step can ever loop over a refused line.
    const authorisedDecisions = res.authorised ? res.decisions : [];
    appendFileSync(process.env.GITHUB_OUTPUT, `items=${authorisedDecisions.map((d) => d.item).join(" ")}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `count=${authorisedDecisions.length}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `decisions_json=${JSON.stringify(authorisedDecisions.map(({ item, decision, digest, reason }) => ({ item, decision, digest, reason })))}\n`,
    );
  }
  process.exitCode = res.errors.length > 0 && !res.authorised ? 2 : 0;
}
