# DSH plugin conventions

This document records **why** `dsh-rebooter` is shaped the way it is. The installable-package rules themselves live in [`dsh-plugin-spec.md`](dsh-plugin-spec.md).

## One menu, panel actions

| Action | From the in-app menu | From the panel / CLI |
| --- | --- | --- |
| `start` | no (DSH is already running) | yes |
| `stop` | yes | yes |
| `restart` | yes | yes |
| `update` | no | yes (when stopped) |
| `update-stop` | yes | yes |
| `update-restart` | yes | yes |
| `open` | no | yes (when running) |

The four in-app items open from the power button on the page window's control bar. They are not a sidebar control, and they are not a one-click stop. Start stays on the panel and the CLI.

The desktop entry is a single **DSH Server** status panel (see [`status-panel.md`](status-panel.md)). Start does **not** open the browser unless `panel.json` has `autoOpen: true` or the CLI passes `--open`.

## Persistence without Windows

The PowerShell helpers in a local harness checkout used a scheduled task, a named mutex, Win32 priority, and `taskkill`. Those keep a console-launched `dsh web` alive on one OS, and they are not a plugin.

This plugin's equivalent is a **detached Node supervisor** (no console window):

1. The Host half, on mount, records `process.execPath` / `execArgv` / `argv` / `cwd` / `DSH_HOME` under `$DSH_HOME/rebooter/`.
2. The Host **adopts** the supervisor once: if a CLI-spawned supervisor is already listening, it is `release`d (exits without signalling DSH) and a new one is spawned from the Host. That way the long-lived Host owns the watcher and a launcher Job Object cannot kill it. No heartbeat — DSH is never killed to "heal".
3. The supervisor `listen`s on `127.0.0.1:(webPort+10000)`. That bind is the singleton lock — a second start exits. A second `dsh-rebooter start` does not open the browser unless `autoOpen` is set or `--open` is passed.
4. If the recorded host pid exits on its own and no stop was requested, the supervisor relaunches the same argv (always with `--no-open`). A running host is never SIGTERM'd except by explicit `stop` / `restart` / `update-*`.
5. `stop` writes a stopping file, asks the control port to quit, then signals the recorded pids.

Closing a terminal, Explorer, or the browser therefore does not end DSH. Only `stop` / `update-stop` does. Spawn uses Node `detached` + `windowsHide` + ignored stdio — no console titled by `process.title`, and no PowerShell / schtasks / VBS on the supervisor hot path (VBS is only the optional desktop double-click launcher).

On Windows, a console-less host would otherwise flash a new console for every short-lived child (tool calls). `envForHost` **prepends** `--require <package>/windows-hide-child.cjs` to `NODE_OPTIONS` (keeping any existing value after it, so other preloads such as a system-proxy hook still wrap ours). That preload defaults Node's `windowsHide` spawn option when the caller omitted it — no Win32 APIs, and a no-op on other platforms. This only applies when this plugin starts the host (`start` / the supervisor); a terminal `dsh web` does not get the inject.

## Outbound network

This plugin does not read, strip, or set proxy variables. The environment of the process that starts it is copied onto the supervisor and the host. If that copy has no `NODE_OPTIONS`, the plugin fills it from its own sources first (`DSH_NODE_OPTIONS`, then `$DSH_HOME/rebooter/node-options`), and only on Windows falls back to a read of the user environment so an already-installed preload still loads when the parent dropped it. Following the system proxy, including a change after DSH is already up, remains that preload's job.

## Update means every plugin, after DSH is down

`update-stop` and `update-restart` reconstruct

```
<same node + execArgv> plugin --profile web update --latest
```

from the captured launch. That is `dsh plugin --profile web update --latest`. It runs in a **separate** CLI process after the web host has exited. This plugin does not rewrite that process's environment.

There is no `git pull` of the harness checkout and no overlay dance. Those belong to a source tree, not to an installed plugin.

## Start from the desktop

```
npx --yes dsh-rebooter desktop
```

Puts **DSH Server** back on the Desktop. The shortcut is also created the first time the Host mounts, and not again after that. Double-click opens the status panel (`dsh-rebooter panel`). The shortcut is the only install-time absolute pointer; the plugin source never embeds a Desktop path.
