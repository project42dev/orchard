// A REAL FINDING WITH NO PUBLISHABLE ARTIFACT REACHES A HUMAN, AND NEVER A GATE.
//
// The defect these tests pin, measured against the pinned corpus on 2026-09-12:
// enumerateCanonicalCorpus produces 212 canonical items from the platform
// checkout and 29 of them are declared in a catalogue rather than published as
// a file of their own -- `catalogue:content`, `catalogue:guide-diagrams`, all 14
// `learning-path:*`, and every catalog `modules[]`/`resources[]` entry with no
// backing file. Their sourcePath IS the catalogue, contentRepositoryPathFor maps
// it to `catalog.json` or `diagrams/catalogue.json`, and lib/registration.mjs
// publishes to neither. Track 2 proposed them at Gate 1 anyway; a human approved
// them; authoring spent; and they stopped dead at the registration hold with no
// way out of the backlog.
//
// Two halves are proved here, and BOTH have to hold or the fix is a regression
// of its own:
//
//   1. such a finding is not proposed  (nothing is spent, nothing is stranded)
//   2. such a finding is not LOST      (the owner is told, in the run summary)
//
// Half 2 is the one that is easy to lose quietly, so most of this file is about
// it: the entry survives the controller, survives persistDiscoveryItems
// replacing the findings object, survives drift, and is rendered with enough to
// act on -- which item, what the inspection concluded, on what evidence, and
// which registration code refused the target.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openStateStore } from "../scripts/lib/state-store.mjs";
import { persistDiscoveryItems } from "../scripts/lib/gate-queue.mjs";
import { sha256Digest } from "../scripts/lib/identity.mjs";
import {
    publishableTargetRefusal,
    reportUnpublishableTargets,
    UnpublishableTargetError,
    UNPUBLISHABLE_TARGET_CODE,
} from "../scripts/lib/publishable-target.mjs";
import {
    currencyCandidateFor,
    currencyFindingCandidates,
    createTrack2RunRecord,
    runTrack2,
} from "../scripts/lib/track-2-controller.mjs";
import { renderRunSummary, runSummaryTitle, runVerdict, verdictBanner } from "../scripts/lib/run-summary.mjs";

const COMMIT = "3".repeat(40);
const verifyCommit = (_root, commit) => {
    if (commit !== COMMIT) throw new Error("pin mismatch");
    return commit;
};

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

/**
 * The corpus shape that produces the defect: a catalogue that declares a
 * learning path and a module with no file behind it, alongside content that IS
 * file-backed. Laid out exactly as the platform repository is, with modules
 * nested under the path that lists them.
 */
function platformFixture(t) {
    const root = mkdtempSync(join(tmpdir(), "orchard-unroutable-"));
    for (const directory of ["content/modules/path-a", "content/resources", "content/diagrams"]) {
        mkdirSync(join(root, directory), { recursive: true });
    }
    writeJson(join(root, "content/catalog.json"), {
        schemaVersion: "1.0.0",
        contentVersion: "test",
        paths: [{ id: "path-a", title: "A", description: "a description that can go stale" }],
        modules: [{ id: "module-a", title: "Module" }, { id: "ghost-module", title: "Declared, never written" }],
        resources: [{ id: "resource-a", title: "Resource" }],
    });
    writeJson(join(root, "content/modules/path-a/module-a.json"), { id: "module-a", body: "canonical module" });
    writeJson(join(root, "content/resources/resource-a.json"), { id: "resource-a", body: "canonical resource" });
    writeJson(join(root, "content/diagrams/catalogue.json"), {
        $schemaVersion: "1.0.0", renderer: "mermaid", diagrams: [{ id: "diagram-a", source: "diagram-a.mmd" }],
    });
    writeFileSync(join(root, "content/diagrams/diagram-a.mmd"), "graph TD; A-->B;\n", "utf8");
    t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* the OS will collect it */ } });
    return root;
}

function stateEstate(t) {
    const directory = mkdtempSync(join(tmpdir(), "orchard-unroutable-state-"));
    const store = openStateStore(join(directory, "state.db"));
    t.after(() => {
        store.close();
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* the OS will collect it */ }
    });
    return store;
}

// Every item in this fixture that CAN be a finding, is one. The split between
// the three that reach the gate and the four that cannot is then entirely a
// property of the target, which is the thing under test.
const EVERYTHING_IS_STALE = async (item) => ({
    classification: "update",
    evidence: [`digest:${item.digest}`, `source:${item.sourcePath}`],
});

function options(root, store, extra = {}) {
    return {
        mode: "full", platformRoot: root, contentCommit: COMMIT, commitVerifier: verifyCommit,
        expectedCanonicalItems: 7, inspector: EVERYTHING_IS_STALE, stateStore: store, ...extra,
    };
}

const item = (stableId, sourcePath, surface = "learning") => ({
    stableId, canonicalId: stableId.split(":")[1], surface, sourcePath,
    sourceDigest: `sha256:${"a".repeat(64)}`, digest: `sha256:${"b".repeat(64)}`,
});

// ---------------------------------------------------------------------------
// Half 1: the finding is never proposed.
// ---------------------------------------------------------------------------

test("the three registration checks decide publishability, and they agree with what run-authoring would do", () => {
    assert.equal(publishableTargetRefusal("modules/path-a/module-a.json"), null);
    assert.equal(publishableTargetRefusal("resources/resource-a.json"), null);
    assert.equal(publishableTargetRefusal("diagrams/diagram-a.mmd"), null);

    assert.equal(publishableTargetRefusal("catalog.json").code, "registration.unrecognized-target",
        "the catalogue itself is not a surface anything publishes to");
    assert.equal(publishableTargetRefusal("diagrams/catalogue.json").code, "registration.unrecognized-diagram-path",
        "the diagram catalogue is a registry, not a diagram");
    assert.equal(publishableTargetRefusal("modules/module-a.json").code, "registration.unrecognized-module-path",
        "a module outside a learning path directory has no URL, so it is not publishable either");
});

test("a currency candidate for an item with no publishable artifact is refused where the target is decided", () => {
    for (const [stableId, sourcePath, expectedCode] of [
        ["catalogue:content", "content/catalog.json", "registration.unrecognized-target"],
        ["learning-path:path-a", "content/catalog.json", "registration.unrecognized-target"],
        ["catalogue:guide-diagrams", "content/diagrams/catalogue.json", "registration.unrecognized-diagram-path"],
    ]) {
        let error = null;
        try {
            currencyCandidateFor(item(stableId, sourcePath), { classification: "update", evidence: ["e:1"] }, "2026-09-12T00:00:00.000Z");
        } catch (thrown) {
            error = thrown;
        }
        assert.ok(error instanceof UnpublishableTargetError, `${stableId} must be refused where its target is decided`);
        assert.equal(error.code, UNPUBLISHABLE_TARGET_CODE);
        assert.equal(error.registrationCode, expectedCode,
            "the refusal carries registration's own code, because that is the fact a human needs");
    }
    // The control: the same builder, the same classification, a file-backed item.
    assert.equal(
        currencyCandidateFor(item("learning-module:module-a", "content/modules/path-a/module-a.json"), { classification: "update", evidence: ["e:1"] }, "2026-09-12T00:00:00.000Z").targetPath,
        "modules/path-a/module-a.json",
    );
});

test("only an unpublishable target is caught; any other builder failure still fails loudly", () => {
    // The control: a well-formed item goes through, so the assertion below is
    // about the failure and not about the harness.
    const healthy = currencyFindingCandidates(
        [item("guide:resource-a", "content/resources/resource-a.json", "guide")],
        [{ stableId: "guide:resource-a", classification: "update", evidence: ["e:1"] }],
        "2026-09-12T00:00:00.000Z",
    );
    assert.equal(healthy.candidates.length, 1);
    assert.equal(healthy.unroutable.length, 0);

    // A source path outside the corpus root throws a TypeError from
    // contentRepositoryPathFor, not an UnpublishableTargetError. It means the
    // corpus layout has moved, which is refused outright rather than guessed
    // at. If currencyFindingCandidates caught by shape instead of by code, a
    // broken enumeration would present as a quietly empty gate -- the exact
    // failure mode this subsystem exists to end -- so it must propagate.
    const moved = { stableId: "guide:boom", canonicalId: "boom", surface: "guide", sourcePath: "elsewhere/x.json", sourceDigest: "", digest: "" };
    assert.throws(
        () => currencyFindingCandidates([moved], [{ stableId: "guide:boom", classification: "update", evidence: ["e:1"] }], "2026-09-12T00:00:00.000Z"),
        /must sit under content\//,
        "a corpus layout that moved is refused outright, never filed away as an unroutable finding",
    );
});

test("a run holds the publishable findings and carries the rest out as unroutable", async (t) => {
    const root = platformFixture(t);
    const store = stateEstate(t);
    const stages = [];
    const result = await runTrack2(options(root, store, { onStage: (event, fields) => stages.push([event, fields]) }));

    assert.equal(result.findings.persisted, 3, "module, resource and diagram each have a file to publish");
    assert.deepEqual(
        result.findings.items.map((entry) => entry.target.path).sort(),
        ["diagrams/diagram-a.mmd", "modules/path-a/module-a.json", "resources/resource-a.json"],
    );
    assert.deepEqual(
        result.findings.unroutable.map((entry) => entry.stableId).sort(),
        ["catalogue:content", "catalogue:guide-diagrams", "learning-module:ghost-module", "learning-path:path-a"],
        "the catalogue, the diagram catalogue, the learning path and the catalog entry with no file all have nowhere to publish",
    );
    // The findings object is REPLACED by persistDiscoveryItems on any run that
    // has candidates, which is every run that matters. Asserted on a run that
    // persisted three, not on an empty one.
    assert.ok(result.findings.persisted > 0 && result.findings.unroutable.length > 0);

    const entry = result.findings.unroutable.find((candidate) => candidate.stableId === "learning-path:path-a");
    assert.equal(entry.classification, "update");
    assert.equal(entry.targetPath, "catalog.json");
    assert.equal(entry.code, "registration.unrecognized-target");
    assert.ok(entry.evidence.length > 0, "the evidence the inspection gave is carried with the finding, not dropped with it");
    assert.equal(entry.sourcePath, "content/catalog.json");

    const announced = stages.find(([event]) => event === "track2.findings.unroutable");
    assert.ok(announced, "the run log says it, on the run, whatever the summary later does with it");
    assert.equal(announced[1].count, 4);

    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_item").get().n, 3,
        "nothing unpublishable is written into the lifecycle, so nothing new can strand");
    assert.ok(store.verify().ok);
});

test("a drifted run still reports what has no publishable artifact, because that is not a fact about the bytes", async (t) => {
    const root = platformFixture(t);
    const store = stateEstate(t);
    let drifted = false;
    const result = await runTrack2(options(root, store, {
        inspector: async (canonical) => {
            if (!drifted) {
                drifted = true;
                writeFileSync(join(root, "content/diagrams/diagram-a.mmd"), "graph TD; A-->C;\n", "utf8");
            }
            return EVERYTHING_IS_STALE(canonical);
        },
    }));
    assert.equal(result.drift, true);
    assert.equal(result.findings.persisted, 0, "a proposal from a corpus that moved is still not held");
    assert.equal(result.findings.unroutable.length, 4,
        "but a finding whose target has no surface is unpublishable whatever the bytes did, and a month of silence is not the right answer");
});

// ---------------------------------------------------------------------------
// Half 2: the finding reaches a human.
// ---------------------------------------------------------------------------

const OUTPUT = Object.freeze({
    status: "completed",
    coverage: { expected: 8, inspected: 8 },
    outcomes: [{ stableId: "learning-path:path-a", classification: "update" }],
    findings: {
        persisted: 3,
        unroutable: [{
            stableId: "learning-path:path-a",
            classification: "update",
            sourcePath: "content/catalog.json",
            targetPath: "catalog.json",
            code: "registration.unrecognized-target",
            reason: "no surface publishes to catalog.json",
            evidence: ["the description names a model retired in March"],
        }],
    },
});

test("the Track 2 verdict carries the unroutable findings, and they are not counted as silent", () => {
    const verdict = runVerdict({ track: "track-2", output: OUTPUT });
    assert.equal(verdict.unroutable.length, 1);
    assert.equal(verdict.silent.length, 0, "the inspection ANSWERED; it is the publication path that has nowhere to put the answer");
    assert.deepEqual(runVerdict({ track: "track-1", output: { candidates: [] } }).unroutable, [],
        "both tracks render from one shape");
});

test("the run summary names each unroutable finding with everything needed to act on it", () => {
    const verdict = runVerdict({ track: "track-2", output: OUTPUT });
    const body = renderRunSummary({
        track: "track-2", runId: "r1", executionName: "e1", verdict, announced: [], now: "2026-09-12T00:00:00.000Z",
    });
    assert.match(body, /Findings with no publishable artifact \(1\)/);
    assert.match(body, /learning-path:path-a/);
    assert.match(body, /\*\*update\*\*/);
    assert.match(body, /catalog\.json/);
    assert.match(body, /registration\.unrecognized-target/);
    assert.match(body, /the description names a model retired in March/,
        "the evidence is in the issue, because a classification with no evidence is not actionable");
    assert.match(body, /editing the registry in `project42dev\/project42-content` by hand/,
        "the reader is told what the next move is, not only that there is a problem");
    assert.doesNotMatch(body, /Silent published items \(1\)/);
});

test("the banner and the title say it, because no gate is holding this work", () => {
    const verdict = runVerdict({ track: "track-2", output: OUTPUT });
    assert.match(verdictBanner({ verdict, controllerError: null }), /1 currency finding has no publishable artifact/);

    // The zero-delta title. "0 new opportunities" on its own is a lie about a
    // run that found something a human has to act on.
    const quiet = runSummaryTitle({ track: "track-2", verdict, announced: [], controllerError: null });
    assert.match(quiet, /1 finding with no publishable artifact/);

    // And the title of a run that DID hold something, where the held count
    // would otherwise be the whole story.
    const busy = runSummaryTitle({
        track: "track-2", verdict, announced: [{ gate: "gate-1", action: "created", count: 3 }], controllerError: null,
    });
    assert.match(busy, /3 items held for your decision/);
    assert.match(busy, /1 finding with no publishable artifact/);

    const clean = runVerdict({ track: "track-2", output: { ...OUTPUT, findings: { persisted: 3, unroutable: [] } } });
    assert.equal(verdictBanner({ verdict: clean, controllerError: null }), null, "a clean run says nothing about this at all");
    assert.doesNotMatch(runSummaryTitle({ track: "track-2", verdict: clean, announced: [], controllerError: null }), /publishable artifact/);
});

// ---------------------------------------------------------------------------
// The backlog that already exists. Not migrated, not closed: named.
// ---------------------------------------------------------------------------

/** An item held at Gate 1 against a target no surface publishes to, exactly as the 29 got there. */
async function holdUnpublishableItem(store, runId, targetPath, subject) {
    const semanticIdentity = `sid:v1:${sha256Digest(subject).slice(7)}`;
    return persistDiscoveryItems({
        store, runId, track: "track-2", now: "2026-09-12T00:00:00.000Z",
        candidates: [{
            subject, surface: "learning", outcome: "currency-finding", scope: "content",
            proposalKind: "track-2-currency-proposal", category: "update",
            title: `update: ${subject}`, term: subject, level: null,
            targetPath, evidence: ["e:1"],
            evidenceRefs: [{ reference: subject, digest: sha256Digest(subject) }],
            rationale: "recorded before the emitter refused it", observedAt: "2026-09-12T00:00:00.000Z",
            semanticIdentity,
        }],
    });
}

test("every live item already recorded against an unpublishable target is named on every run", async (t) => {
    const store = stateEstate(t);
    const runId = "01930000-0000-7000-8000-000000000001";
    await store.recordRun(createTrack2RunRecord(
        { runId, mode: "full", partitionSize: 50, concurrency: 4, contentCommit: "0".repeat(40) },
        { expected: 2, enumerated: 2, inspected: 2, gaps: 0 },
        "running", "2026-09-12T00:00:00.000Z", null,
    ));
    const stranded = await holdUnpublishableItem(store, runId, "catalog.json", "learning-path:path-a");
    const healthy = await holdUnpublishableItem(store, runId, "modules/path-a/module-a.json", "learning-module:module-a");
    assert.equal(stranded.persisted, 1);
    assert.equal(healthy.persisted, 1);

    const logged = [];
    const summary = reportUnpublishableTargets({ store, log: (level, event, fields) => logged.push([level, event, fields]) });
    assert.equal(summary.scanned, 2, "every live item is looked at, whatever its target");
    assert.equal(summary.unpublishable.length, 1, "only the one that can never publish is named");

    const [entry] = summary.unpublishable;
    assert.equal(entry.item, stranded.items[0].item_id);
    assert.equal(entry.path, "catalog.json");
    assert.equal(entry.state, "gate1-pending");
    assert.equal(entry.code, "registration.unrecognized-target");
    assert.match(entry.action, /deny it at Gate 1/, "a Gate 1 item is closable by the owner today, and the report says so");

    assert.ok(logged.some(([level, event]) => level === "warn" && event.endsWith(".held")),
        "it is a warning, every run, until a human acts");
    assert.ok(logged.some(([level, event]) => level === "warn" && event.endsWith(".summary")));
});

test("a closed item is history, not backlog, and is not named", async (t) => {
    const store = stateEstate(t);
    const runId = "01930000-0000-7000-8000-000000000002";
    await store.recordRun(createTrack2RunRecord(
        { runId, mode: "full", partitionSize: 50, concurrency: 4, contentCommit: "0".repeat(40) },
        { expected: 1, enumerated: 1, inspected: 1, gaps: 0 },
        "running", "2026-09-12T00:00:00.000Z", null,
    ));
    const held = await holdUnpublishableItem(store, runId, "catalog.json", "catalogue:content");
    assert.equal(reportUnpublishableTargets({ store }).unpublishable.length, 1);

    store.db.prepare("UPDATE workflow_item SET current_state = 'closed' WHERE item_id = ?").run(held.items[0].item_id);
    const after = reportUnpublishableTargets({ store });
    assert.equal(after.unpublishable.length, 0, "where a closed item once pointed is a fact about the past");
    assert.equal(after.scanned, 0);
});
