import {
  ALL_ACTIONS, MENU_ACTIONS, PLUGIN_NAME, STATE_DIR_NAME,
  availableActions, backoffDelay, captureLaunch, canonicalUrl, classifyHarness, controlPort,
  dshUpdatePlan, gitClientBuildNeeded, gitPullBroughtCommits, isAction, isDshUpdateAction, isMenuAction, isPidAlive, isPluginUpdateAction,
  panelPort, parseHost, parsePort, parseWebUrl, pluginUpdateArgs, shouldOpenUi,
  shouldSkipStart, spawnArgv, withNoOpen,
} from './dsh-rebooter-core.js'
import { dirname } from 'node:path'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

function makeIo(entries, times = {}) {
  const files = new Map()
  const dirs = new Set()
  for (const [raw, content] of Object.entries(entries)) {
    const path = String(raw).replace(/\\/g, '/')
    if (content === true) {
      dirs.add(path)
      continue
    }
    files.set(path, content)
    let dir = dirname(path)
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const norm = (value) => String(value).replace(/\\/g, '/')
  return {
    existsSync(path) {
      const key = norm(path)
      return files.has(key) || dirs.has(key)
    },
    readFileSync(path) {
      const key = norm(path)
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(key)
    },
    realpathSync(path) {
      return norm(path)
    },
    statSync(path) {
      const key = norm(path)
      const mtimeMs = times[key]
      if (mtimeMs == null) {
        const error = new Error(`ENOENT: ${key}`)
        error.code = 'ENOENT'
        throw error
      }
      return { mtimeMs }
    },
  }
}

check('plugin name', PLUGIN_NAME, 'dsh-rebooter')
check('state dir is under DSH home, not a checkout folder', STATE_DIR_NAME, 'rebooter')
check('start is an action', isAction('start'), true)
check('start is not a menu action', isMenuAction('start'), false)
check('update is an action', isAction('update'), true)
check('open is an action', isAction('open'), true)
check('update is not a menu action', isMenuAction('update'), false)
check('update-dsh is an action', isAction('update-dsh'), true)
check('update-dsh is not a menu action', isMenuAction('update-dsh'), false)
check('plugin update action helper', isPluginUpdateAction('update-stop'), true)
check('dsh update action helper', isDshUpdateAction('update-dsh-restart'), true)
check('all three DSH update entry points are recognized',
  ['update-dsh', 'update-dsh-stop', 'update-dsh-restart'].every((action) => isDshUpdateAction(action)), true)
check('the four menu actions', MENU_ACTIONS, ['stop', 'restart', 'update-stop', 'update-restart'])
check('all actions include start, menu, update, update-dsh, open', ALL_ACTIONS,
  ['start', 'stop', 'restart', 'update-stop', 'update-restart', 'update',
    'update-dsh-stop', 'update-dsh-restart', 'update-dsh', 'open'])
check('unknown action', isAction('shutdown'), false)

check('control port is a separate bind from the web port', controlPort(3080), 13080)
check('panel port sits above the control port', panelPort(3080), 13081)
check('available actions when stopped', availableActions(false),
  ['start', 'update', 'update-restart', 'update-dsh', 'update-dsh-restart'])
check('available actions when running', availableActions(true),
  ['stop', 'restart', 'update-stop', 'update-restart', 'update-dsh-stop', 'update-dsh-restart', 'open'])
check('shouldOpenUi defaults off', shouldOpenUi('start', {}, { autoOpen: false }), false)
check('shouldOpenUi respects autoOpen', shouldOpenUi('start', {}, { autoOpen: true }), true)
check('shouldOpenUi respects --open', shouldOpenUi('start', { open: true }, { autoOpen: false }), true)
check('shouldOpenUi for update-dsh-restart respects autoOpen',
  shouldOpenUi('update-dsh-restart', {}, { autoOpen: true }), true)
check('control port stays inside the TCP range', controlPort(60000) <= 65535, true)
check('bogus web port falls back', controlPort('nope'), 13080)

check('parsePort reads --port N', parsePort(['web', '--port', '4040']), 4040)
check('parsePort reads --port=', parsePort(['--port=9090']), 9090)
check('parseHost reads --host', parseHost(['--host', 'localhost']), 'localhost')

check('withNoOpen is idempotent', withNoOpen(['web', '--no-open']), ['web', '--no-open'])
check('withNoOpen appends when missing', withNoOpen(['web']), ['web', '--no-open'])

check('plugin update replaces the web verb',
  pluginUpdateArgs(['apps/cli/src/bin.ts', 'web', '--no-open']),
  ['apps/cli/src/bin.ts', 'plugin', '--profile', 'web', 'update', '--latest'])
check('plugin update without a web verb is absent', pluginUpdateArgs(['not-dsh']), undefined)

const launch = captureLaunch({
  argv: ['/usr/bin/node', 'apps/cli/src/bin.ts', 'web', '--port', '3080'],
  execArgv: ['--import', 'tsx/esm'],
  execPath: 'node',
  cwd: 'repo',
  pid: 11,
  env: { DSH_HOME: 'dsh-home' },
})
check('capture keeps execArgv so tsx relaunches', launch.execArgv, ['--import', 'tsx/esm'])
check('capture records the node pid', launch.nodePid, 11)
check('capture adds --no-open', launch.args.includes('--no-open'), true)
check('spawn argv is execArgv + args', spawnArgv(launch)[0], '--import')

check('parseWebUrl takes the last printed URL',
  parseWebUrl('dsh web: http://127.0.0.1:3080/?token=old\nnoise\ndsh web: http://127.0.0.1:3080/?token=new\n'),
  'http://127.0.0.1:3080/?token=new')
check('parseWebUrl misses garbage', parseWebUrl('not a url'), undefined)

check('pid 0 is never alive', isPidAlive(0, () => true), false)
check('isPidAlive uses the ping', isPidAlive(8, () => true), true)
check('isPidAlive treats throw as dead', isPidAlive(8, () => { throw new Error('gone') }), false)

check('backoff grows then caps', [backoffDelay(0), backoffDelay(1), backoffDelay(20) <= 30000], [1000, 2000, true])
check('canonicalUrl builds from layout', canonicalUrl({ host: '127.0.0.1', port: 3080 }, '/'), 'http://127.0.0.1:3080/')
check('skip start when already healthy', shouldSkipStart(true, false), true)
check('skip start when supervisor holds the lock', shouldSkipStart(false, true), true)
check('do not skip a cold start', shouldSkipStart(false, false), false)

const gitEntry = '/repo/apps/cli/src/bin.ts'
const gitIo = makeIo({
  '/repo/.git': true,
  '/repo/apps/cli/package.json': '{"name":"@deepseek-ai/dsh"}',
  [gitEntry]: 'export {}',
})
const gitLayout = {
  args: [gitEntry, 'web', '--no-open'],
  cwd: '/repo',
  execArgv: ['--import', 'tsx'],
}
const gitClassified = classifyHarness(gitLayout, gitIo)
check('classifyHarness detects a git source tree', gitClassified.kind, 'git')
check('classifyHarness git root', gitClassified.root, '/repo')
const gitPlan = dshUpdatePlan(gitLayout, gitClassified, gitIo)
check('git + tsx + bin.ts rebuilds host+client libs and the web shell', gitPlan.error, undefined)
check('git recipe steps', (gitPlan.steps || []).map((step) => [step.tool, ...step.args]), [
  ['git', 'status', '--porcelain'],
  ['git', 'pull', '--ff-only'],
  ['pnpm', 'install'],
  ['pnpm', 'run', 'build:lib'],
  ['pnpm', 'run', 'build:web'],
])
check('git pull step captures stdout', (gitPlan.steps || []).find((step) => step.capturesPull)?.args?.[0], 'pull')
check('tsx lib and web builds are gated',
  (gitPlan.steps || []).filter((step) => step.optionalUnlessNeeded === true).map((step) => step.label),
  ['pnpm build:lib', 'pnpm build:web'])
check('git recipe never rebuilds client without host',
  !(gitPlan.steps || []).some((step) => (step.args || []).includes('build:lib:client')), true)
check('skip build when pull unchanged',
  gitClientBuildNeeded('/repo', {}, 'Already up to date.\n').needed, false)
check('build when pull brought commits',
  gitClientBuildNeeded('/repo', {}, 'Updating abc..def\nFast-forward\n').needed, true)
check('skip build when pull output empty',
  gitClientBuildNeeded('/repo', {}, '').needed, false)
check('gitPullBroughtCommits detects fast-forward',
  gitPullBroughtCommits('Updating a..b\nFast-forward\n'), true)
check('gitPullBroughtCommits ignores already up to date',
  gitPullBroughtCommits('Already up to date.\n'), false)

const builtEntry = '/repo/apps/cli/lib/bin.js'
const builtIo = makeIo({
  '/repo/.git': true,
  '/repo/apps/cli/package.json': '{"name":"@deepseek-ai/dsh"}',
  [builtEntry]: 'module.exports = {}',
})
const builtPlan = dshUpdatePlan(
  { args: [builtEntry, 'web'], cwd: '/repo', execArgv: [] },
  classifyHarness({ args: [builtEntry], cwd: '/repo' }, builtIo),
  builtIo,
)
check('built lib/bin.js rebuilds lib then web shell',
  (builtPlan.steps || []).filter((step) => step.optionalUnlessNeeded === true).map((step) => [step.tool, ...step.args]),
  [
    ['pnpm', 'run', 'build:lib'],
    ['pnpm', 'run', 'build:web'],
  ])
check('built lib/bin.js rebuild steps are gated on pull',
  (builtPlan.steps || []).filter((step) => (step.args || []).includes('build:lib') || (step.args || []).includes('build:web'))
    .every((step) => step.optionalUnlessNeeded === true), true)

const npxEntry = '/opt/npm-cache/_npx/abc/node_modules/@deepseek-ai/dsh/lib/bin.js'
const npxIo = makeIo({
  [npxEntry]: 'module.exports = {}',
  '/opt/npm-cache/_npx/abc/node_modules/@deepseek-ai/dsh/package.json': '{"name":"@deepseek-ai/dsh"}',
})
const npxClassified = classifyHarness({ args: [npxEntry], cwd: '/opt/scratch' }, npxIo)
check('npx paths classify as npm', npxClassified.kind, 'npm')
check('npx paths are flagged', npxClassified.npx, true)
check('npx recipe is refused',
  dshUpdatePlan({ args: [npxEntry] }, npxClassified, npxIo).error?.includes('npx'), true)

const globalEntry = '/opt/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
const globalRoot = '/opt/npm/node_modules/@deepseek-ai/dsh'
const globalIo = makeIo({
  [globalEntry]: 'module.exports = {}',
  [`${globalRoot}/package.json`]: '{"name":"@deepseek-ai/dsh"}',
})
const globalClassified = classifyHarness({ args: [globalEntry], cwd: '/opt/scratch' }, globalIo)
const globalPlan = dshUpdatePlan({ args: [globalEntry] }, globalClassified, globalIo)
check('global npm install plans npm -g', globalPlan.steps?.[0]?.args,
  ['install', '-g', '@deepseek-ai/dsh@latest'])
check('global npm refreshLayout is on', globalPlan.refreshLayout, true)
check('global npm does not rebuild a git web shell',
  !(globalPlan.steps || []).some((step) => (step.args || []).includes('build:web') || (step.args || []).includes('build:lib')), true)

const localEntry = '/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const localIo = makeIo({
  [localEntry]: 'module.exports = {}',
  '/app/node_modules/@deepseek-ai/dsh/package.json': '{"name":"@deepseek-ai/dsh"}',
  '/app/package.json': '{"dependencies":{"@deepseek-ai/dsh":"^1.0.0"}}',
  '/app/pnpm-lock.yaml': 'lockfileVersion: 9',
})
const localClassified = classifyHarness({ args: [localEntry], cwd: '/app' }, localIo)
const localPlan = dshUpdatePlan({ args: [localEntry], cwd: '/app' }, localClassified, localIo)
check('local pnpm project uses pnpm add', localPlan.steps?.[0], {
  tool: 'pnpm',
  args: ['add', '@deepseek-ai/dsh@latest'],
  cwd: '/app',
  label: 'pnpm add @deepseek-ai/dsh@latest',
})
check('local npm install does not rebuild a git web shell',
  localPlan.refreshLayout === true
  && !(localPlan.steps || []).some((step) => (step.args || []).includes('build:web') || (step.args || []).includes('build:lib')), true)

const unknown = classifyHarness({ args: ['/opt/scratch/not-dsh.js'] }, makeIo({ '/opt/scratch/not-dsh.js': 'x' }))
check('unrecognized trees are unknown', unknown.kind, 'unknown')
check('unknown recipe is refused', dshUpdatePlan({}, unknown, makeIo({})).error != null, true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
