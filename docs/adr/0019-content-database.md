# ADR-0019: The content database is a derived index with a small authoritative core

**Status:** Accepted.

## Decision

**Content files remain the source of truth. The database is compiled from them,
and holds a small authoritative core that exists nowhere else.**

**1. Derived tables are dropped and rebuilt on every build:** items, citations,
sources, candidates, tags, providers. Deleting the database costs nothing,
because a checkout reproduces it in seconds, and a derived schema change needs
no migration.

**2. Two tables are authoritative and survive every rebuild:** the work queue,
which carries what a human decided about a piece of work, and the render log,
which records what was actually produced. Neither is reproducible from a
checkout.

The test for which half a table belongs in: **if a checkout can reproduce it, it
is derived; if it records a decision or an event, it is authoritative.**

**3. A build proposes work and never resets it.** An open candidate becomes a
`needs-creating` row and a stale item becomes a `needs-updating` row, both
inserted only when absent. An existing row keeps its state, owner and note
whatever the build thinks, and **`rejected` is terminal**, for the same reason a
rejected discovery candidate is never re-proposed: a decision a machine can undo
is not a decision.

**4. SQLite, through the runtime's built-in driver.** Nothing to install and
nothing to run. The same artifact serves as a local file, an edge database, and
a plain file for an adopter self-hosting.

**5. Staleness must never go quiet on content it cannot see.**

## The defect that shaped decision 5

The first working build reported **zero stale items** and looked healthy. It was
measuring 84 of 150. Two thirds of one surface declared neither a verification
date nor a review cadence, so those items could not be stale by that definition
and dropped silently out of the count.

Three things followed, and they are part of the design rather than a patch:

1. A view that **names every item the staleness check cannot see**, with the
   reason. A low stale count is only good news if everything was eligible to be
   counted.
2. A **second staleness signal** driven by citation dates and the source
   registry, which does not go blind on a surface missing a field.
3. The build **prints the blind spot on every run.**

## Why not a database as the source of truth

It wins on query performance and loses on everything that makes content
trustworthy. A row change is not reviewable, every schema change becomes a
migration against live data, and an adopter has to provision a server before
asking a single question.
