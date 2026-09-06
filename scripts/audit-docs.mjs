#!/usr/bin/env node
// Documentation audit. Finds classes of defect across every tracked Markdown
// file in the repository, rather than relying on a read-through.
//
// This exists because documentation rots silently. A read-through cannot cover
// two hundred files, and nothing else in CI reads prose, so a reference to a
// file that has since been renamed, or to a host that was retired months ago,
// survives indefinitely and misleads the next reader. The audit that first
// found these defects was a throwaway script run by hand; running it once
// fixes a snapshot, running it in CI keeps it fixed.
//
// Checks, in order of how badly each misleads a reader:
//   1. dead-host      references to retired subdomains
//   2. broken-link    relative Markdown links whose target does not exist
//   3. missing-file   backticked repository paths that do not exist on disk
//   4. wrong-home     claims that the curriculum lives in the platform repo
//   5. stale-version  version strings claimed as current that are not
//
// Read only. Reports and exits non-zero; it never edits a file.
//
// Usage:
//   node scripts/audit-docs.mjs [repoRoot] [currentVersion]
//
// Both arguments are optional. The repository root defaults to this script's
// parent directory, and the current version to the version in its package.json.

import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The single portal at https://project-42.dev replaced all of these. A document
// that still points a reader at one of them is pointing at nothing.
export const DEAD_HOSTS = [
  "learn.project-42.dev",
  "guide.project-42.dev",
  "account.project-42.dev",
  "project42dev.github.io",
];

// Generated output, vendored code, and operator-local runtime state are not
// documentation, so defects in them are not documentation defects.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "content",
  "archive",
  ".wrangler",
  "coverage",
  "seed-inputs",
  "private",
]);

// Release history legitimately names files that later moved or were removed,
// and legitimately quotes the version each release shipped. Flagging that would
// produce hundreds of findings that are all correct as written.
const HISTORY_FILES = /(?:^|\/)(?:CHANGELOG|RELEASE_NOTES)\.md$/;

// A backticked path whose first segment names another Project 42 repository is
// an explicit cross-repository reference, not a claim about a file in this one.
// It cannot be resolved from here, so it is not checked here.
const SIBLING_REPOSITORIES = new Set([
  "orchard",
  "project42-platform",
  "project42-content",
  "project42dev-ops",
  "project-42.dev",
]);

// A line that says a host or a file is retired, archived, or former is a
// deliberate historical note. Those are the record of what changed, and
// deleting them would lose the very history that explains the change.
const HISTORICAL =
  /retired|archived|former|used to|previously|no longer|until 20|record of|at the time|renamed/i;

const RELATIVE_LINK = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
const BACKTICKED_PATH =
  /`([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.(?:mjs|ts|tsx|json|yml|yaml|sql|sh|ps1))`/g;
const SEMVER = /\bv?(\d+)\.(\d+)\.(\d+)\b/g;
const CURRENCY_CLAIM = /current|latest|now at|version is|pinned to|ships/i;

export const CHECK_KINDS = [
  "dead-host",
  "broken-link",
  "missing-file",
  "wrong-home",
  "stale-version",
];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, out = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".ai" && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// CI audits what the checkout contains, so the audit must too. `git ls-files`
// is the exact answer to "what is in the checkout"; the filesystem walk is a
// fallback for a directory that is not a work tree, which is how the tests run.
export async function markdownFiles(repoRoot) {
  let tracked = null;
  try {
    tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "*.md"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    tracked = null;
  }
  if (tracked === null) return (await walk(repoRoot)).sort();
  const files = tracked
    .split("\0")
    .filter(Boolean)
    .filter((relative) => !relative.split("/").some((segment) => SKIP_DIRS.has(segment)))
    .map((relative) => path.join(repoRoot, relative));
  return files.sort();
}

export async function auditRepository(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const currentVersion = options.currentVersion ?? null;
  const files = options.files ?? (await markdownFiles(root));
  const findings = [];

  const report = (kind, file, line, detail) => {
    findings.push({
      kind,
      file: path.relative(root, file).split(path.sep).join("/"),
      line,
      detail,
    });
  };

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const lines = text.split(/\r?\n/);
    const directory = path.dirname(file);
    const isHistory = HISTORY_FILES.test(path.relative(root, file).split(path.sep).join("/"));

    for (const [index, raw] of lines.entries()) {
      const lineNumber = index + 1;
      const historical = HISTORICAL.test(raw);

      for (const host of DEAD_HOSTS) {
        if (raw.includes(host) && !historical) report("dead-host", file, lineNumber, host);
      }

      if (currentVersion && !isHistory) {
        for (const match of raw.matchAll(SEMVER)) {
          const found = [Number(match[1]), Number(match[2]), Number(match[3])];
          const current = currentVersion.split(".").map(Number);
          // Only a claim about THIS project's current version is a defect. A
          // pin to a third-party version, or a changelog entry, is not.
          const sameLine = found[0] === current[0] && found[1] < current[1];
          if (sameLine && CURRENCY_CLAIM.test(raw)) {
            report("stale-version", file, lineNumber, `${match[0]} vs ${currentVersion}`);
          }
        }
      }

      if (
        /curriculum|modules|catalog/i.test(raw) &&
        /(lives?|stored|authored|kept|held)\s+in\s+(this repository|the platform|project42-platform)/i.test(
          raw,
        ) &&
        !historical
      ) {
        report("wrong-home", file, lineNumber, raw.trim().slice(0, 90));
      }
    }

    for (const match of text.matchAll(RELATIVE_LINK)) {
      const target = match[1].split("#")[0];
      if (!target) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        decoded = target;
      }
      if (await exists(path.resolve(directory, decoded))) continue;
      report("broken-link", file, lineNumber(text, match.index), target);
    }

    if (isHistory) continue;
    for (const match of text.matchAll(BACKTICKED_PATH)) {
      const candidate = match[1];
      if (candidate.includes("node_modules")) continue;
      // A path inside a generated or runtime directory names an artifact the
      // repository deliberately does not track. It is absent from a fresh
      // checkout by design, so its absence is not a documentation defect --
      // and checking it would pass locally and fail in CI, which is worse
      // than not checking it at all.
      if (candidate.split("/").some((segment) => SKIP_DIRS.has(segment))) continue;
      if (SIBLING_REPOSITORIES.has(candidate.split("/")[0])) continue;
      if (await exists(path.join(root, candidate))) continue;
      if (await exists(path.join(path.dirname(file), candidate))) continue;
      report("missing-file", file, lineNumber(text, match.index), candidate);
    }
  }

  return findings;
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

export function formatReport(repoRoot, fileCount, findings) {
  const byKind = new Map(CHECK_KINDS.map((kind) => [kind, []]));
  for (const finding of findings) byKind.get(finding.kind)?.push(finding);

  const out = [`Audited ${fileCount} Markdown files under ${path.basename(path.resolve(repoRoot))}`, ""];
  for (const kind of CHECK_KINDS) {
    const group = byKind.get(kind);
    out.push(`## ${kind}: ${group.length}`);
    for (const finding of group.slice(0, 40)) {
      out.push(`   ${finding.file}:${finding.line}  ${finding.detail}`);
    }
    if (group.length > 40) out.push(`   ... and ${group.length - 40} more`);
    out.push("");
  }
  out.push(
    findings.length === 0
      ? "Documentation audit passed: no defects."
      : `Documentation audit FAILED: ${findings.length} defect(s).`,
  );
  return out.join("\n");
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(process.argv[2] ?? path.join(here, ".."));
  let currentVersion = process.argv[3] ?? null;
  if (!currentVersion) {
    try {
      currentVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version ?? null;
    } catch {
      currentVersion = null;
    }
  }

  const files = await markdownFiles(repoRoot);
  const findings = await auditRepository(repoRoot, { currentVersion, files });
  console.log(formatReport(repoRoot, files.length, findings));
  if (findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
