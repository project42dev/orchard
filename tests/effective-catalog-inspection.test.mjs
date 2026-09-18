import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectivePathContext } from '../scripts/lib/effective-catalog-context.mjs';
import { createFoundryInspectionProducer, estimateFoundryInspectionCost } from '../scripts/lib/foundry-inspection-producer.mjs';
import { sha256Digest } from '../scripts/lib/identity.mjs';

test('learning path inspection resolves standalone modules exactly as the product loader does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orchard-effective-catalog-'));
    try {
        mkdirSync(join(root, 'content/modules/foundations'), { recursive: true });
        const source = JSON.stringify({ paths: [{ id: 'p', moduleIds: ['inline', 'standalone'] }], modules: [{ id: 'inline' }] });
        writeFileSync(join(root, 'content/catalog.json'), source);
        writeFileSync(join(root, 'content/modules/foundations/standalone.json'), JSON.stringify({ id: 'standalone' }));
        const item = { stableId: 'learning-path:p', sourcePath: 'content/catalog.json', digest: sha256Digest('path'), sourceDigest: sha256Digest(Buffer.from(source)) };
        const context = effectivePathContext(item, root, source);
        assert.equal(context.effective_module_count, 2);
        assert.deepEqual(context.unresolved_module_ids, []);
        assert.deepEqual(context.module_references, [
            { id: 'inline', source: 'content/catalog.json' },
            { id: 'standalone', source: 'content/modules/foundations/standalone.json' },
        ]);
        let request;
        const client = { responses: { create: async (value) => {
            request = value;
            return { status: 'completed', usage: { input_tokens: 10, output_tokens: 10 }, output_text: JSON.stringify({ classification: 'evidence-backed-no-change', evidence: ['references resolve'] }) };
        } } };
        const args = { endpoint: 'https://example.test/', deployment: 'model', policy: 'policy', client, maxSpendUsd: 1 };
        await createFoundryInspectionProducer(args)(item, root);
        assert.match(request.instructions, /never call it missing/);
        assert.deepEqual(JSON.parse(request.input).effective_catalogue_path, context);
        const estimate = estimateFoundryInspectionCost({ items: [item], platformRoot: root, policy: 'policy', maxOutputTokens: 1200, maxRequests: 1, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
        assert.ok(estimate.inputTokenUpperBound >= Buffer.byteLength(request.instructions) + Buffer.byteLength(request.input));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('genuinely absent module references remain visible', () => {
    const root = mkdtempSync(join(tmpdir(), 'orchard-effective-catalog-'));
    try {
        const source = JSON.stringify({ paths: [{ id: 'p', moduleIds: ['missing'] }], modules: [] });
        const context = effectivePathContext({ stableId: 'learning-path:p', sourcePath: 'content/catalog.json' }, root, source);
        assert.deepEqual(context.unresolved_module_ids, ['missing']);
        assert.equal(context.module_references[0].source, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
