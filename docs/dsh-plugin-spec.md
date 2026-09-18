# DSH 插件制作规范

本文从 `DSH-ModelSelector`（`dsh-model-router`）的可安装形态、加载器契约与踩过的坑里抽出**第三方 DSH 插件必须遵守的规范**。本仓库的 `dsh-rebooter` 按此规范实现。

规范只约束「怎么做成一个能被 DSH 加载的插件」，不约束插件自己的业务。

---

## 1. 持久安装的单位是包，不是文件

DSH 的 profile 行只挂载它点名的那一个模块。浏览器永远看不到这个模块，所以「裸文件行」（`name: ./foo.mjs`）会挂上 Host 半边、**却不产生任何 Client UI**。

`packages/client/modules` 决定什么能进浏览器：从一行的模块 URL 往上找到最近的 `package.json`，读 `dsh.client` 声明；没有声明的包被跳过，声明了却没有 `exports["./client"]` 的包直接报错。

因此持久安装的形状是：

```
package/                          ← `dsh plugin add` 安装的就是这个目录
  package.json                    dsh.bundle + dsh.client + exports
  cordis.patch.yml                包自己的 insert 行（bundle 层）
  lib/index.cjs                   Host 半边（Cordis 行）
  lib/client.cjs                  浏览器包（window.__ModuleLoader__ 包装）
```

`dsh plugin --profile web add ./package` 会把该包追加进 profile 的 `dsh.profile.bundles`，并链接进 `$DSH_HOME/profiles/web/node_modules/<name>`。之后**重启 `dsh web`** 才加载（加载器只在启动时 import）。

动态插件（会话里 `cordis_run`）重启即失，且左下角「Cordis Plugin」面板只显示动态插件，不代表包是否已装。长期功能走包 + profile 行。

---

## 2. package.json 契约

```json
{
  "name": "<插件名，必须与 patch 行的 name 一致>",
  "type": "commonjs",
  "main": "./lib/index.cjs",
  "exports": {
    ".": { "default": "./lib/index.cjs" },
    "./client": { "default": "./lib/client.cjs" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": false,
      "inject": ["@deepseek-ai/dsh-client-ui-slots"],
      "external": ["react"]
    }
  }
}
```

| 字段 | 为什么必须这样 |
| --- | --- |
| `name` = patch 行 `name` | Client 扫描按包名解析；对不上就没有 UI |
| `dsh.bundle.patch` | 没有它，`dsh plugin add` 只当普通依赖，不激活层 |
| `dsh.client` + `exports["./client"]` | 缺一则 Host 在、设置/插槽 UI 不在 |
| `inject: ['@deepseek-ai/dsh-client-ui-slots']` | 插槽系统必须先于本包；否则注册无处可去 |
| `external: ['react']` | 浏览器 `require('react')` 由平台种子回答，保证与壳同一份 React |
| `immediately: false` | 与内置 Client 包一致：等壳就绪再加载 |

`cordis.patch.yml`：

```yaml
- insert:
    - id: <插件名>
      name: <插件名>
```

---

## 3. Host / Client 分裂

| 半边 | 跑在哪 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Host `lib/index.cjs` | Node，Cordis 加载器 `import` | 文件系统、子进程、`webServer` 路由、读 `process` | 碰 DOM、`React`、浏览器 `fetch` 的页面态 |
| Client `lib/client.cjs` | 浏览器，`window.__ModuleLoader__` | `ctx.slots`、`ctx.locale`、对 Host 暴露的 HTTP 发 `fetch` | `node:*`、`child_process`、顶层读 `React`/`ctx` |

同一份策略若要在测试里跑，写成**无 Cordis、无 IO 的纯函数**（或把 IO 收到参数里），再由构建拼进 Host。不要维护两份会漂的逻辑。

Client 与 Host 的对话优先走：

1. 已有的 Client 服务（`ctx.settingsScope`、`ctx.remote.*`）——零自建传输；
2. 否则 Host 用 `webServer.register({ kind: 'prefix', path: '/api/<插件名>', handler })` 挂一条同源 HTTP。

不要发明 `host.call`：那是**动态沙箱**的内建量，打包 Client 插件里不存在。

---

## 4. Cordis `apply` 的硬规则

1. **`apply` 必须返回 `undefined`（或 disposer / Promise / 迭代器）。** 返回普通对象会让整个 profile 树起不来：`Invalid effect`。动态 runner 容忍这个返回值，所以只在包/profile 路径上炸——离线测试必须断言返回值。
2. **`inject` 只声明启动时一定存在的服务。** 声明了却没挂上的服务会让这一行永远 `waiting`。可选能力用 `ctx.get('webServer')` 或 `ctx.inject(['webServer'], cb)`，缺了就降级。
3. **`ctx.plugin()` 返回时 `apply` 还没跑**（Cordis 异步启动）。fiber **一创建就登记**，另用 `applied` 记录启动是否真的跑过。用「apply 跑没跑」当返回值条件，会装上却没被记住，撤销也撤不干净。
4. **Client 不能在模块顶层读 `React` / `ctx` / `styles`。** 它们是求值体的参数，顶层 `const E = React.createElement` 会在 factory 调用时 `ReferenceError`。写成函数：`function E(...) { return React.createElement(...) }`。打包 Client 用 `typeof React !== 'undefined' ? React : require('react')` 同时覆盖两种加载器。
5. **卸载 = 销毁 fiber。** 不要改用户的预设文件、不要在卸载时「还原」你没改过的东西。运行时注册进作用域的工具/路由随 fiber 消失。

---

## 5. Client UI：只走公开 slot，文案走 locale

- 用 `ctx.slots.inject('<slot>', () => ctx.slots.register({ name, id, order, locale, label }, Component))`。
- **新 id** 加在已有条目旁边；**复用已有 id** 会换掉那一格。
- 设置页导航图标由壳硬编码，第三方 section 没有图标字段。
- 侧栏「设置」旁边的公开座位是 `sidebar.footer.action`（list）。壳把 footer actions 画在设置按钮**上方**；若视觉上要在设置左边，只能在自己的组件里把**自己的** DOM 节点挪到设置 trigger 行里，**禁止**改写或换掉 `sidebar.settings`。
- 文案：`ctx.locale.register(NS, { zh, en })` + `ctx.locale.bind(NS)`。源码字符串里除字典与注释外不得出现中日韩字符。两种语言的键集合必须一致。

第三方 Client 包的 `external` 默认只有 `react`。不要 `require('@deepseek-ai/dsh-client-ui-primitives')`——模块表里没有就加载失败。图标用手写 SVG，样式用 `styles.insert(css)` 或自建 `<style data-plugin>`，颜色走 DSH 的 CSS 变量（`--dsw-alias-*`）。

---

## 6. 构建：一份源码，三种模块规则

| 目标 | 模块规则 |
| --- | --- |
| Node 测试 | 普通 ESM，`import` 可用 |
| profile 行 | Cordis 加载器 `import` CJS/`exports["."]` |
| 浏览器 | `window.__ModuleLoader__.load({ id, factory: require => { ... } })`，不是 ESM |

构建只做去 `export`、把 `node:*` 的 `import` 改成 `require`、拼接、包上 ModuleLoader 包装，**不转译**。Host 半边若还要跑进动态沙箱，则不能有静态 `import`（沙箱无模块图）。本仓库的业务不走动态沙箱，Host 以 CJS 包为准。

链接进 profile 时，符号链接类型必须按平台选择：Windows 用 `junction`，其它用 `dir`。写死 `junction` 会让 POSIX 构建直接 `EINVAL`。

---

## 7. 可移植性（测试管，不靠自觉）

静默、只在「写它的那台机器」上正确的缺陷，一律写成断言：

| 禁止 | 原因 |
| --- | --- |
| 源码/产物里的绝对路径（盘符、本机用户目录） | 换机器即错 |
| 系统临时目录 API、Windows 专有的用户主目录变量 | 测试垃圾落到系统盘；主目录用 homedir / `DSH_HOME` |
| 无平台判断的目录联接类型 | POSIX 构建失败 |
| 运行时依赖 PowerShell / 计划任务 / Win32 / VBS / `taskkill` | 把插件绑死在 Windows |
| 界面中文写死在非字典位置 | 英文语言下漏出中文 |

允许的平台分支：**真正的运行时差异**写在一处（例如 `.cmd` 必须经 `cmd.exe` 启动、打开 URL 的 `open` / `xdg-open` / `cmd start`）。分支必须有对应的非 Windows 路径，且默认路径不能假设 Windows。

测试的临时文件写在仓库内 `.tmp/`，跑完即清，不写系统临时目录。

---

## 8. 生命周期类插件的额外约束

「启动 / 关闭 / 重启 / 更新」不能只写在 Host 进程里：更新与关闭必须在 **DSH 死后仍活着的进程**里做完。

| 动作 | 谁执行 |
| --- | --- |
| 启动（含桌面） | 独立 CLI：拉起监督进程，监督进程再拉起 `dsh web` |
| 关闭 / 重启 / 更新 | Host 只负责**派出**独立 CLI，然后可以死；CLI 在外面停进程、更新插件、按需再拉起 |
| 持久常驻 | 监督进程与所启动的 Web 宿主都 `detached`，不依附终端；Web 异常退出则监督进程拉起下一代，直到显式关闭 |
| 不重复启动 | 监督进程对本机 control 端口的 `listen` 是单例锁；已在服务则只打开浏览器 |

不要用 Windows 计划任务、命名互斥体、Win32 优先级、VBS 隐藏启动器来实现上述四点——那些是某台机器上的启动脚本，不是插件。

更新「所有插件」走 DSH 自己的接口：

```
dsh plugin --profile web update --latest
```

先关闭 DSH，再跑这条（profile 的 `node_modules` 正在被占用时 pnpm 会失败）。本插件不改写这次调用的环境变量；若有预加载钩子，钩子自己必须能让短进程正常退出。

状态与日志放在 `$DSH_HOME/rebooter/`，不放在某次 checkout 的 `.dsh-local/`（那是源码树私货，安装后的插件看不到）。

---

## 9. 验收清单（每个 DSH 插件）

- [ ] `package/` 可被 `dsh plugin --profile web add ./package` 安装
- [ ] `dsh.bundle.patch` + `dsh.client` + `exports["./client"]` 三件齐全
- [ ] Host `apply` 返回 `undefined`
- [ ] Client 不在顶层碰 `React`/`ctx`
- [ ] 卸载不改用户预设、不留 fiber
- [ ] 文案双语，键集合一致
- [ ] 无绝对路径、无 Windows 专有实现作为唯一路径
- [ ] 离线测试不写系统临时目录、不碰真实配置（或只读）
