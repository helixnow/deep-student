# 0824 Wave2-C 第 1 轮台账 · 01 Composer 移动面（扫描员只读审阅）

- **角色**：扫描员-Composer移动（第 1 轮）
- **模型**：claude-fable-5-thinking-high
- **方式**：纯静态审阅（未运行 npm/npx/node/tsc/vitest/tauri/CI，未改任何仓库文件）
- **基线文档**：docs/dev/mobile-uiux-unify/README.md（五条规范）+ INVENTORY.md + PROGRESS.md + WRAP-UP.md 已读。`docs/0824-quality-review/*` 在本 tip 确实不存在（已核实目录），以任务书 P1–P8/P1–P6 为准。

---

## 一、现状摘要

Composer（聊天输入栏）已完成模块拆分：`InputBarUI.tsx`（2661 行宿主）+ `ComposerToolbar`（底部工具栏）+ `ComposerPlusMenu`（加号菜单，移动端单层扁平 P1-1）+ `AttachmentPanelBody`（附件面板体，桌面/移动共用）+ `ComposerInlinePanel`（移动内联面板容器 P0-1）+ `ComposerPanelOverlay`（桌面 portal 浮层）+ `AttachmentPreviewChips` + `ContextUsagePopover` + `ComposerPanel` primitives。

移动端整体架构是健康的：
- 布局分支统一走 `isMobile`（MobileLayoutContext 断点），面板走内联展开而非 portal 浮层（InputBarUI.tsx:2133-2195、2555-2651 的 `!isMobile` 网关正确）；
- 键盘 inset 走 `useKeyboardInset` 单例 + 焦点门控（InputBarUI.tsx:1049-1086）；
- Android 返回键三层注册齐全（面板 InputBarUI.tsx:1426-1432、AppMenu 自身 AppMenu.tsx:102-113）；
- 输入栏目录内无 ResizablePanel/宽表（grep 零命中）；chips 删除按钮 coarse 常显（AttachmentPreviewChips.tsx:362），无 hover-only 死锁。

但存在一个高危交互缺陷（P1，portal 外点误杀面板）、一处所有权分裂（P2，附件清理三处所有者、chip 路径漏后端取消）、以及一批可维护性/一致性问题（P3 伪元素扩区重叠与双重扩区、P4 coarse 当相机能力代理、P5 内联面板收起无 inert + 硬编码 aria-label + role=img、P6 动态 i18n 键契约盲区）。逐条见下。

---

## 二、P1–P6 逐条核实

### P1 AppMenu portal 外点关闭 —— **属实（高危）**

**指控**：document pointerdown 外点关闭只认三个 ref、不认 `[data-app-menu-id]`。

**证据**：

- 外点关闭 handler（InputBarUI.tsx:1387-1420）只做三次 contains 检查后即 `closeAllPanels()`：
  - `panelContainerRef.current?.contains(target)` — InputBarUI.tsx:1393
  - `composerPanelOverlayRef.current?.contains(target)` — InputBarUI.tsx:1396
  - `inputContainerRef.current?.contains(target)` — InputBarUI.tsx:1400
  - 监听方式为 `document.addEventListener('pointerdown', handleClickOutside)` — InputBarUI.tsx:1414
  - **没有任何 `[data-app-menu-id]` 检查。**
- 而同文件的键盘焦点门控**已经**特判了这一层（M3 修复）：`active.closest('[data-app-menu-id]')` — InputBarUI.tsx:1064-1066，注释明说"AppMenu 内容 portal 在 body 上"。
- AppMenu 内容确实 portal 到 body：`createPortal(<div … data-app-menu-id={ctx.menuId} …>, portalContainerRef.current ?? document.body)` — src/components/ui/app-menu/AppMenu.tsx:491-543；SubContent 同样 portal 到 body — AppMenu.tsx:972-1004。AppMenu 自己的外点关闭都自豁免：`targetElement?.closest('[data-app-menu-id="${menuId}"]')` — AppMenu.tsx:120。

**触发路径**（移动端实锤）：附件内联面板打开（面板 DOM 在 `inputContainerRef` 壳内）→ 点面板头部「⋯ 更多」AppMenu（AttachmentPanelBody.tsx:151-192，含资源库/拍照/全部清除三项）→ 菜单内容 portal 到 body → 用户点任一菜单项 → document pointerdown 命中三 ref 之外 → `closeAllPanels()` 收掉附件面板 → 内联面板卸载连带 AppMenu 及其 portal 卸载 → 菜单项 click 大概率丢失（pointerdown 先于 click 派发）。即：**移动端附件面板的「全部清除 / 资源库 / 拍照」菜单项一点面板就塌，动作可能不生效**。任何内联面板（model/skill/mcp/advanced 的 `renderXxxPanel` 内容）里如果含 AppMenu/portal 下拉，同样中招。

**次级同源问题**：Esc 路径。AppMenu 根级 document keydown 关菜单时**不 preventDefault**（AppMenu.tsx:82-89，只有焦点在菜单内容里的内层 handler 才 preventDefault，AppMenu.tsx:469-472），而 InputBarUI 的 Esc handler 只跳过 `e.defaultPrevented`（InputBarUI.tsx:1408-1411）→ 焦点不在菜单内时按 Esc 会菜单+面板一起关，违反"一次 Esc 关一层"惯例。

**机制建议**：把「什么算 composer 层内」收敛为一个共享谓词（如 `isWithinComposerLayers(target)`），同时供焦点门控（:1058-1068）与外点关闭（:1390-1405）消费，内含三 ref + `closest('[data-app-menu-id]')`（与 M3 同款）。Esc 侧让 AppMenu 根级 handler 关菜单时 `preventDefault`，或 InputBarUI 侧检测 `document.querySelector('[data-app-menu-id]')` 存在时让行。不要在各面板内容里散点 stopPropagation 打补丁。

### P2 附件双所有者 —— **属实（实为三所有者 + 路径不一致）**

附件删除/清空的清理职责（后端取消 `cancelPdfProcessing` + `URL.revokeObjectURL` + ContextRef/pdfStore 清理）分裂在三处：

| 所有者 | cancelPdfProcessing | revokeObjectURL | removeContextRef / pdfStore.remove |
|---|---|---|---|
| store `removeAttachment`（sessionActions.ts:204-245） | ❌ 无 | ✅ :241-244 | ✅ :223-237 |
| store `clearAttachments`（sessionActions.ts:247-306） | ❌ 无 | ✅ :263-272 | ✅ :287-305 |
| UI `AttachmentPanelBody.handleRemoveAttachment`（:109-128） | ✅ :117 | ✅ :125-127 | —（转调 onRemoveAttachment→store 再做一遍） |
| UI `AttachmentPanelBody.handleClearAllAttachments`（:91-107） | ✅ :94 | ✅ :102-104 | —（转调 onClearAttachments→store 再做一遍） |
| UI `AttachmentPreviewChips` chip 上的 X（:352-357） | ❌ **裸 `onRemove(attachment.id)`** | ❌（靠 store 兜） | —（靠 store 兜） |
| 宿主卸载兜底（InputBarUI.tsx:1731-1739） | — | ✅（第三处 revoke） | — |

后果：
1. **语义分叉**：从附件面板删附件会取消后端 PDF/图片处理流水线；从输入区 chip 的 X 删同一附件**不会取消**，后端继续空跑直到轮询超时（InputBarUI.tsx:1749 MAX_POLL_COUNT ≈ 5 分钟）——但轮询列表来自 attachments，附件已删所以轮询也不查了，后端任务纯粹变孤儿。
2. **双重 revoke**：面板路径 UI 层 revoke 后 store 再 revoke 同一 URL（幂等无害，但正是"双所有者"的直接证据）。
3. 移动端主要删除入口恰恰是 chip X（coarse 常显，:362），也就是**最常用的路径走的是最不完整的清理**。

**机制建议**：清理收敛为 store 单一所有者——把 `cancelPdfProcessing(att.sourceId)`（fire-and-forget + 日志）移入 `sessionActions.removeAttachment/clearAttachments`，删除 AttachmentPanelBody.tsx:91-128 的 UI 层重复清理（保留纯 UI 日志亦可），chips 路径自动继承。InputBarUI 卸载兜底 revoke 可留作防泄漏后盾。注意本轮 sessionActions.ts 为只读，此项列入下轮。

### P3 伪元素重叠 / 水位环双重扩区 —— **属实**

- 三档扩区常量：`coarseHitAreaClass`（after:-inset-1）/ `Lg`（-inset-2）/ `Xl`（-inset-2.5）— ComposerToolbar.tsx:54-57。
- 右侧按钮簇容器 `gap-2`（8px）— ComposerToolbar.tsx:575。簇内相邻控件各自向外扩 8-10px：水位环 span 自带 `after:-inset-2`（:211），推理触发器 `coarseHitAreaLgClass`（-inset-2，:617），最小推理钮 `Xl`（-inset-2.5，:832）。8px 间隙 + 两侧各 8px 扩区 = **相邻命中区互相重叠约 8px**，触屏上环/推理/发送的误触边界不可预测（后渲染的 DOM 顺序赢）。
- **水位环双重扩区**：`ContextUsagePopover` 的 AppMenuTrigger 外壳 span 又叠一层 `after:-inset-2`（ContextUsagePopover.tsx:87-95），包着内部 `ContextWindowUsageRing` span 自己的 `after:-inset-2`（ComposerToolbar.tsx:211）——同一控件两层伪元素扩区嵌套，扩区叠加后实际命中范围超出 44px 目标继续向邻居侵入。
- **role=img 语义错误**：环是弹层触发器（点击展开用量明细），却标 `role="img"` + `tabIndex={0}`（ComposerToolbar.tsx:207-211）。读屏用户听到的是"图片"，不知可点；span 非 button，键盘 Enter/Space 无原生激活。
- 另注：停止按钮混用两套口径 `max-md:!w-11 … [@media(pointer:coarse)]:!w-11`（ComposerToolbar.tsx:876），断点与指针能力双轨叠加，是 P4 的又一佐证。

**机制建议**：右簇改为**容器分配触控位**——每个动作外层统一 `min-h-11 min-w-11`（coarse 下）真实占位，取消散点 after:-inset 伪元素（保留给确实不能长高的行内文字链）；水位环只保留外层 trigger 一处扩区，内层 span 改 `aria-hidden` 纯视觉；`role="img"` → 触发器语义（button 元素或 `role="button"` + `aria-haspopup="dialog"` + keydown）。不要再加第四档 -inset 常量。

### P4 (pointer:coarse) 同时当移动+触摸+相机 —— **部分属实**

- **证伪的一半**：布局分支**没有**用 coarse。A-6/P1-6 注释明确声明双轨分裂（InputBarUI.tsx:319-324）：布局一律 `isMobile`（断点），能力才用 `isMobileEnv`。全文核对属实——内联/浮层切换（:2133、:2558 等）、tooltip 禁用（ComposerToolbar.tsx:408）、底部安全区（:2221）全走 isMobile。
- **证实的一半**：`isMobileEnv = useMediaQuery('(pointer: coarse)')`（InputBarUI.tsx:804-808）当前身兼两职：
  1. **触摸**：CSS 层 `[@media(pointer:coarse)]` 扩触控目标，全目录数十处——这是合理用法；
  2. **相机能力**：`isMobileEnv` 直接决定拍照入口是否出现（ComposerPlusMenu.tsx:315、475；AttachmentPanelBody.tsx:172、225），配 `<input capture="environment">`（InputBarUI.tsx:2573）。**coarse 指针 ≠ 有摄像头**：触屏 Windows 笔记本/一体机（primary pointer coarse 的变体）会出现"拍照"入口且 capture 语义错乱；反之带键鼠的平板（primary pointer fine）会丢失相机入口。注释自己也承认这是"触屏设备≈带摄像头的移动设备"的近似（:805-807）。

**机制建议**：相机入口的判定从"指针能力"换成"捕获能力"：优先 `navigator.mediaDevices?.enumerateDevices` 探测 videoinput（Tauri WebView 可行性需验证），或至少叠加平台判定（Tauri 平台 API / UA-CH mobile）与 coarse 求与。触控目标 CSS 继续用 coarse，职责单一化后在 isMobileEnv 命名上改为 `hasCoarsePointer` 避免继续被当"移动环境"复用。

### P5 closing 无 inert；160px min；硬编码 Skills；role=img —— **属实（四小项全实）**

1. **closing 无 inert**：`ComposerInlinePanel` 收起动画期（motionState='closing'，220ms，useDeferredOpen 兜底 InputBarUI.tsx:130-170）内容仍挂载，仅 `grid-rows-[0fr] opacity-0`（ComposerInlinePanel.tsx:50、63-65）。全目录 grep 无 `inert`。视觉被 0fr+overflow-hidden 裁掉，但 DOM 可聚焦——若焦点原本在面板内输入框（如模型搜索），收起期间 Tab/读屏仍能落入不可见区域；`aria-hidden` 也没有。
2. **160px min**：`clamp(160px, calc(85vh - var(--keyboard-inset,0px) - 180px), maxHeight)`（ComposerInlinePanel.tsx:51-54）。小屏 + iOS overlay 键盘场景（如 667px 视口、键盘 inset≈300px）中间值 ≈ 87px < 160px → 钳到 160px 硬下限，面板+输入区总高超出可视视口，输入区被顶出或被顶栏压住。对照桌面 `ComposerPanelOverlay` 的同名常量 `MIN_PANEL_HEIGHT_PX=160` 只用于**翻转 placement**（ComposerPanelOverlay.tsx:10、97-99）而非硬撑高度——内联版把"最小可用高度"误用成了"强制高度下限"。
3. **硬编码面板 aria-label**：`inlineAriaLabel = 'MCP'`（InputBarUI.tsx:2158）、`inlineAriaLabel = 'Skills'`（InputBarUI.tsx:2167-2171）。同文件其他面板都走 t()（:2144、:2165），加号菜单里技能入口也是 `t('skills:title')`（ComposerPlusMenu.tsx:426）。region 地标读屏播报不随语言。
4. **role=img**：见 P3 第三点（ComposerToolbar.tsx:203-212）。

**机制建议**：①/② 在 ComposerInlinePanel 一处解决：`motionState==='closing'` 时给内容容器加 `inert`（React 19 直接属性 / 否则 ref 设置），min 值改为 `max(0px, …)` 或随 `--keyboard-inset` 二段 clamp，键盘态允许面板缩到内容高度以下并内部滚动；③ 两个字符串换 `t('skills:title')` / MCP 既有词条；④ 并入 P3 的水位环重构。

### P6 动态 i18n 键盲区 —— **部分属实（盲区实、缺键否）**

- **盲区属实**：契约测试 `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` 只匹配字面量键（正则 :34），并在注释里自我声明"模板字符串键（如 chatV2:authority.…${preset}）不在匹配范围内"（:16-17）。
- 模板键清单（本次审阅面内）：
  - `t(\`chatV2:inputBar.uploadStage.${attachment.uploadStage || 'reading'}\`)` — AttachmentPanelBody.tsx:333
  - `t(\`chatV2:authority.permissionPreset.hints.${preset}\`)` / `.modes.${preset}` — ComposerPlusMenu.tsx:385、388（移动扁平菜单）；:548、552、554（桌面飞出层，另含 `.shortHints.${preset}`）
  - 相邻链路：`t(option.labelKey, option.defaultLabel)`（ComposerToolbar.tsx:413-415）、`chatV2:injectMode.${mediaTypeKey}.${mode}`（useInputBarV2.ts:261）、`chatV2:inputBar.thinkingDepth.${keySuffix}`（InputBarV2.tsx:146）。
- **当前未造成实际缺键**（已核对 locale JSON）：zh-CN 与 en-US 的 `inputBar.uploadStage` 均含 reading/uploading/creating 三键；`authority.permissionPreset` 的 modes/hints/shortHints 均含全部 4 个 preset。即盲区存在但今天没漏。
- **附加盲区**：契约文件清单（:22-29）只覆盖 6 个文件，**不含** `AttachmentPreviewChips.tsx`（chip.error/chip.ready/chip.pages 等一批字面量键）、`ContextUsagePopover.tsx`、`ComposerInlinePanel.tsx`、`ComposerPanel/ComposerPanel.tsx`（common.close/common.clearSearch）——这些文件的字面量键同样不受双语可解析保护。

**机制建议**：契约测试升级为"模板键前缀 × 枚举域"校验：对已知模板（uploadStage × {reading,uploading,creating}、permissionPreset.{modes,hints,shortHints} × 4 preset、injectMode.{image,pdf} × 3 mode、thinkingDepth × 档位）展开成静态键集逐一 resolve；同时把上述 4 个文件补进 SPLIT_INPUT_BAR_FILES。不要靠"记得同步词条"的口头约定。

---

## 三、五条规范核验表（Composer 移动面）

| # | 规范 | 结论 | 证据 |
|---|---|---|---|
| 1 | 全局顶栏唯一（useMobileHeader→UnifiedMobileHeader） | **符合** | chat-v2 经 `useMobileHeader('chat-v2', …)` 注册（src/features/chat/pages/useChatPageLayout.tsx:168）；Composer 自身不自绘顶栏，内联面板头部（附件计数行等）是面板内容而非页级 chrome |
| 2 | 左侧按钮语义（主入口☰/次级后退，不双返回） | **符合** | Composer 工具行左侧是「+」菜单（功能入口，非导航），页级左键归 UnifiedMobileHeader；输入栏内无自绘返回键 |
| 3 | 右侧≤2 个 44px 动作 | **部分符合** | 顶栏侧不归本组件。工具行右簇（ComposerToolbar.tsx:575-929）常态含水位环+推理/模型触发+语音插槽+发送，共 3-4 个交互件；44px 靠伪元素扩区凑数且相邻扩区重叠（见 P3），发送/停止本体 44px 达标（:67、:876） |
| 4 | 禁桌面组件滥用 | **符合** | 输入栏目录零 ResizablePanel/宽表；桌面 portal 浮层全部 `!isMobile` 网关（InputBarUI.tsx:2558、2578、2601、2621、2637），移动走内联面板；chip 删除 coarse 常显（AttachmentPreviewChips.tsx:362）；tooltip 移动禁用（ComposerToolbar.tsx:408） |
| 5 | 可达且可回退 | **基本符合，有一处高危例外** | 面板：Android 返回键（InputBarUI.tsx:1426-1432）+ Esc（:1407-1411）+ 外点收起（:1387-1420）+ 视图切换收起（:1436-1441）；AppMenu 自身也注册返回键（AppMenu.tsx:102-113）。例外：P1 外点误杀使 portal 菜单内的操作"点了等于关面板"，破坏可达性 |

---

## 四、已有测试覆盖与缺口

**已有**（均已通读）：
- `InputBarUI.mobileInlinePanel.test.tsx`：内联面板取代 portal、model 面板走内联插槽、无重复模型 chip、附件头部折叠为 ⋯ 菜单（P1-4）。
- `InputBarUI.mobileSplitContract.source.test.ts`：拆分归属、legacy InputBar 弃用、coarse 类名计数（≥7 / ≥5）、OCR stage 文案归属。属于"类名字符串快照"式契约，能防回退但不验行为。
- `ComposerPlusMenu.test.tsx`：桌面飞出层（模式/预设/危险确认/技能内嵌/知识库/互斥/连接器）+ 移动扁平菜单三条（无子菜单、技能跳内联、连接器直出）。覆盖良好。
- `InputBarUI.attachmentPreviewChips.test.tsx`：chip 渲染/删除回调/hover 与 coarse 常显/截断/发送停止黑钮/队列模式 Enter 语义。
- `inputBarSplitI18nKeys.contract.test.ts`：字面量键双语可解析 + more/close aria-label 锁定。

**缺口**（按风险排序）：
1. **P1 无任何测试**：没有"面板打开时，pointerdown 落在 `[data-app-menu-id]` portal 内不应触发 closeAllPanels"的用例。这是本轮最高危缺陷且完全裸奔。
2. **P2 chip 删除路径的清理语义无测试**：chips 测试只断言 `onRemoveAttachment` 被调用，不校验 cancelPdfProcessing/revoke 是否发生；面板删除与 chip 删除的行为等价性无契约。
3. **i18n 契约双盲区**：模板键不校验（测试自述）+ 文件清单缺 AttachmentPreviewChips/ContextUsagePopover/ComposerInlinePanel/ComposerPanel。
4. **ComposerInlinePanel 无独立测试**：closing 期焦点可达性（inert）、clamp 高度策略均无覆盖。
5. **触控目标契约是类名计数**（mobileSplitContract :51、:55），对 P3 的"扩区重叠"完全不敏感；硬编码 'Skills'/'MCP' aria-label 亦无契约拦截。
6. **Esc 单层关闭语义**（P1 次级项）无测试。

---

## 五、下轮建议（同文件同轮单人）

| 优先 | 文件 | 修什么 | 对应痛点 |
|---|---|---|---|
| 1 | `src/features/chat/components/input-bar/InputBarUI.tsx` | 外点关闭加 `[data-app-menu-id]` 豁免（与 :1066 同谓词，建议抽共享函数）；顺手把 :2158/:2171 硬编码 aria-label 换 t() | P1 + P5③ |
| 2 | `src/features/chat/core/store/sessionActions.ts` | removeAttachment/clearAttachments 内收编 cancelPdfProcessing，成为清理单一所有者 | P2 |
| 3 | `src/features/chat/components/input-bar/AttachmentPanelBody.tsx` | 删 UI 层重复清理（:91-128），依赖第 2 项先落地——**建议 2+3 同一人同轮打包**，避免中间态双取消 | P2 |
| 4 | `src/features/chat/components/input-bar/ComposerToolbar.tsx` + `ContextUsagePopover.tsx` | 右簇触控位改容器占位、水位环单层扩区、role=img→button 语义（两文件是同一控件的内外层，同一人） | P3 + P5④ |
| 5 | `src/features/chat/components/input-bar/ComposerInlinePanel.tsx` | closing 期 inert/aria-hidden；min 高度键盘态可压缩 | P5①② |
| 6 | `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` | 模板键枚举展开校验 + 补 4 个文件进清单 | P6 |
| 7 | `src/components/ui/app-menu/AppMenu.tsx`（谨慎，全局组件） | 根级 Esc handler preventDefault，实现单层关闭 | P1 次级 |

新增测试建议（可与对应修复同人）：P1 的 pointerdown-portal 回归测试挂在 InputBarUI 测试族；P2 的删除路径等价性契约挂在 sessionActions 或集成层。

**边界确认**：本轮未触碰 coordinator.rs、tool_loop/hooks/缓存、Composer 桌面专属行为（桌面 overlay/飞出层逻辑仅作对照引用）、anki/qbank 域逻辑;仓库零改动。
