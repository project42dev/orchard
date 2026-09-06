# Orchard documentation

Orchard is the content lifecycle engine for Project 42. It watches an approved
list of primary sources for what the world teaches that this estate does not,
inspects the published corpus for what has stopped being true, and proposes
work. **It never publishes anything a person has not approved twice.**

Orchard consumes an OpenAI-compatible endpoint and never provisions one, so it
is not tied to any cloud. The container image is the portable artifact. What
belongs here and what does not is stated in
[REPO-BOUNDARY.md](../REPO-BOUNDARY.md).

---

## Read in this order

| Document | What it answers |
|---|---|
| [**Status**](status.md) | What is built, deployed and actually proven, in separate columns. **Start here.** |
| [**Lifecycle**](lifecycle.md) | The state machine, and one content item from first noticed to retired. |
| [**Lifecycle, step by step**](lifecycle-steps.md) | Per step: the exact job, script, table, state, artifact, actor and failure mode. |
| [**Workflow orchestration**](workflow-orchestration.md) | The two evidence tracks, the six workflows, and what each may write. |
| [**Decisions**](decisions.md) | The reasoning by theme, with the failure behind each decision. |
| [**Architecture decisions**](adr/index.md) | Thirteen accepted decisions, one page each. |

Start with [Status](status.md). An architecture decision records a decision and
is **not** evidence that anything is built, and this project has been bitten by
reading the two as the same thing.

## Running it

| Document | What it answers |
|---|---|
| [**Architecture and system design**](architecture.md) | System topology, trust boundaries, the multi-model ensemble, and the concrete Azure deployment. |
| [**Operations and runbook**](operations.md) | Manual triggers, reviewing human gates, monitoring, image deployments. |
| [**Installation and local setup**](install.md) | Prerequisites, configuration maps, and local test execution. |
| [**Rejection gate design**](design/rejection-gate.md) | What happens when the ensemble blocks a draft twice. |
| [**Hosting architecture diagram**](hosting-architecture.mmd) | Mermaid diagram of the Container Apps environment and external services. |
| [**Lifecycle diagram**](lifecycle.mmd) | Mermaid source for the lifecycle; [`lifecycle.svg`](lifecycle.svg) is generated from it. |

The ADRs deliberately omit private topology, identity and secret names,
schedules and cost figures, because those describe one organisation's
deployment rather than the portable capability. Architecture and Operations are
where that concrete deployment is written down.

---

## Quick reference

- **Azure Resource Group**: `rg-p42-orchard-prod-eus-01` (East US)
- **Container Apps Environment**: `cae-p42-orchard-prod-eus-01`
- **Container Registry**: `crp42orchprodeus01.azurecr.io/orchard`
- **State Store**: `stp42orchstateprodeus01/orchard-state` (`orchard.db` with lease locking)
- **Model Map Configuration**: `config/model-map.json`
- **Publication Targets**: `config/surface-targets.json`
- **Approved Source Registry**: `seed-inputs/approved-source-registry.json`
- **Live Learning Platform**: `https://project-42.dev`
