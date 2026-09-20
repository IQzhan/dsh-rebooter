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
  ALL_ACTIONS, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROFILE, LAYOUT_VERSION, STATE_DIR_NAME,
  availableActions, backoffDelay, captureLaunch, canonicalUrl, controlPort, defaultPanelPrefs,
  idleJob, isAction, isPidAlive, panelPort, parseWebUrl, pluginUpdateArgs, shouldOpenUi,
  spawnArgv, webIndex, withNoOpen,
} from './dsh-rebooter-core.js'
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

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
  const prefs = readPanelPrefs(paths)
  const url = readWebUrl(paths, layout)
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('DSH URL is not available yet')
  }
  if (prefs.openApp) {
    spawnDetached(prefs.openApp, [url])
    return { ok: true, url, app: prefs.openApp }
  }
  const cli = cliPathFromHost()
  spawnDetached(process.execPath, [cli, 'app'])
  return { ok: true, url, app: null }
}

async function requestAppWindowClose(layout) {
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 800)
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

function envForHost(layout, extra = {}, readOsUser = readOsUserNodeOptions) {
  // Parent environment is copied, not interpreted. Proxy variables stay as the
  // parent left them. A missing NODE_OPTIONS is filled from plugin-owned
  // sources first, then (Windows only) the OS user environment. Never invent.
  const env = { ...process.env, ...extra }
  if (typeof layout?.dshHome === 'string' && layout.dshHome.trim().length > 0) {
    env.DSH_HOME = layout.dshHome.trim()
  }
  return fillMissingNodeOptions(env, readOsUser)
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
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function readWebUrl(paths, layout) {
  // Prefer the log's tokenized URL over a bare `web.url` — a 401 on `/` means
  // the server is up, but opening / saving the bare origin is not useful.
  const fromLog = parseWebUrl(readText(paths.outLog) ?? '')
  if (fromLog) return fromLog
  const fromFile = readText(paths.url)?.trim()
  if (fromFile) return fromFile
  return canonicalUrl(layout, '/')
}

async function waitWebReady(paths, layout, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = readWebUrl(paths, layout)
    if (await probeHttp(url, 3000)) {
      writeText(paths.url, url)
      return url
    }
    if (await isWebListening(layout)) {
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

function packagePanelDir(cli = cliPathFromHost()) {
  return join(dirname(cli), '..', 'panel')
}

function writeWindowsShortcut(lnkPath, target, args, options = {}) {
  // Helper stays beside the package entry, never on the Desktop.
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

/** Write the single DSH Server entry under package/panel and a Desktop shortcut. */
function installPanelEntry(node, cli, options = {}) {
  const panelDir = options.panelDir || packagePanelDir(cli)
  mkdirSync(panelDir, { recursive: true })
  const { kind, ext } = launcherNames()
  const entryExt = kind === 'desktop' ? '.sh' : ext
  const entryName = `DSH-Server${entryExt}`
  const entryPath = join(panelDir, entryName)
  writeText(entryPath, panelLauncherBody(kind))
  if (kind === 'command' || kind === 'desktop') {
    try { chmodSync(entryPath, 0o755) } catch { /* best-effort */ }
  }

  const installed = [entryPath]
  const iconPath = writePanelIcon(panelDir)
  const desk = options.desktopDir || desktopDir()
  if (desk !== undefined) {
    removeShortcutHelpers(desk)
    mkdirSync(desk, { recursive: true })
    if (process.platform === 'win32') {
      const lnk = join(desk, 'DSH Server.lnk')
      const systemRoot = process.env.SystemRoot
      if (typeof systemRoot === 'string' && systemRoot.length > 0) {
        const scriptHost = join(systemRoot, 'System32', 'wscript.exe')
        writeWindowsShortcut(lnk, scriptHost, `//B //nologo "${entryPath}"`, {
          helperDir: panelDir,
          workDir: dirname(panelDir),
          windowStyle: 7,
          iconPath,
        })
        installed.push(lnk)
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
      installed.push(dest)
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
      installed.push(dest)
    }
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
  const env = envForHost(layout, {
    DSH_REBOOTER_SUPERVISOR: String(process.pid),
  })
  const out = openSync(paths.outLog, 'w')
  const err = openSync(paths.errLog, 'w')
  try {
    const child = spawnProcess(layout.node || process.execPath, spawnArgv(layout), {
      cwd: layout.cwd || process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', out, err],
    })
    if (!child.pid) throw new Error('failed to spawn the DSH host')
    // Without unref(), a released supervisor keeps a handle on the living host
    // and never exits — a zombie parent that still looks like "cli.cjs supervisor".
    child.unref()
    writePidFile(paths.nodePid, child.pid)
    writeLayout(paths, { ...layout, nodePid: child.pid, supervisorPid: process.pid })
    return child
  } finally {
    closeSync(out)
    closeSync(err)
  }
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

function dispatchCli(action, extraArgs = []) {
  if (process.env.DSH_REBOOTER_DRY_RUN === '1') {
    return { pid: 0, unref() {} }
  }
  const cli = cliPathFromHost()
  return spawnDetached(process.execPath, [cli, action, ...extraArgs], {
    cwd: process.cwd(),
    env: process.env,
  })
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
  let result
  if (argv !== undefined) {
    result = spawnSync(node, argv, {
      cwd: layout.cwd || process.cwd(),
      env,
      encoding: 'utf8',
      windowsHide: true,
    })
  } else {
    const dsh = lookOnPath('dsh', env)
    if (dsh === undefined) throw new Error('cannot reconstruct `dsh plugin update`: no launch argv and no dsh on PATH')
    result = spawnSync(dsh, ['plugin', '--profile', DEFAULT_PROFILE, 'update', '--latest'], {
      cwd: layout.cwd || process.cwd(),
      env,
      encoding: 'utf8',
      windowsHide: true,
    })
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (output) {
    const tail = output.trim().split('\n').slice(-40)
    logSupervisor(paths, tail.join('\n'))
    for (const line of tail) appendJobLog(paths, line)
  }
  if (result.status !== 0) {
    throw new Error(`plugin update failed (exit ${result.status ?? '?'})`)
  }
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
    if (trackJob) beginJob(paths, action, `running ${action}`)
    if (fromHost && action !== 'start') await sleep(400)
    if (action === 'open') {
      const result = openDshUi(paths, layout)
      if (trackJob) endJob(paths, 'ok', 'UI opened')
      return { ok: true, action, ...result }
    }

    if (action === 'update') {
      await updatePlugins(paths, readLayout(paths) ?? layout)
      if (trackJob) endJob(paths, 'ok', 'update finished')
      return { ok: true, action }
    }

    if (action === 'stop' || action === 'restart' || action === 'update-stop' || action === 'update-restart') {
      if (action === 'stop' || action === 'update-stop') await requestAppWindowClose(layout)
      appendJobLog(paths, 'stopping DSH…')
      await requestSupervisorStop(paths, layout)
    }

    if (action === 'update-stop' || action === 'update-restart') {
      await updatePlugins(paths, readLayout(paths) ?? layout)
    }

    if (action === 'start' || action === 'restart' || action === 'update-restart') {
      removeFile(paths.stopping)
      const listening = await isWebListening(layout)
      if (listening && action === 'start') {
        let ok = await requestHostAdoptSupervisor(layout)
        if (!ok) ok = await ensureSupervisor(paths, layout, options.cliFile)
        if (!ok) throw new Error('supervisor did not start')
        const url = await waitWebReady(paths, layout, Math.min(options.timeoutMs ?? 120000, 15000))
          ?? readWebUrl(paths, layout)
        if (open) openDshUi(paths, layout)
        if (trackJob) endJob(paths, 'ok', 'already running')
        return { ok: true, action, url, skipped: true }
      }
      appendJobLog(paths, 'starting host…')
      const ok = await ensureSupervisor(paths, layout, options.cliFile)
      if (!ok) throw new Error('supervisor did not start')
      const url = await waitWebReady(paths, layout, options.timeoutMs ?? 120000)
      if (url === undefined) throw new Error('DSH did not become ready')
      if (open) openDshUi(paths, layout)
      if (trackJob) endJob(paths, 'ok', 'ready')
      return { ok: true, action, url }
    }

    if (trackJob) endJob(paths, 'ok', 'done')
    return { ok: true, action }
  } catch (error) {
    if (trackJob) {
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
  desktopDir,
  dispatchCli,
  endJob,
  ensureStateDir,
  ensureSupervisor,
  envForHost,
  envForOneShot,
  installDesktopLauncher,
  installPanelEntry,
  isWebListening,
  killPid,
  launcherBody,
  launcherFileName,
  launcherNames,
  listenControl,
  logSupervisor,
  lookOnPath,
  mergeLayout,
  openDshUi,
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
  requestHostAdoptSupervisor,
  requestStopFiles,
  requestSupervisorStop,
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
  waitPidGone,
  waitWebReady,
  writeJob,
  writeLayout,
  writePanelPrefs,
  writePidFile,
}
