# 0824 Wave2-C R1 · 扫描员-浮层体系（07-overlay）

- 范围：AppMenu / portal / overlay 全消费点静态审阅（只读，未改任何代码）
- 仓库：/workspace（分支现状，未执行任何构建/测试命令）
- 模型：claude-fable-5-thinking-high

---

## 0. AppMenu 组件机制速览（后续表格的判定基准）

`src/components/ui/app-menu/AppMenu.tsx`：

| 机制 | 位置 | 行为 |
|---|---|---|
| Portal 目标 | :319-322, :491-544 | `triggerRef.closest('[data-overlay-container="true"]') ?? document.body`。全库仅 `shad/Sheet.Content`（Sheet.tsx:77）和 `DsDialog`（DsDialog.tsx:174/444）标注了 `data-overlay-container="true"`。**其余场景一律 portal 到 body** |
| 子菜单 Portal | :972-1004 | `AppMenuSubContent` **无条件 portal 到 document.body**（:1003），即使根菜单 portal 进了 Sheet/Dialog 容器。子内容带 `data-app-menu-id={rootMenuId}`（:977），外点判定不受影响，但会脱离容器的 stacking/裁切上下文 |
| 外点关闭 | :115-131 | document 级 **`mousedown`**（非 pointerdown）。豁免三类目标：`[data-app-menu-id="${menuId}"]` 内、triggerRef 容器内、contentRef 内 |
| 动作执行时机 | :597-601（AppMenuItem） | `onClick`（click 事件）才执行动作并 `setOpen(false)`。**pointerdown→click 之间存在空窗**，任何在 pointerdown 抢先卸载菜单的外部监听都会吞掉动作 |
| 定位刷新 | :319-395 | 仅监听 `window resize` + `scroll(capture)`（:388-389）。**缺 visualViewport resize/scroll 监听**——软键盘弹出/收起时（尤其 iOS/部分 Android WebView 不改 innerHeight）菜单不重定位。对照组 ComposerPanelOverlay.tsx :78-79（用 visualViewport 尺寸计算）、:154-155/:172-173（订阅 visualViewport 事件）是正确实现 |
| Android back | :102-113 | 打开时注册 `registerBackHandler(close, BACK_PRIORITY.overlay)`；带离屏让行判定（trigger 容器 `[inert]` / `offsetParent===null` 时返回 false 不吞键） |
| z-index | :260, :509-514 | `useNestedOverlayZ()`（OverlayLayer.tsx:94-97）：外层有 `OverlayLayerProvider` 时 baseZ+50，否则退回 CSS 默认 110。调用方 `style.zIndex` 最高优先 |
| OverlayCoordinator | :69, :94-97 | 打开时 `dismissTooltips()` + `registerInteractiveOverlay()`（管 tooltip 副作用，与关闭协调无关） |

`AppSelect.tsx` 是 AppMenu 的薄封装（Select 语义），上述机制全部继承；`index.ts` 纯 re-export（含 AppMenuDemo / AppSelect）。

---

## 1. 全消费点表

### 1.1 AppMenu / AppSelect 直接消费点（grep `from '.*app-menu'`，60 处 import）

判定基准列说明：
- **portal**：除非触发器位于 Sheet/DsDialog（`data-overlay-container`）内，否则= body。下表标"容器内"仅指该消费点确定处于 Sheet/DsDialog 中的场景。
- **外点关闭**：AppMenu 自带 document mousedown（认 `data-app-menu-id`）；"宿主另有"指宿主组件还有自己的 document 级监听（见 §1.2 冲突标注）。

#### Chat 输入栏（P1 波及核心区）

| 文件 | 用途 | portal | 外点关闭 | 端 | 风险 |
|---|---|---|---|---|---|
| `input-bar/ComposerPlusMenu.tsx` | "+"菜单：桌面 AppMenuSub 飞出（文件/模式/技能/连接器），移动端扁平列表 | body | AppMenu 自带；**宿主 InputBarUI pointerdown 不认菜单** | 双端 | 菜单项打开面板类动作（onOpenSkillPanel 等）在 click 执行——若未来"+"菜单打开时已有面板开着，pointerdown 会先关面板。当前"+"菜单打开时通常无面板，风险中 |
| `input-bar/ComposerToolbar.tsx` :610-829 | 推理深度/运行时模型切换菜单（含 AppMenuSub 模型子菜单+搜索） | body | 同上 | 双端 | 同上；子菜单永远 portal body |
| `input-bar/RuntimeModelMenu.tsx` | 独立受控模型选择菜单（showSearch，隐形 trigger 锚定） | body | 同上 | 双端 | **搜索框聚焦弹软键盘 → AppMenu 缺 visualViewport 重定位**（§0）；焦点门控 :1066 已认 `[data-app-menu-id]`（键盘 inset 正确），但定位不跟 |
| `input-bar/ContextUsagePopover.tsx` | 上下文水位环弹层（AppMenu 当 popover 用） | body | 同上 | 双端 | 低（纯展示+一个压缩按钮） |
| `input-bar/AttachmentPanelBody.tsx` :151-192 | 附件面板头部"更多"菜单（资源库/拍照/清空全部） | body | **P1 主案发点**（§2） | 双端 | **高**：宿主是 attachment 面板（移动端内联/桌面 ComposerPanelOverlay），InputBarUI pointerdown 关面板→卸载菜单→click 动作丢失 |
| `InputBarUI.tsx` | 不直接渲 AppMenu，但托管上述全部消费点 + 面板外点关闭 :1387-1420 | — | 见 §2 | 双端 | P1 责任方 |
| `ComposerPanel/ComposerPanel.tsx` | **非 AppMenu 消费点**——文件头注释（:18-21）明确"不复用 AppMenu"，仅共享视觉骨架 | — | — | — | 澄清：任务清单里列它是因为面板体系相关，不是 menu 消费点 |

#### Chat 其它

| 文件 | 用途 | portal | 外点关闭 | 端 |
|---|---|---|---|---|
| `chat/components/message/MessageActions.tsx` | 消息操作"更多"菜单 | body | AppMenu 自带 | 双端 |
| `chat/pages/SessionItemRenderer.tsx` :396 | 会话条目右键/长按 context 菜单 | body | AppMenu 自带；**宿主另有 pointerdown :174-183**（滑动操作收合，不认菜单 → 点菜单会收合滑出条，但 AppMenu 挂在行根上不卸载，动作不丢，视觉抖动） | 双端（滑动=移动） |
| `chat/pages/SessionSidebarContent.tsx` | 会话列表排序/筛选菜单 | body | AppMenu 自带 | 双端 |
| `chat/pages/SessionGroupActions.tsx` | 会话分组操作菜单 | body | AppMenu 自带 | 双端 |
| `chat/components/Variant/VariantActions.tsx`、`ParallelVariantView.tsx` | 变体操作/并行视图菜单 | body | AppMenu 自带 | 双端 |
| `chat/plugins/blocks/ankiCardsBlock.tsx` | Anki 卡片块操作菜单 | body | AppMenu 自带 | 双端 |
| `chat/components/TranslationPopover.tsx` | AppSelect（语言选择） | body | AppMenu 自带 | 双端 |

#### Todo

| 文件 | 用途 | portal | 端 |
|---|---|---|---|
| `todo/components/main/PriorityFilterMenu.tsx` | 优先级筛选菜单 | body | 双端 |
| `todo/components/main/BulkActionBar.tsx` | 批量操作菜单 | body | 双端 |
| `todo/components/TodoSidebar.tsx`、`TodoIconRail.tsx` | 列表/图标栏 context 菜单 | body | 双端 |
| `todo/components/TodoAutomationWorkspace.tsx`、`automation/AutomationList.tsx` | AppSelect | body | 双端 |
| （另：`todo/components/main/TodoItemRow.tsx` 自绘菜单+2 处 pointerdown :155/:494，不是 AppMenu，见 §1.2） | | | |

#### Learning Hub

| 文件 | 用途 | portal | 端 |
|---|---|---|---|
| `learning-hub/LearningHubPage.tsx`、`LearningHubSidebar.tsx` | 页面/侧栏菜单 | body | 双端 |
| `learning-hub/components/finder/FinderToolbar.tsx`、`FinderQuickAccess.tsx`、`FinderBatchToolbar.tsx` | Finder 工具栏/快速访问/批量菜单 | body | 双端 |
| `learning-hub/apps/views/ExamContentView.tsx`、`UnifiedPreviewToolbar.tsx` | 考试视图 AppSelect+菜单 / 预览工具栏菜单 | body | 双端 |

#### Settings（几乎全是 AppSelect）

`Settings.tsx`（+AppMenuDemo）、`GeneralTab.tsx`、`AppearanceTab.tsx`、`EngineSettingsSection.tsx`、`PdfSettingsSection.tsx`、`MemorySettingsSection.tsx`、`McpEditorSection.tsx`、`SyncSettingsSection.tsx`、`WorkbenchSettingsSection.tsx`、`DimensionManagement.tsx`、`ShadApiEditModal.tsx`、`data-governance/SyncTab.tsx`、`BackupTab.tsx`、`AuditTab.tsx`
— 用途：设置下拉选择。**移动端 Settings 若整体在 Sheet 内**（`data-overlay-container`），根菜单 portal 进 Sheet（正确被 Sheet 收纳），但如含子菜单则子菜单仍去 body。ShadApiEditModal 若基于 DsDialog 同理。桌面裸页面 → body。

#### Mindmap / Workbench / 通用组件

| 文件 | 用途 | portal | 端 |
|---|---|---|---|
| `mindmap/MindMapContentView.tsx`、`views/outline/OutlineNodeMenu.tsx` | 画布/大纲节点菜单 | body | 双端 |
| `workbench/components/DockContextMenu.tsx` | Dock 右键菜单 | body | 桌面为主 |
| `workbench/apps/preview/FilePreviewAppWindow.tsx` | 预览窗菜单 | body | 桌面 |
| `components/ModernSidebar.tsx` | 全局侧栏菜单 | body | 双端 |
| `components/QuestionBankManageView.tsx`、`QuestionBankEditor.tsx`、`QuestionInlineEditor.tsx`、`question-types/NumericEditor.tsx`、`MatchingEditor.tsx`、`CsvFieldMapper.tsx` | 题库编辑 AppSelect/菜单 | body | 双端 |
| `components/skills-management/SkillsManagementPage.tsx`、`SkillsList.tsx` | 技能管理菜单 | body | 双端 |
| `components/translation/PromptPanel.tsx`、`LanguageSelect.tsx`、`essay-grading/InputPanel.tsx`、`WebSearchAdvancedConfig.tsx` | AppSelect | body | 双端 |
| `components/ui/app-menu/AppMenuDemo.tsx` | Demo | body | — |

**汇总**：60 处 import、约 40 个实际消费组件。除 Sheet/DsDialog 内的 Settings 场景外全部 portal 到 body；外点关闭统一由 AppMenu 自身 mousedown 承担；`data-app-menu-id` 只有 AppMenu 自己和 InputBarUI 焦点门控（:1066）认，**没有任何一个宿主的外点关闭监听认它**。

### 1.2 document 级 pointerdown / mousedown 外点关闭全库清单（28 处）

| 文件:行 | 事件 | 认 `data-app-menu-id`? | 与 AppMenu 冲突风险 |
|---|---|---|---|
| **`input-bar/InputBarUI.tsx` :1414** | pointerdown | **否** | **P1 主体**（§2） |
| `ui/app-menu/AppMenu.tsx` :125 | mousedown | 是（限本菜单 id） | 基准实现 |
| **`ui/shad/Popover.tsx` :71** | mousedown | **否** | **同构风险**：Popover 内嵌 AppMenu 时，点菜单（body portal）→ mousedown 关 Popover → 卸载菜单 → click 动作丢。桌面/移动通用（§3） |
| `chat/pages/SessionItemRenderer.tsx` :181 | pointerdown | 否 | 中低：宿主行内有 AppMenu context 菜单，点菜单会误收合滑动条，但菜单不卸载 |
| `chat/components/message/MessageTouchActionBar.tsx` :103 | pointerdown | 否 | 无（bar 内无 AppMenu，纯按钮） |
| `chat/plugins/blocks/components/CitationPopover.tsx` :160 | pointerdown(capture) | 否 | 低（内无 AppMenu） |
| `workbench/components/DockItem.tsx` :275 | pointerdown | 否 | 中：Dock 有 DockContextMenu（AppMenu）——需确认菜单是否在 DockItem 外点判定范围内（桌面专属，通报 B） |
| `workbench/apps/notes/ExplorerOverflowMenu.tsx` :47 | pointerdown(capture) | 否 | 低（自绘菜单） |
| `workbench/components/DesktopShortcuts.tsx` :278 | mousedown | 否 | 低（桌面） |
| `todo/components/main/TodoItemRow.tsx` :155, :494 | pointerdown | 否 | 低（自绘行内菜单） |
| `pdf/components/EnhancedPdfViewer.tsx` :806, :1538, :1931 | mousedown/pointerdown | 否 | 低 |
| `mindmap/components/toolbar/StylePanel.tsx` :192、`shared/EmojiPicker.tsx` :51、`shared/BlankActionPopup.tsx` :98、`mindmap/StructureSelector.tsx` :266 | mousedown | 否 | 低-中：Mindmap 视图另有 AppMenu（MindMapContentView），若菜单叠在这些面板上会互踩；未见直接嵌套 |
| `learning-hub/views/IndexStatusView.tsx` :1075、`finder/DesktopView.tsx` :149、`LearningHubContextMenu.tsx` :316、`DstuAppLauncher.tsx` :120、`apps/views/ImageContentView.tsx` :697 | mousedown/pointerdown | 否 | 低-中：LearningHub 同视图混用 AppMenu（Finder 工具栏）与自绘 context 菜单，两套外点体系并存 |
| `components/ModernSelect.tsx` :36、`LearningHeatmap/index.tsx` :339 | mousedown/pointerdown | 否 | 低 |
| `components/context-menu/TextContextMenu.tsx` :195、`shared/selection/useTextSelection.ts` :279 | mousedown | 否 | 低 |
| `crepe/plugins/wikilink/createConfirm.ts` :79、`candidatePicker.ts` :111 | mousedown(capture) | 否 | 低（编辑器内自绘） |
| `pomodoro/components/PomodoroStatsPopover.tsx` :597 | mousedown | 否 | 低 |

**结构性结论**：全库 27 个非 AppMenu 的外点关闭监听没有统一的"浮层归属"判定协议，各自用 ref.contains 判定"自己领地"。任何"portal 到 body 的浮层 + 领地判定"组合都是潜在 P1 同构缺陷；当前已实际踩雷的是 InputBarUI（§2），已确认同构隐患的是 shad/Popover（§3）。

---

## 2. P1 机制：pointerdown 关面板 vs 菜单 click 才执行动作

### 2.1 案发链路（AttachmentPanelBody「更多」菜单为典型）

1. attachment 面板打开（移动端内联于输入壳 :2133-2192；桌面 ComposerPanelOverlay portal 到 body :2555-2568，`composerPanelOverlayRef` 指向浮层 DOM）。
2. 用户点面板头部「更多」→ AppMenu 打开，**内容 portal 到 document.body**（ComposerPanelOverlay 只有 `data-composer-panel-overlay` 属性，**没有** `data-overlay-container="true"`，AppMenu :322 找不到容器）。
3. 用户点菜单项（如"资源库"）。事件序：**pointerdown → mousedown → click**。
4. `pointerdown` 先到 InputBarUI :1390-1405 `handleClickOutside`：目标既不在 `panelContainerRef`（React 子树但 DOM 已 portal 走）、不在 `composerPanelOverlayRef`（菜单不在浮层 DOM 内）、也不在 `inputContainerRef` → `closeAllPanels()`。
5. attachment 面板关闭 → AttachmentPanelBody 卸载 → AppMenu 连根卸载，菜单 DOM 消失。
6. `click` 永远到不了 AppMenuItem（:597-601）→ **动作丢失**，且面板被意外关掉。菜单自己的 mousedown 豁免（:120）救不了——先手是别人的 pointerdown。

对照：同文件焦点门控 :1058-1068 已经学会认 `[data-app-menu-id]`（M3 修复注释明说"AppMenu 内容 portal 在 body 上"），**但 :1387-1420 的外点关闭没同步这条认知**——这就是 P1 的不对称根因。

### 2.2 短期方案：「本 Composer 拥有的 menu portal 排除」

在 :1390 `handleClickOutside` 增加豁免：`target.closest('[data-app-menu-id]')` 时 return。

- 最小改动（一行判定），与 :1066 焦点门控对称。
- 精确版（推荐评估）：blanket 豁免会让"composer 面板开着时点了页面上另一个无关 AppMenu"也不关面板。若要求归属精确，需要 AppMenu 根容器（:135）同步输出 `data-app-menu-id={menuId}`，外点判定先由 content 的 id 反查根容器、再验证根容器在 panelContainerRef/composerPanelOverlayRef/inputContainerRef 内。代价：动 AppMenu.tsx 一处 + InputBarUI 一处。考虑到实际布局里"面板开着 + 屏幕其它 AppMenu 同时开着"几乎不可达（菜单自身 mousedown 也会互踩），blanket 版风险可接受、归属版更严谨。
- 注意 mousedown 附带问题：panelContainerRef 外壳 :2556 有 `onMouseDown={e => e.stopPropagation()}`，它挡的是 mousedown 冒泡（保护 AppMenu 的外点判定不误关别的菜单？实际效果是点面板内不触发其它浮层的 document mousedown 关闭），与 pointerdown 通道互不相干——修 pointerdown 时不要误删它。

### 2.3 长期方案：overlay coordinator「面板拥有的浮层」

OverlayCoordinator 已有 `registerInteractiveOverlay()`（AppMenu :96、ComposerPanelOverlay :131 都在用，但只管 tooltip 消杀）。扩展为**归属登记**：

- 浮层打开时登记 `(overlayElement, ownerElement)`（owner=触发器所在 DOM）；提供 `isWithinOwnedOverlay(target, scopeEl)`：target 落在任何"owner 位于 scopeEl 子树内"的浮层里即视为 scope 内点击（需沿浮层链递归——菜单套菜单）。
- 所有外点关闭消费点（§1.2 表中 27 处可渐进迁移）改问 coordinator，不再各自 ref.contains。
- 备选路线（不推荐直接上）：给 ComposerPanelOverlay 打 `data-overlay-container="true"` 让 AppMenu portal 进浮层、contains 自然命中——**但 ComposerPanelOverlay 外壳是 `overflow-hidden`（:196-198）**，菜单会被裁切，需要同步重做溢出模型，波及面反而大。
- 与 OverlayLayer（z-index 体系）保持正交（OverlayLayer.tsx :14-17 注释已声明二者分工），归属登记放 Coordinator 侧。

---

## 3. 桌面同类风险（通报 B，本轮未改、不建议 C 组动）

1. **桌面 composer 面板同样中招**：InputBarUI 的 pointerdown 监听不分端（:1387 无 isMobile 门控），桌面 ComposerPanelOverlay 里的 AttachmentPanelBody「更多」菜单用鼠标点同样走 §2.1 链路（pointerdown 对鼠标同样先于 click）。修复方案 §2.2 天然双端生效，但**桌面语义验证归 B**。
2. **shad/Popover.tsx :60-77**：document mousedown 外点关闭，不认 `data-app-menu-id`。任何"Popover 内容里嵌 AppMenu/AppSelect"的桌面用法都会复现同构 bug（mousedown 先关 Popover → 菜单卸载 → click 丢）。建议 B 侧同步加豁免或等长期 coordinator。
3. **AppMenuSubContent 恒 portal body（:1003）**：桌面 DsDialog/Sheet 内的多级菜单，根内容进容器、子菜单去 body——若容器有 backdrop pointer 拦截或更高 z-index，子菜单可能被压/点击穿透错位。目前 Settings 区多为 AppSelect（无子菜单），显性受害者未发现，属结构债。
4. **DockItem.tsx :275 + DockContextMenu**：workbench 桌面 Dock 的 pointerdown 收合与 AppMenu 右键菜单并存，同构风险待 B 确认。
5. **AppMenu 定位缺 visualViewport**（:388-389）：桌面无软键盘、影响面≈0，属移动专项（RuntimeModelMenu 搜索框场景），修复应对齐 ComposerPanelOverlay 的 :150-175 实现，但改的是共享组件 AppMenu.tsx——**动之前须通报 B 桌面回归面**（全部 60 个消费点共用该定位逻辑）。

---

## 4. back 链：菜单开时 Android back 是否先关菜单

**结论：链路正确，先关菜单、再关面板、最后走导航。**

- AppMenu 打开即注册 overlay 档 back handler（AppMenu.tsx :102-113）。
- InputBarUI 面板打开注册 overlay 档 handler（:1426-1432，仅 isMobile）。
- androidBackCoordinator.ts :116：同优先级**后注册先执行**（`b.seq - a.seq`，栈语义）。菜单必然晚于宿主面板打开 → 菜单 handler 先跑 → `setOpen(false)` 返回 true 消费事件。下一次 back 才轮到面板 handler → `closeAllPanels()`。
- 离屏让行（AppMenu :105-111）：trigger 容器 `[inert]` 或 `offsetParent===null` 时返回 false 不吞键——保活视图切走时不会出现"back 被看不见的菜单吃掉"。
- Radix Escape 兜底探测（coordinator :127-128）只在遇到低于 overlay 档的 handler 前插入，AppMenu/面板都在 overlay 档，不会被兜底抢先。
- 一个边界：AppMenu back handler 的关闭判定挂在 **trigger 容器**上（:109 注释已自证原因——content portal 到 body 反映不了宿主隐藏态）。若 P1 场景下面板先被 pointerdown 误关（§2.1），菜单已随卸载注销 handler，back 链不残留悬挂 handler——注销路径干净（registerBackHandler 返回的 cleanup 由 effect 卸载执行）。

---

## 5. 免责与边界

- 全程未运行 npm/node/构建/测试，纯静态阅读。
- 未触碰：coordinator.rs、tool_loop、Composer 桌面语义、任何源码文件。
- §2.2/§2.3 是方案建议，本轮未实施任何修改。
