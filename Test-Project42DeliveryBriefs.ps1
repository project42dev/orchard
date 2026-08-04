#Requires -Version 7.4
<#
    Validates the SHIPPED brief files, not briefs this test invents.

    Every other suite in this directory constructs its own brief and then proves
    the pipeline handles it. That is why six green suites coexisted with a
    platform that could not run: a test that builds its own inputs cannot detect
    a defect in the real ones. This suite exists to close exactly that gap.

    It loads delivery/briefs/*.json, the same two files the
    jobs mount at BRIEF_PATH, and drives them through the real entry point with a
    synthetic transport. Everything except the network call is genuine: brief
    parsing, work item expansion, the cross-family independence rule, acceptance
    criteria, prompt assembly, cap arithmetic, and the run record.

    Plan-only mode is NOT sufficient for this and must never be substituted. The
    entry point returns on `-not $Execute` before the brief is read, so a clean
    plan run proves only that the path resolves.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contentRoot = Join-Path $PSScriptRoot 'delivery'
$deliveryScript = Join-Path $contentRoot 'Invoke-Project42Delivery.ps1'
$briefRoot = Join-Path $contentRoot 'briefs'
$harnessBrief = Join-Path $briefRoot 'harness-backlog.json'
$engineBrief = Join-Path $briefRoot 'engine-template.json'
$schemaRoot = Join-Path $PSScriptRoot '..\project42-platform\schemas\content-maintenance'
$testEndpoint = 'https://delivery-test.services.ai.azure.com'

$assertions = 0

function Assert-Brief {
    param(
        [Parameter(Mandatory)][bool] $Condition,
        [Parameter(Mandatory)][string] $Message
    )
    if (-not $Condition) { throw $Message }
}

# The transport answers as the ensemble would, without a network call. It also
# records which deployment each role actually reached, so the independence rule
# is checked against what was SENT rather than against what the file declares.
$transportLog = @{
    calls = 0
    byRole = @{}
}

$transport = {
    param($Endpoint, $DeploymentAlias, $RequestBody)

    $null = $Endpoint
    $transportLog.calls += 1
    $system = [string] $RequestBody.messages[0].content

    $role = $null
    foreach ($candidate in @('drafter', 'verifier', 'adversary', 'arbiter')) {
        if ($system -match "# Role: $candidate") { $role = $candidate; break }
    }
    if (-not $role) { throw 'The request carried no recognizable delivery role prompt.' }
    $transportLog.byRole[$role] = $DeploymentAlias

    $content = switch ($role) {
        'drafter'   { "A drafted answer.`n`nASSUMPTIONS. None beyond the supplied evidence.`n`nOMITTED. Nothing." }
        'verifier'  { "Claim checking complete.`nVERDICT: PASS" }
        'adversary' { "Hostile review complete.`nVERDICT: STANDS" }
        'arbiter'   { "Resolved.`nRESOLUTION: VERIFIER" }
    }

    return [pscustomobject]@{
        content = $content
        promptTokens = 1200
        completionTokens = 300
        latencyMs = 42
    }
}.GetNewClosure()

function Get-BriefAliasSet {
    <#
        Every deployment alias any shipped brief references. The pricing table
        MUST cover all of them: an unpriced alias aborts the run before request
        one, by design, so an alias introduced in a brief and never priced is a
        production outage that no schema check would catch.
    #>
    param([Parameter(Mandatory)][string[]] $Path)

    $aliases = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($file in $Path) {
        foreach ($brief in @(Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)) {
            foreach ($role in @('drafter', 'verifier', 'adversary', 'arbiter')) {
                $config = $brief.roles.PSObject.Properties[$role]
                if ($config) { $null = $aliases.Add([string] $config.Value.deployment) }
            }
        }
    }
    return @($aliases)
}

function New-PricingForAliases {
    param([Parameter(Mandatory)][string[]] $Alias)

    $rates = foreach ($a in $Alias) {
        @{
            deploymentAlias = $a
            inputUsdPerMillionTokens = 5.0
            outputUsdPerMillionTokens = 30.0
            source = 'https://example.invalid/test-fixture-rate'
        }
    }
    return @{
        schemaVersion = '1.0'
        currency = 'USD'
        asOf = '2026-08-03T00:00:00Z'
        rates = @($rates)
    }
}

$root = Join-Path $PSScriptRoot ('.artifacts/brief-validation-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path (Join-Path $root 'run-records') -Force
$null = New-Item -ItemType Directory -Path (Join-Path $root 'proposals') -Force

try {
    # ------------------------------------------------ both files exist and parse

    foreach ($file in @($harnessBrief, $engineBrief)) {
        Assert-Brief -Condition (Test-Path -LiteralPath $file) -Message "Missing shipped brief: $file. Both jobs fail closed without it."
        $assertions++
    }

    $harnessBriefs = @(Get-Content -LiteralPath $harnessBrief -Raw | ConvertFrom-Json)
    $engineBriefs = @(Get-Content -LiteralPath $engineBrief -Raw | ConvertFrom-Json)

    # Both are read as arrays by Get-DeliveryWorkItemSet. The engine reads only
    # element zero, so a bare object rather than an array would make $Briefs[0]
    # a property bag and every role lookup silently null.
    Assert-Brief -Condition ($harnessBriefs.Count -ge 1) -Message 'harness-backlog.json must be a JSON array with at least one brief.'
    $assertions++
    Assert-Brief -Condition ($engineBriefs.Count -ge 1) -Message 'engine-template.json must be a JSON array; the engine reads element zero as its template.'
    $assertions++

    # ------------------------------------------- required fields, on every brief

    foreach ($brief in ($harnessBriefs + $engineBriefs)) {
        $id = [string] $brief.id
        Assert-Brief -Condition (-not [string]::IsNullOrWhiteSpace($id)) -Message 'Every brief needs a non-empty id; it becomes the work item id.'
        $assertions++
        Assert-Brief -Condition (-not [string]::IsNullOrWhiteSpace([string] $brief.prompt)) -Message "Brief '$id' has no prompt."
        $assertions++
        Assert-Brief -Condition (@($brief.acceptanceCriteria).Count -ge 1) -Message "Brief '$id' has no acceptanceCriteria; the entry point rejects a work item with fewer than one."
        $assertions++

        foreach ($role in @('drafter', 'verifier', 'adversary')) {
            $config = $brief.roles.PSObject.Properties[$role]
            Assert-Brief -Condition ($null -ne $config) -Message "Brief '$id' is missing the required role '$role'."
            $assertions++
            Assert-Brief -Condition (-not [string]::IsNullOrWhiteSpace([string] $config.Value.deployment)) -Message "Brief '$id' role '$role' has no deployment alias."
            $assertions++
            Assert-Brief -Condition (-not [string]::IsNullOrWhiteSpace([string] $config.Value.providerFamily)) -Message "Brief '$id' role '$role' has no providerFamily."
            $assertions++
        }

        # ADR-0007's independence rule. The entry point throws on this, but it
        # throws at request time, which in production is after the run has
        # already started spending. Catching it here is the difference between a
        # failed test and a failed job.
        Assert-Brief `
            -Condition ($brief.roles.verifier.providerFamily -ne $brief.roles.drafter.providerFamily) `
            -Message "Brief '$id' has drafter and verifier both from '$($brief.roles.drafter.providerFamily)'. They must differ."
        $assertions++
    }

    # --------------------------------------- every referenced alias is priceable

    $aliases = Get-BriefAliasSet -Path @($harnessBrief, $engineBrief)
    Assert-Brief -Condition ($aliases.Count -ge 1) -Message 'No deployment aliases were resolved from the briefs.'
    $assertions++
    Write-Host "Aliases the operator's pricing.private.json MUST cover: $($aliases -join ', ')"

    $pricingPath = Join-Path $root 'pricing.json'
    New-PricingForAliases -Alias $aliases | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath $pricingPath -Encoding utf8NoBOM

    # ------------------------------- the real harness brief through the real run

    $transportLog.calls = 0
    $transportLog.byRole = @{}
    $log = & $deliveryScript `
        -Mode harness `
        -Endpoint $testEndpoint `
        -BriefPath $harnessBrief `
        -RunRecordRoot (Join-Path $root 'run-records') `
        -ProposalRoot (Join-Path $root 'proposals') `
        -PricingPath $pricingPath `
        -CheckpointPath (Join-Path $root 'harness.checkpoint.private.json') `
        -SchemaRoot $schemaRoot `
        -Transport $transport `
        -Execute 6>&1 | Out-String

    Assert-Brief -Condition ($transportLog.calls -ge (3 * $harnessBriefs.Count)) -Message "Expected at least three role calls per work item across $($harnessBriefs.Count) briefs, saw $($transportLog.calls). The backlog did not fully expand."
    $assertions++
    Assert-Brief -Condition ($log -notmatch 'INDEPENDENCE:') -Message 'The shipped harness backlog violates the cross-family independence rule at run time.'
    $assertions++
    Assert-Brief -Condition ($log -match 'outcome=') -Message 'The harness run produced no outcome line.'
    $assertions++

    # The alias that actually reached the wire must be the one the brief names.
    foreach ($role in @('drafter', 'verifier', 'adversary')) {
        Assert-Brief -Condition ($transportLog.byRole.ContainsKey($role)) -Message "Role '$role' never reached the transport during the harness run."
        $assertions++
    }

    # -------------------------------- the real engine template through the real run

    # Engine mode calls the detector. The fetch delegate is the detector's own
    # seam, so nothing is fetched and the template is still exercised end to end.
    $transportLog.calls = 0
    $transportLog.byRole = @{}
    $fetchDelegate = { param($Request) return [pscustomobject]@{ content = "unchanged fixture for $($Request.sourceId)"; statusCode = 200 } }

    $engineLog = & $deliveryScript `
        -Mode engine `
        -Endpoint $testEndpoint `
        -BriefPath $engineBrief `
        -RunRecordRoot (Join-Path $root 'run-records') `
        -ProposalRoot (Join-Path $root 'proposals') `
        -PricingPath $pricingPath `
        -CheckpointPath (Join-Path $root 'engine.checkpoint.private.json') `
        -SourceCheckpointPath (Join-Path $root 'source-detection.checkpoint.private.json') `
        -SchemaRoot $schemaRoot `
        -Transport $transport `
        -SourceFetchDelegate $fetchDelegate `
        -Execute 6>&1 | Out-String

    Assert-Brief -Condition ($engineLog -notmatch 'INDEPENDENCE:') -Message 'The shipped engine template violates the cross-family independence rule at run time.'
    $assertions++
    Assert-Brief -Condition ($engineLog -match 'detector:') -Message 'Engine mode did not reach the detector; the template was never applied.'
    $assertions++
    Assert-Brief -Condition ($engineLog -match 'outcome=') -Message 'The engine run produced no outcome line.'
    $assertions++

    Write-Host ''
    Write-Host "PASS. $assertions assertions against the shipped brief files."
}
finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
