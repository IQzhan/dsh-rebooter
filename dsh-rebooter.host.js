/**
 * dsh-rebooter.host.js — Cordis adapter.
 *
 * Records how this process was launched, keeps a supervisor watching it so a
 * closed terminal does not end DSH, and exposes a small HTTP surface the
 * Client menu posts to. Stop / restart / update are dispatched to `cli.cjs`
 * as a detached process: those actions must outlive this Host.
 *
 * Returns nothing from `mountRebooter`. Cordis treats `apply`'s return as the
 * plugin effect and rejects a plain object with `Invalid effect`, which takes
 * the whole profile tree down.
 */

function mountRebooter(ctx) {
  const paths = ensureStateDir(statePaths(resolveHome(process.env)))
  const layout = mergeLayout(paths, captureLaunch(process))
  logSupervisor(paths, `host mounted pid=${process.pid} port=${layout.port}`)

  // One-shot adopt: the Host (long-lived) must own the supervisor. A supervisor
  // left parented by a short-lived CLI can be Job-killed when that CLI exits.
  // Release+respawn never signals DSH — agents may be mid-turn. No heartbeat.
  void adoptSupervisor(paths, layout).then((ok) => {
    logSupervisor(paths, ok
      ? 'supervisor adopted at mount'
      : 'supervisor adopt failed at mount')
  }).catch((error) => {
    logSupervisor(paths, `supervisor adopt failed: ${error instanceof Error ? error.message : error}`)
  })

  // First mount only: write the Desktop shortcut once. Later mounts leave a deleted icon alone.
  try {
    const cli = cliPathFromHost()
    installPanelEntry(layout.node || process.execPath, cli)
  } catch (error) {
    logSupervisor(paths, `panel entry install skipped: ${error instanceof Error ? error.message : error}`)
  }

  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.length === 0) return {}
    return JSON.parse(raw)
  }

  const health = async () => ({
    ok: true,
    name: PLUGIN_NAME,
    pid: process.pid,
    port: layout.port,
    supervisor: await supervisorAlive(layout),
    listening: await isWebListening(layout),
    layout: {
      cwd: layout.cwd,
      profile: layout.profile,
      port: layout.port,
    },
  })

  const serve = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = decodeURIComponent(url.pathname.replace(/^\/api\/dsh-rebooter\/?/, '')) || 'health'
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (method === 'health' && (req.method === 'GET' || req.method === 'HEAD')) {
        send(200, await health())
        return
      }
      if (method === 'ensure-supervisor' && req.method === 'POST') {
        const ok = await adoptSupervisor(paths, layout)
        send(200, { ok, supervisor: ok })
        return
      }
      if (method === 'action' && req.method === 'POST') {
        const body = await readBody(req)
        const action = body?.action
        if (!isMenuAction(action)) {
          send(400, { ok: false, error: `unknown action ${JSON.stringify(action)}` })
          return
        }
        dispatchCli(action, ['--from-host'], { dshHome: layout.dshHome, cwd: layout.cwd })
        void ensurePanelVisible(paths, layout)
        send(200, { ok: true, action, dispatched: true })
        return
      }
      send(404, { error: `unknown method ${JSON.stringify(method)}` })
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const registerRoute = (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix', path: '/api/dsh-rebooter', handler: serve,
    }), `${PLUGIN_NAME}: http`)
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerRoute)
  else {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
    if (webServer !== undefined && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'prefix', path: '/api/dsh-rebooter', handler: serve,
      }), `${PLUGIN_NAME}: http`)
    }
  }
}

export { mountRebooter }
