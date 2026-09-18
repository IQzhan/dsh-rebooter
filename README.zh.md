# dsh-rebooter

[English](README.md) · **简体中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**启动 / 关闭 / 重启 / 更新**的插件：侧栏「设置」左侧一个菜单，桌面五个可双击入口。更新会先关掉 DSH，再升级当前 profile 里的**全部插件**。

制作规范见 [`docs/dsh-plugin-spec.md`](docs/dsh-plugin-spec.md)；设计取舍见 [`docs/design-notes.md`](docs/design-notes.md)。

## 它做什么

| 动作 | 菜单 | 桌面 / CLI |
| --- | --- | --- |
| `start` | 否 | 是 |
| `stop` | 是 | 是 |
| `restart` | 是 | 是 |
| `update-stop` | 是 | 是 |
| `update-restart` | 是 | 是 |

菜单注册在 `sidebar.footer.action`。宽侧栏用 CSS 把页脚排成一行，并把本按钮放进设置 trigger 行；窄轨仍叠在设置上方。

启动后由独立的 Node 监督进程常驻：Web 宿主异常退出会拉起下一代，直到你主动 `stop`。已在运行时再 `start` 只打开浏览器，不会起第二份。

## 安装

```bash
node build-rebooter.mjs
dsh plugin --profile web add ./package
```

然后重启 `dsh web`。一条命令在桌面写入五个可双击入口（后缀随系统：`.vbs` / `.command` / `.desktop`）：

```bash
node package/lib/cli.cjs desktop
```

会生成 `DSH-start`、`DSH-stop`、`DSH-restart`、`DSH-update-stop`、`DSH-update-restart`。双击 `DSH-start` 即可启动并打开浏览器。

## 更新 / 卸载

```bash
git pull && node build-rebooter.mjs
```

卸载：`dsh plugin --profile web remove dsh-rebooter`。状态在 `$DSH_HOME/rebooter/`，想留就留。

菜单里的「更新」跑的是 `dsh plugin --profile web update --latest`，会更新**所有**已装插件，不只是本包。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `dsh-rebooter-core.js` | 纯策略：动作名、启动参数、单例端口 |
| `dsh-rebooter-runtime.js` | Node IO：状态目录、监督进程、桌面启动器 |
| `dsh-rebooter.host.js` | Cordis 适配：记录启动、HTTP、派出 CLI |
| `dsh-rebooter.client.js` | 侧栏菜单 |
| `dsh-rebooter-cli.js` | `start` / `stop` / `restart` / `update-*` / `desktop` |
| `build-rebooter.mjs` | 构建 `package/` |
| `docs/dsh-plugin-spec.md` | DSH 插件制作规范 |
| `docs/design-notes.md` | 本插件的设计说明 |

## 测试

```bash
node verify.mjs
```

**7 个套件、136 条断言**：策略核心 · 运行时 · 适配层 · 包 · 菜单 · 文档双语同步 · 可移植性守卫。

测试临时文件写在仓库内 `.tmp/`，不写系统临时目录。

## 许可

[MIT](LICENSE)
