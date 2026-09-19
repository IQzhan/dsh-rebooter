# Status panel — design

This document is the source of truth for the **DSH Server** status panel.
It replaces the five separate desktop launchers with one control surface that
works whether or not the DSH web UI is open.

Chinese summary: [`status-panel.zh.md`](status-panel.zh.md).

## Goals

1. See what DSH is doing (start / stop / restart / update / open) **without**
   opening the chat UI.
2. One double-click entry: **DSH Server**.
3. Closing or minimizing the panel never stops DSH or the supervisor.
4. Keep the stack portable: shared Node logic; only the window shell is OS-specific.

## Non-goals (explicitly dropped)

| Idea | Why dropped |
| --- | --- |
| Five desktop launchers (`DSH-start` …) | Replaced by one panel; clutter and no shared status. |
| Always-visible full console | Idle UI must stay quiet; log only while a job runs (or after an error). |
| Start always opens the browser | User must opt in via **auto-open**, or press **Open UI**. |
| Panel process owns DSH lifetime | Panel is display + dispatch only; lifecycle stays in CLI / supervisor. |
| Perfect “focus existing browser tab + refresh” on every OS | Best-effort: re-navigate to the URL; custom apps are spawned / focused when the OS allows. |

## Architecture

```
┌────────────────────┐     files      ┌──────────────────────────────┐
│  DSH Server panel  │◄──────────────►│  $DSH_HOME/rebooter/         │
│  (HTML + tiny HTTP)│   job + prefs  │  job.json  job.log  panel.json│
└─────────┬──────────┘                │  layout.json  web.*  …       │
          │ POST action               └──────────────────────────────┘
          ▼
┌────────────────────┐     spawn      ┌──────────────────────────────┐
│  dsh-rebooter CLI  │───────────────►│  supervisor + dsh web host   │
│  performAction()   │   writes job   └──────────────────────────────┘
└────────────────────┘
```

- **Status bus** = plain files under `$DSH_HOME/rebooter/` (same home rule as
  the rest of the plugin). No extra daemon database.
- **Panel HTTP** = `127.0.0.1:(webPort + 10001)` (see `panelPort()` in core).
  Singleton bind: a second `panel` call focuses the existing UI instead of
  starting another server.
- **Job runner** = existing `performAction` / `dispatchCli`. The panel never
  embeds lifecycle code; it only starts the CLI and reads progress files.
- **Window shell** = OS web view (`WebView2`, system WebKit, or `WebKitGTK`) loading the local URL. If that runtime is missing, DSH Server and the DSH page open with the default URL handler. Copy follows `zh` or `en`. Desktop entry: Windows shortcut, macOS `.app` (no Terminal), Linux `.desktop` with `dsh-server.png`. Generated under the plugin package (`package/panel/`) and named **DSH Server**.

## Status bus files

| File | Role |
| --- | --- |
| `job.json` | Current or last job: `id`, `action`, `state` (`idle`/`busy`/`ok`/`error`), `message`, timestamps, `error`. |
| `job.log` | Append-only UTF-8 lines for the active job (truncateded). Truncated when a new job starts. |
| `panel.json` | Prefs: `autoOpen` (bool, default `false`), `openApp` (`null` \| absolute path). |

`performAction` (and helpers it calls) is responsible for updating `job.*`.
The panel only reads them (and writes `panel.json` for prefs).

## Available actions (by stable state)

Stable = no busy job. While `job.state === 'busy'`, **no** action buttons are
shown (progress + log only).

| DSH web | Buttons |
| --- | --- |
| **Stopped** | Start service · Update · Update and start service |
| **Running** | Stop service · Restart service · Update and stop service · Update and restart service · Open UI |

Mapping to CLI actions:

| UI label (en) | Action id |
| --- | --- |
| Start service | `start` |
| Update | `update` (new: plugins only, stay down) |
| Update and start service | `update-restart` |
| Stop service | `stop` |
| Restart service | `restart` |
| Update and stop service | `update-stop` |
| Update and restart service | `update-restart` |
| Open UI | `open` (own window, or a bound app) |

The page-window power button opens the same four items (`stop` / `restart` / `update-*`).
Opening the panel for progress is automatic when those run.

## Progress vs console

**Chosen default (simple + enough signal):**

1. Always show a **status strip** (phase text + spinner when busy).
2. Show the **log pane only while busy**, or when the last job ended in
   `error` (until the next idle action). Idle success → log hidden.
3. Log is read-only, auto-scroll, no input.
4. Re-opening the panel mid-job restores the same strip + live log (SSE / poll
   on the files). No manual refresh.

Rationale: a permanent console is noise for “is it up?”; hiding all detail
makes failures opaque. Mid-ground matches “tell me what is happening” without
a fake terminal on the idle home screen.

## Open UI

- **Open UI** opens the page in its own window (the OS web view, not a browser tab). A bound program still wins.
- Gear (**bind app**): pick an executable; then the gear becomes **Clear**.
- Checkbox **Open UI when the service starts** ↔ `panel.json.autoOpen` (default off).
- `stop` and `update-stop` close the page window after the action is accepted. The window close button does not stop the service.
- `start` / `restart` / `update-restart` call `openDshUi` **only**
  when `autoOpen` is true (or CLI `--open` is passed explicitly). A bound program still wins; otherwise the page opens in its own window.
- If the target looks already open: best-effort focus; browser path re-hits the
  URL so the page reloads when the browser cooperates.

## Desktop entry

After install (Host mount once, and/or `dsh-rebooter desktop`):

1. Write a relocatable entry under **`<installed-package>/panel/`** (next to `lib/cli.cjs`). It finds `node` on `PATH` and `lib/cli.cjs` from its own folder. No machine path is stored in that file.
2. Write a Desktop shortcut named **`DSH Server`**. The shortcut is the only file that records where the package is installed, and Host mount rewrites it. Its icon is `panel/dsh-server.ico` (the official DeepSeek mark on a tile), never the `.vbs`. The DSH page window uses `dsh.ico`.
3. Remove legacy five-file launchers and any leftover `_dsh-mkshortcut*.vbs` on the Desktop.

The window host (`@webviewjs/webview`) is a dependency of the installable package. `node build-rebooter.mjs` installs it inside `package/node_modules` for the current OS, so a linked or copied package can open the window without the source checkout.

If automatic Desktop write fails (no Desktop folder, permissions), the CLI
prints the generated path and the exact command to re-run.

### Window chrome

| Window | Shell |
| --- | --- |
| Status panel | One frameless host (`decorations: false`). The page draws the title bar, and only minimize and close. Dragging that bar uses the same screen-delta protocol as the DSH window. No OS caption buttons, and no per-OS window code in this plugin. Colors follow the DSH web tokens and `prefers-color-scheme`. Copy uses the same browser-language match as DSH when `locale.preference` is unset, and otherwise the value from `$DSH_HOME/settings.yaml`. Theme is `ui-theme.preference` (`light`, `dark`, or `system`) from that same file, polled with the snapshot. |
| DSH page | Frameless (`decorations: false`). The page is not restyled. A solid control plate appears only while the pointer is in a small top-right corner, then hides. Its power button opens the four-item lifecycle menu; beside it are minimize, maximize, and close. Dragging a non-interactive spot along the top moves the window through the same pointer protocol the panel title bar uses. No overlay mask. The taskbar icon is the official DSH mark. |

Custom minimize and close live in the page title bar. Close hides the window
only. It does not signal DSH, and it does not stop the panel HTTP process.

## CLI surface

```
dsh-rebooter panel          # ensure panel HTTP + show window
dsh-rebooter desktop        # (re)write package/panel entry + Desktop shortcut
dsh-rebooter start|stop|…   # unchanged, plus job.* updates; open respects prefs
dsh-rebooter update         # new
dsh-rebooter open           # new
```

## Host / Client

- Host `POST /action` (menu actions): `dispatchCli` as today, then
  `ensurePanelVisible()` so progress appears even if the user never opened
  the panel.
- Host mount: best-effort `installPanelEntry` once (idempotent).
- Client: no sidebar control. The menu is the power button on the page window.

## Decoupling checklist

| Layer | Portable? |
| --- | --- |
| core (ports, action sets, availability matrix) | yes |
| runtime job + prefs + performAction | yes |
| panel HTTP + HTML | yes |
| window shell + Desktop shortcut + icon | OS-specific generators only |

## Testing

- Unit: action availability matrix, `panelPort`, prefs defaults, job state machine.
- Runtime: panel HTTP snapshot/SSE/action, desktop installer paths, legacy cleanup.
- Package: `cli.cjs` exposes `panel` / `update` / `open`; the client does not register a sidebar slot.
- Docs: README both languages list the single **DSH Server** entry and the
  button matrix.
