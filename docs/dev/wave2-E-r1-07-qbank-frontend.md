# Wave2-E R1-07 · 题库前端 daily 口径锚定（只读审阅）

- 轮次：0824 Wave2-E 第 1 轮「锚定员-qbank前端」；模型 claude-fable-5-thinking-high。
- 范围：纯静态审阅，未编译/未测试/未改产品代码/未 commit。
- 证据基线：`src/stores/questionBankStore.ts`、`src/hooks/useQuestionBankSession.ts`、`src/features/learning-hub/apps/views/ExamContentView.tsx`、`src/components/practice/DailyPracticeMode.tsx`、`src/components/QuestionBankEditor.tsx`、`src/locales/{zh-CN,en-US}/practice.json`；后端对照 `src-tauri/src/question_bank_service.rs`（只读，不在本组改动面）。

---

## 一、daily 口径对比表（前端会话增量 vs 后端权威重算）

前端唯一写入方是 `questionBankStore.recordPracticeAnswer`（store L1918-1960），由 `ExamContentView.handleSubmitAnswer`（L970）在每次提交后调用。后端权威口径是 `query_daily_progress`（service L2663-2716，`get_daily_practice` L2528 消费）与打卡日历 `get_check_in_calendar`（L2870-2896）同一 SQL 形态。

| 维度 | 前端 `recordPracticeAnswer`（daily 分支 L1940-1959） | 后端 `query_daily_progress` / 日历 | 分叉? |
|---|---|---|---|
| 计数时机 | **首答锁定**：`answered_question_ids` 含该题即整体跳过（L1947），首答后 completed/correct 均不可再变 | 全天动态：`GROUP BY question_id` + `MAX(correct)`，当日**任一次**答对即计对 | **是** |
| 去重粒度 | 按题去重（会话内） | 按题去重（当日全量） | 否（一致） |
| 首答错 → 当日重答对 | correct 不回补（首答已锁） | 该题计入 correct（MAX 取 1） | **是** |
| 主观题首答 `is_correct=null` | completed+1、correct+0，随即锁死 | 待改判；改判走 `regrade_submission_id` 原地改写提交行 → correct 跟着变 | **是** |
| 改判（答对→答错） | correct 不减（无任何下调路径） | 唯一提交被改写为错 → 不计 correct | **是** |
| 计数范围 | 仅本轮推荐集 `daily.question_ids` 内的题（L1944 白名单门禁） | 该 exam 当日**所有**作答题（顺序刷题也计入） | **是** |
| 日界线 | 无概念（会话对象跨零点不重置） | `DATE(submitted_at,'localtime')` 本地日界线 | **是**（跨零点续练时前端继续累加昨日会话） |
| 存量兜底 | 无 | 无提交记录的题按 `last_attempt_at` 兜底（UNION ALL 分支） | —（前端不需要） |

**收敛点**：任何一次 `getDailyPractice(examId, count)`（store L2052-2070）都会让后端用 `query_daily_progress` 全量重算 `completed_count`/`correct_count`/`is_completed` 并整体覆盖 store 的 `dailyPractice`，前端增量误差在此被清洗。`answered_question_ids` 是前端补充字段（store L487-492 注释明示"不回传后端，仅会话内幂等"）。

## 二、「再练一组」是否回补重计 —— 是

`DailyPracticeMode` 的按钮三态（continue/start/anotherRound，L433-437）走同一个 `handleStart` → `getDailyPractice`（L155-163）。后端入口即 `query_daily_progress`（service L2528-2529），因此：

- 「再练一组」/重开面板/切回启动页都会**回补**改判、重答产生的正确数（第 1 节所有分叉在此对齐后端口径）；
- 选题同时排除今日已答题（L2534），不足时才允许重练已答题补齐（L2615-2629）；
- 代价：分叉窗口 = 「本轮会话进行中、尚未回启动页」期间，做题页顶部的 daily 进度可能低于真实值（改判对不涨）。

## 三、handleMarkCorrect 缺口 —— 缺 `recordPracticeAnswer`，确认

```1001:1005:src/features/learning-hub/apps/views/ExamContentView.tsx
  // 🆕 使用 Hook 的 markCorrect
  const handleMarkCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    if (!sessionId) return;
    await markCorrect(questionId, isCorrect);
  }, [sessionId, markCorrect]);
```

- 链路：`QuestionBankEditor.handleManualGrade`（"我答对了/我答错了"，L1238-1252）→ `onMarkCorrect` = 上面这段 → hook `markCorrect`（useQuestionBankSession L545-549）→ 直接调 hook 的裸 `submitAnswer`，**绕开** `handleSubmitAnswer` 里 L970 的 `recordPracticeAnswer` 调用。同理它也绕开 L975-996 的 mock_exam results 回写和 `QuestionBankEditor` 的 `recordPracticeSessionAnswer`（L1142，只在正常提交路径调用）。
- 后果：主观题「首答 null → 改判对」时，daily/timed 会话的 `correct_count` 永远不补；mock_exam 的 `results` 也拿不到改判结果。
- **重要前提**：单补一行调用是无效修复——`recordPracticeAnswer` 的首答锁（daily L1947 / timed L1928）会把改判当重复作答直接吞掉。真正的修复要给该 action 增加"改判修正"语义（见第六节插入点 1）。
- 双计风险已被后端挡住：hook L496-508 的 `regrade_submission_id` 让改判改写原提交行而非新插记录，后端口径天然正确；缺口纯在前端会话增量侧。

## 四、streak / totalCorrect 语义与完成卡文案

现状有**三套**正确数，语义各不相同：

| 字段 | 位置 | 语义 | 消费方 |
|---|---|---|---|
| `PracticeSessionProgress.streakCount` | store L829-830、L1138-1140 | **连续答对的尝试数**（明确答错清零，null 不中断） | 侧栏"连对"卡（QuestionBankEditor L1741-1748）、里程碑通知（L1156） |
| `PracticeSessionProgress.totalCorrectCount` | store L831、L1141 | **正确尝试数**（每次调用都累加，重做同题答对计 2 次；`answeredIds` 才按题去重） | 完成庆祝卡 `correctRate = totalCorrectCount / answeredIds.length`（L1889-1891）——分子尝试维度、分母题目维度，**重做后正确率可超 100%** |
| `DailyPracticeResult.correct_count` | 后端权威 | **当日答对题数**（按题去重 + 任一次答对） | daily 完成卡 `daily.completedDetail`："答对 {{correct}} / {{total}} 题" |
| （题库全局）`total_correct` | store L143 | 历史累计正确尝试数 | 统计口径，不与上面混用 |

**定名建议**（第 4 轮落地，本轮只定名）：

1. `streakCount` 保留尝试维度，中文统一定名「**连对**」；`editor.currentStreak` 现文案已对，不动。
2. `totalCorrectCount` 二选一：改语义为**答对题数**（仅 `questionId` 首次进入 `answeredIds` 时按判定计数，或维护 per-question 最新判定 map 取真值个数），字段改名 `correctQuestionCount`——完成卡分子分母同维度，超 100% 不再可能；若保留尝试语义则必须改名 `correctAttemptCount` 且完成卡分母改用尝试总数。推荐前者（与后端 daily 口径、与 `completedDetail` 文案"答对 X / Y **题**"天然对齐）。
3. daily 完成卡文案 `daily.completedDetail`（zh L173"答对 {{correct}} / {{total}} 题"）语义写的是题数，与后端口径一致，**保留不改**；要改的是前端增量让它在改判后能到达该值（第六节插入点 1）。
4. `daily.streakDays`/`daily.streak`「连续打卡」是天数维度，与「连对」尝试维度勿混——第 4 轮改文案时禁止把两者都写成"连续"不带量词。

## 五、daily_target：localStorage 单值 → 整月按当前目标重算，确认

- 存储：`qbank:dailyTarget:{examId}` 单值（DailyPracticeMode L64-90），无日期维度。
- 传播：`loadCalendar`（L134-144）把**当前** `dailyTarget` 传给 `getCheckInCalendar`（store L2092-2118 → 后端 `daily_target` 参数），后端对整月每一天统一用 `question_count >= target` 判定 `target_achieved`（service L2847、L2925）。
- 后果：目标从 10 调到 20，历史上做了 12 题的达标日立即变不达标（绿格变黄格）；连续打卡天数 `streak_days` 不受影响（`query_streak_days` 只看"有作答"，与 target 无关，service L2929-2953）。
- 依赖同一单值的还有：agent 交接校验（R1-06 已记录 1-20 vs UI 5-50 的口径分裂，B6，本轮不展开）。

### P2-1 两案改动面

**A 案：历史按 exam_id+date 持久化 target**

| 层 | 文件 | 字段/改动 |
|---|---|---|
| 后端存储 | `src-tauri/src/question_bank_service.rs`（或新 repo） | 新表 `daily_targets(exam_id, date, target)`（或挂在既有 check-in 结构）；`get_daily_practice` 开始时 upsert 当日 target；`get_check_in_calendar` 改为逐日读历史 target，缺失日回退请求参数再回退 10 |
| 后端契约 | `commands.rs` 请求/`DailyCheckIn` 响应 | `DailyCheckIn` 增 `daily_target` 字段（前端 tooltip 可显示"当日目标"）；日历请求的 `daily_target` 降级为"缺失日回退值" |
| 前端类型 | `src/stores/questionBankStore.ts` | `DailyCheckIn` 增 `daily_target?: number`；`getCheckInCalendar` 注释更新 |
| 前端组件 | `src/components/practice/DailyPracticeMode.tsx` | 日历格子 title/达标判定不再隐含"当前目标"；localStorage 仍保留（作为"今天"的默认目标） |
| 迁移/同步 | schema migration + 云同步记录级注册面（若 check-in 数据入同步范围） | 历史日期无 target → 回退策略需定档 |

侵入面：后端 schema + 2 个查询 + 前后端契约 + 迁移，跨 E/后端组文件面，**不是纯前端可闭环的活**。

**B 案：改名「按当前目标查看」**

| 层 | 文件 | 字段/改动 |
|---|---|---|
| i18n | `src/locales/zh-CN/practice.json`、`en-US/practice.json` | `daily.calendar` 改为"打卡日历（按当前目标查看）"或新增 `daily.calendarCurrentTargetHint` 副标题键 |
| 组件 | `src/components/practice/DailyPracticeMode.tsx` | CardHeader 标题/副标题引用新键（L448 一处） |

侵入面：2-3 个文件、零后端、零数据迁移，语义诚实化（"达标格 = 按你现在设的目标回看"）。

**建议：本轮选 B 案先行**。理由：A 案的存储位与 R1-06 优化建议 1/2（后端按 `(date, exam_id)` 持久化 completed/correct + target 随 check-in 存储）是同一张表的事，应等后端组统一落 daily 持久化时一并做，前端单独抢跑会造成契约两改；B 案零风险即刻消除误导。B 案落地后 A 案仍可作为后续增强，两案不互斥。

## 六、提交/改判后能否回写后端权威 daily —— 现在没有这类字段

`qbank_submit_answer` 的响应 `SubmitAnswerResult`（hook L69-77）只有 `is_correct / correct_answer / needs_manual_grading / message / submission_id / updated_question / updated_stats`；`updated_stats` 是全库维度（total/mastered/review/in_progress/new/correct_rate），**不含任何当日 daily 进度字段**。前端要拿权威 daily 只能重调 `qbank_get_daily_practice`，但该命令带随机重选题副作用（会换掉 `question_ids`），不适合当纯进度查询用。结论：前端当前**无法**在提交/改判后原子回写权威 daily，只能依赖第二节的"下次回启动页收敛"。

## 七、第 4 轮插入点（修复轮索引，本轮不动代码）

1. **改判回写 daily/timed**（修第三节缺口，两处联动）：
   - `src/stores/questionBankStore.ts` `recordPracticeAnswer`：`answered_question_ids: string[]` 升级为记录每题最近判定（如 `answered_results?: Record<string, boolean | null>`，保留旧数组做兼容读），已答题再次调用时允许 correct_count 按 `旧判定→新判定` 差量修正（null→true 加 1、true→false 减 1），completed 不重复计；
   - `src/features/learning-hub/apps/views/ExamContentView.tsx` `handleMarkCorrect`（L1002-1005）：`markCorrect` 成功后补 `recordPracticeAnswer(sessionId, questionId, isCorrect)`，并同步 mock_exam `results`（可与 L975-996 抽成共用回写函数）。只动这个回调函数体，壳层布局（B 组地盘）不碰。
   - 顺带：`QuestionBankEditor.handleManualGrade` 之后 `recordPracticeSessionAnswer` 的改判语义（totalCorrect 回补/回收）与第四节定名一起做，避免两次动同一函数。
2. **streak/totalCorrect 定名与去膨胀**（第四节方案 2）：`questionBankStore.ts` `PracticeSessionProgress` 字段改名 + `recordPracticeSessionAnswer` 计数规则、`QuestionBankEditor.tsx` 完成卡 L1167-1171/L1889-1891 消费点、`practice.json` 若有文案随动。
3. **提交响应回带权威 daily**（修第六节，需后端组配合）：后端 `SubmitAnswerResult` 增可选 `daily_progress { date, completed_count, correct_count }`（或新增轻量只读命令 `qbank_query_daily_progress` 暴露 service 已有的同名私有函数）；前端 `useQuestionBankSession` 接口 + `ExamContentView` 提交/改判回调改为用权威值 `setDailyPractice` 覆盖而非本地增量。此项落地后插入点 1 的差量修正可降级为兜底。
4. **P2-1 B 案**：`practice.json`（zh/en）+ `DailyPracticeMode.tsx` L448 标题一处；A 案挂后端 daily 持久化统一包，不单独排。
5. **日界线兜底**（低优先）：`recordPracticeAnswer` daily 分支比对 `daily.date !== 今日` 时跳过增量（或触发重取），避免跨零点把昨日会话继续累加。
