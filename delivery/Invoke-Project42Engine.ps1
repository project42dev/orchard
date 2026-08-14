#Requires -Version 7.4
<#
.SYNOPSIS
    The full 8-phase orchard engine: discover, score, build DB, GATE 1, briefs,
    deliver, ingest, notify. Runs entirely within the container.

.DESCRIPTION
    Authorized by the 2026-08-11 design decision: ACA Jobs is the single platform.
    The 8-phase pipeline runs entirely within the container. GitHub Actions is not
    part of the production architecture.

    Phases:
      1. Discovery  - find content opportunities (Node.js)
      2. Scoring    - rank them (Node.js)
      3. Database   - rebuild the content index (Node.js)
      4. GATE 1     - the owner decides what gets written, BEFORE it is written.
                      New work lands at gate1-pending; only an approval moves it
                      to queued, and only queued items are ever authored. This is
                      what stops the engine paying to write items the owner would
                      have declined. (Node.js)
      5. Briefs     - generate briefs for APPROVED work only (Node.js)
      6. Delivery   - run the ensemble against Azure AI Foundry (PowerShell)
      7. Ingest     - record results in the database (Node.js)
      8. Notify     - create a GitHub Issue for human review (Node.js)

    Each phase is independent and fails the run if it fails.

.NOTES
    Authenticates by managed identity. No key is read, stored, or logged.
    The Node.js scripts need the project42-platform content mounted at /mnt/corpus.
#>

[CmdletBinding()]
param(
    [switch] $Execute,
    [switch] $SkipDiscovery,
    [switch] $SkipScoring,
    [switch] $SkipDatabase,
    [switch] $SkipGate1,
    [switch] $SkipBriefs,
    [switch] $SkipDelivery,
    [switch] $SkipIngest,
    [switch] $SkipNotify,
    [switch] $Offline,
    [string] $Surface = ${env:ORCHARD_SURFACE} ?? 'learn',
    [string] $CorpusPath = ${env:ORCHARD_CORPUS_PATH} ?? '/app/content',
    [string] $WorkDir = ${env:ORCHARD_WORK_DIR} ?? '/app',
    [string] $ConfigDir = ${env:ORCHARD_CONFIG_DIR} ?? '/mnt/config',
    [string] $RunRecordRoot = ${env:RUN_RECORD_ROOT} ?? '/mnt/run-records',
    [string] $ProposalRoot = ${env:PROPOSAL_ROOT} ?? '/mnt/run-records/proposals',
    [string] $DbPath = ${env:ORCHARD_DB_PATH} ?? '/mnt/run-records/content.db',
    [string] $RegistryPath = ${env:ORCHARD_REGISTRY_PATH} ?? '/mnt/run-records/opportunity-registry.json',
    [string] $ProbesPath = ${env:ORCHARD_PROBES_PATH} ?? '/app/content/probes.json',
    [string] $DiscoveryOut = ${env:ORCHARD_DISCOVERY_OUT} ?? '/mnt/run-records/discovery-proposals.json',
    [string] $BriefsOut = ${env:ORCHARD_BRIEFS_OUT} ?? '/mnt/run-records/briefs-queue.json',
    [string] $Gate1Out = ${env:ORCHARD_GATE1_OUT} ?? '/mnt/run-records/gate1-issue.md',
    [string] $InventoryPath = ${env:ORCHARD_INVENTORY_PATH} ?? '/mnt/config/deployed-models.json',
    [string] $EngineRunId = ${env:ORCHARD_ENGINE_RUN_ID} ?? '',
    [int] $GapThreshold = [int](${env:ORCHARD_GAP_THRESHOLD} ?? '0'),
    [int] $Timeout = [int](${env:ORCHARD_TIMEOUT} ?? '30')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$startedUtc = [datetime]::UtcNow
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

if ([string]::IsNullOrWhiteSpace($EngineRunId)) {
    $EngineRunId = "engine-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString().Substring(0, 8))"
}

$phaseResults = [System.Collections.Generic.List[object]]::new()

function Write-EngineLog {
    param([string] $Level, [string] $Message)
    $line = '{0} [{1}] [engine] {2}' -f ([datetime]::UtcNow.ToString('o')), $Level.ToUpperInvariant(), $Message
    Write-Host $line
}

function Invoke-EnginePhase {
    param(
        [Parameter(Mandatory)][string] $PhaseName,
        [Parameter(Mandatory)][int] $PhaseNumber,
        [Parameter(Mandatory)][scriptblock] $Action
    )

    Write-EngineLog INFO "Phase $PhaseNumber/${totalPhases}: $PhaseName starting..."
    $phaseStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Action
        $elapsed = [Math]::Round($phaseStopwatch.Elapsed.TotalSeconds, 2)
        Write-EngineLog INFO "Phase ${PhaseNumber}: $PhaseName completed in $($elapsed)s"
        $phaseResults.Add([pscustomobject]@{
                phase          = $PhaseNumber
                name           = $PhaseName
                status         = 'completed'
                elapsedSeconds = $elapsed
            })
        return $result
    }
    catch {
        $elapsed = [Math]::Round($phaseStopwatch.Elapsed.TotalSeconds, 2)
        Write-EngineLog ERROR "Phase ${PhaseNumber}: $PhaseName FAILED in $($elapsed)s: $($_.Exception.Message)"
        $phaseResults.Add([pscustomobject]@{
                phase          = $PhaseNumber
                name           = $PhaseName
                status         = 'failed'
                error          = $_.Exception.Message
                elapsedSeconds = $elapsed
            })
        throw
    }
}

# Count how many phases will run
$totalPhases = 0
$phaseMap = [ordered]@{}
if (-not $SkipDiscovery) { $totalPhases++; $phaseMap['discovery'] = 1 }
if (-not $SkipScoring) { $totalPhases++; $phaseMap['scoring'] = 2 }
if (-not $SkipDatabase) { $totalPhases++; $phaseMap['database'] = 3 }
if (-not $SkipGate1) { $totalPhases++; $phaseMap['gate1'] = 4 }
if (-not $SkipBriefs) { $totalPhases++; $phaseMap['briefs'] = 5 }
if (-not $SkipDelivery) { $totalPhases++; $phaseMap['delivery'] = 6 }
if (-not $SkipIngest) { $totalPhases++; $phaseMap['ingest'] = 7 }
if (-not $SkipNotify) { $totalPhases++; $phaseMap['notify'] = 8 }

Write-EngineLog INFO "run=$EngineRunId phases=$totalPhases surface=$Surface corpus=$CorpusPath"

if (-not $Execute) {
    Write-EngineLog INFO 'PLAN ONLY. No phase will execute. Pass -Execute to run.'
    Write-EngineLog INFO "Would run: $($phaseMap.Keys -join ' -> ')"
    return
}

# Ensure working directories exist
foreach ($dir in @($WorkDir, $RunRecordRoot, $ProposalRoot, (Split-Path $DbPath -Parent))) {
    if (-not (Test-Path $dir)) {
        $null = New-Item -ItemType Directory -Path $dir -Force
    }
}

# Initialize the opportunity registry if it doesn't exist yet.
# The registry is the live record of every opportunity the engine has ever
# discovered. On first run it starts empty and discovery populates it.
if (-not (Test-Path $RegistryPath)) {
    Write-EngineLog INFO "Initializing empty opportunity registry at $RegistryPath"
    $initialRegistry = @{ watchList = @(); opportunities = @(); version = 1; createdAt = [datetime]::UtcNow.ToString('o') }
    $initialRegistry | ConvertTo-Json -Depth 5 | Out-File -FilePath $RegistryPath -Encoding utf8 -NoNewline
}

# ---- Phase 1: Discovery ----
if (-not $SkipDiscovery) {
    Invoke-EnginePhase -PhaseName 'Discovery' -PhaseNumber 1 -Action {
        $offlineFlag = if ($Offline) { '--offline' } else { '' }
        $args = @(
            "$WorkDir/scripts/discover-content-opportunities.mjs",
            '--registry', $RegistryPath,
            '--corpus', $CorpusPath,
            '--probes', $ProbesPath,
            '--out', $DiscoveryOut,
            '--gap-threshold', [string] $GapThreshold,
            '--surface', $Surface,
            '--timeout', [string] $Timeout
        )
        if ($Offline) { $args += '--offline' }

        Write-EngineLog INFO "discovery: node $( $args -join ' ' )"
        & node $args 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3) {
            # Exit code 3 = survey reached no source, proposals still emitted
            throw "discovery exited with code $LASTEXITCODE"
        }
        if ($LASTEXITCODE -eq 3) {
            Write-EngineLog INFO 'discovery: survey reached no source (offline or empty watch list), proposals still emitted'
        }

        # Merge proposals into the live registry
        Write-EngineLog INFO 'discovery: merging proposals into registry...'
        & node "$WorkDir/scripts/merge-opportunity-proposals.mjs" `
            --registry $RegistryPath `
            --proposals $DiscoveryOut `
            --apply 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) {
            # Exit code 2 = conflicts that need human review, not a fatal error
            throw "merge-opportunity-proposals exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 2: Scoring ----
if (-not $SkipScoring) {
    Invoke-EnginePhase -PhaseName 'Scoring' -PhaseNumber 2 -Action {
        & node "$WorkDir/scripts/score-opportunities.mjs" `
            --registry $RegistryPath `
            --all 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "scoring exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 3: Database ----
if (-not $SkipDatabase) {
    Invoke-EnginePhase -PhaseName 'Database Build' -PhaseNumber 3 -Action {
        # The Gate 1 migration MUST run before the build, because the build now
        # inserts new work at 'gate1-pending' and an unmigrated database still
        # carries the old CHECK constraint that rejects that value. Idempotent.
        & node "$WorkDir/scripts/migrate-gate1.mjs" --db $DbPath 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "migrate-gate1 exited with code $LASTEXITCODE" }

        & node "$WorkDir/scripts/build-content-db.mjs" `
            --content $CorpusPath `
            --db $DbPath 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "build-content-db exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 3b: Gate 1 ----
#
# The owner decides what gets written, BEFORE it is written.
#
# New work lands at 'gate1-pending'. generate-briefs.mjs authors only
# `state = 'queued'`, so an unapproved item cannot reach a model and cannot
# spend money. This phase migrates the schema if needed and emits the Gate 1
# issue body listing everything awaiting a decision with its score.
#
# It never approves anything. Approval arrives out of band as an owner comment
# applied by `gate1-review.mjs --apply`.
if (-not $SkipGate1) {
    Invoke-EnginePhase -PhaseName 'Gate 1' -PhaseNumber 4 -Action {
        & node "$WorkDir/scripts/migrate-gate1.mjs" --db $DbPath 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "migrate-gate1 exited with code $LASTEXITCODE" }

        & node "$WorkDir/scripts/gate1-review.mjs" --db $DbPath --notify --out $Gate1Out 2>&1 |
            ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "gate1-review exited with code $LASTEXITCODE" }
        Write-EngineLog INFO "gate 1: issue body written to $Gate1Out"
    }
}

# ---- Phase 5: Briefs ----
if (-not $SkipBriefs) {
    Invoke-EnginePhase -PhaseName 'Brief Generation' -PhaseNumber 5 -Action {
        & node "$WorkDir/scripts/generate-briefs.mjs" `
            --db $DbPath `
            --out $BriefsOut `
            --inventory $InventoryPath `
            --apply 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "generate-briefs exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 5: Delivery ----
if (-not $SkipDelivery) {
    Invoke-EnginePhase -PhaseName 'Delivery' -PhaseNumber 6 -Action {
        # The delivery script is invoked directly with its own environment.
        # It reads BRIEF_PATH, DELIVERY_MODE, etc. from the environment
        # already set by the ACA job definition.
        & pwsh -NoProfile -File "$WorkDir/Invoke-Project42Delivery.ps1" -Execute
        if ($LASTEXITCODE -ne 0) {
            throw "delivery exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 6: Ingest ----
if (-not $SkipIngest) {
    Invoke-EnginePhase -PhaseName 'Ingest' -PhaseNumber 7 -Action {
        & node "$WorkDir/scripts/ingest-proposals.mjs" `
            --db $DbPath `
            --run-records $RunRecordRoot `
            --apply 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "ingest-proposals exited with code $LASTEXITCODE"
        }
    }
}

# ---- Phase 7: Notify ----
if (-not $SkipNotify) {
    Invoke-EnginePhase -PhaseName 'Notify' -PhaseNumber 8 -Action {
        & node "$WorkDir/scripts/notify-review-ready.mjs" `
            --db $DbPath `
            --proposals $ProposalRoot `
            --engine-run-id $EngineRunId 2>&1 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "notify-review-ready exited with code $LASTEXITCODE"
        }
    }
}

# ---- Summary ----
$totalElapsed = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
Write-EngineLog INFO "Engine run $EngineRunId complete in ${totalElapsed}s"
Write-Host ''
Write-Host '## Orchard Engine Run Summary'
Write-Host ''
Write-Host '| Phase | Status | Time |'
Write-Host '|-------|--------|------|'
foreach ($result in $phaseResults) {
    $status = if ($result.status -eq 'completed') { 'OK' } else { "FAILED: $($result.error)" }
    Write-Host "| $($result.name) | $status | $($result.elapsedSeconds)s |"
}
Write-Host ''
Write-Host "Total: ${totalElapsed}s"

$failed = @($phaseResults | Where-Object { $_.status -ne 'completed' })
if ($failed.Count -gt 0) {
    Write-EngineLog ERROR "Engine run had $($failed.Count) failed phase(s)."
    exit 1
}

Write-EngineLog INFO 'All phases completed successfully.'
exit 0
