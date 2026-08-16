#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, constants as fsConstants } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIRECTORY = resolve(HERE, "..", "schema", "migrations");
export const CURRENT_SCHEMA_VERSION = 7;
const MIGRATIONS = Object.freeze([
    { version: 2, name: "002-two-track-authority", file: "002-two-track-authority.sql" },
    { version: 3, name: "003-closure-evidence", file: "003-closure-evidence.sql" },
    { version: 4, name: "004-protected-authority-evidence", file: "004-protected-authority-evidence.sql" },
    { version: 5, name: "005-protected-trust-anchors", file: "005-protected-trust-anchors.sql" },
    { version: 6, name: "006-live-item-uniqueness", file: "006-live-item-uniqueness.sql" },
    { version: 7, name: "007-workflow-item-state-check", file: "007-workflow-item-state-check.sql" }
]);

function nowIso(now) {
    return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function configure(db) {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
}

function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function verifyContentDb(dbOrPath) {
    const owns = typeof dbOrPath === "string";
    const db = owns ? new DatabaseSync(dbOrPath, { readOnly: true }) : dbOrPath;
    try {
        configure(db);
        const integrityRows = db.prepare("PRAGMA integrity_check").all();
        const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
        const integrity = integrityRows.map((row) => String(Object.values(row)[0]));
        return {
            ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0,
            integrity,
            foreignKeys
        };
    } finally {
        if (owns) db.close();
    }
}

function uniqueBackupPath(dbPath, backupDirectory, timestamp) {
    mkdirSync(backupDirectory, { recursive: true });
    const stamp = timestamp.replaceAll(":", "-");
    const base = `${basename(dbPath)}.${stamp}.pre-migration`;
    for (let sequence = 0; sequence < 10_000; sequence += 1) {
        const suffix = sequence === 0 ? "" : `.${sequence}`;
        const candidate = join(backupDirectory, `${base}${suffix}.bak`);
        if (!existsSync(candidate)) return candidate;
    }
    throw new Error("unable to allocate a unique backup path");
}

export function createVerifiedBackup(dbPath, options = {}) {
    const source = resolve(dbPath);
    if (!existsSync(source)) throw new Error(`database does not exist: ${source}`);
    const timestamp = nowIso(options.now);
    const backupDirectory = resolve(options.backupDirectory ?? join(dirname(source), "backups"));
    const destination = uniqueBackupPath(source, backupDirectory, timestamp);

    let db;
    try {
        db = new DatabaseSync(source);
        configure(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        db = undefined;
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
        const verification = verifyContentDb(destination);
        if (!verification.ok) throw new Error(`backup verification failed: ${JSON.stringify(verification)}`);
        const sourceSize = statSync(source).size;
        const backupSize = statSync(destination).size;
        const sourceHash = sha256File(source);
        const backupHash = sha256File(destination);
        if (sourceSize !== backupSize || sourceHash !== backupHash) throw new Error("backup differs from checkpointed source database");
        return {
            backupId: randomUUID(),
            sourcePath: source,
            backupPath: destination,
            sourceSize,
            backupSize,
            sha256: backupHash,
            integrityResult: "ok",
            foreignKeyViolations: 0,
            createdAt: timestamp,
            verifiedAt: timestamp
        };
    } catch (error) {
        if (db) db.close();
        if (existsSync(destination)) unlinkSync(destination);
        throw error;
    }
}

export function restoreContentDb(backupPath, dbPath, options = {}) {
    const source = resolve(backupPath);
    const destination = resolve(dbPath);
    if (!existsSync(source)) throw new Error(`backup does not exist: ${source}`);
    const verification = verifyContentDb(source);
    if (!verification.ok) throw new Error(`backup is not restorable: ${JSON.stringify(verification)}`);
    if (options.expectedSha256 && sha256File(source) !== options.expectedSha256) throw new Error("backup checksum does not match expected checksum");
    if (existsSync(destination) && !options.overwrite) throw new Error(`restore target already exists: ${destination}`);

    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.restore-${randomUUID()}.tmp`;
    const rollbackPath = existsSync(destination) ? `${destination}.rollback-${randomUUID()}.bak` : null;
    let destinationMoved = false;
    try {
        copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
        const restoredVerification = verifyContentDb(temporary);
        if (!restoredVerification.ok || sha256File(temporary) !== sha256File(source)) throw new Error("restored copy verification failed");
        // Both moves occur in the destination directory and therefore on one
        // volume. The prior database is never deleted: it becomes durable
        // rollback evidence before the verified replacement is installed.
        if (rollbackPath) {
            renameSync(destination, rollbackPath);
            destinationMoved = true;
        }
        renameSync(temporary, destination);
        const installedVerification = verifyContentDb(destination);
        if (!installedVerification.ok || sha256File(destination) !== sha256File(source)) {
            throw new Error("installed restore verification failed");
        }
        return {
            backupPath: source, dbPath: destination, sha256: sha256File(destination), verified: true,
            rollbackPath, rollbackSha256: rollbackPath ? sha256File(rollbackPath) : null
        };
    } catch (error) {
        if (destinationMoved && rollbackPath && existsSync(rollbackPath)) {
            if (existsSync(destination)) {
                const failedInstall = `${destination}.failed-${randomUUID()}.bak`;
                renameSync(destination, failedInstall);
            }
            renameSync(rollbackPath, destination);
        }
        throw error;
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

function appliedMigrations(db) {
    if (!tableExists(db, "schema_migration")) return [];
    return db.prepare("SELECT version, name, checksum FROM schema_migration ORDER BY version").all();
}

function recordBackup(db, backup) {
    db.prepare(`INSERT INTO verified_backup
        (backup_id, source_path, backup_path, source_size, backup_size, sha256,
         integrity_result, foreign_key_violations, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        backup.backupId, backup.sourcePath, backup.backupPath, backup.sourceSize,
        backup.backupSize, backup.sha256, backup.integrityResult,
        backup.foreignKeyViolations, backup.createdAt, backup.verifiedAt
    );
}

export function migrateContentDb(dbPath, options = {}) {
    const path = resolve(dbPath);
    const existed = existsSync(path) && statSync(path).size > 0;
    mkdirSync(dirname(path), { recursive: true });

    let db = new DatabaseSync(path);
    configure(db);
    const knownByVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
    const applied = appliedMigrations(db);
    for (const row of applied) {
        const known = knownByVersion.get(Number(row.version));
        if (!known) {
            db.close();
            throw new Error(`database schema version ${row.version} is newer than this program supports (${CURRENT_SCHEMA_VERSION})`);
        }
        const sql = readFileSync(join(MIGRATIONS_DIRECTORY, known.file), "utf8");
        if (row.name !== known.name || row.checksum !== sha256Text(sql)) {
            db.close();
            throw new Error(`applied migration ${row.version} does not match the vendored migration`);
        }
    }

    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    const pending = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));
    if (pending.length === 0) {
        const verification = verifyContentDb(db);
        db.close();
        if (!verification.ok) throw new Error(`database verification failed: ${JSON.stringify(verification)}`);
        return { dbPath: path, fromVersion: CURRENT_SCHEMA_VERSION, toVersion: CURRENT_SCHEMA_VERSION, applied: [], backup: null, noOp: true, verification };
    }

    const fromVersion = applied.length === 0 ? 0 : Math.max(...applied.map((row) => Number(row.version)));
    db.close();
    const backup = existed ? createVerifiedBackup(path, options) : null;
    db = new DatabaseSync(path);
    configure(db);
    // Migrations 006 and 007 rebuild workflow_item (006 drops a table-level
    // UNIQUE constraint, 007 adds the current_state CHECK constraint), and
    // SQLite's documented rebuild procedure requires foreign
    // key enforcement to be off while the old table is dropped and the
    // rebuilt one takes its name. The pragma is a no-op inside a transaction,
    // so it is set here, before BEGIN. Safety is not lost: enforcement is
    // restored right after COMMIT, and verifyContentDb below runs a full
    // foreign_key_check over the whole database and this function throws if
    // it reports a single violation.
    db.exec("PRAGMA foreign_keys = OFF");
    const applicationId = randomUUID();
    try {
        db.exec("BEGIN IMMEDIATE");
        for (const migration of pending) {
            const sql = readFileSync(join(MIGRATIONS_DIRECTORY, migration.file), "utf8");
            db.exec(sql);
            db.prepare("INSERT INTO schema_migration (version, name, checksum, applied_at, application_id) VALUES (?, ?, ?, ?, ?)")
                .run(migration.version, migration.name, sha256Text(sql), nowIso(options.now), applicationId);
        }
        if (backup) recordBackup(db, backup);
        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
        db.close();
        throw error;
    }
    db.exec("PRAGMA foreign_keys = ON");

    const verification = verifyContentDb(db);
    db.close();
    if (!verification.ok) throw new Error(`post-migration database verification failed: ${JSON.stringify(verification)}`);
    return { dbPath: path, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, applied: pending.map(({ version, name }) => ({ version, name })), backup, noOp: false, verification };
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (!value.startsWith("--")) continue;
        const key = value.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) args[key] = true;
        else { args[key] = next; index += 1; }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db) {
        console.error("usage: migrate-content-db.mjs --db <content.db> [--backup-dir <dir>] | --restore <backup> --db <target.db> [--overwrite]");
        process.exitCode = 2;
        return;
    }
    if (args.restore) {
        console.log(JSON.stringify(restoreContentDb(args.restore, args.db, { overwrite: Boolean(args.overwrite) }), null, 2));
        return;
    }
    console.log(JSON.stringify(migrateContentDb(args.db, { backupDirectory: args["backup-dir"] }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
