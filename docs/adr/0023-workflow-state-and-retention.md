# ADR-0023: Authoritative workflow state in SQLite, events append only

**Status:** Accepted.

## Decision

1. **SQLite is the authoritative portable workflow store**, running with foreign
   keys, write-ahead logging, checksums, and explicit schema versions.
2. **Derived content and source indexes stay rebuildable from pinned inputs, and
   a rebuild can never reset authoritative state.** This is the guarantee that
   makes [ADR-0019](0019-content-database.md) safe.
3. **Authoritative data** is runs, items, revisions, append-only events,
   decisions, claims, leases, external bindings, handoff indexes, publication
   transactions, migration history, and backup records.
4. **Events are append only.** Corrections and state changes add events. They do
   not rewrite history.
5. **An atomic online backup is taken after every external transition** and at
   least daily while idle, and copied to a separate failure domain.
6. **Recovery objectives are declared, and restore is tested on a schedule.** An
   untested backup is a belief, not a control.
7. **Migrations require a pre-migration backup, a rehearsal on a copy, forward
   and rollback tests, and post-migration integrity checks.** A failed migration
   stops both tracks rather than continuing on a half-migrated store.
8. **Retention is set per data class, not globally.** Bounded source excerpts
   are kept briefly, prompts and model outputs longer, run records longer again,
   and workflow decisions, publication evidence and financial records longest.
   Legal holds override deletion.
9. **No learner data, secrets, tokens, tenant identifiers or subscription
   identifiers belong in the store.**

## Why append-only events

The store has to answer "who decided what, when, and on what evidence" long
after the fact, and it has to answer it in a way that survives someone
disagreeing with the answer. A store where a state change overwrites its
predecessor cannot distinguish a correction from a cover-up, and the difference
matters precisely when it is being questioned.

## Why retention differs by class

A prompt is useful while diagnosing a run and a liability indefinitely. A
publication decision is the opposite: its value is entirely in being available
years later. One retention period for both is wrong in one direction or the
other, so there is no single right number.

Decision 9 is a hard boundary, not a preference. The store travels: it is backed
up, copied between failure domains, and handed to whoever operates the
deployment.
