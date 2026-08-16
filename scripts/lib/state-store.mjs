import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertValidRecord, closurePacketDigest } from "./contracts.mjs";
import { canonicalJson, lifecycleKey, sha256Digest } from "./identity.mjs";
import { parseCanonicalUtcInstant } from "./delivery-policy.mjs";
import { assertTransitionAllowed, assertApprovalCurrent } from "./state-machine.mjs";
import { verifyGateManifestDigests } from "./gates.mjs";
import { migrateContentDb } from "../migrate-content-db.mjs";

export class IdempotencyConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "IdempotencyConflictError";
        this.code = "state-store.idempotency-conflict";
    }
}

export class StateConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "StateConflictError";
        this.code = "state-store.state-conflict";
    }
}

function transaction(db, operation, options = {}) {
    options.onStage?.("transaction-beginning");
    db.exec("BEGIN IMMEDIATE");
    options.onStage?.("transaction-begun");
    try {
        const result = operation();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
        throw error;
    }
}

function parseRecord(row) {
    return row ? JSON.parse(row.record_json) : null;
}

function exact(actual, expected, label) {
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new StateConflictError(`${label} does not match persisted immutable evidence`);
}

function canonicalTimestamp(value, label) {
    return parseCanonicalUtcInstant(value, label);
}

function exactReplay(db, table, primaryColumn, primaryValue, idempotencyKey, recordJson) {
    const row = db.prepare(`SELECT record_json, ${primaryColumn} AS primary_value FROM ${table} WHERE ${primaryColumn} = ? OR idempotency_key = ?`).get(primaryValue, idempotencyKey);
    if (!row) return null;
    if (row.primary_value !== primaryValue || row.record_json !== recordJson) {
        throw new IdempotencyConflictError(`${table} identity was replayed with different content`);
    }
    return JSON.parse(row.record_json);
}

function required(value, name) {
    if (value === undefined || value === null || value === "") throw new TypeError(`${name} is required`);
    return value;
}

function genericKey(namespace, record) {
    return record.idempotency_key ?? `${namespace}:${sha256Digest(record)}`;
}

export class StateStore {
    constructor(dbOrPath, options = {}) {
        if (typeof dbOrPath === "string") {
            this.path = resolve(dbOrPath);
            if (options.migrate !== false) migrateContentDb(this.path, options.migrationOptions);
            this.db = new DatabaseSync(this.path);
            this.ownsDatabase = true;
        } else {
            this.db = dbOrPath;
            this.path = null;
            this.ownsDatabase = false;
        }
        this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    }

    close() {
        if (this.ownsDatabase && this.db) this.db.close();
        this.db = null;
    }

    provisionTrustAnchor(record) {
        if (!record || !["gate", "publication", "closure"].includes(record.scope)) {
            throw new TypeError("trust anchor scope must be gate, publication, or closure");
        }
        if (!/^sha256:[a-f0-9]{64}$/.test(record.adapter_digest ?? "")
            || typeof record.adapter_identity !== "string" || !record.adapter_identity
            || !record.provisioned_at) {
            throw new TypeError("trust anchor requires adapter identity, digest, and provisioned_at");
        }
        if (record.scope !== "publication" && (!/^sha256:[a-f0-9]{64}$/.test(record.policy_digest ?? "") || !record.policy)) {
            throw new TypeError("gate and closure trust anchors require an exact policy and digest");
        }
        if (record.policy && sha256Digest(record.policy) !== record.policy_digest) {
            throw new StateConflictError("trust anchor policy does not match its digest");
        }
        const normalized = {
            scope: record.scope, adapter_identity: record.adapter_identity,
            adapter_digest: record.adapter_digest, adapter_path: record.adapter_path ?? null,
            policy_digest: record.policy_digest ?? null, policy: record.policy ?? null,
            provisioned_at: canonicalTimestamp(record.provisioned_at, "trust anchor provisioned_at")
        };
        const json = canonicalJson(normalized);
        return transaction(this.db, () => {
            const existing = this.getTrustAnchor(record.scope);
            if (existing) {
                if (canonicalJson(existing) !== json) throw new IdempotencyConflictError(`${record.scope} trust anchor is already provisioned`);
                return existing;
            }
            this.db.prepare(`INSERT INTO protected_trust_anchor
                (scope, adapter_identity, adapter_digest, adapter_path, policy_digest, policy_json, provisioned_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                normalized.scope, normalized.adapter_identity, normalized.adapter_digest, normalized.adapter_path,
                normalized.policy_digest, normalized.policy ? canonicalJson(normalized.policy) : null,
                normalized.provisioned_at, json);
            return normalized;
        });
    }

    getTrustAnchor(scope) {
        return parseRecord(this.db.prepare("SELECT record_json FROM protected_trust_anchor WHERE scope = ?").get(scope));
    }

    requirePublicationAdapter(adapter) {
        const anchor = this.getTrustAnchor("publication");
        if (!anchor) throw new StateConflictError("publication requires an administrator-provisioned adapter trust anchor");
        if (!adapter || adapter.adapterIdentity !== anchor.adapter_identity || adapter.adapterDigest !== anchor.adapter_digest) {
            throw new StateConflictError("publication adapter does not match the protected trust anchor");
        }
        return anchor;
    }

    recordPublicationAuthority(transactionId, anchor) {
        const trustAnchorDigest = sha256Digest(anchor);
        const record = {
            transaction_id: transactionId, adapter_identity: anchor.adapter_identity,
            adapter_digest: anchor.adapter_digest, trust_anchor_digest: trustAnchorDigest
        };
        record.evidence_digest = sha256Digest(record);
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const existing = parseRecord(this.db.prepare("SELECT record_json FROM publication_authority WHERE transaction_id = ?").get(transactionId));
            if (existing) {
                if (canonicalJson(existing) !== json) throw new IdempotencyConflictError("publication adapter authority changed during replay");
                return existing;
            }
            this.db.prepare(`INSERT INTO publication_authority
                (transaction_id, adapter_identity, adapter_digest, trust_anchor_digest, evidence_digest, record_json)
                VALUES (?, ?, ?, ?, ?, ?)`).run(transactionId, anchor.adapter_identity, anchor.adapter_digest,
                trustAnchorDigest, record.evidence_digest, json);
            return record;
        });
    }

    async recordRun(record, options = {}) {
        options.onStage?.("validation-starting");
        await assertValidRecord("run-manifest", record);
        options.onStage?.("validation-completed");
        options.onStage?.("serialization-starting");
        const json = canonicalJson(record);
        const key = record.idempotency_key ?? `run:${record.run_id}:${record.manifest_digest}`;
        options.onStage?.("serialization-completed");
        return transaction(this.db, () => {
            options.onStage?.("replay-checking");
            const replay = exactReplay(this.db, "workflow_run", "run_id", record.run_id, key, json);
            options.onStage?.("replay-checked", { replay: Boolean(replay) });
            if (replay) return replay;
            options.onStage?.("manifest-inserting");
            this.db.prepare(`INSERT INTO workflow_run
                (run_id, track, trigger_type, scope_mode, status, replay_of, manifest_digest,
                 idempotency_key, started_at, completed_at, record_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.run_id, record.track, record.trigger.type, record.scope.mode, record.status,
                record.replay_of ?? null, record.manifest_digest, key, record.started_at,
                record.completed_at ?? null, json, record.started_at
            );
            options.onStage?.("manifest-inserted");
            const coverage = this.db.prepare("INSERT INTO run_coverage (run_id, metric, value) VALUES (?, ?, ?)");
            options.onStage?.("coverage-inserting", { metricCount: Object.keys(record.coverage).length });
            for (const [metric, value] of Object.entries(record.coverage)) coverage.run(record.run_id, metric, value);
            options.onStage?.("coverage-inserted");
            return record;
        }, options);
    }

    async finalizeRun(record) {
        await assertValidRecord("run-manifest", record);
        if (!["incomplete", "blocked", "failed", "completed"].includes(record.status)) {
            throw new StateConflictError("final run status must be terminal");
        }
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const current = this.db.prepare("SELECT status, track, scope_mode FROM workflow_run WHERE run_id = ?").get(record.run_id);
            if (!current) throw new StateConflictError("run must be persisted before it is finalized");
            if (current.track !== record.track || current.scope_mode !== record.scope.mode) throw new StateConflictError("immutable run identity cannot change");
            if (current.status !== "running" && current.status !== "created") {
                const replay = this.getRun(record.run_id);
                if (canonicalJson(replay) === json) return replay;
                throw new StateConflictError("terminal run cannot be finalized with different content");
            }
            const result = this.db.prepare(`UPDATE workflow_run SET status = ?, manifest_digest = ?, completed_at = ?, record_json = ?
                WHERE run_id = ? AND status IN ('created', 'running')`).run(
                record.status, record.manifest_digest, record.completed_at ?? null, json, record.run_id
            );
            if (result.changes !== 1) throw new StateConflictError("run finalization compare-and-swap failed");
            this.db.prepare("DELETE FROM run_coverage WHERE run_id = ?").run(record.run_id);
            const coverage = this.db.prepare("INSERT INTO run_coverage (run_id, metric, value) VALUES (?, ?, ?)");
            for (const [metric, value] of Object.entries(record.coverage)) coverage.run(record.run_id, metric, value);
            return record;
        });
    }

    recordRunOutcome(record) {
        const id = required(record.outcome_id ?? record.outcomeId, "outcome_id");
        const runId = required(record.run_id ?? record.runId, "run_id");
        const subject = required(record.subject_key ?? record.subjectKey, "subject_key");
        const key = genericKey("run-outcome", record);
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "run_outcome", "outcome_id", id, key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO run_outcome
                (outcome_id, run_id, subject_key, outcome, exception_reason, evidence_digest, idempotency_key, occurred_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, runId, subject, required(record.outcome, "outcome"), record.exception_reason ?? null,
                record.evidence_digest ?? null, key, required(record.occurred_at, "occurred_at"), json);
            return record;
        });
    }

    async recordItem(record) {
        await assertValidRecord("item-record", record);
        const json = canonicalJson(record);
        const revisionLifecycleKey = lifecycleKey(record.track, record.item_id, record.item_revision, "revision");
        return transaction(this.db, () => {
            const existingRevision = this.db.prepare("SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?").get(record.item_id, record.item_revision);
            if (existingRevision) {
                if (existingRevision.record_json !== json) throw new IdempotencyConflictError("item revision was replayed with different content");
                return JSON.parse(existingRevision.record_json);
            }
            const item = this.db.prepare("SELECT * FROM workflow_item WHERE item_id = ?").get(record.item_id);
            if (!item) {
                if (record.item_revision !== 1) throw new StateConflictError("the first item revision must be 1");
                this.db.prepare(`INSERT INTO workflow_item
                    (item_id, origin_run_id, track, semantic_identity, surface, outcome, current_revision,
                     current_state, supersedes_item_id, superseded_by_item_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    record.item_id, record.run_id, record.track, record.semantic_identity, record.surface,
                    record.outcome, 1, record.state, record.supersedes_item_id ?? null,
                    record.superseded_by_item_id ?? null, record.created_at, record.updated_at ?? record.created_at
                );
            } else {
                if (item.track !== record.track || item.semantic_identity !== record.semantic_identity) throw new StateConflictError("immutable item identity cannot change");
                if (record.item_revision !== Number(item.current_revision) + 1) throw new StateConflictError("item revisions must be contiguous");
            }
            this.db.prepare(`INSERT INTO item_revision
                (item_id, item_revision, run_id, proposal_digest, artifact_digest, target_repository,
                 target_path, lifecycle_key, record_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.item_id, record.item_revision, record.run_id, record.proposal_digest,
                record.artifact_digest ?? null, record.target.repository, record.target.path,
                revisionLifecycleKey, json, record.created_at
            );
            return record;
        });
    }

    recordObservation(record) {
        const id = required(record.observation_id ?? record.observationId, "observation_id");
        const key = genericKey("observation", record);
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "observation_event", "observation_id", id, key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO observation_event
                (observation_id, run_id, item_id, item_revision, evidence_reference, evidence_digest,
                 idempotency_key, observed_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                id, required(record.run_id, "run_id"), record.item_id ?? null, record.item_revision ?? null,
                required(record.evidence_reference ?? record.reference, "evidence_reference"),
                required(record.evidence_digest ?? record.digest, "evidence_digest"), key,
                required(record.observed_at ?? record.occurred_at, "observed_at"), json
            );
            return record;
        });
    }

    async recordTransition(record) {
        await assertValidRecord("state-transition", record);
        const key = record.idempotency_key ?? `transition:${record.transition_id}`;
        const json = canonicalJson(record);
        const replay = exactReplay(this.db, "state_transition_event", "transition_id", record.transition_id, key, json);
        if (replay) return replay;
        const item = this.db.prepare("SELECT * FROM workflow_item WHERE item_id = ?").get(record.item_id);
        if (!item) throw new StateConflictError("transition item does not exist");
        await assertTransitionAllowed(record, {
            itemId: item.item_id,
            state: item.current_state,
            revision: Number(item.current_revision),
            supersededByItemId: item.superseded_by_item_id
        });
        if (record.to_state === "ado-linked") {
            // The external_link demand lives HERE, not on the approval:
            // ado-linked is the state that asserts the tracker item exists,
            // so it is the transition that must prove it. Moved off
            // gate1-approved on 2026-08-15 per the remediation plan's Part 1.
            const link = this.db.prepare("SELECT 1 FROM external_link WHERE provider = 'ado' AND item_id = ? AND item_revision = ?")
                .get(record.item_id, record.item_revision);
            if (!link) throw new StateConflictError("the ado-linked transition requires a persisted ADO external link");
        }
        if (["ado-closure-ready", "closed"].includes(record.to_state)) {
            const packet = this.db.prepare("SELECT packet_digest FROM closure_packet WHERE item_id = ? AND item_revision = ?")
                .get(record.item_id, record.item_revision);
            if (!packet) throw new StateConflictError("closure transition requires a persisted closure packet");
            const requiredState = record.to_state === "closed" ? "Closed" : "Resolved";
            if (!this.db.prepare("SELECT 1 FROM closure_ado_event WHERE packet_digest = ? AND state = ?").get(packet.packet_digest, requiredState)) {
                throw new StateConflictError(`closure transition requires the persisted ${requiredState} ADO result event`);
            }
            if (record.to_state === "closed" && !this.db.prepare("SELECT 1 FROM closure_acceptance WHERE packet_digest = ?").get(packet.packet_digest)) {
                throw new StateConflictError("closed transition requires persisted owner acceptance");
            }
        }
        return transaction(this.db, () => {
            const committedReplay = exactReplay(this.db, "state_transition_event", "transition_id", record.transition_id, key, json);
            if (committedReplay) return committedReplay;
            const current = this.db.prepare("SELECT * FROM workflow_item WHERE item_id = ?").get(record.item_id);
            if (current.current_state !== record.from_state || Number(current.current_revision) !== record.item_revision) throw new StateConflictError("item changed before transition commit");
            if (record.cause === "revision-created") {
                const successor = this.db.prepare("SELECT 1 FROM item_revision WHERE item_id = ? AND item_revision = ?").get(record.item_id, record.successor_revision);
                if (!successor) throw new StateConflictError("successor item revision must be persisted before its recovery transition");
            }
            this.db.prepare(`INSERT INTO state_transition_event
                (transition_id, run_id, item_id, item_revision, from_state, to_state, cause,
                 correlation_id, idempotency_key, occurred_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.transition_id, record.run_id, record.item_id, record.item_revision,
                record.from_state, record.to_state, record.cause, record.correlation_id,
                key, record.occurred_at, json
            );
            const nextRevision = record.successor_revision ?? record.item_revision;
            const result = this.db.prepare(`UPDATE workflow_item SET current_state = ?, current_revision = ?,
                superseded_by_item_id = COALESCE(?, superseded_by_item_id), updated_at = ?
                WHERE item_id = ? AND current_state = ? AND current_revision = ?`).run(
                record.to_state, nextRevision, record.superseding_item_id ?? null, record.occurred_at,
                record.item_id, record.from_state, record.item_revision
            );
            if (result.changes !== 1) throw new StateConflictError("transition compare-and-swap failed");
            return record;
        });
    }

    async recordDecision() {
        throw new StateConflictError("raw decision persistence is forbidden; use recordVerifiedDecision with protected provider evidence");
    }

    async recordVerifiedDecision(authority) {
        const { decision: record, manifest, full_manifest_items: fullManifestItems,
            current_item: currentItem, verified_event: providerEvent,
            authorization_policy: authorizationPolicy, trust } = authority ?? {};
        await assertValidRecord("decision-event", record);
        await assertValidRecord(record.gate === "gate-1" ? "gate-1-issue-manifest" : "gate-2-issue-manifest", manifest);
        verifyGateManifestDigests(manifest, fullManifestItems);
        const digestPattern = /^sha256:[a-f0-9]{64}$/;
        const anchor = this.getTrustAnchor("gate");
        const protectedTrust = anchor ? {
            authorization_policy_digest: anchor.policy_digest,
            adapter_digest: anchor.adapter_digest,
            adapter_identity: anchor.adapter_identity
        } : null;
        if (!protectedTrust || !digestPattern.test(protectedTrust.authorization_policy_digest ?? "")
            || !digestPattern.test(protectedTrust.adapter_digest ?? "")
            || typeof protectedTrust.adapter_identity !== "string" || !protectedTrust.adapter_identity) {
            throw new StateConflictError("verified decision requires administrator-protected policy and adapter pins");
        }
        if (!trust || !digestPattern.test(trust.adapter_digest ?? "") || typeof trust.adapter_identity !== "string" || !trust.adapter_identity) {
            throw new StateConflictError("verified decision requires a digest-pinned identified provider adapter");
        }
        if (trust.authorization_policy_digest !== protectedTrust.authorization_policy_digest
            || trust.adapter_digest !== protectedTrust.adapter_digest
            || trust.adapter_identity !== protectedTrust.adapter_identity) {
            throw new StateConflictError("verified decision evidence does not match administrator-protected trust pins");
        }
        if (sha256Digest(providerEvent) !== trust.provider_event_digest
            || sha256Digest(authorizationPolicy) !== trust.authorization_policy_digest) {
            throw new StateConflictError("verified decision trust digests do not match supplied immutable evidence");
        }
        if (authorizationPolicy?.provider !== record.actor.provider
            || authorizationPolicy?.repository !== record.source.repository
            || !authorizationPolicy?.authorized_actor_ids?.map(String).includes(String(record.actor.immutable_id))) {
            throw new StateConflictError("verified decision actor is not authorized by the pinned policy");
        }
        if (providerEvent?.repository !== record.source.repository
            || String(providerEvent?.comment_id) !== String(record.source.comment_id)
            || String(providerEvent?.actor?.immutable_id) !== String(record.actor.immutable_id)
            || sha256Digest(providerEvent?.body) !== record.source.comment_digest) {
            throw new StateConflictError("verified provider event does not bind the persisted decision");
        }
        if (manifest.gate !== record.gate || manifest.run_id !== record.run_id) {
            throw new StateConflictError("verified decision does not bind the persisted gate manifest");
        }
        const manifestItems = manifest.items.filter((entry) => entry.item_id === record.item_id);
        if (manifestItems.length !== 1) throw new StateConflictError("verified decision item must occur exactly once in its gate manifest");
        const reviewedItem = manifestItems[0];
        exact(currentItem, reviewedItem, "verified decision current item");
        const reviewedDigest = record.gate === "gate-1" ? reviewedItem.proposal_digest : reviewedItem.artifact_digest;
        if (record.item_revision !== reviewedItem.item_revision || record.digest !== reviewedDigest) {
            throw new StateConflictError("verified decision revision or digest does not match its gate manifest");
        }
        const queueWorkItemId = authority.queue_work_item_id ?? null;
        // The tracker item is created AFTER approval, never before: the owner
        // reads a GitHub issue and says yes, and that yes is what causes the
        // Azure DevOps work item to exist. The first version of this check
        // demanded a positive work item id WITH the approval, which inverted
        // the ordering and made an approval impossible to record at all. The
        // external_link demand now sits on the ado-linked transition in
        // recordTransition, which is the state that means "the tracker item
        // exists". An approval may still carry the id when a reconciler
        // replays one that is already linked, and then it must be exact.
        const authorisesDispatch = record.gate === "gate-1" && record.decision === "approve";
        if (authorisesDispatch && queueWorkItemId !== null
            && (!Number.isSafeInteger(queueWorkItemId) || queueWorkItemId < 1)) {
            throw new StateConflictError("a Gate 1 approval's queue work item ID must be null or a positive integer");
        }
        if (!authorisesDispatch && queueWorkItemId !== null) {
            throw new StateConflictError("only a Gate 1 approval may claim queue dispatch ownership");
        }
        // ADR-0025, amendment 2026-08-16: a bare approve or deny comment
        // decides every pending item on its issue, so one comment can now
        // produce several decision events. Scoping the fallback key to the
        // item as well as the comment keeps a single-item structured command
        // exactly as replay-safe as before (comment_id alone was already
        // unique for it) while letting the same comment legitimately decide
        // more than one item without a false idempotency collision between
        // them.
        const key = record.idempotency_key ?? `decision:${record.source.repository}:${record.source.comment_id}:${record.item_id}`;
        const json = canonicalJson(record);
        const authorityRecord = {
            schema_version: "1.0.0", queue_work_item_id: queueWorkItemId,
            decision: record, manifest, full_manifest_items: fullManifestItems, current_item: currentItem,
            verified_event: providerEvent, authorization_policy: authorizationPolicy,
            trust: {
                provider_event_digest: trust.provider_event_digest,
                authorization_policy_digest: trust.authorization_policy_digest,
                adapter_digest: trust.adapter_digest, adapter_identity: trust.adapter_identity,
                repository: record.source.repository, actor_immutable_id: String(record.actor.immutable_id)
            }
        };
        authorityRecord.evidence_digest = sha256Digest(authorityRecord);
        const authorityJson = canonicalJson(authorityRecord);
        const existingDecision = this.db.prepare("SELECT event_id, record_json FROM decision_event WHERE event_id = ? OR idempotency_key = ?")
            .get(record.event_id, key);
        if (existingDecision) {
            if (existingDecision.event_id !== record.event_id || existingDecision.record_json !== json) {
                throw new IdempotencyConflictError("decision_event identity was replayed with different content");
            }
            const evidence = parseRecord(this.db.prepare("SELECT record_json FROM gate_decision_authority WHERE event_id = ?").get(record.event_id));
            if (!evidence || canonicalJson(evidence) !== authorityJson) {
                throw new IdempotencyConflictError("decision replay lacks the exact protected authority evidence");
            }
            return JSON.parse(existingDecision.record_json);
        }
        const item = this.db.prepare("SELECT * FROM workflow_item WHERE item_id = ?").get(record.item_id);
        if (!item) throw new StateConflictError("decision item does not exist");
        if (Number(item.current_revision) !== record.item_revision) throw new StateConflictError("decision belongs to a stale revision");
        if (item.current_state !== record.previous_state) throw new StateConflictError("decision previous state is stale");
        const revision = this.db.prepare("SELECT proposal_digest, artifact_digest FROM item_revision WHERE item_id = ? AND item_revision = ?").get(record.item_id, record.item_revision);
        const artifactBinding = record.gate === "gate-2" ? this.getArtifactBinding(record.item_id, record.item_revision) : null;
        if (record.gate === "gate-2" && !artifactBinding) throw new StateConflictError("Gate 2 decision requires a persisted immutable artifact binding");
        const currentDigest = record.gate === "gate-1" ? revision.proposal_digest : (artifactBinding?.artifact_digest ?? revision.artifact_digest);
        assertApprovalCurrent({ gate: record.gate, approvalRevision: record.item_revision, currentRevision: Number(item.current_revision), approvedDigest: record.digest, currentDigest });
        return transaction(this.db, () => {
            const committedReplay = exactReplay(this.db, "decision_event", "event_id", record.event_id, key, json);
            if (committedReplay) {
                const evidence = parseRecord(this.db.prepare("SELECT record_json FROM gate_decision_authority WHERE event_id = ?").get(record.event_id));
                if (!evidence || canonicalJson(evidence) !== authorityJson) throw new IdempotencyConflictError("decision replay lacks the exact protected authority evidence");
                return committedReplay;
            }
            this.db.prepare(`INSERT INTO decision_event
                (event_id, gate, run_id, item_id, item_revision, digest, decision, actor_provider,
                 actor_immutable_id, source_repository, source_issue_number, source_comment_id,
                 correlation_id, supersedes_event_id, idempotency_key, occurred_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.event_id, record.gate, record.run_id, record.item_id, record.item_revision,
                record.digest, record.decision, record.actor.provider, record.actor.immutable_id,
                record.source.repository, record.source.issue_number, record.source.comment_id,
                record.correlation_id, record.supersedes_event_id ?? null, key, record.occurred_at, json
            );
            this.db.prepare(`INSERT INTO gate_decision_authority
                (event_id, queue_work_item_id, provider_event_digest, authorization_policy_digest,
                 adapter_digest, adapter_identity, repository, actor_immutable_id, manifest_digest,
                 full_manifest_digest, evidence_digest, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.event_id, queueWorkItemId, trust.provider_event_digest, trust.authorization_policy_digest,
                trust.adapter_digest, trust.adapter_identity, record.source.repository, String(record.actor.immutable_id),
                sha256Digest(manifest), manifest.full_manifest_digest, authorityRecord.evidence_digest, authorityJson
            );
            const result = this.db.prepare("UPDATE workflow_item SET current_state = ?, updated_at = ? WHERE item_id = ? AND current_revision = ? AND current_state = ?")
                .run(record.next_state, record.occurred_at, record.item_id, record.item_revision, record.previous_state);
            if (result.changes !== 1) throw new StateConflictError("decision compare-and-swap failed");
            return record;
        });
    }

    recordExternalLink(record) {
        const id = required(record.link_id ?? record.linkId, "link_id");
        const item = record.item_id
            ? this.db.prepare("SELECT track FROM workflow_item WHERE item_id = ?").get(record.item_id)
            : null;
        if (record.item_id && !item) throw new StateConflictError("external link item does not exist");
        const operationKey = record.lifecycle_key ?? (record.item_id
            ? lifecycleKey(item.track, record.item_id, record.item_revision, record.operation)
            : `run:${record.run_id}:${record.operation}`);
        const key = record.idempotency_key ?? `external:${operationKey}:${record.manifest_digest ?? record.artifact_digest ?? "none"}`;
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "external_link", "link_id", id, key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO external_link
                (link_id, run_id, item_id, item_revision, provider, operation, external_key,
                 external_id, manifest_digest, artifact_digest, lifecycle_key, idempotency_key, linked_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                id, required(record.run_id, "run_id"), record.item_id ?? null, record.item_revision ?? null,
                required(record.provider, "provider"), required(record.operation, "operation"),
                required(record.external_key, "external_key"), String(required(record.external_id, "external_id")),
                record.manifest_digest ?? null, record.artifact_digest ?? null, operationKey, key,
                required(record.linked_at ?? record.occurred_at, "linked_at"), json
            );
            return record;
        });
    }

    async recordHandoff(record) {
        await assertValidRecord("agent-handoff", record);
        const key = record.idempotency_key ?? `handoff:${record.handoff_id}`;
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "agent_handoff", "handoff_id", record.handoff_id, key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO agent_handoff
                (handoff_id, run_id, item_id, item_revision, role, input_digest, output_digest,
                 predecessor_handoff_digest, idempotency_key, status, completed_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.handoff_id, record.run_id, record.item_id, record.item_revision, record.role,
                record.input_digest, record.output_digest, record.predecessor_handoff_digest ?? null,
                key, record.status, record.completed_at, json
            );
            return record;
        });
    }

    recordArtifactBinding(record) {
        canonicalTimestamp(record.occurred_at, "artifact binding occurred_at");
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const candidates = this.db.prepare(`SELECT record_json FROM artifact_binding
                WHERE idempotency_key = ? OR (item_id = ? AND item_revision = ?)`).all(
                record.idempotency_key, record.item_id, record.item_revision);
            if (candidates.length) {
                if (candidates.length !== 1 || candidates[0].record_json !== json) {
                    throw new IdempotencyConflictError("artifact binding conflicts with immutable revision binding");
                }
                return JSON.parse(candidates[0].record_json);
            }
            const handoff = parseRecord(this.db.prepare("SELECT record_json FROM agent_handoff WHERE handoff_id = ?").get(record.final_handoff_id));
            if (!handoff || handoff.run_id !== record.run_id || handoff.item_id !== record.item_id
                || handoff.item_revision !== record.item_revision || handoff.output_digest !== record.artifact_digest
                || handoff.output_digest !== record.final_handoff_digest) {
                throw new StateConflictError("artifact binding does not match the exact persisted final handoff");
            }
            this.db.prepare(`INSERT INTO artifact_binding (binding_id, idempotency_key, run_id, item_id,
                item_revision, artifact_digest, final_handoff_id, final_handoff_digest, scope_digest,
                occurred_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.binding_id, record.idempotency_key, record.run_id, record.item_id, record.item_revision,
                record.artifact_digest, record.final_handoff_id, record.final_handoff_digest,
                record.scope_digest, record.occurred_at, json);
            return record;
        });
    }

    getArtifactBinding(itemId, itemRevision) {
        return parseRecord(this.db.prepare("SELECT record_json FROM artifact_binding WHERE item_id = ? AND item_revision = ?").get(itemId, itemRevision));
    }

    async recordPublicationTransaction(record, _context = {}) {
        const protectedAuthority = this.getGateDecisionAuthority(record.gate2_decision_event_id);
        if (!protectedAuthority) throw new StateConflictError("publication requires protected persisted Gate 2 authority evidence");
        const { decision, manifest, current_item: reviewedItem } = protectedAuthority;
        const track = manifest.track;
        await assertValidRecord("publication-transaction", record, { track });
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            if (decision.gate !== "gate-2" || decision.decision !== "approve"
                || decision.previous_state !== "gate2-pending" || decision.next_state !== "gate2-approved") {
                throw new StateConflictError("publication requires the protected positive Gate 2 approval");
            }
            const expectedBranch = `orchard/publication/${track}/${reviewedItem.item_id}/r${reviewedItem.item_revision}-${reviewedItem.artifact_digest.slice(7, 23)}`;
            const expected = {
                run_id: manifest.run_id, item_id: reviewedItem.item_id, item_revision: reviewedItem.item_revision,
                gate2_decision_event_id: decision.event_id, artifact_digest: reviewedItem.artifact_digest,
                proposal_digest: reviewedItem.proposal_digest, displayed_diff_digest: reviewedItem.displayed_diff_digest,
                prepared_tree_digest: reviewedItem.prepared_tree_digest, ado_external_key: reviewedItem.ado_external_key,
                handoff_chain_digest: reviewedItem.handoff_chain_digest, full_manifest_digest: manifest.full_manifest_digest,
                gate2_batch_digest: manifest.batch_digest, base_commit: reviewedItem.base_commit,
                target: { ...reviewedItem.target, protected_branch: "main", branch: expectedBranch },
                idempotency_key: `publication:${track}:${reviewedItem.item_id}:r${reviewedItem.item_revision}:${reviewedItem.artifact_digest}`
            };
            for (const [field, value] of Object.entries(expected)) exact(record[field], value, `publication ${field}`);
            const revision = this.db.prepare(`SELECT run_id, proposal_digest, artifact_digest, target_repository, target_path
                FROM item_revision WHERE item_id = ? AND item_revision = ?`).get(record.item_id, record.item_revision);
            // The revision's cached artifact_digest is nullable: discovery
            // creates a revision at proposal time, BEFORE any artifact exists,
            // so the source of truth for the artifact_digest is the immutable
            // artifact_binding record (checked below). Requiring the cached
            // column to match here made publication impossible for any item
            // authored after its revision was minted, which is every item
            // discovery produces. If the cached column IS populated on the
            // revision, it must still match, so a bound revision cannot drift.
            if (!revision || revision.run_id !== record.run_id || revision.proposal_digest !== record.proposal_digest
                || (revision.artifact_digest !== null && revision.artifact_digest !== record.artifact_digest)
                || revision.target_repository !== record.target.repository
                || revision.target_path !== record.target.path) {
                throw new StateConflictError("publication does not match the persisted item revision");
            }
            const artifactBinding = this.getArtifactBinding(record.item_id, record.item_revision);
            if (!artifactBinding || artifactBinding.artifact_digest !== record.artifact_digest) {
                throw new StateConflictError("publication does not match the persisted immutable artifact binding");
            }
            const ado = this.db.prepare(`SELECT external_id FROM external_link
                WHERE provider = 'ado' AND external_key = ? AND item_id = ? AND item_revision = ?`).all(
                record.ado_external_key, record.item_id, record.item_revision);
            if (ado.length !== 1 || !Number.isSafeInteger(Number(ado[0].external_id)) || Number(ado[0].external_id) < 1) {
                throw new StateConflictError("publication requires the exact persisted ADO link");
            }
            const replay = exactReplay(this.db, "publication_transaction", "transaction_id", record.transaction_id, record.idempotency_key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO publication_transaction
                (transaction_id, idempotency_key, run_id, item_id, item_revision, gate2_decision_event_id,
                 artifact_digest, proposal_digest, displayed_diff_digest, prepared_tree_digest, ado_external_key,
                 handoff_chain_digest, full_manifest_digest, gate2_batch_digest, target_repository,
                 target_path, base_commit, initial_state, record_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.transaction_id, record.idempotency_key, record.run_id, record.item_id,
                record.item_revision, record.gate2_decision_event_id, record.artifact_digest,
                record.proposal_digest, record.displayed_diff_digest, record.prepared_tree_digest,
                record.ado_external_key, record.handoff_chain_digest, record.full_manifest_digest,
                record.gate2_batch_digest, record.target.repository,
                record.target.path, record.base_commit, record.history[0].state, json, record.created_at
            );
            const insertEvent = this.db.prepare(`INSERT INTO publication_event
                (event_id, transaction_id, phase, state, intent_or_result, correlation_id,
                 evidence_digest, idempotency_key, occurred_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const [index, event] of record.history.entries()) {
                const phase = publicationPhase(event.state);
                const eventRecord = { ...event, transaction_id: record.transaction_id, phase };
                insertEvent.run(randomUUID(), record.transaction_id, phase, event.state, index === 0 ? "intent" : "result",
                    event.correlation_id, event.evidence_digest ?? null, `publication-history:${record.transaction_id}:${index}`,
                    event.occurred_at, canonicalJson(eventRecord));
            }
            return record;
        });
    }

    recordPublicationEvent(record) {
        const id = required(record.event_id ?? record.eventId, "event_id");
        const key = genericKey("publication-event", record);
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "publication_event", "event_id", id, key, json);
            if (replay) return replay;
            this.db.prepare(`INSERT INTO publication_event
                (event_id, transaction_id, phase, state, intent_or_result, correlation_id,
                 evidence_digest, idempotency_key, occurred_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                id, required(record.transaction_id, "transaction_id"), required(record.phase, "phase"),
                required(record.state, "state"), required(record.intent_or_result, "intent_or_result"),
                required(record.correlation_id, "correlation_id"), record.evidence_digest ?? null,
                key, required(record.occurred_at, "occurred_at"), json
            );
            return record;
        });
    }

    async recordClosurePacket(record) {
        await assertValidRecord("closure-evidence-packet", record);
        if (record.packet_digest !== closurePacketDigest(record)) throw new StateConflictError("closure packet digest does not match immutable evidence");
        const json = canonicalJson(record);
        const key = `closure-packet:${record.packet_digest}`;
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "closure_packet", "packet_id", record.packet_id, key, json);
            if (replay) return replay;
            const existingPacket = this.db.prepare("SELECT packet_id, packet_digest FROM closure_packet WHERE item_id = ? AND item_revision = ?")
                .get(record.item_id, record.item_revision);
            if (existingPacket) throw new IdempotencyConflictError("item revision already has a different closure packet");
            const revision = this.db.prepare("SELECT run_id, proposal_digest, target_repository, target_path FROM item_revision WHERE item_id = ? AND item_revision = ?")
                .get(record.item_id, record.item_revision);
            if (!revision || revision.run_id !== record.run_id || revision.proposal_digest !== record.proposal_digest
                || revision.target_repository !== record.canonical_target.repository
                || revision.target_path !== record.canonical_target.path) throw new StateConflictError("closure packet does not match the persisted item revision");
            const binding = this.getArtifactBinding(record.item_id, record.item_revision);
            if (!binding) throw new StateConflictError("closure packet requires a persisted artifact binding");
            exact(record.artifact_binding, binding, "closure artifact binding");
            for (const [gate, evidence] of [["gate-1", record.gate_1], ["gate-2", record.gate_2]]) {
                const decision = this.db.prepare("SELECT gate, run_id, item_id, item_revision, digest, decision FROM decision_event WHERE event_id = ?").get(evidence.event_id);
                if (!decision || decision.gate !== gate || decision.decision !== "approve" || decision.run_id !== record.run_id || decision.item_id !== record.item_id
                    || Number(decision.item_revision) !== record.item_revision || decision.digest !== evidence.digest) {
                    throw new StateConflictError(`closure packet does not match the persisted ${gate} decision`);
                }
            }
            const handoffs = this.listHandoffs(record.item_id, record.item_revision);
            exact(record.handoff_ids, handoffs.map((handoff) => handoff.handoff_id), "closure handoff IDs");
            if (!handoffs.length || handoffs.at(-1).handoff_id !== binding.final_handoff_id
                || handoffs.at(-1).output_digest !== record.artifact_digest) throw new StateConflictError("closure handoff chain does not produce the bound artifact");
            const publication = parseRecord(this.db.prepare("SELECT record_json FROM publication_transaction WHERE transaction_id = ?")
                .get(record.publication_transaction_id));
            if (!publication || publication.ado_external_key !== record.ado.external_key || publication.item_id !== record.item_id
                || publication.item_revision !== record.item_revision || publication.artifact_digest !== record.artifact_digest
                || publication.displayed_diff_digest !== record.displayed_diff_digest || publication.prepared_tree_digest !== record.prepared_tree_digest
                || publication.base_commit !== record.base_commit || publication.handoff_chain_digest !== record.handoff_chain_digest) {
                throw new StateConflictError("closure packet does not match the persisted publication transaction");
            }
            if (!this.getPublicationAuthority(record.publication_transaction_id)) {
                throw new StateConflictError("closure packet requires protected publication adapter authority evidence");
            }
            const publicationState = this.getPublicationState(publication.idempotency_key);
            if (publicationState?.state !== "published") throw new StateConflictError("closure packet requires a completed publication");
            exact(record.push_acknowledgement, publicationState.push_acknowledgement, "closure push acknowledgement");
            if (!publicationState.events.some((event) => event.intent_or_result === "result")) throw new StateConflictError("closure packet requires exact publication result events");
            const link = this.db.prepare("SELECT external_id FROM external_link WHERE provider = 'ado' AND external_key = ?").get(record.ado.external_key);
            if (!link || Number(link.external_id) !== record.ado.work_item_id) throw new StateConflictError("closure packet does not match the persisted ADO link");
            this.db.prepare(`INSERT INTO closure_packet
                (packet_id, packet_digest, idempotency_key, run_id, track, item_id, item_revision,
                 proposal_digest, artifact_digest, scope_digest, handoff_chain_digest,
                 gate1_decision_event_id, gate2_decision_event_id, ado_external_key, ado_work_item_id,
                 publication_transaction_id, protected_main_commit, prepared_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.packet_id, record.packet_digest, key, record.run_id, record.track, record.item_id,
                record.item_revision, record.proposal_digest, record.artifact_digest, record.scope_digest,
                record.handoff_chain_digest, record.gate_1.event_id, record.gate_2.event_id,
                record.ado.external_key, record.ado.work_item_id, record.publication_transaction_id,
                record.protected_main_commit, record.prepared_at, json
            );
            return record;
        });
    }

    recordClosureAcceptance() {
        throw new StateConflictError("raw closure acceptance persistence is forbidden; use recordVerifiedClosureAcceptance");
    }

    validateClosureAcceptanceAuthority(authority) {
        const { acceptance: record, verified_event: providerEvent, owner_policy: ownerPolicy, trust } = authority ?? {};
        for (const key of ["acceptance_id", "packet_digest", "owner", "source", "accepted_at"]) required(record[key], key);
        const anchor = this.getTrustAnchor("closure");
        const protectedTrust = anchor ? {
            policy_digest: anchor.policy_digest,
            adapter_digest: anchor.adapter_digest,
            adapter_identity: anchor.adapter_identity
        } : null;
        if (!protectedTrust || !/^sha256:[a-f0-9]{64}$/.test(protectedTrust.policy_digest ?? "")
            || !/^sha256:[a-f0-9]{64}$/.test(protectedTrust.adapter_digest ?? "")
            || typeof protectedTrust.adapter_identity !== "string" || !protectedTrust.adapter_identity) {
            throw new StateConflictError("closure acceptance requires administrator-protected policy and adapter pins");
        }
        if (!trust || trust.owner_policy_digest !== protectedTrust.policy_digest
            || trust.adapter_digest !== protectedTrust.adapter_digest
            || trust.adapter_identity !== protectedTrust.adapter_identity
            || sha256Digest(ownerPolicy) !== protectedTrust.policy_digest
            || sha256Digest(providerEvent) !== trust.provider_event_digest) {
            throw new StateConflictError("closure acceptance evidence does not match protected trust pins");
        }
        if (!Array.isArray(ownerPolicy?.authorized_owners) || ownerPolicy.authorized_owners.length === 0) {
            throw new StateConflictError("closure acceptance requires a non-empty protected owner policy");
        }
        if (record.owner?.authorized !== undefined || !record.owner.provider || !record.owner.immutable_id) throw new StateConflictError("self-asserted owner authorization is forbidden");
        if (ownerPolicy.provider !== record.owner.provider || !ownerPolicy.authorized_owners.some((owner) => owner.provider === record.owner.provider
            && String(owner.immutable_id) === String(record.owner.immutable_id))) throw new StateConflictError("closure acceptance owner is not authorized by policy");
        if (!record.source?.provider || !record.source.reference || record.source.provider !== record.owner.provider
            || record.source.evidence_digest !== trust.provider_event_digest) {
            throw new StateConflictError("closure acceptance requires exact source evidence");
        }
        if (providerEvent?.packet_digest !== record.packet_digest
            || providerEvent?.reference !== record.source.reference
            || providerEvent?.occurred_at !== record.accepted_at
            || providerEvent?.actor?.provider !== record.owner.provider
            || String(providerEvent?.actor?.immutable_id) !== String(record.owner.immutable_id)) {
            throw new StateConflictError("authenticated closure event does not bind the acceptance");
        }
        const acceptedAt = canonicalTimestamp(record.accepted_at, "closure acceptance accepted_at");
        return { record, providerEvent, ownerPolicy, trust, acceptedAt };
    }

    recordVerifiedClosureAcceptance(authority) {
        const { record, providerEvent, ownerPolicy, trust, acceptedAt } = this.validateClosureAcceptanceAuthority(authority);
        const json = canonicalJson(record);
        const key = `closure-acceptance:${record.packet_digest}:${record.owner.provider}:${record.owner.immutable_id}`;
        const authorityRecord = {
            acceptance: record, verified_event: providerEvent, owner_policy: ownerPolicy,
            trust: {
                owner_policy_digest: trust.owner_policy_digest, provider_event_digest: trust.provider_event_digest,
                adapter_digest: trust.adapter_digest, adapter_identity: trust.adapter_identity
            }
        };
        authorityRecord.evidence_digest = sha256Digest(authorityRecord);
        const authorityJson = canonicalJson(authorityRecord);
        return transaction(this.db, () => {
            const replay = exactReplay(this.db, "closure_acceptance", "acceptance_id", record.acceptance_id, key, json);
            if (replay) {
                const evidence = parseRecord(this.db.prepare("SELECT record_json FROM closure_owner_authority WHERE acceptance_id = ?").get(record.acceptance_id));
                if (!evidence || canonicalJson(evidence) !== authorityJson) throw new IdempotencyConflictError("closure acceptance replay lacks exact protected authority evidence");
                return replay;
            }
            const existingAcceptance = this.db.prepare("SELECT acceptance_id FROM closure_acceptance WHERE packet_digest = ?").get(record.packet_digest);
            if (existingAcceptance) throw new IdempotencyConflictError("closure packet already has a different acceptance");
            const packet = this.getClosurePacket(record.packet_digest);
            if (!packet) throw new StateConflictError("closure acceptance packet does not exist");
            if (acceptedAt < canonicalTimestamp(packet.prepared_at, "closure packet prepared_at")) throw new StateConflictError("closure acceptance predates its packet");
            this.db.prepare(`INSERT INTO closure_acceptance
                (acceptance_id, packet_digest, idempotency_key, owner_provider, owner_immutable_id,
                 source_provider, source_reference, source_evidence_digest, accepted_at, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                record.acceptance_id, record.packet_digest, key, record.owner.provider,
                record.owner.immutable_id, record.source.provider, record.source.reference,
                record.source.evidence_digest, record.accepted_at, json
            );
            this.db.prepare(`INSERT INTO closure_owner_authority
                (acceptance_id, owner_policy_digest, provider_event_digest, adapter_digest,
                 adapter_identity, evidence_digest, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
                record.acceptance_id, trust.owner_policy_digest, trust.provider_event_digest,
                trust.adapter_digest, trust.adapter_identity, authorityRecord.evidence_digest, authorityJson
            );
            return record;
        });
    }

    recordClosureAdoEvent(record) {
        canonicalTimestamp(record.occurred_at, "closure ADO event occurred_at");
        if (!["Resolved", "Closed"].includes(record.state) || record.result_digest !== sha256Digest(record.result)) {
            throw new StateConflictError("closure ADO result event is invalid");
        }
        const packet = this.getClosurePacket(record.packet_digest);
        if (!packet || packet.ado.work_item_id !== record.ado_work_item_id || packet.ado.external_key !== record.ado_external_key) {
            throw new StateConflictError("closure ADO result event does not match its packet");
        }
        if (record.state === "Closed" && !this.getClosureAcceptance(record.packet_digest)) {
            throw new StateConflictError("Closed ADO result event requires persisted owner acceptance");
        }
        const json = canonicalJson(record);
        return transaction(this.db, () => {
            const existing = this.db.prepare(`SELECT record_json FROM closure_ado_event
                WHERE idempotency_key = ? OR (packet_digest = ? AND state = ?)`).all(
                record.idempotency_key, record.packet_digest, record.state);
            if (existing.length) {
                if (existing.length !== 1 || existing[0].record_json !== json) throw new IdempotencyConflictError("closure ADO result event conflicts with immutable evidence");
                return JSON.parse(existing[0].record_json);
            }
            this.db.prepare(`INSERT INTO closure_ado_event (event_id, packet_digest, state, ado_work_item_id,
                ado_external_key, result_digest, occurred_at, idempotency_key, record_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.event_id, record.packet_digest, record.state,
                record.ado_work_item_id, record.ado_external_key, record.result_digest, record.occurred_at,
                record.idempotency_key, json);
            return record;
        });
    }

    getRun(runId) { return parseRecord(this.db.prepare("SELECT record_json FROM workflow_run WHERE run_id = ?").get(runId)); }
    getItem(itemId, revision = undefined) {
        const row = revision === undefined
            ? this.db.prepare("SELECT r.record_json FROM workflow_item i JOIN item_revision r ON r.item_id = i.item_id AND r.item_revision = i.current_revision WHERE i.item_id = ?").get(itemId)
            : this.db.prepare("SELECT record_json FROM item_revision WHERE item_id = ? AND item_revision = ?").get(itemId, revision);
        if (!row) return null;
        const record = parseRecord(row);
        if (revision === undefined) {
            const current = this.db.prepare("SELECT current_state, current_revision, superseded_by_item_id, updated_at FROM workflow_item WHERE item_id = ?").get(itemId);
            return { ...record, state: current.current_state, item_revision: Number(current.current_revision), superseded_by_item_id: current.superseded_by_item_id, updated_at: current.updated_at };
        }
        return record;
    }
    listTransitions(itemId) { return this.db.prepare("SELECT record_json FROM state_transition_event WHERE item_id = ? ORDER BY occurred_at, transition_id").all(itemId).map(parseRecord); }
    listDecisions(itemId) { return this.db.prepare("SELECT record_json FROM decision_event WHERE item_id = ? ORDER BY occurred_at, event_id").all(itemId).map(parseRecord); }
    getGateDecisionAuthority(eventId) {
        const row = this.db.prepare("SELECT * FROM gate_decision_authority WHERE event_id = ?").get(eventId);
        if (!row) return null;
        const evidence = JSON.parse(row.record_json);
        const digestInput = structuredClone(evidence);
        delete digestInput.evidence_digest;
        if (sha256Digest(digestInput) !== evidence.evidence_digest || evidence.evidence_digest !== row.evidence_digest
            || evidence.trust.provider_event_digest !== row.provider_event_digest
            || evidence.trust.authorization_policy_digest !== row.authorization_policy_digest
            || evidence.trust.adapter_digest !== row.adapter_digest
            || evidence.trust.adapter_identity !== row.adapter_identity) {
            throw new StateConflictError("persisted gate authority evidence failed immutable reconciliation");
        }
        return evidence;
    }
    getDispatchBinding(reference) {
        const keys = Object.keys(reference ?? {}).sort();
        if (canonicalJson(keys) !== canonicalJson(["gate1_decision_event_id", "queue_work_item_id"])) {
            throw new StateConflictError("dispatch authority must contain only immutable queue and Gate 1 decision references");
        }
        if (!Number.isSafeInteger(reference.queue_work_item_id) || reference.queue_work_item_id < 1) {
            throw new StateConflictError("dispatch queue work item reference must be a positive integer");
        }
        const authority = this.getGateDecisionAuthority(reference.gate1_decision_event_id);
        if (!authority) {
            throw new StateConflictError("no exact persisted dispatch authority exists for the queue work item");
        }
        // The work item is created after the approval, so the id lives on the
        // external_link row written at creation time (checked below), not on
        // the decision. An authority recorded before that ordering fix may
        // still carry the id, and then it must agree exactly.
        if (authority.queue_work_item_id !== null && authority.queue_work_item_id !== reference.queue_work_item_id) {
            throw new StateConflictError("no exact persisted dispatch authority exists for the queue work item");
        }
        const { decision, manifest, current_item: reviewedItem } = authority;
        if (decision.gate !== "gate-1" || decision.decision !== "approve"
            || decision.previous_state !== "gate1-pending" || decision.next_state !== "gate1-approved") {
            throw new StateConflictError("dispatch requires a persisted positive Gate 1 approval");
        }
        const revision = this.db.prepare(`SELECT run_id, proposal_digest, target_repository, target_path
            FROM item_revision WHERE item_id = ? AND item_revision = ?`).get(decision.item_id, decision.item_revision);
        if (!revision || revision.run_id !== decision.run_id || revision.proposal_digest !== decision.digest
            || revision.target_repository !== reviewedItem.target.repository || revision.target_path !== reviewedItem.target.path) {
            throw new StateConflictError("current persisted revision differs from the Gate 1 reviewed item");
        }
        const expectedKey = `orchard:${manifest.track}:${decision.item_id}:r${decision.item_revision}`;
        const links = this.db.prepare(`SELECT external_id, record_json FROM external_link
            WHERE provider = 'ado' AND external_key = ? AND item_id = ? AND item_revision = ?`).all(
            expectedKey, decision.item_id, decision.item_revision);
        if (links.length !== 1 || !Number.isSafeInteger(Number(links[0].external_id)) || Number(links[0].external_id) < 1) {
            throw new StateConflictError("dispatch requires exactly one positive persisted ADO binding");
        }
        if (Number(links[0].external_id) !== reference.queue_work_item_id) {
            throw new StateConflictError("dispatch queue work item does not match the persisted ADO binding");
        }
        const linkRecord = JSON.parse(links[0].record_json);
        const persistedBinding = linkRecord.binding ?? linkRecord;
        if (persistedBinding.gate1_decision_event_id !== decision.event_id
            || persistedBinding.proposal_digest !== decision.digest
            || persistedBinding.target?.repository !== reviewedItem.target.repository
            || persistedBinding.target?.path !== reviewedItem.target.path) {
            throw new StateConflictError("persisted ADO link does not bind the exact Gate 1 authority");
        }
        return Object.freeze({
            queue_work_item_id: reference.queue_work_item_id, run_id: decision.run_id, track: manifest.track,
            item_id: decision.item_id, item_revision: decision.item_revision, proposal_digest: decision.digest,
            target: structuredClone(reviewedItem.target), gate1_decision_event_id: decision.event_id,
            ado_external_key: expectedKey, ado_work_item_id: Number(links[0].external_id)
        });
    }
    listRunOutcomes(runId) { return this.db.prepare("SELECT record_json FROM run_outcome WHERE run_id = ? ORDER BY occurred_at, outcome_id").all(runId).map(parseRecord); }
    listObservations(runId) { return this.db.prepare("SELECT record_json FROM observation_event WHERE run_id = ? ORDER BY observed_at, observation_id").all(runId).map(parseRecord); }
    listHandoffs(itemId, itemRevision) {
        return this.db.prepare("SELECT record_json FROM agent_handoff WHERE item_id = ? AND item_revision = ? ORDER BY completed_at, handoff_id")
            .all(itemId, itemRevision).map(parseRecord);
    }
    findExternalLinks(itemId, itemRevision) {
        return this.db.prepare("SELECT record_json FROM external_link WHERE item_id = ? AND item_revision = ? ORDER BY linked_at, link_id")
            .all(itemId, itemRevision).map(parseRecord);
    }
    findExternalLink(provider, externalKey) { return parseRecord(this.db.prepare("SELECT record_json FROM external_link WHERE provider = ? AND external_key = ?").get(provider, externalKey)); }
    reconcileExternalLink(provider, externalKey, expected = {}) {
        const record = this.findExternalLink(provider, externalKey);
        if (!record) return { status: "missing", record: null };
        for (const [field, value] of Object.entries(expected)) {
            if (value !== undefined && record[field] !== value) return { status: "conflict", field, expected: value, actual: record[field], record };
        }
        return { status: "matched", record };
    }
    getPublicationTransaction(idempotencyKey) { return parseRecord(this.db.prepare("SELECT record_json FROM publication_transaction WHERE idempotency_key = ?").get(idempotencyKey)); }
    getPublicationAuthority(transactionId) {
        const row = this.db.prepare("SELECT * FROM publication_authority WHERE transaction_id = ?").get(transactionId);
        if (!row) return null;
        const record = JSON.parse(row.record_json);
        const digestInput = structuredClone(record);
        delete digestInput.evidence_digest;
        if (sha256Digest(digestInput) !== record.evidence_digest || record.evidence_digest !== row.evidence_digest
            || record.adapter_identity !== row.adapter_identity || record.adapter_digest !== row.adapter_digest
            || record.trust_anchor_digest !== row.trust_anchor_digest) {
            throw new StateConflictError("persisted publication authority failed immutable reconciliation");
        }
        return record;
    }
    findPublicationEvent(idempotencyKey) {
        return parseRecord(this.db.prepare("SELECT record_json FROM publication_event WHERE idempotency_key = ?").get(idempotencyKey));
    }
    getClosurePacket(packetDigest) { return parseRecord(this.db.prepare("SELECT record_json FROM closure_packet WHERE packet_digest = ?").get(packetDigest)); }
    getClosureAcceptance(packetDigest) { return parseRecord(this.db.prepare("SELECT record_json FROM closure_acceptance WHERE packet_digest = ?").get(packetDigest)); }
    listClosureAdoEvents(packetDigest) {
        return this.db.prepare("SELECT record_json FROM closure_ado_event WHERE packet_digest = ? ORDER BY occurred_at, event_id")
            .all(packetDigest).map(parseRecord);
    }
    listPublicationEvents(transactionId) {
        return this.db.prepare("SELECT record_json FROM publication_event WHERE transaction_id = ? ORDER BY rowid").all(transactionId).map(parseRecord);
    }
    getPublicationState(idempotencyKey) {
        const transactionRecord = this.getPublicationTransaction(idempotencyKey);
        if (!transactionRecord) return null;
        const events = this.listPublicationEvents(transactionRecord.transaction_id);
        const results = events.filter((event) => event.intent_or_result === "result");
        const last = results.at(-1);
        return {
            transaction: transactionRecord,
            events,
            state: last?.state ?? transactionRecord.state,
            result_commit: [...results].reverse().find((event) => event.result_commit)?.result_commit ?? null,
            push_acknowledgement: [...results].reverse().find((event) => event.push_acknowledgement)?.push_acknowledgement ?? null
        };
    }
    verify() {
        const integrity = this.db.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0]));
        const foreignKeys = this.db.prepare("PRAGMA foreign_key_check").all();
        return { ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0, integrity, foreignKeys };
    }
}

function publicationPhase(state) {
    if (state === "created" || state === "preparing") return "prepare";
    if (state === "validating") return "validate";
    if (state === "pr-open") return "pr-open";
    if (["merge-pending", "merging"].includes(state)) return "merge";
    if (state === "acknowledging" || state === "published") return "acknowledge";
    if (state === "reconciling") return "reconcile";
    if (["rollback-pending", "rolled-back"].includes(state)) return "rollback";
    if (["blocked", "failed"].includes(state)) return "reconcile";
    throw new StateConflictError(`unknown publication state: ${state}`);
}

export function openStateStore(path, options) {
    return new StateStore(path, options);
}
