/**
 * dsh-rebooter-runtime — Node IO for the supervisor, CLI, and Host half.
 *
 * Platform branches exist only where the OS actually differs (opening a URL,
 * launching a .cmd file). Everything else is `node:*`. State lives under
 * `$DSH_HOME/rebooter/`, never a checkout-local folder and never the system
 * temp directory.
 *
 * @module dsh-rebooter-runtime
 */

import {
  ALL_ACTIONS, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROFILE, DSH_PACKAGE, LAYOUT_VERSION, STATE_DIR_NAME,
  availableActions, backoffDelay, captureLaunch, canonicalUrl, classifyHarness, controlPort,
  defaultPanelPrefs, dshUpdatePlan, gitClientBuildNeeded, gitPullBroughtCommits, idleJob, isAction, isPidAlive, panelPort,
  parseWebUrl, pluginUpdateArgs, shouldOpenUi, spawnArgv, webIndex, withNoOpen,
} from './dsh-rebooter-core.js'
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const harnessFs = {
  existsSync,
  readFileSync,
  realpathSync: (path) => realpathSync(path),
  statSync: (path) => statSync(path),
}

function resolveHome(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function statePaths(home = resolveHome()) {
  const root = join(home, STATE_DIR_NAME)
  return {
    root,
    layout: join(root, 'layout.json'),
    supervisorPid: join(root, 'supervisor.pid'),
    nodePid: join(root, 'node.pid'),
    panelPid: join(root, 'panel.pid'),
    keepalive: join(root, 'keepalive'),
    stopping: join(root, 'stopping'),
    outLog: join(root, 'web.out.log'),
    errLog: join(root, 'web.err.log'),
    supervisorLog: join(root, 'supervisor.log'),
    url: join(root, 'web.url'),
    job: join(root, 'job.json'),
    jobLog: join(root, 'job.log'),
    panelPrefs: join(root, 'panel.json'),
  }
}

function ensureStateDir(paths) {
  mkdirSync(paths.root, { recursive: true })
  return paths
}

function writeText(path, text) {
  writeFileSync(path, text, 'utf8')
}

function readText(path) {
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readLayout(paths) {
  const raw = readText(paths.layout)
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeLayout(paths, layout) {
  ensureStateDir(paths)
  writeJson(paths.layout, layout)
  return layout
}

function readPanelPrefs(paths) {
  const stored = (() => {
    const raw = readText(paths.panelPrefs)
    if (raw === undefined) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })()
  const base = defaultPanelPrefs()
  return {
    version: base.version,
    autoOpen: stored.autoOpen === true,
    openApp: typeof stored.openApp === 'string' && stored.openApp.trim().length > 0
      ? stored.openApp.trim()
      : null,
  }
}

function writePanelPrefs(paths, prefs) {
  const base = defaultPanelPrefs()
  const next = {
    version: base.version,
    autoOpen: prefs?.autoOpen === true,
    openApp: typeof prefs?.openApp === 'string' && prefs.openApp.trim().length > 0
      ? prefs.openApp.trim()
      : null,
  }
  ensureStateDir(paths)
  writeJson(paths.panelPrefs, next)
  return next
}

function readJob(paths) {
  const raw = readText(paths.job)
  const base = idleJob()
  if (raw === undefined) return base
  try {
    const stored = JSON.parse(raw)
    if (stored === null || typeof stored !== 'object') return base
    return {
      ...base,
      ...stored,
      state: ['idle', 'busy', 'ok', 'error'].includes(stored.state) ? stored.state : 'idle',
    }
  } catch {
    return base
  }
}

function writeJob(paths, job) {
  ensureStateDir(paths)
  writeJson(paths.job, job)
  return job
}

function appendJobLog(paths, line) {
  ensureStateDir(paths)
  const text = typeof line === 'string' ? line : String(line)
  const prev = readText(paths.jobLog)
  writeText(paths.jobLog, prev === undefined || prev.length === 0 ? `${text}\n` : `${prev}${text}\n`)
}

function beginJob(paths, action, message) {
  const job = {
    ...idleJob(),
    id: `${Date.now()}`,
    action,
    state: 'busy',
    message: typeof message === 'string' ? message : '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  }
  writeText(paths.jobLog, '')
  writeJob(paths, job)
  if (job.message) appendJobLog(paths, job.message)
  return job
}

function endJob(paths, state, message, error) {
  const prev = readJob(paths)
  const job = {
    ...prev,
    state: state === 'ok' || state === 'error' || state === 'idle' ? state : 'idle',
    message: typeof message === 'string' ? message : prev.message,
    finishedAt: new Date().toISOString(),
    error: error === undefined || error === null ? null : String(error),
  }
  writeJob(paths, job)
  if (typeof message === 'string' && message.length > 0) appendJobLog(paths, message)
  if (job.error) appendJobLog(paths, job.error)
  return job
}

function openDshUi(paths, layout) {
  // Fire-and-forget wrapper for sync call sites; prefer openDshUiAsync.
  void openDshUiAsync(paths, layout)
  const url = readWebUrl(paths, layout)
  return { ok: true, url, app: readPanelPrefs(paths).openApp || null, pending: true }
}

async function panelHttpReady(port, timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/api/snapshot`, { signal: ac.signal })
    if (!response.ok) return false
    await response.json()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function ensurePanelHttp(paths, layout) {
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  if (await panelHttpReady(port)) return true
  const cli = cliPathFromHost()
  const node = layout?.node || process.execPath
  const env = { ...process.env }
  if (layout?.dshHome) env.DSH_HOME = layout.dshHome
  spawnDetached(node, [cli, 'panel', '--serve'], {
    cwd: layout?.cwd || process.cwd(),
    env,
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await panelHttpReady(port, 800)) return true
    await sleep(150)
  }
  return panelHttpReady(port, 800)
}

async function requestAppWindowOpen(paths, layout, options = {}) {
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const url = typeof options.url === 'string' && options.url.length > 0
    ? options.url
    : readWebUrl(paths, layout)
  if (!url) return false
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12000)
  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/api/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        force: options.force !== false,
        resetCache: options.resetCache === true,
        url,
      }),
      signal: ac.signal,
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true && body?.shown !== false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open the DSH page through the single panel process (never a second HTTP server).
 * Tokenized URLs 303-set a cookie then land on `/`; a stale WebView profile makes
 * that land on a blank 401 shell — force a cold window when requested.
 */
async function openDshUiAsync(paths, layout, options = {}) {
  const prefs = readPanelPrefs(paths)
  const url = readWebUrl(paths, layout)
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('DSH URL is not available yet (waiting for tokenized dsh web: line)')
  }
  if (prefs.openApp) {
    spawnDetached(prefs.openApp, [url])
    return { ok: true, url, app: prefs.openApp }
  }
  const ready = await ensurePanelHttp(paths, layout)
  if (!ready) {
    throw new Error('panel HTTP did not start; cannot open the DSH page window')
  }
  const shown = await requestAppWindowOpen(paths, layout, {
    url,
    force: true,
    resetCache: options.resetCache === true,
  })
  if (!shown) {
    throw new Error('panel could not open the DSH page window')
  }
  return { ok: true, url, app: null, shown: true }
}

async function requestAppWindowClose(layout) {
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2000)
  try {
    await fetch(`http://${DEFAULT_HOST}:${port}/api/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'close' }),
      signal: ac.signal,
    })
  } catch {
    /* the page window is owned by the panel; it may not be open */
  } finally {
    clearTimeout(timer)
  }
}

function writePidFile(path, pid) {
  writeText(path, `pid=${Number(pid)}\n`)
}

function readPidFile(path) {
  const raw = readText(path)
  if (raw === undefined) return 0
  const match = /^pid=(\d+)\s*$/m.exec(raw)
  return match ? Number(match[1]) : 0
}

function removeFile(path) {
  if (existsSync(path)) rmSync(path, { force: true })
}

function logSupervisor(paths, message) {
  ensureStateDir(paths)
  appendFileSync(paths.supervisorLog, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
}

function pingPid(pid, signal) {
  process.kill(pid, signal)
}

function pidAlive(pid) {
  return isPidAlive(pid, pingPid)
}

function killPid(pid, signal = 'SIGTERM') {
  if (!pidAlive(pid)) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitPidGone(pid, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (pidAlive(pid) && Date.now() < deadline) await sleep(intervalMs)
  if (pidAlive(pid)) {
    killPid(pid, 'SIGKILL')
    await sleep(200)
  }
  return !pidAlive(pid)
}

function spawnOptions(extra) {
  return {
    windowsHide: true,
    ...extra,
  }
}

function isWindowsBatch(file) {
  return process.platform === 'win32' && typeof file === 'string' && /\.(cmd|bat)$/i.test(file)
}

function spawnProcess(file, args, options) {
  if (isWindowsBatch(file)) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return spawn(comspec, ['/d', '/s', '/c', file, ...args], spawnOptions(options))
  }
  return spawn(file, args, spawnOptions(options))
}

function spawnDetached(file, args, options = {}) {
  // One cross-platform shape: detach from the launcher, inherit no stdio, and
  // on Windows ask for CREATE_NO_WINDOW (`windowsHide`) by default. Pass
  // `windowsHide: false` for real UI processes (Edge/Chrome `--app=`).
  const child = spawn(file, args, spawnOptions({
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: options.windowsHide !== false,
  }))
  child.unref()
  return child
}

function decodeRegQuery(raw) {
  const utf16 = raw.toString('utf16le').replace(/^\uFEFF/, '')
  return utf16.includes('NODE_OPTIONS') ? utf16 : raw.toString('utf8')
}

/** Plugin-owned preload line. One non-comment line under `$DSH_HOME/rebooter/node-options`. */
function readPluginNodeOptions(home) {
  if (typeof home !== 'string' || home.trim().length === 0) return undefined
  const raw = readText(join(home.trim(), STATE_DIR_NAME, 'node-options'))
  if (typeof raw !== 'string') return undefined
  for (const row of raw.split(/\r?\n/)) {
    const line = row.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    return line
  }
  return undefined
}

// Last-resort Windows user environment (not the system proxy). Preload
// installers write NODE_OPTIONS here; some parents never copy that value.
function readOsUserNodeOptions() {
  if (process.platform !== 'win32') return undefined
  let raw
  try {
    raw = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'NODE_OPTIONS'], {
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
  const line = decodeRegQuery(raw).split(/\r?\n/).find(row => /^\s*NODE_OPTIONS\s+REG_/.test(row))
  if (line === undefined) return undefined
  const value = line.replace(/^\s*NODE_OPTIONS\s+REG_\S+\s+/, '').trim()
  return value.length > 0 ? value : undefined
}

function fillMissingNodeOptions(env, readOsUser = readOsUserNodeOptions) {
  const current = env.NODE_OPTIONS
  if (typeof current === 'string' && current.trim() !== '') return env
  const fromPluginEnv = typeof env.DSH_NODE_OPTIONS === 'string' ? env.DSH_NODE_OPTIONS.trim() : ''
  if (fromPluginEnv) {
    env.NODE_OPTIONS = fromPluginEnv
    return env
  }
  const fromFile = readPluginNodeOptions(env.DSH_HOME)
  if (fromFile) {
    env.NODE_OPTIONS = fromFile
    return env
  }
  const fromOs = readOsUser()
  if (typeof fromOs === 'string' && fromOs.trim() !== '') env.NODE_OPTIONS = fromOs.trim()
  return env
}

/**
 * Path to the packaged `--require` preload (beside cli.cjs), or the checkout
 * copy when tests run from the repo root.
 */
function windowsHidePreloadPath() {
  const besideCli = join(dirname(cliPathFromHost()), 'windows-hide-child.cjs')
  if (existsSync(besideCli)) return besideCli
  const checkout = join(process.cwd(), 'windows-hide-child.cjs')
  return existsSync(checkout) ? checkout : undefined
}

/**
 * On Windows only: prepend `--require …/windows-hide-child.cjs` so a
 * console-less host does not flash a new console on every child spawn.
 * `windowsHide` is a Node spawn option (no-op elsewhere); we never touch
 * Win32 APIs. Existing NODE_OPTIONS values are kept after this flag so later
 * preloads (e.g. sysproxy) still wrap our wrap.
 */
function prependWindowsHideRequire(env) {
  if (process.platform !== 'win32') return env
  const file = windowsHidePreloadPath()
  if (file === undefined) return env
  const current = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : ''
  if (current.includes('windows-hide-child.cjs')) return env
  const flag = /\s/.test(file) ? `--require "${file}"` : `--require ${file}`
  env.NODE_OPTIONS = current.trim() === '' ? flag : `${flag} ${current.trim()}`
  return env
}

function envForHost(layout, extra = {}, readOsUser = readOsUserNodeOptions) {
  // Parent environment is copied, not interpreted. Proxy variables stay as the
  // parent left them. A missing NODE_OPTIONS is filled from plugin-owned
  // sources first, then (Windows only) the OS user environment. Never invent.
  // On Windows, prepend the windowsHide preload so tool spawns stay quiet.
  const env = { ...process.env, ...extra }
  if (typeof layout?.dshHome === 'string' && layout.dshHome.trim().length > 0) {
    env.DSH_HOME = layout.dshHome.trim()
  }
  fillMissingNodeOptions(env, readOsUser)
  return prependWindowsHideRequire(env)
}

function envForOneShot(layout) {
  return envForHost(layout)
}

function lookOnPath(name, env = process.env) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  const dirs = typeof env[pathKey] === 'string' ? env[pathKey].split(delimiter) : []
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    if (dir.length === 0) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function isWebListening(layout, timeoutMs = 400) {
  const host = layout?.host || DEFAULT_HOST
  const port = Number(layout?.port) || DEFAULT_PORT
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const finish = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function probeHttp(url, timeoutMs = 4000) {
  if (typeof url !== 'string' || url.length === 0) return false
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: ac.signal, redirect: 'manual' })
    // 401 on the bare origin means "listening but not usable" — wait for the
    // tokenized `dsh web:` URL instead of opening a locked shell.
    return response.status >= 200 && response.status < 400
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isTokenizedWebUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    return typeof token === 'string' && token.length > 0
  } catch {
    return false
  }
}

function readWebUrl(paths, layout) {
  // Prefer the log's tokenized URL over a bare `web.url` — a 401 on `/` means
  // the server is up, but opening / saving the bare origin is not useful.
  const fromLog = parseWebUrl(readText(paths.outLog) ?? '')
  if (fromLog && isTokenizedWebUrl(fromLog)) return fromLog
  const fromFile = readText(paths.url)?.trim()
  if (fromFile && isTokenizedWebUrl(fromFile)) return fromFile
  return undefined
}

async function waitWebReady(paths, layout, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = readWebUrl(paths, layout)
    if (url && await probeHttp(url, 3000)) {
      writeText(paths.url, url)
      return url
    }
    await sleep(400)
  }
  return undefined
}

function openUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return
  if (process.platform === 'darwin') {
    spawnDetached('open', [url])
    return
  }
  if (process.platform === 'win32') {
    // `start` needs an empty title when the URL is quoted; windowsHide keeps
    // the brief cmd helper off-screen.
    spawnDetached(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url])
    return
  }
  spawnDetached('xdg-open', [url])
}

function desktopDir() {
  const home = homedir()
  const candidates = [
    process.env.DSH_REBOOTER_DESKTOP,
    join(home, 'Desktop'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'OneDrive', '桌面'),
    join(home, '桌面'),
  ]
  for (const dir of candidates) {
    if (typeof dir === 'string' && dir.length > 0 && existsSync(dir)) return dir
  }
  return undefined
}

function launcherNames() {
  if (process.platform === 'win32') {
    return { kind: 'vbs', ext: '.vbs' }
  }
  if (process.platform === 'darwin') {
    return { kind: 'command', ext: '.command' }
  }
  return { kind: 'desktop', ext: '.desktop' }
}

function quoteForVbs(value) {
  return String(value).replace(/"/g, '""')
}

function panelLauncherBody(kind) {
  // The file lives in <package>/panel/. It finds cli.cjs from its own location
  // so a moved or reinstalled package does not keep another machine's paths.
  if (kind === 'vbs') {
    return [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set sh = CreateObject("WScript.Shell")',
      'panelDir = fso.GetParentFolderName(WScript.ScriptFullName)',
      'pkg = fso.GetParentFolderName(panelDir)',
      'cli = fso.BuildPath(fso.BuildPath(pkg, "lib"), "cli.cjs")',
      'sh.CurrentDirectory = pkg',
      'sh.Run "node """ & cli & """ panel", 0, False',
      '',
    ].join('\r\n')
  }
  const script = [
    '#!/bin/sh',
    'here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)',
    'pkg=$(CDPATH= cd -- "$here/.." && pwd)',
    'cd "$pkg" || exit 1',
    'exec node ./lib/cli.cjs panel',
    '',
  ].join('\n')
  if (kind === 'desktop') return script
  return script
}

function writePanelLaunchers(panelDir) {
  mkdirSync(panelDir, { recursive: true })
  const files = [
    ['DSH-Server.vbs', panelLauncherBody('vbs'), null],
    ['DSH-Server.sh', panelLauncherBody('desktop'), 0o755],
  ]
  const written = []
  for (const [name, body, mode] of files) {
    const entryPath = join(panelDir, name)
    try {
      writeText(entryPath, body)
      if (mode !== null) chmodSync(entryPath, mode)
    } catch (error) {
      if (!existsSync(entryPath)) throw error
    }
    written.push(entryPath)
  }
  return written
}

function desktopCreatedMarker() {
  return join(resolveHome(), STATE_DIR_NAME, 'desktop.created')
}

function packagePanelDir(cli = cliPathFromHost()) {
  return join(dirname(cli), '..', 'panel')
}

function writeWindowsShortcut(lnkPath, target, args, options = {}) {
  // Helper stays in the plugin state directory, never on the Desktop.
  const dir = options.helperDir || dirname(target)
  mkdirSync(dir, { recursive: true })
  mkdirSync(dirname(lnkPath), { recursive: true })
  const helper = join(dir, '_dsh-mkshortcut.vbs')
  const q = (value) => `"${quoteForVbs(value)}"`
  const workDir = options.workDir || dirname(target)
  const iconPath = options.iconPath
  const windowStyle = Number.isInteger(options.windowStyle) ? options.windowStyle : 7
  const lines = [
    'Set sh = CreateObject("WScript.Shell")',
    `Set s = sh.CreateShortcut(${q(lnkPath)})`,
    `s.TargetPath = ${q(target)}`,
    `s.Arguments = ${q(args)}`,
    `s.WorkingDirectory = ${q(workDir)}`,
    `s.WindowStyle = ${windowStyle}`,
    `s.Description = ${q('DSH Server')}`,
  ]
  if (iconPath) lines.push(`s.IconLocation = ${q(iconPath)}`)
  lines.push('s.Save')
  writeText(helper, `${lines.join('\r\n')}\r\n`)
  try {
    const result = spawnSync('cscript.exe', ['//nologo', helper], { windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`could not write shortcut (${result.status ?? 'error'})`)
    }
  } finally {
    removeFile(helper)
  }
}

function removeShortcutHelpers(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || !existsSync(dir)) return
  let names = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (/^_dsh-mkshortcut.*\.vbs$/i.test(name)) removeFile(join(dir, name))
  }
}

function copyIconAsset(dir, name) {
  const dest = join(dir, name)
  const designed = join(dirname(dirname(dir)), 'icons', name)
  if (existsSync(designed)) {
    try { copyFileSync(designed, dest) } catch { /* keep any copy already in dir */ }
  }
  return existsSync(dest) ? dest : null
}

/** Shortcut icon. A .vbs has no icon resource, so the shortcut must not point at it. */
function writePanelIcon(dir) {
  copyIconAsset(dir, 'dsh-server.png')
  copyIconAsset(dir, 'dsh-server.rgba')
  copyIconAsset(dir, 'dsh.png')
  copyIconAsset(dir, 'dsh.rgba')
  const dest = join(dir, 'dsh-server.ico')
  const designed = join(dirname(dirname(dir)), 'icons', 'dsh-server.ico')
  if (existsSync(designed)) {
    try {
      copyFileSync(designed, dest)
      return dest
    } catch { /* fall back below */ }
  }
  try {
    if (existsSync(dest) && statSync(dest).size > 8000) return dest
  } catch { /* regenerate the tiny fallback */ }
  const size = 32
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = ((size - 1 - y) * size + x) * 4
      const dx = x - 15.5
      const dy = y - 15.5
      const r2 = dx * dx + dy * dy
      if (r2 > 14 * 14) continue
      if (r2 <= 5.5 * 5.5) {
        xor[offset] = 0xf7
        xor[offset + 1] = 0xab
        xor[offset + 2] = 0x4d
      } else {
        xor[offset] = 0x2b
        xor[offset + 1] = 0x26
        xor[offset + 2] = 0x25
      }
      xor[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(62)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = size
  header[7] = size
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  const andRow = 4
  const and = Buffer.alloc(andRow * size)
  const imageBytes = 40 + xor.length + and.length
  header.writeUInt32LE(imageBytes, 14)
  header.writeUInt32LE(22, 18)
  header.writeUInt32LE(40, 22)
  header.writeInt32LE(size, 26)
  header.writeInt32LE(size * 2, 30)
  header.writeUInt16LE(1, 34)
  header.writeUInt16LE(32, 36)
  header.writeUInt32LE(xor.length, 42)
  const path = join(dir, 'dsh-server.ico')
  writeFileSync(path, Buffer.concat([header, xor, and]))
  return path
}

/** Write panel launchers and, unless already recorded, a Desktop shortcut. */
function installPanelEntry(node, cli, options = {}) {
  const panelDir = options.panelDir || packagePanelDir(cli)
  const launchers = writePanelLaunchers(panelDir)
  const { kind } = launcherNames()
  const entryName = kind === 'vbs' ? 'DSH-Server.vbs' : 'DSH-Server.sh'
  const entryPath = join(panelDir, entryName)

  const installed = [...launchers]
  const iconPath = writePanelIcon(panelDir)
  const marker = desktopCreatedMarker()
  const forceDesktop = options.forceDesktop === true
  if (!forceDesktop && existsSync(marker)) return installed

  const desk = options.desktopDir || desktopDir()
  if (desk === undefined) return installed
  removeShortcutHelpers(desk)
  mkdirSync(desk, { recursive: true })
  let shortcut = null
  if (process.platform === 'win32') {
    const lnk = join(desk, 'DSH Server.lnk')
    const systemRoot = process.env.SystemRoot
    if (typeof systemRoot === 'string' && systemRoot.length > 0) {
      const scriptHost = join(systemRoot, 'System32', 'wscript.exe')
      writeWindowsShortcut(lnk, scriptHost, `//B //nologo "${entryPath}"`, {
        helperDir: dirname(marker),
        workDir: dirname(panelDir),
        windowStyle: 7,
        iconPath,
      })
      shortcut = lnk
    }
  } else if (process.platform === 'darwin') {
    // An .app runs the script without leaving Terminal open. A .command cannot.
    const dest = join(desk, 'DSH Server.app')
    const macos = join(dest, 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    const bin = join(macos, 'DSH-Server')
    writeText(bin, `#!/bin/sh\nexec /bin/sh ${JSON.stringify(entryPath)}\n`)
    try { chmodSync(bin, 0o755) } catch { /* ignore */ }
    writeText(join(dest, 'Contents', 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>DSH-Server</string>',
      '<key>CFBundleIdentifier</key><string>app.dsh.server</string>',
      '<key>CFBundleName</key><string>DSH Server</string>',
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '</dict></plist>',
      '',
    ].join('\n'))
    shortcut = dest
  } else {
    const dest = join(desk, 'DSH Server.desktop')
    const pkg = dirname(panelDir)
    const pngIcon = join(panelDir, 'dsh-server.png')
    const lines = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DSH Server',
      `Exec=${JSON.stringify(entryPath)}`,
      `Path=${pkg}`,
      'Terminal=false',
    ]
    if (existsSync(pngIcon)) lines.push(`Icon=${pngIcon}`)
    lines.push('')
    writeText(dest, lines.join('\n'))
    try { chmodSync(dest, 0o755) } catch { /* ignore */ }
    shortcut = dest
  }

  if (shortcut !== null) {
    installed.push(shortcut)
    try {
      ensureStateDir(statePaths())
      writeText(marker, `${shortcut}\n`)
    } catch { /* the shortcut exists; remembering it is best-effort */ }
  }

  // Remove legacy five-action desktop launchers and old single files.
  if (desk !== undefined) {
    for (const action of ['start', 'stop', 'restart', 'update-stop', 'update-restart']) {
      for (const legacyExt of ['.vbs', '.command', '.desktop', '.cmd']) {
        removeFile(join(desk, `DSH-${action}${legacyExt}`))
      }
    }
    for (const legacy of ['DSH.vbs', 'DSH.cmd', 'DSH.command', 'DSH.desktop', 'DSH Server.command']) {
      removeFile(join(desk, legacy))
    }
  }
  return installed
}

/** @deprecated use installPanelEntry */
function installDesktopLauncher(node, cli, dir = desktopDir()) {
  return installPanelEntry(node, cli, { desktopDir: dir })
}

function launcherFileName(action, ext = launcherNames().ext) {
  return `DSH-${action}${ext}`
}

function launcherTitle(action) {
  return ({
    start: 'DSH Start',
    stop: 'DSH Stop',
    restart: 'DSH Restart',
    'update-stop': 'DSH Update Stop',
    'update-restart': 'DSH Update Restart',
    panel: 'DSH Server',
  })[action] || `DSH ${action}`
}

function launcherBody(kind, node, cli, action = 'start') {
  if (action === 'panel') return panelLauncherBody(kind)
  if (kind === 'vbs') {
    const command = `"${node}" "${cli}" ${action}`
    return [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "${quoteForVbs(command)}", 0, False`,
      '',
    ].join('\r\n')
  }
  if (kind === 'command') {
    return `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(cli)} ${action}\n`
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${launcherTitle(action)}`,
    `Exec=${JSON.stringify(node)} ${JSON.stringify(cli)} ${action}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n')
}

function sendControl(port, payload, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: DEFAULT_HOST, port })
    let buf = ''
    const finish = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, nl)))
        } catch {
          finish(undefined)
        }
      }
    })
    socket.once('timeout', () => finish(undefined))
    socket.once('error', () => finish(undefined))
  })
}

function startControlServer(onCommand) {
  return net.createServer(socket => {
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let request
      try {
        request = JSON.parse(buf.slice(0, nl))
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'bad json' })}\n`)
        return
      }
      Promise.resolve(onCommand(request)).then(result => {
        socket.end(`${JSON.stringify(result ?? { ok: true })}\n`)
      }).catch(error => {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
      })
    })
  })
}

function listenControl(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListen)
      reject(error)
    }
    const onListen = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListen)
    server.listen(port, DEFAULT_HOST)
  })
}

async function supervisorAlive(layout) {
  const port = controlPort(layout?.port)
  const answer = await sendControl(port, { op: 'ping' }, 2000)
  return answer?.ok === true
}

function launchLooksLikeDsh(layout) {
  const args = Array.isArray(layout?.args) ? layout.args : []
  return webIndex(args) >= 0 || /dsh/i.test(String(layout?.node ?? ''))
}

function fallbackDshLaunch(home) {
  const dsh = lookOnPath('dsh')
  if (dsh === undefined) {
    throw new Error('no captured `dsh web` launch, and `dsh` was not found on PATH')
  }
  return {
    version: LAYOUT_VERSION,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    profile: DEFAULT_PROFILE,
    node: dsh,
    execArgv: [],
    args: ['web', '--no-open'],
    cwd: process.cwd(),
    dshHome: home || resolveHome(),
    nodePid: 0,
    supervisorPid: 0,
  }
}

function resolveLayout(paths, options = {}) {
  const candidate = options.layout || readLayout(paths)
  if (candidate && launchLooksLikeDsh(candidate)) return mergeLayout(paths, candidate)
  return mergeLayout(paths, fallbackDshLaunch(options.home))
}

function mergeLayout(paths, captured) {
  const previous = readLayout(paths) ?? {}
  const next = {
    ...previous,
    ...captured,
    execArgv: Array.isArray(captured.execArgv) ? captured.execArgv : previous.execArgv ?? [],
    args: withNoOpen(captured.args ?? previous.args ?? []),
    node: captured.node || previous.node || process.execPath,
    cwd: captured.cwd || previous.cwd || process.cwd(),
    dshHome: captured.dshHome || previous.dshHome || resolveHome(),
    host: captured.host || previous.host || DEFAULT_HOST,
    port: captured.port || previous.port || DEFAULT_PORT,
    profile: captured.profile || previous.profile || DEFAULT_PROFILE,
    version: LAYOUT_VERSION,
  }
  return writeLayout(paths, next)
}

async function startHostProcess(paths, layout) {
  ensureStateDir(paths)
  if (await isWebListening(layout)) {
    throw new Error(`refusing a second DSH host: port ${layout.port || DEFAULT_PORT} is already listening`)
  }
  const env = envForHost(layout, {
    DSH_REBOOTER_SUPERVISOR: String(process.pid),
  })
  // Keep the log fds open for the life of this supervisor. Closing them right
  // after spawn can invalidate the child's inherited handles on Windows.
  const out = openSync(paths.outLog, 'w')
  const err = openSync(paths.errLog, 'w')
  const child = spawnProcess(layout.node || process.execPath, spawnArgv(layout), {
    cwd: layout.cwd || process.cwd(),
    env,
    detached: true,
    stdio: ['ignore', out, err],
  })
  if (!child.pid) {
    closeSync(out)
    closeSync(err)
    throw new Error('failed to spawn the DSH host')
  }
  // Without unref(), a released supervisor keeps a handle on the living host
  // and never exits — a zombie parent that still looks like "cli.cjs supervisor".
  child.unref()
  writePidFile(paths.nodePid, child.pid)
  writeLayout(paths, { ...layout, nodePid: child.pid, supervisorPid: process.pid })
  return child
}

async function stopRecorded(paths, layout) {
  const nodePid = readPidFile(paths.nodePid) || layout?.nodePid || 0
  const supervisorPid = readPidFile(paths.supervisorPid) || layout?.supervisorPid || 0
  if (pidAlive(nodePid)) await waitPidGone(nodePid, 8000)
  if (pidAlive(supervisorPid) && supervisorPid !== process.pid) await waitPidGone(supervisorPid, 4000)
  removeFile(paths.nodePid)
  removeFile(paths.url)
}

function requestStopFiles(paths) {
  ensureStateDir(paths)
  writeText(paths.stopping, new Date().toISOString())
  removeFile(paths.keepalive)
}

async function requestSupervisorStop(paths, layout) {
  requestStopFiles(paths)
  const alive = await supervisorAlive(layout)
  if (alive) await sendControl(controlPort(layout.port), { op: 'stop' }, 4000)
  await stopRecorded(paths, layout)
  removeFile(paths.stopping)
  removeFile(paths.keepalive)
  removeFile(paths.supervisorPid)
}

function cliPathFromHost() {
  return join(typeof __dirname === 'string' ? __dirname : process.cwd(), 'cli.cjs')
}

function dispatchCli(action, extraArgs = [], options = {}) {
  if (process.env.DSH_REBOOTER_DRY_RUN === '1') {
    return { pid: 0, unref() {} }
  }
  const cli = cliPathFromHost()
  const env = { ...process.env }
  if (typeof options.dshHome === 'string' && options.dshHome.trim()) {
    env.DSH_HOME = options.dshHome.trim()
  }
  return spawnDetached(process.execPath, [cli, action, ...extraArgs], {
    cwd: options.cwd || process.cwd(),
    env,
  })
}

const PROFILE_ROLLBACK_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
])

function profileHomeDir(layout) {
  const home = typeof layout?.dshHome === 'string' && layout.dshHome.trim()
    ? layout.dshHome.trim()
    : resolveHome()
  const profile = typeof layout?.profile === 'string' && layout.profile.trim()
    ? layout.profile.trim()
    : DEFAULT_PROFILE
  return join(home, 'profiles', profile)
}

function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout))
}

function readPackageVersion(pkgPath) {
  if (!existsSync(pkgPath)) return ''
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version.trim() : ''
  } catch {
    return ''
  }
}

function rollbackDir(paths, name) {
  return join(paths.root, 'rollback', name)
}

function clearRollbackDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

function snapshotProfileManifests(paths, layout) {
  const profileDir = profileHomeDir(layout)
  const snapRoot = rollbackDir(paths, 'plugins')
  clearRollbackDir(snapRoot)
  mkdirSync(snapRoot, { recursive: true })
  const saved = []
  for (const name of PROFILE_ROLLBACK_FILES) {
    const src = join(profileDir, name)
    if (!existsSync(src)) continue
    copyFileSync(src, join(snapRoot, name))
    saved.push(name)
  }
  writeJson(join(snapRoot, 'meta.json'), {
    version: 1,
    profileDir,
    saved,
    capturedAt: new Date().toISOString(),
  })
  return { snapRoot, profileDir, saved }
}

async function restoreProfileManifests(paths, snap, env) {
  if (!snap || !Array.isArray(snap.saved) || snap.saved.length === 0) {
    appendJobLog(paths, 'plugin rollback skipped: no profile snapshot')
    return
  }
  appendJobLog(paths, `rolling back profile manifests (${snap.saved.join(', ')})…`)
  mkdirSync(snap.profileDir, { recursive: true })
  for (const name of snap.saved) {
    const src = join(snap.snapRoot, name)
    if (!existsSync(src)) continue
    copyFileSync(src, join(snap.profileDir, name))
  }
  const usePnpm = existsSync(join(snap.profileDir, 'pnpm-lock.yaml'))
    || snap.saved.includes('pnpm-lock.yaml')
  if (usePnpm) {
    await runRecipeStep(paths, {
      tool: 'pnpm',
      args: ['install'],
      cwd: snap.profileDir,
      label: 'pnpm install (plugin rollback)',
    }, env)
  } else if (existsSync(join(snap.profileDir, 'package-lock.json'))) {
    await runRecipeStep(paths, {
      tool: 'npm',
      args: ['install'],
      cwd: snap.profileDir,
      label: 'npm install (plugin rollback)',
    }, env)
  }
}

async function captureGitHead(paths, gitRoot, env) {
  const git = resolveTool('git', env)
  const result = await runLoggedCommand(paths, git, ['rev-parse', 'HEAD'], {
    cwd: gitRoot,
    env,
    label: 'git rev-parse HEAD',
  })
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed (exit ${result.status ?? '?'})`)
  }
  const sha = String(result.stdout || '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`git rev-parse HEAD returned an unexpected value`)
  }
  return sha
}

async function rollbackGitCheckout(paths, gitRoot, env, preSha) {
  appendJobLog(paths, `rolling back git to ${preSha.slice(0, 7)}…`)
  logSupervisor(paths, `rolling back git to ${preSha.slice(0, 7)}`)
  await runRecipeStep(paths, {
    tool: 'git',
    args: ['reset', '--hard', preSha],
    cwd: gitRoot,
    label: `git reset --hard ${preSha.slice(0, 7)}`,
  }, env)
  await runRecipeStep(paths, {
    tool: 'pnpm',
    args: ['install'],
    cwd: gitRoot,
    label: 'pnpm install (git rollback)',
  }, env)
}

async function rollbackNpmDsh(paths, plan, env, preVersion, preLayout) {
  if (!preVersion) {
    appendJobLog(paths, 'npm rollback skipped: no prior @deepseek-ai/dsh version captured')
  } else {
    const step = (plan.steps || [])[0]
    const cwd = step?.cwd || process.cwd()
    const labelBase = plan.scope === 'global' ? 'npm install -g' : (step?.tool === 'pnpm' ? 'pnpm add' : 'npm install')
    appendJobLog(paths, `rolling back ${DSH_PACKAGE} to ${preVersion}…`)
    if (plan.scope === 'global') {
      await runRecipeStep(paths, {
        tool: 'npm',
        args: ['install', '-g', `${DSH_PACKAGE}@${preVersion}`],
        cwd,
        label: `${labelBase} ${DSH_PACKAGE}@${preVersion}`,
      }, env)
    } else if (step?.tool === 'pnpm') {
      await runRecipeStep(paths, {
        tool: 'pnpm',
        args: ['add', `${DSH_PACKAGE}@${preVersion}`],
        cwd,
        label: `${labelBase} ${DSH_PACKAGE}@${preVersion}`,
      }, env)
    } else {
      await runRecipeStep(paths, {
        tool: 'npm',
        args: ['install', `${DSH_PACKAGE}@${preVersion}`],
        cwd,
        label: `${labelBase} ${DSH_PACKAGE}@${preVersion}`,
      }, env)
    }
  }
  if (preLayout) {
    writeLayout(paths, preLayout)
    appendJobLog(paths, 'layout.json restored')
  }
}

async function updatePlugins(paths, layout) {
  const args = pluginUpdateArgs(layout.args)
  const node = layout.node || process.execPath
  const execArgv = Array.isArray(layout.execArgv) ? layout.execArgv : []
  const argv = args === undefined
    ? undefined
    : [...execArgv, ...args]
  logSupervisor(paths, 'updating profile plugins')
  appendJobLog(paths, 'updating profile plugins…')
  const env = envForOneShot(layout)
  const snap = snapshotProfileManifests(paths, layout)
  try {
    let result
    if (argv !== undefined) {
      result = await runLoggedCommand(paths, node, argv, {
        cwd: layout.cwd || process.cwd(),
        env,
        label: 'plugin update',
      })
    } else {
      const dsh = lookOnPath('dsh', env)
      if (dsh === undefined) throw new Error('cannot reconstruct `dsh plugin update`: no launch argv and no dsh on PATH')
      result = await runLoggedCommand(paths, dsh, ['plugin', '--profile', DEFAULT_PROFILE, 'update', '--latest'], {
        cwd: layout.cwd || process.cwd(),
        env,
        label: 'plugin update',
      })
    }
    if (result.status !== 0) {
      throw new Error(`plugin update failed (exit ${result.status ?? '?'})`)
    }
    clearRollbackDir(snap.snapRoot)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      await restoreProfileManifests(paths, snap, env)
      clearRollbackDir(snap.snapRoot)
    } catch (rollbackError) {
      const rb = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`plugin upgrade failed: ${detail}; rollback failed: ${rb}`)
    }
    throw new Error(`plugin upgrade failed (restored to pre-update state): ${detail}`)
  }
}

async function updateDsh(paths, layout) {
  const classified = classifyHarness(layout, harnessFs)
  appendJobLog(paths, `DSH install: ${classified.kind}${classified.npx ? ' (npx)' : ''}`)
  const plan = dshUpdatePlan(layout, classified, harnessFs)
  if (plan.error) throw new Error(plan.error)
  const env = envForOneShot(layout)
  logSupervisor(paths, `updating DSH (${plan.kind})`)
  appendJobLog(paths, `updating DSH (${plan.kind})…`)

  const gitRoot = classified.gitRoot || classified.root
  const preLayout = cloneLayout(readLayout(paths) ?? layout)
  let preSha = ''
  let preNpmVersion = ''
  let headMoved = false
  let mutateStarted = false

  if (plan.kind === 'git') {
    if (!gitRoot) throw new Error('missing git root')
    preSha = await captureGitHead(paths, gitRoot, env)
    appendJobLog(paths, `pre-update HEAD ${preSha.slice(0, 7)}`)
  } else if (plan.kind === 'npm') {
    const cliPkgRoot = classified.cliPkgRoot || classified.root
    preNpmVersion = readPackageVersion(join(cliPkgRoot, 'package.json'))
    if (preNpmVersion) appendJobLog(paths, `pre-update ${DSH_PACKAGE}@${preNpmVersion}`)
  }

  try {
    let pullStdout = ''
    for (const step of plan.steps || []) {
      if (step.optionalUnlessNeeded === true) {
        const decision = gitClientBuildNeeded(gitRoot, harnessFs, pullStdout)
        if (!decision.needed) {
          appendJobLog(paths, `skip ${step.label}: ${decision.reason}`)
          logSupervisor(paths, `skip ${step.label}: ${decision.reason}`)
          continue
        }
        appendJobLog(paths, `build needed: ${decision.reason}`)
      }
      const result = await runRecipeStep(paths, step, env)
      if (step.capturesPull === true) {
        pullStdout = String(result?.stdout ?? '')
        headMoved = gitPullBroughtCommits(pullStdout)
        if (headMoved) mutateStarted = true
      } else if (step.expectEmptyStdout !== true) {
        mutateStarted = true
      }
    }
    if (plan.refreshLayout === true) {
      mutateStarted = true
      return refreshLayoutEntry(paths, layout)
    }
    return layout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!mutateStarted && !headMoved) {
      throw error
    }
    try {
      if (plan.kind === 'git' && preSha) {
        const current = await captureGitHead(paths, gitRoot, env).catch(() => '')
        if (current && current !== preSha) {
          await rollbackGitCheckout(paths, gitRoot, env, preSha)
        } else {
          appendJobLog(paths, 'HEAD unchanged; reinstalling deps to repair node_modules…')
          await runRecipeStep(paths, {
            tool: 'pnpm',
            args: ['install'],
            cwd: gitRoot,
            label: 'pnpm install (repair)',
          }, env)
        }
      } else if (plan.kind === 'npm') {
        await rollbackNpmDsh(paths, plan, env, preNpmVersion, preLayout)
      }
    } catch (rollbackError) {
      const rb = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`upgrade failed: ${detail}; rollback failed: ${rb}`)
    }
    throw new Error(`upgrade failed (restored to pre-update state): ${detail}`)
  }
}

function resolveTool(tool, env) {
  const found = lookOnPath(tool, env) || (process.platform === 'win32' ? lookOnPath(`${tool}.cmd`, env) : undefined)
  if (found === undefined) throw new Error(`${tool} was not found on PATH`)
  return found
}

/** Stream a child process into job.log so the panel can poll progress live. */
function runLoggedCommand(paths, file, args, options = {}) {
  const label = options.label || file
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args || [], {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        windowsHide: true,
        shell: options.shell === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    const onChunk = (chunk, stream) => {
      const text = String(chunk)
      if (stream === 'stdout') stdout += text
      else stderr += text
      lineBuf += text
      const parts = lineBuf.split(/\r?\n/)
      lineBuf = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trimEnd()
        if (trimmed.length === 0) continue
        appendJobLog(paths, trimmed)
        logSupervisor(paths, trimmed)
      }
    }
    child.stdout?.on('data', (chunk) => onChunk(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => onChunk(chunk, 'stderr'))
    child.on('error', reject)
    child.on('close', (status) => {
      if (lineBuf.trim().length > 0) {
        appendJobLog(paths, lineBuf.trimEnd())
        logSupervisor(paths, lineBuf.trimEnd())
      }
      resolve({ status: status ?? 1, stdout, stderr, label })
    })
  })
}

async function runRecipeStep(paths, step, env) {
  appendJobLog(paths, step.label || `${step.tool} ${(step.args || []).join(' ')}`)
  logSupervisor(paths, step.label || step.tool)
  const file = resolveTool(step.tool, env)
  const result = await runLoggedCommand(paths, file, step.args || [], {
    cwd: step.cwd || process.cwd(),
    env,
    shell: process.platform === 'win32' && /\.cmd$/i.test(file),
    label: step.label || step.tool,
  })
  if (step.expectEmptyStdout === true) {
    const porcelain = String(result.stdout ?? '').trim()
    if (result.status !== 0) {
      throw new Error(`${step.label || step.tool} failed (exit ${result.status ?? '?'})`)
    }
    if (porcelain.length > 0) {
      throw new Error('git working tree is dirty; commit or stash before updating DSH')
    }
    return result
  }
  if (result.status !== 0) {
    const combined = `${result.stderr || ''}\n${result.stdout || ''}`
    const lines = combined.trim().split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
    const interesting = lines.filter((line) => /error TS|\berror\b:|ERR!/i.test(line)).slice(-12)
    const detail = (interesting.length > 0 ? interesting : lines.slice(-8)).join('\n')
    throw new Error(
      detail
        ? `${step.label || step.tool} failed (exit ${result.status ?? '?'}):\n${detail}`
        : `${step.label || step.tool} failed (exit ${result.status ?? '?'})`,
    )
  }
  return result
}

function refreshLayoutEntry(paths, layout) {
  const node = layout.node || process.execPath
  const env = envForOneShot(layout)
  const roots = []
  if (typeof layout.cwd === 'string' && layout.cwd.trim()) roots.push(layout.cwd.trim())
  try {
    const npm = resolveTool('npm', env)
    const rootRun = spawnSync(npm, ['root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.cmd$/i.test(npm),
      env,
    })
    if (rootRun.status === 0) {
      const globalRoot = String(rootRun.stdout || '').trim()
      if (globalRoot) roots.push(globalRoot)
    }
  } catch { /* optional */ }
  const probe = `
    const { createRequire } = require('node:module');
    const { dirname, join } = require('node:path');
    const roots = ${JSON.stringify(roots)};
    let last = '';
    for (const root of roots) {
      try {
        const req = createRequire(join(root, 'package.json'));
        const pkg = req.resolve(${JSON.stringify(`${DSH_PACKAGE}/package.json`)});
        process.stdout.write(join(dirname(pkg), 'lib', 'bin.js'));
        process.exit(0);
      } catch (error) {
        last = String(error && error.message || error);
      }
    }
    process.stderr.write(last || 'not found');
    process.exit(1);
  `
  const result = spawnSync(node, ['-e', probe], {
    cwd: layout.cwd || process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`cannot resolve ${DSH_PACKAGE} after upgrade: ${(result.stderr || '').trim() || 'unknown error'}`)
  }
  const nextEntry = String(result.stdout || '').trim()
  if (!nextEntry || !existsSync(nextEntry)) {
    throw new Error(`resolved ${DSH_PACKAGE} entry is missing after upgrade`)
  }
  const args = Array.isArray(layout.args) ? layout.args.slice() : []
  if (args[0] === nextEntry) return layout
  args[0] = nextEntry
  const next = {
    ...layout,
    args: withNoOpen(args),
    execArgv: [],
  }
  writeLayout(paths, next)
  appendJobLog(paths, `layout entry → ${nextEntry}`)
  return next
}

function resetAppWebViewData(paths) {
  // Prefer rotating the profile directory: Windows WebView2 often keeps locks
  // on the active `app/` tree, so rmSync fails with EPERM and the next open
  // reuses a poisoned SPA cache (sidebar ok, conversation blank).
  const genPath = join(paths.root, 'app.gen')
  let gen = Number.parseInt(String(readText(genPath) || '0'), 10)
  if (!Number.isFinite(gen) || gen < 0) gen = 0
  gen += 1
  writeText(genPath, `${gen}\n`)
  const keep = `app-${gen}`
  mkdirSync(join(paths.root, keep), { recursive: true })
  appendJobLog(paths, `page window profile → ${keep}`)
  for (const name of readdirSync(paths.root)) {
    if (name === keep || name === 'app.gen') continue
    if (name === 'app' || /^app-\d+$/.test(name)) {
      try {
        rmSync(join(paths.root, name), { recursive: true, force: true })
      } catch (error) {
        logSupervisor(paths, `app cache clear ${name}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }
  return join(paths.root, keep)
}

function currentAppDataDir(paths) {
  const gen = Number.parseInt(String(readText(join(paths.root, 'app.gen')) || '0'), 10)
  if (Number.isFinite(gen) && gen > 0) {
    const dir = join(paths.root, `app-${gen}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const fallback = join(paths.root, 'app')
  mkdirSync(fallback, { recursive: true })
  return fallback
}

async function ensureSupervisor(paths, layout, cliFile) {
  if (process.env.DSH_REBOOTER_DRY_RUN === '1') return true
  if (await supervisorAlive(layout)) return true
  const cli = cliFile || cliPathFromHost()
  const env = envForHost(layout)
  spawnDetached(process.execPath, [cli, 'supervisor'], {
    cwd: layout.cwd || process.cwd(),
    env,
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await supervisorAlive(layout)) return true
    await sleep(200)
  }
  return supervisorAlive(layout)
}

async function releaseSupervisor(layout) {
  if (process.env.DSH_REBOOTER_DRY_RUN === '1') return true
  if (!(await supervisorAlive(layout))) return true
  const answer = await sendControl(controlPort(layout.port), { op: 'release' }, 4000)
  if (answer?.ok !== true) return false
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (!(await supervisorAlive(layout))) return true
    await sleep(100)
  }
  return !(await supervisorAlive(layout))
}

/**
 * Make the calling long-lived process (the DSH Host) own the supervisor.
 * A supervisor spawned by a short-lived CLI can be Job-killed when that CLI
 * exits; releasing it and re-spawning from the Host does not touch DSH.
 */
async function adoptSupervisor(paths, layout, cliFile) {
  if (process.env.DSH_REBOOTER_DRY_RUN === '1') return true
  const port = controlPort(layout.port)

  // Mount races the supervisor's listen(); retry ping before deciding.
  let beforePid = 0
  for (let i = 0; i < 30; i++) {
    const before = await sendControl(port, { op: 'ping' }, 1500)
    if (before?.ok) {
      beforePid = Number(before.pid) || 0
      if (beforePid > 0) break
    }
    await sleep(100)
  }

  if (beforePid > 0 || await supervisorAlive(layout)) {
    logSupervisor(paths, `adopting: releasing supervisor pid=${beforePid || '?'}`)
    const released = await releaseSupervisor(layout)
    if (!released) {
      logSupervisor(paths, 'supervisor release timed out; refusing to disturb host')
      // Keep whatever is still listening — never signal DSH to "heal".
      return supervisorAlive(layout)
    }
    const freeDeadline = Date.now() + 5000
    while (Date.now() < freeDeadline && await supervisorAlive(layout)) await sleep(50)
  }

  if (await supervisorAlive(layout)) {
    logSupervisor(paths, 'adopting: control port still busy after release')
    return false
  }

  const cli = cliFile || cliPathFromHost()
  const env = envForHost(layout)
  spawnDetached(process.execPath, [cli, 'supervisor'], {
    cwd: layout.cwd || process.cwd(),
    env,
  })

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const after = await sendControl(port, { op: 'ping' }, 2000)
    if (after?.ok === true && Number(after.pid) !== beforePid) {
      logSupervisor(paths, `supervisor adopted by pid=${process.pid} supervisor=${after.pid}`)
      return true
    }
    await sleep(200)
  }
  logSupervisor(paths, 'supervisor adopt failed: new supervisor did not come online')
  return false
}

async function requestHostAdoptSupervisor(layout) {
  const host = layout?.host || DEFAULT_HOST
  const port = Number(layout?.port) || DEFAULT_PORT
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10000)
  try {
    const response = await fetch(`http://${host}:${port}/api/dsh-rebooter/ensure-supervisor`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true && body?.supervisor === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function jobLockPath(paths) {
  return join(paths.root, 'job.lock')
}

function releaseJob(paths) {
  removeFile(jobLockPath(paths))
}

function claimJob(paths) {
  if (readJob(paths).state === 'busy') return false
  const lock = jobLockPath(paths)
  const tryCreate = () => {
    closeSync(openSync(lock, 'wx'))
  }
  try {
    tryCreate()
    return true
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
    let stale = false
    try { stale = readJob(paths).state !== 'busy' && Date.now() - statSync(lock).mtimeMs > 30000 } catch { stale = true }
    if (!stale) return false
    removeFile(lock)
    try { tryCreate() } catch { return false }
    return true
  }
}

async function performAction(action, options = {}) {
  if (!isAction(action)) throw new Error(`unknown action ${JSON.stringify(action)}`)
  const paths = ensureStateDir(statePaths(options.home))
  const trackJob = options.trackJob !== false
  if (trackJob && !claimJob(paths)) throw new Error('busy')

  try {
    const layout = resolveLayout(paths, options)
    const fromHost = options.fromHost === true
    const prefs = readPanelPrefs(paths)
    const open = shouldOpenUi(action, options, prefs)
    /** Set when a *-restart upgrade fails but we still attempt to bring the host back. */
    let updateError = null
    if (trackJob) beginJob(paths, action, `running ${action}`)
    if (fromHost && action !== 'start') await sleep(400)
    if (action === 'open') {
      const result = await openDshUiAsync(paths, layout, { resetCache: true })
      if (trackJob) endJob(paths, 'ok', 'UI opened')
      return { ok: true, action, ...result }
    }

    if (action === 'update') {
      if (await isWebListening(layout)) {
        throw new Error('stop DSH before updating plugins (or use update-stop / update-restart)')
      }
      await updatePlugins(paths, readLayout(paths) ?? layout)
      if (trackJob) endJob(paths, 'ok', 'plugin update finished')
      return { ok: true, action }
    }

    if (action === 'update-dsh') {
      if (await isWebListening(layout)) {
        throw new Error('stop DSH before updating the harness (or use update-dsh-stop / update-dsh-restart)')
      }
      await requestAppWindowClose(layout)
      await sleep(300)
      await updateDsh(paths, readLayout(paths) ?? layout)
      resetAppWebViewData(paths)
      if (trackJob) endJob(paths, 'ok', 'DSH update finished')
      return { ok: true, action }
    }

    const stops = action === 'stop' || action === 'restart'
      || action === 'update-stop' || action === 'update-restart'
      || action === 'update-dsh-stop' || action === 'update-dsh-restart'
    if (stops) {
      // Always close the page window before tearing the host down. Leaving it
      // open across a restart/update leaves a half-dead SPA (blank conversation).
      await requestAppWindowClose(layout)
      // WebView2 releases profile locks shortly after close; then drop the
      // persistent cache so the next open does a clean token→cookie→/ hop.
      await sleep(300)
      resetAppWebViewData(paths)
      appendJobLog(paths, 'stopping DSH…')
      await requestSupervisorStop(paths, layout)
    }

    if (action === 'update-stop' || action === 'update-restart') {
      try {
        await updatePlugins(paths, readLayout(paths) ?? layout)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (action !== 'update-restart') {
          throw new Error(`service stopped; plugin upgrade failed: ${detail}`)
        }
        appendJobLog(paths, `plugin upgrade failed after restore; still restarting: ${detail}`)
        logSupervisor(paths, `plugin upgrade failed after restore; still restarting: ${detail}`)
        updateError = detail
      }
    }

    if (action === 'update-dsh-stop' || action === 'update-dsh-restart') {
      try {
        await updateDsh(paths, readLayout(paths) ?? layout)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (action !== 'update-dsh-restart') {
          throw new Error(`service stopped; DSH upgrade failed: ${detail}`)
        }
        appendJobLog(paths, `DSH upgrade failed after restore; still restarting: ${detail}`)
        logSupervisor(paths, `DSH upgrade failed after restore; still restarting: ${detail}`)
        updateError = detail
      }
    }

    if (action === 'start' || action === 'restart'
      || action === 'update-restart' || action === 'update-dsh-restart') {
      removeFile(paths.stopping)
      const liveLayout = readLayout(paths) ?? layout
      const listening = await isWebListening(liveLayout)
      if (listening && action === 'start') {
        let ok = await requestHostAdoptSupervisor(liveLayout)
        if (!ok) ok = await ensureSupervisor(paths, liveLayout, options.cliFile)
        if (!ok) throw new Error('supervisor did not start')
        const url = await waitWebReady(paths, liveLayout, Math.min(options.timeoutMs ?? 120000, 15000))
        if (url === undefined) throw new Error('DSH did not become ready')
        if (open) await openDshUiAsync(paths, liveLayout, { resetCache: true })
        if (trackJob) endJob(paths, 'ok', 'already running')
        return { ok: true, action, url, skipped: true }
      }
      appendJobLog(paths, 'starting host…')
      try {
        const ok = await ensureSupervisor(paths, liveLayout, options.cliFile)
        if (!ok) throw new Error('supervisor did not start')
        const url = await waitWebReady(paths, liveLayout, options.timeoutMs ?? 120000)
        if (url === undefined) throw new Error('DSH did not become ready')
        if (open) await openDshUiAsync(paths, liveLayout, { resetCache: true })
        if (updateError) {
          const message = `service restored; upgrade failed: ${updateError}`
          if (trackJob) endJob(paths, 'error', 'service restored; upgrade failed', updateError)
          const err = new Error(message)
          err.code = 'UPDATE_FAILED_SERVICE_RESTORED'
          throw err
        }
        if (trackJob) endJob(paths, 'ok', 'ready')
        return { ok: true, action, url }
      } catch (error) {
        if (updateError && error?.code !== 'UPDATE_FAILED_SERVICE_RESTORED') {
          const startDetail = error instanceof Error ? error.message : String(error)
          throw new Error(`upgrade failed and service did not start: upgrade=${updateError}; start=${startDetail}`)
        }
        throw error
      }
    }

    if (trackJob) endJob(paths, 'ok', 'done')
    return { ok: true, action }
  } catch (error) {
    if (trackJob && error?.code !== 'UPDATE_FAILED_SERVICE_RESTORED') {
      endJob(paths, 'error', 'failed', error instanceof Error ? error.message : String(error))
    }
    throw error
  } finally {
    if (trackJob) releaseJob(paths)
  }
}

async function runSupervisor(options = {}) {
  const paths = ensureStateDir(statePaths(options.home))
  const layout = resolveLayout(paths, options)
  const port = controlPort(layout.port)
  let stopRequested = existsSync(paths.stopping)
  let leaveHost = false
  let childProc

  const server = startControlServer(async (request) => {
    if (request?.op === 'ping') {
      return { ok: true, pid: process.pid, port: layout.port }
    }
    if (request?.op === 'status') {
      return {
        ok: true,
        pid: process.pid,
        nodePid: readPidFile(paths.nodePid),
        stopping: existsSync(paths.stopping),
        leaveHost,
      }
    }
    if (request?.op === 'release') {
      // Host is taking ownership. Exit without signalling the DSH process.
      leaveHost = true
      stopRequested = true
      return { ok: true }
    }
    if (request?.op === 'stop') {
      stopRequested = true
      leaveHost = false
      requestStopFiles(paths)
      const nodePid = readPidFile(paths.nodePid)
      if (childProc && !childProc.killed) {
        try { childProc.kill('SIGTERM') } catch { /* already gone */ }
      } else if (pidAlive(nodePid)) {
        killPid(nodePid, 'SIGTERM')
      }
      return { ok: true }
    }
    return { ok: false, error: 'unknown op' }
  })

  try {
    await listenControl(server, port)
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      logSupervisor(paths, 'supervisor already running (control port in use)')
      return { ok: true, skipped: true }
    }
    throw error
  }

  // No process.title — renaming the process under a console is what made a
  // "dsh-rebooter-supervisor" tab appear. With windowsHide + stdio ignore
  // there should be no console; do not advertise one either.
  writePidFile(paths.supervisorPid, process.pid)
  removeFile(paths.stopping)
  writeText(paths.keepalive, new Date().toISOString())
  logSupervisor(paths, `supervisor online pid=${process.pid} control=${port}`)

  let generation = 0
  try {
    while (!stopRequested && !existsSync(paths.stopping)) {
      writeText(paths.keepalive, new Date().toISOString())
      const current = readLayout(paths) ?? layout
      const existingPid = readPidFile(paths.nodePid) || current.nodePid || 0
      if (pidAlive(existingPid) && existingPid !== process.pid) {
        logSupervisor(paths, `watching existing host pid=${existingPid}`)
        while (
          pidAlive(existingPid)
          && !stopRequested
          && !existsSync(paths.stopping)
        ) {
          await sleep(500)
          writeText(paths.keepalive, new Date().toISOString())
        }
        if (stopRequested || existsSync(paths.stopping)) break
        logSupervisor(paths, `host pid=${existingPid} exited; restarting`)
      } else if (await isWebListening(current)) {
        // Port held but our pid file is stale/empty — never spawn a twin host.
        logSupervisor(paths, `web port ${current.port || DEFAULT_PORT} is busy without a recorded pid; waiting`)
        while (
          await isWebListening(current)
          && !stopRequested
          && !existsSync(paths.stopping)
        ) {
          await sleep(1000)
          writeText(paths.keepalive, new Date().toISOString())
        }
        if (stopRequested || existsSync(paths.stopping)) break
      } else {
        try {
          childProc = await startHostProcess(paths, current)
          generation = 0
          logSupervisor(paths, `host started pid=${childProc.pid}`)
          // Poll so `release` can interrupt without waiting for the host to exit.
          while (
            childProc.exitCode === null
            && !stopRequested
            && !existsSync(paths.stopping)
          ) {
            await sleep(500)
            writeText(paths.keepalive, new Date().toISOString())
          }
          childProc = undefined
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logSupervisor(paths, `host start failed: ${message}`)
        }
      }
      if (stopRequested || existsSync(paths.stopping)) break
      generation += 1
      await sleep(backoffDelay(generation))
    }
  } finally {
    if (!leaveHost) {
      const nodePid = readPidFile(paths.nodePid)
      if (childProc && !childProc.killed) {
        try { childProc.kill('SIGTERM') } catch { /* ignore */ }
        await waitPidGone(childProc.pid, 6000)
      } else if (pidAlive(nodePid)) {
        await waitPidGone(nodePid, 6000)
      }
    }
    server.close()
    removeFile(paths.supervisorPid)
    removeFile(paths.keepalive)
    if (!leaveHost) removeFile(paths.stopping)
    logSupervisor(paths, leaveHost
      ? 'supervisor released (host kept)'
      : 'supervisor shutting down')
  }
  return { ok: true }
}

export {
  adoptSupervisor,
  appendJobLog,
  beginJob,
  cliPathFromHost,
  desktopCreatedMarker,
  desktopDir,
  writePanelLaunchers,
  dispatchCli,
  endJob,
  ensureStateDir,
  ensureSupervisor,
  envForHost,
  envForOneShot,
  installDesktopLauncher,
  installPanelEntry,
  isWebListening,
  isTokenizedWebUrl,
  killPid,
  launcherBody,
  launcherFileName,
  launcherNames,
  listenControl,
  logSupervisor,
  lookOnPath,
  mergeLayout,
  openDshUi,
  openDshUiAsync,
  openUrl,
  packagePanelDir,
  performAction,
  pidAlive,
  probeHttp,
  readJob,
  readLayout,
  readPanelPrefs,
  readPidFile,
  readText,
  readWebUrl,
  releaseSupervisor,
  removeFile,
  requestHostAdoptSupervisor,
  requestStopFiles,
  requestSupervisorStop,
  resetAppWebViewData,
  currentAppDataDir,
  resolveHome,
  runSupervisor,
  sendControl,
  sleep,
  spawnDetached,
  spawnProcess,
  startControlServer,
  startHostProcess,
  statePaths,
  supervisorAlive,
  updatePlugins,
  updateDsh,
  waitPidGone,
  waitWebReady,
  writeJob,
  writeLayout,
  writePanelPrefs,
  writePidFile,
  writeText,
}
