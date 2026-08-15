#!/usr/bin/env node
// Compile the content files into a queryable index.
//
// The content files stay the source of truth. This database is derived from
// them and can be deleted and rebuilt at any time, EXCEPT for two tables that
// hold state existing nowhere else: work_item, which carries what a human
// decided about a piece of work, and rendering, which records what was actually
// produced. Those survive every rebuild.
//
// The build PROPOSES work items. It never resets one. If a human rejected a
// work item, no later build may resurrect it, for exactly the reason a rejected
// discovery candidate is never re-proposed: a decision that a machine can undo
// is not a decision.
//
// Uses node:sqlite, built into Node 22.5 and later. No dependency to install,
// which matters because an adopter has to be able to run this from a clone.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'schema', 'content-db.sql');
// 1.1 adds the publication table and the two provenance views. Additive only,
// so an existing database picks them up on the next build without losing a row.
const SCHEMA_VERSION = '1.1';

// A surface is a directory of content plus the name the rest of the system
// knows it by. Declared here rather than inferred, so adding one is a visible
// change.
export const DEFAULT_SURFACES = [
  { dir: 'modules', surface: 'learn' },
  { dir: 'resources', surface: 'field-guide' },
  { dir: 'visual-guides', surface: 'visual-guide' },  // loaded from platform package
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function walkJson(root) {
  const found = [];
  if (!existsSync(root)) return found;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.json')) found.push(full);
    }
  }
  return found.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Resolve a citation URL to a registered source by longest matching prefix.
// Longest wins so that a specific prefix beats a general one covering the same
// host, which is the only behaviour that stays correct as the registry grows.
export function resolveSourceId(url, sources) {
  let best = null;
  for (const s of sources) {
    if (typeof url === 'string' && url.startsWith(s.urlPrefix)) {
      if (!best || s.urlPrefix.length > best.urlPrefix.length) best = s;
    }
  }
  return best ? best.id : null;
}

// A missing registry used to produce an empty array, a zero exit and a build
// that reported success. That is the worst failure mode this project has: the
// operator sees "sources 0" in a wall of output, reads it as a small number
// rather than as an absence, and ships a database that dropped every source.
// A registry that cannot be read is now a hard stop. A build that genuinely has
// no registry has to say so with --allow-missing-registries, because deciding
// to index nothing is a decision and decisions get stated.
function openRegistry(registryPath, what, allowMissing) {
  if (!registryPath) throw new Error(`${what} path is required`);
  if (existsSync(registryPath)) return readJson(registryPath);
  if (allowMissing) {
    console.error(`WARNING: ${what} absent at ${registryPath}, building without it as instructed.`);
    return null;
  }
  throw new Error(
    `${what} not found at ${registryPath}. Refusing to build, because an absent `
    + 'registry writes an empty table and still exits 0. Restore the file, or pass '
    + '--allow-missing-registries to build without it deliberately.',
  );
}

// Rows that cannot be indexed are reported by id rather than dropped in
// silence, for the same reason: a shrinking count nobody is watching is not a
// signal.
function reportDropped(dropped, what) {
  if (!dropped.length) return;
  console.error(`WARNING: ${dropped.length} ${what} entr(ies) skipped for missing required fields: ${dropped.join(', ')}`);
}

export function loadSources(registryPath, { allowMissing = false } = {}) {
  const doc = openRegistry(registryPath, 'source registry', allowMissing);
  if (doc === null) return [];
  const entries = Array.isArray(doc) ? doc : (doc.sources ?? []);
  if (!Array.isArray(entries)) throw new Error(`source registry at ${registryPath} has no sources array`);
  const dropped = [];
  const rows = entries.map((e) => ({
    id: e.id,
    urlPrefix: e.urlPrefix,
    publisher: e.publisher ?? null,
    trustTier: e.trustTier ?? null,
    reviewCadenceDays: e.reviewCadenceDays ?? null,
    owner: e.owner ?? null,
  })).filter((e) => {
    if (e.id && e.urlPrefix) return true;
    dropped.push(e.id ?? '<no id>');
    return false;
  });
  reportDropped(dropped, 'source');
  return rows;
}

export function loadCandidates(registryPath, { allowMissing = false } = {}) {
  const doc = openRegistry(registryPath, 'opportunity registry', allowMissing);
  if (doc === null) return [];
  const rows = doc.opportunities ?? doc.candidates ?? doc.entries ?? [];
  if (!Array.isArray(rows)) throw new Error(`opportunity registry at ${registryPath} has no opportunities array`);
  const dropped = [];
  const parsed = rows.map((c) => ({
    id: c.id,
    topicId: c.topicId ?? c.probeId ?? null,
    topicTitle: c.title ?? null,
    surface: c.surface ?? c.kind ?? null,
    status: c.status ?? null,
    level: c.level ?? null,
    supplyOccurrences: c.evidence?.corpusOccurrences
      ?? c.supply?.occurrences ?? null,
    demandSources: c.marketMeasurement?.sourceCount
      ?? c.demand?.sourceCount ?? null,
  })).filter((c) => {
    if (c.id) return true;
    dropped.push(c.topicTitle ?? '<no id>');
    return false;
  });
  reportDropped(dropped, 'candidate');
  return parsed;
}

function readItem(path, surface, contentRoot) {
  let doc;
  try {
    doc = readJson(path);
  } catch {
    return null;
  }
  // A content item declares an id and a title. Delivery contracts, schemas and
  // other machinery in the same tree do not, and are skipped rather than
  // indexed as empty rows.
  if (!doc || typeof doc !== 'object' || !doc.id || !doc.title) return null;

  const raw = readFileSync(path, 'utf8');
  return {
    id: String(doc.id),
    surface,
    path: relative(contentRoot, path).split(sep).join('/'),
    title: doc.title ?? null,
    summary: doc.summary ?? null,
    level: doc.level ?? null,
    estimatedMinutes: Number.isInteger(doc.estimatedMinutes) ? doc.estimatedMinutes : null,
    owner: doc.owner ?? null,
    reviewCadenceDays: Number.isInteger(doc.reviewCadenceDays) ? doc.reviewCadenceDays : null,
    lastVerified: doc.lastVerified ?? null,
    contentSha256: sha256(raw),
    tags: Array.isArray(doc.tags) ? doc.tags.map(String) : [],
    providers: Array.isArray(doc.providers) ? doc.providers.map(String) : [],
    sources: Array.isArray(doc.sources) ? doc.sources : [],
  };
}

// Load visual-guide items from the @project42/platform package.
// Returns an array of items in the same format as readItem.
function loadVisualGuideItems(contentRoot) {
  const items = [];
  try {
    // Find the platform package in node_modules - look from the project root,
    // not the content root (which might be a test fixture)
    const projectRoot = resolve(HERE, '..');
    const platformPath = join(projectRoot, 'node_modules', '@project42', 'platform');
    const cataloguePath = join(platformPath, 'content', 'diagrams', 'catalogue.json');

    if (!existsSync(cataloguePath)) {
      // Silent when the package isn't installed (e.g., in a test fixture)
      return items;
    }

    const catalogue = readJson(cataloguePath);
    const diagrams = catalogue.diagrams ?? [];

    for (const diagram of diagrams) {
      if (!diagram.id || !diagram.title) continue;

      const sourcePath = join(platformPath, 'content', 'diagrams', diagram.source);
      const raw = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';

      items.push({
        id: `${diagram.id}-visual-guide`,
        surface: 'visual-guide',
        path: `@platform/diagrams/${diagram.source}`,
        title: diagram.title,
        summary: diagram.summary ?? null,
        level: null,  // diagrams don't have skill levels
        estimatedMinutes: null,
        owner: null,
        reviewCadenceDays: null,
        lastVerified: null,
        contentSha256: sha256(raw),
        tags: diagram.category ? [diagram.category] : [],
        providers: [],
        sources: [],
      });
    }
  } catch (error) {
    // Visual guides are optional: the platform package may not be installed.
    // Optional is not the same as invisible, so say which one happened rather
    // than swallowing a real read or parse error along with the expected one.
    console.error(`WARNING: visual guides not indexed (${error.message}). This is expected only when the platform package is absent.`);
  }

  return items;
}

export function buildContentDb({ contentRoot, dbPath, surfaces = DEFAULT_SURFACES, now = new Date().toISOString(), allowMissingRegistries = false }) {
  // Read both registries BEFORE touching the database, so a missing input
  // fails without having created or altered anything.
  const sources = loadSources(join(contentRoot, 'source-registry.json'), { allowMissing: allowMissingRegistries });
  const candidates = loadCandidates(join(contentRoot, 'opportunity-registry.json'), { allowMissing: allowMissingRegistries });

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const insertSource = db.prepare(
    'INSERT INTO source (id, url_prefix, publisher, trust_tier, review_cadence_days, owner) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const s of sources) {
    insertSource.run(s.id, s.urlPrefix, s.publisher, s.trustTier, s.reviewCadenceDays, s.owner);
  }

  const insertItem = db.prepare(
    `INSERT INTO item (id, surface, path, title, summary, level, estimated_minutes,
                       owner, review_cadence_days, last_verified, content_sha256, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCitation = db.prepare(
    'INSERT INTO citation (item_id, url, title, publisher, last_verified, source_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTag = db.prepare('INSERT INTO item_tag (item_id, tag) VALUES (?, ?)');
  const insertProvider = db.prepare('INSERT INTO item_provider (item_id, provider) VALUES (?, ?)');

  const stats = { items: 0, citations: 0, skipped: 0, unresolvedCitations: 0, duplicateIds: [] };
  const seenIds = new Set();

  for (const { dir, surface } of surfaces) {
    // Visual-guide items come from the platform package, not the content root
    if (surface === 'visual-guide') {
      const visualGuideItems = loadVisualGuideItems(contentRoot);
      for (const item of visualGuideItems) {
        if (seenIds.has(item.id)) { stats.duplicateIds.push(item.id); continue; }
        seenIds.add(item.id);

        insertItem.run(
          item.id, item.surface, item.path, item.title, item.summary, item.level,
          item.estimatedMinutes, item.owner, item.reviewCadenceDays, item.lastVerified,
          item.contentSha256, now,
        );
        stats.items += 1;

        for (const tag of item.tags) insertTag.run(item.id, tag);
        for (const p of item.providers) insertProvider.run(item.id, p);
        for (const src of item.sources) {
          const sourceId = resolveSourceId(src?.url, sources);
          if (!sourceId) stats.unresolvedCitations += 1;
          insertCitation.run(
            item.id, src?.url ?? '', src?.title ?? null, src?.publisher ?? null,
            src?.lastVerified ?? null, sourceId,
          );
          stats.citations += 1;
        }
      }
      continue;
    }

    for (const file of walkJson(join(contentRoot, dir))) {
      const item = readItem(file, surface, contentRoot);
      if (!item) { stats.skipped += 1; continue; }
      // Two content files claiming the same id is a real defect and silently
      // keeping the last one would hide it.
      if (seenIds.has(item.id)) { stats.duplicateIds.push(item.id); continue; }
      seenIds.add(item.id);

      insertItem.run(
        item.id, item.surface, item.path, item.title, item.summary, item.level,
        item.estimatedMinutes, item.owner, item.reviewCadenceDays, item.lastVerified,
        item.contentSha256, now,
      );
      stats.items += 1;

      for (const tag of item.tags) insertTag.run(item.id, tag);
      for (const p of item.providers) insertProvider.run(item.id, p);
      for (const src of item.sources) {
        const sourceId = resolveSourceId(src?.url, sources);
        if (!sourceId) stats.unresolvedCitations += 1;
        insertCitation.run(
          item.id, src?.url ?? '', src?.title ?? null, src?.publisher ?? null,
          src?.lastVerified ?? null, sourceId,
        );
        stats.citations += 1;
      }
    }
  }

  const insertCandidate = db.prepare(
    `INSERT INTO candidate (id, topic_id, topic_title, surface, status, level,
                            supply_occurrences, demand_sources, score, attention, gap_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of candidates) {
    insertCandidate.run(
      c.id, c.topicId, c.topicTitle, c.surface, c.status, c.level,
      c.supplyOccurrences, c.demandSources, null, null, null,
    );
  }

  const queue = syncWorkQueue(db, now);

  // Report what the staleness views CANNOT see. A count of zero stale items is
  // only good news if everything was eligible to be counted.
  stats.unmeasurable = db.prepare(
    'SELECT surface, reason, count(*) AS n FROM v_unmeasurable GROUP BY surface, reason',
  ).all();
  stats.stale = db.prepare('SELECT count(*) AS n FROM v_stale').get().n;
  stats.staleCitations = db.prepare(
    'SELECT count(DISTINCT item_id) AS n FROM v_stale_citation',
  ).get().n;

  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schemaVersion', SCHEMA_VERSION);
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('builtAt', now);

  db.close();
  return { ...stats, candidates: candidates.length, sources: sources.length, ...queue };
}

// Propose work, never overwrite a decision.
//
// A candidate that is not retired or rejected becomes a needs-creating item.
// An item past its review cadence becomes a needs-updating item. Both are
// inserted only when absent. An existing row keeps its state, its owner, and
// its note, whatever the build thinks.
// GATE 1. New work enters as 'gate1-pending', NOT 'queued'.
//
// generate-briefs.mjs selects `WHERE state = 'queued'`, so an item that has not
// been approved by the owner can never reach authoring, and therefore can never
// spend money on a model. Approval moves 'gate1-pending' to 'queued' and is the
// only way in. Before this, every non-retired candidate was queued on sight and
// authored before the owner saw it, which meant declining an item was only ever
// possible after paying to write it.
export function syncWorkQueue(db, now) {
  const exists = db.prepare('SELECT state FROM work_item WHERE kind = ? AND subject_id = ?');
  const insert = db.prepare(
    `INSERT INTO work_item (id, kind, subject_id, surface, title, state, priority, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, 'gate1-pending', ?, ?, ?)`,
  );

  let created = 0;
  let preserved = 0;

  const openCandidates = db.prepare(
    `SELECT id, surface, topic_title FROM candidate
     WHERE status IS NULL OR status NOT IN ('retired', 'rejected', 'published')`,
  ).all();
  for (const c of openCandidates) {
    if (exists.get('needs-creating', c.id)) { preserved += 1; continue; }
    insert.run(`create:${c.id}`, 'needs-creating', c.id, c.surface ?? 'unknown',
      c.topic_title ?? c.id, null, now, now);
    created += 1;
  }

  // Two staleness signals, deliberately. v_stale uses the item's own declared
  // cadence and goes silent on any surface that omits the field. v_stale_citation
  // works estate-wide because every citation carries a date and the cadence comes
  // from the source registry. Using only the first would report a healthy empty
  // queue for a surface it simply cannot see.
  const stale = db.prepare(
    `SELECT id, surface, title FROM v_stale
     UNION
     SELECT DISTINCT item_id AS id, surface, title FROM v_stale_citation`,
  ).all();
  for (const s of stale) {
    if (exists.get('needs-updating', s.id)) { preserved += 1; continue; }
    insert.run(`update:${s.id}`, 'needs-updating', s.id, s.surface,
      s.title ?? s.id, null, now, now);
    created += 1;
  }

  return { workItemsCreated: created, workItemsPreserved: preserved };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const contentRoot = args.content;
  const dbPath = args.db;
  if (!contentRoot || !dbPath) {
    console.error('usage: build-content-db.mjs --content <content-root> --db <output.db> [--allow-missing-registries]');
    process.exit(2);
  }

  const r = buildContentDb({
    contentRoot: resolve(contentRoot),
    dbPath: resolve(dbPath),
    allowMissingRegistries: args['allow-missing-registries'] === true,
  });

  console.log(`content root: ${resolve(contentRoot)}`);
  console.log(`database:     ${resolve(dbPath)}`);
  console.log(`  items       ${r.items} indexed, ${r.skipped} non-content file(s) skipped`);
  console.log(`  citations   ${r.citations}, ${r.unresolvedCitations} not matching any registered source`);
  console.log(`  sources     ${r.sources}`);
  console.log(`  candidates  ${r.candidates}`);
  console.log(`  queue       ${r.workItemsCreated} new, ${r.workItemsPreserved} existing left untouched`);
  console.log(`  staleness   ${r.stale} item(s) past their own cadence, ${r.staleCitations} item(s) with a stale citation`);

  if (r.unmeasurable.length) {
    const total = r.unmeasurable.reduce((n, u) => n + u.n, 0);
    console.log(`\nSTALENESS IS BLIND TO ${total} OF ${r.items} ITEM(S). A low stale count above does not cover these:`);
    for (const u of r.unmeasurable) {
      console.log(`  ${u.surface}: ${u.n} item(s), ${u.reason}`);
    }
    console.log('  Citation dates still cover them, which is why needs-updating also reads v_stale_citation.');
  }

  if (r.duplicateIds.length) {
    console.error(`\nDUPLICATE ids, only the first of each was indexed: ${r.duplicateIds.join(', ')}`);
    process.exit(1);
  }

  // Mirror new work items to Azure DevOps if --ado-sync is passed.
  // This is optional: local dev builds skip it, CI builds include it.
  if (args['ado-sync'] && r.workItemsCreated > 0) {
    const org = args['ado-org'] || 'hybridcloudsolutions';
    const project = args['ado-project'] || 'Project 42';
    const area = args['ado-area'] || 'Project 42\\Content Intelligence';
    console.log(`\nADO sync: mirroring ${r.workItemsCreated} new work item(s) to Azure DevOps...`);
    try {
      const adoArgs = [
        `--db`, `"${resolve(dbPath)}"`,
        `--operation`, `create`,
        `--org`, org,
        `--project`, `"${project}"`,
        `--area`, `"${area}"`,
        `--apply`,
      ];
      execSync(`node "${resolve(HERE, 'ado-sync.mjs')}" ${adoArgs.join(' ')}`, {
        encoding: 'utf-8',
        stdio: 'inherit',
        timeout: 60_000,
      });
    } catch (err) {
      console.error('ADO sync failed (non-fatal — database is still valid):');
      console.error(err.stderr || err.message);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
