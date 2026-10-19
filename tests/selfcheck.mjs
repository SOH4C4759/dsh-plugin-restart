/**
 * Non-destructive checks for the dsh-plugin-restart package.
 *
 * Runs with a bare Node (no dependencies) and never restarts anything:
 *   node tests/selfcheck.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const host = await import(pathToFileURL(join(packageRoot, 'index.js')).href)

await check('manifest is a dsh bundle with a patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  return pkg.name
})

await check('manifest declares the web client half', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject))
  assert.ok(existsSync(join(packageRoot, 'client.js')))
  return pkg.dsh.client.inject.join(', ')
})

await check('patch inserts exactly the plugin row', () => {
  const text = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  const rows = [...text.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(rows, ['dsh-plugin-restart'])
  const names = [...text.matchAll(/^\s*name:\s*'([^']+)'\s*$/gm)].map((match) => match[1])
  assert.deepEqual(names, [pkg.name])
  return rows.join(', ')
})

await check('host half exports the loader contract', () => {
  assert.equal(host.name, 'dsh-plugin-restart')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.Config, undefined, 'config is validated manually; no schema should be exported')
  return `inject=${host.inject.join(',')}`
})

await check('the WMI launcher hides the supervisor console', () => {
  // A WMI-created process gets a fresh console, and `-WindowStyle Hidden` is
  // applied only after PowerShell starts — so the window still flashes. The
  // startup info has to hide it before the process exists. Measured on Windows
  // 11 / PowerShell 5.1: ShowWindow = 0 alone works; adding CreateFlags = 1
  // makes the process start but never run its payload, and Invoke-CimMethod
  // cannot marshal the embedded object at all.
  const source = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  assert.ok(source.includes('Win32_ProcessStartup'), 'startup info must be passed to Win32_Process.Create')
  assert.ok(source.includes('$startup.ShowWindow = 0'), 'the supervisor console must start hidden (SW_HIDE)')
  assert.ok(!source.includes('$startup.CreateFlags'), 'CreateFlags stalls the created process; do not set it')
  assert.ok(!source.includes('Invoke-CimMethod -ClassName Win32_Process'), 'the CIM path cannot marshal Win32_ProcessStartup')
  assert.ok(source.includes('supervisorPid='), 'the arm hop must report the supervisor pid it created')
  return 'SW_HIDE before creation'
})

await check('the supervisor guards its own preconditions', () => {
  const source = readFileSync(join(packageRoot, 'lib', 'restart-supervisor.ps1'), 'utf8')
  // The first supervisor killed the app by PID and then aborted on a name
  // mismatch, leaving the app down; these four properties are what fixed it.
  assert.ok(source.includes('Get-Process -Name $imageName'), 'it must enumerate processes by image name')
  assert.ok(source.includes('processes before stop'), 'it must report what it will stop')
  assert.ok(source.includes('aborted before stopping anything'), 'it must refuse to stop an app it cannot start')
  assert.ok(source.includes('Start-Process -FilePath $Exe -PassThru'), 'it must start exactly one instance')
  assert.ok(source.includes('UTF8Encoding($false)'), 'the result file must be written without a BOM')
  return `${source.split('\n').length} lines`
})

await check('the supervisor stops the Electron shell before anything else', () => {
  // Measured on Windows 11 (probe: screenshots + child-window text + WASAPI
  // session peaks): when the Host dies while the shell is still alive, the shell
  // runs its "desktop host stopped" handler — a native #32770 message box titled
  // "DeepSeek Harness unusable" with Quit / Restart / Disable-third-party-plugins
  // buttons — and Windows plays the system notification sound. The shell is then
  // killed by the next taskkill in the same loop, so the user sees one flash of a
  // white dialog plus one ding at the start of the restart. The stop order must
  // therefore be explicit: shell first, alone, and confirmed gone.
  const source = readFileSync(join(packageRoot, 'lib', 'restart-supervisor.ps1'), 'utf8')
  assert.ok(source.includes('stopping the app root (Electron shell) first'), 'the shell must be named and stopped first')
  assert.ok(source.includes('Win32_Process'), 'the root must be identified through the OS parent map, not PID order')
  assert.ok(source.includes('Wait-AppProcessGone'), 'the shell must be confirmed gone before the rest are stopped')
  assert.ok(/app root pid=\{0\} is gone after \{1\}ms/.test(source), 'the confirmation must be logged')
  const tray = readFileSync(join(packageRoot, 'tray', 'tray-functions.ps1'), 'utf8')
  assert.ok(tray.includes('stopping the app root (Electron shell) first'), 'the tray path must stop the shell first too')
  return 'shell first, then the rest'
})

await check('command-line tokenizer handles Windows quoting', () => {
  const cases = [
    ['"C:\\Program Files\\App\\app.exe" ', ['C:\\Program Files\\App\\app.exe']],
    ['"C:\\P\\a.exe" --flag "C:\\x y\\z"', ['C:\\P\\a.exe', '--flag', 'C:\\x y\\z']],
    ['plain.exe a b', ['plain.exe', 'a', 'b']],
    ['"q\\"uoted" tail', ['q"uoted', 'tail']],
    ['', []],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(host.tokenizeCommandLine(input), expected, `input=${JSON.stringify(input)}`)
  }
  return `${cases.length} cases`
})

await check('trust gate rejects non-loopback and cross-site requests', () => {
  const trusted = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }
  assert.equal(host.isTrustedRequest(trusted), true)
  assert.equal(host.isTrustedRequest({ ...trusted, socket: { remoteAddress: '10.0.0.5' } }), false)
  assert.equal(host.isTrustedRequest({ ...trusted, headers: { ...trusted.headers, origin: 'http://evil.example' } }), false)
  assert.equal(host.isTrustedRequest({ ...trusted, headers: { ...trusted.headers, 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(host.isTrustedRequest({ ...trusted, headers: { host: 'not a host' } }), false)
  return 'loopback + same-origin only'
})

await check('state directory and supervisor runtime resolve absolutely', () => {
  const stateDir = host.resolveStateDir({ DSH_HOME: 'C:\\Users\\x\\.dsh' })
  assert.equal(stateDir, 'C:\\Users\\x\\.dsh\\dsh-plugin-restart')
  const runtime = host.resolveSupervisorRuntime({ DSH_POWERSHELL: 'C:\\ps\\powershell.exe' })
  assert.equal(runtime.path, 'C:\\ps\\powershell.exe')
  assert.equal(runtime.source, 'DSH_POWERSHELL')
  const fallback = host.resolveSupervisorRuntime({})
  assert.equal(fallback.path, 'powershell.exe', 'Windows PowerShell must be the default supervisor host')
  return stateDir
})

await check('config clamping tolerates junk values', () => {
  const config = host.resolveConfig({ armDelayMs: -5, graceMs: 'nonsense', dryRun: 'yes', enabled: 0, trayTriggerPath: 42 })
  assert.equal(config.armDelayMs, 0)
  assert.equal(config.graceMs, 2000)
  assert.equal(config.dryRun, false)
  assert.equal(config.enabled, true)
  assert.equal(config.trayTriggerPath, '')
  return JSON.stringify({ armDelayMs: config.armDelayMs, graceMs: config.graceMs })
})

await check('the seat is a clamped preset, not a free string', () => {
  assert.deepEqual(host.POSITIONS, ['sidebar-footer', 'session-header', 'composer-input', 'composer-dock', 'off'])
  assert.equal(host.DEFAULT_POSITION, 'sidebar-footer')
  // Case, whitespace and the historical names all land on a real seat.
  assert.equal(host.resolveConfig({ position: 'HEADER ' }).position, 'session-header')
  assert.equal(host.resolveConfig({ position: 'sidebar' }).position, 'sidebar-footer')
  assert.equal(host.resolveConfig({ position: 'hidden' }).position, 'off')
  // A typo must not make the button disappear.
  assert.equal(host.resolveConfig({ position: 'nowhere' }).position, 'sidebar-footer')
  assert.equal(host.resolveConfig({}).prompt, true)
  assert.equal(host.resolveConfig({ prompt: false }).prompt, false)
  return '4 seats + off, typo-safe'
})

await check('UI settings override the patch and never corrupt it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-settings-'))
  try {
    const config = host.resolveConfig({ position: 'composer-dock', prompt: false })
    const baseline = host.resolveSettings(config, dir)
    assert.equal(baseline.position, 'composer-dock')
    assert.equal(baseline.prompt, false)
    assert.equal(baseline.source, 'config')

    host.writeUiSettings(dir, { position: 'session-header' })
    const stored = host.resolveSettings(config, dir)
    assert.equal(stored.position, 'session-header')
    assert.equal(stored.source, 'settings')
    // Only the changed key is overridden; the patch keeps the rest.
    assert.equal(stored.prompt, false, 'the untouched prompt keeps the patch value')

    host.writeUiSettings(dir, { position: 'not-a-seat' })
    assert.equal(host.resolveSettings(config, dir).position, 'session-header', 'an invalid seat is ignored')

    host.writeUiSettings(dir, { prompt: true })
    assert.equal(host.resolveSettings(config, dir).prompt, true)
    return 'patch < settings file < defaults'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('the pending marker survives a dismissal and re-opens on the next change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-pending-'))
  try {
    const record = host.recordPending(dir, { reason: 'install', source: 'plugin-manager' })
    assert.equal(record.reason, 'install')
    assert.equal(record.pid, process.pid, 'the writer pid is what tells a restart apart from a reload')
    assert.equal(host.visiblePending(dir).reason, 'install')

    host.dismissPending(dir)
    assert.equal(host.visiblePending(dir), null, 'a dismissed prompt is hidden')
    assert.equal(host.readPending(dir).reason, 'install', 'the record stays for diagnostics')

    host.recordPending(dir, { reason: 'bundle' })
    assert.equal(host.visiblePending(dir).reason, 'bundle', 'the next change re-opens the prompt')

    host.clearPending(dir)
    assert.equal(host.readPending(dir), null)
    return 'record -> visible -> dismissed -> re-recorded -> cleared'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('the rebuilt-Host-module watcher detects a rewrite', async () => {
  // The one change DSH does not announce: rewriting a linked plugin's Host half
  // in place. Stamp-then-compare is the whole mechanism, so it is tested on a
  // real file rather than a mock.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-watch-'))
  try {
    const file = join(dir, 'index.js')
    writeFileSync(file, 'export const version = 1\n', 'utf8')
    const baseline = host.snapshotModuleStamps([file])
    assert.equal(host.takeModuleChange(baseline), null, 'an untouched file reports no change')
    // Two writes can land inside one filesystem timestamp tick; the size part of
    // the stamp is what keeps this deterministic.
    writeFileSync(file, 'export const version = 2 // rebuilt\n', 'utf8')
    assert.equal(host.takeModuleChange(baseline), file, 'a rewrite is reported once')
    assert.equal(host.takeModuleChange(baseline), null, 'the baseline moved with the report')
    assert.equal(host.snapshotModuleStamps([join(dir, 'missing.js')]).get(join(dir, 'missing.js')), 'missing')
    assert.equal(host.resolveConfig({ watchModules: false }).watchModules, false)
    assert.equal(host.resolveConfig({}).watchModules, true)
    assert.deepEqual(host.collectHostModules({ get: () => undefined }), [], 'a Host without a Loader watches nothing')
    const source = readFileSync(join(packageRoot, 'index.js'), 'utf8')
    assert.ok(source.includes('unref'), 'the watcher must not keep the Host alive')
    assert.ok(source.includes('module-watch'), 'the marker must name its source')
    return 'stamp -> rewrite -> one report'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('the host listens to the three real change signals', () => {
  const source = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  for (const event of ['plugin-manager/changed', 'plugin-manager/install-state', 'app-boot/config-reload']) {
    assert.ok(source.includes(event), `the host must listen to ${event}`)
  }
  // `applying` is the phase that means "files are in place"; the earlier phases
  // describe a download, not a change the user has finished making.
  assert.ok(source.includes("progress?.phase === 'applying'"), 'only the applying phase records a change')
  // The startup reconcile must not be mistaken for a user change.
  assert.ok(source.includes('BOOT_QUIET_MS'), 'the boot quiet window must guard config-reload')
  assert.ok(source.includes('stale.pid !== process.pid'), 'a marker from a dead process is cleared at boot')
  return 'changed + install/applying + config-reload'
})

await check('plan contract matches what the supervisor reads', async () => {
  // The Host passes the plan to the PowerShell supervisor as command-line
  // parameters. Drift between the two sides is silent at build time and fatal at
  // restart time, so the parameters the script DECLARES are asserted against the
  // fields the plan provides (and against the argv the Host actually builds).
  const supervisorSource = readFileSync(join(packageRoot, 'lib', 'restart-supervisor.ps1'), 'utf8')
  const paramBlock = /\[CmdletBinding\(\)\][\s\S]*?\)\s*\n/.exec(supervisorSource)?.[0] ?? ''
  assert.ok(paramBlock !== '', 'the param block was not found')
  const declared = [...paramBlock.matchAll(/\$([A-Za-z][A-Za-z0-9]*)\s*(?:=|,|\))/g)].map((match) => match[1])
  assert.ok(declared.includes('Exe'), 'the supervisor must declare -Exe')
  const config = host.resolveConfig({})
  const plan = await host.buildRestartPlan(config, join(packageRoot, 'tests', 'tmp-contract'), host.resolveSupervisorScript())
  for (const field of ['exe', 'graceMs', 'stateDir', 'logPath', 'resultPath', 'supervisorScript']) {
    assert.ok(field in plan, `the plan must provide ${field}`)
  }
  assert.equal(typeof plan.exe, 'string')
  assert.equal(typeof plan.stateDir, 'string')
  assert.ok(plan.supervisorScript.endsWith('restart-supervisor.ps1'), plan.supervisorScript)
  // The same fields must reach the child as argv, or the script sees defaults.
  const argv = []
  for (const field of ['-Exe', '-GraceMs', '-StateDir', '-LogPath', '-ResultPath']) argv.push(field)
  const spawnSource = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const missing = argv.filter((flag) => !spawnSource.includes(`'${flag}'`))
  assert.deepEqual(missing, [], `spawnSupervisor does not pass: ${missing.join(', ')}`)
  return `${declared.join(', ')} -> ${argv.join(' ')}`
})

await check('client half registers the preset seats and posts to the host', () => {
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.ok(source.includes("id: 'dsh-plugin-restart'"))
  // The trigger lives at the sidebar foot by default, beside the account launcher.
  assert.ok(source.includes("'sidebar.footer.action'"), 'the default seat must stay the sidebar footer')
  assert.ok(!/slots\.inject\('conversation\.session\.header\.actions'/.test(source), 'it must not register into the session title row')
  // The other presets, the end-of-Turn prompt and the plugin's own settings page.
  for (const seat of ['conversation.session.header.utilities', 'conversation.input.right', 'conversation.composer.dock']) {
    assert.ok(source.includes(`'${seat}'`), `the preset seat ${seat} must be registered`)
  }
  assert.ok(source.includes("'conversation.chat.turnTail'"), 'the prompt must use the completed-Turn tail seat')
  assert.ok(source.includes("'plugins.detail.section'"), 'the settings page section must be registered')
  // The prompt is scoped to the last Turn, so history is not repainted.
  assert.ok(source.includes('timeline?.turnOrder'), 'the prompt must compare against the timeline')
  assert.ok(source.includes('useChat'), 'the last-Turn check must use the slot standard prop')
  assert.ok(source.includes('RestartGlyph'), 'the compact button needs an icon')
  assert.ok(!/props\?\.wide/.test(source), 'the button must stay icon-only, with no text label')
  assert.ok(source.includes('action.title'), 'the icon needs an accessible name and tooltip')
  for (const route of ['/api/dsh-restart/restart', '/api/dsh-restart/status', '/api/dsh-restart/state', '/api/dsh-restart/settings', '/api/dsh-restart/dismiss']) {
    assert.ok(source.includes(`'${route}'`), `the browser half must call ${route}`)
  }
  assert.ok(source.includes('window.__ModuleLoader__.load'))
  assert.ok(!source.includes('dsh-client-ui-primitives'), 'must not import host client packages')
  return `${source.split('\n').length} lines`
})

await check('client half keeps the review fixes', () => {
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // F1: the loader claims untagged styles and deletes them on another package's HMR.
  assert.ok(source.includes("setAttribute('data-plugin', 'dsh-plugin-restart')"), 'the stylesheet must be tagged data-plugin')
  assert.ok(source.includes('data-plugin-css'), 'the stylesheet must be tagged data-plugin-css')
  // F2: dry run and relaunch:false answer ok:true with scheduled:false.
  assert.ok(/value\?\.scheduled === true/.test(source), 'arming must require scheduled === true')
  assert.ok(source.includes('state.notScheduled'), 'an unscheduled answer needs its own message')
  // F3: a failed request must stay retryable instead of arming.
  assert.ok(!/catch[\s\S]{0,240}setArmed\(true\)/.test(source), 'a fetch failure must not arm the restart')
  // F4: a hung request must not freeze the popover forever.
  assert.ok(source.includes('AbortController'), 'requests need an abort signal')
  assert.ok(source.includes('aborted'), 'an abort must be distinguished from a failure')
  // F5/F10 (revised 2026-10-08): the confirmation is an inset of the sidebar
  // column, not a card in the bottom-left corner of the viewport. It is anchored
  // to the trigger's own wrapper and sized from the sidebar's own width, so the
  // "no rect maths" rule still holds — and the panel no longer depends on which
  // box `position: fixed` resolves against inside the shell's containment boxes.
  assert.ok(source.includes('position: absolute; left: 0; bottom: calc(100% + 6px)'),
    'the confirmation must be anchored to the trigger, above it, inside the sidebar')
  assert.ok(!source.includes('position: fixed; left: 8px'), 'the viewport-corner window must be gone')
  assert.ok(source.includes('var(--dsh-windows-sidebar-width'), 'the width must come from the frame\'s sidebar column')
  assert.ok(source.includes('var(--dsh-sidebar-inline-padding'), 'the width must respect the sidebar inline padding')
  assert.ok(!source.includes('getBoundingClientRect'), 'no rect maths may remain')
  // F6: Escape must not be swallowed for the whole document.
  assert.ok(!/\.stopPropagation\s*\(/.test(source), 'the popover must not hijack document keys')
  // F7: an in-flight request must not be dismissed by an outside click.
  assert.ok(source.includes('if (!open || busy) return undefined'), 'outside-click must respect the busy state')
  // F8: focus and aria wiring.
  assert.ok(source.includes('aria-controls'), 'the trigger must point at the popover')
  assert.ok(source.includes('tabIndex: -1'), 'the dialog must be focusable')
  assert.ok(source.includes("role: 'alert'"), 'errors need a live region')
  // The confirmation asks one question: no body copy, no warning paragraph, no
  // target/delay metadata in the panel.
  assert.ok(!source.includes("'dialog.body'"), 'the dialog must not carry body copy')
  assert.ok(!source.includes("'dialog.warning'"), 'the dialog must not carry a warning paragraph')
  assert.ok(!source.includes("'dialog.target'"), 'the dialog must not print the target')
  assert.ok(!source.includes("'dialog.delay'"), 'the dialog must not print the delay')
  // F11: translations come from the Client locale service.
  assert.ok(source.includes("inject: ['slots', 'locale']"), 'the locale service must be injected')
  assert.ok(source.includes('ctx.locale.register('), 'the dictionaries must be registered')
  assert.ok(source.includes('locale: NAMESPACE'), 'the slot entry must declare its locale namespace')
  assert.ok(/ctx\.locale\.bind\(/.test(source), 'translation must go through the locale service')
  return 'data-plugin, scheduled===true, abort, CSS anchor, no stopPropagation, busy guard, a11y, locale'
})

await check('the confirmation keeps the scope note out of the title', () => {
  // The question is "重启 DSH"; "（应用与 Host）" is a scope annotation. It must
  // not be a second bold heading: separate dictionary entry, own span, body
  // weight, tertiary label colour. tests/ui-render.mjs proves the same thing by
  // really rendering the panel.
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.ok(source.includes("'dialog.note'"), 'the scope note needs its own dictionary entry')
  assert.ok(/h\('span', \{ className: 'dshr-title' \}/.test(source), 'the question is a title span')
  assert.ok(/h\('span', \{ className: 'dshr-note' \}/.test(source), 'the note is its own span, not part of the title')
  assert.ok(/\.dshr-note \{[^}]*font-weight: 400/.test(source), 'the note must not be bold')
  assert.ok(/\.dshr-note \{[^}]*var\(--dsw-alias-label-tertiary\)/.test(source), 'the note must be visually weaker')
  assert.equal(/'dialog\.title': '([^']+)'/.exec(source)?.[1], '重启 DSH', 'the title must be the question alone')
  return 'title + muted note'
})

await check('styles use theme tokens only', () => {
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const colors = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
  const allowed = new Set(['#fff'])
  const offending = colors.filter((color) => !allowed.has(color))
  assert.deepEqual(offending, [], `literal colors outside artwork: ${offending.join(',')}`)
  return `${colors.length} literal color(s), allowed set ${[...allowed].join(',')}`
})

await check('locale dictionaries mirror the client dictionaries', () => {
  // locale/*.json is the manifest-facing copy of the dictionaries client.js
  // registers at runtime. Nothing imports them, so drift here is invisible at
  // run time and only misleads whoever reads the package: assert the key sets.
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  const block = /const zh = \{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ?? ''
  assert.ok(block !== '', 'the zh dictionary was not found in client.js')
  const clientKeys = [...block.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1])
  assert.ok(clientKeys.length >= 10, `the client dictionary looks truncated: ${String(clientKeys.length)} keys`)
  for (const file of ['zh.json', 'en.json']) {
    const dictionary = JSON.parse(readFileSync(join(packageRoot, 'locale', file), 'utf8'))
    const missing = clientKeys.filter((key) => !(key in dictionary))
    assert.deepEqual(missing, [], `locale/${file} is missing: ${missing.join(', ')}`)
  }
  return `${String(clientKeys.length)} keys mirrored in locale/zh.json + locale/en.json`
})

await check('tray scripts are structurally valid', () => {
  const hostScript = readFileSync(join(packageRoot, 'tray', 'tray-host.ps1'), 'utf8')
  const functions = readFileSync(join(packageRoot, 'tray', 'tray-functions.ps1'), 'utf8')
  assert.ok(hostScript.includes('NotifyIcon'), 'the tray must own a NotifyIcon')
  assert.ok(hostScript.includes('tray-functions.ps1'), 'the tray must dot-source its process-control layer')
  assert.ok(!hostScript.includes('taskkill'), 'process termination belongs in tray-functions.ps1')
  for (const fn of ['Get-AppProcess', 'Test-AppRunning', 'Stop-ProcessTree', 'Start-AppProcess', 'Restart-App', 'Write-RestartResult']) {
    assert.ok(functions.includes(`function ${fn}`), `tray-functions.ps1 must define ${fn}`)
  }
  assert.ok(functions.includes('taskkill.exe'), 'the terminate helper must call taskkill')
  for (const [name, text] of [['tray-host.ps1', hostScript], ['tray-functions.ps1', functions]]) {
    const open = (text.match(/\{/g) ?? []).length
    const close = (text.match(/\}/g) ?? []).length
    assert.equal(open, close, `${name} has unbalanced braces (${String(open)} open vs ${String(close)} close)`)
  }
  return `${hostScript.split('\n').length} + ${functions.split('\n').length} lines`
})

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail === '' ? '' : ` - ${result.detail}`}`)
}
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
