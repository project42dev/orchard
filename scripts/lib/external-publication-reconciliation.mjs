// A reviewed direct content release can finish a stranded Orchard item without
// claiming the Orchard publisher created that release. The operator supplies
// a checked-in, exact release manifest; every target and ADO link is matched
// against the live revision before any state is changed.
import { generateUuidV7, sha256Digest } from './identity.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ELIGIBLE = new Set([
    'ado-linked', 'executing', 'gate2-ready', 'gate2-pending',
    'gate2-approved', 'blocked', 'changes-requested', 'stale-approval',
]);

function resolveTarget(entry, corpusRoot) {
    const read = (path) => JSON.parse(readFileSync(join(corpusRoot, 'content', path), 'utf8'));
    if (/^modules\/[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(entry.path)) {
        if (entry.canonical_content_id) throw new TypeError('standalone target must not have a catalog selector');
        return { value: read(entry.path), url: `https://project-42.dev/learn/${entry.path.slice(8, -5)}` };
    }
    if (/^diagrams\/[a-z0-9-]+\.mmd$/.test(entry.path)) {
        if (entry.canonical_content_id) throw new TypeError('diagram target must not have a catalog selector');
        return { value: readFileSync(join(corpusRoot, 'content', entry.path), 'utf8').replace(/\r\n/g, '\n'), url: `https://project-42.dev/guide/diagrams/${entry.path.slice(9, -4)}` };
    }
    if (entry.path !== 'catalog.json' || !/^(learning-module|learning-path|guide):[a-z0-9-]+$/.test(entry.canonical_content_id ?? '')) {
        throw new TypeError('report item requires an exact supported content target');
    }
    const [kind, id] = entry.canonical_content_id.split(':');
    const catalog = read('catalog.json');
    const collection = { 'learning-module': 'modules', 'learning-path': 'paths', guide: 'resources' }[kind];
    const matches = (catalog[collection] ?? []).filter((value) => value.id === id);
    if (matches.length !== 1) throw new Error('catalog selector must match exactly one item');
    let url;
    if (kind === 'learning-module') {
        const paths = catalog.paths.filter((p) => p.moduleIds.includes(id));
        if (!paths.some((p) => entry.live_url === `https://project-42.dev/learn/${p.id}/${id}`)) throw new Error('module URL must match catalog path membership');
        url = entry.live_url;
    } else url = kind === 'learning-path' ? `https://project-42.dev/learn/${id}` : `https://project-42.dev/guide/resources/${id}`;
    return { value: matches[0], url };
}

function verifySupportingArtifacts(entry, corpusRoot) {
    if (entry.supporting_artifacts === undefined) return;
    if (!Array.isArray(entry.supporting_artifacts) || entry.supporting_artifacts.length === 0) throw new TypeError('supporting artifacts must be a nonempty list');
    const seen = new Set();
    for (const artifact of entry.supporting_artifacts) {
        if (!/^(training\/[a-z0-9-]+\/path-contract\.json|training\/[a-z0-9-]+\/[a-z0-9-]+\/(class-script\.json|integrity\.json|captions\/[a-zA-Z-]+\.vtt|transcripts\/[a-zA-Z-]+\.md|alternatives\/[a-zA-Z-]+\.md)|modules\/[a-z0-9-]+\/[a-z0-9-]+\.json|diagrams\/[a-z0-9-]+\.(json|svg|mmd))$/.test(artifact.path)
            || seen.has(artifact.path) || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) throw new TypeError('invalid supporting artifact');
        seen.add(artifact.path);
        const raw = readFileSync(join(corpusRoot, 'content', artifact.path), 'utf8').replace(/\r\n/g, '\n');
        const value = artifact.path.endsWith('.json') ? JSON.parse(raw) : raw;
        if (sha256Digest(value) !== artifact.digest) throw new Error('supporting artifact digest differs from the deployed corpus');
    }
}

export async function reconcileExternalPublications({
    store, report, deployedPlatformCommit, corpusRoot, liveReleaseFacts, now = new Date().toISOString(),
    actor = 'orchard/admin-external-publication-reconciliation',
}) {
    if (report?.kind !== 'external-publication-reconciliation' || report.schema_version !== '1.0.0'
        || !/^[0-9a-f]{40}$/.test(report.content_commit)
        || !/^[0-9a-f]{40}$/.test(report.platform_commit)
        || !/^[0-9a-f]{40}$/.test(report.site_commit)
        || !/^0\.[0-9]+\.[0-9]+$/.test(report.platform_version)
        || deployedPlatformCommit !== report.platform_commit || typeof corpusRoot !== 'string'
        || liveReleaseFacts?.platformVersion !== report.platform_version
        || !Array.isArray(report.items) || report.items.length === 0) {
        throw new TypeError('a reviewed external-publication report matching the deployed platform commit is required');
    }
    const seen = new Set();
    const prepared = [];
    for (const entry of report.items) {
        if (!/^[0-9a-f-]{36}$/.test(entry.item_id) || seen.has(entry.item_id)
            || !Number.isSafeInteger(entry.ado_id) || entry.ado_id < 1
            || !Number.isSafeInteger(entry.revision) || entry.revision < 1
            || !/^sha256:[0-9a-f]{64}$/.test(entry.content_digest)
            || !Array.isArray(entry.content_prs) || entry.content_prs.length === 0
            || entry.content_prs.some((url) => !/^https:\/\/github\.com\/project42dev\/project42-content\/pull\/[0-9]+$/.test(url))) {
            throw new TypeError('report item lacks a distinct target, source digest, public URL, and reviewed content PR');
        }
        seen.add(entry.item_id);
        const target = resolveTarget(entry, corpusRoot);
        if (entry.live_url !== target.url) throw new TypeError('report URL differs from the exact content target');
        const deployedDigest = sha256Digest(target.value);
        if (deployedDigest !== entry.content_digest) {
            throw new Error(`report item ${entry.item_id} digest differs from the deployed corpus`);
        }
        verifySupportingArtifacts(entry, corpusRoot);
        const row = store.db.prepare(`SELECT w.item_id, w.track, w.origin_run_id, w.current_revision,
                w.current_state, r.target_repository, r.target_path,
                json_extract(r.record_json, '$.canonical_content_id') AS canonical_content_id,
                (SELECT e.external_id FROM external_link e WHERE e.item_id = w.item_id AND e.item_revision = w.current_revision AND e.provider = 'ado'
                    ORDER BY e.item_revision DESC, e.linked_at DESC LIMIT 1) AS ado_id
            FROM workflow_item w JOIN item_revision r ON r.item_id = w.item_id AND r.item_revision = w.current_revision
            WHERE w.item_id = ?`).get(entry.item_id);
        if (!row || row.track !== 'track-2' || row.target_repository !== 'project42dev/project42-content'
            || row.target_path !== entry.path || Number(row.ado_id) !== entry.ado_id
            || (row.canonical_content_id ?? null) !== (entry.canonical_content_id ?? null)
            || Number(row.current_revision) !== entry.revision) {
            throw new Error(`report item ${entry.item_id} does not match the live Orchard target and ADO link`);
        }
        const evidence = {
            kind: report.kind, item_id: entry.item_id, ado_id: entry.ado_id, revision: entry.revision, path: entry.path,
            content_digest: entry.content_digest, live_url: entry.live_url, content_prs: entry.content_prs,
            ...(entry.canonical_content_id ? { canonical_content_id: entry.canonical_content_id } : {}),
            ...(entry.supporting_artifacts ? { supporting_artifacts: entry.supporting_artifacts } : {}),
            content_commit: report.content_commit, platform_commit: report.platform_commit,
            site_commit: report.site_commit, platform_version: report.platform_version,
            conclusion: 'Reviewed content was released directly; Orchard did not publish this item.',
        };
        const digest = sha256Digest(evidence);
        if (row.current_state === 'externally-published') {
            const existing = store.db.prepare(`SELECT 1 FROM observation_event WHERE item_id = ?
                AND item_revision = ? AND evidence_digest = ?`).get(entry.item_id, row.current_revision, digest);
            if (!existing) throw new Error(`report item ${entry.item_id} was externally published with different evidence`);
            prepared.push({ row, entry, evidence, digest, replay: true });
            continue;
        }
        if (!ELIGIBLE.has(row.current_state)) {
            throw new Error(`report item ${entry.item_id} is ${row.current_state}, not eligible for external publication reconciliation`);
        }
        prepared.push({ row, entry, evidence, digest, replay: false });
    }
    await store.runLinkedWrites(async () => {
        for (const { row, entry, evidence, digest, replay } of prepared) {
            if (replay) continue;
            store.recordObservation({
                observation_id: generateUuidV7(), run_id: row.origin_run_id, item_id: entry.item_id,
                item_revision: Number(row.current_revision), evidence_reference: `external-publication:${entry.item_id}`,
                evidence_digest: digest, observed_at: now, report: evidence,
            });
            await store.recordTransition({
                schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: row.origin_run_id,
                item_id: entry.item_id, item_revision: Number(row.current_revision),
                from_state: row.current_state, to_state: 'externally-published',
                cause: 'external-publication-reconciled',
                reason: `Reviewed direct release ${report.site_commit} serves ${entry.live_url}; Orchard publication was not used.`,
                evidence_ref: digest, actor, occurred_at: now, correlation_id: generateUuidV7(),
            });
        }
    });
    return prepared.map(({ entry, digest, replay }) => ({ item: entry.item_id, adoId: entry.ado_id, evidenceDigest: digest, replay }));
}
