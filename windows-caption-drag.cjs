'use strict'

/**
 * Windows caption drag — engages the OS move loop (Aero Snap / Shake).
 *
 * Frameless hosts that move the window with setPosition bypass DefWindowProc's
 * modal drag, so edge snap never runs. Posting WM_NCLBUTTONDOWN + HTCAPTION is
 * the same path tao/wry `drag_window` uses. No-ops on non-Windows platforms.
 */

const WM_NCLBUTTONDOWN = 0x00A1
const HTCAPTION = 2

let cached = null

function loadWin32() {
  if (cached !== null) return cached
  if (process.platform !== 'win32') {
    cached = false
    return cached
  }
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    cached = {
      ReleaseCapture: user32.func('bool __stdcall ReleaseCapture()'),
      PostMessageW: user32.func(
        'bool __stdcall PostMessageW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)',
      ),
    }
  } catch {
    cached = false
  }
  return cached
}

/**
 * @param {bigint | number | string} hwnd native window handle from getNativeHandle()
 * @returns {boolean} true when the OS move loop was requested
 */
function startCaptionDrag(hwnd) {
  const api = loadWin32()
  if (!api) return false
  let handle = 0n
  try {
    if (typeof hwnd === 'bigint') handle = hwnd
    else if (typeof hwnd === 'number' && Number.isFinite(hwnd)) handle = BigInt(Math.trunc(hwnd))
    else if (typeof hwnd === 'string' && hwnd.trim()) handle = BigInt(hwnd.trim())
  } catch {
    return false
  }
  if (handle === 0n) return false
  try {
    api.ReleaseCapture()
    return api.PostMessageW(handle, WM_NCLBUTTONDOWN, HTCAPTION, 0) === true
  } catch {
    return false
  }
}

module.exports = { startCaptionDrag }
