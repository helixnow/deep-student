# 07 · 测试-命中（0824 Wave2-C R3 · claude-fable-5-thinking-high）

工作目录 `/tmp/0824-wave2-c-r3-hit-tests`，基线 `e90fb360`。只写不跑（禁 vitest），
预期红/绿全部写进各文件头。未改任何产品代码，未 git commit。

## 产出文件

| 文件 | 类型 | 基线 e90fb360 | 机制落地后 |
| --- | --- | --- | --- |
| `src/features/chat/components/input-bar/__tests__/ComposerToolbar.hitTarget.source.test.ts` | source 契约 | 3 条红（右簇 after:-inset 引用 ×2、水位环双重扩区） | 全绿 |
| `src/features/chat/components/input-bar/__tests__/ComposerToolbar.adjacentHit.test.tsx` | jsdom 渲染 | 2 条红（右簇渲染类名、几何推演重叠/偷点） | 全绿 |
| `tests/vitest/mobile-uiux/touchTargetOwnership.contract.test.ts` | 跨文件所有权契约 | 1 条红（环命中区双所有者） | 全绿 |

## 契约内容

### 1. source 契约（hitTarget.source.test.ts）

- **右簇不再用 after:-inset 默认扩区**：`{/* 右侧按钮 */}` 起的切片不得含
  `after:-inset` 字面量，也不得引用「初始化式（直接或传递）含 after:-inset 的样式常量」。
  常量污染做了固定点闭包（`iconButtonClass = cn(..., coarseHitAreaClass)` 这类二级引用
  也算），但常量本身允许留给左簇（加号菜单按钮）——任务只约束右簇。
- **水位环无双重扩区**：`ContextWindowUsageRing` 函数切片 + `ContextUsagePopover`
  的 `<AppMenuTrigger>` 切片合计 `after:-inset` ≤ 1。基线为 2（`ComposerToolbar.tsx:211`
  环 span 与 `ContextUsagePopover.tsx:90` 触发器 span 各一个 `-inset-2`），这是真实的
  双重扩区。允许唯一所有者保留一处，也允许两处都改实尺寸方案——不锁实现。
- **所有权保留**：右簇全部 testid 存在（水位环 ×2、推理 ×4、发送/停止/禁用提示 ×3、
  popover ×2）、右簇顺序 环→推理→发送 不变、`[@media(pointer:coarse)]` 机制仍存在
  （机制无关断言，只验存在不数次数）。
- **弃尺寸计数**：文件内没有任何 `match(...)?.length >= N` 类计数断言，文件头写明理由。

### 2. jsdom 相邻命中（adjacentHit.test.tsx）

jsdom 降级已在文件头写清，不假装测到真像素：

- jsdom 无布局：`document.elementFromPoint` 未实现、`getBoundingClientRect` 全 0、
  `::after` 不进 DOM。因此**没有**直接调 elementFromPoint 的用例。
- 降级为两层：
  1. **渲染类名契约**（比 source 扫描强，覆盖 `cn()` 运行时拼接）：右簇 DOM 内含
     `after:-inset` 的元素必须 ≤1 且只允许在环子树内；推理/发送子树为 0。
  2. **getBoundingClientRect mock 几何推演**：按 flex 契约 mock 基础盒
     （gap-2=8px；环 28×32、推理触发器 96×32、发送 44×44），扩区量从**真实渲染的
     className** 解析 `[@media(pointer:coarse)]:after:-inset-N`（含 -x/-y 变体、
     2.5 等小数刻度），用「DOM 靠后者绘制在上」的绘制序命中模型断言：
     相邻有效命中盒不重叠；紧贴环右缘外 2px 的落点不得被更远的推理触发器偷走。
     坐标是推演值，被测对象是组件真实输出的扩区类。
- 基线红的数值依据：右簇 `gap-2` 仅 8px，`-inset-2` 每侧扩 8px → 环与推理触发器的
  命中盒在缝隙里重叠 8px，DOM 靠后的推理触发器伪元素叠在上面偷走缝隙点击。
- 基线也应绿的所有权用例：控件互不嵌套（点击不可能冒泡串扰）、DOM 顺序、
  点击互不串扰（推理触发器→onThinkingMenuWillOpen 不触发 onSend；发送→onSend；
  停止→onStop）、禁用提示覆盖层 `inset-0` 与发送按钮同界不外扩（toast 走
  showGlobalNotification mock）。停止按钮用例顺带锁定它已是目标机制样板
  （coarse 实尺寸 44px、无伪元素扩区）。

### 3. 跨文件所有权（touchTargetOwnership.contract.test.ts）

- 登记表：12 个触控 testid → 唯一生产所有者文件（ComposerToolbar 9、
  ContextUsagePopover 2、ComposerPlusMenu 1），断言「存在于所有者文件」+
  「全 input-bar 生产源中恰好一个所有者」（递归扫描、排除 `__tests__`，带防空断言）。
- 环命中区单一所有者（跨 ComposerToolbar/ContextUsagePopover 合计 ≤1，基线红）。
- 每个所有者文件仍有 `[@media(pointer:coarse)]` 处理（机制无关、不数次数）。

## ⚠️ 给机制落地轮的两个必办事项

1. **既有测试互斥**：`InputBarUI.mobileSplitContract.source.test.ts:41-43` 断言
   toolbar 源码**包含** `[@media(pointer:coarse)]:after:-inset-2`，与本轮契约方向
   相反。机制落地时必须同步改写/删除该断言，否则新旧测试互斥、必有一边红。
   同文件 49-56 行还有 min-h-11/h-11 计数断言（≥7 / ≥5），属于本轮明确弃用的
   尺寸计数风格，建议一并清理（不强制）。
2. **单一所有者归属建议**：若保留一处扩区，建议留在 `ContextUsagePopover` 触发器
   （交互所有者）并删环 span 的那份；若改实尺寸方案则两处全删。两种走法本轮
   测试都放行（≤1 合计）。

## 验证状态

按任务约束未运行任何 runner。人工核对过：AppMenu 内容为 portal + 仅 open 时挂载
（右簇类名扫描不会被闭合菜单污染）；testid 唯一性在基线生产源中成立（所有权用例
基线即绿）；渲染依赖（react-i18next 别名 mock、canvas getContext 降级、
UnifiedNotification mock）与既有 `InputBarUI.*.test.tsx` 的套路一致。
