import test from 'node:test';
import assert from 'node:assert/strict';
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW, candidate } from './test-fixtures.mjs';
import { findLiveItem, persistDiscoveryItems } from './lib/gate-queue.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { ADO_STATE_MAP } from './ado-sync.mjs';
import { invalidateDisprovedPathFindings } from './lib/inspection-invalidation.mjs';

test('a false approved finding needs persisted evidence before terminal invalidation', async () => {
    const { store, runId } = await estate();
    try {
        const [itemId] = await seedGateItems(store, runId, ['false-path-finding']);
        await walkTo(store, runId, itemId, 'ado-linked');
        const semanticIdentity = store.db.prepare('SELECT semantic_identity FROM workflow_item WHERE item_id = ?').get(itemId).semantic_identity;
        const report = { kind: 'inspection-invalidation', item_id: itemId, module_count: 3, unresolved_module_ids: [], inspection_fix: 'github:pull:335' };
        const digest = sha256Digest(report);
        const transition = {
            schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: runId,
            item_id: itemId, item_revision: 1, from_state: 'ado-linked', to_state: 'invalidated',
            cause: 'inspection-invalidated', reason: 'All three referenced modules resolve through the effective catalogue.',
            evidence_ref: digest, actor: 'test', occurred_at: NOW, correlation_id: generateUuidV7(),
        };
        await assert.rejects(store.recordTransition(transition), /persisted matching evidence/);
        store.recordObservation({
            observation_id: generateUuidV7(), run_id: runId, item_id: itemId, item_revision: 1,
            evidence_reference: `inspection-invalidation:${itemId}`, evidence_digest: digest,
            observed_at: NOW, report,
        });
        await store.recordTransition(transition);
        assert.equal(store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state, 'invalidated');
        assert.equal(findLiveItem(store.db, 'track-1', semanticIdentity), null);
        assert.equal(ADO_STATE_MAP.invalidated, 'Removed');
    } finally {
        store.close();
        cleanupFixtures();
    }
});

test('a reviewed path report invalidates only its exact ADO-linked target', async () => {
    const { store, runId } = await estate('track-2');
    try {
        const seeded = await persistDiscoveryItems({
            store, runId, track: 'track-2', candidates: [candidate('path-finding', {
                targetPath: 'catalog.json', canonicalContentId: 'learning-path:test-path',
            })], now: NOW,
        });
        assert.equal(seeded.persisted, 1);
        const itemId = seeded.items[0].item_id;
        await walkTo(store, runId, itemId, 'ado-linked');
        const report = {
            schema_version: '1.0.0', kind: 'inspection-invalidation',
            content_commit: 'a'.repeat(40), inspection_fix: 'github:pull:335',
            items: [{ item_id: itemId, ado_id: 424242, path_id: 'test-path', expected_state: 'ado-linked',
                module_count: 1, modules: [{ id: 'test-module', source: 'modules/test-path/test-module.json' }] }],
        };
        const applied = await invalidateDisprovedPathFindings({ store, report, now: NOW });
        assert.equal(applied.length, 1);
        assert.equal(store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state, 'invalidated');
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM observation_event WHERE item_id = ? AND evidence_digest = ?').get(itemId, applied[0].evidenceDigest).n, 1);
    } finally {
        store.close();
        cleanupFixtures();
    }
});
