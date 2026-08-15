# ADR-0026: Approved items map to evidence-bound tracker work

**Status:** Accepted.

## Decision

1. **One Feature per track**, holding that track's work.
2. **One Gate 1 approved item maps to one primary Story** under its track's
   Feature. Tasks are created only for independently assignable agent,
   validation or publication work, not as decoration.
3. **A unique external key of the form `orchard:<track>:<item>:r<revision>`**
   joins the two systems. Query before create, and stop on a mismatch rather
   than creating a duplicate.
4. **Links are stored in both directions:** the originating run, the Gate 1
   issue and decision event, the actual tracker id, the item revision and
   digest, the target repository and path, and later the Gate 2 and publication
   evidence. Agent handoffs carry both the external key and the real tracker id.
5. **Before Gate 1 approval there is no tracker item at all.** Approved creation
   starts New, execution moves to Active, successful publication with complete
   evidence moves to Resolved, and **only explicit owner acceptance moves
   anything to Closed.**
6. **A Gate 1 denial or deferral creates nothing.** A Gate 2 denial, deferral or
   change request leaves the Story active with an attributed history note. **It
   is never auto-closed.**
7. **Replacement and removal are classifications, not deletions.** Removal
   requires redirect, catalogue, dependency, stable URL, learner record,
   rendering, history and rollback evidence before it is allowed.
8. **A closure note must carry** both gate events, the run and handoff chain,
   tests, accessibility and factual review, target path, pull request, resulting
   commit, acknowledgement, publication transaction, residual risk and rollback
   reference.
9. **Automation may prepare a closure packet. It may not close work.**

## Why the tracker is downstream

Two systems that can both originate a state change will disagree, and they will
disagree at the worst possible moment: when someone is trying to establish what
was actually approved. The queue is authoritative and the tracker is a view of
it, so there is always an answer.

## Why nothing exists before Gate 1

A tracker full of items nobody approved is indistinguishable from a backlog,
and it invites work to start on things that were never agreed. Creating the item
on approval means the board only ever shows work that passed a human.

## Why automation cannot close

Closure is the assertion that something is genuinely finished and accepted. It
is the one judgement in this system that has no mechanical test, which is
exactly why it is reserved for a person.
