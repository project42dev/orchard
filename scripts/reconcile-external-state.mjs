#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AmbiguousExternalStateError, ExternalStateMismatchError, UnknownExternalOutcomeError } from './adapters/github-adapter.mjs';

export async function classifyExternalState({ provider, adapter, request }) {
    if (!['github', 'ado'].includes(provider)) throw new TypeError('provider must be github or ado');
    if (!adapter?.reconcile) throw new TypeError('an injected adapter with reconcile() is required');
    try {
        const result = await adapter.reconcile(request);
        return { provider, externalKey: request.externalKey, classification: result.classification, object: result.object };
    } catch (error) {
        if (error instanceof ExternalStateMismatchError) return { provider, externalKey: request.externalKey, classification: 'mismatch', details: error.mismatches };
        if (error instanceof AmbiguousExternalStateError) return { provider, externalKey: request.externalKey, classification: 'duplicate', count: error.count };
        if (error instanceof UnknownExternalOutcomeError || error?.unknownOutcome || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error?.code)) {
            return { provider, externalKey: request.externalKey, classification: 'unknown', error: error.message };
        }
        return { provider, externalKey: request.externalKey, classification: 'failed', error: error.message };
    }
}

export async function reconcileExternalState({ entries, githubAdapter, adoAdapter }) {
    const results = [];
    for (const entry of entries) {
        const adapter = entry.provider === 'github' ? githubAdapter : entry.provider === 'ado' ? adoAdapter : null;
        results.push(await classifyExternalState({ provider: entry.provider, adapter, request: entry.request }));
    }
    return results;
}

async function main() {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { input: { type: 'string' }, 'adapter-module': { type: 'string' } } });
    if (!values.input || !values['adapter-module']) throw new Error('usage: reconcile-external-state.mjs --input <requests.json> --adapter-module <injected-adapters.mjs>');
    const input = JSON.parse(readFileSync(resolve(values.input), 'utf8'));
    const adapters = await import(pathToFileURL(resolve(values['adapter-module'])).href);
    console.log(JSON.stringify(await reconcileExternalState({ entries: input.entries, ...adapters }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
