// Refuse an artifact whose CONTENT does not match the format its own target
// path declares, before anything can commit it.
//
// FOUND LIVE 2026-08-19, on the only nine items this pipeline has ever
// published to project42dev/project42-platform (merged pull requests #153
// through #161). Every one of the nine carried the wrong format for the path
// it was written to:
//
//   content/modules/discovery/{evaluation,mcp,microsoft-foundry,orchestration,
//   rag,vector,voice-agent}.json
//       Seven files of raw Markdown. rag.json begins
//       "# Retrieval-augmented generation, embeddings, and vector search".
//       The platform's own scripts/load-catalog.mjs recursively finds every
//       .json under content/modules and JSON.parse's each one, so all seven
//       throw, the generated catalog cannot build, and NOTHING renders on
//       learn.project-42.dev: not the seven, and not the sixty-six modules
//       that were already correct either. One malformed file takes the whole
//       surface down.
//
//   content/diagrams/multi-agent.mmd          begins "## 1. Mermaid diagram source"
//   content/diagrams/retrieval-pipeline.mmd   begins "```mermaid"
//       Two files of Markdown prose wrapping a fenced block, where the
//       renderer is handed the file itself as diagram source.
//
// WHY A SEPARATE MODULE, AND WHY SO NARROW. This is not a schema validator
// and deliberately does not try to be one: it answers only the question a
// path can answer on its own, which is "could the consumer of this path even
// PARSE this?". A .json path is consumed by JSON.parse and a .mmd path is
// consumed by a mermaid renderer, so those two are checkable with certainty
// and everything else is left alone rather than guessed at. A check that
// silently measures the wrong thing is worse than no check.
//
// The complementary half of this fix lives in generate-briefs.mjs: the
// learning surface now instructs the drafter to emit LearningModule JSON in
// the first place. This module is the guard that holds when that instruction
// is ignored; that instruction is the reason there should be nothing to hold.

export class ArtifactFormatError extends Error {
    constructor(code, message, { path = null, format = null, contentHead = null } = {}) {
        super(message);
        this.name = "ArtifactFormatError";
        this.code = code;
        this.path = path;
        this.format = format;
        this.contentHead = contentHead;
    }
}

// The formats a target path can DECLARE, keyed by the extension that declares
// them. A path with any other extension (or none) declares nothing this module
// can check, and is passed through untouched.
export const DECLARED_FORMATS = Object.freeze({
    ".json": "json",
    ".mmd": "mermaid",
});

// Every diagram keyword mermaid opens a document with. The list is generous on
// purpose: a keyword missing from it becomes a FALSE refusal that strands real
// work, while a keyword that does not belong here costs nothing, because no
// Markdown document begins with any of them. Matching is case-insensitive for
// the same reason -- the job is to tell a diagram apart from prose, not to be a
// mermaid parser.
export const MERMAID_DIAGRAM_KEYWORDS = Object.freeze([
    "flowchart", "flowchart-elk", "graph",
    "sequenceDiagram", "classDiagram", "classDiagram-v2",
    "stateDiagram", "stateDiagram-v2", "erDiagram", "requirementDiagram",
    "journey", "gantt", "pie", "mindmap", "timeline", "quadrantChart",
    "gitGraph", "sankey-beta", "xychart-beta", "block-beta", "packet-beta",
    "architecture-beta",
    "C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
]);

// Anchored at the start of the line, and the keyword must end at a character
// that cannot continue a word. "graph TD" and "stateDiagram-v2" match; a
// sentence opening "Graphs are useful" does not.
const MERMAID_OPENING = new RegExp(
    `^(?:${MERMAID_DIAGRAM_KEYWORDS.map((keyword) => keyword.replace(/[-]/g, "\\-")).join("|")})(?![A-Za-z0-9])`,
    "i",
);

const HEAD_LENGTH = 160;

export function declaredFormatFor(path) {
    if (typeof path !== "string") return null;
    const dot = path.lastIndexOf(".");
    if (dot === -1) return null;
    return DECLARED_FORMATS[path.slice(dot).toLowerCase()] ?? null;
}

function head(content) {
    const firstLine = String(content).split("\n", 1)[0].trim();
    return firstLine.length > HEAD_LENGTH ? `${firstLine.slice(0, HEAD_LENGTH)}...` : firstLine;
}

/**
 * The first line of a mermaid document that carries the diagram keyword.
 *
 * Blank lines, `%%` comments, and `%%{init: ...}%%` directives are all legal
 * before the keyword and are skipped. So is a leading `---` YAML frontmatter
 * block, which mermaid documents its own configuration in: refusing one would
 * be refusing valid mermaid.
 */
export function firstDiagramLine(content) {
    const lines = String(content).split(/\r?\n/);
    let index = 0;
    if (lines[0]?.trim() === "---") {
        const closing = lines.findIndex((line, position) => position > 0 && line.trim() === "---");
        if (closing !== -1) index = closing + 1;
    }
    for (; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === "" || line.startsWith("%%")) continue;
        return line;
    }
    return null;
}

function refusal({ path, format, code, reason, contentHead }) {
    return { checked: true, ok: false, path, format, code, reason, contentHead };
}

/**
 * Non-throwing inspection, for a caller that wants to report the mismatch
 * rather than abort on it. Returns `{ checked: false, ok: true }` for a path
 * whose extension declares no checkable format.
 */
export function inspectArtifactFormat({ path, content }) {
    const format = declaredFormatFor(path);
    if (!format) {
        return { checked: false, ok: true, path, format: null, code: null, reason: null, contentHead: null };
    }
    if (typeof content !== "string" || content.trim() === "") {
        return refusal({
            path, format, code: "artifact-format.empty", contentHead: "",
            reason: `${path} declares ${format} and the content is empty, so nothing could ever parse it`,
        });
    }

    const contentHead = head(content);
    if (format === "json") {
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            return refusal({
                path, format, code: "artifact-format.json-unparsable", contentHead,
                reason: `${path} declares JSON and the content does not parse (${error.message}). It begins: ${contentHead}`,
            });
        }
        // A top-level scalar parses but is never a catalog artifact, and the
        // platform's loader would spread it into the catalog rather than
        // throw -- a silently wrong catalog instead of a loud failure, which
        // is the worse of the two outcomes.
        if (parsed === null || typeof parsed !== "object") {
            return refusal({
                path, format, code: "artifact-format.json-not-an-object", contentHead,
                reason: `${path} declares JSON and the content parses to a bare ${parsed === null ? "null" : typeof parsed}, not an object or array`,
            });
        }
        return { checked: true, ok: true, path, format, code: null, reason: null, contentHead };
    }

    const opening = firstDiagramLine(content);
    if (!opening || !MERMAID_OPENING.test(opening)) {
        return refusal({
            path, format, code: "artifact-format.mermaid-unrecognized", contentHead,
            reason: `${path} declares mermaid and its first meaningful line is not a mermaid diagram keyword. `
                + `It reads: ${opening === null ? "(nothing but blank lines and comments)" : opening.slice(0, HEAD_LENGTH)}`,
        });
    }
    return { checked: true, ok: true, path, format, code: null, reason: null, contentHead };
}

/**
 * The throwing form, for the choke points that must never let a mismatch
 * past. Returns the inspection on success so a caller can log what it proved.
 */
export function assertArtifactFormat({ path, content }) {
    const inspection = inspectArtifactFormat({ path, content });
    if (!inspection.ok) {
        throw new ArtifactFormatError(inspection.code, inspection.reason, {
            path: inspection.path, format: inspection.format, contentHead: inspection.contentHead,
        });
    }
    return inspection;
}

/**
 * The ONE deliberate opt-out, named so it can be grepped rather than hidden
 * behind a falsy default.
 *
 * The rejection-gate escalation path (run-authoring.mjs's
 * attemptRejectionRecovery) prepares a commit for a draft the ensemble
 * already REFUSED, so a human can see what was rejected at Gate 2. That
 * artifact is evidence of a failure, not a candidate for publication, and
 * refusing to prepare it would strand a twice-blocked item with no route to a
 * human at all -- the exact dead end the rejection gate exists to remove.
 * That path inspects the format anyway and puts the mismatch in front of the
 * reviewer in the rejection reason, so nothing is silently exempt.
 */
export const SKIP_ARTIFACT_FORMAT_CHECK = () => null;

export default {
    ArtifactFormatError, DECLARED_FORMATS, MERMAID_DIAGRAM_KEYWORDS,
    declaredFormatFor, firstDiagramLine, inspectArtifactFormat, assertArtifactFormat,
    SKIP_ARTIFACT_FORMAT_CHECK,
};
