<#
.SYNOPSIS
  Non-destructive end-to-end check of the detached restart supervisor.

.DESCRIPTION
  Runs lib\restart-supervisor.ps1 against a throwaway copy of node.exe renamed to
  a unique image name, so the real DSH app is never matched or stopped:

    powershell -NoProfile -ExecutionPolicy Bypass -File tests\supervisor-e2e.ps1

  Covers: arm delay, list-before-stop, terminate by image name, bounded wait,
  single relaunch, the no-BOM result contract, the missing-exe refusal, and the
  no-relaunch test switch.

  A node.exe is only needed to build an inert stand-in process. It is resolved
  from -NodeSource, then DSH_SELFCHECK_NODE, then PATH, then the DSH desktop
  install, then $PSHOME; when none is found the suite reports SKIP and exits 0
  instead of failing on a machine it was never meant to run on.
#>
[CmdletBinding()]
param(
  [string] $NodeSource = ''
)

$ErrorActionPreference = 'Stop'
$supervisor = Join-Path (Split-Path -Parent $PSScriptRoot) 'lib\restart-supervisor.ps1'
$results = @()
$failures = 0

function Assert-Check {
  param([string] $Name, [bool] $Ok, [string] $Detail = '')
  $script:results += [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
  if (-not $Ok) { $script:failures++ }
  Write-Host ("{0}  {1}{2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { " - $Detail" } else { '' }))
}

function Resolve-NodeExe {
  param([string] $Explicit = '')
  if (-not [string]::IsNullOrWhiteSpace($Explicit) -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_SELFCHECK_NODE) -and (Test-Path -LiteralPath $env:DSH_SELFCHECK_NODE)) { return $env:DSH_SELFCHECK_NODE }
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $onPath -and -not [string]::IsNullOrWhiteSpace($onPath.Source)) { return $onPath.Source }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $candidate = Join-Path $PSHOME 'node.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return ''
}

$NodeSource = Resolve-NodeExe -Explicit $NodeSource
if ([string]::IsNullOrWhiteSpace($NodeSource)) {
  Write-Host 'SKIP  supervisor-e2e: no node.exe found; pass -NodeSource, set DSH_SELFCHECK_NODE, or put node.exe on PATH'
  exit 0
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-supervisor-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$imageName = 'dshsup-dummy-' + $PID
$exePath = Join-Path $tempRoot ($imageName + '.exe')
Copy-Item -LiteralPath $NodeSource -Destination $exePath -Force

function Start-StandIn {
  # Space-free argv: Start-Process does not quote -ArgumentList entries.
  $p = Start-Process -FilePath $exePath -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
  return $p
}

function Get-StandIn { @(Get-Process -Name $imageName -ErrorAction SilentlyContinue) }

try {
  # --- case 1: live stand-in is stopped and exactly one instance comes back ---
  $caseDir = Join-Path $tempRoot 'relaunch'
  New-Item -ItemType Directory -Path $caseDir -Force | Out-Null
  $logPath = Join-Path $caseDir 'restart.log'
  $resultPath = Join-Path $caseDir 'restart-result.json'

  $a = Start-StandIn
  $b = Start-StandIn
  Assert-Check 'two stand-ins are running before the restart' ((Get-StandIn).Count -eq 2) ("count=" + (Get-StandIn).Count)

  & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisor -Exe $exePath -GraceMs 3000 -StateDir $caseDir -LogPath $logPath -ResultPath $resultPath | Out-Null
  Assert-Check 'supervisor exits 0 on a successful relaunch' ($LASTEXITCODE -eq 0) ("exit=" + $LASTEXITCODE)

  $after = @(Get-StandIn)
  Assert-Check 'exactly one instance is running after the restart' ($after.Count -eq 1) ("count=" + $after.Count)

  $log = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
  Assert-Check 'the log lists processes before stopping them' ($log -match 'processes before stop = 2') ''
  Assert-Check 'the log records the failed old supervisor cause as image-name based' ($log -match "image name = '$imageName'") ''

  if (Test-Path -LiteralPath $resultPath) {
    $bytes = [System.IO.File]::ReadAllBytes($resultPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Assert-Check 'result JSON has no UTF-8 BOM' (-not $hasBom) (($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' ')
    $parsed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Assert-Check 'result reports ok with a relaunch phase' ($parsed.ok -eq $true -and $parsed.phase -in @('relaunched','relaunched-no-window')) ($parsed | ConvertTo-Json -Compress)
    Assert-Check 'result records the relaunched pid' ([int]$parsed.relaunchedPid -gt 0) ("pid=" + $parsed.relaunchedPid)
  } else {
    Assert-Check 'result JSON has no UTF-8 BOM' $false 'file missing'
    Assert-Check 'result reports ok/relaunched' $false 'file missing'
    Assert-Check 'result records the relaunched pid' $false 'file missing'
  }
  foreach ($p in @(Get-StandIn)) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }

  # --- case 2: a missing executable must be refused before anything is stopped ---
  $caseDir2 = Join-Path $tempRoot 'missing'
  New-Item -ItemType Directory -Path $caseDir2 -Force | Out-Null
  $running = Start-StandIn
  $logPath2 = Join-Path $caseDir2 'restart.log'
  $resultPath2 = Join-Path $caseDir2 'restart-result.json'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisor -Exe (Join-Path $tempRoot 'does-not-exist.exe') -GraceMs 1000 -StateDir $caseDir2 -LogPath $logPath2 -ResultPath $resultPath2 | Out-Null
  $stillThere = -not $running.HasExited
  Assert-Check 'a missing executable leaves the running app alone' $stillThere ''
  Assert-Check 'a missing executable exits non-zero' ($LASTEXITCODE -ne 0) ("exit=" + $LASTEXITCODE)
  if (Test-Path -LiteralPath $resultPath2) {
    $parsed2 = Get-Content -LiteralPath $resultPath2 -Raw | ConvertFrom-Json
    Assert-Check 'a missing executable writes phase missing-exe' ($parsed2.phase -eq 'missing-exe') ($parsed2 | ConvertTo-Json -Compress)
  } else {
    Assert-Check 'a missing executable writes phase missing-exe' $false 'file missing'
  }
  try { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue } catch { }

  # --- case 3: the test-only no-relaunch switch ---
  $caseDir3 = Join-Path $tempRoot 'nolaunch'
  New-Item -ItemType Directory -Path $caseDir3 -Force | Out-Null
  $target = Start-StandIn
  & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisor -Exe $exePath -GraceMs 3000 -StateDir $caseDir3 -LogPath (Join-Path $caseDir3 'restart.log') -ResultPath (Join-Path $caseDir3 'restart-result.json') -NoRelaunch | Out-Null
  $gone = @(Get-StandIn).Count -eq 0
  Assert-Check 'no-relaunch stops the app and starts nothing' ($gone -and $LASTEXITCODE -eq 0) ("exit=" + $LASTEXITCODE + " remaining=" + (Get-StandIn).Count)
  $parsed3 = Get-Content -LiteralPath (Join-Path $caseDir3 'restart-result.json') -Raw | ConvertFrom-Json
  Assert-Check 'no-relaunch writes phase stopped-no-launch' ($parsed3.phase -eq 'stopped-no-launch') ($parsed3 | ConvertTo-Json -Compress)

  # --- case 4: the Electron shell is stopped BEFORE its children ---
  # Measured bug: when the Host dies while the shell is still alive, the shell runs
  # its "desktop host stopped" handler — a native #32770 message box, "DeepSeek
  # Harness unusable / the application could not start or has stopped
  # unexpectedly", with Quit / Restart / Disable-third-party-plugins buttons — and
  # Windows plays the system notification sound for it. The shell is killed by the
  # next taskkill in the same loop, so the user sees one flash of a white dialog
  # plus one ding at the start of every restart. A parent stand-in with a child of
  # the same image name reproduces the shape of the app tree without touching DSH.
  $caseDir4 = Join-Path $tempRoot 'shell-first'
  New-Item -ItemType Directory -Path $caseDir4 -Force | Out-Null
  # Space-free and double-quote-free: Start-Process does not quote -ArgumentList
  # entries, so anything with a space would be split into several argv entries and
  # the stand-in would die before it ever spawns its child.
  $shellScript = "const{spawn}=require('child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"
  $shell = Start-Process -FilePath $exePath -ArgumentList '-e', $shellScript -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 1500
  $tree = @(Get-StandIn)
  Assert-Check 'the stand-in shell has a child of the same image name' ($tree.Count -ge 2) ("count=" + $tree.Count)
  $childProc = $tree | Where-Object { $_.Id -ne $shell.Id } | Select-Object -First 1
  $logPath4 = Join-Path $caseDir4 'restart.log'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisor -Exe $exePath -GraceMs 3000 -StateDir $caseDir4 -LogPath $logPath4 -ResultPath (Join-Path $caseDir4 'restart-result.json') -NoRelaunch | Out-Null
  $log4 = @(Get-Content -LiteralPath $logPath4 -ErrorAction SilentlyContinue)
  $rootLine = $log4 | Select-String -SimpleMatch ("stopping the app root (Electron shell) first: pid={0}" -f $shell.Id) | Select-Object -First 1
  Assert-Check 'the app root is named as the shell and stopped first' ($null -ne $rootLine) ("shellPid=" + $shell.Id)
  $goneLine = $log4 | Select-String -SimpleMatch ("app root pid={0} is gone after" -f $shell.Id) | Select-Object -First 1
  Assert-Check 'the shell is confirmed gone before the rest are stopped' ($null -ne $goneLine) ''
  $childKill = $log4 | Select-String -Pattern 'taskkill (\d+):' | Where-Object { $_.Line -notmatch ("taskkill {0}:" -f $shell.Id) } | Select-Object -First 1
  Assert-Check 'the remaining processes are stopped after the shell' ($null -ne $childKill -and $null -ne $rootLine -and $childKill.LineNumber -gt $rootLine.LineNumber) ("childKillLine=" + $(if ($null -ne $childKill) { $childKill.LineNumber } else { 'none' }))
  if ($null -ne $childProc) {
    Assert-Check 'the child of the shell is gone too' ($null -eq (Get-Process -Id $childProc.Id -ErrorAction SilentlyContinue)) ("childPid=" + $childProc.Id)
  }
  foreach ($p in @(Get-StandIn)) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
} finally {
  foreach ($p in @(Get-StandIn)) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("{0}/{1} supervisor checks passed" -f ($results.Count - $failures), $results.Count)
exit $(if ($failures -eq 0) { 0 } else { 1 })
