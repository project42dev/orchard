# Decisions behind Orchard

> **What actually runs, verified 2026-08-14.**
> The engine runs monthly (the 1st, 06:00 UTC) as an Azure Container Apps
> job and holds new work at Gate 1 until the owner approves; only approved
> work reaches a model. Gate 2 binds approval to the exact item and artifact
> digest, with a denial-rework loop. Still designed and not built: gate
> manifests and batching, revision binding, `defer`, PR-transaction
> publication, wired live verification, and every currency-track step past
> inspection.

The full architecture decision records live in a private planning repository, by
deliberate decision: candid early analysis needs somewhere it can be candid, and
public repositories receive a **sanitized summary of accepted decisions that
contributors need**. This is that summary.

Nothing here is a preference. Each one exists because the alternative failed, and
the failure is recorded with it.

> **Hosting note (2026-08-11):** The delivery pipeline runs as Azure Container
> Apps Jobs in the reference deployment. The container image is the portable
> artifact — any adopter can run it on any container platform against their own
> OpenAI-compatible endpoint. See [ADR-0007](https://github.com/project42dev/project42dev-ops/blob/main/docs/adrs/0007-foundry-delivery-platform-boundary.md)
> for the hosting decision.

---

## Orchard is a separate repository, and the model layer is read only

Orchard consumes model endpoints. It never provisions one, never requests a
deployment, never triggers one, and never edits a model registry. The dependency
arrows only point one way, and nothing below Orchard knows Orchard exists.

**Orchard requires an OpenAI-compatible endpoint, never a particular cloud.**
Coupling it to one would force every adopter onto that vendor.

**Why a separate repository rather than a directory.** The alternative was
cheaper day to day and lost on one argument: an adopter has to be able to clone
the tool without taking a whole platform with it, and the install guide has to
describe connecting it to *their* endpoint. Both are far easier to trust when the
boundary is physical.

That was not a hypothetical concern. Two codebases were in the wrong
repositories when this was written, and both got there through a directory
convention nobody enforced.

---

## One model map, and a refusal instead of a fallback

Which model does which job lives in one file, with the reason for every
assignment, so a model change is a reviewable diff rather than a behaviour change
nobody sees.

**When a mapped model is not deployed, Orchard refuses to start** and names the
model and the job that wanted it.

**Why not fall back to a similar model.** Content would be produced by a model
nobody chose, output quality would drift, and the one signal saying an operator
needed to act would be swallowed. In the three days before this was written,
five separate defects were **silent successes**: every one exited zero and looked
healthy. This was the place not to add a sixth.

Three rules follow, each because getting it wrong is expensive and quiet:

- **The token parameter dialect is declared per model, never inferred.** Two
  deployed models contradicted each other outright: one rejects `max_tokens` with
  HTTP 400, the other rejects `max_completion_tokens` with HTTP 422. No single
  global setting serves both, so a missing dialect is a validation failure rather
  than a default.
- **Voice is validated by name only.** Speech voices have no deployment,
  capacity, or quota row, so looking for one in the deployment list would fail
  every startup. A voice that emits no word-boundary events is rejected outright,
  because captions and lip sync cannot align to it.
- **Actor-licensed avatars are rejected.** Access to them ends when the actor's
  contract does. A content library fronted by one breaks on a date you do not
  control, so the database records which avatar rendered each item and a
  withdrawal produces a re-render list rather than a hunt.

---

## The content database is compiled, with a small authoritative core

**Content files are the source of truth. The database is derived from them.**

- **Derived and rebuilt every time:** items, citations, sources, candidates.
  Losing the database costs nothing and derived schema changes need no migration.
- **Authoritative and never dropped:** the work queue, which carries what a human
  decided, and the render log, which records what was actually produced.

The test for which half a table belongs in: **if a checkout can reproduce it, it
is derived; if it records a decision or an event, it is authoritative.**

A build **proposes** work and never resets it. `rejected` is terminal, for the
same reason a rejected discovery candidate is never re-proposed: a decision a
machine can undo is not a decision.

**Why not a database as the source of truth.** It wins on query performance and
loses on everything that makes content trustworthy. A row change is not
reviewable, every schema change becomes a migration against live data, and an
adopter has to provision a server before asking a single question.

**Why SQLite specifically.** It is built into Node, so there is nothing to
install and nothing to run. The same file works as a local database, an edge
database, and a self-hosted one.

### The defect that shaped it

The first working build reported **zero stale items** and looked healthy. It was
measuring 84 of 150. Two thirds of one surface declared neither a verification
date nor a review cadence, so those items could not be stale by that definition
and dropped silently out of the count.

Three things followed, and they are part of the design rather than a patch:

1. A view that **names every item the staleness check cannot see**, with the
   reason. A low stale count is only good news if everything was eligible to be
   counted.
2. A **second staleness signal** driven by citation dates and the source
   registry, which does not go blind on a surface missing a field. The work queue
   reads both.
3. The build **prints the blind spot on every run.**

---

## The rule underneath all of them

**A check that silently measures the wrong thing is worse than no check**, because
it returns a confident answer and is believed.

Six instances in three days, every one exiting zero: a probe that measured product
names instead of a subject and reported a nine-module curriculum as a total gap; a
probe whose generic term matched 134 unrelated software adapters and reported a
real gap as covered; a command-line flag that defaulted to `NaN` so every
comparison was false; a platform-specific entry-point guard that never ran `main`;
a link check that fetched URL prefixes as though they were pages; and the
staleness count above.

The habits that come out of it are in the probe design rules, the fail-loud
validator, and the blind-spot reporting, and they are the parts of this project
worth copying even if none of the rest of it is useful to you.
