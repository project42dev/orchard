// A drafter's refusal is not a draft, and it must never be offered for
// approval as one.
import { generateUuidV7, sha256Digest } from "./identity.mjs";
//
// FOUND LIVE 2026-09-13. Item 01a024de-1918-7baf-985c-252d89570314 was sent
// back at Gate 2, redrafted as revision 5, and re-announced on issue #238 with
// an approve command. What the drafter had written for revision 5 was:
//
//   {"status":"BLOCKED","workItem":"p42-update-01a024de-...",
//    "reason":"A schema-conforming correction cannot be produced from the
//     supplied material ...","unknowns":[...],"requiredInputs":[...]}
//
// That is one valid JSON object, so lib/artifact-format.mjs (which asks only
// "is this a JSON object?") passed it. Registration did not care. The
// ensemble's review said "factual review failed" and the escalation path put it
// in front of a human anyway. An approval would have committed a refusal note
// to resources/research-verification/fact-verification-workflow.json and the
// Field Guide catalogue loader would have read it as a resource.
//
// inspectDrafterRefusal() is the one test for that, used everywhere a draft can
// move towards Gate 2: run-authoring (the inline evidence step and the
// rejection-gate escalation), run-gate2-prep (evidence persisted by an earlier
// run), gate rendering, and gate decision capture.

// Every field the platform schemas require, taken from the FORM instructions in
// generate-briefs.mjs, which are themselves taken from project42-platform
// src/schema.ts. A resource or module missing one is refused by the catalogue
// loader, so it is not a conforming artifact whatever else it is.
export const REQUIRED_RESOURCE_FIELDS = Object.freeze([
    "id", "slug", "title", "summary", "category", "format", "audience", "level", "providers",
    "prerequisites", "owner", "reviewCadenceDays", "lastVerified", "tags", "sections", "sources",
]);
export const REQUIRED_MODULE_FIELDS = Object.freeze([
    "id", "title", "summary", "level", "providers", "estimatedMinutes", "objectives",
    "prerequisites", "sections", "knowledgeCheck", "sources",
]);

// The reason is written onto the blocked transition, whose contract caps it
// at 2000 characters (contracts/schemas/state-transition.schema.json). The
// full refusal document goes into an observation beside it.
export const MAX_REFUSAL_REASON_CHARS = 2000;
export const DRAFTER_REFUSAL_PREFIX = "drafter refused: ";
export const DRAFTER_REFUSAL_REFERENCE_PREFIX = "orchard/drafter-refusal/";

function requiredFieldsFor(path) {
    if (typeof path !== "string" || !path.endsWith(".json")) return null;
    const normalized = path.replace(/^content\//, "");
    if (normalized.startsWith("resources/")) return REQUIRED_RESOURCE_FIELDS;
    if (normalized.startsWith("modules/")) return REQUIRED_MODULE_FIELDS;
    return null;
}

function strings(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()) : [];
}

/**
 * Returns null for a draft, or a refusal record:
 *   { code, reason, requiredInputs, unknowns, document }
 *
 * `document` is the parsed refusal object when there is one, so the full text
 * can be recorded without re-parsing.
 */
export function inspectDrafterRefusal({ path, content }) {
    if (typeof content !== "string" || content.trim() === "") return null;
    const trimmed = content.trim();

    // A prose refusal: the researcher's READINESS: BLOCKED convention, or a
    // STATUS: BLOCKED line, opening the output.
    const prose = /^(?:\*\*)?(?:STATUS|READINESS)(?:\*\*)?\s*:\s*BLOCKED\b/i.exec(trimmed);
    if (prose) {
        return { code: "drafter-refusal.status-blocked", reason: trimmed.slice(0, 1500), requiredInputs: [], unknowns: [], document: null };
    }

    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const requiredInputs = strings(parsed.requiredInputs);
    const unknowns = strings(parsed.unknowns);
    if (typeof parsed.status === "string" && /^blocked$/i.test(parsed.status.trim())) {
        return {
            code: "drafter-refusal.status-blocked",
            reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "the drafter returned status BLOCKED with no reason",
            requiredInputs, unknowns, document: parsed,
        };
    }
    if ((requiredInputs.length || unknowns.length) && typeof parsed.id !== "string") {
        return {
            code: "drafter-refusal.required-inputs",
            reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "the drafter returned a list of required inputs instead of an artifact",
            requiredInputs, unknowns, document: parsed,
        };
    }
    const required = requiredFieldsFor(path);
    if (required) {
        const missing = required.filter((field) => parsed[field] === undefined || parsed[field] === null);
        if (missing.length > 0) {
            return {
                code: "drafter-refusal.non-conforming",
                reason: `the drafter's output is a JSON object but not a conforming ${required === REQUIRED_RESOURCE_FIELDS ? "Resource" : "LearningModule"}: it is missing ${missing.join(", ")}`,
                requiredInputs, unknowns, document: parsed,
            };
        }
    }
    return null;
}

/** The single-line reason recorded on the blocked transition, within its cap. */
export function refusalTransitionReason(refusal) {
    const parts = [`${DRAFTER_REFUSAL_PREFIX}${refusal.reason}`];
    if (refusal.requiredInputs.length) parts.push(`Required inputs: ${refusal.requiredInputs.join("; ")}`);
    if (refusal.unknowns.length) parts.push(`Unknowns: ${refusal.unknowns.join("; ")}`);
    parts.push(`(${refusal.code})`);
    const text = parts.join(" | ");
    return text.length <= MAX_REFUSAL_REASON_CHARS ? text : `${text.slice(0, MAX_REFUSAL_REASON_CHARS - 1)}…`;
}

export function drafterRefusalReference(itemId, revision) {
    return `${DRAFTER_REFUSAL_REFERENCE_PREFIX}${itemId}:r${Number(revision)}`;
}

/** Persist the refusal and move its current revision to blocked. */
export async function recordDrafterRefusal({ store, itemId, revision, runId, fromState, refusal, target, now, actor }) {
    const record = {
        kind: "drafter-refusal", item_id: itemId, item_revision: Number(revision), target,
        code: refusal.code, reason: refusal.reason, required_inputs: refusal.requiredInputs,
        unknowns: refusal.unknowns, document: refusal.document, recorded_at: now,
    };
    await store.recordObservation({
        observation_id: generateUuidV7(), run_id: runId, item_id: itemId,
        item_revision: Number(revision), evidence_reference: drafterRefusalReference(itemId, revision),
        evidence_digest: sha256Digest(record), observed_at: now, drafter_refusal: record,
    });
    await store.recordTransition({
        schema_version: "1.0.0", transition_id: generateUuidV7(), run_id: runId,
        item_id: itemId, item_revision: Number(revision), from_state: fromState,
        to_state: "blocked", cause: "policy-block", reason: refusalTransitionReason(refusal),
        actor, occurred_at: now, correlation_id: generateUuidV7(),
    });
    return { item: itemId, revision: Number(revision), code: refusal.code, reason: refusal.reason,
        requiredInputs: refusal.requiredInputs, unknowns: refusal.unknowns };
}

/**
 * The refusal carried by a Gate 2 manifest item, if any: the content it would
 * publish, or the rejected draft an escalation shows.
 */
export function manifestItemRefusal(item) {
    const target = item?.target?.path;
    return inspectDrafterRefusal({ path: target, content: item?.content })
        ?? inspectDrafterRefusal({ path: target, content: item?.rejected_draft });
}
