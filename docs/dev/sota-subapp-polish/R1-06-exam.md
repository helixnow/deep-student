# R1-06 — 题库 / 练习（exam）审阅报告

- 席位：R1-06（只读审阅，`claude-fable-5-thinking-xhigh`）
- 日期：2026-08-24
- 对标：Quizlet（Learn/Test/Match、间隔重复）、作业帮（错题本、组卷打印、每日一练）
- 审阅范围：`src/features/practice`、`src/features/learning-hub/apps/views/ExamContentView.tsx`（~2500 行）、`src/hooks/useQuestionBankSession.ts`、`src/stores/questionBankStore.ts`（~2000 行）、`src/components/practice/*`（Launcher / Timed / MockExam / Daily / PaperGenerator / AnswerSheetGrid）、`src/components/QuestionBankEditor.tsx`（~3000 行）、`src-tauri/src/question_bank_service.rs`、`docs/user-guide/11-题库与练习.md`
- 结论概览：答题器（QuestionBankEditor）能力面很强——7 种题型、AI 判分、快捷键、专注/遮答案模式已达一线水准；**短板集中在"练习闭环"：每日一练进度是死数据（P0）、限时/模拟考不落盘、自评重复计数、组卷导出只有 Markdown**。

## 一、功能缺口（对标 Quizlet / 作业帮）

| # | 缺口 | 竞品参照 | 说明 |
|---|------|----------|------|
| G1 | 每日一练无有效进度/达标反馈 | 作业帮每日一练闭环 | 见 Bug B1/B2，进度条恒 0、达标阈值硬编码，打卡激励链路断裂 |
| G2 | 限时/模拟考会话不可恢复 | 作业帮/考试类 App 均支持断点续考 | `timedSession`/`mockExamSession` 仅存内存（无 persist），应用重启即丢，倒计时无法恢复 |
| G3 | 组卷 PDF/Word 导出未实现 | 作业帮试卷还原/错题打印 | `PaperGenerator.tsx` L175-180：非 Markdown 格式仅提示"即将推出"；打印是纸质练习刚需 |
| G4 | 错题本无导出/打印 | 作业帮错题打印机场景 | 错题模式可重练，但无法把错题集导出成可打印文档 |
| G5 | 无游戏化练习模式 | Quizlet Match/Blast、学习闯关 | 现有 9 种模式全部是"刷题"形态，无配对/竞速/闯关等轻量激励形态 |
| G6 | 无 TTS/音频支持 | Quizlet 读卡、语言学科场景 | 题干/选项无朗读入口 |
| G7 | 练习作用域限单题目集 | Quizlet 文件夹级学习 | 每日一练、错题重练均按单 `examId`；无跨题集混合练习 |
| G8 | 题库(SM-2)与闪卡(FSRS)双轨调度 | Anki 统一调度 | 复习计划用 SM-2、闪卡用 FSRS，口径不一致；错题→制卡目前只能经对话绕行（guide 12"从错题制卡"），题库内无一键制卡直达 |
| G9 | 无每日提醒/通知 | 作业帮打卡提醒 | 连续打卡全靠用户自觉打开应用 |

## 二、UI/UX 问题

1. **死进度条**：`DailyPracticeMode.tsx` L306-349 的"今日进度"与庆祝动画（彩点+奖杯）依赖 `completed_count`/`is_completed`，而该数据恒为 0/false（Bug B1），用户练完 10 题回到面板仍显示 0/10——比没有进度条更伤信任。
2. **导出格式选择误导**：PaperGenerator 的 4 格导出格式选择器把 PDF/Word 与可用的 Markdown 并列平权展示，点导出才发现"即将推出"；未实现格式应置灰+徽标。
3. **每日目标输入口径分裂**：UI 允许 5–50（`normalizeDailyTarget`），而 agent 交接校验 `practiceInteger(session.daily_target, 1, 20)`（`questionBankStore.ts` L718），目标设 30 时 AI 代练交接会判"session 无效"。
4. **组卷预览高度固定** `max-h-[min(60vh,520px)]`，大窗口下浪费一半空间。
5. **日历微动效重播**：月份切换用 key 重挂载全部格子逐格 `ui-rise-in`，快速翻月时闪烁感明显。
6. 配置类面板（限时/模拟考/组卷）无键盘流转，与 QuestionBankEditor 的完善快捷键体系反差大。

## 三、学习桌面（Workbench）窗口表现

- `exam` 属资源工作区应用（`workbenchBus.ts` `RESOURCE_WORKSPACE_TYPE_IDS`），同资源请求复用工作区+内部定位事件，多开体验正确。
- `useQuestionBankSession` 把题目/统计/当前题/练习模式全部本地化到窗口实例（含 `sessionEpochRef` 防串台、`lastQuestionId` localStorage 续读），多开两个题目集互不干扰——这是正确的 workbench 架构。
- **但练习会话是全局单槽**：`questionBankStore` 的 `timedSession`/`mockExamSession`/`dailyPractice`/`generatedPaper` 都是单例字段。展示层已按 `exam_id` 门禁（如 `DailyPracticeMode` L81、`ExamContentView` L361），不会串显；但窗口 B 开始限时练习会**顶掉**窗口 A 的进行中会话（数据被覆盖而非并存）。
- 超时处理在 `ExamContentView` 与 `TimedPracticeMode` 双轨存在，多窗+超时组合下有重复触发风险。

## 四、Bug 清单

| # | 级别 | 现象 | 根因（文件:行） |
|---|------|------|------------------|
| B1 | P0 | 每日一练进度恒 0/10，完成庆祝永不出现 | 后端 `get_daily_practice` 每次现算题目列表并硬编码 `completed_count: 0`（`question_bank_service.rs` L2537-2550，无当日进度持久化）；前端 `setDailyPractice`（`questionBankStore.ts` L1747）定义后**无任何调用方**，答题路径不回写进度 |
| B2 | P1 | 打卡日历"达标"与用户目标无关 | `target_achieved: question_count >= 10` 硬编码（`question_bank_service.rs` L2763）；目标设 5 做 5 题不达标、设 20 做 10 题反而达标 |
| B3 | P1 | 自评（标对/标错）使做题量统计翻倍 | `useQuestionBankSession.ts` L503-507：`markCorrect` 通过再次 `submitAnswer` 实现，`answer_submissions` 多插一行；日历按题去重不受影响，但按提交行数的口径（attempts/正确率）失真 |
| B4 | P1 | 进行中的限时/模拟考重启即丢 | store 无 persist 中间件，会话仅存内存（G2 同源） |
| B5 | P1 | 多窗并发练习互相顶替 | 单槽会话字段（见第三节） |
| B6 | P2 | 目标 21–50 的每日一练无法交给 Agent 续练 | handoff 校验上限 20 与 UI 上限 50 不一致（UI/UX #3 同源） |
| B7 | P2 | PDF/Word 导出不可用但入口平权展示 | `PaperGenerator.tsx` L175-180（guide 11 已注明"待实现"，属已知降级） |

## 五、前 8 优化建议

1. **每日一练进度落盘**（修 B1）：后端按 `(date, exam_id)` 持久化 `completed/correct`，或从 `answer_submissions` 当日聚合推导；前端答题成功后回写 `setDailyPractice`。
2. **达标阈值跟随用户目标**（修 B2）：`daily_target` 随 check-in 记录存储，日历按当日目标判定。
3. **限时/模拟考持久化 + 崩溃恢复**：zustand persist（含 `started_at`，恢复时重算剩余时间），入口提供"继续上次考试"。
4. **`markCorrect` 改为修正而非重提交**：后端提供 `update_attempt_result`，避免双计。
5. **组卷 PDF 导出落地**：已有 Markdown 拼装，接打印管线（或 HTML→系统打印）即可覆盖纸质场景。
6. **错题→闪卡一键直达**：错题详情/错题模式加"做成闪卡"按钮，走现有制卡管线，打通"做错→制卡→FSRS 复习"闭环（现在只能对话绕行）。
7. **练习会话按 `examId` 分槽**：`Record<examId, TimedSession>`，解除多窗互斥。
8. **每日一练提醒**：接现有系统通知能力，未完成目标时定时提醒（可关）。

## 六、优先级汇总

- **P0**：B1 每日一练进度死数据（打卡/庆祝/续练全链路失效，属核心激励闭环断裂）。
- **P1**：B2 达标阈值硬编码；B3 自评双计；B4 会话不持久化；B5 多窗单槽；G3 组卷 PDF 导出。
- **P2**：B6 handoff 目标上限失配；B7 导出入口误导；超时双轨；预览高度；日历动效；配置面板键盘流；G5/G6/G9。
