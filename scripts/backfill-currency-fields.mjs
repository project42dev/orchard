#!/usr/bin/env node
// Give every content item the two fields the currency engine needs.
//
// An item without lastVerified and reviewCadenceDays cannot be stale, so it
// drops silently out of every staleness count and the total looks healthy. On
// the estate this was written for, that was 66 of 150 items.
//
// Neither value is invented. Both are derived from evidence the item already
// carries:
//
//   lastVerified       = the OLDEST lastVerified among the item's own citations.
//                        The oldest is the honest floor: an item is only as
//                        freshly checked as its least freshly checked source.
//
//   reviewCadenceDays  = the STRICTEST reviewCadenceDays among the registered
//                        sources the item cites. An item must be reviewed at
//                        least as often as its fastest moving source, or the
//                        cadence is decorative.
//
// An item whose citations cannot supply either value is LEFT ALONE and reported.
// Writing a guess would recreate the original defect wearing a number.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSources, resolveSourceId, DEFAULT_SURFACES } from './build-content-db.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
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

export function deriveCurrency(doc, sources) {
  const citations = Array.isArray(doc.sources) ? doc.sources : [];
  const dates = citations
    .map((c) => c?.lastVerified)
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const cadences = citations
    .map((c) => resolveSourceId(c?.url, sources))
    .filter(Boolean)
    .map((id) => sources.find((s) => s.id === id)?.reviewCadenceDays)
    .filter((n) => Number.isInteger(n) && n > 0);

  return {
    lastVerified: dates.length ? dates[0] : null,
    reviewCadenceDays: cadences.length ? Math.min(...cadences) : null,
  };
}

export function backfill({ contentRoot, surfaces = DEFAULT_SURFACES, apply = false }) {
  const sources = loadSources(join(contentRoot, 'source-registry.json'));
  const updated = [];
  const skipped = [];

  for (const { dir } of surfaces) {
    for (const file of walkJson(join(contentRoot, dir))) {
      let doc;
      try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (!doc || typeof doc !== 'object' || !doc.id || !doc.title) continue;

      const needsVerified = doc.lastVerified === undefined || doc.lastVerified === null;
      const needsCadence = !Number.isInteger(doc.reviewCadenceDays);
      if (!needsVerified && !needsCadence) continue;

      const derived = deriveCurrency(doc, sources);
      const rel = relative(contentRoot, file).split(sep).join('/');

      if ((needsVerified && !derived.lastVerified) || (needsCadence && !derived.reviewCadenceDays)) {
        skipped.push({
          path: rel,
          id: doc.id,
          reason: !Array.isArray(doc.sources) || doc.sources.length === 0
            ? 'the item cites nothing, so there is no evidence to derive from'
            : 'its citations carry no usable date or no registered source',
        });
        continue;
      }

      // Insert the two lines as TEXT, immediately after "level", leaving every
      // other byte alone.
      //
      // Re-serialising the parsed object instead would rewrite formatting the
      // author chose: a first attempt at this expanded every compact array and
      // turned a two-line addition into 8,576 changed lines across 66 files. A
      // diff nobody can read is a diff nobody reviews.
      const raw = readFileSync(file, 'utf8');
      const anchor = /^([ \t]*)"level"\s*:.*,[ \t]*\r?\n/m.exec(raw);
      if (!anchor) {
        skipped.push({ path: rel, id: doc.id, reason: 'no "level" line to anchor the insertion to' });
        continue;
      }

      const pad = anchor[1];
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const lines = [];
      if (needsCadence) lines.push(`${pad}"reviewCadenceDays": ${derived.reviewCadenceDays},`);
      if (needsVerified) lines.push(`${pad}"lastVerified": ${JSON.stringify(derived.lastVerified)},`);
      const insertAt = anchor.index + anchor[0].length;
      const next = raw.slice(0, insertAt) + lines.join(eol) + eol + raw.slice(insertAt);

      // Never write something that no longer parses, and never change any value
      // other than the two being added.
      let reparsed;
      try { reparsed = JSON.parse(next); } catch {
        skipped.push({ path: rel, id: doc.id, reason: 'the edit would not have parsed, so it was not written' });
        continue;
      }
      const before = JSON.stringify({ ...doc, lastVerified: undefined, reviewCadenceDays: undefined });
      const after = JSON.stringify({ ...reparsed, lastVerified: undefined, reviewCadenceDays: undefined });
      if (before !== after) {
        skipped.push({ path: rel, id: doc.id, reason: 'the edit would have changed a value other than the two being added' });
        continue;
      }

      if (apply) writeFileSync(file, next);

      updated.push({
        path: rel,
        id: doc.id,
        lastVerified: reparsed.lastVerified,
        reviewCadenceDays: reparsed.reviewCadenceDays,
        citations: doc.sources?.length ?? 0,
      });
    }
  }

  return { updated, skipped };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.content) {
    console.error('usage: backfill-currency-fields.mjs --content <content-root> [--apply]');
    process.exit(2);
  }
  const r = backfill({ contentRoot: resolve(args.content), apply: Boolean(args.apply) });

  console.log(`${r.updated.length} item(s) ${args.apply ? 'updated' : 'would be updated'}`);
  const byCadence = {};
  for (const u of r.updated) byCadence[u.reviewCadenceDays] = (byCadence[u.reviewCadenceDays] ?? 0) + 1;
  for (const [days, n] of Object.entries(byCadence).sort((a, b) => a[0] - b[0])) {
    console.log(`  cadence ${days} days: ${n} item(s)`);
  }

  if (r.skipped.length) {
    console.log(`\n${r.skipped.length} item(s) LEFT ALONE, because a derived value would have been a guess:`);
    for (const s of r.skipped) console.log(`  ${s.path}: ${s.reason}`);
  }
  if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
