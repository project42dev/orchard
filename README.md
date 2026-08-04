# Orchard

Orchard is a content lifecycle tool. It discovers what is missing from a
curriculum, drafts it, verifies it, keeps it current, retires it when it stops
earning its place, and drives the content database that holds the record.

It talks to language, image, and embedding models over the **OpenAI wire
format**. Any OpenAI-compatible endpoint works. Orchard does not require a
particular cloud, a particular vendor, or a particular set of models.

## What Orchard is not

Orchard **never provisions anything**. It consumes model endpoints that already
exist. It does not request a deployment, trigger one, edit a model registry, or
scale anything up. If a job needs a model that is not deployed, Orchard stops
and tells a human exactly which model is missing and which job wanted it.

That refusal is the feature. A silent fallback to a similar model would produce
content from an unintended model and hide the fact that an operator needed to
act.

Orchard also does not hold content. Content lives in the platform it drives.

## Where Orchard sits

```text
your product              content, the database, learner surfaces
     ^
     |  reads and writes the content database
     |
ORCHARD                   builds content, updates it, removes it
     ^
     |  CONSUMES deployed endpoints. Read only. No feedback path.
     |
your model endpoints      any OpenAI-compatible endpoint
```

The arrows only point up. Nothing below Orchard knows Orchard exists.

## Status

Early. The discovery half runs end to end today: it surveys a configured set of
market sources, measures what your own corpus already covers, proposes only
topics with both market demand and a real gap, merges proposals under rules that
never resurrect something you rejected, and scores the result so a human can rank
it. The scorer never filters and never gates. A person decides.

The authoring and currency halves are being assembled from an existing delivery
platform.

## The content database

Content lives in files. The database is compiled from them.

```bash
node scripts/build-content-db.mjs \
  --content <path-to-your-content-root> \
  --db      <path-for-content.db>
```

It uses `node:sqlite`, built into Node 22.5 and later, so there is nothing to
install. The same file works three ways: a local database for Orchard, a
Cloudflare D1 database at the edge, and a plain file for anyone self-hosting.

**Two halves, and the split is the whole design.** Derived tables (`item`,
`citation`, `source`, `candidate`) are dropped and rebuilt every time, so losing
the database costs nothing. Two tables are authoritative and survive every
rebuild: `work_item`, which carries what a human decided, and `rendering`, which
records what was actually produced. Neither can be reproduced from a checkout.

The test for which half a table belongs in: **if a git checkout can reproduce
it, it is derived. If it records a decision or an event, it is authoritative.**

A build **proposes** work and never resets it. `rejected` is terminal.

### The questions it exists to answer

| View | Question |
|---|---|
| `v_queue` | What is open, as one queue? `needs-creating` and `needs-updating` together, not two lists joined at read time. |
| `v_affected_by_source` | This source just changed. What has to be reviewed? |
| `v_stale` | What is past its own declared review cadence? |
| `v_stale_citation` | Same question, estate-wide, driven by citation dates and the source registry. |
| `v_unmeasurable` | **What can the staleness views not see?** |
| `v_render_manifest` | This avatar was withdrawn. What has to be re-rendered? |

`v_unmeasurable` exists because the first working build reported zero stale
items and looked healthy. It was measuring 84 of 150, because 66 items declared
neither field and dropped silently out of the count. **A low stale count is only
good news if everything was eligible to be counted**, so the build prints the
blind spot on every run and `needs-updating` reads both staleness signals.

## Design rules that are not negotiable

1. **Fail loudly.** A missing model, an unmapped job, or an unfilled required
   field stops the run. Orchard has no silent substitutions.
2. **Rank, never gate.** Scores order a human's reading. Nothing is auto
   promoted, auto archived, or auto decayed.
3. **A rejection is permanent.** Once a human rejects a candidate, no later run
   may propose it again.
4. **Measure the subject, not its proper nouns.** A probe that lists product
   names measures vocabulary, not coverage, and reports thriving material as a
   total gap. Product names also change, so probe every name a product has held.
5. **Nothing generates at read time.** Everything a reader consumes is produced
   at publish time and stored.

## Licence

Apache-2.0.
