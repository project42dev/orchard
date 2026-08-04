#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contentRoot = Join-Path $PSScriptRoot 'delivery'
$qualificationModule = Join-Path $contentRoot (
    'Project42FoundryQualification.psm1'
)
$executionModule = Join-Path $contentRoot 'Project42FoundryExecution.psm1'
$matrixPath = Join-Path $contentRoot 'candidate-matrix.json'
$benchmarkPath = Join-Path $contentRoot 'benchmark-manifest.json'
$inventoryPath = Join-Path $PSScriptRoot (
    '..\..\hybrid-solutions-cloud\homestead-foundry\' +
    'infra\params\model-catalog.json'
)
Import-Module $executionModule -Force
Import-Module $qualificationModule -Force

function Assert-TestCondition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool] $Condition,

        [Parameter(Mandatory)]
        [string] $Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-TestError {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock] $Operation,

        [Parameter(Mandatory)]
        [string] $Expected
    )

    try {
        & $Operation
    }
    catch {
        Assert-TestCondition `
            -Condition ($_.Exception.Message -match $Expected) `
            -Message (
                "Expected error matching '$Expected' but received: " +
                $_.Exception.Message
            )
        return
    }
    throw "Expected an error matching '$Expected'."
}

$matrix = Read-Project42Json -Path $matrixPath
$benchmark = Read-Project42Json -Path $benchmarkPath
$inventory = Read-Project42Json -Path $inventoryPath
$aliases = @(
    @($matrix.stages.candidates.deploymentAlias) +
    @($matrix.execution.judgePool.deploymentAlias) |
        Sort-Object -Unique
)
$pricing = [pscustomobject]@{
    schemaVersion = '1.0'
    currency = 'USD'
    asOf = [DateTimeOffset]::UtcNow.ToString('o')
    rates = @(
        $aliases |
            ForEach-Object {
                [pscustomobject]@{
                    deploymentAlias = [string] $_
                    inputUsdPerMillionTokens = 0.0
                    outputUsdPerMillionTokens = 0.0
                    source = 'https://example.invalid/measured-pricing-fixture'
                }
            }
    )
}

$plan = New-Project42FoundryExecutionPlan `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory `
    -Pricing $pricing
Assert-TestCondition `
    -Condition ($plan.itemCount -eq 87) `
    -Message 'The full execution plan must contain 87 candidate cases.'
Assert-TestCondition `
    -Condition ($plan.requestCount -eq 261) `
    -Message 'The full execution plan must contain 261 bounded requests.'
$smokePlan = New-Project42FoundryExecutionPlan `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory `
    -Pricing $pricing `
    -Stage 'evidence-research' `
    -DeploymentAlias 'gpt-5-6-sol' `
    -CaseId 'primary-source-provenance'
Assert-TestCondition `
    -Condition (
        $smokePlan.itemCount -eq 1 -and
        $smokePlan.requestCount -eq 3
    ) `
    -Message 'A filtered smoke plan must contain one case and three requests.'
foreach ($item in @($plan.items)) {
    $candidateProvider = (
        [string] $item.providerFamily -replace '[^a-zA-Z0-9]', ''
    ).ToLowerInvariant()
    $judgeProviders = @(
        $item.judges |
            ForEach-Object {
                (
                    [string] $_.providerFamily -replace '[^a-zA-Z0-9]', ''
                ).ToLowerInvariant()
            }
    )
    Assert-TestCondition `
        -Condition ($judgeProviders -notcontains $candidateProvider) `
        -Message 'A candidate cannot judge its own provider family.'
    Assert-TestCondition `
        -Condition (
            @($judgeProviders | Select-Object -Unique).Count -eq
            $judgeProviders.Count
        ) `
        -Message 'The two judges must come from independent providers.'
}

$candidateJson = (
    '{"caseId":"case-1","decision":"block","findings":["unsupported"],' +
    '"humanApprovalRequired":true}'
)
$null = ConvertFrom-Project42ExactJson `
    -Value $candidateJson `
    -Contract candidate `
    -CaseId 'case-1'
Assert-TestError `
    -Operation {
        $null = ConvertFrom-Project42ExactJson `
            -Value ($candidateJson.TrimEnd('}') + ',"extra":"no"}') `
            -Contract candidate `
            -CaseId 'case-1'
    } `
    -Expected 'exact contract'
Assert-TestError `
    -Operation {
        $null = ConvertFrom-Project42ExactJson `
            -Value $candidateJson.Replace('true', 'false') `
            -Contract candidate `
            -CaseId 'case-1'
    } `
    -Expected 'removed human approval'
Assert-TestError `
    -Operation {
        $null = ConvertFrom-Project42ExactJson `
            -Value ('```json' + "`n" + $candidateJson + "`n" + '```') `
            -Contract candidate `
            -CaseId 'case-1'
    } `
    -Expected 'unwrapped JSON'
Assert-TestError `
    -Operation {
        $null = ConvertFrom-Project42ExactJson `
            -Value 'not-json' `
            -Contract judge `
            -CaseId 'case-1'
    } `
    -Expected 'not one unwrapped JSON'

$missingRatePricing = $pricing |
    ConvertTo-Json -Depth 20 |
    ConvertFrom-Json -Depth 20 -DateKind String
$missingRatePricing.rates = @($missingRatePricing.rates | Select-Object -Skip 1)
Assert-TestError `
    -Operation {
        $null = New-Project42FoundryExecutionPlan `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Pricing $missingRatePricing
    } `
    -Expected 'pricing is missing deployment'

$stalePricing = $pricing |
    ConvertTo-Json -Depth 20 |
    ConvertFrom-Json -Depth 20 -DateKind String
$stalePricing.asOf = [DateTimeOffset]::UtcNow.AddDays(-32).ToString('o')
Assert-TestError `
    -Operation {
        $null = New-Project42FoundryExecutionPlan `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Pricing $stalePricing
    } `
    -Expected 'older than 31 days'

$boundedMatrix = $matrix |
    ConvertTo-Json -Depth 100 |
    ConvertFrom-Json -Depth 100 -DateKind String
$boundedMatrix.execution.maximumRequests = 260
Assert-TestError `
    -Operation {
        $null = New-Project42FoundryExecutionPlan `
            -Matrix $boundedMatrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Pricing $pricing
    } `
    -Expected 'exceeds the 260 request ceiling'

$oneItemPlan = [pscustomobject][ordered]@{
    schemaVersion = $plan.schemaVersion
    matrixId = $plan.matrixId
    benchmarkId = $plan.benchmarkId
    itemCount = 1
    requestCount = 3
    minimumJudgeScore = $plan.minimumJudgeScore
    maximumCompletionTokens = $plan.maximumCompletionTokens
    minimumDeploymentIntervalSeconds = 0
    requestTimeoutSeconds = $plan.requestTimeoutSeconds
    maximumRetries = $plan.maximumRetries
    maximumRequests = $plan.maximumRequests
    maximumEstimatedCostUsd = $plan.maximumEstimatedCostUsd
    items = @($plan.items[0])
    rates = $plan.rates
}
$transportCalls = 0
$mockTransport = {
    param($Endpoint, $DeploymentAlias, $RequestBody)
    $null = $Endpoint
    $null = $DeploymentAlias
    $script:transportCalls += 1
    $tokenLimitProperties = @(
        $RequestBody.PSObject.Properties |
            Where-Object {
                $_.Name -in @('max_tokens', 'max_completion_tokens')
            }
    )
    Assert-TestCondition `
        -Condition (
            $tokenLimitProperties.Count -eq 1 -and
            [int] $tokenLimitProperties[0].Value -eq 500
        ) `
        -Message 'Every request requires exactly one completion-token ceiling.'
    $system = [string] $RequestBody.messages[0].content
    $user = [string] $RequestBody.messages[1].content |
        ConvertFrom-Json -Depth 20 -DateKind String
    if ($system -match 'independent Project 42 qualification judge') {
        $content = [pscustomobject][ordered]@{
            caseId = [string] $user.caseId
            score = 0.99
            passed = $true
            reason = 'All rubric criteria are satisfied by the fixture response.'
        } | ConvertTo-Json -Compress
    }
    else {
        $content = [pscustomobject][ordered]@{
            caseId = [string] $user.caseId
            decision = 'block'
            findings = @('The unsupported claim requires human review.')
            humanApprovalRequired = $true
        } | ConvertTo-Json -Compress
    }
    return [pscustomobject]@{
        content = $content
        promptTokens = 100
        completionTokens = 25
        latencyMs = 5
    }
}

$artifactRoot = Join-Path (
    Join-Path (Split-Path -Parent $PSScriptRoot) '.artifacts'
) ('qualification-execution-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $artifactRoot -Force
try {
    $checkpointPath = Join-Path $artifactRoot 'checkpoint.json'
    $checkpoint = Invoke-Project42FoundryQualificationExecution `
        -Plan $oneItemPlan `
        -Endpoint 'https://qualification-test.services.ai.azure.com' `
        -AccessToken 'synthetic-test-token' `
        -CheckpointPath $checkpointPath `
        -Transport $mockTransport
    Assert-TestCondition `
        -Condition (
            $checkpoint.requestCount -eq 3 -and
            @($checkpoint.completed).Count -eq 1 -and
            $checkpoint.completed[0].passed
        ) `
        -Message 'A passing mocked item must checkpoint three requests.'
    Assert-TestCondition `
        -Condition ($transportCalls -eq 3) `
        -Message 'The first mocked execution must make exactly three calls.'

    $checkpoint = Invoke-Project42FoundryQualificationExecution `
        -Plan $oneItemPlan `
        -Endpoint 'https://qualification-test.services.ai.azure.com' `
        -AccessToken 'synthetic-test-token' `
        -CheckpointPath $checkpointPath `
        -Transport $mockTransport
    Assert-TestCondition `
        -Condition (
            $checkpoint.requestCount -eq 3 -and
            $transportCalls -eq 3
        ) `
        -Message 'Resume must not repeat a completed candidate case.'

    $measured = ConvertTo-Project42FoundryMeasuredResultSet `
        -Plan $oneItemPlan `
        -Checkpoint $checkpoint `
        -Selection @(
            [pscustomobject]@{
                stage = [string] $oneItemPlan.items[0].stage
                primaryDeploymentAlias = (
                    [string] $oneItemPlan.items[0].deploymentAlias
                )
                fallbackDeploymentAliases = @('test-fallback')
            }
        )
    Assert-TestCondition `
        -Condition (
            -not $measured.synthetic -and
            @($measured.runs).Count -eq 1 -and
            @($measured.runs[0].cases).Count -eq 1
        ) `
        -Message 'Completed checkpoints must aggregate into measured run evidence.'

    $incompleteCheckpoint = $checkpoint |
        ConvertTo-Json -Depth 50 |
        ConvertFrom-Json -Depth 50 -DateKind String
    $incompleteCheckpoint.completed = @()
    Assert-TestError `
        -Operation {
            $null = ConvertTo-Project42FoundryMeasuredResultSet `
                -Plan $oneItemPlan `
                -Checkpoint $incompleteCheckpoint `
                -Selection @(
                    [pscustomobject]@{
                        stage = [string] $oneItemPlan.items[0].stage
                        primaryDeploymentAlias = (
                            [string] $oneItemPlan.items[0].deploymentAlias
                        )
                        fallbackDeploymentAliases = @('test-fallback')
                    }
                )
        } `
        -Expected 'checkpoint is incomplete'

    $lowScoreTransport = {
        param($Endpoint, $DeploymentAlias, $RequestBody)
        $null = $Endpoint
        $null = $DeploymentAlias
        $system = [string] $RequestBody.messages[0].content
        $user = [string] $RequestBody.messages[1].content |
            ConvertFrom-Json -Depth 20 -DateKind String
        if ($system -match 'independent Project 42 qualification judge') {
            $content = [pscustomobject][ordered]@{
                caseId = [string] $user.caseId
                score = 0.89
                passed = $true
                reason = 'Plausible, but below the configured role threshold.'
            } | ConvertTo-Json -Compress
        }
        else {
            $content = [pscustomobject][ordered]@{
                caseId = [string] $user.caseId
                decision = 'revise'
                findings = @('The response requires revision and human review.')
                humanApprovalRequired = $true
            } | ConvertTo-Json -Compress
        }
        return [pscustomobject]@{
            content = $content
            promptTokens = 100
            completionTokens = 25
            latencyMs = 5
        }
    }
    $thresholdCheckpoint = Join-Path $artifactRoot 'threshold.json'
    $belowThreshold = Invoke-Project42FoundryQualificationExecution `
        -Plan $oneItemPlan `
        -Endpoint 'https://qualification-test.services.ai.azure.com' `
        -AccessToken 'synthetic-test-token' `
        -CheckpointPath $thresholdCheckpoint `
        -Transport $lowScoreTransport
    Assert-TestCondition `
        -Condition (-not $belowThreshold.completed[0].passed) `
        -Message 'Role-specific thresholds must override the lower judge floor.'

    $invalidCandidateTransport = {
        param($Endpoint, $DeploymentAlias, $RequestBody)
        $null = $Endpoint
        $null = $DeploymentAlias
        $system = [string] $RequestBody.messages[0].content
        $user = [string] $RequestBody.messages[1].content |
            ConvertFrom-Json -Depth 20 -DateKind String
        if ($system -match 'independent Project 42 qualification judge') {
            $content = [pscustomobject][ordered]@{
                caseId = [string] $user.caseId
                score = 0.0
                passed = $false
                reason = 'The candidate violated the exact output contract.'
            } | ConvertTo-Json -Compress
        }
        else {
            $content = 'I cannot follow the required JSON contract.'
        }
        return [pscustomobject]@{
            content = $content
            promptTokens = 100
            completionTokens = 25
            latencyMs = 5
        }
    }
    $invalidCheckpoint = Join-Path $artifactRoot 'invalid-contract.json'
    $invalidResult = Invoke-Project42FoundryQualificationExecution `
        -Plan $oneItemPlan `
        -Endpoint 'https://qualification-test.services.ai.azure.com' `
        -AccessToken 'synthetic-test-token' `
        -CheckpointPath $invalidCheckpoint `
        -Transport $invalidCandidateTransport
    Assert-TestCondition `
        -Condition (
            -not $invalidResult.completed[0].passed -and
            -not $invalidResult.completed[0].candidateContractValid -and
            $invalidResult.completed[0].decision -eq 'invalid'
        ) `
        -Message 'Malformed model output must checkpoint as a failed case.'

    $rejectedRequestTransport = {
        param($Endpoint, $DeploymentAlias, $RequestBody)
        $null = $Endpoint
        $null = $DeploymentAlias
        $system = [string] $RequestBody.messages[0].content
        $user = [string] $RequestBody.messages[1].content |
            ConvertFrom-Json -Depth 20 -DateKind String
        if ($system -notmatch 'independent Project 42 qualification judge') {
            throw "Foundry request for $DeploymentAlias failed with HTTP 400."
        }
        return [pscustomobject]@{
            content = (
                [pscustomobject][ordered]@{
                    caseId = [string] $user.caseId
                    score = 0.0
                    passed = $false
                    reason = 'The candidate request was rejected by the service.'
                } | ConvertTo-Json -Compress
            )
            promptTokens = 100
            completionTokens = 25
            latencyMs = 5
        }
    }
    $rejectedCheckpoint = Join-Path $artifactRoot 'request-rejected.json'
    $rejectedResult = Invoke-Project42FoundryQualificationExecution `
        -Plan $oneItemPlan `
        -Endpoint 'https://qualification-test.services.ai.azure.com' `
        -AccessToken 'synthetic-test-token' `
        -CheckpointPath $rejectedCheckpoint `
        -Transport $rejectedRequestTransport
    Assert-TestCondition `
        -Condition (
            -not $rejectedResult.completed[0].passed -and
            -not $rejectedResult.completed[0].candidateRequestSucceeded -and
            $rejectedResult.completed[0].decision -eq 'invalid'
        ) `
        -Message 'A 400/422 model rejection must checkpoint as a failed case.'

    $costCheckpoint = Join-Path $artifactRoot 'cost-ceiling.json'
    $oneItemPlan.maximumEstimatedCostUsd = 0.0
    foreach ($rate in $oneItemPlan.rates.Values) {
        $rate.inputUsdPerMillionTokens = 1.0
        $rate.outputUsdPerMillionTokens = 1.0
    }
    Assert-TestError `
        -Operation {
            $null = Invoke-Project42FoundryQualificationExecution `
                -Plan $oneItemPlan `
                -Endpoint 'https://qualification-test.services.ai.azure.com' `
                -AccessToken 'synthetic-test-token' `
                -CheckpointPath $costCheckpoint `
                -Transport $mockTransport
        } `
        -Expected 'estimated-cost ceiling'
}
finally {
    $resolvedArtifactRoot = [IO.Path]::GetFullPath($artifactRoot)
    $resolvedExpectedRoot = [IO.Path]::GetFullPath(
        (Join-Path (Split-Path -Parent $PSScriptRoot) '.artifacts')
    ).TrimEnd([IO.Path]::DirectorySeparatorChar) +
        [IO.Path]::DirectorySeparatorChar
    if ($resolvedArtifactRoot.StartsWith(
        $resolvedExpectedRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedArtifactRoot -Recurse -Force
    }
}

Write-Information (
    'Foundry execution harness tests passed: 261-request planning, ' +
    'cross-provider judging, exact contracts, human publication gate, pricing ' +
    'freshness, request and cost ceilings, malformed-output rejection, and ' +
    'checkpoint resume. No live model endpoint was called.'
) -InformationAction Continue
