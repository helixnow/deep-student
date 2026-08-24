# R1-09 — 闪卡 / Anki（flashcards）审阅报告

- 席位：R1-09（只读审阅，`claude-fable-5-thinking-xhigh`）
- 日期：2026-08-24
- 对标：Anki（FSRS、牌组体系、多级撤销、统计）、SuperMemo（增量复习、用时追踪）、Quizlet
- 审阅范围：`src/features/workbench/apps/system/FlashcardsAppWindow.tsx` + `register.tsx`、`src/features/flashcards/**`（FlashcardsApp、Today/Library/Statistics/ReviewSession 四屏、`fsrsReviewStore.ts` ~1600 行、libraryStore、review/library/components/hooks）、`docs/user-guide/12-Anki制卡与模板.md`、`13-闪卡复习.md`
- 结论概览：核心复习循环质量很高——FSRS 评分带幂等 `clientOpId` + OCC（`expectedLastReviewMs`）、学习步 15 分钟窗口回插、评分按钮预测间隔、外部（AI）评分回声消解、滑动手势与快捷键齐全。**差距在 Anki 的"体系能力"：无牌组、单级撤销、不记作答用时、无 leech/自定义学习/参数优化；另有一处文档与实现相反的漂移。**

## 一、功能缺口（对标 Anki / SuperMemo）

| # | 缺口 | 竞品参照 | 说明 |
|---|------|----------|------|
| G1 | 无牌组/子牌组体系 | Anki decks + 每牌组选项 | 全库单队列，调度配置为"默认牌组"全局生效；不同学科无法设不同新卡/复习限额，只能靠标签筛选浏览 |
| G2 | 撤销仅单级 | Anki 无限撤销栈 | `fsrsReviewStore.ts` L1285+：`lastReview` 单槽，评下一张后上一步不可撤 |
| G3 | 不记录作答用时 | Anki `time_taken`、SuperMemo 用时分析 | `fsrs_rate` 调用（L1127-1134）不带 duration；统计里永远出不了真实学习时长（题库侧日历 `study_duration_seconds: 0` 同病） |
| G4 | 无 leech（顽固卡）检测 | Anki 8 次 lapse 自动标记/暂停 | 反复评"重来"的卡不会被识别、提示或自动暂停 |
| G5 | 无自定义学习/筛选牌组 | Anki filtered deck、提前学 | 无"考前突击按标签集中复习""提前学明天到期卡""只重练今天错的" |
| G6 | 无 FSRS 参数个体化优化 | Anki FSRS optimizer | 仅可调目标保持率（0.5–0.99）；不能基于自己的 review log 优化权重 |
| G7 | 无卡片信息面板 | Anki Card Info（S/D/R、复习历史） | 库中可见状态/到期/最近评分，但无稳定性/难度/可提取性与完整复习时间线 |
| G8 | 无同族卡（cloze 兄弟卡）埋藏 | Anki sibling burying | 同一填空卡的多个挖空可能背靠背出现 |
| G9 | 库内无导入/导出 | Anki 浏览器导出 | .apkg 导入/导出全部要绕道对话或制卡任务看板；卡片库本身无入口 |
| G10 | 删除无回收站 | Anki 有备份兜底 | 库内删除二次确认后不可恢复（guide 13 Q5 亦如此声明） |

## 二、UI/UX 问题

1. **调度设置藏在「统计」页**：`SchedulerSettingsSection`（每日新卡/复习上限、目标保持率）注释自称"settings tab"，实际渲染在 `StatisticsScreen.tsx` L303——想调每日新卡量的用户不会去统计页找；且该区块在 `stats` 加载失败时整体不可达（包在 `stats ?` 分支内）。
2. **文档与实现相反**：guide 13 Q6 明确说"暂时不能调整每天新卡上限……后续版本开放"，但设置已上线（读写 `fsrs_get/update_scheduler_config`）。文档漂移直接劝退了会去找该功能的用户。
3. **评分预测间隔是异步补显**：翻面后才 `fsrs_preview_intervals`（L1090），慢后端下按钮先无间隔后闪现；可预取当前卡预测。
4. 会话批次上限硬编码 50（`fsrs_get_due` L393），"本轮先练前 50 张"不可配置。
5. 库删除确认、批量操作、键盘（↑↓/回车/空格）齐备，属加分项；但批量栏无"全选筛选结果"（只有"全选本页"），大库批量入队要翻页多次。
6. 统计屏对前端近似数据有诚实标注（真实日志 vs 近似聚合、截断提示），好实践；但热力图/柱状图无点击下钻。

## 三、学习桌面（Workbench）窗口表现

- 注册为单实例应用（`register.tsx` L259-272）：`defaultFrame` 960×680、`minSize` 560×440、`memoryWeight: 2`，Dock 角标 = 到期数（`flashcardsDueBadgeSource`，随 `requestFlashcardsDueRefresh` 事件刷新）——到期角标是同类产品少有的桌面级整合。
- 单实例对复习完整性正确（避免双窗并发评分自打架）；且 store 对**外部评分**（AI 经聊天代评）做了回声消解与忙时挂起（`reconcileExternalRate`：`recentLocalLogIds` 配对忽略、`pendingExternalRateIds` 延迟处理），当前卡不会被外部操作从脚下抽走——这是 workbench 多入口场景下的正确并发设计。
- `onActivation` 支持 agent `startReview` 启动载荷；agent manifest 暴露 screen 路由（`flashcards/${screen}`），AI 可开屏、翻面但不代评分，与 guide 13 声明一致。
- 窗口缩到 560×440 时复习会话仍可用（评分栏/卡面自适应）；库屏为分页而非虚拟列表，千级卡量下每页 DOM 可控。

## 四、Bug / 风险清单

| # | 级别 | 现象 | 根因（文件:行） |
|---|------|------|------------------|
| B1 | P1 | 用户按文档认为"新卡上限不可调"，功能被埋没 | guide 13 Q6 过期 + 设置区位置错位（`StatisticsScreen.tsx` L303） |
| B2 | P1 | 统计加载失败时调度设置一并不可用 | `SchedulerSettingsSection` 渲染在 `stats ?` 分支内，error 分支只给重试 |
| B3 | P2 | 评错分后多做一张即无法撤销 | 单槽 `lastReview`（G2 同源） |
| B4 | P2 | 学习步卡可能早于其 due 提前出现 | 15 分钟窗口内回插队尾"轮到时可提前展示"（L31、L1154-1166）——设计取舍而非缺陷，但与 Anki 严格计时不同，建议在卡面标注"提前重现" |
| B5 | P2 | 旧后端响应缺 `cardState.state` 时 Good/Easy 评分的学习步卡不回插 | L1158-1161 保守回退仅 `rating <= 2` 视为学习中；新后端带 state 则无此问题 |

未发现 P0 级缺陷：评分幂等、OCC 冲突检测、撤销 `expectedLogId` 校验、编辑时填空标记校验（`reviewCardEditFields` 有测试）等关键路径均有防护。

## 五、前 8 优化建议

1. **调度设置迁出统计页**（修 B1/B2）：独立设置区或 Today 页齿轮入口，且不依赖 stats 加载成功；同步修订 guide 13 Q6。
2. **上报作答用时**：翻面→评分计时随 `fsrs_rate` 上报，统计屏补"平均作答时长/总学习时长"。
3. **多级撤销**：`lastReview` 单槽改会话内评分栈（后端 `fsrs_undo_last_review` 已按 `expectedLogId` 校验，栈式回退天然兼容）。
4. **牌组或标签组调度**：最小可行版：按标签组设新卡/复习限额 + 按标签发起会话（G1/G5 可共用此入口）。
5. **leech 检测**：同卡连续/累计"重来"超阈值时提示改写卡面或建议暂停。
6. **FSRS 参数优化**：基于 `fsrs_review_logs` 的 optimizer（可后台跑），对齐新版 Anki 核心卖点。
7. **卡片信息面板**：库详情展开处加 S/D/R 与复习历史时间线（数据已在 review log 里）。
8. **库内 .apkg 导入/导出直达**：复用现有制卡管线命令，减少"绕道对话"的操作链。

## 六、优先级汇总

- **P0**：无。
- **P1**：B1 设置可发现性 + 文档漂移；B2 设置与统计耦合；G3 用时不上报；G1 无牌组级限额；G2 单级撤销。
- **P2**：B3/B4/B5；G4 leech；G5 自定义学习；G6 参数优化；G7 卡片信息；G8 兄弟卡埋藏；G9 库内导入导出；G10 回收站；预测间隔预取；批量"全选筛选结果"。
