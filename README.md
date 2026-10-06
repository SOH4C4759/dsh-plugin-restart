# dsh-plugin-restart · 一键重启 DSH

[![CI](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> English: [README.en.md](README.en.md)

插件迭代后，**点一下界面上的「重启 DSH」按钮**，整个 DeepSeek Harness 桌面应用（Electron 外壳 + Host）会退出并自动重新启动，让刚重建的插件包、组合（bundle）、preset 立即生效。

- **左下角头像/设置那一排**的图标按钮（`sidebar.footer.action`，`order: 10`）：纯图标、无文字，悬停有提示，点击后一个**极简确认框**（一句标题 + 取消/立即重启）。
- 可选：`tray/tray-host.ps1` 提供 Windows 托盘入口「重启 DSH」，不依赖界面也能重启/拉起。

本包**不修改 DSH 源码、不需要 fork**：它是一个标准 profile bundle（`dsh.bundle.patch` + `dsh.client`），装进当前 profile 即可。

## 环境要求

| 项 | 要求 | 为什么 |
|---|---|---|
| 操作系统 | Windows 10 / 11 | 守护脚本用 `Get-Process` / `Start-Process` / `taskkill` / WMI `Win32_Process.Create`，均为 Windows 专有 |
| Shell | **Windows PowerShell 5.1**（`powershell.exe`） | `lib/restart-supervisor.ps1` 声明 `#requires -Version 5.1`；Host 默认就以 `powershell.exe` 启动守护脚本（可用 `DSH_POWERSHELL` 覆盖）。**未适配 pwsh 7** |
| Node | ≥ 20（仅用于自检脚本） | 插件本体在 DSH 内运行，不需要额外的 Node 运行时 |
| DSH | 桌面版（Electron 外壳） | 一键重启的对象是「应用 + Host」，纯 Web/CLI 形态没有可重启的外壳 |

`package.json` 里声明了 `"os": ["win32"]`，在其它平台上安装会被包管理器直接拒绝。

## 为什么必须这么做（进程模型约束）

| 事实 | 后果 |
|---|---|
| 桌面端 Host 是 Electron 主进程的子进程，主进程把 Host 的退出一律当作崩溃（`dsh desktop host stopped`），并弹出原生对话框「DeepSeek Harness 无法使用」+ Windows 系统提示音 | 「只重启 Host」必然弹框；**杀进程的顺序也必须先杀 Electron 主进程**（见第 6 节），否则每次一键重启都会闪一个对话框 |
| 官方菜单里的「重启应用与 Host」被编译在 `development` 开关后面（正式版构建不暴露） | 界面/菜单没有可用重启入口 |
| Host 进程无法让父进程 `app.relaunch()`，也无法在自身被拆掉后继续干活 | 需要**脱离进程的守护者** |

### Windows 上「脱离进程」的实测结论（都踩过坑，改动前先读）

1. **`spawn(exe, args, { detached: true, stdio: 'ignore' })` 不足以让子进程在父进程退出后存活。**
   实测：父进程退出后，detached 子进程的标记文件**从未生成**；同样内容经 `cmd /c start` 启动则生成。早期版本的守护脚本因此「杀掉了旧应用，却没能启动新应用」——日志停在 `processes after stop = 0` 之后。
2. **`cmd /c start` 一旦 stdout 被捕获就会永久阻塞。** 实测：裸调用 35ms 返回；`| Out-Null` 或 `| ForEach-Object` 下无限挂起（`start` 不退出，管道等不到 EOF）。
3. 因此守护进程改用 **WMI 创建**（`Win32_Process.Create`）：由 WMI 服务在**本进程树与句柄继承之外**创建，调用立即返回。实现见 `index.js` 的 `spawnSupervisor`（命令行经 base64 临时文件传递，避免 `-Command` 吞引号）。
4. **拉起 GUI 应用用 `Start-Process`，并且要等窗口，而不是只等进程。**
   实测：在隐藏控制台里启动应用，进程起来了但**没有可见窗口**——用户看到的就是「客户端没被拉起」。守护脚本现在轮询 `MainWindowHandle`：拿到窗口才算 `phase: relaunched`；20 秒内没窗口则记为 `relaunched-no-window`（诚实反映异常，而不是谎报成功）。

守护脚本（`lib/restart-supervisor.ps1`）的顺序：等待触发 → **先校验 exe 存在**（绝不关闭一个无法重新启动的应用）→ 列出将要终止的进程 → **先单独终止应用根进程（Electron 主进程）并确认它已消失** → 再按镜像名 `taskkill /F` 处理其余进程 → 有界等待到全部消失 → 启动**恰好一个**实例 → 等窗口 → 写 `restart-result.json`（无 BOM，Node 的 `JSON.parse` 才能读）。

> 关于「等待」：HTTP 应答与守护脚本启动之间的延迟 `armDelayMs` 由 **Host 侧** `setTimeout` 完成（`index.js` 的 `apply()`），不通过命令行传给守护脚本——守护脚本多等一秒就会被用户感知成「点了没反应」。`spawnSupervisor` 只传 `-Exe / -GraceMs / -StateDir / -LogPath / -ResultPath`。

### 5. 守护进程的控制台窗口必须在创建时就隐藏

WMI 创建的进程会**分配一个新的控制台**。命令行里的 `-WindowStyle Hidden` 是 PowerShell 启动**之后**才生效的，所以窗口会先以可见状态创建、再被隐藏——用户看到的就是每次重启动一下的命令行窗口。做法是给 `Win32_Process.Create` 传一个 `Win32_ProcessStartup` 并把 `ShowWindow` 设为 `0`（SW_HIDE），让控制台**创建时就是隐藏的**。

实测边界（Windows 11 + PowerShell 5.1）：

| 做法 | 控制台可见 | 进程是否正常执行 |
|---|---|---|
| 不传 startup info | **可见** | 是 |
| 命令行 `-WindowStyle Hidden` | 隐藏（但创建瞬间会闪） | 是 |
| **`ShowWindow = 0`** | **隐藏，且无闪窗** | 是 |
| `ShowWindow = 0` + `CreateFlags = 1` | — | **否：进程起来了但从不执行载荷** |
| `ShowWindow = 0` + `CreateFlags = 0x08000000` | — | 否：`Create` 返回 21（参数错误） |

所以**不要**设 `CreateFlags`。另外 `Invoke-CimMethod -ClassName Win32_Process` 无法封送内嵌的 `Win32_ProcessStartup` 对象（报「类型不匹配」），必须走经典 `[wmiclass]'Win32_Process'` 路径。`tests/selfcheck.mjs` 与 `tests/host-arm-e2e.ps1` 都固化了这几条，防止回退。

### 6. 停止顺序必须先杀 Electron 主进程，否则每次都闪一个 Windows 对话框

**现象**：一键重启时会短暂闪出一个白色 Windows 对话框，同时响一声系统提示音。用探针（窗口截图 + 读子控件文字 + WASAPI 分进程声音归因）抓到的是：

```
243185 / 243496  taskkill   逐个杀应用进程
243726  NEW-WINDOW  #32770  «DeepSeek Harness 无法使用»
243818  CAPTURE     标题「DeepSeek Harness 无法使用」正文「应用无法启动或已意外停止。」
                    按钮：退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启
243912  SOUND       pid=0（Windows 系统声音会话）peak=0.1372
```

**原因**：Electron 主进程把 Host 当作自己的孩子监视。守护脚本原来按 `Get-Process` 的返回顺序（PID 升序）逐个 `taskkill`，而 **PID 会被回收，Host 完全可能排在主进程前面**。Host 先死、主进程还活着的那个瞬间，主进程就走「desktop host stopped」的错误处理，弹出上面这个原生框并播放系统音；紧接着主进程自己也被下一个 `taskkill` 杀掉，所以用户只看到「一闪」。

这也是它偶发的原因：主进程恰好先被杀的那几次重启，什么都不会出现。

**做法**：用 `Win32_Process` 的 `ParentProcessId` 建父子映射，找出**应用根进程**（其余应用进程的祖先，即 Electron 主进程），**单独**先 `taskkill /F`，再用 `Wait-AppProcessGone` 轮询确认它真的消失，之后才动其余进程。父映射拿不到时退化为「最早启动的那个进程」——主进程永远是应用树里最先创建的。`tray/tray-functions.ps1` 的 `Stop-ProcessTree` 走同一套逻辑（托盘路径同样会踩这个坑）。

> 为什么不直接用 Host 传进来的 `targetPid`：进程检测失败时它可能就是 Host 自己，按它先杀等于把 bug 装回去；用 OS 的父子关系判断是自洽的，两条入口都适用。`tests/supervisor-e2e.ps1`（case 4）与 `tests/tray-selfcheck.ps1` 都用「父进程 + 同镜像名子进程」复现了这个树形并锁住顺序。

## 安装

```powershell
# 在 DSH 里（推荐）：plugin_manager install_bundle，target = 本目录绝对路径
# 或走桌面端自带 CLI carrier：
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "<你克隆这个仓库的路径>"
```

### 唯一一次人工引导（之后不再需要）

安装后：

- **客户端半（按钮）立即生效**：`sidebar.footer.action` 里会出现 `ui-dsh-restart / dsh-restart`（可用 `cordis_inspect_query` 的 Client `Slots` 确认）。
- **Host 半（重启路由）需要一次应用重启才加载**。三条实测结论，都不要再试：
  1. **Host 半不能热重载**。`plugin_manager set_plugin` 能干净地注销/重挂这一行（路由随禁用消失、启用后回来），但进程内的 ESM 模块缓存会一直交出**第一次 import 的那份代码**。实测：改完磁盘上的 `index.js` 后反复「禁用→启用」，报错栈的行号与文件内容始终是旧版本。
  2. **改包版本也无效**。把 `version` 从 1.0.0 提到 1.0.1 再 `install_bundle`，只会得到 `ambiguous-install`；模块缓存按解析出的标识符缓存，与版本无关。
  3. **profile 里的 `dsh-hmr` 只监视 profile 自身**（`baseDir` = profile 目录），不监视被 `link:` 进来的外部插件目录，所以改外部包也不会触发重载。

  因此请**手动关闭并重新打开 DeepSeek Harness 一次**（托盘 → 退出，或关闭窗口后重新打开）。此后每次插件迭代都只需点按钮。

> **一次教训**：Host 半第一次激活失败时，失败会被这一代进程记住（`fiberPhase: failed`），而磁盘上的修复无法生效——缓存里是旧代码。这一轮就是这样暴露并修掉了两个真实缺陷（cordis 在未 `inject` 时访问 `ctx.parent` 会抛错；locale 服务上并没有 `t`，正确用法是 `ctx.locale.bind(ns)`）。**Host 半的改动必须换进程才能验证。**

#### 引导期的安全顺序（重要）

profile patch 在**你自己的用户目录**里（`$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`），不可能随包交付，所以演练守卫需要你手动加一次。第一次安装时，正在运行的 Host 可能早于你最后一份代码；为避免误点造成「应用被关掉却没有重新拉起」，请**先加守卫再重启**：

```yaml
# $env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml
- id: dsh-plugin-restart
  disabled: false
  config:
    dryRun: true
```

顺序：

1. 写入 `dryRun: true`，**先重启应用**（配置层是热生效的，守卫在旧代码上同样有效：按钮只会返回计划）。
2. 重启后跑下面的自检，确认 `supervisorScript` 指向本包的 `lib/restart-supervisor.ps1`，且 `supervisorRuntime.source` 是 `windows-powershell`（或你显式设置的 `DSH_POWERSHELL`）。
3. 把 `config: dryRun: true` 整段删掉（或改为 `false`），配置层热生效，**不需要再重启**——此后按钮执行真实一键重启。

### 引导后自检（非破坏性）

```powershell
# 计划与运行时证据（不产生任何副作用）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/status `
  -ContentType application/json -Body '{}' -Headers @{ Origin = 'http://127.0.0.1:19387' } |
  Select-Object -ExpandProperty value |
  Select-Object supervisorScript, supervisorSource, supervisorCandidates, supervisorRuntime, target

# 演练：只返回计划，绝不重启
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/restart `
  -ContentType application/json -Body '{"dryRun":true}' -Headers @{ Origin = 'http://127.0.0.1:19387' }
```

`supervisorScript` 必须存在且指向本包的 `lib/restart-supervisor.ps1`；`supervisorRuntime.source` 为 `windows-powershell` 表示守护脚本用系统 PowerShell 5.1 启动，设为 `DSH_POWERSHELL` 时表示用了你指定的解释器。

卸载：`& $dsh plugin --profile desktop remove dsh-plugin-restart`。

## 使用

1. 重建你的插件（`pnpm build` 等）。
2. 点左下角的「重启 DSH」图标 →「立即重启」。
3. 应用自动退出并回来，页面重连后可继续同一会话。
4. 若没回来：看 `%USERPROFILE%\.dsh\dsh-plugin-restart\restart.log` 与 `restart-result.json`，两者都记录了守护脚本每一步。

## 配置（profile 的 `cordis.patch.yml`，可选）

```yaml
- id: dsh-plugin-restart
  name: dsh-plugin-restart
  config:
    enabled: true         # 关闭重启路由（返回 409）
    armDelayMs: 1200      # Host 侧：HTTP 应答与守护脚本启动之间的延迟
    graceMs: 2000         # 等待应用自行退出的时间，超时后强杀进程树
    dryRun: true          # 只返回计划、绝不真正重启（排障用）
    relaunch: false       # false = 不 spawn 守护脚本，改为写触发文件交给托盘处理
    trayTriggerPath: ''   # 默认为 <DSH_HOME>/dsh-plugin-restart/restart-request.json
    supervisorPath: ''    # 覆盖守护脚本路径（一般不用）
    loaderPackageDir: ''  # 覆盖模块加载目录，用于从 link: 之外的布局定位本包
```

触发文件只在**守护脚本启动失败**（或 `relaunch: false`）时写出：如果每条请求都写，常驻托盘就成了与守护脚本赛跑的第二权威，可能在应用刚被拉起时又把它杀掉。

config **不使用 schema**，所有值在 Host 内被钳制到合法区间：手写 patch 写错也只会退化为默认值，不会让 Host 起不来。

## HTTP 面（loopback-only）

两个路由都只接受 `127.0.0.1`/`::1` + 同源（`Origin` 与 `Host` 一致，`Sec-Fetch-Site` 非 cross-site）的 `POST`：

```powershell
# 查看当前重启计划（不产生副作用）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/status -ContentType application/json -Body '{}'
# 演练：只返回计划，不重启
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/restart -ContentType application/json -Body '{"dryRun":true}'
```

## 托盘（可选）

进程控制逻辑单独放在 `tray/tray-functions.ps1`（`Get-AppProcess` / `Test-AppRunning` / `Stop-ProcessTree` / `Start-AppProcess` / `Restart-App` / `Write-RestartResult`），`tray-host.ps1` 只负责通知区图标与菜单——这样「杀进程并重启」这段有风险的逻辑可以被独立验证（见下方自检）。

启动（无控制台窗口，推荐）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<你克隆这个仓库的路径>\tray\tray-host.ps1' -WindowStyle Hidden"
```

托盘双击=重启（未运行则启动），右键有「启动 DSH / 重启 DSH / 状态 / 退出托盘」。它对宿主写出的 `restart-request.json` 只接受**比托盘启动更新**的请求，并在处理后删除该文件——因为没有任何东西会清理它，盲信 mtime 会让每次开机都重放上一次请求、把健康的 DSH 杀掉重启。它也不用 `taskkill /T`（托盘本身可能就是 DSH 的子进程，`/T` 会把托盘自己一起杀掉，留下一个没人拉起的死应用）。日志与结果：`%USERPROFILE%\.dsh\dsh-plugin-restart\tray.log`、`restart-result.json`（无 BOM，Host 的 `JSON.parse` 才能读）。

> 菜单里的中文标签要求 **UTF-8 with BOM**：Windows PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 代码页解码，中文会乱码。改动 `tray/*.ps1` 时请保持 BOM。

## 自检

前置：**Windows 10/11 + Windows PowerShell 5.1**（`powershell.exe`；本包未适配 pwsh 7），以及一个 node.exe（用于构造替身进程；设 `DSH_SELFCHECK_NODE` 或 `-NodeSource` / `-NodeExe` 可显式指定，找不到则报 `SKIP` 并以 0 退出）。

```powershell
# 默认走本机安装目录；其它机器请把 $node 改成本机 node.exe 路径
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node tests\selfcheck.mjs                                                  # 17 项
& $node tests\routes.mjs                                                     # 16 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\supervisor-e2e.ps1  # 18 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\host-arm-e2e.ps1    # 11 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\tray-selfcheck.ps1  # 23 项
```

| 套件 | 运行时 | 条数 | 覆盖 |
|---|---|---|---|
| `tests/selfcheck.mjs` | Node | 17 | manifest/patch/信任门/tokenizer/配置钳制/计划契约/客户端审查结论/样式 token/locale 字典同步/托盘结构/守护进程控制台隐藏/先杀 Electron 主进程 |
| `tests/routes.mjs` | Node | 16 | HTTP 路由契约（假 ctx + 假 req/res，0 副作用） |
| `tests/supervisor-e2e.ps1` | PowerShell 5.1 | 18 | 守护脚本真杀替身进程、按原样重启、写结果、防误杀守卫、no-launch 开关、**父+子树形下的「先杀应用根」顺序** |
| `tests/host-arm-e2e.ps1` | PowerShell 5.1 | 11 | Host 真实 `buildRestartPlan` + `spawnSupervisor` 全链路（WMI 隐藏启动、supervisorPid、替身进程）+ `detached` 反例对照 |
| `tests/tray-selfcheck.ps1` | PowerShell 5.1 | 23 | 托盘进程控制层 + 触发文件契约 + 无 BOM 结果 + **先杀 Electron 主进程** |

合计 **85 项**断言：2 个 Node 套件共 33 项 + 3 个 PowerShell 套件共 52 项。

**换机器 / 上 CI 前必读**（与代码正确性无关，只与运行环境有关）：

- `supervisor-e2e.ps1` / `host-arm-e2e.ps1` 会自动找 node.exe（参数 → `DSH_SELFCHECK_NODE` → PATH → DSH 安装目录 → `$PSHOME`），找不到就 `SKIP`。`host-arm-e2e.ps1` 要求该 node 是 **Node 20+**，因为它要用它 import 真实的 `index.js`。
- `tray-selfcheck.ps1` 默认只验证「镜像名查询路径可用」；要让**本机 DSH 正在运行**成为硬要求，设 `DSH_SELFCHECK_LIVE=1`。
- `host-arm-e2e.ps1` 的 `detached` 反例对照依赖 Windows 实测行为，并固定等待 8 秒，属时序敏感断言。
- 五个套件全部 Windows-only（用到 `Get-Process` / `Start-Process` / `taskkill` / WMI）。
- 含非 ASCII 字面量的 `.ps1` 请保持 **UTF-8 with BOM**（当前只有 `tray/tray-host.ps1`）。

`routes.mjs` 用假 Host 上下文捕获真实注册的两个路由，再用假 `req/res` 驱动它们，覆盖：loopback/同源守卫（403）、方法守卫（405）、`enabled:false`（409）、`dryRun`（200 + 计划）、武装（202）与畸形 body 兜底；武装那一跳由测试专用开关 `DSH_RESTART_NO_ARM=1` 换成桩，**不会启动任何守护进程、也不会写出到真实状态目录**。

`selfcheck.mjs` 里有一条**客户端审查结论回归**：把两轮代码审查发现的每一条（样式必须带 `data-plugin`、武装必须要求 `scheduled === true`、失败不得置 armed、请求必须可中止、弹层必须 CSS 锚定而非 rect 计算、不得 `stopPropagation`、busy 期间不得被外部点击关掉、a11y 与 locale 接线）固化成断言，防止回退。

其中最有价值的一项是**计划契约自检**：它解析 `lib/restart-supervisor.ps1` 的 `param()` 块里脚本真正声明的参数，再断言 `buildRestartPlan()` 都产出、且 `spawnSupervisor` 会把 `-Exe/-GraceMs/-StateDir/-LogPath/-ResultPath` 逐个作为 argv 传下去——开发期就挡住「一边写 `targetPid`、另一边读 `parentPid`」这类只在重启瞬间才炸的字段漂移（本包第一版正是栽在这里）。

三个 PowerShell 套件都用**替身进程**（复制 node.exe 成唯一镜像名后空转）当目标，不会碰正在运行的 DSH；`host-arm-e2e` 走真实 WMI 路径武装，`supervisor-e2e` 用 `-NoRelaunch` 覆盖「只停不启」。托盘自检同样复制成唯一镜像名，因此**绝不可能匹配或杀掉任何真实进程**。

重启应用一次后，还可以用 `scripts\verify-live.mjs` 核对**运行中的 Host** 实际解析出的守护脚本与运行时（只读 `/api/dsh-restart/status`，不重启任何东西）：

```powershell
& $node scripts\verify-live.mjs
```

## 已知边界

- **真实重启不可由代理自测**（重启会杀掉执行测试的进程）。因此仓库内只做非破坏性验证：路由契约、dry-run 计划、信任门、脚本语法、客户端注册。
- `dsh.client.inject` 声明了 `@deepseek-ai/dsh-client-ui-conversation`，用于保证侧边栏页脚插槽所在的 UI 包先于本插件加载；`client.js` 本身只 `require('react')`。
- 界面样式依赖 DSH 内部设计 token（`--dsw-alias-*`），因此跟随宿主主题；这些名字属于宿主内部契约，跨大版本可能改名。
- 生成的客户端 bundle 未压缩，仅为本机开发/自用。
- 强制终止进程树会打断正在运行的任务；会话日志按事件持久化，正常重启后仍可 `--resume`。
- 升级 DSH 后若按钮消失，重新 `install_bundle` 一次即可。

## 许可

[MIT](LICENSE) © 2026 林冠宇 (SOH4C4759) and dsh-plugin-restart contributors
