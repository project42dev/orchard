#!/usr/bin/env node
// T8: the state vocabulary is a database constraint, not a convention.
//
// Before migration 007, workflow_item.current_state had no CHECK constraint
// and no documented vocabulary, so any typo written by any code path (a
// misspelled 'gate1-aproved', a casing slip) persisted silently as
// authoritative state and nothing ever caught it.
//
// These tests prove the fix from every direction: the database itself rejects
// any state outside the vocabulary, every state the machine defines is
// accepted, and the three places the vocabulary appears (LIFECYCLE_STATES in
// state-machine.mjs, the state enum in the state-transition contract, and the
// CHECK constraint in the vendored migration) are held in exact lockstep so
// none can drift from the others unnoticed.
//
// Every fixture is built through openStateStore / migrateContentDb on the
// real vendored schema. Direct UPDATEs of current_state are the whole point
// here: they simulate the buggy caller that bypasses the state machine, which
// is exactly the caller the constraint exists to stop.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { estate, candidate, seedGateItems, cleanupFixtures, NOW, runManifest } from './test-fixtures.mjs';
import { persistDiscoveryItems } from './lib/gate-queue.mjs';
import { LIFECYCLE_STATES } from './lib/state-machine.mjs';
import { loadSchema } from './lib/contracts.mjs';
import { openStateStore, StateStore } from './lib/state-store.mjs';
import { migrateContentDb, MIGRATIONS_DIRECTORY } from './migrate-content-db.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

const temporaries = [];

test('the database rejects any current_state outside the lifecycle vocabulary', async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ['vocab-subject']);

    // The typo class this constraint exists to stop: misspellings, casing
    // drift, invented states, and the empty string.
    for (const bogus of ['gate1-aproved', 'made-up-state', 'Gate1-Pending', 'GATE1-PENDING', '']) {
        assert.throws(
            () => store.db.prepare('UPDATE workflow_item SET current_state = ? WHERE item_id = ?').run(bogus, itemId),
            /CHECK constraint failed/i,
            `${JSON.stringify(bogus)} must be rejected by the database`,
        );
    }

    // A direct INSERT that bypasses the store entirely is caught too.
    assert.throws(
        () => store.db.prepare(`INSERT INTO workflow_item
            (item_id, origin_run_id, track, semantic_identity, surface, outcome,
             current_revision, current_state, created_at, updated_at)
            VALUES (?, ?, 'track-1', 'bogus-subject', 'learning', 'new-module', 1, 'gate1-aproved', ?, ?)`)
            .run(generateUuidV7(), runId, NOW, NOW),
        /CHECK constraint failed/i,
        'an insert with a bogus state must be rejected by the database',
    );

    const row = store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId);
    assert.equal(row.current_state, 'gate1-pending', 'the failed writes must leave the row untouched');
});

test('every state the machine defines is accepted by the constraint', async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ['walkable-subject']);
    for (const state of LIFECYCLE_STATES) {
        store.db.prepare('UPDATE workflow_item SET current_state = ? WHERE item_id = ?').run(state, itemId);
        assert.equal(
            store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state,
            state,
        );
    }
    assert.equal(LIFECYCLE_STATES.length, 22, 'the machine defines exactly 22 states');
});

test('the CHECK constraint, the contract enum, and the state machine share one vocabulary', async () => {
    const { store } = await estate();
    const table = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item'").get();
    const match = table.sql.match(/current_state IN \(([^)]+)\)/);
    assert.ok(match, 'workflow_item must carry the current_state CHECK constraint');
    const constrained = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    assert.deepEqual(
        [...constrained].sort(), [...LIFECYCLE_STATES].sort(),
        'the database CHECK constraint must match LIFECYCLE_STATES exactly',
    );

    const schema = await loadSchema('state-transition');
    assert.deepEqual(
        [...schema.$defs.state.enum].sort(), [...LIFECYCLE_STATES].sort(),
        'the state-transition contract enum must match LIFECYCLE_STATES exactly',
    );
});

test('a version 6 database migrates in place: rows carry over, the live-item index survives, invalid states are rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-vocab-upgrade-'));
    temporaries.push(directory);
    const dbPath = join(directory, 'state.db');

    // Build the exact version 6 schema from the vendored migration files,
    // recorded in schema_migration precisely as the runner records them, so
    // the runner recognises this database as a genuine version 6 estate and
    // applies only migration 007. Foreign key enforcement is off while the
    // files apply because migration 006 is a table rebuild, mirroring how the
    // runner itself applies it.
    const V6 = [
        [2, '002-two-track-authority', '002-two-track-authority.sql'],
        [3, '003-closure-evidence', '003-closure-evidence.sql'],
        [4, '004-protected-authority-evidence', '004-protected-authority-evidence.sql'],
        [5, '005-protected-trust-anchors', '005-protected-trust-anchors.sql'],
        [6, '006-live-item-uniqueness', '006-live-item-uniqueness.sql'],
    ];
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
    for (const [version, name, file] of V6) {
        const sql = readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8');
        db.exec(sql);
        db.prepare('INSERT INTO schema_migration (version, name, checksum, applied_at, application_id) VALUES (?, ?, ?, ?, ?)')
            .run(version, name, `sha256:${createHash('sha256').update(sql).digest('hex')}`, NOW, randomUUID());
    }
    db.exec('PRAGMA foreign_keys = ON');

    // Populate through the store's own API against the open handle.
    const v6store = new StateStore(db);
    const runId = generateUuidV7();
    await v6store.recordRun(runManifest(runId));
    const seeded = await persistDiscoveryItems({ store: v6store, runId, candidates: [candidate('upgraded-vocab-subject')], now: NOW });
    assert.equal(seeded.persisted, 1);
    const itemId = seeded.items[0].item_id;
    v6store.close();
    db.close();

    const outcome = migrateContentDb(dbPath);
    assert.deepEqual(outcome.applied, [{ version: 7, name: '007-workflow-item-state-check' }]);
    assert.ok(outcome.verification.ok, `post-migration verification: ${JSON.stringify(outcome.verification)}`);

    const store = openStateStore(dbPath);
    try {
        const row = store.db.prepare('SELECT item_id, current_state FROM workflow_item').get();
        assert.equal(row.item_id, itemId, 'the rebuild must carry every row across');
        assert.equal(row.current_state, 'gate1-pending');

        // T17's partial unique index must survive the 007 rebuild.
        const index = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_workflow_item_one_live_per_subject'").get();
        assert.ok(index, 'the one-live-item-per-subject index must survive the rebuild');
        assert.match(index.sql, /current_state <> 'closed'/, 'the index must keep its partial WHERE clause');

        assert.throws(
            () => store.db.prepare('UPDATE workflow_item SET current_state = ? WHERE item_id = ?').run('made-up-state', itemId),
            /CHECK constraint failed/i,
            'after the upgrade an invalid state is rejected',
        );
        assert.ok(store.verify().ok);
    } finally {
        store.close();
    }
});

test.after(() => {
    cleanupFixtures();
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
});
