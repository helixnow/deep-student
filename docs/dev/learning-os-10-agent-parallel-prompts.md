# 学习 OS（Workbench）11 子代理并行任务书

- 日期：2026-07-08
- 关联设计：`docs/dev/learning-os-workbench-design.md`（必读）
- 交付标准：非 MVP。视觉 / 交互 / 功能全量高可用（SOTA），实验开关打开后可作为日常主力桌面。
- 并行模型：P1–P10 **完全并行、不分先后**；P11（接线）在 P1–P10 全部完成后启动。

---

## 0. 通用规则（每个子代理必读必守）

### 0.1 冻结契约（P0）

以下文件为**冻结契约**，已实现并通过 typecheck，所有代理只读，禁止修改已有导出签名
（允许 P1 在保持接口不变的前提下重写 windowStore/scheduler 内部实现）：

- `src/features/workbench/core/types.ts` — 全部公共类型
- `src/features/workbench/core/appRegistry.ts` — 应用注册表
- `src/features/workbench/core/workbenchBus.ts` — launch/activate/project 三分语义（P1 可完善内部）
- `src/features/workbench/core/windowStore.ts` — 窗口状态机基线（P1 拥有并强化）
- `src/features/workbench/core/scheduler.ts` — 生命周期基线（P1 拥有并实现完整版）
- `src/features/workbench/core/tiling.ts` — 平铺几何基线（P2 拥有并实现完整版）
- `src/features/workbench/index.ts` — 模块唯一公共出口（新增导出需追加，不得删改）

### 0.2 文件归属（一个文件只有一个可写代理）

| 路径 | 主责 |
|---|---|
| `workbench/core/windowStore.ts`、`scheduler.ts`、`occlusion.ts`、`snapshot*.ts`、`core/__tests__/**` | P1 |
| `workbench/core/pointerEngine.ts`、`tiling.ts`、`snapZones.ts`、`components/SnapPreview.tsx`、相关测试 | P2 |
| `workbench/components/WindowShell.tsx`、`WindowTitleBar.tsx`、`TileMenuPopover.tsx`、`WindowResizeHandles.tsx`、`WindowBody.tsx`、`WindowErrorBoundary.tsx`、相关测试 | P3 |
| `workbench/styles/**`、`core/materialTier.ts`、`components/WallpaperLayer.tsx`、`components/EmptyDesktop.tsx` | P4 |
| `workbench/components/Dock*.tsx`、相关测试 | P5 |
| `workbench/components/ExposeOverlay.tsx`、`WindowSwitcher.tsx`、`core/shortcuts.ts`、`hooks/useWorkbenchShortcuts.ts`、相关测试 | P6 |
| `workbench/apps/chat/**` | P7 |
| `workbench/apps/files/**`、`apps/content/**`、`apps/mindmap/**` | P8 |
| `workbench/apps/system/**`、`apps/sandbox/**`、`core/eventHub.ts`、`core/projection.ts` | P9 |
| `locales/*/workbench.json`、`components/WorkbenchDevPanel.tsx`、settings 实验开关 UI、`docs/dev/learning-os-acceptance.md` | P10 |
| `components/WorkbenchDesktop.tsx`、`App.tsx` 分支、`core/legacyNavigationMap.ts`、导航迁移、启动接线 | P11 |

**全员禁区**：`App.tsx`（P11 专属）、`core/types.ts`、别人的文件、
`UnifiedAppPanel.tsx` / `TabPanelContainer.tsx` 等 legacy 路径（保持原样）、Rust 后端、
`locales/**`（P10 专属）。

### 0.3 CSS 类名契约（P4 定义实现，其他代理只消费）

组件代理（P3/P5/P6/P11）使用以下类名 + Tailwind 布局工具类，**不得**自己写
backdrop-filter/阴影/材质硬编码：

```
wb-glass            玻璃面板基础材质（Dock、标题栏、overlay 背景）
wb-glass-highlight  顶缘高光
wb-window           窗口容器（圆角、边框）
wb-window-focused   焦点窗口阴影档
wb-window-idle      非焦点阴影档
wb-titlebar         标题栏
wb-traffic          三键容器 / wb-traffic-close|min|zoom
wb-dock             Dock 容器 / wb-dock-item / wb-dock-indicator / wb-dock-badge
wb-snap-preview     吸附预览轮廓
wb-anim-open        开窗动画 / wb-anim-minimize 最小化动画
wb-expose-backdrop  俯瞰背景
```

### 0.4 i18n 规则

只有 P10 写 `locales/*/workbench.json`。其他代理在代码中使用
`t('workbench:xxx', '中文兜底文案')` 带默认值形式，并把所用 key 列进自己的进度文件，
P10/P11 汇总补齐。

### 0.5 进度记录（强制）

每个代理在 `docs/dev/workbench-progress/P{N}.md` 记录进度：

- 开始时创建，写入任务 checklist；
- 每完成一项立即勾选并注明产出文件；
- 结束时写四节：`已完成`、`遗留问题`、`需要接线代理（P11）处理的事项`、`需要的 i18n keys`。

### 0.6 验证要求

- 提交前运行 `npx tsc --noEmit -p tsconfig.json`，确保没有**自己引入**的错误；
- 写了测试的运行对应 `npx vitest run <path>`；
- 不要启动 dev server / tauri dev；不要 git commit。

### 0.7 统一启动 Prompt 模板（人工/协调者启动用）

```
你是 Deep Student 学习 OS Workbench 项目的并行实施子代理 P{N}。
仓库根目录：e:\2026ds\deep-student（Windows / PowerShell）。
第一步完整阅读：
  docs/dev/learning-os-10-agent-parallel-prompts.md（通用规则 + 你的章节）
  docs/dev/learning-os-workbench-design.md（设计文档）
然后实现你章节的全部任务清单并达成 DoD。严守文件归属与禁区。
进度按 0.5 节要求记录到 docs/dev/workbench-progress/P{N}.md。
完成前按 0.6 节自验。最终回复：完成内容摘要、文件清单、遗留问题。
```

---

## P1 — 内核完整版（状态机 / 调度器 / 快照）

**职责**：把基线 windowStore、scheduler 升级为生产级，并实现快照持久化。接口冻结不可变。

任务清单：

1. `windowStore.ts` 强化：cascade 边界回卷完善；`hydrate` 与 zIndex 归一化（重排为紧凑序列）；
   focusStack 不变量（focus 必最高 zIndex）；desktopSize 变化时 maximized/tiled 窗口无需存 frame。
2. `occlusion.ts`：zIndex 自顶向下矩形并集遮挡计算，导出 `computeOcclusion(windows, desktopSize): Record<id, boolean>`（true=完全被遮挡）。
3. `scheduler.ts` 完整版：`recomputeLifecycles()` 真实实现——
   focused（栈顶非最小化）/ visible（有可见面积）/ background（最小化或全遮挡）/
   frozen（memoryWeight 预算超限时对 background 按 lastFocusedAt LRU 冻结）。
   预算：默认 12 点，macOS（`navigator.platform` 检测）9 点。
   在窗口增删/移动提交/焦点变化时触发（订阅 store，内部防抖 1 帧）。
4. `snapshot.ts`：`saveSnapshot()`（防抖 2s，写现有 settings 存储 `get_setting`/`save_setting`
   invoke，key=`desktop.workbenchSnapshot`）+ `loadSnapshot()` + sanitizer（白名单剥离，
   剔除 lifecycle/payload/未知字段）+ `WorkbenchSnapshotV1` 校验（坏数据→null+console.warn）。
5. 单元测试 ≥25 case：focusStack/zIndex 不变量、restoreFrame 往返、遮挡矩阵、预算冻结
   （focused/visible 永不冻结）、sanitizer 注入剥离、坏 JSON 恢复。

DoD：
- [ ] 5 窗叠放遮挡判定正确（含部分遮挡=visible）
- [ ] 超预算只冻 background，唤醒（focus）立即解冻
- [ ] 快照往返（save→load→hydrate）后 frame/displayMode/ratio 完全一致
- [ ] vitest 全绿；tsc 无新错误

---

## P2 — 指针交互引擎与平铺系统

**职责**：拖拽/缩放引擎（60fps 纪律）+ 吸附 + 平铺几何完整版。

任务清单：

1. `core/pointerEngine.ts` + `components/window-shell/useWindowPointer.ts`（实现冻结接口
   `WindowPointerCallbacks`）：Pointer Events 捕获；拖动/八向缩放；rAF 合帧回调
   `onFrameChange`（调用方直接写 DOM，不进 React state）；`setPointerCapture`；
   Esc 取消拖动回原位；minSize clamp（从 appRegistry 取）。
2. `core/snapZones.ts`：拖动中命中检测——左/右边缘 24px → 半屏；四角 64px → 四分屏；
   顶缘 → maximize。导出纯函数 `hitTestSnapZone(pointer, desktopSize): SnapZone`。
3. `core/tiling.ts` 完整版：margin 支持（设置读取由 P11 接线，先留参数）；
   ratio 应用于 tiled-left/right 对；`zoneToDisplayMode(zone)` 导出；四分屏几何修正
   （当前基线的 margin 计算需要精确化并配测试）。
4. `components/SnapPreview.tsx`：接收 `zone` prop 渲染预览轮廓（`wb-snap-preview` 类，
   120ms fade-in，独立 fixed 层）。
5. 平铺中缝拖拽 hook `useTilingDivider(leftId, rightId)`：拖动写 store.setTilingRatio。
6. 测试：snapZones 命中矩阵、computeTiledFrame 12 形态、ratio 边界（0.2–0.8 clamp）。

DoD：
- [ ] 拖动过程 0 次 React 重渲染（回调直写 DOM）
- [ ] 12 种平铺形态几何测试全绿
- [ ] Esc 取消、指针捕获丢失（窗外释放）均正确回退

---

## P3 — 窗口 Chrome 与内容壳

**职责**：WindowShell（组合 P2 的 hook）+ 标题栏三键 + 绿灯平铺菜单 + WindowBody 生命周期壳。

任务清单：

1. `WindowShell.tsx`：绝对定位容器；消费 store 单窗 selector + `computeTiledFrame`；
   集成 `useWindowPointer`（拖标题栏移动、边缘缩放）；点击任意处 focusWindow；
   `wb-window wb-window-focused|idle` 类；拖动期间内容层 `pointer-events:none`。
2. `WindowTitleBar.tsx`：高 38px；三键（关=requestClose、最小化、缩放=maximize toggle）；
   双击标题栏 maximize toggle；标题居中省略。
3. `TileMenuPopover.tsx`：缩放键 hover 350ms 弹出九宫格平铺菜单
   （左/右半、四角、填满、居中、恢复），键盘方向键可达，点击调 setDisplayMode/居中算法。
4. `WindowResizeHandles.tsx`：四边四角 6px 命中区（视觉透明）。
5. `WindowBody.tsx`：消费 `useWindowLifecycle`——frozen 卸载子树（显示恢复占位，点击唤醒）、
   background 时 `visibility:hidden; content-visibility:hidden`、把 isActive/isVisible 下传
   给应用 render；Suspense fallback；`WindowErrorBoundary.tsx` 包裹（单窗崩溃显示重载卡片）。
6. requestClose 流程：调 `workbenchBus.closeWindow(id)`（内部走 canClose）。
7. 交互测试：三键行为、双击、菜单键盘导航、ErrorBoundary 恢复。

DoD：
- [ ] WindowShell 在 Storybook 式隔离测试页（测试文件内）可独立渲染
- [ ] frozen→唤醒重建流程测试通过
- [ ] 全部使用 0.3 类名契约，无硬编码材质

---

## P4 — Liquid Glass 视觉系统

**职责**：0.3 全部类名的真实实现 + 三档材质 + 壁纸 + 动效 + 空桌面。视觉是本代理的唯一使命，要做到 macOS Tahoe 级质感。

任务清单：

1. `styles/workbench.tokens.css`：`--wb-glass-bg/blur/highlight`、`--wb-window-radius`(12px)、
   `--wb-shadow-focused/idle`、`--wb-dock-*`、明暗主题两套值（挂 `.dark` 或项目现有主题机制，
   读 `src/styles/theme-colors.css` 对齐变量体系）。
2. `styles/workbench.css`：0.3 全部类；玻璃=多层（半透明底 + backdrop-blur + 顶缘 1px 高光 +
   细边框）；焦点/非焦点阴影两档过渡 160ms；`wb-anim-open`（scale .96→1 + fade 160ms）、
   `wb-anim-minimize`（向下位移缩小 220ms，transform-origin 可由 CSS 变量注入 Dock 方位）。
3. `core/materialTier.ts`：`getMaterialTier()`/`setMaterialTier()`/`useMaterialTier()`——
   full/reduced/minimal；默认值平台检测（Linux→reduced）；`prefers-reduced-motion`→minimal；
   通过 `<html data-wb-material>` 属性驱动 CSS 降级（reduced 去 backdrop-filter，
   minimal 全不透明+禁动画）。
4. `components/WallpaperLayer.tsx`：主题渐变默认（至少 3 套精心调校的渐变预设）+
   自定义图片（值来自 settings，接口 `wallpaper?: {kind,value}`，读写由 P10 设置页提供）。
5. `components/EmptyDesktop.tsx`：空桌面引导卡（玻璃卡片 + 提示从 Dock 开始，插画可用
   phosphor 图标组合）。
6. 对照参考：设计文档 §2.1/§6.5；确保 Windows/macOS full 档观感一致。

DoD：
- [ ] 三档材质切换即时生效（改 html attribute 无需重载）
- [ ] 所有动画仅 transform/opacity
- [ ] reduced 档零 backdrop-filter；minimal 档零动画
- [ ] 明暗两主题下玻璃可读性达标

---

## P5 — Dock 完整实现

**职责**：macOS 级 Dock——固定/运行区、三分支点击、多实例弹层、角标、右键菜单、autohide。

任务清单：

1. `Dock.tsx`：底部居中悬浮（`wb-dock`）；固定区（来自快照 dockPinned，接线前用本地
   state + 导出 `useDockPinned` 供 P11 接快照）+ 运行区（store 中有窗的 typeId 去重）+
   分隔符；图标 44px；hover 放大动效（transform scale，遵守材质档）。
2. `DockItem.tsx`：运行指示点（`wb-dock-indicator`）；点击三分支——无实例→
   `workbenchBus.launch({reason:'dock'})`；单实例→focus（已聚焦→minimize）；
   多实例→弹 `DockWindowList`；角标消费 `appRegistry.get(typeId).badgeSource`
   （轮询 2s + registry subscribe）。
3. `DockWindowList.tsx`：玻璃弹层列出该应用全部窗口（标题 + minimized 标记），点击聚焦；
   Esc/失焦关闭。
4. `DockContextMenu.tsx`：右键——固定/取消固定、关闭全部窗口、（运行中）逐窗列表。
   复用项目现有 context-menu 组件体系（查 `src/components/ui`）。
5. autohide 模式：prop 驱动（设置接线 P11）——隐藏至底缘 4px 热区，指针进入滑出 180ms。
6. 键盘可达：Dock roving tabindex，Enter=点击。
7. 测试：三分支逻辑、多实例弹层、固定切换。

DoD：
- [ ] 三分支 + 弹层 + 右键全部可用
- [ ] badge 源变化 2s 内反映
- [ ] autohide 滑入滑出不抖动

---

## P6 — 俯瞰 / 切换器 / 快捷键

**职责**：Mission Control 式俯瞰 + Ctrl+Tab 切换器 + 全套快捷键系统。

任务清单：

1. `ExposeOverlay.tsx`：触发后所有非 minimized 窗按网格等比缩小
   （对现有窗口 DOM 施加 transform，**不卸载不截图**——通过给每窗注入
   `data-expose-transform` CSS 变量或包装层实现）；标题标签；点击聚焦并退出；
   Esc 退出；进出动画 200ms；背景 `wb-expose-backdrop`。
   网格布局算法：按窗口数计算行列，保持窗口宽高比。
2. `WindowSwitcher.tsx`：Ctrl+Tab 按住循环——中央玻璃条 + 应用图标 + 标题，
   松开 Ctrl 聚焦选中；Shift 反向。
3. `core/shortcuts.ts` + `hooks/useWorkbenchShortcuts.ts`：注册表模式
   （id/键位/handler/描述 key），实现设计文档 §6.4 全部快捷键：
   Ctrl+Alt+←/→（平铺左右）、Ctrl+Alt+↑（maximize）、Ctrl+Alt+↓（恢复/最小化）、
   Ctrl+Alt+C（居中）、Ctrl+Tab/Ctrl+Shift+Tab、Ctrl+Alt+E（俯瞰）、
   Ctrl+W（关焦点窗，可配置）。焦点在 input/textarea/contenteditable 时全部不触发；
   导出快捷键清单 API `listWorkbenchShortcuts()` 供设置页展示（P10 消费）。
4. 测试：快捷键 guard（输入框内不触发）、切换器循环顺序（lastFocusedAt）、
   俯瞰网格算法。

DoD：
- [ ] 俯瞰进出 10 窗不掉帧（transform-only）
- [ ] 切换器松开即聚焦，顺序=最近使用
- [ ] 全部快捷键与浏览器/系统保留键无冲突

---

## P7 — Chat 应用（普通窗口化）

**职责**：把 ChatV2 会话界面抽成 workbench 普通应用。**这是全项目最高风险项，
禁止重写 chat 管线/store，只做 UI 层组合复用。**

任务清单：

1. 研读 `src/features/chat/pages/ChatV2Page.tsx` 与其 hooks，识别「单会话渲染」所需的
   最小组件集（MessageList、InputBarV2、blocks 渲染、会话生命周期 hooks）。
2. `apps/chat/ChatSessionSurface.tsx`：给定 sessionId 渲染完整会话（消息流 + 输入栏 +
   审批栏 + blocks），复用现有 store/adapter；多窗并存安全（两个 surface 不同 sessionId
   互不干扰——注意排查模块级单例状态，发现则在进度文件记录并做窗口级隔离适配）。
3. `apps/chat/ChatAppWindow.tsx`：AppWindowProps 适配——instanceKey=sessionId；
   isVisible=false 时流式 markdown 降频（如现有渲染有节流参数则接入，无则记录遗留）；
   onTitleChange=会话标题；关闭≠删会话。
4. `apps/chat/register.ts`：typeId='chat'，multi，weight=2，onActivation 支持
   `scrollToMessage`/`setInput`/`focusInput`（映射现有 CHAT_V2_* 事件逻辑）。
5. 新会话入口：`apps/chat/newSession.ts` 导出 `launchNewChatSession()`（创建 session 后
   launch 窗口），供 Dock/P11 消费。
6. 测试：register 元数据、surface 挂载（mock adapter）、双实例隔离冒烟。

DoD：
- [ ] 两个 session 窗并排、各自输入发送互不串扰（人工验证路径写进进度文件）
- [ ] 关窗后 session 数据完好，重开恢复
- [ ] 未动 chat 核心 store/pipeline 任何文件

---

## P8 — 资源应用群（files + 七类内容 + 思维导图）

**职责**：资源侧 9 个应用的薄适配与 files 浏览器窗口化。

任务清单：

1. `apps/content/createContentApp.tsx`：工厂——包 `UnifiedAppPanel` 同款逻辑
   （dstu.get(resourceId) → 对应 ContentView），把 AppWindowProps 映射到
   ContentViewProps（isActive/onTitleChange/onClose）；**直接复用**现有
   `views/*ContentView`，不复制代码。
2. 七类 register：note/textbook/exam/translation/essay/image/file
   （weight：textbook=3、note/exam/translation/essay=2、image/file=1；全部 multi，
   instanceKey=resourceId）。essay/note/translation 接 canClose 未保存拦截
   （如现有视图无脏状态查询接口，记录遗留给 P11/后续）。
3. `apps/mindmap/register.ts`：复用 `MindMapContentView`，weight=2，
   isVisible=false 暂停 canvas 动画（现有 isActive prop 已支持则直接接）。
4. `apps/files/FilesAppWindow.tsx`：资源浏览器单例窗——复用 learning-hub 的 finder
   组件体系（`src/features/learning-hub/components/finder/**` 只读消费），
   双击/回车资源 → `workbenchBus.launch({typeId: 由资源类型映射, instanceKey, reason:'files'})`；
   保留搜索与文件夹导航；weight=1，single。
5. 资源删除联动：订阅现有 DSTU 删除事件（查 learning-hub 现有事件名），
   资源删 → 遍历 store 关对应窗（此逻辑放 `apps/files/resourceSync.ts`）。
6. 测试：工厂映射、七类 register 元数据、类型→typeId 映射表。

DoD：
- [ ] files 窗内双击 PDF/笔记/思维导图分别开窗成功
- [ ] 七类内容窗渲染=现有面板等价（复用同一组件）
- [ ] 资源删除后对应窗自动关闭

---

## P9 — 系统应用群 / 投射 / 事件中枢

**职责**：系统级应用窗口化 + 长活实例 projection + Tauri 事件单一中枢。

任务清单：

1. `apps/system/`：五个 register + 薄包装——todo（`TodoContentView`）、
   skills（`SkillsManagementPage`）、templates（`TemplateManagementPage`）、
   taskDashboard（`TaskDashboardPage`）、settings（`Settings` 组件，single，
   注意其现有 shell 侧栏依赖，必要时用其内部 tab 结构，记录适配点）。
   全部 single 或 multi 视组件性质定（settings/todo/skills=single）。
2. `apps/sandbox/register.ts`：`SandboxWorkbenchSurface` 窗口化（multi by workspaceId
   或 single，读现有组件签名决定并记录）。
3. `core/projection.ts`：projection 管理器——`registerProjectionSource(typeId, source)`，
   source 提供 subscribe（实例列表变化）；实例出现→`workbenchBus.project()`；
   实例消失→默认关窗（宿主可配 keepShell）。
4. 接入两个投射源：番茄钟（`src/features/pomodoro` 运行状态）、制卡任务
   （anki 任务 store/事件，查 `TaskDashboardPage` 数据源）——任务运行中 Dock 角标
   （通过 register 的 badgeSource）+ 可选窗口投射。
5. `core/eventHub.ts`：workbench 模式下的 Tauri 事件单一订阅中枢——
   `hubListen(eventName, router)` 保证每个事件名全局仅一个 `listen`，
   按 payload 中 sessionId/resourceId 路由到窗口/应用回调；卸载时统一 unlisten。
   把 P7/P8 需要的常用事件路由预留好接口（与它们的进度文件对齐）。
6. 测试：projection 生命周期（出现/消失/keepShell）、eventHub 单订阅保证、
   system apps register 元数据。

DoD：
- [ ] settings 窗可开在 Chat 旁并正常保存设置
- [ ] 制卡任务进行中 taskDashboard Dock 角标显示数量
- [ ] eventHub 下同一事件名重复 hubListen 不产生重复 Tauri listener

---

## P10 — 设置 / i18n / 诊断面板 / 验收文档

**职责**：实验开关与全部 workbench 设置 UI、双语文案、开发者诊断面板、验收清单。

任务清单：

1. settings 实验区（新建 `src/features/settings/components/WorkbenchSettingsSection.tsx`，
   由现有 GeneralTab 或实验 tab 挂载——只在挂载点插一行 import+组件，减少冲突面）：
   - `desktop.workbenchMode`（总开关，走现有 `get_setting`/`save_setting` invoke 模式）
   - materialTier（分段控件：跟随平台/full/reduced/minimal → 调 P4 `setMaterialTier`）
   - 壁纸选择（预设渐变 + 自定义图片路径）
   - tileMargins（开关+数值）、dockAutohide、workbenchDevPanel
   - 开关变化调用 `workbenchBus.setEnabled()` + dispatch `workbench:mode-changed`
     CustomEvent（P11 在 App.tsx 消费）
2. `locales/zh-CN/workbench.json` + `locales/en-US/workbench.json`：预置全量 key——
   Dock（固定/取消固定/关闭全部）、窗口（关闭/最小化/缩放/平铺各方向/恢复/居中）、
   俯瞰、切换器、空桌面引导、设置项标签与说明、快捷键描述、错误恢复卡。
   检查项目 i18n 注册点（`src/locales` 的 namespace 装载方式）并注册 workbench namespace。
3. `components/WorkbenchDevPanel.tsx`：悬浮诊断面板——窗口列表（lifecycle 着色）、
   weight 预算占用条、focusStack、快照最后保存时间、rAF 帧耗时简易采样。
4. `docs/dev/learning-os-acceptance.md`：30 条验收清单文档化（从编排文档 §7 展开为
   可勾选步骤，含操作路径与期望结果），供 P11 与人工验收执行。
5. 测试：设置读写往返、i18n key 完整性（zh/en key 集合一致）。

DoD：
- [ ] 开关切换即时生效路径就绪（事件已 dispatch，等 P11 接）
- [ ] zh/en key 集合 diff 为空
- [ ] DevPanel 可独立渲染（mock store 数据）

---

## P11 — 接线代理（P1–P10 完成后启动）

**职责**：把十路成果装配成整机并达成全部验收。唯一可改 `App.tsx` 的代理。

任务清单：

1. `components/WorkbenchDesktop.tsx`：总装——WallpaperLayer → 窗口层
   （store 遍历 × WindowShell+WindowBody）→ SnapPreview → Dock → Expose/Switcher overlay →
   DevPanel（条件）；desktopSize 监听（ResizeObserver → store.setDesktopSize）；
   挂 useWorkbenchShortcuts；启动时 loadSnapshot→hydrate→逐帧唤醒；
   订阅 store 防抖 saveSnapshot。
2. `App.tsx` 分支：读 `desktop.workbenchMode` + 监听 `workbench:mode-changed`；
   开启时主内容区渲染 `<React.lazy(WorkbenchDesktop)>`（独立 chunk），
   左侧导航折叠为窄条或隐藏；关闭时 legacy 路径 100% 原样。
3. `core/legacyNavigationMap.ts` + `workbenchBus.registerLegacyFallback`：
   开关关→launch/activate 翻译回现有 CustomEvent；
   开关开→grep 迁移主要导航发起点（`learningHubOpen*`、`CHAT_V2_SET_INPUT`、
   command palette 打开资源/会话、App.tsx 相关 listener）改走 bus；
   维护 `docs/dev/learning-os-nav-migration-checklist.md` 100% 勾选。
4. 应用装配：确保各 apps register 在 workbench 入口统一 import 生效
   （`apps/registerAll.ts`）；Dock pinned 默认值（chat/files/settings/todo）。
5. 全量集成修复：跑 typecheck + vitest 全绿；跑 P10 验收文档逐条执行，
   结果回写 acceptance 文档；发现的跨代理缺陷直接修复（此时拥有全仓写权限，
   但优先小修，大问题记录）。
6. 汇总各 P 进度文件的「需要接线代理处理的事项」并逐条消化。

DoD：
- [ ] 开关 off 零回归（legacy 全量可用）
- [ ] 开关 on：Dock 开 files→双击 PDF→吸附右半屏→开 chat 左半屏→重启恢复布局 全链路通
- [ ] typecheck + vitest 全绿；验收文档 30 条逐条标注结果
