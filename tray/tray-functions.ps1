<#
.SYNOPSIS
  Testable process-control helpers for the DSH restart tray.

.DESCRIPTION
  Split out of tray-host.ps1 so the terminate/relaunch logic can be exercised
  against throwaway processes without a GUI and without touching DSH:

    . .\tray-functions.ps1
    Stop-ProcessTree -Name 'notepad'          # kills every notepad
    Start-AppProcess -Exe 'C:\...\app.exe'   # starts it again

  Every function takes the image name / executable path explicitly; nothing here
  knows about DSH. Diagnostics go through Write-TrayDiag, which the host replaces
  with its file logger.
#>

# Overridable diagnostic sink: the tray host points this at tray.log, because its
# console is hidden and Write-Warning would otherwise be lost.
if (-not (Get-Command Write-TrayDiag -ErrorAction SilentlyContinue)) {
  function Write-TrayDiag {
    param([string] $Message)
    Write-Host $Message
  }
}

function Get-AppProcess {
  <#
  .SYNOPSIS
    Every live process whose image name (no extension) equals -Name.
  .DESCRIPTION
    Equality on the basename, case-insensitive. Windows reports the full image
    name here (`DeepSeek Harness`, 16 chars), so no truncation handling is needed.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string] $Name)

  if ([string]::IsNullOrWhiteSpace($Name)) { return @() }
  $trimmed = $Name.Trim()
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $null -ne $_.ProcessName -and [string]::Equals($_.ProcessName, $trimmed, [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Test-AppRunning {
  <#
  .SYNOPSIS
    Whether any process with this image name is alive.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string] $Name)

  (Get-AppProcess -Name $Name).Count -gt 0
}

function Get-ProcessParentMap {
  <#
  .SYNOPSIS
    pid -> parent pid for every process with this image name, read from the OS.
  .DESCRIPTION
    The stop ORDER depends on this. The Electron shell is the parent of the Host,
    and when the Host dies while the shell is alive the shell puts up its native
    "DeepSeek Harness unusable" message box with the Windows system sound; the
    shell is then killed a moment later, so the user sees one flash of a white
    dialog plus one ding. Killing in PID order does not prevent that, so the shell
    is identified by ancestry and killed first (see Stop-ProcessTree).
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string] $Name)

  $map = @{}
  if ([string]::IsNullOrWhiteSpace($Name)) { return $map }
  $escaped = $Name.Trim().Replace("'", "''")
  try {
    $query = "SELECT ProcessId, ParentProcessId FROM Win32_Process WHERE Name='{0}.exe'" -f $escaped
    foreach ($row in @(Get-CimInstance -Query $query -ErrorAction Stop)) {
      $map[[int]$row.ProcessId] = [int]$row.ParentProcessId
    }
  } catch {
    Write-TrayDiag "parent map unavailable: $($_.Exception.Message)"
  }
  return $map
}

function Select-AppRootProcess {
  <#
  .SYNOPSIS
    The process every other app process descends from — the Electron shell.
  .DESCRIPTION
    Falls back to the oldest process when ancestry is unavailable, because the
    shell is always the first process of its own tree. With an orphan of an earlier
    generation around there can be several roots; the shell is the one that is an
    ancestor of the most processes in this set.
  #>
  [CmdletBinding()]
  param(
    [object[]] $Processes,
    [hashtable] $ParentMap
  )

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

function Stop-ProcessTree {
  <#
  .SYNOPSIS
    Force-terminate every process with this image name, then wait until none remain.
  .DESCRIPTION
    Deliberately does NOT use taskkill /T: the tray can be a descendant of the app
    it restarts (launched from a DSH shell), so /T would kill the tray mid-restart
    and leave the app down. Every process of a given image name is already matched
    by name, so /T adds nothing but collateral damage.

    The shell DOES go first, on its own, and is waited for: while it is alive it
    reacts to the Host's death with a native error dialog plus the Windows system
    sound, which the user otherwise sees as a one-frame white popup at the start of
    every restart (measured; see Select-AppRootProcess).
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Name,
    [int[]] $ExcludePid = @(),
    [int] $WaitMs = 5000,
    [int] $PollMs = 250
  )

  if ([string]::IsNullOrWhiteSpace($Name)) { return $true }
  $self = $PID
  $procs = @(Get-AppProcess -Name $Name | Where-Object { $_.Id -ne $self -and ($ExcludePid -notcontains $_.Id) })
  if (@($procs).Count -eq 0) { return $true }
  $root = Select-AppRootProcess -Processes $procs -ParentMap (Get-ProcessParentMap -Name $Name)
  if ($null -ne $root -and $root.Id -ne $self) {
    Write-TrayDiag "stopping the app root (Electron shell) first: pid $($root.Id)"
    try {
      & taskkill.exe /F /PID $root.Id 2>&1 | Out-Null
    } catch {
      Write-TrayDiag "taskkill failed for the app root pid $($root.Id): $($_.Exception.Message)"
    }
    $waitedForRoot = 0
    while ($waitedForRoot -lt 5000 -and $null -ne (Get-Process -Id $root.Id -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 100
      $waitedForRoot += 100
    }
    Write-TrayDiag "app root pid $($root.Id) gone after ${waitedForRoot}ms"
  }
  foreach ($proc in @($procs | Where-Object { $null -eq $root -or $_.Id -ne $root.Id })) {
    try {
      & taskkill.exe /F /PID $proc.Id 2>&1 | Out-Null
    } catch {
      Write-TrayDiag "taskkill failed for pid $($proc.Id): $($_.Exception.Message)"
    }
  }
  $elapsed = 0
  while ($elapsed -lt $WaitMs) {
    Start-Sleep -Milliseconds $PollMs
    $elapsed += $PollMs
    if (-not (Test-AppRunning -Name $Name)) { return $true }
  }
  return -not (Test-AppRunning -Name $Name)
}

function Start-AppProcess {
  <#
  .SYNOPSIS
    Start the executable if it is not already running.
  .OUTPUTS
    $true when a process with the target image name is running afterwards.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Exe,
    [switch] $Force
  )

  $name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  if (-not $Force -and (Test-AppRunning -Name $name)) { return $true }
  if (-not (Test-Path -LiteralPath $Exe)) { return $false }
  try {
    Start-Process -FilePath $Exe | Out-Null
  } catch {
    Write-TrayDiag "start failed for '$Exe': $($_.Exception.Message)"
    return $false
  }
  # A launched process that dies at once (bad argv, missing asset) must not be
  # reported as a successful start: probe it briefly.
  $deadline = 3000
  while ($deadline -gt 0) {
    Start-Sleep -Milliseconds 200
    $deadline -= 200
    if (Test-AppRunning -Name $name) { return $true }
  }
  return (Test-AppRunning -Name $name)
}

function Restart-App {
  <#
  .SYNOPSIS
    Stop the app tree and start it again.
  .DESCRIPTION
    The executable is validated BEFORE anything is stopped: deriving the image
    name from a wrong path would otherwise kill the running app and then skip the
    relaunch, leaving the user with nothing running.
  .OUTPUTS
    A result record: ok, phase, reason.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Exe,
    [int] $WaitMs = 5000,
    [int] $SettleMs = 600
  )

  if (-not (Test-Path -LiteralPath $Exe)) {
    return [pscustomobject]@{ ok = $false; phase = 'missing-exe'; reason = "executable not found: $Exe" }
  }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
  $stopped = Stop-ProcessTree -Name $name -WaitMs $WaitMs
  Start-Sleep -Milliseconds $SettleMs
  $started = Start-AppProcess -Exe $Exe -Force
  if (-not $started) {
    return [pscustomobject]@{ ok = $false; phase = 'start-failed'; reason = 'the app did not come back; start DSH manually' }
  }
  if (-not $stopped) {
    return [pscustomobject]@{ ok = $false; phase = 'terminate-failed'; reason = 'a previous instance survived termination' }
  }
  return [pscustomobject]@{ ok = $true; phase = 'relaunched'; reason = $null }
}

function Write-RestartResult {
  <#
  .SYNOPSIS
    Persist one restart outcome as JSON for the plugin's status route to read.
  .DESCRIPTION
    Written as UTF-8 WITHOUT a BOM: `Set-Content -Encoding UTF8` prepends one on
    PowerShell 5.1 and Node's JSON.parse then rejects the file.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)] $Result,
    [string] $By = 'tray'
  )

  try {
    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $payload = [pscustomobject]@{
      schemaVersion = 1
      startedAt     = (Get-Date).ToString('o')
      finishedAt    = (Get-Date).ToString('o')
      ok            = [bool]$Result.ok
      phase         = [string]$Result.phase
      reason        = $Result.reason
      relaunchedPid = $null
      by            = $By
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($Path, $payload, (New-Object System.Text.UTF8Encoding($false)))
    return $true
  } catch {
    Write-TrayDiag "result write failed: $($_.Exception.Message)"
    return $false
  }
}

function Read-RestartTrigger {
  <#
  .SYNOPSIS
    Parse a tray trigger file written by the Host plugin.
  .DESCRIPTION
    Returns $null for a missing, unreadable, malformed or REQUESTED-BEFORE-TRAY-START
    file. The age check matters: nothing deletes the trigger, so without it every
    tray launch would replay the last restart request and kill a healthy app.
  .OUTPUTS
    The parsed request (with `requestedAt` as a DateTime) or $null.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [datetime] $NotBefore
  )

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    $requestedAt = $null
    if (-not [string]::IsNullOrWhiteSpace($parsed.requestedAt)) {
      try { $requestedAt = [datetime]::Parse($parsed.requestedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { $requestedAt = $null }
    }
    if ($null -eq $requestedAt) { return $null }
    if ($requestedAt.ToUniversalTime() -lt $NotBefore.ToUniversalTime()) { return $null }
    return [pscustomobject]@{
      requestedAt = $requestedAt
      pid         = $parsed.pid
      exe         = $parsed.exe
      args        = $parsed.args
      graceMs     = $parsed.graceMs
      armedBy     = $parsed.armedBy
    }
  } catch {
    Write-TrayDiag "trigger unreadable: $($_.Exception.Message)"
    return $null
  }
}

function Remove-RestartTrigger {
  <#
  .SYNOPSIS
    Consume a handled trigger so it cannot be replayed later.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string] $Path)

  try {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
    return $true
  } catch {
    Write-TrayDiag "trigger cleanup failed: $($_.Exception.Message)"
    return $false
  }
}
