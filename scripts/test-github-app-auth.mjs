#!/usr/bin/env node
// T5. The gate credential moved from a personal access token to a GitHub App
// installation token. Two failure modes made this defect class before it was
// even used: a JWT whose (exp - iat) exceeds GitHub's 600 second ceiling is
// rejected with an opaque 401 "Bad credentials", and a token exchange
// failure must be distinguishable (a 404-shaped absence vs. everything else)
// the same way the existing vault read already is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { signAppJwt, mintInstallationToken } from './lib/github-app-auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function decodeSegment(segment) {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

test('signAppJwt produces a three-segment RS256 token with a 600 second window', () => {
    const now = 1_800_000_000;
    const jwt = signAppJwt({ appId: '4413058', privateKeyPem: privateKey, now: () => now });
    const segments = jwt.split('.');
    assert.equal(segments.length, 3);

    const header = decodeSegment(segments[0]);
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');

    const payload = decodeSegment(segments[1]);
    assert.equal(payload.iss, '4413058');
    assert.equal(payload.iat, now - 300);
    assert.equal(payload.exp, now + 300);
    assert.equal(payload.exp - payload.iat, 600, 'GitHub rejects a JWT whose exp exceeds iat by more than 600 seconds');
});

test('signAppJwt signature verifies against the matching public key', () => {
    const jwt = signAppJwt({ appId: '4413058', privateKeyPem: privateKey });
    const [header, payload, signature] = jwt.split('.');
    const signingInput = Buffer.from(`${header}.${payload}`);
    const signatureBytes = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const ok = verify('RSA-SHA256', signingInput, createPublicKey(publicKey), signatureBytes);
    assert.equal(ok, true);
});

test('mintInstallationToken returns the token on a 2xx response', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            json: async () => ({ token: 'ghs_fake', permissions: { issues: 'write' } }),
        };
    };
    const token = await mintInstallationToken({ appId: '4413058', installationId: '154162603', privateKeyPem: privateKey, fetchImpl });
    assert.equal(token, 'ghs_fake');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/app/installations/154162603/access_tokens');
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[0].options.headers.Authorization, /^Bearer /);
});

test('mintInstallationToken throws with .status set on a non-2xx response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(
        () => mintInstallationToken({ appId: '4413058', installationId: 'missing', privateKeyPem: privateKey, fetchImpl }),
        (error) => {
            assert.equal(error.status, 404);
            return true;
        },
    );
});
