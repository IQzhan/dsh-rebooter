/**
 * build-rebooter.mjs — assemble the installable package from one source.
 *
 * Outputs:
 *   package/                 dsh plugin add ./package
 *     package.json
 *     cordis.patch.yml
 *     lib/index.cjs          Host (core + runtime + adapter)
 *     lib/client.cjs         ModuleLoader wrapper
 *     lib/cli.cjs            start | stop | restart | update-* | supervisor
 *
 * The same core+runtime is concatenated into Host and CLI so the process that
 * outlives DSH cannot drift from the process that records the launch.
 */
import { mkdir, readFile, rm, symlink, writeFile, readlink, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-rebooter'
const VERSION = '1.0.0'
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const OUT_PACKAGE = join(here, 'package')

const CORE = join(here, 'dsh-rebooter-core.js')
const RUNTIME = join(here, 'dsh-rebooter-runtime.js')
const PANEL = join(here, 'dsh-rebooter-panel.js')
const HOST = join(here, 'dsh-rebooter.host.js')
const CLIENT = join(here, 'dsh-rebooter.client.js')
const CLI = join(here, 'dsh-rebooter-cli.js')

function stripExportBlock(source, label) {
  const match = /^export\s*\{([\s\S]*?)\}\s*;?\s*$/m.exec(source)
  if (match === null) throw new Error(`build: ${label} has no trailing export block to strip`)
  return source.replace(match[0], '')
}

function stripNamedExports(source) {
  return source
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+\{[\s\S]*?\}\s*;?\s*$/m, '')
    .trim()
}

function assertImportFree(source, label) {
  const found = /^\s*import\s.+$/m.exec(source)
  if (found !== null) {
    throw new Error(`build: ${label} must not import (found "${found[0].trim()}")`)
  }
}

function rewriteNodeImports(source) {
  return source
    .replace(/^import\s+(\w+)\s+from\s+'node:([^']+)'\s*$/gm,
      (_, bind, spec) => `const ${bind} = require('node:${spec}')`)
    .replace(/^import\s*\{([^}]+)\}\s*from\s+'node:([^']+)'\s*$/gm,
      (_, names, spec) => `const {${names}} = require('node:${spec}')`)
}

function dropCoreImport(source) {
  return source.replace(/^import\s*\{[\s\S]*?\}\s*from\s+'\.\/dsh-rebooter-core\.js'\s*$/m, '')
}

function clientExportNames(source) {
  const names = []
  for (const match of source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

function wrapClient(clientSource) {
  const body = stripNamedExports(clientSource)
  return [
    `'use strict'`,
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PLUGIN_NAME)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} }',
    '    var exports = module.exports',
    body.split('\n').map(line => (line.length === 0 ? line : `    ${line}`)).join('\n'),
    '    exports.apply = apply',
    '    exports.inject = inject',
    ...clientExportNames(clientSource)
      .filter(name => name !== 'apply' && name !== 'inject')
      .map(name => `    exports.${name} = ${name}`),
    '    exports.default = module.exports',
    '    return module.exports',
    '  },',
    '})',
  ].join('\n')
}

const banner = `/**
 * ${PLUGIN_NAME} — GENERATED FILE, DO NOT EDIT.
 * Assembled by build-rebooter.mjs. Edit the sources and re-run the build.
 */`

const [coreSource, runtimeSource, panelSource, hostSource, clientSource, cliSource] = await Promise.all([
  readFile(CORE, 'utf8'),
  readFile(RUNTIME, 'utf8'),
  readFile(PANEL, 'utf8'),
  readFile(HOST, 'utf8'),
  readFile(CLIENT, 'utf8'),
  readFile(CLI, 'utf8'),
])

assertImportFree(hostSource, 'dsh-rebooter.host.js')
assertImportFree(clientSource, 'dsh-rebooter.client.js')
assertImportFree(cliSource, 'dsh-rebooter-cli.js')

const coreBody = stripExportBlock(coreSource, 'dsh-rebooter-core.js').trim()
const runtimeBody = rewriteNodeImports(dropCoreImport(stripExportBlock(runtimeSource, 'dsh-rebooter-runtime.js'))).trim()
function dropRelativeImports(source) {
  return source
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s+'\.\/dsh-rebooter-core\.js'\s*$/m, '')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s+'\.\/dsh-rebooter-runtime\.js'\s*$/m, '')
}

/** Panel reuses runtime's fs/os/path bindings in the concatenated bundle. */
function dropPanelSharedNodeImports(source) {
  return source
    .replace(/^import\s*\{[^}]+\}\s*from\s+'node:(fs|os|path)'\s*$/gm, '')
}

const panelBody = rewriteNodeImports(
  dropPanelSharedNodeImports(dropRelativeImports(stripExportBlock(panelSource, 'dsh-rebooter-panel.js'))),
).trim()
const hostBody = stripExportBlock(hostSource, 'dsh-rebooter.host.js').trim()
const cliBody = stripExportBlock(cliSource, 'dsh-rebooter-cli.js').trim()

const shared = [banner, `'use strict'`, coreBody, runtimeBody, panelBody].join('\n\n')

const hostModule = [
  shared,
  hostBody,
  'const plugin = {',
  `  name: ${JSON.stringify(PLUGIN_NAME)},`,
  '  inject: [],',
  '  apply(ctx) { return mountRebooter(ctx) },',
  '}',
  'module.exports = plugin',
  'module.exports.default = plugin',
].join('\n\n')

const cliModule = [
  '#!/usr/bin/env node',
  shared,
  cliBody,
  `if (require.main === module) {`,
  '  runCli(process.argv).then(() => {}).catch((error) => {',
  '    console.error(error instanceof Error ? error.message : error)',
  '    process.exit(1)',
  '  })',
  '}',
  'module.exports = { runCli, runSupervisor, performAction, runPanel, startPanelServer, printCliHelp }',
].join('\n\n')

const clientModule = [
  banner,
  wrapClient(clientSource),
].join('\n')

const manifest = {
  name: PLUGIN_NAME,
  version: VERSION,
  private: true,
  description: 'Start, stop, restart, and update DeepSeek Harness (including every profile plugin) from the page window or the desktop.',
  type: 'commonjs',
  main: './lib/index.cjs',
  bin: { 'dsh-rebooter': './lib/cli.cjs' },
  exports: {
    '.': { default: './lib/index.cjs' },
    './client': { default: './lib/client.cjs' },
    './cli': { default: './lib/cli.cjs' },
    './package.json': './package.json',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: false,
      inject: [],
      external: [],
    },
  },
  dependencies: {
    '@webviewjs/webview': '^0.4.5',
  },
  engines: {
    node: '>=24',
  },
}

const bundlePatch = `# ${PLUGIN_NAME} bundle patch.
#
# Declared as \`dsh.bundle.patch\`, so \`dsh plugin --profile web add <this
# package>\` appends the bundle and the profile boot merges this layer.
- insert:
    - id: ${PLUGIN_NAME}
      name: ${PLUGIN_NAME}
`

await mkdir(OUT_PACKAGE, { recursive: true })
await rm(join(OUT_PACKAGE, 'lib'), { recursive: true, force: true })
await rm(join(OUT_PACKAGE, 'cordis.patch.yml'), { force: true })
await mkdir(join(OUT_PACKAGE, 'lib'), { recursive: true })
await mkdir(join(OUT_PACKAGE, 'panel'), { recursive: true })
await writeFile(join(OUT_PACKAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'cordis.patch.yml'), bundlePatch, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'index.cjs'), `${hostModule}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'client.cjs'), `${clientModule}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'cli.cjs'), `${cliModule}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'panel', 'README.txt'), [
  'DSH Server panel entry files are written here by:',
  '  node lib/cli.cjs desktop',
  'or automatically when the Host plugin mounts.',
  '',
].join('\n'), 'utf8')

const iconNames = ['dsh-server.ico', 'dsh-server.png', 'dsh-server.rgba', 'dsh.ico', 'dsh.png', 'dsh.rgba']
for (const name of iconNames) {
  const from = join(here, 'icons', name)
  if (existsSync(from)) await copyFile(from, join(OUT_PACKAGE, 'panel', name))
}

const hostInstalled = existsSync(join(OUT_PACKAGE, 'node_modules', '@webviewjs', 'webview'))
if (!hostInstalled) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installed = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: OUT_PACKAGE,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (installed.status !== 0) {
    console.error('build: window host was not installed; rerun the build online so the panel window can open')
    process.exit(installed.status ?? 1)
  }
}

const lines = source => source.split('\n').length
console.log(`built ${join('package', 'lib', 'index.cjs')}  (${lines(hostModule)} lines)`)
console.log(`built ${join('package', 'lib', 'client.cjs')} (${lines(clientModule)} lines)`)
console.log(`built ${join('package', 'lib', 'cli.cjs')}    (${lines(cliModule)} lines)`)

async function linkIntoProfile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['web', 'headless']) {
    const dir = join(home, 'profiles', profile)
    if (!existsSync(join(dir, 'cordis.patch.yml'))) continue
    const modules = join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    const link = join(modules, PLUGIN_NAME)
    const existing = await readlink(link).catch(() => undefined)
    if (existing !== undefined) {
      if (existing === OUT_PACKAGE) return { link, fresh: false }
      await rm(link, { recursive: true, force: true })
    } else if (existsSync(link)) {
      await rm(link, { recursive: true, force: true })
    }
    await symlink(OUT_PACKAGE, link, LINK_TYPE)
    return { link, fresh: true }
  }
  return undefined
}

const linked = await linkIntoProfile()
if (linked === undefined) {
  console.log('no profile with a cordis.patch.yml found; link package/ into a profile yourself')
} else {
  console.log(`${linked.fresh ? 'linked' : 'already linked'} ${linked.link} -> ${OUT_PACKAGE}`)
  console.log('')
  console.log('Next (once per profile):')
  console.log('  dsh plugin --profile web add ./package')
  console.log('  then restart dsh web')
}
