-- 006: one live item per subject; closed predecessors do not block re-proposal.
--
-- WHY. Currency's whole purpose is to notice that published content has gone
-- stale, and the table-level UNIQUE (track, semantic_identity) from migration
-- 002 made acting on that structurally impossible: once a subject's item
-- reached closed, no new item for the same subject could ever be inserted, so
-- a later run that found the published artifact stale had no way to put it
-- back in front of a human. Remediation plan T17.
--
-- WHAT CHANGES. The table constraint becomes a partial unique index covering
-- only items that are not closed. The invariant it now states is the rule's
-- actual purpose: a subject has AT MOST ONE live item, and any number of
-- closed predecessors. Nothing about the lifecycle changes: closed remains
-- terminal for the item that reached it, and a re-proposal is a NEW item that
-- records its predecessor in supersedes_item_id and walks the whole lifecycle
-- from observed. Denied, blocked, superseded and every other non-closed state
-- still occupies the subject and still blocks a duplicate proposal.
--
-- HOW. SQLite cannot drop a table-level UNIQUE constraint in place, so this
-- follows the documented table-rebuild procedure: create the corrected table,
-- copy every row, drop the original, rename. The migration runner turns
-- foreign key enforcement off for the duration (the pragma is ignored inside
-- a transaction, so the runner sets it before BEGIN) and the post-migration
-- verification runs a full foreign_key_check, which is the proof the swap
-- left every reference intact. With enforcement off, the rename does not
-- rewrite REFERENCES clauses in other tables, so item_revision and both
-- self-references keep pointing at the name workflow_item, which is exactly
-- the table that ends up holding it.

CREATE TABLE workflow_item_rebuilt (
  item_id TEXT PRIMARY KEY,
  origin_run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  track TEXT NOT NULL CHECK (track IN ('track-1', 'track-2')),
  semantic_identity TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_state TEXT NOT NULL,
  supersedes_item_id TEXT REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  superseded_by_item_id TEXT REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (item_id <> supersedes_item_id),
  CHECK (item_id <> superseded_by_item_id)
);

INSERT INTO workflow_item_rebuilt
  (item_id, origin_run_id, track, semantic_identity, surface, outcome,
   current_revision, current_state, supersedes_item_id, superseded_by_item_id,
   created_at, updated_at)
  SELECT item_id, origin_run_id, track, semantic_identity, surface, outcome,
         current_revision, current_state, supersedes_item_id, superseded_by_item_id,
         created_at, updated_at
    FROM workflow_item;

DROP TABLE workflow_item;
ALTER TABLE workflow_item_rebuilt RENAME TO workflow_item;

CREATE INDEX IF NOT EXISTS ix_workflow_item_state ON workflow_item(track, current_state);
CREATE INDEX IF NOT EXISTS ix_workflow_item_target_identity ON workflow_item(track, semantic_identity);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_item_one_live_per_subject
  ON workflow_item(track, semantic_identity)
  WHERE current_state <> 'closed';
