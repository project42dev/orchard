# Orchard documentation

Orchard is the content maintenance engine for Project 42. It watches published
content for staleness, proposes work, and runs a six-role delivery ensemble to
produce reviewed, evidence-backed content proposals.

## Navigation

| Document | What it covers |
|---|---|
| [Install guide](install.md) | Prerequisites, setup, and first run |
| [Lifecycle](lifecycle.md) | How content flows from published to stale to proposed to delivered |
| [Workflow orchestration](workflow-orchestration.md) | Independent evidence tracks, protected pins, and the post-track lifecycle |
| [Decisions](decisions.md) | Architecture decisions and the failures that produced them |

## Quick reference

- **Repo:** `d:\git\project42dev\orchard`
- **Content database:** `content.db` (SQLite, derived from content files)
- **Delivery ensemble:** 6 roles across 4 vendor families
- **Model map:** `config/model-map.json`
- **Brief generator:** `scripts/generate-briefs.mjs`
- **Delivery platform:** `delivery/Invoke-Project42Delivery.ps1`
- **Hosting:** Azure Container Apps Jobs (reference deployment). Container image is portable and runs on any container platform against any OpenAI-compatible endpoint.

## Lifecycle at a glance

```
evidence → Gate 1 → tracker work → qualified handoffs → bound artifact → Gate 2 → pull request → protected-main acknowledgement → owner closure
```

See [lifecycle.md](lifecycle.md) for the full diagram and role descriptions.
