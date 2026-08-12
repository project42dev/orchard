#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256Digest } from './lib/identity.mjs';
import { openStateStore } from './lib/state-store.mjs';

export async function provisionTrustAnchor({ dbPath, inputPath }) {
    const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
    if (!['gate', 'publication', 'closure'].includes(input.scope)) throw new TypeError('scope must be gate, publication, or closure');
    if (!input.adapter_path) throw new TypeError('adapter_path is required');
    const adapterPath = resolve(input.adapter_path);
    const adapterText = readFileSync(adapterPath, 'utf8');
    const loaded = await import(pathToFileURL(adapterPath).href);
    if (typeof loaded.adapterIdentity !== 'string' || !loaded.adapterIdentity) {
        throw new TypeError('protected adapter module must export adapterIdentity');
    }
    let policy = null;
    let policyDigest = null;
    if (input.scope !== 'publication') {
        if (!input.policy_path) throw new TypeError(`${input.scope} requires policy_path`);
        policy = JSON.parse(readFileSync(resolve(input.policy_path), 'utf8'));
        policyDigest = sha256Digest(policy);
    }
    const store = openStateStore(resolve(dbPath));
    try {
        return store.provisionTrustAnchor({
            scope: input.scope, adapter_identity: loaded.adapterIdentity,
            adapter_digest: sha256Digest(adapterText), adapter_path: adapterPath,
            policy_digest: policyDigest, policy,
            provisioned_at: input.provisioned_at ?? new Date().toISOString()
        });
    } finally { store.close(); }
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2), options: { db: { type: 'string' }, input: { type: 'string' } }
    });
    if (!values.db || !values.input) throw new Error('usage: provision-trust-anchor.mjs --db <content.db> --input <anchor.json>');
    console.log(JSON.stringify(await provisionTrustAnchor({ dbPath: values.db, inputPath: values.input }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; });
}
