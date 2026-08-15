# ADR-0020: Instructor-led is a second rendering of one module, sharing one learner record

**Status:** Accepted.

## Decision

**1. Instructor-led is a rendering, never a parallel catalogue.** One content
item produces both the written module and the taught lesson. A correction
reaches both, because there is only one thing to correct.

**2. Both renderings carry the same knowledge check.** They teach the same
material, so they ask the same questions.

**3. The learner record is identical whichever rendering was used.** Progress is
recorded against the module, not against how it was consumed. This required no
change: the learning event contract already keys every command and event by path
and module and carries no field for rendering, delivery mode or format anywhere.
The behaviour was already correct.

**4. If a rendering is ever recorded, it is an annotation and never a key.** It
may not participate in completion, badge award, or path progress.

**5. Nothing is generated while a learner watches.** The instructor package is
produced and reviewed at publish time and served as a fixed package. **The
runtime is a media player, not an inference surface.**

## Why

The alternative produces two copies that drift, and the drift is invisible until
a learner is taught something the written version has already corrected.

Keying progress by rendering has a subtler failure: a learner who starts in one
rendering and finishes in the other either loses their progress or earns credit
twice, and both are wrong for the same reason. They completed one module.

Note that Orchard's own track terminology is unrelated to learner rendering.
Two tracks in [ADR-0022](0022-two-track-lifecycle.md) means two evidence
pipelines, not two ways of consuming content.
