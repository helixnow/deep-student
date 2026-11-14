# L16-anki WAVE0 v0 等价场景（WP-076：模板 CRUD + 相邻卡片 CRUD；WP-141：本地文档会话管理；WP-157：AnkiConnect；WP-233：G3 导出/导入/生成/媒体/记忆候选）

本目录只有场景输入，不含期望答案；Rust A 是唯一判定者。**未运行 A/B 回放，未计 C。**

| 文件 | 工作包 | 场景 | 步骤 | 声明命令 |
|---|---|---|---|---|
| `templates-crud.json` | WP-076 | 13 | 122 | 8 |
| `templates-import.json` | WP-076 | 11 | 74 | 7 |
| `cards-crud.json` | WP-076 | 7 | 124 | 13 |
| WP-076 合计 | | 31 | 320（成功意图 240 / 错误意图 80，其中 serde 27、业务 53） | 去重 17 |
| `document-sessions.json` | WP-141 | 8 | 131（成功意图 103 / 错误意图 28，其中 serde 18、业务 10） | 16（目标 10 + 辅助 6） |
| `anki-connect.json` + `anki-connect.peers.json` | WP-157 | 24 | 121（成功意图 61 / 错误意图 60，其中 serde 10、业务 50） | 10（目标 6 + 辅助 4） |
| `exports-imports.json` | WP-233 | 7 | 62（全部成功意图） | 12（目标 5 + 辅助 7） |
| `generation.json` | WP-233 | 2 | 20（全部成功意图） | 9（目标 2 + 辅助 7） |
| `anki-connect-import.json` + `anki-connect-import.peers.json` | WP-233 | 1 | 5（全部成功意图） | 4（目标 2 + 辅助 2） |
| `anki-media.json` | WP-233 | 2 | 13（全部成功意图） | 4（目标 2 + 辅助 2，其中 `notes_save_asset` 属 L10） |
| `memory-candidates.seeded.json` + `l16-pending-memory-w0.sql` | WP-233 | 3 | 12（全部成功意图） | 2（目标 2），seed `l16-pending-memory-w0`（W21 `slot-seeds.ts`） |
| WP-233 合计 | | 15 | 112（目标命令步 57） | 去重 24（目标 11 + 辅助 13） |

格式遵循 `board/WAVE0-EQUIVALENCE.md` §3 v0：`seed:"empty"`、`capture:{events:true,db:["*"]}`、`normalize:[]`。
`expect:"error"` 仅为标注，不是断言。所有命令在合同中均为 `frontend:"app"`（L16 命令在
`contracts/ipc/L16-anki.json`，WP-141 的两条 FSRS 辅助命令在 `contracts/ipc/L15-review-analytics.json`）。

校验（只做静态编写检查，不执行后端）：

```
node host/plugins/anki/equivalence/check.mjs
```

检查项：v0 结构、`domain:"anki"`、命令在合同中且为 `frontend:"app"`、引用整值且只指向更早的非错误步骤、
引用路径存在于结果 schema、非错误步骤的参数通过合同 schema、每个工作包的目标命令数（WP-076 ≤20、WP-141 ≤10，
WP-141 的 10 条目标全部出现；WP-157 ≤6 且 6 条全部出现；WP-233 的 11 条目标全部出现且无 `expect`）、外域辅助命令必须登记所属合同；
`pending-seed/*.json` 也参与检查，其 `seed` 必须等于登记的种子名且同目录有 `<seed>.sql`；
结果 schema 为无类型 `serde_json::Value`（`notes_save_asset`）时字段路径无法由合同确认，改由 README 引用 Rust 源码；
WP-157 另查 `anki-connect.peers.json`、WP-233 另查 `anki-connect-import.peers.json`（只对应 `anki-connect-import.json`）：
场景 id 与语料一一对应、剖面键与故障形状合法、对端模块存在。合同 `$ref` 嵌套在 `items` 里时也按所属合同解析。

## 引用与 runner 要求

- `${n}`：整值引用第 n 步的原始结果。结果必须是 string 或数组：`create_custom_template` 的 id、
  导出命令返回的文件路径（WP-233），以及 `get_document_cards` 返回的卡片数组（WP-233 直接作为 `selectedCards`/`cards` 传入）。
- `${n.a.b}`：整值引用结果字段（如 `${1.0.version}`、`${2.taskId}`、`${1.template_data}`）。
- 引用必须占满整个 JSON 字符串值；runner 不做子串替换。`template_data` 里的嵌套 JSON 字符串是字面量，
  其中没有引用，runner 不应解析或替换。
- 无引用指向 `expect:"error"` 步骤。
- `${n.arr.0}`：数组下标路径（WP-141 用 `${3.enqueuedStateIds.0}` 取 `fsrs_enqueue_cards` 返回的状态 id）。

## WP-141 运行器注意

- `pause/resume/cancel/get_document_processing_state/delete_document_session` 读写 Rust 进程内静态表
  `DOCUMENT_STATES`（`enhanced_anki_service.rs`），不落库。每个场景都必须在**新进程**里跑；否则同一进程中
  前一场景留下的 `paused` 条目会改变后一场景的结果。场景内已尽量用不重复的 `w141-*` id，并在结尾清除
  `''`/`'  '` 这两个条目，但 `empty-reads-and-serde[15]` 与 `control-unknown-empty-and-serde` 都读 `''`，仍要求进程隔离。
- 事件：pause/resume/cancel 发 `anki_generation_event`，载荷为外部标签枚举
  （`{"DocumentProcessingPaused":{"document_id":…}}`、`DocumentProcessingCompleted`、`DocumentProcessingCancelled`；
  有运行中/未完成任务时还有 `TaskStatusUpdate`，本包场景不会触发它，见下文 pending）。事件发往调用窗口，录制器需捕获窗口事件。

## 命令表

步骤记法：`场景短名[步骤下标]`，`!` 为错误意图步骤。场景短名省略 `anki.` 前缀。

### 模板（10）

| 命令 | 前端调用 | Rust | 分支 | 场景/步骤 |
|---|---|---|---|---|
| `get_all_custom_templates` | `src/data/ankiTemplates.ts:53`；`src/features/anki-tasks/components/SessionRow.tsx:77` | `src-tauri/src/commands.rs:4280` → `database/mod.rs:2552` | 成功（空/非空，`ORDER BY created_at DESC, id ASC`）；Err 仅 DB 故障 | 作为跨步读回出现在 17 个场景，共 27 步 |
| `create_custom_template` | `src/data/ankiTemplates.ts:267` | `commands.rs:4304`、校验 `commands.rs:6109`、`mod.rs:2462` | 成功：默认 version `1.0.0`/is_active true/is_built_in false、显式标志、空串 version 原样写、未声明字段引用只 warn、Cloze 成功；Err：名称空、fields 空、正/背面模板空、提示词空、缺规则、多余规则（排序拼接）、Cloze 缺 `{{cloze:`（大小写不敏感匹配 note_type）、`name` UNIQUE → `创建模板失败`；serde：缺 name、fields 非数组、FieldType 枚举错、规则缺 description、缺 request | `template.create-defaults-and-explicit-flags[0,1,2]`；`create-validation-errors[0!..8!]`；`create-warn-unknown-refs-and-cloze-success[0,1]`；`create-duplicate-name-db-error[0,1!,2]`（尾空格同名成功）；`create-serde-errors[0!..4!]`；其余为准备步骤 |
| `update_custom_template` | `src/data/ankiTemplates.ts:299` | `commands.rs:4321`、合并 `commands.rs:~6060-6105`、`mod.rs:2713`（`increment_version` 2697） | 成功：自动 +1 补丁、显式 version 原样、version 等于当前 → 视为未提供后 +1、非三段式 → `1.0.1`、显式 null 视为未提供、改 is_active、改 is_built_in、已内置模板修改后打 `user_modified`；Err：**模板不存在**（含空 id）、**版本缺失**（缺字段 / null）、**版本错误**（旧版本、空串、重放旧版本）、合并后校验失败 ×8、改名 UNIQUE → `更新模板失败`；serde：缺 request | `template.update-version-sequence[2,4,6,8,10]`；`update-missing-template-and-version-guards[1!..7!,9,10!,11!]`；`update-merged-validation-errors[1!..8!,10]`；`update-rename-collision-db-error[2!,4]`；`update-is-active-and-builtin-flag-then-tombstone[1,3,4]`；`builtin-delete-tombstone-not-revived[6]`；`builtin-user-modified-preserved[1!,2]` |
| `delete_custom_template` | `src/data/ankiTemplates.ts:276` | `commands.rs:4403`、`mod.rs:2839`（物理）/`2921`（软删） | 成功：用户模板物理删除 `{deleted:true}`、**被卡片引用的用户模板删除**（referencingCards>0 + warn）、**内置模板墓碑**（`{deleted:false,deactivated:true}`，再次删除仍成功）、被卡片引用的内置模板停用；Err：模板不存在（缺失 id、空 id、删两次）；serde：缺 templateId | `template.update-is-active-and-builtin-flag-then-tombstone[5,6]`；`delete-missing-and-empty-ids[0!,1!,2!,10,11!]`；`builtin-delete-tombstone-not-revived[1,2]`；`cards.save-read-update-delete-with-custom-template[13]`；`cards.builtin-template-referenced-delete-deactivates[3]` |
| `count_custom_template_references` | `src/features/template-management/TemplateManagementApp.tsx:997` | `commands.rs:4466` → `mod.rs:2867` | 成功：0、>0、删卡后减少、模板删除后仍按 template_id 计数、缺失/空 id 返回 0；serde：缺 templateId | `template.delete-missing-and-empty-ids[6,7,8!]`；`cards.save-read-update-delete-with-custom-template[6,11,14]`；`cards.builtin-template-referenced-delete-deactivates[2]` |
| `export_template` | `TemplateManagementApp.tsx:341` | `commands.rs:4477` | 成功：用户/内置/墓碑模板导出；Err：模板不存在（缺失 id、空 id、删除后）；serde：缺 templateId | 读回用，共 17 个场景；错误在 `template.create-list-export-update-delete[10!]`、`delete-missing-and-empty-ids[3!,4!,5!]` |
| `import_custom_templates_bulk` | `TemplateManagementApp.tsx:506` | `commands.rs:4580`（strict 4595–4782，非 strict 4784–4895） | 成功：单对象/数组/空数组、导出→再导入同名冲突跳过、overwrite 原地替换、删除后再导入新建、camelCase 别名、`strict_builtin` 缺省、非 strict 混合（新建/serde 失败/校验失败/同名冲突/同批同名/内置标志/非对象）、覆盖内置 → `user_modified`、strict 按 id 优先其次按名称定位、同批重复 id、缺 fields_json/坏规则 JSON → 校验失败、缺 id → `unknown`、缺 name → `未命名模板`；Err：JSON 解析失败（strict/非 strict）、非对象非数组（字符串/数字/null）；serde：缺 overwrite_existing、缺 template_data、缺 request | `template.bulk-parse-and-shape-errors[0!..4!,5,6,7!,8!,9!,10,11]`；`bulk-export-reimport-conflict-overwrite[2,4,7]`；`bulk-nonstrict-mixed-items[1,3]`；`bulk-nonstrict-overwrite-builtin-marks-user-modified[1]`；`bulk-strict-id-name-targets-and-errors[1,3]`；`builtin-*` 场景中用于构造旧版内置行 |
| `import_builtin_templates` | `src/utils/forceImportTemplates.ts:50` | `commands.rs:4899`（决策 `decide_builtin_import_action` 5249） | 成功：空库全量导入、幂等 Skip、墓碑 PreserveUserState（重新启用后仍保留）、user_modified 保留、旧版本 Update 原地升级（保持 is_active）、ID 被非内置模板占用 → 冲突、名称被占用 → 冲突、升级改名撞名 → 计入失败（命令仍成功）；Err：仅内嵌 JSON 解析失败与 DB 故障 | `template.builtin-import-then-idempotent-skip[1,3]`；`builtin-delete-tombstone-not-revived[0,4,7]`；`builtin-user-modified-preserved[0,3]`；`builtin-outdated-row-updated-in-place[2,4]`；`builtin-name-and-id-conflicts[3]`；`builtin-update-rename-collision-error[2]`；`bulk-nonstrict-overwrite-builtin-marks-user-modified[0,3]`；`bulk-strict-id-name-targets-and-errors[0,5]`；`cards.builtin-template-referenced-delete-deactivates[0]` |
| `set_default_template` | `src/data/ankiTemplates.ts:319` | `commands.rs:6231` → `mod.rs:7225` | 成功：首次写入、同值写入（`ON CONFLICT ... WHERE IS NOT` 不改 updated_at）、不存在的 id、空串；删除默认模板不清理设置；serde：缺 templateId、null | `template.default-template-set-get[2,4,6,8,10,13!,14!]` |
| `get_default_template_id` | `src/data/ankiTemplates.ts:54,308`；`src/components/anki/cardforge/engines/CardAgent.ts:1244` | `commands.rs:6240` → `mod.rs:7242` | 成功：未设置为 null、设置后读回、模板删除后仍返回旧 id | `template.default-template-set-get[0,3,5,7,9,12,15]` |

### 卡片（7）

| 命令 | 前端调用 | Rust | 分支 | 场景/步骤 |
|---|---|---|---|---|
| `save_anki_cards` | `src/services/ankiApiAdapter.ts:127` | `src-tauri/src/cmd/anki_connect.rs:926` → `save_anki_cards_in_database` 692–923、`mod.rs:4598` | 成功：新卡插入、事件 `fsrs://changed {source:"user",action:"cards_persisted",entityIds}`、请求级 template_id 回填、牌组来自 options.deck_name、同文档同 id 重存 → UPDATE（duplicatedIds）、新旧混合、新 id 同内容 → 映射已有卡（skippedIds）、诊断卡同 id 重存被跳过、临时 id（`anki_synthetic_*`/`chat-batch-*`/空/null）换 UUID、document_id 回落 block_id → message_stable_id → 随机 UUID、source_session_id 仅空时写入、front 回落 `Chat card N`、Text 字段回填；Err：`No cards provided for saving`、`duplicate_card_id_in_request`（trim 后重复）、`未能保存任何卡片`（id 属其他文档）；serde：缺 request、缺 cards | `cards.save-validation-and-dedup-branches[0!,1!,2!,3!,4,5,6,7,8!,11,12]`；`save-document-id-fallbacks-and-defaults[0,2,4,6,8]`；其余为准备步骤 |
| `update_anki_card` | `src/utils/chatApi.ts:207,264`；`src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2356`；`src/features/flashcards/store/fsrsReviewStore.ts:1795` | `src-tauri/src/cmd/enhanced_anki.rs:267`（校验 66）→ `mod.rs:5204` | 成功：完整 AnkiCard、改 template_id、客户端伪造 `_content_provenance`、Cloze 文本（`text` / 大小写不敏感的 `Text` 字段 / front 内填空 / 嵌套）、置诊断卡、chatApi 形状（缺 task_id/时间戳，带 `fields`）；Err：正/背面空、`c0`、空填空、未闭合填空、**卡片不存在**（缺失 id、默认随机 id、删除后）；serde：`extra_fields` 值为 null、tags 非数组、缺 card | `cards.update-validation-and-not-found[1!..5!,6,7,8,9,10!..12!,13,15!..17!]`；`save-read-update-delete-with-custom-template[8]`；`save-validation-and-dedup-branches[10]` |
| `delete_anki_card` | `ankiApiAdapter.ts:164`；`chatApi.ts:268`；`src/features/chat/plugins/blocks/pendingCardDeletes.ts:67` | `enhanced_anki.rs:288` → `mod.rs:6053` | 成功：删除存在的卡（物理删除）、空白 id（非空串）、不存在 id、重复删除均返回 true；Err：空串 `卡片ID不能为空`；serde：缺 cardId | `cards.delete-and-content-edge-ids[0!,1,2,3!,10,12]`；`save-read-update-delete-with-custom-template[10]`；`update-validation-and-not-found[14]` |
| `get_document_cards` | `SessionRow.tsx:76`；`src/features/chat/adapters/tauri/ankiRetryReconcile.ts:83` | `enhanced_anki.rs:381` | 成功：有卡、空文档、空串 documentId；serde：缺 documentId、snake_case 键 | 读回用；错误在 `cards.delete-and-content-edge-ids[15!,16!]` |
| `list_anki_library_cards` | `chatApi.ts:156`；`src/features/notes/components/NoteRelationTargetPicker.tsx:33`；`src/features/flashcards/screens/TodayScreen.tsx:221`；`src/features/flashcards/hooks/useReviewActivity.ts:193` | `enhanced_anki.rs:478` → `mod.rs:7753` | 成功：默认分页、page/pageSize 0 与越界钳制、全 null、templateId 过滤（含空白）、search 中 `%`/`_` 转义与 trim、status 各值与未知值、sort 各值与未知值、sortDesc、deck 精确与子牌组前缀（不匹配 `W0x`）、大小写、includeDecks；serde：page 负数、pageSize 超 u32、sortDesc 非布尔、缺 request | `cards.library-list-filters-and-pagination[5..30,31!..34!]` |
| `get_anki_library_card_content` | `src/features/chat/components/input-bar/AnkiCardUpdateDiff.tsx:113` | `enhanced_anki.rs:461` → `mod.rs:5335` | 成功：存在（含首尾空白 id，trim 后命中）、不存在/删除后 → null；Err：空串与空白 → `读取库卡片失败: cardId is required`；serde：缺 cardId | `cards.delete-and-content-edge-ids[4!,5!,6,7!,9,11]`；`save-*` 中的读回 |
| `get_anki_stats` | `src/features/anki-tasks/AnkiTasksApp.tsx:235` | `enhanced_anki.rs:613` → `mod.rs:7478` | 成功：空库、存卡后、删卡/模板后 | `cards.save-read-update-delete-with-custom-template[0,7,16]` 等 6 步 |

### 验收分支对照

| 要求 | 位置 |
|---|---|
| 缺版本 | `template.update-missing-template-and-version-guards[1!,2!,6!]`；`builtin-user-modified-preserved[1!]` |
| 错误版本 | `template.update-missing-template-and-version-guards[3!,4!,10!]` |
| 缺模板 | `update-missing-template-and-version-guards[5!,7!]`；`delete-missing-and-empty-ids[0!,1!,11!]`；export 同场景 `[3!,4!]` |
| 内置墓碑 | `template.builtin-delete-tombstone-not-revived`；`update-is-active-and-builtin-flag-then-tombstone[5,6]` |
| 删除被卡片引用的模板 | 用户模板：`cards.save-read-update-delete-with-custom-template[13]`；内置模板：`cards.builtin-template-referenced-delete-deactivates[3]` |
| 跨步读回 / DB 副作用 | 每个写步骤后跟 list/export/get_document_cards/library content/count/stats 读回；`capture.db:["*"]` 记录全部表 |

## 未覆盖的可达/不可达 Err

以下 Err 只能经 DB/环境故障触发，空种子 + 真实外层命令无法稳定构造，本包不覆盖：

- 所有 `AppError::database(...)` 的连接/查询失败分支（`获取模板列表失败`、`查询模板失败`、`统计模板引用卡片失败`、`停用内置模板失败`、`删除模板失败`、`查询现有模板失败`、`读取模板用户态标记失败`、默认模板读写失败、卡片库查询失败等）。
- `update_custom_template` 的 `optimistic_lock_failed`：需在命令内“读版本”与“UPDATE”之间并发写，单线程场景不可达；版本错误改由前置检查分支覆盖。
- `soft_delete_builtin_template` 的 `builtin_template_not_found`：命令先确认 `is_built_in`，正常路径不可达。
- strict 批量导入 `create_custom_template_with_id` 的 UNIQUE 冲突：目标先按 id 再按名称定位，同名必然走替换路径，不可达。
- `import_builtin_templates` 内嵌 JSON 解析失败：编译期常量，不可达。
- `serde_json::to_string` 序列化失败、`get_anki_stats` 表缺失降级、`count_anki_cards_referencing_template` 缺 `deleted_at` 列回退：需旧库或故障。
- 卡片软删除对 count 的排除：前端命令里只有物理删除（`delete_anki_card`），本包无法构造 `deleted_at` 非空的卡。

## normalize 候选（仅候选，未写入场景）

模板 UUID（`create_custom_template` 返回值与非 strict 批量新建 id）、`created_at`/`updated_at`、`settings.updated_at`、
`save_anki_cards` 的 `taskId` 与生成的 task 行、随机 document id（仅会话场景）、临时 id 换出的卡片 UUID、
默认 `created_at`/`updated_at`、`extra_fields._content_provenance`（若服务端覆盖写入）、批量导入结果字符串中的 serde 错误位置文本。

## WP-141：本地文档会话管理（10 条目标命令）

文件 `document-sessions.json`，场景短名省略 `anki.sessions.` 前缀，`!` 为错误意图步骤。
Rust 服务层 `S` = `src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs`，库层 `M` = `src-tauri/crates/dstu-storage/src/database/mod.rs`。

| 命令 | 前端调用 | Rust | 本包覆盖的分支 | 场景/步骤 |
|---|---|---|---|---|
| `list_document_sessions` | `src/features/anki-tasks/AnkiTasksApp.tsx:234`（limit 500）；`src/features/anki/ankiCompletionNotifier.ts:55`（50）；`src/features/workbench/apps/system/ankiTaskSource.ts:83`（500）；`src/components/dashboard/TodayCommandCenter.tsx:44`（100） | `src-tauri/src/cmd/enhanced_anki.rs:560` → `M:7430` | 成功：缺省/null → 50、`0`、`u32::MAX`、`1` 截断、按 `MAX(updated_at) DESC` 排序、同文档多任务聚合（totalTasks/completedTasks/totalCards）、物理删卡后 totalCards 减少、`sourceSessionId` null/有值；`limit:0` 且有行时走 “BUG … returned 0 sessions” warn 分支（日志，不在差分面）；serde：负数、超 u32、字符串、小数 | `empty-reads-and-serde[0,1,2,3,4!..7!]`；`list-aggregates-limit-order[3,4,5,10]`；其余场景作读回共 13 步 |
| `get_document_processing_state` | `src/components/anki/cardforge/engines/TaskController.ts:452` | `enhanced_anki.rs:183` → `S:1046` | 成功：无条目默认 `{paused:false,current_task_id:null}`、pause 后 `paused:true`、resume 无剩余任务后条目移除、cancel 后移除、delete_document_session 后移除、空串 id；serde：缺 documentId、非字符串 | `empty-reads-and-serde[14,15,16!,17!]`；`pause-resume-cancel-on-completed-doc[1,3,6,8,12,17]`；`control-unknown-empty-and-serde[1,3,5,7,9,12]`；`delete-session-cascade-with-fsrs[9,11]`；`delete-session-validation-and-serde[10,12]` |
| `get_document_tasks` | `src/features/anki/taskControl.ts:63`；`TaskController.ts:368`；`src/components/anki/cardforge/engines/CardAgent.ts:1358,1542,1554`；`src/features/chat/plugins/blocks/ankiCardsBlock.tsx:1855,2190`；`src/features/chat/adapters/tauri/ankiRetryReconcile.ts:60` | `enhanced_anki.rs:231` → `S:774` → `document_processing_service.rs:136` → `M:4754` | 成功：多任务（均 `segment_index 0`，按 ORDER BY segment_index 的库内顺序）、未知/空串 id → `[]`、首尾空格 id 不 trim → `[]`、cancel 后 Completed 任务不变、会话删除后 `[]`；serde：缺 documentId、null、snake_case 键 | `empty-reads-and-serde[9..13]`；`list-aggregates-limit-order[6,7,8]`；`pause-resume-cancel-on-completed-doc[4,13]`；`delete-session-cascade-with-fsrs[12,14]`；`delete-session-validation-and-serde[7]` |
| `delete_document_session` | `src/features/anki-tasks/components/SessionRow.tsx:143` | `enhanced_anki.rs:327` → `S:901` → `M:6095` | 成功：同文档两任务三卡全删、同事务删除 `fsrs_review_logs` / `fsrs_card_states`（由 L15 命令种出），另一文档及其 FSRS 行保留、有 `DOCUMENT_STATES` 条目（pause 后）时清除、重复删除/不存在 id/空白 id 仍 `true`、首尾空格 id 不 trim（不删）、删除后同 id 卡片重新保存成功；Err：空串 `文档ID不能为空`；serde：缺键、null、数字 | `delete-session-cascade-with-fsrs[10,18,19]`；`delete-session-validation-and-serde[0!,1,2!,3!,4!,6,11]` |
| `set_document_session_source` | `src/features/chat/services/selectionCardGeneration.ts:94` | `enhanced_anki.rs:625` → `M:4547` | 成功：两侧 trim 后写入、只写 `source_session_id IS NULL` 的行（已有不覆盖）、不存在文档为 no-op、同文档新增 null 来源任务后再次写入只填新行、`save_anki_cards` 带 business_session_id 后不被覆盖；Err：`documentId 不能为空`（空串、空白，双空时先报 documentId）、`sessionId 不能为空`（空串、空白 `\t`）；serde：缺 sessionId、缺 documentId、sessionId null | `set-source-validation-and-no-overwrite[2!..9!,11,13,15,18,21]`，读回 `[1,10,12,14,16,19,22]` |
| `pause_document_processing` | `src/features/anki/taskControl.ts:13,38`；`TaskController.ts:134`；`CardAgent.ts:594` | `enhanced_anki.rs:123` → `S:532` | 成功：Completed 文档（无运行中任务，只发 `DocumentProcessingPaused`）、重复暂停、未知 id、空串（命令无空校验）、空白；serde：缺键、null | `pause-resume-cancel-on-completed-doc[2,5,10]`；`control-unknown-empty-and-serde[0,4,10,14!,17!]`；`delete-session-cascade-with-fsrs[8]`；`delete-session-validation-and-serde[9]` |
| `resume_document_processing` | `taskControl.ts:14,38`；`TaskController.ts:192`；`CardAgent.ts:601` | `enhanced_anki.rs:164` → `S:617` | 成功：无 Paused/Pending 任务 → 移除条目并发 `DocumentProcessingCompleted`、无条目时再次 resume、未知 id、空串；serde：缺键、数组 | `pause-resume-cancel-on-completed-doc[7,9]`；`control-unknown-empty-and-serde[2,8,15!,19!]` |
| `cancel_document_processing` | `taskControl.ts:15,38`；`TaskController.ts:318`；`CardAgent.ts:628` | `enhanced_anki.rs:142` → `S:826` | 成功：pause 后取消（Completed 任务与卡片保留，条目移除，发 `DocumentProcessingCancelled`）、无条目再次取消、空白 id；Err：空串 `文档ID不能为空`（不改 `''` 的暂停态，后续 state 读回）；serde：缺键、数字 | `pause-resume-cancel-on-completed-doc[11,16]`；`control-unknown-empty-and-serde[6!,11,16!,18!]` |
| `recover_stuck_document_tasks` | `AnkiTasksApp.tsx:318` | `enhanced_anki.rs:548` → `M:7389`（阈值 10 分钟，`M:7402`） | 成功：空库 `0`、只有 Completed 任务 `0`、pause/cancel 后仍 `0` | `empty-reads-and-serde[8]`；`list-aggregates-limit-order[12]`；`pause-resume-cancel-on-completed-doc[18]` |
| `get_model_adapter_options` | `src/features/settings/components/ShadApiEditModal.tsx:634` | `src-tauri/src/cmd/anki_cards.rs:20` → `commands.rs:3894` → `dstu-llm/src/llm_manager/adapters/mod.rs:396` | 成功：注册表列表（`value/label/description/is_default:true`），连续两次；无 Err 分支 | `model-adapter-options[0,1]` |

辅助命令（不计入本包目标，只作种子/读回）：

| 命令 | owner | 用途 |
|---|---|---|
| `save_anki_cards`、`get_document_cards`、`get_anki_stats`、`delete_anki_card` | L16，WP-076 已作目标覆盖 | 建会话（task 行恒为 `Completed`、`segment_index 0`）、读卡、统计、物理删卡 |
| `fsrs_enqueue_cards`、`fsrs_rate` | **L15-review-analytics**（`src-tauri/src/cmd/fsrs_review.rs:107,250`） | 为 `delete_document_session` 种 `fsrs_card_states` 与 `fsrs_review_logs`，验证级联删除 |

### WP-141 未覆盖分支（pending，需运行中任务或历史种子）

真实前端命令在空种子上只能产生 `Completed` 任务：`save_anki_cards` 把 task 写成 Completed（`anki_connect.rs:822`），
其全部卡被 IGNORE 时整事务回滚（`M:4689`）。唯一能产生 Pending/Processing/Streaming 的入口
`start_enhanced_document_processing` 依赖 LLM 并立即 spawn 后台调度，结果取决于时序，不能作确定场景。
因此以下分支没有用 not-found 或空结果冒充，保持 pending：

- `pause`：Processing/Streaming 任务断流 → 标 `Paused` → 逐任务 `TaskStatusUpdate` 事件；`current_task_id` 指向的在途任务补入；
  `cancel_streaming` 失败后 abort 兜底；`update_task_status` 失败的 `更新任务状态失败` Err；`get_document_tasks` 失败只 warn。需要**运行中任务**。
- `resume`：有 Paused/Pending 任务时按 segment_index 排序后 spawn `process_all_tasks_async`；`entry.running` 已为 true 的防重入早退；
  `get_document_tasks` 失败的 Err 与条目清理。需要**历史 Paused/Pending 种子**（以及 LLM 模拟服务才能确定后续事件）。
- `cancel`：Pending/Processing/Streaming/Paused 任务改 `Cancelled` 并发 `TaskStatusUpdate`；运行中任务断流；`update_task_status` 失败 Err。需要**未完成任务种子**。
- `delete_document_session`：Processing/Streaming 任务断流分支；`删除文档会话失败` DB Err。
- `get_document_processing_state`：`current_task_id` 非 null 只在调度协程运行中出现。
- `recover_stuck_document_tasks`：返回值 >0 需要 `updated_at` 早于 10 分钟（或无法解析）的 Processing/Streaming/Pending 任务，
  以及“同文档仍有活跃分段时 Pending 不回收”的反向分支；`恢复卡住任务失败` DB Err。需要 **X3 历史种子**。
- `list_document_sessions`：`deleted_at` 非空的任务/卡片排除、failed/active/paused 计数非零、`获取任务列表失败` DB Err；
  前端无软删入口，状态计数同上需种子。
- `get_document_tasks` / `set_document_session_source`：DB 故障 Err（`获取文档任务失败`、`设置文档来源会话失败`）；软删任务排除。
- `get_model_adapter_options`：无 Err。

上述种子的 owner：X3（历史数据目录种子，含非终态与超时 `updated_at` 的 `document_tasks`），或 X5 的 LLM 模拟服务
配合 `start_enhanced_document_processing`。不直接写 SQL 造生产入口。

### WP-141 normalize 候选（仅候选，未写入）

`save_anki_cards` 的 `taskId` 与 task 行 id、`created_at`/`updated_at`/`lastUpdated`/`createdAt`；`fsrs_enqueue_cards` 的状态 id 与时间、
`fsrs_rate` 的 log id / due / 时间戳；`get_model_adapter_options` 与适配器注册表顺序一致，不规范化。
`list_document_sessions` 的 `ORDER BY MAX(updated_at)` 在同毫秒内可能平局（Rust 写纳秒 rfc3339），
`sourceSessionId` 是 GROUP BY 的裸列：`set-source-validation-and-no-overwrite` 中 `w141-src-a` 的两任务来源分别为
`w141-chat-1`（步骤 11 写入）与 `w141-chat-4`（步骤 18 只填新任务），步骤 19、22 的读回取哪一行由 SQLite 决定（文档未定义，
同一查询计划下实际稳定）。保留这两步作为语义歧义观测点，A/B 不一致时按 SQLite 版本/查询计划归因，不先规范化。

## WP-157：AnkiConnect（6 条目标命令）

文件 `anki-connect.json`（场景）与 `anki-connect.peers.json`（每个场景的对端剖面，`null` 表示 8765 上不能有监听）。
场景短名省略 `anki.connect.` 前缀，`!` 为错误意图步骤。Rust 服务层 `S` = `src-tauri/crates/dstu-anki/src/anki_connect_service.rs`，
命令层 `C` = `src-tauri/src/cmd/anki_connect.rs`。所有命令错误都是 `AppError::validation(原文)`。

### 确定性 AnkiConnect 对端

`host/plugins/anki/tests/anki-connect-peer.ts#startAnkiConnectPeer`（只用 `node:http`，可擦除 TS，`node --experimental-strip-types` 可直接导入）。
它替代的是 Anki 桌面 + AnkiConnect 插件，**不替代**生产客户端或 handler：两端都用自己写死的 `http://127.0.0.1:8765`
（`S:10`；TS `src/anki-connect.ts:18`）去连。对端只按 AnkiConnect v6 回答 action，不算任何 DeepStudent 结果。

- `start({host,port,profile})`：默认 127.0.0.1:8765；端口被占用时以 `EADDRINUSE` 拒绝，绝不停止/替换已有进程。
- `reset(profile)`：替换状态与故障脚本，清空请求记录与连接数。`stop()`：销毁所有 socket 并释放端口。
- `requests`：原始请求（method、path、headers、body 原文、`action`；无 body 的 GET 记为 `'GET'`）。`connections`：含裸 TCP 端口探测。
- 剖面：`version`（默认 6）、`decks`（默认 `["Default"]`）、`models`（默认 Anki 自带 Basic/Cloze）、`existingNotes`
  （`"<模型>\u0000<首字段>"` 视为已存在）、`firstNoteId`（默认 1700000000001，递增）、`faults`（按 action：单个对象常驻，
  数组按序消费后恢复正常；`reply{status,body}` 原样回字节，`disconnect{at:"before-headers"|"mid-body"}` 断连）。
- 状态行为：`createDeck` 幂等返回 id；`canAddNotes`/`addNotes`/`addNote` 以“牌组存在 + 模型存在 + 首字段非空 + 未重复”判定；
  `addNote` 重复报 `cannot create note because it is a duplicate`；未知 action 报 `unsupported action`。

### 运行器需求（pending sidecar）

- 现有 `scripts/electron-migration/record/provider.mjs` 绑定临时端口并把 URL 交给后端；AnkiConnect 两端都写死 8765，无法注入 URL。
  运行器需要：每个场景**先** `start({profile: peers[id]})`（`null` 剖面则确认 8765 空闲），A、B 各用一份新的对端，跑完 `stop()`；
  把 `requests` 作为“外部请求”一并录制。**这是 pending sidecar，本包未改共享 runner。**
- 端口独占：8765 全机只有一个。所有 `anki.connect.*` 场景必须串行（A 与 B 也不能同时跑），不能进 8 组实例池；
  若要并行，只能每个实例一个独立网络命名空间（需要 root，本包未做）。机器上运行着真实 Anki/AnkiConnect 时这些场景不能跑，
  运行器应报“端口占用”而不是停止对方。
- 请求比较：Rust `Note.fields` 是 `HashMap`，`canAddNotes`/`addNotes`/`addNote` 的 body 键序每次可能不同；应按 JSON 值比较 body，
  不按字节。请求头不进差分面：Rust 只在 `version` POST 上设 `Accept`/`User-Agent: DeepStudent/1.0`，TS 在所有经
  `postAnkiWithStatus` 的 action 上都设（见 D5）。
- 连接复用：TS 用全局 `fetch`（undici 连接池），Rust 每次调用新建 `reqwest::Client`。B 端在同一进程里 `stop()` 后立即
  `start()` 下一个对端时，首个请求可能复用旧 keep-alive socket 而得到 `fetch failed`（本包试跑实测：不等待时 7 步错位，
  `stop()` 后让出 50 ms I/O 即消失）。运行器每场景新进程即可；同进程连跑必须在 `stop()` 后等 socket 关闭。
- 本包 B 端试跑（非 C，仅校对 `expect` 标注）：`/tmp/opencode/wp157-replay-probe-final.log`，116/121 步标注与 TS 结果一致；
  不一致的是 D7（1 步）和 `xseed-settings-batch-retry` 的 4 步 `save_setting`（L16 测试宿主未装 L19，完整应用中有）。
- 重试：`addNotes`/`addNote`/`canAddNotes` 网络类失败按 `retry_times`（默认 1）重试，退避 500ms/1000ms/2000ms；
  `add-cards-push-failures` 单场景约 2 s。

### 命令表

| 命令 | 前端调用 | Rust | 本包覆盖的分支 | 场景/步骤 |
|---|---|---|---|---|
| `check_anki_connect_status` | `src/services/ankiConnectClient.ts:51`；`src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2150` | `C:180` → `S:308-437` | 成功（端口探测 → GET → POST `{"action":"version","version":6}`）、多余参数被忽略；版本 `<6` 拒绝；`"six"`/`5.0`/`null` 非 u64 放行并 warn；u64::MAX 成功；`-1` 非 u64 放行；`error` 非空；非 JSON；HTTP 500 带正文；`[]`；缺 `error` 字段（Option 缺省）成功；重复 `error` 字段；响应头前断连；响应体中途断连；对端未监听（端口探测失败） | `status-success[0,1]`；`status-version-too-old[0!]`；`status-version-boundaries[0..5]`；`status-remote-and-bad-response[0!..3!,4,5!]`；`status-disconnect[0!,1!,2]`；`offline-all-commands[0!]` |
| `get_anki_deck_names` | `ankiConnectClient.ts:55` | `C:189` → `S:439-479`（5 s 超时） | 成功（含 `::` 子牌组、中文）、空列表；`error` 非空、`result:null` → `AnkiConnect返回空结果`、元素非字符串、坏 JSON、HTTP 503（不读正文）、响应头前断连、中途断连；未监听 | `lists-success[0]`；`lists-empty[0]`；`deck-names-errors[0!..6!,7]`；`offline-all-commands[1!]`；`create-deck-*`、`add-cards-basic-then-duplicates[1]` 读回 |
| `anki_get_deck_names` | `src/features/settings/components/AnkiConnectSettingsSection.tsx:53` | `C:198`（直接调 `get_anki_deck_names`） | 成功、多余参数、空列表；`error` 非空、result 为对象；未监听 | `lists-success[1,3]`；`lists-empty[1]`；`deck-names-alias-errors[0!,1!,2]`；`offline-all-commands[2!]` |
| `get_anki_model_names` | `ankiConnectClient.ts:59`；`AnkiConnectSettingsSection.tsx:54` | `C:204` → `S:481-521` | 成功、空列表；`error` 非空、result 为对象、HTTP 404、`result:null`、两种断连；未监听；`createModel` 后读回 | `lists-success[2]`；`lists-empty[2]`；`model-names-errors[0!..5!,6]`；`offline-all-commands[3!]`；`xseed-custom-template-create-model[2]` |
| `create_anki_deck` | `ankiConnectClient.ts:63` | `C:213` → `S:1590-1634`（10 s） | 成功并读回、重复创建、`Default`、空串与空白（命令层无校验，原样发出）；`error` 含 `already exists` → Ok；其他 `error` → `创建牌组时出错: …`；HTTP 500；非 JSON；`[]`；两种断连；未监听；serde：缺键、null、数字、snake_case 键 | `create-deck-success-and-boundaries[0..6,7!..10!]`；`create-deck-errors[0,1!..6!,7]`；`offline-all-commands[4!]` |
| `add_cards_to_anki_connect` | `ankiConnectClient.ts:85`；`src/features/chat/anki/index.tsx:460`；`src/components/anki/cardforge/engines/CardAgent.ts:742` | `C:226-410` → `S:add_notes_to_anki_detailed` | 见下表 | `add-cards-*`、`offline-all-commands[5!,6!]`、`xseed-*` |

`add_cards_to_anki_connect` 分支：

| 分支（Rust 位置） | 场景/步骤 |
|---|---|
| `没有选择任何卡片` / `牌组名称不能为空`（空白、`\t`）/ `笔记类型不能为空`（两者都空先报牌组）`C:233-243`，均在任何连接前 | `add-cards-validation-and-serde[0!..4!]`；`offline-all-commands[6!]` |
| serde：缺 selectedCards、selectedCards 非数组、缺 deckName、noteType null、卡片 tags 非数组、全 snake_case 键 | `add-cards-validation-and-serde[5!..10!]` |
| 成功：`createDeck` → 可用性检查 → `modelFieldNames` → `canAddNotes` → `addNotes`；tags 发出；新牌组被创建 | `add-cards-basic-then-duplicates[0,1]` |
| 全部重复 → Ok（`added 0 / duplicates n / failed 0`）；新旧混合部分成功；卡片只给 `front/back`（其余字段 serde 默认，id 为随机 UUID） | `add-cards-basic-then-duplicates[2,3,4]` |
| `canAddNotes` false 且首字段空白 → 记失败 → `所有卡片同步失败。…` | `add-cards-basic-then-duplicates[5!]` |
| 全部 cloze → note type 改 `Cloze`（`C:246-253`）；`text` 含 cloze；cloze 与普通混合（按卡选模型）；`_occlusion` 等内部字段不发出 | `add-cards-cloze-and-models[0..3]` |
| 模型在 Anki 中不存在：`modelFieldNames` 报错 → warn 后回落基本字段 → `canAddNotes` false → 失败 Err | `add-cards-cloze-and-models[4!]` |
| 可用性失败（版本过旧）在 `createDeck` 之后中止 | `add-cards-availability-failures[0!]` |
| `createDeck` 失败只打印，同步继续（`C:262-264`） | `add-cards-create-deck-failure-logged[0]` |
| `canAddNotes` 业务错误 [0] / 返回数量不符 [1] → 降级逐条 `addNote` + warning，逐条时重复以 `duplicate` 错误计；响应头前断连一次后重试成功，不降级 [2] | `add-cards-precheck-fallback[0,1,2]` |
| `addNotes` 业务错误不重试 [0!]；HTTP 500 两次（重试后仍失败）[1!]；坏结果 `"x"`（解析失败 warning）[2!]；响应头前断连两次 [3!]，均为全失败 Err；故障耗尽后恢复正常 [4] | `add-cards-push-failures[0!..3!,4]` |
| `template_id` 指向不存在的模板 → `模板 … 不存在，请先选择可用模板`；空 id 卡跳过模板解析；空白 template_id 视为无 | `add-cards-template-missing[0!,1,2]` |
| 对端未监听：端口探测失败（在 `createDeck` 失败日志之后） | `offline-all-commands[5!]` |

### 跨域 / 跨步 seed（分列，不计入目标命令）

| 场景 | 辅助命令（owner） | 观察点 |
|---|---|---|
| `xseed-receipt-writeback` | `save_anki_cards`、`get_document_cards`（L16，WP-076 目标） | `add` 成功后 `anki_cards` 回写 note id / `export_status='synced'` / content_hash（`C:369-404`）；不存在的卡 id 不回写；重复推送时 `added 0` 不回写 |
| `xseed-custom-template-create-model` | `create_custom_template`（L16，WP-076 目标） | 模板卡 → `modelNames` 预检 → `createModel`（名 `Deep Student / <id> / v1.0.0`）→ `createdModels`；第二次走 `verify_existing_template_model`（`modelTemplates`/`modelStyling` 比对）。对端 `createModel` 只存 fields/css，`modelTemplates` 回 `{}`，因此第二次按 Rust 走“与本地模板不同”的 Err 分支（`[3!]`，`?` 直接向上传播） |
| `xseed-settings-batch-retry` | `save_setting`（**L19-mcp-browser** 合同） | `anki_connect_batch_size=1`、`retry_times=0` 时分批推送，首批 HTTP 500 不重试，其余批成功（部分成功 Ok + warning）；`0`/`x` 回落默认 50/1 |

### WP-157 正式失败（TS 实测原文 ≠ Rust Display，按 Rust 源码推导，未经 A 录制）

TS 原文来自 `job 20261105185034-764983`（真实 8765 对端，生产入口 `env.host.invoke`）。Rust 原文按 reqwest 0.11.27 / hyper 0.14.32 /
serde_json 1.0.149 / serde_derive 1.0.228 源码推导（`reqwest::Error` Display = `<kind>[ for url (<url>)][: <source>]`）。
这些只在 TS 生产代码 `src/anki-connect.ts`、`src/serde-json.ts` 中能修，不在本包范围（brief：只做 equivalence 与测试夹具）；
场景保留、未规范化，提交的测试只断言两端一致的部分（错误类型 + Rust 前缀）。

| # | 分支 | Rust（推导） | TS（实测） | 场景 |
|---|---|---|---|---|
| D1 | `deckNames`/`modelNames`/`createDeck` 响应头前断连 | `请求牌组列表失败: error sending request for url (http://127.0.0.1:8765/): connection closed before message completed`（`创建牌组失败: …` 同构） | `请求牌组列表失败: fetch failed`；`创建牌组失败: fetch failed` | `deck-names-errors[5!]`、`model-names-errors[4!]`、`create-deck-errors[5!]` |
| D2 | `version` 响应头前断连 | `连接被AnkiConnect服务器关闭，可能原因：1)AnkiConnect版本过旧 2)请求格式不兼容 3)需要重启Anki`（`S:428`，`e.to_string()` 含 `connection closed`） | `AnkiConnect连接失败: fetch failed` | `status-disconnect[0!]` |
| D3 | 响应体中途断连（`json()`/`text()` 读体） | `解析AnkiConnect响应失败: request or response body error: error reading a body from connection: end of file before message length reached`；version 路径为 `读取响应内容失败: request or response body error: error reading a body from connection: end of file before message length reached` | `解析AnkiConnect响应失败: request or response body error: other side closed`；`读取响应内容失败: request or response body error: other side closed` | `deck-names-errors[6!]`、`model-names-errors[5!]`、`create-deck-errors[6!]`、`status-disconnect[1!]` |
| D4 | 响应体是 `[]` | derive 的 `visit_seq` 首元素缺失：`invalid length 0, expected struct AnkiConnectResponse with 2 elements at line 1 column 1` | `invalid type: sequence, expected struct AnkiConnectResponse at line 1 column 1`（`serde-json.ts:157-164` 按 peek_invalid_type 处理，与 serde_json `deserialize_struct` 的 `[` 分支不符） | `status-remote-and-bad-response[3!]`、`create-deck-errors[4!]` |
| D5 | 对端未监听时 `get_anki_deck_names`/`create_anki_deck` | `请求牌组列表失败: error sending request for url (http://127.0.0.1:8765/): error trying to connect: tcp connect error: Connection refused (os error 111)` | `请求牌组列表失败: fetch failed`；`创建牌组失败: fetch failed` | `offline-all-commands[1!..4!]` |
| D6 | 请求头（不在返回值差分面） | 只有 `version` POST 带 `Accept: application/json`、`User-Agent: DeepStudent/1.0`；其他 action 只有 reqwest 默认头 | 经 `postAnkiWithStatus` 的 action（deckNames/modelNames/createDeck/modelFieldNames）都带这两个头 | 全部；对端 `requests[].headers` 可见 |

| D7 | `add_cards_to_anki_connect` 的卡片只有 `front/back`（前端 `fields` 回落形状可产生） | `AnkiCard` 各字段 `#[serde(default)]`，`id` 取随机 UUID → 正常同步（成功意图） | `{"name":"HandlerPanic"}`：handler 直接读 `card.id.trim()`，Host 未按合同补 serde 缺省 | `add-cards-basic-then-duplicates[4]` |

`add_cards_to_anki_connect` 中 D1/D3 只出现在 report 的 `warnings` 原文里（例如 `addNotes 批次推送失败…: AnkiConnect 请求失败(addNotes): …`），
重试分类两端一致（实测 2 次 `addNotes`）。

### WP-157 未覆盖分支（pending）

- 超时分支（`AnkiConnect连接超时…`、`AnkiConnect 请求超时(…)`）：Rust 超时 5–60 s，确定性对端可以挂起不答，但单场景要等满超时；
  本包不放慢语料。需要运行器支持“挂起型故障 + 场景超时预算”后再加。
- 端口探测 `connect_timeout` 5 s 超时（非拒绝）：需要黑洞地址，8765 写死在回环上不可达。
- 媒体分支（`storeMediaFile`、picture/audio 附件、inline_base64、skip）：需要真实本地媒体文件路径作为卡片 `images`，空种子无文件；
  需要 X3 带媒体文件的数据目录种子。
- `verify_existing_template_model` 一致成功路径：需要对端按 `createModel` 参数回 `modelTemplates`/`modelStyling`，本对端只存字段与 css。
- receipt / content_hash 回写失败（`log::warn` 继续）：需 DB 故障。
- `读取模板失败` DB Err。

### WP-157 normalize 候选（仅候选，未写入）

`save_anki_cards` 的 `taskId`/时间戳；`create_custom_template` 的 UUID（进入 `createModel` 名与 `createdModels`）；
只给 `front/back` 的卡片随机 id；`anki_cards.exported_at`。对端 note id 是确定的，不规范化。网络错误原文**不**规范化（见 D1–D5）。

## WP-233：G3 导出 / 导入 / 生成 / 媒体 / 记忆候选（11 条目标命令，只写成功场景）

按 D-158，L16 只写成功场景；错误分支由 W-L16（`g3w-*.json`，id 前缀 `g3w.`）写，本包没有 `expect:"error"` 步骤（check 强制）。
下表“错误分支”列只列出 Rust 可达分支，供 W-L16 对照，本包不覆盖。

brief 末尾的 6 条已有成功场景的命令，按 D-158 错误场景归 W-L16。逐条 Rust 判断如下（供 W-L16 取舍，本包不写）：

| 命令 | Rust | 命令内的 Err / 提前返回 | 空种子 + 前端命令能否稳定触发 |
|---|---|---|---|
| `get_all_custom_templates` | `commands.rs:4280` → `mod.rs:2552` | 只有 `获取模板列表失败`（DB） | 否：只有连接/查询故障或维护屏障（`mod.rs:729`，备份/恢复期间 `get_conn_safe` 拒绝，时序窗口）才触发 |
| `get_anki_stats` | `enhanced_anki.rs:613` → `mod.rs:7478` | 只有 `获取统计失败`（DB）；表缺失在库层降级为 0，不报错 | 否：同上 |
| `get_default_template_id` | `commands.rs:6240` → `mod.rs:7242` | `get_conn_safe` 失败与非 `QueryReturnedNoRows` 的查询错误；无行时 `Ok(None)` | 否：同上 |
| `get_model_adapter_options` | `anki_cards.rs:20` → `commands.rs:3894` | 无（直接 `Ok(注册表列表)`） | 无分支 |
| `import_builtin_templates` | `commands.rs:4899` | `解析内置模板 JSON 失败`（`include_str!` 编译期常量）、`查询现有模板失败`、`读取模板用户态标记失败`（DB）；单个模板的校验/写入失败计入结果字符串，命令仍 Ok（已在 WP-076 成功场景覆盖） | 否：JSON 不可达，其余同上 |
| `recover_stuck_document_tasks` | `enhanced_anki.rs:548` → `mod.rs:7389` | 只有 `恢复卡住任务失败`（DB） | 否：同上 |

按 WAVE0 §3，“可达”指场景能稳定构造；这 6 条命令内都没有输入可控的 Err，W-L16 若要覆盖只能借维护屏障的时序窗口，不建议计入。
场景短名省略 `anki.` 前缀。`C` = `src-tauri/src/cmd/anki_connect.rs`，`E` = `src-tauri/src/cmd/enhanced_anki.rs`，
`I` = `src-tauri/src/cmd/apkg_import.rs`，`S` = `src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs`。

| 命令 | 在768 | 前端调用 | Rust | 本包成功分支 | 场景/步骤 | 错误分支（W-L16） |
|---|---|---|---|---|---|---|
| `export_anki_cards` | 是 | `src/utils/chatApi.ts:285` | `E:646` | json（临时目录，`format` 先 trim 再转小写）；apkg（非 json 一律走 apkg）；默认牌组 `ChatAnki`、默认笔记类型 `Basic`、空白值回落；显式 templateId；未给 templateId 时取首卡 template_id；全部填空卡强制 Cloze；部分 id 不存在时静默丢弃 | `export.library-json-and-apkg-defaults[2..7]`；`export.library-template-and-cloze[4,5,6]` | ids 为空、全部未找到（NotFound）、写 JSON 失败 |
| `export_cards_as_apkg_with_template` | 是 | `src/services/ankiApiAdapter.ts:92`（batch 失败后的降级调用，snake_case 与 camelCase 键同时发送） | `C:977` | 已存卡片（来自 `get_document_cards`）+ 显式模板；全填空卡改 Cloze；templateId null 时取卡片 template_id；模板不存在时 warn 后回退 Basic；牌组名含非法字符时清理文件名；无任何模板 | `export.with-template-variants[6..10]`；`import.apkg-library-roundtrip[3]`；`export.multi-template-output-paths[2]`；`connect.import-package[2]` | 卡片为空、牌组空白、笔记类型空白、导出器失败 |
| `export_multi_template_apkg` | 是 | `src/features/chat/anki/index.tsx:375` | `C:1123` | 按 template_id 分组（Basic + Cloze + 无模板）；`outputPath` 为保存对话框的绝对路径（取上一步导出路径，覆盖写）；缺失图片进 `report.missingMedia`；不给 outputPath 时落 `$HOME/Downloads` | `export.multi-template-output-paths[3,4,5]`；`import.apkg-cloze-template-roundtrip[3]` | 卡片为空、导出器失败、虚拟 URI 写回失败（仅移动端） |
| `batch_export_cards` | 是 | `src/services/ankiApiAdapter.ts:88`（`BatchOperationToolbar` 与 `CardAgent.exportCards`） | `C:1323` | apkg（工具栏形状：`{Front,Back}` + 额外选项键 `includeTags/includeMedia`）；apkg（CardAgent 形状：模板字段原样，`noteType:"Cloze"` + templateId）；json（`save_json_file` 写临时目录） | `export.batch-apkg-and-json[0,4,6]` | 不支持的格式（工具栏的 csv / markdown 菜单）、apkg 无卡片；`anki-connect` 分支前端不可达 |
| `import_apkg_to_library` | 是 | `src/command-palette/modules/anki.commands.ts:50`；`src/features/flashcards/store/libraryStore.ts:509` | `I:81` | 导入本场景导出的包：自定义 Basic 模板包、Cloze 模板包、无模板包、批量导出包、含缺失媒体的包；同一包重复导入（每次新建 `apkg-<uuid>` 文档）；发 `fsrs://changed {action:"import"}` | `import.apkg-library-roundtrip[4,8]`；`import.apkg-cloze-template-roundtrip[4]`；`export.multi-template-output-paths[6]`；`export.batch-apkg-and-json[1,5]` | 路径空白、文件不存在、路径是目录、包结构/大小限制错误 |
| `import_anki_package` | 是 | `src/services/ankiConnectClient.ts:67` | `C:413` → `anki_connect_service.rs:1638` | 可用性检查 → `importPackage` 成功；`deleteAfter:false`；`deleteAfter:true`（成功后删除本地文件） | `connect.import-package[3,4]` | 路径空白、AnkiConnect 不可用、对端 `error`、HTTP 非 2xx、响应解析失败 |
| `start_enhanced_document_processing` | 是 | `src/components/anki/cardforge/engines/CardAgent.ts:380`（generateCards）、`:461`（startGeneration） | `E:85` → `S:86` | 多模板选项（CardAgent 原样：两个内置模板、`custom_anki_prompt` = `src-tauri/tests/fixtures/cardagent_system_prompt.txt`）；划词单模板 Cloze + `source_ref` + `custom_requirements`；`fsrs_feedback:true`（空复习库） | `generate.start-cancel-then-retry-task[2]`；`generate.selection-source-ref-single-template[1,6]` | 内容空白、超过 10MB、文档名含 `../` `./` `..\`、文档名超过 255 字节、`max_cards_per_mistake > 100` |
| `trigger_task_processing` | 是 | `TaskController.ts:258`；`taskControl.ts:28,90`；`CardAgent.ts:617` | `E:209` → `S:697` | cancel 后对 Cancelled/Failed 任务重试 | `generate.start-cancel-then-retry-task[6]` | 任务不存在、任务状态不是待处理（例如 `save_anki_cards` 建的 Completed 任务）、任务正在处理中 |
| `read_anki_media` | 是 | `src/components/anki/utils/cardMedia.ts:24` | `I:306` → `read_anki_media_in` `I:271` | 导入包落盘到 `<app_data>/anki_media` 的 png（`image/png`）、mp3（`audio/mpeg`）、大写扩展名 `Diagram.SVG`（扩展名转小写后 `image/svg+xml`）；同一路径连读两次；同一包导入两次后（同名同内容复用既有文件）读第二次导入卡片的路径 | `media.import-then-read-image-audio-svg[3,4,5,6]`；`media.reimport-same-package-reuses-files[4,5]` | 媒体根目录不存在、路径 canonicalize 失败（不存在/空白）、越出 `anki_media`（含软链接）、扩展名不在白名单、是目录或超过 25 MiB，均为 `只能读取已导入的卡片媒体`；读文件 IO 失败；spawn_blocking join 失败（不可达） |
| `dismiss_pending_memory_candidates` | 是 | `src/utils/graphApi.ts:103`（导出函数目前无调用方，合同记为 app） | `E:786` | 种子 `l16-pending-memory-w0`：`chat-` 前缀剥离后命中 2 条 pending（saved/dismissed 行不动）、重复 → 0、首尾空白 trim、过期但 pending 的行也会更新（不看 `expires_at`）、对已 saved 的会话 → 0、库内 id 本身带 `chat-` 时传单前缀 → 0、大写 `Chat-` 不剥离且原样命中、未知 id → 0 | `memory.dismiss-chat-prefix-then-idempotent[0,1,3]`；`memory.mark-saved-then-dismiss-noop[1]`；`memory.prefix-edge-ids[0,2,4]` | 空/空白 id → `conversation_id 不能为空`；`get_conn_safe` 失败；**空种子库没有该表 → `no such table: pending_memory_candidates`**（W-L16 可在 `empty` 上写） |
| `mark_pending_memory_candidates_saved` | 是 | `src/utils/graphApi.ts:116`（同上） | `E:814` | 同一种子：已被 dismiss 的会话 → 0、命中 1 条、`chat-chat-` 只剥一层后命中库内 `chat-` 行、`chat-` 剥离后为空串 → 命中 `conversation_id=''` 的行（不报空 id 错，因为校验在剥离前） | `memory.dismiss-chat-prefix-then-idempotent[2]`；`memory.mark-saved-then-dismiss-noop[0,2]`；`memory.prefix-edge-ids[1,3]` | 同上 |

辅助命令：`save_anki_cards`、`get_document_cards`、`get_anki_stats`、`create_custom_template`、
`get_all_custom_templates`、`import_builtin_templates`、`list_anki_library_cards`、`list_document_sessions`、`get_document_tasks`、
`cancel_document_processing`、`get_document_processing_state`、`set_document_session_source` 为 L16 已覆盖的目标命令；
`notes_save_asset` 属 **L10-notes**（`src-tauri/src/cmd/notes.rs:1859` → `dstu-storage/src/file_manager.rs:915`，前端
`src/components/crepe/features/imageUpload.ts:161` 的编辑器文件上传，同时发 snake_case 与 camelCase 键，本包照抄）。

### WP-233 媒体链与记忆候选种子

- **`read_anki_media` 为什么用 `notes_save_asset` 暂存**：场景格式没有“种子文件路径”token，引用也只能整值替换，
  所以无法把种子里的 apkg 路径交给 `import_apkg_to_library`。`notes_save_asset` 把 base64 原样解码后写到
  `<app_data>/notes_assets/_global/<noteId>/<uuid>.<ext>` 并返回 `absolute_path`；没有 `data:` 前缀时扩展名取 `defaultExt`（`apkg`）。
  `import_apkg_to_library` 的 `validate_apkg_path` 只要求是普通文件，不看扩展名。导入后卡片 `images` 是 `anki_media` 下的绝对路径
  （`apkg_importer_service.rs:2169`），正好是 `read_anki_media` 允许读取的根目录。整条链都是真实前端可达命令，空种子即可跑。
- **包内容**（1119 字节，sha256 `6a0d053ce28308e81447551676018d5bc5c7e0f9caa27c9325e006e08f467bef`）：与 Rust 测试
  `media_import_extracts_declared_files_and_links_referencing_cards`（`apkg_importer_service.rs:4149`）相同的极简 legacy 结构：
  `collection.anki2`（`col/notes/cards` 三表，Basic 模型 `Front/Back`，牌组 `W233 Media`，1 note / 1 card，
  字段 `猫 <img src="cat.png">` 与 `<img src='Diagram.SVG'> 读音 [sound:clip.mp3]`）、`media` 清单 `{"0":"cat.png","1":"clip.mp3","2":"Diagram.SVG"}`、
  三个条目（70 字节 1×1 PNG、31 字节 ID3 头、95 字节 SVG）。zip 条目时间固定为 2026-01-01，base64 直接写在场景里，A/B 字节相同。
  `images` 顺序按字段扫描（先 `src=` 后 `[sound:`）为 cat.png、Diagram.SVG、clip.mp3；场景按下标读取，三者都是成功路径，顺序不影响覆盖。
- **记忆候选种子 `l16-pending-memory-w0`**（`pending-seed/`，owner **X3**，与 `integration/equivalence/pending-seed/` 同样的放法，
  runner 只读顶层目录，所以不会遇到未知 seed）：当前 Rust 不建 `pending_memory_candidates` 表。v0.9.2（`1813b3c9c`）在
  `src-tauri/src/database/manager.rs:698-716` 用 `CREATE TABLE IF NOT EXISTS` 建在 `mistakes.db`，`c006f457b`（2026-07-20）删掉了这段且没有 DROP，
  所以从 v0.9.2 升级上来的数据目录仍有该表。种子 SQL 原样使用 v0.9.2 的 DDL，再插入 10 行（含 saved/dismissed、过期 pending、
  库内带 `chat-` / `Chat-` 前缀、空 `conversation_id`），时间戳全部显式给定。需要 X3 在 A、B 两端把它应用到“已启动过一次、已停止”的 `mistakes.db`。

### WP-233 未覆盖命令

| 命令 | 在768 | 原因 | 解除条件 / owner |
|---|---|---|---|
| `get_pending_memory_candidates` | 否 | 合同 `frontend:"none"`（`graphApi.ts:90` 的导出函数没有调用方），check 只收 `frontend:"app"`。另外成功在任何库上都不可达：`E:751` 的 SELECT 读 `subject` 列，而 v0.9.2 的表定义从来没有 `subject`（`knowledge_executor.rs:125` 的 INSERT 也写 `subject`），有表时报 `no such column: subject`，且在报错前已执行 `DELETE ... expires_at < datetime('now')`。这是 Rust 缺陷候选，保持原行为。 | 合同改为 app 后，只能写错误场景（W-L16）。 |
| `dismiss_pending_memory_candidates`、`mark_pending_memory_candidates_saved` | 是 | 成功场景见 `memory-candidates.seeded.json`，种子 `l16-pending-memory-w0`。 | — |

### WP-233 运行器注意

- **生成管线是后台任务**：`start_enhanced_document_processing` 只同步切分并写 `Pending` 任务，然后 `tokio::spawn` 调度。
  空种子没有模型配置，任务会经 `get_configurations` 失败转为 `Failed`。它与紧接着的 `cancel_document_processing` 哪个先发生取决于时序，
  所以 `get_document_tasks` 的状态、`TaskStatusUpdate` 事件的数量和顺序都可能变化。`trigger_task_processing[6]` 在 Cancelled 和 Failed 下都成功；
  只有后台任务仍处于 spawn 与就绪信号之间时，才会走 `任务正在处理中` 分支。A1/A2 不一致时按时序归因交 C2，不先规范化。
  要得到确定结果，需要 X5 的脚本化 LLM 端点并配置为默认模型。两个 generation 场景必须各自在新进程里跑（`DOCUMENT_STATES`/`RUNNING_HANDLES` 是进程级静态表），
  录制 DB 前需等后台任务结束。
- **导出路径**：apkg 写到 `$HOME/Downloads/<清理后的牌组名>.apkg`，JSON 写到 `$TMPDIR`（`prepareScenarioRun` 已按场景隔离）。
  `export.multi-template-output-paths` 用上一步返回的绝对路径模拟保存对话框，因此会覆盖同一文件。
- **`chatApi.exportAnkiCards` 的键名**：前端在 `request` 里发 `deck_name`/`note_type`/`template_id`，而 Rust 结构体是 camelCase，
  这些键会被静默忽略（牌组回落 `ChatAnki`）。`[2]` 保留前端真实形状，`[5]` 用合同键。这是前端缺陷候选，本包不修。
- **AnkiConnect**：`anki.connect.import-package` 与 WP-157 一样占用 8765 端口，必须串行运行。对端没有 `importPackage` 处理器，
  所以 `anki-connect-import.peers.json` 用常驻 `reply` 返回 AnkiConnect 的成功包 `{"result":true,"error":null}`。
  `deleteAfter:true` 删除的是文件系统里的文件，不在 `capture.db` 里；对端的 `requests` 会记录 `importPackage` 的 path。
- **normalize 候选（未写入）**：JSON 文件名里的时间戳（`anki_cards_%Y%m%d%H%M%S.json`、`anki_cards_<unix>.json`）、apkg 的 `sizeBytes`（zip 时间与卡片时间戳）、
  `apkg-<uuid>`/`apkg-task-<uuid>` 和导入卡片的 UUID、生成管线的 document/task UUID 与时间戳、模板 UUID。路径前缀是每次运行的数据目录。
  媒体场景另有 `notes_save_asset` 返回的 `<uuid>.apkg` 文件名与绝对路径；`read_anki_media` 的 data URL 由包内固定字节决定，不规范化。

## 排除与剩余

不纳入本包（合同中 `frontend:"none"`）：`get_custom_template_by_id`、`import_template`、`get_task_cards`、
`get_all_recent_cards`、`save_template_debug_data`；读回改用 `export_template` / `get_all_custom_templates`。

L16 合同共 61 条命令，WP-076 17 条、WP-141 10 条、WP-157 6 条、WP-233 11 条，`frontend:"app"` 的 44 条全部有成功场景。
其中 `dismiss_pending_memory_candidates`、`mark_pending_memory_candidates_saved` 的场景在 `pending-seed/`，等 X3 发布种子 `l16-pending-memory-w0` 后才可执行。

剩余 `frontend:"none"`（17）：WP-076 排除的 5 条加 `check_anki_connect_availability`、`delete_document_task`、
`export_apkg_for_selection`、`export_cards_as_apkg`、`generate_anki_cards_from_document`、
`generate_anki_cards_from_document_base64`、`generate_anki_cards_from_document_file`、`get_document_task_counts`、
`get_pending_memory_candidates`、`reset_model_adapter_options`、`save_json_file`、`save_model_adapter_options`。

## 状态

未运行 A/B，未计 C。TESTMAP、SPEC、Rust、共享合同与 runner 未改动。WP-233 只新增场景 JSON、对端剖面、种子规格 SQL 和本 README/check.mjs 的对应条目。WP-157 的生产入口定向证明见
`host/plugins/anki/tests/anki-connect-http-peer.test.ts`（Node 与 Electron 各 38/38），其中不 stub fetch/net。
