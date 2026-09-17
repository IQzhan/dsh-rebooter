# dsh-rebooter

**English** · [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for **start / stop / restart / update**. One menu to the left of Settings; a desktop launcher for start. Update stops DSH first, then upgrades **every plugin** in the current profile.

Plugin conventions: [`docs/dsh-plugin-spec.md`](docs/dsh-plugin-spec.md). Design notes: [`docs/design-notes.md`](docs/design-notes.md).

## What it does

| Action | Menu | Desktop / CLI |
| --- | --- | --- |
| `start` | no | yes |
| `stop` | yes | yes |
| `restart` | yes | yes |
| `update-stop` | yes | yes |
| `update-restart` | yes | yes |

The menu registers on `sidebar.footer.action`. In the wide sidebar the button is moved to the left of the Settings trigger so the gear is squeezed; on the rail it stays stacked above Settings.

A detached Node supervisor keeps DSH alive after start: an unexpected host exit is relaunched until you `stop`. A second `start` only opens the browser.

## Install

```bash
node build-rebooter.mjs
dsh plugin --profile web add ./package
```

Then restart `dsh web`. Put start on the desktop:

```bash
node package/lib/cli.cjs desktop
node package/lib/cli.cjs start
```

## Update / uninstall

```bash
git pull && node build-rebooter.mjs
```

Uninstall: `dsh plugin --profile web remove dsh-rebooter`. State lives in `$DSH_HOME/rebooter/` and is left in place.

The in-app Update actions run `dsh plugin --profile web update --latest`, which updates **every** installed plugin, not only this one.

## Layout

| File | Role |
| --- | --- |
| `dsh-rebooter-core.js` | Pure policy: action names, launch argv, singleton port |
| `dsh-rebooter-runtime.js` | Node IO: state dir, supervisor, desktop launcher |
| `dsh-rebooter.host.js` | Cordis adapter: records launch, HTTP, dispatches CLI |
| `dsh-rebooter.client.js` | Sidebar menu |
| `dsh-rebooter-cli.js` | `start` / `stop` / `restart` / `update-*` / `desktop` |
| `build-rebooter.mjs` | Builds `package/` |
| `docs/dsh-plugin-spec.md` | DSH plugin conventions |
| `docs/design-notes.md` | Why this plugin is shaped this way |

## Tests

```bash
node verify.mjs
```

**7 suites, 127 assertions**: policy core · runtime · adapter · package · menu · bilingual docs · portability guard.

Scratch files stay in-repo under `.tmp/`, never the system temp directory.

## License

[MIT](LICENSE)
