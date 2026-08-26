model=claude-fable-5-thinking-xhigh
# 29 — Step 22 候选：`enableQaPass=false` 不落盘 `_qa_flags`

本文为 MERGE-PLAN Step 22 的候选起草，只覆盖一项修复：`enableQaPass=false`
时后端仍将确定性 lint 结果写回 `extra_fields["_qa_flags"]` 的开关契约缺口
（04 号报告 WARN 第 1 项，12 号报告归因为 **0824 引入**）。修复应在隔离枝
`cursor/0824-fix-anki-qa-cde6` 上完成并验证，再由官方 0824 唯一写入者按
既有 cherry-pick 收口惯例落地。本文不修改 `docs/0824-MERGE-PLAN.md`。

## 结论

**建议受理为 Step 22，范围仅此一项。** 公开 schema 承诺
`enableQaPass=false` = 不产出 `_qa_flags` 留痕，但实现只删除了字段规则
写入的旧 flag，随后确定性 lint 仍无条件经 `merge_flags` 重新落盘。候选
修复为最小改动：以 `qa_pass_enabled` 守卫 `merge_flags` 写入，校验本身
照跑（与现有代码注释「校验本身照跑，仅不落盘」的既定语义一致）。critic
留痕（`llm_critic`）由 `enableCriticPass` 独立控制，不在本候选范围。

**本轮不改代码。** 本文仅为候选方案与验收标准，实际修改在隔离枝
`cursor/0824-fix-anki-qa-cde6` 上进行。

## 缺口事实（静态核实于当前 0824 树）

1. 对模型公开的契约：`src/features/chat/skills/builtin/index.ts:283-287`
   （chatanki_run）与 `374-378`（chatanki_start）均称 `enableQaPass` 为
   「字段 QA 校验留痕开关……仅在用户明确不要 QA 留痕时传 false」。
2. 实现第一半在位：`src-tauri/src/streaming_anki_service.rs:1904-1907`
   在 `!qa_pass_enabled` 时移除 `extract_fields_with_rules`
   （`2103-2473`）已写入的字段规则违规 `_qa_flags`。
3. 实现第二半缺失：同文件 `1944-1968` 的单卡确定性 lint
   （`lint_card`）与文档级重复/近重复检测（`observe_document_card`）
   不受 `qa_pass_enabled` 保护，`1968` 行 `merge_flags` 无条件把 lint
   结果重新写入 `_qa_flags` 并随卡片落盘。
4. 连带影响：`1296`/`1486` 行按 `extra_fields` 是否含 `_qa_flags` 累计
   `StreamStats::flagged_cards`，因此关闭开关后统计仍会计入被 lint
   标记的卡，进一步偏离「无留痕」语义。

## 候选修复方案（最小改动）

在 `streaming_anki_service.rs` 中，把 `1968` 行的
`merge_flags(&mut cleaned_extra_fields, &lint_issues)` 置于
`if qa_pass_enabled` 守卫之下；`1904-1907` 的既有移除逻辑保持不变。

- lint 与文档级指纹检测照常执行（日志与调试价值保留），仅不落盘——
  与 `1904` 行注释的既定语义一致，不引入新参数、不改协议与 schema；
- `flagged_cards` 统计无需另改：不写 `_qa_flags` 后自然归零，与
  「无留痕」语义自洽；
- 明确边界：`anki_critic.rs`（`613`/`656`/`668` 行的 `merge_flags`）
  写入的 `llm_critic` 审计留痕由 `enableCriticPass` 独立 opt-in 控制，
  用户显式开启 critic 即接受其审计痕迹，本候选不触碰。

## 验收标准（隔离枝上完成）

1. 新增回归测试：`qa_pass_enabled=false` 时经完整解析路径产出的卡片
   `extra_fields` 不含 `_qa_flags`（覆盖字段规则违规 + lint 违规 +
   文档级重复三种触发源）；`qa_pass_enabled=true` 行为不变。
2. 既有测试全绿：`cargo test --lib streaming_anki_service`（Step 5 收口
   时 74/74，其中 `3953-3975`、`4022-4027`、`4048-4054`、`4660-4770`
   等 `_qa_flags` 断言均在 QA 开启语义下，不应受影响）、
   `cargo test --lib anki_critic`（45/45）。
3. 编译门禁照 MERGE-PLAN 第 6 节：`npm run typecheck`、`npx vite build`、
   `cargo check --manifest-path src-tauri/Cargo.toml --lib`、
   `cargo fmt --check`。
4. 红线复查：不触碰 critic 开关语义、`_occlusion` 字段合并、
   Composer* 拆分、HPIAS allowlist 等既有不变量（Step 9 §9.4 清单）。

## 范围外（本候选明确不做）

- 04 号报告的另两项 WARN（恢复卡住任务文案错配、`chat_anki_panel` 死
  key）：12 号报告判为既有问题，另行立项；
- schema 文案改写方案（把参数改称「仅关闭字段规则留痕」）：既然实现可
  低成本对齐承诺语义，不采用降级文案的方向；
- 任何对 `docs/0824-MERGE-PLAN.md` 的编辑：Step 22 正式记录由官方 0824
  写入者在落地后补写。
