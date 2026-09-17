import assert from "node:assert/strict";
import { test, after } from "node:test";
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from "../scripts/test-fixtures.mjs";
import { generateUuidV7 } from "../scripts/lib/identity.mjs";
import { holdWithdrawnGate2Approvals, holdStalePublicationApprovals, holdUnsafeGate2Drafts } from "../scripts/lib/withdrawn-gate2-approval.mjs";

after(cleanupFixtures);

test("a withdrawn approval blocks the exact open publication revision", async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ["withdrawn-publication"]);
    await walkTo(store, runId, itemId, "publication-pr-open");
    const eventId = generateUuidV7();
    store.db.prepare(`INSERT INTO decision_event
      (event_id, gate, run_id, item_id, item_revision, digest, decision,
       actor_provider, actor_immutable_id, source_repository, source_issue_number,
       source_comment_id, correlation_id, idempotency_key, occurred_at, record_json)
      VALUES (?, 'gate-2', ?, ?, 1, ?, 'approve', 'github', '42', ?, 1, ?, ?, ?, ?, ?)`)
        .run(eventId, runId, itemId, `sha256:${"a".repeat(64)}`, "project42dev/orchard", "123", generateUuidV7(), eventId, NOW, "{}");
    const held = await holdWithdrawnGate2Approvals({ store, items: [{ itemId, revision: 1 }], now: NOW });
    assert.equal(held.length, 1);
    assert.equal(held[0].previousState, "publication-pr-open");
    assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId).current_state, "blocked");
    await assert.rejects(() => holdWithdrawnGate2Approvals({ store, items: [{ itemId, revision: 1 }], now: NOW }), /not a holdable approval/);
    store.close();
});

test("unsafe pending Gate 2 evidence can be held without approving it", async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ["unsafe-gate2"]);
    await walkTo(store, runId, itemId, "gate2-pending");
    const result = await holdUnsafeGate2Drafts({ store, items: [{ itemId, revision: 1 }], now: NOW });
    assert.equal(result.held.length, 1);
    assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId).current_state, "blocked");
    const replay = await holdUnsafeGate2Drafts({ store, items: [{ itemId, revision: 1 }], now: NOW });
    assert.equal(replay.held.length, 0);
    assert.equal(replay.skipped[0].state, "blocked");
    store.close();
});

test("a closed stale PR blocks its exact approved revision", async () => {
    const { store, runId } = await estate();
    const [itemId] = await seedGateItems(store, runId, ["stale-publication"]);
    await walkTo(store, runId, itemId, "publication-pr-open");
    const eventId = generateUuidV7();
    store.db.prepare(`INSERT INTO decision_event
      (event_id, gate, run_id, item_id, item_revision, digest, decision,
       actor_provider, actor_immutable_id, source_repository, source_issue_number,
       source_comment_id, correlation_id, idempotency_key, occurred_at, record_json)
      VALUES (?, 'gate-2', ?, ?, 1, ?, 'approve', 'github', '42', ?, 1, ?, ?, ?, ?, ?)`)
        .run(eventId, runId, itemId, `sha256:${"a".repeat(64)}`, "project42dev/orchard", "123", generateUuidV7(), eventId, NOW, "{}");
    const result = await holdStalePublicationApprovals({ store, items: [{ itemId, revision: 1 }], now: NOW });
    assert.equal(result.held[0].previousState, "publication-pr-open");
    assert.deepEqual(result.skipped, []);
    assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(itemId).current_state, "blocked");
    assert.match(store.listTransitions(itemId).at(-1).reason, /target changed/);
    const replay = await holdStalePublicationApprovals({ store, items: [{ itemId, revision: 1 }], now: NOW });
    assert.equal(replay.held.length, 0);
    assert.equal(replay.skipped[0].state, "blocked");
    store.close();
});
