# Orchard Content Lifecycle & State Machine

Every curriculum unit tracked by Orchard progresses through a deterministic, strictly ordered 14-state lifecycle machine. No item can bypass a state, skip an authorization gate, or publish without verified proof.

---

## 1. Lifecycle State Machine

```text
                  [ DISCOVERY / INSPECTION ]
                              │
                              ▼
                       ┌──────────────┐
                       │  discovered  │
                       └──────┬───────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │  gate1-pending   │
                     └────────┬─────────┘
            ┌─────────────────┴─────────────────┐
            │                                   │
            ▼                                   ▼
    ┌───────────────┐                   ┌───────────────┐
    │ gate1-approved│                   │    denied     │ (Terminal)
    └───────┬───────┘                   └───────────────┘
            │
            ▼
    ┌───────────────┐
    │  ado-linked   │ (Work Item created in Azure DevOps: AB#...)
    └───────┬───────┘
            │
            ▼
    ┌───────────────┐
    │   executing   │ (5-Model Foundry Ensemble: Drafter ➔ Verifier ➔ Adversary ➔ Arbiter ➔ Finalizer)
    └───────┬───────┘
            │
            ▼
    ┌───────────────┐
    │  gate2-ready  │
    └───────┬───────┘
            │
            ▼
    ┌──────────────────┐
    │  gate2-pending   │ (Manifest & Diff announced on GitHub Gate 2)
    └────────┬─────────┘
            │
            ▼
    ┌──────────────────┐
    │  gate2-approved  │ (Bound to exact SHA-256 artifact digest)
    └────────┬─────────┘
            │
            ▼
 ┌──────────────────────┐
 │ publication-preparing│
 └──────────┬───────────┘
            │
            ▼
    ┌───────────────┐
    │   published   │ (PR Merged into protected main)
    └───────┬───────┘
            │
            ▼
    ┌───────────────┐
    │   verified    │ (Live platform verification & probes pass)
    └───────┬───────┘
            │
            ▼
    ┌───────────────┐
    │    closed     │ (ADO Work Item closed & published to live sites)
    └───────────────┘
```

---

## 2. Detailed State Definitions

| State Index | State Name | Meaning & Trigger | External Action / Evidence Produced |
| :---: | :--- | :--- | :--- |
| **0** | `discovered` | Found by Track 1 discovery or Track 2 currency inspection. | Item recorded in `workflow_item` table. |
| **1** | `gate1-pending` | Batched and announced on GitHub Gate 1 issue. | Issue created with Markdown table and checkboxes. |
| **2** | `gate1-approved` | Authorized by operator comment. | Decision recorded with cryptographic user ID. |
| **3** | `ado-linked` | Azure DevOps work item created. | `AB#...` work item created and linked to GitHub issue. |
| **4** | `executing` | Claimed by authoring engine. | Multi-model ensemble runs in Azure AI Foundry. |
| **5** | `gate2-ready` | Artifact drafted and evidence compiled. | Proposal JSON written with source citations. |
| **6** | `gate2-pending` | Gate 2 manifest published on GitHub. | Gate 2 issue created with full artifact diff & digest. |
| **7** | `gate2-approved` | Operator authorizes exact artifact digest. | Approval recorded; invalidates if artifact changes. |
| **8** | `publication-preparing` | Branch prepared and PR opened against `main`. | Git branch created with immutable commit tree. |
| **9** | `published` | Pull request merged to protected `main`. | Merge commit confirmed on `main`. |
| **10** | `verified` | Probes and health checks pass on live endpoints. | Content probe validates live JSON schemas. |
| **11** | `closed` | Lifecycle complete. | Azure DevOps work item set to Closed. |

---

## 3. Exceptional Transitions & Rework Loops

- **`changes-requested`**: If an operator requests changes during Gate 2 review (`/orchard gate2 request-changes item=... reason="..."`), the item transitions to `changes-requested` and is automatically re-queued for authoring with the reviewer's feedback injected into the prompt.
- **`deferred`**: If review is postponed (`/orchard gate2 defer ... review-after=YYYY-MM-DD`), the item remains dormant until the specified date.
- **`stale-approval`**: If the underlying content or base branch changes after Gate 2 approval was recorded, the approval becomes stale and requires re-confirmation of the new digest.
