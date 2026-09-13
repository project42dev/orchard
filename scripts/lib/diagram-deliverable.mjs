// A DIAGRAM IS TWO DELIVERABLES AND THE PIPELINE HAS ONE CONTENT SLOT.
//
// FOUND BY EXECUTION 2026-09-12. generate-briefs.mjs FORM_INSTRUCTIONS.mermaid
// told the drafter to "Produce two things: 1. A Mermaid diagram source... 2. A
// catalogue entry carrying title, category, summary, description, altText,
// caption, and takeaways." The pipeline could consume exactly one of them.
// reconstructStageContent returns a single string, run-authoring.mjs commits
// that string verbatim to diagrams/<id>.mmd, and nothing anywhere parsed a
// catalogue entry back out of it. So registrationFor was called with no
// `catalogueEntry` at all, it defaulted to null, and registerDiagram threw
// `registration.no-catalogue-entry` for every diagram item that ever got that
// far. A drafter that instead obeyed the instruction literally and emitted both
// halves in one blob failed one step earlier, on
// `artifact-format.mermaid-unrecognized`, because a .mmd file that opens
// "## 1. Mermaid diagram source" or "```mermaid" is not mermaid. Both branches
// end the same way: no diagram item can ever be published. Measured in
// production: four distinct diagram items held on
// artifact-format.mermaid-unrecognized, none published, against eleven
// diagrams in the corpus that were all authored by hand.
//
// THE FIX IS AN ENVELOPE, NOT A SECOND SLOT. There is no second content slot
// to add: the drafter's output is chunked into `findings` by the PowerShell
// side, rejoined here, and hashed against the stage's own outputDigest, so the
// stage produces exactly one string by construction. What can change is the
// SHAPE of that one string. The drafter emits two fenced blocks -- one tagged
// `mermaid` carrying only the diagram source, one tagged
// `orchard-catalogue-entry` carrying exactly one JSON object -- and this module
// splits them. The .mmd file committed is the INNER text of the mermaid block,
// so it is pure mermaid and passes inspectArtifactFormat unchanged, and the
// catalogue entry arrives at registrationFor as a structured object.
//
// WHY A FENCE AND NOT A DELIMITER LINE. Fencing is what the drafters already
// do unprompted: one of the two diagram files merged on 2026-08-19 begins
// "```mermaid" and the other begins "## 1. Mermaid diagram source". A
// convention that fights that instinct loses; a convention that names it can
// be checked. The distinct tag on the second block is what makes the two
// halves unambiguous -- a bare ```json block could be anything, and a diagram
// whose catalogue entry was guessed from "the last JSON-looking thing" is the
// silently-wrong outcome this whole module exists to prevent.
//
// WHY TEXT OUTSIDE THE BLOCKS IS IGNORED. Same reason
// MERMAID_DIAGRAM_KEYWORDS is a generous list: a false refusal strands real
// work and a tolerated preamble costs nothing. Prose outside the fences can
// never become either deliverable -- the source is the mermaid block's text and
// the entry is the catalogue block's JSON -- so ignoring it weakens no
// guarantee. What is NOT tolerated is ambiguity: two mermaid blocks, two
// catalogue blocks, a missing block, or an entry that is not a complete,
// registrable catalogue record are all refusals with their own code.
//
// EVERY REFUSAL IS FREE AND EVERY REFUSAL IS LOUD. This runs at the same choke
// point inspectArtifactFormat does: the content is in hand, no publication
// credential has been minted, and no GitHub object exists. The caller holds the
// item with the code and the reason, exactly as it already holds one on a
// format mismatch. There is no default entry, no partial entry, and no path
// through this module that returns a diagram deliverable without a catalogue
// entry that registerDiagram would accept.

import { declaredFormatFor } from "./artifact-format.mjs";
import { RegistrationError, validateCatalogueEntry } from "./registration.mjs";

export class DiagramDeliverableError extends Error {
    constructor(code, message, { path = null, tagsFound = [] } = {}) {
        super(message);
        this.name = "DiagramDeliverableError";
        this.code = code;
        this.path = path;
        this.tagsFound = tagsFound;
    }
}

/** The info string on the block carrying the diagram source. */
export const MERMAID_FENCE_TAG = "mermaid";

/**
 * The info string on the block carrying the catalogue entry.
 *
 * Deliberately not `json`: a drafter writes JSON for half a dozen reasons and
 * the entry has to be the one block nothing else can be mistaken for.
 */
export const CATALOGUE_FENCE_TAG = "orchard-catalogue-entry";

const FENCE_OPEN = /^\s*(`{3,})[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;
const HEAD_LENGTH = 160;

function head(content) {
    const firstLine = String(content).split("\n", 1)[0].trim();
    return firstLine.length > HEAD_LENGTH ? `${firstLine.slice(0, HEAD_LENGTH)}...` : firstLine;
}

/**
 * Every fenced block in the text, in order, as `{ tag, body }`.
 *
 * Split on /\r?\n/ because this content has been through PowerShell chunking
 * and rejoining on its way here and its line endings are not guaranteed. A
 * closing fence must be at least as long as the one that opened the block, so a
 * ```` ```` ```` block may legally contain a ``` line -- which is how a drafter
 * shows a fence inside a caption without ending the block.
 */
export function fencedBlocks(content) {
    const lines = String(content ?? "").split(/\r?\n/);
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
        const open = FENCE_OPEN.exec(lines[index]);
        if (!open) {
            index += 1;
            continue;
        }
        const ticks = open[1];
        const tag = open[2] ?? "";
        const body = [];
        let cursor = index + 1;
        let closed = false;
        for (; cursor < lines.length; cursor += 1) {
            const close = /^\s*(`{3,})\s*$/.exec(lines[cursor]);
            if (close && close[1].length >= ticks.length) {
                closed = true;
                break;
            }
            body.push(lines[cursor]);
        }
        blocks.push({ tag, body: body.join("\n"), closed });
        index = cursor + 1;
    }
    return blocks;
}

function refusal({ path, code, reason, tagsFound, contentHead }) {
    return { checked: true, ok: false, path, code, reason, tagsFound, contentHead, source: null, catalogueEntry: null };
}

function describeTags(tagsFound) {
    if (!tagsFound.length) return "the output carries no fenced block at all";
    return `the fenced blocks present are tagged: ${tagsFound.map((tag) => (tag === "" ? "(untagged)" : tag)).join(", ")}`;
}

/**
 * Split a drafted diagram deliverable into the mermaid source that gets
 * committed and the catalogue entry that gets registered.
 *
 * Non-throwing, like inspectArtifactFormat, so the caller can hold the item and
 * report the reason rather than abort the whole run on one bad draft.
 *
 * A path that does not declare mermaid is passed through untouched:
 * `{ checked: false, ok: true, source: content, catalogueEntry: null }`. That
 * is what lets one call site in run-authoring.mjs cover every surface instead
 * of branching on the surface name, which is the same "read it off the path"
 * rule surfaceForTargetPath follows.
 *
 * On success the catalogue entry has ALREADY been validated by
 * registration.mjs's validateCatalogueEntry -- the single source of truth for
 * CATALOGUE_ENTRY_FIELDS and DIAGRAM_CATEGORIES -- so there is no way to obtain
 * a `catalogueEntry` from this function that registerDiagram would then refuse.
 * That check has to happen HERE and not only inside registerDiagram, because
 * registerDiagram runs inside prepareRealCommit's `registration.apply`, which
 * is after the publication token has been minted and after one GitHub read of
 * the registry. An incomplete entry is knowable the moment the draft is in
 * hand, and knowable-in-advance holds are paid for in advance or not at all.
 */
export function splitDiagramDeliverable({ path, content }) {
    if (declaredFormatFor(path) !== "mermaid") {
        return { checked: false, ok: true, path, code: null, reason: null, tagsFound: [], contentHead: null, source: content, catalogueEntry: null };
    }

    const contentHead = head(content);
    const blocks = fencedBlocks(content);
    const tagsFound = blocks.map((block) => block.tag.toLowerCase());
    const deny = (code, reason) => refusal({ path, code, reason, tagsFound, contentHead });

    const sources = blocks.filter((block) => block.tag.toLowerCase() === MERMAID_FENCE_TAG);
    const entries = blocks.filter((block) => block.tag.toLowerCase() === CATALOGUE_FENCE_TAG);

    if (sources.length === 0) {
        return deny(
            "diagram-deliverable.no-source-block",
            `${path} needs a \`\`\`${MERMAID_FENCE_TAG} block carrying the diagram source and there is none; ${describeTags(tagsFound)}. It begins: ${contentHead}`,
        );
    }
    if (sources.length > 1) {
        return deny(
            "diagram-deliverable.multiple-source-blocks",
            `${path} is one file and the output carries ${sources.length} \`\`\`${MERMAID_FENCE_TAG} blocks, so which one the reader would see is a guess`,
        );
    }
    // Trimmed, then given back exactly one trailing newline. All 11 published
    // .mmd files in project42dev/project42-content end with one, and a
    // committed blob that does not would open the first diagram this pipeline
    // ever prepares with "No newline at end of file" in the Gate 2 diff -- a
    // reviewer's first impression of the fix being a whitespace complaint.
    const body = sources[0].body.replace(/^\n+/, "").replace(/\s+$/, "");
    const source = body === "" ? "" : `${body}\n`;
    if (source === "") {
        return deny(
            "diagram-deliverable.empty-source-block",
            `${path} has a \`\`\`${MERMAID_FENCE_TAG} block and it is empty, so nothing would render`,
        );
    }

    if (entries.length === 0) {
        return deny(
            "diagram-deliverable.no-catalogue-block",
            `${path} needs a \`\`\`${CATALOGUE_FENCE_TAG} block carrying the catalogue entry and there is none; ${describeTags(tagsFound)}. `
                + "A diagram absent from diagrams/catalogue.json is not published to anybody, and the entry cannot be derived from the source: "
                + "alt text in particular is an accessibility obligation that has to be written.",
        );
    }
    if (entries.length > 1) {
        return deny(
            "diagram-deliverable.multiple-catalogue-blocks",
            `${path} registers one catalogue entry and the output carries ${entries.length} \`\`\`${CATALOGUE_FENCE_TAG} blocks, so which one is the record is a guess`,
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(entries[0].body);
    } catch (error) {
        return deny(
            "diagram-deliverable.catalogue-unparsable",
            `the \`\`\`${CATALOGUE_FENCE_TAG} block for ${path} is not valid JSON (${error.message}). It begins: ${head(entries[0].body)}`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return deny(
            "diagram-deliverable.catalogue-not-an-object",
            `the \`\`\`${CATALOGUE_FENCE_TAG} block for ${path} parses to a ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}, not one catalogue entry object`,
        );
    }

    // The same rule registerDiagram enforces, run here where it is free. A
    // RegistrationError is the honest code for it: it names the same defect the
    // registry would name, just earlier.
    try {
        validateCatalogueEntry({ entry: parsed, targetPath: path });
    } catch (error) {
        if (!(error instanceof RegistrationError)) throw error;
        return deny(error.code, error.message);
    }

    return { checked: true, ok: true, path, code: null, reason: null, tagsFound, contentHead, source, catalogueEntry: parsed };
}

/**
 * The throwing form, for a caller that must never let an unsplit deliverable
 * past. Returns the split on success.
 */
export function assertDiagramDeliverable({ path, content }) {
    const split = splitDiagramDeliverable({ path, content });
    if (!split.ok) {
        throw new DiagramDeliverableError(split.code, split.reason, { path: split.path, tagsFound: split.tagsFound });
    }
    return split;
}

export default {
    DiagramDeliverableError, MERMAID_FENCE_TAG, CATALOGUE_FENCE_TAG,
    fencedBlocks, splitDiagramDeliverable, assertDiagramDeliverable,
};
