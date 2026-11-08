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
 * @param {'On' | 'Off' | 'Status'} action - script action.
 * @param {number} timeoutMs - hard timeout for the child process.
 * @returns {Promise<{ok: boolean, text: string, error: string}>} the outcome.
 */
function runSwitch(scriptPath, action, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const quoted = scriptPath.replace(/'/g, "''")
    const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${quoted}' -Action ${action} -Quiet`
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
    const released = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+空闲 .*释放锁/)
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
        if (action !== 'on' && action !== 'off' && action !== 'refresh') {
          sendJson(res, 400, { ok: false, error: `不支持的动作：${action}` })
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
}
