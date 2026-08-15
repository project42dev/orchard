#!/usr/bin/env node
// Put Track 1 and Track 2 input artifacts into the private artifacts container.
//
// WHY THIS EXISTS. Both storage accounts have publicNetworkAccess Disabled and
// allowSharedKeyAccess false. There is no bastion, no VPN gateway and no
// jumpbox, so nothing outside the virtual network can write a blob. The design
// said seeding was "an operator action through the private endpoint", which
// read as a procedure and was not one: no operator can reach that endpoint.
// The jobs therefore could not start, because Track 1 needs an approved source
// registry and Track 2 needs a corpus snapshot, and neither could be uploaded.
//
// The answer is not to open storage. An artifact bootstrap window that opened
// storage during a release, and left it open when the release failed, is the
// defect that was deliberately removed. This runs INSIDE the network instead,
// as a manually triggered Container Apps job on the same subnet, reaching the
// private endpoint through the private DNS zone that is already linked, using
// a managed identity scoped to the one container it writes.
//
// It is idempotent and it verifies. Every artifact carries a digest declared
// at release time; this checks the file it holds against that digest before
// uploading, skips anything already present and correct, and reads the blob
// back afterwards to prove what landed. Seeding that reports success without
// proving the bytes would be the same class of defect all over again.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { createStructuredLogger } from "./lib/structured-logger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = resolve(HERE, "..", "seed-inputs", "seed-manifest.json");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
// A blob name may not escape its container or carry surprises. Same rule the
// corpus snapshot tool applies to the names it writes.
const SAFE_BLOB = /^[A-Za-z0-9._/-]+$/;

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function digestOf(buffer) {
    return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function safeBlobName(value) {
    if (!SAFE_BLOB.test(value ?? "") || value.startsWith("/") || value.includes("\\")
        || value.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new TypeError(`unsafe blob name: ${value}`);
    }
    return value;
}

export function readSeedManifest(manifestPath) {
    if (!existsSync(manifestPath)) {
        throw new Error(
            `seed manifest not found at ${manifestPath}. The release stages seed inputs into the image; `
            + "an image without them cannot seed, and refusing here is better than writing nothing and reporting success.",
        );
    }
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (doc.schemaVersion !== 1) throw new TypeError("seed manifest schemaVersion must be 1");
    if (!Array.isArray(doc.artifacts) || doc.artifacts.length === 0) throw new TypeError("seed manifest lists no artifacts");
    const root = dirname(manifestPath);
    return doc.artifacts.map((artifact) => {
        if (!DIGEST.test(artifact.digest ?? "")) throw new TypeError(`artifact ${artifact.blobName} needs a sha256 digest`);
        if (isAbsolute(artifact.localPath ?? "")) throw new TypeError("artifact localPath must be relative to the manifest");
        const localPath = resolve(root, artifact.localPath);
        if (!localPath.startsWith(resolve(root))) throw new TypeError("artifact localPath must stay inside the seed inputs directory");
        return { blobName: safeBlobName(artifact.blobName), localPath, digest: artifact.digest };
    });
}

async function existingDigest(blobClient) {
    if (!(await blobClient.exists())) return null;
    return digestOf(await blobClient.downloadToBuffer());
}

export async function seedArtifact(container, artifact, log) {
    const payload = readFileSync(artifact.localPath);
    const actual = digestOf(payload);
    // The image is the source. If what it carries is not what the release
    // declared, the image is wrong and nothing should be written.
    if (actual !== artifact.digest) {
        throw new Error(`staged artifact ${artifact.blobName} has digest ${actual}, release declared ${artifact.digest}`);
    }

    const blobClient = container.getBlockBlobClient(artifact.blobName);
    const before = await existingDigest(blobClient);
    if (before === artifact.digest) {
        log("info", "seed.artifact.unchanged", { blobName: artifact.blobName, digest: artifact.digest, bytes: payload.byteLength });
        return { blobName: artifact.blobName, action: "unchanged", digest: artifact.digest, bytes: payload.byteLength };
    }
    if (before !== null) {
        log("warn", "seed.artifact.replacing", { blobName: artifact.blobName, existingDigest: before, digest: artifact.digest });
    }

    await blobClient.uploadData(payload, {
        blobHTTPHeaders: { blobContentType: artifact.blobName.endsWith(".json") ? "application/json" : "application/octet-stream" },
    });

    // Read it back. An upload that returns 201 has proved a request succeeded,
    // not that the right bytes are readable by the job that needs them.
    const after = await existingDigest(blobClient);
    if (after !== artifact.digest) {
        throw new Error(`artifact ${artifact.blobName} read back as ${after}, expected ${artifact.digest}`);
    }
    log("info", "seed.artifact.written", { blobName: artifact.blobName, digest: artifact.digest, bytes: payload.byteLength, replaced: before !== null });
    return { blobName: artifact.blobName, action: before === null ? "created" : "replaced", digest: artifact.digest, bytes: payload.byteLength };
}

export async function seedArtifacts({ container, artifacts, log }) {
    const results = [];
    for (const artifact of artifacts) results.push(await seedArtifact(container, artifact, log));
    return results;
}

async function main() {
    const log = createStructuredLogger({ base: { service: "orchard", track: "seed" } });
    log("info", "runtime.started", {});
    try {
        const manifestPath = process.env.ORCHARD_SEED_MANIFEST ?? DEFAULT_MANIFEST;
        const artifacts = readSeedManifest(manifestPath);
        const credential = new ManagedIdentityCredential(required("AZURE_CLIENT_ID"));
        const container = new BlobServiceClient(required("ORCHARD_STATE_ACCOUNT_URL"), credential)
            .getContainerClient(required("ORCHARD_ARTIFACT_CONTAINER"));
        log("info", "seed.starting", { manifestPath, artifactCount: artifacts.length });

        const results = await seedArtifacts({ container, artifacts, log });
        const written = results.filter((r) => r.action !== "unchanged").length;
        log("info", "seed.completed", {
            artifactCount: results.length,
            written,
            unchanged: results.length - written,
            totalBytes: results.reduce((sum, r) => sum + r.bytes, 0),
        });
        log("info", "runtime.completed", {});
    } catch (error) {
        process.exitCode = process.exitCode || 1;
        log("error", "runtime.failed", { error: { code: "ERR_ORCHARD_SEED_FAILED", name: error instanceof TypeError ? "TypeError" : "Error" } });
        // The message goes to stderr rather than the structured record, which
        // carries only a fixed code, because a message can quote a path or a
        // blob name and the structured stream feeds alert queries.
        process.stderr.write(`${error.message}\n`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
