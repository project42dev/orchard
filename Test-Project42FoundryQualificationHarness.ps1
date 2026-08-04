#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contentRoot = Join-Path $PSScriptRoot 'delivery'
$modulePath = Join-Path $contentRoot 'Project42FoundryQualification.psm1'
$matrixPath = Join-Path $contentRoot 'candidate-matrix.json'
$benchmarkPath = Join-Path $contentRoot 'benchmark-manifest.json'
$inventoryPath = Join-Path $PSScriptRoot (
    '..\..\hybrid-solutions-cloud\homestead-foundry\' +
    'infra\params\model-catalog.json'
)
Import-Module $modulePath -Force

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
$summary = Test-Project42FoundryQualificationConfiguration `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory
Assert-TestCondition -Condition $summary.valid -Message 'Configuration should pass.'
Assert-TestCondition -Condition ($summary.stageCount -eq 6) -Message 'Stage count drifted.'
Assert-TestCondition -Condition ($summary.caseCount -eq 15) -Message 'Case count drifted.'

$selections = [System.Collections.Generic.List[object]]::new()
$runs = [System.Collections.Generic.List[object]]::new()
$digestA = 'a' * 64
$digestB = 'b' * 64
foreach ($stage in @($matrix.stages)) {
    $candidates = @($stage.candidates)
    $selections.Add([pscustomobject]@{
        stage = [string] $stage.stage
        primaryDeploymentAlias = [string] $candidates[0].deploymentAlias
        fallbackDeploymentAliases = @([string] $candidates[1].deploymentAlias)
    })
    foreach ($candidate in @($candidates[0], $candidates[1])) {
        $caseResults = @(
            $benchmark.cases |
                Where-Object { @($_.appliesTo) -contains $stage.stage } |
                ForEach-Object {
                    [pscustomobject]@{
                        id = [string] $_.id
                        score = 0.99
                        passed = $true
                    }
                }
        )
        $runs.Add([pscustomobject]@{
            stage = [string] $stage.stage
            deploymentAlias = [string] $candidate.deploymentAlias
            providerFamily = [string] $candidate.providerFamily
            modelVersion = [string] $candidate.modelVersion
            evaluatedAt = '2026-07-27T15:00:00.000Z'
            inputDigest = $digestA
            outputDigest = $digestB
            latencyMs = 100
            costUsd = 0.01
            cases = $caseResults
        })
    }
}

$syntheticResults = [pscustomobject]@{
    schemaVersion = '1.0'
    benchmarkId = [string] $benchmark.id
    synthetic = $true
    selection = @($selections)
    runs = @($runs)
}

Assert-TestError `
    -Operation {
        $null = ConvertTo-Project42FoundryRoleProfile `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Results $syntheticResults
    } `
    -Expected 'Synthetic qualification results cannot emit'

$roleProfile = ConvertTo-Project42FoundryRoleProfile `
    -Matrix $matrix `
    -Benchmark $benchmark `
    -Inventory $inventory `
    -Results $syntheticResults `
    -AllowSyntheticTestFixture
Assert-TestCondition `
    -Condition (@($roleProfile.stages).Count -eq 6) `
    -Message 'A passing fixture should produce all six role stages.'
Assert-TestCondition `
    -Condition (
        @($roleProfile.stages.primaryDeploymentAlias | Select-Object -Unique).Count -ge 3
    ) `
    -Message 'A passing fixture should use at least three primary deployments.'

$missingCaseResults = $syntheticResults |
    ConvertTo-Json -Depth 100 |
    ConvertFrom-Json -Depth 100 -DateKind String
$missingCaseResults.runs[0].cases = @($missingCaseResults.runs[0].cases | Select-Object -Skip 1)
Assert-TestError `
    -Operation {
        $null = ConvertTo-Project42FoundryRoleProfile `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Results $missingCaseResults `
            -AllowSyntheticTestFixture
    } `
    -Expected 'does not contain the exact required benchmark cases'

$failedTrapResults = $syntheticResults |
    ConvertTo-Json -Depth 100 |
    ConvertFrom-Json -Depth 100 -DateKind String
$failedTrapResults.runs[0].cases[0].passed = $false
Assert-TestError `
    -Operation {
        $null = ConvertTo-Project42FoundryRoleProfile `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $inventory `
            -Results $failedTrapResults `
            -AllowSyntheticTestFixture
    } `
    -Expected 'failed must-pass case'

$missingInventory = $inventory |
    ConvertTo-Json -Depth 100 |
    ConvertFrom-Json -Depth 100 -DateKind String
$missingInventory.PSObject.Properties.Remove('gpt-5-6-sol')
Assert-TestError `
    -Operation {
        $null = Test-Project42FoundryQualificationConfiguration `
            -Matrix $matrix `
            -Benchmark $benchmark `
            -Inventory $missingInventory
    } `
    -Expected 'absent from the Foundry inventory'

Write-Information (
    'Foundry qualification harness tests passed: configuration, measured-only ' +
    'emission, six-stage profile, missing-case rejection, must-pass rejection, ' +
    'and inventory-drift rejection.'
) -InformationAction Continue
