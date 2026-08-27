# Wave2-E R4-02：qbank AI 判分管线迁移到共享判分原语

- 角色：0824 Wave2-E 第 4 轮「grading pipeline 迁移」
- 独占范围：`src-tauri/src/qbank_grading/pipeline.rs`（同目录 types/events 未动，无需动）
- 禁改：`src-tauri/src/question_bank_service.rs`（原语由 r4-01 抽取，未触碰）
- 约束：未跑编译/测试/CI，未 commit；测试只写不跑

## 1. 结论速览

1. **旧 UPDATE 已删除**：pipeline.rs 原 L220-268 的 Grade 模式手写落库
   （② `UPDATE answer_submissions` + ③ 带 `WHEN is_correct IS NULL AND ?1 = 1`
   单向守卫的 `UPDATE questions`）整段移除。旧实现只处理 NULL→true +1，
   false→true 不加、true→false 不减，且完全不写 mastery 事件
   （r1-06 §2 的 B 路分叉）。
2. **改为调用共享原语**：`QuestionBankService::apply_submission_verdict_in_tx`
   （`grading_method = "ai"`）。开工时该符号尚未出现，按任务约定先写调用 +
   文件头注释预期签名；本轮进行中 r4-01 已在同一工作区把原语落地
   （question_bank_service.rs L786，`&self` 方法，其 doc 注释明确给出
   pipeline 侧调用形态），调用点与文件头注释已改为对齐**实际签名**：

```rust
QuestionBankService::new(Arc::clone(vfs_db))
    .apply_submission_verdict_in_tx(conn, question, &submission, v.is_correct(), "ai", &now)
```

3. mastery 事件由原语写入（幂等键 `me_qbank_{submission_id}`），pipeline
   **不重复插**；统计刷新（`refresh_stats_with_conn`）也由原语在事务内完成，
   pipeline 原事务外的 `VfsQuestionRepo::refresh_stats` 调用一并删除。
4. 旧测试（SSE/verdict 解析）无一依赖旧 UPDATE 语义，全部保留；新增 3 个
   持久化单测覆盖 NULL→true（含防重复）、false→true、true→false（只写未跑）。

## 2. pipeline.rs 改动明细

### 2.1 持久化段重构（run_qbank_grading 第 8 步）

- 原 SAVEPOINT 内的闭包整体抽为独立函数
  `persist_grading_result(conn, vfs_db, question, mode, submission_id,
  feedback, verdict, score)`，便于单测直接驱动落库路径（不需要跑 LLM 流）。
- 保留 pipeline 独有职责（r1-06 §2 明确不属于判分原语的部分）：
  - ① AI 缓存写入：`ai_feedback / ai_score / ai_graded_at`（Analyze 模式
    仍不触碰 ai_score）；
  - Analyze 模式的 S-030 同步标记 + content hash 重算（只改了 ai_feedback，
    不会走原语，需自行标记）。
- **Grade 模式判分落库整体换成原语调用**：submission 判定 + grading_method
  + RowSync 推进（updated_at/local_version）、correct_count 差值
  （±1 / `MAX(0,·)` 防负）、状态 CASE（错→review、>=2→mastered）、
  mark_as_modified、content hash、mastery 事件、refresh_stats 全部由原语在
  同一事务内完成。Grade 模式下 pipeline 不再自行调用
  mark_as_modified / update_content_hash（原语已做；同一事务内先写
  ai_feedback 再由原语重算 hash，覆盖两处变更）。

### 2.2 差值基准修正（配合 r1-06 §2 指出的隐患）

旧 ③ 段以 `questions.is_correct`（题目级旧值）做增量判断，评判期间用户再
提交会把新提交的判定当作本 submission 的前值。现改为**事务内重读**被评判
submission（新增 `get_submission_by_id_with_conn`，原 `get_submission_by_id`
改为其薄包装），把携带旧 `is_correct` 的最新 submission 传给原语作差值基准
（原语内部正是按 `submission.is_correct` 计算 delta），并保留 `question_id`
归属校验（防串题写入）。

### 2.3 事务外收尾对齐人工改判路径

- SM-2 复习计划：由原判 verdict 判断改为消费 `outcome.needs_review_plan`
  （与 `regrade_submission_in_tx` 的事务外收尾完全同构）；
- 新增 `outcome.mastery_state → sync_learner_profile` 回流（旧 AI 路完全
  没有此步；失败仅 warn 不阻塞）；
- 删除事务外 `refresh_stats`（原语在事务内已刷，避免双刷）。

## 3. 与已落地原语的契约核对

r4-01 落地版与 r1-06 §2 草案的差异及 pipeline 侧处理：

| 项 | r1-06 草案 | r4-01 落地版 | pipeline 侧 |
|---|---|---|---|
| 调用形态 | 自由关联函数 | `&self` 方法（需 `QuestionBankService::new`） | 已按落地版调用 |
| Outcome 字段 | updated_question / mastery_state / needs_review_plan | 另加 `changed`、`updated_stats` | 只消费 needs_review_plan / mastery_state |
| 同向幂等 | 短路 | 短路（changed=false，零写入） | 测试 1 断言重跑不重复计数 |
| mastery 换判 | tombstone + `_rN` 纠正事件 | 仍走 `record_qbank_answer_with_conn`（DO NOTHING 停首判信号）；纠正原语 `record_qbank_verdict_correction_with_conn` 已由 r4-03 提供但**接线留待后续轮** | 测试按落地行为断言"换判不重复插事件"，并注释接线后应改为"未删除事件只剩新判定" |

## 4. 测试（只写未跑）

旧测试均为 SSE / verdict 解析类（`test_sse_block_signals_finish_*`、
`test_parse_verdict_and_score*`），不涉及旧 UPDATE，保留不动；代码库中也无
其他测试断言旧"仅 NULL→true +1"行为（已 grep 确认 qbank_grading 仅被
lib.rs / question_bank_service.rs / qbank_executor.rs 引用，均不触及落库 SQL）。
原语自身的计数/RowSync 口径已由 r4-01 的
`apply_submission_verdict_counts_and_rowsync` 直接覆盖；本轮新增测试从
pipeline 的 `persist_grading_result` 入口驱动，验证管线接线后的端到端落库。

新增 3 个单测（pipeline.rs tests 模块，基于 `setup_migrated_test_db` 真实
schema；换判基线用 `submit_answer` 自评 override 落下计数与首判 mastery 事件）：

| 测试 | 基线 | AI verdict | 断言要点 |
|---|---|---|---|
| `persist_grade_first_verdict_null_to_true_counts_once` | 待判定 submission（is_correct NULL） | correct | correct_count 0→1、status=in_progress、grading_method='ai'、mastery 事件恰 1 条；同向重跑不再 +1、事件不重复（旧 NULL 守卫的防重复语义由原语幂等承接） |
| `persist_grade_false_to_true_increments_correct_count` | submit_answer override=false | correct | correct_count 0→1（旧实现漏掉的方向）、attempt_count 不变（换判不新增作答）、mastery 事件不重复插、needs_review_plan=false |
| `persist_grade_true_to_false_decrements_correct_count` | submit_answer override=true | incorrect | correct_count 1→0（旧实现漏掉的方向、MAX(0,·) 防负）、status=review、mastery 事件不重复插、needs_review_plan=true |

## 5. 留给后续轮的交接点

- r4-03 的 `record_qbank_verdict_correction_with_conn`（tombstone + `_rN`
  纠正事件）接入 `apply_submission_verdict_in_tx` 后，AI 路自动受益，
  pipeline 无需再改；届时把 §4 两个换判测试的事件断言从"不重复插"
  升级为"未删除事件只剩新判定"（测试内已留注释标记位置）。
- `VerdictApplyOutcome.updated_question / updated_stats / changed` 目前
  pipeline 未消费（评判完成事件仍以 feedback/verdict/score 为载荷）；若后续
  想让前端拿到落库后的权威计数，可在 emit_complete 中携带。
