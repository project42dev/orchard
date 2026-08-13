import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalJson, generateUuidV7, sha256Digest } from "./identity.mjs";
import { verifyCorpusSnapshot } from "./corpus-snapshot.mjs";

export const TRACK_2_CLASSIFICATIONS = Object.freeze([
    "addition", "update", "correction", "replacement", "removal", "evidence-backed-no-change"
]);
export const TRACK_2_EXPECTED_CANONICAL_ITEMS = 183;

function posixRelative(root, path) { return relative(root, path).split(sep).join("/"); }

function readJson(path, label) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`could not read ${label}: ${error.message}`); }
}

function jsonFiles(root) {
    const files = [];
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return files;
    const walk = (directory) => {
        for (const name of readdirSync(directory).sort()) {
            if (name === "generated" || name.startsWith(".")) continue;
            const path = join(directory, name);
            const info = statSync(path);
            if (info.isDirectory()) walk(path);
            else if (name.endsWith(".json")) files.push(path);
        }
    };
    walk(root);
    return files;
}

function indexCanonicalFiles(root, directory) {
    const index = new Map();
    for (const path of jsonFiles(join(root, directory))) {
        const value = readJson(path, posixRelative(root, path));
        if (typeof value.id !== "string") continue;
        const entries = index.get(value.id) ?? [];
        entries.push(path);
        index.set(value.id, entries);
    }
    return index;
}

function ensureUnique(entries) {
    const ids = new Set();
    for (const item of entries) {
        if (ids.has(item.stableId)) throw new Error(`duplicate canonical item: ${item.stableId}`);
        ids.add(item.stableId);
    }
}

function fileBackedItems(root, directory, index, catalogEntries, prefix, kind, surface) {
    const items = [];
    for (const path of jsonFiles(join(root, directory))) {
        const value = readJson(path, posixRelative(root, path));
        if (typeof value.id !== "string" || value.id.length === 0) throw new Error(`canonical ${kind} source has no id: ${posixRelative(root, path)}`);
        items.push({ stableId: `${prefix}:${value.id}`, kind, canonicalId: value.id, surface, sourcePath: path, value });
    }
    for (const value of catalogEntries) {
        if (!index.has(value.id)) items.push({ stableId: `${prefix}:${value.id}`, kind, canonicalId: value.id, surface, sourcePath: join(root, "content", "catalog.json"), value });
    }
    return items;
}

export function enumerateCanonicalCorpus(platformRoot) {
    const root = resolve(platformRoot);
    const catalogPath = join(root, "content", "catalog.json");
    const diagramCatalogPath = join(root, "content", "diagrams", "catalogue.json");
    const catalog = readJson(catalogPath, "content/catalog.json");
    const diagramCatalog = readJson(diagramCatalogPath, "content/diagrams/catalogue.json");
    for (const field of ["paths", "modules", "resources"]) if (!Array.isArray(catalog[field])) throw new Error(`content/catalog.json needs a ${field} array`);
    if (!Array.isArray(diagramCatalog.diagrams)) throw new Error("content/diagrams/catalogue.json needs a diagrams array");
    const modules = indexCanonicalFiles(root, join("content", "modules"));
    const resources = indexCanonicalFiles(root, join("content", "resources"));
    const items = [
        { stableId: "catalogue:content", kind: "catalogue", canonicalId: "content", surface: "learning", sourcePath: catalogPath, value: catalog },
        { stableId: "catalogue:guide-diagrams", kind: "catalogue", canonicalId: "guide-diagrams", surface: "guide-diagram", sourcePath: diagramCatalogPath, value: diagramCatalog },
        ...catalog.paths.map((value) => ({ stableId: `learning-path:${value.id}`, kind: "learning-item", canonicalId: value.id, surface: "learning", sourcePath: catalogPath, value })),
        ...fileBackedItems(root, join("content", "modules"), modules, catalog.modules, "learning-module", "learning-item", "learning"),
        ...fileBackedItems(root, join("content", "resources"), resources, catalog.resources, "guide", "guide-item", "guide"),
        ...diagramCatalog.diagrams.map((value) => ({ stableId: `guide-diagram:${value.id}`, kind: "guide-diagram-item", canonicalId: value.id, surface: "guide-diagram", sourcePath: join(root, "content", "diagrams", value.source), value })),
    ].sort((left, right) => left.stableId.localeCompare(right.stableId));
    for (const item of items) {
        if (!item.canonicalId || typeof item.canonicalId !== "string") throw new Error(`canonical item has no stable id in ${posixRelative(root, item.sourcePath)}`);
        const normalized = resolve(item.sourcePath);
        if (!normalized.startsWith(`${join(root, "content")}${sep}`)) throw new Error(`canonical item escaped content root: ${item.stableId}`);
        if (!statSync(normalized, { throwIfNoEntry: false })?.isFile()) throw new Error(`canonical item source is missing: ${item.stableId}`);
        item.sourcePath = posixRelative(root, normalized);
        item.sourceDigest = sha256Digest(readFileSync(normalized));
        item.digest = item.kind === "guide-diagram-item" ? item.sourceDigest : sha256Digest(item.value);
    }
    ensureUnique(items);
    return items.map((item) => Object.freeze(item));
}

export function partitionCanonicalItems(items, partitionSize = 50) {
    if (!Number.isSafeInteger(partitionSize) || partitionSize < 1 || partitionSize > 50) throw new TypeError("partitionSize must be from 1 through 50");
    const sorted = [...items].sort((left, right) => left.stableId.localeCompare(right.stableId));
    ensureUnique(sorted);
    const partitions = [];
    for (let offset = 0; offset < sorted.length; offset += partitionSize) partitions.push(Object.freeze(sorted.slice(offset, offset + partitionSize)));
    return Object.freeze(partitions);
}

export async function mapWithConcurrency(items, concurrency, operation) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new TypeError("concurrency must be from 1 through 4");
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await operation(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

function snapshot(root, items) {
    const paths = [...new Set(items.map((item) => item.sourcePath))].sort();
    return sha256Digest(paths.map((path) => ({ path, digest: sha256Digest(readFileSync(join(root, path))) })));
}

export function reconcileTrack2Outcomes(itemIds, outcomes) {
    const expected = new Set(itemIds);
    const seen = new Set();
    const duplicates = [];
    const unexpected = [];
    for (const outcome of outcomes) {
        if (!expected.has(outcome.stableId)) unexpected.push(outcome.stableId);
        if (seen.has(outcome.stableId)) duplicates.push(outcome.stableId);
        seen.add(outcome.stableId);
    }
    const missing = itemIds.filter((id) => !seen.has(id));
    return { ok: duplicates.length === 0 && unexpected.length === 0 && missing.length === 0, duplicates, unexpected, missing };
}

export function verifyPinnedCommit(platformRoot, commit) {
    if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new TypeError("contentCommit must be a full lowercase Git commit");
    const root = resolve(platformRoot);
    if (!statSync(join(root, ".git"), { throwIfNoEntry: false })) return verifyCorpusSnapshot(root, commit).commit;
    const actual = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (actual !== commit) throw new Error(`platform root is at ${actual}, not pinned commit ${commit}`);
    const contentChanges = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--",
        "content/catalog.json", "content/modules", "content/resources", "content/diagrams"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (contentChanges) throw new Error("platform canonical content differs from the pinned commit");
    return actual;
}

export function createTrack2RunRecord(options, coverage, status, startedAt, completedAt) {
    const record = {
        schema_version: "1.0.0", run_id: options.runId, track: "track-2",
        trigger: { type: options.triggerType ?? "manual", reference: options.triggerReference ?? "local-controller" }, status,
        configuration_digest: sha256Digest({ mode: options.mode, partitionSize: options.partitionSize, concurrency: options.concurrency, subset: options.subsetIds ?? [] }),
        source_registry_digest: null, content_commit: options.contentCommit,
        implementation_commit: options.implementationCommit ?? "0000000000000000000000000000000000000000",
        model_role_map_digest: options.modelRoleMapDigest ?? sha256Digest("inspector-adapter"), started_at: startedAt, completed_at: completedAt,
        actor: { kind: options.actorKind ?? "operator", reference: options.actorReference ?? "local-controller" },
        scope: { mode: options.mode, expected_count: coverage.expected, partition_size: options.partitionSize, concurrency_cap: options.concurrency },
        coverage, item_count: 0,
    };
    record.manifest_digest = sha256Digest(record);
    return record;
}

async function persistItemResult(store, runId, item, outcome, observedAt) {
    const evidence = { stableId: item.stableId, canonicalId: item.canonicalId, contentDigest: item.digest, sourcePath: item.sourcePath, classification: outcome.classification ?? null, evidence: outcome.evidence ?? [], error: outcome.error ?? null };
    const digest = sha256Digest(evidence);
    await store.recordObservation({ observation_id: generateUuidV7(), run_id: runId, evidence_reference: item.sourcePath, evidence_digest: digest, observed_at: observedAt, track: "track-2", canonical_content_id: item.canonicalId, evidence });
    await store.recordRunOutcome({ outcome_id: generateUuidV7(), run_id: runId, subject_key: item.stableId, outcome: outcome.classification ?? outcome.outcome, exception_reason: outcome.error ?? null, evidence_digest: digest, occurred_at: observedAt, canonical_content_id: item.canonicalId });
}

function validateInspection(result) {
    if (!result || typeof result !== "object") throw new TypeError("inspector returned no result");
    if (!TRACK_2_CLASSIFICATIONS.includes(result.classification)) throw new TypeError(`unsupported inspection classification: ${result.classification}`);
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) throw new TypeError("deep inspection must return evidence");
    return result;
}

export async function runTrack2(options) {
    if (!["full", "subset", "dry-run"].includes(options.mode)) throw new TypeError("Track 2 mode must be full, subset, or dry-run");
    if (!/^[a-f0-9]{40}$/.test(options.contentCommit ?? "")) throw new TypeError("contentCommit must be supplied as a full lowercase Git commit");
    if (typeof options.inspector !== "function" && options.mode !== "dry-run") throw new TypeError("Track 2 needs an inspector adapter");
    const commitVerifier = options.commitVerifier ?? verifyPinnedCommit;
    commitVerifier(options.platformRoot, options.contentCommit);
    const allItems = enumerateCanonicalCorpus(options.platformRoot);
    const expectedCanonicalItems = options.expectedCanonicalItems ?? TRACK_2_EXPECTED_CANONICAL_ITEMS;
    if (!Number.isSafeInteger(expectedCanonicalItems) || expectedCanonicalItems < 1) throw new TypeError("expectedCanonicalItems must be a positive safe integer");
    if (options.mode === "full" && allItems.length !== expectedCanonicalItems) {
        throw new Error(`full Track 2 requires exactly ${expectedCanonicalItems} canonical items; enumerated ${allItems.length}`);
    }
    const subset = options.mode === "subset" ? new Set(options.subsetIds ?? []) : null;
    if (subset) for (const id of subset) if (!allItems.some((item) => item.stableId === id)) throw new TypeError(`subset item is not canonical: ${id}`);
    const items = allItems.filter((item) => !subset || subset.has(item.stableId));
    const partitionSize = options.partitionSize ?? 50;
    const concurrency = options.concurrency ?? 4;
    const partitions = partitionCanonicalItems(items, partitionSize);
    const runId = options.runId ?? generateUuidV7();
    const normalized = { ...options, runId, partitionSize, concurrency };
    const startedAt = options.startedAt ?? (options.now?.() ?? new Date()).toISOString();
    const before = snapshot(options.platformRoot, allItems);
    const outcomes = [];
    let stopped = false;
    let drift = false;
    const initialCoverage = { expected: items.length, enumerated: items.length, inspected: 0, gaps: items.length };
    if (options.mode !== "dry-run" && options.stateStore) {
        options.onStage?.("track2.state.run-recording");
        await options.stateStore.recordRun(createTrack2RunRecord(normalized, initialCoverage, "running", startedAt, null));
        options.onStage?.("track2.state.run-recorded");
    }

    for (let ordinal = 0; ordinal < partitions.length; ordinal += 1) {
        const partition = partitions[ordinal];
        if (options.mode === "dry-run" || stopped) {
            for (const item of partition) {
                const result = { stableId: item.stableId, outcome: "unevaluated", reason: options.mode === "dry-run" ? "dry-run" : "prior-partition-failure" };
                outcomes.push(result);
                if (options.mode !== "dry-run" && options.stateStore) await persistItemResult(options.stateStore, runId, item, result, (options.now?.() ?? new Date()).toISOString());
            }
            continue;
        }
        let partitionOutcomes;
        try {
            const execute = options.partitionExecutor ?? ((part, inspect) => mapWithConcurrency(part, concurrency, inspect));
            const results = await execute(partition, async (item) => {
                try { return { stableId: item.stableId, ...validateInspection(await options.inspector(item, { runId, contentCommit: options.contentCommit, partitionOrdinal: ordinal, platformRoot: resolve(options.platformRoot) })) }; }
                catch (error) { return { stableId: item.stableId, outcome: "failed", error: error.message }; }
            });
            if (!Array.isArray(results) || results.length !== partition.length) throw new Error("partition executor returned incomplete results");
            const byId = new Map();
            for (const result of results) {
                if (byId.has(result.stableId)) throw new Error(`partition returned duplicate item: ${result.stableId}`);
                byId.set(result.stableId, result);
            }
            partitionOutcomes = partition.map((item) => byId.get(item.stableId)
                ?? { stableId: item.stableId, outcome: "failed", error: "partition omitted item" });
        } catch (error) {
            stopped = true;
            partitionOutcomes = partition.map((item) => ({ stableId: item.stableId, outcome: "failed", error: `partition failure: ${error.message}` }));
        }
        for (let index = 0; index < partition.length; index += 1) {
            const item = partition[index];
            const result = partitionOutcomes[index];
            outcomes.push(result);
            if (options.stateStore) {
                options.onStage?.("track2.state.item-persisting", { partition: ordinal + 1, item: outcomes.length });
                await persistItemResult(options.stateStore, runId, item, result, (options.now?.() ?? new Date()).toISOString());
            }
        }
        options.onStage?.("track2.state.partition-persisted", { partition: ordinal + 1, partitionCount: partitions.length, outcomeCount: outcomes.length });
        try { commitVerifier(options.platformRoot, options.contentCommit); } catch { drift = true; stopped = true; }
        if (snapshot(options.platformRoot, allItems) !== before) { drift = true; stopped = true; }
    }

    const reconciliation = reconcileTrack2Outcomes(items.map((item) => item.stableId), outcomes);
    const inspected = outcomes.filter((entry) => TRACK_2_CLASSIFICATIONS.includes(entry.classification)).length;
    const coverage = { expected: items.length, enumerated: items.length, inspected, gaps: items.length - inspected };
    const inspectionFailed = outcomes.some((entry) => entry.outcome === "failed" || entry.error);
    const fullSuccess = options.mode === "full" && !drift && !stopped && !inspectionFailed && reconciliation.ok && coverage.expected === allItems.length && coverage.expected === coverage.enumerated && coverage.enumerated === coverage.inspected && coverage.gaps === 0;
    const status = drift || stopped || inspectionFailed || !reconciliation.ok ? "failed" : fullSuccess ? "completed" : "incomplete";
    const completedAt = (options.now?.() ?? new Date()).toISOString();
    const run = createTrack2RunRecord(normalized, coverage, status, startedAt, completedAt);
    if (options.mode !== "dry-run" && options.stateStore) {
        options.onStage?.("track2.state.run-finalizing", { status });
        await options.stateStore.finalizeRun(run);
        options.onStage?.("track2.state.run-finalized", { status });
    }
    return { track: "track-2", mode: options.mode, status, contentCommit: options.contentCommit, inventoryDigest: before, items, partitions, outcomes, coverage, reconciliation, drift, inspectionFailed, run };
}
