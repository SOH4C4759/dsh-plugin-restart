<#
.SYNOPSIS
  Non-destructive self-check for the tray's process-control layer.

.DESCRIPTION
  Dot-sources tray-functions.ps1 and exercises it against a throwaway copy of
  node.exe renamed to a unique image name, so no real process (and certainly not
  DSH) can be matched or killed:

    powershell -NoProfile -ExecutionPolicy Bypass -File tests\tray-selfcheck.ps1

  Checks: discovery, running predicate, tree termination, relaunch, and the
  restart result record. A node.exe is needed only to build an inert stand-in
  process; set DSH_SELFCHECK_NODE to point at one explicitly. Set
  DSH_SELFCHECK_LIVE=1 to require the real DSH desktop app to be running.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Capture the helper layer's diagnostics instead of letting them reach the console:
# the stop ORDER is part of the contract and is asserted below (see
# Stop-ProcessTree and the shell-first case at the end of this file).
$script:diag = New-Object System.Collections.Generic.List[string]
function Write-TrayDiag {
  param([string] $Message)
  $script:diag.Add([string]$Message)
}

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'tray\tray-functions.ps1')

$failures = 0
$results = @()

function Assert-Check {
  param([string] $Name, [bool] $Ok, [string] $Detail = '')
  $script:results += [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
  if (-not $Ok) { $script:failures++ }
  $label = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0}  {1}{2}" -f $label, $Name, $(if ($Detail) { " - $Detail" } else { '' }))
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-tray-selfcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

# A unique image name, so nothing else on the machine can match it.
$imageName = "dshrestart-dummy-" + $PID
$exePath = Join-Path $tempRoot "$imageName.exe"

$nodeSource = $null
$onPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -ne $onPath -and -not [string]::IsNullOrWhiteSpace($onPath.Source)) { $nodeSource = $onPath.Source }
if ([string]::IsNullOrWhiteSpace($nodeSource) -and -not [string]::IsNullOrWhiteSpace($env:DSH_SELFCHECK_NODE)) { $nodeSource = $env:DSH_SELFCHECK_NODE }
if ([string]::IsNullOrWhiteSpace($nodeSource)) {
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $candidate) { $nodeSource = $candidate }
}
if ([string]::IsNullOrWhiteSpace($nodeSource)) {
  $candidate = Join-Path $PSHOME 'node.exe'
  if (Test-Path -LiteralPath $candidate) { $nodeSource = $candidate }
}
if ([string]::IsNullOrWhiteSpace($nodeSource) -or -not (Test-Path -LiteralPath $nodeSource)) {
  throw "tray-selfcheck: no node.exe found to build the stand-in (set DSH_SELFCHECK_NODE)"
}
Copy-Item -LiteralPath $nodeSource -Destination $exePath -Force
if (-not (Test-Path -LiteralPath $exePath)) { throw "tray-selfcheck: could not stage $exePath" }

$spawned = New-Object System.Collections.Generic.List[object]
function Start-Dummy {
  param([int] $Count = 1)
  $out = @()
  for ($i = 0; $i -lt $Count; $i++) {
    # A space-free script: Start-Process does not quote -ArgumentList entries, so a
    # spaced script would be split into several argv entries and die instantly.
    $proc = Start-Process -FilePath $exePath -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
    $spawned.Add($proc)
    $out += $proc.Id
  }
  Start-Sleep -Milliseconds 600
  return $out
}

try {
  Assert-Check 'fresh image name has no processes' (-not (Test-AppRunning -Name $imageName)) "name=$imageName"

  # The real image name must match through the same code path the tray uses. A
  # live desktop app is only expected on a developer machine, so on a clean
  # runner this asserts the query path itself; set DSH_SELFCHECK_LIVE=1 to make a
  # running app a hard requirement.
  $dshProcesses = @(Get-AppProcess -Name 'DeepSeek Harness')
  if ($dshProcesses.Count -ge 1 -or $env:DSH_SELFCHECK_LIVE -eq '1') {
    Assert-Check 'the real DSH image name is discoverable' ($dshProcesses.Count -ge 1) ("count=" + $dshProcesses.Count)
  } else {
    Assert-Check 'the DSH image-name query runs without error' ((Test-AppRunning -Name 'DeepSeek Harness') -is [bool]) 'DeepSeek Harness is not running here; set DSH_SELFCHECK_LIVE=1 to require a live process'
  }

  $pids = Start-Dummy -Count 2
  Assert-Check 'spawned stand-ins are discovered' ((Get-AppProcess -Name $imageName).Count -eq 2) "pids=$($pids -join ',')"
  Assert-Check 'running predicate is true while alive' (Test-AppRunning -Name $imageName) ''

  $stopped = Stop-ProcessTree -Name $imageName -WaitMs 5000
  Assert-Check 'tree termination reports success' ($stopped -eq $true) ''
  Assert-Check 'no stand-in survives termination' (-not (Test-AppRunning -Name $imageName)) ''

  $started = Start-AppProcess -Exe $exePath
  Assert-Check 'relaunch reports a running process' ($started -eq $true) ''
  Assert-Check 'relaunched image is discoverable' (Test-AppRunning -Name $imageName) 'post-start discovery'

  $resultPath = Join-Path $tempRoot 'restart-result.json'
  $restart = Restart-App -Exe $exePath -WaitMs 5000 -SettleMs 300
  Assert-Check 'Restart-App reports relaunched' ($restart.ok -eq $true -and $restart.phase -eq 'relaunched') ("ok=$($restart.ok) phase=$($restart.phase)")

  $written = Write-RestartResult -Path $resultPath -Result $restart -By 'selfcheck'
  Assert-Check 'result record is written' ($written -eq $true) ''
  if (Test-Path -LiteralPath $resultPath) {
    $parsed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Assert-Check 'result record is valid JSON with the expected shape' ($parsed.ok -eq $true -and $parsed.phase -eq 'relaunched' -and $parsed.by -eq 'selfcheck') ($parsed | ConvertTo-Json -Compress)
    # The plugin reads this file with Node's JSON.parse, which rejects a BOM.
    $bytes = [System.IO.File]::ReadAllBytes($resultPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Assert-Check 'result record has no UTF-8 BOM (Node JSON.parse must accept it)' (-not $hasBom) ("first bytes: " + (($bytes[0..([Math]::Min(2, $bytes.Length - 1))] | ForEach-Object { $_.ToString('X2') }) -join ' '))
  } else {
    Assert-Check 'result record is valid JSON with the expected shape' $false 'file missing'
    Assert-Check 'result record has no UTF-8 BOM (Node JSON.parse must accept it)' $false 'file missing'
  }

  # Trigger contract: nothing deletes the trigger, so a request older than the
  # tray's start must be refused and a handled one must be consumed.
  $triggerPath = Join-Path $tempRoot 'restart-request.json'
  $trayStart = (Get-Date).ToUniversalTime()
  $stale = [pscustomobject]@{ schemaVersion = 1; requestedAt = $trayStart.AddMinutes(-30).ToString('o'); pid = 1; exe = 'x'; args = @(); graceMs = 500; armedBy = 'host:supervisor-failed' } | ConvertTo-Json
  [System.IO.File]::WriteAllText($triggerPath, $stale, (New-Object System.Text.UTF8Encoding($false)))
  Assert-Check 'a stale trigger is refused' ($null -eq (Read-RestartTrigger -Path $triggerPath -NotBefore $trayStart)) 'requestedAt is 30 minutes before tray start'

  $fresh = [pscustomobject]@{ schemaVersion = 1; requestedAt = (Get-Date).AddSeconds(5).ToString('o'); pid = 2; exe = 'y'; args = @('a'); graceMs = 700; armedBy = 'host:supervisor-failed' } | ConvertTo-Json
  [System.IO.File]::WriteAllText($triggerPath, $fresh, (New-Object System.Text.UTF8Encoding($false)))
  $accepted = Read-RestartTrigger -Path $triggerPath -NotBefore $trayStart
  Assert-Check 'a fresh trigger is accepted with its payload' ($null -ne $accepted -and $accepted.pid -eq 2 -and $accepted.armedBy -eq 'host:supervisor-failed') ($accepted | ConvertTo-Json -Compress)
  Remove-RestartTrigger -Path $triggerPath | Out-Null
  Assert-Check 'a handled trigger is consumed' (-not (Test-Path -LiteralPath $triggerPath)) ''

  [System.IO.File]::WriteAllText($triggerPath, '{ this is not json', (New-Object System.Text.UTF8Encoding($false)))
  Assert-Check 'a malformed trigger is refused without throwing' ($null -eq (Read-RestartTrigger -Path $triggerPath -NotBefore $trayStart)) ''
  Remove-RestartTrigger -Path $triggerPath | Out-Null

  Assert-Check 'a missing trigger is refused' ($null -eq (Read-RestartTrigger -Path (Join-Path $tempRoot 'nope.json') -NotBefore $trayStart)) ''

  Assert-Check 'missing executable is reported, not thrown' ((Restart-App -Exe (Join-Path $tempRoot 'nope.exe') -WaitMs 500).phase -eq 'missing-exe') ''
  Assert-Check 'a missing executable stops nothing' (Test-AppRunning -Name $imageName) 'the stand-in from the relaunch step is untouched'

  # --- the app root (Electron shell) is stopped BEFORE its children ---
  # Measured bug: when the Host dies while the shell is still alive, the shell runs
  # its "desktop host stopped" handler — a native "DeepSeek Harness unusable"
  # message box with the Windows system sound — and the shell is killed a moment
  # later, so the user sees one flash of a white dialog plus one ding at the start
  # of the restart. A parent stand-in with a child of the same image name
  # reproduces the shape of the app tree without touching DSH.
  [void](Stop-ProcessTree -Name $imageName -WaitMs 3000)
  $script:diag.Clear()
  $shellScript = "const{spawn}=require('child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"
  $parent = Start-Process -FilePath $exePath -ArgumentList '-e', $shellScript -PassThru -WindowStyle Hidden
  $spawned.Add($parent)
  Start-Sleep -Milliseconds 1500
  Assert-Check 'the stand-in shell has a child of the same image name' ((Get-AppProcess -Name $imageName).Count -ge 2) ("count=" + (Get-AppProcess -Name $imageName).Count)
  $stoppedTree = Stop-ProcessTree -Name $imageName -WaitMs 5000
  $rootLine = $script:diag | Where-Object { $_ -match ("stopping the app root \(Electron shell\) first: pid {0}$" -f $parent.Id) } | Select-Object -First 1
  Assert-Check 'the tray names the parent shell as the app root and stops it first' ($null -ne $rootLine) (($script:diag | Select-Object -First 3) -join ' | ')
  Assert-Check 'the tray confirms the shell is gone before the rest are stopped' (($script:diag | Where-Object { $_ -match ("app root pid {0} gone after" -f $parent.Id) }).Count -ge 1) ''
  Assert-Check 'the whole tree is down after stopping the shell first' ($stoppedTree -eq $true -and -not (Test-AppRunning -Name $imageName)) ''
} finally {
  Stop-ProcessTree -Name $imageName -WaitMs 3000 | Out-Null
  foreach ($proc in $spawned) { try { if ($null -ne $proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { } }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$passed = $results.Count - $failures
Write-Host ""
Write-Host "$passed/$($results.Count) tray checks passed"
exit $(if ($failures -eq 0) { 0 } else { 1 })
