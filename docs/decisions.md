# Decisions behind Orchard

> **Status, 2026-08-15. Orchard is not running anywhere.**
> The reference deployment was built, run, and then torn down. On 2026-08-14
> the solution was reset to a never-run state ahead of its first full
> start-to-finish test: the work queue and the candidate list are empty, and
> every artifact of the previous runs has been removed. See
> [Status](status.md) for what is built, what is deployed, and what has been
> proven, kept honestly separate.

The full architecture decision records live in a private planning repository, by
deliberate decision: candid early analysis needs somewhere it can be candid, and
public repositories receive a **sanitized summary of accepted decisions that
contributors need**. This is that summary. It is written to stand on its own, so
nothing here links to a repository you cannot open.

Nothing here is a preference. Each one exists because the alternative failed, and
the failure is recorded with it.

> **Hosting.** The delivery pipeline runs as Azure Container Apps Jobs in the
> reference deployment, but **the container image is the portable artifact**.
> Any adopter can run it on any container platform against their own
> OpenAI-compatible endpoint. Orchard consumes an endpoint and never provisions
> one, which is what keeps that promise true rather than aspirational.

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

## Two tracks, and neither one waits for the other

Orchard runs **two independent evidence tracks**. Discovery looks outward at an
approved list of primary sources and asks what the world teaches that this
estate does not. Currency looks inward at the published corpus and asks what has
gone stale. They produce different evidence, they run on their own schedules,
and **neither blocks the other.**

**Why not one pipeline.** A single pipeline makes the slowest stage the speed of
everything, and it couples a failure in outward research to the ability to
notice that a published page has rotted. The two questions are genuinely
different and deserve to fail separately.

Both tracks converge on the same place: a work queue, and a human at Gate 1.

---

## Two gates, and the second one binds to bytes

**Gate 1 comes before any model is reached.** New work is held at
`gate1-pending`, and approval is the only route from there to a model. This is
the spend control and the editorial control at the same time: nothing is drafted
because a schedule fired.

**Gate 2 comes before anything is published**, and it binds the decision to an
exact artifact digest rather than to a title or an item id. An approval means
*these bytes*, not *this idea*. A denial goes into a rework loop rather than
ending the item.

**Why bind to a digest.** Approving a proposal and publishing something else is
the failure mode that makes review theatre, and it does not need bad intent to
happen. Regenerating between approval and publication is enough. The record of
each revision carries the run that produced it, the proposal digest, the
artifact digest, and the exact repository and path it is destined for, so the
question "is this the thing that was approved" has a mechanical answer.

---

## The state is a leased object, not a file on a machine

The working database is pulled from object storage at the start of a run,
mutated, and written back under a digest manifest. Concurrent runs are kept out
of each other's way by a **lease on a coordination object**, and there is a
separate backup container.

Leases are scoped deliberately narrowly: to a track run, to an item, and to a
**target path**. That last one matters because two different items can be
correct on their own and still collide by both wanting to write the same file.

**Why not keep state on the job.** A container job is disposable by design. Any
state that lives only on it is lost on the next run, and worse, two runs that
overlap silently diverge.

---

## The work tracker is a projection, never the source of truth

Work items are mirrored into a tracker so humans can see and schedule the work,
and each queue row carries the tracker id it maps to. **The queue is
authoritative; the tracker is a view of it.**

**Why one direction only.** Two systems that can both originate a state change
will disagree, and the disagreement surfaces at the worst moment. Closure is
evidence-backed: an item closes because something verifiable happened, not
because somebody dragged a card.

---

## Six roles, each with its own budget

Authoring is an ensemble, not a single model call: **researcher, drafter,
verifier, adversary, arbiter, finalizer**, run in that order. The researcher
gathers primary sources before any prose exists. The adversary exists to attack
the draft rather than to improve it. The arbiter decides.

**Token budgets are declared per role and never globally.** A researcher
gathering structured evidence and a drafter writing a module need different
ceilings, and one global number is either wasteful for the first or truncating
for the second. Truncation in an arbiter is particularly expensive, because it
looks like a decision.

Roles may be mapped across different vendors, which is deliberate: an adversary
sharing a model family with the drafter it is attacking is a weaker check.

---

## Detecting that a source moved, not that a page changed

Currency does not diff web pages. It works from the **approved source
registry**, where every source carries a publisher, a trust tier, a review
cadence and an owner, and it tracks change against a checkpoint so a run knows
what it has already seen.

Two signals feed staleness rather than one: the declared review cadence, and
citation dates measured against the source registry. That second signal exists
because the first goes blind on any surface missing a field, which is exactly
the defect recorded above.

---

## Instructor-led delivery is a rendering, not a separate track

An instructor-led version of a module is the **same content rendered
differently**, not a parallel body of work with its own lifecycle. Narration,
stage directions, captions and transcripts attach to the item; they do not fork
it.

**Why this matters practically.** The alternative produces two copies that drift,
and the drift is invisible until a learner is taught something the written
version has already corrected. The runtime that plays it is a media player, not
an inference surface: no model is called at learn time.

---

## One deployment, and nothing about the deployer inside it

The whole reference deployment is a **single template**, and it carries **no
deployer-specific values at all**. Resource names derive from the deployment
scope rather than being typed in, storage is private unconditionally with no
bootstrap window that opens it, and things that identify one organisation, such
as a cost centre, are required parameters with no defaults rather than
convenient constants.

**Why required with no default.** A default that happens to be someone's real
cost centre is worse than a missing value, because it deploys successfully and
bills the wrong owner quietly.

Monitoring is part of the same template rather than a second one. Splitting them
means a deployment can succeed while its alerting does not exist, and nobody
finds out until the thing that needed alerting happens.

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
