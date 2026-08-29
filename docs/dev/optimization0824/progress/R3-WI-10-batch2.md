# R3-WI-10-batch2：精简 Top 6-15 Skill Schema 描述（SA-R3-05）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R3-05（模型 `claude-fable-5-thinking-xhigh`）
> 前置：`R1-WI-10.md`（基线）、`R2-WI-10-slim.md`（batch 1，Top 5）
> 测试：`tests/vitest/chat-v2/token-budget.test.ts`

## 目标与范围

WI-10 续（batch 2）：对 token-budget 测试排名 **Top 6-15** 的 skill 组精简
`embeddedTools` schema description，每组目标 **-10% 以上**；不改 JSON Schema
校验结构（properties、required、enum、oneOf/anyOf、类型与数值约束、字段名
全部保持不变）。

**范围界定**：batch 1 已精简 R1 实际 Top 5（qbank / workbench / workspace /
self-service / vfs-memory）。"Top 6-15" 按 R1 基线排名第 6–15 位执行，恰好
等于本批开始时**尚未精简组中最大的 10 组**（亦即当前排名 Top 15 去掉已精简
的 5 组），两种口径收敛到同一集合：

`automation-tools`、`mindmap-tools`、`user-todo-tools`、`session-manager`、
`textbook-pdf-tools`、`canvas-note`、`browser-tools`、`settings-tools`、
`dstu-tools`、`translation-tools`。

## 结果（口径同 R1/R2：`JSON.stringify(embeddedTools)` 字符数，tokens = chars/4）

| Skill 组 | schema 字符（前→后） | schema tokens（前→后） | 降幅 | 达标(-10%) |
| --- | --- | --- | --- | --- |
| `automation-tools` | 10104 → 9044 | 2526 → 2261 | **-10.5%** | ✅ |
| `mindmap-tools` | 9388 → 8439 | 2347 → 2110 | **-10.1%** | ✅ |
| `user-todo-tools` | 9173 → 8250 | 2294 → 2063 | **-10.1%** | ✅ |
| `session-manager` | 8712 → 7677 | 2178 → 1920 | **-11.9%** | ✅ |
| `textbook-pdf-tools` | 7187 → 6428 | 1797 → 1607 | **-10.6%** | ✅ |
| `canvas-note` | 5412 → 4626 | 1353 → 1157 | **-14.5%** | ✅ |
| `browser-tools` | 5326 → 4688 | 1332 → 1172 | **-12.0%** | ✅ |
| `settings-tools` | 4773 → 4293 | 1194 → 1074 | **-10.1%** | ✅ |
| `dstu-tools` | 4637 → 3901 | 1160 → 976 | **-15.9%** | ✅ |
| `translation-tools` | 4446 → 3905 | 1112 → 977 | **-12.2%** | ✅ |
| **十组合计** | **69158 → 61251** | **17293 → 15317** | **-11.4%** | ✅ |

全库影响（43 组，282 工具）：

| 指标 | batch 1 后 | 本次 | 变化 | vs R1 基线 |
| --- | --- | --- | --- | --- |
| schema 总字符 | 202389 | 194482 | -7907（-3.9%） | -21649（**-10.0%**） |
| schema tokens (est.) | 50614 | 48638 | -1976 | -5412 |
| schema+content 合计 tokens | 72253 | 70277 | -1976 | -5412 |

回归护栏余量进一步扩大：单组上限 9500（当前最大 9044，automation-tools）、
schema 合计上限 68000（当前 48638，余量 ≈28%）、schema+content 上限 95000
（当前 70277，余量 ≈26%）。`content`（技能指令文本）未改动。

## 精简手法（沿用 batch 1 并新增两条）

1. **删「【必填】」「（可选）」标记**：`required` 数组与字段缺省即表达该语义。
2. **删 schema 已编码的数值约束复述**：`minimum/maximum/maxLength/default`
   已在 schema 中，描述里的「默认 20，最大 20」「5–1440」等全部移除。
3. **删内联示例与返回字段全列举**：如 `"每周一三五 → [1,3,5]"`、
   「成功返回 success、action、node、source_id、resource_id、…」压缩为
   「返回 resource_id、path、is_new 等」。
4. **压缩共享常量（乘数效应）**：
   - `browser-tools` 的 `PREFER_FETCH` 英文前缀（122 字符，拼入 8 个工具
     description）压缩为 53 字符，单处修改节省 ≈550 序列化字符；
   - `textbook-pdf-tools` 的 `expectedRevision`（×6）、`highlightProperties`
     （×2–3）、`translation-tools` 的 `saveCommonProperties`（×3）同理。
5. **OCC 流程引用化**：schema 里只保留「先 list/get 取 updatedAt/version 传为
   expected_*；冲突后重新读取」一句，完整流程留在技能 `content`。
6. **（新）删除与字段名完全同义的 description 键**：仅用于结构主导的
   `textbook-pdf-tools` 与 `settings-tools`——如 `textbook_id: '教材 ID'`、
   `slot: '要修改的真实 ModelAssignments 字段'`（enum 已显式列出全部合法值）、
   `page/page_size`（min/max/default 已在 schema）。JSON Schema 校验结构
   未做任何改动；`textbook-pdf-tools.ts` 的 `id()` 辅助函数改为可选参数并在
   未提供时省略 description 键。
7. **（新）安全/边界文案去重**：`settings-tools` schema 中与技能 `content`
   「安全边界」一节逐句重复的密钥/凭据拒绝说明压缩为一句（Rust executor
   仍硬性拦截，防御不依赖提示词）。

语义保留原则：敏感度等级（Low/Medium/High）、OCC 基线要求、审批/确认规则
（ask_user、confirmed=true、不可记住授权）、互斥与清空语义（null/""/[]）、
0-based/1-based 区分、截断标记等硬约束全部保留。

## 结构主导组的说明

`textbook-pdf-tools`（R2 曾因 -15% 不可达而搁置）与 `settings-tools` 的
schema 体积由结构主导（多层 `oneOf`、共享 rect/枚举、12 个模型 slot 枚举），
description 总量分别仅占 25%/17%。本次 -10% 目标通过手法 6/7 达成
（-10.6%/-10.1%），已接近「只动 description」的合理上限；若后续还需下降，
需评估 `$defs` 复用等结构性方案。

## 验证

- `npx vitest run tests/vitest/chat-v2/token-budget.test.ts`：**7/7 通过**
  （含单组/合计三条回归护栏断言与 schema round-trip 校验）。
- `npx tsc --noEmit`：改动文件无类型错误。
- `ActivityTimeline.loadSkillsSummary.test.tsx` 2 个失败用例经 `git stash`
  对照验证为**基线既有失败**，与本次改动无关。

## 复现方式

```bash
npx vitest run tests/vitest/chat-v2/token-budget.test.ts

TOKEN_BUDGET_REPORT_PATH=/tmp/token-budget-report.md \
  npx vitest run tests/vitest/chat-v2/token-budget.test.ts
```

## 改动文件

- `src/features/chat/skills/builtin-tools/automation-tools.ts`
- `src/features/chat/skills/builtin-tools/mindmap-tools.ts`
- `src/features/chat/skills/builtin-tools/user-todo-tools.ts`
- `src/features/chat/skills/builtin-tools/session-manager.ts`
- `src/features/chat/skills/builtin-tools/textbook-pdf-tools.ts`
- `src/features/chat/skills/builtin-tools/canvas-note.ts`
- `src/features/chat/skills/builtin-tools/browser-tools.ts`
- `src/features/chat/skills/builtin-tools/settings-tools.ts`
- `src/features/chat/skills/builtin-tools/dstu-tools.ts`
- `src/features/chat/skills/builtin-tools/translation-tools.ts`
