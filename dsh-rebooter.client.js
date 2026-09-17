/**
 * dsh-rebooter — Client half: one sidebar-foot menu to the left of Settings.
 *
 * Registers into `sidebar.footer.action`. In the wide column the component
 * moves its own DOM node into the Settings trigger row (the first child of
 * the settings seat) so the gear is squeezed rather than covered. The rail
 * stays stacked — two 36px circles will not fit side-by-side in 56px.
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
.dsh-rebooter {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  z-index: 2;
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

function findSettingsTriggerRow(node) {
  const actions = node && node.parentElement
  const foot = actions && actions.parentElement
  if (!foot) return undefined
  for (let index = 0; index < foot.children.length; index += 1) {
    const child = foot.children[index]
    if (child === actions) continue
    const row = child.firstElementChild
    if (row) return row
  }
  return undefined
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
  const [open, setOpen] = ReactLib.useState(false)
  const [busy, setBusy] = ReactLib.useState(false)
  const [error, setError] = ReactLib.useState('')

  ReactLib.useLayoutEffect(() => {
    const node = rootRef.current
    if (node === null) return undefined
    const home = node.parentElement
    if (wide !== true) return undefined
    const row = findSettingsTriggerRow(node)
    if (row === undefined) return undefined
    row.insertBefore(node, row.firstChild)
    return () => {
      try {
        if (home) home.appendChild(node)
      } catch {
        /* unmounting */
      }
    }
  }, [wide])

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
  COPY, MENU, NS, findSettingsTriggerRow, postAction, RebooterMenu, PowerIcon,
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
