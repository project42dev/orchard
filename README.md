# Orchard

> **What actually runs, verified 2026-08-14.**
> The engine runs monthly (the 1st, 06:00 UTC) as an Azure Container Apps
> job: discovery, scoring, database build, Gate 1, brief generation,
> delivery, ingest, and notification. New work holds at Gate 1 until the
> owner approves; only approved work reaches a model. Gate 2 binds approval
> to the exact item and artifact digest, with a denial-rework loop. The
> currency track runs monthly (the 15th) and records findings.
> Still designed and not built: gate manifests and batching, revision
> binding, `defer`, PR-transaction publication, wired live verification,
> and every currency-track step past inspection.

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

**Corrected 2026-08-14.** The item gates are built and live. Gate 1 runs
inside the deployed engine: new work enters `gate1-pending` and only an
owner approval reaches a model. Gate 2 acts on `/orchard gate2` commands
bound to the exact item and artifact digest; editing a proposal invalidates
every approval written before the edit, and a denial re-queues the item with
the reviewer's reason for rework. Live verification code exists but nothing
invokes it yet, and publication is still a direct commit rather than the
designed pull-request transaction.

Status is tracked on four columns, because one axis produced contradictions:
designed, in branch, connected, verified in production. **A capability is
"implemented" only with all four.**

- **Track 1** performs bounded discovery against a versioned approved-source
   registry. A completed full run requires at least 50 distinct approved and
   enabled sources and at least 50 attempts.
- **Track 2** inspects every canonical item at one exact content commit. A
   completed full run requires 100 percent inspection, exact reconciliation, and
   zero gaps.
- **Delivery** requires an item-bound first approval, linked tracker work,
   qualified role handoffs, immutable artifact binding, a second approval, a
   protected-main pull request, protected-main acknowledgement, and explicit
   owner acceptance before tracker closure.
- **Request intake**, designed and not built, is a third way a topic reaches
   the queue: a labeled GitHub issue, submitted through a form or written by
   hand. It joins the same queue as a discovered candidate and passes through
   the same Gate 1 approval; nothing about it skips a gate.

The monthly tracks are independent, discovery on the 1st and currency on the
15th. Manual runs default to dry-run. Neither track treats generated evidence
as approval or publication.

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
the database costs nothing. Three legacy tables are authoritative and survive every
rebuild: `work_item`, which carries what a human decided, `rendering`, which
records what was actually produced, and `publication`, which records which
ensemble run wrote a published item and who accepted it. None of the three can be
reproduced from a checkout.

The lifecycle state store adds the exact run, decision, handoff, artifact,
publication-transaction, acknowledgement, and closure evidence needed for safe
replay and external reconciliation.

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
| `v_provenance` | Which run wrote this item, under which brief, and who accepted it? |
| `v_unprovenanced` | **What published content has no provenance at all?** |

`v_unmeasurable` exists because the first working build reported zero stale
items and looked healthy. It was measuring 84 of 150, because 66 items declared
neither field and dropped silently out of the count. **A low stale count is only
good news if everything was eligible to be counted**, so the build prints the
blind spot on every run and `needs-updating` reads both staleness signals.

## The loop, and the rule that keeps it closed

The queue drives the briefs, the briefs drive the ensemble, and the ensemble's
verdict comes back to the queue.

```bash
node scripts/generate-briefs.mjs --db content.db --inventory <models.json> --out briefs/queue-backlog.json
# ... a delivery run happens, and writes run records ...
node scripts/ingest-proposals.mjs   --db content.db --run-records <dir> --apply
# ... a trust administrator provisions the exact publication adapter once ...
node scripts/provision-trust-anchor.mjs --db content.db --input <publication-anchor.json>
# ... record Gate 2 for the exact immutable artifact ...
node scripts/publish-approved-item.mjs --input <gate2-reference.json> --apply --db content.db
# ... after the pull request merges to protected main ...
node scripts/record-publication.mjs --apply --db content.db --key <publication-idempotency-key>
```

**A brief must carry the subject id of the queue item it serves.** The delivery
platform names its proposal after the brief, and that filename is the entire
channel back. So the generator encodes the subject id in the brief id and refuses
to emit one that would not survive the trip. Without that rule the ensemble runs,
spends money, and its verdict cannot be attached to anything.

Two behaviours nothing here will ever have: **it never publishes without both
item-bound human gates and protected-main acknowledgement**, and **it never
overrides a person**, because a recorded rejection remains authoritative.

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
| [docs/workflow-orchestration.md](docs/workflow-orchestration.md) | Independent monthly and manual tracks, configuration pins, and retired workflow audit. |
| [docs/decisions.md](docs/decisions.md) | Why it works the way it does, and what failed first. |
| [REPO-BOUNDARY.md](REPO-BOUNDARY.md) | What belongs here and what does not. |

## Licence

Apache-2.0.
