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

export function expectedUrl(item, surfaceConfig) {
  const base = surfaceConfig?.publicBaseUrl;
  if (!base) return { error: `surface ${item.surface} has no publicBaseUrl, so serving cannot be verified` };
  const template = surfaceConfig?.publicPathTemplate;
  if (!template) return { error: `surface ${item.surface} has no publicPathTemplate` };
  // A placeholder that resolves to an empty string is the dangerous case: the
  // template still "resolves", but to a parent path that may well return 200.
  // Verifying that URL would prove nothing while reporting success.
  const unresolved = [];
  const path = template.replace(/\{([a-zA-Z_]+)\}/g, (_, k) => {
    const v = item[k];
    if (v === undefined || v === null || String(v).trim() === "") { unresolved.push(k); return ""; }
    return String(v);
  });
  if (unresolved.length > 0 || path.includes("{") || /\/\//.test(path.replace(/^https?:\/\//, ""))) {
    return {
      error: `path template did not fully resolve for ${item.id ?? "an item with no id"}: missing ${unresolved.join(", ") || "value"} in ${template}`,
    };
  }
  return { url: new URL(path, base).toString() };
}

// The marker must come from the item, not from the page, or the check proves
// only that SOMETHING responded. Title is used because it is the one field a
// rendered page is guaranteed to show.
export function markersFor(item) {
  const out = [];
  if (item.title) out.push(String(item.title).trim());
  return out.filter((m) => m.length >= 8);
}

export async function verifyOne(item, surfaceConfig, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = { id: item.id, serving: false, reasons: [] };
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

  const body = await response.text();
  const missing = markers.filter((m) => !body.includes(m));
  if (missing.length > 0) {
    res.reasons.push(
      `HTTP ${response.status} but the page does not contain ${JSON.stringify(missing[0])}. ` +
        "A 200 alone is not proof: a not-found page and an empty app shell both return 200.",
    );
    return res;
  }

  res.serving = true;
  return res;
}

export async function verifyAll(items, surfaces, opts = {}) {
  const results = [];
  for (const item of items) {
    results.push(await verifyOne(item, surfaces?.[item.surface], opts));
  }
  return {
    checked: results.length,
    serving: results.filter((r) => r.serving).length,
    failed: results.filter((r) => !r.serving),
    results,
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").split("/").pop() === "verify-published-live.mjs";
if (invokedDirectly) {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(arg("db", "content.db"));
  try {
    const surfaces = JSON.parse(readFileSync(arg("surfaces", "config/surface-targets.json"), "utf8")).surfaces ?? {};
    const since = arg("since");
    const rows = db
      .prepare(
        `SELECT p.subject_id AS id, p.published_at, i.surface, i.title, i.path
           FROM publication p LEFT JOIN item i ON i.id = p.item_id
          WHERE (? IS NULL OR p.published_at >= ?)
          ORDER BY p.published_at DESC`,
      )
      .all(since, since);
    const out = await verifyAll(rows, surfaces);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.stderr.write(`live verification: ${out.serving}/${out.checked} serving\n`);
    process.exitCode = out.failed.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}
