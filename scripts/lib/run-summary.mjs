import { openOrUpdateGateIssue, resolveUserLogin } from "./github-issues.mjs";

const TRACK_LABELS = Object.freeze({ "track-1": "Discovery", "track-2": "Currency" });
const trackLabel = (track) => TRACK_LABELS[track] ?? track;

export function zeroDeltaMarker({ track, runId }) {
    return `<!-- orchard:summary track=${track} run=${runId} type=zero-delta -->`;
}

export function releaseSummaryMarker({ version }) {
    return `<!-- orchard:summary release=v${version} -->`;
}

export async function announceZeroDeltaSummary({
    repo = "project42dev/orchard",
    track,
    runId,
    executionName,
    sourcesSurveyed = null,
    probesChecked = null,
    token,
    assigneeIds = ["13710532"],
    fetchImpl = fetch,
    log = () => {},
}) {
    if (!token) {
        log("warn", "summary.no-token", { track, runId });
        return null;
    }
    const label = trackLabel(track);
    const marker = zeroDeltaMarker({ track, runId });
    const title = `Orchard Run Summary: ${label} (${track}) — 0 New Opportunities (Catalog Up-to-Date)`;

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
        `## 🏁 Orchard Run Summary: ${label}`,
        "",
        `**Execution ID:** \`${executionName || runId}\``,
        `**Track:** \`${track}\` (${label})`,
        `**Completed At:** \`${new Date().toISOString()}\``,
        "",
        "### 📊 Survey & Gap Analysis Outcome",
        "- **New Gaps Identified:** `0`",
        sourcesSurveyed ? `- **Approved Sources Surveyed:** \`${sourcesSurveyed}\`` : null,
        probesChecked ? `- **Active Probes Checked:** \`${probesChecked}\`` : null,
        "- **Catalog Status:** The existing curriculum catalog is 100% current against frontier standards and approved sources.",
        "- **Gate Decisions Needed:** None (0 items held). No authoring or publishing cycle required for this run.",
        "",
        `_Automated summary recorded by Orchard runtime execution \`${runId}\`._`,
    ].filter(Boolean).join("\n");

    try {
        const result = await openOrUpdateGateIssue({
            repo,
            marker,
            title,
            body,
            labels: ["orchard:summary", `track:${track}`],
            assignees,
            token,
            fetchImpl,
        });
        log("info", "summary.zero-delta-announced", { track, runId, issue: result?.number, url: result?.url });
        return result;
    } catch (error) {
        log("warn", "summary.zero-delta-failed", { error: error.message });
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
        "- **Learn Site:** [https://learn.project-42.dev](https://learn.project-42.dev)",
        "- **Release Facts:** [https://learn.project-42.dev/release-facts.json](https://learn.project-42.dev/release-facts.json)",
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
