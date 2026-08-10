# Connect Orchard to your own models

Orchard needs one thing from you: **an OpenAI-compatible endpoint** and the model
ids behind it. It does not care whose cloud that is, and it will never create
anything in it.

This guide is written for someone who is not the author, has no access to the
author's accounts, and wants Orchard running against their own estate.

## Before you start

- **Node 22.5 or later.** The content database uses `node:sqlite`, which is built
  in. There is nothing to `npm install`.
- **Node 24 requires `--experimental-sqlite`.** `node:sqlite` is still
  experimental on Node 24. Add `--experimental-sqlite` to every `node` command
  below, or set the `NODE_OPTIONS` env var:
  ```bash
  export NODE_OPTIONS="--experimental-sqlite"
  ```
- **An endpoint that speaks the OpenAI wire format**, and a key or token for it.
  Azure AI Foundry, OpenAI, a self-hosted vLLM or Ollama server, or anything else
  that accepts `/chat/completions` will do.
- **Somewhere to put a model inventory.** A small JSON file listing what you have
  deployed. Format below.

You do **not** need the author's Foundry, the author's cloud, or any account you
do not already own.

## Deploying the delivery pipeline

The delivery pipeline (`delivery/Invoke-Project42Delivery.ps1`) runs in a
container. The reference deployment uses **Azure Container Apps Jobs**, but the
container image is portable — it runs on any container platform:

- **Azure Container Apps Jobs** (reference deployment — Bicep in `project42dev-ops/deployment/infra/`)
- **AKS CronJobs** (Kubernetes `CronJob` with the same image)
- **Docker Compose** (one-off `docker compose run`)
- **Any Kubernetes distribution** (Deployment or CronJob)

The image is `mcr.microsoft.com/powershell:7.5-ubuntu-22.04` plus three
PowerShell modules. See the [delivery platform README](https://github.com/project42dev/project42dev-ops/blob/main/deployment/infra/README.md)
for the full environment contract (19 variables, two storage mounts, managed
identity).

## 1. Describe what you have deployed

Orchard validates its model map against a list of what actually exists. Write
that list as JSON. Either shape works:

```json
[
  { "id": "my-drafting-model",  "status": "deployed" },
  { "id": "my-reviewer-model",  "status": "deployed" },
  { "id": "my-embedding-model", "status": "deployed" }
]
```

or, if you prefer a wrapper:

```json
{ "models": [ { "id": "my-drafting-model", "status": "deployed" } ] }
```

Only `id` and `status` are read. Anything else you keep in the file is yours.
`status` must be exactly `deployed` for a model Orchard is allowed to use;
anything else is treated as not ready and will be refused with the reason.

Point Orchard at it:

```bash
export MODEL_INVENTORY_PATH=/path/to/your/model-inventory.json
```

## 2. Map your models to jobs

Edit [`config/model-map.json`](../config/model-map.json). It ships with the
author's model ids, which will mean nothing on your estate. Replace them.

Every job needs three things:

```json
"drafting": {
  "model":   "my-drafting-model",
  "dialect": "max_completion_tokens",
  "why":     "widest context window of anything I have deployed"
}
```

**`dialect` is required and is not guessed.** It is the name of the token-limit
parameter your model accepts. Get it wrong and you get an HTTP error at the worst
possible moment, and models genuinely disagree: on the estate this was built
against, one family rejects `max_tokens` with a 400 and another rejects
`max_completion_tokens` with a 422. Use `n/a` for image and embedding jobs, which
take neither.

**`why` is required too.** Not for the machine. For whoever reads this file in a
year and needs to tell an intentional choice from an accident.

## 3. Check it before you run anything

```bash
node scripts/validate-model-map.mjs
```

On a fresh clone against your own inventory, expect it to fail, and expect the
failure to be useful:

```text
REFUSING TO START. 3 problem(s):

  [model-not-deployed] job "drafting" is mapped to "gpt-5-6-sol", which is not in the deployed set
      fix: deploy gpt-5-6-sol in your model registry, or remap the job.
           Orchard will not substitute a similar model.
```

**That list is your to-do list.** Work through it until you get:

```text
OK. 13 job(s) mapped, every model deployed, every dialect declared.
```

Orchard will not start against an incomplete map, and will never quietly use a
different model than the one you named. A substitution would produce content from
a model you did not choose and hide the fact that something needed your
attention.

## 4. Build the content database

```bash
node scripts/build-content-db.mjs \
  --content /path/to/your/content \
  --db      /path/to/content.db
```

Your content root needs, at minimum, a `modules/` or `resources/` directory of
JSON items and a `source-registry.json`. Each content item declares an `id`, a
`title`, and ideally `lastVerified`, `reviewCadenceDays`, and a `sources` array.

**Read the build output rather than just its exit code.** In particular:

```text
STALENESS IS BLIND TO 66 OF 150 ITEM(S). A low stale count above does not cover these:
  learn: 66 item(s), no lastVerified and no reviewCadenceDays
```

An item without those two fields cannot be stale, so it drops out of every
staleness count and the totals look healthy. If you see this, either add the
fields or run:

```bash
node scripts/backfill-currency-fields.mjs --content /path/to/your/content
```

which derives both from the item's own citations, shows you what it would change,
and writes nothing until you add `--apply`.

## 5. Run a discovery pass

**First, take a copy of the starter registry.** Discovery reads and writes this
file; it does not create one, and a cold clone has nothing to point `--registry`
at:

```bash
cp content/opportunity-registry.starter.json /path/to/your/opportunity-registry.json
```

Then edit its `watchList` to name the catalogue pages you want to measure demand
against. The shipped entry is a placeholder and will find nothing. The format is
an array of URLs:

```json
"watchList": ["https://learn.microsoft.com/en-us/training/browse/"]
```

```bash
node scripts/discover-content-opportunities.mjs \
  --registry /path/to/your/opportunity-registry.json \
  --corpus   /path/to/your/content \
  --probes   /path/to/your/probes.json \
  --out      /path/to/proposals.json \
  --gap-threshold 5
```

Start from [`content/opportunity-probes.example.json`](../content/opportunity-probes.example.json).
**Read its `probeDesignRules` before writing your own probes.** Every rule in
there was written after a probe silently measured the wrong thing and was
believed. The shortest version: ask what a term *also* matches before you trust
its count, and probe every name a product has held.

## 6. Turn the queue into briefs

A build turns open candidates and stale items into a work queue. This is what
hands that queue to the authoring ensemble.

**First, say where each surface's content lives.** Copy
[`config/surface-targets.json`](../config/surface-targets.json) and set
`pathTemplates` for every surface you author. A surface with no template is
refused rather than guessed at, because the delivery platform will not emit a
proposal that cannot name a repository and path, and a proposal nobody can locate
cannot be reviewed.

Two things that file exists to let you say, both learned the hard way:

- **A surface can live in a different repository from the others.** Set
  `repository` on the surface. Assuming one repository made a fully populated
  surface read as one with no home at all.
- **A surface can need more than one path.** An artifact plus its catalogue
  entry is two paths, and a proposal that writes the first and not the second
  produces something no reader can reach.

```bash
node scripts/generate-briefs.mjs \
  --db        /path/to/content.db \
  --inventory /path/to/your/model-inventory.json \
  --registry  /path/to/your/opportunity-registry.json \
  --targets   /path/to/your/surface-targets.json \
  --out       /path/to/briefs/queue-backlog.json \
  --limit     3
```

It writes the brief file and reports the ensemble it staffed from your model map.
Nothing in the queue moves until you add `--apply`, which marks what it issued as
`claimed` so a second run cannot double-issue the same subject.

**Read the skipped list.** Items on a surface with no target are *stranded*, not
deferred: nothing will pick them up until you give that surface a home.

Each generated brief id ends with the subject id of the queue item it serves.
That is not cosmetic. It is the only channel back from a proposal to the queue,
and step 7 depends on it.

## 7. Close the loop

After a delivery run, tell the queue what happened:

```bash
node scripts/ingest-proposals.mjs \
  --db          /path/to/content.db \
  --run-records /path/to/run-records \
  --apply
```

A passed proposal moves its item to `in-progress`; a blocked one moves it to
`blocked`, which is deliberately distinct from nobody having tried. **It never
publishes and never overrides a person**: an item somebody moved to `rejected` or
`done` is reported as left alone.

When you have read a proposal and committed the content, record that:

```bash
node scripts/record-publication.mjs \
  --db          /path/to/content.db \
  --run-records /path/to/run-records \
  --subject     <subject-id> \
  --accepted-by "your name" \
  --apply
```

`--accepted-by` is required and has no default. A publication with nobody named
on it is an automated publication, and this pipeline does not do those. This is
also the only tool that writes the terminal `done` state, which is why a person
runs it and a build does not.

Afterwards, `v_provenance` answers which run wrote a given item, under which
brief, and what its reviewers concluded. **Read `v_unprovenanced` alongside it**:
content that predates the pipeline has no row at all, and without that view a
mostly untraced estate reads as fully traced.

## What Orchard will never do to your environment

- It will not create, scale, or delete a model deployment.
- It will not edit your model inventory.
- It will not call an endpoint you did not configure.
- It will not publish content. Everything it produces is inert until a human
  approves it.

If a job needs a model you have not deployed, Orchard stops and tells you. Doing
something about that is your decision, in your own systems.

## If you are using Azure AI Foundry

You do not have to, and Orchard has no dependency on it. If you do, one way to
stand up the endpoint and the deployments is the framework at
[`homestead-foundry`](https://github.com/Hybrid-Solutions-Cloud/homestead-foundry),
which is the worked example this tool was developed against. Its instance
repository shows what a filled-in model inventory looks like in practice.

Any other OpenAI-compatible endpoint is equally supported, and nothing in Orchard
should ever change that.
