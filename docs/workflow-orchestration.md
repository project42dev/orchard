# Two-track workflow orchestration

> **What actually runs, verified 2026-08-13.**
> The discovery engine performs discovery, scoring, database build, brief
> generation, delivery, ingest, and ends by **opening a GitHub issue**. It has
> a manual trigger and no schedule. The currency track runs monthly and
> records findings.
>
> **Approvals ARE read, by a mechanism the design forbids** (see below). Item-level gates, work-item
> binding, the publication transaction and live verification are designed and
> not built. Treat any lifecycle described below as **intended** behaviour
> unless it is explicitly marked as running.

Orchard runs discovery and canonical-corpus inspection as independent evidence-producing workflows. Neither workflow approves content, creates or closes tracker work, publishes content, or mutates a target repository.

## Workflow boundary audit

> **Scope correction, 2026-08-14. "Removed" below means removed ON THIS BRANCH.**
>
> All four legacy workflows are **still present and active on `main`**, which is
> what runs today. In particular **Orchard Human Review is live on `main`**: it
> triggers on `issue_comment`, has no disable guard, acts on a bare `Approved`
> comment with no item, revision or digest binding, and commits to the content
> platform. The defects listed for it in the table below are **current
> production behaviour, not history.**
>
> Merging this branch removes that workflow. Nothing replaces it until the
> item-bound gate CLI is wired to a trigger, so **merging without that wiring
> leaves no approval path at all.** Sequence the two together.

| Legacy workflow | Trigger and authority problem | External writes | Disposition |
|---|---|---|---|
| Orchard Engine | Disabled body combined discovery, model execution, tracker synchronization, and notifications. It depended on one Azure deployment and broad identity permissions. | Issues, Azure token acquisition, tracker updates, and delivery artifacts. | Removed. Track 1 now performs bounded read-only discovery only. Operator-specific delivery remains outside this public repository. |
| Orchard Maintenance | Disabled body combined source checks, model execution, tracker synchronization, and notifications. It depended on private runtime configuration. | Issues, Azure token acquisition, tracker updates, and delivery artifacts. | Removed. Track 2 now performs complete inspection against one exact corpus commit. |
| Orchard Human Review | Any matching issue comment could infer multiple subjects from mutable issue text. Approval recorded publication before verified publication, pushed directly, suppressed tracker errors, and closed the issue without protected-main acknowledgement or owner acceptance. | Direct repository pushes, issue mutation, database mutation, and tracker mutation. | Removed. Decisions use the item-bound gate CLI. Publication uses a protected-main pull request and exact acknowledgement. Closure requires owner acceptance. |
| Orchard Decommission | A disabled manual body interpolated untrusted inputs into scripts, edited the database directly, and pushed directly to main. | Direct content deletion, redirect mutation, direct push, and issue creation. | Removed. Retirement must enter the same item-bound two-gate lifecycle before a purpose-built replacement is enabled. |

## Track 1

[../.github/workflows/track-1-discovery.yml](../.github/workflows/track-1-discovery.yml) runs every Monday at 06:00 UTC and supports manual dispatch.

- A scheduled run is always `full`.
- A completed full run requires at least 50 distinct approved and enabled sources and at least 50 attempts.
- The source registry comes from an exact canonical platform commit.
- Evidence-bearing scheduled and manual runs use the protected platform commit and normalized registry `sha256` digest.
- Dispatch callers may override those pins only in `dry-run`; caller-selected pins cannot produce evidence.
- Manual dispatch defaults to `dry-run`; `subset` requires explicit source IDs.
- Fetches are HTTPS-only, bounded by time and bytes, and may redirect only to registry-approved hosts.
- Hostnames must resolve only to public addresses, and the validated addresses are pinned into each TLS connection. Bodies are capped while streaming.
- The workflow has `contents: read` permission and uploads evidence only for non-dry runs.

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
| `ORCHARD_PLATFORM_REPOSITORY` | Canonical corpus repository. Defaults to `project42dev/project42-platform`. |
| `ORCHARD_PLATFORM_COMMIT` | Exact lowercase 40-character commit used by scheduled runs. |
| `ORCHARD_SOURCE_REGISTRY_DIGEST` | Exact normalized digest of `content/source-registry.json`. |

Calculate the digest from the same exact platform checkout that supplies the
registry:

```text
npm run digest:source-registry -- ../project42-platform/content/source-registry.json
```

## Track 2

[../.github/workflows/track-2-corpus-inspection.yml](../.github/workflows/track-2-corpus-inspection.yml) runs every Monday at 12:00 UTC and supports manual dispatch.

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
