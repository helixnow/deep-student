# 0824 Wave2-C R2 · 桌面波及复核（07-desktop-impact）

- 范围：桌面附件面板内 AppMenu 同类风险核验（对照 R1 `docs/dev/wave2-C-r1/07-overlay.md`）
- 仓库：/workspace，分支 `cursor/0824-wave2-mobile-uiux-a875`，工作树干净（HEAD `98bbf3f1`）——**本轮共享层修复尚未落地**，本报告核验的是拟议修复的桌面波及面
- 模型：claude-fable-5-thinking-high；纯静态审阅，未运行任何构建/测试，未改任何文件

---

## 0. 核心结论（对 R1 §3.1 的重要修正）

**「桌面附件面板内 AppMenu 同样中招」在现行代码中不成立——桌面 ComposerPanelOverlay 附件面板里根本没有 AppMenu。**

证据链（三处共用同一个 `isMobile`，MobileLayoutContext 宽度断点）：

1. `AttachmentPanelBody.tsx` :134-241——头部按 `isMobile` 三元分叉：
   - `isMobile=true`（:134-204）：标题 + 「+添加」+ **AppMenu「更多」**（资源库/拍照/清空，:151-192）+ 关闭；
   - `isMobile=false`（:205-241）：**横排 DsButton**（添加/资源库/拍照/清空/关闭），**无任何 AppMenu**。
2. `InputBarUI.tsx` :2558——`!isMobile && activeComposerPanel === 'attachment'` 才走 `ComposerPanelOverlay`；`isMobile` 时走输入壳内联面板（:2133）。
3. 两处 `isMobile` 同源（InputBarUI :324 `mobileLayout?.isMobile`，经 :2113 `isMobile={isMobile}` 传入面板体）→ **「ComposerPanelOverlay + AppMenu 头部」组合互斥，不可达**。

其余桌面面板体同样干净：`ModelPicker.tsx`、`skills/components/SkillSelector.tsx`、`plugins/chat/McpPanel.tsx`、`plugins/chat/AdvancedPanel.tsx`、`AttachmentInjectModeSelector.tsx`（纯 DsButton）——grep 均无 `app-menu` / `shad/Popover` import。**现行代码桌面宽屏形态下，composer 面板体内不存在任何 portal 到 body 的 AppMenu，P1 案发链（R1 §2.1）无桌面直接复现路径。**

两条限定：

- **窄桌面窗口例外**：`isMobile` 是宽度断点，桌面窗口拖窄后拿到移动布局（内联面板 + AppMenu 头部），鼠标事件序同样 pointerdown→mousedown→click → **该形态下鼠标同样中招**。这属于「移动布局在桌面设备上」，共享层修复自动覆盖，无需 B 单独动作（但 B 回归时应含一条窄窗口用例）。
- **潜在暴露仍在**：`InputBarUI.tsx` :1387-1420 的 pointerdown 监听确认**无 isMobile 门控**（effect 只依赖 `hasAnyPanelOpen`），且 :1390-1405 现状**尚未加 `[data-app-menu-id]` 豁免**。未来任何人在桌面面板体内新增 AppMenu/AppSelect/Popover，立刻复现 P1。共享层豁免修复因此对桌面是「预防性正确」而非「修 bug」。

---

## 1. 哪些共享层修复会自动修桌面（可在本会话动的移动共享层）

| # | 拟议修复（R1 编号） | 文件（双端共享） | 桌面自动生效机理 | 桌面净效果 |
|---|---|---|---|---|
| 1 | `handleClickOutside` 加 `target.closest('[data-app-menu-id]')` 豁免（R1 §2.2） | `InputBarUI.tsx` :1390-1405 | 监听本就无端别门控，豁免同样无门控 | 修掉窄桌面窗口形态的同款 bug；宽屏形态消除潜在暴露。**语义变化见 §3-a，须通报 B** |
| 2 | AppMenu 根容器（:135 区域）同步输出 `data-app-menu-id`（归属精确版前置，R1 §2.2 精确版） | `ui/app-menu/AppMenu.tsx` | 60 个消费点（约 40 组件）双端共用 | 仅新增 data 属性、不改行为——桌面理论零波及，但共享组件任何改动的**全量回归面归 B**（§2-d） |
| 3 | `shad/Popover.tsx` :60-77 外点 mousedown 加同款豁免（R1 §3.2） | `ui/shad/Popover.tsx` :71 | 共享组件，双端同一段监听 | 本轮核验：**未发现实际「Popover 内嵌 AppMenu」用法**——`ankiCardsBlock.tsx`（:1599 Popover 与 :1617 AppMenu 为兄弟）、`QuestionBankEditor.tsx`（AppSelect :1580 与 PopoverContent :2985 相距甚远、非嵌套）。修复属预防性，桌面无既有行为可破坏；仅限动 :60-77 外点判定，**不得碰** :147-189 `resolvePopoverPosition` 等桌面重度依赖的定位逻辑 |
| 4 | Esc 关闭已带 `e.defaultPrevented` 跳过（:1408-1411，现状已正确） | `InputBarUI.tsx` | — | 无需动，列出仅为排除项 |

不自动生效、也不许借道共享层去动的：见 §2、§3。

## 2. 哪些必须留 B（桌面专属行为，本会话禁动）

- **a. DockItem pointerdown（R1 §3.4 的核验答案）**：`workbench/components/DockItem.tsx` :270-277 的 document pointerdown 只收合 `listOpen`（DockWindowList 窗口列表）。核验结论：**DockContextMenu（AppMenu context 模式）以 DockItem 根元素为 asChild 触发器（DockItem.tsx 头注 :8-9），菜单组件挂在 Dock 层级，`setListOpen(false)` 不会卸载它**→ 动作不丢，非 P1 同构。残余问题仅为：窗口列表开着时点 context 菜单项（portal 到 body，`wrapRef.contains`=false）会误收合列表——视觉抖动，低危。是否要 DockItem 认 `[data-app-menu-id]` 属桌面 workbench 交互决策，**留 B**。
- **b. ComposerPanelOverlay.tsx 全部语义**：placement 翻转（:97-99）、宽度/贴边、`overflow-hidden` 裁切模型（:197-198）、zIndex、`onMouseDown stopPropagation`（:220）。它虽在共享目录，但 InputBarUI 只在 `!isMobile` 下渲染它，实质是桌面专属渲染路径。尤其**不得**给它加 `data-overlay-container="true"`（R1 §2.3 已否决：菜单会被 overflow-hidden 裁切）。
- **c. AttachmentPanelBody 桌面横排分支（:205-241）**：若想让桌面也收敛为「更多」菜单（与移动头部对齐），那是桌面 UX 变更，留 B。本会话只许动移动分支（:134-204）。
- **d. AppMenu.tsx 行为性改动的桌面回归**：visualViewport 重定位补齐（R1 §3.5）、子菜单 portal 策略（:977 恒去 body，R1 §3.3）等如需实施，60 个消费点里 DockContextMenu、FilePreviewAppWindow、Settings 全家桶等桌面场景的回归验证归 B；本会话若动 AppMenu.tsx，仅限 §1-2 那种纯增量 data 属性。
- **e. 修复落地后的桌面手工验证**：宽屏「面板开着 + 点页面其它 AppMenu」语义（§3-a）、窄窗口附件「更多」菜单、Dock 列表 + context 菜单并存，均需鼠标实测，静态审阅无法替代，归 B。

## 3. 须向 B 通报的桌面语义变化点

- **a. blanket 豁免的语义变化（§1-1 的代价）**：加豁免后，桌面面板开着时点击页面上任何**无关** AppMenu（如会话条目右键菜单、消息操作菜单）不再顺带关闭 composer 面板（现状会关）。移动端此组合几乎不可达，桌面完全可达。若 B 认为不可接受，走 R1 §2.2 归属精确版（配合 §1-2 的 data 属性）。
- **b. Popover 豁免同理**：桌面 Popover 开着时点任意 AppMenu 不再关 Popover。现无嵌套用法故无既有场景受损，但属行为面变化。
- **c. R1 §3.1 表述修正**：请 B 以本报告 §0 为准——桌面宽屏附件面板无 AppMenu，无需按「桌面已中招」排期验证；改为验证「窄桌面窗口（移动布局）」一条即可。

## 4. 本会话禁改的桌面文件清单

| 文件 | 理由 |
|---|---|
| `src/features/chat/components/input-bar/ComposerPanelOverlay.tsx` | 桌面专属渲染路径（§2-b），任务方明确只读 |
| `src/features/chat/components/input-bar/InputBarUI.tsx` :2553-2650（`panelContainerRef` 装配区，含 :2556 `onMouseDown stopPropagation`） | 桌面 overlay 装配 + mousedown 挡板（R1 §2.2 已警告勿误删）；共享的 :1390-1405 可按 §1-1 动 |
| `src/features/chat/components/input-bar/AttachmentPanelBody.tsx` :205-241 桌面分支 | 桌面头部 UX 归 B（§2-c）；移动分支可动 |
| `src/features/workbench/components/DockItem.tsx` | 桌面 Dock pointerdown（§2-a） |
| `src/features/workbench/components/DockContextMenu.tsx`、`Dock.tsx`、`DockWindowList`（DockItem 内引用） | 桌面 Dock 体系 |
| `src/features/workbench/components/DesktopShortcuts.tsx` | 桌面快捷方式 mousedown（R1 §1.2） |
| `src/features/workbench/apps/preview/FilePreviewAppWindow.tsx` | 桌面 AppMenu 消费点 |
| `src/components/ui/shad/Popover.tsx` :117-345（PopoverContent/定位） | 桌面重度依赖；若做 §1-3 仅限 :60-77 |
| `src/components/ui/app-menu/AppMenu.tsx` 行为性逻辑（定位 :319-395、子菜单 portal :972-1004、外点 :115-131） | 60 消费点桌面回归归 B；仅允许 §1-2 纯增量 data 属性 |

## 5. 免责

- 未运行 npm/npx/node/cargo/tsc/vite/vitest/tauri/CI/computerUse；未改产品代码；未 git commit。
- 行号基于 HEAD `98bbf3f1` 工作树现状；若修复方（移动共享层会话）先行落地，B 验证前请以最新行号重对。
