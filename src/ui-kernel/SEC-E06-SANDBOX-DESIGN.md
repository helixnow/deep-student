# SEC-E06 UI 半：社区插件 UI 放进 sandbox iframe（设计，未实施）

来源：`reviews/ELECTRON-SHELL-SECURITY.md` SEC-E06 第 2 点；方案 FE-E2（`plans/FRONTEND-PLUGINIZATION.md:363`）；
插件生态 v1 决议第 4 条（权限 `kind:target`，v1 只有 `service:<服务名>`，权限增加需重新同意）。

## 1. 问题与目标

现状：`src/ui-kernel/loader.ts` 用 `import('ds-plugin://<id>/ui.js')` 把社区 UI 模块加载进主窗口的主世界。
模块与官方代码同一个 realm，能直接拿到 `__TAURI_INTERNALS__`、全部内置插件、`plugin:host|call`，
还能改 DOM、读 `localStorage`、monkey-patch React。`ctx.ui` 的各种限制（命名空间、错误预算、核心插件）
只防误用，不防恶意。

目标（社区插件 1.0 开放前的阻断项）：
1. 社区 UI 代码不在主窗口 realm 中执行，拿不到 bridge、主窗口 DOM 和存储。
2. 社区 UI 能做的事，等于“宿主按 manifest 权限与用户同意转发的 RPC”。权限检查在宿主侧做，调用方身份由宿主绑定，不信任消息里的自称。
3. 官方插件和开发模式下的本地插件不受影响（`origin: 'builtin'` 继续走主世界）。

## 2. 架构

```
主窗口（官方代码，主世界）                         沙箱 iframe（每个社区插件一个 realm）
┌───────────────────────────────┐   MessagePort   ┌──────────────────────────────┐
│ UiKernel                      │◀──────────────▶│ @deepstudent/ui（沙箱构建）   │
│  SandboxBroker（每插件一个）    │  JSON-RPC 2.0   │  ctx.ui 代理 → RPC            │
│   · 端口与插件 id 绑定          │                 │  React 渲染远程界面            │
│   · 权限表（manifest + 同意）   │                 │  插件 ui.js                   │
│   · 方法白名单 + 载荷校验       │                 └──────────────────────────────┘
│  RemoteSurface 出口（iframe）   │
└───────────────────────────────┘
```

- **载体**：`<iframe sandbox="allow-scripts" src="ds-plugin-sandbox://<id>/frame.html">`。不给 `allow-same-origin`，
  因此 origin 是 opaque 的：读不到主窗口的 cookie、`localStorage`、IndexedDB，也拿不到 `parent` 的 DOM。
  不给 `allow-popups`、`allow-top-navigation`、`allow-forms`、`allow-modals`。
- **外壳（W06）**：
  - `ds-plugin-sandbox:` 协议只提供该插件包内的文件和 SDK 运行时，响应头 CSP 为
    `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'`。
  - 主窗口的 preload 不进入子 frame（`nodeIntegrationInSubFrames: false`，contextBridge 只暴露给主 frame），这一点要加 E2E 断言。
  - 隔离落地后，主窗口 CSP 的 `script-src` 去掉 `ds-plugin:` 与 `blob:`。
- **一插件一 realm**：
  - 一个常驻的“插件 frame”（0×0，`display:none` 不行，因为会被节流，改为离屏），运行插件的 `apply`，持有它的状态。
  - 需要显示界面的地方，再为每个挂载点开一个“界面 frame”。界面 frame 与插件 frame 同 origin，
    但都是 opaque origin，所以彼此之间也只能经宿主转发。见 §4。

## 3. 通信协议

- **建链**：
  - 宿主创建 iframe，`load` 后用 `postMessage({ type: 'ds:connect', v: 1 }, '*', [port2])` 移交一个 `MessageChannel` 端口。
  - 宿主只认 `event.source === iframe.contentWindow` 的握手回复，之后只用端口通信，不再监听 `window.message`。
  - 端口在宿主侧绑定插件 id。消息里不带、也不信任插件 id。
- **帧格式**（结构化克隆，宿主逐条校验形状和大小）：
  - 请求：`{ id: number, method: string, params: unknown }`
  - 响应：`{ id, result } | { id, error: { code, message } }`
  - 通知：`{ method, params }`，没有 id，比如宿主推送语言、主题、平台、Host 状态的变化。
  - 取消：`{ method: '$/cancel', params: { id } }`
- **握手**：
  - 插件 frame 发 `initialize { sdkVersion, apiVersion }`。
  - 宿主回 `{ pluginId, grants, platform, languages, theme, hostStatus, storageSnapshot }`。
  - `apiVersion` 高于内核版本时拒绝，与 `normalizeUiPluginMeta` 同一规则。
- **方法表**（封闭集合；未知方法返回 `-32601`，并计入错误预算）：

  | 方法 | 对应 v1/v2 API | 权限 |
  |---|---|---|
  | `contribute` / `revoke` | `ctx.ui.contribute`、`views/nav/settings.register`、`commands.register`、`contextMenu.register`、`chat.registerToolResult` | 无（只能写入社区可写的槽位，值必须是可序列化的描述，见 §4） |
  | `invokeCallback` | 宿主调用插件登记的回调，如命令 `execute`、菜单 `run` | — |
  | `host.call` | `ctx.ui.host.<服务>.<方法>()` | 需要 `service:<服务名>` 已授权；宿主带上调用方插件 id 调 `plugin:host\|call`，W01 校验服务属于该插件或已授权 |
  | `storage.get/set/remove/keys` | `ctx.ui.storage.*` | 无（键前缀 `ds:plugin:<id>:` 由宿主加） |
  | `i18n.addBundles` | `ctx.ui.i18n.addBundles` / 派生命名空间的 `addBundle` | 无（只能写派生命名空间，本轮已收紧） |
  | `navigate` | `ctx.ui.navigate` | 无（只能去已登记的视图） |
  | `reportError` | `ctx.ui.reportError` | — |
  | `surface.resize` / `surface.focus` / `surface.close` | 界面 frame 自身 | — |

- **限额**：
  - 单帧 ≤ 1 MB；每插件在途请求 ≤ 64；`host.call` 沿用 Host 侧超时。
  - 插件 frame 30 秒不回心跳视为挂起，宿主卸载它并计入错误预算。
  - 每一类违规都计入错误预算，社区插件累计 3 次自动卸载，与现有规则一致。

## 4. 能力怎么注入

- **权限来源**：只有 `package.json#deepStudent` 的 `permissions`（决议 3），与用户同意记录取交集，得到 `grants`。
  版本升级后权限增加，没有重新同意之前，新增部分不生效。
- **注入**：
  - 沙箱 SDK 的 `ctx.ui` 是本地代理。`ctx.ui.host` 只为 `grants` 里的服务生成访问器；没授权的服务访问时立即抛 `PermissionDenied`。
  - 本地代理只是为了给出好的报错，真正的检查在 broker：每次 `host.call` 都按端口绑定的插件 id 重新查 `grants`。
- **槽位的值必须可序列化**：
  - **数据型贡献**（`nav`、`commands`、菜单行、`chat.toolResults` 的匹配规则）：
    - 函数字段改成回调 id。宿主调用时发 `invokeCallback`，例如 `execute`、`run`。
    - 同步判定，例如菜单的 `visible(ctx)`、`when(props)`，不能跨 realm 同步调用。社区行改用声明式条件：
      `resourceTypes`、`scopes`（本轮新增的 `ScopedResourceMenuContribution`），以及受限的 `when` 表达式（字段 = 值、`in`、`not`）。
  - **组件型贡献**（`views`、`settings.sections`、`chat.toolResults` 的组件、`dashboard.widgets`）：
    - 宿主在出口处放一个 `RemoteSurface`，按需开界面 frame，把可序列化的 props 投影发过去，按 `surface.resize` 调整高度。
    - 主题以 `--ds-*` 变量快照注入，变化时通知；语言变化同理。
  - **高频内联位**（对话 block、工具结果卡片、代码块渲染器）：
    - 每条消息一个 iframe 太重。社区插件在这些位置改用“声明式卡片”：一份 JSON 描述，由宿主的官方组件渲染，类似生成式 UI 的 schema。
    - 需要交互的卡片，点击后打开界面 frame（面板或对话框）。
- **不提供**（沙箱内无意义或危险）：
  - `ctx.ui.pair`：配对由宿主按 meta 做。
  - `declareSlot`：社区框架插件放到 1.x。
  - `withPluginScope`、直接访问 `kernel.*`、任何官方内部模块。

## 5. 对现有 v1 社区插件 API 的影响

| API | 沙箱后 | 迁移 |
|---|---|---|
| `defineUiPlugin` / `definePlugin` | 不变 | — |
| `ctx.ui.views/nav/settings.register` | 组件在界面 frame 中渲染 | 组件写法不变；不能读宿主 context（主题与语言经 SDK hook 拿） |
| `ctx.ui.commands.register` | `execute` 变成异步回调 | 返回值被忽略，原来同步依赖返回值的要改 |
| `ctx.ui.contextMenu.register` | 不变（已经是声明式的 `resourceTypes` + `run`） | — |
| `ctx.ui.contribute` 到组件型槽位 | 走 `RemoteSurface` | props 只给投影，例如对话 block 拿不到 `ChatStore` 对象，改用只读快照与 RPC |
| `ctx.ui.chat.registerBlock/registerEvent/registerMode` | 社区不再开放；block 改用声明式卡片 | 有用到的社区插件需要改写（目前仓库里没有） |
| `ctx.ui.host.*` | 异步 RPC（本来就是），并做权限检查 | 声明 `service:` 权限 |
| `ctx.ui.storage` | 本地快照同步读、异步写 | 同一窗口内语义不变；跨窗口变化经通知同步 |
| `ctx.ui.i18n` | 只限派生命名空间（本轮已收紧） | 示例插件要改，见交接 |
| `useSlot` 等读取宿主槽位的 hook | 社区不再开放（读不到其他插件的贡献） | — |

官方插件（`origin: 'builtin'`）与开发模式下的本地插件（显式勾选“信任此插件”）继续在主世界运行，
API 不变。`kernel.install` 按 origin 和信任级别选择加载器。

## 6. 工作量估计

| 块 | 归属 | 人日 |
|---|---|---|
| 沙箱 SDK 运行时（`ctx.ui` 代理、RPC 客户端、hooks、构建产物） | W17 | 3 |
| SandboxBroker（端口绑定、方法表、载荷校验、权限检查、心跳、错误预算） | W17 | 3 |
| `RemoteSurface`（iframe 生命周期、尺寸、焦点与键盘、主题/语言注入、无障碍） | W17 | 4 |
| 声明式卡片 schema 与宿主渲染器（对话 block、工具结果、仪表盘小部件） | W17 + W18/W19 | 3 |
| 各槽位适配（菜单、命令、导航、视图、设置、工具结果）与 `when` 表达式 | W17 | 3 |
| `ds-plugin-sandbox:` 协议、CSP、子 frame 无 preload 的 E2E、主窗口 CSP 收紧 | W06 | 2 |
| `plugin:host\|call` 带调用方身份并校验（含同意记录） | W01 | 2 |
| 安全测试（拿不到 `__TAURI_INTERNALS__`、越权 `host.call` 被拒、超限与挂起处理）、示例迁移、文档 | W17 | 3 |
| **合计** | | **约 23 人日**（W17 约 19，W06 2，W01 2） |

前置条件：
- 决议 3（`package.json#deepStudent` 作为唯一 manifest）与同意流程先落地。
- W01 给 `hostCall` 加上调用方身份。

进度（第 8 轮）：
- 调用方身份（上表 W01 那一行的前半，主世界版本）：
  - UI 半：`ctx.ui.host` 每次调用带 `caller`，即调用方插件 id；配对半用自己的 id。根 context 或卸载后的调用不发出、直接拒绝。W17 `bdd76587`，随第五批进 INT。
  - Host 半：带 `caller` 时只放行该插件自己提供的服务（`meta.remote` 照旧）。W01 `facf1e63`，随第五批进 INT。缺 `caller` 的处理由 `host/kernel/runtime.ts:54` 的 `DEFAULT_HOST_CALL_CALLER_MODE` 决定，目前为 `warn`；移动端诊断页（W14，`mobile/src/main.ts:68`）也带上 `caller` 后改为 `require`。
  - IPC 契约还没有 `caller` 键，frontend-invoke 门禁因此报 1 条新增。契约改法（W09）见 `.reports/W17-handoffs/W09-host-call-caller-contract.patch`。
  - 这只防住主世界里“插件 A 的 UI 调插件 B 的服务”。社区 UI 仍和宿主同一 realm，可以伪造 `caller` 或直接调 IPC。真正的绑定要等 SandboxBroker 按端口加上 `caller`（§3）。
- 同意记录：未做。
- i18n 派生命名空间：严格模式（`STRICT_COMMUNITY_NAMESPACES`）随示例迁移进 INT 后打开。
- 模块 URL：同一插件再次导入时带 `?reload=<n>`（`loader.ts` 的 `pluginUrl`，V09 P3-4）。沙箱的 `frame.html` 沿用同一计数，插件更新后新开的 frame 不会拿到旧模块。
- `meta.requires` 的依赖被本构建或本平台跳过时，依赖方记为跳过（`reason: 'requires'`），不再报错。沙箱加载器沿用这条规则。
- 上表其余各块（沙箱 SDK 运行时、SandboxBroker、`RemoteSurface`、声明式卡片、槽位适配、协议与 CSP、安全测试）均未开始，估计不变。

## 7. 下一块怎么切（按 §8 的完备标准，未开工）

单独做 SandboxBroker 或沙箱 SDK 运行时都没有调用方，不满足“闭环”；要切就得一起切出一条能跑通的最小链路，放在开关后面：

- **范围**：只支持数据型贡献，不含组件。社区插件在插件 frame 里 `apply`，能用的是 `nav.register`（`viewId` 只能指向已登记的视图）、`commands.register`（`execute` 改成回调 id）、`i18n.addBundles`、`storage.*`、`host.call`、`reportError`。用到 `views`、`settings.sections`、`chat.*` 等组件型槽位的插件，在沙箱模式下安装失败，报“需要 RemoteSurface”，并计入错误预算。
- **开关**：`UiKernelOptions.sandboxCommunity`，默认 `false`。为 `false` 时行为与现在完全相同。打开后，`UiPluginLoader` 对 `origin: 'community'` 的条目改走沙箱加载器。
- **文件**（全在 `src/ui-kernel/` 下）：
  - `sandbox/frames.ts`：帧格式、大小上限、方法表的校验；
  - `sandbox/broker.ts`：端口与插件 id 绑定，按方法表分派到内核服务，`host.call` 的 `caller` 用绑定的 id；
  - `sandbox/runtime.ts`：沙箱里的 `ctx.ui` 代理和 RPC 客户端；
  - `loader.ts`：按开关选加载器。
- **调用方清单**：
  - `UiPluginLoader`（`community.ts` 的 `startCommunityUiPlugins`）是唯一入口，官方插件不经过它。
  - 外壳侧要有 `ds-plugin-sandbox:` 协议（W06）。没有这个协议之前，只能在 jsdom 里用 `srcdoc` + `MessageChannel` 测，不能在真实窗口里打开开关。
  - 所以这一块在 W06 交付协议之前**不开工**；协议落地后再算一轮。
- **测试计划**：
  - 帧校验的单测：超限、未知方法、伪造的 `caller` 被忽略；
  - 失败路径：frame 加载失败、心跳超时，都回到“插件未安装 + 计入错误预算”，宿主界面不受影响；
  - 端到端：word-of-day 示例的 Host 半跑在真实测试宿主上，UI 半去掉视图后在沙箱里登记导航和命令，经 broker 调 `exampleWordOfDay.today`。

验收：沿用 FE-E2 的“篡改文件被拒；沙箱插件调不到 `meta.remote` 以外的方法、拿不到 `__TAURI_INTERNALS__`”，另加：
- 未授权的 `service:` 调用被拒，并计入预算；
- 插件 frame 挂起后被卸载；
- 主窗口 CSP 不含 `ds-plugin:` 与 `blob:`。
