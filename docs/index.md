# Orchard documentation

Orchard is the content maintenance engine for Project 42. It watches published
content for staleness, proposes work, and runs a six-role delivery ensemble to
produce reviewed, evidence-backed content proposals.

## Navigation

**Start with [Status](status.md).** It says what is built, what is deployed and
what has actually been proven, kept in separate columns, so nothing on the other
pages reads as a claim it has not earned.

| Document | What it covers |
|---|---|
| [Status](status.md) | What is built, deployed and verified, and what is none of those |
| [Install guide](install.md) | Prerequisites, setup, and first run |
| [Lifecycle](lifecycle.md) | How content flows from published to stale to proposed to delivered |
| [Hosting architecture](hosting-architecture.mmd) | Azure Container Apps deployment topology (Mermaid diagram) |
| [Workflow orchestration](workflow-orchestration.md) | Independent evidence tracks, protected pins, and the post-track lifecycle |
| [Decisions](decisions.md) | Architecture decisions and the failures that produced them |
| [Repository boundary](../REPO-BOUNDARY.md) | What belongs in this repository and what does not |

Everything Orchard needs is in this repository. Planning material and candid
early analysis live in a private repository by deliberate decision, and no page
here links into it, so every link on this site resolves for everyone.

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

## Lifecycle at a glance

```
evidence → Gate 1 → tracker work → qualified handoffs → bound artifact → Gate 2 → pull request → protected-main acknowledgement → owner closure
```

See [lifecycle.md](lifecycle.md) for the full diagram and role descriptions.
