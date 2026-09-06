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
  publicPathForTarget, ownPageForTarget, baseUrlForTarget,
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

// --- A PUBLISHED REMOVAL IS VERIFIED BY ABSENCE, NOT BY PRESENCE -------------
//
// The third defect. This script proves a page serves by finding a marker from
// the item on it. Point that at a removal that published SUCCESSFULLY and it
// reports the removal broken: the file is gone, the page does not serve, the
// check calls the correct outcome a fault.
//
// It was worse than that. A Track 2 removal's Gate 1 manifest title is
// `removal: <stableId>` (currencyCandidateFor in lib/track-2-controller.mjs),
// which appears on no page anywhere, so a removal could never have passed the
// marker check whatever was live.
//
// Routes confirmed by curl on 2026-09-06 against https://project-42.dev:
//   GET /learn/ai-foundations/what-ai-does            -> 200
//   GET /learn/ai-foundations/definitely-not-a-module -> 404
//   the path page links each module as href="/learn/<pathId>/<moduleId>"
{
  ok(ownPageForTarget("modules/ai-foundations/agents-and-guardrails.json").path
       === "/learn/ai-foundations/agents-and-guardrails",
     "a module's OWN page is /learn/<pathId>/<moduleId>, which is what stops resolving when it is removed");
  ok(ownPageForTarget("modules/ai-foundations/agents-and-guardrails.json").listing === "/learn/ai-foundations",
     "and its listing page is the learning path, which must keep serving");
  ok(ownPageForTarget("resources/coding-agents/ai-assisted-code-review-checklist.json").path
       === "/guide/resources/ai-assisted-code-review-checklist",
     "for every other surface the own page is the listed page");
}

// A removal row carries outcome 'removal', which is what gate-queue records
// from the Gate 1 proposal category and is one of the five actionable Track 2
// classifications.
const REMOVED_MODULE = {
  id: "0198f2a0-1c3a-7a51-9d2e-6f0b2c4d8e21",
  surface: "learning",
  outcome: "removal",
  target_repository: "project42dev/project42-content",
  path: "modules/ai-foundations/agents-and-guardrails.json",
  title: "removal: learning:content/modules/ai-foundations/agents-and-guardrails.json",
};
const REMOVED_RESOURCE = {
  id: "0198f2a0-1c3a-7a51-9d2e-6f0b2c4d8e22",
  surface: "guide",
  outcome: "removal",
  target_repository: "project42dev/project42-content",
  path: "resources/coding-agents/ai-assisted-code-review-checklist.json",
  title: "removal: guide:content/resources/coding-agents/ai-assisted-code-review-checklist.json",
};

// A router keyed on path, because a module removal fetches two pages.
const routed = (byPath) => async (url) => {
  const { pathname } = new URL(url);
  const hit = byPath[pathname];
  if (!hit) throw new Error(`the test fetched an unexpected path: ${pathname}`);
  const status = hit.status ?? 200;
  return { ok: status >= 200 && status < 300, status, url: hit.url ?? url, text: async () => hit.body ?? "" };
};

const PATH_PAGE_WITHOUT = '<h2 id="module-list-title">Modules</h2><a href="/learn/ai-foundations/what-ai-does">What AI does</a>';
const PATH_PAGE_STILL_LINKING = `${PATH_PAGE_WITHOUT}<a href="/learn/ai-foundations/agents-and-guardrails">Agents</a>`;

{
  const gone = await verifyOne(REMOVED_RESOURCE, CONFIG, {
    fetchImpl: routed({ "/guide/resources/ai-assisted-code-review-checklist": { status: 404, body: "not found" } }),
  });
  ok(gone.expectation === "absent", "a removal is checked for absence, not presence");
  ok(gone.verified === true, "a resource whose page is 404 is a removal that WORKED");
  ok(gone.serving === false, "and it is never reported as serving");

  const stillThere = await verifyOne(REMOVED_RESOURCE, CONFIG, {
    fetchImpl: routed({ "/guide/resources/ai-assisted-code-review-checklist": { body: "<h1>AI-assisted code review checklist</h1>" } }),
  });
  ok(stillThere.verified === false, "a removal whose page still returns 200 did NOT take effect");
  ok(stillThere.reasons.some((r) => r.includes("still serving")),
     "and the reason says the page is still serving, not that the item is missing a marker");

  const redirected = await verifyOne(REMOVED_RESOURCE, CONFIG, {
    fetchImpl: routed({
      "/guide/resources/ai-assisted-code-review-checklist": { body: "<h1>Resources</h1>", url: "https://project-42.dev/guide/resources" },
    }),
  });
  ok(redirected.verified === true, "a removal that redirects to its surface index is verified by the redirect the record asked for");
}

{
  const clean = await verifyOne(REMOVED_MODULE, CONFIG, {
    fetchImpl: routed({
      "/learn/ai-foundations/agents-and-guardrails": { status: 404, body: "not found" },
      "/learn/ai-foundations": { body: PATH_PAGE_WITHOUT },
    }),
  });
  ok(clean.verified === true, "a module whose own page is gone and whose path no longer lists it is a clean removal");
  ok(clean.listing.status === 200, "the listing page is recorded alongside the verdict");

  const stillListed = await verifyOne(REMOVED_MODULE, CONFIG, {
    fetchImpl: routed({
      "/learn/ai-foundations/agents-and-guardrails": { status: 404, body: "not found" },
      "/learn/ai-foundations": { body: PATH_PAGE_STILL_LINKING },
    }),
  });
  ok(stillListed.verified === false,
     "a file deleted while the catalogue still links it is a listing that 404s, which is the defect the removal record calls worse than the stale content");
  ok(stillListed.reasons.some((r) => r.includes("still links")), "and the reason names the surviving link");

  // A sibling whose id merely STARTS with the removed one is not a surviving
  // link. Matching on substring would read it as one and fail a clean removal.
  const siblingPrefix = await verifyOne(REMOVED_MODULE, CONFIG, {
    fetchImpl: routed({
      "/learn/ai-foundations/agents-and-guardrails": { status: 404, body: "not found" },
      "/learn/ai-foundations": { body: PATH_PAGE_WITHOUT + `<a href="/learn/ai-foundations/agents-and-guardrails-advanced">More</a>` },
    }),
  });
  ok(siblingPrefix.verified === true, "a sibling module whose id extends the removed one is not a surviving link to it");

  const listingBroken = await verifyOne(REMOVED_MODULE, CONFIG, {
    fetchImpl: routed({
      "/learn/ai-foundations/agents-and-guardrails": { status: 404, body: "not found" },
      "/learn/ai-foundations": { status: 404, body: "not found" },
    }),
  });
  ok(listingBroken.verified === false,
     "a removal that takes the whole learning path down with it is a broken catalogue, not a clean removal");

  const modulePageAlive = await verifyOne(REMOVED_MODULE, CONFIG, {
    fetchImpl: routed({ "/learn/ai-foundations/agents-and-guardrails": { body: "<h1>Agents, Tools, and Guardrails</h1>" } }),
  });
  ok(modulePageAlive.verified === false, "a module still serving its own page has not been removed");
}

// The verdict has to read correctly in the aggregate too: counting `serving`
// as the pass would report every successful removal as a failure.
{
  const out = await verifyAll([ITEM, REMOVED_RESOURCE], CONFIG, {
    fetchImpl: routed({
      "/learn/ai-foundations": { body: "<h1>Agents, Tools, and Guardrails</h1>" },
      "/guide/resources/ai-assisted-code-review-checklist": { status: 404, body: "not found" },
    }),
  });
  ok(out.checked === 2, "both items are checked");
  ok(out.verified === 2 && out.failed.length === 0,
     `a serving publication and a proven removal are both verified, got verified=${out.verified} failed=${out.failed.length}`);
  ok(out.serving === 1 && out.removed === 1, "the two kinds of proof are counted separately, never conflated");
}


console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on live verification: a push is not a publication, and a URL that never resolves proves nothing.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
