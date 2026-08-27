# Wave2-E R4-04：daily 权威回写 + 改判差量修正（store）

- 轮次：0824 Wave2-E 第 4 轮「daily 权威回写」；模型 claude-fable-5-thinking-high。
- 独占文件：`src/stores/questionBankStore.ts`（唯一改动的产品代码文件）。
- 约束：未跑编译 / 测试 / CI，未 commit；未动 `ExamContentView` / `DailyPracticeMode` / `question_bank_service` / pipeline。
- 依据：R1-07 §三（首答锁吞改判）、§六（提交响应无权威 daily）、§七插入点 1/3（修复轮索引）、§四（定名）。

## 一、`recordPracticeAnswer`：首答锁之外增加「已答题差量修正」

修 R1-07 §三的核心缺口：此前 `answered_question_ids` 含该题即整体跳过（daily 原 L1947 / timed 原 L1928），改判被当成重复作答吞掉，correct 永不回补也永不回收。

新计数规则（timed / daily 两个分支对称落地）：

| 场景 | completed / answered | correct |
|---|---|---|
| 首答（不在 `answered_question_ids`） | +1（幂等，不变） | 判 true 时 +1（不变） |
| 已答题再次上报（改判 / 重答），判定有变化 | **不动** | 按 `旧判定 → 新判定` 差量修正：`(新===true?1:0) - (旧===true?1:0)`，即 null→true +1、true→false **-1**、false→null 0；下限 clamp 0 |
| 已答题再次上报，判定未变 | 不动 | 不动（跳过 set，避免无意义 rerender） |
| 已答但无判定基线（旧版会话残留） | 不动 | 不动（保持首答锁 fail-closed，方向不可知不猜，等后端 `get_daily_practice` 全量重算收敛） |

差量基线是新增的会话内字段 `answered_results?: Record<string, boolean | null>`（`TimedPracticeSession` / `DailyPracticeResult` 各加一个，optional 加法，不回传后端），与 `answered_question_ids` 同一次 set 原子写入。旧数组保留做兼容读，正是 R1-07 插入点 1 的方案。

口径说明：

- null（主观题待判定）在差量里计 0，与后端 `MAX(correct)` 对 pending 提交的处理一致；
- daily 分支改判时 `completed_count` / `is_completed` 不动——题数没变，改的只是判定；
- timed 分支仍受 `!is_submitted && !is_timeout` 门禁，交卷/超时后改判不再改动已结算的 timed 计数；
- 后端双计风险不存在：改判走 `regrade_submission_id` 原地改写提交行（R1-07 §三），本修正只对齐前端乐观值。

与 R4-05 的配合：`ExamContentView.handleMarkCorrect` 已在本轮由 05 号补上 `recordPracticeAnswer` 调用，其文档「已知边界：首答 null/错、改判为对时 correct_count 不回补」由本文件的差量分支闭环——**首答锁不再吞改判**。

## 二、daily 权威回写（submit/regrade 响应带进度时覆盖乐观值）

修 R1-07 §六 / 插入点 3 的前端侧，全部为 optional 加法。后端侧本轮已由并行的 R4-03（mastery/backend）在 `question_bank_service.rs` 落地同名结构 `DailyProgressSnapshot`，字段已逐一对齐：

1. **类型**：新增导出 `DailyProgressSnapshot { date; exam_id?; answered_question_ids?; completed_count; correct_count; is_completed? }`，对应 Rust 结构（`date` / `exam_id` / `answered_question_ids` / `completed_count` / `correct_count`；`is_completed` 后端暂不发送，前端 optional 兜底推导）。`SubmitAnswerResult` 增加两个可选字段：
   - `daily_progress?: DailyProgressSnapshot`（**权威字段名**，serde snake_case，后端 `#[serde(default, skip_serializing_if = "Option::is_none")]`，双向兼容旧版本）；
   - `dailyProgress?: DailyProgressSnapshot`（camelCase 兼容读，防未来载荷形态变化）。
2. **action**：新增 `applyAuthoritativeDailyProgress(examId, progress): boolean`——权威优先，覆盖本地乐观 daily 的 `completed_count` / `correct_count` / `is_completed`（缺省时按 `completed >= daily_target` 推导），快照带 `answered_question_ids` 时同步覆盖本地首答去重集合（后端注释明示"前端 hydrate 首答去重集合时以此为准"）。守卫：
   - `dailyPractice` 存在且 `exam_id` 匹配（参数与快照内 `exam_id` 双重校验），否则 false；
   - `progress.date` 与本地 `daily.date` 不一致（跨零点旧会话）时跳过——覆盖会产生「昨日题单 + 今日计数」杂交对象，等下次 `getDailyPractice` 整体换发（对齐 R1-07 §一日界线行 + 插入点 5 精神）；
   - 计数经 `practiceInteger` 校验（非负安全整数），坏值 fail-closed；
   - 不动 `question_ids` / `answered_results` / `source_distribution` 等其余会话内字段（`answered_results` 差量基线保留：被后端集合新覆盖进来、但无本地基线的题在 `recordPracticeAnswer` 里走 fail-closed 分支，不会算错方向）。
3. **消费点**：store 自身的 `submitAnswer` 在 `recordPracticeAnswer` 之后读取 `result.daily_progress ?? result.dailyProgress`，存在即调用上述 action 覆盖（timed 部分不受影响）。真实答题路径（`useQuestionBankSession`，非本轮独占面）将来透出该字段时，直接调用同一 action 即可——R4-05 已在 `handleMarkCorrect` 留了接入注释。

## 三、定名注释（只加注释，不改任何字段名 / API / 运行时语义）

R1-07 §四的三套正确数 + 两种 streak，全部在类型定义处写清维度：

| 字段 | 定名后的注释语义 |
|---|---|
| `PracticeSessionProgress.streakCount` | 「连对」——连续答对的**尝试**数：答错清零、null 不中断、重做同题答对也续连；与 `streak_days` 区分 |
| `PracticeSessionProgress.totalCorrectCount` | 正确**尝试**数：每次判对的提交都 +1，重做同题答对计多次；注明与 `answeredIds` 维度不同、除出的正确率可超 100%，改名 `correctQuestionCount` 方案挂 R1-07 §四（改语义动 `recordPracticeSessionAnswer` + `QuestionBankEditor` 消费点，超出本轮独占面，不 silently 改） |
| `DailyPracticeResult.correct_count` | 当日答对**题**数（题目维度：按题去重 + 任一次答对即计；后端权威） |
| `DailyPracticeResult.completed_count` | 当日已作答**题**数（按题去重） |
| `QuestionBankStats.total_correct` | 历史累计正确**尝试**数（不按题去重），全库统计口径 |
| `CheckInCalendar.streak_days` | 连续打卡**天**数（天数维度），与「连对」尝试维度显式互斥标注 |

`recordPracticeAnswer` 的接口 JSDoc 同步改写为四条计数规则（首答 / 差量修正 / 无基线 fail-closed / 非会话题忽略），不再是「只计首答」。

## 四、3fcebbb1 视图隔离：未回退

`practiceSessions` 分片、`getPracticeSessionKey`（examId + viewInstanceId JSON 元组键）、`ensurePracticeSession` / `recordPracticeSessionAnswer` / `resetPracticeSession` / `releasePracticeSession` 的 fail-closed 门禁全部未触碰；本轮改的 `recordPracticeAnswer` 是另一组全局会话对象（timedSession / dailyPractice），与视图分片正交。

## 五、未动的部分

- `ExamContentView.tsx`（R4-05 独占）、`DailyPracticeMode.tsx`、`useQuestionBankSession.ts`、`question_bank_service.rs`、pipeline；
- `recordPracticeSessionAnswer` 的 totalCorrect 计数规则（改名/改语义与消费点联动，见上表挂账）；
- `hydratePracticeHandoff` / `validateQbankPracticeHandoff`：验证器本就重建零进度会话，新 optional 字段不进交接面，无需改。

## 六、验证建议（后续轮次，本轮禁跑）

- 主观题首答（null）→ 自评「我答对了」：daily `correct_count` +1、`completed_count` 不重复计；再改「我答错了」：`correct_count` -1 回到原值；
- 客观题答对后改判为错：timed / daily correct 各 -1，不为负；
- 判定不变的重复上报（同题同判定）：store 无任何 set；
- 模拟 `SubmitAnswerResult.daily_progress = { date: 今日, completed_count, correct_count }`：本地 daily 被整体覆盖；date 传昨日：跳过覆盖返回 false；
- `question-bank-practice-progress.test.ts` 现有用例（首答幂等、视图隔离）应全部保持通过，需为差量分支补新用例。
