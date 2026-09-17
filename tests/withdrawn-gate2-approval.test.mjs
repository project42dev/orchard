import assert from "node:assert/strict";
import { test, after } from "node:test";
import { estate, seedGateItems, walkTo, cleanupFixtures, NOW } from "../scripts/test-fixtures.mjs";
import { generateUuidV7 } from "../scripts/lib/identity.mjs";
import { holdWithdrawnGate2Approvals } from "../scripts/lib/withdrawn-gate2-approval.mjs";

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
