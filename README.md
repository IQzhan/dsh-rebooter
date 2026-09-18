# dsh-rebooter

**English** · [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for **start / stop / restart / update / open**. One sidebar menu beside Settings; one desktop entry **DSH Server** for the status panel. Update stops DSH first, then upgrades **every plugin** in the current profile.

Plugin conventions: [`docs/dsh-plugin-spec.md`](docs/dsh-plugin-spec.md). Design notes: [`docs/design-notes.md`](docs/design-notes.md). Status panel: [`docs/status-panel.md`](docs/status-panel.md).

## What it does

| Action | Menu | Panel / CLI |
| --- | --- | --- |
| `start` | no | yes |
| `stop` | yes | yes |
| `restart` | yes | yes |
| `update` | no | yes (when stopped) |
| `update-stop` | yes | yes |
| `update-restart` | yes | yes |
| `open` | no | yes (when running) |
| `panel` | — | opens **DSH Server** |

The menu registers on `sidebar.footer.action`. In the wide sidebar the foot is laid out as a row (CSS) and this control is parked in the Settings trigger row; on the rail it stays stacked above Settings.

A detached Node supervisor keeps DSH alive after start: an unexpected host exit is relaunched until you `stop`. Start no longer opens the browser unless **Open UI when DSH starts** is checked in the panel (or you pass `--open`).

## Install

```bash
node build-rebooter.mjs
dsh plugin --profile web add ./package
```

Requires `Node 24` or newer. The panel window uses the OS web view: `WebView2` on Windows, system WebKit on macOS, `WebKitGTK` on Linux. If that runtime is missing, the same page opens with the default URL handler. The panel follows the UI language (`zh` or `en`).

Then restart `dsh web`. Host mount also tries to write the panel entry. To (re)write it by hand:

```bash
node package/lib/cli.cjs desktop
```

That writes `package/panel/` entry files and a Desktop shortcut named **DSH Server**. Double-click it to open the status panel. Open the panel anytime with `node package/lib/cli.cjs panel`.

## Update / uninstall

```bash
git pull && node build-rebooter.mjs
```

Uninstall: `dsh plugin --profile web remove dsh-rebooter`. State lives in `$DSH_HOME/rebooter/` and is left in place.

The in-app Update actions run `dsh plugin --profile web update --latest`, which updates **every** installed plugin, not only this one.

## Layout

| File | Role |
| --- | --- |
| `dsh-rebooter-core.js` | Pure policy: action names, ports, availability matrix |
| `dsh-rebooter-runtime.js` | Node IO: state dir, supervisor, jobs, desktop entry |
| `dsh-rebooter-panel.js` | Status panel HTTP + HTML |
| `dsh-rebooter.host.js` | Cordis adapter: records launch, HTTP, dispatches CLI |
| `dsh-rebooter.client.js` | Sidebar menu |
| `dsh-rebooter-cli.js` | `start` / `stop` / `restart` / `update*` / `open` / `panel` / `desktop` |
| `build-rebooter.mjs` | Builds `package/` |
| `docs/dsh-plugin-spec.md` | DSH plugin conventions |
| `docs/design-notes.md` | Why this plugin is shaped this way |
| `docs/status-panel.md` | DSH Server panel design |

## Tests

```bash
node verify.mjs
```

**8 suites, 171 assertions**: policy core · runtime · panel · adapter · package · menu · bilingual docs · portability guard.

Scratch files stay in-repo under `.tmp/`, never the system temp directory.

## License

[MIT](LICENSE)
