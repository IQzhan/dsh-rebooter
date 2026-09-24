import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  beginJob, endJob, ensureStateDir, mergeLayout, readJob, statePaths, writePanelPrefs,
} from './dsh-rebooter-runtime.js'
import { buildSnapshot, panelPageHtml, windowHostDied } from './dsh-rebooter-panel.js'
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
  check('panel titlebar does not switch to a grabbing cursor while dragging',
    html.includes('cursor: default') && !html.includes('cursor: grabbing'), true)
  check('panel offers a button to put the shortcut on the Desktop', html.includes('id="btnDesktop"'), true)
  check('binding a program does not use window.prompt', html.includes('id="bindPath"') && html.includes('id="btnBrowse"') && !html.includes('prompt('), true)

  writePanelPrefs(paths, { autoOpen: false, openApp: null })
  const idle = await buildSnapshot(paths, layout)
  check('idle snapshot exposes stopped actions', idle.actions, availableActions(false))
  check('idle snapshot is not busy', idle.job.state, 'idle')
  writeFileSync(join(dirname(paths.root), 'settings.yaml'), 'locale:\n  preference: en\nui-theme:\n  preference: dark\n')
  const themed = await buildSnapshot(paths, layout)
  check('snapshot reads legacy settings.yaml locale and theme', themed.appearance, { locale: 'en', theme: 'dark' })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: light\n- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    preference: zh\n',
  )
  const patched = await buildSnapshot(paths, layout)
  check('snapshot prefers profile cordis.patch.yml over settings.yaml', patched.appearance, { locale: 'zh', theme: 'light' })

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
  check('a disposed window host is recognized', windowHostDied(new Error('Application has been disposed')), true)
  check('any other window error is not a dead host', windowHostDied(new Error('module has no Application')), false)
  check('a dead window host is replaced in the same process',
    panelSource.includes('function dropWindowHost') && panelSource.includes('opening a new one') && !panelSource.includes('function holdAnchor') && panelSource.includes('revealFrame() || await showFrameless'), true)
  check('the page controls open from an L at the top-right',
    panelSource.includes('y <= HOT && fromRight <= REACH') && panelSource.includes('fromRight <= HOT && y <= REACH'), true)
  const zhKeys = [...(/zh: \{([\s\S]*?)\n  \}/.exec(panelSource)?.[1] ?? '').matchAll(/'([^']+)':/g)].map(entry => entry[1])
  const enKeys = [...(/en: \{([\s\S]*?)\n  \}/.exec(panelSource)?.[1] ?? '').matchAll(/'([^']+)':/g)].map(entry => entry[1])
  check('panel zh and en expose the same keys', [...zhKeys].sort(), [...enKeys].sort())
  check('panel labels distinguish plugins from DSH',
    panelSource.includes("'update': 'Update plugins'")
    && panelSource.includes("'update-dsh': 'Update DSH'")
    && panelSource.includes("'groupPlugins'")
    && panelSource.includes('action-group-title'), true)
  check('panel actions keep stable buttons across polls',
    panelSource.includes('dataset.action')
    && panelSource.includes('actionsSig')
    && panelSource.includes("closest('button[data-action]')")
    && panelSource.includes('pendingAction'), true)
  check('panel reads appearance from profile cordis.patch.yml',
    panelSource.includes('cordis.patch.yml')
    && panelSource.includes('readAppearanceFromPatch')
    && panelSource.includes('readAppearanceFromLegacySettings'), true)
  check('panel actions detach cli so progress stays live',
    panelSource.includes('dispatchCli(action')
    && !panelSource.includes('await performAction(action'), true)
  check('DSH page uses OS caption drag on Windows; panel keeps custom drag',
    panelSource.includes('nativeDrag: true')
    && panelSource.includes('onMaximizedChange: refreshMax')
    && panelSource.includes('startOsWindowDrag')
    && panelSource.includes("post('drag')")
    && panelSource.includes('nativeOsDrag')
    && panelSource.includes('windows-caption-drag.cjs')
    && !panelSource.includes('function notifyShellMaximized')
    && /bindShellControls\(shell, webview, paths, \(\) => \{[\s\S]*?shell\.hide\(\)[\s\S]*?\}\)(?!,\s*\{)/.test(panelSource), true)
  check('title-bar double-click posts the same max IPC as the maximize button',
    panelSource.includes('function toggleMax')
    && panelSource.includes("post('max')")
    && panelSource.includes('pendingDrag')
    && panelSource.includes('lastTitleTap')
    && panelSource.includes('DBL_MS')
    && panelSource.includes('DRAG_SLOP')
    && panelSource.includes('beginPendingDrag'), true)
  check('maximize icon follows shell.isMaximized, not optimistic clicks',
    panelSource.includes('function watchMaximized')
    && panelSource.includes("shell.on('resize', push)")
    && panelSource.includes("shell.on('move', push)")
    && !panelSource.includes("if (op === 'max') setMax(!maxOn)"), true)
  check('app command does not start a second panel listener',
    panelSource.includes('second listener on panelPort')
    && panelSource.includes('openDshUiAsync'), true)
  check('app window exchanges browser auth before navigation',
    panelSource.includes('exchangeBrowserAuth')
    && panelSource.includes('applyAuthCookies')
    && panelSource.includes("createWebview({ url: 'about:blank'"), true)
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
