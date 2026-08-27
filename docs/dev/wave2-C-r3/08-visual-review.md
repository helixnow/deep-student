# 0824 Wave2-C R3 · 08 审阅员-视觉：替换后视觉尺寸核验

- 审阅范围（基线 e90fb360 → 工作树）：
  - `src/features/chat/components/input-bar/ComposerToolbar.tsx`
  - `src/features/chat/components/input-bar/ContextUsagePopover.tsx`
  - `src/features/chat/components/input-bar/AttachmentPanelBody.tsx`
  - `src/features/chat/components/input-bar/ComposerPlusMenu.tsx`
- 核验目标：伪元素命中区 → 实体 44 盒替换后，**图标/控件视觉三档 24 / 28 / 36（w-6 / h-7 / h-9）不变**；不得出现「h-11 当图标视觉」。
- 方式：静态逐按钮比对 diff 与最终源码（本轮禁止编译/测试，未运行任何 runner）。
- 审阅代码改动：**0**（未触发"允许改动"条件，见结论）。

## 结论：通过

四个文件里没有任何一处图标 class 被改成 44 视觉。所有 44 只以两种形态出现：

1. `[@media(pointer:coarse)]:min-h/min-w-[var(--touch-target-size)]`（min-*，不改 fine 指针视觉，coarse 下撑实体命中盒）；
2. 基线原有的 `!h-11 !w-11` / `!min-h-11`（AttachmentPanelBody 移动端头部按钮与 DsButton 散点、ComposerPlusMenu "+" 触发器、发送/停止按钮）——本轮 diff 未触碰，属既有设计而非本轮"被改成"。

伪元素外扩已全部清除：四文件中 `after:-inset` / `after:absolute` 仅剩注释文字，无实际 class。token 链路成立：`--touch-target-size = var(--control-height-touch) = 44px`（`src/styles/shadcn-variables.css:41-42`）。

## 逐按钮：视觉 class vs 命中 class

「视觉」= 控件本体绘制尺寸（背景/图标）；「命中」= 可点范围来源。基线对照均以 `git diff e90fb360` 逐行核过。

### ComposerToolbar.tsx

| # | 控件（testid） | 视觉 class（改后） | 图标 | 命中 class（改后） | 核验 |
|---|---|---|---|---|---|
| 1 | 加号按钮 `btn-toggle-attachments`（`iconButtonClass` prop → PlusMenu DsButton） | `h-9 w-9`（36×36，未动） | Plus `size={18}`（未动） | `[@media(pointer:coarse)]:min-h/min-w-[var(--touch-target-size)]`（新）+ 基线原有 `[@media(pointer:coarse)]:!min-h-11 !min-w-11`（PlusMenu:286，未动） | ✅ 视觉 36 保持；coarse 命中盒基线本就 44×44，本轮只去掉 `after:-inset-1` 的额外 8px 越界外扩 |
| 2 | 水位环触发器 `context-usage-popover-trigger`（ContextUsagePopover:93-101，span→button） | 无 h/w class（透明包装，无背景），视觉由内层承担 | — | `[@media(pointer:coarse)]:min-h/min-w-[var(--touch-target-size)]` | ✅ button 自身不绘制任何东西（仅 focus-visible ring），fine 下仍是 28×32 内容尺寸 |
| 3 | 水位环内层 `context-window-usage-control`（ComposerToolbar:209-241） | `h-8 w-7`（28×32，未动）；svg `h-4 w-4`（16×16，未动）；r=6.75 / strokeWidth 2.5 / -90° / 分级配色全部未动 | 环 svg 16 | 无（降级 `aria-hidden` 纯视觉，命中让位给外层 button；原 `after:-inset-2` + `tabIndex=0` 已删） | ✅ 双重命中区收敛为单层，视觉零变化 |
| 4 | 推理菜单触发器 `thinking-runtime-menu-trigger`（:615-644） | `h-7`（28，未动），宽随内容 | ProviderIcon/Lightning `size={15}`、CaretDown `size={13}`（均未动） | `coarseSolidTouchHeightClass`（仅 min-h 44，不加 min-w，避免干扰 truncate） | ✅ 用高度版常量而非双向版，`min-w-0` truncate 链路未破坏 |
| 5 | 外壳 span `thinking-runtime-control`（:600-611） | `h-8`（32，未动），无背景 | — | 非交互；追加 `coarseSolidTouchHeightClass` 仅防内部 44 高按钮纵向溢出行盒 | ✅ |
| 6 | 极简闪电开关 `btn-toggle-thinking`（:828-843） | `h-7 w-6`（28×24，未动），无背景 | Lightning `size={15}`（未动） | `coarseSolidTouchTargetClass`（44×44 实体，替代原 `after:-inset-2.5`） | ✅ 24/28 两档视觉保持 |
| 7 | 发送 `btn-send` / 停止 `btn-stop`（:871-931） | `studyUiSendButtonSizeClass` / `!w-8 !h-8 max-md:!w-11 …` 一字未改 | ArrowUp 16 / Square 12 / CircleNotch 14（未动） | 基线原有 `!h-11 !w-11`（coarse/max-md） | ✅ 本轮 diff 不含这两个按钮 |

### ComposerPlusMenu.tsx

| # | 控件（testid） | 视觉 class（改后） | 图标 | 命中 class（改后） | 核验 |
|---|---|---|---|---|---|
| 8 | 权限 chip `full-access-active`（:675-703） | 视觉胶囊下沉为内层 span：`h-6`（24）+ 背景/文字/圆角逐 class 比对与基线一致；hover/focus 经 `group-hover:bg-warning/25` / `group-focus-visible:ring-1 ring-warning/40` 等价迁移 | ShieldWarning `size={12}`（未动） | 外层 button `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`（替代原 `after:-inset-y-1.5 -inset-x-1 / coarse -inset-y-2.5`） | ✅ 24 视觉保持；原横向 ±4px 越界（gap-1 工具条）消除 |
| 9 | 权限 chip `danger-full-access-active`（:704-730） | 同上（`bg-destructive` + `shadow-sm` 等 class 逐一对上，`group-hover:bg-destructive/90` / `group-focus-visible:ring-destructive/50` 等价迁移） | Warning `size={12}`（未动） | 同上 | ✅ |
| 10 | `plus-menu-switch-to-plan`（:662-671） | 文字链样式未动 | — | `min-h-11` → `min-h-[var(--touch-target-size)]`（同为 min-h 44，仅 token 化） | ✅ 等值替换 |
| 11 | 移动端扁平菜单行 `mobileItemClass`（全部扁平行） | 行视觉由 AppMenuItem 自身样式决定，未动 | 各行图标 16px 级，未动 | `min-h-[44px]`（无条件）→ `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`；`AppMenu.css:533-536` 的 coarse `.app-menu-item { min-height: 44px }` 基线兜底 | ✅ 触屏行高不变；桌面缩窄+精确指针回落桌面密度是 05 文档声明的预期语义，非视觉回归 |

### AttachmentPanelBody.tsx

| # | 控件 | 视觉 class（改后） | 命中 class（改后） | 核验 |
|---|---|---|---|---|
| 12 | ⋯更多菜单 3 个 AppMenuItem（资源库/拍照/全部清除，:170-196） | 行样式未动，图标 `w-4 h-4`（16，未动） | `min-h-[44px]` → `coarseRowClass`（token 化；AppMenu.css coarse 基线兜底） | ✅ |
| 13 | 附件列表行容器 `attachment-row`（:325） | 原 class 全保留 | 追加 `coarseRowClass`（coarse 下行实体 ≥44，纯增量 min-height） | ✅ 内容行（文件名+状态+按钮多行）本就普遍 >44，fine 指针零变化 |
| 14 | 头部/行内 DsButton（`!h-11 !min-w-11`、2×`!h-11 !w-11`、7×`[@media(pointer:coarse)]:!min-h-11`） | 与基线逐行一致（`git show e90fb360` 比对：146/157/197/212/219/226/232/236/370/375 行均原样） | 基线原有 | ✅ 本轮 0 触碰，不属"被改成 44 视觉" |

## 专项核验点

1. **「h-11 当图标」扫描**：四文件中所有 `h-11`/`w-11` 逐处核过，全部为基线遗留的实体触控 class（发送/停止/移动端头部按钮/DsButton 散点），本轮 diff 无一新增裸 `h-11`；新增的 44 全部是 `min-h`/`min-w` 形态且限定 `[@media(pointer:coarse)]`。
2. **三档视觉不变**：24（`w-6` 闪电开关宽 / `h-6` 权限胶囊）、28（`h-7` 推理触发器与闪电开关高）、36（`h-9 w-9` 加号按钮）在改后源码中原位存在，图标 `size={12|13|15|18}` 与 svg `h-4 w-4` 全部未动。
3. **无残留伪元素**：`after:-inset|after:absolute` 在四文件中仅剩 3 处注释文字（ComposerToolbar:53、:208，ContextUsagePopover:90），无实际 class。
4. **min-h 不需要 `!`**：CSS 中 min-height 在计算值层面压过 height（与优先级无关），`coarseSolidTouchTargetClass` 无 `!` 也能盖过 `h-9`/`h-7`；未发现任何按任务禁令新加的 `!min-h-11`。
5. **coarse 下的盒尺寸变化是设计目标而非回归**：`btn-toggle-thinking`（24×28→实体 44×44 透明盒）与水位环触发器（28×32→44×44 透明盒）在 coarse 下会把相邻元素按盒模型推开——这正是 04 文档表中 #2/#6 声明的"gap 语义由盒模型承担"；这些按钮均无背景 class，绘制内容（图标/环）尺寸与居中方式不变。

## 翻案项

无。
