# Status

**Last reconciled 2026-08-15.**

This page exists because "built" is an ambiguous word, and using it loosely is
how a project ends up believing things about itself that are not true. Four
columns, and a claim only counts when all four are green.

| Column | Question it answers |
|---|---|
| **Designed** | Is the decision made and written down? |
| **In branch** | Does the code exist on the default branch? |
| **Connected** | Is it wired into a path that actually executes? |
| **Verified** | Has it been observed working on real input? |

## Headline

**Orchard is not running anywhere.** The reference deployment was built, ran,
and was torn down. On 2026-08-14 the solution was reset to a never-run state
ahead of its first full start-to-finish test.

**Nothing has ever completed the lifecycle end to end.** The publication and
rendering tables in the content database are both empty. That is the single
most useful fact on this page, and it is why several rows below stop short of
Verified.

## Where things stand

| Capability | Designed | In branch | Connected | Verified |
|---|---|---|---|---|
| Content database compiled from files | yes | yes | yes | yes |
| Model map with a refusal instead of a fallback | yes | yes | yes | yes |
| Six-role authoring ensemble | yes | yes | yes | partly, roles have run, not through a full lifecycle |
| Gate 1, holding work before any model is reached | yes | yes | yes | yes |
| Gate 2, binding publication to an artifact digest | yes | yes | yes | no |
| Currency track, inspecting the published corpus | yes | yes | yes | no |
| Discovery track, searching approved sources | yes | yes | **no, not deployed** | no |
| Request intake, a third way work enters | yes | yes | no | no |
| Publication through a protected-main pull request | yes | yes | no | no |
| Portable single-template deployment | yes | yes | yes | yes |

## What has to happen before the first real run

1. **Deploy the discovery track.** It is implemented but has never been
   deployed. It requires an approved source registry, which exists again: 60
   primary-tier sources carrying publisher, trust tier, review cadence and
   owner.
2. **Seed the canonical corpus** into the private storage the job reads. This is
   deliberately an operator action rather than a deployment step, so it will
   never happen as a side effect of deploying.
3. **Regenerate briefs from the queue.** The previous brief file was removed in
   the reset, along with every other artifact of the old runs.
4. **Be present for both gates.** Neither gate can be satisfied by a schedule,
   by design.

A real run spends real money and publishes real content. Both are the point,
and neither is reversible by pretending otherwise.

## What was deliberately removed on 2026-08-14

Orchard is being treated as a new deployment, so everything a previous run
produced was deleted rather than archived in place: the work queue, the
candidate list, the generated briefs, the evidence packets, the proposal
packets, the run records, and every machine-raised notification issue.

**Inputs were kept, outputs were not.** The approved source registry, the watch
list, the hand-written brief templates and the published corpus are things an
operator supplies or maintains. Everything a run emitted is gone.

Git history retains all of it, and a baseline snapshot of the database and the
work queue is preserved under `archive/` so the first test can be judged against
what came before rather than against nothing.

## Known defects

- **A missing source registry loads as zero sources, silently.** The database
  build returns an empty list rather than failing when its input file is absent,
  so a rebuild in that state produces a discovery track that searches nothing
  and correctly reports no gaps. The same applies to the corpus, which is
  mounted at runtime and is not in a checkout. Treat a rebuild outside the
  container with suspicion.
- **The content database is committed while also listed in `.gitignore`.** The
  file is tracked, so the ignore rule has no effect on it. The repository
  currently declares the database operator-local while shipping it, and that
  contradiction needs settling before the database becomes a published artifact.
