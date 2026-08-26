# 06 · Android 返回键「菜单叠面板」测试（Wave2-C 第 2 轮 · 测试-back 链）

- 基线：`98bbf3f1`，工作目录 `/tmp/0824-wave2-c-r2-test-back`
- 约束遵守：只写不跑（未执行 npm/vitest/tsc 等），未改任何产品代码，未 git commit
- 目标序列：**菜单开 → back → 面板仍开 → back → 面板关 →（back → native）**

## 产出文件

### 1. `src/app/navigation/__tests__/androidBackCoordinator.menuThenPanel.test.ts`

按指令改用 `menuThenPanel` 命名（避免与卡 4 的 `androidBackCoordinator.stack.test.ts` 撞车；
本地基线上 `src/app/navigation/__tests__/` 原本不存在，撞车风险来自并行分支合并）。

协调器纯函数/栈语义单元测试（4 个用例）+ 产品注册点 source 契约（2 个用例）：

| 用例 | 锁定语义 |
|---|---|
| 面板先注册、菜单后注册：第一次 back 只关菜单 | 同优先级 LIFO（seq 大者先执行），面板 handler 不被触碰 |
| 第二次 back 关面板，第三次返回 false | handler 关闭自身后注销，无陈旧 handler 吞事件；清空后交还 native |
| 顶层 handler 返回 false 让行 | 让行事件继续下传（对应 AppMenu 宿主视图 inert/离屏场景） |
| overlay 档压过 view/navigation 档 | 优先级排序优先于注册顺序 |
| source 契约 · AppMenu | `registerBackHandler(..., BACK_PRIORITY.overlay)` + effect cleanup 注销 + 离屏让行守卫（`closest('[inert]')` / `offsetParent === null`）在源码中存在 |
| source 契约 · InputBarUI | `!isMobile \|\| !hasAnyPanelOpen` 门 + `closeAllPanelsRef.current()` + overlay 档注册在源码中存在 |

用例内用 `createOverlay` 模拟真实组件生命周期：handler 消费事件时同步关闭自身并注销
（对应组件 `open=false` 时 effect cleanup），并用 `afterEach` 统一注销以隔离协调器的模块级栈。

### 2. `src/features/chat/components/input-bar/__tests__/InputBarUI.androidBack.sequence.test.tsx`

真实组件集成测试（不 mock 协调器、不 mock handler），2 个用例：

1. **完整序列**：有状态 Harness 受控托管 `panelStates`（初始 `attachment: true`）与
   AppMenu `open`。先挂载 InputBarUI（面板开 → 注册 overlay handler），再打开 AppMenu
   （后注册 → 栈顶）。连调三次 `handleAndroidBack()`：
   - 第一次：返回 true，菜单关（`onOpenChange(false)`），`[data-composer-panel-inline="attachment"]` 仍在
   - 第二次：返回 true，面板关（`closeAllPanels → onSetPanelState`）
   - 第三次：返回 false（全部注销，native moveTaskToBack）
2. **只开面板**：一次 back 关面板；再 back 返回 false，验证 handler 随关闭注销。

组件集成没有「太重」到需要退化：复用了 `InputBarUI.mobileInlinePanel.test.tsx` 已验证的
最小 mock 集（`usePdfProcessingProgress` / `useTauriDragAndDrop` / `MobileLayoutContext`
的 `isMobile: true`）。协调器单测 + source 契约仍然保留在文件 1 作为双保险。

## 修复前 / 修复后预期（两文件头部均已写入）

- **修复前**（任一回归即测试红）：
  - AppMenu 是自绘浮层（非 Radix），协调器 Escape 兜底探测不到；若未注册 handler，
    back 越过打开中的菜单直接关底下面板，甚至落到 native——「菜单还开着应用先退后台」
  - 若 InputBarUI 未注册，第二次 back 无人消费直接 native
  - 若同优先级按 FIFO，第一次 back 先关面板、菜单残留（层级颠倒）
- **修复后**：两组件都以 `BACK_PRIORITY.overlay` 注册，严格「后开先关」出栈，
  清空后 `handleAndroidBack()` 返回 false。

## 关键 jsdom 适配（写测试时踩到的坑）

AppMenu 的 handler 有离屏让行守卫 `el.offsetParent === null → return false`。
jsdom 不做布局，`offsetParent` 恒为 null，会让菜单 handler 永远让行、测不到目标路径。
集成测试里把 `HTMLElement.prototype.offsetParent` stub 成 `parentElement`
（已挂载即视为在屏，`beforeAll` 定义 / `afterAll` 还原）；守卫本身的存在改由
文件 1 的 source 契约锁定，让行行为由文件 1 的纯函数用例覆盖。

## 风险 / 待第 3 轮验证

- 本轮禁执行，以下断言基于源码静读，需下一轮实际跑 vitest 确认：
  - InputBarUI 在该 mock 集下渲染不抛错（有 `mobileInlinePanel` 先例，风险低）
  - `act()` 内 `handleAndroidBack()` 触发的受控状态回流时序
- 若卡 4 的 `androidBackCoordinator.stack.test.ts` 合入，与本文件 1 存在用例语义重叠
  （栈语义部分），但文件名已错开，不会冲突；可在收敛轮去重。
