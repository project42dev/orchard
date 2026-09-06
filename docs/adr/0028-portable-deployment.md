# ADR-0028: A portable deployment contract, with one cloud as a profile

**Status:** Accepted.

## Decision

1. **The public deployment contract requires capabilities, not products:**
   containers, independent schedules with manual dispatch, persistent SQLite,
   integrity-protected evidence storage, workload identity, a secret provider, a
   registry, logs, metrics, and policy-controlled egress. **Any given cloud is
   one profile against that contract, not the contract itself.**
2. **Each track runs as its own scheduled job with its own manual trigger.**
   Cadence is an operator choice.
3. **The maintenance track sorts canonical ids, partitions the corpus, and
   bounds concurrency.** Full-run completion requires every partition, so a
   partial sweep can never present itself as a complete one.
4. **Workload identities are split by function:** collection and inspection,
   gate reconciliation, tracker reconciliation, agent execution, publication,
   and backup. **Publication credentials never reach collectors or model
   runners.**
5. **State lives on durable storage with atomic backup to a separate failure
   domain**, evidence is separated by data class and retention, and **secret
   values never enter files, logs, manifests or images.**
6. **The registry profile is private, deployment is by immutable digest**, with
   anonymous and administrative access disabled, image scanning, provenance,
   SBOM, signature verification, retention, and recorded rollback digests. Pull
   and push identities are separate.
7. **Publication uses a least-privilege application identity** to open a branch
   and pull request. Protected main, required checks, repository review and Gate
   2 exact-head binding all remain mandatory.
8. **Observe** schedule heartbeat, run outcome, source and corpus coverage,
   stale leases, unauthorized decisions, external reconciliation, publication
   state, backup age, restore results, storage capacity, model limits, spend and
   cleanup activity.
9. **Enforce per-run request, token, fetch, item, duration, concurrency and
   spend caps before work begins. Budgets and alerts are detection, never the
   only stop.**
10. **Public documentation contains no private topology, identity, schedules,
    cost, secret-reference names, or links into a private repository. Public
    text describes portable capabilities and controls only.**

## Why capabilities rather than products

Writing the contract in one vendor's nouns makes every adopter a customer of
that vendor, and quietly makes the project untestable anywhere else. Written as
capabilities, a profile can be judged: it either provides workload identity and
policy-controlled egress or it does not.

## Why split the identities

A single identity that can collect, run models and publish means any compromise
anywhere in the chain can publish. Splitting them means the credential that
reaches untrusted content is not the credential that can write to main.

## Why caps before work rather than budgets alone

A budget alert fires after the money is spent. It is a smoke detector, not a
fuse. Caps enforced before a run starts are the actual stop, and the alert
exists to tell you the cap did its job.

**Decision 10 is why these public pages read the way they do**, and why they
omit specifics you might expect. What is omitted describes one deployment. What
remains is what transfers.
