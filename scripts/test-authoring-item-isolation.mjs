import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeliveryItems } from './run-authoring.mjs';

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
