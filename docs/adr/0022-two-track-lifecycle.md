# ADR-0022: Two independent tracks, one shared two-gate lifecycle

**Status:** Accepted. Amended by owner decision to change both track cadences.

## Decision

1. **Track 1 performs new-content discovery. Track 2 performs existing-content
   maintenance.**
2. **Each track has an independent schedule and its own manual trigger. Neither
   starts the other.** Cadence is an operator choice; the tracks alternate
   rather than compete.
3. **A run belongs to exactly one track.** Full runs within a track serialize.
   Subset runs and dry runs are diagnostic and **never satisfy scheduled
   coverage**, which stops a cheap partial run from being mistaken for the real
   thing.
4. **Completion is defined by counters that must agree, not by exiting zero.** A
   completed discovery run attempts every approved enabled source and accounts
   for every named outcome and exception. A completed currency run must satisfy
   `expected = enumerated = inspected` across a pinned corpus in deterministic
   partitions, with zero gaps. Schema validation enforces the fields and
   thresholds; implementation validation enforces the counter equality.
5. **Both tracks pass Gate 1 before any tracker item or agent work exists, and
   Gate 2 before any exact artifact is published.**
6. **Decisions are independent per item.** Pending, denied, deferred, changed or
   unauthorized items do not advance, and one item's state never carries
   another's.
7. **Gate issues batch after sorting by immutable item id**, and every batch
   binds to the full run manifest, so a batch cannot silently omit items.
8. **Content files remain canonical.** Orchard proposes and coordinates. It does
   not become a content source.

## Why two tracks

A single pipeline makes the slowest stage the speed of everything, and couples a
failure in outward research to the ability to notice that a published page has
rotted. The two questions are genuinely different: what should exist, and what
has stopped being true. They deserve to fail separately.

## Why counter equality rather than success

`expected = enumerated = inspected` exists because a run that inspects half the
corpus and reports no problems is indistinguishable from a run that inspects all
of it and finds none, unless the counts are compared. That distinction is the
entire value of the check.

Related: [ADR-0025](0025-gates-as-schema-bound-issues.md) for the gates
themselves, [ADR-0028](0028-portable-deployment.md) for how the tracks run.
