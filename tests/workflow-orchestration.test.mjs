import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const track1 = read("../.github/workflows/track-1-discovery.yml");
const track2 = read("../.github/workflows/track-2-corpus-inspection.yml");

function assertReadOnlyWorkflow(workflow) {
    assert.match(workflow, /permissions:\s*\n\s+contents: read/);
    assert.doesNotMatch(workflow, /contents: write|issues: write|id-token: write/);
    assert.doesNotMatch(workflow, /git push|--apply|ado-sync|record-publication/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /uses: [^\s]+@v\d/);
}

test("Track 1 weekly orchestration is full, pinned, bounded, and read only", () => {
    assertReadOnlyWorkflow(track1);
    assert.match(track1, /cron: "0 6 \* \* 1"/);
    assert.match(track1, /if \(\$scheduled\) \{ 'full' \}/);
    assert.match(track1, /ORCHARD_PLATFORM_COMMIT/);
    assert.match(track1, /ORCHARD_SOURCE_REGISTRY_DIGEST/);
    assert.match(track1, /overrides are allowed only for dry-run mode/);
    assert.match(track1, /if \(\$mode -eq 'dry-run' -and \$env:REQUESTED_PLATFORM_COMMIT\)/);
    assert.match(track1, /if \(\$mode -eq 'dry-run' -and \$env:REQUESTED_REGISTRY_DIGEST\)/);
    assert.match(track1, /--registry-digest/);
    assert.match(track1, /--trigger-type/);
    assert.match(track1, /--actor-kind/);
    assert.match(track1, /--state-db/);
    assert.match(track1, /steps\.config\.outputs\.mode != 'dry-run'/);
});

test("Track 2 weekly orchestration pins all executable inputs and requires complete inspection settings", () => {
    assertReadOnlyWorkflow(track2);
    assert.match(track2, /cron: "0 12 \* \* 1"/);
    assert.match(track2, /if \(\$scheduled\) \{ 'full' \}/);
    assert.match(track2, /ORCHARD_PLATFORM_COMMIT/);
    assert.match(track2, /platform_commit override is allowed only for dry-run mode/);
    assert.match(track2, /if \(\$mode -eq 'dry-run' -and \$env:REQUESTED_PLATFORM_COMMIT\)/);
    assert.match(track2, /ORCHARD_INSPECTOR_REPOSITORY/);
    assert.match(track2, /ORCHARD_INSPECTOR_COMMIT/);
    assert.match(track2, /ORCHARD_INSPECTOR_MODULE/);
    assert.match(track2, /--partition-size', '50'/);
    assert.match(track2, /--concurrency', '4'/);
    assert.match(track2, /--state-db/);
    assert.match(track2, /steps\.config\.outputs\.mode != 'dry-run'/);
});

test("unsafe legacy workflow entry points are removed", () => {
    for (const name of [
        "orchard-engine.yml",
        "orchard-maintenance.yml",
        "orchard-human-review.yml",
        "orchard-decommission.yml",
    ]) {
        assert.equal(existsSync(new URL(`../.github/workflows/${name}`, import.meta.url)), false, name);
    }
});
