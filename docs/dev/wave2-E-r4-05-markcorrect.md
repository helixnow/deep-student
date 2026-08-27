# Wave2-E R4-05：handleMarkCorrect 判分回写对齐

- 轮次：0824 Wave2-E 第 4 轮
- 独占文件：`src/features/learning-hub/apps/views/ExamContentView.tsx`（仅判分调用点 `handleMarkCorrect`，未动壳层布局 / 路由 / 样式）
- 约束：未跑编译 / 测试 / CI，未 commit

## 问题

`handleMarkCorrect`（自评改判入口，"我答对了 / 我答错了"）此前只调用 hook 的
`markCorrect(questionId, isCorrect)` 就结束了，与 `handleSubmitAnswer` 不对称：

1. 未调用 `recordPracticeAnswer`，限时（timedSession）/ 每日（dailyPractice）
   练习进度不会因自评而更新。对主观题这是唯一判分路径——`submitAnswer`
   返回 `is_correct = null` 时进度分片记的是 null，正确数只能靠改判补上；
   而"跳过自动判分直接自评"的题目此前完全不计入进度。
2. mock_exam 的 `results` 不回写。模拟考成绩计算依赖
   `mockExamSession.results`，主观题提交时 `handleSubmitAnswer` 因
   `isCorrect === null` 会 `delete results[questionId]`，之后自评改判也不再写回，
   导致主观题在模拟考成绩里永远不计分。

## 修改（均在 `handleMarkCorrect` 内，约 1001–1035 行）

1. **`recordPracticeAnswer` 回写**：`await markCorrect(...)` 成功后调用
   `useQuestionBankStore.getState().recordPracticeAnswer(sessionId, questionId, isCorrect)`，
   与 `handleSubmitAnswer` 的写法逐字对齐。action 内部按「会话题目成员资格 +
   首答幂等（answered_question_ids 去重）」门禁：
   - 已通过 `handleSubmitAnswer` 计过数的题目，改判时该调用是空操作，不会双计；
   - 未经自动判分、直接自评的题目由这里首次计入 answered/correct。
   - 已知边界（与 submit 路径同源，非本轮引入）：首答记为 null/错、改判为对时，
     幂等门禁使 correct_count 不回补。修正需改 store action 语义，超出本轮独占范围。
2. **mock_exam results 对称回写**：`practiceMode === 'mock_exam'` 时从 store 读最新
   `mockExamSession`（非闭包快照，防后写覆盖），守卫与 `handleSubmitAnswer` 相同
   （exam_id 匹配、未提交、题目属于本场），额外要求 `questionId in answers`
   （改判不改作答内容，只更新判定；对本场未作答的题目不制造"有判定无作答"记录），
   然后 `results[questionId] = isCorrect`。`markCorrect` 的 `isCorrect` 参数是
   非空 boolean，无需 submit 路径的 null 分支（delete）。
3. **daily_progress**：核查结论——当前链路没有该数据可接。
   `useQuestionBankSession.markCorrect` 返回 `Promise<void>`，其内部
   `qbank_submit_answer` 的返回结构 `SubmitAnswerResult`（is_correct /
   correct_answer / needs_manual_grading / message / submission_id /
   updated_question / updated_stats）不含 `daily_progress` 字段，前端 store 中
   也无同名消费点（全仓 grep `daily_progress|dailyProgress` 无命中）。
   每日进度实际由第 1 点的 `recordPracticeAnswer` 更新 `dailyPractice` 分片覆盖。
   已在调用点留注释：若未来 hook 透出该字段，在此接入 store。

## 未动的部分

- 壳层布局、路由、样式、Tab 结构（归 B）；
- `useQuestionBankSession` / `questionBankStore`（非独占文件）；
- `handleSubmitAnswer` 本体逻辑（仅作为对齐参照）。

## 验证建议（后续轮次）

- 模拟考中提交一道主观题 → 自评"我答对了" → 交卷，成绩应计入该题；
- 每日练习中主观题自评后，面板 completed/correct 计数应更新；
- 客观题正常提交后再改判，timed/daily 进度不应双计。
