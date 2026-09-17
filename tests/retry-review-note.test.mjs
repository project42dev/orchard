import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { failedReviewNoteFor } from '../scripts/generate-briefs.mjs';

test('a recovered draft receives the failed review from its immediately preceding revision', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE agent_handoff (item_id TEXT, item_revision INTEGER, status TEXT, role TEXT, completed_at TEXT, record_json TEXT)`);
    const insert = db.prepare('INSERT INTO agent_handoff VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('item-a', 1, 'failed', 'assessment-reviewer', '2026-09-15T00:00:00Z', JSON.stringify({ findings: [{ summary: 'Old finding' }] }));
    insert.run('item-a', 2, 'failed', 'assessment-reviewer', '2026-09-17T00:00:00Z', JSON.stringify({ findings: [{ summary: 'Recompute the RRF worked example' }] }));
    insert.run('item-a', 2, 'passed', 'factual-verifier', '2026-09-17T00:00:01Z', JSON.stringify({ findings: [{ summary: 'No factual errors' }] }));
    const note = failedReviewNoteFor(db, 'item-a', 3);
    assert.match(note, /Recompute the RRF worked example/);
    assert.doesNotMatch(note, /Old finding|No factual errors/);
    assert.equal(failedReviewNoteFor(db, 'item-a', 4), null);
  } finally {
    db.close();
  }
});
