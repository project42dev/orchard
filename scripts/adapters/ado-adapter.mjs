import {
    AmbiguousExternalStateError,
    ExternalStateMismatchError,
    UnknownExternalOutcomeError,
} from './github-adapter.mjs';

function mismatchPaths(actual, expected, prefix = '') {
    const mismatches = [];
    for (const key of Object.keys(expected).sort()) {
        const path = prefix ? `${prefix}.${key}` : key;
        const wanted = expected[key];
        const observed = actual?.[key];
        if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) mismatches.push(...mismatchPaths(observed, wanted, path));
        else if (JSON.stringify(observed) !== JSON.stringify(wanted)) mismatches.push(`${path}: expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(observed)}`);
    }
    return mismatches;
}

export function assertExactAdoWorkItem(item, expected, externalKey) {
    const mismatches = mismatchPaths(item, expected);
    if (mismatches.length) throw new ExternalStateMismatchError('ado', externalKey, mismatches);
    if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1) {
        throw new ExternalStateMismatchError('ado', externalKey, ['id must be a positive ADO work item ID']);
    }
    return item;
}

function isUnknownOutcome(error) {
    return error?.unknownOutcome === true || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error?.code);
}

function normalizeMatches(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

export class AdoAdapter {
    constructor({ client, commandRunner, maxRetries = 2 } = {}) {
        if (!client && !commandRunner) throw new TypeError('AdoAdapter requires an injected authenticated client or command runner');
        if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new RangeError('maxRetries must be between 0 and 5');
        this.client = client;
        this.commandRunner = commandRunner;
        this.maxRetries = maxRetries;
    }

    async #invoke(method, payload) {
        if (this.client?.[method]) return this.client[method](payload);
        if (!this.commandRunner) throw new TypeError(`injected ADO client does not implement ${method}`);
        const args = {
            queryWorkItemsByExternalKey: ['boards', 'query'],
            createWorkItem: ['boards', 'work-item', 'create'],
            updateWorkItem: ['boards', 'work-item', 'update'],
        }[method];
        if (!args) throw new TypeError(`unsupported ADO operation ${method}`);
        return this.commandRunner({ executable: 'az', arguments: args, input: payload });
    }

    async queryByExternalKey({ externalKey, organization, project }) {
        if (!externalKey) throw new TypeError('externalKey is required');
        return normalizeMatches(await this.#invoke('queryWorkItemsByExternalKey', { externalKey, organization, project }));
    }

    async reconcile({ externalKey, expected, organization, project }) {
        const matches = await this.queryByExternalKey({ externalKey, organization, project });
        if (matches.length > 1) throw new AmbiguousExternalStateError('ado', externalKey, matches.length);
        if (!matches.length) return { classification: 'absent', object: null };
        return { classification: 'exact', object: assertExactAdoWorkItem(matches[0], expected, externalKey) };
    }

    async reconcileBeforeCreate({ externalKey, expected, create, organization, project }) {
        const prior = await this.reconcile({ externalKey, expected, organization, project });
        if (prior.classification === 'exact') return { ...prior, operation: 'reconciled' };
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                const object = await this.#invoke('createWorkItem', { externalKey, organization, project, ...create });
                return { classification: 'exact', operation: 'created', object: assertExactAdoWorkItem(object, expected, externalKey) };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const reconciled = await this.reconcile({ externalKey, expected, organization, project });
                if (reconciled.classification === 'exact') return { ...reconciled, operation: 'reconciled-after-unknown' };
            }
        }
        throw new UnknownExternalOutcomeError('ado', externalKey, lastError);
    }

    async reconcileBeforeUpdate({ externalKey, expectedCurrent, expectedUpdated, update, organization, project }) {
        const matches = await this.queryByExternalKey({ externalKey, organization, project });
        if (matches.length > 1) throw new AmbiguousExternalStateError('ado', externalKey, matches.length);
        if (!matches.length) throw new Error(`ado work item for ${externalKey} does not exist`);
        if (mismatchPaths(matches[0], expectedUpdated).length === 0) return { classification: 'exact', operation: 'already-updated', object: assertExactAdoWorkItem(matches[0], expectedUpdated, externalKey) };
        assertExactAdoWorkItem(matches[0], expectedCurrent, externalKey);

        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                const object = await this.#invoke('updateWorkItem', { externalKey, organization, project, item: matches[0], ...update });
                return { classification: 'exact', operation: 'updated', object: assertExactAdoWorkItem(object, expectedUpdated, externalKey) };
            } catch (error) {
                lastError = error;
                if (!isUnknownOutcome(error)) throw error;
                const reconciled = await this.reconcile({ externalKey, expected: expectedUpdated, organization, project });
                if (reconciled.classification === 'exact') return { ...reconciled, operation: 'reconciled-after-unknown' };
            }
        }
        throw new UnknownExternalOutcomeError('ado', externalKey, lastError);
    }
}

export function createAdoAdapter(options) {
    return new AdoAdapter(options);
}
