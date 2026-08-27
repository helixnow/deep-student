# 0824 Wave2-C R7 · 测试员报告 05：读屏顺序（a11y sequence）

- **轮次**：第 7 轮 · 读屏顺序
- **工作目录**：`/tmp/0824-wave2-c-r7-a11y-seq`
- **模型**：claude-fable-5-thinking-high
- **约束遵守**：未执行任何测试（禁令）；未改产品代码；未 commit。

## 产出

新增 1 个 source 契约测试文件（仅新增测试，无产品代码改动）：

```
tests/vitest/mobile-uiux/inlinePanelScreenReader.sequence.source.test.ts
```

3 个 describe / 10 个 it，覆盖任务点名的三件套：**inert 门控、region 名、无 role=img 水位环**，并以「读屏用户自上而下线性消费输入壳」为统一叙事把三者串成一条序列契约：

> [打开的内联面板 = 有名字的 region 地标] → 输入区 → 底部工具栏（水位环 = 真按钮）

## 契约明细

### 1. inert 门控（4 it）

| 断言 | 依据（现源码） |
| --- | --- |
| 每处非注释 `inert` 都引用 `expanded/motionState/closing/closed`（禁无条件 inert） | `ComposerInlinePanel.tsx` effect：`el.inert = !expanded` |
| `aria-hidden={!expanded \|\| undefined}` 存在，且全文件无字面 `aria-hidden="true"/{true}` | 同上，展开态显式撤除（undefined 而非 `"false"`） |
| 门控严格派生自 `motionState === 'open' \|\| 'opening'`（closing 即摘除，不等 closed） | 源码第 56 行 |
| **ghost landmark 禁令**：`ref={contentRef}` 门控容器出现在首个 `role="region"` 之前（region 是门控容器后代，收起时整体从读屏树消失，序列里不残留空壳地标） | 源码 93–123 行嵌套结构 |

其中 ghost-landmark 断言是本轮新增视角：既有 focusOrder/inertClamp 用例只验证「inert 存在且条件化」，未锁「region 必须在门控容器内部」——若有人把 region 提到门控容器外层，旧用例全绿但收起后读屏 rotor 里会多一个空 region。

### 2. region 名（4 it）

- 两条 heightMode 分支（`available` 普通 div / `content` CustomScrollArea）各自 `role="region"` + `aria-label={ariaLabel ?? panelKey}`（计数 ≥2，缺一条就有一半面板 rotor 不可发现）。
- **结构化解析 switch**：从 `switch (inlineRenderPanel)` 切块，断言 case 集合精确等于 `['attachment','model','mcp','advanced','skill']`，且每个 case 体内 `inlineAriaLabel` 赋非空值。相比既有 focusOrder 用例的 `match(...).length >= 5` 计数法，本写法在**新增面板 case 漏配标签**时会精确红在对应 case 名上（`toEqual` 数组失配 + 逐 case 断言消息），不会被其他赋值凑数。
- `ariaLabel={inlineAriaLabel}` 实际接线到 ComposerInlinePanel。
- 读屏顺序锚点：anchor < `{inlineComposerPanelNode}` < `<ComposerTextarea` < `<ComposerToolbar`（DOM 顺序即读屏顺序；与 focusOrder 用例互为印证，本文件从 tests/vitest/mobile-uiux 目录视角独立可跑）。

### 3. 无 role=img 水位环（3 it）

- `role={?["']img` 正则在 `ComposerToolbar.tsx` / `ContextUsagePopover.tsx` / `InputBarUI.tsx` / `ComposerInlinePanel.tsx` 四处全部 miss（正则带引号，不会误伤 ContextUsagePopover 第 92 行注释里的 `role=img+tabIndex` 历史描述）。
- 环形视觉纯装饰：`ContextWindowUsageRing` 函数体切片内，容器 span（`context-window-usage-control`）与 SVG（`context-window-usage-ring`）的开标签都含 `aria-hidden="true"`；环子树无任何 `tabIndex=`（语义单一所有者）。
- 语义落在真按钮：`<AppMenuTrigger asChild>` 包裹的唯一 `<button>`，开标签含 `type="button"` + `aria-label={t('chatV2:tokenUsage.contextWindow')}` + `data-testid="context-usage-popover-trigger"`；popover 全文件无 `tabIndex=`。

## 预期状态

**全绿（契约锁定型，非 TDD 红灯）。** 三项能力在当前基线均已落地（R4 inert 治理 + R3 右簇命中改造把 role=img 水位环替换为真按钮）。因禁止执行测试，未跑 vitest；以下关键事实已用 ripgrep 逐条静态核对：

- `switch (inlineRenderPanel)` 唯一，5 个 case 顺序与断言一致（InputBarUI 2181–2211 行）；
- input-bar 目录内 `role="img"`（带引号形态）零命中；
- `ContextUsagePopover.tsx` 无 `tabIndex=`、`<button` 唯一；
- `ComposerToolbar.tsx` 的 `tabIndex` 仅存于注释（无 `=`，不触发断言）；
- `data-composer-panel-anchor` / `ref={contentRef}` / `aria-hidden={!expanded || undefined}` / `aria-label={ariaLabel ?? panelKey}`（×2）均在位。

## 与既有用例的分工（防重复）

| 文件 | 归属 | 视角 |
| --- | --- | --- |
| `__tests__/ComposerInlinePanel.focusOrder.source.test.ts` | R4 | Tab 顺序、正 tabindex 禁令 |
| `__tests__/ComposerInlinePanel.inertClamp.source.test.ts` | R4 | inert 实现细节 + 高度 clamp |
| `__tests__/ComposerInlinePanel.focusOrder.test.tsx` | R4 | 运行时（jsdom）焦点行为 |
| `tests/vitest/mobile-uiux/inlinePanelScreenReader.sequence.source.test.ts` | **R7 本轮** | 读屏序列三件套：门控完整性（ghost landmark）、地标命名（逐 case）、水位环按钮语义 |

## 风险与备注

- source 扫描的固有局限：切片依赖 `function ContextWindowUsageRing` / `export interface ComposerToolbarProps` 等锚点字符串，重命名/再拆分时用例会显式红（indexOf → -1 → slice 空 → 断言失败），属预期的「强迫显式更新」行为，不会悄悄失效。
- `case '([a-z]+)'` 只匹配全小写 panel key；若未来引入驼峰 key，`toEqual` 数组断言会先红，提示同步更新。
- 真实读屏输出顺序（VoiceOver/TalkBack rotor）不在 source 扫描能力范围，属设备走查项；本文件只锁「源码结构使正确顺序成为必然」的先决条件。
