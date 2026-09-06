// The trigger at the end of Orchard's boundary.
//
// WHAT WAS MISSING. project42-platform's content-sync.yml declares three ways
// to run: a weekly cron, a manual dispatch, and
//
//     repository_dispatch:   # Vector 3: Webhook from Orchard
//       types: [content_updated]
//
// Nothing in this repository has ever sent that webhook. Grepped across all of
// Orchard's scripts, libraries and workflows on 2026-09-06: no
// repository_dispatch, no /dispatches call, not one occurrence of the string
// content_updated. project42dev/project42-content has no .github/workflows
// directory at all, so it cannot send it either. A listener with no speaker.
//
// The consequence is precisely the failure this project keeps finding: a
// currency correction is approved, published, and merged into the canonical
// content repository, and then nothing happens for up to a week -- until the
// Sunday cron notices. The owner's own statement of the architecture is that
// Orchard's boundary ends at the content drop AND THE TRIGGER, so the trigger
// belongs here, at the moment publication acknowledges a merge.
//
// It can never fail a run. A publication that merged is real work already
// recorded in the state store; a GitHub outage, a token that cannot reach the
// platform repository, or a 404 on the dispatch endpoint must leave that work
// exactly as it is and say what happened. The weekly cron is the fallback the
// pipeline already has, so the cost of a failed trigger is latency, not loss.

export const CONTENT_UPDATED_EVENT = "content_updated";
export const DEFAULT_CONTENT_CONSUMER_REPO = "project42dev/project42-platform";

/**
 * Tell the platform its canonical content moved.
 *
 * Returns a result describing what happened rather than throwing, so a caller
 * can log it and carry on: { sent, reason?, status? }.
 */
export async function notifyContentUpdated({
    repo = DEFAULT_CONTENT_CONSUMER_REPO,
    token,
    items = [],
    commits = [],
    fetchImpl = globalThis.fetch,
    log = () => { },
} = {}) {
    if (!token) {
        log("warn", "content-updated.no-token", { repo, effect: "the platform will pick the change up on its weekly cron instead" });
        return { sent: false, reason: "no credential" };
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        log("warn", "content-updated.bad-repo", { repo, effect: "no trigger sent" });
        return { sent: false, reason: "repository is not owner/name" };
    }
    // The payload is evidence, not instruction: it says which items moved and
    // at which commits, so a human reading the platform's run can trace it
    // back to the decisions that authorised it. GitHub caps client_payload at
    // 10 top-level properties; this uses three.
    const body = JSON.stringify({
        event_type: CONTENT_UPDATED_EVENT,
        client_payload: {
            source: "orchard",
            items: items.slice(0, 50),
            commits: [...new Set(commits.filter(Boolean))].slice(0, 50),
        },
    });
    try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                "content-type": "application/json",
                "user-agent": "orchard",
            },
            body,
        });
        // 204 No Content is success for this endpoint. Anything else is
        // reported with its status, because "403 rate limited" and "403
        // forbidden" are different facts and reading the message is the
        // difference between waiting and re-issuing a credential.
        if (response.status === 204) {
            log("info", "content-updated.sent", { repo, items: items.length, effect: "the platform rebuilds now rather than on its weekly cron" });
            return { sent: true, status: 204 };
        }
        const detail = await response.text?.().catch(() => "") ?? "";
        log("warn", "content-updated.refused", {
            repo, status: response.status, reason: detail.slice(0, 500),
            effect: "the merge stands; the platform will pick it up on its weekly cron",
        });
        return { sent: false, status: response.status, reason: detail.slice(0, 500) };
    } catch (error) {
        log("warn", "content-updated.failed", {
            repo, reason: error.message,
            effect: "the merge stands; the platform will pick it up on its weekly cron",
        });
        return { sent: false, reason: error.message };
    }
}
