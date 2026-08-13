#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createValidatedResultInspector } from "./lib/built-in-inspector.mjs";
import { openStateStore } from "./lib/state-store.mjs";
import { enumerateCanonicalCorpus, runTrack2, TRACK_2_EXPECTED_CANONICAL_ITEMS, verifyPinnedCommit } from "./lib/track-2-controller.mjs";

const HELP = `Track 2 canonical-corpus deep inspection

usage: inspect-canonical-corpus.mjs --track track-2 --mode <full|subset|dry-run>
       --platform-root <path> --content-commit <40-char-sha>
       [--item-ids kind:id,kind:id] [--partition-size 50] [--concurrency 4]
    [--run-id <uuidv7>] [--started-at <iso-8601>]
    [--implementation-commit SHA] [--trigger-type weekly|manual|replay]
    [--trigger-reference <text>] [--actor-kind scheduler|operator]
    [--actor-reference <text>]
    [--inspection-results <json-path>] [--state-db <path>] [--out <path>]

Inspection results are untrusted data, never executable modules. Each result must
bind to the canonical stable ID, item digest, source digest, inspector digest,
evidence, and one supported classification. Non-dry runs require
--inspection-results and --state-db.
Dry-run only validates the pin, enumerates, and partitions; it does not inspect,
open workflow state, write output files, or call external integrations.`;

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

export async function main(argv = process.argv.slice(2), options = {}) {
    const log = options.log ?? (() => { });
    if (argv.includes("--help")) { console.log(HELP); return; }
    const args = parseArgs(argv);
    if (args.track !== "track-2") throw new TypeError("--track must be track-2");
    if (!["full", "subset", "dry-run"].includes(args.mode)) throw new TypeError("--mode must be full, subset, or dry-run");
    if (args["trigger-type"] && !["weekly", "manual", "replay"].includes(args["trigger-type"])) throw new TypeError("--trigger-type must be weekly, manual, or replay");
    if (args["actor-kind"] && !["scheduler", "operator"].includes(args["actor-kind"])) throw new TypeError("--actor-kind must be scheduler or operator");
    for (const name of ["platform-root", "content-commit"]) if (!args[name]) throw new TypeError(`--${name} is required`);
    verifyPinnedCommit(args["platform-root"], args["content-commit"]);
    if (args.inspector) throw new TypeError("--inspector is prohibited because executable inspector modules are not a trust boundary");
    if (args.mode !== "dry-run" && (!args["inspection-results"] || !args["state-db"])) throw new TypeError("non-dry runs require --inspection-results and --state-db");
    const expectedItems = args.mode === "dry-run" ? [] : enumerateCanonicalCorpus(args["platform-root"]);
    if (args.mode === "full" && expectedItems.length !== TRACK_2_EXPECTED_CANONICAL_ITEMS) throw new Error(`full Track 2 requires exactly ${TRACK_2_EXPECTED_CANONICAL_ITEMS} canonical items; enumerated ${expectedItems.length}`);
    const expectedStableIds = args.mode === "subset" ? (args["item-ids"] ?? "").split(",").map((value) => value.trim()).filter(Boolean) : expectedItems.map((item) => item.stableId);
    let inspector;
    try {
        inspector = args.mode === "dry-run" ? null : createValidatedResultInspector({ resultPath: args["inspection-results"], expectedStableIds, maxResults: expectedStableIds.length });
        log("info", "track2.results.validated", { expectedCount: expectedStableIds.length });
    } catch (error) {
        throw stageError("ERR_ORCHARD_RESULTS_INVALID", error);
    }
    let store;
    try {
        store = args.mode === "dry-run" ? null : openStateStore(args["state-db"]);
        if (store) log("info", "track2.state.opened");
    } catch (error) {
        throw stageError("ERR_ORCHARD_STATE_OPEN_FAILED", error);
    }
    try {
        let result;
        try {
            log("info", "track2.controller.started");
            result = await runTrack2({
                mode: args.mode,
                platformRoot: args["platform-root"],
                contentCommit: args["content-commit"],
                runId: args["run-id"],
                startedAt: args["started-at"],
                implementationCommit: args["implementation-commit"],
                triggerType: args["trigger-type"],
                triggerReference: args["trigger-reference"],
                actorKind: args["actor-kind"],
                actorReference: args["actor-reference"],
                subsetIds: (args["item-ids"] ?? "").split(",").map((value) => value.trim()).filter(Boolean),
                partitionSize: Number.parseInt(args["partition-size"] ?? "50", 10),
                concurrency: Number.parseInt(args.concurrency ?? "4", 10),
                inspector,
                stateStore: store,
                onStage: (event, fields) => log("info", event, fields),
            });
            log("info", "track2.controller.finished", { status: result.status, inspected: result.coverage.inspected });
        } catch (error) {
            throw stageError("ERR_ORCHARD_CONTROLLER_FAILED", error);
        }
        const output = `${JSON.stringify(result, null, 2)}\n`;
        if (args.mode !== "dry-run" && args.out) writeFileSync(args.out, output, "utf8");
        else process.stdout.write(output);
        if (result.status === "failed") process.exitCode = 2;
        else if (args.mode !== "dry-run" && result.status !== "completed") process.exitCode = 3;
    } finally {
        store?.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
