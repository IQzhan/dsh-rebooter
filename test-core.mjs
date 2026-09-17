import {
  ALL_ACTIONS, MENU_ACTIONS, PLUGIN_NAME, STATE_DIR_NAME,
  backoffDelay, captureLaunch, canonicalUrl, controlPort, isAction, isMenuAction,
  isPidAlive, parseHost, parsePort, parseWebUrl, pluginUpdateArgs, shouldSkipStart,
  spawnArgv, withNoOpen,
} from './dsh-rebooter-core.js'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

check('plugin name', PLUGIN_NAME, 'dsh-rebooter')
check('state dir is under DSH home, not a checkout folder', STATE_DIR_NAME, 'rebooter')
check('start is an action', isAction('start'), true)
check('start is not a menu action', isMenuAction('start'), false)
check('the four menu actions', MENU_ACTIONS, ['stop', 'restart', 'update-stop', 'update-restart'])
check('all five actions', ALL_ACTIONS, ['start', 'stop', 'restart', 'update-stop', 'update-restart'])
check('unknown action', isAction('shutdown'), false)

check('control port is a separate bind from the web port', controlPort(3080), 13080)
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

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
