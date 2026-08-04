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
