# 0824 Wave2-C R7 · 测试员-浮层 pointer 矩阵 回执

- **模型**: claude-fable-5-thinking-high
- **工作目录**: `/tmp/0824-wave2-c-r7-ptr-matrix`（基线 commit `0f5435a7`，工作树仅新增测试文件，未 commit）
- **产出文件**: `tests/vitest/mobile-uiux/overlayPointerSequence.matrix.source.test.ts`（新建，1 个文件，未改任何产品代码）
- **执行状态**: ⚠️ 按指令**未运行**测试（文件头已注明）。也未跑 tsc/eslint（环境无 node_modules）。

## 矩阵结构（共 27 个用例）

### 路径维度（`describe.each`，owned overlay / closest 双路径）

| 变体 | 构造方式 | 证明什么 |
|---|---|---|
| A. owned-overlay 归属查询 | 渲染树包 `OverlayCoordinatorProvider`，InputBarUI 面板打开窗口内登记 selector `[data-app-menu-id]` | 归属接线后的集成行为 |
| B. closest 兜底 | 不包 Provider → fallback 语义 `isOwnedOverlayTarget` 恒 `false` | 谓词末条 `closest('[data-app-menu-id]')` 兜底路径**独立自足** |

### 场景维度（每个路径变体各跑一遍，2×8=16 个行为用例）

1. **真外点反向对照**（1）：pointerdown 落 body → `onSetPanelState('attachment', false)` 必须发生，防「监听未挂载」假绿。
2. **附件「更多」菜单三动作**（`it.each` ×3）：资源库 / 拍照 / 全部清除。每行走完整链：真实 portal 菜单项 pointerdown → 面板存活（spy 未被调 + 内联面板仍在）→ pointerup → click → 动作真正到达（`CHAT_TOGGLE_PANEL` window 事件 / 隐藏相机 input 收到 click / `onClearAttachments` 被调）。
3. **加号菜单三动作**（`it.each` ×3）：添加文件 / 拍照 / 资源库，动作观察点分别为隐藏文件 input（multiple）、隐藏相机 input、`CHAT_TOGGLE_PANEL`。每行末尾附行内真外点对照（再次 pointerdown body → 关闭必须发生）。
4. **合成 `[data-app-menu-id]` portal 节点**（1）：不依赖真实菜单渲染，直接往 body 挂带属性节点测判定本身。

### owned-overlay 路径隔离（3，仅 Provider 变体可构造）

- **element 登记的无 `data-app-menu-id` 浮层**：借 Provider 内探针拿到与 InputBarUI 同一登记表，以 element 引用补登到 ownerId `input-bar-composer` 下。closest 必不命中（用例内显式断言前提）→ 面板存活只能由归属查询解释，**独证 owned 路径**。
- **不登记对照**：同形态浮层不登记 → pointerdown 关闭面板，证明上条豁免确实来自登记。
- **登记窗口纯函数边界**：`registerOwnedOverlayEntry` / `isEventInsideOwnedOverlay` 真实产品函数——登记期间命中、ownerId 隔离、注销后落空。

### source 契约（8，锁形态防悄悄退化）

外点监听挂 `document pointerdown` 且 handler 走 `isWithinComposerTerritory`；谓词内**归属查询在前、closest 兜底在后**（位置序 + 千字符窗口防漂移）；常量同步（`COMPOSER_OVERLAY_OWNER_ID='input-bar-composer'`、selector `'[data-app-menu-id]'`，测试硬编码值由此契约守护）；登记以 `hasAnyPanelOpen` 为窗口；无 Provider 回退 `isOwnedOverlayTarget: () => false`（fail-empty，closest 因此不可删）；附件「更多」三动作与加号菜单各项 onClick 接线到真实 handler；InputBarUI 把动作接到隐藏 input / 命令事件（保证矩阵动作观察点的真实性）。

## 关键设计决策与调研发现

1. **加号菜单互斥语义（本轮最重要的源码发现）**：`handleAttachmentMenuOpenChange(true)` 会主动 `closeAllPanels()`（InputBarUI.tsx L1513-1519）——加号菜单打开与组合面板**设计上互斥**。因此加号菜单矩阵行不能照搬「pointerdown 前面板 spy 干净」的写法：先断言互斥关闭发生（顺带锁住该产品语义），`mockClear()` 后再单测 pointerdown 是否又触发关闭。受控 prop 在 harness 里保持打开，恰好构造出谓词注释里描述的「面板刚关闭的同一事件窗口」fail-open 边界态（此窗口内外点监听与归属登记均仍挂载）。
2. **断言风格**：完整复用 `InputBarUI.appMenuOutsideClick.pointer.test.tsx` 的套路——`firePointer`（MouseEvent 构造，不依赖 jsdom PointerEvent）、`expectPanelSurvivedPointerDown`（受控 prop 下「被关闭」的唯一可观测信号是 `onSetPanelState('attachment', false)`）、portal 形态前置校验（menu 带 `data-app-menu-id`、挂在 body、不在 input-bar 根内）。全部行为链断言，无「按钮存在」式弱断言。
3. **`.ts` 无 JSX**：按文件名要求用 `React.createElement` 渲染真实 `InputBarUI`；mock 与既有 pointer 测试同套但改用 `@/` alias 指定（`usePdfProcessingProgress` / `useTauriDragAndDrop` / `MobileLayoutContext` isMobile=true / `inputBarCapabilities.canCapturePhoto=true`），vitest 按解析后模块 id 匹配，与相对路径 mock 等效。
4. **双路径隔离方法论**：Provider 变体里 selector 登记与 closest 对 `[data-app-menu-id]` 节点必然同时命中，无法互相区分；故 closest 路径靠「无 Provider（恒 false）」变体独证，owned 路径靠「element 登记 + 无 data 属性节点」独证，两侧各配反向对照。

## 已静态核对的事实（未运行，靠读源码/既有测试佐证）

- `AppMenuContent` portal 目标：trigger `closest('[data-overlay-container="true"]')`，input-bar 生产源无该属性 → 两个菜单都挂 body（与既有测试断言一致）。
- 菜单项顺序 / testid：更多菜单 = 资源库→拍照(能力门控)→全部清除(attachments>0, destructive)；加号菜单移动端扁平 = `plus-menu-add-attachment` / `plus-menu-camera`(能力门控) / `plus-menu-resource-library`；`ComposerToolbar` 全量透传 `isMobile`/`isMobileEnv`。
- `AppMenu` 自身的外点关闭听 `mousedown`（不听 pointerdown），矩阵的 pointerdown 序列不会误关菜单本体。
- 所有 import 的导出存在（`InputBarUI`、`createDefaultPanelStates`、`COMMAND_EVENTS`、`OverlayCoordinatorProvider`/`useOverlayCoordinator`/`OverlayCoordinatorValue`、overlayOwnership 三函数）。

## 风险 / 待验证点（下轮跑测试时优先看）

1. 加号菜单经 `btn-toggle-attachments` 触发器 click 打开（受控 open 经 `handleAttachmentMenuOpenChange` 回写）——既有测试都是直接传 `open`，此路径在 jsdom 里未被现有用例覆盖过；已用 `findByTestId` 容忍异步挂载。
2. `it.each` 行内 `arm`/`pickItem` 为函数成员，vitest `$action` 标题插值应正常，但若格式化异常只影响标题不影响断言。
3. source 契约中 `handleOpenResourceLibrary` / `handleCameraClick` 的 `[\s\S]{0,240}` 窗口按当前源码量出，产品侧在这些 handler 里加长逻辑会需要放宽窗口（属预期的契约红）。

## 交付清单

- [x] 新建 `tests/vitest/mobile-uiux/overlayPointerSequence.matrix.source.test.ts`
- [x] 矩阵覆盖：附件更多三动作 ✓ / 加号菜单 ✓ / 真外点仍关面板 ✓ / owned overlay 与 closest 双路径 ✓（source+合成+真实渲染三层）
- [x] 文件头注明未跑
- [x] 未执行测试、未改产品代码、未 git commit
