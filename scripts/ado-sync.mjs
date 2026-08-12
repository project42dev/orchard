#!/usr/bin/env node
import { readFileSync as readGateInput } from 'node:fs';
import { resolve as resolveGateInput } from 'node:path';
import { pathToFileURL as gateFileUrl } from 'node:url';
import {
    adoExternalKey,
    adoWorkItemFields,
    assertCurrentGate1Approval,
    createSqliteExternalLinkPersister,
    reconcileApprovedItem,
} from './lib/ado-reconciliation.mjs';

export {
    adoExternalKey,
    adoWorkItemFields,
    assertCurrentGate1Approval,
    createSqliteExternalLinkPersister,
    reconcileApprovedItem,
};
export { reconcileApprovedItem as syncCreate };

// ado-sync.mjs: mirror Orchard work items to Azure DevOps User Stories.
//
// Two operations:
//   create: creates ADO User Stories for work_item rows that have no ado_id
//   update: updates ADO User Story state to match work_item.state
//
// Both are idempotent. create skips rows that already have an ado_id.
// update only touches rows that have an ado_id.
//
// Requires: az CLI authenticated, az devops extension installed.
//
// Usage:
//   node scripts/ado-sync.mjs --db <content.db> --org <org> --project <project> --area <areaPath> --operation create [--apply]
//   node scripts/ado-sync.mjs --db <content.db> --org <org> --project <project> --operation update [--apply]

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// ADO state mapping: orchard work_item.state -> ADO User Story state
//
// ADO User Story states (Agile process):
//   New -> Active -> Resolved -> Closed
//   (Removed is also valid but we never use it)
//
// Orchard states map as follows:
//   queued        -> New
//   claimed       -> Active
//   in-progress   -> Active
//   blocked       -> Active (with a note)
//   done          -> Closed
//   rejected      -> Removed
// ---------------------------------------------------------------------------
const ADO_STATE_MAP = {
    queued: 'New',
    claimed: 'Active',
    'in-progress': 'Active',
    blocked: 'Active',
    done: 'Closed',
    rejected: 'Removed',
};

// ---------------------------------------------------------------------------
// ADO area path where User Stories live under the project
// ---------------------------------------------------------------------------
const DEFAULT_AREA_PATH = 'Project 42\\Content Intelligence';

// ---------------------------------------------------------------------------
// ADO config; org and project are required
// ---------------------------------------------------------------------------
const ADO_ORG = 'hybridcloudsolutions';
const ADO_PROJECT = 'Project 42';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

/**
 * Run an az boards command and return stdout. Throws on failure.
 */
function azBoards(cmd, description) {
    void cmd;
    throw new Error(`${description}: legacy direct ADO commands are disabled; use an injected ADO adapter`);
}

/**
 * Escape a string for safe use in an az CLI --fields or --query argument.
 * Wraps in double quotes and escapes internal double quotes.
 */
function azEscape(str) {
    return `"${String(str).replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// create: mirror work_item rows to ADO User Stories
// ---------------------------------------------------------------------------

/**
 * Create an ADO User Story for a single work_item row.
 * Returns the ADO work item id (integer).
 */
function createAdoUserStory(row, org, project, areaPath) {
    const title = `[Orchard] ${row.title || row.subject_id}`;
    const description = [
        `## Orchard Work Item`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Orchard ID** | \`${row.id}\` |`,
        `| **Kind** | \`${row.kind}\` |`,
        `| **Subject** | \`${row.subject_id}\` |`,
        `| **Surface** | \`${row.surface}\` |`,
        `| **State** | \`${row.state}\` |`,
        `| **Priority** | ${row.priority ?? 'not set'} |`,
        `| **First seen** | ${row.first_seen} |`,
        '',
        `This User Story was created automatically by the Orchard content pipeline.`,
        `It tracks a content proposal that needs human review.`,
    ].join('\n');

    const cmd = { operation: 'create', organization: org, project, type: 'User Story', title, description, areaPath };

    const output = azBoards(cmd, `Create ADO User Story for ${row.id}`);
    const created = JSON.parse(output);
    return created.id;
}

/**
 * Create ADO User Stories for all work_item rows that don't have an ado_id.
 * Updates the ado_id column in the database for each created story.
 */
function legacySyncCreate({ dbPath, org, project, areaPath, now = new Date().toISOString(), apply = false }) {
    const db = new DatabaseSync(dbPath);

    // Find rows that need ADO mirroring: have no ado_id and aren't in a terminal state
    const rows = db.prepare(
        `SELECT id, kind, subject_id, surface, title, state, priority, first_seen
     FROM work_item
     WHERE ado_id IS NULL
       AND state NOT IN ('rejected', 'done')
     ORDER BY first_seen ASC`
    ).all();

    if (rows.length === 0) {
        console.log('All work items already have ADO IDs. Nothing to create.');
        db.close();
        return { created: 0, skipped: 0 };
    }

    console.log(`${rows.length} work item(s) need ADO User Stories.`);

    const updateStmt = db.prepare(
        'UPDATE work_item SET ado_id = ?, updated_at = ? WHERE id = ?'
    );

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
        try {
            if (apply) {
                const adoId = createAdoUserStory(row, org, project, areaPath);
                updateStmt.run(adoId, now, row.id);
                console.log(`  ✅ ${row.id} -> ADO #${adoId}`);
                created += 1;
            } else {
                console.log(`  [DRY RUN] would create: ${row.id} (${row.title || row.subject_id})`);
                created += 1;
            }
        } catch (err) {
            console.error(`  ❌ ${row.id}: ${err.message}`);
            skipped += 1;
        }
    }

    db.close();
    return { created, skipped };
}

// ---------------------------------------------------------------------------
// update: sync orchard state -> ADO state
// ---------------------------------------------------------------------------

/**
 * Update an ADO User Story state to match the orchard work_item state.
 */
function updateAdoUserStory(adoId, orchardState, org, project) {
    const adoState = ADO_STATE_MAP[orchardState];
    if (!adoState) {
        throw new Error(`Unknown Orchard state "${orchardState}"; cannot map to ADO state`);
    }

    const cmd = { operation: 'update', organization: org, project, id: adoId, state: adoState };
    azBoards(cmd, `Update ADO #${adoId} to ${adoState}`);
    return adoState;
}

/**
 * Sync orchard work_item.state -> ADO User Story state for all rows that have an ado_id.
 */
export function syncUpdate({ dbPath, org, project, now = new Date().toISOString(), apply = false }) {
    const db = new DatabaseSync(dbPath);

    const rows = db.prepare(
        `SELECT id, kind, subject_id, state, ado_id
     FROM work_item
     WHERE ado_id IS NOT NULL
     ORDER BY updated_at ASC`
    ).all();

    if (rows.length === 0) {
        console.log('No work items with ADO IDs. Nothing to sync.');
        db.close();
        return { updated: 0, skipped: 0 };
    }

    console.log(`${rows.length} work item(s) have ADO IDs. Checking for state drift...`);

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
        const adoState = ADO_STATE_MAP[row.state];
        if (!adoState) {
            console.log(`  ⚠️  ${row.id}: unknown orchard state "${row.state}", skipping`);
            skipped += 1;
            continue;
        }

        try {
            if (apply) {
                const newState = updateAdoUserStory(row.ado_id, row.state, org, project);
                console.log(`  ✅ ${row.id} (ADO #${row.ado_id}): -> ${newState}`);
                updated += 1;
            } else {
                console.log(`  [DRY RUN] would update: ${row.id} (ADO #${row.ado_id}) -> ${adoState}`);
                updated += 1;
            }
        } catch (err) {
            console.error(`  ❌ ${row.id} (ADO #${row.ado_id}): ${err.message}`);
            skipped += 1;
        }
    }

    db.close();
    return { updated, skipped };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.db || !args.operation) {
        console.error('usage: ado-sync.mjs --db <content.db> --operation create|update [--org <org>] [--project <project>] [--area <areaPath>] [--apply]');
        process.exit(2);
    }

    const dbPath = resolve(args.db);
    const org = args.org || ADO_ORG;
    const project = args.project || ADO_PROJECT;
    const areaPath = args.area || DEFAULT_AREA_PATH;
    const apply = Boolean(args.apply);

    let result;
    if (args.operation === 'create') {
        result = legacySyncCreate({ dbPath, org, project, areaPath, apply });
        console.log(`\nCreated: ${result.created}, Skipped: ${result.skipped}`);
    } else if (args.operation === 'update') {
        result = syncUpdate({ dbPath, org, project, apply });
        console.log(`\nUpdated: ${result.updated}, Skipped: ${result.skipped}`);
    } else {
        console.error(`Unknown operation: ${args.operation}. Use "create" or "update".`);
        process.exit(2);
    }

    if (!apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

async function gateBoundMain() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input) throw new Error('usage: ado-sync.mjs --input <approved-item.json> [--db <content.db>] [--apply --adapter-module <module>]');
    const input = JSON.parse(readGateInput(resolveGateInput(args.input), 'utf8'));
    let adoAdapter;
    let persistLink;
    if (args.apply) {
        if (!args['adapter-module'] || !args.db) throw new Error('--apply requires --adapter-module and --db');
        ({ adoAdapter } = await import(gateFileUrl(resolveGateInput(args['adapter-module'])).href));
        persistLink = createSqliteExternalLinkPersister({ dbPath: resolveGateInput(args.db) });
    }
    const result = await reconcileApprovedItem({ ...input, adoAdapter, persistLink, apply: Boolean(args.apply) });
    console.log(JSON.stringify(result, null, 2));
    if (!args.apply) console.error('DRY RUN. No ADO or local state writes performed.');
}

if (import.meta.url === gateFileUrl(process.argv[1]).href) {
    gateBoundMain().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
