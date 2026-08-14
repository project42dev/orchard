#!/usr/bin/env node
// test-verify-published-live.mjs - a push is not a publication.
//
// The defect: the pipeline equated a commit landing with content serving. These
// tests exist to prove the check cannot be fooled by the two things that fool
// naive verifiers: a 200 from a not-found page, and a redirect to somewhere
// else. If this check ever passes on those, it is worse than no check.

import { verifyOne, verifyAll, expectedUrl, markersFor } from "./verify-published-live.mjs";

let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };

const SURFACE = {
  publicBaseUrl: "https://learn.project-42.dev",
  publicPathTemplate: "/modules/{id}",
};
const ITEM = { id: "cost-and-capacity", surface: "learn", title: "Cost and capacity management" };

const reply = (body, { status = 200, url = "https://learn.project-42.dev/modules/cost-and-capacity" } = {}) =>
  async () => ({ ok: status >= 200 && status < 300, status, url, text: async () => body });

// --- the happy path ---
{
  const r = await verifyOne(ITEM, SURFACE, { fetchImpl: reply("<h1>Cost and capacity management</h1>") });
  ok(r.serving === true, "a page containing the item title counts as serving");
  ok(r.url === "https://learn.project-42.dev/modules/cost-and-capacity", "the expected URL is built from the template");
}

// --- THE important negative: 200 is not proof ---
{
  const r = await verifyOne(ITEM, SURFACE, { fetchImpl: reply("<h1>404 - Not found</h1>") });
  ok(r.serving === false, "a 200 from a not-found page is NOT serving");
  ok(r.reasons[0].includes("does not contain"), "the failure names the missing marker");

  const shell = await verifyOne(ITEM, SURFACE, { fetchImpl: reply('<div id="root"></div>') });
  ok(shell.serving === false, "an empty single-page-app shell returning 200 is NOT serving");
}

// --- a redirect elsewhere is a failure, not a pass ---
{
  const r = await verifyOne(ITEM, SURFACE, {
    fetchImpl: reply("<h1>Cost and capacity management</h1>", { url: "https://learn.project-42.dev/" }),
  });
  ok(r.serving === false, "a redirect to the home page is not the published path");
  ok(r.reasons[0].includes("redirected"), "the failure says it redirected");
}

// --- transport failures are reported, never treated as success ---
{
  const r = await verifyOne(ITEM, SURFACE, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  ok(r.serving === false && r.reasons[0].includes("ECONNREFUSED"), "a connection failure is a failure");

  const notFound = await verifyOne(ITEM, SURFACE, { fetchImpl: reply("nope", { status: 404 }) });
  ok(notFound.serving === false && notFound.reasons[0] === "HTTP 404", "a 404 is a failure");

  const slow = await verifyOne(ITEM, SURFACE, {
    fetchImpl: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; rej(e);
    })),
    timeoutMs: 20,
  });
  ok(slow.serving === false && slow.reasons[0].includes("timed out"), "a hang times out and fails");
}

// --- unverifiable configuration fails loudly rather than passing silently ---
{
  ok(expectedUrl(ITEM, {}).error?.includes("publicBaseUrl"), "a surface with no base URL cannot be verified");
  ok(expectedUrl(ITEM, { publicBaseUrl: "https://x" }).error?.includes("publicPathTemplate"),
     "a surface with no path template cannot be verified");
  ok(expectedUrl({ surface: "learn" }, SURFACE).error?.includes("did not fully resolve"),
     "an unresolved template placeholder is an error, not a URL");

  const r = await verifyOne({ id: "x", surface: "learn", title: "tiny" }, SURFACE, { fetchImpl: reply("tiny") });
  ok(r.serving === false && r.reasons[0].includes("no usable marker"),
     "a title too short to be a reliable marker fails rather than producing a weak pass");
}

// --- the aggregate reports failures rather than averaging them away ---
{
  const out = await verifyAll([ITEM, { ...ITEM, id: "other", title: "Another module entirely" }], { learn: SURFACE }, {
    fetchImpl: reply("<h1>Cost and capacity management</h1>"),
  });
  ok(out.checked === 2, "both items are checked");
  ok(out.serving === 1 && out.failed.length === 1, "a partial result reports the failure, it does not round up");
  ok(markersFor({ title: "Cost and capacity management" }).length === 1, "the title is used as the marker");
}

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on live verification: a push is not a publication.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
