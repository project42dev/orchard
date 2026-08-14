-- Orchard authoritative two-track workflow schema, version 2.
-- Additive only. Derived content tables remain governed by schema/content-db.sql.

CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (checksum GLOB 'sha256:[0-9a-f]*' AND length(checksum) = 71),
  applied_at TEXT NOT NULL,
  application_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verified_backup (
  backup_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  backup_path TEXT NOT NULL UNIQUE,
  source_size INTEGER NOT NULL CHECK (source_size >= 0),
  backup_size INTEGER NOT NULL CHECK (backup_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  integrity_result TEXT NOT NULL CHECK (integrity_result = 'ok'),
  foreign_key_violations INTEGER NOT NULL CHECK (foreign_key_violations = 0),
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  restored_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_run (
  run_id TEXT PRIMARY KEY,
  track TEXT NOT NULL CHECK (track IN ('track-1', 'track-2')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('monthly', 'weekly', 'manual', 'replay')),
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('full', 'subset', 'dry-run')),
  status TEXT NOT NULL CHECK (status IN ('created', 'running', 'incomplete', 'blocked', 'failed', 'completed')),
  replay_of TEXT REFERENCES workflow_run(run_id),
  manifest_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_workflow_run_track_started ON workflow_run(track, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_workflow_run_status ON workflow_run(status, track);

CREATE TABLE IF NOT EXISTS run_coverage (
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  evidence_digest TEXT,
  PRIMARY KEY (run_id, metric)
);

CREATE TABLE IF NOT EXISTS run_outcome (
  outcome_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  subject_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  exception_reason TEXT,
  evidence_digest TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE (run_id, subject_key)
);
CREATE INDEX IF NOT EXISTS ix_run_outcome_run ON run_outcome(run_id, outcome);

CREATE TABLE IF NOT EXISTS workflow_item (
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
  UNIQUE (track, semantic_identity),
  CHECK (item_id <> supersedes_item_id),
  CHECK (item_id <> superseded_by_item_id)
);
CREATE INDEX IF NOT EXISTS ix_workflow_item_state ON workflow_item(track, current_state);
CREATE INDEX IF NOT EXISTS ix_workflow_item_target_identity ON workflow_item(track, semantic_identity);

CREATE TABLE IF NOT EXISTS item_revision (
  item_id TEXT NOT NULL REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  item_revision INTEGER NOT NULL CHECK (item_revision >= 1),
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  proposal_digest TEXT NOT NULL,
  artifact_digest TEXT,
  target_repository TEXT NOT NULL,
  target_path TEXT NOT NULL,
  lifecycle_key TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, item_revision)
);
CREATE INDEX IF NOT EXISTS ix_item_revision_run ON item_revision(run_id);
CREATE INDEX IF NOT EXISTS ix_item_revision_target ON item_revision(target_repository, target_path);

CREATE TABLE IF NOT EXISTS observation_event (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT REFERENCES workflow_item(item_id) ON DELETE RESTRICT,
  item_revision INTEGER,
  evidence_reference TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  CHECK ((item_id IS NULL AND item_revision IS NULL) OR (item_id IS NOT NULL AND item_revision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_observation_item ON observation_event(item_id, item_revision, observed_at);
CREATE INDEX IF NOT EXISTS ix_observation_run ON observation_event(run_id, observed_at);

CREATE TABLE IF NOT EXISTS state_transition_event (
  transition_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  cause TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_transition_item ON state_transition_event(item_id, item_revision, occurred_at);
CREATE INDEX IF NOT EXISTS ix_transition_correlation ON state_transition_event(correlation_id);

CREATE TABLE IF NOT EXISTS decision_event (
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
  UNIQUE (source_repository, source_comment_id)
);
CREATE INDEX IF NOT EXISTS ix_decision_item_gate ON decision_event(item_id, item_revision, gate, occurred_at);

CREATE TABLE IF NOT EXISTS external_link (
  link_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT,
  item_revision INTEGER,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  external_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  manifest_digest TEXT,
  artifact_digest TEXT,
  lifecycle_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  UNIQUE (provider, external_key),
  CHECK ((item_id IS NULL AND item_revision IS NULL) OR (item_id IS NOT NULL AND item_revision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_external_link_item ON external_link(item_id, item_revision, provider);

CREATE TABLE IF NOT EXISTS agent_handoff (
  handoff_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  role TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  predecessor_handoff_digest TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_handoff_item ON agent_handoff(item_id, item_revision, completed_at);

CREATE TABLE IF NOT EXISTS lease (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('track-run', 'item', 'target-path')),
  scope_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  PRIMARY KEY (scope_type, scope_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_owner_token ON lease(owner_token);
CREATE INDEX IF NOT EXISTS ix_lease_expiry ON lease(expires_at);

CREATE TABLE IF NOT EXISTS publication_transaction (
  transaction_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  gate2_decision_event_id TEXT NOT NULL REFERENCES decision_event(event_id) ON DELETE RESTRICT,
  artifact_digest TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  displayed_diff_digest TEXT NOT NULL,
  prepared_tree_digest TEXT NOT NULL,
  ado_external_key TEXT NOT NULL,
  handoff_chain_digest TEXT NOT NULL,
  full_manifest_digest TEXT NOT NULL,
  gate2_batch_digest TEXT NOT NULL,
  target_repository TEXT NOT NULL,
  target_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  initial_state TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  UNIQUE (item_id, item_revision, artifact_digest)
);
CREATE INDEX IF NOT EXISTS ix_publication_item ON publication_transaction(item_id, item_revision);
CREATE INDEX IF NOT EXISTS ix_publication_target ON publication_transaction(target_repository, target_path);

CREATE TABLE IF NOT EXISTS publication_event (
  event_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES publication_transaction(transaction_id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('prepare', 'validate', 'pr-open', 'merge', 'acknowledge', 'reconcile', 'rollback')),
  state TEXT NOT NULL,
  intent_or_result TEXT NOT NULL CHECK (intent_or_result IN ('intent', 'result')),
  correlation_id TEXT NOT NULL,
  evidence_digest TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_publication_event_transaction ON publication_event(transaction_id, occurred_at);

-- Event history and immutable revisions are protected even from accidental callers.
CREATE TRIGGER IF NOT EXISTS no_update_item_revision BEFORE UPDATE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_item_revision BEFORE DELETE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_observation_event BEFORE UPDATE ON observation_event BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_observation_event BEFORE DELETE ON observation_event BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_state_transition_event BEFORE UPDATE ON state_transition_event BEGIN SELECT RAISE(ABORT, 'state transitions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_state_transition_event BEFORE DELETE ON state_transition_event BEGIN SELECT RAISE(ABORT, 'state transitions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_decision_event BEFORE UPDATE ON decision_event BEGIN SELECT RAISE(ABORT, 'decision events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_decision_event BEFORE DELETE ON decision_event BEGIN SELECT RAISE(ABORT, 'decision events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_external_link BEFORE UPDATE ON external_link BEGIN SELECT RAISE(ABORT, 'external links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_external_link BEFORE DELETE ON external_link BEGIN SELECT RAISE(ABORT, 'external links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_agent_handoff BEFORE UPDATE ON agent_handoff BEGIN SELECT RAISE(ABORT, 'handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_agent_handoff BEFORE DELETE ON agent_handoff BEGIN SELECT RAISE(ABORT, 'handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_publication_transaction BEFORE UPDATE ON publication_transaction BEGIN SELECT RAISE(ABORT, 'publication transactions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_publication_transaction BEFORE DELETE ON publication_transaction BEGIN SELECT RAISE(ABORT, 'publication transactions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_publication_event BEFORE UPDATE ON publication_event BEGIN SELECT RAISE(ABORT, 'publication events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_publication_event BEFORE DELETE ON publication_event BEGIN SELECT RAISE(ABORT, 'publication events are append-only'); END;
