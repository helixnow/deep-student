# L15 原生能力与跨 lane 依赖

本文件记录 TS 迁移无法在本 lane 内独立完成、需要平台或其他 lane 提供的能力。
迁移原则：能用纯 TS / SQLite 精确复刻的都在 `host/plugins/review` 内实现；无法精确
复刻的保持命令未注册，并在最终报告中列为 blocker，而不是用 mock / stub 顶替。

## 1. `fsrs_optimize_parameters`（原生训练器）

- Rust 实现：`FsrsReviewService::optimize_parameters` 调用 `fsrs-rs` 训练器
  （`fsrs::FSRS::compute_parameters` / 训练数据集构造），训练完成后写回
  `anki_decks.config_json.fsrs_params`，按新参数重算全部记忆状态，并返回
  `FsrsOptimizeResult`。
- 架构师裁定（2026-11-05）：F7 把 fsrs 6.6.2 的 `compute_parameters` 与 `evaluate`
  编进 WASI 引擎，发布为 `nativeFsrs.optimize` / `nativeFsrs.evaluate`。
- TS 现状（命令层与服务已按 Rust 写好，未注册）：
  - `src/fsrs-trainer.ts`：端口 `FsrsTrainer` 与探测 `resolveFsrsTrainer()`。
  - `src/review-memory.ts::optimizeParameters(rt, trainer)`：training_items、
    MIN_TRAINING_ITEMS=8、evaluate 闭包（FSRS::new/evaluate 的 Err → None，非有限 → None）、
    f32 `log_loss + 1e-6 <` 比较、Immediate 事务内 patch config_json（arbitrary_precision 原样数字，
    `fsrs_params` 按 ryu f32 文本）、按新参数重算记忆状态。
  - `src/commands.ts::fsrsOptimizeParameters`：无进度、不可取消（Rust 未传 progress，
    spawn_blocking 不可中止）；AppError 透传；其它拒绝 → Unknown
    `FSRS 参数优化任务异常: …`；`recomputedCards > 0` 时 emit `fsrs://changed`（user/optimize）。
  - `tests/fsrs-optimize.test.ts`：两条 Rust 测试经 `host.invoke` 移植，命令未注册时 skip。
- 2026-11-05 F7 已进 main：`nativeFsrs.optimize(input, {signal})` / `evaluate(params, items)`，
  fsrs-rs Err 抛 `FsrsError`（message = `{:?}`）。L15 已对齐签名并注册命令（不传 signal，同 Rust 不可取消），
  `meta.commands` 已声明，TESTMAP 两条 optimizer 改 ported（`tests/fsrs-optimize.test.ts`，真实引擎）。

## 2. 已接线到其他 lane 服务的命令层

以下 33 条命令在 Rust 中只是薄包装，真正实现在其他 lane 的 crate。TS 侧在
`src/essay-grading-commands.ts` / `src/insight-commands.ts` 按原命令名/参数/默认值/
错误类型注册，并直接使用对方已发布的 `api.ts` 契约：

- `essay_grading_*`（20 条）→ L02 `host/plugins/llm` 发布的 Cordis 服务
  `essayGrading`（`host/plugins/llm/api.ts` 的 `EssayGradingService`）。
- `insight_*`（13 条）→ L17 `host/plugins/memory` 发布的 Cordis 服务 `insight`
  （`host/plugins/memory/api.ts` 的 `InsightCommandService`）。

服务在运行时经 `ctx.get(...)` 解析；未安装时按 Rust 的初始化失败返回
`Database: VFS 数据库未初始化`，不静默降级。`essay_grading_stream` 会把服务 emit
的事件转发到调用窗口，其余命令直接委托。命令层测试
（`tests/foreign-commands.test.ts`）使用与已发布接口同形的测试替身验证参数、默认值
和错误透传，不伪造业务结果。

## 2.1 两条 e2e 测试

`e2e_vfs_mastery_score_biases_due_and_respects_three_day_cap` 与
`e2e_submit_wrong_thrice_lowers_score_and_upserts_weak_point_then_recovers` 已用本
lane 的 `Mastery.recordQbankAnswer`（题库提交写入掌握度的同一生产路径）与
`masteryProfileSink` 测试替身移植，保留对掌握度 EMA、weak_point 回流、FSRS due
偏置与 3 天上限的断言。

## 2.2 未注册命令

仅 `fsrs_optimize_parameters` 仍未注册，原因见第 1 节。由于命令没有生产调用方，
对应两条 Rust 测试在 TESTMAP 中保持 pending：
`optimizer_reports_not_enough_data_for_a_tiny_history`（`not_enough_data` 分支已在
`src/review-memory.ts::optimizeParameters()` 实现并有 TS 用例
`tests/fsrs-review.test.ts`，但按 `docs/dev/electron-migration/quality.md` §三.3
“生产代码未接入时不得标 ported”，命令未注册前保持 pending）与
`optimizer_trains_on_cross_day_history_and_keeps_due_dates`（依赖原生训练器）。

## 3. 已确认可在本 lane 内独立完成的部分

- FSRS 调度器：Anki 学习步 / 重学步 / fuzz / 逻辑日等调度规则在
  `src/fsrs-scheduler.ts`；FSRS-6 记忆模型本身引用 F7 平台模块
  `host/platform/native/fsrs`（`DEFAULT_PARAMETERS`、`effectiveParameters`、
  遗忘曲线、`Fsrs6.memoryState` / `nextStates`），不再手写第二份模型。
- FSRS 服务与仓储：全部 SQL 在本 lane 的 `repository/fsrs.ts` 中实现，测试使用
  真实 mistakes 库与全部 mistakes 迁移。
- 掌握度：EMA、反刷分、verdict 修正、due 偏置、outbox、概览。
- 复习计划（SM-2）：`questions` / `review_plans` 一律经 L11 `vfsRepo` 服务读写，
  本 lane 不持有其 SQL；17 条 `review_plan_*` 命令全部注册，
  测试使用 `tests/vfs-repo-double.ts` 提供 L11 契约替身。
- study_time、media_source。

## 4. 待平台 / 其他 lane 接线的依赖（附证据）

| 目标 | 证据 | 本 lane 现状 |
|---|---|---|
| `vfsRepo`（L11） | 已提供：`host/plugins/vfs-repos/api.ts` 导出 `vfsRepoService = { name: 'vfsRepo' }`，`host/plugins/vfs-repos/index.ts` 以 `super(ctx, 'vfsRepo')` 提供 | 命令层 `src/review-plan-commands.ts:14` 经 `ctx.get('vfsRepo')` 解析；17 条 `review_plan_*` 已接线，缺失时返回 wiring 错误 |
| `masteryProfileSink`（L17 memory） | 已提供：`host/plugins/memory/index.ts:86` `provide('masteryProfileSink', createMasteryProfileSink(service))`；接口由 `host/plugins/memory/src/mastery-sink.ts` 从 `review/api.ts` 导入实现 | `api.ts` 声明扩展点，`src/mastery.ts::syncLearnerProfile` 经 `ctx.get('masteryProfileSink')` 调用；测试使用记录型替身验证调用，缺失时与 Rust 一样 no-op |
| `essayGrading` / `insight` | 已提供：`host/plugins/llm/api.ts` 导出 `EssayGradingService` 并由 `llm/index.ts` `provide('essayGrading')`；`host/plugins/memory/api.ts` 导出 `InsightCommandService` 并由 `memory/index.ts` `provide('insight')` | 命令层已改用上述已发布接口；运行时经 `ctx.get` 解析，缺失时返回 `Database: VFS 数据库未初始化` |
| F4 `host/platform/time` | 已提供：`host/platform/time/api.ts` + `index.ts` | `src/clock.ts` 使用 `now()` / `toRfc3339()`；`src/local-date.ts` 使用 `civilTime()` / `ymd()` |
| F4 `host/platform/util` | 已提供：`host/platform/util/api.ts` + `index.ts` | 生产代码的 Rust `trim` 已全部改为 `rustTrim` / `rustTrimStart` / `rustTrimEnd` |
| F7 `nativeRegex` | 已提供：`host/platform/native/regex/api.ts`，`native.ts` 在运行时 `provide('nativeRegex', …)` | 本 lane 无用户/AI 提供的正则；内部固定正则均为 ASCII / `\p{White_Space}` 常量，语义与 Rust 一致，因此不引入异步 wasm 调用 |

## 5. `review@1` 对外方法（供 L24 chatanki 与 L16 anki）

`api.ts` 的 `ReviewService` 已增补（只增不改）以下与 Rust `FsrsReviewService`
同名同语义的方法，全部由 `index.ts` 的 `Review` 服务委托给生产实现：

- `enqueueCardsForSession(cardIds, sessionId, documentId)`
- `enqueueCardsForLibrary(scope, cards)`
- `getReviewStatesForSession(cardIds, sessionId)`
- `getReviewStatesForLibrary(scope, cardIds)`
- `setSuspendedForSession(cardId, sessionId, expectedReviewVersion, suspended)`
- `setSuspendedForLibrary(scope, cardId, expectedReviewVersion, suspended)`
- `undoLastReviewForSession(cardId, sessionId, expectedReviewVersion, expectedLogId)`
- `undoLastReviewForLibrary(scope, cardId, expectedReviewVersion, expectedLogId)`
- `getReviewStatistics(days)`
- `cleanupCardDeletionInTx(conn, cardIds)` / `cleanupTaskDeletionInTx(conn, taskId)` /
  `cleanupDocumentDeletionInTx(conn, documentId)`
- `enqueueImportedCardsInTx(conn, cards)`（`FsrsImportedCard[]`，返回
  `FsrsImportEnqueueSummary`）

L24 `host/plugins/chatanki/api.ts` 的 `ChatAnkiReviewStateService` /
`SchedulerService` 需要前四项；`chatanki/index.ts::hydrate` 用
`typeof service.getReviewStatesForSession === 'function'` 探测后自动接入。
`tests/l24-review-state-consumer.test.ts` 安装真实 L24 chatanki 插件，经
`chatanki_get_cards` 工具调用消费 `review@1` 的会话快照（卡片仓储仍由测试提供，
因为 L16/chatanki 尚未发布真实卡片仓储实现）。

## 4.1 `mastery@1.recordInsightRecallVerdictWithConn`（供 L17 insight recall）

L17 v2 请求（`host/plugins/memory/BLOCKERS.md` §v2）。对应 Rust
`dstu-research/src/insight/recall.rs:426-448` `record_recall_verdict_to_mastery`：
在调用方连接上 `INSERT OR IGNORE`，`id=me_insight_<insightId>_<sessionId>_<correct|wrong>`，
`concept_key=item_id=insight:<insightId>`，`source='insight'`、`weight=1.0`、
`signal=1.0/0.0`，`created_at=updated_at=now`（调用方传入的 `repo::now_iso()`）。
不 recompute、不回流 profile；失败为 `Database: 写入 mastery 证据失败: <sqlite>`。
SQL 在 `repository/mastery.ts::insertInsightRecallVerdict`，经 `ctx.mastery` 暴露。
测试 `tests/mastery.test.ts::l17_insight_recall_verdict_with_conn_matches_rust_record_recall_verdict_to_mastery`
覆盖字段、幂等、不建 state 与错误前缀。L17 替换 `repository/insight.ts:41-53` 后才算单写者闭合。

## 5.0 `reviewPlan@1`（供 L14 qbank 答题/改判）

`api.ts` 发布 `ReviewPlanPort` 与 `reviewPlanService = { name: 'reviewPlan' }`，
`index.ts` 创建真实 `ReviewPlan` 服务，委托给现有的 `ReviewPlanService`（同一实现
也服务 17 条 `review_plan_*` 命令）：

- `getOrCreatePlan(questionId, examId)`
- `getPlanByQuestion(questionId)`
- `advanceFromPractice(planId)`

`vfsRepo` 在方法调用时经 `ctx.get('vfsRepo')` 解析，缺失时报
`vfsRepo service is not available`；`mastery` 由本插件同一 Cordis 上下文提供。
L14 `host/plugins/qbank/index.ts::gradingHostOf` 已经用
`ctx.get('reviewPlan')` 解析该服务，`tests/review-plan.test.ts` 的
`l14_review_plan_port_resolves_published_service_and_advances_plan` 以同一取值方式
验证创建、按题查询与 `advanceFromPractice`。当前 main 的 L14 手动
`submitAnswer` / `regradeSubmission` 尚未调用该端口（属于 L14 的接入改动）。

## 5.1 R4：L16 单写者接线待办

`cleanup*InTx` / `enqueueImportedCardsInTx` 只接受调用方事务中的
`SqlExecutor`，自身不 begin/commit，保证与 L16 的 `anki_cards` 删除或 APKG
导入同成同败。当前 `host/plugins/anki/repository/anki-cards.ts`
（`deleteCard` / `deleteDocumentTask` / `deleteDocumentSession`）与
`host/plugins/anki/repository/apkg-import.ts` 仍直接 DELETE/INSERT
`fsrs_*` 表；需 L16 在自己的 `db.transaction` 内改调上述方法后，R4 的
“FSRS 表单一业务写入方”才算闭合。本 lane 无法修改 L16 文件，故 R4 保持待接线。
同事务/回滚行为由 `tests/service-transaction-api.test.ts` 覆盖。

## 5.2 R3：跨领域测试已替换与剩余镜像

已替换为真实 L16 插件命令（`createTestHost` 同时安装 `review` 与 `anki`）：
`deletion_paths_and_tombstones_do_not_leave_schedulable_ghosts` 调用
`delete_anki_card` / `delete_document_task` / `delete_document_session`；
`legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue` 调用
`list_anki_library_cards` / `get_anki_library_card_content`，并断言读取侧
`tags` / `images` / `extra_fields` 为空集合（不再只看 total/IDs/non-null；
`enqueue` 结果不作为读取侧替代）。但 Rust 原测试还断言 agent page；main 的
L16 尚无 agent-page 命令，所以该行仍保持 `pending`，待 L16 合并
`listAnkiAgentLibraryCards` 后补 agent page 断言再签收，不以共享 decoder 推测代替。

以下 4 条仍使用 `tests/anki-data-layer.ts` 的测试镜像，TESTMAP 已改为
`pending`，未再声称 ported：
`soft_deleted_card_is_hidden_from_agent_crud_and_fsrs`、
`soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated`、
`chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it`、
`agent_library_delete_conflicts_when_user_rates_after_preflight`。

L16 分支 `784b0471e` 已公开真实卡片仓储 API：
`cards.getCardForSession`、`cards.getCardsForDocumentForSession`、
`cards.insertCard`、`cards.insertCardsForDocument`、
`cards.updateCardIfVersionForSession`、`cards.deleteCardForSession`、
`documents.insertDocumentTask`，并在 `src/service.ts` 的
`createAnkiCards` / `createAnkiDocuments` 中绑定真实 mistakes DB；同时提供
`listAnkiAgentLibraryCards`、`updateAnkiCardIfVersionForLibrary`、
`deleteAnkiCardForLibrary`。但该分支尚未进入 main，本 lane 当前 main 的
`anki` 服务没有 `cards` / `documents` 子仓储，因此这些用例不能改走真实面。
L16 合并后应优先替换能覆盖的镜像；`deleteAnkiCardForLibrary` 已在分支提供，
library CAS 删除不是缺口。

进一步核实：L16 仓库已有 `listCardsForTask`、`getCardsByIds`、
`updateDocumentTaskStatus`、`recoverStuckDocumentTasks`，并通过
`get_task_cards` / `recover_stuck_document_tasks` 等命令或内部服务使用；
此前把它们写成“未提供”不准确。当前缺口只是这些能力尚未全部进入 `anki`
服务的 `cards` / `documents` 公开子仓储，需 L16 正常合并后按真实命令/服务替换
镜像断言，而不是另造平行实现。

`tests/l24-review-state-consumer.test.ts` 安装真实 `review` + `chatanki`，但
`provide: { anki: {} }` 且 cards 为测试对象，只证明真实 review 快照被 L24
读取，不证明真实 Anki 装配、ownership 或 CAS。L16 合并后需改为真实 `anki`
服务并补这三类断言。
