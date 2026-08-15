# ADR-0021: Observability stays outside the container

**Status:** Accepted.

## Decision

**1. The delivery script calls no monitoring service directly.** It writes run
records to durable storage, and those records are the evidence of execution.
Everything else is assembled from platform signals the host already emits:
container logs, storage metrics, and log queries.

**Why.** The container image is the portable artifact
([ADR-0028](0028-portable-deployment.md)). Embedding a vendor's telemetry SDK in
the entry point would mean the image only produces observability when it runs on
that vendor. The run record is the portable evidence; a cloud dashboard is one
view of it.

**2. Alert destinations are operator data, never template data.** The thing that
receives an alert, and the address it delivers to, is created outside the
deployment template and referenced by id. It is never committed.

**Why.** An address committed to a template means every operator who forks the
repository gets alerts for somebody else's deployment.

**3. Alerting covers four failure classes**, not four products:

| Class | What it catches |
|---|---|
| Missed heartbeat | The schedule did not fire at all. Job disabled, image gone, identity revoked, environment down |
| Run failure | The run fired and failed. Model error, quota exhaustion, defect, mount failure |
| Idle backlog | Work is queued and nothing is burning it down |
| Storage near quota | The evidence store is filling and the archive obligation is being neglected |

The heartbeat alert is the important one and the easiest to omit. A failure
alert only fires when something ran. **Nothing running at all is the silent
failure**, and it is the one that looks identical to a quiet month.

**4. No embedded telemetry SDK, no custom metrics, no distributed tracing.**
All three re-import the portability problem decision 1 exists to prevent, and
tracing in particular buys little for a process whose entire shape is a
sequence of outbound HTTP calls recorded in the run record.

## What is deliberately not in this page

The alert thresholds, evaluation windows, workspace layout and costs describe
one deployment. They are operator choices, and publishing them would present one
organisation's tuning as a requirement.
