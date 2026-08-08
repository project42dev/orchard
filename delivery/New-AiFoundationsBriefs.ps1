#Requires -Version 7.4
<#
.SYNOPSIS
    Generates delivery briefs for all AI Foundations modules that need enrichment.
#>
param(
    [Parameter(Mandatory)][string] $PlatformRoot,
    [Parameter(Mandatory)][string] $BriefsOutputDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$null = New-Item -ItemType Directory -Force -Path $BriefsOutputDir

$trainingDir = Join-Path $PlatformRoot 'content' 'training' 'ai-foundations'
$modules = Get-ChildItem $trainingDir -Directory | Where-Object {
    $modName = $_.Name
    # Skip module 1 (already done) and any that already have enrichment
    $hasSuppl = Test-Path (Join-Path $_.FullName 'supplementary-reading.md')
    -not $hasSuppl
}

Write-Host "[INFO] Found $($modules.Count) modules needing enrichment"

$moduleIndex = 2
foreach ($mod in $modules) {
    $modName = $mod.Name
    $scriptPath = Join-Path $mod.FullName 'class-script.json'

    if (-not (Test-Path $scriptPath)) {
        Write-Host "[WARN] No class-script.json for $modName, skipping"
        continue
    }

    $script = Get-Content $scriptPath -Raw | ConvertFrom-Json
    $title = $script.title
    $objectives = $script.learningObjectives -join '; '

    # Determine if this module has coding workflow
    $hasCodeWorkflow = $modName -match 'coding|writing|safe-tool'
    $codeSection = if ($hasCodeWorkflow) {
        "5. CODE SAMPLES (examples/): Provide working code examples that demonstrate the module's concepts. Include setup instructions, the code itself with comments, expected output, and common pitfalls."
    } else {
        "5. CODE SAMPLES (examples/README.md): State that this module is conceptual and has no code exercises. Point to modules 13-15 for coding workflows."
    }

    $brief = @{
        id = "p42-ai-foundations-enrichment-module-$moduleIndex"
        prompt = @"
Create enrichment content for the AI Foundations module "$modName" ($title). The module's class script already exists at content/training/ai-foundations/$modName/class-script.json. Read it as your primary source.

Learning objectives: $objectives

Produce FIVE deliverables:

1. SUPPLEMENTARY READING (supplementary-reading.md): 500-1,000 words of discussion text the learner reads between video segments. NOT a repeat of the script. Expand on the concepts from the learning objectives. Write for a beginner audience.

2. LAB (lab/README.md): A hands-on exercise with objective, prerequisites, step-by-step instructions, expected output, and troubleshooting. The learner should apply the module's concepts to a real scenario. Every step that can fail must carry a remediation path.

3. DIAGRAMS (diagrams/): Two to four Mermaid .mmd files that visualize the module's key concepts. Each must be syntactically valid and render without a legend. Use clear node labels and directional flow.

4. VISUAL ASSETS (images/): SVG files derived from the visual descriptions in the class script segments. Each segment with a "visual" object needs an SVG. Use the Project 42 brand colors: navy #0b1225, lime #c9f25f, cyan #63d7e4, orange #ff8c5a, violet #a99df7, paper #f6f3eb. Include altText-equivalent descriptions as SVG comments.

$codeSection

Constraints:
- Do not invent tool names, version numbers, or configuration keys.
- Write for beginner level.
- Every lab step that can fail must carry a remediation path.
- Mermaid sources must be syntactically valid and render without a legend.
- SVGs must include altText-equivalent descriptions as comments.
- Supplementary reading must expand on (not repeat) the class script.
"@
        acceptanceCriteria = @(
            "Supplementary reading is 500-1000 words and expands on (not repeats) the class script.",
            "Lab has objective, prerequisites, step-by-step instructions, expected output, and troubleshooting.",
            "Mermaid .mmd files are syntactically valid.",
            "SVGs use Project 42 brand colors and derive from class-script.json visual descriptions.",
            "No invented tool names, version numbers, or configuration keys.",
            "All content is at beginner level."
        )
        roles = @{
            drafter = @{
                deployment = "gpt-5-6-luna"
                providerFamily = "OpenAI"
                maxCompletionTokens = 16384
            }
            verifier = @{
                deployment = "grok-4-20-reasoning"
                providerFamily = "xAI"
                maxCompletionTokens = 8192
            }
            adversary = @{
                deployment = "deepseek-v4-pro"
                providerFamily = "DeepSeek"
                maxCompletionTokens = 8192
            }
            arbiter = @{
                deployment = "mistral-large-3"
                providerFamily = "Mistral AI"
                maxCompletionTokens = 8192
            }
        }
        targets = @(
            @{
                repository = "project42dev/project42-platform"
                pathPrefixes = @(
                    "content/training/ai-foundations/$modName/"
                )
            }
        )
    }

    $briefPath = Join-Path $BriefsOutputDir "ai-foundations-enrichment-module-$moduleIndex.json"
    $brief | ConvertTo-Json -Depth 10 | Out-File $briefPath -Encoding utf8
    Write-Host "[INFO] Created brief: $briefPath ($modName)"

    $moduleIndex++
}

Write-Host "[INFO] Done. Created $($moduleIndex - 2) briefs."
