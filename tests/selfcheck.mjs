/**
 * Non-destructive checks for the dsh-plugin-restart package.
 *
 * Runs with a bare Node (no dependencies) and never restarts anything:
 *   node tests/selfcheck.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
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

await check('client half registers the sidebar footer action and posts to the host', () => {
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.ok(source.includes("id: 'dsh-plugin-restart'"))
  // The button lives at the sidebar foot, beside the account launcher.
  assert.ok(source.includes("sidebar.footer.action"), 'the action must register into the sidebar footer')
  assert.ok(!/slots\.inject\('conversation\.session\.header\.actions'/.test(source), 'it must no longer register into the session header')
  assert.ok(source.includes('RestartGlyph'), 'the compact footer button needs an icon')
  assert.ok(!/props\?\.wide/.test(source), 'the button must stay icon-only, with no text label')
  assert.ok(source.includes('action.title'), 'the icon needs an accessible name and tooltip')
  assert.ok(source.includes("'/api/dsh-restart/restart'"))
  assert.ok(source.includes("'/api/dsh-restart/status'"))
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
  // F5/F10: viewport-anchored corner panel, not rect maths inside a containment box.
  assert.ok(source.includes('position: fixed; left: 8px; bottom: 8px'), 'the popover must be anchored to the bottom-left corner')
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
