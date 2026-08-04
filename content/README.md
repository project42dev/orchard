# Content opportunity discovery

Find candidate content by measuring what a watched market teaches against what you
already cover. Discovery proposes; a human decides; nothing is published.

Nothing here is specific to any publisher. The watch list, the corpus, the probes
and the surfaces are all supplied by you.

## The two commands

### 1. Run a discovery pass

```bash
node scripts/discover-content-opportunities.mjs \
  --registry <path-to-registry.json> \
  --corpus   <path-to-your-content-root> \
  --probes   <path-to-probes.json> \
  --out      <path-for-proposals.json> \
  --surfaces "learn|modules|Learn|learn,field-guide|resources|Field Guide|field-guide" \
  --timeout  20
```

Writes **only** the proposals file. It never touches the registry.

Add `--offline` to skip the network survey and measure your corpus alone, which is
how you test coverage without depending on anyone's uptime.

### 2. Merge the proposals into the live list

```bash
# Dry run. Prints every decision it would take and writes nothing.
node scripts/merge-opportunity-proposals.mjs \
  --registry <path-to-registry.json> \
  --proposals <path-for-proposals.json>

# Same command with --apply to write.
```

Dry run is the default on purpose. `--apply` is the only thing that writes, and it
is the only thing that bumps `registryVersion`.

### 3. Rank what is on the list

```bash
node scripts/score-opportunities.mjs \
  --registry <path-to-registry.json> \
  [--weights <path-to-weights.json>] [--json <path>] [--all]
```

Read-only. It never writes the registry, and it never removes anything.

**There is no cutoff score.** The rank orders the queue you read; it does not
decide what is eligible. A threshold would turn a temporary measurement into a
permanent policy: breadth is capped by which sources allowed automated access
that day, so a score understates a real topic for reasons that have nothing to
do with the topic. Ranking is reversible, exclusion is not.

`--all` also scores delivered, retired and rejected entries, which is how you
check that a rejection still looks right instead of taking it on trust.

### What the score is made of

| Input | Points | What it is evidence of |
|---|---|---|
| Breadth | 35 | how many sources teach it. Independent agreement, so it carries the most weight |
| Depth | 15 | total occurrences. Separates a passing mention from a taught subject |
| Gap | 30 | occurrences in **your** corpus. The only input not measured on someone else's site |
| Spread | 20 | how many of your surfaces lack it |
| Strategic | multiplier | owner-set, default 1. The only subjective input, and it is explicit |

Breadth and depth saturate: eight independent sources scores the same as eighty,
because the difference is not ten times the confidence.

**Breadth is read from the peak ever recorded**, not the latest run. A run that
reached fewer sources is a fact about the run, so a source outage can never
quietly downgrade a real opportunity.

Attention tiers (`strong` / `worth a look` / `idea` / `unmeasured`) come from the
source count and order your reading. They never gate anything.

Override any weight with `--weights`, which is merged over the defaults:

```json
{ "points": { "breadth": 40, "depth": 10, "gap": 30, "spread": 20 } }
```

## `--surfaces`, and why it is pipe separated

```
id|path|Label|kind
```

Comma separates entries, **pipe separates fields**. A colon would collide with a
Windows drive letter in an absolute path, and absolute paths are required: visual
guides commonly live in a different repository from the written content.

The path may be relative to `--corpus` or absolute. A surface whose directory does
not exist is skipped with a message rather than failing the run.

**Measure each surface separately.** A topic can be thoroughly taught in one surface
and entirely absent from another; merged into one corpus, the covered surface hides
the gap in the other. This is not a nicety, it is the difference between finding a
Field Guide gap and never seeing it.

## Triage: how you accept or reject a candidate

Every candidate carries a `status`. Edit it in the registry:

| Set it to | Meaning | What later runs do |
|---|---|---|
| `candidate` | undecided, the default | evidence refreshed each run |
| `selected` | you want this built | evidence refreshed, state untouched |
| `in-progress` | being built now | evidence refreshed, state untouched |
| `delivered` | built and published | evidence refreshed, state untouched |
| `retired` | no longer relevant | evidence refreshed, state untouched |
| `rejected` | you do not want this | **never re-proposed again** |

When you set a status by hand, also set `statusSetBy` to `human`. That is what stops
a later run from treating the status as one it set itself and moving it.

When you reject something, write a `rejectionReason`. The merge surfaces it every
time the topic comes up again, so a future reader learns why a plausible-looking gap
is deliberately not being built.

**A rejected candidate never returns.** Re-proposing declined work on every run is
the single failure that trains an owner to ignore the list, so dedup runs against the
whole registry including rejected and retired entries.

## What discovery will not do

- **It will not write your registry.** Only the merge writes, and only with `--apply`.
- **It will not overwrite a decision you made.** It may refresh evidence fields it
  owns; it may not move a status a human set.
- **It will not delete anything, and nothing decays.** A run that finds less evidence
  than the last one still counts as a confirmation. Every run appends to
  `demandHistory`, and `provenance.peakSourceCount` keeps the best reading ever seen,
  so a topic is never judged on its worst day. Only a person retires a candidate.
- **It will not silently change a closed gap.** If a topic you were missing now scores
  above zero, the merge flags it for review rather than editing it.

## Reading the numbers honestly

**Supply is solid.** It is a full word-boundary read of your own corpus.

**Demand is directional only**, for two reasons that both make the score read low:

1. **Breadth is capped by reachability.** Sources that refuse automated access
   contribute nothing. A topic only they teach scores zero through no fault of its
   own. The score is a floor, never a ceiling.
2. **Demand is measured from one page per source.** A catalogue that paginates or
   renders with JavaScript exposes almost nothing to a plain fetch. A low count can
   mean "rarely taught" or "we could not see it", and the score cannot tell those
   apart.

So a topic backed by six independent sources is a real signal. A topic backed by one
belongs on the list because of the zero on *your* side, not the count on theirs.

## Word boundaries are not optional

Every probe is anchored. A naive substring probe for `rag` matches *storage* and
*average*, and once reported 769 occurrences of a topic the corpus did not contain at
all.

## Two failures worth knowing about

Both exited 0 and looked completely healthy.

**The corpus can poison its own measurement.** The registry and the probe file both
*name* every topic under measurement. Left in the corpus, a 3.2 million character
corpus reported one occurrence of RAG, and that occurrence was the registry entry
saying RAG was absent. Both files are now excluded by name and the exclusion is
printed in the run output.

**A corpus of nothing reports everything as missing.** A surface pointed at a
directory with no readable files measures zero characters, and every probe duly comes
back as a gap. Check the per-surface character count in the run output before
believing a result.
