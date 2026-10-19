/**
 * Browser half of the `dsh-plugin-restart` bundle.
 *
 * Three surfaces, one authority (the Host routes):
 *   - a trigger in ONE of several shipped seats — `sidebar.footer.action` by
 *     default, or the Session header utilities, the composer toolbar, the
 *     composer dock, or nothing at all (configurable, with presets);
 *   - an end-of-Turn prompt in `conversation.chat.turnTail`, the native seat for
 *     "content before a completed Turn's action row", shown only when the Host
 *     recorded that the plugin/profile set changed after that Turn began. That
 *     is what makes the nudge read as part of the reply instead of a banner;
 *   - a section on this plugin's own page in the Plugins screen that edits the
 *     two preferences (seat, prompt) without touching the profile patch.
 *
 * Deliberate choices, each one a fix for a defect found in review:
 *   - No Harness Client package is required; only `react`, which is a platform
 *     seed word in the client module table.
 *   - The stylesheet is tagged `data-plugin`/`data-plugin-css` so the loader's
 *     claimStyles/removeOwnedStyles cannot take it over or delete it.
 *   - The confirmation panel is CSS-anchored to a `position: relative` wrapper
 *     (no rect maths at all) and sized per seat: the sidebar's own content
 *     column at the foot, a 280px card at the Session header and above the
 *     composer. Anchoring it with `position: absolute` also removes the question
 *     the previous revision could not answer — where `position: fixed` resolves
 *     inside the shell's layout-containment boxes.
 *   - Every preset seat is registered at apply time and renders `null` unless it
 *     is the configured one. The alternative — registering only the chosen seat
 *     — would need the preference before `apply` can run, and the preference is
 *     a Host file. Registering the same component in four seats costs nothing:
 *     a `null` occupant has no layout.
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
    const STATE_URL = '/api/dsh-restart/state'
    const RESTART_URL = '/api/dsh-restart/restart'
    const SETTINGS_URL = '/api/dsh-restart/settings'
    const DISMISS_URL = '/api/dsh-restart/dismiss'
    const REQUEST_TIMEOUT_MS = 10_000

    /** Seats this plugin can occupy; the Host answers with the same list. */
    const POSITIONS = ['sidebar-footer', 'session-header', 'composer-input', 'composer-dock', 'off']
    const POSITION_SET = new Set(POSITIONS)

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'action.label': '重启 DSH',
      'action.title': '重启 DSH（应用与 Host）',
      'dialog.title': '重启 DSH',
      // The scope note is an annotation beside the question, never a heading:
      // it renders at body weight in the tertiary label colour.
      'dialog.note': '（应用与 Host）',
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
      'prompt.title': '插件已更新，重启后生效',
      'prompt.note': '重启会关闭并重新拉起整个应用，本页随后自动重连。',
      'prompt.later': '稍后',
      'prompt.restart': '立即重启',
      'settings.title': '重启按钮位置',
      'settings.note': '改完立即生效，不需要重启。',
      'settings.prompt': '安装或更新插件后，在回复末尾提示重启',
      'settings.saved': '已保存',
      'settings.failed': '保存失败，请稍后重试。',
      'position.sidebar-footer': '侧栏页脚',
      'position.sidebar-footer.hint': '左下角、设置按钮旁（默认）',
      'position.session-header': '会话标题栏',
      'position.session-header.hint': '会话标题右侧的工具区',
      'position.composer-input': '输入框工具行',
      'position.composer-input.hint': '发送按钮左侧的紧凑控制区',
      'position.composer-dock': '输入框下方',
      'position.composer-dock.hint': '输入框卡片下方的环境条目区',
      'position.off': '不显示按钮',
      'position.off.hint': '只保留回复末尾的提示与本页设置',
    }

    /** English dictionary, same key set. */
    const en = {
      'action.label': 'Restart DSH',
      'action.title': 'Restart DSH (app and Host)',
      'dialog.title': 'Restart DSH',
      'dialog.note': '(app and Host)',
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
      'prompt.title': 'Plugins changed; restart to apply',
      'prompt.note': 'Restarting closes and relaunches the whole app; this page reconnects afterwards.',
      'prompt.later': 'Later',
      'prompt.restart': 'Restart now',
      'settings.title': 'Restart button position',
      'settings.note': 'Applies immediately; no restart needed.',
      'settings.prompt': 'After a plugin change, prompt at the end of the reply',
      'settings.saved': 'Saved',
      'settings.failed': 'Could not save; try again.',
      'position.sidebar-footer': 'Sidebar footer',
      'position.sidebar-footer.hint': 'Bottom left, beside Settings (default)',
      'position.session-header': 'Session header',
      'position.session-header.hint': 'Utilities at the right of the Session title',
      'position.composer-input': 'Composer toolbar',
      'position.composer-input.hint': 'Compact controls left of Send',
      'position.composer-dock': 'Below the composer',
      'position.composer-dock.hint': 'Ambient strip under the composer card',
      'position.off': 'No button',
      'position.off.hint': 'Keep only the end-of-reply prompt and this setting',
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
/* The confirmation is anchored to the trigger's own wrapper in every seat (no
   rect maths at all). Its width is per seat: the sidebar's content column comes
   from the frame's own variables, the header/composer seats get a fixed card
   because those rows have no width to inherit. */
.dshr-panel {
  position: absolute; z-index: 2147483000;
  box-sizing: border-box;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 96px);
  overflow: auto; padding: 12px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  box-shadow: 0 2px 10px rgb(0 0 0 / 12%); font-size: 13px; line-height: 1.5;
}
.dshr-panel:focus { outline: none; }
.dshr-anchor[data-seat="sidebar-footer"] .dshr-panel {
  position: absolute; left: 0; bottom: calc(100% + 6px);
  width: max(196px, calc(var(--dsh-windows-sidebar-width, 240px) - 2 * var(--dsh-sidebar-inline-padding, 12px)));
}
.dshr-anchor[data-seat="session-header"] .dshr-panel { right: 0; top: calc(100% + 8px); width: 280px; }
.dshr-anchor[data-seat="composer-input"] .dshr-panel,
.dshr-anchor[data-seat="composer-dock"] .dshr-panel { right: 0; bottom: calc(100% + 8px); width: 280px; }
.dshr-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin: 0 0 10px; }
.dshr-title { font-weight: 600; font-size: 13px; }
/* The scope note is an annotation, not a heading: body weight, smaller size and
   the tertiary label colour keep the question the only thing that reads as a
   title. */
.dshr-note { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
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
/* The end-of-Turn prompt borrows the shipped cards' language: one hairline
   border, the layer-1 fill, the large radius, a 28px glyph tile on layer-2, and
   a single text column. Nothing here is a document heading. */
.dshr-prompt {
  box-sizing: border-box; margin: 10px 0 2px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5;
}
.dshr-prompt-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dshr-prompt-icon {
  flex: none; width: 28px; height: 28px; display: grid; place-items: center;
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
}
.dshr-prompt-body { flex: 1 1 auto; min-width: 0; }
.dshr-prompt-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshr-prompt-note { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshr-prompt-actions { display: flex; flex: none; gap: 8px; }
/* Inside a reply, the primary action is the app's ordinary primary action, not
   the destructive tint the confirmation panel uses for itself. */
.dshr-prompt .dshr-action[data-primary="true"] { background: var(--dsw-alias-brand-primary); }
.dshr-settings {
  box-sizing: border-box; margin-top: 14px; padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5;
}
.dshr-settings-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.dshr-settings-title { font-weight: 600; font-size: 13px; }
.dshr-settings-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshr-options { display: flex; flex-direction: column; gap: 6px; }
.dshr-option {
  display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; cursor: pointer;
}
.dshr-option[data-active="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dshr-option input { margin: 2px 0 0; }
.dshr-option-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dshr-option-title { font-size: 12.5px; font-weight: 600; }
.dshr-option-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshr-switch { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12.5px; cursor: pointer; }
.dshr-hint { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
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

    /* ----------------------------------------------------------- state store */

    // One immutable snapshot shared by every mounted seat. A new object per
    // update is what makes `useState` re-render; mutating in place would leave
    // the other seats showing the previous seat.
    let snapshotValue = { position: 'sidebar-footer', prompt: true, pending: null, enabled: true, loaded: false, offline: false }
    const subscribers = new Set()

    /** The current snapshot (a new object after every change). */
    function getSnapshot() {
      return snapshotValue
    }

    /** Subscribe one component to the snapshot; returns the unsubscribe function. */
    function subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    }

    /** Replace part of the snapshot and notify every mounted seat. */
    function setSnapshot(patch) {
      snapshotValue = { ...snapshotValue, ...patch }
      for (const listener of subscribers) listener()
    }

    /**
     * Absorb one Host answer (`{ settings, pending, enabled }`).
     * Unknown seats fall back to the current one instead of unmounting the button.
     * @param value - the route's `value` object.
     */
    function absorb(value) {
      if (value === null || typeof value !== 'object') return
      const settings = value.settings !== null && typeof value.settings === 'object' ? value.settings : {}
      const position = typeof settings.position === 'string' && POSITION_SET.has(settings.position)
        ? settings.position
        : snapshotValue.position
      setSnapshot({
        position,
        prompt: settings.prompt !== false,
        pending: value.pending !== null && typeof value.pending === 'object' ? value.pending : null,
        enabled: value.enabled !== false,
        loaded: true,
        offline: false,
      })
    }

    // Four seats mount at once; they must share ONE state request, not race four.
    let inFlight = null

    // A Turn tail mounts once per completed Turn, so the prompt would otherwise
    // ask the Host once per Turn of the whole transcript. The marker it needs is
    // only interesting right after a change, so the reads are throttled.
    let lastStateAt = 0

    /**
     * Read the cheap Host state (settings + pending marker).
     * @returns {Promise<object|null>} the absorbed value.
     */
    function refreshState() {
      if (inFlight !== null) return inFlight
      inFlight = (async () => {
        lastStateAt = Date.now()
        const result = await postJson(STATE_URL, {})
        if (!result.ok) {
          setSnapshot({ offline: true })
          return null
        }
        if (result.response.ok === true && result.payload?.ok === true && result.payload.value !== undefined) {
          absorb(result.payload.value)
          return result.payload.value
        }
        setSnapshot({ offline: true })
        return null
      })().finally(() => {
        inFlight = null
      })
      return inFlight
    }

    /**
     * Refresh at most once per window; a burst of mounting Turns shares one read.
     * This is ALSO the retry path: an unreachable Host is not latched, so a Host
     * that comes back (an update applied elsewhere, a slow boot) recovers on the
     * next completed Turn instead of requiring a page reload.
     * @param {number} [windowMs] - minimum spacing.
     */
    function refreshStateThrottled(windowMs) {
      const spacing = typeof windowMs === 'number' ? windowMs : (snapshotValue.offline === true ? 5000 : 1500)
      if (Date.now() - lastStateAt < spacing) return Promise.resolve(null)
      return refreshState()
    }

    /** Subscribe one component to the shared snapshot. */
    function useUiState() {
      const [value, setValue] = React.useState(getSnapshot())
      React.useEffect(() => subscribe(() => setValue(getSnapshot())), [])
      return value
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

    /**
     * Whether a Plugins-page subject is this bundle (or one of its rows).
     * Mirrors how the shipped page addresses a subject: a row names its module,
     * a bundle names its package and the modules of its rows.
     * @param subject - the slot's `subject`.
     * @returns {boolean} true when this plugin's page is open.
     */
    function isOwnSubject(subject) {
      if (subject === null || typeof subject !== 'object') return false
      if (subject.kind === 'row') return subject.row?.moduleName === 'dsh-plugin-restart'
      if (subject.kind === 'bundle' || subject.kind === 'package') {
        if (subject.pkg?.name === 'dsh-plugin-restart') return true
        const rows = Array.isArray(subject.pkg?.rows) ? subject.pkg.rows : []
        return rows.some((row) => row?.moduleName === 'dsh-plugin-restart')
      }
      return false
    }

    /**
     * Pick the Turn a tail belongs to only when it is the timeline's LAST Turn.
     *
     * A tail renders once per completed Turn, so a global "pending" flag would
     * otherwise repaint the prompt in every historical reply. The shipped tail
     * view solves the same problem the same way — `snapshot.timeline.turnOrder`
     * compared with the node's Turn — and this entry receives `useChat` as a
     * standard prop, so the check needs no imports.
     * @param turn - the slot's TurnLocation.
     * @returns a selector over the Chat snapshot.
     */
    function latestTurnSelector(turn) {
      return (chat) => {
        const order = chat?.timeline?.turnOrder
        if (!Array.isArray(order) || order.length === 0) return true
        const last = order[order.length - 1]
        if (last === turn) return true
        const lastNumber = last?.turn
        const ownNumber = turn?.turn
        if (typeof lastNumber === 'number' && typeof ownNumber === 'number') return lastNumber === ownNumber
        // An unfamiliar snapshot shape must not silently remove the nudge.
        return true
      }
    }

    /** Fallback for a host that does not hand this entry `useChat` (tests, older shells). */
    function useAlwaysLatestTurn() {
      return true
    }

    /**
     * Ask the Host to arm a restart and classify the answer.
     * @returns {Promise<{kind: 'armed'|'notScheduled'|'timeout'|'hostGone'|'failed', reason?: string}>}
     */
    async function requestRestart() {
      const result = await postJson(RESTART_URL, {})
      if (!result.ok) return { kind: result.aborted ? 'timeout' : 'hostGone' }
      const value = result.payload?.value
      if (result.response.ok && result.payload?.ok === true && value?.scheduled === true) return { kind: 'armed' }
      if (result.response.ok && result.payload?.ok === true) return { kind: 'notScheduled' }
      return { kind: 'failed', reason: result.payload?.message ?? `HTTP ${String(result.response.status)}` }
    }

    /** Message for one classified restart outcome. */
    function noticeFor(t, outcome) {
      if (outcome.kind === 'notScheduled') return t('state.notScheduled')
      if (outcome.kind === 'timeout') return t('state.timeout')
      if (outcome.kind === 'hostGone') return t('state.hostGone')
      if (outcome.kind === 'failed') return t('state.failed', { reason: outcome.reason ?? '' })
      return ''
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
     * The trigger: an icon button in the configured seat plus the confirmation
     * panel it opens next to itself. Renders nothing in the seats that are not
     * configured — registering in every preset is what makes a preference change
     * instant instead of a re-register.
     * @param props - slot props, carrying `t` for the registered namespace and `seat`.
     */
    function RestartAction(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const seat = typeof props?.seat === 'string' ? props.seat : 'sidebar-footer'
      const ui = useUiState()
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [armed, setArmed] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      const panelId = `dsh-plugin-restart-panel-${seat}`

      // One shared request for all seats; the first mount starts it.
      React.useEffect(() => {
        if (ui.loaded || ui.offline) return undefined
        void refreshState()
        return undefined
      }, [ui.loaded, ui.offline])

      const loadStatus = React.useCallback(async () => {
        const result = await postJson(STATUS_URL, {})
        if (!result.ok) {
          setError(result.aborted ? t('state.timeout') : t('state.hostGone'))
          return
        }
        if (result.response.ok && result.payload?.ok === true) {
          const value = result.payload.value ?? null
          setStatus(value)
          if (value !== null && typeof value === 'object') absorb(value)
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
      // panel is not modal, so it must not swallow Escape from other surfaces.
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
      // report would have nowhere to render once the panel is gone.
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

      // Move focus into the panel when it opens, so its buttons are reachable
      // without a mouse.
      React.useEffect(() => {
        if (!open) return
        const node = panelRef.current
        if (node !== null) node.focus()
      }, [open])

      const confirmRestart = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        const outcome = await requestRestart()
        setBusy(false)
        if (outcome.kind === 'armed') {
          setArmed(true)
          return
        }
        // A dropped connection usually means the Host went down, but an abort is
        // not proof: report it and leave the button retryable.
        if (outcome.kind === 'failed') setError(t('state.failed', { reason: outcome.reason ?? '' }))
        else setNotice(noticeFor(t, outcome))
      }, [t])

      const openPanel = React.useCallback(() => {
        setOpen(true)
        setNotice(null)
        void loadStatus()
      }, [loadStatus])

      const panel = open
        ? h(
            'div',
            {
              className: 'dshr-panel',
              id: panelId,
              ref: panelRef,
              tabIndex: -1,
              role: 'dialog',
              // The accessible name keeps the scope the visible note carries, so
              // a screen reader hears the full question.
              'aria-label': t('action.title'),
            },
            // The question is the heading; the scope note sits beside it as a
            // muted annotation. Target/delay metadata, warnings and the previous
            // outcome are only shown when they carry information the user must
            // act on (a failure or a refused request).
            h(
              'p',
              { className: 'dshr-head' },
              h('span', { className: 'dshr-title' }, t('dialog.title')),
              h('span', { className: 'dshr-note' }, t('dialog.note')),
            ),
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
                        void confirmRestart()
                      },
                    },
                    busy ? t('action.busy') : error === null ? t('action.confirm') : t('action.retry'),
                  ),
              armed ? h('button', { type: 'button', className: 'dshr-action', disabled: true }, t('action.armed')) : null,
            ),
          )
        : null

      // Every hook above ran, so returning null here cannot change the hook count.
      if (ui.position !== seat) return null

      return h(
        'div',
        { className: 'dshr-anchor', 'data-seat': seat, 'data-dsh-restart-anchor': '' },
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: 'dshr-button',
            title: t('action.title'),
            'aria-label': t('action.title'),
            'aria-haspopup': 'dialog',
            'aria-controls': open ? panelId : undefined,
            'aria-expanded': open,
            'data-busy': busy ? 'true' : 'false',
            onClick: () => {
              if (open) close()
              else openPanel()
            },
          },
          h(RestartGlyph, null),
          // Icon only: every seat is a compact control row, so the button never
          // renders a text label — its name lives in the tooltip and the
          // accessible label.
        ),
        panel,
        armed ? h('div', { className: 'dshr-overlay', role: 'status' }, t('state.armed')) : null,
      )
    }

    /**
     * The end-of-Turn prompt.
     *
     * A Turn's tail renders once per completed Turn, so the prompt is scoped to
     * the timeline's LAST Turn: that keeps it out of the whole transcript's
     * history while putting it exactly where the reply ends. No rect maths, no
     * polling loop — one shared state read on mount (throttled across Turns).
     * @param props - slot props: the closing Turn, `seq`, and the standard props.
     */
    function RestartPrompt(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const ui = useUiState()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const turn = props?.turn
      const useChat = typeof props?.useChat === 'function' ? props.useChat : useAlwaysLatestTurn
      const isLatestTurn = useChat(latestTurnSelector(turn))

      React.useEffect(() => {
        void refreshStateThrottled()
        return undefined
      }, [])

      const pending = ui.pending
      const relevant = pending !== null
        && ui.prompt !== false
        && ui.enabled !== false
        && ui.offline !== true
        && isLatestTurn !== false

      const dismiss = async () => {
        setBusy(true)
        setNotice(null)
        const result = await postJson(DISMISS_URL, {})
        setBusy(false)
        if (result.ok && result.payload?.ok === true && result.payload.value !== undefined) {
          absorb(result.payload.value)
          return
        }
        setNotice(t('state.hostGone'))
      }

      const confirm = async () => {
        setBusy(true)
        setNotice(null)
        const outcome = await requestRestart()
        setBusy(false)
        if (outcome.kind === 'armed') {
          // The app is going away; drop the prompt instead of leaving a dead
          // "restart" button behind while the page reconnects.
          setSnapshot({ pending: null })
          return
        }
        setNotice(noticeFor(t, outcome))
      }

      if (!relevant) return null

      return h(
        'div',
        { className: 'dshr-prompt', role: 'group', 'aria-label': t('prompt.title'), 'data-dsh-restart-prompt': '' },
        h(
          'div',
          { className: 'dshr-prompt-main' },
          h('span', { className: 'dshr-prompt-icon' }, h(RestartGlyph, null)),
          h(
            'div',
            { className: 'dshr-prompt-body' },
            h('p', { className: 'dshr-prompt-title' }, t('prompt.title')),
            h('p', { className: 'dshr-prompt-note' }, t('prompt.note')),
          ),
          h(
            'div',
            { className: 'dshr-prompt-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-action',
                disabled: busy,
                onClick: () => {
                  void dismiss()
                },
              },
              t('prompt.later'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-action',
                'data-primary': 'true',
                disabled: busy,
                onClick: () => {
                  void confirm()
                },
              },
              busy ? t('action.busy') : t('prompt.restart'),
            ),
          ),
        ),
        notice !== null ? h('p', { className: 'dshr-error', role: 'alert' }, notice) : null,
      )
    }

    /**
     * The seat/prompt preferences on this plugin's own Plugins page.
     *
     * The shipped page gives every detail contribution the page's `subject`, and
     * its contract is that an entry draws nothing for a subject it has nothing
     * for — so this returns null on every other plugin's page.
     * @param props - slot props: the page's `subject`, `t`, and standard props.
     */
    function RestartSettings(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const ui = useUiState()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        if (ui.loaded || ui.offline) return undefined
        void refreshState()
        return undefined
      }, [ui.loaded, ui.offline])

      const save = async (patch) => {
        setBusy(true)
        setNotice(null)
        const result = await postJson(SETTINGS_URL, patch)
        setBusy(false)
        if (result.ok && result.payload?.ok === true && result.payload.value !== undefined) {
          absorb(result.payload.value)
          setNotice({ ok: true, text: t('settings.saved') })
          return
        }
        setNotice({ ok: false, text: t('settings.failed') })
      }

      if (!isOwnSubject(props?.subject)) return null

      return h(
        'div',
        { className: 'dshr-settings', 'data-dsh-restart-settings': '' },
        h(
          'div',
          { className: 'dshr-settings-head' },
          h('span', { className: 'dshr-settings-title' }, t('settings.title')),
          h('span', { className: 'dshr-settings-note' }, t('settings.note')),
        ),
        h(
          'div',
          { className: 'dshr-options', role: 'radiogroup', 'aria-label': t('settings.title') },
          POSITIONS.map((position) =>
            h(
              'label',
              {
                key: position,
                className: 'dshr-option',
                'data-active': ui.position === position ? 'true' : undefined,
              },
              h('input', {
                type: 'radio',
                name: 'dshr-position',
                value: position,
                checked: ui.position === position,
                disabled: busy,
                onChange: () => {
                  void save({ position })
                },
              }),
              h(
                'span',
                { className: 'dshr-option-body' },
                h('span', { className: 'dshr-option-title' }, t(`position.${position}`)),
                h('span', { className: 'dshr-option-hint' }, t(`position.${position}.hint`)),
              ),
            ),
          ),
        ),
        h(
          'label',
          { className: 'dshr-switch' },
          h('input', {
            type: 'checkbox',
            checked: ui.prompt !== false,
            disabled: busy,
            onChange: (event) => {
              void save({ prompt: event?.target?.checked !== false })
            },
          }),
          h('span', null, t('settings.prompt')),
        ),
        notice !== null
          ? h('p', { className: notice.ok ? 'dshr-hint' : 'dshr-error', role: notice.ok ? 'status' : 'alert' }, notice.text)
          : null,
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
        const t = ctx.locale.bind(NAMESPACE)

        /**
         * Register one seat and bind its disposer to this fiber, so an HMR
         * replacement leaves no stale occupant behind. Every entry declares this
         * package's locale so the slot hands the component `t`, and the trigger
         * also gets its seat name.
         */
        const registerSeat = (name, id, order, seat, Component) => {
          const dispose = ctx.slots.inject(name, () =>
            ctx.slots.register(
              {
                name,
                id,
                order,
                locale: NAMESPACE,
                inject: () => ({ t, ...(seat === undefined ? {} : { seat }) }),
              },
              Component,
            ),
          )
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, `dsh-plugin-restart: seat ${name}`)
          }
          return dispose
        }

        // The four trigger seats. Only the configured one renders; the others
        // are inert `null` occupants, so changing the seat never re-registers.
        registerSeat('sidebar.footer.action', 'dsh-restart', 10, 'sidebar-footer', RestartAction)
        registerSeat('conversation.session.header.utilities', 'dsh-restart', 60, 'session-header', RestartAction)
        registerSeat('conversation.input.right', 'dsh-restart', 60, 'composer-input', RestartAction)
        registerSeat('conversation.composer.dock', 'dsh-restart', 30, 'composer-dock', RestartAction)

        // The native end-of-Turn seat: content before a completed Turn's action
        // row, i.e. directly under the reply the user just got.
        registerSeat('conversation.chat.turnTail', 'dsh-restart-prompt', 20, undefined, RestartPrompt)

        // This bundle's own page inside the shipped Plugins screen. No `label`:
        // the section draws its own heading (a projected label would duplicate it).
        const disposeSettings = ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'dsh-restart-settings',
              order: 30,
              locale: NAMESPACE,
              inject: () => ({ t }),
            },
            RestartSettings,
          ),
        )
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => disposeSettings, 'dsh-plugin-restart: plugins settings section')
        }
      },
    }
  },
})
