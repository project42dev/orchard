#!/usr/bin/env node
// T17: the dedupe rule versus the currency loop.
//
// Before migration 006, workflow_item carried UNIQUE (track,
// semantic_identity) and the gate queue's lookup was state-blind, so a
// subject that had ever reached closed could never be proposed again. In a
// tool whose currency track exists to notice that published content has gone
// stale, that made the one thing the tool is for structurally impossible.
//
// These tests prove the corrected rule from both directions: a closed subject
// re-enters the lifecycle as a NEW item held at Gate 1, carrying its
// predecessor in supersedes_item_id, and a subject with ANY live item, in
// flight, denied, or published but not yet closed, is still deduped exactly
// as before. The closed predecessor itself is never touched.
//
// Every fixture is built through openStateStore / migrateContentDb on the
// real vendored schema. Direct UPDATEs of current_state appear only as
// stand-ins for recorded human decisions and the closure evidence chain, the
// same convention test-gate-queue.mjs already uses for denial.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { estate, candidate, seedGateItems, walkTo, cleanupFixtures, NOW, runManifest } from './test-fixtures.mjs';
import { persistDiscoveryItems, heldAtGate, findLiveItem, latestClosedItem } from './lib/gate-queue.mjs';
import { openStateStore, StateStore } from './lib/state-store.mjs';
import { migrateContentDb, MIGRATIONS_DIRECTORY } from './migrate-content-db.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

const temporaries = [];

/** Walk a seeded item to published, then stand in for the closure chain. */
async function closeItem(store, runId, itemId) {
    await walkTo(store, runId, itemId, 'published');
    // Stand-in for the closure evidence chain (closure packet, ADO Resolved
    // and Closed events, owner acceptance). What these tests exercise is the
    // dedupe rule's reading of the state the item ends in, not the closure
    // evidence requirements, which test-lifecycle covers.
    store.db.prepare("UPDATE workflow_item SET current_state = 'closed' WHERE item_id = ?").run(itemId);
}

test('a closed subject can be re-proposed and reaches Gate 1 again as a new item', async () => {
    const { store, runId } = await estate();
    const [firstId] = await seedGateItems(store, runId, ['stale-subject']);
    await closeItem(store, runId, firstId);
    const sid = candidate('stale-subject').semanticIdentity;

    assert.equal(findLiveItem(store.db, 'track-1', sid), null, 'a closed item must not occupy the subject');
    assert.equal(latestClosedItem(store.db, 'track-1', sid).item_id, firstId);

    const again = await persistDiscoveryItems({ store, runId, candidates: [candidate('stale-subject')], now: NOW });
    assert.equal(again.persisted, 1, 'the closed subject must be proposable again');
    assert.equal(again.skipped, 0);
    assert.equal(again.reproposed, 1);

    const held = heldAtGate(store.db, 'gate-1', 'track-1');
    assert.equal(held.length, 1, 'the re-proposal must be held at Gate 1 as live work');
    assert.notEqual(held[0].item_id, firstId, 'a re-proposal is a new item, not the closed one reopened');
    assert.ok(held[0].rationale.includes(firstId), 'the gate must say this supersedes a closed predecessor');

    const fresh = store.db.prepare('SELECT * FROM workflow_item WHERE item_id = ?').get(held[0].item_id);
    assert.equal(fresh.current_state, 'gate1-pending');
    assert.equal(Number(fresh.current_revision), 1, 'a re-proposal starts at revision 1 of its own item');
    assert.equal(fresh.supersedes_item_id, firstId, 'lineage lives on the new item');

    const transitions = store.listTransitions(held[0].item_id);
    assert.deepEqual(transitions.map((t) => [t.from_state, t.to_state]), [
        ['observed', 'proposed'], ['proposed', 'gate1-pending'],
    ], 'a re-proposal walks the lifecycle from the top like any other candidate');

    const old = store.db.prepare('SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?').get(firstId);
    assert.equal(old.current_state, 'closed', 'closed stays closed for the item that reached it');
    assert.equal(Number(old.current_revision), 1);
});

test('a subject with a live item is still deduped, at every stage before closed', async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ['live-subject']);

    // In flight at Gate 1.
    let again = await persistDiscoveryItems({ store, runId, candidates: [candidate('live-subject')], now: NOW });
    assert.equal(again.persisted, 0);
    assert.equal(again.skipped, 1);

    // Published but not yet closed: still live, still occupies the subject.
    await walkTo(store, runId, itemId, 'published');
    again = await persistDiscoveryItems({ store, runId, candidates: [candidate('live-subject')], now: NOW });
    assert.equal(again.persisted, 0);
    assert.equal(again.skipped, 1);
    assert.deepEqual(again.existing, [{ semanticIdentity: candidate('live-subject').semanticIdentity, state: 'published' }]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 1);
});

test('the re-proposal path creates no duplicate or orphaned rows', async () => {
    const { store, runId } = await estate();
    const [firstId] = await seedGateItems(store, runId, ['recycled-subject']);
    await closeItem(store, runId, firstId);
    await persistDiscoveryItems({ store, runId, candidates: [candidate('recycled-subject')], now: NOW });
    const sid = candidate('recycled-subject').semanticIdentity;

    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM item_revision').get().n, 2);
    assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM workflow_item WHERE semantic_identity = ? AND current_state <> 'closed'").get(sid).n,
        1, 'exactly one live item may occupy a subject',
    );

    // Idempotent: a third survey while the re-proposal is live adds nothing.
    const third = await persistDiscoveryItems({ store, runId, candidates: [candidate('recycled-subject')], now: NOW });
    assert.equal(third.persisted, 0);
    assert.equal(third.skipped, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 2);

    // The database enforces one live item per subject even if a caller skips
    // the lookup: a direct insert for the occupied subject must fail.
    await assert.rejects(store.recordItem({
        schema_version: '1.0.0', item_id: generateUuidV7(), run_id: runId, track: 'track-1',
        item_revision: 1, semantic_identity: sid, surface: 'learning', outcome: 'new-module',
        state: 'observed', proposal_digest: `sha256:${'1'.repeat(64)}`, artifact_digest: null,
        target: { repository: 'project42dev/project42-platform', path: 'content/modules/discovery/dupe.json' },
        evidence: [{ reference: 'proposal:dupe', digest: `sha256:${'2'.repeat(64)}` }],
        created_at: NOW, updated_at: NOW,
    }), 'the partial unique index is the last line of defence');

    const verification = store.verify();
    assert.ok(verification.ok, `integrity and foreign keys must hold: ${JSON.stringify(verification)}`);
});

test('a version 5 database with a closed item migrates in place and the subject becomes re-proposable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-upgrade-'));
    temporaries.push(directory);
    const dbPath = join(directory, 'state.db');

    // Build the exact version 5 schema from the vendored migration files, the
    // same files migrateContentDb itself applies, recorded in
    // schema_migration precisely as the runner records them, so the runner
    // recognises this database as a genuine version 5 estate and applies only
    // migration 006. This is the deployed upgrade path: content.db on the
    // live estate has rows in workflow_item when 006 rebuilds it.
    const V5 = [
        [2, '002-two-track-authority', '002-two-track-authority.sql'],
        [3, '003-closure-evidence', '003-closure-evidence.sql'],
        [4, '004-protected-authority-evidence', '004-protected-authority-evidence.sql'],
        [5, '005-protected-trust-anchors', '005-protected-trust-anchors.sql'],
    ];
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    for (const [version, name, file] of V5) {
        const sql = readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8');
        db.exec(sql);
        db.prepare('INSERT INTO schema_migration (version, name, checksum, applied_at, application_id) VALUES (?, ?, ?, ?, ?)')
            .run(version, name, `sha256:${createHash('sha256').update(sql).digest('hex')}`, NOW, randomUUID());
    }

    // Populate through the store's own API against the open handle.
    const v5store = new StateStore(db);
    const runId = generateUuidV7();
    await v5store.recordRun(runManifest(runId));
    const seeded = await persistDiscoveryItems({ store: v5store, runId, candidates: [candidate('upgraded-subject')], now: NOW });
    assert.equal(seeded.persisted, 1);
    const itemId = seeded.items[0].item_id;
    db.prepare("UPDATE workflow_item SET current_state = 'closed' WHERE item_id = ?").run(itemId);
    v5store.close();
    db.close();

    const outcome = migrateContentDb(dbPath);
    assert.deepEqual(outcome.applied, [
        { version: 6, name: '006-live-item-uniqueness' },
        { version: 7, name: '007-workflow-item-state-check' },
        { version: 8, name: '008-decision-event-per-item-uniqueness' },
        { version: 9, name: '009-rotate-gate-trust-anchor' },
    ]);
    assert.ok(outcome.verification.ok, `post-migration verification: ${JSON.stringify(outcome.verification)}`);

    const store = openStateStore(dbPath);
    try {
        const row = store.db.prepare('SELECT item_id, current_state FROM workflow_item').get();
        assert.equal(row.item_id, itemId, 'the rebuild must carry every row across');
        assert.equal(row.current_state, 'closed');
        const again = await persistDiscoveryItems({ store, runId, candidates: [candidate('upgraded-subject')], now: NOW });
        assert.equal(again.persisted, 1, 'after the upgrade the closed subject is re-proposable');
        assert.equal(again.reproposed, 1);
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
