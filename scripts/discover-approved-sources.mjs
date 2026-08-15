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
import { countProbe, toPlainText } from "./discover-content-opportunities.mjs";
import { partitionCandidates, runTrack1, semanticCandidateIdentity } from "./lib/track-1-controller.mjs";

const HELP = `Track 1 approved-source discovery

usage: discover-approved-sources.mjs --track track-1 --mode <full|subset|dry-run>
       --source-registry <path> --registry-digest sha256:<64 hex>
       --content-commit <40-char-sha>
       [--source-ids id,id] [--max-sources 100] [--max-failures 5]
       [--probes <path>] [--gap-threshold 0]
       [--run-id <uuidv7>] [--implementation-commit SHA]
       [--trigger-type monthly|weekly|manual|replay]
       [--trigger-reference <text>] [--actor-kind scheduler|operator]
       [--actor-reference <text>] [--state-db <path>] [--out <path>]

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
        let demand = 0;
        for (const outcome of withBody) {
            const hits = countProbe(toPlainText(outcome.body), probe);
            if (hits < 1) continue;
            demand += hits;
            evidence.push(`${outcome.sourceId}:${hits}`);
        }
        if (evidence.length <= gapThreshold) continue;
        const subject = probe.subject ?? probe.term;
        const surface = probe.surface ?? "learn";
        const candidate = {
            subject,
            surface,
            outcome: probe.outcome ?? `teach ${subject}`,
            scope: "content",
            term: probe.term,
            level: probe.level ?? null,
            demandOccurrences: demand,
            demandSourceCount: evidence.length,
            evidence: evidence.sort(),
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
        try {
            log("info", "track1.controller.started", { mode: args.mode });
            result = await runTrack1({
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
                stateStore: store,
            });
            log("info", "track1.survey.finished", {
                status: result.status,
                sources: result.sources.length,
                ...result.run?.coverage,
            });
        } catch (error) {
            throw stageError("ERR_ORCHARD_CONTROLLER_FAILED", error);
        }

        const now = new Date().toISOString();
        const synthesis = candidatesFromOutcomes({
            outcomes: result.outcomes,
            probes,
            sources: result.sources,
            gapThreshold: Number.parseInt(args["gap-threshold"] ?? "0", 10) || 0,
            now,
        });
        log("info", "track1.candidates.proposed", {
            candidates: synthesis.candidates.length,
            probes: synthesis.probeCount,
            sourcesWithBody: synthesis.sourcesWithBody,
        });

        // The survey result carries the fetched bodies. They are evidence for
        // the fetch, not something to publish into a run artifact, and some run
        // to a megabyte each. Record the size, drop the payload.
        const outcomes = result.outcomes.map(({ body, ...rest }) => ({ ...rest, bodyBytes: body?.length ?? 0 }));
        const enriched = {
            ...result,
            outcomes,
            candidates: synthesis.candidates,
            candidateBatches: partitionCandidates(synthesis.candidates),
        };

        writeControllerResult({ result: enriched, mode: args.mode, outputPath: args.out });
        if (result.status === "failed") process.exitCode = 2;
        else if (args.mode !== "dry-run" && result.status !== "completed") process.exitCode = 3;
    } finally {
        store?.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
