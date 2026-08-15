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

export function gateMarker({ track, gate, runId }) {
    if (!["track-1", "track-2"].includes(track)) throw new TypeError("track must be track-1 or track-2");
    if (!["gate-1", "gate-2"].includes(gate)) throw new TypeError("gate must be gate-1 or gate-2");
    if (typeof runId !== "string" || runId.length === 0) throw new TypeError("runId is required");
    return `<!-- orchard:gate track=${track} gate=${gate} run=${runId} -->`;
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
        // The status is the useful part and the body can echo the token back
        // in an error message, so only the status and path travel onward.
        const error = new Error(`GitHub ${method} ${path} returned ${response.status}`);
        error.status = response.status;
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
