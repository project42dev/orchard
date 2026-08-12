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

export async function generateGateManifests({ gate, runId, run_id: snakeRunId, track, items, maximumSize = 20 }) {
    schemaName(gate); runId ??= snakeRunId;
    if (maximumSize !== 20) throw new RangeError('Gate issues must use the normative maximum size of 20');
    if (!Array.isArray(items) || !items.length) throw new TypeError('items must be a non-empty array');
    const sorted = structuredClone(items).sort((a, b) => a.item_id.localeCompare(b.item_id));
    if (new Set(sorted.map((item) => item.item_id)).size !== sorted.length) throw new Error('each item_id must appear exactly once');
    const full = sha256Digest(fullInput(gate, runId, track, sorted));
    const count = Math.ceil(sorted.length / 20); const manifests = [];
    for (let offset = 0; offset < sorted.length; offset += 20) {
        const batchItems = sorted.slice(offset, offset + 20);
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

export function renderGateIssueBody(manifest) {
    const lines = [`## Orchard ${manifest.gate === 'gate-1' ? 'Gate 1 proposal authorization' : 'Gate 2 publication authorization'}`, '',
    `Manifest schema: \`${manifest.schema_version}\``, `Run: \`${manifest.run_id}\``, `Track: \`${manifest.track}\``,
    `Batch: ${manifest.batch.ordinal} of ${manifest.batch.count}; ${manifest.batch.item_count} item(s) in this issue; ${manifest.batch.total_item_count} total`,
    `Full manifest digest: \`${manifest.full_manifest_digest}\``, `Batch digest: \`${manifest.batch_digest}\``, `Idempotency key: \`${manifest.idempotency_key}\``, '',
        '> Decisions are item-specific. General prose, reactions, labels, and whole-issue approval do not change state.', ''];
    for (const item of manifest.items) {
        const digest = manifest.gate === 'gate-1' ? item.proposal_digest : item.artifact_digest;
        lines.push(`### ${safe(item.title ?? item.item_id)}`, '', '| Field | Bound value |', '| --- | --- |', `| Item | \`${item.item_id}\` |`,
            `| Revision | \`${item.item_revision}\` |`, `| Decision digest | \`${digest}\` |`, `| Target | \`${item.target.repository}/${item.target.path}\` |`);
        if (manifest.gate === 'gate-1') lines.push(`| Category | \`${item.category}\` |`, `| Rationale | ${safe(item.rationale)} |`, `| Score | ${item.score.value} (\`${item.score.formula_version}\`) |`, `| Estimated cost | ${item.estimated_cost.currency} ${item.estimated_cost.amount} |`);
        else lines.push(`| Proposal digest | \`${item.proposal_digest}\` |`, `| Displayed diff digest | \`${item.displayed_diff_digest}\` |`,
            `| Prepared tree digest | \`${item.prepared_tree_digest}\` |`, `| Base commit | \`${item.base_commit}\` |`, `| Diff reference | ${safe(item.diff_ref)} |`,
            `| Artifact reference | ${safe(item.artifact_ref)} |`, `| ADO external key | \`${item.ado_external_key}\` |`, `| Handoff chain | \`${item.handoff_chain_digest}\` |`,
            `| Factual review | \`${item.factual_review.status}\`: ${safe(item.factual_review.evidence_ref)} |`, `| Accessibility review | \`${item.accessibility_review.status}\`: ${safe(item.accessibility_review.evidence_ref)} |`);
        lines.push('', '**Approve this item only:**', '', `\`${decisionCommand(manifest, item)}\``, '',
            'For deny or request-changes, replace `approve` and append `reason="..."`.',
            'For defer, replace `approve` and append `reason="..." review-after=YYYY-MM-DD`.', '', '---', '');
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
