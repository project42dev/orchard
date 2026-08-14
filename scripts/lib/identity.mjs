import { createHash, randomBytes } from "node:crypto";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const EXECUTABLE_EXTENSIONS = new Set([
    ".bat", ".cmd", ".com", ".cpl", ".dll", ".exe", ".hta", ".jar",
    ".js", ".jse", ".lnk", ".msi", ".msp", ".ps1", ".scr", ".sh",
    ".vbe", ".vbs", ".wsf"
]);

export function generateUuidV7(timestamp = Date.now(), entropy = randomBytes(10)) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
        throw new RangeError("timestamp must be an integer between 0 and 2^48-1 milliseconds");
    }
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 10) {
        throw new TypeError("entropy must be exactly 10 bytes");
    }

    const bytes = Buffer.alloc(16);
    let remaining = BigInt(timestamp);
    for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    Buffer.from(entropy).copy(bytes, 6);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value) {
    return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

export function assertUuidV7(value, label = "value") {
    if (!isUuidV7(value)) {
        throw new TypeError(`${label} must be a lowercase RFC 9562 UUIDv7 with an RFC 4122 variant`);
    }
    return value;
}

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
    const input = typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonicalJson(value);
    return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function assertKeyComponent(value, label) {
    if (typeof value !== "string" || !KEY_COMPONENT_PATTERN.test(value)) {
        throw new TypeError(`${label} must contain only lowercase letters, digits, dots, underscores, and hyphens`);
    }
    return value;
}

export function revisionKey(track, itemId, revision) {
    if (track !== "track-1" && track !== "track-2") throw new TypeError("track must be track-1 or track-2");
    assertUuidV7(itemId, "itemId");
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("revision must be a positive integer");
    return `${track}:${itemId}:r${revision}`;
}

export function lifecycleKey(track, itemId, revision, operation) {
    return `${revisionKey(track, itemId, revision)}:${assertKeyComponent(operation, "operation")}`;
}

export function idempotencyKey(namespace, identity) {
    return `${assertKeyComponent(namespace, "namespace")}:${sha256Digest(identity)}`;
}

export function validateTargetPath(value) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("target path must be a non-empty string");
    if (value !== value.normalize("NFC")) throw new TypeError("target path must use NFC Unicode normalization");
    if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("target path contains whitespace or control characters at an unsafe position");
    if (value.includes("\\")) throw new TypeError("target path must use forward slashes");
    if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) throw new TypeError("target path must be repository-relative");
    if (value.includes(":")) throw new TypeError("target path must not contain a URI scheme or Windows stream separator");
    if (value.endsWith("/") || value.includes("//")) throw new TypeError("target path must be canonical and contain no empty segments");

    let decoded;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw new TypeError("target path contains invalid percent encoding");
    }
    if (decoded !== value) throw new TypeError("target path must not contain percent-encoded characters");

    const segments = value.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) throw new TypeError("target path must not traverse directories");
    if (segments.some((segment) => segment.toLowerCase() === ".git")) throw new TypeError("target path must not address Git metadata");
    if (segments.some((segment) => /[. ]$/u.test(segment))) throw new TypeError("target path segments must not end in a dot or space");

    const fileName = segments.at(-1).toLowerCase();
    const extensionIndex = fileName.lastIndexOf(".");
    if (extensionIndex >= 0 && EXECUTABLE_EXTENSIONS.has(fileName.slice(extensionIndex))) {
        throw new TypeError("target path must not name an executable or script file");
    }
    return value;
}
