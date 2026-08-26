# 题库 / 练习会话 / daily_target / 工具压缩改造质量评审

对照 `v0.9.44` 与 `origin/cursor/0824-cde6 @ 2d41ea8b`，这块不是简单的“修了几个显示问题”：它把自评改判、每日进度、限时/每日会话回写和 Agent 契约串到了一起。方向大体正确，旧版最明显的双计数与进度恒零问题也确实被修掉了；但新引入的全局练习状态破坏了题库原本刻意建立的多标签隔离，daily 进度又同时存在三套不同口径。**总判定为 WARN：后端主链明显优于旧版，但当前还不能把“练习进度一致性”视为完成态，仍有发布前必须收口的问题。**

## 最需要先修的不是 SQL，而是会话归属

`useQuestionBankSession` 文件开头明确说明，题目、统计、当前位置、练习模式都本地化，是为了让保活的多个 `ExamContentView` 互不干扰（`src/hooks/useQuestionBankSession.ts:1-9`）。本轮却把连对数、正确数、已答题集合重新放进了一个全局单槽 `practiceSession`（`src/stores/questionBankStore.ts:819-834,951-959,1028`）。

这个单槽不是“略有串台概率”，而是能确定复现的归属错误：

- 每个 `QuestionBankEditor` 只在 `sessionId` 变化/挂载时调用一次 `ensurePracticeSession(sessionId)`；最后挂载的题目集会占据全局槽。
- `recordPracticeSessionAnswer(questionId, isCorrect)` 不带 `examId`，也不校验题目是否属于当前槽（`questionBankStore.ts:1053-1072`）。
- 两个保活标签 A、B 挂载后，如果 B 最后写入槽，用户回到 A 答题，A 的题目 ID 会被记进 B 的进度；两个编辑器又同时订阅这一个槽，所以连对提示和完成庆祝会一起被污染。即使是同一题库的两个窗口，也会共享本应独立的“本轮”进度。

这与本轮 session hook 的隔离目标正面冲突。把状态提到全局以便“做题 → 错题本 → 回做题”不清零是合理诉求，但容器至少应是 `Map<examId/viewInstanceId, PracticeSessionProgress>`；如果“同一题库两个窗口”也要隔离，键必须是稳定的 view instance，而不只是 examId。最低限度也应让 record action 携带 examId 并 fail closed，而不是把当前全局槽当作隐式归属。

此外，`recordPracticeSessionAnswer` 只对 `answeredIds` 去重，`streakCount` 与 `totalCorrectCount` 每次重答仍会累加（`:1058-1069`）。这沿用了旧 UI 的尝试次数感知，但新的字段名和完成统计把它表达成“题目数”；应明确是“正确尝试数”还是“答对题数”，否则重做同一题可让完成卡的正确数超过题目总数。

## daily 修复了“恒为 0”，但实时值与权威值并非同一种统计

后端这一段改造本身质量不错。`get_daily_practice` 不再把 `completed_count` 写死为 0，而是按本地日界线查询真实提交；按题去重，正确数采用“该题当天任一次答对”，并将当天已答题先排除出推荐（`src-tauri/src/question_bank_service.rs:2525-2534,2658-2715`）。未答题不足时再回补已答题，保证“再练一组”仍有内容（`:2615-2629`）。相较旧版，这是实质性闭环，不是 UI 补数。

问题在于前端回写选择了另一套语义。`recordPracticeAnswer` 对 timed/daily 都是“首答锁定”：题目 ID 一旦进入 `answered_question_ids`，后续结果完全忽略（`src/stores/questionBankStore.ts:1822-1863`）。因此：

1. 同题第一次答错、重做答对时，后端下次查询会按“当天任一次答对”计正确，当前面板却一直计错，直到重新生成/刷新后突然跳变。
2. 主观题首次提交为 `null` 时会立即计入已答且锁住“未计正确”；之后 AI 评判或“我答对了”改判不会回写该 session。`ExamContentView` 只在初次 `handleSubmitAnswer` 调用 `recordPracticeAnswer`，`handleMarkCorrect` 没有对应调用（`src/features/learning-hub/apps/views/ExamContentView.tsx:963-998,1000-1004`）。
3. “再练一组”会回补今天已经答过的题，而新 session 的 `answered_question_ids` 为空。后端返回的 `completed_count` 已包含这些题，前端再次作答又 `+1`；面板可显示 4 题，后端按唯一题重算仍是 3 题。

新增测试把“first answer wins”明确钉成预期（`tests/vitest/question-bank-practice-progress.test.ts:63-83`），但这恰好与后端 `MAX(correct)`/按题去重口径冲突。这里不应靠更多局部 if 修补；应先选定统一定义。若 daily 展示“当天唯一已答题数 + 当天是否曾答对”，最稳妥的是提交/改判完成后让后端返回权威 daily 聚合，或至少携带按题 verdict map；若产品要展示“本组首答成绩”，就应把它与全天打卡统计拆成两个字段和两套文案。

## `daily_target` 现在只是“用当前值重算历史”，不是按日目标

把 UI 的 5–50、handoff/Agent 的 1–50、executor 的 1–50 和服务端参数打通，修掉旧版 20 上限及日历硬编码 10，契约方向是对的（`questionBankStore.ts:719-735`、`src-tauri/src/chat_v2/tools/qbank_executor.rs:3535-3541,3584-3609`、`question_bank_service.rs:2832-2847`）。日历请求还加了代际保护，旧月份慢请求不会覆盖新请求（`questionBankStore.ts:1996-2020`）。

但实现没有存储“某天的目标”。目标只按题目集写入浏览器 `localStorage`（`src/components/practice/DailyPracticeMode.tsx:64-90`），日历请求把当前这个单值传给后端；后端再用同一个 `target` 判断整个月每一天（`question_bank_service.rs:2912-2926`）。结果是：

- 今天把目标从 10 改成 20，过去整月所有 10–19 题的绿色打卡都会被追溯改成未达标；
- 换设备或清理本地存储后目标回到 10，历史日历又会改变；
- Agent 省略 `daily_target` 时按 10 重算，与用户当前设备上的设置无关联。

所以注释中“随用户目标”“按当日目标判定”的说法高于实际能力。若产品需要历史打卡语义，目标必须作为带 `exam_id + effective_date/date` 的同步数据持久化，并由 calendar 为每一天返回所用 target；若产品只想提供筛选视角，应明确命名为“按当前目标查看”，不要把重算结果包装成历史事实。

## 显式改判是本轮最扎实的后端改进，但还没有统一 grading/mastery

旧版“我答对了/我答错了”会重新插入 submission，导致 `attempt_count` 双计。本轮的方案是正确的：hook 保存每题最近一次 `submission_id` 并在自评时显式带回（`src/hooks/useQuestionBankSession.ts:203-206,464-489`）；command 只在同时有 submission id 和 override 时进入改判；服务端再次确认它仍是该题最新提交，再在同一事务里更新 submission、question、统计、同步标记与 mastery（`src-tauri/src/question_bank_service.rs:661-718,746-809`）。`correct_count` 按旧判定到新判定的差值增减，也比旧版只处理 `NULL → true` 完整。新增回归测试覆盖了错→对→错、幂等和拒绝过期 submission（`:4167-4258`）。这条主链可以肯定。

不过，事务里写入的几个事实并不总能保持一致：

- mastery 事件 ID 固定为 `me_qbank_{submission_id}`，插入使用 `ON CONFLICT(id) DO NOTHING`（`src-tauri/src/mastery/service.rs:121-145,295-337`）。因此一个已产生 mastery 事件的提交从错改对或从对改错时，question/submission 会改变，mastery event、mastery state 和 learner profile 仍保留首判；服务端注释也承认“不会回改首判信号”（`question_bank_service.rs:704-710`）。这不是纯审计留痕，因为该事件被继续当作当前掌握度证据。
- `qbank_grading/pipeline.rs` 没有复用新改判逻辑。它仍只在 question 原先 `is_correct IS NULL` 且新判定为 true 时增加 `correct_count`（`src-tauri/src/qbank_grading/pipeline.rs:220-268`），重复 AI 评判发生 false→true / true→false 时计数会失真；该管线也没有补 mastery event。于是“自动判分、AI 判分、人工换判”三条路径对同一 submission 的派生事实不同。
- 改判 SQL 只更新 `answer_submissions.is_correct/grading_method`（`question_bank_service.rs:755-760`），没有推进该 RowSync 表的 `updated_at/local_version`；虽然 change-log trigger 能看到 UPDATE，LWW 冲突排序仍缺少明确的新版本时间。`answer_submissions` 已被分类为 RowSync/LWW（`src-tauri/src/data_governance/sync/classification.rs:163-171`），这条应至少补跨设备回放测试，不能只验证本地行值。

建议抽出唯一的 `apply_submission_verdict_in_tx`，由 submit pending 改判、AI grading、人工换判共同调用；它统一处理 question 计数/状态、submission 同步元数据、stats、review plan 和 mastery。mastery 若坚持 append-only，应写“撤销/纠正首判”的新事件或 tombstone 旧事件后重算，而不是一边修改 submission，一边让同 ID 的证据永久停在旧 verdict。

## 工具描述压缩：整体无净损失，少数输出契约被压过头

大多数压缩是高质量去重：

- `required`、`maximum`、枚举已经在 JSON Schema 中，删掉字段描述里的“【必填】/最多 N”不会丢机器约束。
- structured_data 与 `user_answer` 的完整示例没有删除，而是集中到技能正文的“出题格式要求”和“user_answer 序列化格式”（`src/features/chat/skills/builtin-tools/qbank-tools.ts:97-119`）；各工具描述改为交叉引用（`:204-218,230-239,376-380`）。这比在多个工具里复制并逐渐漂移更好。
- import/export 的安全属性仍保留：真实写文件、返回截断预览、不把完整正文注入上下文（`:406-417`）；daily 的 50 上限与新增 `daily_target` 也同时进入 schema（`:724-750`）。

有少量真实信息损失，因为这里没有 response schema，description 本身就是输出契约：

- `qbank_get_question_history` 从旧版明确的 `old_value/new_value = {text,truncated} | null` 压成了含混的“old/new_value”（`:599-612`），模型更容易把 bounded wrapper 当字符串。
- `qbank_toggle_bookmark` 删除了具体截断标记名，只剩“截断并标记”（`:569-582`）；同文件的 favorite/create/search 工具仍保留精确字段名，契约粒度不一致。
- export 删除 DOCX 的标题/粗体/斜体说明属于低价值产品信息损失，不影响正确调用。

因此压缩本身可判 PASS，但应把 bounded output 的字段形状提炼成一段共享技能正文，或正式增加 response schema；不要只在部分工具中保留精确名。

## 最终判断

相对旧版，这次不是退化：显式 submission 改判、真实 daily 聚合、已答题排除、目标范围贯通、工具描述去重都属于有效改进，测试也覆盖了主要 happy path。问题集中在“同一事实被多个状态容器和判分管线各算一次”：全局单槽破坏标签隔离，daily 的后端/前端口径互相跳变，目标没有历史身份，mastery 又不接受改判。

发布前优先级建议：

1. 将 `practiceSession` 改成按 view/session 分片并加入归属校验，补两个保活题库并行答题测试。
2. 统一 daily/timed 对重答、待批改→已判定、“再练一组”的统计定义，补权威聚合回写。
3. 让 grading 与人工改判复用同一 verdict 落库原语，并定义 mastery correction 与 RowSync 版本推进。
4. 决定 daily target 是历史事实还是当前重算条件；前者必须持久化并同步。
5. 工具压缩只补回精确的 bounded response 结构，不必恢复大段重复说明。

本评审为定向静态复核：按上述版本间真实 diff 追到 command、session 消费点、sync/mastery/qbank_grading 接缝与测试文本；未运行编译、门禁或测试。
