import test from 'node:test';
import assert from 'node:assert/strict';
import { estate, candidate, walkTo, cleanupFixtures, NOW } from './test-fixtures.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { persistDiscoveryItems, findLiveItem } from './lib/gate-queue.mjs';
import { reconcileExternalPublications } from './lib/external-publication-reconciliation.mjs';
import { ADO_STATE_MAP } from './ado-sync.mjs';
import { sha256Digest } from './lib/identity.mjs';

test('catalog reconciliation binds the selected item, its package, and its current Orchard identity before writing', async () => {
    const { store, runId, directory } = await estate('track-2');
    try {
        const saved = await persistDiscoveryItems({store, runId, track:'track-2', now:NOW, candidates:[candidate('catalog-delivery', {targetPath:'catalog.json', canonicalContentId:'learning-module:review-agent-results'})]});
        const itemId = saved.items[0].item_id;
        await walkTo(store, runId, itemId, 'ado-linked');
        const corpusRoot = join(directory, 'platform');
        const module = {id:'review-agent-results',title:'Review results'};
        const catalog = {modules:[module,{id:'other',title:'Other'}],paths:[{id:'reliable-agent-workflows',moduleIds:['review-agent-results','other']}],resources:[]};
        mkdirSync(join(corpusRoot,'content'),{recursive:true});
        writeFileSync(join(corpusRoot,'content/catalog.json'),JSON.stringify(catalog));
        const packagePath = 'training/reliable-agent-workflows/review-agent-results/class-script.json';
        mkdirSync(dirname(join(corpusRoot,'content',packagePath)),{recursive:true});
        writeFileSync(join(corpusRoot,'content',packagePath),JSON.stringify({id:'review-class'}));
        const entry = {item_id:itemId,ado_id:424242,revision:1,path:'catalog.json',canonical_content_id:'learning-module:review-agent-results',content_digest:sha256Digest(module),live_url:'https://project-42.dev/learn/reliable-agent-workflows/review-agent-results',content_prs:['https://github.com/project42dev/project42-content/pull/77'],supporting_artifacts:[{path:packagePath,digest:sha256Digest({id:'review-class'})}]};
        const report = {schema_version:'1.0.0',kind:'external-publication-reconciliation',content_commit:'a'.repeat(40),platform_commit:'b'.repeat(40),site_commit:'c'.repeat(40),platform_version:'0.116.12',items:[entry]};
        const run = (item=entry) => reconcileExternalPublications({store,report:{...report,items:[item]},deployedPlatformCommit:report.platform_commit,corpusRoot,liveReleaseFacts:{platformVersion:'0.116.12'},now:NOW});
        await assert.rejects(run({...entry,canonical_content_id:undefined}),/exact supported/);
        await assert.rejects(run({...entry,canonical_content_id:'learning-module:other',content_digest:sha256Digest(catalog.modules[1]),live_url:'https://project-42.dev/learn/reliable-agent-workflows/other'}),/live Orchard target/);
        await assert.rejects(run({...entry,supporting_artifacts:[{path:packagePath,digest:`sha256:${'0'.repeat(64)}`}]}),/supporting artifact digest/);
        await assert.rejects(run({...entry,supporting_artifacts:[{path:'../outside.json',digest:entry.content_digest}]}),/invalid supporting artifact/);
        assert.equal(store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(itemId).current_state,'ado-linked');
        assert.equal((await run())[0].replay,false);
        assert.equal((await run())[0].replay,true);
    } finally {store.close();cleanupFixtures();}
});

for (const kind of ['learning-path','guide','diagram']) test(`${kind} reconciliation uses exact content and the correct public route`, async () => {
    const {store,runId,directory}=await estate('track-2');
    try {
        const isDiagram=kind==='diagram';
        const targetPath=isDiagram?'diagrams/test-diagram.mmd':'catalog.json';
        const canonicalContentId=isDiagram?null:`${kind}:test-target`;
        const saved=await persistDiscoveryItems({store,runId,track:'track-2',now:NOW,candidates:[candidate(`delivery-${kind}`,{targetPath,canonicalContentId})]});
        const itemId=saved.items[0].item_id;await walkTo(store,runId,itemId,'ado-linked');
        const corpusRoot=join(directory,'platform');mkdirSync(dirname(join(corpusRoot,'content',targetPath)),{recursive:true});
        const value=isDiagram?'flowchart LR\n A --> B\n':{id:'test-target',moduleIds:[]};
        writeFileSync(join(corpusRoot,'content',targetPath),isDiagram?value.replaceAll('\n','\r\n'):JSON.stringify({paths:kind==='learning-path'?[value]:[],resources:kind==='guide'?[value]:[]}));
        const entry={item_id:itemId,ado_id:424242,revision:1,path:targetPath,...(canonicalContentId?{canonical_content_id:canonicalContentId}:{}),content_digest:sha256Digest(value),live_url:`https://project-42.dev/${isDiagram?'guide/diagrams/test-diagram':kind==='guide'?'guide/resources/test-target':'learn/test-target'}`,content_prs:['https://github.com/project42dev/project42-content/pull/77']};
        const report={schema_version:'1.0.0',kind:'external-publication-reconciliation',content_commit:'a'.repeat(40),platform_commit:'b'.repeat(40),site_commit:'c'.repeat(40),platform_version:'0.116.12',items:[entry]};
        const args={store,report,deployedPlatformCommit:report.platform_commit,corpusRoot,liveReleaseFacts:{platformVersion:'0.116.12'},now:NOW};
        await assert.rejects(reconcileExternalPublications({...args,report:{...report,items:[{...entry,live_url:'https://project-42.dev/guide'}]}}),/URL differs/);
        assert.equal((await reconcileExternalPublications(args))[0].replay,false);
    } finally {store.close();cleanupFixtures();}
});

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
