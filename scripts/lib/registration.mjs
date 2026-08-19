// PUBLISHING A FILE IS NOT PUBLISHING CONTENT.
//
// Found live 2026-08-19, after the first publication run merged nine items into
// project42dev/project42-platform and reported nine successes. Every one of
// them was unreachable:
//
//   content/modules/discovery/*.json   no learning path listed them, and a
//                                      module page is served at
//                                      /learn/<pathId>/<moduleId>, so a module
//                                      no path lists has no URL at all
//   content/diagrams/*.mmd             absent from content/diagrams/catalogue.json,
//                                      which is the only thing the sites read to
//                                      know a diagram exists
//
// Nothing in the pipeline had ever written a registry entry. prepareRealCommit
// wrote exactly one blob at one path, item_revision.target_path is a single
// scalar, and no stage after it holds the content again. The file landed, the
// pull request merged, the release packaged it, and no reader could get to it.
//
// So registration is part of publication, in the same tree, in the same commit,
// under the same Gate 2 approval. A registry entry written afterwards would be
// a second unapproved commit, and a registry entry written and then not merged
// would leave the two halves of one publication in different states.
//
// A surface whose registration cannot be derived HOLDS the item and says what
// is missing. It does not publish half of it.

export class RegistrationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RegistrationError";
        this.code = code;
    }
}

// Where a surface's registry lives, or null for a surface that needs none.
//
// `guide` needs none: scripts/load-catalog.mjs discovers every .json under
// content/resources/ and each resource record carries its own id, category and
// level, so a resource indexes itself the moment it is committed. Checked
// against the platform tree on 2026-08-19: 91 resources, none of them listed
// anywhere else.
export const REGISTRY_BY_SURFACE = Object.freeze({
    learning: "content/catalog.json",
    guide: null,
    "guide-diagram": "content/diagrams/catalogue.json",
});

const CATALOGUE_ENTRY_FIELDS = Object.freeze([
    "id", "title", "category", "summary", "description", "altText", "caption", "takeaways", "source",
]);

// The categories content/diagrams/catalogue.json actually uses. A new one is a
// product decision, so an entry that invents one is refused rather than filed
// under a category no page lists.
export const DIAGRAM_CATEGORIES = Object.freeze([
    "Learning", "Research", "Agents", "Prompting", "Providers", "Safety", "Governance",
]);

/**
 * The contract surface an item is being published to, read from its own target
 * path rather than from a column.
 *
 * The path is the thing that decides what the consumer does with the bytes, and
 * it is already persisted on item_revision. Reading the surface from anywhere
 * else risks the two disagreeing, which is the same class of defect as
 * SURFACE_CRITERIA being keyed by config names while the lifecycle records
 * contract names: two vocabularies for one fact, and no check that they match.
 */
export function surfaceForTargetPath(targetPath) {
    const path = String(targetPath ?? "");
    if (/^content\/modules\//.test(path)) return "learning";
    if (/^content\/resources\//.test(path)) return "guide";
    if (/^content\/diagrams\//.test(path)) return "guide-diagram";
    throw new RegistrationError("registration.unrecognized-target", `no surface publishes to ${targetPath}`);
}

/**
 * The learning path a module belongs to, read from where the module is being
 * published. content/modules/<pathId>/<moduleId>.json is the platform's own
 * layout: all 72 modules that were reachable on 2026-08-19 sat in a directory
 * named exactly for the path that lists them.
 */
export function learningPathIdForTarget(targetPath) {
    const match = /^content\/modules\/([^/]+)\/[^/]+\.json$/.exec(String(targetPath ?? ""));
    if (!match) {
        throw new RegistrationError(
            "registration.unrecognized-module-path",
            `a learning module must be published to content/modules/<pathId>/<moduleId>.json, not ${targetPath}`,
        );
    }
    return match[1];
}

/** The diagram id and source filename, from where the diagram is being published. */
export function diagramIdForTarget(targetPath) {
    const match = /^content\/diagrams\/([^/]+)\.mmd$/.exec(String(targetPath ?? ""));
    if (!match) {
        throw new RegistrationError(
            "registration.unrecognized-diagram-path",
            `a diagram must be published to content/diagrams/<id>.mmd, not ${targetPath}`,
        );
    }
    return { id: match[1], source: `${match[1]}.mmd` };
}

function parseRegistry(path, text) {
    if (typeof text !== "string" || text.trim() === "") {
        throw new RegistrationError("registration.registry-missing", `${path} is not present on the base commit, so there is nothing to register into`);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new RegistrationError("registration.registry-unparsable", `${path} is not valid JSON: ${error.message}`);
    }
}

// Registries are committed with two-space indentation and a trailing newline.
// Reformatting one would produce a diff a reviewer cannot read at Gate 2.
function serialize(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Add a module to the learning path it is being published into.
 *
 * Idempotent: a module already listed returns the registry unchanged, so a
 * re-prepared revision of the same item does not add a duplicate id and does
 * not produce a spurious diff.
 */
export function registerLearningModule({ registryText, targetPath, artifact }) {
    const pathId = learningPathIdForTarget(targetPath);
    let module;
    try {
        module = JSON.parse(artifact);
    } catch (error) {
        throw new RegistrationError("registration.artifact-unparsable", `the module could not be parsed to find its id: ${error.message}`);
    }
    const moduleId = module?.id;
    if (typeof moduleId !== "string" || moduleId === "") {
        throw new RegistrationError("registration.artifact-has-no-id", "the module declares no id, so no learning path can list it");
    }

    const catalog = parseRegistry("content/catalog.json", registryText);
    const paths = Array.isArray(catalog.paths) ? catalog.paths : [];
    const target = paths.find((entry) => entry?.id === pathId);
    if (!target) {
        throw new RegistrationError(
            "registration.no-such-path",
            `content/catalog.json declares no learning path "${pathId}", so a module published to content/modules/${pathId}/ would have no URL. Declared paths: ${paths.map((entry) => entry?.id).join(", ") || "none"}`,
        );
    }
    const moduleIds = Array.isArray(target.moduleIds) ? target.moduleIds : [];
    if (moduleIds.includes(moduleId)) return registryText;

    return serialize({
        ...catalog,
        paths: paths.map((entry) => (entry === target ? { ...entry, moduleIds: [...moduleIds, moduleId] } : entry)),
    });
}

/**
 * Add a diagram to the diagram catalogue.
 *
 * The entry cannot be derived from mermaid source: a catalogue entry carries a
 * title, a category, a summary, a description, alt text, a caption and
 * takeaways, and alt text in particular is an accessibility obligation that
 * must be written rather than generated from node labels. So the entry has to
 * be authored, and an item without one holds.
 */
export function registerDiagram({ registryText, targetPath, entry }) {
    const { id, source } = diagramIdForTarget(targetPath);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new RegistrationError(
            "registration.no-catalogue-entry",
            `no catalogue entry was authored for ${source}, and a diagram absent from content/diagrams/catalogue.json is not published to anybody`,
        );
    }
    const candidate = { ...entry, id, source };
    const missing = CATALOGUE_ENTRY_FIELDS.filter((field) => {
        const value = candidate[field];
        if (field === "takeaways") return !Array.isArray(value) || value.length === 0;
        return typeof value !== "string" || value.trim() === "";
    });
    if (missing.length) {
        throw new RegistrationError("registration.incomplete-catalogue-entry", `the catalogue entry for ${source} is missing: ${missing.join(", ")}`);
    }
    if (!DIAGRAM_CATEGORIES.includes(candidate.category)) {
        throw new RegistrationError(
            "registration.unknown-diagram-category",
            `"${candidate.category}" is not a category any page lists. Use one of: ${DIAGRAM_CATEGORIES.join(", ")}`,
        );
    }

    const catalogue = parseRegistry("content/diagrams/catalogue.json", registryText);
    const diagrams = Array.isArray(catalogue.diagrams) ? catalogue.diagrams : [];
    const ordered = CATALOGUE_ENTRY_FIELDS.reduce((accumulator, field) => ({ ...accumulator, [field]: candidate[field] }), {});
    const existing = diagrams.findIndex((diagram) => diagram?.id === id);
    const next = existing >= 0
        ? diagrams.map((diagram, index) => (index === existing ? ordered : diagram))
        : [...diagrams, ordered];
    if (existing >= 0 && JSON.stringify(diagrams[existing]) === JSON.stringify(ordered)) return registryText;

    return serialize({ ...catalogue, diagrams: next });
}

/**
 * What must be committed alongside the artifact for it to be reachable.
 *
 * Returns null when the surface needs no registry entry, and throws a
 * RegistrationError naming exactly what is missing when the entry cannot be
 * built. The caller holds the item on that error rather than publishing an
 * artifact nothing indexes.
 */
export function registrationFor({ surface, targetPath, artifact, catalogueEntry = null }) {
    const registryPath = REGISTRY_BY_SURFACE[surface];
    if (registryPath === null) return null;
    if (registryPath === undefined) {
        throw new RegistrationError("registration.unknown-surface", `no registration rule is declared for surface "${surface}"`);
    }
    return {
        path: registryPath,
        apply: (registryText) => (surface === "learning"
            ? registerLearningModule({ registryText, targetPath, artifact })
            : registerDiagram({ registryText, targetPath, entry: catalogueEntry })),
    };
}
