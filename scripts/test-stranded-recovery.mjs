// Automatic, bounded recovery of items stranded at gate2-ready.
//
// 114 items sat at gate2-ready with `gate2.prep.no-evidence` logged against
// them on every run. The recovery existed -- apply-blocked-retry.mjs covers
// gate2-ready -- but nothing drove it: an operator had to name each of 114
// items by hand. These tests prove an item is recovered without anyone naming
// it, that the recovery is capped so it cannot quietly spend a budget, and that
// every refusal is named rather than retried blind.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { openStateStore } from './lib/state-store.mjs';
import { PUBLICATION_REPOSITORY } from './lib/publication.mjs';
import {
    recoverStrandedItems, resolveRecoveryBounds, STRANDED_ACTOR,
    DEFAULT_MAX_ITEMS, DEFAULT_MAX_ATTEMPTS,
} from './lib/stranded-recovery.mjs';
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from './test-fixtures.mjs';

after(cleanupFixtures);

function stateOf(dbPath, itemId) {
    const store = openStateStore(dbPath);
    try {
        return store.db.prepare('SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?').get(itemId);
    } finally {
        store.close();
    }
}

async function strandItems(store, runId, terms) {
    const ids = await seedGateItems(store, runId, terms);
    for (const id of ids) await walkTo(store, runId, id, 'gate2-ready');
    return ids;
}

test('a stranded item is recovered without an operator naming it', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-alpha']);
    const before = stateOf(dbPath, id);
    assert.equal(before.current_state, 'gate2-ready');

    // No item id is passed. The sweep finds it, which is the whole point: the
    // recovery path already existed and was reachable only by hand.
    const events = [];
    const summary = await recoverStrandedItems({ store, now: NOW, log: (_l, event) => events.push(event) });
    store.close();

    assert.equal(summary.stranded, 1);
    assert.equal(summary.recovered.length, 1);
    assert.equal(summary.recovered[0].item, id);
    assert.equal(summary.remaining, 0);
    const after_ = stateOf(dbPath, id);
    assert.equal(after_.current_state, 'executing', 'reopened where generate-briefs already looks');
    assert.equal(Number(after_.current_revision), Number(before.current_revision) + 1, 'a fresh revision, never an edited one');
    assert.ok(events.includes('gate2.stranded.recovered'));
    assert.ok(events.includes('gate2.stranded.summary'), 'the sweep reports itself every run, not only when it fails');
});

test('the sweep is capped per run, and says how much is left', async () => {
    const { store, runId, dbPath } = await estate();
    const ids = await strandItems(store, runId, ['stranded-a', 'stranded-b', 'stranded-c', 'stranded-d']);

    // Every recovered item is re-drafted by the ensemble, so the cap is a spend
    // cap. A sweep that worked the whole backlog off in one run would be a
    // budget disappearing without anyone deciding to spend it.
    const summary = await recoverStrandedItems({ store, now: NOW, env: { ORCHARD_STRANDED_RECOVERY_MAX_ITEMS: '2' } });
    store.close();

    assert.equal(summary.stranded, 4);
    assert.equal(summary.recovered.length, 2);
    assert.equal(summary.remaining, 2, 'the backlog still waiting is reported, not implied');
    const recovered = new Set(summary.recovered.map((entry) => entry.item));
    assert.equal(ids.filter((id) => recovered.has(id)).length, 2);
    for (const id of ids) {
        assert.equal(stateOf(dbPath, id).current_state, recovered.has(id) ? 'executing' : 'gate2-ready');
    }
});

test('an item that keeps coming back is named for a human, not retried forever', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-stubborn']);
    const env = { ORCHARD_STRANDED_RECOVERY_MAX_ATTEMPTS: '1' };

    const first = await recoverStrandedItems({ store, now: NOW, env });
    assert.equal(first.recovered.length, 1);

    // Strand it again, exactly as a second failed authoring attempt would.
    await walkTo(store, runId, id, 'gate2-ready');
    assert.equal(stateOf(dbPath, id).current_state, 'gate2-ready');

    const events = [];
    const second = await recoverStrandedItems({ store, now: NOW, env, log: (_l, event) => events.push(event) });
    store.close();

    assert.equal(second.recovered.length, 0);
    assert.equal(second.refused.length, 1);
    assert.equal(second.refused[0].item, id);
    assert.match(second.refused[0].reason, /already recovered automatically 1 time\(s\)/);
    assert.ok(events.includes('gate2.stranded.refused'));
    assert.equal(stateOf(dbPath, id).current_state, 'gate2-ready', 'it stays put, visibly, for a human');
});

test('the attempt count is read from the recovery transitions themselves', async () => {
    const { store, runId } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-counted']);
    await recoverStrandedItems({ store, now: NOW });
    const rows = store.db.prepare(
        `SELECT count(*) AS n FROM state_transition_event
          WHERE item_id = ? AND to_state = 'executing' AND cause = 'revision-created'
            AND json_extract(record_json, '$.actor') = ?`,
    ).get(id, STRANDED_ACTOR);
    store.close();
    // Counted from the append-only record rather than a counter column, so the
    // count cannot drift from what actually happened.
    assert.equal(Number(rows.n), 1);
});

test('an item still pointing at the old repository is refused, not re-drafted into the product repo', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-mistargeted']);
    // Recorded before the content-repository repoint, and migration 011 could
    // not map it. Re-authoring it would prepare a commit into the product
    // repository -- the exact drift publication authority exists to refuse --
    // and spend to do it.
    const revision = Number(stateOf(dbPath, id).current_revision);
    store.db.exec('DROP TRIGGER IF EXISTS no_update_item_revision');
    store.db.prepare('UPDATE item_revision SET target_repository = ? WHERE item_id = ? AND item_revision = ?')
        .run('project42dev/project42-platform', id, revision);
    store.db.exec("CREATE TRIGGER IF NOT EXISTS no_update_item_revision BEFORE UPDATE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;");

    const summary = await recoverStrandedItems({ store, now: NOW });
    store.close();

    assert.equal(summary.recovered.length, 0);
    assert.equal(summary.refused.length, 1);
    assert.match(summary.refused[0].reason, new RegExp(`not ${PUBLICATION_REPOSITORY}`));
    assert.equal(stateOf(dbPath, id).current_state, 'gate2-ready');
});

// Rewrite one item's recorded target path in place. item_revision is
// append-only by trigger, exactly as the mistargeted-repository test above has
// to work around, and a second revision would not reproduce the defect: these
// items carry ONE revision whose target was wrong from the first authoring pass.
function retarget(store, dbPath, itemId, targetPath) {
    const revision = Number(stateOf(dbPath, itemId).current_revision);
    store.db.exec('DROP TRIGGER IF EXISTS no_update_item_revision');
    store.db.prepare('UPDATE item_revision SET target_path = ? WHERE item_id = ? AND item_revision = ?')
        .run(targetPath, itemId, revision);
    store.db.exec("CREATE TRIGGER IF NOT EXISTS no_update_item_revision BEFORE UPDATE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;");
}

test('a target path no surface publishes to is refused before a single token is spent', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-untargetable']);
    // `registration.unrecognized-target`, 1 distinct item over two days of
    // production logs. It never was stranded by the container-disk bug: it
    // failed structurally on its first authoring pass and was swept up here,
    // and a retry re-authors against the SAME target, so every recovery since
    // has paid to reach the identical hold.
    retarget(store, dbPath, id, 'catalog.json');

    let spent = 0;
    const events = [];
    const summary = await recoverStrandedItems({
        store, now: NOW, log: (_l, event) => events.push(event),
        retry: async () => { spent += 1; return { retried: 1, revision: 2, errors: [] }; },
    });
    store.close();

    assert.equal(spent, 0, 'the drafter is never reached, which is the entire point of the check');
    assert.equal(summary.recovered.length, 0);
    assert.equal(summary.refused.length, 1);
    assert.match(summary.refused[0].reason, /registration\.unrecognized-target/, 'the refusal names the code, so a human can act on it');
    assert.match(summary.refused[0].reason, /re-authoring cannot change the target/);
    assert.ok(events.includes('gate2.stranded.refused'));
    assert.equal(stateOf(dbPath, id).current_state, 'gate2-ready', 'it stays put, visibly, for a human to re-target');
});

test('a diagram at a path the diagram catalogue cannot key is refused the same way', async () => {
    const { store, runId, dbPath } = await estate();
    const [id] = await strandItems(store, runId, ['stranded-misfiled-diagram']);
    // `registration.unrecognized-diagram-path`, the other permanent hold in the
    // measured distribution. surfaceForTargetPath accepts it -- it is under
    // diagrams/ -- so only the per-surface check catches it, which is why the
    // pre-filter runs both and not just the first.
    retarget(store, dbPath, id, 'diagrams/agent-loop.md');

    let spent = 0;
    const summary = await recoverStrandedItems({
        store, now: NOW, retry: async () => { spent += 1; return { retried: 1, revision: 2, errors: [] }; },
    });

    assert.equal(spent, 0);
    assert.equal(summary.refused.length, 1);
    assert.match(summary.refused[0].reason, /registration\.unrecognized-diagram-path/);

    // And the attempt cap is untouched by a refusal, so nothing is counted
    // against an item that was never re-drafted.
    const attempts = store.db.prepare(
        `SELECT count(*) AS n FROM state_transition_event
          WHERE item_id = ? AND to_state = 'executing' AND cause = 'revision-created'
            AND json_extract(record_json, '$.actor') = ?`,
    ).get(id, STRANDED_ACTOR);
    store.close();
    assert.equal(Number(attempts.n), 0);
});

test('a legal target path is not refused by the pre-filter', async () => {
    const { store, runId, dbPath } = await estate();
    const [module_, resource] = await strandItems(store, runId, ['stranded-legal-module', 'stranded-legal-resource']);
    // The guide surface has no per-surface path rule -- a resource indexes
    // itself wherever under resources/ it sits -- so the pre-filter must pass
    // it through rather than inventing one. A check that refuses real work is
    // worse than no check.
    retarget(store, dbPath, resource, 'resources/coding-agents/ai-assisted-code-review-checklist.json');

    const summary = await recoverStrandedItems({ store, now: NOW });
    store.close();

    assert.equal(summary.refused.length, 0, `nothing refused, got: ${summary.refused.map((e) => e.reason).join('; ')}`);
    assert.deepEqual(summary.recovered.map((entry) => entry.item).sort(), [module_, resource].sort());
});

test('items this run just moved are left to this run, and the bounds have conservative defaults', async () => {
    const { store, runId, dbPath } = await estate();
    const [fresh, older] = await strandItems(store, runId, ['stranded-fresh', 'stranded-older']);

    // The evidence attempt for an item this run just authored is this run's
    // own; sweeping it here would pay for one item twice.
    const summary = await recoverStrandedItems({ store, now: NOW, exclude: [fresh] });
    store.close();
    assert.equal(summary.stranded, 1);
    assert.deepEqual(summary.recovered.map((entry) => entry.item), [older]);
    assert.equal(stateOf(dbPath, fresh).current_state, 'gate2-ready');

    assert.deepEqual(resolveRecoveryBounds({}), { maxItems: DEFAULT_MAX_ITEMS, maxAttempts: DEFAULT_MAX_ATTEMPTS });
    assert.equal(DEFAULT_MAX_ITEMS, 5, 'small on purpose: each recovered item is re-drafted and that spends');
    // A malformed override must not silently widen the cap.
    assert.deepEqual(
        resolveRecoveryBounds({ ORCHARD_STRANDED_RECOVERY_MAX_ITEMS: 'lots' }),
        { maxItems: DEFAULT_MAX_ITEMS, maxAttempts: DEFAULT_MAX_ATTEMPTS },
    );
    assert.equal(resolveRecoveryBounds({ ORCHARD_STRANDED_RECOVERY_MAX_ITEMS: '0' }).maxItems, 0, 'the sweep can be switched off');
});
