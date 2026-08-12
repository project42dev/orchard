#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
    applyGateIssues,
    decisionCommand,
    gateIssueRequest,
    generateGateManifests,
    MAX_GATE_BATCH_SIZE,
    renderGateIssueBody,
    verifyGateManifestDigests,
} from './lib/gates.mjs';

export {
    applyGateIssues,
    decisionCommand,
    gateIssueRequest,
    generateGateManifests,
    MAX_GATE_BATCH_SIZE,
    renderGateIssueBody,
    verifyGateManifestDigests,
};
export { renderGateIssueBody as buildIssueBody };

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            input: { type: 'string' },
            output: { type: 'string' },
            repository: { type: 'string', default: 'project42dev/orchard' },
            apply: { type: 'boolean', default: false },
            'adapter-module': { type: 'string' },
        },
    });
    if (!values.input) throw new Error('usage: notify-review-ready.mjs --input <gate-input.json> [--output <manifests.json>] [--apply --adapter-module <module>]');
    const manifests = await generateGateManifests(JSON.parse(readFileSync(resolve(values.input), 'utf8')));
    if (values.output) writeFileSync(resolve(values.output), `${JSON.stringify(manifests, null, 2)}\n`, 'utf8');
    let githubAdapter;
    if (values.apply) {
        if (!values['adapter-module']) throw new Error('--apply requires --adapter-module exporting an authenticated githubAdapter');
        ({ githubAdapter } = await import(pathToFileURL(resolve(values['adapter-module'])).href));
    }
    const results = await applyGateIssues({ manifests, repository: values.repository, githubAdapter, apply: values.apply });
    console.log(JSON.stringify({ manifests, results }, null, 2));
    if (!values.apply) console.error('DRY RUN. No external issue writes performed.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
