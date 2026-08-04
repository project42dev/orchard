#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Project42MaintenanceStages = @(
    'evidence-research',
    'curriculum-writing',
    'factual-verification',
    'assessment-review',
    'accessibility-review',
    'release-proposal'
)

function Read-Project42Json {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "JSON file not found: $Path"
    }

    try {
        return Get-Content -LiteralPath $Path -Raw |
            ConvertFrom-Json -Depth 100 -DateKind String
    }
    catch {
        throw "JSON file is invalid: $Path"
    }
}

function Assert-Project42Condition {
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

function Get-Project42NormalizedProvider {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Value
    )

    return ($Value.ToLowerInvariant() -replace '[^a-z0-9]', '')
}

function Assert-Project42Timestamp {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Value,

        [Parameter(Mandatory)]
        [string] $Label
    )

    $pattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$'
    $parsed = [DateTimeOffset]::MinValue
    Assert-Project42Condition `
        -Condition (
            $Value -match $pattern -and
            [DateTimeOffset]::TryParse($Value, [ref] $parsed)
        ) `
        -Message "$Label must be an ISO 8601 UTC timestamp."
}

function Assert-Project42Digest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Value,

        [Parameter(Mandatory)]
        [string] $Label
    )

    Assert-Project42Condition `
        -Condition ($Value -match '^[a-f0-9]{64}$') `
        -Message "$Label must be a lowercase SHA-256 digest."
}

function Get-Project42Inventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject] $InventoryDocument
    )

    $inventory = @{}
    foreach ($property in $InventoryDocument.PSObject.Properties) {
        $inventory[$property.Name] = $property.Value
    }
    Assert-Project42Condition `
        -Condition ($inventory.Count -gt 0) `
        -Message 'The Foundry model inventory is empty.'
    return $inventory
}

function Test-Project42FoundryQualificationConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject] $Matrix,

        [Parameter(Mandatory)]
        [psobject] $Benchmark,

        [Parameter(Mandatory)]
        [psobject] $Inventory
    )

    Assert-Project42Condition `
        -Condition ($Matrix.schemaVersion -eq '1.1') `
        -Message 'The candidate matrix schema version is unsupported.'
    Assert-Project42Condition `
        -Condition ($Benchmark.schemaVersion -eq '1.1') `
        -Message 'The benchmark schema version is unsupported.'

    $inventoryByAlias = Get-Project42Inventory -InventoryDocument $Inventory
    $execution = $Matrix.execution
    Assert-Project42Condition `
        -Condition (
            [int] $execution.judgesPerCase -ge 2 -and
            [int] $execution.judgesPerCase -le 3
        ) `
        -Message 'Foundry execution requires two or three judges per case.'
    Assert-Project42Condition `
        -Condition (
            [double] $execution.minimumJudgeScore -ge 0 -and
            [double] $execution.minimumJudgeScore -le 1
        ) `
        -Message 'The minimum judge score must be between zero and one.'
    Assert-Project42Condition `
        -Condition (
            [int] $execution.maximumCompletionTokens -ge 64 -and
            [int] $execution.maximumCompletionTokens -le 2000
        ) `
        -Message 'The completion-token ceiling must be between 64 and 2,000.'
    Assert-Project42Condition `
        -Condition (
            [int] $execution.minimumDeploymentIntervalSeconds -ge 0 -and
            [int] $execution.minimumDeploymentIntervalSeconds -le 120
        ) `
        -Message 'The deployment interval must be between zero and 120 seconds.'
    Assert-Project42Condition `
        -Condition (
            [int] $execution.requestTimeoutSeconds -ge 30 -and
            [int] $execution.requestTimeoutSeconds -le 600
        ) `
        -Message 'The request timeout must be between 30 and 600 seconds.'
    Assert-Project42Condition `
        -Condition (
            [int] $execution.maximumRetries -ge 0 -and
            [int] $execution.maximumRetries -le 3
        ) `
        -Message 'Foundry execution permits at most three retries.'
    Assert-Project42Condition `
        -Condition ([int] $execution.maximumRequests -gt 0) `
        -Message 'Foundry execution requires a positive request ceiling.'
    Assert-Project42Condition `
        -Condition ([double] $execution.maximumEstimatedCostUsd -gt 0) `
        -Message 'Foundry execution requires a positive cost ceiling.'

    $judgePool = @($execution.judgePool)
    Assert-Project42Condition `
        -Condition ($judgePool.Count -ge 3) `
        -Message 'Foundry execution requires at least three judge deployments.'
    $judgeAliases = @(
        $judgePool |
            ForEach-Object { [string] $_.deploymentAlias }
    )
    Assert-Project42Condition `
        -Condition (
            ($judgeAliases | Select-Object -Unique).Count -eq $judgeAliases.Count
        ) `
        -Message 'The Foundry judge pool contains a duplicate alias.'
    $judgeProviders = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($judge in $judgePool) {
        $alias = [string] $judge.deploymentAlias
        Assert-Project42Condition `
            -Condition ($inventoryByAlias.ContainsKey($alias)) `
            -Message "Judge $alias is absent from the Foundry inventory."
        $inventoryEntry = $inventoryByAlias[$alias]
        Assert-Project42Condition `
            -Condition (
                (Get-Project42NormalizedProvider -Value $judge.providerFamily) -eq
                (Get-Project42NormalizedProvider -Value $inventoryEntry.format)
            ) `
            -Message "Judge $alias has a provider-family mismatch."
        Assert-Project42Condition `
            -Condition (
                [string] $judge.modelVersion -eq [string] $inventoryEntry.version
            ) `
            -Message "Judge $alias has a model-version mismatch."
        $null = $judgeProviders.Add(
            (Get-Project42NormalizedProvider -Value $judge.providerFamily)
        )
    }
    Assert-Project42Condition `
        -Condition ($judgeProviders.Count -ge 3) `
        -Message 'The Foundry judge pool requires three provider families.'
    $matrixStages = @($Matrix.stages)
    Assert-Project42Condition `
        -Condition ($matrixStages.Count -eq $script:Project42MaintenanceStages.Count) `
        -Message 'The candidate matrix must contain exactly six stages.'

    $stageNames = @($matrixStages | ForEach-Object { [string] $_.stage })
    foreach ($stage in $script:Project42MaintenanceStages) {
        Assert-Project42Condition `
            -Condition (@($stageNames | Where-Object { $_ -eq $stage }).Count -eq 1) `
            -Message "The candidate matrix must contain stage $stage exactly once."
    }

    $providerFamilies = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($stage in $matrixStages) {
        $candidates = @($stage.candidates)
        Assert-Project42Condition `
            -Condition ($candidates.Count -ge 2) `
            -Message "$($stage.stage) requires at least two candidates."
        Assert-Project42Condition `
            -Condition (
                [double] $stage.threshold -ge 0 -and
                [double] $stage.threshold -le 1
            ) `
            -Message "$($stage.stage) threshold must be between zero and one."

        $aliases = @($candidates | ForEach-Object { [string] $_.deploymentAlias })
        Assert-Project42Condition `
            -Condition (($aliases | Select-Object -Unique).Count -eq $aliases.Count) `
            -Message "$($stage.stage) contains a duplicate candidate alias."

        foreach ($candidate in $candidates) {
            $alias = [string] $candidate.deploymentAlias
            Assert-Project42Condition `
                -Condition ($inventoryByAlias.ContainsKey($alias)) `
                -Message "$($stage.stage) candidate $alias is absent from the Foundry inventory."
            $inventoryEntry = $inventoryByAlias[$alias]
            Assert-Project42Condition `
                -Condition (
                    (Get-Project42NormalizedProvider -Value $candidate.providerFamily) -eq
                    (Get-Project42NormalizedProvider -Value $inventoryEntry.format)
                ) `
                -Message "$($stage.stage) candidate $alias has a provider-family mismatch."
            Assert-Project42Condition `
                -Condition ([string] $candidate.modelVersion -eq [string] $inventoryEntry.version) `
                -Message "$($stage.stage) candidate $alias has a model-version mismatch."
            $null = $providerFamilies.Add(
                (Get-Project42NormalizedProvider -Value $candidate.providerFamily)
            )
        }
    }
    Assert-Project42Condition `
        -Condition ($providerFamilies.Count -ge 3) `
        -Message 'The candidate matrix must contain at least three provider families.'

    $cases = @($Benchmark.cases)
    Assert-Project42Condition `
        -Condition ($cases.Count -ge 10) `
        -Message 'The held-out benchmark must contain at least ten cases.'
    $caseIds = @($cases | ForEach-Object { [string] $_.id })
    Assert-Project42Condition `
        -Condition (($caseIds | Select-Object -Unique).Count -eq $caseIds.Count) `
        -Message 'The held-out benchmark contains a duplicate case ID.'

    $requiredCategories = @(
        'provenance',
        'factuality',
        'conflict',
        'prompt-injection',
        'instructional-quality',
        'assessment-validity',
        'accessibility',
        'governance',
        'recovery',
        'structured-output'
    )
    $categories = @($cases | ForEach-Object { [string] $_.category })
    foreach ($category in $requiredCategories) {
        Assert-Project42Condition `
            -Condition ($categories -contains $category) `
            -Message "The held-out benchmark is missing category $category."
    }

    foreach ($case in $cases) {
        Assert-Project42Condition `
            -Condition ([double] $case.weight -gt 0) `
            -Message "$($case.id) must have a positive weight."
        Assert-Project42Condition `
            -Condition (
                -not [string]::IsNullOrWhiteSpace([string] $case.prompt) -and
                -not [string]::IsNullOrWhiteSpace([string] $case.expectedBehavior)
            ) `
            -Message "$($case.id) requires a prompt and expected behavior."
        $packet = @($case.fixture.packet)
        Assert-Project42Condition `
            -Condition (
                $packet.Count -ge 1 -and
                @(
                    $packet |
                        Where-Object {
                            [string]::IsNullOrWhiteSpace([string] $_)
                        }
                ).Count -eq 0
            ) `
            -Message "$($case.id) requires a concrete held-out fixture packet."
        $rubric = @($case.rubric)
        Assert-Project42Condition `
            -Condition (
                $rubric.Count -ge 2 -and
                @(
                    $rubric |
                        Where-Object {
                            [string]::IsNullOrWhiteSpace([string] $_)
                        }
                ).Count -eq 0
            ) `
            -Message "$($case.id) requires at least two scoring criteria."
        foreach ($stage in @($case.appliesTo)) {
            Assert-Project42Condition `
                -Condition ($script:Project42MaintenanceStages -contains $stage) `
                -Message "$($case.id) refers to unknown stage $stage."
        }
    }

    foreach ($stage in $script:Project42MaintenanceStages) {
        $stageCases = @(
            $cases |
                Where-Object { @($_.appliesTo) -contains $stage }
        )
        Assert-Project42Condition `
            -Condition ($stageCases.Count -ge 3) `
            -Message "$stage requires at least three held-out cases."
        Assert-Project42Condition `
            -Condition (@($stageCases | Where-Object { $_.mustPass }).Count -ge 2) `
            -Message "$stage requires at least two must-pass cases."
    }

    return [pscustomobject]@{
        schemaVersion = '1.1'
        matrixId = [string] $Matrix.id
        benchmarkId = [string] $Benchmark.id
        stageCount = $matrixStages.Count
        caseCount = $cases.Count
        providerFamilyCount = $providerFamilies.Count
        inventoryAliasCount = $inventoryByAlias.Count
        valid = $true
    }
}

function Get-Project42QualifiedRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Stage,

        [Parameter(Mandatory)]
        [string] $Alias,

        [Parameter(Mandatory)]
        [hashtable] $RunsByKey,

        [Parameter(Mandatory)]
        [hashtable] $CandidatesByKey,

        [Parameter(Mandatory)]
        [psobject[]] $BenchmarkCases,

        [Parameter(Mandatory)]
        [double] $Threshold
    )

    $key = "$Stage|$Alias"
    Assert-Project42Condition `
        -Condition ($CandidatesByKey.ContainsKey($key)) `
        -Message "Selection $key is absent from the candidate matrix."
    Assert-Project42Condition `
        -Condition ($RunsByKey.ContainsKey($key)) `
        -Message "Selection $key has no measured qualification run."

    $candidate = $CandidatesByKey[$key]
    $run = $RunsByKey[$key]
    Assert-Project42Condition `
        -Condition ([string] $run.providerFamily -eq [string] $candidate.providerFamily) `
        -Message "$key run provider does not match the candidate matrix."
    Assert-Project42Condition `
        -Condition ([string] $run.modelVersion -eq [string] $candidate.modelVersion) `
        -Message "$key run model version does not match the candidate matrix."
    Assert-Project42Timestamp -Value $run.evaluatedAt -Label "$key evaluatedAt"
    Assert-Project42Digest -Value $run.inputDigest -Label "$key inputDigest"
    Assert-Project42Digest -Value $run.outputDigest -Label "$key outputDigest"
    Assert-Project42Condition `
        -Condition ([double] $run.latencyMs -ge 0) `
        -Message "$key latency cannot be negative."
    Assert-Project42Condition `
        -Condition ([double] $run.costUsd -ge 0) `
        -Message "$key cost cannot be negative."

    $requiredCases = @(
        $BenchmarkCases |
            Where-Object { @($_.appliesTo) -contains $Stage }
    )
    $runCases = @($run.cases)
    $runCaseIds = @($runCases | ForEach-Object { [string] $_.id })
    Assert-Project42Condition `
        -Condition (($runCaseIds | Select-Object -Unique).Count -eq $runCaseIds.Count) `
        -Message "$key contains a duplicate benchmark result."
    Assert-Project42Condition `
        -Condition ($runCases.Count -eq $requiredCases.Count) `
        -Message "$key does not contain the exact required benchmark cases."

    $weightedScore = 0.0
    $totalWeight = 0.0
    foreach ($benchmarkCase in $requiredCases) {
        $caseResult = @(
            $runCases |
                Where-Object { $_.id -eq $benchmarkCase.id }
        )
        Assert-Project42Condition `
            -Condition ($caseResult.Count -eq 1) `
            -Message "$key is missing benchmark case $($benchmarkCase.id)."
        $score = [double] $caseResult[0].score
        Assert-Project42Condition `
            -Condition ($score -ge 0 -and $score -le 1) `
            -Message "$key case $($benchmarkCase.id) score is outside zero to one."
        if ($benchmarkCase.mustPass) {
            Assert-Project42Condition `
                -Condition ([bool] $caseResult[0].passed) `
                -Message "$key failed must-pass case $($benchmarkCase.id)."
        }
        $weightedScore += $score * [double] $benchmarkCase.weight
        $totalWeight += [double] $benchmarkCase.weight
    }

    $score = [Math]::Round($weightedScore / $totalWeight, 6)
    Assert-Project42Condition `
        -Condition ($score -ge $Threshold) `
        -Message "$key score $score did not meet threshold $Threshold."

    return [pscustomobject]@{
        candidate = $candidate
        run = $run
        score = $score
    }
}

function ConvertTo-Project42FoundryRoleProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject] $Matrix,

        [Parameter(Mandatory)]
        [psobject] $Benchmark,

        [Parameter(Mandatory)]
        [psobject] $Inventory,

        [Parameter(Mandatory)]
        [psobject] $Results,

        [Parameter()]
        [switch] $AllowSyntheticTestFixture
    )

    $null = Test-Project42FoundryQualificationConfiguration `
        -Matrix $Matrix `
        -Benchmark $Benchmark `
        -Inventory $Inventory
    Assert-Project42Condition `
        -Condition ($Results.schemaVersion -eq '1.0') `
        -Message 'The qualification results schema version is unsupported.'
    Assert-Project42Condition `
        -Condition ([string] $Results.benchmarkId -eq [string] $Benchmark.id) `
        -Message 'The qualification results reference a different benchmark.'
    if ([bool] $Results.synthetic -and -not $AllowSyntheticTestFixture) {
        throw 'Synthetic qualification results cannot emit a role profile.'
    }

    $matrixStagesByName = @{}
    $candidatesByKey = @{}
    foreach ($stage in @($Matrix.stages)) {
        $matrixStagesByName[[string] $stage.stage] = $stage
        foreach ($candidate in @($stage.candidates)) {
            $candidatesByKey["$($stage.stage)|$($candidate.deploymentAlias)"] = $candidate
        }
    }

    $runsByKey = @{}
    foreach ($run in @($Results.runs)) {
        $key = "$($run.stage)|$($run.deploymentAlias)"
        Assert-Project42Condition `
            -Condition (-not $runsByKey.ContainsKey($key)) `
            -Message "Qualification results contain duplicate run $key."
        $runsByKey[$key] = $run
    }

    $selectionsByStage = @{}
    foreach ($selection in @($Results.selection)) {
        $stage = [string] $selection.stage
        Assert-Project42Condition `
            -Condition (-not $selectionsByStage.ContainsKey($stage)) `
            -Message "Qualification results contain duplicate selection $stage."
        $selectionsByStage[$stage] = $selection
    }

    $profileStages = [System.Collections.Generic.List[object]]::new()
    $selectedPrimaries = @{}
    foreach ($stageName in $script:Project42MaintenanceStages) {
        Assert-Project42Condition `
            -Condition ($selectionsByStage.ContainsKey($stageName)) `
            -Message "Qualification results are missing selection $stageName."
        $selection = $selectionsByStage[$stageName]
        $fallbackAliases = @($selection.fallbackDeploymentAliases)
        Assert-Project42Condition `
            -Condition ($fallbackAliases.Count -ge 1) `
            -Message "$stageName requires at least one qualified fallback."
        $allAliases = @(
            [string] $selection.primaryDeploymentAlias
            $fallbackAliases | ForEach-Object { [string] $_ }
        )
        Assert-Project42Condition `
            -Condition (($allAliases | Select-Object -Unique).Count -eq $allAliases.Count) `
            -Message "$stageName repeats a primary or fallback alias."

        $matrixStage = $matrixStagesByName[$stageName]
        $primary = Get-Project42QualifiedRun `
            -Stage $stageName `
            -Alias $selection.primaryDeploymentAlias `
            -RunsByKey $runsByKey `
            -CandidatesByKey $candidatesByKey `
            -BenchmarkCases @($Benchmark.cases) `
            -Threshold ([double] $matrixStage.threshold)
        foreach ($fallbackAlias in $fallbackAliases) {
            $null = Get-Project42QualifiedRun `
                -Stage $stageName `
                -Alias $fallbackAlias `
                -RunsByKey $runsByKey `
                -CandidatesByKey $candidatesByKey `
                -BenchmarkCases @($Benchmark.cases) `
                -Threshold ([double] $matrixStage.threshold)
        }

        $selectedPrimaries[$stageName] = $primary
        $profileStages.Add([pscustomobject][ordered]@{
            stage = $stageName
            primaryDeploymentAlias = [string] $selection.primaryDeploymentAlias
            providerFamily = [string] $primary.candidate.providerFamily
            modelVersion = [string] $primary.candidate.modelVersion
            fallbackDeploymentAliases = @($fallbackAliases)
            qualification = [pscustomobject][ordered]@{
                benchmarkId = [string] $Benchmark.id
                evaluatedAt = [string] $primary.run.evaluatedAt
                score = [double] $primary.score
                threshold = [double] $matrixStage.threshold
            }
        })
    }

    $primaryAliases = @(
        $profileStages |
            ForEach-Object { [string] $_.primaryDeploymentAlias }
    )
    Assert-Project42Condition `
        -Condition (($primaryAliases | Select-Object -Unique).Count -ge 3) `
        -Message 'Qualified role profile requires at least three primary deployments.'
    Assert-Project42Condition `
        -Condition (
            $selectedPrimaries['evidence-research'].candidate.deploymentAlias -ne
            $selectedPrimaries['curriculum-writing'].candidate.deploymentAlias
        ) `
        -Message 'Evidence research and curriculum writing require distinct deployments.'
    Assert-Project42Condition `
        -Condition (
            (Get-Project42NormalizedProvider `
                -Value $selectedPrimaries['curriculum-writing'].candidate.providerFamily) -ne
            (Get-Project42NormalizedProvider `
                -Value $selectedPrimaries['factual-verification'].candidate.providerFamily)
        ) `
        -Message 'Curriculum writing and factual verification require different provider families.'

    $effectiveAt = @(
        $profileStages |
            ForEach-Object { [DateTimeOffset]::Parse($_.qualification.evaluatedAt) } |
            Sort-Object -Descending
    )[0].ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

    return [pscustomobject][ordered]@{
        schemaVersion = '1.0'
        id = 'project42-content-maintenance-qualified-1'
        effectiveAt = $effectiveAt
        stages = @($profileStages)
    }
}

Export-ModuleMember -Function @(
    'Read-Project42Json',
    'Test-Project42FoundryQualificationConfiguration',
    'ConvertTo-Project42FoundryRoleProfile'
)
