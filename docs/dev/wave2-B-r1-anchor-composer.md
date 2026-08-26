# 0824 Wave2-B 第 1 轮 · 锚定员-Composer桌面

- 基线：`/workspace @ 061b4815`（当前 HEAD `82e016b7` 为空基线提交，`git diff --stat 061b4815..HEAD -- src/ src-tauri/` 为零，产品代码与 061b4815 逐字节一致）。
- 本轮性质：只读锚定。**本轮零产品改动**（本文件是唯一新增物）。未执行编译/测试/npm/cargo。
- 域界：Composer 桌面行为（`ComposerPanelOverlay`、桌面 overlay 语义、sendAvailability 桌面分支）归本会话；Composer 移动热区与 44px 类名归 C（只读记账，见第 6 节）；tool_loop 归 A（本轮未触及）。

---

## 1. 桌面 overlay 打开/关闭/焦点/Esc/点击外部 状态机

### 1.1 状态源与派生链

面板开关的唯一真相源是会话 store 的 `panelStates`（`useInputBarV2.ts:70/78` 订阅，`useInputBarV2.ts:485-490` 的 `setPanelState` 直写 `store.getState().setPanelState`）。InputBarUI 纯展示，不自持开关状态：

- `hasAnyPanelOpen` / `activeComposerPanel`：`InputBarUI.tsx:1022-1023`（`COMPOSER_PANEL_KEYS` 上 find 首个为 true 的面板）。
- 每个面板一个 `useDeferredOpen`（`InputBarUI.tsx:130-170`）产出 `{ shouldRender, motionState }` 四态动画机：`closed → opening →(双 rAF) open`；关闭走 `closing →(220ms timer) closed`。五个实例在 `InputBarUI.tsx:1003-1008`。
- 桌面渲染条件：`!isMobile && activeComposerPanel === 'X' && xPanelMotion.shouldRender`（attachment `InputBarUI.tsx:2558`、model `:2578-2579`、mcp `:2601-2602`、advanced `:2621-2622`、skill `:2637-2638`），全部走 `ComposerPanelOverlay` portal 到 `document.body`（`ComposerPanelOverlay.tsx:186/232`）。移动端同一 `panelStates` 改走内联插槽（`InputBarUI.tsx:2133-2195`），`isMobile` 判据在 `:324`（宽度断点，注释 `:319-323` 明确与 `isMobileEnv`（`:808`，pointer:coarse）分裂是有意的）。

### 1.2 打开路径

- `togglePanel`（`InputBarUI.tsx:1444-1455`）：先关加号菜单与 @mention 补全，再互斥关掉其他面板，最后翻转目标面板。附件 `:1458-1460`；技能 `:1507-1509`；模型面板经 `handleOpenRuntimeModelPanel`（`:1462-1471`，宿主给了 `onOpenRuntimeModelPanel` 时外交出去，否则 `togglePanel('model')`）。
- 外部事件入口：`CHAT_V2_OPEN_ATTACHMENT_PANEL` window 事件（`InputBarUI.tsx:1603-1610`）直接 `onSetPanelState('attachment', true)`。**事件无 sessionId 过滤**（对比 `CHAT_V2_FOCUS_INPUT` 在 `:1714-1718` 有过滤）——发射方在 `useReferenceToChat.ts:355`、`useVfsContextInject.ts:254`、`LearningHubSidebar.tsx:2885`。多 Chat 窗口并存时所有挂载中的 InputBarUI 都会开自己的附件面板，详见第 4 节。
- 互斥的第二重保险在 store 侧 hook（`useInputBarV2.ts:557-567`）。

### 1.3 关闭路径（全部收敛到 `closeAllPanels`，`InputBarUI.tsx:1378-1384`）

| 触发 | 位置 | 说明 |
| --- | --- | --- |
| 点击外部 | `InputBarUI.tsx:1387-1420` | document 级 `pointerdown`（`:1414`，注释：pointer 覆盖鼠标+触摸且早于 click）。三个白名单：`panelContainerRef` / `composerPanelOverlayRef` / `inputContainerRef`（`:1393-1402`）。补充防线：panel 容器 `onMouseDown` stopPropagation（`:2556`），overlay 自身也 stop（`ComposerPanelOverlay.tsx:220`）。 |
| Esc | `InputBarUI.tsx:1407-1411` | document keydown，`e.defaultPrevented` 跳过（让内层菜单/对话框先消费）。注意：**不 preventDefault、不区分哪个面板**，一律 closeAll。 |
| 再点触发钮 | `togglePanel` `:1454` | 翻转为 false。 |
| 视图切走 | `InputBarUI.tsx:1436-1441` | `app:view-switched`（经典壳事件，`src/events/app.ts:21`）。portal 在 body 上不随宿主 `visibility:hidden`，故必须显式收起——**该事件只覆盖经典壳切换路径**，workbench 窗口最小化/遮挡不派发它（缺口见第 4 节）。 |
| Android 返回键 | `InputBarUI.tsx:1426-1432` | 仅 `isMobile` 注册，桌面无此路径（正确）。 |
| 打开推理/加号菜单 | `:1475-1481`、`:1484-1488` | 菜单打开前 closeAllPanels，保证 AppMenu 与组合面板不叠放。 |

### 1.4 焦点语义

- 桌面 overlay **不设焦点陷阱、不自动抢焦**：`ComposerPanelOverlay` 只有 `role="dialog" aria-modal="false"`（`ComposerPanelOverlay.tsx:189-190`），打开后焦点留在 textarea；面板内可聚焦控件（如 ModelPicker 搜索框）由面板内容自理。
- 打开时经 `useOverlayCoordinator` 熄灭 tooltip 并登记 interactive overlay（`ComposerPanelOverlay.tsx:129-132`；`OverlayCoordinator.tsx:29-41` 计数、压制 tooltip）。
- 关闭后**无焦点归还**：Esc/点外部关闭面板不会把焦点还给 textarea（对比 `BlockingInteractionBar` 有 `restoreFocusRef={textareaRef}`，`InputBarUI.tsx:2269`）。这是桌面打磨项（第 5 节 P-2）。
- `composerEditableFocused` 焦点门控（`InputBarUI.tsx:1052-1083`）在 `!isMobile` 时恒 false（`:1053-1055`），键盘 inset 纯移动语义，桌面无副作用（`:1086`）。

### 1.5 定位/几何（桌面语义主体）

`updatePosition`（`ComposerPanelOverlay.tsx:71-127`）：visualViewport 优先（`:78-79`）、`widthMode` anchor/wide（`:81-87`）、placement 偏上方，两条翻转规则（上方 < 160px，或上方放不下 maxHeight 且下方更宽裕，`:94-100`）。重定位由 resize/scroll(capture)/visualViewport/ResizeObserver 驱动（`:140-176`）。`onPlacementChange` prop（`:26/134-138`）**当前无任何产品调用方**（全仓 grep 仅定义处）——「方角接缝」意图没有接线，见第 5 节 P-4。

---

## 2. sendAvailability 桌面 vs 移动差异

### 2.1 计算层：零平台分支

`computeSendAvailability`（`sendAvailability.ts:53-76`）与两个 resolver（`:83-114`、`:120-129`）是纯函数，输入里没有 isMobile/isMobileEnv。六个原因码（`sendAvailability.ts:19-25`：queue-full / external / uploading / attachment-not-ready / empty / busy）桌面移动完全同集，**没有桌面特有的 code**。唯一调用点在 `InputBarUI.tsx:1186-1204`（输入组装 `:1088-1155`：hasUploadingAttachments / hasSendableAttachments / hasProcessingMedia / firstBlockingAttachment 全平台同一口径）。

### 2.2 呈现层：三条真实的桌面/移动分叉

| 面 | 桌面 | 移动 | 现码 |
| --- | --- | --- | --- |
| 禁用原因呈现 | 发送钮 hover CommonTooltip（内容 `sendBlockedReason`） | tooltip 显式禁用（`disabled={!disabledSend || isMobile || !sendBlockedReason}`），改为按钮上叠透明 `btn-send-disabled-hint`，点按 toast 弹原因 | `ComposerToolbar.tsx:892-894`（tooltip）、`:913-925`（C-2 toast 层，仅 `isMobile` 渲染） |
| Enter 发送路径 | `shouldSendOnEnter` 桌面才可能为 true；Enter 触发 `handleSend`，disabledSend 时以 toast 补偿不可见的按钮置灰（与 tooltip 同文案） | `isMobile` 直接 return false，Enter=换行，发送只走按钮 | `ComposerTextarea.tsx:113-125`（C-11 注释）、`InputBarUI.tsx:1326-1337`（`:1331-1336` 为 Enter 场景的原因反馈——这条实际是**桌面主用**的分支） |
| 快捷键提示 | `!isMobile && sendShortcut==='enter' && isComposerEmpty && composerTextareaFocused` 时工具行显示「Enter 发送」 | 不显示 | `ComposerToolbar.tsx:563-570` |

内联提示条 `send-blocked-inline-hint`（`InputBarUI.tsx:2470-2479`，数据 `:1214-1220`）两端共用，不分叉；empty 态刻意不提示（`sendAvailability.ts:117-119` 注释）。

结论：sendAvailability 的「桌面分支」不在算法而在**反馈通道**（tooltip+Enter-toast vs 点按 toast）。两通道文案同源（都走 `resolveSendBlockedReason`），无漂移。

---

## 3. Workbench 窗口 Composer 与经典壳 Composer：实例关系与 isActive 收口

### 3.1 是几套实例

组件代码是**同一套**（`ChatContainer → InputBarV2 → InputBarUI`），但运行时可以有**多个并存实例**，三类宿主：

1. 经典壳：`ChatV2Page`（跟随全局 `currentSessionId`）。
2. Workbench chat 单例窗：`ChatAppWindow.tsx:180` 直接复用完整 `ChatV2Page`（含 ModernSidebar 会话导航，`:164-169`），会话同样跟随全局 `currentSessionId`（`:135-141` 订阅 `current-session-changed`）。
3. Workbench chat-session multi 窗：`ChatSessionWindow.tsx:84-90 → ChatSessionSurface.tsx:101 → ChatContainer`，instanceKey = sessionId，一会话一窗（`register.ts:340-351`）。

状态收口：store 按 sessionId 由 sessionManager 隔离；**同一会话出现在两个窗口时共享同一 store**（`ChatSessionWindow.tsx:7-8` 注释明说，adapter 引用计数见 `ChatSessionSurface.tsx:10-11`）。这意味着 `panelStates` 也是共享的——chat 单例窗与 chat-session 窗同开同一会话时，一边打开附件面板，另一边的 InputBarUI 因 `panelStates.attachment===true` 且 `!isMobile` **也会渲染自己的 body portal overlay**（`InputBarUI.tsx:2558`），两个 overlay 同时可见；且另一实例的 document 级 pointerdown 白名单只认自己的三个 ref（`:1393-1402`），在 A 窗 overlay 内的任何点击对 B 实例都是「外部点击」→ B 调 `closeAllPanels` → 共享 store 置 false → **A 的面板被隔窗关闭**。这是共享 panelStates + 每实例独立 outside-click 监听的合成结果，现码未处理（第 4 节 G-1）。

### 3.2 isActive 如何收口

- 来源：workbench 窗口生命周期 `lifecycle === 'focused'`，经 `AppWindowProps.isActive` 下发（`ChatSessionWindow.tsx:22/86`、`ChatAppWindow.tsx:39`）。
- 收口点：**只到 CSS**。`ChatSessionSurface.tsx:95` / `ChatAppWindow.tsx:174` 写 `data-wb-chat-active`，消费仅 `ChatSessionSurface.css:80-83`（非焦点窗输入区与沙箱展开钮淡化到 0.6 透明度）。有测试锁定该属性（`__tests__/ChatSessionSurface.test.tsx:159-169`）。
- **isActive 不进入 ChatContainer/InputBarUI 的 props 链**（`ChatSessionSurface.tsx:101` 只传 sessionId）。因此：非焦点 Chat 窗的 Esc 监听（document 级，`InputBarUI.tsx:1408-1411`）与 pointerdown 监听照常活跃；焦点窗按 Esc 时，**所有** panel-open 的 Chat 实例都会 closeAllPanels。窗口 zIndex 序（`windowStore.ts:33` Z_BASE=10 起，compact 阈值 2000）对 composer 行为无任何输入。

---

## 4. 与 Agent/workbenchBus 的桌面结合缺口

Agent 侧现有能力（都干净）：chat agentManifest 暴露 `setInput / focusInput / scrollToMessage`（`agentManifest.ts:33-41/65`，setInput 带 postcondition+undo `:139-152`）；activation 经 `register.ts:262-311` 分发，chat-session 以 instanceKey 为会话身份不回落全局（`:302-311`）；focusInput 确认 DOM 焦点后才回执（`:97-136`）。缺口如下：

- **G-1 共享 panelStates 的跨窗互杀**（见 3.1）：同一会话双窗时，overlay 双份渲染 + 隔窗 outside-click 误关。修复方向：面板白名单判定放宽到「任意 `[data-composer-panel-overlay]` 内」，或 panelStates 降为 InputBarUI 实例态/按 windowId 键控。前者一行可修但改产品代码，本轮不动。
- **G-2 `CHAT_V2_OPEN_ATTACHMENT_PANEL` 无会话过滤**（`InputBarUI.tsx:1603-1610`）：Learning Hub 注入一次，所有挂载的 Chat 实例（含不同会话的 chat-session 窗）都开附件面板。事件发射点（`useVfsContextInject.ts:254` 等）也没有带 sessionId。对齐 `CHAT_V2_FOCUS_INPUT` 的 detail.sessionId 过滤（`:1714-1718`）即可，属跨域小改（chat + learning-hub 两侧）。
- **G-3 workbench 窗口生命周期不触发面板收起**：兜底事件只有经典壳的 `app:view-switched`（`InputBarUI.tsx:1436-1441`）。workbench 窗最小化/被遮挡/挂起（isSuspended）时不派发该事件，body portal 的 overlay 不随窗体隐藏——面板开着时最小化窗口，overlay 预计残留在桌面上（锚点隐藏后 `getBoundingClientRect` 归零还会导致面板漂移到视口左上；`ComposerPanelOverlay.tsx:71-75` 只判 anchor 存在不判可见）。**待真机验证**，静态推演成立。修复方向：ChatSessionSurface 把 `isVisible===false` 下沉为一次 closeAllPanels，或 InputBarUI 观察 anchor 可见性。
- **G-4 overlay 的 z 序脱离窗口 z 序**：overlay portal 到 body、固定 `Z_INDEX.composerPanel = 1150`（`ComposerPanelOverlay.tsx:210`、`zIndex.ts:52`），workbench 窗口在自己的层叠上下文内以 10~2000 排序（`windowStore.ts:33/45`）。非顶层 Chat 窗的面板 overlay 与相邻窗口的遮挡关系不由窗口焦点序决定（body 级比较），存在「背后窗口的面板浮在前面窗口之上」的可能。**待真机验证**。与 G-1/G-3 同根：portal-to-body 设计是移动/经典壳时代的假设，workbench 多窗需要「portal 到窗口内」或 z 桥接。
- **G-5 Agent 无面板操作面**：agentManifest 只有输入/滚动三个 capability，没有 openPanel/closePanel；agent 驱动「帮用户挂附件」类流程时无法把附件面板带出来（现在只能靠 G-2 那个无过滤事件）。属能力补全项，不是缺陷。

---

## 5. 第 4–5 轮可做的桌面打磨项（不碰 44px 类名 / coarse 热区）

优先级从高到低；均不触碰 `coarseHitAreaClass` 系（`ComposerToolbar.tsx:54-57`）与任何 `[@media(pointer:coarse)]` / `!h-11` 类名：

- **P-1 面板白名单跨实例识别**（修 G-1 的最小版）：`handleClickOutside` 白名单加 `(target as Element).closest?.('[data-composer-panel-overlay]')`，与既有 `[data-app-menu-id]` 判定（`InputBarUI.tsx:1066`）同款。改动面：`InputBarUI.tsx:1390-1405` 一处。
- **P-2 Esc/点外部关闭后焦点归还 textarea**：对齐 `BlockingInteractionBar` 的 `restoreFocusRef` 心智（`InputBarUI.tsx:2269`）；仅键盘触发（Esc）时归还即可，鼠标点外部不抢焦。改动面：`closeAllPanels` 增可选 focus 参数或在 `handleEscape` 内补 focus。
- **P-3 Esc 分层消费**：当前 Esc 一律 closeAll 且不 `preventDefault`（`InputBarUI.tsx:1408-1411`），面板开着时按 Esc 可能同时触发宿主层其他 Esc 行为。补 `e.preventDefault()`（仅当确实关了面板时）语义更干净。
- **P-4 接线 `onPlacementChange` 方角接缝**：prop 与回调链齐备（`ComposerPanelOverlay.tsx:26/134-138`）但零调用方；gap=0 + placement 驱动锚点方角可实现设计注释里的「从输入栏长出来」效果（`:23-24` 注释）。纯桌面视觉，五个 overlay 调用点逐个接。
- **P-5 workbench 可见性下沉关面板**（修 G-3）：`ChatSessionSurface` 在 `isVisible` 翻 false 时对本会话 store closeAllPanels（一个 useEffect），或经 ChatContainer 传 prop。零 legacy 改动路径存在。
- **P-6 `CHAT_V2_OPEN_ATTACHMENT_PANEL` 补 sessionId**（修 G-2）：InputBarUI 侧按 `detail.sessionId` 过滤 + 三个发射点带 id。注意 learning-hub 侧文件不在本域，需与占该域的会话协调。
- **P-7 model overlay 锚点缺失兜底**：model 面板锚 `runtimeModelTriggerRef`（`InputBarUI.tsx:2582`），该 ref 只在 `onToggleThinking` 存在时才被 ComposerToolbar 挂上（`ComposerToolbar.tsx:598-600`）；宿主不传 onToggleThinking 时外部入口打开 model 面板会因 anchor 为 null 而 `updatePosition` 早退（`ComposerPanelOverlay.tsx:72-73`），面板 `visibility:hidden` 永不出现（`:216`）。低概率但值得兜底到 `inputContainerRef`。

## 6. 越权文件清单（只记账，不改）

| 文件/对象 | 归属 | 观察 |
| --- | --- | --- |
| `ComposerToolbar.tsx:54-57`（coarseHitArea 三档）、`:67`（send 44px 档）、`:876`（stop 44px 档）、`:731`（菜单搜索框 coarse 11 档） | C（移动热区/44px） | 本轮涉读未涉改。质量评审已指出源码 grep 契约脆闩（`docs/0824-quality-review/chat-composer.md:99-101`），若 C 域换渲染断言，P-1/P-4 的桌面改动不会碰这些字符串。 |
| `__tests__/InputBarUI.mobileSplitContract.source.test.ts` | C | 44px 类名计数闩；桌面改动若移动 ComposerToolbar 内代码位置需先看该闩断言范围。 |
| `src/features/learning-hub/useReferenceToChat.ts:355`、`hooks/useVfsContextInject.ts:252-255`、`LearningHubSidebar.tsx:2883-2886` | Learning Hub 域 | G-2/P-6 的事件发射端在此，修复需要跨域改动（发射时带 sessionId）。 |
| `src/features/chat/components/input-bar/ComposerInlinePanel.tsx`、`InputBarUI.tsx:2133-2195` 移动内联面板分支 | C（移动 chrome） | 与桌面 overlay 共用 panelStates/motion；桌面侧任何 panelStates 语义改动（如 P-5）会波及移动关闭路径，需通报 C。 |
| `src-tauri/src/chat_v2/pipeline/tool_loop.rs` 及 hooks | A | 本轮未读未改。 |
| `src/features/workbench/core/windowStore.ts`、`ChatSessionSurface.tsx` | Workbench 壳域（若另有归属） | G-3/G-4/P-5 的落点部分在 surface/壳层；本会话按任务书把「桌面 overlay 语义」认领为本域，但 windowStore z 序方案若要动需再确权。 |

## 验收声明

- 全部结论基于 061b4815 现码静态阅读，行号即现码行号；标注「待真机验证」的两条（G-3 残留、G-4 z 序）为静态推演。
- 本轮零产品改动：仅新增本文档；未运行编译/测试/包管理命令；未 commit/push/PR（按任务书，本文件留待汇总方处置）。
