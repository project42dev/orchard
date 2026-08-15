# Architecture decisions

Every accepted decision that shapes Orchard, one page each.

The full records, including the candid early analysis and the options that were
rejected, live in a private planning repository. That split is itself a
decision: analysis is more honest when it has somewhere private to be honest,
and what a contributor or an adopter needs is the accepted decision and the
reason it holds. These pages are that, written to stand alone. **Nothing here
links to anything you cannot open.**

Where a page omits something, it is omitted on purpose and by rule: no private
topology, no identity or secret names, no operational schedules, no cost
figures. Those describe one organisation's deployment. What is left is the
portable capability and the control, which is what actually transfers.

| ADR | Decision |
|---|---|
| [0015](0015-source-change-detection.md) | A source is a cited URL, and detection normalizes before it hashes |
| [0017](0017-layer-separation.md) | Orchard is its own repository, and the model layer is read only |
| [0018](0018-model-to-job-map.md) | One model map, and a refusal instead of a fallback |
| [0019](0019-content-database.md) | The content database is derived, with a small authoritative core |
| [0020](0020-instructor-led-is-a-rendering.md) | Instructor-led is a second rendering of one module |
| [0021](0021-observability.md) | Observability stays outside the container |
| [0022](0022-two-track-lifecycle.md) | Two independent tracks, one shared two-gate lifecycle |
| [0023](0023-workflow-state-and-retention.md) | Authoritative workflow state in SQLite, events append only |
| [0024](0024-identity-idempotency-publication.md) | Immutable identity, idempotency, and publication as a transaction |
| [0025](0025-gates-as-schema-bound-issues.md) | Both gates are schema-bound issues with an exact command grammar |
| [0026](0026-tracker-mapping-and-closure.md) | Approved items map to evidence-bound tracker work |
| [0027](0027-agent-roles-and-quality.md) | Qualified independent roles, and every handoff is bound |
| [0028](0028-portable-deployment.md) | A portable deployment contract, with one cloud as a profile |

## How to read these

An ADR records a decision. **It is not evidence that anything is built.** For
what is actually built, deployed and proven, read [Status](../status.md), which
keeps those three in separate columns on purpose.

[Decisions](../decisions.md) is the narrative version of the same material,
organised by theme rather than by record, and it carries the failures that
produced each decision. Start there if you want the reasoning. Come here if you
want a specific decision.
