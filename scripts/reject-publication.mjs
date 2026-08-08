#!/usr/bin/env node
// Record that a human rejected a proposal.
//
// Companion to record-publication.mjs. Moves the work item to 'rejected'
// rather than 'done', and writes a publication row with disposition='rejected'.

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class RejectionError extends Error {
    constructor(detail, fix) {
        super(detail);
        this.name = 'RejectionError';
        this.detail = detail;
        this.fix = fix;
    }
}

export function recordRejection({
    dbPath,
    subjectId,
    rejectedBy,
    kind = null,
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

    const db = new DatabaseSync(dbPath);
    try {
        const rows = db.prepare('SELECT id, kind, state, title FROM work_item WHERE subject_id = ?')
            .all(subjectId)
            .filter((r) => !kind || r.kind === kind);
        if (!rows.length) {
            throw new RejectionError(
                `no work item with subject id "${subjectId}"${kind ? ` and kind "${kind}"` : ''}`,
                'check the id against the work_item table.',
            );
        }
        if (rows.length > 1) {
            throw new RejectionError(
                `subject "${subjectId}" has ${rows.length} work items (${rows.map((r) => r.kind).join(', ')})`,
                'pass --kind needs-creating or --kind needs-updating to say which one this rejection closes.',
            );
        }
        const item = rows[0];
        if (item.state === 'done') {
            throw new RejectionError(
                `work item "${subjectId}" is already done`,
                'this item was already published. Rejecting a published item requires a human decision.',
            );
        }

        if (apply) {
            db.prepare(
                `INSERT INTO publication
           (subject_id, item_id, run_id, brief_id, proposal_file, proposal_digest,
            disposition, accepted_by, published_at, note)
         VALUES (?, ?, NULL, NULL, NULL, NULL, 'rejected', ?, ?, ?)
         ON CONFLICT (subject_id, run_id, proposal_file) DO UPDATE SET
           disposition = 'rejected',
           accepted_by = excluded.accepted_by,
           published_at = excluded.published_at,
           note = excluded.note`,
            ).run(subjectId, item.id, rejectedBy, now, note ?? `Rejected by ${rejectedBy}`);
            db.prepare(
                "UPDATE work_item SET state = 'rejected', note = ?, updated_at = ? WHERE id = ?",
            ).run(`rejected by ${rejectedBy}`, now, item.id);
        }

        return { workItem: item, from: item.state, to: 'rejected' };
    } finally {
        db.close();
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

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db || !args.subject || !args['rejected-by']) {
        console.error('usage: reject-publication.mjs --db <content.db> --subject <subject-id> --rejected-by <name>');
        console.error('       [--kind needs-creating|needs-updating] [--note <text>] [--apply]');
        process.exit(2);
    }

    let r;
    try {
        r = recordRejection({
            dbPath: resolve(args.db),
            subjectId: args.subject,
            rejectedBy: args['rejected-by'] === true ? null : args['rejected-by'],
            kind: args.kind && args.kind !== true ? args.kind : null,
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

    console.log(`${r.workItem.title}`);
    console.log(`  subject     ${args.subject}`);
    console.log(`  work item   ${r.from} -> ${r.to}`);
    console.log(`  rejected by ${args['rejected-by']}`);

    if (!args.apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
