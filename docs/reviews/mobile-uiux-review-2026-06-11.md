# 移动端 UI/UX 全面审阅报告（2026-06-11）

> 审阅范围：全项目所有页面的移动端 UI/UX 设计，模拟真实用户使用路径，对比移动端与桌面端设计风格差距，识别违反用户心智的设计点。
> 方法：逐文件代码审阅 + 用户路径模拟推演。边审阅边记录，持续更新。
> 状态：五轮深审完成（架构 → 页面/组件 → 输入与全局行为 → 手势/性能/查看器 → 拖拽/编辑器/扫尾），共 65 项问题（4×P0 / 18×P1 / 27×P2 / 16×P3）。§7 修复路线图、§8 P0 详细设计、§9 真机验证清单。

---

## 0. 移动端架构概览（审阅基础）

| 构件 | 文件 | 角色 |
|---|---|---|
| 移动断点 | `src/config/breakpoints.ts` + `useBreakpoint` | `< md` 即视为移动端（`isSmallScreen`） |
| 顶栏 | `src/components/layout/UnifiedMobileHeader.tsx` | 固定顶栏 56px + 安全区，App.tsx 级渲染，z-[1100] |
| 顶栏配置 | `MobileHeaderContext` | 各页面通过 context 注入标题/返回/菜单/右侧按钮 |
| 推拉布局 | `src/components/layout/MobileSlidingLayout.tsx` | DeepSeek 风格三屏滑动（左侧栏/主内容/右面板） |
| 抽屉内 App 导航 | `src/components/layout/MobileSidebarNavigation.tsx` | 5 项：chat-v2 / skills-management / learning-hub / task-dashboard / settings |
| 底部 TabBar | `src/components/layout/BottomTabBar.tsx` | ⚠️ **死代码：从未被渲染** |
| 设置页（移动端） | App.tsx `mobileSettingsSheetOpen` | 以底部 Sheet（86dvh）形式呈现，不是独立页面 |
| 全局返回 | App.tsx `unifiedGoBack` | 顶栏左侧全局返回按钮 |

移动端页面承载方式：所有视图仍由 App.tsx 的 `renderViewLayer` 渲染（视图保活 + visibility 切换），移动端没有独立路由栈。

---

## 1. 架构级问题（P0/P1）

### A-1【P1·一致性】BottomTabBar 是死代码，但其布局变量仍渗透在多处
- `BottomTabBar.tsx` 完整实现了底部 Tab 导航（注释声称"5个主要Tab：聊天、Anki、学习资源、技能、设置"），但全仓库无任何 JSX 渲染点。
- 配套的 `MOBILE_LAYOUT.bottomTabBar`、`getBottomTabBarHeight`、`--mobile-bottom-bar-height` CSS 变量、`MobileSlidingLayout` 中的 `enterFullscreen`（注释称"hide the global bottom tab bar"）等逻辑仍然存活。
- App.tsx 主区域注释还写着"移除 pb-16: InputBarUI 已通过 bottom: 64px 处理底部导航间距"。
- 风险：(1) 后续维护者会被误导；(2) 若有组件仍按"底部有 56px TabBar"预留 padding，移动端会出现无意义的底部空白（待逐页核实）。

### A-2【P0·信息架构】移动端导航入口不全：「待办」「模板管理」两个一级功能无法到达
- 桌面侧边栏 7 项：chat-v2、learning-hub、todo、skills-management、task-dashboard、template-management、settings。
- 移动端抽屉导航（MobileSidebarNavigation）只白名单了 5 项，**缺 `todo`（待办）和 `template-management`（模板管理）**。
- BottomTabBar（死代码）同样只有这 5 项。
- 后果：移动端用户完全无法使用待办功能；通过 `canonicalizeView` 看，todo 是合法视图，桌面创建的待办移动端看不到 → 跨端功能对等性破坏，违反用户心智（"我在电脑上用的功能手机上找不到了"）。

### A-3【P1·一致性】移动端与桌面端导航顺序不一致
- 桌面：聊天 → 学习资源 → 待办 → 技能 → 制卡任务 → 模板 → 设置。
- 移动：聊天 → **技能** → 学习资源 → 制卡任务 → 设置（`MOBILE_SIDEBAR_NAV_ITEMS` 硬编码顺序）。
- 同一用户跨端使用时，心智模型中"第二个是学习资源"在移动端变成"技能管理"，增加定位成本。
- BottomTabBar 注释里写的顺序（聊天、Anki、学习资源、技能、设置）又是第三种顺序，进一步说明导航 IA 缺乏单一事实源。

### A-4【P2·架构】移动端无独立路由栈，依赖视图保活 + 自定义事件
- 导航通过 `window.dispatchEvent(MOBILE_APP_NAVIGATE_EVENT)` 自定义事件实现，而非统一的导航 API。
- 全局返回按钮 `unifiedGoBack` 的行为来自自维护的历史栈（`useNavigationHistory`，内存数组，初始为 chat-v2）。

### A-5【P0·平台心智】Android 系统返回键/返回手势完全未接管 → 任意页面一划即退出 App
- 全前端无 `popstate`/`backbutton` 监听（仅 mcp-debug 调试工具有 popstate）；`MainActivity.kt` 只有 `enableEdgeToEdge()`，未覆写返回行为。
- 应用不使用浏览器 history（视图切换不 pushState），Tauri 默认行为是 WebView history 可退则退、否则结束 Activity。本应用 WebView history 恒为空。
- 后果：用户在「聊天 → 学习资源 → 打开 PDF 深层页」按系统返回手势，预期回上一屏，实际**直接退出应用**。这是 Android 用户最高频手势，属最严重的心智违背。应用内自建的 `unifiedGoBack` 历史栈与系统返回完全脱钩。

### A-6【P1·一致性】「移动端」判定标准多达 4 种，640-768px 区间行为撕裂
- `useBreakpoint().isMobile` = `<640px`；`useBreakpoint().isSmallScreen` = `<768px`；`useIsMobile()` = `<768px`（与前者同名不同义）；`InputBarUI` 另有 UA 嗅探 `isMobileEnv`（`/android|iphone|ipad|ipod|mobile/`）+ `INPUT_BAR_CONFIG.breakpoints.mobile=768` 的窗口宽度判断。
- `MobileLayoutContext.isMobile` 实际取的是 `isSmallScreen`（<768），与 `useBreakpoint().isMobile`（<640）同名异义，极易写错。
- 拍照按钮等能力按 UA 判断、布局按宽度判断：768px 以上的 Android 平板会得到桌面布局+移动能力的混合态，640-767px 的桌面窗口会得到移动布局。

### A-7【P0·信息架构】两套移动端抽屉导航入口集合不一致（非对称导航）
- 通用抽屉 `MobileSidebarNavigation`：chat-v2 / skills-management / learning-hub / task-dashboard / settings（无 todo、无 template-management）。
- 聊天页抽屉（`SessionSidebarContent`，`showSidebarAppNavigation=false` 关掉了通用导航）自带主入口：新对话 / **学习资源** / **待办** + 底部设置 —— 有 todo 但没有 skills/task-dashboard/template。
- 后果：**「待办」只能从聊天页抽屉进入**；在待办页打开抽屉（TodoSidebar + 通用导航）后，导航列表里没有「待办」自身，当前位置无高亮，用户"迷路"；想去「技能管理」必须先离开聊天页。入口在哪取决于你现在在哪 —— 典型的非对称导航反模式。
- 同理「模板管理」在移动端任何抽屉中都无入口，只能靠桌面端记忆 + 全局返回历史偶然抵达。

### A-8【P1·体验】Learning Hub 未复用 MobileSlidingLayout，自行复制了一份三屏手势实现
- `LearningHubPage.tsx` L352-547 手写第二份拖拽/轴锁/阈值逻辑，与 `MobileSlidingLayout` 行为细节不一致：
  - 抽屉宽度：ChatV2 固定 304px；LearningHub `containerWidth/2*1.15`（≈57.5% 屏宽）；Todo `'auto'`（全屏-60px peek）；Settings 待核实。**三个核心页面三种抽屉宽度**，滑出体验不统一。
  - 手势忽略列表不同：LearningHub 忽略 `.ProseMirror/.react-pdf__Page/.mindmap-canvas` 等内容组件，MobileSlidingLayout 只忽略表单/按钮类。在聊天页消息区横滑（如选中文本）可能误触发屏切。
  - LearningHub 版无鼠标拖拽支持、无 fullscreen claim 管理。

---

## 2. 聊天页（chat-v2）移动端审阅

### C-1【架构】三屏滑动布局（左:会话列表 / 中:聊天 / 右:资源面板）
- `ChatV2Page.tsx` L986-1077：移动端用 `MobileSlidingLayout`，`showSidebarAppNavigation={false}`，由 `SessionSidebarContent` 自带导航（见 A-7）。
- 右屏复用为三种内容：沙箱工作台 / 打开的资源 App / LearningHubSidebar(canvas 模式)，由 `screenPosition==='right'` 时按条件渲染——同一手势（左滑）在不同状态下到达完全不同的面板，内容可预期性差。

### C-2【P1·可用性】发送按钮禁用原因在移动端不可见
- `InputBarUI.tsx` L2733-2735：禁用原因通过 `CommonTooltip` 提示，但 `disabled={... || isMobile || ...}` 在移动端明确关闭 tooltip，又无 toast/inline 提示兜底。
- 场景：附件还在解析、队列已满、模型未选 → 按钮灰掉，移动端用户完全不知道为什么不能发送（违反"系统状态可见性"）。

### C-3【P2·硬编码】聊天侧边栏主入口文案未走 i18n
- `SessionSidebarContent.tsx` L292-294、303-307：「新对话」「学习资源」「待办」「设置」「未分类」「最近」为硬编码中文，英文环境下混排。

### C-4【P2·一致性】聊天页抽屉无当前页指示
- `renderPrimaryItem('learning-hub'|'todo', ..., active=false)` 恒为非激活态；抽屉里也没有「聊天」这一项本身，用户无法从导航中确认当前位置。

### C-8【P1·功能失效】划词工具栏（复制/AI解释/翻译/加入聊天）移动端不工作
- `useTextSelection.ts` 仅监听 `document.mouseup/mousedown`，未监听 `selectionchange`/touch 事件。
- 移动端长按选词、拖动选择手柄都不产生 mouseup → 工具栏不弹出。消息正文虽可选择（selection.css 白名单），但选完没有任何应用级操作浮层；划词解释/翻译这两个核心学习功能在移动端整体缺失（入口失效，ExplainPopover/TranslationPopover 无从触达）。
- 雪上加霜：长按选词后**拖动选择手柄**的 touch 序列会被 `MobileSlidingLayout` 手势捕获（文本节点不在 INTERACTIVE_SELECTOR 内），横向拖动手柄 → 轴锁定 horizontal → `preventDefault` → 手柄拖不动、屏幕开始平移。移动端文本选择体验整体崩坏。

### C-9【P1·手势冲突】内层横向滚动内容被三屏手势劫持
- `MobileSlidingLayout` 的 touch 监听绑在布局根容器上，轴判定（横向位移 > 1.2×纵向）一旦成立即 `preventDefault` 接管。
- 聊天消息中的**代码块（pre overflow-x-auto）、宽表格（.table-wrapper）、变体卡横滑区（ParallelVariantView）**都是内层横向滚动区域，且均不在 `INTERACTIVE_SELECTOR` 白名单中、也未做 `stopPropagation`/`data-gesture-ignore`——用户在代码块上横滑想看长行 → 实际整屏被拖去会话列表/资源面板。横向内容越多（学习场景常见），误触越频繁。
- 同时发现：`edgeWidth` prop（声明默认 20px、ChatV2Page 显式传 20）在组件实现中**从未被读取**——"仅边缘触发"的设计意图从未生效，手势实际全屏热区，加剧上述冲突。

### C-11【P2·键盘心智】移动端软键盘 Enter 直接发送，无法输入换行
- `shouldSendOnEnter` 默认 `mode='enter'`：Enter 发送、Shift+Enter 换行。移动软键盘**没有 Shift+Enter** → 移动用户无法在消息中换行（多段长问题是学习场景常态）。
- 若用户在设置中切到 Cmd/Ctrl+Enter 模式，移动端 `metaKey/ctrlKey` 恒为 false → Enter 变纯换行、只能点按钮发送（行为可接受但设置文案对移动用户无意义）。
- 建议：触屏环境默认 Enter=换行、发送只走按钮（与微信/Telegram 移动端一致），或在输入栏长按发送键提供选项。

### C-10【P1·误导控件】移动顶栏"对话控制"按钮点击后什么都不出现
- `useChatPageLayout` 顶栏右侧 SlidersHorizontal 按钮：`setShowChatControl(true) + setSessionSheetOpen(true)`。
- 但 `useSessionSidebarContent`（SessionSidebarContent.tsx L62-66）将 `showChatControl`/`setShowChatControl` **显式 `void` 弃用**，抽屉里没有任何对话控制面板的渲染分支。
- 实际效果：用户点"对话控制"→ 只是打开普通会话列表抽屉，参数控制功能不存在。按钮成为"按了没反应"的幽灵控件（遗留状态流，疑似旧版抽屉内嵌参数面板被移除后按钮未撤）。

### PERF-1【P2·性能】视图保活策略未区分端：移动端最多同时保活 8 个完整视图子树
- App.tsx `MAX_ALIVE_VIEWS = 8`（chat-v2 永久 pinned），桌面合理；低端 Android 上 8 棵完整 DOM/JS 子树（聊天+学习中心+设置+待办+…）常驻内存，影响流畅度与后台存活率。移动端建议降为 3-4。

### C-7【P1·操作不可达】会话项操作菜单触屏上基本打不开
- `SessionItemRenderer.tsx`：重命名/置顶/归档仅由 `AppMenu mode="context"`（onContextMenu）触发，无可见"…"按钮。
- 同一节点又挂着 `@hello-pangea/dnd` 的 `dragHandleProps`——触屏长按 ~120ms 优先启动拖拽并抑制 contextmenu。移动用户长按想改名 → 实际进入拖拽排序，操作菜单几乎永远出不来。会话管理（改名/置顶/归档）在移动端事实不可用。

---

## 3. 其余页面审阅

### 3.1 设置页（settings）
- **S-1【P1·主题割裂】移动端设置 Sheet 内容区硬编码亮色变量**：`Settings.tsx` L1484 `[--background:0_0%_100%] [--foreground:0_0%_7%] ...` 强制亮色；而 Sheet 外壳（App.tsx）用主题感知的 `--mobile-sheet-surface`。暗色模式下：Sheet 头部暗色、内容区白色，同一弹层上下两截两种主题。
- **S-2【P1·形态分裂】设置在移动端存在两种形态**：① 正常导航 → 底部 Sheet（86dvh、横向 chip tab rail）；② 桌面宽度缩窗到移动宽度（或平板旋转）→ 已保活的 settings 视图层以 `MobileSlidingLayout` 三屏页形式存在。同一功能两套移动 UI、两套交互（chip rail vs 左抽屉 tab 列表），用户在不同进入路径下看到不同的设置界面。
- **S-3【P2·双实例】`settingsContent` 与 `mobileSettingsSheetContent` 是两个独立的 `LazySettings` 实例，均注册 `useMobileHeader('settings')`，配置互相覆盖；状态（如展开的 vendor、正在编辑的模型）互不相通——用户在 Sheet 里改一半，旋转屏幕后进入 page 形态，编辑状态丢失。
- **S-4【P3】设置 Sheet 的 chip tab rail 横向滚动无渐隐提示，靠后的 tab（关于、快捷键等）可发现性差。**

### 3.2 制卡任务（task-dashboard）
- **T-1【P2·残留】`pb-20`（80px）底部 padding 仅为移动端保留**（L1067），疑似为已不存在的 BottomTabBar 预留，现状造成底部 80px 空白。
- **T-2【P2】移动端表格列裁剪合理（隐藏进度/时间列），但「状态/卡片数」列固定 60/40px，长状态文案（如"部分完成"）会截断；行内无法横向滚动（`isSmallScreen ? '' : 'overflow-x-auto'`）。**
- **T-3【P3】`suppressGlobalBackButton: true` —— 用户从聊天跳转制卡任务后，顶栏无返回，只能靠抽屉导航离开；与其他页面（可返回）心智不一致。**

### 3.3 技能管理（skills-management）
- 适配较完整：三屏（中列表/右编辑器）、顶栏返回箭头/菜单切换、`suppressGlobalBackButton` 在列表态。
- **K-1【P2】列表态 `suppressGlobalBackButton: true` + `showMenu: true`，编辑态切为返回箭头——但编辑态返回箭头点击是 `setScreenPosition('center')`，若用户经全局历史进入编辑态（保活恢复），返回箭头不会回到来源页面，与全局返回语义冲突。**

### 3.4 模板管理（template-management）
- **TM-1【P1·死代码】`TemplateManager.tsx`（1300+ 行，含 `useMobileHeader('template-management')` 注册与完整移动布局）全仓库无引用——与 `TemplateManagementPage` 重复实现，且 viewId 撞名，一旦误挂载会互相覆盖顶栏配置。**
- **TM-2【P2】移动端顶栏面包屑「Anki 制卡 > 卡片模板管理」中"Anki 制卡"是可点按钮但视觉与普通文本几乎一致（仅 hover 变色，移动端无 hover），可供性差。**
- 该页面移动端本身有三屏布局（左 tab 栏 / 中列表 / 右代码编辑器），结构尚可。

### 3.5 仪表盘 / 数据管理 / PDF 阅读器 / 沙箱（dashboard, data-management, pdf-reader, sandbox-workbench）
- **D-1【P1·顶栏空白】这四个视图均未注册 `useMobileHeader`** → 移动端进入后顶栏只有返回按钮 + 空标题，用户失去位置感。
- **D-2【P2】`Dashboard.tsx` 仅有 2 处响应式类（`sm:grid-cols-2 lg:grid-cols-4`），卡片/图表在 <640px 单列堆叠，未验证图表横向溢出；`DataCenter.tsx`/`DataImportExport` 完全无移动判断。**
- **D-3【P2】`features/pdf` 全目录无任何移动端断点/手势处理**（无 pinch-zoom 配置核实记录）；PDF 阅读体验在移动端未经设计。
- 沙箱 `SandboxWorkbenchSurface` 有 `compact={isSmallScreen}` 适配，但作为 chat-v2 右屏呈现时无 `useMobileHeader` 标题同步。

### 3.6 聊天消息（MessageItem）移动端
- 设计较好：移动端精简操作行（时间+紧凑按钮+更多菜单），头像/模型名隐藏。
- **M-1【P3】Token 用量在移动端完全无入口查看**（桌面有 `TokenUsageDisplay`），关心成本的用户无途径。

### 3.7 番茄钟（pomodoro）
- **P-1【P1·遮挡】全局悬浮药丸 `fixed bottom-6 right-6 z-50` 无安全区适配，且在聊天页与底部停靠的输入栏/发送按钮直接重叠**（输入栏同为底部 fixed），移动端可能挡住发送按钮。
- **P-2【P2·触控】药丸内按钮 `p-1.5`+14px 图标 ≈ 26px 触控目标，低于 44px 标准，移动端难点中（暂停/停止/沉浸三连按钮且彼此紧邻，误触率高）。**
- **P-3【P0 连带】番茄钟唯一入口在 Todo 页内嵌面板，而 Todo 在移动端导航不可达（见 A-2/A-7）→ 番茄钟功能移动端几乎不可用。**

### 3.8 Learning Hub 内容视图（notes 等）
- **N-1【P2·断点 off-by-one】`NoteContentView` 用 `useMediaQuery("(max-width: 768px)")`（≤768 含 768），App shell 用 `<768`。恰好 768px（iPad mini/Air 竖屏逻辑宽度）时：shell 按桌面渲染（无移动顶栏），笔记视图按移动渲染（隐藏桌面工具栏）→ 两头 UI 同时缺失。**（`NotesHome` 同样 `≤768` 与 `isSmallScreen` 混用于同一组件）
- **N-2【P2·功能剥夺】移动端笔记视图隐藏右侧大纲/元数据面板且无任何替代入口**：`NOTES_TOGGLE_OUTLINE` 命令在移动端被显式忽略（`if (!isActive || isSmallScreen) return`），也没有移动端按钮。大纲、标签编辑、创建/更新时间在移动端完全不可见。
- **N-3【P1·交互范式】Learning Hub 文件列表（fullscreen 模式 = 移动端中屏）打开文件需要"双击"**：`FinderFileItem` 单击仅选中、`onDoubleClick` 才打开；canvas 模式（聊天页右屏）已改为单击打开，但移动端主路径（Learning Hub 页）没改。移动用户没有双击心智，首次使用大概率"点了没反应"。
- **N-4【P1·不可达操作】文件"更多操作"按钮 `opacity-0 group-hover:opacity-100`，移动端无 hover 永远不可见**；重命名/移动/删除/收藏等只能靠长按触发 `onContextMenu`（无任何视觉提示长按可用）。
- **N-5【P2·触控目标】移动端文件工具栏按钮 28px（h-7 w-7）、canvas 导航返回/前进 24px（h-6 w-6）、面包屑 Home 仅 16px（!h-4 !w-4）**，全部低于 44px 推荐值且未用 `.touch-target` 扩大热区。
- **N-9【P2·功能缺失】文件拖拽整理在触屏上基本不可用**：`FinderFileList` 用 dnd-kit `PointerSensor`+`distance:8` 激活、无 `delay`、文件项未设 `touch-action:none` → 触屏按下后浏览器滚动优先（pointercancel），拖拽几乎无法启动；拖入文件夹/拖拽排序在移动端失效，唯一兜底是长按 contextmenu 的"移动到"（又受 N-4 可见性问题影响）。
- **DND-1【P2·范式分裂】两套拖拽库触屏行为相反**：会话/分组用 `@hello-pangea/dnd`（触屏长按 120ms 可拖，但吞掉 contextmenu→C-7）；文件用 `@dnd-kit`（触屏几乎不可拖→N-9）。同一 App 内"长按"在不同列表上含义完全不同，用户无法建立稳定心智。
- **N-6【P2】Office/图片预览工具栏 `modern-viewer-toolbar` 固定单行不换行不滚动**，docx 模式 9 个控件在 <400px 屏宽溢出裁切；缩放只有按钮 +/-，无 pinch 手势支持。
- **N-7【P3】`ExamSheetMobileLayout.tsx`（641 行"题目集识别移动端专用布局"）为死代码**，真实考试视图 `ExamContentView`（1258 行）无任何移动断点适配。
- **N-8【P3】`TextbookContentView`（教材 PDF）与 `ExamContentView`（题目集）无移动断点适配**；作文/翻译视图经核实其深层工作台（`GradingMain`/`TranslationMain`）有完整 isSmallScreen 适配（含移动端拖拽分隔），不在此问题内。

### 3.9 聊天输入栏面板体系
- **I-1【P1·范式不一致+死代码】`MobileBottomSheet`（带拖拽 snap/visualViewport 键盘适配的标准底部抽屉，282 行）只被 import 从未渲染**；所有输入栏面板（附件/模型/MCP/对话控制/技能）移动端沿用桌面 `ComposerPanelOverlay`（锚定 popover、无遮罩、`aria-modal=false`）。移动平台规范（iOS/Material）此类选择器应为 bottom sheet；现状=桌面范式直接搬到手机。
- **I-2【P2·键盘适配】`ComposerPanelOverlay` 用 `window.innerHeight` 计算可用空间，未用 `visualViewport`**；Android 键盘弹出时（视 softInputMode）面板可能被键盘遮住下半截。讽刺的是未被使用的 MobileBottomSheet 反而正确用了 visualViewport。
- **I-3【P3·层级】面板 `Z_INDEX.popover(1000)` < 移动顶栏 `1100`**，小屏（如 iPhone SE 667px 高）面板向上展开 maxHeight 500px 时顶端伸入顶栏区域被遮挡。

### 3.10 命令面板（CommandPalette）
- **CP-1【P2·不可达】移动端无任何入口**：触发途径只有桌面顶栏按钮、桌面标题热区、Cmd/Ctrl+K 快捷键，移动顶栏无入口 → 功能整体在移动端不存在（连带"强制保存笔记"等只在命令面板暴露的能力）。
- **CP-2【P3】命令面板 footer 的 ↑↓/Enter 键盘提示在移动端无意义且未隐藏；收藏按钮 hover-only，触屏不可用。**

### 3.11 全局 CSS / 工具类卫生
- **CSS-1【P2·死 CSS】`responsive-utilities.css` 的 `.responsive-table/.responsive-grid/.show-mobile/.hide-mobile/.responsive-button-group/.smooth-scroll` 等全部零引用**；`.touch-target` 仅 6 处使用（含 1 个测试），全项目几十个 <44px 小按钮均未受益。
- **CSS-2【P2·死 CSS】`ios-safe-area.css` 引用的 `.app-header/.chat-toolbar/.sidebar-content/.modern-sidebar/.app-main/.modal-header/.chat-input-form` 在 JSX 中均不存在**——整份文件除 `:root` 变量外几乎全部失效。安全区适配实际靠各组件手写 `var(--android-safe-area-*)`，无统一抽象。
- **CSS-3【P3】通知 toast `top: 12px+safe-area`，与移动顶栏（56px）重叠遮挡标题。**

### 3.11b 第三轮补查（输入/可达性/全局行为）
- **A11Y-1【P1·无障碍】全局禁用缩放且无替代**：`index.html` viewport 设 `maximum-scale=1.0, user-scalable=no`（Android WebView/WKWebView 会遵守）；同时 PDF/图片/Office 预览均无 pinch 缩放实现、应用内无全局字号设置。低视力用户在移动端**没有任何放大内容的途径**（WCAG 1.4.4 不满足）。`viewport-fit=cover` 与安全区配合是正确的。
- **GU-1【P2·可发现性】无首次使用引导，抽屉/手势零可供性提示**：聊天页左右滑动是核心导航，但无 edge 指示器、无引导动画、无 onboarding——新用户只能靠误触发现三屏结构。
- **H-1【P3】聊天页打开左抽屉时顶栏 `hidden` 卸载，但内容容器 `paddingTop: var(--mobile-header-total-height)`（App.tsx L2431）不变**，中屏顶部留 56px 空带（有遮罩压暗，可见度低但存在）。
- **H-2【P3·i18n】`UnifiedMobileHeader` 菜单按钮 `aria-label="展开侧边栏"` 硬编码中文**（同类问题再 +1）。
- **V-1【P3】语音输入按钮设计良好（长按说话+点按切换双模式、电平条反馈），但 `title` 提示含键盘快捷键文案，移动端无意义**；按钮高 32px 略低于 44px 标准。
- **SHELL-1【P3·残留】`DESKTOP_SHELL.mobileNavigationWidth=110` 在 isSmallScreen 时写入 `--sidebar-width:110px`**——移动端没有任何 110px 侧栏（第 4 代被弃方案残留变量）。
- **SC-1【P3】根级（html/body）未设置 `overscroll-behavior`**，Android WebView 整页下拉有 overscroll 辉光/回弹噪音；局部弹层已正确用 `overscroll-contain`。
- **IMG-1【P3】`InlineImageViewer`（消息内图片查看器）整体适配优秀**（44-48px 圆形按钮、sm: 阶梯、`data-no-drag` 正确隔离三屏手势——全库唯一主动隔离手势的组件），但缩放仅有按钮+滚轮，无 pinch 双指/双击缩放。
- **LS-1【P3】手机横屏无任何 landscape 适配**：高度 ~360px 时顶栏 56px+输入栏+键盘几乎占满视口；仅 ios-safe-area.css 有 landscape 媒询但其选择器全部失配（见 CSS-2）。
- **良性确认（正面发现）**：聊天页移动顶栏配置完整（会话名标题+汉堡+对话控制+新建，`useChatPageLayout`）；代码块复制按钮常显非 hover、`pre` overflow-x:auto；markdown 表格有 `.table-wrapper` 横向滚动；全局 `user-select:none`+内容白名单（native-feel）与 `-webkit-tap-highlight-color:transparent` 符合原生感；`GroupEditorPanel` 在移动端将 hover 显隐按钮改为 `opacity-100` 常显、`MessageItem` 操作栏用 `md:opacity-0 md:group-hover` 实现"移动常显/桌面悬停"（**全库仅这两处正确处理 hover 显隐**）；SessionBrowser/DataGovernanceDashboard/SandboxWorkbench/AttachmentPreview 均有响应式或 compact 适配；输入栏已实现 `capture="environment"` 拍照入口；UserAgreementDialog 94vw 自适应。

### 3.11c 笔记编辑器（Crepe/Milkdown）
- **NT-1【P3·死代码】`NoteEditorPortal` 在 App.tsx 常驻渲染但永不出内容**：依赖 `useNotesOptional()`，而 NotesProvider 已废弃未挂载（ChatV2Page 注释自证）→ context 恒 null → 永远 return null。连同 NotesHome/NotesSidebar(V2)/NotesTabsBar/NotesLibraryManager 构成完整的废弃 notes 体系仍在编译产物中。
- **NT-2【P2·触控目标+断点】真实笔记编辑工具栏（`NotesEditorToolbar`，由 NotesCrepeEditor 使用）移动端按钮 28px（1.75rem）**，且断点用 `@media (max-width:640px)` ——与 shell 的 768 断点再次不一致（640-768 区间：移动 shell + 桌面尺寸工具栏）。
- **NT-3【P2·待真机验证】Milkdown/ProseMirror 富文本编辑在移动 WebView 的浮动工具栏、slash 菜单、表格编辑、键盘弹出滚动定位等行为，静态审查无法确认**，列入真机验证清单（§9）。

### 3.12 待办（todo）模块补充
- **TD-1【P2】移动端详情为页内全屏覆盖层（absolute inset-0 z-40）**：打开后顶栏仍是列表标题+汉堡按钮，点汉堡会在详情层下打开抽屉，层级心智混乱；详情只能用内部关闭按钮退出（系统返回会退出 App，见 A-5）。
- **TD-2【P3】`useMobileHeader('notes', ...)` 注册的 'notes' viewId 已不是 canonical 视图**（NotesHome 已下线但保留），死注册。

---

## 4. 移动端 vs 桌面端设计风格差距

### 4.1 总体判断
桌面端有一套**完整且精细**的设计语言（study-shell 外壳体系、Notion 风格按钮/弹窗、统一的 `--shell-*` 设计令牌、40px 精确标题栏、热区/凹角/接缝处理、TextSwap 动效等），代码注释中大量引用 Notion/Linear/VS Code 的业界基准。
移动端则是**桌面体系的"裁剪适配"而非独立设计**：复用同一套设计令牌（好），但缺乏移动专属的范式层（差），具体表现：

| 维度 | 桌面端 | 移动端 | 评价 |
|---|---|---|---|
| 外壳 | titlebar(40px)+侧边栏+工作区圆角凹槽，细节极多 | 顶栏(56px)+推拉抽屉，无 tab 栏 | 移动端壳体简单但完成度尚可 |
| 导航 | 常驻侧边栏 7 项+命令面板+快捷键+历史前进后退 | 抽屉内 5 项（不全）+顶栏返回，无命令面板 | **功能不对等**（A-2/CP-1） |
| 选择器/面板 | popover 锚定（符合桌面范式） | 同样的 popover（违背移动范式，本应 bottom sheet） | **范式未切换**（I-1） |
| 弹窗 | NotionDialog 居中 92vw | 同样居中弹窗；仅设置页用了 Sheet | 不统一：Sheet 只有设置一处在用 |
| 触控/指针 | hover 驱动（操作按钮 hover 显现、tooltip 解释禁用原因） | hover 全部失效，无长按/可见替代 | **大量操作不可达**（N-4/C-2/CP-2） |
| 打开文件 | 单击选中+双击打开（Finder 范式） | 主路径仍是双击 | **范式未切换**（N-3） |
| 触控目标 | 24-28px 图标按钮（鼠标 OK） | 同样尺寸（16-28px），无 .touch-target | **低于 44px 标准**（N-5/P-2） |
| 字号 | 11-15px 桌面小字号体系 | 基本沿用（消息时间 10px、面包屑 12px） | 移动端偏小，10px 接近不可读 |
| 安全区 | 不适用 | 各组件手写 var(--android-safe-area-*)，约 10+ 处重复 | 无统一抽象，遗漏点多（如番茄钟） |
| 抽屉宽度 | 固定 272px 侧栏 | 304px / 57.5% / 半宽 / auto(全屏-60) 四种 | **同端不一致**（A-8） |
| 动效 | 200ms cubic-bezier 统一缓动 | 沿用 300ms transform | 基本一致（好） |
| 主题 | 全令牌化、亮暗完备 | 设置 Sheet 内容区硬编码亮色 | **唯一硬编码处恰在移动端**（S-1） |

### 4.2 风格差距结论
1. **移动端不是"被设计"出来的，而是"被兼容"出来的**：除 MobileSlidingLayout/三屏滑动这一个核心创新（DeepSeek 风格，质量不错）外，其余组件几乎都是桌面组件加 `isSmallScreen ?` 分支微调，没有系统性的移动 UI 规范（无 mobile design tokens、无最小触控目标、无 bottom-sheet 体系、无长按手势体系）。
2. **半成品的移动基建被遗弃**：BottomTabBar、MobileBottomSheet、ExamSheetMobileLayout、TemplateManager 移动布局、responsive-utilities 工具类、ios-safe-area.css ——大量"为移动准备"的代码处于死亡状态，说明移动端方向上有过至少两轮未完成的重构，当前代码库同时携带三代移动方案的残骸。
3. **桌面心智词汇直接出现在移动端**：tooltip、hover 显隐、双击、右键 contextmenu、键盘快捷键提示、Cmd+K——这些在移动端要么失效要么无意义。

---

## 5. 用户路径模拟与心智违背点

### 路径 1：Android 新用户首启 → 配置 API → 发起第一次聊天
1. 首启进入 chat-v2 空状态。顶栏只有空标题（chat-v2 未设置默认标题时）+ 无菜单提示 → 用户不知道左滑/点哪里能干嘛。**抽屉的存在缺乏可供性提示**（无 edge 指示、无首次引导）。
2. 要配 API Key：需要知道"左滑打开会话抽屉 → 底部设置"。设置入口藏在抽屉底部（聊天页），其他页面在抽屉中部列表——**入口位置不固定**。
3. 设置 Sheet 打开后是横向 chip rail，"模型服务"在第一位 ✓。配置 vendor → 弹 `VendorConfigModal`（Sheet 形态下是普通居中 Modal）→ 856px 高度的表单在 86dvh Sheet 上再叠 Modal，**双层弹层**，关闭顺序容易误触（点遮罩关 Modal 还是关 Sheet？）。
4. 配置完成回聊天 → 输入问题 → 发送。若模型未选/附件解析中，发送按钮灰色且**无任何原因提示**（C-2）。
5. 任意时刻误触系统返回手势 → **App 直接退出**（A-5），聊天上下文心理预期被打断。

### 路径 2：学生用户「上传 PDF → 提问 → 保存笔记 → 复习」
1. 聊天页点附件 → 附件面板（popover）→「资源库」打开右屏 LearningHubSidebar(canvas)。此处单击文件=添加 ✓。
2. 切到 Learning Hub 页浏览刚上传的 PDF：文件列表**双击才能打开**（N-3），单击只是高亮——用户必然困惑"点了没反应"。
3. 打开 PDF 后（右屏）想调整阅读：PDF 视图无 pinch 缩放设计（D-3），工具栏按钮 24-28px 难点中。
4. AI 回答想保存为笔记：消息"更多"菜单 → 保存笔记 ✓（compactMobile 设计良好）。
5. 想给笔记加标签/看大纲：移动端**无入口**（N-2）。
6. 复习：想用番茄钟 → 找不到"待办"页（A-2）→ 番茄钟不可达（P-3）。

### 路径 3：跨端用户（桌面常用，出门用手机）
1. 桌面上把"模板管理"用得很熟 → 手机上**完全找不到**（A-2）。
2. 桌面第二个导航项是"学习资源" → 手机抽屉第二项是"技能管理"（A-3），肌肉记忆失效。
3. 桌面在设置页深度编辑 vendor → 手机打开设置是另一种形态（Sheet vs 三屏页，S-2），且上次编辑状态不在（S-3）。
4. 桌面暗色主题 → 手机设置 Sheet 内容区是亮的（S-1），"是不是坏了？"
5. 桌面 Cmd+K 搜索一切 → 手机无命令面板（CP-1）。

### 路径 4：纯移动用户日常聊天
1. 多模型对比：变体卡横滑 + snap ✓（少数真正为移动设计的亮点）。
2. 聊天中左滑唤出资源面板时，竖向滚动消息列表偶发误触发横滑（MobileSlidingLayout 轴锁定 1.2 倍系数较宽松，且消息文本选择与手势抢占，INTERACTIVE_SELECTOR 不含文本节点）。
3. 番茄钟运行时悬浮药丸**压在输入栏发送按钮上**（P-1）。
4. 输入长文时键盘弹起：输入栏有 keyboardInset 处理 ✓，但打开模型面板时面板定位用 innerHeight，可能被键盘吃掉下半截（I-2）。
5. 会话改名/置顶/删除：依赖长按（contextmenu）或会话项的 hover 按钮——**移动端同样面临 hover 不可见问题**（待确认 SessionItemRenderer 具体实现，初步判断与 N-4 同模式）。

### 心智违背点汇总（Top 10）
| # | 违背点 | 用户预期 | 实际行为 |
|---|---|---|---|
| 1 | 系统返回手势 | 回上一屏 | 退出 App（A-5） |
| 2 | 单击文件 | 打开 | 仅选中，需双击（N-3） |
| 3 | 移动端找"待办/模板" | 导航里应该有 | 不存在（A-2） |
| 4 | 导航入口位置 | 全 App 一致 | 每页不同（A-7） |
| 5 | 灰色发送按钮 | 点击/提示告知原因 | 无任何反馈（C-2） |
| 6 | 暗色主题 | 全 App 暗色 | 设置 Sheet 内容亮色（S-1） |
| 7 | 文件操作 | 可见的"…"按钮 | hover-only 不可见（N-4） |
| 8 | 长按 | 出现操作菜单（有提示） | 无提示，靠猜（N-4） |
| 9 | 番茄钟药丸 | 不挡核心操作 | 盖住发送按钮（P-1） |
| 10 | 设置入口 | 固定可预期 | 聊天页在抽屉底、其他页在列表中（A-7） |

---

## 6. 问题清单汇总（按严重度）

| 编号 | 严重度 | 模块 | 摘要 |
|---|---|---|---|
| A-5 | P0 | 平台 | Android 系统返回键未接管，一划退出 App |
| A-2 | P0 | 导航 IA | 移动端无法访问「待办」「模板管理」 |
| A-7 | P0 | 导航 IA | 两套抽屉导航入口集合不一致（非对称导航） |
| P-3 | P0 | 番茄钟 | 因 Todo 不可达而连带不可用 |
| A-1 | P1 | 架构卫生 | BottomTabBar 死代码及残留布局变量 |
| A-3 | P1 | 一致性 | 移动/桌面导航顺序不一致 |
| A-6 | P1 | 一致性 | 4 种"移动端"判定标准并存 |
| A-8 | P1 | 一致性 | LearningHub 复制三屏实现，3 页面 3 种抽屉宽度 |
| C-2 | P1 | 聊天 | 发送禁用原因移动端不可见 |
| C-7 | P1 | 聊天 | 会话操作菜单（改名/置顶/归档）触屏不可达（contextmenu 与 dnd 长按冲突） |
| C-8 | P1 | 聊天 | 划词工具栏仅监听 mouseup，移动端解释/翻译功能整体失效 |
| C-9 | P1 | 手势 | 代码块/表格/变体卡横滑被三屏手势劫持；edgeWidth 是死参数 |
| C-10 | P1 | 聊天 | 顶栏"对话控制"按钮为幽灵控件（showChatControl 被 void 弃用） |
| C-11 | P2 | 聊天 | 移动软键盘 Enter 即发送，无法换行 |
| PERF-1 | P2 | 性能 | 移动端保活 8 视图子树，低端机内存压力 |
| IMG-1 | P3 | 图片 | InlineImageViewer 无 pinch/双击缩放（按钮+滚轮 only），其余适配优秀 |
| LS-1 | P3 | 横屏 | 手机横屏（高度~360px）无任何 landscape 适配 |
| S-1 | P1 | 设置 | Sheet 内容区硬编码亮色，暗色模式割裂 |
| S-2 | P1 | 设置 | 移动端两种设置形态并存 |
| TM-1 | P1 | 模板 | TemplateManager 1300 行死代码 + viewId 撞名 |
| D-1 | P1 | 顶栏 | dashboard/data-management/pdf-reader/sandbox 无顶栏标题 |
| P-1 | P1 | 番茄钟 | 悬浮药丸遮挡聊天输入栏、无安全区适配 |
| N-3 | P1 | 学习中心 | 文件列表移动端仍需双击打开 |
| N-4 | P1 | 学习中心 | 文件"更多操作"hover-only，触屏不可见 |
| I-1 | P1 | 输入栏 | 全部面板用桌面 popover，MobileBottomSheet 死代码 |
| C-3 | P2 | 聊天 | 侧边栏主入口硬编码中文 |
| C-4 | P2 | 聊天 | 抽屉无当前页指示 |
| S-3 | P2 | 设置 | 双 LazySettings 实例状态不同步 |
| T-1 | P2 | 制卡 | 移动端 pb-20 残留空白 |
| T-3 | P2 | 制卡 | suppressGlobalBackButton 导致返回心智不一致 |
| K-1 | P2 | 技能 | 编辑态返回箭头与全局返回语义冲突 |
| TM-2 | P2 | 模板 | 面包屑可点性可供性差 |
| D-2 | P2 | 数据 | DataCenter/DataImportExport 无移动适配 |
| D-3 | P2 | PDF | PDF 阅读器无移动端设计 |
| N-1 | P2 | 断点 | 768px 整数边界 off-by-one，iPad 竖屏双布局缺失 |
| N-2 | P2 | 笔记 | 大纲/标签/元数据移动端无入口 |
| N-5 | P2 | 学习中心 | 16-28px 触控目标矩阵 |
| N-9 | P2 | 学习中心 | 文件拖拽整理触屏不可用（PointerSensor 无 delay/touch-action） |
| DND-1 | P2 | 拖拽 | 两套拖拽库触屏行为相反，长按语义不稳定 |
| NT-2 | P2 | 笔记 | 编辑工具栏 28px 按钮 + 640px 断点不一致 |
| NT-3 | P2 | 笔记 | 富文本编辑触屏行为待真机验证 |
| NT-1 | P3 | 笔记 | NoteEditorPortal 死渲染路径（NotesProvider 未挂载） |
| N-6 | P2 | 预览 | 预览工具栏溢出裁切、无 pinch 缩放 |
| I-2 | P2 | 输入栏 | 面板定位用 innerHeight，键盘可能遮挡 |
| CP-1 | P2 | 命令面板 | 移动端无入口，整体不可达 |
| CSS-1 | P2 | CSS | responsive-utilities 大面积死 CSS，touch-target 仅 6 处使用 |
| CSS-2 | P2 | CSS | ios-safe-area.css 选择器全部失配，安全区无统一抽象 |
| TD-1 | P2 | 待办 | 移动详情覆盖层与顶栏/抽屉层级心智混乱 |
| P-2 | P2 | 番茄钟 | 触控目标 26px 过小 |
| A-4 | P2 | 架构 | 移动导航依赖自定义事件，无路由栈 |
| A11Y-1 | P1 | 无障碍 | user-scalable=no 全局禁缩放且无替代放大途径 |
| GU-1 | P2 | 引导 | 无 onboarding，抽屉/手势零可供性提示 |
| M-1 | P3 | 聊天 | Token 用量移动端无入口 |
| S-4 | P3 | 设置 | chip rail 无滚动提示 |
| N-7 | P3 | 考试 | ExamSheetMobileLayout 641 行死代码，ExamContentView 无适配 |
| N-8 | P3 | 教材 | Textbook/Exam 内容视图无移动适配（作文/翻译已适配） |
| H-1 | P3 | 顶栏 | 抽屉打开时顶栏卸载但内容 padding 不变，留 56px 空带 |
| H-2 | P3 | i18n | 顶栏菜单按钮 aria-label 硬编码中文 |
| V-1 | P3 | 语音 | 语音按钮 title 含快捷键文案、32px 高度略小 |
| SHELL-1 | P3 | 残留 | mobileNavigationWidth=110 死变量写入 --sidebar-width |
| SC-1 | P3 | 滚动 | 根级未设 overscroll-behavior |
| I-3 | P3 | 层级 | 面板 z-index 低于移动顶栏 |
| CP-2 | P3 | 命令面板 | 键盘提示/hover 收藏在触屏无意义 |
| CSS-3 | P3 | 通知 | toast 与移动顶栏重叠 |
| TD-2 | P3 | 待办 | 'notes' 死 viewId 注册 |

---

## 7. 修复路线图（建议）

### 阶段 0：止血（每项 ≤1 天，可独立上线）
| 项 | 修复 | 覆盖问题 |
|---|---|---|
| Android 返回键接管 | Tauri v2 安卓 `onBackPressed` → 注入 JS 调 `unifiedGoBack`；历史为空时再退出（或二次确认） | A-5 |
| 补齐移动导航 | `MobileSidebarNavigation`/`SessionSidebarContent` 统一改为消费 `createNavItems()`（与桌面同源同序） | A-2/A-3/A-7/C-4/P-3 |
| 文件单击打开 | `FinderFileItem` 在 `isSmallScreen` 时单击=打开（与 canvas 模式对齐） | N-3 |
| "更多操作"常显 | FinderFileItem/会话项增加常显 `…` 按钮（参照 GroupEditorPanel 的 `isSmallScreen ? opacity-100` 范例） | N-4/C-7 |
| 设置 Sheet 主题 | 删除 `Settings.tsx` L1484 的硬编码亮色变量块 | S-1 |
| 番茄钟药丸避让 | bottom 加 `env(safe-area-inset-bottom)` + 聊天页输入栏高度偏移；扩大按钮到 ≥40px | P-1/P-2 |
| 发送禁用提示 | 移动端禁用时点击触发 toast 说明原因（替代 tooltip） | C-2 |
| 撤掉幽灵按钮 | 移除顶栏"对话控制"按钮，或接回真实面板（输入栏对话控制 panel 已有同功能） | C-10 |

### 阶段 1：移动范式补课（1-2 周）
1. **选择器底部化**：让 `ComposerPanelOverlay` 在 `isSmallScreen` 时渲染为 `MobileBottomSheet`（组件已存在，激活即可），统一带遮罩+visualViewport。covers I-1/I-2/I-3。
2. **划词工具栏触屏化**：`useTextSelection` 增加 `selectionchange`（防抖）+ touchend 监听。covers C-8。
2b. **手势冲突治理**：`MobileSlidingLayout` 真正实现 `edgeWidth`（仅边缘 24px 起手）或检测起点是否在横向可滚动祖先内（`pre`/`.table-wrapper`/`[data-gesture-ignore]`）；给变体横滑容器加 `data-gesture-ignore`；选区激活（`getSelection().isCollapsed === false`）时挂起手势。covers C-9 + C-8 的手柄劫持。
3. **统一断点**：删除 InputBarUI 的 UA 嗅探与 `<640` 判定、统一 `NoteContentView` 等处为 `isSmallScreen`（`<768`）。covers A-6/N-1。
4. **触控目标审计**：把 `.touch-target`（44px 热区）应用到全部 <40px 的移动可点元素（文件工具栏/面包屑/番茄钟/预览工具栏）。covers N-5/P-2/V-1。
5. **缩放无障碍**：移除 `user-scalable=no`（或预览视图实现 pinch 缩放后保留）。covers A11Y-1/N-6/D-3。
6. **设置形态统一**：移动端设置只保留一种形态（建议全屏页，弃 Sheet），单实例。covers S-2/S-3。

### 阶段 2：死代码清理与体系化（持续）
1. 删除或激活：`BottomTabBar`、`TemplateManager`、`ExamSheetMobileLayout`、`MobileSheetHeader`、`NotesHome`、`responsive-utilities` 死类、`ios-safe-area.css` 死选择器、`mobileNavigationWidth`。covers A-1/TM-1/N-7/CSS-1/CSS-2/SHELL-1/TD-2。
2. 安全区统一抽象：以 `pb-safe`/`pt-safe` 工具类或 `MOBILE_SHELL` 常量统一，替换 10+ 处手写 `var(--android-safe-area-*)`。
3. 三屏布局归一：LearningHubPage 迁回 `MobileSlidingLayout`，统一抽屉宽度规范（304px）。covers A-8。
4. 移动顶栏全覆盖：为 dashboard/data-management/pdf-reader/sandbox 注册 `useMobileHeader`。covers D-1。
5. i18n 清理：SessionSidebarContent/UnifiedMobileHeader 硬编码中文。covers C-3/H-2。
6. 新用户引导：首启 coach-mark 提示左右滑手势与抽屉。covers GU-1。
7. 移动端性能预算：`MAX_ALIVE_VIEWS` 按端区分（移动 3-4）；评估保活视图的内存水位。covers PERF-1。
8. 查看器手势补全：InlineImageViewer/PDF/Office 预览统一加 pinch 双指缩放与双击放大。covers IMG-1/N-6/D-3。

### 不建议做的事
- 不要急于上 BottomTabBar：当前三屏滑动 + 抽屉的 IA 是自洽的，补全入口（阶段 0）后先观察；同时维护两套导航范式只会加剧不一致。
- 不要为 768-1024 平板区间新增第五种"中屏"分支：先把现有 4 种移动判定收敛成 1 种再说。

---

## 8. P0 修复详细设计

### 8.1 A-5：Android 系统返回键接管
**方案**（Tauri v2）：
1. `MainActivity.kt` 重写 `onBackPressed`（或注册 `OnBackPressedCallback`，兼容预测性返回手势）：
```kotlin
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this) {
      // 注入 JS：先询问 WebView 内部历史
      runOnUiThread {
        webView?.evaluateJavascript(
          "window.__handleSystemBack ? window.__handleSystemBack() : false"
        ) { handled ->
          if (handled != "true") { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
        }
      }
    }
  }
}
```
2. 前端在 App.tsx 挂 `window.__handleSystemBack`：
   - 有打开的弹层/抽屉/面板（Sheet、ComposerPanel、三屏非 center、移动详情覆盖层）→ 关闭它，返回 true；
   - `unifiedCanGoBack` → `unifiedGoBack()`，返回 true；
   - 都没有 → 返回 false（让系统退出，或弹"再按一次退出"toast）。
3. 关键点：需要一个**全局返回栈协调器**（registry 模式），各弹层挂载时注册 dismiss 回调（含优先级），避免 if-else 地狱。`suppressGlobalBackButton` 的现有语义可并入该协调器。

### 8.2 A-2/A-3/A-7：导航同源化
1. `MobileSidebarNavigation` 与 `SessionSidebarContent` 的主导航段全部改为渲染 `createNavItems(t)`（desktop 同源，7 项同序）。
2. `SessionSidebarContent` 删除自绘的「学习资源/待办/设置」按钮，改为底部固定一行「主导航」分组（或顶部 chips）。
3. 当前视图高亮：以 `useViewStore().currentView` 为准（canonicalizeView 后比较）。
4. 设置入口规则统一：所有页面的抽屉底部固定「设置」行（与聊天页现状一致），删除列表中段的设置项。
5. 验收：任一页面打开抽屉看到的导航集合、顺序、选中态、设置入口位置完全一致；todo/template-management 可达；GlobalPomodoroWidget 在 todo 可达后自然恢复价值（P-3 随之关闭）。

### 8.3 N-3/N-4：文件列表触屏交互
1. `FinderFileItem`：`isSmallScreen`（取自 useBreakpoint，与 shell 同源）时 `onClick` 直接 `onOpen()`；多选模式下单击=选中（保持）。
2. "更多"按钮：移动端 `opacity-100` 常显（复制 GroupEditorPanel 范例），点击打开 `AppMenu`（非 contextmenu 模式，定位到按钮）。
3. dnd-kit PointerSensor 增加 `delay: 250, tolerance: 8`（长按拖拽），与 hello-pangea 行为对齐（DND-1 一并收敛）。

---

## 9. 真机验证清单（静态审查无法确认，需在 Android/iOS 实机复核）

| # | 验证项 | 关联问题 |
|---|---|---|
| 1 | 系统返回手势是否如分析直接退出 App；Tauri v2 是否拦截 | A-5 |
| 2 | 长按会话项：实际触发拖拽还是 contextmenu（hello-pangea 触摸传感器时序） | C-7 |
| 3 | 代码块/表格/变体卡横滑实测：是否如分析被三屏手势劫持 | C-9 |
| 4 | 长按选词 → 拖动选择手柄是否被手势打断；选词后有无系统级菜单兜底 | C-8 |
| 5 | 键盘弹出：输入栏 keyboardInset 实测、ComposerPanelOverlay 是否被键盘遮挡 | I-2 |
| 6 | 文件列表触屏拖拽：dnd-kit 实际能否激活 | N-9 |
| 7 | Milkdown 编辑器：浮动工具栏/slash 菜单/表格在触屏的可用性、光标定位 | NT-3 |
| 8 | user-scalable=no 在目标 WebView（WKWebView/Android System WebView）是否生效 | A11Y-1 |
| 9 | 设置 Sheet + VendorConfigModal 双层弹层的遮罩点击/返回顺序 | S-2 |
| 10 | 通知 toast 与移动顶栏的实际视觉重叠程度 | CSS-3 |
| 11 | 保活 8 视图时低端机（2-4GB RAM）内存与掉帧实测 | PERF-1 |
| 12 | 横屏模式各页面实际可用性 | LS-1 |
