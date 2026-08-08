#Requires -Version 7.4
<#
.SYNOPSIS
    Batch post-process all completed local delivery runs:
    1. Create run records
    2. Create proposal/packet JSON wrappers
    3. Run ingest-proposals.mjs
    4. Run notify-review-ready.mjs
#>
param(
    [string] $OrchardRoot = 'D:\git\project42dev\orchard',
    [switch] $SkipIngest,
    [switch] $SkipNotify
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$localProposalsDir = Join-Path $OrchardRoot 'delivery\private\local-proposals'
$runRecordsDir = Join-Path $OrchardRoot 'delivery\run-records'
$proposalsDir = Join-Path $OrchardRoot 'delivery\proposals'
$dbPath = Join-Path $OrchardRoot 'content.db'

# Ensure output dirs exist
$null = New-Item -ItemType Directory -Force -Path $runRecordsDir
$null = New-Item -ItemType Directory -Force -Path $proposalsDir

# Step 1: Find all completed runs (have 04-final.md)
$completedDirs = Get-ChildItem $localProposalsDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName '04-final.md')
}

Write-Host "[INFO] Found $($completedDirs.Count) completed runs"

# Step 2: Build brief lookup (briefId -> workItemId, subjectId, kind, targets)
$briefsPath = Join-Path $OrchardRoot 'briefs\queue.json'
$briefLookup = @{}
if (Test-Path $briefsPath) {
    $briefs = Get-Content $briefsPath -Raw | ConvertFrom-Json
    foreach ($b in $briefs) {
        $briefLookup[$b.id] = $b
    }
    Write-Host "[INFO] Loaded $($briefLookup.Count) briefs from queue.json"
}

# Step 3: Read run-metadata.json from each to get briefId, then look up workItemId
$runData = @()
foreach ($dir in $completedDirs) {
    $metaPath = Join-Path $dir.FullName 'run-metadata.json'
    if (-not (Test-Path $metaPath)) {
        Write-Host "[WARN] No run-metadata.json in $($dir.Name), skipping"
        continue
    }
    $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    $briefId = $meta.briefId
    $brief = $briefLookup[$briefId]
    if (-not $brief) {
        Write-Host "[SKIP] No brief in queue.json for briefId=$briefId ($($dir.Name)), skipping (already processed)"
        continue
    }
    $runData += @{
        RunId        = $dir.Name
        DirPath      = $dir.FullName
        BriefId      = $briefId
        WorkItemId   = $brief.workItemId
        SubjectId    = $brief.subjectId
        Kind         = $brief.kind
        Targets      = $brief.targets
        StartedUtc   = $meta.startedUtc
        CompletedUtc = if (Get-Member -InputObject $meta -Name 'completedUtc' -MemberType Properties) { $meta.completedUtc } else { $dir.LastWriteTimeUtc.ToString('o') }
    }
}

Write-Host "[INFO] Parsed metadata for $($runData.Count) runs"

# Step 3: Create run records
$newRunRecords = 0
foreach ($run in $runData) {
    $recordPath = Join-Path $runRecordsDir "run-local-$($run.RunId).json"
    if (Test-Path $recordPath) {
        Write-Host "[SKIP] Run record already exists: $recordPath"
        continue
    }

    $record = @{
        outcome      = 'succeeded'
        steps        = @(
            @{ role = 'drafter'; providerFamily = 'OpenAI'; deployment = 'gpt-5-6-sol' }
            @{ role = 'verifier'; providerFamily = 'xAI'; deployment = 'grok-4-20-reasoning' }
            @{ role = 'adversary'; providerFamily = 'DeepSeek'; deployment = 'deepseek-v4-pro' }
            @{ role = 'arbiter'; providerFamily = 'MistralAI'; deployment = 'mistral-large-3' }
        )
        runId        = $run.RunId
        startedUtc   = $run.StartedUtc
        completedUtc = $run.CompletedUtc
        mode         = 'local'
        proposals    = @(
            @{
                workItemId     = $run.WorkItemId
                briefId        = $run.BriefId
                proposalDigest = 'local-delivery-run'
                disposition    = 'ready-for-draft'
                proposalPath   = "delivery\\private\\local-proposals\\$($run.RunId)\\04-final.md"
            }
        )
    }

    $record | ConvertTo-Json -Depth 5 | Set-Content -Path $recordPath -Encoding UTF8
    Write-Host "[CREATED] Run record: $recordPath"
    $newRunRecords++
}
Write-Host "[INFO] Created $newRunRecords new run records"

# Step 4: Create proposal/packet JSON wrappers
$newProposals = 0
foreach ($run in $runData) {
    $shortRunId = $run.RunId.Substring(0, 8)
    $proposalPath = Join-Path $proposalsDir "proposal-$($run.BriefId)-$shortRunId.json"
    $packetPath = Join-Path $proposalsDir "packet-$($run.BriefId)-$shortRunId.json"

    if (Test-Path $proposalPath) {
        Write-Host "[SKIP] Proposal already exists: $proposalPath"
    }
    else {
        $proposal = @{
            id            = "proposal-$($run.BriefId)-$shortRunId"
            targets       = $run.Targets
            schemaVersion = '1.0.0'
            workItemId    = $run.WorkItemId
            disposition   = 'ready-for-draft'
            kind          = $run.Kind
            humanDecision = 'pending'
            summary       = "4-model ensemble completed locally. See delivery/private/local-proposals/$($run.RunId)/"
            packetId      = "packet-$($run.BriefId)-$shortRunId"
            subjectId     = $run.SubjectId
            createdAt     = $run.CompletedUtc
        }
        $proposal | ConvertTo-Json -Depth 5 | Set-Content -Path $proposalPath -Encoding UTF8
        Write-Host "[CREATED] Proposal: $proposalPath"
        $newProposals++
    }

    if (Test-Path $packetPath) {
        Write-Host "[SKIP] Packet already exists: $packetPath"
    }
    else {
        $packet = @{
            disposition   = 'ready-for-draft'
            evidence      = @{
                verifier  = 'grok-4-20-reasoning'
                drafter   = 'gpt-5-6-sol'
                arbiter   = 'mistral-large-3'
                source    = '4-model ensemble (local)'
                adversary = 'deepseek-v4-pro'
            }
            schemaVersion = '1.0.0'
            proposalId    = "proposal-$($run.BriefId)-$shortRunId"
            id            = "packet-$($run.BriefId)-$shortRunId"
            createdAt     = $run.CompletedUtc
        }
        $packet | ConvertTo-Json -Depth 5 | Set-Content -Path $packetPath -Encoding UTF8
        Write-Host "[CREATED] Packet: $packetPath"
    }
}
Write-Host "[INFO] Created $newProposals new proposal/packet pairs"

# Step 5: Run ingest
if (-not $SkipIngest) {
    Write-Host "[INFO] Running ingest-proposals.mjs..."
    $ingestCmd = "node --experimental-sqlite `"$OrchardRoot\scripts\ingest-proposals.mjs`" --db `"$dbPath`" --run-records `"$runRecordsDir`" --apply"
    Write-Host "[CMD] $ingestCmd"
    $result = cmd /c $ingestCmd 2>&1
    Write-Host $result
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Ingest failed with exit code $LASTEXITCODE"
    }
    else {
        Write-Host "[INFO] Ingest complete"
    }
}
else {
    Write-Host "[SKIP] Ingest skipped (--SkipIngest)"
}

# Step 6: Run notify
if (-not $SkipNotify) {
    Write-Host "[INFO] Running notify-review-ready.mjs..."
    $notifyCmd = "node --experimental-sqlite `"$OrchardRoot\scripts\notify-review-ready.mjs`" --db `"$dbPath`" --proposals `"$proposalsDir`""
    Write-Host "[CMD] $notifyCmd"
    $result = cmd /c $notifyCmd 2>&1
    Write-Host $result
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Notify failed with exit code $LASTEXITCODE"
    }
    else {
        Write-Host "[INFO] Notify complete"
    }
}
else {
    Write-Host "[SKIP] Notify skipped (--SkipNotify)"
}

Write-Host "[DONE] Post-processing complete"
