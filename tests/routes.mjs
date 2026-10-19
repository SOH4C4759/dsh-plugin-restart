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
  const expected = [
    '/api/dsh-restart/status',
    '/api/dsh-restart/restart',
    '/api/dsh-restart/state',
    '/api/dsh-restart/settings',
    '/api/dsh-restart/dismiss',
  ]
  record('every route is mounted at its exact path', routes.size === expected.length && expected.every((path) => routes.has(path)), [...routes.keys()].join(', '))
  for (const route of routes.values()) {
    assert.equal(route.kind, 'exact')
  }

  const status = routes.get('/api/dsh-restart/status')
  const restart = routes.get('/api/dsh-restart/restart')
  const state = routes.get('/api/dsh-restart/state')
  const settings = routes.get('/api/dsh-restart/settings')
  const dismiss = routes.get('/api/dsh-restart/dismiss')
  const stateDir = join(workDir, 'dsh-plugin-restart')

  // --- status --------------------------------------------------------------
  {
    const res = makeRes()
    await status.handler(makeReq(), res)
    const body = res.json()
    record('status answers 200 with ok:true', res.statusCode === 200 && body.ok === true, `HTTP ${String(res.statusCode)}`)
    record('status reports the target and supervisor runtime', Number.isInteger(body.value?.target?.pid) && typeof body.value?.supervisorScript === 'string' && typeof body.value?.supervisorRuntime?.source === 'string', JSON.stringify({ pid: body.value?.target?.pid, source: body.value?.supervisorRuntime?.source }))
    record('status sets no-store and no-referrer', res.headers?.['cache-control'] === 'no-store' && res.headers?.['referrer-policy'] === 'no-referrer', JSON.stringify(res.headers))
    record('status carries the seat settings and the pending marker', body.value?.settings?.position === 'sidebar-footer' && body.value?.pending === null && Array.isArray(body.value?.positions), JSON.stringify({ position: body.value?.settings?.position, pending: body.value?.pending }))
  }

  // --- state (cheap read) --------------------------------------------------
  {
    const res = makeRes()
    await state.handler(makeReq({ body: '{}' }), res)
    const body = res.json()
    record('state answers settings + pending without a restart plan',
      res.statusCode === 200
        && body.value?.settings?.position === 'sidebar-footer'
        && body.value?.settings?.prompt === true
        && body.value?.pending === null
        && body.value?.plan === undefined,
      JSON.stringify(body.value?.settings))
    record('state does not scan processes', body.value?.target === undefined, 'no target in the cheap answer')
  }

  // --- settings ------------------------------------------------------------
  {
    const res = makeRes()
    await settings.handler(makeReq({ body: '{"position":"session-header"}' }), res)
    const body = res.json()
    record('settings writes the chosen seat and answers with it',
      res.statusCode === 200 && body.value?.settings?.position === 'session-header' && body.value?.settings?.source === 'settings',
      JSON.stringify(body.value?.settings))
    const again = makeRes()
    await state.handler(makeReq({ body: '{}' }), again)
    record('the chosen seat survives a later read', again.json().value?.settings?.position === 'session-header', String(again.json().value?.settings?.position))
  }
  {
    const res = makeRes()
    await settings.handler(makeReq({ body: '{"position":"nonsense"}' }), res)
    record('an unknown seat is ignored instead of unmounting the button', res.json().value?.settings?.position === 'session-header', String(res.json().value?.settings?.position))
  }
  {
    const res = makeRes()
    await settings.handler(makeReq({ body: '{"prompt":false}' }), res)
    record('settings can switch the end-of-Turn prompt off', res.json().value?.settings?.prompt === false, JSON.stringify(res.json().value?.settings))
    const back = makeRes()
    await settings.handler(makeReq({ body: '{"prompt":true}' }), back)
    record('settings can switch it back on', back.json().value?.settings?.prompt === true, JSON.stringify(back.json().value?.settings))
  }

  // --- pending marker ------------------------------------------------------
  {
    host.recordPending(stateDir, { reason: 'install', source: 'plugin-manager' })
    const res = makeRes()
    await state.handler(makeReq({ body: '{}' }), res)
    const pending = res.json().value?.pending
    record('a recorded change becomes a visible pending marker',
      pending !== null && pending.reason === 'install' && Number.isInteger(pending.pid),
      JSON.stringify({ reason: pending?.reason, pid: pending?.pid }))
    const noScan = makeRes()
    await status.handler(makeReq(), noScan)
    record('status exposes the same marker', noScan.json().value?.pending?.reason === 'install', JSON.stringify(noScan.json().value?.pending?.reason))
  }
  {
    const res = makeRes()
    await dismiss.handler(makeReq({ body: '{}' }), res)
    record('dismiss hides the prompt for this change', res.statusCode === 200 && res.json().value?.pending === null, JSON.stringify(res.json().value?.pending))
    const again = makeRes()
    await state.handler(makeReq({ body: '{}' }), again)
    record('dismissal survives a later read', again.json().value?.pending === null, 'hidden')
  }
  {
    host.recordPending(stateDir, { reason: 'bundle', source: 'plugin-manager' })
    const res = makeRes()
    await state.handler(makeReq({ body: '{}' }), res)
    record('a NEW change re-opens the prompt after a dismissal', res.json().value?.pending?.reason === 'bundle', JSON.stringify(res.json().value?.pending?.reason))
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
  for (const [name, route] of [['state', state], ['settings', settings], ['dismiss', dismiss]]) {
    const res = makeRes()
    await route.handler(makeReq({ origin: 'http://evil.example' }), res)
    record(`${name} keeps the same-origin guard`, res.statusCode === 403, `HTTP ${String(res.statusCode)}`)
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
