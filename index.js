/**
 * DSH 保活开关 — Host half.
 *
 * Serves one JSON endpoint that the composer chip talks to:
 *   GET  /dsh-keepawake/api  -> read the live state
 *   POST /dsh-keepawake/api  -> { action: 'on' | 'off' | 'refresh' }
 *
 * The switch itself is the existing local script `keepawake-toggle.ps1`, invoked
 * with `-Action On|Off|Status -Quiet` so it prints instead of opening a dialog.
 * Nothing here starts, stops or measures anything on its own: the watchdog that
 * script launches is the only actor that holds the system awake.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** Endpoint the panel fetches. */
const ROUTE_PATH = '/dsh-keepawake/api'
/** The user's switch script. */
const SCRIPT_NAME = 'keepawake-toggle.ps1'
/** Log the watchdog appends to (same path the script hard-codes). */
const LOG_NAME = 'dsh-keepawake.log'
/** How long a single PowerShell call may take. */
const CALL_TIMEOUT_MS = 20000
/** Independent settings file — never the UI state file (collectState rewrites that one). */
const CONFIG_NAME = '.dsh-keepawake-config.json'
/** Marker file the watchdog reads; the ps1 hard-codes the same absolute path. */
const WAITING_NAME = 'dsh-keepawake-waiting.json'
/** How often the host republishes the "waiting for the user" flag. */
const WAITING_TICK_MS = 10000
/**
 * Generation tag of the marker payload. Bumped whenever the fields change so a
 * stale writer is identifiable from the file alone. The watchdog never gates on
 * it — a hand-written marker must still be honoured.
 */
const WAITING_VERSION = 2

/** DSH home, matching the host's own convention. */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Where this plugin remembers the last known switch state. */
function stateFile() {
  return path.join(dshHome(), '.dsh-keepawake-ui.json')
}

/** Watchdog log path (`$env:TEMP\dsh-keepawake.log`). */
function logFile() {
  return path.join(os.tmpdir(), LOG_NAME)
}

/** Absolute path of the independent settings file. */
function configFile() {
  return path.join(dshHome(), CONFIG_NAME)
}

/** Marker path — `%USERPROFILE%\.dsh\dsh-keepawake-waiting.json` on the ps1 side. */
function waitingFile() {
  return path.join(dshHome(), WAITING_NAME)
}

/**
 * Read the preference; missing or malformed reads as false.
 * @returns {{keepAwakeWhileWaiting: boolean}} the stored preference.
 */
function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return { keepAwakeWhileWaiting: parsed.keepAwakeWhileWaiting === true }
    }
  } catch {
    /* first run, or the file was removed */
  }
  return { keepAwakeWhileWaiting: false }
}

/**
 * Persist the preference in its own file; throws so the route can report a real failure.
 * @param {{keepAwakeWhileWaiting: boolean}} next - preference to store.
 */
function writeConfig(next) {
  const file = configFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ keepAwakeWhileWaiting: next.keepAwakeWhileWaiting === true }, null, 2), 'utf8')
}

/**
 * Publish the host's own opinion about the lock for the watchdog (best effort).
 *
 * `busy` is the authoritative signal: the host alone can see the pending
 * question/approval counters and the agent's turn phase. The watchdog reads
 * this file, trusts `busy` while the file is fresh, and stops holding the lock
 * when the file goes stale — so nothing here may throw.
 *
 * `pending`, `running` and `sawAgent` are diagnostics: `running` is the size of
 * the event-driven set while `busy` used `runningCount()`, so "running:0 but
 * busy:true" means the two views disagree and is worth investigating.
 * @param {{waiting: boolean, busy: boolean, pending: number, running: number, sawAgent: boolean}} state - snapshot.
 */
function writeWaiting(state) {
  try {
    const file = waitingFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = {
      version: WAITING_VERSION,
      waiting: state && state.waiting === true,
      busy: state && state.busy === true,
      pending: state && Number.isFinite(state.pending) ? state.pending : 0,
      running: state && Number.isFinite(state.running) ? state.running : 0,
      sawAgent: state && state.sawAgent === true,
      at: new Date().toISOString(),
      pid: process.pid,
    }
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
  } catch {
    /* a read-only home must not break the turn */
  }
}

/**
 * Read the persisted record. Missing or malformed files read as an empty record;
 * the panel treats that as "nothing known yet".
 * @returns {Record<string, unknown>} the stored record.
 */
function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* first run, or the file was removed */
  }
  return {}
}

/**
 * Write the persisted record, best effort: a read-only home must not break the
 * panel, which still shows the live state.
 * @param {Record<string, unknown>} next - record to store.
 */
function writePersisted(next) {
  try {
    const file = stateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* persistence is a convenience, not a requirement */
  }
}

/**
 * Candidate locations for the switch script, most specific first.
 * @param {object} ctx - host context (used only for the workspace root).
 * @param {object} config - plugin config, may carry `scriptPath`.
 * @returns {string[]} absolute candidate paths.
 */
function scriptCandidates(ctx, config) {
  const list = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !list.includes(value)) list.push(value)
  }
  if (config && typeof config.scriptPath === 'string') push(config.scriptPath)
  push(process.env.DSH_KEEPAWAKE_SCRIPT)

  const roots = []
  try {
    const policy = ctx.get?.('sandboxPolicy')
    if (policy && typeof policy.workspaceRoot === 'string') roots.push(policy.workspaceRoot)
  } catch {
    /* service absent: fall through to the other roots */
  }
  roots.push(process.cwd())
  roots.push(path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace'))
  roots.push(dshHome())
  for (const root of roots) push(path.join(root, SCRIPT_NAME))
  return list
}

/**
 * Resolve the switch script that actually exists.
 * @param {object} ctx - host context.
 * @param {object} config - plugin config.
 * @returns {string | null} the script path, or null when none of the candidates exist.
 */
function findScript(ctx, config) {
  for (const candidate of scriptCandidates(ctx, config)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Run the switch script once and collect its stdout.
 *
 * `-Quiet` makes the script print through `Write-Output`; the console encoding is
 * pinned to UTF-8 first, otherwise a Chinese Windows console hands back OEM bytes.
 * @param {string} scriptPath - absolute path of `keepawake-toggle.ps1`.
 * @param {'On' | 'Off' | 'Status' | 'Restart'} action - script action.
 * @param {number} timeoutMs - hard timeout for the child process.
 * @returns {Promise<{ok: boolean, text: string, error: string}>} the outcome.
 */
function runSwitch(scriptPath, action, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const quoted = scriptPath.replace(/'/g, "''")
    const waitFlag = readConfig().keepAwakeWhileWaiting ? ' -WaitKeepAwake' : ''
    const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${quoted}' -Action ${action} -Quiet${waitFlag}`
    let settled = false
    let stdout = ''
    let stderr = ''
    let child

    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({ ok: false, text: '', error: String((error && error.message) || error) })
      return
    }

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, text: stdout.trim(), error: '调用 PowerShell 超时' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ ok: false, text: stdout.trim(), error: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, text: stdout.trim(), error: stderr.trim() })
    })
  })
}

/**
 * Interpret the script's Status output.
 * @param {string} text - stdout of `-Action Status -Quiet`.
 * @returns {{known: boolean, enabled: boolean, pids: string[]}} parsed state.
 */
function parseStatus(text) {
  const enabled = text.includes('保活：开启')
  const disabled = text.includes('保活：关闭')
  const match = text.match(/保活：开启（PID ([^）]*)）/)
  const pids = match
    ? match[1]
        .split(/[,，\s]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : []
  return { known: enabled || disabled, enabled, pids }
}

/**
 * Scan the watchdog log for the most recent lock and release records.
 * @returns {{logFile: string, logTail: string[], reason: string | null, reasonAt: string | null, releasedAt: string | null}} log facts.
 */
function readLogInfo() {
  const file = logFile()
  const info = { logFile: file, logTail: [], reason: null, reasonAt: null, releasedAt: null }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return info
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  info.logTail = lines.slice(-3)
  for (const line of lines) {
    const locked = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+DSH 忙 -> 持锁\s*\[(.*)\]\s*$/)
    if (locked) {
      info.reason = locked[2]
      info.reasonAt = locked[1]
      continue
    }
    // Two releases count: the idle timer (historically), the immediate one when
    // the turn comes back to the user ("轮到用户 -> 立刻放锁"), and the stale
    // marker path ("标记文件过期… -> 放锁") where the plugin stopped vouching.
    const released = line.match(
      /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(?:空闲 .*释放锁|轮到用户.*(?:放锁|释放锁)|标记文件.*放锁|宿主报告空闲.*放锁)/,
    )
    if (released) info.releasedAt = released[1]
  }
  return info
}

/**
 * Build the payload the panel renders.
 * @param {object} ctx - host context.
 * @param {object} config - plugin config.
 * @returns {Promise<Record<string, unknown>>} the state payload.
 */
async function collectState(ctx, config) {
  const log = readLogInfo()
  const persisted = readPersisted()
  const script = findScript(ctx, config)
  const payload = {
    ok: true,
    config: readConfig(),
    platform: process.platform,
    scriptPath: script,
    scriptFound: script !== null,
    logFile: log.logFile,
    logTail: log.logTail,
    reason: log.reason ?? (typeof persisted.reason === 'string' ? persisted.reason : null),
    reasonAt: log.reasonAt ?? (typeof persisted.reasonAt === 'string' ? persisted.reasonAt : null),
    releasedAt: log.releasedAt ?? null,
    statusText: '',
    enabled: false,
    known: false,
    pids: [],
    error: '',
    updatedAt: new Date().toISOString(),
  }

  if (process.platform !== 'win32') {
    payload.ok = false
    payload.error = '保活开关只在 Windows 上可用'
    return payload
  }
  if (script === null) {
    payload.ok = false
    payload.error = `找不到 ${SCRIPT_NAME}`
    return payload
  }

  const result = await runSwitch(script, 'Status')
  payload.statusText = result.text
  if (!result.ok && result.text.length === 0) {
    payload.ok = false
    payload.error = result.error || '读取状态失败'
    return payload
  }

  const parsed = parseStatus(result.text)
  payload.known = parsed.known
  payload.enabled = parsed.enabled
  payload.pids = parsed.pids
  if (!parsed.known) {
    payload.ok = false
    payload.error = result.error || '无法识别开关状态'
    return payload
  }

  const record = {
    enabled: payload.enabled,
    pids: payload.pids,
    reason: payload.reason,
    reasonAt: payload.reasonAt,
    updatedAt: payload.updatedAt,
  }
  const unchanged =
    persisted.enabled === record.enabled &&
    persisted.reason === record.reason &&
    persisted.reasonAt === record.reasonAt
  if (!unchanged) writePersisted(record)
  payload.persisted = record
  return payload
}

/**
 * Read a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<string>} the body text ('' on refusal or failure).
 */
function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let settled = false
    let size = 0
    const chunks = []
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
  })
}

/**
 * Build the trust gate for this route.
 *
 * Mirrors the host convention: hand the decision to `connection.requestRejection`
 * when that service is present, and fail closed if it throws. Without the service
 * (a plain local web profile) only same-origin requests are accepted.
 * @param {object} ctx - host context.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean} true when rejected.
 */
function makeFence(ctx) {
  const deny = (res, code = 403) => {
    try {
      res.statusCode = code
      res.end()
    } catch {
      /* response already gone */
    }
    return true
  }

  return (req, res) => {
    let connection
    try {
      connection = ctx.get?.('connection')
    } catch {
      connection = undefined
    }

    if (connection && typeof connection.requestRejection === 'function') {
      let code
      try {
        code = connection.requestRejection(req)
      } catch {
        return deny(res, 403)
      }
      if (code === undefined || code === null || code === false) return false
      return deny(res, typeof code === 'number' ? code : 403)
    }

    // No host fence available: refuse cross-origin writes outright.
    const origin = req.headers && req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        return deny(res, 403)
      }
      const host = String((req.headers && req.headers.host) || '')
      if (host.length > 0 && originHost !== host) return deny(res, 403)
    }
    return false
  }
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - serialisable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* client disconnected */
  }
}

/**
 * Track "it is the user's turn" and publish it for the watchdog.
 *
 * Three facts, all checked against app.asar:
 *  - `user-questions/request` and `approval/request` are `mode:'waterfall'`
 *    events dispatched through the agent's scope carrier. A listener registered
 *    with `{ global: true }` bypasses that scope filter (cordis `_resolve`
 *    keeps `hook.global` unconditionally), so wrapping the answer gives an exact
 *    `pending > 0` for "the agent is blocked on the user right now".
 *  - `agent/status` is `mode:'emit'` and fires only on a transition — there is
 *    no initial snapshot — but its payload is fused with the live `agent`
 *    (`agentEvents` -> `fused = (payload) => ({ ...payload, agent })`).
 *  - `ctx.get('agents')` is strict: it answers `undefined` unless this fiber
 *    actually injected the service, so the running set is tracked from events
 *    and only reconciled against `agents.roots()` once injection succeeds.
 *
 * waiting = pending > 0 || knownRunning === 0.
 * While the running set is still unknowable, "not waiting" wins: a stuck
 * `waiting: true` silently disables the whole keep-awake switch, whereas a late
 * first transition only postpones one idle detection.
 * @param {object} ctx - host context.
 * @returns {{dispose: () => void, attach: (agents: object) => void, detach: () => void}} tracker.
 */
function createWaitingTracker(ctx) {
  let pending = 0
  let agentsService = null
  let sawAgentEvent = false
  const running = new Set()
  const offs = []
  let disposed = false

  const rootsOf = () => {
    if (agentsService === null) return null
    try {
      const roots = agentsService.roots()
      return Array.isArray(roots) ? roots : null
    } catch {
      return null
    }
  }

  const runningCount = () => {
    const roots = rootsOf()
    if (roots !== null) {
      let count = 0
      for (const agent of roots) if (agent && agent.status === 'running') count += 1
      return count
    }
    // No injected service and no event yet: we cannot tell, so do not claim the turn.
    if (!sawAgentEvent) return 1
    return running.size
  }

  const publish = () => {
    if (disposed) return
    // One snapshot, one write: the two flags must never disagree about which
    // tick they came from.
    const pendingNow = pending
    const runningNow = runningCount()
    // `waiting` keeps its original meaning (the turn is back with the user) and
    // its original expression; `busy` is what the watchdog actually obeys.
    const waiting = pendingNow > 0 || runningNow === 0
    const busy = pendingNow > 0 || runningNow > 0
    writeWaiting({ waiting, busy, pending: pendingNow, running: running.size, sawAgent: sawAgentEvent })
  }

  // Waterfall: +1 on entry, -1 once next() settles, always returning its value.
  const guard = (request, next) => {
    pending += 1
    publish()
    let result
    try {
      result = next()
    } catch (error) {
      pending -= 1
      publish()
      throw error
    }
    return Promise.resolve(result).then(
      (value) => {
        pending -= 1
        publish()
        return value
      },
      (error) => {
        pending -= 1
        publish()
        throw error
      },
    )
  }

  const listen = (name, listener, options) => {
    try {
      const off = options === undefined ? ctx.on?.(name, listener) : ctx.on?.(name, listener, options)
      if (typeof off === 'function') offs.push(off)
    } catch {
      /* event absent on this host build */
    }
  }

  // Reconcile one agent's membership from any event that carries it.
  const syncAgent = (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    if (agent.status === 'running') running.add(agent)
    else running.delete(agent)
  }

  // Only `agent/status` proves the running set is observable: it is the one event
  // that reports a transition for an agent we may have missed being created.
  const onStatus = (payload) => {
    sawAgentEvent = true
    syncAgent(payload)
    publish()
  }

  const onCreated = (payload) => {
    syncAgent(payload)
    publish()
  }

  const onDisposed = (payload) => {
    const agent = payload && payload.agent
    if (agent) running.delete(agent)
    publish()
  }

  publish()
  // `{ global: true }` is what makes these reachable from this plugin's scope:
  // the host dispatches them through the agent's carrier, and without the flag
  // cordis filters every listener whose fiber is not that agent's.
  //
  // `prepend: true` is equally load-bearing on the two waterfalls below. Cordis
  // registers `push` by default and runs listeners OUTERMOST-FIRST, so a later
  // listener only runs if every earlier one calls `next()`. The host registers
  // its own remote-event forwarder when it boots (earlier than any plugin) and
  // that forwarder returns the browser's answer without calling `next()` — so
  // an appended guard is never entered and `pending` stays 0 forever. Prepending
  // puts the guard outside the forwarder: it always runs, and the forwarder
  // still gets the request via `next()`.
  //
  // Must stay an object literal: cordis' `on()` rewrites a boolean shorthand to
  // `{ prepend }`, which would silently drop `global`.
  listen('user-questions/request', guard, { global: true, prepend: true })
  listen('approval/request', guard, { global: true, prepend: true })
  listen('agent/status', onStatus, { global: true })
  listen('agent/created', onCreated, { global: true })
  listen('agent/disposed', onDisposed, { global: true })

  const timer = setInterval(publish, WAITING_TICK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()

  return {
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const off of offs) {
        try {
          off()
        } catch {
          /* already detached */
        }
      }
      writeWaiting({ waiting: false, busy: false, pending: 0, running: 0, sawAgent: false })
    },
    attach(agents) {
      agentsService = agents && typeof agents.roots === 'function' ? agents : null
      publish()
    },
    detach() {
      agentsService = null
    },
  }
}

/**
 * Install the route for as long as the plugin is loaded.
 * @param {object} ctx - host context (already waiting on the web server).
 * @param {object} config - plugin config.
 * @returns {() => void} disposer.
 */
function installRoute(ctx, config) {
  const reject = makeFence(ctx)
  const handler = async (req, res) => {
    if (reject(req, res)) return
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (method === 'GET') {
        sendJson(res, 200, await collectState(ctx, config))
        return
      }

      if (method === 'POST') {
        const raw = await readBody(req)
        let body = {}
        try {
          body = raw.length > 0 ? JSON.parse(raw) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const action = typeof body.action === 'string' ? body.action.toLowerCase() : 'refresh'
        if (action !== 'on' && action !== 'off' && action !== 'refresh' && action !== 'config') {
          sendJson(res, 400, { ok: false, error: `不支持的动作：${action}` })
          return
        }

        if (action === 'config') {
          const patch = body.config && typeof body.config === 'object' ? body.config : {}
          if (typeof patch.keepAwakeWhileWaiting !== 'boolean') {
            sendJson(res, 400, { ok: false, error: 'config.keepAwakeWhileWaiting 必须是布尔值' })
            return
          }
          const next = { keepAwakeWhileWaiting: patch.keepAwakeWhileWaiting }
          try {
            writeConfig(next)
          } catch (error) {
            sendJson(res, 200, { ok: false, error: `写配置失败：${String((error && error.message) || error)}` })
            return
          }
          const target = findScript(ctx, config)
          let restarted = false
          let failure = ''
          if (target !== null) {
            const before = await runSwitch(target, 'Status')
            if (parseStatus(before.text).enabled) {
              const result = await runSwitch(target, 'Restart') // 内部重读刚写好的 config
              restarted = result.ok
              if (!result.ok) failure = result.error || '重启看门狗失败'
            }
          }
          const state = await collectState(ctx, config)
          sendJson(res, 200, {
            ...state,
            ok: state.ok && failure.length === 0,
            restarted,
            error: failure || state.error,
          })
          return
        }

        const script = findScript(ctx, config)
        if (script === null) {
          sendJson(res, 200, {
            ok: false,
            enabled: false,
            known: false,
            error: `找不到 ${SCRIPT_NAME}`,
            ...(await collectState(ctx, config)),
          })
          return
        }

        if (action !== 'refresh') {
          const target = action === 'on' ? 'On' : 'Off'
          const result = await runSwitch(script, target)
          const failure = !result.ok
          const state = await collectState(ctx, config)
          sendJson(res, 200, {
            ...state,
            ok: state.ok && !failure,
            message: result.text,
            error: failure ? result.error || '切换失败' : state.error,
          })
          return
        }

        sendJson(res, 200, await collectState(ctx, config))
        return
      }

      try {
        res.statusCode = 405
        res.end()
      } catch {
        /* client disconnected */
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  return ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
}

/**
 * Host entry point.
 * @param {object} ctx - host context.
 * @param {object} [config] - optional `{ scriptPath }` override.
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}

  // Wait for the web server instead of declaring it in the module-level `inject`,
  // so this plugin still loads cleanly anywhere the service is absent.
  ctx.inject(['webServer'], (scoped) => {
    const remove = installRoute(scoped, settings)
    scoped.effect(() => () => {
      try {
        remove()
      } catch {
        /* already torn down */
      }
    })
  })

  ctx.effect(() => {
    const tracker = createWaitingTracker(ctx)
    // Optional: when the agents service is injectable we get an exact live root
    // set. Without it the tracker still works from agent events alone, so a host
    // build that never provides the service must not take the switch down.
    ctx.inject(['agents'], (scoped) => {
      const agents = scoped.agents
      if (!agents || typeof agents.roots !== 'function') return
      tracker.attach(agents)
      scoped.effect(() => () => tracker.detach())
    })
    return () => tracker.dispose()
  })
}
