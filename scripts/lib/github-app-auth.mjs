// Mint a GitHub App installation token from a PEM private key.
//
// T5: the gate client used a personal access token, which shares its
// holder's rate-limit bucket with everything else that holder does. A
// GitHub App installation token draws from the installation's own bucket
// instead. The credential here is the App's private key, exchanged for a
// short-lived JWT (signed RS256, GitHub's required algorithm), then
// exchanged again for an installation token scoped to exactly the
// permissions the installation was granted.
//
// GitHub rejects a JWT whose (exp - iat) exceeds 600 seconds. A symmetric
// window (issued 300s in the past, expiring 300s in the future) tolerates
// clock skew in both directions without ever exceeding that ceiling.

import { createSign } from "node:crypto";

function base64Url(buffer) {
    return buffer.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signAppJwt({ appId, privateKeyPem, now = () => Math.floor(Date.now() / 1000) }) {
    const issuedAt = now();
    const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64Url(Buffer.from(JSON.stringify({ iat: issuedAt - 300, exp: issuedAt + 300, iss: String(appId) })));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const signature = base64Url(signer.sign(privateKeyPem));
    return `${header}.${payload}.${signature}`;
}

/**
 * Exchange an App JWT for an installation access token.
 *
 * Returns the token string, or throws with `.status` set to the GitHub
 * response status, matching the shape callers already handle for the vault
 * read (a 404-shaped failure and everything else are distinguishable).
 */
export async function mintInstallationToken({ appId, installationId, privateKeyPem, fetchImpl = fetch }) {
    const jwt = signAppJwt({ appId, privateKeyPem });
    const response = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (!response.ok) {
        const error = new Error(`installation token exchange returned ${response.status} for installation ${installationId}`);
        error.status = response.status;
        throw error;
    }
    const body = await response.json();
    return body.token;
}
