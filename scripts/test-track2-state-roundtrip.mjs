#!/usr/bin/env node
// 1.3: Track 2 must actually establish state, and cold-start correctly.
//
// WHAT WAS WRONG. Track 2 ran once, ten hours before the estate was renamed.
// Its state generation is stranded on a storage account with no network path,
// and the `track-2-state` container on the live account has never received a
// write. The published architecture says currency keeps a durable, fenced
// state database exactly as discovery does; nothing had ever demonstrated
// that the currency path can create one from nothing.
//
// A cold start is the case that matters and the one nothing covered. On a
// first run there is no manifest, no generation blob, no SQLite file and no
// schema. Every later run reads a manifest that exists. The two paths through
// BlobStateAdapter are genuinely different, and the cold one had no test.
//
// WHAT THESE TESTS PROVE, end to end through the REAL BlobStateAdapter and
// the REAL withFencedState, against an in-memory container that behaves like
// Azure Blob Storage's conditional headers and leases:
//
//   1. A cold start is handled: no manifest, no crash, no silent no-op. The
//      run creates the database, migrates it, does its work, and publishes a
//      generation plus a replicated backup and a commit marker.
//   2. A second run READS THAT BACK and behaves differently because of it:
//      the same four findings it would otherwise have proposed are recognised
//      as already held and proposed again by nobody. That is the difference
//      between state that is written and state that is consulted, and only
//      the second one is worth anything.
//   3. Wiping the container reverts run 2 to run 1's behaviour, which is what
//      makes point 2 evidence rather than coincidence: the changed behaviour
//      is caused by the persisted state and by nothing else in the fixture.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStateAdapter } from './lib/blob-state-adapter.mjs';
import { withFencedState } from './lib/coordination.mjs';
import { heldAtGate } from './lib/gate-queue.mjs';
import { openStateStore } from './lib/state-store.mjs';
import { runTrack2 } from './lib/track-2-controller.mjs';

const COMMIT = '3'.repeat(40);
const temporaries = [];

// ---------------------------------------------------------------------------
// A container that behaves like Azure Blob Storage where this code depends on
// it: If-None-Match:* rejects an overwrite with 409, If-Match rejects a stale
// ETag with 412, a missing blob is a 404 on getProperties, and a lease is
// exclusive. Everything BlobStateAdapter's correctness rests on is a
// conditional header or a lease, so a fake that ignored them would prove
// nothing about the adapter.
// ---------------------------------------------------------------------------

class HttpishError extends Error {
    constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function fakeContainer() {
    const blobs = new Map();
    let leaseHolder = null;

    const put = (name, payload, options = {}) => {
        const existing = blobs.get(name);
        const conditions = options.conditions ?? {};
        if (conditions.ifNoneMatch === '*' && existing) throw new HttpishError(409, `blob already exists: ${name}`);
        if (conditions.ifMatch && existing?.etag !== conditions.ifMatch) throw new HttpishError(412, `etag mismatch: ${name}`);
        const etag = `"${randomUUID()}"`;
        blobs.set(name, { payload: Buffer.from(payload), etag, metadata: options.metadata ?? {} });
        return { etag };
    };

    const require404 = (name) => {
        const blob = blobs.get(name);
        if (!blob) throw new HttpishError(404, `blob not found: ${name}`);
        return blob;
    };

    const reader = (name) => ({
        async getProperties() {
            const blob = require404(name);
            return { etag: blob.etag, contentLength: blob.payload.byteLength, metadata: blob.metadata };
        },
        async download() {
            const blob = require404(name);
            return { readableStreamBody: Readable.from([blob.payload]) };
        },
        async downloadToBuffer() { return Buffer.from(require404(name).payload); },
        async downloadToFile(path) { writeFileSync(path, require404(name).payload); return { contentLength: require404(name).payload.byteLength }; },
    });

    return {
        blobs,
        getBlobClient: reader,
        getBlockBlobClient(name) {
            return {
                ...reader(name),
                async exists() { return blobs.has(name); },
                async upload(content, length, options) { return put(name, content, options); },
                async uploadData(payload, options) { return put(name, payload, options); },
                async uploadFile(path, options) { return put(name, readFileSync(path), options); },
                getBlobLeaseClient(leaseId) {
                    return {
                        leaseId,
                        async acquireLease() {
                            if (leaseHolder && leaseHolder !== leaseId) throw new HttpishError(409, 'blob is already leased');
                            leaseHolder = leaseId;
                        },
                        async renewLease() {
                            if (leaseHolder !== leaseId) throw new HttpishError(412, 'lease lost');
                        },
                        async releaseLease() { if (leaseHolder === leaseId) leaseHolder = null; },
                    };
                },
            };
        },
    };
}

function scratch(prefix) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaries.push(directory);
    return directory;
}

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

/** The same seven-item canonical corpus the other Track 2 tests inspect. */
function platformFixture() {
    const root = scratch('orchard-t2state-platform-');
    for (const directory of ['content/modules', 'content/resources', 'content/diagrams']) mkdirSync(join(root, directory), { recursive: true });
    writeJson(join(root, 'content/catalog.json'), {
        schemaVersion: '1.0.0', contentVersion: 'test',
        paths: [{ id: 'path-b', title: 'B' }, { id: 'path-a', title: 'A' }],
        modules: [{ id: 'module-a', title: 'Module' }],
        resources: [{ id: 'resource-a', title: 'Resource' }],
    });
    writeJson(join(root, 'content/modules/module-a.json'), { id: 'module-a', body: 'canonical module' });
    writeJson(join(root, 'content/resources/resource-a.json'), { id: 'resource-a', body: 'canonical resource' });
    writeJson(join(root, 'content/diagrams/catalogue.json'), { $schemaVersion: '1.0.0', renderer: 'mermaid', diagrams: [{ id: 'diagram-a', source: 'diagram-a.mmd' }] });
    writeFileSync(join(root, 'content/diagrams/diagram-a.mmd'), 'graph TD; A-->B;\n', 'utf8');
    return root;
}

const CLASSIFICATION_BY_ID = {
    'learning-module:module-a': 'update',
    'guide:resource-a': 'correction',
    'guide-diagram:diagram-a': 'removal',
    'catalogue:content': 'addition',
};

/**
 * One whole Track 2 job, exactly as the production runtime shapes it: acquire
 * the fence, read whatever state exists (or does not), open the store at that
 * path, run the controller, hand the path back to be published.
 */
async function runFencedTrack2(adapter, platformRoot) {
    const observed = {};
    const outcome = await withFencedState(adapter, { scope: 'track-2', owner: 'test:1' }, async ({ state }) => {
        observed.coldStart = state.exists === false;
        observed.statePath = state.path;
        const store = openStateStore(state.path);
        try {
            const result = await runTrack2({
                mode: 'full', platformRoot, contentCommit: COMMIT,
                commitVerifier: (_root, commit) => commit,
                expectedCanonicalItems: 7,
                inspector: async (item) => ({
                    classification: CLASSIFICATION_BY_ID[item.stableId] ?? 'evidence-backed-no-change',
                    evidence: [`digest:${item.digest}`],
                }),
                stateStore: store,
            });
            observed.findings = result.findings;
            observed.held = heldAtGate(store.db, 'gate-1', 'track-2').length;
        } finally {
            store.close();
        }
        return { statePath: state.path, value: observed };
    });
    return { observed, published: outcome.published };
}

test('a Track 2 run cold-starts its state and publishes a verified generation', async () => {
    const container = fakeContainer();
    const backup = fakeContainer();
    const adapter = new BlobStateAdapter({ containerClient: container, backupContainerClient: backup, workRoot: scratch('orchard-t2state-work-') });
    const platformRoot = platformFixture();

    assert.equal(container.blobs.size, 0, 'the container starts as empty as the live track-2-state container is');
    const { observed, published } = await runFencedTrack2(adapter, platformRoot);

    assert.equal(observed.coldStart, true, 'there was no prior generation to read');
    assert.equal(observed.findings.persisted, 4, 'a cold start does the work rather than crashing or no-opping');
    assert.equal(observed.held, 4);

    const names = [...container.blobs.keys()].sort();
    assert.ok(names.includes('orchard-state/track-2/manifest.json'), 'the manifest must exist after the first run');
    assert.equal(published.generation, 1, 'a cold start publishes generation 1');
    assert.ok(container.blobs.has(published.blobName), 'the SQLite generation itself must be in the container');

    const manifest = JSON.parse(container.blobs.get('orchard-state/track-2/manifest.json').payload.toString('utf8'));
    assert.equal(manifest.scope, 'track-2');
    assert.equal(manifest.stateGeneration, 1);
    assert.equal(manifest.stateDigest, published.digest);
    assert.equal(`sha256:${createHash('sha256').update(container.blobs.get(published.blobName).payload).digest('hex')}`, published.digest,
        'the published bytes must be the bytes the manifest binds to');
    assert.ok(manifest.backupBlob && backup.blobs.has(manifest.backupBlob), 'the generation must be replicated to the backup account');
    assert.ok([...backup.blobs.keys()].some((name) => name.includes('/backup-commits/')), 'a commit marker records what was published');
});

test('a second run reads the published state back and holds nothing new because of it', async () => {
    const container = fakeContainer();
    const backup = fakeContainer();
    const adapter = new BlobStateAdapter({ containerClient: container, backupContainerClient: backup, workRoot: scratch('orchard-t2state-work-') });
    const platformRoot = platformFixture();

    const first = await runFencedTrack2(adapter, platformRoot);
    assert.equal(first.observed.coldStart, true);
    assert.equal(first.observed.findings.persisted, 4);

    // Nothing about the corpus or the inspector changes. The ONLY thing that
    // is different is that the state the first run published now exists.
    const second = await runFencedTrack2(adapter, platformRoot);
    assert.equal(second.observed.coldStart, false, 'the second run must find and download the published generation');
    assert.notEqual(second.observed.statePath, first.observed.statePath, 'it is a fresh download, not the first run leftover file');
    assert.equal(second.observed.findings.persisted, 0, 'every finding is already held, so nothing is proposed again');
    assert.equal(second.observed.findings.skipped, 4);
    assert.equal(second.observed.held, 4, 'the gate holds four items, not eight');
    assert.equal(second.published.generation, 2, 'the second run publishes the next generation on top of the first');

    // The proof that the behaviour came from the state and not from the
    // fixture: take the state away and the third run behaves like the first.
    container.blobs.clear();
    const third = await runFencedTrack2(adapter, platformRoot);
    assert.equal(third.observed.coldStart, true);
    assert.equal(third.observed.findings.persisted, 4, 'with the state gone, the same run proposes all four again');
});

test.after(() => {
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
});
