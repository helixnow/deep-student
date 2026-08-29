# 0824 Wave2-C 第 7 轮 · 测试员-back 全场景矩阵报告

- 工作目录：`/tmp/0824-wave2-c-r7-back-matrix`（仓库副本，基线 `0f5435a7`，detached HEAD）
- 被测模块：`src/app/navigation/androidBackCoordinator.ts`
- 新增文件：`src/app/navigation/__tests__/androidBackCoordinator.fullScenes.test.ts`（仅测试，未改产品代码，未 commit）
- 执行状态：**未执行**（本轮禁跑 vitest；断言基于对协调器源码 `0f5435a7` 的静态推演）

## 场景覆盖矩阵

| # | 要求场景 | describe / 用例 | 锁死的语义 |
|---|---------|----------------|-----------|
| 1 | 仅面板 | 场景 1 · 仅面板开 | 单 overlay：back 关面板返回 true；handler 随关闭注销，第二次 back 空栈返回 false，且陈旧 handler 不再被调用 |
| 2 | 仅菜单 | 场景 2 · 仅菜单开 | 与面板完全对称（同 overlay 档，无特殊分支） |
| 3 | 菜单+面板 | 场景 3 · 菜单叠面板 | LIFO 栈语义：三按序列 true/true/false；第一次 back 面板 handler 不被触碰；已注销的菜单 handler 不复现 |
| 4 | visibility 守卫让行 | 场景 4 · visibility 守卫（4 用例） | `isElementVisibleForBack` 五分支判定矩阵（null / 断连 / 无布局盒 / visibility:hidden 有布局盒 / 可见）；宿主不可见时守卫在包装层让行、业务 handler 零调用、事件下发低档；可见时消费且保持 overlay 档栈序；宿主中途转 hidden 时同一注册从消费转让行 |
| 5 | Radix 让行 | 场景 5 · Radix 兜底让行（5 用例） | Escape 兜底先于 view/navigation 档消费未注册的 Radix 浮层；显式 overlay handler 不被抢跑（dialog 保持打开、无 Escape 派发）；全员 overlay 档让行时兜底在循环后补跑；`hasOpenRadixOverlayBesides` 的 excluded/非 excluded/关闭恢复/null 四态；无 overlay role 的 `data-state="open"`（accordion）不触发兜底 |
| 6 | 无 handler 返回 false | 场景 6 · 无人消费返回 false（2 用例） | 空栈 + 无浮层 → false；overlay/view/navigation 全员让行时按优先级降序走完全链后仍 false |

共 6 个 describe、13 个 it，全部为纯函数注册 mock handler 驱动 `handleAndroidBack()`，不渲染任何产品组件。

## 关键设计决策

1. **jsdom 布局盒 stub**：jsdom 不做布局，所有元素 `getClientRects()` 恒空。因此「可见宿主」必须显式 stub `getClientRects` 返回非空；反之「无布局盒」场景无需 stub，jsdom 默认即命中——测试注释中已写明，防止后人误删 stub 后误判用例含义。
2. **Radix 关闭行为模拟**：`dismissTopOverlayViaEscape` 把 Escape 派发到 `document.activeElement ?? document` 并冒泡；测试在 document 挂 keydown 监听器，收到 Escape 即把假浮层 `data-state` 置 closed，并记录收到的 key（可断言恰好一次 Escape、不多派发）。
3. **状态回收**：协调器持有模块级 handler 栈，所有注册经 `track()` 登记、`afterEach` 逆序注销 + 清空 `document.body`，断言失败提前退出也不会跨用例污染（沿用 menuThenPanel.test.ts 的既有模式）。
4. **与既有测试的分工**：不重复 order.source.test.ts 的排序表达式源码契约与 menuThenPanel.test.ts 的产品注册点（AppMenu/InputBarUI）source 契约；本文件只做运行时行为矩阵。场景 3 与 menuThenPanel 有意保留少量重叠（矩阵完整性优先），但断言角度不同（本文件额外锁「面板 handler 零调用」「陈旧 handler 不复现」）。

## 静态推演依据（逐场景对照协调器源码）

- 排序 `(b.priority - a.priority) || (b.seq - a.seq)`（L164）→ 场景 3 LIFO 与场景 4 用例 3 的栈序断言。
- Radix 兜底探测仅在首个 `priority < BACK_PRIORITY.overlay` 的 handler 之前触发一次（L176），循环后补跑（L190）→ 场景 5 用例 1/2/3 的时机断言。
- `registerVisibilityGuardedBackHandler` 内部即 `registerBackHandler` 包装（L104-107）→ 场景 4 的让行与栈序断言。
- `OPEN_OVERLAY_SELECTOR` 仅匹配明确 overlay 角色（L115-121）→ 场景 5 用例 5（accordion 不触发）。
- `hasOpenRadixOverlayBesides` 逐个比对 excluded（L131-137）→ 场景 5 用例 4。

## 风险与遗留

- 未执行即交付：`getClientRects` stub 的类型断言（`as unknown as DOMRectList`）与 jsdom `getComputedStyle` 对内联 `visibility` 的反映均为常规用法，但首次实跑仍可能暴露环境差异；建议下一轮以 `npx vitest run src/app/navigation/__tests__/androidBackCoordinator.fullScenes.test.ts` 单文件验证。
- 场景 5 未覆盖 `[data-radix-popper-content-wrapper]` 嵌套选择器分支（menu/listbox 下拉），当前用 `role="dialog"` 代表全部 Radix 浮层入口；如需钉死选择器全集可在后续轮补充。
- `installAndroidBackBridge`（window 桥接安装）不在本矩阵范围内，无对应用例。
