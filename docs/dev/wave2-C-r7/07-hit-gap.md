# 0824 Wave2-C R7 · 07 命中补遗（hit-target gap fill）

- 角色：第 7 轮测试员-命中补遗（claude-fable-5-thinking-high）
- 工作目录：`/tmp/0824-wave2-c-r7-hit-gap`（HEAD `0f5435a7`）
- 约束遵守：未执行任何测试（vitest/CT 均未跑）；未改产品代码；未 commit（新测试文件留在工作区未跟踪状态）

## 产出

新增 1 个 source 契约测试（10 条断言，2 个 describe）：

```
src/features/chat/components/input-bar/__tests__/ComposerToolbar.hitTarget.r7.source.test.ts
```

## 背景：R3 契约留下的两个缺口

触控命中机制已在 `af0be136` 落地：coarse pointer 下工具栏控件本体撑成实体
`min-h/min-w-[var(--touch-target-size)]` 盒，命中区即盒模型，不再用透明
`after:-inset` 伪元素外扩。但既有守卫存在缺口：

1. **机制存在性断言过弱**。R3（`ComposerToolbar.hitTarget.source.test.ts`）刻意
   mechanism-agnostic，只断言 `'[@media(pointer:coarse)]'` 前缀存在——任何无关的
   coarse 规则（如搜索框 `!text-base`）都能让它通过。若有人把
   `coarseSolidTouchTargetClass` 的 min-h 后缀改掉/删掉，R3 不红。
2. **after:-inset 禁令只覆盖右簇**。R3 的 `not.toContain('after:-inset')` 只切
   `{/* 右侧按钮` 之后的切片；左簇 `iconButtonClass` 若回归伪元素扩区抓不到。
   `InputBarUI.mobileSplitContract.source.test.ts` L46 虽是全文扫描，但只匹配带
   coarse 前缀的形式 `[@media(pointer:coarse)]:after:-inset`——裸 `after:-inset`
   （如 ModelPicker.tsx L477 那种细指针也生效的写法）混进工具栏不会被抓。

**为什么不能简单全文 `not.toContain('after:-inset')`**：`ComposerToolbar.tsx`
（L53、L208）与 `ContextUsagePopover.tsx`（L90）的注释里合法提及该字样（解释
「为什么不用它」），全文扫描必然误红。补遗改为**只扫字符串字面量**——className
只能经字符串字面量进 JSX，字面量干净 ⇔ 渲染类名干净，注释天然被排除。

## 断言清单（预期状态均为绿，已静态核对）

### describe 1：coarse min-h 契约（缺口 1）

| # | 断言 | 静态核对 |
|---|------|----------|
| 1 | `coarseSolidTouchTargetClass` / `coarseSolidTouchHeightClass` 常量声明存在（防空锚点） | 均非空 |
| 2 | 工具栏与 Target 常量含 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]` 后缀；Target 版另含 min-w | 命中 |
| 3 | Height 版只含 min-h、不含 min-w（带文字触发器的 truncate 契约） | 命中 |
| 4 | 两常量出现次数 ≥2（声明 + 至少一处真实引用，防死代码回归） | 各 3 处 |
| 5 | `src/styles/shadcn-variables.css` 仍定义 `--touch-target-size:`（变量被删时 `min-h-[var(...)]` 静默塌成 unset，类名扫描测不出） | L42 命中 |
| 6 | ContextUsagePopover 的 `<AppMenuTrigger>` 切片含 min-h + min-w（水位环 44×44 实体命中区唯一所有者） | 命中 |
| 7 | `ContextWindowUsageRing` 函数切片 `aria-hidden="true"` 且无任何 `[@media(pointer:coarse)]`（内环纯视觉，单一所有者反向面） | 命中 |

### describe 2：工具栏无 after:-inset 默认（缺口 2）

| # | 断言 | 静态核对 |
|---|------|----------|
| 8 | ComposerToolbar.tsx 全部字符串字面量（223 个）不含 `after:-inset` | offenders = [] |
| 9 | ContextUsagePopover.tsx 全部字符串字面量（63 个）不含 `after:-inset` | offenders = [] |
| 10 | 两文件全文仍含 `after:-inset` 字样（自证：字样只活在注释里，字面量扫描是必要的；注释若删除可降级为全文 not.toContain） | 命中 |

静态核对方式：用独立 node 脚本对两份源码逐条模拟断言逻辑（正则、切片、计数），
10/10 通过；**未运行 vitest**。

## 刻意不测的边界

- 不数 min-h 出现次数、不锁像素——真实命中盒归 Playwright CT
  （`ComposerToolbar.adjacentHit.test.tsx` 的几何推演）与设计走查。
- chips 类小部件（`ActiveFeatureChips` / `ContextRefChips` / `PageRefChips` /
  `ModelMentionChip` / `AttachmentPreviewChips`）仍合法用 after:-inset 扩区
  （本体不可点、重叠无害），不在本契约范围；`ModelPicker` / `BlockingAskUserBar` /
  `ComposerPanel` 的扩区同理。

## 与既有测试的关系（无互斥）

- R3 `ComposerToolbar.hitTarget.source.test.ts`：同向，本补遗是其加严超集
  （右簇切片 → 全文件字面量；前缀存在 → min-h 后缀 + 变量定义 + 引用计数）。
- `InputBarUI.mobileSplitContract.source.test.ts` L43-46：同向（toContain min-h
  token / not.toContain coarse-前缀 after:-inset），本补遗补上裸形式与注释误红问题。
- `ComposerToolbar.adjacentHit.test.tsx`：渲染层同契约，互为 source/DOM 双保险。

## 后续建议（非本轮范围）

- 若后续把 `--touch-target-size` 改为按平台分档（如 Android 48dp），断言 5 只查
  「有定义」不锁值，无需改动；断言 2/3 锁的是 var() 引用形态，同样兼容。
