# U2-ui-shell：改造前 golden 取证

状态：**完整U1依赖已从main合入，四原测试及origin/default-nav/route用例共86项通过，前端/Host类型、边界、相关目录71项、主构建与demo构建在提供方12GiB堆下退出0（集成器8GiB预算未由U2验证，不视为全部组合通过）；以上均为提供方结果，不自勾验收，待R6独立复验与实际集成门禁**。R6-08已独立关闭（作业070627-16f964），不重做golden。同ID隔离按正式来源契约验证；最新记录见§14，先前误分类与缺依赖失败均保留。

## 1. 取证来源与提交

- 工作树：`/home/dsdev/dev/ds-mig/U2-ui-shell`
- 分支：`ds-mig/U2-ui-shell`
- 改造前基线：`e303957124ac220f55bee1b04cca5d3937983b92`
- 首次提交：仅新增本文，固定改造前清单及基线验证；可用 `git log --reverse --format='%h %s' e303957124ac220f55bee1b04cca5d3937983b92..HEAD -- docs/dev/electron-migration/audits/U2-ui-shell.md` 定位。
- 首轮取证时改造提交：无；当前实施提交见 §6。
- 首次文档取证提交：`1862459a8`。规格 §1 的可执行取证补充：`src/ui-plugins/official/shell/__tests__/legacyEvidence.ts` 从原实现提取视图顺序、文案、图标、桌面筛选、移动入口、壳层条件和 32 组环境组合，固定到 `__golden__/shell.json`。此补充提交仍不含生产改造。
- 已完整阅读 `docs/plugins/FRONTEND.md`、`src/ui-kernel/` 全部六个实现文件与三个现有测试文件。
- 开工 `git status --short` 为空；机器存在其他 lane 的 Vitest 进程。

规格缺失原始证据（2026-11-04，全部命令在本工作树执行）：

```text
$ git show HEAD:docs/plugins/FRONTEND-F1.md
fatal: path 'docs/plugins/FRONTEND-F1.md' does not exist in 'HEAD'
RAW_EXIT_CODE=128
$ git show main:docs/plugins/FRONTEND-F1.md
fatal: path 'docs/plugins/FRONTEND-F1.md' does not exist in 'main'
RAW_EXIT_CODE=128
$ git log --all --oneline -- docs/plugins/FRONTEND-F1.md
RAW_EXIT_CODE=0
```

工作树 glob `**/*FRONTEND*` 仅返回 `docs/plugins/FRONTEND.md`。不能用 FRONTEND.md 的总体方案代替尚未发布的 F1 lane 划分、元数据约定和完成协议。

## 2. 固定 golden：桌面导航

源码：基线 `src/config/navigation.ts:51-127`（只读）、`src/components/ModernSidebar.tsx:338-378,860-899,1262-1504`。

| 顺序 | view | 图标 | label key | fallback |
|---|---|---|---|---|
| 1 | chat-v2 | StudyChatIcon | sidebar:navigation.chat_v2 | 工厂为「新会话」；桌面渲染覆盖为相同 key 的无 fallback 调用 |
| 2 | learning-hub | StudyBooksIcon | sidebar:navigation.learning_hub | 资源库 |
| 3 | media | StudyMediaIcon | sidebar:navigation.media | 音视频 |
| 4 | todo | StudyTodoIcon | sidebar:navigation.todo | 无 |
| 5 | skills-management | StudyMagicWandIcon | sidebar:navigation.skills_management | 技能管理 |
| 6 | flashcards | StudyCardsIcon | sidebar:navigation.flashcards | 闪卡 |
| 7（可选） | ui-lab | StudyBlocksIcon | sidebar:navigation.ui_lab | 无；仅 uiLabEnabled |

- `navigationScope === 'chat'` 只保留 chat-v2 主入口；默认 full 使用上表过滤，顺序继承工厂数组。
- chat-v2 是新建动作，永不作为活动导航行高亮。已在聊天页立即派发 `COMMAND_EVENTS.CHAT_NEW_SESSION`；否则先 `handleViewChange('chat-v2')`，下一动画帧派发。
- 其余入口用 `isNavEntryActive` 高亮、`resolveNavEntryClick` 导航；闪卡三分区为 flashcards / task-dashboard / template-management。组内点击保持当前分区；组外回最近分区，初始为 flashcards。来源：`src/app/navigation/cardsHub.ts`。
- `handleViewChange` 仅目标与当前不同时记录 `pageLifecycleTracker.log('sidebar', 'ModernSidebar', 'sidebar_click', …)`，但始终调用传入的 onViewChange。
- 行保留 `rowType="nav"`、`aria-label`、活动时 `aria-current="page"`、`data-tour-id="nav-${view}"`；图标 `size-[18px]` / strokeWidth 2。
- 新会话快捷键提示仅 macOS、非移动平台且 fine pointer；内容 `formatShortcut('mod+n')`，原 lg/hover/focus/dark 类名保持。
- 品牌区 → 主导航固定区 → 会话滚动区 → full 专属底部菜单。会话滚动区的置顶、课题、对话顺序及全部会话操作均为原实现。
- 设置不是主导航行：full 专属底部 AppMenu，trigger 的 key 为 `sidebar:navigation.settings`（无 fallback）、图标 StudySettingsIcon、活动条件严格为 settings。菜单先设置，再工作台模式开关；宽 224、align start。
- 更新徽标条件为 `!sidebarCollapsed && updater && !updater.checking && updater.available && updater.info`；下载禁用；点击 stopPropagation 后调用 performUpdateAction。有限 progress 四舍五入，其余回纯文案。

## 3. 固定 golden：移动导航

源码：基线 `src/components/layout/MobileSidebarNavigation.tsx:42-189`、`src/config/navigation.ts:119-127`（只读）。

| 顺序 | view | 图标 | 短标签 key → fallback | aria-label key → fallback |
|---|---|---|---|---|
| 1 | chat-v2 | StudyChatIcon | sidebar:navigation.launcher.chat_v2 → 会话 | sidebar:navigation.sessions → 会话 |
| 2 | learning-hub | StudyBooksIcon | sidebar:navigation.launcher.learning_hub → 资源 | sidebar:navigation.learning_hub → 资源库 |
| 3 | media | StudyMediaIcon | sidebar:navigation.launcher.media → 音视频 | sidebar:navigation.media → 音视频 |
| 4 | todo | StudyTodoIcon | sidebar:navigation.launcher.todo → 待办 | sidebar:navigation.todo → 待办 |
| 5 | skills-management | StudyMagicWandIcon | sidebar:navigation.launcher.skills_management → 技能 | sidebar:navigation.skills_management → 技能管理 |
| 6 | flashcards | StudyCardsIcon | sidebar:navigation.launcher.flashcards → 闪卡 | sidebar:navigation.flashcards → 闪卡 |
| 7 | data-management | Database | sidebar:navigation.launcher.data_management → 数据 | common:navigation.data_management → 数据管理 |

- 实际为七项三列，不按文件头旧注释的「二行三列」改成六项。无 UI Lab 启动器入口；其开关仅参与 createNavItems，供设置查找使用。
- `settingsOnly` 查找 canonicalize 后为 settings 的工厂项；不存在则 null。存在时仅渲染 `DsButton`，44px 圆形、`data-mobile-shell="sidebar-settings"`，图标 size-5。
- 默认 `<nav>` 保留 `data-mobile-shell="sidebar-nav"`、`data-mobile-app-launcher=""`、`common:navigation_label`、`grid grid-cols-3 gap-x-0.5 gap-y-0`。
- 按钮保留 min-h-11、14px、图标 25px、文本 truncate、活动背景与 shell CSS 变量；活动判定双方 canonicalize 后交给 isNavEntryActive。
- 导航先 resolveNavEntryClick。有 Provider 则直调 navigate；返回 false 时不调用 onNavigate，抽屉保持展开。无 Provider 派发 `APP_EVENTS.MOBILE_APP_NAVIGATE`，然后 onNavigate(view)。移动 chat-v2 是导航，不派发桌面的新建会话动作。
- hideSettings / embedded 已声明但当前不读取；settingsOnly 默认 false。

## 4. 固定 golden：App 壳条件与侧栏元素

来源：基线 `src/App.tsx:1053-1176,1561-1652,1741-1755`、`src/app/hooks/useDesktopSidebarElements.tsx:14-69`。此表的新元数据列刻意不拟定字段名，等待规格。

| 原条件 / 行为 | 原结果 | 新元数据 / 迁移状态 |
|---|---|---|
| currentView === settings | sidebar kind settings | 未迁移；规格缺失 |
| currentView === todo | sidebar kind todo | 未迁移；规格缺失 |
| currentView === learning-hub | sidebar kind desktop-page | 未迁移；规格缺失 |
| 其他视图 | sidebar kind main | 未迁移；规格缺失 |
| learning-hub | desktop-page 顶部返回主页行；CaretLeft 18px、common:actions.backToHome、setCurrentView(chat-v2) | 未迁移；规格缺失 |
| settings 或 todo | isShellSidebarView=true；标题栏导航仅侧栏折叠时显示 | 未迁移；规格缺失 |
| settings 且未折叠 | 不显示桌面侧栏开关；其他情况显示 | 未迁移；规格缺失 |
| learning-hub / todo / skills-management / media | 页头 portal，slot 分别 learning-hub-toolbar / todo-toolbar / skills-toolbar / media-toolbar | 未迁移；规格缺失 |
| chat-v2 且 sessionId、title 均非空 | 命令面板按钮 + DesktopShellTitleEditor + GoalStatusChip | 未迁移；规格缺失 |
| 其他页头情形 | 命令面板标题热区 + TextSwap | 未迁移；规格缺失 |
| 闪卡三分区 | 标题热区外 CardsHubTabs，variant titlebar、ml-3、handleViewChange | 未迁移；规格缺失 |
| currentView === settings | content-body 追加 settings-view | 未迁移；规格缺失 |
| !isSmallScreen && !workbenchActive | 挂载桌面侧栏层 | 保留原实现 |
| workbenchActive | Suspense + LazyWorkbenchDesktop 替换整个经典视图层 | 保留原实现 |

侧栏层数组顺序固定 `main, settings, todo, desktop-page`。`DesktopShellSidebarLayers`（只读）首次访问才挂载，之后保活；隐藏使用 hidden、aria-hidden、inert、contentVisibility，并移除隐藏层焦点。不可变成每次切换卸载或启动就挂载全部。

`useDesktopSidebarElements` 的三种元素独立 useMemo：主侧栏传 currentView / handleViewChange / leftPanelCollapsed / sidebarUpdater；设置和待办都传 isSmallScreen=false、globalLeftPanelCollapsed，onBack 用 setCurrentView(chat-v2)。sidebarUpdater 精确包含 checking / available / info / downloading / progress / readyToRelaunch / performUpdateAction。

加载时机与演示壳基线（`App.tsx:21-28,163-197,621-628`）：CloudStorageSection、AnkiTasksApp、WorkbenchDesktop、GlobalDebugPanel、DevMobileRecoveryFab 均为 React.lazy；Workbench 模块求值期仅 localStorage 可用、缓存不为 false、非移动平台时预热。演示壳标志由 demo/main 在 App 加载前设置，setCurrentView 拒绝 chat-v2 以外目标。此处取证不声称已运行演示壳或验证深浅色截图。

## 5. 验证原始结果

改造前运行已有测试，验证移动导航交互和现有内核贡献生命周期基线：

```text
$ npx --no-install vitest run src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx src/ui-kernel/__tests__/kernel.test.ts src/ui-kernel/__tests__/loader.test.ts --maxWorkers=2

 RUN  v3.2.7 /home/dsdev/dev/ds-mig/U2-ui-shell

 ✓ src/ui-kernel/__tests__/kernel.test.ts (8 tests) 168ms
 ✓ src/ui-kernel/__tests__/loader.test.ts (6 tests) 65ms
 ✓ src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx (13 tests) 932ms

 Test Files  3 passed (3)
      Tests  27 passed (27)
   Start at  13:37:56
   Duration  10.53s (transform 1.05s, setup 1.50s, collect 6.75s, tests 1.16s, environment 3.96s, prepare 642ms)

RAW_EXIT_CODE=0
ERRORS_LINES:
(no Errors line emitted)
```

首轮取证时未修改测试或 golden 来适配实现，未进行前端类型检查（当时无实现改动）；当时规格 §5 不可读。后续取证、改造与验证见下节及 §6–§7。

### 规格取证补充（仍为改造前）

```text
$ CAPTURE_SHELL_GOLDEN=1 npx --no-install vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/shell.golden.test.ts --maxWorkers=1
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  13:44:37
   Duration  10.97s (transform 253ms, setup 465ms, collect 6.27s, tests 2.67s, environment 1ms, prepare 206ms)
```

原始退出码：0。Errors 行：未输出。此时生产文件仍为 `e30395712` 的原实现；生成开关在改造后的对照测试中删除。

## 6. 改造与接入

- golden 取证提交：`6beac2e74`；较早文档取证：`1862459a8`。
- 协调者自动检查点：`9d5f9d1cb`（契约/注册/视图适配器）、`c2424b6cb`（导航消费与 golden 对照）、`7d629a40a` / `489efb63b`（运行态与原回归装配）；App 元数据/视图层接入提交：`86302a65a`。
- `src/ui-kernel/contracts/shell.ts`：ShellView、ShellNavItem、ViewShell 与最小可见性输入类型。
- `src/ui-plugins/official/shell/index.ts`：`dstu.ui.shell`，order=10；17 个视图、9 个导航贡献。views/nav 显式 order 以 10 递增，原有 gate 保留为 visible。
- `src/App.tsx`：订阅 views；用 slot 元数据选择壳层外观，按 slot 顺序渲染视图，保留原有内容 hook 及 memoized React 元素。
- `RegisteredViewLayer.tsx`：用已注册 component 渲染内容；children 按 component/content memo，原 ViewLayerRenderer 的延迟挂载、保活、动画、ErrorBoundary 保持。
- `ModernSidebar.tsx` / `MobileSidebarNavigation.tsx`：订阅 nav；原行 DOM、样式、事件、闪卡中心行为保留。
- `useDesktopSidebarElements.tsx` 无需改写：既有 memoized 侧栏元素仍由 App 的注册表 sidebarKind 选中，避免将设置/待办组件移到 eager plugin 注册入口。
- 注册入口无页面 import；其 component 只透传现有 memoized content，避免更改页面 Suspense、props、懒加载时间。没有维护第二套路由页面实现。

### 原条件 → 已实现元数据

| 原条件 | 新字段 / 消费方式 |
|---|---|
| settings / todo / learning-hub / 其他侧栏 | views[].shell.sidebarKind = settings / todo / desktop-page / main |
| learning-hub 返回主页行 | shell.pageBackButton |
| settings / todo 有独立返回入口 | shell.sidebarOwnsBackNavigation；折叠时仍显示标题栏导航 |
| settings 展开时隐藏折叠按钮 | shell.hideExpandedSidebarToggle |
| 四个工具栏视图 | shell.toolbarSlot，保留原 data-shell-slot 字符串 |
| chat-v2 会话标题/编辑器 | shell.chatHeader；sessionId/title 非空条件保持 |
| 闪卡三个分区标题栏及移动 tabs | shell.cardsHubTabs，titleKey 仍共用闪卡文案 |
| settings 的 content-body 类 | shell.contentClass = settings-view |
| 移动返回主页兜底 | shell.mobileBackToHome；仅 chat-v2=false |
| renderViewLayer 的有序清单和 overflow-hidden | views 的 order、contentKey、component、extraClass |
| UI Lab / 开发页面 gate | visible({ uiLabEnabled, dev }) |
| 演示壳只允许 chat-v2 导航 | allowInDemo；仍使用原 module-scope isDemoShell 判定 |
| 桌面主入口过滤 / chat 范围 | nav.desktop.placement / chatScope |
| 桌面 chat-v2 新会话动作与特殊翻译 | nav.desktop.action / omitFallback |
| 底部设置入口 | nav.desktop.placement=settings，保留菜单与更新徽标 |
| 移动七项及设置齿轮 | nav.mobile.placement、label、ariaLabel、icon（默认继承顶层 icon） |

### 验证边界与交接点

1. U1 的 UiKernelProvider/官方安装器尚未进入本分支/main；按规格 §3，U2 测试安装真实 UiKernel + shell 插件。生产入口、演示入口需与 U1 集成后验证运行态。未添加缺失 Provider 时的生产 fallback 或私有内核。
2. 既有移动/桌面回归测试直接 render 组件，无 UiKernelProvider；本 lane 的 `mobile.regression.test.tsx` / `desktop.regression.test.tsx` 通过 `registryRender.tsx` 仅为 render 根补真实 Provider，导入原测试并保留全部断言。原测试文件均未修改。共享测试装配由 C1/U1 处理。
3. `CurrentView`/`canonicalizeView`/导航历史等共享路由文件不在 U2 允许路径中，仍有官方 id 白名单。社区可以覆盖现有视图、在 slot 追加贡献并通过测试宿主渲染；社区全新 id 的全局路由接入交 C1/架构师裁定，未改写旧路由语义。
4. App 剩余 currentView 分支用于业务交接/事件（如资源库打开事件、会话切换、维护模式跳转设置页），保留原实现；不是壳层显示元数据。`useViewLayerContents` 内部页面 isActive、LRU pin/defer 规则仍用原实现（不在写入范围）。

恢复时按协调者要求执行的 ledger（后端汇总，非 U2 完成指标）：

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.6% B 0.7%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

原始退出码：0；Errors 行：未输出。本 lane 无 TESTMAP，golden 与回归文件为前端证据。

## 7. 改造后验证

### golden + 消费组件 + 既有回归

```text
$ npx --no-install vitest run --config vitest.config.ts src/ui-plugins/official/shell tests/vitest/ui-shell src/ui-kernel/__tests__/kernel.test.ts src/ui-kernel/__tests__/loader.test.ts --maxWorkers=2
 Test Files  8 passed (8)
      Tests  82 passed (82)
   Start at  13:59:08
   Duration  63.83s (transform 40.66s, setup 4.94s, collect 53.29s, tests 21.26s, environment 10.92s, prepare 2.32s)
RAW_EXIT_CODE=0
```

Errors 行：未输出。完整日志：`/tmp/opencode/u2-shell-final-tests.log`。
其中 golden=1，移动原回归=13，桌面原回归=45，新增运行态集成=4，内核=14，壳原回归=5。
新增集成覆盖卸载/重新安装导航、键盘守卫、未访问页不触发 lazy、隐藏页 memo、卸载撤销视图与社区视图错误隔离。
首次集成运行 62 passed / 1 failed（退出码 1），失败是新增测试未带既有错误详情的 `[community-broken]` 前缀；按原 ViewErrorFallback 文案修正精确断言，未修改生产兜底或 golden。

### 类型与构建

`npm run version:generate` 已成功（退出码 0；生成 App version 0.11.0 / Build number 19142 / Git hash 9d5f9d1c），生成的 `src/version.ts` 不提交。
第一次 tsc 被工具的 120 秒超时中止，无原始完成退出码，不能算通过；已重新以后台命令运行。
```text
$ npx --no-install tsc --noEmit -p tsconfig.json
RAW_EXIT_CODE=0
```

Errors 行：未输出；编译器未输出诊断。完整日志：`/tmp/opencode/u2-typecheck.log`。
默认堆上限的两个构建均失败，不能计为通过：

```text
$ npx --no-install vite build
✓ 20720 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted
RAW_EXIT_CODE=134

$ npm run build:demo
✓ 20567 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted
RAW_EXIT_CODE=134
```

Errors 行：均未输出（但存在以上 FATAL ERROR）；完整日志：`/tmp/opencode/u2-vite-build.log`、`/tmp/opencode/u2-demo-build.log`。
demo 另输出既有 `vite.demo.config.ts:258` 重复 rollupOptions 键警告（原键位于 232 行）；配置不在本 lane 范围。
构建失败时 V8 堆约 4GB；机器可用内存 51GiB。用命令级 `NODE_OPTIONS=--max-old-space-size=12288` 串行重跑两个原命令，未修改构建配置/依赖。结果：

```text
$ NODE_OPTIONS=--max-old-space-size=12288 npx --no-install vite build
✓ 20720 modules transformed.
[vite-plugin-static-copy] Copied 77 items.
✓ built in 4m 47s
RAW_EXIT_CODE=0

$ NODE_OPTIONS=--max-old-space-size=12288 npm run build:demo
✓ 20567 modules transformed.
[vite-plugin-static-copy] Copied 77 items.
✓ built in 4m 38s
[demo-build] warmup preloads injected into hero.html: 10
RAW_EXIT_CODE=0
```

Errors 行：两个成功日志均未输出。保留现有 chunk 大小、Browserslist、demo 重复键等警告。完整日志：`/tmp/opencode/u2-vite-build-12g.log`、`/tmp/opencode/u2-demo-build-12g.log`。

## 8. 最终交接

- 取证：`1862459a8`、`6beac2e74`；实现/回归：`9d5f9d1cb`、`c2424b6cb`、`7d629a40a`、`489efb63b`、`86302a65a`；验证报告：`68de3991d`、`518071df8` 及本文最终提交。
- 规格进入 main 后按架构师指令合并：`75309c356`；该 merge 未改变 `src/`、tsconfig 或 Vite/Vitest 配置，以上验证对应的前端实现保持不变。merge 带入的后端/运维/依赖变更均来自 main，不是 U2 自行改写。
- golden `shell.json` 对 `6beac2e74` 的 `git diff --exit-code` 为 0；提交的 U2 自有变更全部在允许路径内。
- U1 交接：安装 `dstu.ui.shell`（默认导出含 order=10，也导出具名 order），在桌面及 demo 根提供 UiKernelProvider；未在本分支私自修改 main/demo 启动入口。
- C1/架构师待裁定：新社区视图 id 的共享路由白名单开放；既有直接 render 导航组件的公共测试 fixture 补 Provider。详见 §6；旧路由语义保留。
- 未执行真实桌面/移动浏览器与深浅色视觉截图联调，不以构建成功替代 U1 集成后的运行态验收。
- `npm run version:generate` 生成的 `src/version.ts` 为工作树内未跟踪构建输入，未纳入任何提交；未更改其他 lane 文件。

## 9. R6-08：独立 golden 修订取证（规格 §1.4）

接受审阅指出的旧取证错误，不据新元数据调整 expected：

1. `legacyEvidence.ts` 原使用 `Object.keys(shortLabels)` 代替实际 launcher 数组，虽当前顺序碰巧相同，但无法证明真实顺序。修订为从固定改造前提交 `e303957124ac220f55bee1b04cca5d3937983b92:src/config/navigation.ts` 读取并执行 `MOBILE_APP_LAUNCHER_VIEWS` 初始化表达式；图标/标签仍取同提交的移动消费者。
2. chatHeader 原只有 session/title 同有与同无两组；修订为独立的四种组合，执行同一旧 App JSX 的原始 condition，不手写判定。
3. 原 environments.navigable 把输入名误当成最终可达目标，漏掉 canonicalize（例如 dashboard→data-management、生产 DEV 页面→chat-v2、未知→chat-v2）。删除这项误导输出，新增 navigationTransitions：对全部视图、全部旧别名及未知值执行旧 App 的完整 setCurrentView 回调，canonicalizeView及其集合/别名表也来自同一旧提交；记录 input、target、committed、VIEW_SWITCHED payload，并覆盖 DEV/demo 四组合。
4. 环境输出不再手写 workbench/demo 过滤算法：执行旧 App 的实际 workbench JSX 分支及 renderViewLayer 回调，收集产生的视图层；侧栏存在条件同样直接执行旧 JSX condition。环境保留 DEV/UI Lab/小屏/workbench/demo 全32组合。

实现：`consumerEvidence.tsx` 用 TypeScript transpile 执行固定提交中的原始消费者表达式/回调；仅提供 React 元素创建、环境变量、状态提交/事件记录端口，不导入新 shell 元数据生成 expected，也不启动业务页面。修订提取测试 `legacy.evidence.test.ts` 仅依赖该固定旧提交；改造后的 `shell.golden.test.ts` 另行对照真实 UiKernel slot。

独立 golden 修订已被协调者保存为 `3e28111d4`：仅四个取证测试/工具/JSON文件，未包含生产代码。本文补充旧取证错误和证据出处。原 CAPTURE_SHELL_GOLDEN 及本次临时旧提交重录通道均已删除。

首次作业 `20261104062841-97b280` 完成旧源码执行/取证写入，但耗时5.168s触发默认5s测试超时，退出码1；取证包含TypeScript编译和git读取，独立测试超时调整为20s，未改断言。之后以**无写入环境变量**复核：

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  14:31:18
   Duration  11.82s (transform 249ms, setup 389ms, collect 6.04s, tests 4.11s, environment 0ms, prepare 187ms)
[作业 20261104063116-7e8b83] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/legacy.evidence.test.ts --maxWorkers=1
[作业 20261104063116-7e8b83] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063116-7e8b83.log
```

Errors 行：未输出。以上通过仅证明 fixed-old-source → 修订 golden 可复现；新消费者对照在后续修复提交验证。

修订数据规模：17个视图×独立session/title四组合=68个页头输入；环境32组合；40种导航输入×DEV/demo四组合=160次真实旧导航回调输出。举例：dev=false/demo=false的dashboard提交data-management，而crepe-demo和unknown-view提交chat-v2；dev=true/demo=true的crepe-demo被拦截、不提交、不发事件。改造后同一golden测试的actual现在执行当前App的原始消费者表达式/回调，并传入真实UiKernel slot entries，不再在测试重写这些环境/header/canonical算法。

## 10. R6-10：导航图标局部隔离

- 两个消费者保留 `SlotEntry.owner`；`renderNavigationIcon` 对 owner=`dstu.ui.shell` 返回原图标元素，对其他owner仅给图标加既有ErrorBoundary，fallback函数返回null。未给官方图标额外加边界；不隐藏社区导航行/文案/动作。
- 已覆盖不同ID社区贡献的桌面主入口、桌面设置trigger和菜单图标、移动launcher、移动settingsOnly齿轮。真实组件测试验证这些坏图标不影响其他项，动作可点击，插件卸载后条目撤销。**原“验证官方坏图标传播”结论撤回：该测试实际安装同ID新插件，恰好暴露未隔离漏洞，见§11。**
- 首轮真实卸载测试发现旧 `key=viewId` 在官方/社区条目指向同一视图时重复，导致React保留残留行。改用贡献 `owner/id` 作为key，两端同改；官方列表的顺序/DOM/动作不变。
- R6-09 的合法F0 nav无placement/icon默认行为与新viewId路由仍等待C1/架构师裁定，没有自行增加默认入口、图标或放开白名单。

第一轮修复对照（包括修订golden）结果：

```text
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 4 passed (6)
[作业 20261104063851-78ad63] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/shell.golden.test.ts src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx --maxWorkers=2
[作业 20261104063851-78ad63] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104063851-78ad63.log
```

Errors行未输出。golden已通过，两项失败均是以上重复key导致的卸载残留；修生产key而非删除/放宽测试断言。

后续重检查全部经全局队列，未直接启动重任务：

| 作业 | 命令 | 当前结果 |
|---|---|---|
| 20261104064157-5020be | npx vitest run --config vitest.config.ts src/ui-plugins/official/shell --maxWorkers=2 | 退出0，6文件69测试通过，Errors行未输出 |
| 20261104064253-40dc5f | npx tsc --noEmit -p tsconfig.json | 退出0；提交前version:generate退出0，build19263/git5d81fad1 |
| 20261104064320-bf418d | env NODE_OPTIONS=--max-old-space-size=12288 npx vite build | 退出0，5m41s |
| 20261104064320-4fd711 | env NODE_OPTIONS=--max-old-space-size=12288 npm run build:demo | 退出0，5m42s |
| 20261104064353-865d73 | npx vitest run --config vitest.config.ts src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx tests/vitest/modernSidebarNavigation.test.tsx --maxWorkers=2 | 退出1，52 failed/6 passed，缺少Provider；不以wrapper通过代替此结果 |

```text
 Test Files  6 passed (6)
      Tests  69 passed (69)
   Start at  14:41:58
   Duration  31.37s (transform 25.00s, setup 2.65s, collect 47.20s, tests 19.71s, environment 3.82s, prepare 1.02s)
[作业 20261104064157-5020be] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell --maxWorkers=2
[作业 20261104064157-5020be] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064157-5020be.log

Error: useUiKernel: missing <UiKernelProvider>
 Test Files  2 failed (2)
      Tests  52 failed | 6 passed (58)
   Start at  14:43:55
   Duration  19.36s (transform 27.87s, setup 947ms, collect 25.23s, tests 855ms, environment 2.05s, prepare 425ms)
[作业 20261104064353-865d73] npx vitest run --config vitest.config.ts src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx tests/vitest/modernSidebarNavigation.test.tsx --maxWorkers=2
[作业 20261104064353-865d73] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104064353-865d73.log
```

两个日志都未输出 `Errors` 汇总行；第二项明确是失败，不能授予目录全绿。保留原测试原断言，未添加生产fallback；共享测试根Provider装配待U1/C1合入。本轮修订后的golden相对`3e28111d4`未再改变。

队列类型/构建的 `job.mjs result` 原始输出摘要：

```text
[作业 20261104064253-40dc5f] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104064253-40dc5f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064253-40dc5f.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 41s
[作业 20261104064320-bf418d] env NODE_OPTIONS=--max-old-space-size=12288 npx vite build
[作业 20261104064320-bf418d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064320-bf418d.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 42s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104064320-4fd711] env NODE_OPTIONS=--max-old-space-size=12288 npm run build:demo
[作业 20261104064320-4fd711] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064320-4fd711.log
```

扫描以上完整日志：Errors 行均未输出。类型检查的增量参数由队列自动添加；`.lane.tsbuildinfo` 与 `src/version.ts` 是未提交派生文件。

### 本轮交接提交与剩余项

- 旧源码 golden 修订：`3e28111d4`；解释与关闭重录通道：`06d8e8c27`。两提交均为取证/测试/报告，没有生产改动。
- 新实际消费者对照与社区图标隔离：`f122ff3bd`、`5d81fad1e`、`b6c0fdc7b`、`9a0e135f9`；这些为协调者自动检查点。`1a2183bbd` 记录最终真实测试结果。当前各实现均已在上述69测试、队列tsc和两个构建中验证。
- R6-08/10 请求R6独立复核，未自行修改其ACCEPTANCE勾选。
- R6-09：缺placement/icon的F0 nav如何呈现、新id白名单如何开放，等待架构师裁定；原逻辑仍保留。
- 原受影响测试目录：缺Provider的52个失败已取得真实退出码1；等待U1/C1共享测试根装配，不能以本lane wrapper副本的通过替代。

## 11. C1 07:19Z：R6-10 同ID覆盖待决与 U1 接口建议

确认缺陷：`renderNavigationIcon.tsx:14` 用 `owner === 'dstu.ui.shell'` 判定免边界，而owner只是插件id。社区覆盖同id后仍获得该字符串，因此坏图标会传播到导航外层。`navigationIsolation.test.tsx:89-96` 调用 `contribute('primary', 'dstu.ui.shell')`，并非真正内置插件的安装；该测试看到整nav消失只能说明当前误分类，不是满足“内置官方保持原错误传播”的证据。

按C1指令，**保持当前生产实现与该断言，不用改断言、改golden或扩大所有图标边界掩盖问题**。R6-08已独立关闭，取证JSON与消费者对照不再重做。以下仅为供U1/架构师确认的最小接口建议，未实施，也不视为已批准规格：

- 来源应由安装路径产生：官方目录安装器识别其实际内置模块；社区loader安装（包括同id覆盖）标记为社区。不能以id/name前缀、插件自行声明的meta字段或仅“调用了官方安装函数”代替真实内置模块来源。
- U1内核将该来源随安装实例/fiber记入贡献，并向消费者暴露贡献级来源（字段名/API待裁定）。与owner/id独立；同id替换必须撤销旧来源并让新贡献携带新来源，不能复用旧id上的官方标记。
- U2只消费该来源：真正内置官方图标仍走原渲染路径；社区图标（含同id覆盖）使用已有局部边界。保持当前DOM、标签、动作、lazy边界及原官方错误传播。
- 已只读核对U1分支：`installOfficialUiPlugins` 当前既接受默认glob目录模块，也接受传入plugins数组，均调用 `kernel.install(plugin)`；kernel/SlotEntry尚无来源区分。来源契约需覆盖这些入口，不把测试或社区传入的任意同id对象当内置模块。
- 裁定后验证应区分两条真实路径：①实际内置模块经官方安装路径，测试替换其图标依赖来验证原错误传播；②社区安装路径以同id替换该模块，坏图标只局部失败，宿主与其他条目保留。继续覆盖卸载/再次替换，确保来源不按id残留。当前错误命名测试应届时按获批语义纠正，并保留本节失败原因记录。

待决：来源识别契约（U1拥有的kernel/slots/安装器）、R6-09 placement/icon默认值与新id路由、共享测试装配权限。当前修改仅审计报告，无生产/测试/golden变更，故未重跑重任务；后续重检查仍只走全局队列。

## 12. 正式 §6.2 / §6.5 接入（C1 07:30Z 后）

§11的待决项已获架构师裁定，以下按正式口径实施，保留§11为历史记录：

- `renderNavigationIcon` 改读 `SlotEntry.origin`，仅 builtin免局部边界；owner仅用于贡献身份key/日志，不用于判来源。缺icon合法，返回null，不制造默认图标。
- `shellNavigationItems` 为未声明placement的community贡献补桌面primary/移动launcher，在原slot order/id排序基础上稳定放到显式导航之后；builtin原导航条件保持。契约icon、placement可选，与F0合法贡献对齐。
- `resolveShellView` 允许已注册的新视图key；固定官方id仍经原canonicalize，保留dashboard/DEV等旧语义；未注册未知值仍回chat-v2。App三处导航入口和移动活动项使用该规则，原demo guard仍生效。key冲突仍由真实UiKernel拒绝，未修改共享白名单文件。
- 图标测试现在经U1 `createOfficialUiTestKernel` 安装真正官方模块，用依赖图标故障验证builtin原传播；另经默认community安装同ID替代插件，分别在真实桌面/移动导航验证坏icon局部隔离、其他入口存在、卸载及重新安装builtin。新增无placement/icon的F0贡献显示顺序、新key点击/活动/导航/卸载、不同插件撞官方key拒绝测试。
- 获准维护的四个原测试已改：两个导航测试导入U1共享kernel装配helper并保留原断言；两个壳source测试把失效的旧字符串断言改为真实slot+当前App消费者表达式的折叠/返回可达性断言。其余既有断言保留，未改全局setup。删除本lane原先导入原测试的wrapper副本及私有render装配，避免以副本绿替代原文件。
- R6-08 JSON未变，旧证据提取不重做；实际值测试仅适配当前导航消费者新增的真实resolver依赖。

已只读对齐U1提交 `6bd437e73`：`install(plugin, options={})`，options含origin/config，origin默认community；SlotEntry含origin；共享helper路径 `src/ui-plugins/testing/render.tsx`，提供 `createOfficialUiTestKernel` / `renderWithOfficialUi`。目前该提交在 `ds-mig/U1-ui-boot`，未进入main，本工作树仍为旧kernel且没有helper。**不能把这轮消费端改动声明为已通过集成验证**。只在U2允许文件实施，没有复制U1实现或mock来源。

最新检查点 `6ddf0d4b6`、`2c3466876` 保存了改动。最小队列验证已提交 `20261104080353-275a8c`（真实navigationIsolation测试），用于记录当前依赖装配状态。恢复时要求的ledger已提交队列 `20261104080148-6cd845`；本lane没有TESTMAP，仍以本报告与golden为准。

本轮允许路径按§6.5扩展的精确四项：`src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx`、`tests/vitest/modernSidebarNavigation.test.tsx`、`src/app/shell/__tests__/desktopSidebarShell.source.test.ts`、`src/app/shell/__tests__/shellExitReachability.source.test.ts`。U1 helper只导入不修改。

最小验证取得真实阻塞结果（未收集到测试，不算通过）：

```text
Error: Failed to resolve import "@/ui-plugins/testing/render" from "src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
   Start at  16:03:55
   Duration  3.28s (transform 147ms, setup 750ms, collect 0ms, tests 0ms, environment 1.10s, prepare 211ms)
[作业 20261104080353-275a8c] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx --maxWorkers=1
[作业 20261104080353-275a8c] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104080353-275a8c.log

ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 77% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104080148-6cd845] npm run migration:ledger -- --check --no-write
[作业 20261104080148-6cd845] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080148-6cd845.log
```

Errors汇总行均未输出；前一作业明确退出1。App路由接入也已由检查点`b4c956b2d`保存。当前真实依赖是U1已发布但尚未进main的origin API与共享helper；请C1将U1依赖合入main（或明确授权U2合入U1依赖分支），之后继续最小同ID/default-nav/卸载测试、四原测试、类型与构建门禁。没有运行注定缺依赖的重复重检查，没有引用本轮之前的绿结果宣称新实现完成。

## 13. 集成门禁失败回执后的定向核对

按最新回执执行 `git merge --no-edit main`，合并提交 `d4f863104`。本次main仍未包含U1 origin/共享helper；先前C1“不合依赖分支、不建混合树”的限制继续遵守。没有改golden、生产fallback或原测试断言绕过缺失依赖。

回执只含移动测试13项失败的标题和默认4GB构建OOM片段，没有移动测试完整异常或候选提交号，因此不能断言该门禁用的就是当前适配后候选。本工作树当前精确原入口的复现为**收集阶段缺helper**，并非13项断言实际执行：

```text
Error: Failed to resolve import "@/ui-plugins/testing/render" from "src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
   Start at  17:20:49
   Duration  3.42s (transform 159ms, setup 616ms, collect 0ms, tests 0ms, environment 1.22s, prepare 205ms)
[作业 20261104091836-4e06d9] npx vitest run --config vitest.config.ts src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx --maxWorkers=1
[作业 20261104091836-4e06d9] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104091836-4e06d9.log
```

按回执要求运行的Host门禁（U2本身为前端lane，无Host测试目录）：

```text
> deep-student@0.11.0 typecheck:host
> tsc -p tsconfig.host.json
[作业 20261104091236-023b39] npm run typecheck:host
[作业 20261104091236-023b39] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091236-023b39.log

boundaries: scanned 2337 files, 0 violation(s), 166 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
[作业 20261104091241-8afb58] npm run migration:boundaries
[作业 20261104091241-8afb58] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091241-8afb58.log

No test files found, exiting with code 1
filter: src/ui-plugins/official/shell
include: host/**/*.test.ts, electron/**/*.test.ts, scripts/electron-migration/**/*.test.ts
[作业 20261104091241-85cc36] npx vitest run -c vitest.host.config.ts src/ui-plugins/official/shell --maxWorkers=1
[作业 20261104091241-85cc36] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104091241-85cc36.log
```

上述result均未输出Errors汇总行；两项退出1均不算通过。Host配置不包含src测试，未加passWithNoTests伪装成功；适用的前端原入口结果如上。

构建OOM另属执行器环境：新main的 `scripts/electron-migration/integrate-parallel.mjs:148-152` 已为主/demo构建设置8192MB堆和serial；`oc-dispatch.mjs:1153-1154` 的串行路径仍未指定堆。U2此前12GB队列构建成功及默认4GB退出134证据均保留；不在U2越界修改脚本，也不在依赖仍缺时重复相同构建。请求集成方确认失败回执的候选号/执行路径，并先正常集成完整U1依赖，再执行当前候选的四原入口与origin/default-nav/route门禁。

## 14. 完整U1正式合入后的真实验证

合并main提交 `8bec84b4e` 正式带入U1的完整kernel/slots/hooks/官方安装器/共享render helper（含`6bd437e73`），未合依赖分支或建混合树。此前两轮回执中的缺origin/helper错误由正常依赖集成解除；未复制共享实现、未mock内核、未削弱断言。`version:generate` 退出0，build20412/git8bec84b4，随后才提交前端类型检查。

四个获授权原测试直接运行（已无wrapper副本），联合本lane测试结果：

```text
 ✓ src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx (13 tests) 1081ms
 ✓ src/app/shell/__tests__/desktopSidebarShell.source.test.ts (8 tests) 507ms
 ✓ src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx (10 tests) 2925ms
 ✓ src/ui-plugins/official/shell/__tests__/shell.integration.test.tsx (4 tests) 578ms
 ✓ src/app/shell/__tests__/shellExitReachability.source.test.ts (4 tests) 2024ms
 ✓ tests/vitest/modernSidebarNavigation.test.tsx (45 tests) 13979ms
 ✓ src/ui-plugins/official/shell/__tests__/shell.golden.test.ts (1 test) 2247ms
 ✓ src/ui-plugins/official/shell/__tests__/legacy.evidence.test.ts (1 test) 4102ms
 Test Files  8 passed (8)
      Tests  86 passed (86)
   Start at  18:55:07
   Duration  43.22s (transform 27.69s, setup 3.48s, collect 71.51s, tests 27.44s, environment 6.48s, prepare 1.69s)
[作业 20261104105504-887da4] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx tests/vitest/modernSidebarNavigation.test.tsx src/app/shell/__tests__/desktopSidebarShell.source.test.ts src/app/shell/__tests__/shellExitReachability.source.test.ts --maxWorkers=2
[作业 20261104105504-887da4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105504-887da4.log
```

Errors汇总行：未输出。同ID覆盖测试走真实U1安装语义（默认community），断言其他入口仍在；真正builtin原错误传播由官方安装器装实际shell插件、仅注入其图标依赖故障验证。默认F0 iconless/placementless贡献在官方后按order呈现，真实点击、新key活动、App setCurrentView、demo拒绝、卸载后未知回退及不同插件key冲突均通过。

相关目录检查、类型和两构建（均在合并 `8bec84b4e` 后的同一工作树上运行，`job.mjs result` 原文结论）：

| job | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 20261104105851-633c81 | npx tsc --noEmit -p tsconfig.json（队列实际追加 `--incremental --tsBuildInfoFile .lane.tsbuildinfo`） | 0 | 无诊断输出 |
| 20261104105852-08fe76 | npm run typecheck:host | 0 | 无诊断输出 |
| 20261104105852-303cf9 | npm run migration:boundaries | 0 | scanned 2382 files, 0 violation(s), 178 suppressed via boundary-allow |
| 20261104110112-625c17 | npx vitest run --config vitest.config.ts src/components/layout src/app/shell src/ui-plugins/official/shell --maxWorkers=2 | 0 | Test Files 12 passed (12), Tests 71 passed (71) |
| 20261104110112-1db3ef | env NODE_OPTIONS=--max-old-space-size=12288 npx vite build | 0 | ✓ built in 5m 14s（仅既有 chunk>500kB 警告） |
| 20261104110112-b8173a | env NODE_OPTIONS=--max-old-space-size=12288 npm run build:demo | 0 | ✓ built in 4m 33s，warmup preloads 10 |
| 20261104110805-9762ca | npm run migration:ledger -- --check --no-write | 0 | problems: commands 0, tests 0, orphan registrations 0 |

以上 result 均未输出 Errors 汇总行。golden `shell.json` 与 `3e28111d4` 比对无差异。构建仍用 12GB 堆：默认 4GB 下 OOM 属执行器环境问题（§13），并行集成器已配置 8GB，U2 未改脚本。

Host配置不包含任何U2前端测试，上一轮`20261104091241-85cc36`已取得“No test files found”退出1；不重跑该不适用命令，不用passWithNoTests掩盖。适用前端配置的真实结果如上。

## 15. 已完成（standard-v2 §5 自检）

- 合并main `186f8937b`（基线 d84e29565）后运行 `lane-gate.mjs`：自检2项（typecheck、boundaries）全部通过，退出0。本分支与main的差异仅为本报告，F1代码已在main。
- 测试证据：`20261104105504-887da4` 8 files / 86 passed，退出0；`20261104110112-625c17` 12 files / 71 passed，退出0；构建结论见§14（提供方12GiB堆，集成8GiB预算另计）。
- v2 §1自查：1.1 shell插件经 `src/ui-plugins/official/install.ts` glob以builtin安装，App/ModernSidebar/MobileSidebarNavigation直接消费slot；1.2/1.3/1.4/1.7 本lane无持久化、IPC或Rust日志映射，不适用；1.5 测试走真实UiKernel与原入口，无wrapper副本；1.8 R6独立复验尚未签收。
- 本lane无LANE.md（允许路径仅限本报告），完成证据记于此处。剩余：等待R6复验与实际集成门禁。

## 16. X6-SW-0092/0093/0094 translation owner 委托：只读取证（授权前，未改Host）

范围：C1 申请（escalation 125922048）的窄路径 `host/plugins/translation/repository/translations.ts` + 新 `host/plugins/translation/tests/translation-owner.test.ts`。架构师尚未批准，本节只是取证；未编辑任何Host文件，未复制SQL，未改前端golden。

### 16.1 并发WIP核对（取证时 2026-11-04 约13:10Z）

- L02 工作树 `ds-mig/L02-llm-manager` @ `cf9aba133`：未提交改动只有 `host/plugins/llm/SPEC.md`。`main...HEAD` 下 translation 有未合入提交（`commands.ts`、`transport.ts`、`index.ts`、tests、文档），**不含** `repository/translations.ts` 和 `src/tool_executor.ts`。目标文件当前无 L02 WIP。
- L11 工作树：未提交 `repository/textbooks.ts` 和 tests，`translations.ts`/`types/content.ts` 无未合入差异。
- 结论：授权后可改目标文件；如果正式授权前 L02 动了这两个文件，就暂停并回报。

### 16.2 三个写点：Rust → 当前 L02 → L11 公共面

| ID | 当前 TS（L02） | Rust 原实现 | L11 已发布 same-conn 方法 | 差距 |
|---|---|---|---|---|
| SW-0092 | `translations.ts:84` `INSERT OR IGNORE INTO resources`（本地 `createOrReuseResource`） | `resource_repo.rs:118-197` `create_or_reuse_with_conn_and_hash` | `vfsRepo.resources.createOrReuseWithHash(conn, …)`（`vfs-repos/repository/resources.ts:161`） | 有方法，可直接委托。L02 副本缺 `debug!` Content hash / `info!` Created new resource / `debug!` collision、reuse 日志 |
| SW-0093 | `translations.ts:149` `INSERT INTO translations`（`createTranslation` → `createTranslationInFolder`） | `translation_repo.rs:380-460` + `1088-1122`（外层 SAVEPOINT `create_translation_in_folder` → folder 存在检查 → 内层 SAVEPOINT `create_translation` → `add_item_to_folder_with_conn`） | `vfsRepo.translations.createTranslationInFolder(conn, params, folderId: string \| null)`（`vfs-repos/repository/translations.ts:493`） | 有方法，签名把 `undefined` 改为 `null`。见下面的 16.3 行为差 |
| SW-0094 | `translations.ts:218` `UPDATE translations SET metadata_json` | `translation_executor.rs:1293-1311` `persist_translation_metadata`：executor 自己写，`get_conn_safe` 后不 bump `local_version`/`updated_at`，0 行时返回 `Err(String)` "translation row {id} not found for metadata update" | **无**。`TranslationRepository`（`vfs-repos/types/content.ts:484-507`）没有 metadata 写方法 | **缺 L11 面**：需要 L11 发布 `updateTranslationMetadata(conn, translationId, metadataJson: string): void`，语义逐字对齐 Rust（只改 `metadata_json`；changes=0 抛该消息；不改同步列） |

### 16.3 委托后会改变的现有行为（需 R1/架构师知悉，都向 Rust 靠拢）

1. **device_id**：L02 用 `process.env.DEVICE_ID`（缺省为 null）。L11 用 F4 `paths` 解析出的 deviceId（`vfs-repos/index.ts:139`）。Rust `current_device_id()` 对应后者，委托后同步列才正确。
2. **folder_items**：L02 只执行 `INSERT OR REPLACE`。Rust 和 L11 `addItemToFolder` 先 `DELETE … WHERE item_id AND item_type` 再插入，并 canonicalize item_type。新 id 下结果相同，但应当走 owner。
3. **回滚**：L02 把 `ROLLBACK TO SAVEPOINT x; RELEASE SAVEPOINT x` 放在一个 exec 里，回滚失败时 RELEASE 也不会执行。Rust 两步分别执行并忽略错误。L11 两步分开执行并记 warn。
4. **返回形状**：L02 返回 `title/engine/model: null`、`qualityRating: null`、`metadata: null`。Rust `VfsTranslation`（`types.rs:503-543`）对这些字段 `skip_serializing_if = "Option::is_none"`。L11 省略这些键，更接近 Rust。下游 `translationToDstuNode` 和事件需复核是否依赖 null 键。
5. **日志缺口（L11 侧，非U2可修）**：L11 `createTranslation` 缺 Rust `translation_repo.rs:438` 的 `info!` "Created translation: {id} (resource: {rid}), title: {:?}"。`createTranslationInFolder` 缺 `:1115` `debug!`。`addItemToFolder` 缺 `folder_repo.rs:2706` `debug!`。需交 L11 补齐，委托本身不复制日志。
6. **错误映射**：`mapSaveError`（tool_executor.ts）匹配 `VfsError` NotFound/Folder。L11 `notFound('Folder', id)` 需确认 kind/fields 形状与 L02 `new VfsError('NotFound', {resource_type:'Folder', id})` 一致，否则 FOLDER_NOT_FOUND 会降为 TRANSLATION_SAVE_FAILED。授权后先用测试钉住。

### 16.4 装配缺口：只改 translations.ts 做不到

- `translation` 插件当前只 `inject: ['llm', 'llmCodexAuth']`（`translation/index.ts:18`），拿不到 `vfsRepo` 服务。按 boundaries 的 cross-plugin-impl 规则，`translations.ts` 不能 import `vfs-repos/repository/*` 实现，也不能自己 new `TranslationRepo`（会丢 F4 deviceId）。
- 当前生产调用链：`TranslationToolExecutor.save` → `persistTranslation(conn, …)`（`tool_executor.ts:721-748`、`1068-1100`）→ `repository/translations.ts`。`ctx.vfs` 只提供 `getConnSafe`。另外 `toolExecutor` 经 `ctx.provide('translation')` 暴露，但 host 内**尚无**调用 `toolExecutor.save` 的生产点（rg 无结果）。这是 1.1 生产接线问题，归 L02/L03。
- 最小可行方案（需另批 hunk，不在当前窄路径）：
  - A（推荐）：`translation/index.ts` 增加可选依赖 `vfsRepo`，经 `ctx.reflect.get('vfsRepo', false)` 取得后调用 `bindTranslationOwner(vfsRepo.translations)`。`translations.ts` 导出该 binder 和委托函数，未绑定时显式抛 `DEPENDENCY_UNAVAILABLE`，不回落本地SQL。`tool_executor.ts` 不改。
  - B：把 `TranslationRepository` 作为 `TranslationToolContext` 字段传入，需要改 `tool_executor.ts` 签名和 L02 测试，冲突面更大。
- SW-0094 在 L11 发布 `updateTranslationMetadata` 之前不能委托。该项交 L11/C2。

### 16.5 授权后 `translation-owner.test.ts` 的断言清单（经生产入口 `TranslationToolExecutor.persistTranslation` / `persistTranslationMetadata`，用真实 L11 `vfsRepo` 服务）

1. 成功保存：`resources` 一行（hash = sha256(salt=`tr_id` ":" content)，`source_id`=tr_id，`source_table`='translations'，`storage_mode`='inline'，`ref_count`=0），`translations` 一行（`local_version`=1，`device_id`=F4 deviceId，`metadata_json` NULL），`folder_items` 一行（item_type='translation'，sort_order=0）。
2. 根目录保存：`folderId` 省略时 `folder_items.folder_id` 为 NULL（验证 undefined→null 转换）。
3. 文件夹不存在：抛 FOLDER_NOT_FOUND 映射，三张表无残留（外层 SAVEPOINT 回滚）。
4. 内层失败（例如 translations 插入约束失败）：resources 无孤儿行（M-090）。
5. 调用方已持有外层事务时可嵌套，外层回滚后全部撤销。
6. 返回对象：省略 null 可选键，含 `sourceText`/`translatedText`，`createdAt`===`updatedAt`，RFC3339 毫秒 Z。
7. metadata 写入：只改 `metadata_json`，`local_version`/`updated_at` 不变；缺失 id 时抛 "translation row tr_missing not found for metadata update"。（SW-0094，依赖 L11 新方法）
8. 未绑定 owner：显式抛错，**不**执行任何本地SQL（rg 断言 `translations.ts` 无 INSERT/UPDATE）。
9. 日志：L11 补齐后断言 `[VFS::ResourceRepo] Created new resource`、`[VFS::TranslationRepo] Created translation` 的级别和字段。
10. 现有 `tool_executor.test.ts:429-463` 的断言保持不变并继续通过（不弱化）。

### 16.6 待决

- 架构师：批准窄路径授权，并在 16.4 A/B 中选一个，A 需额外批准 `translation/index.ts` 精确 hunk。
- L11/C2：发布 `updateTranslationMetadata` same-conn 方法，补齐 16.3-5 中的日志。
- L02：保留流/模型主线。授权前如果 L02 改了 `repository/translations.ts` 或 `src/tool_executor.ts`，U2 暂停。
- R1：复验，U2 不自签。

### 16.7 C1 回执后的修订（取代 16.4 方案 A 的模块全局 binder）

C1 要求不用模块全局 `bindTranslationOwner`，避免多个 Host 实例共用同一个 owner。下面按 Context / 每实例传递依赖重新设计。本节只是方案，未写任何 Host 文件。

**依赖来源对照 Rust**：Rust `TranslationToolExecutor` 是无状态单元结构体（`translation_executor.rs:938-943`）。VFS 通过每次调用的 `ExecutionContext.vfs_db` 进入，repo 是静态函数，缺 `vfs_db` 时报 `DEPENDENCY_UNAVAILABLE`（`:1349-1356`）。TS 的 L11 `TranslationRepo` 是带 F4 deviceId 的实例，因此 owner 应和 `vfs` 一起放在每次调用的 `TranslationToolContext` 里，不放在模块状态里。

**推荐（Context）——需要另批的精确 hunk，全部在 L02 拥有的 `host/plugins/translation/src/tool_executor.ts`：**

```diff
@@ export interface TranslationToolContext {  // tool_executor.ts:761-768
   vfs?: Pick<VfsDatabase, 'getConnSafe'> | null;
+  /** vfsRepo.translations + resources owner (L11)，与 vfs 同属 Rust ExecutionContext.vfs_db。 */
+  vfsTranslations?: Pick<TranslationRepository, 'createTranslationInFolder'> & TranslationMetadataOwner | null;
@@ save(...)  // tool_executor.ts:1072-1080
-    if (!ctx.vfs) {
+    if (!ctx.vfs || !ctx.vfsTranslations) {
       throw translationFailure('DEPENDENCY_UNAVAILABLE', 'VFS database is not available.', …);
@@ :1088
-      translation = persistTranslation(conn, resolved, args);
+      translation = persistTranslation(ctx.vfsTranslations, conn, resolved, args);
@@ :1106
-      persistTranslationMetadata(conn, translation.id, persistedMetadata);
+      persistTranslationMetadata(ctx.vfsTranslations, conn, translation.id, persistedMetadata);
@@ persistTranslation / persistTranslationMetadata 及 static 包装（:721-748、:1163-1173）
+  首参增加 owner，透传给 repository/translations.ts；folderId `undefined → null`。
@@ mapSaveError (:692-718)
+  同时识别 L11 `VfsRepositoryError`：code==='VFS_NOT_FOUND' 且 details.resourceType 小写为 'folder'
+  → FOLDER_NOT_FOUND（"Folder not found: {id}"，retryable=false），对应 Rust `eq_ignore_ascii_case("folder")`。
```

- 为什么必须改 `mapSaveError`：L11 `createTranslationInFolder` 对缺失 folder 抛 `VfsRepositoryError('VFS_NOT_FOUND', 'Folder not found: {id}', {resourceType:'Folder', id})`（`vfs-repos/repository/attachment-utils.ts:79`），**不是** `vfs/api` 的 `VfsError`。如果不改，缺 folder 会降级为 `TRANSLATION_SAVE_FAILED`（retryable=true），破坏原错误语义。这是委托中唯一需要更大调用点的地方，hunk 如上。
- `index.ts` 在 Context 方案下**不用改**：Host 里目前没有生产代码构造 `TranslationToolContext`（16.4 已记录 rg 结果），由将来接线的调用方（L02/L03）从注入的 `vfsRepo` 填 `vfs` 和 `vfsTranslations`。C1 已补报的 index.ts 注入 hunk 在本方案下可以撤回；如果架构师偏向下面的每实例方案，再使用它。
- 备选（每实例）：`index.ts` 执行 `new TranslationToolExecutor({ vfsTranslations: () => (ctx.get('vfsRepo') as VfsReposService | undefined)?.translations })`，每次调用取 getter，避免 apply 时捕获的服务过期。需要改 index.ts 和 executor 构造函数两处。

**`repository/translations.ts` 改造后（本窄路径内）**：只保留 owner 委托和类型转换，不保留任何 INSERT/UPDATE SQL，也不提供可选的伪 provider 或本地回落。`getTranslation`（读，测试用）改用 owner 的 `getTranslation` 或删除，同时把 `tool_executor.test.ts:19/443` 的读法改成 L11 owner，这一处需要 L02 测试授权。

**保持的事务/错误/日志顺序（由 L11 实现承担，委托层不重复）**：
1. 外层 `SAVEPOINT create_translation_in_folder`，创建失败时 warn "Failed to create savepoint …" 并抛 Database 错误。
2. 如果给了 folderId：`folderExists`，不存在则抛 NotFound(Folder)。不写任何行。
3. `contentJson`（纯计算，在内层 savepoint 之外，对应 Rust `:384-390`）→ 内层 `SAVEPOINT create_translation` → `createOrReuseWithHash`（INSERT OR IGNORE，复用路径查 hash）→ `INSERT translations`（local_version=1，device_id=F4）→ `RELEASE create_translation`。
4. `addItemToFolder`：先 `DELETE` (item_id,item_type)，再 `INSERT OR REPLACE`。
5. `RELEASE create_translation_in_folder`。任一步出错时依次执行 `ROLLBACK TO` 和 `RELEASE`，两步分开、各自吞错，最后抛原错误（对应 Rust `:101-105`）。
6. 元数据写入在保存成功、缓存消费之后才执行，失败时只把 `metadata_persisted` 设为 false。Rust 在这里 `log::warn!`（`:1416`）"Failed to persist translation metadata for {id}: {error}"，而当前 TS `tool_executor.ts:1108` 的 `catch {}` **没有对应 warn**，属于 v2 §1.4 缺口，交 L02，不在本窄路径内。

### 16.8 固化的原语义向量与接缝需求（对应 16.5 的 10 条，授权后逐条实现，不新造SQL）

| # | 向量（输入 → 期望） | Rust 依据 | 接缝 |
|---|---|---|---|
| V1 | 合法 params、folderId 省略 → resources/translations/folder_items 各 +1；`resources.hash`=sha256(`tr_id`+":"+content)，`source_id`=tr_id，`source_table`='translations'，`storage_mode`='inline'，`ref_count`=0；translations `local_version`=1，`device_id`=F4 值，`metadata_json` NULL；folder_items `folder_id` NULL，`item_type`='translation'，`sort_order`=0 | translation_repo.rs:392-436、resource_repo.rs:850-857 | Context `vfsTranslations` = 真实 L11 服务 |
| V2 | folderId=已存在 → folder_items.folder_id=该 id | :1095-1112 | 同上 |
| V3 | folderId=不存在 → FOLDER_NOT_FOUND，retryable=false，三表计数不变 | :1097-1103、executor :1316-1326 | 需要 16.7 的 mapSaveError hunk |
| V4 | 内层 INSERT translations 失败（预置同 id 触发约束）→ 原错误，resources 无孤儿行 | M-090 :379-392 | 真实 L11 + 真实 sqlite |
| V5 | 调用前外层 `BEGIN`，保存成功后外层 `ROLLBACK` → 三表全部撤销（SAVEPOINT 可嵌套） | :1085-1087 注释 | 真实 conn |
| V6 | 返回值：不含 null 可选键（title/engine/model/qualityRating/metadata），含 sourceText/translatedText，createdAt===updatedAt，RFC3339 毫秒 Z | types.rs:503-543 skip_serializing_if | L11 返回值 |
| V7 | metadata 写入 → 只有 metadata_json 变化，local_version/updated_at 不变；缺失 id 时抛 "translation row tr_missing not found for metadata update" | executor :1293-1311 | 依赖 L11 新面 `updateTranslationMetadata` |
| V8 | `ctx.vfsTranslations` 缺失 → DEPENDENCY_UNAVAILABLE，不执行 SQL（conn spy 0 次 run/exec） | executor :1349-1356 | Context 字段 |
| V9 | 日志：`[VFS::ResourceRepo] Created new resource`（info）、`[VFS::TranslationRepo] Created translation`（info）、`… in folder`（debug），以及 metadata 失败时的 warn | resource_repo.rs:164、translation_repo.rs:438/1115、executor :1416 | 依赖 L11 补日志、L02 补 warn |
| V10 | 现有 `tool_executor.test.ts:429-463` 断言不减少 | — | 读法改为 owner（需 L02 测试授权） |

双 Host 隔离（C1 关注点）：两个 L11 实例使用不同 deviceId，同一 executor 两次 save 分别传入不同 Context，两行 `device_id` 应各自对应。只有 Context/实例传递能通过这条，模块全局 binder 必然失败。这条作为 V11 加入测试。

当前没有代码改动，按 C1 指示不跑前端门禁；前端既有签收不变。等待架构师授权（含 16.7 的 tool_executor.ts hunk 归属）和 L11 `updateTranslationMetadata` 回执。

## 17. 续派核对（合并 main ad11a8394）

- `lane-gate.mjs` 在 `6fd89fd57` 上自检 2 项（typecheck、boundaries）全部通过。
- F1：已完成，证据见 §14、§15，等待 R6 复验与集成门禁。
- X6-SW-0092..0094：仍处于授权前只读阶段（§16），阻塞于架构师授权（含 tool_executor.ts hunk 归属）和 L11 `updateTranslationMetadata`。本 lane 没有可以自行推进的剩余事项。

## 18. L02 调用点候选 c2d193f13 只读核对（授权前）

L02 按 §16.7 Context 方案在 `ds-mig/L02-llm-manager` 交付了 `c2d193f13`（实现位于 ab954d6f9/61c67e84f/5984554e1/d45ec91e1）。U2 只读核对结果：

- `tool_executor.ts`：`TranslationToolContext.vfsTranslations`（:780）；缺失时与 vfs 同报 DEPENDENCY_UNAVAILABLE（:1087）；`persistTranslation(ctx.vfsTranslations, conn, …)`（:1103）和 `persistTranslationMetadata(…)`（:1122）使用同一个 conn。`mapSaveError` 能识别 `VfsRepositoryError` VFS_NOT_FOUND/Folder（:698）。metadata 失败时补了 warn "[TranslationToolExecutor] Failed to persist translation metadata for {id}: …"（:1125，对应 Rust :1416）。§16.7 的 hunk 已由 owner 自行落地，U2 不重复实现。
- 该分支的 translation 目录下已经没有生产代码 import `repository/translations.ts`。`714d4c8c2..c2d193f13` 期间这个文件没有变化，U2 预留文件也未被触动。
- 仍待解决：L11 `updateTranslationMetadata(conn, id, JsonValue)` 尚未发布（L02 用 pending 夹具，TESTMAP 仍是 pending）；save 的生产调用方/中央链还没接（L02 未声明已接）。

授权后的 U2 窄单元因此缩小为：处理已无生产 import 的 `repository/translations.ts`（删除复制的 SQL 和 decoder，即 SW-0092..0094 与 UD-0086），加上 `translation-owner.test.ts` 的 V1–V11。V3/V7/V8/V11 已由 L02 的调用点覆盖到入口一侧，U2 的测试只补 owner 一侧的数据库副作用断言，不重复 executor 测试。删除还是改成薄委托，由授权方裁定；倾向删除，因为已经没有消费者，保留只会留下第二个写入入口。授权前继续只读。

## 19. L11 metadata owner 候选已实现（C1 依赖证据更新）

本节更新§16–18中的历史阻塞描述：metadata owner 面**已实现并发布候选，尚未进入main**，不再记为“尚未实现”。只读核对：

- 实现 `b3a999135`：`host/plugins/vfs-repos/repository/translations.ts:448-452`，公开接口检查点 `f55aedcee`：`host/plugins/vfs-repos/types/content.ts:515`；说明提交 `87b5ab5be`。
- 正式调用：`ctx.vfsRepo.translations.setMetadataJsonOnlyWithConn(conn, translationId, metadataJson: string): void`。此名称与string入参取代此前暂拟的 `updateTranslationMetadata(conn, id, JsonValue)`，不要求L11再提供一套别名。
- 实现仅执行 `UPDATE translations SET metadata_json = ?1 WHERE id = ?2`，不改 `updated_at` / `local_version`；0行抛原 `Error("translation row {id} not found for metadata update")`，SQL异常不包装。调用方负责序列化metadata，仍保留保存→缓存消费→尽力写metadata的原顺序。
- C1亲取作业（回执短号 `144515-dfd4f5`）：两文件15项通过、退出0；此处为C1提供的验证证据，U2未重跑，也不将候选通过等同main集成通过。
- 后续最小接入保留每次 `TranslationToolContext.vfsTranslations` 传递owner/同conn，不做模块binder。正式字段名和metadataJson字符串接缝须由L02在其单编辑的 `tool_executor.ts` 对齐；U2不重复改调用点、不新造provider或SQL。

当前剩余阻塞是Host修改授权与候选正常合入main，不是L11未实现。本消息不授予Host编辑权限；本轮仅更新允许的审计文件，未改Host、golden或重跑已签前端检查。
