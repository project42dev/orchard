import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "./lib/state-store.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { quarantineGate2Refusals } from "./lib/quarantine-gate2-refusals.mjs";
import { createTrack2RunRecord } from "./lib/track-2-controller.mjs";

const DIGEST = `sha256:${"0".repeat(64)}`;
const TARGET = { repository: "project42dev/project42-content", path: "resources/test/example.json" };

test("legacy refusal leaves Gate 2 without recording a human decision or touching a real draft", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchard-refusal-recovery-"));
    const store = openStateStore(join(directory, "state.db"));
    try {
        const runId = generateUuidV7();
        const timestamp = "2026-09-16T00:00:00.000Z";
        await store.recordRun(createTrack2RunRecord({
            runId, mode: "full", partitionSize: 50, concurrency: 1,
            contentCommit: "0".repeat(40), implementationCommit: "0".repeat(40),
        }, { expected: 2, enumerated: 2, inspected: 2, gaps: 0 }, "running", timestamp, null, 2));

        const add = (content) => {
            const id = generateUuidV7();
            const artifact = sha256Digest(content);
            const item = { item_id: id, item_revision: 1, artifact_digest: artifact,
                content, target: TARGET, proposal_digest: DIGEST };
            store.db.prepare(`INSERT INTO workflow_item
                (item_id,origin_run_id,track,semantic_identity,surface,outcome,current_revision,current_state,created_at,updated_at)
                VALUES (?,?,'track-2',?,'guide','correction',1,'gate2-pending',?,?)`)
                .run(id, runId, id, timestamp, timestamp);
            store.db.prepare(`INSERT INTO item_revision
                (item_id,item_revision,run_id,proposal_digest,artifact_digest,target_repository,target_path,lifecycle_key,record_json,created_at)
                VALUES (?,1,?,?,?,?,?,?,?,?)`)
                .run(id, runId, DIGEST, artifact, TARGET.repository, TARGET.path, id,
                    JSON.stringify({ proposal_digest: DIGEST, artifact_digest: artifact, target: TARGET }), timestamp);
            store.recordObservation({ observation_id: generateUuidV7(), run_id: runId,
                item_id: id, item_revision: 1,
                evidence_reference: `orchard/gate-manifest/gate-2:${id}`,
                evidence_digest: sha256Digest(item), observed_at: timestamp, manifest_item: item });
            return id;
        };
        const refused = add(JSON.stringify({ status: "BLOCKED", reason: "Existing source was missing", requiredInputs: ["source"] }));
        const valid = add(JSON.stringify({
            id: "valid", slug: "valid", title: "Existing draft", summary: "summary",
            category: "test", format: "checklist", audience: [], level: "beginner",
            providers: [], prerequisites: [], owner: "test", reviewCadenceDays: 30,
            lastVerified: "2026-09-16", tags: [], sections: [], sources: [],
        }));
        const result = await quarantineGate2Refusals({ store, track: "track-2", now: timestamp });
        assert.deepEqual(result, { scanned: 2, blocked: 1, errors: 0 });
        assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(refused).current_state, "blocked");
        assert.equal(store.db.prepare("SELECT current_state FROM workflow_item WHERE item_id = ?").get(valid).current_state, "gate2-pending");
        assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM decision_event").get().n, 0);
        assert.deepEqual(await quarantineGate2Refusals({ store, track: "track-2", now: timestamp }),
            { scanned: 1, blocked: 0, errors: 0 });
    } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
