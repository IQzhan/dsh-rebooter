/**
 * dsh-rebooter-panel — status panel HTTP + HTML.
 *
 * When loaded as ESM (tests), imports core/runtime. The build strips those
 * imports and concatenates this file after core+runtime.
 *
 * @module dsh-rebooter-panel
 */

import http from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROFILE, availableActions, captureLaunch, isAction, panelPort,
} from './dsh-rebooter-core.js'
import {
  cliPathFromHost, currentAppDataDir, dispatchCli, ensureStateDir, installPanelEntry, isTokenizedWebUrl, isWebListening,
  logSupervisor, openDshUi, openDshUiAsync, openUrl, readJob, readLayout,
  readPanelPrefs, readText, readWebUrl, removeFile, resetAppWebViewData, sleep, spawnDetached,
  statePaths, writePanelPrefs, writePidFile,
} from './dsh-rebooter-runtime.js'

function parseQuotedYamlScalar(raw) {
  let value = String(raw ?? '').trim()
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  const comment = value.indexOf(' #')
  if (comment >= 0) value = value.slice(0, comment).trim()
  return value
}

/** Current DSH persists locale / ui-theme in the profile patch, not settings.yaml. */
function readAppearanceFromPatch(text) {
  const found = { locale: '', theme: 'system' }
  if (typeof text !== 'string' || text.length === 0) return found
  let id = ''
  for (const raw of text.split('\n')) {
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(raw)
    if (idMatch) {
      id = idMatch[1]
      continue
    }
    if (id !== 'locale' && id !== 'ui-theme') continue
    const pref = /^\s+preference:\s*(.+)\s*$/.exec(raw)
    if (!pref) continue
    const value = parseQuotedYamlScalar(pref[1])
    if (id === 'locale') {
      if (value === 'zh' || value === 'en') found.locale = value
    } else if (value === 'light' || value === 'dark' || value === 'system') {
      found.theme = value
    }
  }
  return found
}

/** Legacy `$DSH_HOME/settings.yaml` shape kept as a one-release fallback. */
function readAppearanceFromLegacySettings(text) {
  const found = { locale: '', theme: 'system' }
  if (typeof text !== 'string' || text.length === 0) return found
  let section = ''
  for (const raw of text.split('\n')) {
    if (raw.length === 0 || raw.startsWith('#')) continue
    if (raw[0] !== ' ' && raw[0] !== '\t') {
      const cut = raw.indexOf(':')
      section = cut > 0 ? raw.slice(0, cut).trim() : ''
      continue
    }
    if (section !== 'locale' && section !== 'ui-theme') continue
    const line = raw.trim()
    if (!line.startsWith('preference:')) continue
    const value = parseQuotedYamlScalar(line.slice('preference:'.length))
    if (section === 'locale') {
      if (value === 'zh' || value === 'en') found.locale = value
    } else if (value === 'light' || value === 'dark' || value === 'system') {
      found.theme = value
    }
  }
  return found
}

function readUserAppearance(home, profile = DEFAULT_PROFILE) {
  const fallback = { locale: '', theme: 'system' }
  if (typeof home !== 'string' || home.length === 0) return fallback
  const profileId = typeof profile === 'string' && profile.trim() ? profile.trim() : DEFAULT_PROFILE
  try {
    const patch = readFileSync(join(home, 'profiles', profileId, 'cordis.patch.yml'), 'utf8')
    return readAppearanceFromPatch(patch)
  } catch { /* fall through to legacy settings.yaml */ }
  for (const name of ['settings.yaml', 'settings.yml']) {
    try {
      return readAppearanceFromLegacySettings(readFileSync(join(home, name), 'utf8'))
    } catch { /* try next */ }
  }
  return fallback
}

async function buildSnapshot(paths, layout) {
  const running = await isWebListening(layout)
  const job = readJob(paths)
  const prefs = readPanelPrefs(paths)
  const busy = job.state === 'busy'
  const actions = busy ? [] : availableActions(running)
  const url = readWebUrl(paths, layout)
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const home = typeof layout?.dshHome === 'string' && layout.dshHome.trim()
    ? layout.dshHome.trim()
    : dirname(paths.root)
  return {
    running,
    job,
    prefs,
    actions,
    url,
    panelPort: port,
    appearance: readUserAppearance(home, layout?.profile),
  }
}

function panelPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DSH Server</title>
<style>
:root {
  color-scheme: light;
  --bg: #fff;
  --surface: #fff;
  --border: rgba(0, 0, 0, 0.1);
  --text: rgb(15, 17, 21);
  --muted: rgb(97, 102, 107);
  --accent: rgb(65, 118, 230);
  --danger: rgb(236, 19, 19);
  --ok: rgb(34, 197, 94);
  --hover: rgba(38, 49, 72, 0.06);
  --primary: rgb(15, 17, 21);
  --on-primary: #fff;
  --field: rgb(249, 250, 251);
  --log: rgb(245, 246, 247);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "SF Mono", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
}
body[data-ds-dark-theme] {
  color-scheme: dark;
  --bg: rgb(21, 21, 23);
  --surface: rgb(35, 35, 36);
  --border: rgba(255, 255, 255, 0.12);
  --text: rgb(249, 250, 251);
  --muted: rgb(173, 178, 184);
  --accent: rgb(103, 158, 254);
  --danger: rgb(242, 90, 90);
  --ok: rgb(34, 197, 94);
  --hover: rgba(255, 255, 255, 0.08);
  --primary: rgb(249, 250, 251);
  --on-primary: rgb(15, 17, 21);
  --field: rgb(27, 27, 28);
  --log: rgb(27, 27, 28);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--text); font: 14px/22px var(--font); height: auto; overflow: hidden; }
#fit { background: var(--bg); }
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  height: 40px; padding: 0 8px 0 14px; background: var(--bg);
  border-bottom: 1px solid var(--border); user-select: none; cursor: default;
}
.titlebar span { font-weight: 600; font-size: 13px; line-height: 20px; }
.winbtns { display: flex; gap: 1px; }
.winbtns button {
  width: 32px; height: 26px; border: 0; border-radius: 5px;
  background: transparent; color: var(--text); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.winbtns button:hover { background: var(--hover); }
.winbtns button.close:hover { background: #c42b1c; color: #fff; }
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
.actions { display: flex; flex-direction: column; gap: 10px; }
.action-row, .action-group-row { display: flex; flex-wrap: wrap; gap: 8px; }
.action-group-title { font-size: 11px; line-height: 16px; color: var(--muted); letter-spacing: 0.02em; }
.actions button {
  padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit;
}
.actions button:hover:not(:disabled) { background: var(--hover); }
.actions button:disabled { opacity: 0.45; cursor: default; }
.actions button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.actions button.primary:hover:not(:disabled) { background: var(--primary); border-color: var(--primary); color: var(--on-primary); filter: brightness(1.08); }
.open-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.open-row button:not(.iconbtn) {
  padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit;
}
.open-row button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.open-row button.primary:hover { filter: brightness(1.08); }
.open-row label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; cursor: pointer; }
.open-row input[type=checkbox] { accent-color: var(--accent); }
.iconbtn {
  width: 32px; height: 32px; padding: 0; border-radius: 8px; border: 1px solid var(--border);
  background: transparent; color: var(--muted); cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center;
}
.iconbtn:hover { background: var(--hover); color: var(--text); }
.log {
  max-height: 220px; overflow: auto;
  padding: 10px 12px; font: 12px/18px var(--mono);
  background: var(--log); border: 1px solid var(--border); border-radius: 10px;
  color: var(--muted); white-space: pre-wrap; word-break: break-word; display: none;
}
.log.visible { display: block; }
.bind-row {
  display: flex; gap: 6px; align-items: center;
}
.bind-row input {
  flex: 1; min-width: 0; padding: 7px 8px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--field); color: var(--text); font: inherit;
}
.bind-row button {
  padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font: inherit; white-space: nowrap;
}
.bind-row button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.hidden { display: none !important; }
</style>
</head>
<body>
<div id="fit">
<header class="titlebar" id="titlebar">
  <span>DSH Server</span>
  <div class="winbtns">
    <button type="button" id="btnMin" title="Minimize" aria-label="Minimize">${iconMin()}</button>
    <button type="button" id="btnClose" class="close" title="Close" aria-label="Close">${iconClose()}</button>
  </div>
</header>
<main>
  <section class="status" id="statusStrip">
    <div class="dot"></div>
    <div class="status-text" id="statusText">Loading…</div>
    <div class="spinner"></div>
  </section>
  <div class="actions" id="actions"></div>
  <div class="open-row" id="openRow">
    <button type="button" class="primary" id="btnOpen">Open UI</button>
    <button type="button" class="iconbtn" id="btnGear" title="Bind a program">${iconGear()}</button>
    <button type="button" class="iconbtn hidden" id="btnClearApp" title="Clear binding">${iconClear()}</button>
    <label><input type="checkbox" id="autoOpen"/> <span id="autoOpenLabel">Open UI when DSH starts</span></label>
    <button type="button" id="btnDesktop">Put on Desktop</button>
  </div>
  <div class="bind-row hidden" id="bindRow">
    <input id="bindPath" type="text" spellcheck="false" placeholder="Program path, or browse"/>
    <button type="button" id="btnBrowse">Browse</button>
    <button type="button" class="primary" id="btnBindOk">OK</button>
    <button type="button" id="btnBindCancel">Cancel</button>
  </div>
  <pre class="log" id="logPane"></pre>
</main>
</div>
<script>
(function () {
function localeId() {
  const tags = [];
  const list = navigator.languages;
  if (list) for (let i = 0; i < list.length; i++) tags.push(String(list[i] || ''));
  if (navigator.language) tags.push(String(navigator.language));
  const known = ['zh', 'en'];
  for (let i = 0; i < tags.length; i++) {
    const requested = tags[i].toLowerCase();
    const dash = requested.indexOf('-');
    const primary = dash < 0 ? requested : requested.slice(0, dash);
    for (let k = 0; k < known.length; k++) {
      if (known[k] === requested || known[k] === primary) return known[k];
    }
  }
  return 'en';
}
let themePref = 'system';
function resolveDark(theme) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark' || theme === 'system') themePref = theme;
  const dark = resolveDark(themePref);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
}
applyTheme('system');
if (typeof matchMedia === 'function') {
  const media = matchMedia('(prefers-color-scheme: dark)');
  if (typeof media.addEventListener === 'function') media.addEventListener('change', () => applyTheme(themePref));
}
const COPY = {
  zh: {
    'min': '最小化',
    'close': '关闭',
    'loading': '加载中…',
    'working': '正在执行…',
    'failed': '上次操作失败',
    'running': 'DSH 运行中',
    'stopped': 'DSH 已停止',
    'busy': '已有任务进行中',
    'open': '打开界面',
    'bind': '绑定程序',
    'clear': '清除绑定',
    'autoOpen': '开启服务时打开界面',
    'pathPlaceholder': '程序路径，或点浏览选择',
    'browse': '浏览',
    'ok': '确定',
    'cancel': '取消',
    'start': '开启服务',
    'update': '更新插件',
    'update-start': '更新插件并开启服务',
    'update-restart': '更新插件并重启服务',
    'stop': '关闭服务',
    'restart': '重启服务',
    'update-stop': '更新插件并关闭服务',
    'update-dsh': '更新 DSH',
    'update-dsh-start': '更新 DSH 并开启服务',
    'update-dsh-restart': '更新 DSH 并重启服务',
    'update-dsh-stop': '更新 DSH 并关闭服务',
    'groupPlugins': '插件',
    'groupDsh': 'DSH',
    'desktop': '放到桌面',
    'desktopDone': '已放到桌面',
  },
  en: {
    'min': 'Minimize',
    'close': 'Close',
    'loading': 'Loading…',
    'working': 'Working…',
    'failed': 'Last action failed',
    'running': 'DSH is running',
    'stopped': 'DSH is stopped',
    'busy': 'Another action is already running',
    'open': 'Open UI',
    'bind': 'Bind a program',
    'clear': 'Clear binding',
    'autoOpen': 'Open UI when the service starts',
    'pathPlaceholder': 'Program path, or browse',
    'browse': 'Browse',
    'ok': 'OK',
    'cancel': 'Cancel',
    'start': 'Start service',
    'update': 'Update plugins',
    'update-start': 'Update plugins and start service',
    'update-restart': 'Update plugins and restart service',
    'stop': 'Stop service',
    'restart': 'Restart service',
    'update-stop': 'Update plugins and stop service',
    'update-dsh': 'Update DSH',
    'update-dsh-start': 'Update DSH and start service',
    'update-dsh-restart': 'Update DSH and restart service',
    'update-dsh-stop': 'Update DSH and stop service',
    'groupPlugins': 'Plugins',
    'groupDsh': 'DSH',
    'desktop': 'Put on Desktop',
    'desktopDone': 'Shortcut is on the Desktop',
  },
}
  let desktopNoteUntil = 0;
  let lang = localeId();
  let t = COPY[lang] || COPY.en;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  function labelFor(action, running) {
    if (action === 'update-restart') return running ? t['update-restart'] : t['update-start'];
    if (action === 'update-dsh-restart') return running ? t['update-dsh-restart'] : t['update-dsh-start'];
    return t[action] || action;
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
    const height = Math.ceil(box.scrollHeight);
    const width = 440;
    if (height < 80) return;
    const key = width + 'x' + height;
    if (key === lastFit) return;
    lastFit = key;
    void postJson('/api/frame', { op: 'resize', width, height }).then((result) => {
      if (!result || result.ok !== true) lastFit = '';
    });
  }
  const fitTarget = document.getElementById('fit');
  if (fitTarget && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => fitWindow()).observe(fitTarget);
  }

  const titlebar = $('titlebar');
  let moveQueued = null;
  let pumping = false;
  let dragging = false;
  function post(msg) {
    if (!window.ipc || typeof window.ipc.postMessage !== 'function') return;
    window.ipc.postMessage(msg);
  }
  function pumpMove() {
    pumping = false;
    if (!moveQueued) return;
    const msg = moveQueued;
    moveQueued = null;
    post(msg);
  }
  titlebar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    dragging = true;
    try { titlebar.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
    post('d0:' + Math.round(e.screenX) + ':' + Math.round(e.screenY));
  });
  titlebar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    moveQueued = 'd1:' + Math.round(e.screenX) + ':' + Math.round(e.screenY);
    if (!pumping) { pumping = true; requestAnimationFrame(pumpMove); }
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    moveQueued = null;
    post('d2');
  }
  titlebar.addEventListener('pointerup', endDrag);
  titlebar.addEventListener('pointercancel', endDrag);
  $('btnMin').onclick = () => post('min');
  $('btnClose').onclick = () => post('close');

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
    const busy = job.state === 'busy' || pendingAction !== null;
    const err = !busy && job.state === 'error';
    statusStrip.classList.toggle('running', s.running === true && !busy);
    statusStrip.classList.toggle('busy', busy);
    statusStrip.classList.toggle('error', err);
    let text = '';
    if (busy) {
      const action = pendingAction || job.action;
      text = action ? labelFor(action, s.running === true) : t.working;
    } else if (err) {
      const detail = typeof job.error === 'string' ? job.error.trim() : '';
      text = detail ? detail : t.failed;
    } else if (Date.now() < desktopNoteUntil) text = t.desktopDone;
    else if (s.running) text = t.running;
    else text = t.stopped;
    statusText.textContent = text;
    const showLog = busy || err;
    logPane.classList.toggle('visible', showLog);
    if (showLog && logTail) {
      logPane.textContent = logTail;
      logPane.scrollTop = logPane.scrollHeight;
    }
  }

  let actionsSig = '';
  function renderActions(s) {
    const list = Array.isArray(s.actions) ? s.actions : [];
    const busy = (s.job && s.job.state === 'busy') || pendingAction !== null;
    const sig = lang + '|' + (s.running === true ? '1' : '0') + '|' + (busy ? '1' : '0') + '|' + list.join(',');
    if (sig === actionsSig) {
      const buttons = actionsEl.querySelectorAll('button[data-action]');
      for (let i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
      return;
    }
    actionsSig = sig;
    actionsEl.innerHTML = '';
    const serviceIds = new Set(['stop', 'restart', 'start']);
    const pluginIds = new Set(['update', 'update-stop', 'update-restart']);
    const dshIds = new Set(['update-dsh', 'update-dsh-stop', 'update-dsh-restart']);
    function makeButton(action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = action;
      btn.textContent = labelFor(action, s.running === true);
      btn.disabled = busy;
      if (action === 'start' || action === 'restart') btn.classList.add('primary');
      return btn;
    }
    function appendRow(ids) {
      const items = list.filter((action) => ids.has(action));
      if (items.length === 0) return null;
      const row = document.createElement('div');
      row.className = 'action-row';
      for (const action of items) row.appendChild(makeButton(action));
      return row;
    }
    function appendGroup(titleKey, ids) {
      const items = list.filter((action) => ids.has(action));
      if (items.length === 0) return;
      const group = document.createElement('div');
      group.className = 'action-group';
      const title = document.createElement('div');
      title.className = 'action-group-title';
      title.textContent = t[titleKey] || titleKey;
      group.appendChild(title);
      const row = document.createElement('div');
      row.className = 'action-group-row';
      for (const action of items) row.appendChild(makeButton(action));
      group.appendChild(row);
      actionsEl.appendChild(group);
    }
    const service = appendRow(serviceIds);
    if (service) actionsEl.appendChild(service);
    appendGroup('groupPlugins', pluginIds);
    appendGroup('groupDsh', dshIds);
  }

  function renderPrefs(s) {
    const p = s.prefs || {};
    autoOpen.checked = p.autoOpen === true;
    const bound = typeof p.openApp === 'string' && p.openApp.length > 0;
    btnGear.classList.toggle('hidden', bound);
    btnClearApp.classList.toggle('hidden', !bound);
  }

  let pendingAction = null;
  actionsEl.addEventListener('click', (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action) void runAction(action);
  });

  async function runAction(action) {
    if (pendingAction) return;
    pendingAction = action;
    if (lastSnapshot) renderStatus(lastSnapshot);
    if (lastSnapshot) renderActions(lastSnapshot);
    try {
      const { ok, status, data } = await postJson('/api/action', { action });
      if (status === 409) statusText.textContent = t.busy;
      else if (!ok && data && data.error) statusText.textContent = data.error;
    } catch (error) {
      statusText.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      pendingAction = null;
    }
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

  function applyAppearance(appearance) {
    const picked = appearance && appearance.locale;
    const nextLang = picked === 'zh' || picked === 'en' ? picked : localeId();
    const nextTheme = appearance && typeof appearance.theme === 'string' ? appearance.theme : 'system';
    const changed = nextLang !== lang;
    lang = nextLang;
    t = COPY[lang] || COPY.en;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyTheme(nextTheme);
    if (changed) {
      actionsSig = '';
      applyChrome();
    }
  }

  async function tick() {
    try {
      const r = await fetch('/api/snapshot');
      if (!r.ok) return;
      lastSnapshot = await r.json();
      applyAppearance(lastSnapshot.appearance);
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
  $('btnDesktop').onclick = async () => {
    const result = await postJson('/api/desktop', {});
    if (result.ok && result.data && result.data.ok) desktopNoteUntil = Date.now() + 4000;
  };
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

  function applyChrome() {
    $('btnMin').title = t.min;
    $('btnMin').setAttribute('aria-label', t.min);
    $('btnClose').title = t.close;
    $('btnClose').setAttribute('aria-label', t.close);
    $('btnOpen').textContent = t.open;
    $('btnDesktop').textContent = t.desktop;
    btnGear.title = t.bind;
    btnClearApp.title = t.clear;
    $('autoOpenLabel').textContent = t.autoOpen;
    bindPath.placeholder = t.pathPlaceholder;
    $('btnBrowse').textContent = t.browse;
    $('btnBindOk').textContent = t.ok;
    $('btnBindCancel').textContent = t.cancel;
    statusText.textContent = t.loading;
    fetch('/api/frame').then(r => r.json()).then(info => {
      if (!info || info.ok !== true) {
        const buttons = document.querySelector('.winbtns');
        if (buttons) buttons.classList.add('hidden');
      }
    }).catch(() => {});
  }
  applyChrome();

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
  // Never run lifecycle work inside the panel HTTP process. Update recipes use
  // long PATH-tool spawns; keeping them here freezes /api/snapshot and /api/log,
  // so the spinner and in-window console stop updating. Match the Host path:
  // detach cli.cjs and let the panel keep polling job.*.
  dispatchCli(action, [], {
    dshHome: layout?.dshHome || (paths?.root ? dirname(paths.root) : undefined),
    cwd: layout?.cwd,
  })
}

function panelHostAllowed(header, port) {
  const value = String(header || '').trim().toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`
}

function startPanelServer(paths, layout, options = {}) {
  let focusRequested = false
  const html = panelPageHtml()
  const host = DEFAULT_HOST
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (!panelHostAllowed(req.headers.host, port)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }

    try {
      if (req.method === 'GET' && (path === '' || path === '/' || path === '/panel')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (req.method === 'GET' && path === '/api/snapshot') {
        const snapshot = await buildSnapshot(paths, layout)
        pushAppAppearance(snapshot.appearance)
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
      if (req.method === 'POST' && path === '/api/desktop') {
        const cli = cliPathFromHost()
        const installed = installPanelEntry(layout.node || process.execPath, cli, { forceDesktop: true })
        const shortcut = installed.find((item) => /[/\\]DSH Server\.(lnk|app|desktop)$/.test(item))
        if (!shortcut) {
          sendJson(res, 500, { ok: false, error: 'no Desktop folder found' })
          return
        }
        sendJson(res, 200, { ok: true, path: shortcut })
        return
      }
      if (req.method === 'POST' && path === '/api/open') {
        const prefs = readPanelPrefs(paths)
        if (prefs.openApp) {
          const result = openDshUi(paths, layout)
          sendJson(res, 200, result)
          return
        }
        const target = readWebUrl(paths, layout)
        if (!target) {
          sendJson(res, 503, { ok: false, error: 'DSH URL is not ready yet' })
          return
        }
        closeAppWindow()
        await sleep(200)
        resetAppWebViewData(paths)
        let shown = false
        try {
          shown = await showAppWindow(target, paths, { forceReload: true })
        } catch (error) {
          logSupervisor(paths, `app window: ${error instanceof Error ? error.message : error}`)
        }
        if (!shown) openUrl(target)
        sendJson(res, 200, { ok: true, url: target, window: shown })
        return
      }
      if (req.method === 'GET' && path === '/api/frame') {
        sendJson(res, 200, frameGeometry())
        return
      }
      if (req.method === 'POST' && path === '/api/frame') {
        const body = await readRequestBody(req)
        if (body?.op === 'show') {
          const shown = revealFrame() || await showFrameless(`http://${host}:${port}/`, paths)
          sendJson(res, 200, { ok: true, shown })
          return
        }
        sendJson(res, 200, applyFrameOp(body))
        return
      }
      if (req.method === 'POST' && path === '/api/app') {
        const body = await readRequestBody(req)
        if (body?.op === 'close') {
          closeAppWindow()
          sendJson(res, 200, { ok: true, closed: true })
          return
        }
        let target = typeof body?.url === 'string' && body.url.length > 0
          ? body.url
          : readWebUrl(paths, layout)
        if (!target || !isTokenizedWebUrl(target)) {
          target = readWebUrl(paths, layout)
        }
        if (!target) {
          sendJson(res, 503, { ok: false, error: 'DSH URL is not ready yet' })
          return
        }
        const force = body?.force !== false
        if (force) {
          closeAppWindow()
          await sleep(200)
          // Rotate WebView profile even when rm of the old tree fails (EPERM).
          resetAppWebViewData(paths)
        }
        const shown = await showAppWindow(target, paths, { forceReload: force })
        sendJson(res, shown ? 200 : 500, { ok: shown, shown, url: target })
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
      writePidFile(paths.panelPid, process.pid)
      logSupervisor(paths, `panel listening ${panelUrl}`)
      const clearPid = () => {
        try {
          if (readPidFileSafe(paths.panelPid) === process.pid) removeFile(paths.panelPid)
        } catch { /* ignore */ }
      }
      server.on('close', clearPid)
      process.once('exit', clearPid)
      resolve({ server, port, url: panelUrl })
    })
  })
}

function readPidFileSafe(path) {
  try {
    const raw = readText(path)
    if (!raw) return 0
    const match = /pid=(\d+)/.exec(raw)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

let frameHost = null
let appHost = null
let appOpening = null

function pushAppAppearance(appearance) {
  const webview = appHost?.webview
  if (!webview || typeof webview.evaluateScript !== 'function') return
  const locale = appearance?.locale === 'zh' || appearance?.locale === 'en' ? appearance.locale : ''
  try {
    webview.evaluateScript(`window.__dshLook&&window.__dshLook(${JSON.stringify(locale)})`)
  } catch { /* page not ready */ }
}
let sharedApp = null
let pumpStarted = false

function windowHostDied(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes('has been disposed')
}

function dropWindowHost() {
  const dying = sharedApp
  sharedApp = null
  pumpStarted = false
  frameHost = null
  appHost = null
  try {
    if (dying && typeof dying.stop === 'function') dying.stop()
  } catch { /* the pump has already stopped */ }
}

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

function readRgbaIcon(name) {
  const here = typeof __dirname === 'string' ? __dirname : ''
  const candidates = []
  if (here) {
    candidates.push(join(here, '..', 'panel', `${name}.rgba`))
    candidates.push(join(here, '..', '..', 'icons', `${name}.rgba`))
  }
  const argv = process.argv[1]
  if (typeof argv === 'string' && argv.length > 0) {
    const dir = dirname(argv)
    candidates.push(join(dir, '..', 'panel', `${name}.rgba`))
    candidates.push(join(dir, '..', '..', 'icons', `${name}.rgba`))
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue
    let buf
    try { buf = readFileSync(path) } catch { continue }
    if (!buf || buf.length < 12) continue
    const width = buf.readUInt32LE(0)
    const height = buf.readUInt32LE(4)
    const data = buf.subarray(8)
    if (width < 1 || height < 1 || width > 1024 || height > 1024) continue
    if (data.length < width * height * 4) continue
    return { data, width, height }
  }
  return null
}

function applyWindowIcon(shell, name) {
  const icon = readRgbaIcon(name)
  if (!icon || !shell) return
  try { shell.setWindowIcon(icon.data, icon.width, icon.height) } catch { /* host may ignore icons */ }
  if (typeof shell.setTaskbarIcon === 'function') {
    try { shell.setTaskbarIcon(icon.data, icon.width, icon.height) } catch { /* taskbar icon is optional */ }
  }
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
  } catch (error) {
    if (windowHostDied(error)) dropWindowHost()
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
    const apply = (w, h) => {
      try { shell.setSize(w, h, true) } catch { shell.setSize(w, h) }
    }
    apply(width, height)
    try {
      const inner = typeof shell.getInnerSize === 'function' ? shell.getInnerSize(true) : null
      const innerHeight = Number(inner?.height) || 0
      if (innerHeight > 0 && innerHeight < height) apply(width, height + (height - innerHeight))
    } catch { /* the first size already matches the page */ }
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
        title: 'Select a program',
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

async function ensureSharedApp(paths) {
  if (sharedApp) return sharedApp
  let Application
  try {
    Application = await loadFrameApplication()
  } catch (error) {
    logSupervisor(paths, `window host: ${error instanceof Error ? error.message : error}`)
    return null
  }
  if (typeof Application !== 'function') {
    logSupervisor(paths, 'window host: module has no Application')
    return null
  }
  try {
    sharedApp = new Application()
  } catch (error) {
    logSupervisor(paths, `window host: ${error instanceof Error ? error.message : error}`)
    sharedApp = null
    return null
  }
  return sharedApp
}

async function openShell(paths, options, label) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const app = await ensureSharedApp(paths)
    if (!app) return null
    try {
      return { app, shell: app.createBrowserWindow(options) }
    } catch (error) {
      logSupervisor(paths, `${label}: ${error instanceof Error ? error.message : error}`)
      if (attempt === 0 && windowHostDied(error)) {
        logSupervisor(paths, 'window host ended with its last window; opening a new one')
        dropWindowHost()
        continue
      }
      return null
    }
  }
  return null
}

async function pumpSharedApp(app, paths) {
  if (pumpStarted || !app) return
  pumpStarted = true
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
    logSupervisor(paths, `window pump: ${error instanceof Error ? error.message : error}`)
  }
}

async function showFrameless(url, paths, attempt = 0) {
  if (revealFrame()) return true
  if (frameWindow()) return false
  const opened = await openShell(paths, {
    title: 'DSH Server',
    width: 440,
    height: 220,
    decorations: false,
    resizable: false,
    minimizable: true,
    maximizable: false,
  }, 'frameless window')
  if (!opened) return false
  const { app, shell } = opened
  if (typeof shell.setHasShadow === 'function') {
    try { shell.setHasShadow(false) } catch { /* host may not support it */ }
  }
  const dataDir = join(paths.root, 'frame')
  mkdirSync(dataDir, { recursive: true })
  let webview
  try {
    const webContext = app.createWebContext({ dataDirectory: dataDir })
    webview = shell.createWebview({ url, webContext })
  } catch (error) {
    logSupervisor(paths, `frameless window: ${error instanceof Error ? error.message : error}`)
    try { shell.close() } catch { /* already dead */ }
    if (attempt === 0 && windowHostDied(error)) {
      dropWindowHost()
      return showFrameless(url, paths, 1)
    }
    return false
  }
  applyWindowIcon(shell, 'dsh-server')
  bindShellControls(shell, webview, paths, () => {
    try { shell.hide() } catch { /* already hidden */ }
  })
  frameHost = { app, window: shell, webview }
  await pumpSharedApp(app, paths)
  revealFrame()
  return true
}

const WIN_COPY = {
  zh: {
    title: '关闭服务、重启服务或更新插件',
    stop: '关闭服务',
    restart: '重启服务',
    'update-stop': '更新插件并关闭服务',
    'update-restart': '更新插件并重启服务',
    working: '正在执行…',
    failed: '操作失败',
    min: '最小化',
    max: '最大化',
    restore: '还原',
    close: '关闭',
  },
  en: {
    title: 'Stop service, restart service, or update plugins',
    stop: 'Stop service',
    restart: 'Restart service',
    'update-stop': 'Update plugins and stop service',
    'update-restart': 'Update plugins and restart service',
    working: 'Working…',
    failed: 'Action failed',
    min: 'Minimize',
    max: 'Maximize',
    restore: 'Restore',
    close: 'Close',
  },
}

function appControlScript() {
  return `(function () {
  if (window.__dshAppWin) return;
  window.__dshAppWin = true;
  var TEXT = ${JSON.stringify(WIN_COPY)};
  var BAND = 60;
  var HOT = 12;
  var REACH = 156;
  var css = '#dsh-app-win{position:fixed;top:8px;right:8px;z-index:2147483646;display:flex;align-items:center;gap:1px;padding:3px;border-radius:8px;border:1px solid rgb(214,214,214);background:#fff;color:#1c1c1c;box-shadow:0 1px 3px rgb(0 0 0 / 16%);opacity:0;pointer-events:none;user-select:none;}'
    + '#dsh-app-win.on{opacity:1;pointer-events:auto;}'
    + '#dsh-app-win button{width:32px;height:26px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
    + '#dsh-app-win button:hover{background:var(--dsh-hover,#ececec);}'
    + '#dsh-app-win button[data-op="close"]:hover{background:#c42b1c;color:#fff;}'
    + '#dsh-app-win i{width:1px;height:14px;margin:0 3px;background:var(--dsh-line,#d0d0d0);display:block;}'
    + '#dsh-app-win.menu{opacity:1;pointer-events:auto;}'
    + '#dsh-app-menu{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:220px;padding:6px;border-radius:10px;border:1px solid rgb(214,214,214);background:#fff;color:inherit;box-shadow:0 8px 24px rgb(0 0 0 / 18%);flex-direction:column;gap:2px;}'
    + '#dsh-app-win.menu #dsh-app-menu{display:flex;}'
    + '#dsh-app-menu button{width:100%;height:auto;min-height:32px;padding:6px 10px;justify-content:flex-start;border-radius:6px;font:13px/20px sans-serif;white-space:nowrap;text-align:left;}'
    + '#dsh-app-menu button:disabled{opacity:0.45;cursor:default;}'
    + '#dsh-app-menu p{display:none;margin:4px 8px 2px;font:12px/16px sans-serif;color:#c42b1c;}'
    + '#dsh-app-menu p.on{display:block;}';
  function svg(body, extra) {
    return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.15"' + (extra || '') + '>' + body + '</svg>';
  }
  function icon(op, maximized) {
    if (op === 'power') return svg('<path d="M6 1.2v2.8"/><path d="M3.15 3.2a3.6 3.6 0 1 0 5.7 0"/>', ' stroke-linecap="round"');
    if (op === 'min') return svg('<path d="M1.5 6h9"/>');
    if (op === 'close') return svg('<path d="M2.2 2.2l7.6 7.6M9.8 2.2L2.2 9.8"/>');
    if (maximized) return svg('<path d="M3.6 1.6h6.8V8.4"/><path d="M1.6 3.6h6.8V10.4H1.6z"/>');
    return svg('<rect x="1.6" y="1.6" width="8.8" height="8.8"/>');
  }
  var bar = null;
  var menu = null;
  var note = null;
  var menuOpen = false;
  var busy = false;
  var ACTIONS = ['stop', 'restart', 'update-stop', 'update-restart'];
  var maxOn = false;
  var hideTimer = null;
  var dragging = false;
  var pendingDrag = null;
  var lastTitleTap = 0;
  var moveQueued = null;
  var pumping = false;
  // Move past slop before drag so a second tap can post 'max' (same as the button).
  var DRAG_SLOP = 4;
  var DBL_MS = 400;
  // Windows → OS caption drag (Aero Snap). Elsewhere → d0/d1/d2.
  var nativeOsDrag = /Win/i.test(String(navigator.platform || ''))
    || /Windows NT/i.test(String(navigator.userAgent || ''));
  function post(msg) {
    if (!window.ipc || typeof window.ipc.postMessage !== 'function') return;
    window.ipc.postMessage(msg);
  }
  function pumpMove() {
    pumping = false;
    if (!moveQueued) return;
    var msg = moveQueued;
    moveQueued = null;
    post(msg);
  }
  function stopCustomDrag() {
    if (!dragging) return;
    dragging = false;
    moveQueued = null;
    post('d2');
  }
  function toggleMax() {
    pendingDrag = null;
    stopCustomDrag();
    lastTitleTap = 0;
    post('max');
  }
  function beginPendingDrag(start) {
    pendingDrag = null;
    lastTitleTap = 0;
    if (start.native) {
      post('drag');
      return;
    }
    dragging = true;
    post('d0:' + start.sx + ':' + start.sy);
  }
  var forcedLocale = '';
  function phrase(key) {
    var id = forcedLocale === 'zh' || forcedLocale === 'en' ? forcedLocale : '';
    if (!id) {
      var page = document.documentElement && document.documentElement.lang ? String(document.documentElement.lang).toLowerCase() : '';
      var pageDash = page.indexOf('-');
      var pagePrimary = pageDash < 0 ? page : page.slice(0, pageDash);
      if (pagePrimary === 'zh' || pagePrimary === 'en') id = pagePrimary;
    }
    if (!id) {
      var tags = [];
      var list = navigator.languages;
      if (list) { for (var i = 0; i < list.length; i++) tags.push(String(list[i] || '')); }
      if (navigator.language) tags.push(String(navigator.language));
      id = 'en';
      for (var n = 0; n < tags.length; n++) {
        var requested = tags[n].toLowerCase();
        var dash = requested.indexOf('-');
        var primary = dash < 0 ? requested : requested.slice(0, dash);
        if (primary === 'zh' || primary === 'en') { id = primary; break; }
      }
    }
    var pack = TEXT[id] || TEXT.en;
    return pack[key] || key;
  }
  window.__dshLook = function (locale) {
    forcedLocale = locale === 'zh' || locale === 'en' ? locale : '';
    relabel();
    paintBar();
  };
  function relabel() {
    if (!bar) return;
    label(bar.querySelector('[data-op="power"]'), 'title');
    label(bar.querySelector('[data-op="min"]'), 'min');
    label(bar.querySelector('[data-op="close"]'), 'close');
    setMax(maxOn);
    if (!menu) return;
    var items = menu.querySelectorAll('[data-act]');
    for (var i = 0; i < items.length; i++) {
      var act = items[i].getAttribute('data-act');
      if (act) items[i].textContent = phrase(act);
    }
  }
  function label(button, key) {
    if (!button) return;
    var text = phrase(key);
    button.setAttribute('aria-label', text);
    button.title = text;
  }
  function setMax(on) {
    maxOn = on === true;
    if (!bar) return;
    bar.setAttribute('data-max', maxOn ? '1' : '0');
    var button = bar.querySelector('[data-op="max"]');
    if (button) button.innerHTML = icon('max', maxOn);
    label(button, maxOn ? 'restore' : 'max');
  }
  window.__dshSetMax = setMax;
  function paintBar() {
    if (!bar) return;
    var bg = { r: 255, g: 255, b: 255 };
    var fg = { r: 28, g: 28, b: 28 };
    function read(node, wantBg) {
      if (!node) return null;
      var raw = '';
      try { raw = getComputedStyle(node)[wantBg ? 'backgroundColor' : 'color'] || ''; } catch (e) { return null; }
      var open = raw.indexOf('(');
      var close = raw.indexOf(')', open + 1);
      if (raw.indexOf('rgb') !== 0 || open < 0 || close < 0) return null;
      var parts = raw.slice(open + 1, close).split(',');
      if (parts.length < 3) return null;
      if (wantBg && parts.length > 3 && Number(parts[3]) < 0.98) return null;
      return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) };
    }
    var marked = (document.body && document.body.hasAttribute('data-ds-dark-theme'))
      || (document.documentElement && String(document.documentElement.style.colorScheme) === 'dark');
    if (marked) {
      bg = { r: 21, g: 21, b: 23 };
      fg = { r: 249, g: 250, b: 251 };
    } else {
      bg = read(document.body, true) || read(document.documentElement, true) || bg;
      fg = read(document.body, false) || fg;
    }
    var dark = marked || (bg.r * 3 + bg.g * 6 + bg.b) / 10 < 140;
    bar.style.background = 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')';
    bar.style.color = 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')';
    bar.style.borderColor = dark ? 'rgb(68,68,68)' : 'rgb(214,214,214)';
    bar.style.setProperty('--dsh-hover', dark ? 'rgb(58,58,58)' : 'rgb(236,236,236)');
    bar.style.setProperty('--dsh-line', dark ? 'rgb(82,82,82)' : 'rgb(208,208,208)');
    if (menu) {
      menu.style.background = bar.style.background;
      menu.style.color = bar.style.color;
      menu.style.borderColor = bar.style.borderColor;
    }
  }
  function showBar() {
    if (!bar) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    paintBar();
    bar.classList.add('on');
  }
  function hideBarSoon() {
    if (!bar || hideTimer || menuOpen) return;
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (bar && !menuOpen) bar.classList.remove('on');
    }, 160);
  }
  function setNote(text) {
    if (!note) return;
    note.textContent = text || '';
    if (text) note.classList.add('on');
    else note.classList.remove('on');
  }
  function setExpanded(on) {
    var power = bar && bar.querySelector('[data-op="power"]');
    if (power) power.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function closeMenu() {
    menuOpen = false;
    if (bar) bar.classList.remove('menu');
    setExpanded(false);
    setNote('');
  }
  function openMenu() {
    menuOpen = true;
    setNote('');
    if (bar) bar.classList.add('menu');
    setExpanded(true);
    showBar();
  }
  function toggleMenu() {
    if (menuOpen) closeMenu();
    else openMenu();
  }
  function paintBusy() {
    if (!menu) return;
    var buttons = menu.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
  }
  function runAction(action) {
    if (busy) return;
    busy = true;
    setNote(phrase('working'));
    paintBusy();
    fetch('/api/dsh-rebooter/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action: action }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body || body.ok !== true) throw new Error('failed');
        closeMenu();
      }, function () { throw new Error('failed'); });
    }).catch(function () {
      setNote(phrase('failed'));
    }).then(function () {
      busy = false;
      paintBusy();
    });
  }
  function mount() {
    if (!document.documentElement) return;
    var existing = document.getElementById('dsh-app-win');
    if (existing) { bar = existing; return; }
    if (!document.getElementById('dsh-app-win-css')) {
      var style = document.createElement('style');
      style.id = 'dsh-app-win-css';
      style.textContent = css;
      document.documentElement.appendChild(style);
    }
    bar = document.createElement('div');
    bar.id = 'dsh-app-win';
    ['power','min','max','close'].forEach(function (op) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-op', op);
      button.innerHTML = icon(op, false);
      bar.appendChild(button);
    });
    var rule = document.createElement('i');
    var minButton = bar.querySelector('[data-op="min"]');
    if (minButton) bar.insertBefore(rule, minButton);
    label(bar.querySelector('[data-op="min"]'), 'min');
    label(bar.querySelector('[data-op="close"]'), 'close');
    var power = bar.querySelector('[data-op="power"]');
    if (power) {
      power.setAttribute('aria-haspopup', 'menu');
      power.setAttribute('aria-controls', 'dsh-app-menu');
      power.setAttribute('aria-expanded', 'false');
      label(power, 'title');
    }
    menu = document.createElement('div');
    menu.id = 'dsh-app-menu';
    menu.setAttribute('role', 'menu');
    ACTIONS.forEach(function (action) {
      var item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-act', action);
      item.textContent = phrase(action);
      menu.appendChild(item);
    });
    note = document.createElement('p');
    menu.appendChild(note);
    bar.appendChild(menu);
    setMax(maxOn);
    bar.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    bar.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!button || !bar.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      var act = button.getAttribute('data-act');
      if (act) { runAction(act); return; }
      var op = button.getAttribute('data-op') || '';
      if (op === 'power') { toggleMenu(); return; }
      if (op) post(op);
    });
    document.documentElement.appendChild(bar);
    setMax(maxOn);
  }
  function interactive(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue;
      if (node.id === 'dsh-app-win') return true;
      var tag = node.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL' || tag === 'SUMMARY' || tag === 'OPTION') return true;
      if (node.isContentEditable) return true;
      var role = node.getAttribute && node.getAttribute('role');
      if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' || role === 'checkbox' || role === 'switch' || role === 'textbox' || role === 'slider' || role === 'combobox' || role === 'listbox' || role === 'option' || role === 'radio') return true;
      if (i < 4) {
        try { if (getComputedStyle(node).cursor === 'pointer') return true; } catch (e) {}
      }
    }
    return false;
  }
  function inHot(event) {
    var x = event.clientX;
    var y = event.clientY;
    if (x < 0 || y < 0) return false;
    var fromRight = window.innerWidth - x;
    if (fromRight < 0) return false;
    return (y <= HOT && fromRight <= REACH) || (fromRight <= HOT && y <= REACH);
  }
  function overBar(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      if (path[i] && path[i].id === 'dsh-app-win') return true;
    }
    return false;
  }
  document.addEventListener('pointermove', function (event) {
    if (pendingDrag) {
      var pdx = Math.round(event.screenX) - pendingDrag.sx;
      var pdy = Math.round(event.screenY) - pendingDrag.sy;
      if ((pdx * pdx) + (pdy * pdy) >= DRAG_SLOP * DRAG_SLOP) {
        var start = pendingDrag;
        if (!start.native) {
          try { document.documentElement.setPointerCapture(event.pointerId); } catch (e) {}
        }
        beginPendingDrag(start);
        if (dragging) {
          moveQueued = 'd1:' + Math.round(event.screenX) + ':' + Math.round(event.screenY);
          if (!pumping) { pumping = true; requestAnimationFrame(pumpMove); }
        }
      }
      return;
    }
    if (dragging) {
      moveQueued = 'd1:' + Math.round(event.screenX) + ':' + Math.round(event.screenY);
      if (!pumping) { pumping = true; requestAnimationFrame(pumpMove); }
      return;
    }
    if (inHot(event) || overBar(event)) showBar();
    else hideBarSoon();
  }, true);
  document.addEventListener('pointerdown', function (event) {
    if (menuOpen && !overBar(event)) { closeMenu(); hideBarSoon(); }
    if (event.button !== 0 || event.clientY > BAND || event.clientY < 0 || interactive(event)) return;
    event.preventDefault();
    hideBarSoon();
    var now = Date.now();
    // Time-based: WebView2 often keeps pointerdown.detail at 1.
    if (lastTitleTap > 0 && now - lastTitleTap <= DBL_MS) {
      toggleMax();
      return;
    }
    lastTitleTap = now;
    pendingDrag = {
      sx: Math.round(event.screenX),
      sy: Math.round(event.screenY),
      native: nativeOsDrag,
    };
  }, true);
  function endDrag() {
    pendingDrag = null;
    stopCustomDrag();
  }
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menuOpen) { closeMenu(); hideBarSoon(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  setTimeout(mount, 300);
  setTimeout(mount, 1200);
  if (typeof MutationObserver === 'function' && document.documentElement) {
    var watch = new MutationObserver(function () { relabel(); paintBar(); });
    watch.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['lang', 'data-ds-dark-theme'] });
  }
})();`
}

function ipcText(message) {
  const body = message?.body
  const text = typeof body === 'string'
    ? body
    : (body && typeof body.toString === 'function' ? body.toString('utf8') : '')
  return String(text).trim()
}

/** Ask the OS to run its native move loop (Windows Aero Snap). Other platforms: false. */
function startOsWindowDrag(shell) {
  if (process.platform !== 'win32' || !shell) return false
  let hwnd
  try {
    hwnd = typeof shell.getNativeHandle === 'function' ? shell.getNativeHandle() : null
  } catch {
    return false
  }
  if (hwnd == null) return false
  try {
    // cli.cjs is CommonJS; the helper ships beside it under package/lib/.
    const path = require('node:path')
    const here = typeof __dirname === 'string' ? __dirname : path.dirname(process.argv[1] || '')
    const { startCaptionDrag } = require(path.join(here, 'windows-caption-drag.cjs'))
    return typeof startCaptionDrag === 'function' && startCaptionDrag(hwnd) === true
  } catch {
    return false
  }
}

/**
 * Shared pointer protocol for frameless shells.
 * - Panel: custom d0/d1/d2 screen-delta move (no OS snap; no cursor change).
 * - DSH page on Windows: `drag` → OS caption drag so Aero Snap works.
 * - DSH page elsewhere: same d0/d1/d2 fallback as the panel.
 */
function bindShellControls(shell, webview, paths, onClose, onMax, options = {}) {
  const nativeDrag = options?.nativeDrag === true
  const onMaximizedChange = typeof options?.onMaximizedChange === 'function'
    ? options.onMaximizedChange
    : null
  let drag = null
  const place = (x, y) => {
    try { shell.setPosition(x, y, true) } catch { shell.setPosition(x, y) }
  }
  if (typeof webview.onIpcMessage !== 'function') return
  webview.onIpcMessage((message) => {
    const op = ipcText(message)
    try {
      if (op === 'min') shell.setMinimized(true)
      else if (op === 'max' && onMax) onMax()
      else if (op === 'close' && onClose) onClose()
      else if (op === 'drag') {
        // OS move loop (Win32 caption). Falls through only when unavailable.
        if (nativeDrag && startOsWindowDrag(shell)) {
          drag = null
          return
        }
      } else if (op.startsWith('d0:')) {
        if (typeof shell.isMaximized === 'function' && shell.isMaximized()) {
          // Custom-drag fallback: restore first. Native Win32 caption drag does this itself.
          try { shell.setMaximized(false) } catch { return }
          if (onMaximizedChange) onMaximizedChange()
        }
        const parts = op.split(':')
        let pos = null
        try { pos = shell.getPosition(true) } catch { pos = null }
        drag = {
          sx: Number(parts[1]) || 0,
          sy: Number(parts[2]) || 0,
          x: Number(pos?.x ?? shell.x) || 0,
          y: Number(pos?.y ?? shell.y) || 0,
        }
      } else if (op.startsWith('d1:') && drag) {
        const parts = op.split(':')
        place(
          Math.round(drag.x + (Number(parts[1]) || 0) - drag.sx),
          Math.round(drag.y + (Number(parts[2]) || 0) - drag.sy),
        )
      } else if (op === 'd2') {
        drag = null
      }
    } catch (error) {
      logSupervisor(paths, `window control: ${error instanceof Error ? error.message : error}`)
    }
  })
}

/** Push shell.isMaximized() to the page only when it changes (button, Aero Snap, restore). */
function watchMaximized(shell, onChange) {
  if (!shell || typeof onChange !== 'function') return () => {}
  let last = null
  const push = () => {
    let on = false
    try {
      on = typeof shell.isMaximized === 'function' && shell.isMaximized() === true
    } catch {
      return
    }
    if (on === last) return
    last = on
    onChange(on)
  }
  if (typeof shell.on === 'function') {
    shell.on('resize', push)
    shell.on('move', push)
  }
  push()
  return push
}

function liveAppWindow() {
  const shell = appHost?.window
  if (!shell) return null
  try {
    if (typeof shell.isDisposed === 'function' && shell.isDisposed()) return null
  } catch {
    return null
  }
  return shell
}

function closeAppWindow() {
  const shell = liveAppWindow()
  if (!shell) return false
  try { shell.close() } catch { return false }
  if (appHost && appHost.window === shell) appHost = null
  return true
}

async function showAppWindow(url, paths, options = {}) {
  if (appOpening) return appOpening
  appOpening = showAppWindowNow(url, paths, options).finally(() => { appOpening = null })
  return appOpening
}

async function showAppWindowNow(url, paths, options = {}) {
  if (typeof url !== 'string' || url.length === 0) return false
  if (options.forceReload === true) {
    closeAppWindow()
  }
  const session = await exchangeBrowserAuth(url)
  const existing = liveAppWindow()
  if (existing) {
    try {
      if (typeof existing.isMinimized === 'function' && existing.isMinimized()) existing.setMinimized(false)
      applyAuthCookies(appHost?.webview, session)
      if (typeof appHost?.webview?.loadUrl === 'function') {
        appHost.webview.loadUrl(session.finalUrl)
      }
      existing.show()
      existing.focus()
      if (appHost) appHost.url = session.finalUrl
      pushAppAppearance(readUserAppearance(dirname(paths.root), readLayout(paths)?.profile))
      return true
    } catch (error) {
      logSupervisor(paths, `app window focus: ${error instanceof Error ? error.message : error}`)
      if (windowHostDied(error)) dropWindowHost()
    }
  }
  return openAppShell(session.finalUrl, paths, 0, session)
}

/**
 * DSH browser auth: GET ?token=… → 303 Location:./ + Set-Cookie (HttpOnly,
 * SameSite=Strict). WebView2 often fails that hop (blank shell, sidebar may
 * still paint from cache). Exchange in Node, inject the cookie, open `/`.
 */
async function exchangeBrowserAuth(tokenizedUrl) {
  const fallback = { finalUrl: tokenizedUrl, cookies: [] }
  if (typeof tokenizedUrl !== 'string' || tokenizedUrl.length === 0) return fallback
  try {
    const parsed = new URL(tokenizedUrl)
    if (!parsed.searchParams.get('token')) {
      return { finalUrl: tokenizedUrl, cookies: [] }
    }
    const response = await fetch(tokenizedUrl, { redirect: 'manual' })
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
    const cookies = []
    for (const line of setCookies) {
      const cookie = parseSetCookieLine(line, tokenizedUrl)
      if (cookie) cookies.push(cookie)
    }
    let finalUrl = `${parsed.origin}/`
    const location = response.headers.get('location')
    if (location) {
      try { finalUrl = new URL(location, tokenizedUrl).href } catch { /* keep origin/ */ }
    }
    if (cookies.length === 0 && response.status >= 200 && response.status < 400) {
      return { finalUrl: tokenizedUrl, cookies: [] }
    }
    return { finalUrl, cookies }
  } catch {
    return fallback
  }
}

function parseSetCookieLine(line, pageUrl) {
  if (typeof line !== 'string' || line.length === 0) return null
  const parts = line.split(';').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const eq = parts[0].indexOf('=')
  if (eq <= 0) return null
  let host = '127.0.0.1'
  try { host = new URL(pageUrl).hostname } catch { /* default */ }
  const cookie = {
    name: parts[0].slice(0, eq),
    value: parts[0].slice(eq + 1),
    domain: host,
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'strict',
  }
  for (const attr of parts.slice(1)) {
    const lower = attr.toLowerCase()
    if (lower === 'httponly') cookie.httpOnly = true
    else if (lower === 'secure') cookie.secure = true
    else if (lower.startsWith('path=')) cookie.path = attr.slice(5) || '/'
    else if (lower.startsWith('domain=')) cookie.domain = attr.slice(7) || host
    else if (lower.startsWith('samesite=')) cookie.sameSite = attr.slice(9).toLowerCase()
  }
  return cookie
}

function applyAuthCookies(webview, session) {
  if (!webview || !session || !Array.isArray(session.cookies)) return
  for (const cookie of session.cookies) {
    try {
      if (typeof webview.deleteCookie === 'function') {
        webview.deleteCookie(cookie.name, cookie.domain, cookie.path || '/')
      }
    } catch { /* best effort */ }
    try {
      if (typeof webview.setCookie === 'function') webview.setCookie(cookie)
    } catch { /* host may reject malformed cookies */ }
  }
}

async function openAppShell(url, paths, attempt, session) {
  const auth = session && Array.isArray(session.cookies)
    ? session
    : await exchangeBrowserAuth(url)
  const openUrlTarget = auth.finalUrl || url
  const opened = await openShell(paths, {
    title: 'DSH',
    width: 1200,
    height: 800,
    decorations: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    showMenu: false,
  }, 'app window')
  if (!opened) return false
  const { app, shell } = opened
  if (typeof shell.center === 'function') {
    try { shell.center() } catch { /* keep the default position */ }
  }
  const dataDir = currentAppDataDir(paths)
  mkdirSync(dataDir, { recursive: true })
  const controls = appControlScript()
  let webview
  try {
    const webContext = app.createWebContext({ dataDirectory: dataDir })
    // about:blank first so we can set HttpOnly cookies before the document loads.
    webview = shell.createWebview({ url: 'about:blank', webContext, preload: controls })
    applyAuthCookies(webview, auth)
    if (typeof webview.loadUrl === 'function') webview.loadUrl(openUrlTarget)
  } catch (error) {
    logSupervisor(paths, `app window: ${error instanceof Error ? error.message : error}`)
    try { shell.close() } catch { /* already dead */ }
    if (attempt === 0 && windowHostDied(error)) {
      dropWindowHost()
      return openAppShell(url, paths, 1, auth)
    }
    return false
  }
  const syncMax = (on) => {
    try {
      webview.evaluateScript(`window.__dshSetMax&&window.__dshSetMax(${on ? 'true' : 'false'})`)
    } catch { /* page not ready */ }
  }
  const refreshMax = watchMaximized(shell, syncMax)
  if (typeof webview.on === 'function') {
    webview.on('page-load-finished', () => {
      try { webview.evaluateScript(controls) } catch { /* host may reject a second inject */ }
      setTimeout(() => {
        refreshMax()
        pushAppAppearance(readUserAppearance(dirname(paths.root), readLayout(paths)?.profile))
      }, 40)
    })
  }
  applyWindowIcon(shell, 'dsh')
  bindShellControls(shell, webview, paths, () => { closeAppWindow() }, () => {
    let current = false
    try { current = typeof shell.isMaximized === 'function' && shell.isMaximized() === true } catch { current = false }
    try { shell.setMaximized(!current) } catch { /* host may refuse */ }
    refreshMax()
  }, { nativeDrag: true, onMaximizedChange: refreshMax })
  appHost = { window: shell, webview, url: openUrlTarget }
  await pumpSharedApp(app, paths)
  try { shell.show(); shell.focus() } catch { /* already visible */ }
  logSupervisor(paths, `app window opened ${openUrlTarget} cookies=${auth.cookies.length}`)
  return true
}

async function askRunningPanel(layout) {
  const port = panelPort(Number(layout?.port) || DEFAULT_PORT)
  const paths = ensureStateDir(statePaths())
  const url = readWebUrl(paths, layout)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12000)
  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/api/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, resetCache: true, url }),
      signal: ac.signal,
    })
    if (!response.ok) return false
    const data = await response.json()
    return data?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function runAppWindow() {
  // Page windows are owned by the single panel HTTP process. Never start a
  // second listener on panelPort — that used to steal 13081 from the panel.
  const paths = ensureStateDir(statePaths())
  const layout = readLayout(paths) || captureLaunch(process)
  await openDshUiAsync(paths, layout, { resetCache: true })
  return { ok: true, delegated: true }
}

async function postFrame(url, body) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 4000)
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
  let shown = false
  try {
    shown = options.reuse === true
      ? await postFrame(url, { op: 'show' })
      : await showFrameless(url, paths)
  } catch (error) {
    logSupervisor(paths, `panel window: ${error instanceof Error ? error.message : error}`)
  }
  if (!shown) {
    logSupervisor(paths, 'panel window unavailable; opening with the default handler')
    openUrl(url)
  }
  return shown
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
  windowHostDied,
}
