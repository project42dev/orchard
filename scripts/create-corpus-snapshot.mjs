#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { t, x } from "tar";
import { canonicalJson } from "./lib/identity.mjs";
import { corpusContentDigest, validateCorpusArchiveEntry } from "./lib/corpus-snapshot.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_BLOB = /^[A-Za-z0-9._/-]+$/;

function git(repository, args) {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
}

async function fileDigest(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
}

function safeBlobName(value) {
    if (!SAFE_BLOB.test(value ?? "") || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new TypeError("archiveBlob must be a safe relative Blob name");
    }
    return value;
}

export async function createCorpusSnapshot({ repository, commit, archivePath, manifestPath, archiveBlob }) {
    if (!COMMIT.test(commit ?? "")) throw new TypeError("commit must be a full lowercase Git commit");
    const repo = resolve(repository);
    const archive = resolve(archivePath);
    const manifestFile = resolve(manifestPath);
    if (archive === manifestFile) throw new TypeError("archivePath and manifestPath must differ");
    if (existsSync(archive) || existsSync(manifestFile)) throw new Error("snapshot outputs already exist");
    const resolvedCommit = git(repo, ["rev-parse", "--verify", `${commit}^{commit}`]);
    if (resolvedCommit !== commit) throw new Error("repository did not resolve the exact requested commit");
    safeBlobName(archiveBlob);

    mkdirSync(dirname(archive), { recursive: true });
    mkdirSync(dirname(manifestFile), { recursive: true });
    const validationRoot = mkdtempSync(join(tmpdir(), "orchard-snapshot-build-"));
    try {
        const archiveResult = spawnSync("git", ["-C", repo, "archive", "--format=tar.gz", "--prefix=snapshot/", `--output=${archive}`, commit, "content"], { encoding: "utf8", windowsHide: true });
        if (archiveResult.status !== 0) throw new Error(`git archive failed: ${(archiveResult.stderr || archiveResult.stdout).trim()}`);

        const state = { extractedBytes: 0, entryCount: 0, archiveRoot: null };
        await t({ file: archive, strict: true, onentry(entry) { validateCorpusArchiveEntry(entry, state, 1_073_741_824); } });
        await x({ file: archive, cwd: validationRoot, strip: 1, strict: true, preservePaths: false, filter: (_path, entry) => ["File", "Directory"].includes(entry.type) });
        const manifest = Object.freeze({
            schemaVersion: 1,
            commit,
            archiveBlob,
            archiveDigest: await fileDigest(archive),
            contentDigest: corpusContentDigest(validationRoot),
        });
        writeFileSync(manifestFile, `${canonicalJson(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o400 });
        return Object.freeze({ archivePath: archive, manifestPath: manifestFile, manifest });
    } catch (error) {
        rmSync(archive, { force: true });
        rmSync(manifestFile, { force: true });
        throw error;
    } finally {
        rmSync(validationRoot, { recursive: true, force: true });
    }
}

function parseArgs(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) throw new TypeError("arguments must be --name value pairs");
        if (values.has(name)) throw new TypeError(`duplicate argument: ${name}`);
        values.set(name, value);
    }
    for (const name of ["--repository", "--commit", "--archive", "--manifest", "--archive-blob"]) {
        if (!values.has(name)) throw new TypeError(`${name} is required`);
    }
    if (values.size !== 5) throw new TypeError("unknown argument");
    return {
        repository: values.get("--repository"), commit: values.get("--commit"),
        archivePath: values.get("--archive"), manifestPath: values.get("--manifest"),
        archiveBlob: values.get("--archive-blob"),
    };
}

export async function main(argv = process.argv.slice(2)) {
    const result = await createCorpusSnapshot(parseArgs(argv));
    process.stdout.write(`${canonicalJson(result.manifest)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
