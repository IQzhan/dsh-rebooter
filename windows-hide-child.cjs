'use strict'

/**
 * NODE_OPTIONS --require preload (Windows only).
 *
 * Rebooter starts the DSH host with no console. Child console-subsystem
 * processes would then allocate a visible window on every short spawn
 * (tool calls). Default Node's `windowsHide` when the caller omitted it.
 *
 * Mutates options in place (does not replace the object) so other preloads
 * that wrap child_process keep working. Only touches spawn/spawnSync — the
 * paths that flash a console.
 */
if (process.platform !== 'win32') return

const cp = require('node:child_process')

function ensureHide(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return { windowsHide: true }
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'windowsHide')) {
    options.windowsHide = true
  }
  return options
}

function wrap(orig) {
  return function wrapped(file, args, options) {
    if (args != null && typeof args === 'object' && !Array.isArray(args)) {
      return orig.call(this, file, ensureHide(args))
    }
    return orig.call(this, file, args, ensureHide(options))
  }
}

cp.spawn = wrap(cp.spawn)
cp.spawnSync = wrap(cp.spawnSync)
