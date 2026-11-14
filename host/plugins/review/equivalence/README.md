# WP-053：FSRS / mastery 前端场景 v0

状态：本地 v0 输入语料；尚未运行 A/B，未计 C。源码审读基线 main `67295bdb5`。
本包固定 **15 条 L15 命令 + 4 条 L16 种子/状态变更命令 = 19 条**，不跨入题库 review-plan 功能组。
所有场景 `seed: "empty"`、`capture: {"events":true,"db":["*"]}`、`normalize: []`。
`expect: "error"` 仅标记输入意图，实际 Rust A 的完整结果才是 oracle。

## 命令来源与分支范围（编写前固定）

Rust 路径以 `src-tauri/` 为根；下面 S = `crates/dstu-anki/src/fsrs_review_service.rs`，
C = `src/cmd/fsrs_review.rs`。契约逐项来自 `contracts/ipc/L15-review-analytics.json`，
L16 种子来自 `contracts/ipc/L16-anki.json`；参考的是实际 `src/` 调用，不以 demo/mock 作为可达证据。

| 命令 | 真实前端文件:行 | Rust 入口 / 业务分支 | 成功、提前返回与错误输入范围 |
|---|---|---|---|
| `fsrs_enqueue_cards` | `src/features/flashcards/store/fsrsReviewStore.ts:569` | C:109；S:1002,1098–1342,1361–1454 | 新卡、已入队、混合/重复、空批；空白 ID、缺失/删除的卡或任务、诊断卡、前后空格造成第二次校验失败；历史 tombstone/损坏行另列种子缺口 |
| `fsrs_get_due` | `src/features/flashcards/store/fsrsReviewStore.ts:452` | C:130–189；S:1876–2037 | 默认/null/0/上限、空队列、限额、暂停/诊断/物理删除过滤、学习/新卡顺序；有到期 Review 的混排和升级/outbox 故障另列 |
| `fsrs_preview_intervals` | `src/features/flashcards/store/fsrsReviewStore.ts:1334` | C:239；S:2463–2504 | 四档预览；缺失/删除、诊断、暂停；引擎/DB 故障另列 |
| `fsrs_rate` | `src/features/flashcards/store/fsrsReviewStore.ts:1386` | C:252–411；S:2080–2335,4941–5021,5381–5390 | 1..4、缺省/null/显式 CAS、重放；rating 越界、坏 UUID、缺失/删除/诊断/暂停、过期 CAS、op ID 的错卡/错分/旧记录/撤销后复用；事务竞争与故障另列 |
| `fsrs_undo_last_review` | `src/features/flashcards/store/fsrsReviewStore.ts:1640` | C:417；S:2668–2833 | 最新日志撤销与掌握度补偿；空 ID、缺失状态/日志、错卡、旧日志、暂停后失效；旧/坏快照与事务竞争另列 |
| `fsrs_suspend_card` | `src/utils/chatApi.ts:164` | C:457；S:3190,3198–3253 | 改变状态/重复无写入；空白/缺失/删除；并发更新失败另列 |
| `fsrs_unsuspend_card` | `src/utils/chatApi.ts:168` | C:502；S:3194,3198–3253 | 改变状态/重复无写入；空白/缺失/删除；并发更新失败另列 |
| `fsrs_reset_card_progress` | `src/utils/chatApi.ts:231` | C:597；S:4648–4716 | 清日志重建新 state、旧 ID 失效；空白/缺失/删除；写入故障另列 |
| `fsrs_get_stats` | `src/utils/chatApi.ts:226` | C:516；S:3257–3374 | 空/各状态/限额/backlog/删除过滤；无业务输入 Err，DB/升级故障另列 |
| `fsrs_get_review_statistics` | `src/features/flashcards/hooks/useReviewActivity.ts:175` | C:524；S:4132–4446 | 默认/null/0/上下界、已有评分/撤销；无业务输入 Err，DB 故障另列 |
| `fsrs_get_memory_overview` | `src/features/flashcards/memoryCurve.ts:376` | C:535；S:4450–4529 | 默认/null/0/上界、空均值 null、评分/暂停/删除过滤；无业务输入 Err，DB 故障另列 |
| `fsrs_get_card_memory_history` | `src/features/flashcards/memoryCurve.ts:382` | C:546；S:4533–4593 | 新卡 null/评分历史顺序/撤销/重置；空白/缺失/删除/诊断；DB 故障另列 |
| `fsrs_get_scheduler_config` | `src/features/flashcards/components/SchedulerSettingsSection.tsx:106` | C:556；S:3378,5084 起 | 默认/更新；无业务输入 Err，旧/损坏配置回退和 DB 故障另列 |
| `fsrs_update_scheduler_config` | `src/features/flashcards/components/SchedulerSettingsSection.tsx:179` | C:563；S:3390–3653 | 全字段/部分/空/null/边界、参数改变重算；learnAhead、retention、leechAction、两种 steps、maximumInterval、rollover、两种 order、answerSeconds、params 校验 |
| `mastery_get_overview` | `src/components/dashboard/WeakConceptsStrip.tsx:17` | `crates/dstu-learning/src/mastery/mod.rs:24`；`service.rs:824–878` | 默认/null/0/上限、空库/评分后/撤销后、薄弱概念；无业务输入 Err，VFS/SQL 故障另列 |
| `save_anki_cards`（L16 种子） | `src/services/ankiApiAdapter.ts:127` | `src/cmd/anki_connect.rs:926,692–943` | 真实 task/card 原子创建；输入使用 snake_case request、返回 camelCase savedIds/taskId；种子失败停止依赖步骤 |
| `update_anki_card`（L16 状态构造） | `src/utils/chatApi.ts:207` | `src/cmd/enhanced_anki.rs:267` | 将真实卡变为诊断卡；完整 snake_case AnkiCard；不伪造 FSRS state |
| `delete_anki_card`（L16 状态构造） | `src/utils/chatApi.ts:268` | `src/cmd/enhanced_anki.rs:288`；`crates/dstu-storage/src/database/mod.rs:6053–6066` | 真实物理删除卡及复习清理，随后调用 FSRS 确认不可见；不是 tombstone |
| `delete_document_session`（L16 状态构造） | `src/features/anki-tasks/components/SessionRow.tsx:143` | `src/cmd/enhanced_anki.rs:327` | 真实删除源文档任务/卡，再观察 FSRS；不使用无前端调用的 delete_document_task |

四条 L16 命令只承担合法 seed/状态构造，不宣称它们的完整业务分支已覆盖；L16 为这些命令的语料所有者。
main 上 `host/plugins/anki/api.ts` 已包含 cards/documents 与精确版本接口，恢复会话已用 `git show main:host/plugins/anki/api.ts` 核实。

## 逐命令输入覆盖索引

下表的场景名省略 `review.` 前缀；步骤用 0 基编号，与 `${n.path}` 一致。
这是**已写输入**的分支索引，不是执行覆盖率。每个错误步骤保留 A 的完整 error_type/message/details，
不把错误文案写成 expected 替身。所有未能用本包正常 IPC 输入构造的分支见下一节。

| 本域命令 | 成功 / 提前成功输入 | 业务 Err 返回点 → 场景步骤 |
|---|---|---|
| enqueue | `enqueue.new-duplicate-mixed` #1–3 新/旧/重复；`enqueue.empty-and-invalid-selection` #0 空批 | S:1190 → `enqueue.empty-and-invalid-selection` #1–2；:1221 → #3,5；:1387 → #6（trim 复验成功，原 ID 插入前重查失败）；:1265 → `diagnostic.selection-atomic-and-read-filter` #2 |
| due | `reads.empty-null-and-clamps` #0–3；`due.quota-backlog-and-limits-with-cards`；`schedule.learning-due-with-zero-new-quota` #3,5,8,10,12；`suspend.idempotent-visibility-and-stale-undo` | 无纯业务参数 Err；u32 框架拒绝见 `inputs.serde-boundaries` #0–1；连接/查询/解码及补偿异常需后继 |
| preview | `rate.preview-good-undo` #3；`schedule.default-four-ratings` #2；`schedule.single-step-hard-and-graduate` #3,7 | S:2475 → `inputs.empty-and-missing-state` #0–1；:2480 → `diagnostic.selection-atomic-and-read-filter` #8；:2484 → `suspend.idempotent-visibility-and-stale-undo` #8 |
| rate | `schedule.default-four-ratings` #3–6；`rate.cas-null-stale-and-current` #3,6,7；`rate.idempotent-replay-and-conflicts` #2–3 重放；`rate.duration-i64-exact-representable` | S:2091 → `rate.invalid-rating-and-uuid` #2–4；:5387/5391 → #6/#5；:2125 → `inputs.empty-and-missing-state` #2–3；:2129 → `diagnostic.selection-atomic-and-read-filter` #7；:2133 → `suspend.idempotent-visibility-and-stale-undo` #7；:2137 → `rate.cas-null-stale-and-current` #2,4,5；:2115 → `rate.preview-good-undo` #14；:4983/:4988 → `rate.idempotent-replay-and-conflicts` #4/#5；:5006 → `rate.stale-op-and-undo-latest-only` #4 |
| undo | `rate.preview-good-undo` #7；`rate.stale-op-and-undo-latest-only` #6；`schedule.learning-step-chain-undo` #8；`schedule.leech-auto-suspend-and-undo` #8 | S:2674 → `inputs.empty-and-missing-state` #4–5；:2689 → #6；:2712 → `undo.wrong-card-and-missing-log` #4（重复撤销见 `rate.preview-good-undo` #13）；:2718 → #3；:2739 → `rate.stale-op-and-undo-latest-only` #5,8、`suspend.idempotent-visibility-and-stale-undo` #9 |
| suspend | `suspend.idempotent-visibility-and-stale-undo` #5–6 改变/无写入；诊断卡也走普通暂停 | S:3200/:3212 → `inputs.empty-and-missing-state` #7/#8 |
| unsuspend | `suspend.idempotent-visibility-and-stale-undo` #3,14–15 初始无写入/恢复/重复 | S:3200/:3212 → `inputs.empty-and-missing-state` #9/#10 |
| reset | `reset.rebuild-and-old-id-invalid` #4,11 有历史/无历史重建 | S:4650/:4663 → `inputs.empty-and-missing-state` #11/#12；旧 ID → `reset.rebuild-and-old-id-invalid` #10 |
| stats | `reads.empty-null-and-clamps` #4–5（首次升级/已升级）；`due.quota-backlog-and-limits-with-cards`；`schedule.leech-*`；`deleted-*` | 无业务参数 Err；DB/upgrade 失败需后继 |
| statistics | `reads.empty-null-and-clamps` #6–11；`schedule.default-four-ratings` #8；`schedule.empty-steps-short-term-review` #9；`rate.invalid-rating-and-uuid` #9 负时长统计；`rate.preview-good-undo` #11 撤销后 | 无业务参数 Err；u32 拒绝见 `inputs.serde-boundaries` #2；DB 失败需后继 |
| memory overview | `reads.empty-null-and-clamps` #12–16 空均值；`schedule.default-four-ratings` #7 非空且 limit=2；`suspend.*` #12；`deleted-*` | 无业务参数 Err；u32 拒绝见 `inputs.serde-boundaries` #3；DB 失败需后继 |
| memory history | `enqueue.new-duplicate-mixed` #6 未评分；`schedule.learning-step-chain-undo` #11 多日志含撤销；`reset.rebuild-and-old-id-invalid` #5 | S:4535/:4551 → `inputs.empty-and-missing-state` #13/#14；诊断过滤 → `diagnostic.selection-atomic-and-read-filter` #9 |
| get config | `config.defaults-partial-null-and-unknown` #0,2,6；`config.accepted-boundaries` #1,3 | 无业务参数 Err；持久化损坏回退/数据库故障需后继 |
| update config | `config.defaults-partial-null-and-unknown` #1,3–5；`config.accepted-boundaries` #0,2；`schedule.explicit-parameters-recompute-reset` #5,8 | S:3395/:3401/:3408/:3434/:3440/:3449/:3458/:3466 → `config.reject-scalar-validation-branches` #1/#2–3/#4/#5–6/#7/#8/#9/#10–11；S:3423 两种步骤 → `config.reject-steps-and-parameters` #0–3/#4–7；S:3472 → #8 |
| mastery overview | `reads.empty-null-and-clamps` #17–21；`mastery.weak-concept-bias-and-revert`；`mastery.repeat-item-antifarm-vs-independent` | 无业务参数 Err；u32 拒绝见 `inputs.serde-boundaries` #4；VFS/SQL 失败需后继 |

上述表为 **42 个业务 Err 输入分支**（按命令拆分 suspend/unsuspend，相同配置循环的 learning/relearning 分开；
重复输入与物理删除后 NotFound 不重复计数）。框架 serde 拒绝输入另计。实际成功/错误返回数量、
Rust 行覆盖率以及是否真正走到目标分支，必须由 X7 A 端运行确认。

## 原始测试来源与保留差异

- S:5613–5787 的 preview / 幂等 op ID / malformed UUID / wrong-card / undo-reuse / stale-CAS
  原测试已全文审读，对应 lifecycle 的同名主题；建卡 SQL 改为真实 `save_anki_cards`，不复制输出。
- S:7712–8028 的完整 undo / 连续评分 / 暂停失效 / 错卡 / 幂等暂停原测试已全文审读。
  非平凡旧状态、损坏快照由 SQL 写入的部分不在 empty 语料内，未改 TESTMAP。
- S:6497–6592 的历史/重置，S:6970–7147 的诊断卡，S:7150–7539 的软删卡/任务，
  S:9425–9578 的配置/步骤/参数重算，S:9804–9880 的 sibling，S:9910–10018 的排序
  均已阅读全文。借用输入意图，历史种子差异逐条留在下面，不宣称全量移植这些测试。
- `src-tauri/crates/dstu-learning/src/fsrs_scheduler.rs:18–25,102–120,403–451` 是学习步、
  f32 FSRS 参数、日切来源。显式 21 参数来自 fsrs **6.6.2** `src/inference.rs:27–49`
  （本机 Cargo registry 只读），没有复制期望稳定性/难度。
- `src-tauri/src/mastery/service/tests.rs:334–493` 的防刷分/四种 rating signal/幂等补偿已全文审读。
  本包用 FSRS 入口与自然墙钟，不等同原 qbank 的定时防刷场景；只记录两种真实输入轨迹与 DB。

## 保真约定

- 不给 FSRS stability/difficulty/scheduledDays/retention 加 epsilon；保留 f32→f64 的真实输出。
- 不丢弃空字段、NULL、未知返回字段；不排序数组，不去重事件，重放评分仍捕获命令层重复 emit。
- 捕获全部数据库及 storageClasses，尤其 mistakes 的 `fsrs_card_states`、`fsrs_review_logs`、
  `anki_cards`、`document_tasks`、`anki_decks`，以及 VFS mastery/profile 旁路写入。
- 动态 ID 使用 `${n.path}`，保持返回、事件、FK 的关联。时间、UUID、SQLite random 排序与 fuzz
  都尚未双录；目前没有批准的 normalize，不预先屏蔽差异。
- 串行 v0 不构造事务中途的并发冲突，不把前端参数校验失败当作业务成功。

## 已确认需后继种子/运行器支持的分支

1. **大整数 reviewVersion CAS**：S:2838–3190,4800–4934 的 session/library 服务方法使用
   `i64 local_version`，当前 fsrs_* IPC 不接受 reviewVersion；`fsrs_rate` 的 CAS 是 lastReviewMs。
   `empty` 加正常调用无法在两小时内创建 `9007199254740993` 等版本。
   需要 X3 的历史 SQLite 种子（精确 INTEGER、相邻版本、i64::MAX）及 L24 的真实工具外层调用，
   不能添加伪 IPC 或把 durationMs/lastReviewMs 大数冒充版本覆盖。
2. **历史/损坏数据**：S:1402–1419 的 state tombstone 重入队；S:2742–2747 的
   NULL/损坏/结构合法但内容无效快照；S:1929–1946 的历史 JSON SQL NULL；S:5084 起坏配置回退。
   正常创建命令不会写入这些状态，需要 X3 历史种子。保持未覆盖，不为 v0 写任意 SQL 命令。
   特别是 S:7150–7324 / 7327–7539 原测试直接把 card/task 的 `deleted_at` 写入数据库、保留
   子状态；本包 `deleted-card` / `deleted-document` 场景调用物理 DELETE，**不覆盖这两个
   soft-deleted 原测试**。已覆盖的软删除只限 `undo_last_review` 的日志 tombstone。
   同毫秒、纳秒 created_at 逆 UUID 排序（S:6497–6543）也需历史种子；普通连续调用只检查自然历史。
3. **故障/竞态**：各连接、prepare/query/map/commit `map_err`、引擎错误、评分更新 0 行
   (S:2250–2259)、重复日志 INSERT 冲突 (:2303–2313)、撤销 CAS (:2799–2822)、暂停 CAS
   (:3240–3246)、写后行消失，需 X7/X3 的损坏库/事务故障或并发驱动。
   C:121–126,139–187,305–408,425–447 的 best-effort 失败还需记录日志且验证主事务成功。
4. **跨日与成熟记忆**：S:9910–10018 原测试用 SQL 构造四张已到期 Review（不同 elapsed/stability），
   empty 下当天评分生成的 Review 至少未来一天到期；本包只触达 order 配置分支和 Learning/New 排序，
   不宣称到期 Review 的 due/retrievability/random 混排已覆盖。跨日 retention、成熟 stability≥21、
   DST/逻辑日切、埋藏翌日恢复、足量历史截断、参数跨日重算仍需 X3 历史 seed / X7 时间驱动。
   微学习步 `0.000001` 分钟是合法输入（`learning_due_ms` 把 0.06ms round 为 0），用于无需等待的 Learning 到期分支。
5. **mastery 环境分支**：正常桌面同时有 VFS；VFS 缺失、outbox 失败与 profile 回流失败不由合法
   IPC 参数关闭。无标签 save 种子会回退到 `Chat Cards 未分类` 文档名（S:2520–2543），
   不冒称命中了真正 tagless 的补偿确认分支。需要 X7 环境/故障驱动及 X3 文档名空/Default 种子。

## 同域剩余命令

- `fsrs_optimize_parameters`（C:573 / S:4037）：跨逻辑日足量历史/优化训练单独一组，避免
  只覆盖 not_enough_data 就宣称训练成功；`fsrs_bury_card`、`fsrs_unbury_card` 没有真实前端入口。
- review_plan 功能组：其中 10 条由下文 WP-113 覆盖；其余 6 条及无前端调用的 `review_plan_get`
  见 WP-113 的“同组剩余命令”。
- `study_time_add`、essay_grading 的 20 条前端命令留后继；insight 与 study_time_range 无前端调用。

TESTMAP 保持不变：实际行 123 ported / 5 pending（旧 generated 表头的 121/7 已过时，本包禁止修改 TESTMAP）。

---

# WP-113：review_plan（SM-2 错题复习）前端场景 v0

状态：本地 v0 输入语料，尚未在 A/B 上运行，C=0。语料文件 `review-plan-lifecycle.v0.json`，
共 9 个场景、201 步（成功意图 159 步，错误意图 42 步：业务 Err 24 步、serde 拒绝 18 步）。
本包固定 **10 条 L15 目标命令**，另用 4 条辅助种子/状态命令（下表单列，不计入目标数）。
所有场景 `seed: "empty"`、`capture: {"events":true,"db":["*"]}`、`normalize: []`。
`check.mjs` 通过只说明 JSON 结构、契约参数和 `${n.path}` 引用路径合法，**不能证明 A/B 等价已充分**。

## 目标命令（编写前固定）

下面 S = `src-tauri/crates/dstu-qbank/src/review_plan_service.rs`，
R = `src-tauri/crates/dstu-vfs/src/vfs/repos/review_plan_repo.rs`，
P = `src/stores/reviewPlanStore.ts`。契约来自 `contracts/ipc/L15-review-analytics.json`。

| 命令 | 前端 invoke（文件:行） | 真实组件调用 | Rust 入口 / 业务分支 |
|---|---|---|---|
| `review_plan_create` | P:444 | 无当前组件调用（仅 store action） | S:763；S:135–168；R:253–302 |
| `review_plan_process` | P:584 | `src/components/ReviewSession.tsx:594` 经 `submitReview`→`processReview` | S:776–791；S:219–372，状态 S:375–407；SM-2 `crates/dstu-core/src/spaced_repetition.rs:139`；更新 CAS R:522–585 |
| `review_plan_get_due` | P:325 | `src/components/ReviewPlanView.tsx:354`；`src/features/learning-today/dueMistakesReview.ts:53` | S:795；S:417–443（limit 500）；R:365–465 |
| `review_plan_get_stats` | P:380 | `ReviewPlanView.tsx:355`；`src/features/learning-hub/apps/views/useExamDueReviewCount.ts:22`；`src/features/learning-today/todayLearning.ts:43` | S:820；S:464；R:930–1016 |
| `review_plan_get_by_question` | P:567 | 无当前组件调用 | S:844；S:614 |
| `review_plan_suspend` | P:520 | `ReviewPlanView.tsx:450` | S:866；S:632；R:594–615 |
| `review_plan_resume` | P:536 | 无当前组件调用 | S:876；S:659；R:656–683，恢复状态 R:230–240 |
| `review_plan_delete` | P:506 | 无当前组件调用 | S:886；S:683；R:734–746 |
| `review_plan_get_history` | P:608 | 无当前组件调用 | S:896；S:702；R:873–927（默认 100，`reviewed_at DESC`） |
| `review_plan_get_or_create` | P:554 | 无当前组件调用 | S:948；S:733–739 |

“无当前组件调用”的 6 条只有 store action 可达，但契约 `frontend: app`，store 是现行前端代码而非 demo/mock，
因此计入目标；不把 `src/demo/` 下的 mock 当作可达证据。

## 辅助种子/状态命令（不计入目标数）

| 命令 | 所有者 | Rust | 前端调用 | 本包用途 |
|---|---|---|---|---|
| `dstu_create`（type=exam） | L13 | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:726` | `src/dstu/api.ts:336`（`src/dstu/factory.ts:92` createEmpty） | 建真实 `exam_sheets` 行。`questions.exam_id` 有外键，VFS 开启 `foreign_keys=ON`（`database.rs:133`），不能用假 exam ID |
| `qbank_create_question` | L14 | `src-tauri/src/commands.rs:7704` | `src/quick-assistant/service.ts:256` | 建单题（含/不含标签） |
| `qbank_batch_create_questions` | L14 | `src-tauri/src/commands.rs:7718` | `src/essay-grading/essayMistakes.ts:63` | 一次建多题，返回数组以 `${n.i.id}` 引用 |
| `qbank_delete_question` | L14 | `src-tauri/src/commands.rs:7778` | `src/stores/questionBankStore.ts:1574` | 软删题（`deleted_at`），构造“题目已删、计划仍在” |

这四条只承担 seed/状态构造，不宣称覆盖其业务分支；完整语料由 L13/L14 负责。

## 逐命令输入覆盖索引

场景名省略 `review.plan.` 前缀，步骤 0 基编号，与 `${n.path}` 一致。这是**已写输入**的索引，不是执行覆盖率；
错误步骤以 A 端完整返回为 oracle，不写期望文案。Rust 错误经 `e.to_string()` 只露出最外层 context。

| 命令 | 成功 / 提前成功输入 | 业务 Err 返回点 → 场景步骤 | serde 拒绝 |
|---|---|---|---|
| create | `create-reads-before-and-after` #6；`delete-cascade-and-recreate`、`due-stats-*`、`suspend-resume-*` 多题建计划 | S:138 题目不存在 → `create-missing-*` #3（缺失 ID）、#4（空串）、#12（题已软删）；S:141 exam 不匹配 → #5（另一真实 exam）、#6（不存在的 exam）；R:259 AlreadyExists → `create-reads-*` #13 | `create-missing-*` #15 缺 examId、#16 questionId=null |
| get_or_create | 已有计划直接返回：`create-reads-*` #14；`get-or-create-existing-*` #4（换 exam 不校验）、#5（未知 exam）、#8（题已软删仍返回）；新建：`get-or-create-existing-*` #3、`delete-cascade-*` #15（删除后重建） | 走 create 的 S:141 → `create-missing-*` #7；S:138 → #8（缺失）、#13（软删） | `invalid-inputs-*` #27 缺 examId |
| process | 通过链 q=4/5/3、毕业、间隔：`process-pass-chain-*` #3–10；失败/困难/EF 下限/重置：`process-failures-*` #3–5,7–17；空白标签：`process-failures-*` #1 的 `["  ","数列"]`；题已软删跳过掌握度：`get-or-create-existing-*` #9；暂停中评分保持 suspended：`suspend-resume-*` #21–22；`timeSpentSeconds=u32::MAX`：`invalid-inputs-*` #16 | S:783 quality>5（先于查计划）→ `invalid-inputs-*` #3（6）、#4（255）、#7（缺失计划+6）；S:235 计划不存在 → #5（缺失）、#6（空串）、`delete-cascade-*` #14（已删除） | `invalid-inputs-*` #8–14（256、-1、3.5、u32 溢出、负数、planId=null、缺 quality） |
| get_due | 空库 `create-reads-*` #5；默认/省略参数 #8–9；`due-stats-cross-exam-*` #15–21（跨 exam、未知 exam、`1970-01-01`、`9999-12-31`）、#28 暂停后过滤；`process-pass-chain-*` #18–19 | 无业务参数 Err | `invalid-inputs-*` #22 untilDate=0 |
| get_stats | 空库 `create-reads-*` #3–4；`due-stats-*` #22–25,27（null/各 exam/未知 exam/暂停后）；`process-failures-*` #6,19（困难计数）；`suspend-resume-*` #24,32 | 无业务参数 Err | `invalid-inputs-*` #21 examId=1 |
| get_by_question | 无计划返回 null：`create-reads-*` #2、`create-missing-*` #9–10（空串）、`delete-cascade-*` #10；有计划：`create-reads-*` #7；题已软删仍可读：`get-or-create-existing-*` #7 | 无业务参数 Err | `invalid-inputs-*` #26 缺 questionId |
| suspend | `suspend-resume-*` #15–19（new/learning/reviewing/graduated 各一，P4 暂停后再答错）；重复暂停 #20 | R:603 0 行 → `suspend-resume-*` #33（缺失）、#34（空串）、`delete-cascade-*` #12（已删除） | `invalid-inputs-*` #23 planId=null |
| resume | `suspend-resume-*` #25–29（按 repetitions/interval 恢复状态，R:230）；未暂停计划再恢复 #30、`due-stats-*` #12–13（重置 next_review_date 为今天） | R:661 → `suspend-resume-*` #35（缺失）、#36（空串）、`delete-cascade-*` #13 | `invalid-inputs-*` #24 缺 planId |
| delete | `delete-cascade-*` #6（随后 #10–11 读到 null 和空历史，观察级联） | R:738 0 行 → `delete-cascade-*` #7（重复删除）、#8（空串）、#9（缺失） | `invalid-inputs-*` #25 planId=7 |
| get_history | limit 50/null/省略/0/3/`u32::MAX`：`process-pass-chain-*` #11–15；不存在计划返回空：`invalid-inputs-*` #19；`create-reads-*` #12 新计划空历史 | 无业务参数 Err | `invalid-inputs-*` #17 limit=-1、#18 u32 溢出 |

业务 Err 返回点共 10 个（S:138、S:141、R:259、S:783、S:235、R:603、R:661、R:738，以及 get_or_create
复用的 S:138/S:141 两个入口）。实际是否走到目标分支、Rust 行覆盖率与 A/B 是否一致，需 X7 A 端运行确认。

## 原始测试来源

- `src-tauri/src/review_plan_service/tests.rs:29`（exam 不匹配）对应 `create-missing-*` #5–7；
  `:94`（复习写一次掌握度、练习推进不重复计）中命令可达的部分对应 `process-*` 场景。
  `advance_from_practice`（S:215）没有 IPC 入口，不在本包。TESTMAP 两行已 ported，本包不改映射。

## 保真约定

- 不给 `ease_factor` 等浮点加 epsilon，不屏蔽 `created_at`/`updated_at`/`next_review_date`/`reviewed_at`，
  不改写 `rp_` nanoid；这些命令不 emit 事件，`events:true` 用于确认没有事件。
- 捕获全部数据库：VFS `review_plans`、`review_history`、`questions`、`exam_sheets`，以及 process 在同一事务内写入的
  mastery 表（`concept_key_from_tags`，`crates/dstu-learning/src/mastery/service.rs:78`，无有效标签时回退 `item:<qid>`）。
- 日期依赖本地时区“今天”（R:268、S:269）。A/B 同日同时区运行才可比较，不预先 normalize。

## 未覆盖（需后继种子/运行器，不计入本包）

1. **到期与跨日**：`overdue_count` 与 `next_review_date < 今天` 的逾期排序需要跨日或 X3 历史 seed；
   empty 下所有计划当天建立，`untilDate` 远期/远古只覆盖筛选边界。午夜/时区切换、DST 也未覆盖。
2. **规模**：get_due 的 `has_more`（S:430 limit 500）需 500+ 计划，未构造。
3. **CAS 与并发**：process 更新 0 行（R:573 `revision_conflict`）、`expected_updated_at` 冲突（S:237，
   仅 agent 工具路径）、`*_if_unchanged` 三个变体都不经 IPC；并发评分/删除竞态需 X7 并发驱动。
4. **故障**：连接、事务开始/提交、history 写入失败、mastery `.ok()` 吞错（S:343）、
   `sync_learner_profile` 失败只记 warn（S:353），需 X7 故障注入。异常是否另行处理待 C2 复核。
5. **不可达或需历史状态**：同时间戳历史的排序需 X3 seed；repetitions=2 且 interval≥21 由 SM-2 不可达。
6. **历史软删与 CAS 另列**：WP-053 已列的 FSRS 软删卡/任务与 reviewVersion CAS 不属于本包，也不计入本包。
   本包涉及的软删除只限 `qbank_delete_question` 的题目 `deleted_at`。

## 同组剩余命令

- `review_plan_get_due_with_filter`（P:352）、`review_plan_refresh_stats`（P:394）、`review_plan_list_by_exam`（P:415）、
  `review_plan_batch_create`（P:466）、`review_plan_create_for_exam`（P:487）、`review_plan_get_calendar_data`（P:784）：
  由下文 WP-147 覆盖。
- `review_plan_get`（S:856）没有前端调用，不纳入。

TESTMAP 映射未改：实际行 123 ported / 5 pending（本包前后相同）。

---

# WP-147：review_plan 剩余六命令前端场景 v0

状态：本地 v0 输入语料，尚未在 A/B 上运行，C=0。语料文件 `review-plan-aggregate.v0.json`，
共 7 个场景、202 步（成功意图 169 步，错误意图 33 步：业务 Err 2 步、serde 拒绝 31 步）。
本包固定 **6 条 L15 目标命令**（98 步），另用 10 条辅助命令（104 步，下表单列，不计入目标数）。
所有场景 `seed: "empty"`、`capture: {"events":true,"db":["*"]}`、`normalize: []`；与 WP-113 同一格式。
`check.mjs` 为本文件单列 `review-plan-aggregate` 组（16 条命令，≤20），并输出每个文件的步数；
通过只说明结构、契约参数与 `${n.path}` 引用合法，**不证明 A/B 等价已充分**。

## 目标命令（编写前固定）

S、R、P 同 WP-113；另 Q = `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs`。
“UI 调用”只列现行组件（不含 `src/demo/`）；store-only 命令仍按契约 `frontend: app` 计入，**不调整 765 分母**。

| 命令 | 前端 invoke | 实际 UI 调用 | Rust 入口 / 所调方法 |
|---|---|---|---|
| `review_plan_get_due_with_filter` | P:352 `{filter}`（DueReviewsFilter 为 snake_case 字段） | **store-only**：`loadDueReviewsWithFilter` 无组件调用 | S:808 → S:447 → R:365–466（默认 limit 50，`status != 'suspended'`，ORDER BY next_review_date, is_difficult DESC, consecutive_failures DESC） |
| `review_plan_refresh_stats` | P:394 `{examId: examId ?? null}` | `src/components/ReviewPlanView.tsx:365`（`review://changed`）、`:375`（刷新按钮）；另经 `createPlansForExam` P:493 | S:832 → S:472 → R:1018–1078（get_stats R:936 后 UPSERT `review_stats`） |
| `review_plan_list_by_exam` | P:415 `{examId, limit: 1000, offset: 0}` | `src/components/ReviewCalendarView.tsx:536` 经 `loadAllPlans`；另经 batch/create_for_exam 后刷新 | S:934 → S:714 → R:468–515（默认 limit 100，只按 next_review_date 排序，无 status/deleted 过滤） |
| `review_plan_batch_create` | P:466 `{questionIds, examId}` | **store-only**：`batchCreatePlans` 无组件调用 | S:909 → S:491–549 → 每项 S:135 create_review_plan |
| `review_plan_create_for_exam` | P:487 `{examId}` | `src/components/ReviewPlanView.tsx:466`（无计划时一键创建） | S:922 → S:559–618 → Q:1204–1380 list_questions（page_size 500 被 Q:1224 夹到 100）+ S:491 |
| `review_plan_get_calendar_data` | P:784 `{startDate\|\|null, endDate\|\|null, examId\|\|null}` | `src/components/ReviewCalendarView.tsx:524`（总传日期与 examId） | S:961 → S:742 → R:1086–1170（`DATE(rh.reviewed_at)` 分组，JOIN review_plans） |

store 对 `refresh_stats` 用 `??`、对 calendar 用 `||`：UI 传 `""` 时 calendar 收到 null，而 IPC 直接传 `""` 是 `Some("")`。
语料两者都写，`""` 步骤标为 IPC 边界而非 UI 路径。

## 辅助命令（不计入目标数）

| 命令 | 所有者 | 本包步数 | 用途 |
|---|---|---|---|
| `dstu_create`（type=exam） | L13 | 12 | 真实 `exam_sheets` 行（review_plans 与 review_stats 均有 exam 外键） |
| `qbank_create_question` / `qbank_batch_create_questions` | L14 | 2 / 8 | 建题；分页场景一次 103 题 |
| `qbank_delete_question` | L14 | 5 | 题目软删（`deleted_at`），计划保留 |
| `review_plan_create` / `process` / `suspend` / `resume` / `delete` / `get_by_question` | L15（WP-113 已计） | 18 / 22 / 3 / 2 / 3 / 1 | 构造 new/learning/reviewing/difficult/suspended 状态与 review_history；不重复计入 WP-113 覆盖 |

## 逐命令输入覆盖索引

场景名省略 `review.plan.` 前缀，步骤 0 基编号。实际返回、排序与 DB 以 A 端为 oracle；括号中的预期只是编写依据。
全部目标命令都不 emit 事件，`events:true` 用于确认没有事件。

| 命令 | 成功 / 提前返回输入 | 业务 Err → 步骤 | serde 拒绝 |
|---|---|---|---|
| get_due_with_filter | `due-with-filter-*` #21 `{}`；#22–24 exam A/B/未知；#25 全 null；日期 #26 `9999-12-31`、#27 `1970-01-01`、#28 `""`、#29 `"9"`（字符串比较）；status #30–37（new/learning/reviewing/组合/suspended 恒空/graduated/`[]` 不加条件/重复）；difficult_only #38 true、#39 false；#40 组合+分页；分页 #41 limit 0、#42–43 has_more 边界、#44 offset 越界、#45 limit=u32::MAX；#46 camelCase 键与 #47 未知键被忽略；`create-for-exam-*` #21 默认 50 截断、#22–24 102 条边界 | 无业务 Err（S:447 只包 DB 错误） | `due-with-filter-*` #48–57（缺 filter、null、字符串、未知枚举、status 非数组、-1、u32 溢出、bool/日期/exam 类型错） |
| refresh_stats | `refresh-stats-*` #6 null、#7 省略（各插入一行 exam_id NULL，NULL 不触发 ON CONFLICT）、#17、#27 继续累积；#8 插入 A、#16 UPSERT（3/7、平均 EF 浮点）、#19 暂停计数、#20 空 exam（AVG NULL→2.5、rate 0.0）、#24 题软删仍计、#26 删计划后；`batch-create-*` #18；`create-for-exam-*` #25,#29 | R:1031 `review_stats.exam_id` 外键 → `refresh-stats-*` #21 未知 exam、#22 `""`（S:474 context 为外层文案） | `refresh-stats-*` #28–30（数字、数组、布尔） |
| list_by_exam | `create-for-exam-*` #10 默认 100、#11 前端形状 1000/0、#12 null、#13–14 has_more 边界、#15 limit 0、#16 offset=total、#17 limit=u32::MAX、#18–20 空/未知/`""`、#27 题软删后计划仍列出；`batch-create-*` #6,#15–16 | 无业务 Err | `create-for-exam-*` #30–34（缺 examId、null、-1、u32 溢出、小数） |
| batch_create | `batch-create-*` #7 混合（预期 created 2 / skipped 2：已有计划+批内重复 / failed 4：缺失、`""`、他卷题、软删题）；#8 重放全部 skip/fail；#9 空数组；#10 已有计划但 exam 不符→先判 mismatch 计 failed；#11 examId=`AlreadyExists`、#12 questionId=`already exists` 命中 S:518 字符串兜底被计 skipped（#13 为普通 mismatch 对照）；#14 同次调用重复 ID；#15 部分成功已持久化 | 无业务 Err：S:491 逐项吞错只计数（warn S:530），命令总返回 Ok | `batch-create-*` #19–25（缺/null/字符串/元素数字/元素 null/缺 examId/examId null） |
| create_for_exam | `create-for-exam-*` #5 103 题中 1 软删、1 已有计划：两页（100+2），预期 101/1/0；#6 重放 0/102/0；#7 空 exam、#8 未知、#9 `""` 首页即空 0/0/0；#28 软删已有计划的题后 0/101/0 | S:566 list_questions 失败才 Err，正常 IPC 不可达（见下） | `create-for-exam-*` #35–37 |
| get_calendar_data | `calendar-*` #8 无历史；#17 全部（同日一行）；#18–21 exam A/B/未知/`""`；#22 宽区间、#23–24 单边越界、#25 倒置区间、#26–27 非日期字符串按字典序比较；#29 暂停仍计、#31 题软删仍计、#33–34,#36–37 删计划后 history 级联消失；q=2 失败 / q=3 通过（PASSING_GRADE 3）在 #10–11 | 无业务 Err | `calendar-*` #38–40 |

可达业务 Err 返回点只有 1 个：refresh_stats 的外键失败（R:1031，两步输入）。其余 5 条命令只有 DB/连接错误路径。

### u32 溢出隔离场景（不计 Err，也不计成功）

`list-by-exam-u32-offset-overflow` #3、`due-with-filter-u32-offset-overflow` #3：`has_more = (offset + limit) < total as u32`
（R:452/R:508）在 u32 上相加。release 配置未开 overflow-checks（`src-tauri/Cargo.toml:559` 起），会回绕成
0 < 1 → `has_more: true` 并返回空页；dev 配置会 panic，命令可能不返回。两场景各自独立、放在最后一步，
**录制必须记录 Rust 构建 profile 并设超时**，不写 `expect`。前端 P:415 固定 1000/0，不可达；P:352 可由 store 调用方传任意 filter。

## 保真约定

- 不 normalize `rp_` nanoid、`created_at`/`updated_at`（UTC RFC3339）、`next_review_date`（本地日期）、
  `review_stats.updated_at`、`avg_correct_rate`（3/7）、`avg_ease_factor`（`(2.6+2.36+2.5)/3` 的 f64 原值）。
- 排序不重排：get_due_with_filter 在 next_review_date / is_difficult / consecutive_failures 全相同时、
  list_by_exam 在 next_review_date 相同时没有 tie-break（`create-for-exam-*` #10–14,#21–24 的 102 条同日计划、
  `due-with-filter-*` #21 的 d0/e0），顺序由 SQLite 查询计划决定，A/B 不一致时如实报告，不排序后再比。
- 捕获全部 DB：`review_plans`、`review_history`、`review_stats`（含累积的 exam_id NULL 行）、`questions`、`exam_sheets`、
  process 在同一事务写入的 mastery 表。calendar 按 UTC 日期分组、store 按本地日期请求，A/B 同时区同时段运行才可比。

## 未覆盖（需后继种子/驱动，不计入本包）

1. **今天/明天边界**：`until_date` = 今天（含）/明天、calendar 区间端点 = 今天，需要驱动在运行时注入本地日期模板；
   静态 JSON 只能用 null（=今天）、远古、远期、非日期字符串。跨日的 `overdue_count`、UTC 与本地日跨午夜也需 X7 时间驱动或 X3 历史 seed。
2. **graduated 与长间隔**：status `graduated` 只写了“空结果”输入；有到期的 graduated 计划需要 X3 历史 seed（WP-113 已列）。
   d4 第二次通过后 interval 6 带 ±1 天 fuzz（`spaced_repetition.rs:239`），本包只在远期 until_date 下观察。
3. **batch 部分失败的非输入原因**：create_for_exam 内 failed>0 只能由列题与建计划之间题被删/改卷（并发）或 DB 写失败产生；
   S:566 list_questions 失败、R:1031 以外的 UPSERT/查询失败、`log_and_skip_err`（R:22）跳过损坏行需 X3 损坏行 seed 或 X7 故障注入。
4. **规模**：create_for_exam 超过 500 计划的多页已由 100 夹取覆盖两页；get_due_with_filter 未构造 >1000 行。
5. **exam 软删**：`review_stats` 外键对已软删 exam 仍成立；本包未构造 exam 软删（L13 所有者状态），留后继。

TESTMAP 映射未改：实际行 123 ported / 5 pending（本包前后相同）。

# WP-229：essay_grading / insight / study_time / FSRS 埋藏与优化 前端场景 v0

状态：本地 v0 输入语料，尚未在 A/B 上运行，C=0。可运行文件 3 个，共 16 个场景、446 步：
`wp229-essay-grading.v0.json`（8 场景 228 步）、`wp229-insight.v0.json`（3 场景 113 步）、
`wp229-study-time-and-fsrs-bury-optimize.v0.json`（5 场景 105 步）。错误意图 180 步（serde 拒绝 44、业务 Err 136）。
另有 `pending-provider/wp229-essay-stream-scripted.json`（2 场景 13 步）及其 `.provider.json` 脚本，需要 X5/X7 本地脚本化 LLM，
不在可运行集合内（`baseUrl: "${provider.url}"` 不是整值引用，官方 runner 会拒绝）。
本包覆盖 brief 列出的 **37 条命令**，按 brief 不受“每包 ≤20 条 / 首包一个功能组”上限约束（D-059/D-153）。
`check.mjs` 为 `wp229-` 前缀（含 pending 文件）单列一组，不检查 20 条上限；pending 文件只做结构、契约、引用与 id 唯一检查。
所有场景 `seed: "empty"`、`capture: {"events":true,"db":["*"]}`、`normalize: []`。`expect:"error"` 只是编写标注，A（Rust）实际结果才是 oracle。

## 契约 `frontend` 标记过期（未改契约）

`contracts/ipc/L15-review-analytics.json` 把下列命令标为 `frontend: none`，但现行前端有真实 invoke，
所以 `check.mjs` 用白名单放行，契约本身留给契约所有者更新：

- 12 条 `insight_*`：`src/features/insights/api.ts:18–94`，由 `InsightsSection.tsx:13`、`insightRecall.tsx:24` 调用。
- `study_time_range`：`src/features/learning-today/weeklyReport.ts:90`。
- `fsrs_bury_card` / `fsrs_unbury_card`：`src/features/flashcards/store/fsrsReviewStore.ts:707` / `:1842`。

## 辅助种子命令（不计入 37 条）

| 命令 | 所有者 | 步数 | 用途 |
|---|---|---|---|
| `save_api_configurations` | L02（`contracts/ipc/L02-llm-manager.json`） | 4（含 pending 2） | 造启用/禁用/嵌入/重排/多模态模型配置；`baseUrl` 指向拒绝端口 `127.0.0.1:9` |
| `save_model_assignments` | L02 | 4 | 设置/清空 `model2_config_id`（批改默认模型） |
| `save_anki_cards` / `delete_anki_card` | L16 | 3 / 1 | 造 Anki 卡；物理删除后 FSRS 状态失联 |
| `fsrs_enqueue_cards` / `fsrs_get_due` / `fsrs_get_stats` / `fsrs_get_scheduler_config` / `fsrs_update_scheduler_config` / `fsrs_suspend_card` / `fsrs_unsuspend_card` / `fsrs_rate` | L15（WP-053 已计） | 3 / 5 / 5 / 3 / 2 / 1 / 1 / 3 | 入队、观察埋藏对到期队列与统计的影响、造同日评分 |

## 逐命令覆盖表

路径缩写：E = `src-tauri/crates/dstu-tutor/src/essay_grading/`（`mod.rs` 命令实现，`custom_modes.rs` 校验，`pipeline.rs` 流式）；
命令包装在 `src-tauri/src/essay_grading/mod.rs`（行号见 corpus 清单）。I = `src-tauri/crates/dstu-research/src/insight/service.rs`（包装 `src-tauri/src/insight/handlers.rs`）。
T = `src-tauri/crates/dstu-learning/src/study_loop/study_time.rs`。F = `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs`（包装 `src-tauri/src/cmd/fsrs_review.rs`）。
前端 essay 命令都在 `src/essay-grading/essayGradingApi.ts`（stream 在 `useEssayGradingStream.ts:404`）。
“成功 / 错误”为步骤数（pending 成功步另列）；serde 拒绝计入错误列。

| 命令 | 前端 | 成功 | 错误 | 理由 / 覆盖的分支 |
|---|---|---|---|---|
| essay_grading_create_session | api:99 | 5（+1 pending） | 2 | 空标题/空类型也成功；错误只有 serde（缺 gradeLevel、title null） |
| essay_grading_get_session | api:115 | 7（+1） | 2 | 不存在返回 null；空/空白 id → E/mod.rs:76 |
| essay_grading_update_session | api:131 | 3 | 6 | 部分字段更新、`custom_prompt: ""`；空 id、不存在 id（not_found）、缺 id、`is_favorite` 类型错 |
| essay_grading_delete_session | api:151 | 3（+1） | 2 | 重复删除与不存在 id 幂等成功；空 id 校验、null serde |
| essay_grading_list_sessions | api:165 | 15（+2） | 2 | offset/limit null、0、u32::MAX；query 大小写、trim、空白、匹配类型/年级；-1 与 u32 溢出 serde |
| essay_grading_toggle_favorite | api:180 | 3 | 2 | 往返切换；空 id、不存在 id |
| essay_grading_get_rounds | api:191 | 3（+2） | 1 | 轮次只在 stream 成功后写入，空 seed 返回 `[]`（真实轮次见 pending）；空白 id |
| essay_grading_get_round | api:205 | 3（+1） | 7 | roundNumber 1、i32::MAX 返回 null；`< 1` → E/mod.rs:343；空 id；i32 溢出、小数、缺参 serde |
| essay_grading_get_latest_round_number | api:219 | 3（+1） | 1 | 空库返回 0/null；空 id |
| essay_grading_get_modes | api:293 | 5 | 0 | 只读内置 + 覆盖 + 自定义；E/mod.rs:379 无 Err 分支 |
| essay_grading_get_mode | api:306 | 19 | 1 | 别名经 `canonical_mode_id`（types.rs:1004，含 trim）、大小写、未知与空 id 返回 null；缺参 serde |
| essay_grading_list_custom_modes | api:369 | 8 | 0 | 只有 `get_mode_manager` 未初始化一个 Err（E/mod.rs:56），正常启动不可达 |
| essay_grading_create_custom_mode | api:336 | 8 | 26 | 校验 custom_modes.rs:479–560 全分支：名称空/空白/61 字符（含 astral 😀 按 char 计）、描述 2001、提示词 20001、维度 0/21 个、维度名空/超长/trim 后重复、满分 0/-1/100001、维度描述 501、总分 0/-5/100000.01；与内置名、已有名（trim、大小写）重名；serde 缺字段/类型错。边界成功：60 字符、20 维度、`100000.001`（f32 舍入后 ≤ 100000） |
| essay_grading_update_custom_mode | api:347 | 5 | 11 | 全部 null 只改总分、只给 id；不存在 id、空 id、重名（自定义/内置）、各校验项、缺 id serde；覆盖模式按 id `ielts` 更新 |
| essay_grading_delete_custom_mode | api:358 | 1 | 7 | 内置 id/别名/带空格 id 拒绝；不存在、空、已删除 id |
| essay_grading_save_builtin_override | api:389 | 3 | 10 | 别名解析、重复保存；空/空白/未知/自定义 id、名称与其他自定义重名、校验项、缺 builtin_id |
| essay_grading_reset_builtin_mode | api:400 | 6 | 2 | 无覆盖时重置也成功、别名；未知与空 id → E/mod.rs:549 not_found |
| essay_grading_has_builtin_override | api:411 | 10 | 1 | 别名、自定义 id、未知、空；数字 serde |
| essay_grading_get_models | api:431 | 5 | 0 | 过滤禁用/嵌入/重排、默认模型标记随 `model2_config_id` 变化。Err 只来自 LLM 配置读取/解析（E/mod.rs:580–581），空 seed 不可达 |
| essay_grading_stream | useEssayGradingStream.ts:404 | 0（+1 pending） | 25 | 早期检查 pipeline.rs:277–300、1027–1036：空 session/stream id、未知/空白 mode、空文本（含仅空白图片）、50001 字符、mode null、模型缺失/禁用/嵌入/未配默认、默认模型禁用、图片 >6 张；拒绝端口网络错误（重试 MAX_REQUEST_ATTEMPTS=3、间隔 800 ms，录制需容忍耗时）；serde 缺字段/类型错。成功需脚本化 LLM，见 pending |
| insight_create_draft | api:18 | 9 | 7 | ownership 字符串与 `{"ai_draft":null}` 形式；self_reported 无用户证据降级 guided（I:37–60）；最小证据；标题空/空白、转折与规则都空（I:29–47）；未知 ownership/kind、缺快照、缺字段 serde |
| insight_confirm | api:25 | 3 | 4 | 重复确认、带 edits；不存在/空/已删除 id（I:165）；edits 类型错 |
| insight_correct | api:35 | 4 | 3 | 空 input、清空字段；不存在/已删除（I:220）；缺 input |
| insight_delete | api:39 | 4 | 1 | 重复删除、不存在、空 id 均成功；null serde |
| insight_get | api:43 | 8 | 1 | 不存在与空 id 返回 null；缺参 |
| insight_list | api:51 | 11 | 2 | status 大小写不匹配、limit 0/-1/2^53-1、负 offset（均在 i64 schema 内，按 A 结果计）；小数、status 数字 serde |
| insight_list_revisions / list_evidence / list_relations | api:59 / 63 / 67 | 5 / 4 / 6 | 1 / 1 / 1 | 不存在 id 返回 `[]`、删除后级联；各 1 个 serde |
| insight_record_feedback | api:75 | 5 | 6 | 三种 feedback、sessionId 省略/null；未知值/大小写/空（I:355–359）、不存在 id、缺 feedback |
| insight_add_relation | api:94 | 8 | 11 | 7 种 relation_type、自环、重复；未知类型、大写、contradict/supersede 缺 scope 或 evidence（I:468–487）、端点不存在/已删除/空 |
| insight_run_jobs | api:84 | 6 | 2 | batchSize 0/1/null/省略/u32::MAX；-1、u32 溢出 serde。单个 job 失败只 warn，不返回 Err |
| study_time_add | studyTimeTracker.ts:35 | 27 | 14 | date 省略/null/`""`/空白都按今天；单日累计到上限附近（23×3600+…，T:116–177）；seconds 0/-1/3601/±(2^53-1)、日期过旧/过远/格式错/不存在日；小数、缺参、字符串 serde |
| study_time_range | weeklyReport.ts:90 | 7 | 8 | 2026-01-01..2035-12-31、trim、单日、最大跨度 2000-01-01..2010-02-17；空、月份 13、无分隔、倒置、超跨度、坏值（T:35–53）、缺 to、null |
| fsrs_bury_card | fsrsReviewStore.ts:707 | 4 | 6 | 幂等重复埋藏、暂停卡上埋藏；空/空白/不存在 id、卡删除后（F:2416）、缺参/snake_case 键 serde |
| fsrs_unbury_card | fsrsReviewStore.ts:1842 | 4 | 5 | 未埋藏时解除、重复解除；同上错误分支 |
| fsrs_optimize_parameters | FsrsOptimizerPanel.tsx:54 | 3 | 0 | 空 seed 只能到 `not_enough_data`（MIN_TRAINING_ITEMS=8，F:554；同日评分 delta_t=0 被跳过，F:3841）。`compute_parameters` Err（F:4072–4081）与 `optimized`/`already_optimal` 需要跨日历史 seed（X3/X7） |

### `fsrs_get_scheduler_config` / `fsrs_get_stats` 无可达错误

两条命令都没有参数。F:3378 读配置时坏值回退默认并 warn（F:5080–5100）；F:3257 中 `ensure_memory_states_current`
失败只 warn（`src-tauri/src/cmd/fsrs_review.rs:122–126`）。剩下的 Err 只有 DB 连接/查询失败，需要 X7 故障注入。
本包只在埋藏、解除、暂停、更新配置、优化前后各加成功读取步（stats 5 步、config 3 步）。

#### WP-266：逐条 Err 判定（G3 768）

源码审读基线：本分支 merge main `12a07b1b4` 后。C = `src-tauri/src/cmd/fsrs_review.rs`，F 同上，
D = `src-tauri/crates/dstu-storage/src/database/mod.rs`。两条命令都不写 `expect: "error"` 场景。

**`fsrs_get_scheduler_config`**（C:555–559 → F:3378–3384 → F:5080–5196）→ 无可达 Err。

- C:556 没有参数，不存在反序列化错误；函数体只有 `FsrsReviewService::new`（F:997，纯构造）与 `get_scheduler_config()`。
- F:3379–3382 `get_conn_safe` 失败：D:729–737 只有两种情况。D:730 维护屏障拒绝见下方“维护屏障”；
  D:742–755 Mutex poison 被恢复成 `Ok(guard)`，不返回 Err。
- F:5086–5092 `SELECT config_json` 的 `map_err`：只有 SQL 准备/执行失败（表缺失、库损坏）才触发，属 DB 故障。
  默认牌组缺失走 `.optional()` 得 None，`deleted_at` 非空同理，`config_json` 为 NULL 走 `.flatten()`，
  三者都在 F:5095–5097 返回 `Ok(default)`。
- F:5098–5104 JSON 解析失败 warn 后 `Ok(default)`；F:5113–5195 每个字段越界/类型错都跳过保留默认值，
  `read_steps`（F:5140–5144）的 `?` 只在闭包里返回 None，不是命令 Err。函数末尾 F:5196 恒为 `Ok(config)`。

**`fsrs_get_stats`**（C:515–520 → F:3257–3374）→ 无可达 Err。

- C:516 没有参数；C:518 `ensure_memory_states_current` 的错误在 C:122–126 只 `log::warn!`，不传播。
- F:3260–3263 连接失败同上（D:730 维护屏障 / D:742–755 poison 已恢复）。
- F:3265 `load_scheduler_config`：同上一命令，只有 DB 查询失败。
- F:3266 `day_bounds_ms` → `dstu-learning/src/fsrs_scheduler.rs:471–479` 返回元组，无 Err；
  F:3268–3269 `.max(0)` 只做截断。
- F:3267 `load_daily_counters`（F:5207–5228）、F:3280–3329 状态聚合、F:3337–3355 今日评分计数：
  三条 `query_row` 都是 COUNT/`COALESCE(SUM(...),0)`，空表也恰好返回一行，`QueryReturnedNoRows` 不可达；
  剩下的 `map_err` 只覆盖 SQL/类型故障（表缺失、损坏库），属 DB 故障。

**维护屏障（D:730–735，两条命令共用）不写场景的理由**：屏障只在三处建立，`seed: "empty"` 的串行 runner 都构造不出来。

1. 备份快照屏障（`src-tauri/src/data_governance/commands_backup.rs:1095–1140` 进入，`:1173–1181` Drop 时释放）
   只在后台备份任务执行期间存在（`:2006`、`:2808`、`commands_zip.rs:427`），命令本身先返回 job id。
   命中需要并发驱动，属 X7。
2. 恢复切槽屏障（`commands_restore.rs:1198` 进入，成功后保持到重启）由 `data_governance_restore_backup`
   （`:421`）在 `:459` `spawn` 的后台任务设置，前置还要一个已完成的备份。runner（`scripts/electron-migration/record/scenario-v0.mjs`）
   没有等待任务完成的步骤，紧接着的读取会与后台任务竞态，结果不确定。需要 X7 提供任务等待驱动，或 X3 提供“已切槽待重启”种子。
3. 启动时数据治理初始化失败（`src-tauri/src/lib.rs:1370–1416`）需要让治理初始化失败的种子，属 X3。

**State 提取**：`State<'_, AppState>` 在 `lib.rs:1336` manage；`lib.rs:959/972/986/1043/1053/1062/1317` 的恢复启动模式
在 `:1321 build_app_state` 之前 `return Ok(())`，此时 Tauri 返回 “state not managed” 错误（与 WP-246 同一机制）。
`empty` 种子不会进入恢复模式，同样需要 X3 种子。

上述任一前提到位后，在对应种子/驱动下各加一步 `{"cmd":"fsrs_get_stats","args":{},"expect":"error"}`、
`{"cmd":"fsrs_get_scheduler_config","args":{},"expect":"error"}` 即可（调用点 `src/features/flashcards/store/fsrsReviewStore.ts:499` / `:474` 均不传参）。

## 保真约定

- 不 normalize 会话/模式/灵感卡 id、时间戳、`study_time` 秒数与日期、FSRS state id。
- 排序不重排：list_sessions 与 insight_list 在 `updated_at` 相同时没有 tie-break，A/B 顺序不同时如实报告。
- study_time 依赖运行当天：“今天”由省略/null/空白 date 产生，range 固定 2026-01-01..2035-12-31；A/B 需同日同时区运行。
- f32 边界：`100000.001` 在 f32 中舍入为 100000 被接受，`100000.01` 被拒绝；以 A 结果为准。
- 拒绝端口：`http://127.0.0.1:9/v1` 确定性连接失败；每个 stream 网络错误步约 1.6 s 退避。

## 未覆盖（需后继种子/驱动，不计入本包）

1. **stream 成功与轮次数据**：pending-provider 场景需要 X5/X7 脚本化本地 LLM，请求体由 A 录制再比对 B。
   G3-LEDGER 记法：`essay_grading_stream`（在 768）成功路径 `blocked`；owner X5/X7；解除条件 = runner 支持把
   `${provider.url}` 替换进字符串字段并按 `.provider.json` 回放脚本化 SSE；复核人 C2-platform（待 C2 确认）。

在 768 分母内的本包命令 22 条（20 条 essay_grading_*、`fsrs_optimize_parameters`、`study_time_add`），都有可运行的成功步，
`essay_grading_stream` 的成功步除外（见上）。按 D-158，本包已写的错误步保留；L15 后续错误分支由 W-lane（`g3w-*`）负责，
W-lane 可对照上方覆盖表避免重复。
2. **自定义模式文件**：`custom_grading_modes.json` 在 app data 目录（`src-tauri/src/lib.rs:3591`），不在 DB，`capture.db` 看不到；需要 runner 增加文件捕获（X7）。
3. **并发与取消**：`ESSAY_STREAM_ALREADY_ACTIVE`（同一 stream id 并发）、取消流、单张图片 >50 MB 需要驱动支持。
4. **DB/连接故障**：所有命令的 DB 错误、`get_mode_manager` 未初始化、LLM 配置解析失败、insight_run_jobs 单个 job 失败（只 warn）需 X7 故障注入。
5. **optimize 真实训练**：跨日复习历史 seed（X3）。

TESTMAP 映射未改：实际行 123 ported / 5 pending（本包前后相同）。
