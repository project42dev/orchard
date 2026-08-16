-- 008: a decision_event's provider-comment uniqueness includes the item.
--
-- WHY. ADR-0025, amendment 2026-08-16: a bare "approve" or "approved"
-- comment on a gate issue now decides every item still pending on that
-- issue, not the one item a structured command would name. That comment
-- carries a single comment_id but can legitimately produce several
-- decision_event rows, one per item. The table's own UNIQUE
-- (source_repository, source_comment_id) constraint predates that and
-- assumed exactly the opposite: one comment, one decision. The first bare
-- approve on a multi-item issue proved this in scripts/test-apply-gate-
-- decisions.mjs before it ever reached a live gate: item two and three of
-- three both failed with "UNIQUE constraint failed:
-- decision_event.source_repository, decision_event.source_comment_id"
-- while the first item's decision recorded correctly.
--
-- WHAT CHANGES. The constraint becomes UNIQUE (source_repository,
-- source_comment_id, item_id): still refuses two different decisions
-- recorded under the same comment for the SAME item (a real replay), still
-- lets the exact-replay path in recordVerifiedDecision reconcile a retried
-- run, and now also permits the same comment to legitimately decide
-- multiple distinct items. The idempotency_key column's own UNIQUE
-- constraint is untouched; scripts/lib/state-store.mjs's fallback key
-- construction was widened to include item_id in the same change that
-- motivated this migration, so the two stay in agreement.
--
-- HOW. Same documented table-rebuild procedure as migrations 006 and 007,
-- because SQLite cannot alter a table constraint in place: create the
-- corrected table, copy every row unchanged (event_id and every other
-- column keep their exact values, so every existing foreign key reference
-- from gate_decision_authority, closure_packet, and protected_authority
-- stays valid), drop the original, rename, then recreate the index and the
-- two immutability triggers DROP TABLE removes along with it. The migration
-- runner disables foreign key enforcement for the duration and runs a full
-- foreign_key_check afterward, which is the proof the swap left every
-- reference intact.

CREATE TABLE decision_event_rebuilt (
  event_id TEXT PRIMARY KEY,
  gate TEXT NOT NULL CHECK (gate IN ('gate-1', 'gate-2')),
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny', 'defer', 'request-changes')),
  actor_provider TEXT NOT NULL,
  actor_immutable_id TEXT NOT NULL,
  source_repository TEXT NOT NULL,
  source_issue_number INTEGER NOT NULL CHECK (source_issue_number > 0),
  source_comment_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  supersedes_event_id TEXT REFERENCES decision_event(event_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  UNIQUE (source_repository, source_comment_id, item_id)
);

INSERT INTO decision_event_rebuilt
  (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
   actor_immutable_id, source_repository, source_issue_number, source_comment_id,
   correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
  SELECT event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
         actor_immutable_id, source_repository, source_issue_number, source_comment_id,
         correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json
    FROM decision_event;

DROP TABLE decision_event;
ALTER TABLE decision_event_rebuilt RENAME TO decision_event;

CREATE INDEX IF NOT EXISTS ix_decision_item_gate ON decision_event(item_id, item_revision, gate, occurred_at);
CREATE TRIGGER IF NOT EXISTS no_update_decision_event BEFORE UPDATE ON decision_event BEGIN SELECT RAISE(ABORT, 'decision events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_decision_event BEFORE DELETE ON decision_event BEGIN SELECT RAISE(ABORT, 'decision events are immutable'); END;
