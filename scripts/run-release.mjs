#!/usr/bin/env node
// The release role: carry content that is already merged into the content
// repository all the way onto the live websites.
//
// WHY THIS EXISTS. Publication (run-publication.mjs) ends at "merged into
// project42dev/project42-platform main". Nothing on any site changes at that
// moment, and nothing deployed moved it further: the sites consume the
// platform as a git-tagged npm dependency
// (`github:project42dev/project42-platform#vX.Y.Z`), so merged-but-untagged
// content is invisible to every consumer, and a tag that nobody cuts is a
// deploy that never happens. This role is that last mile, and only that:
//
//   1. report what the App installation can actually write to
//   2. decide whether main has moved past the newest release tag at all
//   3. if it has, cut a governance-compliant release pull request, merge it,
//      and push the tag that triggers the platform's existing release.yml
//   4. bump each consuming site's pin to the new tag, which is what triggers
//      each site's own existing deploy workflow
//
// NOTHING HERE IS A NEW DEPLOY MECHANISM. Every workflow it relies on already
// exists and already works. The only thing that was missing is the thing that
// pushes the button, and the button is a tag.
//
// WHY STEP 1 IS NOT OPTIONAL. The credential is a GitHub App installation
// token, and an App is installed on a chosen set of repositories. A site the
// App is not installed on cannot be bumped, no matter how correct everything
// else is, and the failure looks exactly like "nothing happened". So the
// installation's own repository list is read and logged on every run, before
// anything is decided, and a site outside it is reported as unreachable with
// the effect named rather than silently skipped or loudly thrown.
//
// GOVERNANCE IS THE PLATFORM'S, NOT THIS FILE'S. CONTRIBUTING.md says a
// release pull request must update package.json, CHANGELOG.md,
// RELEASE_NOTES.md and self-host/compatibility.json TOGETHER, and that only a
// tag publishes. This role satisfies that contract literally: one commit,
// four files, then the tag. It does not add a rule of its own and it does not
// relax one.
//
// NOTHING IS INVENTED. Every version, commit, and file body this role writes
// is derived from something it actually read back from the API: the version
// comes from the repository's own package.json, the changelog and release
// notes list the files the compare API actually reports, the compatibility
// document is rewritten from its own parsed shape, and the tag is created at
// the merge commit GitHub itself reported. Anything it cannot read, it
// refuses with a named ReleaseError rather than guessing.
//
// IDEMPOTENT BY CHECKING, NOT BY CATCHING. A re-run reconciles: an existing
// tag is used, an existing branch is reused, an existing pull request is
// found before one is opened, and an already-merged pull request is read for
// its merge commit rather than merged again. No path relies on a 422 being
// thrown and swallowed, because a swallowed 422 hides real faults too.

import { pathToFileURL } from "node:url";
import { readGateToken } from "./announce-gates.mjs";

const API = "https://api.github.com";
const USER_AGENT = "Orchard-Release/1.0";

// Defaults, overridable by deployment configuration so an adopter is not
// forced onto this estate's repository names.
const DEFAULT_PLATFORM_REPO = "project42dev/project42-platform";
const DEFAULT_SITE_REPOS = Object.freeze([
    "project42dev/learn.project-42.dev",
    "project42dev/guide.project-42.dev",
    "project42dev/project-42.dev",
]);

const LOCK_PACKAGE_KEY = "node_modules/@project42/platform";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export class ReleaseError extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.name = "ReleaseError";
        this.code = code;
        Object.assign(this, detail);
    }
}

function fail(code, message, detail) {
    throw new ReleaseError(code, message, detail);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Branch names carry slashes, and a slash is a path separator in a ref URL, not a character to escape. */
function refPath(branch) {
    return branch.split("/").map(encodeURIComponent).join("/");
}

export const releaseBranchFor = (version) => `orchard/release/v${version}`;
export const bumpBranchFor = (version) => `orchard/platform-bump/v${version}`;

/**
 * One fetch-based GitHub client for the whole role, shaped exactly like the
 * one lib/prepare-gate2-evidence.mjs already proves out against the Git Data
 * API, plus the two things this role needs that it did not: a 404 that can be
 * an answer rather than a fault (does this ref exist?), and GitHub's own
 * message carried onward on failure, scrubbed of anything token-shaped.
 *
 * fetchImpl is injectable all the way down so the tests drive a simulated API
 * and this file never has to know it is being tested.
 */
export function createGitHubClient({ token, fetchImpl = fetch, userAgent = USER_AGENT }) {
    if (typeof token !== "string" || token.length === 0) fail("release.no-token", "a GitHub token is required to call the API");
    return async function call(path, { method = "GET", body, allow404 = false } = {}) {
        const response = await fetchImpl(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": userAgent,
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }
        if (response.status === 404 && allow404) return null;
        if (!response.ok) {
            // Same reasoning as lib/github-issues.mjs: a 403 is both "you may
            // not" and "you are rate limited", and only the body tells them
            // apart, so the message travels. Only `message`, and only after
            // anything token-shaped is removed from it.
            const reason = String(parsed?.message ?? "")
                .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{40})\b/g, "[REDACTED]");
            fail(
                "release.github-api",
                `GitHub ${method} ${path} returned ${response.status}${reason ? `: ${reason}` : ""}`,
                { status: response.status, reason },
            );
        }
        return parsed;
    };
}

/**
 * Every repository this installation can write to.
 *
 * Diagnostic and always run. An operator staring at "the site did not update"
 * needs this list first, because the single most likely cause is that the App
 * was never installed on that repository, and no other signal says so.
 */
export async function listInstallationRepositories({ call, maxPages = 10 }) {
    const names = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const body = await call(`/installation/repositories?per_page=100&page=${page}`);
        const repositories = Array.isArray(body?.repositories) ? body.repositories : [];
        for (const repository of repositories) {
            if (typeof repository?.full_name === "string") names.push(repository.full_name);
        }
        if (repositories.length < 100) break;
    }
    return names;
}

/** Every tag on the repository, paged, in the API's own order. */
export async function listTags({ call, repo, maxPages = 10 }) {
    const tags = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const batch = await call(`/repos/${repo}/tags?per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        tags.push(...batch);
        if (batch.length < 100) break;
    }
    return tags;
}

/**
 * The newest v*.*.* tag, ordered numerically rather than lexically.
 *
 * Lexical order is wrong and quietly so: this repository carries v0.9.0 and
 * v0.73.0 at the same time, and a string sort calls v0.9.0 the newer of the
 * two. Prereleases (v1.0.0-rc1) are deliberately not matched: release.yml
 * triggers on v*.*.*, and a tag it would not act on is not a release.
 */
export function newestSemverTag(tags) {
    let best = null;
    for (const tag of tags ?? []) {
        const match = SEMVER_TAG.exec(tag?.name ?? "");
        if (!match) continue;
        const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
        if (best && !(parts[0] > best.parts[0]
            || (parts[0] === best.parts[0] && parts[1] > best.parts[1])
            || (parts[0] === best.parts[0] && parts[1] === best.parts[1] && parts[2] > best.parts[2]))) continue;
        best = { name: tag.name, commit: tag.commit?.sha ?? null, parts };
    }
    return best;
}

/** The next version is a minor bump of whatever package.json actually says today. */
export function bumpMinor(version) {
    const match = SEMVER.exec(String(version ?? ""));
    if (!match) fail("release.version-invalid", `package.json version ${JSON.stringify(version)} is not a three part semantic version`);
    return `${Number(match[1])}.${Number(match[2]) + 1}.0`;
}

/**
 * A file as it exists in the repository, never from local disk.
 *
 * The contents API stops returning a body above one megabyte and hands back
 * the blob sha instead, which matters here: every site's package-lock.json is
 * over four hundred kilobytes today and growing, and a silently empty read
 * would be rewritten into a truncated lockfile. So an empty body is not
 * treated as an empty file, it is followed to the blob.
 */
export async function readRepoFile({ call, repo, path, ref }) {
    const meta = await call(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { allow404: true });
    if (!meta) fail("release.file-absent", `${repo} has no ${path} at ${ref}`, { repo, path, ref });
    if (meta.encoding === "base64" && typeof meta.content === "string" && meta.content.length > 0) {
        return { text: Buffer.from(meta.content, "base64").toString("utf8"), sha: meta.sha };
    }
    if (typeof meta.sha !== "string" || meta.sha.length === 0) fail("release.file-unreadable", `${repo} ${path} carries no blob sha to read`, { repo, path });
    const blob = await call(`/repos/${repo}/git/blobs/${meta.sha}`);
    if (blob?.encoding !== "base64" || typeof blob.content !== "string") {
        fail("release.file-unreadable", `${repo} ${path} blob ${meta.sha} was not returned as base64`, { repo, path });
    }
    return { text: Buffer.from(blob.content, "base64").toString("utf8"), sha: meta.sha };
}

/** The tip commit of a branch, or null when the branch does not exist. */
export async function readBranchTip({ call, repo, branch }) {
    const ref = await call(`/repos/${repo}/git/ref/heads/${refPath(branch)}`, { allow404: true });
    const sha = ref?.object?.sha ?? null;
    if (sha !== null && !COMMIT_SHA.test(sha)) fail("release.ref-invalid", `${repo} ${branch} resolved to ${sha}, which is not a commit sha`, { repo, branch });
    return sha;
}

/**
 * One commit carrying every supplied file, against the base commit's own
 * tree. Blob, tree, commit, exactly as prepare-gate2-evidence.mjs does it.
 * No ref is touched here: the caller decides where the commit lands.
 */
export async function commitFiles({ call, repo, baseCommit, message, files }) {
    if (!Array.isArray(files) || files.length === 0) fail("release.empty-commit", `nothing to commit to ${repo}`, { repo });
    const base = await call(`/repos/${repo}/git/commits/${baseCommit}`);
    const baseTree = base?.tree?.sha;
    if (typeof baseTree !== "string") fail("release.base-unreadable", `${repo} commit ${baseCommit} carries no tree`, { repo, baseCommit });
    const entries = [];
    for (const file of files) {
        const blob = await call(`/repos/${repo}/git/blobs`, { method: "POST", body: { content: file.content, encoding: "utf-8" } });
        entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await call(`/repos/${repo}/git/trees`, { method: "POST", body: { base_tree: baseTree, tree: entries } });
    const commit = await call(`/repos/${repo}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [baseCommit] } });
    if (!COMMIT_SHA.test(commit?.sha ?? "")) fail("release.commit-failed", `${repo} returned no commit sha for ${message.split("\n")[0]}`, { repo });
    return commit.sha;
}

/**
 * Put the branch at a commit carrying our files, whatever state it is in.
 *
 * Three real cases, and the third is the one a naive create-or-fail gets
 * wrong. The branch may not exist (create it). It may exist and already carry
 * work from a previous run that got as far as committing (reuse it as is,
 * rather than force-rewriting a branch a pull request may already be open
 * against). Or it may exist and sit exactly at the base, meaning a previous
 * run created the ref and then died before committing (commit onto it, which
 * is a fast forward and needs no force).
 */
export async function reconcileBranch({ call, repo, branch, baseCommit, message, files, log }) {
    const existing = await readBranchTip({ call, repo, branch });
    if (existing && existing !== baseCommit) {
        log("info", "release.branch-exists", { repo, branch, head: existing, effect: "the branch a previous run left behind is reused rather than rewritten" });
        return { head: existing, action: "reused" };
    }
    const head = await commitFiles({ call, repo, baseCommit, message, files });
    if (existing) {
        await call(`/repos/${repo}/git/refs/heads/${refPath(branch)}`, { method: "PATCH", body: { sha: head, force: false } });
        return { head, action: "advanced" };
    }
    await call(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: head } });
    return { head, action: "created" };
}

/** The pull request for this branch, opened only if one does not already exist. */
export async function reconcilePullRequest({ call, repo, branch, base, title, body, log }) {
    const owner = repo.split("/")[0];
    const found = await call(`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`);
    const match = Array.isArray(found) ? found.find((pull) => pull?.head?.ref === branch) : null;
    if (match) {
        log("info", "release.pull-exists", { repo, branch, pull: match.number, state: match.state, effect: "the existing pull request is reconciled rather than duplicated" });
        return { number: match.number, action: "existing" };
    }
    const created = await call(`/repos/${repo}/pulls`, { method: "POST", body: { title, head: branch, base, body } });
    if (!Number.isInteger(created?.number)) fail("release.pull-failed", `${repo} returned no pull request number for ${branch}`, { repo, branch });
    return { number: created.number, action: "created" };
}

/**
 * Merge, or read back the merge that already happened.
 *
 * The merge commit is load-bearing: it is what the tag points at and what
 * each site's lockfile records as `resolved`. So a merge that reports success
 * without a 40 character sha is refused rather than carried forward as a
 * placeholder.
 */
export async function mergePullRequest({ call, repo, number, commitTitle }) {
    const pull = await call(`/repos/${repo}/pulls/${number}`);
    if (pull?.merged) {
        if (!COMMIT_SHA.test(pull.merge_commit_sha ?? "")) fail("release.merge-unreadable", `${repo} pull ${number} reports merged with no merge commit`, { repo, number });
        return { sha: pull.merge_commit_sha, action: "already-merged" };
    }
    const merged = await call(`/repos/${repo}/pulls/${number}/merge`, { method: "PUT", body: { commit_title: commitTitle, merge_method: "merge" } });
    if (!merged?.merged || !COMMIT_SHA.test(merged.sha ?? "")) {
        fail("release.merge-refused", `${repo} refused to merge pull ${number}: ${merged?.message ?? "no merge commit was returned"}`, { repo, number });
    }
    return { sha: merged.sha, action: "merged" };
}

/**
 * What actually changed between the last release and main, from the compare
 * API, split into the categories the release notes speak about. Nothing here
 * is a judgement: it is the file list GitHub reports, grouped.
 */
export function summarizeCompare(files) {
    const summary = { contentAdded: [], contentChanged: [], migrations: [], total: 0 };
    for (const file of Array.isArray(files) ? files : []) {
        const name = file?.filename;
        if (typeof name !== "string") continue;
        summary.total += 1;
        if (name.startsWith("content/")) {
            if (file.status === "added") summary.contentAdded.push(name);
            else summary.contentChanged.push(name);
        } else if (name.startsWith("migrations/")) {
            summary.migrations.push(name);
        }
    }
    return summary;
}

export async function compareSinceTag({ call, repo, base, head }) {
    const compare = await call(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return summarizeCompare(compare?.files);
}

// --- the four release files ------------------------------------------------

/**
 * package.json's own version field, replaced in place rather than through a
 * reserialization that would reformat a file nobody asked us to reformat. The
 * value being replaced is checked against the parsed document first, and the
 * result is parsed again to prove the edit landed on the field it meant to.
 */
export function rewritePackageVersion(text, version) {
    const current = JSON.parse(text).version;
    if (current === version) return text;
    const pattern = /^(\s*"version":\s*")([^"]*)(")/m;
    const match = pattern.exec(text);
    if (!match || match[2] !== current) fail("release.package-shape", "package.json's top level version field could not be located for rewriting");
    const rewritten = text.replace(pattern, `$1${version}$3`);
    if (JSON.parse(rewritten).version !== version) fail("release.package-shape", "rewriting package.json did not change the version field it meant to");
    return rewritten;
}

/**
 * self-host/compatibility.json, rewritten from its own real shape.
 *
 * The schema is NOT invented here. The document is parsed, and only the
 * fields it actually carries that actually hold the current release version
 * are moved: `release`, `api.version`, and the version suffix of `api.image`.
 * A field that does not exist, or that holds something other than the current
 * release, is left exactly as it was. Reserialization at two space indent
 * reproduces this file byte for byte, verified against the real document.
 */
export function rewriteCompatibility(text, version) {
    const document = JSON.parse(text);
    const current = document?.release;
    if (typeof current !== "string" || !SEMVER.test(current)) {
        fail("release.compatibility-shape", "self-host/compatibility.json carries no semantic version in its release field");
    }
    if (current === version) return text;
    document.release = version;
    if (document.api && document.api.version === current) document.api.version = version;
    if (document.api && typeof document.api.image === "string" && document.api.image.endsWith(`:${current}`)) {
        document.api.image = `${document.api.image.slice(0, -current.length)}${version}`;
    }
    return `${JSON.stringify(document, null, 2)}\n`;
}

function bulletList(paths) {
    return paths.map((path) => `- \`${path}\``).join("\n");
}

/**
 * A Keep a Changelog section for the new version, inserted above the newest
 * existing one. Idempotent by looking for the version's own heading first, so
 * a re-run reconciles instead of stacking a second identical section.
 */
export function prependChangelogSection(text, { version, date, previousTag, compare }) {
    if (new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(text)) return text;
    const insertAt = text.search(/^## \[/m);
    if (insertAt === -1) fail("release.changelog-shape", "CHANGELOG.md carries no '## [version]' section to insert above");
    const blocks = [`## [${version}] - ${date}`];
    if (compare.contentAdded.length > 0) blocks.push("### Added", `${bulletList(compare.contentAdded)}`);
    if (compare.contentChanged.length > 0) blocks.push("### Changed", `${bulletList(compare.contentChanged)}`);
    if (compare.contentAdded.length === 0 && compare.contentChanged.length === 0) {
        blocks.push("### Changed", `- Release cut by Orchard. No file under \`content/\` was added or changed since ${previousTag}.`);
    }
    return `${text.slice(0, insertAt)}${blocks.join("\n\n")}\n\n${text.slice(insertAt)}`;
}

/**
 * Release notes for the new version, in the same section vocabulary the
 * existing notes use.
 *
 * WHAT THIS DOES NOT CLAIM. Breaking changes and known limitations are
 * human judgements about the code, and an automated release cannot make
 * either one honestly, so it says that rather than writing "None." and being
 * believed. Migrations are not a judgement, they are a file list, so those
 * are reported from the compare exactly like the content files.
 */
export function prependReleaseNotesSection(text, { version, previousTag, compare }) {
    const heading = `# Project 42 platform v${version}`;
    if (text.includes(heading)) return text;
    const contentLines = compare.contentAdded.length + compare.contentChanged.length > 0
        ? [
            ...(compare.contentAdded.length > 0 ? [`Added:`, "", bulletList(compare.contentAdded)] : []),
            ...(compare.contentChanged.length > 0 ? [`Changed:`, "", bulletList(compare.contentChanged)] : []),
        ]
        : [`No file under \`content/\` was added or changed since ${previousTag}.`];
    const blocks = [
        heading,
        `Version ${version} was cut by the Orchard release role from everything merged into \`main\` since ${previousTag}. It exists so that content already merged into the platform repository reaches the sites that consume the platform package.`,
        "## Content",
        ...contentLines,
        "## Migrations",
        compare.migrations.length > 0
            ? bulletList(compare.migrations)
            : `No file under \`migrations/\` was added or changed since ${previousTag}.`,
        "## Breaking changes",
        "Orchard does not classify breaking changes. Review the file list above, and the diff for this tag, before approving the release environment.",
        "## Known limitations",
        "None are recorded by the automation that cut this release. It reports what changed; it does not assess it.",
        "## Rollback",
        `Revert consuming sites to ${previousTag}.`,
    ];
    return `${blocks.join("\n\n")}\n\n${text}`;
}

// --- the site pins ---------------------------------------------------------

/**
 * Every `github:<repo>#vX.Y.Z` spec in a file, moved to the new tag.
 *
 * Raw text, not parse and reserialize: a package-lock.json is four hundred
 * kilobytes of generated JSON, and rewriting the whole document to change one
 * string turns a two line diff into an unreviewable one. Every occurrence is
 * replaced, which is deliberate: the same spec appears in the dependency
 * block, in the lockfile's root package entry, and in allowScripts, and a
 * pin that is updated in one of those places and not the others is exactly
 * the kind of half-bump that installs the old tag.
 */
export function rewritePlatformTagSpec(text, { repo, version }) {
    const pattern = new RegExp(`github:${escapeRegExp(repo)}#v\\d+\\.\\d+\\.\\d+`, "g");
    const target = `github:${repo}#v${version}`;
    let replaced = 0;
    const rewritten = text.replace(pattern, (found) => {
        if (found !== target) replaced += 1;
        return target;
    });
    return { text: rewritten, replaced };
}

/**
 * The span of one top level JSON object value, found by brace matching with
 * string awareness. Used to confine the lockfile edits below to the one
 * package entry they are about, so a `"version"` belonging to any other of
 * the eight hundred packages in the file can never be touched.
 */
export function objectSpan(text, key) {
    const marker = `"${key}": {`;
    const start = text.indexOf(marker);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start + marker.length - 1; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{") depth += 1;
        else if (character === "}") {
            depth -= 1;
            if (depth === 0) return { start, end: index + 1 };
        }
    }
    return null;
}

/**
 * The lockfile's installed record of the platform package.
 *
 * Two fields, and the second one is the one that actually decides what npm
 * fetches: `version` is the human readable "0.73.0", and `resolved` is a
 * git+ssh URL whose fragment is a COMMIT SHA. Move the version and leave the
 * sha, and `npm ci` installs the old content while every visible pin claims
 * the new release. So the sha is moved to the commit the new tag points at,
 * and a lockfile that carries no such entry, or an entry with no fragment to
 * move, is refused by name rather than half rewritten.
 */
export function rewritePlatformLockEntry(text, { version, commit, key = LOCK_PACKAGE_KEY }) {
    if (!COMMIT_SHA.test(commit ?? "")) fail("release.lock-commit", `refusing to write ${JSON.stringify(commit)} into a lockfile as a resolved commit`);
    const span = objectSpan(text, key);
    if (!span) fail("release.lock-entry-missing", `the lockfile carries no "${key}" entry to update`, { key });
    const before = text.slice(span.start, span.end);
    let changed = 0;

    const versionPattern = /("version":\s*")([^"]*)(")/;
    if (!versionPattern.test(before)) fail("release.lock-entry-shape", `the lockfile's "${key}" entry carries no version field`, { key });
    let entry = before.replace(versionPattern, (whole, head, found, tail) => {
        if (found !== version) changed += 1;
        return `${head}${version}${tail}`;
    });

    const resolvedPattern = /("resolved":\s*")([^"]*)(")/;
    const resolved = resolvedPattern.exec(entry);
    if (!resolved) fail("release.lock-entry-shape", `the lockfile's "${key}" entry carries no resolved field`, { key });
    if (!resolved[2].includes("#")) fail("release.lock-entry-shape", `the lockfile's "${key}" resolved URL carries no commit fragment to move`, { key, resolved: resolved[2] });
    const movedResolved = `${resolved[2].slice(0, resolved[2].lastIndexOf("#") + 1)}${commit}`;
    if (movedResolved !== resolved[2]) changed += 1;
    entry = entry.replace(resolvedPattern, (whole, head, found, tail) => `${head}${movedResolved}${tail}`);

    return { text: `${text.slice(0, span.start)}${entry}${text.slice(span.end)}`, changed };
}

// --- the role itself -------------------------------------------------------

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

function siteRepos(env) {
    const configured = String(env.ORCHARD_RELEASE_SITE_REPOS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    return configured.length > 0 ? configured : [...DEFAULT_SITE_REPOS];
}

/**
 * Steps 3 and 3a: the release pull request, its merge, and the tag.
 *
 * Returns the version and the commit the tag points at, because step 4 needs
 * both: the version for every pin, and the commit for every lockfile.
 */
export async function cutPlatformRelease({ call, repo, log, mainSha, newestTag, tags, today }) {
    const packageFile = await readRepoFile({ call, repo, path: "package.json", ref: mainSha });
    const currentVersion = JSON.parse(packageFile.text).version;
    const version = bumpMinor(currentVersion);
    const tagName = `v${version}`;

    // Idempotence, checked rather than caught. A previous run that tagged and
    // then failed on a site must not tag again, and must not open a second
    // release pull request for a version that is already released.
    const existingTag = (tags ?? []).find((tag) => tag?.name === tagName);
    if (existingTag) {
        if (!COMMIT_SHA.test(existingTag.commit?.sha ?? "")) fail("release.tag-unreadable", `${repo} tag ${tagName} resolves to no commit`, { repo, tag: tagName });
        log("info", "release.tag-exists", {
            version, tag: tagName, commit: existingTag.commit.sha,
            effect: "the tag this run would have created already exists; nothing is tagged again and the sites are reconciled against it",
        });
        return { version, tagName, commit: existingTag.commit.sha, action: "existing" };
    }

    const compare = await compareSinceTag({ call, repo, base: newestTag.name, head: "main" });
    log("info", "release.changes-since-tag", {
        previousTag: newestTag.name, version,
        contentAdded: compare.contentAdded.length, contentChanged: compare.contentChanged.length,
        migrations: compare.migrations.length, files: compare.total,
    });

    const changelog = await readRepoFile({ call, repo, path: "CHANGELOG.md", ref: mainSha });
    const releaseNotes = await readRepoFile({ call, repo, path: "RELEASE_NOTES.md", ref: mainSha });
    const compatibility = await readRepoFile({ call, repo, path: "self-host/compatibility.json", ref: mainSha });

    // CONTRIBUTING.md: these four move together, in one commit, or the
    // release pull request is not a release pull request.
    const files = [
        { path: "package.json", content: rewritePackageVersion(packageFile.text, version) },
        { path: "CHANGELOG.md", content: prependChangelogSection(changelog.text, { version, date: today, previousTag: newestTag.name, compare }) },
        { path: "RELEASE_NOTES.md", content: prependReleaseNotesSection(releaseNotes.text, { version, previousTag: newestTag.name, compare }) },
        { path: "self-host/compatibility.json", content: rewriteCompatibility(compatibility.text, version) },
    ];

    const branch = releaseBranchFor(version);
    const branchResult = await reconcileBranch({
        call, repo, branch, baseCommit: mainSha, files, log,
        message: `chore(release): v${version}\n\nCut by the Orchard release role. package.json, CHANGELOG.md, RELEASE_NOTES.md\nand self-host/compatibility.json move together, as CONTRIBUTING.md requires.`,
    });
    log("info", "release.branch", { repo, branch, head: branchResult.head, action: branchResult.action });

    const pull = await reconcilePullRequest({
        call, repo, branch, base: "main",
        title: `[Orchard] Release v${version}`,
        body: [
            `Cut by the Orchard release role from everything merged into \`main\` since ${newestTag.name}.`,
            "",
            "This pull request updates `package.json`, `CHANGELOG.md`, `RELEASE_NOTES.md` and `self-host/compatibility.json` together, which is what CONTRIBUTING.md requires of a release pull request.",
            "",
            `Merging it and pushing tag \`${tagName}\` is what runs the signed release workflow. The tag is created at this pull request's merge commit.`,
            "",
            `Content files added since ${newestTag.name}: ${compare.contentAdded.length}. Changed: ${compare.contentChanged.length}. Migration files touched: ${compare.migrations.length}.`,
        ].join("\n"),
        log,
    });
    log("info", "release.pull", { repo, pull: pull.number, action: pull.action });

    const merged = await mergePullRequest({ call, repo, number: pull.number, commitTitle: `[Orchard] Release v${version} (#${pull.number})` });
    log("info", "release.merged", { repo, pull: pull.number, commit: merged.sha, action: merged.action });

    // The tag is the trigger. release.yml fires on a pushed v*.*.* tag and on
    // nothing else, so this single call is the whole publish.
    await call(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/tags/${tagName}`, sha: merged.sha } });
    log("info", "release.tagged", { version, commit: merged.sha });
    return { version, tagName, commit: merged.sha, action: "created" };
}

/** Step 4, for one site: move both pins onto the new tag and merge that. */
export async function bumpSite({ call, repo, log, version, commit }) {
    const mainSha = await readBranchTip({ call, repo, branch: "main" });
    if (!mainSha) fail("release.site-main-absent", `${repo} has no main branch to bump`, { repo });

    const packageFile = await readRepoFile({ call, repo, path: "package.json", ref: mainSha });
    const lockFile = await readRepoFile({ call, repo, path: "package-lock.json", ref: mainSha });

    const packageRewrite = rewritePlatformTagSpec(packageFile.text, { repo: DEFAULT_PLATFORM_REPO, version });
    const lockSpec = rewritePlatformTagSpec(lockFile.text, { repo: DEFAULT_PLATFORM_REPO, version });
    const lockEntry = rewritePlatformLockEntry(lockSpec.text, { version, commit });
    const changed = packageRewrite.replaced + lockSpec.replaced + lockEntry.changed;
    if (changed === 0) return { action: "already-current" };

    const files = [
        { path: "package.json", content: packageRewrite.text },
        { path: "package-lock.json", content: lockEntry.text },
    ];
    const branch = bumpBranchFor(version);
    const branchResult = await reconcileBranch({
        call, repo, branch, baseCommit: mainSha, files, log,
        message: `chore(deps): pin @project42/platform to v${version}\n\nCut by the Orchard release role. package.json and package-lock.json move\ntogether, and the lockfile's resolved commit moves to the tag's own commit.`,
    });
    log("info", "release.branch", { repo, branch, head: branchResult.head, action: branchResult.action });

    const pull = await reconcilePullRequest({
        call, repo, branch, base: "main",
        title: `[Orchard] Bump @project42/platform to v${version}`,
        body: [
            `Moves this site's \`@project42/platform\` pin to \`v${version}\`.`,
            "",
            `The lockfile's \`resolved\` commit moves to \`${commit}\`, which is the commit tag \`v${version}\` points at. A pin that moves the version string without moving that commit installs the old content.`,
            "",
            "Merging this pull request is what runs this site's existing deploy workflow.",
        ].join("\n"),
        log,
    });
    const merged = await mergePullRequest({ call, repo, number: pull.number, commitTitle: `[Orchard] Bump @project42/platform to v${version} (#${pull.number})` });
    return { action: "bumped", pull: pull.number, commit: merged.sha };
}

/**
 * The role.
 *
 * argv carries the runtime's standard --state-db and --track, and this role
 * reads neither: whether a release is needed is a question about git, not
 * about workflow state, and answering it from the repository itself is the
 * only answer that cannot drift from what is actually deployed.
 *
 * `token` is injectable so the tests can drive a simulated API without a
 * managed identity. Production leaves it undefined and the Key Vault path
 * runs, exactly as run-publication.mjs does it -- and deliberately with no
 * environment-variable token fallback, for the reason announce-gates.mjs
 * already gives: a token in a job definition is a token the platform holds.
 */
export async function main(argv = process.argv.slice(2), {
    log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })),
    env = process.env,
    fetchImpl = fetch,
    token: suppliedToken = null,
    today = new Date().toISOString().slice(0, 10),
} = {}) {
    void argOf(argv, "state-db");
    const platformRepo = env.ORCHARD_RELEASE_PLATFORM_REPO ?? DEFAULT_PLATFORM_REPO;
    const summary = {
        released: false,
        version: null,
        sitesBumped: [],
        sitesUnreachable: [],
        skipped: [],
        releaseAction: "none",
        newestTag: null,
    };

    const token = suppliedToken ?? await readGateToken({
        log, env, prefix: "release",
        vaultUrlVar: "ORCHARD_PUBLICATION_VAULT_URL", repoVar: "ORCHARD_PUBLICATION_GITHUB_REPO",
        appIdVar: "ORCHARD_PUBLICATION_APP_ID_SECRET", installationIdVar: "ORCHARD_PUBLICATION_INSTALLATION_ID_SECRET",
        appKeyVar: "ORCHARD_PUBLICATION_APP_KEY_SECRET", tokenVar: "ORCHARD_PUBLICATION_TOKEN_SECRET",
    });
    if (!token) {
        log("warn", "release.no-credential", { effect: "nothing is released and no site is bumped; merged content stays invisible to the sites" });
        return summary;
    }
    const call = createGitHubClient({ token, fetchImpl });

    // 1. Scope first, always, before anything is decided.
    let scope = null;
    try {
        scope = await listInstallationRepositories({ call });
        log("info", "release.installation-scope", { repositories: scope });
    } catch (error) {
        log("warn", "release.installation-scope-unavailable", {
            code: error.code ?? null, status: error.status ?? null, reason: error.message,
            effect: "the writable repository list could not be read; every configured site is attempted and one that refuses is reported unreachable",
        });
    }

    // 2. Is a release needed at all?
    const tags = await listTags({ call, repo: platformRepo });
    const newestTag = newestSemverTag(tags);
    if (!newestTag) fail("release.no-tag", `${platformRepo} carries no v*.*.* tag to compare main against`, { repo: platformRepo });
    if (!COMMIT_SHA.test(newestTag.commit ?? "")) fail("release.tag-unreadable", `${platformRepo} tag ${newestTag.name} resolves to no commit`, { repo: platformRepo, tag: newestTag.name });
    summary.newestTag = newestTag.name;

    const mainSha = await readBranchTip({ call, repo: platformRepo, branch: "main" });
    if (!mainSha) fail("release.main-absent", `${platformRepo} has no main branch`, { repo: platformRepo });
    if (mainSha === newestTag.commit) {
        log("info", "release.nothing-to-release", {
            repo: platformRepo, tag: newestTag.name, commit: mainSha,
            effect: "main sits exactly at the newest release tag; there is nothing merged that the sites cannot already see",
        });
        return summary;
    }

    // 3. Cut it.
    const release = await cutPlatformRelease({ call, repo: platformRepo, log, mainSha, newestTag, tags, today });
    summary.released = true;
    summary.version = release.version;
    summary.releaseAction = release.action;

    // 4. Bump every site the installation can actually reach.
    for (const repo of siteRepos(env)) {
        if (scope && !scope.includes(repo)) {
            summary.sitesUnreachable.push(repo);
            log("warn", "release.site-unreachable", {
                repo, version: release.version,
                effect: "the GitHub App is not installed on this repository, so its platform pin is not bumped and its deploy workflow does not run; install the App on it to close this",
            });
            continue;
        }
        try {
            const result = await bumpSite({ call, repo, log, version: release.version, commit: release.commit });
            if (result.action === "already-current") {
                summary.skipped.push({ repo, reason: `already pinned to v${release.version}` });
                log("info", "release.site-already-current", { repo, version: release.version, effect: "nothing to bump; this site already points at the new tag" });
                continue;
            }
            summary.sitesBumped.push(repo);
            log("info", "release.site-bumped", { repo, version: release.version, pull: result.pull, commit: result.commit });
        } catch (error) {
            // One site that cannot be reached or written must not strand the
            // others, and must not be reported as if it succeeded. A 403 or a
            // 404 here is the same operator problem the scope check names.
            if (error.status === 403 || error.status === 404) {
                summary.sitesUnreachable.push(repo);
                log("warn", "release.site-unreachable", {
                    repo, version: release.version, status: error.status, reason: error.message,
                    effect: "the credential cannot write to this repository, so its platform pin is not bumped and its deploy workflow does not run",
                });
                continue;
            }
            summary.skipped.push({ repo, reason: error.message });
            log("error", "release.site-failed", {
                repo, version: release.version, code: error.code ?? null, reason: error.message,
                effect: "this site keeps its old pin; the release tag and the other sites are unaffected",
            });
        }
    }

    log("info", "release.finished", summary);
    return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
