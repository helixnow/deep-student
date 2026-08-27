# 0824 Wave2-C R3 — DsButton 下沉实现（buttonPrimitiveContract 粗指针命中保底）

基线 e90fb360，工作目录 /tmp/0824-wave2-c-r3-dsbutton。未 commit。

## 改了什么

### 1. src/components/ui/buttonPrimitiveContract.ts（唯一实现改动）

根因：尺寸压缩条件只有 `lg:` 视口断点。宽视口 + 粗指针（iPad 横屏 1024px+）
命中 `lg:h-[var(--button-height)]`，按钮被压到 32px 命中区。全库 1335 处
`!min-h-11` 都是在调用点补这个洞。

修法：在 `buttonSizeClassNames` 与 `buttonIconSizeClassNames` 全部 10 个
条目的 `lg:h-*`（及 `lg:w-*`）之后追加：

- 所有 size：`[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`
- 正方形图标尺寸（`buttonSizeClassNames.icon` + `buttonIconSizeClassNames`
  全部 5 个）：再追加 `[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]`

要点：

- 用 `min-*` 不用 `!h-11`/`!min-h-11`：视觉高度（`h`/`lg:h`）与命中保底
  （`min-h`）分离。CSS 中 min-height 天然赢过 height，无需 important，
  调用方局部覆盖 height 时保底仍生效。
- `buttonToneClassNames` 一字未动（含 nav 的 `lg:min-h-9`，属 tone 层，
  按约束不碰）。
- `[@media(pointer:coarse)]:` 任意变体语法库内已大量使用（TouchTarget、
  ChatCollapsible 等），Tailwind 3.4.19 支持，无新语法引入。

### 2. src/components/ui/DsButton.tsx — 未改

DsButton 的尺寸类全部来自 contract 的 `buttonSizeClassNames` /
`buttonIconSizeClassNames`，contract 下沉后自动生效。shad/Button.tsx 同理
（也消费同一 contract），一处改动同时覆盖两个入口。

### 3. src/components/ui/__tests__/migrationFoundation.source.test.ts（同步断言）

「keeps migrated primitives touch-sized through tablet and compacts only
at lg」用例中锁 size 字符串的 3 条正则（default / sm / icon）需要改。
旧正则不会因新后缀失败（无锚点、`[^'"]*` 允许后缀），但按「同步断言」
要求把新后缀锁进正则，防止后续回退：

- `default:` / `sm:`：在 `lg:h-[var(--button-height[-sm])]` 之后追加
  `[^'"]*\[@media\(pointer:coarse\)\]:min-h-\[var\(--touch-target-size\)\]`
- `icon:`：在 `h-[touch] ... w-[touch]` 之后追加 coarse `min-h` + `min-w`
  两段。

其余断言（token 桥接、forbidden patterns、Phosphor 守卫）逐条核对不受
影响：新类不含 `md:h-`、`!min-h-11`、`#hex`、`rgba(`、`shadow-[`、
`active:scale` 等被禁模式。

### 4. src/components/ui/__tests__/buttonPrimitiveContract.coarse.source.test.ts（新建，只写不跑）

源码级粗粒度守卫，5 个用例：

1. `buttonSizeClassNames` 每个 size 保留 `lg:h-*` 压缩，且 coarse `min-h`
   保底出现在 lg 压缩之后（位置断言）。
2. 正方形图标尺寸（icon 尺寸 map 全部 + size map 的 icon）双轴保底
   （min-h + min-w）。
3. contract 层禁止 `!min-h-11` / `!h-11` / coarse 条件下写死 `h-*`
   （只许 min-*，视觉与命中分离）。
4. 保底必须带 `pointer:coarse` 条件——负向 lookbehind 拦裸
   `min-h-[var(--touch-target-size)]`，防止有人把细指针桌面也顶到 44px。
5. tone map 不含任何 `[@media(pointer:coarse)]`（tone 不被本轮改动污染）。

## 哪些测试断言要改（汇总）

| 文件 | 用例 | 改动 |
| --- | --- | --- |
| migrationFoundation.source.test.ts | keeps migrated primitives touch-sized… | 3 条 size 正则追加 coarse `min-h`（icon 再加 `min-w`）后缀要求，已改 |
| migrationFoundation.source.test.ts | 其余 4 个用例 | 不需要改，新类不触发任何 forbidden pattern |
| buttonPrimitiveContract.coarse.source.test.ts | 新建 5 用例 | 只写不跑 |

## 桌面视觉是否不变

不变。逐分支：

- 细指针 + lg 宽屏（桌面主场景）：`@media(pointer:coarse)` 不匹配，只有
  `lg:h-[var(--button-height)]` 生效 → 32px，与基线逐像素一致。
- 细指针 + 窄视口（桌面缩窗）：走 `h-[var(--touch-target-size)]` 44px，
  与基线一致。
- 粗指针 + 窄视口（手机/iPad 竖屏）：本来就是 h-44px，min-h-44px 冗余
  无副作用，一致。
- 粗指针 + lg 宽视口（iPad 横屏，本轮修的洞）：height 32px 被
  min-height 44px 顶起 → 命中 44px。这是唯一行为变化，正是目标。
  视觉上该场景按钮从 32px 变 44px 高——这不是「桌面」，桌面（细指针）
  完全不受影响。
- 触屏笔记本（粗指针 + 宽屏）：同上会拿到 44px 保底。这是 WCAG 2.5.8
  期望行为，接受。

图标按钮的 `min-w` 同理只在粗指针生效；min-width 赢过 width，
`lg:w-[var(--button-icon-size)]` 在细指针桌面不受影响。

padding/字号/圆角/tone 全部未动，禁用态、focus ring、press 反馈不变。

## 验证方式（受禁令约束，未跑 node/vitest）

- python 正则模拟：migrationFoundation 更新后的 3 条正则对新 contract
  源码全部 MATCH；新 coarse 测试的全部断言逐条模拟通过；forbidden
  patterns（`md:h-`、`!min-h-11`、hex、rgba、active:scale）全 clean。
- git diff 复核：仅 size 两个 map 变化 + 注释，tone map 与
  DsButton.tsx 零改动。
- 语法确认：`[@media(pointer:coarse)]:` 前缀在库内既有代码中大量出现，
  Tailwind ^3.4.19 原生支持。

## 后续（不在本轮范围）

contract 保底落地后，全库 1335 处 `!min-h-11` 散点补丁可以分批摘除
（属「全库散点替换」禁区，留给后续轮次）；eslint-rules 可加「禁止在
DsButton/shad Button 调用点再写 !min-h-11」的规则（卡 1 范围）。
