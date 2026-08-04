# Foundry delivery platform container image.
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
#   Resolved by:        Docker Registry v2 manifest read against mcr.microsoft.com,
#                       Docker-Content-Digest response header. Reproduce with:
#                         docker manifest inspect --verbose \
#                           mcr.microsoft.com/powershell:7.5-ubuntu-22.04
#
#   Why 7.5 and not 7.4. MCR publishes a 7.4-ubuntu-22.04-EOL tag alongside
#   7.4-ubuntu-22.04, which is how that repository marks a line as ended. 7.5 is
#   the newest non-preview PowerShell on ubuntu-22.04 in MCR; 7.6 exists only as
#   preview-7.6-ubuntu-22.04. Invoke-Project42Delivery.ps1 declares
#   "#Requires -Version 7.4", which 7.5 satisfies.
#
#   ADR-0014 decision 4 also calls for the base to be mirrored into the delivery
#   registry so a rebuild is triggered by an event rather than a 10 to 60 minute
#   poll. The mirror cannot be the default here, because the registry does not
#   exist until delivery-platform.bicep pass 1 runs and the mirror does not
#   exist until az acr import runs. So the default below is the public MCR
#   digest, and BASE_IMAGE is overridden once the mirror exists:
#     az acr import --name <registry> \
#       --source mcr.microsoft.com/powershell@sha256:a3affe99603400235501b8da8be5f9e40152d4db6557f698a91da0280f9e1469 \
#       --image base/powershell@sha256:a3affe99603400235501b8da8be5f9e40152d4db6557f698a91da0280f9e1469
#     docker build --build-arg BASE_IMAGE=<registry>.azurecr.io/base/powershell@sha256:a3affe... .
#   Either way the digest is the same bytes. Only the source of them changes.
#
# BUILD CONTEXT
#   Unchanged: deployment/content-maintenance. Build it with
#     docker build -f deployment/content-maintenance/Dockerfile \
#       deployment/content-maintenance
#
#   WHAT IS DELIBERATELY NOT IN THE IMAGE, and why. Four runtime inputs live
#   outside this context: the JSON schemas and the watched source registry,
#   which belong to the project42-platform repository, the pricing table, which
#   is not in version control at all, and the two briefs, which are the work
#   itself and change far more often than the image does. Two ways to close
#   that were weighed:
#
#     Vendor a copy here. Rejected. It needs the build context widened to the
#     directory holding both repositories, which is 278 MB of context uploaded
#     on every az acr build, and the alternative of committing a duplicate
#     schema means the validation contract can drift from the canonical one in
#     project42-platform with nothing to detect it. The pricing table cannot be
#     vendored under any variant: it is gitignored on purpose.
#
#     A read-only file share on a SEPARATE storage account. Chosen.
#     delivery-platform.bicep mounts it at /mnt/config and points SCHEMA_ROOT,
#     SOURCE_REGISTRY_PATH, PRICING_PATH, and BRIEF_PATH at it. Read-only means
#     a run can read its own spend ceiling and its own conformance contract but
#     cannot rewrite either. The separate account means read-only is backed by
#     a credential boundary and not only by the mount: the key that reaches the
#     pricing table cannot reach the run records, and vice versa. Every one of
#     those paths is a template parameter, so pointing them back at /app costs
#     one parameter change if the schemas are ever vendored.
#
#   The trade being accepted: the contents of that share are not covered by the
#   image digest. deployment/infra/README.md carries the upload step and the
#   obligation to re-upload when a schema changes.

ARG BASE_IMAGE=mcr.microsoft.com/powershell:7.5-ubuntu-22.04@sha256:a3affe99603400235501b8da8be5f9e40152d4db6557f698a91da0280f9e1469

FROM ${BASE_IMAGE} AS base

WORKDIR /app

# Non-root. The job needs no privileged operation.
#
# The UID and GID are pinned rather than allocated, because the run record share
# is mounted over SMB and the mount options in delivery-platform.bicep name this
# exact UID and GID. If you change either number, change containerUid and
# containerGid in that template in the same commit or every run record write
# fails with permission denied.
ARG DELIVERY_UID=10001
ARG DELIVERY_GID=10001
RUN groupadd --gid ${DELIVERY_GID} delivery \
    && useradd --uid ${DELIVERY_UID} --gid ${DELIVERY_GID} --create-home --shell /usr/sbin/nologin delivery \
    && mkdir -p /mnt/run-records \
    && chown ${DELIVERY_UID}:${DELIVERY_GID} /mnt/run-records

# ALL THREE MODULES, not one.
#
# Project42FoundryExecution.psm1 unconditionally imports
# Project42FoundryQualification.psm1 at its top level, and that module holds the
# only definition of Read-Project42Json, which Read-Project42DeliveryCheckpoint
# calls. Omitting it broke the first Import-Module in the entry point, in both
# modes, before a single line of delivery logic ran.
#
# Project42SourceChange.psm1 is the source-change detector engine mode imports
# from SOURCE_CHANGE_MODULE_PATH, which defaults to this directory.
COPY --chown=delivery:delivery Project42FoundryQualification.psm1 ./
COPY --chown=delivery:delivery Project42FoundryExecution.psm1 ./
COPY --chown=delivery:delivery Project42SourceChange.psm1 ./
COPY --chown=delivery:delivery Invoke-Project42Delivery.ps1 ./
COPY --chown=delivery:delivery delivery-prompts/ ./delivery-prompts/
COPY --chown=delivery:delivery style/ ./style/

# A fallback directory the delivery user can actually write to.
#
# WORKDIR created /app root-owned and 0755 before this point, so the non-root
# process could not create /app/private at all. Nothing in a hosted run should
# land here, because every private path is pointed at a mount by
# delivery-platform.bicep, but a local docker run with no mount and no overrides
# falls back to $PSScriptRoot/private and should fail on its merits rather than
# on a permission error.
RUN mkdir -p /app/private /mnt/config \
    && chown ${DELIVERY_UID}:${DELIVERY_GID} /app /app/private /mnt/config

USER delivery

# BUILD-TIME SMOKE LAYER.
#
# This exists so a missing module fails the BUILD, loudly, in front of whoever
# changed it, instead of failing the first scheduled run at 00:00 with a
# stack trace nobody is watching for. Every import below is one the entry point
# performs, and every command asserted is one it calls.
#
# Confirm-Project42SourceChange is asserted alongside Get-Project42SourceChangeSet
# because the detector is a TWO-PHASE commit and only the first phase was being
# checked. Get- observes and returns the change set; Confirm- is what advances
# the stored baseline once a proposal exists for a change. A module carrying the
# first and not the second passed this build, and the engine would then re-fetch
# every watched source and re-propose the same change on every hourly run,
# forever, against a budget that only alerts.
#
# JSON exec form on purpose: the shell form would let /bin/sh expand
# $ErrorActionPreference to the empty string before pwsh ever saw it.
RUN ["pwsh","-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw ('the entry point requires PowerShell 7.4 or later, found ' + $PSVersionTable.PSVersion) }; Import-Module ./Project42FoundryExecution.psm1 -Force; Import-Module ./Project42FoundryQualification.psm1 -Force; Import-Module ./Project42SourceChange.psm1 -Force; foreach ($c in @('Read-Project42DeliveryCheckpoint','Save-Project42DeliveryCheckpoint','New-Project42UntrustedNonce','Assert-Project42SchemaConformance','Get-Project42FoundryRateTable','Read-Project42Json','Get-Project42SourceChangeSet','Confirm-Project42SourceChange')) { if (-not (Get-Command -Name $c -ErrorAction SilentlyContinue)) { throw ('image smoke check failed, command not available: ' + $c) } }; $parseErrors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ./Invoke-Project42Delivery.ps1).Path,[ref]$null,[ref]$parseErrors); if ($parseErrors) { throw 'image smoke check failed, the entry point does not parse' }; Write-Host 'image smoke check passed'"]

# THE FULL ENVIRONMENT CONTRACT, all nineteen variables the entry point and the
# detector read, declared here so `docker inspect` states it and so a local run
# and a hosted run resolve the same paths.
#
# BRIEF_PATH is the nineteenth and it is the one that used to be missing
# entirely. $BriefPath was the only parameter in the entry point's param block
# with no $env: default, so it could not be supplied through the environment at
# all, the CMD below carries no brief argument, and neither job in
# delivery-platform.bicep declared `args` or `command`. Every hosted execution
# therefore threw at "<mode> mode requires -BriefPath" before it reached the
# pricing check, the checkpoint, or the detector. It is left EMPTY here rather
# than given a path, because the harness brief and the engine brief are
# different files by design: the harness reads the whole array as a backlog and
# the engine reads element zero as a template. The job definition supplies the
# right one, and a local `docker run` with nothing set fails on that line with
# an accurate message instead of silently reading the wrong file.
#
# DELIVERY_CHECKPOINT_PATH has ONE value here and TWO in the job definitions,
# for a related reason. Read-Project42DeliveryCheckpoint refuses any checkpoint
# whose mode or run key does not match the run reading it, so the harness and
# the engine cannot share one file without stranding each other. A local run is
# one mode at a time and does not need the split.
#
# delivery-platform.bicep sets every one of these on both jobs and overrides
# what is empty here. The values below are the same values, so a local run
# without the template lands in the same places.
#
# Caps are supplied by the job definition, not defaulted generously here.
#
# NOTHING PRIVATE RESOLVES INSIDE THE IMAGE. Every state path points at
# /mnt/run-records and every configuration path at /mnt/config. A path inside
# the replica is destroyed with the replica, and ADR-0007 decision 7 says a run
# without a record did not happen. The same defect silently voided resume and,
# worse, wiped the detector's digests between runs, so every hourly engine
# execution re-observed all watched sources as new and could never report a
# change. Both mount points are created and chowned above, so an unmounted local
# run still starts; a hosted run gets the same paths backed by durable storage,
# which is what keeps a local run and a hosted run interchangeable (ADR-0015).
#
# The /mnt/config inputs are operator supplied, not baked. The pricing table is
# deliberately not in version control, the schemas are the canonical contract
# owned by project42-platform, the watch list changes on its own cadence, and
# the briefs are the work itself. See deployment/infra/README.md for the upload.
# That share also lives on its own storage account, so the key that can rewrite
# the spend ceiling is not the key that can delete a run record.
ENV DELIVERY_MODE="" \
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
    SOURCE_CHANGE_MODULE_PATH=/app/Project42SourceChange.psm1

# CMD carries -Execute and nothing else, and that is now correct rather than
# incomplete. Every other input, the brief included, arrives through the
# environment, so neither Container Apps Job needs to declare `args` or
# `command` and the image has exactly one supported invocation. Overriding CMD
# with -BriefPath still works and still wins, because a bound parameter beats a
# parameter default.
ENTRYPOINT ["pwsh", "-NoProfile", "-File", "./Invoke-Project42Delivery.ps1"]
CMD ["-Execute"]
