import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const DOCS = ['README.md', 'README.zh.md']
const missing = DOCS.filter(name => !existsSync(join(ROOT, name)))
check('both languages exist', missing, [])

const read = name => readFileSync(join(ROOT, name), 'utf8')
const zh = read('README.zh.md')
const en = read('README.md')

const sections = text => [...text.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim())
const fences = text => [...text.matchAll(/^```(\S*)$/gm)].map(match => match[1])
const tokens = text => [...new Set([...text.matchAll(/`([^`\n]+)`/g)]
  .map(match => match[1].trim())
  .filter(token => /^[\x20-\x7E]+$/.test(token) && !token.includes(' ')))]
const tableRows = text => text.split('\n').filter(line => line.trimStart().startsWith('|')).length

check('the two languages have the same number of sections', sections(en).length, sections(zh).length)
check('and the same code blocks', fences(en), fences(zh))
check('and the same tables', tableRows(en), tableRows(zh))
check('and the same inline code', tokens(en).sort(), tokens(zh).sort())
check('the English file links to the Chinese one', /README\.zh\.md/.test(en.split('\n').slice(0, 6).join('\n')), true)
check('the Chinese file links to the English one', /README\.md/.test(zh.split('\n').slice(0, 6).join('\n')), true)

const KEYS = ['start', 'stop', 'restart', 'update', 'update-stop', 'update-restart', 'open', 'panel', 'sidebar.footer.action', 'DSH Server']
check('every action and slot is documented in both languages',
  KEYS.filter(key => !en.includes(key) || !zh.includes(key)), [])
check('status panel design is linked', [en.includes('docs/status-panel'), zh.includes('docs/status-panel')], [true, true])

for (const command of [
  'node build-rebooter.mjs',
  'node verify.mjs',
  'dsh plugin --profile web add ./package',
  'dsh plugin --profile web update --latest',
]) {
  check(`both languages document \`${command}\``, [en.includes(command), zh.includes(command)], [true, true])
}

check('the plugin spec exists', existsSync(join(ROOT, 'docs', 'dsh-plugin-spec.md')), true)
check('and both languages link to it', [en.includes('docs/dsh-plugin-spec.md'), zh.includes('docs/dsh-plugin-spec.md')], [true, true])
check('both languages state the licence', [/MIT/.test(en), /MIT/.test(zh)], [true, true])

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
