#!/usr/bin/env node
// Track 1 production controller: survey the approved sources, record what each
// one did, and propose candidates from what came back.
//
// WHY THIS FILE EXISTS. The production runtime resolves each track to an entry
// point and calls `module.main(args, { log })`. Track 2 pointed at
// inspect-canonical-corpus.mjs, which exports exactly that. Track 1 pointed at
// discover-content-opportunities.mjs, which is a LOCAL tool: it does not export
// main, its main takes no arguments and reads process.argv itself, and it
// requires --registry --corpus --probes, none of which the runtime passes. So
// `module.main` was undefined and Track 1 died with a TypeError 13ms after the
// controller loaded, on its first ever production execution, 2026-08-15.
//
// It was never caught because Track 1 had never been deployed, and every check
// asserted that its absence was correct. The two files stay separate because
// they do different jobs: that one measures a local corpus for gaps, this one
// runs the governed survey of approved external sources.
//
// The survey logic itself was already written and tested in
// lib/track-1-controller.mjs. All that was missing was something to call it.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeControllerResult } from "./lib/controller-output.mjs";
import { openStateStore } from "./lib/state-store.mjs";
import { sha256Digest } from "./lib/identity.mjs";
import { countProbe, toPlainText } from "./discover-content-opportunities.mjs";
import { partitionCandidates, runTrack1, semanticCandidateIdentity } from "./lib/track-1-controller.mjs";
import { persistDiscoveryItems, surfaceForProbe } from "./lib/gate-queue.mjs";

const HELP = `Track 1 approved-source discovery

usage: discover-approved-sources.mjs --track track-1 --mode <full|subset|dry-run>
       --source-registry <path> --registry-digest sha256:<64 hex>
       --content-commit <40-char-sha>
       [--source-ids id,id] [--max-sources 100] [--max-failures 5]
       [--min-coverage 0.9]
       [--probes <path>] [--gap-threshold 0]
       [--run-id <uuidv7>] [--implementation-commit SHA]
       [--trigger-type monthly|weekly|manual|replay]
       [--trigger-reference <text>] [--actor-kind scheduler|operator]
       [--actor-reference <text>] [--state-db <path>] [--out <path>]

Every run reports attempted against successfully evaluated, names every source
that produced nothing and why, and does not report success below --min-coverage
of the enabled sources (default 0.9).

Only sources that are enabled AND carry a reviewed policy are fetched; the
registry loader rejects anything else before a request is made. Non-dry runs
require --state-db and --out. A dry run validates and enumerates without
fetching, opening state, or writing files.`;

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (!key.startsWith("--")) throw new TypeError(`unexpected argument ${key}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new TypeError(`${key} needs a value`);
        result[key.slice(2)] = value;
        index += 1;
    }
    return result;
}

function stageError(code, cause) {
    const error = new Error(code, { cause });
    error.code = code;
    return error;
}

function positiveInteger(raw, name) {
    if (!/^[1-9]\d*$/.test(raw ?? "")) throw new TypeError(`--${name} must be a positive integer`);
    return Number.parseInt(raw, 10);
}

function buildLimits(args) {
    const limits = {};
    if (args["max-sources"] !== undefined) limits.maxSources = positiveInteger(args["max-sources"], "max-sources");
    if (args["max-failures"] !== undefined) limits.maxFailures = positiveInteger(args["max-failures"], "max-failures");
    return limits;
}

function minCoverage(args) {
    if (args["min-coverage"] === undefined) return undefined;
    const value = Number.parseFloat(args["min-coverage"]);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError("--min-coverage must be a fraction from 0 through 1");
    return value;
}

/**
 * Say what the survey covered, and name what it did not.
 *
 * The run used to log seven aggregate counters. That is enough to see that
 * something produced nothing and not enough to see WHICH something, so a source
 * that had been dead for a month looked exactly like a source with no news --
 * the silent-success failure this project keeps hitting. Every silent source is
 * now logged by id, with the reason, on every run, whether or not the threshold
 * is met.
 */
export function reportCoverage(result, log) {
    const attribution = result.attribution ?? { silent: [], retired: [], causes: {}, coverage: null };
    const verdict = attribution.coverage;
    log("info", "track1.coverage", {
        enabled: verdict?.expected ?? null,
        retired: attribution.retired.length,
        attempted: result.run?.coverage?.attempted ?? null,
        successfullyEvaluated: verdict?.evaluated ?? null,
        silent: attribution.silent.length,
        ratio: verdict ? Number(verdict.ratio.toFixed(4)) : null,
        threshold: verdict?.minCoverage ?? null,
        met: verdict?.met ?? null,
        causes: attribution.causes,
    });
    for (const entry of attribution.silent) {
        log(verdict?.met ? "warn" : "error", "track1.source.silent", {
            sourceId: entry.sourceId,
            label: entry.label,
            url: entry.url,
            outcome: entry.outcome,
            reason: entry.reason,
            status: entry.status,
        });
    }
    // Retirement lifts the ratio by shrinking the denominator, so what was
    // dropped is stated next to it rather than left for someone to notice.
    if (attribution.retired.length > 0) {
        log("info", "track1.sources.retired", {
            count: attribution.retired.length,
            sourceIds: attribution.retired.map((entry) => entry.sourceId),
        });
    }
    if (verdict && !verdict.met) {
        log("error", "track1.coverage.below-threshold", {
            evaluated: verdict.evaluated,
            enabled: verdict.expected,
            ratio: Number(verdict.ratio.toFixed(4)),
            threshold: verdict.minCoverage,
            effect: "the run surveyed less of its approved list than the threshold allows and is not reported as completed",
        });
    }
    return verdict;
}

/**
 * Turn what the survey fetched into candidates.
 *
 * A candidate is a claim that a subject is in demand and under-served: the
 * probe term appears on approved sources and at or below the gap threshold in
 * our own corpus. This measures the demand half, which is what Track 1 can see;
 * the supply half comes from the corpus and is recorded as evidence for the
 * human at Gate 1 rather than decided here.
 *
 * Returns { candidates, probeCount, sourcesWithBody }. It NEVER returns an
 * empty list quietly: the caller logs why the list is the size it is, because
 * "found nothing" and "measured nothing" produce identical output otherwise
 * and this project has been burned by exactly that more than once.
 */
export function candidatesFromOutcomes({ outcomes, probes, sources, gapThreshold = 0, now }) {
    const byId = new Map(sources.map((source) => [source.id, source]));
    const withBody = outcomes.filter((outcome) => typeof outcome.body === "string" && outcome.body.length > 0);
    const candidates = [];
    for (const probe of probes) {
        const evidence = [];
        const evidenceRefs = [];
        let demand = 0;
        for (const outcome of withBody) {
            const hits = countProbe(toPlainText(outcome.body), probe);
            if (hits < 1) continue;
            demand += hits;
            evidence.push(`${outcome.sourceId}:${hits}`);
            // The digest is of the exact bytes the count was taken from, so the
            // Gate 1 approval binds to what was actually read rather than to
            // the URL, which serves different content tomorrow.
            evidenceRefs.push({ reference: outcome.finalUrl ?? byId.get(outcome.sourceId)?.url ?? outcome.sourceId, digest: sha256Digest(outcome.body) });
        }
        if (evidence.length <= gapThreshold) continue;
        const subject = probe.subject ?? probe.title ?? probe.term;
        // The contract surface, not the probe's own vocabulary. item-record
        // allows learning, guide, and guide-diagram and nothing else, and the
        // surface is part of the semantic identity, so getting it from the
        // probe kinds here keeps identity and lifecycle speaking one language.
        const surface = surfaceForProbe(probe);
        const candidate = {
            subject,
            surface,
            // The learning path this probe proposes into, declared on the probe
            // itself. Load-bearing: without it a learning candidate has nowhere
            // real to be published. See targetForCandidate in gate-queue.mjs.
            pathId: probe.pathId ?? null,
            outcome: probe.outcome ?? `teach ${subject}`,
            scope: "content",
            title: probe.title ?? subject,
            term: probe.term,
            level: probe.level ?? null,
            demandOccurrences: demand,
            demandSourceCount: evidence.length,
            evidence: evidence.sort(),
            evidenceRefs,
            observedAt: now,
            sourceLabels: evidence.map((entry) => byId.get(entry.split(":")[0])?.label ?? entry.split(":")[0]).sort(),
        };
        candidates.push({ ...candidate, semanticIdentity: semanticCandidateIdentity(candidate) });
    }
    return { candidates, probeCount: probes.length, sourcesWithBody: withBody.length };
}

function loadProbes(path, log) {
    if (!path) {
        // Not an error: a survey-only run is legitimate. It is stated loudly
        // because a run that proposes nothing because it measured nothing looks
        // exactly like a run that proposes nothing because there are no gaps.
        log("warn", "track1.probes.absent", { effect: "sources surveyed and recorded; no candidates proposed" });
        return [];
    }
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const probes = Array.isArray(doc) ? doc : doc.probes;
    if (!Array.isArray(probes) || probes.length === 0) throw new TypeError(`probe file ${path} has no probes array`);
    return probes;
}

/**
 * What the run tells the operator through its exit code.
 *
 * 4 is new and is the point of this function: a run that surveyed less of its
 * approved list than the threshold allows must not exit 0, even in a subset run
 * where "completed" was never on offer. Coverage is the verdict that has to
 * escape the process, because a scheduler reads an exit code and nothing else.
 *
 * A dry run is exempt. It deliberately evaluates nothing, so measuring its
 * coverage against a threshold would fail every validation run for being what
 * it was asked to be.
 */
export function exitCodeFor(result, mode) {
    if (result.status === "failed") return 2;
    if (mode !== "dry-run" && result.attribution?.coverage && !result.attribution.coverage.met) return 4;
    if (mode !== "dry-run" && result.status !== "completed") return 3;
    return 0;
}

export async function main(argv = process.argv.slice(2), options = {}) {
    const log = options.log ?? (() => { });
    if (argv.includes("--help")) { console.log(HELP); return; }
    const args = parseArgs(argv);
    if (args.track !== "track-1") throw new TypeError("--track must be track-1");
    if (!["full", "subset", "dry-run"].includes(args.mode)) throw new TypeError("--mode must be full, subset, or dry-run");
    if (args["trigger-type"] && !["monthly", "weekly", "manual", "replay"].includes(args["trigger-type"])) throw new TypeError("--trigger-type must be monthly, weekly, manual, or replay");
    if (args["actor-kind"] && !["scheduler", "operator"].includes(args["actor-kind"])) throw new TypeError("--actor-kind must be scheduler or operator");
    for (const name of ["source-registry", "registry-digest", "content-commit"]) {
        if (!args[name]) throw new TypeError(`--${name} is required`);
    }
    if (args.mode !== "dry-run" && (!args["state-db"] || !args.out)) throw new TypeError("non-dry runs require --state-db and --out");

    let registry;
    try {
        registry = JSON.parse(readFileSync(args["source-registry"], "utf8"));
    } catch (error) {
        throw stageError("ERR_ORCHARD_CONFIGURATION", error);
    }
    const probes = loadProbes(args.probes, log);

    let store;
    try {
        store = args.mode === "dry-run" ? null : openStateStore(args["state-db"]);
        if (store) log("info", "track1.state.opened");
    } catch (error) {
        throw stageError("ERR_ORCHARD_STATE_OPEN_FAILED", error);
    }

    try {
        let result;
        let synthesis = { candidates: [], probeCount: probes.length, sourcesWithBody: 0 };
        // Synthesis and persistence run inside the controller, between the last
        // fetch and the run being finalized. Before this the candidates were
        // computed after runTrack1 returned and written to a file that nothing
        // reads, so a successful discovery run left the gate holding nothing.
        const synthesize = async ({ outcomes, sources, runId, stateStore, mode }) => {
            const observedAt = new Date().toISOString();
            synthesis = candidatesFromOutcomes({
                outcomes,
                probes,
                sources,
                gapThreshold: Number.parseInt(args["gap-threshold"] ?? "0", 10) || 0,
                now: observedAt,
            });
            log("info", "track1.candidates.proposed", {
                candidates: synthesis.candidates.length,
                probes: synthesis.probeCount,
                sourcesWithBody: synthesis.sourcesWithBody,
            });
            if (mode === "dry-run" || !stateStore) {
                log("info", "gate1.items.skipped", { mode, effect: "dry run proposes candidates and holds nothing" });
                return { candidates: synthesis.candidates, items: null };
            }
            const items = await persistDiscoveryItems({
                store: stateStore,
                runId,
                track: "track-1",
                candidates: synthesis.candidates,
                now: observedAt,
                log,
            });
            return { candidates: synthesis.candidates, items };
        };
        try {
            log("info", "track1.controller.started", { mode: args.mode });
            result = await runTrack1({
                synthesize,
                mode: args.mode,
                registry,
                registryDigest: args["registry-digest"],
                // Production never accepts a registry without a reviewed
                // policy per enabled source. These are the same options the
                // runtime already used to verify the artifact it downloaded.
                allowLegacyMetadata: false,
                requirePolicyReview: true,
                subsetIds: (args["source-ids"] ?? "").split(",").map((value) => value.trim()).filter(Boolean),
                contentCommit: args["content-commit"],
                runId: args["run-id"],
                implementationCommit: args["implementation-commit"],
                triggerType: args["trigger-type"],
                triggerReference: args["trigger-reference"],
                actorKind: args["actor-kind"],
                actorReference: args["actor-reference"],
                // Absent keys, not undefined values. The run record is hashed
                // through canonicalJson, which refuses undefined outright, so
                // passing an unset cap through would fail the whole run at
                // digest time rather than defaulting.
                limits: buildLimits(args),
                minCoverage: minCoverage(args),
                stateStore: store,
            });
            log("info", "track1.survey.finished", {
                status: result.status,
                sources: result.sources.length,
                ...result.run?.coverage,
            });
            reportCoverage(result, log);
        } catch (error) {
            throw stageError("ERR_ORCHARD_CONTROLLER_FAILED", error);
        }

        // The survey result carries the fetched bodies. They are evidence for
        // the fetch, not something to publish into a run artifact, and some run
        // to a megabyte each. Record the size, drop the payload.
        const outcomes = result.outcomes.map(({ body, ...rest }) => ({ ...rest, bodyBytes: body?.length ?? 0 }));
        const enriched = {
            ...result,
            outcomes,
            // Named, in the artifact as well as the log, so the record of the
            // run answers "which sources produced nothing" without a re-run.
            attribution: result.attribution,
            candidates: synthesis.candidates,
            candidateBatches: partitionCandidates(synthesis.candidates),
            // What the gate now holds because of this run. The output file is a
            // record of what happened, not the place work waits: the items are
            // in the state database and the gate reads them from there.
            gate1: result.items
                ? { held: result.items.persisted, alreadyKnown: result.items.skipped, failed: result.items.failed }
                : { held: 0, alreadyKnown: 0, failed: 0 },
        };

        writeControllerResult({ result: enriched, mode: args.mode, outputPath: args.out });
        process.exitCode = exitCodeFor(result, args.mode);
    } finally {
        store?.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
