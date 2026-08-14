import assert from "node:assert/strict";
import { test } from "node:test";

import {
    canonicalJson,
    generateUuidV7,
    idempotencyKey,
    isUuidV7,
    lifecycleKey,
    revisionKey,
    sha256Digest,
    validateTargetPath
} from "../scripts/lib/identity.mjs";

const ITEM_ID = "018f1000-0000-7000-8000-000000000001";

test("UUIDv7 generation preserves timestamp, version, variant, and lexical validity", () => {
    const timestamp = 0x018f10000000;
    const uuid = generateUuidV7(timestamp, Uint8Array.from({ length: 10 }, (_, index) => index));

    assert.equal(uuid, "018f1000-0000-7001-8203-040506070809");
    assert.equal(isUuidV7(uuid), true);
    assert.equal(isUuidV7(uuid.toUpperCase()), false);
});

test("UUIDv7 validation rejects the wrong version and variant", () => {
    assert.equal(isUuidV7("018f1000-0000-6000-8000-000000000001"), false);
    assert.equal(isUuidV7("018f1000-0000-7000-7000-000000000001"), false);
    assert.equal(isUuidV7(ITEM_ID), true);
});

test("canonical JSON is independent of object insertion order", () => {
    const left = { zebra: 1, nested: { second: true, first: [3, 2, 1] } };
    const right = { nested: { first: [3, 2, 1], second: true }, zebra: 1 };

    assert.equal(canonicalJson(left), canonicalJson(right));
    assert.equal(sha256Digest(left), sha256Digest(right));
});

test("a one-byte input change produces a different digest", () => {
    assert.notEqual(sha256Digest(Buffer.from("artifact-a")), sha256Digest(Buffer.from("artifact-b")));
});

test("revision, lifecycle, and idempotency keys are deterministic", () => {
    assert.equal(revisionKey("track-1", ITEM_ID, 3), `track-1:${ITEM_ID}:r3`);
    assert.equal(lifecycleKey("track-1", ITEM_ID, 3, "publication"), `track-1:${ITEM_ID}:r3:publication`);
    assert.equal(idempotencyKey("gate-1", { revision: 3, item: ITEM_ID }), idempotencyKey("gate-1", { item: ITEM_ID, revision: 3 }));
});

test("safe canonical repository-relative target paths are accepted", () => {
    const path = "content/learning/example-module.json";
    assert.equal(validateTargetPath(path), path);
});

const unsafePaths = [
    ["../secrets.json", "traversal"],
    ["content/../secrets.json", "embedded traversal"],
    ["/etc/passwd", "POSIX absolute path"],
    ["C:/Windows/system.ini", "drive-qualified path"],
    ["content\\module.json", "backslash path"],
    [".git/config", "Git metadata"],
    ["content/.GIT/config", "case-insensitive Git metadata"],
    ["scripts/deploy.ps1", "PowerShell script"],
    ["content/module.js", "JavaScript file"],
    ["content/%2e%2e/secrets.json", "percent-encoded traversal"],
    ["content//module.json", "empty segment"],
    ["content/./module.json", "dot segment"],
    ["content/module.json/", "trailing slash"],
    ["content/cafe\u0301.json", "non-NFC path"]
];

for (const [path, description] of unsafePaths) {
    test(`target path validation rejects ${description}`, () => {
        assert.throws(() => validateTargetPath(path), TypeError);
    });
}
