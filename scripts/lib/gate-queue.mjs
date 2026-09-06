// Turn discovery candidates into lifecycle items that a gate can hold.
//
// WHY THIS FILE EXISTS, and why it is not the obvious one line of SQL.
//
// Track 1 surveyed 78 approved sources on 2026-08-15 and proposed 13
// candidates. They went into a controller output file that nothing reads. Gate
// 1 announced nothing, because nothing was held, because nothing had ever been
// written into the lifecycle. That is the whole point of Orchard and it was
// missing.
//
// THE TRAP THAT COST THE FIRST ATTEMPT. There are two work queues in this
// repository and they are not the same queue:
//
//   work_item      in schema/content-db.sql. Created by build-content-db.mjs
//                  when it compiles a LOCAL content checkout. States are
//                  gate1-pending / queued / gate1-denied. gate1-review.mjs and
//                  generate-briefs.mjs read it. It is a local authoring tool.
//
//   workflow_item  in schema/migrations/002-two-track-authority.sql. Created by
//                  migrateContentDb, which is what openStateStore runs. This is
//                  the ONLY item table that exists in the deployed state
//                  database, because no migration ever runs content-db.sql.
//
// Nothing in the container has ever created a work_item row and nothing ever
// will, because the table is not there. Persisting into it would have produced
// a run that reported success and held nothing, which is the exact failure this
// file exists to end. Everything here targets workflow_item.
//
// The lifecycle is declared in lib/state-machine.mjs and is entered at the top:
// observed -> proposed -> gate1-pending. A candidate is an observation that has
// been turned into a proposal; it is not approved by arriving, and the only
// thing that moves it past gate1-pending is a recorded human decision.

import { generateUuidV7, sha256Digest } from "./identity.mjs";

// Fixed by contract, not by configuration: gate-1-issue-manifest.schema.json
// pins target.repository to this exact value, so a deployer setting would only
// be able to produce manifests that fail validation.
//
// Changed 2026-09-05 from project42dev/project42-platform. The curriculum is no
// longer in the product repository; project42dev/project42-content is the
// canonical home and the platform consumes it. Publishing into the platform is
// what produced the content drift, so the contract now refuses it.
export const TARGET_REPOSITORY = "project42dev/project42-content";

// How a recorded gate manifest entry is found again. It is a prefix on the
// observation's evidence reference rather than a separate table, because the
// entry IS evidence about the item: what was proposed, on what grounds, at what
// estimated cost.
export const GATE_MANIFEST_REFERENCE_PREFIX = "orchard/gate-manifest/";

// The contract surfaces, and the probe vocabulary that maps onto them.
// contracts/schemas/item-record.schema.json allows exactly three, and the probe
// file speaks a different three. A probe that declares no kinds is a learning
// probe, which is what the file's own default means.
const SURFACE_BY_PROBE_KIND = Object.freeze({
    learn: "learning",
    learning: "learning",
    "field-guide": "guide",
    guide: "guide",
    "visual-guide": "guide-diagram",
    "guide-diagram": "guide-diagram",
});

// Where a surface's content actually lives in the CONTENT repository, checked
// against the project42dev/project42-content tree on 2026-09-05. The path is a
// proposal: Gate 1 is where a human moves it if the placement is wrong.
//
// A wrong directory here is invisible: publication succeeds, the file lands,
// and nothing indexes it. The content repository has NO content/ prefix - the
// trees are modules/, resources/ and diagrams/ at the repository root, unlike
// the platform repository this pipeline used to write to, which nests them
// under content/. The prefix was dropped on 2026-09-05 with the repoint; a
// content/ path in the content repository would create a phantom tree that no
// loader reads.
//
// FIXED 2026-09-06. A learning candidate used to be filed under
// modules/discovery/, and "discovery" is not a declared learning path in
// project42dev/project42-content catalog.json -- nor was it in the platform
// repository's content/catalog.json before the repoint, so this predated it.
// Every Track 1 learning item was therefore refused by registerLearningModule
// with registration.no-such-path, and had one slipped past, it would have been
// unreachable: /learn/discovery returns 404, confirmed live on 2026-09-06.
//
// The fix is not to pick a different placeholder. A module is reachable only at
// the learning path that lists it, so the path is part of what is being
// proposed, and a probe now declares it (seed-inputs/probes.json, `pathId`).
// A learning candidate with no declared path is REFUSED here, naming the probe,
// because filing it somewhere that looks harmless is the silent success this
// project's own rules forbid.
//
// The guide surface is deliberately not treated the same way. Its registry is
// null: the catalogue loader discovers every .json under resources/ and each
// resource carries its own id, so a resource indexes itself and its route is
// /guide/resources/<its own id> whatever pack directory it sits in. The pack is
// organisational, not load-bearing, so a declared pathId is used when there is
// one and `resources/discovery` remains an acceptable default.
const DIRECTORY_BY_SURFACE = Object.freeze({
    guide: "resources/discovery",
    "guide-diagram": "diagrams",
});

const EXTENSION_BY_SURFACE = Object.freeze({
    learning: "json",
    guide: "json",
    "guide-diagram": "mmd",
});

// The lifecycle outcome and the Gate 1 category use the same vocabulary. A
// discovery candidate is always new work: Track 1 measures what approved
// sources teach that our corpus does not, so it can only ever propose something
// that is not there. Updates to existing content are Track 2's job.
const OUTCOME_BY_SURFACE = Object.freeze({
    learning: "new-module",
    guide: "addition",
    "guide-diagram": "addition",
});

/** The contract surface for a probe, from its declared kinds. */
export function surfaceForProbe(probe) {
    const kinds = Array.isArray(probe?.kinds) ? probe.kinds : [];
    for (const kind of kinds) {
        const surface = SURFACE_BY_PROBE_KIND[String(kind).toLowerCase()];
        if (surface) return surface;
    }
    return "learning";
}

/** A path-safe slug. The target path pattern allows only [A-Za-z0-9._-] segments. */
export function slugify(value) {
    const slug = String(value ?? "")
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 80);
    if (!slug) throw new TypeError("cannot build a target path from an empty subject");
    return slug;
}

export function targetForCandidate(candidate) {
    // A currency finding already knows exactly which published file it is
    // about: the canonical item's own source path. Deriving a fresh discovery
    // path for it would propose creating a second copy of content that exists,
    // so a candidate that names its target keeps it. Discovery candidates
    // never set this and fall through to the derived placement below.
    if (candidate.targetPath) {
        return { repository: TARGET_REPOSITORY, path: candidate.targetPath };
    }
    const surface = candidate.surface;
    if (surface === "learning") {
        const pathId = candidate.pathId;
        if (typeof pathId !== "string" || pathId.trim() === "") {
            throw new TypeError(
                `the learning candidate "${candidate.subject ?? candidate.term}" declares no pathId, so there is no learning path to publish it into. ` +
                "A module no path lists has no URL at all. Declare pathId on the probe in seed-inputs/probes.json, naming a path that catalog.json declares.",
            );
        }
        return {
            repository: TARGET_REPOSITORY,
            path: `modules/${slugify(pathId)}/${slugify(candidate.term ?? candidate.subject)}.json`,
        };
    }
    const directory = candidate.pathId && surface === "guide"
        ? `resources/${slugify(candidate.pathId)}`
        : DIRECTORY_BY_SURFACE[surface];
    if (!directory) throw new TypeError(`no target directory for surface ${surface}`);
    return {
        repository: TARGET_REPOSITORY,
        path: `${directory}/${slugify(candidate.term ?? candidate.subject)}.${EXTENSION_BY_SURFACE[surface]}`,
    };
}

/**
 * Score a discovery candidate, for reading order only.
 *
 * Demand breadth (how many approved sources mention it) counts for far more
 * than depth (how many times), because one source repeating a term twenty times
 * is one publisher's editorial habit and twenty sources mentioning it once is a
 * market. The score never gates: every candidate goes to the gate regardless,
 * and the human decides. See score-opportunities.mjs, which holds the same
 * position for the local registry.
 */
export const SCORE_FORMULA_VERSION = "track1-demand-1.0.0";

export function scoreCandidate(candidate) {
    const breadth = Number(candidate.demandSourceCount ?? 0);
    const depth = Number(candidate.demandOccurrences ?? 0);
    return Math.round((breadth * 10 + Math.min(depth, 100) * 0.5) * 10) / 10;
}

/**
 * The proposal document, and therefore the thing the Gate 1 approval binds to.
 *
 * An approval is bound to proposal_digest. If any of this changes, the approval
 * stops applying and the item returns for a fresh decision, which is why the
 * evidence list is in it: approving a claim backed by twelve sources is not the
 * same decision as approving the same sentence backed by one.
 */
export function proposalFor(candidate) {
    return {
        schema_version: "1.0.0",
        // Track 1 discovery is the default; a currency candidate names its own
        // kind and category, because a Track 2 finding is never "new work for
        // this surface": it is an update, correction, replacement, removal or
        // addition against content that is already published. Both vocabularies
        // are the same closed enum the gate manifest contract allows.
        kind: candidate.proposalKind ?? "track-1-discovery-proposal",
        semantic_identity: candidate.semanticIdentity,
        subject: candidate.subject,
        surface: candidate.surface,
        category: candidate.category ?? OUTCOME_BY_SURFACE[candidate.surface],
        title: candidate.title ?? candidate.subject,
        term: candidate.term,
        level: candidate.level ?? null,
        demand_occurrences: candidate.demandOccurrences ?? 0,
        demand_source_count: candidate.demandSourceCount ?? 0,
        evidence: [...(candidate.evidence ?? [])].sort(),
        target: targetForCandidate(candidate),
        observed_at: candidate.observedAt,
    };
}

export function rationaleFor(candidate) {
    const sources = candidate.sourceLabels?.length
        ? candidate.sourceLabels.slice(0, 6).join(", ") + (candidate.sourceLabels.length > 6 ? ", and others" : "")
        : "the approved sources listed in the evidence";
    return [
        `${candidate.demandSourceCount} of the surveyed approved sources discuss "${candidate.term}"`,
        `(${candidate.demandOccurrences} occurrences in total), and the pinned corpus does not cover it.`,
        `Sources: ${sources}.`,
        "Demand is measured; the supply side is the corpus probe result and is evidence for this decision, not a decision itself.",
    ].join(" ");
}

/**
 * Estimated authoring cost for one item.
 *
 * The number exists so the gate issue can say what approving will spend. It is
 * a deployer setting rather than a constant because the ensemble size, the
 * model, and the price all belong to whoever runs it. The default is the
 * measured cost of a six-role ensemble run on 2026-08-13 (9 requests, USD
 * 0.57), rounded up.
 */
export function estimatedItemCostUsd(env = process.env) {
    const raw = env.ORCHARD_ESTIMATED_ITEM_COST_USD;
    const value = raw === undefined || raw === "" ? 0.75 : Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new TypeError("ORCHARD_ESTIMATED_ITEM_COST_USD must be a non-negative number");
    return value;
}

function evidenceRecordsFor(candidate) {
    const records = (candidate.evidenceRefs ?? []).filter((entry) => entry?.reference && entry?.digest);
    if (records.length) return records.slice(0, 50);
    // A candidate always has at least the proposal itself as evidence. The
    // contract requires a non-empty list and an empty one would be a lie of
    // omission rather than a validation error worth failing a run over.
    return [{ reference: `proposal:${candidate.semanticIdentity}`, digest: sha256Digest(proposalFor(candidate)) }];
}

/**
 * Look up the item that currently occupies a candidate's subject.
 *
 * The partial unique index ux_workflow_item_one_live_per_subject (migration
 * 006) allows at most one item per (track, semantic_identity) that is not
 * closed, so this is the idempotence key for a re-run and the never-resurrect
 * rule in one query: an item a human denied, or one still anywhere in flight,
 * is not proposed again by a later survey that happens to see the same
 * demand. A decision a machine can undo is not a decision.
 *
 * What this deliberately does NOT return is a closed item. Closed means that
 * item's work finished; it does not mean the subject is settled forever.
 * Currency exists to notice that published content has gone stale, and until
 * migration 006 the dedupe treated closed as blocking, which made the one
 * thing the tool is for structurally impossible (remediation plan T17). A
 * subject whose only items are closed is open for a fresh proposal, which
 * enters as a NEW item at observed and earns every gate again.
 *
 * Amended 2026-09-06 (migration 010): 'superseded' joins 'closed' here. A
 * superseded item HAS a successor, and that successor is the live occupant of
 * the subject, so counting the superseded predecessor as live too would report
 * two live items for one subject and block the successor from ever existing.
 */
export function findLiveItem(db, track, semanticIdentity) {
    return db.prepare("SELECT item_id, current_state, current_revision, outcome FROM workflow_item WHERE track = ? AND semantic_identity = ? AND current_state NOT IN ('closed', 'superseded')")
        .get(track, semanticIdentity) ?? null;
}

/**
 * Whether a live item at Gate 1 should be replaced by this candidate.
 *
 * THE RULE, and why it is this narrow.
 *
 * A currency finding's semantic identity is the canonical item it is about,
 * deliberately not the classification, so one published file can only have one
 * currency question in front of a human at a time. That makes a CHANGED
 * assessment ambiguous: the subject is the same, the question is not. Asking
 * the owner last week's question about this week's content is wrong, and
 * putting a second item beside it asks two contradictory questions about one
 * file. So a changed assessment supersedes.
 *
 * Only the classification counts as a change. Evidence prose varies run to
 * run for reasons that are not a change of assessment (an inspector rewording
 * itself, a digest line moving), and superseding on that would churn a fresh
 * item at the gate every cycle for a finding nobody's understanding of has
 * moved. Same classification, different evidence: the item stays, and the
 * owner is answering the same question they already have in front of them.
 *
 * Only an item still at gate1-pending is superseded. Anything further along
 * has had real money or a human decision spent on it -- an approved item is
 * being authored, a denied item is a human's "no" that a machine may not
 * undo, a deferred item is a human's "not yet". Those keep occupying the
 * subject and the new observation is skipped and logged, exactly as an
 * unchanged assessment is.
 */
export function supersessionTarget(existing, candidate) {
    if (!existing) return null;
    if (existing.current_state !== "gate1-pending") return null;
    const proposedOutcome = candidate.category ?? OUTCOME_BY_SURFACE[candidate.surface];
    return existing.outcome === proposedOutcome ? null : existing;
}

/**
 * The most recent closed item for a subject, so a re-proposal can record what
 * it supersedes. Lineage lives on the new item's supersedes_item_id; the
 * closed predecessor itself is never touched, because closed is terminal for
 * that item and stays that way.
 */
export function latestClosedItem(db, track, semanticIdentity) {
    return db.prepare(`SELECT item_id, current_state, current_revision FROM workflow_item
        WHERE track = ? AND semantic_identity = ? AND current_state = 'closed'
        ORDER BY created_at DESC, item_id DESC LIMIT 1`)
        .get(track, semanticIdentity) ?? null;
}

/**
 * Write each new candidate into the lifecycle and leave it held at Gate 1.
 *
 * Returns { persisted, skipped, items } where items carry everything the gate
 * manifest needs, so the caller never has to read back what it just wrote.
 *
 * A candidate that fails to persist does not fail the run. The survey it came
 * from is real work already recorded, and losing 78 sources of evidence because
 * one proposal would not validate is the wrong trade. Every failure is logged
 * with its reason and counted, so a run that persisted nothing cannot look like
 * a run that found nothing.
 */
export async function persistDiscoveryItems({ store, runId, track = "track-1", candidates, now, log = () => { }, env = process.env }) {
    if (!store) throw new TypeError("persistDiscoveryItems requires an open state store");
    const timestamp = now ?? new Date().toISOString();
    const cost = estimatedItemCostUsd(env);
    const result = { persisted: 0, skipped: 0, failed: 0, reproposed: 0, superseded: 0, items: [], existing: [] };

    for (const candidate of candidates) {
        const existing = findLiveItem(store.db, track, candidate.semanticIdentity);
        const supersede = supersessionTarget(existing, candidate);
        if (existing && !supersede) {
            result.skipped += 1;
            result.existing.push({ semanticIdentity: candidate.semanticIdentity, state: existing.current_state });
            log("info", "gate1.item.known", {
                semanticIdentity: candidate.semanticIdentity,
                itemId: existing.item_id,
                state: existing.current_state,
                effect: "not re-proposed",
            });
            continue;
        }
        // A subject whose only items are closed is available again: the
        // predecessor finished its lifecycle, and this survey has found the
        // same demand afterwards. The new item records the lineage and the
        // gate issue says so, because "we published this once already" is
        // material to the decision being asked for.
        // A live item being superseded is itself the predecessor: the lineage
        // question is "which item does this one replace", and a changed
        // assessment replaces the stale one it displaces, not some older
        // closed item behind it.
        const predecessor = supersede ?? latestClosedItem(store.db, track, candidate.semanticIdentity);

        // Building the proposal is inside the try for the same reason the
        // writes are: a probe with a surface nothing can place threw here and
        // took the whole run's candidates with it, which is precisely the
        // all-or-nothing behaviour this loop exists to avoid.
        let manifestItem;
        try {
            const proposal = proposalFor(candidate);
            const proposalDigest = sha256Digest(proposal);
            const itemId = generateUuidV7();
            const target = proposal.target;
            // A candidate that explains itself keeps its own words. The
            // derived text below speaks in Track 1's demand vocabulary, which
            // is a lie when the candidate is a currency finding about content
            // that already exists.
            const baseRationale = candidate.rationale ?? rationaleFor(candidate);
            const rationale = supersede
                ? `${baseRationale} This replaces item ${supersede.item_id}, which was held at this gate proposing "${supersede.outcome}" for the same subject and has been superseded: the assessment changed to "${proposal.category}", so the earlier question is no longer the one to answer.`
                : predecessor
                    ? `${baseRationale} This subject has been through the lifecycle before: item ${predecessor.item_id} is closed, and this proposal supersedes it as a fresh item with a fresh decision.`
                    : baseRationale;
            manifestItem = {
                item_id: itemId,
                item_revision: 1,
                proposal_digest: proposalDigest,
                category: proposal.category,
                title: String(proposal.title).slice(0, 200),
                rationale: rationale.slice(0, 4000),
                evidence_refs: proposal.evidence.length ? proposal.evidence.slice(0, 50) : [`proposal:${candidate.semanticIdentity}`],
                score: { formula_version: SCORE_FORMULA_VERSION, value: scoreCandidate(candidate) },
                target,
                risks: [
                    "Demand is measured on approved sources only; a gap here is a gap relative to that set, not to the whole field.",
                    "The target path is a proposal. Redirect it at this gate if the placement is wrong.",
                ],
                estimated_cost: { currency: "USD", amount: cost },
                decision_state: "pending",
            };
            // One unit of work. Displacing the stale item and holding its
            // replacement are the same decision, and a crash between them
            // would either leave the subject empty at the gate (superseded
            // with no successor) or leave an item stranded at 'observed' that
            // nothing announces and nothing can advance. Both were possible
            // before this was a single transaction.
            await store.runLinkedWrites(async () => {
                // The old item goes first: the partial unique index refuses a
                // second live item for the subject, so the replacement cannot
                // exist until the stale one stops occupying it. The forward
                // foreign key on superseded_by_item_id is what runLinkedWrites
                // defers to the commit.
                if (supersede) {
                    await store.recordTransition({
                        schema_version: "1.0.0",
                        transition_id: generateUuidV7(),
                        run_id: runId,
                        item_id: supersede.item_id,
                        item_revision: Number(supersede.current_revision),
                        from_state: supersede.current_state,
                        to_state: "superseded",
                        cause: "superseded",
                        superseding_item_id: itemId,
                        actor: `orchard-${track}-controller`,
                        occurred_at: timestamp,
                        correlation_id: runId,
                    });
                }
                await store.recordItem({
                    schema_version: "1.0.0",
                    item_id: itemId,
                    run_id: runId,
                    track,
                    item_revision: 1,
                    semantic_identity: candidate.semanticIdentity,
                    surface: candidate.surface,
                    outcome: proposal.category,
                    state: "observed",
                    proposal_digest: proposalDigest,
                    artifact_digest: null,
                    target,
                    evidence: evidenceRecordsFor(candidate),
                    supersedes_item_id: predecessor?.item_id ?? null,
                    created_at: timestamp,
                    updated_at: timestamp,
                });
                for (const [from, to, cause] of [["observed", "proposed", "observation-recorded"], ["proposed", "gate1-pending", "proposal-ready"]]) {
                    await store.recordTransition({
                        schema_version: "1.0.0",
                        transition_id: generateUuidV7(),
                        run_id: runId,
                        item_id: itemId,
                        item_revision: 1,
                        from_state: from,
                        to_state: to,
                        cause,
                        actor: `orchard-${track}-controller`,
                        occurred_at: timestamp,
                        correlation_id: runId,
                    });
                }
                // The gate issue needs a title, a rationale, a score and a cost.
                // None of them fit in the item record, whose schema is closed, and
                // an item held from an earlier run has to announce itself just as
                // well as one held from this run. So the manifest entry is recorded
                // as evidence about the item, which is what it is, and the gate
                // reads it back from the database rather than from memory.
                await store.recordObservation({
                    observation_id: generateUuidV7(),
                    run_id: runId,
                    item_id: itemId,
                    item_revision: 1,
                    evidence_reference: `${GATE_MANIFEST_REFERENCE_PREFIX}gate-1:${itemId}`,
                    evidence_digest: sha256Digest(manifestItem),
                    observed_at: timestamp,
                    gate: "gate-1",
                    manifest_item: manifestItem,
                });
            });
        } catch (error) {
            result.failed += 1;
            log("warn", "gate1.item.failed", {
                semanticIdentity: candidate.semanticIdentity,
                code: error.code ?? null,
                reason: error.message,
                effect: "candidate not held at the gate; the survey is unaffected",
            });
            continue;
        }

        result.persisted += 1;
        result.items.push(manifestItem);
        if (supersede) {
            result.superseded += 1;
            log("info", "gate1.item.superseded", {
                semanticIdentity: candidate.semanticIdentity,
                itemId: manifestItem.item_id,
                supersedesItemId: supersede.item_id,
                priorOutcome: supersede.outcome,
                outcome: manifestItem.category,
                effect: "the stale assessment left Gate 1; its replacement is held there instead",
            });
        } else if (predecessor) {
            result.reproposed += 1;
            log("info", "gate1.item.reproposed", {
                semanticIdentity: candidate.semanticIdentity,
                itemId: manifestItem.item_id,
                supersedesItemId: predecessor.item_id,
                effect: "closed subject re-enters the lifecycle as a new item held at Gate 1",
            });
        }
    }

    log("info", "gate1.items.persisted", {
        persisted: result.persisted,
        alreadyKnown: result.skipped,
        reproposed: result.reproposed,
        superseded: result.superseded,
        failed: result.failed,
        candidates: candidates.length,
    });
    return result;
}

const GATE_STATE = Object.freeze({ "gate-1": "gate1-pending", "gate-2": "gate2-pending" });

/**
 * A digest of WHAT is held, independent of which run announced it.
 *
 * The contract's batch digest cannot do this job: it hashes the run id, so it
 * changes every month even when the same items are still waiting, and keying
 * the issue on it would open a fresh issue each run and scatter one decision
 * across several. This hashes the items, their revisions and their decision
 * digests and nothing else, so an undecided set keeps its issue and a changed
 * set correctly gets a new one.
 */
export function heldSetDigest(gate, items) {
    return sha256Digest({
        gate,
        items: items
            .map((item) => `${item.item_id}:${item.item_revision}:${gate === "gate-1" ? item.proposal_digest : item.artifact_digest}`)
            .sort(),
    });
}

/**
 * Everything a gate currently holds, as gate manifest entries.
 *
 * Reads workflow_item, which is the ONLY item table the deployed database has.
 * The first version of this read work_item, from content-db.sql, which exists
 * in a local build and nowhere else; announcing would have failed with "no such
 * table" on every run and been logged as an announcement fault rather than the
 * schema mistake it was.
 *
 * The manifest entry comes from the observation recorded when the item was
 * proposed, so an item held since an earlier run announces itself exactly as
 * well as one held since this one. An item with no recorded entry still
 * appears, built from what the item record can prove, because a gate that
 * silently omits work it is holding is worse than a gate with a thin
 * description of it.
 */
export function heldAtGate(db, gate, track = null) {
    const state = GATE_STATE[gate];
    if (!state) throw new TypeError("gate must be gate-1 or gate-2");
    const where = track ? "i.current_state = ? AND i.track = ?" : "i.current_state = ?";
    const parameters = track ? [state, track] : [state];
    const rows = db.prepare(
        `SELECT i.item_id, i.track, i.current_revision, i.surface, i.outcome, i.semantic_identity, r.record_json
           FROM workflow_item i
           JOIN item_revision r ON r.item_id = i.item_id AND r.item_revision = i.current_revision
          WHERE ${where}
          ORDER BY i.item_id`,
    ).all(...parameters);

    const entry = db.prepare(
        `SELECT record_json FROM observation_event
          WHERE item_id = ? AND item_revision = ? AND evidence_reference = ?
          ORDER BY observed_at DESC LIMIT 1`,
    );

    return rows.map((row) => {
        const record = JSON.parse(row.record_json);
        const revision = Number(row.current_revision);
        const observed = entry.get(row.item_id, revision, `${GATE_MANIFEST_REFERENCE_PREFIX}${gate}:${row.item_id}`);
        const manifestItem = observed ? JSON.parse(observed.record_json).manifest_item : null;
        if (manifestItem) return { ...manifestItem, track: row.track };
        return {
            item_id: row.item_id,
            track: row.track,
            item_revision: revision,
            proposal_digest: record.proposal_digest,
            artifact_digest: record.artifact_digest ?? null,
            category: row.outcome,
            title: `${row.outcome} on ${row.surface}: ${record.target?.path ?? row.semantic_identity}`.slice(0, 200),
            rationale: "No recorded proposal detail for this item. It is held and must still be decided.",
            evidence_refs: [row.semantic_identity],
            score: { formula_version: SCORE_FORMULA_VERSION, value: 0 },
            target: record.target,
            risks: ["The proposal detail for this item was not recorded, so the description here is derived from the item record."],
            estimated_cost: { currency: "USD", amount: 0 },
            decision_state: "pending",
        };
    });
}
