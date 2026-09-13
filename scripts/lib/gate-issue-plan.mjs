// Decide WHICH issues announce which held items, before anything is written.
//
// WHY THIS EXISTS. On 2026-09-12 Track 2 left 53 open Gate 2 issues behind in
// one evening, 24 distinct "generations" of the same growing item set, and the
// owner refused to read any of them. The cause was in the issue identity, not
// in the gate: announce-gates.mjs keyed each issue on heldSetDigest of that
// batch's exact items, and sizedBatches (lib/gates.mjs) re-chunks the WHOLE
// pending set every run. A Track 2 Gate 2 item embeds its full artifact, so a
// batch holds about three items, and every newly discovered finding sorts last
// (item ids are UUIDv7, so they are time-ordered) and lands in the tail batch.
// The tail batch's digest therefore changed on every single pass, its marker
// stopped matching, and openOrUpdateGateIssue opened a NEW issue instead of
// updating the one that was already there. 1 -> 2 -> 4 -> 7 -> ... -> 83 items,
// each step stranding the previous tail.
//
// THE FIX IS TO STOP DERIVING IDENTITY FROM MEMBERSHIP. An issue's identity is
// the issue itself: this plans against the issues that are ALREADY OPEN, read
// once per gate per run, and only opens an issue for work that no open issue
// announces. A growing set therefore adds an issue; it does not replace all of
// them.
//
// TWO RULES THAT LOOK LIKE OPTIMISATIONS AND ARE NOT. Both protect the bare
// `approve` comment, which names no item and is re-read on every run:
// apply-gate-decisions.mjs expands it over whatever is pending ON THAT ISSUE at
// the moment it is evaluated (ADR-0025, amendment 2026-08-16).
//
//   1. AN ISSUE'S ITEM SET NEVER GROWS. Items may leave a group (decided,
//      superseded, reworked); nothing is ever added to a group that already has
//      an issue. Packing a newly discovered item into a half-full existing
//      issue would mean an owner's earlier bare `approve` silently approving
//      work that was not on the page when they wrote it. Fresh items always get
//      a fresh issue.
//
//   2. AN ITEM IS MATCHED BY ITS WHOLE ANNOUNCED TRIPLE -- id, revision, and
//      the digest the decision binds to -- never by id alone. A reworked item
//      coming back at a new revision is NOT the item that was announced before;
//      it is fresh, and it gets a fresh issue, so that neither a bare approve
//      nor a stale typed command can reach across a revision the owner never
//      saw. This is the same key heldSetDigest already hashes, applied per item.
//
// WHAT THIS FILE CANNOT DO. It never decides an item's outcome and never
// changes one. It chooses which GitHub issues exist and which are closed, and
// nothing else. The decision binding lives entirely in capture-gate-decision.mjs
// and is checked against the manifest embedded in the issue body at the moment
// a comment is read, so moving an item's announcement between issues cannot
// loosen it: a command naming an item the issue's manifest does not offer is
// refused with binding.item, and one naming a digest or revision the manifest
// does not carry is refused with binding.digest / binding.stale-revision.

import { manifestFromIssueBody } from "../adapters/github-gate/adapter.mjs";

/** The exact thing an issue announced about an item, and the thing a decision binds to. */
export function announcedTriple(gate, item) {
    if (gate !== "gate-1" && gate !== "gate-2") throw new TypeError("gate must be gate-1 or gate-2");
    const digest = gate === "gate-1" ? item.proposal_digest : item.artifact_digest;
    return `${item.item_id}:${item.item_revision}:${digest}`;
}

const MARKER = /<!-- orchard:gate track=[^ ]+ gate=[^ ]+ [^>]*-->/;

/** The hidden marker an issue already carries, or null. Never recomputed from the items. */
export function markerOf(body) {
    return MARKER.exec(String(body ?? ""))?.[0] ?? null;
}

/**
 * Which of several open issues keeps an item that all of them announce.
 *
 * IN STEADY STATE THIS NEVER FIRES: once the open issues partition the pending
 * set, each triple is on exactly one issue and there is nothing to choose. It
 * exists for the one-time cleanup of an estate that already has generations of
 * duplicates, and the order is chosen for what it preserves:
 *
 *   1. An issue somebody has COMMENTED on outranks one nobody has touched. A
 *      decision comment is the whole point of the gate; closing the issue it
 *      sits on would strand it.
 *   2. Then the most recently updated, because an orphaned generation is
 *      precisely an issue the announcer stopped updating.
 *   3. Then the highest number, so the choice is total and deterministic.
 */
export function rankIssue(issue) {
    return [
        Number(issue.comments ?? 0) > 0 ? 1 : 0,
        Date.parse(issue.updated_at ?? 0) || 0,
        Number(issue.number),
    ];
}

function better(left, right) {
    const a = rankIssue(left);
    const b = rankIssue(right);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? left : right;
    }
    return left;
}

/**
 * The plan: which issue announces what, and which issues are finished.
 *
 * Returns { groups, close, unreadable }.
 *   groups     one per issue that will exist after this pass, in issue-number
 *              order with new issues last. { issueNumber, marker, items }.
 *              issueNumber is null for an issue that does not exist yet.
 *   close      open issues that announce nothing still pending, each with the
 *              reason, the items that moved, and which issues took them.
 *   unreadable open issues whose body carries no manifest this can trust. They
 *              are left alone: an issue whose contents cannot be read is one
 *              whose contents cannot be proven finished either.
 *
 * `chunk` splits the items no open issue announces. It is the caller's batching
 * rule (lib/gates.mjs sizedBatches), injected so this file stays pure.
 */
export function planGateIssues({ gate, openIssues = [], pendingItems = [], chunk = (items) => (items.length ? [items] : []) }) {
    if (gate !== "gate-1" && gate !== "gate-2") throw new TypeError("gate must be gate-1 or gate-2");

    const pendingByTriple = new Map();
    for (const item of pendingItems) {
        const triple = announcedTriple(gate, item);
        if (pendingByTriple.has(triple)) throw new Error("the pending set offers the same item twice");
        pendingByTriple.set(triple, item);
    }

    const readable = [];
    const unreadable = [];
    for (const issue of [...openIssues].sort((left, right) => Number(left.number) - Number(right.number))) {
        const marker = MARKER.exec(String(issue.body ?? ""))?.[0] ?? null;
        let announced;
        try {
            announced = manifestFromIssueBody(issue.body).items.map((item) => announcedTriple(gate, item));
        } catch (error) {
            unreadable.push({ issueNumber: Number(issue.number), reason: error.message });
            continue;
        }
        if (!marker) {
            unreadable.push({ issueNumber: Number(issue.number), reason: "the issue body carries no gate marker" });
            continue;
        }
        readable.push({ issue, number: Number(issue.number), marker, announced: [...new Set(announced)] });
    }

    // Every open issue that offers a triple is a candidate to keep it; the
    // ranking picks one, and only one.
    const candidates = new Map();
    for (const entry of readable) {
        for (const triple of entry.announced) {
            if (!pendingByTriple.has(triple)) continue;
            const current = candidates.get(triple);
            candidates.set(triple, current ? better(current.issue, entry.issue) === entry.issue ? entry : current : entry);
        }
    }

    const anchored = new Map(readable.map((entry) => [entry.number, []]));
    for (const [triple, entry] of candidates) anchored.get(entry.number).push(triple);

    const groups = [];
    const close = [];
    for (const entry of readable) {
        const kept = anchored.get(entry.number);
        // RULE 1: a group only ever shrinks. `kept` is a subset of what this
        // issue already announced, never a superset, because it is drawn from
        // this issue's own announced triples.
        if (kept.length > 0) {
            groups.push({
                issueNumber: entry.number,
                marker: entry.marker,
                items: entry.announced.filter((triple) => kept.includes(triple)).map((triple) => pendingByTriple.get(triple)),
            });
            continue;
        }
        const moved = entry.announced
            .filter((triple) => pendingByTriple.has(triple))
            .map((triple) => ({ triple, item: pendingByTriple.get(triple), to: candidates.get(triple).number }));
        close.push({
            issueNumber: entry.number,
            moved,
            settled: entry.announced.filter((triple) => !pendingByTriple.has(triple)),
            supersededBy: [...new Set(moved.map((entry_) => entry_.to))].sort((a, b) => a - b),
            // Retained so the caller can refuse to close an issue whose items
            // did not actually land somewhere else this pass.
            pendingTriples: moved.map((entry_) => entry_.triple),
        });
    }

    const claimed = new Set(candidates.keys());
    const fresh = [...pendingByTriple.entries()].filter(([triple]) => !claimed.has(triple)).map(([, item]) => item);
    for (const batch of chunk(fresh)) groups.push({ issueNumber: null, marker: null, items: batch });

    // NO ITEM MAY BE SILENTLY DROPPED FROM ANNOUNCEMENT. The whole point of a
    // gate is that a human is told what is waiting; an item that is held and
    // named by no open issue is held in silence, which is the failure this file
    // exists to prevent and is worse than the sprawl it replaces. So the
    // partition is asserted, not assumed, and a plan that does not cover every
    // pending item exactly once is refused outright rather than half-applied.
    const planned = groups.flatMap((group) => group.items.map((item) => announcedTriple(gate, item)));
    if (planned.length !== pendingByTriple.size || new Set(planned).size !== planned.length) {
        throw new Error(`gate issue plan does not announce each pending item exactly once (${new Set(planned).size} of ${pendingByTriple.size})`);
    }
    for (const triple of pendingByTriple.keys()) {
        if (!planned.includes(triple)) throw new Error("gate issue plan drops a pending item from announcement");
    }
    // NEVER CLOSE THE SOLE ANNOUNCEMENT OF A PENDING ITEM. Structurally an
    // issue only reaches `close` when every pending item it offered was
    // anchored elsewhere, so this can only fire if the anchoring above is
    // changed to something that does not cover what it releases. It is checked
    // anyway, because the cost of being wrong here is an item nobody is ever
    // told about.
    const announcedSomewhere = new Set(planned);
    for (const entry of close) {
        for (const triple of entry.pendingTriples) {
            if (!announcedSomewhere.has(triple)) {
                throw new Error(`issue #${entry.issueNumber} would be closed while it is the only announcement of a pending item`);
            }
        }
    }

    return { groups, close, unreadable };
}

/**
 * The comment a closure leaves behind, naming why and where.
 *
 * A closure is never silent: an owner scrolling back has to be able to see that
 * this issue ended because its work moved, not because anything was decided.
 * Nothing here decides or changes an item's outcome.
 */
export function closureComment({ issueNumber, moved, settled, supersededBy, states = {} }) {
    const lines = [
        "Closing this issue: it no longer announces anything that is waiting for you.",
        "",
        "**No decision was made, and nothing about any item's outcome changed by this closure.** This is bookkeeping only: earlier runs opened a new issue for the same growing set of items instead of updating the one already open, and this is one of the duplicates.",
        "",
    ];
    if (moved.length > 0) {
        lines.push("Still waiting, and now announced on another issue:", "");
        for (const entry of moved) {
            lines.push(`- \`${entry.item.item_id}\` (${entry.item.target?.path ?? "unknown target"}) -- decide it on #${entry.to}`);
        }
        lines.push("");
    }
    if (settled.length > 0) {
        lines.push("No longer waiting at this gate:", "");
        for (const triple of settled) {
            const itemId = triple.split(":")[0];
            const state = states[itemId];
            lines.push(`- \`${itemId}\`${state ? ` -- now \`${state}\`` : ""}. If it comes back to this gate it will be announced again, on a new issue, at whatever revision it comes back as.`);
        }
        lines.push("");
    }
    if (supersededBy.length > 0) lines.push(`Superseded by ${supersededBy.map((number) => `#${number}`).join(", ")}.`);
    else lines.push("Nothing on this issue is still waiting, so there is nothing to supersede it.");
    lines.push("", `Closed by the Gate reconciliation pass, which runs on every Track pass and closes only an issue that is not the sole announcement of anything still pending. Issue #${issueNumber}.`);
    return lines.join("\n");
}
