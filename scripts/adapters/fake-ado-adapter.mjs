import { AdoAdapter } from './ado-adapter.mjs';

function clone(value) { return structuredClone(value); }
function timeout(message) { return Object.assign(new Error(message), { code: 'ETIMEDOUT', unknownOutcome: true }); }

export class FakeAdoClient {
    constructor({ workItems = [], scenarios = [] } = {}) {
        this.workItems = workItems.map(clone);
        this.scenarios = [...scenarios];
        this.calls = [];
        this.nextId = Math.max(5000, ...this.workItems.map((item) => Number(item.id) || 0)) + 1;
    }

    #scenario(operation) {
        const index = this.scenarios.findIndex((entry) => (typeof entry === 'string' ? true : entry.operation === operation));
        if (index < 0) return null;
        const [entry] = this.scenarios.splice(index, 1);
        return typeof entry === 'string' ? { type: entry } : entry;
    }

    async queryWorkItemsByExternalKey(input) {
        this.calls.push({ operation: 'query', input: clone(input) });
        const scenario = this.#scenario('query');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic ADO query failure');
        if (scenario?.type === 'timeout') throw timeout('deterministic ADO query timeout');
        let matches = this.workItems.filter((item) => item.externalKey === input.externalKey).map(clone);
        if (scenario?.type === 'duplicate' && matches.length === 1) matches = [matches[0], { ...matches[0], id: matches[0].id + 1000 }];
        if (scenario?.type === 'mismatch' && matches.length) matches[0] = { ...matches[0], ...(scenario.patch ?? { title: 'mismatch' }) };
        return matches;
    }

    async createWorkItem(input) {
        this.calls.push({ operation: 'create', input: clone(input) });
        const scenario = this.#scenario('create');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic ADO create failure');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic ADO timeout before create');
        const item = { id: this.nextId++, externalKey: input.externalKey, ...clone(input.fields ?? {}) };
        this.workItems.push(item);
        if (scenario?.type === 'duplicate') this.workItems.push({ ...item, id: this.nextId++ });
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic ADO timeout after create');
        return clone(scenario?.type === 'mismatch' ? { ...item, ...(scenario.patch ?? { title: 'mismatch' }) } : item);
    }

    async updateWorkItem(input) {
        this.calls.push({ operation: 'update', input: clone(input) });
        const scenario = this.#scenario('update');
        if (scenario?.type === 'failure') throw new Error(scenario.message ?? 'deterministic ADO update failure');
        const index = this.workItems.findIndex((item) => item.externalKey === input.externalKey);
        if (index < 0) throw new Error('work item not found');
        if (scenario?.type === 'timeout-before') throw timeout('deterministic ADO timeout before update');
        this.workItems[index] = { ...this.workItems[index], ...clone(input.fields ?? {}) };
        if (scenario?.type === 'timeout' || scenario?.type === 'timeout-after') throw timeout('deterministic ADO timeout after update');
        return clone(scenario?.type === 'mismatch' ? { ...this.workItems[index], ...(scenario.patch ?? { title: 'mismatch' }) } : this.workItems[index]);
    }
}

export class FakeAdoAdapter extends AdoAdapter {
    constructor(options = {}) {
        const client = options.client ?? new FakeAdoClient(options);
        super({ client, maxRetries: options.maxRetries ?? 2 });
        this.fakeClient = client;
    }
}
