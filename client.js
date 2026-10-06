/**
 * Browser half of the `dsh-plugin-restart` bundle.
 *
 * Adds one icon-only button to the `sidebar.footer.action` slot (at the sidebar
 * foot, beside the account launcher) that asks the Host to arm a restart of the
 * whole desktop app.
 *
 * Deliberate choices, each one a fix for a defect found in review:
 *   - No Harness Client package is required; only `react`, which is a platform
 *     seed word in the client module table.
 *   - The stylesheet is tagged `data-plugin`/`data-plugin-css` so the loader's
 *     claimStyles/removeOwnedStyles cannot take it over or delete it.
 *   - The popover is CSS-anchored inside a `position: relative` wrapper instead of
 *     measuring rects: this slot renders inside a layout-containment box, where
 *     `position: fixed` resolves against that box, not the viewport.
 *   - "Armed" requires `value.scheduled === true`; a dry run answers 200 with
 *     `scheduled: false` and must not be reported as a restart.
 *   - Every request is aborted after a timeout, and a failure stays retryable.
 *   - Visible text comes from the Client locale service, so English is reachable.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NAMESPACE = 'dsh-restart'
    const STYLE_ID = 'dsh-plugin-restart-styles'
    const STATUS_URL = '/api/dsh-restart/status'
    const RESTART_URL = '/api/dsh-restart/restart'
    const REQUEST_TIMEOUT_MS = 10_000

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'action.label': '重启 DSH',
      'action.title': '重启 DSH（应用与 Host）',
      'dialog.title': '重启 DSH（应用与 Host）',
      'dialog.lastFailure': '上次重启未完成：{reason}',
      'action.cancel': '取消',
      'action.confirm': '立即重启',
      'action.busy': '正在请求…',
      'action.armed': '已安排',
      'action.retry': '重试',
      'state.armed': 'DSH 即将重启，页面会在应用回来后重新连接…',
      'state.notScheduled': 'Host 未安排重启（演练模式或已禁用），应用不会关闭。',
      'state.hostGone': '无法连接 Host；若应用已退出，请手动重新打开。',
      'state.failed': '重启请求失败：{reason}',
      'state.timeout': '请求超时，未确认重启。',
      'status.failed': '状态请求失败（HTTP {status}）',
    }

    /** English dictionary, same key set. */
    const en = {
      'action.label': 'Restart DSH',
      'action.title': 'Restart DSH (app and Host)',
      'dialog.title': 'Restart DSH (app and Host)',
      'dialog.lastFailure': 'Previous restart did not finish: {reason}',
      'action.cancel': 'Cancel',
      'action.confirm': 'Restart now',
      'action.busy': 'Requesting…',
      'action.armed': 'Scheduled',
      'action.retry': 'Retry',
      'state.armed': 'DSH is restarting; this page reconnects once the app is back…',
      'state.notScheduled': 'The Host did not schedule a restart (dry run or disabled), so the app stays open.',
      'state.hostGone': 'Cannot reach the Host; if the app exited, reopen it manually.',
      'state.failed': 'Restart request failed: {reason}',
      'state.timeout': 'The request timed out, so no restart was confirmed.',
      'status.failed': 'Status request failed (HTTP {status})',
    }

    const CSS = `
.dshr-anchor { position: relative; display: inline-flex; align-items: center; }
.dshr-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 8px; border: 1px solid transparent;
  border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.dshr-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshr-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshr-button[data-busy="true"] { opacity: .6; cursor: default; }
.dshr-icon { display: block; width: 16px; height: 16px; flex: none; }
.dshr-popover {
  /* The trigger sits at the sidebar foot, so the panel opens from the bottom-left
     corner and can never hang off the left edge or leave the viewport. */
  position: fixed; left: 8px; bottom: 8px; z-index: 2147483000;
  width: 320px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
  overflow: auto; padding: 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  box-shadow: 0 12px 32px rgb(0 0 0 / 24%); font-size: 13px; line-height: 1.55;
}
.dshr-popover:focus { outline: none; }
.dshr-title { font-weight: 600; margin: 0 0 6px; font-size: 13px; }
.dshr-text { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); }
.dshr-meta { margin: 0 0 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-all; }
.dshr-warn { margin: 8px 0 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.dshr-error { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dshr-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.dshr-action {
  height: 28px; padding: 0 12px; border-radius: 6px; font: inherit; font-size: 12px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary);
}
.dshr-action:hover { background: var(--dsw-alias-bg-layer-2); }
.dshr-action[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary); color: #fff; }
.dshr-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshr-action[disabled] { opacity: .6; cursor: default; }
.dshr-overlay {
  position: fixed; z-index: 2147483001; left: 50%; top: 18px; transform: translateX(-50%);
  max-width: calc(100vw - 32px); padding: 10px 16px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  font-size: 13px; box-shadow: 0 12px 32px rgb(0 0 0 / 24%);
}
`

    /**
     * Inject the stylesheet once per document.
     *
     * The loader's materialize step claims every `<style>` that carries no
     * `data-plugin` attribute for the package being materialized, and a later HMR
     * replace of THAT package deletes what it claimed. Tagging the element with
     * this package's own identity keeps it out of both paths.
     */
    function ensureStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-plugin-restart')
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.append(style)
    }

    /** Read a JSON response defensively; never throws. */
    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return null
      }
    }

    /** POST one JSON body with a hard timeout; distinguishes a timeout from a drop. */
    async function postJson(url, body) {
      const controller = new AbortController()
      const timer = globalThis.setTimeout(() => {
        controller.abort()
      }, REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        })
        return { ok: true, response, payload: await readJson(response) }
      } catch (error) {
        return { ok: false, aborted: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) }
      } finally {
        globalThis.clearTimeout(timer)
      }
    }

    /** A compact restart glyph, drawn with `currentColor` so it follows the theme. */
    function RestartGlyph() {
      return h(
        'svg',
        { className: 'dshr-icon', viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.4 2.6v3.4H10',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** A compact, human-readable description of the restart target. */
    function describeTarget(value) {
      const target = value?.target
      if (target === undefined || target === null) return ''
      const parts = []
      if (typeof target.exe === 'string') parts.push(target.exe)
      if (Number.isInteger(target.pid)) parts.push(`PID ${String(target.pid)}`)
      return parts.join(' · ')
    }

    // The target description is deliberately not rendered in the confirmation:
    // the dialog asks one question. It stays available for the status payload and
    // for a future detail view.
    void describeTarget

    /**
     * The header action: a trigger button plus its confirmation popover.
     * @param props - slot props, carrying `t` for the registered namespace.
     */
    function RestartAction(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const buttonRef = React.useRef(null)
      const popoverRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [armed, setArmed] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      const popoverId = 'dsh-plugin-restart-popover'

      const loadStatus = React.useCallback(async () => {
        const result = await postJson(STATUS_URL, {})
        if (!result.ok) {
          setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          setStatus(result.payload.value ?? null)
          setError(null)
          return
        }
        setError(t('status.failed', { status: String(result.response.status) }))
      }, [t])

      const close = React.useCallback(() => {
        setOpen(false)
        setError(null)
      }, [])

      // Escape closes and focus returns to the trigger. No stopPropagation: this
      // popover is not modal, so it must not swallow Escape from other surfaces.
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
          setError(null)
          const trigger = buttonRef.current
          if (trigger !== null) trigger.focus()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      // Outside click closes, but never while a request is in flight: the failure
      // report would have nowhere to render once the popover is gone.
      React.useEffect(() => {
        if (!open || busy) return undefined
        const onPointerDown = (event) => {
          const node = event.target
          if (node instanceof Element && node.closest('[data-dsh-restart-anchor]') !== null) return
          setOpen(false)
          setError(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, busy])

      // Move focus into the dialog when it opens, so its buttons are reachable
      // without a mouse.
      React.useEffect(() => {
        if (!open) return
        const node = popoverRef.current
        if (node !== null) node.focus()
      }, [open])

      const requestRestart = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        const result = await postJson(RESTART_URL, {})
        setBusy(false)
        if (!result.ok) {
          // A dropped connection usually means the Host went down, but an abort is
          // not proof: report it and leave the button retryable.
          setNotice(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        const value = result.payload?.value
        if (result.response.ok && result.payload?.ok === true && value?.scheduled === true) {
          setArmed(true)
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          setNotice(t('state.notScheduled'))
          return
        }
        setError(t('state.failed', { reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }))
      }, [t])

      const openPopover = React.useCallback(() => {
        setOpen(true)
        setNotice(null)
        void loadStatus()
      }, [loadStatus])

      const popover = open
        ? h(
            'div',
            {
              className: 'dshr-popover',
              id: popoverId,
              ref: popoverRef,
              tabIndex: -1,
              role: 'dialog',
              'aria-label': t('dialog.title'),
            },
            // One line, one question. Target/delay metadata, warnings and the
            // previous outcome are only shown when they carry information the
            // user must act on (a failure or a refused request).
            h('p', { className: 'dshr-title' }, t('dialog.title')),
            error !== null ? h('p', { className: 'dshr-error', role: 'alert' }, error) : null,
            notice !== null ? h('p', { className: 'dshr-warn', role: 'status' }, notice) : null,
            status?.lastResult?.ok === false && typeof status.lastResult.reason === 'string'
              ? h('p', { className: 'dshr-warn' }, t('dialog.lastFailure', { reason: status.lastResult.reason }))
              : null,
            h(
              'div',
              { className: 'dshr-row' },
              h('button', { type: 'button', className: 'dshr-action', onClick: close, disabled: busy }, t('action.cancel')),
              armed
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshr-action',
                      'data-primary': 'true',
                      disabled: busy,
                      onClick: () => {
                        void requestRestart()
                      },
                    },
                    busy ? t('action.busy') : error === null ? t('action.confirm') : t('action.retry'),
                  ),
              armed ? h('button', { type: 'button', className: 'dshr-action', disabled: true }, t('action.armed')) : null,
            ),
          )
        : null

      return h(
        'div',
        { className: 'dshr-anchor', 'data-dsh-restart-anchor': '' },
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: 'dshr-button',
            title: t('action.title'),
            'aria-label': t('action.title'),
            'aria-haspopup': 'dialog',
            'aria-controls': open ? popoverId : undefined,
            'aria-expanded': open,
            'data-busy': busy ? 'true' : 'false',
            onClick: () => {
              if (open) close()
              else openPopover()
            },
          },
          h(RestartGlyph, null),
          // Icon only: the sidebar foot is a compact control row, so the button
          // never renders a text label — its name lives in the tooltip and the
          // accessible label.
        ),
        popover,
        armed ? h('div', { className: 'dshr-overlay', role: 'status' }, t('state.armed')) : null,
      )
    }

    return {
      name: 'ui-dsh-restart',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        ctx.effect(
          () => ctx.locale.register(NAMESPACE, { zh, en }),
          'dsh-plugin-restart: dictionaries',
        )
        // Sidebar foot, beside the account launcher and the shipped footer actions:
        // the button lives with the other compact column controls instead of the
        // session header. `order: 10` puts it after the account launcher and before
        // the shipped entries that order themselves at 26 and above.
        const dispose = ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-restart',
              order: 10,
              locale: NAMESPACE,
              inject: () => ({ t: ctx.locale.bind(NAMESPACE) }),
            },
            RestartAction,
          ),
        )
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => dispose, 'dsh-plugin-restart: header action')
        }
      },
    }
  },
})
