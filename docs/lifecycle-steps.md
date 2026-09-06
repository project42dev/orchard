# The Orchard lifecycle, step by step

This is the per-step design reference. For every step it names the exact job,
the exact script, the exact database and table, the exact state transition, the
exact artifact, the actor who decides, and what happens when it fails.

**Why this document exists.** Every serious defect found in Orchard has sat
below the level the narrative design describes. Candidates were written to a
table that exists only on a developer machine. A script shelled out to a binary
that is not in the container. Twelve scripts have no runtime that can invoke
them. **A design that stops at "the work queue" cannot catch any of that.**
English noun phrases are what let a builder guess wrong eleven times.

**The rule this document follows:** every step names its database, its table,
its state value, its artifact and digest, its actor and its failure mode. If a
step cannot be described at that level, it is not designed.

**Honesty marker.** Every step carries one of:

- **BUILT** the code exists, is reachable from a deployed job, and has been
  observed running in production
- **BUILT, UNPROVEN** the code exists and is reachable, but has never been
  observed completing in production
- **NO RUNTIME** the script exists and **nothing deployed can invoke it**
- **NOT BUILT** neither script nor runtime exists

> **Honesty markers on this page are dated 2026-08-15 and several are now
> superseded.** This page was written the day after the 2026-08-14 reset
> (commit `0f05642`), when nothing downstream of Gate 1 had a runtime. The
> production bring-up of 2026-08-16 to 2026-08-20 changed that: publication,
> merge acknowledgement, release and closure all ran against real
> infrastructure, and the commit stream of those five days is fixes to failures
> only a running system produces. **Read every BUILT / NO RUNTIME marker below
> as the state on 2026-08-15**, and read [Status](status.md) for what is
> current. The per-step detail — the exact job, script, table, state, artifact,
> actor and failure mode — is still accurate and is why this page is kept.
>
> **Path convention.** An unqualified `.mjs` script name such as
> `announce-gates.mjs` means `scripts/announce-gates.mjs`. Every other
> unqualified path is relative to this repository root; a path that names
> another repository first (for example `project-42.dev/app/...`) is relative
> to that repository's root.

---

## The physical system

| Thing | Value |
| --- | --- |
| Runtime image | `orchard-two-track`, `node:22-bookworm-slim` plus `ca-certificates` and `git` |
| Entry point | `node /app/scripts/orchard-production-runtime.mjs --track track-1\|track-2` |
| **Not in the image** | **`az`, `gh`, PowerShell.** Anything shelling out to these fails |
| Database | SQLite, `node:sqlite`, at `ORCHARD_DB_PATH` on the mounted state blob |
| Schema | `schema/migrations/002` to `005` only, applied by `migrateContentDb` |
| **Not applied** | **`schema/content-db.sql`. It is developer-only and production has never had it** |
| Version table | `schema_migration`. (`schema_meta` belongs to the other schema and is not present) |
| State storage | `stp42orchstateprodeus01`, containers `track-1-state`, `track-2-state`, `orchestration-artifacts` |
| Backup storage | `stp42orchbkupprodeus01`, containers `track-1-backup`, `track-2-backup`, immutable |
| Secret store | `kv-p42orch-prod-eus-01`, secret `orchard-gate-github-token` |

### The tables that exist

| Table | Holds |
| --- | --- |
| `workflow_item` | **The work item. This is the one.** Identity, track, semantic identity, `current_state` |
| `item_revision` | Each revision of an item, with its proposal or artifact digest |
| `workflow_run` | One row per track execution. `run_id` is a **UUIDv7** |
| `decision_event` | Every state transition, with cause and actor |
| `external_link` | The binding to a tracker work item. **Created on approval, never before** |
| `artifact_binding` | An artifact digest bound to an item revision |
| `closure_packet` | The evidence bundle assembled at closure |
| `protected_trust_anchor` | Pinned adapter identities and digests |
| `publication_transaction` | A publication attempt and its outcome |

### Tables that do NOT exist in production

`work_item`, `item`, `source`, `citation`, `candidate`, `publication`,
`rendering`. **Any code referencing these will fail with `no such table`.**
They belong to `schema/content-db.sql`, which production has never applied.

### Three things called "publication"

Corrected 2026-08-15 (T10, issue I-44). The word is overloaded across the
schema and the prose. This is the disambiguation; the rename itself (below)
is a schema change and is not done here.

| Name | What it actually is | Where it lives | Real today? |
| --- | --- | --- | --- |
| `publication` (table) | A row per accepted content item, closing a queue item. | `schema/content-db.sql`, line ~93 | **No.** Developer-only schema, never applied to production. Any script querying it fails with `no such table`. See `publish-approved-item.mjs`, `record-publication.mjs`, `reject-publication.mjs`, Step 13. |
| `publication_transaction` (table) | **The one that is real.** One row per publish attempt and its outcome: the exact artifact digest, the Gate 2 decision event, the PR head/base/tree/diff digests, the ADO external key. | `schema/migrations/002-two-track-authority.sql` | **Yes**, in the applied production schema, though `NO RUNTIME` today because nothing deployed can invoke `publish-approved-item.mjs` (Step 13). |
| `publication_authority` (table) | Not a record of publishing at all. Per `publication_transaction`, an append-only row binding the protected adapter's identity and digest, checked against the administrator-provisioned `protected_trust_anchor` for scope `publication`. Written by `recordPublicationAuthority` at the same time the transaction is recorded, one row per transaction, never updated or deleted. | `schema/migrations/005-protected-trust-anchors.sql` | **Yes**, applied. `NO RUNTIME` today for the same reason as `publication_transaction`: nothing deployed reaches the code path that would write a row. |
| "publication" (prose) | The informal noun for the *act* of publishing content live, i.e. Step 13 in this document, step 12-13 in the owner's mandate. Not a table at all. | everywhere in narrative docs | Refers to an event, not a row. |

**Remediation not done here:** the plan's remediation for I-44 is "rename two
of the three," which is a schema migration and a code change across every
script that references these tables, out of scope for a documentation-only
change. This table is the reconciliation the plan asked for: a reader can now
tell the three apart without guessing. The rename itself is a follow-up for a
build workstream.

### The state vocabulary

```
observed -> proposed -> gate1-pending -> gate1-approved -> ado-linked
  -> executing -> gate2-ready -> gate2-pending -> gate2-approved
  -> publication-* -> published -> ado-closure-ready -> closed
```

Terminal negatives: `denied`, `deferred`, `changes-requested`.

**Known defect:** `workflow_item.current_state` has no CHECK constraint, so a
typo persists silently as authoritative state. Issue I-25.

### The four gates

Two gate types, each on two tracks, which is four gates and four GitHub issues.

| Gate | Track | State | Held before |
| --- | --- | --- | --- |
| Gate 1 | discovery | `gate1-pending` | any model is called or anything is spent |
| Gate 1 | currency | `gate1-pending` | any model is called or anything is spent |
| Gate 2 | discovery | `gate2-pending` | publication, bound to the artifact digest |
| Gate 2 | currency | `gate2-pending` | publication, bound to the artifact digest |

---

## Step 0: Seed the artifacts container

**Status: BUILT.**

| Field | Value |
| --- | --- |
| Job | `caj-orch-seed-prod-eus-01`, manual trigger, 1800s timeout |
| Script | `seed-artifacts.mjs` |
| Identity | `id-p42orch-seed-prod-eus-01` |
| Reads | `/app/seed-inputs`, baked into the image at build time |
| Writes | `stp42orchstateprodeus01/orchestration-artifacts` |
| Database | none |
| Actor | operator, manual |

**Why the inputs travel inside the image.** The artifacts container is private
with no public network path, and there is no bastion or VPN. **No human can
reach it.** The seeding job is the only writer that can, so its inputs are
staged into `seed-inputs/` by the release and baked into the image. This is the
resolution of the seeding gap, where a design asserted an operational step no
operator could perform.

**On failure:** both tracks fail closed. They cannot run without their inputs.
**Known defect:** the release reports success without triggering this job or
verifying the container. Issue I-37.

---

## Step 1: Survey the approved sources (discovery)

**Status: BUILT.** Verified in production: 78 of 78 sources, 0 unevaluated.

| Field | Value |
| --- | --- |
| Job | `caj-orch-t1-sch-prod-eus-01` (cron `0 6 1 * *`) or `-t1-man-` |
| Entry | `orchard-production-runtime.mjs --track track-1` |
| Script | `discover-approved-sources.mjs` via `scripts/lib/track-1-controller.mjs` |
| Identity | `id-p42orch-t1-prod-eus-01` |
| Reads | the approved source registry; the public internet, egress-restricted |
| Writes | `workflow_run` (one row, `run_id` UUIDv7), `track-1-state` blobs |
| Transition | none yet |
| Actor | scheduler or operator |

**Egress.** The NSG denies arbitrary internet by default. Rule
`allow-approved-source-discovery` at priority 3900 sits ahead of
`deny-arbitrary-internet` at 4000. **A source not covered by that rule cannot
be read**, and this was a live defect once.

**Outcome counters, all recorded on the run:** `attempted`,
`successfully_evaluated`, `redirected`, `rate_limited`, `failed`, `skipped`,
`blocked`, `unevaluated`, `stale`, `exception_count`.

**`blocked` is counted separately from `failed` on purpose.** A source that
robots.txt or policy forbids is a correct outcome, not a run failure. Counting
them together previously made healthy runs look broken.

**On failure:** more than 15 failed sources fails the run. `unevaluated` must
be zero; a non-zero value means the survey did not finish and the run is not
`completed`.

---

## Step 2: Inspect the canonical corpus (currency)

**Status: BUILT AND RUNNING on the live estate.** Corrected 2026-09-06; the
paragraph this replaces was wrong. `stp42orchstateprodeus01` is the only state
account that has ever existed (created 2026-08-15; a subscription-wide storage
listing on 2026-09-06 shows no other), and `track-2-state` on it has been
written and read back repeatedly. The `caj-p42orch-t2-man-prod-eus-01-1u6i46c`
execution of 2026-08-22T17:47Z read 173 existing workflow items out of that
container, inspected all 183 canonical items, finalised its run and published a
new generation, and the chain check then downloaded that generation and counted
114 items waiting at `gate2-ready`. The orphaned account is
`stp42orchbkupwiaxgzgxhh7`, a BACKUP account from before the rename; no state
was lost with it. Issue I-06 is closed by observation.

A cold start -- no manifest, no generation, no database -- is covered by
`scripts/test-track2-state-roundtrip.mjs`, which runs a whole fenced Track 2
job through the real `BlobStateAdapter` and `withFencedState` and proves the
run creates and publishes a verified generation, that a second run downloads it
and holds nothing new because of it, and that clearing the container reverts
the third run to cold-start behaviour.

| Field | Value |
| --- | --- |
| Job | `caj-orch-t2-sch-prod-eus-01` (cron `0 6 15 * *`) or `-t2-man-` |
| Entry | `orchard-production-runtime.mjs --track track-2` |
| Script | `inspect-canonical-corpus.mjs` via `scripts/lib/track-2-controller.mjs` |
| Identity | `id-p42orch-t2-prod-eus-01` |
| Reads | the canonical corpus snapshot; Foundry, for inspection |
| Writes | `workflow_run`, `observation_event`, `run_outcome`, `track-2-state` |
| Actor | scheduler or operator |

**Spend ceiling: USD 34.00 per run**, enforced in-run. The proven run spent
USD 33.51 across 183 inspections and stopped cleanly.

**Issue I-12 is fixed.** A currency finding is now a `workflow_item` held at
`gate1-pending`, exactly as a discovery candidate is. Its semantic identity is
its SUBJECT -- the canonical item it is about -- and deliberately not the
classification, so one published file can have only one currency question in
front of a human at a time. The consequences of that choice are the dedupe and
supersession rules: an unchanged assessment is the same question and is skipped;
a CHANGED assessment supersedes the stale item through the lifecycle's own
`superseded` cause (migration 010) rather than sitting beside it; an item a
human denied, deferred or approved still occupies its subject and is never
re-proposed; and a closed subject is proposable again as a new item that records
its predecessor. Proven by `scripts/test-track2-gate.mjs`.

---

## Step 3: Propose candidates

**Status: BUILT.** Verified: 13 candidates from 63 sources with a body.

| Field | Value |
| --- | --- |
| Script | `scripts/lib/gate-queue.mjs`, called by the track controller |
| Reads | the survey results held in memory for this run |
| Writes | nothing yet; produces candidate objects |

**Scoring.** `scoreCandidate` in `scripts/lib/gate-queue.mjs`:

```
score = round((breadth * 10 + min(depth, 100) * 0.5) * 10) / 10
```

where `breadth` is `demandSourceCount` and `depth` is `demandOccurrences`.
Formula version `track1-demand-1.0.0`, recorded on every item so a score can
always be re-derived.

**There is no cutoff.** Every candidate is proposed regardless of score.
`score-opportunities.mjs` documents why in its own comments: a threshold would
turn a temporary measurement into a permanent policy, since low reachability
and a single-page catalogue scan both understate a real topic for reasons
that have nothing to do with the topic.

**Corrected 2026-08-15 (issue I-45).** Two design documents used to disagree
with this and with each other: `project42dev-ops/docs/adrs/0022-orchard-two-track-lifecycle.md`'s
request-intake amendment said a request is scored "above the cutoff," and
`project42dev-ops/docs/architecture/orchard-two-track-target-architecture.md`
described "no bypass of scoring, cutoff, or caps," both implying a score
floor exists. `lifecycle.md`'s "There is no cutoff score" section already
said the opposite. Both documents are now corrected to say there is no
cutoff, matching the code; no number was invented. Whether a floor should be
added is owner decision Q4 in the remediation plan, open.

**Surface determines destination:**

| Surface | Directory | Outcome |
| --- | --- | --- |
| `learning` | `content/modules/discovery` | `new-module` |
| `guide` | `content/reference` | `addition` |
| `guide-diagram` | `content/diagrams` | `addition` |

**Failure isolation.** Proposal construction happens **inside** the per-candidate
try block. It was once outside it, so one bad surface killed every candidate in
the run.

---

## Step 4: Persist candidates as held work

**Status: BUILT.** Verified twice, with idempotence proven
(`alreadyKnown: 13, persisted: 0` on re-run).

| Field | Value |
| --- | --- |
| Function | `persistDiscoveryItems` in `scripts/lib/gate-queue.mjs` |
| Database | the SQLite state database |
| **Table** | **`workflow_item`**, plus `item_revision` and `decision_event` |
| Writes | `recordItem` at `observed`, then two transitions, then `recordObservation` |

**The two transitions, in order:**

| From | To | Cause |
| --- | --- | --- |
| `observed` | `proposed` | `observation-recorded` |
| `proposed` | `gate1-pending` | `proposal-ready` |

**Deduplication.** `findExistingItem(db, track, semanticIdentity)`. If an item
with this semantic identity already exists on this track it is **not
re-proposed**, and the run logs `gate1.item.known` with the existing item id and
state. This is what makes a re-run idempotent.

**Consequence to understand:** the same rule means a subject already taken to
`closed` **cannot be re-proposed later**, which is why decommissioning has no
path. Issue I-27.

**On failure:** a single item failing to persist is counted in `failed` and does
not stop the others.

---

## Step 5: Announce the gate

**Status: BUILT.** Proven 2026-08-16 00:55Z: issue #24, 13 items, one batch.

| Field | Value |
| --- | --- |
| Script | `announce-gates.mjs` |
| Reads | `heldAtGate(db, gate, track)` over `workflow_item` |
| Writes | a GitHub issue in the target repository |
| Credential | read at runtime from `kv-p42orch-prod-eus-01` by the job's own identity |

**Not a Container Apps secret reference.** The token is fetched from the vault
at runtime, so rotating it does not require a redeploy.

**The manifest.** Each announcement carries a gate manifest with
`full_manifest_digest`, `batch_digest` and `idempotency_key`. **Batch size is
20**; more than 20 held items produce multiple issues, `batch 1/N`.

**`run_id` must be a UUIDv7.** `manifestRunId(db, track, fallback)` reads the
most recent `workflow_run.run_id` for the track. The Container Apps execution
name (`caj-orch-t1-man-prod-eus-01-4dq4gpj`) **is not a UUID**, and passing it
produced a manifest that failed validation while thirteen items sat held and
unmentioned.

**The issue marker uses `heldSetDigest`, not the contract's batch digest.** The
contract's batch digest hashes the run id, so it changes every run and would
open a fresh issue every month for the same unchanged work. `heldSetDigest`
hashes the sorted set of item ids, revisions and digests, so the marker is
stable while the held set is stable. Issue I-46.

**Corrected 2026-08-15.** `docs/adr/0025-gates-as-schema-bound-issues.md`
decision 9 said idempotency is "keyed on gate, run and batch digest," which is
the rule the builder had to override for the reason above. The ADR now
carries a correction note describing the override and why, rather than
stating the overridden rule as current. The `batch_digest` field itself is
still computed and persisted exactly as that ADR describes; only the issue
idempotency key uses the different value.

**Announcing can never fail the run.** Each gate is wrapped in its own
try/catch. A failure logs
`gate.announce.gate-failed ... "effect":"this gate still holds its work; nobody
was told about it"` and the run continues.

**Known defect:** the GitHub credential is a personal access token drawing on a
user-wide quota that Orchard does not control, and that quota is exhausted
continuously by six CI runner scalers. Issue I-08.

**The alert half of the mandate is not built.** The mandate is "a GitHub issue
**and an alert**". None of the four deployed alerts fires on work held at a
gate. Issue I-26.

---

## Step 6: Apply the owner's decision

**Status: BUILT for denial. Approval CANNOT be recorded.**

| Field | Value |
| --- | --- |
| Script | `apply-gate-decisions.mjs`, run at track **start**, before any work |
| Reads | open gate issues and their comments |
| Adapter | `scripts/adapters/github-gate/adapter.mjs`, identity `orchard.github-gate-adapter.v1` |
| Writes | `decision_event`, `workflow_item.current_state` |

**The adapter is pinned.** `scripts/lib/protected-adapter.mjs` hashes the entry file and
every reachable file, refuses any import that leaves the artifact root, and
refuses any package import. Its digest is recorded in
`protected_trust_anchor`. A modified adapter cannot execute.

**Why decisions are applied at the start of a run**, not on a webhook: the
runtime is a scheduled job with no ingress. It reads what happened since it last
ran.

**Authorised actors** are checked against a configured id list. A decision from
anyone else is refused and logged.

| Decision | Transition | Works? |
| --- | --- | --- |
| deny | `gate1-pending` -> `denied` | **yes** |
| defer | `gate1-pending` -> `deferred` | **yes** |
| request changes | `gate1-pending` -> `changes-requested` | **yes** |
| **approve** | `gate1-pending` -> `gate1-approved` | **NO** |

**Why approval fails.** `state-store.mjs:415-417` requires a positive integer
tracker work item id **with** the approval, and `getDispatchBinding` requires a
persisted `external_link` row. **`recordExternalLink` has zero callers**, so
that row can never exist.

**This inverts the design.** The design says approval **creates** the tracker
item. The code demands the tracker item **before** it will accept the approval.
Issue I-04.

---

## Step 7: Gate 1 review

**Status: NO RUNTIME.** `gate1-review.mjs` exists and **nothing deployed can
invoke it**. It also queries `work_item` and `candidate`, neither of which
exists in production. It fails twice over. Issues I-01 and I-03.

**Intended:** present the held set with its scoring evidence for review.

---

## Step 8: Create the tracker work item

**Status: NO RUNTIME, and the capability has never existed.**

**Orchard has never created an Azure DevOps work item and has never updated
one.** `ado-sync.mjs` is unreachable, queries `work_item`, and **shells out to
`az`, which is not in the image.** Three independent failures. Issues I-01,
I-03, I-07.

**Intended design, which is correct and unbuilt:**

| Field | Value |
| --- | --- |
| Trigger | an approval recorded at step 6, and nothing else |
| Destination | organisation `hybridcloudsolutions`, project `Project 42` |
| Creates | one work item per approved item |
| Writes | `external_link` binding the work item id to the Orchard item |
| Transition | `gate1-approved` -> `ado-linked` -> `executing` |

**Fields the work item must carry**, so it stands alone on the board: the
subject, what was found and why it scored as it did, the score and formula
version, the Orchard item id and revision, the semantic identity, the source
evidence references, the track, and links back to the gate issue and the
approving comment. The work item id and URL are written back into the gate
issue so both sides point at each other.

**Idempotence is mandatory.** The `external_link` row is the guard: if one
exists for this item, reuse it and create nothing.

**Transport must be the Azure DevOps REST API over `fetch`**, exactly as
`scripts/lib/github-issues.mjs` is, for exactly the same reason.

**Credential must not be a PAT.** Both existing PATs return 401. A service
principal or managed identity registered in the organisation, obtaining an AAD
bearer token for resource `499b84ac-1321-427f-aa17-267ca6975798`, works
unattended in a container and does not expire on a calendar.

---

## Step 9: Generate the brief

**Status: NO RUNTIME.** `generate-briefs.mjs` is unreachable and queries
`work_item`, `citation` and `source`, none of which exist. Issues I-01, I-03.

**Intended:** turn an approved item into an authoring brief carrying its
evidence and constraints.

---

## Step 10: Authoring

**Status: NOT BUILT in the deployed system.**

**No deployed job can author anything.** The eight-phase authoring engine
exists in `delivery/Dockerfile` with `delivery/Invoke-Project42Engine.ps1`. **That image
was never built or pushed.** `az acr repository list` on the registry returns
exactly one repository, `orchard-two-track`. Issues I-01, I-02.

**The consequence, stated plainly:** an item that reaches `executing` stops
there permanently. There is no mechanism by which it can proceed.

**The architecture decision that must be made first:** either the two runtimes
converge into one image, or the authoring engine is invoked as a separate
Container Apps job with its own identity, RBAC, timeout and **spend ceiling**.
This is a decision, not a code change, and it should be made explicitly.

---

## Step 11: Ingest the authored proposal

**Status: NO RUNTIME.** `ingest-proposals.mjs` is unreachable, queries
`work_item`, and shells out to `az`. Issues I-01, I-03, I-07.

**Intended transition:** `executing` -> `gate2-ready` -> `gate2-pending`, with
the artifact digest bound in `artifact_binding`.

---

## Step 12: Gate 2, publication approval

**Status: NO RUNTIME.** `gate2-review.mjs` and `apply-gate2-rework.mjs` are
unreachable; the latter queries `work_item`. Issues I-01, I-03.

**The design rule that must survive implementation:** **a Gate 2 approval is
bound to the exact artifact digest.** If the artifact changes, the approval
stops applying. This is what makes "approved" mean something specific rather
than something general.

---

## Step 13: Publish

**Status: NO RUNTIME.** `publish-approved-item.mjs`,
`record-publication.mjs` and `reject-publication.mjs` are all unreachable, and
the latter two query `publication`, which does not exist. The table that does
exist is `publication_transaction`. Issues I-01, I-03.

**Naming defect:** three different things are called "publication":
`publication`, `publication_transaction` and `publication_authority`. Two must
be renamed. Issue I-44. See "Three things called 'publication'" above for the
disambiguation; the rename itself is unbuilt.

---

## Step 14: Verify the published content is live

**Status: BUILT AND REACHABLE, unproven since repair.** Updated 2026-09-06.
Correcting the 2026-08-15 marker below, which said NO RUNTIME:
`run-verification.mjs` imports this script and is registered as the
`verification` phase in `scripts/orchard-production-runtime.mjs`.

`scripts/verify-published-live.mjs` fetches the published location and confirms
the content is actually serving before the item may move on to
`ado-closure-ready`. It refuses a bare 2xx, requires an item-derived marker in
the body, and treats a redirect away from the expected path as a failure.

Two defects have been fixed since this step was first written, and one remains:

- **Fixed.** It queried `publication` and `item`, tables the production schema
  has never had, so every run would have failed `no such table` and been logged
  as a serving fault. It now reads `publication_transaction` and
  `workflow_item`, and `PUBLISHED_ITEMS_SQL` is exported so a test can prove
  the statement compiles against the migrated schema.
- **Fixed 2026-09-06.** It composed the public URL by substituting a `{topic}`
  placeholder that no projected column supplied, so `expectedUrl` returned "did
  not fully resolve" for **every** item and live verification silently verified
  nothing. The public route is now derived from the item's own
  `publication_transaction.target_path`, per surface, by
  `publicPathForTarget()`: `modules/<pathId>/<moduleId>.json` becomes
  `/learn/<pathId>`, `resources/<pack>/<resourceId>.json` becomes
  `/guide/resources/<resourceId>`, and `diagrams/<id>.mmd` becomes
  `/guide/diagrams/<id>`. The surface is derived from the path too, not read
  from a column, because the column and the configuration file used two
  different vocabularies for one fact.
- **Still open.** The check is correct and proven by hand against the live
  portal, but no production run has been observed since the repair. Because it
  was reachable throughout, the second defect above was not a dormant bug: the
  phase executed and reported zero items serving on every run.

**Corrected 2026-08-15.** This step was missing entirely from
`docs/lifecycle.mmd` (Issue I-48); the diagram jumped straight from
publication to closure with no node for verification. It now has one, node
`B11V`, styled the same dashed `notbuilt` as every other step past the
denial branch of Gate 1. See "The two Mermaid lifecycle diagrams" below.

---

## Step 15: Close, and assemble the closure packet

**Status: NOT BUILT.**

**Intended:** assemble `closure_packet` with the evidence chain, close the
tracker work item, and transition `ado-closure-ready` -> `closed`.

---

## Step 16: Decommission

**Status: NOT DESIGNED AND NOT BUILT. This is the largest hole in the system
relative to its stated purpose.**

`scripts/lib/state-machine.mjs` terminates at `closed` **with no re-entry**, and the
deduplication rule at step 4 actively prevents a future currency run from
re-proposing a subject that already has an item. **So content that becomes
obsolete, superseded or wrong has no path to retirement and cannot be
revisited.**

The tool is called lifecycle management and the lifecycle has no end. Before
this can be designed, "retirement" has to be defined: unpublish, mark
superseded, archive, or delete. Issue I-27.

---

## The two Mermaid lifecycle diagrams

Corrected 2026-08-15 (T10, issue I-48). Two static Mermaid lifecycle diagrams
are committed, and they used to disagree with each other and with this
document:

1. **`docs/lifecycle.mmd`**, embedded in `lifecycle.md`. Sixteen
   machine states and two authority gates, the same shape this document uses.
   Was missing a node for Step 14, live verification, entirely, and drew
   almost everything past Gate 1 as solid, built edges.
2. **`project42-platform/content/diagrams/orchard-lifecycle.mmd`**, rendered on the public
   interactive guide site. Fourteen owner-mandate steps across three intake
   lanes. Draws the same overstatement: its `currencyRecord`-`issue1` edge and
   everything from `approvedTracker` through `commitPush` are solid, though
   only two of those (the currency edge and the tracker-item creation on
   approval) are even reachable enough to have a specific issue number, I-12
   and I-04; the rest are simply `NO RUNTIME` per Steps 7 through 13 above.

**Resolution.** Both diagrams describe the same lifecycle at different
altitudes and are meant to keep existing side by side; deleting either loses
an audience (this document's technical reader, or the public site's
narrative reader). What made them "conflicting" was not that two exist, it
is that both told a story the code disproves. `lifecycle.mmd` is corrected:
it now has a node for Step 14 and every step this document marks `NO
RUNTIME` or `NOT BUILT` is styled dashed. `project42-platform/content/diagrams/orchard-lifecycle.mmd`
is not corrected here. Its data is `graph.ts` in `project-42.dev` (this named
`guide.project-42.dev`, a repository archived in September 2026 when the estate
consolidated onto one origin), application code in a different repository, and
its SVG is checksum-pinned
in `project42-platform/content/diagrams/catalogue.json`; editing the Mermaid source without
regenerating the SVG and updating that hash would fail the site's own
consistency check rather than fix anything, and this is a documentation
change with no build tooling available to it. **Follow-up:** apply the same
`pending: true` treatment `graph.ts` already uses for `requestIntake` and
`verifyLive` to `currencyRecord`, `approvedTracker`, `orchestration`,
`storeWritten`, `issue2`, `gate2`, `rework` and `commitPush`, regenerate
`project-42.dev/public/diagrams/orchard-lifecycle.svg`, and update its `sourceSha256` and
`svgSha256` in `project42-platform/content/diagrams/catalogue.json`. Tracked against T9, which
already owns that diagram's dead links.

---

## Failure modes that are not in the failure analysis

The existing failure analysis has 24 scenarios. **None of them is the failure
that actually happened**, twice. Both belong in it:

1. **Code writes to a table absent from the deployed schema.** Symptom:
   `no such table`. Cause: two schemas, only one applied, no document says so.
   Detection: run every script against a database built only by
   `migrateContentDb`.
2. **Code invokes a binary absent from the image.** Symptom: spawn failure.
   Cause: the script was written and tested on a workstation where `az`, `gh`
   and PowerShell are all present. Detection: the image is
   `node:22-bookworm-slim` plus `ca-certificates` and `git`; assume nothing
   else exists.

A third, from the same family, is worth adding:

3. **A script exists, is correct, and nothing can invoke it.** Symptom: no
   symptom at all, which is what makes it dangerous. Detection: trace imports
   from the deployed entry points and compare against the script inventory.
   **Nine of thirty-four scripts are currently reachable.**

---

## Summary of what actually runs

| Steps | Status on 2026-08-15 | Status on 2026-09-06 |
| --- | --- | --- |
| 0 to 6 | built; step 2 unproven; step 6 approval broken | built and running |
| 7 to 13 | **no runtime** | **running in production.** Brought up 2026-08-16 to 2026-08-20; the first publication run merged nine items on 2026-08-19 |
| 14 | recorded as no runtime, which was wrong: it is the `verification` phase of the production runtime | built and reachable; repaired 2026-09-06 after resolving a URL for **no** item at all; unproven in production since |
| 15 | not built | closure packet and owner acceptance are in the machine; not separately re-verified here |
| 16 | not designed | not designed |

The 2026-08-15 sentence that stood here — "Orchard today finds work and holds it
at a gate, and nothing downstream of that gate exists as a running system" — was
true when written and was superseded within a week. It is quoted rather than
deleted because a status claim that quietly disappears teaches nobody anything.
[Status](status.md) carries the evidence.
