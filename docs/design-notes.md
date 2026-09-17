# DSH plugin conventions

This document records **why** `dsh-rebooter` is shaped the way it is. The installable-package rules themselves live in [`dsh-plugin-spec.md`](dsh-plugin-spec.md).

## One menu, five actions

| Action | From the in-app menu | From the desktop / CLI |
| --- | --- | --- |
| `start` | no (DSH is already running) | yes |
| `stop` | yes | yes |
| `restart` | yes | yes |
| `update-stop` | yes | yes |
| `update-restart` | yes | yes |

The four in-app items sit on **one** `sidebar.footer.action` control, parked to the **left** of Settings in the wide sidebar by moving only this plugin's DOM node into the settings trigger row. The rail stays stacked: two 36px circles do not fit in 56px.

## Persistence without Windows

The PowerShell helpers in a local harness checkout used a scheduled task, a named mutex, Win32 priority, and `taskkill`. Those keep a console-launched `dsh web` alive on one OS, and they are not a plugin.

This plugin's equivalent is a **detached Node supervisor** (no console window):

1. The Host half, on mount, records `process.execPath` / `execArgv` / `argv` / `cwd` / `DSH_HOME` under `$DSH_HOME/rebooter/`.
2. The Host **adopts** the supervisor once: if a CLI-spawned supervisor is already listening, it is `release`d (exits without signalling DSH) and a new one is spawned from the Host. That way the long-lived Host owns the watcher and a launcher Job Object cannot kill it. No heartbeat — DSH is never killed to "heal".
3. The supervisor `listen`s on `127.0.0.1:(webPort+10000)`. That bind is the singleton lock — a second start exits, and a second `dsh-rebooter start` only opens the browser (after asking the living Host to re-adopt if needed).
4. If the recorded host pid exits on its own and no stop was requested, the supervisor relaunches the same argv (always with `--no-open`). A running host is never SIGTERM'd except by explicit `stop` / `restart` / `update-*`.
5. `stop` writes a stopping file, asks the control port to quit, then signals the recorded pids.

Closing a terminal, Explorer, or the browser therefore does not end DSH. Only `stop` / `update-stop` does. Spawn uses Node `detached` + `windowsHide` + ignored stdio — no console titled by `process.title`, and no PowerShell / schtasks / VBS on the supervisor hot path (VBS is only the optional desktop double-click launcher).

## Outbound proxy (Gemini / LLM)

Cursor and short CLIs often start **without** the User-level `NODE_OPTIONS=--require …/sysproxy-sync…` that routes Node `fetch` through the live WinINET proxy. A host started that way cannot reach Google APIs from networks that need Clash.

On spawn the plugin therefore:

1. Merges User/Machine `NODE_OPTIONS` when the parent process env lacks it (Windows `reg` read — same intent as the old launcher’s `Get-DshMergedUserEnv`).
2. Strips static `HTTP(S)_PROXY` on the **host** so sysproxy can follow WinINET on/off live.
3. If WinINET points at a local proxy that is **not listening**, drops `NODE_OPTIONS` and goes direct (dead Clash left enabled).
4. For **one-shot** update CLIs, strips `NODE_OPTIONS` (avoids hanging `tsx`/`pnpm`) and, when the proxy is up, sets a static `HTTPS_PROXY` for that short process only.

## Update means every plugin, after DSH is down

`update-stop` and `update-restart` reconstruct

```
<same node + execArgv> plugin --profile web update --latest
```

from the captured launch. That is `dsh plugin --profile web update --latest`. It runs in a **separate** CLI process after the web host has exited, with `NODE_OPTIONS` stripped so a persistent `--require` hook cannot hang the one-shot.

There is no `git pull` of the harness checkout and no overlay dance. Those belong to a source tree, not to an installed plugin.

## Start from the desktop

```
node package/lib/cli.cjs start
node package/lib/cli.cjs desktop
```

`desktop` writes a double-clickable launcher onto the user's Desktop (`DSH.vbs` on Windows with no console, `DSH.command` / `DSH.desktop` elsewhere). The launcher is machine-local; the plugin source never embeds a Desktop path.
