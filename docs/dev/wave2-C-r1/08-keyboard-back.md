# 0824 Wave2-C R1 · P8 扫描员台账：键盘与 Android back 链
- 扫描员：Wave2-C 第 1 轮「键盘与back链」（claude-fable-5-thinking-high）
- 方式：只静态审阅（未跑任何 npm/npx/node/tsc/vitest/tauri）
- 仓库：/workspace 只读
- 结论先行：**底座（useKeyboardHeight 单例 / androidBackCoordinator / mobileShell）结构健康，不需要重写**。全库 back 注册点 ~70 处已列全表；发现 2 个值得第 2 轮做「加法」的点（settings 双轨 useKeyboardInset、显式 overlay handler 与 Radix 兜底的错序风险），协调器本身无缺陷性错序。

---

## 1. 键盘 inset 分支表（Android / iOS）

底座：`src/hooks/useKeyboardHeight.ts`（模块级单例，visualViewport 驱动）。

| 值 | 定义 | Android（adjustResize） | iOS（overlay 键盘） | 来源行 |
|---|---|---|---|---|
| `keyboardHeight` | 基线视口高 − 当前 vv.height（>150px 阈值才判弹出） | ≈键盘高（WebView 被压缩，vv 同步缩小） | ≈键盘高 | L88-97 |
| `keyboardInset` | `documentElement.clientHeight − vv.height − vv.offsetTop`（仅键盘判定弹出时非零） | **≈0**（布局视口已随键盘收缩，避免双重抬升） | **≈键盘高**（布局视口不变） | L100-113 |
| `--keyboard-inset` CSS 变量 | `keyboardInset` 实时写到 document root（L48-51，`KEYBOARD_INSET_CSS_VAR`） | 0px | ≈键盘高 px | L38, L48-51 |
| `getLayoutViewportObscuredHeight()` | 不做阈值判定的实时遮挡值（Dialog paddingBottom 补偿用） | ≈0 | ≈键盘高 | L204-210 |

分支/守卫要点（全部在该文件内，静态可证）：
- 平台门控：`!isAndroid() && !isIOSLike()` 时不启用追踪（L124），桌面窗口 resize 不会误判；iOS 检测含 iPadOS 桌面 UA（MacIntel + maxTouchPoints，L54-63）。
- 宽度变化（旋转/分屏）重置基线并归零（L76-86）；iOS 只触发 vv `scroll` 的场景也监听（L130）。
- `ensureKeyboardTracking()` 由 `App.tsx` L1571 在壳层挂载时显式调用，防冷启动基线记成「键盘压缩后高度」。
- **调用方无需区分平台**——`useKeyboardInset()` 一个 API 覆盖两端，这是本模块的核心契约（文件头注释 L15-21）。

### 谁消费 keyboard height / inset

| 消费方 | 用哪个 API | 用途 |
|---|---|---|
| `src/features/chat/components/input-bar/InputBarUI.tsx` L327, L1086 | `useKeyboardInset()`（单例） | docked 输入栏 bottom 避让；焦点门控（仅 composer 内可编辑元素聚焦才抬升）；L1161-1163 与 safe-area 取 **max** 不叠加（M1 修复）；L2035-2048 把 `--unified-input-docked-height` / `--unified-input-keyboard-inset` / `--composer-dock-height` 写到 root 供消息列表/番茄钟药丸避让 |
| `src/features/chat/components/input-bar/ComposerInlinePanel.tsx` L51-54 | CSS `var(--keyboard-inset, 0px)` | 内联面板 `clamp(160px, calc(85vh - var(--keyboard-inset) - 180px), …)` 高度约束 |
| `src/components/ui/DsDialog.tsx` L162-165, L436-439 | `useKeyboardHeight()` + `getLayoutViewportObscuredHeight()` | 自绘 Dialog 键盘避让（keyboardAvoid） |
| `src/components/ui/shad/Dialog.tsx` L192, L233 | 同上 | shad Dialog paddingBottom 补偿 |
| `src/features/todo/components/TodoMainPanel.tsx` L103, L1046 | `useKeyboardInset()` + CSS `var(--keyboard-inset)` | 列表底部垫高（QuickAdd/行内编辑不被键盘盖住）；订阅同时保证单例启动 |
| `src/components/layout/MobileSlidingLayout.tsx` L893 | CSS `max(var(--mobile-safe-area-bottom), var(--keyboard-inset))` | 抽屉底部同时避让 safe-area 与键盘 |
| `src/App.tsx` L90, L1571, L1805 | `ensureKeyboardTracking()` + `shouldBlockMobileNavigation()` | 壳层启动追踪；Android 键盘弹出/输入聚焦期间拦截侧栏误导航（#113 bug1/3） |
| `src/features/settings/components/ShadApiEditModal.tsx` L50, L166 | ⚠️ **另一个** `useKeyboardInset`（`src/features/settings/hooks/useKeyboardInset.ts`，P2-15 旧实现） | 移动端面板避让 |
| `src/styles/transitions-dev.css` L273-275 | （文档契约）声明 `--keyboard-inset` 只能由 useKeyboardHeight.ts 写、CSS 侧只 var() 消费、勿重复声明 | — |

⚠️ 发现 #1（双轨实现，建议第 2 轮加法收敛）：`src/features/settings/hooks/useKeyboardInset.ts` 是独立的旧实现——阈值 80px（单例是 150px）、基于 `window.innerHeight`（单例用 `documentElement.clientHeight` + 最大基线）、无旋转基线重置、每组件自挂监听。唯一消费方是 ShadApiEditModal。语义上 Android adjustResize 下 innerHeight−vv.height 也≈0，方向不冲突，但阈值/抖动行为不一致。**建议**：让 ShadApiEditModal 改 import `@/hooks/useKeyboardHeight` 的 `useKeyboardInset`，旧 hook 保留 re-export 或删除（一行级加法迁移，不动底座）。

---

## 2. Android back 注册全链表

### 底座（不重写，只记事实）
`src/app/navigation/androidBackCoordinator.ts`：
- 链路：MainActivity OnBackPressedCallback → `window.__DEEP_STUDENT_HANDLE_BACK__()`（`installAndroidBackBridge()`，由 App.tsx L1567 安装）→ `handleAndroidBack()`。
- `BACK_PRIORITY = { overlay: 100, view: 50, navigation: 0 }`（L30-37）。
- 消费顺序（L110-148）：显式 handler 按 `priority` 降序、同 priority 按 seq 降序（**栈语义：后注册先执行**）→ 在第一个 `priority < overlay` 的 handler 之前插入 **Radix Escape 兜底探测**（匹配 `[role=dialog|alertdialog][data-state=open]`、popper 内 menu/listbox/dialog）→ view → navigation → 全部未消费则返回 false，native `moveTaskToBack`。
- 全是 overlay 档 handler 时兜底探测在循环后补跑（L142-144）。
- `hasOpenRadixOverlayBesides(excluded)`（L83-89）：给「自身就是 Radix dialog 的全屏容器」（Settings Sheet）让行用。
- handler 抛异常被 try/catch 吞掉并继续下一个（L131-138）——单个 handler 崩溃不会断链。

### 注册点全表（~70 处，priority 与消费内容）

**navigation 档（0）——1 处**

| 文件:行 | 消费什么 |
|---|---|
| `src/App.tsx` L1576-1589 | 统一历史 `canGoBack ? goBack : …`；F1 兜底：无历史且非 chat-v2 时回 chat-v2 主视图，再不行返回 false → 退后台 |

**view 档（50）——8 处**

| 文件:行 | 消费什么 | 叠层备注 |
|---|---|---|
| `src/features/chat/pages/ChatV2Page.tsx` L689-706 | 移动端中屏 viewMode / groupEditor 回退（`currentView !== 'chat-v2'` 让行） | 上层浮层归 overlay 档 |
| `src/features/learning-hub/LearningHubPage.tsx` L764-769 | finder `goUp`（目录上一级），isSmallScreen | 其头部菜单另注册 overlay 档 |
| `src/features/todo/components/TodoMainPanel.tsx` L127-136 | 关闭 todo 主面板（滑出），保活可见性守卫 | 多选模式另有 overlay 档 |
| `src/features/mindmap/MindMapContentView.tsx` L480-489 | 背诵模式退出 → 分支专注逐级上移 | 移动子屏全部 overlay 档 |
| `src/components/practice/PracticeLauncher.tsx` L97-100 | 关闭高级面板（activeAdvanced），isActive 门控 | — |
| `src/features/template-management/TemplateManagementApp.tsx` L761-768 | 小屏编辑态：收左右屏→脏检查返回 | 导入/导出面板是 overlay 档 |
| `src/features/template-management/TemplateManagementApp.tsx` L774-781 | 小屏选择模式 onCancel | — |

**overlay 档（100）——按域归组（除注明外均 `BACK_PRIORITY.overlay`，多数带保活可见性守卫：`isConnected` / `getClientRects` / `computed visibility` / `closest('[inert]')` / `offsetParent`）**

- 基建/通用组件（**所有 Radix 封装与自绘弹层都显式注册，兜底探测只是保险**）：
  - `src/components/ui/shad/Dialog.tsx` L32-35（Dialog 关闭）
  - `src/components/ui/shad/Popover.tsx` L54-57（Popover 关闭）
  - `src/components/ui/DsDialog.tsx` L26-29（自绘 Dialog）
  - `src/components/ui/app-menu/AppMenu.tsx` L104-112（**AppMenu 根统一注册**，含 inert/offsetParent 让行守卫——AppMenu 无 data-state=open，兜底探测不到，必须显式）
  - `src/components/layout/MobileSlidingLayout.tsx` L647-652（三屏布局：非 center 屏时收屏；**常驻注册**、seq 最早 → 同档栈语义下天然排最后）
  - `src/command-palette/CommandPalette.tsx` L296-299
  - `src/components/legal/UserAgreementDialog.tsx` L223-226；`src/components/onboarding/WelcomeOnboardingDialog.tsx` L164-167
  - `src/components/crepe/CrepeEditor.tsx` L391-394（块菜单）；`src/components/crepe/plugins/imageLightbox/lightboxDom.ts` L253-256（灯箱，非 React）
  - `src/components/ImageViewer.tsx` L161-169（先退裁剪再关查看器）；`src/components/ImageCropDialog.tsx` L221-231；`src/components/InlineImageViewer`→chat 域见下
  - `src/features/pomodoro/components/ImmersiveFocusMode.tsx` L182-185
- chat / Composer 域：
  - `src/features/chat/components/input-bar/InputBarUI.tsx` L1428-1431（**组合面板：attachment/model/skill/mcp/对话控制，closeAllPanels**，isMobile+hasAnyPanelOpen 门控；另有 app:view-switched 收面板兜底 L1437-1441）
  - `src/features/chat/components/input-bar/ModelMentionPopover.tsx` L82-85；`SkillSlashPopover.tsx` L198-201
  - `src/features/chat/components/MessageSearchBar.tsx` L53-63（自绘搜索条，带保活守卫）；`InlineImageViewer.tsx` L396-399
  - `src/features/chat/components/message/MessageTouchActionBar.tsx` L86-89
  - `src/features/chat/skills/components/SkillSelector.tsx` L235-238（技能详情子层，注释明确依赖「后注册先执行」压过面板层）
  - `src/features/chat/plugins/blocks/components/CitationPopover.tsx` L175-178
- settings 域：
  - `src/features/settings/components/Settings.tsx` L588-598（**全屏 Sheet 容器**：`hasOpenRadixOverlayBesides(sheetContentRef)` 让行 → 上方 Radix 浮层先关；再按 screenPosition/mobileNavView/vendorDetail 分级回退）
  - `VendorDetailPanel.tsx` L166-169；`OpenSourceAcknowledgementsSection.tsx` L163-166（legal 文档子屏）；`McpToolsSection.tsx` L1546-1549（菜单）与 L1711-1718（权限确认→预置列表两级）；`plugins/PluginsTab.tsx` L510-519（小屏详情）
- learning-hub 域：
  - `LearningHubPage.tsx` L618-621（头部菜单）；`LearningHubSidebar.tsx` L334-341（新建菜单，inert 守卫）；`views/IndexStatusView.tsx` L1086-1093（更多菜单，inert 守卫）
  - finder：`FolderPickerDialog.tsx` L212-215（inline 子屏）；`FinderBatchToolbar.tsx` L115-118（排序菜单）；`DesktopView.tsx` L167-170（自绘菜单）；`TabBar.tsx` L195-198（标签右键菜单）；`LearningHubContextMenu.tsx` L335-338（无 data-state，须显式）；`DstuAppLauncher.tsx` L131-134（新建菜单）
  - 内容视图：`NoteContentView.tsx` L150-153（右面板）；`ImageContentView.tsx` L705-708（缩放菜单）；`ExamContentView.tsx` L1706-1715（非根 viewMode 回退，inert 守卫）；`EpubPreview.tsx` L152-155（侧栏）；`media/VideoPlayer.tsx` L180-185（先退全屏）
- workbench / notes：
  - `apps/preview/quickLook.tsx` L123-126；`apps/notes/NotesWorkspaceApp.tsx` L1818-1827（compact explorer 子屏，保活守卫）；`apps/notes/NotesSearchOverlay.tsx` L603-612（搜索面板，保活守卫）
  - `src/features/notes/components/NotesEditorHeader.tsx` L384-394（标签建议浮层）
  - `src/shared/notes/useSaveAsNoteFlow.tsx`（注释声明由 FolderPickerDialog inline 承接）
- mindmap：`MindMapContentView.tsx` L353-467 六个 overlay（结构/样式/快捷键帮助/更多/版本历史/搜索+导入反馈+演示态）；`OutlineView.tsx` L453-457（聚焦态）；`StylePanel.tsx` L210-213、`StructureSelector.tsx` L286-289、`MobileNodeToolbar.tsx` L124-131（面板→关自身两级）、`MindMapResourcePicker.tsx` L225-228、`MindMapCanvas.tsx` L1721-1728（联想线模式/选中线）、`CanvasContextMenu.tsx` L224-233（图标面板→删除确认→关菜单三级）、`shared/BlankActionPopup.tsx` L79-82（均带 isMindMapActive / isCanvasActive 门控）
- todo：`TodoMainPanel.tsx` L366-375（多选退出）；`TodoItemDetail.tsx` L143-152（日历）；`TodoItemRow.tsx` L165-173（展开条）；`detail/TagsEditor.tsx` L66-74（标签建议）——全带保活守卫
- 题库/练习：`QuestionBankEditor.tsx` L671-681（设置面板）；`QuestionBankExportDialog.tsx` L246-256；`QuestionHistoryView.tsx` L238-248（inline 子屏）；`CsvImportDialog.tsx` L1101-1104；`BatchOperationToolbar/FilterBuilder.tsx` L76-79；`ReviewCalendarView.tsx` L496-499（选中日期）；`practice/PaperGenerator.tsx` L113-116；`practice/MockExamMode.tsx` L137-140；`practice/TimedPracticeMode.tsx` L110-113（答题卡，overlay）+ **L118-121 提交确认用 `BACK_PRIORITY.overlay + 1`**（唯一非标准档，语义正确：确认层压过答题卡层）
- 其他：`pdf/PdfSelectionActions.tsx` L79-82（结果面板）；`pdf/EnhancedPdfViewer.tsx` L1259-1297（选择工具条/高亮菜单/侧栏/搜索等复合 overlay，保活守卫）；`sandbox/SandboxWorkbenchSurface.tsx` L96-103（inspector）；`skills-management/SkillTapBrowser.tsx` L155-164、`SkillEditorModal.tsx` L333-341（embedded 取消+脏检查）；`translation/TranslationMain.tsx` L191-194、`essay-grading/GradingMain.tsx` L223-226（prompt 编辑器，isActive 门控）；`template-management/TemplateManagementApp.tsx` L236-244（导入导出面板）

### 期望顺序 vs 实际顺序
期望：**面板/浮层（overlay=100，后开先关）→ 未注册的 Radix 浮层（Escape 兜底）→ 视图内导航（view=50）→ 应用历史（navigation=0）→ native moveTaskToBack**。

实际（静态核实）：排序逻辑 L116 `priority 降序 + seq 降序` 与兜底插入点 L128 完全实现上述顺序。关键依赖成立：
- MobileSlidingLayout（抽屉）虽是 overlay 档但**挂载时常驻注册**，seq 最小 → 任何后开的菜单/面板都排它前面：「先关菜单再收抽屉」成立。
- Settings 全屏 Sheet 用 `hasOpenRadixOverlayBesides` 显式让行，解决「容器自身常驻命中 Escape 探测」的档位死角——这是底座提供的标准姿势。

⚠️ 发现 #2（错序风险，非底座缺陷，建议第 2 轮加法）：**显式 overlay handler 永远先于 Radix 兜底探测**。若「自绘面板（已注册 overlay）之上又叠了一个未显式注册的 Radix 浮层（如 shad/Select 下拉）」，且该 Select 没走 shad/Popover/Dialog 封装（那些都自注册），back 会先关下层自绘面板、上层下拉悬空。目前只有 Settings.tsx 用了 `hasOpenRadixOverlayBesides` 守卫；InputBarUI 组合面板、TodoItemDetail 日历、McpToolsSection 等含 Select/Popover 子控件的 handler 未加。实际风险被两点缓解：(a) shad/Popover、AppMenu、shad/Dialog 均自注册且后开 seq 更大；(b) 裸 Radix Select 使用点有限。**建议**：第 2 轮排查各含裸 Radix 子浮层的 overlay handler，按 Settings 模式加 `hasOpenRadixOverlayBesides` 让行（纯加法，一处一行）。

### Composer 内联面板 / AppMenu / InputBarUI 是否注册 back —— 结论：**无缺失**
- InputBarUI 组合面板（含移动端内联形态 ComposerInlinePanel，同一 panelStates 驱动）：已注册（L1428-1431，overlay）。
- AppMenu：根组件统一注册（AppMenu.tsx L104-112），ComposerPlusMenu 基于 AppMenu（ComposerPlusMenu.tsx L32-44）→ 自动覆盖，无需也没有重复注册。
- ModelMentionPopover / SkillSlashPopover / MessageSearchBar：各自显式注册。
- 顺序：面板打开后再开「+」菜单 → 菜单 seq 更大 → back 先关菜单再关面板，符合「面板→菜单」栈语义（同 SkillSelector L232 注释声明的机制）。

---

## 3. 契约测试现状（只列文件，未运行）
- `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`——源码级断言 PdfSelectionActions 含 `registerBackHandler` + `BACK_PRIORITY.overlay` + safe-area 派生变量（L99-106）。
- `src/components/legal/__tests__/UserAgreementDialog.visibility.test.tsx`——mock `registerBackHandler`/`BACK_PRIORITY` 测协议弹窗可见性（L9-10）。
- `src/features/chat/components/__tests__/ChatContainer.emptyComposerLayout.source.test.ts`——断言 InputBarUI 含 `globalKeyboardInset` / `--unified-input-keyboard-inset` / `keyboardInsetPx`（键盘契约字符串守卫，L123-125）。
- `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts`、`InputBarUI.mobileInlinePanel.test.tsx`、`ComposerPlusMenu.test.tsx`——Composer 拆分/内联面板契约。
- `src/components/ui/__tests__/migrationFoundation.source.test.ts`——`--touch-target-size: var(--control-height-touch)` 44px 契约（L46-107）。
- `src/components/crepe/features/__tests__/imageUploadMobileCopy.source.test.ts`——touch-target 规则源码守卫。
- **空白**：无 `androidBackCoordinator` 的直接单测（排序/兜底插入点/异常吞噬无覆盖，`rg handleAndroidBack --glob '*test*'` 仅命中 UserAgreementDialog mock）；无 `useKeyboardHeight.ts` 单例的单测（基线重置/阈值/inset 归零无覆盖）。

---

## 4. 不变量 18 静态自证（只记证据）
1. **NOTICES 在 legal/**：`/workspace/legal/THIRD_PARTY_NOTICES.txt` 存在（ls 确认）。✔
2. **Composer\* 拆分仍在**：`src/features/chat/components/input-bar/` 下 `ComposerInlinePanel.tsx`、`ComposerPanelOverlay.tsx`、`ComposerPlusMenu.tsx`、`ComposerTextarea.tsx`、`ComposerToolbar.tsx`、`ComposerPanel/ComposerPanel.tsx`、`composerDraftStorage.ts` 全部在位，且有 `InputBarUI.mobileSplitContract.source.test.ts` 契约守卫。✔
3. **G 44px / safe-area / Android back**：
   - 44px：`src/styles/responsive-utilities.css` L30-33 `.touch-target{min-height/width:44px!important}`（coarse pointer）、L134 抽屉导航行 `min-height:44px!important`、L158-159 `.touch-row{min-height:var(--control-height-touch,44px)}`；契约测试 `migrationFoundation.source.test.ts`。✔
   - safe-area：`src/app/shell/mobileShell.ts` L4-8 `var(--android-safe-area-*, env(safe-area-inset-*, 0px))` 四向变量 + `getMobileShellCssVars()`；`src/styles/ios-safe-area.css` L19-31 :root 全局映射兜底。✔
   - Android back：`androidBackCoordinator.ts` 在位，`App.tsx` L1567 `installAndroidBackBridge()` + L1576 navigation fallback 注册。✔

---

## 5. 补强建议（全部为加法，不动 mobileShell / androidBackCoordinator 底座）
给第 2 轮（back 链）：
1. ShadApiEditModal 迁到 `@/hooks/useKeyboardHeight` 的 `useKeyboardInset`，删除/收编 `src/features/settings/hooks/useKeyboardInset.ts`（双轨阈值 80 vs 150 不一致，见发现 #1）。
2. 给含裸 Radix 子浮层的 overlay handler 补 `hasOpenRadixOverlayBesides` 让行（Settings 模式，见发现 #2）；优先排查 InputBarUI 组合面板、McpToolsSection、TodoItemDetail。
3. TimedPracticeMode 的 `overlay + 1` 建议提为 BACK_PRIORITY 具名档（如 `confirm: 110`）或保持现状但在 BACK_PRIORITY 注释里记录——魔法 +1 不易被后来者发现（注册加法，不改协调器逻辑）。

给第 7 轮（序列测试）：
4. 新增 `androidBackCoordinator` 单测：优先级降序 + 同档 seq 栈语义、Radix 兜底插入点（overlay 档之后 / view 档之前、全 overlay 时循环后补跑）、handler 抛异常继续下一个、无 handler 无浮层返回 false。纯函数 + jsdom 可测，不需要跑 Android。
5. 新增 `useKeyboardHeight` 单测：mock visualViewport——阈值 150、宽度变化基线重置归零、iOS scroll-only 路径、`--keyboard-inset` CSS 变量写入/归零。
6. 序列级契约：模拟「抽屉开 → 面板开 → 菜单开 → 连按 back」断言消费顺序（菜单→面板→抽屉→view→navigation→false），把本表第 2 节的期望顺序固化成测试。

底座结论重申：`handleAndroidBack` 的排序/兜底/异常处理与 `useKeyboardHeight` 的双端分支设计自洽、注释与实现一致，**不重写，只做上述加法注册与测试补强**。
