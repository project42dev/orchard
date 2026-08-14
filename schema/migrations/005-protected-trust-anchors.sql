-- Orchard protected trust anchors, version 5.
-- Trust is provisioned once by an administrator and is never accepted from an
-- evidence-bearing operation's command line or process environment.

CREATE TABLE IF NOT EXISTS protected_trust_anchor (
  scope TEXT PRIMARY KEY CHECK (scope IN ('gate', 'publication', 'closure')),
  adapter_identity TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  adapter_path TEXT,
  policy_digest TEXT,
  policy_json TEXT,
  provisioned_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_authority (
  transaction_id TEXT PRIMARY KEY REFERENCES publication_transaction(transaction_id) ON DELETE RESTRICT,
  adapter_identity TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  trust_anchor_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS no_update_protected_trust_anchor BEFORE UPDATE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_protected_trust_anchor BEFORE DELETE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_publication_authority BEFORE UPDATE ON publication_authority BEGIN SELECT RAISE(ABORT, 'publication authority is append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_publication_authority BEFORE DELETE ON publication_authority BEGIN SELECT RAISE(ABORT, 'publication authority is append-only'); END;
