# R2-WI-10-slim：精简 Top 5 冗长 Skill Schema 描述（SA-R2-06）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R2-06（模型 `claude-fable-5-thinking-xhigh`）
> 基线：`R1-WI-10.md`；测试：`tests/vitest/chat-v2/token-budget.test.ts`

## 目标与范围

对 R1 基线中 schema tokens 最冗长的 **实际 Top 5** skill 组的 `embeddedTools`
description 做精简：保留语义、删冗余示例与重复句，每组 schema tokens 目标
**-15% 以上**。不改 JSON Schema 结构与字段名（properties、required、enum、
类型约束等全部保持不变），只改 `description` 字符串（及 workbench-tools 中
拼入 description 的 `DIVISION` 常量文本）。

任务单原列 `textbook-pdf-tools`、`office-tools`，按「或实际 Top 5」执行：
R1 实际 Top 5 为 `qbank-tools`、`workbench-tools`、`workspace-tools`、
`self-service-tools`、`vfs-memory`（见 R1 排名表），故以这 5 组为目标。

## 结果（口径同 R1：`JSON.stringify(embeddedTools)` 字符数，tokens = chars/4）

| Skill 组 | schema 字符（前→后） | schema tokens（前→后） | 降幅 | 达标(-15%) |
| --- | --- | --- | --- | --- |
| `qbank-tools` | 29554 → 24685 | 7389 → 6172 | **-16.5%** | ✅ |
| `workbench-tools` | 18949 → 16104 | 4738 → 4026 | **-15.0%** | ✅ |
| `workspace-tools` | 17558 → 14924 | 4390 → 3731 | **-15.0%** | ✅ |
| `self-service-tools` | 10724 → 9079 | 2681 → 2270 | **-15.3%** | ✅ |
| `vfs-memory` | 10435 → 8686 | 2609 → 2172 | **-16.8%** | ✅ |
| **五组合计** | **87220 → 73478** | **21807 → 18371** | **-15.8%** | ✅ |

全库影响（43 组，282 工具）：

| 指标 | R1 基线 | 本次 | 变化 |
| --- | --- | --- | --- |
| schema 总字符 | 216131 | 202389 | -13742（-6.4%） |
| schema tokens (est.) | 54050 | 50614 | -3436（-6.4%） |
| schema+content 合计 tokens | 75689 | 72253 | -3436（-4.5%） |

回归护栏余量同步扩大：单组上限 9500（当前最大 6172，余量 ≈35%）、
schema 合计上限 68000（当前 50614，余量 ≈26%）、schema+content 上限
95000（当前 72253，余量 ≈24%）。`content`（技能指令文本）未改动。

## 精简手法（各组通用）

1. **删「【必填】」标记**：`required` 数组已表达必填语义，描述里的
   【必填】/「可选：」前缀全部移除。
2. **删内联示例**：如 `"高三理科生"`、`"做了 5 道二次函数题，错 2 道"` 等
   例句，字段名 + 类型 + 一句话语义已足够。
3. **去跨工具重复**：同组内反复出现的分页说明（limit/offset/has_more）、
   OCC 流程（先读 updated_at → 冲突重读）、截断提示、UI 混合模式语义等，
   压缩为短句或改为引用技能 `content` 中的统一说明（如「见技能说明
   『记忆分类』」「见 qbank_search_questions 枚举」）。
4. **同义句合并**：删除与工具名/枚举值自明信息重复的解释
   （如 `subject: '科目，如"数学"'` → `'科目'`）。
5. **共享契约引用**：`workbench_act_high` 引用 `workbench_act` 的公共契约，
   `app_command` 的动作清单压缩为一行并注明 High 动作走 observe+act_high。

语义保留原则：风险等级（Medium/High）、OCC 基线要求、数量上限
（如 1–20 条、≤80 字）、默认值、枚举含义、审批语义等硬约束全部保留。

## 未精简说明

- `textbook-pdf-tools`（R1 #10，7187 字符）：仅 3 个工具，schema 体积由
  结构主导（多层 `oneOf`、复用的 rect 坐标 schema、大量枚举/数值约束），
  description 文本占比低。在「不改 JSON Schema 结构/字段名」约束下，
  仅删描述无法达到 -15%，故不动，留待后续结构性方案（如 $defs 复用）评估。
- `office-tools`：不存在同名组；最接近的 `office-fidelity-tools` 仅 1 个
  工具 / 514 字符（全库最小），无精简价值。

## 验证

- `npx vitest run tests/vitest/chat-v2/token-budget.test.ts`：**7/7 通过**
  （含三条回归护栏断言）。
- `tsc --noEmit`：改动文件无类型错误。
- `ActivityTimeline.loadSkillsSummary.test.tsx`、`McpToolBlock.test.tsx`
  引用了相关 skill，其 5 个失败用例经 `git stash` 对照验证为**基线既有失败**
  （mock 缺 `getExternalToolProviderName` 导出、UI 文案断言），与本次改动无关。

## 复现方式

```bash
npx vitest run tests/vitest/chat-v2/token-budget.test.ts

TOKEN_BUDGET_REPORT_PATH=/tmp/token-budget-report.md \
  npx vitest run tests/vitest/chat-v2/token-budget.test.ts
```

## 改动文件

- `src/features/chat/skills/builtin-tools/qbank-tools.ts`
- `src/features/chat/skills/builtin-tools/workbench-tools.ts`
- `src/features/chat/skills/builtin-tools/workspace-tools.ts`
- `src/features/chat/skills/builtin-tools/self-service-tools.ts`
- `src/features/chat/skills/builtin-tools/vfs-memory.ts`
