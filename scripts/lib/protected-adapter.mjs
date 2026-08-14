import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { sha256Digest } from './identity.mjs';

function manifestPath(entryDirectory, path) {
    const value = relative(entryDirectory, path).split(sep).join('/');
    return value || '.';
}

export async function protectedAdapterDigest(adapterPath) {
    const artifact = await collectProtectedAdapter(adapterPath);
    return artifact.digest;
}

async function collectProtectedAdapter(adapterPath) {
    await init;
    const entryPath = resolve(adapterPath);
    if (lstatSync(entryPath).isSymbolicLink()) throw new Error('protected adapter entry must not be a symbolic link');
    const entryDirectory = realpathSync(dirname(entryPath));
    const normalizedEntry = realpathSync(entryPath);
    if (!normalizedEntry.startsWith(`${entryDirectory}${sep}`)) throw new Error('protected adapter entry escaped its artifact root');
    const pending = [normalizedEntry];
    const visited = new Set();
    const files = [];
    while (pending.length) {
        const path = pending.pop();
        if (visited.has(path)) continue;
        visited.add(path);
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`protected adapter dependency is not a regular file: ${manifestPath(entryDirectory, path)}`);
        const actualPath = realpathSync(path);
        if (!actualPath.startsWith(`${entryDirectory}${sep}`)) throw new Error(`protected adapter dependency escaped its artifact root: ${manifestPath(entryDirectory, path)}`);
        const source = readFileSync(actualPath, 'utf8');
        const [imports] = parse(source);
        files.push({ path: manifestPath(entryDirectory, actualPath), digest: sha256Digest(source), source });
        for (const imported of imports) {
            if (!imported.n) throw new Error(`protected adapter has a non-literal dynamic import: ${manifestPath(entryDirectory, path)}`);
            if (imported.n.startsWith('node:')) continue;
            if (!imported.n.startsWith('.')) throw new Error(`protected adapter must bundle package dependency ${imported.n}`);
            const dependency = resolve(dirname(actualPath), imported.n);
            if (!dependency.startsWith(`${entryDirectory}${sep}`)) throw new Error(`protected adapter dependency escaped its artifact root: ${imported.n}`);
            pending.push(dependency);
        }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = files.map(({ path, digest }) => ({ path, digest }));
    const entryRelative = manifestPath(entryDirectory, normalizedEntry);
    return { entryDirectory, entryPath: normalizedEntry, entryRelative, files, digest: sha256Digest({ format: 'protected-esm-artifact-v2', entry: entryRelative, files: manifest }) };
}

export async function verifyProtectedAdapterArtifact(adapterPath, expectedDigest) {
    const digest = await protectedAdapterDigest(adapterPath);
    if (digest !== expectedDigest) throw new Error('protected adapter artifact does not match the protected digest');
    return digest;
}

export async function loadProtectedAdapterModule(store, scope, { validateIdentity = true } = {}) {
    const trust = store.getTrustAnchor(scope);
    if (!trust?.adapter_path) throw new Error(`${scope} requires an administrator-provisioned adapter path`);
    const artifact = await collectProtectedAdapter(resolve(trust.adapter_path));
    if (artifact.digest !== trust.adapter_digest) throw new Error('protected adapter artifact does not match the protected digest');
    const snapshot = mkdtempSync(join(tmpdir(), 'orchard-protected-adapter-'));
    for (const file of artifact.files) {
        const destination = join(snapshot, file.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, file.source, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
    }
    const loaded = await import(pathToFileURL(join(snapshot, artifact.entryRelative)).href);
    if (validateIdentity && loaded.adapterIdentity !== trust.adapter_identity) {
        throw new Error(`${scope} adapter module identity does not match the protected identity`);
    }
    return { loaded, trust };
}

export async function loadProtectedAdapter(store, scope, requiredMethod) {
    const { loaded, trust } = await loadProtectedAdapterModule(store, scope);
    const adapter = loaded.adapter ?? loaded.default ?? (loaded.createAdapter ? await loaded.createAdapter() : null);
    if (!adapter || typeof adapter[requiredMethod] !== 'function') {
        throw new TypeError(`${scope} adapter module does not implement ${requiredMethod}`);
    }
    adapter.adapterIdentity = trust.adapter_identity;
    adapter.adapterDigest = trust.adapter_digest;
    return adapter;
}
