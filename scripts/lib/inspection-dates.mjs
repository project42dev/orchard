// What "today" is, said to a model that cannot know it, and the one finding a
// model without it keeps producing.
//
// FOUND LIVE 2026-09-13, on item 01a024de-1918-7baf-985c-252d89570314
// (resources/research-verification/fact-verification-workflow.json). The
// Track 2 currency inspector called that file's lastVerified of 2026-07-25 "a
// future date". The inspection ran in September 2026. The inspector's request
// (lib/foundry-inspection-producer.mjs inspectionRequest) carried the digest-
// bound policy text, the security boundary and the canonical source, and not
// one word about the current date; the policy text itself
// (project42dev-ops/deployment/config/orchard-track-2-inspection-policy-v1.txt)
// has none either. A model whose training cutoff precedes the date it is
// judging reads every recent date as the future. The delivery engine learned
// this the hard way in Get-DeliveryRolePrompt (Invoke-Project42Delivery.ps1)
// and grounds every ensemble role; the inspector was never given the same.
//
// The finding became a Gate 1 item, the item became a brief, and the drafter
// -- which IS told the date -- correctly refused to act on it:
// "The inspection's characterization of 2026-07-25 as a future date conflicts
// with the stated current date of 2026-09-13".
//
// Two defences, because the first is a request and the second is a rule:
//   1. currentDateGrounding() goes into the inspector's instructions.
//   2. withdrawFalseFutureDateEvidence() drops any evidence entry that calls a
//      date the future when every date it names is on or before today. A
//      model that ignores (1) still cannot turn the mistake into work.

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// "future", "future-dated", "in the future", "has not yet occurred",
// "has not happened yet". Deliberately narrow: the claim being refused is
// specifically that a date has not arrived.
const FUTURE_CLAIM = /\bfuture\b|\bhas(?: not|n't) (?:yet )?(?:happened|occurred|arrived)\b|\bnot yet (?:happened|occurred|arrived)\b/i;

/** YYYY-MM-DD in UTC for a Date, an ISO string, or a function returning either. */
export function isoDateOf(now = new Date()) {
    const value = typeof now === "function" ? now() : now;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError(`not a valid date: ${String(value)}`);
    return date.toISOString().slice(0, 10);
}

/** The grounding paragraph, in the same terms the delivery engine uses. */
export function currentDateGrounding(today) {
    return [
        `Today's date is ${today} (UTC), and it is real.`,
        "It is later than your training cutoff. A date on or before today is in the past or present and is NEVER a future date,",
        "however recent it looks to you. Do not report a date on or before today as future-dated, not-yet-occurred, or fabricated,",
        "and do not classify content as needing change on that basis. A date is only in the future if it is strictly later than today.",
    ].join(" ");
}

/**
 * True when `text` claims a date is in the future and every YYYY-MM-DD date it
 * names is on or before `today`. Text naming no date is never matched: there
 * is nothing to check it against, and dropping it would be guessing.
 */
export function isFalseFutureDateClaim(text, today) {
    if (typeof text !== "string" || !FUTURE_CLAIM.test(text)) return false;
    const dates = [...text.matchAll(ISO_DATE)].map((match) => match[0]);
    if (dates.length === 0) return false;
    return dates.every((date) => date <= today);
}

/**
 * Remove evidence built on a false future-date claim.
 *
 * Returns { classification, evidence, withdrawn }. When an actionable finding
 * loses ALL of its evidence it is not a finding any more: it becomes
 * evidence-backed-no-change, with one evidence line naming exactly what was
 * withdrawn and why, so the record says what happened instead of silently
 * changing the verdict. Throwing instead would fail the whole 183-item
 * inspection run on one wrong sentence.
 */
export function withdrawFalseFutureDateEvidence({ classification, evidence }, today, maxEntryLength = 500) {
    const entries = Array.isArray(evidence) ? evidence : [];
    const withdrawn = entries.filter((entry) => isFalseFutureDateClaim(entry, today));
    if (withdrawn.length === 0) return { classification, evidence: entries, withdrawn };
    const kept = entries.filter((entry) => !isFalseFutureDateClaim(entry, today));
    // Other evidence survives: the finding stands on that evidence alone.
    if (kept.length > 0) return { classification, evidence: kept, withdrawn };
    // Nothing survives: whatever the model concluded, it concluded on a date
    // error, so there is no finding. The note keeps the evidence list non-empty,
    // which every downstream contract requires, and says why.
    return { classification: "evidence-backed-no-change", evidence: [withdrawalNote(withdrawn, today, maxEntryLength)], withdrawn };
}

function withdrawalNote(withdrawn, today, maxEntryLength) {
    const first = withdrawn[0].replace(/\s+/g, " ");
    return `Withdrawn by Orchard: the inspection ran on ${today}, and ${withdrawn.length} evidence entr${withdrawn.length === 1 ? "y" : "ies"} called a date on or before that day a future date, which it is not. First withdrawn entry: ${first}`.slice(0, maxEntryLength);
}
