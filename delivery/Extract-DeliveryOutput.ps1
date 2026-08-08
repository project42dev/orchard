#Requires -Version 7.4
<#
.SYNOPSIS
    Parses the arbiter's final output and extracts individual files to the target repo.
#>
param(
    [Parameter(Mandatory)][string] $FinalOutputPath,
    [Parameter(Mandatory)][string] $TargetRepoRoot,
    [Parameter(Mandatory)][string] $ModuleDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$content = Get-Content $FinalOutputPath -Raw

# The arbiter output has sections like:
# ## `supplementary-reading.md`
# ...content...
# ## `lab/README.md`
# ...content...
# ## `diagrams/ai-product-boundary-map.mmd`
# ```mermaid ... ```
# etc.

# Strategy: split on markdown headers that look like file paths
$lines = $content -split "`n"
$currentFile = $null
$currentContent = [System.Collections.Generic.List[string]]::new()
$inCodeBlock = $false
$codeBlockDelim = ''

$files = [ordered]@{}

foreach ($line in $lines) {
    # Detect file headers: # `path/to/file.ext`, ## `path/to/file.ext`, # path/file.ext, or ## path/file.ext
    # File paths contain a dot (extension) or a slash (directory)
    if ($line -match '^#{1,2}\s+(?:`([^`]+)`|([^\s`].*\.[a-zA-Z0-9]+))$') {
        $matchedFile = if ($matches[1]) { $matches[1] } else { $matches[2] }
        # Save previous file
        if ($currentFile -and $currentContent.Count -gt 0) {
            $text = ($currentContent -join "`n").Trim()
            if ($text) {
                $files[$currentFile] = $text
            }
        }
        $currentFile = $matchedFile
        $currentContent = [System.Collections.Generic.List[string]]::new()
        $inCodeBlock = $false
        continue
    }

    # Skip the horizontal rule separators
    if ($line -eq '---' -and $currentContent.Count -eq 0) {
        continue
    }

    if ($currentFile) {
        # Handle code blocks - extract content without the fences
        if ($line -match '^```(\w*)') {
            if (-not $inCodeBlock) {
                $inCodeBlock = $true
                $codeBlockDelim = $line
                continue
            }
            else {
                $inCodeBlock = $false
                continue
            }
        }
        $currentContent.Add($line)
    }
}

# Save last file
if ($currentFile -and $currentContent.Count -gt 0) {
    $text = ($currentContent -join "`n").Trim()
    if ($text) {
        $files[$currentFile] = $text
    }
}

# Write files
$moduleDir = Join-Path $TargetRepoRoot 'content' 'training' 'ai-foundations' $ModuleDir
Write-Host "[INFO] Writing $($files.Count) files to $moduleDir"

foreach ($kv in $files.GetEnumerator()) {
    $relPath = $kv.Key
    $fileContent = $kv.Value

    $fullPath = Join-Path $moduleDir $relPath
    $dir = Split-Path $fullPath -Parent
    if (-not (Test-Path $dir)) {
        $null = New-Item -ItemType Directory -Force -Path $dir
    }

    $fileContent | Out-File $fullPath -Encoding utf8 -NoNewline
    Write-Host "[INFO] Wrote $fullPath ($($fileContent.Length) chars)"
}

Write-Host "[INFO] Done. $($files.Count) files extracted."
