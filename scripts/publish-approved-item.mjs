#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { publishApprovedItem } from './lib/publication.mjs';
import { loadProtectedAdapter } from './lib/protected-adapter.mjs';
import { openStateStore } from './lib/state-store.mjs';

export async function runPublicationCli(argv = process.argv.slice(2)) {
    const { values } = parseArgs({
        args: argv, options: {
            input: { type: 'string' }, db: { type: 'string' },
            apply: { type: 'boolean', default: false }, merge: { type: 'boolean', default: false },
        }
    });
    if (!values.input || !values.db) throw new Error('usage: publish-approved-item.mjs --input <gate2-reference.json> --db <content.db> [--apply] [--merge]');
    if (values.merge && !values.apply) throw new Error('--merge is valid only with --apply');
    const input = JSON.parse(await readFile(resolve(values.input), 'utf8'));
    const store = openStateStore(resolve(values.db));
    try {
        if (!values.apply) return publishApprovedItem({ authorityReference: input.authority_reference ?? input, preparedCommit: input.prepared_commit, store, apply: false, merge: false });
        const adapter = await loadProtectedAdapter(store, 'publication', 'reconcileBeforeCreateBranch');
        return await publishApprovedItem({
            authorityReference: input.authority_reference ?? input, preparedCommit: input.prepared_commit,
            transactionId: input.transaction_id, adapter, store, apply: true, merge: values.merge
        });
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runPublicationCli().then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; });
}
