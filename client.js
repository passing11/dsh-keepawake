window.__ModuleLoader__.load({
  id: 'dsh-keepawake',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-keepawake'
    /** This tab type's id: also the keyed-slot dispatch key for body and title. */
    const TAB_ID = 'dsh-keepawake'
    /** This tab type's kind, as passed to `sidebarRight.openTab`. */
    const TAB_KIND = 'dsh-keepawake'
    /** Host endpoint serving the switch state. */
    const API = '/dsh-keepawake/api'
    /** How often the panel re-reads the state while it is on screen. */
    const POLL_MS = 30000

    const zh = {
      'tab.title': '保活',
      'guide.title': '保活开关',
      'guide.description': '开启后，DSH 思考、调工具、跟模型对话期间电脑不睡眠、不休眠',
      'panel.heading': 'DSH 保活',
      'panel.on': '已开启',
      'panel.off': '已关闭',
      'panel.unknown': '读取中…',
      'panel.onHint': '我思考、调工具、跟模型对话的期间，电脑不会自动睡眠或休眠。屏幕照常按你的计划关闭。',
      'panel.offHint': '电脑按原来的计划睡眠 / 休眠。',
      'panel.turnOn': '开启保活',
      'panel.turnOff': '关闭保活',
      'panel.busy': '切换中…',
      'panel.reason': '最近一次持锁原因',
      'panel.reasonNone': '还没有持锁记录',
      'panel.released': '最近一次放开',
      'panel.log': '最近的看门狗记录',
      'panel.refresh': '刷新',
      'panel.missing': '找不到 keepawake-toggle.ps1',
      'panel.missingHint': '把脚本放到工作区根目录，或在插件配置里指定 scriptPath。',
      'panel.unsupported': '保活开关只在 Windows 上可用',
      'panel.error': '读取状态失败',
    }

    const en = {
      'tab.title': 'Keep awake',
      'guide.title': 'Keep-awake switch',
      'guide.description':
        'Stops the PC from sleeping or hibernating while DSH thinks, calls tools and talks to the model',
      'panel.heading': 'DSH keep-awake',
      'panel.on': 'On',
      'panel.off': 'Off',
      'panel.unknown': 'Reading…',
      'panel.onHint':
        'While I think, call tools and talk to the model, the PC will not sleep or hibernate. The display still follows your power plan.',
      'panel.offHint': 'The PC follows its usual sleep / hibernate plan.',
      'panel.turnOn': 'Turn on',
      'panel.turnOff': 'Turn off',
      'panel.busy': 'Switching…',
      'panel.reason': 'Most recent lock',
      'panel.reasonNone': 'No lock has been held yet',
      'panel.released': 'Most recent release',
      'panel.log': 'Recent watchdog records',
      'panel.refresh': 'Refresh',
      'panel.missing': 'keepawake-toggle.ps1 was not found',
      'panel.missingHint': 'Place the script in the workspace root, or set scriptPath in the plugin config.',
      'panel.unsupported': 'The keep-awake switch is Windows only',
      'panel.error': 'Could not read the state',
    }

    /** Inline styles: the panel must never depend on another plugin's CSS. */
    const CSS = `
.dsh-keepawake-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-keepawake-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-keepawake-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-keepawake-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  white-space: nowrap;
}
.dsh-keepawake-pill[data-on='true'] {
  color: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-keepawake-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-quaternary);
  flex: none;
}
.dsh-keepawake-pill[data-on='true'] .dsh-keepawake-dot,
.dsh-keepawake-dot[data-on='true'] {
  background: var(--dsw-alias-state-business-primary);
}
.dsh-keepawake-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dsh-keepawake-toggle:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-keepawake-toggle:disabled {
  cursor: default;
  opacity: 0.7;
}
.dsh-keepawake-toggle[data-on='true'] {
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-keepawake-switch {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  flex: none;
  transition: background 0.15s ease;
}
.dsh-keepawake-toggle[data-on='true'] .dsh-keepawake-switch {
  background: var(--dsw-alias-state-business-primary);
}
.dsh-keepawake-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 0.15s ease;
}
.dsh-keepawake-toggle[data-on='true'] .dsh-keepawake-knob {
  transform: translateX(16px);
}
.dsh-keepawake-toggleText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-keepawake-toggleLabel {
  font-size: 13px;
  font-weight: 600;
}
.dsh-keepawake-toggleHint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-keepawake-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-keepawake-label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-keepawake-value {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}
.dsh-keepawake-log {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}
.dsh-keepawake-error {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  word-break: break-word;
}
.dsh-keepawake-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-keepawake-refresh {
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-keepawake-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-keepawake-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}
.dsh-keepawake-mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: currentColor;
}
.dsh-keepawake-markText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

    /**
     * Decorative padlock mark, inline so the tab carries no icon dependency.
     * @param {object} props - `{ size, className }`.
     * @returns {object} the glyph element.
     */
    function KeepAwakeGlyph(props) {
      const size = (props && Number(props.size)) || 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: (props && props.className) || undefined,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 3.2, y: 7.1, width: 9.6, height: 6.6, rx: 1.6 }),
        h('path', { d: 'M5.6 7.1V5.4a2.4 2.4 0 0 1 4.8 0v1.7' }),
        h('path', { d: 'M8 9.6v1.6' }),
      )
    }

    /** Latest state, shared by the body and the tab title. */
    function createStatusStore() {
      let snapshot = null
      const listeners = new Set()
      const notify = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        get: () => snapshot,
        set(next) {
          snapshot = next
          notify()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * Subscribe a component to the shared store.
     * @param {object} store - status store.
     * @returns {object | null} current snapshot.
     */
    function useStatus(store) {
      const [value, setValue] = React.useState(store.get())
      React.useEffect(() => {
        setValue(store.get())
        return store.subscribe(() => setValue(store.get()))
      }, [store])
      return value
    }

    /**
     * Read the state from the host endpoint.
     * @param {string} method - HTTP method.
     * @param {object} [body] - JSON body for POST.
     * @returns {Promise<object>} parsed payload.
     */
    async function callApi(method, body) {
      const init = { method, cache: 'no-store', headers: { Accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(API, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        return { ok: false, error: `HTTP ${response.status}` }
      }
      return payload
    }

    /**
     * Build one panel instance.
     * @param {object} props - `{ copy, store }`.
     * @returns {object} the panel element.
     */
    function KeepAwakePanel(props) {
      const { copy, store } = props
      const state = useStatus(store)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const next = await callApi('GET')
          if (!alive.current) return
          store.set(next)
          setFailure(next && next.ok === false ? String(next.error || '') : '')
        } catch (error) {
          if (!alive.current) return
          setFailure(String((error && error.message) || error))
        }
      }, [store])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const toggle = async () => {
        const current = store.get()
        const next = !(current && current.enabled === true)
        setBusy(true)
        try {
          const result = await callApi('POST', { action: next ? 'on' : 'off' })
          if (!alive.current) return
          store.set(result)
          setFailure(result && result.ok === false ? String(result.error || '') : '')
        } catch (error) {
          if (!alive.current) return
          setFailure(String((error && error.message) || error))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const on = state !== null && state.enabled === true
      const known = state !== null && state.known === true
      const unsupported = state !== null && typeof state.platform === 'string' && state.platform !== 'win32'
      const missing = state !== null && state.scriptFound === false
      // Anything other than a definite answer reads as "not known yet": the pill
      // must not claim "off" when the host could not tell what the switch is doing.
      const statusLabel = known ? (on ? copy('panel.on') : copy('panel.off')) : copy('panel.unknown')

      const reason = state && typeof state.reason === 'string' && state.reason.length > 0 ? state.reason : ''
      const reasonAt = state && typeof state.reasonAt === 'string' ? state.reasonAt : ''
      const releasedAt = state && typeof state.releasedAt === 'string' ? state.releasedAt : ''
      const logTail = state && Array.isArray(state.logTail) ? state.logTail : []

      const children = [
        h(
          'div',
          { className: 'dsh-keepawake-head', key: 'head' },
          h('span', { className: 'dsh-keepawake-title' }, copy('panel.heading')),
          h(
            'span',
            { className: 'dsh-keepawake-pill', 'data-on': on ? 'true' : 'false' },
            h('span', { className: 'dsh-keepawake-dot' }),
            statusLabel,
          ),
        ),
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            className: 'dsh-keepawake-toggle',
            'data-on': on ? 'true' : 'false',
            disabled: busy || unsupported,
            onClick: toggle,
            title: on ? copy('panel.turnOff') : copy('panel.turnOn'),
          },
          h('span', { className: 'dsh-keepawake-switch' }, h('span', { className: 'dsh-keepawake-knob' })),
          h(
            'span',
            { className: 'dsh-keepawake-toggleText' },
            h('span', { className: 'dsh-keepawake-toggleLabel' }, busy ? copy('panel.busy') : on ? copy('panel.turnOff') : copy('panel.turnOn')),
            h('span', { className: 'dsh-keepawake-toggleHint' }, on ? copy('panel.onHint') : copy('panel.offHint')),
          ),
        ),
      ]

      if (unsupported) {
        children.push(
          h('div', { className: 'dsh-keepawake-error', key: 'unsupported' }, copy('panel.unsupported')),
        )
      } else if (missing) {
        children.push(
          h(
            'div',
            { className: 'dsh-keepawake-error', key: 'missing' },
            copy('panel.missing'),
            h('div', { className: 'dsh-keepawake-value' }, copy('panel.missingHint')),
          ),
        )
      } else if (failure.length > 0) {
        children.push(h('div', { className: 'dsh-keepawake-error', key: 'failure' }, failure))
      }

      children.push(
        h(
          'div',
          { className: 'dsh-keepawake-section', key: 'reason' },
          h('span', { className: 'dsh-keepawake-label' }, copy('panel.reason')),
          h(
            'span',
            { className: 'dsh-keepawake-value' },
            reason.length > 0 ? (reasonAt.length > 0 ? `${reasonAt}　${reason}` : reason) : copy('panel.reasonNone'),
          ),
          releasedAt.length > 0
            ? h('span', { className: 'dsh-keepawake-value' }, `${copy('panel.released')}：${releasedAt}`)
            : null,
        ),
      )

      if (logTail.length > 0) {
        children.push(
          h(
            'div',
            { className: 'dsh-keepawake-section', key: 'log' },
            h('span', { className: 'dsh-keepawake-label' }, copy('panel.log')),
            h('pre', { className: 'dsh-keepawake-log' }, logTail.join('\n')),
          ),
        )
      }

      children.push(
        h(
          'div',
          { className: 'dsh-keepawake-actions', key: 'actions' },
          h(
            'button',
            {
              className: 'dsh-keepawake-refresh',
              type: 'button',
              disabled: busy,
              onClick: () => {
                refresh()
              },
            },
            copy('panel.refresh'),
          ),
          // Only complain once a real answer came back unreadable; while the
          // first read is still in flight the pill already says "读取中…".
          state !== null && known === false && !unsupported && !missing && failure.length === 0
            ? h('span', { className: 'dsh-keepawake-value' }, copy('panel.error'))
            : null,
        ),
      )

      return h('div', { className: 'dsh-keepawake-panel' }, children)
    }

    /**
     * The chip drawn inside the right-sidebar tab strip.
     *
     * It reads the shared store only: the panel owns the polling, so a closed
     * panel costs nothing, and the chip simply shows no dot until the first
     * answer arrives.
     * @param {object} props - `{ copy, store }`.
     * @returns {object} the chip element.
     */
    function KeepAwakeTabTitle(props) {
      const { copy, store } = props
      const state = useStatus(store)
      const known = state !== null && state.known === true
      const on = known && state.enabled === true
      return h(
        'span',
        { className: 'dsh-keepawake-mark' },
        h(KeepAwakeGlyph, { size: 14 }),
        h('span', { className: 'dsh-keepawake-markText' }, copy('tab.title')),
        known ? h('span', { className: 'dsh-keepawake-dot', 'data-on': on ? 'true' : 'false' }) : null,
      )
    }

    /** Services this plugin needs from the client runtime. */
    const inject = ['slots', 'locale', 'sidebarRightTabs']

    /**
     * Register the tab type, its two keyed surfaces and the shared store.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      const store = createStatusStore()
      const settle = (register) => {
        try {
          const dispose = register()
          return typeof dispose === 'function' ? dispose : () => {}
        } catch {
          return () => {}
        }
      }

      ctx.effect(
        () =>
          settle(() => {
            const style = document.createElement('style')
            style.setAttribute('data-dsh-keepawake', '')
            style.textContent = CSS
            document.head.appendChild(style)
            return () => {
              try {
                style.remove()
              } catch {
                /* head already gone */
              }
            }
          }),
        'dsh-keepawake: styles',
      )

      ctx.effect(
        () =>
          settle(() =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          ),
        'dsh-keepawake: dictionaries',
      )

      let translate
      try {
        translate = ctx.locale.bind(NS)
      } catch {
        translate = undefined
      }
      const copy = (key) => translate?.(key) ?? zh[key]

      ctx.effect(
        () =>
          settle(() =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              priority: 'extension',
              title: () => copy('tab.title'),
              guide: [
                {
                  id: 'open',
                  order: 40,
                  title: () => copy('guide.title'),
                  description: () => copy('guide.description'),
                  icon: KeepAwakeGlyph,
                },
              ],
            }),
          ),
        'dsh-keepawake: tab type',
      )

      ctx.slots.inject('sidebar.right.pane.tab', () => {
        try {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
              inject: (sessionId) => ({ sessionId, copy, store }),
            },
            KeepAwakePanel,
          )
        } catch {
          return () => {}
        }
      })

      ctx.slots.inject('sidebar.right.pane.tab.title', () => {
        try {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID,
              locale: NS,
              inject: (sessionId) => ({ sessionId, copy, store }),
            },
            KeepAwakeTabTitle,
          )
        } catch {
          return () => {}
        }
      })

      // Open the panel once per conversation, and only while the user has not
      // closed it there: the tab strip is the user's own layout.
      const settled = new Set()
      ctx.effect(
        () =>
          settle(() => {
            const right = () => {
              try {
                return ctx.get?.('sidebarRight')
              } catch {
                return undefined
              }
            }
            const alreadyOpen = (control, sessionId) => {
              try {
                const rows = control.openTabs?.getSnapshot?.()
                if (!Array.isArray(rows)) return false
                return rows.some((row) => row && row.sessionId === sessionId && row.kind === TAB_KIND)
              } catch {
                return false
              }
            }
            const react = () => {
              const control = right()
              if (!control || typeof control.openTab !== 'function') return
              let sessionId
              try {
                sessionId = control.mounted?.getSnapshot?.()
              } catch {
                return
              }
              if (typeof sessionId !== 'string' || sessionId.length === 0) return
              if (settled.has(sessionId)) return
              settled.add(sessionId)
              if (alreadyOpen(control, sessionId)) return
              try {
                control.openTab(TAB_KIND)
              } catch {
                /* the host may refuse while the strip is still mounting */
              }
            }
            let unsubscribe = () => {}
            const control = right()
            if (control && control.mounted && typeof control.mounted.subscribe === 'function') {
              try {
                unsubscribe = control.mounted.subscribe(react) || (() => {})
              } catch {
                unsubscribe = () => {}
              }
            }
            react()
            return () => {
              try {
                unsubscribe()
              } catch {
                /* already detached */
              }
            }
          }),
        'dsh-keepawake: open once',
      )

      // Unloading closes only this plugin's own tabs, never the user's others.
      ctx.effect(
        () => () => {
          let control
          try {
            control = ctx.get?.('sidebarRight')
          } catch {
            control = undefined
          }
          if (!control) return
          let rows = []
          try {
            rows = control.openTabs?.getSnapshot?.() || []
          } catch {
            rows = []
          }
          for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || row.kind !== TAB_KIND) continue
            try {
              control.closeIn?.(row.sessionId, row.tabId)
            } catch {
              /* the host may have dropped the tab already */
            }
          }
        },
        'dsh-keepawake: teardown',
      )
    }

    return { inject, apply }
  },
})
