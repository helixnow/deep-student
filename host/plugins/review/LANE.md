# L15-review-analytics：复习与学习分析

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L15-review-analytics（复习与学习分析） |
| 目录 | `host/plugins/review/` |
| Rust 范围（lanes.md） | fsrs_review_service、review_plan、mastery、insight、essay_grading、dstu-learning |
| 主要提供 | `review@1`、`mastery@1`、`reviewPlan@1` |
| 主要消费 | F7 fsrs、L14 |
| 特别注意 | FSRS 数值逐项对照 |
| 规模（本目录） | 16542 行 · 19 个文件 · 70 个命令（前端调用 53） · 128 个测试 |
| 规模（整条 lane，inventory） | 16542 行 · 19 个文件 · 70 个命令（前端 53） · 128 个测试 |
| 契约 | [`contracts/ipc/L15-review-analytics.json`](../../../contracts/ipc/L15-review-analytics.json) |
| 服务草稿 | [`contracts/services/DRAFT-L15-review-analytics.md`](../../../contracts/services/DRAFT-L15-review-analytics.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs` | 10247 | 73 |  |
| `src-tauri/crates/dstu-learning/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-learning/src/fsrs_scheduler.rs` | 831 | 19 |  |
| `src-tauri/crates/dstu-learning/src/lib.rs` | 20 | 0 |  |
| `src-tauri/crates/dstu-learning/src/mastery/bias.rs` | 211 | 7 |  |
| `src-tauri/crates/dstu-learning/src/mastery/mod.rs` | 32 | 0 | 1 |
| `src-tauri/crates/dstu-learning/src/mastery/profile_sink.rs` | 77 | 0 |  |
| `src-tauri/crates/dstu-learning/src/mastery/service.rs` | 987 | 0 |  |
| `src-tauri/crates/dstu-learning/src/mastery/types.rs` | 149 | 0 |  |
| `src-tauri/crates/dstu-learning/src/study_loop/media_source.rs` | 347 | 8 |  |
| `src-tauri/crates/dstu-learning/src/study_loop/mod.rs` | 8 | 0 |  |
| `src-tauri/crates/dstu-learning/src/study_loop/study_time.rs` | 271 | 4 | 2 |
| `src-tauri/crates/dstu-qbank/src/review_plan_service.rs` | 976 | 0 | 17 |
| `src-tauri/src/cmd/fsrs_review.rs` | 730 | 4 | 17 |
| `src-tauri/src/essay_grading/mod.rs` | 225 | 0 | 20 |
| `src-tauri/src/fsrs_review_service/tests.rs` | 281 | 1 |  |
| `src-tauri/src/insight/handlers.rs` | 154 | 0 | 13 |
| `src-tauri/src/mastery/service/tests.rs` | 819 | 10 |  |
| `src-tauri/src/review_plan_service/tests.rs` | 159 | 2 |  |

### 命令（70）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `essay_grading_create_custom_mode` | `src/essay_grading/mod.rs:157` | async | app | src/essay-grading/essayGradingApi.ts:336 | (input: CreateModeInput) → GradingMode ! AppError |
| `essay_grading_create_session` | `src/essay_grading/mod.rs:37` | async | app | src/essay-grading/essayGradingApi.ts:99 | (title: string, essayType: string, gradeLevel: string, customPrompt?: string \| null) → VfsEssaySession ! AppError |
| `essay_grading_delete_custom_mode` | `src/essay_grading/mod.rs:175` | async | app | src/essay-grading/essayGradingApi.ts:358 | (modeId: string) → null ! AppError |
| `essay_grading_delete_session` | `src/essay_grading/mod.rs:79` | async | app | src/essay-grading/essayGradingApi.ts:151 | (sessionId: string) → integer(usize) ! AppError |
| `essay_grading_get_latest_round_number` | `src/essay_grading/mod.rs:127` | async | app | src/essay-grading/essayGradingApi.ts:219 | (sessionId: string) → integer(i32) ! AppError |
| `essay_grading_get_mode` | `src/essay_grading/mod.rs:144` | async | app | src/essay-grading/essayGradingApi.ts:306 | (modeId: string) → GradingMode \| null ! AppError |
| `essay_grading_get_models` | `src/essay_grading/mod.rs:219` | async | app | src/essay-grading/essayGradingApi.ts:431 | (（无）) → ModelInfo[] ! AppError |
| `essay_grading_get_modes` | `src/essay_grading/mod.rs:136` | async | app | src/essay-grading/essayGradingApi.ts:293 | (（无）) → GradingMode[] ! AppError |
| `essay_grading_get_round` | `src/essay_grading/mod.rs:117` | async | app | src/essay-grading/essayGradingApi.ts:205 | (sessionId: string, roundNumber: integer(i32)) → GradingRoundResponse \| null ! AppError |
| `essay_grading_get_rounds` | `src/essay_grading/mod.rs:108` | async | app | src/essay-grading/essayGradingApi.ts:191 | (sessionId: string) → GradingRoundResponse[] ! AppError |
| `essay_grading_get_session` | `src/essay_grading/mod.rs:56` | async | app | src/essay-grading/essayGradingApi.ts:115 | (sessionId: string) → VfsEssaySession \| null ! AppError |
| `essay_grading_has_builtin_override` | `src/essay_grading/mod.rs:210` | async | app | src/essay-grading/essayGradingApi.ts:411 | (builtinId: string) → boolean ! AppError |
| `essay_grading_list_custom_modes` | `src/essay_grading/mod.rs:184` | async | app | src/essay-grading/essayGradingApi.ts:369 | (（无）) → GradingMode[] ! AppError |
| `essay_grading_list_sessions` | `src/essay_grading/mod.rs:88` | async | app | src/essay-grading/essayGradingApi.ts:165 | (offset?: integer(u32) \| null, limit?: integer(u32) \| null, query?: string \| null) → VfsEssaySession[] ! AppError |
| `essay_grading_reset_builtin_mode` | `src/essay_grading/mod.rs:201` | async | app | src/essay-grading/essayGradingApi.ts:400 | (builtinId: string) → GradingMode ! AppError |
| `essay_grading_save_builtin_override` | `src/essay_grading/mod.rs:192` | async | app | src/essay-grading/essayGradingApi.ts:389 | (input: SaveBuiltinOverrideInput) → GradingMode ! AppError |
| `essay_grading_stream` | `src/essay_grading/mod.rs:27` | async | app | src/essay-grading/useEssayGradingStream.ts:403 | (request: GradingRequest) → GradingResponse \| null ! AppError |
| `essay_grading_toggle_favorite` | `src/essay_grading/mod.rs:99` | async | app | src/essay-grading/essayGradingApi.ts:180 | (sessionId: string) → boolean ! AppError |
| `essay_grading_update_custom_mode` | `src/essay_grading/mod.rs:166` | async | app | src/essay-grading/essayGradingApi.ts:347 | (input: UpdateModeInput) → GradingMode ! AppError |
| `essay_grading_update_session` | `src/essay_grading/mod.rs:68` | async | app | src/essay-grading/essayGradingApi.ts:131 | (session: VfsUpdateEssaySessionParams) → null ! AppError |
| `fsrs_bury_card` | `src/cmd/fsrs_review.rs:470` | async | none | — | (cardStateId: string) → FsrsBuryResult ! AppError |
| `fsrs_enqueue_cards` | `src/cmd/fsrs_review.rs:107` | async | app | src/features/flashcards/store/fsrsReviewStore.ts:569<br>src/features/mindmap/utils/saveReciteMissCards.ts:44<br>src/utils/chatApi.ts:160 | (ankiCardIds: string[]) → FsrsEnqueueResult ! AppError |
| `fsrs_get_card_memory_history` | `src/cmd/fsrs_review.rs:544` | async | app | src/features/flashcards/memoryCurve.ts:382 | (cardStateId: string) → FsrsCardMemoryHistory ! AppError |
| `fsrs_get_due` | `src/cmd/fsrs_review.rs:129` | async | app | src/features/flashcards/components/FsrsParamsPanel.tsx:100<br>src/features/flashcards/store/fsrsReviewStore.ts:452<br>src/quick-assistant/service.ts:318 | (limit?: integer(u32) \| null) → FsrsDueCard[] ! AppError |
| `fsrs_get_memory_overview` | `src/cmd/fsrs_review.rs:533` | async | app | src/features/flashcards/memoryCurve.ts:376 | (recentLimit?: integer(u32) \| null) → FsrsMemoryOverview ! AppError |
| `fsrs_get_review_statistics` | `src/cmd/fsrs_review.rs:523` | async | app | src/features/flashcards/components/RetentionInsightsPanel.tsx:134<br>src/features/flashcards/hooks/useReviewActivity.ts:175 | (days?: integer(u32) \| null) → FsrsReviewStatistics ! AppError |
| `fsrs_get_scheduler_config` | `src/cmd/fsrs_review.rs:555` | async | app | src/features/flashcards/components/FsrsOptimizerPanel.tsx:45<br>src/features/flashcards/components/SchedulerSettingsSection.tsx:106 | (（无）) → FsrsSchedulerConfig ! AppError |
| `fsrs_get_stats` | `src/cmd/fsrs_review.rs:515` | async | app | src/features/flashcards/screens/TodayScreen.tsx:146<br>src/features/flashcards/store/fsrsReviewStore.ts:499<br>src/features/learning-today/todayLearning.ts:42<br>…共 5 处 | (（无）) → FsrsStats ! AppError |
| `fsrs_optimize_parameters` | `src/cmd/fsrs_review.rs:572` | async | app | src/features/flashcards/components/FsrsOptimizerPanel.tsx:54 | (（无）) → FsrsOptimizeResult ! AppError |
| `fsrs_preview_intervals` | `src/cmd/fsrs_review.rs:237` | async | app | src/features/flashcards/store/fsrsReviewStore.ts:1334 | (cardStateId: string) → FsrsPreviewResult ! AppError |
| `fsrs_rate` | `src/cmd/fsrs_review.rs:250` | async | app | src/features/flashcards/store/fsrsReviewStore.ts:1386<br>src/quick-assistant/service.ts:329 | (cardStateId: string, rating: integer(u8), durationMs?: integer(i64) \| null, clientOpId?: string \| null, enforceExpectedLastReview?: boolean \| null, expectedLastReviewMs?: integer(i64) \| null) → FsrsRateResult ! AppError |
| `fsrs_reset_card_progress` | `src/cmd/fsrs_review.rs:595` | async | app | src/utils/chatApi.ts:231 | (cardStateId: string) → FsrsResetResult ! AppError |
| `fsrs_suspend_card` | `src/cmd/fsrs_review.rs:455` | async | app | src/utils/chatApi.ts:164 | (cardStateId: string) → FsrsSuspendResult ! AppError |
| `fsrs_unbury_card` | `src/cmd/fsrs_review.rs:485` | async | none | — | (cardStateId: string) → FsrsBuryResult ! AppError |
| `fsrs_undo_last_review` | `src/cmd/fsrs_review.rs:415` | async | app | src/features/flashcards/store/fsrsReviewStore.ts:1640<br>src/utils/chatApi.ts:175 | (expectedLogId: string, cardStateId: string) → FsrsUndoResult ! AppError |
| `fsrs_unsuspend_card` | `src/cmd/fsrs_review.rs:500` | async | app | src/utils/chatApi.ts:168 | (cardStateId: string) → FsrsSuspendResult ! AppError |
| `fsrs_update_scheduler_config` | `src/cmd/fsrs_review.rs:562` | async | app | src/features/flashcards/components/FsrsOptimizerPanel.tsx:74<br>src/features/flashcards/components/SchedulerSettingsSection.tsx:179 | (update: FsrsSchedulerConfigUpdate) → FsrsSchedulerConfig ! AppError |
| `insight_add_relation` | `src/insight/handlers.rs:125` | async | none | — | (fromId: string, toId: string, relationType: string, scope?: string \| null, evidence?: string \| null) → string ! AppError |
| `insight_confirm` | `src/insight/handlers.rs:31` | async | none | — | (insightId: string, edits?: InsightCorrectInput \| null) → InsightCard ! AppError |
| `insight_correct` | `src/insight/handlers.rs:41` | async | none | — | (insightId: string, input: InsightCorrectInput) → InsightCard ! AppError |
| `insight_create_draft` | `src/insight/handlers.rs:22` | async | none | — | (input: InsightDraftInput) → InsightCard ! AppError |
| `insight_delete` | `src/insight/handlers.rs:51` | async | none | — | (insightId: string) → null ! AppError |
| `insight_get` | `src/insight/handlers.rs:57` | async | none | — | (insightId: string) → InsightCard \| null ! AppError |
| `insight_list` | `src/insight/handlers.rs:66` | async | none | — | (status?: string \| null, limit?: integer(i64) \| null, offset?: integer(i64) \| null) → InsightCard[] ! AppError |
| `insight_list_events` | `src/insight/handlers.rs:104` | async | none | — | (insightId: string, limit?: integer(i64) \| null) → InsightEvent[] ! AppError |
| `insight_list_evidence` | `src/insight/handlers.rs:88` | async | none | — | (insightId: string) → InsightEvidence[] ! AppError |
| `insight_list_relations` | `src/insight/handlers.rs:96` | async | none | — | (insightId: string) → InsightRelation[] ! AppError |
| `insight_list_revisions` | `src/insight/handlers.rs:80` | async | none | — | (insightId: string) → InsightRevision[] ! AppError |
| `insight_record_feedback` | `src/insight/handlers.rs:114` | async | none | — | (insightId: string, feedback: string, sessionId?: string \| null) → null ! AppError |
| `insight_run_jobs` | `src/insight/handlers.rs:144` | async | none | — | (batchSize?: integer(u32) \| null) → integer(u32) ! AppError |
| `mastery_get_overview` | `crates/dstu-learning/src/mastery/mod.rs:23` | async | app | src/components/dashboard/WeakConceptsStrip.tsx:17 | (limit?: integer(u32) \| null) → MasteryOverviewSummary ! string |
| `review_plan_batch_create` | `crates/dstu-qbank/src/review_plan_service.rs:908` | async | app | src/stores/reviewPlanStore.ts:466 | (questionIds: string[], examId: string) → BatchCreateResult ! string |
| `review_plan_create` | `crates/dstu-qbank/src/review_plan_service.rs:762` | async | app | src/stores/reviewPlanStore.ts:444 | (questionId: string, examId: string) → ReviewPlan ! string |
| `review_plan_create_for_exam` | `crates/dstu-qbank/src/review_plan_service.rs:921` | async | app | src/stores/reviewPlanStore.ts:487 | (examId: string) → BatchCreateResult ! string |
| `review_plan_delete` | `crates/dstu-qbank/src/review_plan_service.rs:885` | async | app | src/stores/reviewPlanStore.ts:506 | (planId: string) → null ! string |
| `review_plan_get` | `crates/dstu-qbank/src/review_plan_service.rs:855` | async | none | — | (planId: string) → ReviewPlan \| null ! string |
| `review_plan_get_by_question` | `crates/dstu-qbank/src/review_plan_service.rs:843` | async | app | src/stores/reviewPlanStore.ts:567 | (questionId: string) → ReviewPlan \| null ! string |
| `review_plan_get_calendar_data` | `crates/dstu-qbank/src/review_plan_service.rs:960` | async | app | src/stores/reviewPlanStore.ts:783 | (startDate?: string \| null, endDate?: string \| null, examId?: string \| null) → CalendarHeatmapData[] ! string |
| `review_plan_get_due` | `crates/dstu-qbank/src/review_plan_service.rs:794` | async | app | src/features/learning-today/dueMistakesReview.ts:53<br>src/stores/reviewPlanStore.ts:325 | (examId?: string \| null, untilDate?: string \| null) → DueReviewsResult ! string |
| `review_plan_get_due_with_filter` | `crates/dstu-qbank/src/review_plan_service.rs:807` | async | app | src/stores/reviewPlanStore.ts:352 | (filter: DueReviewsFilter) → DueReviewsResult ! string |
| `review_plan_get_history` | `crates/dstu-qbank/src/review_plan_service.rs:895` | async | app | src/stores/reviewPlanStore.ts:608 | (planId: string, limit?: integer(u32) \| null) → ReviewHistory[] ! string |
| `review_plan_get_or_create` | `crates/dstu-qbank/src/review_plan_service.rs:947` | async | app | src/stores/reviewPlanStore.ts:554 | (questionId: string, examId: string) → ReviewPlan ! string |
| `review_plan_get_stats` | `crates/dstu-qbank/src/review_plan_service.rs:819` | async | app | src/features/learning-hub/apps/views/useExamDueReviewCount.ts:22<br>src/features/learning-today/todayLearning.ts:43<br>src/stores/reviewPlanStore.ts:380 | (examId?: string \| null) → ReviewStats ! string |
| `review_plan_list_by_exam` | `crates/dstu-qbank/src/review_plan_service.rs:933` | async | app | src/stores/reviewPlanStore.ts:415 | (examId: string, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → DueReviewsResult ! string |
| `review_plan_process` | `crates/dstu-qbank/src/review_plan_service.rs:775` | async | app | src/stores/reviewPlanStore.ts:584 | (planId: string, quality: integer(u8), userAnswer?: string \| null, timeSpentSeconds?: integer(u32) \| null) → ProcessReviewResult ! string |
| `review_plan_refresh_stats` | `crates/dstu-qbank/src/review_plan_service.rs:831` | async | app | src/stores/reviewPlanStore.ts:394 | (examId?: string \| null) → ReviewStats ! string |
| `review_plan_resume` | `crates/dstu-qbank/src/review_plan_service.rs:875` | async | app | src/stores/reviewPlanStore.ts:536 | (planId: string) → ReviewPlan ! string |
| `review_plan_suspend` | `crates/dstu-qbank/src/review_plan_service.rs:865` | async | app | src/stores/reviewPlanStore.ts:520 | (planId: string) → ReviewPlan ! string |
| `study_time_add` | `crates/dstu-learning/src/study_loop/study_time.rs:116` | async | app | src/features/study-time/studyTimeTracker.ts:35 | (seconds: integer(i64), date?: string \| null) → StudyTimeDay ! AppError |
| `study_time_range` | `crates/dstu-learning/src/study_loop/study_time.rs:147` | async | none | — | (from: string, to: string) → StudyTimeDay[] ! AppError |

### 发出的事件（1）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `fsrs://changed` | 字面量 | crates/dstu-anki/src/fsrs_review_service.rs:5496 (emit)<br>src/cmd/fsrs_review.rs:101 (emit)<br>src/cmd/fsrs_review.rs:291 (emit) |

### 契约中的事件（1，`contracts/ipc/L15-review-analytics.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `fsrs://changed` | 否 | object \| Value | crates/dstu-anki/src/fsrs_review_service.rs:5496 (emit)<br>src/cmd/fsrs_review.rs:101 (emit)<br>src/cmd/fsrs_review.rs:291 (emit) |
<!-- END GENERATED:lane -->

## 备注

## v2 接手盘点（2026-11-04，新会话）

基线：原分支 `3690782ca`，已 `git merge --no-edit main`。不重做已有修复；
`95d567a50` 已将 L24 测试注入键改为 `anki`。当前树没有 `ACCEPTANCE.md`，
复核人文件不自行创建或修改；以下 R1–R6 依据协调者注入的复核原文，不表示签收。
旧 SPEC 勾选与 ledger 是机械状态，不是 v2 逐分支验收结论。

### 八类自查（相同入口的命令归组列出；证据为接手时行号）

| 命令/模块 | §1.1 接线 | §1.2 所有权 | §1.3 数据边界 | §1.4 日志/错误 | §1.5 测试 | §1.6 分支 | §1.7 运行时 | §1.8 闭环 |
|---|---|---|---|---|---|---|---|---|
| `fsrs_enqueue_cards` / `fsrs_get_due` / `fsrs_get_stats` / `fsrs_preview_intervals` | `src/commands.ts:261-279,362` | FSRS/deck 写入在 `repository/fsrs.ts:72,259`，卡片/任务只读 | `repository/fsrs.ts:98-100` 的 null 键回退、浮点转整数与 Rust Value 不符（V2-S2） | `src/commands.ts:33-169` 保留 debug/warn 与补偿 | Host invoke 与 service 测试存在；不能代表所有分支 | `src/review.ts:118-155` 队列路径存在 | deferred/immediate 由 `src/review-runtime.ts` 实现；无新增取消 | R2/R3/R4 待消费端签收 |
| `fsrs_rate` | `src/commands.ts:281` | `repository/fsrs.ts:406,434` 写 state/log | `src/review-input.ts:10-19` UUID 正则接受混合格式（V2-S3）；快照后续读取见下 | `src/commands.ts:178-240` 提交后重试/告警 | `tests/fsrs-commands.test.ts:66-105` 真入口 | CAS、重放、诊断卡路径 `src/review.ts:200-320` | commit 后掌握度补偿；时钟用 `utcNow` | 未获复核签收 |
| `fsrs_undo_last_review` | `src/commands.ts:305` | 仅 FSRS state/log | `src/review.ts:389` 无解码断言（V2-S1），旧快照 serde 默认丢失 | `Validation`/`Conflict` 分流存在，但错误类型字段可导致 panic | 原测试有损坏字符串，缺合法 JSON 非法结构回归 | `src/review.ts:365-406` | immediate 原子恢复 | V2-S1 必须补生产入口测试 |
| `fsrs_suspend_card` / `fsrs_unsuspend_card` / `fsrs_bury_card` / `fsrs_unbury_card` / `fsrs_reset_card_progress` | `src/commands.ts:326-359,382` | 仅 FSRS state/log | IPC 由 kernel 解码，state 行 `repository/fsrs.ts:47-69` | 服务抛 `CommandError`；reset info `src/review-memory.ts:41` | `tests/fsrs-review.test.ts` + Host 命令测试 | 幂等、缺失、更新冲突均有实现 | immediate；埋藏为逻辑日墙钟 | R6 仅有候选运行证据 |
| `fsrs_get_review_statistics` / `fsrs_get_memory_overview` / `fsrs_get_card_memory_history` | `src/commands.ts:368-375` | 只读 | `repository/fsrs.ts:36-44` map 部分字段过滤不等于 serde 整体失败（并入 V2-S1） | 错误前缀在仓储；无新增日志 | 原聚合测试存在，不据此宣称数值差分 | `src/review-statistics.ts` 实现 | 单次墙钟；只读 SQL | 尚未 v2 独立签收 |
| `fsrs_get_scheduler_config` / `fsrs_update_scheduler_config` | `src/commands.ts:377-380` | `anki_decks` 调度配置由 L15 拥有 | R1 的 17 个 null 更新已修；读取侧 V2-S2 仍须修 | 损坏配置 warn `repository/fsrs.ts:91-94` | `tests/fsrs-commands.test.ts:125-153` 真 invoke | 17 字段校验与更新存在 | immediate 更新/重算；未知键保留 | R1 保留未签收 |
| `fsrs_optimize_parameters` | **未注册** `index.ts:144-169` | 未来只写 deck/state | F7 无精确训练 provider | 不返回假优化值 | 两条 optimizer 保持 pending | `src/review-memory.ts:141-175` 仅不足量分支 | 不自行安装/编译原生模块 | R5 外部阻塞，见 BLOCKERS |
| `review_plan_create` / `process` / `get_due` / `get_due_with_filter` / `get_stats` / `refresh_stats` / `get_by_question` / `get` / `suspend` / `resume` / `delete` / `get_history` / `batch_create` / `create_for_exam` / `list_by_exam` / `get_or_create` / `get_calendar_data`（后 16 项同 `review_plan_` 前缀） | `src/review-plan-commands.ts:51-105`；服务 `index.ts:115-139` | 经 L11 `vfsRepo`，无复制生产 SQL | IPC kernel；跨服务 DTO 依赖 L11 | `wrap` 转纯字符串；logger 注入 `:21-22` | 命令测试真实，仓储仍用 L11 替身；不证明 L11 实现 | 现有 SPEC 未列完整 v2 Rust→TS 分支表，不把旧勾选当签收 | 同事务传 conn；SM2 Date/时间待按源继续审读 | `reviewPlan` 已发布，消费者完整链仍须复核 |
| `mastery_get_overview` / `mastery` 全公开方法 | `index.ts:174,181-187`；`src/mastery.ts:30` | 仅 `mastery_events`/`mastery_states`；profile 经 L17 sink | SQL 类型与参数按 Rust；无持久化 JSON | `src/mastery.ts:44,83,114,123` info/warn 存在 | e2e sink 仍是替身，不能证明真实 profile 链 | EMA/补偿/改判已有，不重写 | immediate 与 WithConn；墙钟纳秒反刷分 | 等独立复核，不声称已通过 v2 |
| `study_time_add` / `study_time_range` / studyTime 公开函数 | `index.ts:188-189`；`api.ts:27` | 仅 `study_time_daily` | IPC kernel + 日期校验 `src/study-time.ts` | AppError 映射存在 | `tests/study-time.test.ts` 真 invoke/SQLite | inclusive range、上限、日期校验已测 | Rust 墙钟对应 `utcNow`；无 Drop 资源 | 未独立签收 |
| `essay_grading_stream` / `create_session` / `get_session` / `update_session` / `delete_session` / `list_sessions` / `toggle_favorite` / `get_rounds` / `get_round` / `get_latest_round_number` / `get_modes` / `get_mode` / `create_custom_mode` / `update_custom_mode` / `delete_custom_mode` / `list_custom_modes` / `save_builtin_override` / `reset_builtin_mode` / `has_builtin_override` / `get_models`（均 `essay_grading_` 前缀） | `src/essay-grading-commands.ts:38-104` → L02 `essayGrading` | 不写表，L02/L11 所有 | kernel 契约，Option→null | 服务缺失 Database；服务错误依赖 L02 公共契约 | 委托测试仅证明 L15 命令包装，不是批改业务验收 | 本 lane Rust 薄包装；不复制 L02 | stream signal/emitTo 转发；其他命令不额外取消 | 等消费链复核 |
| `insight_create_draft` / `confirm` / `correct` / `delete` / `get` / `list` / `list_revisions` / `list_evidence` / `list_relations` / `list_events` / `record_feedback` / `add_relation` / `run_jobs`（均 `insight_` 前缀） | `src/insight-commands.ts:78-127` → L17 `insight` | 不写表 | kernel 契约 | 结构化业务错→CommandError，未知错不吞 `:23-60` | `tests/insight-command-errors.test.ts` 真 invoke；非 L17 业务证明 | 包装默认值 100/0、50、5 已对应 Rust | 等待 async 结果；无多余取消 | 既有修复保留待复核 |
| review scoped snapshots/suspend/undo/enqueue；cleanup/import WithConn | `index.ts:28-99` | 四个事务接缝已提供，L16 main 尚未消费 | 版本 `repository/fsrs.ts:875-888` 经 Number 丢精度（V2-S4）；`buildAgentSnapshot:915-938` 还有较弱副本校验（V2-S1） | damaged/invalid 分流须保留 | R2 仅真实 L24+review，anki/cards 仍是替身 | session/library 面存在，不再称全部缺失 | caller conn 不 begin/commit | R2/R4 真实 L16 待合入 |
| media_source 与 SM2 API 纯函数 | `api.ts:20-27` | media 文件表只读 | 固定正则/参数，不接用户 regex | best-effort 行为须按 Rust，不泛化告警 | 8 media/15 SM2 原测试已有 | 生产公开 API，不把 import 图当实际业务接入 | 无进程/文件句柄清理；时间按 Rust | 下游调用链不由本 lane 代签 |

### 处理顺序与复核未勾选项

1. R1：保留已通过的真实 Host invoke 17-null 测试；不重做 null 修复。
2. R2：先复现门禁，现 L24 测试通过；只证明 review 快照消费，不称真实 Anki ownership/CAS 已闭合。
3. R3：保留 121 ported / 7 pending；四镜像 + legacy-null agent page 必须待真实 L16 接口，禁止用绿镜像改账。
4. R4：保留调用方事务接口；需 L16 删除/导入消费并证明同事务提交/回滚。
5. R5：精确 F7 6.6.2 + card_ids + evaluate 未提供，不注册优化命令。
6. R6：本次 job `20261104093240-79a20b` 为 169 passed / **Errors 1**（RPC onTaskUpdate timeout）/ **exit 1**；不删 Errors 行，不称绿。类型检查 `20261104093240-7db748` 与 boundaries `20261104093240-b71ec0` 均 exit 0。后续限制测试 worker 重新运行，不改断言。
   - 更新：根因为每用例重放 mistakes 迁移约 3s；`tests/storage.ts` 改为每文件迁移一次模板库再复制（检查点 `1bb0af9ec`，收尾 `dbf5cf87a`）。job `20261104113541-7ec1fd`：17 files / 170 passed、无 Errors、exit 0（207s→38.6s）；typecheck `b3a8ec`、boundaries `17a4d6` exit 0。门禁绿不等于 R 项签收。
7. 自查排雷：V2-S1（快照 serde/重复弱校验/map）、V2-S2（配置 Value 读取）、V2-S3（UUID 严格格式）、V2-S4（CAS 大整数）；先写生产入口回归，再改实现与 SPEC。
   - V2-S1 `9fc6cee86`：`decodeStateBeforeSnapshot` 严格解码 + 旧快照 serde 默认（修复旧快照撤销 `SQL parameter #19 is undefined`）；测试 `v2_s1_*`。`d9e7a5655` 补齐 map 整体失败→空，而非逐项过滤；测试 `v2_s1_due_card_json_fields_fail_whole_like_serde_not_per_entry`。已知差异：快照 JSON 重复键不检测，i64 快照时间戳仍受安全数范围限制（未闭合，不等同本次 CAS 版本修复）。
   - V2-S2 `553b2dfab`：`src/serde-json.ts` + `loadSchedulerConfig` 按 Value 访问器；测试 `v2_s2_scheduler_config_reads_json_like_serde_value_accessors`。`d9e7a5655` 依 dstu-anki 的 `arbitrary_precision` 实际特性修正 `-0`/`1e400`：Value 的 -0→0，1e400 可解析但 as_f64=None；typed struct 数字规则独立。
   - V2-S3 `23da6c01e`：clientOpId 按 uuid 1.20 `try_parse` 形状；测试 `v2_s3_fsrs_rate_client_op_id_accepts_only_uuid_parse_str_shapes`。
   - V2-S4/D3：`227d44de4` 按 MAX_SAFE 拒绝合法 i64 是错误设计，C1 P0 要求纠正。现在 owner 快照 `reviewVersion: bigint`，四个 CAS 输入 `number | bigint`，比较/SQL 绑定均 bigint，SQLite 递增；仅 kernel 最外 `toWireJson` 转 number。真实 provider 测试 `tests/agent-review-version.test.ts`（5 例）覆盖 `9007199254740993n`、`9223372036854774784n`、i64::MAX 的读/相邻 stale CAS、暂停/撤销、事务回滚，未降低 L24 原大数范围。现有小版本断言按同一 Rust i64 值改为 bigint（0→0n，1→1n 等），wire 数字断言保留。
8. 真实外部阻塞精确记录在 `BLOCKERS.md`；原有 `native-needs.md` 历史证据保留，未合入分支不算解除。

### C2 稳定 ID 映射（冻结报告 0119143715c0，源码基线 2ee9a9cbe）

不重编号；main 合入后独立复验前不算完成。

| C2 ID | 位置（基线） | 映射 | 状态 |
|---|---|---|---|
| X6-UD-0068 | repository/fsrs.ts:920 buildAgentSnapshot | V2-S1 | `9fc6cee86` 改为 `decodeStateBeforeSnapshot` + 完整 `validateSnapshotFor`，删弱副本 |
| X6-UD-0069 | src/review-memory.ts:116 | V2-S1 | `9fc6cee86` |
| X6-UD-0070 | src/review.ts:388 undoLastReview | V2-S1 | `9fc6cee86`，测试 `v2_s1_*` |
| X6-UD-0071 | src/review.ts:564 Agent undo | V2-S1 | `9fc6cee86`，测试 `v2_s1_*` |
| X6-LP-0244 | fsrs_review_service.rs warn! 1 | config_json 解析告警 | 已存在：`loadSchedulerConfig` 经注入 `warn` 回调，计数口径未识别；文案由 `v2_s2_*` 断言 |
| X6-LP-0245 | mastery/service.rs warn! 3 | 回流失败告警 | `0edd575cd`：补 `[Mastery]` 前缀与 log/submission id；测试 `x6_lp_0245_*` |
| X6-LP-0246 | review_plan_service.rs warn! 2 | review-plan 告警 | 已存在：`src/review-plan.ts:295,438` 经注入回调，文案一致 |
| X6-LP-0247 | cmd/fsrs_review.rs warn! 14 | 命令补偿告警 | `0edd575cd`：补 4 条专用文案 + 2 条 debug；`5d26d1222`：fsrs_get_due 的 revert/补偿写入失败恢复 Rust 静默（:149/:158），query/tag/confirm 原 warn 保留；测试 `x6_lp_0247_*`（2 例） |
| X6-LP-0248 | 插件合计 | 0244–0247 汇总 | 同上 |
| X6-AP-0384 / 0397 | tests/mastery.test.ts:68 | qbank 纠错 false→true | 人工候选，待逐条对照 Rust 断言；不机械补 expect |
| X6-AP-0398 / 0399 | tests/mastery.test.ts:83 / :32 | qbank 纠错幂等 / 远端墓碑 | 人工候选，待核 |
| X6-AP-0390 / 0391 / 0393 | tests/fsrs-review.test.ts:602 / 748 / 1123 | enqueue 事件、诊断卡评分、模板元数据 | 人工候选，待核 |
| X6-AP-0392 / 0394 | tests/fsrs-cross-domain.test.ts:182 / 434 | 软删任务、legacy-null（R3 相关） | 人工候选；0394 与 R3 pending 行一起，等真实 L16 |
| X6-AP-0395 | tests/study-time.test.ts:32 | 校验拒绝 | 人工候选，待核 |
| X6-AP-0396 | tests/fsrs-events.test.ts:59 | enqueue changed 负载 | 人工候选，待核 |

### C1 单次 SW 增量：anki_decks（1c8239f67 / main 4525e11ac）

- `repository/fsrs.ts` 的 ensure-default INSERT / config UPDATE 已改用 L16 `474e38f29`
  的公开函数；原 tx/conn、try/catch、JSON.stringify 位置不变，无本地写 SQL/fallback。
  L16 接口已随 5b1b19055 进 main，44c08e870 重新应用。详见 BLOCKERS。
- 生产命令回归已预置：`tests/deck-owner-transaction.test.ts`，job
  `20261104154906-6d546b` **3 passed / exit 0**，覆盖默认字段、原事务回滚、原错误前缀、
  已有字段/SQL 精确版本/deleted 过滤。该结果只是原行为基线，**不证明 owner 接线已修**。
- 沿原稳定 ID/两写点身份记录，不因新数组重新编号；不扩大扫描范围或重跑旧失败。

### 接管进度（2026-11-05）

- **P0 D3 CAS**：分支已含 a0515bf75（owner 内部 `reviewVersion` 为 bigint，CAS 入参
  number|bigint 归一到 bigint 按 0..=i64::MAX 校验，比较/绑定精确，只在 IPC wire 转 number）。
  77c4bef2a 依赖未进 main 的 L16 `474e38f29`，在 main 基线上使 review 90 条测试失败，
  已由 84f328310 revert（L16 接口进 main 后原样重新应用，见 BLOCKERS）。
  lane-gate `84f328310` 全部通过（基线 main 677f6727c）。
- main 上 `chatanki/tests/review-executor-real-l15.test.ts` 仍断言快照为 number，
  与 D3 内部 bigint 不符；L24 分支 `a61798e9f` 已改为 bigint 精确断言 + wire number 投影。
  临时组合（本分支 + L24 分支）实测该文件 4 passed、`l24-review-state-consumer` 1 passed
  （job 20261104161159-6893df）。两分支都集成后 main 闭环。
- `fsrs_optimize_parameters`：F7 `nativeFsrs.optimize/evaluate` 已进 main；已注册并声明，两条 Rust 测试经 host.invoke 走真实引擎（`tests/fsrs-optimize.test.ts`）。

### WP-159：insight_list 精确分页消费

- 开工正常 merge main `b17264b88`，已核 `memory/api.ts` 重导出的
  `InsightCommandService.listInsights(status, limit: IpcInteger, offset: IpcInteger)`；
  WP-158/9f5a99787、F1 argsJson/IpcInteger 与 F3 bigint 已可消费，无供方缺失。
- `ListArgs` 仅将 limit/offset 对齐公开 IpcInteger；原 handler 直接转发及100/0默认值正确。
- 保留158六例供方回归，新增 `tests/insight-pagination-inbound.test.ts` 三例补原文命令到真实SQLite绑定/错误证据；详见 SPEC 的 WP-159 分支表。
- TESTMAP 实际123 ported/5 pending不变；本包不重映射、不给其他精度路径或GUI/A/C签收。
