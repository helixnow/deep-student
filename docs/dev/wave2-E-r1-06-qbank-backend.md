# Wave2-E R1-06 锚定审阅：qbank 判分后端（静态审阅，未改代码）

- 角色：0824 Wave2-E 第 1 轮「锚定员-qbank后端」
- 范围：`src-tauri/src/question_bank_service.rs`、`src-tauri/src/qbank_grading/*`、
  `src-tauri/src/mastery/*`、`src-tauri/src/chat_v2/tools/qbank_executor.rs`（只读）、
  同步侧 `data_governance/sync/*` 与相关迁移。
- 结论速览：
  1. **已有可复用原语**：`QuestionBankService::regrade_submission_in_tx`
     （question_bank_service.rs L712），即"apply_submission_verdict_in_tx"的雏形，
     但目前只覆盖人工改判 + 待判定去重两路；AI 判分管线（pipeline.rs）是另一份手写副本。
  2. **三路计数分叉**：AI 判分路（pipeline.rs L242-267）只做 `NULL→true +1`，
     **不处理 true→false 的 -1**，与人工改判路的差值口径（L749-753）不一致；
     且 AI 路完全不写 mastery 事件。
  3. **daily 后端返回权威聚合**：`get_daily_practice` 返回 `DailyPracticeResult`
     （含 completed_count/correct_count/is_completed），口径为"按题去重 + 当天任一次答对"。
     缺 `answered_question_ids`（前端自行本地维护）。
  4. **RowSync 缺口**：改判/AI 判分对 `answer_submissions` 的 UPDATE 均未推进
     `updated_at`/`local_version`（INSERT 也留 NULL/0）。
  5. **Step 22 的 3fcebbb1 视图隔离仍在**（questionBankStore.ts `practiceSessions`
     按 `[examId, viewInstanceId]` 分片，测试保留）。

---

## 1. 三路判分调用图（函数名 + 行号）

### A 路：自动判分（客观题 / 带 override 的提交）

```text
前端 useQuestionBankSession → invoke(submit_answer)（commands.rs L6437-6443 同一命令分流）
Agent 工具面 qbank_executor.rs::execute_submit_answer (L2496)
    └─ service.submit_answer(question.id, user_answer, is_correct_override, None) (L2536)

QuestionBankService::submit_answer (question_bank_service.rs L442)
  ├─ 幂等短路：get_submission_by_client_request_with_conn (L470-510)
  ├─ 待判定去重分支：latest.is_correct IS NULL 且同答案 →
  │      regrade_submission_in_tx (L521-531)   ← 与 C 路共用原语
  ├─ check_answer_correctness (L534-544 → L879)
  ├─ VfsQuestionRepo::submit_answer_with_conn (L553; question_repo.rs L1998)
  │      attempt_count+1、correct_count+（仅答对时+1）、状态 CASE (L2012-2038)
  ├─ VfsQuestionRepo::insert_submission_with_conn (L570; question_repo.rs L2453)
  ├─ refresh_stats_with_conn (L581)
  ├─ MasteryService::record_qbank_answer_with_conn (L587-600; mastery/service.rs L121)
  │      事件 id = "me_qbank_{submission_id}"（L136），同事务
  ├─ tx.commit (L602)
  ├─ 答错 → ReviewPlanService::get_or_create_plan (L606-623)
  └─ mastery.sync_learner_profile（事务外回流，L627-635）
```

### B 路：AI 判分（主观题流式评判）

```text
UI 命令 qbank_ai_grade (qbank_grading/mod.rs L23)
Agent 工具面 qbank_executor.rs::execute_ai_grade (L2896) → run_qbank_grading (L2999)
    ——两个入口共用同一管线，工具面仅多了取消令牌桥接（L3001-3011）。

run_qbank_grading (qbank_grading/pipeline.rs L46)
  ├─ 校验 submission 归属 (L69-84)
  ├─ 流式 LLM → parse_verdict_and_score (L161-174 → L516)
  └─ 持久化 SAVEPOINT qbank_grading_persist (L187-294)：
       ① UPDATE questions ai_feedback/ai_score/ai_graded_at/updated_at (L199-218)
       ② UPDATE answer_submissions SET is_correct, grading_method='ai' (L228-239)
       ③ UPDATE questions is_correct/correct_count/status（"旧计数"段 L242-267）
       ④ mark_as_modified_with_conn + update_content_hash_with_conn (L272-281)
     事务外：refresh_stats (L297-301)、判错建复习计划 (L306-317)、emit_complete (L326)
     ★ 全程不写 mastery_events。
```

### C 路：人工改判（"我答对了/我答错了"）

```text
前端 useQuestionBankSession.ts L507 传 regrade_submission_id
    → commands.rs submit_answer 命令内分流 (L6422-6443)
    → QuestionBankService::regrade_submission (question_bank_service.rs L668)
         只允许改判最近一次提交 (L688-697)
    → regrade_submission_in_tx (L712)：
       ├─ 同向幂等短路 (L722-744)
       ├─ correct_delta 差值：None/false→true = +1，true→false = -1 (L749-753)
       ├─ UPDATE answer_submissions SET is_correct, grading_method='manual' (L755-760)
       ├─ UPDATE questions：correct_count=MAX(0, +delta)、状态同口径 CASE (L763-778)
       ├─ mark_as_modified + update_content_hash (L781-790)
       ├─ record_qbank_answer_with_conn（幂等键已存在→DO NOTHING，L794-801）
       ├─ refresh_stats_with_conn + commit (L806-809)
       └─ 改错→复习计划 (L812-821)、sync_learner_profile (L823-829)
    （Agent 工具面无 regrade 工具；executor 中 grep 无 "regrade"。）
```

**是否已有可抽取的 `apply_submission_verdict_in_tx`？** 有雏形：
`regrade_submission_in_tx`（L712）已经把"更新 submission 判定 + 题目差值计数 +
状态 CASE + 同步标记 + mastery 事件 + 刷新统计"收敛在一个事务函数里，且已被
A 路的待判定去重分支和 C 路共用。**唯一没接入的是 B 路（AI 管线）**，它在
pipeline.rs 里维护了一份口径略旧的手写 SQL。

## 2. pipeline 旧计数 vs 主链：重复与方向性问题

pipeline.rs L242-267（③段）与 regrade_submission_in_tx L763-778 是**同一职责的两份实现**：

| 转移 | pipeline.rs（AI 路） | regrade_submission_in_tx（人工路） |
|---|---|---|
| NULL→true | `is_correct IS NULL AND ?1=1` 时 +1（L247-249）✅ | delta=+1（L751）✅ |
| NULL→false | 不加，status='review' ✅ | delta=0 ✅ |
| false→true | **不加**（is_correct=0 非 NULL，条件不满足）❌ | delta=+1 ✅ |
| true→false | **不减** ❌（status 置 review，但 correct_count 残留） | delta=-1、MAX(0,·) 防负 ✅ |
| mastery 事件 | **完全不写** ❌ | 写（幂等键，换判时停旧值，见 §3） |

pipeline 的守卫注释写的是"仅当 is_correct 为 NULL 时递增 correct_count，防止重复计数"
——它防住了"同一 submission 重复跑 AI 评判"的双计，但把"换判"两个方向都判丢了。
另一处隐患：② 段严格绑定 `submission_id + question_id`（L228-231），但 ③ 段读的是
`questions.is_correct` 这个**题目级**旧值做增量判断；若评判期间用户又提交了一次新答案，
③ 会拿新提交的判定当作"本 submission 的前值"，增量方向可能错。抽取原语时应改为
以"被评判 submission 的旧 is_correct"为差值基准（regrade_submission_in_tx 正是这么做的，
它以 `submission.is_correct` 计算 delta）。

另外 pipeline 独有职责（AI 缓存 ①、content hash ④ 之外的 ai_feedback/ai_score）不属于
判分原语，应留在管线内，判分落库段换成调用共享原语。

### 建议的原语签名

```rust
// question_bank_service.rs（或独立 grading_core 模块）
pub(crate) struct VerdictApplyOutcome {
    pub updated_question: Question,
    pub mastery_state: Option<MasteryState>, // 事务外回流 sync_learner_profile
    pub needs_review_plan: bool,             // 事务外接 SM-2
}

/// 三路共用：把"某条 submission 的判定变化"原子落库。
/// - 以 submission 的旧 is_correct 为差值基准（±1 / 0），MAX(0,·) 防负；
/// - grading_method ∈ {"auto","ai","manual"}；
/// - 推进 answer_submissions.updated_at/local_version（修 §5 缺口）；
/// - 首判插 mastery 事件，换判走 tombstone+纠正事件（见 §3）；
/// - 调 mark_as_modified / update_content_hash / refresh_stats_with_conn。
pub(crate) fn apply_submission_verdict_in_tx(
    conn: &rusqlite::Connection,       // 兼容 Transaction / SAVEPOINT 两种调用方
    question: &Question,
    submission: &AnswerSubmission,     // 携带旧 is_correct
    new_is_correct: bool,
    grading_method: &str,
    now_rfc3339: &str,
) -> Result<VerdictApplyOutcome, AppError>;
```

改造顺序：`regrade_submission_in_tx` 内部改为调用它（行为等价）；pipeline.rs 的
②③ 段替换为它（借此修 false→true / true→false 与 mastery 缺失）；A 路首次判分
可保持现状（insert 路径），或让 insert 后也走同一状态 CASE 以消除第三份 CASE 文本
（question_repo.rs L2020-2025）。

## 3. mastery：append-only + ON CONFLICT DO NOTHING 如何停住旧 verdict

- 事件写入：`record_event_with_conn`（mastery/service.rs L295-347）
  `INSERT ... ON CONFLICT(id) DO NOTHING`（L320-336），qbank 事件 id 固定为
  `me_qbank_{submission_id}`（L136）。
- 改判链路：`regrade_submission_in_tx` L794-801 再次调用
  `record_qbank_answer_with_conn`。**首判（NULL→有值）**时键不存在，插入成功；
  **换判（true↔false）**时键已存在 → DO NOTHING → 事件流里留下的仍是**首判 outcome**，
  随后的 `recompute_state_with_conn`（L410-485）按旧事件回放，score/wrong_count/streak
  全部停在首判信号。L709-710 的注释明确承认这一设计（"不回改首判信号"）。
- 连带：B 路 AI 判分根本不写事件，所以"主观题 AI 判错"对掌握度是零信号——
  比"停旧值"更彻底的缺失。

**纠正事件 / tombstone 重算应插在哪：**

代码库已有现成范式：`revert_fsrs_rating_for_log`（mastery/service.rs L227-264）
用 `deleted_at = COALESCE(deleted_at, now)` 软删事件（同时推进 updated_at/local_version，
L252-259），再 `recompute_state_with_conn`；`recompute_state_with_conn` 与防刷统计
（L366）均已过滤 `deleted_at IS NULL`。且 `mastery_events` 在同步分类里是
NoConflict append-only（classification.rs L183-192），tombstone 可安全跨设备传播
（tests L1247-1286 已验证 remote tombstone 重算）。

建议在 MasteryService 新增并由 `apply_submission_verdict_in_tx` 调用：

```rust
/// 换判纠正：软删旧事件 + 插入带修订后缀的新事件 + 重算。
/// 幂等：revision 取当前未删事件数（me_qbank_{sid}_r1, _r2 …），
/// 同一次换判重放时新 id 已存在 → DO NOTHING。
pub fn correct_qbank_answer_with_conn(
    &self, conn: &Connection, submission_id: &str,
    question_id: &str, tags: &[String], new_is_correct: bool,
) -> Result<MasteryState, AppError>;
```

插入点：`regrade_submission_in_tx` L794（把现在的"补记"调用改为
"submission.is_correct 为 None → 原 record；为 Some 且方向变化 → correct"），
以及抽取后的 AI 管线落库段（AI 首判 → record；AI 复判换向 → correct）。
注意换判纠正应绕过 60s 防刷衰减（`compute_event_weight_with_conn` L350-382 会把
纠正后的 correct 权重压到 0.25，纠正事件建议 weight=1 直写）。

## 4. RowSync：改判是否推进 answer_submissions 的 updated_at / local_version

**没有推进，三处写点全缺：**

1. `insert_submission_with_conn`（question_repo.rs L2474-2488）：INSERT 列表里没有
   `updated_at/local_version/device_id` → 落库即 `updated_at=NULL, local_version=0`。
2. 人工改判 UPDATE（question_bank_service.rs L755-760）：只 SET
   `is_correct, grading_method`。
3. AI 判分 UPDATE（pipeline.rs L228-231）与遗留的
   `update_submission_correct`（question_repo.rs L2530-2543）：同样只 SET 两列。

而表结构与同步引擎都假定这些列有效：V20260523 迁移给 answer_submissions 补了
`device_id/local_version/updated_at/deleted_at` 及索引（L103-111）并挂了
__change_log 触发器（L287-307）；分类表将其登记为 RowSync + LWW
（classification.rs L163-172）。

**后果**：__change_log 触发器能让变更进推送队列（不至于完全不同步），但：

- 行级 LWW 取时间戳优先读行内 `updated_at`（sync/mod.rs L7679、L3398-3402 快照路径
  NULL 时回退 snapshot.created_at）——改判后的行时间戳恒 NULL/陈旧，跨设备冲突时
  **改判结果可能被对端旧行按"更新"回写覆盖**；
- `local_version > sync_version` 的本地修改判定（sync/mod.rs L1164）永不为真，
  基线重置/快照对齐路径（L4126-4128 touch local_version）对这些行为空操作。

**修复口径**（应并入 §2 的原语）：三处写点统一追加
`updated_at = ?now, local_version = COALESCE(local_version,0)+1`（INSERT 时直接写
now/1/device_id）。mastery/service.rs L252-259 的 tombstone 语句就是本仓库的标准写法，
照抄即可。

## 5. 后端 daily 聚合口径与权威返回结构

- 口径：`query_daily_progress`（question_bank_service.rs L2663-2716）——
  `answer_submissions` 为主，`DATE(submitted_at,'localtime')` 对齐本地日界线；
  存量无提交记录的题按 `questions.last_attempt_at` 兜底（L2683-2690）；
  `GROUP BY question_id` + `MAX(correct)` = **按题去重、当天任一次答对即计 correct**。
  与打卡日历/热力图同口径（注释 L2660-2662；`get_check_in_calendar` L2834 支持
  `daily_target` 参数化阈值）。✅ 与目标口径一致。
- 权威返回结构：`DailyPracticeResult`（L3268-3287）：
  `date / exam_id / question_ids / daily_target / completed_count / correct_count /
  source_distribution{mistake,new,review} / is_completed`。`get_daily_practice`
  （L2511）每次调用都会重算当日真实进度（L2528-2529）并把已答题排除出推荐
  （L2532-2534），答完可回补重练（L2615-2629）。
- 工具面：`execute_get_daily_practice`（qbank_executor.rs L3531）直接透传该结构
  并打包 practice_handoff；`daily_target` 参数校验 1..=50（L3588-3605）。
- **缺口**：结构缺 `answered_question_ids`。前端 `recordPracticeAnswer`
  （questionBankStore.ts L1918-1960）在会话对象上本地维护
  `answered_question_ids` 做首答去重与乐观 +1，重开/多端时只能靠重新调
  `get_daily_practice` 找齐 completed_count，但"哪些题已答"仍是前端态。
  建议：`DailyPracticeResult` 增加 `answered_question_ids: Vec<String>`
  （`query_daily_progress` 已经算出该列表，L2702-2713，只是没返回），
  前端 hydrate 时以后端列表为准、本地只做乐观增量。
  另一小口径差：后端 correct_count 是"当天答对过的题数（按题）"，前端乐观 +1
  的是"本会话首答即对次数"，同一题当天先错后对时两者会差 1——第 5 轮
  qbank-tools 改造时应统一为后端口径。

## 6. Step 22 的 3fcebbb1 视图隔离仍在否

**仍在。** MERGE-PLAN Step 22 记录 `aa88dcbc → 3fcebbb1`"练习进度按视图隔离"
（docs/0824-MERGE-PLAN.md L1016-1017）。对应实现完整保留于
`src/stores/questionBankStore.ts`：

- `PracticeSessionOwner { examId, viewInstanceId }` + `getPracticeSessionKey`
  用 JSON 元组防键碰撞（L819-846）；
- `practiceSessions` 按 key 分片（L973-977、L1062），
  `ensurePracticeSession`（L1087）/`recordPracticeSessionAnswer`（L1121，校验
  owner.viewInstanceId 不匹配即 fail-closed）/清理（L1166-1171）；
- 回归测试 `tests/vitest/question-bank-practice-progress.test.ts`
  "isolates answers between two kept-alive instances of the same exam"（L39-65）
  与 fail-closed 用例（L67-75）均在。
- 消费点 `ExamContentView.tsx` L970 调 `recordPracticeAnswer`（全局会话对象），
  与按视图分片的 `recordPracticeSessionAnswer` 并存，职责未混淆。

## 7. 禁改区确认

本轮零代码改动、零 commit。工具面契约（qbank_executor 的 submit_answer 返回
`is_correct/needs_manual_grading/submission_id/source`，ai_grade 返回
QbankGradingResponse 序列化）已记录，qbank-tools 改造留待第 5 轮。
