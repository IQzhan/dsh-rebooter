/**
 * dsh-rebooter-core — policy with no Cordis and no IO.
 *
 * Layout shape, launch reconstruction, action names, the control-port lock,
 * and log scraping live here so they can be tested without spawning DSH.
 *
 * @module dsh-rebooter-core
 */

const PLUGIN_NAME = 'dsh-rebooter'
const STATE_DIR_NAME = 'rebooter'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_PROFILE = 'web'
const LAYOUT_VERSION = 1
const CONTROL_OFFSET = 10000
const MENU_ACTIONS = Object.freeze(['stop', 'restart', 'update-stop', 'update-restart'])
const ALL_ACTIONS = Object.freeze(['start', ...MENU_ACTIONS])
const WEB_URL_RE = /dsh web:\s*(https?:\/\/[^\s\r\n]+)/g

function controlPort(webPort) {
  const port = Number(webPort)
  const base = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT
  const candidate = base + CONTROL_OFFSET
  return candidate <= 65535 ? candidate : Math.max(1, base - 1)
}

function isAction(value) {
  return ALL_ACTIONS.includes(value)
}

function isMenuAction(value) {
  return MENU_ACTIONS.includes(value)
}

function parseFlag(args, name, fallback) {
  const list = Array.isArray(args) ? args : []
  const prefix = `${name}=`
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]
    if (token === name && list[index + 1] !== undefined) return list[index + 1]
    if (typeof token === 'string' && token.startsWith(prefix)) return token.slice(prefix.length)
  }
  return fallback
}

function parsePort(args, fallback = DEFAULT_PORT) {
  const raw = parseFlag(args, '--port', fallback)
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

function parseHost(args, fallback = DEFAULT_HOST) {
  const host = parseFlag(args, '--host', fallback)
  return typeof host === 'string' && host.trim().length > 0 ? host.trim() : fallback
}

function withNoOpen(args) {
  const list = Array.isArray(args) ? args.slice() : []
  if (list.includes('--no-open')) return list
  list.push('--no-open')
  return list
}

function webIndex(args) {
  const list = Array.isArray(args) ? args : []
  return list.lastIndexOf('web')
}

function pluginUpdateArgs(args) {
  const cleaned = (Array.isArray(args) ? args : []).filter(token => token !== '--no-open')
  const index = webIndex(cleaned)
  if (index < 0) return undefined
  return [...cleaned.slice(0, index), 'plugin', '--profile', DEFAULT_PROFILE, 'update', '--latest']
}

function captureLaunch(processLike) {
  const argv = Array.isArray(processLike?.argv) ? processLike.argv.slice() : []
  const args = argv.slice(1)
  const execArgv = Array.isArray(processLike?.execArgv) ? processLike.execArgv.slice() : []
  return {
    version: LAYOUT_VERSION,
    host: parseHost(args, DEFAULT_HOST),
    port: parsePort(args, DEFAULT_PORT),
    profile: DEFAULT_PROFILE,
    node: typeof processLike?.execPath === 'string' ? processLike.execPath : '',
    execArgv,
    args: withNoOpen(args),
    cwd: typeof processLike?.cwd === 'string'
      ? processLike.cwd
      : (typeof processLike?.cwd === 'function' ? processLike.cwd() : ''),
    dshHome: typeof processLike?.env?.DSH_HOME === 'string' ? processLike.env.DSH_HOME : '',
    nodePid: Number(processLike?.pid) || 0,
    supervisorPid: 0,
  }
}

function spawnArgv(layout) {
  const execArgv = Array.isArray(layout?.execArgv) ? layout.execArgv : []
  const args = withNoOpen(Array.isArray(layout?.args) ? layout.args : [])
  return [...execArgv, ...args]
}

function parseWebUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const matches = [...text.matchAll(WEB_URL_RE)]
  if (matches.length === 0) return undefined
  return matches[matches.length - 1][1]
}

function isPidAlive(pid, ping) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  if (typeof ping !== 'function') return false
  try {
    ping(id, 0)
    return true
  } catch {
    return false
  }
}

function backoffDelay(generation, initialMs = 1000, maxMs = 30000) {
  const n = Number(generation)
  const start = Number(initialMs) > 0 ? Number(initialMs) : 1000
  const cap = Number(maxMs) > 0 ? Number(maxMs) : 30000
  if (!Number.isInteger(n) || n <= 0) return start
  return Math.min(start * (2 ** Math.min(n, 16)), cap)
}

function canonicalUrl(layout, pathAndQuery) {
  const host = typeof layout?.host === 'string' && layout.host.trim().length > 0 ? layout.host.trim() : DEFAULT_HOST
  const port = parsePort(['--port', String(layout?.port ?? '')], DEFAULT_PORT)
  if (typeof pathAndQuery === 'string' && /^https?:\/\//.test(pathAndQuery)) return pathAndQuery
  const suffix = typeof pathAndQuery === 'string' ? pathAndQuery : '/'
  return `http://${host}:${port}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

function shouldSkipStart(webHealthy, supervisorAlive) {
  return webHealthy === true || supervisorAlive === true
}

export {
  ALL_ACTIONS,
  CONTROL_OFFSET,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  LAYOUT_VERSION,
  MENU_ACTIONS,
  PLUGIN_NAME,
  STATE_DIR_NAME,
  backoffDelay,
  captureLaunch,
  canonicalUrl,
  controlPort,
  isAction,
  isMenuAction,
  isPidAlive,
  parseHost,
  parsePort,
  parseWebUrl,
  pluginUpdateArgs,
  shouldSkipStart,
  spawnArgv,
  webIndex,
  withNoOpen,
}
