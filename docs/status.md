# Status

**Last reconciled 2026-09-06.**

This page exists because "built" is an ambiguous word, and using it loosely is
how a project ends up believing things about itself that are not true. Four
columns, and a claim only counts when all four are green.

| Column | Question it answers |
|---|---|
| **Designed** | Is the decision made and written down? |
| **In branch** | Does the code exist on the default branch? |
| **Connected** | Is it wired into a path that actually executes? |
| **Verified** | Has it been observed working on real input? |

---

## The contradiction this page used to carry, and how it was settled

Two claims in this documentation set flatly contradicted each other, and both
were carried forward for weeks:

- `decisions.md`, `lifecycle.md` and `workflow-orchestration.md`, all
  banner-dated **2026-08-15**, said **"Orchard is not running anywhere."**
- This page, dated **2026-08-20**, said the pipeline was **"deployed,
  connected, and verified end-to-end in production."**

They are not both true, and neither is simply wrong. Settled 2026-09-06 from
this repository's own history and code:

**Both were true when written. The 08-15 statement was superseded five days
later, and nobody went back to retire it.**

**Evidence, all of it in this repository:**

1. **The 08-15 statement was accurate at the time.** Commit `0f05642`
   (2026-08-14), "merge: reconcile the two-track lifecycle branch into main",
   is the reset those banners describe. Everything before it was a reference
   deployment that had been torn down, and Gate 1, Gate 2, the denial loop and
   live verification all landed on that same day (`beb89a0`, `6b776fd`,
   `55bb607`, `6d25773`) as new, never-run code.

2. **Production bring-up happened between 2026-08-16 and 2026-08-20, and it is
   legible in the commit stream.** Roughly sixty commits in those five days are
   not feature work: they are fixes to failures that can only be observed by
   watching real runs against real infrastructure. Among them — `03dadc3` "use
   async spawn so Node event loop continuously renews Azure Blob coordination
   lease", `a786d4f` "tolerate protected main advancing, so more than one item
   can publish", `e64aa6e` "reconcile a pull request merged outside Orchard
   instead of refusing it forever", `4bf5a9a` "acknowledge on the provider's
   report of the merge, not on main's tip". Nobody writes that sequence against
   a system that is not running.

3. **The code itself records production observations by date.**
   `scripts/lib/registration.mjs` opens with: *"Found live 2026-08-19, after
   the first publication run merged nine items into
   project42dev/project42-platform and reported nine successes."* That is a
   production run, named in the source, five days after the reset.

**Verdict: Orchard is deployed and running in production.** The "not running
anywhere" banners are kept on the pages that carry them, marked as the
historical record of 2026-08-14, because deleting them would lose the reset
they document.

### The 08-20 headline overstated it, and the repository says so

The 2026-08-20 wording — "deployed, connected, and **verified** end-to-end" —
does not survive contact with this repository. Three defects recorded in the
code contradict the Verified column as it was then written:

- **Publication was landing files nobody could reach.**
  `scripts/lib/gate-queue.mjs` and `scripts/lib/registration.mjs` both record
  that the first publication run's nine merged items were all unreachable: no
  learning path listed the modules, and no catalogue entry listed the diagrams.
  Registration was written afterwards to close that.
- **Every Track 1 learning item was refused at registration.** `discovery` was
  never a declared learning path in either target repository's `catalog.json`,
  so `registration.no-such-path` fired on every one. Fixed 2026-09-06.
- **Live verification verified nothing, while running.**
  `scripts/verify-published-live.mjs` substituted a `{topic}` placeholder from a
  row that never carried one, so `expectedUrl` returned "did not fully resolve"
  for every item, no URL was ever fetched, and the `verification` phase of the
  production runtime reported zero items serving on every run. Fixed 2026-09-06:
  the route is derived from the item's own target path per surface, proven by
  resolving real published items and fetching them.

### What cannot be determined from this repository

The 2026-08-20 entry also claimed 13 discovered modules, a v0.81.0 release, 12
learning paths across 94 modules, and work items AB#7745–AB#7757. **None of
those are verifiable from here**, because this repository holds neither the
curriculum nor the tracker. They are recorded below as claims made on that
date, not as findings. Confirming them means reading `project42-content` and
the work tracker directly.

---

## Where things stand

Corrected 2026-09-06 against the code, not against the previous version of this
table.

| Capability | Designed | In branch | Connected | Verified |
|---|---|---|---|---|
| Content database compiled from files | yes | yes | yes | yes |
| Model map with a refusal instead of a fallback | yes | yes | yes | yes |
| Multi-role frontier authoring ensemble | yes | yes | yes | yes |
| Gate 1, holding work before any model is reached | yes | yes | yes | yes |
| Gate 2, binding publication to an artifact digest | yes | yes | yes | yes |
| Currency track, inspecting the published corpus | yes | yes | yes | inspection only; no currency finding has been carried through to publication |
| Discovery track, searching approved sources | yes | yes | yes | yes |
| Seeding the shared inputs both tracks read | yes | yes | yes | yes |
| Direct request intake (`seed-inputs/curriculum-requests.json`) | yes | yes | yes | yes |
| Publication through protected-main pull requests | yes | yes | yes | yes |
| Registration, so a published file is reachable | yes | yes | yes | **no.** Built 2026-08-19, after the defect it exists for. No full run has been observed since the 2026-09-06 learning-path fix |
| Live verification that a published page really serves | yes | yes | yes | **no.** It IS reachable — `orchard-production-runtime.mjs` runs it as the `verification` phase — and until 2026-09-06 it resolved a URL for no item at all, so every run reported 0 serving. Repaired and proven against the live portal by hand; no production run has been observed since |
| Consumer site version bumping and release gate | yes | yes | yes | yes |
| Portable single-template deployment | yes | yes | yes | yes |

Two rows are deliberately not green. A check that has been repaired but not yet
observed working in production is exactly the thing this page exists to keep
apart from a check that is working.

The live-verification row is worth reading twice. The check was **connected all
along** — `run-verification.mjs` is a phase of the production runtime — which is
precisely why the defect mattered: it ran, and it reported zero items serving
every time, because it could not build a URL for any of them. A disconnected
check is inert. A connected check that measures nothing is believed.

## What was claimed on 2026-08-20

Recorded as the claim made that day. It is history, not a description of the
current estate.

- 13 new curriculum modules discovered, scored, and authored across AI Foundry,
  Agentic Orchestration, MCP, Voice Agents, Cost Governance, and Multi-Model
  Evaluation.
- A 5-model frontier ensemble qualified them against instructional and
  factuality standards.
- Gate 1 and Gate 2 cycles executed with SHA-256 digests and authorization
  recorded in the append-only ledger.
- Publication opened pull requests, verified trailers, and merged.
- Release v0.81.0 was tagged and the consumer sites of the day were updated.
  Two of those hosts were retired in September 2026 when the estate
  consolidated onto the single `project-42.dev` origin, and their repositories
  were archived.
- Work items AB#7745–AB#7757 were moved from Active to Resolved.

## Related

- [Lifecycle](lifecycle.md) — the states an item moves through, and the narrative
- [Lifecycle, step by step](lifecycle-steps.md) — per-step jobs, tables and failure modes
- [Workflow orchestration](workflow-orchestration.md) — the two tracks and what each may write
- [Decisions](decisions.md) — the reasoning by theme
- [Architecture decisions](adr/index.md) — one page per accepted decision
