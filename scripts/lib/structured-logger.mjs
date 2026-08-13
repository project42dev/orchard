const SENSITIVE_KEY = /(authorization|cookie|credential|key|password|secret|signature|token|connection.?string)/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/giu;
const QUERY_SECRET = /([?&](?:sig|signature|token|key|api[_-]?key|client_secret)=)[^&#\s]*/giu;
const API_KEY = /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/gu;

function sanitizeString(value) {
    return value.replace(BEARER, "Bearer [REDACTED]").replace(JWT, "[REDACTED]").replace(URL_CREDENTIALS, "$1[REDACTED]@").replace(QUERY_SECRET, "$1[REDACTED]").replace(API_KEY, "[REDACTED]");
}

function sanitize(value, seen = new Set()) {
    if (value === null || ["boolean", "number"].includes(typeof value)) return value;
    if (typeof value === "string") return sanitizeString(value);
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const output = Array.isArray(value) ? value.map((entry) => sanitize(entry, seen)) : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry, seen)]));
    seen.delete(value);
    return output;
}

export function createStructuredLogger({ write = (line) => process.stdout.write(line), now = () => new Date(), base = {} } = {}) {
    return function log(level, event, fields = {}) {
        if (!["debug", "info", "warn", "error"].includes(level)) throw new TypeError("unsupported log level");
        if (typeof event !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(event)) throw new TypeError("event must be a stable lowercase identifier");
        const record = sanitize({ timestamp: now().toISOString(), level, event, ...base, ...fields });
        write(`${JSON.stringify(record)}\n`);
        return record;
    };
}
