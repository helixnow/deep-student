# Wave2-E R4-01：verdict 原语（apply_submission_verdict_in_tx）

- 角色：0824 Wave2-E 第 4 轮「verdict 原语」
- 独占文件：`src-tauri/src/question_bank_service.rs`（唯一代码改动文件）
- 未动：`qbank_grading/pipeline.rs`、`mastery/*`、前端、`ExamContentView`、
  `data_governance/migration/coordinator.rs`、迁移目录（本轮零新 migration）
- 依据：`docs/dev/wave2-E-r1-06-qbank-backend.md`（r1-06 锚定审阅）
- 本轮未跑编译/测试/CI，未 commit（按轮次纪律，由外层统一处理）。

## 1. 原语签名（pipeline 应调用的接口）

`regrade_submission_in_tx`（原 L712）拆成两层：

```rust
// question_bank_service.rs

/// apply_submission_verdict_in_tx 的落库产物。
/// 事务内只做"事实写入"；SM-2 复习计划 / learner profile 回流属事务外副作用，
/// 由调用方在 commit（或 RELEASE SAVEPOINT）之后按标记执行。
pub(crate) struct VerdictApplyOutcome {
    pub changed: bool,                 // 同向幂等短路时 false（零写入）
    pub updated_question: Question,
    pub updated_stats: QuestionBankStats,
    pub mastery_state: Option<crate::mastery::MasteryState>, // changed 时 Some，事务外回流
    pub needs_review_plan: bool,       // 判"错"时 true，事务外接 SM-2
}

/// 三路判分共用原语：把"某条既有 submission 的判定变化"原子落库。
impl QuestionBankService {
    pub(crate) fn apply_submission_verdict_in_tx(
        &self,
        conn: &rusqlite::Connection,   // Transaction 经 Deref 传 &tx；裸 Connection + SAVEPOINT 直接传 &conn
        question: &Question,
        submission: &AnswerSubmission, // 携带旧 is_correct，作为差值基准
        new_is_correct: bool,
        grading_method: &str,          // "auto" | "ai" | "manual"
        now_rfc3339: &str,             // 调用方统一时间戳（pipeline 复用其 ① 段的 now）
    ) -> Result<VerdictApplyOutcome, AppError>;
}
```

`regrade_submission_in_tx` 现在只是外壳：调原语（`grading_method="manual"`）→
`tx.commit()` → 按 outcome 做事务外副作用（复习计划 / profile 回流）→ 组装
`SubmitAnswerResult`（含 `daily_progress` 快照）。`submit_answer` 的待判定去重分支
与 `regrade_submission` 走的都是这个外壳，行为等价于改造前。

### pipeline.rs 如何接（本轮未改 pipeline，留待其独占轮）

pipeline 的 persist 段用的是**裸 Connection + 手工 SAVEPOINT**
（`SAVEPOINT qbank_grading_persist`，pipeline.rs L187），不是 `Transaction`。
原语参数收 `&rusqlite::Connection`，SAVEPOINT 内直接传 `&conn` 即可生效于同一
SAVEPOINT 作用域，**不需要 with_conn 变体**。接入写法：

```rust
// qbank_grading/pipeline.rs persist 闭包内（Grade 模式分支），
// 替换现有 ②（UPDATE answer_submissions）+ ③（UPDATE questions 旧计数）两段：
let svc = crate::question_bank_service::QuestionBankService::new(Arc::clone(&deps.vfs_db));
let submission = /* SAVEPOINT 内按 request.submission_id + question_id 取 AnswerSubmission */;
let outcome = svc.apply_submission_verdict_in_tx(
    &conn,                //  SAVEPOINT 作用域内的同一连接
    &question,
    &submission,
    v.is_correct(),
    "ai",
    &now,                 // 与 ① 段 ai_graded_at/updated_at 同一时间戳
)?;
// RELEASE 之后：
//   outcome.needs_review_plan  → ReviewPlanService::get_or_create_plan（替换现 L306-317）
//   outcome.mastery_state      → mastery.sync_learner_profile（AI 路此前完全缺失）
//   outcome.updated_stats      → 已在原语内 refresh，L297-301 的事务外 refresh_stats 可删
```

注意事项：

- 原语内部含 `mark_as_modified_with_conn` + `update_content_hash_with_conn`，
  pipeline ④ 段与其重复，接入后 ④ 段可删（幂等，多调一次也不坏数据）。
- 原语的幂等短路以 `submission.is_correct == Some(new)` 判定，AI 复判同向重放
  返回 `changed=false`、零写入；换向（false→true / true→false）会正确 ±1——
  这修复 r1-06 §2 指出的 AI 路"false→true 不 +1、true→false 不 -1"分叉。
- 差值基准是**被评判 submission 的旧 is_correct**（不是题目级
  `questions.is_correct` 旧值），评判期间用户再提交新答案也不会把增量方向搞错
  （r1-06 §2 隐患）。
- 原语 SQL 严格绑定 `id + question_id`，0 行更新报 not_found，与 pipeline
  现有的串题防护等价。

## 2. 计数口径（要求 #2，已实现并写单测）

以 `(submission.is_correct, new_is_correct)` 为基准：

| 转移 | delta |
|---|---|
| NULL → true | +1 |
| false → true | +1 |
| true → false | -1，落库取 `MAX(0, correct_count + delta)` 防负 |
| NULL → false / 同向 | 0；同向直接幂等短路，零写入 |

状态 CASE 保持现语义不变：
`?1=0 → 'review'；MAX(0, correct_count+delta) >= 2 → 'mastered'；否则 'in_progress'`，
与 `submit_answer_with_conn`（question_repo.rs）同口径。

## 3. RowSync：answer_submissions 的 updated_at / local_version（要求 #3）

**列已存在**：`V20260523__add_missing_sync_coverage.sql` L103-106 已给
`answer_submissions` 补 `device_id / local_version / updated_at / deleted_at`，
本轮**没有新增任何 migration**。原语的 UPDATE 现在推进：

```sql
UPDATE answer_submissions SET
    is_correct = ?, grading_method = ?,
    updated_at = ?,                                  -- now_rfc3339
    local_version = COALESCE(local_version, 0) + 1   -- 行级 LWW 判新旧
WHERE id = ? AND question_id = ?
```

覆盖人工改判路与（接入后的）AI 判分路。仍留缺口、不在本轮独占文件内：

- `insert_submission_with_conn`（question_repo.rs L2453）INSERT 仍不写
  `updated_at/local_version/device_id`（落库 NULL/0）——修它要动 question_repo.rs，
  留待该文件的独占轮；
- `device_id` 本轮未写（要求只点名 updated_at + local_version；device_id 归
  INSERT 侧一起补更合理）；
- 遗留的 `update_submission_correct`（question_repo.rs L2530）未动，pipeline
  接入原语后它将无调用方，可在 question_repo 轮删除。

## 4. daily_progress 权威回写（要求 #4）

`SubmitAnswerResult` 新增 optional 字段：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub daily_progress: Option<DailyProgressSnapshot>,

pub struct DailyProgressSnapshot {
    pub date: String,                       // YYYY-MM-DD，本地时区
    pub exam_id: String,
    pub answered_question_ids: Vec<String>, // 按题去重，前端 hydrate 首答去重集合
    pub completed_count: u32,               // = answered_question_ids.len()
    pub correct_count: u32,                 // 当天该题任一次答对即计（后端权威口径）
}
```

- 数据源**复用 `query_daily_progress`**（与 `get_daily_practice` /
  `DailyPracticeResult.completed_count/correct_count` / 打卡日历完全同口径），
  在事务 commit 之后另取连接重算（`build_daily_progress_snapshot`），计算失败
  降级为 None、只 warn 不阻塞答题。
- 覆盖四条返回路径：submit_answer 主路径、client_request_id 幂等重放路径、
  regrade（含换判与同向幂等）——前端拿到即可回写权威 completed/correct，
  消除 r1-06 §5 指出的"先错后对差 1"乐观计数偏差；`answered_question_ids`
  同时补齐了 §5 点名的缺口。
- serde 兼容：`skip_serializing_if` 使 None 不出现在 JSON；旧前端（TS）忽略
  未知字段；`default` 保证旧 payload 反序列化不炸。未选 `DailyPracticeResult`
  本体是因为其 `question_ids/daily_target/source_distribution` 属推荐生成期语义，
  提交时点并不存在，硬填会造出误导性契约。

## 5. 视图隔离（要求 #5）

前端零改动，`questionBankStore.ts` 的 3fcebbb1 视图隔离
（`practiceSessions` 按 `[examId, viewInstanceId]` 分片）及其回归测试不受影响、
未回退。`daily_progress` 是新增可选字段，旧 hydrate 逻辑照旧工作。

## 6. 单测（要求 #6，只写未跑）

`question_bank_service.rs` tests 模块新增：

- `apply_submission_verdict_counts_and_rowsync`：直接驱动原语——
  NULL→true +1（首判产出 mastery_state）；同向幂等 `changed=false` 且
  correct_count / updated_at / local_version 全部不动；true→false -1 且状态回
  review、`needs_review_plan=true`；false→true +1；连续判错验证 `MAX(0,·)` 防负；
  每次生效写入 local_version 严格 +1（0→1→2→3→4）、updated_at 落值。
- `submit_and_regrade_return_daily_progress_snapshot`：submit 与 regrade 均返回
  快照；改判错→对后 correct_count 权威回写为 1 而 completed_count 不变；
  两题作答按题去重累计。

既有回归 `regrade_submission_flips_latest_without_double_counting` /
`regrade_submission_rejects_stale_submission` 未改动，继续覆盖外壳行为等价性。

## 7. 本轮明确不做（留给对应独占轮）

- pipeline.rs 接入（见 §1 写法）；
- mastery 换判纠正事件（r1-06 §3 的 correct_qbank_answer_with_conn 提案）——
  原语保持现状 `record_qbank_answer_with_conn`（ON CONFLICT DO NOTHING，
  换判不回改首判信号），语义与改造前逐字节一致；
- `insert_submission_with_conn` 的 RowSync INSERT 缺口与 `device_id`；
- `DailyPracticeResult.answered_question_ids`（第 5 轮 qbank-tools 统一口径时
  可直接复用 `DailyProgressSnapshot` 或按 §5 建议扩展）。

## 8. 第 4 轮补丁：mastery 换判纠正接线（覆盖 §7 第 2 条）

原语的 mastery 段按旧 `submission.is_correct` 分路，换判**不再走 DO NOTHING**：

- 首判（`is_correct IS NULL`）：保持 `record_qbank_answer_with_conn`
  （幂等键 `me_qbank_{sid}`，首判恰好一次）；
- 换判（`Some(old) != new`）：改调 pub
  `MasteryService::record_qbank_verdict_correction_with_conn`——tombstone
  链上存活旧信号并追加修订事件 `me_qbank_{sid}_r{n}`，信号跟随最新判定；
- 同向重放：原语入口已幂等短路（`changed=false` 零写入），不写任何纠正事件。

覆盖两条既有调用路（manual regrade 外壳 + pipeline AI 落库段，pipeline 零改动）。
单测 `apply_submission_verdict_counts_and_rowsync` 补断言：首判恰 1 条 base
事件；true→false 后存活信号为 `_r1 wrong`（base 被软删）；false→true 推进到
`_r2 correct`；同向幂等停在 `_r3`、不追加。只写未跑，未 commit。
