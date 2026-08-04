#Requires -Version 7.0

<#
.SYNOPSIS
    Deterministic source-change detection for the Project 42 currency engine.

.DESCRIPTION
    Feature 5135. Designed by ADR-0015 (source-change detection). This module
    answers one question per watched URL: did the normalized content change
    since the last time we looked. It returns digests and metadata. It does not
    fetch on a schedule, does not call a model, does not write content, and does
    not edit the source registry.

    The public contract, which engine mode is coded against:

        Get-Project42SourceChangeSet
            -RegistryPath   <path to source-registry.json>
            -CheckpointPath <path to *.checkpoint.private.json>
            [-FetchDelegate <scriptblock>]
            [-Force]
            [-DeferChangeCommit]

    Results are written to the pipeline in registry order, so a caller that
    needs a countable collection writes @(Get-Project42SourceChangeSet ...).
    Every returned object carries at least these six properties:

        sourceId        registry id of the governing source entry
        url             the absolute https URL that was fetched
        state           unchanged | changed | unreachable
        previousDigest  stored SHA-256 digest, or $null when none is held
        currentDigest   SHA-256 digest computed this run, or $null when the
                        fetch failed
        checkedAt       ISO 8601 UTC timestamp of this check

    Additional properties (publisher, trustTier, owner, reviewCadenceDays,
    fetchIntervalDays, normalizationVersion, baseline, rebaselined, escalated,
    consecutiveFailures, statusCode, reason, excerpt, excerptTruncated,
    excerptProvenance, changeCommitted, pendingDigest) are additive and may be
    ignored by a caller that only needs the six.

    Two-phase change commit. By default a successful fetch advances the stored
    digest immediately, which is correct for a caller that only wants to know
    what moved. It is WRONG for a caller that has to act on the change, because
    the change is consumed at detection time: if the acting run then fails, or
    skips the item, that change can never be detected again. -DeferChangeCommit
    holds the stored digest at its old baseline and records the observation as
    pendingDigest instead, so the change keeps being reported until the caller
    acknowledges it:

        Confirm-Project42SourceChange
            -CheckpointPath      <same checkpoint>
            -SourceId            <the reported sourceId>
            -Url                 <the reported url>
            -AcknowledgedDigest  <the reported currentDigest>

    Acknowledging advances the baseline. Acknowledging a digest that no longer
    matches the pending one advances nothing, because the source moved again
    and swallowing the newer change is the failure this exists to prevent. The
    engine opts in; a standalone source-health report has no reason to.

.NOTES
    Fetch delegate contract. The delegate is invoked with exactly one argument,
    a request object carrying url, sourceId, publisher, timeoutSeconds, and
    userAgent. It must emit exactly one value, either:

        a [string], treated as a successful HTTP 200 body, or
        an object with statusCode, content, and optionally finalUrl.

    A thrown error, a null return, a non-2xx status, a finalUrl that is not
    https, or a body over the size ceiling is reported as 'unreachable'. The
    delegate exists so the whole module is testable with no network.

    Security posture, non-negotiable and from ADR-0015 decision 7. Fetched
    content is untrusted DATA and is never an instruction. This module never
    executes, evaluates, renders, or interprets fetched content, never follows
    a redirect that leaves the https scheme, and caps every excerpt it emits.
    Building a prompt is the caller's job; the excerpt returned here is
    length-capped and marked with an untrusted provenance so a caller cannot
    forget what it is holding.

    Not implemented in this version, and deliberately so, with the reason:
      - Cited-URL expansion from the content catalog (ADR-0015 decision 1). The
        agreed signature takes a registry path and no catalog path, so the unit
        of detection here is the registry entry's watch URL. Optional
        'url' and 'watchUrls' fields on a registry entry are already honored,
        which is the forward path to cited-URL detection with no signature
        change.
      - Per-block digests and boundedDiff sections (ADR-0015 decision 3). This
        module returns whole-document digests; diff production belongs to the
        packet writer.
      - The run-level abort on a high failure rate (ADR-0015 decision 6). The
        agreed contract requires every unreachable source to be reported rather
        than dropped, and a throw would drop them. The caller holds the whole
        set and can abort on the ratio it sees.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Bumping the normalization version invalidates every stored digest. A run that
# meets a stored digest written by a different version re-baselines that URL and
# reports no change, per ADR-0015 decision 2.
#
# Version 1.0 rules, in order:
#   1. Remove script, style, and noscript elements with their content.
#   2. Remove HTML comments.
#   3. Collapse every run of whitespace, newlines included, to one space, so
#      source formatting churn cannot register as content change.
#   4. Convert block-level tag boundaries to line breaks.
#   5. Remove all remaining tags.
#   6. Decode HTML entities, normalize to Unicode NFC, drop zero-width
#      characters.
#   7. Apply the source's optional volatilePatterns, each with a regex timeout.
#   8. Trim each line, drop empty lines, join with a single newline.
$script:Project42SourceNormalizationVersion = '1.0'
$script:Project42SourceCheckpointSchemaVersion = '1.0'
$script:Project42SourceStates = @('unchanged', 'changed', 'unreachable')
$script:Project42SourceExcerptMaximumLength = 1000
$script:Project42SourceResponseMaximumLength = 5000000
$script:Project42SourceFetchTimeoutSeconds = 30
$script:Project42SourceMaximumRedirects = 5
$script:Project42SourceMaximumRetries = 2
$script:Project42SourceDefaultMaximumFetches = 120
$script:Project42SourceRegexTimeout = [timespan]::FromSeconds(2)
$script:Project42SourceUserAgent = (
    'Project42-SourceChangeDetector/1.0 ' +
    '(+https://project-42.dev; content currency monitor; read only)'
)
$script:Project42SourceIdPattern = '^[a-z0-9][a-z0-9._-]{2,127}$'
$script:Project42SourceTimestampFormat = 'yyyy-MM-ddTHH:mm:ss.fffZ'
$script:Project42SourceBlockTagPattern = (
    '(?is)</?(?:p|div|li|ul|ol|dl|dt|dd|h[1-6]|br|hr|tr|td|th|table|thead|' +
    'tbody|section|article|aside|main|header|footer|nav|figure|figcaption|' +
    'blockquote|pre|form|fieldset|details|summary)\b[^>]*>'
)

function New-Project42SourceNormalizer {
    <#
        Compiles one built-in normalization rule with the same two second regex
        timeout the declared volatilePatterns already carry.

        The timeout is not decoration. Two of these rules are lazy quantifiers
        that degrade quadratically against input engineered to open an element
        or a comment and never close it, and a document may be up to five
        million characters. The detector runs before any caller-side ceiling
        exists, so an unbounded match here is CPU a crafted page can spend for
        free. -replace takes no timeout, which is why every rule is compiled
        here instead.

        Constructed once at import so a sixty-source run pays the compilation
        cost once rather than per document.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Compiles and returns an in-memory rule only.'
    )]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Label,

        [Parameter(Mandatory)]
        [string] $Pattern,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Replacement
    )

    return [pscustomobject][ordered]@{
        label = $Label
        expression = [regex]::new(
            $Pattern,
            # IgnoreCase matches what -replace did here by default, so
            # compiling these changes only the timeout, never the match set.
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase,
            $script:Project42SourceRegexTimeout
        )
        replacement = $Replacement
    }
}

# Used twice: once to collapse formatting churn before any line structure
# exists, and once per line at the end. Linear rather than backtracking, but it
# carries the same timeout as every other rule so no normalization path is
# unbounded.
$script:Project42SourceWhitespaceRun = [regex]::new(
    '\s+',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase,
    $script:Project42SourceRegexTimeout
)

# The built-in rules, in the order section 1 to 5 of the normalization contract
# applies them. Inline flags are kept in the patterns so a reviewer reads the
# same expression that is compiled.
$script:Project42SourceNormalizers = @(
    (New-Project42SourceNormalizer -Label 'script element' `
        -Pattern '(?is)<script\b[^>]*>.*?</script\s*>' -Replacement ' '),
    (New-Project42SourceNormalizer -Label 'style element' `
        -Pattern '(?is)<style\b[^>]*>.*?</style\s*>' -Replacement ' '),
    (New-Project42SourceNormalizer -Label 'noscript element' `
        -Pattern '(?is)<noscript\b[^>]*>.*?</noscript\s*>' -Replacement ' '),
    (New-Project42SourceNormalizer -Label 'unterminated script or style element' `
        -Pattern '(?is)<(?:script|style|noscript)\b[^>]*>.*$' -Replacement ' '),
    (New-Project42SourceNormalizer -Label 'HTML comment' `
        -Pattern '(?s)<!--.*?-->' -Replacement ' '),
    ([pscustomobject][ordered]@{
        label = 'whitespace run'
        expression = $script:Project42SourceWhitespaceRun
        replacement = ' '
    }),
    (New-Project42SourceNormalizer -Label 'block tag boundary' `
        -Pattern $script:Project42SourceBlockTagPattern -Replacement "`n"),
    (New-Project42SourceNormalizer -Label 'residual tag' `
        -Pattern '(?s)<[^>]*>' -Replacement ' ')
)

function Assert-Project42SourceCondition {
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

function Get-Project42SourceProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [psobject] $InputObject,

        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter()]
        [AllowNull()]
        [object] $Default = $null
    )

    if ($null -eq $InputObject) {
        return $Default
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) {
        return $Default
    }
    return $property.Value
}

function Get-Project42SourceTimestamp {
    [CmdletBinding()]
    param(
        [Parameter()]
        [DateTimeOffset] $Value = [DateTimeOffset]::UtcNow
    )

    return $Value.ToUniversalTime().ToString(
        $script:Project42SourceTimestampFormat
    )
}

function ConvertTo-Project42SourceInstant {
    <#
        Reads a stored timestamp back as an unambiguous UTC instant.

        This is not defensive padding. ConvertFrom-Json converts an ISO 8601
        string into a [datetime] on its own, and a checkpoint written on a UTC
        container and read on a machine in another zone would otherwise be off
        by that zone's offset, which is enough to fire or suppress a one day
        fetch interval incorrectly. Returns $null when the value cannot be read
        as an instant, and the caller then treats the source as due.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Value
    )

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [DateTimeOffset]) {
        return $Value.ToUniversalTime()
    }
    if ($Value -is [datetime]) {
        $moment = [datetime] $Value
        if ($moment.Kind -eq [System.DateTimeKind]::Unspecified) {
            $moment = [datetime]::SpecifyKind($moment, [System.DateTimeKind]::Utc)
        }
        return ([DateTimeOffset]::new($moment)).ToUniversalTime()
    }

    $text = [string] $Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    $parsed = [DateTimeOffset]::MinValue
    $styles = (
        [System.Globalization.DateTimeStyles]::RoundtripKind -bor
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
        [System.Globalization.DateTimeStyles]::AdjustToUniversal
    )
    if ([DateTimeOffset]::TryParse(
            $text, [cultureinfo]::InvariantCulture, $styles, [ref] $parsed)) {
        return $parsed.ToUniversalTime()
    }
    return $null
}

function Get-Project42SourceDigest {
    <#
        SHA-256, lowercase hexadecimal, over the UTF-8 bytes of the normalized
        projection. Decided by content-change-packet.schema.json, whose digest
        pattern ^[a-f0-9]{64}$ admits nothing else (ADR-0015 decision 3).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Value
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData($bytes)
    ).ToLowerInvariant()
}

function ConvertTo-Project42NormalizedSourceText {
    <#
        The normalized projection that is digested. Fetched markup is treated
        as inert text throughout: nothing here evaluates, expands, or executes
        any part of the input.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Content,

        [Parameter()]
        [AllowEmptyCollection()]
        [string[]] $VolatilePattern = @()
    )

    $text = $Content

    # Rules 1 to 5, every one of them time-bounded. In order:
    #   1. Executable and presentational elements never contribute to the
    #      digest. A page whose only movement is a build id inside a script tag
    #      has not changed any fact.
    #      An unterminated script or style element runs to the end of the
    #      document in every browser, so truncating there is the safe
    #      direction: it can never leak script text into the projection.
    #   2. Comments, including conditional comments.
    #   3. Source formatting churn dies here, before any line structure exists.
    #   4. Block boundaries become the only line breaks in the projection.
    #   5. Everything else that looks like markup becomes a space.
    foreach ($normalizer in $script:Project42SourceNormalizers) {
        try {
            $text = $normalizer.expression.Replace($text, $normalizer.replacement)
        }
        catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
            throw (
                'A built-in normalization pattern timed out against fetched ' +
                "content: $($normalizer.label). The document is either " +
                'pathological or engineered; it is refused rather than ' +
                'digested from a partial projection.'
            )
        }
    }

    # 6. Entities, Unicode form, and invisible characters. The invisible set is
    #    zero-width space, non-joiner, and joiner, plus the word joiner and the
    #    byte order mark, written as code points so no reviewer has to trust
    #    that an unreadable character in this file is the one it claims to be.
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text.Normalize([System.Text.NormalizationForm]::FormC)
    $invisible = [char[]] @(0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF)
    $text = ($text.Split($invisible, [System.StringSplitOptions]::None) -join '')

    # 7. Declared volatile regions. Every pattern is a deliberate blind spot and
    #    ADR-0015 decision 2 requires a recorded reason for each one. The regex
    #    timeout bounds a pathological pattern meeting adversarial content.
    foreach ($pattern in @($VolatilePattern)) {
        if ([string]::IsNullOrWhiteSpace($pattern)) {
            continue
        }
        try {
            $expression = [regex]::new(
                $pattern,
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase,
                $script:Project42SourceRegexTimeout
            )
            $text = $expression.Replace($text, ' ')
        }
        catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
            throw "A volatile pattern timed out against fetched content: $pattern"
        }
        catch {
            throw "A volatile pattern is not a valid regular expression: $pattern"
        }
    }

    # 8. One block per line, no leading, trailing, or empty lines.
    try {
        $lines = @(
            $text -split "`n" |
                ForEach-Object {
                    $script:Project42SourceWhitespaceRun.Replace($_, ' ').Trim()
                } |
                Where-Object { $_.Length -gt 0 }
        )
    }
    catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
        throw (
            'A built-in normalization pattern timed out against fetched ' +
            'content: line whitespace run.'
        )
    }
    return ($lines -join "`n")
}

function Get-Project42SourceExcerpt {
    <#
        Bounded, provenance-labelled evidence. The cap matches the packet
        schema's claim.evidence.excerpt maxLength of 1,000 characters. Whole
        fetched documents never leave this module.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Value,

        [Parameter()]
        [int] $MaximumLength = $script:Project42SourceExcerptMaximumLength
    )

    Assert-Project42SourceCondition `
        -Condition ($MaximumLength -gt 0) `
        -Message 'An excerpt cap must be a positive length.'

    $truncated = $Value.Length -gt $MaximumLength
    $text = if ($truncated) {
        $Value.Substring(0, $MaximumLength)
    }
    else {
        $Value
    }

    return [pscustomobject][ordered]@{
        text = $text
        truncated = $truncated
        maximumLength = $MaximumLength
        provenance = 'untrusted'
    }
}

function Get-Project42SourceFetchInterval {
    <#
        reviewCadenceDays is a human review obligation, not a polling interval.
        The fetch interval is derived from it and never configured separately
        (ADR-0015 decision 5): max(1, floor(reviewCadenceDays / 30)) days.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int] $ReviewCadenceDays
    )

    Assert-Project42SourceCondition `
        -Condition ($ReviewCadenceDays -gt 0) `
        -Message 'reviewCadenceDays must be a positive number of days.'

    $interval = [int][Math]::Floor([double] $ReviewCadenceDays / 30.0)
    if ($interval -lt 1) {
        $interval = 1
    }
    return $interval
}

function Read-Project42SourceRegistry {
    <#
        Reads and validates content/source-registry.json. The registry is a
        trusted, repository-controlled file, so a defect in it fails the run
        rather than being skipped.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    Assert-Project42SourceCondition `
        -Condition (Test-Path -LiteralPath $Path -PathType Leaf) `
        -Message "The source registry was not found: $Path"

    try {
        $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 50
    }
    catch {
        throw "The source registry is not valid JSON: $Path"
    }

    Assert-Project42SourceCondition `
        -Condition (
            [string] (Get-Project42SourceProperty `
                -InputObject $document -Name 'schemaVersion') -eq '1.0'
        ) `
        -Message 'The source registry schema version is unsupported.'

    $entries = @(Get-Project42SourceProperty `
        -InputObject $document -Name 'sources' -Default @())
    Assert-Project42SourceCondition `
        -Condition ($entries.Count -gt 0) `
        -Message 'The source registry contains no sources.'

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $sources = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $entries) {
        $id = [string] (Get-Project42SourceProperty -InputObject $entry -Name 'id')
        Assert-Project42SourceCondition `
            -Condition ($id -match $script:Project42SourceIdPattern) `
            -Message "A source id is not a stable lowercase identifier: $id"
        Assert-Project42SourceCondition `
            -Condition ($seen.Add($id)) `
            -Message "The source registry contains duplicate id $id."

        $prefix = [string] (Get-Project42SourceProperty `
            -InputObject $entry -Name 'urlPrefix')
        Assert-Project42SourceCondition `
            -Condition ($prefix.StartsWith('https://')) `
            -Message "Source $id must declare an https urlPrefix."

        $publisher = [string] (Get-Project42SourceProperty `
            -InputObject $entry -Name 'publisher')
        Assert-Project42SourceCondition `
            -Condition (-not [string]::IsNullOrWhiteSpace($publisher)) `
            -Message "Source $id requires a publisher."

        $trustTier = [string] (Get-Project42SourceProperty `
            -InputObject $entry -Name 'trustTier')
        Assert-Project42SourceCondition `
            -Condition (-not [string]::IsNullOrWhiteSpace($trustTier)) `
            -Message "Source $id requires a trust tier."

        $owner = [string] (Get-Project42SourceProperty `
            -InputObject $entry -Name 'owner')
        Assert-Project42SourceCondition `
            -Condition (-not [string]::IsNullOrWhiteSpace($owner)) `
            -Message "Source $id requires an owner."

        $cadenceValue = Get-Project42SourceProperty `
            -InputObject $entry -Name 'reviewCadenceDays'
        $cadence = 0
        Assert-Project42SourceCondition `
            -Condition (
                $null -ne $cadenceValue -and
                [int]::TryParse([string] $cadenceValue, [ref] $cadence) -and
                $cadence -gt 0
            ) `
            -Message "Source $id requires a positive reviewCadenceDays."

        # The unit of detection. ADR-0015 decision 1 makes it the cited URL;
        # the registry alone cannot supply citations, so the watch list is the
        # entry's explicit urls when it has them and the prefix otherwise.
        $watchUrls = @(
            Get-Project42SourceProperty -InputObject $entry -Name 'watchUrls' -Default @()
        )
        if ($watchUrls.Count -eq 0) {
            $single = [string] (Get-Project42SourceProperty `
                -InputObject $entry -Name 'url' -Default '')
            $watchUrls = if ([string]::IsNullOrWhiteSpace($single)) {
                @($prefix)
            }
            else {
                @($single)
            }
        }
        foreach ($watchUrl in $watchUrls) {
            Assert-Project42SourceCondition `
                -Condition ([string] $watchUrl -match '^https://\S+$') `
                -Message "Source $id declares a watch URL that is not https: $watchUrl"
        }

        $volatilePatterns = @(
            Get-Project42SourceProperty `
                -InputObject $entry -Name 'volatilePatterns' -Default @()
        )

        $sources.Add([pscustomobject][ordered]@{
            id = $id
            urlPrefix = $prefix
            publisher = $publisher
            trustTier = $trustTier
            reviewCadenceDays = $cadence
            owner = $owner
            watchUrls = @($watchUrls | ForEach-Object { [string] $_ })
            volatilePatterns = @($volatilePatterns | ForEach-Object { [string] $_ })
            fetchIntervalDays = (
                Get-Project42SourceFetchInterval -ReviewCadenceDays $cadence
            )
        })
    }

    return [pscustomobject][ordered]@{
        schemaVersion = '1.0'
        path = $Path
        sourceCount = $sources.Count
        watchUrlCount = @($sources | ForEach-Object { $_.watchUrls }).Count
        sources = @($sources)
    }
}

function Initialize-Project42SourceCheckpointEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $SourceId,

        [Parameter(Mandatory)]
        [string] $Url
    )

    return [pscustomobject][ordered]@{
        sourceId = $SourceId
        url = $Url
        normalizationVersion = $null
        digest = $null
        pendingDigest = $null
        pendingObservedAt = $null
        lastCheckedAt = $null
        lastChangedAt = $null
        lastFailureAt = $null
        consecutiveFailures = 0
        escalated = $false
    }
}

function Read-Project42SourceCheckpoint {
    <#
        Absent is a clean first run. Corrupt is not: a checkpoint that cannot be
        read is an operator problem, and silently re-baselining sixty sources
        would hide the data loss instead of reporting it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            schemaVersion = $script:Project42SourceCheckpointSchemaVersion
            normalizationVersion = $script:Project42SourceNormalizationVersion
            updatedAt = $null
            sources = @()
        }
    }

    try {
        $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 50
    }
    catch {
        throw "The source-detection checkpoint is not valid JSON: $Path"
    }

    Assert-Project42SourceCondition `
        -Condition (
            [string] (Get-Project42SourceProperty `
                -InputObject $document -Name 'schemaVersion') -eq
            $script:Project42SourceCheckpointSchemaVersion
        ) `
        -Message 'The source-detection checkpoint schema version is unsupported.'

    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(Get-Project42SourceProperty `
            -InputObject $document -Name 'sources' -Default @())) {
        $sourceId = [string] (Get-Project42SourceProperty `
            -InputObject $entry -Name 'sourceId')
        $url = [string] (Get-Project42SourceProperty -InputObject $entry -Name 'url')
        Assert-Project42SourceCondition `
            -Condition (
                -not [string]::IsNullOrWhiteSpace($sourceId) -and
                -not [string]::IsNullOrWhiteSpace($url)
            ) `
            -Message 'A checkpoint entry is missing its source id or URL.'

        $digest = Get-Project42SourceProperty -InputObject $entry -Name 'digest'
        $pendingDigest = Get-Project42SourceProperty `
            -InputObject $entry -Name 'pendingDigest'
        foreach ($storedDigest in @($digest, $pendingDigest)) {
            if ($null -ne $storedDigest) {
                Assert-Project42SourceCondition `
                    -Condition ([string] $storedDigest -match '^[a-f0-9]{64}$') `
                    -Message "Checkpoint entry $sourceId holds a malformed digest."
            }
        }

        $failures = 0
        $null = [int]::TryParse(
            [string] (Get-Project42SourceProperty `
                -InputObject $entry -Name 'consecutiveFailures' -Default 0),
            [ref] $failures
        )

        # Canonicalize the timestamps on the way in. ConvertFrom-Json will have
        # turned them into [datetime] values already, and only an explicit
        # instant is safe to do interval arithmetic against.
        $storedTimestamps = @{}
        foreach ($field in @(
            'lastCheckedAt', 'lastChangedAt', 'lastFailureAt', 'pendingObservedAt'
        )) {
            $instant = ConvertTo-Project42SourceInstant -Value (
                Get-Project42SourceProperty -InputObject $entry -Name $field
            )
            $storedTimestamps[$field] = if ($null -eq $instant) {
                $null
            }
            else {
                Get-Project42SourceTimestamp -Value $instant
            }
        }

        $entries.Add([pscustomobject][ordered]@{
            sourceId = $sourceId
            url = $url
            normalizationVersion = Get-Project42SourceProperty `
                -InputObject $entry -Name 'normalizationVersion'
            digest = $digest
            pendingDigest = $pendingDigest
            pendingObservedAt = $storedTimestamps['pendingObservedAt']
            lastCheckedAt = $storedTimestamps['lastCheckedAt']
            lastChangedAt = $storedTimestamps['lastChangedAt']
            lastFailureAt = $storedTimestamps['lastFailureAt']
            consecutiveFailures = $failures
            escalated = [bool] (Get-Project42SourceProperty `
                -InputObject $entry -Name 'escalated' -Default $false)
        })
    }

    return [pscustomobject][ordered]@{
        schemaVersion = $script:Project42SourceCheckpointSchemaVersion
        normalizationVersion = [string] (Get-Project42SourceProperty `
            -InputObject $document -Name 'normalizationVersion' `
            -Default $script:Project42SourceNormalizationVersion)
        updatedAt = Get-Project42SourceProperty -InputObject $document -Name 'updatedAt'
        sources = @($entries)
    }
}

function Save-Project42SourceCheckpoint {
    <#
        Atomic by construction: the document is serialized in full to a sibling
        temporary file, flushed, and then moved over the destination. An
        interrupted run leaves either the previous checkpoint or the new one,
        never a half-written one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]] $Entry
    )

    $directory = Split-Path -Parent $Path
    Assert-Project42SourceCondition `
        -Condition (
            $directory -and
            (Test-Path -LiteralPath $directory -PathType Container)
        ) `
        -Message 'The private checkpoint directory must already exist.'

    $document = [pscustomobject][ordered]@{
        schemaVersion = $script:Project42SourceCheckpointSchemaVersion
        normalizationVersion = $script:Project42SourceNormalizationVersion
        updatedAt = Get-Project42SourceTimestamp
        sources = @($Entry)
    }

    $temporaryPath = Join-Path $directory (
        (Split-Path -Leaf $Path) + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
    )
    try {
        $json = ConvertTo-Json -InputObject $document -Depth 20
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $json,
            [System.Text.UTF8Encoding]::new($false)
        )
        [System.IO.File]::Move($temporaryPath, $Path, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }

    return $Path
}

function Invoke-Project42SourceFetch {
    <#
        The default fetch delegate. Read only, https only, bounded redirects,
        bounded retries, fixed Accept-Language, declared user agent. A redirect
        that leaves the https scheme is refused rather than followed, and TLS
        verification is never disabled (threat model T5).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [psobject] $Request
    )

    $url = [string] (Get-Project42SourceProperty -InputObject $Request -Name 'url')
    $timeoutSeconds = [int] (Get-Project42SourceProperty `
        -InputObject $Request -Name 'timeoutSeconds' `
        -Default $script:Project42SourceFetchTimeoutSeconds)
    $userAgent = [string] (Get-Project42SourceProperty `
        -InputObject $Request -Name 'userAgent' `
        -Default $script:Project42SourceUserAgent)

    $headers = @{
        'Accept' = 'text/html,application/xhtml+xml,text/plain;q=0.9'
        'Accept-Language' = 'en-US,en;q=0.9'
    }

    $current = $url
    for ($hop = 0; $hop -le $script:Project42SourceMaximumRedirects; $hop += 1) {
        $target = $null
        if (-not [uri]::TryCreate($current, [System.UriKind]::Absolute, [ref] $target)) {
            return [pscustomobject]@{
                statusCode = 0
                content = ''
                finalUrl = $current
                reason = 'the fetch target is not an absolute URL'
            }
        }
        if ($target.Scheme -ne 'https') {
            return [pscustomobject]@{
                statusCode = 0
                content = ''
                finalUrl = $current
                reason = 'the fetch target left the https scheme'
            }
        }

        # -MaximumRedirection 0 and -SkipHttpErrorCheck TOGETHER throw
        # InvalidOperationException ("Operation is not valid due to the current
        # state of the object") on any 3xx, instead of returning the response.
        # That single interaction reported 28 of 29 watched sources as
        # unreachable on the first hosted engine runs, and it looked exactly
        # like the whole internet refusing us. It is not a network condition and
        # it is not bot blocking: it reproduces locally against any URL that
        # redirects, and drops to a clean 200 the moment either switch is
        # removed.
        #
        # -SkipHttpErrorCheck is therefore dropped and the terminating error is
        # caught instead. A 3xx and a 4xx both arrive as exceptions carrying a
        # real HttpResponseMessage, which is where the status and the Location
        # header are read from. Auto-redirect stays OFF: the loop below still
        # resolves every hop itself and still refuses any hop that leaves the
        # https scheme, which is the threat model T5 property that made manual
        # redirect handling necessary in the first place.
        $response = $null
        $errorResponse = $null
        for ($attempt = 0; $attempt -le $script:Project42SourceMaximumRetries; $attempt += 1) {
            $errorResponse = $null
            try {
                $response = Invoke-WebRequest `
                    -Uri $target `
                    -Method Get `
                    -Headers $headers `
                    -UserAgent $userAgent `
                    -MaximumRedirection 0 `
                    -TimeoutSec $timeoutSeconds `
                    -ErrorAction Stop
                break
            }
            catch {
                # A non-2xx that carries a response is an ANSWER, not a
                # transport failure, and must not be retried or reported as one.
                if ($null -ne $_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) {
                    $errorResponse = $_.Exception.Response
                    break
                }
                if ($attempt -eq $script:Project42SourceMaximumRetries) {
                    return [pscustomobject]@{
                        statusCode = 0
                        content = ''
                        finalUrl = $current
                        reason = "transport failure: $($_.Exception.Message)"
                    }
                }
                Start-Sleep -Seconds ([int][Math]::Pow(2, $attempt + 1))
            }
        }

        # Header access differs between the two shapes: a successful
        # Invoke-WebRequest exposes a dictionary, while the exception carries an
        # HttpResponseMessage whose headers are read with TryGetValues.
        $fromError = $null -ne $errorResponse
        $statusCode = if ($fromError) { [int] $errorResponse.StatusCode } else { [int] $response.StatusCode }

        $readHeader = {
            param([string] $Name)
            if ($fromError) {
                $values = $null
                if ($errorResponse.Headers.TryGetValues($Name, [ref] $values)) {
                    return [string] @($values)[0]
                }
                return ''
            }
            if ($response.Headers.ContainsKey($Name)) {
                return [string] @($response.Headers[$Name])[0]
            }
            return ''
        }

        if ($statusCode -ge 300 -and $statusCode -lt 400) {
            $location = [string] (& $readHeader 'Location')
            if ([string]::IsNullOrWhiteSpace($location)) {
                return [pscustomobject]@{
                    statusCode = $statusCode
                    content = ''
                    finalUrl = $current
                    reason = 'a redirect carried no Location header'
                }
            }
            $resolved = $null
            if (-not [uri]::TryCreate($target, $location, [ref] $resolved)) {
                return [pscustomobject]@{
                    statusCode = $statusCode
                    content = ''
                    finalUrl = $current
                    reason = 'a redirect Location could not be resolved'
                }
            }
            $current = $resolved.AbsoluteUri
            continue
        }

        # 429 is deferred to the next run rather than hammered. Retry-After is
        # reported so an operator can see why a source went quiet.
        if ($statusCode -eq 429) {
            $retryAfter = [string] (& $readHeader 'Retry-After')
            return [pscustomobject]@{
                statusCode = $statusCode
                content = ''
                finalUrl = $current
                reason = "rate limited, deferred to the next run (Retry-After: $retryAfter)"
            }
        }

        # A non-2xx that reached us is reported with its status and no content.
        # ConvertTo-Project42SourceResponse treats any non-2xx as unreachable,
        # so the status is what an operator needs and the body is not.
        if ($fromError) {
            return [pscustomobject]@{
                statusCode = $statusCode
                content = ''
                finalUrl = $current
                reason = "HTTP $statusCode"
            }
        }

        return [pscustomobject]@{
            statusCode = $statusCode
            content = [string] $response.Content
            finalUrl = $current
            reason = ''
        }
    }

    return [pscustomobject]@{
        statusCode = 0
        content = ''
        finalUrl = $current
        reason = 'the redirect ceiling was reached'
    }
}

function ConvertTo-Project42SourceResponse {
    <#
        Reduces whatever a delegate emitted to one predictable shape and applies
        every rule that decides reachability before a byte is hashed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object] $Value,

        [Parameter(Mandatory)]
        [string] $RequestedUrl
    )

    $failure = {
        param([string] $Reason, [int] $StatusCode)
        [pscustomobject][ordered]@{
            ok = $false
            statusCode = $StatusCode
            content = ''
            finalUrl = $RequestedUrl
            reason = $Reason
        }
    }

    $candidate = $Value
    if ($candidate -is [System.Array]) {
        $items = @($candidate | Where-Object { $null -ne $_ })
        if ($items.Count -eq 0) {
            return (& $failure 'the fetch delegate returned nothing' 0)
        }
        $candidate = $items[-1]
    }
    if ($null -eq $candidate) {
        return (& $failure 'the fetch delegate returned nothing' 0)
    }

    $statusCode = 200
    $content = ''
    $finalUrl = $RequestedUrl
    $reason = ''

    if ($candidate -is [string]) {
        $content = [string] $candidate
    }
    else {
        $statusValue = Get-Project42SourceProperty `
            -InputObject $candidate -Name 'statusCode'
        $contentValue = Get-Project42SourceProperty `
            -InputObject $candidate -Name 'content'
        if ($null -eq $statusValue -and $null -eq $contentValue) {
            return (& $failure 'the fetch delegate returned an unsupported response shape' 0)
        }
        if ($null -ne $statusValue) {
            $parsed = 0
            if (-not [int]::TryParse([string] $statusValue, [ref] $parsed)) {
                return (& $failure 'the fetch delegate returned a non-numeric status code' 0)
            }
            $statusCode = $parsed
        }
        $content = [string] $contentValue
        $finalUrl = [string] (Get-Project42SourceProperty `
            -InputObject $candidate -Name 'finalUrl' -Default $RequestedUrl)
        $reason = [string] (Get-Project42SourceProperty `
            -InputObject $candidate -Name 'reason' -Default '')
    }

    $resolved = $null
    if (-not [uri]::TryCreate($finalUrl, [System.UriKind]::Absolute, [ref] $resolved)) {
        return (& $failure 'the response reported a URL that is not absolute' $statusCode)
    }
    if ($resolved.Scheme -ne 'https') {
        # Non-negotiable: a redirect that leaves https is a downgrade, and a
        # downgraded response is not evidence about anything.
        return (& $failure 'the response left the https scheme' $statusCode)
    }

    if ($statusCode -lt 200 -or $statusCode -ge 300) {
        $detail = if ([string]::IsNullOrWhiteSpace($reason)) {
            "HTTP $statusCode"
        }
        else {
            "HTTP $statusCode ($reason)"
        }
        return (& $failure $detail $statusCode)
    }

    if ($content.Length -gt $script:Project42SourceResponseMaximumLength) {
        return (& $failure (
            'the response exceeded the ' +
            "$($script:Project42SourceResponseMaximumLength) character ceiling"
        ) $statusCode)
    }

    return [pscustomobject][ordered]@{
        ok = $true
        statusCode = $statusCode
        content = $content
        finalUrl = $resolved.AbsoluteUri
        reason = $reason
    }
}

function Get-Project42SourceChangeSet {
    <#
    .SYNOPSIS
        Detects which registered sources changed since the last run.

    .DESCRIPTION
        Reads the source registry, applies the derived cadence gate, fetches
        what is due, normalizes and digests it, compares against the stored
        baseline, and persists the checkpoint atomically after each source.

        A source inside its fetch interval is skipped and is absent from the
        returned set, because 'we did not look' is not one of the three states
        and must never be reported as 'unchanged'. -Force checks everything.

        An unreachable source is reported, never dropped, and never overwrites
        the digest it already holds.

    .PARAMETER RegistryPath
        Path to content/source-registry.json.

    .PARAMETER CheckpointPath
        Path to the checkpoint, conventionally
        deployment/content-maintenance/private/source-detection.checkpoint.private.json.
        Its directory must already exist.

    .PARAMETER FetchDelegate
        Optional. Replaces the default HTTP fetch, which is how this module is
        tested with no network. See the module notes for the delegate contract.

    .PARAMETER Force
        Check every watched URL regardless of its fetch interval.

    .PARAMETER DeferChangeCommit
        Hold the stored baseline at its old digest when a change is detected,
        recording the observation as pendingDigest instead, so the change is
        re-reported on every run until Confirm-Project42SourceChange
        acknowledges it. Any caller that ACTS on a change must set this;
        without it the change is consumed the moment it is observed and a
        caller that then fails has destroyed it.

    .OUTPUTS
        Change objects, written to the pipeline in registry order. Nothing is
        written when nothing was due, so a caller that needs a countable
        collection wraps the call:
            $set = @(Get-Project42SourceChangeSet ...)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $RegistryPath,

        [Parameter(Mandatory)]
        [string] $CheckpointPath,

        [Parameter()]
        [scriptblock] $FetchDelegate,

        [Parameter()]
        [switch] $Force,

        [Parameter()]
        [switch] $DeferChangeCommit
    )

    $registry = Read-Project42SourceRegistry -Path $RegistryPath

    $checkpointDirectory = Split-Path -Parent $CheckpointPath
    Assert-Project42SourceCondition `
        -Condition (
            $checkpointDirectory -and
            (Test-Path -LiteralPath $checkpointDirectory -PathType Container)
        ) `
        -Message 'The private checkpoint directory must already exist.'

    $checkpoint = Read-Project42SourceCheckpoint -Path $CheckpointPath
    $entries = [ordered]@{}
    foreach ($entry in @($checkpoint.sources)) {
        $entries["$($entry.sourceId)|$($entry.url)"] = $entry
    }

    $maximumFetches = $script:Project42SourceDefaultMaximumFetches
    $configuredCeiling = $env:MAX_FETCHES_PER_RUN
    if (-not [string]::IsNullOrWhiteSpace($configuredCeiling)) {
        $parsedCeiling = 0
        Assert-Project42SourceCondition `
            -Condition (
                [int]::TryParse($configuredCeiling, [ref] $parsedCeiling) -and
                $parsedCeiling -gt 0
            ) `
            -Message 'MAX_FETCHES_PER_RUN must be a positive integer.'
        $maximumFetches = $parsedCeiling
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $fetchCount = 0
    $ceilingReached = $false

    foreach ($source in @($registry.sources)) {
        if ($ceilingReached) {
            break
        }
        foreach ($url in @($source.watchUrls)) {
            $key = "$($source.id)|$url"
            $entry = if ($entries.Contains($key)) {
                $entries[$key]
            }
            else {
                $null
            }

            $storedDigest = $null
            $storedNormalization = $null
            $escalated = $false
            if ($entry) {
                $storedDigest = $entry.digest
                $storedNormalization = $entry.normalizationVersion
                $escalated = [bool] $entry.escalated
            }

            # A digest written by a different normalizer is not comparable. The
            # run re-baselines and reports no change, so one rule edit cannot
            # produce sixty simultaneous false positives.
            $rebaseline = (
                $null -ne $storedDigest -and
                [string] $storedNormalization -ne $script:Project42SourceNormalizationVersion
            )
            $previousDigest = if ($rebaseline) { $null } else { $storedDigest }

            $intervalDays = if ($escalated) { 1 } else { [int] $source.fetchIntervalDays }
            $lastCheckedAt = $null
            if ($entry) {
                $lastCheckedAt = ConvertTo-Project42SourceInstant `
                    -Value $entry.lastCheckedAt
            }
            # An unreadable or missing last-checked time makes the source due.
            # Erring toward one extra fetch is cheap; erring toward silence is
            # what a currency engine exists to prevent.
            $due = $true
            if (-not $Force -and -not $rebaseline -and $null -ne $lastCheckedAt) {
                $elapsedDays = (
                    [DateTimeOffset]::UtcNow - $lastCheckedAt
                ).TotalDays
                $due = $elapsedDays -ge $intervalDays
            }

            if (-not $due) {
                Write-Verbose (
                    "Skipped $($source.id) ($url): inside its $intervalDays day fetch interval."
                )
                continue
            }

            if ($fetchCount -ge $maximumFetches) {
                Write-Warning (
                    "The fetch ceiling of $maximumFetches was reached. " +
                    'Remaining sources were not checked in this run.'
                )
                $ceilingReached = $true
                break
            }

            if (-not $entry) {
                $entry = Initialize-Project42SourceCheckpointEntry `
                    -SourceId $source.id -Url $url
                $entries[$key] = $entry
            }

            $request = [pscustomobject][ordered]@{
                url = $url
                sourceId = $source.id
                publisher = $source.publisher
                timeoutSeconds = $script:Project42SourceFetchTimeoutSeconds
                userAgent = $script:Project42SourceUserAgent
            }

            $fetchCount += 1
            $checkedAt = [DateTimeOffset]::UtcNow
            $response = $null
            try {
                $raw = if ($FetchDelegate) {
                    & $FetchDelegate $request
                }
                else {
                    Invoke-Project42SourceFetch -Request $request
                }
                $response = ConvertTo-Project42SourceResponse `
                    -Value $raw -RequestedUrl $url
            }
            catch {
                $response = [pscustomobject][ordered]@{
                    ok = $false
                    statusCode = 0
                    content = ''
                    finalUrl = $url
                    reason = "the fetch failed: $($_.Exception.Message)"
                }
            }

            $state = 'unreachable'
            $currentDigest = $null
            $baseline = $false
            $wasRebaselined = $false
            $reason = [string] $response.reason
            $excerpt = $null
            $excerptTruncated = $false
            $changeCommitted = $true

            if (-not $response.ok) {
                # A failure never overwrites a baseline. If it did, the next
                # successful fetch would report a change against the failure.
                $entry.consecutiveFailures = [int] $entry.consecutiveFailures + 1
                $entry.lastFailureAt = Get-Project42SourceTimestamp -Value $checkedAt
                $previousDigest = $storedDigest
                if ([string]::IsNullOrWhiteSpace($reason)) {
                    $reason = 'the source could not be retrieved'
                }
            }
            else {
                $normalized = ConvertTo-Project42NormalizedSourceText `
                    -Content $response.content `
                    -VolatilePattern @($source.volatilePatterns)
                $currentDigest = Get-Project42SourceDigest -Value $normalized

                if ($null -eq $previousDigest) {
                    $state = 'unchanged'
                    $baseline = $true
                    $wasRebaselined = $rebaseline
                    $reason = if ($rebaseline) {
                        'the normalizer version changed, so the baseline was re-recorded'
                    }
                    else {
                        'first observation, baseline recorded'
                    }
                }
                elseif ($previousDigest -eq $currentDigest) {
                    $state = 'unchanged'
                    $reason = 'the normalized digest matches the stored baseline'
                }
                else {
                    $state = 'changed'
                    $reason = 'the normalized digest differs from the stored baseline'
                    $entry.lastChangedAt = Get-Project42SourceTimestamp -Value $checkedAt
                    # A page that just changed is the page most likely to change
                    # again, so it polls daily until a human closes the proposal.
                    $entry.escalated = $true
                    $bounded = Get-Project42SourceExcerpt -Value $normalized
                    $excerpt = $bounded.text
                    $excerptTruncated = $bounded.truncated
                }

                $entry.normalizationVersion = $script:Project42SourceNormalizationVersion
                $entry.lastCheckedAt = Get-Project42SourceTimestamp -Value $checkedAt
                $entry.consecutiveFailures = 0

                if ($state -eq 'changed' -and $DeferChangeCommit) {
                    # Two-phase. The baseline stays where it was, so this change
                    # is reported again on the next run and on every run after
                    # it until the caller acknowledges it. That costs a repeated
                    # proposal when a caller crashes between the fetch and the
                    # acknowledgment, which is the correct direction to fail: a
                    # duplicate proposal is visible and a human throws it away,
                    # whereas a change consumed by a run that then died is
                    # invisible and gone for good.
                    $changeCommitted = $false
                    $entry.pendingDigest = $currentDigest
                    $entry.pendingObservedAt = Get-Project42SourceTimestamp `
                        -Value $checkedAt
                }
                else {
                    $entry.digest = $currentDigest
                    $entry.pendingDigest = $null
                    $entry.pendingObservedAt = $null
                }
            }

            $null = Save-Project42SourceCheckpoint `
                -Path $CheckpointPath `
                -Entry @($entries.Values)

            Assert-Project42SourceCondition `
                -Condition ($script:Project42SourceStates -contains $state) `
                -Message "The detector produced state '$state', which is outside the contract."

            $results.Add([pscustomobject][ordered]@{
                sourceId = [string] $source.id
                url = [string] $url
                state = [string] $state
                previousDigest = $previousDigest
                currentDigest = $currentDigest
                checkedAt = Get-Project42SourceTimestamp -Value $checkedAt
                publisher = [string] $source.publisher
                trustTier = [string] $source.trustTier
                owner = [string] $source.owner
                reviewCadenceDays = [int] $source.reviewCadenceDays
                fetchIntervalDays = [int] $intervalDays
                normalizationVersion = $script:Project42SourceNormalizationVersion
                baseline = [bool] $baseline
                rebaselined = [bool] $wasRebaselined
                escalated = [bool] $entry.escalated
                consecutiveFailures = [int] $entry.consecutiveFailures
                statusCode = [int] $response.statusCode
                reason = [string] $reason
                excerpt = $excerpt
                excerptTruncated = [bool] $excerptTruncated
                excerptProvenance = 'untrusted'
                changeCommitted = [bool] $changeCommitted
                pendingDigest = $entry.pendingDigest
            })
        }
    }

    return $results.ToArray()
}

function Confirm-Project42SourceChange {
    <#
    .SYNOPSIS
        Advances a deferred baseline once the caller has acted on the change.

    .DESCRIPTION
        The second phase of -DeferChangeCommit. Get-Project42SourceChangeSet
        observes and holds; this commits. Until it is called, the change keeps
        being reported, which is what makes a change impossible to lose to a run
        that died or skipped it.

        Acknowledging a digest that is not the pending one advances NOTHING. The
        source moved again between the observation and the acknowledgment, so
        committing would set the baseline to a digest nobody looked at and
        silently swallow the newer change. Leaving the baseline alone means the
        next run reports the whole outstanding delta instead.

        Not safe against two engine replicas acknowledging the same source
        concurrently: the write is atomic but read-modify-write is not. ADR-0007
        runs one scheduled job, so that is the deployed shape rather than a
        guarantee this function makes.

    .PARAMETER CheckpointPath
        The same checkpoint the observing run was given.

    .PARAMETER SourceId
        The sourceId from the reported change object.

    .PARAMETER Url
        The url from the reported change object. Source id alone is not a key:
        one registry entry may watch several URLs.

    .PARAMETER AcknowledgedDigest
        The currentDigest from the reported change object, which is the digest
        the caller actually acted on.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseShouldProcessForStateChangingFunctions',
        '',
        Justification = 'Advances the detection checkpoint at an explicit path.'
    )]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $CheckpointPath,

        [Parameter(Mandatory)]
        [string] $SourceId,

        [Parameter(Mandatory)]
        [string] $Url,

        [Parameter(Mandatory)]
        [string] $AcknowledgedDigest
    )

    Assert-Project42SourceCondition `
        -Condition ($AcknowledgedDigest -match '^[a-f0-9]{64}$') `
        -Message 'An acknowledged digest must be a lowercase SHA-256 digest.'
    Assert-Project42SourceCondition `
        -Condition (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) `
        -Message "The source-detection checkpoint was not found: $CheckpointPath"

    $checkpoint = Read-Project42SourceCheckpoint -Path $CheckpointPath
    $entries = @($checkpoint.sources)
    $target = @(
        $entries |
            Where-Object {
                [string] $_.sourceId -eq $SourceId -and [string] $_.url -eq $Url
            }
    )

    $result = [ordered]@{
        sourceId = $SourceId
        url = $Url
        advanced = $false
        digest = $null
        pendingDigest = $null
        reason = ''
    }

    if ($target.Count -eq 0) {
        $result.reason = 'the checkpoint holds no entry for that source and URL'
        return [pscustomobject] $result
    }

    $entry = $target[0]
    $result.digest = $entry.digest
    $result.pendingDigest = $entry.pendingDigest

    if ($null -eq $entry.pendingDigest) {
        $result.reason = (
            'no change is pending, so there is nothing to advance. The run ' +
            'either did not defer the commit or another run already ' +
            'acknowledged this change.'
        )
        return [pscustomobject] $result
    }
    if ([string] $entry.pendingDigest -ne $AcknowledgedDigest) {
        $result.reason = (
            'the pending digest is not the one acknowledged, so the source ' +
            'moved again after it was observed. The baseline is left alone ' +
            'and the outstanding delta is reported on the next run.'
        )
        return [pscustomobject] $result
    }

    $entry.digest = [string] $entry.pendingDigest
    $entry.pendingDigest = $null
    $entry.pendingObservedAt = $null
    $null = Save-Project42SourceCheckpoint -Path $CheckpointPath -Entry $entries

    $result.advanced = $true
    $result.digest = $entry.digest
    $result.pendingDigest = $null
    $result.reason = 'the baseline advanced to the acknowledged digest'
    return [pscustomobject] $result
}

Export-ModuleMember -Function @(
    'Confirm-Project42SourceChange',
    'Get-Project42SourceChangeSet',
    'Read-Project42SourceRegistry',
    'Read-Project42SourceCheckpoint',
    'Save-Project42SourceCheckpoint',
    'Get-Project42SourceFetchInterval',
    'ConvertTo-Project42SourceInstant',
    'ConvertTo-Project42NormalizedSourceText',
    'Get-Project42SourceDigest',
    'Get-Project42SourceExcerpt',
    'Invoke-Project42SourceFetch'
)
