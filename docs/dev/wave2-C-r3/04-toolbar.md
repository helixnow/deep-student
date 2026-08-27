# 0824 Wave2-C R3 · 04 Composer 工具栏：伪元素命中区 → 实体 44×44 盒

- 基线：e90fb360
- 改动文件（独占范围内）：
  - `src/features/chat/components/input-bar/ComposerToolbar.tsx`
  - `src/features/chat/components/input-bar/ContextUsagePopover.tsx`
  - `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts`（源码契约测试：原断言"工具栏必须含 `[@media(pointer:coarse)]:after:-inset-2`"与本轮目标直接冲突，改为断言实体 `min-h-[var(--touch-target-size)]` 且工具栏内不得再出现 coarse 伪元素外扩）
- 未触碰：InputBarUI.tsx、DsButton/契约、AttachmentPanelBody、ComposerPlusMenu.tsx 及其余散点文件；没有给任何按钮手贴 `!min-h-11`。

## 做了什么

1. 删除 `ComposerToolbar.tsx` 中三个透明伪元素命中区常量 `coarseHitAreaClass` / `coarseHitAreaLgClass` / `coarseHitAreaXlClass`（`after:-inset-1 / -2 / -2.5`），替换为两个实体占位常量：
   - `coarseSolidTouchTargetClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]'`（图标类方形控件，双向撑满 44）
   - `coarseSolidTouchHeightClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]'`（带文字标签、宽度由内容决定的触发器只抬高度，避免 min-w 干扰 `min-w-0` truncate）
   - `--touch-target-size = var(--control-height-touch) = 44px`（shadcn-variables.css，已有 token，未新增）。
2. 水位环去双重伪元素：
   - 内层（ComposerToolbar `ContextWindowUsageRing`，原 203-212 行）：删掉 `role="img"`、`tabIndex={0}`、`aria-label`/`title`、focus ring 和 `after:-inset-2`，降级为纯视觉 `aria-hidden` 内层，svg 环视觉原样保留（h-4 w-4 / r=6.75 / strokeWidth 2.5 / -90° 起点 / 分级配色全部不动，配套 source 契约测试断言仍全部命中）。
   - 外层（ContextUsagePopover 触发器）：`span + after:-inset-2` → 实体 `<button type="button">`，coarse 下 `min-h/min-w-[var(--touch-target-size)]` 撑成 44×44 flex box；`AppMenuTrigger asChild`（Slot）会把 `aria-haspopup="menu"`、`aria-expanded` 与点击/键盘处理合并到该 button 上，button 自带原生可聚焦性 + `aria-label`/`title`（`chatV2:tokenUsage.contextWindow`，与旧 role=img 标签同 key）+ focus-visible ring。语义从"图片"修正为"可聚焦弹层触发按钮"。
3. 右簇（gap-2 = 8px）其余高频散点全部改实体占位：命中区=盒模型，不再有任何跨 gap 的负 inset 伪元素，相邻命中区零重叠；`ComposerPlusMenu` 通过 `iconButtonClass` prop 继承同一实体策略（其自身已有 `!min-h-11 !min-w-11`，此前是"实体 44 + 伪元素再外扩 8px"的重叠态，现在收敛为恰好 44）。

## 逐处视觉尺寸对照表

图标视觉三档 24 / 28 / 36（w-6 / h-7 / h-9）全部不变；下表"视觉"列为控件本体绘制尺寸（背景/图标），"命中区"列为可点范围。

| # | 控件（testid） | 图标视觉 改前→改后 | 控件视觉盒 改前→改后 | fine 命中区 改前→改后 | coarse 命中区 改前→改后 | 重叠消除 |
|---|---|---|---|---|---|---|
| 1 | 加号菜单按钮 `btn-toggle-attachments`（经 `iconButtonClass` prop） | Plus 18px → 18px（不变） | 36×36（h-9 w-9）；coarse 下本就被 PlusMenu 的 `!min-h/w-11` 撑到 44×44 → 不变 | 36×36 → 36×36（fine 无伪元素，前后一致） | 实体 44×44 **+ after:-inset-1 再外扩 8px（≈52×52）** → 恰好实体 44×44 | 伪元素越过 gap-1.5 压住左簇相邻插槽 → 已消除 |
| 2 | 水位环触发器 `context-usage-popover-trigger`（外层，ContextUsagePopover） | 环 svg 16×16 → 16×16（不变） | 透明包装（28×32 内容尺寸）→ 透明 button；fine 同 28×32，coarse 实体 44×44 | 28×32 → 28×32 | **28×32 + 外层 after:-inset-2（44×48）与内层 after:-inset-2 双重叠加** → 实体 44×44，单层 | 双重伪元素互相重叠、且右缘越界压住推理触发器 → 已消除 |
| 3 | 水位环内层 `context-window-usage-control`（ComposerToolbar:203-212 区段） | 环 svg 16×16 → 16×16（不变） | 28×32（h-8 w-7）→ 28×32（不变） | 曾 tabIndex=0 可聚焦 → 纯视觉 `aria-hidden`，命中/焦点全部让位给外层 button | after:-inset-2（44×48）→ 无（0 外扩） | 内外两圈 44+ 命中区完全重叠 → 只剩外层一个 |
| 4 | 推理运行时菜单触发器 `thinking-runtime-menu-trigger` | ProviderIcon/Lightning 15px、Caret 13px → 不变 | 28 高文字胶囊（h-7）→ fine 不变；coarse 实体 44 高（宽随内容，含标签 ≥44） | 28×内容宽 → 28×内容宽 | **h+16 / w+16（after:-inset-2，横向越过 gap-2 压水位环与媒体指示）** → 实体 44 高 × 内容宽，无横向外扩 | 与左侧水位环、右侧处理指示的横向重叠 → 已消除 |
| 5 | `thinking-runtime-control` 外壳 span | — | 32 高（h-8）→ fine 不变；coarse min-h 44（防内部 44 高按钮纵向溢出行盒） | 非交互 | 非交互 | — |
| 6 | 极简闪电开关 `btn-toggle-thinking`（无菜单分支） | Lightning 15px → 15px（不变） | 24×28（w-6 h-7）→ fine 不变；coarse 实体 44×44 | 24×28 → 24×28 | **44×48（after:-inset-2.5，右缘压住紧邻的状态文字 label）** → 实体 44×44 | 与状态 label（px-1 紧贴）的重叠 → 已消除；实体占位把 label 右移，gap 语义由盒模型承担 |
| 7 | 发送 `btn-send` / 停止 `btn-stop` | ArrowUp 16 / Square 12 → 不变 | 未改动（本就是实体 44：coarse `!h-11 !w-11`） | 不变 | 44×44 → 44×44 | 本就无伪元素 |

## 语义对照（水位环）

| 维度 | 改前 | 改后 |
|---|---|---|
| 元素 | 外 `span`（AppMenuTrigger asChild）+ 内 `span role="img" tabIndex=0` | 外 `button type="button"`（AppMenuTrigger asChild）+ 内 `span aria-hidden` |
| aria-haspopup / aria-expanded | 挂在外层非交互 span 上 | Slot 合并到原生 button 上 |
| 可聚焦 | 内层 role=img span 手动 tabIndex=0（焦点落在"图片"上） | button 原生可聚焦 + focus-visible ring |
| 可访问名 | 内层 aria-label/title | button aria-label/title（同 i18n key `chatV2:tokenUsage.contextWindow`） |
| Enter/Space 激活 | 依赖 keydown 冒泡到外层 span 的 AppMenuTrigger handler | button 原生 + AppMenuTrigger handler |

## 验证说明

- 本轮禁止 npm/npx/vitest，未运行测试；已人工核对以下源码契约测试的全部断言串在改后源码中仍成立：
  - `InputBarUI.thinkingRuntimeState.source.test.ts`（testid、环 svg 结构、无 hover 类、分级配色等 ~40 条断言逐条比对通过）；
  - `InputBarUI.mobileSplitContract.source.test.ts`：`!h-11 !w-11`、搜索框 `!h-11 !text-base` 断言仍命中；`after:-inset-2` 断言按本轮目标反转（见上）。
- `coarseHitArea*` 三常量为 ComposerToolbar.tsx 文件内私有（TranslationMain / TargetPanel / InputPanel 各有同名私有副本，未触碰，属后续批次）。
- Tailwind 任意值 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]` 在库内已有同形先例（MobileBreadcrumb.tsx、shad/Select.tsx），JIT 可生成。

## 残留（后续批次）

工具栏独占文件之外仍有伪元素外扩散点（本轮禁改）：PageRefChips、ModelMentionChip、ContextRefChips、ActiveFeatureChips 的 16px 关闭钮（after:-inset-3.5）、ModelPicker、ComposerPlusMenu 菜单行、BlockingAskUserBar、AttachmentPreviewChips、ComposerPanel。
