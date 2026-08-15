# Pre-test baseline, 2026-08-14

This is the state of Orchard immediately before the first full start to finish
test of the discovery and currency tracks. It exists so the test can be judged
against something. Nothing here is an input to a run. It is the expected
result.

## Why a baseline and not a reset

The 31 queued work items were real, un-started work first seen
2026-08-09. Feeding them back into discovery would assume the answer. The
question the test has to settle is whether the process finds them again on its
own, so they are archived here and the registry is returned to its clean
starter state.

## What is in this directory

| File | What it is |
|---|---|
| `content-baseline.db` | Byte copy of `content.db` as of 2026-08-14. Named to avoid the bare `content.db` gitignore pattern, which matches at any depth. |
| `work-items.json` | The 31 work items, all in state `queued`, each carrying its `ado_id` (AB#7227 to AB#7257). |
| `candidates.json` | The 39 candidate rows: 31 at status `candidate`, 8 `retired`. |
| `source-registry.json` | The 60 approved sources, recovered from the database. |
| `briefs-queue.json` | The 27 briefs generated 2026-08-08. Stale: they name the retired model deployments. |
| `table-counts.json` | Row counts for every table, so a later rebuild can be compared without opening the database. |

## The pass condition

A discovery run from the clean starter should reproduce the archived work
items, plus whatever is genuinely new since 2026-08-09. Reproduction is the
floor, not the ceiling.

Two rows to watch: `publication` and `rendering` are both **0** in this
baseline. Nothing has ever completed the lifecycle end to end. A test that
leaves them at zero has not proven publication.

## Three things that will interfere, recorded here so they are not rediscovered

1. **Discovery deduplicates against the whole registry.**
   `merge-opportunity-proposals.mjs` never changes the status of an id it has
   seen, and only a human retires a topic. Run against a registry that already
   holds these ids and every finding files as refreshed rather than added. That
   is correct behaviour and it is also an uninformative test, which is why the
   registry goes back to the starter first.
2. **The source registry file was missing.** `build-content-db.mjs` reads
   `content/source-registry.json`, and `loadSources` returns an empty array
   when the file is absent, with no error. A rebuild in that state zeroes the
   sources and reports success. The file has now been restored from the
   database, which was the only surviving copy.
3. **Work items created by a fresh run carry no `ado_id`.** The board already
   holds 31 orphaned stubs from the previous run. Synchronising before those
   are closed produces a second set, 62 in total.
