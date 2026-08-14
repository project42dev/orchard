-- Orchard protected authority evidence, version 4.
-- Gate decisions and closure owner authorization are accepted only with
-- immutable evidence captured at the protected trust boundary.

CREATE TABLE IF NOT EXISTS gate_decision_authority (
  event_id TEXT PRIMARY KEY REFERENCES decision_event(event_id) ON DELETE RESTRICT,
  queue_work_item_id INTEGER,
  provider_event_digest TEXT NOT NULL,
  authorization_policy_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  adapter_identity TEXT NOT NULL,
  repository TEXT NOT NULL,
  actor_immutable_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  full_manifest_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_gate_decision_queue_gate1
  ON gate_decision_authority(queue_work_item_id)
  WHERE queue_work_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS closure_owner_authority (
  acceptance_id TEXT PRIMARY KEY REFERENCES closure_acceptance(acceptance_id) ON DELETE RESTRICT,
  owner_policy_digest TEXT NOT NULL,
  provider_event_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  adapter_identity TEXT NOT NULL,
  evidence_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS no_update_gate_decision_authority BEFORE UPDATE ON gate_decision_authority BEGIN SELECT RAISE(ABORT, 'gate decision authority is append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_gate_decision_authority BEFORE DELETE ON gate_decision_authority BEGIN SELECT RAISE(ABORT, 'gate decision authority is append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_update_closure_owner_authority BEFORE UPDATE ON closure_owner_authority BEGIN SELECT RAISE(ABORT, 'closure owner authority is append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_closure_owner_authority BEFORE DELETE ON closure_owner_authority BEGIN SELECT RAISE(ABORT, 'closure owner authority is append-only'); END;
