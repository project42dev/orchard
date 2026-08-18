# Rejection gate: closing the loop on ensemble-blocked content

Owner request, 2026-08-18, verbatim intent: when the authoring ensemble
blocks an item, the pipeline should try again automatically at least once,
log what happened to the linked ADO work item so it is auditable, and if
it is rejected a second time, escalate to a human with the full rejected
document and the real reason, not a generic note. The human can override
the ensemble and let the item proceed, or confirm the rejection and let it
drop. This applies to every surface (`learning` and `field-guide` both go
through the same `curriculum-writing` / `factual-verification` /
`assessment-review` stages and the same `blocked` state -- nothing here is
surface-specific).

## Why this reuses Gate 2's existing grammar instead of inventing a new one

`scripts/adapters/github-gate/adapter.mjs` is a pinned, trust-anchor-hashed
file: `lib/protected-adapter.mjs` verifies its digest before trusting any
decision it parses. Inventing a new decision verb (`reject-gate override`,
`reject-gate confirm`) would mean editing that file and re-running
`provision-trust-anchor.mjs`, a security-sensitive operation this design
avoids entirely by not needing it. `approve` and `deny` on a Gate 2 issue
already mean exactly what is needed here:

- **Owner overrides the ensemble** (disagrees with the rejection, wants it
  to proceed) -> the SAME `/orchard gate2 approve item=... revision=...
  digest=...` command a normal Gate 2 approval uses. It publishes the
  rejected draft, because publishing IS the normal Gate 2 approval action.
- **Owner confirms the rejection** (agrees it is bad) -> the SAME
  `/orchard gate2 deny item=... revision=... digest=... reason="..."`
  command a normal Gate 2 denial uses. The item lands in `denied`, exactly
  where a track-1 approver's ordinary "no" already lands an item tonight.
  That state is not a dead end: `apply-blocked-retry.mjs`'s `denied ->
  executing` recovery (built earlier this session) can bring it back for a
  fresh authoring attempt whenever anyone decides to, which is precisely
  the "back burner, double-check later" behavior asked for -- no new
  terminal state, no new decommissioning mechanism, reusing the one that
  already exists and is tested.

The only genuinely new pieces are: (1) when to auto-retry, (2) when to
escalate instead of retrying again, (3) capturing evidence rich enough to
make escalation worth reading, and (4) a distinct title/lead so the
escalated issue does not look like an ordinary publication-ready batch.

## State machine change: exactly one new transition

`blocked -> gate2-ready`, cause `"escalated-for-human-review"`, allowed
only when the item has already been blocked twice (see below). This is the
same shape as the two recovery rules added earlier tonight
(`blocked -> executing`, `gate2-ready -> executing`) -- a named exception,
gated on a real precondition, not a generic escape hatch. `run-gate2-prep`'s
existing `gate2-ready -> gate2-pending` announcement path picks it up
completely unmodified: the escalation looks, to the announcer, exactly
like a normal item that just finished authoring, except its evidence
carries a failed factual_review with a real reason and its rationale field
carries the actual rejected content.

## Counting blocks: `attempt_count`, not a new column

`state_transition_event` already has one row per transition. "This item
has been blocked twice" is `SELECT COUNT(*) FROM state_transition_event
WHERE item_id = ? AND to_state = 'blocked'`. No new column, no new table.
Two thresholds:

- **count == 1** (first block ever for this item): auto-retry. Call the
  same `applyRetry` function `apply-blocked-retry.mjs` already exports,
  inline, in the same fenced state operation that just recorded the block
  -- no second job execution, no lease re-acquisition race.
- **count >= 2** (already retried once, blocked again): escalate. Do NOT
  retry a third time automatically -- two real authoring attempts already
  spent real Foundry cost; a third blind attempt is the owner's call, not
  the pipeline's.

## Evidence capture: what actually gets shown, and where it lives

Today `ingest-proposals.mjs` records exactly one string for a block:
`` `${disposition} by the authoring ensemble, ${file}` `` -- confirmed live
2026-08-18 to be the ENTIRE extent of what survives once the authoring
container exits. This design fixes that for every block, not just
escalated ones, because the ADO audit trail the owner asked for needs it
on attempt one too.

New function `buildRejectionEvidence(proposal)` in
`lib/prepare-gate2-evidence.mjs`, called from the same place
`run-authoring.mjs` already calls `reconstructStageContent` for the
drafter stage:

- `draft`: `reconstructStageContent` of the `curriculum-writing` stage --
  the actual rejected document, the same reconstruction function that
  already proved out this session, just pointed at a blocked proposal
  instead of a passed one.
- `verifierFinding`, `adversaryFinding`, `arbiterResolution`:
  `reconstructStageContent` of `factual-verification`, `assessment-review`,
  and (if present) the arbiter's resolution note -- the actual critique
  text, not the verdict label.
- `verdicts`: the raw PASS/FAIL and STANDS/REFUTED strings, kept alongside
  the prose so a human does not have to parse it back out.

This whole object is persisted as one `observation_event`
(`evidence_reference: orchard/rejection-evidence/{itemId}:r{revision}`),
the same mechanism `prepare-gate2-evidence.mjs` already uses for gate2
evidence -- it survives the container. `blockedNoteFor`'s reason field
still gets the short one-liner (unchanged, for anything that reads it
today); the rich evidence is the observation, read explicitly by name.

## ADO comment on every block, not just the escalated one

`ado-sync.mjs` gets one new call, alongside the existing
`tracker.update.moved` comment: when a transition to `blocked` is synced,
post a second comment carrying `verifierFinding` and `adversaryFinding`
(truncated to ADO's comment size limits, full text stays in the
observation_event and the eventual GitHub issue). This is the audit trail
the owner asked for -- readable on the ADO ticket itself, no digging
required, on the FIRST block, before anyone decides whether escalation is
even needed.

## The escalated issue itself

Same `renderGateIssueBody`/`renderGateIssue` machinery as every other Gate
2 issue, with two additions gated on a new `manifest.items[].escalated:
true` flag (schema-additive, not a new gate type):

- **Title and lead change** when any item in the batch is escalated:
  `Orchard Gate 2: N items rejected twice, needs your call (Discovery)`
  instead of the normal `N items awaiting publication` -- the "this is
  different" signal the owner asked for, without a new issue label or a
  new decision grammar underneath it.
- **The rendered body shows the real reason** (`verifierFinding` /
  `adversaryFinding`, not "factual review failed") and **the full rejected
  draft**, inline, in a fenced block under its own heading -- not
  collapsed behind `<details>` the way binding digests are. The owner
  asked to read the whole thing, not click to expand it; digests are noise
  to hide, the actual content under dispute is not.
- Everything else (the approve/deny command block, the collapsed binding
  details, the embedded machine-readable manifest) is byte-identical to
  every other Gate 2 item, because the decision mechanism IS identical.

## What each decision does, concretely

| Owner comment | State machine effect | What happens next |
| --- | --- | --- |
| `/orchard gate2 approve item=... revision=... digest=...` | `gate2-pending -> gate2-approved` (unchanged existing path) | Publication runs on the REJECTED draft, exactly as it would for a clean item -- the owner's read is the final check, matching "then it moves onto the normal process" |
| `/orchard gate2 deny item=... revision=... digest=... reason="..."` | `gate2-pending -> denied` (unchanged existing path) | Item sits denied. Nothing auto-retries it again (the one auto-retry already happened before escalation). A human can bring it back later via `apply-blocked-retry.mjs`'s existing `denied -> executing` recovery whenever anyone decides to -- this IS the "back burner" the owner asked for |

## Surfaces

Nothing above branches on `item.surface`. `curriculum-writing` /
`factual-verification` / `assessment-review` / `release-proposal` are the
same four stages regardless of whether the target is `learning` or
`field-guide` content (`DIRECTORY_BY_SURFACE` only affects the target
path, never the ensemble stages). Confirmed by reading
`gate-queue.mjs:targetForCandidate` and `STAGE_ORDER` in
`prepare-gate2-evidence.mjs` -- both are surface-agnostic already.

## What is explicitly NOT built here

- No new GitHub issue label, no new adapter decision verb, no trust-anchor
  re-provisioning.
- No third automatic retry. Two real authoring attempts is the ceiling;
  a third is always a human decision.
- No automatic re-proposal suppression for a confirmed-bad topic (a
  `deny` on this gate does not stop the SAME semantic identity from being
  discovered again in a future track-1 run). Flagging this as a known gap,
  not solving it tonight -- it is a discovery-side dedup question, a
  different subsystem, and out of scope for closing this specific loop.
- **The ADO comment on every block, deliberately deferred, not silently
  dropped.** Investigated live: `ADO_STATE_MAP` maps both `executing` and
  `blocked` to the same ADO state (`Active`), so `ado-sync.mjs`'s existing
  state-drift comment mechanism (`transitionComment`) never fires for a
  block at all -- confirmed by checking a real item's ADO comment history
  and finding no block-related comment ever posted, for any item, ever.
  Posting one for real requires wiring ADO client credentials into
  `run-authoring.mjs`, which does not have them today (only
  `orchard-production-runtime.mjs`'s separate sync path does) -- new
  credential wiring into a new file, under real time pressure, is exactly
  the kind of change that deserves its own careful pass rather than being
  rushed in alongside everything else here. The evidence itself IS
  captured durably regardless (the `observation_event` `--admin-show-reason`
  now reads), so nothing is lost -- it is one click further from the ADO
  board than the owner asked for, until this is picked up.
