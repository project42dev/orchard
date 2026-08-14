# The Orchard content lifecycle, discovery through decommission

**Date:** 2026-08-03
**Related:** ADR-0017 (the separation), ADR-0018 (the model map), ADR-0019 (the
content database)

> **Correction, 2026-08-13. Read this before the rest of the page.**
>
> The sentence that followed this banner claimed every state below is a state a
> real record is in, in a real system, and every arrow is something that
> actually happens. **That is not true today**, and stating it in the present
> tense is how this project came to believe a lifecycle was running when it was
> not.
>
> What is actually deployed, verified 2026-08-14: the 8-phase engine runs
> monthly (the 1st, 06:00 UTC) performing discovery, scoring, database build,
> **Gate 1**, brief generation, delivery against Foundry, ingest, and
> notification. New work holds at `gate1-pending` until the owner approves.
> Gate 2 binds the publication approval to the exact item and artifact
> digest, with a denial-rework loop. The currency track runs monthly (the
> 15th) and records findings.
>
> Still designed and not built: gate manifests and batching, revision
> binding, `defer`, the PR-transaction publication, wired live verification,
> and every currency-track step past inspection.
>
> Treat this page as the intended lifecycle. The record of what runs is
> `how-orchard-works.md` in the operations repository design package.

One content item, from the moment a discovery pass first notices the topic to
the moment it is retired. The states below are the **intended** lifecycle.

Three systems carry the item, and they answer different questions. Confusing
them is the main way a process like this rots:

| System | Answers | Authoritative for |
|---|---|---|
| Discovery list | what could we build, and why do we think so | candidate evidence and triage |
| Content database | what do we have, and what state is it in | content state, forever |
| Work tracker | who did what work, and when was it done | the work, not the content |

Version-controlled content files are canonical. The database is a **compiled index** of them and is authoritative only for **workflow state**, per ADR-0019 and ADR-0023. Corrected 2026-08-13: this line previously called the database the source of truth for content, contradicting the ADRs. The work tracker is the
source of truth for **work**. A content item outlives any number of work items
about it.


## The process this must deliver

This is the product owner's mandate, in the owner's own terms. Every design
decision, contract, diagram and runbook in Orchard exists to deliver these
steps. If any document describes a different flow, this section wins and that
document is wrong.

### Discovery track

1. Process kicks off.
2. A discovery agent runs against a list of valid sources.
3. Discovered content is stored.
4. Discovered content is scored.
5. Scored content is stored.
6. A GitHub issue and an alert are raised, listing everything discovered with
   its scoring.
7. The owner approves on the comment.
8. Approved content moves to an approved list, and each item gets a work item
   for tracking.
9. Orchestration kicks off: research agents, authoring agents, review agents.
10. Fully written content is stored.
11. A GitHub issue is created carrying the work-item link and either the written
    content or a link to it, for owner review.
12. Approve or deny. A denial carries a reason and the work returns for rework.
    An approval moves the content into the central content store: brand-new
    content becomes a new course, and content extending an existing course is
    added to it.
13. Commit and push.
14. Verify the new content is live.

### Currency track

The currency track follows the same method from step 6 onward. It differs at the
start:

1. Instead of discovering new content, it inspects existing content, using the
   source list and, **as an owner requirement not yet designed**, an online
   search.
2. New updates found are recorded, as is stale content that should be removed.
3. The same GitHub approval process runs, for updates and for removals.
4. The same research and authoring agents run.
5. A second GitHub issue approves the written updates and the deletions.
6. The agents update existing content, remove stale content, commit and push.

### Request intake

**Designed, not built.** A third intake path alongside discovery and the
currency track, so a topic can be suggested rather than only discovered or
found stale. Anyone can propose a topic through a GitHub issue form or by
opening an ordinary issue and applying the `content-request` label; both
converge on the same labeled issue and there is exactly one parser.

1. Intake runs as the first step of the scheduled discovery run, before source
   collection, and reads every open `content-request` issue.
2. Each request is matched against the canonical corpus and against open
   candidates. A subject already covered becomes a currency finding against
   the existing item instead of a new candidate; a duplicate of an open
   candidate links to it instead of creating a second one.
3. What survives dedup and classification is written into the same discovery
   queue a discovered candidate uses, recording its origin as requested, the
   originating issue number, and the requester's immutable numeric actor id.
4. A request never starts a run by itself. It waits for the next scheduled run
   or a manual trigger, and it is scored on the same scale as a discovered
   candidate, never bypassing scoring, the cutoff, or any cap.
5. Requests are batched with discovered and currency items in the same Gate 1
   manifest and issue, with an origin column, so **discovery, the currency
   track, and request intake all feed the same queue and the same Gate 1
   decision.** Only the owner's Gate 1 approval moves a requested item
   forward.
6. Everything after Gate 1 is identical regardless of origin: the same
   tracker item, the same authoring ensemble, the same Gate 2, the same
   publication and verification path.
7. The loop closes on the requester. A verified publication comments the live
   link on the original issue and closes it; a Gate 1 denial closes the issue
   with the owner's reason.

### Known gaps against this mandate

- **Approval before authoring is live (closed 2026-08-14).** Gate 1 runs inside the deployed engine: new work enters `gate1-pending` and only owner approval reaches a model. Remaining wiring: nothing posts the Gate 1 issue automatically, and the engine job has no `ORCHARD_GATE1_ISSUE` set, so decisions are pulled manually.
- **The publication approval is bound (closed 2026-08-14).** `orchard-human-review.yml` now acts only on `/orchard gate2` commands naming the exact item and artifact digest; editing a proposal invalidates prior approvals, and denial re-queues the item with the reviewer's reason. Publication is still a direct commit, not the designed PR transaction.
- **Online search for the currency track is not designed.** It conflicts with
  the fail-closed approved-source rule and needs a decision.
- **Batch approval is not designed.** Every decision command is per item and
  carries a UUID, a revision and a digest, which does not scale to a human
  typing them.
- **Two of the six required agent roles do not exist**: researcher and
  finalizer.
- **Live verification, step 14, is implemented but nothing invokes it.**
  `verify-published-live.mjs` refuses bare 2xx responses and demands an
  item-derived marker in the body; it is not yet wired to any phase or
  workflow.
- **Request intake is designed and not built.** No issue template, no intake
  step in the scheduled run, and no code exists today. See the "Request
  intake" section above for the design: the intent is that it reads
  `content-request` issues, deduplicates and classifies them, and joins the
  same queue and the same Gate 1 that discovery and the currency track use.

## Current authoritative lifecycle

The current implementation separates evidence collection from mutation.

1. Track 1 surveys a versioned approved-source registry. A full run completes
  only after at least 50 distinct approved and enabled sources are attempted.
2. Track 2 enumerates the canonical corpus at one exact Git commit. A full run
  completes only when every canonical item has one evidence-bearing inspection
  and reconciliation reports zero gaps.
3. Gate 1 records one decision for one item and revision before tracker work is
  created.
4. Qualified roles produce persisted handoffs and one immutable artifact
  binding.
5. Gate 2 approves that exact artifact.
6. Publication uses a branch and pull request. Direct pushes to the protected
  branch are refused.
7. The merge is reconciled to an exact protected-main acknowledgement.
8. The owner accepts the bound closure packet and completion notes before the
  tracker item may close.

Weekly Track 1 and Track 2 runs are independent and always use full mode.
Manual runs support full, subset, and dry-run modes and default to dry-run.
Run evidence never counts as either approval. See
[`workflow-orchestration.md`](workflow-orchestration.md) for pins, permissions,
and the retired workflow audit.

### Authority is protected evidence, not caller input

Gate decisions become authoritative only when Orchard atomically stores the
authenticated provider event, the authorization policy, the provider-adapter
identity and digest, and the resulting decision. The policy and adapter digests
must match an immutable administrator-provisioned trust anchor in the same
SQLite authority store. `provision-trust-anchor.mjs` derives the policy and
adapter digests from exact files and persists the adapter identity; the capture
command cannot supply or replace any of them.
A payload that supplies its own event, policy, actor allowlist, or adapter claim
is rejected even when all of those caller-controlled values agree with each
other.

Downstream delivery and publication commands do not accept copies of those
authority objects. Dispatch accepts only the queue work-item ID and persisted
Gate 1 decision-event ID. Publication accepts only the persisted Gate 2
decision-event ID. Orchard resolves each reference through the content database
and reconciles every reviewed field against immutable run, revision, tracker,
handoff, artifact, and publication evidence before allowing a write.

Closure follows the same rule. The authenticated owner event and owner policy
are persisted atomically, and the owner policy and adapter must match the
immutable closure trust anchor. Publication and acknowledgement load their
adapter only from the publication anchor, persist its identity and digest as
publication authority, and reconcile that authority before acknowledgement or
closure. Runtime environment variables and command-line adapter paths cannot
select protected authority. A caller cannot authorize itself by adding an
`authorized` field or by passing an owner list. The tracker remains open unless
the protected owner event binds the current closure-packet digest exactly.

Database restore is also fail closed. A candidate backup is verified before
replacement, replacement must remain on the same volume, and the previous
destination is retained as rollback evidence rather than deleted. A restored
database is accepted only after integrity and schema verification succeeds.

## The whole cycle

![Content lifecycle diagram](lifecycle.svg)

> The Mermaid source is in [`lifecycle.mmd`](lifecycle.mmd). The SVG above is
> generated from it. GitHub does not render Mermaid in markdown files, so the
> rendered image is committed alongside the source.

<details>
<summary>Mermaid source (click to expand)</summary>

```mermaid
flowchart TD
  subgraph EVIDENCE["Independent evidence tracks"]
    A1["Track 1 approved-source discovery<br/>full: at least 50 sources attempted"]
    A2["Track 2 canonical inspection<br/>full: 100 percent at exact commit"]
    end

  A1 --> B1["Candidate or finding<br/>one item and revision"]
  A2 --> B1

  subgraph DELIVERY["Bound delivery lifecycle"]
    B1 --> B2{"Gate 1 decision"}
    B2 -->|deny, defer, or changes| B3["No delivery authority"]
    B2 -->|approve| B4["Linked tracker item reconciled"]
    B4 --> B5["Qualified role chain<br/>persisted handoffs"]
    B5 --> B6["Immutable artifact binding"]
    B6 --> B7{"Gate 2 decision<br/>exact artifact"}
    B7 -->|deny, defer, or changes| B8["No publication authority"]
    B7 -->|approve| B9["Deterministic branch<br/>protected-main pull request"]
    B9 --> B10["Exact merge, tree, diff,<br/>head, and base reconciliation"]
    B10 --> B11["Protected-main acknowledgement"]
    B11 --> B12{"Owner accepts closure packet<br/>and completion notes?"}
    B12 -->|no| B13["Tracker remains open"]
    B12 -->|yes| B14["Tracker item closed"]
    end

  B11 --> C1{"Instructor-led rendering wanted?"}
  C1 -->|no| C2["Written content only"]
  C1 -->|yes| C3["Build immutable media package<br/>and integrity manifest"]

  B11 --> D1["Future Track 2 run<br/>re-inspects the canonical item"]
  C3 --> D1
  D1 -->|material finding| B1
```

</details>

## The authoring ensemble: six roles designed, four running

**Corrected 2026-08-13.** The heading previously said all six are built. Two are
not in the deployed ensemble: **researcher** (AB#7047) and **finalizer**
(AB#7048). The owner has asked three times for six roles.

Every piece of content, whether written for the first time or corrected after a
source changed, must pass through the same ordered ensemble. **The same ensemble
applies to the scheduled currency scans.** It is one platform with two triggers,
so a role added here is a role the scheduled run gets too, and an update needs
research more than a first draft does: the whole trigger is that a cited source
changed, and nothing can assess that without reading what changed.

Each role runs as a separate call, with its own prompt, against a **different
vendor family** wherever the roles check each other. Two models from one family
agree for reasons that have nothing to do with whether the content is right.

| # | Role | Owns | State |
|---|---|---|---|
| 1 | **Researcher** | Gathers primary sources before anything is written, and hands the drafter evidence rather than a topic. | **Designed only. Not in the deployed ensemble** (AB#7047) |
| 2 | **Drafter** | Writes the content from the brief and the researcher's evidence. | Built |
| 3 | **Verifier** | Checks every claim against the supplied evidence. Different vendor family from the drafter, enforced. | Built |
| 4 | **Adversary** | Attacks the draft rather than reviewing it. Looks for what is overstated, unsupported, or invented. | Built |
| 5 | **Arbiter** | Breaks a tie when the verifier and adversary disagree. Never judges its own output. | Built |
| 6 | **Finalizer** | Structure, formatting, citations rendered at the end, knowledge checks correct and answerable from the material, and the item placed correctly in its learning path. | **Designed only. Not in the deployed ensemble** (AB#7048) |

### Why the two bookend roles matter

The ensemble is strongest exactly where it is easiest to over-build, three
independent checkers, and absent at both ends.

**Without a researcher**, the drafter can only restate its brief. A brief
instruction such as "do not invent tool names, version numbers, or configuration
keys" becomes a hope rather than a control, because there is no supplied evidence
to check an invention against. The verifier is then checking prose against prose.

**Without a finalizer**, nothing owns the things a reader actually judges the
content by: whether the sources are listed, whether the exam questions can be
answered from the material, and whether the module sits in the right place in a
path. Those are not writing problems and a drafter will not catch them.

Both roles are now built and wired. The delivery platform has always supported
all six roles; the gap was only in the brief generator not including researcher
and finalizer configuration in generated briefs. That gap is now closed.

### The constraint a researcher must respect

Fetched source text is **untrusted data, never instruction**. The platform
already fences it inside a per-run nonce so retrieved text cannot forge a closing
delimiter and resume instruction context, and a run aborts rather than stripping
a forged delimiter. A researcher role uses that existing machinery. It does not
get a new, looser path to the model.

### Historical execution and current implementation

The four core roles ran end to end against the live estate: **9 requests,
$0.57, four vendor families**, drafter `gpt-5-6-sol`, verifier
`grok-4-20-reasoning`, adversary `deepseek-v4-pro`, arbiter `mistral-large-3`.

**Both proposals came back `blocked`.** The pipeline works and the content was
not good enough, which is the correct outcome for a gate and the reason nothing
was published. Missing roles 1 and 6 was the leading explanation.

All six roles are wired: researcher and finalizer are in the brief generator
(`ROLE_JOBS` and `ROLE_TOKEN_BUDGET`), the model map has `research` and
`finalization` jobs, and deterministic lifecycle tests exercise complete
qualified role chains. Historical live results above prove only the four-role
run they record; they are not evidence of a later deployment.

One defect fixed to get there: the drafter returned an **empty completion**
because reasoning tokens are billed against `max_completion_tokens`, and a 4096
budget was consumed entirely by reasoning before a single word of prose. The
budget is raised per role in the brief, never globally, because the global value
feeds the pre-flight cost projection and raising it aborts the run on the spend
ceiling before request one.

## Is the lifecycle actually a cycle? Yes, as of 2026-08-04. All three breaks closed.

Each phase worked long before the whole did, because the phases were the boxes
and the breaks were in the arrows. Three arrows were missing.

| Break | What happened | Closed by |
|---|---|---|
| **Phase 2 to Phase 3** | The queue held 24 items needing creation. The ensemble read **hand-written briefs**. The two lists had no relationship, so nothing in the queue could ever be picked up and work was chosen by whoever last edited the brief file. | `scripts/generate-briefs.mjs` |
| **Phase 3 to Phase 2** | The ensemble wrote a proposal to a directory. Nothing read it back, so an item stayed `queued` forever and a human reconciled two lists by hand. | `scripts/ingest-proposals.mjs` |
| **Phase 3 to Phase 5** | Nothing recorded what was published or from which proposal, so provenance from a published item back to the run that produced it did not exist. | immutable artifact and publication transactions plus protected-main acknowledgement |

### The rule that closes the outbound arrow

**A brief must carry the subject id of the queue item it serves.**

The delivery platform names its proposal file after the brief that produced it,
and the ingest recovers the queue item from that filename. That filename is the
entire channel from the ensemble back to the queue. So the generator encodes the
subject id in the brief id, as `p42-create-<subject>` or `p42-update-<subject>`,
and **refuses to emit a brief whose id would not survive the trip**: the platform
lowercases and rewrites anything outside `a-z0-9._-` on its way to a filename,
and an id that changes on the way through is an id that cannot be recovered.

Before this, run against the two real proposals from the first successful
ensemble run, the ingest reported `0 work item(s) would move` and `2 proposal(s)
NOT MATCHED`. It still reports unmatched rather than guessing, because a wrong
match writes a real state change onto the wrong content. It just no longer has
anything to report against a generated brief.

### The return arrow, and what it will not do

- **It never publishes directly.** A proposal is inert until both item-bound
  gates approve the exact revision and artifact. Publication then proceeds by
  pull request and remains incomplete until protected-main acknowledgement.
- **It never overrides a human.** An item a person moved to `rejected` or `done`
  stays there. Automation may propose a state change and may not perform one.

### The provenance arrow

`publish-approved-item.mjs` creates a deterministic branch and pull request only
after Gate 2 approves the exact immutable artifact. `record-publication.mjs`
then reconciles the remote transaction and records acknowledgement only when
the expected head, base, merge commit, tree, and diff are present on protected
main. A merged pull request by itself is not acceptance and does not close work.

Closure is a separate transaction. Orchard prepares a packet bound to the
acknowledged publication and exact completion notes. The currently authorized
owner must explicitly accept that packet before the linked tracker item may move
through `Resolved` to `Closed`. No publication command writes a terminal legacy
`done` state on the owner's behalf.

`v_provenance` answers "which run wrote this, under which brief, and what did its
reviewers conclude". Filtering the table on `run_id` answers the other direction,
which is the query to run the day a model is found to be producing bad content.
**`v_unprovenanced` is its honest companion**: content that predates the pipeline
or was committed by hand has no row at all, and without it a mostly untraced
estate would read as fully traced. Same reason `v_unmeasurable` exists.

### Proven end to end, and what "proven" means here

`scripts/test-lifecycle.mjs` walks one topic all the way round: discovered,
queued, briefed, blocked by the ensemble's own reviewers, re-drafted, passed,
accepted by a person, indexed by a rebuild, and then aged past its review cadence
until the currency engine queues the same item again as an update. **31
assertions on the arrows rather than the boxes.**

The delivery platform is not run inside that test: it needs a managed identity
and costs real money per run. What is reproduced exactly is the only thing it
hands back, the run record, with the proposal filename built through the real
normalizer. Separately, `Test-Project42DeliveryBriefs.ps1` drives the **generated
backlog itself** through the real entry point with a synthetic transport, and
checks that the proposal filenames the platform actually writes still recover
back to their subject ids.

### Three defects this work found, all on the happy path

1. **The ingest did not know `ready-for-draft`**, which is the only pass
   disposition the platform emits. Every failure path worked, so the run where
   both proposals came back `blocked` looked like proof the tool worked. The
   first proposal to PASS would have been filed as an unknown disposition and
   its queue item left sitting.
2. **The model map staffed the drafter and the verifier from the same vendor
   family**, and the platform throws `INDEPENDENCE` on that at request time,
   after the draft has been paid for. That ensemble could never have completed a
   run. Brief generation now checks the same rule before any money is spent.
3. **One subject can carry two work items at once**, a completed creation and an
   open update, and the ingest keyed on subject id alone. An update proposal
   would have reopened the completed creation, and the terminal-state guard read
   whichever row SQLite returned first.

### A surface is not necessarily in the same repository as the others

The first version of the target map had one repository for everything, and on
that assumption ten of the twenty-four queued items looked homeless: the
`visual-guide` surface had no directory anywhere in the content platform.

**It was never homeless. It was in a different repository.** Visual guides are
the diagrams published on the Field Guide subdomain at `/diagrams` and
`/diagrams/<id>`, where the interface calls them visual guides. The Mermaid
source is `diagrams/<id>.mmd`, the catalogue entry is in `config/diagrams.json`,
and the SVG under `public/diagrams/` is generated rather than authored.

Two rules came out of it, and both are in `config/surface-targets.json`:

- **A surface may override the default repository.** Assuming one repository is
  what made a populated surface read as an empty one.
- **A surface that needs a catalogue entry as well as a file declares both
  paths.** A proposal that writes the artifact and never registers it produces
  something no reader can reach.

A third followed from the same place: a visual guide is not an article, so the
brief for one carries a **form instruction** (produce Mermaid source plus a
catalogue entry, never a hand-authored SVG) and acceptance criteria about
`altText` and whether the diagram renders without a legend. A drafter handed the
generic prose instruction writes prose, which cannot be published on that
surface at all.

All 24 queued items now resolve to a repository and a path. Nothing is stranded.

## Phase 4 is on hold, and the reason is a design question not a technical one

**Held 2026-08-04 by owner decision**, so that the Learn surface can be designed
before anything is rendered against it. Rendering 29 modules against a structure
that is about to change would be waste, and the avatar and voice choices are
already recorded and do not expire.

**The load-bearing rule, which the hold does not change: instructor-led is a
second RENDERING of one module, not a second track and not a replacement for
self-paced.**

The platform is already built this way. Every class-ready module already carries
`class-script.json`, `captions/`, `transcripts/`, `alternatives/` and
`integrity.json` beside the module itself. Everything exists except rendered
audio and video.

Two separate tracks would mean maintaining the same subject twice. They drift,
and when a cited source changes the currency engine cannot reconcile two copies
of the same claim. A `hasInstructorPackage` flag on the row is far cheaper than a
parallel catalogue, and it keeps one source of truth feeding every rendering
derived from it.

So the Learn redesign is a question about **presentation and navigation**, not
about replacing one catalogue with another. A learner should be able to read a
module or watch it, and both should come from the same content.

### Both renderings carry the knowledge check, and progress is identical

**Decided 2026-08-04.** Instructor-led includes the same knowledge check, and a
learner's record is the same whichever way they took the module.

**This needs no change, and the reason is worth knowing.** The learning event
contract already keys every command and event by `pathId` and `moduleId`, and
carries no field for rendering, delivery mode, or format anywhere. Progress is
therefore recorded **against the module, not against how it was consumed**, which
is exactly the required behaviour and was true before anyone asked for it.

Three consequences follow, and all three are desirable:

- A learner can **read half a module and watch the rest**, and the record is one
  record. Nothing forces a choice at the start.
- **A badge or credential means the same thing** however it was earned, which is
  the only defensible position if both renderings teach the same material and
  ask the same questions.
- **Completion cannot be gamed by switching rendering**, because there is nothing
  to switch between as far as the record is concerned.

**If a rendering is ever recorded, it must be an annotation and never a key.**
Knowing which modules were watched is useful for two real purposes: judging
whether the instructor work earns its cost, and building a re-render list if an
avatar is withdrawn. Neither is a reason to let it touch completion, and adding a
field to a portable learning record is a contract change rather than a detail.

## Phase 4 proof of concept, not production automation

**A real lesson was rendered on 2026-08-04.** The opening 87 seconds of *Agents,
Tools, and Guardrails*, spoken from that module's own class script, with captions
embedded. Submit to finished video took about two and a half minutes. This proves
the media path only; production Phase 4 automation remains on hold and is not
built.

**Cost, measured rather than estimated.** Two separate meters:

| Meter | First render |
|---|---|
| `talkingAvatarDurationSeconds` | 86 |
| `hdNeuralCharacters` | 1281 |

Video is billed by **duration**, the voice by **character**. A full seventeen
segment module extrapolates to roughly twelve to thirteen minutes of video from
about 10,900 characters. **The cost recurs on every re-render**, so a module that
changes often is more expensive to keep as video than as text. That is a real
input to deciding which modules get an instructor package, and it argues for
rendering stable material first.

### The finding that overturned the avatar choice

Three characters had been chosen. **All three are rejected by the batch API.**

```text
camila  -> avatar character camila is not supported
faris   -> avatar character faris is not supported
clara   -> avatar character clara is not supported
lisa    -> WORKS
```

The documented roster and the set batch synthesis accepts **are not the same
list**, and nothing in the documentation says so. The three were selected from
the documentation without ever being submitted to the API that renders.

**It inverts the reason they were preferred.** They were chosen because they sit
outside the actor-licensed set that can be withdrawn when a contract lapses. The
one character proven to work is **inside** that set.

**Leading hypothesis, not confirmed:** the talking heads are **real-time**
avatars and batch supports only `lisa`. If that holds, "which presenter" and
"which synthesis mode" are the same question, and they were treated as
independent.

**The lesson generalises past avatars.** A capability read from documentation is
a claim. A capability exercised against the API is a fact. This is the same shape
as every other defect on this project: something that looked settled, was
believed, and was never measured.
## How a candidate is scored

Scoring exists to make selection arguable rather than instinctive. It does not
decide anything; it orders the queue a human reads.

Implemented in `scripts/score-opportunities.mjs`, with 38 assertions in
`scripts/test-score-opportunities.mjs`. It is read only: it never writes a
registry and never removes an entry.

| Input | Points | Where it comes from | Why it counts |
|---|---|---|---|
| **Breadth of demand** | 35 | how many surveyed sources mention the topic | one source is an anecdote, six is a pattern |
| **Depth of demand** | 15 | total occurrences across those sources | separates a passing mention from a taught subject |
| **Supply gap** | 30 | occurrences in our own corpus, per surface | zero is a gap; a low count may be a thin treatment |
| **Surface spread** | 20 | how many of our surfaces lack it | absent everywhere is worse than absent in one place |
| **Strategic weight** | multiplier | owner set, default 1 | the only subjective input, and it is explicit |

Breadth and depth saturate, at eight sources and twenty occurrences. Past that,
more of the same evidence adds nothing: the difference between eight sources and
eighty is not ten times the confidence.

Breadth reads `provenance.peakSourceCount`, the best reading ever recorded, not
the latest run. A run that reached fewer sources is a fact about the run.

### There is no cutoff score

Nothing is excluded for scoring low, and no threshold decides what reaches the
database. The two honesty rules below are the reason: both understate a real
topic for reasons that have nothing to do with the topic, so a threshold would
turn a temporary measurement into a permanent policy. Ranking is reversible and
exclusion is not.

What the score produces instead is reading order. Attention tiers of `strong`
(3 or more independent sources), `worth a look` (2), and `idea` (1) say where to
start, never what is allowed through.

Two honesty rules on the score, both learned from the first pass:

- **Breadth is capped by reachability.** Five sources refuse automated access,
  so a topic they teach and nobody else does scores zero through no fault of its
  own. The score is a floor, never a ceiling.
- **Demand is measured on a single catalogue page per site.** A site that
  paginates or renders its catalogue with JavaScript exposes almost nothing. A
  low score can mean "rarely taught" or "we could not see it", and today the
  score cannot tell those apart.

### A third honesty rule, learned later

**A topic with no measured demand is not a topic nobody wants.** The surveyed
sources are education providers teaching vendor-neutral curricula, so anything
platform specific scores zero demand no matter how valuable it is. Discovery
will never propose it. Such a topic can still be worth building, but it enters
the plan as **a strategy decision recorded as one**, never as a discovery
finding. Writing it into the registry as though discovery found it corrupts the
one signal the registry exists to carry.

## What the content database carries

Built, and described in ADR-0019. The design in one line: **content files stay
the source of truth, the database is compiled from them, and two tables hold
state that exists nowhere else.**

- **Derived and rebuilt every time:** `item`, `citation`, `source`, `candidate`.
  Losing them costs nothing.
- **Authoritative and never dropped:** `work_item`, what a human decided about a
  piece of work, and `rendering`, what was actually produced.

The test for which half a table belongs in: if a git checkout can reproduce it,
it is derived; if it records a decision or an event, it is authoritative.

`needs-creating` and `needs-updating` are one table separated by kind, which is
what makes a single queue serve both new content and corrections. A build
proposes work and never resets it, and `rejected` is terminal.

## The work-tracker model

**One standing Epic per surface family.** Features group by theme. **One story
per selected content item.**

```text
Epic:    Deliver the Learn catalogue
  Feature: Retrieval and grounding curriculum
    Story: Author "Retrieval-augmented generation" (work_item: create:learn-rag-001)
    Story: Author "Embeddings and vector stores"   (work_item: create:learn-emb-002)
  Feature: Leadership and decision-maker track
    Story: Author "AI for executives"              (work_item: create:learn-exec-003)
```

Rules that keep it usable:

1. **A story is created at promotion, not at discovery.** Candidates are not
   work. Putting every candidate on the board buries the board.
2. **The story carries the work item id.** That is the join between the two
   systems, and without it neither can answer questions about the other.
3. **A story closes when the content publishes.**
4. **An update never reopens a closed story.** It creates a new story linked to
   the original. "When was this written" and "when was it last corrected" are
   different questions and both deserve an answer.
5. **Decommissioning is a story too.** Unpublishing has steps, including
   redirects, catalogue removal, and package withdrawal, and an untracked
   removal is how dead links happen.

## What is built, and what is not

| Phase | State |
|---|---|
| 1, discovery | **Built and run.** 24 candidates across 10 topics, registry v0.1.6. |
| 2, selection, scoring, content DB | **Built.** Scoring runs against all 24. The content database compiles 150 items and 550 citations, and carries the queue. |
| 3, creation and publication | **Built.** The engine runs monthly (the 1st, 06:00 UTC, as an Azure Container Apps job), holds new work at Gate 1 until the owner approves, then the ensemble emits proposals and publishes through the digest-bound Gate 2 review. |
| 4, virtual instructor | **Not built.** Avatar and voice are chosen and validated; no rendering code. |
| 5, currency and retirement | **Partially built.** The monthly currency job (the 15th, 06:00 UTC) inspects the full corpus and records findings; nothing yet carries findings to review, authoring, or publication. Impact assessment and retirement do not exist. |

The diagram deliberately shows the whole cycle including the parts that do not
exist, because the shape of the end state is what makes each phase reviewable
before it is written rather than after.
