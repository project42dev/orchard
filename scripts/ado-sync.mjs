#!/usr/bin/env node
// ado-sync.mjs — mirror orchard workflow items to Azure DevOps User Stories.
//
// Two operations:
//   create  — creates ADO User Stories for gate1-approved workflow_item rows
//             that have no recorded ADO external link, records the link, and
//             advances the item to 'ado-linked' (cause ado-reconciled)
//   update  — updates ADO User Story state to match workflow_item.current_state
//
// Both are idempotent. create skips rows that already have an ADO link.
// update only touches rows that have one.
//
// SCHEMA. This tool targets workflow_item and external_link from
// schema/migrations/002, the ONLY tables the deployed database has. The first
// version targeted work_item.ado_id from schema/content-db.sql, which no
// migration ever applies, so it would have failed `no such table` the moment
// it ran against production data. The ADO id lives in external_link
// (provider 'ado', external_key `orchard:<track>:<item_id>:r<revision>`),
// which is the exact binding lib/state-store.mjs getDispatchBinding reads.
//
// Requires: az CLI authenticated, az devops extension installed. (The
// container runtime path replaces this shell-out with a fetch-based ADO REST
// client under the T3 tracker work; this remains the operator's local tool.)
//
// Usage:
//   node scripts/ado-sync.mjs --db <state.db> --org <org> --project <project> --area <areaPath> --operation create [--apply]
//   node scripts/ado-sync.mjs --db <state.db> --org <org> --project <project> --operation update [--apply]

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { generateUuidV7 } from './lib/identity.mjs';

// ---------------------------------------------------------------------------
// ADO state mapping: orchard workflow_item.current_state -> ADO User Story state
//
// ADO User Story states (Agile process):
//   New -> Active -> Resolved -> Closed
//   (Removed is also valid and receives the terminal negatives)
//
// Lifecycle states before the gate (observed/proposed/gate1-pending) are
// deliberately absent: an item the owner has not approved has no ADO story,
// because the work item is created AFTER approval, never before.
// ---------------------------------------------------------------------------
const ADO_STATE_MAP = {
    'gate1-approved': 'New',
    'ado-linked': 'New',
    executing: 'Active',
    'gate2-ready': 'Active',
    'gate2-pending': 'Active',
    'gate2-approved': 'Active',
    'publication-preparing': 'Active',
    'publication-validating': 'Active',
    'publication-pr-open': 'Active',
    'publication-merging': 'Active',
    blocked: 'Active',
    'changes-requested': 'Active',
    'stale-approval': 'Active',
    deferred: 'Active',
    published: 'Resolved',
    'ado-closure-ready': 'Resolved',
    closed: 'Closed',
    denied: 'Removed',
    superseded: 'Removed',
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

export function adoExternalKey(row) {
    return `orchard:${row.track}:${row.item_id}:r${Number(row.current_revision)}`;
}

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

/** The recorded Gate 1 manifest detail for an item, when it exists. */
function manifestDetail(db, itemId, itemRevision) {
    const row = db.prepare(
        `SELECT record_json FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?
          ORDER BY observed_at DESC LIMIT 1`,
    ).get(itemId, itemRevision, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${itemId}`);
    return row ? JSON.parse(row.record_json).manifest_item ?? null : null;
}

// ---------------------------------------------------------------------------
// create: mirror gate1-approved workflow_item rows to ADO User Stories
// ---------------------------------------------------------------------------

/**
 * Create an ADO User Story for a single workflow_item row.
 * Returns the ADO work item id (integer).
 */
function createAdoUserStory(row, org, project, areaPath) {
    const title = `[Orchard] ${row.title}`;
    const description = [
        `## Orchard Workflow Item`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Orchard item** | \`${row.item_id}\` (revision ${row.current_revision}) |`,
        `| **Track** | \`${row.track}\` |`,
        `| **Outcome** | \`${row.outcome}\` |`,
        `| **Surface** | \`${row.surface}\` |`,
        `| **Semantic identity** | \`${row.semantic_identity}\` |`,
        `| **State** | \`${row.current_state}\` |`,
        `| **First seen** | ${row.created_at} |`,
        '',
        `This User Story was created automatically by the Orchard content pipeline.`,
        `It tracks a Gate 1 approved content item through authoring and review.`,
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

    const output = azBoards(cmd, `Create ADO User Story for ${row.item_id}`);
    const created = JSON.parse(output);
    return created.id;
}

/**
 * Create ADO User Stories for all gate1-approved workflow_item rows with no
 * recorded ADO link. Records the external_link row for each created story and
 * advances the item to 'ado-linked', which is the state generate-briefs.mjs
 * authors from.
 */
export async function syncCreate({
    dbPath, org, project, areaPath,
    now = new Date().toISOString(), apply = false,
    createStory = createAdoUserStory,
    actor = 'orchard/ado-sync',
}) {
    const store = openStateStore(dbPath);
    try {
        // Rows that need ADO mirroring: gate1-approved and not yet linked.
        const rows = store.db.prepare(
            `SELECT i.item_id, i.track, i.surface, i.outcome, i.semantic_identity,
                    i.current_state, i.current_revision, i.origin_run_id, i.created_at
               FROM workflow_item i
              WHERE i.current_state = 'gate1-approved'
                AND NOT EXISTS (
                    SELECT 1 FROM external_link l
                     WHERE l.provider = 'ado' AND l.item_id = i.item_id
                       AND l.item_revision = i.current_revision)
              ORDER BY i.created_at, i.item_id`,
        ).all();

        if (rows.length === 0) {
            console.log('All approved workflow items already have ADO links. Nothing to create.');
            return { created: 0, skipped: 0 };
        }

        console.log(`${rows.length} workflow item(s) need ADO User Stories.`);

        let created = 0;
        let skipped = 0;

        for (const row of rows) {
            const detail = manifestDetail(store.db, row.item_id, Number(row.current_revision));
            const enriched = { ...row, title: detail?.title ?? row.semantic_identity };
            try {
                if (apply) {
                    const adoId = createStory(enriched, org, project, areaPath);
                    store.recordExternalLink({
                        link_id: generateUuidV7(),
                        run_id: row.origin_run_id,
                        item_id: row.item_id,
                        item_revision: Number(row.current_revision),
                        provider: 'ado',
                        operation: 'ado-link',
                        external_key: adoExternalKey(row),
                        external_id: String(adoId),
                        linked_at: now,
                    });
                    await store.recordTransition({
                        schema_version: '1.0.0',
                        transition_id: generateUuidV7(),
                        run_id: row.origin_run_id,
                        item_id: row.item_id,
                        item_revision: Number(row.current_revision),
                        from_state: 'gate1-approved',
                        to_state: 'ado-linked',
                        cause: 'ado-reconciled',
                        actor,
                        occurred_at: now,
                        correlation_id: generateUuidV7(),
                    });
                    console.log(`  created ${row.item_id} -> ADO #${adoId}, now ado-linked`);
                    created += 1;
                } else {
                    console.log(`  [DRY RUN] would create: ${row.item_id} (${enriched.title})`);
                    created += 1;
                }
            } catch (err) {
                console.error(`  FAILED ${row.item_id}: ${err.message}`);
                skipped += 1;
            }
        }

        return { created, skipped };
    } finally {
        store.close();
    }
}

// ---------------------------------------------------------------------------
// update: sync orchard state -> ADO state
// ---------------------------------------------------------------------------

/**
 * Update an ADO User Story state to match the orchard workflow item state.
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
 * Sync workflow_item.current_state -> ADO User Story state for all items with
 * a recorded ADO external link. The newest link per item wins, because a
 * superseding revision re-links.
 */
export async function syncUpdate({
    dbPath, org, project,
    apply = false,
    updateStory = updateAdoUserStory,
}) {
    const store = openStateStore(dbPath);
    try {
        const rows = store.db.prepare(
            `SELECT i.item_id, i.current_state, l.external_id AS ado_id
               FROM workflow_item i
               JOIN external_link l ON l.link_id = (
                    SELECT link_id FROM external_link
                     WHERE provider = 'ado' AND item_id = i.item_id
                     ORDER BY item_revision DESC, linked_at DESC LIMIT 1)
              ORDER BY i.updated_at, i.item_id`,
        ).all();

        if (rows.length === 0) {
            console.log('No workflow items with ADO links. Nothing to sync.');
            return { updated: 0, skipped: 0 };
        }

        console.log(`${rows.length} workflow item(s) have ADO links. Checking for state drift...`);

        let updated = 0;
        let skipped = 0;

        for (const row of rows) {
            const adoState = ADO_STATE_MAP[row.current_state];
            if (!adoState) {
                console.log(`  NOTE ${row.item_id}: state "${row.current_state}" has no ADO mapping, skipping`);
                skipped += 1;
                continue;
            }

            try {
                if (apply) {
                    const newState = updateStory(row.ado_id, row.current_state, org, project);
                    console.log(`  updated ${row.item_id} (ADO #${row.ado_id}): -> ${newState}`);
                    updated += 1;
                } else {
                    console.log(`  [DRY RUN] would update: ${row.item_id} (ADO #${row.ado_id}) -> ${adoState}`);
                    updated += 1;
                }
            } catch (err) {
                console.error(`  FAILED ${row.item_id} (ADO #${row.ado_id}): ${err.message}`);
                skipped += 1;
            }
        }

        return { updated, skipped };
    } finally {
        store.close();
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.db || !args.operation) {
        console.error('usage: ado-sync.mjs --db <state.db> --operation create|update [--org <org>] [--project <project>] [--area <areaPath>] [--apply]');
        process.exit(2);
    }

    const dbPath = resolve(args.db);
    const org = args.org || ADO_ORG;
    const project = args.project || ADO_PROJECT;
    const areaPath = args.area || DEFAULT_AREA_PATH;
    const apply = Boolean(args.apply);

    let result;
    if (args.operation === 'create') {
        result = await syncCreate({ dbPath, org, project, areaPath, apply });
        console.log(`\nCreated: ${result.created}, Skipped: ${result.skipped}`);
    } else if (args.operation === 'update') {
        result = await syncUpdate({ dbPath, org, project, apply });
        console.log(`\nUpdated: ${result.updated}, Skipped: ${result.skipped}`);
    } else {
        console.error(`Unknown operation: ${args.operation}. Use "create" or "update".`);
        process.exit(2);
    }

    if (!apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
