-- Orchard content database.
--
-- TWO HALVES, AND THE SPLIT IS THE WHOLE DESIGN.
--
-- DERIVED tables are compiled from the content files on every build. They are
-- dropped and rebuilt, they are never edited, and losing the database costs
-- nothing because it can be rebuilt from a git checkout in seconds. The content
-- files remain the source of truth: they diff, they review, they blame, they
-- roll back, and an adopter gets all of it from a clone.
--
-- AUTHORITATIVE tables hold operational state that exists nowhere else: what a
-- human decided about a piece of work, and what was actually rendered. These
-- survive every rebuild. A rebuild that reset them would destroy the only copy.
--
-- The rule for telling them apart: if a git checkout can reproduce it, it is
-- derived. If it records a decision or an event, it is authoritative.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- AUTHORITATIVE. Created if absent, never dropped by a build.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The one queue. The plan requires needs-creating and needs-updating to be a
-- single queue Orchard pulls from, so they are one table separated by kind
-- rather than two tables joined at read time.
CREATE TABLE IF NOT EXISTS work_item (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('needs-creating', 'needs-updating')),
  subject_id   TEXT NOT NULL,
  surface      TEXT NOT NULL,
  title        TEXT NOT NULL,
  -- rejected is terminal and permanent. A rebuild may never move a row out of
  -- it, for the same reason a rejected discovery candidate is never re-proposed.
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','claimed','in-progress','blocked','done','rejected')),
  priority     REAL,
  claimed_by   TEXT,
  claimed_at   TEXT,
  note         TEXT,
  first_seen   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- ADO work item id, populated when the work item is mirrored to Azure DevOps.
  -- Null means the item has not been pushed to ADO yet (e.g. dry-run builds).
  ado_id       INTEGER,
  UNIQUE (kind, subject_id)
);

CREATE INDEX IF NOT EXISTS ix_work_item_state ON work_item (state, kind);

-- What was actually rendered, and by whom. ADR-0018 requires this: standard
-- avatars can be withdrawn when an actor contract lapses, and a withdrawal has
-- to produce a re-render list rather than a hunt through the file tree.
CREATE TABLE IF NOT EXISTS rendering (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL,
  rendering_kind TEXT NOT NULL,
  avatar        TEXT,
  voice         TEXT,
  model_id      TEXT,
  output_path   TEXT,
  rendered_at   TEXT NOT NULL,
  UNIQUE (item_id, rendering_kind, rendered_at)
);

CREATE INDEX IF NOT EXISTS ix_rendering_avatar ON rendering (avatar);

-- What was published, and which run produced it.
--
-- Authoritative, because nothing else records it. The content files show what
-- the estate contains and git shows who committed it, and neither can answer
-- "which ensemble run wrote this, under which brief, and which reviewers signed
-- it off". Without that, a model found to be producing bad content gives no
-- list of what to re-check, and a proposal accepted by a human leaves no trace
-- that it ever existed.
--
-- A row here means a human accepted a proposal and the content landed. The
-- ingest never writes one: it records what reviewers CONCLUDED, and a
-- conclusion is not a publication (ADR-0004, the pipeline proposes only).
CREATE TABLE IF NOT EXISTS publication (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The queue item this closes. Kept even after the work item is gone, which
  -- is why it is a plain column and not a foreign key.
  subject_id     TEXT NOT NULL,
  -- The content item as it now exists. Null until the next build indexes it,
  -- because a publication is recorded at accept time and the file may not be
  -- committed yet.
  item_id        TEXT,
  run_id         TEXT,
  brief_id       TEXT,
  proposal_file  TEXT,
  proposal_digest TEXT,
  disposition    TEXT,
  -- Who accepted it. A publication with no named accepter is an automated
  -- publication, which this pipeline does not do.
  accepted_by    TEXT NOT NULL,
  published_at   TEXT NOT NULL,
  note           TEXT,
  UNIQUE (subject_id, run_id, proposal_file)
);

CREATE INDEX IF NOT EXISTS ix_publication_subject ON publication (subject_id);
CREATE INDEX IF NOT EXISTS ix_publication_run ON publication (run_id);

-- ---------------------------------------------------------------------------
-- DERIVED. Dropped and rebuilt on every build.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS citation;
DROP TABLE IF EXISTS item_tag;
DROP TABLE IF EXISTS item_provider;
DROP TABLE IF EXISTS candidate;
DROP TABLE IF EXISTS item;
DROP TABLE IF EXISTS source;

CREATE TABLE item (
  id                  TEXT PRIMARY KEY,
  surface             TEXT NOT NULL,
  path                TEXT NOT NULL,
  title               TEXT,
  summary             TEXT,
  level               TEXT,
  estimated_minutes   INTEGER,
  owner               TEXT,
  review_cadence_days INTEGER,
  last_verified       TEXT,
  content_sha256      TEXT NOT NULL,
  indexed_at          TEXT NOT NULL
);

CREATE INDEX ix_item_surface ON item (surface);

CREATE TABLE source (
  id                  TEXT PRIMARY KEY,
  url_prefix          TEXT NOT NULL,
  publisher           TEXT,
  trust_tier          TEXT,
  review_cadence_days INTEGER,
  owner               TEXT
);

-- The currency engine's reason for existing. Answering "which items cite the
-- source that just changed" by grepping 3.2 million characters is the thing
-- this table removes.
CREATE TABLE citation (
  item_id       TEXT NOT NULL REFERENCES item (id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  publisher     TEXT,
  last_verified TEXT,
  source_id     TEXT REFERENCES source (id)
);

CREATE INDEX ix_citation_source ON citation (source_id);
CREATE INDEX ix_citation_item   ON citation (item_id);

CREATE TABLE item_tag (
  item_id TEXT NOT NULL REFERENCES item (id) ON DELETE CASCADE,
  tag     TEXT NOT NULL
);

CREATE TABLE item_provider (
  item_id  TEXT NOT NULL REFERENCES item (id) ON DELETE CASCADE,
  provider TEXT NOT NULL
);

CREATE TABLE candidate (
  id                 TEXT PRIMARY KEY,
  topic_id           TEXT,
  topic_title        TEXT,
  surface            TEXT,
  status             TEXT,
  level              TEXT,
  supply_occurrences INTEGER,
  demand_sources     INTEGER,
  score              REAL,
  attention          TEXT,
  gap_label          TEXT
);

CREATE INDEX ix_candidate_status ON candidate (status);

-- ---------------------------------------------------------------------------
-- VIEWS. The questions the file tree cannot answer cheaply.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS v_queue;
DROP VIEW IF EXISTS v_affected_by_source;
DROP VIEW IF EXISTS v_stale;
DROP VIEW IF EXISTS v_stale_citation;
DROP VIEW IF EXISTS v_unmeasurable;
DROP VIEW IF EXISTS v_render_manifest;
DROP VIEW IF EXISTS v_provenance;
DROP VIEW IF EXISTS v_unprovenanced;

-- The single queue Orchard pulls from, open work only, highest priority first.
CREATE VIEW v_queue AS
SELECT id, kind, subject_id, surface, title, state, priority, claimed_by, updated_at
FROM   work_item
WHERE  state NOT IN ('done', 'rejected')
ORDER BY CASE state WHEN 'in-progress' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
         priority DESC NULLS LAST,
         first_seen;

-- Feed a source id in and get every item that will need review.
CREATE VIEW v_affected_by_source AS
SELECT s.id AS source_id, s.publisher, i.id AS item_id, i.surface, i.title, c.url
FROM   citation c
JOIN   item   i ON i.id = c.item_id
JOIN   source s ON s.id = c.source_id;

-- Items past their own declared review cadence.
--
-- READ v_unmeasurable BEFORE TRUSTING A LOW COUNT HERE. An item that declares
-- neither lastVerified nor reviewCadenceDays cannot be stale by this
-- definition, so it silently drops out and the total looks healthy. On the
-- estate this was built against, that was 66 of 150 items, the entire Learn
-- surface. A zero here meant "half the estate is invisible", not "nothing is
-- stale", and nothing in the number said so.
CREATE VIEW v_stale AS
SELECT id, surface, title, last_verified, review_cadence_days,
       CAST(julianday('now') - julianday(last_verified) AS INTEGER) AS days_since_verified
FROM   item
WHERE  last_verified IS NOT NULL
  AND  review_cadence_days IS NOT NULL
  AND  julianday('now') - julianday(last_verified) > review_cadence_days;

-- The companion that makes the omission visible. Anything listed here is not
-- covered by v_stale and never will be until the content model gains the field.
CREATE VIEW v_unmeasurable AS
SELECT id, surface, title,
       CASE WHEN last_verified IS NULL AND review_cadence_days IS NULL
              THEN 'no lastVerified and no reviewCadenceDays'
            WHEN last_verified IS NULL THEN 'no lastVerified'
            ELSE 'no reviewCadenceDays' END AS reason
FROM   item
WHERE  last_verified IS NULL OR review_cadence_days IS NULL;

-- Staleness that works across the WHOLE estate, because every citation carries
-- its own lastVerified even where the item does not, and the cadence comes from
-- the source registry rather than the content file. This is the currency signal
-- to drive needs-updating from: it does not go quiet on a surface that omits a
-- field.
CREATE VIEW v_stale_citation AS
SELECT i.id AS item_id, i.surface, i.title, c.url, c.source_id, s.publisher,
       c.last_verified, s.review_cadence_days,
       CAST(julianday('now') - julianday(c.last_verified) AS INTEGER) AS days_since_verified
FROM   citation c
JOIN   item   i ON i.id = c.item_id
JOIN   source s ON s.id = c.source_id
WHERE  c.last_verified IS NOT NULL
  AND  s.review_cadence_days IS NOT NULL
  AND  julianday('now') - julianday(c.last_verified) > s.review_cadence_days;

-- The re-render list. Pass an avatar name the day it is withdrawn.
CREATE VIEW v_render_manifest AS
SELECT r.avatar, r.voice, r.rendering_kind, r.item_id, i.title, i.surface, r.rendered_at
FROM   rendering r
LEFT JOIN item i ON i.id = r.item_id;

-- Provenance, in the direction it is actually asked in: start from a piece of
-- published content and get back to the run that wrote it.
--
-- The other direction matters too and needs no view. Filter on run_id to get
-- everything one run published, which is the query to run the day a model is
-- found to be producing bad content.
CREATE VIEW v_provenance AS
SELECT p.subject_id,
       COALESCE(p.item_id, i.id)   AS item_id,
       i.surface,
       COALESCE(i.title, w.title)  AS title,
       i.path,
       p.run_id,
       p.brief_id,
       p.proposal_file,
       p.disposition,
       p.accepted_by,
       p.published_at,
       w.state                     AS work_item_state
FROM   publication p
LEFT JOIN item      i ON i.id = COALESCE(p.item_id, p.subject_id)
LEFT JOIN work_item w ON w.subject_id = p.subject_id
ORDER BY p.published_at DESC;

-- Published content whose provenance is missing. The honest companion to
-- v_provenance, for the same reason v_unmeasurable exists: a provenance table
-- can only answer for rows that are in it, and content that predates the
-- pipeline or was committed by hand leaves no row at all. Reading v_provenance
-- alone would make a mostly unprovenanced estate look fully traced.
CREATE VIEW v_unprovenanced AS
SELECT i.id AS item_id, i.surface, i.title, i.path
FROM   item i
WHERE  NOT EXISTS (
  SELECT 1 FROM publication p WHERE COALESCE(p.item_id, p.subject_id) = i.id
);
