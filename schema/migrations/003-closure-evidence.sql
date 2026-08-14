-- Orchard explicit closure evidence and owner acceptance, version 3.
-- Additive only. All evidence records are immutable and append-only.

CREATE TABLE IF NOT EXISTS artifact_binding (
  binding_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL CHECK (item_revision >= 1),
  artifact_digest TEXT NOT NULL,
  final_handoff_id TEXT NOT NULL REFERENCES agent_handoff(handoff_id) ON DELETE RESTRICT,
  final_handoff_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  UNIQUE (item_id, item_revision)
);
CREATE INDEX IF NOT EXISTS ix_artifact_binding_run ON artifact_binding(run_id, occurred_at);

CREATE TABLE IF NOT EXISTS closure_packet (
  packet_id TEXT PRIMARY KEY,
  packet_digest TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_run(run_id) ON DELETE RESTRICT,
  track TEXT NOT NULL CHECK (track IN ('track-1', 'track-2')),
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL CHECK (item_revision >= 1),
  proposal_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  handoff_chain_digest TEXT NOT NULL,
  gate1_decision_event_id TEXT NOT NULL REFERENCES decision_event(event_id) ON DELETE RESTRICT,
  gate2_decision_event_id TEXT NOT NULL REFERENCES decision_event(event_id) ON DELETE RESTRICT,
  ado_external_key TEXT NOT NULL,
  ado_work_item_id INTEGER NOT NULL CHECK (ado_work_item_id > 0),
  publication_transaction_id TEXT NOT NULL REFERENCES publication_transaction(transaction_id) ON DELETE RESTRICT,
  protected_main_commit TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (item_id, item_revision) REFERENCES item_revision(item_id, item_revision) ON DELETE RESTRICT,
  UNIQUE (item_id, item_revision)
);
CREATE INDEX IF NOT EXISTS ix_closure_packet_run ON closure_packet(run_id, prepared_at);

CREATE TABLE IF NOT EXISTS closure_acceptance (
  acceptance_id TEXT PRIMARY KEY,
  packet_digest TEXT NOT NULL UNIQUE REFERENCES closure_packet(packet_digest) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_provider TEXT NOT NULL,
  owner_immutable_id TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  source_evidence_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closure_ado_event (
  event_id TEXT PRIMARY KEY,
  packet_digest TEXT NOT NULL REFERENCES closure_packet(packet_digest) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('Resolved', 'Closed')),
  ado_work_item_id INTEGER NOT NULL CHECK (ado_work_item_id > 0),
  ado_external_key TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  UNIQUE (packet_digest, state)
);

CREATE TRIGGER IF NOT EXISTS no_update_artifact_binding BEFORE UPDATE ON artifact_binding BEGIN SELECT RAISE(ABORT, 'artifact bindings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_artifact_binding BEFORE DELETE ON artifact_binding BEGIN SELECT RAISE(ABORT, 'artifact bindings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_closure_packet BEFORE UPDATE ON closure_packet BEGIN SELECT RAISE(ABORT, 'closure packets are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_closure_packet BEFORE DELETE ON closure_packet BEGIN SELECT RAISE(ABORT, 'closure packets are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_closure_acceptance BEFORE UPDATE ON closure_acceptance BEGIN SELECT RAISE(ABORT, 'closure acceptances are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_closure_acceptance BEFORE DELETE ON closure_acceptance BEGIN SELECT RAISE(ABORT, 'closure acceptances are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_closure_ado_event BEFORE UPDATE ON closure_ado_event BEGIN SELECT RAISE(ABORT, 'closure ADO events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_closure_ado_event BEFORE DELETE ON closure_ado_event BEGIN SELECT RAISE(ABORT, 'closure ADO events are append-only'); END;
