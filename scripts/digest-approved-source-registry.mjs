#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadApprovedSourceRegistry } from "./lib/track-1-controller.mjs";

export function digestApprovedSourceRegistry(path) {
    if (!path) throw new TypeError("approved source registry path is required");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    return loadApprovedSourceRegistry(registry).digest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3) {
        console.error("usage: digest-approved-source-registry.mjs <registry.json>");
        process.exitCode = 1;
    } else {
        console.log(digestApprovedSourceRegistry(path));
    }
}
