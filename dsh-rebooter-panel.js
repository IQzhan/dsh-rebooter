/**
 * dsh-rebooter-panel — status panel HTTP + HTML.
 *
 * When loaded as ESM (tests), imports core/runtime. The build strips those
 * imports and concatenates this file after core+runtime.
 *
 * @module dsh-rebooter-panel
 */

import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_HOST, DEFAULT_PORT, availableActions, captureLaunch, panelPort,
} from './dsh-rebooter-core.js'
import {
  cliPathFromHost, ensureStateDir, isWebListening,
  logSupervisor, openDshUi, performAction, readJob, readLayout,
  readPanelPrefs, readText, readWebUrl, spawnDetached, statePaths, writePanelPrefs,
} from './dsh-rebooter-runtime.js'

async function buildSnapshot(paths, layout) {
  const running = await isWebListening(layout)
  const job = readJob(paths)
  const prefs = readPanelPrefs(paths)
  const busy = job.state === 'busy'
  const actions = busy ? [] : availableActions(running)
  const url = readWebUrl(paths, layout)
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  return { running, job, prefs, actions, url, panelPort: port }
}

function panelPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DSH Server</title>
<style>
:root {
  --bg: #1a1b1e;
  --surface: #25262b;
  --border: #373a40;
  --text: #e9ecef;
  --muted: #909296;
  --accent: #4dabf7;
  --danger: #ff6b6b;
  --ok: #51cf66;
  --font: system-ui, -apple-system, Segoe UI, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--text); font: 14px/1.45 var(--font); height: auto; }
#fit { border: 1px solid var(--border); background: var(--bg); }
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  height: 36px; padding: 0 6px 0 12px; background: var(--surface);
  border-bottom: 1px solid var(--border); user-select: none; cursor: grab;
}
.titlebar:active { cursor: grabbing; }
.titlebar span { font-weight: 600; font-size: 13px; letter-spacing: 0.02em; }
.winbtns { display: flex; gap: 4px; }
.winbtns button {
  width: 32px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.winbtns button:hover { background: var(--border); color: var(--text); }
.winbtns button.close:hover { background: var(--danger); color: #fff; }
main { display: flex; flex-direction: column; padding: 12px; gap: 10px; }
.status {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.status.running .dot { background: var(--ok); }
.status.busy .dot { background: var(--accent); animation: pulse 1s ease infinite; }
.status.error .dot { background: var(--danger); }
@keyframes pulse { 50% { opacity: 0.4; } }
.status-text { flex: 1; font-size: 13px; }
.spinner {
  width: 16px; height: 16px; border: 2px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.7s linear infinite; display: none;
}
.status.busy .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.actions button {
  padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit;
}
.actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.actions button:disabled { opacity: 0.45; cursor: default; }
.actions button.primary { background: #228be6; border-color: #228be6; color: #fff; }
.actions button.primary:hover:not(:disabled) { background: #1c7ed6; border-color: #1c7ed6; color: #fff; }
.open-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.open-row button:not(.iconbtn) {
  padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit;
}
.open-row button.primary { background: #228be6; border-color: #228be6; color: #fff; }
.open-row button.primary:hover { background: #1c7ed6; }
.open-row label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; cursor: pointer; }
.open-row input[type=checkbox] { accent-color: var(--accent); }
.iconbtn {
  width: 32px; height: 32px; padding: 0; border-radius: 8px; border: 1px solid var(--border);
  background: transparent; color: var(--muted); cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center;
}
.iconbtn:hover { border-color: var(--accent); color: var(--accent); }
.log {
  max-height: 220px; overflow: auto;
  padding: 10px 12px; font: 12px/1.4 ui-monospace, monospace;
  background: #141517; border: 1px solid var(--border); border-radius: 8px;
  color: #ced4da; white-space: pre-wrap; word-break: break-word; display: none;
}
.log.visible { display: block; }
.bind-row {
  display: flex; gap: 6px; align-items: center;
}
.bind-row input {
  flex: 1; min-width: 0; padding: 7px 8px; border-radius: 8px;
  border: 1px solid var(--border); background: #141517; color: var(--text); font: inherit;
}
.bind-row button {
  padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit; white-space: nowrap;
}
.bind-row button.primary { background: #228be6; border-color: #228be6; color: #fff; }
.hidden { display: none !important; }
</style>
</head>
<body>
<div id="fit">
<header class="titlebar" id="titlebar">
  <span>DSH Server</span>
  <div class="winbtns">
    <button type="button" id="btnMin" title="最小化" aria-label="最小化">${iconMin()}</button>
    <button type="button" id="btnClose" class="close" title="关闭" aria-label="关闭">${iconClose()}</button>
  </div>
</header>
<main>
  <section class="status" id="statusStrip">
    <div class="dot"></div>
    <div class="status-text" id="statusText">加载中…</div>
    <div class="spinner"></div>
  </section>
  <div class="actions" id="actions"></div>
  <div class="open-row" id="openRow">
    <button type="button" class="primary" id="btnOpen">打开界面</button>
    <button type="button" class="iconbtn" id="btnGear" title="绑定程序">${iconGear()}</button>
    <button type="button" class="iconbtn hidden" id="btnClearApp" title="清除绑定">${iconClear()}</button>
    <label><input type="checkbox" id="autoOpen"/> 启动时打开界面</label>
  </div>
  <div class="bind-row hidden" id="bindRow">
    <input id="bindPath" type="text" spellcheck="false" placeholder="程序路径，或点浏览选择"/>
    <button type="button" id="btnBrowse">浏览</button>
    <button type="button" class="primary" id="btnBindOk">确定</button>
    <button type="button" id="btnBindCancel">取消</button>
  </div>
  <pre class="log" id="logPane"></pre>
</main>
</div>
<script>
(function () {
  const LABELS = {
    start: '启动',
    update: '更新',
    'update-restart': '更新并启动',
    stop: '关闭',
    restart: '重启',
    'update-stop': '更新并关闭',
    open: '打开界面',
  };
  function labelFor(action, running) {
    if (action === 'update-restart') return running ? '更新并重启' : '更新并启动';
    if (action === 'open') return '打开界面';
    return LABELS[action] || action;
  }
  const $ = (id) => document.getElementById(id);
  const statusStrip = $('statusStrip');
  const statusText = $('statusText');
  const actionsEl = $('actions');
  const logPane = $('logPane');
  const openRow = $('openRow');
  const autoOpen = $('autoOpen');
  const btnGear = $('btnGear');
  const btnClearApp = $('btnClearApp');
  const bindRow = $('bindRow');
  const bindPath = $('bindPath');
  let lastSnapshot = null;
  let logTail = '';

  let lastFit = '';
  function fitWindow() {
    const box = document.getElementById('fit');
    if (!box) return;
    const height = Math.ceil(box.getBoundingClientRect().height);
    const width = 440;
    if (height < 80) return;
    const key = width + 'x' + height;
    if (key === lastFit) return;
    lastFit = key;
    void postJson('/api/frame', { op: 'resize', width, height });
  }

  const titlebar = $('titlebar');
  let drag = null;
  let dragQueued = null;
  let dragSending = false;
  function flushDrag() {
    if (!dragQueued || dragSending) return;
    const body = dragQueued;
    dragQueued = null;
    dragSending = true;
    postJson('/api/frame', body).finally(() => {
      dragSending = false;
      flushDrag();
    });
  }
  titlebar.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const info = await fetch('/api/frame').then(r => r.json()).catch(() => null);
    if (!info || info.ok !== true) return;
    drag = { sx: e.screenX, sy: e.screenY, x: info.x, y: info.y };
    titlebar.setPointerCapture(e.pointerId);
  });
  titlebar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    dragQueued = {
      op: 'move',
      x: Math.round(drag.x + e.screenX - drag.sx),
      y: Math.round(drag.y + e.screenY - drag.sy),
    };
    flushDrag();
  });
  function endDrag() { drag = null; }
  titlebar.addEventListener('pointerup', endDrag);
  titlebar.addEventListener('pointercancel', endDrag);
  $('btnMin').onclick = () => void postJson('/api/frame', { op: 'minimize' });
  $('btnClose').onclick = () => void postJson('/api/frame', { op: 'close' });

  async function postJson(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
    return { ok: r.ok, status: r.status, data };
  }

  function renderStatus(s) {
    const job = s.job || {};
    const busy = job.state === 'busy';
    const err = job.state === 'error';
    statusStrip.classList.toggle('running', s.running === true && !busy);
    statusStrip.classList.toggle('busy', busy);
    statusStrip.classList.toggle('error', err);
    let text = '';
    if (busy) text = job.message || '正在执行…';
    else if (err) text = job.message || job.error || '上次操作失败';
    else if (s.running) text = 'DSH 运行中';
    else text = 'DSH 已停止';
    statusText.textContent = text;
    const showLog = busy || err;
    logPane.classList.toggle('visible', showLog);
    if (showLog && logTail) {
      logPane.textContent = logTail;
      logPane.scrollTop = logPane.scrollHeight;
    }
  }

  function renderActions(s) {
    actionsEl.innerHTML = '';
    const list = Array.isArray(s.actions) ? s.actions : [];
    const busy = s.job && s.job.state === 'busy';
    for (const action of list) {
      if (action === 'open') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = labelFor(action, s.running === true);
      btn.disabled = busy;
      btn.onclick = () => void runAction(action);
      if (action === 'start' || action === 'restart') btn.classList.add('primary');
      actionsEl.appendChild(btn);
    }
  }

  function renderPrefs(s) {
    const p = s.prefs || {};
    autoOpen.checked = p.autoOpen === true;
    const bound = typeof p.openApp === 'string' && p.openApp.length > 0;
    btnGear.classList.toggle('hidden', bound);
    btnClearApp.classList.toggle('hidden', !bound);
    openRow.style.opacity = s.running === false && !(s.job && s.job.state === 'busy') ? '1' : '1';
  }

  async function runAction(action) {
    const { ok, status, data } = await postJson('/api/action', { action });
    if (status === 409) statusText.textContent = '已有任务进行中';
    else if (!ok && data.error) statusText.textContent = data.error;
  }

  async function refreshLog() {
    try {
      const r = await fetch('/api/log');
      if (!r.ok) return;
      const t = await r.text();
      if (t !== logTail) {
        logTail = t;
        if (logPane.classList.contains('visible')) {
          logPane.textContent = t;
          logPane.scrollTop = logPane.scrollHeight;
        }
      }
    } catch { /* ignore */ }
  }

  async function tick() {
    try {
      const r = await fetch('/api/snapshot');
      if (!r.ok) return;
      lastSnapshot = await r.json();
      renderStatus(lastSnapshot);
      renderActions(lastSnapshot);
      renderPrefs(lastSnapshot);
      await refreshLog();
      fitWindow();
    } catch { /* ignore */ }
  }

  function saveOpenApp(value) {
    const p = lastSnapshot && lastSnapshot.prefs ? { ...lastSnapshot.prefs } : {};
    p.openApp = value;
    void postJson('/api/prefs', p);
  }
  $('btnOpen').onclick = () => void postJson('/api/open', {});
  autoOpen.onchange = () => {
    const p = lastSnapshot && lastSnapshot.prefs ? { ...lastSnapshot.prefs } : {};
    p.autoOpen = autoOpen.checked;
    void postJson('/api/prefs', p);
  };
  btnGear.onclick = () => {
    bindRow.classList.remove('hidden');
    bindPath.focus();
    fitWindow();
  };
  $('btnBrowse').onclick = async () => {
    const { data } = await postJson('/api/frame', { op: 'pick' });
    if (data && typeof data.path === 'string' && data.path.length > 0) bindPath.value = data.path;
    fitWindow();
  };
  $('btnBindOk').onclick = () => {
    const trimmed = bindPath.value.trim();
    if (trimmed.length === 0) return;
    saveOpenApp(trimmed);
    bindRow.classList.add('hidden');
    fitWindow();
  };
  $('btnBindCancel').onclick = () => {
    bindRow.classList.add('hidden');
    fitWindow();
  };
  btnClearApp.onclick = () => {
    bindPath.value = '';
    bindRow.classList.add('hidden');
    saveOpenApp(null);
    fitWindow();
  };

  tick();
  setInterval(tick, 500);
})();
</script>
</body>
</html>`
}

function iconMin() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 11h10"/></svg>'
}

function iconClose() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l8 8M11 3L3 11"/></svg>'
}

function iconGear() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 13.5a7.7 7.7 0 0 0 .1-1.5 7.7 7.7 0 0 0-.1-1.5l2-1.6-2-3.4-2.4 1a7.8 7.8 0 0 0-2.6-1.5L14 2h-4l-.4 2.5a7.8 7.8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0-.1 1.5 7.7 7.7 0 0 0 .1 1.5l-2 1.6 2 3.4 2.4-1a7.8 7.8 0 0 0 2.6 1.5L10 22h4l.4-2.5a7.8 7.8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6z"/></svg>'
}

function iconClear() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 6L6 18M6 6l12 12"/></svg>'
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function runActionBackground(paths, layout, action) {
  void (async () => {
    try {
      await performAction(action, {})
    } catch {
      /* performAction already recorded the job error */
    }
  })()
}

function startPanelServer(paths, layout, options = {}) {
  let focusRequested = false
  const html = panelPageHtml()
  const host = DEFAULT_HOST
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (req.method === 'GET' && (path === '' || path === '/' || path === '/panel')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (req.method === 'GET' && path === '/api/snapshot') {
        const snapshot = await buildSnapshot(paths, layout)
        sendJson(res, 200, snapshot)
        return
      }
      if (req.method === 'GET' && path === '/api/log') {
        const log = readText(paths.jobLog) ?? ''
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(log)
        return
      }
      if (req.method === 'GET' && path === '/api/focus') {
        const focus = focusRequested
        focusRequested = false
        sendJson(res, 200, { ok: true, focus })
        return
      }
      if (req.method === 'POST' && path === '/api/focus') {
        focusRequested = true
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && path === '/api/prefs') {
        const body = await readRequestBody(req)
        const cur = readPanelPrefs(paths)
        const prefs = writePanelPrefs(paths, {
          autoOpen: body.autoOpen !== undefined ? body.autoOpen === true : cur.autoOpen,
          openApp: body.clearApp === true
            ? null
            : (body.openApp !== undefined ? body.openApp : cur.openApp),
        })
        sendJson(res, 200, { ok: true, prefs })
        return
      }
      if (req.method === 'POST' && path === '/api/open') {
        const result = openDshUi(paths, layout)
        sendJson(res, 200, result)
        return
      }
      if (req.method === 'GET' && path === '/api/frame') {
        sendJson(res, 200, frameGeometry())
        return
      }
      if (req.method === 'POST' && path === '/api/frame') {
        const body = await readRequestBody(req)
        sendJson(res, 200, applyFrameOp(body))
        return
      }
      if (req.method === 'POST' && path === '/api/action') {
        const body = await readRequestBody(req)
        const action = body?.action
        if (!isAction(action)) {
          sendJson(res, 400, { ok: false, error: `unknown action ${JSON.stringify(action)}` })
          return
        }
        const job = readJob(paths)
        if (job.state === 'busy') {
          sendJson(res, 409, { ok: false, error: 'busy' })
          return
        }
        runActionBackground(paths, layout, action)
        sendJson(res, 202, { ok: true, accepted: true, action })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, error: message })
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const panelUrl = `http://${host}:${port}/`
      logSupervisor(paths, `panel listening ${panelUrl}`)
      resolve({ server, port, url: panelUrl })
    })
  })
}

let frameHost = null

function frameWindow() {
  const shell = frameHost?.window
  if (!shell) return null
  try {
    if (typeof shell.isDisposed === 'function' && shell.isDisposed()) return null
  } catch {
    return null
  }
  return shell
}

function frameGeometry() {
  const shell = frameWindow()
  if (!shell) return { ok: false }
  let pos = null
  let size = null
  try { pos = shell.getPosition(true) } catch { pos = null }
  try { size = shell.getOuterSize(true) } catch { size = null }
  return {
    ok: true,
    x: Number(pos?.x ?? shell.x) || 0,
    y: Number(pos?.y ?? shell.y) || 0,
    width: Number(size?.width ?? shell.width) || 0,
    height: Number(size?.height ?? shell.height) || 0,
  }
}

function revealFrame() {
  const shell = frameWindow()
  if (!shell) return false
  try {
    if (typeof shell.isMinimized === 'function' && shell.isMinimized()) shell.setMinimized(false)
    shell.show()
    shell.focus()
    return true
  } catch {
    return false
  }
}

function applyFrameOp(body) {
  const op = body?.op
  if (op === 'show') return { ok: true, shown: revealFrame() }
  const shell = frameWindow()
  if (!shell) return { ok: false, shown: false }
  if (op === 'move') {
    const x = Number(body.x) || 0
    const y = Number(body.y) || 0
    try { shell.setPosition(x, y, true) } catch { shell.setPosition(x, y) }
    return { ok: true }
  }
  if (op === 'resize') {
    const width = Math.max(320, Math.min(800, Number(body.width) || 440))
    const height = Math.max(160, Math.min(720, Number(body.height) || 280))
    try { shell.setSize(width, height, true) } catch { shell.setSize(width, height) }
    return { ok: true }
  }
  if (op === 'minimize') {
    shell.setMinimized(true)
    return { ok: true }
  }
  if (op === 'close') {
    shell.hide()
    return { ok: true }
  }
  if (op === 'pick') {
    let files = []
    try {
      files = shell.openFileDialog({
        title: '选择要绑定的程序',
        multiple: false,
      }) || []
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const picked = Array.isArray(files) ? files.find(item => typeof item === 'string' && item.length > 0) : null
    return { ok: true, path: picked || null }
  }
  return { ok: false }
}

async function loadFrameApplication() {
  const { createRequire } = await import('node:module')
  const { dirname, join: joinPath } = await import('node:path')
  const here = typeof __dirname === 'string' ? __dirname : dirname(process.argv[1] || '')
  for (const base of [joinPath(here, '..'), joinPath(here, '..', '..')]) {
    try {
      const loaded = createRequire(joinPath(base, 'package.json'))('@webviewjs/webview')
      const Application = loaded.Application || loaded.default?.Application
      if (typeof Application === 'function') return Application
    } catch {
      /* try the next install root */
    }
  }
  try {
    const mod = await import('@webviewjs/webview')
    return mod.Application || mod.default?.Application || null
  } catch {
    return null
  }
}

async function showFrameless(url, paths) {
  if (revealFrame()) return true
  let Application
  try {
    Application = await loadFrameApplication()
  } catch (error) {
    logSupervisor(paths, `frameless window: ${error instanceof Error ? error.message : error}`)
    return false
  }
  if (typeof Application !== 'function') {
    logSupervisor(paths, 'frameless window: host module has no Application')
    return false
  }
  const app = new Application()
  const shell = app.createBrowserWindow({
    title: 'DSH Server',
    width: 440,
    height: 220,
    decorations: false,
    resizable: false,
    minimizable: true,
    maximizable: false,
  })
  if (typeof shell.setHasShadow === 'function') {
    try { shell.setHasShadow(false) } catch { /* host may not support it */ }
  }
  const dataDir = join(paths.root, 'frame')
  mkdirSync(dataDir, { recursive: true })
  const webContext = app.createWebContext({ dataDirectory: dataDir })
  let webview
  try {
    webview = shell.createWebview({ url, webContext })
  } catch (error) {
    logSupervisor(paths, `frameless window: ${error instanceof Error ? error.message : error}`)
    try { shell.close() } catch { /* already dead */ }
    return false
  }
  frameHost = { app, window: shell, webview }
  try {
    if (typeof app.whenReady === 'function') {
      await Promise.race([
        app.whenReady({ interval: 16, ref: true }),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ])
    } else if (typeof app.run === 'function') {
      app.run({ interval: 16, ref: true })
    }
  } catch (error) {
    logSupervisor(paths, `frameless pump: ${error instanceof Error ? error.message : error}`)
  }
  revealFrame()
  return true
}

async function postFrame(url, body) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 800)
  try {
    const response = await fetch(new URL('/api/frame', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) return false
    const data = await response.json()
    return data.shown === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function openPanelWindow(url, paths, options = {}) {
  if (typeof url !== 'string' || url.length === 0) return false
  if (options.reuse === true) {
    const shown = await postFrame(url, { op: 'show' })
    if (!shown) logSupervisor(paths, 'running panel has no frameless window to show')
    return shown
  }
  return showFrameless(url, paths)
}

function forever() {
  return new Promise(() => {})
}

async function panelSnapshotReachable(port) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1500)
  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/api/snapshot`, { signal: ac.signal })
    if (!response.ok) return false
    await response.json()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function runPanel(options = {}) {
  const home = options.home
  const paths = ensureStateDir(statePaths(home))
  const layout = readLayout(paths) || captureLaunch(process)
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const baseUrl = `http://${DEFAULT_HOST}:${port}/`

  let bound
  try {
    bound = await startPanelServer(paths, layout, options)
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      logSupervisor(paths, 'panel already running (port in use)')
      if (options.serveOnly !== true) await openPanelWindow(baseUrl, paths, { reuse: true })
      return { ok: true, port, url: baseUrl, reused: true }
    }
    throw error
  }

  if (options.serveOnly !== true) await openPanelWindow(bound.url, paths)
  await forever()
  return { ok: true, port: bound.port, url: bound.url }
}

async function ensurePanelVisible(paths, layout) {
  try {
    const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
    const url = `http://${DEFAULT_HOST}:${port}/`
    if (await panelSnapshotReachable(port)) {
      await openPanelWindow(url, paths, { reuse: true })
      return { ok: true, url, already: true }
    }
    const cli = cliPathFromHost()
    const node = layout?.node || process.execPath
    spawnDetached(node, [cli, 'panel'], { cwd: layout?.cwd || process.cwd() })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await panelSnapshotReachable(port)) {
        await openPanelWindow(url, paths, { reuse: true })
        return { ok: true, url, spawned: true }
      }
      await sleep(200)
    }
    await openPanelWindow(url, paths, { reuse: true })
    return { ok: true, url, timeout: true }
  } catch (error) {
    logSupervisor(paths, `ensurePanelVisible: ${error instanceof Error ? error.message : error}`)
    return { ok: false }
  }
}

export {
  buildSnapshot,
  ensurePanelVisible,
  panelPageHtml,
  runPanel,
  startPanelServer,
}
