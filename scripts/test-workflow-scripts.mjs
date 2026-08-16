#!/usr/bin/env node
// The operator scripts against the REAL schema.
//
// ado-sync, ingest-proposals, record-publication, reject-publication and the
// live-verification query were all written against schema/content-db.sql, a
// developer-local schema no migration ever applies, and none of them had a
// test. Every fixture here is built through openStateStore on the migrated
// schema and walked through the lifecycle's own transitions, so a query
// against a table production does not have fails HERE, not on the first real
// run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from './lib/state-store.mjs';
import { syncCreate, syncUpdate, adoExternalKey } from './ado-sync.mjs';
import { ingest, DISPOSITION_STATE, TERMINAL_STATES } from './ingest-proposals.mjs';
import { recordPublication, PublicationError } from './record-publication.mjs';
import { recordRejection, RejectionError } from './reject-publication.mjs';
import { PUBLISHED_ITEMS_SQL, ITEM_TITLE_SQL } from './verify-published-live.mjs';
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from './test-fixtures.mjs';

const temporaries = [];

function stateOf(dbPath, id) {
    const store = openStateStore(dbPath);
    try {
        return store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(id).current_state;
    } finally {
        store.close();
    }
}

function runRecordDir(proposals) {
    const dir = mkdtempSync(join(tmpdir(), 'orchard-run-records-'));
    temporaries.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-0001.json'), JSON.stringify({
        runId: 'run-0001',
        proposals,
    }));
    return dir;
}

// --- ado-sync ----------------------------------------------------------------

test('ado-sync creates a story for a gate1-approved item, records the link, and advances it', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['linkable']);
    await walkTo(store, runId, id, 'gate1-approved');
    store.close();

    const dry = await syncCreate({ dbPath, org: 'o', project: 'p', areaPath: 'a', apply: false });
    assert.equal(dry.created, 1, 'the approved, unlinked item is found');

    const created = [];
    const applied = await syncCreate({
        dbPath, org: 'o', project: 'p', areaPath: 'a', apply: true, now: NOW,
        createStory: (row) => { created.push(row); return 4242; },
    });
    assert.equal(applied.created, 1);
    assert.equal(created[0].title, 'How to teach linkable', 'the recorded manifest title names the story');

    const store2 = openStateStore(dbPath);
    try {
        const link = store2.db.prepare("SELECT external_key, external_id, item_revision FROM external_link WHERE provider = 'ado' AND item_id = ?").get(id);
        assert.equal(link.external_id, '4242');
        assert.equal(link.external_key, adoExternalKey({ track: 'track-1', item_id: id, current_revision: link.item_revision }),
            'the link uses the exact key the dispatch binding reads');
        assert.equal(store2.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(id).current_state,
            'ado-linked', 'the item advanced through the lifecycle, not around it');
    } finally {
        store2.close();
    }

    const again = await syncCreate({ dbPath, org: 'o', project: 'p', areaPath: 'a', apply: true, createStory: () => { throw new Error('must not be called twice'); } });
    assert.equal(again.created, 0, 'create is idempotent: a linked item is not re-created');
});

test('ado-sync update maps lifecycle states onto ADO states through the recorded link', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['tracked']);
    await walkTo(store, runId, id, 'gate1-approved');
    store.close();
    await syncCreate({ dbPath, org: 'o', project: 'p', areaPath: 'a', apply: true, now: NOW, createStory: () => 77 });

    const store2 = openStateStore(dbPath);
    await walkTo(store2, runId, id, 'executing');
    store2.close();

    const updates = [];
    const result = await syncUpdate({
        dbPath, org: 'o', project: 'p', apply: true,
        updateStory: (adoId, state) => { updates.push([adoId, state]); return 'Active'; },
    });
    assert.equal(result.updated, 1);
    assert.deepEqual(updates, [['77', 'executing']], 'the update carries the lifecycle state for mapping');
});

// --- ingest-proposals --------------------------------------------------------

test('ingest moves an executing item on the ensemble verdict, through the lifecycle', async () => {
    const { store, runId, dbPath } = await estate();
    const [passId] = await seedGateItems(store, runId, ['authored-pass']);
    const [blockId] = await seedGateItems(store, runId, ['authored-block']);
    await walkTo(store, runId, passId, 'executing');
    await walkTo(store, runId, blockId, 'executing');
    store.close();

    const dir = runRecordDir([
        { proposalPath: `proposal-p42-create-${passId}-01234567.json`, disposition: 'ready-for-draft' },
        { proposalPath: `proposal-p42-create-${blockId}-01234567.json`, disposition: 'blocked' },
    ]);

    const dry = await ingest({ dbPath, runRecordDir: dir, apply: false });
    assert.equal(dry.applied.length, 2);
    assert.equal(stateOf(dbPath, passId), 'executing', 'a dry run changes nothing');

    const r = await ingest({ dbPath, runRecordDir: dir, apply: true, now: NOW });
    assert.equal(r.applied.length, 2);
    assert.equal(stateOf(dbPath, passId), DISPOSITION_STATE['ready-for-draft']);
    assert.equal(stateOf(dbPath, blockId), 'blocked');

    const store2 = openStateStore(dbPath);
    try {
        const blocked = store2.listTransitions(blockId).findLast((t) => t.to_state === 'blocked');
        assert.ok(blocked.reason.includes('blocked by the authoring ensemble'), 'the refusal carries its reason');
    } finally {
        store2.close();
    }
});

test('ingest never touches an item a human or the engine owns', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['already-published']);
    await walkTo(store, runId, id, 'published');
    store.close();
    assert.ok(TERMINAL_STATES.has('published'));

    const dir = runRecordDir([
        { proposalPath: `proposal-p42-create-${id}-01234567.json`, disposition: 'ready-for-draft' },
    ]);
    const r = await ingest({ dbPath, runRecordDir: dir, apply: true });
    assert.equal(r.applied.length, 0);
    assert.equal(r.protectedItems.length, 1);
    assert.equal(stateOf(dbPath, id), 'published');
});

test('ingest reports an item that is not executing rather than guessing', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['not-started']);
    store.close();

    const dir = runRecordDir([
        { proposalPath: `proposal-p42-create-${id}-01234567.json`, disposition: 'ready-for-draft' },
    ]);
    const r = await ingest({ dbPath, runRecordDir: dir, apply: true });
    assert.equal(r.applied.length, 0);
    assert.equal(r.unmatched.length, 1);
    assert.ok(r.unmatched[0].reason.includes('gate1-pending'));
    assert.equal(stateOf(dbPath, id), 'gate1-pending');
});

// --- record-publication ------------------------------------------------------

test('a manual acceptance is recorded as immutable evidence, and never moves state', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['hand-published']);
    await walkTo(store, runId, id, 'executing');
    store.close();

    const r = await recordPublication({ dbPath, subjectId: id, acceptedBy: 'kris', apply: true, now: NOW });
    assert.equal(r.row.accepted_by, 'kris');
    assert.equal(r.transaction, null, 'no publication transaction exists and none is fabricated');
    assert.equal(stateOf(dbPath, id), 'executing', 'a bookkeeping row is not a lifecycle transition');

    const store2 = openStateStore(dbPath);
    try {
        const observation = store2.listObservations(runId).find((o) => o.acceptance?.accepted_by === 'kris');
        assert.ok(observation, 'the acceptance is persisted as observation evidence');
        assert.ok(observation.evidence_reference.startsWith('orchard/manual-acceptance/'));
    } finally {
        store2.close();
    }
});

test('an acceptance for a denied item is refused', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['owner-said-no']);
    await walkTo(store, runId, id, 'gate2-pending');
    store.close();
    await recordRejection({ dbPath, subjectId: id, rejectedBy: 'kris', apply: true, now: NOW });

    await assert.rejects(
        () => recordPublication({ dbPath, subjectId: id, acceptedBy: 'kris', apply: true }),
        (e) => e instanceof PublicationError && e.detail.includes('denied'),
    );
});

// --- reject-publication ------------------------------------------------------

test('a rejection is the lifecycle denial, with the reason and the person on it', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['to-reject']);
    await walkTo(store, runId, id, 'gate2-pending');
    store.close();

    const r = await recordRejection({ dbPath, subjectId: id, rejectedBy: 'kris', note: 'not worth publishing', apply: true, now: NOW });
    assert.equal(r.to, 'denied');
    assert.equal(stateOf(dbPath, id), 'denied');

    const store2 = openStateStore(dbPath);
    try {
        const denial = store2.listTransitions(id).findLast((t) => t.to_state === 'denied');
        assert.equal(denial.actor, 'kris');
        assert.equal(denial.reason, 'not worth publishing');
    } finally {
        store2.close();
    }
});

test('a rejection of work that is not under review is refused', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['mid-flight']);
    await walkTo(store, runId, id, 'executing');
    store.close();

    await assert.rejects(
        () => recordRejection({ dbPath, subjectId: id, rejectedBy: 'kris', apply: true }),
        (e) => e instanceof RejectionError && e.detail.includes('executing'),
    );
});

// --- verify-published-live ---------------------------------------------------

test('the live-verification queries compile against the migrated schema', async () => {
    const { store } = await estate();
    try {
        // prepare() resolves table and column names, which is exactly what the
        // old query could not do against production: it read `publication` and
        // `item`, and would have failed `no such table` on every run.
        assert.doesNotThrow(() => store.db.prepare(PUBLISHED_ITEMS_SQL));
        assert.doesNotThrow(() => store.db.prepare(ITEM_TITLE_SQL));
        assert.deepEqual(store.db.prepare(PUBLISHED_ITEMS_SQL).all(null, null), [],
            'an estate that has never published verifies zero items, not a crash');
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
