/**
 * dsh-rebooter-cli.js — command entry for start / stop / restart / update.
 *
 * Invoked as `node lib/cli.cjs <action>`. The Host half also spawns this
 * file detached so close/update can finish after the web process is gone.
 */

async function runCli(argv = process.argv) {
  const args = argv.slice(2)
  const action = args[0] && !args[0].startsWith('-') ? args[0] : 'start'
  const fromHost = args.includes('--from-host')
  const noOpen = args.includes('--no-open')
  if (action === 'supervisor') {
    return runSupervisor({ fromHost })
  }
  if (action === 'desktop') {
    const paths = ensureStateDir(statePaths())
    const layout = readLayout(paths) || captureLaunch(process)
    const cli = cliPathFromHost()
    const installed = installDesktopLauncher(layout.node || process.execPath, cli)
    if (installed === undefined) throw new Error('no Desktop directory')
    return { ok: true, action: 'desktop', path: installed }
  }
  if (!isAction(action)) {
    throw new Error(`usage: dsh-rebooter <${ALL_ACTIONS.join('|')}|supervisor|desktop>`)
  }
  return performAction(action, { fromHost, open: !noOpen })
}

function printCliHelp() {
  const lines = [
    `dsh-rebooter ${ALL_ACTIONS.join('|')} | supervisor | desktop`,
    '  start            start DSH (no-op if already running) and open the browser',
    '  stop              stop the supervisor and the web host',
    '  restart           stop, then start',
    '  update-stop       stop, then update every profile plugin',
    '  update-restart    stop, update every profile plugin, then start',
    '  desktop           write a Start launcher to the user Desktop',
  ]
  return lines.join('\n')
}

export { printCliHelp, runCli }
