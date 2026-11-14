# 跨 lane 服务草稿：F2-shell

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（4 个条目，其中 4 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_platform::startup_gate::STARTUP_READY_WAIT` | const | `crates/dstu-platform/src/startup_gate.rs:24` | F3-storage 1/0<br>L21-backup-governance 1/0 | `pub const STARTUP_READY_WAIT: Duration = Duration::from_secs(120)` |
| `dstu_platform::startup_gate::wait_startup_ready` | fn | `crates/dstu-platform/src/startup_gate.rs:46` | F3-storage 1/0<br>L21-backup-governance 1/0 | `pub async fn wait_startup_ready(timeout: Duration) -> bool` |
| `deep_student_lib::apk_installer::ApkInstallerHandle` | struct | `src/apk_installer.rs:26` | L22-app-commands 1/0 | `pub(crate) struct ApkInstallerHandle` |
| `deep_student_lib::load_mcp_config_from_db` | fn | `src/lib.rs:3868` | L22-app-commands 1/0 | `pub async fn load_mcp_config_from_db( database: &Arc<crate::database::Database>, ) -> Result<crate::mcp::McpConfig, Box<dyn std::error::Error + Send + Sync>>` |

### 引用点样例

- `dstu_platform::startup_gate::STARTUP_READY_WAIT` — F3-storage: `crates/dstu-storage/src/data_space.rs:2176`；L21-backup-governance: `src/data_governance/commands.rs:434`
- `dstu_platform::startup_gate::wait_startup_ready` — F3-storage: `crates/dstu-storage/src/data_space.rs:2176`；L21-backup-governance: `src/data_governance/commands.rs:434`
- `deep_student_lib::apk_installer::ApkInstallerHandle` — L22-app-commands: `src/commands.rs:537`
- `deep_student_lib::load_mcp_config_from_db` — L22-app-commands: `src/commands.rs:7006`

## 消费其他 lane

### F4-security（18 个条目，prod 56 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::internal` | method | 9/0 | `src/cmd/window_effects.rs` |
| `dstu_core::models::AppError::unknown` | method | 7/0 | `src/external_file_opener.rs`, `src/system_bars.rs` |
| `dstu_platform::debug_logger::init_global_logger` | fn | 7/0 | `src/lib.rs` |
| `dstu_platform::debug_logger::start_periodic_flush` | fn | 7/0 | `src/lib.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 5/0 | `src/external_file_opener.rs` |
| `dstu_core::models::AppError::validation` | method | 4/0 | `src/external_file_opener.rs` |
| `dstu_core::models::AppError` | struct | 3/0 | `src/cmd/window_effects.rs`, `src/external_file_opener.rs`, `src/system_bars.rs` |
| `dstu_platform::background_tasks::spawn` | fn | 2/0 | `src/lib.rs` |
| `dstu_platform::debug_log_service::flush_pending_debug_log_writes` | fn | 2/0 | `src/lib.rs` |
| `dstu_platform::debug_logger::flush_global_logger` | fn | 2/0 | `src/lib.rs` |
| `deep_student_lib::backup_config::start_auto_backup_scheduler` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::crash_logger::init_crash_logging` | fn | 1/0 | `src/lib.rs` |
| `dstu_core::models::AppError::not_found` | method | 1/0 | `src/external_file_opener.rs` |
| `dstu_platform::background_tasks::BACKGROUND_TASKS` | static | 1/0 | `src/lib.rs` |
| `dstu_platform::background_tasks::shutdown` | fn | 1/0 | `src/lib.rs` |
| `dstu_platform::metrics_server::ensure_metrics_server` | fn | 1/0 | `src/lib.rs` |
| `dstu_platform::secret_prompt::SecretPromptStore` | struct | 1/0 | `src/lib.rs` |
| `dstu_security::crypto::CryptoService::new` | method | 1/0 | `src/lib.rs` |

### F3-storage（30 个条目，prod 39 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::data_space::StartupRecoveryState` | struct | 5/0 | `src/lib.rs` |
| `dstu_storage::audit::AuditDatabase::open` | method | 3/0 | `src/lib.rs` |
| `dstu_storage::database::Database` | struct | 2/0 | `src/lib.rs` |
| `dstu_storage::schema_registry::SchemaRegistry` | struct | 2/0 | `src/lib.rs` |
| `dstu_storage::startup_cleanup::ResetSyncBaselineFn` | type | 2/0 | `src/lib.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::try_acquire` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::get_data_space_manager` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::init_data_space_manager` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::prepare_startup_recovery` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::startup_health::StartupComponentHealth` ? | struct | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::startup_health::StartupComponentHealthState` | struct | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::StartupRecoveryState::failed` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::data_space::StartupRecoveryState::new` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::database::Database::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_storage::database::manager::DatabaseManager::new` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::file_deletion_queue::recover_asset_deletions` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::file_deletion_queue::recover_workspace_deletions` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_storage::llm_usage::collector::UsageCollector::new` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::llm_usage::database::LlmUsageDatabase` | struct | 1/0 | `src/lib.rs` |
| `dstu_storage::llm_usage::database::LlmUsageDatabase::new` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::llm_usage::set_app_handle` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 1/0 | `src/lib.rs` |
| `dstu_storage::startup_cleanup::clear_purge_marker` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::startup_cleanup::purge_all_local_data` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::startup_cleanup::should_purge_on_start` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::unified_file_manager::saf_permission_plugin` | fn | 1/0 | `src/lib.rs` |
| `dstu_storage::unified_file_manager::sanitize_file_name_for_fs` | fn | 1/0 | `src/external_file_opener.rs` |
| `dstu_storage::unified_file_manager::set_app_handle` | fn | 1/0 | `src/lib.rs` |

### L19-mcp-browser（10 个条目，prod 19 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::mcp::config::McpTransportConfig` | enum | 6/0 | `src/lib.rs` |
| `dstu_mcp::mcp::config::McpFraming` | enum | 4/0 | `src/lib.rs` |
| `dstu_mcp::mcp::config::McpConfig` | struct | 2/0 | `src/lib.rs` |
| `dstu_browser::browser::database::BrowserDatabase::new` | method | 1/0 | `src/lib.rs` |
| `dstu_browser::browser::service::BrowserService::boot_cleanup` | method | 1/0 | `src/lib.rs` |
| `dstu_browser::browser::service::BrowserService::new` | method | 1/0 | `src/lib.rs` |
| `dstu_mcp::mcp::client::McpEvent` ? | enum | 1/0 | `src/lib.rs` |
| `dstu_mcp::mcp::global::get_global_mcp_client` | fn | 1/0 | `src/lib.rs` |
| `dstu_mcp::mcp::global::initialize_global_mcp_client` | fn | 1/0 | `src/lib.rs` |
| `dstu_mcp::tools::ToolRegistry::new_with` | method | 1/0 | `src/lib.rs` |

### L13-vfs-api（9 个条目，prod 10 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::pdf_protocol::resolve_allowed_dirs` | fn | 2/0 | `src/lib.rs` |
| `dstu_vfs::file_stream_protocol::cors_origin_for_request` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::file_stream_protocol::handle_asset_protocol` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::file_stream_protocol::resolve_blob_dirs` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::pdf_protocol::cors_origin_for_request` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::pdf_protocol::handle_asset_protocol` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::set_app_handle` | fn | 1/0 | `src/lib.rs` |

### L21-backup-governance（6 个条目，prod 10 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::data_governance::commands::AuditHealthState` | struct | 3/0 | `src/lib.rs` |
| `deep_student_lib::data_governance::commands::persist_migration_error` | fn | 3/0 | `src/lib.rs` |
| `deep_student_lib::data_governance::commands_restore::finalize_restore_activation` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::data_governance::commands::clear_migration_error` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::data_governance::init::initialize_with_report` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::data_governance::should_force_maintenance_mode_on_init_failure` | fn | 1/0 | `src/lib.rs` |

### L22-app-commands（2 个条目，prod 10 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 9/0 | `src/external_file_opener.rs`, `src/lib.rs` |
| `deep_student_lib::commands::ActiveDatabaseKind` | enum | 1/0 | `src/lib.rs` |

### L12-vfs-index（8 个条目，prod 8 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::lance_vector_store::LanceVectorStore::new` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::recover_stuck_indexing` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::indexing::VfsIndexingService::new` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService::new` | method | 1/0 | `src/lib.rs` |

### F1-kernel（7 个条目，prod 8 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::plugins::manager::PluginManager` | struct | 2/0 | `src/lib.rs` |
| `deep_student_lib::agent_wiring::plugins::NotesCanvasSource` | struct | 1/0 | `src/lib.rs` |
| `deep_student_lib::agent_wiring::roster::AppExecutorRoster` | struct | 1/0 | `src/lib.rs` |
| `deep_student_lib::agent_wiring::roster::verify_roster_coverage` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::agent_wiring::services::build_pipeline_services_from_managed` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::extensions::register_extensions` | fn | 1/0 | `src/lib.rs` |
| `deep_student_lib::plugins::manager::PluginManager::new` | method | 1/0 | `src/lib.rs` |

### L06-agent-orchestration（6 个条目，prod 8 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::automations::automation_app_is_exiting` ? | fn | 2/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::automations::mark_automation_app_exiting` ? | fn | 2/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::automations::should_keep_automation_background` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::automations::start_automation_scheduler` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::super_session::state::init` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::super_session::state::is_enabled` ? | fn | 1/0 | `src/lib.rs` |

### L04-chat-session（6 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::init_chat_v2` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::state::ChatV2State` ? | struct | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::state::ChatV2State::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_agent::set_app_handle` | fn | 1/0 | `src/lib.rs` |
| `dstu_agent::system_notification::notifications_disabled` | fn | 1/0 | `src/lib.rs` |

### L11-vfs-repos（6 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::cleanup_unreferenced` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::requeue_paged_pdfs_once` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::revive_config_blocked` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::sweep_orphan_index_units` | fn | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::cleanup_orphan_note_mindmap_resources` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::cleanup_unreferenced_retrievals` | method | 1/0 | `src/lib.rs` |

### L10-notes（4 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::cmd::notes::cleanup_note_editor_leases` | fn | 3/0 | `src/lib.rs` |
| `dstu_notes::notes_manager::NotesManager::new_with_vfs` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::note_lease_repo::NoteLeaseRepo::cleanup` | method | 1/0 | `src/lib.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::backfill_note_links_once` | method | 1/0 | `src/lib.rs` |

### L18-media-docs（5 个条目，prod 5 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::heic_decoder::init` | fn | 1/0 | `src/lib.rs` |
| `dstu_media::media::bilibili_lifecycle::init` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_media::media::bilibili_stream::handle` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_vision::exam_sheet_service::ExamSheetService::new` | method | 1/0 | `src/lib.rs` |
| `dstu_vision::pdf_ocr_service::PdfOcrService::new` | method | 1/0 | `src/lib.rs` |

### L02-llm-manager（4 个条目，prod 4 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 1/0 | `src/lib.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_llm::llm_manager::set_app_handle` | fn | 1/0 | `src/lib.rs` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager::new` ? | method | 1/0 | `src/lib.rs` |

### L05-agent-workspace（4 个条目，prod 4 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::approval_manager::ApprovalManager::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::maybe_run_helper` ? | fn | 1/0 | `src/main.rs` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 1/0 | `src/lib.rs` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator::new` ? | method | 1/0 | `src/lib.rs` |

### L14-qbank（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_qbank::qbank_generation::recover_interrupted_tasks` ? | fn | 1/0 | `src/lib.rs` |
| `dstu_qbank::question_bank_service::QuestionBankService::new` ? | method | 1/0 | `src/lib.rs` |
| `dstu_qbank::question_import_service::QuestionImportService::new` | method | 1/0 | `src/lib.rs` |

### L03-chat-pipeline（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline::new` ? | method | 1/0 | `src/lib.rs` |

### L17-memory-research（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::quick_assistant::desktop::toggle` | fn | 1/0 | `src/lib.rs` |

### L20-sync（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::data_governance::sync::state::SyncStateStore::reset_default_after_local_purge` | method | 1/0 | `src/lib.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::window_effects::*` @ `src/commands.rs:55`
- 被 L15-review-analytics 导入：`use deep_student_lib::fsrs_review_service::*` @ `src/fsrs_review_service/tests.rs:10`（test）
- 被 L15-review-analytics 导入：`use deep_student_lib::mastery::service::*` @ `src/mastery/service/tests.rs:9`（test）
- 被 L14-qbank 导入：`use deep_student_lib::qbank_read::*` @ `src/qbank_read/tests.rs:7`（test）
- 被 L14-qbank 导入：`use deep_student_lib::question_bank_service::*` @ `src/question_bank_service/tests.rs:7`（test）
- 被 L15-review-analytics 导入：`use deep_student_lib::review_plan_service::*` @ `src/review_plan_service/tests.rs:6`（test）
- 导入 L15-review-analytics：`use dstu_anki::fsrs_review_service::*` @ `src/lib.rs:89`
- 导入 L17-memory-research：`use dstu_research::insight::*` @ `src/lib.rs:100`
- 导入 L15-review-analytics：`use dstu_learning::mastery::*` @ `src/lib.rs:114`
- 导入 L15-review-analytics：`use dstu_learning::mastery::service::*` @ `src/lib.rs:116`
- 导入 L13-vfs-api：`use dstu_vfs::vfs::qbank_read::*` @ `src/lib.rs:161`
- 导入 L14-qbank：`use dstu_qbank::question_bank_service::*` @ `src/lib.rs:170`
- 导入 L15-review-analytics：`use dstu_qbank::review_plan_service::*` @ `src/lib.rs:182`
