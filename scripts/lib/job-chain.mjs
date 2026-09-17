// Auto-chaining between Orchard's manual-trigger-only production roles.
//
// WHY THIS EXISTS. Every role after gate-1 approval (authoring, gate2-prep,
// publication, verification) is a Container Apps Job with triggerType Manual
// and replicaRetryLimit 0 -- deliberate, per T19: a spend or publish action
// must be an operator decision, not a platform retry. But "operator decision"
// was never meant to mean a human has to remember to click go after every
// single approval; that requirement was never explicit, and NOTHING triggered
// the next role automatically, so approved work sat waiting for a manual
// re-trigger every single hop. This closes exactly that gap, without loosening
// the spend/publish caps those jobs already enforce on themselves: chaining
// only ever calls the SAME /start endpoint an operator would have called by
// hand, so every existing safety brake (budget caps, evidence requirements,
// Gate 2's human review) still applies unchanged.
//
// WHEN THIS RUNS. Called from runRoleAzure AFTER its own withFencedState
// session has fully returned (lease released) -- never from inside the fenced
// callback, so a just-triggered downstream execution never races the current
// run for the same lease.

import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";

const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_BASE = "https://management.azure.com";
const JOBS_API_VERSION = "2024-03-01";

/** Same shape as lib/ado-client.mjs's token provider, for the ARM resource. */
export function defaultArmTokenProvider(env = process.env) {
    let credential = null;
    return async () => {
        credential ??= env.AZURE_CLIENT_ID
            ? new ManagedIdentityCredential(env.AZURE_CLIENT_ID, { retryOptions: { maxRetries: 5, retryDelayInMs: 2000, maxRetryDelayInMs: 10000 } })
            : new AzureCliCredential();
        const { token } = await credential.getToken(ARM_SCOPE);
        return token;
    };
}

export async function startJob({ jobResourceId, tokenProvider, fetchImpl = fetch }) {
    const token = await tokenProvider();
    const response = await fetchImpl(`${ARM_BASE}${jobResourceId}/start?api-version=${JOBS_API_VERSION}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        // statusCode carried as a property, not just folded into the message,
        // so a caller (continueAuthoringChain, chainNextRoles) can log the ARM
        // status code as its own structured field instead of a caller having
        // to regex it back out of prose -- found live 2026-09-11/12: a chain
        // start that fails on a missing Microsoft.App/jobs/start/action grant
        // must be diagnosable from the log line alone, without a repro.
        const error = new Error(`failed to start job ${jobResourceId}: HTTP ${response.status} ${body}`);
        error.statusCode = response.status;
        throw error;
    }
    return response.json().catch(() => null);
}

// One hop per lifecycle state that has downstream, unstarted work waiting on
// it. gate2-approved -> publication is the one hop that is ALSO gated by a
// human decision (Gate 2 itself) -- that gate already happened by the time an
// item reaches gate2-approved, so triggering publication here is exactly
// "the moment you approve Gate 2, it starts," not a bypass of the review.
const CHAIN_HOPS = [
    { state: "ado-linked", envVar: "ORCHARD_CHAIN_AUTHORING_JOB_ID", role: "authoring" },
    { state: "gate2-ready", envVar: "ORCHARD_CHAIN_GATE2PREP_JOB_ID", role: "gate2-prep" },
    { state: "gate2-approved", envVar: "ORCHARD_CHAIN_PUBLICATION_JOB_ID", role: "publication" },
    { state: "published", envVar: "ORCHARD_CHAIN_RELEASE_JOB_ID", role: "release" },
];

/**
 * Look at what the run just left behind and start whichever next role has
 * real waiting work. A hop with no configured job id is silently off (lets
 * an adopter or a partial deploy enable chaining one hop at a time). Start
 * only one successful hop per handoff: all roles share one fenced state lease,
 * so starting two together makes one fail before it can do useful work. If
 * a start itself fails, try the next eligible hop so a broken job id does not
 * stop unrelated work.
 *
 * currentRole, if given, is never triggered by its own hop: a role that HELD
 * an item rather than advancing it (gate2-prep with no evidence yet is the
 * proven live case) would otherwise see the same waiting count after its own
 * run as before it, and re-trigger itself forever. A DIFFERENT role
 * producing that same state (authoring producing gate2-ready work) still
 * correctly triggers it -- only self-triggering is refused.
 */
export async function chainNextRoles({ counts, env = process.env, tokenProvider = defaultArmTokenProvider(env), fetchImpl = fetch, log, currentRole = null }) {
    const triggered = [];
    for (const hop of CHAIN_HOPS) {
        if (hop.role === currentRole) continue;
        const jobResourceId = env[hop.envVar];
        if (!jobResourceId) continue;
        // Authoring's waiting work is three things, each counted by
        // BlobStateAdapter.peekStateCounts with the exact predicate the
        // authoring run acts on: fresh ado-linked approvals, binding-free
        // executing items a crashed run left behind, and Gate 2 rework
        // (lib/rework-recovery.mjs). Rework was invisible here until
        // 2026-09-13, so a request-changes decision never started a redraft.
        const waiting = hop.state === "ado-linked"
            ? (counts["ado-linked"] ?? 0) + (counts["authoring-recoverable"] ?? 0) + (counts["rework-recoverable"] ?? 0)
            : (counts[hop.state] ?? 0);
        if (waiting <= 0) continue;
        try {
            const started = await startJob({ jobResourceId, tokenProvider, fetchImpl });
            triggered.push(hop.role);
            log?.("info", "chain.triggered", { role: hop.role, state: hop.state, waiting, execution: started?.name });
            break;
        } catch (error) {
            log?.("error", "chain.trigger-failed", { role: hop.role, state: hop.state, waiting, statusCode: error.statusCode ?? null, error: error.message });
        }
    }
    return triggered;
}

/**
 * Authoring's OWN continuation, separate from the cross-role hops above and
 * for a reason: a stranded item recovered by recoverStrandedItems
 * (lib/stranded-recovery.mjs) never leaves 'gate2-ready' for a state a
 * DIFFERENT role's hop watches -- it comes straight back to 'executing' and
 * is re-drafted inside the SAME authoring run that recovered it. So the
 * backlog that keeps authoring's stranded sweep busy across many runs is
 * invisible to chainNextRoles' counts-based hops, and currentRole there
 * refuses authoring's "ado-linked" hop from re-triggering itself anyway
 * (correctly, for the reason recorded on that guard -- it exists to stop a
 * role that HELD without progress from looping forever). Proven live
 * 2026-09-11/12: authoring's gate2.stranded.summary kept reporting dozens of
 * items still `remaining`, and nothing ever started the next run for it --
 * the chain only ever advanced when an UNRELATED trigger (a fresh Gate 1
 * approval, an operator's manual restart) happened to also see ado-linked
 * work waiting.
 *
 * Bounded the same way the sweep itself is bounded, but on a different
 * axis: `recovered === 0` means this run's sweep looked at the backlog and
 * could not move a single item (every candidate refused -- wrong
 * publication target, already at its automatic-attempt cap, or genuinely
 * out of candidates), so starting another run would only spend a Container
 * Apps execution to rediscover the exact same stuck items. That is the
 * deliberate stop, logged with why, never a silent one.
 */
//
// GATE 2 REWORK, since 2026-09-13, is the second backlog only authoring
// drains (lib/rework-recovery.mjs reopens at most a capped number of returned
// items per run), and it is bounded by the identical rule: another run starts
// only if some backlog still has eligible work AND this run moved at least one
// item out of THAT backlog. A backlog that did not move cannot restart the
// chain on the strength of a different backlog's progress. `remaining` for
// rework counts only eligible items -- a Gate 1 return or an unpublishable
// target is refused every run and is not a backlog -- and a reopened rework
// item cannot return to changes-requested without a new human decision, so
// this cannot self-trigger forever.
export async function continueAuthoringChain({ freshQueue = null, strandedRecovery, reworkRecovery = null, env = process.env, tokenProvider = defaultArmTokenProvider(env), fetchImpl = fetch, log }) {
    const jobResourceId = env.ORCHARD_CHAIN_AUTHORING_JOB_ID;
    if (!jobResourceId) return false;
    const backlogs = [["fresh", freshQueue], ["stranded", strandedRecovery], ["rework", reworkRecovery]]
        .filter(([, summary]) => summary)
        .map(([name, summary]) => ({ name, remaining: summary.remaining ?? 0,
            recovered: name === "fresh" ? (summary.claimed ?? 0) : (summary.recovered?.length ?? 0) }));
    if (backlogs.length === 0) return false;
    const waiting = backlogs.filter((backlog) => backlog.remaining > 0);
    const remaining = waiting.reduce((sum, backlog) => sum + backlog.remaining, 0);
    if (waiting.length === 0) {
        log?.("info", "chain.continue.none", { remaining: 0, effect: "no stranded or rework backlog is waiting on another authoring run" });
        return false;
    }
    const moving = waiting.filter((backlog) => backlog.recovered > 0);
    if (moving.length === 0) {
        log?.("warn", "chain.continue.stopped", {
            remaining,
            backlogs: waiting.map((backlog) => backlog.name),
            reason: "this run's recovery sweeps recovered 0 items from every backlog still waiting; nothing is moving, so starting another authoring run would only re-find the same stuck items",
        });
        return false;
    }
    const recovered = moving.reduce((sum, backlog) => sum + backlog.recovered, 0);
    try {
        const started = await startJob({ jobResourceId, tokenProvider, fetchImpl });
        log?.("info", "chain.continue.triggered", { role: "authoring", remaining, recovered, backlogs: moving.map((backlog) => backlog.name), execution: started?.name });
        return true;
    } catch (error) {
        log?.("error", "chain.continue.trigger-failed", { role: "authoring", remaining, recovered, statusCode: error.statusCode ?? null, error: error.message });
        return false;
    }
}
