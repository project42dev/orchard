// A copy of canonicalJson and sha256Digest from scripts/lib/identity.mjs.
//
// WHY A COPY, WHICH IS NORMALLY THE WRONG ANSWER. This directory is a
// protected adapter artifact: lib/protected-adapter.mjs hashes the entry file
// and every file it reaches, refuses any import that leaves this directory,
// and refuses any package import. That is the whole point of the pinning, so
// importing ../lib/identity.mjs is not available. The alternative would be to
// vendor the whole lib tree into the artifact and hash all of it, which makes
// the pinned surface far larger than the adapter.
//
// The drift risk is real and is handled by a test, not by hope:
// scripts/test-github-gate-adapter.mjs asserts these produce byte-identical
// digests to lib/identity.mjs across a fixture set. If the canonical form ever
// changes there, that test fails here.

import { createHash } from "node:crypto";

function serializeJson(value, seen) {
    if (value === null) return "null";
    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
            return JSON.stringify(Object.is(value, -0) ? 0 : value);
        case "object": {
            if (seen.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
            if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) {
                throw new TypeError("canonical JSON supports only plain objects and arrays");
            }
            seen.add(value);
            let result;
            if (Array.isArray(value)) {
                if (Object.keys(value).length !== value.length) {
                    throw new TypeError("canonical JSON does not support sparse arrays or array properties");
                }
                result = `[${value.map((entry) => serializeJson(entry, seen)).join(",")}]`;
            } else {
                const keys = Object.keys(value).sort();
                result = `{${keys.map((key) => {
                    const entry = value[key];
                    if (["undefined", "function", "symbol", "bigint"].includes(typeof entry)) {
                        throw new TypeError(`canonical JSON does not support property ${JSON.stringify(key)} of type ${typeof entry}`);
                    }
                    return `${JSON.stringify(key)}:${serializeJson(entry, seen)}`;
                }).join(",")}}`;
            }
            seen.delete(value);
            return result;
        }
        default:
            throw new TypeError(`canonical JSON does not support values of type ${typeof value}`);
    }
}

export function canonicalJson(value) {
    return serializeJson(value, new Set());
}

export function sha256Digest(value) {
    const input = typeof value === "string" || value instanceof Uint8Array ? value : canonicalJson(value);
    return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
