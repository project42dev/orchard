#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter()]
    [string] $MatrixPath = (
        Join-Path $PSScriptRoot 'delivery\candidate-matrix.json'
    ),

    [Parameter()]
    [string] $BenchmarkPath = (
        Join-Path $PSScriptRoot 'delivery\benchmark-manifest.json'
    ),

    [Parameter()]
    [string] $InventoryPath = (
        Join-Path $PSScriptRoot (
            '..\..\hybrid-solutions-cloud\homestead-foundry\' +
            'infra\params\model-catalog.json'
        )
    ),

    [Parameter()]
    [string] $PricingPath = (
        Join-Path $PSScriptRoot (
            'delivery\private\pricing.private.json'
        )
    ),

    [Parameter()]
    [string[]] $Stage,

    [Parameter()]
    [string[]] $DeploymentAlias,

    [Parameter()]
    [string[]] $CaseId,

    [Parameter()]
    [uri] $Endpoint,

    [Parameter()]
    [string] $TenantId,

    [Parameter()]
    [string] $CheckpointPath = (
        Join-Path $PSScriptRoot (
            'delivery\private\' +
            'qualification.checkpoint.private.json'
        )
    ),

    [Parameter()]
    [string] $SelectionPath,

    [Parameter()]
    [string] $ResultsPath,

    [Parameter()]
    [string] $RoleProfilePath,

    [Parameter()]
    [switch] $Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contentRoot = Join-Path $PSScriptRoot 'delivery'
$qualificationModule = Join-Path $contentRoot (
    'Project42FoundryQualification.psm1'
)
$executionModule = Join-Path $contentRoot 'Project42FoundryExecution.psm1'
Import-Module $executionModule -Force
Import-Module $qualificationModule -Force

foreach ($requiredPath in @(
    $MatrixPath,
    $BenchmarkPath,
    $InventoryPath,
    $PricingPath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required qualification input does not exist: $requiredPath"
    }
}

$matrix = Read-Project42Json -Path $MatrixPath
$benchmark = Read-Project42Json -Path $BenchmarkPath
$inventory = Read-Project42Json -Path $InventoryPath
$pricing = Read-Project42Json -Path $PricingPath
$planArguments = @{
    Matrix = $matrix
    Benchmark = $benchmark
    Inventory = $inventory
    Pricing = $pricing
}
if ($Stage) {
    $planArguments.Stage = $Stage
}
if ($DeploymentAlias) {
    $planArguments.DeploymentAlias = $DeploymentAlias
}
if ($CaseId) {
    $planArguments.CaseId = $CaseId
}
$plan = New-Project42FoundryExecutionPlan @planArguments

Write-Information (
    'Foundry qualification plan is valid: ' +
    "$($plan.itemCount) candidate cases and $($plan.requestCount) bounded " +
    "requests; maximum estimated cost USD $($plan.maximumEstimatedCostUsd)."
) -InformationAction Continue

if (-not $Execute) {
    Write-Information (
        'Plan-only mode completed. No model endpoint was called and no ' +
        'qualification result was emitted.'
    ) -InformationAction Continue
    return
}

if (-not $Endpoint) {
    throw 'Endpoint is required with -Execute.'
}
if ([string]::IsNullOrWhiteSpace($TenantId)) {
    throw 'TenantId is required with -Execute so authentication is tenant-bound.'
}

$privateRoot = [IO.Path]::GetFullPath(
    (Join-Path $contentRoot 'private')
).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$resolvedCheckpoint = [IO.Path]::GetFullPath($CheckpointPath)
if (-not $resolvedCheckpoint.StartsWith(
    $privateRoot,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw 'CheckpointPath must be inside delivery/private.'
}
if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $privateRoot
}

$accessToken = [string] $env:PROJECT42_FOUNDRY_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($accessToken)) {
    $accessToken = [string] (
        & az account get-access-token `
            --tenant $TenantId `
            --scope 'https://ai.azure.com/.default' `
            --query accessToken `
            --output tsv
    )
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) {
        throw (
            'Unable to obtain a tenant-bound Foundry token. Authenticate Azure ' +
            'CLI to the required tenant or set PROJECT42_FOUNDRY_ACCESS_TOKEN.'
        )
    }
}

try {
    $checkpoint = Invoke-Project42FoundryQualificationExecution `
        -Plan $plan `
        -Endpoint $Endpoint `
        -AccessToken $accessToken `
        -CheckpointPath $resolvedCheckpoint
}
finally {
    $accessToken = $null
}

$passed = @($checkpoint.completed | Where-Object { $_.passed }).Count
$failed = @($checkpoint.completed | Where-Object { -not $_.passed }).Count
Write-Information (
    'Foundry qualification execution checkpointed privately: ' +
    "$passed passed, $failed failed, $($checkpoint.requestCount) requests, " +
    "estimated cost USD $($checkpoint.estimatedCostUsd). Human review remains " +
    'required; this command does not publish content or emit a role profile.'
) -InformationAction Continue

$outputArguments = @($SelectionPath, $ResultsPath, $RoleProfilePath)
if (@($outputArguments | Where-Object { $_ }).Count -eq 0) {
    return
}
if (@($outputArguments | Where-Object { $_ }).Count -ne 3) {
    throw (
        'SelectionPath, ResultsPath, and RoleProfilePath must be supplied together.'
    )
}
if ($Stage -or $DeploymentAlias -or $CaseId) {
    throw 'A filtered execution cannot emit a complete qualified role profile.'
}
if (-not (Test-Path -LiteralPath $SelectionPath -PathType Leaf)) {
    throw "Selection input does not exist: $SelectionPath"
}
foreach ($privateOutput in @($ResultsPath, $RoleProfilePath)) {
    $resolvedPrivateOutput = [IO.Path]::GetFullPath($privateOutput)
    if (-not $resolvedPrivateOutput.StartsWith(
        $privateRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw (
            'Measured results and role profiles must remain inside ' +
            'delivery/private.'
        )
    }
}

$selectionDocument = Read-Project42Json -Path $SelectionPath
$measuredResults = ConvertTo-Project42FoundryMeasuredResultSet `
    -Plan $plan `
    -Checkpoint $checkpoint `
    -Selection @($selectionDocument.selection)
$roleProfile = ConvertTo-Project42FoundryRoleProfile `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory `
    -Results $measuredResults
$measuredResults |
    ConvertTo-Json -Depth 50 |
    Set-Content -LiteralPath $ResultsPath -Encoding utf8NoBOM
$roleProfile |
    ConvertTo-Json -Depth 50 |
    Set-Content -LiteralPath $RoleProfilePath -Encoding utf8NoBOM
Write-Information (
    'Measured results and the validated role profile were emitted privately. ' +
    'They remain evidence for human review and do not authorize publication.'
) -InformationAction Continue
