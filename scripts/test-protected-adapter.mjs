#!/usr/bin/env node
// Found live 2026-08-19, on the very first real publication attempt this
// pipeline ever made: 9 real approved items sat at gate2-approved,
// unable to move, because loadProtectedAdapter picked the publication
// adapter module's `default` namespace export (truthy, but not an
// adapter) instead of calling its `createAdapter` factory. The job itself
// reported "Succeeded" -- this refusal is deliberately non-fatal, which is
// exactly why it went unnoticed until a human actually looked for
// published content and found none. This module had zero test coverage
// before now.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "./lib/state-store.mjs";
import { protectedAdapterDigest, loadProtectedAdapter } from "./lib/protected-adapter.mjs";
import { estate } from "./test-fixtures.mjs";

async function provisionAndWrite(store, moduleSource) {
  const directory = mkdtempSync(join(tmpdir(), "orchard-protected-adapter-"));
  const adapterPath = join(directory, "adapter.mjs");
  writeFileSync(adapterPath, moduleSource);
  const digest = await protectedAdapterDigest(adapterPath);
  store.provisionTrustAnchor({
    scope: "publication", adapter_identity: "test.publication-adapter.v1",
    adapter_digest: digest, adapter_path: adapterPath, provisioned_at: "2026-08-15T00:00:00.000Z",
  });
  return adapterPath;
}

test("a factory-only adapter module (createAdapter + a namespace default, no top-level `adapter`) is loaded correctly -- the exact shape that broke the first real publication", async () => {
  const { store } = await estate();
  await provisionAndWrite(store, [
    "export const adapterIdentity = 'test.publication-adapter.v1';",
    "class RealAdapter { async reconcileBeforeCreateBranch() { return { classification: 'created', object: { ok: true } }; } }",
    "export async function createAdapter() { return new RealAdapter(); }",
    "export default { adapterIdentity, createAdapter, RealAdapter };",
  ].join("\n"));
  const adapter = await loadProtectedAdapter(store, "publication", "reconcileBeforeCreateBranch");
  assert.equal(typeof adapter.reconcileBeforeCreateBranch, "function", "the factory must actually be called, not skipped in favor of the namespace default");
  const result = await adapter.reconcileBeforeCreateBranch();
  assert.deepEqual(result, { classification: "created", object: { ok: true } }, "the loaded adapter must be a real, working instance, not a stub that happens to have the right shape");
  store.close();
});

test("an adapter module that exports `adapter` directly still works, unchanged from before", async () => {
  const { store } = await estate();
  await provisionAndWrite(store, [
    "export const adapterIdentity = 'test.publication-adapter.v1';",
    "export const adapter = { async reconcileBeforeCreateBranch() { return 'direct'; } };",
  ].join("\n"));
  const loaded = await loadProtectedAdapter(store, "publication", "reconcileBeforeCreateBranch");
  assert.equal(await loaded.reconcileBeforeCreateBranch(), "direct");
  store.close();
});

test("a module with neither `adapter` nor `createAdapter`, only an unrelated default export, still refuses clearly", async () => {
  const { store } = await estate();
  await provisionAndWrite(store, [
    "export const adapterIdentity = 'test.publication-adapter.v1';",
    "export default { adapterIdentity };",
  ].join("\n"));
  await assert.rejects(
    () => loadProtectedAdapter(store, "publication", "reconcileBeforeCreateBranch"),
    /publication adapter module does not implement reconcileBeforeCreateBranch/,
  );
  store.close();
});
