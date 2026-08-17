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
            ? new ManagedIdentityCredential(env.AZURE_CLIENT_ID)
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
        throw new Error(`failed to start job ${jobResourceId}: HTTP ${response.status} ${body}`);
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
];

/**
 * Look at what the run just left behind and start whichever next role has
 * real waiting work. A hop with no configured job id is silently off (lets
 * an adopter or a partial deploy enable chaining one hop at a time). Each
 * hop is independent and a failure on one does not stop the others.
 */
export async function chainNextRoles({ counts, env = process.env, tokenProvider = defaultArmTokenProvider(env), fetchImpl = fetch, log }) {
    const triggered = [];
    for (const hop of CHAIN_HOPS) {
        const jobResourceId = env[hop.envVar];
        if (!jobResourceId) continue;
        const waiting = counts[hop.state] ?? 0;
        if (waiting <= 0) continue;
        try {
            const started = await startJob({ jobResourceId, tokenProvider, fetchImpl });
            triggered.push(hop.role);
            log?.("info", "chain.triggered", { role: hop.role, state: hop.state, waiting, execution: started?.name });
        } catch (error) {
            log?.("error", "chain.trigger-failed", { role: hop.role, state: hop.state, waiting, error: error.message });
        }
    }
    return triggered;
}
