#Requires -Version 7.4
<#
.SYNOPSIS
    Batch runs the local delivery pipeline for all AI Foundations enrichment briefs.
#>
param(
    [Parameter(Mandatory)][string] $BriefsDir,
    [Parameter(Mandatory)][string] $PlatformRoot,
    [string] $Endpoint = 'https://aif-studioai-prod-eus-01.services.ai.azure.com',
    [string] $DeliveryScript = $null,
    [string] $ExtractScript = $null
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

if (-not $DeliveryScript) {
    $DeliveryScript = Join-Path $PSScriptRoot 'Invoke-LocalDelivery.ps1'
}
if (-not $ExtractScript) {
    $ExtractScript = Join-Path $PSScriptRoot 'Extract-DeliveryOutput.ps1'
}

$briefs = Get-ChildItem $BriefsDir -Filter '*.json' | Sort-Object Name
Write-Host "[INFO] Processing $($briefs.Count) briefs"

$success = 0
$failed = 0
$results = @()

foreach ($brief in $briefs) {
    Write-Host ""
    Write-Host "============================================================"
    Write-Host "[INFO] Processing: $($brief.Name)"
    Write-Host "============================================================"

    # Run delivery pipeline
    $result = pwsh -NoProfile -File $DeliveryScript `
        -BriefPath $brief.FullName `
        -Endpoint $Endpoint 2>&1

    $resultStr = $result -join "`n"
    Write-Host $resultStr

    # Read brief to get module directory
    $briefData = Get-Content $brief.FullName -Raw | ConvertFrom-Json
    $moduleDir = Split-Path $briefData.targets[0].pathPrefixes[0] -Leaf
    Write-Host "[INFO] Module directory: $moduleDir"

    # Find the run directory (multiline regex to match end of line)
    if ($resultStr -match '(?m)Output: (.+)$') {
        $runDir = $matches[1].Trim()
        $finalPath = Join-Path $runDir '04-final.md'

        if (Test-Path $finalPath) {
            $finalContent = Get-Content $finalPath -Raw
            if ($finalContent.Length -gt 500 -and $finalContent -notmatch '\[ERROR') {
                # Extract files
                Write-Host "[INFO] Extracting files from $finalPath to module $moduleDir..."
                $extractResult = pwsh -NoProfile -File $ExtractScript `
                    -FinalOutputPath $finalPath `
                    -TargetRepoRoot $PlatformRoot `
                    -ModuleDir $moduleDir 2>&1
                Write-Host ($extractResult -join "`n")
                $success++
                $results += "$($brief.Name): SUCCESS"
            }
            else {
                Write-Host "[ERROR] Final output too short or contains errors"
                $failed++
                $results += "$($brief.Name): FAILED (bad output)"
            }
        }
        else {
            Write-Host "[ERROR] No final output found at $finalPath"
            $failed++
            $results += "$($brief.Name): FAILED (no output)"
        }
    }
    else {
        Write-Host "[ERROR] Could not find run directory in output"
        $failed++
        $results += "$($brief.Name): FAILED (no run dir)"
    }

    # Brief pause between runs
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "============================================================"
Write-Host "[INFO] BATCH COMPLETE: $success succeeded, $failed failed"
Write-Host "============================================================"
foreach ($r in $results) {
    Write-Host "  $r"
}
