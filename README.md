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

## The model map

Which model does which job lives in one file, [`config/model-map.json`](config/model-map.json),
and every assignment carries the reason it was made. A model change is then a
reviewable diff rather than a behaviour change nobody sees.

```bash
node scripts/validate-model-map.mjs --inventory <your-deployed-model-registry.json>
```

**It refuses to start when a mapped model is not deployed**, and names the model
and the job that wanted it:

```text
REFUSING TO START. 1 problem(s):

  [model-not-deployed] job "code-samples" is mapped to "kimi-k2-9-code", which is not in the deployed set
      fix: deploy kimi-k2-9-code in your model registry, or remap the job.
           Orchard will not substitute a similar model.
```

There is no nearest-match fallback. Orchard consumes endpoints and never
provisions, so a missing model is a human action somewhere else, and a
substitution would swallow the only signal that says so.

Three things the validator also enforces, each because getting it wrong is
expensive and silent:

- **The token parameter dialect is declared per model, never inferred.** Two
  models in the estate this was built against contradict each other: one rejects
  `max_tokens` with HTTP 400, the other rejects `max_completion_tokens` with
  HTTP 422. A missing dialect is a failure, not a default.
- **Voice is validated by name only.** Speech voices have no deployment,
  capacity, or quota row, so looking for them in the deployment list would fail
  every startup. A voice that emits no word-boundary events is rejected, because
  captions and lip sync cannot align to it.
- **Actor-licensed avatars are rejected.** Access to them ends when the actor's
  contract does, and a library fronted by one breaks on a date you do not
  control.

**Adopters:** the shipped map names one operator's models. Point the validator at
your own inventory and it will tell you, job by job, exactly what you need.

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

## Documentation

| Document | What it covers |
|---|---|
| [docs/install.md](docs/install.md) | Connect Orchard to your own models. Start here. |
| [docs/lifecycle.md](docs/lifecycle.md) | The whole content lifecycle, discovery through retirement. |
| [docs/decisions.md](docs/decisions.md) | Why it works the way it does, and what failed first. |
| [REPO-BOUNDARY.md](REPO-BOUNDARY.md) | What belongs here and what does not. |

## Licence

Apache-2.0.
