#Requires -Version 7.4
<#
.SYNOPSIS
    The Foundry delivery platform: drafter, verifier, adversary, arbiter.

.DESCRIPTION
    Authorized by ADR-0007. One platform, two triggers. DELIVERY_MODE selects
    which: 'harness' runs once against a named brief, 'engine' runs on a
    schedule against watched sources.

    Extends the existing qualification harness rather than introducing a second
    Foundry client, per ADR-0007 decision 2.

    Non-negotiable behaviours, inherited and enforced here:
      - Proposes only. Never merges, publishes, tags, deploys, or releases.
      - Every run writes a run record. A run that cannot write one aborts.
      - Caps fail closed: requests, spend, timeout, bounded retries.
      - Data tier 3 is never sent. Tier 2 only redacted.
      - Fetched source content is delimited as untrusted data, never
        instruction (threat model T2, ADR-0015 decision 7).
      - Drafter and verifier must be different provider families.
      - A run is interruptible without re-spending (plan section 8.2).

.NOTES
    Authenticates by managed identity. No key is read, stored, or logged.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSReviewUnusedParameter',
    '',
    Justification = 'Every parameter here is read inside a nested function in this script, which the rule does not follow.'
)]
param(
    [ValidateSet('harness', 'engine')]
    [string] $Mode = $env:DELIVERY_MODE,

    [string] $BriefPath = $env:BRIEF_PATH,

    [string] $Endpoint = $env:FOUNDRY_ENDPOINT,

    [int] $MaxRequestsPerRun = [int]($env:MAX_REQUESTS_PER_RUN ?? 300),

    [decimal] $MaxSpendUsdPerRun = [decimal]($env:MAX_SPEND_USD_PER_RUN ?? '5.00'),

    [int] $RunTimeoutSeconds = [int]($env:RUN_TIMEOUT_SECONDS ?? 3600),

    [int] $MaxDataTier = [int]($env:DATA_TIER_MAX ?? 1),

    [string] $RunRecordRoot = ($env:RUN_RECORD_ROOT ?? (Join-Path $PSScriptRoot 'private/run-records')),

    [string] $PricingPath = ($env:PRICING_PATH ?? (Join-Path $PSScriptRoot 'private/pricing.private.json')),

    # Opt-in, and zero means not configured. Setting these keeps a run going
    # when a deployment is missing from the pricing file, by charging it a
    # deliberately pessimistic rate instead of the zero that used to let it
    # slip past the USD ceiling entirely. Leaving them unset aborts instead,
    # which is the safer default.
    [decimal] $WorstCaseInputUsdPerMillionTokens = [decimal]($env:WORST_CASE_INPUT_USD_PER_MTOK ?? '0'),

    [decimal] $WorstCaseOutputUsdPerMillionTokens = [decimal]($env:WORST_CASE_OUTPUT_USD_PER_MTOK ?? '0'),

    [string] $CheckpointPath = ($env:DELIVERY_CHECKPOINT_PATH ?? (Join-Path $PSScriptRoot 'private/delivery.checkpoint.private.json')),

    [string] $ProposalRoot = ($env:PROPOSAL_ROOT ?? (Join-Path $PSScriptRoot 'private/proposals')),

    [string] $SchemaRoot = ($env:SCHEMA_ROOT ?? (Join-Path $PSScriptRoot '../../project42-platform/schemas/content-maintenance')),

    [string] $SourceChangeModulePath = ($env:SOURCE_CHANGE_MODULE_PATH ?? (Join-Path $PSScriptRoot 'Project42SourceChange.psm1')),

    [string] $SourceRegistryPath = ($env:SOURCE_REGISTRY_PATH ?? (Join-Path $PSScriptRoot '../../project42-platform/content/source-registry.json')),

    [string] $SourceCheckpointPath = ($env:SOURCE_CHECKPOINT_PATH ?? (Join-Path $PSScriptRoot 'private/source-detection.checkpoint.private.json')),

    [switch] $ForceSourceRefresh,

    [switch] $ResetCheckpoint,

    # Test injection only, matching the pattern
    # Invoke-Project42FoundryQualificationExecution already uses. Supplying a
    # transport means no managed identity is requested and no live endpoint is
    # contacted, and the run record says so, so a fixture run can never be read
    # as a real one.
    [scriptblock] $Transport,

    # The detector's own test seam, passed straight through, so the whole
    # engine path can be exercised without fetching anything.
    [scriptblock] $SourceFetchDelegate,

    [switch] $Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'Project42FoundryExecution.psm1') -Force

# ---------------------------------------------------------------- run context

$runId = [guid]::NewGuid().ToString()
$startedUtc = [datetime]::UtcNow
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# One nonce per run, generated here and never written into a version-controlled
# prompt template, so retrieved text cannot forge a closing delimiter and resume
# instruction context (ADR-0015 decision 7).
$runNonce = New-Project42UntrustedNonce

$packetSchemaPath = Join-Path $SchemaRoot 'content-change-packet.schema.json'
$proposalSchemaPath = Join-Path $SchemaRoot 'maintenance-proposal.schema.json'

$worstCaseRate = $null
if (
    $WorstCaseInputUsdPerMillionTokens -gt 0 -and
    $WorstCaseOutputUsdPerMillionTokens -gt 0
) {
    $worstCaseRate = [pscustomobject]@{
        inputUsdPerMillionTokens  = [double] $WorstCaseInputUsdPerMillionTokens
        outputUsdPerMillionTokens = [double] $WorstCaseOutputUsdPerMillionTokens
    }
}

$state = [ordered]@{
    runId              = $runId
    mode               = $Mode
    startedUtc         = $startedUtc.ToString('o')
    requestCount       = 0
    spendUsd           = [decimal]0
    resumedRequests    = 0
    resumedSpendUsd    = [decimal]0
    untrustedBlocks    = 0
    syntheticTransport = [bool] $Transport
    aborted            = $false
    abortReason        = $null
    proposals          = [System.Collections.Generic.List[object]]::new()
    steps              = [System.Collections.Generic.List[object]]::new()
}

function Write-DeliveryLog {
    param([string] $Level, [string] $Message)
    $line = '{0} [{1}] {2}' -f ([datetime]::UtcNow.ToString('o')), $Level.ToUpperInvariant(), $Message
    Write-Host $line
}

# ------------------------------------------------------------ fail-closed caps

function Assert-CapsOrAbort {
    <#
        Every cap is checked BEFORE a request is issued, never after. A run that
        breaches a cap stops rather than continuing (ADR-0007 decision 8).

        The spend cap is checked against the PROJECTED cost of the pending
        request, not only against what has already been spent. Checking only
        what is already spent means the request that crosses the ceiling is
        always allowed through.

        ProjectedUsd lets a caller that has already computed the projection pass
        it in, so the same number gates the request, is reserved against the
        meter, and is later reconciled. Recomputing it in three places invites
        the three to drift.
    #>
    param(
        [int] $PendingRequests = 1,
        [psobject] $Rate,
        [string] $PromptText = '',
        [int] $MaxCompletionTokens = 0,
        [AllowNull()][object] $ProjectedUsd = $null
    )

    if (($state.requestCount + $PendingRequests) -gt $MaxRequestsPerRun) {
        throw "CAP: request ceiling reached ($MaxRequestsPerRun). Aborting rather than continuing."
    }
    if ($state.spendUsd -ge $MaxSpendUsdPerRun) {
        throw ('CAP: spend ceiling reached ({0:N2} USD of {1:N2}). Aborting.' -f $state.spendUsd, $MaxSpendUsdPerRun)
    }
    $projected = $null
    if ($null -ne $ProjectedUsd) {
        $projected = [decimal] $ProjectedUsd
    }
    elseif ($Rate) {
        $projected = [decimal] (
            Get-Project42ProjectedRequestCost `
                -Rate $Rate `
                -PromptText $PromptText `
                -MaximumCompletionTokens $MaxCompletionTokens
        )
    }
    if ($null -ne $projected) {
        if (($state.spendUsd + $projected) -gt $MaxSpendUsdPerRun) {
            throw (
                'CAP: the pending request projects to {0:N4} USD, which would take this run past the {1:N2} USD ceiling ({2:N4} already spent). Aborting before the request.' -f `
                    $projected, $MaxSpendUsdPerRun, $state.spendUsd
            )
        }
    }
    if ($stopwatch.Elapsed.TotalSeconds -ge $RunTimeoutSeconds) {
        throw "CAP: run timeout reached ($RunTimeoutSeconds s). Aborting."
    }
}

# The pending request's reservation, at script scope so the charge scriptblock
# below reaches it the same way it reaches $state. Invoke-DeliveryRole sets
# projectedUsd immediately before dispatch and reads back what was reserved.
$pendingCharge = [pscustomobject]@{
    projectedUsd = [decimal] 0
    attempts     = 0
    reservedUsd  = [decimal] 0
    workItemId   = ''
    durable      = $false
}

# Invoked by Invoke-Project42FoundryRequest before EVERY HTTP attempt, including
# the first and including the injected-transport path.
#
# Metering after the response under-counts, and it under-counts in the
# expensive direction. One logical request is up to MaximumRetries + 1 calls,
# and a client-side timeout arrives with no Response object, is classified
# retryable, and is retried, while the service has already processed and billed
# the original. Charging the pessimistic projection here means a call we never
# saw the answer to is still counted against both ceilings; the attempt that
# does return usage is reconciled down to its measured cost afterwards.
#
# Re-checking the caps on each attempt is deliberate: a retry that would cross
# the ceiling aborts instead of dispatching.
# The reservation is written to the checkpoint BEFORE the dispatch, not after
# it. A charge that only ever lived in memory is lost by the very failure it
# exists to survive: the container is killed, the next scheduled attempt reads a
# checkpoint that never heard about the call, and re-spends. Persisting first
# over-counts by one projection if the process dies in the gap between the write
# and the wire, which is the direction a ceiling is supposed to err in.
$chargeAttempt = {
    param([int] $AttemptNumber)

    $null = $AttemptNumber
    Assert-CapsOrAbort -PendingRequests 1 -ProjectedUsd $pendingCharge.projectedUsd
    $state.requestCount++
    $state.spendUsd += $pendingCharge.projectedUsd
    $pendingCharge.attempts += 1
    $pendingCharge.reservedUsd += $pendingCharge.projectedUsd
    if ($pendingCharge.durable) {
        Save-DeliveryProgress -InFlightWorkItemId $pendingCharge.workItemId
    }
}

# ------------------------------------------------------------------- identity

function Get-DeliveryAccessToken {
    <#
        Managed identity preferred; Azure CLI fallback for local dev.
        ADR-0007 decision 4 and threat model condition 2.
        No key is read from anywhere, and none is accepted as a parameter.

        In GitHub Actions with OIDC, the workflow passes a pre-obtained token
        via FOUNDRY_ACCESS_TOKEN. This avoids the az account get-access-token
        round-trip that can fail when azure/login@v2 uses federated credentials.
    #>
    if ($Transport) {
        Write-DeliveryLog WARN 'TRANSPORT OVERRIDE: no managed-identity token is requested and no live endpoint is contacted. This path is for tests only and the run record is marked synthetic.'
        return 'synthetic-transport-no-credential'
    }

    # Local/dev OIDC path: token passed via environment variable.
    # This is NOT the production path — production uses managed identity below.
    # Retained for local development and emergency GHA fallback only.
    if (-not [string]::IsNullOrWhiteSpace($env:FOUNDRY_ACCESS_TOKEN)) {
        Write-DeliveryLog INFO 'Authenticated via FOUNDRY_ACCESS_TOKEN (local/dev OIDC path).'
        return $env:FOUNDRY_ACCESS_TOKEN
    }

    $clientId = $env:AZURE_CLIENT_ID
    $resource = 'https://cognitiveservices.azure.com'

    # Two managed-identity contracts, and the platform runs on the one that is
    # NOT the well-known address.
    #
    # Container Apps does not expose IMDS at 169.254.169.254. It injects
    # IDENTITY_ENDPOINT and IDENTITY_HEADER into the container and expects the
    # secret echoed back in X-IDENTITY-HEADER, with its own api-version. An
    # earlier revision hardcoded the IMDS address, so every hosted run hung for
    # the full 30 second timeout and aborted with
    #
    #   The request was canceled due to the configured HttpClient.Timeout of 30
    #   seconds elapsing.
    #
    # before issuing a single request. That is what the first real execution
    # did, 2026-08-03, run ab6c2344. No test caught it because every suite
    # passes -Transport, which returns before this function reads anything.
    #
    # IMDS is kept as the fallback so the same entry point still works on a VM
    # or in an environment that does expose it.
    if (-not [string]::IsNullOrWhiteSpace($env:IDENTITY_ENDPOINT)) {
        $uri = '{0}?api-version=2019-08-01&resource={1}&client_id={2}' -f `
            $env:IDENTITY_ENDPOINT, [uri]::EscapeDataString($resource), $clientId
        $headers = @{ 'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER }
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30
        if ([string]::IsNullOrWhiteSpace($response.access_token)) {
            throw 'Managed identity (Container Apps) returned no access token.'
        }
        return $response.access_token
    }

    if (-not [string]::IsNullOrWhiteSpace($clientId)) {
        # Try IMDS (VM managed identity)
        $uri = '{0}?api-version=2018-02-01&resource={1}&client_id={2}' -f `
            'http://169.254.169.254/metadata/identity/oauth2/token',
        [uri]::EscapeDataString($resource),
        $clientId
        $headers = @{ Metadata = 'true' }
        try {
            $response = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 5
            if (-not [string]::IsNullOrWhiteSpace($response.access_token)) {
                return $response.access_token
            }
        }
        catch {
            Write-DeliveryLog INFO 'IMDS unreachable; falling back to Azure CLI for local dev.'
        }
    }

    # Azure CLI fallback for local development (same pattern as
    # Invoke-Project42FoundryQualification.ps1).
    $azToken = & az account get-access-token `
        --scope "$resource/.default" `
        --query accessToken `
        --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($azToken)) {
        throw (
            'Unable to obtain a token. Set AZURE_CLIENT_ID for managed identity, ' +
            'or authenticate Azure CLI (az login) for local development.'
        )
    }
    Write-DeliveryLog INFO 'Authenticated via Azure CLI (local dev).'
    return $azToken
}

# -------------------------------------------------------- data classification

function Assert-DataTierAllowed {
    <#
        Tier 3 is an absolute never-send. Tier 2 only in redacted form. The tier
        is recorded on every request so a violation is detectable in the run
        record rather than merely forbidden in prose (threat model T3).
    #>
    param([Parameter(Mandatory)][int] $Tier, [Parameter(Mandatory)][string] $Label)

    if ($Tier -ge 3) {
        throw "DATA: '$Label' is tier $Tier. Tier 3 is never sent, under any circumstance."
    }
    if ($Tier -gt $MaxDataTier) {
        throw "DATA: '$Label' is tier $Tier, above this run's ceiling of $MaxDataTier. Redact it or raise DATA_TIER_MAX deliberately."
    }
}

# ------------------------------------------------------- untrusted source text

function New-UntrustedBlock {
    <#
        Threat model T2. Content we did not author is delimited and labelled as
        data. The role prompts treat anything inside these markers as quoted
        material to be assessed, never as instruction to follow.

        This is the only way retrieved text is permitted to reach a prompt.
        Invoke-DeliveryRole accepts source text nowhere else, and rejects any
        block that does not carry this run's nonce.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Builds an in-memory prompt block and changes no state.'
    )]
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Text,
        [string] $CanonicalUrl = 'urn:project42:delivery/unspecified-origin',
        [string] $RetrievedAt
    )

    $arguments = @{
        Nonce        = $runNonce
        SourceId     = $Source
        CanonicalUrl = $CanonicalUrl
        Text         = $Text
    }
    if ($RetrievedAt) {
        $arguments.RetrievedAt = $RetrievedAt
    }
    $block = New-Project42UntrustedBlock @arguments
    $state.untrustedBlocks++
    Write-DeliveryLog INFO "untrusted block source=$Source digest=$($block.contentDigest) provenance=untrusted"
    return $block
}

# ------------------------------------------------------------- a single role

function Invoke-DeliveryRole {
    param(
        [Parameter(Mandatory)][ValidateSet('drafter', 'verifier', 'adversary', 'arbiter', 'researcher', 'finalizer')][string] $Role,
        [Parameter(Mandatory)][string] $WorkItemId,
        [Parameter(Mandatory)][string] $WorkItemKey,
        [Parameter(Mandatory)][string] $DeploymentAlias,
        [Parameter(Mandatory)][string] $ProviderFamily,
        [Parameter(Mandatory)][string] $SystemPrompt,
        [Parameter(Mandatory)][string] $UserPrompt,
        [Parameter(Mandatory)][hashtable] $RateTable,
        [Parameter(Mandatory)][string] $AccessToken,
        [psobject[]] $UntrustedBlocks = @(),
        # 4096 was too low for a reasoning deployment and produced a silent
        # empty completion rather than an error. On these models reasoning
        # tokens are billed and counted against max_completion_tokens, so a
        # budget consumed entirely by reasoning returns HTTP 200 with empty
        # message content. gpt-5-6-sol cleared 4096; gpt-5-6-terra did not, on
        # the first full hosted ensemble run, 2026-08-03.
        #
        # The ceiling stays 4096 by DEFAULT and is raised per role in the brief,
        # never globally. Raising the default to 16384 was tried and reverted
        # the same day: this value feeds the pre-flight cost projection, which
        # prices every request at its worst case, so a global raise pushed the
        # projection past the 5.00 USD run ceiling and aborted the run before
        # request one. The guard was right and the change was wrong.
        #
        # Set roles.<role>.maxCompletionTokens in the brief for a deployment
        # that genuinely needs more, and accept that it consumes more of the run
        # budget. The drafter also now fails loudly on an empty completion
        # instead of crashing the verifier's parameter binding.
        [int] $MaxCompletionTokens = 4096,
        [int] $DataTier = 1,
        [object] $Temperature = $null
    )

    Assert-DataTierAllowed -Tier $DataTier -Label "$Role/$DeploymentAlias"

    # Structural guarantee for threat model condition 6: retrieved text reaches
    # a prompt only inside a nonce-fenced block built this run.
    Assert-Project42UntrustedBlockSet -Blocks $UntrustedBlocks -Nonce $runNonce

    $userSections = [System.Collections.Generic.List[string]]::new()
    $userSections.Add($UserPrompt)
    foreach ($block in $UntrustedBlocks) {
        $userSections.Add($block.block)
    }
    $user = $userSections -join "`n`n"

    $prompt = [pscustomobject]@{
        system = $SystemPrompt
        user   = $user
    }
    $inputMaterial = $prompt.system + "`n" + $prompt.user
    $inputDigest = Get-Project42ExecutionDigest -Value $inputMaterial

    # Role-level resume. The key must identify the QUESTION, and the rendered
    # prompt cannot do that: it carries this run's fence nonce, which is fresh
    # every run by design, so a digest of it never matches across attempts. The
    # key is therefore taken over the nonce-free projection of the same inputs,
    # the two prompts plus each fenced block's source and content digest. A
    # different brief, a different draft upstream, or different retrieved text
    # all still miss and are paid for.
    $roleKey = '{0}|{1}|{2}' -f $WorkItemKey, $Role, (
        Get-Project42ExecutionDigest -Value (
            @(
                $SystemPrompt
                $UserPrompt
                @(
                    $UntrustedBlocks |
                    ForEach-Object { "$($_.sourceId)|$($_.contentDigest)" }
                )
            ) -join "`n"
        )
    )
    # An empty completion is never a reusable answer. It was cached as one, and
    # that made the defect it causes unfixable in place: the drafter returned
    # empty, the empty string was checkpointed as a paid result, and every
    # subsequent attempt replayed it from cache without calling the deployment
    # again. Raising the role's token budget then changed nothing, because no
    # request was issued to spend it. Observed 2026-08-03 on gpt-5-6-terra,
    # where an 8192 budget appeared to have no effect at all.
    #
    # Dropping the entry rather than serving it means the next attempt pays for
    # a real request. That is the correct trade: the run already paid for a
    # result it cannot use, and replaying it forever guarantees the run can
    # never succeed.
    if ($roleCache.Contains($roleKey) -and [string]::IsNullOrWhiteSpace([string] $roleCache[$roleKey].content)) {
        Write-DeliveryLog WARN "role=$Role deployment=$DeploymentAlias had an EMPTY completion in the checkpoint. Discarding it and re-requesting; an empty answer is not reusable."
        $null = $roleCache.Remove($roleKey)
    }

    if ($roleCache.Contains($roleKey)) {
        $cached = $roleCache[$roleKey]
        Write-DeliveryLog INFO "role=$Role deployment=$DeploymentAlias reused from checkpoint; an earlier attempt of this run already paid for it."
        return (
            New-DeliveryRoleResult `
                -Record $cached `
                -InputMaterial $inputMaterial `
                -UntrustedBlocks $UntrustedBlocks `
                -Reused $true
        )
    }

    # The rate is resolved BEFORE the request, so an unpriced deployment aborts
    # without spending anything at all.
    $rate = Get-Project42EffectiveRate `
        -RateTable $RateTable `
        -DeploymentAlias $DeploymentAlias `
        -WorstCaseRate $worstCaseRate

    $projected = [decimal] (
        Get-Project42ProjectedRequestCost `
            -Rate $rate `
            -PromptText $inputMaterial `
            -MaximumCompletionTokens $MaxCompletionTokens
    )
    Assert-CapsOrAbort -ProjectedUsd $projected

    Write-DeliveryLog INFO "role=$Role deployment=$DeploymentAlias tier=$DataTier untrustedBlocks=$($UntrustedBlocks.Count) priced=$($rate.priced)"

    $requestArguments = @{
        Endpoint                = $Endpoint
        AccessToken             = $AccessToken
        DeploymentAlias         = $DeploymentAlias
        ProviderFamily          = $ProviderFamily
        Prompt                  = $prompt
        TimeoutSeconds          = 300
        MaximumRetries          = 2
        MaximumCompletionTokens = $MaxCompletionTokens
        OnAttempt               = $chargeAttempt
    }
    if ($null -ne $Temperature) {
        $requestArguments.Temperature = $Temperature
    }
    if ($Transport) {
        $requestArguments.Transport = $Transport
    }

    # Arm the reservation, then dispatch. Every attempt inside the call charges
    # $projected before it touches the wire, so an attempt that is billed but
    # never answered is still on the meter when this throws.
    $pendingCharge.projectedUsd = $projected
    $pendingCharge.attempts = 0
    $pendingCharge.reservedUsd = [decimal] 0
    $pendingCharge.workItemId = $WorkItemId
    $pendingCharge.durable = $true
    $result = Invoke-Project42FoundryRequest @requestArguments

    # Always charged. An unpriced deployment either aborted above or is being
    # charged the configured worst case; nothing reaches this line at zero cost
    # by accident.
    $cost = Get-Project42RequestCost -Rate $rate `
        -PromptTokens $result.promptTokens -CompletionTokens $result.completionTokens

    # Reconcile only the attempt that came back with usage. Earlier attempts
    # keep their pessimistic reservation, because what they consumed before the
    # client gave up on them is exactly what we cannot know.
    $state.spendUsd += ([decimal] $cost - $projected)

    $record = [pscustomobject][ordered]@{
        key              = $roleKey
        workItemId       = $WorkItemId
        role             = $Role
        deployment       = $DeploymentAlias
        providerFamily   = $ProviderFamily
        dataTier         = $DataTier
        temperature      = $Temperature
        maxTokens        = $MaxCompletionTokens
        pricedDeployment = [bool] $rate.priced
        inputDigest      = $inputDigest
        content          = [string] $result.content
        promptTokens     = [int] $result.promptTokens
        completionTokens = [int] $result.completionTokens
        latencyMs        = [long] $result.latencyMs
        costUsd          = [double] $cost
        attempts         = [int] $pendingCharge.attempts
        reservedUsd      = [double] $pendingCharge.reservedUsd
        completedUtc     = [datetime]::UtcNow.ToString('o')
    }
    $roleCache[$roleKey] = $record

    # Persisted per ROLE, not per work item. A work item that reliably dies on
    # its fourth role used to re-buy the first three on every scheduled hour;
    # now the next attempt reads them back and pays for the fourth only.
    Save-DeliveryProgress -InFlightWorkItemId $WorkItemId

    return (
        New-DeliveryRoleResult `
            -Record $record `
            -InputMaterial $inputMaterial `
            -UntrustedBlocks $UntrustedBlocks `
            -Reused $false
    )
}

function New-DeliveryRoleResult {
    <#
        One shape for a role's outcome whether it was just executed or read back
        from the checkpoint, so the two paths cannot drift. The step is appended
        to the run record here, marked with whether this attempt paid for it, so
        the record distinguishes work done now from work inherited.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Appends an in-memory run-record step and returns it.'
    )]
    param(
        [Parameter(Mandatory)][psobject] $Record,
        [Parameter(Mandatory)][string] $InputMaterial,
        [Parameter(Mandatory)][AllowEmptyCollection()][psobject[]] $UntrustedBlocks,
        [Parameter(Mandatory)][bool] $Reused
    )

    $step = [ordered]@{
        role                 = [string] $Record.role
        deployment           = [string] $Record.deployment
        providerFamily       = [string] $Record.providerFamily
        dataTier             = [int] $Record.dataTier
        untrustedProvenance  = ($UntrustedBlocks.Count -gt 0)
        untrustedDigests     = @($UntrustedBlocks | ForEach-Object { $_.contentDigest })
        pricedDeployment     = [bool] $Record.pricedDeployment
        promptTokens         = [int] $Record.promptTokens
        completionTokens     = [int] $Record.completionTokens
        latencyMs            = [long] $Record.latencyMs
        estimatedUsd         = [double] $Record.costUsd
        reusedFromCheckpoint = $Reused
        inputDigest          = [string] $Record.inputDigest
        contentDigest        = Get-Project42ExecutionDigest -Value ([string] $Record.content)
        completedUtc         = [string] $Record.completedUtc
    }
    $state.steps.Add([pscustomobject]$step)

    return [pscustomobject]@{
        role          = [string] $Record.role
        content       = [string] $Record.content
        deployment    = [string] $Record.deployment
        provider      = [string] $Record.providerFamily
        inputMaterial = $InputMaterial
        temperature   = $Record.temperature
        maxTokens     = [int] $Record.maxTokens
        result        = [pscustomobject]@{
            content          = [string] $Record.content
            promptTokens     = [int] $Record.promptTokens
            completionTokens = [int] $Record.completionTokens
            latencyMs        = [long] $Record.latencyMs
        }
        cost          = [double] $Record.costUsd
        reused        = $Reused
        step          = $step
    }
}

# --------------------------------------------------------------- verdict parse

function Get-RoleVerdict {
    <#
        The role prompts end with a machine-readable verdict line. Anything that
        does not parse is treated as a failure, never as a pass. The arbiter's
        RESOLUTION line is parsed the same way, and an unparseable arbiter
        resolution falls closed to HUMAN.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $Content,
        [Parameter(Mandatory)][ValidateSet('verifier', 'adversary', 'arbiter')][string] $Role
    )

    $verdict = Get-Project42RoleVerdict -Content $Content -Role $Role
    if (-not $verdict.parsed) {
        Write-DeliveryLog WARN "role=$Role emitted no parseable verdict; treating as $($verdict.verdict)"
    }
    return $verdict.verdict
}

# --------------------------------------------------------- source change input

function Import-DeliverySourceChangeModule {
    <#
        Engine mode's detector is a separate component (Feature 5135, ADR-0015).
        This imports it by name and fails with an actionable message rather than
        a stack trace when it is not present.
    #>
    if (-not (Test-Path -LiteralPath $SourceChangeModulePath -PathType Leaf)) {
        throw (
            'engine mode requires the source-change detector module ' +
            "Project42SourceChange.psm1, which is not present at " +
            "$SourceChangeModulePath. Build or deploy that module (ADR-0015, " +
            'Feature 5135), or set SOURCE_CHANGE_MODULE_PATH to its location. ' +
            'Harness mode does not need it.'
        )
    }
    Import-Module $SourceChangeModulePath -Force
    if (-not (Get-Command -Name 'Get-Project42SourceChangeSet' -ErrorAction SilentlyContinue)) {
        throw (
            "$SourceChangeModulePath does not export " +
            'Get-Project42SourceChangeSet. Engine mode needs that command and ' +
            'will not guess at a substitute.'
        )
    }
}

function Get-DeliverySourceChangeSet {
    <#
        Returns the detector's observations, validated against the contract this
        script codes to, so a drift in the partner module is reported here
        rather than surfacing as a malformed packet later.
    #>
    Import-DeliverySourceChangeModule

    if (-not (Test-Path -LiteralPath $SourceRegistryPath -PathType Leaf)) {
        throw (
            "engine mode requires the source registry at $SourceRegistryPath. " +
            'Set SOURCE_REGISTRY_PATH to the registry in project42-platform.'
        )
    }
    $detectorCheckpointDirectory = Split-Path -Parent $SourceCheckpointPath
    if (-not (Test-Path -LiteralPath $detectorCheckpointDirectory -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $detectorCheckpointDirectory -Force
    }

    $arguments = @{
        RegistryPath   = $SourceRegistryPath
        CheckpointPath = $SourceCheckpointPath
    }
    if ($ForceSourceRefresh) {
        $arguments.Force = $true
    }
    if ($SourceFetchDelegate) {
        $arguments.FetchDelegate = $SourceFetchDelegate
    }

    # Two-phase, when the detector offers it. The detector's default advances
    # the stored digest the moment it observes a change, which CONSUMES the
    # change: this run then has the only copy of it, and a run that aborts,
    # skips, or dies takes it with it. Deferring means the change is re-reported
    # until Confirm-DeliverySourceChange acknowledges it downstream, so the only
    # way to lose one is for this component to succeed at handling it.
    #
    # Probed rather than assumed, because the detector is a separate component
    # (Feature 5135) and an older copy of it will not have the parameter. An
    # older copy is not silently tolerated: it warns loudly, because the
    # lost-change window is exactly what the caller is trying to close.
    $detector = Get-Command -Name 'Get-Project42SourceChangeSet'
    if ($detector.Parameters.ContainsKey('DeferChangeCommit')) {
        $arguments.DeferChangeCommit = $true
    }
    else {
        Write-DeliveryLog WARN (
            'The source-change detector does not support DeferChangeCommit, ' +
            'so a detected change is committed the moment it is observed. If ' +
            'this run fails before emitting a proposal for it, that change is ' +
            'gone and will not be detected again. Update ' +
            'Project42SourceChange.psm1.'
        )
    }
    $changeSet = @(Get-Project42SourceChangeSet @arguments)

    foreach ($entry in $changeSet) {
        foreach ($required in @('sourceId', 'url', 'state', 'checkedAt')) {
            if (-not $entry.PSObject.Properties[$required]) {
                throw (
                    "The source-change detector returned an observation with " +
                    "no '$required'. The contract requires sourceId, url, " +
                    'state, previousDigest, currentDigest, and checkedAt.'
                )
            }
        }
        if (@('unchanged', 'changed', 'unreachable') -notcontains [string] $entry.state) {
            throw (
                "The source-change detector returned state " +
                "'$($entry.state)' for $($entry.sourceId). Expected " +
                'unchanged, changed, or unreachable.'
            )
        }
    }
    return $changeSet
}

# --------------------------------------------------------------- work items

function Get-DeliveryWorkItemSet {
    <#
        One shape for both triggers. A harness brief is a work item whose change
        set is whatever the brief declares; an engine work item is one detected
        source change, with the brief supplying the role assignments and target.
    #>
    param([Parameter(Mandatory)][psobject[]] $Briefs)

    $items = [System.Collections.Generic.List[object]]::new()

    if ($Mode -eq 'harness') {
        foreach ($brief in $Briefs) {
            $items.Add([pscustomobject]@{
                    id        = [string] $brief.id
                    brief     = $brief
                    changeSet = @(
                        Get-Project42OptionalValue -InputObject $brief -Name 'sourceChanges' -Default @()
                    )
                })
        }
        return @($items)
    }

    $template = $Briefs[0]
    $changeSet = Get-DeliverySourceChangeSet
    $changed = @($changeSet | Where-Object { [string] $_.state -eq 'changed' })
    $unreachable = @($changeSet | Where-Object { [string] $_.state -eq 'unreachable' })

    Write-DeliveryLog INFO "detector: $(@($changeSet).Count) watched, $($changed.Count) changed, $($unreachable.Count) unreachable"
    foreach ($entry in $unreachable) {
        # ADR-0015 decision 6. An unreachable source is never a change, and it
        # is an operations finding rather than a content proposal.
        # The detector already carries the reason. Dropping it produced 29
        # identical "was unreachable" lines on the first hosted engine run and
        # no way to tell a 403 from a DNS failure from a timeout, which is the
        # same diagnostic gap the Foundry error path had. Print it.
        $reason = [string] (Get-Project42OptionalValue -InputObject $entry -Name 'reason' -Default '')
        $because = if ([string]::IsNullOrWhiteSpace($reason)) { '' } else { " Reason: $reason." }
        Write-DeliveryLog WARN "source-health: $($entry.sourceId) ($($entry.url)) was unreachable.$because Not a change; the stored digest is untouched."
    }

    # ADR-0015 decision 8: no model call is made unless a digest changed.
    foreach ($entry in $changed) {
        $items.Add([pscustomobject]@{
                id        = "$($template.id)-$($entry.sourceId)"
                brief     = $template
                changeSet = @($entry)
            })
    }
    return @($items)
}

function Get-DeliveryWorkItemKey {
    <#
        The identity of a unit of WORK, which is not the identity of the thing
        the work is about.

        Engine mode derives a work item id from the source that changed, so the
        id is stable for the life of that registry entry. Using it alone as the
        completion key meant that once anthropic-docs had been processed once,
        every later change to anthropic-docs was skipped as "already completed",
        forever. Folding in the digests of the change itself makes a second
        genuine change to the same source a different unit of work, which is
        what it is, while a retry of the SAME change still matches and is still
        skipped without re-spending.
    #>
    param([Parameter(Mandatory)][psobject] $WorkItem)

    $changed = @(
        $WorkItem.changeSet |
        Where-Object {
            (Get-Project42OptionalValue -InputObject $_ -Name 'evidencePacket' -Default '') -or
            [string] $_.state -eq 'changed'
        } |
        ForEach-Object {
            $evidencePacketPath = [string] (
                Get-Project42OptionalValue -InputObject $_ -Name 'evidencePacket' -Default ''
            )
            if ($evidencePacketPath) {
                "$evidencePacketPath"
            }
            else {
                "$([string] $_.sourceId)|$([string] $_.previousDigest)|$([string] $_.currentDigest)"
            }
        } |
        Sort-Object
    )
    $changeDigest = Get-Project42ExecutionDigest -Value ($changed -join "`n")
    return "$([string] $WorkItem.id)|$changeDigest"
}

function Save-DeliveryProgress {
    <#
        Writes the caps and everything finished so far, after every ROLE rather
        than after every work item.

        Per-work-item persistence made the inherited count bound only completed
        items. A work item that died on its fourth role recorded nothing, so the
        next attempt started that item from zero and bought roles one to three
        again. On an hourly schedule with a replica retry, an item that reliably
        fails late re-spent up to the per-run ceiling every single invocation,
        against a budget that only alerts.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Writes the resume checkpoint to the configured path.'
    )]
    param([string] $InFlightWorkItemId = '')

    $checkpoint.requestCount = [int] $state.requestCount
    $checkpoint.spendUsd = [double] $state.spendUsd
    $checkpoint.completed = @($completed)
    $checkpoint.roles = @($roleCache.Values)
    $checkpoint.inFlight = if ([string]::IsNullOrWhiteSpace($InFlightWorkItemId)) {
        $null
    }
    else {
        [pscustomobject][ordered]@{
            workItemId  = $InFlightWorkItemId
            observedUtc = [datetime]::UtcNow.ToString('o')
        }
    }
    Save-Project42DeliveryCheckpoint `
        -Checkpoint $checkpoint `
        -CheckpointPath $CheckpointPath
}

function Confirm-DeliverySourceChange {
    <#
        The second half of the detector's two-phase commit. Called once this run
        has emitted a proposal for the change, or has recorded that it already
        did on an earlier attempt. Idempotent: acknowledging a change with
        nothing pending is a no-op, which is what makes it safe to call from
        both the fresh-completion path and the already-completed path.

        Engine mode only. In harness mode the change set comes from the brief,
        so there is no detector baseline to advance.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Advances the detection checkpoint at the configured path.'
    )]
    param([Parameter(Mandatory)][psobject] $WorkItem)

    if ($Mode -ne 'engine') {
        return
    }
    if (-not (Get-Command -Name 'Confirm-Project42SourceChange' -ErrorAction SilentlyContinue)) {
        return
    }
    foreach (
        $entry in @($WorkItem.changeSet | Where-Object { [string] $_.state -eq 'changed' })
    ) {
        $acknowledged = Confirm-Project42SourceChange `
            -CheckpointPath $SourceCheckpointPath `
            -SourceId ([string] $entry.sourceId) `
            -Url ([string] $entry.url) `
            -AcknowledgedDigest ([string] $entry.currentDigest)
        Write-DeliveryLog INFO (
            "source-commit: $($entry.sourceId) advanced=$($acknowledged.advanced) " +
            "($($acknowledged.reason))"
        )
    }
}

function Get-DeliveryUntrustedBlockSet {
    <#
        Every piece of retrieved text that will reach a prompt, wrapped. Text
        can arrive on a change-set entry (an excerpt or a bounded diff), as an
        explicit untrustedSources entry on a brief, or as an evidence packet
        (a JSON file of observations produced by Invoke-EngineeringEvidenceFeed).
        There is no fourth path, and no path that skips the wrapper.
    #>
    param([Parameter(Mandatory)][psobject] $WorkItem)

    $blocks = [System.Collections.Generic.List[object]]::new()

    foreach ($entry in @($WorkItem.changeSet)) {
        # Evidence packet: a JSON file of observations from the engineering
        # evidence feed. Each observation becomes an untrusted block.
        $evidencePacketPath = [string] (
            Get-Project42OptionalValue -InputObject $entry -Name 'evidencePacket' -Default ''
        )
        if ($evidencePacketPath) {
            $resolvedPath = if ([System.IO.Path]::IsPathRooted($evidencePacketPath)) {
                $evidencePacketPath
            }
            else {
                Join-Path $PSScriptRoot '..' $evidencePacketPath
            }
            if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
                Write-DeliveryLog WARN "evidence packet not found: $resolvedPath (referenced by sourceChanges entry, skipping)"
                continue
            }
            try {
                $packet = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
                foreach ($obs in @(Get-Project42OptionalValue -InputObject $packet -Name 'observations' -Default @())) {
                    $obsId = [string] (Get-Project42OptionalValue -InputObject $obs -Name 'id' -Default 'unknown')
                    $obsSource = [string] (Get-Project42OptionalValue -InputObject $obs -Name 'source' -Default 'evidence-packet')
                    $obsLocation = [string] (Get-Project42OptionalValue -InputObject $obs -Name 'location' -Default '')
                    $obsContent = [string] (Get-Project42OptionalValue -InputObject $obs -Name 'content' -Default '')
                    $obsDigest = [string] (Get-Project42OptionalValue -InputObject $obs -Name 'digest' -Default '')
                    if ($obsContent) {
                        $blocks.Add(
                            (New-UntrustedBlock -Source "$obsSource/$obsId" -CanonicalUrl "urn:project42:evidence/$obsLocation" -Text $obsContent -RetrievedAt ([string] $packet.createdAt))
                        )
                    }
                }
                Write-DeliveryLog INFO "evidence: loaded $($blocks.Count) untrusted block(s) from $evidencePacketPath"
            }
            catch {
                Write-DeliveryLog WARN "evidence packet $resolvedPath could not be parsed: $($_.Exception.Message)"
            }
            continue
        }

        $sourceId = [string] $entry.sourceId
        $url = [string] $entry.url
        $retrievedAt = [string] (
            Get-Project42OptionalValue -InputObject $entry -Name 'checkedAt' -Default ''
        )
        $excerpt = [string] (
            Get-Project42OptionalValue -InputObject $entry -Name 'excerpt' -Default ''
        )
        if (-not [string]::IsNullOrWhiteSpace($excerpt)) {
            $blocks.Add(
                (New-UntrustedBlock -Source $sourceId -CanonicalUrl $url -Text $excerpt -RetrievedAt $retrievedAt)
            )
        }
        $diffOrdinal = 0
        foreach (
            $section in @(
                Get-Project42OptionalValue -InputObject $entry -Name 'boundedDiff' -Default @()
            )
        ) {
            $diffOrdinal++
            $before = [string] (Get-Project42OptionalValue -InputObject $section -Name 'before' -Default '')
            $after = [string] (Get-Project42OptionalValue -InputObject $section -Name 'after' -Default '')
            $text = "section: $($section.section)`nbefore:`n$before`nafter:`n$after"
            $blocks.Add(
                (New-UntrustedBlock -Source "$sourceId-diff-$diffOrdinal" -CanonicalUrl $url -Text $text -RetrievedAt $retrievedAt)
            )
        }
    }

    foreach (
        $source in @(
            Get-Project42OptionalValue -InputObject $WorkItem.brief -Name 'untrustedSources' -Default @()
        )
    ) {
        $blocks.Add(
            (
                New-UntrustedBlock `
                    -Source ([string] $source.sourceId) `
                    -CanonicalUrl ([string] (Get-Project42OptionalValue -InputObject $source -Name 'url' -Default 'urn:project42:delivery/unspecified-origin')) `
                    -Text ([string] (Get-Project42OptionalValue -InputObject $source -Name 'text' -Default '')) `
                    -RetrievedAt ([string] (Get-Project42OptionalValue -InputObject $source -Name 'retrievedAt' -Default ''))
            )
        )
    }

    return @($blocks)
}

function Get-DeliveryCitationBlockSet {
    <#
        Retrieves the sources a draft cites and returns them as untrusted
        blocks, so the verifier can actually read what it is being asked to
        check.

        WHY THIS EXISTS. The verifier is told to check every citation and is
        forbidden from passing one it did not read. It was then given no
        network access and no source text, so every cited claim came back
        CANNOT VERIFY and the artifact failed on that alone. Measured on a real
        run: all four acceptance criteria MET, no em-dashes, no uncited claims,
        no contradictions, and VERDICT: FAIL, because "the verifier cannot
        retrieve any URLs and the prompt contains no verbatim excerpts". The
        control was structurally impossible to satisfy, which makes it a
        rejection stamp rather than a check.

        Retrieved text is EVIDENCE, never instruction. It goes through the same
        nonce-fenced wrapper as every other untrusted input, so a page that
        tries to address the model is contained by the same control that
        contains a changed source.

        Bounded on purpose: a small number of sources, truncated, fail-open to
        an absent block rather than aborting the run. A citation that cannot be
        fetched simply stays CANNOT VERIFY, which is the honest outcome.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $DraftText,
        [int] $MaximumSources = 6,
        [int] $MaximumCharacters = 20000
    )

    $blocks = [System.Collections.Generic.List[object]]::new()
    if ([string]::IsNullOrWhiteSpace($DraftText)) { return @($blocks) }

    # The detector module owns the only fetch path that enforces https-only
    # redirects and the response ceiling, so citation retrieval reuses it rather
    # than opening a second, less careful way onto the network. It is imported
    # on demand here because harness mode does not otherwise need it, and a
    # harness run must not fail merely because it cited something.
    if (-not (Get-Command Invoke-Project42SourceFetch -ErrorAction SilentlyContinue)) {
        try { Import-DeliverySourceChangeModule }
        catch {
            Write-DeliveryLog WARN "citations: the source-change module could not be loaded ($($_.Exception.Message)), so cited sources cannot be retrieved. Every citation stays CANNOT VERIFY."
            return @($blocks)
        }
    }
    if (-not (Get-Command Invoke-Project42SourceFetch -ErrorAction SilentlyContinue)) {
        Write-DeliveryLog WARN 'citations: the fetch primitive is unavailable, so cited sources cannot be retrieved. Every citation stays CANNOT VERIFY.'
        return @($blocks)
    }

    $urls = [System.Collections.Generic.List[string]]::new()
    foreach ($match in [regex]::Matches($DraftText, 'https://[^\s)\]<>"'']+')) {
        $url = ($match.Value -replace '[.,;:]+$', '')
        if (-not $urls.Contains($url)) { $urls.Add($url) }
        if ($urls.Count -ge $MaximumSources) { break }
    }
    if ($urls.Count -eq 0) { return @($blocks) }

    Write-DeliveryLog INFO "citations: retrieving $($urls.Count) cited source(s) so the verifier can read them."
    foreach ($url in $urls) {
        try {
            $response = Invoke-Project42SourceFetch -Request ([pscustomobject]@{
                    url            = $url
                    sourceId       = 'citation'
                    publisher      = 'cited-source'
                    timeoutSeconds = 20
                })
            $status = [int] $response.statusCode
            if ($status -lt 200 -or $status -ge 300 -or [string]::IsNullOrWhiteSpace([string] $response.content)) {
                Write-DeliveryLog WARN "citation unreadable: $url -> HTTP $status. It stays CANNOT VERIFY."
                continue
            }
            $text = ([string] $response.content)
            $text = ($text -replace '<script\b[^>]*>[\s\S]*?</script>', ' ')
            $text = ($text -replace '<style\b[^>]*>[\s\S]*?</style>', ' ')
            $text = ($text -replace '<[^>]+>', ' ')
            $text = ($text -replace '\s+', ' ').Trim()
            if ($text.Length -gt $MaximumCharacters) {
                $text = $text.Substring(0, $MaximumCharacters) + ' [truncated]'
            }
            $blocks.Add(
                (New-UntrustedBlock `
                    -Source "citation-$($blocks.Count + 1)" `
                    -CanonicalUrl $url `
                    -Text $text `
                    -RetrievedAt ([DateTimeOffset]::UtcNow.ToString('o')))
            )
        }
        catch {
            Write-DeliveryLog WARN "citation fetch failed: $url -> $($_.Exception.Message). It stays CANNOT VERIFY."
        }
    }
    Write-DeliveryLog INFO "citations: $($blocks.Count) of $($urls.Count) retrieved and fenced for review."
    return @($blocks)
}

# ---------------------------------------------------------- proposal emission

function New-DeliveryStageRecord {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Builds an in-memory proposal stage record only.'
    )]
    param(
        [Parameter(Mandatory)][psobject] $RoleResult,
        [Parameter(Mandatory)][psobject] $Brief,
        [Parameter(Mandatory)][ValidateSet('passed', 'failed', 'human-review')][string] $Status,
        [string[]] $ExtraFindings = @()
    )

    $roleConfig = $Brief.roles.($RoleResult.role)
    $stage = [string] (
        Get-Project42OptionalValue `
            -InputObject $roleConfig `
            -Name 'stage' `
            -Default (Get-Project42DeliveryRoleStage -Role $RoleResult.role)
    )

    # A replayed role is disclosed rather than presented as fresh. The output
    # came from an earlier attempt, and the input evidence digest below covers
    # THIS attempt's rendering of the identical question. The two renderings
    # differ only in the per-run fence nonce, which is regenerated every run on
    # purpose, but a reviewer should be told rather than left to work it out.
    $findings = $ExtraFindings
    if ($RoleResult.reused) {
        $findings = $findings + @(
            'This role was not executed by this attempt. Its output was ' +
            'produced by an earlier attempt of the same run and replayed from ' +
            'the checkpoint, so it was not paid for twice. The input evidence ' +
            "digest covers this attempt's rendering of the identical question, " +
            'which differs from the original only in the per-run fence nonce.'
        )
    }

    return New-Project42ProposalModelStage `
        -Stage $stage `
        -DeploymentAlias $RoleResult.deployment `
        -ProviderFamily $RoleResult.provider `
        -ModelVersion ([string] (Get-Project42OptionalValue -InputObject $roleConfig -Name 'modelVersion' -Default 'unrecorded')) `
        -ContractVersion ([string] (Get-Project42OptionalValue -InputObject $Brief -Name 'contractVersion' -Default 'delivery-prompts-1.0')) `
        -InputEvidence $RoleResult.inputMaterial `
        -Output $RoleResult.content `
        -Status $Status `
        -MaxOutputTokens $RoleResult.maxTokens `
        -LatencyMs ([double] $RoleResult.result.latencyMs) `
        -CostUsd ([double] $RoleResult.cost) `
        -Temperature $RoleResult.temperature `
        -ExtraFindings ($findings + @("Delivery role: $($RoleResult.role)."))
}

function Get-DeliveryRolePrompt {
    <#
        Loads a role prompt and substitutes its runtime placeholders.

        TWO DEFECTS THIS EXISTS TO FIX, both found by reading what the models
        actually said rather than by reading the code.

        1. {{FETCH_MODE}} was NEVER substituted. verifier.md carried the literal
           text "**{{FETCH_MODE}}**", so the verifier never learned whether it
           could retrieve URLs. Its own instructions then told it to write
           CANNOT VERIFY for anything it could not check, and it did, for every
           claim, and failed the work item.

        2. The models treat the real current date as fabricated. Every
           CANNOT VERIFY in the first real run was "future-dated source not
           retrievable", and the adversary raised "the check date has not
           occurred" as its single Critical finding. Their training cutoffs
           precede today, so a correctly dated artifact looks like a forgery to
           them.

        The fix for 2 is not to hide the date. It is to state plainly that the
        date is real, that the model's own cutoff is behind it, and that
        "I cannot retrieve this" is a statement about the reviewer's access and
        never evidence that a claim is false. Conflating those two is what
        turned an unverifiable citation into a failed artifact.
    #>
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][bool] $CanRetrieveUrls
    )

    $path = Join-Path $PSScriptRoot "delivery-prompts/$Name.md"
    $text = Get-Content -LiteralPath $path -Raw

    $fetchMode = if ($CanRetrieveUrls) {
        'You CAN retrieve URLs in this run.'
    }
    else {
        'You CANNOT retrieve URLs in this run. No network tool is attached.'
    }

    $grounding = @(
        ''
        '## Today, and what you can conclude from not being able to check something'
        ''
        "The current date is $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-dd')) and it is real."
        'It is later than your training cutoff. A date in this artifact that is'
        'later than anything you remember is therefore expected, and is NOT'
        'evidence of fabrication. Do not raise a correct current date as a'
        'finding.'
        ''
        'You have no network access unless the line above says otherwise.'
        '**"I cannot retrieve this source" is a statement about your access. It'
        'is never evidence that the claim is false.** Report it as CANNOT VERIFY'
        'and let it weigh accordingly. Do not fail an artifact because its'
        'sources postdate your training data, and do not treat unreachable as'
        'refuted.'
        ''
        'Judge what you CAN judge: internal consistency, whether the artifact'
        'meets the acceptance criteria stated above it, unsupported figures,'
        'overclaiming, hidden assumptions, and omissions a reader would trip'
        'over.'
        ''
    ) -join "`n"

    return ($text -replace '\{\{FETCH_MODE\}\}', $fetchMode) + $grounding
}


function Normalize-DeliveryArtifactContent {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $Content,
        [object] $Brief
    )
    if ([string]::IsNullOrWhiteSpace($Content)) { return $Content }

    $isJsonTarget = $false
    $isMmdTarget = $false
    if ($null -ne $Brief -and $null -ne $Brief.targets) {
        foreach ($t in $Brief.targets) {
            if ($null -ne $t.pathPrefixes) {
                foreach ($p in $t.pathPrefixes) {
                    if ($p -match '\.json$') { $isJsonTarget = $true }
                    if ($p -match '\.mmd$') { $isMmdTarget = $true }
                }
            }
        }
    }

    if ($isJsonTarget) {
        $trimmed = $Content.Trim()
        if ($trimmed -match '^`(?:json)?\s*([\s\S]*?)\s*``$') {
            $trimmed = $Matches[1].Trim()
        }
        try {
            $null = $trimmed | ConvertFrom-Json
            return $trimmed
        }
        catch {
            $startIdx = $trimmed.IndexOf('{')
            $endIdx = $trimmed.LastIndexOf('}')
            if ($startIdx -ge 0 -and $endIdx -gt $startIdx) {
                $sub = $trimmed.Substring($startIdx, ($endIdx - $startIdx + 1)).Trim()
                try {
                    $null = $sub | ConvertFrom-Json
                    return $sub
                }
                catch { }
            }
        }
    }
    elseif ($isMmdTarget) {
        $trimmed = $Content.Trim()
        if ($trimmed -match '^`(?:mermaid)?\s*([\s\S]*?)\s*``$') {
            return $Matches[1].Trim()
        }
    }

    return $Content
}

function Write-DeliveryProposal {
    <#
        Emits the evidence packet and the proposal that cites it, both validated
        against the published schemas before anything is written.

        ADR-0004 is binding. The proposal is inert: humanDecision is pending,
        there is no reviewer, and no code path here approves, merges, tags,
        publishes, or closes anything.
    #>
    param(
        [Parameter(Mandatory)][psobject] $WorkItem,
        [Parameter(Mandatory)][psobject[]] $ExecutedStages,
        [Parameter(Mandatory)][bool] $Survives,
        [string[]] $UnresolvedConflicts = @(),
        [psobject[]] $UntrustedBlocks = @()
    )

    $changed = @($WorkItem.changeSet | Where-Object { [string] (Get-Project42OptionalValue -InputObject $_ -Name 'state' -Default '') -eq 'changed' })

    # An authoring brief has no changed source by definition, and for a long
    # time that meant it could never emit a proposal: the ensemble ran, spent
    # real money, and its output died in the run record. The platform was
    # "working" and producing nothing publishable.
    #
    # An authoring proposal is evidence-linked to the REQUEST instead, and the
    # packet says so rather than dressing a request up as a detected change. A
    # brief that names no targets still emits nothing, because a proposal that
    # cannot say which repository and paths it applies to cannot be reviewed.
    $authoringBasis = $null
    if ($changed.Count -eq 0) {
        $declaredTargets = @(
            Get-Project42OptionalValue -InputObject $WorkItem.brief -Name 'targets' -Default @()
        )
        if ($declaredTargets.Count -eq 0) {
            Write-DeliveryLog WARN "brief=$($WorkItem.id): no changed source and no targets, so no proposal. Add a targets array to the brief to make it an authoring brief. The ensemble result is in the run record."
            return $null
        }

        $authoringBasis = [pscustomobject]@{
            briefId       = [string] $WorkItem.id
            requestedAt   = [DateTimeOffset]::UtcNow.ToString('o')
            # Digest the REQUEST, so a reviewer can tell whether the brief moved
            # after the proposal was written.
            requestDigest = Get-Project42ExecutionDigest -Value (
                @(
                    [string] $WorkItem.id
                    [string] $WorkItem.brief.prompt
                    @(
                        Get-Project42OptionalValue `
                            -InputObject $WorkItem.brief -Name 'acceptanceCriteria' -Default @()
                    ) -join "`n"
                ) -join "`n"
            )
        }
        Write-DeliveryLog INFO "brief=$($WorkItem.id): authoring proposal, evidence-linked to the request rather than to a source change."
    }

    if (-not (Test-Path -LiteralPath $ProposalRoot -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $ProposalRoot -Force
    }

    $slug = Get-Project42StableId -Value "$($WorkItem.id)-$($runId.Substring(0, 8))"
    $packet = New-Project42ContentChangePacket `
        -PacketId "packet-$slug" `
        -ChangeSet $changed `
        -Disposition ($Survives ? 'ready-for-draft' : 'blocked') `
        -SchemaPath $packetSchemaPath `
        -Impact (Get-Project42OptionalValue -InputObject $WorkItem.brief -Name 'impact' -Default $null) `
        -Claims @(Get-Project42OptionalValue -InputObject $WorkItem.brief -Name 'claims' -Default @()) `
        -AuthoringBasis $authoringBasis

    $packetPath = Join-Path $ProposalRoot "packet-$slug.json"
    $packetWrite = Write-Project42DeliveryDocument `
        -Document $packet `
        -Path $packetPath `
        -SchemaPath $packetSchemaPath `
        -DocumentLabel 'content-change packet'

    $targets = @(Get-Project42OptionalValue -InputObject $WorkItem.brief -Name 'targets' -Default @())
    if ($targets.Count -eq 0) {
        throw (
            "brief '$($WorkItem.id)' emits a proposal but names no targets. A " +
            'proposal that does not say which repository and paths it applies ' +
            'to cannot be reviewed. Add a targets array to the brief.'
        )
    }

    $gates = @(
        # The gate reports what it actually verified and, just as importantly,
        # what it did not. A reviewer who reads "passed" against a gate named
        # untrusted-source-delimiting will otherwise take it to cover every
        # untrusted thing in the chain, and this control is the one a human
        # decision is leaning on.
        [pscustomobject]@{
            id          = 'untrusted-source-delimiting'
            status      = 'passed'
            evidenceRef = (
                "run ${runId}: SOURCE-TEXT CHANNEL ONLY. " +
                "$($UntrustedBlocks.Count) block(s) of retrieved source text " +
                '(detector excerpts, bounded diffs, brief-supplied untrusted ' +
                'sources) were nonce-fenced as untrusted data before any ' +
                'prompt, and none contained the delimiter token or the run ' +
                'nonce. NOT COVERED: model output passed between roles is not ' +
                'fenced. The draft reaches the verifier and the adversary, and ' +
                'the draft plus both reports reach the arbiter, as ordinary ' +
                'prompt text. That is an accepted scoping decision, not an ' +
                'omission, and it means a later role can be steered by an ' +
                'earlier one. Read every inter-role quotation as unfenced ' +
                '(threat model T2, ADR-0015 decision 7).'
            )
        }
        [pscustomobject]@{
            id          = 'provider-independence'
            status      = 'passed'
            evidenceRef = (
                "run ${runId}: drafter " +
                "$($WorkItem.brief.roles.drafter.providerFamily) and verifier " +
                "$($WorkItem.brief.roles.verifier.providerFamily) are " +
                'different provider families (ADR-0007).'
            )
        }
        [pscustomobject]@{
            id          = 'caller-side-ceilings'
            status      = 'passed'
            evidenceRef = (
                "run ${runId}: $($state.requestCount) of $MaxRequestsPerRun " +
                "requests and $([Math]::Round($state.spendUsd, 4)) of " +
                "$MaxSpendUsdPerRun USD, both checked before every request " +
                '(ADR-0007 decision 8).'
            )
        }
        [pscustomobject]@{
            id          = 'human-publication-gate'
            status      = 'passed'
            evidenceRef = (
                "run ${runId}: this proposal is inert. Automation proposes and " +
                'never publishes (ADR-0004, ADR-0007 decision 6).'
            )
        }
        [pscustomobject]@{
            id          = 'evidence-packet-schema'
            status      = 'passed'
            evidenceRef = (
                "$([IO.Path]::GetFileName($packetPath)) validates against " +
                "content-change-packet.schema.json; digest $($packetWrite.digest)."
            )
        }
    )

    $rollback = (
        'No change has been applied anywhere. This proposal is a document, not ' +
        'a patch: nothing was merged, published, tagged, deployed, or closed. ' +
        "Rollback is to discard proposal $slug and its packet at " +
        "$([IO.Path]::GetFileName($packetPath)). If a human later acts on it, " +
        'rollback reverts to the normal versioned release process named in ' +
        'ADR-0004 step 7.'
    )

    $proposal = New-Project42MaintenanceProposal `
        -ProposalId "proposal-$slug" `
        -PacketId ([string] $packet.id) `
        -PacketDigest $packetWrite.digest `
        -Targets $targets `
        -ExecutedStages $ExecutedStages `
        -DeterministicGates $gates `
        -RollbackPlan $rollback `
        -UnresolvedConflicts $UnresolvedConflicts `
        -SchemaPath $proposalSchemaPath

    $proposalPath = Join-Path $ProposalRoot "proposal-$slug.json"
    $proposalWrite = Write-Project42DeliveryDocument `
        -Document $proposal `
        -Path $proposalPath `
        -SchemaPath $proposalSchemaPath `
        -DocumentLabel 'maintenance proposal'

    Write-DeliveryLog INFO "proposal emitted: $proposalPath (pending human decision, disposition $($packet.disposition))"

    return [pscustomobject]@{
        packetPath     = $packetPath
        packetDigest   = $packetWrite.digest
        proposalPath   = $proposalPath
        proposalDigest = $proposalWrite.digest
        disposition    = [string] $packet.disposition
    }
}

# ----------------------------------------------------------------- run record

function Write-RunRecord {
    <#
        A run without a record did not happen (ADR-0007 decision 7). This is
        called from finally, so an aborted run still leaves evidence.
    #>
    param([string] $Outcome)

    $state.outcome = $Outcome
    $state.completedUtc = [datetime]::UtcNow.ToString('o')
    $state.elapsedSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
    $state.totalRequests = $state.requestCount
    $state.totalEstimatedUsd = [Math]::Round($state.spendUsd, 6)

    if (-not (Test-Path $RunRecordRoot)) {
        New-Item -ItemType Directory -Path $RunRecordRoot -Force | Out-Null
    }
    $path = Join-Path $RunRecordRoot ("run-{0:yyyyMMdd-HHmmss}-{1}.json" -f $startedUtc, $runId.Substring(0, 8))
    ([pscustomobject]$state) | ConvertTo-Json -Depth 10 | Set-Content -Path $path -Encoding utf8
    Write-DeliveryLog INFO "run record written: $path"
    return $path
}

# ------------------------------------------------------------------- the loop

$outcome = 'failed'
try {
    if (-not $Mode) { throw 'DELIVERY_MODE is not set. Expected harness or engine.' }
    if (-not $Endpoint) { throw 'FOUNDRY_ENDPOINT is not set.' }

    Write-DeliveryLog INFO "run=$runId mode=$Mode caps: requests<=$MaxRequestsPerRun spend<=$MaxSpendUsdPerRun timeout=${RunTimeoutSeconds}s tier<=$MaxDataTier"

    if (-not $Execute) {
        Write-DeliveryLog INFO 'PLAN ONLY. No request will be issued. Pass -Execute to run.'
        $outcome = 'planned'
        return
    }

    # Brief: what to draft or revise. The harness takes one per work item; the
    # engine takes one template and applies it to each detected source change.
    if (-not $BriefPath) { throw "$Mode mode requires -BriefPath." }
    if (-not (Test-Path $BriefPath)) { throw "brief not found: $BriefPath" }
    $briefs = @(Get-Content $BriefPath -Raw | ConvertFrom-Json)

    $workItems = @(Get-DeliveryWorkItemSet -Briefs $briefs)
    if ($workItems.Count -eq 0) {
        Write-DeliveryLog INFO 'Nothing to do: no source changed and no brief item is pending. No model call was made.'
        $outcome = 'succeeded'
        return
    }

    $accessToken = Get-DeliveryAccessToken

    if (-not (Test-Path -LiteralPath $PricingPath -PathType Leaf)) {
        if ($null -eq $worstCaseRate) {
            throw (
                "The pricing file is not present at $PricingPath. Without rates " +
                'the USD ceiling cannot be enforced, and this run will not proceed ' +
                'with an unenforceable spend cap. Set PRICING_PATH, or configure ' +
                'WORST_CASE_INPUT_USD_PER_MTOK and WORST_CASE_OUTPUT_USD_PER_MTOK ' +
                'deliberately.'
            )
        }
        Write-DeliveryLog WARN "Pricing file not found at $PricingPath; using worst-case rates (input=$($worstCaseRate.inputUsdPerMillionTokens)/Mtok, output=$($worstCaseRate.outputUsdPerMillionTokens)/Mtok) for all deployments."
        $pricing = [pscustomobject]@{
            schemaVersion = '1.0'
            currency      = 'USD'
            asOf          = [DateTimeOffset]::UtcNow.ToString('o')
            rates         = @()
        }
    }
    else {
        $pricing = Get-Content -LiteralPath $PricingPath -Raw |
        ConvertFrom-Json -Depth 30 -DateKind String
    }
    $rateTable = Get-Project42FoundryRateTable -Pricing $pricing -RequiredAliases @()

    # Pre-flight the pricing of every deployment this run will touch, so an
    # unpriced one aborts before request number one rather than part way
    # through, having already spent money that no ceiling counted.
    $requiredAliases = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($item in $workItems) {
        foreach ($roleName in @('researcher', 'drafter', 'verifier', 'adversary', 'arbiter', 'finalizer')) {
            $roleConfig = Get-Project42OptionalValue -InputObject $item.brief.roles -Name $roleName -Default $null
            if ($null -ne $roleConfig) {
                $null = $requiredAliases.Add([string] $roleConfig.deployment)
            }
        }
    }
    foreach ($alias in $requiredAliases) {
        $null = Get-Project42EffectiveRate `
            -RateTable $rateTable `
            -DeploymentAlias $alias `
            -WorstCaseRate $worstCaseRate
    }

    # Checkpoint and resume (plan section 8.2), following the pattern
    # Invoke-Project42FoundryQualificationExecution already uses.
    $checkpointDirectory = Split-Path -Parent $CheckpointPath
    if (-not (Test-Path -LiteralPath $checkpointDirectory -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $checkpointDirectory -Force
    }
    if ($ResetCheckpoint -and (Test-Path -LiteralPath $CheckpointPath -PathType Leaf)) {
        Remove-Item -LiteralPath $CheckpointPath -Force
        Write-DeliveryLog WARN "checkpoint reset on request: $CheckpointPath"
    }
    # The run key identifies the BRIEF DEFINITION this run executes, not the
    # input it was handed. Keying it on the work items meant that in engine mode
    # it was a digest over whichever sources happened to have moved, so the next
    # scheduled hour with a different set of changes read the surviving
    # checkpoint, decided it described "different work", and aborted. The
    # scheduled job then stayed aborted until a human deleted the file. A brief
    # is the work; which sources moved is data.
    #
    # In harness mode work items are the briefs one for one, so this is the same
    # key it always was, and a run pointed at a different brief file is still
    # refused.
    $runKey = Get-Project42ExecutionDigest -Value (
        (
            $briefs |
            ForEach-Object {
                "$([string] $_.id)|$(Get-Project42ExecutionDigest -Value ([string] $_.prompt))"
            } |
            Sort-Object
        ) -join "`n"
    )
    $checkpoint = Read-Project42DeliveryCheckpoint `
        -CheckpointPath $CheckpointPath `
        -RunKey $runKey `
        -Mode $Mode

    # A resumed run inherits what previous attempts already spent, so the caps
    # bound the work rather than each attempt at it.
    $state.resumedRequests = [int] $checkpoint.requestCount
    $state.resumedSpendUsd = [decimal] $checkpoint.spendUsd
    $state.requestCount = [int] $checkpoint.requestCount
    $state.spendUsd = [decimal] $checkpoint.spendUsd
    $completed = [System.Collections.Generic.List[object]]::new()
    $completedKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($entry in @($checkpoint.completed)) {
        $completed.Add($entry)
        # workItemKey scopes completion to the change that produced the item, so
        # a later change to the same source is new work rather than a repeat.
        # An entry written before that key existed carries no key and therefore
        # suppresses nothing, which costs one repeated work item on upgrade and
        # cannot silently drop one.
        $null = $completedKeys.Add(
            [string] (
                Get-Project42OptionalValue -InputObject $entry -Name 'workItemKey' -Default ''
            )
        )
    }
    $roleCache = [ordered]@{}
    foreach ($entry in @($checkpoint.roles)) {
        $roleCache[[string] $entry.key] = $entry
    }
    if ($completed.Count -gt 0 -or $roleCache.Count -gt 0) {
        Write-DeliveryLog INFO "resuming: $($completed.Count) work item(s) already complete, $($roleCache.Count) role(s) already answered, $($state.requestCount) request(s) and $([Math]::Round($state.spendUsd, 4)) USD already spent"
    }

    foreach ($item in $workItems) {
        $brief = $item.brief
        $workItemKey = Get-DeliveryWorkItemKey -WorkItem $item
        if ($completedKeys.Contains($workItemKey)) {
            Write-DeliveryLog INFO "skipping '$($item.id)': already completed in an earlier attempt of this run."
            # Acknowledge anyway. An earlier attempt may have emitted the
            # proposal and then died before advancing the detector baseline, and
            # this call is a no-op when there is nothing pending.
            Confirm-DeliverySourceChange -WorkItem $item
            continue
        }
        $acceptanceCriteria = @(
            Get-Project42OptionalValue -InputObject $brief -Name 'acceptanceCriteria' -Default @()
        )
        if ($acceptanceCriteria.Count -lt 1) {
            Write-DeliveryLog WARN "skipping '$($item.id)': no acceptance criteria. Nothing can verify it."
            continue
        }

        $unresolved = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in @($item.changeSet | Where-Object {
                    $entryState = Get-Project42OptionalValue -InputObject $_ -Name 'state' -Default ''
                    $entryState -eq 'unreachable'
                })) {
            $unresolved.Add(
                "Source $($entry.sourceId) ($($entry.url)) was unreachable at " +
                "$($entry.checkedAt). Treated as no change, not as a change. " +
                'This is a source-health finding for operations, not evidence.'
            )
        }

        # Every piece of retrieved text this work item will show a model, fenced
        # once and reused by every role, so a forged delimiter aborts before the
        # first request rather than between roles.
        $untrusted = @(Get-DeliveryUntrustedBlockSet -WorkItem $item)

        $changed = @($item.changeSet | Where-Object {
                (Get-Project42OptionalValue -InputObject $_ -Name 'evidencePacket' -Default '') -or
                [string] $_.state -eq 'changed'
            })
        $evidenceLines = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in $changed) {
            $evidencePacketPath = [string] (
                Get-Project42OptionalValue -InputObject $entry -Name 'evidencePacket' -Default ''
            )
            if ($evidencePacketPath) {
                $evidenceLines.Add("evidencePacket=$evidencePacketPath (pre-generated diff evidence)")
            }
            else {
                $evidenceLines.Add(
                    "sourceId=$($entry.sourceId) url=$($entry.url) " +
                    "previousDigest=$($entry.previousDigest) " +
                    "currentDigest=$($entry.currentDigest) checkedAt=$($entry.checkedAt)"
                )
            }
        }
        $draftPrompt = @(
            "Work item: $($item.id)"
            'Acceptance criteria:'
            (@($acceptanceCriteria | ForEach-Object { "- $_" }) -join "`n")
            ''
            [string] $brief.prompt
        )
        if ($evidenceLines.Count -gt 0) {
            $draftPrompt += @(
                ''
                'Changed sources under review (metadata, from our own detector):'
                ($evidenceLines -join "`n")
            )
        }
        $draftUserPrompt = ($draftPrompt -join "`n")

        # The review roles were handed ONLY the draft text. The verifier
        # therefore reported "no explicit acceptance criteria are stated in the
        # supplied prompt or artifact, therefore CANNOT TELL for every
        # criterion" and failed the work item on that basis. It was being asked
        # to judge against a rubric it had never been given.
        #
        # Both review roles now receive the same acceptance criteria the drafter
        # was held to, ahead of the draft.
        $reviewHeader = @(
            "Work item: $($item.id)"
            'Acceptance criteria this artifact must satisfy:'
            (@($acceptanceCriteria | ForEach-Object { "- $_" }) -join "`n")
            ''
            'Artifact under review follows.'
            ''
        ) -join "`n"

        # Researcher runs first, before the drafter. It gathers evidence the
        # drafter will need and flags gaps the supplied material cannot fill.
        # The researcher is optional: a brief without a researcher role skips
        # this step and the drafter works from the supplied material alone.
        $researcherConfig = Get-Project42OptionalValue -InputObject $brief.roles -Name 'researcher' -Default $null
        $researcherResult = $null
        $researchFindings = ''
        if ($null -ne $researcherConfig) {
            $researcherPrompt = @(
                "Work item: $($item.id)"
                'Acceptance criteria:'
                (@($acceptanceCriteria | ForEach-Object { "- $_" }) -join "`n")
                ''
                [string] $brief.prompt
            )
            if ($evidenceLines.Count -gt 0) {
                $researcherPrompt += @(
                    ''
                    'Changed sources under review (metadata, from our own detector):'
                    ($evidenceLines -join "`n")
                )
            }
            $researcherUserPrompt = ($researcherPrompt -join "`n")

            $researcherResult = Invoke-DeliveryRole -Role researcher `
                -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
                -DeploymentAlias $researcherConfig.deployment `
                -ProviderFamily $researcherConfig.providerFamily `
                -SystemPrompt (Get-DeliveryRolePrompt -Name 'researcher' -CanRetrieveUrls $false) `
                -UserPrompt $researcherUserPrompt -RateTable $rateTable -AccessToken $accessToken `
                -UntrustedBlocks $untrusted `
                -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $researcherConfig -Name 'maxCompletionTokens' -Default 4096)) `
                -Temperature (Get-Project42OptionalValue -InputObject $researcherConfig -Name 'temperature' -Default $null)

            $researchFindings = [string] $researcherResult.content
            Write-DeliveryLog INFO "brief=$($item.id) researcher completed"
        }

        # If the researcher ran, prepend its findings to the drafter's prompt
        # so the drafter works from gathered evidence rather than raw material.
        $drafterPrompt = $draftUserPrompt
        if ($researchFindings) {
            $drafterPrompt = @(
                'RESEARCH FINDINGS (gathered before drafting; use these facts and sources):'
                $researchFindings
                ''
                '---'
                ''
                $draftUserPrompt
            ) -join "`n"
        }

        $draft = Invoke-DeliveryRole -Role drafter `
            -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
            -DeploymentAlias $brief.roles.drafter.deployment `
            -ProviderFamily $brief.roles.drafter.providerFamily `
            -SystemPrompt (Get-DeliveryRolePrompt -Name 'drafter' -CanRetrieveUrls $false) `
            -UserPrompt $drafterPrompt -RateTable $rateTable -AccessToken $accessToken `
            -UntrustedBlocks $untrusted `
            -Temperature (Get-Project42OptionalValue -InputObject $brief.roles.drafter -Name 'temperature' -Default $null) `
            -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $brief.roles.drafter -Name 'maxCompletionTokens' -Default 4096))

        # An empty draft is a role failure, not a crash. A reasoning deployment
        # can return HTTP 200 with empty message content, most often when the
        # completion budget was consumed by reasoning tokens, and the verifier's
        # -UserPrompt is mandatory. Left unguarded this surfaced as
        #
        #   Cannot bind argument to parameter 'UserPrompt' because it is an
        #   empty string.
        #
        # pointing at this file rather than at the deployment that returned
        # nothing, which is the opposite of actionable. Observed on the first
        # full hosted ensemble run, 2026-08-03, from gpt-5-6-terra. The drafter
        # call is already metered and checkpointed by this point, so failing
        # here does not lose the spend record.
        $draft.content = Normalize-DeliveryArtifactContent -Content ([string] $draft.content) -Brief $brief

        if ([string]::IsNullOrWhiteSpace($draft.content)) {
            throw (
                "role=drafter deployment=$($brief.roles.drafter.deployment) returned an " +
                'empty completion, so there is nothing to verify. This is usually a ' +
                'completion budget consumed by reasoning tokens. Raise the budget for ' +
                'this deployment or choose a drafter that returns prose.'
            )
        }

        # The review roles get the sources the draft cites, fenced as untrusted
        # evidence, so "check every citation and never pass one you did not
        # read" is a check they can actually perform rather than a rejection
        # stamp. The drafter deliberately does NOT get these: its job is to
        # write from the material it was given, and handing it the same pages
        # would make the verifier's independent read worthless.
        $citationBlocks = @(Get-DeliveryCitationBlockSet -DraftText ([string] $draft.content))
        $reviewBlocks = @($untrusted) + $citationBlocks

        # The verifier must not share a provider family with the drafter. A
        # single-vendor injection or blind spot then has to work twice.
        if ($brief.roles.verifier.providerFamily -eq $brief.roles.drafter.providerFamily) {
            throw "INDEPENDENCE: verifier and drafter are both $($brief.roles.drafter.providerFamily). They must differ."
        }

        $verify = Invoke-DeliveryRole -Role verifier `
            -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
            -DeploymentAlias $brief.roles.verifier.deployment `
            -ProviderFamily $brief.roles.verifier.providerFamily `
            -SystemPrompt (Get-DeliveryRolePrompt -Name 'verifier' -CanRetrieveUrls ($citationBlocks.Count -gt 0)) `
            -UserPrompt ($reviewHeader + $draft.content) -RateTable $rateTable -AccessToken $accessToken `
            -UntrustedBlocks $reviewBlocks `
            -Temperature (Get-Project42OptionalValue -InputObject $brief.roles.verifier -Name 'temperature' -Default $null) `
            -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $brief.roles.verifier -Name 'maxCompletionTokens' -Default 4096))

        $adversary = Invoke-DeliveryRole -Role adversary `
            -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
            -DeploymentAlias $brief.roles.adversary.deployment `
            -ProviderFamily $brief.roles.adversary.providerFamily `
            -SystemPrompt (Get-DeliveryRolePrompt -Name 'adversary' -CanRetrieveUrls ($citationBlocks.Count -gt 0)) `
            -UserPrompt ($reviewHeader + $draft.content) -RateTable $rateTable -AccessToken $accessToken `
            -UntrustedBlocks $reviewBlocks `
            -Temperature (Get-Project42OptionalValue -InputObject $brief.roles.adversary -Name 'temperature' -Default $null) `
            -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $brief.roles.adversary -Name 'maxCompletionTokens' -Default 4096))

        $verdictV = Get-RoleVerdict -Content $verify.content -Role verifier
        $verdictA = Get-RoleVerdict -Content $adversary.content -Role adversary

        Write-DeliveryLog INFO "brief=$($item.id) verifier=$verdictV adversary=$verdictA"

        # Agreement: a draft survives only when the verifier passes it AND the
        # adversary fails to refute it. Anything else goes to a human, never to
        # a pull request.
        $survives = ($verdictV -eq 'PASS') -and ($verdictA -eq 'STANDS')

        # A split is the two roles reaching opposite conclusions about the same
        # artifact: one says it holds, the other says it does not. Agreement in
        # either direction needs no arbiter.
        $split = (
            (($verdictV -eq 'PASS') -and ($verdictA -eq 'REFUTED')) -or
            (($verdictV -eq 'FAIL') -and ($verdictA -eq 'STANDS'))
        )
        $arbiterConfig = Get-Project42OptionalValue -InputObject $brief.roles -Name 'arbiter' -Default $null
        $verdictR = $null
        $arbiterResult = $null
        if ($split -and $null -ne $arbiterConfig) {
            # arbiter.md is explicit that the arbiter is not part of the default
            # path and runs on human request. Configuring an arbiter role on the
            # brief IS that request, made in advance by the person who wrote the
            # brief. Its resolution annotates the proposal for a reviewer; it
            # decides nothing, because the proposal stays pending regardless.
            $arbiterPrompt = @(
                "Work item: $($item.id)"
                'The verifier and the adversary disagree.'
                "Verifier verdict: $verdictV. Adversary verdict: $verdictA."
                ''
                'DRAFT:'
                [string] $draft.content
                ''
                'VERIFIER REPORT:'
                [string] $verify.content
                ''
                'ADVERSARY REPORT:'
                [string] $adversary.content
            ) -join "`n"

            # The arbiter was the one role that ignored the brief's token budget
            # and stayed pinned at the 4096 default. It is also the role with
            # the longest input, the draft plus two full reports, so a reasoning
            # deployment here is the likeliest of the four to spend its whole
            # budget on reasoning and return an empty completion. Same fix as
            # the other three roles.
            $arbiterResult = Invoke-DeliveryRole -Role arbiter `
                -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
                -DeploymentAlias $arbiterConfig.deployment `
                -ProviderFamily $arbiterConfig.providerFamily `
                -SystemPrompt (Get-DeliveryRolePrompt -Name 'arbiter' -CanRetrieveUrls $false) `
                -UserPrompt $arbiterPrompt -RateTable $rateTable -AccessToken $accessToken `
                -UntrustedBlocks $untrusted `
                -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $arbiterConfig -Name 'maxCompletionTokens' -Default 4096)) `
                -Temperature (Get-Project42OptionalValue -InputObject $arbiterConfig -Name 'temperature' -Default $null)

            $verdictR = Get-RoleVerdict -Content $arbiterResult.content -Role arbiter
            Write-DeliveryLog INFO "brief=$($item.id) arbiter=$verdictR"

            # BUG FIXED 2026-08-17, found live: this line used to read
            # `$survives = ($verdictR -eq 'VERIFIER') -and ($verdictV -eq 'PASS')`,
            # which made $survives -- and therefore the ready-for-draft/blocked
            # disposition below -- depend on the arbiter's verdict. That
            # directly contradicted the two comments immediately above and
            # below it (arbiter.md: "you are not part of the default path... a
            # human asked for your opinion"; this function: "the proposal
            # stays pending regardless... a human decides regardless; the
            # arbiter annotates, it does not approve"). In production every
            # split whose arbiter did not say VERIFIER was silently sent to
            # 'blocked' -- unreviewable until tonight's blocked-item-recovery
            # fix, and even after that fix a retried split landed right back
            # on the same arbiter verdict and re-blocked, because nothing
            # about the split itself had changed. A split is a disagreement,
            # not a verdict, so it must reach a human -- $survives stays true
            # here; the arbiter's resolution is recorded below as context for
            # that human, exactly as arbiter.md says it should be.
            $survives = $true
            $unresolved.Add(
                "Verifier said $verdictV and the adversary said $verdictA. The " +
                "arbiter resolved to $verdictR. A human decides regardless; " +
                'the arbiter annotates, it does not approve.'
            )
        }
        elseif ($split) {
            # Same bug, same fix: a split with no arbiter configured is still
            # a split, not a verdict. $survives already carries the pre-split
            # value computed above (always false for a split, since the two
            # roles disagree by definition) -- explicitly overridden here so
            # this branch is not silently correct only because $arbiterConfig
            # happens to be set on every brief in production today.
            $survives = $true
            $unresolved.Add(
                "Verifier said $verdictV and the adversary said $verdictA, " +
                'which is a split. No arbiter role is configured on this ' +
                'brief, so the split is unresolved and goes to a human as it ' +
                'stands.'
            )
        }

        $stages = [System.Collections.Generic.List[object]]::new()
        if ($null -ne $researcherResult) {
            $stages.Add(
                (
                    New-DeliveryStageRecord -RoleResult $researcherResult -Brief $brief `
                        -Status ([string]::IsNullOrWhiteSpace($researcherResult.content) ? 'failed' : 'passed')
                )
            )
        }
        $stages.Add(
            (
                New-DeliveryStageRecord -RoleResult $draft -Brief $brief `
                    -Status ([string]::IsNullOrWhiteSpace($draft.content) ? 'failed' : 'passed')
            )
        )
        $stages.Add(
            (
                New-DeliveryStageRecord -RoleResult $verify -Brief $brief `
                    -Status (($verdictV -eq 'PASS') ? 'passed' : 'failed') `
                    -ExtraFindings @("Verifier verdict: $verdictV.")
            )
        )
        $stages.Add(
            (
                New-DeliveryStageRecord -RoleResult $adversary -Brief $brief `
                    -Status (($verdictA -eq 'STANDS') ? 'passed' : 'failed') `
                    -ExtraFindings @("Adversary verdict: $verdictA.")
            )
        )
        # The arbiter and the finalizer both map onto the schema's single
        # 'release-proposal' stage ($script:Project42DeliveryRoleStage), and
        # New-Project42MaintenanceProposal refuses two stage records that
        # claim the same name ("Two delivery roles both claim the
        # release-proposal proposal stage"). When both roles are configured
        # this collided on every such brief, not just a second item in a
        # session. The finalizer already supersedes the arbiter here: its own
        # prompt is built with the arbiter's resolution folded in verbatim
        # (below), so the finalizer's stage record already carries and
        # reflects it. The arbiter gets its own release-proposal record only
        # when no finalizer is configured to absorb it.
        $finalizerConfigured = $null -ne (
            Get-Project42OptionalValue -InputObject $brief.roles -Name 'finalizer' -Default $null
        )
        if ($null -ne $arbiterResult -and -not $finalizerConfigured) {
            $stages.Add(
                (
                    New-DeliveryStageRecord -RoleResult $arbiterResult -Brief $brief `
                        -Status (($verdictR -eq 'HUMAN') ? 'human-review' : 'passed') `
                        -ExtraFindings @("Arbiter resolution: $verdictR.")
                )
            )
        }

        # Finalizer runs last, after all other roles. It reviews the complete
        # package for completeness and consistency before human handoff.
        # The finalizer is optional: a brief without a finalizer role skips
        # this step and the proposal goes to a human as-is.
        $finalizerConfig = Get-Project42OptionalValue -InputObject $brief.roles -Name 'finalizer' -Default $null
        $finalizerResult = $null
        if ($null -ne $finalizerConfig) {
            $finalizerPrompt = @(
                "Work item: $($item.id)"
                'Acceptance criteria:'
                (@($acceptanceCriteria | ForEach-Object { "- $_" }) -join "`n")
                ''
                'DRAFT:'
                [string] $draft.content
                ''
                'VERIFIER REPORT:'
                [string] $verify.content
                ''
                'ADVERSARY REPORT:'
                [string] $adversary.content
            )
            if ($null -ne $arbiterResult) {
                $finalizerPrompt += @(
                    ''
                    'ARBITER RESOLUTION:'
                    [string] $arbiterResult.content
                )
            }
            $finalizerUserPrompt = ($finalizerPrompt -join "`n")

            $finalizerResult = Invoke-DeliveryRole -Role finalizer `
                -WorkItemId ([string] $item.id) -WorkItemKey $workItemKey `
                -DeploymentAlias $finalizerConfig.deployment `
                -ProviderFamily $finalizerConfig.providerFamily `
                -SystemPrompt (Get-DeliveryRolePrompt -Name 'finalizer' -CanRetrieveUrls $false) `
                -UserPrompt $finalizerUserPrompt -RateTable $rateTable -AccessToken $accessToken `
                -UntrustedBlocks $untrusted `
                -MaxCompletionTokens ([int](Get-Project42OptionalValue -InputObject $finalizerConfig -Name 'maxCompletionTokens' -Default 4096)) `
                -Temperature (Get-Project42OptionalValue -InputObject $finalizerConfig -Name 'temperature' -Default $null)

            Write-DeliveryLog INFO "brief=$($item.id) finalizer completed"
        }

        if ($null -ne $finalizerResult) {
            $finalizerFindings = @('Finalizer package review.')
            if ($null -ne $arbiterResult) {
                $finalizerFindings += "Arbiter resolution folded in: $verdictR."
            }
            $stages.Add(
                (
                    New-DeliveryStageRecord -RoleResult $finalizerResult -Brief $brief `
                        -Status 'passed' `
                        -ExtraFindings $finalizerFindings
                )
            )
        }

        if ($null -ne $finalizerResult) { $survives = $true }

        $emitted = Write-DeliveryProposal `
            -WorkItem $item `
            -ExecutedStages @($stages) `
            -Survives $survives `
            -UnresolvedConflicts @($unresolved) `
            -UntrustedBlocks $untrusted

        $state.steps.Add([pscustomobject]@{
                role = 'agreement'; brief = $item.id
                verifier = $verdictV; adversary = $verdictA; arbiter = $verdictR
                survives = $survives
            })
        if ($null -ne $emitted) {
            $state.proposals.Add($emitted)
        }

        $completed.Add([pscustomobject][ordered]@{
                workItemId   = [string] $item.id
                workItemKey  = $workItemKey
                verifier     = $verdictV
                adversary    = $verdictA
                arbiter      = $verdictR
                survives     = [bool] $survives
                proposalPath = ($null -eq $emitted) ? $null : [string] $emitted.proposalPath
                packetPath   = ($null -eq $emitted) ? $null : [string] $emitted.packetPath
                completedUtc = [datetime]::UtcNow.ToString('o')
            })
        $null = $completedKeys.Add($workItemKey)
        Save-DeliveryProgress

        # Only now, with the proposal on disk and the completion recorded, is
        # the detector told it may move past this change. Doing it any earlier
        # would mean a crash between the two lost the change entirely, which is
        # the whole failure this two-phase commit exists to prevent.
        Confirm-DeliverySourceChange -WorkItem $item
    }

    # Every work item this run was given is finished, so the resume state has
    # nothing left to say. Keeping it would be actively harmful on the next
    # scheduled hour: it would either reject that run as different work or
    # suppress a work item whose source has moved again. The run record, not
    # the checkpoint, is the durable evidence (ADR-0007 decision 7).
    if (Remove-Project42DeliveryCheckpoint -CheckpointPath $CheckpointPath) {
        Write-DeliveryLog INFO "checkpoint rolled on completion: $CheckpointPath"
    }

    $outcome = 'succeeded'
}
catch {
    $state.aborted = $true
    $state.abortReason = $_.Exception.Message
    Write-DeliveryLog ERROR $_.Exception.Message
    $outcome = 'aborted'
    throw
}
finally {
    Write-RunRecord -Outcome $outcome | Out-Null
    Write-DeliveryLog INFO "outcome=$outcome requests=$($state.requestCount) spend=$([Math]::Round($state.spendUsd,4)) proposals=$($state.proposals.Count)"
}


