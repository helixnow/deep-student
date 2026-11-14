# 跨 lane 服务草稿：L10-notes

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（76 个条目，其中 57 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:37` | L13-vfs-api 11/0<br>L17-memory-research 6/0<br>L11-vfs-repos 2/0<br>L06-agent-orchestration 1/0<br>L12-vfs-index 1/0<br>L14-qbank 1/0<br>L18-media-docs 0/1<br>L20-sync 0/3<br>L22-app-commands 0/7 | `pub struct VfsNoteRepo` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:911` | L13-vfs-api 15/0<br>L17-memory-research 6/0<br>L14-qbank 1/0<br>L11-vfs-repos 0/2<br>L22-app-commands 0/6 | `pub fn get_note(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<VfsNote>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:972` | L17-memory-research 13/0<br>L13-vfs-api 7/0<br>L14-qbank 1/0 | `pub fn get_note_content(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<String>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note` ? | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:604` | L17-memory-research 16/1<br>L13-vfs-api 4/0 | `pub fn update_note( db: &VfsDatabase, note_id: &str, params: VfsUpdateNoteParams, ) -> VfsResult<VfsNote>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` ? | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2289` | L17-memory-research 8/1<br>L06-agent-orchestration 1/0<br>L13-vfs-api 1/0<br>L11-vfs-repos 0/3<br>L22-app-commands 0/2 | `pub fn create_note_in_folder( db: &VfsDatabase, params: VfsCreateNoteParams, folder_id: Option<&str>, ) -> VfsResult<VfsNote>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1266` | L13-vfs-api 9/0<br>L11-vfs-repos 0/1 | `pub fn list_notes( db: &VfsDatabase, search: Option<&str>, limit: u32, offset: u32, ) -> VfsResult<Vec<VfsNote>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:617` | L17-memory-research 6/0<br>L13-vfs-api 1/0<br>L20-sync 0/1 | `pub fn update_note_with_conn( conn: &Connection, note_id: &str, params: VfsUpdateNoteParams, ) -> VfsResult<VfsNote>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:920` | L17-memory-research 6/0<br>L12-vfs-index 1/0 | `pub fn get_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<Option<VfsNote>>` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::required_capabilities` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:187` | L20-sync 6/0 | `pub fn required_capabilities(format: &NoteFormat) -> Vec<String>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2358` | L17-memory-research 3/0<br>L13-vfs-api 2/0 | `pub fn delete_note_with_folder_item(db: &VfsDatabase, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteMetadataUpdate` | struct | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:44` | L13-vfs-api 3/0<br>L11-vfs-repos 1/0<br>L18-media-docs 0/1 | `pub struct VfsNoteMetadataUpdate` |
| `dstu_notes::notes_manager::NotesManager` | struct | `crates/dstu-notes/src/notes_manager.rs:113` | F1-kernel 3/0<br>L22-app-commands 1/0 | `pub struct NotesManager` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::detect` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:117` | L20-sync 4/0 | `pub fn detect(note_id: &str, content: &str) -> VfsResult<NoteFormat>` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::ensure_supported` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:158` | L20-sync 4/0 | `pub fn ensure_supported(format: &NoteFormat) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:471` | L13-vfs-api 3/2<br>L18-media-docs 0/1<br>L20-sync 0/5<br>L14-qbank 0/1<br>L21-backup-governance 0/1 | `pub fn create_note(db: &VfsDatabase, params: VfsCreateNoteParams) -> VfsResult<VfsNote>` |
| `deep_student_lib::cmd::notes::cleanup_note_editor_leases` | fn | `src/cmd/notes.rs:527` | F2-shell 3/0 | `pub(crate) fn cleanup_note_editor_leases( app: tauri::AppHandle, window: Option<String>, webview: Option<String>, )` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormat` | struct | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:28` | L20-sync 3/0 | `pub struct NoteFormat` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2502` | L17-memory-research 3/0 | `pub fn get_note_location( db: &VfsDatabase, note_id: &str, ) -> VfsResult<Option<ResourceLocation>>` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor` | struct | `src/chat_v2/tools/user_todo_executor.rs:816` | F1-kernel 1/2<br>L13-vfs-api 1/0<br>L22-app-commands 0/2 | `pub struct UserTodoExecutor` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor` | struct | `src/chat_v2/tools/canvas_executor.rs:712` | F1-kernel 1/2<br>L13-vfs-api 1/0<br>L22-app-commands 0/1 | `pub struct CanvasToolExecutor` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::get` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:98` | L20-sync 2/0 | `pub fn get(conn: &Connection, note_id: &str) -> VfsResult<NoteFormat>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder_uncommitted` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2327` | L17-memory-research 2/0 | `pub fn create_note_in_folder_uncommitted( conn: &Connection, params: VfsCreateNoteParams, folder_id: Option<&str>, ) -> VfsResult<VfsNote>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2367` | L17-memory-research 1/0<br>L13-vfs-api 1/0 | `pub fn delete_note_with_folder_item_with_conn( conn: &Connection, note_id: &str, ) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_deleted_notes` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2130` | L13-vfs-api 2/0 | `pub fn list_deleted_notes( db: &VfsDatabase, limit: u32, offset: u32, ) -> VfsResult<Vec<VfsNote>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes_by_folder` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2452` | L13-vfs-api 2/0 | `pub fn list_notes_by_folder( db: &VfsDatabase, folder_id: Option<&str>, limit: u32, offset: u32, ) -> VfsResult<Vec<VfsNote>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1728` | L13-vfs-api 1/0<br>L11-vfs-repos 1/0 | `pub fn purge_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1521` | L13-vfs-api 2/0 | `pub fn restore_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1553` | L13-vfs-api 1/0<br>L11-vfs-repos 1/0 | `pub fn restore_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()>` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor::new` | method | `src/chat_v2/tools/canvas_executor.rs:715` | F1-kernel 1/2<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::set_pinned` ? | method | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:321` | L20-sync 1/2 | `pub fn set_pinned( conn: &Connection, note_id: &str, version_id: &str, pinned: bool, ) -> VfsResult<NoteRevisionSummary>` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor::new` | method | `src/chat_v2/tools/user_todo_executor.rs:819` | F1-kernel 1/0<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1425` | L13-vfs-api 1/0<br>L18-media-docs 0/1 | `pub fn delete_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_metadata` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1959` | L13-vfs-api 1/0<br>L18-media-docs 0/1 | `pub fn update_note_metadata( db: &VfsDatabase, note_id: &str, update: VfsNoteMetadataUpdate, ) -> VfsResult<VfsNote>` |
| `deep_student_lib::chat_v2::handlers::canvas_handlers::chat_v2_canvas_edit_result` | fn | `src/chat_v2/handlers/canvas_handlers.rs:29` | L04-chat-session 1/0 | `pub fn chat_v2_canvas_edit_result(result: CanvasAIEditResult) -> Result<(), String>` |
| `deep_student_lib::chat_v2::tools::notes_import_executor::NotesImportExecutor::new` | method | `src/chat_v2/tools/notes_import_executor.rs:37` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_notes::notes_manager::NotesManager::new_with_vfs` | method | `crates/dstu-notes/src/notes_manager.rs:133` | F2-shell 1/0 | `pub fn new_with_vfs(db: Arc<Database>, vfs_db: Arc<VfsDatabase>) -> Result<Self>` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo` | struct | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:96` | L20-sync 1/0 | `pub struct NoteFormatRepo` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::insert` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:152` | L20-sync 1/0 | `pub fn insert(conn: &Connection, format: &NoteFormat) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::serializer` | method | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:179` | L20-sync 1/0 | `pub fn serializer(stable: bool, columns: bool) -> String` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseAuth` | struct | `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:24` | L13-vfs-api 1/0 | `pub struct NoteLeaseAuth` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo` | struct | `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:56` | L13-vfs-api 1/0 | `pub struct NoteLeaseRepo` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::authorized` | method | `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:307` | L13-vfs-api 1/0 | `pub fn authorized<T>( conn: &Connection, auth: &NoteLeaseAuth, webview: &str, now: i64, commit: bool, work: impl FnOnce() -> VfsResult<T>, ) -> VfsResult<T>` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::cleanup` | method | `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:506` | F2-shell 1/0 | `pub fn cleanup( conn: &Connection, now: i64, window: Option<&str>, webview: Option<&str>, ) -> VfsResult<Vec<LeaseCancellation>>` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::now` | method | `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs:58` | L13-vfs-api 1/0 | `pub fn now() -> i64` |
| `dstu_vfs::vfs::repos::note_relation_repo::NoteRelationRepo::invalidate_missing_blocks` | method | `crates/dstu-vfs/src/vfs/repos/note_relation_repo.rs:211` | L20-sync 1/0 | `pub fn invalidate_missing_blocks(conn: &Connection, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::backfill_note_links_once` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:3092` | F2-shell 1/0 | `pub fn backfill_note_links_once(db: &VfsDatabase, batch_size: usize) -> VfsResult<bool>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1477` | L11-vfs-repos 1/0 | `pub fn delete_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:981` | L18-media-docs 1/0 | `pub fn get_note_content_with_conn( conn: &Connection, note_id: &str, ) -> VfsResult<Option<String>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2511` | L12-vfs-index 1/0 | `pub fn get_note_location_with_conn( conn: &Connection, note_id: &str, ) -> VfsResult<Option<ResourceLocation>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_content_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1048` | L17-memory-research 1/0 | `pub fn get_note_with_content_with_conn( conn: &Connection, note_id: &str, ) -> VfsResult<Option<(VfsNote, String)>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2181` | L13-vfs-api 1/0 | `pub fn purge_deleted_notes(db: &VfsDatabase) -> VfsResult<usize>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes_with_conn` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2191` | L13-vfs-api 1/0 | `pub fn purge_deleted_notes_with_conn(conn: &Connection) -> VfsResult<usize>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1719` | L13-vfs-api 1/0 | `pub fn purge_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::set_favorite` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1911` | L13-vfs-api 1/0 | `pub fn set_favorite(db: &VfsDatabase, note_id: &str, is_favorite: bool) -> VfsResult<()>` |
| `dstu_vfs::vfs::repos::note_revision_repo::install_storage_hooks` | fn | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:523` | F1-kernel 1/0 | `pub fn install_storage_hooks(scope: &mut dstu_kernel::Scope)` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteAssetRef` | struct | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:15` | L20-sync 1/0 | `pub struct NoteAssetRef` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::snapshot` | method | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:138` | L20-sync 1/0 | `pub fn snapshot(conn: &Connection, note_id: &str, source: &str) -> VfsResult<String>` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_DELETE_ITEM` | const | `src/chat_v2/tools/user_todo_executor.rs:428` | L22-app-commands 0/4 | `pub const USER_TODO_DELETE_ITEM: &str = "user_todo_delete_item"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_RESTORE` | const | `src/chat_v2/tools/user_todo_executor.rs:434` | L22-app-commands 0/4 | `pub const USER_TODO_RESTORE: &str = "user_todo_restore"` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo` | struct | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:105` | L20-sync 0/4 | `pub struct NoteRevisionRepo` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_CREATE_ITEM` | const | `src/chat_v2/tools/user_todo_executor.rs:423` | L22-app-commands 0/3 | `pub const USER_TODO_CREATE_ITEM: &str = "user_todo_create_item"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_DELETE_LIST` | const | `src/chat_v2/tools/user_todo_executor.rs:431` | L22-app-commands 0/3 | `pub const USER_TODO_DELETE_LIST: &str = "user_todo_delete_list"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_UPDATE_ITEM` | const | `src/chat_v2/tools/user_todo_executor.rs:427` | L22-app-commands 0/3 | `pub const USER_TODO_UPDATE_ITEM: &str = "user_todo_update_item"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_UPDATE_LIST` | const | `src/chat_v2/tools/user_todo_executor.rs:430` | L22-app-commands 0/3 | `pub const USER_TODO_UPDATE_LIST: &str = "user_todo_update_list"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_LIST_TRASH` | const | `src/chat_v2/tools/user_todo_executor.rs:433` | L22-app-commands 0/2 | `pub const USER_TODO_LIST_TRASH: &str = "user_todo_list_trash"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_REORDER` | const | `src/chat_v2/tools/user_todo_executor.rs:435` | L22-app-commands 0/2 | `pub const USER_TODO_REORDER: &str = "user_todo_reorder"` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::set_note_props` ? | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2103` | L13-vfs-api 0/2 | `pub fn set_note_props( db: &VfsDatabase, note_id: &str, props: serde_json::Value, ) -> VfsResult<VfsNote>` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::get` ? | method | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:290` | L20-sync 0/2 | `pub fn get(conn: &Connection, note_id: &str, version_id: &str) -> VfsResult<NoteRevision>` |
| `deep_student_lib::chat_v2::tools::notes_import_executor::NotesImportExecutor` | struct | `src/chat_v2/tools/notes_import_executor.rs:34` | F1-kernel 0/1 | `pub struct NotesImportExecutor` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_CREATE_LIST` | const | `src/chat_v2/tools/user_todo_executor.rs:429` | L22-app-commands 0/1 | `pub const USER_TODO_CREATE_LIST: &str = "user_todo_create_list"` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_SEARCH` | const | `src/chat_v2/tools/user_todo_executor.rs:432` | L22-app-commands 0/1 | `pub const USER_TODO_SEARCH: &str = "user_todo_search"` |
| `dstu_vfs::vfs::repos::note_relation_repo::NoteRelationRepo::get` | method | `crates/dstu-vfs/src/vfs/repos/note_relation_repo.rs:112` | L20-sync 0/1 | `pub fn get( conn: &Connection, anki: Option<&Connection>, id: &str, ) -> VfsResult<Option<NoteRelation>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_content` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1039` | L22-app-commands 0/1 | `pub fn get_note_with_content( db: &VfsDatabase, note_id: &str, ) -> VfsResult<Option<(VfsNote, String)>>` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::search_notes_with_snippets` | method | `crates/dstu-vfs/src/vfs/repos/note_repo.rs:1178` | L21-backup-governance 0/1 | `pub fn search_notes_with_snippets( db: &VfsDatabase, keyword: &str, limit: u32, ) -> VfsResult<Vec<(VfsNote, Option<String>)>>` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::list` ? | method | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:234` | L20-sync 0/1 | `pub fn list( conn: &Connection, note_id: &str, cursor: Option<i64>, limit: u32, ) -> VfsResult<NoteHistoryPage>` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::restore_copy` ? | method | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:361` | L20-sync 0/1 | `pub fn restore_copy(conn: &Connection, note_id: &str, version_id: &str) -> VfsResult<VfsNote>` |

### 引用点样例

- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:54`；L18-media-docs: `crates/dstu-media/src/media/library.rs:462`；L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:20`, `crates/dstu-memory/src/memory/daily_log.rs:23`, `crates/dstu-memory/src/memory/delete_hook.rs:9`, `crates/dstu-memory/src/memory/evolution.rs:30`；L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:451`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:653`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:672`；L13-vfs-api: `crates/dstu-vfs/src/dstu/export/note_adapter.rs:11`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs:21`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs:8`, `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:10`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:23`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:23`, `crates/dstu-vfs/src/vfs/repos/mod.rs:71`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:21`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:222`, `tests/dstu_canvas_executor_e2e.rs:256`, `tests/dstu_canvas_executor_e2e.rs:296`, `tests/dstu_canvas_executor_e2e.rs:309`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` — L17-memory-research: `crates/dstu-memory/src/memory/delete_hook.rs:23`, `crates/dstu-memory/src/memory/evolution.rs:531`, `crates/dstu-memory/src/memory/evolution.rs:625`, `crates/dstu-memory/src/memory/service.rs:965`；L13-vfs-api: `crates/dstu-vfs/src/dstu/export/note_adapter.rs:49`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs:30`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs:152`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs:229`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3529`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3569`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:180`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:467`, `tests/phase8_9_executor_e2e.rs:478`, `tests/phase8_9_executor_e2e.rs:536`, `tests/phase8_9_executor_e2e.rs:539`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content` — L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:175`, `crates/dstu-memory/src/memory/category_manager.rs:411`, `crates/dstu-memory/src/memory/daily_log.rs:357`, `crates/dstu-memory/src/memory/evolution.rs:457`；L13-vfs-api: `crates/dstu-vfs/src/dstu/export/note_adapter.rs:54`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs:154`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs:169`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs:216`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:188`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note` — L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:297`, `crates/dstu-memory/src/memory/daily_log.rs:209`, `crates/dstu-memory/src/memory/evolution.rs:501`, `crates/dstu-memory/src/memory/learner_profile.rs:902`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs:549`, `crates/dstu-vfs/src/dstu/handlers.rs:1535`, `crates/dstu-vfs/src/dstu/handlers.rs:1909`, `crates/dstu-vfs/src/vfs/handlers.rs:552`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:406`；L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:320`, `crates/dstu-memory/src/memory/daily_log.rs:271`, `crates/dstu-memory/src/memory/learner_profile.rs:932`, `crates/dstu-memory/src/memory/learner_profile.rs:1196`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:904`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3416`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3498`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3540`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:159`, `tests/phase8_9_executor_e2e.rs:389`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs:45`, `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs:72`, `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs:258`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs:165`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3512`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_with_conn` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:1376`, `crates/dstu-memory/src/memory/service.rs:3643`, `crates/dstu-memory/src/memory/service.rs:3660`, `crates/dstu-memory/src/memory/service.rs:3768`；L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:639`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:1531`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_conn` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:1466`, `crates/dstu-memory/src/memory/service.rs:3620`, `crates/dstu-memory/src/memory/service.rs:3626`, `crates/dstu-memory/src/memory/service.rs:3741`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:2338`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::required_capabilities` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:202`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:203`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:291`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:292`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item` — L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:364`, `crates/dstu-memory/src/memory/evolution.rs:537`, `crates/dstu-memory/src/memory/service.rs:3426`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:38`, `crates/dstu-vfs/src/vfs/handlers.rs:662`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteMetadataUpdate` — L18-media-docs: `crates/dstu-media/src/media/library.rs:732`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:109`, `crates/dstu-vfs/src/dstu/handlers.rs:157`, `crates/dstu-vfs/src/vfs/mod.rs:87`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/mod.rs:71`
- `dstu_notes::notes_manager::NotesManager` — F1-kernel: `src/agent_wiring/plugins.rs:20`, `src/agent_wiring/services.rs:21`, `src/agent_wiring/services.rs:45`；L22-app-commands: `src/commands.rs:697`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::detect` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:197`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:287`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:353`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:383`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::ensure_supported` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:196`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:333`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:376`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:388`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` — L18-media-docs: `crates/dstu-media/src/media/library.rs:719`；L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:420`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:474`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:539`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:586`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs:1062`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs:1086`, `crates/dstu-vfs/src/dstu/handlers.rs:2318`, `crates/dstu-vfs/src/dstu/handlers.rs:3009`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:538`；L21-backup-governance: `src/data_governance/migration_compat_tests.rs:688`
- `deep_student_lib::cmd::notes::cleanup_note_editor_leases` — F2-shell: `src/lib.rs:491`, `src/lib.rs:707`, `src/lib.rs:1352`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormat` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:186`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:326`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:375`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location` — L17-memory-research: `crates/dstu-memory/src/memory/delete_hook.rs:24`, `crates/dstu-memory/src/memory/service.rs:3279`, `crates/dstu-memory/src/memory/service.rs:4187`
- `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:86`, `src/agent_wiring/tests/headless_tests.rs:35`；L13-vfs-api: `src/chat_v2/tools/mod.rs:82`；L22-app-commands: `tests/phase5_tool_execution_e2e.rs:13`, `tests/tool_pack_integration_tests.rs:48`
- `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:57`, `src/agent_wiring/tests/legacy_tests.rs:22`；L13-vfs-api: `src/chat_v2/tools/mod.rs:58`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:4`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::get` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:288`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:387`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder_uncommitted` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:1228`, `crates/dstu-memory/src/memory/service.rs:1482`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item_with_conn` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:1472`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:125`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_deleted_notes` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:4871`, `crates/dstu-vfs/src/dstu/trash_handlers.rs:302`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes_by_folder` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:724`, `src/chat_v2/tools/builtin_resource_executor.rs:859`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note_with_conn` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:284`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:1934`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:362`, `crates/dstu-vfs/src/dstu/trash_handlers.rs:191`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note_with_conn` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:414`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:1785`
- `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:44`, `src/agent_wiring/tests/hooks_tests.rs:69`, `src/agent_wiring/tests/legacy_tests.rs:196`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:174`
- `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::set_pinned` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:314`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:553`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:698`
- `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:74`；L22-app-commands: `tests/phase5_tool_execution_e2e.rs:185`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note` — L18-media-docs: `crates/dstu-media/src/media/library.rs:784`；L13-vfs-api: `crates/dstu-vfs/src/dstu/trash_handlers.rs:129`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_metadata` — L18-media-docs: `crates/dstu-media/src/media/library.rs:729`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:3432`
- `deep_student_lib::chat_v2::handlers::canvas_handlers::chat_v2_canvas_edit_result` — L04-chat-session: `src/chat_v2/handlers/mod.rs:11`
- `deep_student_lib::chat_v2::tools::notes_import_executor::NotesImportExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:94`
- `dstu_notes::notes_manager::NotesManager::new_with_vfs` — F2-shell: `src/lib.rs:3582`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:4`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::insert` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:302`
- `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::serializer` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:295`
- `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseAuth` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:1444`
- `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:69`
- `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::authorized` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:1525`
- `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::cleanup` — F2-shell: `src/lib.rs:1344`
- `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::now` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:1529`
- `dstu_vfs::vfs::repos::note_relation_repo::NoteRelationRepo::invalidate_missing_blocks` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:145`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::backfill_note_links_once` — F2-shell: `src/lib.rs:3755`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_conn` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:1757`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content_with_conn` — L18-media-docs: `crates/dstu-media/src/media/ledger.rs:385`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location_with_conn` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:2381`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_content_with_conn` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:1334`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:5176`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes_with_conn` — L13-vfs-api: `crates/dstu-vfs/src/dstu/trash_handlers.rs:690`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs:183`
- `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::set_favorite` — L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:4583`
- `dstu_vfs::vfs::repos::note_revision_repo::install_storage_hooks` — F1-kernel: `src/extensions.rs:160`
- `dstu_vfs::vfs::repos::note_revision_repo::NoteAssetRef` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:209`
- `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::snapshot` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:312`
- `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_DELETE_ITEM` — L22-app-commands: `tests/phase5_tool_execution_e2e.rs:379`, `tests/phase5_tool_execution_e2e.rs:390`, `tests/phase5_tool_execution_e2e.rs:404`, `tests/phase5_tool_execution_e2e.rs:436`
- `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_RESTORE` — L22-app-commands: `tests/phase5_tool_execution_e2e.rs:411`, `tests/phase5_tool_execution_e2e.rs:429`, `tests/phase5_tool_execution_e2e.rs:515`, `tests/phase5_tool_execution_e2e.rs:533`
- `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo` — L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:575`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:638`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:713`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:729`
- 其余 16 个条目的引用点见 `draft.json`。

## 消费其他 lane

### F4-security（17 个条目，prod 461 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::database` | method | 199/0 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::models::AppError::validation` | method | 59/0 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 58/0 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::models::AppError::internal` | method | 48/0 | `crates/dstu-notes/src/notes_exporter.rs`, `src/cmd/notes.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 27/0 | `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::models::AppError` | struct | 21/0 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 12/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::models::AppError::not_found` | method | 8/0 | `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::tool_args::with_localized_message` ? | fn | 8/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 4/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 4/0 | `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 3/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 3/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_core::models::AppError::conflict` | method | 3/0 | `crates/dstu-notes/src/notes_manager.rs`, `src/cmd/notes.rs` |
| `dstu_core::APP_VERSION` | const | 2/0 | `crates/dstu-notes/src/notes_exporter.rs` |
| `dstu_core::models::RagConfigRequest` | struct | 1/0 | `src/cmd/notes.rs` |
| `dstu_core::tool_args::ensure_localized_error` ? | fn | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |

### L13-vfs-api（37 个条目，prod 421 / test 120）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::error::VfsResult` | type | 157/0 | `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs`, `crates/dstu-vfs/src/vfs/repos/note_history_restore.rs`, `crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs` 等 11 个 |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 79/1 | `crates/dstu-notes/src/notes_manager.rs`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs`, `crates/dstu-vfs/src/vfs/repos/note_repo.rs` 等 7 个 |
| `dstu_vfs::vfs::types::VfsNote` ? | struct | 56/16 | `crates/dstu-notes/src/notes_manager.rs`, `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs` 等 10 个 |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 50/4 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `crates/dstu-vfs/src/vfs/repos/note_repo.rs` 等 6 个 |
| `dstu_vfs::vfs::types::VfsUpdateNoteParams` ? | struct | 18/21 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs` 等 14 个 |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 12/31 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs`, `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs` 等 12 个 |
| `dstu_vfs::dstu::types::DstuNode` | struct | 7/0 | `src/cmd/notes.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::note_to_dstu_node` | fn | 6/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/cmd/notes.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` | fn | 5/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/cmd/notes.rs` |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 3/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | 2/0 | `src/cmd/notes.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::updated` | method | 2/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/cmd/notes.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService::new` ? | method | 2/0 | `src/cmd/notes.rs` |
| `dstu_vfs::vfs::types::ResourceLocation` | struct | 2/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsTodoItem` | struct | 1/1 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent` | struct | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::deleted` | method | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService` | struct | 1/0 | `src/cmd/notes.rs` |
| `dstu_vfs::vfs::note_props::MalformedPropsKind` | enum | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::MAX_PROP_KEY_CHARS` | const | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::MAX_PROP_VALUE_CHARS` | const | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::MAX_PROPS` | const | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::parse_props_cell` | fn | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::PROPS_RESERVED_KEYS` | const | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::record_malformed_props` | fn | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::note_props::validate_prop_key` | fn | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsCreateTodoItemParams` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::types::VfsCreateTodoListParams` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::types::VfsFolderItem` ? | struct | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsFolderItem::new` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsNote::generate_id` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsTodoList` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::types::VfsUpdateTodoItemParams` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::types::VfsUpdateTodoListParams` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/43 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs`, `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs` 等 10 个 |
| `dstu_vfs::vfs::note_props::malformed_props_total` ? | fn | 0/2 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | 0/1 | `src/chat_v2/tools/canvas_executor.rs` |

### L22-app-commands（1 个条目，prod 83 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 83/0 | `src/chat_v2/tools/notes_import_executor.rs`, `src/cmd/notes.rs` |

### L04-chat-session（15 个条目，prod 69 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 31/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_agent::chat_v2::tools::strip_canvas_builtin_prefix` ? | fn | 6/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_APPEND` ? | const | 5/2 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_SET` ? | const | 5/2 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_REPLACE` ? | const | 5/1 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::error::ChatV2Error` ? | enum | 3/0 | `src/chat_v2/handlers/canvas_handlers.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 3/0 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_CREATE` ? | const | 2/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_DELETE` ? | const | 2/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_UPDATE_TAGS` ? | const | 2/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::resolve_staged_file_in_temp_root` ? | fn | 1/0 | `src/chat_v2/tools/notes_import_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_LIST` ? | const | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_READ` ? | const | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_SEARCH` ? | const | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::is_canvas_tool` ? | fn | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |

### F3-storage（18 个条目，prod 51 / test 9）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 9/2 | `crates/dstu-notes/src/notes_exporter.rs`, `crates/dstu-notes/src/notes_manager.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 6/1 | `crates/dstu-notes/src/notes_exporter.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 5/0 | `src/cmd/notes.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::try_acquire` | method | 4/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::active_data_dir_from_runtime_base` | fn | 4/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::asset_local_path_from_key` | fn | 4/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::asset_key_from_relative_path` | fn | 3/0 | `src/cmd/notes.rs` |
| `dstu_storage::unified_file_manager::ensure_local_path` | fn | 3/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::delete_asset_with_journal` | fn | 2/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::finish_asset_deletion_with_conn` | fn | 2/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::prepare_asset_deletion_with_conn` | fn | 2/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::recover_asset_deletions` | fn | 2/0 | `src/cmd/notes.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 2/0 | `src/cmd/notes.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard` | struct | 1/0 | `src/cmd/notes.rs` |
| `dstu_storage::file_deletion_queue::NoteAssetRetention` | trait | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs` |
| `dstu_storage::file_deletion_queue::register_note_asset_retention` | fn | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/4 | `crates/dstu-notes/src/notes_exporter.rs`, `src/notes_app_tests.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/2 | `crates/dstu-notes/src/notes_exporter.rs`, `src/notes_app_tests.rs` |

### L11-vfs-repos（42 个条目，prod 48 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_item` | method | 3/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::compute_hash_with_salt` | method | 2/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::create_or_reuse_with_conn_and_hash` | method | 2/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_list` | method | 2/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_completed_items` | method | 2/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_items_by_list` | method | 2/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_pending` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::add_item_to_folder_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::folder_exists_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_resource_location_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::remove_item_by_item_id_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource` | fn | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::compute_hash` | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_repo.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo` | struct | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::count_deleted_todo_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::count_deleted_todo_lists` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_item` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_list` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::delete_todo_item_if_version` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::delete_todo_list_if_version` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::ensure_default_inbox` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::format_active_summary_for_prompt` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_active_todo_summary` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_all_pending_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_deleted_todo_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_deleted_todo_lists` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_overdue_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_today_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_todo_lists` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_upcoming_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::reorder_items` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::restore_todo_item` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::restore_todo_list` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::search_items_paginated` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::toggle_todo_item` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::update_todo_item` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::update_todo_list_if_version` | method | 1/0 | `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder` ? | method | 0/1 | `src/chat_v2/tools/canvas_executor.rs` |

### L07-agent-skills-ptc（7 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::workbench_bridge::uncertain_apply_receipt` ? | fn | 4/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::acr_bridge_call` ? | fn | 2/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::apply_ops_timeout_ms` ? | fn | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_bridge_cancelled` ? | fn | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_valid_apply_receipt` ? | fn | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::PROBE_TIMEOUT_MS` ? | const | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_executor::is_workbench_agent_delegation_enabled` ? | fn | 1/0 | `src/chat_v2/tools/canvas_executor.rs` |

### F1-kernel（3 个条目，prod 11 / test 17）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 10/16 | `src/chat_v2/tools/canvas_executor.rs`, `src/chat_v2/tools/notes_import_executor.rs`, `src/chat_v2/tools/user_todo_executor.rs` |
| `dstu_kernel::plugin::Scope` | struct | 1/0 | `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs` |
| `deep_student_lib::extensions::register_extensions` | fn | 0/1 | `src/notes_app_tests.rs` |

### L12-vfs-index（3 个条目，prod 4 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 2/0 | `src/cmd/notes.rs` |
| `dstu_vfs::lance_vector_store::default_lance_root_from_db_path` | fn | 1/0 | `crates/dstu-notes/src/notes_manager.rs` |
| `dstu_vfs::lance_vector_store::ensure_mobile_tmpdir_within` | fn | 1/0 | `crates/dstu-notes/src/notes_manager.rs` |

### L05-agent-workspace（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::runtime_roots::temp_root` ? | fn | 1/0 | `src/chat_v2/tools/notes_import_executor.rs` |

### L02-llm-manager（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::adapters::moonshot::normalize_tool_schemas_for_mfjs` | fn | 0/1 | `src/chat_v2/tools/user_todo_executor.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::notes::*` @ `src/commands.rs:50`
