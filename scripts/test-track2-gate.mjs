#!/usr/bin/env node
// T6: currency findings must become gated work.
//
// Before this, track-2-controller.mjs wrote only observation_event and
// run_outcome rows. No workflow_item was ever created, no Gate 1 issue for
// track-2 was ever announced, and the published architecture drew an edge
// from currency to Gate 1 that did not exist in any running code. These tests
// prove the edge now exists: a currency run's actionable classifications
// (addition, update, correction, replacement, removal) are persisted as
// workflow_item rows held at gate1-pending, "evidence-backed-no-change"
// proposes nothing, Gate 1 announces for track-2 with the right count, and a
// closed finding is re-proposable, which is T6 composing with T17's dedupe
// fix end to end.
//
// EVERY fixture is built through openStateStore / migrateContentDb on the
// real vendored schema, and every state is reached through the lifecycle's
// own transitions. Direct UPDATEs of current_state appear only as stand-ins
// for the closure evidence chain, the convention test-reproposal.mjs set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { announceGates } from './announce-gates.mjs';
import { heldAtGate } from './lib/gate-queue.mjs';
import { openStateStore } from './lib/state-store.mjs';
import {
    currencyCandidateFor,
    currencyFindingCandidates,
    runTrack2,
    TRACK_2_ACTIONABLE_CLASSIFICATIONS,
} from './lib/track-2-controller.mjs';
import { walkTo } from './test-fixtures.mjs';

const COMMIT = '3'.repeat(40);
const verifyCommit = (_root, commit) => {
    if (commit !== COMMIT) throw new Error('pin mismatch');
    return commit;
};

const temporaries = [];

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

/** The same seven-item canonical corpus the track-2 coverage tests use. */
function platformFixture() {
    const root = mkdtempSync(join(tmpdir(), 'orchard-t6-platform-'));
    temporaries.push(root);
    for (const directory of ['content/modules', 'content/resources', 'content/diagrams']) mkdirSync(join(root, directory), { recursive: true });
    writeJson(join(root, 'content/catalog.json'), {
        schemaVersion: '1.0.0',
        contentVersion: 'test',
        paths: [{ id: 'path-b', title: 'B' }, { id: 'path-a', title: 'A' }],
        modules: [{ id: 'module-a', title: 'Module' }],
        resources: [{ id: 'resource-a', title: 'Resource' }],
    });
    writeJson(join(root, 'content/modules/module-a.json'), { id: 'module-a', body: 'canonical module' });
    writeJson(join(root, 'content/resources/resource-a.json'), { id: 'resource-a', body: 'canonical resource' });
    writeJson(join(root, 'content/diagrams/catalogue.json'), {
        $schemaVersion: '1.0.0',
        renderer: 'mermaid',
        diagrams: [{ id: 'diagram-a', source: 'diagram-a.mmd' }],
    });
    writeFileSync(join(root, 'content/diagrams/diagram-a.mmd'), 'graph TD; A-->B;\n', 'utf8');
    return root;
}

function stateEstate() {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-t6-state-'));
    temporaries.push(directory);
    return openStateStore(join(directory, 'state.db'));
}

// The mix: four of the five actionable classifications plus no-change, so one
// run exercises both directions at once. The fifth actionable classification,
// replacement, is covered by the unit test on the candidate builder below.
const CLASSIFICATION_BY_ID = {
    'learning-module:module-a': 'update',
    'guide:resource-a': 'correction',
    'guide-diagram:diagram-a': 'removal',
    'catalogue:content': 'addition',
};

const EXPECTED_CATEGORY_BY_PATH = {
    'content/modules/module-a.json': 'update',
    'content/resources/resource-a.json': 'correction',
    'content/diagrams/diagram-a.mmd': 'removal',
    'content/catalog.json': 'addition',
};

function mixedInspector(item) {
    return {
        classification: CLASSIFICATION_BY_ID[item.stableId] ?? 'evidence-backed-no-change',
        evidence: [`digest:${item.digest}`, `source:${item.sourcePath}`],
    };
}

function runOptions(root, store, extra = {}) {
    return {
        mode: 'full', platformRoot: root, contentCommit: COMMIT, commitVerifier: verifyCommit,
        expectedCanonicalItems: 7, inspector: async (item) => mixedInspector(item), stateStore: store, ...extra,
    };
}

function recordingFetch(responses) {
    const calls = [];
    return {
        calls,
        impl: async (url, options) => {
            calls.push({ url, method: options?.method ?? 'GET', body: options?.body });
            const next = responses.shift() ?? { ok: true, status: 200, body: '[]' };
            return { ok: next.ok, status: next.status, text: async () => next.body };
        },
    };
}

test('the actionable classifications are exactly the five that are findings', () => {
    assert.deepEqual([...TRACK_2_ACTIONABLE_CLASSIFICATIONS].sort(), ['addition', 'correction', 'removal', 'replacement', 'update']);
});

test('the candidate builder covers every actionable classification and refuses no-change', () => {
    const item = {
        stableId: 'guide:resource-a', canonicalId: 'resource-a', surface: 'guide',
        sourcePath: 'content/resources/resource-a.json',
        sourceDigest: `sha256:${'a'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}`,
    };
    for (const classification of TRACK_2_ACTIONABLE_CLASSIFICATIONS) {
        const candidate = currencyCandidateFor(item, { classification, evidence: ['e:1'] }, '2026-08-16T00:00:00.000Z');
        assert.equal(candidate.category, classification);
        assert.equal(candidate.targetPath, item.sourcePath, 'a finding targets the published file, never a fresh discovery path');
        assert.match(candidate.semanticIdentity, /^sid:v1:[a-f0-9]{64}$/);
    }
    const update = currencyCandidateFor(item, { classification: 'update', evidence: ['e:1'] }, '2026-08-16T00:00:00.000Z');
    const removal = currencyCandidateFor(item, { classification: 'removal', evidence: ['e:1'] }, '2026-08-16T00:00:00.000Z');
    assert.equal(update.semanticIdentity, removal.semanticIdentity,
        'the subject is the canonical item, so two kinds of finding cannot both be live for one file');
    assert.throws(() => currencyCandidateFor(item, { classification: 'evidence-backed-no-change', evidence: ['e:1'] }, '2026-08-16T00:00:00.000Z'),
        /not an actionable/, 'confirmed-current content is not a finding');
    assert.equal(currencyFindingCandidates([item], [{ stableId: item.stableId, classification: 'evidence-backed-no-change', evidence: ['e:1'] }], '2026-08-16T00:00:00.000Z').length, 0);
});

test('a currency run persists gate-bound items for the actionable classifications only, at gate1-pending', async () => {
    const root = platformFixture();
    const store = stateEstate();
    try {
        const result = await runTrack2(runOptions(root, store));
        assert.equal(result.status, 'completed');
        assert.equal(result.findings.persisted, 4, 'four actionable classifications, four items');
        assert.equal(result.findings.failed, 0);

        const held = heldAtGate(store.db, 'gate-1', 'track-2');
        assert.equal(held.length, 4, 'every finding must be held at Gate 1 for track-2');
        assert.deepEqual(
            Object.fromEntries(held.map((entry) => [entry.target.path, entry.category])),
            EXPECTED_CATEGORY_BY_PATH,
            'each finding binds its classification to the published file it is about',
        );
        assert.equal(heldAtGate(store.db, 'gate-1', 'track-1').length, 0, 'track-2 findings must not leak into the track-1 gate');

        const rows = store.db.prepare('SELECT * FROM workflow_item ORDER BY item_id').all();
        assert.equal(rows.length, 4, 'evidence-backed-no-change must persist no workflow item');
        for (const row of rows) {
            assert.equal(row.track, 'track-2');
            assert.equal(row.current_state, 'gate1-pending');
            assert.ok(TRACK_2_ACTIONABLE_CLASSIFICATIONS.includes(row.outcome), `outcome ${row.outcome} must be an actionable classification`);
        }

        const transitions = store.listTransitions(rows[0].item_id);
        assert.deepEqual(transitions.map((t) => [t.from_state, t.to_state]), [
            ['observed', 'proposed'], ['proposed', 'gate1-pending'],
        ], 'a finding enters the lifecycle at the top like any discovery candidate');
        assert.equal(transitions[0].actor, 'orchard-track-2-controller', 'the transition names the controller that recorded it');

        assert.equal(store.getRun(result.run.run_id).item_count, 4, 'the run manifest must measure what the database holds');
        const verification = store.verify();
        assert.ok(verification.ok, `integrity and foreign keys must hold: ${JSON.stringify(verification)}`);
    } finally {
        store.close();
    }
});

test('Gate 1 announces for track-2 with the right count, through the same announcement path as track-1', async () => {
    const root = platformFixture();
    const store = stateEstate();
    try {
        const result = await runTrack2(runOptions(root, store));
        assert.equal(result.findings.persisted, 4);
        const { impl, calls } = recordingFetch([
            { ok: true, status: 200, body: '[]' },
            { ok: true, status: 201, body: JSON.stringify({ number: 42, html_url: 'u' }) },
        ]);
        const results = await announceGates({
            db: store.db, track: 'track-2', runId: result.run.run_id, repo: 'o/r', token: 't', log: () => { }, fetchImpl: impl,
        });
        assert.deepEqual(results.map((r) => [r.gate, r.action, r.count]), [['gate-1', 'created', 4], ['gate-2', 'empty', 0]]);
        const posted = JSON.parse(calls.at(-1).body);
        assert.ok(posted.title.includes('4 items awaiting approval (Currency)'), 'the issue title must name the track by what it does and the count');
        assert.ok(posted.body.includes('content/modules/module-a.json'), 'the issue must name the published file the finding is about');
        assert.ok(posted.body.includes('/orchard gate1 approve item='), 'the issue must carry the exact decision command');
    } finally {
        store.close();
    }
});

test('a second run over unchanged findings dedupes instead of stacking duplicates', async () => {
    const root = platformFixture();
    const store = stateEstate();
    try {
        const first = await runTrack2(runOptions(root, store));
        assert.equal(first.findings.persisted, 4);
        const second = await runTrack2(runOptions(root, store));
        assert.equal(second.findings.persisted, 0, 'a live finding must not be proposed again');
        assert.equal(second.findings.skipped, 4);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 4);
        assert.equal(store.getRun(second.run.run_id).item_count, 0, 'the second run held nothing new and its manifest says so');
    } finally {
        store.close();
    }
});

test('a closed finding is re-proposed by the next run: T6 composes with the T17 dedupe fix', async () => {
    const root = platformFixture();
    const store = stateEstate();
    const oneFinding = (item) => ({
        classification: item.stableId === 'learning-module:module-a' ? 'update' : 'evidence-backed-no-change',
        evidence: [`digest:${item.digest}`],
    });
    try {
        const first = await runTrack2(runOptions(root, store, { inspector: async (item) => oneFinding(item) }));
        assert.equal(first.findings.persisted, 1);
        const firstItemId = first.findings.items[0].item_id;

        // Walk the finding through its whole lifecycle, then stand in for the
        // closure evidence chain, the convention test-reproposal.mjs set.
        await walkTo(store, first.run.run_id, firstItemId, 'published');
        store.db.prepare("UPDATE workflow_item SET current_state = 'closed' WHERE item_id = ?").run(firstItemId);

        const second = await runTrack2(runOptions(root, store, { inspector: async (item) => oneFinding(item) }));
        assert.equal(second.findings.persisted, 1, 'the closed subject must be proposable again');
        assert.equal(second.findings.reproposed, 1);

        const held = heldAtGate(store.db, 'gate-1', 'track-2');
        assert.equal(held.length, 1);
        assert.notEqual(held[0].item_id, firstItemId, 'a re-proposal is a new item, not the closed one reopened');
        assert.ok(held[0].rationale.includes(firstItemId), 'the gate must say this supersedes a closed predecessor');

        const fresh = store.db.prepare('SELECT * FROM workflow_item WHERE item_id = ?').get(held[0].item_id);
        assert.equal(fresh.current_state, 'gate1-pending');
        assert.equal(fresh.supersedes_item_id, firstItemId, 'lineage lives on the new item');
        const old = store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(firstItemId);
        assert.equal(old.current_state, 'closed', 'closed stays closed for the item that reached it');
    } finally {
        store.close();
    }
});

test('corpus drift persists no findings, because the evidence describes a corpus that moved', async () => {
    const root = platformFixture();
    const store = stateEstate();
    let drifted = false;
    try {
        const result = await runTrack2(runOptions(root, store, {
            inspector: async (item) => {
                if (!drifted) {
                    drifted = true;
                    writeFileSync(join(root, 'content/diagrams/diagram-a.mmd'), 'graph TD; A-->C;\n', 'utf8');
                }
                return mixedInspector(item);
            },
        }));
        assert.equal(result.drift, true);
        assert.equal(result.status, 'failed');
        assert.equal(result.findings.persisted, 0);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_item').get().n, 0);
    } finally {
        store.close();
    }
});

test.after(() => {
    // Windows keeps a handle on a just-closed SQLite file for a moment. A
    // failed cleanup is a temp directory, not a test result.
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
});
