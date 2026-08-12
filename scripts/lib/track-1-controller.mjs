import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import ipaddr from "ipaddr.js";
import { canonicalJson, generateUuidV7, sha256Digest } from "./identity.mjs";

export const TRACK_1_OUTCOMES = Object.freeze([
    "success", "redirected", "rate-limited", "failed", "skipped", "blocked", "unevaluated"
]);

const FAILURE_OUTCOMES = new Set(["rate-limited", "failed", "blocked"]);
const IPV6_GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3");
const BLOCKED_IPV6_RANGES = Object.freeze([
    "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23",
    "2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10",
    "fec0::/10", "ff00::/8"
].map((range) => ipaddr.parseCIDR(range)));

function positiveInteger(value, name, fallback) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
    return result;
}

function normalizeSource(source, legacyDefaults) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("approved source entries must be objects");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(source.id ?? "")) throw new TypeError("approved source id must be immutable lowercase key text");
    const url = source.url ?? source.urlPrefix;
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError(`approved source ${source.id} has an invalid URL`); }
    if (parsed.protocol !== "https:") throw new TypeError(`approved source ${source.id} must use HTTPS`);
    if (source.enabled === undefined && !legacyDefaults) throw new TypeError(`approved source ${source.id} needs an explicit enabled state`);
    const enabled = source.enabled ?? true;
    if (typeof enabled !== "boolean") throw new TypeError(`approved source ${source.id} enabled must be boolean`);
    const policy = source.policy ?? {
        approval: "versioned-registry-entry",
        trustTier: source.trustTier ?? "market-signal",
        reviewCadenceDays: source.reviewCadenceDays ?? null,
        owner: source.owner ?? null,
        fetchNote: source.fetchNote ?? null,
    };
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError(`approved source ${source.id} needs policy metadata`);
    const allowedHosts = [...new Set((policy.allowedHosts ?? [parsed.hostname]).map((host) => String(host).toLowerCase()))].sort();
    return Object.freeze({
        id: source.id,
        enabled,
        url: parsed.href,
        label: source.label ?? source.publisher ?? source.id,
        policy: Object.freeze({ ...policy, allowedHosts }),
    });
}

export function loadApprovedSourceRegistry(registry, options = {}) {
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new TypeError("approved source registry must be an object");
    const version = registry.registryVersion ?? registry.version ?? registry.schemaVersion;
    if (typeof version !== "string" || version.length === 0) throw new TypeError("approved source registry must be versioned");
    const entries = registry.approvedSources ?? registry.sources ?? registry.watchList;
    if (!Array.isArray(entries)) throw new TypeError("approved source registry needs approvedSources, sources, or watchList");
    const legacyDefaults = options.allowLegacyMetadata !== false && !registry.approvedSources;
    const sources = entries.map((entry) => normalizeSource(entry, legacyDefaults)).sort((left, right) => left.id.localeCompare(right.id));
    const ids = new Set();
    for (const source of sources) {
        if (ids.has(source.id)) throw new TypeError(`duplicate approved source id: ${source.id}`);
        ids.add(source.id);
    }
    const digest = sha256Digest({ version, sources });
    if (options.expectedDigest && options.expectedDigest !== digest) throw new Error("approved source registry digest does not match the caller pin");
    return Object.freeze({ version, digest, sources: Object.freeze(sources) });
}

export function semanticCandidateIdentity({ subject, surface, outcome, scope = "content" }) {
    const normalize = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    const identity = { subject: normalize(subject), surface: normalize(surface), outcome: normalize(outcome), scope: normalize(scope) };
    if (Object.values(identity).some((value) => value.length === 0)) throw new TypeError("semantic candidate identity fields must be non-empty");
    return `sid:v1:${sha256Digest(identity).slice(7)}`;
}

export function dedupeCandidates(candidates) {
    const byIdentity = new Map();
    for (const candidate of candidates) {
        const semanticIdentity = candidate.semanticIdentity ?? semanticCandidateIdentity(candidate);
        const existing = byIdentity.get(semanticIdentity);
        const evidence = [...new Set([...(existing?.evidence ?? []), ...(candidate.evidence ?? [])])].sort();
        const current = { ...candidate, semanticIdentity };
        const existingKey = existing ? canonicalJson({ ...existing, evidence: [] }) : null;
        const currentKey = canonicalJson({ ...current, evidence: [] });
        const representative = existingKey !== null && existingKey <= currentKey ? existing : current;
        byIdentity.set(semanticIdentity, { ...representative, semanticIdentity, evidence });
    }
    return [...byIdentity.values()].sort((left, right) => left.semanticIdentity.localeCompare(right.semanticIdentity));
}

export function partitionCandidates(candidates, batchSize = 20) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new TypeError("batchSize must be from 1 through 20");
    const unique = dedupeCandidates(candidates);
    const batches = [];
    for (let offset = 0; offset < unique.length; offset += batchSize) batches.push(Object.freeze(unique.slice(offset, offset + batchSize)));
    return Object.freeze(batches);
}

export function reconcileTrack1Outcomes(sourceIds, outcomes) {
    const expected = new Set(sourceIds);
    const seen = new Set();
    const duplicates = [];
    const unexpected = [];
    for (const outcome of outcomes) {
        if (!TRACK_1_OUTCOMES.includes(outcome.outcome)) throw new TypeError(`unknown Track 1 outcome: ${outcome.outcome}`);
        if (!expected.has(outcome.sourceId)) unexpected.push(outcome.sourceId);
        if (seen.has(outcome.sourceId)) duplicates.push(outcome.sourceId);
        seen.add(outcome.sourceId);
    }
    const missing = sourceIds.filter((id) => !seen.has(id));
    return { ok: duplicates.length === 0 && unexpected.length === 0 && missing.length === 0, duplicates, unexpected, missing };
}

export function isPublicIp(address) {
    if (!ipaddr.isValid(address)) return false;
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
        return parsed.toIPv4Address().range() === "unicast";
    }
    if (parsed.kind() === "ipv6") {
        if (!parsed.match(IPV6_GLOBAL_UNICAST) || BLOCKED_IPV6_RANGES.some((range) => parsed.match(range))) return false;
    }
    // Library classification is supplemented with the IANA IPv6 exclusions
    // above because deprecated site-local and some translation ranges are
    // intentionally reported as generic unicast by ipaddr.js.
    return parsed.range() === "unicast";
}

export function arePublicAddresses(addresses) {
    return Array.isArray(addresses) && addresses.length > 0 && addresses.every(({ address }) => isPublicIp(address));
}

async function resolvePublicAddresses(hostname) {
    const literalFamily = ipaddr.isValid(hostname) ? (ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6) : 0;
    const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true });
    if (!arePublicAddresses(addresses)) throw new Error("source hostname resolves to a non-public address");
    return addresses;
}

async function secureHttpsFetch(url, options) {
    const parsed = new URL(url);
    const approvedAddresses = await resolvePublicAddresses(parsed.hostname);
    return new Promise((resolve, reject) => {
        const request = httpsRequest(parsed, {
            method: "GET",
            headers: options.headers,
            signal: options.signal,
            lookup(_hostname, lookupOptions, callback) {
                const family = typeof lookupOptions === "number" ? lookupOptions : lookupOptions?.family;
                const eligible = family ? approvedAddresses.filter((entry) => entry.family === family) : approvedAddresses;
                if (eligible.length === 0) return callback(new Error("no approved public address matches the requested family"));
                if (typeof lookupOptions === "object" && lookupOptions?.all) return callback(null, eligible);
                const selected = eligible[0];
                return callback(null, selected.address, selected.family);
            },
        }, (response) => resolve({
            status: response.statusCode ?? 0,
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            headers: new Headers(response.headers),
            body: response,
        }));
        request.on("error", reject);
        request.end();
    });
}

async function readBoundedBody(response, maxBytes) {
    const chunks = [];
    let bytes = 0;
    if (response.body && Symbol.asyncIterator in response.body) {
        for await (const chunk of response.body) {
            const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                response.body.destroy?.();
                return { exceeded: true, bytes };
            }
            chunks.push(value);
        }
    } else if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                return { exceeded: true, bytes };
            }
            chunks.push(value);
        }
    } else {
        const value = new Uint8Array(await response.arrayBuffer());
        bytes = value.byteLength;
        if (bytes > maxBytes) return { exceeded: true, bytes };
        chunks.push(value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return { exceeded: false, bytes, body: new TextDecoder().decode(combined) };
}

export function createBoundedFetchAdapter(options = {}) {
    const fetchImpl = options.fetchImpl ?? secureHttpsFetch;
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    const limits = {
        maxRedirects: positiveInteger(options.maxRedirects, "maxRedirects", 3),
        maxBytes: positiveInteger(options.maxBytes, "maxBytes", 1_000_000),
        timeoutMs: positiveInteger(options.timeoutMs, "timeoutMs", 15_000),
        maxRetries: Number.isSafeInteger(options.maxRetries ?? 1) && (options.maxRetries ?? 1) >= 0 ? (options.maxRetries ?? 1) : 1,
    };
    return async function boundedFetch(source) {
        const started = Date.now();
        let url = source.url;
        let redirects = 0;
        let lastError;
        for (let retry = 0; retry <= limits.maxRetries; retry += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
            try {
                while (true) {
                    const response = await fetchImpl(url, {
                        redirect: "manual",
                        signal: controller.signal,
                        headers: { "User-Agent": "Orchard-Track-1/1.0 (+bounded read-only discovery)", Accept: "text/html,text/plain,application/json;q=0.8" },
                    });
                    if ([301, 302, 303, 307, 308].includes(response.status)) {
                        redirects += 1;
                        if (redirects > limits.maxRedirects) return { kind: "blocked", reason: "redirect-cap", status: response.status, redirects, bytes: 0, durationMs: Date.now() - started };
                        const location = response.headers.get("location");
                        if (!location) return { kind: "failed", reason: "redirect-without-location", status: response.status, redirects, bytes: 0, durationMs: Date.now() - started };
                        const next = new URL(location, url);
                        if (next.protocol !== "https:" || !source.policy.allowedHosts.includes(next.hostname.toLowerCase())) {
                            return { kind: "blocked", reason: "unapproved-redirect", status: response.status, finalUrl: next.href, redirects, bytes: 0, durationMs: Date.now() - started };
                        }
                        url = next.href;
                        continue;
                    }
                    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
                    if (declaredLength > limits.maxBytes) return { kind: "blocked", reason: "byte-cap", status: response.status, finalUrl: url, redirects, bytes: declaredLength, durationMs: Date.now() - started };
                    const bodyResult = await readBoundedBody(response, limits.maxBytes);
                    if (bodyResult.exceeded) return { kind: "blocked", reason: "byte-cap", status: response.status, finalUrl: url, redirects, bytes: bodyResult.bytes, durationMs: Date.now() - started };
                    const kind = response.status === 429 ? "rate-limited" : response.ok ? (redirects > 0 ? "redirected" : "success") : "failed";
                    return { kind, status: response.status, finalUrl: url, redirects, bytes: bodyResult.bytes, durationMs: Date.now() - started, body: bodyResult.body };
                }
            } catch (error) {
                lastError = error;
                if (retry < limits.maxRetries) await delay(Math.min(100 * (2 ** retry), 1_000));
            } finally {
                clearTimeout(timer);
            }
        }
        return { kind: "failed", reason: lastError?.name === "AbortError" ? "timeout" : "fetch-error", error: lastError?.message, redirects, bytes: 0, durationMs: Date.now() - started };
    };
}

function coverageFor(sources, outcomes) {
    const count = (name) => outcomes.filter((entry) => entry.outcome === name).length;
    return {
        approved_enabled_source_count: sources.filter((source) => source.enabled).length,
        attempted: outcomes.filter((entry) => !["skipped", "unevaluated"].includes(entry.outcome)).length,
        successfully_evaluated: count("success") + count("redirected"),
        redirected: count("redirected"),
        rate_limited: count("rate-limited"),
        failed: count("failed"),
        skipped: count("skipped"),
        blocked: count("blocked"),
        unevaluated: count("unevaluated"),
        stale: 0,
        exception_count: 0,
    };
}

function runRecord(options, registry, coverage, status, startedAt, completedAt) {
    const record = {
        schema_version: "1.0.0",
        run_id: options.runId,
        track: "track-1",
        trigger: { type: options.triggerType ?? "manual", reference: options.triggerReference ?? "local-controller" },
        status,
        configuration_digest: sha256Digest({ mode: options.mode, limits: options.limits ?? {}, subset: options.subsetIds ?? [] }),
        source_registry_digest: registry.digest,
        content_commit: options.contentCommit ?? "0000000000000000000000000000000000000000",
        implementation_commit: options.implementationCommit ?? "0000000000000000000000000000000000000000",
        model_role_map_digest: options.modelRoleMapDigest ?? sha256Digest("not-used-by-controller"),
        started_at: startedAt,
        completed_at: completedAt,
        actor: { kind: options.actorKind ?? "operator", reference: options.actorReference ?? "local-controller" },
        scope: { mode: options.mode, expected_count: coverage.approved_enabled_source_count, concurrency_cap: 1 },
        coverage,
        item_count: 0,
    };
    record.manifest_digest = sha256Digest(record);
    return record;
}

async function persistSourceResult(store, runId, source, result, observedAt) {
    const evidence = {
        sourceId: source.id,
        requestedUrl: source.url,
        finalUrl: result.finalUrl ?? null,
        status: result.status ?? null,
        outcome: result.outcome,
        redirects: result.redirects ?? 0,
        bytes: result.bytes ?? 0,
        durationMs: result.durationMs ?? 0,
        reason: result.reason ?? null,
        bodyDigest: result.body ? sha256Digest(result.body) : null,
    };
    const digest = sha256Digest(evidence);
    await store.recordObservation({ observation_id: generateUuidV7(), run_id: runId, evidence_reference: source.url, evidence_digest: digest, observed_at: observedAt, track: "track-1", source_id: source.id, evidence });
    await store.recordRunOutcome({ outcome_id: generateUuidV7(), run_id: runId, subject_key: source.id, outcome: result.outcome, exception_reason: result.reason ?? null, evidence_digest: digest, occurred_at: observedAt, source_id: source.id });
}

export async function runTrack1(options) {
    if (!["full", "subset", "dry-run"].includes(options.mode)) throw new TypeError("Track 1 mode must be full, subset, or dry-run");
    const registry = loadApprovedSourceRegistry(options.registry, { expectedDigest: options.registryDigest, allowLegacyMetadata: options.allowLegacyMetadata });
    const requested = options.mode === "subset" ? new Set(options.subsetIds ?? []) : null;
    if (requested) {
        for (const id of requested) if (!registry.sources.some((source) => source.id === id)) throw new TypeError(`subset source is not approved: ${id}`);
    }
    // Disabled registry entries are policy history, not approved enabled run
    // scope. Including them as "skipped" creates an outcome for a source that
    // is deliberately outside the run while approved_enabled_source_count
    // correctly excludes it. Select enabled sources before outcome accounting
    // so every persisted source outcome belongs to the declared run scope.
    const sources = registry.sources.filter((source) => source.enabled && (!requested || requested.has(source.id)));
    const runId = options.runId ?? generateUuidV7();
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const fetchAdapter = options.fetchAdapter ?? createBoundedFetchAdapter(options.limits);
    const maxSources = options.limits?.maxSources ?? Number.MAX_SAFE_INTEGER;
    const maxFailures = options.limits?.maxFailures ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.limits?.maxBytes ?? 1_000_000;
    const maxDurationMs = options.limits?.timeoutMs ?? 15_000;
    const outcomes = [];
    let attempted = 0;
    let failures = 0;

    if (options.mode !== "dry-run" && options.stateStore) {
        const initialCoverage = coverageFor(sources, []);
        await options.stateStore.recordRun(runRecord({ ...options, runId }, registry, initialCoverage, "running", startedAt, null));
    }

    for (const source of sources) {
        let result;
        if (options.mode === "dry-run") result = { outcome: "unevaluated", reason: "dry-run" };
        else if (attempted >= maxSources) result = { outcome: "unevaluated", reason: "source-cap" };
        else if (failures >= maxFailures) result = { outcome: "unevaluated", reason: "failure-cap" };
        else {
            attempted += 1;
            try {
                const fetched = await fetchAdapter(source, options.limits ?? {});
                const kind = TRACK_1_OUTCOMES.includes(fetched?.kind) ? fetched.kind : "failed";
                result = { ...fetched, outcome: kind, reason: fetched?.reason ?? (kind === "failed" ? "invalid-fetch-result" : undefined) };
                if ((result.bytes ?? 0) > maxBytes) result = { ...result, outcome: "blocked", reason: "byte-cap" };
                if ((result.durationMs ?? 0) > maxDurationMs) result = { ...result, outcome: "failed", reason: "duration-cap" };
                if (result.finalUrl) {
                    const host = new URL(result.finalUrl).hostname.toLowerCase();
                    if (!source.policy.allowedHosts.includes(host)) result = { ...result, outcome: "blocked", reason: "unapproved-redirect" };
                }
            } catch (error) {
                result = { outcome: "failed", reason: "adapter-error", error: error.message };
            }
            if (FAILURE_OUTCOMES.has(result.outcome)) failures += 1;
        }
        const outcome = { sourceId: source.id, ...result };
        outcomes.push(outcome);
        if (options.mode !== "dry-run" && options.stateStore) await persistSourceResult(options.stateStore, runId, source, outcome, (options.now?.() ?? new Date()).toISOString());
    }

    const reconciliation = reconcileTrack1Outcomes(sources.map((source) => source.id), outcomes);
    const coverage = coverageFor(sources, outcomes);
    const fullSuccess = options.mode === "full" && coverage.attempted >= 50 && coverage.approved_enabled_source_count >= 50 && coverage.unevaluated === 0 && failures <= maxFailures && reconciliation.ok;
    const status = fullSuccess ? "completed" : reconciliation.ok ? "incomplete" : "failed";
    const completedAt = (options.now?.() ?? new Date()).toISOString();
    const run = runRecord({ ...options, runId }, registry, coverage, status, startedAt, completedAt);
    if (options.mode !== "dry-run" && options.stateStore) await options.stateStore.finalizeRun(run);
    const candidates = dedupeCandidates(options.candidates ?? []);
    return { track: "track-1", mode: options.mode, status, registry: { version: registry.version, digest: registry.digest }, run, sources, outcomes, reconciliation, candidates, candidateBatches: partitionCandidates(candidates) };
}
