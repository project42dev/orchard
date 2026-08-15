# ADR-0018: One model map, and a refusal instead of a fallback

**Status:** Accepted.

## Decision

**1. One model map file inside Orchard.** For each job it carries the model id,
the reason that model was chosen, and the token parameter dialect as an explicit
field. **The dialect is never inferred from the model name.**

**2. Orchard validates the map against what is actually deployed at startup,
and fails loudly.** If a mapped model is absent, Orchard refuses to run and
names both the missing model and the job that wanted it. There is no silent
substitution and no nearest-match fallback.

**3. Voice is validated by name only.** Speech voices have no deployment,
capacity or quota record, so looking for one in a deployment list would fail
every startup.

**4. Never rank, budget or schedule by raw capacity.** Capacity is a per-model
unit and does not compare across models. Throughput planning uses measured
latency and observed throttling instead.

## Why refuse rather than fall back

A fallback swallows the only signal that says a human needs to go and deploy
something, and deploying is deliberately a human act performed outside Orchard
([ADR-0017](0017-layer-separation.md)). Content would also be produced by a
model nobody chose, and quality would drift without anything reporting it.

The token dialect is explicit for a concrete reason: two deployed models
contradicted each other outright, one rejecting `max_tokens` with HTTP 400 and
the other rejecting `max_completion_tokens` with HTTP 422. No single global
setting serves both, so a missing dialect is a validation failure rather than a
default.

In the three days before this decision, five separate defects were **silent
successes**. Every one exited zero and looked healthy. This was the place not to
add a sixth.
