# L10-notes 行为规格（`host/plugins/notes/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 81 个 · 发出事件 9 种 · 契约：`contracts/ipc/L10-notes.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### WP-174：租约清理 interval 的默认 Burst

- 生产链：`index.ts:114-115` 在启动重置后调用 `src/lease-lifecycle.ts::scheduleNoteEditorLeaseCleanup`；对应 `lib.rs:1347-1353` 的 `tokio::time::interval(5s)` 循环。tokio 1.49.0 `time/interval.rs:73-75,339-377,462-493`：起点为 Instant::now，首 tick 立即就绪；默认 Burst，每次只将原截止时间加一个 period（包括迟到 ≤5ms 的分支），不得重置为 now+period 或跳过过期 tick。
- 调度用单调时钟 `performance.now()`，固定 5000ms；迟到后按原截止次序逐个调用清理，直到追上当前单调时间，再等待下一个原始截止点。首轮仍异步立即运行，scope 卸载取消首轮与后续 timer。
- 每个 tick 继续走 `cleanupNoteEditorLeases`：`cmd/notes.rs:537-543` 每次执行时取 `NoteLeaseRepo::now()` 的墙钟纪元秒，不以调度截止时间替代 TTL。`note_lease_repo.rs:506-523` 的真实仓储保存点、参与者/租约删除及取消事件不变；本包无新 SQL、接口或数据解码。
- `cmd/notes.rs:545-552`：成功按仓储返回顺序发 `notes:lease-ended`；取连接/仓储失败只 warn `Notes editor lease cleanup: {Display}`，本 tick 已消费，继续后续 tick，维护错误保留原文。不追加失败重试或另一个周期。
- 验证入口为真实 notes 插件安装；`tests/note-lease-lifecycle.test.ts` 保留 WP-084 六例全部断言及预算，仅扩充可控 timer/单调时钟。`tests/note-lease-burst.test.ts` 补单调时钟迟到多周期的数量/顺序/原相位、墙钟跳变的 TTL、SQL 失败后继续、首 tick 前卸载。仓储 spy 仅透传观察，不替换清理算法。
- 同步 IO / spawn_blocking、启动失败域、PageLoadEvent::Started（WP-091）分别保持独立工作包；此表仅覆盖 interval 调度。

### L10-V2-09：历史 tags_json 的 typed Vec<String>（2026-11-05）

- Rust 入口：`note_revision_repo.rs:290-315` 的 `get` 先读取数据库列，然后依次 `serde_json::from_str::<Vec<String>>(tags_json)` → `props_json: Option<Value>` → `asset_refs_json: Vec<NoteAssetRef>`；`:327-336` 的 `set_pinned` 先 get 成功才 UPDATE pinned。Host 对应 `repository/revisions.ts::get/setPinned`，命令入口为 `index.ts::notes_history_get/notes_history_set_pinned`。
- 完整 tags 解码分支：根必须 sequence；按元素顺序读取 String，不接受 null/number/bool/object/array；合法字符串含空串/重复/Unicode 原样返回；无默认值、无修剪/去重/写回。元素类型错误在出现时立即返回，即使后面还有非法 JSON/尾随字符也不能覆盖第一错误。所有元素成功后才检查根值后的尾随字符。
- 实现用 F4 公共 `JsonReader`（`platform/util/api.ts`），不再先完整扫描后 JSON.parse；只将 `JsonSyntaxError.message` 包成 `NoteSerializationError`，由现有 `databaseStorage` 映射为 `{error_type:'Database',message:'Serialization error: <serde Display at line L column C>',details:null}`。位置按 UTF-8 字节，保留数字/浮点分类与 Rust 字符串 Debug 形式。非 JSON 编程异常不吞掉。
- 无新增日志（原 Rust 此解码路径无日志）；不改 DB 所有权/事务/时间/取消点。get 仍只读，set_pinned 解码失败在原事务内且 UPDATE 之前，不新增事务；失败不能污染 pin 或修复持久化原文。history worker/其余 JSON struct 分支不因本单元完成而签收。
- `tests/history-boundaries.test.ts` 的 `L10-V2-09` 经真实 kernel + notes/L11 + SQLite：12 种无效输入精确错误（含整数/小数/指数/-0 的 ParserNumber 分类）、UTF-8 列、第一类型错误优先于后续语法/单元格错误、失败 pin 不写入；2 种合法输入保留空串/重复/Unicode。旧 V2-08 三例及所有原移植断言不改。

### L10-V2-08：历史摘要与 seq 边界（2026-11-05）

- Rust `note_revision_repo.rs:253-286` 以列索引读取 `seq: i64`、`pinned: bool` 和 UTF-8 BLOB 长度；Host `repository/revisions.ts` 的摘要 SQL 必须给长度表达式起 `content_bytes` 别名，不能读取不存在的字段后返回 NaN。list/get/set_pinned 共用摘要映射，返回字节数而非 JS UTF-16 长度。
- `set_pinned`（Rust :327-336）只返回更新 pinned 后的九字段 `NoteRevisionSummary`，不把 `NoteRevision` 的正文/tags/props/assets/format 字段一并展开。新测试使用与 list 摘要的完整对象相等断言，不仅检查 pinned 字段。
- `list_filtered` 的 limit clamp 1..100、limit+1、pinned_only、seq DESC 与游标 `<` 条件保持原 SQL；使用 F3 safeIntegers 精确读取 seq，内部 next_cursor 在安全范围内仍 number，越界 bigint，调用方可原样继续分页。只在 kernel wire copy 中转 JSON number，不在仓储提前舍入，不拒绝合法大 i64。API 增补 `NoteHistorySequence` / `ExactNoteHistoryPage`，不改生成 IPC 契约。
- Rust `note_history_restore.rs:178-214` 在 before_restore snapshot/pin 之后读取 `MAX(seq): i64`，随后只删除本事务中新生成的 `seq > before_seq` 中间版本，再写 restore_current 来源。Host 必须在同一原保存点上精确读取/绑定此边界，禁止 Number(MAX(seq)) 导致保留中间格式版本或删除原有版本。
- 无新表所有权/事务/事件/日志/取消点；原 SQL 错误仍经 `databaseStorage` / `noteStorage` 映射。既有纳秒 policy 比较已经用 `parseRfc3339().epochNanos`（`v2-boundaries.test.ts`），本项不重做该修复。summary 内其他整数（pin、内容长度）的映射同步兼容 safeIntegers 查询。
- 新增 `tests/history-boundaries.test.ts` 经真实 notes/L11/SQLite 与 kernel 命令验证中文/emoji 字节数、get/pin 摘要、邻接大 seq 分页与 IPC 数字转换、恢复时精确高水位和来源保护；保留原 history 测试断言。本项不签收剩余历史 JSON serde 分支或跨 owner changelog 清理。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## 跨插件接线待办

### N5 / L10-V2-01：L11 owner 接口消费（2026-11-05）

本单元只替换下列跨 owner SQL，不改变周围校验/事务/事件；不以本表签收这些命令的其他 v2 分支。
正式 provider 为 `vfsRepo.noteOwnerWrites`（`vfs-repos/api.ts`），插件装配检查能力，缺失明确失败，不回退本地 SQL。

| Rust `note_repo.rs` 分支 | notes 生产落点 / owner 方法 | 顺序、错误与日志 |
|---|---|---|
| :536-540 新建后绑定资源 | `repository/notes.ts::createNoteWithConn` → `bindNoteSourceIdWithConn` | 同一个 create_note 保存点，先 notes INSERT，再 source_id，再 links/format/history；SQL 失败回滚并保留 `Database error: …`；:551 Created note info 在 format/snapshot 之前 |
| :823-842 内容变化且旧资源无 note 引用 | `updateNoteWithFormat` → `purgeNoteResourceRowWithConn` | 关系 retarget → 引用计数 → index artifacts → 单行资源删除，仍在 update_note 保存点；删除成功 debug 后才写 links/history |
| :2371-2417 软删 | `deleteNoteWithFolderItem` → `softDeleteNoteMembershipsWithConn` / `disableNoteUnitsWithConn` | 原保存点内 note 软删 → active membership 软删 → 若 resource 存在禁用两个 state；RFC3339 毫秒与 epoch ms 分别采样，原样传 owner；disabled_count>0 info，完成 debug；不改 required/error/updated_at |
| :1618-1641 恢复 | `restoreNoteWithConn` → `restoreLatestDeletedNoteMembershipWithConn` | note 标题 CAS 成功后、trash_restore snapshot 前；按 COALESCE(updated_at,created_at) DESC/created_at DESC 仅恢复一行，无行不报错；owner 不另开事务 |
| :1854-1884 硬删资源 | `purgeNoteWithConn` → `purgeNoteResourceRowWithConn` | 同一 purge 保存点，仍先 membership/note，再资源引用过滤和 index artifacts；不扩大为所有孤儿清理；原有 purge 日志/错误上下文的全分支核对仍待独立完成 |
| :3092-3123 一次性回填 | `backfillNoteLinksOnce` → `markNoteLinksBackfillDoneWithConn` | true 标记提前 false 返回；每批原 IMMEDIATE 事务全部成功后才写固定 maintenance key；任一失败不写完成标记，可重试；成功后 info 含 notes/links 数；不放宽公开 setConfig 白名单 |

输入/输出：此六面只使用上游已验证的 note/resource id、时间戳，新增数据解码为零；不改变 IPC 形状。L11 自有 resources/folder_items/vfs_index_units/vfs_indexing_config 的写入仅留 owner；notes/links/revisions 仍属 L10。`vfsRepoCall` 保留 owner 的 VfsError Display（不重复加 Database 前缀）。无新增取消点、连接、锁或异步提交。测试 `tests/note-owner-consumption.test.ts` 经真实 notes 服务及 L11 provider，call-through spy 只观察真实方法；覆盖同连接、顺序、调用方回滚、真实 SQL 失败/重试和回填失败不落标志；原 Rust 断言仍由原测试文件保留。

- 已接线：`vfsRepo.resources.createOrReuseWithHash/computeHash/computeHashWithSalt`、
  `vfsRepo.indexStates.markPending`、`vfsRepo.embeddingUnits.purgeIndexArtifactsByResource`、
  `vfsRepo.folders.folderExists/addItemToFolder/getResourceLocation`。
  生产路径 `inject: ['storage', 'vfsRepo']` 并经 `ctx.get('vfsRepo')` 调用；L11 现已在
  `host/plugins/vfs-repos/index.ts:111` 提供 `vfsRepo`（ARCHITECTURE.md 附录 A 名称）。
- 已接线：`agentTools.registerToolExecutors`。`canvas` / `user_todo_*` / `notes_import`
  三个执行器由 `index.ts` 实例化并随 `notes.tools` 暴露，L07 `agentTools` 就绪后注册
  （含晚注入）；`tests/agent-tools-registration.test.ts` 从真实入口验证。L04 的消费端
  `ToolExecutorRegistry` 尚未合入 `main`，真实聊天派发仍不可验证。
- 剩余跨 lane：L04 `ToolExecutorRegistry` 未合入 `main`；L04 候选 `host/plugins/chat/api.ts:143` 与 `host/plugins/chat/src/execution-context.ts:70` 已实现 `ExecutionContext.tryWindow`，但尚未合入 `main`，正式 ACR 调用窗口消费待候选合入；前端 ACR 桥可达性未证实。
  `CanvasToolExecutor.search` 不是“缺 Lance 所以改 FTS”：Rust VFS 模式下
  `notes_manager.rs:618-632` 已把 `search_notes_lance` 短路到 `search_notes_vfs`，
  后者（`:717-737`）调用 `VfsNoteRepo::search_notes_with_snippets`（FTS5 bm25 优先、
  LIKE 兜底）；Host 复用同一仓储方法，保留分页、folder 过滤、摘要截断与错误前缀。

## 命令 `canvas_note_append`

<!-- BEGIN GENERATED:cmd:canvas_note_append -->
- Rust：`src-tauri/src/cmd/notes.rs:1385` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:375`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, content: string, section?: string | null
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:canvas_note_append -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `canvas_note_read`

<!-- BEGIN GENERATED:cmd:canvas_note_read -->
- Rust：`src-tauri/src/cmd/notes.rs:1363` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:361`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, section?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:canvas_note_read -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `canvas_note_replace`

<!-- BEGIN GENERATED:cmd:canvas_note_replace -->
- Rust：`src-tauri/src/cmd/notes.rs:1410` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:392`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, search: string, replace: string, isRegex?: boolean | null
  - 结果：integer(u32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:canvas_note_replace -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `canvas_note_set`

<!-- BEGIN GENERATED:cmd:canvas_note_set -->
- Rust：`src-tauri/src/cmd/notes.rs:1437` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:404`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, content: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:canvas_note_set -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_canvas_edit_ack`

<!-- BEGIN GENERATED:cmd:chat_v2_canvas_edit_ack -->
- Rust：`src-tauri/src/chat_v2/handlers/canvas_handlers.rs:49` · sync
- 前端：app（3 处，例 `src/features/notes/aiReview.ts:222`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：requestId: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:chat_v2_canvas_edit_ack -->

- [x] 输入：requestId 必填；trim 后为空返回 InvalidInput（canvas_handlers.rs:49-62）。
- [x] 输出：成功返回 null；无 pending 回调仅 warn 并返回 null（canvas_executor.rs:handle_edit_ack）。
- [x] 错误：空 requestId 返回字符串 `Invalid input: request_id must not be empty`（ChatV2Error::InvalidInput，canvas_handlers.rs:51-53）。
- [x] 事件：不主动发事件（canvas_handlers.rs:49-62）。
- [x] DB 读写：无数据库访问（canvas_handlers.rs:49-62）。
- [x] 取消/并发：同步投递 pending ACK；找不到回调时静默忽略，不阻塞（canvas_executor.rs:handle_edit_ack）。
- [x] 时间/ID：只使用调用方 requestId，不生成 ID/时间（canvas_handlers.rs:49-62）。

## 命令 `chat_v2_canvas_edit_result`

<!-- BEGIN GENERATED:cmd:chat_v2_canvas_edit_result -->
- Rust：`src-tauri/src/chat_v2/handlers/canvas_handlers.rs:28` · sync
- 前端：app（3 处，例 `src/features/notes/aiReview.ts:29`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：result: CanvasAIEditResult
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:chat_v2_canvas_edit_result -->

- [x] 输入：result.requestId 必填；success/error/计数/预览字段按 CanvasAIEditResult 解码（canvas_handlers.rs:28-47）。
- [x] 输出：成功返回 null；无 pending 回调仅 warn 并返回 null（canvas_executor.rs:handle_edit_result）。
- [x] 错误：空 requestId 返回字符串 `Invalid input: request_id must not be empty`（ChatV2Error::InvalidInput，canvas_handlers.rs:30-32）。
- [x] 事件：不主动发事件（canvas_handlers.rs:28-47）。
- [x] DB 读写：无数据库访问（canvas_handlers.rs:28-47）。
- [x] 取消/并发：同步投递 pending oneshot；超时/已消费时只记录 warn，命令仍返回 Ok（canvas_handlers.rs:24-27）。
- [x] 时间/ID：只使用调用方 requestId，不生成 ID/时间（canvas_handlers.rs:28-47）。

## 命令 `notes_assets_bulk_delete`

<!-- BEGIN GENERATED:cmd:notes_assets_bulk_delete -->
- Rust：`src-tauri/src/cmd/notes.rs:2167` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:290`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：paths: string[]
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_assets_bulk_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_assets_index_scan`

<!-- BEGIN GENERATED:cmd:notes_assets_index_scan -->
- Rust：`src-tauri/src/cmd/notes.rs:1972` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:284`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_assets_index_scan -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_assets_scan_orphans`

<!-- BEGIN GENERATED:cmd:notes_assets_scan_orphans -->
- Rust：`src-tauri/src/cmd/notes.rs:2004` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:287`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null
  - 结果：string[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_assets_scan_orphans -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_create`

<!-- BEGIN GENERATED:cmd:notes_create -->
- Rust：`src-tauri/src/cmd/notes.rs:1206` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, note: NewNotePayload
  - 结果：NoteItem · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_create -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_db_stats`

<!-- BEGIN GENERATED:cmd:notes_db_stats -->
- Rust：`src-tauri/src/cmd/notes.rs:2960` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:229`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：（无）
  - 结果：NotesDbStats · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_db_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_db_vacuum`

<!-- BEGIN GENERATED:cmd:notes_db_vacuum -->
- Rust：`src-tauri/src/cmd/notes.rs:3020` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:232`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：（无）
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_db_vacuum -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_delete`

<!-- BEGIN GENERATED:cmd:notes_delete -->
- Rust：`src-tauri/src/cmd/notes.rs:1342` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, id: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_delete_asset`

<!-- BEGIN GENERATED:cmd:notes_delete_asset -->
- Rust：`src-tauri/src/cmd/notes.rs:1898` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:201`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：relativePath: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_delete_asset -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_begin`

<!-- BEGIN GENERATED:cmd:notes_editor_begin -->
- Rust：`src-tauri/src/cmd/notes.rs:397` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:215`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：participantId: string, operationId: string, noteIds: string[]
  - 结果：LeaseStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_begin -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_finish`

<!-- BEGIN GENERATED:cmd:notes_editor_finish -->
- Rust：`src-tauri/src/cmd/notes.rs:478` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:247`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：lease: NoteLeaseAuth
  - 结果：LeaseStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_finish -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_flush`

<!-- BEGIN GENERATED:cmd:notes_editor_flush -->
- Rust：`src-tauri/src/cmd/notes.rs:457` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：lease: NoteLeaseAuth, noteId: string, capabilities?: string[] | null
  - 结果：LeaseNote · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_flush -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_freeze_ack`

<!-- BEGIN GENERATED:cmd:notes_editor_freeze_ack -->
- Rust：`src-tauri/src/cmd/notes.rs:428` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:242`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：lease: NoteLeaseAuth, draft: FrozenDraft
  - 结果：LeaseStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_freeze_ack -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_heartbeat`

<!-- BEGIN GENERATED:cmd:notes_editor_heartbeat -->
- Rust：`src-tauri/src/cmd/notes.rs:368` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:67`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：participantId: string
  - 结果：ParticipantStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_heartbeat -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_lease_status`

<!-- BEGIN GENERATED:cmd:notes_editor_lease_status -->
- Rust：`src-tauri/src/cmd/notes.rs:421` · async
- 前端：app（3 处，例 `src/features/notes/noteHostCoordinator.ts:223`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：token: string
  - 结果：LeaseStatus | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_editor_lease_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_refresh_ack`

<!-- BEGIN GENERATED:cmd:notes_editor_refresh_ack -->
- Rust：`src-tauri/src/cmd/notes.rs:493` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:296`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：lease: NoteLeaseAuth, updatedAt: string
  - 结果：LeaseStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_refresh_ack -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_register`

<!-- BEGIN GENERATED:cmd:notes_editor_register -->
- Rust：`src-tauri/src/cmd/notes.rs:350` · async
- 前端：app（1 处，例 `src/features/notes/noteHostCoordinator.ts:60`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string
  - 结果：ParticipantStatus · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_register -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_release`

<!-- BEGIN GENERATED:cmd:notes_editor_release -->
- Rust：`src-tauri/src/cmd/notes.rs:509` · async
- 前端：app（3 处，例 `src/features/notes/noteHostCoordinator.ts:139`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：lease: NoteLeaseAuth, cancel: boolean
  - 结果：LeaseCancellation · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_release -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_editor_unregister`

<!-- BEGIN GENERATED:cmd:notes_editor_unregister -->
- Rust：`src-tauri/src/cmd/notes.rs:380` · async
- 前端：app（2 处，例 `src/features/notes/noteHostCoordinator.ts:62`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：participantId: string
  - 结果：LeaseCancellation[] · 错误：AppError · 注入：webview, state
<!-- END GENERATED:cmd:notes_editor_unregister -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_empty_trash`

<!-- BEGIN GENERATED:cmd:notes_empty_trash -->
- Rust：`src-tauri/src/cmd/notes.rs:1595` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:263`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null
  - 结果：integer(usize) · 错误：AppError · 注入：state, state
<!-- END GENERATED:cmd:notes_empty_trash -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_enable_columns`

<!-- BEGIN GENERATED:cmd:notes_enable_columns -->
- Rust：`src-tauri/src/cmd/notes.rs:628` · async
- 前端：app（1 处，例 `src/features/notes/noteEditorHost.ts:144`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, expectedUpdatedAt: string, lease?: NoteLeaseAuth | null
  - 结果：NoteFormatStatus · 错误：AppError · 注入：webview, state, app-handle
<!-- END GENERATED:cmd:notes_enable_columns -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_export`

<!-- BEGIN GENERATED:cmd:notes_export -->
- Rust：`src-tauri/src/cmd/notes.rs:2363` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:304`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NotesExportCommandRequest
  - 结果：NotesExportCommandResponse · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_export -->

- [x] 输入：request 的 subjects/output_path/include_versions 均可空；include_versions 缺省 true，output_path 为目录时自动拼 `notes_export_<UTC时间>.zip`（cmd/notes.rs:2363-2445；notes_exporter.rs:386-400）。
- [x] 输出：`{output_path, note_count, attachment_count}`；note_count 为 VFS 当前笔记/筛选后数量，attachment_count 为去重后的 notes_assets 引用数（notes_exporter.rs:185-206,461-590）。
- [x] 错误：空库 `没有可导出的笔记`；目标目录/文件创建失败映射 FileSystem；引用附件缺失/越界映射 FileSystem/Validation（notes_exporter.rs:185-206,386-400）。
- [x] 事件：不主动发事件（导出无进度事件；cmd/notes.rs:2364-2445）。
- [x] DB 读写：VFS 只读快照读取 notes/resources/历史/关系/偏好；不写库（notes_exporter.rs:750-863）。
- [x] 取消/并发：无取消点；导出在快照事务内读取，写 ZIP 前不持写锁（notes_exporter.rs:753-757）。
- [x] 时间/ID：默认文件名用 UTC `YYYYMMDD_HHMMSS`；导出清单 exported_at 用当前 UTC ISO 时间（notes_exporter.rs:34-43,386-400）。

## 命令 `notes_export_single`

<!-- BEGIN GENERATED:cmd:notes_export_single -->
- Rust：`src-tauri/src/cmd/notes.rs:2447` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:325`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NotesExportSingleCommandRequest
  - 结果：NotesExportCommandResponse · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_export_single -->

- [x] 输入：note_id 必填；subject/output_path/include_versions 可空，include_versions 缺省 true（cmd/notes.rs:2447-2523；notes_exporter.rs:621-740）。
- [x] 输出：`{output_path, note_count, attachment_count}`；单笔记 note_count=1（notes_exporter.rs:621-740）。
- [x] 错误：笔记不存在 `未找到要导出的笔记`；附件/路径错误同 notes_export（notes_exporter.rs:190-206）。
- [x] 事件：不主动发事件（cmd/notes.rs:2447-2523）。
- [x] DB 读写：只读目标笔记、历史版本、关系与被引用附件（notes_exporter.rs:621-740）。
- [x] 取消/并发：无取消点；单笔记快照读取（notes_exporter.rs:621-740）。
- [x] 时间/ID：默认文件名含 sanitize 后标题与笔记 ID（notes_exporter.rs:402-431）。

## 命令 `notes_get`

<!-- BEGIN GENERATED:cmd:notes_get -->
- Rust：`src-tauri/src/cmd/notes.rs:1327` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, id: string
  - 结果：NoteItem · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_get_backlinks`

<!-- BEGIN GENERATED:cmd:notes_get_backlinks -->
- Rust：`src-tauri/src/cmd/notes.rs:3384` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string
  - 结果：NoteBacklink[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get_backlinks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_get_format`

<!-- BEGIN GENERATED:cmd:notes_get_format -->
- Rust：`src-tauri/src/cmd/notes.rs:595` · async
- 前端：app（1 处，例 `src/features/notes/noteEditorHost.ts:46`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string
  - 结果：NoteFormatStatus · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get_format -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_get_outgoing_links`

<!-- BEGIN GENERATED:cmd:notes_get_outgoing_links -->
- Rust：`src-tauri/src/cmd/notes.rs:3403` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string
  - 结果：NoteOutgoingLink[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get_outgoing_links -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_get_pref`

<!-- BEGIN GENERATED:cmd:notes_get_pref -->
- Rust：`src-tauri/src/cmd/notes.rs:2326` · async
- 前端：app（2 处，例 `src/features/notes/NotesContext.tsx:474`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：key: string
  - 结果：string | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get_pref -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_get_subject_rag_config`

<!-- BEGIN GENERATED:cmd:notes_get_subject_rag_config -->
- Rust：`src-tauri/src/cmd/notes.rs:2230` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject: string
  - 结果：NotesSubjectRagConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_get_subject_rag_config -->

- [x] 输入：IPC `subject: String` 经 kernel 契约；持久化 `notes.rag.config.<subject>` 按 `NotesSubjectRagConfig` 反序列化，字段 `chunk_size/chunk_overlap/min_chunk_size` 均必填 i32、`rerank_enabled` 必填 bool，无 default/rename/deny_unknown_fields（Rust `cmd/notes.rs:2222-2243`）。允许 struct 的四项 sequence 形式；未知字段忽略；已知字段重复拒绝；小数/指数浮点即使数值为整数也拒绝。不对 GET 应用 UPDATE 的业务范围限制。
- [x] 输出：四个 snake_case 字段，均非 Option；有效配置原样返回；无有效覆盖则读取默认配置，缺行时为 512/50/20/true（`:2245-2257`）。
- [x] 错误：设置读取失败、JSON/serde 失败静默 fallback；默认配置读取错误 → `AppError::database(Display)`（`:2236-2248`）；不把业务 Err 变 HandlerPanic。
- [x] 事件/日志：此 Rust 入口没有 emitter 或 warn/error/info；解码失败不得新增 warn/error（`:2230-2258`）。
- [ ] DB 读写/所有权：设置只经 F4 SettingsStore；默认 rag_configurations 旧只读查询仍待明确 owner 业务面（`BLOCKERS.md::B-RAG-owner`），不得以本解码修复签收完整 owner 迁移。
- [x] 取消/并发/清理：无 Rust cancel token、Drop guard、跨写事务；同步读完成，无新增中断点。
- [x] 时间/ID：不生成。

### v2 分支与证据（L10-V2-02）

| Rust | Host 生产落点 | 断言 |
|---|---|---|
| `cmd/notes.rs:2236-2243` 设置存在且 serde 成功 | `repository/rag-config.ts::decodeSubjectRagConfig/getSubjectRagConfig` | `tests/v2-boundaries.test.ts` 经真实 notes 命令、F4 settings、L11 插件；i32 两端点、sequence、未知字段 |
| `:2236-2243` 设置读取失败 / serde 错误后继续 | 同函数设置读取 catch / decoder null | 小数、指数、i32 越界、缺字段/null、重复字段、坏 JSON 均读 fallback 且原设置不被改写 |
| `:2245-2257` 默认行/无行/读取错误 | 旧默认查询 + `src/settings-commands.ts::getSubjectConfig` | 既有 settings 命令测试；owner 接缝未闭合，不自行勾所有权 |

证据等级：生产入口测试 + Rust struct/入口审读；无 Rust 动态差分。该项修复不代表 `notes_update_subject_rag_config` 的 owner 缺口已解决。

## 命令 `notes_hard_delete`

<!-- BEGIN GENERATED:cmd:notes_hard_delete -->
- Rust：`src-tauri/src/cmd/notes.rs:1462` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:266`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, id: string
  - 结果：boolean · 错误：AppError · 注入：state, state
<!-- END GENERATED:cmd:notes_hard_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_current`

<!-- BEGIN GENERATED:cmd:notes_history_current -->
- Rust：`src-tauri/src/cmd/notes.rs:926` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:163`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string
  - 结果：NoteHistoryCurrent · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_current -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_get`

<!-- BEGIN GENERATED:cmd:notes_history_get -->
- Rust：`src-tauri/src/cmd/notes.rs:1032` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:148`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, versionId: string
  - 结果：NoteRevision · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_get -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_get_retention`

<!-- BEGIN GENERATED:cmd:notes_history_get_retention -->
- Rust：`src-tauri/src/cmd/notes.rs:934` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:171`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：（无）
  - 结果：NoteHistoryRetention · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_get_retention -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_list`

<!-- BEGIN GENERATED:cmd:notes_history_list -->
- Rust：`src-tauri/src/cmd/notes.rs:1002` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:144`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, cursor?: integer(i64) | null, limit?: integer(u32) | null, pinnedOnly?: boolean | null
  - 结果：NoteHistoryPage · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_restore_copy`

<!-- BEGIN GENERATED:cmd:notes_history_restore_copy -->
- Rust：`src-tauri/src/cmd/notes.rs:1077` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:160`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, versionId: string
  - 结果：DstuNode · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_history_restore_copy -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_restore_current`

<!-- BEGIN GENERATED:cmd:notes_history_restore_current -->
- Rust：`src-tauri/src/cmd/notes.rs:972` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:168`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, versionId: string, expectedUpdatedAt: string, selection?: NoteHistorySelection | null, lease?: NoteLeaseAuth | null
  - 结果：DstuNode · 错误：AppError · 注入：webview, state, window
<!-- END GENERATED:cmd:notes_history_restore_current -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_restore_selection_copy`

<!-- BEGIN GENERATED:cmd:notes_history_restore_selection_copy -->
- Rust：`src-tauri/src/cmd/notes.rs:952` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:159`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, versionId: string, selection: NoteHistorySelection
  - 结果：DstuNode · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_history_restore_selection_copy -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_set_pinned`

<!-- BEGIN GENERATED:cmd:notes_history_set_pinned -->
- Rust：`src-tauri/src/cmd/notes.rs:1054` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:152`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, versionId: string, pinned: boolean
  - 结果：NoteRevisionSummary · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_set_pinned -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_history_set_retention`

<!-- BEGIN GENERATED:cmd:notes_history_set_retention -->
- Rust：`src-tauri/src/cmd/notes.rs:941` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:174`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：policy: NoteHistoryRetention__De
  - 结果：NoteHistoryRetention · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_history_set_retention -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_import`

<!-- BEGIN GENERATED:cmd:notes_import -->
- Rust：`src-tauri/src/cmd/notes.rs:2544` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:341`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NotesImportCommandRequest
  - 结果：NotesImportCommandResponse · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_import -->

- [x] 输入：file_path 必填；conflict_strategy 缺省 skip，仅 skip/overwrite/merge_keep_newer（cmd/notes.rs:2544-2667；notes_exporter.rs:1698-1811）。
- [x] 输出：`{subject_count, note_count, attachment_count, skipped_count, overwritten_count}`；VFS 模式 subject_count=0（notes_exporter.rs:1690-1696,2689-3138）。
- [x] 错误：文件不存在 `导入文件不存在`；畸形/未来 manifest、缺失文档、数量不符、越界附件均 Validation；写盘失败 FileSystem（notes_exporter.rs:1725-1810,1839-2202）。
- [x] 事件：按阶段发 `notes-import-progress`（parsing/importing_notes/importing_attachments/importing_preferences/done），处理数 >200 时按 1/200 步进节流（cmd/notes.rs:2580；notes_exporter.rs:34-43）。
- [x] DB 读写：schema 3 在单事务内写 notes/resources/历史/关系，失败回滚并删除已写附件；schema 2 逐笔记写 VFS（notes_exporter.rs:1839-2202,2689-3138）。
- [x] 取消/并发：无取消点；schema 3 文档导入使用 SAVEPOINT 保证原子性（notes_exporter.rs:2060-2160）。
- [x] 时间/ID：导入附件使用新 `import_<uuid>` 命名空间；历史版本/附件引用重映射后写入（notes_exporter.rs:2710-2740,3050-3138）。

## 命令 `notes_import_markdown`

<!-- BEGIN GENERATED:cmd:notes_import_markdown -->
- Rust：`src-tauri/src/cmd/notes.rs:2668` · async
- 前端：app（1 处，例 `src/dstu/adapters/notesDstuAdapter.ts:225`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NotesImportMarkdownRequest
  - 结果：DstuNode · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_import_markdown -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_import_markdown_batch`

<!-- BEGIN GENERATED:cmd:notes_import_markdown_batch -->
- Rust：`src-tauri/src/cmd/notes.rs:2722` · async
- 前端：app（1 处，例 `src/dstu/adapters/notesDstuAdapter.ts:248`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NotesImportMarkdownBatchRequest
  - 结果：NotesImportMarkdownBatchResponse · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_import_markdown_batch -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_invalidate_resource_refs`

<!-- BEGIN GENERATED:cmd:notes_invalidate_resource_refs -->
- Rust：`src-tauri/src/cmd/notes.rs:914` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：resourceId: string
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_invalidate_resource_refs -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list`

<!-- BEGIN GENERATED:cmd:notes_list -->
- Rust：`src-tauri/src/cmd/notes.rs:1110` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：NoteItem[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list_advanced`

<!-- BEGIN GENERATED:cmd:notes_list_advanced -->
- Rust：`src-tauri/src/cmd/notes.rs:1162` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, options: NotesListAdvancedOptions
  - 结果：NotesListAdvancedResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_advanced -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list_assets`

<!-- BEGIN GENERATED:cmd:notes_list_assets -->
- Rust：`src-tauri/src/cmd/notes.rs:1879` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:193`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string
  - 结果：Value[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_assets -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list_deleted`

<!-- BEGIN GENERATED:cmd:notes_list_deleted -->
- Rust：`src-tauri/src/cmd/notes.rs:1782` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:260`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, page?: integer(i64) | null, pageSize?: integer(i64) | null
  - 结果：NotesListAdvancedResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_deleted -->

- [x] 输入：`subject` 被忽略（Rust `_subject`；VFS 版本不需要学科）；`page` 缺省 0，`pageSize` 缺省 20，`limit = pageSize as u32`、`offset = (page*pageSize) as u32`（cmd/notes.rs:1782-1798；Host `listDeletedNotes` note-commands.ts:112-121 用 `BigInt.asUintN(32)` 复刻 as u32）。
- [x] 输出：`NotesListAdvancedResponse { items: NoteItem[], total, page, page_size }`；`content_md` 恒为空串，`item` 字段保持 snake_case（cmd/notes.rs:1805-1822；契约 `NotesListAdvancedResponse`）。
- [x] 错误：VFS 未配置 → `Configuration("VFS database not configured")`；查询失败 → `Database("VFS 查询回收站失败: …")`；`count_deleted_notes` 失败回退 `items.len()` 并 warn（cmd/notes.rs:1789-1820；Host note-commands.ts:126-130）。
- [x] 事件：无。
- [x] DB 读写：只读 `SELECT … FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?`，附加 `COUNT(*)` 同条件（note_repo.rs:2140-2177；Host repository/notes.ts:875-883）。
- [x] 取消/并发：Rust 放 `spawn_blocking`，不可中途取消；Host 同步只读，经同一 SQLite 连接串行。
- [x] 时间/ID：不生成时间或 ID，原样返回已有 RFC3339 字符串与 note id。

## 命令 `notes_list_meta`

<!-- BEGIN GENERATED:cmd:notes_list_meta -->
- Rust：`src-tauri/src/cmd/notes.rs:1128` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null
  - 结果：NoteItem[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_meta -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list_referencing_resource`

<!-- BEGIN GENERATED:cmd:notes_list_referencing_resource -->
- Rust：`src-tauri/src/cmd/notes.rs:835` · async
- 前端：app（1 处，例 `src/features/pdf/components/PdfRelatedPanel.tsx:28`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：resourceIds: string[]
  - 结果：NoteReferencingResource[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_referencing_resource -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_list_tags`

<!-- BEGIN GENERATED:cmd:notes_list_tags -->
- Rust：`src-tauri/src/cmd/notes.rs:3040` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:236`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null
  - 结果：string[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_list_tags -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_mentions_search`

<!-- BEGIN GENERATED:cmd:notes_mentions_search -->
- Rust：`src-tauri/src/cmd/notes.rs:3202` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:278`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, keyword: string, limit?: integer(u32) | null
  - 结果：NotesMentionSearchResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_mentions_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_migrate_blocks`

<!-- BEGIN GENERATED:cmd:notes_migrate_blocks -->
- Rust：`src-tauri/src/cmd/notes.rs:677` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string, expectedUpdatedAt: string, content: string, lease?: NoteLeaseAuth | null
  - 结果：VfsNote · 错误：AppError · 注入：webview, state, app-handle
<!-- END GENERATED:cmd:notes_migrate_blocks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_rag_rebuild_fts_index`

<!-- BEGIN GENERATED:cmd:notes_rag_rebuild_fts_index -->
- Rust：`src-tauri/src/cmd/notes.rs:2212` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_rag_rebuild_fts_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_rebuild_links`

<!-- BEGIN GENERATED:cmd:notes_rebuild_links -->
- Rust：`src-tauri/src/cmd/notes.rs:3435` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, batchSize?: integer(u32) | null
  - 结果：NotesRebuildLinksResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_rebuild_links -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_reference_status`

<!-- BEGIN GENERATED:cmd:notes_reference_status -->
- Rust：`src-tauri/src/cmd/notes.rs:899` · async
- 前端：app（1 处，例 `src/features/notes/noteRelations.ts:49`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：resourceId: string, locator: NoteLocator__De
  - 结果：NoteReferenceStatus · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_reference_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_relation_delete`

<!-- BEGIN GENERATED:cmd:notes_relation_delete -->
- Rust：`src-tauri/src/cmd/notes.rs:888` · async
- 前端：app（1 处，例 `src/features/notes/noteRelations.ts:45`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：id: string, expectedRevision: integer(i64)
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_relation_delete -->

### v2 D3 增量（L10-V2-07；不代表整条命令已签收）

- Rust `note_relation_repo.rs:197-205` → `repository/relations.ts::delete` → `index.ts` 注册：仍是 `DELETE ... WHERE id=?1 AND revision=?2`，非 1 行抛 `notes.relation_conflict`，成功返回 true。
- Host 的 expectedRevision 接受精确 bigint 或 number；IPC 仍按原 i64 数字契约入站，不新增负数/unsafe integer 拒绝规则。
- 仅写 L10 `note_learning_relations`，不增加事务；Rust 无事件、无该分支 warn/error。调用方事务回滚保持原语义。
- 测试：`tests/v2-boundaries.test.ts` 的 `L10-V2-07`，相邻大 i64 删除冲突、用精确更新后 revision 删除成功；安装真实插件和 SQLite。
- 未闭合：与其他 note_storage 命令共用的 worker/取消路径仍需单独复核，不能凭本次 D3 回归勾整项。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_relation_get`

<!-- BEGIN GENERATED:cmd:notes_relation_get -->
- Rust：`src-tauri/src/cmd/notes.rs:730` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：id: string
  - 结果：NoteRelation | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_relation_get -->

### v2 D3 增量（L10-V2-07；不代表整条命令已签收）

- Rust `note_relation_repo.rs:112-135` → `repository/relations.ts::get/relation` → `index.ts` 注册；缺失行返回 null，命中行解码 locator/type/reference 后返回完整对象。
- `revision: i64` 由 `defineQuery(...safeIntegers:true)` 精确读取；仅双边安全区间内可转 number，其余保持 bigint。SQLite REAL（包括 i64 自增溢出）按 Rust `r.get::<_,i64>(6)` 报 `Database error: Invalid column type Real at index: 6, name: revision`，在 locator 解码之前失败。
- IPC 仍由 kernel `toWireJson` 转 JSON 数字，与 Tauri 一致；不把 JS 生成契约的 number 断言当作 Host 内部精度保障。契约生成文件未改。
- 仓储读取 L10 relation 和 reference_status 涉及的目标 owner 表，无新写入/事件/日志。locator 的严格 serde 解码及 note_storage worker 行为尚未完成全面复核。
- 证据：`tests/v2-boundaries.test.ts` 的 `L10-V2-07` 对照 Rust 审读 + 生产命令 get 输出/真实仓储精确回读测试。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_relation_list`

<!-- BEGIN GENERATED:cmd:notes_relation_list -->
- Rust：`src-tauri/src/cmd/notes.rs:744` · async
- 前端：app（1 处，例 `src/features/notes/noteRelations.ts:38`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：noteId: string
  - 结果：NoteRelation[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_relation_list -->

### v2 D3 增量（L10-V2-07；不代表整条命令已签收）

- Rust `note_relation_repo.rs:137-153` → `repository/relations.ts::list` → `index.ts` 注册：按 id 排序查列表，再调用同一 `get` 解码；缺失项不推入数组，任一解码错误向上传播。
- 每项 revision 沿用 get 的精确 i64/REAL 列类型规则；Host 内部数组保留 bigint，IPC 转 JSON 数字只发生于 kernel 线上边界。
- 无写入、无事件、无额外日志；目标 reference_status 的各 locator 分支及 worker/取消完整性不以本次精度测试签收。
- 测试：`L10-V2-07` 验证大正/负 revision 的仓储 list 精确对象和生产 list 命令数字表示。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_relation_put`

<!-- BEGIN GENERATED:cmd:notes_relation_put -->
- Rust：`src-tauri/src/cmd/notes.rs:874` · async
- 前端：app（1 处，例 `src/features/notes/noteRelations.ts:40`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NoteRelationPut
  - 结果：NoteRelation · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_relation_put -->

### v2 D3 增量（L10-V2-07；不代表整条命令已签收）

| Rust 分支 | TS 落点 / 本次结论 |
|---|---|
| `note_relation_repo.rs:160-184` id、类型、owner、block、目标校验 | `relations.ts::put/referenceStatus`，顺序未改；本次未将其声明全部 serde 等价 |
| `:185-186` expected_revision=Some，SQL `revision=revision+1` CAS | 同一 SQL，expected_revision 内部允许 bigint 精确绑定，不经 Number |
| `:187-192` None 新建/冲突 | 原 INSERT ON CONFLICT DO NOTHING 保留，非 1 行仍为 notes.relation_conflict |
| `:193-194` 原子回读 get::<i64> | 精确回读；i64::MAX 自增产生 REAL 后按原列类型错误回滚 savepoint，不新增提前 checked_add/负数拒绝 |

- `NoteRelationPut.expected_revision: Option<i64>` / `NoteRelation.revision: i64` 对应内部 `ExactNoteRelationPut` / `ExactNoteRelation`；IPC/生成类型不变。未触碰 locator 字段的现有解码逻辑。
- 写 L10 `note_learning_relations`；沿用 `note_history_write` savepoint、原异常回滚。无新增事件/业务日志；Rust note_storage 的 worker/取消仍另核。
- 测试：新 `L10-V2-07` 覆盖正/负大数、相邻 CAS 冲突、调用方回滚、i64 溢出回滚；旧 note-storage / note-lease 断言保持不变。证据为真实插件/SQLite 回归和 Rust 审读，非 Rust 差分运行。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_resolve_asset_path`

<!-- BEGIN GENERATED:cmd:notes_resolve_asset_path -->
- Rust：`src-tauri/src/cmd/notes.rs:1926` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:206`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：relativePath: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_resolve_asset_path -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_restore`

<!-- BEGIN GENERATED:cmd:notes_restore -->
- Rust：`src-tauri/src/cmd/notes.rs:1836` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:269`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, id: string
  - 结果：boolean · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:notes_restore -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_review_save_as`

<!-- BEGIN GENERATED:cmd:notes_review_save_as -->
- Rust：`src-tauri/src/cmd/notes.rs:648` · async
- 前端：app（1 处，例 `src/features/notes/noteReviewHost.ts:92`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：operationId: string, sourceNoteId: string, markdown: string, expectedUpdatedAt?: string | null, capabilities?: string[] | null, lease?: NoteLeaseAuth | null
  - 结果：ReviewSaveResult · 错误：AppError · 注入：webview, state, app-handle
<!-- END GENERATED:cmd:notes_review_save_as -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_save_asset`

<!-- BEGIN GENERATED:cmd:notes_save_asset -->
- Rust：`src-tauri/src/cmd/notes.rs:1858` · async
- 前端：app（3 处，例 `src/components/crepe/features/imageUpload.ts:161`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, base64Data: string, defaultExt?: string | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_save_asset -->

- [x] 输入：`subject` 先 `normalize_subject`（空白→`_global`）；`noteId`/`subject` 用于目录分段并拒绝空值、路径分隔符、`.`/`..`、绝对路径与 NUL；`defaultExt` 缺省 `"jpg"`；`base64Data` 可为 `data:<mime>;base64,<payload>` 或纯 base64（cmd/notes.rs:1858-1874；Host assets.ts:30-58、69-99）。
- [x] 输出：`{ absolute_path, relative_path }`；文件落在 `notes_assets/<subject>/<noteId>/<uuid>.<ext>`，扩展名按 data URI MIME 选 png/webp/gif/bmp/jpg，否则用 `defaultExt`，相对路径使用可移植分隔符（file_manager.rs:915-959；assets.ts:60-99）。
- [x] 错误：base64 非法 → `Validation("base64解码失败: …")`；目录/写文件失败 → `FileSystem("创建资源目录失败: …"/"写入资源失败: …")`；非法路径分段 → Validation（file_manager.rs:924-952；Host `assetFailure` command-utils.ts:51-58）。
- [x] 事件：无。
- [x] DB 读写：不写数据库；仅确保目录并写文件（file_manager.rs:922-952）。资产引用登记由调用方/后续命令负责。
- [x] 取消/并发：Rust 放 `spawn_blocking`，不可中途取消；每次写使用独立 UUID 文件名，避免并发覆盖。
- [x] 时间/ID：文件名 ID 为 `uuid::Uuid::new_v4()`，不写时间戳；返回绝对路径按运行时 base 计算。

## 命令 `notes_search`

<!-- BEGIN GENERATED:cmd:notes_search -->
- Rust：`src-tauri/src/cmd/notes.rs:3129` · async
- 前端：app（1 处，例 `src/utils/notesApi.ts:252`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, keyword: string, limit?: integer(i64) | null
  - 结果：NotesSearchHit[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_set_favorite`

<!-- BEGIN GENERATED:cmd:notes_set_favorite -->
- Rust：`src-tauri/src/cmd/notes.rs:1310` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, id: string, favorite: boolean
  - 结果：NoteItem · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_set_favorite -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_set_pref`

<!-- BEGIN GENERATED:cmd:notes_set_pref -->
- Rust：`src-tauri/src/cmd/notes.rs:2313` · async
- 前端：app（2 处，例 `src/features/notes/NotesContext.tsx:1407`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：key: string, value: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_set_pref -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_state_delete`

<!-- BEGIN GENERATED:cmd:notes_state_delete -->
- Rust：`src-tauri/src/cmd/notes.rs:720` · async
- 前端：app（2 处，例 `src/features/notes/aiReviewPersistence.ts:34`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NoteStateDelete
  - 结果：NoteState · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:notes_state_delete -->

- [x] 输入：Rust 扁平 note_id/type/key/expected_revision；F5 已修复契约，`additionalProperties:false` 与扁平字段共存（contracts/ipc/L10-notes.json；note_state_repo.rs:135-171）。
- [x] 输出：含 value=null、revision+1、deleted=true 的墓碑，保留 key/type（note_state_repo.rs:144-171）。
- [x] 错误：空/超过512 UTF-8字节键或无笔记 → Validation；旧 revision → Conflict notes.state_conflict；SQL/JSON → Database（note_state_repo.rs:69-75,168；cmd/notes.rs:313-321）。
- [x] 事件：提交完成后 notes:state-changed，载荷即返回行（cmd/notes.rs:726-728）。
- [x] DB 读写：同连接保存点内 CAS UPDATE，不删除行（note_state_repo.rs:160-171）。
- [x] 取消/并发：无取消点；同步保存点与 SQL CAS 对所有连接生效（note_state_repo.rs:160-172）。
- [x] 时间/ID：SQLite strftime 毫秒 UTC Z；无新 ID（note_state_repo.rs:163）。

## 命令 `notes_state_get`

<!-- BEGIN GENERATED:cmd:notes_state_get -->
- Rust：`src-tauri/src/cmd/notes.rs:696` · async
- 前端：app（1 处，例 `src/features/notes/aiReviewPersistence.ts:26`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NoteStateKey
  - 结果：NoteState | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_state_get -->

- [x] 输入：request 的 note_id/type/key 均 snake_case；type=review/draft，禁止额外字段（note_state_repo.rs:12-33）。
- [x] 输出：没有状态返回 null；墓碑照常返回，字段完整含 value/revision/deleted/updated_at（note_state_repo.rs:56-94）。
- [x] 错误：键长按 UTF-8字节1..512、要求未软删除笔记；SQL/JSON 按 note_storage 映射（note_state_repo.rs:69-94；cmd/notes.rs:313-321）。
- [x] 事件：不发事件（cmd/notes.rs:697-701）。
- [x] DB 读写：只读 note_state 与 notes 存在性（note_state_repo.rs:69-94）。
- [x] 取消/并发：无取消点；单条同步查询、不持跨 await 的锁（note_state_repo.rs:79-94）。
- [x] 时间/ID：只返回原存储 updated_at，不生成 ID（note_state_repo.rs:81-90）。

## 命令 `notes_state_list`

<!-- BEGIN GENERATED:cmd:notes_state_list -->
- Rust：`src-tauri/src/cmd/notes.rs:703` · async
- 前端：app（2 处，例 `src/features/notes/aiReviewPersistence.ts:29`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NoteStateList
  - 结果：NoteState[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_state_list -->

- [x] 输入：note_id/type，include_deleted 缺省 false（note_state_repo.rs:35-41）。
- [x] 输出：ORDER BY state_key，默认排墓碑；空结果 []（note_state_repo.rs:95-133）。
- [x] 错误：使用 key=list 做相同笔记存在性校验，SQL/JSON 按 note_storage 映射（note_state_repo.rs:96-103；cmd/notes.rs:313-321）。
- [x] 事件：不发事件（cmd/notes.rs:704-708）。
- [x] DB 读写：只读 notes/note_state（note_state_repo.rs:95-133）。
- [x] 取消/并发：无取消点；同步读取（note_state_repo.rs:95-133）。
- [x] 时间/ID：返回原值，不生成 ID（note_state_repo.rs:123-130）。

## 命令 `notes_state_put`

<!-- BEGIN GENERATED:cmd:notes_state_put -->
- Rust：`src-tauri/src/cmd/notes.rs:710` · async
- 前端：app（2 处，例 `src/features/notes/aiReviewPersistence.ts:31`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: NoteStatePut
  - 结果：NoteState · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:notes_state_put -->

- [x] 输入：Rust 扁平 note_id/type/key/expected_revision/value；缺省或 null revision 只允许新建；F5 契约已修复并接受扁平字段（contracts/ipc/L10-notes.json；note_state_repo.rs:135-171）。
- [x] 输出：新建 revision=1/deleted=false；更新加1，可按墓碑 revision 重建（note_state_repo.rs:135-171）。
- [x] 错误：键长/缺失笔记 Validation，CAS/重复创建 Conflict，SQL/JSON Database（note_state_repo.rs:69-75,168；cmd/notes.rs:313-321）。
- [x] 事件：提交后 notes:state-changed，失败不发（cmd/notes.rs:716-718）。
- [x] DB 读写：保存点内 INSERT ON CONFLICT DO NOTHING 或 revision CAS UPDATE，原子回读（note_state_repo.rs:160-172）。
- [x] 取消/并发：同步执行无 await 交错，SQL 条件保障多连接 CAS；无取消点（note_state_repo.rs:160-172）。
- [x] 时间/ID：SQLite strftime UTC毫秒Z；无新 ID（note_state_repo.rs:163-166）。

## 命令 `notes_transfer_blocks`

<!-- BEGIN GENERATED:cmd:notes_transfer_blocks -->
- Rust：`src-tauri/src/cmd/notes.rs:556` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：request: TransferBlocksRequest, lease?: NoteLeaseAuth | null
  - 结果：TransferResult · 错误：AppError · 注入：webview, state, app-handle
<!-- END GENERATED:cmd:notes_transfer_blocks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_undo_transfer`

<!-- BEGIN GENERATED:cmd:notes_undo_transfer -->
- Rust：`src-tauri/src/cmd/notes.rs:572` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：operationId: string, expectedSourceUpdatedAt: string, expectedTargetUpdatedAt: string, lease?: NoteLeaseAuth | null
  - 结果：TransferResult · 错误：AppError · 注入：webview, state, app-handle
<!-- END GENERATED:cmd:notes_undo_transfer -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_unlinked_mentions`

<!-- BEGIN GENERATED:cmd:notes_unlinked_mentions -->
- Rust：`src-tauri/src/cmd/notes.rs:3469` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, noteId: string, limit?: integer(u32) | null
  - 结果：NotesSearchHit[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_unlinked_mentions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_update`

<!-- BEGIN GENERATED:cmd:notes_update -->
- Rust：`src-tauri/src/cmd/notes.rs:1245` · async
- 前端：app（3 处，例 `src/features/learning-hub/apps/views/NoteContentView.tsx:602`）
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject?: string | null, note: UpdateNotePayload, lease?: NoteLeaseAuth | null
  - 结果：NoteItem · 错误：AppError · 注入：webview, state, window
<!-- END GENERATED:cmd:notes_update -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `notes_update_subject_rag_config`

<!-- BEGIN GENERATED:cmd:notes_update_subject_rag_config -->
- Rust：`src-tauri/src/cmd/notes.rs:2260` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：subject: string, cfg: NotesSubjectRagConfig__De
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_update_subject_rag_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `rag_rebuild_fts_index`

<!-- BEGIN GENERATED:cmd:rag_rebuild_fts_index -->
- Rust：`src-tauri/src/cmd/notes.rs:2203` · async
- 前端：none
- 契约：`contracts/ipc/L10-notes.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:rag_rebuild_fts_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `canvas:ai-edit-request`

<!-- BEGIN GENERATED:event:canvas:ai-edit-request -->
- 事件名 `canvas:ai-edit-request`
- 发送点：`src-tauri/src/chat_v2/tools/canvas_executor.rs:1742`（emit）
<!-- END GENERATED:event:canvas:ai-edit-request -->

- [x] 载荷：`CanvasAIEditRequest { requestId, noteId, operation: "append"|"replace"|"set", content?, search?, replace?, isRegex?, section? }`；可选字段 `skip_serializing_if = "Option::is_none"` 省略（canvas_executor.rs:69-91；契约 `CanvasAIEditRequest`）。Host 纯构造器 `buildCanvasAIEditRequest`（host/plugins/notes/src/canvas-tool.ts:243）逐字段对齐并补省略语义。
- [x] 触发时机与顺序：`execute_write_frontend` 构造请求 → 校验必填 → 注册 result/ack 回调 → emit → 等 ACK（canvas_executor.rs:1647-1745）。该函数在 R1-03 后仅保留 suggestion 模式，Rust `execute` 不再调用，写入改走 `probe → apply_ops`（canvas_executor.rs:6、704-711、1352）。Host 不发送该事件，仅保留同形构造器用于契约验证（canvas-tool.ts:640 的 ACR 分支用 `apply_ops`）。
- [x] 节流/合并：无；每次工具调用一个 `requestId`，一问一答。
- [x] 是否在事务提交后：不涉及数据库事务；事件先于前端应用，前端 ACK 后才进入结果等待。
- [x] 目标窗口（emit / emit_to / emit_filter）：`ctx.window_ref().emit(...)`，只发给发起工具调用的窗口（canvas_executor.rs:1742）。

## 事件 `notes-import-progress`

<!-- BEGIN GENERATED:event:notes-import-progress -->
- 事件名 `notes-import-progress`
- 发送点：`src-tauri/src/cmd/notes.rs:2580`（emit）
<!-- END GENERATED:event:notes-import-progress -->

- [x] 载荷：`ImportProgress { stage: "parsing"|"importing_notes"|"importing_attachments"|"importing_preferences"|"done", progress: u8(0-100), current_item: string|null, processed: usize, total: usize }`；stage 为 snake_case，`current_item` 无 skip 因而显式 null（notes_exporter.rs:1654-1684）。
- [x] 触发时机与顺序：`parsing(0)` → `importing_notes(0→50)` → `importing_attachments(50→90)` → `importing_preferences(90)` → `done(100)`；每阶段先发“准备导入 N 条/个”的起始帧（notes_exporter.rs:1741-1750、2265-2274、2474-2483、2586-2595、2642-2650）。
- [x] 节流/合并：`should_report_progress`：`total <= 200` 每条都报；否则 `step = ceil(total/200)`，仅 `processed == 1`、`processed == total` 或 `processed % step == 0` 上报（notes_exporter.rs:34-40）；Host 同规则（repository/import-archive.ts:221-225）。
- [x] 是否在事务提交后：`done` 在 `tx.commit()` 之后（notes_exporter.rs:2634-2650）；其余进度帧在同一个导入事务内、提交前发出，仅作 UI 进度，不代表已持久化。
- [x] 目标窗口（emit / emit_to / emit_filter）：progress 回调持有调用命令的 `Window`，`window_clone.emit(...)` 只发给发起导入的窗口（cmd/notes.rs:2559-2581）；Host 用 `emitTo({kind:'Window', label: call.source.window})`（host/plugins/notes/index.ts:621-627）。

## 事件 `notes:format-changed`

<!-- BEGIN GENERATED:event:notes:format-changed -->
- 事件名 `notes:format-changed`
- 发送点：`src-tauri/src/cmd/notes.rs:644`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:691`（emit）
<!-- END GENERATED:event:notes:format-changed -->

- [x] 载荷：两种形状——`notes_enable_columns` 发 `NoteFormatStatus { note_id, content_format, format_version, serializer_version, baseline_version_id, required_capabilities, updated_at }`（`NoteFormat` flatten，cmd/notes.rs:599-607、629-645）；`notes_migrate_blocks` 发完整 `VfsNote`（cmd/notes.rs:678-692）。契约以 `anyOf` 标注该差异。
- [x] 触发时机与顺序：写事务 `note_write_storage(...).await?` 返回后 emit，先于命令结果返回：enable_columns 在 `NoteRevisionRepo::transaction` 提交后（cmd/notes.rs:629-645），migrate_blocks 在 `NoteFormatRepo::migrate` 返回后（cmd/notes.rs:678-692）。Host 顺序一致（host/plugins/notes/index.ts:307-325）。
- [x] 节流/合并：无；每次成功命令一条。
- [x] 是否在事务提交后：是；事件在存储闭包/事务结束并成功后发出，失败路径 `?` 提前返回不发事件。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:644、691）。

## 事件 `notes:lease-changed`

<!-- BEGIN GENERATED:event:notes:lease-changed -->
- 事件名 `notes:lease-changed`
- 发送点：`src-tauri/src/cmd/notes.rs:364`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:418`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:454`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:490`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:506`（emit）
<!-- END GENERATED:event:notes:lease-changed -->

- [x] 载荷：`LeaseStatus { token, operation_id, owner_id, phase, expires_at, notes: [{ note_id, updated_at }], waiting_for: string[] }`（note_lease_repo.rs:33-42）。`notes_editor_register` 只发 `status.active_lease`（仍是 LeaseStatus，不是 ParticipantStatus，cmd/notes.rs:351-366）。
- [x] 触发时机与顺序：register / begin / freeze_ack 成功 / finish / refresh_ack 各在对应 `note_storage(...).await?` 成功后、命令返回前 emit（cmd/notes.rs:351-366、398-420、429-456、479-492、494-507）；freeze_ack 冲突路径不成功返回，改发 lease-ended 后以冲突结束。
- [x] 节流/合并：无；每个成功命令一条。
- [x] 是否在事务提交后：是；`note_storage` 的写操作已在 SQLite 连接内完成（savepoint release）后返回，emit 在其后。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:364、418、454、490、506）；Host 同用 `ctx.backendEvents.emit`（host/plugins/notes/index.ts:405-476）。

## 事件 `notes:lease-ended`

<!-- BEGIN GENERATED:event:notes:lease-ended -->
- 事件名 `notes:lease-ended`
- 发送点：`src-tauri/src/cmd/notes.rs:393`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:448`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:522`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:548`（emit）
<!-- END GENERATED:event:notes:lease-ended -->

- [x] 载荷：`LeaseCancellation { token, note_ids: string[], reason }`（note_lease_repo.rs:50-54）。契约对 cleanup 的动态事件载荷标注 unresolved，但运行期仍为该结构。
- [x] 触发时机与顺序：`notes_editor_unregister` 对返回的每个 cancellation 依次 emit（cmd/notes.rs:381-395）；`notes_editor_release` 在 release 成功后 emit 一条（cmd/notes.rs:510-523）；`notes_editor_freeze_ack` 的 stale/divergent 冲突在删除 lease 的 transaction 后、错误返回前 emit（cmd/notes.rs:429-456）；TTL/窗口销毁清理由 `cleanup_note_editor_leases` 后台逐条 emit（cmd/notes.rs:526-553；lib.rs:491、707、1352）。
- [x] 节流/合并：无；每条 cancellation 一条事件。
- [x] 是否在事务提交后：unregister/release/cleanup 在存储闭包成功返回后发出；freeze_ack 冲突路径在 `remove` 事务返回后、命令以 Conflict 失败前发出（事件代表 lease 已删除，命令结果仍是错误）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:393、448、522、548）；Host 同用 `ctx.backendEvents.emit`（host/plugins/notes/index.ts:416-479）。

## 事件 `notes:review-saved`

<!-- BEGIN GENERATED:event:notes:review-saved -->
- 事件名 `notes:review-saved`
- 发送点：`src-tauri/src/cmd/notes.rs:673`（emit）
<!-- END GENERATED:event:notes:review-saved -->

- [x] 载荷：`ReviewSaveResult { noteId, revision, markdown, updatedAt }`（camelCase，note_review_repo.rs:24-31）。
- [x] 触发时机与顺序：`notes_review_save_as` 在 `note_write_storage(...).await?` 成功后 emit，然后才返回结果（cmd/notes.rs:649-675）；Host 顺序一致（host/plugins/notes/index.ts:395-401）。
- [x] 节流/合并：无；每次成功保存一条。
- [x] 是否在事务提交后：是；`save_as` 内的 revision transaction 已结束并成功（note_review_repo.rs:35-43）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:673）。

## 事件 `notes:state-changed`

<!-- BEGIN GENERATED:event:notes:state-changed -->
- 事件名 `notes:state-changed`
- 发送点：`src-tauri/src/cmd/notes.rs:717`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:727`（emit）
<!-- END GENERATED:event:notes:state-changed -->

- [x] 载荷：`NoteState { note_id, type: "review"|"draft", key, value, revision, deleted, updated_at }`（note_state_repo.rs:57-65）。put 发新行；delete 发 tombstone（`deleted=true`，保留 revision 供重开 WebView 取 CAS token，note_state_repo.rs:78）。
- [x] 触发时机与顺序：`notes_state_put`/`notes_state_delete` 在 `note_storage(...).await?` 成功后 emit，再返回同一行（cmd/notes.rs:711-730）；get/list 不发事件。
- [x] 节流/合并：无；每次成功写入一条。
- [x] 是否在事务提交后：是；存储闭包返回即事务结束（put/delete 为单条 upsert/update）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:717、727）；Host 同用 `ctx.backendEvents.emit`（host/plugins/notes/index.ts:187-197）。

## 事件 `notes:transfer-completed`

<!-- BEGIN GENERATED:event:notes:transfer-completed -->
- 事件名 `notes:transfer-completed`
- 发送点：`src-tauri/src/cmd/notes.rs:568`（emit）
- 发送点：`src-tauri/src/cmd/notes.rs:591`（emit）
<!-- END GENERATED:event:notes:transfer-completed -->

- [x] 载荷：`TransferResult { operation_id, source_note_id, target_note_id, source_updated_at, target_updated_at, source_version_id, target_version_id, undone }`（snake_case，note_transfer_repo.rs:29-38）。
- [x] 触发时机与顺序：`notes_transfer_blocks` 与 `notes_undo_transfer` 各在 `note_write_storage(...).await?` 成功后 emit，再返回结果（cmd/notes.rs:557-593）；Host 顺序一致（host/plugins/notes/index.ts:376-390）。
- [x] 节流/合并：无；每次成功命令一条。
- [x] 是否在事务提交后：是；transfer/undo 的写事务已结束并成功。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit(...)`，广播到所有窗口/WebView（cmd/notes.rs:568、591）。

## 事件 `todo://changed`

<!-- BEGIN GENERATED:event:todo://changed -->
- 事件名 `todo://changed`
- 发送点：`src-tauri/src/chat_v2/tools/user_todo_executor.rs:274`（emit）
<!-- END GENERATED:event:todo://changed -->

- [x] 载荷：`{ source: "agent", action: string, entityIds: string[], runId: string }`；`runId = tool_call_id 非空 ? tool_call_id : block_id`（user_todo_executor.rs:262-280；executor.rs:366-371）。契约对历史 emitter 兼容为 source/action/entityIds 可缺省，但当前执行器恒发四字段。
- [x] 触发时机与顺序：每个成功的 todo 变更（create/update/delete/complete/restore/reorder 等）在仓储写入后、返回 `ToolResultInfo` 前 emit（user_todo_executor.rs:274；Host 同构于 host/plugins/notes/src/user-todo-tool.ts:503-516）。无前端窗口（headless）时直接跳过（user_todo_executor.rs:265-269）。
- [x] 节流/合并：无；每次工具调用至多一条。
- [x] 是否在事务提交后：是；emit 位于对应仓储方法成功返回之后。
- [x] 目标窗口（emit / emit_to / emit_filter）：`window.emit(...)`，只发给执行工具的窗口（user_todo_executor.rs:274）；Host `ctx.host.emit` 走同一调用窗口（user-todo-tool.ts:513）。
