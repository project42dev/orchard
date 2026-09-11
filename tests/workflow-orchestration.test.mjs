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

test("a Gate 2 decision can only be made by a comment that was CREATED, never an edited one", () => {
    // gate2-review.mjs sees only the comment body; it has no way to know the
    // text on screen is not the text that was posted. The refusal therefore
    // lives HERE, in the trigger, and it is the only thing holding it on this
    // path -- so it is pinned rather than left to a reading of the YAML.
    // Adding 'edited' to this list would make every prior refused approval
    // re-approvable by quietly rewriting the comment that was refused.
    const parsed = parseDocument(read("../.github/workflows/orchard-human-review.yml"), { prettyErrors: true, uniqueKeys: true }).toJS();
    assert.deepEqual(parsed.on.issue_comment.types, ["created"]);
    const trigger = parseDocument(read("../.github/workflows/gate-comment-trigger.yml"), { prettyErrors: true, uniqueKeys: true }).toJS();
    assert.deepEqual(trigger.on.issue_comment.types, ["created"]);
});

test("the Gate 2 reviewer's several-decisions-per-comment contract is what the workflow actually consumes", () => {
    const humanReview = read("../.github/workflows/orchard-human-review.yml");
    // decisions_json pairs each reason with the item it was written about.
    // The rework step must read THAT, not re-scrape the comment body: a
    // body-scrape takes the first reason in the comment and would hand item
    // two the reason written about item one.
    assert.match(humanReview, /ORCHARD_DECISIONS_JSON: \$\{\{ steps\.decision\.outputs\.decisions_json \}\}/);
    assert.doesNotMatch(humanReview, /sed -n 's\/\.\*reason=/);
    // The help text on a refused comment has to say the rule the script
    // enforces, or the owner cannot tell a refusal from a bug.
    assert.match(humanReview, /if any line is wrong, NONE of them is applied/);
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

    // Read-only, like every other GitHub Actions entry point here. id-token
    // is not a GitHub write scope: it is the OIDC exchange the Azure login
    // step below uses to reach Key Vault, so it stays permitted here even
    // though contents/issues write do not.
    assert.equal(parsed.permissions.contents, "read");
    assert.equal(parsed.permissions["id-token"], "write");
    assert.doesNotMatch(ingest, /contents: write|issues: write/);
    assert.doesNotMatch(ingest, /git push|record-publication/);
    assert.match(ingest, /persist-credentials: false/);
    assert.doesNotMatch(ingest, /uses: [^\s]+@v\d/);

    // A partial conversion must not read as a clean run.
    assert.match(ingest, /Fail the run if any request was rejected/);
});

test("the three App-token mints read the GitHub App credential from Key Vault via OIDC, not repository secrets (T-08)", () => {
    const ingest = read("../.github/workflows/curriculum-request-ingest.yml");
    const humanReview = read("../.github/workflows/orchard-human-review.yml");
    const verifyCredential = read("../.github/workflows/verify-publish-credential.yml");

    for (const [name, workflow] of [
        ["curriculum-request-ingest.yml", ingest],
        ["orchard-human-review.yml", humanReview],
        ["verify-publish-credential.yml", verifyCredential],
    ]) {
        const document = parseDocument(workflow, { prettyErrors: true, uniqueKeys: true });
        assert.deepEqual(document.errors, [], `${name} must be valid YAML`);
        const parsed = document.toJS();

        // The job exchanges GitHub's OIDC token for an Azure token as the
        // dedicated content-request managed identity, never the deploy
        // identity deploy-runtime.yml signs in as.
        assert.match(workflow, /client-id: \$\{\{ vars\.ORCHARD_CONTENT_REQUEST_CLIENT_ID \}\}/, `${name} must sign in as the content-request identity`);
        assert.doesNotMatch(workflow, /vars\.ORCHARD_DEPLOY_CLIENT_ID/, `${name} must not reuse the deploy identity`);

        // Some job in the workflow carries id-token: write for that login.
        const jobPermissions = Object.values(parsed.jobs ?? {})
            .map((job) => job?.permissions)
            .filter(Boolean);
        const topLevelHasIdToken = parsed.permissions?.["id-token"] === "write";
        const someJobHasIdToken = jobPermissions.some((p) => p["id-token"] === "write");
        assert.ok(topLevelHasIdToken || someJobHasIdToken, `${name} must grant id-token: write for the Azure login`);

        // The private key is a multiline PEM: tsv silently truncates it, so
        // it must be read as json and unwrapped with jq, never tsv.
        assert.match(workflow, /hcs-platform-github-app-private-key[^\n]*-o json/, `${name} must read the private key as json`);
        assert.doesNotMatch(workflow, /hcs-platform-github-app-private-key[^\n]*-o tsv/, `${name} must not read the private key as tsv (it truncates multiline values)`);
        assert.match(workflow, /jq -r \.value/, `${name} must unwrap the Key Vault json response with jq`);

        // Both secrets are masked before they can reach a log: the app id as
        // a whole, and the PEM private key line-by-line (a single mask on
        // the whole multiline value would not match it split across log
        // lines).
        assert.match(workflow, /::add-mask::\$app_id/, `${name} must mask the app id`);
        assert.match(workflow, /::add-mask::\$line/, `${name} must mask the private key line-by-line`);

        // No repository-secret App credential and no organisation-wide PAT
        // fallback remain anywhere in these workflows.
        assert.doesNotMatch(workflow, /ORG_PAT/, `${name} must not reference ORG_PAT`);
        assert.doesNotMatch(workflow, /secrets\.ORCHARD_CONTENT_REQUEST_APP_/, `${name} must not read the App credential from a repository secret`);
    }

    // The two production paths fail the run on a bad login/read/mint; only
    // the diagnostic workflow may swallow that failure.
    assert.doesNotMatch(ingest, /continue-on-error/, "curriculum-request-ingest.yml must fail loudly on the production path");
    assert.doesNotMatch(humanReview, /Azure login[\s\S]{0,400}continue-on-error/, "orchard-human-review.yml's mint chain must fail loudly");
    assert.match(verifyCredential, /Azure login \(OIDC, no stored secret\)\s*\n\s*id: azure-login\s*\n\s*continue-on-error: true/, "verify-publish-credential.yml's mint path stays diagnostic");
});

test("the deploy workflow rebuilds and re-points the runtime, immutably and loudly", () => {
    // The gap this closes: nothing committed here reached production. There was
    // no build on merge, no image push, and no job re-point, so every fix sat
    // inert until an operator remembered to run Deploy-Orchard.ps1 by hand --
    // including for a scheduled run, which uses whatever image is deployed when
    // the cron fires.
    const deploy = read("../.github/workflows/deploy-runtime.yml");
    const document = parseDocument(deploy, { prettyErrors: true, uniqueKeys: true });
    assert.deepEqual(document.errors, [], "the deploy workflow must be valid YAML");
    const parsed = document.toJS();

    // It runs on merge to main, and by hand.
    assert.deepEqual(parsed.on.push.branches, ["main"]);
    assert.equal(typeof parsed.on.workflow_dispatch, "object");
    assert.equal(parsed.concurrency["cancel-in-progress"], false,
        "two rollouts of one estate must never interleave");

    // OIDC federation against the existing repository secrets, no stored
    // credential, and every action pinned by commit like the others here.
    assert.equal(parsed.permissions["id-token"], "write");
    assert.equal(parsed.permissions.contents, "read");
    for (const secret of ["AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) {
        assert.match(deploy, new RegExp(`secrets\.${secret}`), `${secret} must come from the repository secret`);
    }
    // T-06: the rollout signs in as the dedicated deploy identity. It must not
    // borrow AZURE_CLIENT_ID, which is the least-privilege gate app.
    assert.match(deploy, /client-id: \$\{\{ vars\.ORCHARD_DEPLOY_CLIENT_ID \}\}/,
        "the rollout must sign in as the deploy identity");
    assert.doesNotMatch(deploy, /secrets\.AZURE_CLIENT_ID/,
        "the rollout must not reuse the gate app's client id");
    assert.doesNotMatch(deploy, /uses: [^\s]+@v\d/, "every action is pinned by commit");
    assert.match(deploy, /persist-credentials: false/);

    // Armed by the owner, not by a merge: an unset variable skips the job
    // rather than failing it, and merging this workflow deploys nothing.
    assert.equal(parsed.jobs.rollout.if, "vars.ORCHARD_DEPLOY_ENABLED == 'true'");

    // Immutable by construction. The estate was pinned off floating tags after
    // a prior incident; the tag is the commit and the jobs are re-pointed by
    // digest, never by tag.
    const deployCode = deploy.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(deployCode, /:latest/, "no floating tag, ever");
    assert.match(deploy, /tag="\$\{GITHUB_SHA\}"/);
    assert.match(deploy, /\^\[a-f0-9\]\{40\}\$/, "the release tag is checked to be an exact commit");
    assert.match(deploy, /\^sha256:\[a-f0-9\]\{64\}\$/, "each tag must resolve to exactly one immutable digest");
    assert.match(deploy, /--image "\$\{expected\[\$name\]\}"/);
    assert.match(deploy, /ORCHARD_IMPLEMENTATION_COMMIT=\$\{TAG\}/,
        "a job re-pointed without its commit would report provenance it does not have");

    // Fails loudly. Every job is attempted, every job is read back, and a
    // partial rollout exits non-zero naming what is stranded.
    assert.match(deploy, /az containerapp job show/, "the deployed resource is read back, not assumed");
    assert.match(deploy, /exit 1/);
    assert.doesNotMatch(deploy, /continue-on-error/);

    // A protected adapter is verified inside the job against a digest the
    // release BOUND into its environment. Ship an image whose adapter changed
    // without re-binding that digest and the job provisions no decision
    // authority and publishes nothing, while the rollout reports success --
    // the exact half-success this workflow exists to prevent.
    assert.match(deploy, /protectedAdapterDigest/, "the digests are recomputed with the runtime's own hasher");
    assert.match(deploy, /ORCHARD_GATE_ADAPTER_DIGEST=/);
    assert.match(deploy, /ORCHARD_PUBLICATION_ADAPTER_DIGEST=/);
    assert.match(deploy, /would refuse to provision its decision authority/,
        "and a job left on the wrong adapter fails the rollout by name");

    // The seed job's image carries release-staged artifacts that are gitignored
    // here, so a CI-built image would fail its own bound-digest verification.
    // It must never appear in the rollout list.
    assert.doesNotMatch(deploy, /runtime_jobs=\([^)]*seed/, "the seed job is never re-pointed by CI");
    assert.match(deploy, /does not touch the SEED job/i, "and the reason is stated, not implied");
});
