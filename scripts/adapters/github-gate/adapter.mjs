// The GitHub gate provider adapter: the only thing in Orchard permitted to say
// who approved something.
//
// WHAT IT IS. It reads one comment off a gate issue and reports back what is
// provably true about it: which comment, WHO wrote it as GitHub's immutable
// numeric user id rather than a display name, the exact body, and which issue
// it sat on. capture-gate-decision.mjs then checks that against the manifest
// the issue offered, and only then does an item move out of gate1-pending.
//
// WHY IT IS A SEPARATE PINNED FILE rather than an ordinary function. The
// engine refuses to take a decision from code it cannot verify.
// lib/protected-adapter.mjs hashes this file and every file it reaches, and
// compares that digest to one an administrator recorded in the database. Change
// a character here and every decision is refused until the anchor is
// re-provisioned. That is what stops a change somewhere else in the codebase
// from being able to forge an approval.
//
// THE CONSTRAINTS THAT SHAPE THIS FILE. The pinning refuses any import that
// leaves this directory and any package import. So: no @azure/identity, no
// ../lib. The token arrives through the environment, set by the caller that
// read it from Key Vault. Plain fetch, node builtins, and the local copy of
// the canonical digest in canonical.mjs.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never decides anything, never writes,
// and never reads the state database. It reports provider facts. Every
// authorisation question, who is allowed to decide, whether the digest is
// current, whether the item is still pending, belongs to captureGateDecision
// and recordVerifiedDecision, which re-check against the database.

import { sha256Digest } from "./canonical.mjs";

export const adapterIdentity = "orchard.github-gate-adapter.v1";

const API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// The command grammar, only far enough to learn which item is being decided.
// The authoritative parse is parseDecisionCommand in capture-gate-decision.mjs
// and this must never disagree with it about the item id.
const ITEM = /\/orchard gate[12] (?:approve|deny|defer|request-changes) item=([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// ADR-0025, amendment 2026-08-16. A comment whose entire body, trimmed, is
// exactly one of these words decides every item on the issue that is still
// pending, not the one item a structured command would name. It carries no
// item, revision, or digest of its own, so the caller must supply which item
// this particular verification is for (reference.expected_item_id) and this
// function resolves and binds the rest from the issue's own manifest, the
// same trusted source the structured path already reads. The binding
// integrity option B (whole-issue approval) was rejected for is unchanged:
// nothing here trusts anything the human typed beyond which of these two
// words they wrote. Deny still requires a reason for the audit trail; a bare
// deny cannot supply one a human authored, so this names honestly what
// actually happened rather than inventing text and attributing it to them.
const BARE_DECISION = /^(approve|approved|deny|denied)$/i;
const BARE_DENY_REASON = "denied via whole-issue bare deny comment";

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

async function call(path, { token, fetchImpl }) {
    const response = await fetchImpl(`${API}${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Orchard-Gate-Adapter/1.0",
        },
    });
    const text = await response.text();
    // The status is the useful part, and an error body can echo the token back
    // in its message, so only the status and the path travel onward.
    if (!response.ok) fail("provider.http", `GitHub GET ${path} returned ${response.status}`);
    return text ? JSON.parse(text) : null;
}

/**
 * Pull the exact manifest out of the issue that offered it.
 *
 * announce-gates.mjs writes the manifest into the issue body as JSON inside a
 * details block. Reading it from the ISSUE, rather than being handed it, is
 * what makes the binding real: capture then compares the caller's copy against
 * the copy the owner was actually looking at when they commented. Without it,
 * an issue whose rendered text had drifted from the manifest behind it would
 * still accept decisions.
 */
export function manifestFromIssueBody(body) {
    if (typeof body !== "string") fail("issue.body", "issue body is not text");
    const fenced = /```json\r?\n([\s\S]*?)\r?\n```/.exec(body);
    if (!fenced) fail("issue.manifest-absent", "the issue carries no machine-readable manifest, so no decision on it can be bound");
    let manifest;
    try {
        manifest = JSON.parse(fenced[1]);
    } catch (error) {
        fail("issue.manifest-invalid", `the issue manifest is not valid JSON: ${error.message}`);
    }
    for (const field of ["gate", "run_id", "track", "batch_digest", "idempotency_key", "items"]) {
        if (manifest[field] === undefined) fail("issue.manifest-incomplete", `the issue manifest has no ${field}`);
    }
    if (!Array.isArray(manifest.items) || manifest.items.length === 0) fail("issue.manifest-incomplete", "the issue manifest offers no items");
    return manifest;
}

/**
 * The one export capture-gate-decision.mjs calls.
 *
 * `reference` carries only what is needed to LOOK SOMETHING UP:
 *   { repository, issue_number, comment_id, current_state }
 *
 * Everything else is fetched. `current_state` is the single value that is not,
 * because a provider adapter cannot see the state database; it is an assertion
 * the caller makes and that recordVerifiedDecision independently re-checks
 * against the persisted item before anything is written. If the caller lies,
 * the write fails there.
 */
export async function fetchVerifiedEvent(reference, { fetchImpl = fetch, env = process.env } = {}) {
    const { repository, issue_number: issueNumber, comment_id: commentId, current_state: currentState, expected_item_id: expectedItemId } = reference ?? {};
    if (!REPOSITORY.test(repository ?? "")) fail("reference.repository", "reference.repository must be owner/name");
    if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 1) fail("reference.issue", "reference.issue_number must be a positive integer");
    if (commentId === undefined || commentId === null || String(commentId).length === 0) fail("reference.comment", "reference.comment_id is required");
    if (typeof currentState !== "string" || currentState.length === 0) fail("reference.state", "reference.current_state is required");
    if (expectedItemId !== undefined && !new RegExp(`^${UUID}$`).test(expectedItemId)) fail("reference.expected-item", "reference.expected_item_id must be a v7 uuid when supplied");

    const token = env.ORCHARD_GATE_GITHUB_TOKEN;
    if (typeof token !== "string" || token.length === 0) fail("provider.token", "ORCHARD_GATE_GITHUB_TOKEN is not set, so no comment can be verified");

    const comment = await call(`/repos/${repository}/issues/comments/${encodeURIComponent(String(commentId))}`, { token, fetchImpl });
    const issue = await call(`/repos/${repository}/issues/${Number(issueNumber)}`, { token, fetchImpl });

    // An edited comment cannot create a decision. GitHub does not label a
    // fetched comment "edited", so it is derived: updated_at ahead of
    // created_at means the text on screen is not the text that was posted, and
    // an approval must bind to what was actually written.
    const edited = Boolean(comment.updated_at && comment.created_at && comment.updated_at !== comment.created_at);

    const actorId = comment.user?.id;
    if (!Number.isSafeInteger(actorId) || actorId < 1) fail("provider.actor", "the comment carries no immutable GitHub user id");
    if (String(comment.issue_url ?? "").split("/").pop() !== String(Number(issueNumber))) {
        fail("provider.issue-binding", "the comment does not belong to the issue it was looked up against");
    }

    const manifest = manifestFromIssueBody(issue.body);
    const realBody = String(comment.body ?? "");
    const bareMatch = BARE_DECISION.exec(realBody.trim());

    let item;
    let body;
    if (bareMatch) {
        // The comment itself names nothing: the caller must say which item
        // this particular verification resolves, and that item must be real,
        // read from the same manifest the structured path trusts.
        if (!expectedItemId) fail("reference.expected-item", "a bare approve or deny comment requires reference.expected_item_id");
        item = manifest.items.find((entry) => entry.item_id === expectedItemId);
        if (!item) fail("binding.item", "expected_item_id names an item this issue did not offer");
        const gateToken = manifest.gate === "gate-1" ? "gate1" : "gate2";
        const digestField = manifest.gate === "gate-1" ? "proposal_digest" : "artifact_digest";
        const decision = /^approve/i.test(bareMatch[1]) ? "approve" : "deny";
        // Synthesized, never trusted as typed: every field comes from the
        // issue's own manifest, exactly as if the human had typed the full
        // command for this one item. parseDecisionCommand in
        // capture-gate-decision.mjs sees this and nothing else; it cannot
        // tell a synthesized command from a typed one, which is the point.
        // Deny still needs a reason for the audit trail; a bare word cannot
        // supply one a human wrote, so the reason names exactly what
        // happened rather than fabricating something and attributing it.
        body = decision === "approve"
            ? `/orchard ${gateToken} approve item=${item.item_id} revision=${item.item_revision} digest=${item[digestField]}`
            : `/orchard ${gateToken} deny item=${item.item_id} revision=${item.item_revision} digest=${item[digestField]} reason="${BARE_DENY_REASON}"`;
    } else {
        const commanded = ITEM.exec(realBody);
        if (!commanded) fail("command.grammar", "the comment names no item, so there is nothing to bind it to");
        item = manifest.items.find((entry) => entry.item_id === commanded[1]);
        if (!item) fail("binding.item", "the comment names an item this issue did not offer");
        body = realBody;
    }

    return {
        repository,
        issue_number: Number(issueNumber),
        comment_id: String(commentId),
        body,
        action: edited ? "edited" : "created",
        edited,
        deleted: false,
        occurred_at: comment.created_at,
        current_state: currentState,
        actor: {
            immutable_id: String(actorId),
            ...(comment.user?.login ? { display_name: String(comment.user.login) } : {}),
        },
        issue: {
            repository,
            number: Number(issueNumber),
            gate: manifest.gate,
            run_id: manifest.run_id,
            track: manifest.track,
            manifest_digest: sha256Digest(manifest),
            idempotency_key: manifest.idempotency_key,
            batch_digest: manifest.batch_digest,
            target: item.target,
            ...(item.base_commit ? { base_commit: item.base_commit } : {}),
        },
    };
}

export default { adapterIdentity, fetchVerifiedEvent };
