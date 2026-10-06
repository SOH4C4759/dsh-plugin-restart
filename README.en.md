# dsh-plugin-restart · one-click DSH restart

[![CI](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 中文文档见 [README.md](README.md)

After you rebuild a plugin, **click the "Restart DSH" button in the UI** and the entire DeepSeek Harness desktop app (Electron shell + Host) exits and relaunches itself, so the freshly built plugin, bundle, or preset is loaded immediately.

- An **icon-only button at the sidebar foot** (`sidebar.footer.action`, `order: 10`), next to the account launcher. Hovering shows a tooltip; clicking opens a one-question confirmation panel (title + Cancel / Restart now).
- Optional: `tray/tray-host.ps1` puts "Restart DSH" in the Windows notification area, so a restart does not depend on the UI being reachable.

This package **does not patch DSH source and does not need a fork**: it is a standard profile bundle (`dsh.bundle.patch` + `dsh.client`) that you install into your own profile.

## Requirements

| Item | Requirement | Why |
|---|---|---|
| OS | Windows 10 / 11 | The supervisor uses `Get-Process`, `Start-Process`, `taskkill`, and WMI `Win32_Process.Create` — all Windows-only |
| Shell | **Windows PowerShell 5.1** (`powershell.exe`) | `lib/restart-supervisor.ps1` declares `#requires -Version 5.1`, and the Host launches it with `powershell.exe` by default (override with `DSH_POWERSHELL`). **pwsh 7 is not supported** |
| Node | ≥ 20 (self-check scripts only) | The plugin itself runs inside DSH and needs no extra Node runtime |
| DSH | Desktop build (Electron shell) | The thing being restarted is "app + Host"; a web-only or CLI-only install has no shell to relaunch |

`package.json` declares `"os": ["win32"]`, so package managers refuse to install it elsewhere.

## Why it has to work this way

| Fact | Consequence |
|---|---|
| The desktop Host is a child process of the Electron main process, and the main process treats *any* Host exit as a crash (`dsh desktop host stopped`) — it answers with a native "DeepSeek Harness unusable" message box plus the Windows system sound | "Restart only the Host" always raises that dialog. **The stop order matters too**: the Electron main must die first (section 6), or every one-click restart flashes a dialog |
| The built-in "Restart App and Host" menu item is compiled behind a `development` flag | A release build exposes no restart entry point |
| A Host process cannot call `app.relaunch()` on its parent, and cannot keep working after it is torn down | You need a **detached supervisor** |

### Windows findings behind the design (all of these were measured; read before changing)

1. **`spawn(exe, args, { detached: true, stdio: 'ignore' })` is not enough for a child to outlive its parent.**
   Measured: after the parent exited, the detached child's marker file was **never written**, while the same payload launched via `cmd /c start` was. The first supervisor therefore killed the old app and failed to start the new one — its log stopped right after `processes after stop = 0`.
2. **`cmd /c start` blocks forever once its stdout is captured.** Measured: a bare call returns in 35 ms, while `| Out-Null` or `| ForEach-Object` hangs indefinitely (`start` never exits, so the pipe never sees EOF).
3. The supervisor is therefore created through **WMI** (`Win32_Process.Create`): the WMI service creates it **outside this process tree and outside its handle inheritance**, and the call returns immediately. See `spawnSupervisor` in `index.js` (the command line travels through a base64 temp file, because `-Command` eats the quoting).
4. **Start a GUI app with `Start-Process` and wait for its window, not just its process.**
   Measured: launched from a hidden console, the process appeared but had **no visible window** — which looks exactly like "the client never came back". The supervisor now polls `MainWindowHandle`: only a window counts as `phase: relaunched`; no window within 20 s is recorded as `relaunched-no-window` (an honest failure, not a fake success).

The supervisor (`lib/restart-supervisor.ps1`) then runs in this order: wait for the trigger → **verify the executable exists first** (never close an app it cannot start again) → list the processes it is about to stop → **stop the app root (the Electron main) on its own and confirm it is gone** → `taskkill /F` the remaining processes by image name → wait a bounded time until they are gone → start **exactly one** instance → wait for its window → write `restart-result.json` (without a BOM, so Node's `JSON.parse` accepts it).

> About the delay: the gap between the HTTP answer and the supervisor starting (`armDelayMs`) is enforced by the **Host** with a `setTimeout` (see `apply()` in `index.js`) and is not passed to the supervisor — a supervisor that waits an extra second feels like "I clicked and nothing happened". `spawnSupervisor` only passes `-Exe / -GraceMs / -StateDir / -LogPath / -ResultPath`.

### 5. The supervisor's console must be hidden at creation, not after start

A WMI-created process is given a **fresh console**. `-WindowStyle Hidden` on the command line is applied only *after* PowerShell has started, so the window is created visible and then hidden — that flash is the command-line window a user sees at the start of every restart. The fix is to pass a `Win32_ProcessStartup` object with `ShowWindow = 0` (SW_HIDE) to `Win32_Process.Create`, which hides the console *before the process exists*.

Measured on Windows 11 + PowerShell 5.1:

| Approach | Console visible | Process runs |
|---|---|---|
| no startup info | **yes** | yes |
| command-line `-WindowStyle Hidden` | hidden (but flashes at creation) | yes |
| **`ShowWindow = 0`** | **hidden, no flash** | yes |
| `ShowWindow = 0` + `CreateFlags = 1` | — | **no: starts but never executes its payload** |
| `ShowWindow = 0` + `CreateFlags = 0x08000000` | — | no: `Create` returns 21 (invalid parameter) |

So do **not** set `CreateFlags`. Note also that `Invoke-CimMethod -ClassName Win32_Process` cannot marshal the embedded `Win32_ProcessStartup` object ("type mismatch"); the classic `[wmiclass]'Win32_Process'` path is required. `tests/selfcheck.mjs` and `tests/host-arm-e2e.ps1` pin all of this so it cannot regress.

### 6. The Electron main process has to be stopped FIRST, or a Windows dialog flashes on every restart

**Symptom**: a one-click restart briefly flashes a white Windows dialog and plays one system notification sound. A probe (window screenshots + child-control text + per-process WASAPI sound attribution) captured exactly this:

```
243185 / 243496  taskkill   stopping the app's processes one by one
243726  NEW-WINDOW  #32770  "DeepSeek Harness unusable"
243818  CAPTURE     title "DeepSeek Harness unusable", body "the application could not
                    start or has stopped unexpectedly", buttons Quit / Restart /
                    Disable third-party plugins, back up the profile patch and restart
243912  SOUND       pid=0 (Windows system-sounds session) peak=0.1372
```

**Cause**: the Electron main watches the Host as its own child. The supervisor used to `taskkill` the processes in `Get-Process` order (ascending PID), and **PIDs are recycled — the Host can sort before the main**. In the instant where the Host is dead and the main is still alive, the main runs its "desktop host stopped" handler, raises that native dialog and plays the system sound; the main is then killed by the next `taskkill` in the same loop, so the user only ever sees a flash.

That is also why it was intermittent: on the restarts where the main happened to sort first, nothing appeared.

**Fix**: build a parent map from `Win32_Process.ParentProcessId`, find the **app root** (the ancestor of every other app process — the Electron main), `taskkill /F` it **on its own**, then poll with `Wait-AppProcessGone` until it is really gone before touching anything else. When the parent map is unavailable the code falls back to the oldest process, because the main is always the first process of its own tree. `Stop-ProcessTree` in `tray/tray-functions.ps1` uses the same logic (the tray path has the same trap).

> Why not use the `targetPid` the Host already computes: when process detection fails that pid can be the Host itself, and killing by it first would put the bug back. Ancestry read from the OS is self-consistent and works for both entry points. `tests/supervisor-e2e.ps1` (case 4) and `tests/tray-selfcheck.ps1` both reproduce the shape (a parent with a child of the same image name) and pin the order.

## Install

```powershell
# Inside DSH (recommended): plugin_manager install_bundle, target = the absolute path of this directory
# Or use the CLI carrier shipped with the desktop app:
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "<path to your clone of this repository>"
```

### The one manual bootstrap step (never needed again)

After installing:

- **The client half (the button) is live immediately**: an entry `ui-dsh-restart / dsh-restart` appears in `sidebar.footer.action` (confirm through `cordis_inspect_query`'s client `Slots`).
- **The Host half (the restart routes) needs one app restart to load.** Three measured facts; do not retry any of them:
  1. **The Host half cannot hot-reload.** `plugin_manager set_plugin` cleanly unregisters and remounts the row (the routes disappear and come back), but the in-process ESM module cache keeps handing out **the code from the first import**. Measured: after editing `index.js` on disk, repeated disable/enable cycles kept reporting the old line numbers and the old source.
  2. **Bumping the package version does not help.** Raising `version` from 1.0.0 to 1.0.1 and reinstalling only produces `ambiguous-install`; the module cache is keyed by the resolved specifier, not the version.
  3. **`dsh-hmr` in the profile only watches the profile itself** (`baseDir` = the profile directory), not the external plugin directory linked in with `link:`, so editing the external package triggers no reload.

  So **close and reopen DeepSeek Harness once** (tray → Exit, or close the window and reopen). After that, every plugin iteration is one click.

> **One lesson worth keeping**: when the Host half fails to activate, that failure is remembered for the life of the process (`fiberPhase: failed`), and any on-disk fix stays inert because the cache holds the old code. That is exactly how two real defects surfaced here (cordis throws when `ctx.parent` is read without `inject`; the locale service has no `t`, the correct call is `ctx.locale.bind(ns)`). **A Host-half change can only be verified in a new process.**

#### Safe order for the bootstrap (important)

The profile patch lives in **your own user directory** (`$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`) and can never ship with this package, so add the dry-run guard yourself. On first install the running Host may predate your latest code; so that a misclick cannot leave the app closed with nothing to start it, **add the guard before you restart**:

```yaml
# $env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml
- id: dsh-plugin-restart
  disabled: false
  config:
    dryRun: true
```

Then:

1. Keep `dryRun: true` and **restart the app first**. Config layers are live, and the guard works on the old code too: the button only returns a plan.
2. After the restart, run the self-check below and confirm `supervisorScript` points at this package's `lib/restart-supervisor.ps1` and `supervisorRuntime.source` is `windows-powershell` (or `DSH_POWERSHELL` if you set it).
3. Delete the `config: dryRun: true` block (or set it to `false`). Config layers are live, so **no second restart is needed** — from then on the button performs a real one-click restart.

### Post-bootstrap self-check (non-destructive)

```powershell
# Plan and runtime evidence (no side effects)
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/status `
  -ContentType application/json -Body '{}' -Headers @{ Origin = 'http://127.0.0.1:19387' } |
  Select-Object -ExpandProperty value |
  Select-Object supervisorScript, supervisorSource, supervisorCandidates, supervisorRuntime, target

# Dry run: returns the plan and never restarts
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/restart `
  -ContentType application/json -Body '{"dryRun":true}' -Headers @{ Origin = 'http://127.0.0.1:19387' }
```

`supervisorScript` must exist and point at this package's `lib/restart-supervisor.ps1`. `supervisorRuntime.source` is `windows-powershell` when the supervisor runs under system PowerShell 5.1, or `DSH_POWERSHELL` when you supplied your own interpreter.

Uninstall: `& $dsh plugin --profile desktop remove dsh-plugin-restart`.

## Usage

1. Rebuild your plugin (`pnpm build` or similar).
2. Click the restart icon at the sidebar foot → "Restart now".
3. The app exits and comes back; the page reconnects and you can continue the same session.
4. If it does not come back, read `%USERPROFILE%\.dsh\dsh-plugin-restart\restart.log` and `restart-result.json` — both record every supervisor step.

## Configuration (optional, in the profile's `cordis.patch.yml`)

```yaml
- id: dsh-plugin-restart
  name: dsh-plugin-restart
  config:
    enabled: true         # false disables the restart routes (they answer 409)
    armDelayMs: 1200      # Host side: delay between the HTTP answer and the supervisor launch
    graceMs: 2000         # how long the app may exit on its own before its tree is force-killed
    dryRun: true          # return the plan only, never restart (troubleshooting)
    relaunch: false       # false = do not spawn the supervisor; write the trigger file for the tray
    trayTriggerPath: ''   # defaults to <DSH_HOME>/dsh-plugin-restart/restart-request.json
    supervisorPath: ''    # override the supervisor script path (rarely needed)
    loaderPackageDir: ''  # override the module-loading directory used to locate this package
```

The trigger file is written **only** when the supervisor fails to launch (or when `relaunch: false`). Writing it on every request would make a resident tray a second authority racing the supervisor, and it could kill the app right after the supervisor brought it back.

The config **uses no schema**: every value is clamped to its legal range inside the Host, so a hand-edited patch can only fall back to a default — it can never stop the Host from booting.

## HTTP surface (loopback only)

Both routes accept only `POST` from `127.0.0.1`/`::1` with a same-origin `Origin` (matching `Host`, and `Sec-Fetch-Site` not `cross-site`):

```powershell
# Current restart plan (no side effects)
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/status -ContentType application/json -Body '{}'
# Dry run: return the plan, do not restart
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/restart -ContentType application/json -Body '{"dryRun":true}'
```

## Tray (optional)

Process control lives in its own file, `tray/tray-functions.ps1` (`Get-AppProcess` / `Test-AppRunning` / `Stop-ProcessTree` / `Start-AppProcess` / `Restart-App` / `Write-RestartResult`); `tray-host.ps1` only owns the notification icon and its menu. That way the risky "kill the tree and relaunch" logic can be verified on its own (see the self-checks below).

Launch it (no console window — recommended):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<path to your clone>\tray\tray-host.ps1' -WindowStyle Hidden"
```

Double-click restarts (or starts, if not running); the right-click menu offers Start / Restart / Status / Exit tray. It honours `restart-request.json` only when the request is **newer than the tray's own start**, and deletes the file after handling it — nothing else ever cleans it up, so blindly trusting its mtime would replay the previous request on every boot and kill a healthy DSH. It also avoids `taskkill /T`, because the tray itself may be a child of DSH and `/T` would kill the tray along with it, leaving a dead app with nothing to start it. Log and result: `%USERPROFILE%\.dsh\dsh-plugin-restart\tray.log` and `restart-result.json` (no BOM, so the Host's `JSON.parse` accepts it).

> The menu labels are Chinese and therefore require **UTF-8 with BOM**: Windows PowerShell 5.1 decodes BOM-less UTF-8 with the ANSI code page and shows mojibake. Keep the BOM when you edit `tray/*.ps1`.

## Self-checks

Prerequisites: **Windows 10/11 + Windows PowerShell 5.1** (`powershell.exe`; pwsh 7 is not supported), plus a node.exe used to stage inert stand-in processes. Point at one explicitly with `DSH_SELFCHECK_NODE` or `-NodeSource` / `-NodeExe`; when none is found the suite prints `SKIP` and exits 0.

```powershell
# Defaults to the local desktop install; on another machine, point $node at your node.exe
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node tests\selfcheck.mjs                                                  # 17 checks
& $node tests\routes.mjs                                                     # 16 checks
powershell -NoProfile -ExecutionPolicy Bypass -File tests\supervisor-e2e.ps1  # 18 checks
powershell -NoProfile -ExecutionPolicy Bypass -File tests\host-arm-e2e.ps1    # 11 checks
powershell -NoProfile -ExecutionPolicy Bypass -File tests\tray-selfcheck.ps1  # 23 checks
```

| Suite | Runtime | Checks | Covers |
|---|---|---|---|
| `tests/selfcheck.mjs` | Node | 17 | manifest/patch/trust gate/tokenizer/config clamping/plan contract/client review regressions/style tokens/locale parity/tray structure/hidden supervisor console/Electron main stopped first |
| `tests/routes.mjs` | Node | 16 | HTTP route contract (fake ctx + fake req/res, zero side effects) |
| `tests/supervisor-e2e.ps1` | PowerShell 5.1 | 18 | the supervisor really stops stand-ins, relaunches as-is, writes its result, refuses a missing exe, `-NoRelaunch`, **the app root stopped first in a parent/child tree** |
| `tests/host-arm-e2e.ps1` | PowerShell 5.1 | 11 | the real `buildRestartPlan` + `spawnSupervisor` path (hidden WMI start, supervisorPid, stand-ins) plus the `detached` negative control |
| `tests/tray-selfcheck.ps1` | PowerShell 5.1 | 23 | tray process-control layer, trigger-file contract, BOM-less result, **the Electron main stopped first** |

**85 checks total**: 33 across the two Node suites plus 52 across the three PowerShell suites.

**Read this before running on another machine or in CI** (environment only, nothing to do with correctness):

- `supervisor-e2e.ps1` / `host-arm-e2e.ps1` discover node.exe themselves (argument → `DSH_SELFCHECK_NODE` → `PATH` → DSH install → `$PSHOME`) and print `SKIP` when none is found. `host-arm-e2e.ps1` needs **Node 20+**, because it uses that interpreter to import the real `index.js`.
- `tray-selfcheck.ps1` only verifies that the image-name query path works by default; set `DSH_SELFCHECK_LIVE=1` to require a **running** DSH desktop app.
- `host-arm-e2e.ps1`'s `detached` negative control depends on measured Windows behaviour and waits a fixed 8 seconds, so it is timing-sensitive.
- All five suites are Windows-only (`Get-Process` / `Start-Process` / `taskkill` / WMI).
- Keep `.ps1` files that contain non-ASCII literals as **UTF-8 with BOM** (currently only `tray/tray-host.ps1`).

`routes.mjs` captures the two really-registered routes from a fake Host context and drives them with fake `req`/`res` objects. It covers the loopback/same-origin guard (403), the method guard (405), `enabled:false` (409), `dryRun` (200 + plan), arming (202), and a malformed body. The arming hop is replaced by a stub through the test-only `DSH_RESTART_NO_ARM=1`, so **no supervisor is ever launched and nothing is written to the real state directory**.

`selfcheck.mjs` contains a **client review-regression block** that turns every finding from two rounds of review into an assertion (styles must carry `data-plugin`, arming must require `scheduled === true`, a failure must not arm, requests must be abortable, the panel must be CSS-anchored rather than rect-measured, no `stopPropagation`, an outside click must not dismiss a busy panel, a11y and locale wiring), so none of them can regress silently.

The most valuable single check is the **plan contract**: it parses the `param()` block of `lib/restart-supervisor.ps1` for the parameters the script really declares, then asserts that `buildRestartPlan()` produces them and that `spawnSupervisor` passes `-Exe/-GraceMs/-StateDir/-LogPath/-ResultPath` through as argv. That catches "one side writes `targetPid`, the other reads `parentPid`" at development time instead of at the moment of a restart — which is exactly where this package's first version failed.

All three PowerShell suites target **stand-in processes** (a copy of node.exe under a unique image name, idling), so the running DSH is never touched; `host-arm-e2e` arms through the real WMI path, and `supervisor-e2e` uses `-NoRelaunch` to cover "stop only". The tray self-check also stages a uniquely named copy, so it can **never** match or kill a real process.

After one app restart you can also ask the **running Host** what it resolved, using `scripts\verify-live.mjs` (it only reads `/api/dsh-restart/status` and restarts nothing):

```powershell
& $node scripts\verify-live.mjs
```

## Known limits

- **A real restart cannot be self-tested by an agent** (the restart kills the process running the tests). The repository therefore ships non-destructive verification only: route contract, dry-run plan, trust gate, script syntax, client registration.
- `dsh.client.inject` declares `@deepseek-ai/dsh-client-ui-conversation` to ensure the UI package that provides the sidebar-footer slot loads before this plugin; `client.js` itself only requires `react`.
- The UI styles depend on DSH's internal design tokens (`--dsw-alias-*`) so they follow the host theme. Those names are an internal host contract and may be renamed across major versions.
- The generated client bundle is unminified; this is a development/personal-use package.
- Force-killing the process tree interrupts running tasks; session logs are persisted per event, so a normal restart can still `--resume`.
- If the button disappears after a DSH upgrade, run `install_bundle` once more.

## License

[MIT](LICENSE) © 2026 林冠宇 (SOH4C4759) and dsh-plugin-restart contributors
