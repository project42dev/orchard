import test from 'node:test';
import assert from 'node:assert/strict';
import { estate, candidate, walkTo, cleanupFixtures, NOW } from './test-fixtures.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { persistDiscoveryItems, findLiveItem } from './lib/gate-queue.mjs';
import { reconcileExternalPublications } from './lib/external-publication-reconciliation.mjs';
import { ADO_STATE_MAP } from './ado-sync.mjs';
import { sha256Digest } from './lib/identity.mjs';

test('a reviewed direct release resolves only its exact live target and remains distinct from Orchard publication', async () => {
    const { store, runId, directory } = await estate('track-2');
    try {
        const saved = await persistDiscoveryItems({
            store, runId, track: 'track-2', now: NOW,
            candidates: [candidate('external-delivery', {
                targetPath: 'modules/agentic-systems-and-mcp/external-delivery.json',
            })],
        });
        const itemId = saved.items[0].item_id;
        await walkTo(store, runId, itemId, 'gate2-pending');
        const corpusRoot = join(directory, 'platform');
        const contentFile = join(corpusRoot, 'content', 'modules/agentic-systems-and-mcp/external-delivery.json');
        mkdirSync(dirname(contentFile), { recursive: true });
        writeFileSync(contentFile, JSON.stringify({ id: 'external-delivery' }));
        const semanticIdentity = store.db.prepare('SELECT semantic_identity FROM workflow_item WHERE item_id = ?').get(itemId).semantic_identity;
        const report = {
            schema_version: '1.0.0', kind: 'external-publication-reconciliation',
            content_commit: 'a'.repeat(40), platform_commit: 'b'.repeat(40), site_commit: 'c'.repeat(40), platform_version: '0.116.11',
            items: [{ item_id: itemId, ado_id: 424242, revision: 1,
                path: 'modules/agentic-systems-and-mcp/external-delivery.json',
                content_digest: sha256Digest({ id: 'external-delivery' }),
                live_url: 'https://project-42.dev/learn/agentic-systems-and-mcp/external-delivery',
                content_prs: ['https://github.com/project42dev/project42-content/pull/75'] }],
        };
        await assert.rejects(reconcileExternalPublications({ store, report, deployedPlatformCommit: 'e'.repeat(40), corpusRoot, liveReleaseFacts: { platformVersion: '0.116.11' } }), /matching the deployed platform commit/);
        assert.equal(store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state, 'gate2-pending');
        await assert.rejects(reconcileExternalPublications({ store, report, deployedPlatformCommit: report.platform_commit, corpusRoot, liveReleaseFacts: { platformVersion: '0.116.10' } }), /matching the deployed platform commit/);
        await assert.rejects(reconcileExternalPublications({ store, report: { ...report, items: [{ ...report.items[0], content_digest: `sha256:${'d'.repeat(64)}` }] }, deployedPlatformCommit: report.platform_commit, corpusRoot, liveReleaseFacts: { platformVersion: '0.116.11' } }), /digest differs/);
        const applied = await reconcileExternalPublications({ store, report, deployedPlatformCommit: report.platform_commit, corpusRoot, liveReleaseFacts: { platformVersion: '0.116.11' }, now: NOW });
        assert.equal(applied.length, 1);
        assert.equal(applied[0].replay, false);
        assert.equal(store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state, 'externally-published');
        assert.equal(findLiveItem(store.db, 'track-2', semanticIdentity), null);
        assert.equal(ADO_STATE_MAP['externally-published'], 'Resolved');
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM observation_event WHERE item_id = ? AND evidence_digest = ?').get(itemId, applied[0].evidenceDigest).n, 1);
        const replay = await reconcileExternalPublications({ store, report, deployedPlatformCommit: report.platform_commit, corpusRoot, liveReleaseFacts: { platformVersion: '0.116.11' }, now: NOW });
        assert.equal(replay[0].replay, true);
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM state_transition_event WHERE item_id = ? AND to_state = 'externally-published'").get(itemId).n, 1);
    } finally {
        store.close();
        cleanupFixtures();
    }
});
