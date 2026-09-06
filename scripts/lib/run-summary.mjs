import { openOrUpdateGateIssue, resolveUserLogin } from "./github-issues.mjs";

const TRACK_LABELS = Object.freeze({ "track-1": "Discovery", "track-2": "Currency" });
const trackLabel = (track) => TRACK_LABELS[track] ?? track;

export function releaseSummaryMarker({ version }) {
    return `<!-- orchard:summary release=v${version} -->`;
}

/**
 * True when a run's gate announcements produced nothing for the owner to
 * see -- announceGates() returns [] when there is no repo/token configured,
 * or a list of { gate, action, count } entries where an empty gate is
 * { action: "empty", count: 0 }. A zero-delta run is one where every gate
 * entry is empty (or there were no entries at all).
 *
 * Exported and unit-tested on its own: this predicate previously lived
 * inline in orchard-production-runtime.mjs checking a.items and
 * a.action === "none", neither of which announceGates() ever produces, so
 * the zero-delta summary silently never fired. Keeping the real field names
 * (action / count) as an explicit, testable contract is what prevents that
 * regressing again.
 */
export function isZeroDeltaRun(announced) {
    return !announced || announced.length === 0 || announced.every((a) => a.count === 0 || a.action === "empty");
}

export function runSummaryMarker({ track, runId }) {
    return `<!-- orchard:summary track=${track} run=${runId} type=run -->`;
}

/**
 * What the run measured, in one shape both tracks can be rendered from.
 *
 * THE POINT OF THIS FILE. Source attribution was made loud in the wrong
 * place: a run computes coverage, names every silent source and exits 4 below
 * the threshold, and every word of that reaches the owner only through an exit
 * code and a structured log he does not read. The GitHub issue IS the
 * deliverable, so the verdict has to be IN the issue.
 *
 * The controller's own output file is the input, because it is the record of
 * what actually happened rather than a second measurement taken here. Field
 * names are copied from the producers deliberately -- attribution.coverage
 * carries `expected`/`evaluated` and NOT `attempted`, which lives on
 * run.coverage -- because a field-name mismatch in exactly this path is why
 * the zero-delta summary once never fired at all.
 */
export function runVerdict({ track, output }) {
    if (!output) return null;
    return track === "track-2" ? track2Verdict(output) : track1Verdict(output);
}

function ratioOf(evaluated, expected) {
    return expected > 0 ? evaluated / expected : 0;
}

function causeOf(entry) {
    if (entry.outcome && entry.reason) return `${entry.outcome}/${entry.reason}`;
    return entry.outcome ?? entry.reason ?? "unknown";
}

export function track1Verdict(output) {
    const attribution = output?.attribution ?? {};
    const coverage = attribution.coverage ?? null;
    const expected = coverage?.expected ?? output?.run?.coverage?.approved_enabled_source_count ?? 0;
    const evaluated = coverage?.evaluated ?? output?.run?.coverage?.successfully_evaluated ?? 0;
    return {
        track: "track-1",
        unit: "approved source",
        unitPlural: "approved sources",
        measure: "surveyed",
        status: output?.status ?? null,
        attempted: output?.run?.coverage?.attempted ?? null,
        evaluated,
        expected,
        ratio: coverage ? coverage.ratio : ratioOf(evaluated, expected),
        threshold: coverage?.minCoverage ?? null,
        met: coverage ? coverage.met : null,
        silent: (attribution.silent ?? []).map((entry) => ({
            id: entry.sourceId,
            label: entry.label ?? entry.sourceId,
            url: entry.url ?? null,
            cause: causeOf(entry),
            detail: entry.reason ?? null,
            status: entry.status ?? null,
        })),
        withheld: (attribution.disabled ?? []).map((entry) => ({
            id: entry.sourceId,
            label: entry.label ?? entry.sourceId,
            approval: entry.approval ?? null,
            reason: entry.reason ?? null,
        })),
        produced: { label: "Candidates proposed", count: output?.candidates?.length ?? 0 },
        drift: false,
    };
}

export function track2Verdict(output) {
    const coverage = output?.coverage ?? {};
    const expected = coverage.expected ?? 0;
    const inspected = coverage.inspected ?? 0;
    const outcomes = Array.isArray(output?.outcomes) ? output.outcomes : [];
    // An item the inspection could not classify produced nothing, exactly as a
    // source that answered nothing produced nothing. Same word, same section,
    // because the owner is owed the same answer on both tracks.
    const silent = outcomes
        .filter((entry) => !entry.classification)
        .map((entry) => ({
            id: entry.stableId,
            label: entry.stableId,
            url: null,
            cause: entry.outcome ?? "unclassified",
            detail: entry.error ?? entry.reason ?? null,
            status: null,
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return {
        track: "track-2",
        unit: "published item",
        unitPlural: "published items",
        measure: "inspected",
        status: output?.status ?? null,
        attempted: outcomes.length,
        evaluated: inspected,
        expected,
        ratio: ratioOf(inspected, expected),
        // Track 2 has no configurable floor: its own definition of a completed
        // run is coverage.gaps === 0, so the threshold IS every item.
        threshold: 1,
        met: expected > 0 && inspected === expected,
        silent,
        // Nothing is retired out of the canonical corpus: the corpus is the
        // denominator, and the runtime refuses to start if the count moves.
        withheld: [],
        produced: { label: "Currency findings held", count: output?.findings?.persisted ?? 0 },
        drift: Boolean(output?.drift),
    };
}

const percent = (ratio) => `${(Number(ratio ?? 0) * 100).toFixed(1)}%`;

/**
 * The coverage line, on EVERY run including a clean one.
 *
 * A number that appears only when something is wrong teaches a reader that its
 * absence means nothing happened. This one is always present, so its absence
 * means the summary itself is broken.
 */
export function coverageLine(verdict) {
    if (!verdict) return "- **Coverage:** this run produced no controller output, so nothing was measured.";
    const attempted = verdict.attempted === null || verdict.attempted === undefined ? "not recorded" : `\`${verdict.attempted}\``;
    const threshold = verdict.threshold === null ? "no threshold configured" : `threshold \`${percent(verdict.threshold)}\``;
    return `- **Coverage:** \`${verdict.evaluated}\` of \`${verdict.expected}\` ${verdict.unitPlural} produced a usable answer — **${percent(verdict.ratio)}** (${threshold}). Attempted: ${attempted}.`;
}

function silentSection(verdict) {
    if (!verdict) return [];
    if (verdict.silent.length === 0) {
        return [`### Silent ${verdict.unitPlural} (0)`, "", `None. Every ${verdict.unit} in scope produced an answer.`, ""];
    }
    const byCause = new Map();
    for (const entry of verdict.silent) {
        if (!byCause.has(entry.cause)) byCause.set(entry.cause, []);
        byCause.get(entry.cause).push(entry);
    }
    const lines = [
        `### Silent ${verdict.unitPlural} (${verdict.silent.length})`,
        "",
        `Every one is named, grouped by the measured cause. A count on its own cannot tell one that has been dead for a month from one that simply had no news.`,
        "",
    ];
    for (const [cause, entries] of [...byCause.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        lines.push(`**${cause}** — ${entries.length}`);
        lines.push("");
        for (const entry of entries) {
            const where = entry.url ? ` (${entry.url})` : "";
            const status = entry.status ? ` HTTP ${entry.status}.` : "";
            // The cause heading already carries the reason where there is
            // one; repeating it under the heading reads as noise.
            const detail = entry.detail && !entry.cause.includes(entry.detail) ? ` ${entry.detail}` : "";
            lines.push(`- \`${entry.id}\` — ${entry.label}${where}.${status}${detail}`);
        }
        lines.push("");
    }
    return lines;
}

function withheldSection(verdict) {
    if (!verdict || verdict.withheld.length === 0) return [];
    return [
        `### Retired or held out of scope (${verdict.withheld.length})`,
        "",
        "Disabling a source shrinks the denominator, so what was dropped is named next to the percentage rather than left to quietly flatter it.",
        "",
        ...verdict.withheld.map((entry) => `- \`${entry.id}\` — ${entry.label} — **${entry.approval ?? "disabled"}**${entry.reason ? `. ${entry.reason}` : ""}`),
        "",
    ];
}

function gateSection({ announced, repo }) {
    const entries = Array.isArray(announced) ? announced : [];
    const failed = entries.filter((entry) => entry.action === "failed");
    const opened = entries.filter((entry) => (entry.count ?? 0) > 0);
    const lines = ["### Gates", ""];
    if (opened.length === 0 && failed.length === 0) {
        lines.push("No item is held at either gate. Nothing is waiting on a decision from you.");
        lines.push("");
        return lines;
    }
    for (const entry of opened) {
        const link = entry.number && repo ? ` — [#${entry.number}](https://github.com/${repo}/issues/${entry.number})` : "";
        lines.push(`- **${entry.gate}** — \`${entry.count}\` item${entry.count === 1 ? "" : "s"} held${link}.`);
    }
    for (const entry of failed) {
        lines.push(`- **${entry.gate}** — ⚠️ the announcement FAILED: ${entry.reason ?? "no reason recorded"}. Work is held at this gate and no issue was opened for it.`);
    }
    lines.push("");
    return lines;
}

/**
 * The verdict, at the top, before anything else.
 *
 * A below-threshold run reading like a quiet week is the failure this whole
 * change exists to stop, so the first line under the heading says so.
 */
export function verdictBanner({ verdict, controllerError }) {
    if (controllerError) {
        return `> ❌ **This run did not complete.** ${controllerError}`;
    }
    if (verdict && verdict.met === false) {
        const threshold = verdict.threshold === null ? "the configured threshold" : percent(verdict.threshold);
        return `> ❌ **Coverage ${percent(verdict.ratio)} is BELOW the ${threshold} threshold.** The run ${verdict.measure} \`${verdict.evaluated}\` of \`${verdict.expected}\` ${verdict.unitPlural}. Everything below is measured against a run that did not see its whole scope, so a quiet result here is not evidence of a quiet week.`;
    }
    if (verdict && verdict.drift) {
        return "> ⚠️ **The corpus changed under the inspection.** Findings from this run were not persisted; the next clean run re-derives them.";
    }
    return null;
}

export function runSummaryTitle({ track, verdict, announced, controllerError }) {
    const label = trackLabel(track);
    const prefix = `Orchard Run Summary: ${label} (${track})`;
    if (controllerError) return `${prefix} — RUN FAILED`;
    if (verdict && verdict.met === false) {
        return `${prefix} — coverage ${percent(verdict.ratio)}, BELOW the ${verdict.threshold === null ? "configured" : percent(verdict.threshold)} threshold`;
    }
    const coverage = `coverage ${percent(verdict?.ratio)}`;
    // isZeroDeltaRun is the contract with announceGates() own return shape.
    // It is asserted here rather than re-derived, because the last time this
    // path invented its own field names the summary never fired at all.
    if (!isZeroDeltaRun(announced)) {
        const held = announced.reduce((total, entry) => total + (entry.count ?? 0), 0);
        return `${prefix} — ${held} item${held === 1 ? "" : "s"} held for your decision, ${coverage}`;
    }
    if (verdict && verdict.silent.length > 0) {
        return `${prefix} — 0 new opportunities, ${coverage} with ${verdict.silent.length} silent ${verdict.silent.length === 1 ? verdict.unit : verdict.unitPlural}`;
    }
    return `${prefix} — 0 new opportunities, ${coverage}`;
}

/**
 * The whole issue body, rendered. Pure, so a test can assert on the text a
 * reader actually gets rather than on the fact that a function was called.
 */
export function renderRunSummary({
    track, runId, executionName, verdict = null, announced = [], controllerError = null,
    repo = "project42dev/orchard", marker, now = new Date().toISOString(),
}) {
    const label = trackLabel(track);
    const banner = verdictBanner({ verdict, controllerError });
    return [
        marker ?? runSummaryMarker({ track, runId }),
        "",
        `## Orchard run summary: ${label}`,
        "",
        ...(banner ? [banner, ""] : []),
        `**Execution:** \`${executionName || runId}\``,
        `**Track:** \`${track}\` (${label})`,
        `**Controller status:** \`${verdict?.status ?? (controllerError ? "failed" : "unknown")}\``,
        `**Completed at:** \`${now}\``,
        "",
        "### What this run covered",
        "",
        coverageLine(verdict),
        verdict ? `- **${verdict.produced.label}:** \`${verdict.produced.count}\`` : null,
        "",
        ...silentSection(verdict),
        ...withheldSection(verdict),
        ...gateSection({ announced, repo }),
        `_Automated summary recorded by Orchard run \`${runId}\`. Coverage is reported on every run, clean or not._`,
    ].filter((line) => line !== null).join("\n");
}

/**
 * Post the summary. Every run, not only a quiet one.
 *
 * Nothing here may fail a run, and nothing here is allowed to be silent: a
 * summary that cannot be posted is logged with the reason, because the owner
 * judges a run by whether the issue arrived.
 */
export async function announceRunSummary({
    repo = "project42dev/orchard",
    track,
    runId,
    executionName,
    verdict = null,
    announced = [],
    controllerError = null,
    token,
    assigneeIds = ["13710532"],
    fetchImpl = fetch,
    log = () => {},
}) {
    if (!token) {
        log("warn", "summary.no-token", { track, runId, effect: "the run happened and nobody was told what it covered" });
        return null;
    }
    const marker = runSummaryMarker({ track, runId });
    const title = runSummaryTitle({ track, verdict, announced, controllerError });
    const body = renderRunSummary({ track, runId, executionName, verdict, announced, controllerError, repo, marker });

    const assignees = [];
    for (const userId of assigneeIds) {
        try {
            const login = await resolveUserLogin({ userId, token, fetchImpl });
            if (login) assignees.push(login);
        } catch { /* non-fatal */ }
    }

    try {
        const result = await openOrUpdateGateIssue({
            repo, marker, title, body,
            labels: ["orchard:summary", `track:${track}`],
            assignees, token, fetchImpl,
        });
        log("info", "summary.run-announced", {
            track, runId, issue: result?.number, url: result?.url,
            coverage: verdict ? Number(verdict.ratio.toFixed(4)) : null,
            silent: verdict?.silent.length ?? null,
            met: verdict?.met ?? null,
        });
        return result;
    } catch (error) {
        log("warn", "summary.run-failed", { track, runId, error: error.message, effect: "the run happened and nobody was told what it covered" });
        return null;
    }
}

export async function announceReleaseSummary({
    repo = "project42dev/orchard",
    version,
    sitesBumped = [],
    newestTag = null,
    token,
    assigneeIds = ["13710532"],
    fetchImpl = fetch,
    log = () => {},
}) {
    if (!token) {
        log("warn", "summary.no-token", { version });
        return null;
    }
    const marker = releaseSummaryMarker({ version });
    const title = `Orchard Run Summary: Production Release v${version} Deployed`;

    const assignees = [];
    for (const userId of assigneeIds) {
        try {
            const login = await resolveUserLogin({ userId, token, fetchImpl });
            if (login) assignees.push(login);
        } catch { /* non-fatal */ }
    }

    const body = [
        marker,
        "",
        `## 🚀 Orchard Production Release Summary: v${version}`,
        "",
        `**Release Version:** \`v${version}\``,
        newestTag ? `**Previous Version:** \`${newestTag}\`` : null,
        `**Deployed At:** \`${new Date().toISOString()}\``,
        "",
        "### 📦 Consuming Sites Updated",
        ...sitesBumped.map((s) => `- ✅ [\`${s}\`](https://github.com/${s}) bumped to \`v${version}\``),
        "",
        "### 🌐 Production Verification",
        "- **Portal:** [https://project-42.dev](https://project-42.dev)",
        "- **Release Facts:** [https://project-42.dev/release-facts.json](https://project-42.dev/release-facts.json)",
        "",
        `_Automated release summary recorded by Orchard._`,
    ].filter(Boolean).join("\n");

    try {
        const result = await openOrUpdateGateIssue({
            repo,
            marker,
            title,
            body,
            labels: ["orchard:summary", "orchard:release"],
            assignees,
            token,
            fetchImpl,
        });
        log("info", "summary.release-announced", { version, issue: result?.number, url: result?.url });
        return result;
    } catch (error) {
        log("warn", "summary.release-failed", { error: error.message });
        return null;
    }
}
