#!/usr/bin/env node
// notify-review-ready.mjs: queries content.db for proposals awaiting human
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
// The SAME digest function the gate checks against, never a second copy of the
// formula. This issue prints the command the owner will paste; if the digest
// here were computed any differently from the one gate2-review.mjs recomputes
// from the bytes on disk, every printed command would be refused as stale and
// the issue would be instructing the owner to fail.
import { artifactDigest } from './gate2-review.mjs';
import { MAX_GATE_BATCH_SIZE as MAX_DECISIONS_PER_COMMENT } from './lib/gates.mjs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// helpers

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function digest(str) {
    // Simple stable hash for dedup, not cryptographic, just collision-resistant
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
     *  of { proposal, packet, workItem, contentPath } where workItem is the
     *  matching row or null if unmatched, and contentPath is the path to the
     *  final content file if found. */
    const results = [];

    const allItems = db.prepare(
        'SELECT id, subject_id, title, kind, state, ado_id FROM work_item'
    ).all();

    for (const p of proposals) {
        const packetId = p.packet.id;
        let workItem = null;

        // Packet ID format: packet-p42-create-<subject>-<runIdPrefix>
        // or: packet-p42-update-<subject>-<runIdPrefix>
        // Work item ID format: create:<subject> or update:<subject>
        // Extract the subject by stripping "packet-p42-" prefix and the trailing "-<hash>"
        const subjectMatch = packetId.match(/^packet-p42-(?:create|update)-(.+?)-[0-9a-f]{8}$/);
        if (subjectMatch) {
            const subject = subjectMatch[1];
            // Try both create: and update: prefixes
            const wiIdCreate = `create:${subject}`;
            const wiIdUpdate = `update:${subject}`;
            workItem = allItems.find(row => row.id === wiIdCreate || row.id === wiIdUpdate) || null;
        }

        results.push({ ...p, workItem });
    }

    return results;
}

// ---------------------------------------------------------------------------
// issue body builder

/**
 * The exact Gate 2 approve command for one proposal, bound to its bytes.
 *
 * The digest is read from the proposal file at the moment the issue is written,
 * which is the same file and the same bytes gate2-review.mjs re-reads when the
 * comment arrives. If the artifact is rewritten between the two, the digests
 * differ and the approval is refused -- which is the whole point, not a defect.
 */
export function approveCommandFor(entry) {
    return `/orchard gate2 approve item=${entry.proposal.id} digest=${artifactDigest(readFileSync(entry.path))}`;
}

export function buildIssueBody(matched, localProposalsDir, engineRunId) {
    /** Builds a markdown issue body summarizing all proposals ready for review.
     *  When localProposalsDir is provided, includes the actual proposal content
     *  in collapsible sections so reviewers can read it directly in the issue.
     *  engineRunId is the container-generated run ID (GUID) from the ACA
     *  engine job that produced these proposals, embedded as an HTML
     *  comment so the human-review workflow can find the right artifact. */

    const lines = [
        '## Orchard proposals ready for review',
        '',
        '> [!IMPORTANT]',
        // This used to read "comment Approved or Denied". It was telling the
        // owner to do the one thing the gate refuses: gate2-review.mjs has
        // refused a bare "Approved" since ADR-0025, because a bare word
        // approves nothing in particular -- not an item, not a revision, not
        // any particular bytes. An issue whose instructions the engine will
        // reject is worse than an issue with no instructions at all.
        '> @kristopherjturner: approve or reject each proposal below with the command printed in its section.',
        '> A bare `Approved` is NOT a decision and will be refused: an approval has to name the item and the exact artifact digest it approves.',
        '',
        '> [!TIP]',
        `> **You can decide several proposals in one comment.** Put each command on its own line, up to ${MAX_DECISIONS_PER_COMMENT} of them, all of the same kind (all approvals, or all denials).`,
        '> Every line is checked on its own against the artifact it names. If any line is wrong, NONE of them is applied and the reply says which line and why, so you fix that line and post the comment again.',
        '',
        `**${matched.length} proposal(s)** emitted by the delivery ensemble and awaiting human decision.`,
        '',
        '---',
        '',
    ];

    // Embed engine run ID for artifact download by human-review workflow
    if (engineRunId) {
        lines.push(`<!-- orchard-engine-run-id: ${engineRunId} -->`);
        lines.push('');
    }

    for (const m of matched) {
        const p = m.proposal;
        const pkt = m.packet;
        const wi = m.workItem;

        // Section header: human-readable title
        const heading = wi?.title || p.subjectId || p.id;
        lines.push(`### ${heading}`);
        lines.push('');

        // ---- KEY LINKS ----
        lines.push('| | |');
        lines.push('|---|---|');

        // ADO link
        if (wi?.ado_id) {
            const adoUrl = `https://dev.azure.com/hybridcloudsolutions/Project%2042/_workitems/edit/${wi.ado_id}`;
            lines.push(`| **ADO** | [User Story #${wi.ado_id}](${adoUrl}) |`);
        } else {
            lines.push('| **ADO** | *not yet mirrored* |');
        }

        // Content link: anchor to the inline collapsible section below
        const slug = (wi?.subject_id || p.id || '').replace(/[^a-z0-9-]/gi, '-').substring(0, 60);
        lines.push(`| **Content** | [View inline below](#proposal-content-${slug}) |`);

        lines.push('');

        // ---- DETAILS TABLE ----
        lines.push('| Field | Value |');
        lines.push('|-------|-------|');
        lines.push(`| Packet ID | \`${p.id}\` |`);
        lines.push(`| Disposition | \`${pkt.disposition}\` |`);

        if (wi) {
            lines.push(`| Work item | \`${wi.id}\` (${wi.kind}, ${wi.state}) |`);
            if (wi.subject_id) lines.push(`| Subject | \`${wi.subject_id}\` |`);
        } else {
            lines.push('| Work item | *not matched* |');
        }

        // Targets
        if (p.targets && p.targets.length > 0) {
            lines.push('| Targets | ' + p.targets.map(t => `\`${t.repo || t.repository}/${(t.pathPrefixes || [t.path]).join(', ')}\``).join('<br>') + ' |');
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

        // ---- PROPOSAL CONTENT (collapsible inline) ----
        if (localProposalsDir && existsSync(localProposalsDir)) {
            const content = findProposalContentText(p, localProposalsDir);
            if (content) {
                lines.push('');
                lines.push(`<a name="proposal-content-${slug}"></a>`);
                lines.push('<details><summary>📄 Proposal content (click to expand)</summary>');
                lines.push('');
                const maxContent = 2000;
                const truncated = content.length > maxContent
                    ? content.slice(0, maxContent) + '\n\n... (truncated, full content in delivery/private/local-proposals/)'
                    : content;
                lines.push(truncated);
                lines.push('');
                lines.push('</details>');
            }
        }

        // ---- THE DECISION COMMAND ----
        // Printed for every proposal, right where the reader finishes reading
        // it, so deciding never means going and constructing a digest by hand.
        // lib/gates.mjs learned the same lesson on the engine-side issues: a
        // command a reader can copy is the difference between a gate that gets
        // answered and one that gets ignored.
        lines.push('');
        lines.push('**Approve this proposal:**');
        lines.push('');
        lines.push('```');
        lines.push(approveCommandFor(m));
        lines.push('```');
        lines.push('');
        lines.push(`To reject it instead, replace \`approve\` with \`deny\`, drop the digest, and append \`reason="..."\`.`);

        lines.push('');
        lines.push('---');
        lines.push('');
    }

    // Review procedure
    lines.push('## Review procedure');
    lines.push('');
    lines.push('1. Click each **Content** link above to read the drafted content');
    lines.push('2. Click each **ADO** link to see the tracking User Story');
    lines.push('3. Verify the deterministic gates');
    lines.push('4. Review the model stages for any red flags');
    lines.push('5. Decide: accept or reject');
    lines.push('6. Comment the decision command from each proposal\'s section (just Comment, not Close):');
    lines.push('   - `/orchard gate2 approve item=<id> digest=<sha256>` publishes that proposal to the live site');
    lines.push('   - `/orchard gate2 deny item=<id> reason="..."` rejects it');
    lines.push('   - `/orchard gate2 request-changes item=<id> reason="..."` sends it back to be rewritten, and the next authoring pass is given your reason verbatim');
    lines.push(`   - Several commands may go in one comment, one per line, up to ${MAX_DECISIONS_PER_COMMENT}, all of the same kind`);
    lines.push('   - A bare `Approved` is refused. So is a digest that no longer matches the artifact, which is what stops an approval written before an edit from applying after it.');
    lines.push('');
    lines.push('The `orchard-human-review` workflow will:');
    lines.push('1. Reply to confirm it received your decision');
    lines.push('2. Record the publication or rejection');
    lines.push('3. Commit and push the content to the platform repo (on Approve)');
    lines.push('4. Update the ADO User Story state');
    lines.push('5. Close this issue automatically');
    lines.push('');
    lines.push('You never touch a terminal. Just comment and wait for the confirmation reply.');

    return lines.join('\n');
}

/**
 * Find the local-proposals directory for a given proposal by searching run-records.
 * Returns the path to the 04-final.md file if found, or null.
 */
function findProposalContent(proposal, localProposalsDir) {
    if (!localProposalsDir || !existsSync(localProposalsDir)) return null;

    // The proposal's id contains an 8-char hex suffix that matches the first 8 chars
    // of a local-proposals subdirectory UUID.
    // e.g. "proposal-p42-create-agent-orchestration-visual-guide-3c68e8d1" -> look for dir starting with "3c68e8d1"
    const uuidMatch = (proposal.id || '').match(/([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
        || (proposal.proposalId || '').match(/([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
        || (proposal.id || '').match(/([0-9a-f]{8})$/i)
        || (proposal.proposalId || '').match(/([0-9a-f]{8})$/i);

    if (!uuidMatch) return null;

    const uuidPrefix = uuidMatch[1];

    for (const entry of readdirSync(localProposalsDir)) {
        if (!entry.startsWith(uuidPrefix)) continue;
        const finalPath = resolve(localProposalsDir, entry, '04-final.md');
        if (existsSync(finalPath)) {
            return finalPath;
        }
    }
    return null;
}

/**
 * Read the text content of 04-final.md for a proposal. Returns the text or null.
 */
function findProposalContentText(proposal, localProposalsDir) {
    const path = findProposalContent(proposal, localProposalsDir);
    if (!path) return null;
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
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
            'local-proposals': { type: 'string' },  // path to local-proposals dir with 04-final.md files
            'engine-run-id': { type: 'string' },  // GITHUB_RUN_ID of the engine workflow
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
    const proposalDigests = matched.map(m => digest(m.proposal.id || m.proposal.proposalId || JSON.stringify(m.proposal)));
    const existing = findExistingIssue(tracker, proposalDigests);

    if (existing) {
        console.log(`Issue already exists for this proposal set: #${existing.issueNumber || existing.id} (${existing.url || 'no URL recorded'})`);
        console.log('Nothing to do. Delete the tracker entry to force a new issue.');
        process.exit(0);
    }

    // 6. Build the issue body
    const localProposalsDir = args.values['local-proposals']
        ? resolve(args.values['local-proposals'])
        : resolve(proposalDir, '..', 'private', 'local-proposals');
    const engineRunId = args.values['engine-run-id'] || null;
    const body = buildIssueBody(matched, existsSync(localProposalsDir) ? localProposalsDir : null, engineRunId);

    // Derive a meaningful title from the dispositions present.
    const dispositions = [...new Set(matched.map(m => m.packet.disposition))].sort();
    const phaseLabel = dispositions.join('/');
    const title = `[Orchard] ${matched.length} proposal(s) ready for review, ${phaseLabel}`;

    if (dryRun) {
        console.log('\n=== DRY RUN: would create issue ===');
        console.log(`Title: ${title}`);
        console.log(`\n${body}`);
        console.log('\n=== end dry run ===');
        process.exit(0);
    }

    // 7. Create the GitHub issue via gh CLI
    // This requires gh to be authenticated. The scheduled workflow provides this.
    try {
        // Write body to temp file: gh CLI on Windows doesn't reliably accept
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

// Run the CLI only when this file is the entry point. Compare the exact
// basename: endsWith would also match test-notify-review-ready.mjs, and an
// unconditional call runs the CLI on import, which is how the import
// side-effect test caught this.
if (process.argv[1] && basename(process.argv[1]) === 'notify-review-ready.mjs') main();
