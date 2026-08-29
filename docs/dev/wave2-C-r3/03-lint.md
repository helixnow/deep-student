# 0824 Wave2-C 第 3 轮：coarse-touch-target lint 规则

基线 `e90fb360`，工作目录 `/tmp/0824-wave2-c-r3-lint`。未跑 eslint/vitest（本轮禁令），规则正则已用等价用例表在 Python `re` 下全量核对（flag 13 例 / allow 10 例 / 混合与去重各 1 例，全部通过），白名单 JSON 已验证可解析。

## 产出

| 文件 | 内容 |
| --- | --- |
| `eslint-rules/coarse-touch-target.js` | 新规则，Literal + TemplateElement 扫描（骨架照抄 no-arbitrary-font-size） |
| `eslint-rules/coarse-touch-target.allowlist.json` | 9 个有意折衷文件，每条带 reason + source |
| `eslint.config.js` | `ds-components/coarse-touch-target: 'warn'` 接线 + 两处目录级 off |
| `tests/vitest/coarseTouchTargetRule.test.ts` | 规则单测源码（Linter API，仿 noArbitraryFontSizeRule.test.ts），只写未跑 |

## 规则语义

两个 messageId：

1. **`coarseMinOverride`**（对应任务里的「新增散点」主拦截面）：
   - `[@media(pointer:coarse)]:!` 后跟 44px 级强制尺寸：`!min-h-11` / `!min-w-11` / `!h-11` / `!w-11` / `!min-h-[44px]` / `!min-w-[2.75rem]`；
   - 裸（无变体前缀）`!min-h-[44px]` / `!min-w-[2.75rem]`——把触控常量写死等同绕过 `var(--touch-target-size)`。
2. **`bareHitInset`**（任务里的「裸 after:-inset 扩区，可先 warn」）：
   - `after:-inset-*` / `before:-inset-*`（含 `-x/-y` 轴形与 `[13px]` 任意值形，含 coarse 前缀形）。`before` 也拦：TabBar 用的就是 `before:-inset-y-[13px]`，同一种扩区 hack。

两类各自最多报一次/字符串节点（与 sibling 规则一致），同一字符串两类混用时各报一条。

## 误报边界（有意的收窄）

- **只拦 `!` 强制形，不拦 `[@media(pointer:coarse)]:min-h-11`（非 important）**。任务给出的三个样本串全部带 `!`；非 `!` 形存量更大（SelectItem/label/菜单行等非按钮容器上大量使用，且 ROUND 文档把「SelectItem/SegmentedControl 原语 `!`」列为勿再动项），其中不少场景没有体系组件可替换。第 8 轮放量时可再评估是否并入。
- **裸 `!min-h-11`（无 coarse 前缀）放行**：不带 coarse 时 44px 可能就是正常桌面布局尺寸，只有 `[44px]`/`[2.75rem]` 字面量才视为「写死触控常量」。
- **44 级以外的 coarse 尺寸放行**（如翻译面板的 `!h-9`/`!w-9`）：那是视觉微调不是命中区声明。
- **`11` 加了 `(?![\d.])` 负先行**：`!h-110`、`!h-11.5` 不误报。
- **token 形天然放过**：`[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]` 不在备选集内（shad Input/Select、UnifiedSidebar、MobileBreadcrumb 的正统写法零误报）。
- **`after:-inset-px` 放行**：1px 负 inset 是装饰描边不是扩区；正值 `after:inset-x-0`（TabBar 扩条）不含 `-inset` 也不命中。
- **coarse 前缀的 `!min-h-[44px]` 只报一次**：`BARE_IMPORTANT_44` 的 lookbehind 排除 `:` 前缀，避免与 coarse 正则重复报告（已在用例表验证）。
- **测试文件目录级 off**：契约/源码测试把这些类名当断言样本引用（`pdfMobilePanelTabs.source.test.ts`、`InputBarUI.mobileSplitContract.source.test.ts` 等），复用了现成的「示例文件和测试文件」config 块。

## 白名单及理由

两层豁免，性质不同：

**A. 目录级 off（eslint.config.js，`src/components/ui/**`）**——不是折衷，是体系本体。DsButton/DsDialog/shad Select/Sheet/Slider/SegmentedControl/TagInput 正是 coarse 44px 命中的集中实现处，`[@media(pointer:coarse)]:!min-h-11`、`after:-inset-[16px]`（Slider thumb）在此目录是规则要求大家「走」的那条路本身。挂在既有的 ui/** 块上（该块同时把 no-arbitrary-font-size 升 error，互不影响）。

**B. 文件级白名单（allowlist.json，9 条）**——ROUND-81~90 / WRAP-UP 记录的有意折衷，每条 JSON 内带 reason 与文档出处：

- `MiniCalendar.tsx`：42 格月视图格宽 28（coarse h-9）折衷，「勿硬叠 44 视觉」；
- `TabBar.tsx`：标签宽 28 折衷 + before/after 扩条热区受 z 层叠约束，勿重做；
- `FinderToolbar.tsx`：视觉 40 + 伪元素命中 48，标题栏高度约束；
- 翻译四件套 `TranslationMain / SourcePanel / TargetPanel / ComparisonView`：`COARSE_HIT` 常量已凑满 ≥44，文档明确「勿重做视觉」；
- `essay-grading/InputPanel.tsx`：COARSE_HIT 同款范式三档变体（任务里「翻译 COARSE_HIT **等**」的等）；
- `chat/input-bar/ComposerToolbar.tsx`：`coarseHitAreaClass` 定义处，被各 COARSE_HIT 注释指认为范式来源。

匹配方式：posix 路径后缀匹配（`===` 或 `endsWith('/'+path)`），绝对/相对文件名都可命中；规则在 `create()` 入口整文件短路，白名单文件里两类模式都不报。

## 预期 warn 量（rg 估算，未跑 eslint）

排除 ui/**、测试、白名单后：`coarseMinOverride` 约 **1777** 行（1807 − 白名单内 30），`bareHitInset` 约 **119** 行（141 − 22）。量级与 no-arbitrary-font-size 的 ~950 存量 warn 同一策略：先 warn 记账，不阻塞 CI。

## 第 8 轮升 error 前的待办

1. 清（或迁移到体系组件）上面 ~1900 行存量，重点大户：McpToolsSection（49）、MemoryView（44）、ankiCardsBlock（21）；
2. 决定是否把非 `!` 的 `[@media(pointer:coarse)]:min-h-11` 并入拦截面；
3. 白名单复核：若届时 TouchTarget 类体系组件复活（2026-07 已因零消费移除），翻译 COARSE_HIT 族可考虑迁移后摘除。
