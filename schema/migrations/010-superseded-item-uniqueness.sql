-- 010: a superseded item no longer occupies its subject.
--
-- WHY. Migration 006 made the "one live item per subject" invariant a partial
-- unique index over every state except 'closed', and its own comment said
-- superseded still blocks a duplicate proposal. That was right while nothing
-- ever superseded anything: the only writer of the 'superseded' cause was the
-- state machine's vocabulary, not any running code.
--
-- Currency changed that. A Track 2 finding is keyed on the canonical item it
-- is about, deliberately NOT on the classification, so that one published file
-- can only ever have one currency question in front of a human at a time. But
-- an assessment can change between runs: a file first read as needing an
-- 'update' can, a week later, read as needing 'removal'. Leaving the stale
-- item at the gate asks the owner last week's question about this week's
-- content, and proposing a second item alongside it asks two contradictory
-- questions about one file. The lifecycle already has the right answer -- the
-- 'superseded' cause, which names its successor -- and it was unreachable for
-- this purpose because the index refused to let the successor exist.
--
-- WHAT CHANGES. Only the index predicate: 'superseded' joins 'closed' as a
-- state that does not occupy the subject. The invariant it states is unchanged
-- and in fact better enforced: a superseded item has a successor, and that
-- successor IS the one live item for the subject. Denied, deferred,
-- changes-requested, blocked, stale-approval and every in-flight state still
-- occupy the subject and still block a duplicate proposal, so a human's "no"
-- is still not undoable by a machine.
--
-- HOW. An index swap, not a table rebuild: the new predicate is strictly less
-- restrictive than the old one, so it cannot fail against any existing row.
DROP INDEX IF EXISTS ux_workflow_item_one_live_per_subject;
CREATE UNIQUE INDEX ux_workflow_item_one_live_per_subject
  ON workflow_item(track, semantic_identity)
  WHERE current_state NOT IN ('closed', 'superseded');
