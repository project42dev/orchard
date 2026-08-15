# ADR-0015: A source is a cited URL, and detection normalizes before it hashes

**Status:** Accepted.

## Decision

**1. The unit of detection is the cited URL, not the documentation tree.** A
registry entry's `urlPrefix` names a tree, and a tree cannot be fetched or
digested meaningfully. Treating one as a unit would mean a single character
changing anywhere beneath it reports that an entire vendor's documentation
changed, which is not actionable. Every distinct URL cited by a piece of content
is a detection target. The registry entry matching it by longest prefix supplies
the governance: publisher, trust tier, review cadence, owner.

Three consequences follow, all intended:

- **Detection scope tracks the corpus.** A source stops being watched when the
  last citation of it is removed, which is correct. There is no longer a claim
  to invalidate.
- **A registered source with no citation is not watched by the currency
  engine.** It is a discovery input instead, where the question is what to
  teach rather than whether an existing claim still holds.
- **Many observations can share one source id**, because one governed source
  legitimately backs many cited pages.

**2. Normalize before hashing, and version the normalizer.** Digesting a raw
HTTP response reports a change on every deploy of every documentation site,
because build banners, session nonces, rendered timestamps, analytics payloads
and CDN markers all move without any fact moving.

Normalization runs in a fixed order and produces a newline-delimited sequence of
block-level text nodes: fetch with a stable declared user agent and language,
follow redirects and record the final URL, prefer a declared canonical link and
record both when they differ, then discard script, style, navigation, header,
footer and decorative elements before extracting text.

**The normalizer is versioned**, so a change to normalization is visibly a
change to normalization rather than a wave of false positives.

## Why this shape

A detector that cries wolf sixty times a day trains its operator to ignore it,
which converts a safety mechanism into noise. The expensive failure is not a
missed change; it is a detector nobody reads any more.

Related: [ADR-0019](0019-content-database.md) for how staleness is recorded, and
[ADR-0022](0022-two-track-lifecycle.md) for the track this runs in.
