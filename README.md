# Orchard

> **Autonomous Curriculum Discovery, Currency Maintenance & Multi-Model AI Delivery Platform**

Orchard is an enterprise-grade content lifecycle engine designed for continuous discovery, drift detection, multi-model adversarial AI authoring, human-in-the-loop governance, and verifiable production publication.

---

## 🌟 Key Capabilities

- **Dual Independent Tracks**:
  - **Track 1 (Discovery)**: Bounded, ethical surveys across 78+ verified technical documentation sources.
  - **Track 2 (Currency)**: Complete, 100% inspection of 183 canonical curriculum modules to detect and correct drift.
- **5-Model Adversarial Authoring Ensemble**:
  - Automatically orchestrates specialized frontier LLMs in Azure AI Foundry: **Drafter** (`gpt-5-6-sol`), **Verifier** (`grok-4-20-reasoning`), **Adversary** (`deepseek-v4-pro`), **Arbiter** (`mistral-large-3`), and **Finalizer** (`gpt-5-6-luna`).
- **Cryptographic Human-in-the-Loop Gates**:
  - **Gate 1 (Scope & Budget)**: Human approval required before compute or spend begins.
  - **Gate 2 (Evidence & Digest)**: Cryptographically bound approval of exact artifact SHA-256 digests before merge.
- **Enterprise Tracking & Provenance**:
  - Bidirectional Azure DevOps synchronization (`AB#...`) and full tamper-evident citation hashing.

---

## 🏗️ Architecture Overview

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
│  - Drafter: gpt-5-6-sol        - Verifier: grok-4-20-reasoning         │
│  - Adversary: deepseek-v4-pro  - Arbiter: mistral-large-3              │
│  - Finalizer: gpt-5-6-luna                                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📖 Public Documentation

All detailed architectural and operational documentation is available in the [`docs/`](docs/) directory:

- 🏛️ [**Architecture & System Design**](docs/architecture.md)
- 🛠️ [**Operations & Operator Runbook**](docs/operations.md)
- 🔄 [**Content Lifecycle & State Machine**](docs/lifecycle.md)
- 📊 [**Hosting Architecture Diagram**](docs/hosting-architecture.mmd)
- 📦 [**Installation & Environment Setup**](docs/install.md)
- 🛡️ [**Repository Boundary Policy**](REPO-BOUNDARY.md)

---

## 🚀 Quick Start (Operations)

### **Manual Track 1 (Discovery Survey)**
```bash
az containerapp job start \
  --name caj-p42orch-t1-man-prod-eus-01 \
  --resource-group rg-p42-orchard-prod-eus-01
```

### **Manual Track 2 (Full Corpus Currency Inspection)**
```bash
az containerapp job start \
  --name caj-p42orch-t2-man-prod-eus-01 \
  --resource-group rg-p42-orchard-prod-eus-01
```

### **Building & Deploying the Container Image**
```bash
az acr build \
  --registry crp42orchprodeus01 \
  --image orchard:latest \
  --file delivery/Dockerfile.two-track .
```

---

## 📜 License

Apache-2.0. Copyright (c) Project 42 Contributors.
