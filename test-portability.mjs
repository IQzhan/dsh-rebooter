import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

function shippedFiles() {
  const named = [
    'dsh-rebooter-core.js', 'dsh-rebooter-runtime.js', 'dsh-rebooter-panel.js',
    'dsh-rebooter.host.js', 'dsh-rebooter.client.js', 'dsh-rebooter-cli.js',
    'windows-hide-child.cjs',
    'windows-caption-drag.cjs',
    'build-rebooter.mjs', 'run-tests.mjs', 'package.json', 'README.md', 'README.zh.md',
    'LICENSE', 'test-support.mjs',
  ]
  const missing = named.filter(name => !existsSync(join(ROOT, name)))
  check('every named file is actually there', missing, [])
  const files = named.filter(name => existsSync(join(ROOT, name))).map(name => join(ROOT, name))
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('test-') && entry.endsWith('.mjs')) files.push(join(ROOT, entry))
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }
  if (existsSync(join(ROOT, 'docs'))) walk(join(ROOT, 'docs'))
  for (const artifact of [
    'package/lib/index.cjs', 'package/lib/client.cjs', 'package/lib/cli.cjs',
    'package/lib/windows-hide-child.cjs',
    'package/lib/windows-caption-drag.cjs',
    'package/package.json', 'package/cordis.patch.yml',
  ]) {
    if (existsSync(join(ROOT, artifact))) files.push(join(ROOT, artifact))
  }
  return [...new Set(files)]
}

const files = shippedFiles()
check('the guard actually looks at the shipped files', files.length > 8, true)

const WINDOWS_PATH = /[A-Za-z]:\\[A-Za-z0-9_.\- ]+(?:\\[A-Za-z0-9_.\- ]+)+|[A-Za-z]:\/(?!\/)[A-Za-z0-9_.\- ]+(?:\/[A-Za-z0-9_.\- ]+)+/
const POSIX_PATH = /\/(?:Users|home|tmp|var\/folders)\//

const pathOffenders = []
const windowsOffenders = []
const tempOffenders = []
for (const file of files) {
  const name = file.slice(ROOT.length + 1)
  if (name.endsWith('test-portability.mjs')) continue
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, index) => {
    if (WINDOWS_PATH.test(line) || POSIX_PATH.test(line)) pathOffenders.push(`${name}:${index + 1}`)
    if (/\btmpdir\s*\(/.test(line) || /process\.env\.USERPROFILE/.test(line)) {
      tempOffenders.push(`${name}:${index + 1}`)
    }
    if (/'junction'/.test(line) && !/process\.platform/.test(line)) {
      windowsOffenders.push(`${name}:${index + 1}`)
    }
  })
}

check('no absolute path from any machine', pathOffenders, [])
check('no system temp directory and no Windows-only home variable', tempOffenders, [])
check('no platform-specific symlink type outside a platform switch', windowsOffenders, [])

const build = readFileSync(join(ROOT, 'build-rebooter.mjs'), 'utf8')
check('the build chooses its link type per platform',
  /process\.platform === 'win32' \? 'junction' : 'dir'/.test(build), true)

const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
check('the licence is MIT', licence.startsWith('MIT License'), true)
check('and it is in English', /[\u4e00-\u9fff]/.test(licence), false)

const powerShellUsers = files
  .map(file => file.slice(ROOT.length + 1))
  .filter(name => name.endsWith('.ps1'))
check('PowerShell is not a runtime dependency', powerShellUsers, [])

const runtime = readFileSync(join(ROOT, 'dsh-rebooter-runtime.js'), 'utf8')
check('runtime never shells out to powershell / schtasks / taskkill',
  /powershell|pwsh|schtasks|taskkill/i.test(runtime), false)
check('runtime never uses a Windows named mutex', /Mutex|Win32_Process|CreateMutex/i.test(runtime), false)
// WScript may appear only inside launcher/shortcut *string bodies* (desktop entry).
const wscriptCodeLines = runtime.split('\n')
  .map(line => line.trim())
  .filter(line => /wscript/i.test(line))
  .filter(line => !line.startsWith('//') && !line.startsWith('*'))
  .filter(line => !/(['"`]).*[Ww][Ss]cript|CreateObject\("WScript/.test(line))
check('supervisor path does not use WScript', wscriptCodeLines, [])
check('desktop launcher may use WScript for a windowless start', /WScript\.Shell/.test(runtime), true)
check('desktop shortcut targets wscript host string', /wscript\.exe/.test(runtime), true)
check('darwin desktop entry is an app bundle, not a terminal command',
  runtime.includes("'DSH Server.app'") && !/join\(desk, 'DSH Server\.command'\)/.test(runtime), true)
check('default UI open goes through the panel singleton',
  /openDshUiAsync/.test(runtime) && /ensurePanelHttp/.test(runtime) && !/\[cli, 'app'\]/.test(runtime), true)
check('runtime does not read or rewrite proxy variables',
  /HTTPS_PROXY|HTTP_PROXY|NO_PROXY|ALL_PROXY|WinINET|Internet Settings/.test(runtime), false)
check('runtime restores a dropped NODE_OPTIONS from plugin sources then OS user env',
  /node-options/.test(runtime) && /DSH_NODE_OPTIONS/.test(runtime) && /HKCU\\\\Environment/.test(runtime), true)
check('runtime prepends a windowsHide preload only on Windows',
  /windows-hide-child\.cjs/.test(runtime)
    && /prependWindowsHideRequire/.test(runtime)
    && /process\.platform !== 'win32'/.test(runtime), true)
check('Windows caption drag is isolated and only loaded on win32',
  existsSync(join(ROOT, 'windows-caption-drag.cjs'))
    && /WM_NCLBUTTONDOWN|HTCAPTION/.test(readFileSync(join(ROOT, 'windows-caption-drag.cjs'), 'utf8'))
    && /startOsWindowDrag/.test(readFileSync(join(ROOT, 'dsh-rebooter-panel.js'), 'utf8'))
    && /process\.platform !== 'win32'/.test(readFileSync(join(ROOT, 'dsh-rebooter-panel.js'), 'utf8')), true)
check('runtime does not install an OS web view',
  /apt-get|pkexec|webview2-setup|fwlink/i.test(runtime), false)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
