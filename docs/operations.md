# Orchard Operations & Runbook Guide

This runbook describes standard operational procedures for Orchard in production, including manual pipeline execution, gate approvals, telemetry monitoring, image updates, and failure recovery.

---

## 1. Triggering Pipelines Manually

Orchard runs on scheduled timers (1st of month for Track 1, 15th for Track 2), but either track can be triggered manually on demand via Azure CLI or Azure Portal.

### **Manual Track 1 (Discovery Survey)**
To survey all enabled sources in `seed-inputs/approved-source-registry.json` and create Gate 1 opportunities or zero-delta summaries:

```bash
az containerapp job start \
  --name caj-p42orch-t1-man-prod-eus-01 \
  --resource-group rg-p42-orchard-prod-eus-01 \
  --subscription be069ae1-fc96-4a07-9f8e-5994d83a137d
```

### **Manual Track 2 (Full Corpus Currency Inspection)**
To inspect all 183 canonical corpus items against live provider documentation and create Gate 1 drift review batches:

```bash
az containerapp job start \
  --name caj-p42orch-t2-man-prod-eus-01 \
  --resource-group rg-p42-orchard-prod-eus-01 \
  --subscription be069ae1-fc96-4a07-9f8e-5994d83a137d
```

### **Manual Release & Deployment Check**
To compare `main` against published release tags, bump versions, and deploy live learning platforms:

```bash
az containerapp job start \
  --name caj-p42orch-rel-prod-eus-01 \
  --resource-group rg-p42-orchard-prod-eus-01 \
  --subscription be069ae1-fc96-4a07-9f8e-5994d83a137d
```

---

## 2. Reviewing & Approving Human Gates

### **Gate 1 Approvals (Discovery & Currency Batches)**
Gate 1 issues appear on GitHub labeled with `orchard-gate-1`.
- **Whole Issue Approval**: Commenting `approved` or `approve` authorizes all items in that issue for AI authoring and Azure DevOps synchronization.
- **Specific Item Approval**:
  ```text
  /orchard gate1 approve item=<item-id>
  ```
- **Denying an Item**:
  ```text
  /orchard gate1 deny item=<item-id> reason="Out of scope for current curriculum milestone"
  ```

### **Gate 2 Approvals (Publication Manifests)**
Gate 2 issues appear on GitHub labeled with `orchard-gate-2`.
- **Whole Issue Approval**: Commenting `approved` approves every item in the batch whose evidence passed review.
- **Specific Item Approval**:
  ```text
  /orchard gate2 approve item=<item-id> revision=<rev> digest=<sha256-digest>
  ```
- **Requesting Changes**:
  ```text
  /orchard gate2 request-changes item=<item-id> revision=<rev> reason="Update source URL to official docs"
  ```

> **Note on Approver Identity**: All comments must originate from an authorized GitHub identity (`@kristopherjturner`). Comments from bots or unlisted users fail closed with `gate.apply.actor-unauthorised`.

---

## 3. Real-Time Telemetry & Log Monitoring

Orchard streams structured JSON events to Azure Log Analytics (`log-p42-orchard-prod-eus-01`, Workspace ID `83f9f9a4-4d62-49c9-8e8d-10279eb687f6`).

### **View Active Authoring Progress**
```kusto
ContainerAppConsoleLogs_CL
| where ContainerJobName_s == "caj-p42orch-t2-auth-prod-eus-01"
| order by TimeGenerated desc
| take 100
```

### **Inspect Gate Decision Processing**
```kusto
ContainerAppConsoleLogs_CL
| where Log_s contains "gate.apply"
| order by TimeGenerated desc
| project TimeGenerated, ContainerJobName_s, Log_s
```

### **Check Live Multi-Model Inference Calls**
```kusto
ContainerAppConsoleLogs_CL
| where Log_s contains "role=" or Log_s contains "brief="
| order by TimeGenerated desc
```

---

## 4. Building & Deploying Updated Container Images

A merge to `main` builds both runtime images and re-points every runtime Container Apps job at the new image, through `.github/workflows/deploy-runtime.yml`. Nothing has to be run by hand for a code change to reach production.

This section previously told an operator to build an `orchard:latest` tag and said the jobs pull that tag on each execution. Both statements were wrong and dangerous: the estate was deliberately pinned off floating tags after an incident, and every job is referenced by immutable manifest digest. There is no floating tag in this estate.

**Arming the rollout.** The workflow's job runs only when the repository variable `ORCHARD_DEPLOY_ENABLED` is exactly `true`. Unset, it is skipped and shows as skipped, not failed, so merging never deploys by accident.

```bash
gh variable set ORCHARD_DEPLOY_ENABLED --repo project42dev/orchard --body true
gh workflow run "Deploy runtime" --repo project42dev/orchard
```

**What one rollout does.** Builds `orchard-two-track` (from `delivery/Dockerfile.two-track`) and `orchard` (from `delivery/Dockerfile`), both tagged with the exact commit; resolves each tag to exactly one manifest digest; updates each job's image to that digest and its `ORCHARD_IMPLEMENTATION_COMMIT` to the same commit; then reads every job back and fails, naming each stranded job, unless all of them carry the expected digest and commit.

**What it deliberately does not do.**

- No infrastructure. The Bicep template, budget, alerts and role assignments stay with `Deploy-Orchard.ps1` in `project42dev-ops/deployment`.
- No seeding, and the **seed job is never re-pointed**. Its image must carry release-staged artifacts (`corpus.tar.gz`, `manifest.json`, `approved-source-registry.json`, `seed-manifest.json`) that `Deploy-Orchard.ps1` stages into `seed-inputs/` from the operator's own content checkout. Those files are gitignored, so a CI-built image carries an empty `seed-inputs/` and the seed job would fail its own bound-digest verification. Re-seed with `Deploy-Orchard.ps1`.

**Identity and permissions.** The workflow authenticates with the repository's `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` secrets over OIDC federation, with no stored credential. That principal needs a federated credential for subject `repo:project42dev/orchard:ref:refs/heads/main`, rights to schedule a registry build (`Microsoft.ContainerRegistry/registries/scheduleRun/action`, `listBuildSourceUploadUrl/action`, and image push), and `Microsoft.App/jobs/write` plus read on the runtime jobs. It is a different, more capable principal than the gate-comment starter, whose custom role carries only `Microsoft.App/jobs/start/action`.

---

## 5. Emergency Procedures & Troubleshooting

| Symptom | Cause | Remediation |
| :--- | :--- | :--- |
| **`ERR_ORCHARD_LEASE_ACQUISITION_FAILED`** | Another job currently holds the state blob lease. | Wait 60s for the lease to expire, or inspect active ACA executions. |
| **`ERR_ORCHARD_RUNTIME_FAILED (ENOENT)`** | Required file missing from container image. | Ensure file is in `delivery/Dockerfile.two-track` COPY directives and rebuild image. |
| **`gate.apply.actor-unauthorised`** | Issue comment made by unauthorized GitHub account. | Have `@kristopherjturner` post the approval comment. |
| **`ERR_ORCHARD_AUTHORING_SPEND_CAP`** | Single item exceeds estimated cost limit. | Review model pricing table in `config/model-map.json`. |
