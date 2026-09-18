-- A separately reviewed manual release can satisfy an Orchard item without
-- claiming Orchard published it. Keep its original decisions and draft, but
-- end its active gate and make the external delivery visible to ADO.
CREATE TABLE workflow_item_rebuilt_014 (
  item_id TEXT PRIMARY KEY,
  origin_run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  track TEXT NOT NULL CHECK (track IN ('track-1', 'track-2')),
  semantic_identity TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_state TEXT NOT NULL CHECK (current_state IN (
    'observed', 'proposed', 'gate1-pending', 'gate1-approved',
    'ado-linked', 'executing', 'gate2-ready', 'gate2-pending',
    'gate2-approved', 'publication-preparing', 'publication-validating',
    'publication-pr-open', 'publication-merging', 'published',
    'ado-closure-ready', 'closed', 'denied', 'deferred',
    'changes-requested', 'stale-approval', 'blocked', 'superseded',
    'invalidated', 'externally-published'
  )),
  supersedes_item_id TEXT REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  superseded_by_item_id TEXT REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (item_id <> supersedes_item_id),
  CHECK (item_id <> superseded_by_item_id)
);

INSERT INTO workflow_item_rebuilt_014
  (item_id, origin_run_id, track, semantic_identity, surface, outcome,
   current_revision, current_state, supersedes_item_id, superseded_by_item_id,
   created_at, updated_at)
  SELECT item_id, origin_run_id, track, semantic_identity, surface, outcome,
         current_revision, current_state, supersedes_item_id, superseded_by_item_id,
         created_at, updated_at
    FROM workflow_item;

DROP TABLE workflow_item;
ALTER TABLE workflow_item_rebuilt_014 RENAME TO workflow_item;

CREATE INDEX IF NOT EXISTS ix_workflow_item_state ON workflow_item(track, current_state);
CREATE INDEX IF NOT EXISTS ix_workflow_item_target_identity ON workflow_item(track, semantic_identity);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_item_one_live_per_subject
  ON workflow_item(track, semantic_identity)
  WHERE current_state NOT IN ('closed', 'superseded', 'invalidated', 'externally-published');
