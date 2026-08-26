# 0824 Wave2-C 第 2 轮 · 测试-pointer 序列（卡 1 回归测试）

- 模型：claude-fable-5-thinking-high
- 基线：98bbf3f1（工作目录 /tmp/0824-wave2-c-r2-test-pointer）
- 状态：**只写了测试源码，未执行**（本轮禁止 npm/npx/node/vitest；父代理本轮不跑测试）
- 未改任何产品代码（InputBarUI.tsx / AppMenu.tsx / AttachmentPanelBody.tsx 均未动）；未 git commit

## 新增文件

`src/features/chat/components/input-bar/__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx`

风格对照 `InputBarUI.mobileInlinePanel.test.tsx`（相同的 mock 组合 + renderInputBar 帮手），
额外 mock 了 `@/hooks/useMediaQuery`（`(pointer: coarse)` → true）让「拍照」菜单项出现
（全局 vitest.setup 的 matchMedia mock 恒 false，会藏掉相机入口）。

## 针对的基线缺陷（为什么修复前红）

`InputBarUI.tsx` 的 document 级外点监听（`handleClickOutside`，挂在 `pointerdown` 上，
约 L1390–1420）只豁免三个容器：`panelContainerRef` / `composerPanelOverlayRef` /
`inputContainerRef`。而附件面板「更多」AppMenu 的内容层 `createPortal` 到
`document.body`（附件面板树里没有 `[data-overlay-container]` 祖先），节点带
`data-app-menu-id` 属性但不在任何豁免容器内。

结果：在菜单项上 **pointerdown 的瞬间** 就命中 `closeAllPanels()` →
`onSetPanelState('attachment', false)`，附件面板先被关掉，后续 pointerup/click
到不了菜单动作。卡 1 的修复是在外点判定里豁免
`closest('[data-app-menu-id]')` 命中的 portal 节点。

## 用例清单与预期红/绿

| # | 用例 | 基线 98bbf3f1 | 卡 1 落地后 |
|---|------|--------------|------------|
| 1 | sanity：真正的外点（body 上 pointerdown）仍应关面板 | 绿 | 绿（防假绿对照，也防修复把外点关闭整个关掉） |
| 2 | 资源库：真实菜单项 pointerdown→pointerup→click 全链，断言面板未被 pointerdown 关闭 + `CHAT_TOGGLE_PANEL` 事件被派发 | **红**（pointerdown 即 `onSetPanelState('attachment', false)`） | 绿 |
| 3 | 拍照：同全链，断言面板存活 + 隐藏相机 input（`accept="image/*"[capture]`）收到 click | **红** | 绿 |
| 4 | 全部清除：同全链（destructive 菜单项），断言面板存活 + `onClearAttachments` 被调用 | **红** | 绿 |
| 5 | 合成 portal 节点：手动往 body 挂 `[data-app-menu-id]` 节点，在其内层子节点 pointerdown，断言不触发 `onSetPanelState('attachment', false)` | **红** | 绿 |
| 6 | source 契约 a：`document.addEventListener('pointerdown', handleClickOutside)` 仍存在 | 绿 | 绿 |
| 7 | source 契约 b：`handleClickOutside` 函数体内含 `closest('[data-app-menu-id]')` | **红** | 绿（要求修复走 closest 判定） |

## 关键实现说明（保守哲学）

- 不做「按钮存在」式弱断言。三动作都走**真实菜单项**全链：打开 attachment 内联
  面板 → 点 `attachment-panel-more` 打开 AppMenu → 断言菜单内容层确实是
  `document.body` 直挂的 `[data-app-menu-id]` portal、且不在 `input-bar-v2-root`
  内（即基线判「外点」的前提成立）→ 再 dispatch 指针序列。
- 红/绿判定点：`panelStates` 是受控 prop，「面板被 pointerdown 卸载」的可观测
  信号是 `onSetPanelState('attachment', false)`；每个用例在 pointerdown 之后、
  click 之前断言该调用**未发生**，并断言内联面板节点、菜单项节点仍在 DOM。
- 指针事件用 `new MouseEvent('pointerdown', { bubbles: true, ... })` 手工构造
  （经 RTL `fireEvent(el, event)` 包 act），不依赖 jsdom 是否实现 PointerEvent
  构造器；document 级监听只读 `e.target`，与真实 PointerEvent 等效。
- 三个动作的「被调用」断言分别锚在真实副作用上：
  - 资源库 → `window` 上监听 `COMMAND_EVENTS.CHAT_TOGGLE_PANEL`（`handleOpenResourceLibrary` 派发该事件）；
  - 拍照 → 隐藏相机 `<input type="file" accept="image/*" capture>` 的原生 click 监听（`handleCameraClick` 调 `input.click()`）；
  - 全部清除 → `onClearAttachments` prop mock（附件 fixture 无 sourceId / 无 blob previewUrl，避免触碰 `cancelPdfProcessing` / `revokeObjectURL`）。
- 菜单项定位不依赖 i18n 文案：按 AttachmentPanelBody 源码顺序（资源库 → 拍照 →
  全部清除）+ 「全部清除」用 `app-menu-item-destructive` class 唯一定位。
- jsdom 兜底路径也写了（任务允许的两条都做）：用例 5 合成 portal 节点只测外点
  判定；用例 6/7 是 source 契约，锁定修复必须在 `handleClickOutside` 里用
  `closest('[data-app-menu-id]')`。

## 已核实的环境前提（写测试时逐一确认过源码）

- `useOverlayCoordinator` 无 Provider 时有 fallback，AppMenu 可在裸 render 下打开。
- AppMenu 关闭外点监听挂在 `mousedown`，与本测试派发的 `pointerdown/pointerup/click` 不冲突（菜单不会中途自关）。
- `AppMenuItem` click 后才 `setOpen(false)`，动作回调先于关菜单执行。
- 附件面板「更多」按钮 testid `attachment-panel-more` 已由既有用例
  （mobileInlinePanel P1-4）锁定。
