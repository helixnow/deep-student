# 前端插件化 F1：官方 UI 改造为 UI 插件（规格）

前置：`docs/plugins/FRONTEND.md`（总体设计与 F0 地基：`src/ui-kernel/` 的 UiKernel、slot、`defineUiPlugin`、`src/ui-sdk/`）。本文是 F1 阶段的执行规格，由架构师制定；lane 按此实施，C1 协调者负责日常调度，规格疑问上报架构师。

> 历史规格，保留原文。插件生态 v1（`decisions/2026-11-07-plugin-ecosystem-v1.md`）之后，社区插件不能再用官方插件的 id
> （`dstu.*` 保留，社区 UI 半的 id 必须等于它的 Host 条目 id），下文“社区插件以相同 id 覆盖官方插件”的说法不再成立；
> 仍然成立的是 `origin` 判定与社区贡献的错误隔离。社区插件的写法见 `docs/plugins/SDK.md`。

## 0. 唯一目标与红线

**把现有前端中硬编码的扩展点改为"读注册表（slot）"，并把全部官方 UI 以官方 UI 插件的形式注册进去——用户可见的行为、外观、顺序、文案、交互、性能特征完全不变。** 这是等价重构，不是功能开发。

红线（任何一条都使改造不成立）：
- 不改任何可见内容：文案、图标、顺序、布局、样式、动画、快捷键、移动端布局、深浅色。
- 不增删功能，不"顺手改进"，不调整加载时机（懒加载仍懒加载，首屏不新增同步依赖）。
- 不碰后端（`host/`、`electron/`）、契约、IPC 调用；不碰 `src/plugin-runtime/` 与 `src/plugins/translation/`（另一条工作线）。
- 演示壳（`demo.html` / `demo-app.html`，`src/demo/`）必须继续工作：`npm run build:demo` 通过。

## 1. 等价性证明（每条 lane 必须先做）

1. **先取证、后改造**：动手前，写一个测试把**改造前**代码里该扩展点的完整清单提取出来（id、顺序、labelKey/文案键、icon 标识、可见性条件对应的输入→输出表、平台/断点差异），存为 `src/ui-plugins/official/<area>/__golden__/<name>.json`（U1 没有领域目录，存到 `src/ui-plugins/testing/__golden__/boot/`），并提交（这一提交只含取证，不含改造）。
2. **改造后对照**：同一测试改为从 UiKernel 的 slot 读出清单，与 golden 逐字段相等。可见性条件用"条件输入组合表"验证（例如每个视图在 desktop/mobile、workbench 开/关、demo 壳内外的可见性）。
3. **全量回归**：`npm run version:generate && npx tsc --noEmit -p tsconfig.json`、`npx vitest run --config vitest.config.ts <受影响目录>`、`npx vite build`、`npm run build:demo` 全部通过（报告里贴退出码与 Errors 行）。
4. 不得修改 golden 来让测试通过；golden 有误要说明证据并单独提交。

## 2. 结构

```
src/ui-kernel/contracts/<area>.ts      # 各领域 slot 值的类型契约（由对应 lane 拥有）
src/ui-plugins/official/<area>/index.ts # 默认导出 defineUiPlugin({ meta: { id: 'dstu.ui.<area>' }, order, apply })
src/ui-plugins/official/<area>/__golden__/   # 改造前取证
src/ui-plugins/official/install.ts      # U1：import.meta.glob('./*/index.ts', { eager: true }) 收集，按 order 安装
```

- 官方插件 id 统一 `dstu.ui.<area>`；社区插件可用相同 id 覆盖（内核已支持同 id 替换），或向同一 slot 追加条目。（v1 起社区插件只能追加条目，见文首说明。）
- slot 名沿用 F0 的 `BUILTIN_SLOTS`：`views`、`nav`、`settings.sections`、`markdown.codeBlocks`、`chat.toolResults`、`resource.contextMenu`；命令、聊天块、工作台应用继续经 F0 已有的适配器（commandRegistry / blockRegistry / appRegistry）注册。
- slot 值里放**组件引用或懒加载工厂**（`() => import(...)`），保持原有的 lazy 边界；不得为了注册而把页面组件静态导入首屏。
- 消费方用 `useSlot` / `useSlotEntry`（`src/ui-kernel/react.tsx`）；快照引用稳定，未变化时不触发重渲染。

## 3. lane 划分（文件互不重叠）

| lane | 范围 | 只写这些路径 |
|---|---|---|
| U1-ui-boot | 应用启动接入：创建 UiKernel（`createAppUiKernel`）、`UiKernelProvider` 包裹根组件、安装官方插件（`install.ts`）、社区 UI 插件加载器（`UiPluginLoader` 订阅 `plugin:ui|manifest` 与 `host://ui-manifest`，无社区插件时零开销）、共享依赖 import map（`installSharedModules`，在第一个社区插件 import 前）；演示壳同样接入（以 `window.__DS_DEMO_SHELL__` 为准，不加载社区插件） | `src/main.tsx`、`src/demo/main.tsx`、`src/demo/app/main.tsx`、`src/ui-kernel/`（`contracts/` 下其他领域文件除外）、`src/ui-sdk/`、`src/ui-plugins/official/install.ts`、`src/ui-plugins/testing/` |
| U2-ui-shell | 视图与导航：桌面侧栏（`ModernSidebar`）、移动端导航（`MobileSidebarNavigation`）、`App.tsx` 中按 `currentView` 分支的渲染与外壳元数据（壳层侧栏类型、工具栏槽位、返回按钮、全宽/内边距等）改为读 `views`/`nav` slot 的条目元数据；官方视图注册为 `dstu.ui.shell` | `src/App.tsx`、`src/components/ModernSidebar.tsx`、`src/components/layout/MobileSidebarNavigation.tsx`、`src/app/hooks/useDesktopSidebarElements.tsx`、`src/ui-kernel/contracts/shell.ts`、`src/ui-plugins/official/shell/` |
| U3-ui-settings | 设置页的分区/页签改为读 `settings.sections`；官方分区注册为 `dstu.ui.settings` | `src/features/settings/components/Settings.tsx`、`src/ui-kernel/contracts/settings.ts`、`src/ui-plugins/official/settings/` |
| U4-ui-content | Markdown 代码块按语言的渲染器（`MarkdownRenderer.tsx` 中的 code 组件分派，含 mermaid/思维导图等）改为读 `markdown.codeBlocks`；学习资源右键菜单（`LearningHubContextMenu.tsx`）改为读 `resource.contextMenu`；官方条目注册为 `dstu.ui.content` | `src/features/chat/components/renderers/MarkdownRenderer.tsx`、`src/features/learning-hub/components/LearningHubContextMenu.tsx`、`src/ui-kernel/contracts/content.ts`、`src/ui-plugins/official/content/` |
| R6-review-frontend | 独立复核 U1–U4 的等价性 | `src/ui-plugins/ACCEPTANCE.md`、`docs/dev/electron-migration/audits/R6-review-frontend.md` |

依赖：U2–U4 不依赖 U1 的进度——各自先完成取证与 slot 读取；UiKernel 未接入启动前，测试里用 `new UiKernel()` + 安装自己的官方插件验证。U1 的 `install.ts` 以 glob 自动收集各领域插件，不需要别的 lane 改它。

## 4. 设计要点

- **元数据驱动，消灭散落的 `currentView === 'x'` 条件**（U2）：把 `App.tsx` 中按视图分支的外壳差异收敛为视图条目的声明式字段（例如 `shell: { sidebarKind, toolbarSlot, backButton, fullBleed }`），渲染层只读字段。字段集合以"恰好覆盖现有分支"为准，不预留没用到的字段。
- **可见性条件**：原有条件（平台、断点、实验开关、demo 壳）原样迁为条目上的 `visible(ctx)` 或等价数据；`ctx` 只提供原条件用到的输入。
- **顺序**：用显式 `order` 数值复现现有顺序，相邻值留间隔（10、20、30…）便于社区插入。
- **i18n**：沿用现有文案键与命名空间，不新增文案。
- **错误隔离**：社区插件贡献的组件渲染出错不得拖垮宿主页面（ErrorBoundary 包裹社区贡献；官方贡献保持现状）。
- 不做的事：插件管理 UI、权限/信任提示、热更新——属于 F2。

## 5. 完成协议

报告：取证提交与改造提交的哈希；golden 对照测试结果；第 1 节第 3 条全部命令的原始退出码与摘要；改造涉及的文件与原条件 → 新元数据的对照表；任何无法等价迁移的点（列出并停在原实现，不要硬改）。

## 6. 架构裁定（2026-11-04，回应 C1 上报）

### 6.1 轻量窗口（QuickAssistant 等）不进入 F1 装配
- 轻量窗口保持原实现与原时序：不包 `UiKernelProvider`，不等待 `createAppUiKernel`，不安装社区插件。F1 范围只覆盖主窗口与演示壳。
- 被轻量窗口复用的消费方（如 U4 的 Markdown 代码块分派）**必须在没有 Provider 时同步回退到官方条目**：官方 `content` 插件同时导出一张静态的官方条目表（与注册进 slot 的是同一份数据），消费方 `useSlot` 拿不到内核时直接用这张表。这样轻量窗口行为与改造前逐字一致，也不新增同步首屏依赖。
- 主窗口的内核创建与官方插件安装应在首次渲染前同步完成（官方插件只注册懒加载工厂，成本可忽略）；若需要异步，首帧必须先用上述静态官方表渲染，安装完成后再切换，且切换不得造成可见变化。

### 6.2 内置来源标记（解决同 ID 覆盖绕过隔离）
- UiKernel 记录每次安装的**来源**：`install(plugin, { origin: 'builtin' | 'community' })`。官方安装器（`install.ts`）传 `builtin`，社区加载器（`UiPluginLoader`）传 `community`；未指定时默认 `community`（安全侧）。
- slot 条目携带 `origin`。消费方判断"是否官方贡献"一律用 `entry.origin === 'builtin'`，**不得**用 owner id 字符串比较。同 ID 的社区覆盖其 origin 为 `community`，照常走错误隔离。
- 由 U1 在 `src/ui-kernel/` 实现并导出；U2/U4 改用 origin。测试必须覆盖"社区以官方同 ID 覆盖、且其贡献的组件抛错"——断言错误被隔离、其他导航项仍在。
- 社区贡献的默认值（R6-09）：未声明 `placement` 的导航条目归入主导航、按 `order` 排在官方条目之后；社区视图 id 不得与官方视图 id 相同（keyed slot 冲突即报错），同 ID 插件覆盖是唯一的替换官方方式（v1 起社区插件不能替换官方插件，见文首说明）。F1 不新增信任/权限 UI（属 F2）。

### 6.3 测试文件归属
被改造文件的**现有**测试文件，归改造该文件的 lane 维护。C1 把需要授权的测试文件精确路径列给架构师，架构师加入对应 lane 的允许路径（不放宽到整个目录）。共享测试 helper 留在 U1 的 `src/ui-plugins/testing/`，其他 lane 只导入、不修改。

### 6.4 检查点事故的补救口径
U1 的检查点 `e354acaa6` 把 golden 修订与生产 WIP 混在一个提交里，不重写历史。补救：U1 在 `audits/U1-ui-boot.md` 为这 5 处 golden 修订逐条给出"改造前源码"证据（文件:行与旧提交号），R6 逐条核实。核实通过即视为满足 §1.4；任何一处给不出旧源码证据，则恢复该 golden 原值并修正实现。今后修订 golden 前，先手动提交 golden（检查点只会兜底提交，不能依赖它分隔提交）。

### 6.5 授权补充（回应 C1 精确清单）
- U2 增加 4 个既有测试：`src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx`、`tests/vitest/modernSidebarNavigation.test.tsx`、`src/app/shell/__tests__/desktopSidebarShell.source.test.ts`、`src/app/shell/__tests__/shellExitReachability.source.test.ts`——接 U1 共享渲染 helper，保持原断言目的，不删除、不弱化。
- U3 增加生产消费点 `src/features/settings/components/SettingsShellSidebar.tsx`（桌面壳设置侧栏同样读 settings.sections）。
- U4 增加 `src/features/chat/components/renderers/CodeBlock.tsx`（mermaid/思维导图等按语言分派在此，属 §3 的 markdown.codeBlocks 范围，同样须有 §6.1 的静态官方表回退）与 10 个既有渲染测试（`src/features/chat/components/__tests__/messageSearchContext.test.tsx` 及 `src/features/chat/components/renderers/__tests__/` 下的 FlowToken.lazyCode、MarkdownRenderer.{bold,codeblock,flowtoken,identity}、StreamingBlockRenderer.visibility、blockRenderSkip、streamingCompletion、streamingDefaults）；优先让原测试在无 Provider 时经静态官方表照常成立，只在必要时调整装配，不改全局 vitest setup、不 mock 全局内核。
