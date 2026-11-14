# 前端插件化方案

状态：**已定稿**（2026-11-03，协调者决策）。本文与 [ARCHITECTURE.md](ARCHITECTURE.md)（后端插件）合起来，构成完整的插件模型：
**一个功能 = 一个插件包 = Host 一半 + UI 一半（可选）**。社区开发者可以同时扩展后端能力和界面，一个开关同时启用或停用两半。

落地后的写法（v1 清单、由 id 派生的名字、`ctx.ui.host`）以 [SDK.md](SDK.md)、`examples/README.md`、`src/ui-sdk/README.md`
为准；下文的接口名已按实现更新。社区插件与官方插件并存，不能顶替官方插件（SDK.md §3.3）。

参考：DeepSeek Harness 的客户端插件（浏览器内运行 Cordis 树、类型化 slot、host 决定加载哪些客户端模块、
插件包同时带两半）。我们取其模型，不取其重型基础设施（自研 CJS 加载器、pnpm 安装、对现有组件"零上下文"的
重写要求），以适配一个已经很大的 React 应用。

## 1. 决策摘要

| 问题 | 决定 | 理由 |
|---|---|---|
| UI 插件运行在哪 | 渲染进程中的 **Cordis 根**（`src/ui-kernel/`），与 Host 同一框架、同一套 `apply(ctx)` / `inject` / 副作用生命周期 | 开发者只学一套模型；贡献物随插件卸载自动撤销 |
| 插件包形态 | 一个目录或 npm 包：`index.ts`（Host 半）+ `ui.tsx`（UI 半，可选，构建成 `dist/ui.js`），在清单 `deepStudent.ui` 与 Host 插件的 `meta.ui` 中声明 | 启用、停用都只有一个开关（profile 条目） |
| 谁决定加载哪些 UI 模块 | **Host**：根据已装载的 profile 生成 UI 引导清单，渲染进程按清单加载 | 前后两半永远一致；被禁用的插件不会只剩半个 |
| 怎么加载第三方代码 | 原生 ESM，经 Electron 自定义协议 `ds-plugin://<插件 id>/…` 提供；共享依赖经 **import map** 指向宿主单例 | 不需要自研模块系统，也不需要用户机器上有构建工具链 |
| 共享依赖 | 固定白名单：`react`、`react-dom`、`@deepstudent/ui`（UI SDK：设计系统组件、hooks、类型）、`i18next` | 第三方插件不自带 React，体积小、行为一致 |
| 扩展点形态 | **类型化 slot**（单个 / 列表 / 按 key 三种基数），外加若干领域注册表（对话 block、命令、设置分区…），全部通过 `ctx.ui.*` 服务暴露 | 新扩展点只需声明 slot，不再往中心列表里加 if 分支 |
| 现有代码 | **不重写**。把中心化列表（视图、侧栏、设置页签、命令、block…）改为读取注册表，官方功能自己先作为 UI 插件注册 | 前端完整保留，渐进改造，每一步都可单独验证 |
| UI 怎么调用后端 | `ctx.ui.host.<服务名>.<方法>()`：调用 Host 插件 `meta.remote` 中列出的服务方法 | 第三方 UI 不需要（也不允许）新增 Tauri 命令 |
| 信任与隔离 | 已安装插件与应用同进程运行（同 DSH），安装时提示信任（未实现：现在没有安装流程和同意记录，见 SECURITY.md 第 6 节）；**不受信任的展示类贡献**（例如 HTML 卡片）走现有的沙箱 iframe（`HtmlSandboxPreview` 策略） | 教育类应用需要可控；完全沙箱化所有 UI 代价过高 |
| 样式 | 只用 `@deepstudent/ui` 组件与应用主题的 CSS 变量（`src/styles/shadcn-variables.css`，如 `hsl(var(--foreground))`）；Tailwind 工具类只有应用自己用到的才有样式（`tailwind.config.js` 只扫描 `src/`）；禁止覆盖全局选择器 | 与现有主题系统一致，深浅色自动适配 |
| 文案 | 插件自带语言包，经 `ctx.ui.i18n.addBundles({ 'zh-CN': …, 'en-US': … })` 注册到由插件 id 派生的命名空间（i18next `addResourceBundle`） | 不需要修改全局 `ALL_NS` |

## 2. 包结构

```
my-plugin/
  package.json   "engines": { "deepStudent": "^0.11" },
                 "deepStudent": { "manifestVersion": 1, "id": "alice.my-plugin", "platforms": ["desktop"], "host": "./index.ts", "ui": "./dist/ui.js" }
  index.ts       Host 半：definePlugin({ meta: { id, version, provides, ui: './dist/ui.js', remote }, apply })（host/kernel/api.ts）
  ui.tsx         UI 半：definePlugin({ meta: { id, version, host: true }, apply(ctx) { ctx.ui.views.register(…) } })（@deepstudent/ui）
  dist/ui.js     npm run build:ui（应用仓库的 examples/scripts/build-ui.mjs）的产物：四个共享模块 external，文案写在 ui.tsx 里
```

完整的可运行例子与脚手架见 `examples/README.md`。官方插件同样分两半：Host 半在 `host/plugins/<x>/index.ts`；UI 半在
`src/ui-plugins/official/<x>/`，由 Vite 打包进主应用（不经协议加载），注册方式与第三方插件相同。

## 3. 引导流程

1. Host 装载 profile 后，kernel 收集每个已装载插件的 `meta.ui`，生成 **UI 引导清单**（v1 为 `[{ id, file, version }]`；
   `{ version: 2 }` 请求返回带 `origin`、`platforms` 的 `{ plugins }`），在握手完成后通过 `host://ui-manifest` 事件和
   `plugin:ui|manifest` 命令提供给渲染进程（`host/kernel/core.ts` `UI_MANIFEST_EVENT`、`UI_MANIFEST_COMMAND`）。
2. 渲染进程的 `ui-kernel` 先启动内置的官方 UI 插件，再按清单 `import()` 第三方 UI 模块（`ds-plugin://<id>/<文件名>`，
   `src/ui-kernel/loader.ts`；main 进程从插件目录读取文件，`electron/shell/plugin-ui-protocol.ts`）。
3. 第三方模块的 `import 'react'` 由 import map 解析到 blob URL 托管的 shim，shim 再从 `window.__DS_SHARED__` 导出宿主单例的
   全部具名导出（`src/ui-kernel/shared.ts`）。
4. 插件被停用或卸载时，Host 推送新清单，`ui-kernel` 卸载对应 UI 插件的 fiber：它的全部贡献（视图、菜单项、
   设置分区、block 渲染器……）自动撤销。

## 4. UI 扩展点（`ctx.ui.*`）

第一批（F0 基础 + F1 改造）选的是社区最需要、同时改造成本最低的：

| 服务 | 贡献 | 对应的现有代码（改造时改为读注册表） |
|---|---|---|
| `ctx.ui.views` | 顶层视图：`{ id, titleKey, icon, component, keepAlive? }` | `CurrentView` 联合类型、App.tsx 的视图分支 |
| `ctx.ui.nav` | 侧栏导航项：`{ id, viewId, order, icon, labelKey, badge? }` | `ModernSidebar.createNavItems` |
| `settings.sections` 槽位 | 设置分区：`ctx.ui.contribute('settings.sections', …)`，值为 `SettingsSection`（`src/ui-kernel/contracts/settings.ts`），带 `navigation` 才进设置侧栏；v1 快捷方式 `ctx.ui.settings.register` 收同样的值（`SettingsSectionRegistration`，`order` 可省） | `Settings.tsx` 的 `activeTab` 分支、`useSettingsNavigation` |
| `ctx.ui.commands` | 命令面板命令与快捷键 | 已有 `commandRegistry`（直接包装） |
| `ctx.ui.chat.registerBlock` | 对话 block 渲染器（按 block type） | 已有 `blockRegistry`（直接包装） |
| `chat.toolResults` 槽位 | AI 工具结果卡片（按工具名的 keyed slot；`ctx.ui.chat.registerToolResult` 为 v1 写法） | 工具渲染分发 |
| `ctx.ui.markdown` | Markdown 代码块语言渲染器（如 `mermaid`、`smiles`）、remark/rehype 插件 | `MarkdownRenderer` 内联数组 |
| `ctx.ui.workbench` | 工作台应用 | 已有 `appRegistry`（直接包装） |
| `resource.contextMenu` 槽位 | 资源右键菜单行（`scopes` 选界面；v1 快捷方式 `ctx.ui.contextMenu.register` 按资源类型） | 已改造：学习资源库 `LearningHubContextMenu`、笔记树 `NotesWorkspaceApp` 读槽位 |
| `ctx.ui.i18n` | 语言包 | `i18n.ts` |

第二批（后续）：全局搜索 provider、资源编辑器、生成式 UI 组件、产物面板种类、调试面板。

上表是改造范围，不等于社区插件现在都能用：有示例的贡献和其余接口的状态见 `SDK.md` 第 4 节。

**组件约定**：贡献的组件只接收派生 props（数据与回调），不直接拿 `ctx`；需要服务时在 `apply` 中取好，
通过 props 或插件自己的 store 传入。这样组件可以单独测试，插件卸载时也不会留下悬空引用。对现有官方组件
不做此项强制，新写的插件 UI 遵守即可。

## 5. UI 调用后端

Host 插件把可供 UI 调用的服务方法列在 `meta.remote` 里（摘自 `examples/plugins/community-word-of-day`）：

```ts
// examples/plugins/community-word-of-day/index.ts
export default definePlugin({
  meta: {
    id: 'example.word-of-day',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['exampleWordOfDay'],
    ui: './dist/ui.js',
    remote: { exampleWordOfDay: ['today', 'history'] },
  },
```

UI 端调用 `await ctx.ui.host.exampleWordOfDay.today(date)`。kernel 通过统一的 `plugin:host|call` 通道转发，只放行 `meta.remote`
中列出的方法，参数和返回值必须是可序列化的 JSON；方法抛 `CommandError(value)` 时 UI 收到 `value`（SDK.md §2）。官方前端现有的
`invoke` 调用保持不变（它们受 IPC 契约约束）；新功能优先使用这个通道。

## 6. 分阶段计划

| 阶段 | 内容 | 负责 | 时机 |
|---|---|---|---|
| **F0 基础** | `src/ui-kernel/`：渲染进程 Cordis 根、`defineUiPlugin`、slot 原语（单个 / 列表 / keyed，贡献随 fiber 撤销）、`ctx.ui.commands` / `chat.blocks` / `workbench` 三个包装现有注册表的服务、`@deepstudent/ui` SDK 入口、`ds-shared` shim 生成；配套测试 | 协调者（Claude）亲自 | 现在（后端迁移期间并行） |
| F0b 加载通道 | kernel：`meta.ui` / `meta.remote`、UI 引导清单、`plugin:host\|call`；外壳：`ds-plugin://` 与 `ds-shared://` 协议、import map、CSP | F1、F2 lane（按本文规格） | 后端 A 级接近完成时 |
| F1 改造 | 视图、侧栏、设置分区、Markdown、右键菜单改为读注册表；官方功能逐个注册为 UI 插件；每步做前端回归 | lane（规格明确的机械改造） | 后端集成完成后 |
| F2 生态 | 社区插件示例（Host+UI 两半）、插件管理页（启用/停用/信任提示）、SDK 文档补 UI 章节 | 协调者设计，lane 实现 | F1 之后 |

## 7. 不做的事

- 不引入 Module Federation，也不写自研模块加载器：Electron 自定义协议加上原生 ESM 和 import map 足够。
- 不为现有官方组件强推"零上下文"重写；这条约定只用于新插件。
- 不在用户机器上调用 npm/pnpm：插件以预构建的包分发（UI 半是构建好的 `dist/ui.js`）。现在还没有安装流程，用户在
  `<数据目录>/plugins/user.profile.json` 里加一条指向包的条目（`examples/README.md`「装载」）。
