# Two-track workflow orchestration

> **Historical status, 2026-08-15 — superseded 2026-08-20.**
> This banner read "Orchard is not running anywhere", written after the
> 2026-08-14 reset to a never-run state (commit `0f05642`) ahead of the first
> full start-to-finish test. **It was true then and is not true now.** The
> production bring-up ran from 2026-08-16 to 2026-08-20; publication,
> PR-transaction merge, protected-main acknowledgement and release all execute
> against real infrastructure today, and `defer` is in the state machine.
> Live verification is the one item on that old "not built" list that is still
> genuinely incomplete: the check exists and was repaired on 2026-09-06, but
> nothing deployed invokes it. [Status](status.md) carries the evidence for all
> of this, kept in separate columns.

Orchard runs discovery and canonical-corpus inspection as independent evidence-producing workflows. Neither workflow approves content, creates or closes tracker work, publishes content, or mutates a target repository.

A third intake path, request intake, is **built** as of 2026-09-06. It is not a
track: it runs ahead of source collection, reads open GitHub issues carrying the
`content-request` label via `scripts/ingest-curriculum-requests.mjs`
(`.github/workflows/curriculum-request-ingest.yml`), and joins the same
discovery queue and the same Gate 1 as a discovered candidate. Corrected: this
paragraph previously said it was designed and not built. See the "Request
intake" section of [`lifecycle.md`](lifecycle.md).

## The workflows in this repository

Six, as of 2026-09-06. Added because this page previously named only the two
track workflows, and a reader had no way to discover the other four.

| Workflow | Name | What it does |
|---|---|---|
| [`track-1-discovery.yml`](../.github/workflows/track-1-discovery.yml) | Track 1 Source Policy Validation | Manual dispatch. Validates reviewed source policy in dry-run. Production discovery runs monthly as a container job, not here. |
| [`track-2-corpus-inspection.yml`](../.github/workflows/track-2-corpus-inspection.yml) | Track 2 Corpus Pin Validation | Manual dispatch. Validates an immutable corpus pin in dry-run. Production inspection runs monthly as a container job. |
| [`orchard-human-review.yml`](../.github/workflows/orchard-human-review.yml) | Orchard Human Review | The bound Gate 2 approver. Acts only on `/orchard gate2` commands naming the exact item and artifact digest. |
| [`gate-comment-trigger.yml`](../.github/workflows/gate-comment-trigger.yml) | Gate comment trigger | Routes a gate decision comment on a Discovery or Currency issue to the item-bound gate CLI. |
| [`curriculum-request-ingest.yml`](../.github/workflows/curriculum-request-ingest.yml) | Curriculum Request Ingest | Reads open `content-request` issues into the discovery queue. This is request intake. |
| [`release-validation.yml`](../.github/workflows/release-validation.yml) | Orchard release validation | Validates a release before the release job may act. |

## Workflow boundary audit

> **Scope correction, updated at the 2026-08-14 merge to `main`.**
>
> Three legacy workflows (engine, maintenance, decommission) are removed:
> their jobs run as Azure Container Apps jobs. **Orchard Human Review was
> deliberately kept and NOT removed**, because by merge time it had been
> rebuilt as the bound Gate 2 approver: it acts only on `/orchard gate2`
> commands naming the exact item and artifact digest, with a denial-rework
> loop. Rows below describing an unbound bare-`Approved` approver are
> history, not current behaviour.

| Legacy workflow | Trigger and authority problem | External writes | Disposition |
|---|---|---|---|
| Orchard Engine | Disabled body combined discovery, model execution, tracker synchronization, and notifications. It depended on one Azure deployment and broad identity permissions. | Issues, Azure token acquisition, tracker updates, and delivery artifacts. | Removed. Track 1 now performs bounded read-only discovery only. Operator-specific delivery remains outside this public repository. |
| Orchard Maintenance | Disabled body combined source checks, model execution, tracker synchronization, and notifications. It depended on private runtime configuration. | Issues, Azure token acquisition, tracker updates, and delivery artifacts. | Removed. Track 2 now performs complete inspection against one exact corpus commit. |
| Orchard Human Review | Any matching issue comment could infer multiple subjects from mutable issue text. Approval recorded publication before verified publication, pushed directly, suppressed tracker errors, and closed the issue without protected-main acknowledgement or owner acceptance. | Direct repository pushes, issue mutation, database mutation, and tracker mutation. | Removed. Decisions use the item-bound gate CLI. Publication uses a protected-main pull request and exact acknowledgement. Closure requires owner acceptance. |
| Orchard Decommission | A disabled manual body interpolated untrusted inputs into scripts, edited the database directly, and pushed directly to main. | Direct content deletion, redirect mutation, direct push, and issue creation. | Removed. Retirement must enter the same item-bound two-gate lifecycle before a purpose-built replacement is enabled. |

## Track 1

[`.github/workflows/track-1-discovery.yml`](../.github/workflows/track-1-discovery.yml) is manual dispatch only and carries no schedule. It validates reviewed source policy in dry-run; production discovery runs monthly on the 1st at 06:00 UTC as a container job, not as a GitHub workflow. Corrected 2026-08-14: this line previously claimed a weekly Monday schedule that the workflow does not have.

- A scheduled run is always `full`.
- A completed full run requires at least 50 distinct approved and enabled sources and at least 50 attempts.
- The source registry comes from an exact canonical platform commit.
- Evidence-bearing scheduled and manual runs use the protected platform commit and normalized registry `sha256` digest.
- Dispatch callers may override those pins only in `dry-run`; caller-selected pins cannot produce evidence.
- Manual dispatch defaults to `dry-run`; `subset` requires explicit source IDs.
- Fetches are HTTPS-only, bounded by time and bytes, and may redirect only to registry-approved hosts.
- Hostnames must resolve only to public addresses, and the validated addresses are pinned into each TLS connection. Bodies are capped while streaming.
- The workflow has `contents: read` permission and uploads evidence only for non-dry runs.
- **Built:** request intake as the first step, before source collection,
  reading open `content-request` issues into the same queue a discovered
  candidate uses.

Track completion means complete, reconciled attempt accounting. Individual
source failures remain visible in coverage and evidence; they do not disappear
or become successful observations.

## Gate capture trust boundary

The decision capture payload supplies only reviewed-item bindings and a provider
event reference. It cannot supply provider evidence, an actor allowlist, or an
authorization policy. The authenticated provider adapter and authorization
policy are loaded from an immutable `gate` trust anchor in Orchard's SQLite
authority store. A separate administrator runs `provision-trust-anchor.mjs` to
derive and persist the exact adapter identity, adapter digest, policy content,
and policy digest. Gate capture has no environment variable, payload field, or
command-line option that can replace that authority. Equivalent `publication`
and `closure` anchors protect publication adapters and owner authorization.
Trust anchors and their evidence are append-only.

Configure these protected repository variables:

| Variable | Purpose |
|---|---|
| `ORCHARD_PLATFORM_REPOSITORY` | Repository supplying the approved **source registry** for a discovery run. Still defaults to `project42dev/project42-platform`, which is what `track-1-discovery.yml` sets. Note the distinction, checked 2026-09-06: the curriculum itself moved to `project42dev/project42-content` and Orchard **publishes** there (see `config/surface-targets.json`), but the source-registry pin this variable controls was not part of that repoint. |
| `ORCHARD_PLATFORM_COMMIT` | Exact lowercase 40-character commit used by scheduled runs. |
| `ORCHARD_SOURCE_REGISTRY_DIGEST` | Exact normalized digest of `content/source-registry.json`. |

Calculate the digest from the same exact platform checkout that supplies the
registry:

```text
npm run digest:source-registry -- ../project42-platform/content/source-registry.json
```

## Track 2

[`.github/workflows/track-2-corpus-inspection.yml`](../.github/workflows/track-2-corpus-inspection.yml) is manual dispatch only and carries no schedule. It validates an immutable corpus pin in dry-run; production inspection runs monthly on the 15th at 06:00 UTC as a container job, not as a GitHub workflow. Corrected 2026-08-14: this line previously claimed a weekly Monday schedule that the workflow does not have.

- A scheduled run is always `full`.
- A completed full run requires one valid evidence-bearing inspection for every canonical item and zero gaps.
- Enumeration and all source reads use one exact canonical platform commit.
- Evidence-bearing scheduled and manual runs use the protected platform commit; a dispatch override is dry-run-only.
- The controller verifies the commit and clean canonical paths before the run and after every partition.
- Partitions contain at most 50 items and inspection concurrency is capped at four.
- Manual dispatch defaults to `dry-run`; `subset` requires explicit stable item IDs.
- Non-dry inspection code comes from an administrator-controlled repository, exact commit, and safe relative module path.
- The workflow has `contents: read` permission and uploads evidence only for non-dry runs.

Configure these additional protected repository variables:

| Variable | Purpose |
|---|---|
| `ORCHARD_INSPECTOR_REPOSITORY` | Repository containing the operator's inspector adapter. |
| `ORCHARD_INSPECTOR_COMMIT` | Exact lowercase 40-character inspector commit. |
| `ORCHARD_INSPECTOR_MODULE` | Relative `.mjs` module exporting `inspect(item, context)`. |

A private inspector repository also needs the `ORCHARD_INSPECTOR_TOKEN` Actions secret with read-only access. Public repositories may use the workflow token fallback. Orchard validates the repository, commit, and module path before executing the adapter. Operator-specific models, credentials, and tenant configuration stay outside Orchard.

## Lifecycle after either track

Run evidence is not approval. A candidate or finding must proceed through these bindings:

1. Gate 1 records one explicit decision for one item and revision.
2. A linked tracker item is created and reconciled.
3. Qualified roles produce handoffs and one immutable artifact binding.
4. Gate 2 records one explicit decision for that exact artifact.
5. Publication creates a branch and pull request. Direct-main publication is forbidden.
6. Orchard records the exact protected-main acknowledgement after merge.
7. The owner explicitly accepts the closure packet and completion notes.
8. The tracker item may then move to Closed.

All mutation commands default to dry-run. External state is reconciled before every retry, and ambiguous or mismatched state fails closed.
