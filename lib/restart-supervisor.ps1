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

<#
  Parent-process map for this image name, read from the OS.

  Why the stop ORDER needs one: the Electron shell is the parent of the Host and of
  every renderer, and it owns the Host as a watched child. When the Host dies while
  the shell is still alive, the shell runs its "desktop host stopped" handler,
  which is a NATIVE message box — measured on Windows 11 as class #32770, title
  "DeepSeek Harness unusable", body "the application could not start or has
  stopped unexpectedly", buttons Quit / Restart / Disable third-party plugins,
  back up the profile patch and restart — and Windows plays the system
  notification sound for it (WASAPI system-sounds session, peak 0.13). The shell
  is then killed a fraction of a second later by the next taskkill, so the user
  sees exactly one flash of a white dialog plus one ding at the start of the
  restart.

  Iterating processes in PID order cannot prevent that (PIDs are recycled, so the
  Host can sort before the shell), and neither can killing the whole set in one
  pass: the shell only has to outlive the Host by one message-pump turn. The shell
  is therefore identified by ANCESTRY, terminated on its own, and waited for
  before anything else is touched.
#>
function Get-AppProcessParentMap {
  $map = @{}
  try {
    $query = "SELECT ProcessId, ParentProcessId FROM Win32_Process WHERE Name='{0}.exe'" -f $imageName
    foreach ($row in @(Get-CimInstance -Query $query -ErrorAction Stop)) {
      $map[[int]$row.ProcessId] = [int]$row.ParentProcessId
    }
  } catch {
    Write-Log ("parent map unavailable ({0}); falling back to start-time order" -f $_.Exception.Message)
  }
  return $map
}

<#
  The process every other app process descends from — the Electron shell.

  Falls back to the OLDEST process when ancestry is unavailable, because the shell
  is always the first process of its own tree. When an orphan of an earlier
  generation is still around there can be several roots; the shell is the one that
  is an ancestor of the most processes in this set.
#>
function Select-AppRootProcess {
  param([object[]] $Processes, [hashtable] $ParentMap)

  if ($null -eq $Processes -or $Processes.Count -eq 0) { return $null }
  $oldest = @{ Expression = { try { $_.StartTime } catch { [datetime]::MaxValue } } }
  if ($null -eq $ParentMap -or $ParentMap.Count -eq 0) {
    return ($Processes | Sort-Object -Property $oldest | Select-Object -First 1)
  }
  $ids = @{}
  foreach ($p in $Processes) { $ids[[int]$p.Id] = $true }
  $roots = @($Processes | Where-Object {
      $parent = $ParentMap[[int]$_.Id]
      ($null -eq $parent) -or (-not $ids.ContainsKey([int]$parent))
    })
  if ($roots.Count -eq 0) {
    return ($Processes | Sort-Object -Property $oldest | Select-Object -First 1)
  }
  if ($roots.Count -eq 1) { return $roots[0] }
  $best = $null
  $bestScore = -1
  foreach ($root in $roots) {
    $score = 0
    foreach ($p in $Processes) {
      $cursor = [int]$p.Id
      $hops = 0
      while ($ParentMap.ContainsKey($cursor) -and $hops -lt 64) {
        $cursor = [int]$ParentMap[$cursor]
        if ($cursor -eq [int]$root.Id) { $score++; break }
        $hops++
      }
    }
    if ($score -gt $bestScore) { $best = $root; $bestScore = $score }
  }
  if ($null -eq $best) { return $roots[0] }
  return $best
}

function Stop-AppOneProcess {
  param($Process)
  try {
    & taskkill.exe /F /PID $Process.Id 2>&1 | ForEach-Object { if (-not [string]::IsNullOrWhiteSpace($_)) { Write-Log ("  taskkill {0}: {1}" -f $Process.Id, $_) } }
  } catch {
    Write-Log ("  taskkill {0} threw: {1}" -f $Process.Id, $_.Exception.Message)
  }
}

function Wait-AppProcessGone {
  param([int] $Id, [int] $TimeoutMs)
  $waited = 0
  while ($waited -lt $TimeoutMs) {
    if ($null -eq (Get-Process -Id $Id -ErrorAction SilentlyContinue)) { return $waited }
    Start-Sleep -Milliseconds 100
    $waited += 100
  }
  return -1
}

$before = Get-AppProcess
Write-Log ("processes before stop = {0} [{1}]" -f $before.Count, (($before | ForEach-Object { $_.Id }) -join ','))
if ($before.Count -eq 0) {
  Write-Log 'nothing was running; starting one instance'
} else {
  # The shell goes first, and alone: while it is alive it turns the Host's death
  # into a native error dialog with a system sound (see Get-AppProcessParentMap).
  $root = Select-AppRootProcess -Processes $before -ParentMap (Get-AppProcessParentMap)
  if ($null -ne $root) {
    Write-Log ("stopping the app root (Electron shell) first: pid={0}" -f $root.Id)
    Stop-AppOneProcess -Process $root
    $goneAfterMs = Wait-AppProcessGone -Id $root.Id -TimeoutMs 5000
    if ($goneAfterMs -ge 0) {
      Write-Log ("  app root pid={0} is gone after {1}ms; nothing is left that could report the Host as stopped" -f $root.Id, $goneAfterMs)
    } else {
      Write-Log ("  app root pid={0} was still alive after 5000ms; stopping the remaining processes anyway" -f $root.Id)
    }
  }
  foreach ($p in @($before | Where-Object { $null -eq $root -or $_.Id -ne $root.Id })) {
    Stop-AppOneProcess -Process $p
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
