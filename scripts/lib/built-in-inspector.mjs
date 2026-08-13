import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { sha256Digest } from "./identity.mjs";
import { TRACK_2_CLASSIFICATIONS } from "./track-2-controller.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function loadResults(path, options = {}) {
    const resolved = resolve(path);
    const maxBytes = options.maxBytes ?? 8_388_608;
    const maxResults = options.maxResults ?? 183;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxResults) || maxResults < 1) throw new TypeError("inspection result bounds must be positive safe integers");
    const size = statSync(resolved).size;
    if (size < 1 || size > maxBytes) throw new Error("inspection result file exceeds its byte bound");
    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    if (!Array.isArray(parsed)) throw new TypeError("inspection result file must contain an array");
    if (parsed.length > maxResults) throw new TypeError("inspection result file exceeds its result-count bound");
    const expectedStableIds = options.expectedStableIds ? new Set(options.expectedStableIds) : null;
    const results = new Map();
    for (const result of parsed) {
        if (!result || typeof result !== "object" || typeof result.stableId !== "string" || result.stableId.length < 1 || result.stableId.length > 300) throw new TypeError("inspection result needs a bounded stableId");
        if (expectedStableIds && !expectedStableIds.has(result.stableId)) throw new TypeError(`unexpected inspection result: ${result.stableId}`);
        if (results.has(result.stableId)) throw new TypeError(`duplicate inspection result: ${result.stableId}`);
        if (!DIGEST.test(result.itemDigest ?? "") || !DIGEST.test(result.sourceDigest ?? "") || !DIGEST.test(result.inspectorDigest ?? "")) {
            throw new TypeError(`inspection result has invalid digest binding: ${result.stableId}`);
        }
        if (!TRACK_2_CLASSIFICATIONS.includes(result.classification)) throw new TypeError(`unsupported inspection classification: ${result.classification}`);
        if (!Array.isArray(result.evidence) || result.evidence.length === 0 || result.evidence.length > 8 || result.evidence.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 500)) {
            throw new TypeError(`inspection result needs one through eight bounded evidence strings: ${result.stableId}`);
        }
        results.set(result.stableId, Object.freeze({ ...result }));
    }
    return results;
}

export function createValidatedResultInspector({ resultPath, expectedStableIds, maxBytes, maxResults }) {
    const results = loadResults(resultPath, { expectedStableIds, maxBytes, maxResults });
    return async function inspect(item, context) {
        const root = resolve(context.platformRoot);
        const path = resolve(root, item.sourcePath);
        if (!path.startsWith(`${root}${sep}`)) throw new Error(`canonical source escaped platform root: ${item.stableId}`);
        const actualSourceDigest = sha256Digest(readFileSync(path));
        if (actualSourceDigest !== item.sourceDigest) throw new Error(`canonical source digest changed: ${item.stableId}`);
        const result = results.get(item.stableId);
        if (!result) throw new Error(`inspection result is missing: ${item.stableId}`);
        if (result.itemDigest !== item.digest || result.sourceDigest !== item.sourceDigest) throw new Error(`inspection result does not bind canonical bytes: ${item.stableId}`);
        return {
            classification: result.classification,
            evidence: [...result.evidence, `inspector:${result.inspectorDigest}`, `item:${result.itemDigest}`, `source:${result.sourceDigest}`],
        };
    };
}

export function inspectionInputDigest(item, contentCommit, policyDigest) {
    if (!DIGEST.test(policyDigest ?? "")) throw new TypeError("policyDigest must be a sha256 digest");
    return sha256Digest({ stableId: item.stableId, itemDigest: item.digest, sourceDigest: item.sourceDigest, contentCommit, policyDigest });
}
