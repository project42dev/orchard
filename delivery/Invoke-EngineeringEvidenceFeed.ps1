#Requires -Version 7.4
<#
.SYNOPSIS
    Feeds a git diff into the engineering review brief as evidence packets.

.DESCRIPTION
    The engineering review brief (delivery/briefs/engineering-review.json)
    plans cleanly but issues zero requests because nothing feeds it the diff
    or files under review. This script bridges that gap.

    It takes a git diff (or a commit range) and produces one or more
    content-change-packet.json files conforming to the schema at
    delivery/schemas/engineering/content-change-packet.schema.json.

    Each packet is written to delivery/briefs/evidence/ and can be referenced
    by the engineering review brief's sourceChanges array.

.PARAMETER RepoPath
    Path to the git repository to diff.

.PARAMETER CommitRange
    Git commit range to diff (e.g. "HEAD~1..HEAD", "main..feature/branch").
    Defaults to the staged changes if omitted.

.PARAMETER OutputDir
    Where to write the evidence packets. Defaults to
    delivery/briefs/evidence/.

.PARAMETER ScopePaths
    Limit the diff to specific paths. Matches the brief's pathPrefixes.

.EXAMPLE
    .\Invoke-EngineeringEvidenceFeed.ps1 -RepoPath D:\git\project42dev\orchard -CommitRange "HEAD~3..HEAD" -ScopePaths @("scripts/", "delivery/", "config/")
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $RepoPath,

    [string] $CommitRange,

    [string] $OutputDir = (Join-Path $PSScriptRoot '..' 'briefs' 'evidence'),

    [string[]] $ScopePaths = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Push-Location $RepoPath
try {
    # Build the diff command
    $diffArgs = @('diff', '--unified=5')
    if ($ScopePaths.Count -gt 0) {
        $diffArgs += '--'
        $diffArgs += $ScopePaths
    }
    if ($CommitRange) {
        $diffArgs = @('diff', '--unified=5', $CommitRange) + ($ScopePaths.Count -gt 0 ? @('--') + $ScopePaths : @())
    }
    else {
        # Staged + unstaged
        $diffArgs = @('diff', 'HEAD', '--unified=5') + ($ScopePaths.Count -gt 0 ? @('--') + $ScopePaths : @())
    }

    $diffOutput = & git @diffArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git diff failed: $diffOutput"
    }

    $diffText = $diffOutput -join "`n"
    if ([string]::IsNullOrWhiteSpace($diffText)) {
        Write-Host 'No changes to feed.'
        return
    }

    # Get the list of changed files
    $changedFilesArgs = @('diff', '--name-only')
    if ($CommitRange) {
        $changedFilesArgs = @('diff', '--name-only', $CommitRange)
    }
    else {
        $changedFilesArgs = @('diff', '--name-only', 'HEAD')
    }
    if ($ScopePaths.Count -gt 0) {
        $changedFilesArgs += '--'
        $changedFilesArgs += $ScopePaths
    }
    $changedFiles = @(& git @changedFilesArgs 2>&1 | Where-Object { $_ -match '\S' })

    if ($changedFiles.Count -eq 0) {
        Write-Host 'No changed files in scope.'
        return
    }

    # Ensure output directory exists
    if (-not (Test-Path $OutputDir)) {
        $null = New-Item -ItemType Directory -Path $OutputDir -Force
    }

    $timestamp = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $packetId = 'evidence-' + ([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))

    # Build observations from the diff
    $observations = [System.Collections.Generic.List[object]]::new()
    $currentFile = $null
    $currentHunk = [System.Text.StringBuilder]::new()

    foreach ($line in ($diffText -split "`n")) {
        if ($line -match '^diff --git') {
            # Flush previous file's hunk
            if ($null -ne $currentFile -and $currentHunk.Length -gt 0) {
                $observations.Add([pscustomobject][ordered]@{
                        id       = "obs-$($observations.Count + 1)-$($currentFile -replace '[^a-zA-Z0-9]','-')"
                        source   = "git-diff"
                        location = $currentFile
                        content  = $currentHunk.ToString()
                        digest   = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($currentHunk.ToString()))) -Algorithm SHA256).Hash.ToLowerInvariant()
                    })
                $currentHunk = [System.Text.StringBuilder]::new()
            }
            $currentFile = ($line -replace '^diff --git a/', '' -replace ' b/.*$', '')
        }
        elseif ($line -match '^@@') {
            # Flush previous hunk within same file
            if ($currentHunk.Length -gt 0) {
                $observations.Add([pscustomobject][ordered]@{
                        id       = "obs-$($observations.Count + 1)-$($currentFile -replace '[^a-zA-Z0-9]','-')"
                        source   = "git-diff"
                        location = $currentFile
                        content  = $currentHunk.ToString()
                        digest   = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($currentHunk.ToString()))) -Algorithm SHA256).Hash.ToLowerInvariant()
                    })
                $currentHunk = [System.Text.StringBuilder]::new()
            }
            $null = $currentHunk.AppendLine($line)
        }
        else {
            $null = $currentHunk.AppendLine($line)
        }
    }
    # Flush last hunk
    if ($null -ne $currentFile -and $currentHunk.Length -gt 0) {
        $observations.Add([pscustomobject][ordered]@{
                id       = "obs-$($observations.Count + 1)-$($currentFile -replace '[^a-zA-Z0-9]','-')"
                source   = "git-diff"
                location = $currentFile
                content  = $currentHunk.ToString()
                digest   = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($currentHunk.ToString()))) -Algorithm SHA256).Hash.ToLowerInvariant()
            })
    }

    # Build the packet
    $packet = [pscustomobject][ordered]@{
        schemaVersion = '1.0'
        id            = $packetId
        createdAt     = $timestamp
        observations  = @($observations)
        claims        = @()
        impact        = [pscustomobject][ordered]@{
            learnModuleIds             = @()
            fieldGuideResourceIds      = @()
            assessmentQuestionIds      = @()
            instructorPackageModuleIds = @()
        }
        disposition   = 'ready-for-draft'
    }

    # Write the packet
    $packetPath = Join-Path $OutputDir "$packetId.json"
    $packet | ConvertTo-Json -Depth 10 | Set-Content -Path $packetPath -Encoding utf8

    Write-Host "Evidence packet written: $packetPath"
    Write-Host "  Files: $($changedFiles.Count)"
    Write-Host "  Observations: $($observations.Count)"
    Write-Host ""
    Write-Host "To use this evidence with the engineering review brief, add to the brief's sourceChanges:"
    Write-Host "  {"
    Write-Host "    ""evidencePacket"": ""briefs/evidence/$packetId.json"""
    Write-Host "  }"

    return $packetPath
}
finally {
    Pop-Location
}
