# ADR-0025: Both gates are schema-bound issues with an exact command grammar

**Status:** Accepted.

> **Path convention used on this page.** Orchard's code does not live in this
> repository. Every file path written here is relative to the root of the
> **`project42dev/orchard`** repository unless it names a repository first
> (for example `project-42.dev/app/...`, which is relative to the
> `project42dev/project-42.dev` repository root). An unqualified `.mjs`
> script name such as `announce-gates.mjs` means
> `scripts/announce-gates.mjs`; every other unqualified name is relative to
> the Orchard repository root, or is named with its directory in the
> surrounding prose.

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

    > **Correction, 2026-08-15.** The builder had to override this. The
    > contract's `batch_digest` (`scripts/lib/gates.mjs`) hashes the run id along with
    > the batch, so keying idempotency on gate, run and batch digest as
    > written above would open a fresh issue every month for the same
    > unchanged held work, because the run id changes every run even when
    > nothing else does. `announce-gates.mjs` instead keys the issue marker on
    > `heldSetDigest` (`scripts/lib/gate-queue.mjs`), a hash of the sorted set of held
    > item ids, revisions and proposal or artifact digests, which does not
    > include the run id and so stays stable while the held set is stable.
    > The `batch_digest` field itself is still computed and persisted exactly
    > as this ADR describes; only the idempotency key that decides whether a
    > new issue is opened uses the different value. See
    > [`lifecycle-steps.md`](../lifecycle-steps.md), Step 5.
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
