// The historical-target repoint, against the real migrated schema.
//
// 173 currency items were recorded before Orchard was repointed onto
// project42-content. lib/publication.mjs refuses any item whose Gate 2 manifest
// names another repository -- correctly, and that refusal is not weakened here
// -- so every one of those items is permanently unpublishable until its
// recorded target moves.
//
// item_revision is append-only, enforced by a trigger, so the correction is a
// schema migration and not runtime code. These tests record legacy revisions
// through the store's own API exactly as production recorded them, run
// migration 011's real SQL, and prove three things: the rows it moves land on
// exactly the path contentRepositoryPathFor computes, the rows it refuses are
// untouched, and every refusal is named in the run log rather than left silent.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStateStore } from './lib/state-store.mjs';
import { canonicalJson, generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { PUBLICATION_REPOSITORY } from './lib/publication.mjs';
import { contentRepositoryPathFor } from './lib/track-2-controller.mjs';
import { MIGRATIONS_DIRECTORY } from './migrate-content-db.mjs';
import { reportUnmappedPublicationTargets } from './lib/publication-target-migration.mjs';
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from './test-fixtures.mjs';

const LEGACY_REPOSITORY = 'project42dev/project42-platform';
const MIGRATION_011 = readFileSync(join(MIGRATIONS_DIRECTORY, '011-repoint-publication-targets.sql'), 'utf8');

after(cleanupFixtures);

/**
 * Record a successor revision on the pre-repoint target, through recordItem,
 * exactly as production recorded every item before 2026-09-05: the platform
 * repository and the platform's content/ path layout. A fresh fixture database
 * is already at schema version 11, so the legacy row has to be created after
 * the migration has run -- which is why the test then re-runs 011's SQL. Its
 * WHERE clause makes that idempotent and is the only reason it is legitimate.
 */
async function recordLegacyRevision(store, runId, itemId, legacyPath) {
    const row = store.db.prepare(
        'SELECT current_revision, track, semantic_identity, current_state FROM workflow_item WHERE item_id = ?',
    ).get(itemId);
    const revision = Number(row.current_revision);
    const prior = JSON.parse(store.db.prepare(
        'SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?',
    ).get(itemId, revision).record_json);
    // Revisions are contiguous and append-only, so the legacy target is
    // recorded as the item's next revision rather than by editing the last one.
    await store.recordItem({
        ...prior,
        item_revision: revision + 1,
        state: row.current_state,
        artifact_digest: null,
        target: { repository: LEGACY_REPOSITORY, path: legacyPath },
        created_at: NOW,
        updated_at: NOW,
    });
    store.db.prepare('UPDATE workflow_item SET current_revision = ? WHERE item_id = ?').run(revision + 1, itemId);
    return revision + 1;
}

function applyMigration011(store) {
    store.db.exec(MIGRATION_011);
}

function liveRevision(dbPath, itemId) {
    const store = openStateStore(dbPath);
    try {
        return store.db.prepare(
            `SELECT r.target_repository, r.target_path, r.record_json
               FROM item_revision r JOIN workflow_item w ON w.item_id = r.item_id
              WHERE r.item_id = ? AND r.item_revision = w.current_revision`,
        ).get(itemId);
    } finally {
        store.close();
    }
}

test('every content layout is repointed onto exactly the path the mapping computes', async () => {
    const { store, runId, dbPath } = await estate();
    const ids = await seedGateItems(store, runId, ['currency-module', 'currency-resource', 'currency-diagram', 'currency-catalog']);
    const legacy = [
        'content/modules/ai-foundations/prompting.json',
        'content/resources/coding-tools/agents.json',
        'content/diagrams/agent-orchestration.mmd',
        'content/catalog.json',
    ];
    for (const [index, id] of ids.entries()) {
        await walkTo(store, runId, id, 'gate2-ready');
        await recordLegacyRevision(store, runId, id, legacy[index]);
    }

    // The precondition the whole migration exists for: as recorded, every one
    // of these is on the repository publication authority refuses.
    for (const id of ids) assert.equal(liveRevision(dbPath, id).target_repository, LEGACY_REPOSITORY);

    applyMigration011(store);
    store.close();

    for (const [index, id] of ids.entries()) {
        const row = liveRevision(dbPath, id);
        assert.equal(row.target_repository, PUBLICATION_REPOSITORY, `${id} is now publishable at all`);
        // The SQL's substr and lib/track-2-controller.mjs's own mapping must
        // agree exactly. This is the proof the migration's comment is not
        // merely asserting they do.
        assert.equal(row.target_path, contentRepositoryPathFor(legacy[index]));
        // The canonical item record is what a later Gate 2 manifest is built
        // from, so leaving it behind would repoint the columns and nothing that
        // reads them.
        const record = JSON.parse(row.record_json);
        assert.equal(record.target.repository, PUBLICATION_REPOSITORY);
        assert.equal(record.target.path, contentRepositoryPathFor(legacy[index]));
        assert.equal(row.record_json, canonicalJson(record), 'the rewritten record stays canonical JSON');
    }
});

test('a path the mapping cannot express is left alone, and named on every run', async () => {
    const { store, runId, dbPath } = await estate();
    const [mappable, unmappable] = await seedGateItems(store, runId, ['currency-ok', 'currency-odd']);
    for (const id of [mappable, unmappable]) await walkTo(store, runId, id, 'gate2-ready');
    await recordLegacyRevision(store, runId, mappable, 'content/modules/agentic-systems-and-mcp/mcp.json');
    // Not under content/: the corpus layout would have to have moved for this
    // to exist, and a guess here publishes into a tree no loader reads.
    await recordLegacyRevision(store, runId, unmappable, 'docs/architecture/overview.md');

    applyMigration011(store);

    assert.equal(liveRevision(dbPath, mappable).target_repository, PUBLICATION_REPOSITORY);
    const left = liveRevision(dbPath, unmappable);
    assert.equal(left.target_repository, LEGACY_REPOSITORY, 'reported is not the same as fixed');
    assert.equal(left.target_path, 'docs/architecture/overview.md');

    // A refusal expressed as a SQL WHERE clause is silent. The runtime's
    // read-only pass is what makes it audible, with the mapping function's own
    // message as the reason.
    const events = [];
    const report = reportUnmappedPublicationTargets({ store, log: (_level, event) => events.push(event) });
    store.close();
    assert.equal(report.unmapped.length, 1);
    assert.equal(report.unmapped[0].item, unmappable);
    assert.match(report.unmapped[0].reason, /must sit under content\//);
    assert.ok(events.includes('publication.target-migration.unmapped'), 'the refusal is named in the log, not only returned');
});

test('a revision a Gate 2 manifest already binds is refused, not rewritten under the evidence', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['currency-bound']);
    await walkTo(store, runId, id, 'gate2-ready');
    const revision = await recordLegacyRevision(store, runId, id, 'content/modules/ai-foundations/prompting.json');

    // The manifest observation is what publication authority actually reads,
    // and its evidence digest is computed over the manifest item, target
    // included. Rewriting the revision beneath it would not make the item
    // publishable and WOULD falsify the recorded evidence.
    const manifestItem = { item_id: id, item_revision: revision, target: { repository: LEGACY_REPOSITORY, path: 'content/modules/ai-foundations/prompting.json' } };
    store.recordObservation({
        observation_id: generateUuidV7(),
        run_id: runId,
        item_id: id,
        item_revision: revision,
        evidence_reference: `${GATE_MANIFEST_REFERENCE_PREFIX}gate-2:${id}`,
        evidence_digest: sha256Digest(manifestItem),
        observed_at: NOW,
        gate: 'gate-2',
        manifest_item: manifestItem,
    });

    applyMigration011(store);
    assert.equal(liveRevision(dbPath, id).target_repository, LEGACY_REPOSITORY, 'the recorded evidence is left exactly as it was');

    const report = reportUnmappedPublicationTargets({ store });
    store.close();
    assert.equal(report.unmapped.length, 1);
    assert.match(report.unmapped[0].reason, /reworked or denied by a human/);
});

test('the migration is idempotent and leaves a clean database silent', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await seedGateItems(store, runId, ['currency-idempotent']);
    await walkTo(store, runId, id, 'gate2-ready');
    await recordLegacyRevision(store, runId, id, 'content/modules/ai-foundations/prompting.json');

    applyMigration011(store);
    const first = liveRevision(dbPath, id);
    // It runs on every store open through the migration ledger, and re-running
    // its SQL must never double-strip the prefix or touch a corrected row.
    applyMigration011(store);
    applyMigration011(store);
    assert.deepEqual(liveRevision(dbPath, id), first);

    const events = [];
    const report = reportUnmappedPublicationTargets({ store, log: (_level, event) => events.push(event) });
    store.close();
    assert.equal(report.scanned, 0);
    assert.deepEqual(events, ['publication.target-migration.clear']);
});

test('the append-only trigger is back in place after the migration', async () => {
    const { store, runId } = await estate();
    const [id] = await seedGateItems(store, runId, ['currency-trigger']);
    await walkTo(store, runId, id, 'gate2-ready');
    await recordLegacyRevision(store, runId, id, 'content/modules/ai-foundations/prompting.json');
    applyMigration011(store);

    // The migration drops the guard to do its one legal write. If it did not
    // put it back, every later job could quietly edit history.
    assert.throws(
        () => store.db.prepare('UPDATE item_revision SET target_path = ? WHERE item_id = ?').run('modules/x.json', id),
        /item revisions are append-only/,
    );
    store.close();
});
