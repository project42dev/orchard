#!/usr/bin/env node
// test-verify-published-live.mjs - a push is not a publication.
//
// The defect: the pipeline equated a commit landing with content serving. These
// tests exist to prove the check cannot be fooled by the two things that fool
// naive verifiers: a 200 from a not-found page, and a redirect to somewhere
// else. If this check ever passes on those, it is worse than no check.
//
// The SECOND defect, found 2026-09-06: the check could not compose a URL for a
// single real item, so none of the above ever ran. `expectedUrl` substituted
// `{topic}` out of the row, and `PUBLISHED_ITEMS_SQL` projects no `topic` --
// it projects `id` (a UUID), `published_at`, `surface`, `target_repository` and
// `path`. Every item therefore came back "did not fully resolve", every item
// counted as failed, and nothing was ever fetched. The check returned a
// confident answer about nothing.
//
// So the resolution tests below are not decoration. They are the ones that
// would have caught it, and they assert against REAL published paths and REAL
// routes on the portal, confirmed by curl on 2026-09-06.

import {
  verifyOne, verifyAll, expectedUrl, markersFor,
  publicPathForTarget, baseUrlForTarget,
} from "./verify-published-live.mjs";

let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };

// The shape of the real configuration file, post 2026-09-06.
const CONFIG = {
  publicBaseUrl: "https://project-42.dev",
  surfaces: { learn: {}, "field-guide": {}, "visual-guide": {}, learning: {} },
};

// A real row, in the shape PUBLISHED_ITEMS_SQL actually returns: a UUID id, a
// contract-vocabulary surface, and the target path the artifact was published
// to. Note there is no `topic` on it, and never was.
const ITEM = {
  id: "0198f2a0-1c3a-7a51-9d2e-6f0b2c4d8e11",
  surface: "learning",
  target_repository: "project42dev/project42-content",
  path: "modules/ai-foundations/agents-and-guardrails.json",
  title: "Agents, Tools, and Guardrails",
};

const reply = (body, { status = 200, url = "https://project-42.dev/learn/ai-foundations" } = {}) =>
  async () => ({ ok: status >= 200 && status < 300, status, url, text: async () => body });

// --- THE regression: a real row resolves to a real URL ---
{
  const r = expectedUrl(ITEM, CONFIG);
  ok(r.error === undefined, "a real published row resolves, it does not error");
  ok(r.url === "https://project-42.dev/learn/ai-foundations",
     `a learning module resolves to its PATH page, got ${r.url}`);
}

// --- route derivation, per surface, against real published paths ---
{
  ok(publicPathForTarget("modules/ai-foundations/agents-and-guardrails.json").path === "/learn/ai-foundations",
     "modules/<pathId>/<moduleId>.json -> /learn/<pathId>");
  ok(publicPathForTarget("modules/agentic-systems-and-mcp/mcp-servers.json").path === "/learn/agentic-systems-and-mcp",
     "the learning PATH is the route, not the module id");

  // 2b. The pack directory is not a route. /guide/resources/coding-agents was
  // 404 on 2026-09-06; the leaf was 200. pathTemplates names the pack because
  // that is where the FILE goes, which is a different question.
  ok(publicPathForTarget("resources/coding-agents/ai-assisted-code-review-checklist.json").path
       === "/guide/resources/ai-assisted-code-review-checklist",
     "resources/<pack>/<resourceId>.json -> the LEAF, /guide/resources/<resourceId>");
  ok(!publicPathForTarget("resources/coding-agents/ai-assisted-code-review-checklist.json").path
       .endsWith("/coding-agents"),
     "the pack directory is NEVER the route: it 404s");

  ok(publicPathForTarget("diagrams/agent-orchestration.mmd").path === "/guide/diagrams/agent-orchestration",
     "diagrams/<id>.mmd -> /guide/diagrams/<id>");
}

// --- a path with no known route errors loudly, it never guesses ---
{
  ok(publicPathForTarget("").error?.includes("no target path"), "an empty target path is an error");
  ok(publicPathForTarget("modules/orphan.json").error?.includes("no public route"),
     "a module not inside a learning-path directory has no route");
  ok(publicPathForTarget("content/modules/x/y.json").error?.includes("no public route"),
     "a stale content/ prefix has no route: the content repository has no such tree");
  ok(publicPathForTarget("catalog.json").error?.includes("registry, not a page"),
     "a registry is not a page, and says so rather than resolving to the site root");
  ok(publicPathForTarget("diagrams/catalogue.json").error?.includes("registry, not a page"),
     "the diagram catalogue is a registry too");
  ok(publicPathForTarget("README.md").error?.includes("no public route"), "an unknown shape refuses");
}

// --- the base URL is found without trusting workflow_item.surface ---
{
  // The column says `guide`; the config is keyed `field-guide`. Indexing the
  // config by the column missed on every guide item and reported "no
  // publicBaseUrl" before the route was ever considered.
  const perSurface = {
    surfaces: {
      learn: { publicBaseUrl: "https://learn.example.test" },
      "field-guide": { publicBaseUrl: "https://guide.example.test" },
    },
  };
  ok(baseUrlForTarget(perSurface, "modules/p/m.json") === "https://learn.example.test",
     "a surface override is honoured for modules");
  ok(baseUrlForTarget(perSurface, "resources/p/r.json") === "https://guide.example.test",
     "a guide item finds its base URL even though the row says `guide` and the key says `field-guide`");
  ok(baseUrlForTarget(CONFIG, "diagrams/d.mmd") === "https://project-42.dev",
     "the top-level base URL covers a surface with no override");
  ok(baseUrlForTarget({}, "modules/p/m.json") === null, "no configuration at all yields no base URL");

  const guideItem = { ...ITEM, surface: "guide", path: "resources/coding-agents/test-debug-handoff.json" };
  ok(expectedUrl(guideItem, CONFIG).url === "https://project-42.dev/guide/resources/test-debug-handoff",
     "a guide item resolves end to end despite the vocabulary mismatch");
}

// --- the happy path ---
{
  const r = await verifyOne(ITEM, CONFIG, { fetchImpl: reply("<h1>Agents, Tools, and Guardrails</h1>") });
  ok(r.serving === true, "a page containing the item title counts as serving");
  ok(r.url === "https://project-42.dev/learn/ai-foundations", "the expected URL is built from the target path");
}

// --- THE important negative: 200 is not proof ---
{
  const r = await verifyOne(ITEM, CONFIG, { fetchImpl: reply("<h1>404 - Not found</h1>") });
  ok(r.serving === false, "a 200 from a not-found page is NOT serving");
  ok(r.reasons[0].includes("does not contain"), "the failure names the missing marker");

  const shell = await verifyOne(ITEM, CONFIG, { fetchImpl: reply('<div id="root"></div>') });
  ok(shell.serving === false, "an empty single-page-app shell returning 200 is NOT serving");
}

// --- a redirect elsewhere is a failure, not a pass ---
{
  const r = await verifyOne(ITEM, CONFIG, {
    fetchImpl: reply("<h1>Agents, Tools, and Guardrails</h1>", { url: "https://project-42.dev/" }),
  });
  ok(r.serving === false, "a redirect to the home page is not the published path");
  ok(r.reasons[0].includes("redirected"), "the failure says it redirected");

  // The live site appends a trailing slash. That is the same path, and treating
  // it as a redirect elsewhere would fail every real item.
  const slashed = await verifyOne(ITEM, CONFIG, {
    fetchImpl: reply("<h1>Agents, Tools, and Guardrails</h1>", { url: "https://project-42.dev/learn/ai-foundations/" }),
  });
  ok(slashed.serving === true, "a trailing slash is the same path, not a redirect away from it");
}

// --- an escaped title is still the title ---
{
  // Found live 2026-09-06: "EU AI Act, NIST AI RMF & Deletion Receipts" is listed
  // on its path page and serving, and the check called it not serving because the
  // rendered page says . A false negative is as much a lie as a false positive.
  const amp = { ...ITEM, title: "EU AI Act, NIST AI RMF & Deletion Receipts" };
  const r = await verifyOne(amp, CONFIG, { fetchImpl: reply("<h2>EU AI Act, NIST AI RMF &amp; Deletion Receipts</h2>") });
  ok(r.serving === true, "an HTML-escaped ampersand in the rendered title still counts as serving");

  const lt = { ...ITEM, title: "Prompting <system> messages in practice" };
  const r2 = await verifyOne(lt, CONFIG, { fetchImpl: reply("<p>Prompting &lt;system&gt; messages in practice</p>") });
  ok(r2.serving === true, "escaped angle brackets too");

  const wrong = await verifyOne(amp, CONFIG, { fetchImpl: reply("<h2>Something else entirely here</h2>") });
  ok(wrong.serving === false, "decoding does not make an unrelated page pass");
}

// --- transport failures are reported, never treated as success ---
{
  const r = await verifyOne(ITEM, CONFIG, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  ok(r.serving === false && r.reasons[0].includes("ECONNREFUSED"), "a connection failure is a failure");

  const notFound = await verifyOne(ITEM, CONFIG, { fetchImpl: reply("nope", { status: 404 }) });
  ok(notFound.serving === false && notFound.reasons[0] === "HTTP 404", "a 404 is a failure");

  const slow = await verifyOne(ITEM, CONFIG, {
    fetchImpl: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; rej(e);
    })),
    timeoutMs: 20,
  });
  ok(slow.serving === false && slow.reasons[0].includes("timed out"), "a hang times out and fails");
}

// --- unverifiable configuration fails loudly rather than passing silently ---
{
  ok(expectedUrl(ITEM, {}).error?.includes("publicBaseUrl"), "no configured base URL cannot be verified");
  ok(expectedUrl({ ...ITEM, path: "nowhere.txt" }, CONFIG).error?.includes("no public route"),
     "an unroutable target path is an error, not a URL");

  const r = await verifyOne({ ...ITEM, title: "tiny" }, CONFIG, { fetchImpl: reply("tiny") });
  ok(r.serving === false && r.reasons[0].includes("no usable marker"),
     "a title too short to be a reliable marker fails rather than producing a weak pass");

  const noTitle = await verifyOne({ ...ITEM, title: null }, CONFIG, { fetchImpl: reply("anything") });
  ok(noTitle.serving === false, "an item with no recorded title cannot be proven serving");
}

// --- the aggregate reports failures rather than averaging them away ---
{
  const other = { ...ITEM, id: "0198f2a0-1c3a-7a51-9d2e-6f0b2c4d8e12", title: "Another module entirely" };
  const out = await verifyAll([ITEM, other], CONFIG, {
    fetchImpl: reply("<h1>Agents, Tools, and Guardrails</h1>"),
  });
  ok(out.checked === 2, "both items are checked");
  ok(out.serving === 1 && out.failed.length === 1, "a partial result reports the failure, it does not round up");
  ok(markersFor({ title: "Agents, Tools, and Guardrails" }).length === 1, "the title is used as the marker");

  // The pre-2026-09-06 behaviour, asserted as the thing that must not return:
  // every item failing with a resolution error and no URL fetched at all.
  let fetched = 0;
  const counted = await verifyAll([ITEM, other], CONFIG, {
    fetchImpl: async (u) => { fetched++; return { ok: true, status: 200, url: u, text: async () => "<h1>Agents, Tools, and Guardrails</h1>" }; },
  });
  ok(fetched === 2, "every item is actually FETCHED; the old code fetched none of them");
  ok(counted.results.every((r) => typeof r.url === "string"), "every result carries the URL it checked");
}

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on live verification: a push is not a publication, and a URL that never resolves proves nothing.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
