#!/usr/bin/env node
// verify-published-live.mjs - prove published content is actually serving.
//
// The gap this closes: the pipeline treated a push as publication. A commit
// landing is not the same as a page serving. A build can fail, a route can be
// wrong, a catalogue entry can be missing, and every record in the database
// would still say "published" while a reader gets a 404.
//
// This fetches the expected public URL and checks the content is really there.
// It is deliberately strict about what counts as proof:
//
//   - a 2xx is NOT sufficient on its own, because single-page apps and
//     not-found pages routinely return 200
//   - the response must contain a marker drawn from the item itself
//   - a redirect away from the expected path is a failure, not a pass
//
// Exit code 0 only when every checked item is genuinely serving.

const DEFAULT_TIMEOUT_MS = 15000;

// THE PUBLIC ROUTE IS DERIVED FROM THE TARGET PATH, NOT FROM A TEMPLATE.
//
// The first version substituted `{topic}` out of the item row. Nothing ever put
// a `topic` on that row: PUBLISHED_ITEMS_SQL projects id, published_at, surface,
// target_repository and path, and `id` is a UUID. So `expectedUrl` returned
// "did not fully resolve" for EVERY item, `verifyAll` counted every item as a
// failure with no URL ever fetched, and live verification silently verified
// nothing while looking like a working check. That is the exact defect class
// this repository's own rules call worse than no check at all.
//
// A template could not have been made to work either, because `{topic}` was
// asked to mean two different things at once. For a learning module the public
// route keys on the LEARNING PATH the module was filed into; for a field-guide
// resource it keys on the LEAF RESOURCE, not on the pack directory the file
// sits in. `pathTemplates: resources/{topic}/` names a pack; the route
// /guide/resources/<id> names a resource. Proven live on 2026-09-06:
//
//   GET /guide/resources/ai-assisted-code-review-checklist  ->  200  (a leaf)
//   GET /guide/resources/coding-agents                      ->  404  (its pack)
//
// The one thing that always knows which is which is the path the artifact was
// actually published to, which is already persisted on the publication
// transaction. So the route is derived from it, per surface, by the same
// path-shape rules registration.mjs uses to decide what to register.
//
// Content-repository paths carry no `content/` prefix: the trees are modules/,
// resources/ and diagrams/ at the repository root.
//
// Verified live 2026-09-06 against https://project-42.dev.
export function publicPathForTarget(targetPath) {
  const path = String(targetPath ?? "").trim();
  if (!path) return { error: "the publication transaction records no target path, so no public URL can be derived" };

  // modules/<pathId>/<moduleId>.json -> /learn/<pathId>
  // The learning path is what has a page. A module is listed on its path's
  // page; registration.mjs is what puts it there, and a module no path lists
  // has no URL at all.
  const module_ = /^modules\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (module_) return { path: `/learn/${module_[1]}` };

  // resources/<pack>/<resourceId>.json -> /guide/resources/<resourceId>
  // The LEAF, not the pack. See the 404 above.
  const resource = /^resources\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (resource) return { path: `/guide/resources/${resource[2]}` };

  // diagrams/<id>.mmd -> /guide/diagrams/<id>
  const diagram = /^diagrams\/([^/]+)\.mmd$/.exec(path);
  if (diagram) return { path: `/guide/diagrams/${diagram[1]}` };

  // A registry file is published alongside an artifact and is not itself a
  // page. Saying so is not the same as saying it serves.
  if (/^(?:catalog\.json|diagrams\/catalogue\.json)$/.test(path)) {
    return { error: `${path} is a registry, not a page, so it has no public URL of its own` };
  }

  return {
    error: `no public route is known for ${path}. Routes are derived from the target path: ` +
      "modules/<pathId>/<moduleId>.json, resources/<pack>/<resourceId>.json, or diagrams/<id>.mmd",
  };
}

// THE ARTIFACT'S OWN PAGE, which is not always the page that PROVES it.
//
// publicPathForTarget above answers "where would a reader see this listed",
// and for a module that is deliberately the learning path's page: a module the
// catalogue does not list is unreachable however well its own route serves, so
// the listing is what proves publication took.
//
// This answers the other question, which only a removal asks: "which URL stops
// resolving when this file is gone". They differ for exactly one surface.
// Verified live 2026-09-06 against https://project-42.dev:
//
//   GET /learn/ai-foundations/what-ai-does           -> 200
//   GET /learn/ai-foundations/definitely-not-a-module -> 404
//
// So a module DOES have a page of its own, and removing one orphans it. The
// removal record said otherwise ("a learning module has no page of its own")
// until that was measured; redirectFor in lib/removal.mjs now derives its
// answer from here so the record and the check can never disagree.
export function ownPageForTarget(targetPath) {
  const path = String(targetPath ?? "").trim();
  if (!path) return { error: "the publication transaction records no target path, so no public URL can be derived" };

  // modules/<pathId>/<moduleId>.json -> /learn/<pathId>/<moduleId>
  const module_ = /^modules\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (module_) return { path: `/learn/${module_[1]}/${module_[2]}`, listing: `/learn/${module_[1]}` };

  // Every other surface's own page IS its listed page.
  return publicPathForTarget(path);
}

// The origin to verify against. A single top-level publicBaseUrl covers the
// whole estate now that it is one portal; a surface may still override it,
// because a surface moving origin without the others is the case the target
// configuration was written to allow.
//
// The lookup deliberately does NOT key off item.surface. `workflow_item.surface`
// carries the contract vocabulary (learning, guide, guide-diagram) while
// config/surface-targets.json is keyed by the probe vocabulary (learn,
// field-guide, visual-guide), so `surfaces[item.surface]` missed on every
// guide and guide-diagram item and reported "has no publicBaseUrl" before it
// ever reached the template. Two vocabularies for one fact, with nothing
// checking that they match, is the same defect shape as the one above.
export const CONFIG_KEY_BY_TARGET_PREFIX = Object.freeze({
  "modules/": ["learn", "learning"],
  "resources/": ["field-guide", "guide"],
  "diagrams/": ["visual-guide", "guide-diagram"],
});

export function baseUrlForTarget(config, targetPath) {
  const path = String(targetPath ?? "");
  const surfaces = config?.surfaces ?? {};
  for (const [prefix, keys] of Object.entries(CONFIG_KEY_BY_TARGET_PREFIX)) {
    if (!path.startsWith(prefix)) continue;
    for (const key of keys) {
      const base = surfaces[key]?.publicBaseUrl;
      if (base) return base;
    }
  }
  return config?.publicBaseUrl ?? null;
}

export function expectedUrl(item, config) {
  const base = typeof config === "string" ? config : baseUrlForTarget(config, item?.path);
  if (!base) {
    return { error: `no publicBaseUrl is configured for ${item?.path ?? "an item with no target path"}, so serving cannot be verified` };
  }
  const route = publicPathForTarget(item?.path);
  if (route.error) return { error: `${route.error} (item ${item?.id ?? "with no id"})` };
  return { url: new URL(route.path, base).toString() };
}

// The marker must come from the item, not from the page, or the check proves
// only that SOMETHING responded. Title is used because it is the one field a
// rendered page is guaranteed to show.
export function markersFor(item) {
  const out = [];
  if (item.title) out.push(String(item.title).trim());
  return out.filter((m) => m.length >= 8);
}

// A rendered page escapes the characters that would otherwise be markup, so a
// title carrying `&`, `<`, `>` or a quote never appears in the body verbatim.
// Found 2026-09-06 while proving the URL fix against the live portal: the
// module "EU AI Act, NIST AI RMF & Deletion Receipts" is listed on its path
// page and serving correctly, and the check called it not serving because the
// page says `&amp;`. A false negative here is the mirror of the false positive
// this whole script exists to prevent, and it is just as much a lie.
//
// The body is decoded rather than the marker escaped, because a page may escape
// only some of them and there is no way to know which from here.
export function decodeEntities(text) {
  return String(text)
    .replace(/&(?:amp|#0*38|#[xX]0*26);/g, "&")
    .replace(/&(?:lt|#0*60|#[xX]0*3[cC]);/g, "<")
    .replace(/&(?:gt|#0*62|#[xX]0*3[eE]);/g, ">")
    .replace(/&(?:quot|#0*34|#[xX]0*22);/g, '"')
    .replace(/&(?:apos|#0*39|#[xX]0*27);/g, "'")
    .replace(/&(?:nbsp|#0*160|#[xX]0*[aA]0);/g, " ");
}

// A REMOVAL THAT WORKED IS NOT A VERIFICATION THAT FAILED.
//
// This script proves a page serves by fetching it and finding a marker from the
// item. Applied to a removal that published successfully, that reports the
// removal broken: the file is gone, the page does not serve, and the check
// calls the correct outcome a fault. It was worse than that in practice -- a
// Track 2 removal's Gate 1 manifest title is `removal: <stableId>`, which is
// not on any page anywhere, so a removal could never have passed the marker
// check no matter what was live.
//
// So a removal is verified by ABSENCE:
//
//   - its own page (ownPageForTarget, the same derivation the removal record's
//     `redirect.from` is built from -- deterministic in surface and target
//     path, so deriving it here equals reading the recorded one) must stop
//     resolving, or land on the redirect target the record named
//   - a module's removal is also a DEREGISTRATION: the learning path that
//     listed it must still serve, and must no longer link the module. A
//     deregistration that breaks catalog.json is the real risk of a module
//     removal, and a module still linked from a page whose file is gone is a
//     listing that 404s -- the exact defect the removal record calls worse than
//     the stale content it was for.
//
// The item is a removal when workflow_item.outcome is "removal", which is one
// of TRACK_2_ACTIONABLE_CLASSIFICATIONS and is the value gate-queue records as
// the item's outcome from the Gate 1 proposal category.
export function isRemoval(item) {
  return item?.outcome === "removal";
}

async function fetchPage(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    return { response };
  } catch (e) {
    return { error: `fetch failed: ${e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e?.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const GONE_STATUSES = new Set([404, 410]);

export async function verifyRemoved(item, surfaceConfig, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = { id: item.id, expectation: "absent", verified: false, reasons: [] };
  const base = typeof surfaceConfig === "string" ? surfaceConfig : baseUrlForTarget(surfaceConfig, item?.path);
  if (!base) {
    res.reasons.push(`no publicBaseUrl is configured for ${item?.path ?? "an item with no target path"}, so the removal cannot be verified`);
    return res;
  }
  const route = ownPageForTarget(item?.path);
  if (route.error) { res.reasons.push(`${route.error} (item ${item?.id ?? "with no id"})`); return res; }
  res.url = new URL(route.path, base).toString();

  const { response, error } = await fetchPage(res.url, { fetchImpl, timeoutMs });
  if (error) { res.reasons.push(error); return res; }
  res.status = response.status;

  const landed = response.url ? new URL(response.url) : null;
  const samePath = !landed || new URL(res.url).pathname.replace(/\/$/, "") === landed.pathname.replace(/\/$/, "");
  if (GONE_STATUSES.has(response.status)) {
    res.verified = true;
  } else if (!samePath) {
    // A redirect away from the removed artifact's own page is the recorded
    // redirect having been honoured. Where it landed is stated either way.
    res.verified = true;
    res.reasons.push(`redirected to ${landed.pathname}, which is where a removed ${item.surface ?? "artifact"} is expected to land`);
  } else {
    res.reasons.push(
      `HTTP ${response.status} at ${route.path}: the removal was recorded as published, but the artifact's own page is still serving. ` +
        "A removal is proven by absence, and this URL is present.",
    );
    return res;
  }

  // The deregistration half. Only a module has a separate listing page; for
  // every other surface the artifact's own page IS its listing.
  if (!route.listing) return res;
  const listingUrl = new URL(route.listing, base).toString();
  const listing = await fetchPage(listingUrl, { fetchImpl, timeoutMs });
  if (listing.error) {
    res.verified = false;
    res.reasons.push(`the learning path ${route.listing} could not be fetched, so the deregistration is unproven: ${listing.error}`);
    return res;
  }
  res.listing = { url: listingUrl, status: listing.response.status };
  if (!listing.response.ok) {
    res.verified = false;
    res.reasons.push(`the learning path ${route.listing} returned HTTP ${listing.response.status}: the removal took the page down with the module, which is a broken catalogue, not a clean removal`);
    return res;
  }
  const listingBody = decodeEntities(await listing.response.text());
  // The exact href, not a substring: /learn/x/agents-and-guardrails is a
  // prefix of /learn/x/agents-and-guardrails-advanced, and a sibling module
  // whose id starts with this one's would otherwise read as a surviving link.
  // The `href="<path>"` form was confirmed live on the path pages 2026-09-06.
  if (new RegExp(`href="${route.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/?#][^"]*)?"`).test(listingBody)) {
    res.verified = false;
    res.reasons.push(`the learning path ${route.listing} still links ${route.path}, so the catalogue entry outlived the file and that listing now 404s`);
  }
  return res;
}

export async function verifyOne(item, surfaceConfig, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (isRemoval(item)) {
    const removed = await verifyRemoved(item, surfaceConfig, { fetchImpl, timeoutMs });
    // `serving` stays false for a removal and is meaningless there: the page
    // is supposed to be gone. `verified` is the verdict every caller reads.
    return { serving: false, ...removed };
  }
  const res = { id: item.id, expectation: "present", serving: false, verified: false, reasons: [] };
  const target = expectedUrl(item, surfaceConfig);
  if (target.error) { res.reasons.push(target.error); return res; }
  res.url = target.url;

  const markers = markersFor(item);
  if (markers.length === 0) {
    res.reasons.push(`${item.id} has no usable marker, so a fetch could not prove the right page served`);
    return res;
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(target.url, { redirect: "follow", signal: controller.signal });
  } catch (e) {
    res.reasons.push(`fetch failed: ${e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e?.message}`);
    return res;
  } finally {
    clearTimeout(timer);
  }

  res.status = response.status;
  if (!response.ok) { res.reasons.push(`HTTP ${response.status}`); return res; }

  // A redirect that lands somewhere else is not the page we published.
  const landed = response.url ? new URL(response.url) : null;
  if (landed && new URL(target.url).pathname.replace(/\/$/, "") !== landed.pathname.replace(/\/$/, "")) {
    res.reasons.push(`redirected to ${landed.pathname}, which is not the published path`);
    return res;
  }

  const body = decodeEntities(await response.text());
  const missing = markers.filter((m) => !body.includes(m));
  if (missing.length > 0) {
    res.reasons.push(
      `HTTP ${response.status} but the page does not contain ${JSON.stringify(missing[0])}. ` +
        "A 200 alone is not proof: a not-found page and an empty app shell both return 200.",
    );
    return res;
  }

  res.serving = true;
  res.verified = true;
  return res;
}

// `config` is the whole config/surface-targets.json document, not a surface
// entry pulled out of it by a column value. See baseUrlForTarget for why the
// column cannot be trusted to pick the entry.
//
// `verified` is the verdict, not `serving`: a removal is verified when its page
// is GONE, so counting "serving" as the pass would report every successful
// removal as a failure. `serving` and `removed` are reported separately so the
// two kinds of proof stay legible.
export async function verifyAll(items, config, opts = {}) {
  const results = [];
  for (const item of items) {
    results.push(await verifyOne(item, config, opts));
  }
  return {
    checked: results.length,
    verified: results.filter((r) => r.verified).length,
    serving: results.filter((r) => r.verified && r.expectation !== "absent").length,
    removed: results.filter((r) => r.verified && r.expectation === "absent").length,
    failed: results.filter((r) => !r.verified),
    results,
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// SCHEMA. Published work is read from publication_transaction and
// workflow_item (schema/migrations/002), the ONLY tables the deployed database
// has. The first version read `publication` and `item` from
// schema/content-db.sql, a developer-local schema no migration ever applies,
// so live verification would have failed `no such table` on every run and
// been logged as a serving fault rather than the schema mistake it was.
//
// Exported so a test can prove the statement compiles against the migrated
// schema: a query with a wrong table name is exactly the defect class that
// shipped here once already.
export const PUBLISHED_ITEMS_SQL =
  `SELECT p.item_id AS id, p.created_at AS published_at, i.surface, i.outcome,
          p.target_repository, p.target_path AS path
     FROM publication_transaction p
     LEFT JOIN workflow_item i ON i.item_id = p.item_id
    WHERE (? IS NULL OR p.created_at >= ?)
    ORDER BY p.created_at DESC`;

// The marker for a published item is its recorded Gate 1 manifest title, the
// same detail every other reader of the lifecycle uses.
export const ITEM_TITLE_SQL =
  `SELECT record_json FROM observation_event
    WHERE item_id = ? AND evidence_reference = ?
    ORDER BY observed_at DESC LIMIT 1`;

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "verify-published-live.mjs";
if (invokedDirectly) {
  const { openStateStore } = await import("./lib/state-store.mjs");
  const { GATE_MANIFEST_REFERENCE_PREFIX } = await import("./lib/gate-queue.mjs");
  const { readFileSync } = await import("node:fs");
  const store = openStateStore(arg("db", "content.db"));
  const db = store.db;
  try {
    const config = JSON.parse(readFileSync(arg("surfaces", "config/surface-targets.json"), "utf8"));
    const since = arg("since");
    const titleFor = db.prepare(ITEM_TITLE_SQL);
    const rows = db.prepare(PUBLISHED_ITEMS_SQL).all(since, since).map((row) => {
      const observed = titleFor.get(row.id, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${row.id}`);
      const manifest = observed ? JSON.parse(observed.record_json).manifest_item ?? null : null;
      return { ...row, title: manifest?.title ?? null };
    });
    const out = await verifyAll(rows, config);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.stderr.write(`live verification: ${out.verified}/${out.checked} verified (${out.serving} serving, ${out.removed} proven removed)\n`);
    process.exitCode = out.failed.length === 0 ? 0 : 1;
  } finally {
    store.close();
  }
}
