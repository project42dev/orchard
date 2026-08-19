#!/usr/bin/env node
// The release role, driven end to end against a simulated GitHub API.
//
// WHY A SIMULATOR AND NOT STUBBED FUNCTIONS. The thing that can actually be
// wrong here is the sequence of API calls: which ref is read before which
// commit is created, whether the tag lands on the merge commit or on the
// branch tip, whether a re-run creates a second tag. Stubbing run-release's
// own helpers would test the parts and prove nothing about the order. So this
// file implements enough of the Git Data, contents, pulls, compare, and
// installation endpoints to actually hold state: blobs, trees, commits, refs,
// pull requests and merges are all real objects here, and the assertions read
// the resulting repository state rather than a call log wherever they can.
//
// NOTHING HERE TOUCHES THE REAL API. fetchImpl is injected everywhere, and
// the token is injected too, so no vault and no managed identity is involved.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    main as runRelease,
    bumpMinor,
    newestSemverTag,
    objectSpan,
    prependChangelogSection,
    rewriteCompatibility,
    rewritePackageVersion,
    rewritePlatformLockEntry,
    rewritePlatformTagSpec,
    summarizeCompare,
} from "./run-release.mjs";

const PLATFORM = "project42dev/project42-platform";
const LEARN = "project42dev/learn.project-42.dev";
const GUIDE = "project42dev/guide.project-42.dev";
const WWW = "project42dev/project-42.dev";

const OLD_RESOLVED_SHA = "8fd32a0e464c2cd21e3176271834cefbf7a5fba3";

// --- fixtures ---------------------------------------------------------------

const PLATFORM_PACKAGE_JSON = `{
  "name": "@project42/platform",
  "version": "0.73.0",
  "description": "Open-source content, assessment, and learning-record core for Project 42.",
  "type": "module"
}
`;

const PLATFORM_CHANGELOG = `# Changelog

All notable reusable platform changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and released versions use
semantic versioning.

## [0.72.1] - 2026-08-06

### Fixed

- Current terms acceptance is now idempotent.
`;

const PLATFORM_RELEASE_NOTES = `# Project 42 platform v0.72.1

Version 0.72.1 persists the one-time terms acceptance.

## Breaking changes

None.
`;

const PLATFORM_COMPATIBILITY = `${JSON.stringify({
    $schema: "./compatibility.schema.json",
    schemaVersion: 1,
    release: "0.72.1",
    supportLevel: "evaluation",
    api: {
        package: "@project42/platform",
        version: "0.72.1",
        image: "ghcr.io/project42dev/project42-platform-api:0.72.1",
        healthPath: "/health",
    },
    database: { adapter: "postgresql", supportedMajors: [17] },
    learn: { availability: "released", minimumVersion: "0.11.0" },
}, null, 2)}\n`;

// allowScripts carries its own, separately stale, pin of the same package --
// real in all three sites today (they sit on #v0.49.0 while the dependency has
// moved on many times). It is a second occurrence of the same spec, and a bump
// that misses it stops allowing the package's install script.
function sitePackageJson(name, pinnedVersion, allowScriptsVersion = "0.49.0") {
    return `{
  "name": "${name}",
  "version": "0.12.1",
  "dependencies": {
    "@project42/platform": "github:project42dev/project42-platform#v${pinnedVersion}",
    "next": "16.2.11"
  },
  "type": "module",
  "allowScripts": {
    "github:project42dev/project42-platform#v${allowScriptsVersion}": true,
    "puppeteer": false
  }
}
`;
}

function siteLockJson(name, pinnedVersion, resolvedSha = OLD_RESOLVED_SHA) {
    return `{
  "name": "${name}",
  "version": "0.12.1",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "${name}",
      "version": "0.12.1",
      "license": "Apache-2.0",
      "dependencies": {
        "@project42/platform": "github:project42dev/project42-platform#v${pinnedVersion}",
        "next": "16.2.11"
      }
    },
    "node_modules/@project42/platform": {
      "version": "${pinnedVersion}",
      "resolved": "git+ssh://git@github.com/project42dev/project42-platform.git#${resolvedSha}",
      "license": "Apache-2.0",
      "dependencies": {
        "jose": "6.2.4"
      }
    },
    "node_modules/next": {
      "version": "16.2.11",
      "resolved": "https://registry.npmjs.org/next/-/next-16.2.11.tgz"
    }
  }
}
`;
}

const COMPARE_FILES = [
    { filename: "content/modules/azure-local-networking.json", status: "added" },
    { filename: "content/modules/azure-local-storage.json", status: "added" },
    { filename: "content/modules/existing-module.json", status: "modified" },
    { filename: "migrations/0020_release_notes.sql", status: "added" },
    { filename: "src/index.ts", status: "modified" },
];

// --- the simulator ----------------------------------------------------------

function makeGitHub({ installation, repos, compare = {} }) {
    let counter = 0;
    const nextSha = (prefix) => {
        counter += 1;
        return `${prefix}${String(counter).padStart(40 - prefix.length, "0")}`.slice(0, 40);
    };

    const blobs = new Map();
    const trees = new Map();
    const commits = new Map();
    const refs = new Map();
    const tags = new Map();
    const pulls = [];
    const written = [];
    const calls = [];

    for (const [repo, seed] of Object.entries(repos)) {
        const treeSha = nextSha("777");
        trees.set(treeSha, { repo, files: new Map(Object.entries(seed.files)) });
        const commitSha = nextSha("aaa");
        commits.set(commitSha, { repo, tree: treeSha, parents: [] });
        refs.set(`${repo}:heads/main`, commitSha);
        tags.set(repo, (seed.tags ?? []).map((tag) => ({ ...tag, commit: { sha: tag.sha ?? commitSha } })));
        // A seeded tag naming MAIN resolves to whatever main actually is, so a
        // fixture never has to know the generated sha up front.
        for (const tag of tags.get(repo)) if (tag.sha === "MAIN") tag.commit = { sha: commitSha };
    }

    function respond(status, body) {
        const text = body === undefined ? "" : JSON.stringify(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            async text() { return text; },
            headers: { get: () => null },
        };
    }

    function fileAt(repo, ref, path) {
        const commitSha = /^[0-9a-f]{40}$/.test(ref) ? ref : refs.get(`${repo}:heads/${ref}`);
        const commit = commits.get(commitSha);
        if (!commit) return null;
        const tree = trees.get(commit.tree);
        const content = tree?.files.get(path);
        return content === undefined ? null : content;
    }

    async function fetchImpl(url, options = {}) {
        const method = options.method ?? "GET";
        const body = options.body ? JSON.parse(options.body) : null;
        const withoutHost = String(url).replace("https://api.github.com", "");
        const [rawPath, rawQuery = ""] = withoutHost.split("?");
        const path = decodeURI(rawPath);
        const query = new URLSearchParams(rawQuery);
        calls.push({ method, path, body });

        if (path === "/installation/repositories") {
            if (installation === null) return respond(403, { message: "Resource not accessible by personal access token" });
            if (Number(query.get("page") ?? "1") > 1) return respond(200, { total_count: installation.length, repositories: [] });
            return respond(200, { total_count: installation.length, repositories: installation.map((full_name) => ({ full_name })) });
        }

        const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
        if (!repoMatch) return respond(404, { message: `no route for ${path}` });
        const repo = repoMatch[1];
        const rest = repoMatch[2] ?? "";
        if (!repos[repo]) return respond(404, { message: "Not Found" });

        if (method === "GET" && rest === "/tags") {
            if (Number(query.get("page") ?? "1") > 1) return respond(200, []);
            return respond(200, tags.get(repo) ?? []);
        }

        if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
            const branch = rest.slice("/git/ref/heads/".length);
            const sha = refs.get(`${repo}:heads/${branch}`);
            if (!sha) return respond(404, { message: "Not Found" });
            return respond(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
        }

        if (method === "PATCH" && rest.startsWith("/git/refs/heads/")) {
            const branch = rest.slice("/git/refs/heads/".length);
            if (!refs.has(`${repo}:heads/${branch}`)) return respond(422, { message: "Reference does not exist" });
            refs.set(`${repo}:heads/${branch}`, body.sha);
            return respond(200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
        }

        if (method === "POST" && rest === "/git/refs") {
            if (body.ref.startsWith("refs/tags/")) {
                const name = body.ref.slice("refs/tags/".length);
                const existing = tags.get(repo) ?? [];
                if (existing.some((tag) => tag.name === name)) return respond(422, { message: "Reference already exists" });
                existing.push({ name, commit: { sha: body.sha } });
                tags.set(repo, existing);
                return respond(201, { ref: body.ref, object: { sha: body.sha } });
            }
            const branch = body.ref.slice("refs/heads/".length);
            if (refs.has(`${repo}:heads/${branch}`)) return respond(422, { message: "Reference already exists" });
            refs.set(`${repo}:heads/${branch}`, body.sha);
            return respond(201, { ref: body.ref, object: { sha: body.sha } });
        }

        if (method === "POST" && rest === "/git/blobs") {
            const sha = nextSha("b1b");
            blobs.set(sha, Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8").toString("utf8"));
            return respond(201, { sha });
        }

        if (method === "GET" && rest.startsWith("/git/blobs/")) {
            const sha = rest.slice("/git/blobs/".length);
            if (!blobs.has(sha)) return respond(404, { message: "Not Found" });
            return respond(200, { sha, encoding: "base64", content: Buffer.from(blobs.get(sha), "utf8").toString("base64") });
        }

        if (method === "POST" && rest === "/git/trees") {
            const base = trees.get(body.base_tree);
            if (!base) return respond(422, { message: "base_tree does not exist" });
            const files = new Map(base.files);
            for (const entry of body.tree) {
                const content = blobs.get(entry.sha);
                if (content === undefined) return respond(422, { message: `blob ${entry.sha} does not exist` });
                files.set(entry.path, content);
                written.push({ repo, path: entry.path, content });
            }
            const sha = nextSha("777");
            trees.set(sha, { repo, files });
            return respond(201, { sha });
        }

        if (method === "POST" && rest === "/git/commits") {
            if (!trees.has(body.tree)) return respond(422, { message: "tree does not exist" });
            const sha = nextSha("aaa");
            commits.set(sha, { repo, tree: body.tree, parents: body.parents, message: body.message });
            return respond(201, { sha });
        }

        if (method === "GET" && rest.startsWith("/git/commits/")) {
            const sha = rest.slice("/git/commits/".length);
            const commit = commits.get(sha);
            if (!commit) return respond(404, { message: "Not Found" });
            return respond(200, { sha, tree: { sha: commit.tree }, parents: commit.parents.map((parent) => ({ sha: parent })) });
        }

        if (method === "GET" && rest.startsWith("/contents/")) {
            const filePath = rest.slice("/contents/".length);
            const content = fileAt(repo, query.get("ref"), filePath);
            if (content === null) return respond(404, { message: "Not Found" });
            const sha = nextSha("c0c");
            blobs.set(sha, content);
            // Above one megabyte GitHub omits the body and hands back only the
            // sha; every real site lockfile is well under that today, so the
            // simulator returns the body inline, and the blob fallback path is
            // exercised by the oversized fixture below.
            if (content.length > 1_000_000) return respond(200, { sha, encoding: "none", content: "" });
            return respond(200, { sha, encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
        }

        if (method === "GET" && rest.startsWith("/compare/")) {
            const key = `${repo}:${rest.slice("/compare/".length)}`;
            return respond(200, { files: compare[key] ?? compare[repo] ?? [] });
        }

        if (method === "GET" && rest === "/pulls") {
            const head = query.get("head");
            const branch = head?.includes(":") ? head.split(":").slice(1).join(":") : head;
            return respond(200, pulls.filter((pull) => pull.repo === repo && (!branch || pull.head.ref === branch)));
        }

        if (method === "POST" && rest === "/pulls") {
            const number = pulls.length + 1;
            const pull = {
                repo, number, title: body.title, body: body.body, state: "open",
                merged: false, merge_commit_sha: null,
                head: { ref: body.head }, base: { ref: body.base },
            };
            pulls.push(pull);
            return respond(201, pull);
        }

        const pullMatch = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
        if (pullMatch) {
            const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(pullMatch[1]));
            if (!pull) return respond(404, { message: "Not Found" });
            if (method === "GET" && !pullMatch[2]) return respond(200, pull);
            if (method === "PUT" && pullMatch[2]) {
                if (pull.merged) return respond(405, { message: "Pull Request is not mergeable" });
                const headSha = refs.get(`${repo}:heads/${pull.head.ref}`);
                const baseSha = refs.get(`${repo}:heads/${pull.base.ref}`);
                const mergeSha = nextSha("aaa");
                commits.set(mergeSha, { repo, tree: commits.get(headSha).tree, parents: [baseSha, headSha], message: body.commit_title });
                refs.set(`${repo}:heads/${pull.base.ref}`, mergeSha);
                pull.merged = true;
                pull.state = "closed";
                pull.merge_commit_sha = mergeSha;
                return respond(200, { merged: true, sha: mergeSha, message: "Pull Request successfully merged" });
            }
        }

        return respond(404, { message: `no route for ${method} ${path}` });
    }

    return {
        fetchImpl, blobs, trees, commits, refs, tags, pulls, written, calls,
        mainOf: (repo) => refs.get(`${repo}:heads/main`),
        tagNamed: (repo, name) => (tags.get(repo) ?? []).find((tag) => tag.name === name) ?? null,
        fileOnMain: (repo, path) => fileAt(repo, "main", path),
        wroteToRepo: (repo) => written.filter((entry) => entry.repo === repo),
    };
}

function makeLog() {
    const events = [];
    const log = (level, event, detail) => { events.push({ level, event, detail }); };
    log.events = events;
    log.named = (name) => events.filter((entry) => entry.event === name);
    log.has = (name) => events.some((entry) => entry.event === name);
    return log;
}

function platformSeed({ tags }) {
    return {
        files: {
            "package.json": PLATFORM_PACKAGE_JSON,
            "CHANGELOG.md": PLATFORM_CHANGELOG,
            "RELEASE_NOTES.md": PLATFORM_RELEASE_NOTES,
            "self-host/compatibility.json": PLATFORM_COMPATIBILITY,
        },
        tags,
    };
}

function siteSeed(name, pinnedVersion = "0.72.1") {
    return {
        files: {
            "package.json": sitePackageJson(name, pinnedVersion),
            "package-lock.json": siteLockJson(name, pinnedVersion),
        },
        tags: [],
    };
}

const RUN_OPTIONS = { token: "ghs_simulated", today: "2026-08-19", env: {} };

// --- 1. nothing to release --------------------------------------------------

test("main already sitting at the newest tag releases nothing, and says so", async () => {
    const github = makeGitHub({
        installation: [PLATFORM, LEARN, GUIDE, WWW],
        repos: {
            // "MAIN" resolves to whatever main actually is, so this fixture is
            // the exact condition the check is about: tip equals newest tag.
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.9.0", sha: "9".repeat(40) }, { name: "v0.73.0", sha: "MAIN" }] }),
            [LEARN]: siteSeed("project-42-learn"),
        },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.equal(summary.released, false, "nothing is released when main carries nothing the newest tag does not");
    assert.equal(summary.releaseAction, "none");
    assert.equal(summary.version, null);
    assert.deepEqual(summary.sitesBumped, [], "no site is touched when there is nothing to release");
    assert.ok(log.has("release.nothing-to-release"), "the reason is logged, not left as silence");
    assert.ok(!log.has("release.tagged"), "nothing is tagged");
    assert.equal(github.pulls.length, 0, "no pull request is opened");

    // The diagnostic runs first and unconditionally, including on this path:
    // an operator asking "why did nothing deploy" needs the scope either way.
    const scope = log.named("release.installation-scope");
    assert.equal(scope.length, 1, "the installation scope is reported exactly once, before anything is decided");
    assert.deepEqual(scope[0].detail.repositories, [PLATFORM, LEARN, GUIDE, WWW]);
    assert.ok(
        log.events.findIndex((entry) => entry.event === "release.installation-scope")
        < log.events.findIndex((entry) => entry.event === "release.nothing-to-release"),
        "scope is logged before the release decision",
    );

    // v0.9.0 must not beat v0.73.0. A lexical sort says it does.
    assert.equal(
        newestSemverTag([{ name: "v0.9.0", commit: { sha: "1" } }, { name: "v0.73.0", commit: { sha: "2" } }]).name,
        "v0.73.0",
        "tags order numerically, not lexically",
    );
});

// --- 2. a full release ------------------------------------------------------

test("a full release updates the four governed files in one commit, merges, and tags the merge commit", async () => {
    const github = makeGitHub({
        installation: [PLATFORM, LEARN, GUIDE, WWW],
        repos: {
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.72.1", sha: "7".repeat(40) }, { name: "v0.73.0", sha: "3".repeat(40) }] }),
            [LEARN]: siteSeed("project-42-learn"),
            [GUIDE]: siteSeed("project-42-guide"),
            [WWW]: siteSeed("project-42-www"),
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.equal(summary.released, true);
    assert.equal(summary.version, "0.74.0", "the minor of package.json's own 0.73.0 is bumped");
    assert.equal(summary.releaseAction, "created");

    // --- exactly four files, in exactly one commit --------------------------
    const platformWrites = github.wroteToRepo(PLATFORM);
    assert.deepEqual(
        platformWrites.map((entry) => entry.path).sort(),
        ["CHANGELOG.md", "RELEASE_NOTES.md", "package.json", "self-host/compatibility.json"],
        "CONTRIBUTING.md's four release files move together",
    );
    const platformTrees = github.calls.filter((call) => call.method === "POST" && call.path === `/repos/${PLATFORM}/git/trees`);
    assert.equal(platformTrees.length, 1, "the four files land in one tree, which is one commit, not four");

    const byPath = Object.fromEntries(platformWrites.map((entry) => [entry.path, entry.content]));
    assert.equal(JSON.parse(byPath["package.json"]).version, "0.74.0");
    assert.match(byPath["CHANGELOG.md"], /^## \[0\.74\.0\] - 2026-08-19$/m);
    assert.match(byPath["CHANGELOG.md"], /- `content\/modules\/azure-local-networking\.json`/, "the changelog lists the content files the compare API actually reported");
    assert.match(byPath["CHANGELOG.md"], /## \[0\.72\.1\]/, "the existing changelog survives underneath");
    assert.ok(byPath["RELEASE_NOTES.md"].startsWith("# Project 42 platform v0.74.0"), "the new notes go on top");
    assert.match(byPath["RELEASE_NOTES.md"], /- `migrations\/0020_release_notes\.sql`/, "migrations are reported from the compare rather than asserted to be none");
    const compatibility = JSON.parse(byPath["self-host/compatibility.json"]);
    assert.equal(compatibility.release, "0.74.0");
    assert.equal(compatibility.api.version, "0.74.0", "the shape the real file carries is mirrored, not replaced");
    assert.equal(compatibility.api.image, "ghcr.io/project42dev/project42-platform-api:0.74.0");
    assert.equal(compatibility.api.package, "@project42/platform", "unrelated fields are left exactly as they were");
    assert.equal(compatibility.database.supportedMajors[0], 17);

    // --- the pull request, merged -------------------------------------------
    const releasePull = github.pulls.find((pull) => pull.repo === PLATFORM);
    assert.equal(releasePull.title, "[Orchard] Release v0.74.0");
    assert.equal(releasePull.head.ref, "orchard/release/v0.74.0");
    assert.equal(releasePull.base.ref, "main");
    assert.equal(releasePull.merged, true, "the release pull request is merged, not left open");

    // --- the tag, at the merge commit ---------------------------------------
    const tag = github.tagNamed(PLATFORM, "v0.74.0");
    assert.ok(tag, "the tag that triggers release.yml exists");
    assert.equal(tag.commit.sha, releasePull.merge_commit_sha, "the tag points at the merge commit, not at the branch tip");
    assert.equal(tag.commit.sha, github.mainOf(PLATFORM), "which is what main now is");
    const tagged = log.named("release.tagged");
    assert.equal(tagged.length, 1);
    assert.deepEqual(tagged[0].detail, { version: "0.74.0", commit: releasePull.merge_commit_sha });

    // --- every site bumped and merged ---------------------------------------
    assert.deepEqual(summary.sitesBumped, [LEARN, GUIDE, WWW]);
    assert.deepEqual(summary.sitesUnreachable, []);
    assert.deepEqual(summary.skipped, []);
    for (const repo of [LEARN, GUIDE, WWW]) {
        const bumped = github.fileOnMain(repo, "package.json");
        assert.match(bumped, /"@project42\/platform": "github:project42dev\/project42-platform#v0\.74\.0"/, `${repo} package.json is pinned to the new tag on main`);
        const pull = github.pulls.find((entry) => entry.repo === repo);
        assert.equal(pull.merged, true, `${repo} bump pull request is merged, which is what triggers its deploy workflow`);
        assert.equal(pull.head.ref, "orchard/platform-bump/v0.74.0");
    }
    assert.deepEqual(
        log.named("release.site-bumped").map((entry) => entry.detail.repo),
        [LEARN, GUIDE, WWW],
    );
    assert.ok(log.named("release.site-bumped").every((entry) => entry.detail.version === "0.74.0"));
});

// --- 3. a site outside the installation scope -------------------------------

test("a site the App is not installed on is reported unreachable, does not throw, and does not stop the others", async () => {
    const github = makeGitHub({
        installation: [PLATFORM, LEARN, GUIDE],
        repos: {
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }] }),
            [LEARN]: siteSeed("project-42-learn"),
            [GUIDE]: siteSeed("project-42-guide"),
            [WWW]: siteSeed("project-42-www"),
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.equal(summary.released, true, "the release itself still happens");
    assert.deepEqual(summary.sitesUnreachable, [WWW]);
    assert.deepEqual(summary.sitesBumped, [LEARN, GUIDE], "every reachable site is still bumped");

    const unreachable = log.named("release.site-unreachable");
    assert.equal(unreachable.length, 1);
    assert.equal(unreachable[0].detail.repo, WWW);
    assert.match(unreachable[0].detail.effect, /not installed/, "the effect names what an operator has to do about it");
    assert.equal(unreachable[0].level, "warn", "unreachable is a warning, not a silent skip and not a failure");

    assert.equal(github.pulls.filter((pull) => pull.repo === WWW).length, 0, "nothing is attempted against a repository outside the scope");
    assert.match(github.fileOnMain(WWW, "package.json"), /#v0\.72\.1/, "the unreachable site keeps its old pin");
});

// --- 4. re-running when the tag already exists -------------------------------

test("re-running when the tag already exists reconciles against it instead of creating a duplicate", async () => {
    const existingTagCommit = "e".repeat(40);
    const github = makeGitHub({
        installation: [PLATFORM, LEARN],
        repos: {
            // A previous run got as far as tagging v0.74.0 and then failed
            // before it bumped anything. main has moved on, package.json still
            // says 0.73.0, so this run computes the same v0.74.0 again.
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }, { name: "v0.74.0", sha: existingTagCommit }] }),
            [LEARN]: siteSeed("project-42-learn"),
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.equal(summary.releaseAction, "existing", "the existing tag is reconciled, not recut");
    assert.equal(summary.version, "0.74.0");
    const tagCreations = github.calls.filter((call) => call.method === "POST" && call.path === `/repos/${PLATFORM}/git/refs` && call.body?.ref === "refs/tags/v0.74.0");
    assert.equal(tagCreations.length, 0, "no second tag ref is ever posted");
    assert.equal(github.tags.get(PLATFORM).filter((tag) => tag.name === "v0.74.0").length, 1, "exactly one v0.74.0 tag exists");
    assert.equal(github.pulls.filter((pull) => pull.repo === PLATFORM).length, 0, "no second release pull request is opened for a version already tagged");
    assert.equal(github.wroteToRepo(PLATFORM).length, 0, "the four governed files are not rewritten for a release that already exists");
    assert.ok(log.has("release.tag-exists"));

    // The last mile is still finished: the sites the previous run never
    // reached are bumped, against the tag that already exists.
    assert.deepEqual(summary.sitesBumped, [LEARN]);
    const lock = github.fileOnMain(LEARN, "package-lock.json");
    assert.match(lock, new RegExp(`#${existingTagCommit}"`), "the site resolves to the existing tag's own commit");
});

// --- 5. the lockfile rewrite ------------------------------------------------

test("the lockfile rewrite moves the resolved commit as well as the version, and touches nothing else", () => {
    const lock = siteLockJson("project-42-learn", "0.72.1");
    const spec = rewritePlatformTagSpec(lock, { repo: PLATFORM, version: "0.74.0" });
    assert.equal(spec.replaced, 1, "the root package entry's spec is moved");

    const commit = "d".repeat(40);
    const rewritten = rewritePlatformLockEntry(spec.text, { version: "0.74.0", commit });
    const parsed = JSON.parse(rewritten.text);

    assert.equal(parsed.packages[""].dependencies["@project42/platform"], "github:project42dev/project42-platform#v0.74.0");
    assert.equal(parsed.packages["node_modules/@project42/platform"].version, "0.74.0");
    assert.equal(
        parsed.packages["node_modules/@project42/platform"].resolved,
        `git+ssh://git@github.com/project42dev/project42-platform.git#${commit}`,
        "the resolved commit is what npm actually fetches, so it moves too",
    );
    assert.equal(parsed.packages["node_modules/@project42/platform"].dependencies.jose, "6.2.4", "the rest of the entry is untouched");
    assert.equal(parsed.packages["node_modules/next"].version, "16.2.11", "no other package's version field is touched");
    assert.equal(parsed.packages["node_modules/next"].resolved, "https://registry.npmjs.org/next/-/next-16.2.11.tgz");
    assert.equal(rewritten.text.split("\n").length, lock.split("\n").length, "a targeted edit, not a reserialization of the whole lockfile");

    // A lockfile with no platform entry is refused by name rather than half written.
    assert.throws(
        () => rewritePlatformLockEntry('{"packages":{}}', { version: "0.74.0", commit }),
        (error) => error.code === "release.lock-entry-missing",
    );
    // And a resolved value with nothing to move is refused too.
    assert.throws(
        () => rewritePlatformLockEntry(
            JSON.stringify({ packages: { "node_modules/@project42/platform": { version: "0.1.0", resolved: "https://example.invalid/x.tgz" } } }, null, 2),
            { version: "0.74.0", commit },
        ),
        (error) => error.code === "release.lock-entry-shape",
    );
});

test("the end to end run writes both site pins and the resolved commit of the new tag", async () => {
    const github = makeGitHub({
        installation: [PLATFORM, LEARN],
        repos: {
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }] }),
            [LEARN]: siteSeed("project-42-learn"),
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });
    const tagCommit = github.tagNamed(PLATFORM, "v0.74.0").commit.sha;

    const writes = Object.fromEntries(github.wroteToRepo(LEARN).map((entry) => [entry.path, entry.content]));
    assert.deepEqual(Object.keys(writes).sort(), ["package-lock.json", "package.json"]);
    assert.match(writes["package.json"], /"@project42\/platform": "github:project42dev\/project42-platform#v0\.74\.0"/);
    assert.match(writes["package.json"], /"github:project42dev\/project42-platform#v0\.74\.0": true/, "the allowScripts pin moves too, or the install script is no longer allowed");

    const lock = JSON.parse(writes["package-lock.json"]);
    assert.equal(lock.packages[""].dependencies["@project42/platform"], "github:project42dev/project42-platform#v0.74.0");
    assert.equal(lock.packages["node_modules/@project42/platform"].version, "0.74.0");
    assert.equal(
        lock.packages["node_modules/@project42/platform"].resolved,
        `git+ssh://git@github.com/project42dev/project42-platform.git#${tagCommit}`,
        "the lockfile resolves to the commit the new tag points at",
    );
    assert.equal(summary.sitesBumped.length, 1);
});

// --- idempotence of a site already at the new pin ---------------------------

test("a site already pinned to the new tag is skipped rather than given an empty pull request", async () => {
    const github = makeGitHub({
        installation: [PLATFORM, LEARN],
        repos: {
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }, { name: "v0.74.0", sha: "e".repeat(40) }] }),
            [LEARN]: { files: { "package.json": sitePackageJson("project-42-learn", "0.74.0", "0.74.0"), "package-lock.json": siteLockJson("project-42-learn", "0.74.0", "e".repeat(40)) }, tags: [] },
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.deepEqual(summary.sitesBumped, []);
    assert.deepEqual(summary.skipped, [{ repo: LEARN, reason: "already pinned to v0.74.0" }]);
    assert.equal(github.pulls.length, 0, "no pull request is opened with nothing in it");
    assert.ok(log.has("release.site-already-current"));
});

// --- the large-file read path -----------------------------------------------

test("a lockfile too large for the contents API is read through its blob rather than treated as empty", async () => {
    const padding = `\n${"    ".repeat(4)}`.repeat(0);
    const bigLock = siteLockJson("project-42-learn", "0.72.1").replace(
        '"node_modules/next": {',
        `"node_modules/filler": {\n      "version": "1.0.0",\n      "description": "${"x".repeat(1_000_100)}"${padding}\n    },\n    "node_modules/next": {`,
    );
    const github = makeGitHub({
        installation: [PLATFORM, LEARN],
        repos: {
            [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }] }),
            [LEARN]: { files: { "package.json": sitePackageJson("project-42-learn", "0.72.1"), "package-lock.json": bigLock }, tags: [] },
        },
        compare: { [PLATFORM]: COMPARE_FILES },
    });
    const log = makeLog();

    const summary = await runRelease([], { ...RUN_OPTIONS, log, fetchImpl: github.fetchImpl });

    assert.deepEqual(summary.sitesBumped, [LEARN]);
    const written = github.wroteToRepo(LEARN).find((entry) => entry.path === "package-lock.json");
    assert.ok(written.content.length > 1_000_000, "the whole lockfile survives the round trip; an empty contents body is not mistaken for an empty file");
    assert.equal(JSON.parse(written.content).packages["node_modules/@project42/platform"].version, "0.74.0");
    assert.ok(
        github.calls.some((call) => call.method === "GET" && call.path.startsWith(`/repos/${LEARN}/git/blobs/`)),
        "the blob endpoint is the one that actually returned the content",
    );
});

// --- the credential path ----------------------------------------------------

test("with no credential the role reports the effect and changes nothing", async () => {
    const github = makeGitHub({ installation: [PLATFORM], repos: { [PLATFORM]: platformSeed({ tags: [{ name: "v0.73.0", sha: "3".repeat(40) }] }) } });
    const log = makeLog();

    // No vault URL and no repo variable, which is exactly what readGateToken
    // treats as unconfigured. It must not throw and must not reach the API.
    const summary = await runRelease([], { log, env: {}, fetchImpl: github.fetchImpl, today: "2026-08-19" });

    assert.equal(summary.released, false);
    assert.equal(github.calls.length, 0, "not one API call is made without a credential");
    assert.ok(log.has("release.no-credential"));
});

// --- helper-level checks ----------------------------------------------------

test("the version bump, the compare summary, and the file rewrites behave", () => {
    assert.equal(bumpMinor("0.73.0"), "0.74.0");
    assert.equal(bumpMinor("1.9.4"), "1.10.0", "the patch resets and the minor carries past nine");
    assert.throws(() => bumpMinor("0.73"), (error) => error.code === "release.version-invalid");
    assert.throws(() => bumpMinor(undefined), (error) => error.code === "release.version-invalid");

    const summary = summarizeCompare(COMPARE_FILES);
    assert.deepEqual(summary.contentAdded, ["content/modules/azure-local-networking.json", "content/modules/azure-local-storage.json"]);
    assert.deepEqual(summary.contentChanged, ["content/modules/existing-module.json"]);
    assert.deepEqual(summary.migrations, ["migrations/0020_release_notes.sql"]);
    assert.equal(summary.total, 5);

    // Rewrites are idempotent: a re-run must reconcile, never stack.
    const bumped = rewritePackageVersion(PLATFORM_PACKAGE_JSON, "0.74.0");
    assert.equal(JSON.parse(bumped).version, "0.74.0");
    assert.equal(rewritePackageVersion(bumped, "0.74.0"), bumped);
    assert.equal(JSON.parse(bumped).name, "@project42/platform", "nothing but the version moves");

    const changelog = prependChangelogSection(PLATFORM_CHANGELOG, { version: "0.74.0", date: "2026-08-19", previousTag: "v0.73.0", compare: summary });
    assert.equal(prependChangelogSection(changelog, { version: "0.74.0", date: "2026-08-19", previousTag: "v0.73.0", compare: summary }), changelog, "a second pass adds no second section");
    assert.ok(changelog.indexOf("## [0.74.0]") < changelog.indexOf("## [0.72.1]"), "newest first");

    const empty = prependChangelogSection(PLATFORM_CHANGELOG, {
        version: "0.74.0", date: "2026-08-19", previousTag: "v0.73.0",
        compare: { contentAdded: [], contentChanged: [], migrations: [], total: 0 },
    });
    assert.match(empty, /No file under `content\/` was added or changed since v0\.73\.0\./, "an empty release says so rather than emitting a bare heading");

    const compatibility = rewriteCompatibility(PLATFORM_COMPATIBILITY, "0.74.0");
    assert.equal(rewriteCompatibility(compatibility, "0.74.0"), compatibility);
    assert.throws(() => rewriteCompatibility('{"api":{}}', "0.74.0"), (error) => error.code === "release.compatibility-shape");

    // Brace matching has to survive a brace inside a string value.
    const span = objectSpan('{"a": {"x": "} not the end"}, "b": 1}', "a");
    assert.equal('{"a": {"x": "} not the end"}, "b": 1}'.slice(span.start, span.end), '"a": {"x": "} not the end"}');
});
