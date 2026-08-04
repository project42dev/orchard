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
            ($env:MODEL_CATALOG_PATH ?? ('..\..\hybrid-solutions-cloud\homestead-foundry\' + 'infra\params\model-catalog.json'))
        )
    ),

    [Parameter()]
    [string] $ResultsPath,

    [Parameter()]
    [string] $OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$modulePath = Join-Path (
    Join-Path $PSScriptRoot 'delivery'
) 'Project42FoundryQualification.psm1'
Import-Module $modulePath -Force

$matrix = Read-Project42Json -Path $MatrixPath
$benchmark = Read-Project42Json -Path $BenchmarkPath
$inventory = Read-Project42Json -Path $InventoryPath
$configuration = Test-Project42FoundryQualificationConfiguration `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory

if (-not $ResultsPath) {
    Write-Information (
        'Foundry candidate inventory and held-out benchmark are valid: ' +
        "$($configuration.stageCount) stages, $($configuration.caseCount) cases, " +
        "$($configuration.providerFamilyCount) provider families, and " +
        "$($configuration.inventoryAliasCount) deployed aliases. No qualified " +
        'role profile was emitted because measured results were not supplied.'
    ) -InformationAction Continue
    return
}

if (-not $OutputPath) {
    throw 'OutputPath is required when ResultsPath is supplied.'
}

$results = Read-Project42Json -Path $ResultsPath
$roleProfile = ConvertTo-Project42FoundryRoleProfile `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory `
    -Results $results

$resolvedOutputDirectory = Split-Path -Parent $OutputPath
if (-not $resolvedOutputDirectory) {
    throw 'OutputPath must include a directory.'
}
if (-not (Test-Path -LiteralPath $resolvedOutputDirectory -PathType Container)) {
    throw "Output directory does not exist: $resolvedOutputDirectory"
}

$roleProfile |
    ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
Write-Information (
    'Qualified role profile emitted after all measured thresholds, fallbacks, ' +
    'inventory checks, and provider-independence rules passed.'
) -InformationAction Continue
