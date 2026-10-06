<#
.SYNOPSIS
  Optional tray host for the dsh-plugin-restart plugin: "Restart DSH" from the
  Windows notification area.

.DESCRIPTION
  This is a second, independent restart path. The in-app button already restarts
  DSH on its own (the Host plugin spawns a detached supervisor). The tray is for
  when the Host cannot do it itself, and it is the only authority that acts on
  the trigger file the Host writes when a supervisor arm fails.

  Behaviour:
    * starts DSH when it is not running,
    * "Restart DSH" stops the app tree and relaunches it,
    * honours <state dir>\restart-request.json only when the request is NEWER than
      this tray's start (nothing deletes the file, so a blind mtime check would
      replay the last request on every launch and kill a healthy app),
    * "Exit tray" closes the tray without touching DSH,
    * single instance: a second copy exits immediately instead of adding a second
      restart authority.

  Process control lives in tray-functions.ps1, which is dot-sourced so the
  terminate/relaunch logic can be verified without a GUI (see
  tests\tray-selfcheck.ps1).

.PARAMETER Exe
  Full path of the DSH executable. Defaults to the per-user desktop install.

.PARAMETER NoStart
  Do not start DSH when the tray launches.

.EXAMPLE
  # No console window: launch through a hidden host (see README).
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<path to this repo>\dsh-plugin-restart\tray\tray-host.ps1' -WindowStyle Hidden"
#>
[CmdletBinding()]
param(
  [string] $Exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe",
  [switch] $NoStart
)

$ErrorActionPreference = 'Stop'

function Write-BootFailure {
  param([string] $Message)
  # The console is hidden by design, and the state directory may not exist yet, so
  # a startup failure is recorded where it can still be found.
  try {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-restart-tray-boot.log'
    Add-Content -LiteralPath $path -Value ("[{0}] {1}" -f (Get-Date).ToString('s'), $Message) -Encoding UTF8
  } catch { }
}

try {
  $scriptPath = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  if ([string]::IsNullOrWhiteSpace($scriptPath)) { throw 'cannot resolve the tray script directory ($PSScriptRoot is empty)' }
  $functionsPath = Join-Path $scriptPath 'tray-functions.ps1'
  if (-not (Test-Path -LiteralPath $functionsPath)) { throw "missing dependency: $functionsPath" }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  # Single instance: one tray, one restart authority.
  $mutex = New-Object System.Threading.Mutex($false, 'Global\dsh-plugin-restart-tray')
  if (-not $mutex.WaitOne(0)) {
    Write-BootFailure 'another tray instance is already running; this one exits'
    exit 0
  }

  . $functionsPath

  # NOT `$home`: PowerShell's $HOME is a read-only automatic variable and names
  # are case-insensitive, so assigning it aborts the whole script at startup.
  $dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME.Trim() }
  $stateDir = Join-Path $dshHome 'dsh-plugin-restart'
  if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
  $logPath = Join-Path $stateDir 'tray.log'
  $triggerPath = Join-Path $stateDir 'restart-request.json'
  $resultPath = Join-Path $stateDir 'restart-result.json'
  $trayStartedAt = (Get-Date).ToUniversalTime()
  $exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)

  function Write-TrayLog {
    param([string] $Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString('s'), $Message
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
  }

  # Route the helper layer's diagnostics into the log: the console is hidden.
  function Write-TrayDiag {
    param([string] $Message)
    Write-TrayLog $Message
  }

  $script:restartBusy = $false

  function Invoke-DshRestart {
    param([string] $Reason = 'menu')
    if ($script:restartBusy) {
      Write-TrayLog 'restart already in progress; request ignored'
      return
    }
    $script:restartBusy = $true
    $startedAt = (Get-Date).ToString('o')
    try {
      Write-TrayLog "restart requested ($Reason)"
      $result = Restart-App -Exe $Exe
      Write-TrayLog ("restart outcome: ok={0} phase={1} reason={2}" -f $result.ok, $result.phase, $result.reason)
      if (-not $result.ok -and $null -ne $notify) {
        try { $notify.ShowBalloonTip(4000, 'DSH restart failed', [string]$result.reason, [System.Windows.Forms.ToolTipIcon]::Warning) } catch { }
      }
      try {
        $directory = Split-Path -Parent $resultPath
        if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        $payload = [pscustomobject]@{
          schemaVersion = 1
          startedAt     = $startedAt
          finishedAt    = (Get-Date).ToString('o')
          ok            = [bool]$result.ok
          phase         = [string]$result.phase
          reason        = $result.reason
          relaunchedPid = $null
          by            = 'tray'
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText($resultPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
      } catch {
        Write-TrayLog "result write failed: $($_.Exception.Message)"
      }
    } catch {
      Write-TrayLog "restart threw: $($_.Exception.Message)"
    } finally {
      $script:restartBusy = $false
    }
  }

  function New-TrayArtwork {
    # A 16x16 restart glyph drawn in memory, so the tray needs no extra asset.
    $bitmap = New-Object System.Drawing.Bitmap 16, 16
    $hicon = [IntPtr]::Zero
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 77, 107, 254)), 2.2
      $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 77, 107, 254))
      try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.DrawArc($pen, 3, 3, 10, 10, -40, 300)
        $graphics.FillPolygon($brush, @(
            (New-Object System.Drawing.Point 11, 1),
            (New-Object System.Drawing.Point 15, 4),
            (New-Object System.Drawing.Point 10, 6)
          ))
      } finally {
        $graphics.Dispose()
        $pen.Dispose()
        $brush.Dispose()
      }
      $hicon = $bitmap.GetHicon()
      # Icon.FromHandle does NOT own the handle: it stays alive for the
      # NotifyIcon's lifetime and must be released explicitly with DestroyIcon.
      $icon = [System.Drawing.Icon]::FromHandle($hicon)
    } catch {
      $bitmap.Dispose()
      throw
    }
    return @{ Icon = $icon; Bitmap = $bitmap; HIcon = $hicon }
  }

  if (-not ('DshRestartTrayNative' -as [type])) {
    Add-Type -Namespace DshRestartTray -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)] public static extern bool DestroyIcon(System.IntPtr handle);' -ErrorAction Stop
  }

  $art = New-TrayArtwork
  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = $art.Icon
  $notify.Text = 'DSH restart tray'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $itemStart = $menu.Items.Add('启动 DSH / Start DSH')
  $itemRestart = $menu.Items.Add('重启 DSH / Restart DSH')
  $itemStatus = $menu.Items.Add('状态 / Status')
  $itemStatus.Enabled = $false
  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $itemExit = $menu.Items.Add('退出托盘 / Exit tray')

  $itemStart.add_Click({
      if (-not (Test-AppRunning -Name $exeName)) {
        if (Start-AppProcess -Exe $Exe) { Write-TrayLog "started '$Exe'" } else { Write-TrayLog "start failed for '$Exe'" }
      }
    })
  $itemRestart.add_Click({ Invoke-DshRestart -Reason 'menu' })
  $itemExit.add_Click({
      Write-TrayLog 'tray exiting'
      $notify.Visible = $false
      $notify.Dispose()
      [System.Windows.Forms.Application]::ExitThread()
    })

  function Update-TrayStatus {
    $procs = @(Get-AppProcess -Name $exeName)
    $running = $procs.Count -gt 0
    $itemStatus.Text = if ($running) { "DSH 运行中（$($procs.Count) 个进程）/ running" } else { 'DSH 未运行 / not running' }
    $notify.Text = if ($running) { 'DSH restart tray · running' } else { 'DSH restart tray · stopped' }
  }

  $notify.ContextMenuStrip = $menu
  $notify.add_MouseDoubleClick({
      if ($_.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
      if (Test-AppRunning -Name $exeName) { Invoke-DshRestart -Reason 'double-click' } else { Start-AppProcess -Exe $Exe | Out-Null }
    })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 2000
  $timer.add_Tick({
      try {
        Update-TrayStatus
        # Only a request NEWER than this tray's start is honoured, and a handled
        # trigger is consumed: nothing else deletes the file.
        $request = Read-RestartTrigger -Path $triggerPath -NotBefore $trayStartedAt
        if ($null -ne $request) {
          Write-TrayLog ("restart-request.json accepted (requestedAt={0}, armedBy={1})" -f $request.requestedAt, $request.armedBy)
          Remove-RestartTrigger -Path $triggerPath | Out-Null
          Invoke-DshRestart -Reason 'host-trigger'
        }
      } catch {
        Write-TrayLog "tick failed: $($_.Exception.Message)"
      }
    })
  $timer.Start()
  Update-TrayStatus

  if (-not $NoStart) {
    if (Start-AppProcess -Exe $Exe) { Write-TrayLog "started '$Exe'" }
  }
  Write-TrayLog "tray host started (exe=$Exe, noStart=$($NoStart.IsPresent))"

  try {
    [System.Windows.Forms.Application]::Run()
  } finally {
    $timer.Stop()
    $timer.Dispose()
    $notify.Visible = $false
    $notify.Dispose()
    $art.Bitmap.Dispose()
    $art.Icon.Dispose()
    if ($art.HIcon -ne [IntPtr]::Zero) {
      try { [DshRestartTray.Native]::DestroyIcon($art.HIcon) | Out-Null } catch { }
    }
    Write-TrayLog 'tray host stopped'
  }
} catch {
  Write-BootFailure ("tray host failed to start: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
  throw
} finally {
  if ($null -ne $mutex) { try { $mutex.ReleaseMutex() } catch { } ; $mutex.Dispose() }
}
