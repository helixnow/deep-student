# L13-vfs-api：VFS 与 DSTU API

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L13-vfs-api（VFS 与 DSTU API） |
| 目录 | `host/plugins/vfs/` |
| Rust 范围（lanes.md） | vfs 的 handlers（91 个命令）、ref_handlers、question_sync、dstu（54 个命令），以及其余资源类工具 |
| 主要提供 | **`vfs@1`（H18 里程碑）**、`dstu@1` |
| 主要消费 | L11、L12、F3 |
| 特别注意 | 命令最多；filestream 和 pdfstream 协议的数据源 |
| 规模（本目录） | 56197 行 · 63 个文件 · 214 个命令（前端调用 131） · 381 个测试 |
| 规模（整条 lane，inventory） | 56197 行 · 63 个文件 · 214 个命令（前端 131） · 381 个测试 |
| 契约 | [`contracts/ipc/L13-vfs-api.json`](../../../contracts/ipc/L13-vfs-api.json) |
| 服务草稿 | [`contracts/services/DRAFT-L13-vfs-api.md`](../../../contracts/services/DRAFT-L13-vfs-api.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-vfs/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/error.rs` | 162 | 2 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/exam_formatter.rs` | 373 | 3 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/essay_adapter.rs` | 181 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/exam_adapter.rs` | 167 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/file_adapter.rs` | 133 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/image_adapter.rs` | 91 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/mindmap_adapter.rs` | 151 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs` | 628 | 0 | 2 |
| `src-tauri/crates/dstu-vfs/src/dstu/export/note_adapter.rs` | 91 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/textbook_adapter.rs` | 135 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/export/translation_adapter.rs` | 138 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs` | 1109 | 10 | 16 |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` | 842 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/crud.rs` | 270 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` | 456 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs` | 379 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/mod.rs` | 64 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs` | 751 | 21 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/path_utils.rs` | 155 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` | 1125 | 3 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs` | 6751 | 6 | 31 |
| `src-tauri/crates/dstu-vfs/src/dstu/mod.rs` | 144 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/path_parser.rs` | 741 | 38 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/path_types.rs` | 413 | 11 |  |
| `src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs` | 919 | 0 | 5 |
| `src-tauri/crates/dstu-vfs/src/dstu/types.rs` | 1019 | 12 |  |
| `src-tauri/crates/dstu-vfs/src/file_stream_protocol.rs` | 1276 | 16 | 1 |
| `src-tauri/crates/dstu-vfs/src/lib.rs` | 41 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/pdf_protocol.rs` | 962 | 12 |  |
| `src-tauri/crates/dstu-vfs/src/textbooks_db.rs` | 136 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vector_store.rs` | 98 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/attachment_config.rs` | 139 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/database.rs` | 1431 | 25 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/error.rs` | 402 | 5 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs` | 8307 | 21 | 91 |
| `src-tauri/crates/dstu-vfs/src/vfs/hooks.rs` | 158 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs` | 313 | 0 | 7 |
| `src-tauri/crates/dstu-vfs/src/vfs/index_service.rs` | 646 | 5 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/lexical_bm25.rs` | 280 | 7 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/media_index.rs` | 641 | 8 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/mod.rs` | 202 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/note_props.rs` | 416 | 10 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/ocr_utils.rs` | 235 | 2 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` | 143 | 0 | 7 |
| `src-tauri/crates/dstu-vfs/src/vfs/qbank_helpers.rs` | 149 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/qbank_read.rs` | 65 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/qbank_types.rs` | 29 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/question_sync_service.rs` | 2297 | 4 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs` | 2647 | 27 | 3 |
| `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs` | 1319 | 6 | 51 |
| `src-tauri/crates/dstu-vfs/src/vfs/types.rs` | 3252 | 16 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/unit_builder/builders.rs` | 987 | 10 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/unit_builder/mod.rs` | 13 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/unit_builder/registry.rs` | 77 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/unit_builder/trait_def.rs` | 45 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/upload_saga.rs` | 699 | 9 |  |
| `src-tauri/src/chat_v2/tools/attachment_executor.rs` | 934 | 8 |  |
| `src-tauri/src/chat_v2/tools/builtin_resource_executor.rs` | 6103 | 15 |  |
| `src-tauri/src/chat_v2/tools/builtin_retrieval_executor.rs` | 2115 | 20 |  |
| `src-tauri/src/chat_v2/tools/dstu_executor.rs` | 1036 | 8 |  |
| `src-tauri/src/chat_v2/tools/generative_ui_executor.rs` | 1114 | 38 |  |
| `src-tauri/src/chat_v2/tools/mod.rs` | 84 | 0 |  |

### 命令（214）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `dstu_batch_move` | `crates/dstu-vfs/src/dstu/handlers.rs:6297` | async | app | src/dstu/api/pathApi.ts:171 | (request: BatchMoveRequest) → BatchMoveResult ! string |
| `dstu_build_path` | `crates/dstu-vfs/src/dstu/handlers.rs:5929` | async | app | src/dstu/api/pathApi.ts:65 | (folderId?: string \| null, resourceId: string) → string ! string |
| `dstu_copy` | `crates/dstu-vfs/src/dstu/handlers.rs:2243` | async | app | src/dstu/api.ts:558 | (src: string, dst: string) → DstuNode ! string |
| `dstu_create` | `crates/dstu-vfs/src/dstu/handlers.rs:726` | async | app | src/dstu/api.ts:336 | (path: string, options: DstuCreateOptions) → DstuNode ! string |
| `dstu_delete` | `crates/dstu-vfs/src/dstu/handlers.rs:1663` | async | app | src/dstu/api.ts:444 | (path: string) → null ! string |
| `dstu_delete_many` | `crates/dstu-vfs/src/dstu/handlers.rs:5264` | async | app | src/dstu/api.ts:827 | (paths: string[]) → integer(usize) ! string |
| `dstu_empty_trash` | `crates/dstu-vfs/src/dstu/trash_handlers.rs:641` | async | app | src/dstu/api/trashApi.ts:107 | (itemTypes?: string[] \| null) → integer(usize) ! DstuError |
| `dstu_export` | `crates/dstu-vfs/src/dstu/export/mod.rs:303` | async | app | src/dstu/api.ts:1098 | (path: string, format: string) → DstuExportResult ! string |
| `dstu_export_formats` | `crates/dstu-vfs/src/dstu/export/mod.rs:275` | async | app | src/dstu/api.ts:1077 | (path: string) → string[] ! string |
| `dstu_folder_add_item` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:471` | async | app | src/dstu/api/folderApi.ts:222 | (folderId?: string \| null, itemType: string, itemId: string) → VfsFolderItem ! string |
| `dstu_folder_create` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:135` | async | app | src/dstu/api/folderApi.ts:77 | (title: string, parentId?: string \| null, icon?: string \| null, color?: string \| null) → VfsFolder ! string |
| `dstu_folder_delete` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:336` | async | app | src/dstu/api/folderApi.ts:138 | (folderId: string) → null ! string |
| `dstu_folder_get` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:233` | async | app | src/dstu/api/folderApi.ts:99 | (folderId: string) → VfsFolder \| null ! string |
| `dstu_folder_get_all_resources` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:762` | async | app | src/dstu/api/folderApi.ts:365 | (folderId: string, includeSubfolders: boolean, includeContent: boolean) → FolderResourcesResult ! string |
| `dstu_folder_get_breadcrumbs` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:910` | async | app | src/dstu/api/folderApi.ts:421 | (folderId: string) → BreadcrumbItem[] ! string |
| `dstu_folder_get_items` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:704` | async | app | src/dstu/api/folderApi.ts:341 | (folderId?: string \| null) → VfsFolderItem[] ! string |
| `dstu_folder_get_tree` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:669` | async | app | src/dstu/api/folderApi.ts:327 | (（无）) → FolderTreeNode[] ! string |
| `dstu_folder_list` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:637` | async | app | src/dstu/api/folderApi.ts:313 | (（无）) → VfsFolder[] ! string |
| `dstu_folder_move` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:382` | async | app | src/dstu/api/folderApi.ts:165 | (folderId: string, newParentId?: string \| null) → null ! string |
| `dstu_folder_move_item` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:588` | async | app | src/dstu/api/folderApi.ts:276 | (itemType: string, itemId: string, newFolderId?: string \| null) → null ! string |
| `dstu_folder_remove_item` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:553` | async | app | src/dstu/api/folderApi.ts:243 | (itemType: string, itemId: string) → null ! string |
| `dstu_folder_rename` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:273` | async | app | src/dstu/api/folderApi.ts:118 | (folderId: string, title: string) → null ! string |
| `dstu_folder_reorder` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:817` | async | app | src/dstu/api/folderApi.ts:387 | (folderIds: string[]) → null ! string |
| `dstu_folder_reorder_items` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:858` | async | app | src/dstu/api/folderApi.ts:437 | (folderId?: string \| null, itemIds: string[]) → null ! string |
| `dstu_folder_set_expanded` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:424` | async | app | src/dstu/api/folderApi.ts:197 | (folderId: string, isExpanded: boolean) → null ! string |
| `dstu_get` | `crates/dstu-vfs/src/dstu/handlers.rs:467` | async | app | src/dstu/api.ts:277<br>src/features/chat/components/MediaCitationBadge.tsx:23 | (path: string) → DstuNode \| null ! string |
| `dstu_get_content` | `crates/dstu-vfs/src/dstu/handlers.rs:3289` | async | app | src/dstu/api.ts:627 | (path: string) → string ! string |
| `dstu_get_exam_content` | `crates/dstu-vfs/src/dstu/handlers.rs:3323` | async | none | — | (examId: string, isMultimodal: boolean) → ContentBlock[] ! string |
| `dstu_get_path_by_id` | `crates/dstu-vfs/src/dstu/handlers.rs:6625` | async | app | src/dstu/api/pathApi.ts:229 | (resourceId: string) → string ! string |
| `dstu_get_resource_by_path` | `crates/dstu-vfs/src/dstu/handlers.rs:6042` | async | app | src/dstu/api/pathApi.ts:108 | (path: string) → DstuNode \| null ! string |
| `dstu_get_resource_location` | `crates/dstu-vfs/src/dstu/handlers.rs:5973` | async | app | src/dstu/api/pathApi.ts:90 | (resourceId: string) → ResourceLocation ! string |
| `dstu_list` | `crates/dstu-vfs/src/dstu/handlers.rs:171` | async | app | src/dstu/api.ts:258 | (path: string, options?: DstuListOptions \| null) → DstuNode[] ! string |
| `dstu_list_deleted` | `crates/dstu-vfs/src/dstu/handlers.rs:4857` | async | app | src/dstu/api.ts:1013 | (resourceType: string, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → DstuNode[] ! string |
| `dstu_list_trash` | `crates/dstu-vfs/src/dstu/trash_handlers.rs:237` | async | app | src/dstu/api/trashApi.ts:88 | (limit?: integer(u32) \| null, offset?: integer(u32) \| null, itemTypes?: string[] \| null) → DstuNode[] ! DstuError |
| `dstu_move` | `crates/dstu-vfs/src/dstu/handlers.rs:1770` | async | app | src/dstu/api.ts:472 | (src: string, dst: string) → DstuNode ! string |
| `dstu_move_many` | `crates/dstu-vfs/src/dstu/handlers.rs:5530` | async | app | src/dstu/api.ts:895 | (paths: string[], destFolder: string) → integer(usize) ! string |
| `dstu_move_to_folder` | `crates/dstu-vfs/src/dstu/handlers.rs:6137` | async | app | src/dstu/api/pathApi.ts:141 | (resourceId: string, targetFolderId?: string \| null) → ResourceLocation ! string |
| `dstu_parse_path` | `crates/dstu-vfs/src/dstu/handlers.rs:5851` | async | app | src/dstu/api/pathApi.ts:43 | (path: string) → DstuParsedPath ! string |
| `dstu_permanently_delete` | `crates/dstu-vfs/src/dstu/trash_handlers.rs:798` | async | app | src/dstu/api/trashApi.ts:126 | (id: string, itemType: string) → null ! DstuError |
| `dstu_purge` | `crates/dstu-vfs/src/dstu/handlers.rs:4459` | async | app | src/dstu/api.ts:985 | (path: string) → null ! string |
| `dstu_purge_all` | `crates/dstu-vfs/src/dstu/handlers.rs:5141` | async | app | src/dstu/api.ts:1035 | (resourceType: string) → integer(usize) ! string |
| `dstu_refresh_path_cache` | `crates/dstu-vfs/src/dstu/handlers.rs:6516` | async | app | src/dstu/api/pathApi.ts:209 | (resourceId?: string \| null) → integer(usize) ! string |
| `dstu_rename` | `crates/dstu-vfs/src/dstu/handlers.rs:1879` | async | app | src/dstu/api.ts:508 | (path: string, newName: string) → DstuNode ! string |
| `dstu_restore` | `crates/dstu-vfs/src/dstu/handlers.rs:4234` | async | app | src/dstu/api.ts:956 | (path: string) → DstuNode ! string |
| `dstu_restore_many` | `crates/dstu-vfs/src/dstu/handlers.rs:5427` | async | app | src/dstu/api.ts:860 | (paths: string[]) → integer(usize) ! string |
| `dstu_search` | `crates/dstu-vfs/src/dstu/handlers.rs:3269` | async | app | src/dstu/api.ts:609 | (query: string, options?: DstuListOptions \| null) → DstuNode[] ! string |
| `dstu_search_in_folder` | `crates/dstu-vfs/src/dstu/handlers.rs:5654` | async | app | src/dstu/api.ts:931 | (folderId?: string \| null, query: string, options?: DstuListOptions \| null) → DstuNode[] ! string |
| `dstu_set_favorite` | `crates/dstu-vfs/src/dstu/handlers.rs:4554` | async | app | src/dstu/api.ts:698 | (path: string, favorite: boolean) → null ! string |
| `dstu_set_metadata` | `crates/dstu-vfs/src/dstu/handlers.rs:3348` | async | app | src/dstu/api.ts:667 | (path: string, metadata: Value, expectedUpdatedAt?: string \| null) → null ! string |
| `dstu_soft_delete` | `crates/dstu-vfs/src/dstu/trash_handlers.rs:113` | async | app | src/dstu/api/trashApi.ts:52 | (id: string, itemType: string) → null ! DstuError |
| `dstu_trash_restore` | `crates/dstu-vfs/src/dstu/trash_handlers.rs:180` | async | app | src/dstu/api/trashApi.ts:68 | (id: string, itemType: string) → null ! DstuError |
| `dstu_unwatch` | `crates/dstu-vfs/src/dstu/handlers.rs:5634` | async | app | src/dstu/api.ts:738<br>src/dstu/api.ts:804 | (path: string) → null ! string |
| `dstu_update` | `crates/dstu-vfs/src/dstu/handlers.rs:1438` | async | app | src/dstu/api.ts:405 | (path: string, content: string, resourceType: string, expectedUpdatedAtMs?: integer(i64) \| null, lease?: NoteLeaseAuth \| null) → DstuNode ! string |
| `dstu_watch` | `crates/dstu-vfs/src/dstu/handlers.rs:5627` | async | app | src/dstu/api.ts:735 | (path: string) → null ! string |
| `filestream_check_access` | `crates/dstu-vfs/src/file_stream_protocol.rs:718` | async | app | src/features/learning-hub/apps/views/FileContentView.tsx:479 | (path: string) → boolean ! string |
| `pomodoro_create_record` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1175` | async | app | src/features/pomodoro/api.ts:53 | (input: CreatePomodoroInput) → PomodoroRecord ! string |
| `pomodoro_daily_stats` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1247` | async | app | src/features/pomodoro/api.ts:74 | (days?: integer(u32) \| null) → PomodoroDailyStat[] ! string |
| `pomodoro_delete_record` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:23` | async | app | src/features/pomodoro/api.ts:79 | (recordId: string) → null ! string |
| `pomodoro_get_record` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1204` | async | app | src/features/pomodoro/api.ts:57 | (recordId: string) → PomodoroRecord \| null ! string |
| `pomodoro_hourly_stats` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:77` | async | none | — | (days?: integer(u32) \| null) → PomodoroHourlyStat[] ! string |
| `pomodoro_list_by_todo` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1216` | async | app | src/features/pomodoro/api.ts:61 | (todoItemId: string) → PomodoroRecord[] ! string |
| `pomodoro_list_range` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:48` | async | app | src/features/pomodoro/api.ts:87 | (startDate: string, endDate: string) → PomodoroRecord[] ! string |
| `pomodoro_list_today` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1237` | async | app | src/features/pomodoro/api.ts:69 | (（无）) → PomodoroRecord[] ! string |
| `pomodoro_stats_by_todo` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:93` | async | none | — | (startDate?: string \| null, endDate?: string \| null, limit?: integer(u32) \| null) → PomodoroTodoStat[] ! string |
| `pomodoro_stats_overview` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:117` | async | none | — | (days?: integer(u32) \| null) → PomodoroStatsOverview ! string |
| `pomodoro_streak` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:65` | async | none | — | (（无）) → PomodoroStreakStats ! string |
| `pomodoro_today_stats` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1228` | async | app | src/features/pomodoro/api.ts:65 | (（无）) → PomodoroTodayStats ! string |
| `pomodoro_todo_focus_summary` | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:132` | async | none | — | (todoItemId: string) → PomodoroTodoFocusSummary ! string |
| `todo_ai_breakdown` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:1007` | async | none | — | (itemId: string) → VfsTodoItem[] ! CommandError |
| `todo_batch_complete` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:750` | async | none | — | (itemIds: string[]) → TodoBatchItemsResult ! CommandError |
| `todo_batch_delete` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:831` | async | none | — | (itemIds: string[]) → TodoBatchIdsResult ! CommandError |
| `todo_batch_move` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:811` | async | none | — | (itemIds: string[], targetListId: string) → TodoBatchItemsResult ! CommandError |
| `todo_batch_purge` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:868` | async | none | — | (itemIds: string[]) → TodoBatchIdsResult ! CommandError |
| `todo_batch_reschedule` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:769` | async | none | — | (itemIds: string[], dueDate?: string \| null, dueTime?: string \| null) → TodoBatchItemsResult ! CommandError |
| `todo_batch_restore` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:849` | async | none | — | (itemIds: string[]) → TodoBatchItemsResult ! CommandError |
| `todo_batch_set_priority` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:791` | async | none | — | (itemIds: string[], priority: string) → TodoBatchItemsResult ! CommandError |
| `todo_counts_snapshot` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:730` | async | none | — | (（无）) → TodoCountsSnapshot ! CommandError |
| `todo_create_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:452` | async | none | — | (input: CreateTodoItemInput) → VfsTodoItem ! CommandError |
| `todo_create_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:231` | async | none | — | (input: CreateTodoListInput) → VfsTodoList ! CommandError |
| `todo_delete_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:564` | async | none | — | (itemId: string) → null ! CommandError |
| `todo_delete_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:293` | async | none | — | (listId: string) → null ! CommandError |
| `todo_ensure_inbox` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:317` | async | none | — | (title?: string \| null) → VfsTodoList ! CommandError |
| `todo_get_active_summary` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:717` | async | none | — | (（无）) → TodoActiveSummary \| null ! CommandError |
| `todo_get_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:480` | async | none | — | (itemId: string) → VfsTodoItem \| null ! CommandError |
| `todo_get_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:254` | async | none | — | (listId: string) → VfsTodoList \| null ! CommandError |
| `todo_list_all_pending` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:669` | async | none | — | (（无）) → VfsTodoItem[] ! CommandError |
| `todo_list_all_tags` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:916` | async | none | — | (（无）) → TagCountEntry[] ! CommandError |
| `todo_list_completed` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:679` | async | none | — | (listId?: string \| null) → VfsTodoItem[] ! CommandError |
| `todo_list_deleted_items` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:408` | async | none | — | (limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoItem[] ! CommandError |
| `todo_list_deleted_lists` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:344` | async | none | — | (limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoList[] ! CommandError |
| `todo_list_items` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:492` | async | none | — | (listId: string, includeCompleted: boolean, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoItem[] ! CommandError |
| `todo_list_items_with_stats` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:927` | async | none | — | (listId: string, includeCompleted: boolean, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → TodoItemWithChildStats[] ! CommandError |
| `todo_list_lists` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:263` | async | none | — | (（无）) → VfsTodoList[] ! CommandError |
| `todo_list_overdue` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:629` | async | none | — | (includeCompleted: boolean, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoItem[] ! CommandError |
| `todo_list_reminders` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:659` | async | none | — | (（无）) → VfsTodoItem[] ! CommandError |
| `todo_list_today` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:612` | async | none | — | (includeCompleted: boolean, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoItem[] ! CommandError |
| `todo_list_upcoming` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:644` | async | none | — | (days: integer(i64), includeCompleted: boolean) → VfsTodoItem[] ! CommandError |
| `todo_move_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:594` | async | none | — | (input: MoveTodoItemInput) → VfsTodoItem ! CommandError |
| `todo_purge_deleted_items` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:434` | async | none | — | (（无）) → integer(usize) ! CommandError |
| `todo_purge_deleted_lists` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:382` | async | none | — | (（无）) → integer(usize) ! CommandError |
| `todo_purge_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:422` | async | none | — | (itemId: string) → null ! CommandError |
| `todo_purge_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:370` | async | none | — | (listId: string) → null ! CommandError |
| `todo_reorder_items` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:576` | async | none | — | (input: ReorderItemsInput) → null ! CommandError |
| `todo_reorder_lists` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:328` | async | none | — | (input: ReorderListsInput) → null ! CommandError |
| `todo_restore_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:396` | async | none | — | (itemId: string) → VfsTodoItem ! CommandError |
| `todo_restore_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:358` | async | none | — | (listId: string) → VfsTodoList ! CommandError |
| `todo_search` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:696` | async | none | — | (query: string, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsTodoItem[] ! CommandError |
| `todo_stats_overview` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:901` | async | none | — | (days?: integer(u32) \| null) → TodoStatsOverview ! CommandError |
| `todo_toggle_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:547` | async | none | — | (itemId: string, expectedUpdatedAt?: string \| null) → VfsTodoItem ! CommandError |
| `todo_toggle_list_favorite` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:305` | async | none | — | (listId: string) → VfsTodoList ! CommandError |
| `todo_trash_counts` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:886` | async | none | — | (（无）) → TodoTrashCounts ! CommandError |
| `todo_update_item` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:508` | async | none | — | (input: UpdateTodoItemInput) → VfsTodoItem ! CommandError |
| `todo_update_list` | `crates/dstu-vfs/src/vfs/todo_handlers.rs:272` | async | none | — | (input: UpdateTodoListInput) → VfsTodoList ! CommandError |
| `vfs_assign_dimension_model` | `crates/dstu-vfs/src/vfs/handlers.rs:3398` | async | app | src/api/vfsUnifiedIndexApi.ts:226 | (dimension: integer(i32), modality: string, modelConfigId: string, modelName: string) → boolean ! string |
| `vfs_batch_index_pending` | `crates/dstu-vfs/src/vfs/handlers.rs:3859` | async | app | src/api/vfsUnifiedIndexApi.ts:202 | (batchSize?: integer(u32) \| null) → dstu_vfs__vfs__handlers__BatchIndexResult ! string |
| `vfs_cancel_pdf_processing` | `crates/dstu-vfs/src/vfs/handlers.rs:6533` | async | app | src/api/vfsPdfProcessingApi.ts:164 | (fileId: string) → boolean ! string |
| `vfs_clear_default_embedding_dimension` | `crates/dstu-vfs/src/vfs/handlers.rs:3817` | async | app | src/api/vfsUnifiedIndexApi.ts:332 | (modality: string) → boolean ! string |
| `vfs_clear_media_cache` | `crates/dstu-vfs/src/vfs/handlers.rs:6975` | async | app | src/api/dataGovernance.ts:1272 | (params: ClearMediaCacheParams) → ClearMediaCacheResult ! string |
| `vfs_clear_resource_ocr` | `crates/dstu-vfs/src/vfs/handlers.rs:7783` | async | app | src/api/vfsUnifiedIndexApi.ts:389 | (resourceId: string) → boolean ! string |
| `vfs_create_attachment_root_folder` | `crates/dstu-vfs/src/vfs/handlers.rs:1679` | async | app | src/api/attachmentConfigApi.ts:18 | (title: string) → string ! string |
| `vfs_create_dimension` | `crates/dstu-vfs/src/vfs/handlers.rs:3495` | async | app | src/api/vfsUnifiedIndexApi.ts:252 | (dimension: integer(i32), modality: string, modelConfigId?: string \| null, modelName?: string \| null) → VfsEmbeddingDim ! string |
| `vfs_create_mindmap` | `crates/dstu-vfs/src/vfs/handlers.rs:5088` | async | none | — | (params: CreateMindMapInput) → VfsMindMap ! string |
| `vfs_create_note` | `crates/dstu-vfs/src/vfs/handlers.rs:460` | async | none | — | (params: CreateNoteInput) → VfsNote ! string |
| `vfs_create_or_reuse` | `crates/dstu-vfs/src/vfs/handlers.rs:300` | async | app | src/features/chat/resources/api.ts:147<br>src/services/resourceSyncService.ts:73 | (params: CreateResourceInput) → VfsCreateResourceResult ! string |
| `vfs_debug_index_status` | `crates/dstu-vfs/src/vfs/handlers.rs:5472` | async | app | src/api/vfsRagApi.ts:406 | (resourceId?: string \| null) → IndexDiagnosticInfo ! string |
| `vfs_decrement_ref` | `crates/dstu-vfs/src/vfs/handlers.rs:430` | async | app | src/features/chat/resources/api.ts:255 | (resourceId: string) → null ! string |
| `vfs_delete_attachment` | `crates/dstu-vfs/src/vfs/handlers.rs:1964` | async | app | src/features/chat/debug/attachmentPipelineTestPlugin.ts:1225 | (attachmentId: string) → null ! string |
| `vfs_delete_dimension` | `crates/dstu-vfs/src/vfs/handlers.rs:3581` | async | app | src/api/vfsUnifiedIndexApi.ts:271 | (dimension: integer(i32), modality: string) → DeleteDimensionResult ! string |
| `vfs_delete_file` | `crates/dstu-vfs/src/vfs/handlers.rs:2750` | async | app | src/api/vfsFileApi.ts:112 | (fileId: string) → null ! string |
| `vfs_delete_mindmap` | `crates/dstu-vfs/src/vfs/handlers.rs:5302` | async | none | — | (mindmapId: string) → null ! string |
| `vfs_delete_note` | `crates/dstu-vfs/src/vfs/handlers.rs:646` | async | none | — | (id: string) → null ! string |
| `vfs_delete_resource_index` | `crates/dstu-vfs/src/vfs/index_handlers.rs:201` | async | app | src/api/vfsUnifiedIndexApi.ts:154 | (resourceId: string) → DeleteIndexResult ! string |
| `vfs_diagnose_lance_schema` | `crates/dstu-vfs/src/vfs/handlers.rs:6472` | async | app | src/api/vfsRagApi.ts:995 | (modality?: string \| null) → LanceTableDiagnostic[] ! string |
| `vfs_download_paper` | `crates/dstu-vfs/src/vfs/handlers.rs:7340` | async | app | src/features/chat/plugins/blocks/paperSave.tsx:142 | (params: VfsDownloadPaperParams) → VfsDownloadPaperResult ! string |
| `vfs_get_all_index_status` | `crates/dstu-vfs/src/vfs/handlers.rs:4225` | async | app | src/api/vfsUnifiedIndexApi.ts:177 | (folderId?: string \| null, resourceType?: string \| null, stateFilter?: string \| null, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → dstu_vfs__vfs__handlers__IndexStatusSummary ! string |
| `vfs_get_attachment` | `crates/dstu-vfs/src/vfs/handlers.rs:1946` | async | app | src/features/learning-hub/apps/views/ImageContentView.tsx:346 | (attachmentId: string) → VfsAttachment \| null ! string |
| `vfs_get_attachment_config` | `crates/dstu-vfs/src/vfs/handlers.rs:1648` | async | app | src/api/attachmentConfigApi.ts:10 | (（无）) → AttachmentConfigOutput ! string |
| `vfs_get_attachment_content` | `crates/dstu-vfs/src/vfs/handlers.rs:1720` | async | app | src/components/QuestionInlineEditor.tsx:353<br>src/components/practice/paperExport.ts:53<br>src/components/question-types/imageAnswerUpload.ts:225<br>…共 11 处 | (attachmentId: string, maxBytes?: integer(u64) \| null) → VfsAttachmentContentResult ! string |
| `vfs_get_batch_pdf_processing_status` | `crates/dstu-vfs/src/vfs/handlers.rs:6628` | async | none | — | (fileIds: string[]) → object ! string |
| `vfs_get_blob_base64` | `crates/dstu-vfs/src/vfs/handlers.rs:2858` | async | app | src/features/chat/context/blobApi.ts:118 | (blobHash: string) → VfsBlobBase64Result ! string |
| `vfs_get_default_embedding_dimension` | `crates/dstu-vfs/src/vfs/handlers.rs:3763` | async | app | src/api/vfsUnifiedIndexApi.ts:318 | (modality: string) → VfsEmbeddingDim \| null ! string |
| `vfs_get_dimension_range` | `crates/dstu-vfs/src/vfs/handlers.rs:3675` | async | app | src/api/vfsUnifiedIndexApi.ts:284 | (（无）) → ?[] ! string |
| `vfs_get_embedding_readiness` | `crates/dstu-vfs/src/vfs/handlers.rs:4198` | async | app | src/features/learning-hub/embeddingReadiness.ts:33 | (（无）) → EmbeddingReadiness ! string |
| `vfs_get_embedding_stats` | `crates/dstu-vfs/src/vfs/handlers.rs:3318` | async | none | — | (（无）) → VfsEmbeddingStats ! string |
| `vfs_get_file` | `crates/dstu-vfs/src/vfs/handlers.rs:2714` | async | app | src/api/vfsFileApi.ts:96 | (fileId: string) → VfsFile \| null ! string |
| `vfs_get_file_content` | `crates/dstu-vfs/src/vfs/handlers.rs:2782` | async | app | src/api/vfsFileApi.ts:116 | (fileId: string) → VfsFileContentResult ! string |
| `vfs_get_index_status` | `crates/dstu-vfs/src/vfs/handlers.rs:3269` | async | none | — | (resourceId: string) → IndexState \| null ! string |
| `vfs_get_indexing_config` | `crates/dstu-vfs/src/vfs/handlers.rs:4053` | async | none | — | (key: string) → string \| null ! string |
| `vfs_get_lance_stats` | `crates/dstu-vfs/src/vfs/handlers.rs:4970` | async | app | src/api/vfsRagApi.ts:209 | (modality?: string \| null) → ?[][] ! string |
| `vfs_get_media_cache_stats` | `crates/dstu-vfs/src/vfs/handlers.rs:6813` | async | app | src/api/dataGovernance.ts:1262 | (（无）) → MediaCacheStats ! string |
| `vfs_get_mindmap` | `crates/dstu-vfs/src/vfs/handlers.rs:5115` | async | none | — | (mindmapId: string) → VfsMindMap \| null ! string |
| `vfs_get_mindmap_content` | `crates/dstu-vfs/src/vfs/handlers.rs:5134` | async | none | — | (mindmapId: string) → string \| null ! string |
| `vfs_get_mindmap_version` | `crates/dstu-vfs/src/vfs/handlers.rs:5231` | async | none | — | (versionId: string) → VfsMindMapVersion \| null ! string |
| `vfs_get_mindmap_version_content` | `crates/dstu-vfs/src/vfs/handlers.rs:5209` | async | none | — | (versionId: string) → string \| null ! string |
| `vfs_get_mindmap_versions` | `crates/dstu-vfs/src/vfs/handlers.rs:5155` | async | none | — | (mindmapId: string, limit?: integer(u32) \| null) → VfsMindMapVersion[] ! string |
| `vfs_get_note` | `crates/dstu-vfs/src/vfs/handlers.rs:567` | async | none | — | (id: string) → VfsNote \| null ! string |
| `vfs_get_note_content` | `crates/dstu-vfs/src/vfs/handlers.rs:592` | async | none | — | (id: string) → string \| null ! string |
| `vfs_get_or_create_attachment_root_folder` | `crates/dstu-vfs/src/vfs/handlers.rs:1688` | async | none | — | (（无）) → string ! string |
| `vfs_get_pdf_page_image` | `crates/dstu-vfs/src/vfs/handlers.rs:3105` | async | app | src/api/vfsRagApi.ts:945 | (resourceId: string, pageIndex: integer(usize)) → VfsBlobBase64Result ! string |
| `vfs_get_pdf_processing_status` | `crates/dstu-vfs/src/vfs/handlers.rs:6504` | async | app | src/api/vfsPdfProcessingApi.ts:123 | (fileId: string) → ProcessingStatus \| null ! string |
| `vfs_get_pending_resources` | `crates/dstu-vfs/src/vfs/handlers.rs:3353` | async | none | — | (（无）) → string[] ! string |
| `vfs_get_preset_dimensions` | `crates/dstu-vfs/src/vfs/handlers.rs:3670` | async | app | src/api/vfsUnifiedIndexApi.ts:279 | (（无）) → integer(i32)[] ! string |
| `vfs_get_resource` | `crates/dstu-vfs/src/vfs/handlers.rs:355` | async | app | src/demo/app/data/chat/ChatWithSourcePane.tsx:77 (demo)<br>src/features/chat/pages/useChatPageEvents.ts:412<br>src/features/chat/pages/useChatPageEvents.ts:571<br>…共 11 处 | (resourceId: string) → VfsResource \| null ! string |
| `vfs_get_resource_ocr_info` | `crates/dstu-vfs/src/vfs/handlers.rs:7621` | async | app | src/api/vfsUnifiedIndexApi.ts:379 | (resourceId: string) → ResourceOcrInfo ! string |
| `vfs_get_resource_path` | `crates/dstu-vfs/src/vfs/handlers.rs:1043` | async | app | src/features/chat/context/vfsRefApi.ts:180 | (sourceId: string) → string ! string |
| `vfs_get_resource_ref_count` | `crates/dstu-vfs/src/vfs/ref_handlers.rs:243` | async | app | src/features/chat/context/vfsRefApi.ts:538 | (sourceId: string) → integer(i32) ! string |
| `vfs_get_resource_refs` | `crates/dstu-vfs/src/vfs/ref_handlers.rs:52` | async | app | src/features/chat/context/vfsRefApi.ts:158 | (params: GetResourceRefsInput) → VfsContextRefData ! string |
| `vfs_get_resource_text_chunks` | `crates/dstu-vfs/src/vfs/handlers.rs:7860` | async | app | src/api/vfsUnifiedIndexApi.ts:397 | (resourceId: string) → TextChunkInfo[] ! string |
| `vfs_get_resource_units` | `crates/dstu-vfs/src/vfs/index_handlers.rs:27` | async | app | src/api/vfsUnifiedIndexApi.ts:99 | (resourceId: string) → UnitIndexStatus[] ! string |
| `vfs_increment_ref` | `crates/dstu-vfs/src/vfs/handlers.rs:404` | async | app | src/features/chat/resources/api.ts:242 | (resourceId: string) → null ! string |
| `vfs_inspect_retrieval_capabilities` | `crates/dstu-vfs/src/vfs/handlers.rs:6354` | async | app | src/api/vfsRagApi.ts:816 | (（无）) → CapabilitySnapshot ! string |
| `vfs_list_dimensions` | `crates/dstu-vfs/src/vfs/handlers.rs:3329` | async | app | src/api/vfsUnifiedIndexApi.ts:210 | (（无）) → VfsEmbeddingDimension[] ! string |
| `vfs_list_embedding_dims` | `crates/dstu-vfs/src/vfs/index_handlers.rs:287` | async | app | src/api/vfsUnifiedIndexApi.ts:161 | (（无）) → EmbeddingDimInfo[] ! string |
| `vfs_list_essays` | `crates/dstu-vfs/src/vfs/handlers.rs:779` | async | none | — | (params?: ListInput \| null) → VfsEssay[] ! string |
| `vfs_list_exam_sheets` | `crates/dstu-vfs/src/vfs/handlers.rs:717` | async | none | — | (params?: ListInput \| null) → VfsExamSheet[] ! string |
| `vfs_list_files` | `crates/dstu-vfs/src/vfs/handlers.rs:2728` | async | app | src/api/vfsFileApi.ts:104<br>src/components/AiQuestionGenerationPanel.tsx:243 | (fileType?: string \| null, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → VfsFile[] ! string |
| `vfs_list_mindmaps` | `crates/dstu-vfs/src/vfs/handlers.rs:5321` | async | none | — | (（无）) → VfsMindMap[] ! string |
| `vfs_list_notes` | `crates/dstu-vfs/src/vfs/handlers.rs:614` | async | none | — | (params?: ListInput \| null) → VfsNote[] ! string |
| `vfs_list_pending_pdf_processing` | `crates/dstu-vfs/src/vfs/handlers.rs:6685` | async | none | — | (limit?: integer(u32) \| null) → VfsFile[] ! string |
| `vfs_list_textbooks` | `crates/dstu-vfs/src/vfs/handlers.rs:682` | async | none | — | (params?: ListInput \| null) → VfsTextbook[] ! string |
| `vfs_list_translations` | `crates/dstu-vfs/src/vfs/handlers.rs:747` | async | none | — | (params?: ListInput \| null) → VfsTranslation[] ! string |
| `vfs_multimodal_delete` | `crates/dstu-vfs/src/vfs/handlers.rs:6395` | async | app | src/api/vfsRagApi.ts:850 | (resourceId: string) → null ! string |
| `vfs_multimodal_index` | `crates/dstu-vfs/src/vfs/handlers.rs:6080` | async | app | src/api/vfsRagApi.ts:724 | (params: VfsMultimodalIndexInput) → VfsMultimodalIndexOutput ! string |
| `vfs_multimodal_index_resource` | `crates/dstu-vfs/src/vfs/handlers.rs:6419` | async | app | src/api/vfsRagApi.ts:894 | (sourceType: string, sourceId: string, folderId?: string \| null, forceRebuild?: boolean \| null) → Value ! string |
| `vfs_multimodal_search` | `crates/dstu-vfs/src/vfs/handlers.rs:6295` | async | app | src/api/vfsRagApi.ts:785 | (params: VfsMultimodalSearchInput) → VfsMultimodalSearchOutput[] ! string |
| `vfs_multimodal_search_detailed` | `crates/dstu-vfs/src/vfs/handlers.rs:6337` | async | app | src/api/vfsRagApi.ts:804 | (params: VfsMultimodalSearchInput) → UnifiedRetrievalResponse ! string |
| `vfs_multimodal_stats` | `crates/dstu-vfs/src/vfs/handlers.rs:6372` | async | app | src/api/vfsRagApi.ts:832 | (（无）) → Value ! string |
| `vfs_optimize_lance` | `crates/dstu-vfs/src/vfs/handlers.rs:4989` | async | app | src/api/vfsRagApi.ts:233 | (modality?: string \| null) → integer(usize) ! string |
| `vfs_rag_search` | `crates/dstu-vfs/src/vfs/handlers.rs:4889` | async | app | src/api/vfsRagApi.ts:121 | (input: VfsRagSearchInput) → VfsRagSearchOutput ! string |
| `vfs_reindex_resource` | `crates/dstu-vfs/src/vfs/handlers.rs:3153` | async | app | src/api/vfsUnifiedIndexApi.ts:194 | (resourceId: string, embeddingDim?: integer(i32) \| null) → integer(usize) ! string |
| `vfs_reindex_unit` | `crates/dstu-vfs/src/vfs/index_handlers.rs:39` | async | app | src/api/vfsUnifiedIndexApi.ts:106 | (unitId: string, mode: string) → boolean ! string |
| `vfs_reset_all_index_state` | `crates/dstu-vfs/src/vfs/handlers.rs:5922` | async | app | src/api/vfsRagApi.ts:464 | (（无）) → integer(i32) ! string |
| `vfs_reset_disabled_to_pending` | `crates/dstu-vfs/src/vfs/handlers.rs:5859` | async | app | src/api/vfsRagApi.ts:426 | (（无）) → integer(i32) ! string |
| `vfs_reset_indexed_without_embeddings` | `crates/dstu-vfs/src/vfs/handlers.rs:5885` | async | app | src/api/vfsRagApi.ts:444 | (（无）) → integer(i32) ! string |
| `vfs_resolve_resource_refs` | `crates/dstu-vfs/src/vfs/ref_handlers.rs:153` | async | app | src/features/chat/context/vfsRefApi.ts:171<br>src/features/chat/context/vfsRefApiEnhancements.ts:608<br>src/features/chat/plugins/blocks/ankiCardsBlock.tsx:491<br>…共 4 处 | (refs: VfsResourceRef__De[]) → ResolvedResource[] ! string |
| `vfs_resource_exists` | `crates/dstu-vfs/src/vfs/handlers.rs:378` | async | app | src/features/chat/resources/api.ts:229 | (resourceId: string) → boolean ! string |
| `vfs_restore_mindmap_version` | `crates/dstu-vfs/src/vfs/handlers.rs:5187` | async | none | — | (versionId: string) → VfsMindMap ! string |
| `vfs_retry_pdf_processing` | `crates/dstu-vfs/src/vfs/handlers.rs:6558` | async | app | src/api/vfsPdfProcessingApi.ts:185 | (fileId: string) → null ! string |
| `vfs_search` | `crates/dstu-vfs/src/vfs/handlers.rs:3132` | async | none | — | (params: VfsSearchParams) → VfsSearchResult[] ! string |
| `vfs_search_all` | `crates/dstu-vfs/src/vfs/handlers.rs:811` | async | none | — | (params: SearchAllInput) → VfsListItem[] ! string |
| `vfs_set_attachment_root_folder` | `crates/dstu-vfs/src/vfs/handlers.rs:1662` | async | app | src/api/attachmentConfigApi.ts:14 | (folderId: string) → null ! string |
| `vfs_set_default_embedding_dimension` | `crates/dstu-vfs/src/vfs/handlers.rs:3693` | async | app | src/api/vfsUnifiedIndexApi.ts:302 | (dimension: integer(i32), modality: string) → boolean ! string |
| `vfs_set_indexing_config` | `crates/dstu-vfs/src/vfs/handlers.rs:4043` | async | none | — | (key: string, value: string) → null ! string |
| `vfs_set_mindmap_favorite` | `crates/dstu-vfs/src/vfs/handlers.rs:5331` | async | none | — | (mindmapId: string, isFavorite: boolean) → null ! string |
| `vfs_start_pdf_processing` | `crates/dstu-vfs/src/vfs/handlers.rs:6592` | async | app | src/api/vfsPdfProcessingApi.ts:202 | (fileId: string, startFromStage?: string \| null) → null ! string |
| `vfs_sync_resource_units` | `crates/dstu-vfs/src/vfs/index_handlers.rs:164` | async | app | src/api/vfsUnifiedIndexApi.ts:123 | (resourceId: string, resourceType: string, data?: string \| null, ocrText?: string \| null, ocrPagesJson?: string \| null, blobHash?: string \| null, pageCount?: integer(i32) \| null, extractedText?: string \| null, previewJson?: string \| null) → UnitIndexStatus[] ! string |
| `vfs_toggle_index_disabled` | `crates/dstu-vfs/src/vfs/handlers.rs:3282` | async | none | — | (resourceId: string) → string ! string |
| `vfs_unified_batch_index` | `crates/dstu-vfs/src/vfs/index_handlers.rs:56` | async | app | src/api/vfsUnifiedIndexApi.ts:116 | (mode: string, batchSize?: integer(i32) \| null) → dstu_vfs__vfs__index_handlers__BatchIndexResult ! string |
| `vfs_unified_index_status` | `crates/dstu-vfs/src/vfs/index_handlers.rs:18` | async | app | src/api/vfsUnifiedIndexApi.ts:92 | (（无）) → dstu_vfs__vfs__index_service__IndexStatusSummary ! string |
| `vfs_update_mindmap` | `crates/dstu-vfs/src/vfs/handlers.rs:5250` | async | none | — | (mindmapId: string, params: UpdateMindMapInput) → VfsMindMap ! string |
| `vfs_update_note` | `crates/dstu-vfs/src/vfs/handlers.rs:516` | async | none | — | (id: string, params: UpdateNoteInput) → VfsNote ! string |
| `vfs_update_path_cache` | `crates/dstu-vfs/src/vfs/handlers.rs:1143` | async | app | src/features/chat/context/vfsRefApi.ts:189 | (folderId: string) → integer(u32) ! string |
| `vfs_upload_attachment` | `crates/dstu-vfs/src/vfs/handlers.rs:1327` | async | app | src/components/QuestionInlineEditor.tsx:400<br>src/components/question-types/imageAnswerUpload.ts:203<br>src/features/chat/context/vfsRefApi.ts:622<br>…共 5 处 | (params: VfsUploadAttachmentParamsExt) → VfsUploadAttachmentResult ! string |
| `vfs_upload_file` | `crates/dstu-vfs/src/vfs/handlers.rs:2107` | async | app | src/api/vfsFileApi.ts:92 | (params: VfsUploadFileParams) → VfsUploadFileResult ! string |

### 发出的事件（6）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `dstu:change` | 字面量 | crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:140 (emit) |
| `mm_index_progress` | 字面量 | crates/dstu-vfs/src/vfs/handlers.rs:6105 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:6447 (emit) |
| `pdf-annotations:changed` | 字面量 | crates/dstu-vfs/src/dstu/handlers.rs:3858 (emit) |
| `todo://changed` | 字面量 | crates/dstu-vfs/src/vfs/todo_handlers.rs:31 (emit) |
| `vfs-index-progress` | 字面量 | crates/dstu-vfs/src/vfs/handlers.rs:3189 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3223 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3242 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3255 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3903 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3941 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3968 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3991 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:4007 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:4024 (emit) |
| `event_name` | 动态（表达式） | crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:131 (emit) |

### 契约中的事件（6，`contracts/ipc/L13-vfs-api.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `todo://changed` | 否 | object \| object \| object | crates/dstu-vfs/src/vfs/todo_handlers.rs:31 (emit) |
| `vfs-index-progress` | 否 | object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object | crates/dstu-vfs/src/vfs/handlers.rs:3189 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3223 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3242 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3255 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3903 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3941 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3968 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:3991 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:4007 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:4024 (emit) |
| `dstu:change` | 否 | DstuWatchEvent \| object | crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:140 (emit) |
| `dstu:change:{}` | 是 | DstuWatchEvent \| object | crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:131 (emit) |
| `mm_index_progress` | 否 | IndexProgressEvent | crates/dstu-vfs/src/vfs/handlers.rs:6105 (emit)<br>crates/dstu-vfs/src/vfs/handlers.rs:6447 (emit) |
| `pdf-annotations:changed` | 否 | object \| object | crates/dstu-vfs/src/dstu/handlers.rs:3858 (emit) |
<!-- END GENERATED:lane -->

## 备注

### 当前拆分与公开服务

按当前派发，本工作树迁移 DSTU 54 命令、VFS 核心服务/API、filestream/pdfstream；非 DSTU 命令由 L13b-vfs-handlers 接入。上方生成清单仍保留拆分前的 214 命令/381 测试，不能把该清单的全部 pending 当作本工作树已完成。

`vfs` 运行时新增以下可消费能力（类型从本目录 api.ts 引用）：
- `unitIndex`：同步单位、状态总览、原子 reset、SQLite 清理及完整 SQLite/Lance 清理；所有索引表写入通过 L11。
- `mediaIndex`：转写时间窗、时间范围查询/补全、索引刷新、带时间戳读取。
- `ocr`：OCR JSON 兼容解析与 PDF 文本层判定。
- `upload`：同连接同步 savepoint、UploadSaga 引用补偿；使用 `using` 或 finally/dispose 对齐 Rust Drop。
- `attachmentConfig`：附件根文件夹管理，通过下述 L17 配置端口写配置。
- `contextWithConn/contextText/imageRefs` 由 api.ts 公开，供题库/引用读取共用。

### 尚需其他 lane 发布的具体接口

- L10 `notes`、L11 `vfsRepo` 更名与循环注入修复已随 main 合入；测试直接装载真实 owner 插件，旧测试名称适配器已删除。
- L14：`qbank.exportDocument(examId)`。最小契约 `QbankExportHook` 已发布；`dstu_export` 原始 exam 分支按 Rust 在缺失时返回 `Internal error: 题目导出服务未注册`，测试通过 createTestHost.provide 提供该端口。`qbank/api.ts` 当前仅公开 QuestionBankService CRUD，未公开导出。
- L17：`memoryConfig.get(key)/set(key,value)`（set 的 updated_at 为 SQLite datetime('now')）。最小契约 `AttachmentConfigStore` 已发布；运行时缺失明确报错，测试替身只替代配置持久化边界，文件夹仍用真实 L11 仓储。
- L10：`isOperatorSearchableKey/parsePropsCell/malformedPropsTotal/snippet` 尚未在 `notes/api.ts` 发布；note_props 的操作符可表达性、共享计数和截断7项对照测试仍 pending。非法键类别、搜索键规范化和 JSON 类型保留3项已通过真实公开生产路径验证；不能引用其实现路径或复制计数器。
- L12：`vfs-index/src/lexical-bm25.ts` 已有实现，但 `vfs-index/api.ts` 未公开 tokenizer/idf/scoring；7 个 lexical_bm25 对照测试仍 pending，避免另写一套评分算法。
- 题目哈希旧阻塞已解除：L11 `questions.updateQuestion/submitAnswer` 已公开并持久化内容哈希；`test_content_hash_consistency` 通过该真实路径移植。资源类型解析与列表输出两项测试也通过 L13b 已注册命令验证，均已 ported。

### 已获协调者批准的 obsolete

- `types.rs::test_vfs_resource_type_all`：C2-platform 审批已进入 main；全仓调用仅 types.rs:3034 测试，别名 T 也只在测试内且无 T::all 调用。
- `types.rs::test_vfs_blob_generate_relative_path`：C2-platform 审批已进入 main；全仓未限定符号检索仅定义1755及测试3150/3153，未发现生产调用。
- `question_sync_service.rs` 的 `test_conflict_strategy_conversion`、`test_merge_versions`、`test_apply_keep_local_keeps_pending_push_and_recomputes_hash`：协调者已在 main `ac8989383` 的 migration/approvals.json 批准 obsolete；TESTMAP 已据此更新。文件头1-16明示冲突子系统退役；生产消费者仅保留 mark_as_modified/update_content_hash。

### 未结束的工作

拆分前 TESTMAP 的 handler/ref/todo 中，51项按 L13b TESTMAP 的已接线去向纳入权威表；3项路径维护测试仍pending。chat_v2 tools 的89项中，resource_read/list/search/folder_list已真实注册、12项原测试ported；generative UI/DSTU 已有45项原测试与1项额外 emitter 集成测试，附件已有7项原测试与2项补充测试，retrieval已有20项原测试与6项集成测试，这72项仍等待业务/取消端口（见 BLOCKERS.md）。另有1项block-type测试待L03、1项附件共享错误测试待L04，以及3项resource测试对应的剩余导图命令仍需本 lane 继续完成。已有核心仓储的历史跨 owner 直接写入也仍需收敛，当前测试通过不代表这些遗留问题已解决。

生成式 UI：`src/tools/generative-ui.ts` 已实现 Rust 校验、结果、元数据事件与持久化失败策略；37个原测试及1个真实 emitter 集成测试通过。index.ts 已接入真实 L07 注册接口的依赖回调，但 L17 hpiasResearch 后端端口未发布；原38条 TESTMAP 保持 pending（其中 block-type mapping 还需 L03 提供函数）。

DSTU 工具：`src/tools/dstu-executor.ts` 复用生产 DSTU 处理函数，8个原 Rust 测试已迁移，含真实迁移库上的文件夹/回收站路径；index.ts 已接入真实 L07 注册接口的依赖回调，L05 runtimeRoots 已接用；（更正 WP-101）dstuUpload 不归 L13b，本lane b71c37b70 以同一 vfs_upload_file 实现 provide，待进main。L11 附件类型/大小策略已发布；最小契约 DstuUploadRoots/DstuUploadPort 在 api.ts，上传未改用简化创建流程。

### 当前状态与下一步（2026-11-04 新会话）

- 已完成：`api.ts` 正式服务面、DSTU 核心命令与仓储、filestream/pdfstream、索引/媒体/OCR/上传基础服务，以及资源读取、资源列表/搜索/文件夹和导图 CRUD/版本/节点编辑工具；对应生产入口和已接线测试已保留在本分支。
- 剩余：先复核合并后的类型检查与本 lane 测试，再逐项核对 `TESTMAP.md` 的 pending；自有实现优先处理尚未登记的导图导入/工具入口与测试，外部接口则只消费已发布的正式端口。
- 真实跨 lane 阻塞：L10 属性诊断、L12 词法评分/可取消检索、L04 附件错误与会话范围、L19 可取消 webSearch、L17 memory/HPIAS 配置与研究、L03 block type、L14 qbank 导出、L05 runtime roots、L13b 上传/路径维护；以 `BLOCKERS.md` 中的符号和证据为准，分支候选未合入 main 不视为已发布。
- 复核资料：本目录未发现 `ACCEPTANCE.md`，因此暂无独立复核人列出的必须修复项；质量规范中的生产入口、原断言、错误/日志和单写者要求继续作为验收条件。
- 顺序：类型检查/本 lane 最小测试 → 检查当前自有 pending 是否已有真实生产绑定 → 必要时补实现与测试并更新 SPEC/TESTMAP → 仅按 jobs 规则运行相关门禁并提交。

### C2 v2 小单元交付与当前门禁（覆盖上文历史状态）

当前实现基线 `8755b9a3a`（合并 `main eeaf5bdc7`），本次自查 finding **L13-BUILD-PATH-01** 仅修 `dstu_build_path`：根分支不取连接、Some 分支通过 L11 公开路径仓储、补入口/结果 info。SPEC 对应小节有逐分支/serde/错误/所有权/运行时证据；不把整个历史树视为 v2 已验收，R3 尚未签收。

历史工作单元（供协调者按提交历史拆分；不是建议重放所有 WIP）：

| 单元 | 实现检查点 | 当前范围与未决项 |
|---|---|---|
| 共享 API/数据库/路径类型 | `6f751bae1`、`a0d077f24`、`d18240991`、`c95b94e51`、`1332d2cc8` | 所有 DSTU 命令依赖的基础；协议注册唯一性修正在 `0cf554900` |
| 路径定位 | `85d9dc16c` | 本次最小可审读单元是 `dstu_build_path`；其他 move/cache 方法仍含 L11 表写入副本，不能宣称整组 v2 通过 |
| 创建/更新/删除 | `672c44517`；更新/删除实现位于 `c0b1631e1`/`da2a44b5c` 前的 WIP 链 | 不应只挑文档提交当实现；`f4a22b3a6` 开始收敛 notes/resources 所有者，但 create/delete/folders 仍有跨 owner SQL，需要继续逐单元处理 |
| 移动/改名/批量 | `af88b6375`、`5ca75e790` | 批量失败/回滚生产测试已有；D1 所有权及逐分支日志尚需 v2 复核，不将其合并称为“接口阻塞” |
| 当前正式服务接线 | `dc901f687`、`89151ce77`、`68cf77f7a` | 真实 notes/vfsRepo/vfsIndex，检索测试安装真实 agent-workspace 提供 agentVfsResolver |

本次最小路径修复依赖的已合入 main 检查点：F1 `902d86ee3`（kernel API）、F3 `80de40d89`（storage API）、L11 `d531a2060`（vfsRepo 提供方及公开 `folders.buildFolderPath`）、L10 `5ae69dfe6`（notes 公共面）、L12 `3cb904fee`（vfsIndex 入口）。后两项是本插件安装依赖；本命令业务只调用 L11。基线中已含这些提交，未复制提供方实现。

原始作业证据（未出现 Errors 行的作业明确记“无 Errors 行”，不由 passed 数推断退出码）：

| 实现树 | job ID | 检查 | 原 exit / Errors / 结果 |
|---|---|---|---|
| `68cf77f7a` | `20261104085206-ee6895` | VFS 全目录 | exit 0；无 Errors 行；40 files、467 passed、2 Windows 条件 skipped |
| `69fd771fc` | `20261104092028-8eacf0` | retrieval 两文件 | exit 0；无 Errors 行；26 passed，agentVfsResolver 启动失败已由真实 workspace 插件装配修复 |
| `69fd771fc` | `20261104093441-2641b8` | typecheck:host | exit 0；无 Errors 行 |
| `69fd771fc` | `20261104093445-005134` | migration:boundaries | exit 0；0 violation(s) |
| `69fd771fc` | `20261104093445-225b3c` | VFS 全目录 | **exit 1；Errors 5 errors**；2 failed files / 38 passed，452 passed / 17 skipped；locations/dstu-export 建库 beforeAll 120s 超时及五次 Vitest onTaskUpdate RPC timeout；不算绿 |
| `69fd771fc` | `20261104093445-e0ae45` | ledger --check --no-write | exit 0；原文末行见下 |
| `8755b9a3a` | `20261104105658-21ae8d` | 两个失败文件，maxWorkers=1 | exit 0；无 Errors 行；15 passed；未修改超时或断言，仅降低测试调度并发 |

```text
ledger: commands 1058 (A 93.9% B 5.9% C 0%), tests 8036 (A 82.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

该 ledger 行是全仓数字，不冒充 L13 的 A/B 百分比。最新协调者摘录仅含通过行，不能据此定位新的失败；此前 L12 `unit-maintenance.test.ts` 九项失败属允许目录外，已在后续 main 合并获得其更新，尚不能凭更新本身宣称通过。

当前接线事实：L17 `memoryRetrieval`/`hpiasResearch`/`memoryConfig` 已随 main 合入，L10 props/L03 block type/L05 roots/L19 webSearch 也已正式提供；撤销“整项未发布”的历史描述。L17 类型签名不证明 L12 在途检索可取消。L13b 三项路径 invoke/UTF-8 限额/回滚证据已核并更新 TESTMAP，两个线程保证仍 pending。按 C2 小单元优先指令，本次不叠加 HPIAS 集成测试扩展；该验证是本 lane 待办而非外部未发布阻塞。

L13-BUILD-PATH-01 实现由自动检查点 `341201bf6` 保存。对应 jobs：`20261104110133-b2e4d4` Node 路径7例 exit 0、无 Errors 行；`20261104110551-42959f` Electron 同7例 exit 0、无 Errors 行；`20261104110133-91dc55` typecheck exit 0；`20261104110133-db1dde` strict exit 0；`20261104110134-c8d204` 原生擦除 importable exit 0（`importable: ok`）。strict 原文汇总：

```text
boundaries: scanned 2459 files, 0 violation(s), 208 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

`20261104110134-164e15` 虽 exit 0，但 `--lane host/plugins/vfs` 参数未匹配目录，显示 ported 0；不以该空扫描证明接线，已改用工具实际接受的 `--lane vfs` 提交 `20261104110924-ca8bff`。

后续原文结果（`20261104110924-ca8bff`，exit 0）：

```text
合计 ported 293，其中所测模块未从 index.ts 接入 0（0.0%）
```

X6 单写者小单元：`90d40c0ac` 已保存导图创建两个包装函数消费真实 L11 同连接方法，删除 L13 的 mindmaps INSERT，保留原 create/copy 断言；新增 folder_items trigger 第二阶段失败时 resources/mindmaps/成员全回滚及无事件断言。R3 finding ID 已请求，尚无签收。验证树为 `e43715ca8 + 90d40c0ac` 中的实现/测试（自动检查点前后内容一致）：

| job ID | 最小检查 | 原结果 |
|---|---|---|
| `20261104111203-182051` | Node dstu-create + dstu-copy | exit 0；13 passed；无 Errors 行 |
| `20261104111203-4ae77f` | typecheck:host | exit 0；无 Errors 行 |
| `20261104111452-306d9e` | Electron 相同两文件 | exit 0；13 passed；无 Errors 行 |
| `20261104111452-35f861` | strict boundaries | exit 0；2459 files / 0 violation(s) / 208 suppressed |
| `20261104111452-964308` | ledger --check --no-write | exit 0；原文如下 |

```text
ledger: commands 1058 (A 94.7% B 5.9% C 0%), tests 8036 (A 82.6% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

现树X6排真清单已写 BLOCKERS：63条 foreign write、16条重复信息、33个登记 unknown 的 SQL 命中；notes创建旧样例已修，导图创建为本次修复，其余不冒称绿。此单元之外的自有待修按 C2 小单元顺序继续，而非统一归为跨 lane 阻塞。

### C2 关键服务最小集成：L18 → L13 转写刷新

正式签名（`api.ts` 导出并由 `index.ts` 的 `vfs` 实例提供）：

```ts
ctx.vfs.mediaIndex.refreshTranscriptIndex(ctx.vfs.database, ctx.vfs.unitIndex, fileId): number
```

返回0：文件缺失/resource_id缺失；转写为空时先通过 L11 indexStates.markPending 再0；存在转写时立即 syncResourceUnits 并返回单位数。消费方不 import 本 lane src，不写索引表。L18 `index.ts:757-788` 已正式绑定这一调用：异常 warn 后继续；pipeline.ts 的20完成段部分刷新及结束刷新均使用同一 refreshIndex 回调。完整 ASR 部分刷新时机由 L18 测试/审读负责，本 lane 组合测试不把导入字幕分支冒充20段ASR证明。

最小集成文件/依赖：
- L13 公开层 `api.ts` 的 VfsService.unitIndex/mediaIndex + index.ts 的实例构造/真实 provide；实现 `src/{unit-index-service,unit-builders,media-index,ocr}.ts`、只读 `repository/media-index.ts`、既有 `repository/services.ts` 与 `VfsDatabase`。首次实现检查点 **1593f4db8**，增量 **ca0056c34/06dd04db5**；`daa4676e4` 仅 TESTMAP 映射提交，不能只挑它冒充实现。
- 宿主装配：F3 storage + F4 paths → L11 vfsRepo + L10 notes → L12 vfsIndex → L13 vfs；L13无对L18反向注入。L18 **19d92b75d** 的 mediaTranscriber 已在main，消费现有vfs公开字段；导入字幕测试另装真实F4 settings与F7 nativeAudio（该分支不调用解码）。依赖SHA沿上方小单元清单。
- 生产证据 `tests/media-index.test.ts`：原8个Rust测试不删改断言；新增 `host.install(mediaPlugin)` 后调用真实 `host.ctx.mediaTranscriber.transcribe`，验证首次三窗、字幕更新后一窗、pending状态，以及真实SQLite trigger导致索引写失败仍返回转写成功。没有手动直接调用refresh冒充生产消费者。
- 不能把这个公开层补丁独立于它静态导入的模块树集成；协调者若切片，应包含上述闭包并与现main的 index.ts 接线合并，不重新复制L18/L12算法。

依赖闭包补充：`unit-builders.ts` 首次 **935eca390**，其parseOcrPagesJson依赖现有 `repository/resources.ts` 与 `repository/json.ts`；`repository/services.ts` 首次 **8de16ed46**（当前配置为真实owner），OCR模块 **ef90cbf9b**。关键新增生产组合测试 job **20261104112543-8ed64e**：10 passed，exit 0，无 Errors 行（仅 WASI experimental 提示），已证明L18刷新实际写入转写索引及失败继续。Electron同组合验证排队于 `20261104112949-c48a13`。

R3 已确认本lane单写者 finding **R13v-01**，可分 `.notes` / `.mindmap`；SPEC已补号。`41a804a2c` 删除仓储全部委托owner（同conn），`abcf9501a` 保存新增媒体组合与删除夹具修正。删除最小回归 `20261104112230-b99275` 首轮 **exit1，1 failed/44 passed，无Errors行**：新增删除测试准备的导图缺content，创建阶段合法拒绝，未进入被测删除路径；已补合法JSON内容，所有断言未改。只重跑失败文件 `20261104112652-93c64b` **exit0，6 passed，无Errors行**；44条已通过项不重复。`20261104112230-2fd796` typecheck exit0。

最终最小集验证（实现树 `abcf9501a`，后续 `1e8d3e815` 只补交付文档）：
- Electron `20261104112949-c48a13`：删除6例 + 媒体10例 = **16 passed，exit0，无 Errors 行**，只含 WASI 提示。
- strict `20261104112949-0bfcf4`：**exit0**；L13仅显示已有 boundary-allow 行，无 violation。原汇总：

```text
boundaries: scanned 2477 files, 0 violation(s), 206 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

- importable `20261104112949-a74cf6`：**exit0，importable: ok**。
- typecheck `20261104112949-e9609d`：**exit0**；ledger `20261104112949-f04760`：**exit0**。本次原始末行：

```text
ledger: commands 1058 (A 94.7% B 5.9% C 0%), tests 8036 (A 86.1% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

本次小单元已完成最小验证，供C2独立集成、R3复验；整lane尚未完成：TESTMAP实际293ported/83pending/5obsolete，R13v-01剩余create/files/blobs、folders、update/resources所有者修复和L17真实组合验证仍是自有待办，具体外部接缝证据另见BLOCKERS。原全套Errors5未撤销、未以这批最小通过重写为全套绿。

C2日志证据补充：此前媒体失败用例只证明“继续+字幕持久化”，未断言日志，不能将旧10例/16例结果称为日志已验证。本次在同一用例追加真实 `ctx.logger.buffer` 中 `name=media.commands/type=warn/level=2`、Rust消息前缀、file_media和SQL错误字段断言，业务断言不变；只排 `20261104114338-a49361` 这一用例复验，结果待取。L11日志候选 `b03e1753f` 已补创建info/成员debug，仍待主线/R3，不在消费者复制。

日志单例首轮 `20261104114338-a49361` **exit1，1 failed / 9 filtered，无Errors行**：Cordis默认buffer的exporter阈值为INFO(1)，WARN(2)未收集。测试改为注册真实logger.exporter并显式启用level3，随host生命周期清理；target/level/消息字段断言和全部业务断言保持不变，没有mock logger。修正后最小复验 `20261104114753-56edc2` **exit0，1 passed / 9 filtered，无Errors行**，仅WASI提示；9例是testNamePattern未选择，非新增skip或删断言。该单例现在验证真实warn发出，完整ASR/日志文件持久化仍不在本用例证明范围。

### R3 六组补审后的小单元（2026-11-04 12:00 UTC）

已读R3 e03c2ad0d/fe5c1ddcf；候选创建/build_path签收范围沿原记录，不重做。R13v-02后继删除入口、同conn owner和既有Node/Electron证据已回派R3；不按旧main缺入口重新实现。

- **R13v-05**：`4c3a7205c` 保存正文更新接L11 `updateMindmapWithConn(... versionSource:'manual')` 与3条新增生产invoke测试：旧内容快照及合并窗；快照失败warn/warn/error仍提交；最终写失败时版本+正文回滚且无事件。现树旧local快照副本仍供元数据路径，不误称整个update.ts单写者已清零。JSON语法文案在owner拒绝后沿原parser翻译，保持OCC/NotFound优先与既有Rust断言。
- **R13v-06**：`acb015f93` 保存test_simple_path_format改调用生产buildSimpleResourcePath，原Rust唯一相等断言输入/结果不变；TESTMAP头刷新已由C2转infra，未越权手改。实际293P/83Q/5O。
- **门禁路径夹具**：`20261104120752-5b6d74` exit1，1 failed/6过滤，无Errors；modern教材工厂按Rust生成file_，原test要验证tb_分派。service-wiring改用legacy tb_def456真实DB行保留/教材.pdf断言，另增file_回退，生产解析器不改。最小复验job `20261104121324-bd643b`。

| 实现树/单元 | job | 原结果 |
|---|---|---|
| R13v-06路径生产helper | `20261104115919-fff9d3` | exit0；53 passed；无Errors |
| R13v-05（4c3a7205c）Node | `20261104120139-5ed6b7` | exit0；12 passed；无Errors |
| R13v-05 Electron | `20261104120346-bcf6d5` | exit0；12 passed；无Errors |
| typecheck | `20261104120139-2180f1` | exit0 |
| strict | `20261104120346-6b7240` | exit0；2477 files、0 violation、206 suppressed |
| importable | `20261104120346-90ae00` | exit0；importable: ok |
| wiring --lane vfs | `20261104120346-f53f21` | exit0；合计 ported 293，其中所测模块未从 index.ts 接入 0（0.0%） |
| ledger | `20261104120346-a016df` | exit0；原末行如下 |

```text
ledger: commands 1058 (A 94.7% B 5.9% C 0%), tests 8036 (A 86.1% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

新standard-v2 §5已收到：这批提交全部变更后merge main，再执行正式lane-gate；门禁结果按其固定tip/base反馈C2/R3，不在门禁期间修改被测实现。R13v-01更新/级联其余SQL、R13v-03剩余日志与breadcrumb阶段文案、R13v-04同步DB/流式媒体仍未关闭；R13v-05此次候选待独立验收。

## v2排雷清单

固定报告 **0119143715c0bab2d8f698b7c1d58651358e85be**，源码基线 **2ee9a9cbe**。以下每行的编号、原位置及计数均来自该固定报告，后续重扫不重排/复用编号。当前核对树 **c90fcd6c6**；本节只记录现树状态与证据，不修改原报告，不机械改A/B/TESTMAP，不代替R3签收。

所有权裁定以 **037376b1e / X6-OWN-C2-20261104** 优先，键含数据库/用途：本节SW均为vfs.db；notes及租约属L10，resources/folder_items等VFS实体属L11，**qbank_practice_attempts属L14**（原报告标L11保留为历史字段，不据此倒改）。qbank_sources/materials/groups/group_materials/papers等领域表同样按C2裁定/owner级联处理。D1要求owner窄业务API+同conn，函数名WithConn不豁免消费者SQL。

状态约定：**候选已修待复核**仅指指定写点已被owner调用替代；仍须正常main集成与R3复验。**待修**为现树仍有相应代码；**人工核对同义覆盖**仅解释AP计数线索，不是审批例外/整个测试集签收。所有“—”均表示没有该项修复SHA，而非完成。已批准obsolete/dead保持原审批，不复活无生产分支。

### SW（45）与UD（1）

`C`=`host/plugins/vfs/repository/create.ts`，`F`=`host/plugins/vfs/repository/folders.ts`，`U`=`host/plugins/vfs/repository/update.ts`，`R`=`host/plugins/vfs/repository/resources.ts`；这些缩写仅缩短表格，原路径不变。E=原报告executed，S=原报告sql-text。

| 稳定 finding ID | 源码基线 | 原位置 / 操作 / owner报告 / 分类 | 当前状态、修复SHA与生产证据 |
|---|---|---|---|
| X6-SW-0095 | 2ee9a9cbe | C:83 INSERT resources；vfs-repos；E | 候选已修待复核；800f2aa85删除本地INSERT，createOrReuseResourceWithConn→resources.createOrReuseWithHash(conn)；dstu_create真实仓储测试 |
| X6-SW-0096 | 2ee9a9cbe | C:171 INSERT notes；notes；E | 候选已修待复核；8de16ed46→notes.repository.createNote/createNoteInFolder；R13v-01.notes候选经R3 f55ba4验证 |
| X6-SW-0097 | 2ee9a9cbe | C:175 UPDATE resources；vfs-repos；E | 候选已修待复核；8de16ed46删除笔记创建后的消费者source_id更新；由L10/L11同conn完成，证据同0096 |
| X6-SW-0098 | 2ee9a9cbe | C:231 INSERT translations；vfs-repos；E | 候选已修待复核；3b3a17867→translations.createTranslation/createTranslationInFolder(conn)；dstu-create真实翻译内容/成员断言 |
| X6-SW-0099 | 2ee9a9cbe | C:283 UPDATE translations；vfs-repos；E | 候选已修待复核；3b3a17867→translations.setFavorite(conn)；dstu-create持久is_favorite=1断言保留 |
| X6-SW-0100 | 2ee9a9cbe | C:294 UPDATE translations；vfs-repos；E | 候选已修待复核；3b3a17867→translations.setQualityRating(conn)；同测试quality_rating=4断言保留 |
| X6-SW-0101 | 2ee9a9cbe | C:314 INSERT essay_sessions；vfs-repos；E | 候选已修待复核；3b3a17867→essays.createSessionWithConn/createSessionInFolder；dstu-create会话ID/元数据断言 |
| X6-SW-0102 | 2ee9a9cbe | C:372 INSERT exam_sheets；vfs-repos；E | 候选已修待复核；3b3a17867→exams.createExamSheet/InFolder(conn)；dstu-create preview/status/resource关联断言 |
| X6-SW-0103 | 2ee9a9cbe | C:381 UPDATE resources；vfs-repos；E | 候选已修待复核；3b3a17867删除exam创建后source_id副本；同0102真实owner事务，不单独再提交 |
| X6-SW-0104 | 2ee9a9cbe | C:551 INSERT mindmaps；vfs-repos；E | 候选已修待复核；90d40c0ac→mindmaps.createMindmapWithConn/InFolderWithConn；R13v-01.mindmap/R3 f55ba4回滚与事件验证 |
| X6-SW-0105 | 2ee9a9cbe | C:652 INSERT blobs；vfs-repos；S | 真生产候选待修；—；dstu_create→createMedia→storeBlobWithConn实际执行该SQL，不能因S分类豁免 |
| X6-SW-0106 | 2ee9a9cbe | C:728 UPDATE files；vfs-repos；E | 待修；—；createFileWithConn恢复既有文件分支仍消费者写表，R13v-01 |
| X6-SW-0107 | 2ee9a9cbe | C:748 INSERT resources；vfs-repos；E | 待修；—；createFileWithConn新建资源仍有副本，不因0095已修整文件关闭 |
| X6-SW-0108 | 2ee9a9cbe | C:753 INSERT files；vfs-repos；E | 待修；—；createFileWithConn新文件仍消费者写表；需与0107同事务接owner |
| X6-SW-0109 | 2ee9a9cbe | F:207 INSERT folders；vfs-repos；E | 待修；—；dstu_folder_create→createFolderWithConn本地SQL；R13v-01/04 |
| X6-SW-0110 | 2ee9a9cbe | F:286 UPDATE folders；vfs-repos；E | 待修；—；setFolderExpandedWithConn，正式owner方法已有，不能报未发布 |
| X6-SW-0111 | 2ee9a9cbe | F:303 UPDATE folders；vfs-repos；E | 待修；—；renameFolderIfVersionWithConn须保OCC与缓存副作用 |
| X6-SW-0112 | 2ee9a9cbe | F:373 UPDATE folders；vfs-repos；E | 待修；—；moveFolderWithConn须保层级/深度/缓存失效，不复制owner |
| X6-SW-0113 | 2ee9a9cbe | F:715 UPDATE resources；vfs-repos；E | 待修；—；移动成员后索引pending副本，需由L11同conn业务方法执行 |
| X6-SW-0114 | 2ee9a9cbe | F:820 DELETE path_cache；vfs-repos；E | 待修；—；invalidateByFoldersBatchWithConn文件夹缓存清理，R13v-01 |
| X6-SW-0115 | 2ee9a9cbe | F:842 DELETE path_cache；vfs-repos；E | 待修；—；同方法资源缓存清理，和0114保持原事务/尽力日志 |
| X6-SW-0116 | 2ee9a9cbe | F:894 UPDATE notes；notes；E | 候选已修待复核；800f2aa85→notes.repository.deleteNote(itemId,conn)，a44910f12补错误映射；folders真实级联测试；不扩到其他entity |
| X6-SW-0117 | 2ee9a9cbe | F:907 UPDATE files；vfs-repos；E | 候选已修待复核；0fe8c89d2删除整个本地级联，统一调用folders.deleteFolder(conn,id)；文件写失败真实trigger证明整树回滚 |
| X6-SW-0118 | 2ee9a9cbe | F:925 UPDATE exam_sheets；vfs-repos；E | 候选已修待复核；0fe8c89d2同conn委托L11 folder/entity adapter；下游L14领域级联仍须owner/R3确认，不由消费者补SQL |
| X6-SW-0119 | 2ee9a9cbe | F:940 UPDATE qbank_practice_attempts；原vfs-repos；E | 消费者候选已修待复核；0fe8c89d2删除该SQL；**现裁定L14 qbank/vfs.db**，L11→L14同conn下游待owner/R3，不按旧owner倒改 |
| X6-SW-0120 | 2ee9a9cbe | F:956 UPDATE translations；vfs-repos；E | 候选已修待复核；0fe8c89d2删除translation级联副本，身份/版本推进由owner配置 |
| X6-SW-0121 | 2ee9a9cbe | F:978 UPDATE essay_sessions；vfs-repos；E | 候选已修待复核；0fe8c89d2删除会话级联SQL，L11 adapter按essay_session前缀分派 |
| X6-SW-0122 | 2ee9a9cbe | F:988 UPDATE essays；vfs-repos；E | 候选已修待复核；0fe8c89d2删除单篇级联SQL，L11 adapter执行 |
| X6-SW-0123 | 2ee9a9cbe | F:1001 UPDATE mindmaps；vfs-repos；E | 候选已修待复核；0fe8c89d2删除导图级联SQL，L11同conn方法保嵌套savepoint |
| X6-SW-0124 | 2ee9a9cbe | F:1050 UPDATE folders；vfs-repos；E | 候选已修待复核；0fe8c89d2由owner处理根更新/已删幂等/FolderNotFound，原生产断言保留 |
| X6-SW-0125 | 2ee9a9cbe | F:1064 UPDATE folders；vfs-repos；E | 候选已修待复核；0fe8c89d2由owner处理树/成员更新，共享成员不删实体和末步故障回滚均经真实invoke验证 |
| X6-SW-0126 | 2ee9a9cbe | U:80 UPDATE resources；vfs-repos；E | 候选已修待复核；800f2aa85→resources.updateResourceData(conn)；dstu-update正文/资源哈希生产测试 |
| X6-SW-0127 | 2ee9a9cbe | U:167 INSERT note_editor_write_grants；notes；E | 候选已修待复核；f8b509c32；L10 leases已main，薄委托authorized(conn,auth,webview,now,commit,work)，本地围栏SQL/解码副本删除 |
| X6-SW-0128 | 2ee9a9cbe | U:215 UPDATE note_editor_lease_acks；notes；E | 候选已修待复核；f8b509c32；owner同conn刷新ack；真实trigger拒绝ack时正文/资源/ack/grant全部回滚且无事件 |
| X6-SW-0129 | 2ee9a9cbe | U:221 DELETE note_editor_write_grants；notes；E | 候选已修待复核；f8b509c32；grant清理由owner，保原错误key，Node/Electron授权失败后可重试且grant=0 |
| X6-SW-0130 | 2ee9a9cbe | U:277 UPDATE notes；notes；E | 候选已修待复核；8de16ed46→notes.repository.updateNote(id,params,conn)，保OCC；lease副本另计 |
| X6-SW-0131 | 2ee9a9cbe | U:282 UPDATE notes；notes；E | 候选已修待复核；8de16ed46删除无expected版本的本地UPDATE，同0130 |
| X6-SW-0132 | 2ee9a9cbe | U:295 DELETE resources；vfs-repos；E | 候选已修待复核；8de16ed46删除笔记更新后的本地旧资源清理，交L10/L11；dstu-update原旧资源消失断言保持 |
| X6-SW-0133 | 2ee9a9cbe | U:320 UPDATE exam_sheets；vfs-repos；E | 待修；—；updateExamPreviewJsonWithConn仍写preview，须保资源同步同事务 |
| X6-SW-0134 | 2ee9a9cbe | U:356 UPDATE essay_sessions；vfs-repos；E | 待修；—；updateEssaySessionWithConn的title分支 |
| X6-SW-0135 | 2ee9a9cbe | U:360 UPDATE essay_sessions；vfs-repos；E | 待修；—；同方法is_favorite分支 |
| X6-SW-0136 | 2ee9a9cbe | U:364 UPDATE essay_sessions；vfs-repos；E | 待修；—；同方法essay_type分支 |
| X6-SW-0137 | 2ee9a9cbe | U:368 UPDATE essay_sessions；vfs-repos；E | 待修；—；同方法grade_level分支 |
| X6-SW-0138 | 2ee9a9cbe | U:372 UPDATE essay_sessions；vfs-repos；E | 待修；—；同方法custom_prompt分支 |
| X6-SW-0139 | 2ee9a9cbe | U:451 UPDATE mindmaps；vfs-repos；E | **部分候选已修，整点仍待修**；4c3a7205c/70c6b1412将dstu_update正文送L11 manual路径，Node/Electron12例；rename/set_metadata仍走本地updateMindmapWithConn，不能清除此ID |
| X6-UD-0087 | 2ee9a9cbe | R:30 parseJson；JSON.parse(raw) as T | 真风险待逐调用修；—；现R:46-52仍泛型断言。string-array/props等unknown调用有后验检查，resource_metadata/content_json的Record请求未全校验；不得整函数allow，数值词法/D3另核 |

SW候选证据：上列历史diff已实际读取（8de16ed46、800f2aa85、3b3a17867、90d40c0ac），运行入口由index强依赖真实notes/vfsRepo配置，见前文Node/Electron/create/update/folder回归与R3 f55ba4。c90fcd6c6时15个原写点候选已委托、30个待修；0fe8c89d2级联单元新增9个消费者候选修复，现24个已委托待复核、21个待修（含0139部分接面）。不把这45个旧快照项当作现树全部SQL上限，亦不因下游API存在自动签收全部领域语义。

f8b509c32再接main L10租约正式面，0127–0129三项消费者SQL删除；现该固定45项中27个候选已委托待复核、18个仍待修。编号与原基线不变，下游owner/其他未列写点不自动签收。

### PR/AP（PR=0，AP=23；均report-only）

本插件固定报告PR=0，没有可据此宣称的“全部符号已可达”结论。AP列保留原粗关联；`P`=`host/plugins/vfs/tests/paths.test.ts`，`T`=`host/plugins/vfs/tests/dstu-types.test.ts`，`D`=`host/plugins/vfs/tests/database.test.ts`。Rust路径均在`src-tauri/`下；每行完整Rust测试ID为所列Rust相对路径去掉`src-tauri/`后追加`::tests::<函数名>`，原报告错关联单独列明。原23项cfg-gated均0。

| 稳定 finding ID | 源码基线 | 原TS位置 / 原计数 Rust→TS | Rust原位置 / 测试ID函数 | 当前人工核对、修复SHA |
|---|---|---|---|---|
| X6-AP-0430 | 2ee9a9cbe | P:16；6→1 | crates/dstu-vfs/src/dstu/path_parser.rs:359 / test_normalize_path | 同义覆盖：6组原输入/期望逐一循环调用normalizePath；—，不补重复expect |
| X6-AP-0431 | 2ee9a9cbe | P:19；9→2 | crates/dstu-vfs/src/dstu/path_parser.rs:369 / test_is_parent_path | 同义覆盖：5真+4假原向量分别循环；— |
| X6-AP-0432 | 2ee9a9cbe | P:29；4→1 | crates/dstu-vfs/src/dstu/path_parser.rs:394 / test_get_path_name | 同义覆盖：根/中文/notes/资源ID四组；— |
| X6-AP-0433 | 2ee9a9cbe | P:90；3→1 | crates/dstu-vfs/src/dstu/path_parser.rs:603 / test_is_valid_path_normal | 同义覆盖：3个合法路径逐个生产判断；— |
| X6-AP-0434 | 2ee9a9cbe | P:95；7→1 | crates/dstu-vfs/src/dstu/path_parser.rs:630 / test_is_valid_path_traversal_attack | 同义覆盖：Rust7个遍历攻击字符串逐个false；— |
| X6-AP-0435 | 2ee9a9cbe | P:106；9→1 | crates/dstu-vfs/src/dstu/path_parser.rs:678 / test_get_resource_type_all_prefixes | 同义覆盖：note/tb/exam/tr/essay/fld/att/img/file九前缀；— |
| X6-AP-0436 | 2ee9a9cbe | P:109；3→1 | crates/dstu-vfs/src/dstu/path_parser.rs:694 / test_get_resource_type_invalid | 同义覆盖：abc123/unknown_id/数学三组null；— |
| X6-AP-0437 | 2ee9a9cbe | P:110；3→1 | crates/dstu-vfs/src/dstu/path_parser.rs:705 / test_is_valid_resource_id_true | 同义覆盖：note_abc/tb_123/exam_001三组true；— |
| X6-AP-0438 | 2ee9a9cbe | P:111；3→1 | crates/dstu-vfs/src/dstu/path_parser.rs:712 / test_is_valid_resource_id_false | 同义覆盖：abc/数学/notes三组false；— |
| X6-AP-0439 | 2ee9a9cbe | P:112；4→2 | crates/dstu-vfs/src/dstu/path_parser.rs:723 / test_parse_real_path_resource_id_length_limit | 同义覆盖：正常返回+resourceId相等涵盖is_ok；toThrow含文案同时涵盖is_err/contains；128/129边界相同；— |
| X6-AP-0440 | 2ee9a9cbe | P:131；6→3；原test_parsed_path_resource_at_root | crates/dstu-vfs/src/dstu/path_types.rs:305 / test_parsed_path_resource | 粗关联错位：正确同名用例在现P:127-129有6个原字段断言；at_root另对应Rust:316三断言；—，不整文件降A |
| X6-AP-0441 | 2ee9a9cbe | P:134；8→3 | crates/dstu-vfs/src/dstu/path_types.rs:324 / test_get_resource_type_from_id | 同义覆盖：6组prefix循环+2个invalid，输入和值逐一相同；— |
| X6-AP-0442 | 2ee9a9cbe | P:110；5→1；原test_is_valid_resource_id_true | crates/dstu-vfs/src/dstu/path_types.rs:354 / test_is_valid_resource_id | 粗关联到path_parser用例；正确path_types同名P:138-140覆盖3真2假；— |
| X6-AP-0443 | 2ee9a9cbe | P:111；5→1；原test_is_valid_resource_id_false | crates/dstu-vfs/src/dstu/path_types.rs:354 / test_is_valid_resource_id | 同0442为粗关联而非该原测试少4条；正确同名用例已逐向量核；— |
| X6-AP-0444 | 2ee9a9cbe | P:138；5→2 | crates/dstu-vfs/src/dstu/path_types.rs:354 / test_is_valid_resource_id | 同义覆盖：3真2假原输入各执行一次；— |
| X6-AP-0445 | 2ee9a9cbe | P:147；7→2 | crates/dstu-vfs/src/dstu/path_types.rs:381 / test_is_virtual_path_type | 同义覆盖：6个合法含TRASH/ALL + notes非法；— |
| X6-AP-0446 | 2ee9a9cbe | P:155；6→3 | crates/dstu-vfs/src/dstu/path_types.rs:402 / test_parsed_path_serialization | 同义覆盖：真实ParsedPath构造后序列化，4个camel键循环+两个false字段；— |
| X6-AP-0447 | 2ee9a9cbe | T:16；8→1 | crates/dstu-vfs/src/dstu/types.rs:838 / test_node_type_serialization | 8类型向量没有缺项，但**真实生产覆盖不足**：目前仅JSON.stringify测试字面量；待按R13v-06改真实节点/IPC输出，—；不为补计数复制expect |
| X6-AP-0448 | 2ee9a9cbe | T:22；3→1 | crates/dstu-vfs/src/dstu/types.rs:875 / test_node_type_deserialization | 同义覆盖此3个有效输入：循环调用生产dstuNodeTypeFromString；不由此批准全部serde拒绝语义；— |
| X6-AP-0449 | 2ee9a9cbe | D:68；8→1 | crates/dstu-vfs/src/vfs/database.rs:621 / test_get_statistics | 同义覆盖：真实db.getStatistics的toEqual一次验证7个零计数+schema版本；— |
| X6-AP-0450 | 2ee9a9cbe | D:107；2→1 | crates/dstu-vfs/src/vfs/database.rs:882 / test_folders_indexes_created | 两端都循环：Rust两组各3索引，TS合并6索引逐个查sqlite_master=1；名字与当前Rust完全一致；— |
| X6-AP-0451 | 2ee9a9cbe | D:139；3→1 | crates/dstu-vfs/src/vfs/database.rs:1127 / test_migration_011_subject_columns_removed | 同义覆盖：folders/folder_items/resources三个pragma查询均=0；— |
| X6-AP-0452 | 2ee9a9cbe | D:142；8→4 | crates/dstu-vfs/src/vfs/database.rs:1172 / test_migration_009_path_cache_table | 同义覆盖：表存在1+五列循环5+两个索引2，共8个原事实；— |

上述语义核对读取了对应Rust原测试，不新跑全仓、不补重复expect；既有路径53例作业fff9d3仍只证明当时该文件通过。AP0447真实可达性问题保留待修，不因其他22条计数解释而被掩盖。

### LP（16；逐分支待核，不按文件计数签收）

以下原路径均写全以保留跨文件粗关联。计数是固定报告的词法站点，不是当前运行日志次数；同名handlers.rs已按原报告rust字段区分DSTU与VFS。

| 稳定 finding ID | 源码基线 | 原位置 / 固定报告线索 | 当前状态、修复SHA与范围 |
|---|---|---|---|
| X6-LP-0263 | 2ee9a9cbe | host/plugins/vfs/src/dstu-content.ts:1；dstu/handler_utils/content_helpers.rs warn 2>0 / 2 citing files | 待分支修，—；mindmap OCC warn等属R13v-03，R13v-05 owner快照warn不是这2个warn的替代 |
| X6-LP-0264 | 2ee9a9cbe | host/plugins/vfs/src/dstu-content.ts:1；content_helpers.rs error 16>0 / 2 files | 待逐读取/解析错误分支核对，—；不能只补统一catch日志 |
| X6-LP-0265 | 2ee9a9cbe | host/plugins/vfs/src/dstu-list.ts:1；list_helpers.rs warn 2>0 / 1 file | 待核实际list调用与降级分支，—；不按整个Rust文件计数自动判两个缺陷 |
| X6-LP-0266 | 2ee9a9cbe | host/plugins/vfs/src/dstu-list.ts:1；list_helpers.rs error 14>0 / 1 file | 待按资源类型列表失败日志对照，—；已有返回错误不证明日志保留 |
| X6-LP-0267 | 2ee9a9cbe | host/plugins/vfs/src/locations.ts:1；node_converters.rs warn 3>1 / 2 files | 部分候选已有日志；dc901f687共享时间解析/非法时间warn与emit失败warn，仍需逐3分支复核，未关闭 |
| X6-LP-0268 | 2ee9a9cbe | host/plugins/vfs/repository/resources.ts:1；search_helpers.rs warn 2>0 / 2 files | 待对照search生产分支，—；转交owner不能自动视为日志齐全 |
| X6-LP-0269 | 2ee9a9cbe | host/plugins/vfs/index.ts:1；dstu/handlers.rs warn 73>1 / 11 files | R13v-03待修，—；当前拆分命令逐函数核对，build_path的info候选修复不抵消warn缺口 |
| X6-LP-0270 | 2ee9a9cbe | host/plugins/vfs/index.ts:1；dstu/handlers.rs error 156>0 / 11 files | R13v-03待修，—；旧统计不扩大为156个确定缺陷，需分支/owner日志证据 |
| X6-LP-0271 | 2ee9a9cbe | host/plugins/vfs/repository/database.ts:1；vfs/database.rs warn 2>0 / 2 files | 待核F3连接/维护/恢复日志与本lane映射，—；平台无RwLock不等整组obsolete |
| X6-LP-0272 | 2ee9a9cbe | host/plugins/vfs/repository/database.ts:1；database.rs error 5>1 / 2 files | 待核；现VfsDatabaseImpl.getStatistics有真实error，其余失败路径逐项对照；—，未签全覆盖 |
| X6-LP-0273 | 2ee9a9cbe | host/plugins/vfs/index.ts:1；vfs/handlers.rs warn 48>1 / 11 files | 粗归属需核：非DSTU handler实现由L13b，当前本index不是该Rust全文件消费者；与L13b日志证据合看，— |
| X6-LP-0274 | 2ee9a9cbe | host/plugins/vfs/index.ts:1；vfs/handlers.rs error 13>0 / 11 files | 同0273，不能只按文件级词法计数要求本index复制L13b日志；仍待分支核，— |
| X6-LP-0275 | 2ee9a9cbe | host/plugins/vfs/repository/resources.ts:1；ocr_utils.rs warn 2>0 / 1 file | 候选已增日志站点ef90cbf9b/dc901f687：src/ocr.ts解析失败、缺pages两warn，经resources的logger转发；各生产调用/消息/时序仍待复核，不按2站点就完成 |
| X6-LP-0276 | 2ee9a9cbe | host/plugins/vfs/repository/locations.ts:1；ref_handlers.rs warn 14>1 / 4 files | 待按ref读取辅助函数与L13b真实resolver分工核对，—；本lane path helper不等整个ref_handlers |
| X6-LP-0277 | 2ee9a9cbe | host/plugins/vfs/LANE.md:1；plugin total warn 266>3 | 人工汇总线索，—；含拆分owner/文件粗关联，不作为独立机械封禁或缺陷数，不发明obsolete |
| X6-LP-0278 | 2ee9a9cbe | host/plugins/vfs/LANE.md:1；plugin total error 249>1 | 同0277，—；需原级别/字段/顺序证据，非补249次error调用 |

下一步仍先R13v-01/03/04与L04接缝关键路径，再按上述固定ID逐单元修复；后续修复提交同时写X6 ID与对应R13v编号。无新增全量测试。本次只读核对发现AP0447真实风险后登记，未擅自改已批准dead/obsolete。

先前正式lane-gate（tip c90fcd6c6、base 45c3250b0）已返回：typecheck、boundaries、strict(changed)、importable通过；tests **exit1**，明确失败为 `host/plugins/vfs-handlers/tests/embedding.test.ts` 的真实LLM装配缺 `injectionBudget` / `llmCodexAuth`。此为允许目录外测试夹具依赖缺口，通知L13b/C2，不越权改它或扫描器。独立路径夹具单例bd643b已1passed/6过滤/exit0，无Errors；不将它替代正式门禁结果。本节提交后仍按§5 merge main并执行lane-gate记录新tip。

已补取完整门禁作业 `20261104122141-afbb3c`（exit1，无Errors/Unhandled行）：**3 files failed / 111 passed；11 tests failed / 1101 passed / 2平台skipped**。三个失败文件均在vfs-handlers：embedding的7条上述LLM依赖缺失、files的3条`deleteByResource does not exist`、paths的1条现代file_误作legacy tb_夹具。当前`host/plugins/vfs/`无FAIL行，不能据此把包含兄弟目录的正式gate改称通过。其余gate jobs：`20261104122141-491946` tsc、`25cde1`普通boundaries、`401196`strict、`bb53eb`importable，均exit0。该结果未触发手工重跑全仓；最新清单只读核对85行ID唯一（SW45/UD1/AP23/LP16）。

### 架构师关键路径优先级（2026-11-04）

账本同源 `scanPluginFile` + L13 IPC契约的只读核对：当前main有191个声明/注册，本候选211个；main缺23条恰为20条DSTU候选待集成和3条L13b尚未注册命令。该数只定位入口差异，不当作v2/A验收进度；仓库已提交的migration/ledger.json是旧骨架快照（pluginsScanned=4），不能据它判当前实现。

main缺、候选已实现的20条：`dstu_copy`、`dstu_delete`、`dstu_delete_many`、`dstu_empty_trash`、`dstu_export`、`dstu_export_formats`、`dstu_get_exam_content`、`dstu_list_trash`、`dstu_move`、`dstu_move_many`、`dstu_permanently_delete`、`dstu_purge`、`dstu_purge_all`、`dstu_rename`、`dstu_restore`、`dstu_restore_many`、`dstu_set_favorite`、`dstu_set_metadata`、`dstu_soft_delete`、`dstu_trash_restore`。各有现有SPEC小节/生产入口测试，仍需高危owner/日志/运行时整改与正常集成，不能重新堆20份实现冒充补缺。

两树都未注册的3条：`vfs_download_paper`、`vfs_upload_attachment`、`vfs_upload_file`，按既有拆分归L13b，已向其请求最小正式上传面及实现SHA/生产证据，并上报架构师/C2。L13只可写vfs目录，不越权注册重复handler。

执行顺序调整为：先R13v-01/03/04影响正确性/阻他人的高危小单元→20条候选集成与3条owner命令补缺接面→其余AP/LP排雷。当前先完成0fe8c89d2文件夹删除owner级联，删除L13对多领域表的副本，保SAVEPOINT/共享成员/失败回滚；4faf0d998移除不再使用的私有savepoint，查询副本一并删除。Node `20261104130253-7e3c73`：6passed/29名称过滤，exit0，无Errors；tsc `20261104130253-1c4722` exit0。Electron同最小集 `20261104130731-29fbb3`：6passed/29名称过滤，exit0，无Errors；ledger `20261104130731-f6e713` exit0，原末行如下。未重复旧全量失败；正式lane-gate仍在提交/merge之后执行。

```text
ledger: commands 1058 (A 94.7% B 5.9% C 0%), tests 8036 (A 85.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

main解锁后的同轮高危修复：L10 leases已公开（当前main API变更源e445524ba，index真实provide），f8b509c32经正式NoteLeaseRepository接authorized/now，删除L13 grant/ack与冻结稿/owned副本。Node `20261104132532-544997` 与Electron `20261104132821-566a1e` 各 **3passed/10名称过滤、exit0、无Errors**，覆盖原租约错误key/成功draft刷新及新ack失败整事务回滚；typecheck `20261104132532-1585d4` exit0。未更改既有断言/未恢复测试替身。

架构师后续路径诊断差异已按v2上报：Rust handlers.rs:8178-8190原测试仅五个prefix断言且tb_def456；:1094-1099→:1257-1303仅tb查文件名，file回退原ID；textbook_repo.rs:136-137现代创建为file_。当前main两个owner同样如此。此前service-wiring修复已保留legacy tb_名称断言并额外验证modern file_回退；最新“不改测试”指令后未再改路径测试。等待裁定，不为了门禁私自给生产解析器增加file→filename分支。此争议不阻碍提交已验证owner接缝和按正式gate推进候选集成。

### 自动续派：R13v-03 校验警告与正式门禁（2026-11-04 14:00 UTC后）

- 路径裁定已由架构师/C2撤销错误生产修改方向，L11独立核实支持原file_回退；保留已提交legacy tb_夹具/modern file_独立断言，不再争论或给生产新增file标题分支。
- 新版gate固定7aceb9b8b的测试作业 **20261104142501-1cbef1：exit1，1 failed / 1132 passed / 2平台skipped（117文件中1 failed/116 passed），无Errors/Unhandled**。唯一失败为L12 media-provider-integration漏notes；当前其他旧红灯在该次实际运行已通过，不把它们写成被隐藏/删去。其他四项gate通过。22:00/22:04工具语法故障反馈另按架构师指令作废，不与此真实失败混淆。
- 唯一fixture修复 **93863d6e1** 仍真实保留于L12分支（再次只读确认import和plugins均有notesPlugin），正常main仍未含；本lane不越权改vfs-index、不撤notes必需owner依赖。已向C2/架构师请求优先集成该独立单文件修复。
- 等待主线修复期间继续高危R13v-03：**e046b5ca3**恢复folder校验器四种warn及非法color warn，原校验顺序/错误串/空标题无warn均保留；新增真实kernel invoke+Cordis exporter验证级别、消息、字段、create/rename路径及不写folders，既有断言不改。SPEC **34b0d3a8e** 记录Rust:59-88/182-186；该子单元不关闭整个R13v-03或线程/单写者组。

| 检查 | job | 原结果 |
|---|---|---|
| Node最小folder日志/校验 | 20261104143858-76083b | exit0；4passed/26名称过滤；无Errors |
| Electron同最小集 | 20261104144242-833635 | exit0；4passed/26名称过滤；无Errors |
| typecheck | 20261104143859-44c1a7 | exit0 |
| ledger --check --no-write | 20261104145106-9c26b9 | exit0；原末行如下 |

```text
ledger: commands 1058 (A 94.7% B 5.9% C 0%), tests 8109 (A 84.7% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

F3 StorageError.phase现在main已可见；breadcrumb仍需保prepare→中文固定串、bind/query→Query failed、collect→Collect failed的分支/日志。已向L11请求窄getBreadcrumbs接口以遵守D4，不借此复制第二仓储，未宣称该项已完成。本轮提交后按§5 merge main并运行lane-gate；还有高危项和未集成命令，不能写“无剩余工作”。

### 接管续作：20 条 dstu_* 合入准备 + H1 vfs_upload_attachment 合流（2026-11-04 23:00 CST）

- 34b0d3a8e 提交遗留 SPEC；70abbccc5 merge main。lane-gate 固定 70abbccc5：4/5 通过，tests 唯一新增失败为 L12 `media-provider-integration`（dstu.vfs 必需 notes，fixture 未装 notesPlugin）；L13 工作树临时副本加 notesPlugin 后作业 20261104145629-0c0054 1 passed。修复由架构师在 09c380ae5 热修进 main，本 lane 不越权改 vfs-index。
- c4c395118 合入 H1（ds-mig/L13-vfs-api-h1 头 8ddce8b57）：`vfs_upload_attachment` 按 handlers.rs:1310-1639 实现并注册，契约测试 `tests/upload-attachment.test.ts`。Rust handlers.rs 无该命令专属单测，TESTMAP 无对应行需改去向。注意：mediaKind 依赖 L11 api.ts 0a3d703ad（截至本记录未进 main），未发布时命令报错、命令级测试跳过——L11 合入前该命令不算完成。
- standard-v2 §1.4 日志/行为复核（批次 2）：
  - `dstu_move`/`dstu_rename`：补 Rust 入口 info、各分支 SUCCESS/FAILED 日志；essay 改名节点时间戳改为 Rust 严格 RFC3339（created 失败→0、updated 失败→created，各 warn），不再宽松解析。
  - `dstu_delete`：补删除前 resource_id 查找（handlers.rs:1707-1727，错误吞掉）与成功后后台 Lance text/multimodal 清理 + `cleaned up vectors` 日志（此前 TS 完全缺失）；补 UUID fallback info 与 delete_helpers 各类型 SUCCESS 日志。
  - `cleanupVectors` 改为批量纯清理、由调用方按 Rust 文案记日志：dstu_purge 单条、dstu_purge_all / dstu_delete_many 按"N resources"一次（此前三者都误记 dstu_purge 文案、且逐条）。
  - `dstu_set_favorite`：补入口/各分支 SUCCESS/FAILED/get_* error/not-found warn/末尾 info，与 handlers.rs:4555-4840 逐条对应。
  - H1 合流修正：`vfsUnitBuilder` 原为插件级必需 inject，导致本 lane dstu-trash/retrieval 共 22 例 `did not start` 失败（作业 20261104151408-003453）；改为 vfs_upload_attachment 调用时 `ctx.get` 解析、缺失即 VfsError，不影响 dstu_* 宿主组合。
  - 验证：tsc 20261104152111-4af6ef exit0；vitest host/plugins/vfs/ + memory delete-hook-integration 20261104152153-1fbd43：42 文件 480 passed / 5 skipped，exit0。
  - 其余 dstu_* 命令（copy/metadata/trash/export 等）日志未逐条复核，留待后续。
- H1 第二批合流（ds-mig/L13-vfs-api-h1 头 01083f8ca）：`vfs_upload_file`（handlers.rs:1985-2712）、`vfs_download_paper`（handlers.rs:7311-7587）实现并注册，契约测试 `tests/upload-file.test.ts`（undici MockAgent）；三条上传命令语义与 spawn_blocking 线程差异记入 SPEC。index.ts 冲突按两侧意图合并：保留 H1 两条注册，`unitBuilder` 统一走调用时 `requireUnitBuilder(ctx.get('vfsUnitBuilder'))`，不恢复插件级硬 inject。
- TESTMAP：Rust handlers.rs 测试模块（L7912 起）无这三条命令专属测试，既有行已映射，去向无需改；`dstu_executor.rs::secx_08_upload_source_requires_managed_runtime_locator` 仍 pending（非本三条命令）。
- 依赖：H1 部分测试依赖 L11 0a3d703ad（mediaKind 等），未进 main 时跳过；L11 合入后自动启用，届时三条命令才算有完整生产入口证据。

### WP-200：folder八目标v0交付（2026-11-05，覆盖旧状态的本包部分）

恢复起点c2a4b9fbc干净，merge main至0764800b3，WP-064/101/109历史均保留；提交前再合并6e2936bac。
本包只新增folder八目标场景与检查/观察证据：`equivalence/folders.v0.json` 21场景208步，
167目标步骤+41辅助create，全部capture.db=["*"]、动态ID引用、normalize=[]。
首次提交6792b177a。前端/Rust逐命令落点及未覆盖错误/提前返回分支见`equivalence/README.md`。

jobs：起点typecheck 20261105203031-9a65fd exit0；原folders.test.ts 20261105203032-f6f72a
30passed/0failed/0skipped exit0；结构20261105203626-a60302 exit0；Node观察20261105203626-70d31e、
Electron内置Node观察20261105203905-7dc4a5各21场景passed/0failed/0skipped、208调用、exit0、无Errors。
原始全DB/事件/返回/错误/log位于`equivalence/raw/wp200-{node,electron}`，全部为实际观察，不是golden。
TESTMAP实际293ported/83pending/5obsolete未改去向；不恢复旧73资格，不判定A/C或语料充分性。
F3/L11接口已在main；既有单写者/worker/日志整改不是接口缺失，本包未扩到它们或XML/上传。
按WORKER只交本包，提交后直接lane-gate，再wp-done；下一件事由协调者另派。
