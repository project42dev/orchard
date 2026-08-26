# Repo intent — orchard

**Autonomous Curriculum Discovery, Currency Maintenance & Multi-Model AI Delivery Platform.**

## What this repo is

Orchard is a content lifecycle tool for Project 42's curriculum: it discovers,
drafts, verifies, maintains, and retires content over any OpenAI-compatible
endpoint. Enterprise-grade design for continuous discovery, drift detection,
multi-model adversarial AI authoring, human-in-the-loop governance, and verifiable
production publication.

Key mechanisms:
- **Two independent tracks** — Discovery (bounded, ethical surveys across 78+
  verified technical sources) and Currency (100% inspection of 183 canonical
  curriculum modules to detect and correct drift)
- **5-model adversarial authoring ensemble** in Azure AI Foundry: Drafter,
  Verifier, Adversary, Arbiter, Finalizer — each a distinct frontier model
- **Cryptographic human-in-the-loop gates** — Gate 1 (scope/budget approval before
  spend), Gate 2 (cryptographically bound approval of exact artifact SHA-256
  digests before merge)

## Shape

- `briefs/`, `delivery/`, `content/` — the pipeline stages
- `Test-Project42*.ps1`, `Invoke-Project42FoundryQualification.ps1` — PowerShell
  harnesses for delivery/foundry qualification testing
- `schema/`, `contracts/` — content and delivery contracts
- `content.db` — local content database

## How it relates to other repos

- Produces content consumed by **`project42-platform`**'s content model

## What this repo is not

- Per `REPO-BOUNDARY.md`: keep this scoped to the content lifecycle engine, not a
  general Project 42 ops dumping ground (that's `project42dev-ops`)

## Status

Active — this is Project 42's most operationally elaborate repo, running real
multi-model pipelines with cryptographic approval gates.
