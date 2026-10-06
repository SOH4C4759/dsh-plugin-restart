/**
 * Host half of the `dsh-plugin-restart` bundle.
 *
 * Why this exists: after a plugin or profile iteration the desktop app keeps the
 * JavaScript generation it booted with, so a rebuilt plugin only takes effect
 * after a restart. The Electron shell owns the Host as a child process, treats
 * the Host's exit as a crash, and hides its own "Restart App and Host" menu item
 * behind a development flag — so the reliable one-click restart is: this Host
 * spawns a DETACHED supervisor and answers the caller; the whole app tree
 * (including this Host) then goes away while the supervisor relaunches the app.
 *
 * Surface:
 *   POST /api/dsh-restart/status   what a restart would do right now (no side effect)
 *   POST /api/dsh-restart/restart  arm the detached relaunch (dryRun: true = plan only)
 *
 * Both routes are loopback-only and same-origin gated, mirroring the trust policy
 * the shipped Web-UI settings bridge applies to its own loopback routes.
 *
 * @module dsh-plugin-restart
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/** Plugin name shown in loader logs. */
export const name = 'dsh-plugin-restart'

/** The Web server is the only required service: it carries the restart routes. */
export const inject = ['webServer']

/** This package's own name, used to locate its root from a profile link. */
const PACKAGE_NAME = 'dsh-plugin-restart'

/** This module's directory (the package root when the entry is `index.js`). */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the package root by walking up from this module until the manifest
 * names this package. A profile install reaches the file through a link, and
 * `import.meta.url` may already be the link target, so neither "moduleDir" nor
 * "its parent" can be assumed: the manifest decides.
 * @param {string} from - directory to start from.
 * @returns {string} the directory holding this package's `package.json`.
 */
function findPackageRoot(from) {
  let current = from
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(current, 'package.json')
    try {
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed?.name === PACKAGE_NAME) return current
      }
    } catch {
      /* keep walking */
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return from
}

const packageRoot = findPackageRoot(moduleDir)

/**
 * Resolve the supervisor entry from the candidates this module can prove:
 * an explicit config path, the manifest-verified package root, this module's own
 * directory, and a loader-provided package directory. The first existing file
 * wins, so an unusual profile link can never leave the restart unarmed.
 * @param {string} explicit - configured `supervisorPath` (may be empty).
 * @param {string} [loaderPackageDir] - `packageDir` reported by Config.listConfigs, when available.
 * @returns {{path: string, source: string, candidates: {path: string, exists: boolean}[]}}
 */
export function resolveSupervisorScript(explicit = '', loaderPackageDir = '') {
  const bases = []
  if (typeof explicit === 'string' && explicit.trim() !== '') bases.push({ dir: explicit.trim(), source: 'config' })
  if (typeof loaderPackageDir === 'string' && loaderPackageDir.trim() !== '') bases.push({ dir: loaderPackageDir.trim(), source: 'loader-package-dir' })
  bases.push({ dir: packageRoot, source: 'package-root' })
  bases.push({ dir: moduleDir, source: 'module-dir' })
  const seen = new Set()
  const candidates = []
  for (const base of bases) {
    const path = base.source === 'config' && base.dir.toLowerCase().endsWith('.ps1')
      ? base.dir
      : join(base.dir, 'lib', 'restart-supervisor.ps1')
    if (seen.has(path)) continue
    seen.add(path)
    candidates.push({ path, exists: existsSync(path), source: base.source })
  }
  const winner = candidates.find((candidate) => candidate.exists)
  return {
    path: winner?.path ?? candidates[0]?.path ?? join(packageRoot, 'lib', 'restart-supervisor.ps1'),
    source: winner?.source ?? 'unresolved',
    candidates,
  }
}

const supervisorScript = resolveSupervisorScript().path

/** Route namespace owned by this plugin. */
const ROUTE_PREFIX = '/api/dsh-restart'

/**
 * Ask the Loader for this plugin's own resolved package directory.
 *
 * The Loader is the authority on where a row's package really lives, which is
 * what makes this a better candidate than any path derived from
 * `import.meta.url`. The lookup is structural — no Loader import — and returns
 * undefined in a Host whose Loader exposes no entries.
 * @param {object} ctx - plugin context.
 * @returns {string|undefined} absolute package directory, when the Loader knows it.
 */
export function resolveLoaderPackageDir(ctx) {
  // Only this context is asked. Walking `ctx.parent` is NOT possible: cordis
  // gates every un-injected property access and throws
  // `cannot get property "parent" without inject`, which would make the whole
  // plugin fail to activate. `ctx.get('loader')` is safe and scoped.
  let loader
  try {
    loader = ctx?.get?.('loader')
  } catch {
    return undefined
  }
  if (loader === undefined || loader === null) return undefined
  try {
    const entries = typeof loader.entries === 'function' ? [...loader.entries()] : []
    for (const entry of entries) {
      const options = entry?.options ?? entry?.subtree?.options
      if (options?.name !== PACKAGE_NAME) continue
      const dir = typeof options?.packageDir === 'string' ? options.packageDir : undefined
      if (dir !== undefined && dir !== '') return dir
      const filename = typeof options?.filename === 'string' ? options.filename : undefined
      if (filename !== undefined && filename !== '') return dirname(filename)
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Default grace before a restart is acted on, so the HTTP reply flushes first. */
const DEFAULT_ARM_DELAY_MS = 1200

/** How long the supervisor waits for a clean exit before it force-terminates the tree. */
const DEFAULT_GRACE_MS = 2000

/** Upper bound for the arming delay accepted from the browser half. */
const MAX_ARM_DELAY_MS = 10000

/** Resolve `$DSH_HOME` (the Host's own environment is the authority). */
export function resolveDshHome(env = process.env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return raw === '' ? join(homedir(), '.dsh') : raw
}

/** Directory this plugin owns for its trigger, log and result files. */
export function resolveStateDir(env = process.env) {
  return join(resolveDshHome(env), 'dsh-plugin-restart')
}

/** Absolute path of a Node executable able to run the supervisor. */
export function resolveNodeExecutable(env = process.env) {
  const fromEnv = typeof env.DSH_NODE === 'string' && env.DSH_NODE.trim() !== '' ? env.DSH_NODE.trim() : ''
  if (fromEnv !== '') return fromEnv
  return process.execPath
}

/**
 * Resolve how to run the supervisor.
 *
 * The supervisor is a PowerShell script: the first Node version killed the
 * Electron main by PID and then aborted on an image-name mismatch, leaving the
 * app closed with nothing to start it again. Windows PowerShell 5.1 is always
 * present and addresses processes by image name through the OS API.
 * @param {object} env - environment to read.
 * @returns {{path: string, env: object, source: string, notes: string[]}}
 */
export function resolveSupervisorRuntime(env = process.env) {
  const notes = ['the supervisor runs under Windows PowerShell 5.1']
  const fromEnv = typeof env.DSH_POWERSHELL === 'string' && env.DSH_POWERSHELL.trim() !== '' ? env.DSH_POWERSHELL.trim() : ''
  if (fromEnv !== '') return { path: fromEnv, env: { ...env }, source: 'DSH_POWERSHELL', notes }
  return { path: 'powershell.exe', env: { ...env }, source: 'windows-powershell', notes }
}

/**
 * Split a Windows command line into argv, honouring the quoting and
 * backslash-escaping rules CreateProcess applies to quoted arguments.
 * @param {string} commandLine - raw command line.
 * @returns {string[]} argv, empty when the line is blank.
 */
export function tokenizeCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return []
  const argv = []
  let current = ''
  let inQuotes = false
  let started = false
  let backslashes = 0
  for (const char of commandLine) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2 === 1) current += '"'
      else inQuotes = !inQuotes
      backslashes = 0
      started = true
      continue
    }
    if (backslashes > 0) {
      current += '\\'.repeat(backslashes)
      backslashes = 0
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started || current !== '') {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (backslashes > 0) current += '\\'.repeat(backslashes)
  if (started || current !== '') argv.push(current)
  return argv
}

/** Read a process record from `/proc` (non-Windows); null when unavailable. */
function readProcRecord(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    const cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
    const [exe, ...args] = cmdline
    return { ppid: Number.isInteger(ppid) ? ppid : null, exe: exe ?? null, args, name: exe === undefined ? null : exe.slice(exe.lastIndexOf('/') + 1), error: null }
  } catch (error) {
    return { ppid: null, exe: null, args: null, name: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read a process record through PowerShell/CIM (Windows). Never throws: an
 * unreadable parent only means the restart can be planned but not confirmed.
 * @returns {Promise<{ppid: number|null, exe: string|null, args: string[]|null, name: string|null, error: string|null}>}
 */
function readProcessRecord(pid) {
  if (process.platform !== 'win32') return Promise.resolve(readProcRecord(pid))
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"`,
    'if ($null -eq $p) { "{}" } else {',
    '  [pscustomobject]@{ ppid = $p.ParentProcessId; name = $p.Name;',
    '    exe = $p.ExecutablePath; cmd = $p.CommandLine } | ConvertTo-Json -Compress',
    '}',
  ].join('\n')
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      out += chunk
    })
    child.once('error', (error) => {
      resolve({ ppid: null, exe: null, args: null, name: null, error: error.message })
    })
    child.once('close', () => {
      const text = out.trim()
      if (text === '' || text === '{}') {
        resolve({ ppid: null, exe: null, args: null, name: null, error: `no process record for pid ${String(pid)}` })
        return
      }
      try {
        const parsed = JSON.parse(text)
        const argv = tokenizeCommandLine(typeof parsed.cmd === 'string' ? parsed.cmd : '')
        const exe = typeof parsed.exe === 'string' && parsed.exe !== '' ? parsed.exe : (argv[0] ?? null)
        resolve({
          ppid: Number.isInteger(parsed.ppid) ? parsed.ppid : null,
          exe,
          args: argv.length > 0 ? argv.slice(1) : [],
          name: typeof parsed.name === 'string' ? parsed.name : null,
          error: null,
        })
      } catch (error) {
        resolve({ ppid: null, exe: null, args: null, name: null, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

/**
 * Describe how this Host was started and which process owns it.
 * @param {number} pid - Host pid (defaults to the current process).
 * @returns {Promise<object>} the detection record.
 */
export async function detectProcessContext(pid = process.pid) {
  const self = await readProcessRecord(pid)
  const parentPid = self.ppid !== null && self.ppid > 0 ? self.ppid : null
  const parent = parentPid === null ? null : await readProcessRecord(parentPid)
  return {
    hostPid: pid,
    hostExe: self.exe ?? process.execPath,
    parentPid,
    parentName: parent?.name ?? null,
    parentExe: parent?.exe ?? parent?.args?.[0] ?? null,
    parentArgs: Array.isArray(parent?.args) ? parent.args : [],
    detectionError: self.error ?? parent?.error ?? null,
  }
}

/** Clamp a numeric value into a range. */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Build the restart plan without performing it: which process to stop, which
 * executable to relaunch, and with which arguments.
 * @param {object} config - resolved plugin config.
 * @param {string} stateDir - plugin-owned state directory.
 * @param {{path: string, source: string, candidates: object[]}} [supervisor] - resolved supervisor entry.
 * @returns {Promise<object>} a JSON-safe plan.
 */
export async function buildRestartPlan(config, stateDir, supervisor) {
  const resolvedSupervisor = supervisor ?? resolveSupervisorScript(config.supervisorPath)
  const context = await detectProcessContext()
  const targetIsParent = context.parentPid !== null && context.parentPid > 0
  const targetPid = targetIsParent ? context.parentPid : context.hostPid
  const exe = targetIsParent ? (context.parentExe ?? context.parentArgs[0] ?? null) : context.hostExe
  const args = targetIsParent ? context.parentArgs : []
  const triggerPath = config.trayTriggerPath !== '' ? config.trayTriggerPath : join(stateDir, 'restart-request.json')
  return {
    targetPid,
    // The supervisor's own contract name for the process it stops and relaunches.
    parentPid: targetPid,
    targetKind: targetIsParent ? 'electron-shell-parent' : 'host-process',
    // The image name has no `.exe` suffix: `DeepSeek Harness`, not
    // `DeepSeek Harness.exe`. Getting this wrong is what makes a name-based
    // stop-then-start abort after the app is already down.
    name: targetIsParent ? (context.parentName ?? 'DeepSeek Harness') : null,
    exe: typeof exe === 'string' && exe !== '' ? exe : null,
    args,
    commandLine: typeof exe === 'string' && exe !== '' ? [exe, ...args].join(' ') : null,
    graceMs: clampNumber(config.graceMs, 250, 30000, DEFAULT_GRACE_MS),
    relaunch: config.relaunch !== false,
    logPath: join(stateDir, 'restart.log'),
    resultPath: join(stateDir, 'restart-result.json'),
    stateDir,
    triggerPath,
    supervisorScript: resolvedSupervisor.path,
    supervisorSource: resolvedSupervisor.source,
    supervisorCandidates: resolvedSupervisor.candidates,
    detection: context,
  }
}

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Parse one bare Host authority into a URL, or undefined when malformed. */
function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority.trim() !== authority || authority === '') return undefined
  const match = authority.startsWith('[') ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority) : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Whether a request is same-origin with the (loopback) Host it reached. */
function isSameOriginRequest(request, hostUrl) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Loopback-only, same-origin trust decision for the restart routes. */
export function isTrustedRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  return isSameOriginRequest(request, hostUrl)
}

/** Write one JSON response without depending on any Host helper. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read a bounded JSON body; null for a blank, oversized or invalid body. */
async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Read the previous run's supervisor result, when one was written. */
export function readLastRestartResult(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'restart-result.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * Launch the detached PowerShell supervisor for one restart.
 *
 * Two Windows facts this respects, both measured:
 *   1. `spawn(..., { detached: true })` is NOT enough — a child started that way
 *      dies with the Node parent, so a plain detached supervisor never finished
 *      its work after the Host went away.
 *   2. `cmd /c start` survives the parent, but blocks forever whenever its stdout
 *      is captured (35 ms bare vs. an unbounded hang under a pipe), and the
 *      supervisor must not inherit this process's handles anyway.
 * Creating the supervisor through WMI (`Win32_Process.Create`) satisfies both: the
 * WMI service creates it outside this process tree and outside its handle
 * inheritance, and the call returns as soon as the process exists.
 *
 * The supervisor enumerates the app's processes by image name, refuses to stop an
 * app it cannot start again, kills them, waits for them to be gone, starts one
 * instance, and waits for its window.
 * @param {object} plan - plan from {@link buildRestartPlan}.
 * @param {{path: string, env: object, source?: string}} runtime - resolved supervisor runtime.
 * @returns {Promise<{spawned: boolean, supervisorPid: number|null, error: string|null}>}
 */
export async function spawnSupervisor(plan, runtime) {
  const executable = typeof runtime === 'string' ? runtime : runtime.path
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`
  const commandLine = [
    quote(executable),
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', quote(plan.supervisorScript),
    '-Exe', quote(plan.exe),
    '-GraceMs', String(plan.graceMs ?? 4000),
    '-StateDir', quote(plan.stateDir),
    '-LogPath', quote(plan.logPath),
    '-ResultPath', quote(plan.resultPath),
  ].join(' ')
  const environment = { ...process.env, ...(typeof runtime === 'string' ? {} : runtime.env) }
  if (process.platform !== 'win32') {
    try {
      const child = spawn(executable, commandLine.split(' ').slice(1), { detached: true, stdio: 'ignore', env: environment })
      child.unref()
      return { spawned: true, supervisorPid: child.pid ?? null, error: null, via: 'spawn' }
    } catch (error) {
      return { spawned: false, supervisorPid: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const { execFile } = await import('node:child_process')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    // The command line contains quotes and backslashes; passing it through
    // `powershell -Command` mangles it. A temp script carries it verbatim, and a
    // base64 payload avoids every quoting layer in between.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-arm-'))
    const payloadPath = join(dir, 'commandline.b64')
    writeFileSync(payloadPath, Buffer.from(commandLine, 'utf8').toString('base64'), 'utf8')
    const scriptPath = join(dir, 'arm.ps1')
    writeFileSync(
      scriptPath,
      [
        'param([string] $PayloadPath)',
        '$ErrorActionPreference = "Stop"',
        '$commandLine = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String((Get-Content -LiteralPath $PayloadPath -Raw).Trim()))',
        '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }',
        'if ($result.ReturnValue -ne 0) { Write-Error ("Win32_Process.Create failed with " + $result.ReturnValue); exit 1 }',
        'exit 0',
      ].join('\n'),
      'utf8',
    )
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, payloadPath],
        { windowsHide: true },
        (error) => {
          if (error !== null) reject(new Error(error.message))
          else resolve(undefined)
        },
      )
    })
    // WMI does not surface the new pid; the supervisor reports its own progress
    // in restart.log and restart-result.json.
    return { spawned: true, supervisorPid: null, error: null, via: 'wmi' }
  } catch (error) {
    return { spawned: false, supervisorPid: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Write the tray trigger file consumed by the optional tray host. */
export function writeTrayTrigger(plan, extra) {
  try {
    mkdirSync(dirname(plan.triggerPath), { recursive: true })
    writeFileSync(
      plan.triggerPath,
      `${JSON.stringify({ schemaVersion: 1, requestedAt: new Date().toISOString(), pid: plan.targetPid, exe: plan.exe, args: plan.args, graceMs: plan.graceMs, ...extra }, null, 2)}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the row config into the plugin's working shape. Values are clamped
 * rather than rejected so a hand-written patch can never break Host startup.
 * @param {object|undefined} raw - row config from the profile patch.
 * @param {object} [env] - environment override (test seam).
 * @returns {object} resolved config.
 */
export function resolveConfig(raw, env = process.env) {
  const runtime = resolveSupervisorRuntime(env)
  return {
    enabled: raw?.enabled !== false,
    armDelayMs: clampNumber(raw?.armDelayMs, 0, MAX_ARM_DELAY_MS, DEFAULT_ARM_DELAY_MS),
    graceMs: clampNumber(raw?.graceMs, 250, 30000, DEFAULT_GRACE_MS),
    dryRun: raw?.dryRun === true,
    relaunch: raw?.relaunch !== false,
    trayTriggerPath: typeof raw?.trayTriggerPath === 'string' ? raw.trayTriggerPath : '',
    supervisorPath: typeof raw?.supervisorPath === 'string' ? raw.supervisorPath : '',
    loaderPackageDir: typeof raw?.loaderPackageDir === 'string' ? raw.loaderPackageDir : '',
    stateDir: resolveStateDir(env),
    runtime,
  }
}

/**
 * Mount the restart routes.
 * @param {object} ctx - Host plugin context carrying `webServer`.
 * @param {object} [rawConfig] - row config from the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const loaderPackageDir = resolveLoaderPackageDir(ctx) ?? config.loaderPackageDir
  const supervisor = resolveSupervisorScript(config.supervisorPath, loaderPackageDir)
  /** Armed restart timers, so a teardown cancels a restart that has not fired. */
  const pending = new Set()

  const guard = (req, res) => {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'restart routes are loopback-only' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  const statusHandler = async (req, res) => {
    if (!guard(req, res)) return
    const plan = await buildRestartPlan(config, config.stateDir, supervisor)
    writeJson(res, 200, {
      ok: true,
      value: {
        enabled: config.enabled,
        dryRun: config.dryRun,
        relaunch: config.relaunch,
        armDelayMs: config.armDelayMs,
        stateDir: config.stateDir,
        moduleUrl: import.meta.url,
        moduleDir,
        packageRoot,
        supervisorScript: supervisor.path,
        supervisorSource: supervisor.source,
        supervisorCandidates: supervisor.candidates,
        supervisorScriptExists: existsSync(supervisor.path),
        supervisorRuntime: {
          path: config.runtime.path,
          source: config.runtime.source,
          notes: config.runtime.notes,
        },
        target: { pid: plan.targetPid, kind: plan.targetKind, name: plan.name, exe: plan.exe, args: plan.args },
        commandLine: plan.commandLine,
        lastResult: readLastRestartResult(config.stateDir),
        detectionError: plan.detection.detectionError,
      },
    })
  }

  const restartHandler = async (req, res) => {
    if (!guard(req, res)) return
    if (!config.enabled) {
      writeJson(res, 409, { ok: false, code: 'disabled', message: 'restart is disabled by plugin config (enabled: false)' })
      return
    }
    const body = (await readJsonBody(req)) ?? {}
    const dryRun = config.dryRun || body.dryRun === true
    const plan = await buildRestartPlan(config, config.stateDir, supervisor)
    if (plan.exe === null) {
      writeJson(res, 500, {
        ok: false,
        code: 'no-executable',
        message: 'cannot resolve the application executable to relaunch; the Host parent process was unreadable',
        plan: { targetPid: plan.targetPid, detectionError: plan.detection.detectionError },
      })
      return
    }
    if (dryRun) {
      writeJson(res, 200, { ok: true, value: { scheduled: false, dryRun: true, armDelayMs: config.armDelayMs, plan } })
      return
    }
    if (!existsSync(plan.supervisorScript)) {
      // Fail before arming: a missing supervisor would stop the app with nothing
      // left to start it again.
      writeJson(res, 500, {
        ok: false,
        code: 'supervisor-missing',
        message: `supervisor script not found at ${plan.supervisorScript}; reinstall the bundle`,
        moduleUrl: import.meta.url,
        moduleDir,
        packageRoot,
        candidates: plan.supervisorCandidates,
      })
      return
    }

    mkdirSync(config.stateDir, { recursive: true })
    const armDelayMs = clampNumber(body.armDelayMs ?? config.armDelayMs, 0, MAX_ARM_DELAY_MS, config.armDelayMs)

    if (!config.relaunch) {
      // Debug shape: answer, and hand the restart to the optional tray host,
      // which is the only authority left when the supervisor is disabled.
      const triggerWritten = writeTrayTrigger(plan, { armedBy: 'host:relaunch-disabled', supervisorRuntime: config.runtime.path })
      writeJson(res, 202, {
        ok: true,
        value: {
          scheduled: false,
          relaunchDisabled: true,
          armDelayMs,
          trayTriggerWritten: triggerWritten,
          plan: { targetPid: plan.targetPid, targetKind: plan.targetKind, exe: plan.exe, args: plan.args, logPath: plan.logPath, resultPath: plan.resultPath },
        },
      })
      return
    }

    const timer = setTimeout(() => {
      pending.delete(timer)
      void (async () => {
        // Test-only seam: a route-level test exercises the arming path without
        // ever starting a supervisor. Production leaves this unset.
        const result = process.env.DSH_RESTART_NO_ARM === '1'
          ? { spawned: true, supervisorPid: null, error: null, stubbed: true }
          : await spawnSupervisor(plan, config.runtime)
        if (result.spawned) {
          ctx.logger?.info?.('dsh-plugin-restart: supervisor armed (%s) for target pid %s', String(result.via ?? 'spawn'), String(plan.targetPid))
        } else {
          // Only a FAILED arm hands the request to the tray: writing the trigger on
          // every request made a resident tray a second authority racing the
          // supervisor, which could kill the freshly relaunched instance.
          const handedToTray = writeTrayTrigger(plan, { armedBy: 'host:supervisor-failed', error: result.error ?? 'unknown error' })
          ctx.logger?.warn?.('dsh-plugin-restart: supervisor could not start (%s); tray trigger written=%s', result.error ?? 'unknown error', String(handedToTray))
        }
      })()
    }, armDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    pending.add(timer)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const handle of pending) clearTimeout(handle)
        pending.clear()
      }, 'dsh-plugin-restart: armed restarts')
    }

    writeJson(res, 202, {
      ok: true,
      value: {
        scheduled: true,
        armDelayMs,
        // The tray trigger is written only if the supervisor fails to start; it is
        // the fallback authority, not a second one racing the supervisor.
        trayFallback: true,
        plan: {
          targetPid: plan.targetPid,
          targetKind: plan.targetKind,
          exe: plan.exe,
          args: plan.args,
          graceMs: plan.graceMs,
          logPath: plan.logPath,
          resultPath: plan.resultPath,
        },
      },
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: statusHandler }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/restart`, handler: restartHandler }),
  ]
  for (const dispose of disposers) {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-plugin-restart: restart route')
  }
  ctx.logger?.info?.('dsh-plugin-restart: routes mounted at %s (dryRun=%s, stateDir=%s)', ROUTE_PREFIX, String(config.dryRun), config.stateDir)
}
