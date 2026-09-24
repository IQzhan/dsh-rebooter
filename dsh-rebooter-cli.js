/**
 * dsh-rebooter-cli.js — command entry for start / stop / restart / update / panel.
 *
 * Invoked as `node lib/cli.cjs <action>`. The Host half also spawns this
 * file detached so close/update can finish after the web process is gone.
 */

async function runCli(argv = process.argv) {
  const args = argv.slice(2)
  const action = args[0] && !args[0].startsWith('-') ? args[0] : 'start'
  const fromHost = args.includes('--from-host')
  const noOpen = args.includes('--no-open')
  const forceOpen = args.includes('--open')
  const serveOnly = args.includes('--serve')

  if (action === 'supervisor') {
    return runSupervisor({ fromHost })
  }
  if (action === 'panel') {
    return runPanel({ serveOnly, fromHost })
  }
  if (action === 'app') {
    return runAppWindow()
  }
  if (action === 'desktop') {
    const paths = ensureStateDir(statePaths())
    const layout = readLayout(paths) || captureLaunch(process)
    const cli = cliPathFromHost()
    const installed = installPanelEntry(layout.node || process.execPath, cli, { forceDesktop: true })
    const shortcuts = (installed || []).filter((item) => /[/\\]DSH Server\.(lnk|app|desktop)$/.test(item))
    if (shortcuts.length === 0) {
      throw new Error('could not write Desktop shortcut (no Desktop folder found)')
    }
    return { ok: true, action: 'desktop', paths: installed }
  }
  if (!isAction(action)) {
    throw new Error(`usage: dsh-rebooter <${ALL_ACTIONS.join('|')}|supervisor|panel|app|desktop>`)
  }
  const open = forceOpen ? true : noOpen ? false : undefined
  return performAction(action, { fromHost, open })
}

function printCliHelp() {
  const lines = [
    `dsh-rebooter <action> | supervisor | panel | app | desktop`,
    '',
    'Service:',
    '  start               start DSH (no-op if already running); opens UI only if prefs.autoOpen or --open',
    '  stop                stop the supervisor and the web host',
    '  restart             stop, then start',
    '  open                open the bound app or the page window at the DSH URL',
    '',
    'Plugins (profile):',
    '  update              update every profile plugin (DSH stays down)',
    '  update-stop         stop, then update every profile plugin',
    '  update-restart      stop, update every profile plugin, then start',
    '',
    'DSH install (git / npm):',
    '  update-dsh          upgrade the recorded DSH harness (DSH stays down)',
    '  update-dsh-stop     stop, then upgrade the recorded DSH harness',
    '  update-dsh-restart  stop, upgrade DSH, then start',
    '',
    'Other:',
    '  panel               open the DSH Server status panel',
    '  app                 open the DSH page in its own window',
    '  desktop             put DSH Server on the Desktop again',
  ]
  return lines.join('\n')
}

export { printCliHelp, runCli }
