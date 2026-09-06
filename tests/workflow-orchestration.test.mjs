import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDocument } from "yaml";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const track1 = read("../.github/workflows/track-1-discovery.yml");
const track2 = read("../.github/workflows/track-2-corpus-inspection.yml");

function parseWorkflow(workflow, name) {
    const document = parseDocument(workflow, { prettyErrors: true, uniqueKeys: true });
    assert.deepEqual(document.errors, [], `${name} must be valid YAML`);
    const parsed = document.toJS();
    assert.equal(typeof parsed?.on?.workflow_dispatch, "object", `${name} must be manually dispatched`);
    assert.equal(typeof parsed?.jobs, "object", `${name} must define jobs`);
    return parsed;
}

test("GitHub workflows are structurally valid YAML", () => {
    const parsedTrack1 = parseWorkflow(track1, "Track 1 workflow");
    const parsedTrack2 = parseWorkflow(track2, "Track 2 workflow");
    assert.equal(parsedTrack1.permissions.contents, "read");
    assert.equal(parsedTrack2.permissions.contents, "read");
    assert.ok(Array.isArray(parsedTrack1.jobs.validate.steps));
    assert.ok(Array.isArray(parsedTrack2.jobs.validate.steps));
});

function assertReadOnlyWorkflow(workflow) {
    assert.match(workflow, /permissions:\s*\n\s+contents: read/);
    assert.doesNotMatch(workflow, /contents: write|issues: write|id-token: write/);
    assert.doesNotMatch(workflow, /git push|--apply|ado-sync|record-publication/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /uses: [^\s]+@v\d/);
}

test("Track 1 workflow only validates exact reviewed source policy in dry-run mode", () => {
    assertReadOnlyWorkflow(track1);
    assert.match(track1, /workflow_dispatch:/);
    assert.doesNotMatch(track1, /schedule:|cron:/);
    assert.match(track1, /ORCHARD_PLATFORM_COMMIT/);
    assert.match(track1, /ORCHARD_SOURCE_REGISTRY_DIGEST/);
    assert.match(track1, /--mode dry-run/);
    assert.match(track1, /--registry-digest/);
    assert.match(track1, /Production discovery is performed only by the fixed Container Apps Job runtime/);
    assert.doesNotMatch(track1, /--source-ids|--state-db|--out|--mode full|--mode subset|upload-artifact/);
});

test("Track 2 workflow only validates an immutable corpus pin in dry-run mode", () => {
    assertReadOnlyWorkflow(track2);
    assert.match(track2, /workflow_dispatch:/);
    assert.doesNotMatch(track2, /schedule:|cron:/);
    assert.match(track2, /ORCHARD_PLATFORM_COMMIT/);
    assert.match(track2, /--mode dry-run/);
    assert.match(track2, /--partition-size 50/);
    assert.match(track2, /--concurrency 4/);
    assert.match(track2, /Production inspection is performed only by the fixed Container Apps Job runtime/);
    assert.doesNotMatch(track2, /ORCHARD_INSPECTOR_|--inspection-results|--state-db|--mode full/);
});

test("unsafe legacy workflow entry points are removed", () => {
    // Removed at the 2026-08-14 merge: their jobs run as Azure Container Apps
    // jobs, not GitHub Actions.
    for (const name of [
        "orchard-engine.yml",
        "orchard-maintenance.yml",
        "orchard-decommission.yml",
    ]) {
        assert.equal(existsSync(new URL(`../.github/workflows/${name}`, import.meta.url)), false, name);
    }
    // Deliberately kept: by merge time this was no longer the unbound
    // bare-Approved approver. It is the Gate 2 approver, and it must bind
    // approval to the exact item and artifact digest.
    const humanReview = read("../.github/workflows/orchard-human-review.yml");
    assert.match(humanReview, /\/orchard gate2 approve item=<id> digest=<sha256>/);
    assert.match(humanReview, /gate2-review\.mjs/);
});

test("the curriculum request ingest is wired to run, and only reads", () => {
    const ingest = read("../.github/workflows/curriculum-request-ingest.yml");
    const document = parseDocument(ingest, { prettyErrors: true, uniqueKeys: true });
    assert.deepEqual(document.errors, [], "the curriculum request ingest must be valid YAML");
    const parsed = document.toJS();

    // The defect this closes: the script existed and no workflow called it.
    assert.match(ingest, /ingest-curriculum-requests\.mjs/);

    // A schedule AND an issue-labelled trigger, because a learner should not
    // wait for the next poll when the event is reachable.
    assert.ok(Array.isArray(parsed.on.schedule) && parsed.on.schedule[0].cron, "must run on a schedule");
    assert.deepEqual(parsed.on.issues.types, ["labeled"]);
    assert.deepEqual(parsed.on.repository_dispatch.types, ["content-request-labeled"]);
    assert.equal(typeof parsed.on.workflow_dispatch, "object");

    // Read-only, like every other GitHub Actions entry point here.
    assert.equal(parsed.permissions.contents, "read");
    assert.doesNotMatch(ingest, /contents: write|issues: write|id-token: write/);
    assert.doesNotMatch(ingest, /git push|record-publication/);
    assert.match(ingest, /persist-credentials: false/);
    assert.doesNotMatch(ingest, /uses: [^\s]+@v\d/);

    // A partial conversion must not read as a clean run.
    assert.match(ingest, /Fail the run if any request was rejected/);
});
