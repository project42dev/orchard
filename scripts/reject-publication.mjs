#!/usr/bin/env node
// Record that a human rejected a proposal.
//
// Companion to record-publication.mjs. A rejection is a gate decision, so it
// is recorded as the lifecycle's own 'denied' transition with the reason and
// the rejecting person on it.
//
// SCHEMA. This tool targets workflow_item and publication_transaction from
// schema/migrations/002, the ONLY tables the deployed database has. The first
// version wrote into `publication` from schema/content-db.sql, which no
// migration ever applies, so it would have failed `no such table` on first
// use against production data.
//
// The lifecycle allows a denial only while an item is actually under review
// (gate1-pending or gate2-pending). An item that already carries immutable
// publication evidence cannot be "rejected" by bookkeeping: reversing a
// publication is a decision with its own machinery, not a row.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

export class RejectionError extends Error {
    constructor(detail, fix) {
        super(detail);
        this.name = 'RejectionError';
        this.detail = detail;
        this.fix = fix;
    }
}

const DENIABLE = new Set(['gate1-pending', 'gate2-pending']);

export async function recordRejection({
    dbPath,
    subjectId,
    rejectedBy,
    note = null,
    now = new Date().toISOString(),
    apply = false,
}) {
    if (!rejectedBy) {
        throw new RejectionError(
            'no --rejected-by',
            'name the person who rejected the proposal.',
        );
    }

    const store = openStateStore(dbPath);
    try {
        const db = store.db;
        // A semantic identity can match several items since migration 006: at
        // most one live one plus any closed predecessors. A rejection acts on
        // the live item, so closed matches sort last.
        const item = db.prepare(
            `SELECT item_id, outcome, current_state, current_revision, origin_run_id, semantic_identity
         FROM workflow_item WHERE item_id = ? OR semantic_identity = ?
        ORDER BY CASE WHEN current_state = 'closed' THEN 1 ELSE 0 END, updated_at DESC, item_id DESC
        LIMIT 1`,
        ).get(subjectId, subjectId);
        if (!item) {
            throw new RejectionError(
                `no workflow item matches "${subjectId}"`,
                'check the id against the workflow_item table.',
            );
        }
        const published = db.prepare(
            'SELECT transaction_id FROM publication_transaction WHERE item_id = ? LIMIT 1',
        ).get(item.item_id);
        if (published || item.current_state === 'published' || item.current_state === 'closed') {
            throw new RejectionError(
                `workflow item "${item.item_id}" carries publication evidence (state ${item.current_state})`,
                'this item was already published. Rejecting published work requires a human decision with its own machinery, not a bookkeeping row.',
            );
        }
        if (!DENIABLE.has(item.current_state)) {
            throw new RejectionError(
                `workflow item "${item.item_id}" is in state ${item.current_state}, which is not under review`,
                'a denial is a gate decision; only a gate1-pending or gate2-pending item can be denied.',
            );
        }

        if (apply) {
            await store.recordTransition({
                schema_version: '1.0.0',
                transition_id: generateUuidV7(),
                run_id: item.origin_run_id,
                item_id: item.item_id,
                item_revision: Number(item.current_revision),
                from_state: item.current_state,
                to_state: 'denied',
                cause: 'decision-denied',
                actor: rejectedBy,
                reason: note ?? `rejected by ${rejectedBy}`,
                occurred_at: now,
                correlation_id: generateUuidV7(),
            });
        }

        return { workItem: item, from: item.current_state, to: 'denied' };
    } finally {
        store.close();
    }
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i += 1; }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db || !args.subject || !args['rejected-by']) {
        console.error('usage: reject-publication.mjs --db <state.db> --subject <item-id-or-semantic-identity> --rejected-by <name>');
        console.error('       [--note <text>] [--apply]');
        process.exit(2);
    }

    let r;
    try {
        r = await recordRejection({
            dbPath: resolve(args.db),
            subjectId: args.subject,
            rejectedBy: args['rejected-by'] === true ? null : args['rejected-by'],
            note: args.note && args.note !== true ? args.note : null,
            apply: Boolean(args.apply),
        });
    } catch (err) {
        if (err instanceof RejectionError) {
            console.error(`REFUSING. ${err.detail}`);
            console.error(`  ${err.fix}`);
            process.exit(1);
        }
        throw err;
    }

    console.log(`${r.workItem.item_id} [${r.workItem.outcome}]`);
    console.log(`  subject      ${args.subject}`);
    console.log(`  lifecycle    ${r.from} -> ${r.to}`);
    console.log(`  rejected by  ${args['rejected-by']}`);

    if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
