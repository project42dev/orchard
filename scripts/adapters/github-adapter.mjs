const DEFAULT_RETRIES = 2;

export class ExternalStateMismatchError extends Error {
    constructor(provider, externalKey, mismatches) {
        super(`${provider} object for ${externalKey} does not exactly match the requested fields: ${mismatches.join('; ')}`);
        this.name = 'ExternalStateMismatchError';
        this.provider = provider;
        this.externalKey = externalKey;
        this.mismatches = mismatches;
    }
}

export class AmbiguousExternalStateError extends Error {
    constructor(provider, externalKey, count) {
        super(`${provider} query for ${externalKey} returned ${count} objects; expected at most one`);
        this.name = 'AmbiguousExternalStateError';
        this.provider = provider;
        this.externalKey = externalKey;
        this.count = count;
    }
}

export class UnknownExternalOutcomeError extends Error {
    constructor(provider, externalKey, cause) {
        super(`${provider} write outcome for ${externalKey} remains unknown after reconciliation`, { cause });
        this.name = 'UnknownExternalOutcomeError';
        this.provider = provider;
        this.externalKey = externalKey;
    }
}

function mismatchPaths(actual, expected, prefix = '') {
    const mismatches = [];
    for (const key of Object.keys(expected).sort()) {
        const path = prefix ? `${prefix}.${key}` : key;
        const wanted = expected[key];
        const observed = actual?.[key];
        if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
            mismatches.push(...mismatchPaths(observed, wanted, path));
        } else if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
            mismatches.push(`${path}: expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(observed)}`);
        }
    }
    return mismatches;
}

export function assertExactGithubIssue(issue, expected, externalKey) {
    const mismatches = mismatchPaths(issue, expected);
    if (mismatches.length) throw new ExternalStateMismatchError('github', externalKey, mismatches);
    return issue;
}

function assertExactGithubObject(object, expected, externalKey) {
    const mismatches = mismatchPaths(object, expected);
    if (mismatches.length) throw new ExternalStateMismatchError('github', externalKey, mismatches);
    return object;
}

function assertPublicationTarget(repository, branch, { allowHead = false } = {}) {
    if (repository !== 'project42dev/project42-platform') throw new TypeError('publication is restricted to project42dev/project42-platform');
    if (branch === 'main' && allowHead) throw new TypeError('direct publication to protected main is forbidden');
    if (branch !== 'main' && !allowHead) throw new TypeError('protected-main acknowledgement must target main');
}

function isUnknownOutcome(error) {
    return error?.unknownOutcome === true || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error?.code);
}

function normalizeMatches(result) {
    if (result == null) return [];
    return Array.isArray(result) ? result : [result];
}

export class GitHubAdapter {
    constructor({ client, commandRunner, maxRetries = DEFAULT_RETRIES, adapterIdentity, adapterDigest } = {}) {
        if (!client && !commandRunner) throw new TypeError('GitHubAdapter requires an injected authenticated client or command runner');
        if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new RangeError('maxRetries must be between 0 and 5');
        this.client = client;
        this.commandRunner = commandRunner;
        this.maxRetries = maxRetries;
        this.adapterIdentity = adapterIdentity ?? null;
        this.adapterDigest = adapterDigest ?? null;
    }

    async #invoke(method, payload) {
        if (this.client?.[method]) return this.client[method](payload);
        if (!this.commandRunner) throw new TypeError(`injected GitHub client does not implement ${method}`);
        const operation = {
            queryIssuesByExternalKey: ['issue', 'list'],
            createIssue: ['issue', 'create'],
            updateIssue: ['issue', 'edit'],
            queryBranch: ['api', 'repos/{owner}/{repo}/git/ref/heads/{branch}'],
            createBranch: ['api', 'repos/{owner}/{repo}/git/refs'],
            queryPullRequestsByExternalKey: ['pr', 'list'],
            createPullRequest: ['pr', 'create'],
            queryPullRequest: ['pr', 'view'],
            mergePullRequest: ['pr', 'merge'],
            queryProtectedBranch: ['api', 'repos/{owner}/{repo}/git/ref/heads/main'],
        }[method];
        if (!operation) throw new TypeError(`unsupported GitHub operation ${method}`);
        return this.commandRunner({ executable: 'gh', arguments: operation, input: payload });
    }

    async queryByExternalKey({ repository, externalKey }) {
        if (!repository || !externalKey) throw new TypeError('repository and externalKey are required');
        return normalizeMatches(await this.#invoke('queryIssuesByExternalKey', { repository, externalKey }));
    }

    async reconcile({ repository, externalKey, expected }) {
        const matches = await this.queryByExternalKey({ repository, externalKey });
        if (matches.length > 1) throw new AmbiguousExternalStateError('github', externalKey, matches.length);
        if (matches.length === 0) return { classification: 'absent', object: null };
        return { classification: 'exact', object: assertExactGithubIssue(matches[0], expected, externalKey) };
    }

    async reconcileBeforeCreate({ repository, externalKey, expected, create }) {
        const prior = await this.reconcile({ repository, externalKey, expected });
        if (prior.classification === 'exact') return { ...prior, operation: 'reconciled' };

        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                const object = await this.#invoke('createIssue', { repository, externalKey, ...create });
                return { classification: 'exact', operation: 'created', object: assertExactGithubIssue(object, expected, externalKey) };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const reconciled = await this.reconcile({ repository, externalKey, expected });
                if (reconciled.classification === 'exact') return { ...reconciled, operation: 'reconciled-after-unknown' };
            }
        }
        throw new UnknownExternalOutcomeError('github', externalKey, lastError);
    }

    async reconcileBeforeUpdate({ repository, externalKey, expectedCurrent, expectedUpdated, update }) {
        const matches = await this.queryByExternalKey({ repository, externalKey });
        if (matches.length > 1) throw new AmbiguousExternalStateError('github', externalKey, matches.length);
        if (matches.length === 0) throw new Error(`github object for ${externalKey} does not exist`);
        if (mismatchPaths(matches[0], expectedUpdated).length === 0) return { classification: 'exact', operation: 'already-updated', object: assertExactGithubIssue(matches[0], expectedUpdated, externalKey) };
        const current = { object: assertExactGithubIssue(matches[0], expectedCurrent, externalKey) };

        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                const object = await this.#invoke('updateIssue', { repository, externalKey, issue: current.object, ...update });
                return { classification: 'exact', operation: 'updated', object: assertExactGithubIssue(object, expectedUpdated, externalKey) };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const reconciled = await this.reconcile({ repository, externalKey, expected: expectedUpdated });
                if (reconciled.classification === 'exact') return { ...reconciled, operation: 'reconciled-after-unknown' };
            }
        }
        throw new UnknownExternalOutcomeError('github', externalKey, lastError);
    }

    async #boundedWrite({ externalKey, write, reconcile, operation }) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            const prior = await reconcile();
            if (prior.classification === 'exact') return { ...prior, operation: attempt === 0 ? 'reconciled' : 'reconciled-after-unknown' };
            try {
                const object = await write();
                return { classification: 'exact', operation, object };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const after = await reconcile();
                if (after.classification === 'exact') return { ...after, operation: 'reconciled-after-unknown' };
            }
        }
        throw new UnknownExternalOutcomeError('github', externalKey, lastError);
    }

    async reconcileBranch({ repository, branch, expected }) {
        assertPublicationTarget(repository, branch, { allowHead: true });
        const matches = normalizeMatches(await this.#invoke('queryBranch', { repository, branch }));
        if (matches.length > 1) throw new AmbiguousExternalStateError('github', `branch:${branch}`, matches.length);
        if (matches.length === 0) return { classification: 'absent', object: null };
        return { classification: 'exact', object: assertExactGithubObject(matches[0], expected, `branch:${branch}`) };
    }

    async reconcileBeforeCreateBranch({ repository, branch, expected, create }) {
        assertPublicationTarget(repository, branch, { allowHead: true });
        return this.#boundedWrite({
            externalKey: `branch:${branch}`, operation: 'created',
            reconcile: () => this.reconcileBranch({ repository, branch, expected }),
            write: async () => assertExactGithubObject(
                await this.#invoke('createBranch', { repository, branch, ...create }), expected, `branch:${branch}`
            )
        });
    }

    async reconcilePullRequest({ repository, externalKey, expected }) {
        assertPublicationTarget(repository, expected.headBranch, { allowHead: true });
        if (expected.baseBranch !== 'main') throw new TypeError('publication pull requests must target protected main');
        const matches = normalizeMatches(await this.#invoke('queryPullRequestsByExternalKey', { repository, externalKey }));
        if (matches.length > 1) throw new AmbiguousExternalStateError('github', externalKey, matches.length);
        if (matches.length === 0) return { classification: 'absent', object: null };
        return { classification: 'exact', object: assertExactGithubObject(matches[0], expected, externalKey) };
    }

    async reconcileBeforeCreatePullRequest({ repository, externalKey, expected, create }) {
        assertPublicationTarget(repository, expected.headBranch, { allowHead: true });
        return this.#boundedWrite({
            externalKey, operation: 'created',
            reconcile: () => this.reconcilePullRequest({ repository, externalKey, expected }),
            write: async () => assertExactGithubObject(
                await this.#invoke('createPullRequest', { repository, externalKey, ...create }), expected, externalKey
            )
        });
    }

    async reconcileMerge({ repository, externalKey, pullNumber, expected }) {
        const object = await this.#invoke('queryPullRequest', { repository, pullNumber, externalKey });
        if (!object || object.state !== 'merged') return { classification: 'absent', object };
        return { classification: 'exact', object: assertExactGithubObject(object, expected, externalKey) };
    }

    async reconcileBeforeMerge({ repository, externalKey, pullNumber, expected, merge }) {
        if (merge.baseBranch !== 'main') throw new TypeError('publication merges must target protected main');
        assertPublicationTarget(repository, merge.headBranch, { allowHead: true });
        return this.#boundedWrite({
            externalKey, operation: 'merged',
            reconcile: () => this.reconcileMerge({ repository, externalKey, pullNumber, expected }),
            write: async () => assertExactGithubObject(
                await this.#invoke('mergePullRequest', { repository, pullNumber, externalKey, ...merge }), expected, externalKey
            )
        });
    }

    async reconcileProtectedMain({ repository, branch = 'main', expectedCommit }) {
        assertPublicationTarget(repository, branch);
        const object = await this.#invoke('queryProtectedBranch', { repository, branch });
        if (!object) return { classification: 'absent', object: null };
        return {
            classification: 'exact', object: assertExactGithubObject(object,
                { repository, branch: 'main', commit: expectedCommit }, `protected-main:${expectedCommit}`)
        };
    }
}

export function createGitHubAdapter(options) {
    return new GitHubAdapter(options);
}
