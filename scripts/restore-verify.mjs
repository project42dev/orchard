#!/usr/bin/env node
// T20. Both state accounts carry versioning, immutability, and a 90 day
// retention claim, and the backup account is GRS. None of that means
// anything until a backup has actually been pulled back down and opened. A
// backup that has never been restored is a hypothesis.
//
// This reads the latest committed generation for one track straight out of
// the backup container's own commit-marker protocol (the same one
// BlobStateAdapter#replicateBackup writes), verifies the downloaded bytes
// against the digest the commit marker names, opens the result with the
// same openStateStore every production script uses, and reports what a real
// track run would see: total item count and the state distribution. It
// writes nothing back anywhere; the scratch copy is deleted before this
// exits either way.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { openStateStore } from "./lib/state-store.mjs";
import { LIFECYCLE_STATES } from "./lib/state-machine.mjs";

const SHA = /^sha256:[a-f0-9]{64}$/;

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

function requireTrack(track) {
    if (track !== "track-1" && track !== "track-2") throw new Error("restore-verify requires --track track-1 or --track track-2");
    return track;
}

function required(env, name) {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

/**
 * The latest committed backup generation for a track, read from its own
 * commit marker rather than trusted from a blob-name sort: the marker is
 * the same document BlobStateAdapter#replicateBackup writes only after the
 * backup bytes round-tripped and rehashed correctly at write time.
 */
export async function latestBackupCommit({ backupContainerClient, prefix, scope }) {
    const commitPrefix = `${prefix}/${scope}/backup-commits/`;
    let latestName = null;
    for await (const item of backupContainerClient.listBlobsFlat({ prefix: commitPrefix })) {
        if (latestName === null || item.name > latestName) latestName = item.name;
    }
    if (!latestName) return null;
    const payload = await backupContainerClient.getBlobClient(latestName).downloadToBuffer();
    const commit = JSON.parse(payload.toString("utf8"));
    if (commit.scope !== scope || !SHA.test(commit.stateDigest ?? "")
        || typeof commit.backupBlob !== "string" || !commit.backupBlob.startsWith(`${prefix}/${scope}/backups/`) || commit.backupBlob.includes("..")) {
        throw new Error(`backup commit marker ${latestName} is malformed`);
    }
    return { commitName: latestName, ...commit };
}

/** Downloads the backup blob a commit marker names and verifies its digest before anything opens it. */
export async function downloadVerifiedBackup({ backupContainerClient, commit, destination, maxBytes = 536_870_912 }) {
    const blob = backupContainerClient.getBlobClient(commit.backupBlob);
    const properties = await blob.getProperties();
    if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength < 1 || properties.contentLength > maxBytes) {
        throw new Error(`backup ${commit.backupBlob} exceeds the configured size bound`);
    }
    const payload = await blob.downloadToBuffer();
    if (payload.byteLength !== properties.contentLength) throw new Error(`backup ${commit.backupBlob} length changed during download`);
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    if (digest !== commit.stateDigest) throw new Error(`backup ${commit.backupBlob} digest mismatch: expected ${commit.stateDigest}, got ${digest}`);
    writeFileSync(destination, payload, { mode: 0o400 });
    return destination;
}

/** What a real track run would see: the restored file opens, migrates, and its state vocabulary is exactly T8's. */
export function verifyRestoredState({ store, track }) {
    const schemaRow = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item'").get();
    if (!schemaRow) throw new Error("restored database has no workflow_item table");
    for (const state of LIFECYCLE_STATES) {
        if (!schemaRow.sql.includes(`'${state}'`)) throw new Error(`restored database's CHECK constraint is missing lifecycle state '${state}'`);
    }
    const totalRow = store.db.prepare("SELECT COUNT(*) AS n FROM workflow_item WHERE track = ?").get(track);
    const byStateRows = store.db.prepare(
        "SELECT current_state, COUNT(*) AS n FROM workflow_item WHERE track = ? GROUP BY current_state ORDER BY current_state",
    ).all(track);
    return { total: totalRow.n, byState: Object.fromEntries(byStateRows.map((row) => [row.current_state, row.n])) };
}

export async function main(argv = process.argv.slice(2), {
    log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })),
    env = process.env,
    backupContainerClient = null,
} = {}) {
    const track = requireTrack(argOf(argv, "track"));
    const prefix = "orchard-state";
    const backup = backupContainerClient ?? new BlobServiceClient(
        required(env, "ORCHARD_BACKUP_ACCOUNT_URL"),
        new ManagedIdentityCredential(required(env, "AZURE_CLIENT_ID")),
    ).getContainerClient(required(env, "ORCHARD_BACKUP_CONTAINER"));

    const commit = await latestBackupCommit({ backupContainerClient: backup, prefix, scope: track });
    if (!commit) {
        log("warn", "restore.verify.no-backup", { track, effect: "no backup commit marker exists yet for this track" });
        throw Object.assign(new Error(`no backup exists yet for ${track}`), { code: "ERR_ORCHARD_NO_BACKUP" });
    }
    log("info", "restore.verify.commit-found", { track, generation: commit.stateGeneration, backupBlob: commit.backupBlob });

    const scratchDir = mkdtempSync(join(tmpdir(), "orchard-restore-verify-"));
    const destination = join(scratchDir, "restored.sqlite");
    try {
        await downloadVerifiedBackup({ backupContainerClient: backup, commit, destination });
        log("info", "restore.verify.downloaded", { track, destination, generation: commit.stateGeneration, digest: commit.stateDigest });

        const store = openStateStore(destination);
        try {
            const summary = verifyRestoredState({ store, track });
            log("info", "restore.verify.completed", { track, generation: commit.stateGeneration, backupBlob: commit.backupBlob, ...summary });
            return summary;
        } finally {
            store.close();
        }
    } finally {
        rmSync(scratchDir, { recursive: true, force: true });
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
