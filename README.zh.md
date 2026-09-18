# dsh-rebooter

[English](README.md) · **简体中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**启动 / 关闭 / 重启 / 更新 / 打开界面**的插件：侧栏「设置」旁一个菜单；桌面一个 **DSH Server** 状态面板入口。更新会先关掉 DSH，再升级当前 profile 里的**全部插件**。

制作规范见 [`docs/dsh-plugin-spec.md`](docs/dsh-plugin-spec.md)；设计取舍见 [`docs/design-notes.md`](docs/design-notes.md)；状态面板见 [`docs/status-panel.md`](docs/status-panel.md)。

## 它做什么

| 动作 | 菜单 | 面板 / CLI |
| --- | --- | --- |
| `start` | 否 | 是 |
| `stop` | 是 | 是 |
| `restart` | 是 | 是 |
| `update` | 否 | 是（未启动时） |
| `update-stop` | 是 | 是 |
| `update-restart` | 是 | 是 |
| `open` | 否 | 是（已启动时） |
| `panel` | — | 打开 **DSH Server** |

菜单注册在 `sidebar.footer.action`。宽侧栏用 CSS 把页脚排成一行，并把本按钮放进设置 trigger 行；窄轨仍叠在设置上方。

启动后由独立的 Node 监督进程常驻：Web 宿主异常退出会拉起下一代，直到你主动 `stop`。启动**默认不再**打开浏览器，除非在面板勾选「启动时打开界面」（或 CLI 传 `--open`）。

## 安装

```bash
node build-rebooter.mjs
dsh plugin --profile web add ./package
```

需要 `Node 24` 或更高版本。面板窗口使用系统网页组件：Windows 为 `WebView2`，macOS 为系统 WebKit，Linux 为 `WebKitGTK`。组件缺失时，同一页面改由系统默认方式打开。面板文案跟随界面语言（`zh` 或 `en`）。

然后重启 `dsh web`。Host 挂载时也会尽力写入面板入口。也可手动：

```bash
node package/lib/cli.cjs desktop
```

会在 `package/panel/` 写入系统入口，并在桌面生成名为 **DSH Server** 的快捷方式。随时可用 `node package/lib/cli.cjs panel` 打开面板。

## 更新 / 卸载

```bash
git pull && node build-rebooter.mjs
```

卸载：`dsh plugin --profile web remove dsh-rebooter`。状态在 `$DSH_HOME/rebooter/`，想留就留。

菜单里的「更新」跑的是 `dsh plugin --profile web update --latest`，会更新**所有**已装插件，不只是本包。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `dsh-rebooter-core.js` | 纯策略：动作名、端口、可用性矩阵 |
| `dsh-rebooter-runtime.js` | Node IO：状态目录、监督进程、任务、桌面入口 |
| `dsh-rebooter-panel.js` | 状态面板 HTTP + HTML |
| `dsh-rebooter.host.js` | Cordis 适配：记录启动、HTTP、派出 CLI |
| `dsh-rebooter.client.js` | 侧栏菜单 |
| `dsh-rebooter-cli.js` | `start` / `stop` / `restart` / `update*` / `open` / `panel` / `desktop` |
| `build-rebooter.mjs` | 构建 `package/` |
| `docs/dsh-plugin-spec.md` | DSH 插件制作规范 |
| `docs/design-notes.md` | 本插件的设计说明 |
| `docs/status-panel.md` | DSH Server 面板设计 |

## 测试

```bash
node verify.mjs
```

**8 个套件、171 条断言**：策略核心 · 运行时 · 面板 · 适配层 · 包 · 菜单 · 文档双语同步 · 可移植性守卫。

测试临时文件写在仓库内 `.tmp/`，不写系统临时目录。

## 许可

[MIT](LICENSE)
