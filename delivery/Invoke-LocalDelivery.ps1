#Requires -Version 7.4
<#
.SYNOPSIS
    Local Foundry delivery runner v2. Uses Azure CLI token.
    Handles provider-specific API differences.
#>
param(
    [Parameter(Mandatory)][string] $BriefPath,
    [string] $Endpoint = 'https://aif-studioai-prod-eus-01.services.ai.azure.com',
    [string] $OutputRoot = $null
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

if (-not $OutputRoot) {
    $OutputRoot = Join-Path $PSScriptRoot 'private' 'local-proposals'
}
$null = New-Item -ItemType Directory -Force -Path $OutputRoot

$briefs = Get-Content $BriefPath -Raw | ConvertFrom-Json
if ($briefs -isnot [array]) {
    $briefs = @($briefs)
}
Write-Host "[INFO] Loaded $($briefs.Count) brief(s) from $BriefPath"

Write-Host "[INFO] Getting Azure CLI token..."
$azToken = az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv 2>&1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($azToken)) {
    throw "Failed to get Azure CLI token: $azToken"
}
Write-Host "[INFO] Token acquired."

function Invoke-FoundryChat {
    param(
        [string] $Deployment,
        [string] $SystemPrompt,
        [string] $UserPrompt,
        [int] $MaxTokens = 4096,
        [string] $ProviderFamily = 'OpenAI'
    )

    $messages = @(
        @{ role = 'system'; content = $SystemPrompt }
        @{ role = 'user'; content = $UserPrompt }
    )

    $body = [ordered]@{ messages = $messages }

    # MistralAI doesn't accept max_completion_tokens, uses max_tokens instead
    if ($ProviderFamily -eq 'MistralAI' -or $ProviderFamily -eq 'Mistral AI') {
        $body.max_tokens = $MaxTokens
    }
    else {
        $body.max_completion_tokens = $MaxTokens
    }

    $bodyJson = $body | ConvertTo-Json -Depth 10 -Compress
    $uri = "$Endpoint/openai/deployments/$Deployment/chat/completions?api-version=2024-10-21"

    $headers = @{
        'Authorization' = "Bearer $azToken"
        'Content-Type'  = 'application/json'
    }

    Write-Host "[DEBUG] Calling $Deployment ($ProviderFamily) maxTokens=$MaxTokens..."

    try {
        $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $bodyJson -TimeoutSec 300
    }
    catch {
        $errMsg = $_.Exception.Message
        $errBody = ''
        try { $errBody = $_.ErrorDetails.Message } catch {}
        Write-Host "[ERROR] $Deployment failed: $errMsg"
        if ($errBody) { Write-Host "[ERROR] Body: $errBody" }
        return "[ERROR: $errMsg]"
    }

    if (-not $response.choices -or $response.choices.Count -eq 0) {
        Write-Host "[WARN] ${Deployment}: no choices in response"
        return "[EMPTY RESPONSE]"
    }

    $content = $response.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace($content)) {
        Write-Host "[WARN] ${Deployment}: empty content. Finish reason: $($response.choices[0].finish_reason)"
        return "[EMPTY CONTENT: finish_reason=$($response.choices[0].finish_reason)]"
    }

    return $content
}

# --- Role system prompts
$drafterSystem = @'
You are a DRAFTER. Your job is to produce a complete first draft of the requested content.
Write clearly and accurately. Follow all constraints in the prompt.
Do NOT mark your output as a draft or add meta-commentary. Produce the deliverable itself.
'@

$verifierSystem = @'
You are a VERIFIER. You receive a draft and the original brief. Your job is to check the draft against every acceptance criterion.
List each criterion and state PASS or FAIL with a brief reason.
If any criterion FAILS, state exactly what needs to change.
Do NOT rewrite the draft. Produce only the verification report.
'@

$adversarySystem = @'
You are an ADVERSARY. You receive a draft, its verification report, and the original brief.
Your job is to find weaknesses the verifier missed: factual errors, logical gaps, missing edge cases, unclear explanations, or anything that would confuse the target audience.
Be specific. Name the exact passage and what is wrong with it.
Do NOT rewrite the draft. Produce only the adversary report.
'@

$arbiterSystem = @'
You are an ARBITER. You receive a draft, a verification report, and an adversary report.
Your job is to produce the FINAL version of the content.
Incorporate all valid feedback from both reports. Resolve any conflicts between them.
Produce the complete, final deliverable. Do NOT add meta-commentary or mark it as final.
'@

# --- Execute pipeline for each brief
foreach ($brief in $briefs) {
    $runId = [guid]::NewGuid().ToString()
    $runDir = Join-Path $OutputRoot $runId
    $null = New-Item -ItemType Directory -Force -Path $runDir
    Write-Host "[INFO] Run $runId starting for brief $($brief.id)"
    Write-Host "[INFO] Output: $runDir"

    # Step 1: Drafter
    Write-Host "[INFO] === DRAFTER: $($brief.roles.drafter.deployment) ($($brief.roles.drafter.providerFamily)) ==="
    $draft = Invoke-FoundryChat `
        -Deployment $brief.roles.drafter.deployment `
        -SystemPrompt $drafterSystem `
        -UserPrompt $brief.prompt `
        -MaxTokens ([int]$brief.roles.drafter.maxCompletionTokens) `
        -ProviderFamily $brief.roles.drafter.providerFamily

    $draftLines = if ($draft) { ($draft -split "`n").Count } else { 0 }
    Write-Host "[INFO] Drafter: $draftLines lines"
    $draft | Out-File (Join-Path $runDir '01-draft.md') -Encoding utf8

    if ($draftLines -eq 0 -or $draft.StartsWith('[ERROR:') -or $draft.StartsWith('[EMPTY')) {
        Write-Host "[ERROR] Drafter failed. Aborting pipeline."
        exit 1
    }

    # Step 2: Verifier
    Write-Host "[INFO] === VERIFIER: $($brief.roles.verifier.deployment) ($($brief.roles.verifier.providerFamily)) ==="
    $verifierPrompt = @"
ORIGINAL BRIEF:
$($brief.prompt)

ACCEPTANCE CRITERIA:
$($brief.acceptanceCriteria -join "`n")

DRAFT TO VERIFY:
$draft
"@
    $verification = Invoke-FoundryChat `
        -Deployment $brief.roles.verifier.deployment `
        -SystemPrompt $verifierSystem `
        -UserPrompt $verifierPrompt `
        -MaxTokens ([int]$brief.roles.verifier.maxCompletionTokens) `
        -ProviderFamily $brief.roles.verifier.providerFamily

    $verLines = if ($verification) { ($verification -split "`n").Count } else { 0 }
    Write-Host "[INFO] Verifier: $verLines lines"
    $verification | Out-File (Join-Path $runDir '02-verification.md') -Encoding utf8

    # Step 3: Adversary
    Write-Host "[INFO] === ADVERSARY: $($brief.roles.adversary.deployment) ($($brief.roles.adversary.providerFamily)) ==="
    $adversaryPrompt = @"
ORIGINAL BRIEF:
$($brief.prompt)

DRAFT:
$draft

VERIFICATION REPORT:
$verification
"@
    $adversary = Invoke-FoundryChat `
        -Deployment $brief.roles.adversary.deployment `
        -SystemPrompt $adversarySystem `
        -UserPrompt $adversaryPrompt `
        -MaxTokens ([int]$brief.roles.adversary.maxCompletionTokens) `
        -ProviderFamily $brief.roles.adversary.providerFamily

    $advLines = if ($adversary) { ($adversary -split "`n").Count } else { 0 }
    Write-Host "[INFO] Adversary: $advLines lines"
    $adversary | Out-File (Join-Path $runDir '03-adversary.md') -Encoding utf8

    # Step 4: Arbiter (produces final)
    Write-Host "[INFO] === ARBITER: $($brief.roles.arbiter.deployment) ($($brief.roles.arbiter.providerFamily)) ==="

    # Truncate draft if too large for arbiter context (MistralAI struggles with >32K prompts)
    $draftForArbiter = $draft
    $maxDraftChars = 20000
    if ($draft.Length -gt $maxDraftChars) {
        Write-Host "[WARN] Draft is $($draft.Length) chars, truncating to $maxDraftChars for arbiter"
        $draftForArbiter = $draft.Substring(0, $maxDraftChars) + "`n`n[... DRAFT TRUNCATED - see 01-draft.md for full text ...]"
    }

    $arbiterPrompt = @"
ORIGINAL BRIEF:
$($brief.prompt)

DRAFT:
$draftForArbiter

VERIFICATION REPORT:
$verification

ADVERSARY REPORT:
$adversary

Produce the FINAL version incorporating all valid feedback. Output the complete deliverable.
"@

    Write-Host "[DEBUG] Arbiter prompt size: $($arbiterPrompt.Length) chars"

    $final = Invoke-FoundryChat `
        -Deployment $brief.roles.arbiter.deployment `
        -SystemPrompt $arbiterSystem `
        -UserPrompt $arbiterPrompt `
        -MaxTokens ([int]$brief.roles.arbiter.maxCompletionTokens) `
        -ProviderFamily $brief.roles.arbiter.providerFamily

    $finalLines = if ($final) { ($final -split "`n").Count } else { 0 }
    Write-Host "[INFO] Arbiter: $finalLines lines"
    $final | Out-File (Join-Path $runDir '04-final.md') -Encoding utf8

    # Save metadata
    @{
        runId       = $runId
        briefId     = $brief.id
        startedUtc  = [datetime]::UtcNow.ToString('o')
        deployments = @{
            drafter   = $brief.roles.drafter.deployment
            verifier  = $brief.roles.verifier.deployment
            adversary = $brief.roles.adversary.deployment
            arbiter   = $brief.roles.arbiter.deployment
        }
        stats       = @{
            draftLines     = $draftLines
            verifierLines  = $verLines
            adversaryLines = $advLines
            finalLines     = $finalLines
        }
    } | ConvertTo-Json | Out-File (Join-Path $runDir 'run-metadata.json') -Encoding utf8

    Write-Host "[INFO] === Run $runId complete ==="
    Write-Host "[INFO] Final: $(Join-Path $runDir '04-final.md')"
}  # end foreach brief
