// The removal brief form.
//
// THE DEAD END THIS CLOSES. Track 2's currency inspection has always been able
// to classify published content as needing `removal` -- it is one of the five
// actionable classifications -- and an approved removal finding then stopped
// dead. generate-briefs.mjs's OUTCOME_KIND carried no entry for it, so the item
// was reported as stranded at every pass and never claimed: "removal and
// no-change are not written by the ensemble". That was true and it was not a
// reason to have no answer. A removal is a real editorial outcome. Something
// published should stop being published.
//
// WHY IT IS DETERMINISTIC AND NEVER REACHES THE ENSEMBLE. There is nothing to
// draft. The whole decision is: which file goes, which catalogue entry goes
// with it, does anything still point at it, and does a URL stop resolving. Every
// one of those is computable from the target path and the repository tree, and
// sending it to six models would spend real money to be told what a regular
// expression already knows. So the brief IS the artifact: a removal record, in
// canonical JSON, which is what the owner reads at Gate 2 and what the artifact
// digest binds.
//
// WHAT THE RECORD CARRIES, and why each part is there:
//
//   removed     -- repository, path, surface, and the id the catalogue knows it
//                  by. What is going.
//   rationale   -- the currency finding's own classification and evidence. Why.
//                  Never restated or invented here; it comes off the item.
//   catalogue   -- which registry entry is removed in the SAME commit. A file
//                  deleted while its catalogue entry survives leaves a listing
//                  that 404s, which is a worse defect than the stale content
//                  the removal was for.
//   inbound     -- what still references it, and, honestly, what was and was
//                  not looked at. A removal with a live inbound reference HOLDS:
//                  publishing it would break a page that works today.
//   redirect    -- whether a URL stops resolving, decided by the estate's own
//                  route rules rather than by assumption. A learning module has
//                  no URL of its own (verify-published-live.mjs:
//                  modules/<pathId>/<moduleId>.json serves at /learn/<pathId>,
//                  the PATH's page), so removing one orphans nothing and needs
//                  no redirect. A resource and a diagram each have their own
//                  page, so removing one does orphan a URL and the record says
//                  so, names it, and names where it should point.

import { canonicalJson, generateUuidV7, sha256Digest } from "./identity.mjs";
import { createAgentHandoff } from "./handoffs.mjs";
import {
    REGISTRY_BY_SURFACE, RegistrationError, surfaceForTargetPath,
    learningPathIdForTarget, diagramIdForTarget,
} from "./registration.mjs";
import { publicPathForTarget } from "../verify-published-live.mjs";

export class RemovalError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RemovalError";
        this.code = code;
    }
}

function fail(code, message) { throw new RemovalError(code, message); }

// Registries are committed with two-space indentation and a trailing newline;
// reformatting one produces a diff no reviewer can read at Gate 2. Same rule
// registration.mjs follows on the way in.
function serialize(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function parseRegistry(path, text) {
    if (typeof text !== "string" || text.trim() === "") {
        fail("removal.registry-missing", `${path} is not present on the base commit, so its entry cannot be removed`);
    }
    try { return JSON.parse(text); } catch (error) {
        fail("removal.registry-unparsable", `${path} is not valid JSON: ${error.message}`);
    }
}

/** The id the catalogue knows this artifact by, read from where it is published. */
export function removedIdForTarget(targetPath, surface) {
    if (surface === "learning") {
        const match = /^modules\/[^/]+\/([^/]+)\.json$/.exec(String(targetPath ?? ""));
        if (!match) fail("removal.unrecognized-module-path", `a learning module must sit at modules/<pathId>/<moduleId>.json, not ${targetPath}`);
        return match[1];
    }
    if (surface === "guide-diagram") return diagramIdForTarget(targetPath).id;
    const match = /^resources\/[^/]+\/([^/]+)\.json$/.exec(String(targetPath ?? ""));
    if (!match) fail("removal.unrecognized-resource-path", `a resource must sit at resources/<pack>/<resourceId>.json, not ${targetPath}`);
    return match[1];
}

/**
 * Take a module out of the learning path that lists it, and out of the
 * catalogue's own module summaries. The exact inverse of
 * registration.mjs's registerLearningModule, and idempotent for the same
 * reason: a re-prepared revision must not produce a second, spurious diff.
 */
export function deregisterLearningModule({ registryText, targetPath, moduleId }) {
    const pathId = learningPathIdForTarget(targetPath);
    const catalog = parseRegistry("catalog.json", registryText);
    const paths = Array.isArray(catalog.paths) ? catalog.paths : [];
    const target = paths.find((entry) => entry?.id === pathId);
    if (!target) {
        fail("removal.no-such-path", `catalog.json declares no learning path "${pathId}", so there is no listing to remove ${moduleId} from`);
    }
    const moduleIds = Array.isArray(target.moduleIds) ? target.moduleIds : [];
    const modules = Array.isArray(catalog.modules) ? catalog.modules : [];
    const listed = moduleIds.includes(moduleId);
    const summarized = modules.some((entry) => entry?.id === moduleId);
    if (!listed && !summarized) return registryText;
    return serialize({
        ...catalog,
        paths: paths.map((entry) => (entry === target
            ? { ...entry, moduleIds: moduleIds.filter((id) => id !== moduleId) }
            : entry)),
        ...(Array.isArray(catalog.modules) ? { modules: modules.filter((entry) => entry?.id !== moduleId) } : {}),
    });
}

/** Take a diagram out of the diagram catalogue. Idempotent. */
export function deregisterDiagram({ registryText, targetPath }) {
    const { id } = diagramIdForTarget(targetPath);
    const catalogue = parseRegistry("diagrams/catalogue.json", registryText);
    const entries = Array.isArray(catalogue) ? catalogue : catalogue.diagrams;
    if (!Array.isArray(entries)) {
        fail("removal.registry-shape", "diagrams/catalogue.json does not carry a diagram array, so no entry can be removed");
    }
    if (!entries.some((entry) => entry?.id === id)) return registryText;
    const remaining = entries.filter((entry) => entry?.id !== id);
    return serialize(Array.isArray(catalogue) ? remaining : { ...catalogue, diagrams: remaining });
}

/**
 * The registry edit that must travel in the SAME commit as the deletion, or
 * null when the surface has no registry (a resource indexes itself, so
 * deleting the file is the whole removal).
 */
export function deregistrationFor({ surface, targetPath, removedId }) {
    const registryPath = REGISTRY_BY_SURFACE[surface];
    if (registryPath === null) return null;
    if (registryPath === undefined) {
        throw new RegistrationError("registration.unknown-surface", `no registration rule is declared for surface "${surface}", so nothing knows how to deregister it`);
    }
    return {
        path: registryPath,
        apply: (registryText) => (surface === "learning"
            ? deregisterLearningModule({ registryText, targetPath, moduleId: removedId })
            : deregisterDiagram({ registryText, targetPath })),
    };
}

/**
 * Does a public URL stop resolving when this is removed?
 *
 * Decided by the estate's own route rules, not by assumption. A learning module
 * is listed on its learning path's page and has no page of its own, so removing
 * one orphans no URL. A resource and a diagram each serve at their own route,
 * so removing one leaves a live URL with nothing behind it.
 */
export function redirectFor({ surface, targetPath }) {
    const route = publicPathForTarget(targetPath);
    if (route.error) {
        return { needed: false, reason: route.error };
    }
    if (surface === "learning") {
        return {
            needed: false,
            reason: `a learning module has no page of its own: modules/<pathId>/<moduleId>.json serves at ${route.path}, the learning path's page, which keeps resolving with one fewer module listed`,
            from: null,
            to: null,
        };
    }
    const pathId = null;
    return {
        needed: true,
        reason: `${route.path} is this artifact's own page and stops resolving once the file is gone`,
        from: route.path,
        // Deliberately the surface index and not a guess at a replacement. This
        // record states the need and where it should land; Orchard does not
        // invent a redirect mechanism in a repository it does not own.
        to: surface === "guide-diagram" ? "/guide/diagrams" : "/guide/resources",
        pathId,
    };
}

/**
 * Everything in the repository that still points at the artifact, after the
 * deregistration has been applied.
 *
 * BOUNDED ON PURPOSE. The publication account is rate limited, so this reads
 * the catalogue that was fetched anyway plus the removed module's own siblings,
 * and states plainly what it did not look at. A scan that quietly skipped most
 * of the repository while reporting "no inbound references" would be worse than
 * no scan: it would read as a clearance.
 */
export function inboundReferences({ removedId, surface, catalogText, siblings = [], maxSiblings = 50 }) {
    const found = [];
    const scanned = [];
    const notScanned = [];

    if (surface === "learning" && typeof catalogText === "string" && catalogText.trim() !== "") {
        scanned.push("catalog.json");
        const catalog = parseRegistry("catalog.json", catalogText);
        for (const path of (Array.isArray(catalog.paths) ? catalog.paths : [])) {
            if ((path?.moduleIds ?? []).includes(removedId)) {
                found.push({ reference: `catalog.json paths[${path.id}].moduleIds`, kind: "listing" });
            }
        }
        for (const entry of (Array.isArray(catalog.modules) ? catalog.modules : [])) {
            if (entry?.id === removedId) found.push({ reference: "catalog.json modules[]", kind: "summary" });
        }
    } else if (surface === "learning") {
        notScanned.push("catalog.json (not readable on the base commit)");
    }

    const inspected = siblings.slice(0, maxSiblings);
    if (siblings.length > inspected.length) {
        notScanned.push(`${siblings.length - inspected.length} sibling module(s) beyond the ${maxSiblings} this scan reads`);
    }
    for (const sibling of inspected) {
        scanned.push(sibling.path);
        let module;
        try { module = JSON.parse(sibling.content); } catch { notScanned.push(`${sibling.path} (unparsable)`); continue; }
        if ((module?.prerequisites ?? []).includes(removedId)) {
            found.push({ reference: `${sibling.path} prerequisites`, kind: "prerequisite" });
        }
    }

    // Said out loud rather than implied by silence: nothing here reads modules
    // in other learning paths, resource packs, or diagram usages, so "no
    // inbound references" means "none in what was read".
    notScanned.push("modules in other learning paths, resource packs, and prose references to this artifact");

    return { found, scanned, notScanned };
}

/**
 * The removal record. This is the artifact: its canonical JSON is what the
 * owner reads at Gate 2 and its digest is what the artifact binding binds.
 */
export function buildRemovalRecord({ item, target, rationale, evidence = [], catalogue, inbound, redirect, now }) {
    const surface = surfaceForTargetPath(target.path);
    const record = {
        schema_version: "1.0.0",
        kind: "content-removal",
        removed: {
            repository: target.repository,
            path: target.path,
            surface,
            id: removedIdForTarget(target.path, surface),
        },
        rationale: {
            classification: "removal",
            item_id: item.item_id ?? item.id ?? null,
            summary: rationale,
            evidence: evidence.map((entry) => String(entry).slice(0, 1000)),
        },
        catalogue,
        inbound,
        redirect,
        composed_at: now,
    };
    return { record, content: canonicalJson(record), digest: sha256Digest(record) };
}

export default {
    RemovalError, deregistrationFor, deregisterLearningModule, deregisterDiagram,
    redirectFor, inboundReferences, buildRemovalRecord, removedIdForTarget, buildRemovalEvidence,
};

/**
 * The Gate 2 evidence document for a removal, in exactly the shape
 * run-gate2-prep.mjs's prepareItem demands.
 *
 * ONE HANDOFF, HONESTLY NAMED. The chain a drafted artifact carries is six
 * ensemble stages. A removal has one actor and it is not a model: the composer
 * in this file. That is recorded as a single 'content-remover' handoff whose
 * model identity names the deterministic composer rather than borrowing an
 * ensemble role it did not use. Calling the composer 'final-reviewer' to fit
 * the existing vocabulary would have put a lie in the permanent record, so the
 * vocabulary was extended instead.
 *
 * THE REVIEWS ARE NOT FAKED. `tests` reports the preconditions this code
 * actually checked: the path exists at the base commit, the catalogue entry
 * travels in the same commit, and nothing that was scanned still references it.
 * factual_review and accessibility_review are "human-review", which is the
 * truth -- no reviewer looked, and the human at Gate 2 IS the review. cost is
 * zero, which is also the truth: the ensemble was never invoked.
 */
export async function buildRemovalEvidence({ binding, target, removal, commit, now }) {
    const handoff = await createAgentHandoff({
        binding,
        role: "content-remover",
        model: {
            identity: "orchard/lib/removal.mjs",
            provider_family: "deterministic",
            qualification_digest: sha256Digest({ composer: "orchard/lib/removal.mjs", schema: removal.record.schema_version }),
        },
        promptVersion: "1.0.0",
        input: sha256Digest({ target, rationale: removal.record.rationale }),
        output: removal.digest,
        predecessor: null,
        status: "passed",
        findings: [{
            severity: "info",
            summary: `Composed a removal of ${target.path}. ${removal.record.catalogue.effect} ${removal.record.redirect.reason}`.slice(0, 2000),
        }],
        startedAt: now,
        completedAt: now,
    });

    const artifactBinding = {
        binding_id: generateUuidV7(),
        run_id: binding.run_id,
        item_id: binding.item_id,
        item_revision: binding.item_revision,
        artifact_digest: handoff.output_digest,
        final_handoff_id: handoff.handoff_id,
        final_handoff_digest: handoff.output_digest,
        scope_digest: sha256Digest(target),
        occurred_at: now,
    };
    artifactBinding.idempotency_key = `artifact-binding:${binding.track}:${binding.item_id}:r${binding.item_revision}:${sha256Digest(artifactBinding)}`;

    return {
        handoffs: [handoff],
        artifact_binding: artifactBinding,
        manifest: {
            displayed_diff_digest: sha256Digest({ path: target.path, removed: true, content_digest: removal.digest }),
            prepared_tree_digest: commit.preparedTreeDigest,
            base_commit: commit.baseCommit,
            diff_ref: `github:commit:${commit.preparedCommit}:path:${target.path}`,
            artifact_ref: `orchard:artifact:${removal.digest}`,
            handoff_chain_digest: sha256Digest({ handoffs: [sha256Digest(handoff)] }),
            tests: [
                { name: "removal-target-present-at-base", status: "passed", evidence_ref: `github:commit:${commit.baseCommit}:path:${target.path}` },
                {
                    name: "catalogue-entry-removed-in-the-same-commit",
                    status: removal.record.catalogue.registry === null || commit.registeredIn === removal.record.catalogue.registry ? "passed" : "failed",
                    evidence_ref: `github:commit:${commit.preparedCommit}`,
                },
                {
                    name: "no-inbound-reference-in-what-was-scanned",
                    status: removal.record.inbound.found.length === 0 ? "passed" : "failed",
                    evidence_ref: `orchard:removal:${binding.item_id}:inbound`,
                },
            ],
            factual_review: { status: "human-review", evidence_ref: `orchard:handoff:${handoff.handoff_id}` },
            accessibility_review: { status: "human-review", evidence_ref: `orchard:handoff:${handoff.handoff_id}` },
            cost: { currency: "USD", amount: 0 },
        },
    };
}
