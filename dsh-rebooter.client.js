/**
 * dsh-rebooter — Client half: one sidebar-foot menu to the left of Settings.
 *
 * Registers into `sidebar.footer.action`. The official foot stacks that list
 * above Settings. In the wide column we (1) CSS-flip the foot into a row and
 * (2) move this node into the Settings triggerRow so it shares the gear's
 * horizontal rhythm. Slot wrappers use `display: contents`, so the CSS
 * selector must reach three levels deep. The rail stays stacked — two 36px
 * circles will not fit side-by-side in 56px.
 *
 * Start is not in this menu; it is the desktop / CLI action. The four items
 * here POST `/api/dsh-rebooter/action` and the Host dispatches a detached CLI.
 *
 * @module dsh-rebooter/client
 */

const ReactLib = typeof React !== 'undefined' ? React : require('react')

const stylesApi = typeof styles !== 'undefined' ? styles : {
  insert(css) {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-rebooter')
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  },
}

function E(type, props, ...children) {
  return ReactLib.createElement(type, props, ...children)
}

const NS = 'dsh-rebooter'
const COPY = {
  zh: {
    'button.label': 'DSH',
    'button.title': '关闭、重启或更新 DSH',
    'menu.stop': '关闭',
    'menu.restart': '重启',
    'menu.update-stop': '更新并关闭',
    'menu.update-restart': '更新并重启',
    'status.working': '正在执行…',
    'status.error': '操作失败',
  },
  en: {
    'button.label': 'DSH',
    'button.title': 'Stop, restart, or update DSH',
    'menu.stop': 'Stop',
    'menu.restart': 'Restart',
    'menu.update-stop': 'Update and stop',
    'menu.update-restart': 'Update and restart',
    'status.working': 'Working…',
    'status.error': 'Action failed',
  },
}

const MENU = [
  { action: 'stop', key: 'menu.stop' },
  { action: 'restart', key: 'menu.restart' },
  { action: 'update-stop', key: 'menu.update-stop' },
  { action: 'update-restart', key: 'menu.update-restart' },
]

const STYLES = `
/* Official footArea is a column. Reach past footerActions + display:contents
   slot (three levels) so only the foot matches — not the sidebar root. */
div:has(> * > * > [data-plugin="dsh-rebooter"].wide) {
  flex-direction: row !important;
  align-items: center !important;
  gap: 0;
}
div:has(> * > * > [data-plugin="dsh-rebooter"].wide) > * {
  width: auto !important;
  flex: none;
  min-width: 0;
}
div:has(> * > * > [data-plugin="dsh-rebooter"].wide) > *:last-child {
  flex: 1 1 auto;
}
.dsh-rebooter {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  z-index: 2;
}
.dsh-rebooter.wide {
  margin: 0;
}
.dsh-rebooter-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-rebooter.wide .dsh-rebooter-btn {
  width: 42px;
  height: 42px;
  border-radius: 12px;
}
.dsh-rebooter.rail .dsh-rebooter-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}
.dsh-rebooter-btn:hover,
.dsh-rebooter-btn:focus-visible,
.dsh-rebooter-btn[data-open] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rebooter-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}
.dsh-rebooter-icon {
  display: block;
}
.dsh-rebooter-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 168px;
  padding: 6px;
  box-sizing: border-box;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  z-index: 30;
}
.dsh-rebooter-item {
  display: block;
  width: 100%;
  margin: 0;
  padding: 8px 12px;
  box-sizing: border-box;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-rebooter-item:hover,
.dsh-rebooter-item:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rebooter-item:disabled {
  cursor: wait;
  opacity: 0.6;
}
.dsh-rebooter-error {
  padding: 6px 12px 4px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 16px;
}

`

function PowerIcon({ size }) {
  return E('svg', {
    className: 'dsh-rebooter-icon',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    E('path', { d: 'M12 2v10' }),
    E('path', { d: 'M6.4 6.4a8 8 0 1 0 11.2 0' }),
  )
}

function localeBridge() {
  return {
    t: (key) => {
      const dict = COPY.zh
      return dict[key] ?? key
    },
  }
}

const locale = localeBridge()

function t(key) {
  return locale.t(key)
}

/** Walk up to the foot that owns both footer actions and the settings seat. */
function findFoot(node) {
  if (node && node.closest) {
    const tagged = node.closest('[data-dsh-rebooter-foot]')
    if (tagged) return tagged
  }
  let el = node && node.parentElement
  while (el) {
    let hasUs = false
    let hasDialog = false
    let dialogIsDirect = false
    for (let index = 0; index < el.children.length; index += 1) {
      const child = el.children[index]
      if (
        child === node
        || child.contains(node)
        || (child.querySelector && child.querySelector('[data-plugin="dsh-rebooter"]'))
      ) {
        hasUs = true
      }
      if (child.matches && child.matches('button[aria-haspopup="dialog"]')) {
        hasDialog = true
        dialogIsDirect = true
      } else if (child.querySelector && child.querySelector('button[aria-haspopup="dialog"]')) {
        hasDialog = true
      }
    }
    // triggerRow also has us + the dialog button as direct children — keep climbing.
    if (hasUs && hasDialog && dialogIsDirect !== true && el.children.length >= 2) {
      return el
    }
    el = el.parentElement
  }
  return undefined
}

/** Settings triggerRow: the flex parent of the gear button. */
function findSettingsTriggerRow(node) {
  const foot = findFoot(node)
  if (foot) {
    for (let index = 0; index < foot.children.length; index += 1) {
      const child = foot.children[index]
      const button = child.querySelector
        && child.querySelector('button[aria-haspopup="dialog"]')
      if (button && button.parentElement) return button.parentElement
    }
  }
  // Already parked beside the gear: parent is the row.
  if (node && node.parentElement) {
    const sibling = node.parentElement.querySelector('button[aria-haspopup="dialog"]')
    if (sibling) return node.parentElement
  }
  return undefined
}

function applyWideFootStyle(foot) {
  foot.setAttribute('data-dsh-rebooter-foot', '')
  foot.style.flexDirection = 'row'
  foot.style.alignItems = 'center'
  for (let index = 0; index < foot.children.length; index += 1) {
    const child = foot.children[index]
    child.style.width = 'auto'
    child.style.flex = 'none'
    child.style.minWidth = '0'
  }
  const last = foot.lastElementChild
  if (last) last.style.flex = '1 1 auto'
}

function clearWideFootStyle(foot) {
  foot.removeAttribute('data-dsh-rebooter-foot')
  foot.style.flexDirection = ''
  foot.style.alignItems = ''
  for (let index = 0; index < foot.children.length; index += 1) {
    const child = foot.children[index]
    child.style.width = ''
    child.style.flex = ''
    child.style.minWidth = ''
  }
}

function placeBesideSettings(node) {
  const foot = findFoot(node)
  if (foot) applyWideFootStyle(foot)
  const row = findSettingsTriggerRow(node)
  if (row === undefined) return false
  if (node.parentElement !== row) row.insertBefore(node, row.firstChild)
  return true
}

async function postAction(action) {
  const response = await fetch('/api/dsh-rebooter/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action }),
    cache: 'no-store',
  })
  const body = await response.json().catch(() => null)
  if (response.ok !== true || body?.ok !== true) {
    const detail = body?.error || `HTTP ${response.status}`
    throw new Error(detail)
  }
  return body
}

function RebooterMenu(props) {
  const wide = props.wide === true
  const translate = typeof props.t === 'function' ? props.t : t
  const rootRef = ReactLib.useRef(null)
  const homeRef = ReactLib.useRef(null)
  const [open, setOpen] = ReactLib.useState(false)
  const [busy, setBusy] = ReactLib.useState(false)
  const [error, setError] = ReactLib.useState('')

  // Wide: park beside the gear. Observe the foot (not the whole document).
  // A short poll covers settings mounting a frame later than this slot.
  ReactLib.useLayoutEffect(() => {
    const node = rootRef.current
    if (node === null) return undefined
    if (homeRef.current === null) homeRef.current = node.parentElement
    const home = homeRef.current

    if (wide !== true) {
      const foot = findFoot(node)
      if (foot) clearWideFootStyle(foot)
      try {
        if (home && node.parentElement !== home) home.appendChild(node)
      } catch { /* unmounting */ }
      return undefined
    }

    placeBesideSettings(node)

    const observeTarget = findFoot(node) || (home && home.parentElement) || home
    const observer = typeof MutationObserver === 'function' && observeTarget
      ? new MutationObserver(() => { placeBesideSettings(node) })
      : null
    if (observer && observeTarget) {
      observer.observe(observeTarget, { childList: true, subtree: true })
    }
    const timer = typeof setInterval === 'function'
      ? setInterval(() => { placeBesideSettings(node) }, 100)
      : 0
    const stop = typeof setTimeout === 'function' && timer
      ? setTimeout(() => { clearInterval(timer) }, 2000)
      : 0

    return () => {
      if (observer) observer.disconnect()
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      const currentFoot = findFoot(node)
      if (currentFoot) clearWideFootStyle(currentFoot)
      try {
        if (home && node.parentElement !== home) home.appendChild(node)
      } catch { /* unmounting */ }
    }
  }, [wide])

  // React may put the node back under footerActions on local state updates.
  ReactLib.useLayoutEffect(() => {
    if (wide !== true) return
    const node = rootRef.current
    if (node === null) return
    placeBesideSettings(node)
  }, [wide, open, busy, error])

  ReactLib.useEffect(() => {
    if (open !== true) return undefined
    const onPointer = (event) => {
      const node = rootRef.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = async (action) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await postAction(action)
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const label = busy ? translate('status.working') : translate('button.label')
  return E('div', {
    ref: rootRef,
    className: wide ? 'dsh-rebooter wide' : 'dsh-rebooter rail',
    'data-plugin': 'dsh-rebooter',
  },
    E('button', {
      type: 'button',
      className: 'dsh-rebooter-btn',
      'aria-label': translate('button.title'),
      title: translate('button.title'),
      'aria-haspopup': 'menu',
      'aria-expanded': open ? 'true' : 'false',
      'data-open': open ? '' : undefined,
      disabled: busy,
      onClick: () => { if (!busy) setOpen(value => !value) },
    },
      E(PowerIcon, { size: wide ? 16 : 18 }),
    ),
    open ? E('div', { className: 'dsh-rebooter-menu', role: 'menu', 'aria-label': label },
      ...MENU.map(item => E('button', {
        key: item.action,
        type: 'button',
        role: 'menuitem',
        className: 'dsh-rebooter-item',
        disabled: busy,
        onClick: () => { void run(item.action) },
      }, translate(item.key))),
      error ? E('div', { className: 'dsh-rebooter-error' }, translate('status.error')) : null,
    ) : null,
  )
}

export const inject = ['slots', 'locale']

export const __testing = {
  COPY, MENU, NS, findFoot, findSettingsTriggerRow, placeBesideSettings,
  postAction, RebooterMenu, PowerIcon,
}

export function apply(ctx) {
  ctx.effect(() => stylesApi.insert(STYLES), 'dsh-rebooter: styles')
  ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-rebooter: copy')
  if (typeof ctx.locale.bind === 'function') locale.t = ctx.locale.bind(NS)

  const tBound = () => (typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : t)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-rebooter',
    order: 50,
    locale: NS,
    label: () => tBound()('button.label'),
  }, function RebooterSlot(props) {
    return E(RebooterMenu, { wide: props.wide === true, t: tBound() })
  }))
}
