// An approved removal finding, all the way to publication.
//
// Before this, `removal` was one of Track 2's five actionable classifications
// and the only one with nowhere to go: generate-briefs had no brief form for it,
// so an approved removal finding was reported as stranded at every pass and
// never claimed. These tests drive one from a Gate 1 approval through the
// deterministic composition, the deletion commit, Gate 2 preparation, and into
// validateGate2PublicationAuthority -- the exact function that decides whether
// publication may proceed.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { validateGate2PublicationAuthority } from './lib/publication.mjs';
import { prepareRemovalCommit } from './lib/prepare-gate2-evidence.mjs';
import {
    deregisterLearningModule, deregisterDiagram, deregistrationFor,
    inboundReferences, redirectFor, removedIdForTarget, RemovalError,
} from './lib/removal.mjs';
import { executeRemovals } from './run-authoring.mjs';
import { heldAtGate } from './lib/gate-queue.mjs';
import { generateGateManifests } from './lib/gates.mjs';
import { estate, seedGateItems, cleanupFixtures, NOW } from './test-fixtures.mjs';

const GATE_POLICY = { provider: 'github', repository: 'project42dev/orchard', authorized_actor_ids: ['1001'] };
const GATE_TRUST = {
    authorization_policy_digest: sha256Digest(GATE_POLICY),
    adapter_digest: `sha256:${'8'.repeat(64)}`,
    adapter_identity: 'test:protected-github-adapter:v1',
};

/** A verified Gate 1 approval, the shape the store's protected path demands. */
function gateAuthority({ manifest, reviewedItem }) {
    const record = {
        schema_version: '1.0.0', event_id: generateUuidV7(), gate: 'gate-1', run_id: manifest.run_id,
        item_id: reviewedItem.item_id, item_revision: reviewedItem.item_revision,
        digest: reviewedItem.proposal_digest, decision: 'approve', reason: null, review_after: null,
        actor: { provider: 'github', immutable_id: '1001', authorized: true },
        source: { repository: 'project42dev/orchard', issue_number: 1, comment_id: 'removal-gate-1', comment_digest: `sha256:${'0'.repeat(64)}` },
        occurred_at: '2026-08-16T10:01:00Z', previous_state: 'gate1-pending', next_state: 'gate1-approved',
        supersedes_event_id: null, correlation_id: manifest.run_id,
    };
    const body = `/orchard gate1 approve item=${record.item_id} revision=${record.item_revision} digest=${record.digest}`;
    record.source.comment_digest = sha256Digest(body);
    const verifiedEvent = { body, repository: record.source.repository, comment_id: record.source.comment_id, actor: { immutable_id: record.actor.immutable_id } };
    return {
        schema_version: '1.0.0', queue_work_item_id: null,
        manifest, full_manifest_items: [structuredClone(reviewedItem)], current_item: structuredClone(reviewedItem),
        decision: record, verified_event: verifiedEvent, authorization_policy: GATE_POLICY,
        trust: { ...GATE_TRUST, provider_event_digest: sha256Digest(verifiedEvent) },
    };
}

after(cleanupFixtures);

const BASE_COMMIT = '1'.repeat(40);
const PREPARED_COMMIT = '3'.repeat(40);
const MODULE_PATH = 'modules/agentic-systems-and-mcp/obsolete-topic.json';
const REPOSITORY = 'project42dev/project42-content';

const CATALOG = JSON.stringify({
    schemaVersion: 1,
    paths: [
        { id: 'agentic-systems-and-mcp', title: 'Agentic Systems', moduleIds: ['obsolete-topic', 'embeddings'] },
        { id: 'other', title: 'Other', moduleIds: ['unrelated'] },
    ],
    modules: [{ id: 'obsolete-topic', title: 'Obsolete Topic' }, { id: 'embeddings', title: 'Embeddings' }],
}, null, 2) + '\n';

function siblingModule(id, prerequisites = []) {
    return JSON.stringify({ id, title: id, prerequisites }, null, 2);
}

/**
 * The Git Data API, faked. Same shape as test-registration.mjs's mock, plus the
 * directory listing and the sibling reads a removal makes.
 */
function removalFetchMock({ catalog = CATALOG, siblings = {}, targetPresent = true } = {}) {
    const calls = [];
    const trees = [];
    const blobs = [];
    const commits = [];
    const impl = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET' });
        const body = options.body ? JSON.parse(options.body) : null;
        const respond = (status, payload) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
        const file = (text) => respond(200, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64', sha: 'f'.repeat(40) });

        if (url.includes('/git/ref/heads/')) return respond(200, { object: { sha: BASE_COMMIT } });
        if (url.includes(`/git/commits/${BASE_COMMIT}`)) return respond(200, { tree: { sha: '2'.repeat(40) } });
        if (url.includes('/contents/catalog.json')) return file(catalog);
        if (url.includes(`/contents/${MODULE_PATH}`)) {
            return targetPresent ? file('{"id":"obsolete-topic"}') : respond(404, { message: 'Not Found' });
        }
        if (url.includes('/contents/modules/agentic-systems-and-mcp?') || url.endsWith('/contents/modules/agentic-systems-and-mcp')) {
            return respond(200, [
                { type: 'file', path: MODULE_PATH },
                ...Object.keys(siblings).map((path) => ({ type: 'file', path })),
            ]);
        }
        for (const [path, content] of Object.entries(siblings)) {
            if (url.includes(`/contents/${path}`)) return file(content);
        }
        if (url.endsWith('/git/blobs')) { blobs.push(body.content); return respond(201, { sha: `b${blobs.length}`.padEnd(40, '0') }); }
        if (url.endsWith('/git/trees')) { trees.push(body.tree); return respond(201, { sha: 't'.repeat(40) }); }
        if (url.endsWith('/git/commits') && options.method === 'POST') { commits.push(body.message); return respond(201, { sha: PREPARED_COMMIT }); }
        throw new Error(`unexpected fetch: ${url}`);
    };
    return { impl, calls, trees, blobs, commits };
}

// --- deregistration, the inverse of registration ------------------------------

test('a removed module leaves its learning path and the catalogue summaries', () => {
    const next = JSON.parse(deregisterLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, moduleId: 'obsolete-topic' }));
    assert.deepEqual(next.paths.find((entry) => entry.id === 'agentic-systems-and-mcp').moduleIds, ['embeddings']);
    assert.deepEqual(next.paths.find((entry) => entry.id === 'other').moduleIds, ['unrelated'], 'no other path is touched');
    assert.deepEqual(next.modules.map((entry) => entry.id), ['embeddings']);

    // Idempotent, like registration: a re-prepared revision must not produce a
    // second, spurious diff for a reviewer to read.
    const again = deregisterLearningModule({ registryText: JSON.stringify(next, null, 2) + '\n', targetPath: MODULE_PATH, moduleId: 'obsolete-topic' });
    assert.equal(JSON.parse(again).paths.find((entry) => entry.id === 'agentic-systems-and-mcp').moduleIds.length, 1);
});

test('a removed diagram leaves the diagram catalogue, and an unknown path is refused', () => {
    const catalogue = JSON.stringify([{ id: 'agent-orchestration' }, { id: 'other' }], null, 2) + '\n';
    const next = JSON.parse(deregisterDiagram({ registryText: catalogue, targetPath: 'diagrams/agent-orchestration.mmd' }));
    assert.deepEqual(next.map((entry) => entry.id), ['other']);
    assert.throws(() => removedIdForTarget('somewhere/else.json', 'learning'), RemovalError);
});

// --- the two questions a removal has to answer --------------------------------

test('a removal states whether a URL stops resolving, from the estate route rules', () => {
    // A module is listed on its learning path's page and has no page of its
    // own, so removing one orphans nothing.
    const module_ = redirectFor({ surface: 'learning', targetPath: MODULE_PATH });
    assert.equal(module_.needed, false);
    assert.match(module_.reason, /\/learn\/agentic-systems-and-mcp/);

    // A diagram serves at its own route, so removing one leaves a live URL
    // with nothing behind it, and the record has to say so.
    const diagram = redirectFor({ surface: 'guide-diagram', targetPath: 'diagrams/agent-orchestration.mmd' });
    assert.equal(diagram.needed, true);
    assert.equal(diagram.from, '/guide/diagrams/agent-orchestration');
    assert.equal(diagram.to, '/guide/diagrams');
});

test('the inbound scan reports what it did not read, so silence is never a clearance', () => {
    const report = inboundReferences({
        removedId: 'obsolete-topic', surface: 'learning', catalogText: CATALOG,
        siblings: [{ path: 'modules/agentic-systems-and-mcp/embeddings.json', content: siblingModule('embeddings', ['obsolete-topic']) }],
    });
    assert.deepEqual(report.found.map((entry) => entry.kind).sort(), ['listing', 'prerequisite', 'summary']);
    assert.ok(report.scanned.includes('catalog.json'));
    assert.ok(report.notScanned.some((entry) => /other learning paths/.test(entry)),
        'what was not looked at is stated, not implied by silence');
});

// --- the deletion commit -------------------------------------------------------

test('the deletion and its deregistration are one tree, so they merge together or not at all', async () => {
    const deregistered = deregisterLearningModule({ registryText: CATALOG, targetPath: MODULE_PATH, moduleId: 'obsolete-topic' });
    const mock = removalFetchMock({ catalog: CATALOG });
    const commit = await prepareRemovalCommit({
        repository: REPOSITORY, path: MODULE_PATH,
        deregistration: deregistrationFor({ surface: 'learning', targetPath: MODULE_PATH, removedId: 'obsolete-topic' }),
        token: 'test-token-literal', fetchImpl: mock.impl,
    });
    assert.equal(mock.trees.length, 1);
    assert.deepEqual(mock.trees[0].map((entry) => entry.path), [MODULE_PATH, 'catalog.json']);
    // sha: null is how the Git Data API says "this path is gone at this tree".
    assert.equal(mock.trees[0][0].sha, null);
    assert.equal(mock.blobs[0], deregistered, 'the catalogue is rewritten, not reformatted');
    assert.equal(commit.registeredIn, 'catalog.json');
    assert.match(mock.commits[0], /Remove modules\/agentic-systems-and-mcp\/obsolete-topic\.json and its entry in catalog\.json/);
});

test('a removal of a path that is already gone is refused, not reported as done', async () => {
    const mock = removalFetchMock({ targetPresent: false });
    await assert.rejects(
        () => prepareRemovalCommit({ repository: REPOSITORY, path: MODULE_PATH, token: 't', fetchImpl: mock.impl }),
        (error) => /is not present on/.test(error.message),
    );
    assert.equal(mock.trees.length, 0, 'an approval of a diff that changes nothing is never offered to a human');
});

// --- end to end ----------------------------------------------------------------

/** An approved, ADO-linked removal item claimed at executing, as the queue leaves it. */
async function approvedRemoval(store, runId) {
    // The Gate 1 approval, recorded the only way the store accepts one: a
    // verified decision carrying protected provider evidence. A removal is a
    // deletion from a live site, so the approval behind it has to be as real as
    // the approval behind anything else.
    store.provisionTrustAnchor({
        scope: 'gate', adapter_identity: GATE_TRUST.adapter_identity, adapter_digest: GATE_TRUST.adapter_digest,
        policy_digest: GATE_TRUST.authorization_policy_digest, policy: GATE_POLICY, provisioned_at: '2026-08-01T00:00:00.000Z',
    });
    const [id] = await seedGateItems(store, runId, ['obsolete-topic']);
    const heldItems = heldAtGate(store.db, 'gate-1', 'track-1').map(({ track: _track, ...entry }) => entry);
    const [manifest] = await generateGateManifests({ gate: 'gate-1', runId, track: 'track-1', items: heldItems });
    const reviewedItem = heldItems.find((entry) => entry.item_id === id);
    await store.recordVerifiedDecision(gateAuthority({ manifest, reviewedItem }));

    const externalKey = `orchard:track-1:${id}:r1`;
    store.recordExternalLink({
        link_id: generateUuidV7(), run_id: runId, item_id: id, item_revision: 1,
        provider: 'ado', operation: 'ado-link', external_key: externalKey, external_id: '424242',
        linked_at: NOW,
    });
    for (const [from, to, cause] of [['gate1-approved', 'ado-linked', 'ado-reconciled'], ['ado-linked', 'executing', 'execution-started']]) {
        await store.recordTransition({
            schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: runId, item_id: id,
            item_revision: 1, from_state: from, to_state: to, cause,
            actor: 'test-fixture', occurred_at: NOW, correlation_id: generateUuidV7(),
        });
    }
    // The target of record is the item revision's, not one this fixture
    // invents: the gate manifest is built from that column, so a made-up
    // path here would prove nothing about the item the owner actually sees.
    const recorded = store.db.prepare('SELECT target_path FROM item_revision WHERE item_id = ? AND item_revision = 1').get(id);
    return {
        subjectId: id, itemId: id, track: 'track-1', surface: 'learning',
        itemRevision: 1, originRunId: runId, state: 'executing',
        title: 'removal: obsolete-topic', target: { repository: REPOSITORY, path: recorded.target_path },
        rationale: 'The provider retired the feature this module teaches.',
        evidence: ['https://vendor.example/deprecation'],
    };
}

test('an approved removal reaches publication, and the owner reads the removal record itself', async () => {
    const { store, runId, dbPath } = await estate();
    const removal = await approvedRemoval(store, runId);
    const mock = removalFetchMock({ siblings: { 'modules/agentic-systems-and-mcp/embeddings.json': siblingModule('embeddings', []) } });

    const summary = await executeRemovals({
        store, removals: [removal], now: NOW, env: {}, log: (level, event, detail) => { if (level !== 'info') console.error(event, JSON.stringify(detail)); },
        fetchImpl: mock.impl, readGateTokenImpl: async () => 'test-token-literal',
    });
    assert.deepEqual(summary, { prepared: 1, held: 0 });
    assert.equal(
        store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(removal.itemId).current_state,
        'gate2-pending',
        'the removal is in front of a human, which is the point of Gate 2',
    );

    const observation = store.db.prepare(
        'SELECT record_json FROM observation_event WHERE item_id = ? AND evidence_reference = ?',
    ).get(removal.itemId, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-2:${removal.itemId}`);
    const manifestItem = JSON.parse(observation.record_json).manifest_item;

    // The content the owner sees is the removal record itself, not a wall of
    // digests about a file they cannot watch being deleted.
    const record = JSON.parse(manifestItem.content);
    assert.equal(record.kind, 'content-removal');
    assert.equal(record.removed.path, MODULE_PATH);
    assert.equal(record.removed.id, 'obsolete-topic');
    assert.equal(record.rationale.summary, removal.rationale);
    assert.equal(record.catalogue.registry, 'catalog.json');
    assert.deepEqual(record.inbound.found, []);
    assert.equal(record.redirect.needed, false);
    // Nothing was drafted, so nothing was spent, and the record says so rather
    // than reporting a review that never happened.
    assert.deepEqual(manifestItem.cost, { currency: 'USD', amount: 0 });
    assert.equal(manifestItem.factual_review.status, 'human-review');
    assert.deepEqual(manifestItem.tests.map((entry) => entry.status), ['passed', 'passed', 'passed']);

    // PUBLICATION AUTHORITY. This is the function that decides whether a
    // publication may proceed at all. The manifest is built by the runtime's
    // own generator from what the removal actually recorded -- not hand-shaped
    // here, or the test would prove only that a hand-shaped object validates.
    const gate2Items = heldAtGate(store.db, 'gate-2', 'track-1').map(({ track: _track, ...entry }) => entry);
    const [gate2Manifest] = await generateGateManifests({ gate: 'gate-2', runId, track: 'track-1', items: gate2Items });
    const reviewed = gate2Items.find((entry) => entry.item_id === removal.itemId);
    assert.ok(reviewed, 'the removal is held at Gate 2 like any other item');

    const decision = {
        schema_version: '1.0.0', event_id: generateUuidV7(), gate: 'gate-2', run_id: runId,
        item_id: removal.itemId, item_revision: reviewed.item_revision,
        digest: reviewed.artifact_digest, decision: 'approve', reason: null, review_after: null,
        actor: { provider: 'github', immutable_id: '1001', authorized: true },
        source: { repository: 'project42dev/orchard', issue_number: 2, comment_id: 'removal-gate-2', comment_digest: sha256Digest('approve') },
        occurred_at: NOW, previous_state: 'gate2-pending', next_state: 'gate2-approved',
        supersedes_event_id: null, correlation_id: runId,
    };
    const authority = await validateGate2PublicationAuthority({
        manifest: gate2Manifest, full_manifest_items: gate2Items, decision, current_item: reviewed,
    });
    store.close();
    assert.equal(authority.item_id, removal.itemId);
    // The removal is publishable: the target is the content repository, and the
    // base commit is the one the deletion was prepared against.
    assert.deepEqual(authority.target, { repository: REPOSITORY, path: MODULE_PATH });
    assert.equal(authority.base_commit, BASE_COMMIT);
    assert.ok(dbPath);
});


test('a removal something still points at holds, with the referrers named', async () => {
    const { store, runId } = await estate();
    const removal = await approvedRemoval(store, runId);
    // A sibling module still lists it as a prerequisite. Removing it would
    // break a page that works today.
    const mock = removalFetchMock({ siblings: { 'modules/agentic-systems-and-mcp/embeddings.json': siblingModule('embeddings', ['obsolete-topic']) } });

    const held = [];
    const summary = await executeRemovals({
        store, removals: [removal], now: NOW, env: {},
        log: (_level, event, detail) => { if (event === 'removal.held') held.push(detail); },
        fetchImpl: mock.impl, readGateTokenImpl: async () => 'test-token-literal',
    });
    const state = store.db.prepare('SELECT current_state FROM workflow_item WHERE item_id = ?').get(removal.itemId).current_state;
    store.close();

    assert.deepEqual(summary, { prepared: 0, held: 1 });
    assert.match(held[0].reason, /break a page that works today/);
    assert.ok(held[0].referrers.some((entry) => /embeddings\.json prerequisites/.test(entry)),
        'the referrer is named so a human can decide what to do about it');
    assert.equal(state, 'executing', 'nothing is deleted and nothing is put in front of the owner');
    assert.equal(mock.commits.length, 0, 'no commit object is created for a removal that will not go ahead');
});
