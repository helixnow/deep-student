# `@deepstudent/ui` — UI 插件 SDK（v2）

UI 插件只从 `@deepstudent/ui`（仓库内为 `src/ui-sdk`）以及 `react` / `react-dom` / `i18next` 导入；宿主经 import map
提供同一份单例。下面是稳定的公共 API，导出清单由 `__tests__/public-api.test.ts` 锁定。最小示例见
`__tests__/example.test.tsx`（约 40 行功能插件 + 框架插件 + 测试）。

## 1. 定义插件

```ts
export default definePlugin({
  meta: {
    id: 'acme.study-stats', version: '0.1.0',   // <publisher>.<name>；dstu、community、example 等 publisher 保留，不能用
    platforms: ['desktop', 'mobile'],   // 省略 = 不限平台；取值与 Host meta.platforms 相同
    host: true,                         // 与同 id 的 Host 半配对（或写 Host 插件 id）；省略 = 纯前端
    requiresHost: ['dstu.review'],      // 额外依赖的 Host 插件
    requires: ['dstu.frame.dashboard'], // 必须先安装的 UI 插件
    slots: ['acme.study-stats.cards'],  // 本插件 declareSlot 的槽位（可省；写了就要列全，见 §6）
    // i18n.namespace 省略 = 插件 id（社区插件只能用这个派生值；另起命名空间只限官方插件）
  },
  inject: [],                           // Cordis 服务依赖（可选）
  apply(ctx) { /* 见下文；全部贡献随卸载撤销 */ },
});
```

- `definePlugin` = `defineUiPlugin` + `meta.apiVersion` 缺省为 2。v1 的 `defineUiPlugin({ meta: { id } })` 继续有效。
- 安装：meta 不合法或缺 `requires` 依赖时拒绝；`platforms` 不含当前平台时跳过（`install` 返回 false）。
- 插件 apply 失败、卸载、被同 id 覆盖时，下面所有服务的状态都会撤销。

## 2. 槽位

| API | 说明 |
|---|---|
| `interface SlotMap` | 槽位名 → 值类型。拥有槽位的一方用声明合并登记：`declare module '@deepstudent/ui' { interface SlotMap { 'dashboard.widgets': Widget } }` |
| `ctx.ui.contribute(slot, { id, key?, order?, value })` | 已登记槽位在编译期检查 `value` 形状；未登记槽位接受任意值；`contribute<T>(…)` 显式泛型为逃生口 |
| `contribution(slot, c)` / `contributeAll(ctx, list)` | 静态贡献表：定义处做形状检查，`apply` 里一次登记 |
| `defineSlot(name, 'list' \| 'keyed' \| 'single', desc?)` + `ctx.ui.declareSlot` | 框架插件开放新槽位 |
| `<SlotOutlet name props? render? filter? fallback? empty? suspense? entries? onError?>` | 统一渲染：按 order 排序，order 相同按贡献 id 的码点顺序（与系统语言无关）；每条贡献独立错误边界，出错只替换自身并计入错误预算；社区贡献外包 `display: contents` 的 `[data-ds-plugin]` 作用域；无 Provider 时渲染 `entries` 静态表 |
| `useSlot(name)` / `useSlotEntry(name, key)` / `useOptionalSlot(name)` | 订阅槽位（已登记槽位自动推断值类型） |

官方槽位的值类型：`views` → `ShellViewContribution`（`ShellView` 或带 `load()` 的 `LazyShellView`；宿主用
`resolveShellViewComponent(value)` 取组件并放在 `<Suspense>` 里）、`nav` → `ShellNavItem`、`settings.sections` → `SettingsSection`、
`app.menu` → `AppMenuContribution`、`resource.contextMenu` → `ResourceMenuContribution`、
`resource.types` → `ResourceTypeDefinition`（key = 资源类型）、`editor.selectionToolbar` → `EditorSelectionToolbarContribution`、
`editor.blockMenu` → `EditorBlockMenuContribution`（都随 SDK 导出）。`app.menu` 各菜单的
上下文是 `AppMenuContext<M>`，Dock 项菜单和桌面右键菜单用到的 `AppMenuDock`、`AppMenuDesktop` 等也一并导出。
`workbench.*` 菜单的上下文带 `workbench`（菜单栏动作）；不以 `workbench.` 开头的菜单（在工作台以外渲染）只有自己的上下文和 `t`。
`resource.types` 与两个编辑器槽位由宿主（W37 / `dstu.ui.editor`）声明；声明之前往它们贡献会报 `slot "…" is not declared`。
`editor.extensions` 可写 `purposes: ['editor', 'diff']` 参与 AI 修改审阅的 diff 视图（省略 = 只参与普通编辑器）。
`markdown.codeBlocks` 的类型依赖官方内部的渲染器模块，仓库内可用，暂不随 SDK 导出；
`chat.toolResults` → `ChatToolResultContribution`（SDK 导出，见下）。v1 快捷方式（`ctx.ui.views.register`、`nav.register` 等）保留。
`ctx.ui.settings.register(section)` 收 `SettingsSectionRegistration`（`SettingsSection`，`order` 可省）：分区要带
`navigation`（`order`、`legacyGroup`、`icon`、`mobileDescriptionKey`、`mobileAccent`）才会出现在设置侧栏，没有它只在
切到该 tab 时渲染。

懒视图加载失败后，重试按钮应先调用 `invalidateShellViewComponent(value)`，再重新解析组件并重置错误边界。
失效同步且不会调用 `load()`；新组件首次渲染才重试加载。同一 `load` 的条目共享缓存和失效，其它视图不受影响。
不要在每次渲染或切换视图时失效，成功结果仍照常缓存。

### 对话扩展（`chat.toolResults` 与 `ctx.ui.chat.*`）

新工具的结果卡片只需一条贡献，key 是基础工具名（`builtin-` 前缀可省略），找不到时回落通用 JSON 视图：

```ts
ctx.ui.contribute('chat.toolResults', {
  id: 'essay-score', key: 'essay_grade',
  value: { placement: 'block', component: EssayScoreCard },
});
```

- `placement`：`block` 替换整个工具块；`output` 替换成功态的输出区；`actions` 追加在输出区下方。
- `when(props)` 返回 false 时本条不生效；`match: 'qualified'` 另外匹配 `builtin:`、`mcp_`、`mcp.tools.`、`<namespace>.` 前缀。
- 组件收到 `ChatToolResultProps`：`block`、`isStreaming`、`store`、`toolName`、`toolInput`、`toolOutput`。
- `ctx.ui.chat.registerToolResult(name, Component | contribution)` 是 v1 写法，裸组件按 `block` 处理。

对话 block、事件处理器、模式经适配器写入对话注册表（slot 支撑、可订阅，消息列表订阅变化，晚注册的 block 也能渲染）：
`ctx.ui.chat.registerBlock(type, { type, component, onAbort? })`、`registerEvent(type, handler)`、`registerMode(name, mode)`。
与已登记的类型冲突时报错；卸载即撤销。

## 3. 内核服务（`ctx.ui.*`，在 `apply` 中使用）

| 服务 | API | 卸载时 |
|---|---|---|
| 平台 | `ctx.ui.platform` → `{ kind: 'desktop' \| 'mobile', os, arch?, capabilities, has(cap), subscribe(fn) }` | 订阅撤销 |
| 导航 | `ctx.ui.navigate(viewId, params?)`；`ctx.ui.navigation.canNavigate(viewId)`、`.provide(navigator)`（框架插件） | 句柄失效；提供的导航实现撤销 |
| 存储 | `ctx.ui.storage.get/set/remove/keys/clear/subscribe/json(key, initial)`，键自动加 `ds:plugin:<id>:` 前缀 | 订阅撤销、句柄失效；数据保留 |
| 状态 | `createPluginStore(ctx, init, { persist? })` = `ctx.ui.createStore`（zustand store） | 重置为初始状态并断开订阅 |
| 文案 | `const t = ctx.ui.i18n.addBundles({ 'zh-CN': {...}, 'en-US': {...} })`；`ctx.ui.i18n.t`、`ctx.ui.i18n.useT()`、`ctx.ui.i18n.namespace` | 语言包移除、命名空间释放 |
| 错误 | `ctx.ui.reportError(error)`：计入本插件错误预算 | — |
| 身份 | `ctx.ui.plugin` → `{ id, origin, meta }` | — |
| Host | `ctx.ui.host.<服务>.<方法>(...args)`：每次调用带上本插件 id（配对半内是该半的 id）作为 `caller`，Host 只放行这个插件自己的 Host 半在 `meta.remote` 里开放的方法（SEC-E06）。只能在插件内调用 | 之后的调用直接拒绝（`UiPluginDisposedError`） |
| Host 事件 | `ctx.ui.host.on<T>(event, handler)`：订阅本插件命名空间（`<id 的 . 换成 />:<事件>`）下的 Host 推送，返回同步生效的 `UiDisposer`；`event` 写完整名或本地名。外来/近似前缀与非法字符在注册前抛错；handler 异常与传输失败进本插件错误预算 | 自动退订（含尚未 resolve 的注册） |
| Host 状态 | `ctx.ui.hostStatus` → `{ known, safeMode, state(id), reason(id), degraded(id), consentRequired(id), availability(ids), subscribe(fn) }`；清单到达前为 `unknown`（按在线处理）。`degraded(id)` 返回 `{ code?, detail, consentRequired }`（Host 错误码与 W32 的 `CONSENT_REQUIRED`） | 订阅撤销 |
| 配对半 | `await ctx.ui.pair(defineUiPlugin({ meta: { id, host: true }, apply }))`：贡献记在调用方名下，Host 半缺失时撤下、降级 ⇄ 可用时重新 apply | 随调用方撤销 |
| 语义锚点 | `ctx.ui.anchors` → `{ registerAnchorRevealHandler(kind, handler), reveal(target, options?), upsertAnchorEdges(edges), pruneAnchorEdgesBySource(params), queryAnchorEdgesByTarget(params), subscribeAnchorEdgesChanged(fn) }` | 揭示处理器与反向链接订阅自动撤销 |
| 摘录拖拽 | `ctx.ui.dnd` → `{ startExcerptDrag(event, input), hasExcerptMime(event), readExcerptDrag(event), registerExcerptDropTarget(el, onDrop, options?), emitAutoExcerpt(input), subscribeAutoExcerpt(fn) }` | 落点监听与自动摘录订阅自动撤销，DOM `data-ds-excerpt-drop` 重置为 `'idle'` |

### 跨插件互操作协议 v1（`ds-anchor://v1/...` 与 `DS_EXCERPT_MIME`）

SDK 直接导出纯函数与常量供插件与视图桥接使用：
- 锚点 URI：`DS_ANCHOR_SCHEME`、`DS_ANCHOR_VERSION`、`serializeSemanticAnchor`、`parseSemanticAnchor`、`isSemanticAnchorUri`、`formatAnchorShortLocator`、`fnv1a64Hex`。
- 摘录拖拽：`DS_EXCERPT_MIME`（`'application/x-deepstudent-excerpt'`，与工作台窗口资源拖拽 `WB_RESOURCE_MIME` 严格隔离）、`sanitizeExcerptDragPayload`、`startExcerptDrag`、`hasExcerptMime`、`readExcerptDrag`。
- `ctx.ui.anchors.reveal(target, { splitIfClosed, pulse })` 优先走 `<50ms` 内存快路径（`'exact-focused'` 优先于 `'exact-mounted'`），目标未打开且 `splitIfClosed !== false` 时经宿主分屏拉起并在新视图注册处理器后立即冲刷定位脉冲。

与 Host 的对账（FE-A3）：`meta.host` / `requiresHost` 声明的 Host 插件已知缺失时，`install` 返回 false 并暂不安装，
Host 插件回来后自动装回；降级 ⇄ 可用切换时按原参数重装（`apply` 内读 `ctx.ui.hostStatus` 换成降级界面）。

文案规则：`t` 只查本插件命名空间（以及本插件用 v1 `addBundle` 认领的命名空间），按语言链回落语言，
**不会**回落到官方或其他插件的命名空间；支持 `{{变量}}`、`count` 复数（`key_one` / `key_other`）、`defaultValue`、
`a.b` 嵌套键。v1 `ctx.ui.i18n.addBundle(lng, ns, res)` 保留，但社区插件只能写本插件 id 派生的命名空间（`ctx.ui.i18n.namespace`）：写别的命名空间直接报错，API v1 和 v2 插件都一样。这由内核的 `STRICT_COMMUNITY_NAMESPACES` 控制（`src/ui-kernel/kernel.ts`，现为 `true`）。迁移期它是 `false`，那时 API v1 插件还能写未被认领的非官方命名空间，并收到一次弃用告警。写官方或他人的命名空间一直都会被拒绝。

错误预算：社区插件累计 3 次渲染/过滤/自报错误即自动卸载（`kernel.errors.disabled()` 可见），重新安装清零；
官方插件只计数。

## 4. 组件内 hook

由 `<SlotOutlet>` 渲染的贡献自动知道自己属于哪个插件；交给其他官方消费方渲染的组件用
`withPluginScope(ctx, Component)` 包一层。

| Hook | 返回 |
|---|---|
| `useT()` | 绑定所属插件命名空间的 `t`，语言变化时重渲染 |
| `usePluginStorage(key, initial)` | `[value, setValue]`，与 `ctx.ui.storage` 同步 |
| `usePluginStore(store, selector?)` | 订阅插件 store |
| `usePlatform()` | 当前平台信息 |
| `useNavigate()` | 以所属插件为来源的导航函数 |
| `usePluginScope()` | `{ id, origin }` 或 null |

## 5. 设计系统

`DsButton`、`DsDialog`、`SegmentedControl`；样式只用 `--ds-*` 变量。

## 6. 撤销句柄、懒加载贡献点、构建与平台

- 所有登记都返回 `UiDisposer`（`() => void`），只撤销这一条，可重复调用：`contribute`、`views/nav/settings.register`、
  `markdown.registerCodeBlock`、`chat.registerToolResult/registerBlock/registerEvent/registerMode`、
  `commands.register(UiCommand)`、`workbench.registerApp(UiWorkbenchApp)`、`contextMenu.register`、`attach`。
  插件卸载时未撤销的登记照旧全部撤销。命令 id、应用 `typeId`、已占用的 block 类型冲突时抛错。
- `UiCommand`、`UiWorkbenchApp`、`UiChatBlock`、`UiChatEventHandler`、`UiChatMode` 是收窄后的参数类型（SDK 类型导出）。
- `meta.devOnly: true`：只在开发构建安装；生产构建中 `install` 返回 false，`kernel.skipped()` 记为 `reason: 'build'`。
  `meta.requires` 里没装上的依赖如果全都是被跳过的插件（平台不符、`devOnly`，或同样因此被跳过），依赖它们的插件也跳过，
  记为 `reason: 'requires'`，不报依赖缺失。例如往 `debug.panels` 贡献的插件写 `requires: ['dstu.ui.debug']`，生产构建里就安静地跳过。
  官方插件必须写字面量，构建期据此连模块都不收录（写法见 §8）。
- `meta.slots`：插件 `declareSlot` 的槽位名。写了就必须列全，`declareSlot` 一个没列出的槽位会抛 `SlotError`。
  插件被跳过时（平台不符、`devOnly`、依赖被跳过），往这些槽位的贡献不再抛 `slot "…" is not declared`：
  `contribute` 返回空句柄、不登记；开发构建对每个“贡献者 + 槽位”打一条 `console.warn`，生产构建不出声。
  没有任何被跳过插件列出的未声明槽位照旧报错（防拼错）。被丢弃的贡献不会在槽位所有者之后装上时补登。
  生产构建里被排除的官方插件只留元数据桩（`excludedOfficialUiPlugins`），官方安装入口先装桩，内核照样记下跳过原因和槽位。
- 懒加载 chunk 的贡献：chunk 侧用 `createLazyContributionPoint<T>(name, fallback?)`（`@/ui-sdk/lazy`，不在稳定索引里）
  建点并 `announce(value)`；所属插件在 `apply` 里 `ctx.ui.attach(point, (value) => ctx.ui.contribute(...))`。
  已宣告的值立即交付，之后的同步交付；单个值失败只拒绝该值并计入错误预算（`slot: 'lazy:<name>'`）。
  没有插件接上时由 `fallback` 维持旧行为，接上时撤下 `fallback` 的登记。
  官方代码要按同样规则排序时用 `compareCodePoints`（`@/ui-sdk/order`，同样不在稳定索引里）。
- `ctx.ui.platform` 增加 `arch?`。初值取壳层的 `globalThis.__DS_PLATFORM__ = { kind, os, arch? }`（`os` 规范化为
  `macos/windows/linux/android/ios/unknown`），没有壳层（浏览器、测试）时为桌面。
- 订阅按槽位：`useSlotEntry`、`useOptionalSlot` 只在本槽位变化时通知；`kernel.slots.subscribe(name, fn)` 同理。

- 核心插件：官方插件在 meta 里写 `core: true`（只限以 `origin: 'builtin'` 安装的官方插件，与 `devOnly` 互斥）。
  生产构建中 `kernel.unload(id)` 抛出 `UiCorePluginError`，同 id 的社区插件安装也被拒绝；官方重装、Host 对账、
  `kernel.dispose()` 不受影响。`kernel.isProtectedCore(id)` 供插件管理页隐藏停用开关。开发构建与测试照常可卸载。
- 工作台应用的 `hostPlugin: '<Host 插件 id>'`（`AppDefinition`，经 `contributeWorkbenchApp` 登记）：由 `dstu.ui.workbench`
  按 `ctx.ui.hostStatus` 处理——缺失时撤下应用，回来后重新登记；降级时已打开和新打开的窗口都显示
  `HostUnavailablePanel`（标题为应用名），恢复后即时换回。清单未到或没有 UI 内核时按在线处理。
  标准降级面板可从 `@/ui-sdk/host-unavailable` 取（`React.lazy`，放在 `<Suspense>` 里）。
- `resource.contextMenu` 的界面（scope）：学习资源库 `empty | folder | resource | trash-empty | trash-item`
  （`ContentMenuContext`），笔记树 `notes-tree`（`NotesTreeMenuContext`：`item`、`beginRename`、`createFolderId`、
  `canDelete`、`actions`）。不带 `scopes` 的行沿用学习资源库语义，`visible` 需自查 `context.scope`；
  `ScopedResourceMenuContribution<'notes-tree'>` 写 `scopes: ['notes-tree']`，内核保证它只在这些界面出现，
  回调拿到的 context 类型随 scope 收窄。v1 `ctx.ui.contextMenu.register` 的条目在笔记树里按 `item.kind` 匹配 `resourceTypes`。

## 7. 兼容性

v1 的全部导出与 `ctx.ui` 接口保持不变（`defineUiPlugin`、`BUILTIN_SLOTS`、`useSlot*`、领域快捷方式、`ctx.ui.host`）。
行为变化有两处是把旧注册表对齐内核的“冲突即报错”：经内核登记的命令与已有命令 id 冲突时报错（原先警告后覆盖）；
社区插件的 v1 `addBundle` 不能再写入官方或他人的命名空间（原先可写，且卸载时会删掉整个命名空间）。
另一处是 `ctx.ui.host` 的调用方绑定（SEC-E06）：调用带上 `caller`，只能调用本插件自己的 Host 半；
从根 context（`kernel.ui().host`）或已卸载插件发起的调用直接拒绝，不再发到 Host。
v1 `ctx.ui.contextMenu.register({ id, resourceTypes, labelKey, order?, run })` 现在适配为资源菜单读取的形状：
`resourceTypes` 取资源类型、`'folder'` 或 `'*'`，`labelKey` 不含 `:` 时按插件命名空间解析，`run(resource)` 在关闭菜单后执行，
失败计入插件错误预算（原先条目缺 `visible`，会在社区错误边界内报错）。

## 8. 官方插件约定（`src/ui-plugins/official/<目录>/index.ts`）

构建期官方插件表（`src/platform/official-plugins.ts`）不执行插件代码，而是从源码里读 `meta.id`、`meta.platforms`、
`meta.devOnly`、`meta.slots`，决定哪些目录进包、被排除的插件留下什么桩。所以官方插件只有一种写法：

```ts
export default defineUiPlugin({
  meta: { id: 'dstu.ui.debug', devOnly: true },   // 字面量，就地写出每个字段
  apply(ctx) { … },
});
// 需要安装顺序时包一层，只加 order：
export default Object.assign(defineUiPlugin({ meta: { id: 'dstu.ui.x' }, apply }), { order: 190 });
export default { ...defineUiPlugin({ meta: { id: 'dstu.ui.x' }, apply }), order };
```

- 默认导出里只能有一个 `defineUiPlugin(…)`。配对半写成单独的常量，或在 `apply` 里 `ctx.ui.pair(…)`，不算在内。
- `meta` 必须是写在调用里的对象字面量，每个字段都是 `名字: 值`。变量、import、函数返回值、`{ meta }` 简写、
  `...展开`、字段简写都读不出来。`id` 是字符串字面量，`platforms`、`slots` 是字符串字面量数组，`devOnly` 是 `true`/`false`。
- `devOnly`、`platforms`、`core` 等 `UiPluginMeta` 字段只能写在 `meta` 里。内核和插件表都只读 `plugin.meta`，写在外面的
  会被静默忽略。例如顶层的 `devOnly: true` 会让插件照常进生产包、照常安装。
- 不支持直接导出插件对象（`const p: UiPlugin = { name, meta, … }`）。理由：
  - 对象字面量绕过了 `defineUiPlugin` 参数的多余属性检查。W19 的 debug 插件写成 `UiPlugin & { devOnly: true }`，
    顶层 `devOnly` 因此能通过编译，又被内核忽略。写在 `defineUiPlugin({ … })` 里，tsc 直接报
    `'devOnly' does not exist`（`typetests/sdk.typetest.ts` 的 `meta-field-outside-meta`）。
  - 社区插件也是 `defineUiPlugin`（加载器只认它），官方和社区共用一种写法，文档和检查都只需一套。
  - INT `6c491e6f` 起，全部官方插件都已是这种写法，没有迁移成本。
- 违反约定时，`official-plugins.test.ts`（导入时读取全部官方插件）和每次生产 / 移动端 / 演示壳构建都会失败。
  报错格式为 `文件:行:列: 问题`，下一行 `fix:` 给出改法。dev server 不读这张表，所以开发时要靠这个单测和 tsc 发现。
- 改了插件的槽位声明，要同时更新 `src/ui-plugins/testing/__golden__/official-slots.json`（删掉旧文件后用
  `W17_CAPTURE_OFFICIAL_SLOTS=1` 跑 `official-slots.golden.test.tsx` 重新采集）。
