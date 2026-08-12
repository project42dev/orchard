import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Digest } from './identity.mjs';

export async function loadProtectedAdapter(store, scope, requiredMethod) {
    const trust = store.getTrustAnchor(scope);
    if (!trust?.adapter_path) throw new Error(`${scope} requires an administrator-provisioned adapter path`);
    const adapterPath = resolve(trust.adapter_path);
    if (sha256Digest(readFileSync(adapterPath, 'utf8')) !== trust.adapter_digest) {
        throw new Error(`${scope} adapter file does not match the protected digest`);
    }
    const loaded = await import(pathToFileURL(adapterPath).href);
    if (loaded.adapterIdentity !== trust.adapter_identity) {
        throw new Error(`${scope} adapter module identity does not match the protected identity`);
    }
    const adapter = loaded.adapter ?? loaded.default ?? (loaded.createAdapter ? await loaded.createAdapter() : null);
    if (!adapter || typeof adapter[requiredMethod] !== 'function') {
        throw new TypeError(`${scope} adapter module does not implement ${requiredMethod}`);
    }
    adapter.adapterIdentity = trust.adapter_identity;
    adapter.adapterDigest = trust.adapter_digest;
    return adapter;
}
