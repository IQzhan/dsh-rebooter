# Status panel — design

This document is the source of truth for the **DSH Server** status panel.
It replaces the five separate desktop launchers with one control surface that
works whether or not the DSH web UI is open.

Chinese summary: [`status-panel.zh.md`](status-panel.zh.md).

## Goals

1. See what DSH is doing (start / stop / restart / update plugins / update DSH / open) **without**
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

The panel renders **service** buttons, then two titled groups (**Plugins** / **DSH**). Never a lone “Update”.

| DSH web | Service | Plugins | DSH |
| --- | --- | --- | --- |
| **Stopped** | Start service | Update plugins · Update plugins and start service | Update DSH · Update DSH and start service |
| **Running** | Stop service · Restart service | Update plugins and stop service · Update plugins and restart service | Update DSH and stop service · Update DSH and restart service |

`open` stays on the Open UI row (not in the action groups).

Mapping to CLI actions:

| UI label (en) | Action id |
| --- | --- |
| Start service | `start` |
| Update plugins | `update` (plugins only, stay down) |
| Update plugins and start service | `update-restart` |
| Update plugins and stop service | `update-stop` |
| Update plugins and restart service | `update-restart` |
| Update DSH | `update-dsh` |
| Update DSH and start service | `update-dsh-restart` |
| Update DSH and stop service | `update-dsh-stop` |
| Update DSH and restart service | `update-dsh-restart` |
| Stop service | `stop` |
| Restart service | `restart` |
| Open UI | `open` (own window, or a bound app) |

The page-window power button opens the same four **plugin** items (`stop` / `restart` / `update-stop` / `update-restart`). DSH upgrades are panel + CLI only.
Opening the panel for progress is automatic when those run.

## Progress vs console

**Chosen default (simple + enough signal):**

1. Always show a **status strip** (phase text + spinner when busy).
2. Show the **log pane only while busy**, or when the last job ended in
   `error` (until the next idle action). Idle success → log hidden.
3. Log is read-only, auto-scroll, no input.
4. Re-opening the panel mid-job restores the same strip + live log (SSE / poll
   on the files). No manual refresh.
5. Plugin / DSH upgrades that fail mid-flight **roll back** to the pre-update
   state; `… and restart service` still tries to bring the host back up, with
   the failure kept on the status strip.

Rationale: a permanent console is noise for “is it up?”; hiding all detail
makes failures opaque. Mid-ground matches “tell me what is happening” without
a fake terminal on the idle home screen.

## Open UI

- **Open UI** opens the page in its own window (the OS web view, not a browser tab). A bound program still wins.
- Gear (**bind app**): pick an executable; then the gear becomes **Clear**.
- Checkbox **Open UI when the service starts** ↔ `panel.json.autoOpen` (default off).
- `stop` and `update-stop` / `update-dsh-stop` close the page window after the action is accepted. The window close button does not stop the service.
- `start` / `restart` / `update-restart` / `update-dsh-restart` call `openDshUi` **only**
  when `autoOpen` is true (or CLI `--open` is passed explicitly). A bound program still wins; otherwise the page opens in its own window.
- If the target looks already open: best-effort focus; browser path re-hits the
  URL so the page reloads when the browser cooperates.

## Desktop entry

After install, the first Host mount writes a Desktop shortcut named **`DSH Server`**. A later mount does not write it again, even if the icon was deleted. `dsh-rebooter desktop` and the panel button **Put on Desktop** write it again.

1. The relocatable entry ships in **`<installed-package>/panel/`** (`DSH-Server.vbs` and `DSH-Server.sh`). It finds `node` on `PATH` and `lib/cli.cjs` from its own folder. No machine path is stored in that file.
2. The Desktop shortcut is the only file that records where the package is installed. Its icon is `panel/dsh-server.ico` (the official DeepSeek mark on a tile), never the `.vbs`. The DSH page window uses `dsh.ico`. A marker under `$DSH_HOME/rebooter/` remembers that the shortcut was created.
3. The first successful write also removes legacy five-file launchers and any leftover `_dsh-mkshortcut*.vbs` on the Desktop.

The window host (`@webviewjs/webview`) is a dependency of the installable package. `node build-rebooter.mjs` installs it inside `package/node_modules` for the current OS, so a linked or copied package can open the window without the source checkout.

If automatic Desktop write fails (no Desktop folder, permissions), the CLI
prints the generated path and the exact command to re-run.

### Window chrome

| Window | Shell |
| --- | --- |
| Status panel | Frameless. Custom title bar (minimize + close). Portable screen-delta drag — no Aero Snap, no cursor change. Appearance / locale from the profile `cordis.patch.yml` (legacy `settings.yaml` only if the patch is missing). Action buttons stay stable across polls so clicks are not swallowed. |
| DSH page | Frameless; page content unchanged. Hover the top-right L (≈12px) to show power / min / max / close. Top blank band: drag window (Windows uses OS caption drag → Aero Snap; other platforms use the same screen-delta as the panel). Double-click that band posts the same `max` IPC as the maximize button. The max icon follows `shell.isMaximized()` only. Optional Win32 helper (`windows-caption-drag.cjs`) is loaded only for this window on Windows. |

Close on either window hides that window only — it does not stop DSH or the panel HTTP process.

## CLI surface

```
dsh-rebooter panel          # ensure panel HTTP + show window
dsh-rebooter desktop        # put the Desktop shortcut back
dsh-rebooter start|stop|…   # unchanged, plus job.* updates; open respects prefs
dsh-rebooter update         # profile plugins
dsh-rebooter update-dsh*    # recorded DSH harness (git / npm)
dsh-rebooter open           # open UI
```

## Host / Client

- Host `POST /action` (menu actions): `dispatchCli` as today, then
  `ensurePanelVisible()` so progress appears even if the user never opened
  the panel.
- Host mount: `installPanelEntry` creates the Desktop shortcut only when `$DSH_HOME/rebooter/desktop.created` is absent. `desktop` and `POST /api/desktop` pass `forceDesktop`.
- Client: no sidebar control. The menu is the power button on the page window.

## Decoupling checklist

| Layer | Portable? |
| --- | --- |
| core (ports, action sets, availability matrix) | yes |
| runtime job + prefs + performAction | yes |
| panel HTTP + HTML | yes |
| window shell + Desktop shortcut + icon | OS-specific generators; optional Win32 caption-drag helper for the DSH page only |

## Testing

- Unit: action availability matrix, `panelPort`, prefs defaults, job state machine.
- Runtime: panel HTTP snapshot/SSE/action, desktop installer paths, legacy cleanup.
- Package: `cli.cjs` exposes `panel` / `update` / `open`; the client does not register a sidebar slot.
- Docs: README both languages list the single **DSH Server** entry and the
  button matrix.
