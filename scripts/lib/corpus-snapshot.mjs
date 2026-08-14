import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { t, x } from "tar";
import { canonicalJson, sha256Digest } from "./identity.mjs";

const MANIFEST_NAME = ".orchard-corpus-manifest.json";
const SHA = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function contentFiles(root) {
    const base = join(root, "content");
    const files = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const info = statSync(path);
            if (info.isDirectory()) walk(path);
            else if (info.isFile()) files.push(path);
            else throw new Error(`canonical content contains a non-file entry: ${relative(root, path)}`);
        }
    };
    walk(base);
    return files;
}

export function corpusContentDigest(root) {
    const normalized = resolve(root);
    return sha256Digest(contentFiles(normalized).map((path) => ({
        path: relative(normalized, path).split(sep).join("/"),
        digest: sha256Digest(readFileSync(path)),
    })));
}

export function verifyCorpusSnapshot(root, expectedCommit) {
    const normalized = resolve(root);
    const manifest = JSON.parse(readFileSync(join(normalized, MANIFEST_NAME), "utf8"));
    if (!COMMIT.test(manifest.commit ?? "") || manifest.commit !== expectedCommit) throw new Error(`corpus snapshot is not pinned to ${expectedCommit}`);
    if (!SHA.test(manifest.contentDigest ?? "")) throw new Error("corpus snapshot has no valid content digest");
    const actual = corpusContentDigest(normalized);
    if (actual !== manifest.contentDigest) throw new Error("corpus snapshot content digest mismatch");
    return Object.freeze(manifest);
}

async function fileDigest(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
}

export function validateCorpusArchiveEntry(entry, state, maxExtractedBytes) {
    if (!["File", "Directory"].includes(entry.type)) throw new Error(`corpus archive contains prohibited ${entry.type} entry`);
    if (typeof entry.path !== "string") throw new Error("corpus archive contains an unsafe path");
    const normalizedPath = entry.path.replace(/\/+$/g, "");
    const parts = normalizedPath.split("/");
    if (!normalizedPath || normalizedPath.startsWith("/") || /^[A-Za-z]:/.test(normalizedPath) || normalizedPath.includes("\\") || parts.some((part) => !part || part === "." || part === "..")) throw new Error("corpus archive contains an unsafe path");
    if (state.archiveRoot === null) state.archiveRoot = parts[0];
    if (parts[0] !== state.archiveRoot || (entry.type === "File" && parts.length < 2)) throw new Error("corpus archive does not have one protected top-level root");
    state.entryCount += 1;
    if (state.entryCount > 100_000) throw new Error("corpus archive exceeds the entry-count bound");
    if (entry.type === "File" && (!Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error("corpus archive contains an invalid entry size");
    state.extractedBytes += entry.type === "File" ? entry.size : 0;
    if (!Number.isSafeInteger(state.extractedBytes) || state.extractedBytes > maxExtractedBytes) throw new Error("corpus archive exceeds the extracted-size bound");
}

export async function materializeCorpusSnapshot({ containerClient, archiveBlob, manifestBlob, expectedCommit, destination, maxArchiveBytes = 268_435_456 }) {
    if (!COMMIT.test(expectedCommit ?? "")) throw new TypeError("expectedCommit must be a full lowercase Git commit");
    if (!containerClient || typeof containerClient.getBlobClient !== "function") throw new TypeError("containerClient is required");
    const manifestDownload = await containerClient.getBlobClient(manifestBlob).download();
    const manifest = JSON.parse(await streamToString(manifestDownload.readableStreamBody, 65_536));
    if (manifest.schemaVersion !== 1 || manifest.commit !== expectedCommit || manifest.archiveBlob !== archiveBlob || !SHA.test(manifest.archiveDigest ?? "") || !SHA.test(manifest.contentDigest ?? "")) throw new Error("corpus manifest binding is invalid");
    const root = resolve(destination);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const archiveDirectory = mkdtempSync(join(tmpdir(), "orchard-corpus-"));
    const archivePath = join(archiveDirectory, "snapshot.tgz");
    try {
        const blob = containerClient.getBlobClient(archiveBlob);
        const properties = await blob.getProperties();
        if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength < 1 || properties.contentLength > maxArchiveBytes) throw new Error("corpus archive exceeds the configured size bound");
        await blob.downloadToFile(archivePath);
        if (await fileDigest(archivePath) !== manifest.archiveDigest) throw new Error("corpus archive digest mismatch");
        const archiveState = { extractedBytes: 0, entryCount: 0, archiveRoot: null };
        await t({
            file: archivePath, strict: true, onentry(entry) {
                validateCorpusArchiveEntry(entry, archiveState, maxArchiveBytes * 4);
            }
        });
        if (await fileDigest(archivePath) !== manifest.archiveDigest) throw new Error("corpus archive changed after validation");
        await x({ file: archivePath, cwd: root, strip: 1, strict: true, preservePaths: false, filter: (_path, entry) => ["File", "Directory"].includes(entry.type) });
        writeFileSync(join(root, MANIFEST_NAME), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o400 });
        verifyCorpusSnapshot(root, expectedCommit);
        return root;
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    } finally {
        rmSync(archiveDirectory, { recursive: true, force: true });
    }
}

async function streamToString(stream, maxBytes) {
    if (!stream) throw new Error("blob download returned no readable body");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error("corpus manifest exceeds the configured size bound");
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
