# 0824 Wave2-C R2 · 04 back 链协同（AppMenu × Composer 面板）

基线 `98bbf3f1`，工作目录 `/tmp/0824-wave2-c-r2-back`。本轮全静态，未执行任何测试/构建，未 commit。

## 1. 静态再核结论：无需改代码，栈语义已保证「后开的菜单先关」

三处证据链（均为第 1 轮结论的逐行复核）：

- **协调器排序**（`src/app/navigation/androidBackCoordinator.ts:116`）：
  `sort((a, b) => (b.priority - a.priority) || (b.seq - a.seq))` —— 优先级降序，同优先级 `seq` 降序，即**同优先级后注册者先执行**。`seq` 在 `registerBackHandler`（:53-60，现为 :64-71）注册时单调递增。
- **AppMenu 注册**（`src/components/ui/app-menu/AppMenu.tsx:102-113`）：
  `useEffect` 以 `actualOpen` 为 gate，菜单打开时 `registerBackHandler(..., BACK_PRIORITY.overlay)`，关闭/卸载时经 effect cleanup 注销。handler 内还有离屏让行判定（`inert` / `offsetParent === null` 时返回 false），不影响本卡场景。
- **InputBarUI 注册**（`src/features/chat/components/input-bar/InputBarUI.tsx:1426-1432`）：
  `useEffect` 以 `isMobile && hasAnyPanelOpen` 为 gate，组合面板（附件/模型/技能/MCP/对话控制）打开时 `registerBackHandler(..., BACK_PRIORITY.overlay)`，面板全关时注销。

**场景推演**（面板先开、菜单后开）：

1. 面板打开 → InputBarUI handler 注册，seq = N。
2. 菜单打开 → AppMenu handler 注册，seq = N+1。
3. 第一次 back：两者同为 overlay(100)，seq 降序 → AppMenu handler 先执行，`setOpen(false)` 返回 true，事件消费。菜单关闭触发 effect cleanup，AppMenu handler 注销。**面板仍开。**
4. 第二次 back：栈里只剩 InputBarUI handler → `closeAllPanels()` 返回 true。**面板关闭。**

反向顺序（菜单先开、面板后开）同理面板先关，栈语义对称成立。底座健康，未动 `handleAndroidBack` 分发顺序、排序算法与 Radix 兜底探测。

## 2. 落地改动

### 2.1 注释登记（只加法）

`androidBackCoordinator.ts` 的 `BACK_PRIORITY.overlay` doc 注释扩充为「同档共存登记」：写明 AppMenu 与 Chat 组合面板同以 overlay 档注册、先后由栈语义（seq 降序）保证、新增同档浮层不要引入 `overlay±1` 魔法数值。数值未改，`handleAndroidBack` 未改。

### 2.2 source 契约测试（新建，只写不跑）

`src/app/navigation/__tests__/androidBackCoordinator.order.source.test.ts`，仿照既有 `pdfSelectionToolbar.source.test.ts` 的源码扫描风格，跨三文件锁住：

| 契约 | 锁法 |
| --- | --- |
| 同优先级后注册先执行 | 正则锁排序表达式 `(b.priority - a.priority) \|\| (b.seq - a.seq)` + `seq: seqCounter++` + `handlers.push(entry)` |
| BACK_PRIORITY 旁有同档登记注释 | `toContain('同档共存登记')` + AppMenu…InputBarUI 邻近正则 |
| AppMenu 注册 | import 来自 `@/app/navigation/androidBackCoordinator` + `}, BACK_PRIORITY.overlay)` + `!actualOpen` gate 邻近 `registerBackHandler` |
| InputBarUI 注册 | 同上 import + overlay 收尾 + `!isMobile \|\| !hasAnyPanelOpen` gate 邻近 `registerBackHandler` |
| 禁魔法数值 | `not.toMatch(/BACK_PRIORITY\.overlay\s*[+-]\s*\d/)` 双文件各一条 |

**红/绿说明**（已写入测试文件头）：修复前若 AppMenu 或 InputBarUI 缺失 `registerBackHandler` 注册，对应用例红；若协调器排序改成 seq 升序（先注册先执行）或去掉 seq 比较，排序用例红；当前基线三处齐全，应全绿。

**静态自证**：本轮虽禁执行,已用 `rg`（含 `-U` 多行模式）逐条验证测试中全部正则均能在当前源码命中(每条恰 1 处),`overlay±N` 反向断言确认无命中。

## 3. 未动清单

- 未改 `handleAndroidBack` 分发顺序、排序算法、Radix Escape 兜底探测。
- 未加代码 helper（`isHandlerVisible` / `getHandlerStackSnapshot`）——静态核对确认无需加固，遵循「只在必须时加」。
- 未触碰禁区文件：`InputBarUI.tsx`、`AppMenu.tsx`、`ComposerPanelOverlay.tsx`、`coordinator.rs` 零改动。
- 未 commit（`git status`：M `androidBackCoordinator.ts`，新增 `__tests__/androidBackCoordinator.order.source.test.ts`）。
