import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureStateDir, envForHostAsync, envForOneShot, installDesktopLauncher, isWebListening, killPid,
  launcherBody, launcherFileName, launcherNames, listenControl, lookOnPath, mergeLayout, pidAlive,
  probeHttp, readLayout, readPidFile, requestStopFiles, resolveHome, sendControl,
  sleep, spawnProcess, startControlServer, statePaths, writePidFile,
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
  check('one-shot CLI drops NODE_OPTIONS', Object.hasOwn(env, 'NODE_OPTIONS'), false)
  check('one-shot CLI still has DSH_HOME', env.DSH_HOME, home)

  const previousHttps = process.env.HTTPS_PROXY
  const previousNodeOptions = process.env.NODE_OPTIONS
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
  const hook = join(home, 'outbound-hook.cjs')
  writeFileSync(hook, "'use strict'\n")
  process.env.NODE_OPTIONS = `--require ${hook}`
  const prepared = await envForHostAsync({ dshHome: home })
  check('host strips static HTTPS_PROXY', prepared.env.HTTPS_PROXY, undefined)
  check('host keeps NODE_OPTIONS when require exists', prepared.env.NODE_OPTIONS, `--require ${hook}`)
  process.env.NODE_OPTIONS = `--require ${join(home, 'missing-hook.cjs')}`
  const missing = await envForHostAsync({ dshHome: home })
  check('host drops NODE_OPTIONS when require is missing', Object.hasOwn(missing.env, 'NODE_OPTIONS'), false)
  if (previousHttps === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = previousHttps
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
  const installed = installDesktopLauncher(process.execPath, join(home, 'cli.cjs'), fakeDesktop)
  check('desktop writes five launchers', Array.isArray(installed) && installed.length, 5)
  check('every launcher file exists', installed.every(path => existsSync(path)), true)
  check('start launcher invokes start', readFileSync(installed.find(p => p.includes('DSH-start')), 'utf8').includes(' start'), true)
  check('stop launcher invokes stop', readFileSync(installed.find(p => p.includes('DSH-stop')), 'utf8').includes(' stop'), true)
  check('legacy single DSH launcher is removed', existsSync(join(fakeDesktop, 'DSH.vbs')) || existsSync(join(fakeDesktop, 'DSH.cmd')), false)

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
