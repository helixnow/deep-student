# Wave2-E R7-07：混合态 + nullable 测试补强

- 轮次：0824 Wave2-E 第 7 轮「混合态+nullable 测试」
- 模型：`claude-fable-5-thinking-high`
- 纪律：只写测试不跑（vitest / cargo test 统一第 8 轮执行）；未改任何产品代码；未 commit
- 范围：
  - 扩展 `src/features/anki-tasks/__tests__/classify.mixed.test.ts`
  - 新建 `src-tauri/tests/anki_nullable_card_reads.rs`（真实集成测试，非骨架）

## 一、混合态前端测试扩展（classify.mixed.test.ts）

r3-06 的既有断言是逐例锁定；本轮在文件末尾追加 describe
`classify mixed-state contract — r7 extensions (truth table & partition)`，
把契约升级为系统性质锁定（与既有 `classify.mixedState.test.ts` 的逐例断言不重复）：

| 测试名 | 锁定内容 |
| --- | --- |
| `locks the full zero/non-zero truth table over (failedTasks, activeTasks, pausedTasks)` | (failed, active, paused) 零/非零 8 组合全覆盖；预期由独立函数按 types.ts 注释声明的优先级推导（非照抄实现分支），任何分支顺序改动会精确暴露翻掉的组合。非零值取互不相同的 2/3/4，防「恰好 1」掩盖计数调换回归 |
| `keeps hasWarnings orthogonal on the same truth table …` | 同一张真值表上：徽章点亮 ⇔ 失败与运行/暂停并存（纯 attention 不点亮）；且徽章计算从不搬组 |
| `partitions any session list into exactly one tab group (FilterTab count contract)` | 三组计数之和 = 会话总数（无遗漏、无重复），「全部」tab 口径依赖的全划分性质 |
| `fast-poll predicate also sees a failed+paused (nothing running) session` | 补齐既有轮询锚点未覆盖的 failed+paused（无运行）形态：仍须维持 5s 轮询 |
| `counter drift beyond totalTasks does not flip the grouping …` | classify 契约输入只有三个状态计数：计数与 totalTasks 漂移不改变分组 |
| `optional warning fields on a mixed active session light the badge without moving the group` | optional `warningTasks` / `completedWithWarnings` 与混合态并存时的叠加语义 |

文件既有内容（r3-06 的 6 个 it）未改动；仅头部 import 增加
`hasWarnings` 与 `SessionGroup` 类型。

## 二、nullable 读侧 Rust 集成测试（anki_nullable_card_reads.rs）

### 结论：有 pub 读 API 可测，写的是真实测试而非骨架

r5-03 落地的读侧防御所在函数几乎全部是 `pub`：
`Database::new` / `get_conn_safe` / `get_cards_for_task` / `get_cards_for_document`
/ `get_cards_by_ids` / `get_cards_for_document_for_session` / `get_recent_anki_cards`
/ `list_anki_library_cards`，以及 `FsrsReviewService::new` / `list_feedback_rows`。
既有集成测试（`anki_fsrs_feedback.rs`）已示范同样的组装方式。

### 关键设计：手建「历史形态」库

当前迁移产物（`migrations/mistakes/V20260130__init.sql:180-197`）的
`anki_cards.front/back` 带 NOT NULL —— 对迁移后的库直接 INSERT NULL 会被
约束拒绝。这恰好印证 r5-03 的前提：NULL 只存在于**历史库**（旧建表语句
无 NOT NULL、兼容性 `ALTER TABLE` 补列允许 NULL）。而 `Database::new`
只开连接、不建表（生产 schema 由 MigrationCoordinator 负责，
`database/mod.rs:1184-1225` 无任何 DDL），所以测试先用裸 rusqlite 按历史
形态建最小 schema（六个目标文本列全部不带 NOT NULL），再用
`Database::new` 打开同一文件走公开读 API —— 与「旧库被新版本代码读取」
的真实场景同构。

夹具三卡同任务：全 NULL 行（`card-null`）、健康对照行（`card-ok`）、
非法 JSON 行（`card-badjson`，验证 mapper `.ok()` 软解析）。

### 测试清单

| 测试名 | 覆盖读路径（r5-03 改动点） |
| --- | --- |
| `get_cards_for_task_defaults_null_columns_instead_of_failing_the_batch` | `get_cards_for_task` 内联 mapper：NULL → 默认值、整批可读（修复前 InvalidColumnType 全批失败）、非法 JSON 软解析、对照卡不被污染 |
| `document_id_and_recent_reads_share_the_same_null_defaults` | `get_cards_for_document` / `get_cards_by_ids` / `get_recent_anki_cards` 三条内联 mapper 与 task 路径行为一致 |
| `session_scoped_read_uses_shared_mapper_defaults_and_keeps_ownership_guard` | 共享 `map_anki_card_row` 路径；同时锁定 nullable 兜底不放宽归属校验（非归属会话仍返回 None） |
| `library_listing_survives_null_rows_and_reports_full_totals` | `list_anki_library_cards`：总数含坏行、页内可读、LEFT JOIN 两侧（有/无 fsrs 调度行）enqueued/state 正确 |
| `fsrs_feedback_rows_default_null_front_and_tags` | `FsrsReviewService::list_feedback_rows`：NULL front/tags_json 兜底（front → 空串、tags → 空 Vec） |

断言语义与 r5-03 声明一致：`front`/`back` → 空串；`tags`/`images` → 空
Vec；`extra_fields` → 空 HashMap；`text` 本身 `Option` 保持 `None`。

### 第 8 轮 in-crate 欠账（本文件覆盖不到，已写入测试头注释）

1. `fsrs_review_service::get_due_inner::map_due_row`——SQL 已 COALESCE，
   读侧 Option 属双保险；要验证兜底本身需 in-crate 单测构造无 COALESCE 读取。
2. `fsrs_review_service::load_review_cards_for_states`（**私有**）——
   「NULL → 兜底默认」与「非法 JSON → 仍报 `AppError::database` 硬错误」的
   区分语义（r5-03 特意不放宽的数据损坏检测）只能 in-crate `#[cfg(test)]` 锁定。
3. `is_error_card` NULL 不在 r5-03 契约内（mapper 仍硬取 i32），测试的历史
   schema 保留其 NOT NULL DEFAULT 0，不私自扩大契约面。

## 三、约束自证

- 未改产品代码：`src/features/anki-tasks/types.ts`、`src-tauri/src/**` 零改动；
  本轮只新增/扩展测试与文档三个文件。
- 未跑测试/编译：vitest、cargo 均未执行（第 1–7 轮禁令；第 8 轮统一执行
  `npx vitest run src/features/anki-tasks/__tests__/classify.mixed.test.ts`
  与 `cargo test --test anki_nullable_card_reads`）。
- 未 commit：按本轮指令，改动留在工作区。
- 静态自查：Rust 测试引用的类型/签名均逐一与源码核对
  （`models::AnkiCard` 字段类型、`AnkiLibraryCard.state: Option<i32>`、
  `FsrsFeedbackRow.stability: Option<f64>`、`list_anki_library_cards`
  五参签名、`Cargo.toml` 未关 autotests 故新测试文件自动发现）。
