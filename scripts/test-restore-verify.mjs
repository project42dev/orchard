#!/usr/bin/env node
// T20: a backup that has never been restored is a hypothesis.
//
// These tests build a real workflow_item fixture through openStateStore /
// migrateContentDb (the same fixture helper every other test file uses,
// never a hand-created table), take its actual bytes as the stand-in for
// what BlobStateAdapter#replicateBackup would have uploaded, and prove
// restore-verify.mjs finds the right commit, verifies the digest before
// trusting the bytes, and reports the same state distribution the real
// database holds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { estate, seedGateItems, cleanupFixtures } from './test-fixtures.mjs';
import { latestBackupCommit, downloadVerifiedBackup, verifyRestoredState, main } from './restore-verify.mjs';

const digestOf = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
const log = () => {};

/** A stub backup container serving commit markers and their named blobs from an in-memory map. */
function stubBackupContainer(blobs = new Map()) {
    return {
        blobs,
        async *listBlobsFlat({ prefix }) {
            for (const name of blobs.keys()) if (name.startsWith(prefix)) yield { name };
        },
        getBlobClient(name) {
            return {
                getProperties: async () => {
                    if (!blobs.has(name)) { const error = new Error('not found'); error.statusCode = 404; throw error; }
                    return { contentLength: blobs.get(name).byteLength };
                },
                downloadToBuffer: async () => {
                    if (!blobs.has(name)) throw new Error(`no such blob: ${name}`);
                    return blobs.get(name);
                },
            };
        },
    };
}

function commitMarker({ scope, generation, digest, backupBlob }) {
    return Buffer.from(JSON.stringify({
        schemaVersion: 1, scope, stateGeneration: generation, fencingGeneration: 1,
        stateDigest: digest, stateBlob: `orchard-state/${scope}/generations/${String(generation).padStart(12, '0')}.sqlite`,
        backupBlob, manifestEtag: 'etag-1',
    }));
}

test('latestBackupCommit picks the highest generation, not just any commit', async () => {
    const bytes = Buffer.from('fixture');
    const digest = digestOf(bytes);
    const blobs = new Map([
        ['orchard-state/track-1/backup-commits/000000000001-aaa.json', commitMarker({ scope: 'track-1', generation: 1, digest, backupBlob: 'orchard-state/track-1/backups/000000000001-aaa.sqlite' })],
        ['orchard-state/track-1/backup-commits/000000000003-ccc.json', commitMarker({ scope: 'track-1', generation: 3, digest, backupBlob: 'orchard-state/track-1/backups/000000000003-ccc.sqlite' })],
        ['orchard-state/track-1/backup-commits/000000000002-bbb.json', commitMarker({ scope: 'track-1', generation: 2, digest, backupBlob: 'orchard-state/track-1/backups/000000000002-bbb.sqlite' })],
    ]);
    const commit = await latestBackupCommit({ backupContainerClient: stubBackupContainer(blobs), prefix: 'orchard-state', scope: 'track-1' });
    assert.equal(commit.stateGeneration, 3);
    assert.equal(commit.backupBlob, 'orchard-state/track-1/backups/000000000003-ccc.sqlite');
});

test('latestBackupCommit returns null when a track has never been backed up', async () => {
    const commit = await latestBackupCommit({ backupContainerClient: stubBackupContainer(), prefix: 'orchard-state', scope: 'track-2' });
    assert.equal(commit, null);
});

test('a commit marker naming a blob outside the backup prefix is rejected', async () => {
    const blobs = new Map([
        ['orchard-state/track-1/backup-commits/000000000001-aaa.json', commitMarker({ scope: 'track-1', generation: 1, digest: digestOf(Buffer.from('x')), backupBlob: 'orchard-state/track-2/backups/escape.sqlite' })],
    ]);
    await assert.rejects(
        () => latestBackupCommit({ backupContainerClient: stubBackupContainer(blobs), prefix: 'orchard-state', scope: 'track-1' }),
        /malformed/,
    );
});

test('downloadVerifiedBackup rejects bytes that do not match the commit digest', async () => {
    const blobs = new Map([['orchard-state/track-1/backups/g.sqlite', Buffer.from('tampered')]]);
    const commit = { backupBlob: 'orchard-state/track-1/backups/g.sqlite', stateDigest: digestOf(Buffer.from('original')) };
    await assert.rejects(
        () => downloadVerifiedBackup({ backupContainerClient: stubBackupContainer(blobs), commit, destination: '/tmp/should-not-be-written.sqlite' }),
        /digest mismatch/,
    );
});

test('end to end: restore-verify opens a real backed-up database and reports its real state distribution', async () => {
    const { store, runId } = await estate('track-1');
    await seedGateItems(store, runId, ['alpha', 'bravo', 'charlie']);
    store.close();
    const bytes = readFileSync(store.path);
    const digest = digestOf(bytes);

    const blobs = new Map([
        ['orchard-state/track-1/backup-commits/000000000001-x.json', commitMarker({ scope: 'track-1', generation: 1, digest, backupBlob: 'orchard-state/track-1/backups/000000000001-x.sqlite' })],
        ['orchard-state/track-1/backups/000000000001-x.sqlite', bytes],
    ]);

    const summary = await main(['--track', 'track-1'], { log, backupContainerClient: stubBackupContainer(blobs) });
    assert.equal(summary.total, 3, 'the restored database must report the same item count the fixture seeded');
    assert.equal(summary.byState['gate1-pending'], 3);
});

test('verifyRestoredState throws a clear error on a database with no workflow_item table at all', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE unrelated (id INTEGER)');
    assert.throws(() => verifyRestoredState({ store: { db }, track: 'track-1' }), /no workflow_item table/);
});

test('verifyRestoredState reports the real distribution a live track run would see', async () => {
    const { store, runId } = await estate('track-1');
    await seedGateItems(store, runId, ['delta', 'echo']);
    const summary = verifyRestoredState({ store, track: 'track-1' });
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.byState, { 'gate1-pending': 2 });
    store.close();
});

test('restore-verify reports a clear, typed error when no backup exists yet for a track', async () => {
    await assert.rejects(
        () => main(['--track', 'track-2'], { log, backupContainerClient: stubBackupContainer() }),
        (error) => {
            assert.equal(error.code, 'ERR_ORCHARD_NO_BACKUP');
            return true;
        },
    );
});

test.after(cleanupFixtures);
