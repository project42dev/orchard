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

When code or configuration is updated in the `orchard` repository, rebuild and push the production container image to Azure Container Registry:

```bash
# Run Azure Container Registry cloud build from repository root
az acr build \
  --registry crp42orchprodeus01 \
  --image orchard:latest \
  --file delivery/Dockerfile.two-track . \
  --subscription be069ae1-fc96-4a07-9f8e-5994d83a137d
```

The Container App Jobs pull `crp42orchprodeus01.azurecr.io/orchard:latest` on each execution.

---

## 5. Emergency Procedures & Troubleshooting

| Symptom | Cause | Remediation |
| :--- | :--- | :--- |
| **`ERR_ORCHARD_LEASE_ACQUISITION_FAILED`** | Another job currently holds the state blob lease. | Wait 60s for the lease to expire, or inspect active ACA executions. |
| **`ERR_ORCHARD_RUNTIME_FAILED (ENOENT)`** | Required file missing from container image. | Ensure file is in `delivery/Dockerfile.two-track` COPY directives and rebuild image. |
| **`gate.apply.actor-unauthorised`** | Issue comment made by unauthorized GitHub account. | Have `@kristopherjturner` post the approval comment. |
| **`ERR_ORCHARD_AUTHORING_SPEND_CAP`** | Single item exceeds estimated cost limit. | Review model pricing table in `config/model-map.json`. |
