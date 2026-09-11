#!/usr/bin/env node
// test-gate2-review.mjs - the Gate 2 contract.
//
// The properties that matter are all negative. Approval must be refused when
// the artifact changed, when the actor is not authorised, and above all when
// the comment is a bare "Approved", which is what the live workflow accepted
// and what let one word publish content with nothing bound to it.
//
// Since 2026-09-11 a comment may carry several decisions. The negative
// properties did not move: each line still names an exact item and that item's
// exact digest, and a comment containing one bad line approves nothing at all.
// The tests below say so line by line rather than only in aggregate, because
// "the comment was refused" and "each line was checked" are different claims
// and only the second one is the guarantee.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, parseDecision, isBareApproval, artifactDigest, readProposal } from "./gate2-review.mjs";
import { MAX_GATE_BATCH_SIZE } from "./lib/gates.mjs";

let assertions = 0;
let failures = 0;
function ok(cond, msg) {
  assertions += 1;
  if (!cond) { failures += 1; console.error(`FAIL: ${msg}`); }
}

function fixture(body = '{"item":"x","content":"hello"}') {
  const dir = mkdtempSync(join(tmpdir(), "gate2-"));
  const bytes = Buffer.from(body, "utf8");
  writeFileSync(join(dir, "proposal-create-thing.json"), bytes);
  return { dir, digest: artifactDigest(bytes) };
}

// N items in one offered set, the shape the 114-item re-authoring produces.
// Each item gets its own bytes so each gets its own digest: a test where every
// artifact hashes the same could not tell a per-item binding from a global one.
function batchFixture(count) {
  const dir = mkdtempSync(join(tmpdir(), "gate2-batch-"));
  const items = [];
  for (let n = 1; n <= count; n += 1) {
    const id = `item-${String(n).padStart(2, "0")}`;
    const bytes = Buffer.from(JSON.stringify({ item: id, content: `body ${n}` }), "utf8");
    writeFileSync(join(dir, `proposal-${id}.json`), bytes);
    items.push({ id, digest: artifactDigest(bytes) });
  }
  return { dir, items };
}

const approveLine = (i) => `/orchard gate2 approve item=${i.id} digest=${i.digest}`;

// --- a bare Approved is NOT a decision. This is the defect being closed. ---
{
  const { dir, digest } = fixture();
  for (const word of ["Approved", "approved", "  APPROVED  ", "Denied"]) {
    const r = evaluate({ text: word, proposalDir: dir });
    ok(!r.authorised, `a bare "${word.trim()}" must never authorise`);
    // Not merely "it authorised nothing" -- it must be REFUSED, by name. A
    // bare word that falls through to "no command found" silently would still
    // authorise nothing today and would tell the owner nothing about why, so
    // the specific refusal is the property, not the absence of authorisation.
    ok(r.errors.some((e) => e.includes("is not a Gate 2 decision")),
       `a bare "${word.trim()}" is refused by name, not ignored`);
  }
  ok(isBareApproval("Approved"), "isBareApproval recognises the old shape");
  ok(!isBareApproval("/orchard gate2 approve item=create-thing digest=" + digest),
     "a bound command is not a bare approval");
  rmSync(dir, { recursive: true, force: true });
}

// --- approval requires a digest, and it must match the bytes on disk ---
{
  const { dir, digest } = fixture();
  let r = evaluate({ text: "/orchard gate2 approve item=create-thing", proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("requires digest")), "approve without a digest is refused");

  r = evaluate({ text: `/orchard gate2 approve item=create-thing digest=sha256:${"0".repeat(64)}`, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("STALE APPROVAL REFUSED")), "a wrong digest is refused as stale");

  r = evaluate({ text: `/orchard gate2 approve item=create-thing digest=${digest}`, proposalDir: dir });
  ok(r.authorised && r.decision === "approve", "the correct digest authorises");
  rmSync(dir, { recursive: true, force: true });
}

// --- editing the artifact invalidates an approval written before the edit ---
{
  const { dir, digest } = fixture();
  const cmd = `/orchard gate2 approve item=create-thing digest=${digest}`;
  ok(evaluate({ text: cmd, proposalDir: dir }).authorised, "approval valid before the edit");
  writeFileSync(join(dir, "proposal-create-thing.json"), Buffer.from('{"item":"x","content":"TAMPERED"}', "utf8"));
  const r = evaluate({ text: cmd, proposalDir: dir });
  ok(!r.authorised, "the SAME approval stops applying once the artifact changes");
  ok(r.errors.some((e) => e.includes("changed after the approval")), "the refusal says why");
  rmSync(dir, { recursive: true, force: true });
}

// --- deny and request-changes require a reason and carry it ---
{
  const { dir } = fixture();
  let r = evaluate({ text: "/orchard gate2 deny item=create-thing", proposalDir: dir });
  ok(!r.authorised, "deny without a reason is refused");
  r = evaluate({ text: '/orchard gate2 deny item=create-thing reason="factually wrong"', proposalDir: dir });
  ok(r.authorised && r.reason === "factually wrong", "deny carries its reason");
  r = evaluate({ text: '/orchard gate2 request-changes item=create-thing reason="tighten the intro"', proposalDir: dir });
  ok(r.authorised && r.decision === "request-changes" && r.reason === "tighten the intro",
     "request-changes is a first-class decision carrying its reason");
  ok(!r.digest, "a non-approval never binds a digest");
  rmSync(dir, { recursive: true, force: true });
}

// --- only an authorised actor may decide ---
{
  const { dir, digest } = fixture();
  const cmd = `/orchard gate2 approve item=create-thing digest=${digest}`;
  let r = evaluate({ text: cmd, proposalDir: dir, allowedActors: ["owner"], actor: "drive-by" });
  ok(!r.authorised && r.errors.some((e) => e.includes("not authorised")), "an unauthorised actor is refused");
  r = evaluate({ text: cmd, proposalDir: dir, allowedActors: ["owner"], actor: "Owner" });
  ok(r.authorised, "the authorised actor decides, case-insensitively");
  r = evaluate({ text: cmd, proposalDir: dir, allowedActors: [], actor: null });
  ok(r.authorised, "an empty allowlist does not block");
  rmSync(dir, { recursive: true, force: true });
}

// --- ambiguity and prose never authorise ---
{
  const { dir, digest } = fixture();
  let r = evaluate({ text: "looks great to me, ship it", proposalDir: dir });
  ok(!r.authorised, "prose authorises nothing");
  r = evaluate({ text: `/orchard gate2 approve item=missing digest=${digest}`, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("no proposal artifact")), "an unknown item is refused");
  rmSync(dir, { recursive: true, force: true });
}

// --- SEVERAL BOUND DECISIONS IN ONE COMMENT (2026-09-11) ---
//
// The refusal that used to sit here ("one comment carries more than one Gate 2
// decision") was never the guarantee. The guarantee is that each approval names
// an exact item AND that item's exact artifact digest, and every assertion below
// is about keeping that true while the count goes up.

// Several bound approvals in one comment all apply.
{
  const { dir, items } = batchFixture(5);
  const r = evaluate({ text: items.map(approveLine).join("\n"), proposalDir: dir });
  ok(r.authorised, "five bound approvals in one comment authorise");
  ok(r.decisions.length === 5 && r.decisions.every((d) => d.ok), "every line reports its own outcome, and all five are good");
  ok(r.decisions.every((d, n) => d.item === items[n].id && d.digest === items[n].digest),
     "each line is bound to ITS OWN item and ITS OWN digest, not to the first one's");
  ok(r.items.join(",") === items.map((i) => i.id).join(","), "every decided item is reported, in order");
  ok(r.item === items[0].id && r.digest === items[0].digest,
     "the scalar item/digest still name the first decision, so nothing already reading them changes meaning");
  rmSync(dir, { recursive: true, force: true });
}

// A full batch is accepted; one more than a batch is not.
{
  const { dir, items } = batchFixture(MAX_GATE_BATCH_SIZE + 1);
  const full = evaluate({ text: items.slice(0, MAX_GATE_BATCH_SIZE).map(approveLine).join("\n"), proposalDir: dir });
  ok(full.authorised && full.decisions.length === MAX_GATE_BATCH_SIZE,
     `a comment carrying a whole batch of ${MAX_GATE_BATCH_SIZE} authorises`);
  const over = evaluate({ text: items.map(approveLine).join("\n"), proposalDir: dir });
  ok(!over.authorised && over.errors.some((e) => e.includes(`most a gate batch can hold is ${MAX_GATE_BATCH_SIZE}`)),
     "one decision past a batch is refused, because it cannot be answering the issue it was posted on");
  rmSync(dir, { recursive: true, force: true });
}

// A wrong digest among good lines approves NOTHING, and says which line.
{
  const { dir, items } = batchFixture(4);
  const text = [
    approveLine(items[0]),
    approveLine(items[1]),
    `/orchard gate2 approve item=${items[2].id} digest=sha256:${"0".repeat(64)}`,
    approveLine(items[3]),
  ].join("\n");
  const r = evaluate({ text, proposalDir: dir });
  ok(!r.authorised, "one wrong digest refuses the whole comment; the good lines are NOT approved either");
  ok(r.errors.some((e) => e.includes("STALE APPROVAL REFUSED") && e.includes(items[2].id)),
     "the refusal names the item whose digest was wrong");
  ok(r.decisions.filter((d) => d.ok).length === 3 && r.decisions.filter((d) => !d.ok).length === 1,
     "per-line outcomes are still reported, so the owner can see which three were fine");
  ok(r.decisions[2].ok === false, "the bad line is the one reported bad");
  rmSync(dir, { recursive: true, force: true });
}

// An item this gate is not holding, mixed in with items it is.
{
  const { dir, items } = batchFixture(3);
  const text = [
    approveLine(items[0]),
    `/orchard gate2 approve item=not-offered-here digest=${items[0].digest}`,
    approveLine(items[2]),
  ].join("\n");
  const r = evaluate({ text, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("no proposal artifact")),
     "an item this issue never offered refuses the comment it arrived in");
  rmSync(dir, { recursive: true, force: true });
}

// A line that is not a command at all still refuses the comment it is in.
{
  const { dir, items } = batchFixture(2);
  const r = evaluate({ text: `${approveLine(items[0])}\n/orchard gate2 approve item=${items[1].id}`, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("requires digest")),
     "a line missing its digest refuses the comment; a good line beside it does not carry it through");
  rmSync(dir, { recursive: true, force: true });
}

// The same item twice: no defined order of precedence, so neither applies.
{
  const { dir, items } = batchFixture(2);
  let r = evaluate({ text: `${approveLine(items[0])}\n${approveLine(items[0])}`, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("same item more than once")),
     "the same item approved twice in one comment is refused");
  r = evaluate({
    text: `${approveLine(items[0])}\n/orchard gate2 deny item=${items[0].id} reason="no"`,
    proposalDir: dir,
  });
  ok(!r.authorised && r.errors.some((e) => e.includes("same item more than once")),
     "approving and denying the same item in one comment is refused, exactly as it always was");
  rmSync(dir, { recursive: true, force: true });
}

// Two kinds of decision in one comment: the workflow branches once, so it
// cannot act on both.
{
  const { dir, items } = batchFixture(2);
  const r = evaluate({
    text: `${approveLine(items[0])}\n/orchard gate2 deny item=${items[1].id} reason="wrong"`,
    proposalDir: dir,
  });
  ok(!r.authorised && r.errors.some((e) => e.includes("mixes approve and deny")),
     "approve and deny in one comment are refused, even on different items");
  rmSync(dir, { recursive: true, force: true });
}

// Several denials, or several request-changes, in one comment: same rules.
{
  const { dir, items } = batchFixture(3);
  const r = evaluate({
    text: items.map((i) => `/orchard gate2 request-changes item=${i.id} reason="tighten ${i.id}"`).join("\n"),
    proposalDir: dir,
  });
  ok(r.authorised && r.decision === "request-changes" && r.decisions.length === 3,
     "three request-changes in one comment authorise");
  ok(r.decisions.every((d, n) => d.reason === `tighten ${items[n].id}`),
     "each returned item keeps ITS OWN reason, so no item is handed the reason written about another");
  ok(r.decisions.every((d) => d.digest === null), "a non-approval never binds a digest, however many there are");
  rmSync(dir, { recursive: true, force: true });
}

// The batch path does not create a way round the bare-approval refusal or the
// actor allowlist.
{
  const { dir, items } = batchFixture(2);
  ok(evaluate({ text: "Approved", proposalDir: dir }).errors.some((e) => e.includes("bare")),
     "the bare-approval refusal is unchanged by the batch path");
  const prose = evaluate({ text: "approve all of these please", proposalDir: dir });
  ok(!prose.authorised && prose.decisions.length === 0,
     "a request to approve everything, written as prose, still binds to nothing and authorises nothing");
  const unauthorised = evaluate({
    text: items.map(approveLine).join("\n"),
    proposalDir: dir, allowedActors: ["owner"], actor: "drive-by",
  });
  ok(!unauthorised.authorised && unauthorised.errors.some((e) => e.includes("not authorised")),
     "the actor allowlist applies to a batch comment exactly as to a single one");
  ok(unauthorised.decisions.length === 0, "an unauthorised actor's lines are never even evaluated");
  rmSync(dir, { recursive: true, force: true });
}

// --- the digest covers exact bytes, not re-serialised JSON ---
{
  const a = artifactDigest(Buffer.from('{"a":1}', "utf8"));
  const b = artifactDigest(Buffer.from('{ "a": 1 }', "utf8"));
  ok(a !== b, "a formatting-only change produces a different digest and invalidates approval");
  ok(parseDecision("/orchard gate2 approve item=x digest=sha256:zz").errors.length === 1,
     "a malformed digest is rejected by the grammar");
}

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on Gate 2: approval binds to the exact artifact.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
