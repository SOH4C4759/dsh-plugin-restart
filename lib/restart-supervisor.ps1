#requires -Version 5.1
<#
.SYNOPSIS
  Detached relaunch supervisor for the DeepSeek Harness desktop app (Windows).

.DESCRIPTION
  The Host plugin cannot restart its own parent (the Electron shell) and cannot
  survive the teardown it triggers, so it spawns THIS script detached, answers the
  caller, and lets the whole app tree go away while the supervisor keeps running.

  Why PowerShell and not Node: the first Node version killed the Electron main by
  PID, then aborted on a name mismatch (the image name is `DeepSeek Harness`, not
  `DeepSeek Harness.exe`) and left the app closed with nothing to start it again.
  This version works by image name through the OS process API, so:

    1. waits `-ArmDelayMs` so the HTTP reply can flush,
    2. lists every process of the image name and reports them to the log,
    3. refuses to continue if the executable is missing (never kill what it cannot start),
    4. terminates those processes with taskkill /F,
    5. waits until none remain (bounded),
    6. starts exactly ONE new instance,
    7. writes restart-result.json so the next Host start can report what happened.

.PARAMETER Exe
  Full path of the application executable.

.PARAMETER ArmDelayMs
  Delay before anything is stopped, in milliseconds.

.PARAMETER GraceMs
  How long to wait for the app to exit after the kill, in milliseconds.

.PARAMETER StateDir
  Directory for restart.log and restart-result.json.

.PARAMETER LogPath
  Explicit log path (overrides the StateDir default).

.PARAMETER ResultPath
  Explicit result path (overrides the StateDir default).

.PARAMETER NoRelaunch
  Test-only: stop the app but do not start it again.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Exe,
  [int] $ArmDelayMs = 0,
  [int] $GraceMs = 4000,
  [string] $StateDir = (Join-Path $env:USERPROFILE '.dsh\dsh-plugin-restart'),
  [string] $LogPath,
  [string] $ResultPath,
  [switch] $NoRelaunch,
  # Test-only: report the resolved parameters and exit without touching anything.
  [switch] $PrintPlan
)

$ErrorActionPreference = 'Continue'
$startedAt = (Get-Date).ToString('o')
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $StateDir 'restart.log' }
if ([string]::IsNullOrWhiteSpace($ResultPath)) { $ResultPath = Join-Path $StateDir 'restart-result.json' }

if ($PrintPlan) {
  [pscustomobject]@{
    exe       = $Exe
    armDelay  = $ArmDelayMs
    graceMs   = $GraceMs
    stateDir  = $StateDir
    logPath   = $LogPath
    resultPath = $ResultPath
    noRelaunch = $NoRelaunch.IsPresent
  } | ConvertTo-Json -Compress
  exit 0
}

function Write-Log {
  param([string] $Message)
  $line = "[{0}] {1}" -f (Get-Date).ToString('o'), $Message
  try {
    $dir = Split-Path -Parent $LogPath
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch { }
}

function Write-Result {
  param([bool] $Ok, [string] $Phase, [string] $Reason, $RelaunchedPid)
  try {
    $dir = Split-Path -Parent $ResultPath
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # UTF-8 WITHOUT BOM: the plugin reads this with Node's JSON.parse.
    $payload = [pscustomobject]@{
      schemaVersion = 1
      startedAt     = $startedAt
      finishedAt    = (Get-Date).ToString('o')
      ok            = $Ok
      phase         = $Phase
      reason        = $Reason
      relaunchedPid = $RelaunchedPid
      by            = 'supervisor'
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($ResultPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

Write-Log ("supervisor started; exe='{0}' armDelayMs={1} graceMs={2}" -f $Exe, $ArmDelayMs, $GraceMs)

if ([string]::IsNullOrWhiteSpace($Exe)) {
  Write-Log 'aborted: no executable was supplied'
  Write-Result -Ok $false -Phase 'missing-exe' -Reason 'no executable supplied' -RelaunchedPid $null
  exit 1
}
if (-not (Test-Path -LiteralPath $Exe)) {
  # Never stop an app that cannot be started again.
  Write-Log ("aborted before stopping anything: executable not found: {0}" -f $Exe)
  Write-Result -Ok $false -Phase 'missing-exe' -Reason ("executable not found: " + $Exe) -RelaunchedPid $null
  exit 1
}

$imageName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
Write-Log ("image name = '{0}'" -f $imageName)

if ($ArmDelayMs -gt 0) { Start-Sleep -Milliseconds $ArmDelayMs }

function Get-AppProcess {
  @(Get-Process -Name $imageName -ErrorAction SilentlyContinue)
}

$before = Get-AppProcess
Write-Log ("processes before stop = {0} [{1}]" -f $before.Count, (($before | ForEach-Object { $_.Id }) -join ','))
if ($before.Count -eq 0) {
  Write-Log 'nothing was running; starting one instance'
} else {
  foreach ($p in $before) {
    try {
      & taskkill.exe /F /PID $p.Id 2>&1 | ForEach-Object { if (-not [string]::IsNullOrWhiteSpace($_)) { Write-Log ("  taskkill {0}: {1}" -f $p.Id, $_) } }
    } catch {
      Write-Log ("  taskkill {0} threw: {1}" -f $p.Id, $_.Exception.Message)
    }
  }
}

$waited = 0
while ($waited -lt $GraceMs -and (Get-AppProcess).Count -gt 0) {
  Start-Sleep -Milliseconds 250
  $waited += 250
}
$left = Get-AppProcess
Write-Log ("processes after stop = {0} (waited {1}ms)" -f $left.Count, $waited)
if ($left.Count -gt 0) {
  foreach ($p in $left) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  Start-Sleep -Milliseconds 1500
  $left = Get-AppProcess
  Write-Log ("processes after force pass = {0}" -f $left.Count)
}
$stoppedCleanly = $left.Count -eq 0

if ($NoRelaunch) {
  Write-Log 'test mode: application NOT started'
  Write-Result -Ok $stoppedCleanly -Phase 'stopped-no-launch' -Reason $null -RelaunchedPid $null
  exit $(if ($stoppedCleanly) { 0 } else { 1 })
}

Start-Sleep -Milliseconds 800
try {
  # Start-Process (not `cmd /c start`): this supervisor has no console of its own
  # (it is created through WMI), and `start` blocks whenever its stdout is
  # captured. Start-Process hands the app a normal foreground window from a
  # non-console parent.
  $new = Start-Process -FilePath $Exe -PassThru
  Write-Log ("launch requested pid={0}" -f $new.Id)
  # Wait for a real window, not just a process: the reported failure was an app
  # that came back process-wise with no visible client.
  $windowed = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $candidate = @(Get-AppProcess) | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -ne $candidate) { $windowed = $candidate; break }
  }
  $running = @(Get-AppProcess)
  $newest = if ($running.Count -gt 0) { $running | Sort-Object StartTime -Descending | Select-Object -First 1 } else { $null }
  if ($null -eq $newest) {
    Write-Log 'the app did not appear after the launch request'
    Write-Result -Ok $false -Phase 'launch-failed' -Reason 'no process appeared after the launch request' -RelaunchedPid $null
    exit 1
  }
  if ($null -eq $windowed) {
    Write-Log ("started pid={0} but no window was observed within 20s" -f $newest.Id)
    Write-Result -Ok $true -Phase 'relaunched-no-window' -Reason 'the app started but no main window was observed' -RelaunchedPid $newest.Id
    exit 0
  }
  Write-Log ("started one instance pid={0} with a visible window '{1}'" -f $windowed.Id, $windowed.MainWindowTitle)
  Write-Result -Ok $true -Phase 'relaunched' -Reason $null -RelaunchedPid $windowed.Id
  exit 0
} catch {
  Write-Log ("start failed: {0}" -f $_.Exception.Message)
  Write-Result -Ok $false -Phase 'launch-failed' -Reason $_.Exception.Message -RelaunchedPid $null
  exit 1
}
