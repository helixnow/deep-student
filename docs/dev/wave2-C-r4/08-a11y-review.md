# Wave2-C R4 · 审阅 08：a11y 复核（审阅员-a11y）

- 轮次：0824 Wave2-C 第 4 轮
- 审阅范围:ComposerInlinePanel inert/aria-hidden/clamp、InputBarUI 内联面板 aria-label i18n、焦点顺序测试质量、ComposerToolbar 水位环 role=img 残留
- 结论:**四项全部通过,无翻案,零补丁。**
- 约束遵守:未执行测试(纯源码静态复核),未修改任何源码/测试文件。

---

## 1. ComposerInlinePanel:inert / aria-hidden / clamp ✅ 通过

文件:`src/features/chat/components/input-bar/ComposerInlinePanel.tsx`

### 1.1 inert 已正确挂上(方向正确)

```61:65:src/features/chat/components/input-bar/ComposerInlinePanel.tsx
  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = contentRef.current as (HTMLDivElement & { inert: boolean }) | null;
    if (el) el.inert = !expanded;
  }, [expanded]);
```

- `expanded = motionState === 'open' || motionState === 'opening'`(L56),即 closing/closed 时 `el.inert = true`,展开态 `false`。**方向正确,未反。**
- 走 DOM property 而非 JSX 属性是对的:React 18 JSX 不识别 `inert`,`inert={false}` 会序列化成 truthy 的 `inert="false"`,反而把展开面板锁死。effect 依赖 `[expanded]`,ref 挂在两种 heightMode 共用的 `min-h-0 overflow-hidden` 容器上(L93-96),content/available 两条分支的 children 都被覆盖。
- 首帧细节:`useDeferredOpen` 初帧为 `opening`,属于 expanded,effect 挂载后置 `inert = false`,展开路径不会被误伤。

### 1.2 aria-hidden 方向正确(未反)

```95:95:src/features/chat/components/input-bar/ComposerInlinePanel.tsx
        aria-hidden={!expanded || undefined}
```

- 收起(`!expanded === true`)→ `aria-hidden="true"`;展开 → `false || undefined` → 属性整个不渲染。**不存在"展开时被 aria-hidden 抠掉"的反向 bug。**
- 与 inert 挂在同一容器,读屏树与 Tab 焦点同步隔离。

### 1.3 clamp 二段式下限正确

```70:75:src/features/chat/components/input-bar/ComposerInlinePanel.tsx
  const availableSpace = `calc(85vh - var(--keyboard-inset, 0px) - 180px)`;
  // 二段式下限：可用空间 ≥160px 才保底 160px；不足（短横屏 + 键盘）时下限退化
  // 为可用空间本身并靠内部滚动消化，max(0px, ...) 兜底防止负值。
  // 禁止无条件 clamp(160px, ...)——那会在极端视口把面板撑出屏幕。
  const minHeightFloor = `max(0px, min(160px, ${availableSpace}))`;
  const heightValue = `clamp(${minHeightFloor}, ${availableSpace}, ${maxHeight}px)`;
```

- 全文件已无无条件 `clamp(160px,` 字面量;下限是 `max(0px, min(160px, 可用空间))`,短横屏 + 键盘时退化为可用空间本身,`max(0px, …)` 兜底防负值。
- `heightValue` 同时喂给 available 分支的 `height`(L106)与 content 分支的 `maxHeight`(L117-118,含 CustomScrollArea viewport),两条渲染路径受同一约束。
- 与 `ComposerInlinePanel.inertClamp.source.test.ts` 的全部断言逐条比对(expanded 推导、effect 形态、共用容器正则、`clamp(160px,` 禁令、二段式公式、桌面 Overlay 无 inert/160px),**源码与契约一致,该测试静态判定应为绿。** 另核实 `ComposerPanelOverlay.tsx` 确无 `inert` 与 `160px` 字面量。

## 2. InputBarUI:Skills / MCP aria-label 走 t() ✅ 通过

文件:`src/features/chat/components/input-bar/InputBarUI.tsx`(L2147-2194,内联面板 switch)

五个 case 的 `inlineAriaLabel` 赋值全部经 i18n:

| case | 赋值 | zh-CN | en-US |
|---|---|---|---|
| attachment | `t('analysis:input_bar.attachments.title')` | 附件 | Attachments |
| model | `runtimeModelTitle` = `t('chatV2:inputBar.runtimeModelTitle')`(L1020) | 模型 | Model |
| mcp | `t('analysis:input_bar.mcp.title')` | MCP工具 | MCP Tools |
| advanced | `t('common:chat_controls')` | 对话控制 | Chat Controls |
| skill | `t('skills:title')` | 技能 | Skills |

- 全文件 grep `['"](?:MCP|Skills)['"]` 零命中——不存在硬编码英文字面量。
- 五个 key 在 zh-CN / en-US 两侧 locale JSON 中均存在且非空(已逐 key 核实)。
- 与 `InputBarUI.inlinePanelAriaI18n.source.test.ts` 的三组断言(无硬编码、两处 t() 调用、双语 key 存在)逐条比对一致,静态判定应为绿。

## 3. 焦点顺序测试:不是"只断言按钮存在" ✅ 通过

文件:`__tests__/ComposerInlinePanel.focusOrder.test.tsx`(运行时)+ `__tests__/ComposerInlinePanel.focusOrder.source.test.ts`(静态)

运行时测试断言了**真实顺序关系**,不止存在性:

- `precedes()` 基于 `compareDocumentPosition` 的 `DOCUMENT_POSITION_FOLLOWING` 位断言文档序:`region → textarea → btn-send` 三段顺序 + `focusableInPanel → textarea`(L118-120)。查找面板内可聚焦控件(L111-114)只是顺序断言的前置条件——找到后立即参与 `precedes` 顺序断言,而非断言完存在就结束。
- 补充断言"无正 tabindex 重排"(L123-126),保证「DOM 顺序 = Tab 顺序」的前提成立,顺序断言才有效力。
- region 语义用例(L85-99)另断言:aria-label 非空、无 `[inert]` / `[aria-hidden="true"]` 祖先——与第 1 项的展开态互为对偶。
- 静态测试补断言源码顺序(anchor → 面板槽 → `<ComposerTextarea` → `<ComposerToolbar` 的 indexOf 序)与两文件的正 tabIndex 禁令。
- 测试锚点核实:`input-bar-v2-root`(InputBarUI L2210)、`input-bar-v2-textarea`(ComposerTextarea L140)、`btn-send`(ComposerToolbar L901)均真实存在;`data-panel-motion` 接受 `opening|open` 兼容 useDeferredOpen 初帧。

## 4. ComposerToolbar:水位环无 role=img 残留 ✅ 通过(第 3 轮改动确认落地)

文件:`src/features/chat/components/input-bar/ComposerToolbar.tsx`(`ContextWindowUsageRing`,L115-244)

- 整个 input-bar 目录 grep `role="img"` / `role='img'` **零命中**。
- 水位环现为纯视觉内层:外层 `<span data-testid="context-window-usage-control">` 与内部 `<svg data-testid="context-window-usage-ring">` 均 `aria-hidden="true"`(L211、L219),无 tabIndex、无伪元素命中区。
- 可访问名与交互语义收敛到 `ContextUsagePopover.tsx` 的 `<button>` 触发器(L93-98):`aria-label={t('chatV2:tokenUsage.contextWindow')}`(zh「上下文窗口」/ en「Context Window」,key 双语已核实),`AppMenuTrigger(asChild)` 合并 aria-haspopup/aria-expanded 与键盘处理,coarse pointer 下 ≥44×44 实体命中。
- 单一可聚焦触发器 + 视觉层全部 aria-hidden,不存在读屏重复播报或幽灵 Tab 停靠点。

---

## 审阅结论

| # | 复核项 | 结论 |
|---|---|---|
| 1 | ComposerInlinePanel inert(effect 挂载、方向)/ aria-hidden(方向)/ clamp 二段式 | 通过 |
| 2 | InputBarUI 五个内联面板 aria-label 全走 t(),双语 key 齐备,无 MCP/Skills 硬编码 | 通过 |
| 3 | 焦点顺序测试断言真实 DOM/Tab 顺序(compareDocumentPosition + 正 tabindex 禁令),非仅存在性 | 通过 |
| 4 | ComposerToolbar 水位环无 role=img,语义收敛到 Popover button 触发器 | 通过 |

允许范围内的补丁额度(inert 未挂上 / aria-hidden 反了)本轮**未动用**——两处实现方向均正确。无翻案项。
