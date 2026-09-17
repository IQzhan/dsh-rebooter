import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, ROOT, scratch } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const home = scratch('host-')
const previousHome = process.env.DSH_HOME
const previousSupervisor = process.env.DSH_REBOOTER_SUPERVISOR
const previousDry = process.env.DSH_REBOOTER_DRY_RUN
process.env.DSH_HOME = home
process.env.DSH_REBOOTER_SUPERVISOR = '1'
process.env.DSH_REBOOTER_DRY_RUN = '1'

const require = createRequire(join(ROOT, 'package', 'package.json'))
let plugin
try {
  plugin = require(join(ROOT, 'package', 'lib', 'index.cjs'))
} catch (error) {
  console.error('host bundle missing; run node build-rebooter.mjs first:', error.message)
  process.exit(1)
}

check('host exports a name', plugin.name, 'dsh-rebooter')
check('host exports apply', typeof plugin.apply, 'function')
check('host injects nothing that might not exist', plugin.inject, [])

const routes = []
const effects = []
const ctx = {
  inject: (deps, callback) => {
    check('host waits for webServer', deps, ['webServer'])
    callback({
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
      effect: (fn, label) => {
        effects.push(label)
        return fn()
      },
    })
  },
  effect: (fn, label) => {
    effects.push(label)
    return fn()
  },
  get: () => undefined,
}

const returned = plugin.apply(ctx)
check('apply returns undefined', returned, undefined)
check('a prefix route is registered', routes[0]?.kind, 'prefix')
check('the route is under /api/dsh-rebooter', routes[0]?.path, '/api/dsh-rebooter')
check('layout was recorded under DSH_HOME', existsSync(join(home, 'rebooter', 'layout.json')), true)

const layout = JSON.parse(readFileSync(join(home, 'rebooter', 'layout.json'), 'utf8'))
check('layout records this node', layout.node, process.execPath)
check('layout adds --no-open', Array.isArray(layout.args) && layout.args.includes('--no-open'), true)

const handler = routes[0].handler
const getHealth = async () => {
  let status = 0
  let body = ''
  await handler(
    { method: 'GET', url: '/api/dsh-rebooter/health' },
    {
      writeHead: (code) => { status = code },
      end: (text) => { body = text },
    },
  )
  return { status, json: JSON.parse(body) }
}

const health = await getHealth()
check('health is 200', health.status, 200)
check('health names the plugin', health.json.name, 'dsh-rebooter')

const postAction = async (action) => {
  const chunks = [Buffer.from(JSON.stringify({ action }))]
  let status = 0
  let body = ''
  await handler(
    {
      method: 'POST',
      url: '/api/dsh-rebooter/action',
      [Symbol.asyncIterator]: async function* () { yield* chunks },
    },
    {
      writeHead: (code) => { status = code },
      end: (text) => { body = text },
    },
  )
  return { status, json: JSON.parse(body) }
}

const rejected = await postAction('start')
check('start is refused from the in-app menu', rejected.status, 400)
const accepted = await postAction('stop')
check('stop is accepted', accepted.json, { ok: true, action: 'stop', dispatched: true })

{
  let status = 0
  let body = ''
  await handler(
    { method: 'POST', url: '/api/dsh-rebooter/ensure-supervisor' },
    {
      writeHead: (code) => { status = code },
      end: (text) => { body = text },
    },
  )
  const json = JSON.parse(body)
  check('ensure-supervisor is 200', status, 200)
  check('ensure-supervisor reports ok under dry-run', json, { ok: true, supervisor: true })
}

if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome
if (previousSupervisor === undefined) delete process.env.DSH_REBOOTER_SUPERVISOR
else process.env.DSH_REBOOTER_SUPERVISOR = previousSupervisor
if (previousDry === undefined) delete process.env.DSH_REBOOTER_DRY_RUN
else process.env.DSH_REBOOTER_DRY_RUN = previousDry
cleanup(home)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
