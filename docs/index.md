# Orchard documentation

**This repository holds the source and the operator documentation. What Orchard
is and what it does is documented with the rest of Project 42.**

Orchard is a separate open-source tool and a core part of Project 42, so the
documentation is split by who is reading it rather than by which repository the
files happen to sit in.

## Running Orchard, here

| Document | What it covers |
|---|---|
| [Install guide](install.md) | Prerequisites, the environment contract, and a first run |
| [Hosting architecture](hosting-architecture.mmd) | Deployment topology |
| [Repository boundary](../REPO-BOUNDARY.md) | What belongs in this repository and what does not |

The environment contract is declared in the `ENV` block of
[`delivery/Dockerfile`](../delivery/Dockerfile). Read it there: it is the list
the entry point actually reads, so it cannot drift from the code.

## What Orchard is, in the Project 42 documentation

Everything below lives in
[`project42dev/project42-platform`](https://github.com/project42dev/project42-platform),
under `docs/orchard/`, which is the one location for public Project 42
documentation.

| Document | What it answers |
|---|---|
| [Status](https://github.com/project42dev/project42-platform/blob/main/docs/orchard/status.md) | What is built, deployed and actually proven, in separate columns |
| [Lifecycle](https://github.com/project42dev/project42-platform/blob/main/docs/orchard/lifecycle.md) | One content item from first noticed to retired |
| [Workflow orchestration](https://github.com/project42dev/project42-platform/blob/main/docs/orchard/workflow-orchestration.md) | The two evidence tracks and what each may write |
| [Decisions](https://github.com/project42dev/project42-platform/blob/main/docs/orchard/decisions.md) | The reasoning, and the failure behind each decision |
| [Decision records](https://github.com/project42dev/project42-platform/blob/main/docs/orchard/adr/index.md) | Thirteen accepted decisions, one page each |

**Read the status page before anything else.** A decision record records a
decision and is not evidence that anything is built, and reading the two as the
same thing is a mistake this project has already made.

## Quick reference

| Thing | Where |
|---|---|
| Content database | `content.db`, SQLite, derived from content files |
| Model map | `config/model-map.json` |
| Approved source registry | `content/source-registry.json` |
| Watch list and opportunity registry | `content/opportunity-registry.starter.json` |
| Brief generator | `scripts/generate-briefs.mjs` |
| Delivery entry point | `delivery/Invoke-Project42Delivery.ps1` |
| Environment contract | the `ENV` block of `delivery/Dockerfile` |
| Delivery ensemble | 6 roles across 4 vendor families |

**Hosting.** Azure Container Apps Jobs in the reference deployment. The
container image is the portable artifact and runs on any container platform
against any OpenAI-compatible endpoint. Orchard consumes an endpoint and never
provisions one.
