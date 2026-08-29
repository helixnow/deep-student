# Wave2-E R4-09 · 判分事务与计数一致性审阅（审阅员-事务）

- 轮次：0824 Wave2-E 第 4 轮「审阅员-事务」；模型 claude-fable-5-thinking-high。
- 纪律：零产品代码改动、零测试运行、零 commit，纯静态审阅。
- 基线：工作区干净（HEAD = d43ea37f）。`git log a07fbad8..HEAD` 对
  `question_bank_service.rs`、`qbank_grading/*`、`mastery/*`、`questionBankStore.ts`、
  `ExamContentView.tsx` 均为空——**当前代码与 r1-06/r1-07 审阅基线逐字节一致，
  第 1 轮列出的全部缺口均未修复**。本文以最新工作区行号复核并补充新发现。
- 范围：`src-tauri/src/question_bank_service.rs`（submit_answer / regrade_submission_in_tx /
  get_daily_practice / query_daily_progress / submit_mock_exam）、
  `src-tauri/src/qbank_grading/pipeline.rs`、`src-tauri/src/mastery/service.rs`、
  `src-tauri/src/vfs/repos/question_repo.rs`（提交写点）、
  前端 `recordPracticeAnswer`（questionBankStore.ts）与 `handleMarkCorrect`
  （ExamContentView.tsx）及其上下游。

## 结论速览

- **阻断 5 条 / 非阻断 7 条**（清单见 §5）。
- **计数三路一致性：部分一致。** A 路（自动判分）与 C 路（人工改判）差值口径一致；
  B 路（AI 判分）单向计数 + 差值基准取错 + 零 mastery 事件，三处全部分叉。
- **daily 回写闭环：后端闭环、前端会话内不闭环。** 三路判分都落到
  `answer_submissions.is_correct`，`query_daily_progress` 按行重算即收敛；
  但前端 `handleMarkCorrect` 不走任何会话回写，且 `recordPracticeAnswer`
  的首答锁会吞掉补调用；mock_exam 成绩单由前端 `results` 计算，改判缺口在
  该路是**永久性算错**而非窗口期显示滞后。

---

## 1. 事务边界逐路核对

### A 路：`submit_answer`（question_bank_service.rs L442-659）

单事务闭合，边界正确：

| 步骤 | 行号 | 事务内? |
|---|---|---|
| 幂等短路（client_request_id） | L470-510 | ✅（读 + commit 返回） |
| 待判定去重 → 转 C 路原语 | L521-531 | ✅（同一 tx 移交） |
| `submit_answer_with_conn`（attempt+1 / correct+increment / 状态 CASE / mark_as_modified） | L553-560；repo L2012-2053 | ✅ |
| `insert_submission_with_conn` | L570-578；repo L2474-2488 | ✅ |
| `refresh_stats_with_conn` | L581 | ✅ |
| `record_qbank_answer_with_conn`（事件 + 聚合重算） | L587-600 | ✅ |
| commit | L602 | — |
| SM-2 复习计划（答错） | L606-623 | 事务外，失败 warn 不阻塞 ✅ |
| learner profile 回流 | L627-635 | 事务外，可重试 CAS ✅ |

作答事实、计数、mastery 事件同事务原子；事务外只有可重放的派生动作。**无阻断问题。**

### B 路：AI 判分 `run_qbank_grading`（pipeline.rs L46-340）

SAVEPOINT `qbank_grading_persist`（L187-294）包住 ①AI 缓存（L199-218）、
②submission 判定（L228-239）、③question 计数/状态（L242-267）、
④mark_as_modified + content hash（L272-281）；任一失败 `ROLLBACK TO` + `RELEASE`
（L289-290）。事务外：refresh_stats（L297-301，失败仅 warn，与 A/C 对称）、
判错建复习计划（L306-317）。**边界本身成立**，但事务内的写入语义有三处阻断
（见 §2 / §5 B1-B3），且 ② 不推进同步列（§3）。

补充一点边界内的取消语义：S-014 二次取消检查在持久化**之前**（L154-158），
持久化开始后不再响应取消——SAVEPOINT 短事务，可接受。

### C 路：人工改判 `regrade_submission(_in_tx)`（L668-849）

- 只允许改判最近一次提交（L688-697），防旧提交改判污染"最近作答结果"口径 ✅；
- 同向改判幂等短路，零写入（L722-744）✅；
- 差值基准取**被改判 submission 的旧 is_correct**（L749-753：None/false→true=+1，
  true→false=−1，`MAX(0, correct_count + delta)` 防负，L767）✅；
- UPDATE submissions（L755-760）→ UPDATE questions 含状态 CASE（L763-778）→
  mark_as_modified/content hash（L781-790）→ mastery 补记（L794-801）→
  refresh_stats（L806-807）→ commit（L809），全部同事务 ✅；
- 事务外复习计划（L812-821）、profile 回流（L823-829），与 A 路对称 ✅。

命令分流（commands.rs L6435-6444）：`regrade_submission_id + is_correct_override`
同时存在才走 C 路，否则落 A 路——A 路内部再做待判定去重兜底（L521-531），
两层兜底不冲突。**C 路唯一缺口是 submission 行不推进同步列（§3）。**

## 2. 计数一致性：三路对照（复核 r1-06 §2，全部属实）

`questions.correct_count` 的三份写实现：

| 判定转移 | A 路 repo L2018/L2007 | B 路 pipeline L247-250 | C 路 L749-753 |
|---|---|---|---|
| 首判 NULL→true | +1 ✅ | +1 ✅ | +1 ✅ |
| 首判 NULL→false | 0 ✅ | 0 ✅ | 0 ✅ |
| 换判 false→true | （不适用，A 路只插新行） | **0 ❌** | +1 ✅ |
| 换判 true→false | （不适用） | **0 ❌**（status 置 review 但计数残留） | −1、防负 ✅ |
| mastery 事件 | 写（客观题）✅ | **不写 ❌** | 写（幂等键 DO NOTHING，见 N1） |
| 差值基准 | 新插入行 | **题目级 `questions.is_correct` 旧值 ❌** | submission 旧 `is_correct` ✅ |

B 路两处 `❌` 的实际场景：主观题先由 AI 判对（+1），用户走 C 路改成错（−1，正确），
之后**重跑 AI 评判**又判对——pipeline 里 `is_correct=0 非 NULL`，+1 不发生，
计数偏低；反向：AI 复判从对改错，correct_count 不减，计数偏高且 status 与计数矛盾
（status='review' 但 correct_count 仍含这次"对"）。漂移不自愈（refresh_stats
只汇总 questions 行，不校正行内计数）。

差值基准问题（B2）还带竞态：② 严格绑定 `submission_id + question_id`
（L230-231），③ 却无条件用本次 verdict 覆盖 `questions.is_correct` 并以题目级
旧值算增量（L245-259）。评判进行中用户对同题再提交（A 路已 commit 新行、
更新了 `questions.is_correct/user_answer`），AI 持久化落地时会把**旧 submission
的判定**回写成题目"最近作答结果"，增量方向也以新提交的判定为前值——两个字段
双错。C 路以 submission 旧值为基准，天然免疫。

**三路一致性判定：部分。** A/C 一致；B 全分叉。r1-06 §2 提出的
`apply_submission_verdict_in_tx` 抽取（以 `regrade_submission_in_tx` 为雏形、
兼容 `Transaction`/SAVEPOINT 两种调用方）仍是正确修法，第 4 轮未落地。

## 3. RowSync 核对（复核 r1-06 §4，全部属实，现工作区行号）

表结构与引擎假定：V20260523 迁移给 `answer_submissions` 补
`device_id/local_version/updated_at/deleted_at` + 索引（迁移 SQL L100-111）并挂
__change_log 触发器（L287 起）；classification.rs L163-172 登记为
RowSync + **LWW**（幂等键 `question_id,client_request_id`）。

三处写点全部不推进同步列：

1. `insert_submission_with_conn`（question_repo.rs L2474-2488）：INSERT 列表无
   `updated_at/local_version/device_id` → 新行 `updated_at=NULL, local_version=0`；
2. C 路 UPDATE（question_bank_service.rs L755-760）：只 SET `is_correct, grading_method`；
3. B 路 UPDATE（pipeline.rs L228-231）：同上两列。

另有零调用死代码 `update_submission_correct`（question_repo.rs L2530-2545，
全仓 grep 无调用方）同样只 SET 两列——留着就是下一个复制粘贴错误源。

后果（引擎侧核对）：__change_log 触发器能把变更送进推送队列，不至于漏传；但
LWW 冲突裁决读行内 `updated_at`（NULL 回退快照 created_at）——改判行时间戳恒
NULL/陈旧，**跨设备并发时改判结果可被对端旧行按"更新"覆盖**；
`local_version > sync_version` 的本地修改判定恒假。对照写法：mastery tombstone
（mastery/service.rs L252-259）`updated_at = now, local_version = COALESCE(·,0)+1`
是仓内标准，三处写点照抄即可，应并入 §2 原语一次修完。

`questions` 行三路都走 `mark_as_modified_with_conn + update_content_hash_with_conn`
（A：repo L2052-2053；B：pipeline L272-281；C：L781-790），题目行同步无缺口 ✅。

## 4. daily 回写闭环核对

### 后端：闭环 ✅

- `query_daily_progress`（L2663-2716）以 `answer_submissions` 为权威源，
  `DATE(submitted_at,'localtime')` 对齐本地日界线，`GROUP BY question_id +
  MAX(correct)` = 按题去重、当日任一次答对计对；存量无提交题按
  `last_attempt_at` 兜底（L2683-2690）。
- 三路判分都改写 submission 行的 `is_correct`（A 插行 / B、C 原地 UPDATE），
  所以任何一次 `get_daily_practice`（L2528-2529 重算进度，L2534 排除已答，
  L2617-2629 题荒时允许重练回补）都能把改判/AI 复判收敛进
  `completed_count/correct_count/is_completed`（L2640-2647）。
- 残留小口径：`is_completed = completed_today >= count`（L2647）用的是**本次请求
  参数** count，daily_target 换挡后新旧请求判定不一致（N5）；
  `DailyPracticeResult` 仍不回传 `answered_question_ids`（r1-06 §5 缺口，N7）。

### 前端：会话内不闭环 ❌（复核 r1-07 §三，属实且未修）

- 唯一写入方 `recordPracticeAnswer`（questionBankStore.ts L1918-1960）：
  timed 首答锁 L1928、daily 首答锁 L1947——已答题再调用整体跳过，
  没有任何"旧判定→新判定"差量路径。
- 正常提交路径 `handleSubmitAnswer`（ExamContentView.tsx L963-999）调它（L970）
  并回写 mock_exam `answers/results`（L975-996，主观题 `isCorrect=null` 时从
  results 删除键，L988）。
- **改判路径 `handleMarkCorrect`（L1002-1005）只调 hook `markCorrect`
  （useQuestionBankSession.ts L545-549 → 裸 submitAnswer 带
  `regrade_submission_id`，L498-507），三个回写全绕开**：
  `recordPracticeAnswer`、mock_exam results、`recordPracticeSessionAnswer`
  （QuestionBankEditor.tsx L1142 只在正常提交路径调用）。
- **AI 判分完成路径同样绕开**：`startAiGrading` 的 onComplete
  （QuestionBankEditor.tsx L1121-1133）只 `setSubmitResult` + `onRefreshQuestion`
  （刷新单题 + 全库 stats，useQuestionBankSession L441-484），不碰任何会话对象。
- 后果分档：
  - daily/timed：会话窗口内进度/正确数滞后，回启动页 `getDailyPractice`
    全量覆盖收敛（r1-07 §二）——**显示滞后，非阻断**（N2）；
  - mock_exam：成绩单由后端 `submit_mock_exam` 直接以前端传入的
    `session.results` 计数（question_bank_service.rs L2487
    `correct_count = session.results.values().filter(|&&v| v).count()`），
    没有任何服务端重算兜底。主观题在交卷前经 AI 判分或 handleMarkCorrect
    改判的结果**永远进不了 results**（提交时已按 null 从 results 删键，L988），
    交卷即按"答了但没对"计入 wrong_count（L2489）——**成绩单永久算错，阻断**（B5）。
- 修复前提复核（r1-07 §三结论仍成立）：给 `handleMarkCorrect`/AI onComplete
  单补一行 `recordPracticeAnswer` 是无效修复，首答锁会吞掉；需先给该 action
  增加改判差量语义（r1-07 §七插入点 1），mock results 回写可与
  L975-996 抽成共用函数。

### mastery 回写（附带核对）

- 事件幂等键 `me_qbank_{submission_id}`（service.rs L136），
  `ON CONFLICT(id) DO NOTHING`（L320-336）；换判时 C 路 L794-801 再调用，
  键已存在 → 事件流停在首判 outcome，`recompute_state_with_conn`（L410-485，
  已滤 `deleted_at IS NULL`）按旧信号回放——**有意设计**（L709-710 注释明示），
  但与"三路一致"目标冲突；tombstone+纠正事件范式已有现成参照
  （`revert_fsrs_rating_for_log` L227-264），修法见 r1-06 §3（N1）。
- B 路零事件比"停旧值"更彻底：主观题 AI 判分对掌握度是**零信号**（B3）。

## 5. 阻断 / 非阻断清单

### 阻断（5 条，全部集中在 B 路与改判回写面）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| B1 | AI 判分 correct_count 单向计数：漏 false→true +1、true→false −1 | pipeline.rs L242-267 | 复判换向后计数漂移不自愈，status 与计数矛盾；三路口径分叉根因 |
| B2 | AI 判分差值基准取题目级 `questions.is_correct` 而非被评判 submission 旧值，③ 段还无条件覆盖题目"最近作答结果" | pipeline.rs L228-267（对照 L749-753 正确写法） | 评判期间再提交 → 增量方向错 + 新提交状态被旧 verdict 回写覆盖 |
| B3 | AI 判分全程不写 mastery 事件 | pipeline.rs 持久化段（无任何 record_qbank_answer 调用） | 主观题掌握度零信号，画像/弱点/防刷统计全缺该来源 |
| B4 | `answer_submissions` 三处写点不推进 `updated_at/local_version(/device_id)` | question_repo.rs L2474-2488；question_bank_service.rs L755-760；pipeline.rs L228-231 | LWW 时间戳恒 NULL → 跨设备改判可被对端旧行覆盖；本地修改判定恒假 |
| B5 | `handleMarkCorrect` 与 AI onComplete 均不回写 mock_exam `results`，而成绩单由该 map 计数 | ExamContentView.tsx L1002-1005；QuestionBankEditor.tsx L1121-1133、L988；question_bank_service.rs L2487-2489 | 主观题改判/AI 判对后交卷，成绩单永久少计 correct、多计 wrong——非显示滞后，是持久化错账 |

### 非阻断（7 条）

| # | 问题 | 位置 | 定性 |
|---|---|---|---|
| N1 | mastery 换判 DO NOTHING 停首判信号（不回改） | service.rs L320-336；question_bank_service.rs L792-801 | 注释明示的设计取舍；修复走 tombstone+纠正事件（r1-06 §3），应与 B3 同包 |
| N2 | daily/timed 前端首答锁：会话窗口内改判/当日重答不修正，回启动页收敛；跨零点会话继续累加昨日 | questionBankStore.ts L1928、L1947 | 显示滞后，后端权威值兜底；修复即 r1-07 插入点 1/5 |
| N3 | B 路 refresh_stats、三路复习计划/profile 回流在事务外，失败仅 warn | pipeline.rs L297-317；service L606-635、L812-829 | 派生数据可重放，口径三路对称，可接受 |
| N4 | `update_submission_correct` 死代码（零调用）且同样缺同步列 | question_repo.rs L2530-2545 | 应随原语抽取删除，防复用旧口径 |
| N5 | `is_completed` 用本次请求 count 而非持久化 daily_target | question_bank_service.rs L2647 | target 换挡时新旧判定不一致；与 r1-07 §五 P2-1 同族 |
| N6 | 状态转换 CASE 三份文本副本（repo L2020-2025 / pipeline L251-255 / service L768-772） | 三文件 | 行为当前一致，纯维护性风险；原语抽取时消除 |
| N7 | `DailyPracticeResult` 缺 `answered_question_ids`（query_daily_progress L2702-2713 已算出未返回） | question_bank_service.rs L3268 附近结构体 | 前端只能本地维护已答集，多端/重开靠重拉收敛 |

## 6. 对照 r1-06 / r1-07 的复核结论

- r1-06 §1-§5 与 r1-07 §一-§三、§六的全部事实断言在当前工作区**逐条复核属实**，
  行号一致（文件零改动）。
- 本轮新增（第 1 轮未明确定级）：**B5**——r1-07 §三只记录了 mock results
  拿不到改判结果，本轮沿链核到后端 `submit_mock_exam` L2487 确认成绩单直接
  以该 map 计数、无服务端重算，故从"前端会话增量缺口"升格为阻断。
- 修复归并建议（供第 5 轮）：B1+B2+B4(写点2/3)+N4+N6 → 一次
  `apply_submission_verdict_in_tx` 抽取（签名见 r1-06 §2）；B3+N1 →
  `correct_qbank_answer_with_conn`（r1-06 §3）；B4(写点1) → INSERT 补三列；
  B5+N2 → r1-07 §七插入点 1（改判差量语义 + mock 回写共用函数）。

## 7. 禁改区确认

本轮零代码改动、零测试运行、零 commit；仅新增本审阅文档。
