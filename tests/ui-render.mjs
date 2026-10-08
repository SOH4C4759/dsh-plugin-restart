#!/usr/bin/env node
/**
 * Behavioural verification of the browser half, without a browser.
 *
 * File hashes prove the bytes; this proves the BRANCHES. `client.js` is loaded
 * in `node:vm` with a stub React plus the two platform services it injects, its
 * `apply(ctx)` is mounted against a stub context, and the component it
 * registers into `sidebar.footer.action` is really rendered — first closed,
 * then again after the trigger is pressed:
 *
 *   - the trigger stays icon-only (the sidebar foot is a compact control row)
 *     and keeps its accessible name;
 *   - pressing it renders the confirmation as an INSET OF THE SIDEBAR COLUMN:
 *     anchored to the trigger's own wrapper, as wide as the sidebar's content
 *     column — not a card parked in the bottom-left corner of the window;
 *   - the question is the only title, and the scope note is a separate,
 *     body-weight, tertiary-coloured annotation.
 *
 * Usage:
 *   node tests/ui-render.mjs [--bundle <client.js>] [--control]
 *
 *   --bundle   check another copy of the browser half. This is how the negative
 *              control is run: `git show <before>:client.js > <file>` and expect
 *              the NEW expectations to fail on it.
 *   --control  expect the arrangement to be ABSENT: exit 0 only when at least
 *              one expectation fails, i.e. the checker still discriminates
 *              instead of asserting something that was always true.
 *
 * Exit codes: 0 as expected, 1 otherwise (including "no discriminating failure"
 * under --control), 2 bad usage.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const control = argv.includes('--control')

function argValue(flag, fallback) {
  const at = argv.indexOf(flag)
  if (at === -1) return fallback
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value`)
    process.exit(2)
  }
  return value
}

const bundlePath = resolve(argValue('--bundle', join(packageRoot, 'client.js')))
if (!existsSync(bundlePath)) {
  console.error(`[FAIL] the browser half is missing: ${bundlePath}`)
  process.exit(2)
}

/* -------------------------------------------------------------- stub React */

function createStub() {
  const values = new Map()
  const effectSlots = new Map()
  const ownerPath = []
  let cursor = 0
  let dirty = false
  let pendingEffects = []
  const hookKey = () => ownerPath.join('/') + '#' + String(cursor++)

  const flatten = (children) => children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== 'boolean')
  const element = (type, props, children) => ({ $$el: true, type, props: props ?? {}, children: flatten(children) })

  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => element(type, props, children),
    useState: (initial) => {
      const key = hookKey()
      if (!values.has(key)) values.set(key, typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        const value = typeof next === 'function' ? next(values.get(key)) : next
        if (value !== values.get(key)) { values.set(key, value); dirty = true }
      }
      return [values.get(key), set]
    },
    useRef: (initial) => {
      const key = hookKey()
      if (!values.has(key)) values.set(key, { current: initial })
      return values.get(key)
    },
    useEffect: (fn, deps) => { pendingEffects.push({ key: hookKey(), fn, deps }) },
    useLayoutEffect: (fn, deps) => { pendingEffects.push({ key: hookKey(), fn, deps }) },
    useCallback: (fn) => {
      const key = hookKey()
      if (!values.has(key)) values.set(key, fn)
      return values.get(key)
    },
    useMemo: (fn) => {
      const key = hookKey()
      if (!values.has(key)) values.set(key, fn())
      return values.get(key)
    },
    memo: (component) => component,
    createRef: () => ({ current: null }),
    Children: { map: (children, fn) => flatten([children]).map(fn), toArray: (children) => flatten([children]) },
    isValidElement: (value) => Boolean(value && value.$$el),
  }

  const styleElements = []
  const documentStub = {
    visibilityState: 'visible',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: () => {}, append: () => {}, appendChild: () => {}, textContent: '', style: {}, dataset: {} }),
    head: { append: (el) => styleElements.push(el), appendChild: (el) => styleElements.push(el) },
    body: { append: () => {}, appendChild: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  return {
    React, documentStub, styleElements,
    runEffects: async () => {
      for (const effect of pendingEffects) {
        const slot = effectSlots.get(effect.key)
        const deps = effect.deps
        const changed = slot === undefined || deps === undefined || slot.deps === undefined
          || deps.length !== slot.deps.length || deps.some((v, i) => v !== slot.deps[i])
        if (!changed) continue
        if (typeof slot?.cleanup === 'function') slot.cleanup()
        effectSlots.set(effect.key, { deps, cleanup: effect.fn() })
      }
      await new Promise((r) => { setTimeout(r, 0) })
    },
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; pendingEffects = []; cursor = 0; ownerPath.length = 0 },
    begin: () => { ownerPath.push('root') },
    cursorRestore: () => { cursor = 0 },
  }
}

/* ------------------------------------------------------------- tree walking */

const childrenOf = (node) => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node.children) && node.children.length > 0) return node.children
  const fromProps = node.props?.children
  if (fromProps === undefined || fromProps === null || typeof fromProps === 'boolean') return []
  return Array.isArray(fromProps) ? fromProps.flat(Infinity) : [fromProps]
}

function renderTree(stub, node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, at) => renderTree(stub, child, path + '.' + String(at)))
  if (typeof node.type === 'function') {
    const name = node.type.name || node.type.displayName || 'Component'
    stub.begin()
    let output
    try { output = node.type(node.props ?? {}) } finally { stub.cursorRestore() }
    return { $$host: 'component', name, value: renderTree(stub, output, path + '<' + name + '>') }
  }
  return { $$host: node.type, props: node.props ?? {}, children: childrenOf(node).map((c, at) => renderTree(stub, c, path + '.' + String(at))) }
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.$$host === 'component') return textOf(node.value)
  return (node.children ?? []).map(textOf).join(' ')
}

function findHost(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findHost(c, predicate, out); return out }
  if (node.$$host === 'component') { findHost(node.value, predicate, out); return out }
  if (node.$$host && predicate(node)) out.push(node)
  for (const c of node.children ?? []) findHost(c, predicate, out)
  return out
}

/* ------------------------------------------------------------------ loading */

function loadBundle(file, stub) {
  const source = readFileSync(file, 'utf8')
  const registered = []
  const sandbox = {
    console,
    setTimeout, clearTimeout, queueMicrotask,
    setInterval: () => 0, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }), text: async () => '' }),
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder,
    JSON, Date, Math, Number, String, Boolean, Array, Object, Error, TypeError, Promise, RegExp, Symbol, Map, Set, Intl, WeakMap, WeakSet,
    document: stub.documentStub,
    HTMLElement: class HTMLElement {},
    Element: class Element {},
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    navigator: { userAgent: 'ui-render', webdriver: true, clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => 'false', setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load: ({ factory }) => {
      sandbox.__module = factory((name) => {
        if (name === 'react') return stub.React
        throw new Error('unexpected require in ' + file + ': ' + name)
      })
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: file })
  const module = sandbox.__module
  if (module === undefined || module === null) throw new Error('the bundle never called window.__ModuleLoader__.load()')

  const dictionaries = {}
  let dictionary = null
  const translate = (key, params) => {
    const template = dictionary?.[key] ?? key
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (whole, k) => (k in params ? String(params[k]) : whole))
  }
  const ctx = {
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    inject: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    provide: () => {},
    get: () => undefined,
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; dictionary = dicts?.zh ?? null; return () => {} },
      bind: () => translate,
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (name, fn) => {
        const produced = fn()
        const disposers = []
        if (produced && typeof produced.next === 'function') {
          let step = produced.next()
          while (step.done !== true) {
            if (typeof step.value === 'function') disposers.push(step.value)
            step = produced.next()
          }
        } else if (typeof produced === 'function') disposers.push(produced)
        return () => { for (const off of disposers) off() }
      },
      register: (meta, component) => { registered.push({ meta, component }); return () => {} },
      entries: () => [],
      entriesOfSlot: () => [],
      subscribe: () => () => {},
      getVersion: () => 0,
    },
  }
  module.apply(ctx)
  return { registered, translate, source, dictionaries }
}

async function renderComponent(stub, component, props) {
  let tree = null
  for (let round = 0; round < 6; round += 1) {
    stub.clearDirty()
    stub.begin()
    tree = renderTree(stub, component(props), 'root')
    await stub.runEffects()
    if (!stub.isDirty()) break
  }
  return tree
}

/* ------------------------------------------------------------------- checks */

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''))
}

const stub = createStub()
let loaded = null
try {
  loaded = loadBundle(bundlePath, stub)
} catch (error) {
  console.error('[FAIL] the browser half did not load: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

const { registered, translate, source } = loaded
const slots = registered.map((entry) => entry.meta?.name)
const entry = registered.find((row) => row.meta?.name === 'sidebar.footer.action')

check('registers one sidebar.footer.action entry', Boolean(entry), 'slots=' + JSON.stringify(slots))
check('the entry keeps the stable id and the low order', entry?.meta?.id === 'dsh-restart' && entry?.meta?.order === 10,
  `id=${String(entry?.meta?.id)} order=${String(entry?.meta?.order)}`)

const injected = typeof entry?.meta?.inject === 'function' ? entry.meta.inject() : {}
const closed = await renderComponent(stub, entry.component, { wide: true, ...injected })
const triggerButtons = findHost(closed, (node) => node.$$host === 'button')
check('closed: exactly one trigger button', triggerButtons.length === 1, 'buttons=' + String(triggerButtons.length))
check('closed: icon only, no visible text', textOf(closed).trim() === '', 'text=' + JSON.stringify(textOf(closed).trim()))
check('closed: the button keeps the full accessible name',
  triggerButtons[0]?.props?.['aria-label'] === '重启 DSH（应用与 Host）',
  'aria-label=' + JSON.stringify(triggerButtons[0]?.props?.['aria-label']))
check('closed: the glyph is drawn', findHost(closed, (node) => node.$$host === 'svg').length === 1)
check('closed: the trigger advertises a dialog and is collapsed',
  triggerButtons[0]?.props?.['aria-haspopup'] === 'dialog' && triggerButtons[0]?.props?.['aria-expanded'] === false)
check('closed: no confirmation is rendered yet', findHost(closed, (node) => node.props?.role === 'dialog').length === 0)

// Press the trigger: the panel path is what the rest of the checks are about.
if (typeof triggerButtons[0]?.props?.onClick === 'function') triggerButtons[0].props.onClick()
const open = await renderComponent(stub, entry.component, { wide: true, ...injected })

const dialogs = findHost(open, (node) => node.props?.role === 'dialog')
check('open: pressing the trigger renders the confirmation', dialogs.length === 1, 'dialogs=' + String(dialogs.length))

const panel = dialogs[0] ?? null
check('open: the panel is the plugin\'s own seat, anchored to the trigger wrapper',
  panel?.props?.className === 'dshr-panel' || String(panel?.props?.className).includes('dshr-panel'),
  'class=' + JSON.stringify(panel?.props?.className))

const openButtons = panel === null ? [] : findHost(panel, (node) => node.$$host === 'button')
check('open: the panel asks exactly two questions worth of buttons',
  openButtons.length === 2 && textOf(openButtons[0]) === '取消' && textOf(openButtons[1]) === '立即重启',
  'button texts=' + JSON.stringify(openButtons.map((b) => textOf(b))))

const headings = panel === null ? [] : findHost(panel, (node) => typeof node.$$host === 'string' && /^h[1-6]$/.test(node.$$host))
check('open: nothing in the panel is a document heading', headings.length === 0, 'headings=' + String(headings.length))

const titleSpans = panel === null ? [] : findHost(panel, (node) => String(node.props?.className) === 'dshr-title')
const noteSpans = panel === null ? [] : findHost(panel, (node) => String(node.props?.className) === 'dshr-note')
check('open: the question is the only title', titleSpans.length === 1 && textOf(titleSpans[0]) === '重启 DSH',
  'title=' + JSON.stringify(titleSpans.map((n) => textOf(n))))
check('open: the scope note is its own element, not the title',
  noteSpans.length === 1 && textOf(noteSpans[0]) === '（应用与 Host）' && noteSpans[0] !== titleSpans[0],
  'note=' + JSON.stringify(noteSpans.map((n) => textOf(n))))
check('open: the note lives inside the panel, beside the question',
  noteSpans.length === 1 && titleSpans.length === 1 && panel !== null
    && findHost(panel, (n) => n === noteSpans[0]).length === 1,
  'panel contains the note')

/* ------------------------------------------------------------- the stylesheet */

const noteRule = /\.dshr-note \{[^}]*\}/.exec(source)?.[0] ?? ''
const titleRule = /\.dshr-title \{[^}]*\}/.exec(source)?.[0] ?? ''
const panelRule = /\.dshr-panel \{[^}]*\}/.exec(source)?.[0] ?? ''

check('css: the note is not bold', /font-weight:\s*400/.test(noteRule) && !/font-weight:\s*[5-9]00/.test(noteRule), noteRule.trim())
check('css: the note is de-emphasised with the tertiary label colour',
  noteRule.includes('var(--dsw-alias-label-tertiary)'), noteRule.trim())
check('css: the note is smaller than the question', /font-size:\s*12px/.test(noteRule) && /font-size:\s*13px/.test(titleRule),
  `note: ${noteRule.trim()} | title: ${titleRule.trim()}`)
check('css: the question keeps the title weight', /font-weight:\s*600/.test(titleRule), titleRule.trim())

check('css: the panel is anchored to the trigger inside the sidebar column',
  /position:\s*absolute/.test(panelRule) && /left:\s*0/.test(panelRule) && /bottom:\s*calc\(100% \+ 6px\)/.test(panelRule),
  panelRule.replace(/\s+/g, ' ').trim().slice(0, 120))
check('css: no viewport-corner window remains',
  !/position:\s*fixed;\s*left:\s*8px/.test(source) && !/width:\s*320px/.test(source))
check('css: the width is the sidebar content column, from the frame\'s own variables',
  panelRule.includes('--dsh-windows-sidebar-width') && panelRule.includes('--dsh-sidebar-inline-padding'),
  'sidebar-width + inline-padding')
check('css: still no rect maths', !source.includes('getBoundingClientRect'))
check('css: theme tokens only, no literal colours', (() => {
  const colors = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]).filter((c) => c !== '#fff')
  return colors.length === 0
})())

/* ------------------------------------------------------------------ verdict */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\nbrowser half — ${control ? 'control (pre-change expected)' : 'target state'} — ${passed}/${results.length} checks passed`)

if (control) {
  if (failed === 0) {
    console.log('RESULT: the checker no longer discriminates (every new expectation passed on the old bundle)')
    process.exit(1)
  }
  console.log(`RESULT: ok — ${failed} expectation(s) correctly failed on the old bundle`)
  process.exit(0)
}
if (failed > 0) {
  console.log('RESULT: the sidebar-inset confirmation is NOT fully in place')
  process.exit(1)
}
console.log('RESULT: ok')
process.exit(0)
