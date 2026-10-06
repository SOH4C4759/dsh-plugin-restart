/**
 * Post-bootstrap verification: ask the RUNNING Host what it would do.
 *
 * Run this after restarting the app once (the Host half only loads at boot):
 *
 *   node scripts/verify-live.mjs
 *
 * It never restarts anything: it reads `/api/dsh-restart/status` and prints a
 * verdict about the live code generation.
 */

import { existsSync } from 'node:fs'

const BASE = process.env.DSH_BASE_URL ?? 'http://127.0.0.1:19387'
const ORIGIN = BASE

function line(ok, text) {
  console.log(`${ok ? 'OK  ' : 'BAD '} ${text}`)
}

async function call(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, parsed }
}

let failures = 0

const status = await call('/api/dsh-restart/status')
if (status.status !== 200 || status.parsed?.ok !== true) {
  console.log(`status route answered HTTP ${String(status.status)}: ${JSON.stringify(status.parsed)}`)
  console.log('\nThe Host half is not loaded in this process yet — restart the app once, then run this again.')
  process.exitCode = 1
} else {
  const value = status.parsed.value
  console.log('live status:')
  console.log(JSON.stringify(value, null, 2))
  console.log('')

  const checks = [
    [typeof value.supervisorScript === 'string' && value.supervisorScript.endsWith('restart-supervisor.ps1'), `supervisorScript resolves: ${String(value.supervisorScript)}`],
    [existsSync(value.supervisorScript), 'supervisor script exists on disk'],
    [value.supervisorScriptExists !== false, 'Host reports the supervisor exists'],
    [Number.isInteger(value.target?.pid), `restart target pid ${String(value.target?.pid)} (${String(value.target?.kind)})`],
    [typeof value.target?.exe === 'string' && value.target.exe.includes('DeepSeek Harness'), `relaunch executable ${String(value.target?.exe)}`],
    [value.supervisorRuntime?.source === 'windows-powershell' || value.supervisorRuntime?.source === 'DSH_POWERSHELL', `supervisor runtime source: ${String(value.supervisorRuntime?.source)}`],
    [value.lastResult === null || value.lastResult?.ok === true || value.lastResult?.phase === 'stopped-no-launch', `previous restart outcome: ${JSON.stringify(value.lastResult)}`],
  ]
  for (const [ok, text] of checks) {
    line(ok, text)
    if (!ok) failures += 1
  }

  console.log('')
  const dry = await call('/api/dsh-restart/restart', { dryRun: true })
  if (dry.status === 200 && dry.parsed?.value?.scheduled === false) {
    line(true, 'dry run returned a plan without restarting')
    const plan = dry.parsed.value.plan
    line(plan?.parentPid === plan?.targetPid, `plan.parentPid equals plan.targetPid (${String(plan?.parentPid)})`)
  } else {
    line(false, `dry run failed: HTTP ${String(dry.status)} ${JSON.stringify(dry.parsed)}`)
    failures += 1
  }

  if (value.dryRun === true) {
    console.log('\nNOTE: dryRun is still true in the profile patch — remove that config block to enable the real restart.')
  }
}

console.log(`\n${failures === 0 ? 'LIVE VERIFICATION PASSED' : `${String(failures)} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
