# ADR-0025: Both gates are schema-bound issues with an exact command grammar

**Status:** Accepted.

## Decision

1. **Gate 1 and Gate 2 use separate schemas and separate labels.** They ask
   different questions and must not be satisfiable by each other's evidence.
2. **Items are sorted by immutable id and batched**, every item appearing
   exactly once, with the final batch allowed to be smaller.
3. **Every issue binds** the gate, schema version, track, run, batch ordinal and
   count, total item count, full manifest digest, batch digest, target, item
   revision, artifact or proposal digest, and decision state.
4. **Only exact commands have effect:**

   ```
   /orchard gate1 <approve|deny|defer|request-changes> item=<uuid> revision=<n> digest=<sha256> [reason="..."]
   /orchard gate2 <approve|deny|defer|request-changes> item=<uuid> revision=<n> digest=<sha256> [reason="..."]
   ```

5. **Denial, deferral and change requests require a reason.** A deferral also
   requires a review date, so that deferring is not a quiet way of dropping
   something.
6. **Authorization is by an immutable numeric user id allowlist.** Usernames are
   display data and are not authoritative. Rotating the allowlist is a reviewed
   configuration change with add, verify and remove steps.
7. **Nothing else counts.** General approval text, reactions, labels, issue
   authorship, quoted commands, bot text, and commands missing a required field
   have no state effect whatsoever.
8. **Decision events are append only.** Gate 1 decisions map only out of
   `gate1-pending` and Gate 2 decisions only out of `gate2-pending`. Editing or
   deleting a comment triggers reconciliation but does not erase the captured
   event; a correction supersedes through a new authorized event.
9. **Issue creation is idempotent**, keyed on gate, run and batch digest, and a
   timeout is reconciled before any retry.
10. **Gate 2 carries the finished artifact, the readable diff and its digest,
    the prepared-tree digest, tests, factual and accessibility review, the
    handoff chain, cost, tracker links, the allowlisted repository, the safe
    target path and the base commit.** Approval requires every test and both
    reviews to have passed.

## Why an exact grammar rather than natural language

"Looks good to me" is not a decision anyone can reconstruct six months later,
and it cannot be bound to a revision or a digest. Requiring the item, the
revision and the digest in the command means the approval names exactly what was
approved, and an approval issued against a superseded revision is detectable
rather than plausible.

Rule 7 is deliberately unforgiving. A gate where an emoji might count is a gate
whose state nobody can predict, and a reviewer who believes a thumbs-up
approved something has been actively misled.

## Why numeric ids rather than usernames

A username can be changed and can be released and re-registered by somebody
else. The numeric id cannot. An allowlist keyed on the mutable one is an
authorization control with a rename-shaped hole in it.
