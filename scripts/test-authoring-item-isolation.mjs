import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeliveryItems } from './run-authoring.mjs';
import { assertRoleDeliverySucceeded } from './orchard-production-runtime.mjs';

test('an empty completion for one item does not prevent the next item running', async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'orchard-item-isolation-'));
    const seen = [];
    const logs = [];
    try {
        const failed = await runDeliveryItems({
            briefs: [{ itemId: 'first' }, { itemId: 'second' }],
            workRoot, runRecordDir: workRoot, proposalRoot: workRoot,
            command: ['delivery'], env: {}, budget: { perItemUsd: 0.75, capUsd: 1.50 },
            log: (level, event, detail) => logs.push({ level, event, detail }),
            spawn: async (_exe, _args, options) => {
                const brief = JSON.parse(readFileSync(options.env.BRIEF_PATH, 'utf8'));
                assert.equal(brief.length, 1);
                assert.equal(options.env.MAX_SPEND_USD_PER_RUN, '0.75');
                seen.push(brief[0].itemId);
                return { status: seen.length === 1 ? 1 : 0, error: null };
            },
        });
        assert.equal(failed, true);
        assert.deepEqual(seen, ['first', 'second']);
        assert.deepEqual(logs.filter((entry) => entry.event === 'authoring.delivery.failed').map((entry) => entry.detail.item), ['first']);
        assert.deepEqual(logs.filter((entry) => entry.event === 'authoring.delivery.completed').map((entry) => entry.detail.item), ['second']);
    } finally {
        rmSync(workRoot, { recursive: true, force: true });
    }
});

test('a selected single item keeps the approved run cap', async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'orchard-item-cap-'));
    try {
        const failed = await runDeliveryItems({
            briefs: [{ itemId: 'selected' }], workRoot,
            runRecordDir: workRoot, proposalRoot: workRoot, command: ['delivery'], env: {},
            budget: { perItemUsd: 0.75, capUsd: 34 }, log: () => {},
            spawn: async (_exe, _args, options) => {
                assert.equal(options.env.MAX_SPEND_USD_PER_RUN, '34');
                return { status: 0, error: null };
            },
        });
        assert.equal(failed, false);
    } finally {
        rmSync(workRoot, { recursive: true, force: true });
    }
});

test('production brief subjectId is logged for each isolated delivery', async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'orchard-item-log-'));
    const logs = [];
    try {
        await runDeliveryItems({
            briefs: [{ subjectId: 'real-item-id' }], workRoot,
            runRecordDir: workRoot, proposalRoot: workRoot, command: ['delivery'], env: {},
            budget: { perItemUsd: 0.75, capUsd: 34 },
            log: (level, event, detail) => logs.push({ level, event, detail }),
            spawn: async () => ({ status: 1, error: null }),
        });
        assert.deepEqual(logs.filter((entry) => entry.event === 'authoring.delivery.failed').map((entry) => entry.detail.item), ['real-item-id']);
    } finally {
        rmSync(workRoot, { recursive: true, force: true });
    }
});

test('authoring delivery failure makes the runtime fail after committing state', () => {
    assert.throws(
        () => assertRoleDeliverySucceeded('authoring', { briefs: 1, applied: 0, deliveryFailed: true }),
        (error) => error.code === 'ERR_ORCHARD_DELIVERY_FAILED',
    );
    assert.throws(
        () => assertRoleDeliverySucceeded('authoring', { briefs: 1, applied: 0, deliveryFailed: false }),
        (error) => error.code === 'ERR_ORCHARD_DELIVERY_FAILED',
    );
    assert.doesNotThrow(() => assertRoleDeliverySucceeded('authoring', { briefs: 1, applied: 1, deliveryFailed: false }));
});
