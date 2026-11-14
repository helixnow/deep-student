# 跨 lane 服务草稿：L17-memory-research

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（39 个条目，其中 35 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_memory::memory::service::MemoryService` | struct | `crates/dstu-memory/src/memory/service.rs:379` | L13-vfs-api 2/0<br>L03-chat-pipeline 1/0<br>L22-app-commands 0/1 | `pub struct MemoryService` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor` | struct | `src/chat_v2/tools/memory_executor.rs:45` | F1-kernel 1/2<br>L13-vfs-api 1/0<br>L22-app-commands 0/1 | `pub struct MemoryToolExecutor` |
| `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor` | struct | `src/chat_v2/tools/learning_overview_executor.rs:60` | F1-kernel 1/2<br>L13-vfs-api 1/0 | `pub struct LearningOverviewExecutor` |
| `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor` | struct | `src/chat_v2/tools/academic_search_executor.rs:71` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct AcademicSearchExecutor` |
| `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor` | struct | `src/chat_v2/tools/knowledge_executor.rs:17` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct KnowledgeExecutor` |
| `dstu_memory::memory::compaction_flush::FlushExtraction` | struct | `crates/dstu-memory/src/memory/compaction_flush.rs:44` | L03-chat-pipeline 2/0 | `pub struct FlushExtraction` |
| `dstu_memory::memory::config::AutoExtractFrequency` | enum | `crates/dstu-memory/src/memory/config.rs:66` | L03-chat-pipeline 2/0 | `pub enum AutoExtractFrequency` |
| `dstu_memory::memory::config::MemoryConfig::new` | method | `crates/dstu-memory/src/memory/config.rs:159` | L03-chat-pipeline 2/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_memory::memory::learner_profile::load_profile_from_db` | fn | `crates/dstu-memory/src/memory/learner_profile.rs:702` | L03-chat-pipeline 1/0<br>L15-review-analytics 0/4<br>L14-qbank 0/1 | `pub fn load_profile_from_db(vfs_db: &Arc<VfsDatabase>) -> VfsResult<Option<LearnerProfile>>` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor::new` | method | `src/chat_v2/tools/memory_executor.rs:54` | F1-kernel 1/1<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor` | struct | `src/chat_v2/tools/insight_recall_executor.rs:35` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct InsightRecallExecutor` |
| `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor::new` | method | `src/chat_v2/tools/learning_overview_executor.rs:63` | F1-kernel 1/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor` | struct | `src/chat_v2/tools/paper_save_executor.rs:180` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct PaperSaveExecutor` |
| `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor::new` | method | `src/chat_v2/tools/academic_search_executor.rs:79` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor::new` | method | `src/chat_v2/tools/insight_recall_executor.rs:38` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor::new` | method | `src/chat_v2/tools/knowledge_executor.rs:21` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor::new` | method | `src/chat_v2/tools/paper_save_executor.rs:188` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::quick_assistant::desktop::toggle` | fn | `src/quick_assistant.rs:228` | F2-shell 1/0 | `pub fn toggle(app: &AppHandle)` |
| `dstu_memory::memory::compaction_flush::CompactionMemoryFlush` | struct | `crates/dstu-memory/src/memory/compaction_flush.rs:66` | L03-chat-pipeline 1/0 | `pub struct CompactionMemoryFlush` |
| `dstu_memory::memory::compaction_flush::parse_flush_response` | fn | `crates/dstu-memory/src/memory/compaction_flush.rs:216` | L03-chat-pipeline 1/0 | `pub fn parse_flush_response(response: &str) -> FlushExtraction` |
| `dstu_memory::memory::compressor::MemoryCompressor::new` | method | `crates/dstu-memory/src/memory/compressor.rs:52` | L13-vfs-api 1/0 | `pub fn new(llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_memory::memory::delete_hook::install_vfs_hooks` | fn | `crates/dstu-memory/src/memory/delete_hook.rs:108` | F1-kernel 1/0 | `pub fn install_vfs_hooks(scope: &mut dstu_kernel::Scope)` |
| `dstu_memory::memory::learner_profile::merge_profile_json_for_sync` | fn | `crates/dstu-memory/src/memory/learner_profile.rs:551` | F1-kernel 1/0 | `pub fn merge_profile_json_for_sync(local_json: &str, remote_json: &str) -> Option<String>` |
| `dstu_memory::memory::mastery_hook::install_mastery_hooks` | fn | `crates/dstu-memory/src/memory/mastery_hook.rs:38` | F1-kernel 1/0 | `pub fn install_mastery_hooks(scope: &mut dstu_kernel::Scope)` |
| `dstu_research::hpias::events::HpiasEventEmitter` | struct | `crates/dstu-research/src/hpias/events.rs:14` | L13-vfs-api 1/0 | `pub struct HpiasEventEmitter` |
| `dstu_research::hpias::events::HpiasEventEmitter::new` | method | `crates/dstu-research/src/hpias/events.rs:19` | L13-vfs-api 1/0 | `pub fn new(window: Window) -> Self` |
| `dstu_research::hpias::payloads::extract_question_from_intent` | fn | `crates/dstu-research/src/hpias/payloads.rs:30` | L13-vfs-api 1/0 | `pub fn extract_question_from_intent(intent: &Value) -> Option<String>` |
| `dstu_research::hpias::payloads::intent_has_research_blocks` | fn | `crates/dstu-research/src/hpias/payloads.rs:13` | L13-vfs-api 1/0 | `pub fn intent_has_research_blocks(intent: &Value) -> bool` |
| `dstu_research::hpias::retrieval_backend::HpiasResearchDeps` | struct | `crates/dstu-research/src/hpias/retrieval_backend.rs:33` | L13-vfs-api 1/0 | `pub struct HpiasResearchDeps` |
| `dstu_research::hpias::service::create_research_backend` | fn | `crates/dstu-research/src/hpias/service.rs:89` | L13-vfs-api 1/0 | `pub fn create_research_backend( window: Window, deps: HpiasResearchDeps, ) -> Option<Box<dyn HpiasResearchBackend>>` |
| `dstu_research::hpias::service::HpiasResearchSessionRequest` | struct | `crates/dstu-research/src/hpias/service.rs:52` | L13-vfs-api 1/0 | `pub struct HpiasResearchSessionRequest<'a>` |
| `dstu_research::insight::jobs::InsightJobWorker::new` ? | method | `crates/dstu-research/src/insight/jobs.rs:206` | L15-review-analytics 1/0 | `pub fn new( vfs_db: Arc<VfsDatabase>, mistakes_db: Option<Arc<crate::database::Database>>, ) -> Self` |
| `dstu_research::insight::repo::bump_stat` ? | fn | `crates/dstu-research/src/insight/repo.rs:191` | F1-kernel 1/0 | `pub fn bump_stat(conn: &Connection, insight_id: &str, column: &str) -> Result<(), AppError>` |
| `dstu_research::insight::service::InsightService` ? | struct | `crates/dstu-research/src/insight/service.rs:20` | L15-review-analytics 1/0 | `pub struct InsightService` |
| `dstu_research::insight::service::InsightService::new` ? | method | `crates/dstu-research/src/insight/service.rs:25` | L15-review-analytics 1/0 | `pub fn new(vfs_db: Arc<VfsDatabase>) -> Self` |
| `dstu_memory::memory::learner_profile::LearningGoal` | struct | `crates/dstu-memory/src/memory/learner_profile.rs:101` | L20-sync 0/2 | `pub struct LearningGoal` |
| `dstu_research::hpias::events::HPIAS_EVENT_CHANNEL` | const | `crates/dstu-research/src/hpias/events.rs:11` | L22-app-commands 0/2 | `pub const HPIAS_EVENT_CHANNEL: &str = "hpias_event"` |
| `dstu_memory::memory::service::MemoryService::new` | method | `crates/dstu-memory/src/memory/service.rs:389` | L22-app-commands 0/1 | `pub fn new( vfs_db: Arc<VfsDatabase>, lance_store: Arc<VfsLanceStore>, llm_manager: Arc<LLMManager>, ) -> Self` |
| `dstu_memory::memory::test_support::setup_memory_service` | fn | `crates/dstu-memory/src/memory/mod.rs:87` | L03-chat-pipeline 0/1 | `pub fn setup_memory_service() -> (TempDir, Arc<VfsDatabase>, MemoryService)` |

### 引用点样例

- `dstu_memory::memory::service::MemoryService` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:756`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:1129`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1177`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:33`
- `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:85`, `src/agent_wiring/tests/headless_tests.rs:34`；L13-vfs-api: `src/chat_v2/tools/mod.rs:73`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:5`
- `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:82`, `src/agent_wiring/tests/headless_tests.rs:29`；L13-vfs-api: `src/chat_v2/tools/mod.rs:71`
- `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:73`；L13-vfs-api: `src/chat_v2/tools/mod.rs:53`
- `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:75`；L13-vfs-api: `src/chat_v2/tools/mod.rs:70`
- `dstu_memory::memory::compaction_flush::FlushExtraction` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:271`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:290`
- `dstu_memory::memory::config::AutoExtractFrequency` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1641`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1643`
- `dstu_memory::memory::config::MemoryConfig::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1638`, `crates/dstu-agent/src/chat_v2/prompt_builder.rs:1051`
- `dstu_memory::memory::learner_profile::load_profile_from_db` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/prompt_builder.rs:1064`；L15-review-analytics: `src/mastery/service/tests.rs:211`, `src/mastery/service/tests.rs:304`, `src/mastery/service/tests.rs:672`, `src/mastery/service/tests.rs:695`；L14-qbank: `src/question_bank_service/tests.rs:98`
- `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:73`, `src/agent_wiring/tests/hooks_tests.rs:16`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:402`
- `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:60`；L13-vfs-api: `src/chat_v2/tools/mod.rs:69`
- `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:70`, `src/agent_wiring/tests/hooks_tests.rs:168`
- `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:74`；L13-vfs-api: `src/chat_v2/tools/mod.rs:75`
- `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:61`
- `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:48`
- `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:63`
- `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:62`
- `deep_student_lib::quick_assistant::desktop::toggle` — F2-shell: `src/lib.rs:730`
- `dstu_memory::memory::compaction_flush::CompactionMemoryFlush` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:757`
- `dstu_memory::memory::compaction_flush::parse_flush_response` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:293`
- `dstu_memory::memory::compressor::MemoryCompressor::new` — L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:1202`
- `dstu_memory::memory::delete_hook::install_vfs_hooks` — F1-kernel: `src/extensions.rs:51`
- `dstu_memory::memory::learner_profile::merge_profile_json_for_sync` — F1-kernel: `src/extensions.rs:260`
- `dstu_memory::memory::mastery_hook::install_mastery_hooks` — F1-kernel: `src/extensions.rs:65`
- `dstu_research::hpias::events::HpiasEventEmitter` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:14`
- `dstu_research::hpias::events::HpiasEventEmitter::new` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:348`
- `dstu_research::hpias::payloads::extract_question_from_intent` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:440`
- `dstu_research::hpias::payloads::intent_has_research_blocks` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:455`
- `dstu_research::hpias::retrieval_backend::HpiasResearchDeps` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:340`
- `dstu_research::hpias::service::create_research_backend` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:345`
- `dstu_research::hpias::service::HpiasResearchSessionRequest` — L13-vfs-api: `src/chat_v2/tools/generative_ui_executor.rs:355`
- `dstu_research::insight::jobs::InsightJobWorker::new` — L15-review-analytics: `src/insight/handlers.rs:150`
- `dstu_research::insight::repo::bump_stat` — F1-kernel: `src/agent_wiring/plugins.rs:130`
- `dstu_research::insight::service::InsightService` — L15-review-analytics: `src/insight/handlers.rs:13`
- `dstu_research::insight::service::InsightService::new` — L15-review-analytics: `src/insight/handlers.rs:18`
- `dstu_memory::memory::learner_profile::LearningGoal` — L20-sync: `src/sync_app_tests.rs:24`, `src/sync_app_tests.rs:35`
- `dstu_research::hpias::events::HPIAS_EVENT_CHANNEL` — L22-app-commands: `tests/generative_ui_executor_e2e.rs:99`, `tests/generative_ui_executor_e2e.rs:119`
- `dstu_memory::memory::service::MemoryService::new` — L22-app-commands: `tests/phase8_9_executor_e2e.rs:62`
- `dstu_memory::memory::test_support::setup_memory_service` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs:1246`

## 消费其他 lane

### L13-vfs-api（19 个条目，prod 393 / test 31）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::error::VfsResult` | type | 151/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/daily_log.rs` 等 8 个 |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 75/1 | `crates/dstu-memory/src/memory/audit_log.rs`, `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/config.rs` 等 18 个 |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 72/7 | `crates/dstu-memory/src/memory/audit_log.rs`, `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs` 等 8 个 |
| `dstu_vfs::vfs::types::VfsNote` ? | struct | 31/2 | `crates/dstu-memory/src/memory/semantic_dedup.rs`, `crates/dstu-memory/src/memory/service.rs`, `src/chat_v2/tools/memory_executor.rs` |
| `dstu_vfs::vfs::types::VfsUpdateNoteParams` ? | struct | 22/1 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/evolution.rs` 等 6 个 |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 10/1 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `dstu_vfs::vfs::types::FolderTreeNode` | struct | 7/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/handlers.rs` 等 4 个 |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | 6/1 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `dstu_vfs::vfs::types::VfsFolder` ? | struct | 4/0 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::build_numbered_sources` | fn | 3/2 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs` |
| `dstu_vfs::vfs::types::PomodoroDailyStat` | struct | 3/1 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 3/0 | `crates/dstu-research/src/insight/service.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 1/14 | `crates/dstu-memory/src/memory/mod.rs`, `crates/dstu-research/src/insight/tests.rs` |
| `dstu_vfs::vfs::hooks::NoteDeleteHook` | trait | 1/0 | `crates/dstu-memory/src/memory/delete_hook.rs` |
| `dstu_vfs::vfs::hooks::register_note_delete_hook` | fn | 1/0 | `crates/dstu-memory/src/memory/delete_hook.rs` |
| `dstu_vfs::vfs::types::VfsCreateTodoItemParams` | struct | 1/0 | `crates/dstu-research/src/insight/jobs.rs` |
| `dstu_vfs::vfs::types::VfsCreateTodoListParams` | struct | 1/0 | `crates/dstu-research/src/insight/jobs.rs` |
| `dstu_vfs::vfs::types::VfsResourceMetadata` ? | struct | 1/0 | `crates/dstu-research/src/insight/service.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/1 | `src/chat_v2/tools/learning_overview_executor.rs` |

### F4-security（16 个条目，prod 215 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError` | struct | 57/0 | `crates/dstu-research/src/insight/jobs.rs`, `crates/dstu-research/src/insight/recall.rs`, `crates/dstu-research/src/insight/repo.rs` 等 4 个 |
| `dstu_core::models::AppError::database` | method | 50/0 | `crates/dstu-research/src/insight/jobs.rs`, `crates/dstu-research/src/insight/recall.rs`, `crates/dstu-research/src/insight/repo.rs` 等 4 个 |
| `dstu_core::agent::ToolCall` ? | struct | 29/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_core::tool_args::with_localized_message` ? | fn | 17/0 | `src/chat_v2/tools/learning_overview_executor.rs`, `src/chat_v2/tools/memory_executor.rs`, `src/chat_v2/tools/paper_save_executor.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 14/1 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_core::models::AppError::validation` | method | 14/0 | `crates/dstu-research/src/insight/jobs.rs`, `crates/dstu-research/src/insight/service.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 7/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_core::agent::ToolResultInfo` ? | struct | 6/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 6/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_core::models::AppError::not_found` | method | 6/0 | `crates/dstu-research/src/insight/service.rs` |
| `dstu_core::events::event_types::INSIGHT_RECALL` ? | const | 3/0 | `src/chat_v2/tools/insight_recall_executor.rs` |
| `dstu_platform::background_tasks::BACKGROUND_TASKS` | static | 2/0 | `crates/dstu-memory/src/memory/handlers.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 1/0 | `src/chat_v2/tools/paper_save_executor.rs` |
| `dstu_core::tool_args::ensure_localized_error` ? | fn | 1/0 | `src/chat_v2/tools/paper_save_executor.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenPolicy` ? | enum | 1/0 | `src/chat_v2/tools/knowledge_executor.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenStreamFilter::new` ? | method | 1/0 | `src/chat_v2/tools/knowledge_executor.rs` |

### L11-vfs-repos（31 个条目，prod 83 / test 10）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_disabled_with_reason` | method | 8/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_pending` | method | 8/0 | `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_folders_by_parent` ? | method | 6/2 | `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder` ? | method | 6/1 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder` ? | method | 5/1 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo` | struct | 5/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/evolution.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 4/1 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/delete_hook.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_index_state_with_conn` | method | 4/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_folders_by_parent_with_conn` | method | 4/0 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource` | fn | 4/0 | `crates/dstu-memory/src/memory/delete_hook.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_PENDING` | const | 3/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::build_folder_path` | method | 3/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_daily_stats` ? | method | 2/1 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_indexed` | method | 2/0 | `crates/dstu-memory/src/memory/handlers.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::folder_exists` | method | 2/0 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_ids_recursive` | method | 2/0 | `crates/dstu-memory/src/memory/delete_hook.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_items_by_folder_with_conn` | method | 2/0 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::move_item_by_item_id_with_conn` | method | 2/0 | `crates/dstu-memory/src/memory/config.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::create_or_reuse_with_conn` | method | 2/0 | `crates/dstu-research/src/insight/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::delete_folder_with_conn` | method | 1/0 | `crates/dstu-memory/src/memory/config.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_with_conn` | method | 1/0 | `crates/dstu-memory/src/memory/config.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_items_by_folder` | method | 1/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::move_folder_with_conn` | method | 1/0 | `crates/dstu-memory/src/memory/config.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo` | struct | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::get_today_stats` | method | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `crates/dstu-research/src/insight/service.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_item_with_conn` | method | 1/0 | `crates/dstu-research/src/insight/jobs.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_list_with_conn` | method | 1/0 | `crates/dstu-research/src/insight/jobs.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::create_record` | method | 0/2 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::create` | fn | 0/1 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::CreateUnitInput` | struct | 0/1 | `crates/dstu-memory/src/memory/service.rs` |

### L10-notes（12 个条目，prod 71 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note` ? | method | 16/1 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/evolution.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content` | method | 13/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/evolution.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` ? | method | 8/1 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/learner_profile.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 6/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/daily_log.rs`, `crates/dstu-memory/src/memory/delete_hook.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` | method | 6/0 | `crates/dstu-memory/src/memory/delete_hook.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_conn` | method | 6/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_with_conn` | method | 6/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item` | method | 3/0 | `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location` | method | 3/0 | `crates/dstu-memory/src/memory/delete_hook.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder_uncommitted` | method | 2/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item_with_conn` | method | 1/0 | `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_content_with_conn` | method | 1/0 | `crates/dstu-memory/src/memory/service.rs` |

### L02-llm-manager（3 个条目，prod 65 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 59/0 | `crates/dstu-memory/src/memory/auto_extractor.rs`, `crates/dstu-memory/src/memory/category_manager.rs`, `crates/dstu-memory/src/memory/compaction_flush.rs` 等 15 个 |
| `dstu_llm::llm_manager::parser::enhanced_clean_json_response` | fn | 5/0 | `crates/dstu-memory/src/memory/auto_extractor.rs`, `crates/dstu-memory/src/memory/compaction_flush.rs`, `crates/dstu-memory/src/memory/evolution.rs` 等 5 个 |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 1/0 | `crates/dstu-memory/src/memory/mod.rs` |

### L12-vfs-index（11 个条目，prod 61 / test 8）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 39/0 | `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/handlers.rs`, `crates/dstu-memory/src/memory/mod.rs` 等 6 个 |
| `dstu_vfs::vfs::retrieval_planner::FusedRetrievalHit` | struct | 6/6 | `crates/dstu-research/src/hpias/retrieval_backend.rs`, `crates/dstu-research/src/hpias/synthesis.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 4/0 | `crates/dstu-memory/src/memory/evolution.rs`, `crates/dstu-memory/src/memory/mod.rs`, `crates/dstu-research/src/hpias/retrieval_backend.rs` 等 4 个 |
| `dstu_vfs::vfs::retrieval_planner::QueryModality` | enum | 3/0 | `crates/dstu-memory/src/memory/service.rs`, `crates/dstu-research/src/hpias/retrieval_backend.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService` | struct | 2/0 | `crates/dstu-memory/src/memory/handlers.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` | method | 2/0 | `crates/dstu-memory/src/memory/handlers.rs`, `crates/dstu-memory/src/memory/service.rs` |
| `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalRequest` | struct | 2/0 | `crates/dstu-memory/src/memory/service.rs`, `crates/dstu-research/src/hpias/retrieval_backend.rs` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever::new` | method | 2/0 | `crates/dstu-memory/src/memory/service.rs`, `crates/dstu-research/src/hpias/retrieval_backend.rs` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever` | struct | 1/0 | `crates/dstu-research/src/hpias/retrieval_backend.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalHit` | struct | 0/1 | `crates/dstu-research/src/hpias/synthesis.rs` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalIdentity` | struct | 0/1 | `crates/dstu-research/src/hpias/synthesis.rs` |

### L04-chat-session（5 个条目，prod 51 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 39/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 6/2 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs` 等 6 个 |
| `dstu_agent::chat_v2::types::SourceInfo` ? | struct | 5/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 1/1 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/2 | `src/chat_v2/tools/learning_overview_executor.rs` |

### F1-kernel（3 个条目，prod 25 / test 21）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 16/13 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/knowledge_executor.rs`, `src/chat_v2/tools/learning_overview_executor.rs` 等 5 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 7/8 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/learning_overview_executor.rs`, `src/chat_v2/tools/memory_executor.rs` |
| `dstu_kernel::plugin::Scope` | struct | 2/0 | `crates/dstu-memory/src/memory/delete_hook.rs`, `crates/dstu-memory/src/memory/mastery_hook.rs` |

### L15-review-analytics（11 个条目，prod 13 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_anki::fsrs_review_service::FsrsReviewService::new` ? | method | 2/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_learning::mastery::profile_sink::MasteryWeakPointEvidence` | struct | 2/0 | `crates/dstu-memory/src/memory/learner_profile.rs`, `crates/dstu-memory/src/memory/mastery_hook.rs` |
| `dstu_learning::mastery::profile_sink::WEAK_POINT_SOURCE_MASTERY` | const | 2/0 | `crates/dstu-memory/src/memory/learner_profile.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService` ? | struct | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_learning::mastery::profile_sink::MasteryProfileSink` | trait | 1/0 | `crates/dstu-memory/src/memory/mastery_hook.rs` |
| `dstu_learning::mastery::profile_sink::register_mastery_profile_sink` | fn | 1/0 | `crates/dstu-memory/src/memory/mastery_hook.rs` |
| `dstu_learning::mastery::service::MasteryService::new` ? | method | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_learning::study_loop::study_time::range` | fn | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_qbank::review_plan_service::ReviewPlanService` ? | struct | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_qbank::review_plan_service::ReviewPlanService::new` ? | method | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `dstu_learning::study_loop::study_time::add_seconds` | fn | 0/1 | `src/chat_v2/tools/learning_overview_executor.rs` |

### L22-app-commands（3 个条目，prod 10 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::LearningActivity` | struct | 5/1 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `deep_student_lib::commands::DailyActivityDetails` | struct | 3/1 | `src/chat_v2/tools/learning_overview_executor.rs` |
| `deep_student_lib::commands::AppState` | struct | 2/0 | `src/quick_assistant.rs` |

### F3-storage（4 个条目，prod 8 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 5/1 | `crates/dstu-memory/src/memory/mod.rs`, `crates/dstu-research/src/insight/disclosure.rs`, `crates/dstu-research/src/insight/jobs.rs` 等 5 个 |
| `dstu_storage::database::Database::new` ? | method | 1/1 | `crates/dstu-memory/src/memory/mod.rs`, `crates/dstu-research/src/insight/tests.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 1/0 | `crates/dstu-memory/src/memory/mod.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 1/0 | `crates/dstu-memory/src/memory/mod.rs` |

### L03-chat-pipeline（3 个条目，prod 4 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::context::citation_ledger_for_reply` ? | fn | 3/0 | `src/chat_v2/tools/academic_search_executor.rs`, `src/chat_v2/tools/insight_recall_executor.rs` |
| `dstu_agent::chat_v2::pipeline::managed_vfs_lance_store_for` ? | fn | 1/0 | `src/chat_v2/tools/memory_executor.rs` |
| `dstu_agent::chat_v2::context::CitationLedger::new` ? | method | 0/1 | `src/chat_v2/tools/academic_search_executor.rs` |

### L18-media-docs（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_media::media::ledger::media_learning_summary` ? | fn | 1/0 | `src/chat_v2/tools/learning_overview_executor.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L15-review-analytics 导入：`use dstu_research::insight::types::*` @ `src/insight/handlers.rs:9`
- 被 F2-shell 导入：`use dstu_research::insight::*` @ `src/lib.rs:100`
