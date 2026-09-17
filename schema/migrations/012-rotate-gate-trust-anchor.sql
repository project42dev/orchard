-- 012: rotate the gate trust anchor after the item-command alias amendment.
--
-- The release at 89b2b30 changed scripts/adapters/github-gate/adapter.mjs
-- to recognize approved/denied item commands. The image and its bound digest
-- were rolled out together, but the immutable database anchor still pinned
-- the previous adapter. As a result every gate decision failed closed with
-- "protected adapter artifact does not match the protected digest".
--
-- As in migration 009, rotation is a reviewed schema operation. The next
-- decision pass re-provisions the gate anchor from the release-bound digest.
-- Publication and closure anchors, and all recorded decisions, are untouched.

DROP TRIGGER IF EXISTS no_update_protected_trust_anchor;
DROP TRIGGER IF EXISTS no_delete_protected_trust_anchor;

DELETE FROM protected_trust_anchor WHERE scope = 'gate';

CREATE TRIGGER IF NOT EXISTS no_update_protected_trust_anchor BEFORE UPDATE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_protected_trust_anchor BEFORE DELETE ON protected_trust_anchor BEGIN SELECT RAISE(ABORT, 'protected trust anchors are immutable'); END;
