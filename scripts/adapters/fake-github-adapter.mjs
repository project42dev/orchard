import { GitHubAdapter } from './github-adapter.mjs';
import { createHash } from 'node:crypto';

function clone(value) { return structuredClone(value); }
function timeout(message) { return Object.assign(new Error(message), { code: 'ETIMEDOUT', unknownOutcome: true }); }

export class FakeGitHubClient {
    constructor({ issues = [], branches = [], pullRequests = [], protectedMain = null, scenarios = [], advanceMainOnMerge = false } = {}) {
        this.issues = issues.map(clone);
        this.branches = branches.map(clone);
        this.pullRequests = pullRequests.map(clone);
        this.protectedMain = clone(protectedMain);
        this.advanceMainOnMerge = advanceMainOnMerge;
        this.scenarios = [...scenarios];
        this.calls = [];
        this.nextNumber = Math.max(0, ...this.issues.map((issue) => Number(issue.number) || 0)) + 1;
        this.nextPullNumber = Math.max(0, ...this.pullRequests.map((pull) => Number(pull.number) || 0)) + 1;
    }

    #scenario(operation) {
        const index = this.scenarios.findIndex((entry) => (typeof entry === 'string' ? true : entry.operation === operation));
        if (index < 0) return null;
        const [entry] = this.scenarios.splice(index, 1);
        return typeof entry === 'string' ? { type: entry } : entry;
    }

    async queryIssuesByExternalKey(input) {
        this.calls.push({ operation: 'query', input: clone(input) });
        const scenario = this.#scenario('query');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub query failure');
        if (scenario?.type === 'timeout') throw timeout('deterministic GitHub query timeout');
        let matches = this.issues.filter((issue) => issue.repository === input.repository && issue.externalKey === input.externalKey).map(clone);
        if (scenario?.type === 'duplicate' && matches.length === 1) matches = [matches[0], { ...matches[0], number: matches[0].number + 1000 }];
        if (scenario?.type === 'mismatch' && matches.length) matches[0] = { ...matches[0], ...(scenario.patch ?? { title: 'mismatch' }) };
        return matches;
    }

    async createIssue(input) {
        this.calls.push({ operation: 'create', input: clone(input) });
        const scenario = this.#scenario('create');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub create failure');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic GitHub timeout before create');
        const issue = { number: this.nextNumber++, repository: input.repository, externalKey: input.externalKey, title: input.title, body: input.body, labels: input.labels ?? [] };
        this.issues.push(issue);
        if (scenario?.type === 'duplicate') this.issues.push({ ...issue, number: this.nextNumber++ });
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic GitHub timeout after create');
        return clone(scenario?.type === 'mismatch' ? { ...issue, ...(scenario.patch ?? { body: 'mismatch' }) } : issue);
    }

    async updateIssue(input) {
        this.calls.push({ operation: 'update', input: clone(input) });
        const scenario = this.#scenario('update');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub update failure');
        const index = this.issues.findIndex((issue) => issue.repository === input.repository && issue.externalKey === input.externalKey);
        if (index < 0) throw new Error('issue not found');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic GitHub timeout before update');
        this.issues[index] = { ...this.issues[index], ...input.patch };
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic GitHub timeout after update');
        return clone(scenario?.type === 'mismatch' ? { ...this.issues[index], ...(scenario.patchResult ?? { body: 'mismatch' }) } : this.issues[index]);
    }

    async queryBranch(input) {
        this.calls.push({ operation: 'query-branch', input: clone(input) });
        const scenario = this.#scenario('query-branch');
        if (scenario?.type === 'timeout') throw timeout('deterministic GitHub branch query timeout');
        const matches = this.branches.filter((entry) => entry.repository === input.repository && entry.name === input.branch);
        if (scenario?.type === 'duplicate' && matches.length === 1) matches.push({ ...matches[0] });
        if (matches.length > 1) return clone(matches);
        const branch = matches[0];
        return branch ? clone(scenario?.type === 'mismatch' ? { ...branch, ...scenario.patch } : branch) : null;
    }

    async createBranch(input) {
        this.calls.push({ operation: 'create-branch', input: clone(input) });
        const scenario = this.#scenario('create-branch');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic GitHub timeout before branch create');
        const branch = { repository: input.repository, name: input.branch, commit: input.commit, preparedTreeDigest: input.preparedTreeDigest };
        this.branches.push(branch);
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic GitHub timeout after branch create');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub branch create failure');
        return clone(scenario?.type === 'mismatch' ? { ...branch, ...scenario.patch } : branch);
    }

    async queryPullRequestsByExternalKey(input) {
        this.calls.push({ operation: 'query-pr', input: clone(input) });
        const scenario = this.#scenario('query-pr');
        if (scenario?.type === 'timeout') throw timeout('deterministic GitHub pull-request query timeout');
        let matches = this.pullRequests.filter((pull) => pull.repository === input.repository && pull.externalKey === input.externalKey).map(clone);
        if (scenario?.type === 'duplicate' && matches.length === 1) matches.push({ ...matches[0], number: matches[0].number + 1000 });
        if (scenario?.type === 'mismatch' && matches.length) matches[0] = { ...matches[0], ...scenario.patch };
        return matches;
    }

    async createPullRequest(input) {
        this.calls.push({ operation: 'create-pr', input: clone(input) });
        const scenario = this.#scenario('create-pr');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic GitHub timeout before pull-request create');
        const pull = {
            number: this.nextPullNumber++, repository: input.repository, externalKey: input.externalKey,
            title: input.title, body: input.body, headBranch: input.headBranch, headCommit: input.headCommit,
            baseBranch: input.baseBranch, baseCommit: input.baseCommit, preparedTreeDigest: input.preparedTreeDigest,
            displayedDiffDigest: input.displayedDiffDigest, state: 'open'
        };
        this.pullRequests.push(pull);
        if (scenario?.type === 'duplicate') this.pullRequests.push({ ...pull, number: this.nextPullNumber++ });
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic GitHub timeout after pull-request create');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub pull-request create failure');
        return clone(scenario?.type === 'mismatch' ? { ...pull, ...scenario.patch } : pull);
    }

    async queryPullRequest(input) {
        this.calls.push({ operation: 'query-merge', input: clone(input) });
        const scenario = this.#scenario('query-merge');
        if (scenario?.type === 'timeout') throw timeout('deterministic GitHub merge query timeout');
        const pull = this.pullRequests.find((entry) => entry.repository === input.repository && entry.number === input.pullNumber);
        return pull ? clone(scenario?.type === 'mismatch' ? { ...pull, ...scenario.patch } : pull) : null;
    }

    async mergePullRequest(input) {
        this.calls.push({ operation: 'merge-pr', input: clone(input) });
        const scenario = this.#scenario('merge-pr');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic GitHub timeout before merge');
        const index = this.pullRequests.findIndex((entry) => entry.repository === input.repository && entry.number === input.pullNumber);
        if (index < 0) throw new Error('pull request not found');
        const resultCommit = input.resultCommit ?? createHash('sha1').update(`${input.repository}\0${input.pullNumber}\0${input.expectedHeadCommit}\0${input.expectedBaseCommit}`).digest('hex');
        this.pullRequests[index] = { ...this.pullRequests[index], state: 'merged', mergeCommit: resultCommit };
        if (this.advanceMainOnMerge) this.protectedMain = { repository: input.repository, branch: 'main', commit: resultCommit };
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic GitHub timeout after merge');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic GitHub merge failure');
        return clone(scenario?.type === 'mismatch' ? { ...this.pullRequests[index], ...scenario.patch } : this.pullRequests[index]);
    }

    async queryProtectedBranch(input) {
        this.calls.push({ operation: 'query-main', input: clone(input) });
        const scenario = this.#scenario('query-main');
        if (scenario?.type === 'timeout') throw timeout('deterministic GitHub protected-main query timeout');
        if (!this.protectedMain || this.protectedMain.repository !== input.repository) return null;
        return clone(scenario?.type === 'mismatch' ? { ...this.protectedMain, ...scenario.patch } : this.protectedMain);
    }
}

export class FakeGitHubAdapter extends GitHubAdapter {
    constructor(options = {}) {
        const client = options.client ?? new FakeGitHubClient(options);
        super({
            client, maxRetries: options.maxRetries ?? 2,
            adapterIdentity: options.adapterIdentity ?? 'test:protected-publication-adapter:v1',
            adapterDigest: options.adapterDigest ?? `sha256:${'6'.repeat(64)}`
        });
        this.fakeClient = client;
    }
}
