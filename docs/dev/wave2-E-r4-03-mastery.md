# Wave2-E R4-03：mastery 换判纠正（tombstone + `_r{n}` 修订事件）

- 角色：0824 Wave2-E 第 4 轮「mastery correction」
- 改动文件：仅 `src-tauri/src/mastery/service.rs`（types.rs 无需改动）
- 禁改区遵守：未动 `question_bank_service.rs`、`qbank_grading/pipeline.rs`、前端
- 约束遵守：未跑编译/测试/CI，未 commit；单测只写不跑

## 1. 问题（r1-06 §3 复述）

qbank 事件幂等键固定为 `me_qbank_{submission_id}`（service.rs `record_qbank_answer_with_conn`），
写入走 `INSERT ... ON CONFLICT(id) DO NOTHING`。首判（NULL→有值）插入成功；
换判（true↔false，人工改判或 AI 复判）再调 `record_qbank_answer_with_conn` 时
同键已存在 → DO NOTHING → 事件流里留下的仍是**首判 outcome**，随后的
`recompute_state_with_conn` 按旧事件回放，score/wrong_count/streak 全部停在首判信号。

## 2. 方案：参照 `revert_fsrs_rating_for_log` 的 tombstone 范式

append-only 语义下不 UPDATE 旧事件的语义列（outcome/signal/weight），换判走：

1. **tombstone**：软删该 submission 事件链上仍存活的旧事件
   （`deleted_at = COALESCE(deleted_at, now)`，同时推进 `updated_at/local_version`，
   与 `revert_fsrs_rating_for_log` 完全同一 SQL 写法——`mastery_events` 在同步分类里是
   NoConflict append-only，tombstone 可安全跨设备传播）；
2. **纠正事件**：追加 `me_qbank_{sid}_r{n}`（n 取链上最大修订号 +1；首判视为 rev 0）。
   `weight = 1.0` 直写，绕过 `compute_event_weight_with_conn` 的 60s 防刷衰减
   （否则纠正后的 correct 会被压到 0.25）；仍带 `ON CONFLICT(id) DO NOTHING` 兜底；
3. **重算**：复用既有 `recompute_state_with_conn`（已过滤 `deleted_at IS NULL`）。
   若旧事件因 tags 漂移挂在不同 concept，旧 concept 一并重算，防止残留旧聚合。

## 3. 新增 pub 函数签名

```rust
// src-tauri/src/mastery/service.rs（impl MasteryService）

/// 事务内原语：判分事务（regrade / AI 管线 SAVEPOINT）直接传入 conn 调用。
pub fn record_qbank_verdict_correction_with_conn(
    &self,
    conn: &Connection,
    submission_id: &str,
    question_id: &str,
    tags: &[String],
    new_is_correct: bool,
) -> Result<MasteryState, AppError>;

/// 自持事务版：开 IMMEDIATE 事务调用上者，commit 后 sync_learner_profile
/// （回流失败仅 warn，不回滚，与 record_fsrs_rating_for_log 同口径）。
pub fn record_qbank_verdict_correction(
    &self,
    submission_id: &str,
    question_id: &str,
    tags: &[String],
    new_is_correct: bool,
) -> Result<MasteryState, AppError>;
```

两者均为 pub——question_bank 侧本轮未接线，留给判分原语
（r1-06 §2 的 `apply_submission_verdict_in_tx`）后续调用。

### 幂等与降级语义

| 场景 | 行为 |
|---|---|
| 存活末端事件方向已与 `new_is_correct` 一致（同向重放） | 不追加事件，仅重算返回 |
| 换向 | tombstone 存活旧事件 + 追加 `_r{n+1}` + 重算 |
| 纠正事件 id 已存在（同一纠正在事务重放） | ON CONFLICT DO NOTHING 兜底 |
| 链上无任何事件（AI 判分路从未写首判） | 退化为首判 record（写 `me_qbank_{sid}`，含正常防刷权重） |

事件链识别用 `id = base OR substr(id, 1, length(prefix)) = prefix` 前缀匹配
（非 LIKE，避免 submission_id 中 `_`/`%` 当通配符），并在 Rust 侧要求修订后缀
为纯数字 `_r{digits}`，排除恰以 `{sid}_r` 开头的其它 submission。

### 接线指引（后续轮，question_bank 侧）

- `regrade_submission_in_tx`（question_bank_service.rs L794 附近）：
  `submission.is_correct` 为 None → 维持 `record_qbank_answer_with_conn`；
  为 Some 且方向变化 → 改调 `record_qbank_verdict_correction_with_conn`。
- AI 管线落库段（pipeline.rs ②③ 段抽原语后）：AI 首判 → record；AI 复判换向 → correction。
- `record_qbank_answer_with_conn` 的文档注释已加指引，防止再次误用 record 路做换判。

## 4. 单测（只写不跑）

`mastery/service.rs` tests 模块新增：

1. `qbank_verdict_correction_false_to_true_recomputes_state`
   - 首判 wrong（与主链同款事务内写入）→ 复现 record 路换向被锁死
     （score 停在 0.35、wrong_count=1）；
   - 调 `record_qbank_verdict_correction(..., true)` 后：
     score = 0.5 + 0.3·(1.0−0.5) = **0.65**（只按纠正事件回放），
     total=1、wrong_count=0、streak=1；
   - 终态表断言：`me_qbank_{sid}` 已 tombstone 且 outcome 仍为 'wrong'
     （append-only，语义列未被 UPDATE）；`me_qbank_{sid}_r1` 存活、outcome='correct'、
     weight=1.0（防刷旁路）。
2. `qbank_verdict_correction_is_idempotent_and_supports_reflip`
   - 空链降级首判 → 同向重放不追加 → false→true 追加 `_r1` →
     true→false 追加 `_r2`（`_r1` 被 tombstone）；
   - 终态：链上共 3 条事件（base+_r1+_r2），存活仅 `_r2`，score=0.35。

## 5. 结论

- **纠正后是否仍被 ON CONFLICT 锁死首判？否。** 纠正路径的新事件 id 带 `_r{n}`
  修订后缀，与首判键不同，不会命中 DO NOTHING；旧事件被 tombstone 后
  `recompute_state_with_conn` 只回放存活事件，状态跟随最新判定。
- **record 路本身仍保留 ON CONFLICT DO NOTHING**（有意为之）：它继续保证
  "首判恰好一次"的幂等；换判必须显式走 correction 函数。question_bank 侧
  在接线完成前，人工改判链路（regrade_submission_in_tx）的 mastery 信号
  仍是旧行为——这是本轮范围边界，非残留缺陷。
