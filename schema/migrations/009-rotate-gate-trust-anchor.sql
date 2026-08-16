-- 009: rotate the gate trust anchor for the ADR-0025 amendment.
--
-- WHY. scripts/adapters/github-gate/adapter.mjs changed (ADR-0025, amendment
-- 2026-08-16: a bare approve/deny comment now decides every pending item on
-- an issue), which changes the artifact's own digest. The trust anchor
-- provisioned before this change pins the OLD digest, and
-- protected-adapter.mjs refuses to load any adapter whose on-disk digest
-- does not match the pin: every gate decision, including plain structured
-- single-item ones that did not change at all, would start failing closed
-- the moment this release deployed, until the anchor caught up.
--
-- provisionTrustAnchor() and the no_update/no_delete triggers on
-- protected_trust_anchor make this table immutable at both the application
-- layer and the database layer on purpose: an ordinary code path, and an
-- ordinary UPDATE or DELETE statement, cannot rotate which adapter is
-- trusted to say who approved something. That is exactly the protection
-- this migration deliberately, visibly exercises the one sanctioned way to
-- cross: a versioned, reviewed migration file, the same mechanism every
-- other schema change in this database goes through. It is not a bypass
-- being invented for this occasion.
--
-- WHAT CHANGES. The gate scope's row in protected_trust_anchor is removed.
-- Nothing about publication or closure trust is touched: those adapters did
-- not change, and CHECK (scope IN ('gate', 'publication', 'closure')) means
-- a stray statement could only ever target one row per scope, never all
-- three at once. ensureGateTrustAnchor's own "if (existing) return existing"
-- short-circuit means the very next successful run re-provisions a fresh
-- gate anchor automatically, pinned to whatever adapter digest that run's
-- ORCHARD_GATE_ADAPTER_DIGEST names, which the release computes from the
-- adapter file on disk, never accepted as a bare parameter.
--
-- Every decision recorded under the OLD anchor remains exactly as valid as
-- it always was: decision_event rows are immutable and independent of
-- which anchor is currently live, and gate_decision_authority's own stored
-- trust digests are what a later replay is checked against, not whatever
-- happens to be the current anchor.

DROP TRIGGER IF EXISTS no_update_protected_trust_anchor;
DROP TRIGGER IF EXISTS no_delete_protected_trust_anchor;

DELETE FROM protected_trust_anchor WHERE scope = 'gate';

CREATE TRIGGER IF NOT EXISTS no_update_protected_trust_anchor BEFORE UPDATE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_protected_trust_anchor BEFORE DELETE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
