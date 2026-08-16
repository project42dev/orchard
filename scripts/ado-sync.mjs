#!/usr/bin/env node
// ado-sync.mjs - the tracker reconciler. Mirrors orchard workflow items to
// Azure DevOps User Stories and keeps them current for the life of the item.
//
// Two operations:
//   create  - creates one ADO User Story per gate1-approved workflow_item row
//             that has no recorded ADO external link, records the link with
//             the exact Gate 1 binding, advances the item to 'ado-linked'
//             (cause ado-reconciled), and writes the ADO id and URL back onto
//             the gate issue that carried the approval
//   update  - moves each linked ADO User Story to the state the workflow item
//             is in now, commenting when the state actually changes
//
// Both are idempotent. The external_link row is the duplicate guard for
// create: an item that has one is never created again, so a re-run creates
// nothing. update reads the work item's current state first and touches
// nothing that already matches.
//
// SCHEMA. This targets workflow_item and external_link from
// schema/migrations/002, the ONLY tables the deployed database has. The ADO
// id lives in external_link (provider 'ado', external_key
// `orchard:<track>:<item_id>:r<revision>`), which is the exact binding
// lib/state-store.mjs getDispatchBinding reads.
//
// TRANSPORT. fetch against the ADO REST API via lib/ado-client.mjs. Never a
// shell out: `az` is not in the production image, and the first version of
// this file would have died on its first line inside the container.
//
// CREDENTIAL. The job's managed identity, registered as a service principal
// user of the ADO organisation. Never a PAT. See lib/ado-client.mjs.
//
// A TRACKER FAILURE NEVER FAILS THE RUN. Every ADO and GitHub call is wrapped:
// a 4xx, a 5xx or a network fault logs the row and continues, and
// runTrackerSyncForRun never throws at all. The board lagging the lifecycle
// is recoverable on the next run; a run failed by its own bookkeeping is not.
//
// Usage:
//   node scripts/ado-sync.mjs --db <state.db> --operation create [--org <org>] [--project <project>] [--area <areaPath>] [--apply]
//   node scripts/ado-sync.mjs --db <state.db> --operation update [--org <org>] [--project <project>] [--apply]

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from './lib/state-store.mjs';
import { GATE_MANIFEST_REFERENCE_PREFIX } from './lib/gate-queue.mjs';
import { generateUuidV7 } from './lib/identity.mjs';
import { ADO_ORGANIZATION, ADO_PROJECT, PARENT_EPIC_BY_TRACK, createAdoRestClient, workItemUrl } from './lib/ado-client.mjs';
import { commentOnIssue } from './lib/github-issues.mjs';

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
export const ADO_STATE_MAP = {
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

// Where User Stories live under the project.
const DEFAULT_AREA_PATH = 'Project 42\\Content Intelligence';

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

/** The recorded Gate 1 manifest detail for an item, when it exists. */
function manifestDetail(db, itemId, itemRevision) {
    const row = db.prepare(
        `SELECT record_json FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?
          ORDER BY observed_at DESC LIMIT 1`,
    ).get(itemId, itemRevision, `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${itemId}`);
    return row ? JSON.parse(row.record_json).manifest_item ?? null : null;
}

/** The Gate 1 approval this item reached gate1-approved through. */
function gate1Approval(db, itemId, itemRevision) {
    const row = db.prepare(
        `SELECT event_id, run_id, digest, source_repository, source_issue_number, source_comment_id
           FROM decision_event
          WHERE item_id = ? AND item_revision = ? AND gate = 'gate-1' AND decision = 'approve'
          ORDER BY occurred_at DESC LIMIT 1`,
    ).get(itemId, itemRevision);
    return row ?? null;
}

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The work item description, built so the item stands alone on the board:
 * subject, the finding and why it scored as it did, the score and formula
 * version, the Orchard identifiers, the evidence, the track, and the links
 * back to the gate issue and the approving comment.
 */
export function workItemDescription(row, detail, decision) {
    const issueUrl = decision
        ? `https://github.com/${decision.source_repository}/issues/${decision.source_issue_number}`
        : null;
    const commentUrl = decision
        ? `${issueUrl}#issuecomment-${decision.source_comment_id}`
        : null;
    const evidence = (detail?.evidence_refs ?? []).slice(0, 20).map((ref) => `<li>${escapeHtml(ref)}</li>`).join('');
    const parts = [
        `<p><strong>${escapeHtml(detail?.title ?? row.semantic_identity)}</strong></p>`,
        detail?.rationale ? `<p>${escapeHtml(detail.rationale)}</p>` : '',
        '<table>',
        `<tr><td><strong>Score</strong></td><td>${escapeHtml(detail?.score?.value ?? 'unrecorded')} (formula ${escapeHtml(detail?.score?.formula_version ?? 'unrecorded')})</td></tr>`,
        `<tr><td><strong>Orchard item</strong></td><td><code>${escapeHtml(row.item_id)}</code> revision ${Number(row.current_revision)}</td></tr>`,
        `<tr><td><strong>Semantic identity</strong></td><td><code>${escapeHtml(row.semantic_identity)}</code></td></tr>`,
        `<tr><td><strong>Track</strong></td><td>${escapeHtml(row.track)}</td></tr>`,
        `<tr><td><strong>Surface</strong></td><td>${escapeHtml(row.surface)}</td></tr>`,
        `<tr><td><strong>Outcome</strong></td><td>${escapeHtml(row.outcome)}</td></tr>`,
        detail?.target ? `<tr><td><strong>Proposed target</strong></td><td><code>${escapeHtml(detail.target.repository)}/${escapeHtml(detail.target.path)}</code></td></tr>` : '',
        issueUrl ? `<tr><td><strong>Gate issue</strong></td><td><a href="${issueUrl}">${issueUrl}</a></td></tr>` : '',
        commentUrl ? `<tr><td><strong>Approving comment</strong></td><td><a href="${commentUrl}">${commentUrl}</a></td></tr>` : '',
        '</table>',
        evidence ? `<p><strong>Evidence</strong></p><ul>${evidence}</ul>` : '',
        '<p>Created automatically by the Orchard content pipeline on Gate 1 approval. Its state follows the Orchard item.</p>',
    ];
    return parts.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// create: mirror gate1-approved workflow_item rows to ADO User Stories
// ---------------------------------------------------------------------------

/**
 * Create ADO User Stories for all gate1-approved workflow_item rows with no
 * recorded ADO link. Records the external_link row (carrying the exact Gate 1
 * binding getDispatchBinding verifies), advances the item to 'ado-linked',
 * and comments the ADO id and URL onto the gate issue that approved it.
 *
 * Idempotent: the external_link row is the duplicate guard. A re-run finds
 * the link and creates nothing.
 */
export async function syncCreate({
    dbPath, client, areaPath = DEFAULT_AREA_PATH,
    now = new Date().toISOString(), apply = false,
    actor = 'orchard/ado-sync',
    githubToken = null, fetchImpl = fetch,
    log = (level, event, detail) => console[level === 'warn' ? 'error' : 'log'](`${event} ${JSON.stringify(detail ?? {})}`),
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
            log('info', 'tracker.create.none', { effect: 'every approved item already has its ADO link' });
            return { created: 0, skipped: 0 };
        }

        log('info', 'tracker.create.pending', { count: rows.length });

        let created = 0;
        let skipped = 0;

        for (const row of rows) {
            const revision = Number(row.current_revision);
            try {
                const detail = manifestDetail(store.db, row.item_id, revision);
                const decision = gate1Approval(store.db, row.item_id, revision);
                if (!decision) {
                    // gate1-approved is only reachable through a recorded
                    // approval, so this is corruption worth naming, not a row
                    // to guess about.
                    skipped += 1;
                    log('warn', 'tracker.create.no-approval', { item: row.item_id, effect: 'no work item created; the approval record is missing' });
                    continue;
                }
                const revisionRow = store.db.prepare(
                    'SELECT target_repository, target_path, proposal_digest FROM item_revision WHERE item_id = ? AND item_revision = ?',
                ).get(row.item_id, revision);
                const externalKey = adoExternalKey(row);
                const title = `[Orchard] ${detail?.title ?? row.semantic_identity}`.slice(0, 255);

                if (!apply) {
                    log('info', 'tracker.create.dry-run', { item: row.item_id, title });
                    created += 1;
                    continue;
                }

                const workItem = await client.createWorkItem({
                    type: 'User Story',
                    title,
                    description: workItemDescription(row, detail, decision),
                    areaPath,
                    parentId: PARENT_EPIC_BY_TRACK[row.track] ?? null,
                    tags: `orchard; ${row.track}`,
                });

                // The link record carries the exact Gate 1 binding, which is
                // what getDispatchBinding verifies before anything executes.
                store.recordExternalLink({
                    link_id: generateUuidV7(),
                    run_id: decision.run_id,
                    item_id: row.item_id,
                    item_revision: revision,
                    provider: 'ado',
                    operation: 'ado-link',
                    external_key: externalKey,
                    external_id: String(workItem.id),
                    linked_at: now,
                    binding: {
                        run_id: decision.run_id,
                        track: row.track,
                        item_id: row.item_id,
                        item_revision: revision,
                        proposal_digest: decision.digest,
                        gate1_decision_event_id: decision.event_id,
                        ado_external_key: externalKey,
                        ado_work_item_id: workItem.id,
                        target: { repository: revisionRow.target_repository, path: revisionRow.target_path },
                    },
                });
                await store.recordTransition({
                    schema_version: '1.0.0',
                    transition_id: generateUuidV7(),
                    run_id: decision.run_id,
                    item_id: row.item_id,
                    item_revision: revision,
                    from_state: 'gate1-approved',
                    to_state: 'ado-linked',
                    cause: 'ado-reconciled',
                    actor,
                    occurred_at: now,
                    correlation_id: generateUuidV7(),
                });
                created += 1;
                log('info', 'tracker.create.linked', { item: row.item_id, adoId: workItem.id, state: 'ado-linked' });

                // Both sides link: the gate issue that carried the approval
                // gets the ADO id and URL. Best effort, separately wrapped:
                // a failed comment must not undo or hide a created work item.
                if (githubToken) {
                    try {
                        await commentOnIssue({
                            repo: decision.source_repository,
                            issueNumber: decision.source_issue_number,
                            body: `Approved item \`${row.item_id}\` is now tracked as [AB#${workItem.id}](${workItem.url}).`,
                            token: githubToken,
                            fetchImpl,
                        });
                        log('info', 'tracker.create.issue-linked', { item: row.item_id, issue: decision.source_issue_number, adoId: workItem.id });
                    } catch (error) {
                        log('warn', 'tracker.create.issue-link-failed', {
                            item: row.item_id, issue: decision.source_issue_number,
                            status: error.status ?? null, reason: error.message,
                            effect: 'the work item exists and is linked in the database; only the issue comment is missing',
                        });
                    }
                } else {
                    log('info', 'tracker.create.issue-link-skipped', { item: row.item_id, effect: 'no GitHub token; the issue was not commented' });
                }
            } catch (error) {
                skipped += 1;
                log('warn', 'tracker.create.failed', {
                    item: row.item_id, status: error.status ?? null, reason: error.message,
                    effect: 'the item stays gate1-approved; the next run retries',
                });
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

/** What the state-change comment says, so the board explains itself. */
export function transitionComment(orchardState, target) {
    if (orchardState === 'published') {
        return `Orchard published this item${target ? ` to <code>${escapeHtml(target.repository)}/${escapeHtml(target.path)}</code>` : ''}.`;
    }
    if (orchardState === 'denied') return 'The owner denied this item at a gate. It will not proceed.';
    if (orchardState === 'superseded') return 'A newer Orchard item supersedes this one.';
    if (orchardState === 'blocked') return 'Orchard blocked this item (policy, integrity, security or cost). It is not silently Active: it needs attention.';
    if (orchardState === 'changes-requested') return 'The owner requested changes at a gate. The item returns for rework.';
    if (orchardState === 'closed') return 'Orchard closed this item with a complete closure evidence packet.';
    return `Orchard state is now <code>${escapeHtml(orchardState)}</code>.`;
}

/**
 * Sync workflow_item.current_state -> ADO User Story state for all items with
 * a recorded ADO external link. The newest link per item wins, because a
 * superseding revision re-links. Reads the work item first and only writes on
 * drift, so a re-run with nothing to do does nothing.
 */
export async function syncUpdate({
    dbPath, client, apply = false,
    log = (level, event, detail) => console[level === 'warn' ? 'error' : 'log'](`${event} ${JSON.stringify(detail ?? {})}`),
}) {
    const store = openStateStore(dbPath);
    try {
        const rows = store.db.prepare(
            `SELECT i.item_id, i.current_state, l.external_id AS ado_id,
                    r.target_repository, r.target_path
               FROM workflow_item i
               JOIN external_link l ON l.link_id = (
                    SELECT link_id FROM external_link
                     WHERE provider = 'ado' AND item_id = i.item_id
                     ORDER BY item_revision DESC, linked_at DESC LIMIT 1)
               LEFT JOIN item_revision r ON r.item_id = i.item_id AND r.item_revision = i.current_revision
              ORDER BY i.updated_at, i.item_id`,
        ).all();

        if (rows.length === 0) {
            log('info', 'tracker.update.none', { effect: 'no workflow item has an ADO link yet' });
            return { updated: 0, unchanged: 0, skipped: 0 };
        }

        let updated = 0;
        let unchanged = 0;
        let skipped = 0;

        for (const row of rows) {
            const adoState = ADO_STATE_MAP[row.current_state];
            if (!adoState) {
                skipped += 1;
                log('warn', 'tracker.update.unmapped', { item: row.item_id, state: row.current_state, effect: 'no ADO state mapping; the work item is untouched' });
                continue;
            }
            try {
                const current = await client.getWorkItem(row.ado_id);
                if (current.state === adoState) {
                    unchanged += 1;
                    continue;
                }
                if (!apply) {
                    updated += 1;
                    log('info', 'tracker.update.dry-run', { item: row.item_id, adoId: row.ado_id, from: current.state, to: adoState });
                    continue;
                }
                await client.updateWorkItemState(row.ado_id, adoState);
                // The comment explains the move in Orchard's own vocabulary,
                // because 'Active' alone does not say whether work started or
                // rework was ordered. Only on a real change, never per run.
                try {
                    const target = row.target_repository ? { repository: row.target_repository, path: row.target_path } : null;
                    await client.addComment(row.ado_id, transitionComment(row.current_state, target));
                } catch (error) {
                    log('warn', 'tracker.update.comment-failed', { item: row.item_id, adoId: row.ado_id, status: error.status ?? null, reason: error.message });
                }
                updated += 1;
                log('info', 'tracker.update.moved', { item: row.item_id, adoId: row.ado_id, from: current.state, to: adoState, orchardState: row.current_state });
            } catch (error) {
                skipped += 1;
                log('warn', 'tracker.update.failed', {
                    item: row.item_id, adoId: row.ado_id, status: error.status ?? null, reason: error.message,
                    effect: 'the board lags the lifecycle for this item; the next run retries',
                });
            }
        }

        return { updated, unchanged, skipped };
    } finally {
        store.close();
    }
}

// ---------------------------------------------------------------------------
// The runtime entry point. NEVER throws: a tracker failure must never fail
// the run, exactly as announceGatesForRun and applyGateDecisionsForRun hold.
// ---------------------------------------------------------------------------

export async function runTrackerSyncForRun({ stateDbPath, log, env = process.env, client, githubToken = null, fetchImpl = fetch }) {
    if (env.ORCHARD_ADO_SYNC === 'disabled') {
        log('info', 'tracker.sync.disabled', { effect: 'no work item is created or moved' });
        return null;
    }
    try {
        const adoClient = client ?? createAdoRestClient({
            organization: env.ORCHARD_ADO_ORGANIZATION || ADO_ORGANIZATION,
            project: env.ORCHARD_ADO_PROJECT || ADO_PROJECT,
            env,
        });
        const created = await syncCreate({ dbPath: stateDbPath, client: adoClient, apply: true, githubToken, fetchImpl, log });
        const updated = await syncUpdate({ dbPath: stateDbPath, client: adoClient, apply: true, log });
        log('info', 'tracker.sync.finished', { ...created, ...updated });
        return { ...created, ...updated };
    } catch (error) {
        log('warn', 'tracker.sync.failed', {
            status: error.status ?? null, reason: error.message,
            effect: 'the run is unaffected; the board lags the lifecycle until the next run',
        });
        return null;
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
    const apply = Boolean(args.apply);
    const client = createAdoRestClient({
        organization: args.org || ADO_ORGANIZATION,
        project: args.project || ADO_PROJECT,
    });

    let result;
    if (args.operation === 'create') {
        result = await syncCreate({
            dbPath, client, areaPath: args.area || DEFAULT_AREA_PATH, apply,
            githubToken: process.env.ORCHARD_GATE_GITHUB_TOKEN ?? null,
        });
        console.log(`\nCreated: ${result.created}, Skipped: ${result.skipped}`);
    } else if (args.operation === 'update') {
        result = await syncUpdate({ dbPath, client, apply });
        console.log(`\nUpdated: ${result.updated}, Unchanged: ${result.unchanged}, Skipped: ${result.skipped}`);
    } else {
        console.error(`Unknown operation: ${args.operation}. Use "create" or "update".`);
        process.exit(2);
    }

    if (!apply) console.log('\nDRY RUN. Nothing written. Pass --apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
