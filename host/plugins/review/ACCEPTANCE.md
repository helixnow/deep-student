# L15-review-analytics 独立验收（R5-review-learning，2026-11-04）

结论：不通过

初审基线 `f23c98702`；独立只读审读，未运行 Rust。本目录原无 ACCEPTANCE。历史候选结论保留；最新正常main基线核对见文末。v2允许已集成修复复验签收，本目录尚未集成的候选不据此勾选。

## 必须修复

- [x] **R7 / L15-V2-S4、D3：正常main精确版本链复验签收。** `1e80f32b4`已集成L15/L16/L24对应修复，独立job`20261104203909-c2516b`全部exit0，无Errors：L15 provider5例及L24真实公开CAS4例通过。保留2^53+1、2^63-1024、i64MAX范围、内部bigint比较/SQL绑定与精确TEXT回读、stale不写、精确返回快照、最终wire Number且原对象不变；无缺陷skip。原MAX_SAFE拒绝与缩向量缺陷闭合，不等于所有i64字段或全部工具完成。下方阶段记录为历史。
  **当前main状态更正**：以上拒绝缺陷是306eb8bbb历史快照；a0515bf75/7f9e63ea1现已通过819b970b6正常进入main。独立只读main确认i64Version接受number|bigint全范围，exactReviewVersion返回bigint，无MAX_SAFE拒绝。R7改为“提供方修复已main、独立联合复验待完成”，不再称当前main旧限制仍在；L16 a47/L24 6962尚非main，整链仍未签。
  **a0515bf75候选进展**：检查时仍非HEAD/main，但完整树已移除入参/读取两处MAX_SAFE拒绝，owner快照/记录为bigint，四入口归一number|bigint至非负i64后精确比较/SQL绑定；原R7根因在该候选静态修复确认。提供方新5例通过及旧L24组合2pass/2fail按下文实际result记录，不自动升级main签收。

- [x] **R1 / main原null缺陷复验签收。** `9299fa83e`→`fabf9d048`已含`91c250fe5`；当前 `src/review-config.ts:14-55`用`!= null`/`steps == null`，`src/review.ts:698-714`17个Option仅非null写入，对齐Rust `fsrs_review_service.rs:3394-3474,3524-3628`。独立job `20261104120822-dcf771` 中真实Host回归`tests/fsrs-commands.test.ts:125-139`以17字段同时null检查配置不变，4557ms通过。签收限定原null校验/写入缺陷；总job另有Anki hook失败及Errors4/exit1，不签R6或整套门禁。
- [ ] **R2 / main已补齐scoped提供面，真实完整消费链待闭合。** 当前`index.ts:31-77`公开library enqueue、session/library suspend及undo，原session enqueue/快照/统计保持。提供接口缺失子项已修并进入本轮main；真实L24全部变更/CAS与L16所有权链未由该声明或局部快照测试证明，整项保留。历史候选证据与Rust对照见04:55Z章节。
- [ ] **R3 / main账本已纠偏为121P/7待，业务缺口仍在。** 当前四镜像及legacy-null行均pending（`TESTMAP.md:56-57,73,91-92`），不再报“legacy-null仍ported”。`tests/fsrs-cross-domain.test.ts:452-500`保留真实library/content空集合断言，agent page仍缺；四镜像的生产替换未完成。认可去向纠偏，未把pending改正升级为完整业务迁移。
- [ ] **R4 / FSRS清理/导入消费者已main闭合；独立deck SW仍开放。** `1e80f32b4`的Anki删除/APKG已经真实review同conn owner，生产Anki仓储检索无直接fsrs_card_states/fsrs_review_logs写SQL；本轮真实删除、APKG导入及review事务用例通过。原FSRS重复写子项认可闭合，不再称当前L16仍双写；review两处anki_decks写SQL仍待已发布L16 owner消费，不能连带签收该独立SW范围。
  07:56轮消费者增量：L16 `18c563a46` 已在其分支合L15（`0857832cf`），用真实 `Pick<ReviewService,...>` owner及同一tx调用，删除fallback SQL/测试owner double；生产FSRS写SQL零匹配，APKG真实入队/回滚用例已改真实review。这些消费者修复静态证据已认可，旧“尚未迁接口/仍重复写”的描述只适用于早期快照。候选尚非main，普通删除锁模式与完整失败矩阵仍待核定，R4勾选不变；详见Anki验收07:56轮章节，不重审已确认的L15提供面。
- [ ] **R5 / 高：优化命令及原测试未完成。** 70 条契约命令缺 `fsrs_optimize_parameters`；TS 只实现数据不足，足量历史抛“requires the native fsrs-rs trainer”。TESTMAP 2项 pending，无豁免。按已批准的 F7 方案接训练器并补真实训练行为。（证据：`host/plugins/review/src/commands.ts:259`、`host/plugins/review/src/review-memory.ts:141-174`、`host/plugins/review/TESTMAP.md:84-85`；Rust：`src-tauri/src/cmd/fsrs_review.rs:573-591`、`src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:9606,9630`。）
- [x] **R6 / 独立正常main干净运行证据签收。** job`20261104203909-c2516b`覆盖完整review及anki/chatanki/qbank，160files/1709pass/1外部APKG skip，原始exit0、无Errors/Unhandled；官方固定tip1e80f32b4四项自检全部通过。只关闭原运行阻塞，不用总绿灯覆盖R3/R5或deck SW；旧RPC失败与提供方记录原样保留。

## 建议

- [ ] null 回归应经真实 Host invoke 验证，避免 TS 自定义非 nullable 类型掩盖 wire 契约。
- [ ] 不将只检验 import 图的 wiring 结果表述为“全部业务已接线”；为 scoped 服务增加真实消费者调用证据。

## 已核实通过

- [x] 复核确认：下列19条 scheduler 原测试保留原断言并调用生产函数；FSRS 模型经 `host/platform/native/fsrs` 使用，不在 review 本地另造模型（`src/fsrs-scheduler.ts:11-18,98-114`）。
- [x] 复核确认：评分事务先提交再发事件、再做 outbox 补偿；失败仅记录，20/40ms 重试保留（`src/review.ts:216-295`、`src/commands.ts:178-240,281-303`；Rust `src/cmd/fsrs_review.rs:269-411`）。
- [x] 复核确认：服务名 `mastery`/`review`、声明、运行时提供一致（`index.ts:15,72,76-77`、`api.ts:65-74`）；生产 SQL 在 repository；检索未发现生产 `console.*` 调用/测试目录导入。跨插件导入使用 api；表所有权另见 R4。
- [x] 复核确认：四入口 native import 成功；review wiring 输出126 ported、模块未接入0。它没有覆盖 R2/R3。

## 命令等价抽查（17 条）

TS 根为 `host/plugins/review/`；Rust 命令文件统一为 `src-tauri/src/cmd/fsrs_review.rs`。契约：`contracts/ipc/L15-review-analytics.json`。此表确认命令参数、默认值、返回/事件与对应服务路径；平台 FSRS 数值跨实现逐位一致性不据此宣称已完成。

| 命令 | 结论与行为 | TS 文件:行 | Rust 命令行 |
|---|---|---|---|
| fsrs_enqueue_cards | 通过：写后加载新增卡内容、失败 debug 不发事件 | src/commands.ts:43-60,261-266；src/review-enqueue.ts:95-181 | 109-118 |
| fsrs_get_due | 通过：先记忆升级，再补偿 outbox；limit null 下传 | src/commands.ts:127-169,268-273；src/review.ts:121-153 | 130-189 |
| fsrs_preview_intervals | 通过：掌握度预取失败回退，四档预览不写 | src/commands.ts:72-99,275-279；src/review.ts:299-318 | 193-246 |
| fsrs_rate | 通过：CAS 默认 false、clientOpId/duration null、事务/事件/补偿顺序 | src/commands.ts:281-303；src/review.ts:199-295 | 252-411 |
| fsrs_undo_last_review | 通过：先撤销，再补偿，changed 控制事件 | src/commands.ts:305-324；src/review.ts:364-405 | 417-451 |
| fsrs_suspend_card | 通过：原子、幂等、无变更不发事件 | src/commands.ts:326-333；src/review.ts:347-359 | 457-466 |
| fsrs_bury_card | 通过：下个逻辑日到期、重复无写入 | src/commands.ts:335-342；src/review.ts:321-336 | 472-481 |
| fsrs_unbury_card | 通过：清除 buriedUntilMs、changed 分支 | src/commands.ts:344-351；src/review.ts:321-336 | 487-496 |
| fsrs_unsuspend_card | 通过：恢复与重复恢复分支 | src/commands.ts:353-360；src/review.ts:343-359 | 502-511 |
| fsrs_get_stats | 通过：升级失败 warn 继续，额度/隐藏 backlog 独立统计 | src/commands.ts:362-366；src/review.ts:682-709 | 516-519 |
| fsrs_get_review_statistics | 通过：可空 days 传统计服务，非命令层捏造值 | src/commands.ts:368-369；src/review-statistics.ts:32 | 524-529 |
| fsrs_get_memory_overview | 通过：recentLimit null 传服务 | src/commands.ts:371-372；src/review.ts:718-720 | 535-540 |
| fsrs_get_card_memory_history | 通过：按 state id 读取历史 | src/commands.ts:374-375；src/review.ts:722-724 | 546-551 |
| fsrs_get_scheduler_config | 通过：读取默认牌组配置 | src/commands.ts:377；src/review.ts:636-638 | 556-559 |
| fsrs_update_scheduler_config | 问题 R1；非 null 更新用 immediate 事务，未知键保留 | src/review-config.ts:14-55；src/review.ts:640-678 | 563-568；服务源码:3390-3628 |
| fsrs_reset_card_progress | 通过：立即事务清日志/重建状态，提交后事件 | src/commands.ts:382-388；src/review-memory.ts:24-42 | 597-606 |
| fsrs_optimize_parameters | 问题 R5：未注册 | src/commands.ts:259；src/review-memory.ts:141-174 | 573-591 |

## 测试真实性抽查（20 条 ported）

前19条：Rust 文件 `src-tauri/crates/dstu-learning/src/fsrs_scheduler.rs`；TS 文件 `host/plugins/review/tests/fsrs-scheduler.test.ts`。TESTMAP `:93-111`。

| 测试名 | Rust行 / TS行 | 结论与原断言 |
|---|---|---|
| new_card_follows_default_learning_steps | 551 / 37 | 通过：1/5.5/10分钟、Easy 8天与稳定度 |
| last_learning_step_good_graduates_with_fsrs_interval | 567 / 51 | 通过：毕业2天、Hard重复当前步 |
| single_step_hard_is_one_and_a_half_times_capped_at_one_extra_day | 594 / 68 | 通过：1.5倍/额外一天上限 |
| single_learning_step_good_on_new_card_graduates | 601 / 74 | 通过：单步毕业 |
| review_again_enters_relearning_and_counts_a_lapse | 614 / 82 | 通过：10分钟、lapse只加一次 |
| empty_relearning_steps_reschedule_lapse_in_days | 624 / 90 | 通过：空步长以天调度 |
| relearning_good_graduates_back_to_review | 636 / 98 | 通过：保留lapse、Again仍重学 |
| review_intervals_are_strictly_increasing | 656 / 112 | 通过：原5稳定度×4 fuzz组合 |
| maximum_interval_caps_every_passing_answer | 683 / 124 | 通过：三档全部30天 |
| review_on_due_day_counts_full_logical_days | 698 / 132 | 通过：21点→次日8点算1天 |
| same_logical_day_reviews_use_short_term_stability | 718 / 144 | 通过：稳定度[5,6) |
| rollover_hour_moves_the_day_boundary | 727 / 150 | 通过：上海4点边界及起止时间 |
| learning_step_crossing_rollover_is_due_at_next_logical_day_start | 749 / 161 | 通过：10/360/1440分钟 |
| fuzz_matches_anki_ranges | 766 / 168 | 通过：区间上下界与不抖动阈值 |
| fuzz_factor_is_deterministic_and_bounded | 779 / 179 | 通过：确定性、reps变化、200次范围 |
| fuzz_does_not_regress_below_elapsed_days | 790 / 190 | 通过：Good >30天 |
| sanitize_steps_drops_invalid_entries | 801 / 195 | 通过：负/NaN/零过滤、上限 |
| forgetting_curve_constants_follow_fsrs6_decay | 809 / 199 | 通过：FSRS6/19参数衰减、t=S保留率 |
| missing_memory_on_learning_card_reinitializes_like_new | 819 / 207 | 通过：缺 memory 重入 learning、不计 lapse |
| chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it | fsrs_review_service.rs:8571 / fsrs-cross-domain.test.ts:247 | **问题 R3**：删除被测对象换成测试镜像；真实 SQLite 不能弥补调用对象错误 |

最后一条完整根分别是 `src-tauri/crates/dstu-anki/src/` 与 `host/plugins/review/tests/`。初审快照TESTMAP为126 ported、2 pending、0 merged/obsolete；最新候选已纠偏为122 ported/6 pending（见文末），不将初审计数作为最新状态。

## 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/review
Test Files  13 passed (13)
Tests       143 passed (143)
Errors      1 error
Duration    68.34s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
exit 1

$ npx vitest run -c vitest.host.config.ts host/plugins/review --maxWorkers=1
Test Files  13 passed (13)
Tests       143 passed (143)
Errors      1 error
Duration    91.24s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
exit 1

$ node scripts/electron-migration/wiring.mjs --lane review
合计 ported 126，其中所测模块未从 index.ts 接入 0（0.0%）
```

四入口一起运行 `node scripts/electron-migration/importable.mjs`（包含 `host/plugins/review/index.ts`）：`importable: ok`，退出0。重启前的一次限 worker 运行被服务器取消，不计为通过。

另直接调用生产 `validateSchedulerConfigUpdate`（Node 原生类型擦除，无文件改动），原始结果：

```text
{"desiredRetention":null} CommandError { error_type: 'Validation', message: 'desiredRetention must be within (0, 1)', details: null }
{"learningSteps":null} TypeError Cannot read properties of null (reading 'length')
{"fsrsParams":null} TypeError Cannot read properties of null (reading 'length')
```

## 语义差异分类

- 应修缺陷：R1 的 null、R2 的服务缺口、R3 的测试对象替换、R4 的双写所有权、R5 的未实现优化。不存在“缺训练器所以可以标通过”的批准。
- 已登记技术方案：FSRS 模型复用 F7（`SPEC.md:33`、总方案 `README.md:120`）；优化缺口在 `SPEC.md:557` 登记，但属于待实现而非平台豁免。
- 已登记平台差异：JS 毫秒精度见 `docs/dev/electron-migration/decisions.md:52-59`；不据此豁免 CAS 版本和完整撤销快照。

## 协调者指令1：R2 增量复核

- 提交：`14cbe1b2a` 已是本次合并基线 `4b9c2809b` 的祖先；合入的 main 父提交为 `35b4fbfdf`。
- 真实入口：`index.ts` 创建 Cordis `Review` → `host.ctx.review` 的上述四方法 → `FsrsReviewService` → `repository/fsrs.ts`。新测试创建真实 SQLite 表/任务/卡片，未替换 review 服务（`tests/fsrs-commands.test.ts:11-25,107-123`）。
- 已证实部分：session 入队返回 enqueued=1；session/library 快照返回实际卡ID；7天统计返回 days=7 和非零日限额。这是真实提供方验证，不只是接口声明/源码 grep。
- 尚未证实/未完成：library CAS 入队、session/library CAS 挂起/撤销未出现在 `ReviewService`；真实 chatanki 消费端仍受其自身装载/卡片仓储接线阻塞。本轮不重复审 R1/R3–R5，不因新增方法关闭整项 R2。

运行命令（同时核对 Q6 两个 merged 目标）：

```text
npx vitest run -c vitest.host.config.ts host/plugins/review/tests/fsrs-commands.test.ts host/plugins/review/tests/mastery.test.ts -t 'review_service_exposes_agent_scopes_and_review_statistics|qbank_verdict_correction_false_to_true_recomputes_state|qbank_verdict_correction_is_idempotent_and_supports_reflip' --maxWorkers=1 --no-file-parallelism
Test Files  2 passed (2)
Tests       3 passed | 11 skipped (14)
Duration    4.91s
exit 0

node scripts/electron-migration/importable.mjs host/plugins/review/index.ts host/plugins/anki/index.ts
importable: ok
exit 0
```

11 skipped 为定向 `-t` 过滤。仅 Linux Node；未做 Windows/macOS/Electron 运行验证。**R6 保留资源超时验证阻塞**，本轮小范围测试不替代上轮整目录失败证据；所有验收勾选保持不变。

## C1 04:55Z：仅复核新增 R2/R4 提供面（静态）

审读分支起点 `92a9ef56d`；检查时 main=`c7c15e5b5`。`git merge-base --is-ancestor` 分别检查 `877089c34`、`f221d37fd` 对 HEAD/main，四次均退出1（均非祖先）。因此只用 `git show` / `git diff` 读取候选对象，**没有摘取实现、没有切换/合并候选、没有运行旧代码测试或候选内存测试**。`877089c34` 本身仅改api；下面核对完整快照 `f221d37fd` 的声明与实际接线，不把单份类型声明当作已实现。

### R2：五个新增 scoped 方法

下表路径均在候选 `f221d37fd` 的 `host/plugins/review/`，不是当前工作树行号。

| 方法 | api声明 → 实际委托 | 静态结论 |
|---|---|---|
| enqueueCardsForLibrary | `api.ts:80-82` → `index.ts:31-35` → `FsrsReviewService.enqueueCardsForLibrary` | scope/cards原样传递，返回 `FsrsLibraryEnqueueOutcome`，未改成无条件成功 |
| setSuspendedForSession | `api.ts:96-98` → `index.ts:54-57` | cardId/sessionId/expectedReviewVersion/suspended次序一致，直接返回原CAS outcome |
| setSuspendedForLibrary | `api.ts:99-101` → `index.ts:59-62` | scope/cardId/expectedReviewVersion/suspended原样委托 |
| undoLastReviewForSession | `api.ts:102-104` → `index.ts:64-69` | cardId/sessionId/expectedReviewVersion/expectedLogId原样委托 |
| undoLastReviewForLibrary | `api.ts:105-107` → `index.ts:71-76` | scope/cardId/expectedReviewVersion/expectedLogId原样委托 |

公开参数/返回类型从 `api.ts:11-15` 导出。`meta.provides` 含review（`:170`），apply实例化真实 `Review`（`:175`），构造器注册 `review`（`:17`），不是只有声明或测试对象。接线没有吞掉异常/替换返回值；原scoped校验和事务仍在内部服务。上一轮“这五项未公开”的判断只适用于当时运行基线，**对本候选的提供面应更新为静态确认已补齐**。

### R4：四个所有者事务接口

| 方法 | api声明 → 生产路径 | 静态结论 |
|---|---|---|
| cleanupCardDeletionInTx | `api.ts:109` → `index.ts:78-82` → `src/review.ts:638-639` → `repository/fsrs.ts:1011-1017` | 同一个传入conn执行先删logs再删states；空ID列表不写；失败传播Database错误 |
| cleanupTaskDeletionInTx | `api.ts:110` → `index.ts:84-87` → `src/review.ts:643-644` → `repository/fsrs.ts:1021-1027` | 按task下卡片集合清理logs/states，SQL仍在review仓储 |
| cleanupDocumentDeletionInTx | `api.ts:111` → `index.ts:89-92` → `src/review.ts:648-649` → `repository/fsrs.ts:1031-1043` | 按document关联任务/卡片清理；不直接删除Anki卡/任务 |
| enqueueImportedCardsInTx | `api.ts:113-115` → `index.ts:94-98` → `src/review.ts:653-678` | 传入conn用于配置、默认牌组、insertState；透传cardId/seed；返回enqueued/skipped/withHistory/suspended计数 |

这四个入口内没有另开/提交事务，也没有将SQL换到独立数据库句柄：**具备让L16传同一事务执行器、保留原子边界的提供能力**。接口类型为 `SqlExecutor`，仍由消费方负责传真实事务并安排卡片行删除/导入；不能仅因方法名含InTx就证明端到端原子性。此轮不审核APKG全部算法/错误映射，不据接口存在认定L16重复写表已移除。

### 本轮边界与结论

- R2：新增五方法的公开类型、运行时提供、委托链静态确认；L24真实装载/调用/CAS行为未在此轮验证。
- R4：三个清理入口和一个导入入口静态确认；L16实际采用、旧SQL退出、同事务失败回滚仍待后续交付证据。
- 候选未在main集成；测试命令：**未运行**，测试退出码：**不适用**。上一轮exit0结果不转借给这九个新入口。
- R2/R4保持未勾选，不重新复核C1/C5，不关闭Q7/R6。Windows/macOS/Electron与跨平台行为未验证。按协调者要求记录后结束，等进入可运行基线再按增量需要做最小真实服务验证。

## C1 05:34Z：R1/R2/R3子项/R4/R6定向复核

### 基线、规范与运行范围

- 本轮审读HEAD=`b2b138fe7`；检查时main=`11b57346f`。候选 `8d213a08f`、null修 `91c250fe5`、service/cross-domain `ec41ef932`、实跑快照 `c07bd04d1` 均非HEAD/main祖先（八次 `git merge-base --is-ancestor` 均exit1）。只读git对象，未摘实现、未切分支、未在旧基线重跑新增测试。
- 已只读main的 `docs/dev/electron-migration/decisions.md:102-138`（D1–D6）和 `quality.md:116-128`。按D1/D4，消费方传同一SqlExecutor给表所有者是允许的原子接缝，不将“带conn”误判为违规；FSRS归L15、卡片归L16。按D3，内部整数/时间精度要求与IPC数字表示分开，早期毫秒精度备注不作为内部值丢精度豁免。本轮不修改/重新认证这些数值契约。
- 下面行号统一指 **`8d213a08f` 候选树**。`git diff c07bd04d1 8d213a08f -- host/plugins/review` 无差异，但其他依赖/集成状态不能据此当作相同运行环境。

### R1：17字段null在校验和写入层均保持None语义

`src/review-config.ts:15-55` 将null与undefined一并跳过；`src/review.ts:698-714` 对17个Option字段均用 `!= null` 判断。`fsrsParams:null` 不进入参数更新和清除optimized元数据分支；learning/relearning steps为null不访问length。原非null校验范围/错误文案保持，更新仍在immediate事务（`:687-724`）。这里的no-op指字段值不被null覆盖，不宣称整次调用绝不写配置元数据——Rust也保存合并配置。

回归 `tests/fsrs-commands.test.ts:125-139` 调用真实 `host.invoke('fsrs_update_scheduler_config', {update})`，17字段同时null，断言结果与调用前配置相等；宿主安装真实review/storage（`:11-25`），不是直接测替身。**R1具体修复静态确认，运行证据归C1核实的分支套件；本轮未亲跑该候选。**

### R2：真实review→真实L24消费的局部证据

新增 `tests/l24-review-state-consumer.test.ts:15-23,63-105` 安装真实review和chatanki；先经 `host.ctx.review.enqueueCardsForSession` 入队，再经 `host.ctx.chatankiTools.execute(chatanki_get_cards)`，断言返回 `cardStateId/ankiCardId/reviewVersion=0` 来自真实review状态。认可这条公开快照消费路径。

限制也明确：`:21` 提供空 `anki@1`，`:86-91` 自写cards对象只返回预置卡与ownership结果，未安装真实L16；没有覆盖scoped挂起/撤销、library CAS写或真实L16版本冲突。因此不是完整L16/L24/CAS端到端证明，R2整项不勾选。此前九个提供接口的静态结论仍有效，不重复审读已确认的委托链。

### R3：真实命令替换确认与剩余问题

| 用例 | 增量证据与结论 |
|---|---|
| deletion_paths_and_tombstones_do_not_leave_schedulable_ghosts | `tests/fsrs-cross-domain.test.ts:395-446` 安装真实Anki/review，`:408,413,420` 分别invoke删除卡/任务/文档会话；原直接SQL触发器、墓碑隐藏、恢复后历史与可评分断言保留，对照Rust `fsrs_review_service.rs:9049-9127`。被测删除已从测试镜像换到生产命令，认可这一子项。 |
| legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue | `:448-482` 的list/content读取已改真实Anki命令；SQL NULL未被改写、enqueue返回空tags/images/extraFields仍有断言。**真实路径改进确认，但原断言覆盖未全齐**：Rust `:10135-10154` 还断言library及agent page所返回的tags/images/extra_fields为空；TS读取侧只检查total/IDs与content非null（`:462-470`），这不能证明读取返回字段归一化。 |

仍需替换或先改pending的四条（候选TESTMAP仍ported，未自行修改）：

1. `soft_deleted_card_is_hidden_from_agent_crud_and_fsrs`，测试`:135-185`，TESTMAP`:56`。
2. `soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated`，测试`:188-250`，TESTMAP`:57`。
3. `chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it`，测试`:253-292`，TESTMAP`:73`。
4. `agent_library_delete_conflicts_when_user_rates_after_preflight`，测试`:484-521`，TESTMAP`:92`。

这四条依然从 `tests/anki-data-layer.ts` 导入被测CRUD/CAS（`:15-24`）。fixture建数据与只读计数可保留，不能把测试目录业务实现当生产实现。

### R4：传入conn的提供方保证与测试边界

`tests/service-transaction-api.test.ts:9-14` 安装真实review，使用真实SQLite；三条分别为：

- `review_service_cleanup_shares_the_callers_transaction`（`:54-74`）：真实 `host.ctx.review.cleanupCardDeletionInTx(tx,...)` 与卡片删除同事务；抛错后卡/state都还在，提交后都清除。
- `review_service_enqueue_imported_cards_shares_the_callers_transaction`（`:76-106`）：真实导入接口与测试创建的卡行一起回滚/提交；重复card被skip，计数与持久化state一致。
- `review_service_import_summary_counts_history_and_suspended_seeds`（`:108-134`）：验证历史/挂起seed统计及suspended持久化，**第三条不是回滚用例**。

提供方实际代码继续使用传入conn、未私自另开事务，与D1接缝一致（`src/review.ts:638-678`）。这些是有效的生产服务测试设计，不是FSRS镜像；但未调用真实L16删除/导入服务，且未覆盖cleanupTask/Document两入口。当前候选里的L16删除命令仍直接进入其repository写FSRS SQL（`host/plugins/anki/src/plugin-handlers-cards.ts:221-247`、`repository/anki-cards.ts:221-273`），所以真实Anki删除测试通过也不等于已消费L15所有者接口。L16更新的session API候选不在本次指定快照审读范围，不据通知自动签收。

### R6：新运行证据按来源和快照单列

证据来源是 **C1 05:34Z对原工具事件的核验**，不是实现者自述，也不是R5本轮运行：

| 快照/范围 | C1核实的结果 | 退出码可信度 |
|---|---|---|
| `c07bd04d1`，review完整目录 | 150 passed；无Errors/未处理错误 | 命令捕获code并以该code退出；真实exit **0**，不是tail退出码 |

指令未附该工具事件的完整命令文本/全部flags，本报告不伪造命令原文或“Errors 0”的stdout行；保留C1核实的范围、无Errors事实和真实exit0。**R6对该分支快照已有干净运行证据**，历史RPC错误不再是它的当前失败结论；R6签收勾选按协调流程保持不变，不把这次分支绿灯转为main及消费者链通过，也不转借给Q7。

本轮R5测试：未运行（退出码不适用）；候选未集成，按quality§10不重复旧全量来证明候选。所有验收勾选保持不变；Windows/macOS/Electron未验证。进入可运行基线后仅按新增必要单元验证，不无依据重跑已确认的旧全量。

## C1后续纠偏：`83bca9a29` / `4ceacd86b`（仅新增证据）

审读起点 `f330c030a`，检查时main=`f37426009`；两候选对HEAD/main四次祖先检查均exit1。只读git对象；未重跑测试、未摘实现、未重复L24/L16尚无修复提交的问题。以下行号指 `4ceacd86b` 的 `host/plugins/review/`。

1. **四条账本纠偏已确认。** `TESTMAP.md:56,57,73,92` 已从ported改pending，表头`:12`与逐行统计均为 **122 ported / 6 pending**（四镜像加原两优化器）。测试保留并注明MIRROR不是生产替代；退pending不是断言回归，也不是业务完成。此前05:34Z章节“仍ported”仅描述 `8d213a08f`，不适用于最新候选。
2. **legacy-null读取字段已补。** `tests/fsrs-cross-domain.test.ts:466-485`经真实 `list_anki_library_cards` / `get_anki_library_card_content`，新增 `tags:[], images:[], extra_fields:{}` 断言；`:493-498`保留真实入队字段断言。认可已修部分，不重复要求这些现有断言。
3. **agent page仍缺，不能完整计ported。** 原Rust `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:10142-10154`调用 `list_anki_agent_library_cards` 并检查total/tags/images。候选`:486-487`只有待补注释，无真实agent page调用/断言；`TESTMAP.md:91`仍ported。两个不同读取入口即使共享mapper也不能互相代替行为覆盖，R3仍开放。
4. **L24测试范围声明纠正。** `tests/l24-review-state-consumer.test.ts:1-3`已明确只证明真实review快照被L24读取，cards对象与anki@1仍为替身，不证明真实Anki装配/ownership/CAS；该声明与上轮独立结论一致。

运行证据来源：C1已读取提供方 **job `20261104064103-da0785`** 的result，报告 **8 tests，exit 0**。这是提供方文件运行结果且包含保留镜像，不能将8条全绿计为生产完成；本轮R5未重新取result或执行该文件，不伪造完整命令/Errors原文。R5本轮无新作业、测试退出码不适用。R6先前快照干净运行证据与这次局部结果分别保留，不外推main集成/消费者闭环。

所有验收勾选不变；L15整体仍不通过。L24 regex、L16 ready/abort/trigger/A6等待明确新修复提交，不重复旧静态审读；跨平台/Windows/macOS/Electron未新增验证。

## v2 main基线核对（`d414183bf`→`add36c913`）

本轮实际main尚未含 `91c250fe5`、`8d213a08f`、`877089c34`、`f221d37fd`、`83bca9a29`、`4ceacd86b`（对HEAD/main祖先检查均exit1）。故顶部已认可的后继候选修复不撤回，但不能签成main闭环：

- **R1**当前main `src/review-config.ts:15-55`仍用`!== undefined`，steps只跳过undefined；真实null回归未进入当前`tests/fsrs-commands.test.ts`。后继候选已修不等于运行树已修。
- **R2/R4**当前`index.ts:25-52`公开session enqueue/快照等局部面，尚无候选中的完整scoped变更及cleanup*InTx；L16候选已消费真实owner且后继普通删除deferred修复认可，但两侧候选未入此main。
- **R3**main实际TESTMAP **126 ported/2 pending**，四条镜像在`:56,57,73,92`仍ported；候选122/6是另一快照，不能将其纠偏计入当前账本。最新候选legacy-null library/content断言认可，agent page仍缺。
- **R6**独立main作业`20261104105734-f5cb83`包含review/anki/chatanki三目录，命令`npx vitest run -c vitest.host.config.ts host/plugins/review host/plugins/anki host/plugins/chatanki --maxWorkers=1 --no-file-parallelism`；86 files pass/2 skip，1200 pass/13 skip，Errors1、exit1（RPC onTaskUpdate timeout）。fsrs-cross-domain8条、fsrs-commands5条报告通过，不抵消Errors。不能将C1早先150pass候选结果转移到此基线。

最新门禁要求下已正常merge main至`add36c913`，六目录串行作业`20261104112238-eb7e77`及typecheck/boundaries已排队。原独立enqueue作业仍只证明真实L15写入与事件，card预检Double限制保留，未重复执行。后继L16 A3/A4/A6新增差异已单独完成审读，不再停留在“等待提交”。

C1后续说明已核对：`95d567a50`将L15候选消费者测试的旧`anki@1`改为`anki`，检查时仍非HEAD/main。不能拿L16旧依赖树的启动问题要求再修一遍该行或新增旧服务名兼容。该改动依然提供空anki与显式cards对象，只证明review快照局部消费，不把服务键纠正升级为真实Anki ownership/CAS证据。

### `dbf5cf87a` owner与性能证据交接

候选仍非HEAD/main。独立静态核对`src/mastery.ts:127-129`→`repository/mastery.ts:103-112`：`recordInsightRecallVerdictWithConn`在caller conn上INSERT OR IGNORE，使用caller now，不开事务、不重算状态、不回流profile；L17消费者后续需保留该原语义。

C1亲取提供方`20261104111818-7413d8` 10pass/exit0、`20261104113541-7ec1fd` 17files/170pass/exit0；R5未重跑/重取，不伪造Errors输出。`tests/storage.ts`确实完整迁移模板、checkpoint并close后，每例复制到独立目录，未见共用可写测试库。性能通过不签R1–R6业务，不替代本次独立六目录作业exit128/SIGTERM及旧三目录Errors1/exit1。勾选保持原状态，等待正常main消费者最小复验。

## §5合并后的正常main增量（9299fa83e / fabf9d048）

自动续派先merge main得到`fabf9d048`，相对已启动自检的`9299fa83e`仅门禁构建槽配置变化，host/contracts/Vitest配置无差异。`91c250fe5`、`4ceacd86b`、`95d567a50`现为HEAD祖先，`dbf5cf87a`仍不是。此前“候选未main”章节保留为旧快照，不套用到当前代码。

- R1验证/写入两层null及17字段Host回归现已集成，独立结果待统一自检返回。
- R2/R4提供方完整scoped变更与cleanup*/enqueueImportedCardsInTx已在当前`index.ts:31-98`可达；L16当前 `repository/anki-cards.ts:223-259`仍直接DELETE fsrs表，故不能签消费者单写者闭环。
- R3当前121P/7pending；包含legacy-null在内的五个不完整项均已退pending。旧122P/6pending不再是最新main计数。
- 本轮没有重提六目录或重复已启动的自检；该自检实际列typecheck/boundaries/importable/tests四项，结果尚未回到会话。不把提供方170pass转借为本轮独立通过。

### C1日志候选0edd575cd增量（未main）

静态核对确认该候选保留的两条fsrs_get_due warn（`src/commands.ts:134-139,160-166`）不对应Rust日志：`src-tauri/src/cmd/fsrs_review.rs:147-151`的matches!(revert,Ok(Some(_)))及`:157-165`的record(...).is_ok()原为静默错误。按C1已派回事项保持未签，不能以信息更多豁免，也不重复派单。

fsrs_rate/undo的原warn/debug专用文案恢复另行认可，对应Rust`:309,321,329,364,432,439`；不要把修复上述两处静默差异扩成删除原日志。候选对HEAD/main均非祖先，18/11pass等为提供方说明，本轮未跑新测试或重新自检。详细N2/N4同期候选审读在R5总报告。

### P0 D3同根回归：main提供方与L24候选测试

`227d44de4`把旧Number读取改为typeof+CAST TEXT，是精确读取的部分进展；但新增MAX_SAFE拒绝及number内部表示不符合D3。不能在“舍入”和“拒绝合法输入”之间任选一种当等价修复。最小成功向量为可由JS Number精确表示的`2^63-1024`（非负且在i64内）：原Rust允许其作为CAS token，main在入参校验已拒绝。库内`9007199254740993`同样是合法i64，读取侧不得仅因发布wire number而失败。

L24 `342c61556`把真实L15测试LARGE从`2**63-1024`改为`Number.MAX_SAFE_INTEGER-1`，并新增断言`local_version 9007199254740993 exceeds the exact JS integer range`。该测试用expected=MAX_SAFE而库值=2^53+1，两值不等，本应保留正常Conflict语义；不能声称此输入应成功，也不能认可范围Database错误。需恢复原大i64成功向量，SQL回读用safeIntegers/CAST TEXT核实精确+1，不用number舍入后的相等掩盖数据差异。

当前audit HEAD尚未合入这份更新，但main已含原回归；本轮以只读main源码确认，无需运行错误期望测试。原R1 null签收不受影响，R7与C3/D3作为同根跨lane事项记录，不重复派单。

后继L24 `c5c8ce42c`完整树已恢复原`2^63-1024`与bigint/TEXT/+1/stale断言，静态认可；但新增skipOnL15PrecisionDefect在三条正向路径断言前跳过已知Validation/Database精度拒绝，故测试保证仍未完整恢复。C1已要求立即移除helper/skip，L15输入与存储两点仍由既有owner派工处理；本轮不重复派实现或运行这些错误期望路径，详见Chatanki C3增量。

### R7 a0515bf75后继：完整i64 owner链静态确认，main待验

实现位于`21b30f5ff`/`6a32027af`，`a0515bf75`发布api及说明；检查时非HEAD/main。本轮只审D3相关新增差异，不把累计树的S1/S2等其它修改一并签收。

- `src/review.ts:i64Version`接受整数number或bigint，立即BigInt归一并校验0..i64MAX；四个Session/Library suspend/undo入口均使用该值比较并传repo，不再用Number.isSafeInteger。
- `repository/fsrs.ts:878,888-905`保持CAST TEXT→BigInt并移除安全范围拒绝；`:949-983`两个CAS写方法以bigint绑定expectedVersion，SQL仍原式+1。快照`src/fsrs-types.ts:326-330`及公开Service/index签名同步，内部不提前Number化。
- 原Rust `fsrs_review_service.rs:2959-2963`写后精确回读成功才commit；候选保留SQLite MAX+1变REAL后读失败→整事务回滚，不提前拒绝合法i64MAX输入，也不clamp。
- `agent-review-version.test.ts`5例经真实review provider：2^53+1与2^63-1024分别覆盖邻值stale、暂停/恢复、撤销、SQL TEXT+1/类型；MAX覆盖可读/幂等、stale及溢出时状态/日志均不变。`toWireJson(before)`另断言number且未改变原bigint对象；这是生产边界函数证据，不外推完整L04/L16消费者。
- 小值原断言0/1/2/3改0n/1n/2n/3n是相同Rust i64值的精确内部表示修正；原大数输入范围未缩小。原“2^53+1应报范围错误”断言已移除，改为合法更新和邻值Conflict，非法i64输入/REAL单元仍拒绝。

**提供方原result（本轮已取，非R5独立运行）**：

| 作业 | 实际范围/结果 |
|---|---|
| `20261104145637-b0a249` | agent-review-version **5/5**与fsrs-review **69/69**通过；整个4文件job为**2 files failed/2 passed，2 tests failed/81 passed，exit1**。失败在cross-domain与l24-review-state-consumer的旧0/0n断言；6a32027af后继树已改并保留wire=0断言。不能把“job中5例通过”写成全job通过。 |
| `20261104150540-a52cf7` | `npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/review-executor-real-l15.test.ts`，**2pass/2fail/exit1**。这是旧execute+直接FsrsReviewService注入，不是新版公开provider/hydrate链。undo大i64和越界拒绝通过；suspend成功/changed以及stale conflict断言先通过，随后该快照文件`:99,125`用number LARGE+1与内部bigint比较而失败。 |

两个完整日志均在`/home/dsdev/.oc-jobs/done/<ID>.log`，无Errors/Unhandled段。第二作业实际收到`9223372036854774785n`，旧number期望显示`9223372036854775000`；正确内部oracle是`BigInt(LARGE)+1n`，数据库用safeIntegers/CAST TEXT，只有wire另验Number。该运行树中的L24文件是保留旧内部number断言的版本，不能混成c5c8ce42c runtime-skip版，更不能要求恢复错误MAX_SAFE拒绝来使旧断言通过。

L15交付称a0515bf75相对main879e0a56b自检5/5绿，作为提供方报告单列，本轮未取该自检各项原作业，不转为R5 main签收。R7保留开放至正常main最小复验；C3仍需消费者保留原向量、精确内部/SQL oracle及无缺陷skip。未修改L24测试或SQL，未提交新运行作业。

C1后继核对已纳入：L24 `48063ba9b`确已撤掉runtime skip，不能继续列为该版本未修；但新公开provider链漏了两个输出快照reviewVersion断言，仅有SQL TEXT检查。旧`a52cf7`直接类注入的2pass/2fail不证明新版公开服务链，须在正常main组合中保留2^63-1024、stale不写、精确内部返回值及wire边界后最小复验。

再后继`de19f72a0`已补成功/冲突/undo输出bigint及wire副本/内部不变断言，静态认可测试保证恢复；L16 `a47f42ded`内部删除CAS/读取亦已改精确i64。两方候选仍非main，L24 API仍number且L16兼容断言tsc exit2，故不由提供方局部5pass签R7/C3联合链。相关证据与wire例的注入快照限制已分别记入Anki/Chatanki报告。

最新L24 `6962cbfed/e8b2046c1`的API/六decoder现已对齐完整i64，静态认可，不再沿用de19的number类型缺口。其44pass是解析/consumer子集；L16输入1df97b515与L24候选api的只读内存compiler-host检查`20261104153009-ff06f8` diagnostics0/exit0，只证明候选接口兼容，无provider执行或磁盘覆盖，不覆盖原正式typecheck失败。R7仍待正常main三方公开链最小复验，所有已取原始job状态保持。

### SW两写点：本地anki_decks的L16 owner候选

L16 `474e38f29`（非HEAD/main）从anki/api.ts同步导出ensureDefaultFsrsDeckWithConn与writeFsrsDeckConfigWithConn；独立核对仅传入conn.run，保Rust默认INSERT OR IGNORE、live-only更新、原JSON字符串、同内容仍增local_version及raw StorageError。当前已审review基线`repository/fsrs.ts:72-77,159-164`仍有两处直接写anki_decks，分别在L15包装“确保默认牌组失败”/“写入牌组调度配置失败”。消费后应保这两边界且不双包，不另开连接或拆出原事务。

提供方`20261104155443-cf2669`4pass/exit0已取，测试withReview:false，只证明owner函数/真实库及caller事务，不证明L15已消费。C1所述154906的3例基线绿亦不证明SQL消除；待消费提交正常main后做两写点最小同conn/同tx/错误边界核验。与R7的i64 CAS及原FSRS cleanup消费者范围分开记录，不自动关闭R4或其他项。

SW最新状态以`84f328310`为准：`77c4bef2a`曾真实删除两写SQL、传原conn/tx/JSON.stringify并保原错误包装；84已显式撤回该消费，因为474尚未main导致缺导出失败，不能阻塞a0515 D3。当前两写点恢复，SW仍开放。L15已parked，不派新工作；正常先owner再重应用consumer，C2已有顺序。

已取**提供方临时组合**`20261104160521-9ce58d`：树HEAD5b728ccee（父77+474），3files/10pass/exit0，无Errors/Unhandled段；deck3、cleanup/import3、owner4分别保留范围。`20261104160521-4c059f` tscexit2仅旧L24SurfaceCompatibility:210；clean组合树不等于正常main，10pass不覆盖正式缺导出失败、原类型失败或R7/D3。R5只读其metadata/result/clean状态，没有构造或执行临时混合树。

## 1e80f32b4正常main独立复验（2026-11-05）

官方自检tip1e80f32b4/main5b1b19055，四项全通过；测试job20261104203909-c2516b原始**160files、1709pass/1skip、618.35s、exit0，无Errors/Unhandled**，不是baseline豁免失败后变绿。唯一skip为Anki外部APKG环境fixture。类型576f49、边界a46bb6、导入4f71e1（完整前缀20261104203909）均exit0。

R7精度链与R6运行阻塞签收。真实公开L24→hydrate→review CAS4例、review provider5例、L16精确删除5例均通过；L16 list wire其中1例依旧注入review快照，其限制不抹去，真实L24链是另外独立证据。R4原FSRS所有者迁移认可，deck两写点仍自写且未随474 owner发布而迁移；R3未完成测试/optimizer消费R5仍开放。F7训练器接口已main不等于review optimize已使用，当前review-memory.ts仍对足量数据抛requires trainer，不能以提供方新能力关闭消费者。
