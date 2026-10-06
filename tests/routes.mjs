/**
 * Route-contract checks for the Host half.
 *
 * Mounts the real plugin on a fake Host context, captures the two registered
 * routes and drives them with fake req/res objects. Nothing is restarted and no
 * supervisor is ever spawned: `DSH_RESTART_NO_ARM=1` replaces the arming call
 * with a stub, and `dryRun` is exercised through the real handler.
 *
 *   node tests/routes.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.DSH_RESTART_NO_ARM = '1'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const host = await import(pathToFileURL(join(packageRoot, 'index.js')).href)

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` - ${detail}`}`)
}

function makeReq({ method = 'POST', address = '127.0.0.1', host: hostHeader = '127.0.0.1:19387', origin = 'http://127.0.0.1:19387', body = '{}' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method,
    socket: { remoteAddress: address },
    headers: { host: hostHeader, ...(origin === undefined ? {} : { origin }) },
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }),
      }
    },
    destroy() {},
  }
  return req
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    payload: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
    },
    end(text) {
      res.payload = text ?? ''
    },
    json() {
      return JSON.parse(res.payload)
    },
  }
  return res
}

/** Mount the plugin and return its routes by path. */
function mount(config, stateDir) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    logger: { info() {}, warn() {} },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = stateDir
  try {
    host.apply(ctx, config)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  return routes
}

const workDir = join(tmpdir(), `dsh-restart-routes-${String(process.pid)}`)
mkdirSync(workDir, { recursive: true })

try {
  // --- mounting ------------------------------------------------------------
  const routes = mount({ armDelayMs: 0, graceMs: 300 }, workDir)
  record('both routes are mounted at their exact paths', routes.size === 2 && routes.has('/api/dsh-restart/status') && routes.has('/api/dsh-restart/restart'), [...routes.keys()].join(', '))
  for (const route of routes.values()) {
    assert.equal(route.kind, 'exact')
  }

  const status = routes.get('/api/dsh-restart/status')
  const restart = routes.get('/api/dsh-restart/restart')

  // --- status --------------------------------------------------------------
  {
    const res = makeRes()
    await status.handler(makeReq(), res)
    const body = res.json()
    record('status answers 200 with ok:true', res.statusCode === 200 && body.ok === true, `HTTP ${String(res.statusCode)}`)
    record('status reports the target and supervisor runtime', Number.isInteger(body.value?.target?.pid) && typeof body.value?.supervisorScript === 'string' && typeof body.value?.supervisorRuntime?.source === 'string', JSON.stringify({ pid: body.value?.target?.pid, source: body.value?.supervisorRuntime?.source }))
    record('status sets no-store and no-referrer', res.headers?.['cache-control'] === 'no-store' && res.headers?.['referrer-policy'] === 'no-referrer', JSON.stringify(res.headers))
  }

  // --- guards --------------------------------------------------------------
  {
    const res = makeRes()
    await status.handler(makeReq({ address: '10.0.0.5' }), res)
    record('non-loopback peer is refused with 403', res.statusCode === 403 && res.json().code === 'forbidden', `HTTP ${String(res.statusCode)}`)
  }
  {
    const res = makeRes()
    await restart.handler(makeReq({ address: '10.0.0.5' }), res)
    record('restart refuses a non-loopback peer before doing anything', res.statusCode === 403 && res.json().code === 'forbidden', `HTTP ${String(res.statusCode)}`)
  }
  {
    const res = makeRes()
    await restart.handler(makeReq({ origin: 'http://evil.example' }), res)
    record('cross-origin POST is refused', res.statusCode === 403, `HTTP ${String(res.statusCode)}`)
  }
  {
    const res = makeRes()
    await restart.handler(makeReq({ method: 'GET' }), res)
    record('GET is refused with 405', res.statusCode === 405 && res.json().code === 'method-not-allowed', `HTTP ${String(res.statusCode)}`)
  }

  // --- dry run -------------------------------------------------------------
  {
    const res = makeRes()
    await restart.handler(makeReq({ body: '{"dryRun":true}' }), res)
    const body = res.json()
    record('dryRun answers 200 with scheduled:false and a plan', res.statusCode === 200 && body.value?.scheduled === false && body.value?.dryRun === true && body.value?.plan?.parentPid === body.value?.plan?.targetPid, JSON.stringify({ status: res.statusCode, scheduled: body.value?.scheduled }))
    record('dryRun plan carries the supervisor and paths', typeof body.value?.plan?.supervisorScript === 'string' && typeof body.value?.plan?.resultPath === 'string' && typeof body.value?.plan?.logPath === 'string', body.value?.plan?.supervisorScript ?? '')
  }

  // --- arming (stubbed spawn) ---------------------------------------------
  {
    const res = makeRes()
    await restart.handler(makeReq({ body: '{"armDelayMs":0}' }), res)
    const body = res.json()
    record('arming answers 202 with scheduled:true', res.statusCode === 202 && body.value?.scheduled === true, `HTTP ${String(res.statusCode)}`)
    record('arming declares the tray as a fallback, not a race', body.value?.trayFallback === true, JSON.stringify({ trayFallback: body.value?.trayFallback }))
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }

  // --- malformed input -----------------------------------------------------
  {
    const res = makeRes()
    await restart.handler(makeReq({ body: 'not json' }), res)
    record('a malformed body falls back to defaults instead of throwing', res.statusCode === 202 || res.statusCode === 200, `HTTP ${String(res.statusCode)}`)
  }

  // --- disabled ------------------------------------------------------------
  {
    const disabledRoutes = mount({ enabled: false }, workDir)
    const res = makeRes()
    await disabledRoutes.get('/api/dsh-restart/restart').handler(makeReq({ body: '{}' }), res)
    record('enabled:false answers 409', res.statusCode === 409 && res.json().code === 'disabled', `HTTP ${String(res.statusCode)}`)
    const statusRes = makeRes()
    await disabledRoutes.get('/api/dsh-restart/status').handler(makeReq(), statusRes)
    record('status still works while disabled', statusRes.statusCode === 200 && statusRes.json().value?.enabled === false, `HTTP ${String(statusRes.statusCode)}`)
  }

  // --- config dryRun makes the route a pure plan ---------------------------
  {
    const dryRoutes = mount({ dryRun: true }, workDir)
    const res = makeRes()
    await dryRoutes.get('/api/dsh-restart/restart').handler(makeReq({ body: '{}' }), res)
    const body = res.json()
    record('config dryRun:true never arms', res.statusCode === 200 && body.value?.scheduled === false, JSON.stringify({ status: res.statusCode, scheduled: body.value?.scheduled }))
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} route checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
