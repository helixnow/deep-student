# serde 表示差异审计（宿主 DB 写入 + IPC 返回值 vs Rust）

> 生成：`node scripts/serde-audit/audit.mjs <ds-g3-DIFF-TRIAGE.json.gz>`（HEAD `2b37d5c5`）。完整条目见同目录 `audit.json`。

## 输入与范围

- Rust：805 个 .rs（`src-tauri/src`、`src-tauri/crates`，不含测试），1531 个 Serialize 类型；serde_json 写库 302 处，覆盖 124 个表列。
- 宿主：1668 个非测试 .ts，SQL 写语句绑定参数 2822 个（INSERT/UPDATE/UPSERT 列级映射）。
- IPC：24 份 `contracts/ipc/*.json`，1058 个有返回值的命令。
- G3：`ds-g3-DIFF-TRIAGE.json.gz`（sha256 `6f9de78fce58…`，937 组，2026-11-06T15:40:34.302Z）。DB 文本逐字节比较；IPC 比较器按值比较、忽略键序，只暴露 None 与数值精度。

## 方法与置信度

1. **宿主**：TypeScript AST 找 `db.run/get/all/…`（含 `prepare(sql).run`）的写语句，按 `?N`/`$name` 把参数映射到列；对参数表达式回溯 JSON 来源（局部变量、`??`/三元、辅助函数返回值、唯一命名函数的形参 → 全部调用点）。来源为 `JSON.stringify` 即“裸写”；`toRustJson` 等视为已对齐。
2. **Rust**：tree-sitter 扫 Serialize 类型（字段声明序、`rename_all`/`rename`、`skip_serializing_if`、`flatten`、f64/f32/Option/HashMap/BTreeMap/u64/chrono/enum 标记，递归展开）；扫 SQL 字面量 → `params![…]`/命名参数 → `serde_json::to_string(&x)`/`json!`/`Value::to_string`，再解析 `x` 的静态类型（`let x: T`、形参、构造器、字段访问、函数返回类型）。
3. **G3**：`lib/classify.mjs` 对每个 A(Rust)/B(宿主) 文本差异分类（`f64-integer`、`f32-precision`、`none-null-vs-omit`、`skip-default`、`key-order`、`time-format`…），按表列/命令汇总。
4. **判定**（`lib/decide.mjs`）：`high` = G3 已复现，或静态可证（对象字面量键序 ≠ Rust 声明序、字面量缺 Option(null) 键或给 skip 字段写 null、pretty 不一致）；`medium` = Rust 类型已解析且宿主裸写；`low` = 来源/类型未解析或只在大数值时出现。`自动判定` 之外均标 **需人工核对**。

## 统计

有差异的条目 454 个（DB 209，IPC 245）；按 (类型, 表列/命令) 合并后 346 处，其中 G3 已复现 20 处。

### 按差异类型

| 差异类型 | 判定数 | DB | IPC | high | medium | low | 自动判定 | 需人工核对 | G3 复现 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| f64 整数 `.0` | 88 | 88 | 0 | 33 | 7 | 48 | 33 | 55 | 33 |
| None（null/省略） | 250 | 36 | 214 | 13 | 223 | 14 | 13 | 237 | 13 |
| 键序 | 76 | 76 | 0 | 17 | 0 | 59 | 17 | 59 | 17 |
| 精度（f32/u64） | 73 | 32 | 41 | 3 | 45 | 25 | 3 | 70 | 3 |
| 其他 | 139 | 91 | 48 | 0 | 0 | 139 | 0 | 139 | 0 |

### 按插件

| 插件 | DB 条目 | IPC 条目 | f64 | None | 键序 | 精度 | 其他 | 需人工核对 | G3 次数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| anki | 23 | 5 | 12 | 8 | 17 | 0 | 4 | 23 | 2617 |
| chat | 24 | 27 | 7 | 36 | 4 | 6 | 32 | 76 | 994 |
| review | 2 | 19 | 2 | 9 | 1 | 12 | 0 | 20 | 781 |
| vfs-repos | 78 | 0 | 41 | 13 | 33 | 21 | 24 | 107 | 82 |
| platform/errors | 0 | 4 | 0 | 4 | 0 | 0 | 0 | 3 | 16 |
| agent-orchestration | 4 | 25 | 0 | 22 | 2 | 5 | 4 | 30 | 14 |
| vfs | 7 | 17 | 6 | 18 | 2 | 3 | 1 | 28 | 12 |
| notes | 17 | 6 | 0 | 6 | 5 | 0 | 12 | 22 | 10 |
| browser | 2 | 7 | 2 | 4 | 2 | 1 | 5 | 13 | 6 |
| translation | 3 | 1 | 1 | 1 | 0 | 0 | 2 | 3 | 6 |
| llm | 0 | 4 | 0 | 2 | 0 | 2 | 0 | 3 | 5 |
| vfs-handlers | 0 | 67 | 0 | 66 | 0 | 3 | 0 | 69 | 0 |
| qbank | 23 | 19 | 11 | 21 | 5 | 2 | 14 | 53 | 0 |
| platform/storage | 2 | 10 | 1 | 10 | 0 | 0 | 3 | 14 | 0 |
| media | 0 | 11 | 0 | 6 | 0 | 9 | 4 | 19 | 0 |
| sync | 6 | 2 | 2 | 4 | 2 | 2 | 6 | 16 | 0 |
| agent-workspace | 7 | 0 | 1 | 1 | 1 | 1 | 6 | 10 | 0 |
| backup | 2 | 5 | 1 | 4 | 0 | 3 | 5 | 13 | 0 |
| agent-skills | 3 | 3 | 0 | 3 | 0 | 0 | 3 | 6 | 0 |
| memory | 4 | 2 | 0 | 1 | 0 | 1 | 4 | 6 | 0 |
| sync-providers | 0 | 6 | 0 | 6 | 0 | 0 | 6 | 12 | 0 |
| mcp | 0 | 3 | 0 | 2 | 0 | 0 | 1 | 3 | 0 |
| integration | 1 | 0 | 1 | 1 | 2 | 2 | 2 | 8 | 0 |
| llm-providers | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| platform/settings | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| sync-support | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 |

## G3 已复现的 serde 差异

| 位置 | G3 次数 | 差异（路径，A=Rust → B=宿主） |
|---|---:|---|
| DB mistakes.db:custom_anki_templates.field_extraction_rules_json | 1554 | key-order `$`×128 (["Question","Expl","ID","Formula"] → ["ID","Question","Formula","Expl"])；none-null-vs-omit/rust-null `$.Back.default_value`×1；none-null-vs-omit/rust-null `$.Back.validation_pattern`×1；none-null-vs-omit/rust-null `$.Front.default_value`×1 |
| DB mistakes.db:anki_cards.extra_fields_json | 1038 | key-order `$`×50 (["Back","Front"] → ["Front","Back"]) |
| DB chat_v2.db:chat_v2_messages.meta_json | 966 | none-null-vs-omit/rust-omit `$.executionSnapshot.generationPlan.auxiliaryMultimodalConfigId`×23；key-order `$`×12 (["executionSnapshot","canonicalContent"] → ["canonicalContent","executionSnapshot"])；none-null-vs-omit/rust-omit `$.executionSnapshot.executionRoute`×4；none-null-vs-omit/rust-omit `$.executionSnapshot.requestedModelId`×2 |
| DB mistakes.db:fsrs_review_logs.state_before_json | 626 | f64-integer/rust-float `$.elapsedDays`×21 ("0.0" → "0")；f64-integer/rust-float `$.scheduledDays`×21 ("0.0" → "0") |
| DB mistakes.db:anki_decks.config_json | 138 | f64-integer/rust-float `$.learning_steps[]`×5 ("525600.0" → "525600")；f64-integer/rust-float `$.relearning_steps[]`×5 ("525600.0" → "525600")；f32-precision/rust-f32 `$.fsrs_params[]`×17 ("0.212" → "0.21199999749660492") |
| DB chat_v2.db:chat_v2_sessions.metadata_json | 28 | skip-default/rust-null `$.toolFacePrefixGeneration`×4 |
| DB vfs.db:essays.dimension_scores_json | 25 | f64-integer/rust-float `$.total`×5 ("52.0" → "52")；f64-integer/rust-float `$.max_total`×5 ("60.0" → "60")；f64-integer/rust-float `$.dimensions[].score`×15 ("18.0" → "18")；f64-integer/rust-float `$.dimensions[].max_score`×15 ("20.0" → "20") |
| DB vfs.db:essays.grading_result_json | 25 | f64-integer/rust-float `$.overall_score`×5 ("52.0" → "52") |
| DB vfs.db:files.processing_progress | 20 | f64-integer/rust-float `$.percent`×4 ("1.0" → "1") |
| DB mistakes.db:document_tasks.anki_generation_options_json | 19 | key-order `$.field_extraction_rules`×2 (["Extra","Section","Text"] → ["Text","Section","Extra"])；key-order `$.field_extraction_rules_by_id.design-exam`×2 (["Section","Extra","Text"] → ["Text","Section","Extra"]) |
| IPC outcome:fsrs_get_card_memory_history | 17 | none-null-vs-omit/rust-omit `$.card.text`×1 |
| IPC outcome:cloud_config_ssot_get | 16 | none-null-vs-omit/rust-omit `$.config`×1 |
| IPC outcome:memory_write_smart | 8 | none-null-vs-omit/rust-omit `$.resourceId`×1 |
| DB vfs.db:exam_sheets.preview_json | 6 | f64-integer/rust-float `$.pages[].cards[].resolved_bbox.x`×3 ("50.0" → "50")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.y`×3 ("70.0" → "70")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.width`×3 ("900.0" → "900")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.height`×3 ("350.0" → "350") |
| DB vfs.db:resources.data | 6 | f64-integer/rust-float `$.pages[].cards[].resolved_bbox.x`×3 ("50.0" → "50")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.y`×3 ("70.0" → "70")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.width`×3 ("900.0" → "900")；f64-integer/rust-float `$.pages[].cards[].resolved_bbox.height`×3 ("350.0" → "350") |
| DB mistakes.db:settings.value | 6 | f64-integer/rust-float `$.searxng.backoff_multiplier`×4 ("0.0" → "0") |
| IPC outcome:fetch_vendor_models | 5 | none-null-vs-omit/rust-omit `$[].contextWindow`×1 |
| IPC outcome:notes_migrate_blocks | 5 | none-null-vs-omit/rust-omit `$.deletedAt`×1 |
| IPC events:notes_migrate_blocks | 5 | none-null-vs-omit/rust-omit `$[].payload.deletedAt`×1 |
| IPC outcome:fsrs_update_scheduler_config | 3 | f32-precision/rust-f32 `$.fsrsParams[]`×1 ("0.212" → "0.21199999749660492") |
| IPC outcome:fsrs_get_scheduler_config | 3 | f32-precision/rust-f32 `$.fsrsParams[]`×1 ("0.212" → "0.21199999749660492") |

## 第二阶段修复指南

排序：可由宿主修复 > G3 已复现（按出现次数）> 置信度 > DB 优先于 IPC（DB 文本持久化并参与同步/备份比对，用户影响更大）。

### 前 10 个最值得修的点

“G3 可修复差异数”= 宿主可修的差异在 G3 中的出现次数（HashMap 键序不计）；“G3 次数”= 该列/命令所在差异组的总出现次数。

| # | 位置 | 插件 | 差异类型（G3 可修复差异数） | G3 次数 | 宿主位置 | Rust 位置 | 修复工具 |
|---:|---|---|---|---:|---|---|---|
| 1 | DB `fsrs_review_logs.state_before_json` | review | f64 整数 `.0`（42）、None（null/省略）、键序 | 626 | `host/plugins/review/src/review.ts:255` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:2263` | `toRustJson` + `rs.f64`（或 `f64Atom`）；`rs.option` / `rs.field(…, { skipIf: 'none' })`；`rs.struct` 声明序 |
| 2 | DB `chat_v2_messages.meta_json` | chat | None（null/省略）（29）、键序（12） | 966 | `host/plugins/chat/repository/legacy-migration.ts:188`<br>`host/plugins/chat/repository/messages.ts:132` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | `rs.option` / `rs.field(…, { skipIf: 'none' })`；`rs.struct` 声明序 |
| 3 | DB `essays.dimension_scores_json` | vfs-repos | f64 整数 `.0`（40） | 25 | `host/plugins/vfs-repos/repository/essays.ts:48`<br>`host/plugins/vfs-repos/repository/exams.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:313` | `toRustJson` + `rs.f64`（或 `f64Atom`） |
| 4 | DB `anki_decks.config_json` | review | f64 整数 `.0`（10）、精度（f32/u64）（17） | 138 | `host/plugins/review/repository/fsrs.ts:172` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:3637` | `toRustJson` + `rs.f64`（或 `f64Atom`）；`rs.f32` / `f32Atom` |
| 5 | DB `resources.data` | translation, vfs-repos, vfs | f64 整数 `.0`（12） | 6 | `host/plugins/translation/repository/translations.ts:83`<br>`host/plugins/vfs-repos/repository/files.ts:311`<br>(+5) | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | `toRustJson` + `rs.f64`（或 `f64Atom`） |
| 6 | DB `exam_sheets.preview_json` | vfs-repos, vfs | f64 整数 `.0`（12） | 6 | `host/plugins/vfs-repos/repository/essays.ts:48`<br>`host/plugins/vfs-repos/repository/exams.ts:61`<br>(+3) | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365` | `toRustJson` + `rs.f64`（或 `f64Atom`） |
| 7 | DB `essays.grading_result_json` | vfs-repos | f64 整数 `.0`（5） | 25 | `host/plugins/vfs-repos/repository/essays.ts:48`<br>`host/plugins/vfs-repos/repository/exams.ts:61`<br>(+1) | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:432` | `toRustJson` + `rs.f64`（或 `f64Atom`） |
| 8 | DB `custom_anki_templates.field_extraction_rules_json` | anki | f64 整数 `.0`、None（null/省略）（4）、键序（HashMap，交 N-009） | 1554 | `host/plugins/anki/repository/templates.ts:26` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475` | `toRustJson` + `rs.f64`（或 `f64Atom`）；`rs.option` / `rs.field(…, { skipIf: 'none' })` |
| 9 | DB `chat_v2_sessions.metadata_json` | chat | f64 整数 `.0`、None（null/省略）（4） | 28 | `host/plugins/chat/repository/groups.ts:186`<br>`host/plugins/chat/repository/groups.ts:222`<br>(+3) | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415` | `toRustJson` + `rs.f64`（或 `f64Atom`）；`rs.option` / `rs.field(…, { skipIf: 'none' })` |
| 10 | DB `files.processing_progress` | vfs-repos | f64 整数 `.0`（4）、精度（f32/u64）、None（null/省略）、键序 | 20 | `host/plugins/vfs-repos/repository/attachment-upload.ts:378`<br>`host/plugins/vfs-repos/repository/attachment-upload.ts:446`<br>(+9) | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904` | `toRustJson` + `rs.f64`（或 `f64Atom`）；`rs.f32` / `f32Atom`；`rs.option` / `rs.field(…, { skipIf: 'none' })`；`rs.struct` 声明序 |

### 工具函数对照

| 差异类型 | DB 写入 | IPC 返回值 |
|---|---|---|
| f64 整数 `.0` | `toRustJson(v, rs.struct({ x: rs.f64 }))`；手工拼对象时 `f64Atom(x)`；`json!`/Value 列用 `rs.valueObject({ x: rs.f64 }, { rest })` | IPC 不可见（前端 `JSON.parse` 后同值），无需修 |
| None（null/省略） | `rs.field(rs.option(T), { skipIf: 'none' })`（Rust 省略）/ `rs.option(T)`（Rust 写 null） | `toRustValue(v, fromContractSchema(result, …))`：按 `x-option` 省略或写 null |
| 键序 | `rs.struct` 按 Rust 字段声明序；BTreeMap → `rs.btreeMap`；IndexMap/Value → `rs.indexMap` / `rs.valueObject`；HashMap 无法逐字节对齐 → 比较器 N-009 | `toRustValue`（同 struct 序）；前端一般不依赖键序 |
| 精度（f32/u64） | f32 字段 `rs.f32` / `f32Atom(x)`（binary32 最短往返）；u64 传 bigint + `rs.u64` | `toRustValue(v, fromContractSchema(result, …))`（f32 投影为 `Math.fround` 后的最短十进制）或 `formatF32` |
| 其他 | chrono → `rs.dateTimeUtc`；enum → `rs.enum(…, { tag, content, untagged })`；pretty → `toRustJson(v, s, { pretty: true })`；未解析 → 先人工确认 Rust 类型再用 `rs.*` 描述 | date-time → `rs.dateTimeUtc`（`toRustValue`） |

通用做法：在插件 repository 层为该列定义一次 schema（`rs.struct` 手写并在注释引用 Rust 结构体 file:line，或 `fromContractSchema` 取序列化形状契约），把 `JSON.stringify(x)` 换成 `toRustJson(x, Schema)`；IPC 在 handler 返回前 `toRustValue(x, Schema)`。反序列化形状契约（`X__De`、只作参数的类型）会被 `fromContractSchema` 拒绝，须手写。

### 按插件的修复顺序

- **review**：`fsrs_review_logs.state_before_json`（f64 整数 `.0`、None（null/省略）、键序；G3 626）；`anki_decks.config_json`（f64 整数 `.0`、精度（f32/u64）；G3 138）；IPC `fsrs_get_card_memory_history`（None（null/省略）；G3 17）；IPC `essay_grading_create_custom_mode`（精度（f32/u64））；IPC `essay_grading_create_session`（None（null/省略））；IPC `essay_grading_get_mode`（精度（f32/u64））；另 15 处见明细。
- **chat**：`chat_v2_messages.meta_json`（None（null/省略）、键序；G3 966）；`chat_v2_sessions.metadata_json`（f64 整数 `.0`、None（null/省略）；G3 28）；`chat_v2_messages.shared_context_json`（f64 整数 `.0`、精度（f32/u64）、None（null/省略）、键序）；IPC `chat_v2_branch_session`（None（null/省略）、其他）；IPC `chat_v2_compact_session`（None（null/省略））；IPC `chat_v2_create_group`（None（null/省略）、其他）；另 37 处见明细。
- **vfs-repos**：`essays.dimension_scores_json`（f64 整数 `.0`；G3 25）；`resources.data`（f64 整数 `.0`；G3 6）；`exam_sheets.preview_json`（f64 整数 `.0`；G3 6）；`essays.grading_result_json`（f64 整数 `.0`；G3 25）；`files.processing_progress`（f64 整数 `.0`、精度（f32/u64）、None（null/省略）、键序；G3 20）；`files.ocr_pages_json`（f64 整数 `.0`、精度（f32/u64）、键序）；另 20 处见明细。
- **translation**：`resources.data`（f64 整数 `.0`；G3 6）；IPC `translate_text_candidates`（None（null/省略））；`translations.metadata_json`（其他）。
- **vfs**：`resources.data`（f64 整数 `.0`；G3 6）；`exam_sheets.preview_json`（f64 整数 `.0`；G3 6）；`files.ocr_pages_json`（f64 整数 `.0`、精度（f32/u64）、键序）；`resources.metadata_json`（f64 整数 `.0`、None（null/省略）、键序、精度（f32/u64））；IPC `dstu_copy`（None（null/省略））；IPC `dstu_create`（None（null/省略））；另 17 处见明细。
- **anki**：`custom_anki_templates.field_extraction_rules_json`（f64 整数 `.0`、None（null/省略）、键序；G3 1554）；`document_tasks.anki_generation_options_json`（f64 整数 `.0`、键序；G3 19）；`settings.value`（f64 整数 `.0`、None（null/省略）、键序；G3 6）；IPC `add_cards_to_anki_connect`（None（null/省略））；IPC `export_multi_template_apkg`（None（null/省略））；IPC `get_all_custom_templates`（None（null/省略）、其他）；另 7 处见明细。
- **browser**：`settings.value`（f64 整数 `.0`、None（null/省略）、键序；G3 6）；`resources.metadata_json`（f64 整数 `.0`、None（null/省略）、键序、精度（f32/u64））；IPC `browser_list_downloads`（None（null/省略））；IPC `browser_list_task_downloads`（None（null/省略））；IPC `browser_forward`（其他）；IPC `browser_get_state`（其他）；另 3 处见明细。
- **notes**：IPC `notes_migrate_blocks`（None（null/省略）；G3 10）；IPC `notes_history_restore_copy`（None（null/省略））；IPC `notes_history_restore_current`（None（null/省略））；IPC `notes_history_restore_selection_copy`（None（null/省略））；IPC `notes_import_markdown`（None（null/省略））；IPC `notes_import_markdown_batch`（None（null/省略））；另 12 处见明细。
- **platform/errors**：IPC `cloud_config_ssot_get`（None（null/省略）；G3 16）；IPC `cloud_config_publish`（None（null/省略））；IPC `cloud_config_ssot_clear`（None（null/省略））；IPC `cloud_config_ssot_save`（None（null/省略））。
- **agent-orchestration**：IPC `memory_write_smart`（None（null/省略）、精度（f32/u64）；G3 8）；IPC `fsrs_get_scheduler_config`（精度（f32/u64）；G3 3）；IPC `fsrs_update_scheduler_config`（精度（f32/u64）；G3 3）；`automation_definitions.schedule_json`（None（null/省略）、键序）；IPC `dstu_folder_create`（None（null/省略））；IPC `dstu_list_trash`（None（null/省略））；另 22 处见明细。
- **llm**：IPC `fetch_vendor_models`（None（null/省略）；G3 5）；IPC `get_api_configurations`（精度（f32/u64））；IPC `get_model_profiles`（精度（f32/u64））；IPC `test_api_connection`（None（null/省略））。
- **agent-workspace**：`resources.metadata_json`（f64 整数 `.0`、None（null/省略）、键序、精度（f32/u64））；`agent.metadata_json`（其他）；`message.metadata_json`（其他）；`completion_outbox.payload_json`（其他）；`sleep_block.wake_condition`（其他）。
- **qbank**：`qbank_import_jobs.document_json`（f64 整数 `.0`、键序）；`qbank_generation_tasks.drafts_json`（f64 整数 `.0`、None（null/省略）、键序）；`qbank_generation_tasks.skipped_references_json`（None（null/省略）、键序）；IPC `import_question_bank`（None（null/省略）、精度（f32/u64）、其他）；IPC `import_question_bank_stream`（None（null/省略）、精度（f32/u64）、其他）；IPC `list_exam_sheet_sessions`（None（null/省略）、其他）；另 28 处见明细。
- **sync-providers**：IPC `cloud_storage_list`（None（null/省略）、其他）；IPC `cloud_storage_stat`（None（null/省略）、其他）；IPC `cloud_sync_download`（None（null/省略）、其他）；IPC `cloud_sync_get_status`（None（null/省略）、其他）；IPC `cloud_sync_list_versions`（None（null/省略）、其他）；IPC `cloud_sync_upload`（None（null/省略）、其他）。
- **backup**：IPC `data_governance_get_backup_job`（None（null/省略）、精度（f32/u64）、其他）；IPC `data_governance_list_backup_jobs`（None（null/省略）、精度（f32/u64）、其他）；IPC `data_governance_list_resumable_jobs`（None（null/省略）、精度（f32/u64）、其他）；IPC `data_governance_restore_with_assets`（None（null/省略））；`__audit_log.details`（f64 整数 `.0`）；`__audit_log.operation_data`（其他）；另 1 处见明细。
- **sync**：IPC `data_governance_list_unsynced_items`（None（null/省略）、其他）；IPC `data_governance_repo_check`（None（null/省略）、其他）；`__sync_conflicts.data_json`（其他）；`__sync_quarantine.baseline_json`（其他）；`__sync_quarantine.payload_json`（f64 整数 `.0`、None（null/省略）、键序、精度（f32/u64））；`__sync_record_history.data_json`（其他）。
- **platform/settings**：IPC `get_backup_config`（None（null/省略））。
- **media**：IPC `get_exam_sheet_session_detail`（None（null/省略）、精度（f32/u64）、其他）；IPC `media_bilibili_import_subtitle`（精度（f32/u64））；IPC `media_bilibili_stream_quality`（None（null/省略））；IPC `media_transcribe_cancel`（精度（f32/u64））；IPC `media_transcribe_start`（精度（f32/u64））；IPC `media_transcript_get`（精度（f32/u64））；另 5 处见明细。
- **mcp**：IPC `get_mcp_config`（None（null/省略））；IPC `import_mcp_config`（None（null/省略））；IPC `start_mcp_oauth`（其他）。
- **platform/storage**：IPC `get_startup_recovery_status`（None（null/省略））；IPC `list_startup_recovery_incidents`（None（null/省略））；IPC `llm_usage_by_caller`（None（null/省略））；IPC `llm_usage_by_model`（None（null/省略））；IPC `llm_usage_daily`（None（null/省略））；IPC `llm_usage_get_trends`（None（null/省略））；另 6 处见明细。
- **memory**：IPC `memory_get_audit_logs`（精度（f32/u64））；IPC `memory_get_tree`（None（null/省略））；`insight_events.payload_json`（其他）；`insight_jobs.payload_json`（其他）；`memory_audit_log.extra_json`（其他）。
- **llm-providers**：IPC `openai_codex_usage`（None（null/省略））。
- **vfs-handlers**：IPC `pomodoro_create_record`（None（null/省略））；IPC `pomodoro_get_record`（None（null/省略））；IPC `pomodoro_list_by_todo`（None（null/省略））；IPC `pomodoro_list_range`（None（null/省略））；IPC `pomodoro_list_today`（None（null/省略））；IPC `todo_ai_breakdown`（None（null/省略））；另 61 处见明细。
- **agent-skills**：IPC `skill_check_updates`（None（null/省略））；IPC `skill_import_zip`（None（null/省略））；IPC `skill_tap_install`（None（null/省略））；`connector_operations.preview_json`（其他）；`skill_candidates.draft_payload_json`（其他）；`skill_candidates.evidence_refs_json`（其他）。
- **sync-support**：`__sync_conflicts.data_json`（其他）。
- **integration**：`temp_sessions.session_data`（f64 整数 `.0`、精度（f32/u64）、None（null/省略）、键序、其他）。

宿主无法逐字节对齐（Rust 侧 HashMap 键序随进程随机）、应由比较器归一化（N-009）处理的 G3 差异：
- `anki_cards.extra_fields_json`（G3 1038；Rust `src-tauri/crates/dstu-storage/src/database/mod.rs:567`，类型 `std::collections::HashMap<String, String>`）

## 逐插件明细

### agent-orchestration

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `memory_write_smart` | `host/plugins/agent-orchestration/src/headless.ts:187` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:761` | None（null/省略） | high | 自动判定 | 1 | Rust 省略 None：.resourceId（宿主写 null 不被契约校验拦截） |
| IPC `memory_write_smart` | `host/plugins/agent-orchestration/src/headless.ts:187` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:761` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.confidence（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `fsrs_get_scheduler_config` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:188` | `src-tauri/src/cmd/fsrs_review.rs:555` | 精度（f32/u64） | high | 自动判定 | 1 | f32：.fsrsParams[]（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `fsrs_update_scheduler_config` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:189` | `src-tauri/src/cmd/fsrs_review.rs:562` | 精度（f32/u64） | high | 自动判定 | 1 | f32：.fsrsParams[]（宿主须返回 Math.fround 后的最短十进制值） |
| DB `automation_definitions.schedule_json` | `host/plugins/agent-orchestration/repository/automation-definitions.ts:42` | `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:1046`<br>`AutomationSchedule` @ `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:250` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：weekday, weekdays, day_of_month, interval_minutes |
| DB `automation_definitions.schedule_json` | `host/plugins/agent-orchestration/repository/automation-definitions.ts:42` | `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:1046`<br>`AutomationSchedule` @ `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:250` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `automation_definitions.trusted_profile_json` | `host/plugins/agent-orchestration/repository/automation-definitions.ts:106` | `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:1046` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（trustedProfileJson） |
| DB `automation_definitions.trusted_profile_json` | `host/plugins/agent-orchestration/repository/automation-definitions.ts:428` | `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:1046` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（trustedProfileJson） |
| IPC `browser_back` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:110` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:158` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| IPC `browser_navigate` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:102` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:134` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| DB `chat_v2_todo_lists.steps_json` | `host/plugins/agent-orchestration/repository/todo.ts:62` | `src-tauri/crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:236`<br>`Vec<TodoStep>` @ `src-tauri/crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:81` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| IPC `dstu_folder_create` | `host/plugins/agent-orchestration/src/headless.ts:200` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:135` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.parentId, .icon, .color（宿主写 null 不被契约校验拦截） |
| IPC `dstu_list_trash` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:94` | `src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:237` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].size, [].children, [].childCount, [].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_move` | `host/plugins/agent-orchestration/src/headless.ts:203` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1770` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_rename` | `host/plugins/agent-orchestration/src/headless.ts:202` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1879` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_restore` | `host/plugins/agent-orchestration/src/headless.ts:205` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4234` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `memory_search` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:195` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:233` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].updatedAt（宿主写 null 不被契约校验拦截） |
| IPC `memory_search` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:195` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:233` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `memory_write_batch` | `host/plugins/agent-orchestration/src/headless.ts:188` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:815` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.results[].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `memory_write_batch` | `host/plugins/agent-orchestration/src/headless.ts:188` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:815` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.results[].confidence（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `qbank_create_question` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:154` | `src-tauri/src/commands.rs:7704` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role, .materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_generate_paper` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:160` | `src-tauri/src/commands.rs:8168` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_get_generation_task` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:169` | `src-tauri/src/qbank_generation.rs:27` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.drafts[].local_id, .drafts[].group_id, .drafts[].original_label, .drafts[].structured_data（宿主写 null 不被契约校验拦截） |
| IPC `qbank_get_paper` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:162` | `src-tauri/src/qbank_practice.rs:80` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_get_question` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:142` | `src-tauri/src/commands.rs:7675` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role, .materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_list_papers` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:161` | `src-tauri/src/qbank_practice.rs:72` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].questions[].images[].role, [].questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_list_questions` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:141` | `src-tauri/src/commands.rs:7572` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_search_questions` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:148` | `src-tauri/src/commands.rs:7641` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.results[].question.images[].role, .results[].question.materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_submit_answer` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:157` | `src-tauri/src/commands.rs:7817` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.updated_question.images[].role, .updated_question.materials[].images[].role, .daily_progress（宿主写 null 不被契约校验拦截） |
| IPC `qbank_toggle_favorite` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:155` | `src-tauri/src/commands.rs:7854` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role, .materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_update_question` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:158` | `src-tauri/src/commands.rs:7740` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role, .materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `skill_market_download_and_scan` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:308` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1277` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.tempZipPath, .scan.requires（宿主写 null 不被契约校验拦截） |
| IPC `skill_market_search` | `host/plugins/agent-orchestration/src/tool-descriptors.ts:305` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1196` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].verify（宿主写 null 不被契约校验拦截） |

### agent-skills

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `connector_operations.preview_json` | `host/plugins/agent-skills/repository/connector-ledger.ts:221` | `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs:218` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（op.previewJson） |
| DB `skill_candidates.draft_payload_json` | `host/plugins/agent-skills/repository/skill-usage.ts:245` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_usage.rs:526` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（candidate.draftPayloadJson） |
| DB `skill_candidates.evidence_refs_json` | `host/plugins/agent-skills/repository/skill-usage.ts:245` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_usage.rs:526` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（candidate.evidenceRefsJson） |
| IPC `skill_check_updates` | `host/plugins/agent-skills/index.ts:203` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_updates.rs:354` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].currentVersion, [].remoteVersion（宿主写 null 不被契约校验拦截） |
| IPC `skill_import_zip` | `host/plugins/agent-skills/index.ts:200` | `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2320` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.requires（宿主写 null 不被契约校验拦截） |
| IPC `skill_tap_install` | `host/plugins/agent-skills/index.ts:201` | `src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs:489` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.requires（宿主写 null 不被契约校验拦截） |

### agent-workspace

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `agent.metadata_json` | `host/plugins/agent-workspace/repository/workspace-repository.ts:145` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/repo.rs:155` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（record.metadataJson） |
| DB `agent.metadata_json` | `host/plugins/agent-workspace/repository/workspace-repository.ts:178` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/repo.rs:155` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（metadataJson） |
| DB `completion_outbox.payload_json` | `host/plugins/agent-workspace/repository/completion-outbox-repository.ts:70` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:162` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（record.payloadJson） |
| DB `message.metadata_json` | `host/plugins/agent-workspace/repository/workspace-repository.ts:189` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/repo.rs:262` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（record.metadataJson） |
| DB `message.metadata_json` | `host/plugins/agent-workspace/repository/workspace-repository.ts:227` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/repo.rs:262` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（metadataJson） |
| DB `resources.metadata_json` | `host/plugins/agent-workspace/src/workspace/repo.ts:30` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/agent-workspace/src/workspace/repo.ts:30` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/agent-workspace/src/workspace/repo.ts:30` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/agent-workspace/src/workspace/repo.ts:30` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | u64/i64 字段 .size：超过 2^53 时 number 失精度 |
| DB `sleep_block.wake_condition` | `host/plugins/agent-workspace/repository/sleep-repository.ts:38` | `src-tauri/crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:1110`<br>`WakeCondition` @ `src-tauri/crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:25` | 其他 | low | 需人工核对 |  | 宿主来源未解析；enum 标记 $（tag/content/untagged） |

### anki

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `custom_anki_templates.field_extraction_rules_json` | `host/plugins/anki/repository/templates.ts:26` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475`<br>`std::collections::HashMap<String, FieldExtractionRule>` @ `src-tauri/crates/dstu-core/src/models.rs:1542` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .validation.min, .validation.max：JSON.stringify 对整数值不写 `.0` |
| DB `custom_anki_templates.field_extraction_rules_json` | `host/plugins/anki/repository/templates.ts:26` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475`<br>`std::collections::HashMap<String, FieldExtractionRule>` @ `src-tauri/crates/dstu-core/src/models.rs:1542` | None（null/省略） | high | 自动判定 | 4 | Rust 省略 None：validation, transform, schema, item_schema；Rust 写 null：default_value, validation_pattern |
| DB `custom_anki_templates.field_extraction_rules_json` | `host/plugins/anki/repository/templates.ts:26` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475`<br>`std::collections::HashMap<String, FieldExtractionRule>` @ `src-tauri/crates/dstu-core/src/models.rs:1542` | 键序 | high | 自动判定 | 128 | HashMap $, .schema.properties：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/anki-cards.ts:187` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/anki-cards.ts:342` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/anki-cards.ts:397` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/anki-cards.ts:437` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/anki-library.ts:149` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/apkg-import.ts:236` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/chatanki-surface.ts:183` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/chatanki-surface.ts:301` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `anki_cards.extra_fields_json` | `host/plugins/anki/repository/chatanki-surface.ts:688` | `src-tauri/crates/dstu-storage/src/database/mod.rs:567`<br>`std::collections::HashMap<String, String>` | 键序 | high | 自动判定 | 50 | HashMap $：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/anki-cards.ts:281` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/anki-cards.ts:281` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | 键序 | high | 自动判定 | 4 | G3：键序差（`$.field_extraction_rules`, `$.field_extraction_rules_by_id.design-exam`）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/anki-cards.ts:301` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/anki-cards.ts:301` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | 键序 | high | 自动判定 | 4 | G3：键序差（`$.field_extraction_rules`, `$.field_extraction_rules_by_id.design-exam`）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/apkg-import.ts:201` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/apkg-import.ts:201` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | 键序 | high | 自动判定 | 4 | G3：键序差（`$.field_extraction_rules`, `$.field_extraction_rules_by_id.design-exam`）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/document-processing.ts:42` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/document-processing.ts:42` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | 键序 | high | 自动判定 | 4 | G3：键序差（`$.field_extraction_rules`, `$.field_extraction_rules_by_id.design-exam`）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/document-processing.ts:63` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `document_tasks.anki_generation_options_json` | `host/plugins/anki/repository/document-processing.ts:63` | `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:2346` | 键序 | high | 自动判定 | 4 | G3：键序差（`$.field_extraction_rules`, `$.field_extraction_rules_by_id.design-exam`）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:111` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 `$.searxng.backoff_multiplier`：JSON.stringify 对整数值不写 `.0` |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:111` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | None（null/省略） | medium | 需人工核对 |  | Rust 写 null：model2_config_id, review_analysis_model_config_id, anki_card_model_config_id, qbank_ai_grading_model_config_id |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:111` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:127` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 `$.searxng.backoff_multiplier`：JSON.stringify 对整数值不写 `.0` |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:127` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | None（null/省略） | medium | 需人工核对 |  | Rust 写 null：model2_config_id, review_analysis_model_config_id, anki_card_model_config_id, qbank_ai_grading_model_config_id |
| DB `settings.value` | `host/plugins/anki/src/plugin-handlers-export.ts:127` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| IPC `add_cards_to_anki_connect` | `host/plugins/anki/index.ts:57` | `src-tauri/src/cmd/anki_connect.rs:226` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.modelErrors, .warnings（宿主写 null 不被契约校验拦截） |
| DB `col.dconf` | `host/plugins/anki/repository/apkg-export.ts:65` | `src-tauri/crates/dstu-anki/src/apkg_exporter_service.rs:1439`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `col.decks` | `host/plugins/anki/repository/apkg-export.ts:65` | `src-tauri/crates/dstu-anki/src/apkg_exporter_service.rs:1439`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `col.models` | `host/plugins/anki/repository/apkg-export.ts:65` | `src-tauri/crates/dstu-anki/src/apkg_exporter_service.rs:1439`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `custom_anki_templates.preview_data_json` | `host/plugins/anki/repository/templates.ts:158` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（request.preview_data_json ?? null） |
| DB `custom_anki_templates.preview_data_json` | `host/plugins/anki/repository/templates.ts:51` | `src-tauri/crates/dstu-storage/src/database/mod.rs:2475` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（request.preview_data_json ?? null） |
| IPC `export_multi_template_apkg` | `host/plugins/anki/index.ts:63` | `src-tauri/src/cmd/anki_connect.rs:1123` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.report.missingMedia, .report.warnings（宿主写 null 不被契约校验拦截） |
| IPC `get_all_custom_templates` | `host/plugins/anki/index.ts:23` | `src-tauri/src/commands.rs:4279` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].field_extraction_rules{}.validation, [].field_extraction_rules{}.transform, [].field_extraction_rules{}.schema, [].field_extraction_rules{}.item_schema（宿主写 null 不被契约校验拦截） |
| IPC `get_all_custom_templates` | `host/plugins/anki/index.ts:23` | `src-tauri/src/commands.rs:4279` | 其他 | low | 需人工核对 |  | date-time：[].created_at, [].updated_at |
| IPC `get_custom_template_by_id` | `host/plugins/anki/index.ts:24` | `src-tauri/src/commands.rs:4291` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.field_extraction_rules{}.validation, .field_extraction_rules{}.transform, .field_extraction_rules{}.schema, .field_extraction_rules{}.item_schema（宿主写 null 不被契约校验拦截） |
| IPC `get_custom_template_by_id` | `host/plugins/anki/index.ts:24` | `src-tauri/src/commands.rs:4291` | 其他 | low | 需人工核对 |  | date-time：.created_at, .updated_at |
| IPC `import_apkg_to_library` | `host/plugins/anki/index.ts:13` | `src-tauri/src/cmd/apkg_import.rs:81` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.mediaReport, .mediaReport.skips, .mediaReport.skips[].filenames, .mediaReport.mediaDir（宿主写 null 不被契约校验拦截） |
| DB `notes.data` | `host/plugins/anki/repository/apkg-export.ts:86` | `src-tauri/crates/dstu-anki/src/apkg_exporter_service.rs:1504`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |

### backup

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `__audit_log.details` | `host/plugins/backup/repository/audit.ts:142` | `src-tauri/crates/dstu-storage/src/audit/mod.rs:245`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `__audit_log.operation_data` | `host/plugins/backup/repository/audit.ts:148` | `src-tauri/crates/dstu-storage/src/audit/mod.rs:245`<br>`AuditOperation` @ `src-tauri/crates/dstu-storage/src/audit/mod.rs:46` | 其他 | low | 需人工核对 |  | enum 标记 $（tag/content/untagged） |
| IPC `data_governance_get_backup_job` | `host/plugins/backup/index.ts:154` | `src-tauri/src/data_governance/commands_backup.rs:2281` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.started_at, .finished_at, .result, .result.resolved_path（宿主写 null 不被契约校验拦截） |
| IPC `data_governance_get_backup_job` | `host/plugins/backup/index.ts:154` | `src-tauri/src/data_governance/commands_backup.rs:2281` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `data_governance_get_backup_job` | `host/plugins/backup/index.ts:154` | `src-tauri/src/data_governance/commands_backup.rs:2281` | 其他 | low | 需人工核对 |  | date-time：.created_at, .started_at, .finished_at |
| IPC `data_governance_get_maintenance_status` | `host/plugins/backup/index.ts:156` | `src-tauri/src/data_governance/commands.rs:430` | 其他 | low | 需人工核对 |  | date-time：.current_operation.started_at |
| IPC `data_governance_list_backup_jobs` | `host/plugins/backup/index.ts:158` | `src-tauri/src/data_governance/commands_backup.rs:2299` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].started_at, [].finished_at, [].result, [].result.resolved_path（宿主写 null 不被契约校验拦截） |
| IPC `data_governance_list_backup_jobs` | `host/plugins/backup/index.ts:158` | `src-tauri/src/data_governance/commands_backup.rs:2299` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].progress（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `data_governance_list_backup_jobs` | `host/plugins/backup/index.ts:158` | `src-tauri/src/data_governance/commands_backup.rs:2299` | 其他 | low | 需人工核对 |  | date-time：[].created_at, [].started_at, [].finished_at |
| IPC `data_governance_list_resumable_jobs` | `host/plugins/backup/index.ts:159` | `src-tauri/src/data_governance/commands_backup.rs:2355` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].started_at, [].checkpoint, [].checkpoint.partial_output, [].error_message（宿主写 null 不被契约校验拦截） |
| IPC `data_governance_list_resumable_jobs` | `host/plugins/backup/index.ts:159` | `src-tauri/src/data_governance/commands_backup.rs:2355` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].progress（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `data_governance_list_resumable_jobs` | `host/plugins/backup/index.ts:159` | `src-tauri/src/data_governance/commands_backup.rs:2355` | 其他 | low | 需人工核对 |  | date-time：[].created_at, [].started_at, [].checkpoint.last_updated |
| IPC `data_governance_restore_with_assets` | `host/plugins/backup/index.ts:160` | `src-tauri/src/data_governance/commands_asset.rs:116` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.assets_restored（宿主写 null 不被契约校验拦截） |

### browser

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `settings.value` | `host/plugins/browser/repository/index.ts:402` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 `$.searxng.backoff_multiplier`：JSON.stringify 对整数值不写 `.0` |
| DB `settings.value` | `host/plugins/browser/repository/index.ts:402` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 写 null：model2_config_id, review_analysis_model_config_id, anki_card_model_config_id, qbank_ai_grading_model_config_id |
| DB `settings.value` | `host/plugins/browser/repository/index.ts:402` | `src-tauri/src/chat_v2/tools/settings_models_executor.rs:1573`<br>`ModelAssignments` @ `src-tauri/crates/dstu-core/src/models.rs:1161` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| IPC `browser_forward` | `host/plugins/browser/index.ts:69` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:168` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| IPC `browser_get_state` | `host/plugins/browser/index.ts:70` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:191` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| IPC `browser_list_downloads` | `host/plugins/browser/index.ts:73` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:443` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].objectHandle.mediaType, [].objectHandle.sizeBytes, [].objectHandle.sha256, [].objectHandle.locator（宿主写 null 不被契约校验拦截） |
| IPC `browser_list_task_downloads` | `host/plugins/browser/index.ts:73` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:454` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].objectHandle.mediaType, [].objectHandle.sizeBytes, [].objectHandle.sha256, [].objectHandle.locator（宿主写 null 不被契约校验拦截） |
| IPC `browser_open_session` | `host/plugins/browser/api.ts:113` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:109` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| IPC `browser_reload` | `host/plugins/browser/index.ts:69` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:178` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| IPC `browser_take_over` | `host/plugins/browser/index.ts:72` | `src-tauri/crates/dstu-browser/src/cmd/browser.rs:335` | 其他 | low | 需人工核对 |  | date-time：.history[].visitedAt |
| DB `resources.metadata_json` | `host/plugins/browser/src/index-webpage-executor.ts:647` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/browser/src/index-webpage-executor.ts:647` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/browser/src/index-webpage-executor.ts:647` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/browser/src/index-webpage-executor.ts:647` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | u64/i64 字段 .size：超过 2^53 时 number 失精度 |

### chat

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `chat_v2_messages.meta_json` | `host/plugins/chat/repository/legacy-migration.ts:188` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | None（null/省略） | high | 自动判定 | 29 | G3：null/省略差（`$.executionSnapshot.generationPlan.auxiliaryMultimodalConfigId`, `$.executionSnapshot.executionRoute`, `$.executionSnapshot.requestedModelId`） |
| DB `chat_v2_messages.meta_json` | `host/plugins/chat/repository/legacy-migration.ts:188` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | 键序 | high | 自动判定 | 12 | G3：键序差（`$`）；Rust 值类型未静态解析，若该处为 HashMap 则交比较器 N-009 |
| DB `chat_v2_messages.meta_json` | `host/plugins/chat/repository/messages.ts:132` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | None（null/省略） | high | 自动判定 | 29 | G3：null/省略差（`$.executionSnapshot.generationPlan.auxiliaryMultimodalConfigId`, `$.executionSnapshot.executionRoute`, `$.executionSnapshot.requestedModelId`） |
| DB `chat_v2_messages.meta_json` | `host/plugins/chat/repository/messages.ts:132` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | 键序 | high | 自动判定 | 12 | G3：键序差（`$`）；Rust 值类型未静态解析，若该处为 HashMap 则交比较器 N-009 |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/groups.ts:186` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/groups.ts:186` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | None（null/省略） | high | 自动判定 | 4 | G3：null/省略差 |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/groups.ts:222` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/groups.ts:222` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | None（null/省略） | high | 自动判定 | 4 | G3：null/省略差 |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/legacy-migration.ts:173` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/legacy-migration.ts:173` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | None（null/省略） | high | 自动判定 | 4 | G3：null/省略差 |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/sessions.ts:74` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/sessions.ts:74` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | None（null/省略） | high | 自动判定 | 4 | G3：null/省略差 |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/sessions.ts:91` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `chat_v2_sessions.metadata_json` | `host/plugins/chat/repository/sessions.ts:91` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:415`<br>`serde_json::Value` | None（null/省略） | high | 自动判定 | 4 | G3：null/省略差 |
| DB `chat_v2_blocks.citations_json` | `host/plugins/chat/repository/legacy-migration.ts:204` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:981` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（block.citationsJson） |
| DB `chat_v2_blocks.tool_input_json` | `host/plugins/chat/repository/legacy-migration.ts:220` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:981` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（block.toolInputJson） |
| DB `chat_v2_blocks.tool_output_json` | `host/plugins/chat/repository/legacy-migration.ts:220` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:981` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（block.toolOutputJson） |
| IPC `chat_v2_branch_session` | `host/plugins/chat/index.ts:104` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:710` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_branch_session` | `host/plugins/chat/index.ts:104` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:710` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_compact_session` | `host/plugins/chat/index.ts:102` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:56` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.tokensBefore, .tokensAfter（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_create_group` | `host/plugins/chat/index.ts:95` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:145` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .systemPrompt（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_create_group` | `host/plugins/chat/index.ts:95` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:145` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_create_session` | `host/plugins/chat/index.ts:71` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:329` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_create_session` | `host/plugins/chat/index.ts:71` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:329` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_edit_and_resend` | `host/plugins/chat/index.ts:102` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1267` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.deleted_message_ids, .new_variant_id（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_emergency_stop` | `host/plugins/chat/index.ts:86` | `src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:194` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.cancelledStreams（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_export_session_messages` | `host/plugins/chat/index.ts:85` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:116` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.messages[].persistentStableId, .messages[].parentId, .messages[].supersedes, .messages[]._meta（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_export_session_messages` | `host/plugins/chat/index.ts:85` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:116` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.messages[]._meta.sources.rag[].score, .messages[]._meta.sources.memory[].score, .messages[]._meta.sources.graph[].score, .messages[]._meta.sources.webSearch[].score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `chat_v2_export_session_meta` | `host/plugins/chat/index.ts:85` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.session.title, .session.description, .session.summaryHash, .session.metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_export_session_meta` | `host/plugins/chat/index.ts:85` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.sessionState.chatParams.temperature, .sessionState.chatParams.topP, .sessionState.chatParams.frequencyPenalty, .sessionState.chatParams.presencePenalty（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `chat_v2_export_session_meta` | `host/plugins/chat/index.ts:85` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82` | 其他 | low | 需人工核对 |  | date-time：.session.createdAt, .session.updatedAt |
| IPC `chat_v2_get_group` | `host/plugins/chat/index.ts:96` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:368` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .systemPrompt（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_get_group` | `host/plugins/chat/index.ts:96` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:368` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_get_session` | `host/plugins/chat/index.ts:66` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:413` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_get_session` | `host/plugins/chat/index.ts:66` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:413` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_kill_switch_status` | `host/plugins/chat/index.ts:86` | `src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:290` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.cancelledStreams（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_list_agent_sessions` | `host/plugins/chat/index.ts:72` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:671` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].title, [].description, [].summaryHash, [].metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_list_agent_sessions` | `host/plugins/chat/index.ts:72` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:671` | 其他 | low | 需人工核对 |  | date-time：[].createdAt, [].updatedAt |
| IPC `chat_v2_list_groups` | `host/plugins/chat/index.ts:96` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:398` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].icon, [].color, [].systemPrompt（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_list_groups` | `host/plugins/chat/index.ts:96` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:398` | 其他 | low | 需人工核对 |  | date-time：[].createdAt, [].updatedAt |
| IPC `chat_v2_list_sessions` | `host/plugins/chat/index.ts:66` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:597` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].title, [].description, [].summaryHash, [].metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_list_sessions` | `host/plugins/chat/index.ts:66` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:597` | 其他 | low | 需人工核对 |  | date-time：[].createdAt, [].updatedAt |
| IPC `chat_v2_load_messages_page` | `host/plugins/chat/index.ts:77` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs:32` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.messages[].persistentStableId, .messages[].parentId, .messages[].supersedes, .messages[]._meta（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_load_messages_page` | `host/plugins/chat/index.ts:77` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs:32` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.messages[]._meta.sources.rag[].score, .messages[]._meta.sources.memory[].score, .messages[]._meta.sources.graph[].score, .messages[]._meta.sources.webSearch[].score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `chat_v2_load_session` | `host/plugins/chat/index.ts:77` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.session.title, .session.description, .session.summaryHash, .session.metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_load_session` | `host/plugins/chat/index.ts:77` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.messages[]._meta.sources.rag[].score, .messages[]._meta.sources.memory[].score, .messages[]._meta.sources.graph[].score, .messages[]._meta.sources.webSearch[].score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `chat_v2_load_session` | `host/plugins/chat/index.ts:77` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37` | 其他 | low | 需人工核对 |  | date-time：.session.createdAt, .session.updatedAt |
| DB `chat_v2_messages.attachments_json` | `host/plugins/chat/repository/legacy-migration.ts:188` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:455` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（message.attachmentsJson） |
| DB `chat_v2_messages.attachments_json` | `host/plugins/chat/repository/messages.ts:213` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:455` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_messages.attachments_json` | `host/plugins/chat/repository/messages.ts:278` | `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:455` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:216` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .ragSources[].score：JSON.stringify 对整数值不写 `.0` |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:216` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .ragSources[].score：宿主须按 binary32 最短表示写出 |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:216` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：ragSources |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:216` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:281` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .ragSources[].score：JSON.stringify 对整数值不写 `.0` |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:281` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .ragSources[].score：宿主须按 binary32 最短表示写出 |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:281` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：ragSources |
| DB `chat_v2_messages.shared_context_json` | `host/plugins/chat/repository/messages.ts:281` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:4155`<br>`SharedContext` @ `src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1481` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `chat_v2_messages.variants_json` | `host/plugins/chat/repository/messages.ts:170` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:1316` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| IPC `chat_v2_restore_group` | `host/plugins/chat/index.ts:97` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:341` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .systemPrompt（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_restore_group` | `host/plugins/chat/index.ts:97` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:341` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_restore_session` | `host/plugins/chat/index.ts:72` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:845` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_restore_session` | `host/plugins/chat/index.ts:72` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:845` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_resume_agents` | `host/plugins/chat/index.ts:86` | `src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:255` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.cancelledStreams（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_resume_automations` | `host/plugins/chat/index.ts:87` | `src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:272` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.cancelledStreams（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_retry_message` | `host/plugins/chat/index.ts:102` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:918` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.deleted_message_ids, .deleted_variant_ids, .new_variant_id（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_search_sessions` | `host/plugins/chat/index.ts:68` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:71` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].title, [].description, [].summaryHash, [].metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_search_sessions` | `host/plugins/chat/index.ts:68` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:71` | 其他 | low | 需人工核对 |  | date-time：[].createdAt, [].updatedAt |
| DB `chat_v2_session_state.active_skill_ids_json` | `host/plugins/chat/repository/session-state.ts:32` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（state.activeSkillIdsJson ?? null） |
| DB `chat_v2_session_state.chat_params_json` | `host/plugins/chat/repository/session-state.ts:44` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_session_state.features_json` | `host/plugins/chat/repository/session-state.ts:45` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_session_state.loaded_skill_ids_json` | `host/plugins/chat/repository/session-state.ts:32` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（state.loadedSkillIdsJson ?? null） |
| DB `chat_v2_session_state.mode_state_json` | `host/plugins/chat/repository/session-state.ts:46` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_session_state.panel_states_json` | `host/plugins/chat/repository/session-state.ts:48` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `chat_v2_session_state.pending_context_refs_json` | `host/plugins/chat/repository/session-state.ts:32` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（state.pendingContextRefsJson ?? null） |
| DB `chat_v2_session_state.skill_state_json` | `host/plugins/chat/repository/session-state.ts:32` | `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs:2689` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（state.skillStateJson ?? null） |
| IPC `chat_v2_set_authority_mode` | `host/plugins/chat/index.ts:73` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2127` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_set_authority_mode` | `host/plugins/chat/index.ts:73` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2127` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_set_permission_preset` | `host/plugins/chat/index.ts:74` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2153` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_set_permission_preset` | `host/plugins/chat/index.ts:74` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2153` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_stage_context_attachments` | `host/plugins/chat/index.ts:105` | `src-tauri/crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1848` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.attachments[].mediaType, .attachments[].objectHandle.mediaType, .attachments[].objectHandle.sizeBytes, .attachments[].objectHandle.sha256（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_update_group` | `host/plugins/chat/index.ts:95` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:197` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .systemPrompt（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_update_group` | `host/plugins/chat/index.ts:95` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:197` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |
| IPC `chat_v2_update_session_settings` | `host/plugins/chat/index.ts:71` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:448` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.title, .description, .summaryHash, .metadata（宿主写 null 不被契约校验拦截） |
| IPC `chat_v2_update_session_settings` | `host/plugins/chat/index.ts:71` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:448` | 其他 | low | 需人工核对 |  | date-time：.createdAt, .updatedAt |

### integration

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .chat_history[].rag_sources[].score, .exam_sheet.bbox.x, .exam_sheet.bbox.y, .exam_sheet.bbox.width：JSON.stringify 对整数值不写 `.0` |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .chat_history[].rag_sources[].score, .exam_sheet.bbox.x, .exam_sheet.bbox.y, .exam_sheet.bbox.width：宿主须按 binary32 最短表示写出 |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：ocr_note, chat_metadata |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 键序 | low | 需人工核对 |  | 宿主来源未解析；HashMap .chat_history[].tool_result.error_details.context：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009） |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；u64/i64 字段 .chat_history[].doc_attachments[].size_bytes：超过 2^53 时 number 失精度 |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 其他 | low | 需人工核对 |  | 宿主来源未解析；chrono 时间 .chat_history[].timestamp, .created_at：RFC 3339 AutoSi + Z |
| DB `temp_sessions.session_data` | `host/plugins/integration/repository/temp-sessions.ts:37` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4177`<br>`StreamContext` @ `src-tauri/crates/dstu-core/src/models.rs:180` | 其他 | low | 需人工核对 |  | 宿主来源未解析；enum 标记 .chat_history[].multimodal_content[]（tag/content/untagged） |

### llm

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `fetch_vendor_models` | `host/plugins/llm/index.ts:85` | `src-tauri/src/commands.rs:3106` | None（null/省略） | high | 自动判定 | 1 | Rust 省略 None：[].contextWindow, [].maxOutputTokens（宿主写 null 不被契约校验拦截） |
| IPC `get_api_configurations` | `host/plugins/llm/index.ts:81` | `src-tauri/src/commands.rs:2127` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].temperature, [].minP, [].topPOverride, [].frequencyPenaltyOverride（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `get_model_profiles` | `host/plugins/llm/index.ts:82` | `src-tauri/src/commands.rs:2206` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].temperature, [].minP, [].repetitionPenalty（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `test_api_connection` | `host/plugins/llm/index.ts:85` | `src-tauri/src/commands.rs:3321` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.category, .message, .warning（宿主写 null 不被契约校验拦截） |

### llm-providers

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `openai_codex_usage` | `host/plugins/llm-providers/index.ts:36` | `src-tauri/src/cmd/openai_codex.rs:57` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.rateLimits, .rateLimits.primary, .rateLimits.primary.usedPercent, .rateLimits.primary.windowDurationMins（宿主写 null 不被契约校验拦截） |

### mcp

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `get_mcp_config` | `host/plugins/mcp/index.ts:74` | `src-tauri/src/commands.rs:7003` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.transport.port, .transport.working_dir, .transport.api_key, .transport.oauth（宿主写 null 不被契约校验拦截） |
| IPC `import_mcp_config` | `host/plugins/mcp/index.ts:74` | `src-tauri/src/commands.rs:7016` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.transport.port, .transport.working_dir, .transport.api_key, .transport.oauth（宿主写 null 不被契约校验拦截） |
| IPC `start_mcp_oauth` | `host/plugins/mcp/index.ts:78` | `src-tauri/crates/dstu-mcp/src/mcp/commands.rs:15` | 其他 | low | 需人工核对 |  | date-time：.expires_at |

### media

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `get_exam_sheet_session_detail` | `host/plugins/media/api.ts:222` | `src-tauri/src/commands.rs:945` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.detail.summary.exam_name, .detail.summary.metadata, .detail.summary.metadata.instructions, .detail.summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `get_exam_sheet_session_detail` | `host/plugins/media/api.ts:222` | `src-tauri/src/commands.rs:945` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.detail.preview.pages[].cards[].bbox.x, .detail.preview.pages[].cards[].bbox.y, .detail.preview.pages[].cards[].bbox.width, .detail.preview.pages[].cards[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `get_exam_sheet_session_detail` | `host/plugins/media/api.ts:222` | `src-tauri/src/commands.rs:945` | 其他 | low | 需人工核对 |  | date-time：.detail.summary.created_at, .detail.summary.updated_at |
| IPC `media_bilibili_import_subtitle` | `host/plugins/media/index.ts:49` | `src-tauri/crates/dstu-media/src/media/bilibili.rs:1311` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `media_bilibili_stream_quality` | `host/plugins/media/index.ts:49` | `src-tauri/crates/dstu-media/src/media/bilibili_stream.rs:512` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.streamUrl（宿主写 null 不被契约校验拦截） |
| IPC `media_transcribe_cancel` | `host/plugins/media/index.ts:38` | `src-tauri/crates/dstu-media/src/media/commands.rs:366` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `media_transcribe_start` | `host/plugins/media/index.ts:38` | `src-tauri/src/media/commands.rs:28` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `media_transcript_get` | `host/plugins/media/index.ts:37` | `src-tauri/crates/dstu-media/src/media/commands.rs:382` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `media_transcript_import` | `host/plugins/media/index.ts:37` | `src-tauri/crates/dstu-media/src/media/commands.rs:422` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `process_pdf_ocr` | `host/plugins/media/index.ts:57` | `src-tauri/src/commands.rs:774` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.page_results[].image_path（宿主写 null 不被契约校验拦截） |
| IPC `process_pdf_ocr` | `host/plugins/media/index.ts:57` | `src-tauri/src/commands.rs:774` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.page_results[].blocks[].bbox.x, .page_results[].blocks[].bbox.y, .page_results[].blocks[].bbox.width, .page_results[].blocks[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `rename_exam_sheet_session` | `host/plugins/media/api.ts:226` | `src-tauri/src/commands.rs:980` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.summary.exam_name, .summary.metadata, .summary.metadata.instructions, .summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `rename_exam_sheet_session` | `host/plugins/media/api.ts:226` | `src-tauri/src/commands.rs:980` | 其他 | low | 需人工核对 |  | date-time：.summary.created_at, .summary.updated_at |
| IPC `resume_question_import` | `host/plugins/media/api.ts:450` | `src-tauri/src/commands.rs:1285` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.summary.exam_name, .summary.metadata, .summary.metadata.instructions, .summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `resume_question_import` | `host/plugins/media/api.ts:450` | `src-tauri/src/commands.rs:1285` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.preview.pages[].cards[].bbox.x, .preview.pages[].cards[].bbox.y, .preview.pages[].cards[].bbox.width, .preview.pages[].cards[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `resume_question_import` | `host/plugins/media/api.ts:450` | `src-tauri/src/commands.rs:1285` | 其他 | low | 需人工核对 |  | date-time：.summary.created_at, .summary.updated_at |
| IPC `update_exam_sheet_cards` | `host/plugins/media/api.ts:224` | `src-tauri/src/commands.rs:957` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.detail.summary.exam_name, .detail.summary.metadata, .detail.summary.metadata.instructions, .detail.summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `update_exam_sheet_cards` | `host/plugins/media/api.ts:224` | `src-tauri/src/commands.rs:957` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.detail.preview.pages[].cards[].bbox.x, .detail.preview.pages[].cards[].bbox.y, .detail.preview.pages[].cards[].bbox.width, .detail.preview.pages[].cards[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `update_exam_sheet_cards` | `host/plugins/media/api.ts:224` | `src-tauri/src/commands.rs:957` | 其他 | low | 需人工核对 |  | date-time：.detail.summary.created_at, .detail.summary.updated_at |

### memory

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `insight_events.payload_json` | `host/plugins/memory/repository/insight-cards.ts:490` | `src-tauri/crates/dstu-research/src/insight/recall.rs:401` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（params.payloadJson ?? null） |
| DB `insight_events.payload_json` | `host/plugins/memory/repository/insight.ts:38` | `src-tauri/crates/dstu-research/src/insight/recall.rs:401` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（payloadJson） |
| DB `insight_jobs.payload_json` | `host/plugins/memory/repository/insight-jobs.ts:26` | `src-tauri/crates/dstu-research/src/insight/jobs.rs:59` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（payloadJson） |
| DB `memory_audit_log.extra_json` | `host/plugins/memory/repository/audit.ts:133` | `src-tauri/crates/dstu-memory/src/memory/audit_log.rs:125` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（entry.extraJson） |
| IPC `memory_get_audit_logs` | `host/plugins/memory/index.ts:60` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:947` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].confidence（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `memory_get_tree` | `host/plugins/memory/index.ts:54` | `src-tauri/crates/dstu-memory/src/memory/handlers.rs:353` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.folder.parentId, .folder.icon, .folder.color, .items[].folderId（宿主写 null 不被契约校验拦截） |

### notes

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `notes_migrate_blocks` | `host/plugins/notes/index.ts:75` | `src-tauri/src/cmd/notes.rs:677` | None（null/省略） | high | 自动判定 | 2 | Rust 省略 None：.deletedAt, .props（宿主写 null 不被契约校验拦截） |
| DB `note_document_revisions.asset_refs_json` | `host/plugins/notes/repository/import-archive.ts:758` | `src-tauri/crates/dstu-notes/src/notes_exporter.rs:1165`<br>`Vec<NoteAssetRef>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:15` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `note_document_revisions.asset_refs_json` | `host/plugins/notes/repository/revisions.ts:233` | `src-tauri/crates/dstu-notes/src/notes_exporter.rs:1165`<br>`Vec<NoteAssetRef>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:15` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `note_document_revisions.props_json` | `host/plugins/notes/repository/import-archive.ts:757` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:183` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_document_revisions.props_json` | `host/plugins/notes/repository/revisions.ts:232` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:183` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_editor_lease_acks.draft_json` | `host/plugins/notes/repository/leases.ts:241` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:294`<br>`FrozenDraft` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:18` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `note_editor_lease_acks.draft_json` | `host/plugins/notes/repository/leases.ts:297` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:294`<br>`FrozenDraft` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:18` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `note_editor_lease_acks.draft_json` | `host/plugins/notes/repository/leases.ts:347` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:294`<br>`FrozenDraft` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:18` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `note_learning_relations.locator_json` | `host/plugins/notes/repository/import-archive.ts:805` | `src-tauri/crates/dstu-notes/src/notes_exporter.rs:1026` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `note_learning_relations.locator_json` | `host/plugins/notes/repository/relations.ts:187` | `src-tauri/crates/dstu-notes/src/notes_exporter.rs:1026` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `note_review_save_receipts.request_json` | `host/plugins/notes/repository/review.ts:34` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_review_repo.rs:112` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_review_save_receipts.result_json` | `host/plugins/notes/repository/review.ts:76` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_review_repo.rs:112` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_state.value_json` | `host/plugins/notes/repository/state.ts:76` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_state_repo.rs:163` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_transfer_operations.asset_refs_json` | `host/plugins/notes/repository/transfer.ts:185` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_transfer_repo.rs:210` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_transfer_operations.request_json` | `host/plugins/notes/repository/transfer.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_transfer_repo.rs:210` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_transfer_operations.result_json` | `host/plugins/notes/repository/transfer.ts:185` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_transfer_repo.rs:210` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `note_transfer_operations.undo_result_json` | `host/plugins/notes/repository/transfer.ts:209` | `src-tauri/crates/dstu-vfs/src/vfs/repos/note_transfer_repo.rs:246` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| IPC `notes_history_restore_copy` | `host/plugins/notes/index.ts:78` | `src-tauri/src/cmd/notes.rs:1077` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `notes_history_restore_current` | `host/plugins/notes/index.ts:78` | `src-tauri/src/cmd/notes.rs:972` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `notes_history_restore_selection_copy` | `host/plugins/notes/index.ts:78` | `src-tauri/src/cmd/notes.rs:952` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `notes_import_markdown` | `host/plugins/notes/index.ts:88` | `src-tauri/src/cmd/notes.rs:2668` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `notes_import_markdown_batch` | `host/plugins/notes/index.ts:88` | `src-tauri/src/cmd/notes.rs:2722` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.imported[].size, .imported[].children, .imported[].childCount, .imported[].resourceId（宿主写 null 不被契约校验拦截） |
| DB `notes.props` | `host/plugins/notes/repository/import-archive.ts:660` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |

### platform/errors

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `cloud_config_ssot_get` | `host/platform/errors/cloud-config-commands.ts:12` | `src-tauri/src/cloud_config_commands.rs:18` | None（null/省略） | high | 自动判定 | 1 | Rust 省略 None：.provider, .root, .config, .config.root（宿主写 null 不被契约校验拦截） |
| IPC `cloud_config_publish` | `host/platform/errors/cloud-config-commands.ts:2` | `src-tauri/src/cloud_config_commands.rs:27` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.root, .config.root, .config.allow_insecure, .config.s3.region（宿主写 null 不被契约校验拦截） |
| IPC `cloud_config_ssot_clear` | `host/platform/errors/cloud-config-commands.ts:13` | `src-tauri/src/cloud_config_commands.rs:47` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.provider, .root, .config, .config.root（宿主写 null 不被契约校验拦截） |
| IPC `cloud_config_ssot_save` | `host/platform/errors/cloud-config-commands.ts:11` | `src-tauri/src/cloud_config_commands.rs:10` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.provider, .root, .config, .config.root（宿主写 null 不被契约校验拦截） |

### platform/settings

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `get_backup_config` | `host/platform/settings/backup-commands.ts:101` | `src-tauri/src/backup_config.rs:115` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.backupTiers（宿主写 null 不被契约校验拦截） |

### platform/storage

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `__audit_log.details` | `host/platform/storage/migration/audit-log.ts:118` | `src-tauri/crates/dstu-storage/src/audit/mod.rs:245`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `__audit_log.operation_data` | `host/platform/storage/migration/audit-log.ts:117` | `src-tauri/crates/dstu-storage/src/audit/mod.rs:245`<br>`AuditOperation` @ `src-tauri/crates/dstu-storage/src/audit/mod.rs:46` | 其他 | low | 需人工核对 |  | enum 标记 $（tag/content/untagged） |
| IPC `get_startup_recovery_status` | `host/platform/storage/index.ts:74` | `src-tauri/crates/dstu-storage/src/data_space.rs:2169` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.incident, .incident.resolved_at, .incident.selected_candidate, .incident.recovery_error（宿主写 null 不被契约校验拦截） |
| IPC `list_startup_recovery_incidents` | `host/platform/storage/index.ts:74` | `src-tauri/crates/dstu-storage/src/data_space.rs:2469` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resolved_at, [].selected_candidate, [].recovery_error, [].failed_operation（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_by_caller` | `host/platform/storage/index.ts:80` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:39` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].estimatedCostUsd, [].percentage（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_by_model` | `host/platform/storage/index.ts:80` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:29` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].estimatedCostUsd, [].percentage, [].avgTokensPerRequest（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_daily` | `host/platform/storage/index.ts:81` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:79` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].callerType, [].modelId, [].totalReasoningTokens, [].totalCachedTokens（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_get_trends` | `host/platform/storage/index.ts:80` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:11` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].estimatedCostUsd, [].successRate（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_recent` | `host/platform/storage/index.ts:81` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:70` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].callerId, [].variantId, [].runId, [].configId（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_recent` | `host/platform/storage/index.ts:81` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:70` | 其他 | low | 需人工核对 |  | date-time：[].createdAt |
| IPC `llm_usage_session_summary` | `host/platform/storage/index.ts:81` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:61` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.estimatedCostUsd（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_summary` | `host/platform/storage/index.ts:80` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:49` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.totalReasoningTokens, .totalCachedTokens, .totalEstimatedCostUsd, .avgTokensPerRequest（宿主写 null 不被契约校验拦截） |
| IPC `llm_usage_summary` | `host/platform/storage/index.ts:80` | `src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:49` | 其他 | low | 需人工核对 |  | date-time：.startDate, .endDate |
| IPC `retry_startup_recovery_preflight` | `host/platform/storage/index.ts:74` | `src-tauri/crates/dstu-storage/src/data_space.rs:2190` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.incident, .incident.resolved_at, .incident.selected_candidate, .incident.recovery_error（宿主写 null 不被契约校验拦截） |

### qbank

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `import_question_bank` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1087` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.summary.exam_name, .summary.metadata, .summary.metadata.instructions, .summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `import_question_bank` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1087` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.preview.pages[].cards[].bbox.x, .preview.pages[].cards[].bbox.y, .preview.pages[].cards[].bbox.width, .preview.pages[].cards[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `import_question_bank` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1087` | 其他 | low | 需人工核对 |  | date-time：.summary.created_at, .summary.updated_at |
| IPC `import_question_bank_stream` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1122` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.summary.exam_name, .summary.metadata, .summary.metadata.instructions, .summary.metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `import_question_bank_stream` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1122` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.preview.pages[].cards[].bbox.x, .preview.pages[].cards[].bbox.y, .preview.pages[].cards[].bbox.width, .preview.pages[].cards[].bbox.height（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `import_question_bank_stream` | `host/plugins/qbank/index.ts:408` | `src-tauri/src/commands.rs:1122` | 其他 | low | 需人工核对 |  | date-time：.summary.created_at, .summary.updated_at |
| IPC `list_exam_sheet_sessions` | `host/plugins/qbank/index.ts:381` | `src-tauri/src/commands.rs:932` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.sessions[].exam_name, .sessions[].metadata, .sessions[].metadata.instructions, .sessions[].metadata.tags（宿主写 null 不被契约校验拦截） |
| IPC `list_exam_sheet_sessions` | `host/plugins/qbank/index.ts:381` | `src-tauri/src/commands.rs:932` | 其他 | low | 需人工核对 |  | date-time：.sessions[].created_at, .sessions[].updated_at |
| IPC `qbank_ai_generate_questions` | `host/plugins/qbank/index.ts:403` | `src-tauri/src/qbank_generation.rs:16` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.drafts[].local_id, .drafts[].group_id, .drafts[].original_label, .drafts[].structured_data（宿主写 null 不被契约校验拦截） |
| IPC `qbank_batch_create_questions` | `host/plugins/qbank/index.ts:386` | `src-tauri/src/commands.rs:7718` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].images[].role, [].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_cancel_generation_task` | `host/plugins/qbank/index.ts:403` | `src-tauri/src/qbank_generation.rs:48` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.drafts[].local_id, .drafts[].group_id, .drafts[].original_label, .drafts[].structured_data（宿主写 null 不被契约校验拦截） |
| IPC `qbank_create_practice` | `host/plugins/qbank/index.ts:390` | `src-tauri/src/qbank_practice.rs:16` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_crop_source_image` | `host/plugins/qbank/index.ts:402` | `src-tauri/src/commands.rs:8609` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.role（宿主写 null 不被契约校验拦截） |
| DB `qbank_generation_tasks.authoring_result_json` | `host/plugins/qbank/repository/generation-tasks.ts:122` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:283`<br>`super::types::QbankGenerationResponse` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:137` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 .document, .model_route, .drafts[].structured_data：Rust 构造时的浮点值写 `.0` |
| DB `qbank_generation_tasks.authoring_result_json` | `host/plugins/qbank/repository/generation-tasks.ts:122` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:283`<br>`super::types::QbankGenerationResponse` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:137` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `qbank_generation_tasks.drafts_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[GeneratedQuestionDraft]` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:83` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 .structured_data：Rust 构造时的浮点值写 `.0` |
| DB `qbank_generation_tasks.drafts_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[GeneratedQuestionDraft]` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:83` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：local_id, group_id, original_label, structured_data；Rust 写 null：options, answer, explanation, difficulty |
| DB `qbank_generation_tasks.drafts_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[GeneratedQuestionDraft]` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:83` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `qbank_generation_tasks.rejection_reasons_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[String]` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `qbank_generation_tasks.request_json` | `host/plugins/qbank/repository/generation-tasks.ts:96` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:139` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（requestJson） |
| DB `qbank_generation_tasks.skipped_references_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[SkippedReference]` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:329` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：detail |
| DB `qbank_generation_tasks.skipped_references_json` | `host/plugins/qbank/repository/generation-tasks.ts:114` | `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs:231`<br>`[SkippedReference]` @ `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs:329` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| IPC `qbank_get_authoring_draft` | `host/plugins/qbank/index.ts:398` | `src-tauri/src/commands.rs:1386` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.document.materials[].images[].role, .document.questions[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_get_question_by_card_id` | `host/plugins/qbank/index.ts:385` | `src-tauri/src/commands.rs:7689` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role, .materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_grade_practice_manually` | `host/plugins/qbank/index.ts:392` | `src-tauri/src/qbank_practice.rs:112` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| DB `qbank_import_jobs.document_json` | `host/plugins/qbank/repository/authoring.ts:106` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:105`<br>`QuestionDocument` @ `src-tauri/crates/dstu-qbank/src/qbank_document.rs:88` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .materials[].source_refs[].bbox, .materials[].figures[].bbox：JSON.stringify 对整数值不写 `.0` |
| DB `qbank_import_jobs.document_json` | `host/plugins/qbank/repository/authoring.ts:106` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:105`<br>`QuestionDocument` @ `src-tauri/crates/dstu-qbank/src/qbank_document.rs:88` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `qbank_import_jobs.document_json` | `host/plugins/qbank/repository/authoring.ts:171` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:105`<br>`QuestionDocument` @ `src-tauri/crates/dstu-qbank/src/qbank_document.rs:88` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .materials[].source_refs[].bbox, .materials[].figures[].bbox：JSON.stringify 对整数值不写 `.0` |
| DB `qbank_import_jobs.document_json` | `host/plugins/qbank/repository/authoring.ts:171` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:105`<br>`QuestionDocument` @ `src-tauri/crates/dstu-qbank/src/qbank_document.rs:88` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `qbank_import_jobs.metadata_json` | `host/plugins/qbank/repository/authoring.ts:171` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:685`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_import_jobs.metadata_json` | `host/plugins/qbank/repository/legacy.ts:870` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:685`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_import_jobs.receipt_json` | `host/plugins/qbank/repository/authoring.ts:194` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:535` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_import_jobs.selected_json` | `host/plugins/qbank/src/authoring-service.ts:173` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:535` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| IPC `qbank_list_generation_tasks` | `host/plugins/qbank/index.ts:383` | `src-tauri/src/qbank_generation.rs:37` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].drafts[].local_id, [].drafts[].group_id, [].drafts[].original_label, [].drafts[].structured_data（宿主写 null 不被契约校验拦截） |
| IPC `qbank_list_mistakes` | `host/plugins/qbank/index.ts:384` | `src-tauri/src/commands.rs:7600` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].images[].role, .items[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_list_structure` | `host/plugins/qbank/index.ts:397` | `src-tauri/src/commands.rs:1530` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.materials[].images[].role（宿主写 null 不被契约校验拦截） |
| DB `qbank_materials.images_json` | `host/plugins/qbank/repository/authoring.ts:357` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:431` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_materials.source_refs_json` | `host/plugins/qbank/repository/authoring.ts:358` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:431` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_materials.source_refs_json` | `host/plugins/qbank/repository/exam-cascade.ts:64` | `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs:431` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `qbank_papers.document_json` | `host/plugins/qbank/repository/practice.ts:28` | `src-tauri/src/chat_v2/tools/qbank_executor.rs:4144` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `qbank_papers.document_json` | `host/plugins/qbank/repository/practice.ts:47` | `src-tauri/src/chat_v2/tools/qbank_executor.rs:4144` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `qbank_papers.document_json` | `host/plugins/qbank/repository/practice.ts:53` | `src-tauri/src/chat_v2/tools/qbank_executor.rs:4144` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `qbank_practice_attempts.document_json` | `host/plugins/qbank/repository/practice.ts:59` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| DB `qbank_practice_attempts.document_json` | `host/plugins/qbank/repository/practice.ts:77` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| DB `qbank_practice_drafts.document_json` | `host/plugins/qbank/repository/practice.ts:65` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| DB `qbank_practice_drafts.document_json` | `host/plugins/qbank/repository/practice.ts:71` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| IPC `qbank_retry_practice_grading` | `host/plugins/qbank/index.ts:393` | `src-tauri/src/qbank_practice.rs:101` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_review_authoring_draft` | `host/plugins/qbank/index.ts:398` | `src-tauri/src/commands.rs:1410` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.document.materials[].images[].role, .document.questions[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_save_practice` | `host/plugins/qbank/index.ts:390` | `src-tauri/src/qbank_practice.rs:25` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| DB `qbank_sources.descriptor_json` | `host/plugins/qbank/repository/authoring.ts:302` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| DB `qbank_sources.descriptor_json` | `host/plugins/qbank/repository/authoring.ts:306` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| IPC `qbank_submit_practice` | `host/plugins/qbank/index.ts:391` | `src-tauri/src/qbank_practice.rs:53` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.questions[].images[].role, .questions[].materials[].images[].role（宿主写 null 不被契约校验拦截） |
| IPC `qbank_update_material` | `host/plugins/qbank/index.ts:399` | `src-tauri/src/commands.rs:1432` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.images[].role（宿主写 null 不被契约校验拦截） |

### review

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `fsrs_review_logs.state_before_json` | `host/plugins/review/src/review.ts:255` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:2263`<br>`FsrsStateBeforeSnapshot` @ `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:859` | f64 整数 `.0` | high | 自动判定 | 42 | 浮点字段 .stability, .difficulty, .elapsedDays, .scheduledDays：JSON.stringify 对整数值不写 `.0` |
| DB `fsrs_review_logs.state_before_json` | `host/plugins/review/src/review.ts:255` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:2263`<br>`FsrsStateBeforeSnapshot` @ `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:859` | None（null/省略） | medium | 需人工核对 |  | Rust 写 null：deckId, stability, difficulty, lastReviewMs |
| DB `fsrs_review_logs.state_before_json` | `host/plugins/review/src/review.ts:255` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:2263`<br>`FsrsStateBeforeSnapshot` @ `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:859` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `anki_decks.config_json` | `host/plugins/review/repository/fsrs.ts:172` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:3637`<br>`serde_json::Value` | f64 整数 `.0` | high | 自动判定 | 10 | 浮点字段 `$.learning_steps[]`, `$.relearning_steps[]`：JSON.stringify 对整数值不写 `.0` |
| DB `anki_decks.config_json` | `host/plugins/review/repository/fsrs.ts:172` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:3637`<br>`serde_json::Value` | 精度（f32/u64） | high | 自动判定 | 17 | f32 字段 `$.fsrs_params[]`：宿主须按 binary32 最短表示写出 |
| IPC `fsrs_get_card_memory_history` | `host/plugins/review/index.ts:161` | `src-tauri/src/cmd/fsrs_review.rs:544` | None（null/省略） | high | 自动判定 | 1 | Rust 省略 None：.card.text（宿主写 null 不被契约校验拦截） |
| IPC `essay_grading_create_custom_mode` | `host/plugins/review/index.ts:174` | `src-tauri/src/essay_grading/mod.rs:157` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.score_dimensions[].max_score, .total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_create_session` | `host/plugins/review/index.ts:170` | `src-tauri/src/essay_grading/mod.rs:37` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.latest_score, .deleted_at（宿主写 null 不被契约校验拦截） |
| IPC `essay_grading_get_mode` | `host/plugins/review/index.ts:173` | `src-tauri/src/essay_grading/mod.rs:144` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.score_dimensions[].max_score, .total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_get_modes` | `host/plugins/review/index.ts:173` | `src-tauri/src/essay_grading/mod.rs:136` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].score_dimensions[].max_score, [].total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_get_round` | `host/plugins/review/index.ts:172` | `src-tauri/src/essay_grading/mod.rs:117` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.overall_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_get_rounds` | `host/plugins/review/index.ts:172` | `src-tauri/src/essay_grading/mod.rs:108` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].overall_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_get_session` | `host/plugins/review/index.ts:170` | `src-tauri/src/essay_grading/mod.rs:56` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.latest_score, .deleted_at（宿主写 null 不被契约校验拦截） |
| IPC `essay_grading_list_custom_modes` | `host/plugins/review/index.ts:175` | `src-tauri/src/essay_grading/mod.rs:184` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].score_dimensions[].max_score, [].total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_list_sessions` | `host/plugins/review/index.ts:171` | `src-tauri/src/essay_grading/mod.rs:88` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].latest_score, [].deleted_at（宿主写 null 不被契约校验拦截） |
| IPC `essay_grading_reset_builtin_mode` | `host/plugins/review/index.ts:176` | `src-tauri/src/essay_grading/mod.rs:201` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.score_dimensions[].max_score, .total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_save_builtin_override` | `host/plugins/review/index.ts:176` | `src-tauri/src/essay_grading/mod.rs:192` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.score_dimensions[].max_score, .total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_stream` | `host/plugins/review/index.ts:170` | `src-tauri/src/essay_grading/mod.rs:27` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.overall_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `essay_grading_update_custom_mode` | `host/plugins/review/index.ts:174` | `src-tauri/src/essay_grading/mod.rs:166` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.score_dimensions[].max_score, .total_max_score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `fsrs_enqueue_cards` | `host/plugins/review/index.ts:158` | `src-tauri/src/cmd/fsrs_review.rs:107` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.reviewCards[].text, .reviewCards[].templateId, .reviewCards[].errorContent（宿主写 null 不被契约校验拦截） |
| IPC `fsrs_get_due` | `host/plugins/review/index.ts:158` | `src-tauri/src/cmd/fsrs_review.rs:129` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].text, [].templateId, [].errorContent（宿主写 null 不被契约校验拦截） |
| IPC `fsrs_get_memory_overview` | `host/plugins/review/index.ts:161` | `src-tauri/src/cmd/fsrs_review.rs:533` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.recent[].text（宿主写 null 不被契约校验拦截） |
| IPC `fsrs_optimize_parameters` | `host/plugins/review/index.ts:162` | `src-tauri/src/cmd/fsrs_review.rs:572` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.current.logLoss, .current.rmseBins, .optimized.logLoss, .optimized.rmseBins（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `mastery_get_overview` | `host/plugins/review/index.ts:157` | `src-tauri/crates/dstu-learning/src/mastery/mod.rs:23` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.todayPriorityReview[].dueCardCount（宿主写 null 不被契约校验拦截） |

### sync

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `__sync_conflicts.data_json` | `host/plugins/sync/repository/conflict-resolver.ts:115` | `src-tauri/crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs:495` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（dataJson） |
| DB `__sync_quarantine.baseline_json` | `host/plugins/sync/repository/apply-quarantine.ts:140` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（baselineJson） |
| DB `__sync_quarantine.baseline_json` | `host/plugins/sync/repository/quarantine.ts:271` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（baselineJson） |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/apply-quarantine.ts:140` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 .data：Rust 构造时的浮点值写 `.0` |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/apply-quarantine.ts:140` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：change_log_id, database_name, suppress_change_log, source_device_id；Rust 写 null：data |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/apply-quarantine.ts:140` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/apply-quarantine.ts:140` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；u64/i64 字段 .change_log_id, .source_seq：超过 2^53 时 number 失精度 |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/quarantine.ts:271` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 .data：Rust 构造时的浮点值写 `.0` |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/quarantine.ts:271` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：change_log_id, database_name, suppress_change_log, source_device_id；Rust 写 null：data |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/quarantine.ts:271` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `__sync_quarantine.payload_json` | `host/plugins/sync/repository/quarantine.ts:271` | `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:6639`<br>`SyncChangeWithData` @ `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；u64/i64 字段 .change_log_id, .source_seq：超过 2^53 时 number 失精度 |
| DB `__sync_record_history.data_json` | `host/plugins/sync/repository/history.ts:84` | `src-tauri/crates/dstu-sync/src/data_governance/sync/history.rs:120` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（dataJson） |
| IPC `data_governance_list_unsynced_items` | `host/plugins/sync/index.ts:85` | `src-tauri/src/data_governance/commands_sync.rs:5812` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].counterpart, .items[].size（宿主写 null 不被契约校验拦截） |
| IPC `data_governance_list_unsynced_items` | `host/plugins/sync/index.ts:85` | `src-tauri/src/data_governance/commands_sync.rs:5812` | 其他 | low | 需人工核对 |  | date-time：.generatedAt |
| IPC `data_governance_repo_check` | `host/plugins/sync/index.ts:75` | `src-tauri/src/data_governance/commands_sync.rs:5150` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.problems[].objectKey, .problems[].versionId（宿主写 null 不被契约校验拦截） |
| IPC `data_governance_repo_check` | `host/plugins/sync/index.ts:75` | `src-tauri/src/data_governance/commands_sync.rs:5150` | 其他 | low | 需人工核对 |  | date-time：.checkedAt |

### sync-providers

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `cloud_storage_list` | `host/plugins/sync-providers/index.ts:46` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:334` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].etag（宿主写 null 不被契约校验拦截） |
| IPC `cloud_storage_list` | `host/plugins/sync-providers/index.ts:46` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:334` | 其他 | low | 需人工核对 |  | date-time：[].lastModified |
| IPC `cloud_storage_stat` | `host/plugins/sync-providers/index.ts:48` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:358` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.etag（宿主写 null 不被契约校验拦截） |
| IPC `cloud_storage_stat` | `host/plugins/sync-providers/index.ts:48` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:358` | 其他 | low | 需人工核对 |  | date-time：.lastModified |
| IPC `cloud_sync_download` | `host/plugins/sync-providers/index.ts:50` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:552` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.version.appVersion, .version.note, .version.recoveryKind（宿主写 null 不被契约校验拦截） |
| IPC `cloud_sync_download` | `host/plugins/sync-providers/index.ts:50` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:552` | 其他 | low | 需人工核对 |  | date-time：.version.timestamp |
| IPC `cloud_sync_get_status` | `host/plugins/sync-providers/index.ts:52` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:384` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.latestVersion, .latestVersion.appVersion, .latestVersion.note, .latestVersion.recoveryKind（宿主写 null 不被契约校验拦截） |
| IPC `cloud_sync_get_status` | `host/plugins/sync-providers/index.ts:52` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:384` | 其他 | low | 需人工核对 |  | date-time：.latestVersion.timestamp, .lastSyncTime, .encryptionMemoryPersistFailure.at |
| IPC `cloud_sync_list_versions` | `host/plugins/sync-providers/index.ts:53` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:396` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].appVersion, [].note, [].recoveryKind（宿主写 null 不被契约校验拦截） |
| IPC `cloud_sync_list_versions` | `host/plugins/sync-providers/index.ts:53` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:396` | 其他 | low | 需人工核对 |  | date-time：[].timestamp |
| IPC `cloud_sync_upload` | `host/plugins/sync-providers/index.ts:54` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:410` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.version.appVersion, .version.note, .version.recoveryKind（宿主写 null 不被契约校验拦截） |
| IPC `cloud_sync_upload` | `host/plugins/sync-providers/index.ts:54` | `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:410` | 其他 | low | 需人工核对 |  | date-time：.version.timestamp |

### sync-support

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `__sync_conflicts.data_json` | `host/plugins/sync-support/src/conflicts.ts:132` | `src-tauri/crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs:495` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |

### translation

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `resources.data` | `host/plugins/translation/repository/translations.ts:83` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| IPC `translate_text_candidates` | `host/plugins/translation/index.ts:32` | `src-tauri/src/translation/candidates.rs:21` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.candidates[].error, .detected_lang（宿主写 null 不被契约校验拦截） |
| DB `translations.metadata_json` | `host/plugins/translation/index.ts:84` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |
| DB `translations.metadata_json` | `host/plugins/translation/repository/translations.ts:219` | — | 其他 | low | 需人工核对 |  | 未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列） |

### vfs

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `exam_sheets.preview_json` | `host/plugins/vfs/repository/update.ts:129` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 12 | 浮点字段 `$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`：JSON.stringify 对整数值不写 `.0` |
| DB `resources.data` | `host/plugins/vfs/repository/update.ts:726` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| IPC `dstu_copy` | `host/plugins/vfs/index.ts:126` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:2243` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_create` | `host/plugins/vfs/index.ts:125` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:726` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_export` | `host/plugins/vfs/index.ts:135` | `src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs:303` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.content, .dataBase64, .tempPath（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_add_item` | `host/plugins/vfs/index.ts:91` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:471` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.folderId, .cachedPath（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_get` | `host/plugins/vfs/index.ts:94` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:233` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.parentId, .icon, .color（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_get_all_resources` | `host/plugins/vfs/index.ts:95` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:762` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.resources[].resourceId, .resources[].content（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_get_items` | `host/plugins/vfs/index.ts:97` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:704` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].folderId, [].cachedPath（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_get_tree` | `host/plugins/vfs/index.ts:98` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:669` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].folder.parentId, [].folder.icon, [].folder.color, [].items[].folderId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_folder_list` | `host/plugins/vfs/index.ts:99` | `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:637` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].parentId, [].icon, [].color（宿主写 null 不被契约校验拦截） |
| IPC `dstu_get` | `host/plugins/vfs/index.ts:112` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:467` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_get_resource_by_path` | `host/plugins/vfs/index.ts:114` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6042` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_list` | `host/plugins/vfs/index.ts:120` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:171` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].size, [].children, [].childCount, [].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_list_deleted` | `host/plugins/vfs/index.ts:120` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4857` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].size, [].children, [].childCount, [].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_search` | `host/plugins/vfs/index.ts:122` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3269` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].size, [].children, [].childCount, [].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_search_in_folder` | `host/plugins/vfs/index.ts:122` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5654` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].size, [].children, [].childCount, [].resourceId（宿主写 null 不被契约校验拦截） |
| IPC `dstu_update` | `host/plugins/vfs/index.ts:125` | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1438` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.size, .children, .childCount, .resourceId（宿主写 null 不被契约校验拦截） |
| DB `files.bookmarks_json` | `host/plugins/vfs/repository/update.ts:842` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:707`<br>`[Value]` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `files.bookmarks_json` | `host/plugins/vfs/repository/update.ts:875` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:707`<br>`[Value]` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs/src/upload-file.ts:281` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs/src/upload-file.ts:281` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs/src/upload-file.ts:281` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `mindmaps.settings` | `host/plugins/vfs/repository/update.ts:399` | `src-tauri/crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:725` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `resources.metadata_json` | `host/plugins/vfs/repository/update.ts:943` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/vfs/repository/update.ts:943` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/vfs/repository/update.ts:943` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/vfs/repository/update.ts:943` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | u64/i64 字段 .size：超过 2^53 时 number 失精度 |
| IPC `vfs_upload_attachment` | `host/plugins/vfs/index.ts:145` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1327` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.attachment.resourceId, .attachment.blobHash, .attachment.previewJson, .attachment.extractedText（宿主写 null 不被契约校验拦截） |
| IPC `vfs_upload_attachment` | `host/plugins/vfs/index.ts:145` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1327` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.processingPercent（宿主须返回 Math.fround 后的最短十进制值） |

### vfs-handlers

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| IPC `pomodoro_create_record` | `host/plugins/vfs-handlers/index.ts:177` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1175` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.todoItemId, .endTime, .updatedAt, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `pomodoro_get_record` | `host/plugins/vfs-handlers/index.ts:180` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1204` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.todoItemId, .endTime, .updatedAt, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `pomodoro_list_by_todo` | `host/plugins/vfs-handlers/index.ts:182` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1216` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].todoItemId, [].endTime, [].updatedAt, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `pomodoro_list_range` | `host/plugins/vfs-handlers/index.ts:183` | `src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:48` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].todoItemId, [].endTime, [].updatedAt, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `pomodoro_list_today` | `host/plugins/vfs-handlers/index.ts:184` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1237` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].todoItemId, [].endTime, [].updatedAt, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_ai_breakdown` | `host/plugins/vfs-handlers/index.ts:34` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1007` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_batch_complete` | `host/plugins/vfs-handlers/index.ts:35` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:750` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].description, .items[].dueDate, .items[].dueTime, .items[].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_batch_move` | `host/plugins/vfs-handlers/index.ts:37` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:811` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].description, .items[].dueDate, .items[].dueTime, .items[].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_batch_reschedule` | `host/plugins/vfs-handlers/index.ts:39` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:769` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].description, .items[].dueDate, .items[].dueTime, .items[].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_batch_restore` | `host/plugins/vfs-handlers/index.ts:40` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:849` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].description, .items[].dueDate, .items[].dueTime, .items[].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_batch_set_priority` | `host/plugins/vfs-handlers/index.ts:41` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:791` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.items[].description, .items[].dueDate, .items[].dueTime, .items[].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_create_item` | `host/plugins/vfs-handlers/index.ts:43` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:452` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_create_list` | `host/plugins/vfs-handlers/index.ts:44` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:231` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_ensure_inbox` | `host/plugins/vfs-handlers/index.ts:47` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:317` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_get_item` | `host/plugins/vfs-handlers/index.ts:49` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:480` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_get_list` | `host/plugins/vfs-handlers/index.ts:50` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:254` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_all_pending` | `host/plugins/vfs-handlers/index.ts:51` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:669` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_completed` | `host/plugins/vfs-handlers/index.ts:53` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:679` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_deleted_items` | `host/plugins/vfs-handlers/index.ts:54` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:408` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_deleted_lists` | `host/plugins/vfs-handlers/index.ts:55` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:344` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].icon, [].color, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_items` | `host/plugins/vfs-handlers/index.ts:56` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:492` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_items_with_stats` | `host/plugins/vfs-handlers/index.ts:57` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:927` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_lists` | `host/plugins/vfs-handlers/index.ts:58` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:263` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].icon, [].color, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_overdue` | `host/plugins/vfs-handlers/index.ts:59` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:629` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_reminders` | `host/plugins/vfs-handlers/index.ts:60` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:659` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_today` | `host/plugins/vfs-handlers/index.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:612` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_list_upcoming` | `host/plugins/vfs-handlers/index.ts:62` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:644` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_move_item` | `host/plugins/vfs-handlers/index.ts:63` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:594` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_restore_item` | `host/plugins/vfs-handlers/index.ts:70` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:396` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_restore_list` | `host/plugins/vfs-handlers/index.ts:71` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:358` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_search` | `host/plugins/vfs-handlers/index.ts:72` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:696` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].dueDate, [].dueTime, [].reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_toggle_item` | `host/plugins/vfs-handlers/index.ts:74` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:547` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_toggle_list_favorite` | `host/plugins/vfs-handlers/index.ts:75` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:305` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `todo_update_item` | `host/plugins/vfs-handlers/index.ts:77` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:508` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .dueDate, .dueTime, .reminder（宿主写 null 不被契约校验拦截） |
| IPC `todo_update_list` | `host/plugins/vfs-handlers/index.ts:78` | `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:272` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .icon, .color, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_create_mindmap` | `host/plugins/vfs-handlers/index.ts:113` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5088` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .theme, .settings, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_create_note` | `host/plugins/vfs-handlers/index.ts:90` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:460` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.deletedAt, .props（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_attachment` | `host/plugins/vfs-handlers/index.ts:117` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1946` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.resourceId, .blobHash, .previewJson, .extractedText（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_attachment_content` | `host/plugins/vfs-handlers/index.ts:117` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1720` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.error（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_batch_pdf_processing_status` | `host/plugins/vfs-handlers/index.ts:121` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6628` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：{}.progress.currentPage, {}.progress.totalPages, {}.progress.mediaType, {}.progress.failedStages（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_batch_pdf_processing_status` | `host/plugins/vfs-handlers/index.ts:121` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6628` | 精度（f32/u64） | medium | 需人工核对 |  | f32：{}.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `vfs_get_file` | `host/plugins/vfs-handlers/index.ts:171` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2714` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.resourceId, .blobHash, .originalPath, .pageCount（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_mindmap` | `host/plugins/vfs-handlers/index.ts:113` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5115` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .theme, .settings, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_mindmap_version` | `host/plugins/vfs-handlers/index.ts:114` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5231` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.label, .source（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_mindmap_versions` | `host/plugins/vfs-handlers/index.ts:113` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5155` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].label, [].source（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_note` | `host/plugins/vfs-handlers/index.ts:92` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:567` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.deletedAt, .props（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_pdf_processing_status` | `host/plugins/vfs-handlers/index.ts:123` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6504` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.progress.currentPage, .progress.totalPages, .progress.mediaType, .progress.failedStages（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_pdf_processing_status` | `host/plugins/vfs-handlers/index.ts:123` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6504` | 精度（f32/u64） | medium | 需人工核对 |  | f32：.progress.percent（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `vfs_get_resource` | `host/plugins/vfs-handlers/index.ts:84` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:355` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.sourceId, .sourceTable, .data, .externalHash（宿主写 null 不被契约校验拦截） |
| IPC `vfs_get_resource_refs` | `host/plugins/vfs-handlers/index.ts:107` | `src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs:52` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.refs[].resourceId, .refs[].snippet, .refs[].injectModes, .refs[].injectModes.image（宿主写 null 不被契约校验拦截） |
| IPC `vfs_inspect_retrieval_capabilities` | `host/plugins/vfs-handlers/index.ts:156` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6354` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.textEmbedding.reason, .multimodalEmbedding.reason, .textModel.reason, .multimodalModel.reason（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_essays` | `host/plugins/vfs-handlers/index.ts:99` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:779` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].title, [].essayType, [].gradingResult, [].score（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_exam_sheets` | `host/plugins/vfs-handlers/index.ts:100` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:717` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resourceId, [].examName, [].linkedMistakeIds（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_files` | `host/plugins/vfs-handlers/index.ts:173` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2728` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resourceId, [].blobHash, [].originalPath, [].pageCount（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_mindmaps` | `host/plugins/vfs-handlers/index.ts:115` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5321` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].description, [].theme, [].settings, [].deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_notes` | `host/plugins/vfs-handlers/index.ts:94` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:614` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].deletedAt, [].props（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_pending_pdf_processing` | `host/plugins/vfs-handlers/index.ts:124` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6685` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resourceId, [].blobHash, [].originalPath, [].pageCount（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_textbooks` | `host/plugins/vfs-handlers/index.ts:101` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:682` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resourceId, [].blobHash, [].originalPath, [].pageCount（宿主写 null 不被契约校验拦截） |
| IPC `vfs_list_translations` | `host/plugins/vfs-handlers/index.ts:102` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:747` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].title, [].engine, [].model, [].qualityRating（宿主写 null 不被契约校验拦截） |
| IPC `vfs_multimodal_search` | `host/plugins/vfs-handlers/index.ts:160` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6295` | 精度（f32/u64） | medium | 需人工核对 |  | f32：[].score（宿主须返回 Math.fround 后的最短十进制值） |
| IPC `vfs_multimodal_search_detailed` | `host/plugins/vfs-handlers/index.ts:161` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6337` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.capabilitySnapshot.textEmbedding.reason, .capabilitySnapshot.multimodalEmbedding.reason, .capabilitySnapshot.textModel.reason, .capabilitySnapshot.multimodalModel.reason（宿主写 null 不被契约校验拦截） |
| IPC `vfs_rag_search` | `host/plugins/vfs-handlers/index.ts:164` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4889` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.results[].resourceTitle, .results[].resourceType, .results[].pageIndex, .results[].sourceId（宿主写 null 不被契约校验拦截） |
| IPC `vfs_resolve_resource_refs` | `host/plugins/vfs-handlers/index.ts:107` | `src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs:153` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].content, [].warning, [].multimodalBlocks, [].multimodalBlocks[].text（宿主写 null 不被契约校验拦截） |
| IPC `vfs_restore_mindmap_version` | `host/plugins/vfs-handlers/index.ts:114` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5187` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .theme, .settings, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_search` | `host/plugins/vfs-handlers/index.ts:165` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3132` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].resourceTitle, [].resourceType, [].pageIndex, [].sourceId（宿主写 null 不被契约校验拦截） |
| IPC `vfs_search_all` | `host/plugins/vfs-handlers/index.ts:103` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:811` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：[].updatedAt, [].metadata, [].metadata.name, [].metadata.title（宿主写 null 不被契约校验拦截） |
| IPC `vfs_update_mindmap` | `host/plugins/vfs-handlers/index.ts:114` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5250` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.description, .theme, .settings, .deletedAt（宿主写 null 不被契约校验拦截） |
| IPC `vfs_update_note` | `host/plugins/vfs-handlers/index.ts:95` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:516` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.deletedAt, .props（宿主写 null 不被契约校验拦截） |
| IPC `vfs_upload_file` | `host/plugins/vfs-handlers/src/upload-file.ts:2` | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2107` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：.file.resourceId, .file.blobHash, .file.originalPath, .file.pageCount（宿主写 null 不被契约校验拦截） |

### vfs-repos

| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |
|---|---|---|---|---|---|---:|---|
| DB `essays.dimension_scores_json` | `host/plugins/vfs-repos/repository/essays.ts:48` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:313` | f64 整数 `.0` | high | 自动判定 | 40 | G3：Rust 写 `.0`（`$.total`, `$.max_total`, `$.dimensions[].score`） |
| DB `essays.dimension_scores_json` | `host/plugins/vfs-repos/repository/exams.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:313` | f64 整数 `.0` | high | 自动判定 | 40 | G3：Rust 写 `.0`（`$.total`, `$.max_total`, `$.dimensions[].score`） |
| DB `essays.grading_result_json` | `host/plugins/vfs-repos/repository/essays.ts:255` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:432`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 5 | 浮点字段 `$.overall_score`：JSON.stringify 对整数值不写 `.0` |
| DB `essays.grading_result_json` | `host/plugins/vfs-repos/repository/essays.ts:48` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:432`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 5 | 浮点字段 `$.overall_score`：JSON.stringify 对整数值不写 `.0` |
| DB `essays.grading_result_json` | `host/plugins/vfs-repos/repository/exams.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs:432`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 5 | 浮点字段 `$.overall_score`：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:378` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:378` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:446` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:446` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:446` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/attachment-upload.ts:446` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:395` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:395` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:395` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:395` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:785` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:785` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:785` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:785` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:798` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:798` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:798` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:798` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:803` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:803` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:803` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:803` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:809` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:809` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:809` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:809` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:813` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:813` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:813` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/files.ts:813` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/maintenance.ts:658` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/maintenance.ts:658` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/maintenance.ts:658` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/maintenance.ts:658` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/textbooks.ts:233` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | f64 整数 `.0` | high | 自动判定 | 4 | 浮点字段 .percent：JSON.stringify 对整数值不写 `.0` |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/textbooks.ts:233` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .percent：宿主须按 binary32 最短表示写出 |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/textbooks.ts:233` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：currentPage, totalPages, mediaType, failedStages |
| DB `files.processing_progress` | `host/plugins/vfs-repos/repository/textbooks.ts:233` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:904`<br>`ProcessingProgress` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `exam_sheets.preview_json` | `host/plugins/vfs-repos/repository/essays.ts:48` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 12 | 浮点字段 `$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`：JSON.stringify 对整数值不写 `.0` |
| DB `exam_sheets.preview_json` | `host/plugins/vfs-repos/repository/exams.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 12 | 浮点字段 `$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`：JSON.stringify 对整数值不写 `.0` |
| DB `exam_sheets.preview_json` | `host/plugins/vfs-repos/repository/exams.ts:864` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 12 | 浮点字段 `$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`：JSON.stringify 对整数值不写 `.0` |
| DB `exam_sheets.preview_json` | `host/plugins/vfs-repos/repository/exams.ts:883` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1365`<br>`Value` | f64 整数 `.0` | high | 自动判定 | 12 | 浮点字段 `$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`：JSON.stringify 对整数值不写 `.0` |
| DB `resources.data` | `host/plugins/vfs-repos/repository/files.ts:311` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| DB `resources.data` | `host/plugins/vfs-repos/repository/resources.ts:170` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| DB `resources.data` | `host/plugins/vfs-repos/repository/resources.ts:389` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| DB `resources.data` | `host/plugins/vfs-repos/repository/textbooks.ts:215` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| DB `resources.data` | `host/plugins/vfs-repos/repository/translations.ts:176` | `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs:841` | f64 整数 `.0` | high | 自动判定 | 12 | G3：Rust 写 `.0`（`$.pages[].cards[].resolved_bbox.x`, `$.pages[].cards[].resolved_bbox.y`, `$.pages[].cards[].resolved_bbox.width`） |
| DB `answer_submissions.material_snapshot_json` | `host/plugins/vfs-repos/repository/questions.ts:720` | `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs:3100` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（materialSnapshot） |
| DB `answer_submissions.question_snapshot_json` | `host/plugins/vfs-repos/repository/questions.ts:720` | `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs:3100` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（questionSnapshot） |
| DB `exam_sheets.import_state_json` | `host/plugins/vfs-repos/repository/exams.ts:906` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1505`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `exam_sheets.linked_mistake_ids` | `host/plugins/vfs-repos/repository/exams.ts:658` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:720` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（linked） |
| DB `exam_sheets.metadata_json` | `host/plugins/vfs-repos/repository/essays.ts:48` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:288` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `exam_sheets.metadata_json` | `host/plugins/vfs-repos/repository/exams.ts:61` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:288` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `exam_sheets.mm_indexed_pages_json` | `host/plugins/vfs-repos/repository/exams.ts:1081` | `src-tauri/crates/dstu-vfs/src/vfs/multimodal_service.rs:1648` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（indexedPagesJsonOrError） |
| DB `exam_sheets.mm_indexed_pages_json` | `host/plugins/vfs-repos/repository/exams.ts:1102` | `src-tauri/crates/dstu-vfs/src/vfs/multimodal_service.rs:1648` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（indexedPagesJson） |
| DB `exam_sheets.ocr_pages_json` | `host/plugins/vfs-repos/repository/exams.ts:1024` | `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1840`<br>`[Option<String>]` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（ocrJson） |
| DB `files.bookmarks_json` | `host/plugins/vfs-repos/repository/textbooks.ts:397` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:707`<br>`[Value]` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `files.bookmarks_json` | `host/plugins/vfs-repos/repository/textbooks.ts:411` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:707`<br>`[Value]` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `files.mm_indexed_pages_json` | `host/plugins/vfs-repos/repository/attachments.ts:737` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:1842`<br>`Vec<PageIndexMeta>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:38` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.mm_indexed_pages_json` | `host/plugins/vfs-repos/repository/files.ts:829` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:1842`<br>`Vec<PageIndexMeta>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:38` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.mm_indexed_pages_json` | `host/plugins/vfs-repos/repository/textbooks.ts:788` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:1842`<br>`Vec<PageIndexMeta>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:38` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:483` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:483` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:483` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:526` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:526` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:526` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachments.ts:688` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachments.ts:688` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/attachments.ts:688` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:730` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:730` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/files.ts:730` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/ocr-utils.ts:101` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | medium | 需人工核对 |  | 浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/ocr-utils.ts:101` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | medium | 需人工核对 |  | f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/ocr-utils.ts:101` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/textbooks.ts:544` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；浮点字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：JSON.stringify 对整数值不写 `.0` |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/textbooks.ts:544` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；f32 字段 .pages[].blocks[].bbox.x, .pages[].blocks[].bbox.y, .pages[].blocks[].bbox.width, .pages[].blocks[].bbox.height：宿主须按 binary32 最短表示写出 |
| DB `files.ocr_pages_json` | `host/plugins/vfs-repos/repository/textbooks.ts:544` | `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3758`<br>`OcrPagesJson` @ `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:523` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:373` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/attachment-upload.ts:446` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/files.ts:315` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/files.ts:395` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/files.ts:713` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/files.ts:722` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `files.preview_json` | `host/plugins/vfs-repos/repository/textbooks.ts:233` | `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2508`<br>`PdfPreviewJson` @ `src-tauri/crates/dstu-vfs/src/vfs/types.rs:2851` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `mindmaps.settings` | `host/plugins/vfs-repos/repository/mindmaps.ts:498` | `src-tauri/crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:725` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（unresolved） |
| DB `questions.images_json` | `host/plugins/vfs-repos/repository/exams.ts:352` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328`<br>`Vec<QuestionImage>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs:257` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `questions.images_json` | `host/plugins/vfs-repos/repository/questions.ts:326` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328`<br>`Vec<QuestionImage>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs:257` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `questions.images_json` | `host/plugins/vfs-repos/repository/questions.ts:473` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328`<br>`Vec<QuestionImage>` @ `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs:257` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `questions.options_json` | `host/plugins/vfs-repos/repository/exams.ts:352` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（optionsJson） |
| DB `questions.options_json` | `host/plugins/vfs-repos/repository/questions.ts:324` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `questions.options_json` | `host/plugins/vfs-repos/repository/questions.ts:470` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1328` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `questions.provenance_json` | `host/plugins/vfs-repos/repository/exams.ts:359` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:444`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `questions.provenance_json` | `host/plugins/vfs-repos/repository/questions.ts:460` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:444`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `questions.provenance_json` | `host/plugins/vfs-repos/repository/questions.ts:474` | `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs:444`<br>`serde_json::Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $：Rust 构造时的浮点值写 `.0` |
| DB `questions.structured_data` | `host/plugins/vfs-repos/repository/exams.ts:359` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1080` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（oldId） |
| DB `questions.structured_data` | `host/plugins/vfs-repos/repository/questions.ts:327` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1080` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `questions.structured_data` | `host/plugins/vfs-repos/repository/questions.ts:472` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1080` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:131` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:131` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:131` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:131` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | u64/i64 字段 .size：超过 2^53 时 number 失精度 |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:441` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | 宿主来源未解析；serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:441` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | low | 需人工核对 |  | 宿主来源未解析；Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:441` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 宿主来源未解析；非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/resources.ts:441` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | 宿主来源未解析；u64/i64 字段 .size：超过 2^53 时 number 失精度 |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/textbooks.ts:470` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | f64 整数 `.0` | low | 需人工核对 |  | serde_json::Value 字段 $, .extra：Rust 构造时的浮点值写 `.0` |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/textbooks.ts:470` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | None（null/省略） | medium | 需人工核对 |  | Rust 省略 None：name, title, mimeType, size |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/textbooks.ts:470` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 键序 | low | 需人工核对 |  | 非字面量构造，键序取决于对象构建顺序 |
| DB `resources.metadata_json` | `host/plugins/vfs-repos/repository/textbooks.ts:470` | `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:824`<br>`Value` | 精度（f32/u64） | low | 需人工核对 |  | u64/i64 字段 .size：超过 2^53 时 number 失精度 |
| DB `todo_items.attachments_json` | `host/plugins/vfs-repos/repository/todo-utils.ts:105` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `todo_items.attachments_json` | `host/plugins/vfs-repos/repository/todos.ts:527` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（completed.attachmentsJson） |
| DB `todo_items.repeat_json` | `host/plugins/vfs-repos/repository/todos.ts:353` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（normalizedRepeatJson） |
| DB `todo_items.repeat_json` | `host/plugins/vfs-repos/repository/todos.ts:461` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（finalRepeatJson） |
| DB `todo_items.repeat_json` | `host/plugins/vfs-repos/repository/todos.ts:527` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（recurrence.repeatJson） |
| DB `todo_items.tags_json` | `host/plugins/vfs-repos/repository/todo-utils.ts:105` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | Rust 写入值类型未静态解析（to_string） |
| DB `todo_items.tags_json` | `host/plugins/vfs-repos/repository/todos.ts:527` | `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1347` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（completed.tagsJson） |
| DB `vfs_index_segments.metadata_json` | `host/plugins/vfs-repos/repository/index-segments.ts:185` | `src-tauri/crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs:223` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（input.metadataJson） |
| DB `vfs_index_segments.metadata_json` | `host/plugins/vfs-repos/repository/index-segments.ts:231` | `src-tauri/crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs:223` | 其他 | low | 需人工核对 |  | 宿主写入值来源未静态解析（input.metadataJson） |

## 附：进入哈希/指纹的 JSON.stringify（G3 不可见）

指纹、幂等键、内容哈希若要与 Rust 一致，哈希输入必须与 Rust `serde_json::to_string/to_vec` 逐字节相同（f64 `.0`、键序、None 省略都会改变哈希；已知例：qbank `batch_import` 幂等键）。全部需人工核对对应 Rust 实现；对齐方式同 DB 写入（`toRustJson(x, Schema)` 后再哈希）。

| 插件 | 宿主 file:line | 函数 | 哈希调用 | 输入 |
|---|---|---|---|---|
| agent-orchestration | `host/plugins/agent-orchestration/src/role-packs.ts:325` | `sha256Hex` | `createHash('sha256').update` | `value` |
| agent-skills | `host/plugins/agent-skills/src/tools/mcp-manage-executor.ts:57` | `mcpEntryRevision` | `hasher.update` | `entry` |
| agent-skills | `host/plugins/agent-skills/src/tools/task-objects.ts:368` | `hashTransformParams` | `createHash('sha256').update` | `params` |
| agent-workspace | `host/plugins/agent-workspace/src/tools/file-manager/files.ts:120` | `sha256Json` | `sha256Hex` | `value` |
| agent-workspace | `host/plugins/agent-workspace/src/tools/file-manager/objects.ts:56` | `hashTransformParams` | `sha256Hex` | `params` |
| agent-workspace | `host/plugins/agent-workspace/src/workspace/agent-profile.ts:432` | `computedHash` | `sha256Hex` | `agentProfileToJson(profile)` |
| chat | `host/plugins/chat/src/attachment-stage.ts:602` | `materializeCorpusManifest` | `sha256Hex` | `manifestJson(manifest)` |
| llm | `host/plugins/llm/src/cache_debug.ts:67` | `cacheDebugHash16` | `createHash('sha256').update` | `value` |
| media | `host/plugins/media/src/office-fidelity.ts:49` | `hashJson` | `sha256Hex` | `value` |
| media | `host/plugins/media/src/task-objects.ts:22` | `hashTransformParams` | `createHash('sha256').update` | `params` |
| qbank | `host/plugins/qbank/repository/authoring.ts:249` | `sourceSlot` | `sha256` | `[sourceIds, question.section_path, question.original_label]` |
| qbank | `host/plugins/qbank/repository/legacy.ts:53` | `hashValue` | `createHash('sha256').update` | `value` |
| qbank | `host/plugins/qbank/src/question-import-service.ts:272` | `authoringConfigFingerprint` | `createHash('sha256').update` | `snapshot` |
| qbank | `host/plugins/qbank/src/tools/qbank-tools-authoring.ts:341` | `batchImport` | `createHash('sha256').update` | `documentValue` |
| vfs-repos | `host/plugins/vfs-repos/repository/questions.ts:91` | `computeQuestionContentHash` | `hasher.update` | `question.options` |
| vfs-repos | `host/plugins/vfs-repos/repository/questions.ts:96` | `computeQuestionContentHash` | `hasher.update` | `question.tags` |
| vfs-repos | `host/plugins/vfs-repos/repository/questions.ts:97` | `computeQuestionContentHash` | `hasher.update` | `question.images` |

## 附：只有 Rust 写入、宿主未定位到写入的 JSON 列

宿主可能尚未实现、用动态 SQL，或经未能静态回溯的封装写入；均需人工核对。

| 表列 | Rust file:line | Rust 类型 | Rust 写入处 | G3 |
|---|---|---|---:|---:|
| `budget_snapshots.limits_json` | `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:645` | `BudgetLimitsSnapshot` | 1 |  |
| `budget_snapshots.usage_json` | `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs:645` | — | 1 |  |
| `chat_messages.metadata` | `src-tauri/crates/dstu-storage/src/database/mod.rs:3598` | — | 4 |  |
| `connector_operations.evidence_json` | `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs:370` | — | 1 |  |
| `exam_sheet_sessions.linked_mistake_ids` | `src-tauri/crates/dstu-storage/src/database/mod.rs:916` | — | 3 |  |
| `exam_sheet_sessions.metadata_json` | `src-tauri/crates/dstu-storage/src/database/mod.rs:916` | — | 3 |  |
| `exam_sheet_sessions.preview_json` | `src-tauri/crates/dstu-storage/src/database/mod.rs:916` | `ExamSheetPreviewResult` | 1 |  |
| `exam_sheet_sessions.status` | `src-tauri/crates/dstu-storage/src/database/mod.rs:1131` | — | 1 |  |
| `exam_sheets.sync_config` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1590` | `SyncConfig` | 1 |  |
| `mistakes.exam_sheet` | `src-tauri/crates/dstu-storage/src/database/mod.rs:1099` | — | 1 |  |
| `question_sync_conflicts.local_snapshot` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1479` | `QuestionVersion` | 1 |  |
| `question_sync_conflicts.remote_snapshot` | `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs:1479` | `QuestionVersion` | 1 |  |
| `research_reports.metadata` | `src-tauri/crates/dstu-storage/src/database/mod.rs:4369` | — | 1 |  |

