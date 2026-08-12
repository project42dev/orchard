#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStore } from "./lib/state-store.mjs";
import { runTrack2, verifyPinnedCommit } from "./lib/track-2-controller.mjs";

const HELP = `Track 2 canonical-corpus deep inspection

usage: inspect-canonical-corpus.mjs --track track-2 --mode <full|subset|dry-run>
       --platform-root <path> --content-commit <40-char-sha>
       [--item-ids kind:id,kind:id] [--partition-size 50] [--concurrency 4]
    [--implementation-commit SHA] [--trigger-type weekly|manual|replay]
    [--trigger-reference <text>] [--actor-kind scheduler|operator]
    [--actor-reference <text>]
       [--inspector <file-url-or-path>] [--state-db <path>] [--out <path>]

The inspector module must export inspect(item, context) and return evidence plus
one classification: addition, update, correction, replacement, removal, or
evidence-backed-no-change. Non-dry runs require --inspector and --state-db.
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

async function loadInspector(specifier) {
    const url = specifier.startsWith("file:") ? specifier : pathToFileURL(resolve(specifier)).href;
    const module = await import(url);
    if (typeof module.inspect !== "function") throw new TypeError("inspector module must export inspect(item, context)");
    return module.inspect;
}

export async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help")) { console.log(HELP); return; }
    const args = parseArgs(argv);
    if (args.track !== "track-2") throw new TypeError("--track must be track-2");
    if (!["full", "subset", "dry-run"].includes(args.mode)) throw new TypeError("--mode must be full, subset, or dry-run");
    if (args["trigger-type"] && !["weekly", "manual", "replay"].includes(args["trigger-type"])) throw new TypeError("--trigger-type must be weekly, manual, or replay");
    if (args["actor-kind"] && !["scheduler", "operator"].includes(args["actor-kind"])) throw new TypeError("--actor-kind must be scheduler or operator");
    for (const name of ["platform-root", "content-commit"]) if (!args[name]) throw new TypeError(`--${name} is required`);
    verifyPinnedCommit(args["platform-root"], args["content-commit"]);
    if (args.mode !== "dry-run" && (!args.inspector || !args["state-db"])) throw new TypeError("non-dry runs require --inspector and --state-db");
    const inspector = args.mode === "dry-run" ? null : await loadInspector(args.inspector);
    const store = args.mode === "dry-run" ? null : openStateStore(args["state-db"]);
    try {
        const result = await runTrack2({
            mode: args.mode,
            platformRoot: args["platform-root"],
            contentCommit: args["content-commit"],
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
        });
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
