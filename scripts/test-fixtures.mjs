// Shared test fixtures for the workflow scripts.
//
// EVERY fixture here is built through openStateStore on the real migrated
// schema, and every state is reached by walking the lifecycle's own legal
// transitions. No test may create a table itself: a test that builds its own
// convenient tables is exactly how eight scripts shipped against a schema
// production does not have, and passed.
//
// This file is imported by tests; it is not itself a test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7, sha256Digest } from './lib/identity.mjs';
import { persistDiscoveryItems } from './lib/gate-queue.mjs';

const DIGEST = `sha256:${'0'.repeat(64)}`;
const SHA = '0'.repeat(40);

export const NOW = '2026-08-15T00:00:00.000Z';

export function runManifest(runId, track = 'track-1') {
    const record = {
        schema_version: '1.0.0', run_id: runId, track,
        trigger: { type: 'manual', reference: 'test' }, status: 'running',
        configuration_digest: DIGEST, source_registry_digest: DIGEST,
        content_commit: SHA, implementation_commit: SHA, model_role_map_digest: DIGEST,
        started_at: NOW, completed_at: null,
        actor: { kind: 'operator', reference: 'test' },
        scope: { mode: 'full', expected_count: 1 },
        coverage: {
            approved_enabled_source_count: 1, attempted: 1, successfully_evaluated: 1,
            redirected: 0, rate_limited: 0, failed: 0, skipped: 0, blocked: 0,
            unevaluated: 0, stale: 0, exception_count: 0,
        },
        item_count: 0,
    };
    record.manifest_digest = sha256Digest(record);
    return record;
}

export function candidate(term, overrides = {}) {
    const subject = `Teaching ${term}`;
    return {
        subject, surface: 'learning', outcome: `teach ${subject}`, scope: 'content',
        title: `How to teach ${term}`, term, level: 'intermediate',
        demandOccurrences: 12, demandSourceCount: 3,
        evidence: ['a:4', 'b:4', 'c:4'],
        evidenceRefs: [{ reference: `https://example.invalid/${term}`, digest: sha256Digest(term) }],
        observedAt: NOW, sourceLabels: ['Example Publisher'],
        semanticIdentity: `sid:v1:${sha256Digest(term).slice(7)}`,
        ...overrides,
    };
}

const temporaries = [];

/** A migrated store with one recorded run. */
export async function estate(track = 'track-1') {
    const directory = mkdtempSync(join(tmpdir(), 'orchard-fixture-'));
    temporaries.push(directory);
    const dbPath = join(directory, 'state.db');
    const store = openStateStore(dbPath);
    const runId = generateUuidV7();
    await store.recordRun(runManifest(runId, track));
    return { store, runId, dbPath, directory };
}

/**
 * Persist candidates as items held at gate1-pending, with their manifest
 * observations, exactly as the discovery controller does. Returns the
 * workflow_item ids in insertion order.
 */
export async function seedGateItems(store, runId, terms) {
    const result = await persistDiscoveryItems({
        store, runId, candidates: terms.map((t) => candidate(t)), now: NOW,
    });
    if (result.persisted !== terms.length) {
        throw new Error(`fixture expected ${terms.length} persisted items, got ${result.persisted}`);
    }
    return result.items.map((item) => item.item_id);
}

const CHAIN = [
    ['gate1-pending', 'gate1-approved', 'decision-approved'],
    ['gate1-approved', 'ado-linked', 'ado-reconciled'],
    ['ado-linked', 'executing', 'execution-started'],
    ['executing', 'gate2-ready', 'artifact-ready'],
    ['gate2-ready', 'gate2-pending', 'proposal-ready'],
    ['gate2-pending', 'gate2-approved', 'decision-approved'],
    ['gate2-approved', 'publication-preparing', 'publication-started'],
    ['publication-preparing', 'publication-validating', 'validation-passed'],
    ['publication-validating', 'publication-pr-open', 'pr-reconciled'],
    ['publication-pr-open', 'publication-merging', 'merge-started'],
    ['publication-merging', 'published', 'publication-acknowledged'],
];

/**
 * Walk an item from gate1-pending to the target state through the lifecycle's
 * own legal transitions, one recorded event per step.
 */
export async function walkTo(store, runId, itemId, targetState, { now = NOW, actor = 'test-fixture' } = {}) {
    const current = store.db.prepare('SELECT current_state, current_revision FROM workflow_item WHERE item_id = ?').get(itemId);
    if (!current) throw new Error(`no workflow item ${itemId}`);
    let walking = current.current_state === targetState;
    if (walking) return;
    let started = false;
    for (const [from, to, cause] of CHAIN) {
        if (!started && from !== current.current_state) continue;
        started = true;
        if (to === 'ado-linked') {
            // The lifecycle now proves the tracker item exists before it will
            // say so: ado-linked requires a persisted ADO external link, so
            // the fixture records one exactly as ado-sync.mjs does in
            // production. Through the store's own API, never raw SQL.
            const revision = Number(current.current_revision);
            const linked = store.db.prepare(
                "SELECT 1 FROM external_link WHERE provider = 'ado' AND item_id = ? AND item_revision = ?",
            ).get(itemId, revision);
            if (!linked) {
                const track = store.db.prepare('SELECT track FROM workflow_item WHERE item_id = ?').get(itemId).track;
                store.recordExternalLink({
                    link_id: generateUuidV7(),
                    run_id: runId,
                    item_id: itemId,
                    item_revision: revision,
                    provider: 'ado',
                    operation: 'ado-link',
                    external_key: `orchard:${track}:${itemId}:r${revision}`,
                    external_id: '424242',
                    linked_at: now,
                });
            }
        }
        await store.recordTransition({
            schema_version: '1.0.0',
            transition_id: generateUuidV7(),
            run_id: runId,
            item_id: itemId,
            item_revision: Number(current.current_revision),
            from_state: from,
            to_state: to,
            cause,
            actor,
            occurred_at: now,
            correlation_id: generateUuidV7(),
        });
        if (to === targetState) { walking = true; break; }
    }
    if (!walking) throw new Error(`no lifecycle path from ${current.current_state} to ${targetState}`);
}

export function cleanupFixtures() {
    for (const directory of temporaries) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    }
    temporaries.length = 0;
}
