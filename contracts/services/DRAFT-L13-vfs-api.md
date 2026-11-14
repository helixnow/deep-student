# 跨 lane 服务草稿：L13-vfs-api

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（181 个条目，其中 175 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_vfs::vfs::error::VfsResult` | type | `crates/dstu-vfs/src/vfs/error.rs:8` | L11-vfs-repos 929/0<br>L12-vfs-index 198/0<br>L10-notes 157/0<br>L17-memory-research 151/0<br>L15-review-analytics 4/0 | `pub type VfsResult<T> = Result<T, VfsError>` |
| `dstu_vfs::vfs::error::VfsError` ? | enum | `crates/dstu-vfs/src/vfs/error.rs:12` | L11-vfs-repos 488/5<br>L12-vfs-index 223/5<br>L10-notes 79/1<br>L17-memory-research 72/7<br>L14-qbank 19/0<br>L02-llm-manager 7/0<br>L18-media-docs 4/1<br>L15-review-analytics 2/0<br>L05-agent-workspace 1/0 | `pub enum VfsError` |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | `crates/dstu-vfs/src/vfs/database.rs:50` | L11-vfs-repos 412/19<br>L14-qbank 97/36<br>L17-memory-research 75/1<br>L18-media-docs 60/3<br>L10-notes 50/4<br>L12-vfs-index 32/1<br>L15-review-analytics 31/4<br>L04-chat-session 29/0<br>L02-llm-manager 8/2<br>L06-agent-orchestration 7/0<br>L24-chatanki 7/2<br>L03-chat-pipeline 6/0<br>L19-mcp-browser 5/1<br>L05-agent-workspace 3/0<br>L07-agent-skills-ptc 1/0<br>L22-app-commands 1/10<br>F4-security 1/0<br>F2-shell 1/0<br>F3-storage 0/1 | `pub struct VfsDatabase` |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | `crates/dstu-vfs/src/vfs/types.rs:86` | L12-vfs-index 65/4<br>L11-vfs-repos 28/9<br>L24-chatanki 27/43<br>L05-agent-workspace 11/1<br>L17-memory-research 3/0<br>L10-notes 3/0<br>L18-media-docs 2/0<br>L16-anki 0/3 | `pub enum VfsResourceType` |
| `dstu_vfs::vfs::types::VfsNote` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:312` | L10-notes 56/16<br>L17-memory-research 31/2<br>L22-app-commands 0/2 | `pub struct VfsNote` |
| `dstu_vfs::vfs::types::VfsTextbook` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:362` | L11-vfs-repos 36/1<br>L18-media-docs 7/2 | `pub struct VfsTextbook` |
| `dstu_vfs::vfs::types::VfsFile` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:1875` | L11-vfs-repos 34/0<br>L19-mcp-browser 3/0<br>L24-chatanki 2/0<br>L18-media-docs 2/1<br>L14-qbank 2/1 | `pub struct VfsFile` |
| `dstu_vfs::vfs::types::VfsUpdateNoteParams` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:2235` | L17-memory-research 22/1<br>L10-notes 18/21<br>L20-sync 0/1 | `pub struct VfsUpdateNoteParams` |
| `dstu_vfs::vfs::types::VfsTodoItem` | struct | `crates/dstu-vfs/src/vfs/types.rs:818` | L11-vfs-repos 36/2<br>L10-notes 1/1 | `pub struct VfsTodoItem` |
| `dstu_vfs::vfs::types::VfsResourceRef` | struct | `crates/dstu-vfs/src/vfs/types.rs:2532` | L05-agent-workspace 32/2<br>L24-chatanki 2/8<br>L16-anki 0/2 | `pub struct VfsResourceRef` |
| `dstu_vfs::vfs::types::VfsExamSheet` | struct | `crates/dstu-vfs/src/vfs/types.rs:448` | L11-vfs-repos 34/0 | `pub struct VfsExamSheet` |
| `dstu_vfs::vfs::types::VfsEssay` | struct | `crates/dstu-vfs/src/vfs/types.rs:1550` | L11-vfs-repos 32/0<br>L02-llm-manager 1/0 | `pub struct VfsEssay` |
| `dstu_vfs::vfs::types::VfsFolderItem` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:1350` | L11-vfs-repos 31/0<br>L10-notes 1/0<br>L19-mcp-browser 1/0 | `pub struct VfsFolderItem` |
| `dstu_vfs::vfs::types::VfsMindMap` | struct | `crates/dstu-vfs/src/vfs/types.rs:586` | L11-vfs-repos 33/0 | `pub struct VfsMindMap` |
| `dstu_vfs::vfs::types::VfsTranslation` | struct | `crates/dstu-vfs/src/vfs/types.rs:503` | L11-vfs-repos 28/0<br>L02-llm-manager 1/0 | `pub struct VfsTranslation` |
| `dstu_vfs::vfs::types::VfsTodoList` | struct | `crates/dstu-vfs/src/vfs/types.rs:766` | L11-vfs-repos 25/1<br>L10-notes 1/0 | `pub struct VfsTodoList` |
| `dstu_vfs::vfs::types::VfsFolder` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:1274` | L11-vfs-repos 18/5<br>L17-memory-research 4/0<br>L04-chat-session 1/0<br>L18-media-docs 1/0<br>L22-app-commands 0/1<br>L02-llm-manager 0/1 | `pub struct VfsFolder` |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:2218` | L10-notes 12/31<br>L17-memory-research 10/1<br>L06-agent-orchestration 1/0<br>L18-media-docs 0/1<br>L20-sync 0/5<br>L11-vfs-repos 0/3<br>L14-qbank 0/1<br>L21-backup-governance 0/1<br>L22-app-commands 0/2 | `pub struct VfsCreateNoteParams` |
| `dstu_vfs::vfs::types::VfsEssaySession` | struct | `crates/dstu-vfs/src/vfs/types.rs:1630` | L11-vfs-repos 16/0<br>L02-llm-manager 4/0<br>L15-review-analytics 3/0 | `pub struct VfsEssaySession` |
| `dstu_vfs::vfs::types::VfsContextRefData` | struct | `crates/dstu-vfs/src/vfs/types.rs:2565` | L24-chatanki 17/42<br>L04-chat-session 2/0<br>L05-agent-workspace 2/0<br>L16-anki 0/2 | `pub struct VfsContextRefData` |
| `dstu_vfs::vfs::types::VfsResource` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:204` | L11-vfs-repos 14/0<br>L12-vfs-index 6/2<br>L19-mcp-browser 1/0 | `pub struct VfsResource` |
| `dstu_vfs::vfs::types::PdfPreviewJson` | struct | `crates/dstu-vfs/src/vfs/types.rs:2851` | L11-vfs-repos 9/0<br>L05-agent-workspace 4/0<br>L12-vfs-index 4/0 | `pub struct PdfPreviewJson` |
| `dstu_vfs::vfs::types::VfsMindMapVersion` | struct | `crates/dstu-vfs/src/vfs/types.rs:655` | L11-vfs-repos 17/0 | `pub struct VfsMindMapVersion` |
| `dstu_vfs::vfs::types::VfsUploadAttachmentResult` | struct | `crates/dstu-vfs/src/vfs/types.rs:2040` | L11-vfs-repos 17/0 | `pub struct VfsUploadAttachmentResult` |
| `dstu_vfs::vfs::types::VfsCreateExamSheetParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:2325` | L11-vfs-repos 8/2<br>L14-qbank 7/11<br>L18-media-docs 1/0<br>L15-review-analytics 0/3 | `pub struct VfsCreateExamSheetParams` |
| `dstu_vfs::vfs::types::VfsFolderItem::new` ? | method | `crates/dstu-vfs/src/vfs/types.rs:1388` | L11-vfs-repos 12/2<br>L18-media-docs 2/0<br>L10-notes 1/0<br>L19-mcp-browser 1/0 | `pub fn new(folder_id: Option<String>, item_type: String, item_id: String) -> Self` |
| `dstu_vfs::vfs::types::FolderTreeNode` | struct | `crates/dstu-vfs/src/vfs/types.rs:1430` | L11-vfs-repos 8/0<br>L17-memory-research 7/0 | `pub struct FolderTreeNode` |
| `dstu_vfs::vfs::ocr_utils::parse_ocr_pages_json` | fn | `crates/dstu-vfs/src/vfs/ocr_utils.rs:44` | L11-vfs-repos 8/0<br>L12-vfs-index 4/0<br>L05-agent-workspace 2/0 | `pub fn parse_ocr_pages_json(json_str: &str) -> Vec<Option<String>>` |
| `dstu_vfs::vfs::types::VfsAttachment` | struct | `crates/dstu-vfs/src/vfs/types.rs:1777` | L11-vfs-repos 12/0<br>L18-media-docs 2/0 | `pub struct VfsAttachment` |
| `dstu_vfs::vfs::types::VfsUploadAttachmentParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:2022` | L11-vfs-repos 12/0<br>L18-media-docs 2/0 | `pub struct VfsUploadAttachmentParams` |
| `dstu_vfs::vfs::types::VfsResourceMetadata` ? | struct | `crates/dstu-vfs/src/vfs/types.rs:168` | L11-vfs-repos 9/0<br>L17-memory-research 1/0<br>L12-vfs-index 1/2<br>L18-media-docs 1/0<br>L19-mcp-browser 1/0 | `pub struct VfsResourceMetadata` |
| `dstu_vfs::vfs::types::ResourceLocation` | struct | `crates/dstu-vfs/src/vfs/types.rs:2729` | L11-vfs-repos 11/0<br>L10-notes 2/0 | `pub struct ResourceLocation` |
| `dstu_vfs::vfs::qbank_types::QuestionMaterial` | struct | `crates/dstu-vfs/src/vfs/qbank_types.rs:20` | L14-qbank 9/2<br>L11-vfs-repos 3/0 | `pub struct QuestionMaterial` |
| `dstu_vfs::vfs::canonical_folder_item_type` | fn | `crates/dstu-vfs/src/vfs/mod.rs:147` | L11-vfs-repos 11/0 | `pub fn canonical_folder_item_type(item_type: &str) -> &str` |
| `dstu_vfs::vfs::qbank_types::SourceRef` | struct | `crates/dstu-vfs/src/vfs/qbank_types.rs:11` | L14-qbank 5/0<br>L11-vfs-repos 5/0 | `pub struct SourceRef` |
| `dstu_vfs::vfs::types::VfsBlob` | struct | `crates/dstu-vfs/src/vfs/types.rs:1730` | L11-vfs-repos 10/0 | `pub struct VfsBlob` |
| `dstu_vfs::vfs::types::VfsUpdateTodoItemParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:1009` | L11-vfs-repos 8/5<br>L10-notes 1/0 | `pub struct VfsUpdateTodoItemParams` |
| `dstu_vfs::vfs::types::VfsCreateResourceResult` | struct | `crates/dstu-vfs/src/vfs/types.rs:292` | L11-vfs-repos 9/0 | `pub struct VfsCreateResourceResult` |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | `crates/dstu-vfs/src/vfs/types.rs:1323` | L17-memory-research 6/1<br>L04-chat-session 1/0<br>L18-media-docs 1/0<br>L11-vfs-repos 0/14<br>L10-notes 0/1<br>L22-app-commands 0/1<br>L02-llm-manager 0/1 | `pub fn new( title: String, parent_id: Option<String>, icon: Option<String>, color: Option<String>, ) -> Self` |
| `dstu_vfs::vfs::types::PdfInjectMode` | enum | `crates/dstu-vfs/src/vfs/types.rs:2446` | L04-chat-session 6/0<br>L05-agent-workspace 2/1 | `pub enum PdfInjectMode` |
| `dstu_vfs::vfs::types::PomodoroDailyStat` | struct | `crates/dstu-vfs/src/vfs/types.rs:1218` | L11-vfs-repos 5/0<br>L17-memory-research 3/1 | `pub struct PomodoroDailyStat` |
| `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:129` | L10-notes 5/0<br>L06-agent-orchestration 1/0<br>L19-mcp-browser 1/0<br>L02-llm-manager 1/0 | `pub fn emit_watch_event(window: &Window, event: DstuWatchEvent)` |
| `dstu_vfs::vfs::types::PomodoroRecord` | struct | `crates/dstu-vfs/src/vfs/types.rs:1112` | L11-vfs-repos 8/0 | `pub struct PomodoroRecord` |
| `dstu_vfs::vfs::types::VfsCreateTranslationParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:2355` | L11-vfs-repos 6/2<br>L02-llm-manager 1/0 | `pub struct VfsCreateTranslationParams` |
| `dstu_vfs::vfs::types::ImageInjectMode` | enum | `crates/dstu-vfs/src/vfs/types.rs:2436` | L04-chat-session 5/0<br>L05-agent-workspace 2/1 | `pub enum ImageInjectMode` |
| `dstu_vfs::vfs::types::ResourceInjectModes` | struct | `crates/dstu-vfs/src/vfs/types.rs:2458` | L04-chat-session 7/0<br>L05-agent-workspace 0/1 | `pub struct ResourceInjectModes` |
| `dstu_vfs::dstu::handler_utils::node_converters::note_to_dstu_node` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:166` | L10-notes 6/0<br>L06-agent-orchestration 1/0 | `pub fn note_to_dstu_node(note: &VfsNote) -> DstuNode` |
| `dstu_vfs::dstu::types::DstuNode` | struct | `crates/dstu-vfs/src/dstu/types.rs:163` | L10-notes 7/0 | `pub struct DstuNode` |
| `dstu_vfs::vfs::index_service::VfsIndexService::new` ? | method | `crates/dstu-vfs/src/vfs/index_service.rs:114` | L12-vfs-index 2/0<br>L19-mcp-browser 2/1<br>L10-notes 2/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | `crates/dstu-vfs/src/dstu/types.rs:610` | L10-notes 2/0<br>L06-agent-orchestration 1/0<br>L18-media-docs 1/0<br>L19-mcp-browser 1/0<br>L02-llm-manager 1/0 | `pub fn created(path: impl Into<String>, node: DstuNode) -> Self` |
| `dstu_vfs::vfs::ocr_utils::OCR_FAILED_MARKER` | const | `crates/dstu-vfs/src/vfs/ocr_utils.rs:11` | L12-vfs-index 6/0 | `pub const OCR_FAILED_MARKER: &str = "__OCR_FAILED__"` |
| `dstu_vfs::vfs::qbank_helpers::refresh_canonical_preview_with_conn` | fn | `crates/dstu-vfs/src/vfs/qbank_helpers.rs:46` | L14-qbank 5/0<br>L11-vfs-repos 1/0 | `pub fn refresh_canonical_preview_with_conn( conn: &Connection, exam_id: &str, ) -> Result<(), AppError>` |
| `dstu_vfs::vfs::question_sync_service::QuestionSyncService::mark_as_modified_with_conn` | method | `crates/dstu-vfs/src/vfs/question_sync_service.rs:1518` | L14-qbank 4/0<br>L11-vfs-repos 2/0 | `pub fn mark_as_modified_with_conn(conn: &Connection, question_id: &str) -> VfsResult<()>` |
| `dstu_vfs::vfs::question_sync_service::QuestionSyncService::update_content_hash_with_conn` | method | `crates/dstu-vfs/src/vfs/question_sync_service.rs:1540` | L14-qbank 4/0<br>L11-vfs-repos 2/0 | `pub fn update_content_hash_with_conn( conn: &Connection, question_id: &str, ) -> VfsResult<String>` |
| `dstu_vfs::vfs::types::VfsCreateEssayParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:2387` | L11-vfs-repos 5/0<br>L02-llm-manager 1/0 | `pub struct VfsCreateEssayParams` |
| `dstu_vfs::vfs::types::VfsCreateEssaySessionParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:1703` | L11-vfs-repos 4/0<br>L02-llm-manager 1/0<br>L14-qbank 1/0 | `pub struct VfsCreateEssaySessionParams` |
| `dstu_vfs::vfs::types::VfsCreateTodoItemParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:962` | L11-vfs-repos 2/7<br>L06-agent-orchestration 1/0<br>L17-memory-research 1/0<br>L10-notes 1/0 | `pub struct VfsCreateTodoItemParams` |
| `dstu_vfs::vfs::types::VfsCreateTodoListParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:917` | L11-vfs-repos 3/2<br>L17-memory-research 1/0<br>L10-notes 1/0 | `pub struct VfsCreateTodoListParams` |
| `dstu_vfs::vfs::index_service::VfsIndexService` | struct | `crates/dstu-vfs/src/vfs/index_service.rs:108` | L12-vfs-index 2/0<br>L11-vfs-repos 1/0<br>L19-mcp-browser 1/0<br>L10-notes 1/0 | `pub struct VfsIndexService` |
| `dstu_vfs::vfs::types::VfsCreateMindMapParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:694` | L11-vfs-repos 5/0 | `pub struct VfsCreateMindMapParams` |
| `dstu_vfs::vfs::unit_builder::trait_def::UnitBuildInput` | struct | `crates/dstu-vfs/src/vfs/unit_builder/trait_def.rs:7` | L12-vfs-index 4/0<br>L19-mcp-browser 1/0 | `pub struct UnitBuildInput` |
| `dstu_vfs::dstu::handler_utils::node_converters::parse_timestamp` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:48` | L18-media-docs 4/1 | `pub fn parse_timestamp(s: &str) -> i64` |
| `dstu_vfs::dstu::types::DstuWatchEvent` | struct | `crates/dstu-vfs/src/dstu/types.rs:591` | L06-agent-orchestration 1/0<br>L10-notes 1/0<br>L19-mcp-browser 1/0<br>L02-llm-manager 1/0 | `pub struct DstuWatchEvent` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionFailure` | struct | `crates/dstu-vfs/src/vfs/hooks.rs:75` | L18-media-docs 4/0 | `pub struct MediaTranscriptionFailure` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionProgress` | struct | `crates/dstu-vfs/src/vfs/hooks.rs:61` | L18-media-docs 2/0<br>L12-vfs-index 2/0 | `pub struct MediaTranscriptionProgress` |
| `dstu_vfs::vfs::ocr_utils::has_valid_text` | fn | `crates/dstu-vfs/src/vfs/ocr_utils.rs:15` | L12-vfs-index 4/0 | `pub fn has_valid_text(text: Option<&str>, threshold: usize) -> bool` |
| `dstu_vfs::vfs::types::VfsFile::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:2001` | L11-vfs-repos 4/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsUpdateMindMapParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:722` | L11-vfs-repos 4/0 | `pub struct VfsUpdateMindMapParams` |
| `dstu_vfs::vfs::VECTOR_INDEX_AVAILABLE` | const | `crates/dstu-vfs/src/vfs/mod.rs:130` | L12-vfs-index 3/0<br>L19-mcp-browser 1/0 | `pub const VECTOR_INDEX_AVAILABLE: bool = cfg!(feature = "lance")` |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::build_numbered_sources` | fn | `src/chat_v2/tools/builtin_retrieval_executor.rs:1050` | L17-memory-research 3/2 | `pub(crate) fn build_numbered_sources( sources: &[SourceInfo], ledger: &mut crate::chat_v2::context::CitationLedger, ) -> Vec<Value>` |
| `dstu_vfs::vfs::types::VfsUpdateTodoListParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:941` | L11-vfs-repos 2/2<br>L10-notes 1/0 | `pub struct VfsUpdateTodoListParams` |
| `dstu_vfs::dstu::types::DstuWatchEvent::updated` | method | `crates/dstu-vfs/src/dstu/types.rs:620` | L10-notes 2/0<br>L19-mcp-browser 1/0 | `pub fn updated(path: impl Into<String>, node: DstuNode) -> Self` |
| `dstu_vfs::pdf_protocol::resolve_allowed_dirs` | fn | `crates/dstu-vfs/src/pdf_protocol.rs:259` | F2-shell 2/0<br>L22-app-commands 1/0 | `pub fn resolve_allowed_dirs(app: &tauri::AppHandle) -> Vec<PathBuf>` |
| `dstu_vfs::textbooks_db::Textbook` | struct | `crates/dstu-vfs/src/textbooks_db.rs:22` | L18-media-docs 3/0 | `pub struct Textbook` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionRequest` | struct | `crates/dstu-vfs/src/vfs/hooks.rs:83` | L18-media-docs 2/0<br>L12-vfs-index 1/0 | `pub struct MediaTranscriptionRequest` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionSummary` | struct | `crates/dstu-vfs/src/vfs/hooks.rs:68` | L18-media-docs 3/0 | `pub struct MediaTranscriptionSummary` |
| `dstu_vfs::vfs::media_index::TRANSCRIPT_TEXT_SOURCE` | const | `crates/dstu-vfs/src/vfs/media_index.rs:28` | L12-vfs-index 3/0 | `pub const TRANSCRIPT_TEXT_SOURCE: &str = "transcript"` |
| `dstu_vfs::vfs::ocr_utils::has_valid_ocr_pages` | fn | `crates/dstu-vfs/src/vfs/ocr_utils.rs:21` | L12-vfs-index 3/0 | `pub fn has_valid_ocr_pages(pages: &[Option<String>], threshold: usize) -> bool` |
| `dstu_vfs::vfs::qbank_read::context_with_conn` | fn | `crates/dstu-vfs/src/vfs/qbank_read.rs:5` | L12-vfs-index 3/0 | `pub fn context_with_conn(conn: &Connection, exam_id: &str) -> Result<Option<Value>, String>` |
| `dstu_vfs::vfs::types::FolderResourcesResult` | struct | `crates/dstu-vfs/src/vfs/types.rs:1446` | L11-vfs-repos 3/0 | `pub struct FolderResourcesResult` |
| `dstu_vfs::vfs::types::PomodoroHourlyStat` | struct | `crates/dstu-vfs/src/vfs/types.rs:1242` | L11-vfs-repos 3/0 | `pub struct PomodoroHourlyStat` |
| `dstu_vfs::vfs::types::PomodoroStreakStats` | struct | `crates/dstu-vfs/src/vfs/types.rs:1232` | L11-vfs-repos 3/0 | `pub struct PomodoroStreakStats` |
| `dstu_vfs::vfs::types::PomodoroTodayStats` | struct | `crates/dstu-vfs/src/vfs/types.rs:1202` | L11-vfs-repos 3/0 | `pub struct PomodoroTodayStats` |
| `dstu_vfs::vfs::types::TodoActiveSummary` | struct | `crates/dstu-vfs/src/vfs/types.rs:1068` | L11-vfs-repos 3/0 | `pub struct TodoActiveSummary` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | `crates/dstu-vfs/src/vfs/database.rs:74` | L21-backup-governance 1/1<br>F2-shell 1/0<br>L04-chat-session 0/1<br>L19-mcp-browser 0/1<br>L17-memory-research 0/1<br>L15-review-analytics 0/1<br>L24-chatanki 0/1<br>L22-app-commands 0/5<br>L14-qbank 0/3<br>F3-storage 0/12<br>L02-llm-manager 0/1 | `pub fn new(app_data_dir: &Path) -> VfsResult<Self>` |
| `dstu_vfs::vfs::qbank_helpers::retains_asset` | fn | `crates/dstu-vfs/src/vfs/qbank_helpers.rs:20` | L11-vfs-repos 2/0<br>L14-qbank 0/3 | `pub fn retains_asset(conn: &Connection, value: &str) -> Result<bool, rusqlite::Error>` |
| `dstu_vfs::vfs::types::resolve_pdf_inject_modes` | fn | `crates/dstu-vfs/src/vfs/types.rs:2505` | L05-agent-workspace 2/3 | `pub fn resolve_pdf_inject_modes( pdf_modes: Option<&Vec<PdfInjectMode>>, is_multimodal: bool, ) -> (bool, bool, bool, bool)` |
| `dstu_vfs::vfs::types::StorageMode` ? | enum | `crates/dstu-vfs/src/vfs/types.rs:49` | L11-vfs-repos 2/0<br>L12-vfs-index 0/3 | `pub enum StorageMode` |
| `dstu_vfs::vfs::types::CreatePomodoroRecordParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:1172` | L11-vfs-repos 2/2 | `pub struct CreatePomodoroRecordParams` |
| `dstu_vfs::vfs::media_index::MediaTimeRange` | struct | `crates/dstu-vfs/src/vfs/media_index.rs:39` | L12-vfs-index 2/1 | `pub struct MediaTimeRange` |
| `dstu_vfs::file_stream_protocol::cors_origin_for_request` | fn | `crates/dstu-vfs/src/file_stream_protocol.rs:209` | L18-media-docs 1/0<br>F2-shell 1/0 | `pub fn cors_origin_for_request(request: &tauri::http::Request<Vec<u8>>) -> String` |
| `dstu_vfs::pdf_protocol::windows_comparable_path_text` | fn | `crates/dstu-vfs/src/pdf_protocol.rs:111` | L05-agent-workspace 2/0 | `pub fn windows_comparable_path_text(path: &str) -> String` |
| `dstu_vfs::vfs::file_folder_item_sql` | fn | `crates/dstu-vfs/src/vfs/mod.rs:158` | L11-vfs-repos 2/0 | `pub fn file_folder_item_sql(column: &str) -> String` |
| `dstu_vfs::vfs::media_index::range_for_unit` | fn | `crates/dstu-vfs/src/vfs/media_index.rs:254` | L12-vfs-index 2/0 | `pub fn range_for_unit(ranges: &[MediaTimeRange], unit_index: i32) -> Option<MediaTimeRange>` |
| `dstu_vfs::vfs::media_index::segment_metadata_json` | fn | `crates/dstu-vfs/src/vfs/media_index.rs:77` | L12-vfs-index 2/0 | `pub fn segment_metadata_json(range: MediaTimeRange) -> String` |
| `dstu_vfs::vfs::media_index::unit_time_ranges` | fn | `crates/dstu-vfs/src/vfs/media_index.rs:243` | L12-vfs-index 2/0 | `pub fn unit_time_ranges(conn: &Connection, resource_id: &str) -> VfsResult<Vec<MediaTimeRange>>` |
| `dstu_vfs::vfs::ocr_utils::classify_pdf_content` | fn | `crates/dstu-vfs/src/vfs/ocr_utils.rs:35` | L12-vfs-index 2/0 | `pub fn classify_pdf_content(extracted_text: Option<&str>, threshold: usize) -> PdfContentKind` |
| `dstu_vfs::vfs::ocr_utils::join_ocr_pages_text` | fn | `crates/dstu-vfs/src/vfs/ocr_utils.rs:192` | L12-vfs-index 2/0 | `pub fn join_ocr_pages_text( pages: &[Option<String>], header_prefix: &str, header_suffix: &str, ) -> Option<String>` |
| `dstu_vfs::vfs::qbank_read::context_text` | fn | `crates/dstu-vfs/src/vfs/qbank_read.rs:31` | L12-vfs-index 2/0 | `pub fn context_text(document: &Value) -> String` |
| `dstu_vfs::vfs::ref_handlers::extract_file_text_with_strategy` | fn | `crates/dstu-vfs/src/vfs/ref_handlers.rs:1877` | L14-qbank 2/0 | `pub fn extract_file_text_with_strategy( conn: &Connection, source_id: &str, file_name: &str, base64_content: Option<&str>, ) -> Option<String>` |
| `dstu_vfs::vfs::types::FolderResourceInfo` | struct | `crates/dstu-vfs/src/vfs/types.rs:1466` | L11-vfs-repos 2/0 | `pub struct FolderResourceInfo` |
| `dstu_vfs::vfs::types::PdfPagePreview` | struct | `crates/dstu-vfs/src/vfs/types.rs:2878` | L11-vfs-repos 2/0 | `pub struct PdfPagePreview` |
| `dstu_vfs::vfs::types::PomodoroTodoStat` | struct | `crates/dstu-vfs/src/vfs/types.rs:1254` | L11-vfs-repos 2/0 | `pub struct PomodoroTodoStat` |
| `dstu_vfs::vfs::types::TodoSummaryItem` | struct | `crates/dstu-vfs/src/vfs/types.rs:1082` | L11-vfs-repos 2/0 | `pub struct TodoSummaryItem` |
| `dstu_vfs::vfs::types::VfsAttachment::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:1842` | L11-vfs-repos 2/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsResource::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:252` | L11-vfs-repos 2/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsResourceType::from_str` ? | method | `crates/dstu-vfs/src/vfs/types.rs:128` | L11-vfs-repos 1/0<br>L12-vfs-index 1/0 | `pub fn from_str(s: &str) -> Option<Self>` |
| `dstu_vfs::vfs::types::VfsTodoItem::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:909` | L11-vfs-repos 2/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsUpdateEssaySessionParams` | struct | `crates/dstu-vfs/src/vfs/types.rs:1675` | L02-llm-manager 1/0<br>L15-review-analytics 1/0 | `pub struct VfsUpdateEssaySessionParams` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | `crates/dstu-vfs/src/vfs/database.rs:529` | L17-memory-research 1/14<br>L18-media-docs 0/19<br>L10-notes 0/43<br>L14-qbank 0/29<br>L21-backup-governance 0/1<br>L20-sync 0/10<br>L12-vfs-index 0/15<br>L11-vfs-repos 0/38<br>L24-chatanki 0/3<br>L02-llm-manager 0/1<br>L15-review-analytics 0/2 | `pub fn setup_migrated_test_db() -> (tempfile::TempDir, VfsDatabase)` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor::new` | method | `src/chat_v2/tools/generative_ui_executor.rs:47` | F1-kernel 1/0<br>L22-app-commands 0/9 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor` | struct | `src/chat_v2/tools/dstu_executor.rs:396` | F1-kernel 1/2<br>L22-app-commands 0/1 | `pub struct DstuToolExecutor` |
| `deep_student_lib::chat_v2::tools::builtin_resource_executor::BuiltinResourceExecutor` | struct | `src/chat_v2/tools/builtin_resource_executor.rs:72` | F1-kernel 1/2 | `pub struct BuiltinResourceExecutor` |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::BuiltinRetrievalExecutor` | struct | `src/chat_v2/tools/builtin_retrieval_executor.rs:83` | F1-kernel 1/2 | `pub struct BuiltinRetrievalExecutor` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor::new` | method | `src/chat_v2/tools/dstu_executor.rs:399` | F1-kernel 1/1<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_vfs::vfs::types::resolve_image_inject_modes` | fn | `crates/dstu-vfs/src/vfs/types.rs:2481` | L05-agent-workspace 1/2 | `pub fn resolve_image_inject_modes( image_modes: Option<&Vec<ImageInjectMode>>, is_multimodal: bool, ) -> (bool, bool, bool)` |
| `dstu_vfs::vfs::types::VfsEssay::generate_id` ? | method | `crates/dstu-vfs/src/vfs/types.rs:1611` | L11-vfs-repos 1/1 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsExamSheet::generate_id` ? | method | `crates/dstu-vfs/src/vfs/types.rs:489` | L11-vfs-repos 1/1 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsTranslation::generate_id` ? | method | `crates/dstu-vfs/src/vfs/types.rs:568` | L11-vfs-repos 1/1 | `pub fn generate_id() -> String` |
| `deep_student_lib::chat_v2::tools::attachment_executor::AttachmentToolExecutor::new` | method | `src/chat_v2/tools/attachment_executor.rs:51` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::builtin_resource_executor::BuiltinResourceExecutor::new` | method | `src/chat_v2/tools/builtin_resource_executor.rs:118` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::BuiltinRetrievalExecutor::new` | method | `src/chat_v2/tools/builtin_retrieval_executor.rs:91` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_vfs::dstu::handler_utils::node_converters::file_to_dstu_node` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:414` | L19-mcp-browser 1/0 | `pub fn file_to_dstu_node(file: &VfsFile) -> DstuNode` |
| `dstu_vfs::dstu::handler_utils::node_converters::sanitize_textbook_display_name` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:27` | L18-media-docs 1/0 | `pub fn sanitize_textbook_display_name(file_name: &str, created_at: &str) -> String` |
| `dstu_vfs::dstu::handler_utils::node_converters::translation_to_dstu_node` | fn | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:248` | L02-llm-manager 1/0 | `pub fn translation_to_dstu_node(translation: &VfsTranslation) -> DstuNode` |
| `dstu_vfs::dstu::types::DstuWatchEvent::deleted` | method | `crates/dstu-vfs/src/dstu/types.rs:630` | L10-notes 1/0 | `pub fn deleted(path: impl Into<String>) -> Self` |
| `dstu_vfs::dstu::types::DstuWatchEvent::restored` | method | `crates/dstu-vfs/src/dstu/types.rs:650` | L19-mcp-browser 1/0 | `pub fn restored(path: impl Into<String>, node: Option<DstuNode>) -> Self` |
| `dstu_vfs::file_stream_protocol::handle_asset_protocol` | fn | `crates/dstu-vfs/src/file_stream_protocol.rs:382` | F2-shell 1/0 | `pub fn handle_asset_protocol( request: &tauri::http::Request<Vec<u8>>, allowed_dirs: &[PathBuf], blob_dirs: &[PathBuf], ) -> Result<tauri::http::Response<Vec<u8>>, Box<dyn std::error::Error>>` |
| `dstu_vfs::file_stream_protocol::resolve_blob_dirs` | fn | `crates/dstu-vfs/src/file_stream_protocol.rs:215` | F2-shell 1/0 | `pub fn resolve_blob_dirs(app: &tauri::AppHandle) -> Vec<PathBuf>` |
| `dstu_vfs::pdf_protocol::cors_origin_for_request` | fn | `crates/dstu-vfs/src/pdf_protocol.rs:253` | F2-shell 1/0 | `pub fn cors_origin_for_request(request: &tauri::http::Request<Vec<u8>>) -> String` |
| `dstu_vfs::pdf_protocol::handle_asset_protocol` | fn | `crates/dstu-vfs/src/pdf_protocol.rs:309` | F2-shell 1/0 | `pub fn handle_asset_protocol( request: &tauri::http::Request<Vec<u8>>, allowed_dirs: &[PathBuf], ) -> Result<tauri::http::Response<Vec<u8>>, Box<dyn std::error::Error>>` |
| `dstu_vfs::pdf_protocol::path_is_within` | fn | `crates/dstu-vfs/src/pdf_protocol.rs:144` | L22-app-commands 1/0 | `pub fn path_is_within(path: &Path, dir: &Path) -> bool` |
| `dstu_vfs::textbooks_db::TextbooksDb` | struct | `crates/dstu-vfs/src/textbooks_db.rs:54` | L18-media-docs 1/0 | `pub struct TextbooksDb` |
| `dstu_vfs::textbooks_db::TextbooksDb::update_vfs` | method | `crates/dstu-vfs/src/textbooks_db.rs:66` | L18-media-docs 1/0 | `pub fn update_vfs( vfs_db: &VfsDatabase, id: &str, params: VfsUpdateTextbookParams, ) -> Result<Option<VfsTextbook>>` |
| `dstu_vfs::textbooks_db::VfsUpdateTextbookParams` | struct | `crates/dstu-vfs/src/textbooks_db.rs:43` | L18-media-docs 1/0 | `pub struct VfsUpdateTextbookParams` |
| `dstu_vfs::vector_store::VectorStore` | trait | `crates/dstu-vfs/src/vector_store.rs:22` | L12-vfs-index 1/0 | `pub trait VectorStore: Send + Sync` |
| `dstu_vfs::vfs::app_handle` | fn | `crates/dstu-vfs/src/vfs/mod.rs:120` | L12-vfs-index 1/0 | `pub(crate) fn app_handle() -> Option<&'static tauri::AppHandle>` |
| `dstu_vfs::vfs::handlers::read_pdf_page_image_bytes` | fn | `crates/dstu-vfs/src/vfs/handlers.rs:2943` | L18-media-docs 1/0 | `pub fn read_pdf_page_image_bytes( vfs_db: &VfsDatabase, resource_id: &str, page_index: usize, max_bytes: Option<usize>, ) -> Result<PdfPageImageBytes, String>` |
| `dstu_vfs::vfs::hooks::ExamDocumentExporter` | trait | `crates/dstu-vfs/src/vfs/hooks.rs:142` | L14-qbank 1/0 | `pub trait ExamDocumentExporter: Send + Sync` |
| `dstu_vfs::vfs::hooks::media_transcriber` | fn | `crates/dstu-vfs/src/vfs/hooks.rs:116` | L12-vfs-index 1/0 | `pub(crate) fn media_transcriber() -> Option<Arc<dyn MediaTranscriber>>` |
| `dstu_vfs::vfs::hooks::MediaTranscriber` | trait | `crates/dstu-vfs/src/vfs/hooks.rs:95` | L18-media-docs 1/0 | `pub trait MediaTranscriber: Send + Sync` |
| `dstu_vfs::vfs::hooks::NoteDeleteHook` | trait | `crates/dstu-vfs/src/vfs/hooks.rs:30` | L17-memory-research 1/0 | `pub trait NoteDeleteHook: Send + Sync` |
| `dstu_vfs::vfs::hooks::register_exam_document_exporter` | fn | `crates/dstu-vfs/src/vfs/hooks.rs:149` | L14-qbank 1/0 | `pub fn register_exam_document_exporter( exporter: Arc<dyn ExamDocumentExporter>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_vfs::vfs::hooks::register_media_transcriber` | fn | `crates/dstu-vfs/src/vfs/hooks.rs:110` | L18-media-docs 1/0 | `pub fn register_media_transcriber( transcriber: Arc<dyn MediaTranscriber>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_vfs::vfs::hooks::register_note_delete_hook` | fn | `crates/dstu-vfs/src/vfs/hooks.rs:41` | L17-memory-research 1/0 | `pub fn register_note_delete_hook(hook: Arc<dyn NoteDeleteHook>) -> Disposer` |
| `dstu_vfs::vfs::hooks::register_resource_created_hook` | fn | `crates/dstu-vfs/src/vfs/hooks.rs:126` | L18-media-docs 1/0 | `pub fn register_resource_created_hook(hook: Arc<dyn ResourceCreatedHook>) -> Disposer` |
| `dstu_vfs::vfs::hooks::ResourceCreatedHook` | trait | `crates/dstu-vfs/src/vfs/hooks.rs:120` | L18-media-docs 1/0 | `pub trait ResourceCreatedHook: Send + Sync` |
| `dstu_vfs::vfs::is_file_folder_item_type` | fn | `crates/dstu-vfs/src/vfs/mod.rs:154` | L11-vfs-repos 1/0 | `pub fn is_file_folder_item_type(item_type: &str) -> bool` |
| `dstu_vfs::vfs::lexical_bm25::bm25_scores` | fn | `crates/dstu-vfs/src/vfs/lexical_bm25.rs:126` | L12-vfs-index 1/0 | `pub fn bm25_scores<S: AsRef<str>>(terms: &[String], docs: &[S], options: Bm25Options) -> Vec<f64>` |
| `dstu_vfs::vfs::lexical_bm25::Bm25Options` | struct | `crates/dstu-vfs/src/vfs/lexical_bm25.rs:29` | L12-vfs-index 1/0 | `pub struct Bm25Options` |
| `dstu_vfs::vfs::lexical_bm25::tokenize` | fn | `crates/dstu-vfs/src/vfs/lexical_bm25.rs:101` | L12-vfs-index 1/0 | `pub fn tokenize(text: &str) -> Vec<String>` |
| `dstu_vfs::vfs::MAX_FOLDER_TITLE_LENGTH` | const | `crates/dstu-vfs/src/vfs/mod.rs:176` | L04-chat-session 1/0 | `pub const MAX_FOLDER_TITLE_LENGTH: usize = 100` |
| `dstu_vfs::vfs::media_index::attach_media_time_ranges` | fn | `crates/dstu-vfs/src/vfs/media_index.rs:263` | L12-vfs-index 1/0 | `pub fn attach_media_time_ranges(db: &VfsDatabase, hits: &mut [FusedRetrievalHit])` |
| `dstu_vfs::vfs::media_index::refresh_transcript_index` | fn | `crates/dstu-vfs/src/vfs/media_index.rs:199` | L18-media-docs 1/0 | `pub fn refresh_transcript_index( db: &std::sync::Arc<VfsDatabase>, file_id: &str, ) -> VfsResult<usize>` |
| `dstu_vfs::vfs::note_props::MalformedPropsKind` | enum | `crates/dstu-vfs/src/vfs/note_props.rs:139` | L10-notes 1/0 | `pub enum MalformedPropsKind` |
| `dstu_vfs::vfs::note_props::MAX_PROP_KEY_CHARS` | const | `crates/dstu-vfs/src/vfs/note_props.rs:32` | L10-notes 1/0 | `pub const MAX_PROP_KEY_CHARS: usize = 64` |
| `dstu_vfs::vfs::note_props::MAX_PROP_VALUE_CHARS` | const | `crates/dstu-vfs/src/vfs/note_props.rs:34` | L10-notes 1/0 | `pub const MAX_PROP_VALUE_CHARS: usize = 512` |
| `dstu_vfs::vfs::note_props::MAX_PROPS` | const | `crates/dstu-vfs/src/vfs/note_props.rs:30` | L10-notes 1/0 | `pub const MAX_PROPS: usize = 32` |
| `dstu_vfs::vfs::note_props::parse_props_cell` | fn | `crates/dstu-vfs/src/vfs/note_props.rs:189` | L10-notes 1/0 | `pub fn parse_props_cell(note_id: &str, raw: Option<&str>) -> Option<serde_json::Value>` |
| `dstu_vfs::vfs::note_props::PROPS_RESERVED_KEYS` | const | `crates/dstu-vfs/src/vfs/note_props.rs:37` | L10-notes 1/0 | `pub const PROPS_RESERVED_KEYS: [&str; 7] = [ "tags", "tag", "path", "title", "isfavorite", "snippet", "props", ]` |
| `dstu_vfs::vfs::note_props::record_malformed_props` | fn | `crates/dstu-vfs/src/vfs/note_props.rs:162` | L10-notes 1/0 | `pub fn record_malformed_props(note_id: &str, kind: MalformedPropsKind, detail: &str)` |
| `dstu_vfs::vfs::note_props::validate_prop_key` | fn | `crates/dstu-vfs/src/vfs/note_props.rs:78` | L10-notes 1/0 | `pub fn validate_prop_key(key: &str) -> Result<&str, PropKeyError>` |
| `dstu_vfs::vfs::ocr_utils::PdfContentKind` | enum | `crates/dstu-vfs/src/vfs/ocr_utils.rs:30` | L12-vfs-index 1/0 | `pub enum PdfContentKind` |
| `dstu_vfs::vfs::question_sync_service::QuestionSyncService` | struct | `crates/dstu-vfs/src/vfs/question_sync_service.rs:460` | L11-vfs-repos 1/0 | `pub struct QuestionSyncService` |
| `dstu_vfs::vfs::set_app_handle` | fn | `crates/dstu-vfs/src/vfs/mod.rs:115` | F2-shell 1/0 | `pub fn set_app_handle(handle: tauri::AppHandle)` |
| `dstu_vfs::vfs::types::PomodoroRecord::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:1164` | L11-vfs-repos 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::StorageMode::from_str` | method | `crates/dstu-vfs/src/vfs/types.rs:68` | L11-vfs-repos 1/0 | `pub fn from_str(s: &str) -> Option<Self>` |
| `dstu_vfs::vfs::types::TodoStats` | struct | `crates/dstu-vfs/src/vfs/types.rs:1094` | L11-vfs-repos 1/0 | `pub struct TodoStats` |
| `dstu_vfs::vfs::types::VfsEssay::generate_session_id` | method | `crates/dstu-vfs/src/vfs/types.rs:1616` | L11-vfs-repos 1/0 | `pub fn generate_session_id() -> String` |
| `dstu_vfs::vfs::types::VfsFolderItem::generate_id` ? | method | `crates/dstu-vfs/src/vfs/types.rs:1378` | L11-vfs-repos 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsMindMap::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:641` | L11-vfs-repos 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsMindMapVersion::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:686` | L11-vfs-repos 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsNote::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:350` | L10-notes 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::types::VfsTodoList::generate_id` | method | `crates/dstu-vfs/src/vfs/types.rs:810` | L11-vfs-repos 1/0 | `pub fn generate_id() -> String` |
| `dstu_vfs::vfs::VECTOR_INDEX_UNAVAILABLE_MESSAGE` | const | `crates/dstu-vfs/src/vfs/mod.rs:133` | L19-mcp-browser 1/0 | `pub const VECTOR_INDEX_UNAVAILABLE_MESSAGE: &str = "此版本不包含向量索引，无需建立索引：资料检索会自动使用关键词搜索。"` |
| `dstu_vfs::vfs::database::CURRENT_SCHEMA_VERSION` | const | `crates/dstu-vfs/src/vfs/database.rs:35` | F3-storage 0/15 | `pub const CURRENT_SCHEMA_VERSION: u32 = dstu_storage::migration::vfs::VFS_SCHEMA_VERSION` |
| `dstu_vfs::vfs::types::VfsFolder::generate_id` ? | method | `crates/dstu-vfs/src/vfs/types.rs:1312` | L11-vfs-repos 0/5 | `pub fn generate_id() -> String` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor` | struct | `src/chat_v2/tools/generative_ui_executor.rs:44` | F1-kernel 0/1<br>L22-app-commands 0/1 | `pub struct GenerativeUiExecutor` |
| `dstu_vfs::vfs::note_props::malformed_props_total` ? | fn | `crates/dstu-vfs/src/vfs/note_props.rs:133` | L10-notes 0/2 | `pub fn malformed_props_total() -> u64` |
| `dstu_vfs::vfs::question_sync_service::SyncConfig` | struct | `crates/dstu-vfs/src/vfs/question_sync_service.rs:373` | L23-sync-providers 0/2 | `pub struct SyncConfig` |
| `deep_student_lib::chat_v2::tools::attachment_executor::AttachmentToolExecutor` | struct | `src/chat_v2/tools/attachment_executor.rs:47` | F1-kernel 0/1 | `pub struct AttachmentToolExecutor` |

### 引用点样例

- `dstu_vfs::vfs::error::VfsResult` — L15-review-analytics: `crates/dstu-learning/src/mastery/profile_sink.rs:38`, `crates/dstu-learning/src/mastery/profile_sink.rs:45`, `crates/dstu-learning/src/mastery/profile_sink.rs:61`, `crates/dstu-learning/src/mastery/profile_sink.rs:71`；L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:85`, `crates/dstu-memory/src/memory/category_manager.rs:142`, `crates/dstu-memory/src/memory/category_manager.rs:210`, `crates/dstu-memory/src/memory/category_manager.rs:278`；L12-vfs-index: `crates/dstu-vfs/src/vfs/embedding_service.rs:114`, `crates/dstu-vfs/src/vfs/embedding_service.rs:125`, `crates/dstu-vfs/src/vfs/embedding_service.rs:143`, `crates/dstu-vfs/src/vfs/embedding_service.rs:169`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:342`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:401`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:424`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:437`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:59`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:98`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:117`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:152`
- `dstu_vfs::vfs::error::VfsError` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:338`；L18-media-docs: `crates/dstu-media/src/media/mod.rs:107`, `crates/dstu-media/src/media/mod.rs:108`, `src/chat_v2/tools/textbook_pdf_executor.rs:911`, `src/chat_v2/tools/textbook_pdf_executor.rs:916`；L17-memory-research: `crates/dstu-memory/src/memory/audit_log.rs:314`, `crates/dstu-memory/src/memory/category_manager.rs:244`, `crates/dstu-memory/src/memory/daily_log.rs:236`, `crates/dstu-memory/src/memory/daily_log.rs:297`；L10-notes: `crates/dstu-notes/src/notes_manager.rs:2002`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:14`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:20`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:15`；L14-qbank: `crates/dstu-qbank/src/qbank_generation/pipeline.rs:384`, `crates/dstu-qbank/src/qbank_generation/task_repo.rs:124`, `crates/dstu-qbank/src/qbank_generation/task_repo.rs:135`, `crates/dstu-qbank/src/qbank_generation/task_repo.rs:158`；L15-review-analytics: `crates/dstu-qbank/src/review_plan_service.rs:239`, `crates/dstu-qbank/src/review_plan_service.rs:515`；L02-llm-manager: `crates/dstu-tutor/src/essay_grading/mod.rs:65`, `crates/dstu-tutor/src/essay_grading/mod.rs:68`, `crates/dstu-tutor/src/essay_grading/mod.rs:69`, `src/chat_v2/tools/translation_executor.rs:1313`；L12-vfs-index: `crates/dstu-vfs/src/vfs/embedding_service.rs:20`, `crates/dstu-vfs/src/vfs/embedding_service.rs:119`, `crates/dstu-vfs/src/vfs/embedding_service.rs:130`, `crates/dstu-vfs/src/vfs/embedding_service.rs:148`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:368`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:2446`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:3327`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:3380`
- `dstu_vfs::vfs::database::VfsDatabase` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:79`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:328`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:337`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/automations.rs:2510`, `crates/dstu-agent/src/chat_v2/automations.rs:3345`, `crates/dstu-agent/src/chat_v2/automations.rs:3849`, `crates/dstu-agent/src/chat_v2/automations.rs:4139`；L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:200`, `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:304`, `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:60`, `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:150`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:137`, `crates/dstu-agent/src/chat_v2/pipeline.rs:140`, `crates/dstu-agent/src/chat_v2/pipeline.rs:220`, `crates/dstu-agent/src/chat_v2/pipeline.rs:296`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:152`；L15-review-analytics: `crates/dstu-learning/src/mastery/mod.rs:26`, `crates/dstu-learning/src/mastery/profile_sink.rs:35`, `crates/dstu-learning/src/mastery/profile_sink.rs:43`, `crates/dstu-learning/src/mastery/profile_sink.rs:58`；L18-media-docs: `crates/dstu-media/src/media/bilibili.rs:951`, `crates/dstu-media/src/media/bilibili.rs:963`, `crates/dstu-media/src/media/bilibili.rs:985`, `crates/dstu-media/src/media/bilibili.rs:992`；L17-memory-research: `crates/dstu-memory/src/memory/audit_log.rs:102`, `crates/dstu-memory/src/memory/audit_log.rs:106`, `crates/dstu-memory/src/memory/audit_log.rs:308`, `crates/dstu-memory/src/memory/category_manager.rs:44`；L10-notes: `crates/dstu-notes/src/notes_exporter.rs:48`, `crates/dstu-notes/src/notes_exporter.rs:176`, `crates/dstu-notes/src/notes_exporter.rs:744`, `crates/dstu-notes/src/notes_exporter.rs:1686`；L14-qbank: `crates/dstu-qbank/src/qbank_authoring_service.rs:51`, `crates/dstu-qbank/src/qbank_authoring_service.rs:67`, `crates/dstu-qbank/src/qbank_generation/mod.rs:35`, `crates/dstu-qbank/src/qbank_generation/mod.rs:101`；L02-llm-manager: `crates/dstu-tutor/src/essay_grading/mod.rs:44`, `crates/dstu-tutor/src/essay_grading/mod.rs:49`, `crates/dstu-tutor/src/essay_grading/mod.rs:93`, `crates/dstu-tutor/src/essay_grading/pipeline.rs:107`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:1583`, `crates/dstu-vfs/src/vfs/indexing.rs:1587`, `crates/dstu-vfs/src/vfs/indexing.rs:1828`, `crates/dstu-vfs/src/vfs/indexing.rs:1876`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1370`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1381`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1427`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1437`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:7234`, `src/chat_v2/tools/chatanki_executor.rs:10210`, `src/chat_v2/tools/chatanki_executor.rs:10263`, `src/chat_v2/tools/chatanki_executor.rs:10536`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:580`, `src/chat_v2/tools/index_webpage_executor.rs:591`, `src/chat_v2/tools/index_webpage_executor.rs:616`, `src/chat_v2/tools/index_webpage_executor.rs:1006`；L22-app-commands: `src/commands.rs:688`, `tests/dstu_canvas_executor_e2e.rs:26`, `tests/dstu_canvas_executor_e2e.rs:31`, `tests/dstu_canvas_executor_e2e.rs:42`；F4-security: `src/debug_commands.rs:246`；F2-shell: `src/lib.rs:3294`；F3-storage: `tests/migration_tests.rs:801`
- `dstu_vfs::vfs::types::VfsResourceType` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:30`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:118`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:119`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:120`；L17-memory-research: `crates/dstu-research/src/insight/service.rs:15`, `crates/dstu-research/src/insight/service.rs:92`, `crates/dstu-research/src/insight/service.rs:312`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:403`, `crates/dstu-vfs/src/vfs/indexing.rs:425`, `crates/dstu-vfs/src/vfs/indexing.rs:2443`, `crates/dstu-vfs/src/vfs/indexing.rs:407`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:39`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1549`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1732`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1734`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_repo.rs:22`, `crates/dstu-vfs/src/vfs/repos/note_repo.rs:506`, `crates/dstu-vfs/src/vfs/repos/note_repo.rs:741`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:14775`, `src/chat_v2/tools/chatanki_executor.rs:16841`, `src/chat_v2/tools/chatanki_executor.rs:18953`, `src/chat_v2/tools/chatanki_executor.rs:18961`；L18-media-docs: `src/chat_v2/tools/image_generation_executor.rs:16`, `src/chat_v2/tools/image_generation_executor.rs:370`；L16-anki: `tests/anki_ai_native_integration.rs:82`, `tests/anki_ai_native_integration.rs:97`, `tests/anki_ai_native_integration.rs:100`
- `dstu_vfs::vfs::types::VfsNote` — L17-memory-research: `crates/dstu-memory/src/memory/semantic_dedup.rs:297`, `crates/dstu-memory/src/memory/semantic_dedup.rs:553`, `crates/dstu-memory/src/memory/semantic_dedup.rs:554`, `crates/dstu-memory/src/memory/semantic_dedup.rs:603`；L10-notes: `crates/dstu-notes/src/notes_manager.rs:2082`, `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs:15`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:239`, `crates/dstu-vfs/src/vfs/repos/note_format_repo.rs:294`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:158`, `tests/phase8_9_executor_e2e.rs:388`
- `dstu_vfs::vfs::types::VfsTextbook` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:65`, `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:78`, `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:108`, `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:152`；L18-media-docs: `src/chat_v2/tools/textbook_pdf_executor.rs:692`, `src/chat_v2/tools/textbook_pdf_executor.rs:763`, `src/chat_v2/tools/textbook_pdf_executor.rs:779`, `src/chat_v2/tools/textbook_pdf_executor.rs:883`
- `dstu_vfs::vfs::types::VfsFile` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/file_repo.rs:51`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:78`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:113`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:154`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:10264`, `src/chat_v2/tools/chatanki_executor.rs:10325`；L18-media-docs: `src/chat_v2/tools/document_processing_executor.rs:71`, `src/chat_v2/tools/document_processing_executor.rs:108`, `src/chat_v2/tools/document_processing_executor.rs:459`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:607`, `src/chat_v2/tools/index_webpage_executor.rs:1008`, `src/chat_v2/tools/index_webpage_executor.rs:1037`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:210`, `src/chat_v2/tools/qbank_import_source.rs:311`, `src/chat_v2/tools/qbank_import_source.rs:366`
- `dstu_vfs::vfs::types::VfsUpdateNoteParams` — L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:300`, `crates/dstu-memory/src/memory/daily_log.rs:212`, `crates/dstu-memory/src/memory/evolution.rs:504`, `crates/dstu-memory/src/memory/learner_profile.rs:905`；L10-notes: `crates/dstu-notes/src/notes_exporter.rs:2038`, `crates/dstu-notes/src/notes_exporter.rs:2858`, `crates/dstu-notes/src/notes_exporter.rs:2885`, `crates/dstu-notes/src/notes_exporter.rs:3850`；L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:642`
- `dstu_vfs::vfs::types::VfsTodoItem` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:1089`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:391`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:491`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1244`；L10-notes: `src/chat_v2/tools/user_todo_executor.rs:153`, `src/chat_v2/tools/user_todo_executor.rs:1721`
- `dstu_vfs::vfs::types::VfsResourceRef` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:114`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:145`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:190`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:263`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9979`, `src/chat_v2/tools/chatanki_executor.rs:10495`, `src/chat_v2/tools/chatanki_executor.rs:14775`, `src/chat_v2/tools/chatanki_executor.rs:14776`；L16-anki: `tests/anki_ai_native_integration.rs:82`, `tests/anki_ai_native_integration.rs:83`
- `dstu_vfs::vfs::types::VfsExamSheet` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:67`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:78`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:112`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:148`
- `dstu_vfs::vfs::types::VfsEssay` — L02-llm-manager: `crates/dstu-tutor/src/essay_grading/mod.rs:94`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:48`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:59`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:99`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:107`
- `dstu_vfs::vfs::types::VfsFolderItem` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:38`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:18`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:38`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:33`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_repo.rs:22`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:35`
- `dstu_vfs::vfs::types::VfsMindMap` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:319`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:332`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:362`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:410`
- `dstu_vfs::vfs::types::VfsTranslation` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:127`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:141`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:177`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:195`；L02-llm-manager: `src/chat_v2/tools/translation_executor.rs:1344`
- `dstu_vfs::vfs::types::VfsTodoList` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:536`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:545`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:589`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:605`；L10-notes: `src/chat_v2/tools/user_todo_executor.rs:122`
- `dstu_vfs::vfs::types::VfsFolder` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:17`；L17-memory-research: `crates/dstu-memory/src/memory/config.rs:9`, `crates/dstu-memory/src/memory/daily_log.rs:24`, `crates/dstu-memory/src/memory/learner_profile.rs:25`, `crates/dstu-memory/src/memory/service.rs:17`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:311`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:317`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:370`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:381`；L18-media-docs: `src/chat_v2/tools/image_generation_executor.rs:16`；L22-app-commands: `tests/session_executor_e2e.rs:13`；L02-llm-manager: `tests/translation_executor_e2e.rs:15`
- `dstu_vfs::vfs::types::VfsCreateNoteParams` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:408`；L18-media-docs: `crates/dstu-media/src/media/library.rs:721`；L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:322`, `crates/dstu-memory/src/memory/daily_log.rs:273`, `crates/dstu-memory/src/memory/learner_profile.rs:934`, `crates/dstu-memory/src/memory/learner_profile.rs:1198`；L10-notes: `crates/dstu-notes/src/notes_exporter.rs:2052`, `crates/dstu-notes/src/notes_exporter.rs:2914`, `crates/dstu-notes/src/notes_exporter.rs:3735`, `crates/dstu-notes/src/notes_exporter.rs:3827`；L20-sync: `crates/dstu-sync/src/data_governance/sync/note_history.rs:422`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:476`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:541`, `crates/dstu-sync/src/data_governance/sync/note_history.rs:588`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3418`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3500`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3542`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:540`；L21-backup-governance: `src/data_governance/migration_compat_tests.rs:690`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:161`, `tests/phase8_9_executor_e2e.rs:391`
- `dstu_vfs::vfs::types::VfsEssaySession` — L02-llm-manager: `crates/dstu-tutor/src/essay_grading/mod.rs:83`, `crates/dstu-tutor/src/essay_grading/mod.rs:191`, `crates/dstu-tutor/src/essay_grading/mod.rs:212`, `crates/dstu-tutor/src/essay_grading/mod.rs:273`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:742`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:752`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:777`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:803`；L15-review-analytics: `src/essay_grading/mod.rs:44`, `src/essay_grading/mod.rs:60`, `src/essay_grading/mod.rs:94`
- `dstu_vfs::vfs::types::VfsContextRefData` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1889`, `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:1234`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:203`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:223`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:7721`, `src/chat_v2/tools/chatanki_executor.rs:9125`, `src/chat_v2/tools/chatanki_executor.rs:9210`, `src/chat_v2/tools/chatanki_executor.rs:9243`；L16-anki: `tests/anki_ai_native_integration.rs:94`, `tests/anki_ai_native_integration.rs:102`
- `dstu_vfs::vfs::types::VfsResource` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:391`, `crates/dstu-vfs/src/vfs/indexing.rs:771`, `crates/dstu-vfs/src/vfs/indexing.rs:1150`, `crates/dstu-vfs/src/vfs/indexing.rs:3271`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:311`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:320`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:337`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:343`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:1007`
- `dstu_vfs::vfs::types::PdfPreviewJson` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:753`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:982`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:1709`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:1862`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:3537`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2281`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:2321`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3639`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:2486`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:342`, `crates/dstu-vfs/src/vfs/repos/file_repo.rs:1206`, `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:52`
- `dstu_vfs::vfs::types::VfsMindMapVersion` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:532`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:545`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:549`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:1532`
- `dstu_vfs::vfs::types::VfsUploadAttachmentResult` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:697`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:718`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:847`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:873`
- `dstu_vfs::vfs::types::VfsCreateExamSheetParams` — L14-qbank: `crates/dstu-qbank/src/qbank_authoring_service/tests.rs:10`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:1874`, `crates/dstu-qbank/src/qbank_management/tests.rs:38`, `crates/dstu-qbank/src/qbank_source_view.rs:364`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:234`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:251`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:602`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:622`；L18-media-docs: `crates/dstu-vision/src/exam_sheet_service.rs:94`；L15-review-analytics: `src/review_plan_service/tests.rs:35`, `src/review_plan_service/tests.rs:48`, `src/review_plan_service/tests.rs:99`
- `dstu_vfs::vfs::types::VfsFolderItem::new` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1624`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1677`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:834`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:1437`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2342`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:649`；L18-media-docs: `src/cmd/textbooks.rs:49`, `src/cmd/textbooks.rs:663`
- `dstu_vfs::vfs::types::FolderTreeNode` — L17-memory-research: `crates/dstu-memory/src/memory/category_manager.rs:113`, `crates/dstu-memory/src/memory/evolution.rs:842`, `crates/dstu-memory/src/memory/handlers.rs:358`, `crates/dstu-memory/src/memory/service.rs:2771`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:2809`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:2815`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:2830`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:2842`
- `dstu_vfs::vfs::ocr_utils::parse_ocr_pages_json` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:942`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:1816`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:1121`, `crates/dstu-vfs/src/vfs/indexing.rs:1527`, `crates/dstu-vfs/src/vfs/indexing.rs:3474`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:1211`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:3074`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:3107`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1888`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1921`
- `dstu_vfs::vfs::types::VfsAttachment` — L18-media-docs: `crates/dstu-media/src/media/bilibili.rs:987`, `crates/dstu-media/src/media/bilibili.rs:995`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1269`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1592`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1868`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1874`
- `dstu_vfs::vfs::types::VfsUploadAttachmentParams` — L18-media-docs: `crates/dstu-media/src/media/bilibili.rs:1021`, `src/chat_v2/tools/image_generation_executor.rs:324`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:696`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:703`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:716`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1371`
- `dstu_vfs::vfs::types::VfsResourceMetadata` — L17-memory-research: `crates/dstu-research/src/insight/service.rs:96`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:5365`, `crates/dstu-vfs/src/vfs/indexing.rs:5389`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1075`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1541`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1737`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:1785`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:60`；L18-media-docs: `src/chat_v2/tools/image_generation_executor.rs:346`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:708`
- `dstu_vfs::vfs::types::ResourceLocation` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:1550`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:1559`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1797`, `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1806`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2505`, `crates/dstu-vfs/src/vfs/repos/note_repo.rs:2514`
- `dstu_vfs::vfs::qbank_types::QuestionMaterial` — L14-qbank: `crates/dstu-qbank/src/qbank_document.rs:9`, `crates/dstu-qbank/src/qbank_grading/context.rs:43`, `crates/dstu-qbank/src/qbank_grading/context.rs:187`, `crates/dstu-qbank/src/qbank_grading/context.rs:221`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/question_repo.rs:323`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:1856`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:1900`
- `dstu_vfs::vfs::canonical_folder_item_type` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:829`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:935`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:1820`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:1842`
- `dstu_vfs::vfs::qbank_types::SourceRef` — L14-qbank: `crates/dstu-qbank/src/qbank_document.rs:27`, `crates/dstu-qbank/src/qbank_document.rs:67`, `crates/dstu-qbank/src/qbank_document.rs:69`, `crates/dstu-qbank/src/qbank_document.rs:305`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/question_repo.rs:37`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:38`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:47`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:329`
- `dstu_vfs::vfs::types::VfsBlob` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/blob_repo.rs:95`, `crates/dstu-vfs/src/vfs/repos/blob_repo.rs:111`, `crates/dstu-vfs/src/vfs/repos/blob_repo.rs:178`, `crates/dstu-vfs/src/vfs/repos/blob_repo.rs:194`
- `dstu_vfs::vfs::types::VfsUpdateTodoItemParams` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1509`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1519`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1530`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1977`；L10-notes: `src/chat_v2/tools/user_todo_executor.rs:1084`
- `dstu_vfs::vfs::types::VfsCreateResourceResult` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:61`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:102`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:126`, `crates/dstu-vfs/src/vfs/repos/resource_repo.rs:169`
- `dstu_vfs::vfs::types::VfsFolder::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:100`；L17-memory-research: `crates/dstu-memory/src/memory/config.rs:220`, `crates/dstu-memory/src/memory/config.rs:404`, `crates/dstu-memory/src/memory/daily_log.rs:81`, `crates/dstu-memory/src/memory/learner_profile.rs:1013`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3126`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3139`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3161`, `crates/dstu-vfs/src/vfs/repos/folder_repo.rs:3207`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:2029`；L18-media-docs: `src/chat_v2/tools/image_generation_executor.rs:718`；L22-app-commands: `tests/session_executor_e2e.rs:161`；L02-llm-manager: `tests/translation_executor_e2e.rs:366`
- `dstu_vfs::vfs::types::PdfInjectMode` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:28`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:116`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:132`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:162`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2943`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2002`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2008`
- `dstu_vfs::vfs::types::PomodoroDailyStat` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:110`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:505`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:531`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:532`；L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:1037`, `src/chat_v2/tools/learning_overview_executor.rs:1047`, `src/chat_v2/tools/learning_overview_executor.rs:1055`, `src/chat_v2/tools/learning_overview_executor.rs:1220`
- `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:418`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:259`, `src/chat_v2/tools/canvas_executor.rs:1103`, `src/cmd/notes.rs:965`, `src/cmd/notes.rs:994`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:435`；L02-llm-manager: `src/chat_v2/tools/translation_executor.rs:1431`
- `dstu_vfs::vfs::types::PomodoroRecord` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:160`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:214`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:349`, `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:369`
- `dstu_vfs::vfs::types::VfsCreateTranslationParams` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:366`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:382`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:476`, `crates/dstu-vfs/src/vfs/repos/translation_repo.rs:501`；L02-llm-manager: `src/chat_v2/tools/translation_executor.rs:1347`
- `dstu_vfs::vfs::types::ImageInjectMode` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:28`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:112`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:128`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:146`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2921`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2004`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2009`
- `dstu_vfs::vfs::types::ResourceInjectModes` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:106`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:122`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:138`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:154`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:2855`
- `dstu_vfs::dstu::handler_utils::node_converters::note_to_dstu_node` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:417`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:258`, `src/chat_v2/tools/canvas_executor.rs:1082`, `src/cmd/notes.rs:221`, `src/cmd/notes.rs:962`
- `dstu_vfs::dstu::types::DstuNode` — L10-notes: `src/cmd/notes.rs:182`, `src/cmd/notes.rs:959`, `src/cmd/notes.rs:982`, `src/cmd/notes.rs:1083`
- `dstu_vfs::vfs::index_service::VfsIndexService::new` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:2064`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3427`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:78`, `src/chat_v2/tools/index_webpage_executor.rs:732`, `src/chat_v2/tools/index_webpage_executor.rs:1357`；L10-notes: `src/cmd/notes.rs:1569`, `src/cmd/notes.rs:1761`
- `dstu_vfs::dstu::types::DstuWatchEvent::created` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:420`；L18-media-docs: `crates/dstu-media/src/media/bilibili.rs:1284`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:431`；L02-llm-manager: `src/chat_v2/tools/translation_executor.rs:1433`；L10-notes: `src/cmd/notes.rs:967`, `src/cmd/notes.rs:1100`
- `dstu_vfs::vfs::ocr_utils::OCR_FAILED_MARKER` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:882`, `crates/dstu-vfs/src/vfs/indexing.rs:889`, `crates/dstu-vfs/src/vfs/indexing.rs:1225`, `crates/dstu-vfs/src/vfs/indexing.rs:1241`
- `dstu_vfs::vfs::qbank_helpers::refresh_canonical_preview_with_conn` — L14-qbank: `crates/dstu-qbank/src/qbank_authoring_service.rs:533`, `crates/dstu-qbank/src/qbank_authoring_service.rs:635`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:454`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:664`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:560`
- `dstu_vfs::vfs::question_sync_service::QuestionSyncService::mark_as_modified_with_conn` — L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:627`, `crates/dstu-qbank/src/question_bank_service.rs:909`, `crates/dstu-qbank/src/question_bank_service.rs:1767`, `crates/dstu-qbank/src/question_bank_service.rs:1862`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/question_repo.rs:2511`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:2602`
- `dstu_vfs::vfs::question_sync_service::QuestionSyncService::update_content_hash_with_conn` — L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:632`, `crates/dstu-qbank/src/question_bank_service.rs:914`, `crates/dstu-qbank/src/question_bank_service.rs:1769`, `crates/dstu-qbank/src/question_bank_service.rs:1867`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/question_repo.rs:2512`, `crates/dstu-vfs/src/vfs/repos/question_repo.rs:2603`
- `dstu_vfs::vfs::types::VfsCreateEssayParams` — L02-llm-manager: `crates/dstu-tutor/src/essay_grading/pipeline.rs:521`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:225`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:252`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:264`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:1404`
- `dstu_vfs::vfs::types::VfsCreateEssaySessionParams` — L02-llm-manager: `crates/dstu-tutor/src/essay_grading/mod.rs:193`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:741`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:751`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:801`, `crates/dstu-vfs/src/vfs/repos/essay_repo.rs:813`；L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:343`
- `dstu_vfs::vfs::types::VfsCreateTodoItemParams` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/automations.rs:2525`；L17-memory-research: `crates/dstu-research/src/insight/jobs.rs:328`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:1103`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1243`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1252`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:4282`；L10-notes: `src/chat_v2/tools/user_todo_executor.rs:857`
- `dstu_vfs::vfs::types::VfsCreateTodoListParams` — L17-memory-research: `crates/dstu-research/src/insight/jobs.rs:292`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs:1092`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:535`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:544`, `crates/dstu-vfs/src/vfs/repos/todo_repo.rs:1214`；L10-notes: `src/chat_v2/tools/user_todo_executor.rs:1171`
- `dstu_vfs::vfs::index_service::VfsIndexService` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:16`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:61`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/file_repo.rs:1758`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:29`；L10-notes: `src/cmd/notes.rs:16`
- `dstu_vfs::vfs::types::VfsCreateMindMapParams` — L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:318`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:331`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:361`, `crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs:429`
- 其余 121 个条目的引用点见 `draft.json`。

## 消费其他 lane

### L11-vfs-repos（353 个条目，prod 844 / test 55）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::index_unit_repo::CreateUnitInput` | struct | 23/3 | `crates/dstu-vfs/src/vfs/media_index.rs`, `crates/dstu-vfs/src/vfs/unit_builder/builders.rs`, `crates/dstu-vfs/src/vfs/unit_builder/trait_def.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_mindmap` | method | 19/0 | `crates/dstu-vfs/src/dstu/export/mindmap_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 7 个 |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::get_textbook` | method | 17/0 | `crates/dstu-vfs/src/dstu/export/textbook_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 16/0 | `crates/dstu-vfs/src/dstu/export/file_adapter.rs`, `crates/dstu-vfs/src/dstu/export/image_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` 等 7 个 |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::get_translation` ? | method | 16/0 | `crates/dstu-vfs/src/dstu/export/translation_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_exam_sheet` ? | method | 15/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs`, `crates/dstu-vfs/src/dstu/export/exam_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` 等 7 个 |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder` ? | method | 14/1 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/attachment_config.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_session` | method | 14/0 | `crates/dstu-vfs/src/dstu/export/essay_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo` | struct | 13/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs`, `crates/dstu-vfs/src/dstu/export/exam_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` 等 13 个 |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 12/1 | `crates/dstu-vfs/src/dstu/export/file_adapter.rs`, `crates/dstu-vfs/src/dstu/export/image_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` 等 13 个 |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::add_item_to_folder` ? | method | 12/1 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::question_repo::Question` | struct | 12/1 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo` | struct | 12/0 | `crates/dstu-vfs/src/dstu/export/mindmap_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo` | struct | 11/0 | `crates/dstu-vfs/src/dstu/export/essay_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::index_unit_repo::IndexState` | enum | 11/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo` | struct | 11/0 | `crates/dstu-vfs/src/dstu/export/textbook_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs`, `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo` | struct | 11/0 | `crates/dstu-vfs/src/dstu/export/translation_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 10/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs`, `crates/dstu-vfs/src/dstu/export/file_adapter.rs`, `crates/dstu-vfs/src/dstu/export/image_adapter.rs` 等 10 个 |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 10/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` 等 10 个 |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_mindmap_content` | method | 10/0 | `crates/dstu-vfs/src/dstu/export/mindmap_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_essay` | method | 9/0 | `crates/dstu-vfs/src/dstu/export/essay_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::index_unit_repo::VfsIndexUnit` | struct | 9/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path` | method | 7/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs`, `crates/dstu-vfs/src/dstu/export/file_adapter.rs`, `crates/dstu-vfs/src/dstu/export/image_adapter.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_PENDING` | const | 6/1 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_service.rs`, `crates/dstu-vfs/src/vfs/mod.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_exam_sheets` | method | 6/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::list_files_by_type` | method | 6/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_items_by_folder` | method | 6/0 | `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionImage` | struct | 6/0 | `crates/dstu-vfs/src/vfs/qbank_types.rs`, `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::get_translation_content` | method | 6/0 | `crates/dstu-vfs/src/dstu/export/translation_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::list_translations` | method | 6/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::question_repo::QuestionOption` | struct | 5/2 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_pending` | method | 5/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/media_index.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::create_mindmap_in_folder` | method | 5/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::update_mindmap` | method | 5/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 5/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::list_textbooks` | method | 5/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoBatchItemsResult` | struct | 5/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo` | struct | 4/1 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_service.rs`, `crates/dstu-vfs/src/vfs/mod.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo` | struct | 4/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs`, `src/chat_v2/tools/attachment_executor.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::decrement_ref_with_conn` | method | 4/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path_with_conn` | method | 4/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::get_by_key` | fn | 4/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_essay_content` | method | 4/0 | `crates/dstu-vfs/src/dstu/export/essay_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_sessions` | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::update_session` | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content` | method | 4/0 | `crates/dstu-vfs/src/dstu/export/file_adapter.rs`, `crates/dstu-vfs/src/dstu/export/image_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::list_files_by_folder` | method | 4/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::build_folder_path` | method | 4/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::build_folder_path_with_conn` | method | 4/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::delete_mindmap` | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::list_mindmaps` | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource` ? | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder` ? | method | 3/1 | `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/attachment_config.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::delete_folder` ? | method | 3/1 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::max_upload_size_bytes` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::VfsEmbeddingDim` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_DISABLED` | const | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsEmbeddingDimension` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::update_file_name` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::folder_exists` | method | 3/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/vfs/attachment_config.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_ids_recursive_with_conn` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/ref_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_items_by_folders_with_conn` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/ref_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_folders_by_parent` ? | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::move_item_to_folder` | method | 3/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_mm_state` | fn | 3/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_text_state` | fn | 3/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::create_version` | method | 3/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_version_content` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::set_favorite` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo` | struct | 3/0 | `crates/dstu-vfs/src/vfs/mod.rs`, `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs`, `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::question_repo::Difficulty::from_str` | method | 3/0 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionStatus::from_str` | method | 3/0 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionType::from_str` | method | 3/0 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::SourceType::from_str` | method | 3/0 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::set_favorite` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/textbooks_db.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::update_bookmarks` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/textbooks_db.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::update_reading_progress` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/textbooks_db.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::set_favorite` | method | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob_with_conn` ? | method | 2/11 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/upload_saga.rs`, `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::remove_unregistered_blob_file` ? | method | 2/4 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionStatus` ? | enum | 2/4 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionType` ? | enum | 2/4 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::Difficulty` ? | enum | 2/3 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_index_state_with_conn` | method | 2/1 | `crates/dstu-vfs/src/vfs/index_service.rs`, `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::is_supported_upload_type` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::resolve_file_id_with_conn` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_media_stream_with_folder` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::cleanup_unreferenced` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::cleanup_unreferenced_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_with_conn` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::list_all` | fn | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::model_fingerprint_for_config` ? | fn | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::register_with_model_fingerprint` | fn | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::IndexState` | struct | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::MODALITY_MULTIMODAL` | const | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo` | struct | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_index_state` ? | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_failed` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::create_session` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_deleted_sessions` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_essays_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_essays_by_session` | method | 2/0 | `crates/dstu-vfs/src/dstu/export/essay_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::purge_session_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::restore_session` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::copy_exam_sheet` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_deleted_exams` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_exam_sheets_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::purge_exam_sheet_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::restore_exam` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::set_favorite` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_exam_name` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::copy_file_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file_in_folder` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::delete_file` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::restore_file` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::set_favorite` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::restore_folder` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::update_folder` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::CreateSegmentInput` | struct | 2/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::VfsIndexSegment` | struct | 2/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::get_by_id` | fn | 2/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::get_by_resource` | fn | 2/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_version` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_versions` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::list_mindmaps_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::restore_mindmap` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_record` | method | 2/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs`, `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn` ? | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::update_resource_data_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::copy_textbook` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::list_deleted_textbooks` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::list_textbooks_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::replace_bookmarks_if_version` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::restore_textbook` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::update_file_name` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoBatchIdsResult` | struct | 2/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo` | struct | 2/0 | `crates/dstu-vfs/src/vfs/mod.rs`, `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_item` | method | 2/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::create_translation` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::list_deleted_translations` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::list_translations_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::purge_translation_with_conn` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::restore_translation` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::set_quality_rating` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::question_repo::SourceType` ? | enum | 1/1 | `crates/dstu-vfs/src/vfs/question_sync_service.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::build_zip_manifest_text` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::delete_attachment` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_by_id` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_by_id_with_conn` | method | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_content` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_content_bounded` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_content_with_conn` | method | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_bytes_with_folder` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_with_folder` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::cleanup_blob_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob` | method | 1/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::stage_stream` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob` ? | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_staged_blob_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::create_dimension` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::delete_dimension_cascade` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::generate_lance_table_name` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::has_indexing_units_for_dimension` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::MAX_DIMENSION` ? | const | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::MIN_DIMENSION` | const | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::PRESET_DIMENSIONS` | const | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::refresh_counts_from_segments` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::register` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_FAILED` | const | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_INDEXED` | const | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_INDEXING` | const | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::MODALITY_TEXT` | const | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VFS_EMB_TABLE_PREFIX` | const | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsDimensionRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsEmbedding` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo::get_config` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo::set_config` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::claim_pending_resources` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_disabled` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_disabled_with_reason` | method | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_mm_index_state_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::create_session_in_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::delete_essay_with_folder_item` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::delete_essay_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::delete_session` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::delete_session_with_folder_item` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::delete_session_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_essays` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::purge_essay` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::purge_essay_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::purge_session` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::restore_essay` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::restore_essay_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::restore_session_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::search_essays` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::update_title` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::create_exam_sheet_in_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::delete_exam_sheet` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::delete_exam_sheet_with_folder_item` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::delete_exam_sheet_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::purge_exam_sheet` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::restore_exam_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::search_exam_sheets` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_preview_json` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_preview_json_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/qbank_helpers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::delete_file_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/ref_handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::list_deleted_files` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::purge_deleted_files_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::purge_file` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::purge_file_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::restore_file_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::delete_folder_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_all_resources` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_ids_recursive` | method | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_item_by_cached_path` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_items_all` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_tree_all` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_all_assigned_item_ids` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_all_folders` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_deleted_folders` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::move_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::purge_deleted_folders_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::purge_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::purge_folder_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::remove_item_by_item_id` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::remove_item_from_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::rename_folder_if_version` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::reorder_folders` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::reorder_items` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::restore_folder_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::set_favorite` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::set_folder_expanded` | method | 1/0 | `crates/dstu-vfs/src/dstu/folder_handlers.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::batch_create` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::create` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::get_modality_dim_stats` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::list_lance_row_ids_by_unit` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::get_stats` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::list_pending_mm` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::list_pending_text` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_mm_indexed` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_text_indexed` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::sync_units` | fn | 1/0 | `crates/dstu-vfs/src/vfs/index_service.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/media_index.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::list_segments_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/media_index.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::SEGMENT_STATUS_DONE` | const | 1/0 | `crates/dstu-vfs/src/vfs/media_index.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::count_active_mindmaps_by_resource_id` | method | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::create_mindmap` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::delete_mindmap_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::get_versions_paged` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::list_deleted_mindmaps` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::purge_deleted_mindmaps_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::purge_mindmap` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::purge_mindmap_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::restore_mindmap_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::restore_version` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::mindmap_repo::VfsMindMapRepo::update_mindmap_returning_version` | method | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::PomodoroStatsOverview` | struct | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::PomodoroTodoFocusSummary` | struct | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::create_record` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::delete_record` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_daily_stats` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_hourly_stats` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_stats_by_todo` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_stats_overview` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_streak_stats` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_today_stats` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_todo_focus_summary` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::list_by_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::list_range` | method | 1/0 | `crates/dstu-vfs/src/vfs/pomodoro_handlers.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::list_today_records` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::create_or_reuse` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::decrement_ref` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::exists` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::increment_ref` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::delete_textbook` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::delete_textbook_with_folder_item` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::delete_textbook_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::purge_deleted_textbooks` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::purge_deleted_textbooks_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::purge_textbook` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::purge_textbook_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::replace_highlights_if_version` ? | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::restore_textbook_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::search_textbooks` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::update_page_count` | method | 1/0 | `crates/dstu-vfs/src/textbooks_db.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TagCountEntry` | struct | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoCountsSnapshot` | struct | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoItemWithChildStats` | struct | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoStatsOverview` | struct | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::TodoTrashCounts` | struct | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_complete_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_delete_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_move_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_purge_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_reschedule_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_restore_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::batch_set_priority_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::counts_snapshot` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::delete_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::delete_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::ensure_default_inbox_with_title` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_active_todo_summary` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_all_pending_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_all_tags` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_completed_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_deleted_todo_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_deleted_todo_lists` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_items_by_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_items_by_list_paged` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_items_with_child_stats` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_overdue_items_paged` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_reminder_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_today_items_paged` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_todo_lists` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_upcoming_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::move_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::purge_deleted_todo_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::purge_deleted_todo_lists` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::purge_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::purge_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::reorder_items` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::reorder_todo_lists` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::restore_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::restore_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::search_items_paginated` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::stats_overview` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::toggle_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::toggle_todo_list_favorite` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::trash_counts` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::update_todo_item` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::update_todo_list` | method | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::create_translation_in_folder` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::delete_translation` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::delete_translation_with_folder_item` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::delete_translation_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::purge_translation` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::restore_translation_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::search_translations` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::update_title` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::update_translation_content` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::compute_hash` ? | method | 0/5 | `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file_with_doc_data_in_folder_outcome` | method | 0/4 | `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_pending_resources_with_conn` | method | 0/2 | `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_failed_with_conn` | method | 0/1 | `crates/dstu-vfs/src/vfs/upload_saga.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::delete_segments_with_conn` ? | method | 0/1 | `crates/dstu-vfs/src/vfs/media_index.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::set_imported_segments_with_conn` ? | method | 0/1 | `crates/dstu-vfs/src/vfs/media_index.rs` |

### L12-vfs-index（69 个条目，prod 150 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 33/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 8 个 |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | 13/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStage` | enum | 9/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteFailure` | struct | 4/0 | `crates/dstu-vfs/src/vfs/mod.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_vfs::vfs::retrieval_planner::FusedRetrievalHit` | struct | 3/1 | `crates/dstu-vfs/src/vfs/media_index.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_handlers.rs` |
| `dstu_vfs::vfs::indexing::VfsIndexingService` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsIndexingService::new` | method | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/index_handlers.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchParams` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchResult` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStatus` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalResponse` | struct | 3/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::embedding_service::EmbeddingProgressCallback` | type | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::indexing::VfsContentExtractor` | struct | 2/0 | `crates/dstu-vfs/src/vfs/mod.rs`, `crates/dstu-vfs/src/vfs/ref_handlers.rs` |
| `dstu_vfs::vfs::indexing::VfsEmbeddingStats` | struct | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchService` | struct | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchService::new` | method | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService` | struct | 2/0 | `crates/dstu-vfs/src/vfs/index_handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilitySnapshot` | struct | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::QueryModality` | enum | 2/0 | `crates/dstu-vfs/src/vfs/mod.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_vfs::vfs::embedding_service::ChunkWithEmbedding` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::embedding_service::EmbeddingResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::embedding_service::VfsEmbeddingPipeline` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::embedding_service::VfsEmbeddingService` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::ChunkingConfig` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::IndexingConfig` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::PageText` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::SearchConfig` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::TextChunk` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsChunker` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsContentExtractor::extract_mindmap_text` | method | 1/0 | `crates/dstu-vfs/src/vfs/ref_handlers.rs` |
| `dstu_vfs::vfs::indexing::VfsDimensionStat` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsFullSearchService` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchMode` | enum | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::lance_store::LanceTableDiagnostic` | struct | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceRow` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceSearchResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalIndexResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalPage` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalSearchResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService::new` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/index_handlers.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalStats` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingCompletedEvent` | type | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingErrorEvent` | type | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingProgressEvent` | type | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingProgress` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStage::from_str` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::retrieval_planner::ActiveGenerationModel` ? | enum | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityKind` | enum | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::fuse_route_results` | fn | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::FusedRetrievalResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::GenerationPlan` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::GenerationRoute` ? | enum | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::IndexProfileCapability` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::plan_generation` | fn | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::plan_retrieval` | fn | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::PlannedRetrievalRoute` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalHit` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalHitProvenance` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalIdentity` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalPlan` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteKind` | enum | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteResult` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalRequest` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever` | struct | 1/0 | `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever::new` | method | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |

### F4-security（38 个条目，prod 138 / test 34）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::agent::ToolCall` ? | struct | 21/1 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 15/8 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_core::resource_types::ContentBlock` ? | enum | 7/1 | `crates/dstu-vfs/src/dstu/exam_formatter.rs`, `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 7/0 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_core::resource_types::ContentBlock::text` ? | method | 7/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_core::models::AppError::database` | method | 6/0 | `crates/dstu-vfs/src/textbooks_db.rs`, `crates/dstu-vfs/src/vfs/qbank_helpers.rs` |
| `dstu_platform::background_tasks::BACKGROUND_TASKS` | static | 6/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 5/0 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 5/0 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_core::error_details::CommandError` | struct | 5/0 | `crates/dstu-vfs/src/vfs/error.rs`, `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_core::models::RetrievedChunk` | struct | 5/0 | `crates/dstu-vfs/src/vector_store.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::events::event_types::GENERATIVE_UI` ? | const | 4/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 4/0 | `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_core::models::AppError` | struct | 4/0 | `crates/dstu-vfs/src/textbooks_db.rs`, `crates/dstu-vfs/src/vector_store.rs`, `crates/dstu-vfs/src/vfs/qbank_helpers.rs` |
| `dstu_util::utils::text::safe_truncate_chars` ? | fn | 4/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_core::models::ExamSheetPreviewResult` | struct | 3/2 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_core::events::event_types::WEB_SEARCH` ? | const | 3/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::media_types::media_kind` | fn | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_core::tool_args::with_localized_message` ? | fn | 3/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 2/3 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_core::events::event_types::RAG` ? | const | 2/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::models::DocumentChunk` | struct | 2/0 | `crates/dstu-vfs/src/vector_store.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::resource_types::ContentBlock::image` ? | method | 2/0 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_util::utils::unicode::sanitize_unicode` | fn | 2/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_core::models::ExamCardPreview` | struct | 1/3 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_core::error_details::CommandError::new` | method | 1/1 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_core::events::event_types::MEMORY` ? | const | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::media_types::MAX_MEDIA_IMPORT_BYTES` | const | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_core::models::AppError::not_implemented` | method | 1/0 | `crates/dstu-vfs/src/vector_store.rs` |
| `dstu_core::models::AppError::validation` | method | 1/0 | `crates/dstu-vfs/src/vfs/qbank_helpers.rs` |
| `dstu_core::models::DocumentChunkWithEmbedding` | struct | 1/0 | `crates/dstu-vfs/src/vector_store.rs` |
| `dstu_core::models::VectorStoreStats` | struct | 1/0 | `crates/dstu-vfs/src/vector_store.rs` |
| `dstu_core::tool_args::ensure_localized_error` ? | fn | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_core::tool_args::get_json_array_arg` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_testkit::setup_migrated_vfs` | fn | 1/0 | `crates/dstu-vfs/src/vfs/database.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 0/11 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_core::models::ExamCardBBox` | struct | 0/3 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |
| `dstu_core::models::ExamSheetPreviewPage` | struct | 0/1 | `crates/dstu-vfs/src/dstu/exam_formatter.rs` |

### L04-chat-session（26 个条目，prod 86 / test 46）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 43/4 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_agent::chat_v2::types::SourceInfo` ? | struct | 22/11 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 5/0 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::localized_attachment_failure` ? | fn | 3/6 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::required_attachment_id` ? | fn | 2/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 2/1 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::attachment_not_found_error` ? | fn | 2/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_v2` ? | method | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_v2` ? | method | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_with_conn` ? | method | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::resource_types::ContextRef` ? | struct | 1/0 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::session_scope::load_session_rag_scope` ? | fn | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::tools::types::BUILTIN_NAMESPACE` ? | const | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_windowless_for_test` ? | method | 0/3 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/3 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 0/2 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_v2` ? | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_v2` ? | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_user` ? | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::types::ChatSession::new` ? | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::resource_types::ContextRef::new` ? | method | 0/1 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::types::AttachmentMeta` ? | struct | 0/1 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage` ? | struct | 0/1 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_agent::chat_v2::types::ChatSession` ? | struct | 0/1 | `src/chat_v2/tools/attachment_executor.rs` |

### L10-notes（29 个条目，prod 77 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` | method | 15/0 | `crates/dstu-vfs/src/dstu/export/note_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 11/0 | `crates/dstu-vfs/src/dstu/export/note_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/crud.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes` | method | 9/0 | `crates/dstu-vfs/src/dstu/handler_utils/list_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content` | method | 7/0 | `crates/dstu-vfs/src/dstu/export/note_adapter.rs`, `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note` ? | method | 4/0 | `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | 3/2 | `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs`, `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteMetadataUpdate` | struct | 3/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/mod.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_deleted_notes` | method | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::list_notes_by_folder` | method | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note` | method | 2/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs`, `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseAuth` | struct | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo` | struct | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::authorized` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::now` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` ? | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_deleted_notes_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/trash_handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::purge_note_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::restore_note_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/delete_helpers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::set_favorite` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_metadata` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_with_conn` | method | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::set_note_props` ? | method | 0/2 | `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs` |

### F1-kernel（9 个条目，prod 39 / test 16）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 14/12 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 5 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 10/4 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/builtin_resource_executor.rs`, `src/chat_v2/tools/builtin_retrieval_executor.rs` 等 4 个 |
| `dstu_kernel::disposer::Disposer` | struct | 4/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_kernel::hookset::HookSet` | struct | 2/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_kernel::hookset::HookSet::new` | method | 2/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_kernel::slot::Slot` | struct | 2/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_kernel::slot::Slot::new` | method | 2/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 2/0 | `crates/dstu-vfs/src/vfs/hooks.rs` |
| `dstu_agent_api::budget::DEFAULT_TOOL_RESULT_CHAR_BUDGET` ? | const | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |

### L02-llm-manager（3 个条目，prod 24 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 22/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/hooks.rs`, `crates/dstu-vfs/src/vfs/index_handlers.rs` 等 6 个 |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |

### F3-storage（12 个条目，prod 20 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 11/0 | `crates/dstu-vfs/src/vfs/handlers.rs`, `crates/dstu-vfs/src/vfs/hooks.rs`, `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_storage::staged_upload::take_staged_upload` | fn | 2/0 | `crates/dstu-vfs/src/dstu/handlers.rs`, `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_storage::database::maintenance::checkpoint_truncate_strict` | fn | 1/0 | `crates/dstu-vfs/src/vfs/database.rs` |
| `dstu_storage::database::maintenance::fail_closed_placeholder_pool` | fn | 1/0 | `crates/dstu-vfs/src/vfs/database.rs` |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 1/0 | `crates/dstu-vfs/src/vfs/todo_handlers.rs` |
| `dstu_storage::migration::vfs::VFS_SCHEMA_VERSION` | const | 1/0 | `crates/dstu-vfs/src/vfs/database.rs` |
| `dstu_storage::staged_upload::StagedFile` | struct | 1/0 | `crates/dstu-vfs/src/dstu/handlers.rs` |
| `dstu_storage::unified_file_manager::is_opaque_document_id` | fn | 1/0 | `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/3 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/2 | `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/1 | `src/chat_v2/tools/attachment_executor.rs` |

### L17-memory-research（15 个条目，prod 16 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_memory::memory::service::MemoryService` | struct | 2/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `dstu_memory::memory::compressor::MemoryCompressor::new` | method | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_research::hpias::events::HpiasEventEmitter` | struct | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::events::HpiasEventEmitter::new` | method | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::payloads::extract_question_from_intent` | fn | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::payloads::intent_has_research_blocks` | fn | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::retrieval_backend::HpiasResearchDeps` | struct | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::service::create_research_backend` | fn | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_research::hpias::service::HpiasResearchSessionRequest` | struct | 1/0 | `src/chat_v2/tools/generative_ui_executor.rs` |

### L18-media-docs（12 个条目，prod 15 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | 3/0 | `crates/dstu-vfs/src/vfs/ref_handlers.rs`, `src/chat_v2/tools/attachment_executor.rs` |
| `dstu_docs::document_parser::DocumentParser` | struct | 2/0 | `crates/dstu-vfs/src/vfs/ref_handlers.rs`, `src/chat_v2/tools/attachment_executor.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `dstu_docs::document_parser::is_plain_text_code_extension` | fn | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |
| `dstu_docs::pdfium_utils::PDF_PAGE_SEPARATOR` | const | 1/0 | `crates/dstu-vfs/src/vfs/unit_builder/builders.rs` |

### L05-agent-workspace（10 个条目，prod 13 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::utf8_paged_read::fit_paged_read_to_default_budget` ? | fn | 4/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 1/2 | `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::page_utf8_text` ? | fn | 1/2 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::check_expected_hash` ? | fn | 1/1 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::sha256_hex` ? | fn | 1/1 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` ? | fn | 1/0 | `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 1/0 | `src/chat_v2/tools/dstu_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::optional_expected_hash` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::parse_max_bytes` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::parse_offset` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |

### L07-agent-skills-ptc（7 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::workbench_bridge::uncertain_apply_receipt` ? | fn | 4/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::acr_bridge_call` ? | fn | 2/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::apply_ops_timeout_ms` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_bridge_cancelled` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_valid_apply_receipt` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_bridge::PROBE_TIMEOUT_MS` ? | const | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |
| `dstu_agent::chat_v2::tools::workbench_executor::is_workbench_agent_delegation_enabled` ? | fn | 1/0 | `src/chat_v2/tools/builtin_resource_executor.rs` |

### L19-mcp-browser（8 个条目，prod 7 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::web_search::do_search` | fn | 2/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `dstu_mcp::tools::web_search::SearchInput` | struct | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_mcp::tools::web_search::ToolConfig` ? | struct | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_mcp::tools::web_search::ToolConfig::from_env_and_file` ? | method | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/3 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/2 | `src/chat_v2/tools/attachment_executor.rs`, `src/chat_v2/tools/generative_ui_executor.rs` |

### L24-chatanki（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |

### L03-chat-pipeline（3 个条目，prod 2 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::context::citation_ledger_for_reply` ? | fn | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::context::CitationLedger` ? | struct | 1/0 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |
| `dstu_agent::chat_v2::context::CitationLedger::new` ? | method | 0/3 | `src/chat_v2/tools/builtin_retrieval_executor.rs` |

### L14-qbank（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |
| `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |

### L01-llm-providers（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::multimodal::types::MultimodalInput` | struct | 1/0 | `crates/dstu-vfs/src/vfs/handlers.rs` |

### L21-backup-governance（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor` | struct | 1/0 | `src/chat_v2/tools/mod.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 F2-shell 导入：`use dstu_vfs::vfs::qbank_read::*` @ `src/lib.rs:161`
- 导入 L04-chat-session：`use dstu_agent::chat_v2::tools::*` @ `src/chat_v2/tools/mod.rs:12`
