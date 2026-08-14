import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, sha256Digest, validateTargetPath } from "./identity.mjs";

const SCHEMA_DIRECTORY = new URL("../../contracts/schemas/", import.meta.url);

export const schemaRegistry = Object.freeze({
    "agent-handoff": "agent-handoff.schema.json",
    "closure-evidence-packet": "closure-evidence-packet.schema.json",
    "decision-event": "decision-event.schema.json",
    "gate-1-issue-manifest": "gate-1-issue-manifest.schema.json",
    "gate-2-issue-manifest": "gate-2-issue-manifest.schema.json",
    "item-record": "item-record.schema.json",
    "publication-transaction": "publication-transaction.schema.json",
    "run-manifest": "run-manifest.schema.json",
    "state-transition": "state-transition.schema.json"
});

const validatorCache = new Map();
let ajvInstance;

function createAjv() {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ajv.addFormat("date", {
        type: "string",
        validate(value) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const [year, month, day] = value.split("-").map(Number);
            const date = new Date(Date.UTC(year, month - 1, day));
            return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
        }
    });
    ajv.addFormat("date-time", {
        type: "string",
        validate(value) {
            return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
                && Number.isFinite(Date.parse(value));
        }
    });
    return ajv;
}

function error(code, path, message, details = undefined) {
    return { code, path, message, ...(details === undefined ? {} : { details }) };
}

function stableErrors(errors) {
    return [...errors].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function ajvErrors(errors = []) {
    return stableErrors(errors.map((entry) => error(
        `schema.${entry.keyword}`,
        entry.instancePath || "/",
        entry.message ?? "schema validation failed",
        entry.params
    )));
}

function equality(errors, path, actual, expected, label) {
    if (actual !== undefined && expected !== undefined && actual !== expected) {
        errors.push(error("binding.mismatch", path, `${label} must match`, { actual, expected }));
    }
}

function targetEquality(errors, path, actual, expected, label) {
    if (!actual || !expected) return;
    equality(errors, `${path}/repository`, actual.repository, expected.repository, `${label} repository`);
    equality(errors, `${path}/path`, actual.path, expected.path, `${label} path`);
}

function validateRunInvariants(record) {
    const errors = [];
    if (record.status !== "completed" || record.scope?.mode !== "full") return errors;

    if (record.track === "track-1") {
        const coverage = record.coverage ?? {};
        if (coverage.approved_enabled_source_count < 50) {
            errors.push(error("run.track1.approved-source-threshold", "/coverage/approved_enabled_source_count", "a completed full Track 1 run requires at least 50 approved enabled sources"));
        }
        if (coverage.attempted < 50) {
            errors.push(error("run.track1.attempt-threshold", "/coverage/attempted", "a completed full Track 1 run requires at least 50 attempted sources"));
        }
        const accountedAttempts = coverage.successfully_evaluated + coverage.rate_limited + coverage.failed + (coverage.blocked ?? 0);
        if (coverage.attempted !== accountedAttempts) {
            errors.push(error("run.track1.attempt-accounting", "/coverage/attempted", "attempted must equal successfully_evaluated + rate_limited + failed + blocked", { actual: coverage.attempted, expected: accountedAttempts }));
        }
        const accountedRegistry = coverage.attempted + coverage.skipped + coverage.unevaluated;
        if (coverage.approved_enabled_source_count !== accountedRegistry) {
            errors.push(error("run.track1.registry-accounting", "/coverage/approved_enabled_source_count", "approved_enabled_source_count must equal attempted + skipped + unevaluated", { actual: coverage.approved_enabled_source_count, expected: accountedRegistry }));
        }
        if (coverage.redirected > coverage.successfully_evaluated) {
            errors.push(error("run.track1.redirect-accounting", "/coverage/redirected", "redirected sources cannot exceed successfully evaluated sources"));
        }
        if (coverage.stale > coverage.approved_enabled_source_count) {
            errors.push(error("run.track1.stale-accounting", "/coverage/stale", "stale sources cannot exceed approved enabled sources"));
        }
    }

    if (record.track === "track-2") {
        const coverage = record.coverage ?? {};
        for (const [name, actual] of [["enumerated", coverage.enumerated], ["inspected", coverage.inspected]]) {
            if (actual !== coverage.expected) {
                errors.push(error("run.track2.coverage-mismatch", `/coverage/${name}`, `${name} must equal expected for a completed full Track 2 run`, { actual, expected: coverage.expected }));
            }
        }
        equality(errors, "/scope/expected_count", record.scope?.expected_count, coverage.expected, "scope expected_count and coverage expected");
        if (coverage.gaps !== 0) errors.push(error("run.track2.gaps", "/coverage/gaps", "a completed full Track 2 run requires zero gaps"));
    }
    return errors;
}

function validateGateInvariants(record) {
    const errors = [];
    if (record.batch) {
        equality(errors, "/batch/item_count", record.batch.item_count, record.items?.length, "batch item_count and items length");
        if (record.batch.ordinal > record.batch.count) errors.push(error("gate.batch.ordinal", "/batch/ordinal", "batch ordinal cannot exceed batch count"));
        if (record.batch.total_item_count < record.items?.length) errors.push(error("gate.batch.total", "/batch/total_item_count", "total_item_count cannot be smaller than this batch"));
    }
    const expectedKey = `github:${record.gate}:${record.run_id}:${record.batch_digest}`;
    equality(errors, "/idempotency_key", record.idempotency_key, expectedKey, "gate idempotency key");
    return errors;
}

function validatePublicationInvariants(record, context = {}) {
    const errors = [];
    const track = context.track ?? context.item?.track ?? context.gate2?.track;
    if (track) {
        const expectedKey = `publication:${track}:${record.item_id}:r${record.item_revision}:${record.artifact_digest}`;
        equality(errors, "/idempotency_key", record.idempotency_key, expectedKey, "publication idempotency key");
    }
    if (record.pull_request) {
        equality(errors, "/pull_request/displayed_diff_digest", record.pull_request.displayed_diff_digest, record.displayed_diff_digest, "pull request and transaction displayed diff digests");
        equality(errors, "/pull_request/prepared_tree_digest", record.pull_request.prepared_tree_digest, record.prepared_tree_digest, "pull request and transaction prepared tree digests");
    }
    if (record.state === "published") {
        equality(errors, "/push_acknowledgement/commit", record.push_acknowledgement?.commit, record.result_commit, "push acknowledgement and result commit");
        equality(errors, "/push_acknowledgement/repository", record.push_acknowledgement?.repository, record.target?.repository, "push acknowledgement and target repository");
        equality(errors, "/push_acknowledgement/branch", record.push_acknowledgement?.branch, record.target?.protected_branch, "push acknowledgement and protected branch");
    }
    return errors;
}

function validateTransitionInvariants(record) {
    if (record.cause === "revision-created" && record.successor_revision <= record.item_revision) {
        return [error("transition.revision.monotonic", "/successor_revision", "successor_revision must be greater than item_revision")];
    }
    return [];
}

export function closurePacketDigest(record) {
    const immutable = structuredClone(record);
    delete immutable.packet_digest;
    return sha256Digest(immutable);
}

function validateClosurePacketInvariants(record) {
    const errors = [];
    equality(errors, "/packet_digest", record.packet_digest, closurePacketDigest(record), "closure packet digest");
    equality(errors, "/gate_1/digest", record.gate_1?.digest, record.proposal_digest, "Gate 1 and proposal digests");
    equality(errors, "/gate_2/digest", record.gate_2?.digest, record.artifact_digest, "Gate 2 and artifact digests");
    equality(errors, "/push_acknowledgement/commit", record.push_acknowledgement?.commit, record.protected_main_commit, "push acknowledgement and protected-main commit");
    equality(errors, "/push_acknowledgement/repository", record.push_acknowledgement?.repository, record.canonical_target?.repository, "push acknowledgement and target repository");
    equality(errors, "/push_acknowledgement/branch", record.push_acknowledgement?.branch, record.canonical_target?.protected_branch, "push acknowledgement and protected branch");
    equality(errors, "/artifact_binding/run_id", record.artifact_binding?.run_id, record.run_id, "artifact binding and run");
    equality(errors, "/artifact_binding/item_id", record.artifact_binding?.item_id, record.item_id, "artifact binding and item");
    equality(errors, "/artifact_binding/item_revision", record.artifact_binding?.item_revision, record.item_revision, "artifact binding and item revision");
    equality(errors, "/artifact_binding/artifact_digest", record.artifact_binding?.artifact_digest, record.artifact_digest, "artifact binding and artifact");
    equality(errors, "/artifact_binding/final_handoff_digest", record.artifact_binding?.final_handoff_digest, record.artifact_digest, "final handoff and artifact");
    equality(errors, "/artifact_binding/scope_digest", record.artifact_binding?.scope_digest, record.scope_digest, "artifact binding and scope");
    if (record.handoff_ids && record.artifact_binding) equality(errors, "/artifact_binding/final_handoff_id",
        record.artifact_binding.final_handoff_id, record.handoff_ids.at(-1), "artifact binding and final handoff ID");
    const expectedKey = record.track && record.item_id && record.item_revision
        ? `orchard:${record.track}:${record.item_id}:r${record.item_revision}` : undefined;
    equality(errors, "/ado/external_key", record.ado?.external_key, expectedKey, "closure ADO external key");
    return errors;
}

function recordInvariants(name, record, context) {
    if (name === "run-manifest") return validateRunInvariants(record);
    if (name === "gate-1-issue-manifest" || name === "gate-2-issue-manifest") return validateGateInvariants(record);
    if (name === "publication-transaction") return validatePublicationInvariants(record, context);
    if (name === "state-transition") return validateTransitionInvariants(record);
    if (name === "closure-evidence-packet") return validateClosurePacketInvariants(record);
    if (name === "item-record") {
        try {
            validateTargetPath(record.target?.path);
            return [];
        } catch (pathError) {
            return [error("item.target.unsafe", "/target/path", pathError.message)];
        }
    }
    return [];
}

export class ContractValidationError extends Error {
    constructor(schemaName, errors) {
        super(`${schemaName} contract validation failed: ${errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
        this.name = "ContractValidationError";
        this.schemaName = schemaName;
        this.errors = errors;
    }
}

export async function loadJson(pathOrUrl) {
    const text = await readFile(pathOrUrl, "utf8");
    try {
        return JSON.parse(text);
    } catch (parseError) {
        throw new SyntaxError(`invalid JSON in ${pathOrUrl instanceof URL ? fileURLToPath(pathOrUrl) : pathOrUrl}: ${parseError.message}`);
    }
}

export async function loadSchema(name) {
    const fileName = schemaRegistry[name];
    if (!fileName) throw new RangeError(`unknown Orchard schema: ${name}`);
    return loadJson(new URL(fileName, SCHEMA_DIRECTORY));
}

export async function compileSchema(name) {
    if (validatorCache.has(name)) return validatorCache.get(name);
    const schema = await loadSchema(name);
    ajvInstance ??= createAjv();
    const validator = ajvInstance.compile(schema);
    validatorCache.set(name, validator);
    return validator;
}

export async function validateRecord(name, record, context = {}) {
    const validator = await compileSchema(name);
    const schemaValid = validator(record);
    const errors = [
        ...(schemaValid ? [] : ajvErrors(validator.errors)),
        ...(schemaValid ? recordInvariants(name, record, context) : [])
    ];
    return { valid: errors.length === 0, errors: stableErrors(errors) };
}

export async function assertValidRecord(name, record, context = {}) {
    const result = await validateRecord(name, record, context);
    if (!result.valid) throw new ContractValidationError(name, result.errors);
    return record;
}

function findBoundItem(manifest, itemId) {
    return manifest?.items?.find((entry) => entry.item_id === itemId);
}

export function validateContractBindings(records) {
    const { run, item, gate1, gate1Decision, handoffs = [], gate2, gate2Decision, publication } = records;
    const errors = [];
    const linked = [
        [item, "item"], [gate1, "gate1"], [gate1Decision, "gate1Decision"],
        ...handoffs.map((handoff, index) => [handoff, `handoffs/${index}`]),
        [gate2, "gate2"], [gate2Decision, "gate2Decision"], [publication, "publication"]
    ];
    for (const [record, path] of linked) {
        if (!record) continue;
        equality(errors, `/${path}/run_id`, record.run_id, run?.run_id, `${path} run_id`);
        equality(errors, `/${path}/track`, record.track, run?.track, `${path} track`);
    }
    if (item && run) equality(errors, "/item/track", item.track, run.track, "item track");

    const gate1Item = findBoundItem(gate1, item?.item_id);
    const gate2Item = findBoundItem(gate2, item?.item_id);
    if (gate1 && item && !gate1Item) errors.push(error("binding.gate1.item-missing", "/gate1/items", "Gate 1 must contain the bound item"));
    if (gate2 && item && !gate2Item) errors.push(error("binding.gate2.item-missing", "/gate2/items", "Gate 2 must contain the bound item"));

    for (const [bound, path] of [[gate1Item, "gate1/items"], [gate2Item, "gate2/items"]]) {
        if (!bound || !item) continue;
        equality(errors, `/${path}/item_revision`, bound.item_revision, item.item_revision, `${path} item revision`);
        equality(errors, `/${path}/proposal_digest`, bound.proposal_digest, item.proposal_digest, `${path} proposal digest`);
        targetEquality(errors, `/${path}/target`, bound.target, item.target, `${path} target`);
    }
    if (gate1Item && item) equality(errors, "/gate1/items/category", gate1Item.category, item.outcome, "Gate 1 category and item outcome");
    if (gate2Item && item?.artifact_digest != null) equality(errors, "/gate2/items/artifact_digest", gate2Item.artifact_digest, item.artifact_digest, "Gate 2 and item artifact digest");

    for (const [decision, gate, bound, path] of [[gate1Decision, "gate-1", gate1Item, "gate1Decision"], [gate2Decision, "gate-2", gate2Item, "gate2Decision"]]) {
        if (!decision) continue;
        equality(errors, `/${path}/gate`, decision.gate, gate, `${path} gate`);
        equality(errors, `/${path}/item_id`, decision.item_id, item?.item_id, `${path} item_id`);
        equality(errors, `/${path}/item_revision`, decision.item_revision, item?.item_revision, `${path} item revision`);
        equality(errors, `/${path}/digest`, decision.digest, gate === "gate-1" ? bound?.proposal_digest : bound?.artifact_digest, `${path} approved digest`);
        if (publication && path === "gate2Decision") equality(errors, "/publication/gate2_decision_event_id", publication.gate2_decision_event_id, decision.event_id, "publication Gate 2 decision event");
    }

    for (const [index, handoff] of handoffs.entries()) {
        const prefix = `/handoffs/${index}`;
        equality(errors, `${prefix}/item_id`, handoff.item_id, item?.item_id, "handoff item_id");
        equality(errors, `${prefix}/item_revision`, handoff.item_revision, item?.item_revision, "handoff item revision");
        equality(errors, `${prefix}/proposal_digest`, handoff.proposal_digest, item?.proposal_digest, "handoff proposal digest");
        equality(errors, `${prefix}/gate1_decision_event_id`, handoff.gate1_decision_event_id, gate1Decision?.event_id, "handoff Gate 1 decision event");
        const expectedAdoKey = item && run ? `orchard:${run.track}:${item.item_id}:r${item.item_revision}` : undefined;
        equality(errors, `${prefix}/ado_external_key`, handoff.ado_external_key, expectedAdoKey, "handoff ADO external key");
        if (index > 0) equality(errors, `${prefix}/predecessor_handoff_digest`, handoff.predecessor_handoff_digest, handoffs[index - 1].output_digest, "handoff predecessor digest");
    }

    if (gate2Item && handoffs.length > 0) {
        equality(errors, "/gate2/items/ado_external_key", gate2Item.ado_external_key, handoffs[0].ado_external_key, "Gate 2 and handoff ADO external key");
    }

    if (publication && gate2Item) {
        equality(errors, "/publication/item_id", publication.item_id, gate2Item.item_id, "publication item_id");
        equality(errors, "/publication/item_revision", publication.item_revision, gate2Item.item_revision, "publication item revision");
        equality(errors, "/publication/artifact_digest", publication.artifact_digest, gate2Item.artifact_digest, "publication artifact digest");
        equality(errors, "/publication/proposal_digest", publication.proposal_digest, gate2Item.proposal_digest, "publication proposal digest");
        equality(errors, "/publication/displayed_diff_digest", publication.displayed_diff_digest, gate2Item.displayed_diff_digest, "publication displayed diff digest");
        equality(errors, "/publication/prepared_tree_digest", publication.prepared_tree_digest, gate2Item.prepared_tree_digest, "publication prepared tree digest");
        equality(errors, "/publication/ado_external_key", publication.ado_external_key, gate2Item.ado_external_key, "publication ADO external key");
        equality(errors, "/publication/handoff_chain_digest", publication.handoff_chain_digest, gate2Item.handoff_chain_digest, "publication handoff chain digest");
        equality(errors, "/publication/full_manifest_digest", publication.full_manifest_digest, gate2.full_manifest_digest, "publication full manifest digest");
        equality(errors, "/publication/gate2_batch_digest", publication.gate2_batch_digest, gate2.batch_digest, "publication Gate 2 batch digest");
        equality(errors, "/publication/base_commit", publication.base_commit, gate2Item.base_commit, "publication base commit");
        targetEquality(errors, "/publication/target", publication.target, gate2Item.target, "publication target");
        equality(errors, "/publication/pull_request/displayed_diff_digest", publication.pull_request?.displayed_diff_digest, publication.displayed_diff_digest, "publication pull request displayed diff digest");
        equality(errors, "/publication/pull_request/prepared_tree_digest", publication.pull_request?.prepared_tree_digest, publication.prepared_tree_digest, "publication pull request prepared tree digest");
        const expectedKey = run ? `publication:${run.track}:${publication.item_id}:r${publication.item_revision}:${publication.artifact_digest}` : undefined;
        equality(errors, "/publication/idempotency_key", publication.idempotency_key, expectedKey, "publication idempotency key");
    }

    return { valid: errors.length === 0, errors: stableErrors(errors) };
}

export function assertContractBindings(records) {
    const result = validateContractBindings(records);
    if (!result.valid) throw new ContractValidationError("cross-record-bindings", result.errors);
    return records;
}
