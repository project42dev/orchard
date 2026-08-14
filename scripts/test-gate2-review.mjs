#!/usr/bin/env node
// test-gate2-review.mjs - the Gate 2 contract.
//
// The properties that matter are all negative. Approval must be refused when
// the artifact changed, when the actor is not authorised, and above all when
// the comment is a bare "Approved", which is what the live workflow accepted
// and what let one word publish content with nothing bound to it.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, parseDecision, isBareApproval, artifactDigest, readProposal } from "./gate2-review.mjs";

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

// --- a bare Approved is NOT a decision. This is the defect being closed. ---
{
  const { dir, digest } = fixture();
  for (const word of ["Approved", "approved", "  APPROVED  ", "Denied"]) {
    const r = evaluate({ text: word, proposalDir: dir });
    ok(!r.authorised, `a bare "${word.trim()}" must never authorise`);
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
  r = evaluate({
    text: `/orchard gate2 approve item=create-thing digest=${digest}\n/orchard gate2 deny item=create-thing reason="no"`,
    proposalDir: dir,
  });
  ok(!r.authorised && r.errors.some((e) => e.includes("more than one")), "two decisions in one comment are refused");
  r = evaluate({ text: `/orchard gate2 approve item=missing digest=${digest}`, proposalDir: dir });
  ok(!r.authorised && r.errors.some((e) => e.includes("no proposal artifact")), "an unknown item is refused");
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
