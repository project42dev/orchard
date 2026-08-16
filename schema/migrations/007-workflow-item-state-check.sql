-- 007: the state vocabulary becomes a database constraint.
--
-- WHY. workflow_item.current_state had no CHECK constraint and no documented
-- vocabulary, so any typo written by any code path (a misspelled
-- 'gate1-aproved', a casing slip, a state renamed in one script but not
-- another) persisted silently as authoritative state and nothing ever caught
-- it. Remediation plan T8.
--
-- WHAT CHANGES. current_state gains CHECK (current_state IN (...)) listing
-- the complete lifecycle vocabulary: the sixteen states of the direct
-- transition chain plus the six exception states (denied, deferred,
-- changes-requested, stale-approval, blocked, superseded). The authoritative
-- list is LIFECYCLE_STATES in scripts/lib/state-machine.mjs, derived from the
-- transition table itself; this constraint and the state enum in
-- contracts/schemas/state-transition.schema.json are copies that
-- scripts/test-state-vocabulary.mjs holds in lockstep with it, so the three
-- cannot drift apart unnoticed. If a deployed database already holds a row
-- with a state outside the vocabulary, the copy below fails the CHECK and the
-- whole migration rolls back: surfacing that corruption loudly is the point
-- of this migration, not an accident of it.
--
-- HOW. Same documented table-rebuild procedure as migration 006, because
-- SQLite cannot add a CHECK constraint in place: create the corrected table,
-- copy every row, drop the original, rename, recreate every index including
-- the one-live-item-per-subject partial unique index from 006. The migration
-- runner turns foreign key enforcement off for the duration (the pragma is
-- ignored inside a transaction, so the runner sets it before BEGIN) and the
-- post-migration verification runs a full foreign_key_check, which is the
-- proof the swap left every reference intact.

CREATE TABLE workflow_item_rebuilt (
  item_id TEXT PRIMARY KEY,
  origin_run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  track TEXT NOT NULL CHECK (track IN ('track-1', 'track-2')),
  semantic_identity TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_state TEXT NOT NULL CHECK (current_state IN (
    'observed',
    'proposed',
    'gate1-pending',
    'gate1-approved',
    'ado-linked',
    'executing',
    'gate2-ready',
    'gate2-pending',
    'gate2-approved',
    'publication-preparing',
    'publication-validating',
    'publication-pr-open',
    'publication-merging',
    'published',
    'ado-closure-ready',
    'closed',
    'denied',
    'deferred',
    'changes-requested',
    'stale-approval',
    'blocked',
    'superseded'
  )),
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
