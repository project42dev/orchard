# Orchard 8-phase engine container image.
#
# Authorized by the 2026-08-11 design decision: ACA Jobs is the single platform.
# The 8-phase pipeline (discover -> score -> build DB -> GATE 1 -> briefs ->
# delivery -> ingest -> notify) runs entirely within the container. GitHub
# Actions is not part of the production architecture.
#
# This Dockerfile replaces the delivery-only image. It adds Node.js 22.5+,
# all orchard .mjs scripts, project42-platform content, and a new entrypoint
# (Invoke-Project42Engine.ps1) that orchestrates all 8 phases.
#
# Threat model T7: the base image is pinned by digest, not by a floating tag.
# No credential is baked in, copied in, or expected as an environment variable.
# Authentication is managed identity via IMDS at runtime.
#
# BASE IMAGE PROVENANCE (ADR-0014 decision 4)
#   Tag resolved from:  mcr.microsoft.com/powershell:7.5-ubuntu-22.04
#   Digest:             sha256:a3affe99603400235501b8da8be5f9e40152d4db6557f698a91da0280f9e1469
#   Platform:           linux/amd64
#   Resolved on:        2026-08-03
#
# BUILD CONTEXT
#   Build from the orchard repo root:
#     docker build -f delivery/Dockerfile .
#
#   WHAT IS DELIBERATELY NOT IN THE IMAGE: runtime inputs that live outside this
#   context. See the original Dockerfile comments for the full rationale.
#   - JSON schemas (project42-platform)
#   - Source registry (project42-platform)
#   - Pricing table (not in version control)
#   - Briefs (the work itself, changes more often than the image)
#   These arrive via the /mnt/config file share at runtime.

ARG BASE_IMAGE=mcr.microsoft.com/powershell:7.5-ubuntu-22.04@sha256:a3affe99603400235501b8da8be5f9e40152d4db6557f698a91da0280f9e1469

FROM ${BASE_IMAGE} AS base

WORKDIR /app

# Non-root. The job needs no privileged operation.
# UID/GID pinned because the run record share mount options name these exact values.
ARG DELIVERY_UID=10001
ARG DELIVERY_GID=10001
RUN groupadd --gid ${DELIVERY_GID} delivery \
    && useradd --uid ${DELIVERY_UID} --gid ${DELIVERY_GID} --create-home --shell /usr/sbin/nologin delivery \
    && mkdir -p /mnt/run-records /mnt/config /mnt/corpus /var/lib/orchard \
    && chown ${DELIVERY_UID}:${DELIVERY_GID} /mnt/run-records /mnt/config /mnt/corpus /var/lib/orchard

# ---- Node.js 22.x (required for node:sqlite built-in) ----
# Ubuntu 22.04 ships Node 12. The orchard scripts need >=22.5.0.
# We install from NodeSource, which publishes LTS binaries for Ubuntu.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Verify node:sqlite is available (Node >=22.5.0)
RUN node -e "const sqlite = require('node:sqlite'); console.log('node:sqlite available:', typeof sqlite.DatabaseSync)"

# ---- GitHub CLI (for notify phase issue creation) ----
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# ---- PowerShell delivery modules (unchanged from original) ----
COPY --chown=delivery:delivery delivery/Project42FoundryQualification.psm1 ./
COPY --chown=delivery:delivery delivery/Project42FoundryExecution.psm1 ./
COPY --chown=delivery:delivery delivery/Project42SourceChange.psm1 ./
COPY --chown=delivery:delivery delivery/Invoke-Project42Delivery.ps1 ./
COPY --chown=delivery:delivery delivery/Invoke-Project42Engine.ps1 ./
COPY --chown=delivery:delivery delivery/delivery-prompts/ ./delivery-prompts/
COPY --chown=delivery:delivery delivery/style/ ./style/

# ---- Orchard Node.js scripts (phases 1-4, 6-7) ----
COPY --chown=delivery:delivery scripts/ ./scripts/
COPY --chown=delivery:delivery contracts/ ./contracts/
COPY --chown=delivery:delivery package.json ./
COPY --chown=delivery:delivery package-lock.json ./

# Install npm dependencies (only production deps; mermaid-cli is devDependency)
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ---- project42-platform content (the corpus the engine indexes) ----
# This is the content/ directory from project42-platform that the discovery
# and database phases read. It is copied at build time so the image is
# self-contained for the content it indexes.
#
# If the corpus is mounted externally (via /mnt/corpus), the mount overrides
# this baked copy. The baked copy is the fallback for local runs.
COPY --chown=delivery:delivery content/ ./content/

# ---- Config files ----
COPY --chown=delivery:delivery config/ ./config/
COPY --chown=delivery:delivery seed-inputs/ ./seed-inputs/

# ---- Schema files (SQL, JSON schemas) ----
COPY --chown=delivery:delivery schema/ ./schema/

# ---- Writeable directories ----
RUN mkdir -p /app/private /app/proposals /app/run-records \
    && chown ${DELIVERY_UID}:${DELIVERY_GID} /app /app/private /app/proposals /app/run-records

USER delivery

# ---- BUILD-TIME SMOKE LAYER ----
# Verify PowerShell modules parse and commands are available.
RUN ["pwsh","-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw ('the entry point requires PowerShell 7.4 or later, found ' + $PSVersionTable.PSVersion) }; Import-Module ./Project42FoundryExecution.psm1 -Force; Import-Module ./Project42FoundryQualification.psm1 -Force; Import-Module ./Project42SourceChange.psm1 -Force; foreach ($c in @('Read-Project42DeliveryCheckpoint','Save-Project42DeliveryCheckpoint','New-Project42UntrustedNonce','Assert-Project42SchemaConformance','Get-Project42FoundryRateTable','Read-Project42Json','Get-Project42SourceChangeSet','Confirm-Project42SourceChange')) { if (-not (Get-Command -Name $c -ErrorAction SilentlyContinue)) { throw ('image smoke check failed, command not available: ' + $c) } }; $parseErrors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./Invoke-Project42Delivery.ps1).Path,[ref]$null,[ref]$parseErrors); if ($parseErrors) { throw 'image smoke check failed, the delivery entry point does not parse' }; $null=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./Invoke-Project42Engine.ps1).Path,[ref]$null,[ref]$parseErrors); if ($parseErrors) { throw 'image smoke check failed, the engine entry point does not parse' }; Write-Host 'image smoke check passed'"]

# Verify Node.js scripts parse (syntax check only, no execution).
RUN node --check scripts/discover-content-opportunities.mjs \
    && node --check scripts/score-opportunities.mjs \
    && node --check scripts/build-content-db.mjs \
    && node --check scripts/generate-briefs.mjs \
    && node --check scripts/ingest-proposals.mjs \
    && node --check scripts/notify-review-ready.mjs \
    && node --check scripts/merge-opportunity-proposals.mjs \
    && echo 'all Node.js scripts parse successfully'

# ---- ENVIRONMENT CONTRACT ----
# All variables the engine entry point reads. The delivery entry point's
# variables are a subset of these.
#
# Caps are supplied by the job definition, not defaulted generously here.
# NOTHING PRIVATE RESOLVES INSIDE THE IMAGE.
ENV ORCHARD_STATE_ROOT=/var/lib/orchard \
    DELIVERY_MODE="" \
    BRIEF_PATH="" \
    FOUNDRY_ENDPOINT="" \
    AZURE_CLIENT_ID="" \
    MAX_REQUESTS_PER_RUN=300 \
    MAX_SPEND_USD_PER_RUN=5.00 \
    RUN_TIMEOUT_SECONDS=3600 \
    DATA_TIER_MAX=1 \
    MAX_FETCHES_PER_RUN=120 \
    WORST_CASE_INPUT_USD_PER_MTOK=0 \
    WORST_CASE_OUTPUT_USD_PER_MTOK=0 \
    RUN_RECORD_ROOT=/mnt/run-records \
    DELIVERY_CHECKPOINT_PATH=/mnt/run-records/state/delivery.checkpoint.private.json \
    SOURCE_CHECKPOINT_PATH=/mnt/run-records/state/source-detection.checkpoint.private.json \
    PROPOSAL_ROOT=/mnt/run-records/proposals \
    PRICING_PATH=/mnt/config/pricing.private.json \
    SCHEMA_ROOT=/mnt/config/schemas/content-maintenance \
    SOURCE_REGISTRY_PATH=/mnt/config/source-registry.json \
    SOURCE_CHANGE_MODULE_PATH=/app/Project42SourceChange.psm1 \
    ORCHARD_SURFACE=learn \
    ORCHARD_CORPUS_PATH=/app/content \
    ORCHARD_WORK_DIR=/app \
    ORCHARD_CONFIG_DIR=/mnt/config \
    ORCHARD_DB_PATH=/mnt/run-records/content.db \
    ORCHARD_REGISTRY_PATH=/mnt/run-records/opportunity-registry.json \
    ORCHARD_PROBES_PATH=/app/content/probes.json \
    ORCHARD_DISCOVERY_OUT=/mnt/run-records/discovery-proposals.json \
    ORCHARD_BRIEFS_OUT=/mnt/run-records/briefs-queue.json \
    ORCHARD_INVENTORY_PATH=/mnt/config/deployed-models.json \
    ORCHARD_GAP_THRESHOLD=0 \
    ORCHARD_TIMEOUT=30

# The engine entrypoint replaces the delivery-only entrypoint.
# Override CMD with -SkipDiscovery -SkipScoring etc. for partial runs.
ENTRYPOINT ["pwsh", "-NoProfile", "-File", "./Invoke-Project42Engine.ps1"]
CMD ["-Execute"]
