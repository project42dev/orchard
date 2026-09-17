// A currency finding about a catalogue entry publishes one reviewed entry.
// The rest of the registry is copied from the protected-main base tree at
// preparation time, so the drafter cannot rewrite unrelated lessons.
import { sha256Digest } from "./identity.mjs";

export const CATALOGUE_TARGETS = Object.freeze(["catalog.json", "diagrams/catalogue.json"]);

export class CatalogueDeliverableError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CatalogueDeliverableError";
        this.code = code;
    }
}

export function isCatalogueTarget(path) {
    return CATALOGUE_TARGETS.includes(path);
}

function selectorFor(path, canonicalId) {
    if (path === "catalog.json") {
        if (canonicalId === "catalogue:content") return { field: null, id: null };
        for (const [prefix, field] of [["learning-path:", "paths"], ["learning-module:", "modules"], ["guide:", "resources"]]) {
            if (canonicalId?.startsWith(prefix) && canonicalId.length > prefix.length) {
                return { field, id: canonicalId.slice(prefix.length) };
            }
        }
    }
    if (path === "diagrams/catalogue.json" && canonicalId === "catalogue:guide-diagrams") {
        return { field: null, id: null };
    }
    throw new CatalogueDeliverableError("catalogue.selector", `${canonicalId} is not an entry in ${path}`);
}

function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text, label) {
    let value;
    try { value = JSON.parse(text); }
    catch (error) { throw new CatalogueDeliverableError("catalogue.json", `${label} is not valid JSON: ${error.message}`); }
    if (!object(value)) throw new CatalogueDeliverableError("catalogue.object", `${label} must be one JSON object`);
    return value;
}

function sameShapeKind(left, right) {
    if (Array.isArray(left)) return Array.isArray(right);
    if (object(left)) return object(right);
    return typeof left === typeof right;
}

export function selectedCatalogueContent({ path, canonicalId, registry }) {
    const { field, id } = selectorFor(path, canonicalId);
    if (!object(registry)) throw new CatalogueDeliverableError("catalogue.registry", `${path} is not a JSON object`);
    if (field === null) return Object.fromEntries(Object.entries(registry).filter(([, value]) => !Array.isArray(value)));
    const entries = registry[field];
    if (!Array.isArray(entries)) throw new CatalogueDeliverableError("catalogue.registry", `${path} has no ${field} array`);
    const matches = entries.filter((entry) => entry?.id === id);
    if (matches.length !== 1) throw new CatalogueDeliverableError("catalogue.entry", `${path} must contain exactly one ${canonicalId} entry; found ${matches.length}`);
    return matches[0];
}

export function parseCatalogueDraft({ path, canonicalId, content }) {
    selectorFor(path, canonicalId);
    const draft = parseObject(content, "catalogue draft");
    const { id } = selectorFor(path, canonicalId);
    if (id !== null && draft.id !== id) {
        throw new CatalogueDeliverableError("catalogue.id", `draft for ${canonicalId} must retain id ${id}`);
    }
    return draft;
}

export function applyCatalogueDraft({ path, canonicalId, content, registryText, expectedEntryDigest = null }) {
    const draft = parseCatalogueDraft({ path, canonicalId, content });
    const registry = parseObject(registryText, path);
    const { field, id } = selectorFor(path, canonicalId);
    const baseline = selectedCatalogueContent({ path, canonicalId, registry });
    if (expectedEntryDigest && sha256Digest(baseline) !== expectedEntryDigest) {
        throw new CatalogueDeliverableError("catalogue.baseline-drift", `${canonicalId} changed since the inspected corpus; it needs a new inspection and decision`);
    }
    let next;
    if (field === null) {
        const current = selectedCatalogueContent({ path, canonicalId, registry });
        if (Object.keys(draft).sort().join("\0") !== Object.keys(current).sort().join("\0")) {
            throw new CatalogueDeliverableError("catalogue.top-level-keys", `draft for ${canonicalId} must contain exactly the existing non-array top-level keys`);
        }
        for (const [key, value] of Object.entries(draft)) {
            if (Array.isArray(value) || object(value)) throw new CatalogueDeliverableError("catalogue.top-level-value", `top-level ${key} must stay scalar`);
            if (!sameShapeKind(current[key], value)) throw new CatalogueDeliverableError("catalogue.field-type", `draft for ${canonicalId} changed the type of ${key}`);
        }
        next = { ...registry, ...draft };
    } else {
        const current = selectedCatalogueContent({ path, canonicalId, registry });
        for (const key of Object.keys(current)) {
            if (!(key in draft)) throw new CatalogueDeliverableError("catalogue.missing-field", `draft for ${canonicalId} omitted existing field ${key}`);
            if (!sameShapeKind(current[key], draft[key])) throw new CatalogueDeliverableError("catalogue.field-type", `draft for ${canonicalId} changed the type of ${key}`);
        }
        next = { ...registry, [field]: registry[field].map((entry) => entry.id === id ? draft : entry) };
    }
    const result = `${JSON.stringify(next, null, 2)}\n`;
    if (JSON.stringify(next) === JSON.stringify(registry)) {
        throw new CatalogueDeliverableError("catalogue.no-change", `draft for ${canonicalId} makes no change to ${path}`);
    }
    return result;
}
