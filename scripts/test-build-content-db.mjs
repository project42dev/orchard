#!/usr/bin/env node
// Tests for the content database build.
//
// These assert the PROMISES, not the arithmetic. The promises are what a
// future change can quietly break: that a rebuild never destroys a human
// decision, that derived data really is rebuilt, and that a staleness count
// cannot go quiet on content it is structurally unable to see.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContentDb, resolveSourceId, DEFAULT_SURFACES } from './build-content-db.mjs';
import { backfill, deriveCurrency } from './backfill-currency-fields.mjs';

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) { passed += 1; } else { failures.push(label); }
}

function equal(label, actual, expected) {
  check(`${label} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
    actual === expected);
}

// --- fixture -----------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'orchard-db-'));
const content = join(root, 'content');
mkdirSync(join(content, 'modules'), { recursive: true });
mkdirSync(join(content, 'resources'), { recursive: true });

const OLD = '2020-01-01';
const NEW = new Date().toISOString().slice(0, 10);

writeFileSync(join(content, 'source-registry.json'), JSON.stringify({
  sources: [
    { id: 'vendor-docs', urlPrefix: 'https://vendor.example/', publisher: 'Vendor', reviewCadenceDays: 30 },
    { id: 'vendor-api-docs', urlPrefix: 'https://vendor.example/api/', publisher: 'Vendor API', reviewCadenceDays: 30 },
  ],
}));

writeFileSync(join(content, 'opportunity-registry.json'), JSON.stringify({
  opportunities: [
    { id: 'open-one', title: 'An open candidate', surface: 'learn', status: 'candidate' },
    { id: 'retired-one', title: 'A retired candidate', surface: 'learn', status: 'retired' },
  ],
}));

// A module with no lastVerified and no cadence: unmeasurable by v_stale.
writeFileSync(join(content, 'modules', 'a.json'), JSON.stringify({
  id: 'mod-a', title: 'Module A', level: 'beginner',
  sources: [{ url: 'https://vendor.example/api/reference', title: 'API', lastVerified: OLD }],
}));

// A resource that declares both fields and is long overdue.
writeFileSync(join(content, 'resources', 'b.json'), JSON.stringify({
  id: 'res-b', title: 'Resource B', level: 'advanced',
  reviewCadenceDays: 30, lastVerified: OLD, tags: ['x'], providers: ['p'],
  sources: [{ url: 'https://vendor.example/guide', lastVerified: NEW }],
}));

// Not a content item: no id, no title. Must be skipped, not indexed empty.
writeFileSync(join(content, 'resources', 'contract.json'), JSON.stringify({
  kind: 'delivery-contract', steps: [],
}));

const dbPath = join(root, 'content.db');
const first = buildContentDb({ contentRoot: content, dbPath, surfaces: DEFAULT_SURFACES });

// --- indexing ----------------------------------------------------------------

equal('two content items indexed plus 8 visual-guide items from platform', first.items, 10);
equal('the non-content file is skipped, not indexed as an empty row', first.skipped, 1);
equal('both citations indexed', first.citations, 2);
equal('every citation resolved to a registered source', first.unresolvedCitations, 0);

equal('longest matching prefix wins, not the first match',
  resolveSourceId('https://vendor.example/api/reference', [
    { id: 'vendor-docs', urlPrefix: 'https://vendor.example/' },
    { id: 'vendor-api-docs', urlPrefix: 'https://vendor.example/api/' },
  ]), 'vendor-api-docs');

equal('an unregistered url resolves to nothing rather than guessing',
  resolveSourceId('https://elsewhere.example/x', [
    { id: 'vendor-docs', urlPrefix: 'https://vendor.example/' },
  ]), null);

// --- the blindness guard, which is the defect this caught -------------------

{
  const db = new DatabaseSync(dbPath);
  const unmeasurable = db.prepare('SELECT * FROM v_unmeasurable').all();
  equal('the item lacking both fields is NAMED as unmeasurable, plus 8 visual-guides', unmeasurable.length, 9);
  check('mod-a is in the unmeasurable set', unmeasurable.some(u => u.id === 'mod-a'));

  const stale = db.prepare('SELECT id FROM v_stale').all().map((r) => r.id);
  check('v_stale cannot see the unmeasurable item, which is exactly why v_unmeasurable exists',
    !stale.includes('mod-a'));
  check('v_stale does catch the item that declares its own cadence', stale.includes('res-b'));

  const staleCite = db.prepare('SELECT DISTINCT item_id FROM v_stale_citation').all().map((r) => r.item_id);
  check('the citation signal reaches the item v_stale is blind to', staleCite.includes('mod-a'));

  const queued = db.prepare("SELECT subject_id FROM work_item WHERE kind = 'needs-updating'")
    .all().map((r) => r.subject_id);
  check('needs-updating covers the item only the citation signal can see', queued.includes('mod-a'));
  check('needs-updating covers the item the cadence signal can see', queued.includes('res-b'));
  db.close();
}

// --- the queue ---------------------------------------------------------------

{
  const db = new DatabaseSync(dbPath);
  const creating = db.prepare("SELECT subject_id FROM work_item WHERE kind = 'needs-creating'")
    .all().map((r) => r.subject_id);
  check('an open candidate becomes a needs-creating item', creating.includes('open-one'));
  check('a retired candidate does NOT', !creating.includes('retired-one'));

  const kinds = db.prepare('SELECT DISTINCT kind FROM v_queue').all().map((r) => r.kind).sort();
  equal('needs-creating and needs-updating are ONE queue, not two',
    kinds.join(','), 'needs-creating,needs-updating');
  db.close();
}

// --- what a rebuild must never destroy --------------------------------------

{
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE work_item SET state = 'in-progress', claimed_by = 'kris', note = 'mine' WHERE subject_id = 'open-one'").run();
  db.prepare("UPDATE work_item SET state = 'rejected' WHERE subject_id = 'res-b'").run();
  db.prepare(`INSERT INTO rendering (item_id, rendering_kind, avatar, voice, rendered_at)
              VALUES ('res-b', 'instructor-video', 'Camila', 'en-US-AvaNeural', '2026-08-03T00:00:00Z')`).run();
  db.close();
}

const second = buildContentDb({ contentRoot: content, dbPath, surfaces: DEFAULT_SURFACES });

{
  const db = new DatabaseSync(dbPath);

  const claimed = db.prepare("SELECT state, claimed_by, note FROM work_item WHERE subject_id = 'open-one'").get();
  equal('a rebuild does not reset an in-progress work item', claimed.state, 'in-progress');
  equal('and does not drop who claimed it', claimed.claimed_by, 'kris');
  equal('and does not drop the note', claimed.note, 'mine');

  const rejected = db.prepare("SELECT state FROM work_item WHERE subject_id = 'res-b'").get();
  equal('a rejected work item is NEVER resurrected by a later build', rejected.state, 'rejected');

  const rendering = db.prepare("SELECT avatar FROM rendering WHERE item_id = 'res-b'").all();
  equal('render records survive a rebuild, or a withdrawn avatar cannot be traced', rendering.length, 1);
  equal('and keep the avatar that produced them', rendering[0].avatar, 'Camila');

  const manifest = db.prepare("SELECT item_id FROM v_render_manifest WHERE avatar = 'Camila'").all();
  equal('the re-render list answers "what did this avatar render"', manifest.length, 1);

  equal('a second build proposes nothing new', second.workItemsCreated, 0);
  check('and reports what it left alone', second.workItemsPreserved > 0);

  equal('derived items are rebuilt, not duplicated',
    db.prepare('SELECT count(*) AS n FROM item').get().n, 10);
  equal('derived citations are rebuilt, not duplicated',
    db.prepare('SELECT count(*) AS n FROM citation').get().n, 2);
  db.close();
}

// --- derived data really is derived ------------------------------------------

rmSync(join(content, 'resources', 'b.json'));
buildContentDb({ contentRoot: content, dbPath, surfaces: DEFAULT_SURFACES });

{
  const db = new DatabaseSync(dbPath);
  const gone = db.prepare("SELECT count(*) AS n FROM item WHERE id = 'res-b'").get().n;
  equal('deleting a content file removes it from the derived index', gone, 0);

  const stillRejected = db.prepare("SELECT state FROM work_item WHERE subject_id = 'res-b'").get();
  equal('but the human decision about it survives, because it exists nowhere else',
    stillRejected.state, 'rejected');
  db.close();
}

// --- the currency backfill ---------------------------------------------------

{
  const sources = [
    { id: 'fast', urlPrefix: 'https://fast.example/', reviewCadenceDays: 30 },
    { id: 'slow', urlPrefix: 'https://slow.example/', reviewCadenceDays: 365 },
  ];

  const d = deriveCurrency({
    sources: [
      { url: 'https://slow.example/a', lastVerified: '2026-01-01' },
      { url: 'https://fast.example/b', lastVerified: '2025-01-01' },
    ],
  }, sources);
  equal('lastVerified takes the OLDEST citation, because an item is only as fresh as its stalest source',
    d.lastVerified, '2025-01-01');
  equal('reviewCadenceDays takes the STRICTEST source cadence, or the cadence is decorative',
    d.reviewCadenceDays, 30);

  const none = deriveCurrency({ sources: [] }, sources);
  check('an item citing nothing derives nothing rather than guessing',
    none.lastVerified === null && none.reviewCadenceDays === null);

  const unregistered = deriveCurrency({
    sources: [{ url: 'https://nowhere.example/x', lastVerified: '2026-01-01' }],
  }, sources);
  equal('an unregistered citation yields a date but no cadence', unregistered.reviewCadenceDays, null);

  // The formatting promise: a backfill adds two lines and touches nothing else.
  const fixture = mkdtempSync(join(tmpdir(), 'orchard-backfill-'));
  mkdirSync(join(fixture, 'modules'), { recursive: true });
  mkdirSync(join(fixture, 'resources'), { recursive: true });
  writeFileSync(join(fixture, 'source-registry.json'), JSON.stringify({
    sources: [{ id: 'fast', urlPrefix: 'https://fast.example/', reviewCadenceDays: 30 }],
  }));
  const before = '{\n  "id": "m",\n  "title": "T",\n  "level": "beginner",\n  "providers": ["a", "b"],\n  "sources": [{ "url": "https://fast.example/x", "lastVerified": "2026-01-01" }]\n}\n';
  const target = join(fixture, 'modules', 'm.json');
  writeFileSync(target, before);

  backfill({ contentRoot: fixture, apply: true });
  const after = readFileSync(target, 'utf8');

  equal('the backfill adds exactly two lines',
    after.split('\n').length - before.split('\n').length, 2);
  check('and leaves the author\'s compact array formatting alone',
    after.includes('"providers": ["a", "b"]'));
  check('and places them after level', /"level".*\n\s*"reviewCadenceDays"/.test(after));
  equal('and the result still parses', JSON.parse(after).reviewCadenceDays, 30);

  const secondRun = backfill({ contentRoot: fixture, apply: true });
  equal('re-running changes nothing, because the fields are already there',
    secondRun.updated.length, 0);

  rmSync(fixture, { recursive: true, force: true });
}

// --- report ------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL. ${failures.length} of ${passed + failures.length} assertions failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS. ${passed} assertions on the content database build.`);
