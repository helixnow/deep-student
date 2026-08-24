# R4-WI-10-full：精简剩余全部 Skill 组 + prompt_builder 静态块（SA-R4-05）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R4-05（模型 `claude-fable-5-thinking-xhigh`）
> 前置：`R1-WI-10.md`（基线）、`R2-WI-10-slim.md`（Top 5）、`R3-WI-10-batch2.md`（Top 6-15）
> 测试：`tests/vitest/chat-v2/token-budget.test.ts`、`src-tauri/src/chat_v2/prompt_builder.rs`（单元测试）

## 目标与范围

WI-10 收口（R4）：

1. 精简 R2/R3 之后**尚未处理的全部 28 个** builtin skill 组的 `embeddedTools`
   description，每组 schema 序列化体积 **-8% 以上**（或声明结构主导已达上限）；
2. 按精简后的新总量把 token-budget 回归护栏收紧到 **≈10% 余量**；
3. `prompt_builder.rs` 落地一处安全精简（删除 rules 与 examples 之间逐句重复
   的示例行），并新增 Rust 单元测试守护。

约束沿用前三轮：**不改 JSON Schema 校验结构**——properties、required、enum、
oneOf/anyOf、类型与数值约束、字段名全部保持不变；仅修改 `description`
注释字符串（含删除与顶层重复的 oneOf 分支内 description 键，为纯注释元数据，
不影响校验）。未触碰 `package.json`、`model2_pipeline`、`tool_loop`。

## 剩余 28 组界定

R1 基线共 43 组。R2 精简 5 组（qbank / workbench / workspace / self-service /
vfs-memory），R3 精简 10 组（automation / mindmap / user-todo / session-manager /
textbook-pdf / canvas-note / browser / settings / dstu / translation），
剩余 28 组即本轮全集（见下表标注 R4 的行）。本轮完成后，**43 组全部经过
description 精简**，WI-10 schema 侧收口。

## 全库前后对比（43 组；「前」= R3 完成时，口径同 R1：`JSON.stringify(embeddedTools)` 字符数，tokens = chars/4）

| Skill 组 | schema 字符（前） | schema 字符（后） | tokens（前） | tokens（后） | 降幅 | 处理轮次 |
| --- | --- | --- | --- | --- | --- | --- |
| `qbank-tools` | 24685 | 24685 | 6172 | 6172 | — | R2 已精简 |
| `workbench-tools` | 16104 | 16104 | 4026 | 4026 | — | R2 已精简 |
| `workspace-tools` | 14924 | 14924 | 3731 | 3731 | — | R2 已精简 |
| `self-service-tools` | 9079 | 9079 | 2270 | 2270 | — | R2 已精简 |
| `automation-tools` | 9044 | 9044 | 2261 | 2261 | — | R3 已精简 |
| `vfs-memory` | 8686 | 8686 | 2172 | 2172 | — | R2 已精简 |
| `mindmap-tools` | 8439 | 8439 | 2110 | 2110 | — | R3 已精简 |
| `user-todo-tools` | 8250 | 8250 | 2063 | 2063 | — | R3 已精简 |
| `session-manager` | 7677 | 7677 | 1920 | 1920 | — | R3 已精简 |
| `textbook-pdf-tools` | 6428 | 6428 | 1607 | 1607 | — | R3 已精简 |
| `browser-tools` | 4688 | 4688 | 1172 | 1172 | — | R3 已精简 |
| `canvas-note` | 4626 | 4626 | 1157 | 1157 | — | R3 已精简 |
| `settings-tools` | 4293 | 4293 | 1074 | 1074 | — | R3 已精简 |
| `translation-tools` | 3905 | 3905 | 977 | 977 | — | R3 已精简 |
| `dstu-tools` | 3901 | 3901 | 976 | 976 | — | R3 已精简 |
| `review-planning` | 4139 | 3720 | 1035 | 930 | **-10.1%** | R4 |
| `xlsx-tools` | 4366 | 3678 | 1092 | 920 | **-15.8%** | R4 |
| `template-designer` | 4162 | 3519 | 1041 | 880 | **-15.4%** | R4 |
| `docx-tools` | 3818 | 3143 | 955 | 786 | **-17.7%** | R4 |
| `pptx-tools` | 3501 | 3035 | 876 | 759 | **-13.3%** | R4 |
| `academic-search` | 3671 | 2930 | 918 | 733 | **-20.2%** | R4 |
| `essay-grading` | 3124 | 2863 | 781 | 716 | **-8.4%** | R4 |
| `llm-usage-tools` | 2823 | 2528 | 706 | 632 | **-10.4%** | R4 |
| `file-manager-tools` | 2615 | 2379 | 654 | 595 | **-9.0%** | R4 |
| `task-governance-tools` | 2447 | 2251 | 612 | 563 | **-8.0%** | R4 |
| `learning-resource` | 2505 | 2122 | 627 | 531 | **-15.3%** | R4 |
| `connector-tools` | 2293 | 2080 | 574 | 520 | **-9.3%** | R4 |
| `data-governance-tools` | 2259 | 2048 | 565 | 512 | **-9.3%** | R4 |
| `index-webpage-tools` | 2148 | 1921 | 537 | 481 | **-10.6%** | R4 |
| `learning-overview-tools` | 2042 | 1843 | 511 | 461 | **-9.7%** | R4 |
| `attachment-tools` | 1905 | 1572 | 477 | 393 | **-17.5%** | R4 |
| `knowledge-retrieval` | 1691 | 1343 | 423 | 336 | **-20.6%** | R4 |
| `role-packs` | 1388 | 1273 | 347 | 319 | **-8.3%** | R4 |
| `image-generation` | 1250 | 1141 | 313 | 286 | **-8.7%** | R4 |
| `todo-tools` | 1305 | 1124 | 327 | 281 | **-13.9%** | R4 |
| `subagent-worker` | 1154 | 1060 | 289 | 265 | **-8.1%** | R4 |
| `ask-user` | 884 | 794 | 221 | 199 | **-10.2%** | R4 |
| `document-processing` | 898 | 717 | 225 | 180 | **-20.2%** | R4 |
| `media-tools` | 817 | 709 | 205 | 178 | **-13.2%** | R4 |
| `tool-pack` | 849 | 655 | 213 | 164 | **-22.9%** | R4 |
| `web-fetch` | 642 | 576 | 161 | 144 | **-10.3%** | R4 |
| `office-fidelity-tools` | 514 | 465 | 129 | 117 | **-9.5%** | R4 |
| `root-request-tools` | 543 | 405 | 136 | 102 | **-25.4%** | R4 |
| **合计（43 组）** | **194482** | **186623** | **48638** | **46671** | **-4.0%** | — |

- **R4 处理的 28 组小计**：59753 → 51894 字符（**-13.2%**），每组均 ≥8%
  （最低 `task-governance-tools` -8.0%，最高 `root-request-tools` -25.4%）。
- **结构主导组说明**：`llm-usage-tools`（单工具 5 分支 oneOf）与
  `learning-overview-tools`（oneOf 双分支）原判断接近「只动 description」上限，
  实际通过「删除 oneOf 分支内与顶层重复的 description 注释键」（校验结构不变，
  R3 手法 6 的推广）分别达成 -10.4% / -9.7%，无需保留豁免；本轮 28 组
  **无一组需要声明结构主导豁免**。

## 全库累计（vs R1 基线）

| 指标 | R1 基线 | R2 后 | R3 后 | **R4 后** | 累计降幅 |
| --- | --- | --- | --- | --- | --- |
| schema 总字符 | 216131 | 202389 | 194482 | **186623** | **-29508（-13.7%）** |
| schema tokens (est.) | 54050 | 50614 | 48638 | **46671** | **-7379（-13.7%）** |
| schema+content 合计 tokens | 75689 | 72253 | 70277 | **68310** | **-7379（-9.7%）** |

`content`（技能指令文本）本轮亦未改动；工具数保持 282，43 组 id 不变。

## 回归护栏收紧（≈10% 余量，写入测试）

| 护栏 | 旧值（R1 起） | **新值（R4）** | 当前实测 | 余量 |
| --- | --- | --- | --- | --- |
| 单组 schema tokens 上限 | 9500 | **6800** | 6172（qbank-tools） | ≈10.2% |
| 全部组 schema tokens 合计上限 | 68000 | **51500** | 46671 | ≈10.3% |
| schema+content 合计上限 | 95000 | **75500** | 68310 | ≈10.5% |

旧护栏是 R1 现状 +25% 余量；三轮精简后若沿用会留下 ≈46% 的虚余量，
增量回吃不可见。新护栏以 R4 实测为基线 +≈10%，越线即强制显式决策
（先精简、确属合理再上调并在本文件追加记录）。

## prompt_builder.rs 精简（删重复句）

`src-tauri/src/chat_v2/prompt_builder.rs` 的两个静态常量存在 rules 与
examples 之间的逐句重复，本轮删除重复的**示例行**、完整保留**规则句**：

1. `CITATION_GUIDE`：规则 6 已写明「禁止在回复末尾生成"参考文献"…表格或列表」，
   删除 examples 中重复的
   `错误：在回复末尾添加"参考文献"表格（系统已自动展示，禁止重复）` 一行。
2. `LATEX_RULES`：规则 7 已同时给出正确（`$\boxed{C}$`）与禁止（`[\boxed{C}]`）
   两种写法，删除 examples 中重复的
   `- 带框答案：$\boxed{C}$ 或 $$\boxed{C}$$` 与
   `- [\boxed{C}] （\boxed 未用 $ 包裹，禁止！）` 两行。

体积变化：`LATEX_RULES` 984 → 905 字符（-8.0%）、`CITATION_GUIDE`
760 → 727 字符（-4.3%）。该文本随**每一条**聊天请求进入 system prompt
（LATEX_RULES 恒定注入、CITATION_GUIDE 在有检索来源时注入），为高频路径。

**测试守护**：新增单元测试 `test_static_prompt_blocks_stay_within_budget`——

- 字符预算：`LATEX_RULES ≤ 950`、`CITATION_GUIDE ≤ 750`，均低于精简前体积，
  重复句回归即测试失败；
- 去重断言：`\boxed{C}` 在 LATEX_RULES 中只允许出现规则 7 的 2 处、
  `参考文献` 在 CITATION_GUIDE 中只允许规则 6 的 1 处；
- 语义保留断言：规则句（`\boxed{} 命令必须用 $...$ 包裹`、`禁止在回复末尾生成`）
  必须仍然存在。

## 契约测试对账（description 断言与精简后文案同步）

skills 契约测试大量以 `toContain` 固定 description 原文子串。本轮按
「语义仍在 → 改断言指向新文案/技能 content；语义确实丢失 → 描述里最小化恢复」
两条规则逐条对账：

- **改断言**（新文案或 content 已覆盖同一契约语义）：
  `fileManagerToolsContract`（`Every source is re-hashed` → `re-hashed`）、
  `phase8IndexWebpageTools`（内部服务名 `VfsFullIndexingService` → `完整索引`；
  `blob + source metadata` → `hasMore=true`，源元数据由 url/title schema 断言覆盖）、
  `phase10LearningOverviewTools`、`rolePacksContract`、`toolPackSkillContract`、
  `mediaAndBinaryGapContracts`（`外部 ASR 提供商` → `外部 ASR`）、
  `taskGovernanceToolsContract`（TaskObjectHandle / 收件人/ACL / Role Pack /
  incompleteLayers 断言改指技能 content，原文即含这些事实）。
- **描述最小化恢复**（约束性事实不应从 description 消失）：
  `web-fetch` 恢复「最终跳转域名」（二进制物化按重定向终点校验域名）、
  `essay-grading.mode_id` 恢复「（含自定义模式）」、
  `task-governance-tools` 恢复 `coverageComplete=false` 与
  `rootId+relativePath`（同时用等量其他压缩保住该组 -8.0%）。
- **修复存量断裂**（R2 精简 workspace-tools/browser-tools 时未同步，主干上
  即已失败，非本轮引入）：`workspaceToolsContract` 3 处
  （`Defaults to false`、`不要在正文中自行索要确认`、`后端按当前会话档位`）、
  `mediaAndBinaryGapContracts` 1 处（`PLATFORM_API_UNAVAILABLE` → `reasonCode`）。

对账后上述 10 个契约测试文件全部通过；其余 vitest 存量失败
（UI/jsdom 及 qbank、dstu、session 等契约）与主干基线完全一致，非本轮引入。

## 精简手法（沿用 R2/R3，无新增结构性改动）

1. 删「【必填】」「可选：」标记（required/字段缺省已表达）；
2. 删 schema 已编码的 default/min/max/maxLength 复述；
3. 删「当用户说 XXX 时使用」类触发例句（与技能 `content` 的典型场景节重复）；
4. 跨工具重复的 workspace 输出参数块（output_target/root_id/relative_path/
   overwrite_policy/expected_sha256，xlsx/docx/pptx 三组 ×2 工具共 5 处）统一压缩；
5. 与技能 `content` 逐句重复的说明改为「见技能说明」引用
   （essay-grading 链路、task-governance 输入构成、learning-overview 数据边界等）；
6. oneOf 分支内与顶层重复的 description 注释键删除
   （llm-usage-tools、learning-overview-tools；校验结构不变）。

语义保留原则：敏感度等级（Low/Medium/High）、OCC/expected_* 要求、审批与确认
规则（ask_user、不可撤销警示）、互斥与「显式传空数组/not_applicable」契约、
参数名反混淆提示（top_k vs limit）、拒绝边界（critical 目录、凭据不入参）等
硬约束全部保留。

## 验证

- `npx vitest run tests/vitest/chat-v2/token-budget.test.ts`：**7/7 通过**
  （含收紧后的三条护栏断言与 schema round-trip 校验）。
- `cargo test --lib chat_v2::prompt_builder`（Rust 1.98.0 stable + lld）：
  **14/14 通过**（含新增守护测试 `test_static_prompt_blocks_stay_within_budget`；
  环境注：容器默认 Rust 1.83 因依赖 edition2024 无法编译、1.90 又缺
  `cfg_select`（libsqlite3-sys 0.38），需 `rustup default stable` 并安装
  `lld`、`protobuf-compiler`，且先运行 `scripts/download-pdfium.sh linux-x64`）。
- `npx tsc --noEmit -p tsconfig.json`：0 错误（先运行
  `node scripts/generate-version.mjs` 生成 `@/version`）。

## 复现方式

```bash
npx vitest run tests/vitest/chat-v2/token-budget.test.ts

TOKEN_BUDGET_REPORT_PATH=/tmp/token-budget-report.md \
  npx vitest run tests/vitest/chat-v2/token-budget.test.ts

cd src-tauri && cargo test --lib chat_v2::prompt_builder
```

## 改动文件

- `src/features/chat/skills/builtin-tools/`（28 个文件）：
  `academic-search.ts`、`ask-user.ts`、`attachment-tools.ts`、`connector-tools.ts`、
  `data-governance-tools.ts`、`document-processing.ts`、`docx-tools.ts`、
  `essay-grading.ts`、`file-manager-tools.ts`、`image-generation.ts`、
  `index-webpage-tools.ts`、`knowledge-retrieval.ts`、`learning-overview-tools.ts`、
  `learning-resource.ts`、`llm-usage-tools.ts`、`media-tools.ts`、
  `office-fidelity-tools.ts`、`pptx-tools.ts`、`review-planning.ts`、
  `role-packs.ts`、`root-request-tools.ts`、`subagent-worker.ts`、
  `task-governance-tools.ts`、`template-designer.ts`、`todo-tools.ts`、
  `tool-pack.ts`、`web-fetch.ts`、`xlsx-tools.ts`
- `tests/vitest/chat-v2/token-budget.test.ts`（护栏收紧 9500/68000/95000 →
  6800/51500/75500）
- `src-tauri/src/chat_v2/prompt_builder.rs`（删 3 行重复示例 + 新增守护测试）
- `src/features/chat/skills/__tests__/`（8 个契约测试对账，见上节）：
  `fileManagerToolsContract`、`mediaAndBinaryGapContracts`、
  `phase8IndexWebpageTools`、`phase10LearningOverviewTools`、
  `rolePacksContract`、`taskGovernanceToolsContract`、
  `toolPackSkillContract`、`workspaceToolsContract`
- 本报告
