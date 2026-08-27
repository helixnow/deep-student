# Wave2-E R6-08：daily 判分链路第 6 轮复核

- 轮次：0824 Wave2-E 第 6 轮
- 独占文件：`src/stores/questionBankStore.ts`、`src/hooks/useQuestionBankSession.ts`、
  `src/features/learning-hub/apps/views/ExamContentView.tsx`（仅判分调用点）、
  `src/components/practice/DailyPracticeMode.tsx`
- 约束：未跑编译 / 测试 / CI，未 commit；未动壳层布局

## 复核结论（四项）

### 1. recordPracticeAnswer 差量 —— 通过，无需改动

`questionBankStore.recordPracticeAnswer`（R4 版）三分支齐全：

- 首答：`answered_question_ids` 幂等去重，completed/answered +1，
  correct 按判定 +0/+1，同步写入 `answered_results` 判定基线；
- 已答且有基线：correct 按 旧判定 → 新判定 差量修正
  （`correctDelta`，null 与 false 同权重计 0，可减且下限 0），
  completed / is_completed 不动；timed 分支同构；
- 已答但无基线：fail-closed 保持首答锁（方向不可知，见第 3 项收敛路径）。

已知口径差（记录，不改）：本地差量是「最近判定」口径，后端 daily 是
「当日任一次答对即计」口径。对改判（in-place regrade）两者一致；对
「答对后重答答错」本地会 -1 而后端不减。该偏差由第 3 项的权威快照
在下一次提交响应时覆盖修正，无需在本地模拟后端口径。

### 2. markCorrect 回写 —— 通过，本轮增强返回值

- hook `markCorrect` 走 `submitAnswer(questionId, userAnswer, isCorrect)`，
  携带 `regrade_submission_id`（本会话最近提交 id），后端对该提交改判而非
  新插记录，attempt_count 不双计（R4 既有，未动）；
- `ExamContentView.handleMarkCorrect` 的 `recordPracticeAnswer` 回写与
  mock_exam `results` 对称回写（R4-05 既有）核查无误，未动；
- 本轮变更：`markCorrect` 返回类型从 `Promise<void>` 改为
  `Promise<SessionSubmitResult>`，把改判响应（含权威 daily 快照）透传给
  调用点。既有调用方仅 await，签名放宽向后兼容。

### 3. 权威 daily_progress —— 缺口，本轮补齐（本轮主修）

R4-05 留档的遗留项：Rust `SubmitAnswerResult.daily_progress`（提交/改判
响应回带的当日权威快照，`qbank_verdict_three_paths.rs` 已验证与
`get_daily_practice` 同口径）只在 store 的 `submitAnswer` action 里被
`applyAuthoritativeDailyProgress` 消费，而该 action 无真实调用方——
真实答题路径（hook → ExamContentView）把该字段整个丢掉了。

本轮接线（沿 R4-05 预留的「hook 透出字段 → 调用点接入」方案）：

1. **hook**（`useQuestionBankSession.ts`）：
   - 内部 `SubmitAnswerResult` 增补 `daily_progress?: DailyProgressSnapshot | null`
     （serde snake_case，旧后端载荷无此键时 undefined，行为不变）；
   - 新导出类型 `SessionSubmitResult = SubmitResult & { dailyProgress?: DailyProgressSnapshot }`；
   - `submitAnswer` / `markCorrect` 均返回该类型并透传快照。hook 本身不
     apply——顺序必须由调用点保证（见下）。
2. **ExamContentView 判分调用点**（`handleSubmitAnswer` / `handleMarkCorrect`）：
   在 `recordPracticeAnswer` 之后追加
   `applyAuthoritativeDailyProgress(sessionId, result.dailyProgress)`。
   顺序不可颠倒：先乐观（维护 `answered_results` 差量基线）、后权威覆盖
   计数；若权威先行，随后的乐观差量会在权威值上二次叠加。
   store 的 `applyAuthoritativeDailyProgress` 自带门禁（exam 匹配、跨零点
   日期不一致不覆盖、计数非法不覆盖），调用点不重复校验。
3. **store**：实现未动，仅更新 `recordPracticeAnswer` 接口注释——
   fail-closed 分支的收敛路径从「等下次 get_daily_practice」扩展为
   「submit/regrade 权威快照即时收敛，或下次 get_daily_practice 兜底」。

消费面核查：hook 的 `submitAnswer` 全仓仅 ExamContentView 一个调用方，
无双 apply 风险；store 的 `submitAnswer` action（自带 apply）仍无真实
调用方，保持现状。

### 4. P2-1 文案 —— 通过，无需改动

B 案文案四键在 `DailyPracticeMode` 与 zh-CN / en-US `practice.json` 均在位、
语义一致：

- `daily.targetHint`（目标不按天存历史，达标判定用当前值）；
- `daily.viewByCurrentTarget`（日历 Badge「按当前目标查看」）；
- `daily.calendarTargetHint`（带 `{{target}}` 插值，达标标记统一按当前目标判定）；
- `daily.streakHint`（streak 只看当日有无做题，与达标无关）。

`getCheckInCalendar` 请求侧 `daily_target` 跟随用户目标下传，与文案承诺一致。
`DailyPracticeMode.tsx` 本轮零改动。

## 回复：改判是否仍被首答锁吞？

**不再被吞。** 分两层：

- 本会话内的改判（占绝大多数）：R4 起 `recordPracticeAnswer` 对已答题按
  `answered_results` 基线做差量修正（true→false 可减、null→true 可补），
  首答锁只拦「completed 重复计数」，不再吞判定变化——本轮复核该逻辑
  正确，未改。
- 唯一残留的 fail-closed 窄缝（已答但无判定基线：旧版会话残留，或权威
  快照覆盖 `answered_question_ids` 时引入的会话外题目）：本地仍不动计数
  （方向不可知，故意锁死），但本轮接通权威 `daily_progress` 后，改判
  响应当场就用后端全量重算值覆盖本地计数，该窄缝从「等下次
  get_daily_practice 才收敛」变为「提交响应即收敛」。仅当后端为不回带
  该字段的旧版本时，这条窄缝才退回原状（加法字段，兼容既定）。

## 验证建议（后续轮次）

- 每日一练答一题（判错）→「我答对了」：面板 correct +1，completed 不变；
  再「我答错了」反悔：correct 回落，均与后端 `get_daily_practice` 一致；
- 关闭重开（answered_question_ids 由权威快照灌入、无本地基线）后直接
  改判某题：本地乐观层无动作，但提交响应的权威快照应立即修正计数；
- 跨零点旧会话上改判：权威快照因日期不一致被拒，等换发（既有门禁）。
