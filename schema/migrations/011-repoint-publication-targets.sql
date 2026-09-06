-- 011: historical items point at the repository publication refuses.
--
-- WHY. Orchard published the curriculum into project42dev/project42-platform,
-- the product repository, which is what let the platform's copy and the
-- canonical corpus drift apart. lib/publication.mjs now refuses any item whose
-- Gate 2 manifest names anything but project42dev/project42-content, and that
-- refusal is correct and stays. The consequence is that every item recorded
-- before the repoint carries the old repository AND the old path layout, so
-- every one of them is permanently unpublishable. They are not wrong findings;
-- they are correct findings recorded against a target that has since moved.
--
-- WHY A MIGRATION AND NOT RUNTIME CODE. item_revision is append-only, enforced
-- by a BEFORE UPDATE trigger, because a revision is history and history is not
-- editable by a running job. A schema migration is the one sanctioned place
-- that rule is relaxed: it is checksummed, applied exactly once, recorded in
-- schema_migration, wrapped in the migrator's own transaction, and preceded by
-- a verified backup. Migrations 006, 007 and 008 already rebuild whole tables
-- under the same mechanism. Runtime code must never do this, and does not: the
-- runtime's pass over these rows is read-only and only reports what is left.
--
-- THE MAPPING. The inspected corpus uses the platform layout, content/modules,
-- content/resources, content/diagrams, content/catalog.json. The content
-- repository has modules/, resources/, diagrams/ and catalog.json at the ROOT.
-- The two layouts are otherwise identical, so the mapping is exactly the
-- prefix: strip a leading 'content/'. That is character-for-character
-- lib/track-2-controller.mjs's contentRepositoryPathFor, and
-- test-publication-target-migration.mjs proves this SQL agrees with that
-- function rather than trusting the comment.
--
-- WHAT IT REFUSES, RATHER THAN GUESSING. This migration must be incapable of
-- throwing: a failed migration aborts every job's store open, so a bad row
-- would take the whole estate down rather than block one item. Every refusal is
-- therefore expressed as a WHERE clause, and a refused row is left exactly as
-- it is and reported at runtime, forever, until a human acts on it.
--
--   * a path not under 'content/' -- the corpus layout would have to have moved
--     for one to exist, and a guess here is invisible: the publication succeeds
--     into a phantom tree no loader reads
--   * a record_json that is not an object with a target to repoint
--   * a superseded revision -- only the item's live revision is corrected;
--     older revisions are the history of what was actually proposed
--   * a revision a Gate 2 manifest already binds. The manifest, not the
--     revision, is what publication authority reads, and its evidence digest
--     covers the target. Rewriting the revision beneath it would not make the
--     item publishable and WOULD falsify recorded evidence. Those items need a
--     human to rework or deny them.
--   * an item that is published, closed or superseded. Where something was
--     actually published is a fact about the past, not a defect.

DROP TRIGGER IF EXISTS no_update_item_revision;

UPDATE item_revision
   SET target_repository = 'project42dev/project42-content',
       target_path = substr(target_path, 9),
       record_json = json_set(
           record_json,
           '$.target.repository', 'project42dev/project42-content',
           '$.target.path', substr(target_path, 9)
       )
 WHERE target_repository = 'project42dev/project42-platform'
   -- substr, not LIKE: LIKE is case-insensitive in SQLite and
   -- contentRepositoryPathFor is not, so 'Content/x' would map here and be
   -- refused there. The two must agree exactly or this migration is a
   -- different rule wearing the same comment.
   AND substr(target_path, 1, 8) = 'content/'
   AND length(target_path) > 8
   AND json_valid(record_json)
   AND json_type(record_json, '$.target') = 'object'
   AND item_revision = (
        SELECT w.current_revision FROM workflow_item w WHERE w.item_id = item_revision.item_id
   )
   AND (
        SELECT w.current_state FROM workflow_item w WHERE w.item_id = item_revision.item_id
   ) NOT IN ('published', 'closed', 'superseded')
   AND NOT EXISTS (
        SELECT 1 FROM observation_event o
         WHERE o.item_id = item_revision.item_id
           AND o.item_revision = item_revision.item_revision
           AND o.evidence_reference = 'orchard/gate-manifest/gate-2:' || item_revision.item_id
   );

CREATE TRIGGER IF NOT EXISTS no_update_item_revision BEFORE UPDATE ON item_revision BEGIN SELECT RAISE(ABORT, 'item revisions are append-only'); END;
