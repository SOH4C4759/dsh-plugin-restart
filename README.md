# dsh-plugin-restart · 一键重启 DSH

[![CI](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/SOH4C4759/dsh-plugin-restart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> English: [README.en.md](README.en.md)

插件迭代后，**点一下界面上的「重启 DSH」按钮**，整个 DeepSeek Harness 桌面应用（Electron 外壳 + Host）会退出并自动重新启动，让刚重建的插件包、组合（bundle）、preset 立即生效。

- **按钮位置可配置**（`position`，5 个预设）：侧栏页脚（默认）、会话标题栏、输入框工具行、输入框下方、不显示按钮。位置既写在 profile patch 里，也能在**「设置 → 插件 → 一键重启 DSH」这一页**直接改，改完即时生效、不需要重启。
- **回复末尾的自动提示**：Host 收到「插件/组合已变更」的信号后记一个待重启标记；下一轮回复结束时，提示卡直接出现在**这条回复的末尾**（`conversation.chat.turnTail`——DSH 给「完成的一轮回复、动作行之前」的原生席位），一句标题、两个按钮：`稍后` / `立即重启`。它只出现在**最新一轮**上，不会把整段历史都刷一遍；`稍后` 只收起本次，下次插件变更会再出现。
- 默认位置是**左下角头像/设置那一排**的图标按钮（`sidebar.footer.action`，`order: 10`）：纯图标、无文字，悬停有提示，点击后在**侧栏内**（不是窗口角落）弹出确认面板——一句标题 `重启 DSH`、一条弱化的范围备注 `（应用与 Host）`，加 取消 / 立即重启。
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

1. 重建你的插件（`pnpm build` 等），或从「设置 → 插件」安装/更新一个插件包。
2. 下一轮回复结束时，回复末尾会出现提示卡：**插件已更新，重启后生效** → `立即重启`（或 `稍后`）。
   - 也可以在配置的位置点图标按钮 → 确认面板 → `立即重启`。
3. 应用自动退出并回来，页面重连后可继续同一会话。
4. 若没回来：看 `%USERPROFILE%\.dsh\dsh-plugin-restart\restart.log` 与 `restart-result.json`，两者都记录了守护脚本每一步。

### 回复末尾的自动提示（什么时候出现）

Host 只认四种信号，全部来自 DSH 自己发布的事件或已加载模块的实际时间戳，不猜文件内容：

| 信号 | 含义 |
|---|---|
| `plugin-manager/changed` | 本进程里完成了一次管理器操作（装/卸/启停/组合层变化） |
| `plugin-manager/install-state`（`applying`） | 一次安装已经落到文件上 |
| `app-boot/config-reload` | CLI 或手改 patch 后，watcher 把新的 patch 代次并对进 Loader 树 |
| **已加载 Host 入口模块的 `mtime:size` 变了** | **重建了某个 `link:` 安装的插件**——这类改动不产生任何事件，只改磁盘 |

最后一条就是本插件存在的理由：管理器会广播安装，watcher 会广播 patch，但**原地重写一个 linked 插件的 Host 半边什么都不广播**。所以每 3 秒给每个 Loader 条目的入口模块盖一次戳（`mtimeMs:size`），戳变了就记一笔。只盯**入口模块**、不盯整个包目录：浏览器半边是热替换的，盯目录只会报出「重启也修不好」的变化。

命中任一信号 → 写 `<DSH_HOME>\dsh-plugin-restart\pending-restart.json`（记录时间、来源、**写入进程的 pid**）。提示卡在下一轮对话结束时读到它，于是出现在**这条回复的末尾**：

- 只出现在**时间线的最后一轮**：往上的历史轮次不会被反复刷出同一张卡。
- `稍后` 只是给标记补一个 `dismissedAt`，**下次插件变更会重新出现**。
- 重启成功后，新进程启动时会发现标记的 pid 不是自己 → 自动清掉（`pid` 就是「这次改动有没有被重启兑现」的判据；同进程内的插件重载不会误清）。
- 启动后 4 秒内的 `config-reload` 视为开机对账、不记标记，避免一打开应用就弹提示。
- `prompt: false` 时 Host 连标记都不写。

标记只是一个文件，删掉即等于「没有待重启的改动」：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\dsh-plugin-restart\pending-restart.json" -ErrorAction SilentlyContinue
```

### 按钮位置（预设）

| `position` | 落在哪个席位 | 说明 |
|---|---|---|
| `sidebar-footer`（默认） | `sidebar.footer.action` | 左下角、设置按钮旁 |
| `session-header` | `conversation.session.header.utilities` | 会话标题右侧工具区 |
| `composer-input` | `conversation.input.right` | 发送按钮左侧的紧凑控制区 |
| `composer-dock` | `conversation.composer.dock` | 输入框卡片下方的环境条目区 |
| `off` | — | 不显示按钮；回复末尾的提示与本页设置仍可用 |

座位是**运行时偏好**，改完即时生效：四个席位在加载时全部注册，未选中的席位渲染 `null`（没有布局），所以换位置不需要重新注册、更不需要刷新页面。

改法有两条，优先用第一条：

1. **「设置 → 插件 → 一键重启 DSH」页面底部**的「重启按钮位置」，点一下即保存到 `<DSH_HOME>\dsh-plugin-restart\ui-settings.json`。
2. profile patch 的 `position`（作为基线；删掉 `ui-settings.json` 就回到 patch 的值）。

## 配置（profile 的 `cordis.patch.yml`，可选）

```yaml
- id: dsh-plugin-restart
  name: dsh-plugin-restart
  config:
    enabled: true         # 关闭重启路由（返回 409）
    position: sidebar-footer # 按钮位置：sidebar-footer / session-header / composer-input / composer-dock / off
    prompt: true          # 插件变更后在回复末尾提示重启（false = 不记待重启标记）
    watchModules: true    # 每 3 秒给已加载的 Host 入口模块盖戳，重建 linked 插件也能被发现
    armDelayMs: 1200      # Host 侧：HTTP 应答与守护脚本启动之间的延迟
    graceMs: 2000         # 等待应用自行退出的时间，超时后强杀进程树
    dryRun: true          # 只返回计划、绝不真正重启（排障用）
    relaunch: false       # false = 不 spawn 守护脚本，改为写触发文件交给托盘处理
    trayTriggerPath: ''   # 默认为 <DSH_HOME>/dsh-plugin-restart/restart-request.json
    supervisorPath: ''    # 覆盖守护脚本路径（一般不用）
    loaderPackageDir: ''  # 覆盖模块加载目录，用于从 link: 之外的布局定位本包
```

触发文件只在**守护脚本启动失败**（或 `relaunch: false`）时写出：如果每条请求都写，常驻托盘就成了与守护脚本赛跑的第二权威，可能在应用刚被拉起时又把它杀掉。

config **不使用 schema**，所有值在 Host 内被钳制到合法区间：手写 patch 写错也只会退化为默认值，不会让 Host 起不来（`position` 拼错 → 回落到 `sidebar-footer`，按钮不会消失）。

## HTTP 面（loopback-only）

五个路由都只接受 `127.0.0.1`/`::1` + 同源（`Origin` 与 `Host` 一致，`Sec-Fetch-Site` 非 cross-site）的 `POST`：

```powershell
# 查看当前重启计划（不产生副作用）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/status -ContentType application/json -Body '{}'
# 演练：只返回计划，不重启
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/restart -ContentType application/json -Body '{"dryRun":true}'
# 便宜的状态读：按钮位置 + 提示开关 + 待重启标记（不扫进程）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/state -ContentType application/json -Body '{}'
# 改位置 / 关提示
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/settings -ContentType application/json -Body '{"position":"session-header"}'
# 收起本次提示（等同界面上的「稍后」）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/api/dsh-restart/dismiss -ContentType application/json -Body '{}'
```

`/state`、`/settings`、`/dismiss` 的回答形状一致：`{ settings: { position, prompt, updatedAt, source }, pending, enabled, dryRun, relaunch, positions }`。

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

& $node tests\selfcheck.mjs                                                  # 23 项
& $node tests\ui-render.mjs                                                  # 38 项（桩 React 真渲染浏览器半）
& $node tests\ui-render.mjs --bundle <旧版 client.js> --control              # 反向对照：旧版必须失败
& $node tests\routes.mjs                                                     # 32 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\supervisor-e2e.ps1  # 18 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\host-arm-e2e.ps1    # 11 项
powershell -NoProfile -ExecutionPolicy Bypass -File tests\tray-selfcheck.ps1  # 23 项
```

| 套件 | 运行时 | 条数 | 覆盖 |
|---|---|---|---|
| `tests/selfcheck.mjs` | Node | 23 | manifest/patch/信任门/tokenizer/配置钳制/**座位预设归一化**/**UI 偏好优先级**/**待重启标记生命周期**/**三种变更信号接线**/**重建模块的戳变化检测**/计划契约/客户端审查结论/样式 token/locale 字典同步/托盘结构/守护进程控制台隐藏/先杀 Electron 主进程 |
| `tests/ui-render.mjs` | Node (`node:vm`) | 38 | 浏览器半**真渲染**：六个席位、未选中席位渲染 null、纯图标触发、按下后侧栏内嵌面板、标题与弱化备注分离、面板宽度取自侧栏列变量、**回复末尾提示卡（仅最后一轮）**、`稍后` 走后端收起、**插件页设置区（5 个预设 + 开关 + 其它插件页不渲染）**、无 rect 计算（配 `--control` 反向对照） |
| `tests/routes.mjs` | Node | 32 | HTTP 路由契约（假 ctx + 假 req/res，0 副作用）：状态/重启/`state`/`settings`/`dismiss`、座位写入与非法值回落、提示开关、待重启标记与收起 |
| `tests/supervisor-e2e.ps1` | PowerShell 5.1 | 18 | 守护脚本真杀替身进程、按原样重启、写结果、防误杀守卫、no-launch 开关、**父+子树形下的「先杀应用根」顺序** |
| `tests/host-arm-e2e.ps1` | PowerShell 5.1 | 11 | Host 真实 `buildRestartPlan` + `spawnSupervisor` 全链路（WMI 隐藏启动、supervisorPid、替身进程）+ `detached` 反例对照 |
| `tests/tray-selfcheck.ps1` | PowerShell 5.1 | 23 | 托盘进程控制层 + 触发文件契约 + 无 BOM 结果 + **先杀 Electron 主进程** |

合计 **145 项**断言：3 个 Node 套件共 93 项 + 3 个 PowerShell 套件共 52 项。

**换机器 / 上 CI 前必读**（与代码正确性无关，只与运行环境有关）：

- `supervisor-e2e.ps1` / `host-arm-e2e.ps1` 会自动找 node.exe（参数 → `DSH_SELFCHECK_NODE` → PATH → DSH 安装目录 → `$PSHOME`），找不到就 `SKIP`。`host-arm-e2e.ps1` 要求该 node 是 **Node 20+**，因为它要用它 import 真实的 `index.js`。
- `tray-selfcheck.ps1` 默认只验证「镜像名查询路径可用」；要让**本机 DSH 正在运行**成为硬要求，设 `DSH_SELFCHECK_LIVE=1`。
- `host-arm-e2e.ps1` 的 `detached` 反例对照依赖 Windows 实测行为，并固定等待 8 秒，属时序敏感断言。
- 五个套件全部 Windows-only（用到 `Get-Process` / `Start-Process` / `taskkill` / WMI）。
- 含非 ASCII 字面量的 `.ps1` 请保持 **UTF-8 with BOM**（当前只有 `tray/tray-host.ps1`）。

`routes.mjs` 用假 Host 上下文捕获真实注册的五个路由，再用假 `req/res` 驱动它们，覆盖：loopback/同源守卫（403）、方法守卫（405）、`enabled:false`（409）、`dryRun`（200 + 计划）、武装（202）与畸形 body 兜底；`/state`、`/settings`、`/dismiss` 覆盖座位写入、非法座位回落、提示开关、待重启标记与「稍后」；武装那一跳由测试专用开关 `DSH_RESTART_NO_ARM=1` 换成桩，**不会启动任何守护进程、也不会写出到真实状态目录**。

`selfcheck.mjs` 里有一条**客户端审查结论回归**：把两轮代码审查发现的每一条（样式必须带 `data-plugin`、武装必须要求 `scheduled === true`、失败不得置 armed、请求必须可中止、弹层必须 CSS 锚定而非 rect 计算、不得 `stopPropagation`、busy 期间不得被外部点击关掉、a11y 与 locale 接线）固化成断言，防止回退。其中「弹层必须 CSS 锚定」一条在 2026-10-08 被**改写成新结论**：确认面板从「视口左下角的浮窗」改为「侧栏列内嵌面板」，断言随之变为「锚定在触发按钮自己的 wrapper 上、宽度取自侧栏列变量、且仍然不做 rect 计算」。2026-10-19 加入「座位预设」后，这条断言进一步变成「每个座位都有自己的锚点规则（页脚向上贴列、标题栏向下、输入框向上），页脚那条仍取侧栏列变量」。

`ui-render.mjs` 是同一批结论的**行为版**：它把 `client.js` 装进 `node:vm`（桩 React + 桩 `slots`/`locale`/`fetch`），逐个渲染注册出去的组件——先渲染闭合态（纯图标、无文字、`aria-label` 完整），再调用触发按钮的 `onClick` 渲染展开态，然后断言面板落在自己的席位上、标题与备注是两个不同元素、备注不是标题也不是粗体、面板宽度来自 `--dsh-windows-sidebar-width` 与 `--dsh-sidebar-inline-padding`；再用一份「有待重启标记」的桩 `fetch` 渲染回复末尾的提示卡（最后一轮出现、历史轮不出、`稍后` 打到 `/dismiss`），最后渲染插件页设置区（其它插件页面渲染 null、本包页面给出 5 个预设与开关）。它支持 `--bundle <旧版> --control`：旧 bundle 上必须**恰好**在新期望上失败（2026-10-19 实测 9 项），否则说明这套断言恒真、已经失去鉴别力。

其中最有价值的一项是**计划契约自检**：它解析 `lib/restart-supervisor.ps1` 的 `param()` 块里脚本真正声明的参数，再断言 `buildRestartPlan()` 都产出、且 `spawnSupervisor` 会把 `-Exe/-GraceMs/-StateDir/-LogPath/-ResultPath` 逐个作为 argv 传下去——开发期就挡住「一边写 `targetPid`、另一边读 `parentPid`」这类只在重启瞬间才炸的字段漂移（本包第一版正是栽在这里）。

三个 PowerShell 套件都用**替身进程**（复制 node.exe 成唯一镜像名后空转）当目标，不会碰正在运行的 DSH；`host-arm-e2e` 走真实 WMI 路径武装，`supervisor-e2e` 用 `-NoRelaunch` 覆盖「只停不启」。托盘自检同样复制成唯一镜像名，因此**绝不可能匹配或杀掉任何真实进程**。

重启应用一次后，还可以用 `scripts\verify-live.mjs` 核对**运行中的 Host** 实际解析出的守护脚本与运行时（只读 `/api/dsh-restart/status`，不重启任何东西）：

```powershell
& $node scripts\verify-live.mjs
```

## 已知边界

- **真实重启不可由代理自测**（重启会杀掉执行测试的进程）。因此仓库内只做非破坏性验证：路由契约、dry-run 计划、信任门、脚本语法、客户端注册。
- **从 1.0.x 升级到 1.1.0 后需要重启一次**：浏览器半边会随 client-hmr 立刻换成新代码（四个席位立刻出现在 Slot 账本里），但新路由（`/state`、`/settings`、`/dismiss`）与事件监听在 Host 半边，必须换进程才生效。重启前新客户端会读不到 `/state`、把提示功能标成离线——按钮仍然可用，不会出错。
- **回复末尾提示的座位是 `conversation.chat.turnTail`**（DSH 的原生位置：「一轮完成、动作行之前」）。它按**时间线最后一轮**过滤，所以历史轮不会重复弹；换 DSH 大版本时若该席位或 `useChat` 的标准 props 改名，提示会退化——`useChat` 缺失时按「始终是最新一轮」处理，宁可在历史轮里安全地多显示，也不静默消失。
- **「插件变更」的三个事件信号 + 一个文件戳信号**（`plugin-manager/changed`、`plugin-manager/install-state` 的 `applying`、`app-boot/config-reload`，以及每 3 秒给已加载 Host 入口模块盖的 `mtimeMs:size`）。事件描述「变更有发生」，不保证「必须重启」——DSH 的管理器自己还会区分 `restart-required` / `applied`。因此提示的措辞是「重启后生效」，而不是「必须重启」；是否需要重启由你判断，点不点都能继续用。模块戳会有误报（例如构建工具连续重写入口文件），代价只是一张可收起的提示卡。
- 四个触发席位在加载时全部注册、未选中的渲染 `null`。这样换位置是纯数据更新；代价是 Slot 账本里能看到四个 `dsh-restart` 占位（每个都没有布局）。
- 面板在标题栏/输入框这两个席位是**绝对定位的浮层**，会覆盖到会话内容上；如果将来 DSH 给这些行加了 `overflow: hidden`，这两个座位的面板会被裁切（页脚座位是贴侧栏列宽的，不受影响）。遇到这种情况换回 `sidebar-footer` 即可。
- `dsh.client.inject` 声明了 `@deepseek-ai/dsh-client-ui-conversation`，用于保证侧边栏页脚插槽所在的 UI 包先于本插件加载；`client.js` 本身只 `require('react')`。
- 界面样式依赖 DSH 内部设计 token（`--dsw-alias-*`），因此跟随宿主主题；这些名字属于宿主内部契约，跨大版本可能改名。
- **页脚座位**的确认面板宽度取自宿主的侧栏列变量 `--dsh-windows-sidebar-width`（由框架在网格列上发布）与侧栏根定义的 `--dsh-sidebar-inline-padding`，两者都带兜底值（`240px` / `12px`）：变量缺失时面板退化为 216px 宽，不会塌成 0。标题栏/输入框座位改用固定 280px 的卡片（这些行没有可继承的列宽）。这些名字与 `--dsw-alias-*` 同属宿主内部契约，改名时同样只需跟随调整。
- **页脚座位**的面板横向对齐依赖「本插件的 `order: 10` 是页脚动作排里最小的一个」——它注册在 `footerActions` 这一整行 flex 的首位，因此 `left: 0` 就等于侧栏内容列的左缘。若将来有别的插件用更小的 `order` 挤到前面，面板只会整体右移该按钮的宽度，不会错位到侧栏之外。
- 生成的客户端 bundle 未压缩，仅为本机开发/自用。
- 强制终止进程树会打断正在运行的任务；会话日志按事件持久化，正常重启后仍可 `--resume`。
- 升级 DSH 后若按钮消失，重新 `install_bundle` 一次即可。

## 许可

[MIT](LICENSE) © 2026 林冠宇 (SOH4C4759) and dsh-plugin-restart contributors
