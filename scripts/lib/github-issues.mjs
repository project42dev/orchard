// Open and update the GitHub issues that carry a gate decision.
//
// WHY THIS EXISTS. A gate that halts a run and says nothing is not a gate, it
// is a stall. The owner's requirement is plain: "I don't run anything. It
// creates a GitHub issue and that notifies me." Four gates, two per track.
//
// Why not `gh`. The runtime image installs ca-certificates and git and nothing
// else, so the GitHub CLI is not there and adding it would put a whole
// toolchain in a job that needs one HTTP call. notify-review-ready.mjs shells
// out to `gh issue create` and therefore cannot run in production at all.
// This uses fetch against the REST API, which is already how
// gate1-review.mjs reads comments back.
//
// Idempotence is by MARKER, not by title. Titles get edited by humans; a
// hidden HTML comment does not. One marker means one issue for the life of
// that gate instance, so a re-run updates the issue in place rather than
// opening a second one and splitting the conversation.

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The hidden marker that makes one issue the home of one gate decision.
 *
 * KEYED ON THE BATCH DIGEST WHEN THERE IS ONE, not on the run. A gate holds
 * work until a human decides, which is deliberately longer than a run: keying
 * on the run id would open a fresh issue every month for the same undecided
 * items and split the conversation across all of them. The batch digest is the
 * exact set of items and revisions on offer, so the same held set updates the
 * same issue, and a changed set correctly gets a new one.
 */
export function gateMarker({ track, gate, runId, batchDigest }) {
    if (!["track-1", "track-2"].includes(track)) throw new TypeError("track must be track-1 or track-2");
    if (!["gate-1", "gate-2"].includes(gate)) throw new TypeError("gate must be gate-1 or gate-2");
    if (typeof runId !== "string" || runId.length === 0) throw new TypeError("runId is required");
    if (batchDigest === undefined) return `<!-- orchard:gate track=${track} gate=${gate} run=${runId} -->`;
    if (!/^sha256:[a-f0-9]{64}$/.test(batchDigest)) throw new TypeError("batchDigest must be sha256:<64 hex>");
    return `<!-- orchard:gate track=${track} gate=${gate} batch=${batchDigest} -->`;
}

async function call(path, { token, method = "GET", body, fetchImpl = fetch }) {
    const response = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Orchard-Gates/1.0",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
        // GitHub's own message travels onward, because the status alone is
        // ambiguous in the one way that matters: a 403 is "you may not" AND
        // "you have used your 5000 requests", and the two are indistinguishable
        // until you read the body. That ambiguity cost a wrong diagnosis on
        // 2026-08-15, reported to the owner as a permission problem when it was
        // a rate limit.
        //
        // Only the `message` field is taken, never the whole body, and anything
        // that looks like a credential is removed from it before it is logged.
        let reason = "";
        try {
            const parsed = JSON.parse(text);
            reason = typeof parsed?.message === "string" ? parsed.message : "";
        } catch { /* a non-JSON error body tells us nothing worth risking */ }
        reason = reason.replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{40})\b/g, "[REDACTED]");
        const error = new Error(`GitHub ${method} ${path} returned ${response.status}${reason ? `: ${reason}` : ""}`);
        error.status = response.status;
        error.reason = reason;
        // A rate limit is a wait, not a fault, and a caller that cannot tell
        // them apart will either retry forever or give up on a working token.
        error.rateLimited = response.status === 403 && /rate limit/i.test(reason);
        error.resetAt = response.headers?.get?.("x-ratelimit-reset") ?? null;
        throw error;
    }
    return text ? JSON.parse(text) : null;
}

// Search is eventually consistent and rate limited, so this pages open issues
// directly. A gate issue is open by definition while it waits for a decision,
// and there are never many.
export async function findIssueByMarker({ repo, marker, token, fetchImpl = fetch, maxPages = 5 }) {
    if (!REPO.test(repo ?? "")) throw new TypeError("repo must be owner/name");
    for (let page = 1; page <= maxPages; page += 1) {
        const issues = await call(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, { token, fetchImpl });
        if (!Array.isArray(issues) || issues.length === 0) return null;
        const match = issues.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
        if (match) return match;
        if (issues.length < 100) return null;
    }
    return null;
}

/**
 * Every open issue this repository is holding a gate decision on.
 *
 * The marker is the filter, not a label or a title: labels get removed and
 * titles get edited, and an issue that stops looking like a gate issue while
 * still holding a decision is how a decision goes unread.
 */
export async function listOpenGateIssues({ repo, gate, track, token, fetchImpl = fetch, maxPages = 5 }) {
    if (!REPO.test(repo ?? "")) throw new TypeError("repo must be owner/name");
    const prefix = `<!-- orchard:gate track=${track} gate=${gate} `;
    const found = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const issues = await call(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, { token, fetchImpl });
        if (!Array.isArray(issues) || issues.length === 0) break;
        for (const issue of issues) {
            if (typeof issue.body === "string" && issue.body.includes(prefix)) found.push(issue);
        }
        if (issues.length < 100) break;
    }
    return found;
}

/** Every comment on one issue, oldest first, which is the order decisions were made in. */
export async function listIssueComments({ repo, issueNumber, token, fetchImpl = fetch, maxPages = 5 }) {
    if (!REPO.test(repo ?? "")) throw new TypeError("repo must be owner/name");
    const comments = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const batch = await call(`/repos/${repo}/issues/${Number(issueNumber)}/comments?per_page=100&page=${page}`, { token, fetchImpl });
        if (!Array.isArray(batch) || batch.length === 0) break;
        comments.push(...batch);
        if (batch.length < 100) break;
    }
    return comments;
}

/**
 * Add one comment to an issue. Used by the tracker sync to write the Azure
 * DevOps work item id and URL back onto the gate issue that produced it, so
 * the two sides link: the issue names the item and the item names the issue.
 */
export async function commentOnIssue({ repo, issueNumber, body, token, fetchImpl = fetch }) {
    if (!REPO.test(repo ?? "")) throw new TypeError("repo must be owner/name");
    if (typeof body !== "string" || body.length === 0) throw new TypeError("a comment body is required");
    const created = await call(`/repos/${repo}/issues/${Number(issueNumber)}/comments`, {
        token, fetchImpl, method: "POST", body: { body },
    });
    return { id: created.id, url: created.html_url };
}

/**
 * Create the gate issue, or update the one this marker already owns.
 *
 * Returns { action, number, url }. `action` is "created" or "updated", never a
 * silent no-op: a gate that reports success without an issue number is the
 * failure this whole file exists to prevent, so a caller can assert on it.
 */
export async function openOrUpdateGateIssue({ repo, marker, title, body, labels = [], token, fetchImpl = fetch }) {
    if (!REPO.test(repo ?? "")) throw new TypeError("repo must be owner/name");
    if (typeof token !== "string" || token.length === 0) throw new TypeError("a GitHub token is required");
    if (typeof title !== "string" || title.length === 0) throw new TypeError("title is required");
    if (typeof body !== "string" || !body.includes(marker)) throw new TypeError("the issue body must carry its marker");

    const existing = await findIssueByMarker({ repo, marker, token, fetchImpl });
    if (existing) {
        const updated = await call(`/repos/${repo}/issues/${existing.number}`, {
            token, fetchImpl, method: "PATCH", body: { title, body },
        });
        return { action: "updated", number: updated.number, url: updated.html_url };
    }
    const created = await call(`/repos/${repo}/issues`, {
        token, fetchImpl, method: "POST", body: { title, body, labels },
    });
    return { action: "created", number: created.number, url: created.html_url };
}
