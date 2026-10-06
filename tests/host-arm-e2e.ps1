<#
.SYNOPSIS
  End-to-end check of the Host half's arming hop.

.DESCRIPTION
  Imports the real index.js, builds a plan through the real buildRestartPlan and
  runs the real spawnSupervisor -?but points the plan at a throwaway copy of
  node.exe renamed to a unique image name, so the running DSH app is never
  involved. The supervisor then does its real work (kill + relaunch) on the
  stand-in.

    powershell -NoProfile -ExecutionPolicy Bypass -File tests\host-arm-e2e.ps1

  A node.exe serves two roles here: it is the interpreter that drives the real
  Host arming path, and a renamed copy of it is the stand-in process. It is
  resolved from -NodeExe, then DSH_SELFCHECK_NODE, then PATH, then the DSH
  desktop install, then $PSHOME; when none is found the suite reports SKIP and
  exits 0 instead of failing on a machine it was never meant to run on. The
  interpreter must be Node 20 or newer, because the arm step imports index.js.
#>
[CmdletBinding()]
param(
  [string] $NodeExe = ''
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
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

$NodeExe = Resolve-NodeExe -Explicit $NodeExe
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
  Write-Host 'SKIP  host-arm-e2e: no node.exe found; pass -NodeExe, set DSH_SELFCHECK_NODE, or put node.exe on PATH'
  exit 0
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-arm-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$imageName = 'dsharm-dummy-' + $PID
$exePath = Join-Path $tempRoot ($imageName + '.exe')
Copy-Item -LiteralPath $NodeExe -Destination $exePath -Force
$stateDir = Join-Path $tempRoot 'state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$standIns = New-Object System.Collections.Generic.List[object]
function Start-StandIn {
  $p = Start-Process -FilePath $exePath -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
  $script:standIns.Add($p)
  Start-Sleep -Milliseconds 600
  return $p
}
function Get-StandIn { @(Get-Process -Name $imageName -ErrorAction SilentlyContinue) }

try {
  Start-StandIn | Out-Null
  Start-StandIn | Out-Null
  Assert-Check 'two stand-ins are running' ((Get-StandIn).Count -eq 2) ("count=" + (Get-StandIn).Count)

  # Drive the real Host arming path from Node, with the plan pointed at the stand-in.
  # Paths arrive as argv: embedding Windows backslash paths in a here-string would
  # let PowerShell turn them into escape sequences.
  $packageUrl = 'file:///' + ($packageRoot -replace '\\', '/')
  $script = @"
const host = await import('$packageUrl/index.js')
const stateDir = process.argv[2]
const exePath = process.argv[3]
const config = host.resolveConfig({ graceMs: 3000, dryRun: false, relaunch: true })
const supervisor = host.resolveSupervisorScript()
const plan = await host.buildRestartPlan(config, stateDir, supervisor)
plan.exe = exePath
plan.stateDir = stateDir
plan.logPath = stateDir + '\\restart.log'
plan.resultPath = stateDir + '\\restart-result.json'
const runtime = host.resolveSupervisorRuntime({})
const spawned = await host.spawnSupervisor(plan, runtime)
console.log(JSON.stringify({ supervisorScript: plan.supervisorScript, spawned, stateDir }))
"@
  $scriptPath = Join-Path $tempRoot 'arm.mjs'
  Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
  $out = & $NodeExe $scriptPath $stateDir $exePath 2>&1 | Out-String
  Write-Host ("  node: " + $out.Trim())
  $parsed = $out.Trim() -split "`n" | Select-Object -Last 1 | ConvertFrom-Json
  Assert-Check 'buildRestartPlan resolves the PowerShell supervisor' ($parsed.supervisorScript -like '*restart-supervisor.ps1') $parsed.supervisorScript
  Assert-Check 'spawnSupervisor arms through WMI, outside the Host process tree' ($parsed.spawned.spawned -eq $true -and $parsed.spawned.via -eq 'wmi') ($parsed.spawned | ConvertTo-Json -Compress)

  # Regression: on Windows a `detached: true` child STILL dies with its Node
  # parent, so the supervisor is created through WMI. This
  # negative control proves the distinction the fix relies on.
  $detachScript = @"
import { spawn } from 'node:child_process'
const [marker, mode] = process.argv.slice(2)
const ps = 'powershell.exe'
const argv = ['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command', 'Start-Sleep -Seconds 2; Add-Content -LiteralPath ' + JSON.stringify(marker) + ' -Value ok']
if (mode === 'start') {
  const c = spawn('cmd.exe', ['/c','start','','/min', ps, ...argv], { detached: true, stdio: 'ignore', windowsHide: true })
  c.unref()
} else {
  const c = spawn(ps, argv, { detached: true, stdio: 'ignore', windowsHide: true })
  c.unref()
}
process.exit(0)
"@
  $detachPath = Join-Path $tempRoot 'detach.mjs'
  Set-Content -LiteralPath $detachPath -Value $detachScript -Encoding UTF8
  $plainMarker = Join-Path $tempRoot 'plain.marker'
  $startMarker = Join-Path $tempRoot 'start.marker'
  & $NodeExe $detachPath $plainMarker plain | Out-Null
  & $NodeExe $detachPath $startMarker start | Out-Null
  # Each helper waits 2s before writing its marker. The wait below is generous on
  # purpose: it must be long enough for a surviving child to finish on a loaded
  # machine (otherwise the positive control goes flaky), and a longer wait only
  # makes the negative control stricter.
  Start-Sleep -Seconds 8
  Assert-Check 'negative control: a plain detached child dies with its parent' (-not (Test-Path -LiteralPath $plainMarker)) 'no marker (detached alone is not enough)'
  Assert-Check 'cmd /c start also survives a parent exit' (Test-Path -LiteralPath $startMarker) 'marker written'
  $indexSource = Get-Content -LiteralPath (Join-Path $packageRoot 'index.js') -Raw
  Assert-Check 'spawnSupervisor launches through WMI' ($indexSource -match 'Win32_Process') 'index.js must keep the WMI launcher'

  # The armed supervisor stops the stand-ins and starts exactly one replacement.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $stateDir 'restart-result.json'))) { Start-Sleep -Milliseconds 500 }
  $resultPath = Join-Path $stateDir 'restart-result.json'
  Assert-Check 'the armed supervisor wrote a result file' (Test-Path -LiteralPath $resultPath) $resultPath
  if (Test-Path -LiteralPath $resultPath) {
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Assert-Check 'the armed supervisor relaunched the app' ($result.ok -eq $true -and $result.phase -in @('relaunched','relaunched-no-window')) ($result | ConvertTo-Json -Compress)
  } else {
    Assert-Check 'the armed supervisor relaunched the app' $false 'no result'
  }
  Assert-Check 'exactly one stand-in is left running' ((Get-StandIn).Count -eq 1) ("count=" + (Get-StandIn).Count)
} finally {
  foreach ($p in @(Get-StandIn)) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("{0}/{1} host-arm checks passed" -f ($results.Count - $failures), $results.Count)
exit $(if ($failures -eq 0) { 0 } else { 1 })
