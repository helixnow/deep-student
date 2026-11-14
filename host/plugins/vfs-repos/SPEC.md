# L11-vfs-repos 行为规格（`host/plugins/vfs-repos/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 0 个 · 发出事件 0 种 · 契约：`contracts/ipc/L11-vfs-repos.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：带 `skip_serializing_if = "Option::is_none"` 的字段缺省（`compact`/条件展开，见 `repository/todos.ts`、`repository/attachments.ts`、`repository/mindmaps.ts`）；Rust 不跳过的 Option 字段保留 `null`（如 `Question.*`、`VfsResource.source_id`）；`VfsEssaySession.essay_type/grade_level` 恒为字符串（缺省时 `""`）。
- [x] u64/i64 超过 2^53 的表示：ID/哈希全部用字符串；时间戳按毫秒 number（当代时间在 2^53 内）；`VfsBlob.size` 等 u64 字段按 number 暴露，>2^53 会丢精度，属已记录差异，不用 `Number()` 处理 ID/HLC。
- [x] 字段顺序（serde_json preserve_order）：workspace 的 `serde_json` 开启 `preserve_order`；TS `JSON.parse/stringify` 对普通字符串键保持插入顺序，但整数形键按 JS 规范重排。测试只比较解析后的字段/数组，不对含对象的整段 JSON 做顺序敏感比较。
- [x] f32 精度：`attachment_repo.rs:853` 的 `processing_progress as f32` 在 TS 用 number（double）；进度测试使用整数百分比，非整数进度的末位舍入可能与 Rust f32 不同。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：统一抛 `VfsRepositoryError`（`code`、`message`、可选 `data`、`cause`），SQLite 错误映射为 `VFS_STORAGE` + `Database error: ...`；Rust 的 panic 不迁移，参数/状态错误改为稳定 `VFS_INVALID_ARGUMENT`/`VFS_INVALID_OPERATION`，不向调用方暴露 panic 文本。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：Rust repo 方法本身不接收 CancellationToken，均为同步/连接绑定；TS 同样不引入 AbortSignal。附件异步上传只在进入数据库事务前 await 原生处理，事务内无取消点；`StagedBlob` 的 Drop 清理已由 `dispose()`/`staged.dispose()` 等价实现。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：每个调用方显式传入同一 `SqlExecutor`；写路径使用 `BEGIN IMMEDIATE`/`SAVEPOINT`，跨表写只由表所有者仓储执行。Rust `BLOB_FILE_MUTATION_LOCK` 对应 TS 的同步 blob 方法 + `UPDATE blobs ... WHERE 0` 预留写锁；异步上传在 await 之后才进入保存点，避免文件/元数据交错。
- [x] 时间与 ID：生成方式、格式、时区：时间统一走 `host/platform/time`（AutoSi `+00:00` 或 `%.3fZ`），解析用 chrono 兼容 `parseRfc3339`/`parseNaiveDateTime`；ID 使用 Rust 相同前缀 + `nanoid(10/16)`；本地日界仍用 JS 本地 `Date` 构造午夜（毫秒精度）。
- [x] 不对含 HashMap 的结构做序列化后比对：仓储输出中的 map 仅出现在 `metadata_json`/`settings`/`structured_data` 等 JSON 字段；测试比较解析后的键值或字段，不断言 HashMap 迭代顺序。`serde_json` 的 `preserve_order` 只保证输入顺序，不作为跨语言相等条件。

## 已迁移仓储：id_alias / path_cache

- `id_alias.rs:11–64`：不存在别名表时原样返回；按表名逐链查找；任意循环返回最初 ID；保留两个中文错误前缀。
- `path_cache_repo.rs:64–997`：所有方法接收同一 `SqlExecutor`；批量写和全量重建显式 deferred 事务，与 Rust 一样不能嵌套进已有事务；失败回滚。按文件夹重建不额外开启事务。
- 缓存条目/统计返回 camelCase；读/失效将 textbook 转为 file，写入不归一化（保留 Rust 的非对称行为）。路径上限 1000 **UTF-8 字节**，批量写跳过超长条目；单条写报 InvalidArgument。
- 路径时间为 UTC 毫秒 ISO 字符串；folder path 向上最多 11 层；递归子树 depth 从 0 开始、上限 10；资源路径使用 ID 而非标题；前缀保留 LIKE 通配符。
- 原测试 7 个已移植，另覆盖链循环、错误、中文路径字节上限、回滚、重建与软删除过滤。本 lane 23 个 Rust 仓储文件已全部迁移，`TESTMAP.md` 158/158 行 `ported`、`pending` 0。

## 已迁移题目仓储范围

### WP-216：仅条件回填 explanation 的 owner 原语

Rust `dstu-qbank/src/qbank_grading/pipeline.rs:680-688` →
`api.ts` 既有 questions 类型导出 → `QuestionRepository.fillExplanationIfEmpty(conn,id,explanation): number`
→ 生产 `ctx.vfsRepo.questions` 的同一 `QuestionRepo` 实例。

| Rust 分支/边界 | TS 行为与生产入口测试 |
|---|---|
| :682-686 id、未删除、NULL 或 TRIM 空串 | 单条 UPDATE explanation，TRIM 字符仅空格/9/10/13；NULL/空串/各字符命中1，非空/其它空白/已删/缺行0 |
| :668-669 写时判据 | WHERE 在 UPDATE 内判断；另一连接已写解析或本方法重复调用不能覆盖 |
| :677 输入 trim 判空 | 留给 L14；本原语原样绑定输入，空输入也执行 SQL |
| :688 SQL 失败 | 原始 StorageError/message/sqliteCode/cause 交调用方，不包装 Database error、不记录日志 |
| :689-701 history 与后续 mark/hash | 留给 L14 按原顺序编排；本原语不预读/回读、不写其它列、不主动 history/mark/hash/invalidate、不新开事务 |
| 调用方 conn | 同连接执行；外层事务内可见、外部连接不可见，回滚撤销、提交生效 |

真实迁移 schema 的 `V20260130__init.sql:503-508` 保持 `trg_questions_updated_at`：
只 SET explanation 仍会自动更新 updated_at；FTS/change_log 原触发器也保留，不删除以满足列断言。
`tests/question-explanation-owner-write.test.ts` 核整行（仅 explanation＋原触发器时间戳）、
相邻行、history 空、已 indexed 资源整行不变、真实触发器失败和外层回滚。
证据为源码审读＋真实 Host/SQLite，不新增 Rust TESTMAP 映射资格。

### V2-OWNER-QBANK：题集生命周期消费 qbank owner

- [x] `exam_repo.rs:2115-2175/902-911/1246-1254`、`qbank_helpers.rs::retains_asset` →
  `exams.copyExamSheet/deleteExamSheet/restoreExam/purgeExamSheetWithConn` →
  正式 `QbankService.examCascade` 四个 WithConn 方法。生产从 ctx.get('qbank') 懒解析，
  不加入 inject（qbank 自身也消费 vfsRepo），无依赖环/SQL回退。
- [x] 所有权与事务：删除 L11 对 qbank_sources/materials/groups/group_materials/papers/practice_attempts
  的写入副本；L11 保留 questions/folder_items/exam_sheets 的原语句与顺序、原 savepoint、原 conn。
  copy 传入 `utcNow()`（Rust to_rfc3339）并消费返回的 ID 映射；restore 原样传入 batch 或 null。
- [x] 错误/日志：外层 StorageError 仍映射 VFS_STORAGE；owner copy 的 SyntaxError 保留
  VFS_SERIALIZATION 包装；原 rollback/warn/error 分支不删。缺 qbank owner 明确报错，不静默跳过。
- [x] 测试：`tests/exams.test.ts` 以两个真实插件组合，原三例不弱化，新增四例核 authoring
  引用重映射、真实 owner SQL 错误时 L11 blob/resource/exam 回滚、删除批次/恢复保留既删行、
  JSON 错误与 owner snapshot 引用阻止 blob 递减。`20261104162348-930820` 7passed/exit0，无Errors。
- [ ] 未据此声称 qbank owner 的全部 JSON/整数语义已差分等价；main 合入后还需独立复验。

- `question_repo.rs:82–585`：发布 Question/筛选/作答/历史/统计类型。`QuestionImage.role` 缺省而非 null；其他 Option 返回 null。QuestionType 宽松归一化，其他 enum 未知值使用 Rust 默认值。
- `618–2331,2615–3477`：查询/筛选/FTS 与 LIKE 回退、错题本、canonical 分页/文本、题组材料读取投影、创建/批量创建、删除/OCC 删除、历史、统计、提交快照与幂等均已实现。每个调用显式传入同一个连接；SQL 顺序和事务边界沿用源码。
- FTS 路径页大小夹到 1–100；空词直接返回输入分页；LIKE 搜索回退保留未夹紧分页并忽略 sort_by（Rust 原行为）。随机抽题忽略 filters.search；错题本统计忽略题目集/搜索过滤。
- `update_question` 与 `submit_answer` 已按 `question_repo.rs:2344–2609` 实现：OCC 条件写进 `UPDATE ... WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`，冲突记 warn 并抛 `VFS_INTERNAL` + `QBANK_CONFLICT: expected_updated_at=..., actual_updated_at=...`；写入后执行 `mark_as_modified`（`sync_status` CASE）与 `update_content_hash`（SHA-256 字段顺序照 `question_sync_service.rs:471–517`）。两个同步副作用只写本 lane 的 `questions` 列。原 2 个 OCC 测试已移植，`TESTMAP` 无 pending（见文末阻塞说明）。
- 时间：使用 `host/platform/time` 的 chrono 兼容实现；`to_rfc3339()` 写 UTC `+00:00` 并按 AutoSi 输出 0/3/6/9 位小数，`%Y-%m-%dT%H:%M:%S%.3fZ` 列用 `toRfc3339Opts(..., 'Millis', true)`。平台时钟的亚毫秒部分来自 `performance.now()` 采样，不等同 Rust `Utc::now()` 的真实纳秒时钟；不能将同毫秒并发更新时间当作纳秒一致性已验证。
- **Q8/L14 题目表唯一写者接缝**：`question_bank_service.rs:820-957` 的改判段发布为 `applySubmissionVerdict(conn, questionId, submissionId, isCorrect, gradingMethod, now)`，返回 `{changed, updated_question, submission}`：同向短路、严格绑定 submission/question、按 submission 旧值算 `correct_count` 增量、只对最近一次 submission 改题目状态、submission `updated_at/local_version+1`、题目 `sync_status/content_hash`；stats 与 L15 mastery 由 L14 在同一事务内随后调用。`1725-1916` 的整库/单题重置发布为 `resetExamProgress`（含 submissions 删除与 stats）和 `resetQuestionProgress`（返回 exam_id）；`665-709` 的当日进度读取发布为 `dailyProgressRows`。出题/迁移/题组的直接 `questions` 写入另发布 `applyQuestionMetadata`、`bindQuestionCard`、`mergeQuestionProvenance`、`replaceQuestionForReparse`、`updateQuestionGroupMembership`、`softDeleteQuestionInGroup`，与 L14 原 SQL 的列/条件/OCC 语义一致。WP-021 另发布 AI 缓存与同步标记四方法 `updateAiFeedback` / `updateAiAnalysis`（`qbank_grading/pipeline.rs:596-607`，原始 SQLite 错误不包装）、`markAsModified` / `updateContentHash`（`question_sync_service.rs:1518-1556`，读题照 `get_question_by_id:1612-1718`，缺失/转换失败为 `question not found: <id>`），见 `BLOCKERS.md`「WP-021」与 `tests/question-sync-owner-writes.test.ts`。L14 不再保留这四张表的 SQL 副本；接线清单见 `BLOCKERS.md`。`tests/question-owner-writes.test.ts` 覆盖改判、同向重放、旧 submission 改判、mastery 失败回滚、重置、当日进度与迁移/题组写入。

## 已迁移待办仓储范围

- `todo_repo.rs:19–524`：完整移植日期/时间/提醒校验、重复规则解析与推进、提醒平移、批量 ID 清洗（去空白、去重、上限 500）、行解析（解析失败按 Rust `log_and_skip_err` 跳过，回收站列表例外为整批报错）。
- `527–4227`：清单与条目 CRUD、OCC（`update_todo_list_if_version` / `delete_todo_list_if_version` / 条目更新与删除）、默认收件箱、收藏、重排、移动子树、今日/逾期/未来/已完成/提醒/搜索、计数快照、活跃摘要与 Prompt 文本、回收站、批量完成/改期/优先级/移动/删除/恢复/彻底删除、统计总览、全量标签、子任务计数均已实现。
- 返回结构按 Rust serde 输出 camelCase；`Option::is_none` 字段缺省而非 `null`。错误码与 Display 文案沿用 `VfsError`（`VFS_NOT_FOUND`、`VFS_INVALID_ARGUMENT`、`VFS_INVALID_OPERATION`、`VFS_CONFLICT`），冲突消息保留 `TODO_CONFLICT` 与 `key`。
- 写路径保留 `local_version = COALESCE(local_version,0)+1`、清单 `updated_at` 推进、SAVEPOINT 原子性、递归 depth 100 上限与“同批次删除”恢复语义。`fresh_updated_at` 使用 UTC 毫秒，并在不晚于上一版本时 +1ms。
- 重复规则保留 Rust 原行为：weekly 的 `byWeekday` 去重排序、非 weekly 忽略、空数组视为未设置；monthly/yearly 收口到月末；逾期完成跳到 >= 今天（允许等于今天）；派生实例按标题+到期日+规则去重。
- 本地日历日边界使用 JS 本地时区构造午夜；DST 不存在/歧义时刻与 Rust 的 0–3 点逐小时探测在常见时区一致。时间戳格式化/解析已改用 `host/platform/time`；本地日界构造仍依赖 JS `Date` 的毫秒精度。
- 原测试 27 个全部移植到 `tests/todos.test.ts`，并保留 Rust 测试函数名。

## 已迁移文件夹仓储范围

### N5 / L10-V2-01：笔记流程的六个 L11 同连接写点

- [x] 入口：`api.ts::NoteOwnerWrites` → 生产 `vfsRepo.noteOwnerWrites` →
  `repository/note-owner-writes.ts`。独立能力，不向旧仓储接口增加必填成员；消费者先检查能力，
  缺失明确报错，不能复制 SQL 作为回退。无需 notes 静态 inject，不产生服务依赖环。
- [x] 分支/列：Rust `note_repo.rs:538` 仅绑定 resources.source_id；`:837/:1878` 仅按 id
  删除单个 resources 行，返回 changes；`:2383` 仅软删 item_type='note' 且仍活跃的 membership；
  `:1618-1637` 按 COALESCE(updated_at,created_at) DESC、created_at DESC 选一条已删 note membership
  后仅按选中 id 恢复，缺行返回 0；`:2397` 仅把 unit 两个 state 改 disabled；
  `:3111-3118` 固定维护 key INSERT OR REPLACE 为 true。
- [x] 边界/所有权：只写 L11 的 resources/folder_items/vfs_index_units/vfs_indexing_config；
  noteId/resourceId/删除时间不清洗，updatedAtMs 保留 `number | bigint` 并直接绑定，无 Number 转换。
  标志专用面不放宽公开 setConfig 白名单。
- [x] 事务/错误/日志：所有方法只用传入 SqlExecutor，不开始或提交事务；SQL 失败保留
  VFS_STORAGE / `Database error: …`。L10 保留引用计数检查、清索引、快照、日志和先后次序；
  完成标志仍只能在所有 rebuild 批次成功后调用，不把维护流程搬进 L11。
- [x] 测试落点：`tests/note-owner-writes.test.ts` 安装真实生产插件并调用公开能力；
  核完整行未改额外列、i64 绑定、软删过滤/单行恢复排序、固定 key/白名单，以及真实触发器失败时
  六写共同由调用方事务回滚。不用 notes owner 算法替身。
  作业 `20261104160908-a3ba2b`：6 passed、exit 0、无 Errors；
  typecheck `20261104160908-b5fd7e` exit 2 仅 `vfs-index/repository/index-units.ts:338/348`
  的既有 generation 联合合入类型错误，无 L11 新接口/实现错误。
- [ ] 消费方完整生产链、main 合入后独立复验和 Rust 动态差分尚未据此宣布通过。

### R13v-03：breadcrumbs 窄读取

- [x] Rust `dstu/folder_handlers.rs:911-975` → `folders.getBreadcrumbs(conn, folderId)` →
  `repository/folder-breadcrumbs.ts`；CTE 从叶到根最多 11 层，出参根到叶 `{id,name}[]`，不加 deleted 过滤。
- [x] F3 iterate 是惰性执行：prepare/bind/execute 错误按 `StorageError.phase` 区分。
  prepare 记 error 并抛“数据库查询失败”；bind 抛 `Query failed: …`（无额外 error）；
  step/字符串列解码失败记 error 并抛 `Collect failed: …`；成功 info 含 folder_id/count。
- [x] 只读 folders、使用调用方连接，不开事务、不拼入任意调用方 SQL。命令的入口/get_conn 日志仍归 L13。
- [x] 按架构师后续接口兼容裁定，`FolderRepository.getBreadcrumbs?` 为可选能力；生产实现不变。
  新消费者必须检查存在性，缺失明确报错；不以复制 CTE/静默回退替代 owner。既有实现不被新增成员破坏。
- [x] `tests/folders.test.ts` 从生产 host 服务覆盖深度、顺序、缺行与成功日志；
  `20261104143849-ab8c91` 14 测试 exit 0；新增真实 SQLite prepare/坏列类型用例另行记录结果。
- [ ] 本节为 owner 服务测试及源码审读，未声称 L13 命令已消费或 Rust 动态差分通过。

### C1 U2/U4：metadata-only 与教材 relink 写点

- [x] `translation_executor.rs:1293-1311` → `translations.setMetadataJsonOnlyWithConn`：
  原样绑定调用方已序列化 JSON，仅写 metadata_json；不改 updated_at/version；0 行抛
  `translation row {id} not found for metadata update`，SQLite 错误不包装。
- [x] `cmd/textbooks.rs:747-754` → `textbooks.setOriginalPathWithConn`：仅写 original_path +
  updated_at（UTC 毫秒 ISO），不新开事务，0 行不报错；后续读文件/补 blob 失败不回滚该写点。
  内容校验、调用顺序及外层错误前缀仍由消费者按 Rust 保留。
- [x] `tests/translations.test.ts` / `tests/textbooks.test.ts` 生产服务测试对比完整行：
  仅预期列改变，缺行分别报错/返回 0；`20261104144515-dfd4f5` 15 passed，exit 0，无 Errors。
- [ ] 消费者完整命令链与独立复验另验，不以这两个写点测试代替整条命令验收。

- `folder_repo.rs:32–3105`：文件夹 CRUD、递归 ID/路径、树、内容项成员管理、移动/重排/计数、展开/收藏、回收站软删/恢复/彻底删除、资源定位与上下文注入聚合均已实现。所有方法接收调用方 `SqlExecutor`。
- `folders.created_at/updated_at` 保持 INTEGER 毫秒；读取用 Rust 的 `CASE typeof(...)` 兼容 TEXT 历史行。`folder_items.created_at` 兼容 INTEGER/REAL/TEXT（RFC3339、`YYYY-MM-DD HH:MM:SS`、`YYYY-MM-DD`、秒级整数），无法解析时按 Rust 回退 0。
- 成员类型统一经 `textbook → file` 归一化；添加/删除成员按 Rust 先删同 `(item_type,item_id)` 旧行。批量移动保留 Rust 的原始类型分组（不归一化）与无 `deleted_at` 过滤。批量 SQL 以 100 条分块。
- 文件夹删除/恢复/彻底删除保留 SAVEPOINT 原子性、幂等软删、父级已删则恢复至根并生成唯一标题、子树缓存清理与 `folders.purge_conflict` 冲突键。`rename_folder_if_version` 使用 `max(now, expected+1)` 推进版本并返回 `folders.conflict`。
- 级联实体操作通过 `FolderEntityAdapter` 注入（file/image、exam、translation、essay、mindmap 由本 lane 各仓储提供；note 需 L10 note 仓储提供）。未接适配器的已知类型会显式报 `VFS_INTERNAL`，避免静默漏删；Rust 中本就未知的类型仍按源码告警跳过。
- 原测试 9 个已移植到 `tests/folders.test.ts`（含依赖 note 级联的用例；测试宿主经 `tests/support/notes-service.ts` 提供 notes 替身，生产代码只调用 `notes.repository` 的公开方法）。

## 已迁移 Blob 仓储范围

- `blob_repo.rs:24–1145`：SHA-256 去重存储、同 hash 复用已登记 `relative_path`、原子临时文件写入、`ref_count` 增减（下限 0）、引用为 0 的两阶段删除（prepare → ready outbox）、崩溃恢复、未登记孤儿文件清理、24h 临时文件清扫均已实现。
- 物理目录由调用方传入（对应 Rust `blobs_dir`）；`stage_stream` 以 `Iterable<Uint8Array>` 表达流式写入，保留大小上限与暂存文件清理。
- 删除日志与 outbox 复用迁移中的 `__file_deletion_journal` / `__blob_deletion_queue`，状态机 prepared → ready → published/cancelled 与源码一致。物理删除要求 autocommit 连接（用 `PRAGMA synchronous=FULL` 失败映射为 Rust 的 `INVALID_STATE`）。
- 原测试 10 个全部移植到 `tests/blobs.test.ts`。

## 已迁移文件仓储范围

### V2-PDF-JSON：持久化预览解码与blob引用（2026-11-04）

- [x] 入口/分支：Rust `types.rs:2851-2898` + `attachment_repo.rs:2485-2509`、`file_repo.rs`/`textbook_repo.rs` 的 `from_str::<PdfPreviewJson>` → `repository/pdf-preview-json.ts`；附件purge、文件/教材copy与purge共用一个解码器。
- [x] 字段：pages/renderDpi/totalPages/renderedAt必填；pageIndex/blobHash/width/height/mimeType必填；compressedBlobHash缺省或null为None；isTruncated/maxRenderedPages只在缺省时false/0，显式null非法；未知字段忽略；支持serde结构体字段顺序数组形式。
- [x] 数值：Node source-aware JSON reviver保留整数字面量为bigint，u32上界为4294967295、桌面usize上界为18446744073709551615；浮点字面量（即便150.0）和负数拒绝。内部usize不经过number，原始preview_json字符串仍原样持久化，公共wire类型不变。
- [x] 错误/日志：解析失败返回null，Rust `if let Ok` 同样静默跳过整份预览；不会先递减有效前缀页再遇坏页。blob失败的warn/事务传播保持调用点原行为。
- [x] 所有权/运行时：只由L11 copy/purge操作自己的blobs/files/resources；解析不打开连接、不引入事务或取消点。
- [x] 测试：`tests/pdf-preview-boundary.test.ts`安装生产插件，公开attachments.purgeAttachmentWithConn/files.copyFile，读取真实blob ref_count；旧实现红测 `20261104105344-7bf6ce` exit1（缺必填字段仍递减、u32溢出仍增加引用）。新增测试不改弱任何原测试。
- [ ] 证据边界：JSON.parse对对象重复键采用后值覆盖，serde结构体会拒绝已知字段重复；需要平台共享保留键序列的JSON解析能力，此项已请求F4，不能将本小节称为全域serde等价。其余上述分支由生产入口回归/源码审读证明，无Rust动态差分。

- `file_repo.rs:42–1795`：文件创建/去重（软删自动恢复）、文件夹内创建、文档数据创建与 `created` outcome、blob 共享复制、查询/列表、重命名/收藏、软删/恢复、SAVEPOINT 彻底删除（含 PDF 页图与压缩 blob 引用递减、索引产物入 Lance 孤儿队列）、回收站列表、内容读取（压缩图 → resources.data → blob → original_path 的 base64 回退）、OCR 页读写、批量 purge、存在性与 resource_id 查询均已实现。
- `create_file_in_folder` 保留 Rust 的 `BEGIN IMMEDIATE`/`COMMIT`；`create_file`、`create_file_with_doc_data_in_folder_outcome`、`copy_file`、`purge_file` 使用同名 SAVEPOINT，可嵌套于外层事务。
- `row_to_file` 保持 `VfsFile` 的 camelCase 序列化语义：`Option::is_none` 字段省略，`tags_json`/`bookmarks_json` 解析失败回退空数组，行解析失败在列表查询中告警跳过。
- `purge_file_with_conn` 在 files 表无记录时按 Rust 删除任意 `folder_items.item_id` 孤儿行；删除索引产物复用 `purge_index_artifacts_by_resource`（`__lance_orphan_queue` + `vfs_index_units`）。blob 引用递减失败仅告警，不阻断删除。
- `delete_file_with_index_cleanup`（异步、依赖 index_service/Lance store）未迁移：索引清理由 L12 索引 lane 的删除链路负责；本 lane 提供同步软删。
- PDF/媒体处理写点（`pdf_processing_service.rs`）发布为连接绑定业务方法：`updatePdfExtractedText`/`updatePdfPreview`/`updatePdfPreviewOnly`/`updatePdfOcrPages`/`updateCompressedBlobHash`（均按 Rust `updated_at=datetime('now')`）、`cancelProcessing`、`markProcessingRecovered`、`setProcessingError`、`updateProcessingProgress`、`applyProcessingStatus`（四阶段分支，**不**触碰业务 `updated_at`）；`compressed_blob_hash` 写入不另开事务，blob 引用变更由调用方在同一事务完成。多模态业务表写入 `applyMultimodalIndexState` 按 `multimodal_service.rs:1631-1644` 分支写 `mm_index_state/mm_indexed_pages_json/mm_index_error/updated_at`。
- 上传命令的另一个写点 `handlers.rs:2528-2537` 单独发布为
  `files.setUploadOcrPagesWithConn`：**只**写 ocr_pages_json，不改 updated_at、不开新事务、0 行不报错；
  SQL 错误原样交由上传消费者按 Rust 记 best-effort warn。不可用上面的 `updatePdfOcrPages` 替代。
  `api.ts` 同时转导出渲染器原对象 `DEFAULT_PDF_PREVIEW_CONFIG`，消费者不复制默认值。
  `tests/pdf-owner-writes.test.ts` 从生产服务核整行、缺行和外层事务回滚，并核导出对象身份。
- 原测试 6 个全部移植到 `tests/files.test.ts`；`folders.test.ts` 增补 `test_purge_folder_tree_handles_image_items`，并接线 file/image 文件夹级联适配器；`pdf-owner-writes.test.ts` 覆盖 PDF/多模态写点的列、时间戳、计数与调用方事务回滚。

## 已迁移资源仓储范围

- `resource_repo.rs:54–988`：内容哈希去重创建（`INSERT OR IGNORE` 竞态安全）、指定 hash 创建、external 模式创建、按 id/hash/source_id 查询、引用计数增减（下限 0、缺失行按 Rust `Query returned no rows` 报错）、批量递减、retrieval 与孤儿 note/mindmap 资源清扫（Lance 孤儿入列 + units 删除）、按类型列表、LIKE 搜索、原地更新 data/hash（唯一冲突退避为加盐 hash 并重置索引状态）、OCR 文本存取均已实现。
- `VfsResource` 的 wire 键保留 Rust 的 `type`（显式 `#[serde(rename = "type")]`）；`insight_card`/`insightcard` 读取归一为 serde 小写形式 `insightcard`，写入仍用 Display 形式 `insight_card`。未知类型回退 `file`，未知存储模式回退 `inline`。
- `created_at`/`updated_at` 兼容 INTEGER 毫秒与 RFC3339 TEXT（解析失败回退 0），与 Rust `row_to_resource` 一致。
- PDF OCR 链路另发布 `saveOcrTextForFile(conn, fileId, ocrText)`，对应 `pdf_processing_service.rs:2663` 的 `resources.ocr_text` 子查询写入（`updated_at=datetime('now')`，返回 changes 供调用方保留 `rows_affected==0` 报错）；它与 `saveOcrText` 的 `resource_repo.rs:922-938` 毫秒时间戳语义分开，不互相替代。
- 原测试 6 个移植到 `tests/resources.test.ts`；并发测试在 Host 单连接同步执行下退化为串行 10 次调用，仍验证单行/单 `isNew` 不变式；`pdf-owner-writes.test.ts` 覆盖按 file 写 OCR 与 affected rows。

## WP-001：L12 精确 OCR 缓存与卡住索引恢复

Rust 来源为 `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs`，消费入口为
`vfs-index/repository/index-content.ts:199-224,367-370`。新增方法经 `api.ts` 的
`PdfResourceOwner` / `MaintenanceRepository` 导出，由 `index.ts:53,117-121,167` 的真实
`ResourceRepo` / `MaintenanceRepo` 发布，不新增服务或连接包装。

| Rust 分支 | TS owner 落点 | 验证 |
|---|---|---|
| :1082,3485 `ocr_text IS NULL OR ocr_text = ''` | `resources.saveOcrTextIfEmptyWithConn`，单条条件 UPDATE | NULL/空串写入，已有文本/空白不覆盖，缺行成功，整行只变 OCR |
| :3354,3949 按 id 无条件 OCR UPDATE | `resources.saveOcrTextWithoutTimestampWithConn` | 原文（含空串/空白）绑定、不改 updated_at、缺行成功 |
| :1982-1997 text indexing | `maintenance.recoverStuckIndexingWithConn` 第一条 UPDATE | 仅 text_state/error + caller at；required=0 仍恢复，其余列保留 |
| :1999-2014 mm indexing | 同方法第二条 UPDATE | 仅 mm_state/error + 同一 at；双路 unit 计两次 |
| :2016-2038 resource 任一路 indexing | 同方法第三条 UPDATE 的两组 CASE | 对应路 pending/error、retry/next_retry=0；另一侧保留；双路 resource 计一次；不改 updated_at、不滤 deleted_at |
| :1991,2008,2032 UPDATE 失败 | 各语句独立 catch → 原文 warn → 计0并继续 | 每个分支真实 SQLite ABORT 触发器；缺表 prepare 失败 |
| :2040-2052 total>0 / =0 | 累加三次 changes；warn 含分项计数 / debug 无卡住行 | 正常总数11（含另一侧NULL保留）、部分失败总数2、重复/缺表总数0 |

- 数据边界：OCR 字符串原样绑定，方法不 trim/解析 JSON；at 是调用方一次采样的毫秒 number，
  与 L12 请求签名一致，不在 owner 重新读时钟。返回 void / changes 总数 number，无 IPC DTO 改动。
- 事务：三个入口只使用传入 SqlExecutor，不开连接、不 BEGIN/COMMIT/SAVEPOINT；恢复的 Rust
  原入口也没有自持事务。调用方传事务时所有成功写入跟随其回滚，语句失败仍按 Rust best-effort。
- 错误/日志：OCR SQL 错误原样抛出，L12 调用点应保留 `[VfsIndexing] Failed to cache ocr_text…`
  warn（审读发现现有 L12 缺局部 catch，已记 BLOCKERS）；owner 不重复记日志或改成 `Database error:`。恢复的三个失败 warn 与汇总 warn/debug
  由 owner 保留，位置在三条 SQL 执行过程中/之后，不改成提交后日志。
- 正式 Rust 签名是 `VfsFullIndexingService::recover_stuck_indexing(db: &VfsDatabase) -> VfsResult<usize>`；
  owner 提取拿到连接后的 SQL/日志部分，连接获取错误仍归 L12。两个 OCR 写点是内联
  `conn.execute(...) -> rusqlite::Result<usize>`，不是已有 Rust 命名函数；TS 按消费者需要返回 void。
- 生产服务测试：`tests/indexing-owner-writes.test.ts`，真实迁移 SQLite、实际 kernel provider、独占
  异步事务连接与主连接不可见性、回滚、完整行快照和真实 logger。属于源码分支回归，未改
  TESTMAP 原158条去向（pending 0→0），不冒充新增 Rust 测试移植或 Rust 动态差分。

## PDF 预渲染配置面

- `pdf_preview.rs:19–55` 的 `PdfPreviewConfig::default`（150 DPI、最多 50 页、目标宽 1200、最大高 1600、JPEG 质量 75、启用压缩）迁移为 `repository/pdf-preview.ts` 的 `DEFAULT_PDF_PREVIEW_CONFIG`；原测试 `test_pdf_preview_config_default` 移植到 `tests/pdf-preview.test.ts`。
- `render_pdf_preview*` 依赖 pdfium 原生渲染，Host 运行时不可用；`PdfPreviewRenderer` 仅声明注入适配器接口，实际渲染由调用方（媒体/文档 lane）提供，不在本 lane 伪造实现。

## 向量维度与索引 profile

- `embedding_dim_repo.rs:15–1317` 全部迁移到 `repository/embedding-dims.ts`：维度注册/模型绑定（含 transport-aware `sha256:` 指纹、URL 凭据/查询参数剥离）、profile 生成与复用、`register` 的 COALESCE 绑定保留、绑定守卫、profile 状态机（active/building/queryable/retired）、ANN 状态、计数增减、级联删除（Lance 孤儿入队 + 全部历史表名收集 + unit 指针清理）、indexing unit 检测、模型解绑与计数刷新。
- 模型指纹格式、profile id 哈希、Lance 表名（含 16 位指纹后缀）与 Rust 逐字节一致；`refresh_counts_from_segments` 的可见性账本条件（unit profile + generation）保持一致。
- 原 9 个测试移植到 `tests/embedding-dims.test.ts`；`endpoint_change_rolls_profile_without_hashing_secrets` 使用等价 `EmbeddingModelConfig` 结构，凭据/headers 不参与指纹。

## 索引 Segment

- `index_segment_repo.rs:35–747` 全部迁移到 `repository/index-segments.ts`：segment 创建（unit profile/generation 优先，缺失时按归一化 modality 回退 dims active profile）、批量创建（单 SAVEPOINT + unit/dims 双缓存）、按 id/unit/modality 查询、裸删除默认入 `__lance_orphan_queue`、`*_unsafe` 不入队、按资源+模态删除、`replace_by_unit_and_modality` 的保留行撤销删除意图/淘汰行入队、按 lance_row_id/id 删除、计数与分布、Lance 期望行数对账与孤儿积压计数。
- `image` modality 在查询 dims/profile 前统一归一化为 `multimodal`；segment id 为 `seg_` + nanoid(10)，时间戳为毫秒整数。
- 原 4 个测试移植到 `tests/index-segments.test.ts`。

## 索引 Unit

- `index_unit_repo.rs:8–1104` 迁移到 `repository/index-units.ts`：unit 创建（文本非空/图片存在决定 required 与 pending/disabled、`sha256(image||'|'||text)` 内容哈希）、查询/更新（含 profile/generation）、`set_index_profile` 的可写 profile 校验、删除（默认 Lance 孤儿入队）/unsafe 变体、按资源 purge/sweep、文本与多模态状态机、待办列表、统计、批量创建、`sync_units`（按 content_hash 增量、变化侧立即失效旧 segment/profile、删除缺失 unit 并入队）、`sync_multimodal_units`（保留文本侧、页面消失仅禁用多模态侧）与 `clear_multimodal_index`。
- `IndexState::from_str` 未知值告警并降级为 `disabled`；generation 单调不清零。
- 原 6 个测试移植到 `tests/index-units.test.ts`。

## 向量维度门面、索引状态与索引配置

- `embedding_repo.rs:16–1077` 迁移到 `repository/embedding-repo.ts`：`VfsDimensionRepo`（注册返回 Lance 表名、按维度查询/列出、record_count 更新、模型绑定委托 `embedding_dim_repo`）、`VfsIndexStateRepo`（文本/多模态状态读取与写入、mark_* 便捷方法、指数退避失败、配置错误复活、分页 PDF 一次性重排、pending/disabled 查询、原子 claim、reindex 检测）与 `VfsIndexingConfigRepo`（完整键校验、布尔/整数/浮点读取）。
- 索引状态写入不触碰业务 `updated_at`；`pending/indexed/disabled` 清零重试计数与下次重试时间；failed 退避为 `min(5 * 2^clamp(retry,0,10), 3600)` 秒。
- 原 6 个测试移植到 `tests/embedding-repo.test.ts`。

## 音视频字幕段与播放进度

- `media_transcript_repo.rs:19–551` 迁移到 `repository/media-transcripts.ts`：段列表/时间窗相交查询/未完成段、计数（pending = total - done - failed）、计划信息（`MAX(plan_version), MIN(source) HAVING COUNT(*) > 0`）、`apply_plan`（无计划 Created；来源为 `import` 或段数偏差 ≤ 20% 时 Reused；否则整表重建且版本 +1）、带 `plan_version` 守卫的完成/失败写入、完成时可选边界收紧（新边界必须落在原段内）、失败段重置、字幕导入整体替换（SAVEPOINT，`source='import'`、全部 done、版本 +1）、删除段。
- WP-100（D1-L18-M02）：播放进度 `media_transcript_repo.rs:454-535` 内部全程 i64。`getProgressExact`/`setProgressExact` 以 safeIntegers 读六列（`duration_ms` 可空，非 INTEGER 抛 rusqlite `Invalid column type <Kind> at index: N, name: <col>`），position `max(0)`、duration 仅 `>0` 覆盖、delta 夹 0..=120000、`saturating_add` 上限 i64::MAX、自动看完按 `position as f64 >= duration as f64 * 0.95`，bigint 绑定写回。`getProgress`/`setProgress` 走同一精确读写，仅返回值按 D3 `Number(bigint)` 投影（与 Rust serde_json→前端 JSON.parse 同一舍入）；`MediaProgressUpdate` 与 `recordDuration` 增补接受 bigint。测试 `tests/media-transcripts.test.ts`「WP-100 media_progress i64」。
- 播放进度：缺省位置/时长保留原值，观看增量截断到 `[0, 120s]` 后累加，位置 ≥ 95% 自动看完，已看完保持；`record_duration` 仅记录时长且冲突时不更新 `updated_at`。时间戳为毫秒整数。
- 原 5 个测试移植到 `tests/media-transcripts.test.ts`。

## 番茄钟记录与统计

- `pomodoro_repo.rs:15–1076` 迁移到 `repository/pomodoros.ts`：记录创建/软删（SAVEPOINT、UTC 毫秒时间戳、`updated_at = created_at`、`local_version+1`）、完成 work 记录时按事实表重算 `todo_items.completed_pomodoros`（`IS NOT` guard 保证幂等且不产生 LWW 噪声）、单条/按任务/今日/日期区间查询、今日统计（四项标量查询失败回退 0 并记录 error 日志）、按本地日专注秒数、近 N 天日聚合、连续天数、按本地小时聚合、按任务聚合（LEFT JOIN 不过滤软删任务）、统计总览（daily 派生 weekly，周一为起点）与单任务专注历史。
- 本地日界统一使用本地午夜转 UTC 毫秒字符串；日期参数严格 `YYYY-MM-DD`，闭区间上界取次日 00:00；分桶时间戳无法解析时跳过并告警。
- 原 10 个测试移植到 `tests/pomodoros.test.ts`。
- **S04/TD-02 表所有者入口**：`recomputeCompletedPomodorosForSyncBatch(conn, changedTables)` 对应 `dstu-sync/.../pomodoro_counts.rs:72-145`。调用方在同步 apply 的 `BEGIN IMMEDIATE` 内、所有单条 SAVEPOINT 之后、提交之前，用同一事务执行器调用；传入本批表名（含 `pomodoro_records` / `todo_items` 才重算）。实现按未软删 `work` + `completed` 事实重算全部 todo、空集合归零、`IS NOT` 防空转、不改 `updated_at`/`local_version`，并只抑制 `id > pre_log_max` 且 `sync_version = 0` 的 `todo_items` 回声日志；`pre_log_max` 用 bigint 读取以保留 i64 精度。库形状探测对应 `sync/mod.rs:8147-8159`：缺表/缺列以及 PRAGMA prepare/query 失败都返回 false 并静默跳过（R11-06）；两条真实 UPDATE 失败仍转换为 `VFS_STORAGE` 传播。`tests/sync-pomodoro-counts.test.ts` 覆盖口径、NULL/漂移归正、软删 todo、幂等、i64 边界、缺表守卫、探测失败与 UPDATE 失败对照。

## 教材仓库

- `textbook_repo.rs:22–2050` 迁移到 `repository/textbooks.ts`：按 sha256 去重与软删恢复、创建（resources + files 两表 SAVEPOINT、PDF 预处理状态/readyModes、扩展名推断 type/mime）、复制（共享 blob 引用 +1、复制 preview/extracted_text/page_count、sha256 副本后缀）、查询/搜索/列表、阅读进度/页数/重命名/收藏/书签、基于 `updated_at` 的 OCC 书签与高亮替换（冲突 key `textbooks.annotations_conflict`，高亮写入 resource metadata.extra.highlights，512 KiB 上限）、软删/恢复（同步恢复 folder_items）、补存 blob、永久删除（文件级/页级原始与压缩 blob 引用递减、索引产物清理、folder_items 清理）、回收站列表与批量清除、文件夹内创建/删除/清除/列表、ResourceLocation、OCR 页存取、多模态索引元数据与状态（已废弃接口仍保留）。
- 保留 Rust 行为：教材 ID 为 `file_` 前缀但回收站查询只匹配 `tb_%`；`purge` 按 `item_id` 删除 folder_items 不区分类型；`rename_textbook` 同时更新 `file_name` 与 `name`。
- 原 6 个测试移植到 `tests/textbooks.test.ts`。

## 翻译仓库

- `translation_repo.rs:26–1207` 迁移到 `repository/translations.ts`：完整/轻量列表（前者 JOIN resources 并按标题或正文搜索，后者只搜标题且不加载正文）、普通读取过滤软删与含软删读取、正文读取（仅 `resources.data`，空串视为无）、创建（SAVEPOINT + 以 `translation_id` 为盐的内容哈希 + `resources`/`translations` 两表写入 + `local_version=1`）、旧版创建别名、收藏/评分/标题更新（评分 1–5 校验、软删不可改、同步 bump `local_version`/`device_id`）、软删（级联软删除 `folder_items`，幂等）、恢复（级联恢复 `folder_items`）、永久删除（先删 `folder_items`，仅最后一个引用者删除资源并清理索引产物）、内容更新（独占资源就地刷新 data/hash/`index_state='pending'`/重试计数；共享资源写时复制切换指针）、回收站列表、文件夹内创建/删除/按文件夹列表与 `ResourceLocation` 查询。
- 保留 Rust 行为：搜索不做 trim；共享计数包含已软删翻译；创建内容 JSON 为 `{"source":...,"translated":...}`；时间戳为 UTC 毫秒 ISO 字符串。
- 同步列身份：插件 `apply` 只调用 F4 正式底层入口 `ctx.paths.dataSpaceDeviceId()` 解析一次持久设备身份（`DEVICE_ID` env → 主 `.device_id` → 旧路径命中迁移 → 生成并原子持久化；对应 Rust `translation_repo.rs:65-70` 调用的 `dstu-storage/src/data_space/device_id.rs::get_device_id`），注入 `TranslationRepo` 构造；所有 translations / folder_items 写路径写同一身份，保持 Rust `OnceLock` 缓存语义。main 尚未合入 F4 候选（`d85995b4b`），该分支处于待集成状态；**不得回退** legacy-root-first `deviceId()`（旧 root 与 env 并存时身份不同），也不复制身份解析/规范化/临时缓存。`tests/support/paths-service.ts` 同时提供两个入口，`tests/device-identity.test.ts` 用两个不同身份验证生产 `index.ts` 只取 `dataSpaceDeviceId()`。
- 原 5 个测试移植到 `tests/translations.test.ts`；另加 `sync_column_mutations_use_persisted_device_id` 验证同一身份贯穿 mutations。R11-01 的 env/primary/legacy 真实文件分支由 F4 身份测试证明，L11 此处的调用面测试不等于 F4/main 已完成集成。

## 复习计划仓库

- `review_plan_repo.rs:1–1190` 迁移到 `repository/review-plans.ts`：SM-2 计划创建（题目唯一性检查、默认易度因子 2.5、本地日期作为首次复习日）、按 ID/题目查询、到期复习筛选（截止日期、排除暂停、题目集/状态/困难题过滤、分页与 `has_more`）、按题目集列表、带 `updated_at` OCC 的更新/暂停/恢复/删除（冲突 key `review_plan.updated_at`）、恢复状态推导、按题目删除、复习历史记录与查询、统计（全局参数绑定、`SUM` 空值回退、平均正确率/易度因子）、`review_stats` upsert 与日历热力图聚合。
- 时间戳使用 UTC 毫秒 ISO 字符串；日期边界使用本地日期 `YYYY-MM-DD`；计划 ID `rp_`、历史 ID `rh_` 均为 nanoid(10)。
- 原 1 个测试移植到 `tests/review-plans.test.ts`。

## 作文仓库

- `essay_repo.rs:1–1590` 迁移到 `repository/essays.ts`：作文列表/搜索（标题或 resources.data）、按会话与轮次查询、内容读取、创建（入口 `BEGIN IMMEDIATE`、同 session+round 幂等返回、无盐资源复用、`resources.source_id` 回填、会话 `total_rounds`/`latest_score` 统计）、批改结果/标题更新、软删/恢复（恢复级联 folder_items）、永久删除（先删作文再删 folder_items，仅最后一个引用者清理资源与索引产物）、回收站列表、会话创建/查询/列表/计数/条件更新、会话软删/恢复/回收站列表、按会话轮次列表与分页、最新轮次、单轮查询、会话收藏切换、文件夹内作文/会话创建、删除级联 folder_items、按文件夹列出作文与 `ResourceLocation`。
- 保留 Rust 行为：`list_essays_by_folder` 不过滤作文/folder_items 的软删状态；`purge_session` 不检查会话是否存在；会话 `essay_type`/`grade_level` 序列化为空字符串而非省略。
- 原 1 个测试移植到 `tests/essays.test.ts`。

## 题目集仓库

- `exam_repo.rs:1–2178` 迁移到 `repository/exams.ts`：题目集列表/计数/搜索（按 `exam_name` LIKE）、按 ID 读取与内容读取、创建（`SAVEPOINT create_exam`、预览 JSON 存入 `resources`、回填 `source_id`、可选 folder item）、复制（`SAVEPOINT copy_exam`、页图/题图 blob 引用 +1、`(副本)` 名称、题组/材料/来源复制与引用重映射、题目逐条复制并重建父子关系、刷新 canonical preview 与题库统计）、旧版创建、按 ID/temp_id upsert、错题关联、重命名、收藏、状态更新、软删除（`deletion_batch` + 级联 questions/qbank 表/练习尝试/folder_items）、永久删除（保存点、回收 review/sync/question 子表、仅在无其他引用时删除 resource、按 `retains_asset` 递减页图/题图 blob 并在事务后清扫）、恢复（按 batch 或 deleted_at 恢复题目集/题目/qbank 实体）、回收站与全量列表、preview 更新与 OCC 版本、导入断点状态读写、文件夹内创建/删除/列表、`ResourceLocation`、页级 OCR 读写、多模态索引状态与元数据。
- `qbank_helpers.rs` 的 `retains_asset`、`refresh_canonical_preview_with_conn`、`copy_authoring_entities`、`remap_entity_references` 在本文件内本地移植，不跨插件导入。
- 保留 Rust 行为：`purge` 先收集 blob 哈希再删行；题图收集包含软删题目；`folder_items` 删除不区分软删；恢复时 batch 为 NULL 则 qbank 表不恢复；`refresh_canonical_preview` 缺 `blob_hash` 时报错并回滚复制；`update_preview_json` 同步更新 resource 内容。
- 多模态业务表状态发布 `applyMultimodalIndexState(conn, examId, state, payload, embeddingDim)`：`indexed` 同时写 `mm_indexed_pages_json/mm_embedding_dim/mm_indexed_at/updated_at`，`failed` 写 `mm_index_error/updated_at`，其他只写 state/updated_at，对应 `multimodal_service.rs:1645-1658`；`resources` 侧仍由 L12 调用 `indexStates.setMmIndexState/markMmFailed`。
- 原 3 个测试移植到 `tests/exams.test.ts`；`pdf-owner-writes.test.ts` 覆盖 exam mm 三分支与 `mm_indexed_at == updated_at`。

## 附件仓库

- `attachment_repo.rs:1–3305` 迁移到 `repository/attachments.ts`：Base64/Data URL 解码（解码前预算上限）、类型/大小/压缩包魔数校验、文件名/MIME 推断、SHA-256、原始路径安全判定（canonicalize + slot/textbooks 白名单、symlink 逃逸拒绝）、跨平台 slot 相对路径重映射、有界文件读取、附件查询/列表/哈希去重/内容来源（inline resource、blob、original_path 回退与同步别名）、收藏、软删/恢复/回收站/批量永久删除、附件与 PDF 页图 blob 引用递减、资源与索引产物清理、页级 OCR 与已废弃多模态索引字段、上传（inline <1MB / external、并发 INSERT OR IGNORE、已删附件自动恢复重命名、PDF 处理状态、ZIP 清单、pptx/epub 页级文本、文件夹挂载、SQLITE_BUSY 4 次重试与 80ms 指数退避）、音视频流式导入（staged blob + 同事务 finalize）。
- `AttachmentProcessingAdapter` 注入 PDF 加密检测/渲染与文档文本提取；本 lane 未接线原生 pdfium/DocumentParser，PDF 上传会显式报 `VFS_INTERNAL`，非 PDF 文档在未注入适配器时跳过文本提取（已记录为跨 lane 缺口）。ZIP 清单在无适配器时使用 `host/platform/util` 的 `readZip` 读取中央目录。
- 原 21 个测试移植到 `tests/attachments.test.ts`。

## 知识导图仓库

- `mindmap_repo.rs:1–2051` 迁移到 `repository/mindmaps.ts`：内容规范化（裸根节点包装、`version`/`meta.createdAt` 修复、根节点补全、节点 ID 唯一化、`text` 回退链 `name/label/title/value/content`、`note` 非字符串归零、`children` 非数组归零、深度 100/节点 10000 上限）、创建（`SAVEPOINT vfs_mindmap_create_tx`、空标题回退“无标题导图”、资源去重）、文件夹内创建（`BEGIN IMMEDIATE` + folder item）、更新（`BEGIN IMMEDIATE`、OCC 基线为 `content_updated_at` 或 `updated_at`、`next_timestamp_after` 严格递增、共享资源写时复制、内容变化才推进 `content_updated_at`）、收藏（不推进 `updated_at`）、软删除/恢复（folder_items 级联、恢复后标记重新索引）、永久删除（保存点、版本资源先收集后删除、孤儿资源与索引产物清理）、回收站分页/批量永久删除、版本快照（30 分钟 manual/auto/NULL 合并窗口、`chat%`/`pre_chat_backup`/`restore_backup` 不合并、非 chat 版本保留 20 条并回收孤儿资源）、版本查询/分页/内容读取、版本恢复（`restore_backup` fail-closed、共享资源 COW、内容相同 no-op、双时间戳推进）。
- 保留 Rust 行为：`count_active_mindmaps_by_resource_id` 计入软删除导图；`set_favorite` 不推进 `updated_at`；`purge_mindmap` 对不存在的 ID 静默成功；`purge_deleted_mindmaps` 单保存点包裹全部删除；`restore_version` 的 no-op 仍会标记资源待重新索引。
- Rust 已知缺陷（按原样移植，未修复）：版本快照通过 `create_or_reuse_with_conn` 按 hash 去重，旧内容与主资源相同时会复用主资源；随后原地更新会把该快照内容一并改写。类似地，`restore_backup` 复用主资源后也会被恢复写入覆盖；且目标内容 hash 被版本资源占用时主资源会退避为加盐 hash，导致“内容相同 no-op”判断失效。`tests/mindmaps.test.ts` 用断言记录了这些行为。
- 数字型节点 `text` 的回退格式化使用 JS `String(number)`；Rust `serde_json` 开启 `arbitrary_precision`，会保留原始数字字面量（如 `1.0`），此处存在已记录的表示差异。
- `mindmap_repo.rs` 无 Rust 单元测试，本 lane 新增 18 个行为测试到 `tests/mindmaps.test.ts`。

## 跨线程执行入口（R13-02）

- 发布 `ctx.vfsWorker`：`runTodoOperation`、`runPomodoroOperation`、`runResourceSearch`、`workerThreadId`、`pauseAndDrain`、`resume`、`dispose`。todo/pomodoro 由持久 worker 顺序执行，搜索每次启动短生命周期 worker 以保留 Rust `spawn_blocking` 的并行语义。
- worker 内用 F3 `SqliteDatabase` + `PROFILES.vfs` 打开自己的连接，再调用现有生产仓储；主线程 `DatabaseHandle` 不跨线程传递，也没有同步 Promise 包装。成功值 structured clone；失败保留 `name/message/code/data/stack` 并重建 `VfsRepositoryError`。
- 维护接缝：`pauseAndDrain(timeoutMs)` 先拒绝新操作，再等待已准入请求、pending 响应与全部短寿命 worker；超时则拒绝在途 Promise、终止 worker 并抛错。准入计数保持到请求真正结束，避免“worker 已就绪但请求尚未登记”时被排空关闭连接。`resume` 后下一次请求重新打开连接。
- **F3 维护参与者注册**：以 `vfs-worker`、`databases:['vfs']` 注册；enter await pauseAndDrain，失败自行resume后抛出，exit同步resume，卸载先unregister再dispose。本候选`513aac879`为直接注册清理；固定main`fd925aa05`虽仍为条件注册，真实F3已使该分支生效。R3 `f9e10ed4c` / ACCEPTANCE§11已独立签收原R11-05，不因清理候选未合入重新列功能阻塞。
- 日志：`worker-entry.ts` 调用 `setRepositoryLogger`，将 worker 内仓储的 error/warn/info/debug 经 `parentPort` 回传，主线程转发到 `ctx.logger('dstu_vfs::repos')`；转发失败只 warn，不改变任务结果。
- 120s 超时只拒绝调用方 Promise，不取消底层操作；持久 worker 上的操作可能继续写入，短寿命搜索 worker 超时后保持运行并继续被维护排空跟踪，直到退出或被 `pauseAndDrain`/`dispose` 终止。错误文案明确 `may still be running ... not cancelled`。
- 只允许 `TodoRepo`/`PomodoroRepo` 原型方法；命令层校验、`CommandError` 映射和提交后事件仍在主线程。note 搜索由 L10 发布，不在本入口范围；exam/translation/essay 三类搜索已可用。
- `tests/worker-service.test.ts` 断言真实 threadId 不同、跨线程写入可见、pomodoro 派生计数、短生命周期搜索、业务错误原样返回、`pauseAndDrain` 等待已准入请求/拒绝新请求/`resume` 恢复、短寿命搜索排空跟踪、worker warn 日志回传与 dispose 行为。`tests/maintenance-registration.test.ts` 用已发布 F3 签名的最小注册替身走生产 `index.ts`，断言 `vfs-worker`/`vfs` 注册、在途排空、新请求拒绝、exit 恢复、enter 失败自行恢复与卸载撤销；该替身不复制 F3 的 storage 维护屏障，不能替代真实组合验证。

## 接线、日志与平台依赖

- 服务名按 `docs/plugins/ARCHITECTURE.md` 附录 A 改为 `vfsRepo`（`vfsRepoService = { name: 'vfsRepo', version: '1.0.0' }`）；`index.ts` 的 `meta.provides` 与 `super(ctx, 'vfsRepo')` 同步。
- `index.ts` 只做接线：只注入 `storage`；notes 自身注入 `vfsRepo`，若本插件在 `inject` 中声明 `notes` 会形成循环注入，因此只在文件夹级联实际调用时 `ctx.get('notes')`，缺失时显式报错。`FolderRepo` 的级联适配器接到本 lane 的 `files`/`exams`/`translations`/`essays`/`mindmaps`，note 类型经 `notes.repository` 的真实 `deleteNote`/`restoreNote`/`purgeNote`（与 Rust `delete_note_with_conn`/`restore_note_with_conn`/`purge_note_with_conn` 对应），不再直接写 `notes` 表。测试通过 `tests/support/notes-service.ts` 提供 notes 替身（`kernel/testing.ts` 允许的唯一替身位置）。
- 仓储日志经 `repository/logger.ts` 的 `logWarn`/`logError`/`logInfo`/`logDebug` 输出，`index.ts` 注入 `ctx.logger('dstu_vfs::repos')`；测试直接构造仓储时使用静默 sink。本轮抽检发现的 Rust `warn!`/`error!` 缺失位置已补齐（文件/问题/附件/题库/嵌入配置等），`catch` 不再静默吞掉。
- 时间格式统一走 `host/platform/time`：`blob_repo`、`exam_repo::copy_authoring_entities`、`question_repo`、`review_plan_repo` 的 `to_rfc3339()` 用 `toRfc3339()`；其余 `%Y-%m-%dT%H:%M:%S%.3fZ` 列用 `toRfc3339Opts(..., 'Millis', true)`；解析用 `parseRfc3339`/`parseNaiveDateTime`。`repository/timestamps.ts` 只保留平台函数的薄封装。
- ZIP 读写与 Rust `trim`/UTF-8 工具统一走 `host/platform/util`；本 lane 不再保留手写中央目录解析或 trim 副本。
- 超大文件按职责拆分：`api.ts` 曾达 1328 行，现为 16 行 barrel，按职责转出到 `types/common.ts`（错误/JSON）、`types/core.ts`（路径缓存/别名/待办/文件夹/blob）、`types/content.ts`（教材/番茄钟/附件/导图/题目集/作文/复习/翻译/媒体）、`types/indexing.ts`（嵌入维度/索引状态与配置/unit/segment）、`types/files.ts`（文件/资源/PDF 写入口）、`types/questions.ts`（题库 wire 类型与 `QuestionRepository`）、`types/services.ts`（维护/服务描述符/worker/`Context` 增强）；各文件均低于 800 行。附件独立辅助函数在 `repository/attachment-utils.ts`，待办常量/行解析在 `repository/todo-utils.ts`，统计查询在 `repository/todo-queries.ts`。
- 可擦除语法：本 lane 不使用构造函数参数属性、`enum` 或带实现的 `namespace`；`AttachmentRepo` 改为显式字段声明 + 构造函数赋值。`migration:boundaries:strict` 的 `erasable-syntax` 对本 lane 为 0，`importable.mjs host/plugins/vfs-repos/index.ts` 返回 `importable: ok`。
- 自动反馈中列出的 `rfc3339Offset`/`nowIso`/`rfc3339Millis`/`parseRfc3339`/`rustTrim` 本地副本已在本分支删除并改用平台模块；main 上的旧副本会在协调者合入本分支后消失。

## 仍待接线 / 阻塞

- `QuestionRepo.updateQuestion` / `submitAnswer` 已按 `question_repo.rs:2344–2609` 完整实现：OCC 条件直接写进 `UPDATE ... WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`，冲突时记录 `warn!` 并抛 `VFS_INTERNAL` + `QBANK_CONFLICT: expected_updated_at=..., actual_updated_at=...`；写入后执行 `mark_as_modified`（`sync_status` CASE）与 `update_content_hash`（`question_sync_service.rs:471–517` 的 SHA-256 字段顺序），再失效题目集资源索引。两个 Rust OCC 测试已移植到 `tests/questions.test.ts`（`update_question_occ_is_atomic_and_rejects_stale_writes`、`concurrent_question_updates_allow_exactly_one_occ_winner`），`TESTMAP` 无 `pending`。这两个同步副作用只写本 lane 拥有的 `questions` 列，因此不依赖 qbank 的连接绑定接口；`qbank.questionSync.*` 仍未发布，但不再是本 lane 的阻塞项。
- 附件 PDF 上传/修复：`AttachmentProcessingAdapter` 需要 F7 提供的 pdfium 渲染与文档文本提取；未注入时 PDF 上传按 Rust 语义显式报 `VFS_INTERNAL`，非 PDF 文档跳过文本提取。ZIP 清单已改用 `host/platform/util` 的 `readZip`（与 Rust `zip 0.6` 的中央目录解析/名称解码/目录判定对齐）。
- `pdf_preview.rs` 的 `render_pdf_preview` 依赖 pdfium，本 lane 只迁移了配置与 `PdfPreviewResult` 形状；渲染入口待 F7。
- **F3 维护参与者原组合阻塞已解除**：R3在真实main`fd925aa05`以F3+notes/repos和真实worker验证维护/日志，`20261104163651-79f860` exit0；不再要求重复原R11-05测试。消费者是否覆盖各命令的spawn_blocking语义仍按R13-02独立验收，不由本项签收自动关闭。
- **F4 deviceId 集成已签收**：`index.ts` 只调正式 `ctx.paths.dataSpaceDeviceId()`（env → primary → legacy），不改用旧root优先入口、不复制解析器。R3已在正常main验证真实F4与L11写入/缓存并关闭原R11-01（ACCEPTANCE§8）；旧“待F4合入”不再是当前阻塞。
- L12 PDF/多模态消费方仍可直接写 `files`/`resources`/`exam_sheets`；L11 已发布 `updatePdf*`、`saveOcrTextForFile`、`applyProcessingStatus`、`applyMultimodalIndexState` 等窄业务方法，接线清单与时间戳差异见 `BLOCKERS.md`。L12 删除本地 SQL 后，读者可把“repository 目录内 SQL”与表所有者写入口区分开。
- 本 lane 发布三个服务：`vfsRepo`（`api.ts:vfsRepoService`、`index.ts:super(ctx, vfsRepoService.name)`）、表所有者维护服务 `vfsMaintenance`（`api.ts:vfsMaintenanceService`、`index.ts:src/maintenance-service.ts`）与跨线程执行服务 `vfsWorker`（`api.ts:vfsWorkerService`、`index.ts:src/worker-service.ts`），`meta.provides` 同步列出三者；不再发布 `vfs.repo.core@1`。
- `vfsMaintenance` 的公开方法（无连接参数，提供方内部取 `vfs` 句柄与 blob 目录）：
  `createTodoSubtasks`、`resetDisabledToPending`、`resetIndexedWithoutEmbeddings`、`resetAllIndexStateRows`、`clearMediaCache`、`clearResourceOcr`、`getResourcePath`、`updatePathCache`、
  `resetRebuildableIndex(targetDir)`（L21/L12 恢复槽派生索引重置，见下节）。
  提供方优先调用已注入的 `vfsDatabase.getConnSafe()/blobsDir()`，未安装该服务时回退 `storage.database('vfs')` 与 `join(storage.locations.activeDir, 'vfs_blobs')`，与 `VfsDatabaseImpl` 的目录计算一致；因此只注入 `storage` 的测试和最小 profile 也能解析服务。
- `vfsMaintenance` 暂不在本 lane 的 `api.ts` 里 `declare module` 扩展 `Context`：L13b 的 `src/maintenance-needs.ts` 已用完整交接接口声明同名属性，声明合并要求属性类型完全一致；等协调者拆分该临时接口后由本 lane 接管本子集声明。
- 全仓消费者已由协调者在 main 同步到新名：`qbank/index.ts` 用 `ctx.get('vfsRepo')?.exams`、`llm/index.ts` inject `vfsRepo` 并取 `.essays`、`review/src/review-plan-commands.ts` 用 `ctx.get('vfsRepo')`、`vfs-handlers` inject `vfsRepo`。其他 lane 的 SPEC/native-needs 与少量注释仍写旧名（文档残留，不影响运行时）；本 lane 生产代码与 `api.ts` 声明无旧名。
- L13b（`host/plugins/vfs-handlers`）仍直接写本 lane 的部分表；按单写者原则应改调本 lane 已发布的仓储方法。普通 CRUD 映射均已发布：`resources.createOrReuse/getResource/updateResourceData`、`translations.createTranslation/createTranslationInFolder/setFavorite/setQualityRating`、`essays.createSession/createSessionInFolder/updateSession`、`exams.createExamSheet/createExamSheetInFolder/updatePreviewJson`、`mindmaps.normalizeContent/createMindmap/createMindmapInFolder/countActiveMindmapsByResourceId/updateMindmap`、`blobs.storeBlob`、`files.createFile/createFileInFolder`、`folders.createFolder/setFolderExpanded/renameFolderIfVersion/moveFolder/addItemToFolder/removeItemFromFolder/moveItemToFolder/moveItemByItemId/reorderFolders/reorderItems/deleteFolder`。
- L13b 的表所有者维护写操作（`handlers.rs`/`todo_handlers.rs`）已在本 lane 新增 `VfsReposService.maintenance`（`repository/maintenance.ts`，连接绑定、保留 Rust 顺序与忽略错误位置）：
  - `getResourcePath` / `updatePathCache`：`handlers.rs:1044-1304`；1000 **UTF-8 字节**上限、`cached_path` 命中直接返回、未挂文件夹只返回 `/{title}`；标题前缀分支照 Rust：只有 `tb_` 查 `files.file_name`，`file_`（含本 lane 教材 ID）落默认分支回退为 `source_id`，`tests/maintenance.test.ts` 的 `resource title follows Rust prefix branches for file and tb` 固定该语义；`updatePathCache` 先校验 `fld_` 前缀（非法时抛 `Invalid argument 'folder_id': Invalid folder ID format: ...`），再自持 `BEGIN/COMMIT/ROLLBACK`；内部错误按 Rust 顺序 rollback（失败仅 warn）后以 error 级记录并原样抛出。
  - `resetDisabledToPending` / `resetIndexedWithoutEmbeddings`：`handlers.rs:5855-5917`，保留 retry/backoff 清零与 Unit+Segment 存在性条件。
  - `resetAllIndexStateRows`：`handlers.rs:5923-6020` 的 SQLite 部分，按 segments → units → dims → resources → files → exam_sheets 顺序；Lance 清理由调用方先做。
  - `clearMediaCache`：`handlers.rs:6976-7309` 的 SQLite/blob 部分（preview/compressed/OCR/vector/readyModes）。向量分支新增可选 `beforeVectorClear(lanceDir)` 文件阶段，严格在 OCR 之后、`DELETE vfs_index_segments/units` 之前调用，对齐 `handlers.rs:7161-7178`；回调由 L12/命令层提供，返回 `{existed, removed, bytesFreed}`，成功后累计 `vectorIndexCleared` 与 `totalBytesFreed`，目录存在但删除失败（或抛错）时 warn 后继续 SQL。回调缺失时保持原“文件阶段不在 L11”行为，L13b 必须传入，不能把目录删除挪到方法前后。Rust 用 `let _ =`/`unwrap_or(0)` 忽略的 decrement、清缓存、计数与 blob 清扫失败不使命令失败，按边界规则在 warn 级留痕。
  - `clearResourceOcr`：`handlers.rs:7793-7827`；`mark_pending` 仍由命令层 best-effort 执行（Rust 在该失败点记 warn）。
  - `createTodoSubtasks`：`todo_handlers.rs:1099-1140` 的落库部分，单 `SAVEPOINT todo_ai_breakdown`，优先级 `none`、`parent_id` 指向被拆解任务。
  - 测试：`tests/maintenance.test.ts` 共 17 个测试，覆盖仓储分支、回滚、真实 provider 无连接委托，以及 `clearMediaCache` 的向量文件阶段顺序/字节累计/失败 warn 回归。
- 仍不属于本 lane 的交接方法：`resetUnitIndex`、`deleteResourceIndex`（Unit/Segment/维度计数/Lance，按分工归 L12）与 `setAttachmentRootFolderId`/`createAttachmentRootFolder`/`getOrCreateAttachmentRootFolder`（`attachment_config.rs` 写 `memory_config`，该表属 L17 memory）。附件配置应经 memory 服务或由协调者指定所有者，不在本 lane 直接写他表；L13b 在接入生产前需由协调者补齐这些方法的提供方。
- Rust 已知缺陷（按原样保留）：`handlers.rs:7193-7200` 的 `clear_media_cache` 向量分支引用 `resources.vector_indexed_at`，但 vfs 迁移从未创建该列；SQLite 上该分支在 Lance 文件阶段、已删除 segments/units、清零 `record_count` 后必然报 `no such column`。`tests/maintenance.test.ts` 用断言记录文件目录已删除、SQL 前半生效 + 随后失败的顺序；未修复。

## 验收问题处理（R3 ACCEPTANCE 逐条）

- **R11-01（身份，已闭合）**：main `081b3426d` 已正式提供
  `ctx.paths.dataSpaceDeviceId()`（env → primary → legacy 规范化 + 原子持久化）；
  `index.ts` 只调用该正式方法，已删除 `918b252fd` 的能力探测与 legacy-root-first
  `deviceId()` 回退，也不复制 F4 解析器/临时缓存。作业 `20261104092703-363010` 在
  main 的 `paths` 上跑通 `device-id.test.ts` 6 例（env/primary/legacy/生成持久化/
  旧包装区分/logger）、L11 `device-identity.test.ts` 1 例与 `translations.test.ts`
  6 例，共 5 文件 / 43 测试、退出码 0、无 Errors。
- **R11-02（竞争测试）**：R3 已在 `f470e5c89` 分支复核通过，本轮不复改、不重跑。
- **R11-03（连接参数）**：按 main `decisions.md` D1/D4 裁定撤销原违规判定；本 lane 未批量改签名，
  也未新增任意 SQL 通道。
- **R11-04（全套运行证据）**：本 lane 全套经全局作业队列重跑（作业
  `20261104084231-139884`）：`30` 个测试文件 / `239` 个测试通过、退出码 0、无
  `onTaskUpdate`/unhandled errors；此为历史owner证据。R3 ACCEPTANCE§10后续已用正常main
  `bec9c35ba`、作业`20261104140723-05a526`（三插件77文件/656测试，L11为32文件/257测试）
  独立关闭原R11-04，不重复要求同项全套。
- **R11-05（worker 维护/日志）**：`src/worker-entry.ts` 已 `setRepositoryLogger` 并经 `parentPort`
  回传日志到主线程 `ctx.logger('dstu_vfs::repos')`；`src/worker-service.ts` 提供真实
  `pauseAndDrain`/`resume` 与短寿命 worker 排空跟踪；`index.ts` 按 F3 `registerMaintenanceParticipant`
  签名注册 `vfs-worker`/`vfs`，enter 排空、exit 同步恢复、卸载撤销。原05已由R3
  `f9e10ed4c` / ACCEPTANCE§11在main `fd925aa05`正式签收；strict作业
  `20261104163651-79f860` exit0，真实在途todo/短search排空、拒新借用、release后thread1→3及WARN均过。
  `513aac879`未入main不再构成原05功能阻塞。原R11组未决0，不等于整lane v2通过。
- **R11-06（形状探测容错）**：`tableHasColumn` 的 PRAGMA prepare/query 失败返回 false 并静默跳过，
  对应 `sync/mod.rs:8147-8159`；重算/清零两条业务 UPDATE 失败仍分别抛 `VFS_STORAGE`。
  R3 定向复核通过（`b169acd4c`），本轮不再重复。
- **R13-01.path-file（路径标题前缀）**：`repository/maintenance.ts` 的 `resourceTitle` 已删除
  `file` 分支，只有 `tb` 查 `files.file_name`，`file_` 落 Rust 默认分支回退 `source_id`。
  `tests/maintenance.test.ts` 新增 `resource title follows Rust prefix branches for file and tb`，
  并修正既有路径/缓存断言为 Rust 的 `/{folder}/file_<id>`。L13b `tests/paths.test.ts:71` 当前仍
  断言 `/教材.pdf`，需其同步改为 `/file_<id>`；本 lane 未修改他 lane 测试。
- **ACCEPTANCE 建议（日志）**：补回 Rust 的 info/debug 日志（`pomodoro_repo.rs:212,301` 的创建/
  删除、`resource_repo.rs:128,164,177,191,399,427,521,829,939` 的哈希/新建/复用/计数/清扫/更新/
  OCR），不改变业务行为。
- **ACCEPTANCE 建议（文档一致性）**：已删除 `SPEC.md` 中“其余仓储仍未迁移”“保持 pending”等与
  `TESTMAP.md` 158/158 `ported` 矛盾的自述。

## 恢复槽派生索引重置（L21/L12）

- 发布 `ctx.vfsMaintenance.resetRebuildableIndex(targetDir)`，对应
  `dstu-sync/src/data_governance/backup/mod.rs:2307 reset_rebuildable_vfs_index`。
  先删 `<targetDir>/databases/lance/vfs`（失败不继续 SQLite），再打开
  `<targetDir>/databases/vfs.db` 并在 `BEGIN IMMEDIATE` 内按 `PRAGMA table_info`
  只重置存在的列：segments 删除、units 文本/mm 状态按 required 回 pending/disabled、
  dims 计数/ann 归零、profiles 按 active_profile_id 标 active/retired、resources
  保留 disabled 其余 pending、files/exam_sheets 的 mm 三态、清空 orphan queue。
  仓储侧另有 `maintenance.resetRebuildableIndex(conn)` 供调用方在同一事务中复用。
- 文件阶段与 SQL 阶段顺序、失败语义见 `BLOCKERS.md`；L12 只负责调度与其它派生目录，
  L21 不再保留本地 VFS SQL。

## 附件 PDF 异步处理（F7/L18 接缝）

- `AttachmentProcessingAdapter.renderPdf` 改为 `Promise<PdfPreviewResult>`，生产组装在
  `src/attachment-processing.ts`：`nativePdfium.extractText/open/page/render` +
  `nativeImage.encode` 逐页渲染，照 `pdf_preview.rs` 的 JPEG/PNG、1200/1600、
  maxPages=50、截断与逐页 warn 语义；渲染失败只保留文本，不伪造预览。
- 加密检查经 L18 `docs.checkPdfEncryptionBytes`（DocumentParser）；CSV/纯文本/代码经
  F7 `nativeOfficeText`，epub 页级拆分经 L18 docs；docx/xlsx/pptx 等二进制解析仍未
  交付，按提取失败 warn 后入库。索引期 PDF 流水线仍归 L12，L11 不重复其 SQL。
- `tests/attachment-processing.test.ts` 走真实 `index.ts` 装配，断言上传 PDF 的
  preview/text/page_count/processing 状态与加密拒绝；另覆盖截断、form-feed、逐页失败、
  PNG 与适配器委派。

## 只读资源存活面（L16）

- 新增 `ctx.vfsRepo.resources.getLiveResource(conn, resourceId)`：仅
  `resources.deleted_at IS NULL` 时返回既有 `VfsResource` DTO，missing/软删返回 null；
  `getResource` 保持原“包含软删行”的查询与 wire 形状不变。对应
  `chatanki_executor.rs:10642-10653` 的 LEFT JOIN 存活判据；不按 source file 状态过滤。
- `tests/resources.test.ts` 覆盖 live/deleted/missing 与 source file deleted。

## 下游所有者接口登记（L18 / L04 / L13b / L14，2026-11-05）

均经 `api.ts`（`VfsReposService` 即 `ctx.vfsRepo`）发布，消费方不复制 SQL：

| 消费方 | 接口 | Rust 依据 | 测试（生产入口） |
|---|---|---|---|
| L18 textbooks_add、L13b、L04 | `vfsRepo.attachmentProcessing: AttachmentProcessingAdapter`；`renderPdf(conn, blobsDir, bytes, config?: PdfPreviewConfig, progress?: PdfRenderProgress): Promise<PdfPreviewResult>`，`PdfRenderProgress = (currentPage, totalPages) => void` | `pdf_preview.rs:82-225` `render_pdf_preview_with_progress`：每页渲染**前**回调 `(page_index+1, render_pages)`，`render_pages = min(total, max_pages, u16::MAX)`；非 PDF/加密输入不回调；`config` 缺省 = `PdfPreviewConfig::default()` | `tests/attachment-processing.test.ts`「renderPdf reports Rust per-page progress…」 |
| L18 textbooks_add | `vfsRepo.textbooks.updateTextbookOcrPagesJson(conn, textbookId, pagesJson): void` | `cmd/textbooks.rs:631-641`：仅 `ocr_pages_json`，不改 `updated_at`；调用方连接、0 行不报错；SQL 错误原样抛出，由调用方记 `[Textbooks] Failed to write ocr_pages_json for {id}: {e}` warn | `tests/textbooks.test.ts` |
| L18 textbooks_add | `vfsRepo.textbooks.markTextbookRenderError(conn, textbookId, renderError): void` | `cmd/textbooks.rs:644-654`：仅 `processing_status='error'` + `processing_error`（不写 `processing_completed_at`/`updated_at`）；SQL 错误原样抛出，调用方记 `[Textbooks] Failed to write render failure status for {id}: {e}` warn | `tests/textbooks.test.ts` |
| L04 stage_context_attachments | `vfsRepo.attachments.getInlineDataWithConn(conn, fileId): string \| null` | `attachment_stage_executor.rs:1350-1362` | `tests/attachments.test.ts` |
| L04 / L13b / L18 | `mediaKind(mimeType, fileName): VfsMediaKind \| null`、`AUDIO_EXTENSIONS`/`VIDEO_EXTENSIONS`/`isLinkItem`（`api.ts` 直接导出） | dstu-core `media_types.rs` | 先前已发布（附件上传路由在用），本批未改 |
| L13b | `DEFAULT_PDF_PREVIEW_CONFIG`、`type PdfPreviewConfig`/`PdfPreviewResult`（`api.ts`）；`files.setUploadOcrPagesWithConn` | `pdf_preview.rs:19-55`、`handlers.rs:2528-2537` | `tests/pdf-owner-writes.test.ts` |
| L14 resume_question_import | `vfsRepo.files.ensureFileForBlobWithConn(conn, blobHash, fileName, mime): string` | dstu-qbank `question_import_service.rs:3758-3812` | `tests/files.test.ts`「ensure_vfs_file_for_blob owner write」 |

`ensureFileForBlobWithConn` 逐分支：①`SELECT id FROM files WHERE blob_hash=?1 AND deleted_at IS NULL LIMIT 1` 命中即返回；查询 SQL 错误按 Rust `.optional().ok().flatten()` 视为未命中、无日志。②否则 `file_`+nanoid(12)、`%Y-%m-%dT%H:%M:%S%.3fZ`，插入时 sha256 写 blob_hash；同内容已被软删除的行改为恢复该行（`RF-W10-ensure-file-for-blob-sha256`，偏离 Rust：Rust 原文的 `INSERT OR IGNORE` 不写 sha256，永远不落行，却仍返回新 id）。③INSERT 错误原样抛出；`get_conn_safe` 失败与两条 warn、`None` 回退归调用方（L14）。
**已知 Rust 缺陷，按 Rust 原样保留（协调者 2026-11-05 裁定：严格对齐、不偏离）**：真实 schema 中 `files.sha256 TEXT NOT NULL UNIQUE`（`V20260130__init.sql:109`），`OR IGNORE` 同样吞掉 NOT NULL 冲突，所以在已迁移库上这条 INSERT 永远不落行，返回的 id 没有对应 files 行，每次调用都会生成新 id。测试按 Rust 实际行为断言这一点，并另用记录型连接核对列集/参数。若要修，属于 Rust 侧产品缺陷，需协调者决定，本 lane 不擅自偏离。

## 最新全量验证（2026-11-04）

- main `081b3426d` 合并后 typecheck 作业 `20261104092703-e74f09` → 退出码 0。
- 全 lane 测试作业 `20261104092941-6d1783`：31 个文件 / 252 个测试通过、退出码 0、
  无 Errors；覆盖 `resetRebuildableIndex`、异步 PDF 处理、`getLiveResource` 与既有仓储。
- 静态门禁：`importable: ok`、wiring ported 158 / 未接入 0、boundaries 本 lane 无
  未豁免违规、ledger check problems 0。详见 `BLOCKERS.md` 验证记录。
