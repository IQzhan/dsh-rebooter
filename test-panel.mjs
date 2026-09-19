import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  beginJob, endJob, ensureStateDir, mergeLayout, readJob, statePaths, writePanelPrefs,
} from './dsh-rebooter-runtime.js'
import { buildSnapshot, panelPageHtml } from './dsh-rebooter-panel.js'
import { availableActions } from './dsh-rebooter-core.js'
import { cleanup, scratch } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const home = scratch('panel-')
process.env.DSH_HOME = home

try {
  const paths = ensureStateDir(statePaths(home))
  const layout = mergeLayout(paths, {
    node: process.execPath,
    args: ['web', '--port', '37901'],
    execArgv: [],
    cwd: home,
    dshHome: home,
    host: '127.0.0.1',
    port: 37901,
    nodePid: 0,
  })

  const html = panelPageHtml()
  check('panel html is a full document', html.includes('<!DOCTYPE html>') && html.includes('DSH Server'), true)
  check('panel html has a custom draggable frame',
    html.includes('id="titlebar"') && html.includes('id="btnMin"') && html.includes('id="btnClose"') && !html.includes('id="btnMax"') && html.includes("post('d0:") && html.includes('data-ds-dark-theme') && html.includes('navigator.languages'), true)
  check('binding a program does not use window.prompt', html.includes('id="bindPath"') && html.includes('id="btnBrowse"') && !html.includes('prompt('), true)

  writePanelPrefs(paths, { autoOpen: false, openApp: null })
  const idle = await buildSnapshot(paths, layout)
  check('idle snapshot exposes stopped actions', idle.actions, availableActions(false))
  check('idle snapshot is not busy', idle.job.state, 'idle')
  writeFileSync(join(dirname(paths.root), 'settings.yaml'), 'locale:\n  preference: en\nui-theme:\n  preference: dark\n')
  const themed = await buildSnapshot(paths, layout)
  check('snapshot reads DSH locale and theme', themed.appearance, { locale: 'en', theme: 'dark' })

  beginJob(paths, 'start', 'starting')
  const busy = await buildSnapshot(paths, layout)
  check('busy snapshot hides actions', busy.actions, [])
  endJob(paths, 'ok', 'done')

  const fakeWeb = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise(resolve => fakeWeb.listen(37901, '127.0.0.1', resolve))
  const runningSnap = await buildSnapshot(paths, layout)
  check('running snapshot exposes running actions', runningSnap.actions, availableActions(true))
  await new Promise((resolve, reject) => {
    fakeWeb.close((error) => (error ? reject(error) : resolve()))
  })

  // HTTP serving is exercised via the built CLI in manual/desktop use; keep
  // this suite free of libuv close races on Windows.
  check('status-panel design doc exists', existsSync(join(process.cwd(), 'docs', 'status-panel.md')), true)
  check('status-panel zh doc exists', existsSync(join(process.cwd(), 'docs', 'status-panel.zh.md')), true)
  check('design mentions DSH Server', readFileSync(join(process.cwd(), 'docs', 'status-panel.md'), 'utf8').includes('DSH Server'), true)

  const panelSource = readFileSync(join(process.cwd(), 'dsh-rebooter-panel.js'), 'utf8')
  const copyBlock = /const COPY = \{([\s\S]*?)\n\}/.exec(panelSource)
  check('panel has a COPY dictionary', copyBlock !== null, true)
  const withoutCopy = panelSource
    .replace(/const COPY = \{[\s\S]*?\n\}/, '')
    .replace(/const WIN_COPY = \{[\s\S]*?\n\}/, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  check('panel CJK lives only in the dictionary and comments', /[\u4e00-\u9fff]/.test(withoutCopy), false)
  const zhKeys = [...(/zh: \{([\s\S]*?)\n  \}/.exec(panelSource)?.[1] ?? '').matchAll(/'([^']+)':/g)].map(entry => entry[1])
  const enKeys = [...(/en: \{([\s\S]*?)\n  \}/.exec(panelSource)?.[1] ?? '').matchAll(/'([^']+)':/g)].map(entry => entry[1])
  check('panel zh and en expose the same keys', [...zhKeys].sort(), [...enKeys].sort())
  check('app window controls are power, min, max, and close on a frameless window',
    panelSource.includes("'power','min','max','close'") && panelSource.includes("setAttribute('aria-haspopup', 'menu')") && panelSource.includes('setWindowIcon') && panelSource.includes('setTaskbarIcon') && panelSource.includes("body?.op === 'close'") && /title: 'DSH'[\s\S]{0,280}decorations: false/.test(panelSource) && panelSource.includes('window.__dshLook') && panelSource.includes('pushAppAppearance') && panelSource.includes("pagePrimary === 'zh' || pagePrimary === 'en'") && panelSource.includes("hasAttribute('data-ds-dark-theme')") && panelSource.includes('#dsh-app-menu p{display:none'), true)
} finally {
  cleanup(home)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
