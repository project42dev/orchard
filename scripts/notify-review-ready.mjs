#!/usr/bin/env node
// notify-review-ready.mjs — queries content.db for proposals awaiting human
// review and creates a GitHub Issue in project42dev/orchard with a summary.
//
// Usage:
//   node scripts/notify-review-ready.mjs --db <content.db> --proposals <dir> [--dry-run]
//
// The script reads the proposal documents emitted by Invoke-Project42Delivery.ps1
// and cross-references them with the work_item table to produce a review-ready
// summary. It creates ONE issue per run, listing all proposals that are ready.
//
// Idempotent: if an issue already exists for a given proposal set (matched by
// proposal digests), it is not duplicated. The script records the issue number
// it created so the next run can update rather than duplicate.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// helpers

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function digest(str) {
    // Simple stable hash for dedup — not cryptographic, just collision-resistant
    // enough to tell two different proposal sets apart.
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}

// ---------------------------------------------------------------------------
// proposal reader

function readProposals(proposalDir) {
    /** Returns an array of { path, proposal, packet } for every proposal in the
     *  directory that has a matching packet file. */
    const proposals = [];
    if (!existsSync(proposalDir)) return proposals;

    for (const f of readdirSync(proposalDir)) {
        if (!f.startsWith('proposal-') || !f.endsWith('.json')) continue;
        const proposalPath = resolve(proposalDir, f);
        const proposal = readJson(proposalPath);

        // The packet is named in the proposal
        const packetFile = f.replace('proposal-', 'packet-');
        const packetPath = resolve(proposalDir, packetFile);
        if (!existsSync(packetPath)) {
            console.warn(`  WARN: proposal ${f} references packet ${packetFile} but it is missing`);
            continue;
        }
        const packet = readJson(packetPath);

        proposals.push({ path: proposalPath, proposal, packet });
    }
    return proposals;
}

// ---------------------------------------------------------------------------
// work item cross-reference

function matchToWorkItems(db, proposals) {
    /** Cross-references proposals against the work_item table. Returns an array
     *  of { proposal, packet, workItem } where workItem is the matching row or
     *  null if unmatched. */
    const results = [];

    const stmt = db.prepare(
        'SELECT id, subject_id, kind, state, first_seen, updated_at FROM work_item WHERE id = ?'
    );

    for (const p of proposals) {
        // The proposal's packet.id is "packet-{slug}". The slug encodes the work
        // item id. Extract it: packet-{workItemId}-{runIdPrefix}
        const packetId = p.packet.id;
        // Try to find a work item whose id appears in the packet id
        let workItem = null;

        // The work item id is embedded in the packet id. Try direct match first.
        const allItems = db.prepare('SELECT id, subject_id, kind, state, first_seen, updated_at FROM work_item').all();
        for (const row of allItems) {
            if (packetId.includes(row.id)) {
                workItem = row;
                break;
            }
        }

        results.push({ ...p, workItem });
    }

    return results;
}

// ---------------------------------------------------------------------------
// issue body builder

function buildIssueBody(matched) {
    /** Builds a markdown issue body summarizing all proposals ready for review. */

    const lines = [
        '## Orchard proposals ready for review',
        '',
        `**${matched.length} proposal(s)** emitted by the delivery ensemble and awaiting human decision.`,
        '',
        '---',
        '',
    ];

    for (const m of matched) {
        const p = m.proposal;
        const pkt = m.packet;
        const wi = m.workItem;

        lines.push(`### ${p.id}`);
        lines.push('');
        lines.push('| Field | Value |');
        lines.push('|-------|-------|');
        lines.push(`| Disposition | \`${pkt.disposition}\` |`);
        lines.push(`| Packet digest | \`${p.packetDigest}\` |`);
        lines.push(`| Proposal digest | \`${p.proposalDigest}\` |`);

        if (wi) {
            lines.push(`| Work item | \`${wi.id}\` (${wi.kind}, ${wi.state}) |`);
            if (wi.subject_id) lines.push(`| Subject | \`${wi.subject_id}\` |`);
        } else {
            lines.push('| Work item | *not matched* |');
        }

        // Targets
        if (p.targets && p.targets.length > 0) {
            lines.push('| Targets | ' + p.targets.map(t => `\`${t.repo || t.repository}/${t.path || ''}\``).join(', ') + ' |');
        }

        // Model stages summary
        if (p.modelStages && p.modelStages.length > 0) {
            lines.push('');
            lines.push('**Model stages:**');
            lines.push('');
            for (const stage of p.modelStages) {
                const statusIcon = stage.status === 'passed' ? '✅' : stage.status === 'failed' ? '❌' : '⚠️';
                lines.push(`- ${statusIcon} **${stage.stage}** (${stage.providerFamily}/${stage.deploymentAlias}): ${stage.status}`);
            }
        }

        // Unresolved conflicts
        if (p.unresolvedConflicts && p.unresolvedConflicts.length > 0) {
            lines.push('');
            lines.push('**⚠️ Unresolved conflicts:**');
            for (const c of p.unresolvedConflicts) {
                lines.push(`- ${c}`);
            }
        }

        // Gates
        if (p.deterministicGates && p.deterministicGates.length > 0) {
            lines.push('');
            lines.push('<details><summary>Deterministic gates</summary>');
            lines.push('');
            for (const g of p.deterministicGates) {
                const icon = g.status === 'passed' ? '✅' : '❌';
                lines.push(`- ${icon} **${g.id}**: ${g.evidenceRef}`);
            }
            lines.push('');
            lines.push('</details>');
        }

        lines.push('');
        lines.push('---');
        lines.push('');
    }

    // Review procedure
    lines.push('## Review procedure');
    lines.push('');
    lines.push('See [`docs/runbooks/content-proposal-review.md`](https://github.com/project42dev/orchard/blob/main/docs/runbooks/content-proposal-review.md) for the 9-point human review checklist.');
    lines.push('');
    lines.push('1. Read the proposal and its packet');
    lines.push('2. Verify the deterministic gates');
    lines.push('3. Review the model stages for any red flags');
    lines.push('4. Decide: accept, reject, or request revision');
    lines.push('5. Type your decision and click **Close with comment** (NOT just Comment):');
    lines.push('   - **`approved`** (or `LGTM`, `accept`, `ship it`) to publish');
    lines.push('   - **`rejected`** (or `denied`, `decline`) to reject');
    lines.push('');
    lines.push('The issue must be **closed** for the workflow to fire.');
    lines.push('Closing the issue triggers the `orchard-human-review` workflow');
    lines.push('which records your decision automatically. You never touch a terminal.');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// issue tracker (file-based, no GitHub API dependency)

function readIssueTracker(trackerPath) {
    /** Reads the issue tracker file. Returns { issues: [] }. */
    if (!existsSync(trackerPath)) return { issues: [] };
    try {
        return readJson(trackerPath);
    } catch {
        return { issues: [] };
    }
}

function writeIssueTracker(trackerPath, tracker) {
    writeFileSync(trackerPath, JSON.stringify(tracker, null, 2) + '\n', 'utf-8');
}

function findExistingIssue(tracker, proposalDigests) {
    /** Returns an existing issue entry if one matches this exact set of proposal
     *  digests, or null. */
    const setDigest = digest(proposalDigests.sort().join(','));
    return tracker.issues.find(i => i.proposalSetDigest === setDigest) || null;
}

// ---------------------------------------------------------------------------
// main

function main() {
    const args = parseArgs({
        args: process.argv.slice(2),
        options: {
            db: { type: 'string' },
            proposals: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            'tracker': { type: 'string' },  // path to issue-tracker.json
        },
    });

    if (!args.values.db || !args.values.proposals) {
        console.error('usage: notify-review-ready.mjs --db <content.db> --proposals <dir> [--dry-run] [--tracker <file>]');
        process.exit(2);
    }

    const dbPath = resolve(args.values.db);
    const proposalDir = resolve(args.values.proposals);
    const trackerPath = args.values.tracker
        ? resolve(args.values.tracker)
        : resolve(proposalDir, '..', 'issue-tracker.json');
    const dryRun = args.values['dry-run'];

    if (!existsSync(dbPath)) {
        console.error(`database not found: ${dbPath}`);
        process.exit(1);
    }

    // 1. Read proposals
    const proposals = readProposals(proposalDir);
    if (proposals.length === 0) {
        console.log('No proposals found. Nothing to notify.');
        process.exit(0);
    }

    // 2. Filter to proposals that need human review (disposition is not 'blocked')
    const reviewReady = proposals.filter(p => p.packet.disposition !== 'blocked');
    if (reviewReady.length === 0) {
        console.log(`${proposals.length} proposal(s) found, but none are ready for review (all blocked).`);
        process.exit(0);
    }

    console.log(`${reviewReady.length} of ${proposals.length} proposal(s) ready for review.`);

    // 3. Open the database
    const db = new DatabaseSync(dbPath);

    // 4. Cross-reference with work items
    const matched = matchToWorkItems(db, reviewReady);
    db.close();

    // 5. Check for existing issue
    const tracker = readIssueTracker(trackerPath);
    const proposalDigests = matched.map(m => m.proposal.proposalDigest);
    const existing = findExistingIssue(tracker, proposalDigests);

    if (existing) {
        console.log(`Issue already exists for this proposal set: #${existing.issueNumber || existing.id} (${existing.url || 'no URL recorded'})`);
        console.log('Nothing to do. Delete the tracker entry to force a new issue.');
        process.exit(0);
    }

    // 6. Build the issue body
    const body = buildIssueBody(matched);
    const title = `[Orchard] ${matched.length} proposal(s) ready for review`;

    if (dryRun) {
        console.log('\n=== DRY RUN — would create issue ===');
        console.log(`Title: ${title}`);
        console.log(`\n${body}`);
        console.log('\n=== end dry run ===');
        process.exit(0);
    }

    // 7. Create the GitHub issue via gh CLI
    // This requires gh to be authenticated. The scheduled workflow provides this.
    try {
        // Write body to temp file — gh CLI on Windows doesn't reliably accept
        // stdin via execSync input.
        const tmpBody = resolve(proposalDir, '..', '.orchard-issue-body.tmp');
        writeFileSync(tmpBody, body, 'utf-8');
        const issueUrl = execSync(
            `gh issue create --repo project42dev/orchard --title "${title}" --body-file "${tmpBody}"`,
            { encoding: 'utf-8' }
        ).trim();

        console.log(`Issue created: ${issueUrl}`);

        // Extract issue number from URL
        const match = issueUrl.match(/\/issues\/(\d+)$/);
        const issueNumber = match ? parseInt(match[1], 10) : null;

        // 8. Record in tracker
        tracker.issues.push({
            proposalSetDigest: digest(proposalDigests.sort().join(',')),
            proposalDigests,
            issueNumber,
            url: issueUrl,
            createdAt: new Date().toISOString(),
            title,
        });
        writeIssueTracker(trackerPath, tracker);
        console.log(`Tracker updated: ${trackerPath}`);
    } catch (err) {
        console.error('Failed to create GitHub issue via gh CLI.');
        console.error('Error:', err.message);
        console.error('');
        console.error('The issue body is printed below. Create it manually or ensure gh is authenticated.');
        console.error('');
        console.error(`Title: ${title}`);
        console.error(body);
        process.exit(1);
    }
}

// Top-level call
main();
