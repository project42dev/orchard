# Orchard Architecture & System Design

Orchard is an autonomous, dual-track curriculum lifecycle platform built for continuous discovery, currency maintenance, multi-model AI authoring, human-in-the-loop governance, and verifiable production release.

---

## 1. System Topology & Core Boundaries

Orchard operates across three strict trust boundaries:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        HUMAN OPERATOR & GOVERNANCE                     │
│  - GitHub Issues (Gate 1 Approvals & Gate 2 Manifest Approvals)        │
│  - Azure DevOps (Authoritative Work Items: AB#...)                     │
└────────────────────────────────────▲───────────────────────────────────┘
                                     │ Human Decisions / Webhooks
┌────────────────────────────────────▼───────────────────────────────────┐
│                      ORCHARD PRODUCTION RUNTIME                        │
│  Azure Container Apps Environment (cae-p42-orchard-prod-eus-01)        │
│                                                                        │
│  [ Track 1: Discovery ]         [ Track 2: Currency & Maintenance ]    │
│  • Bounded Source Surveys        • 100% Corpus Inspection              │
│  • Opportunity Scoring           • Multi-Model Authoring Ensemble      │
│  • Gate 1 Batching               • Gate 2 Evidence Qualification       │
│                                                                        │
│  [ Private State Store ]                                               │
│  • SQLite state database (orchard.db) in Azure Blob Storage            │
│  • Lease-locked transactional updates                                  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Read-Only Model Invocations
┌────────────────────────────────────▼───────────────────────────────────┐
│                        AZURE AI FOUNDRY ENDPOINTS                      │
│  - Drafter: gpt-5-6-sol                                                │
│  - Verifier: grok-4-20-reasoning                                       │
│  - Adversary: deepseek-v4-pro                                          │
│  - Arbiter: mistral-large-3                                            │
│  - Finalizer: gpt-5-6-luna                                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The Two Independent Evidence Tracks

Orchard separates discovery of *new opportunities* from *maintenance of existing content* into two decoupled tracks:

### **Track 1: Content Discovery**
- **Objective**: Survey the versioned Approved Source Registry (`seed-inputs/approved-source-registry.json`) to identify gaps, emerging tooling, and new standards.
- **Cadence**: Automatically scheduled on the **1st of each month at 06:00 UTC** (`caj-p42orch-t1-sch-prod-eus-01`) or triggered manually on demand (`caj-p42orch-t1-man-prod-eus-01`).
- **Safety**: Bounded to enabled sources (78+ sources); respects `robots.txt`, rate limits, and domain-specific policies.
- **Zero-Delta Announcement**: If all surveyed sources are up to date and 0 new opportunities are found, posts an end-of-run summary issue and exits cleanly.
- **Gate 1 Generation**: If actionable gaps are discovered, creates batched Gate 1 review issues in GitHub.

### **Track 2: Content Currency & Drift Maintenance**
- **Objective**: Perform an exhaustive, 100% inspection of every canonical corpus item against active provider documentation and standards.
- **Cadence**: Automatically scheduled on the **15th of each month at 06:00 UTC** (`caj-p42orch-t2-sch-prod-eus-01`) or triggered manually on demand (`caj-p42orch-t2-man-prod-eus-01`).
- **Coverage**: Inspects all 183 canonical corpus items across modules, code labs, diagrams, resources, and standards.
- **Gate 1 Batching**: Batches drift items into review issues (max 16 items/issue) with complete proposed corrections, sources, and affected learning paths.

---

## 3. Human-in-the-Loop Governance Gates

Orchard never reaches an external model or publishes content without explicit, cryptographically bound human authorization:

```
[ Raw Discovery / Currency Findings ]
                  │
                  ▼
         ┌─────────────────┐
         │     GATE 1      │ ──► Human review of scope, spend cap, and learning path
         └────────┬────────┘
                  │ Approved by @kristopherjturner
                  ▼
         ┌─────────────────┐
         │ Azure DevOps    │ ──► Creates AB# Work Items & links back to GitHub
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ Multi-Model AI  │ ──► 5-Model Adversarial Qualification Ensemble
         │   Authoring     │     (Drafter ➔ Verifier ➔ Adversary ➔ Arbiter ➔ Finalizer)
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │     GATE 2      │ ──► Human review of exact immutable artifact diff & digest
         └────────┬────────┘
                  │ Approved by @kristopherjturner
                  ▼
         ┌─────────────────┐
         │ Publication &   │ ──► Pull Request merge, release bump, Cloudflare & Azure deploy
         │ Live Release    │
         └─────────────────┘
```

### **Gate 1 (Scope & Budget Approval)**
- Controls whether an item is permitted to consume AI compute and spend budget.
- Authorized approver: `@kristopherjturner` (ID `13710532`).
- Upon approval, the comment trigger webhook immediately invokes the authoring pipeline and synchronizes Azure DevOps work items.

### **Gate 2 (Artifact & Evidence Qualification)**
- Controls whether an authored artifact is permitted to merge into the protected `main` branch.
- Binds approval to the exact SHA-256 digest of the artifact and display diff.
- If an artifact is modified, earlier approvals are automatically invalidated.
- Denial or request-changes re-queues the item with the reviewer's feedback for automated rework.

---

## 4. Multi-Model Adversarial Authoring Ensemble

When Gate 1 items are approved, Orchard executes a 5-role adversarial qualification pipeline in Azure AI Foundry:

| Role | Deployed Model | Responsibility |
| :--- | :--- | :--- |
| **1. Drafter / Researcher** | `gpt-5-6-sol` | Researches approved citations and drafts curriculum JSON/Markdown. |
| **2. Verifier** | `grok-4-20-reasoning` | Fact-checks every claim against cited sources and verifies schema rules. |
| **3. Adversary** | `deepseek-v4-pro` | Red-teams the draft, actively searching for hallucinated parameters and edge-case bugs. |
| **4. Arbiter** | `mistral-large-3` | Weighs Verifier proof against Adversary challenges to issue a consensus verdict (`PASS`/`REFUTED`). |
| **5. Finalizer** | `gpt-5-6-luna` | Polishes style, formats JSON structure, and prepares Gate 2 evidence. |

---

## 5. Persistence, State Storage & Leases

All workflow state travels in a private SQLite database (`orchard.db`) stored in Azure Blob Storage (`stp42orchstateprodeus01/orchard-state`):
- **Lease Locking**: Prior to any read/write cycle, the executing Container App acquires an exclusive 60-second blob lease, preventing split-brain execution across parallel jobs.
- **Authoritative vs Derived Data**:
  - *Authoritative* (survives rebuilds): `workflow_item`, `gate_decision`, `handoff_record`, `publication_record`.
  - *Derived* (rebuilt from repository content): `item`, `citation`, `source`, `candidate`.
