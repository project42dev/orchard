#!/usr/bin/env node
// ado-sync.mjs — mirror orchard work items to Azure DevOps User Stories.
//
// Two operations:
//   create  — creates ADO User Stories for work_item rows that have no ado_id
//   update  — updates ADO User Story state to match work_item.state
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
import { execSync } from 'node:child_process';
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
// ADO area path — where User Stories live under the project
// ---------------------------------------------------------------------------
const DEFAULT_AREA_PATH = 'Project 42\\Content Intelligence';

// ---------------------------------------------------------------------------
// ADO config — org and project are required
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
    try {
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 });
        return result.trim();
    } catch (err) {
        const stderr = err.stderr || err.message;
        throw new Error(`${description}: ${stderr}`);
    }
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
        `| **Priority** | ${row.priority ?? '—'} |`,
        `| **First seen** | ${row.first_seen} |`,
        '',
        `This User Story was created automatically by the Orchard content pipeline.`,
        `It tracks a content proposal that needs human review.`,
    ].join('\n');

    // az boards work-item create returns JSON with the created item
    const cmd = [
        'az boards work-item create',
        `--org "https://dev.azure.com/${org}"`,
        `--project "${project}"`,
        '--type "User Story"',
        `--title ${azEscape(title)}`,
        `--description ${azEscape(description)}`,
        `--area "${areaPath}"`,
        '--output json',
    ].join(' ');

    const output = azBoards(cmd, `Create ADO User Story for ${row.id}`);
    const created = JSON.parse(output);
    return created.id;
}

/**
 * Create ADO User Stories for all work_item rows that don't have an ado_id.
 * Updates the ado_id column in the database for each created story.
 */
export function syncCreate({ dbPath, org, project, areaPath, now = new Date().toISOString(), apply = false }) {
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
        throw new Error(`Unknown orchard state "${orchardState}" — cannot map to ADO state`);
    }

    const cmd = [
        'az boards work-item update',
        `--id ${adoId}`,
        `--org "https://dev.azure.com/${org}"`,
        `--state "${adoState}"`,
        '--output json',
    ].join(' ');

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
        result = syncCreate({ dbPath, org, project, areaPath, apply });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
