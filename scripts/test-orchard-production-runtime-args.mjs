#!/usr/bin/env node
// test-orchard-production-runtime-args.mjs - the runtime's CLI form is what
// actually reaches production, so its parsing is worth asserting directly.
//
// --admin-retry-blocked is new: a one-off human decision (retry a blocked
// item), deliberately kept out of the --role vocabulary so it never has to
// satisfy the env contract those roles require. These tests are the only
// place that form's parsing is checked; nothing else in the deployed system
// calls parseRuntimeArgs.

import { parseRuntimeArgs } from "./orchard-production-runtime.mjs";

let assertions = 0, failures = 0;
const ok = (c, m) => { assertions++; if (!c) { failures++; console.error(`FAIL: ${m}`); } };
const throws = (fn, m) => {
  try { fn(); failures++; console.error(`FAIL: ${m} (did not throw)`); assertions++; }
  catch { assertions++; }
};

// --- the existing forms are unchanged ---
{
  const r = parseRuntimeArgs(["--track", "track-1"]);
  ok(r.track === "track-1" && !r.role && !r.adminRetryBlocked, "--track still parses to track alone");
}
{
  const r = parseRuntimeArgs(["--role", "authoring"]);
  ok(r.role === "authoring" && !r.track && !r.adminRetryBlocked, "--role still parses to role alone");
}
throws(() => parseRuntimeArgs(["--track", "track-1", "--role", "authoring"]),
  "--track and --role together still refused");

// --- the new admin form ---
{
  const r = parseRuntimeArgs(["--admin-retry-blocked", "01a00674-0000-7000-8000-000000000001"]);
  ok(r.adminRetryBlocked === "01a00674-0000-7000-8000-000000000001" && !r.track && !r.role,
    "--admin-retry-blocked parses to the item id alone");
  ok(Array.isArray(r.controller) && r.controller.length === 0, "no controller args leak through");
}
throws(() => parseRuntimeArgs(["--admin-retry-blocked"]),
  "--admin-retry-blocked with no item id is refused");
throws(() => parseRuntimeArgs(["--admin-retry-blocked", "x", "--track", "track-1"]),
  "--admin-retry-blocked cannot be combined with --track");
throws(() => parseRuntimeArgs(["--track", "track-1", "--admin-retry-blocked", "x"]),
  "--admin-retry-blocked cannot trail another flag");

console.log(
  failures === 0
    ? `PASS. ${assertions} assertions on the runtime's CLI parsing.`
    : `FAIL. ${failures} of ${assertions} assertions failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
