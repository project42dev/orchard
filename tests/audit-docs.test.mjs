// The documentation audit is a CI gate, so it needs the same treatment as any
// other gate: proof that it catches each class of defect, and proof that it
// does not fire on the things that are correct as written. A gate that cannot
// fail is not a gate, and a gate that cries wolf gets disabled.
//
// Every case runs against a throwaway fixture repository rather than against
// this repository, so a real documentation fix cannot silently break a test and
// a real documentation defect cannot silently make one pass.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { auditRepository, formatReport, CHECK_KINDS } from "../scripts/audit-docs.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "orchard-audit-docs-"));
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).sort();
}

test("reports a retired host", async () => {
  const root = fixture({ "README.md": "Learners sign in at https://learn.project-42.dev/paths.\n" });
  const findings = await auditRepository(root);
  assert.deepEqual(kinds(findings), ["dead-host"]);
  assert.equal(findings[0].detail, "learn.project-42.dev");
  assert.equal(findings[0].line, 1);
});

test("leaves a deliberate historical note about a retired host alone", async () => {
  const root = fixture({
    "README.md": "The retired learn.project-42.dev surface now serves from /learn/**.\n",
  });
  assert.deepEqual(await auditRepository(root), []);
});

test("reports a relative link whose target does not exist", async () => {
  const root = fixture({ "docs/index.md": "See [the design](design/missing.md).\n" });
  const findings = await auditRepository(root);
  assert.deepEqual(kinds(findings), ["broken-link"]);
  assert.equal(findings[0].detail, "design/missing.md");
});

test("accepts a relative link whose target exists, with an anchor", async () => {
  const root = fixture({
    "docs/index.md": "See [the design](design/gate.md#why).\n",
    "docs/design/gate.md": "# Gate\n",
  });
  assert.deepEqual(await auditRepository(root), []);
});

test("reports a backticked repository path that is not on disk", async () => {
  const root = fixture({ "docs/design.md": "Verified by `lib/protected-adapter.mjs` first.\n" });
  const findings = await auditRepository(root);
  assert.deepEqual(kinds(findings), ["missing-file"]);
  assert.equal(findings[0].detail, "lib/protected-adapter.mjs");
});

test("accepts a backticked repository path that is on disk", async () => {
  const root = fixture({
    "docs/design.md": "Verified by `scripts/lib/protected-adapter.mjs` first.\n",
    "scripts/lib/protected-adapter.mjs": "export const ok = true;\n",
  });
  assert.deepEqual(await auditRepository(root), []);
});

test("accepts an explicit cross-repository path it cannot resolve from here", async () => {
  const root = fixture({
    "docs/design.md": "Released through `project42dev-ops/deployment/Deploy-Orchard.ps1`.\n",
  });
  assert.deepEqual(await auditRepository(root), []);
});

test("accepts a path inside a directory the repository does not track", async () => {
  // seed-inputs/ is release output, gitignored, and absent from a fresh
  // checkout. Checking it would pass on a developer machine and fail in CI.
  const root = fixture({
    "docs/operations.md":
      "The registry is staged to `seed-inputs/approved-source-registry.json`.\n",
  });
  assert.deepEqual(await auditRepository(root), []);
});

test("does not check release history for missing files or stale versions", async () => {
  const root = fixture({
    "CHANGELOG.md": "- 0.4.0 removed `scripts/gone.mjs`; the current version is 0.4.0.\n",
    "RELEASE_NOTES.md": "The latest release is v0.4.0 and it deleted `lib/gone.mjs`.\n",
  });
  assert.deepEqual(await auditRepository(root, { currentVersion: "0.9.0" }), []);
});

test("reports a version claimed as current that is behind the package version", async () => {
  const root = fixture({ "docs/status.md": "The platform is currently pinned to v0.81.0.\n" });
  const findings = await auditRepository(root, { currentVersion: "0.101.0" });
  assert.deepEqual(kinds(findings), ["stale-version"]);
  assert.equal(findings[0].detail, "v0.81.0 vs 0.101.0");
});

test("leaves an unrelated version number alone", async () => {
  const root = fixture({ "docs/status.md": "Node 22.5.0 and ajv 8.20.0 are required.\n" });
  assert.deepEqual(await auditRepository(root, { currentVersion: "0.101.0" }), []);
});

test("reports a claim that the curriculum lives in the platform repository", async () => {
  const root = fixture({ "docs/home.md": "The curriculum is authored in project42-platform.\n" });
  assert.deepEqual(kinds(await auditRepository(root)), ["wrong-home"]);
});

test("finds every class at once and names each one in the report", async () => {
  const root = fixture({
    "README.md": [
      "Sign in at https://guide.project-42.dev.",
      "See [the gate](docs/missing.md).",
      "Implemented in `lib/nowhere.mjs`.",
      "The catalog is stored in the platform.",
      "The current version is 0.5.0.",
    ].join("\n"),
  });
  const findings = await auditRepository(root, { currentVersion: "0.9.0" });
  assert.deepEqual(kinds(findings), [...CHECK_KINDS].sort());

  const report = formatReport(root, 1, findings);
  for (const kind of CHECK_KINDS) assert.match(report, new RegExp(`## ${kind}: 1`));
  assert.match(report, /Documentation audit FAILED: 5 defect\(s\)/);
});

test("a clean repository produces a passing report", async () => {
  const root = fixture({ "README.md": "Everything here is true.\n" });
  const findings = await auditRepository(root);
  assert.deepEqual(findings, []);
  assert.match(formatReport(root, 1, findings), /Documentation audit passed: no defects\./);
});

test("this repository's own documentation passes the audit", async () => {
  const repoRoot = join(import.meta.dirname, "..");
  const findings = await auditRepository(repoRoot, { currentVersion: null });
  assert.deepEqual(findings, [], formatReport(repoRoot, 0, findings));
});
