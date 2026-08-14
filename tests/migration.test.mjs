import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildContentDb } from "../scripts/build-content-db.mjs";
import {
    CURRENT_SCHEMA_VERSION,
    createVerifiedBackup,
    migrateContentDb,
    restoreContentDb,
    verifyContentDb
} from "../scripts/migrate-content-db.mjs";

function temporary(t) {
    const root = mkdtempSync(join(tmpdir(), "orchard-migration-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function legacyDatabase(path) {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE legacy_authority (id TEXT PRIMARY KEY, decision TEXT NOT NULL); INSERT INTO legacy_authority VALUES ('one', 'keep');");
    db.close();
}

test("fresh migration is transactional, versioned, verified, and replay-safe", (t) => {
    const path = join(temporary(t), "fresh.db");
    const first = migrateContentDb(path);
    assert.equal(first.toVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(first.noOp, false);
    assert.equal(first.backup, null);
    assert.equal(first.verification.ok, true);

    const replay = migrateContentDb(path);
    assert.equal(replay.noOp, true);
    assert.deepEqual(replay.applied, []);
    assert.equal(replay.backup, null);

    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 4);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_transaction'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_packet'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_acceptance'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_decision_authority'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_owner_authority'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'protected_trust_anchor'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_authority'").get());
    db.close();
});

test("legacy upgrade creates a verified unique backup and preserves existing authority", (t) => {
    const root = temporary(t);
    const path = join(root, "legacy.db");
    legacyDatabase(path);

    const result = migrateContentDb(path, { backupDirectory: join(root, "backups"), now: "2026-08-12T10:00:00Z" });
    assert.ok(result.backup);
    assert.equal(existsSync(result.backup.backupPath), true);
    assert.equal(result.backup.integrityResult, "ok");
    const db = new DatabaseSync(path);
    const preserved = db.prepare("SELECT * FROM legacy_authority").get();
    assert.equal(preserved.id, "one");
    assert.equal(preserved.decision, "keep");
    assert.equal(db.prepare("SELECT count(*) AS n FROM verified_backup").get().n, 1);
    db.close();
});

test("backup allocation never overwrites, verifies checksums, and restores", (t) => {
    const root = temporary(t);
    const path = join(root, "source.db");
    legacyDatabase(path);
    const options = { backupDirectory: join(root, "backups"), now: "2026-08-12T10:00:00Z" };
    const first = createVerifiedBackup(path, options);
    const second = createVerifiedBackup(path, options);
    assert.notEqual(first.backupPath, second.backupPath);
    assert.equal(first.sha256, second.sha256);

    const restored = join(root, "restored.db");
    const result = restoreContentDb(first.backupPath, restored, { expectedSha256: first.sha256 });
    assert.equal(result.verified, true);
    assert.equal(verifyContentDb(restored).ok, true);
    const replacement = restoreContentDb(second.backupPath, restored, { expectedSha256: second.sha256, overwrite: true });
    assert.equal(replacement.verified, true);
    assert.equal(existsSync(replacement.rollbackPath), true);
    assert.match(replacement.rollbackSha256, /^[a-f0-9]{64}$/);
    assert.equal(verifyContentDb(replacement.rollbackPath).ok, true);
});

test("derived rebuild preserves authoritative workflow rows", (t) => {
    const root = temporary(t);
    const dbPath = join(root, "content.db");
    const content = join(root, "content");
    mkdirSync(join(content, "modules"), { recursive: true });
    mkdirSync(join(content, "resources"), { recursive: true });
    writeFileSync(join(content, "source-registry.json"), "{\"sources\":[]}");
    writeFileSync(join(content, "opportunity-registry.json"), "{\"opportunities\":[]}");
    migrateContentDb(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO workflow_run
        (run_id, track, trigger_type, scope_mode, status, manifest_digest, idempotency_key,
         started_at, record_json, created_at) VALUES (?, 'track-1', 'manual', 'subset', 'created', ?, ?, ?, ?, ?)`)
        .run("018f0000-0000-7000-8000-000000000001", `sha256:${"a".repeat(64)}`, "run:preserve",
            "2026-08-12T10:00:00Z", "{\"preserved\":true}", "2026-08-12T10:00:00Z");
    db.close();

    buildContentDb({ contentRoot: content, dbPath, surfaces: [] });
    buildContentDb({ contentRoot: content, dbPath, surfaces: [] });
    const rebuilt = new DatabaseSync(dbPath);
    assert.equal(rebuilt.prepare("SELECT count(*) AS n FROM workflow_run WHERE idempotency_key = 'run:preserve'").get().n, 1);
    rebuilt.close();
});

test("integrity verification reports foreign-key violations", (t) => {
    const path = join(temporary(t), "broken.db");
    migrateContentDb(path);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(`INSERT INTO run_coverage (run_id, metric, value) VALUES ('missing-run', 'attempted', 1)`).run();
    db.close();
    const verification = verifyContentDb(path);
    assert.equal(verification.ok, false);
    assert.equal(verification.foreignKeys.length, 1);
});
