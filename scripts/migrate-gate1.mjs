#!/usr/bin/env node
// migrate-gate1.mjs - add the Gate 1 states to work_item.
//
// SQLite cannot alter a CHECK constraint, and work_item is authoritative and is
// never dropped by a build, so the table is rebuilt in place inside one
// transaction with every row preserved.
//
// What changes:
//   - state gains 'gate1-pending' and 'gate1-denied'
//   - the column default becomes 'gate1-pending'
//
// What does NOT change: existing rows keep their exact current state. An item
// already 'queued' stays authorable. This migration never moves work backwards
// and never resets a decision. Only NEW items land at 'gate1-pending'.
//
// Idempotent: running it twice is a no-op.

import { DatabaseSync } from "node:sqlite";

const NEW_STATES = "'gate1-pending','gate1-denied','queued','claimed','in-progress','blocked','done','rejected'";

export function needsMigration(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_item'")
    .get();
  if (!row) return false;
  return !String(row.sql).includes("gate1-pending");
}

export function migrate(db) {
  if (!needsMigration(db)) return { migrated: false, rows: 0 };

  const before = db.prepare("SELECT count(*) c FROM work_item").get().c;
  const cols = db.prepare("PRAGMA table_info(work_item)").all().map((c) => c.name);
  const colList = cols.map((c) => `"${c}"`).join(", ");

  // Views that reference work_item must be dropped and recreated around the
  // swap, otherwise the rename fails against the dependent view definition.
  const views = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='view' AND sql LIKE '%work_item%'")
    .all();

  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const v of views) db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
    db.exec(`
      CREATE TABLE work_item__gate1 (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('needs-creating', 'needs-updating')),
        subject_id   TEXT NOT NULL,
        surface      TEXT NOT NULL,
        title        TEXT NOT NULL,
        state        TEXT NOT NULL DEFAULT 'gate1-pending'
                     CHECK (state IN (${NEW_STATES})),
        priority     REAL,
        claimed_by   TEXT,
        claimed_at   TEXT,
        note         TEXT,
        first_seen   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        ado_id       TEXT,
        UNIQUE (kind, subject_id)
      )`);
    db.exec(`INSERT INTO work_item__gate1 (${colList}) SELECT ${colList} FROM work_item`);
    db.exec("DROP TABLE work_item");
    db.exec("ALTER TABLE work_item__gate1 RENAME TO work_item");
    for (const v of views) db.exec(v.sql);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("PRAGMA foreign_keys=ON");

  const after = db.prepare("SELECT count(*) c FROM work_item").get().c;
  if (after !== before) throw new Error(`row count changed: ${before} -> ${after}`);
  return { migrated: true, rows: after };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && process.argv[1].endsWith("migrate-gate1.mjs")) {
  const db = new DatabaseSync(arg("db", "content.db"));
  try {
    const r = migrate(db);
    const states = db.prepare("SELECT state, count(*) c FROM work_item GROUP BY state").all();
    process.stdout.write(JSON.stringify({ ...r, states }, null, 2) + "\n");
  } finally {
    db.close();
  }
}
