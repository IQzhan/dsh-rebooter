import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginJob, desktopCreatedMarker, endJob, ensureStateDir, envForHost, envForOneShot, installPanelEntry, isWebListening,
  isTokenizedWebUrl, killPid, launcherBody, launcherFileName, launcherNames, listenControl, lookOnPath, mergeLayout,
  performAction, pidAlive, probeHttp, readJob, readLayout, readPanelPrefs, readPidFile, readWebUrl, requestStopFiles,
  resolveHome, sendControl, sleep, spawnProcess, startControlServer, statePaths, writePanelPrefs,
  writePidFile, writeText,
} from './dsh-rebooter-runtime.js'
import { cleanup, ROOT, scratch } from './test-support.mjs'

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
  check('host keeps an explicit NODE_OPTIONS prefix',
    hostEnv.NODE_OPTIONS.includes('--require missing-on-purpose.cjs'), true)
  check('one-shot keeps an explicit NODE_OPTIONS prefix',
    oneShot.NODE_OPTIONS.includes('--require missing-on-purpose.cjs'), true)
  if (process.platform === 'win32') {
    check('on Windows host prepends the windowsHide preload',
      hostEnv.NODE_OPTIONS.includes('windows-hide-child.cjs'), true)
    check('on Windows one-shot prepends the windowsHide preload',
      oneShot.NODE_OPTIONS.includes('windows-hide-child.cjs'), true)
    check('on Windows the hide preload comes before an existing NODE_OPTIONS value',
      hostEnv.NODE_OPTIONS.indexOf('windows-hide-child.cjs')
        < hostEnv.NODE_OPTIONS.indexOf('missing-on-purpose.cjs'), true)
  } else {
    check('non-Windows host leaves NODE_OPTIONS unchanged',
      hostEnv.NODE_OPTIONS, '--require missing-on-purpose.cjs')
    check('non-Windows one-shot leaves NODE_OPTIONS unchanged',
      oneShot.NODE_OPTIONS, '--require missing-on-purpose.cjs')
    check('non-Windows does not inject the windowsHide preload',
      hostEnv.NODE_OPTIONS.includes('windows-hide-child.cjs'), false)
  }
  if (previousHttps === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = previousHttps
  delete process.env.NODE_OPTIONS
  const restored = envForHost({ dshHome: home }, {}, () => '--require from-user.cjs')
  check('missing NODE_OPTIONS is restored from the OS user environment',
    restored.NODE_OPTIONS.includes('--require from-user.cjs'), true)
  const parentWins = envForHost({ dshHome: home }, { NODE_OPTIONS: '--require parent.cjs' }, () => '--require from-user.cjs')
  check('an explicit NODE_OPTIONS is not replaced',
    parentWins.NODE_OPTIONS.includes('--require parent.cjs')
      && !parentWins.NODE_OPTIONS.includes('--require from-user.cjs'), true)
  const blank = envForHost({ dshHome: home }, {}, () => '  ')
  if (process.platform === 'win32') {
    check('a blank OS user NODE_OPTIONS still gets the hide preload on Windows',
      typeof blank.NODE_OPTIONS === 'string' && blank.NODE_OPTIONS.includes('windows-hide-child.cjs'), true)
  } else {
    check('a blank OS user NODE_OPTIONS stays absent off Windows', blank.NODE_OPTIONS, undefined)
  }
  writeFileSync(join(home, 'rebooter', 'node-options'), '# comment\n--require from-file.cjs\n', 'utf8')
  const fromFile = envForHost({ dshHome: home }, {}, () => '--require from-user.cjs')
  check('plugin node-options file wins over the OS user environment',
    fromFile.NODE_OPTIONS.includes('--require from-file.cjs'), true)
  const fromPluginEnv = envForHost(
    { dshHome: home },
    { DSH_NODE_OPTIONS: '--require from-env.cjs' },
    () => '--require from-user.cjs',
  )
  check('DSH_NODE_OPTIONS wins over the plugin file',
    fromPluginEnv.NODE_OPTIONS.includes('--require from-env.cjs'), true)
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = previousNodeOptions

  // Direct wrap behaviour of windows-hide-child.cjs (not only NODE_OPTIONS path).
  // Same assertion count on every OS so README tallies match CI (Linux) and local (Windows).
  {
    const preload = join(ROOT, 'windows-hide-child.cjs')
    const probe = `
      const cp = require('node:child_process');
      const seen = [];
      function capture(file, args, options) {
        if (args != null && typeof args === 'object' && !Array.isArray(args)) {
          options = args;
        }
        return options == null ? options : { ...options };
      }
      const spySync = function (file, args, options) {
        seen.push({ kind: 'sync', options: capture(file, args, options) });
        return { status: 0, pid: 1, stdout: '', stderr: '', output: [] };
      };
      const spySpawn = function (file, args, options) {
        seen.push({ kind: 'async', options: capture(file, args, options) });
        return { on() {}, unref() {}, pid: 1 };
      };
      cp.spawnSync = spySync;
      cp.spawn = spySpawn;
      require(${JSON.stringify(preload)});
      const wrapped = cp.spawnSync !== spySync || cp.spawn !== spySpawn;
      cp.spawnSync('x', [], undefined);
      cp.spawnSync('x', { cwd: '.' });
      cp.spawnSync('x', [], { windowsHide: false });
      cp.spawn('x', [], {});
      process.stdout.write(JSON.stringify({ wrapped, platform: process.platform, seen }));
    `
    const run = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
    check('windows-hide wrap probe exits cleanly', run.status, 0)
    let report = { wrapped: false, seen: [] }
    try { report = JSON.parse(run.stdout || '{}') } catch { report = { wrapped: false, seen: [] } }
    const seen = Array.isArray(report.seen) ? report.seen : []
    if (process.platform === 'win32') {
      check('windows-hide wraps child_process on Windows', report.wrapped, true)
      check('windows-hide defaults windowsHide when options are omitted',
        seen[0]?.options?.windowsHide, true)
      check('windows-hide defaults windowsHide when options are the 2nd argument',
        seen[1]?.options?.windowsHide === true && seen[1]?.options?.cwd === '.', true)
      check('windows-hide keeps an explicit windowsHide: false',
        seen[2]?.options?.windowsHide, false)
      check('windows-hide wraps spawn as well as spawnSync',
        seen[3]?.kind === 'async' && seen[3]?.options?.windowsHide === true, true)
    } else {
      check('windows-hide does not wrap child_process off Windows', report.wrapped, false)
      check('windows-hide leaves omitted options alone off Windows',
        seen[0]?.options, undefined)
      check('windows-hide leaves a 2nd-argument options object alone off Windows',
        seen[1]?.options, { cwd: '.' })
      check('windows-hide leaves an explicit windowsHide: false alone off Windows',
        seen[2]?.options?.windowsHide, false)
      check('windows-hide leaves spawn options alone off Windows',
        seen[3]?.kind === 'async' && seen[3]?.options?.windowsHide === undefined, true)
    }
  }

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
  const locked = createServer((_req, res) => { res.writeHead(401); res.end('no') })
  await new Promise((resolve, reject) => {
    locked.once('error', reject)
    locked.listen(37854, '127.0.0.1', resolve)
  })
  check('http probe rejects 401', await probeHttp('http://127.0.0.1:37854/'), false)
  locked.close()
  check('closed port is not listening', await isWebListening({ host: '127.0.0.1', port: 37853 }), false)

  check('tokenized URL helper', isTokenizedWebUrl('http://127.0.0.1:3080/?token=abc'), true)
  check('bare origin is not tokenized', isTokenizedWebUrl('http://127.0.0.1:3080/'), false)
  writeText(paths.outLog, 'noise\ndsh web: http://127.0.0.1:3080/?token=ready-token\n')
  writeText(paths.url, 'http://127.0.0.1:3080/')
  check('readWebUrl prefers the tokenized log line',
    readWebUrl(paths, { host: '127.0.0.1', port: 3080 }),
    'http://127.0.0.1:3080/?token=ready-token')
  writeText(paths.outLog, '')
  writeText(paths.url, 'http://127.0.0.1:3080/')
  check('readWebUrl ignores a bare saved URL',
    readWebUrl(paths, { host: '127.0.0.1', port: 3080 }),
    undefined)

  const child = spawnProcess(process.execPath, ['-e', 'setInterval(()=>{}, 999999)'], { stdio: 'ignore' })
  check('spawned pid is alive', pidAlive(child.pid), true)
  killPid(child.pid, 'SIGTERM')
  const deadline = Date.now() + 4000
  while (pidAlive(child.pid) && Date.now() < deadline) await sleep(50)
  check('SIGTERM reaps the child', pidAlive(child.pid), false)
  const runtimeSource = readFileSync(join(process.cwd(), 'dsh-rebooter-runtime.js'), 'utf8')
  check('stopping the service closes the page window',
    runtimeSource.includes('Always close the page window before tearing the host down')
    && runtimeSource.includes('await requestAppWindowClose(layout)')
    && runtimeSource.includes("action === 'restart'"), true)
  check('waitWebReady requires a tokenized URL',
    runtimeSource.includes('function isTokenizedWebUrl')
    && runtimeSource.includes('response.status >= 200 && response.status < 400')
    && !runtimeSource.includes('if (await isWebListening(layout)) {\n      writeText(paths.url, url)'), true)
  check('update recipes stream into job.log',
    runtimeSource.includes('function runLoggedCommand')
    && runtimeSource.includes('await runLoggedCommand'), true)
  check('DSH upgrade clears the page window cache',
    runtimeSource.includes('function resetAppWebViewData')
    && runtimeSource.includes('page window profile →'), true)
  check('openDshUi goes through the panel singleton',
    runtimeSource.includes('async function openDshUiAsync')
    && runtimeSource.includes('ensurePanelHttp')
    && runtimeSource.includes('refusing a second DSH host')
    && runtimeSource.includes('busy without a recorded pid'), true)
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
