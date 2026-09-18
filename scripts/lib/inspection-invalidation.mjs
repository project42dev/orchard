import { generateUuidV7, sha256Digest } from './identity.mjs';

export async function invalidateDisprovedPathFindings({ store, report, now = new Date().toISOString(), actor = 'orchard/admin-inspection-invalidation' }) {
    if (report?.kind !== 'inspection-invalidation' || report.schema_version !== '1.0.0'
        || !/^[0-9a-f]{40}$/.test(report.content_commit) || report.inspection_fix !== 'github:pull:335'
        || !Array.isArray(report.items) || report.items.length === 0) {
        throw new TypeError('a reviewed inspection-invalidation report is required');
    }
    const seen = new Set();
    const prepared = [];
    for (const entry of report.items) {
        if (!/^[0-9a-f-]{36}$/.test(entry.item_id) || seen.has(entry.item_id)
            || !Number.isSafeInteger(entry.ado_id) || !/^[a-z0-9-]+$/.test(entry.path_id)
            || !Number.isSafeInteger(entry.module_count) || entry.module_count < 1
            || !Array.isArray(entry.modules) || entry.modules.length !== entry.module_count
            || entry.modules.some((module) => !/^[a-z0-9-]+$/.test(module.id)
                || !(module.source === 'catalog.json#modules' || /^modules\/[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(module.source)))) {
            throw new TypeError('report item lacks a distinct, fully resolved path and source list');
        }
        seen.add(entry.item_id);
        const row = store.db.prepare(`SELECT w.item_id, w.track, w.origin_run_id, w.current_revision,
                w.current_state, r.target_path,
                json_extract(r.record_json, '$.canonical_content_id') AS canonical_content_id,
                (SELECT e.external_id FROM external_link e WHERE e.item_id = w.item_id AND e.provider = 'ado'
                    ORDER BY e.item_revision DESC, e.linked_at DESC LIMIT 1) AS ado_id
            FROM workflow_item w JOIN item_revision r ON r.item_id = w.item_id AND r.item_revision = w.current_revision
            WHERE w.item_id = ?`).get(entry.item_id);
        if (!row || row.track !== 'track-2' || row.current_state !== 'ado-linked'
            || row.target_path !== 'catalog.json' || row.canonical_content_id !== `learning-path:${entry.path_id}`
            || Number(row.ado_id) !== entry.ado_id) {
            throw new Error(`report item ${entry.item_id} does not match the live approved path and ADO link`);
        }
        const evidence = {
            kind: report.kind, item_id: entry.item_id, ado_id: entry.ado_id, path_id: entry.path_id,
            content_commit: report.content_commit, inspection_fix: report.inspection_fix,
            module_count: entry.module_count, modules: entry.modules,
            conclusion: 'All path module references resolve from the effective catalogue; the approved missing-module finding was false.',
        };
        prepared.push({ row, entry, evidence, digest: sha256Digest(evidence) });
    }
    await store.runLinkedWrites(async () => {
        for (const { row, entry, evidence, digest } of prepared) {
            store.recordObservation({
                observation_id: generateUuidV7(), run_id: row.origin_run_id, item_id: entry.item_id,
                item_revision: Number(row.current_revision), evidence_reference: `inspection-invalidation:${entry.item_id}`,
                evidence_digest: digest, observed_at: now, report: evidence,
            });
            await store.recordTransition({
                schema_version: '1.0.0', transition_id: generateUuidV7(), run_id: row.origin_run_id,
                item_id: entry.item_id, item_revision: Number(row.current_revision),
                from_state: 'ado-linked', to_state: 'invalidated', cause: 'inspection-invalidated',
                reason: `${entry.module_count}/${entry.module_count} path module references resolve through the effective catalogue at ${report.content_commit}.`,
                evidence_ref: digest, actor, occurred_at: now, correlation_id: generateUuidV7(),
            });
        }
    });
    return prepared.map(({ entry, digest }) => ({ item: entry.item_id, adoId: entry.ado_id, pathId: entry.path_id, evidenceDigest: digest }));
}
