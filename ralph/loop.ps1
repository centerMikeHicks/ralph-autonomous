<#
.SYNOPSIS
  Ralph loop launcher (Windows PowerShell 5.1 / PowerShell 7). Holds no policy: the loop
  lives in ralph/lib/run-loop.mjs so this script and loop.sh cannot drift.

.EXAMPLE
  .\ralph\loop.ps1 plan 1 specs\my-spec.md
  .\ralph\loop.ps1 build 20
  .\ralph\loop.ps1 review 5 -Model opus
  .\ralph\loop.ps1 status

  Environment: RALPH_MODEL, RALPH_AGENT_CMD, RALPH_SUPERVISED=1 (confirm each iteration)
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet("plan", "build", "review", "status")]
    [string]$Mode = "build",

    [Parameter(Position = 1)]
    [int]$MaxIterations = 0,

    [Parameter(Position = 2)]
    [string]$SpecFile = "",

    # Force one model for every iteration (same as RALPH_MODEL).
    [string]$Model = "",

    # Bind the spec to a tracker ticket (writes tracker_issue into the spec front matter).
    [string]$Issue = "",

    # Run without the tracker even when tracker.provider is "jira".
    [switch]$SkipTracker,

    # Do not keep per-iteration transcripts under .ralph/logs/.
    [switch]$NoTranscripts
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[Ralph] ERROR: node (>= 20) is required and was not found on PATH" -ForegroundColor Red
    exit 1
}

$LoopArgs = @($Mode)
if ($MaxIterations -gt 0) { $LoopArgs += "$MaxIterations" }
if ($SpecFile) { $LoopArgs += $SpecFile }
if ($Model) { $LoopArgs += @("--model", $Model) }
if ($Issue) { $LoopArgs += @("--issue", $Issue) }
if ($SkipTracker) { $LoopArgs += "--skip-tracker" }
if ($NoTranscripts) { $LoopArgs += "--no-transcripts" }

# A native command's exit status is its own; this script adds nothing to it.
$ErrorActionPreference = "Continue"
& node (Join-Path $PSScriptRoot "lib\run-loop.mjs") @LoopArgs
exit $LASTEXITCODE
