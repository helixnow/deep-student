# Wave2-E R7-04：verdict 三路测试扩展

- 角色：0824 Wave2-E 第 7 轮「verdict 三路测试」
- 独占文件：`src-tauri/tests/qbank_verdict_three_paths.rs`（扩展，不删旧用例）+ 本文档
- 本轮未跑编译/测试/CI，未 commit（按轮次纪律，由外层统一处理；
  本文件的用例与 R4 存量一样，**第 8 轮统一执行**）。

## 1. AI 路（B 路）integration 可测性结论：仍不可直接测 ❌ → 文档化

R7 复核维持 R4 结论，B 路无法在 `qbank_verdict_three_paths.rs`
（默认 harness 集成测试）内直接驱动，依据：

1. **入口强依赖 tauri Window**：`run_qbank_grading(request, deps)` 的
   `QbankGradingDeps.emitter` 是具体类型 `QbankGradingEmitter`
   （qbank_grading/events.rs L10），唯一构造函数 `::new(window: tauri::Window)`，
   无 trait 抽象、无测试替身注入点。
2. **建 Window 须 harness=false**：仓库内唯一成功建 tauri App + Window 的
   测试是 `tests/qbank_executor_e2e.rs`，其前提是 Cargo.toml 的
   `[[test]] harness = false` 注册（L221-224）。为本文件补注册须改
   `src-tauri/Cargo.toml`——产品文件，本轮禁改。
3. **无旁路 pub 入口**：`persist_grading_result` 为模块私有，AI 落库段只能
   经 `run_qbank_grading` 到达；`apply_submission_verdict_in_tx` 为
   pub(crate)，集成测试（外部 crate 视角）不可见。

**逼近策略（R7 已落地）**：因 B/C 两路共用
`apply_submission_verdict_in_tx`，两路对 submission 行的写入仅
grading_method 字面量（'ai' vs 'manual'）不同。故本文件用「先经 pub API 走
NULL→true 改判、再单列覆写 grading_method='ai'」构造出与真实 B 路判分
**逐列一致的落库终态**，在其上黑盒验证 B→C 交接（AI 判定被人工换判）。
种子模式与文件内 legacy 兼容用例同源（旁证 SQL，非私有 API）。

## 2. B 路行为的 manual/auto 转移表（覆盖归属）

| # | B 路行为 | auto（自动测试位置） | manual（人工验证步骤） |
|---|---------|----------------------|------------------------|
| B1 | 首判 correct → correct_count +1、grading_method='ai' | `tests/qbank_executor_e2e.rs`（mockito SSE + 真 Window） | — |
| B2 | 换判 false→true / true→false 计数等价 + mastery tombstone/`_rN` | pipeline.rs in-crate 白盒（R6 已收紧方向断言）+ 原语白盒 `apply_submission_verdict_counts_and_rowsync` | — |
| B3 | AI 判定后的人工换判（B→C 交接：'ai' 收敛 'manual'、-1、review、RowSync 推进） | 本文件 `ai_decided_verdict_manual_flip_converges_to_manual_method`（终态种子逼近） | — |
| B4 | 同向 verdict 重放零写入（原语入口短路） | 原语白盒 + 本文件 `idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync`（pub 面等价） | — |
| B5 | SSE 流式判分全链路（事件序列 grading_started/verdict/error、断流/取消） | e2e 覆盖 completed 主径 | 断流/取消的 UI 表现：真机启动应用 → 题集练习提交主观题 → 触发 AI 判分中途断网/点取消 → 核对错误提示与题目状态未脏写 |
| B6 | AI 判分与前端 daily 回写联动（判分后当日进度即时刷新） | 快照口径由本文件 `daily_progress_write_back_matches_get_daily_practice` 锁定（C 路同口径） | 真机：AI 判分完成后不刷新页面，核对每日一练 completed/correct 即时变化 |

第 8 轮若扩展 `qbank_executor_e2e.rs`（可建 Window，B2/B5 可升级为
auto），应对齐 `qbank_verdict_three_paths.rs` 头部契约表，并将本表对应行
的 manual 步骤降级为回归项。

## 3. grading_method 转移表（auto / ai / manual 状态机，本文件锁定）

| 事件 | grading_method 转移 | 锁定测试 |
|------|--------------------|----------|
| 客观题提交（自动判分） | (插入) → `auto` | `grading_method_origin_matrix_matches_documented_table` |
| 主观题提交（待判定，等 AI/人工） | (插入) → `ai` | 同上 |
| 带 override 的新作答提交 | (插入) → `manual` | 同上 |
| A 路待判定去重 / C 路改判（换判生效） | 任意 → `manual` | `auto_graded_choice_regrade_transfers_method_and_counts`、`ai_decided_verdict_manual_flip_converges_to_manual_method` 等 |
| B 路 AI persist（判定生效） | 任意 → `ai` | qbank_executor_e2e（首判）+ pipeline 白盒（换判） |
| 同向幂等重放（任一路） | 不变（零写入） | `idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync` |

## 4. 本轮新增测试（追加，未删/未改旧用例断言）

| 测试名 | 意图 |
|--------|------|
| `grading_method_origin_matrix_matches_documented_table` | 插入分支三起点（auto/ai/manual）字面量矩阵，为收敛断言定参照系 |
| `auto_graded_choice_regrade_transfers_method_and_counts` | 'auto' 起点走 C 路换判：false→true +1 / true→false -1、attempt 恒 1、method auto→manual |
| `idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync` | 同向幂等零写入的 pub 面：不洗 method、不推 RowSync、计数不动 |
| `ai_decided_verdict_manual_flip_converges_to_manual_method` | B→C 交接（终态种子）：'ai' 判定被人工换判 → -1、review、method 收敛 manual、local_version +1 |
| `true_to_false_regrade_clamps_correct_count_at_zero` | 计数漂移库上 true→false，MAX(0,·) 钳制不下穿为负（纯 pub 流程不可达分支） |
| `regrade_guard_rejects_stale_or_unknown_submission_without_side_effects` | pub 守卫黑盒面：stale/未知/零作答均报错且零副作用 |

配套改动：测试文件头部补「grading_method 转移表」与 B 路 R7 复核结论；
新增 `create_choice_question` 夹具（single_choice，自动判分路起点）。

## 5. 回复

**AI 路仍不可在本 integration 文件直接测**（Window 强依赖 + harness=false
须改 Cargo.toml，产品文件本轮禁改），已按 §1 文档化并以落库终态种子逼近
B→C 交接；§2/§3 给出 manual/auto 双转移表。新增 6 个测试（见 §4），
旧 7 例全保留，第 8 轮统一执行。
