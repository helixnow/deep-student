# Wave2-C R4 · 03 ComposerInlinePanel「inert + clamp」

- 基线：`af0be136`，工作目录 `/tmp/0824-wave2-c-r4-inline-panel`
- 独占文件：`src/features/chat/components/input-bar/ComposerInlinePanel.tsx`
- 新增测试：`src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.inertClamp.source.test.ts`
- 桌面 `ComposerPanelOverlay.tsx` 未改动（测试中有守卫断言）
- 按要求未执行测试、未 git commit

## 1. 收起态 inert + aria-hidden

问题：面板用 `grid-template-rows 0fr→1fr` 做收起动画，closed 时 children 仍挂载，
`overflow-hidden` 只裁视觉——收起后的按钮/输入项依然能被 Tab 聚焦、仍暴露在读屏树里。

实现：

- `expanded = motionState === 'open' || motionState === 'opening'`（已有），
  closing/closed 一律视为收起态。
- 在 `min-h-0 overflow-hidden` 的内容容器（`content`/`available` 两种 heightMode
  的 children 都经过它）上：
  - `aria-hidden={!expanded || undefined}`——收起时从无障碍树移除；
  - `inert` 经 `useEffect` 设置 DOM property：`el.inert = !expanded`。

关于「React 19 支持 inert 属性」：本仓库实际是 **React 18.3.1**（package.json
`"react": "^18.3.1"`），React 18 的 JSX 属性表不识别 `inert`，且 `inert={false}`
会被序列化为 truthy 的 `inert="false"`（反而永久 inert）。因此沿用仓库既有先例
`InlineReveal.tsx` 的 DOM property 模式——版本无关，将来升 React 19 也不需要改。
inert 对整棵子树生效且不可被子级覆盖，同时移除可聚焦性与指针命中。

## 2. clamp 160px 硬下限 → 二段式下限

问题：原值 `clamp(160px, calc(85vh - var(--keyboard-inset, 0px) - 180px), maxHeight)`。
短横屏 + 键盘时 calc 项可为很小甚至负值，但 clamp 无条件保 160px，
面板把输入区撑出屏幕。

实现（二段式，随 `--keyboard-inset`）：

```ts
const availableSpace = `calc(85vh - var(--keyboard-inset, 0px) - 180px)`;
const minHeightFloor = `max(0px, min(160px, ${availableSpace}))`;
const heightValue = `clamp(${minHeightFloor}, ${availableSpace}, ${maxHeight}px)`;
```

语义分段（设 avail = 85vh − keyboard-inset − 180px）：

| 可用空间 | 下限 | 生效高度 |
| --- | --- | --- |
| avail ≥ 160px | 160px | clamp(160px, avail, maxHeight)——与原行为一致，保底 160 |
| 0 < avail < 160px | avail | avail 本身，内容内部滚动消化 |
| avail ≤ 0 | 0px | 0px，绝不为负、绝不撑破 |

- `content` 模式该值作 `maxHeight`（外层 + CustomScrollArea viewport），
  `available` 模式作固定 `height`，两处消费同一个 `heightValue`，行为一致。
- 85vh 基于布局视口 + `--keyboard-inset` 扣除的原设计保留
  （Android adjustResize / iOS overlay 键盘两种模型的注释也保留）。
- 源码中不再存在无条件 `clamp(160px,`。

## 3. 测试（source 契约，未执行）

`ComposerInlinePanel.inertClamp.source.test.ts`，沿用仓库
`*.source.test.ts` 风格（readFileSync + 字符串/正则断言）：

- expanded 严格由 open/opening 推导；
- inert 走 effect + DOM property，依赖数组为 `[expanded]`；
- ref + aria-hidden 挂在共享内容容器上（正则匹配 JSX 结构）；
- 禁止 `clamp(160px,`；断言 `availableSpace` / `minHeightFloor` / `heightValue`
  三段表达式原文；
- 两种 heightMode 消费同一 heightValue；
- 守卫：`ComposerPanelOverlay.tsx` 不含 `inert` 与 `160px`。

## 风险与验证状态

- 未执行测试（按任务约束）；worktree 无 node_modules 也无可用 tsc，
  未能 typecheck。inert 模式与 `InlineReveal.tsx`（主干已编译通过）逐字一致，
  clamp 改动为纯模板字符串，类型风险极低。
- 现有 `InputBarUI.mobileInlinePanel.test.tsx` 等测试无 clamp/inert/aria-hidden
  相关断言，已确认不冲突。
- CSS 嵌套数学函数 `clamp(max(0px, min(160px, calc(...))), calc(...), Npx)`
  为标准合法写法，无兼容性顾虑（inert 与 min/max/clamp 的浏览器基线一致）。
- 基建备注：任务过程中 `/tmp/0824-wave2-c-r4-inline-panel` 被并发进程重置过一次
  （worktree 出现了他轮的 `ComposerInlinePanel.focusOrder.*` 测试文件、我的首次
  修改被回滚）。已重新落盘并经 `git diff` 确认（+32/−5 + 新增 inertClamp 测试）；
  若合并时发现该文件回到基线，可用本报告描述的 diff 重放，暂存副本在
  `/tmp/r4-staging-9785/`。
