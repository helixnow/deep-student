# 0824 Wave2-C R4 · 05 读屏顺序：内联面板展开的焦点顺序

- 轮次：Wave2-C 第 4 轮「读屏顺序」
- 模型：claude-fable-5-thinking-high
- 工作目录：/tmp/0824-wave2-c-r4-focus-a11y
- 约束遵守：未执行任何测试、未 git commit、未改产品代码（仅新增测试文件）

## 产出文件

1. `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.focusOrder.source.test.ts`
   （静态源码断言，主体）
2. `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.focusOrder.test.tsx`
   （运行时 DOM 断言，配套；镜像同目录 `InputBarUI.mobileInlinePanel.test.tsx` 的已验证 mock 组合）

## 源码事实（断言依据）

### 实际 Tab 顺序：**内联面板 → 输入区 → 工具栏**

任务给的顺序假设是「输入区 → 工具栏 → 内联面板（或反过来）」。以源码 DOM
顺序为准核实后，**实际顺序是反的**：内联面板在输入壳内部、输入区**上方**
随文档流长出（`InputBarUI.tsx` 注释原话：「面板在输入壳内部、输入区上方随
文档流展开（顶起消息区）」）。输入壳（`data-composer-panel-anchor`，
InputBarUI.tsx L2238-2251）内的子节点顺序为：

| DOM 序 | 节点 | 位置（InputBarUI.tsx） |
|---|---|---|
| 1 | `{inlineComposerPanelNode}`（打开的内联面板渲染槽） | L2265 |
| 2 | `<ComposerTextarea>`（输入区，`data-testid="input-bar-v2-textarea"`） | L2450 |
| 3 | `<ComposerToolbar>`（底部工具栏，发送键 `btn-send` 收尾） | L2490 |

两份产出中均无正 tabindex（并新增断言禁止出现），因此 Tab 顺序即上表 DOM
顺序，与视觉自上而下一致。测试注释里已写清实际顺序。

### 面板 open 语义（现状即满足，断言为绿）

`ComposerInlinePanel.tsx` 两条渲染分支（`heightMode: 'available'` 的普通 div
与 `'content'` 的 CustomScrollArea）都渲染 `role="region"` +
`aria-label={ariaLabel ?? panelKey}`（L73-74 / L85-86）；`InputBarUI.tsx`
对 attachment/model/mcp/advanced/skill 五个 case 都赋了人类可读的
`inlineAriaLabel`（L2148-2183）并透传 `ariaLabel={inlineAriaLabel}`。
源码中当前不存在任何 `aria-hidden` / `inert`。

### closing/closed 时 inert（卡 3 前红，落地后转绿）

收起动画只是 `grid-rows-[0fr]` + `overflow-hidden` 视觉裁切
（ComposerInlinePanel.tsx L63-70），`shouldRender` 在 220ms 收起期内仍为
true（useDeferredOpen，InputBarUI.tsx L131-171），面板 DOM 及其中按钮在
closing/closed 期间仍挂在树上——当前**没有任何 inert 治理**（全目录 grep
确认 0 处实现）。

## 断言清单

### source.test.ts（静态，5 个用例）

1. **两条高度分支都是可命名 region**：`role="region"` 与
   `aria-label={ariaLabel ?? panelKey}` 各 ≥2 处（只有 1 处 = 有一半面板读屏不可发现）。
2. **五个内联 case 都提供 ariaLabel**：`ariaLabel={inlineAriaLabel}` 存在，
   且非空 `inlineAriaLabel = …` 赋值 ≥5 处。
3. **open 面板不许被无条件隐藏**：禁止 `aria-hidden="true"/{true}` 字面量；
   对每一处非注释 `inert` 出现取 ±160 字符上下文窗口，要求引用
   `expanded|motionState|closing|closed`（即必须按展开态条件化，裸
   `inert`/`inert=""` 恒真 hack 均判失败）。
4. **【卡 3 落地后转绿】collapsed 面板必须 inert**：在
   `ComposerInlinePanel.tsx` 或 `InputBarUI.tsx` 的内联面板包装块中，至少
   1 处按展开态门控的 inert 实现。上下文窗口方案对三种落地形态都兼容：
   JSX 条件 prop（`inert={!expanded}`）、React 18 空串 hack
   （`inert={expanded ? undefined : ''}`，本仓是 React 18.3，布尔 prop 不直通）、
   ref 命令式赋值（`node.inert = !expanded`）。
5. **Tab 顺序 = DOM 顺序**：`data-composer-panel-anchor` <
   `{inlineComposerPanelNode}` < `<ComposerTextarea` < `<ComposerToolbar`
   的源码 index 全序断言（四个锚点缺一即失败，防拆分改名后悄悄失效）；
   并禁止 InputBarUI / ComposerInlinePanel 出现正 `tabIndex`。

### .test.tsx（运行时，2 个用例，当前应为绿）

1. **open 面板 = 带标签的 region**：渲染移动端 InputBarUI（attachment 打开），
   `data-panel-motion ∈ {opening, open}`；region 存在且 `aria-label` 非空；
   `region.closest('[inert]')` / `closest('[aria-hidden="true"]')` 均为 null。
2. **DOM（=Tab）顺序**：用 `compareDocumentPosition` 断言
   面板 region → textarea（`input-bar-v2-textarea`）→ 发送键（`btn-send`）
   的文档全序；断言面板内确有可聚焦控件（顺序断言落在真实 Tab 停靠点上，
   而非「按钮存在」）；断言整个输入栏无正 tabindex。
   closing/closed 的 inert 运行时断言**有意不放本文件**（会在卡 3 前把整个
   文件红掉），由 source 测试第 4 条承担红→绿信号。

## 「不许只断言按钮存在」的满足方式

没有任何用例以「某按钮渲染了」作为通过条件。所有用例都断言**关系与语义**：
源码 index 全序 / `compareDocumentPosition` 文档序、region 可命名性、
inert 的条件化门控、正 tabindex 禁令。运行时用例中对面板内可聚焦控件的
存在性检查仅是顺序断言的前置（保证顺序断言作用在真实焦点停靠点上），
并叠加了它相对 textarea 的顺序断言。

## 预期红绿状态

| 用例 | 当前 | 卡 3 落地后 |
|---|---|---|
| source #1/#2/#3/#5 | 绿 | 绿 |
| source #4（collapsed inert） | **红** | 绿 |
| runtime #1/#2 | 绿 | 绿 |

## 风险与备注

- 按任务约束未执行测试；环境未装依赖（无 node_modules），也未做 tsc
  typecheck。运行时测试的 mock/渲染路径与同目录已在 CI 通过的
  `InputBarUI.mobileInlinePanel.test.tsx` 完全一致（同 render helper、同三个
  vi.mock、同 panelStates 构造），选择器均为源码中的稳定 testid。
- 若卡 3 把 inert 落在完全不同的位置（如 CustomScrollArea 内部转发），
  source #4 的「ComposerInlinePanel.tsx + InputBarUI 内联包装块」双源检查
  可能需要补一个源文件，属预期内的小改动。
- source #3 的注释行过滤会跳过 `//`、`*`、`/*` 开头的行，本仓中文注释大量
  讨论 a11y 方案，不过滤会误报。
