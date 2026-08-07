# 学习 OS（Workbench）20 子代理并行落地编排

- 日期：2026-07-08
- 关联设计：`docs/dev/learning-os-workbench-design.md`
- 目标：**非 MVP**——视觉、交互、功能全量 SOTA 可用，实验开关后可作为日常主力桌面使用
- 策略：**20 个子代理高度并行**，通过冻结契约 + 文件归属 + 分波集成降低冲突

---

## 0. 第二轮思考结论（为什么这样拆）

### 0.1 「完全落地」的定义

对照设计文档 Phase 1–4，**全部交付**，并额外补齐「SOTA 抛光层」：

| 维度 | 必须达到的标准（不是「能用就行」） |
|---|---|
| **视觉** | Liquid Glass 三档材质可切换；Dock/标题栏/俯瞰/吸附预览玻璃一致；开窗/最小化/聚焦阴影过渡 160–220ms 无 jank；壁纸随主题联动 + 自定义图；Linux 自动降级不白屏 |
| **交互** | 拖拽吸附半屏/四角 + 预览轮廓；绿灯悬停平铺菜单；平铺间距可关；左右平铺中缝可调比例；restoreFrame 拖走即恢复；Dock 三分支（launch/focus/minimize）+ 多实例弹层 + 右键固定；Mission Control 俯瞰 + Ctrl+Tab 循环；全套快捷键 + 输入框内不触发 |
| **功能** | Chat 与普通应用完全同权（多会话多窗）；9 类资源应用 + files 浏览器 + sandbox + todo + skills + settings + templates + task-dashboard；`workbenchBus` 取代主要 CustomEvent 导航；projection（番茄钟/制卡任务/Agent 任务）；快照跨重启恢复；开关关闭零回归 |
| **性能** | 5 窗（PDF+编辑器+Chat 流式+思维导图+files）拖焦点窗 ≥55fps；调度器四档生命周期正确；frozen 唤醒无数据丢失；Chat 降频不丢 token |
| **工程** | 每窗口 ErrorBoundary 隔离；dev 诊断面板；vitest 覆盖 store/scheduler/snapshot/交互；中英文 i18n |

### 0.2 并行落地的核心矛盾

20 个代理同时改代码，**最大风险是 merge 冲突与接口漂移**，不是「做不出来」。

解法三件套：

1. **Hour-0 契约冻结**（本文 §1）——所有代理按同一份 TypeScript 契约实现，禁止私改公共类型
2. **文件归属表**（本文 §3）——一个文件只有一个「主责代理」可写；跨模块只通过 `workbenchBus` / `appRegistry.register()`
3. **分波集成**（本文 §4）——Wave A 合入内核 → Wave B 合入壳层 → Wave C 合入应用 → Wave D 合入迁移与 QA

### 0.3 关键架构决策（并行友好）

- **应用自注册**：每个应用代理在 `apps/<name>/register.ts` 末尾调用 `appRegistry.register(def)`，**禁止**多人共改一个巨型 `registerBuiltinApps.tsx`
- **Store 单写者**：仅 A02 写 `windowStore.ts`；其他代理通过 selector + action 调用
- **样式单写者**：仅 A08 写 `workbench.css` 与材质 token；组件只用 className/token，不写硬编码 blur
- **App.tsx 二分**：A09 只加 workbench 渲染分支（~80 行）；A17 只改导航 listener（不改渲染结构）

---

## 1. Hour-0 冻结契约（所有代理必须遵守）

> 实现时以 `src/features/workbench/core/types.ts` 为唯一真相源；A01 负责落盘，其他代理在 A01 合入前可本地 stub 同签名。

```ts
// === 帧与窗口 ===
export interface Frame { x: number; y: number; w: number; h: number; }

export type DisplayMode =
  | 'floating' | 'maximized'
  | 'tiled-left' | 'tiled-right'
  | 'tiled-tl' | 'tiled-tr' | 'tiled-bl' | 'tiled-br';

export type WindowLifecycle = 'focused' | 'visible' | 'background' | 'frozen';

export interface WorkbenchWindow {
  id: string;
  typeId: string;
  instanceKey: string | null;
  title: string;
  frame: Frame;
  restoreFrame: Frame | null;
  displayMode: DisplayMode;
  minimized: boolean;
  zIndex: number;
  createdAt: number;
  lastFocusedAt: number;
  // lifecycle 由 scheduler 派生，不持久化
}

// === 应用 ===
export interface AppWindowProps {
  windowId: string;
  instanceKey: string | null;
  launchPayload: unknown;          // 瞬态，不进快照
  isActive: boolean;
  isVisible: boolean;
  onTitleChange: (title: string) => void;
  requestClose: () => void;
  confirmClose: () => void;
}

export interface AppDefinition {
  typeId: string;
  nameKey: string;
  icon: React.ReactNode;
  instanceMode: 'single' | 'multi';
  memoryWeight: 1 | 2 | 3;
  defaultFrame: Frame;
  minSize: { w: number; h: number };
  render: React.LazyExoticComponent<React.FC<AppWindowProps>>;
  onActivation?: (ctx: ActivationContext) => void;
  badgeSource?: () => { kind: 'count' | 'dot'; value?: number };
  canClose?: (instanceKey: string | null) => boolean | Promise<boolean>;
}

// === Bus ===
export interface LaunchRequest {
  typeId: string;
  instanceKey?: string;
  payload?: unknown;
  reason: 'dock' | 'api' | 'shortcut' | 'files' | 'command';
}

export interface ActivateRequest {
  typeId: string;
  instanceKey: string;
  action: string;
  payload?: unknown;
  fallbackLaunch?: LaunchRequest;
}

export interface ProjectRequest {
  typeId: string;
  instanceKey: string;
  title: string;
  initialFrame?: Partial<Frame>;
}

// === 快照 ===
export interface WorkbenchSnapshotV1 {
  version: 1;
  windows: Omit<WorkbenchWindow, never>[]; // 无 lifecycle
  dockPinned: string[];
  tilingRatios: Record<string, number>;    // key: tiled pair id
  wallpaper?: { kind: 'theme' | 'image'; value: string };
  materialTier?: 'full' | 'reduced' | 'minimal';
}
```

**Bus 行为契约（A01 实现，全员调用）**

| API | 行为 |
|---|---|
| `launch(req)` | multi+同 instanceKey → focus 已有；single → focus 或新建；新建走 cascade 落位 |
| `activate(req)` | 找窗 → onActivation；找不到 + fallbackLaunch → launch |
| `project(req)` | 注册投射；实例在 → .ensureWindow；实例不在 → 保留壳/layout 记忆 |
| `closeWindow(id)` | 走 canClose → 销毁壳 |
| `isEnabled()` | 读 `desktop.workbenchMode`；false 时 launch/activate **降级**到 legacy 导航 |

---

## 2. 二十子代理分工（主责 + SOTA 验收）

每个代理交付量：**≥8 个文件或 ≥1500 行有效逻辑**（含测试），且通过自身 DoD。

### A01 — Platform Spine & Bus（内核主责）

**拥有**：`core/types.ts`、`core/appRegistry.ts`、`core/workbenchBus.ts`、`core/index.ts`、`hooks/useWorkbenchEnabled.ts`

**任务**：
- 完整实现 appRegistry（register/get/list/badge 聚合）
- workbenchBus 三分语义 + legacy 降级表（至少覆盖：`learningHubOpen*`、`CHAT_V2_*`、`NAVIGATE_TO_VIEW`、command palette open resource）
- 读取 settings 中 `desktop.workbenchMode`（A19 提供 UI，A01 提供 read API）
- 导出模块公共 API（`index.ts` 唯一出口）

**SOTA DoD**：
- [ ] bus 单测 ≥20 case（launch 去重、activate fallback、disabled 降级）
- [ ] 任何 feature 不 import workbench 内部，只 import `@/features/workbench`

---

### A02 — Window Store 状态机（内核主责）

**拥有**：`core/windowStore.ts`、`core/windowStore.actions.ts`、`core/__tests__/windowStore.test.ts`

**任务**：
- zustand store：windows Map、focusStack、zIndex 分配、CRUD
- actions：open/focus/minimize/close/move/resize/setDisplayMode/bringToFront/sendToBack
- cascade 新窗算法（+24 偏移、边界回卷、<1280px 默认 maximized）
- restoreFrame 语义：进入 tiled/maximized 前保存，退出时恢复

**SOTA DoD**：
- [ ] 焦点栈与 zIndex 不变量测试（focus 必 top zIndex）
- [ ] 平铺切换不丢 restoreFrame

---

### A03 — Scheduler & Lifecycle（性能主责）

**拥有**：`core/scheduler.ts`、`core/occlusion.ts`、`core/__tests__/scheduler.test.ts`

**任务**：
- 遮挡矩形并集 → lifecycle（focused/visible/background）
- memoryWeight 预算池（默认 12，macOS 检测降至 9）→ frozen LRU
- 导出 `useWindowLifecycle(windowId)` hook 供 WindowBody 消费
- 与 A02 订阅联动：窗口 frame/displayMode 变 → 重算

**SOTA DoD**：
- [ ] 5 窗叠放遮挡用例 100% 通过
- [ ] 超预算只 frozen background 档，never frozen focused/visible

---

### A04 — Snapshot 持久化（数据主责）

**拥有**：`core/snapshot.ts`、`core/snapshot.migrate.ts`、`core/__tests__/snapshot.test.ts`

**任务**：
- debounce 2s 写入现有 settings 存储（key: `desktop.workbenchSnapshot`）
- sanitizer 白名单剥离 lifecycle/payload
- v1 恢复 + 资源不存在丢弃 + 坏 JSON → 空桌面
- 启动时 lazy 恢复（首帧只 mount focused，其余 idle callback 唤醒）

**SOTA DoD**：
- [ ] 恶意字段注入被 sanitizer 剔除
- [ ] 重启后平铺比例/窗口位置误差 <2px

---

### A05 — Pointer Drag & Resize 引擎（交互主责）

**拥有**：`core/pointerEngine.ts`、`components/window-shell/useWindowPointer.ts`

**任务**：
- Pointer Events 拖动/八向缩放
- rAF 合帧写 DOM transform/size，**不** tick store
- pointerup 时 commit 到 windowStore
- 拖动中窗口内容 `pointer-events: none`
- 集成 A06 snap 检测回调（只上报 zone，不渲染）

**SOTA DoD**：
- [ ] 拖动 1000 次无 React re-render storm（perf test / dev 计数）
- [ ] 缩放触 minSize clamp

---

### A06 — Tiling & Snap 系统（交互主责）

**拥有**：`core/tiling.ts`、`core/snapZones.ts`、`components/SnapPreview.tsx`

**任务**：
- 边缘/角落 snap zone 几何（含 8px margin 可关）
- displayMode 与 frame 互转（半屏/四分屏/maximized）
- 左右双窗 tilingRatios 中缝拖拽（写入 snapshot）
- 从 tiled 态拖离 → 触发 restoreFrame

**SOTA DoD**：
- [ ] 12 种平铺形态单元测试全覆盖
- [ ] SnapPreview 120ms fade-in，拖动离开 zone 即 hide

---

### A07 — Window Chrome & Tile Menu（交互主责）

**拥有**：`components/WindowShell.tsx`、`components/WindowTitleBar.tsx`、`components/TileMenuPopover.tsx`、`components/WindowResizeHandles.tsx`

**任务**：
- 三键（关/最小化/缩放）+ 双击标题栏 maximize toggle
- 缩放键 hover 350ms → 平铺菜单（九宫格图标）
- requestClose → AppDefinition.canClose 拦截 → confirmClose
- 每窗 ErrorBoundary 包裹 body

**SOTA DoD**：
- [ ] Crepe 未保存关闭弹出确认且可取消
- [ ] 缩放菜单键盘可达（Arrow + Enter）

---

### A08 — Liquid Glass 视觉系统（视觉主责）

**拥有**：`styles/workbench.css`、`styles/workbench.tokens.css`、`core/materialTier.ts`

**任务**：
- 全量 CSS token（§设计 6.5）
- 三档材质：full / reduced / minimal，读 settings + 平台默认覆盖（Linux→reduced）
- 壁纸层（主题渐变 / 自定义图）
- 动效：open/minimize/focus shadow（仅 transform/opacity）
- `prefers-reduced-motion` 自动 minimal

**SOTA DoD**：
- [ ] Windows/macOS full 档 Dock 与标题栏视觉一致
- [ ] reduced 档无 backdrop-filter 仍可读

---

### A09 — Desktop Canvas 宿主（集成主责）

**拥有**：`components/WorkbenchDesktop.tsx`、`components/WindowBody.tsx`、`components/EmptyDesktop.tsx`

**任务**：
- 层序：壁纸 → 窗口层（zIndex）→ SnapPreview → Dock 占位 → 全局 overlay 挂载点
- WindowBody：按 lifecycle 决定 mount/frozen/visibility hidden
- 空桌面引导（「从 Dock 打开文件管理器或 Chat」）
- **App.tsx 唯一注入点**：`workbenchMode ? <LazyWorkbenchDesktop /> : <LegacyViews />`

**SOTA DoD**：
- [ ] lazy import workbench chunk，开关 off 时不下载
- [ ] 空桌面 + 3 窗并排截图基线（供 QA 回归）

---

### A10 — Dock 完整实现（导航主责）

**拥有**：`components/Dock.tsx`、`components/DockItem.tsx`、`components/DockWindowList.tsx`、`components/DockContextMenu.tsx`

**任务**：
- 固定区 + 运行中区 + 分隔符
- 点击三分支 + 已聚焦再点 minimize
- 多实例长按/右键 → 窗口列表（标题 + 可选 live thumbnail div）
- badge 聚合 appRegistry.badgeSource
- 右键：固定/取消固定、退出应用（关全部实例）
- autohide 设置项（A19 暴露，A10 实现）

**SOTA DoD**：
- [ ] Chat 3 会话时 Dock 弹层可切换聚焦
- [ ] 运行指示点动画与 macOS 一致（scale fade）

---

### A11 — Expose & Alt-Tab Switcher（导航主责）

**拥有**：`components/ExposeOverlay.tsx`、`components/WindowSwitcher.tsx`

**任务**：
- Ctrl+Alt+E：所有非 minimized 窗 transform scale 俯瞰，点击聚焦，Esc 退出
- Ctrl+Tab / Ctrl+Shift+Tab：图标条 + 窗口缩略布局，松开聚焦
- 动画 200ms，overlay 背景使用 A08 glass token

**SOTA DoD**：
- [ ] 俯瞰模式不卸载窗口 DOM（保持状态）
- [ ] 10 窗下仍 60fps 进入/退出

---

### A12 — 快捷键系统（导航主责）

**拥有**：`core/shortcuts.ts`、`hooks/useWorkbenchShortcuts.ts`

**任务**：
- 实现设计文档 §6.4 全部快捷键
- 焦点在 input/textarea/contenteditable 时不触发（除 Ctrl+W 可选）
- 与 tile/windowStore/bus 动作绑定
- 注册到现有 shortcuts settings 页（可读名称）

**SOTA DoD**：
- [ ] shortcuts 页展示 workbench 分组
- [ ] 与浏览器保留键零冲突

---

### A13 — Files 应用（Learning Hub 窗口化）

**拥有**：`apps/files/` 目录（register + FilesAppWindow + 侧栏/列表/打开逻辑）

**任务**：
- 将 `LearningHubSidebar` + finder 能力迁入单例 files 窗
- 双击资源 → `workbenchBus.launch({ typeId, instanceKey })`
- 与 DSTU 删除联动：资源删 → 对应窗自动 close
- files 窗内搜索、文件夹导航、索引状态栏完整保留

**SOTA DoD**：
- [ ] 从 files 打开 PDF+笔记+Chat 三窗并排无二次导航
- [ ] workbench off 时 files 仍走 legacy learning-hub 全屏

---

### A14 — Chat 应用（普通窗口，核心产品）

**拥有**：`apps/chat/` 目录

**任务**：
- 从 `ChatV2Page` 抽取 **单会话** 视图组件（消息列表+输入栏+blocks），去除 secondary panel 依赖
- multi instanceKey = sessionId；新会话 launch 新窗
- onActivation：`scrollToMessage`、`setInput`、`openAttachment` 等映射现有 chat 事件
- 会话列表不在 Chat 窗内——由 files 或 Dock 多实例列表进入
- Chat 窗关闭 ≠ 删 session

**SOTA DoD**：
- [ ] 两 session 左右平铺，各自流式输出互不抢焦点
- [ ] activate 从 command palette 跳转到已有 session 窗

---

### A15 — Unified Content 七类应用（资源窗）

**拥有**：`apps/content/`（note/textbook/exam/translation/essay/image/file 七个 register）

**任务**：
- 薄适配层：AppWindowProps → 现有 `*ContentView`
- 统一处理 dstu.get(resourceId)、onTitleChange、isActive 降频
- textbook weight=3；note/exam/translation/essay/mindmap=2；image/file=1
- 未保存拦截接入 canClose（note/translation/essay）

**SOTA DoD**：
- [ ] 七类资源各 1 个 e2e 场景：files 打开 → 编辑 → 关闭 → 快照恢复
- [ ] PDF 仍走 pdfstream，无 IPC 大图

---

### A16 — Mindmap / Sandbox / System 应用包

**拥有**：`apps/mindmap/`、`apps/sandbox/`、`apps/system/`（todo、skills-management、settings、template-management、task-dashboard）

**任务**：
- mindmap：复用 MindMapContentView，canvas 在 visible 档暂停动画
- sandbox：SandboxWorkbenchSurface 窗口化
- system 五应用：现有全屏页面包一层 AppWindowProps 适配
- pomodoro / 制卡任务：**projection** 接入（任务开始 project，结束 close 或 minimize to dock badge）

**SOTA DoD**：
- [ ] settings 窗可在 Chat 旁边打开且保存设置生效
- [ ] 制卡任务进行中 Dock task-dashboard 角标

---

### A17 — 全局导航迁移（跨模块主责）

**拥有**：`core/legacyNavigationMap.ts`、修改 `App.tsx` listeners、`command-palette/modules/*`、`menu/menuEventBridge.ts`、`app/navigation/*`

**任务**：
- grep 驱动迁移所有 `learningHubOpen*` / `NAVIGATE_TO_VIEW` / chat 相关 CustomEvent → workbenchBus
- command palette「打开资源/会话/设置」走 activate/launch
- workbench off：legacy map 原样 dispatch CustomEvent
- learning-hub 全屏 view 保留但 workbench on 时不再作为默认入口

**SOTA DoD**：
- [ ] 迁移清单 100% 勾选（agent 维护 `docs/dev/learning-os-nav-migration-checklist.md`）
- [ ] 开关 off 回归测试全绿

---

### A18 — Tauri Event 中枢（后端事件主责）

**拥有**：`core/eventHub.ts`、`hooks/useWorkbenchEventHub.ts`

**任务**：
- workbench 模式下单例 subscribe 现有 Tauri 事件（chat stream、anki、pdf progress…）
- 按 sessionId/resourceId 路由到目标 windowId，再 dispatch 到应用 onActivation
- 禁止应用窗口内直接 `listen` 全局事件（lint 或 comment 约束）
- 与现有 `TauriAdapter` 共存：adapter 在 workbench off 路径不变

**SOTA DoD**：
- [ ] Chat 两窗时 stream 只进对应 session 窗
- [ ] 无 duplicate listener（DevTools 计数）

---

### A19 — Settings / i18n / 诊断面板

**拥有**：`settings` 相关 UI、`locales/*/workbench.json`、GeneralTab 实验开关、`components/WorkbenchDevPanel.tsx`

**任务**：
- GeneralTab：workbenchMode、materialTier、wallpaper、tileMargins、dockAutohide、workbenchDevPanel
- 中英文全量 key（Dock、Expose、快捷键、空桌面）
- Dev 面板：lifecycle 分布、weight 占用、frozen 列表、last frame time

**SOTA DoD**：
- [ ] 开关切换无需重启
- [ ] i18n 无 fallback 英文漏网

---

### A20 — Integration QA & 性能门禁（质量主责）

**拥有**：`core/__tests__/integration/`、`e2e/workbench/`（如有）、`docs/dev/learning-os-acceptance.md`

**任务**：
- 补齐 A01–A04 未覆盖测试；交互测试：snap、tile menu、dock 三分支、requestClose
- 5 窗性能脚本（手动清单 + 可选 vitest mock rAF 计数）
- 窗口级 ErrorBoundary 触发恢复 UI
- a11y：窗口 role=dialog、aria-label 标题、Dock roving tabindex
- 编写最终验收报告模板，跑完全部 SOTA DoD

**SOTA DoD**：
- [ ] CI vitest 全绿
- [ ] acceptance 文档 30+ 条手工用例全通过

---

## 3. 文件归属与冲突规则

| 路径 | 主责 | 他人权限 |
|---|---|---|
| `workbench/core/types.ts` | A01 | 只读 |
| `workbench/core/windowStore.ts` | A02 | 只读 |
| `workbench/core/scheduler.ts` | A03 | 只读 |
| `workbench/core/snapshot.ts` | A04 | 只读 |
| `workbench/core/pointerEngine.ts` | A05 | 只读 |
| `workbench/core/tiling.ts` | A06 | 只读 |
| `workbench/components/WindowShell.tsx` | A07 | A05 可 PR 指针 hook |
| `workbench/styles/*` | A08 | 只读 |
| `workbench/components/WorkbenchDesktop.tsx` | A09 | 只读 |
| `workbench/components/Dock*.tsx` | A10 | 只读 |
| `workbench/components/Expose*.tsx` | A11 | 只读 |
| `workbench/core/shortcuts.ts` | A12 | 只读 |
| `workbench/apps/files/**` | A13 | 只读 |
| `workbench/apps/chat/**` | A14 | 只读 |
| `workbench/apps/content/**` | A15 | 只读 |
| `workbench/apps/mindmap\|sandbox\|system/**` | A16 | 只读 |
| `App.tsx` | A09（渲染分支）+ A17（listeners） | 禁止第三人改 |
| `locales/**/workbench.json` | A19 | 只读 |

**禁止事项**
- 任何代理不得修改 `UnifiedAppPanel.tsx` / `TabPanelContainer.tsx`（legacy 路径保持）
- 任何代理不得改 Rust 后端（本阶段纯前端 workbench）
- 应用代理不得互引 apps 子目录

---

## 4. 分波集成时间表（最大化并行）

```
Hour 0–2    [契约] A01 合入 types + registry + bus stub（或负责人预先合入本文 §1）
Hour 0–24   [Wave A 并行] A02 A03 A04 A08 A19(仅 settings read)
Hour 0–24   [Wave B 并行] A05 A06 A07 A09 A10 A11 A12 — 依赖 store mock，可并行开发
Hour 12–36  [Wave C 并行] A13 A14 A15 A16 — 依赖 bus + WindowBody 接口
Hour 24–48  [Wave D 并行] A17 A18 A19(完整) A20
Hour 48–72  [Hard merge] A20 牵头全量验收 + 冲突清扫
```

**并行度**：Peak **16 代理同时活跃**（Wave B+C）。

**每日集成顺序**：A01→A02→A03→A04 → A05/A06/A07 → A09 → A10/A11/A12 → A13–A16 → A17/A18 → A19 → A20

---

## 5. 子代理启动 Prompt 模板（复制即用）

每个子代理统一前缀：

```
你是 Deep Student 学习 OS 项目的 Agent {ID}（{名称}）。
仓库：e:\2026ds\deep-student
必读：docs/dev/learning-os-workbench-design.md
      docs/dev/learning-os-20-agent-delivery-plan.md（§2 你的章节 + §3 文件归属）
约束：不得修改非本 agent 拥有的文件；公共类型只读 types.ts；应用用 appRegistry.register() 自注册。
交付：实现 §2 全部任务 + SOTA DoD 勾选；提交前跑 vitest 相关测试；更新 checklist 如有。
```

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| A14 Chat 抽取面过大 | 先抽 `ChatSessionSurface` 纯 UI，逻辑仍用现有 store；禁止重写 chat pipeline |
| A17 迁移遗漏 | 维护 nav-migration-checklist.md，CI grep 禁止新增 `learningHubOpen` 裸 dispatch |
| 视觉/交互分叉 | A08 拥有 token，A07/A10/A11 仅消费 class；Weekly sync 截图对比 |
| 性能回归 | A03 frozen 策略 + A19 dev 面板；A20 5 窗基准为 merge 阻断项 |
| App.tsx 冲突 | A09 与 A17 指定唯一协调人顺序合入（先 A09 分支，A17 rebase） |

---

## 7. 最终验收：SOTA 30 条（A20 执行）

1. 实验开关 off → 与现网完全一致
2. 开关 on → 默认空桌面 + Dock，无侧边栏占位（或可折叠窄条）
3. 从 Dock 开 files → 双击 PDF → 右半屏；再开 Chat 会话 → 左半屏
4. 拖拽窗到左边缘 → 预览 → 半屏吸附
5. 绿灯菜单 → 四分屏 → 中缝拖 70/30 → 重启后比例保持
6. 从 tiled 拖走 → 恢复原始 floating 尺寸
7. Ctrl+Tab 循环 5 窗正确
8. Ctrl+Alt+E 俯瞰 → 点击聚焦
9. Chat 两会话流式输出互不干扰
10. 关闭 Chat 窗不删 session
11. note 未保存关闭 → 拦截
12. 七类资源各开一窗 + 快照恢复
13. settings/todo/skills 可窗口化使用
14. sandbox 窗独立运行
15. pomodoro/制卡 projection 与 Dock 角标
16. 5 窗拖动 ≥55fps（主观 + dev 面板）
17. frozen 后唤醒 PDF 回到上次页码
18. Linux reduced 材质无 blur 崩溃
19. prefers-reduced-motion → 无动画
20. 壁纸自定义保存
21. tile margins 开关生效
22. Dock autohide 生效
23. Dock 固定/取消固定
24. 资源删除 → 对应窗关闭
25. command palette 打开 session → activate
26. 菜单栏/File 菜单（如有）workbench 路由
27. 窗口 ErrorBoundary 单窗崩溃不白屏
28. 中英文 i18n 完整
29. vitest CI 全绿
30. nav migration checklist 100%

---

## 8. 建议的启动命令（协调者一次性拉起）

协调者在同一轮对话中 **并行启动 20 个 Task 子代理**（`subagent_type=generalPurpose` 或 `explore`+实现型），每个携带 §5 模板 + 对应 §2 章节。

**Wave A 优先 4 个**：A01 A02 A03 A04（完成后立即 notify Wave B/C）

**不要** 20 个同时改 App.tsx；A09/A17 错开 12h。

---

*本文档随实现更新；checklist 与 acceptance 由 A17/A20 维护。*
