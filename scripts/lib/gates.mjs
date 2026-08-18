import { assertValidRecord } from './contracts.mjs';
import { sha256Digest } from './identity.mjs';

export const MAX_GATE_BATCH_SIZE = 20;
const schemaName = (gate) => ({ 'gate-1': 'gate-1-issue-manifest', 'gate-2': 'gate-2-issue-manifest' }[gate] ?? (() => { throw new TypeError('gate must be gate-1 or gate-2'); })());
const fullInput = (gate, runId, track, items) => ({ schema_version: '1.0.0', gate, run_id: runId, track, items });
const batchInput = (m) => ({ schema_version: m.schema_version, gate: m.gate, run_id: m.run_id, track: m.track, batch: m.batch, full_manifest_digest: m.full_manifest_digest, items: m.items });

export function verifyGateManifestDigests(manifest, allItems) {
    if (!allItems) {
        if (manifest.batch?.count !== 1 || manifest.batch?.total_item_count !== manifest.items?.length) {
            throw new Error('complete full-manifest items are required to verify a multi-batch digest');
        }
        allItems = manifest.items;
    }
    const full = sha256Digest(fullInput(manifest.gate, manifest.run_id, manifest.track, allItems));
    if (manifest.full_manifest_digest !== full) throw new Error('full manifest digest mismatch');
    const batch = sha256Digest(batchInput(manifest));
    if (manifest.batch_digest !== batch) throw new Error('batch digest mismatch');
    if (manifest.idempotency_key !== `github:${manifest.gate}:${manifest.run_id}:${batch}`) throw new Error('gate issue idempotency key mismatch');
    return manifest;
}

// A conservative budget on the RAW JSON size of one batch's items, well
// short of GitHub's 65536-character issue body limit. Found live 2026-08-17:
// Track 2 currency items can carry up to 50 evidence entries at up to 1000
// characters each (track-2-controller.mjs), so a batch of 20 such items can
// serialize past the body limit on its own, before the human-readable
// rendering even joins it. All nine of Track 2's real 20-item batches from
// 2026-08-16 did. A batch whose own manifest cannot fit is one no decision
// can ever bind to (apply-gate-decisions.mjs has no way to read a manifest
// except the fenced JSON block in the issue body), so batches split on
// serialized size, not on a flat item count alone. 20 stays the ceiling;
// this only ever makes a batch smaller, never larger, and the last batch was
// already allowed to be smaller than 20 before this existed.
const MAX_MANIFEST_ITEM_BYTES = 30_000;

function sizedBatches(sorted) {
    const batches = [];
    let current = [];
    let currentSize = 0;
    for (const item of sorted) {
        const itemSize = JSON.stringify(item).length;
        if (current.length > 0 && (current.length >= 20 || currentSize + itemSize > MAX_MANIFEST_ITEM_BYTES)) {
            batches.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(item);
        currentSize += itemSize;
    }
    if (current.length) batches.push(current);
    return batches;
}

export async function generateGateManifests({ gate, runId, run_id: snakeRunId, track, items, maximumSize = 20 }) {
    schemaName(gate); runId ??= snakeRunId;
    if (maximumSize !== 20) throw new RangeError('Gate issues must use the normative maximum size of 20');
    if (!Array.isArray(items) || !items.length) throw new TypeError('items must be a non-empty array');
    const sorted = structuredClone(items).sort((a, b) => a.item_id.localeCompare(b.item_id));
    if (new Set(sorted.map((item) => item.item_id)).size !== sorted.length) throw new Error('each item_id must appear exactly once');
    const full = sha256Digest(fullInput(gate, runId, track, sorted));
    const batches = sizedBatches(sorted);
    const count = batches.length; const manifests = [];
    for (const batchItems of batches) {
        const manifest = {
            schema_version: '1.0.0', gate, run_id: runId, track,
            batch: { ordinal: manifests.length + 1, count, item_count: batchItems.length, total_item_count: sorted.length, maximum_size: 20 },
            full_manifest_digest: full, batch_digest: '', idempotency_key: '', items: batchItems
        };
        manifest.batch_digest = sha256Digest(batchInput(manifest));
        manifest.idempotency_key = `github:${gate}:${runId}:${manifest.batch_digest}`;
        await assertValidRecord(schemaName(gate), manifest); verifyGateManifestDigests(manifest, sorted); manifests.push(manifest);
    }
    return manifests;
}

export function decisionCommand(manifest, item, decision = 'approve') {
    const digest = manifest.gate === 'gate-1' ? item.proposal_digest : item.artifact_digest;
    return `/orchard ${manifest.gate.replace('-', '')} ${decision} item=${item.item_id} revision=${item.item_revision} digest=${digest}`;
}
const safe = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');

// Found live 2026-08-17: an owner staring at a Gate 2 issue full of digests
// had no way to tell, without reading every table cell, that one of three
// items had FAILED its factual review while the other two passed -- and a
// bare "approve" comment approves every item on the issue with no
// distinction. This surfaces exactly that distinction up front, once, in
// plain language, instead of leaving it buried in a table row the reader
// has to already know to look for.
//
// ONLY "failed" is a red flag. The schema (gate-2-issue-manifest) allows
// three statuses -- passed, failed, human-review -- and "human-review" is
// not a warning, it is the PERMANENT, EVERY-SINGLE-ITEM state of
// accessibility_review in this deployed engine: no accessibility-review
// agent exists, so every item's accessibility field reads "human-review"
// forever, by design. The first version of this function treated anything
// short of "passed" as needing attention, which meant literally 100% of
// Gate 2 items were flagged -- found live 2026-08-17 when the owner got a
// real issue where the ONLY thing wrong was the normal, universal
// accessibility state, and correctly refused to trust a warning that
// fires on everything. factual_review DOES vary for real (a dedicated
// agent produces passed/failed), so a "human-review" there is left alone
// too, for the same reason: it is not evidence of a problem, only of no
// automated verdict, which is not this function's job to editorialize on.
function gate2AttentionReason(item) {
    const bad = [];
    if (item.factual_review && item.factual_review.status === 'failed') bad.push('factual review failed');
    if (item.accessibility_review && item.accessibility_review.status === 'failed') bad.push('accessibility review failed');
    return bad.length ? bad.join(', ') : null;
}

function renderGateSummary(manifest) {
    if (manifest.gate !== 'gate-2') {
        return [`**${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'}**, all newly proposed -- there is nothing to compare against yet, so nothing here is flagged.`, ''];
    }
    const attention = manifest.items
        .map((item) => ({ item, reason: gate2AttentionReason(item) }))
        .filter((entry) => entry.reason);
    if (attention.length === 0) {
        return [`**All ${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'} passed every review.** Commenting just the word \`approve\` on this issue approves all of them.`, ''];
    }
    const clean = manifest.items.length - attention.length;
    const lines = [
        `**${attention.length} of ${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention before you approve.**`,
        `Commenting the bare word \`approve\` approves EVERY item on this issue, including the ${attention.length} below -- for a mixed issue like this one, use the per-item command instead.`,
        '',
    ];
    if (clean > 0) lines.push(`${clean} item${clean === 1 ? '' : 's'} passed every review and are safe to approve individually.`, '');
    lines.push('| Needs attention | Why |', '| --- | --- |');
    for (const { item, reason } of attention) lines.push(`| \`${item.item_id}\` (${safe(item.target.path)}) | ${safe(reason)} |`);
    lines.push('');
    return lines;
}

// `compact` drops the per-item prose (rationale, evidence, risks, review
// detail) and keeps only what a human needs to act: which item, its target,
// and the exact decision command. Used when the full rendering plus the
// embedded machine-readable manifest would exceed GitHub's body limit --
// the manifest is what makes a decision bindable at all, so it must never be
// the thing dropped to make room. Full detail still lives in the manifest
// itself and in the item's own ADO work item.
// Found live 2026-08-17: the owner pasted a real Gate 2 issue back and
// rejected it a second time -- the badge/summary fix above made the TOP of
// the issue readable, but each item still dropped a 13-row table of raw
// SHA-256 digests between the badge and the approve command. Nine items
// meant ~117 rows of hashes standing between the reader and the nine
// one-line commands they actually needed. Verifying "the badge renders
// correctly" is not the same as verifying a human can actually use the
// page -- this is the concrete lesson from shipping that half-fix. The
// digests are not decoration: they are what apply-gate-decisions.mjs binds
// an approval to, so they cannot be dropped (that is what `compact` is
// for, and compact drops far more than this). They can, however, be
// collapsed: GitHub renders <details> natively, so the binding table moves
// there and the visible page becomes badge, target, command -- the digests
// are one click away for the review, not blocking it.
function pushBindingDetails(lines, manifest, item, digest) {
    lines.push('<details>', '<summary>Binding details (for the approval record -- not needed to decide)</summary>', '',
        '| Field | Bound value |', '| --- | --- |', `| Item | \`${item.item_id}\` |`,
        `| Revision | \`${item.item_revision}\` |`, `| Decision digest | \`${digest}\` |`, `| Target | \`${item.target.repository}/${item.target.path}\` |`);
    if (manifest.gate === 'gate-1') lines.push(`| Evidence | ${safe(item.evidence_refs.join('; '))} |`);
    else lines.push(`| Proposal digest | \`${item.proposal_digest}\` |`, `| Displayed diff digest | \`${item.displayed_diff_digest}\` |`,
        `| Prepared tree digest | \`${item.prepared_tree_digest}\` |`, `| Base commit | \`${item.base_commit}\` |`, `| Diff reference | ${safe(item.diff_ref)} |`,
        `| Artifact reference | ${safe(item.artifact_ref)} |`, `| ADO external key | \`${item.ado_external_key}\` |`, `| Handoff chain | \`${item.handoff_chain_digest}\` |`,
        `| Factual review | \`${item.factual_review.status}\`: ${safe(item.factual_review.evidence_ref)} |`, `| Accessibility review | \`${item.accessibility_review.status}\`: ${safe(item.accessibility_review.evidence_ref)} |`);
    lines.push('', '</details>', '');
}

export function renderGateIssueBody(manifest, { compact = false } = {}) {
    const lines = [`## Orchard ${manifest.gate === 'gate-1' ? 'Gate 1 proposal authorization' : 'Gate 2 publication authorization'}`, '',
    `Manifest schema: \`${manifest.schema_version}\``, `Run: \`${manifest.run_id}\``, `Track: \`${manifest.track}\``,
    `Batch: ${manifest.batch.ordinal} of ${manifest.batch.count}; ${manifest.batch.item_count} item(s) in this issue; ${manifest.batch.total_item_count} total`,
    `Full manifest digest: \`${manifest.full_manifest_digest}\``, `Batch digest: \`${manifest.batch_digest}\``, `Idempotency key: \`${manifest.idempotency_key}\``, '',
        ...renderGateSummary(manifest),
        '> Decisions are item-specific. General prose, reactions, labels, and whole-issue approval do not change state.', ''];
    if (compact) {
        lines.push('> Per-item rationale, evidence, risks, and review detail are omitted from this rendering so the machine-readable manifest below fits GitHub\'s body limit. Every field is still in that manifest and on the item\'s own ADO work item.', '');
    }
    for (const item of manifest.items) {
        const digest = manifest.gate === 'gate-1' ? item.proposal_digest : item.artifact_digest;
        const attention = manifest.gate === 'gate-2' ? gate2AttentionReason(item) : null;
        const badge = manifest.gate === 'gate-2'
            ? (item.escalated ? '🛑 REJECTED TWICE BY THE ENSEMBLE -- YOUR CALL' : attention ? `⚠️ NEEDS ATTENTION -- ${attention}` : '✅ passed every review')
            : null;
        lines.push(`### ${safe(item.target.path)}`, '');
        if (badge) lines.push(`**${badge}**`, '');
        if (manifest.gate === 'gate-1' && !compact) {
            lines.push(`Category: \`${item.category}\`  |  Score: ${item.score.value} (\`${item.score.formula_version}\`)  |  Estimated cost: ${item.estimated_cost.currency} ${item.estimated_cost.amount}`, '',
                `Rationale: ${safe(item.rationale)}`, '', `Risks: ${safe(item.risks.join('; '))}`, '');
        }
        // Rejection gate (docs/design/rejection-gate.md): the real reason and
        // the actual rejected content, shown directly -- not collapsed the
        // way binding digests are. The owner asked to read the whole thing,
        // not click to expand it; digests are noise to hide, the content
        // under dispute is not.
        if (item.escalated) {
            lines.push(
                'The authoring ensemble blocked this item twice, including one automatic retry. This is what it actually found and what it actually wrote -- approving publishes it exactly as shown below; denying leaves it denied, available for a fresh attempt later via the admin recovery path.',
                '', '**Why the ensemble rejected it:**', '', item.rejection_reason, '',
                '**The rejected document, in full:**', '', '````', item.rejected_draft, '````', '',
            );
        } else if (manifest.gate === 'gate-2' && attention) {
            // Found live 2026-08-18: a bare "factual review failed" badge,
            // with the finding text only reachable via a handoff-id pointer
            // no command here can follow, gave the owner nothing to actually
            // decide from. The finding is real and was already captured
            // (prepare-gate2-evidence.mjs's reviewFor); show it directly,
            // in both renderings -- this is exactly the "why" content that
            // must never be the thing dropped to save space.
            if (item.factual_review?.status === 'failed' && item.factual_review.finding) {
                lines.push(`**Factual review finding:** ${safe(item.factual_review.finding)}`, '');
            }
            if (item.accessibility_review?.status === 'failed' && item.accessibility_review.finding) {
                lines.push(`**Accessibility review finding:** ${safe(item.accessibility_review.finding)}`, '');
            }
        }
        // Found live 2026-08-18, on a CLEAN item this time: "passed every
        // review" plus a wall of digests is still nothing to review -- a
        // badge is a claim, not evidence. Every gate-2 item now shows the
        // actual artifact content directly, the same way an escalated
        // item's rejected draft already does, in both renderings. Optional:
        // evidence built before this field existed renders without a
        // content section rather than failing (contracts/schemas/gate-2-issue-manifest
        // makes `content` optional for exactly this reason) -- if that gap
        // is ever seen live, it means the item's evidence predates this fix
        // and needs a fresh authoring pass, not a re-render.
        if (manifest.gate === 'gate-2' && !item.escalated && item.content) {
            lines.push('**The proposed content, in full:**', '', '````', item.content, '````', '');
        }
        lines.push('**Approve this item only:**', '', `\`${decisionCommand(manifest, item)}\``, '',
            'For deny or request-changes, replace `approve` and append `reason="..."`.',
            'For defer, replace `approve` and append `reason="..." review-after=YYYY-MM-DD`.', '');
        if (compact) {
            lines.push(`Item \`${item.item_id}\` revision \`${item.item_revision}\`, target \`${item.target.repository}/${item.target.path}\`.`, '');
        } else {
            pushBindingDetails(lines, manifest, item, digest);
        }
        lines.push('---', '');
    }
    return lines.join('\n');
}

export function gateIssueRequest(manifest, repository) {
    const title = `[Orchard] ${manifest.gate.toUpperCase()} ${manifest.track} run ${manifest.run_id} batch ${manifest.batch.ordinal}/${manifest.batch.count}`;
    const body = renderGateIssueBody(manifest); const labels = [`orchard-${manifest.gate}`];
    return { repository, externalKey: manifest.idempotency_key, expected: { repository, externalKey: manifest.idempotency_key, title, body, labels }, create: { title, body, labels } };
}

export async function applyGateIssues({ manifests, repository, githubAdapter, apply = false }) {
    if (!Array.isArray(manifests) || manifests.length === 0) throw new TypeError('manifests must be a non-empty array');
    const allItems = manifests.flatMap((manifest) => manifest.items).sort((a, b) => a.item_id.localeCompare(b.item_id));
    const expectedCount = manifests[0].batch.total_item_count;
    if (allItems.length !== expectedCount || new Set(allItems.map((item) => item.item_id)).size !== expectedCount) {
        throw new Error('gate manifest collection does not contain each full-manifest item exactly once');
    }
    for (const manifest of manifests) verifyGateManifestDigests(manifest, allItems);
    const requests = manifests.map((m) => gateIssueRequest(m, repository));
    if (!apply) return requests.map((request) => ({ operation: 'dry-run', request }));
    if (!githubAdapter) throw new TypeError('explicit --apply requires an injected GitHub adapter');
    const results = []; for (const request of requests) results.push(await githubAdapter.reconcileBeforeCreate(request)); return results;
}
