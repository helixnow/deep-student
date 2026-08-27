# 0824 Wave2-C R2 · 审阅员-回归面（09-regression-pointerdown）

- 任务：全库 document 级 pointerdown/mousedown 消费点，有无与 P1 同构问题（外点关闭不认 portal / `data-app-menu-id`）
- 基准：docs/dev/wave2-C-r1/07-overlay.md §1.2 的 28 处清单，逐条复核并补漏
- 仓库：/workspace（分支 cursor/0824-wave2-mobile-uiux-a875，HEAD 98bbf3f1），只读静态审阅，未执行编译/测试，未改任何产品代码
- 模型：claude-fable-5-thinking-high

## 0. 判定基准（复核用）

- **P1 同构缺陷定义**：document/window 级 pointerdown 或 mousedown 外点关闭监听，用 `ref.contains(target)` 判"自己领地"；其领地内存在 AppMenu/AppSelect **触发器**，而菜单**内容 portal 到 body**（AppMenu.tsx :319-322 找不到 `data-overlay-container` 时一律 body）→ 点菜单项被判为"外部"→ 先手关闭/卸载宿主 → AppMenuItem 的 click（:597-601）永远不到 → **动作丢失**。
- **同构高危 = 是** 需同时满足：① 不认 `[data-app-menu-id]`；② 关闭动作会**卸载**（而非仅视觉收合）领地内的 AppMenu；③ 领地内确实存在（或有现实路径出现）AppMenu 触发器。
- 全库认 `data-app-menu-id` 的只有两处（grep 复核）：AppMenu.tsx :120（自身外点豁免）、InputBarUI.tsx :1066（焦点门控，**不是**外点关闭通道）。→ R1 §1 汇总结论"没有任何宿主外点监听认它"**成立**。
- 全库无 useClickOutside/useOnClickOutside 类公共 hook，无 `documentElement/body.addEventListener`、无 `.onmousedown=` 赋值式注册（已 grep 排除）——各消费点全部手写，无公共收口点。

## 1. R1 28 处清单逐条复核表

行号全部与当前 HEAD 一致（逐条 grep+读源确认）。passive 列：pointerdown/mousedown 全部未显式指定（默认非 passive），只有伴生 touchstart 监听（§2.2）标了 passive。

| # | 文件:line | 事件类型 | capture/bubble/passive | 是否认菜单 portal（data-app-menu-id） | 是否同构高危 | 归属 | 复核备注 |
|---|---|---|---|---|---|---|---|
| 1 | `chat/components/input-bar/InputBarUI.tsx:1414` | pointerdown | bubble / 非passive | **否**（:1393-1402 只认 panelContainerRef / composerPanelOverlayRef / inputContainerRef 三个 ref.contains） | **是（P1 实锤）** | **C 本会话** → 列第 6 轮复核 | 关面板即卸载 AttachmentPanelBody 等面板内 AppMenu；同文件 :1066 焦点门控已认 `[data-app-menu-id]`，此处未同步。复核确认 R1 §2 链路成立 |
| 2 | `components/ui/app-menu/AppMenu.tsx:125` | mousedown | bubble / 非passive | 是（:120，限本 menuId） | 否（基准实现） | C 观察 | 唯一正确样板 |
| 3 | `components/ui/shad/Popover.tsx:71` | mousedown | bubble / 非passive | **否**（:64-65 只认 containerRef/contentRef） | **潜在同构（当前无实例）** | 通报 B | **对 R1 §3.2 的修正**：逐一排查全部 14 个 Popover 消费文件（AgentControlCenter、RowPriorityMenu、RescheduleMenu、Settings、McpToolsSection、McpEditorSection、NotesEditorToolbar、PlaybackRateMenu、EpubPreview、ankiCardsBlock、ComponentCompareTab、UnifiedModelSelector、QuestionBankEditor + 测试），**没有任何一处把 AppMenu/AppSelect 嵌进 PopoverContent**（ankiCardsBlock :1586/:1617、McpEditorSection :319/:1091 均为兄弟关系；QuestionBankEditor 的 AppSelect :1580/:1590 在 Popover :2977 之外）。降级为结构债：一旦未来嵌套即复现 P1 |
| 4 | `chat/pages/SessionItemRenderer.tsx:181` | pointerdown | bubble / 非passive | 否（:178 只认 rootRef） | 否（同构低危） | 观察（chat 移动侧属 C，暂不动） | 复核确认：仅收合滑动条（setOpen(false)），AppMenu 挂在行根（rootRef 内）不卸载，动作不丢，只有视觉抖动。若做体验修补：豁免 `[data-app-menu-id]` 一行即可，非 P1 级 |
| 5 | `chat/components/message/MessageTouchActionBar.tsx:103` | pointerdown | bubble / 非passive | 否（:97 rootRef） | 否 | 观察 | 复核确认组件**不接收 children**、无 app-menu import，纯按钮条，领地内无菜单触发器 |
| 6 | `chat/plugins/blocks/components/CitationPopover.tsx:160` | pointerdown | **capture** / 非passive | 否（:156 popRef） | 否 | 观察 | 引用弹层自绘，内无 AppMenu |
| 7 | `workbench/components/DockItem.tsx:275` | pointerdown | bubble / 非passive | 否（:273 wrapRef） | 否（同构低危，**较 R1 降级**） | 通报 B（桌面） | R1 标"中：待确认"；本轮确认：仅收合 DockWindowList（:553 内联渲在 wrapRef 子树，无 portal，无 app-menu import）；DockContextMenu（AppMenu）包在 DockItem **外层**（Dock.tsx:289），点菜单内容只会收合窗口列表，菜单不卸载 → 与 #4 同型的视觉抖动，非动作丢失 |
| 8 | `workbench/apps/notes/ExplorerOverflowMenu.tsx:47` | pointerdown | **capture** / 非passive | 否（:44 rootRef） | 否 | 观察 | 自绘溢出菜单，内无 AppMenu |
| 9 | `workbench/components/DesktopShortcuts.tsx:278` | mousedown | bubble / 非passive；**延迟 setTimeout 挂载**（:277） | 否 | 否 | 通报 B（桌面） | 自绘右键菜单 |
| 10 | `todo/components/main/TodoItemRow.tsx:155` | pointerdown | bubble / 非passive | 否 | 否 | 观察 | 自绘行内菜单，无 app-menu import |
| 11 | `todo/components/main/TodoItemRow.tsx:494` | pointerdown | bubble / 非passive | 否（:490 wrapRef） | 否 | 观察 | 同上 |
| 12 | `pdf/components/EnhancedPdfViewer.tsx:806` | mousedown | bubble / 非passive | 否（:802 zoomMenuRef） | 否 | 观察 | 自绘缩放菜单 |
| 13 | `pdf/components/EnhancedPdfViewer.tsx:1538` | pointerdown | bubble / 非passive；延迟 100ms 挂载 | 否 | 否 | 观察 | 清高亮激活态，非浮层卸载 |
| 14 | `pdf/components/EnhancedPdfViewer.tsx:1931` | pointerdown | bubble / 非passive；延迟 100ms 挂载 | 否（:1927 认 `.ds-highlight-menu/.ds-pdf__highlight-bar` class 豁免——**class 版领地协议**，同样不认 app-menu） | 否 | 观察 | 高亮菜单自绘 |
| 15 | `mindmap/components/toolbar/StylePanel.tsx:192` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 面板自绘，无 app-menu import |
| 16 | `mindmap/components/shared/EmojiPicker.tsx:51` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 同上 |
| 17 | `mindmap/components/shared/BlankActionPopup.tsx:98` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 同上 |
| 18 | `mindmap/components/mindmap/StructureSelector.tsx:266` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 同上 |
| 19 | `learning-hub/views/IndexStatusView.tsx:1075` | mousedown | bubble / 非passive | 否（:1068 mobileMoreRef） | 否 | 观察 | 移动端"更多"自绘菜单，无 app-menu import |
| 20 | `learning-hub/components/finder/DesktopView.tsx:149` | mousedown | bubble / 非passive；延迟挂载；伴生 touchstart(capture,passive) :150 | 否 | 否 | 观察 | 自绘 context 菜单 |
| 21 | `learning-hub/components/LearningHubContextMenu.tsx:316` | mousedown | bubble / 非passive；延迟挂载；伴生 touchstart(capture,passive) :317 | 否 | 否 | 观察 | 自绘 context 菜单 |
| 22 | `learning-hub/components/DstuAppLauncher.tsx:120` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 自绘创建菜单 |
| 23 | `learning-hub/apps/views/ImageContentView.tsx:697` | pointerdown | bubble / 非passive | 否（:693 zoomMenuWrapRef） | 否 | 观察 | 自绘缩放菜单 |
| 24 | `components/ModernSelect.tsx:36` | mousedown | bubble / 非passive | 否（:32 containerRef） | 否 | 观察 | 自绘下拉，内容不 portal（领地自洽） |
| 25 | `components/LearningHeatmap/index.tsx:339` | pointerdown | bubble / 非passive | 否（:336 认 `.lh-grid/.lh-tooltip` class） | 否 | 观察 | 只清 hover tooltip |
| 26 | `components/context-menu/TextContextMenu.tsx:195` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 自绘文本菜单 |
| 27 | `shared/selection/useTextSelection.ts:279` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 选区管理，非浮层关闭 |
| 28 | `components/crepe/plugins/wikilink/createConfirm.ts:79` | mousedown | **capture** / 非passive | 否 | 否 | 观察 | 编辑器内自绘确认框（:26 另有元素级 mousedown preventDefault 保焦点） |
| 29 | `components/crepe/plugins/wikilink/candidatePicker.ts:111` | mousedown | **capture** / 非passive | 否 | 否 | 观察 | 编辑器内自绘候选框 |
| 30 | `features/pomodoro/components/PomodoroStatsPopover.tsx:597` | mousedown | bubble / 非passive | 否 | 否 | 观察 | 自绘统计弹层 |

（R1 把 TodoItemRow 两处、EnhancedPdfViewer 三处、mindmap 四处、learning-hub 五处合并成行计 28；上表拆开逐行计 30 个注册点，集合一致，**行号全部复核无漂移**。）

## 2. 补漏（R1 清单未覆盖）

### 2.1 window 级 pointerdown/mousedown（与 document 级同相位、同风险面，R1 漏扫）

grep 口径：R1 只扫了 `document.addEventListener`，`window.addEventListener` 的同类监听在事件到达 document 前/后同样先于 click 消费，判定协议问题完全同构，应并入台账：

| # | 文件:line | 事件类型 | capture/bubble/passive | 是否认菜单 portal | 是否同构高危 | 归属 | 备注 |
|---|---|---|---|---|---|---|---|
| W1 | `mindmap/components/mindmap/MindMapResourcePicker.tsx:284` | mousedown（window） | bubble / 非passive；延迟 50ms 挂载（:283） | 否（:254 panelRef） | 否 | 观察 | 资源挑选面板自绘，无 app-menu import，内无菜单触发器 |
| W2 | `mindmap/components/mindmap/CanvasContextMenu.tsx:284` | mousedown（window） | bubble / 非passive | 否（:271 menuRef） | 否 | 观察 | 画布右键菜单自绘；MindMapContentView 的 AppMenu 与它互为外部——点 AppMenu 会关画布菜单（合理），反向不卸载 AppMenu |
| W3 | `components/crepe/CrepeEditor.tsx:374` | pointerdown（window） | **capture** / 非passive | 否（:364 认 `.crepe-block-menu` class） | 否 | 观察 | 关自绘 block 菜单；capture 相位极早，若未来 block 菜单里嵌 AppMenu 会即刻同构，现无 |
| W4 | `components/BatchOperationToolbar/index.tsx:302` | pointerdown（window） | **capture** / 非passive | 否（:298 moreMenuRef） | 否 | 观察 | 自绘"更多"菜单 |
| W5 | `workbench/components/WorkbenchDevPanel.tsx:795` | pointerdown（window） | **capture** / 非passive | 否（:783 root.contains） | 否 | 观察 | 非关闭语义：外部按住时给 HUD 加幽灵 class，pointerup 即恢复 |
| W6 | `hooks/useNavigationShortcuts.ts:73` | mousedown（window） | bubble / 非passive | 否 | 否 | 观察 | 非外点关闭：鼠标侧键（button 3/4）→ 前进/后退导航。边缘备注：AppMenu 打开时按侧键会直接触发导航、菜单不拦截（Alt+方向键同理），属全局快捷键与浮层的通用交互问题，非 P1 同构 |
| W7 | `pomodoro/components/ImmersiveFocusMode.tsx:246` | pointerdown（window） | bubble / 非passive | 否 | 否 | 观察 | 非关闭语义：活动探测唤醒 chrome |

### 2.2 touchstart 家族（超出本任务事件类型，仅备注不入台账）

移动端事件序 touchstart 先于 mousedown/click，同样是"click 前抢先关闭"通道；本轮 grep 到 4 处 document 级 touchstart：

- `learning-hub/components/finder/DesktopView.tsx:150`、`LearningHubContextMenu.tsx:317`——上表 #20/#21 的伴生监听（capture+passive），领地判定同主监听，无 AppMenu 触发器，低。
- **`learning-hub/components/TabBar.tsx:181`（R1 未列）**——自绘 tab 右键菜单的触屏外点关闭（capture+passive，:175 ctxMenuRef.contains），另有 `click,{once:true}` :178 与 `contextmenu,{once:true}` :179 兜底。菜单自绘、无 app-menu import，低，观察。
- `learning-hub/apps/views/EpubPreview.tsx:619`——EPUB iframe 内文档的翻页手势（passive），非外点关闭，无关。

### 2.3 排除项说明

`SnapPreview:139`、`NotesCrepeEditor:440`、`MessageList:798`、`TodoMainPanel:166`、`SnappySlider:215`、`voice-input/hooks:368`、`useSwipeGesture:239`、`MobileSlidingLayout:766`、`useResourceDragOut:189`、`useFilesHoverPreview:184`、`useSlashMenuCustomScrollbar:258`、crepe 各 view.ts、`CrepeDragDropDebugPlugin:441`、`CrepeEditor:270/:2137` 等均为**元素级**监听（拖拽/滑动/焦点保持/调试），不构成 document 级外点关闭，不入台账。

## 3. 结论

1. **P1 同构高危仅 1 处实锤**：`InputBarUI.tsx:1414`（表 #1），即 P1 本体，归 C 本会话所有权，修复方向按 R1 §2.2（外点判定豁免 `[data-app-menu-id]`，与同文件 :1066 焦点门控对称）。**本轮未修，列第 6 轮复核。**
2. **1 处潜在同构（结构债）**：`shad/Popover.tsx:71`。本轮把 R1 的"同构风险"精化为"**当前全库无 Popover 内嵌 AppMenu 实例**，暂不可达"；但只要任何消费点把 AppSelect/AppMenu 放进 PopoverContent 即复现 P1。通报 B（组件属共享 UI，桌面消费点多），建议与 InputBarUI 同款豁免或等 coordinator 归属协议。
3. **2 处同构低危（关而不卸、视觉抖动）**：`SessionItemRenderer.tsx:181`（观察）、`DockItem.tsx:275`（较 R1"中"降级，通报 B 仅作桌面语义确认）。共同点：AppMenu 挂在监听领地之内/之外的**稳定节点**上，外点误判只收合视觉状态，不卸载菜单、不丢 click。
4. **其余 26 个 document 级注册点 + 7 个 window 级补漏点**：领地内均无 AppMenu 触发器（逐文件 grep app-menu import + 读 JSX 确认），自绘浮层的内容不 portal（ref.contains 自洽），无同构问题，全部"观察"。
5. **结构性确认**：R1 §1.2 的结论成立且补漏后更强——全库 **37 个** document/window 级 pointerdown/mousedown 注册点（30+7）中只有 AppMenu 自身认 `data-app-menu-id`，无公共 click-outside hook 可收口，长期解仍应走 R1 §2.3 的 OverlayCoordinator 归属登记。
6. **不散点修**：本轮 0 代码改动、0 commit，只记台账。

## 4. 第 6 轮复核清单（C 会话所有权内的同构修复项）

| 项 | 文件 | 修复内容（届时验证点） |
|---|---|---|
| R2-6-1 | `chat/components/input-bar/InputBarUI.tsx` :1390-1405 | 外点关闭豁免 `target.closest('[data-app-menu-id]')`（或归属精确版，见 R1 §2.2）；验证：附件面板"更多"菜单点"资源库"动作不丢、面板不误关；豁免不影响 Esc/back 链（:1408/:1426）；不误删 :2556 的 onMouseDown stopPropagation |

（`SessionItemRenderer.tsx:181` 若届时决定顺手加豁免，属体验优化非 P1 级，需单独立项，不并入 R2-6-1。）

## 5. 免责与边界

- 全程未运行 npm/node/编译/测试，纯静态阅读；未改产品代码，未 git commit。
- grep 口径：`document|window.addEventListener('pointerdown'|'mousedown')` 全 src 扫描 + `ownerDocument`/`.onmousedown=` 赋值式/公共 hook 三路排除扫描；React 合成事件（onPointerDown props）为元素级，不在 document 级口径内。
- Popover 嵌套排查基于当前 HEAD 的静态 JSX 结构；动态 children（如 renderProps 注入 AppMenu）理论上可绕过静态排查，未发现此类模式。
