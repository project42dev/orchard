// The Azure DevOps client the production container can actually run.
//
// WHY THIS EXISTS. The first tracker integration shelled out to `az boards`,
// and `az` is not in the production image (node:22-bookworm-slim plus
// ca-certificates and git, nothing else). Same defect class as assuming `gh`
// and as writing to work_item: code written against a developer workstation,
// deployed into a container that has none of it. This file is the fix, written
// the same way lib/github-issues.mjs was written for the same reason: fetch
// against the REST API, no CLI, no shell out.
//
// CREDENTIAL. A service principal, never a PAT. Both stored ADO PATs returned
// hard 401s on 2026-08-14, which is what a calendar-expiring credential does.
// The container jobs each run as a user-assigned managed identity, and a
// managed identity IS a service principal in the Entra tenant the ADO
// organisation trusts. Both track identities were registered as service
// principal users of the `hybridcloudsolutions` organisation on 2026-08-15
// (Basic access, member of Project 42) via the member entitlement REST API:
//   id-p42orch-t1-prod-eus-01  entitlement abe6316b-8fce-6854-adcb-465c984e328d
//   id-p42orch-t2-prod-eus-01  entitlement 02759f24-6c53-6991-bf08-9ee9f3e07a9b
// The identity obtains an AAD bearer token for the Azure DevOps resource id
// below. Nothing is stored in Key Vault for this: there is no secret to store.
//
// On an operator workstation the fallback is AzureCliCredential, the
// signed-in `az` session, which is the identity ops docs name for ADO. Not
// DefaultAzureCredential: its chain reads ambient environment variables
// first, and a stray service principal in the session environment produced a
// 401 from an identity nobody chose when this was first smoke tested.

import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";

// The well-known Entra resource id of Azure DevOps. Constant across tenants.
export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

// The destination was never a question: hardcoded here as it always was in
// ado-sync.mjs, confirmed live on 2026-08-15 (project 65db102b-0f2f-439e-af54-1d9db2f3c6ff).
export const ADO_ORGANIZATION = "hybridcloudsolutions";
export const ADO_PROJECT = "Project 42";

// Where a tracker item hangs on the board, settled per the plan's Part 2 and
// verified against the live board on 2026-08-15 (both Epics exist and are
// Active):
//
//   track-1 (discovery)  -> Epic 5112 "[Project 42] Deliver self paced
//     learning". Every discovery surface (learning, guide, guide-diagram)
//     proposes NEW learner-facing content into the platform corpus, which is
//     exactly what that Epic delivers. The surfaces share one parent because
//     they share one outcome: net-new content a learner can reach.
//
//   track-2 (currency)   -> Epic 5115 "[Project 42] Automate trusted content
//     maintenance". Currency inspections produce maintenance of content that
//     already exists, which is that Epic's whole scope.
export const PARENT_EPIC_BY_TRACK = Object.freeze({
    "track-1": 5112,
    "track-2": 5115,
});

/**
 * A bearer-token provider for Azure DevOps.
 *
 * In the container AZURE_CLIENT_ID names the job's user-assigned managed
 * identity, exactly as the blob and Foundry clients use it. Anywhere else,
 * AzureCliCredential reaches the signed-in az session. The token is
 * fetched per call and never cached here: @azure/identity caches internally
 * and a stale token cached twice is a 401 nobody can explain.
 */
export function defaultAdoTokenProvider(env = process.env) {
    let credential = null;
    return async () => {
        credential ??= env.AZURE_CLIENT_ID
            ? new ManagedIdentityCredential(env.AZURE_CLIENT_ID, { retryOptions: { maxRetries: 5, retryDelayInMs: 2000, maxRetryDelayInMs: 10000 } })
            : new AzureCliCredential();
        const { token } = await credential.getToken(`${ADO_RESOURCE_ID}/.default`);
        return token;
    };
}

/** The human URL for a work item, for issue comments and logs. */
export function workItemUrl(organization, project, id) {
    return `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_workitems/edit/${Number(id)}`;
}

export class AdoClient {
    constructor({
        organization = ADO_ORGANIZATION,
        project = ADO_PROJECT,
        tokenProvider,
        fetchImpl = fetch,
        apiVersion = "7.1",
    } = {}) {
        if (typeof tokenProvider !== "function") throw new TypeError("AdoClient requires a tokenProvider");
        this.organization = organization;
        this.project = project;
        this.tokenProvider = tokenProvider;
        this.fetchImpl = fetchImpl;
        this.apiVersion = apiVersion;
    }

    async #call(path, { method = "GET", body, contentType = "application/json", apiVersion = this.apiVersion } = {}) {
        const token = await this.tokenProvider();
        const separator = path.includes("?") ? "&" : "?";
        const url = `https://dev.azure.com/${this.organization}${path}${separator}api-version=${apiVersion}`;
        const response = await this.fetchImpl(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(body ? { "Content-Type": contentType } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        if (!response.ok) {
            // Only the service's own message field travels onward, never the
            // whole body, and anything token-shaped is removed before anyone
            // logs it. Same discipline as lib/github-issues.mjs.
            let reason = "";
            try {
                const parsed = JSON.parse(text);
                reason = typeof parsed?.message === "string" ? parsed.message : "";
            } catch { /* a non-JSON error body tells us nothing worth risking */ }
            reason = reason.replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, "[REDACTED]");
            const error = new Error(`ADO ${method} ${path} returned ${response.status}${reason ? `: ${reason}` : ""}`);
            error.status = response.status;
            throw error;
        }
        return text ? JSON.parse(text) : null;
    }

    /**
     * Create one work item. Returns { id, url } with the human web URL.
     *
     * Idempotence is NOT here. The external_link row in the state database is
     * the duplicate guard, per the plan: the caller checks it before calling
     * this, and a call that reaches this method is a call that should create.
     */
    async createWorkItem({ type = "User Story", title, description, areaPath, parentId = null, tags = null }) {
        if (typeof title !== "string" || title.length === 0) throw new TypeError("title is required");
        const operations = [
            { op: "add", path: "/fields/System.Title", value: title.slice(0, 255) },
        ];
        if (description) operations.push({ op: "add", path: "/fields/System.Description", value: description });
        if (areaPath) operations.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
        if (tags) operations.push({ op: "add", path: "/fields/System.Tags", value: tags });
        if (parentId) {
            operations.push({
                op: "add",
                path: "/relations/-",
                value: {
                    rel: "System.LinkTypes.Hierarchy-Reverse",
                    url: `https://dev.azure.com/${this.organization}/_apis/wit/workItems/${Number(parentId)}`,
                },
            });
        }
        const created = await this.#call(
            `/${encodeURIComponent(this.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}`,
            { method: "POST", body: operations, contentType: "application/json-patch+json" },
        );
        const id = Number(created?.id);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("ADO did not return a positive work item ID");
        return { id, url: workItemUrl(this.organization, this.project, id), raw: created };
    }

    /** The current state (and title) of one work item, for drift detection. */
    async getWorkItem(id) {
        const item = await this.#call(`/_apis/wit/workitems/${Number(id)}?fields=System.State,System.Title`);
        return { id: Number(item.id), state: item.fields?.["System.State"] ?? null, title: item.fields?.["System.Title"] ?? null };
    }

    /** Move one work item to a state. */
    async updateWorkItemState(id, state) {
        if (typeof state !== "string" || state.length === 0) throw new TypeError("state is required");
        await this.#call(`/_apis/wit/workitems/${Number(id)}`, {
            method: "PATCH",
            body: [{ op: "add", path: "/fields/System.State", value: state }],
            contentType: "application/json-patch+json",
        });
        return state;
    }

    /** Add a discussion comment to one work item. */
    async addComment(id, text) {
        if (typeof text !== "string" || text.length === 0) throw new TypeError("comment text is required");
        return this.#call(
            `/${encodeURIComponent(this.project)}/_apis/wit/workItems/${Number(id)}/comments`,
            { method: "POST", body: { text }, apiVersion: "7.1-preview.4" },
        );
    }

    /** Permanently delete is never offered. Removed state is the terminal negative. */
}

export function createAdoRestClient(options = {}) {
    return new AdoClient({ tokenProvider: defaultAdoTokenProvider(options.env ?? process.env), ...options });
}

