#!/usr/bin/env node
import { createStructuredLogger } from "./lib/structured-logger.mjs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { BlobStateAdapter } from "./lib/blob-state-adapter.mjs";
import { withFencedState } from "./lib/coordination.mjs";
import { materializeCorpusSnapshot } from "./lib/corpus-snapshot.mjs";
import { createFoundryInspectionProducer, estimateFoundryInspectionCost, produceInspectionResultFile, summarizeFoundryInspectionUsage } from "./lib/foundry-inspection-producer.mjs";
import { generateUuidV7, sha256Digest } from "./lib/identity.mjs";
import { openStateStore } from "./lib/state-store.mjs";
import { createTrack2RunRecord, enumerateCanonicalCorpus, TRACK_2_EXPECTED_CANONICAL_ITEMS } from "./lib/track-2-controller.mjs";
import { loadApprovedSourceRegistry } from "./lib/track-1-controller.mjs";
import { announceGatesForRun, readGateToken } from "./announce-gates.mjs";
import { applyGateDecisionsForRun } from "./apply-gate-decisions.mjs";
import { runTrackerSyncForRun } from "./ado-sync.mjs";

// Both entry points must export `main(argv, options)`, because that is what
// runController calls. Track 1 pointed at discover-content-opportunities.mjs,
// a LOCAL tool that exports no main and takes a completely different argument
// set, so the first production Track 1 execution died with a TypeError 13ms
// after loading it. The two are separate jobs and stay separate files: that one
// measures a local corpus for gaps, discover-approved-sources.mjs runs the
// governed survey of approved external sources.
const TRACK_ENTRY_POINTS = Object.freeze({
    "track-1": "./discover-approved-sources.mjs",
    "track-2": "./inspect-canonical-corpus.mjs",
});

// The execution roles (remediation plan T19). Before these existed, an
// approved item reached `executing` and stopped forever, because the runtime
// knew only the two survey tracks and nothing deployed could author, prepare
// Gate 2, publish, or verify anything.
//
// ARCHITECTURE DECISION, made explicitly per the plan: the two runtimes stay
// SEPARATE. The proven eight-phase PowerShell authoring engine
// (delivery/Dockerfile) is not merged into this Node image and is not
// rewritten in Node. The authoring role runs inside the engine image, which
// carries Node and these scripts as well as pwsh, and shells out to
// Invoke-Project42Delivery.ps1 for the ensemble itself. The other three roles
// run in the lean two-track image. The ONLY handoff between the runtimes is
// the shared workflow_item state store, exactly as discovery, currency, and
// seeding already share it.
const ROLE_ENTRY_POINTS = Object.freeze({
    "authoring": "./run-authoring.mjs",
    "gate2-prep": "./run-gate2-prep.mjs",
    "publication": "./run-publication.mjs",
    "verification": "./run-verification.mjs",
});

function parseRuntimeArgs(argv) {
    const separator = argv.indexOf("--");
    const runtime = separator === -1 ? argv : argv.slice(0, separator);
    const controller = separator === -1 ? [] : argv.slice(separator + 1);
    const trackIndex = runtime.indexOf("--track");
    const roleIndex = runtime.indexOf("--role");
    if (trackIndex !== -1 && roleIndex !== -1) throw new TypeError("runtime accepts --track or --role, never both");
    if (roleIndex !== -1) {
        if (!ROLE_ENTRY_POINTS[runtime[roleIndex + 1]]) throw new TypeError("runtime requires --role authoring, gate2-prep, publication, or verification");
        if (runtime.length !== 2 || roleIndex !== 0) throw new TypeError("runtime accepts only --role before the -- separator");
        return { role: runtime[roleIndex + 1], controller };
    }
    if (trackIndex === -1 || !TRACK_ENTRY_POINTS[runtime[trackIndex + 1]]) throw new TypeError("runtime requires --track track-1 or --track track-2, or --role for an execution role");
    if (runtime.length !== 2 || trackIndex !== 0) throw new TypeError("runtime accepts only --track before the -- separator");
    return { track: runtime[trackIndex + 1], controller };
}

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function integer(name, fallback) {
    const raw = process.env[name] ?? `${fallback}`;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a canonical positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

function positiveNumber(name) {
    const raw = required(name);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error(`${name} must use canonical decimal syntax`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    return value;
}

export function verifyInspectionPolicy(policy, expectedDigest) {
    if (typeof policy !== "string" || policy.length < 1) throw new TypeError("inspection policy is required");
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest) || sha256Digest(policy) !== expectedDigest) throw new Error("inspection policy digest mismatch");
    return policy;
}

function blobClients() {
    const credential = new ManagedIdentityCredential(required("AZURE_CLIENT_ID"));
    const primary = new BlobServiceClient(required("ORCHARD_STATE_ACCOUNT_URL"), credential);
    const backup = new BlobServiceClient(required("ORCHARD_BACKUP_ACCOUNT_URL"), credential);
    return {
        artifacts: primary.getContainerClient(required("ORCHARD_ARTIFACT_CONTAINER")),
        state: primary.getContainerClient(required("ORCHARD_STATE_CONTAINER")),
        backup: backup.getContainerClient(required("ORCHARD_BACKUP_CONTAINER")),
    };
}

export async function downloadBoundArtifact(container, blobName, expectedDigest, destination, maxBytes) {
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error(`invalid digest for ${blobName}`);
    const properties = await container.getBlobClient(blobName).getProperties();
    if (!Number.isSafeInteger(properties.contentLength) || properties.contentLength < 1 || properties.contentLength > maxBytes) throw new Error(`artifact exceeds configured size bound: ${blobName}`);
    const payload = await container.getBlobClient(blobName).downloadToBuffer();
    if (payload.byteLength !== properties.contentLength) throw new Error(`artifact length changed during download: ${blobName}`);
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    if (digest !== expectedDigest) throw new Error(`artifact digest mismatch: ${blobName}`);
    writeFileSync(destination, payload, { mode: 0o400 });
    return destination;
}

export async function runController(track, args, log) {
    log("info", "controller.loading");
    const module = await import(TRACK_ENTRY_POINTS[track] ?? ROLE_ENTRY_POINTS[track]);
    log("info", "controller.loaded");
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let controllerExitCode;
    try {
        log("info", "controller.executing");
        await module.main(args, { log });
        controllerExitCode = process.exitCode;
    } finally {
        process.exitCode = previousExitCode;
    }
    if (controllerExitCode) throw new Error(`controller set exit code ${controllerExitCode}`);
    log("info", "controller.completed");
}

async function runAzure(track, log) {
    const clients = blobClients();
    const root = process.env.ORCHARD_STATE_ROOT ?? "/var/lib/orchard";
    mkdirSync(root, { recursive: true });
    const adapter = new BlobStateAdapter({ containerClient: clients.state, backupContainerClient: clients.backup, workRoot: root });
    return withFencedState(adapter, { scope: track, owner: `${process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "local"}:${process.pid}` }, async ({ state, assertCurrent }) => {
        const execution = process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "local-execution";

        // Read the answer to the LAST run before doing anything in this one.
        //
        // The order is the point. What the owner decided is what says whether
        // held work may proceed, so it has to be applied before the controller
        // spends a request or a dollar. It runs inside the fence, as the single
        // writer, because the state database is behind a private endpoint and
        // nothing outside the subnet can reach it to apply a decision itself.
        //
        // It cannot fail a run: no anchor, no token, GitHub down all log and
        // return, and the work stays exactly where it was.
        const gateToken = await readGateToken({ log });
        const decisionStore = openStateStore(state.path);
        try {
            await applyGateDecisionsForRun({ store: decisionStore, track, log, token: gateToken });
        } finally {
            decisionStore.close();
        }

        // The tracker follows the decisions immediately: an approval the
        // block above just recorded is what creates the Azure DevOps work
        // item, and every already-linked item is moved to the state its
        // lifecycle is in now. Inside the fence, as the single writer, and
        // it cannot fail the run: the job's managed identity is a registered
        // ADO service principal user, and any ADO or GitHub fault logs and
        // leaves the board to catch up on the next run.
        await runTrackerSyncForRun({ stateDbPath: state.path, log, githubToken: gateToken });

        const common = ["--mode", required("ORCHARD_RUN_MODE"), "--state-db", state.path, "--implementation-commit", required("ORCHARD_IMPLEMENTATION_COMMIT"), "--trigger-type", required("ORCHARD_TRIGGER_TYPE"), "--trigger-reference", process.env.ORCHARD_TRIGGER_REFERENCE ?? execution, "--actor-kind", required("ORCHARD_ACTOR_KIND"), "--actor-reference", process.env.ORCHARD_ACTOR_REFERENCE ?? execution, "--out", join(root, `${track}-controller-output.json`)];
        if (track === "track-1") {
            const registry = await downloadBoundArtifact(clients.artifacts, required("ORCHARD_SOURCE_REGISTRY_BLOB"), required("ORCHARD_SOURCE_REGISTRY_DIGEST"), join(root, "source-registry.json"), integer("ORCHARD_MAX_SOURCE_REGISTRY_BYTES", 4_194_304));
            loadApprovedSourceRegistry(JSON.parse(readFileSync(registry, "utf8")), { allowLegacyMetadata: false, requirePolicyReview: true, expectedDigest: required("ORCHARD_SOURCE_REGISTRY_CANONICAL_DIGEST") });
            // Probes ship in the image rather than the artifacts container:
            // they say what to measure, not what is approved to be fetched, so
            // they are not a governed input and do not need a bound digest.
            // Absent, the controller surveys and records but proposes nothing,
            // and says so rather than reporting zero candidates in silence.
            const probes = process.env.ORCHARD_PROBES_PATH && existsSync(process.env.ORCHARD_PROBES_PATH)
                ? ["--probes", process.env.ORCHARD_PROBES_PATH]
                : [];
            await runController(track, ["--track", track, ...common, "--source-registry", registry, "--registry-digest", required("ORCHARD_SOURCE_REGISTRY_CANONICAL_DIGEST"), "--content-commit", required("ORCHARD_CONTENT_COMMIT"), "--max-sources", process.env.ORCHARD_MAX_SOURCES ?? "100", "--max-failures", process.env.ORCHARD_MAX_FAILURES ?? "5", ...probes], log);
        } else {
            const commit = required("ORCHARD_CONTENT_COMMIT");
            const platformRoot = await materializeCorpusSnapshot({ containerClient: clients.artifacts, archiveBlob: required("ORCHARD_CORPUS_ARCHIVE_BLOB"), manifestBlob: required("ORCHARD_CORPUS_MANIFEST_BLOB"), expectedCommit: commit, destination: join(root, "platform"), maxArchiveBytes: integer("ORCHARD_MAX_CORPUS_ARCHIVE_BYTES", 268_435_456) });
            const items = enumerateCanonicalCorpus(platformRoot, commit);
            if (items.length !== TRACK_2_EXPECTED_CANONICAL_ITEMS) throw new Error(`production Track 2 requires exactly ${TRACK_2_EXPECTED_CANONICAL_ITEMS} canonical items; enumerated ${items.length}`);
            const runId = generateUuidV7();
            const startedAt = new Date().toISOString();
            const concurrency = integer("ORCHARD_INSPECTION_CONCURRENCY", 4);
            const runOptions = {
                mode: required("ORCHARD_RUN_MODE"), partitionSize: 50, concurrency, subsetIds: [], runId,
                contentCommit: commit, implementationCommit: required("ORCHARD_IMPLEMENTATION_COMMIT"),
                triggerType: required("ORCHARD_TRIGGER_TYPE"), triggerReference: process.env.ORCHARD_TRIGGER_REFERENCE ?? execution,
                actorKind: required("ORCHARD_ACTOR_KIND"), actorReference: process.env.ORCHARD_ACTOR_REFERENCE ?? execution,
            };
            const preflightStore = openStateStore(state.path);
            try {
                log("info", "track2.state.preflight-recording");
                const coverage = { expected: items.length, enumerated: items.length, inspected: 0, gaps: items.length };
                await preflightStore.recordRun(createTrack2RunRecord(runOptions, coverage, "running", startedAt, null), {
                    onStage: (stage, details) => log("info", `track2.state.preflight.${stage}`, details),
                });
                log("info", "track2.state.preflight-recorded");
            } finally {
                preflightStore.close();
            }
            const policy = verifyInspectionPolicy(required("ORCHARD_INSPECTION_POLICY"), required("ORCHARD_INSPECTION_POLICY_DIGEST"));
            const maxOutputTokens = integer("ORCHARD_MAX_OUTPUT_TOKENS", 1200);
            const maxInputBytes = integer("ORCHARD_MAX_INSPECTION_INPUT_BYTES", 200_000);
            const maxRequests = integer("ORCHARD_MAX_FOUNDRY_REQUESTS", 1000);
            const inputRate = positiveNumber("ORCHARD_FOUNDRY_INPUT_USD_PER_MILLION_TOKENS");
            const outputRate = positiveNumber("ORCHARD_FOUNDRY_OUTPUT_USD_PER_MILLION_TOKENS");
            const requestOverheadTokens = integer("ORCHARD_FOUNDRY_REQUEST_OVERHEAD_TOKENS", 4000);
            const estimate = estimateFoundryInspectionCost({ items, platformRoot, policy, maxInputBytes, maxOutputTokens, maxRequests, requestOverheadTokens, inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate });
            const spendCap = positiveNumber("ORCHARD_MAX_FOUNDRY_SPEND_USD");
            if (estimate.estimatedUsd > spendCap) throw new Error(`Foundry pessimistic cost estimate ${estimate.estimatedUsd.toFixed(4)} exceeds run cap ${spendCap.toFixed(4)}`);
            log("info", "foundry.budget.accepted", { requestCount: estimate.requestCount, inputTokenUpperBound: estimate.inputTokenUpperBound, outputTokenUpperBound: estimate.outputTokenUpperBound, estimatedUsd: Number(estimate.estimatedUsd.toFixed(6)), spendCapUsd: spendCap });
            const producer = createFoundryInspectionProducer({ endpoint: required("ORCHARD_FOUNDRY_ENDPOINT"), deployment: required("ORCHARD_FOUNDRY_DEPLOYMENT"), managedIdentityClientId: required("AZURE_CLIENT_ID"), policy, maxInputBytes, maxOutputTokens, maxRequests, maxTotalInputTokens: estimate.inputTokenUpperBound, maxTotalOutputTokens: estimate.outputTokenUpperBound, maxSpendUsd: spendCap, requestOverheadTokens, inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate });
            const results = join(root, "inspection-results.json");
            const inspectionResults = await produceInspectionResultFile({
                items,
                platformRoot,
                producer,
                outputPath: results,
                concurrency,
                onProgress: ({ completed, total }) => log("info", "foundry.inspection.progress", { completed, total }),
            });
            const usage = summarizeFoundryInspectionUsage(inspectionResults, inputRate, outputRate);
            log("info", "foundry.usage.completed", {
                requestCount: usage.requestCount,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                actualUsd: Number(usage.actualUsd.toFixed(6)),
            });
            await runController(track, ["--track", track, ...common, "--platform-root", platformRoot, "--content-commit", commit, "--inspection-results", results, "--run-id", runId, "--started-at", startedAt, "--partition-size", "50", "--concurrency", String(concurrency)], log);
        }
        await assertCurrent();
        // Tell someone. Both gates hold work by state machine, which is
        // correct and was also completely silent: finding out that a run had
        // stopped meant running a review script by hand. Each track announces
        // its own two gates here, so all four are covered.
        //
        // After assertCurrent, so nothing is announced from a run that lost
        // its lease, and inside the fence so the state file is still the one
        // this run wrote. It cannot throw: a run that did its work must not be
        // failed by a GitHub outage.
        await announceGatesForRun({ stateDbPath: state.path, track, runId: execution, log, token: gateToken });
        return { statePath: state.path, value: { track } };
    });
}

// One execution role, run under the SAME fence and scope as the track whose
// state it works on. The scope is the point: the fence lease is what makes the
// state database single-writer, and a role job holding a lease named anything
// other than the track would run concurrently with that track's own job
// against one database. ORCHARD_ROLE_TRACK names the track whose items this
// role executes; it defaults to track-1, the discovery pipeline the end-to-end
// criterion is written against.
async function runRoleAzure(role, log) {
    const clients = blobClients();
    const root = process.env.ORCHARD_STATE_ROOT ?? "/var/lib/orchard";
    mkdirSync(root, { recursive: true });
    const track = process.env.ORCHARD_ROLE_TRACK ?? "track-1";
    if (!TRACK_ENTRY_POINTS[track]) throw new Error("ORCHARD_ROLE_TRACK must be track-1 or track-2");
    const adapter = new BlobStateAdapter({ containerClient: clients.state, backupContainerClient: clients.backup, workRoot: root });
    return withFencedState(adapter, { scope: track, owner: `${process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "local"}:${process.pid}` }, async ({ state, assertCurrent }) => {
        const execution = process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "local-execution";
        // Decisions first, exactly as the tracks do: what the owner answered
        // since the last run is what authorizes this run to do anything. For
        // the publication role this is load-bearing, not a courtesy: the Gate 2
        // approval it publishes from is recorded here, by this run, moments
        // before it is read back.
        const gateToken = await readGateToken({ log });
        const decisionStore = openStateStore(state.path);
        try {
            await applyGateDecisionsForRun({ store: decisionStore, track, log, token: gateToken });
        } finally {
            decisionStore.close();
        }
        await runTrackerSyncForRun({ stateDbPath: state.path, log, githubToken: gateToken });
        await runController(role, ["--state-db", state.path, "--track", track], log);
        // The role just moved lifecycle states, so the tracker follows now
        // rather than at the next monthly survey. Never fails the run.
        await runTrackerSyncForRun({ stateDbPath: state.path, log, githubToken: gateToken });
        await assertCurrent();
        // gate2-prep moves work to gate2-pending; announcing here is what
        // turns that into an issue the owner hears about. For the other roles
        // this reports the gates empty or unchanged, which is cheap and true.
        await announceGatesForRun({ stateDbPath: state.path, track, runId: execution, log, token: gateToken });
        return { statePath: state.path, value: { role, track } };
    });
}

export async function main(argv = process.argv.slice(2)) {
    const { track, role, controller } = parseRuntimeArgs(argv);
    const log = createStructuredLogger({ base: { service: "orchard", ...(role ? { role } : {}), ...(track ? { track } : {}) } });
    log("info", "runtime.started", { argumentCount: controller.length });
    try {
        if (process.env.ORCHARD_RUNTIME_CONFIG === "azure") await (role ? runRoleAzure(role, log) : runAzure(track, log));
        else await runController(role ?? track, controller, log);
        log("info", "runtime.completed");
    } catch (error) {
        process.exitCode = process.exitCode || 1;
        const safeErrorCodes = new Set([
            "ERR_ORCHARD_AUTHORING_SPEND_CAP",
            "ERR_ORCHARD_DELIVERY_FAILED",
            "ERR_ORCHARD_ROLE_FAILED",
            "ERR_ORCHARD_VERIFICATION_FAILED",
            "ERR_ORCHARD_CONFIGURATION",
            "ERR_FOUNDRY_AUTHORIZATION",
            "ERR_FOUNDRY_INCOMPLETE",
            "ERR_FOUNDRY_INPUT_CAP",
            "ERR_FOUNDRY_INPUT_RESERVATION_CAP",
            "ERR_FOUNDRY_OUTPUT_CAP",
            "ERR_FOUNDRY_OUTPUT_RESERVATION_CAP",
            "ERR_FOUNDRY_PRODUCER_FAILED",
            "ERR_FOUNDRY_RATE_LIMITED",
            "ERR_FOUNDRY_REQUEST_CAP",
            "ERR_FOUNDRY_REQUEST_FAILED",
            "ERR_FOUNDRY_REQUEST_REJECTED",
            "ERR_FOUNDRY_RESULT_INVALID",
            "ERR_FOUNDRY_SERVICE_UNAVAILABLE",
            "ERR_FOUNDRY_SPEND_CAP",
            "ERR_FOUNDRY_SPEND_RESERVATION_CAP",
            "ERR_FOUNDRY_USAGE_INVALID",
            "ERR_ORCHARD_CONTROLLER_FAILED",
            "ERR_ORCHARD_RESULTS_INVALID",
            "ERR_ORCHARD_STATE_OPEN_FAILED",
        ]);
        const errorCode = safeErrorCodes.has(error?.code) ? error.code : "ERR_ORCHARD_RUNTIME_FAILED";
        log("error", "runtime.failed", { error: { code: errorCode, name: error instanceof TypeError ? "TypeError" : "Error", message: String(error?.message ?? error) } });
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
