/**
 * dsh-rebooter-core — policy with no Cordis and no IO.
 *
 * Layout shape, launch reconstruction, action names, the control-port lock,
 * and log scraping live here so they can be tested without spawning DSH.
 * Filesystem access for harness classification is injected (tests pass fakes).
 *
 * @module dsh-rebooter-core
 */

import { dirname, join } from 'node:path'

const PLUGIN_NAME = 'dsh-rebooter'
const STATE_DIR_NAME = 'rebooter'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_PROFILE = 'web'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const LAYOUT_VERSION = 1
const CONTROL_OFFSET = 10000
const PANEL_OFFSET = 10001
/** Page power-menu: plugin lifecycle only (DSH upgrade lives on panel + CLI). */
const MENU_ACTIONS = Object.freeze(['stop', 'restart', 'update-stop', 'update-restart'])
const PLUGIN_UPDATE_ACTIONS = Object.freeze(['update', 'update-stop', 'update-restart'])
const DSH_UPDATE_ACTIONS = Object.freeze(['update-dsh', 'update-dsh-stop', 'update-dsh-restart'])
const EXTRA_ACTIONS = Object.freeze(['update', 'update-dsh', 'open'])
const ALL_ACTIONS = Object.freeze([
  'start',
  'stop',
  'restart',
  'update-stop',
  'update-restart',
  'update',
  'update-dsh-stop',
  'update-dsh-restart',
  'update-dsh',
  'open',
])
const WEB_URL_RE = /dsh web:\s*(https?:\/\/[^\s\r\n]+)/g

function controlPort(webPort) {
  const port = Number(webPort)
  const base = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT
  const candidate = base + CONTROL_OFFSET
  return candidate <= 65535 ? candidate : Math.max(1, base - 1)
}

function panelPort(webPort) {
  const port = Number(webPort)
  const base = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT
  const candidate = base + PANEL_OFFSET
  return candidate <= 65535 ? candidate : Math.max(1, base - 2)
}

function isAction(value) {
  return ALL_ACTIONS.includes(value)
}

function isMenuAction(value) {
  return MENU_ACTIONS.includes(value)
}

function isPluginUpdateAction(value) {
  return PLUGIN_UPDATE_ACTIONS.includes(value)
}

function isDshUpdateAction(value) {
  return DSH_UPDATE_ACTIONS.includes(value)
}

/** Buttons shown on the status panel when no job is busy. */
function availableActions(running) {
  if (running === true) {
    return Object.freeze([
      'stop', 'restart',
      'update-stop', 'update-restart',
      'update-dsh-stop', 'update-dsh-restart',
      'open',
    ])
  }
  return Object.freeze([
    'start',
    'update', 'update-restart',
    'update-dsh', 'update-dsh-restart',
  ])
}

function idleJob() {
  return {
    version: 1,
    id: null,
    action: null,
    state: 'idle',
    message: '',
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

function defaultPanelPrefs() {
  return {
    version: 1,
    autoOpen: false,
    openApp: null,
  }
}

/** Whether a start-like action should open the UI (prefs + explicit flags). */
function shouldOpenUi(action, options = {}, prefs = defaultPanelPrefs()) {
  if (action === 'open') return true
  if (options.open === true) return true
  if (options.open === false) return false
  if (action === 'start' || action === 'restart'
    || action === 'update-restart' || action === 'update-dsh-restart') {
    return prefs.autoOpen === true
  }
  return false
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

function normalizePath(value) {
  return String(value).replace(/\\/g, '/')
}

function parentOrUndef(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  const parent = dirname(dir)
  return parent === dir ? undefined : parent
}

function isNpxEntry(entry) {
  const norm = normalizePath(entry)
  return norm.includes('/_npx/') || /\/npm-cache\/_npx\//i.test(norm)
}

function readPackageName(pkgPath, io) {
  try {
    const pkg = JSON.parse(io.readFileSync(pkgPath, 'utf8'))
    return typeof pkg?.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

function readPackageJson(pkgPath, io) {
  try {
    return JSON.parse(io.readFileSync(pkgPath, 'utf8'))
  } catch {
    return undefined
  }
}

function packageDeclaresDsh(pkg) {
  if (!pkg || typeof pkg !== 'object') return false
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const bag = pkg[field]
    if (bag && typeof bag === 'object' && Object.prototype.hasOwnProperty.call(bag, DSH_PACKAGE)) {
      return true
    }
  }
  return false
}

/**
 * Classify the harness install recorded in layout.
 * @param {object} layout
 * @param {{ existsSync: Function, readFileSync: Function, realpathSync?: Function }} io
 */
function classifyHarness(layout, io) {
  if (!io || typeof io.existsSync !== 'function' || typeof io.readFileSync !== 'function') {
    return { kind: 'unknown', entry: '', root: undefined, reason: 'filesystem io required', npx: false }
  }
  const entry = typeof layout?.args?.[0] === 'string' ? layout.args[0] : ''
  if (!entry || !io.existsSync(entry)) {
    return { kind: 'unknown', entry, root: undefined, reason: 'missing entry script', npx: false }
  }
  const npx = isNpxEntry(entry)

  let cliPkgRoot
  for (let dir = dirname(entry); dir; dir = parentOrUndef(dir)) {
    const pkgPath = join(dir, 'package.json')
    if (!io.existsSync(pkgPath)) continue
    if (readPackageName(pkgPath, io) === DSH_PACKAGE) {
      cliPkgRoot = dir
      break
    }
  }

  const walkStart = typeof layout?.cwd === 'string' && layout.cwd.trim().length > 0
    ? layout.cwd.trim()
    : dirname(entry)
  let gitRoot
  for (let dir = walkStart; dir; dir = parentOrUndef(dir)) {
    if (io.existsSync(join(dir, '.git'))) {
      gitRoot = dir
      break
    }
  }

  const normEntry = normalizePath(entry)
  const inNodeModules = normEntry.includes('/node_modules/')

  if (inNodeModules && cliPkgRoot) {
    return {
      kind: 'npm', entry, root: cliPkgRoot, cliPkgRoot, gitRoot, npx,
      reason: npx ? 'npx install is not upgradable' : undefined,
    }
  }

  const isSourceBin = /[/\\]apps[/\\]cli[/\\]src[/\\]bin\.ts$/i.test(entry)
  const cliUnderGit = Boolean(
    gitRoot && cliPkgRoot
    && normalizePath(cliPkgRoot).startsWith(`${normalizePath(gitRoot)}/`),
  )
  if (gitRoot && (isSourceBin || cliUnderGit)) {
    return { kind: 'git', entry, root: gitRoot, cliPkgRoot, gitRoot, npx: false, reason: undefined }
  }

  return {
    kind: 'unknown', entry, root: undefined, cliPkgRoot, gitRoot, npx,
    reason: 'unrecognized DSH install',
  }
}

function projectRootAboveCliPkg(cliPkgRoot) {
  let dir = cliPkgRoot
  while (dir && !normalizePath(dir).endsWith('/node_modules')) {
    dir = parentOrUndef(dir)
  }
  return dir ? parentOrUndef(dir) : undefined
}

/**
 * Build a DSH-update recipe from a classification.
 * @returns {{ kind: string, steps: object[], refreshLayout: boolean } | { error: string }}
 */
function dshUpdatePlan(layout, classified, io) {
  if (!classified || classified.kind === 'unknown') {
    return { error: classified?.reason || 'unrecognized DSH install' }
  }
  if (classified.npx || classified.reason === 'npx install is not upgradable') {
    return { error: 'npx install is not upgradable; start DSH from a global or project-local @deepseek-ai/dsh' }
  }

  if (classified.kind === 'git') {
    const cwd = classified.gitRoot || classified.root
    if (!cwd) return { error: 'missing git root' }
    const steps = [
      { tool: 'git', args: ['status', '--porcelain'], cwd, label: 'git status', expectEmptyStdout: true },
      { tool: 'git', args: ['pull', '--ff-only'], cwd, label: 'git pull --ff-only', capturesPull: true },
      { tool: 'pnpm', args: ['install'], cwd, label: 'pnpm install' },
    ]
    const execArgv = Array.isArray(layout?.execArgv) ? layout.execArgv : []
    const usesTsx = execArgv.some((token) => String(token).includes('tsx'))
    const isBinTs = /bin\.ts$/i.test(classified.entry || '')
    // Host CLI can run from TypeScript via tsx, but browser plugins are still
    // served from packages/*/lib/client.js. Rebuild only when pull moved HEAD —
    // a no-op pull must not run `build:lib:client`, which often fails on WIP
    // trees for unrelated tsc errors and previously blocked the panel.
    if (usesTsx && isBinTs) {
      steps.push({
        tool: 'pnpm',
        args: ['run', 'build:lib:client'],
        cwd,
        label: 'pnpm build:lib:client',
        optionalUnlessNeeded: true,
      })
      return { kind: 'git', steps, refreshLayout: false }
    }
    if (/[/\\]apps[/\\]cli[/\\]lib[/\\]bin\.js$/i.test(classified.entry || '')) {
      steps.push({
        tool: 'pnpm',
        args: ['--filter', DSH_PACKAGE, 'run', 'build'],
        cwd,
        label: `pnpm build ${DSH_PACKAGE}`,
        optionalUnlessNeeded: true,
      })
      return { kind: 'git', steps, refreshLayout: false }
    }
    return { error: 'cannot choose a build; start DSH via tsx + bin.ts or a built lib/bin.js' }
  }

  if (classified.kind === 'npm') {
    if (!io || typeof io.existsSync !== 'function') {
      return { error: 'filesystem io required for npm DSH update' }
    }
    const realpathSync = typeof io.realpathSync === 'function' ? io.realpathSync : (path) => path
    const cliPkgRoot = classified.cliPkgRoot || classified.root
    if (!cliPkgRoot) return { error: 'missing @deepseek-ai/dsh package root' }

    const norm = normalizePath(cliPkgRoot)
    const looksGlobal = /\/npm\/node_modules\/@deepseek-ai\/dsh$/i.test(norm)
      || /\/Roaming\/npm\/node_modules\/@deepseek-ai\/dsh$/i.test(norm)

    if (looksGlobal) {
      return {
        kind: 'npm',
        scope: 'global',
        steps: [{
          tool: 'npm',
          args: ['install', '-g', `${DSH_PACKAGE}@latest`],
          cwd: cliPkgRoot,
          label: `npm install -g ${DSH_PACKAGE}@latest`,
        }],
        refreshLayout: true,
      }
    }

    const projectRoot = projectRootAboveCliPkg(cliPkgRoot)
    if (!projectRoot) {
      return { error: 'cannot locate project root for local @deepseek-ai/dsh' }
    }
    const pkgPath = join(projectRoot, 'package.json')
    const pkg = readPackageJson(pkgPath, io)
    if (!packageDeclaresDsh(pkg)) {
      return { error: 'project does not declare @deepseek-ai/dsh as a direct dependency' }
    }
    const linked = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh')
    if (!io.existsSync(linked)) {
      return { error: 'project node_modules/@deepseek-ai/dsh is missing' }
    }
    try {
      if (normalizePath(realpathSync(linked)) !== normalizePath(realpathSync(cliPkgRoot))) {
        return { error: 'project @deepseek-ai/dsh does not match the running entry' }
      }
    } catch {
      return { error: 'cannot realpath local @deepseek-ai/dsh' }
    }
    const usePnpm = io.existsSync(join(projectRoot, 'pnpm-lock.yaml'))
    if (usePnpm) {
      return {
        kind: 'npm',
        scope: 'local',
        steps: [{
          tool: 'pnpm',
          args: ['add', `${DSH_PACKAGE}@latest`],
          cwd: projectRoot,
          label: `pnpm add ${DSH_PACKAGE}@latest`,
        }],
        refreshLayout: true,
      }
    }
    return {
      kind: 'npm',
      scope: 'local',
      steps: [{
        tool: 'npm',
        args: ['install', `${DSH_PACKAGE}@latest`],
        cwd: projectRoot,
        label: `npm install ${DSH_PACKAGE}@latest`,
      }],
      refreshLayout: true,
    }
  }

  return { error: 'unrecognized DSH install' }
}

/**
 * True when a successful `git pull` transcript indicates HEAD moved.
 * @param {string} [pullStdout]
 */
function gitPullBroughtCommits(pullStdout) {
  const out = String(pullStdout ?? '')
  if (out.length === 0) return false
  if (/\bAlready up to date\b/i.test(out)) return false
  return true
}

/**
 * Whether a git client/lib rebuild is required after `git pull`.
 * Only the pull transcript matters: no-op pulls must not invoke a workspace
 * build that WIP trees often cannot complete.
 * @param {string} _gitRoot unused; kept for call-site stability
 * @param {unknown} _io unused; kept for call-site stability
 * @param {string} [pullStdout]
 * @returns {{ needed: boolean, reason: string }}
 */
function gitClientBuildNeeded(_gitRoot, _io, pullStdout) {
  if (gitPullBroughtCommits(pullStdout)) {
    return { needed: true, reason: 'git pull brought new commits' }
  }
  return { needed: false, reason: 'pull unchanged' }
}

export {
  ALL_ACTIONS,
  CONTROL_OFFSET,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  DSH_PACKAGE,
  DSH_UPDATE_ACTIONS,
  EXTRA_ACTIONS,
  LAYOUT_VERSION,
  MENU_ACTIONS,
  PANEL_OFFSET,
  PLUGIN_NAME,
  PLUGIN_UPDATE_ACTIONS,
  STATE_DIR_NAME,
  availableActions,
  backoffDelay,
  captureLaunch,
  canonicalUrl,
  classifyHarness,
  controlPort,
  defaultPanelPrefs,
  dshUpdatePlan,
  gitClientBuildNeeded,
  gitPullBroughtCommits,
  idleJob,
  isAction,
  isDshUpdateAction,
  isMenuAction,
  isPidAlive,
  isPluginUpdateAction,
  panelPort,
  parseHost,
  parsePort,
  parseWebUrl,
  pluginUpdateArgs,
  shouldOpenUi,
  shouldSkipStart,
  spawnArgv,
  webIndex,
  withNoOpen,
}
