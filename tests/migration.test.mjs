import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildContentDb } from "../scripts/build-content-db.mjs";
import {
    CURRENT_SCHEMA_VERSION,
    MIGRATIONS_DIRECTORY,
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
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migration").get().n, 8);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_transaction'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_packet'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_acceptance'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_decision_authority'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closure_owner_authority'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'protected_trust_anchor'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_authority'").get());
    db.close();
});

test("009 rotates the gate trust anchor only, and the anchor stays immutable afterward", (t) => {
    const path = join(temporary(t), "rotate.db");

    // Build the exact version 8 schema, provisioning a gate anchor and a
    // publication anchor directly, the same way an administrator-provisioned
    // anchor would already exist on a live database before this release.
    const V8 = [
        "002-two-track-authority", "003-closure-evidence", "004-protected-authority-evidence",
        "005-protected-trust-anchors", "006-live-item-uniqueness", "007-workflow-item-state-check",
        "008-decision-event-per-item-uniqueness",
    ];
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;");
    for (const name of V8) {
        const sql = readFileSync(join(MIGRATIONS_DIRECTORY, `${name}.sql`), "utf8");
        db.exec(sql);
        db.prepare("INSERT INTO schema_migration (version, name, checksum, applied_at, application_id) VALUES (?, ?, ?, ?, ?)")
            .run(V8.indexOf(name) + 2, name, `sha256:${createHash("sha256").update(sql).digest("hex")}`, "2026-08-16T00:00:00Z", randomUUID());
    }
    db.exec("PRAGMA foreign_keys = ON");
    const anchor = (scope, digest) => JSON.stringify({ scope, adapter_identity: `test:${scope}:v1`, adapter_digest: digest, adapter_path: null, policy_digest: null, policy: null, provisioned_at: "2026-08-16T00:00:00Z" });
    db.prepare("INSERT INTO protected_trust_anchor (scope, adapter_identity, adapter_digest, adapter_path, policy_digest, policy_json, provisioned_at, record_json) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)")
        .run("gate", "test:gate:v1", `sha256:${"a".repeat(64)}`, "2026-08-16T00:00:00Z", anchor("gate", `sha256:${"a".repeat(64)}`));
    db.prepare("INSERT INTO protected_trust_anchor (scope, adapter_identity, adapter_digest, adapter_path, policy_digest, policy_json, provisioned_at, record_json) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)")
        .run("publication", "test:publication:v1", `sha256:${"b".repeat(64)}`, "2026-08-16T00:00:00Z", anchor("publication", `sha256:${"b".repeat(64)}`));
    // The database-level immutability trigger really does block a direct
    // delete before migration 009 runs, which is the whole point of it.
    assert.throws(() => db.exec("DELETE FROM protected_trust_anchor WHERE scope = 'gate'"), /immutable/);
    db.close();

    const outcome = migrateContentDb(path);
    assert.deepEqual(outcome.applied.map((m) => m.name), ["009-rotate-gate-trust-anchor"]);
    assert.ok(outcome.verification.ok, JSON.stringify(outcome.verification));

    const after = new DatabaseSync(path);
    assert.equal(after.prepare("SELECT * FROM protected_trust_anchor WHERE scope = 'gate'").get(), undefined,
        "the gate anchor must be gone so the next run re-provisions it against the new adapter digest");
    const publication = after.prepare("SELECT adapter_digest FROM protected_trust_anchor WHERE scope = 'publication'").get();
    assert.equal(publication.adapter_digest, `sha256:${"b".repeat(64)}`, "an adapter that did not change must keep its anchor");
    // The trigger must still be enforcing immutability after the migration
    // that used its own sanctioned bypass: this was a deliberate, versioned
    // exception, not a general-purpose door left open.
    assert.throws(() => after.exec("DELETE FROM protected_trust_anchor WHERE scope = 'publication'"), /immutable/);
    after.close();
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
