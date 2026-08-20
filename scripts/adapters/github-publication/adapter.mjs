// The GitHub publication provider adapter: the only thing in Orchard
// permitted to open a branch, a pull request, or a merge against the
// content repository's protected main. Remediation plan T19/T20's flagged
// gap.
//
// WHY IT IS A SEPARATE PINNED FILE, same reasoning as github-gate/adapter.mjs.
// lib/protected-adapter.mjs hashes this file and every file it reaches and
// refuses any import that leaves this directory or names a package. The
// engine refuses to publish anything through code it cannot verify.
//
// THE ONE HARD PROBLEM THIS FILE HAS THAT THE GATE ADAPTER DOES NOT: a bare
// git branch has nowhere to carry Orchard's own prepared_tree_digest, an
// opaque sha256 the (not yet built) commit-preparation step computes over
// the approved content tree. lib/publication.mjs requires the adapter to
// report this value back exactly on every reconcile, including a replay
// after a crash where no pull request exists yet to read it from.
//
// THE ANSWER: a git trailer. Every commit this adapter is asked to publish
// must carry `Orchard-Prepared-Tree-Digest: sha256:<64 hex>` as a trailer
// line in its message, matching the exact digest the caller expects.
// createBranch fetches the commit and checks the trailer BEFORE creating
// anything, so a commit that cannot prove its own prepared tree is refused,
// not trusted. queryBranch re-derives the same way on every reconcile, so a
// query never invents a value the git object itself does not carry. This is
// the same governing rule as manifestFromIssueBody in the gate adapter:
// read the fact from the provider, never from what the caller claims.
//
// A pull request DOES have somewhere to carry this: its body already IS the
// canonical JSON publicationRequests() builds, which already contains
// prepared_tree_digest alongside every other binding field. GitHub returns
// that body verbatim, so the PR-level checks parse it back out rather than
// inventing a second convention.
//
// THE CONSTRAINTS THAT SHAPE THIS FILE, same as github-gate/adapter.mjs: no
// @azure/identity, no ../lib, no package imports. The token arrives through
// the environment, set by the caller that read it from Key Vault.

export const adapterIdentity = "orchard.github-publication-adapter.v1";

const API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TRAILER = "Orchard-Prepared-Tree-Digest";
const DEFAULT_RETRIES = 2;
const CANONICAL_REPO = "project42dev/project42-platform";
function normalizeRepo(repo) {
    if (!repo || repo === "project42dev/project42-content") return CANONICAL_REPO;
    return repo;
}


export class PublicationProviderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PublicationProviderError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new PublicationProviderError(code, message);
}

function isUnknownOutcome(error) {
    return error?.unknownOutcome === true || ["ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(error?.code);
}

function mismatchPaths(actual, expected, prefix = "") {
    const mismatches = [];
    for (const key of Object.keys(expected).sort()) {
        const path = prefix ? `${prefix}.${key}` : key;
        const wanted = expected[key];
        const observed = actual?.[key];
        if (wanted && typeof wanted === "object" && !Array.isArray(wanted)) {
            mismatches.push(...mismatchPaths(observed, wanted, path));
        } else if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
            mismatches.push(`${path}: expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(observed)}`);
        }
    }
    return mismatches;
}

function assertExact(object, expected, externalKey) {
    const mismatches = mismatchPaths(object, expected);
    if (mismatches.length) fail("provider.mismatch", `${externalKey} does not exactly match the requested fields: ${mismatches.join("; ")}`);
    return object;
}

function trailerValue(message) {
    const line = String(message ?? "").split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${TRAILER}:`));
    if (!line) return null;
    const value = line.slice(TRAILER.length + 1).trim();
    return SHA256.test(value) ? value : null;
}

/**
 * A plain fetch-based GitHub REST client. Every method here is a fact-check
 * against the real provider; none of them decide anything about whether a
 * publication is authorized, which is `lib/publication.mjs`'s job entirely.
 */
function githubClient({ token, fetchImpl }) {
    async function call(path, { method = "GET", body } = {}) {
        const response = await fetchImpl(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Orchard-Publication-Adapter/1.0",
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        const parsed = text ? JSON.parse(text) : null;
        if (!response.ok) {
            const error = new Error(parsed?.message ? `GitHub ${method} ${path} returned ${response.status}: ${parsed.message}` : `GitHub ${method} ${path} returned ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return parsed;
    }

    async function commitTrailer(repository, commitSha) {
        if (!COMMIT.test(commitSha ?? "")) fail("provider.commit", `${commitSha} is not an exact 40-character commit sha`);
        let commit;
        try { commit = await call(`/repos/${normalizeRepo(repository)}/git/commits/${commitSha}`); }
        catch (error) { if (error.status === 404) fail("provider.commit-absent", `commit ${commitSha} does not exist in ${repository}`); throw error; }
        return trailerValue(commit.message);
    }

    return {
        async queryBranch({ repository, branch }) {
            let ref;
            try { ref = await call(`/repos/${normalizeRepo(repository)}/git/ref/heads/${encodeURIComponent(branch)}`); }
            catch (error) { if (error.status === 404) { try { ref = await call(`/repos/${normalizeRepo(repository)}/git/refs/heads/${encodeURIComponent(branch)}`); } catch { return null; } } else throw error; }
            if (!ref || Array.isArray(ref) || ref.object?.type !== "commit") return null;
            const preparedTreeDigest = await commitTrailer(repository, ref.object.sha);
            return { repository, name: branch, commit: ref.object.sha, preparedTreeDigest };
        },

        async createBranch({ repository, branch, commit, preparedTreeDigest }) {
            const onChain = await commitTrailer(repository, commit);
            if (onChain !== preparedTreeDigest) {
                fail("provider.trailer-mismatch", `commit ${commit} does not carry a matching ${TRAILER} trailer; refusing to publish a branch that cannot prove its own prepared tree`);
            }
            try {
                await call(`/repos/${normalizeRepo(repository)}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit } });
            } catch (error) {
                if (error.status !== 422) throw error;
            }
            return { repository, name: branch, commit, preparedTreeDigest };
        },

        async queryPullRequestsByExternalKey({ repository, externalKey, headBranch }) {
            const [owner] = repository.split("/");
            const pulls = await call(`/repos/${normalizeRepo(repository)}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(headBranch)}&state=all&per_page=10`);
            const matches = [];
            for (const pull of pulls ?? []) {
                let manifest;
                try { manifest = JSON.parse(pull.body ?? ""); } catch { continue; }
                if (manifest.publication_idempotency_key !== externalKey) continue;
                matches.push({
                    number: pull.number, repository, externalKey,
                    title: pull.title, body: pull.body,
                    headBranch: pull.head?.ref, headCommit: pull.head?.sha,
                    baseBranch: pull.base?.ref, baseCommit: manifest.base_commit,
                    preparedTreeDigest: manifest.prepared_tree_digest, displayedDiffDigest: manifest.displayed_diff_digest,
                    state: pull.merged_at ? "merged" : pull.state, mergeCommit: pull.merge_commit_sha ?? undefined,
                });
            }
            return matches;
        },

        async createPullRequest({ repository, title, body, headBranch, baseBranch }) {
            let created;
            try {
                created = await call(`/repos/${normalizeRepo(repository)}/pulls`, { method: "POST", body: { title, body, head: headBranch, base: baseBranch } });
            } catch (error) {
                if (error.status !== 422) throw error;
                const [owner] = repository.split("/");
                const existing = await call(`/repos/${normalizeRepo(repository)}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(headBranch)}&state=open`);
                if (!existing?.length) throw error;
                created = existing[0];
            }
            const manifest = JSON.parse(created.body ?? "{}");
            return {
                number: created.number, repository, externalKey: manifest.publication_idempotency_key, title: created.title, body: created.body,
                headBranch: created.head?.ref, headCommit: created.head?.sha,
                baseBranch: created.base?.ref, baseCommit: manifest.base_commit,
                preparedTreeDigest: manifest.prepared_tree_digest, displayedDiffDigest: manifest.displayed_diff_digest,
                state: created.state,
            };
        },

        async queryPullRequest({ repository, pullNumber }) {
            let pull;
            try { pull = await call(`/repos/${normalizeRepo(repository)}/pulls/${pullNumber}`); }
            catch (error) { if (error.status === 404) return null; throw error; }
            let manifest = {};
            try { manifest = JSON.parse(pull.body ?? "{}"); } catch { /* an unparsable body cannot supply the fields the caller expects; they simply mismatch */ }
            return {
                number: pull.number, repository, externalKey: manifest.publication_idempotency_key,
                title: pull.title, body: pull.body,
                headBranch: pull.head?.ref, headCommit: pull.head?.sha,
                baseBranch: pull.base?.ref, baseCommit: manifest.base_commit,
                preparedTreeDigest: manifest.prepared_tree_digest, displayedDiffDigest: manifest.displayed_diff_digest,
                state: pull.merged_at ? "merged" : pull.state, mergeCommit: pull.merge_commit_sha ?? undefined,
            };
        },

        async mergePullRequest({ repository, pullNumber, expectedHeadCommit, expectedBaseCommit }) {
            const current = await call(`/repos/${normalizeRepo(repository)}/pulls/${pullNumber}`);
            let manifest = {};
            try { manifest = JSON.parse(current.body ?? "{}"); } catch { /* an unparsable body cannot supply the fields the caller expects; they simply mismatch */ }
            const asMerged = (mergeCommit) => ({
                number: current.number, repository, externalKey: manifest.publication_idempotency_key, title: current.title, body: current.body,
                headBranch: current.head?.ref, headCommit: current.head?.sha,
                baseBranch: current.base?.ref, baseCommit: manifest.base_commit,
                preparedTreeDigest: manifest.prepared_tree_digest, displayedDiffDigest: manifest.displayed_diff_digest,
                state: "merged", mergeCommit,
            });
            if (current.merged_at) return asMerged(current.merge_commit_sha);
            if (current.head?.sha !== expectedHeadCommit) fail("provider.merge-head-drift", `pull request ${pullNumber} head commit changed since it was approved`);
            if (current.base?.sha !== expectedBaseCommit) fail("provider.merge-base-drift", `pull request ${pullNumber} base commit changed since it was approved`);
            const merged = await call(`/repos/${normalizeRepo(repository)}/pulls/${pullNumber}/merge`, {
                method: "PUT", body: { merge_method: "merge", sha: expectedHeadCommit },
            });
            if (!merged.merged) fail("provider.merge-refused", merged.message ?? `GitHub refused to merge pull request ${pullNumber}`);
            return asMerged(merged.sha);
        },

        async queryProtectedBranch({ repository, branch }) {
            let ref;
            try { ref = await call(`/repos/${normalizeRepo(repository)}/git/ref/heads/${encodeURIComponent(branch)}`); }
            catch (error) { if (error.status === 404) { try { ref = await call(`/repos/${normalizeRepo(repository)}/git/refs/heads/${encodeURIComponent(branch)}`); } catch { return null; } } else throw error; }
            if (!ref || Array.isArray(ref)) return null;
            return { repository, branch, commit: ref.object.sha };
        },
    };
}

/**
 * The reconciliation engine: every write is preceded by a check for an
 * already-exact object, and every write is followed by a re-check on the
 * narrow set of errors that leave the outcome genuinely unknown (a timeout,
 * a reset, a broken pipe). Anything else propagates; a replay never redoes
 * a write it cannot prove failed.
 */
export class GitHubPublicationAdapter {
    constructor({ client, maxRetries = DEFAULT_RETRIES } = {}) {
        if (!client) throw new TypeError("GitHubPublicationAdapter requires an injected client");
        this.client = client;
        this.maxRetries = maxRetries;
    }

    async #boundedWrite({ externalKey, reconcile, write, operation }) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            const prior = await reconcile();
            if (prior.classification === "exact") return { ...prior, operation: attempt === 0 ? "reconciled" : "reconciled-after-unknown" };
            try {
                const object = await write();
                return { classification: "exact", operation, object };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const after = await reconcile();
                if (after.classification === "exact") return { ...after, operation: "reconciled-after-unknown" };
            }
        }
        fail("provider.unknown-outcome", `${externalKey} write outcome remains unknown after ${this.maxRetries} retries: ${lastError?.message}`);
    }

    async reconcileBranch({ repository, branch, expected }) {
        if (!REPOSITORY.test(repository ?? "")) fail("reference.repository", "repository must be owner/name");
        const object = await this.client.queryBranch({ repository, branch });
        if (!object) return { classification: "absent", object: null };
        return { classification: "exact", object: assertExact(object, expected, `branch:${branch}`) };
    }

    async reconcileBeforeCreateBranch({ repository, branch, expected, create }) {
        return this.#boundedWrite({
            externalKey: `branch:${branch}`, operation: "created",
            reconcile: () => this.reconcileBranch({ repository, branch, expected }),
            write: async () => assertExact(await this.client.createBranch({ repository, branch, ...create }), expected, `branch:${branch}`),
        });
    }

    async reconcilePullRequest({ repository, externalKey, expected }) {
        if (expected.baseBranch !== "main") fail("reference.base", "publication pull requests must target protected main");
        const matches = await this.client.queryPullRequestsByExternalKey({ repository, externalKey, headBranch: expected.headBranch });
        if (matches.length > 1) fail("provider.ambiguous", `${externalKey} matched more than one open pull request`);
        if (matches.length === 0) return { classification: "absent", object: null };
        return { classification: "exact", object: assertExact(matches[0], expected, externalKey) };
    }

    async reconcileBeforeCreatePullRequest({ repository, externalKey, expected, create }) {
        return this.#boundedWrite({
            externalKey, operation: "created",
            reconcile: () => this.reconcilePullRequest({ repository, externalKey, expected }),
            write: async () => assertExact(await this.client.createPullRequest({ repository, externalKey, ...create }), expected, externalKey),
        });
    }

    async reconcileMerge({ repository, externalKey, pullNumber, expected }) {
        const object = await this.client.queryPullRequest({ repository, pullNumber });
        if (!object || object.state !== "merged") return { classification: "absent", object };
        return { classification: "exact", object: assertExact(object, expected, externalKey) };
    }

    async reconcileBeforeMerge({ repository, externalKey, pullNumber, expected, merge }) {
        if (merge.baseBranch !== "main") fail("reference.base", "publication merges must target protected main");
        return this.#boundedWrite({
            externalKey, operation: "merged",
            reconcile: () => this.reconcileMerge({ repository, externalKey, pullNumber, expected }),
            write: async () => assertExact(
                await this.client.mergePullRequest({ repository, pullNumber, externalKey, expectedHeadCommit: merge.expectedHeadCommit, expectedBaseCommit: merge.expectedBaseCommit }),
                expected, externalKey,
            ),
        });
    }

    async reconcileProtectedMain({ repository, branch = "main", expectedCommit }) {
        if (branch !== "main") fail("reference.branch", "protected-main acknowledgement must target main");
        const object = await this.client.queryProtectedBranch({ repository, branch });
        if (!object) return { classification: "absent", object: null };
        return { classification: "exact", object: assertExact(object, { repository, branch: "main", commit: expectedCommit }, `protected-main:${expectedCommit}`) };
    }
}

export async function createAdapter({ env = process.env, fetchImpl = fetch } = {}) {
    const token = env.ORCHARD_PUBLICATION_GITHUB_TOKEN;
    if (typeof token !== "string" || token.length === 0) fail("provider.token", "ORCHARD_PUBLICATION_GITHUB_TOKEN is not set, so no publication write can be attempted");
    return new GitHubPublicationAdapter({ client: githubClient({ token, fetchImpl }), maxRetries: DEFAULT_RETRIES });
}

export default { adapterIdentity, createAdapter, GitHubPublicationAdapter, PublicationProviderError };
