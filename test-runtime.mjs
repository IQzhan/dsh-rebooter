import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginJob, desktopCreatedMarker, endJob, ensureStateDir, envForHost, envForOneShot, installPanelEntry, isWebListening,
  killPid, launcherBody, launcherFileName, launcherNames, listenControl, lookOnPath, mergeLayout,
  performAction, pidAlive, probeHttp, readJob, readLayout, readPanelPrefs, readPidFile, requestStopFiles,
  resolveHome, sendControl, sleep, spawnProcess, startControlServer, statePaths, writePanelPrefs,
  writePidFile,
} from './dsh-rebooter-runtime.js'
import { cleanup, scratch } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const home = scratch('runtime-')
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

try {
  check('resolveHome prefers DSH_HOME', resolveHome({ DSH_HOME: home }), home)
  check('empty DSH_HOME is unset', resolveHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true)

  const paths = ensureStateDir(statePaths(home))
  check('state lives under DSH_HOME/rebooter', paths.root, join(home, 'rebooter'))
  check('the directory exists', existsSync(paths.root), true)

  const layout = mergeLayout(paths, {
    node: process.execPath,
    args: ['-e', 'setInterval(()=>{}, 999999)'],
    execArgv: [],
    cwd: home,
    dshHome: home,
    host: '127.0.0.1',
    port: 37851,
    nodePid: 0,
  })
  check('layout round-trips', readLayout(paths).port, 37851)
  writePidFile(paths.nodePid, 4242)
  check('pid file parses', readPidFile(paths.nodePid), 4242)

  requestStopFiles(paths)
  check('stop writes the stopping file', existsSync(paths.stopping), true)

  const env = envForOneShot(layout)
  check('one-shot still has DSH_HOME', env.DSH_HOME, home)

  const previousHttps = process.env.HTTPS_PROXY
  const previousNodeOptions = process.env.NODE_OPTIONS
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
  process.env.NODE_OPTIONS = '--require missing-on-purpose.cjs'
  const hostEnv = envForHost({ dshHome: home })
  const oneShot = envForOneShot({ dshHome: home })
  check('host does not rewrite HTTPS_PROXY', hostEnv.HTTPS_PROXY, 'http://127.0.0.1:9')
  check('host does not rewrite NODE_OPTIONS', hostEnv.NODE_OPTIONS, '--require missing-on-purpose.cjs')
  check('one-shot does not strip NODE_OPTIONS', oneShot.NODE_OPTIONS, '--require missing-on-purpose.cjs')
  if (previousHttps === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = previousHttps
  delete process.env.NODE_OPTIONS
  const restored = envForHost({ dshHome: home }, {}, () => '--require from-user.cjs')
  check('missing NODE_OPTIONS is restored from the OS user environment', restored.NODE_OPTIONS, '--require from-user.cjs')
  const parentWins = envForHost({ dshHome: home }, { NODE_OPTIONS: '--require parent.cjs' }, () => '--require from-user.cjs')
  check('an explicit NODE_OPTIONS is not replaced', parentWins.NODE_OPTIONS, '--require parent.cjs')
  const blank = envForHost({ dshHome: home }, {}, () => '  ')
  check('a blank OS user NODE_OPTIONS stays absent', blank.NODE_OPTIONS, undefined)
  writeFileSync(join(home, 'rebooter', 'node-options'), '# comment\n--require from-file.cjs\n', 'utf8')
  const fromFile = envForHost({ dshHome: home }, {}, () => '--require from-user.cjs')
  check('plugin node-options file wins over the OS user environment', fromFile.NODE_OPTIONS, '--require from-file.cjs')
  const fromPluginEnv = envForHost(
    { dshHome: home },
    { DSH_NODE_OPTIONS: '--require from-env.cjs' },
    () => '--require from-user.cjs',
  )
  check('DSH_NODE_OPTIONS wins over the plugin file', fromPluginEnv.NODE_OPTIONS, '--require from-env.cjs')
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = previousNodeOptions

  check('lookOnPath finds node', typeof lookOnPath('node') === 'string' || lookOnPath('node.exe') !== undefined, true)

  const names = launcherNames()
  const body = launcherBody(names.kind, '/bin/node', '/opt/cli.cjs', 'start')
  check('launcher names the start verb', body.includes(' start') || body.includes('"start"') || /\sstart(?:\n|"|,)/.test(body), true)
  check('launcher does not pass --no-open', body.includes('--no-open'), false)
  check('launcher does not embed a machine Desktop path in source form', /[A-Za-z]:\\/.test(body), false)
  check('launcher file uses the platform suffix', launcherFileName('start').endsWith(names.ext), true)

  const vbsUpdate = launcherBody('vbs', 'C:\\Program Files\\nodejs\\node.exe', 'D:\\cli.cjs', 'update-restart')
  check('vbs keeps update-restart inside one Run string',
    /"" update-restart", 0, False/.test(vbsUpdate), true)
  check('vbs separates quoted paths with space not triple-quote',
    vbsUpdate.includes('"" ""') && !vbsUpdate.includes('"" """'), true)

  const fakeDesktop = join(home, 'Desktop')
  ensureStateDir({ root: fakeDesktop })
  const panelDir = join(home, 'package-panel')
  const installed = installPanelEntry(process.execPath, join(home, 'cli.cjs'), {
    panelDir,
    desktopDir: fakeDesktop,
  })
  check('desktop installer returns paths', Array.isArray(installed) && installed.length >= 1, true)
  check('every installed path exists', installed.every(path => existsSync(path)), true)
  check('package panel entry invokes panel',
    readFileSync(installed.find(p => p.includes('DSH-Server')), 'utf8').includes(' panel'), true)
  const vbsPath = installed.find(p => p.endsWith('.vbs')) || join(panelDir, 'DSH-Server.vbs')
  const vbs = readFileSync(vbsPath, 'utf8')
  check('panel vbs hides the node console', /", 0, False/.test(vbs), true)
  check('panel vbs locates cli from its own folder', vbs.includes('ScriptFullName') && vbs.includes('cli.cjs'), true)
  check('panel vbs does not bake a drive path', /[A-Za-z]:\\/.test(vbs), false)
  check('shortcut helper is not left on the desktop', existsSync(join(fakeDesktop, '_dsh-mkshortcut.vbs')), false)
  check('panel icon is a real file', existsSync(join(panelDir, 'dsh-server.ico')), true)
  check('legacy five-action launchers are not created',
    !existsSync(join(fakeDesktop, 'DSH-start.vbs'))
      && !existsSync(join(fakeDesktop, 'DSH-start.command'))
      && !existsSync(join(fakeDesktop, 'DSH-start.desktop')), true)
  check('legacy single DSH launcher is removed', existsSync(join(fakeDesktop, 'DSH.vbs')) || existsSync(join(fakeDesktop, 'DSH.cmd')), false)
  const shortcutName = process.platform === 'win32'
    ? 'DSH Server.lnk'
    : process.platform === 'darwin' ? 'DSH Server.app' : 'DSH Server.desktop'
  const shortcut = join(fakeDesktop, shortcutName)
  check('first mount records that the shortcut was created', existsSync(desktopCreatedMarker()), true)
  rmSync(shortcut, { recursive: true, force: true })
  installPanelEntry(process.execPath, join(home, 'cli.cjs'), { panelDir, desktopDir: fakeDesktop })
  check('a later mount does not recreate a deleted shortcut', existsSync(shortcut), false)
  installPanelEntry(process.execPath, join(home, 'cli.cjs'), {
    panelDir, desktopDir: fakeDesktop, forceDesktop: true,
  })
  check('an explicit desktop request puts the shortcut back', existsSync(shortcut), true)

  const prefs = writePanelPrefs(paths, { autoOpen: true, openApp: null })
  check('panel prefs round-trip autoOpen', readPanelPrefs(paths).autoOpen, true)
  check('panel prefs default openApp null', prefs.openApp, null)
  beginJob(paths, 'start', 'starting')
  check('beginJob marks busy', readJob(paths).state, 'busy')
  let refused = false
  try {
    await performAction('stop', { home, trackJob: true })
  } catch (error) {
    refused = error instanceof Error && error.message === 'busy'
  }
  check('a busy job is not started again', refused, true)
  endJob(paths, 'ok', 'done')
  check('endJob marks ok', readJob(paths).state, 'ok')

  const control = startControlServer(async (request) => {
    if (request.op === 'ping') return { ok: true, pid: 7 }
    if (request.op === 'stop') return { ok: true, stopped: true }
    return { ok: false }
  })
  await listenControl(control, 37852)
  const ping = await sendControl(37852, { op: 'ping' })
  check('control ping', ping, { ok: true, pid: 7 })
  const stop = await sendControl(37852, { op: 'stop' })
  check('control stop', stop, { ok: true, stopped: true })
  control.close()

  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(37853, '127.0.0.1', resolve)
  })
  check('http probe sees 200', await probeHttp('http://127.0.0.1:37853/'), true)
  check('port listen check', await isWebListening({ host: '127.0.0.1', port: 37853 }), true)
  server.close()
  check('closed port is not listening', await isWebListening({ host: '127.0.0.1', port: 37853 }), false)

  const child = spawnProcess(process.execPath, ['-e', 'setInterval(()=>{}, 999999)'], { stdio: 'ignore' })
  check('spawned pid is alive', pidAlive(child.pid), true)
  killPid(child.pid, 'SIGTERM')
  const deadline = Date.now() + 4000
  while (pidAlive(child.pid) && Date.now() < deadline) await sleep(50)
  check('SIGTERM reaps the child', pidAlive(child.pid), false)
  const runtimeSource = readFileSync(join(process.cwd(), 'dsh-rebooter-runtime.js'), 'utf8')
  check('stopping the service closes the page window',
    runtimeSource.includes("if (action === 'stop' || action === 'update-stop') await requestAppWindowClose(layout)"), true)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  cleanup(home)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
