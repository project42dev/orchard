#!/usr/bin/env node
// Prove the seeder before it touches a real container.
//
// The failure this guards against is the one that has bitten this project
// repeatedly: a step that reports success while writing nothing, or writing
// the wrong bytes. Every assertion here is about that.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSeedManifest, seedArtifacts } from './seed-artifacts.mjs';

const digestOf = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
const log = () => {};

function stubContainer(initial = new Map()) {
  const blobs = new Map(initial);
  return {
    blobs,
    getBlockBlobClient(name) {
      return {
        exists: async () => blobs.has(name),
        downloadToBuffer: async () => blobs.get(name),
        uploadData: async (payload) => { blobs.set(name, Buffer.from(payload)); },
      };
    },
  };
}

function stage(files) {
  const root = mkdtempSync(join(tmpdir(), 'orchard-seed-test-'));
  const artifacts = [];
  for (const [name, contents] of Object.entries(files)) {
    const buffer = Buffer.from(contents);
    writeFileSync(join(root, name), buffer);
    artifacts.push({ localPath: name, blobName: `inputs/${name}`, digest: digestOf(buffer) });
  }
  writeFileSync(join(root, 'seed-manifest.json'), JSON.stringify({ schemaVersion: 1, contentCommit: 'a'.repeat(40), artifacts }));
  return { root, manifestPath: join(root, 'seed-manifest.json') };
}

test('a missing manifest stops the seed rather than seeding nothing successfully', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-seed-test-'));
  assert.throws(() => readSeedManifest(join(root, 'seed-manifest.json')), /seed manifest not found/);
  rmSync(root, { recursive: true, force: true });
});

test('an empty artifact list is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-seed-test-'));
  const path = join(root, 'seed-manifest.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, artifacts: [] }));
  assert.throws(() => readSeedManifest(path), /lists no artifacts/);
  rmSync(root, { recursive: true, force: true });
});

test('a blob name that escapes its container is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-seed-test-'));
  const path = join(root, 'seed-manifest.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    artifacts: [{ localPath: 'a.json', blobName: '../escape.json', digest: `sha256:${'0'.repeat(64)}` }],
  }));
  assert.throws(() => readSeedManifest(path), /unsafe blob name/);
  rmSync(root, { recursive: true, force: true });
});

test('a local path that escapes the staging directory is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-seed-test-'));
  const path = join(root, 'seed-manifest.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    artifacts: [{ localPath: '../../etc/passwd', blobName: 'inputs/a.json', digest: `sha256:${'0'.repeat(64)}` }],
  }));
  assert.throws(() => readSeedManifest(path), /must stay inside the seed inputs directory/);
  rmSync(root, { recursive: true, force: true });
});

test('artifacts are written and read back', async () => {
  const { root, manifestPath } = stage({ 'registry.json': '{"registryVersion":"1.0.0"}', 'corpus.bin': 'corpus bytes' });
  const container = stubContainer();
  const results = await seedArtifacts({ container, artifacts: readSeedManifest(manifestPath), log });
  assert.deepEqual(results.map((r) => r.action), ['created', 'created']);
  assert.equal(container.blobs.get('inputs/registry.json').toString(), '{"registryVersion":"1.0.0"}');
  assert.equal(container.blobs.get('inputs/corpus.bin').toString(), 'corpus bytes');
  rmSync(root, { recursive: true, force: true });
});

test('a second run changes nothing and says so', async () => {
  const { root, manifestPath } = stage({ 'registry.json': '{"a":1}' });
  const artifacts = readSeedManifest(manifestPath);
  const container = stubContainer();
  await seedArtifacts({ container, artifacts, log });
  const again = await seedArtifacts({ container, artifacts, log });
  assert.deepEqual(again.map((r) => r.action), ['unchanged']);
  rmSync(root, { recursive: true, force: true });
});

test('a blob holding different content is replaced, not left stale', async () => {
  const { root, manifestPath } = stage({ 'registry.json': '{"a":2}' });
  const container = stubContainer(new Map([['inputs/registry.json', Buffer.from('{"a":1}')]]));
  const results = await seedArtifacts({ container, artifacts: readSeedManifest(manifestPath), log });
  assert.deepEqual(results.map((r) => r.action), ['replaced']);
  assert.equal(container.blobs.get('inputs/registry.json').toString(), '{"a":2}');
  rmSync(root, { recursive: true, force: true });
});

test('a staged file that does not match its declared digest is never uploaded', async () => {
  const { root, manifestPath } = stage({ 'registry.json': '{"a":1}' });
  const artifacts = readSeedManifest(manifestPath);
  writeFileSync(join(root, 'registry.json'), '{"a":999}');
  const container = stubContainer();
  await assert.rejects(seedArtifacts({ container, artifacts, log }), /release declared/);
  assert.equal(container.blobs.size, 0, 'nothing may be written when the image contents are wrong');
  rmSync(root, { recursive: true, force: true });
});

test('a write that reads back wrong fails instead of reporting success', async () => {
  const { root, manifestPath } = stage({ 'registry.json': '{"a":1}' });
  const container = stubContainer();
  const inner = container.getBlockBlobClient.bind(container);
  container.getBlockBlobClient = (name) => {
    const client = inner(name);
    return { ...client, uploadData: async () => { container.blobs.set(name, Buffer.from('corrupted')); } };
  };
  await assert.rejects(seedArtifacts({ container, artifacts: readSeedManifest(manifestPath), log }), /read back as/);
  rmSync(root, { recursive: true, force: true });
});
