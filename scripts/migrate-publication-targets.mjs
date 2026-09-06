#!/usr/bin/env node
// Operator report for the publication-target repoint.
//
// The repoint itself is schema/migrations/011 and it runs automatically:
// openStateStore migrates before it opens, so the first job to start after the
// migration deploys corrects the whole historical backlog with no operator
// involved. Nothing here has to be run for the items to become publishable.
//
// This exists for the half a WHERE clause cannot do: telling a human which
// items migration 011 deliberately refused, and exactly why, using
// contentRepositoryPathFor's own refusal message.
//
//   node scripts/migrate-publication-targets.mjs --state-db <path>
//
// It writes nothing of its own. Opening the database does apply any pending
// migration, so point it at a copy if you want to inspect a database as it
// stands before 011.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStateStore } from "./lib/state-store.mjs";
import { reportUnmappedPublicationTargets } from "./lib/publication-target-migration.mjs";

function argOf(argv, name, fallback = null) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
}

export async function main(argv = process.argv.slice(2), { log = (level, event, detail) => console.log(JSON.stringify({ level, event, ...detail })) } = {}) {
    const dbPath = argOf(argv, "state-db");
    if (!dbPath) throw Object.assign(new Error("migrate-publication-targets requires --state-db"), { code: "ERR_ORCHARD_CONFIGURATION" });
    const migrate = !argv.includes("--no-migrate");
    const store = openStateStore(resolve(dbPath), { migrate });
    try {
        return reportUnmappedPublicationTargets({ store, log });
    } finally {
        store.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
