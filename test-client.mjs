import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const source = readFileSync(join(ROOT, 'dsh-rebooter.client.js'), 'utf8')

const copyBlock = /const COPY = \{([\s\S]*?)\n\}/.exec(source)
check('the client has a COPY dictionary', copyBlock !== null, true)

const withoutCopy = source.replace(copyBlock?.[0] ?? '', '')
  .split('\n')
  .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
  .join('\n')
check('CJK characters live only in the dictionary and comments',
  /[\u4e00-\u9fff]/.test(withoutCopy), false)

const zhBlock = /zh: \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? ''
const enBlock = /en: \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? ''
const zhKeys = [...zhBlock.matchAll(/'([^']+)':/g)].map(entry => entry[1])
const enKeys = [...enBlock.matchAll(/'([^']+)':/g)].map(entry => entry[1])
check('zh and en expose the same keys', [...zhKeys].sort(), [...enKeys].sort())

check('the menu does not include start', /menu\.start/.test(source), false)
check('the client registers sidebar.footer.action', source.includes("name: 'sidebar.footer.action'"), true)
check('the client uses its own list id', source.includes("id: 'dsh-rebooter'"), true)
check('React is not read at module top level', /^\s*const E = React\.createElement/m.test(source), false)
check('wide foot layout reaches past display:contents slot', source.includes('> * > * > [data-plugin="dsh-rebooter"].wide'), true)
check('wide mode moves this plugin into the settings trigger row', source.includes('insertBefore(node, row.firstChild)'), true)
check('wide foot layout does not rewrite sidebar.settings', source.includes("name: 'sidebar.settings'"), false)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
