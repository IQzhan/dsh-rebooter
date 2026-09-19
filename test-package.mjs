import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const require = createRequire(join(ROOT, 'package', 'package.json'))
let pkg
try {
  pkg = require(join(ROOT, 'package', 'package.json'))
} catch (error) {
  console.error('package missing; run node build-rebooter.mjs first:', error.message)
  process.exit(1)
}

check('package name matches the patch row', pkg.name, 'dsh-rebooter')
check('package declares dsh.client for web', pkg.dsh?.client?.platform, 'web')
check('package declares a bundle patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
check('package exposes ./client', pkg.exports?.['./client']?.default, './lib/client.cjs')
check('package exposes a cli bin', pkg.bin?.['dsh-rebooter'], './lib/cli.cjs')
check('client does not inject a slots package', pkg.dsh?.client?.inject, [])
check('client does not declare a platform external', pkg.dsh?.client?.external, [])

const host = require(join(ROOT, 'package', 'lib', 'index.cjs'))
check('host exports a name', host.name, 'dsh-rebooter')
check('host exports apply', typeof host.apply, 'function')
check('host default export mirrors it', typeof host.default?.apply, 'function')
check('host bundle has no import statements',
  /^\s*import\s/m.test(readFileSync(require.resolve(join(ROOT, 'package', 'lib', 'index.cjs')), 'utf8')), false)

const clientPath = join(ROOT, 'package', 'lib', 'client.cjs')
const clientSource = readFileSync(clientPath, 'utf8')
check('client bundle has no ESM exports', /^\s*export\s/m.test(clientSource), false)
check('client bundle registers via __ModuleLoader__', clientSource.includes('window.__ModuleLoader__.load('), true)

const registrations = []
const fakeWindow = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}
const registered = []
const stubLocale = {
  register: (ns, copy) => { registered.push({ ns, copy }); return () => {} },
  bind: (ns) => (key) => copyOf(ns)[key] ?? key,
}
function copyOf(ns) {
  return registered.find(entry => entry.ns === ns)?.copy?.en ?? {}
}
const stubCtx = {
  slots: {
    inject: (slot, callback) => {
      const result = callback()
      registered.push({ slot, result })
      return result
    },
    register: (options, component) => {
      registered.push({ options, component })
      return { options, component }
    },
  },
  locale: stubLocale,
  effect: (fn) => fn(),
}
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require ${name}`)
}

const loader = new Function('window', 'require', clientSource)
loader(fakeWindow, fakeRequire)
check('ModuleLoader received one registration', registrations.length, 1)
const mod = registrations[0].factory(fakeRequire)
check('client factory exports apply', typeof mod.apply, 'function')
check('client inject list is empty', mod.inject, [])
const applied = mod.apply(stubCtx)
check('client apply returns undefined', applied, undefined)
const slot = registered.find(entry => entry.options?.name === 'sidebar.footer.action')
check('client does not occupy the sidebar foot', slot, undefined)
check('client leaves the page untouched', registered.length, 0)

const patch = readFileSync(join(ROOT, 'package', 'cordis.patch.yml'), 'utf8')
check('patch inserts this package by name', /name: dsh-rebooter/.test(patch), true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
