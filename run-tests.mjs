import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUITES = [
  ['test-core.mjs', '策略核心：动作、启动参数、单例端口'],
  ['test-runtime.mjs', '运行时：状态目录、控制面、进程、桌面启动器'],
  ['test-panel.mjs', '状态面板：快照、HTTP、文档'],
  ['test-host.mjs', '适配层：路由、layout、apply 返回值'],
  ['test-package.mjs', '包：两个真实加载器'],
  ['test-client.mjs', '菜单：窗口操作栏，不占侧栏'],
  ['test-docs.mjs', '文档：双语同步'],
  ['test-portability.mjs', '可移植性：无绝对路径、无 Windows 专有实现'],
]

const rows = []
let failed = 0
for (const [file, label] of SUITES) {
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const tally = /(\d+)\/(\d+) passed/.exec(output)
  const ok = run.status === 0 && tally !== null
  if (!ok) failed += 1
  rows.push({
    file,
    label,
    ok,
    result: tally === null ? `crashed (exit ${String(run.status)})` : tally[0],
    asserted: tally === null ? 0 : Number(tally[2]),
    output,
  })
  if (!ok) {
    console.log(output.split('\n').filter(line => /FAIL|Error|error:/.test(line)).slice(0, 20).join('\n'))
  }
}

const measured = rows.reduce((total, row) => total + row.asserted, 0)
const suiteCount = rows.length
const docs = [['README.md', /(\d+)\s*suites/], ['README.zh.md', /(\d+)\s*个套件/]]
const documented = docs.map(([file, suitePattern]) => {
  const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  const suites = suitePattern.exec(text)
  const assertions = /(\d+)\s*(?:assertions|条断言)/u.exec(text)
  return { file, suites: suites?.[1] ?? null, assertions: assertions?.[1] ?? null }
})
for (const entry of documented) {
  const ok = Number(entry.suites) === suiteCount && Number(entry.assertions) === measured
  if (!ok) failed += 1
  rows.push({
    file: entry.file,
    label: 'the README states this run',
    ok,
    result: `${entry.suites ?? '?'} suites / ${entry.assertions ?? '?'} assertions`,
  })
}
if (documented.some(entry => Number(entry.assertions) !== measured)) {
  console.log(`\nThe run measured ${suiteCount} suites and ${measured} assertions;`
    + ' update both READMEs (both languages) to match.')
}

for (const row of rows) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${(row.result ?? '').padEnd(14)} ${row.label}`)
}
console.log(`\n${rows.length - failed}/${rows.length} suites passed`)
process.exit(failed > 0 ? 1 : 0)
