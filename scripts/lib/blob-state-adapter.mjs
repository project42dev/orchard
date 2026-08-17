import { randomUUID, createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SHA = /^sha256:[a-f0-9]{64}$/;

async function sha256File(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
}

async function bodyToString(response, maxBytes = 65_536) {
    if (!response.readableStreamBody) throw new Error("blob download returned no readable body");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.readableStreamBody) {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error("state manifest exceeds the configured size bound");
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function safeScope(scope) {
    if (typeof scope !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(scope)) throw new TypeError("state scope must be a lowercase slug");
    return scope;
}

function validateManifest(manifest, scope, prefix) {
    if (!manifest || manifest.schemaVersion !== 1 || manifest.scope !== scope
        || !Number.isSafeInteger(manifest.fencingGeneration) || manifest.fencingGeneration < 0
        || !Number.isSafeInteger(manifest.stateGeneration) || manifest.stateGeneration < 0) {
        throw new Error("state manifest structure is invalid");
    }
    if (manifest.stateBlob === null && manifest.stateDigest === null) return manifest;
    const expectedPrefix = `${prefix}/${scope}/generations/`;
    if (typeof manifest.stateBlob !== "string" || !manifest.stateBlob.startsWith(expectedPrefix) || manifest.stateBlob.includes("..") || !SHA.test(manifest.stateDigest ?? "")) {
        throw new Error("state manifest generation binding is invalid");
    }
    if (manifest.backupBlob !== undefined && (typeof manifest.backupBlob !== "string" || !manifest.backupBlob.startsWith(`${prefix}/${scope}/backups/`) || manifest.backupBlob.includes(".."))) throw new Error("state manifest backup binding is invalid");
    return manifest;
}

export class BlobStateAdapter {
    constructor({ containerClient, backupContainerClient, workRoot = tmpdir(), prefix = "orchard-state", maxStateBytes = 536_870_912 }) {
        if (!containerClient || !backupContainerClient) throw new TypeError("primary and backup container clients are required");
        if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1) throw new TypeError("maxStateBytes must be a positive safe integer");
        this.container = containerClient;
        this.backup = backupContainerClient;
        this.workRoot = resolve(workRoot);
        this.prefix = prefix.replace(/^\/+|\/+$/g, "");
        this.maxStateBytes = maxStateBytes;
    }

    async acquire(scope, owner) {
        scope = safeScope(scope);
        if (typeof owner !== "string" || owner.length < 1) throw new TypeError("owner is required");
        const lock = this.container.getBlockBlobClient(`${this.prefix}/${scope}/coordination.lock`);
        await lock.upload("orchard", 7, { conditions: { ifNoneMatch: "*" } }).catch((error) => {
            if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
        });
        const lease = lock.getBlobLeaseClient(randomUUID());
        await lease.acquireLease(60);
        try {
            const current = await this.#readManifest(scope);
            // Backfill a missing marker for whatever was last actually published
            // (recovers a run that crashed between replicateBackup's manifest
            // write and its own commit-marker write). Checked for existence
            // FIRST, not written unconditionally: a prior acquire that itself
            // crashed before publishing anything new still bumps
            // fencingGeneration on the very manifest we are reading right now,
            // so an unconditional re-write here would race the marker's own
            // strict field comparison against fencingGeneration values that
            // were never actually published under, throwing a false conflict
            // for content nothing is really wrong with. Existence is checked
            // by commitGeneration+digest, the identity that reflects what was
            // truly published, not the fencing token of whichever acquire
            // happens to run this backfill.
            if (current.manifest?.backupBlob) {
                const alreadyRecorded = await this.backup.getBlockBlobClient(this.#commitMarkerName(current.manifest)).exists();
                if (!alreadyRecorded) await this.#writeCommitMarker(current.manifest, current.etag);
            }
            const manifest = current.manifest ?? { schemaVersion: 1, scope, fencingGeneration: 0, stateGeneration: 0, stateBlob: null, stateDigest: null };
            manifest.fencingGeneration += 1;
            manifest.owner = owner;
            manifest.acquiredAt = new Date().toISOString();
            const updated = await this.#writeManifest(scope, manifest, current.etag);
            return { scope, owner, lease, leaseId: lease.leaseId, manifest, manifestEtag: updated.etag };
        } catch (error) {
            await lease.releaseLease().catch(() => { });
            throw error;
        }
    }

    async renew(handle) { await handle.lease.renewLease(); }
    async release(handle) { await handle.lease.releaseLease(); }

    async assertCurrent(handle) {
        await handle.lease.renewLease();
        const current = await this.#readManifest(handle.scope);
        if (current.manifest?.fencingGeneration !== handle.manifest.fencingGeneration || current.manifest?.owner !== handle.owner) throw new Error("state fencing generation is stale");
        handle.manifestEtag = current.etag;
    }

    async readState(handle) {
        const { manifest } = handle;
        const directory = join(this.workRoot, `orchard-${handle.scope}-${manifest.fencingGeneration}`);
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory, { recursive: true });
        const path = join(directory, "state.sqlite");
        if (!manifest.stateBlob) return { path, exists: false, etag: handle.manifestEtag, manifest };
        if (!SHA.test(manifest.stateDigest ?? "")) throw new Error("state manifest contains an invalid digest");
        const blob = this.container.getBlobClient(manifest.stateBlob);
        const properties = await blob.getProperties();
        if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength < 1 || properties.contentLength > this.maxStateBytes) throw new Error("state generation exceeds the configured download size bound");
        await blob.downloadToFile(path);
        if (statSync(path).size !== properties.contentLength) throw new Error("state generation length changed during download");
        if (await sha256File(path) !== manifest.stateDigest) throw new Error("downloaded SQLite generation failed checksum validation");
        return { path, exists: true, etag: handle.manifestEtag, manifest };
    }

    async publishState(handle, statePath, prior) {
        const stateInfo = statSync(statePath, { throwIfNoEntry: false });
        if (!stateInfo?.isFile()) throw new Error("state database is missing at publication");
        if (stateInfo.size < 1 || stateInfo.size > this.maxStateBytes) throw new Error("state database exceeds the configured publication size bound");
        const digest = await sha256File(statePath);
        const generation = handle.manifest.stateGeneration + 1;
        const blobName = `${this.prefix}/${handle.scope}/generations/${String(generation).padStart(12, "0")}-${digest.slice(7)}.sqlite`;
        const blob = this.container.getBlockBlobClient(blobName);
        try {
            await blob.uploadFile(statePath, { conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/vnd.sqlite3" }, metadata: { sha256: digest.slice(7), fencinggeneration: String(handle.manifest.fencingGeneration) } });
        } catch (error) {
            if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
        }
        const properties = await blob.getProperties();
        if (properties.contentLength !== stateInfo.size || properties.metadata?.sha256 !== digest.slice(7) || properties.metadata?.fencinggeneration !== String(handle.manifest.fencingGeneration)) {
            throw new Error("uploaded SQLite generation did not reconcile to the intended immutable bytes");
        }
        const manifest = { ...handle.manifest, stateGeneration: generation, stateBlob: blobName, stateDigest: digest, publishedAt: new Date().toISOString() };
        return { scope: handle.scope, generation, blobName, digest, priorEtag: prior.etag, manifest };
    }

    async replicateBackup(handle, published) {
        const source = this.container.getBlobClient(published.blobName);
        const targetName = `${this.prefix}/${handle.scope}/backups/${String(published.generation).padStart(12, "0")}-${published.digest.slice(7)}.sqlite`;
        const target = this.backup.getBlockBlobClient(targetName);
        const sourceProperties = await source.getProperties();
        if (!Number.isSafeInteger(sourceProperties.contentLength) || sourceProperties.contentLength < 1 || sourceProperties.contentLength > this.maxStateBytes) throw new Error("published state exceeds the configured backup size bound");
        const payload = await source.downloadToBuffer();
        if (payload.byteLength !== sourceProperties.contentLength) throw new Error("published state length changed during backup download");
        const fencingGeneration = String(handle.manifest.fencingGeneration);
        try {
            await target.uploadData(payload, { conditions: { ifNoneMatch: "*" }, metadata: { sha256: published.digest.slice(7), sourcegeneration: String(published.generation), fencinggeneration: fencingGeneration } });
        } catch (error) {
            if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
        }
        const targetProperties = await target.getProperties();
        if (targetProperties.contentLength !== payload.byteLength || targetProperties.metadata?.sha256 !== published.digest.slice(7) || targetProperties.metadata?.sourcegeneration !== String(published.generation) || targetProperties.metadata?.fencinggeneration !== fencingGeneration) {
            throw new Error("backup generation did not reconcile to the intended immutable bytes");
        }
        const downloaded = await target.downloadToBuffer();
        const verified = `sha256:${createHash("sha256").update(downloaded).digest("hex")}`;
        if (verified !== published.digest) throw new Error("backup replication checksum mismatch");
        await this.assertCurrent(handle);
        const committedManifest = { ...published.manifest, backupBlob: targetName };
        const written = await this.#writeManifest(handle.scope, committedManifest, published.priorEtag);
        handle.manifest = committedManifest;
        handle.manifestEtag = written.etag;
        published.manifestEtag = written.etag;
        published.manifest = committedManifest;
        const commitName = await this.#writeCommitMarker(committedManifest, written.etag);
        return { blobName: targetName, digest: verified, manifestEtag: written.etag, commitMarker: commitName };
    }

    #commitMarkerName(manifest) {
        return `${this.prefix}/${manifest.scope}/backup-commits/${String(manifest.stateGeneration).padStart(12, "0")}-${manifest.stateDigest.slice(7)}.json`;
    }

    async #writeCommitMarker(manifest, manifestEtag) {
        const commit = {
            schemaVersion: 1,
            scope: manifest.scope,
            stateGeneration: manifest.stateGeneration,
            fencingGeneration: manifest.fencingGeneration,
            stateDigest: manifest.stateDigest,
            stateBlob: manifest.stateBlob,
            backupBlob: manifest.backupBlob,
            manifestEtag,
        };
        const commitPayload = `${JSON.stringify(commit)}\n`;
        const commitName = this.#commitMarkerName(manifest);
        const commitBlob = this.backup.getBlockBlobClient(commitName);
        try {
            await commitBlob.upload(commitPayload, Buffer.byteLength(commitPayload), { conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" } });
        } catch (error) {
            if (error.statusCode !== 409 && error.statusCode !== 412) throw error;
            const existing = await commitBlob.downloadToBuffer();
            const parsed = JSON.parse(existing.toString("utf8"));
            if (parsed.scope !== commit.scope || parsed.stateGeneration !== commit.stateGeneration || parsed.fencingGeneration !== commit.fencingGeneration || parsed.stateDigest !== commit.stateDigest || parsed.stateBlob !== commit.stateBlob || parsed.backupBlob !== commit.backupBlob) throw new Error("backup commit marker conflicts with the authoritative manifest");
        }
        return commitName;
    }

    async #readManifest(scope) {
        const blob = this.container.getBlobClient(`${this.prefix}/${scope}/manifest.json`);
        try {
            const properties = await blob.getProperties();
            const response = await blob.download();
            return { manifest: validateManifest(JSON.parse(await bodyToString(response)), scope, this.prefix), etag: properties.etag };
        } catch (error) {
            if (error.statusCode === 404) return { manifest: null, etag: null };
            throw error;
        }
    }

    async #writeManifest(scope, manifest, etag) {
        const blob = this.container.getBlockBlobClient(`${this.prefix}/${scope}/manifest.json`);
        const payload = `${JSON.stringify(manifest)}\n`;
        const conditions = etag ? { ifMatch: etag } : { ifNoneMatch: "*" };
        const response = await blob.upload(payload, Buffer.byteLength(payload), { conditions, blobHTTPHeaders: { blobContentType: "application/json" } });
        if (!response.etag) throw new Error("state manifest update returned no ETag");
        return response;
    }
}
