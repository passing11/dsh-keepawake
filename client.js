window.__ModuleLoader__.load({
  id: 'dsh-keepawake',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-keepawake'
    /** Host endpoint serving the switch state. */
    const API = '/dsh-keepawake/api'
    /** How often the chip re-reads the state while it is on screen. */
    const POLL_MS = 30000

    const zh = {
      'guide.title': '保活开关',
      'panel.on': '保活中',
      'panel.off': '保活',
      'panel.onHint': '我思考、调工具、跟模型对话的期间，电脑不会自动睡眠或休眠。屏幕照常按你的计划关闭。',
      'panel.offHint': '电脑按原来的计划睡眠 / 休眠。',
      'panel.turnOn': '开启保活',
      'panel.turnOff': '关闭保活',
      'panel.busy': '切换中…',
      'panel.missing': '找不到 keepawake-toggle.ps1',
      'panel.missingHint': '把脚本放到工作区根目录，或在插件配置里指定 scriptPath。',
    }

    const en = {
      'guide.title': 'Keep-awake switch',
      'panel.on': 'Awake',
      'panel.off': 'Keep awake',
      'panel.onHint':
        'While I think, call tools and talk to the model, the PC will not sleep or hibernate. The display still follows your power plan.',
      'panel.offHint': 'The PC follows its usual sleep / hibernate plan.',
      'panel.turnOn': 'Turn on',
      'panel.turnOff': 'Turn off',
      'panel.busy': 'Switching…',
      'panel.missing': 'keepawake-toggle.ps1 was not found',
      'panel.missingHint': 'Place the script in the workspace root, or set scriptPath in the plugin config.',
    }

    /** Inline styles: the chip must never depend on another plugin's CSS. */
    const CSS = `
.dsh-keepawake-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.dsh-keepawake-chip:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-keepawake-chip[data-on='true'] {
  color: var(--dsw-alias-state-business-primary);
}
.dsh-keepawake-chip:disabled {
  cursor: default;
  opacity: 0.55;
}
.dsh-keepawake-chip svg {
  flex: none;
  width: 14px;
  height: 14px;
}
.dsh-keepawake-chipLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.dsh-keepawake-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-quaternary);
  flex: none;
}
.dsh-keepawake-dot[data-on='true'] {
  background: var(--dsw-alias-state-business-primary);
}
`

    /**
     * Decorative padlock mark, inline so the chip carries no icon dependency.
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
     * The switch: a compact chip in the composer dock, directly below the input
     * box, next to the shipped statistics pills.
     * @param {object} props - `{ copy }`.
     * @returns {object | null} the chip element.
     */
    function KeepAwakeChip(props) {
      const { copy } = props
      const [state, setState] = React.useState(null)
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
          setState(next)
          setFailure(next && next.ok === false ? String(next.error || '') : '')
        } catch (error) {
          if (!alive.current) return
          setFailure(String((error && error.message) || error))
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const toggle = async () => {
        const next = !(state && state.enabled === true)
        setBusy(true)
        try {
          const result = await callApi('POST', { action: next ? 'on' : 'off' })
          if (!alive.current) return
          setState(result)
          setFailure(result && result.ok === false ? String(result.error || '') : '')
        } catch (error) {
          if (!alive.current) return
          setFailure(String((error && error.message) || error))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const on = state !== null && state.enabled === true
      const unsupported = state !== null && typeof state.platform === 'string' && state.platform !== 'win32'
      const missing = state !== null && state.scriptFound === false
      // The dock is shared with the shipped statistics pills: where the switch
      // cannot work, stay out of the row entirely instead of drawing a dead one.
      if (unsupported) return null

      const label = busy ? copy('panel.busy') : on ? copy('panel.on') : copy('panel.off')
      const title =
        failure.length > 0
          ? failure
          : missing
            ? `${copy('panel.missing')}\n${copy('panel.missingHint')}`
            : on
              ? `${copy('panel.onHint')}\n\n${copy('panel.turnOff')}`
              : `${copy('panel.offHint')}\n\n${copy('panel.turnOn')}`

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-keepawake-chip',
          'data-on': on ? 'true' : 'false',
          'data-composer-stat': 'keepawake',
          'aria-pressed': on,
          'aria-label': `${copy('guide.title')}：${label}`,
          disabled: busy,
          onClick: toggle,
          title,
        },
        h(KeepAwakeGlyph, { size: 14 }),
        h('span', { className: 'dsh-keepawake-chipLabel' }, label),
        state !== null ? h('span', { className: 'dsh-keepawake-dot', 'data-on': on ? 'true' : 'false' }) : null,
      )
    }

    /** Services this plugin needs from the client runtime. */
    const inject = ['slots', 'locale']

    /**
     * Register the dock entry that draws the switch below the input box.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
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

      // `conversation.composer.dock` is the row of small controls directly under
      // the input box. A fresh id adds one beside the shipped statistics pills.
      ctx.slots.inject('conversation.composer.dock', () => {
        try {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'keepawake',
              order: 5,
              locale: NS,
              inject: () => ({ copy }),
            },
            KeepAwakeChip,
          )
        } catch {
          return () => {}
        }
      })
    }

    return { inject, apply }
  },
})
