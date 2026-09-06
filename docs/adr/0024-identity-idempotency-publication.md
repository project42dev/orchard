# ADR-0024: Immutable identity, idempotency, and publication as a transaction

**Status:** Accepted.

## Decision

1. **Identifiers are generated once and persisted before work starts**, using a
   time-ordered UUID scheme, for runs, items, events, handoffs and transactions.
2. **Semantic identity is computed and versioned**, from the normalized subject,
   target surface, canonical content id where one exists, intended outcome and
   scope. **Titles and filenames are not identity.**
3. **Repeated evidence attaches to the same item.** A material change to a
   proposal increments the item revision. A change of subject, outcome or target
   surface creates a successor item, linked to what it supersedes.
4. **Gate 1 approval binds to track, run, item, revision and proposal digest.
   Gate 2 approval binds additionally to the artifact, the displayed diff, the
   prepared tree, the canonical repository, the safe target path and the base
   commit. Any material change invalidates the approval.**
5. **A unique lifecycle key over track, item, revision and operation** makes
   every external write idempotent. External writes bind their own manifest or
   artifact digest too.
6. **Reconcile by immutable key before every create retry.** A replay of a
   completed operation returns the original result rather than performing it
   again.
7. **Leases are compare-and-set, with an owner, an expiry and a heartbeat.** Only
   one publication transaction may hold a given item and a given target path.
8. **Publication is a transaction with durable phases**: prepare, validate, open
   the pull request, merge, acknowledge, reconcile, roll back. Both intent and
   result are recorded.
9. **Publication goes through a branch and a pull request against protected
   main.** The transaction and the reconciled pull request carry the Gate 2
   digests, and equality with the reviewed record is enforced rather than
   assumed.
10. **Rollback before merge closes the pull request. Rollback after merge is a
    new reviewed corrective transaction.** Published history and gate evidence
    are never erased.

## Why titles are not identity

Titles get edited, and a rename would otherwise create a second item that
duplicates work already approved, or worse, silently detach an approval from the
thing it approved.

## Why the target path gets its own lease

Two items can each be entirely correct and still collide, because both want to
write the same file. Locking the item alone does not prevent that; the
collision is on the destination, so the destination is what has to be held.

## Why rollback after merge is not a revert

Erasing published history destroys the evidence trail that made the publication
reviewable. A correction that leaves no record of what was corrected is
indistinguishable from a correction that never happened.
