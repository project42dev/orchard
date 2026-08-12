#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { acknowledgePublication } from './lib/publication.mjs';
import { loadProtectedAdapter } from './lib/protected-adapter.mjs';
import { openStateStore } from './lib/state-store.mjs';

export async function recordPublicationAcknowledgement({ dbPath, idempotencyKey, now }) {
    const store = openStateStore(resolve(dbPath));
    try {
        const adapter = await loadProtectedAdapter(store, 'publication', 'reconcileProtectedMain');
        return await acknowledgePublication({ idempotencyKey, adapter, store, now });
    } finally {
        store.close();
    }
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            db: { type: 'string' }, key: { type: 'string' }, apply: { type: 'boolean', default: false },
        },
    });
    if (!values.apply || !values.db || !values.key) {
        throw new Error('usage: record-publication.mjs --apply --db <content.db> --key <publication-idempotency-key>');
    }
    const result = await recordPublicationAcknowledgement({ dbPath: values.db, idempotencyKey: values.key });
    console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; });
}
