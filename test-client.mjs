import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const client = readFileSync(join(ROOT, 'dsh-rebooter.client.js'), 'utf8')
const panel = readFileSync(join(ROOT, 'dsh-rebooter-panel.js'), 'utf8')

const clientCode = client.split('\n')
  .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
  .join('\n')
check('client source has no CJK', /[\u4e00-\u9fff]/.test(clientCode), false)
check('client does not register a sidebar slot', client.includes('sidebar.footer.action'), false)
check('client does not draw a page button', client.includes('dsh-rebooter-btn'), false)
check('client inject list is empty', /export const inject = \[\]/.test(client), true)
check('window menu has the four previous actions', panel.includes("['stop', 'restart', 'update-stop', 'update-restart']"), true)
check('window menu does not offer start', panel.includes("data-act', 'start'") || panel.includes("['start'"), false)
check('window menu posts the host action route', panel.includes("'/api/dsh-rebooter/action'"), true)
check('window menu action fetch times out so busy cannot stick',
  panel.includes('AbortController')
  && panel.includes('ac.abort()')
  && panel.includes("error.message === 'http'"), true)
check('power button opens a menu', panel.includes("setAttribute('aria-haspopup', 'menu')"), true)
check('power click does not stop or start immediately', panel.includes("live ? 'stop' : 'start'"), false)
check('window close is still only a window close', panel.includes("op === 'close'") && panel.includes('closeAppWindow()'), true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
