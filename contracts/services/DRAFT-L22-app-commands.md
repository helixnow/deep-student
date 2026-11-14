# 跨 lane 服务草稿：L22-app-commands

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（5 个条目，其中 5 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | `src/commands.rs:681` | L10-notes 83/0<br>L15-review-analytics 52/0<br>L16-anki 37/0<br>L19-mcp-browser 35/0<br>L18-media-docs 31/0<br>L14-qbank 18/0<br>F1-kernel 15/0<br>F4-security 12/0<br>F2-shell 9/0<br>L02-llm-manager 7/0<br>L21-backup-governance 6/0<br>L20-sync 2/0<br>L17-memory-research 2/0<br>L07-agent-skills-ptc 1/0 | `pub struct AppState` |
| `deep_student_lib::commands::LearningActivity` | struct | `src/commands.rs:8233` | L17-memory-research 5/1 | `pub struct LearningActivity` |
| `deep_student_lib::commands::DailyActivityDetails` | struct | `src/commands.rs:8218` | L17-memory-research 3/1 | `pub struct DailyActivityDetails` |
| `deep_student_lib::commands::get_default_model_adapter_options` | fn | `src/commands.rs:3894` | L16-anki 2/0 | `pub fn get_default_model_adapter_options() -> Vec<serde_json::Value>` |
| `deep_student_lib::commands::ActiveDatabaseKind` | enum | `src/commands.rs:655` | F2-shell 1/0 | `pub enum ActiveDatabaseKind` |

### 引用点样例

- `deep_student_lib::commands::AppState` — F4-security: `src/backup_config.rs:116`, `src/backup_config.rs:122`, `src/backup_config.rs:138`, `src/backup_config.rs:174`；L07-agent-skills-ptc: `src/chat_v2/skill_taps.rs:20`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:240`, `src/chat_v2/tools/browser_executor.rs:712`, `src/cmd/mcp.rs:26`, `src/cmd/mcp.rs:59`；L18-media-docs: `src/chat_v2/tools/media_executor.rs:316`, `src/chat_v2/tools/media_executor.rs:510`, `src/chat_v2/tools/office_fidelity_executor.rs:102`, `src/chat_v2/tools/office_output.rs:232`；L10-notes: `src/chat_v2/tools/notes_import_executor.rs:88`, `src/cmd/notes.rs:300`, `src/cmd/notes.rs:328`, `src/cmd/notes.rs:354`；L16-anki: `src/cmd/anki_cards.rs:21`, `src/cmd/anki_cards.rs:30`, `src/cmd/anki_cards.rs:59`, `src/cmd/anki_connect.rs:231`；L15-review-analytics: `src/cmd/fsrs_review.rs:112`, `src/cmd/fsrs_review.rs:132`, `src/cmd/fsrs_review.rs:241`, `src/cmd/fsrs_review.rs:260`；L02-llm-manager: `src/cmd/translation.rs:94`, `src/translation/candidates.rs:26`, `src/translation/candidates.rs:36`, `src/translation/chat_popover.rs:20`；L21-backup-governance: `src/data_governance/commands.rs:95`, `src/data_governance/commands.rs:107`, `src/data_governance/commands.rs:441`, `src/data_governance/commands_backup.rs:1034`；L20-sync: `src/data_governance/commands_sync.rs:1628`, `src/data_governance/commands_sync.rs:2911`；F1-kernel: `src/extensions.rs:114`, `src/extensions.rs:128`, `src/extensions.rs:228`, `src/plugins/manager.rs:120`；F2-shell: `src/external_file_opener.rs:210`, `src/lib.rs:334`, `src/lib.rs:1339`, `src/lib.rs:1342`；L14-qbank: `src/qbank_generation.rs:20`, `src/qbank_generation.rs:30`, `src/qbank_generation.rs:41`, `src/qbank_generation.rs:51`；L17-memory-research: `src/quick_assistant.rs:40`, `src/quick_assistant.rs:45`
- `deep_student_lib::commands::LearningActivity` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:805`, `src/chat_v2/tools/learning_overview_executor.rs:986`, `src/chat_v2/tools/learning_overview_executor.rs:1005`, `src/chat_v2/tools/learning_overview_executor.rs:1046`
- `deep_student_lib::commands::DailyActivityDetails` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:1208`, `src/chat_v2/tools/learning_overview_executor.rs:781`, `src/chat_v2/tools/learning_overview_executor.rs:782`, `src/chat_v2/tools/learning_overview_executor.rs:824`
- `deep_student_lib::commands::get_default_model_adapter_options` — L16-anki: `src/cmd/anki_cards.rs:24`, `src/cmd/anki_cards.rs:63`
- `deep_student_lib::commands::ActiveDatabaseKind` — F2-shell: `src/lib.rs:3816`

## 消费其他 lane

### F4-security（79 个条目，prod 340 / test 207）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::validation` | method | 90/1 | `src/commands.rs`, `tests/sync_r11_repo_check.rs` |
| `dstu_core::models::AppError::database` | method | 45/0 | `src/commands.rs` |
| `dstu_core::models::AppError::internal` | method | 43/0 | `src/commands.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 35/9 | `src/commands.rs`, `tests/sync_r10_download.rs`, `tests/sync_r11_repo_check.rs` |
| `dstu_core::models::AnkiDocumentGenerationResponse` | struct | 11/0 | `src/commands.rs` |
| `dstu_core::models::AppError::not_found` | method | 8/2 | `src/commands.rs`, `tests/sync_r10_download.rs`, `tests/sync_r11_repo_check.rs` |
| `dstu_core::models::CreateTemplateRequest` | struct | 8/2 | `src/commands.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 7/43 | `src/commands.rs` |
| `dstu_core::models::StreamContext` | struct | 7/19 | `src/commands.rs` |
| `dstu_core::models::AppError::network` ? | method | 7/3 | `src/commands.rs`, `tests/sync_r11_repo_check.rs`, `tests/sync_r12_delta_upload.rs` 等 4 个 |
| `dstu_core::models::AppError::unknown` | method | 7/0 | `src/commands.rs` |
| `dstu_core::models::CustomAnkiTemplate` | struct | 6/0 | `src/commands.rs` |
| `dstu_platform::debug_logger::LogLevel` | enum | 6/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::flush_pending_debug_log_writes` | fn | 4/0 | `src/commands.rs` |
| `dstu_core::models::AppError` | struct | 3/18 | `src/commands.rs`, `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs` 等 15 个 |
| `dstu_core::models::AppError::not_implemented` | method | 3/0 | `src/commands.rs` |
| `dstu_core::models::FieldExtractionRule` | struct | 3/0 | `src/commands.rs` |
| `dstu_core::models::UpdateTemplateRequest` | struct | 3/0 | `src/commands.rs` |
| `dstu_core::models::AnkiGenerationOptions` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::ExamSheetSessionDetailResponse` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::ExamSheetSessionListResponse` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::ModelAssignments` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::RenameExamSheetSessionResponse` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::TemplateExportResponse` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::UpdateExamSheetCardsRequest` | struct | 2/0 | `src/commands.rs` |
| `dstu_core::models::UpdateExamSheetCardsResponse` | struct | 2/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::redact_sensitive_text` | fn | 2/0 | `src/commands.rs` |
| `dstu_core::models::AnkiCard` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::AnkiDocumentGenerationRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::AppError::new` | method | 1/0 | `src/commands.rs` |
| `dstu_core::models::AppErrorType` | enum | 1/0 | `src/commands.rs` |
| `dstu_core::models::DocumentTask` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::ExamSheetSessionDetail` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::ExamSheetSessionDetailRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::ExamSheetSessionListRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::MistakeExamSheetLink` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::PdfOcrPageInput` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::PdfOcrRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::PdfOcrResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::RenameExamSheetSessionRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::StandardModel2Output` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::TemplateBulkImportRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_core::models::TemplateImportRequest` | struct | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::cleanup_old_debug_logs` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::clear_all_debug_logs` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::DebugLogsInfo` | struct | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::ensure_debug_log_dir` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::get_debug_logs_info` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::read_debug_log_file` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_log_service::redact_sensitive_fields` | fn | 1/0 | `src/commands.rs` |
| `dstu_platform::debug_logger::get_global_logger` | fn | 1/0 | `src/commands.rs` |
| `dstu_security::crypto::CryptoService` | struct | 1/0 | `src/commands.rs` |
| `dstu_util::utils::token_budget::estimate_tokens_with_model` ? | fn | 1/0 | `src/commands.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 0/18 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 5 个 |
| `dstu_core::agent::ToolCall::new` ? | method | 0/16 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_core::agent::ToolCall` ? | struct | 0/12 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_security::crypto::backup_crypto::FileCipherSession` | struct | 0/9 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_security::crypto::backup_crypto::check_password_verifier` | fn | 0/8 | `tests/sync_r10_protocol_locks.rs`, `tests/sync_r10_verifier.rs` |
| `dstu_core::events::event_types::GENERATIVE_UI` ? | const | 0/5 | `tests/generative_ui_executor_e2e.rs` |
| `dstu_security::crypto::backup_crypto::FileCipherSession::with_params` | method | 0/5 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_security::crypto::backup_crypto::is_encrypted_backup` | fn | 0/4 | `tests/sync_r12_delta_upload.rs` |
| `dstu_security::crypto::backup_crypto::PasswordVerifier` | struct | 0/4 | `tests/sync_r10_protocol_locks.rs`, `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup_file` | fn | 0/3 | `tests/sync_r10_verifier.rs`, `tests/sync_r11_repo_check.rs`, `tests/sync_r12_v1_marker_trust.rs` |
| `dstu_security::crypto::backup_crypto::PASSWORD_VERIFIER_KDF_ARGON2ID` | const | 0/3 | `tests/sync_r10_protocol_locks.rs`, `tests/sync_r10_verifier.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 0/2 | `tests/tool_pack_integration_tests.rs` |
| `dstu_core::error_details::http_status_to_error_code` | fn | 0/2 | `tests/tools_integration_tests.rs` |
| `dstu_security::crypto::backup_crypto::create_password_verifier` | fn | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::decrypt_backup` | fn | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup` | fn | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::KDF_MAX_M_COST_KIB` | const | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::KDF_MAX_P_COST` | const | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::KDF_MAX_T_COST` | const | 0/2 | `tests/sync_r10_verifier.rs` |
| `dstu_core::agent::MessageBlock` ? | struct | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_core::agent::MessageBlock::new_content` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_core::agent::MessageBlock::new_thinking` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_core::agent::ToolResultInfo::cancelled` ? | method | 0/1 | `tests/tool_pack_integration_tests.rs` |
| `dstu_security::crypto::backup_crypto::decrypt_backup_file` | fn | 0/1 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::EncryptedRootMemory` | struct | 0/1 | `tests/sync_r10_verifier.rs` |
| `dstu_security::crypto::backup_crypto::EncryptedRootMemory::at` | method | 0/1 | `tests/sync_r10_verifier.rs` |

### L14-qbank（42 个条目，prod 57 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_qbank::qbank_authoring_service::QuestionAuthoringService::new` | method | 6/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyReconcileService::new` | method | 4/0 | `src/commands.rs` |
| `dstu_qbank::qbank_management::QuestionBankManagementService::new` | method | 3/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::BatchResult` ? | struct | 3/0 | `src/commands.rs` |
| `dstu_qbank::qbank_authoring_service::QuestionAuthoringDraft` | struct | 2/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::MockExamSession` ? | struct | 2/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::CsvImportResult` | struct | 2/0 | `src/commands.rs` |
| `dstu_qbank::qbank_authoring_service::AuthoringCommitReceipt` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_authoring_service::QuestionDraftSummary` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationAudit` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationReceipt` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseDecision` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseReport` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseResolveReceipt` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_management::DeleteGroupMode` | enum | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_management::GroupDeleteResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::qbank_management::QuestionBankStructure` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_authoring_runner::resolve_visual_fallback` | fn | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_authoring_runner::SourceRange` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::ActivityHeatmapPoint` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::CheckInCalendar` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::DailyPracticeResult` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::GeneratedPaper` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::KnowledgePoint` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::KnowledgeStatsComparison` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::LearningTrendPoint` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::MockExamConfig` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::MockExamScoreCard` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::PaperConfig` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::QuestionBankService` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::SubmitAnswerResult` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_bank_service::TimedPracticeSession` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_export_service::authoring::export_document` | fn | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_export_service::authoring::export_portable` | fn | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_export_service::authoring::PortableExport` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_export_service::CsvExportResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::CsvImportCancellation` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::CsvPreviewResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::ImportResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::PdfTextInspection` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::QuestionImportCancellation` | struct | 1/0 | `src/commands.rs` |
| `dstu_qbank::question_import_service::QuestionImportCancellation::new` | method | 1/0 | `src/commands.rs` |

### F3-storage（45 个条目，prod 36 / test 129）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 8/8 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 6 个 |
| `dstu_storage::file_manager::FileManager` | struct | 5/3 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 4 个 |
| `dstu_storage::database::Database::new` ? | method | 4/5 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 6 个 |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 3/3 | `src/commands.rs`, `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::deny_hidden_local_path` | fn | 3/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::sanitize_for_legacy` | fn | 2/2 | `src/cmd/helpers.rs`, `src/commands.rs`, `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 2/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::ensure_local_path` | fn | 2/0 | `src/commands.rs` |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 1/2 | `src/commands.rs`, `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::database::manager::DatabaseManager` | struct | 1/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::get_file_size` | fn | 1/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::hash_file_sha256` | fn | 1/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::read_all_bytes_bounded` | fn | 1/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::read_to_string` | fn | 1/0 | `src/commands.rs` |
| `dstu_storage::unified_file_manager::write_text_file` | fn | 1/0 | `src/commands.rs` |
| `dstu_storage::data_space::Slot` | enum | 0/19 | `tests/sync_r10_android.rs`, `tests/sync_r10_chaos_lease.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/17 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 6 个 |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/12 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 7 个 |
| `dstu_storage::data_space::DataSpaceManager::new` | method | 0/8 | `tests/sync_r10_android.rs`, `tests/sync_r10_chaos_lease.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/7 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 7 个 |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 0/4 | `tests/sync_r11_autosync.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::try_acquire` | method | 0/3 | `tests/sync_r11_autosync.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/3 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase7_system_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `dstu_storage::unified_file_manager::extract_file_name` | fn | 0/3 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::sanitize_file_name_for_fs` | fn | 0/3 | `tests/sync_r10_android.rs` |
| `dstu_storage::backup_common::BACKUP_GLOBAL_LIMITER` | static | 0/2 | `tests/sync_r11_autosync.rs` |
| `dstu_storage::backup_common::current_data_governance_operation` | fn | 0/2 | `tests/sync_r11_autosync.rs` |
| `dstu_storage::data_space::DataSpaceManager` | struct | 0/2 | `tests/sync_r10_android.rs`, `tests/sync_r10_chaos_lease.rs` |
| `dstu_storage::data_space::get_data_space_manager` | fn | 0/2 | `tests/sync_r11_history.rs`, `tests/sync_r12_conflict_fast_path.rs` |
| `dstu_storage::data_space::init_data_space_manager` | fn | 0/2 | `tests/sync_r11_history.rs`, `tests/sync_r12_conflict_fast_path.rs` |
| `dstu_storage::unified_file_manager::extract_extension` | fn | 0/2 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::is_opaque_document_id` | fn | 0/2 | `tests/sync_r10_android.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard` | struct | 0/1 | `tests/sync_r11_autosync.rs` |
| `dstu_storage::llm_usage::database::LlmUsageDatabase` | struct | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::llm_usage::database::LlmUsageDatabase::new` | method | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo` | struct | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::insert_usage` | method | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::llm_usage::types::UsageRecord` ? | struct | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::llm_usage::types::UsageRecord::new` ? | method | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_storage::unified_file_manager::DOUBLE_ENCODED_VIRTUAL_URI_REJECTED` | const | 0/1 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::PENDING_SAF_PERSIST_DIR` | const | 0/1 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::PENDING_SAF_PERSIST_FILE` | const | 0/1 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::persistable_saf_queue_file` | fn | 0/1 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::queue_persistable_saf_uri` | fn | 0/1 | `tests/sync_r10_android.rs` |
| `dstu_storage::unified_file_manager::reject_double_encoded_virtual_uri` | fn | 0/1 | `tests/sync_r10_android.rs` |

### L11-vfs-repos（31 个条目，prod 30 / test 17）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::question_repo::Question` | struct | 6/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::UpdateQuestionParams` | struct | 4/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionBankStats` | struct | 3/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::CreateQuestionParams` | struct | 2/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionFilters` | struct | 2/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::exam_repo::ImportingSession` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::clear_import_state` | method | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_exam_sheet` ? | method | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_importing_sessions` | method | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_status` | method | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::AnswerSubmission` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::MistakeListFilters` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::MistakeListResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionHistory` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionImage` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionListResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionSearchFilters` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionSearchListResult` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/session_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_item_by_item_id` | method | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/session_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::get_textbook` | method | 0/2 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_list` | method | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo` | struct | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::create_textbook` ? | method | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::update_page_count` | method | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo` | struct | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::get_todo_item` | method | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::list_items_by_list` | method | 0/1 | `tests/phase5_tool_execution_e2e.rs` |

### L02-llm-manager（23 个条目，prod 27 / test 33）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::VendorConfig` | struct | 5/11 | `src/commands.rs`, `tests/phase7_system_executor_e2e.rs` |
| `dstu_llm::llm_manager::build_provider_adapter` | fn | 2/4 | `src/commands.rs` |
| `dstu_llm::llm_manager::ModelProfile` | struct | 2/2 | `src/commands.rs`, `tests/phase7_system_executor_e2e.rs` |
| `dstu_llm::llm_manager::AUTH_MODE_NONE` | const | 2/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::VENDOR_ID` | const | 2/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::AUTH_MODE_OPENAI_CODEX_OAUTH` | const | 1/7 | `src/commands.rs` |
| `dstu_llm::llm_manager::LLMManager` | struct | 1/3 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs`, `tests/phase7_system_executor_e2e.rs` 等 4 个 |
| `dstu_llm::llm_manager::LLMManager::apply_reasoning_config` | method | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::looks_like_image_generation_model_id` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::model2_pipeline::apply_generation_params` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::BUILTIN_MODELS` | const | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::fetch_usage` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::is_opencode_go_config` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::OpenCodeGoUsage` | struct | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::PROVIDER_TYPE` | const | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::opencode_go::usage_client` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::provider_quirks::resolve_quirks` | fn | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::request_adapter_for_config` | fn | 1/0 | `src/commands.rs` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager` ? | struct | 1/0 | `src/commands.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 0/3 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase7_system_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::MODEL_ASSIGNMENTS_CHANGED_EVENT` | const | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor` | struct | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor::new` | method | 0/1 | `tests/phase7_system_executor_e2e.rs` |

### L18-media-docs（8 个条目，prod 6 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | 2/0 | `src/commands.rs` |
| `dstu_media::media::wav::encode_wav_mono_16k` ? | fn | 1/0 | `src/commands.rs` |
| `dstu_vision::exam_sheet_service::ExamSheetService` | struct | 1/0 | `src/commands.rs` |
| `dstu_vision::pdf_ocr_service::PdfOcrService` | struct | 1/0 | `src/commands.rs` |
| `dstu_vision::pdf_ocr_service::PdfOcrSession` | struct | 1/0 | `src/commands.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::PDF_ANNOTATIONS_CHANGED_EVENT` | const | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor` | struct | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor::new` | method | 0/1 | `tests/phase8_9_executor_e2e.rs` |

### L12-vfs-index（5 个条目，prod 4 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::lance_vector_store::LanceVectorStore::new` | method | 3/0 | `src/commands.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | 1/1 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService::new` | method | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |

### L19-mcp-browser（9 个条目，prod 3 / test 32）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::mcp::config::McpConfig` | struct | 3/0 | `src/commands.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/8 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 8 个 |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/8 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 8 个 |
| `dstu_mcp::tools::WebSearchTool` | struct | 0/4 | `tests/tools_integration_tests.rs` |
| `dstu_mcp::tools::Tool` | trait | 0/3 | `tests/tools_integration_tests.rs` |
| `dstu_mcp::tools::ToolRegistry::new_with` | method | 0/3 | `tests/tools_integration_tests.rs` |
| `dstu_mcp::tools::ToolContext` | struct | 0/2 | `tests/tools_integration_tests.rs` |
| `dstu_mcp::tools::web_search::ProviderStrategies` | struct | 0/2 | `tests/tools_integration_tests.rs` |
| `dstu_mcp::tools::web_search::ProviderStrategy` | struct | 0/2 | `tests/tools_integration_tests.rs` |

### L13-vfs-api（12 个条目，prod 3 / test 33）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 1/10 | `src/commands.rs`, `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 6 个 |
| `dstu_vfs::pdf_protocol::path_is_within` | fn | 1/0 | `src/commands.rs` |
| `dstu_vfs::pdf_protocol::resolve_allowed_dirs` | fn | 1/0 | `src/commands.rs` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor::new` | method | 0/9 | `tests/generative_ui_executor_e2e.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/5 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs`, `tests/phase8_9_executor_e2e.rs` 等 5 个 |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsNote` ? | struct | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor` | struct | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor::new` | method | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor` | struct | 0/1 | `tests/generative_ui_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsFolder` ? | struct | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | 0/1 | `tests/session_executor_e2e.rs` |

### F2-shell（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::apk_installer::ApkInstallerHandle` | struct | 1/0 | `src/commands.rs` |
| `deep_student_lib::load_mcp_config_from_db` | fn | 1/0 | `src/commands.rs` |

### L04-chat-session（21 个条目，prod 1 / test 80）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 1/5 | `src/commands.rs`, `tests/session_executor_e2e.rs`, `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 0/14 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 0/12 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 0/7 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 0/7 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/7 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 7 个 |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new` ? | method | 0/6 | `tests/dstu_canvas_executor_e2e.rs`, `tests/generative_ui_executor_e2e.rs`, `tests/phase5_tool_execution_e2e.rs` 等 6 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_v2` ? | method | 0/4 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry::from_vec` ? | method | 0/4 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/2 | `tests/session_executor_e2e.rs`, `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_block_v2` ? | method | 0/2 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_headless` ? | method | 0/1 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_v2` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor::AdmittedToolDispatcher` ? | trait | 0/1 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::types::SETTINGS_CHANGED_EVENT` ? | const | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatMessage` ? | struct | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_assistant` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_user` ? | method | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatSession` ? | struct | 0/1 | `tests/session_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatSession::new` ? | method | 0/1 | `tests/session_executor_e2e.rs` |

### L01-llm-providers（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::providers::normalize_ollama_root_base_url` | fn | 1/0 | `src/commands.rs` |

### L10-notes（19 个条目，prod 1 / test 47）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_notes::notes_manager::NotesManager` | struct | 1/0 | `src/commands.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 0/7 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs`, `tests/session_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` | method | 0/6 | `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_DELETE_ITEM` | const | 0/4 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_RESTORE` | const | 0/4 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_CREATE_ITEM` | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_DELETE_LIST` | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_UPDATE_ITEM` | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_UPDATE_LIST` | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_LIST_TRASH` | const | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_REORDER` | const | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor` | struct | 0/2 | `tests/phase5_tool_execution_e2e.rs`, `tests/tool_pack_integration_tests.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` ? | method | 0/2 | `tests/dstu_canvas_executor_e2e.rs`, `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor` | struct | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor::new` | method | 0/1 | `tests/dstu_canvas_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_CREATE_LIST` | const | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::USER_TODO_SEARCH` | const | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor::new` | method | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_content` | method | 0/1 | `tests/session_executor_e2e.rs` |

### L16-anki（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_anki::anki::get_template_config` | fn | 1/0 | `src/commands.rs` |

### L07-agent-skills-ptc（3 个条目，prod 0 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` ? | struct | 0/4 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor` ? | struct | 0/1 | `tests/phase7_system_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor::new` ? | method | 0/1 | `tests/phase7_system_executor_e2e.rs` |

### L05-agent-workspace（2 个条目，prod 0 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::helper_arg` ? | fn | 0/1 | `tests/windows_shell_helper_e2e.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::payload_root` ? | fn | 0/1 | `tests/windows_shell_helper_e2e.rs` |

### L06-agent-orchestration（15 个条目，prod 0 / test 30）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor` ? | struct | 0/4 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_DELETE` ? | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_RUN_NOW` ? | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_SET_ENABLED` ? | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_UPDATE` ? | const | 0/3 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::automations::list_automation_runs` ? | fn | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::automations::load_automations` ? | fn | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_PROPOSE` ? | const | 0/2 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor` ? | struct | 0/2 | `tests/session_executor_e2e.rs`, `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::automations::AUTOMATIONS_CHANGED_EVENT` ? | const | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor` ? | struct | 0/1 | `tests/tool_pack_integration_tests.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor` ? | struct | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor::new` ? | method | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_LIST` ? | const | 0/1 | `tests/phase5_tool_execution_e2e.rs` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor::new` ? | method | 0/1 | `tests/session_executor_e2e.rs` |

### L17-memory-research（5 个条目，prod 0 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_research::hpias::events::HPIAS_EVENT_CHANNEL` | const | 0/2 | `tests/generative_ui_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor` | struct | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor::new` | method | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_memory::memory::service::MemoryService` | struct | 0/1 | `tests/phase8_9_executor_e2e.rs` |
| `dstu_memory::memory::service::MemoryService::new` | method | 0/1 | `tests/phase8_9_executor_e2e.rs` |

### L23-sync-providers（62 个条目，prod 0 / test 381）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::cloud_storage::traits::FileInfo` | struct | 0/72 | `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs`, `tests/sync_r10_chaos_truncation.rs` 等 14 个 |
| `dstu_sync::cloud_storage::traits::CloudStorage` ? | trait | 0/31 | `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs`, `tests/sync_r10_chaos_truncation.rs` 等 15 个 |
| `dstu_sync::cloud_storage::repo_check::RepoCheckStatus` | enum | 0/13 | `tests/sync_r11_repo_check.rs` |
| `dstu_sync::cloud_storage::delta_gc::sweep_gc_candidates` | fn | 0/12 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_OBJECTS_PREFIX` | const | 0/12 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckProblemKind` | enum | 0/12 | `tests/sync_r11_repo_check.rs` |
| `dstu_sync::cloud_storage::traits::ListOutcome` | struct | 0/12 | `tests/sync_r10_chaos_truncation.rs`, `tests/sync_r11_lease.rs`, `tests/sync_r11_repo_check.rs` 等 7 个 |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_PREFIX` | const | 0/11 | `tests/sync_r12_backup_lease.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::delta_gc::collect_gc_candidates` | fn | 0/11 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::repo_check::run_repo_check` | fn | 0/11 | `tests/sync_r11_repo_check.rs` |
| `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease_with_ttl` | fn | 0/11 | `tests/sync_r11_lease.rs` |
| `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2` | struct | 0/10 | `tests/sync_r12_delta_format.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::delta_gc::BACKUP_V2_GC_CANDIDATES_PREFIX` | const | 0/9 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_upload::device_index_key` | fn | 0/9 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::backup_lease::acquire_backup_repo_lease_with_ttl` | fn | 0/8 | `tests/sync_r12_backup_lease.rs` |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_LEASE_HELD_ERROR_CODE` | const | 0/8 | `tests/sync_r12_backup_lease.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::sync_manager::CloudSyncManager` | struct | 0/8 | `tests/sync_r10_download.rs`, `tests/sync_r10_verifier.rs`, `tests/sync_r11_repo_check.rs` 等 5 个 |
| `dstu_sync::cloud_storage::sync_lease::SYNC_LEASE_HELD_ERROR_CODE` | const | 0/7 | `tests/sync_r11_lease.rs`, `tests/sync_r12_backup_lease.rs` |
| `dstu_sync::cloud_storage::sync_manager::CloudSyncManager::new` | method | 0/7 | `tests/sync_r10_download.rs`, `tests/sync_r10_verifier.rs`, `tests/sync_r11_repo_check.rs` 等 5 个 |
| `dstu_sync::cloud_storage::backup_lease::BackupRepoLease` | struct | 0/6 | `tests/sync_r12_backup_lease.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::delta_gc::GcCandidateV2` | struct | 0/6 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_format::BackupV2RepoConfig` | struct | 0/5 | `tests/sync_r12_delta_format.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2::decode` | method | 0/5 | `tests/sync_r12_delta_format.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::delta_upload::PublishResult` | struct | 0/5 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::sync_lease::SYNC_TARGET_LEASE_PREFIX` | const | 0/5 | `tests/sync_r11_lease.rs`, `tests/sync_r12_backup_lease.rs` |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_FORMAT_VERSION` | const | 0/4 | `tests/sync_r12_backup_lease.rs`, `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_CONFIG_KEY` | const | 0/4 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_MANIFESTS_PREFIX` | const | 0/4 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_SNAPSHOTS_PREFIX` | const | 0/4 | `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_format::MAX_LOGICAL_PATH_BYTES` | const | 0/3 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_format::MAX_SNAPSHOT_FILES` | const | 0/3 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_format::SnapshotFileRefV2` | struct | 0/3 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_upload::BackupV2DeviceIndex::decode` | method | 0/3 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_upload::publish_verified_staging` | fn | 0/3 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_upload::PublishParams` | struct | 0/3 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::sync_lease::SyncTargetLease` | struct | 0/3 | `tests/sync_r11_lease.rs` |
| `dstu_sync::cloud_storage::traits::ListOutcome::complete` | method | 0/3 | `tests/sync_r10_chaos_truncation.rs`, `tests/sync_r12_delta_restore.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::config::CloudStorageConfig` ? | struct | 0/2 | `tests/sync_r10_provider_contract.rs` |
| `dstu_sync::cloud_storage::config::StorageProvider` | enum | 0/2 | `tests/sync_r10_provider_contract.rs` |
| `dstu_sync::cloud_storage::delta_format::BackupV2RepoConfig::decode` | method | 0/2 | `tests/sync_r12_delta_format.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::delta_format::DELTA_FORMAT_VERSION` | const | 0/2 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_gc::GC_CANDIDATE_FORMAT` | const | 0/2 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_gc::GC_CANDIDATE_FORMAT_VERSION` | const | 0/2 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_gc::GcParams` | struct | 0/2 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_upload::BackupV2DeviceIndex` | struct | 0/2 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::sync_manager::EncryptionMarker` | struct | 0/2 | `tests/sync_r12_neutral_names.rs`, `tests/sync_r12_v1_marker_trust.rs` |
| `dstu_sync::cloud_storage::traits::DownloadProgressCallback` | type | 0/2 | `tests/sync_r10_download.rs`, `tests/sync_r11_repo_check.rs` |
| `dstu_sync::cloud_storage::backup_lease::DEFAULT_BACKUP_LEASE_TTL` | const | 0/1 | `tests/sync_r12_backup_lease.rs` |
| `dstu_sync::cloud_storage::config::WebDavConfig` | struct | 0/1 | `tests/sync_r10_provider_contract.rs` |
| `dstu_sync::cloud_storage::create_storage` | fn | 0/1 | `tests/sync_r10_provider_contract.rs` |
| `dstu_sync::cloud_storage::delta_format::BACKUP_V2_FORMAT` | const | 0/1 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_format::MAX_OBJECT_KEY_BYTES` | const | 0/1 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_format::SNAPSHOT_V2_FORMAT` | const | 0/1 | `tests/sync_r12_delta_format.rs` |
| `dstu_sync::cloud_storage::delta_gc::DEFAULT_GC_GRACE` | const | 0/1 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_gc::GcCandidateV2::decode` | method | 0/1 | `tests/sync_r12_delta_gc.rs` |
| `dstu_sync::cloud_storage::delta_restore::restore_snapshot_to_staging` | fn | 0/1 | `tests/sync_r12_delta_restore.rs` |
| `dstu_sync::cloud_storage::delta_restore::RestoreParams` | struct | 0/1 | `tests/sync_r12_delta_restore.rs` |
| `dstu_sync::cloud_storage::delta_restore::RestoreResult` | struct | 0/1 | `tests/sync_r12_delta_restore.rs` |
| `dstu_sync::cloud_storage::delta_upload::DEFAULT_BACKUP_V2_MAX_VERSIONS` | const | 0/1 | `tests/sync_r12_delta_upload.rs` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckReport` | struct | 0/1 | `tests/sync_r11_repo_check.rs` |
| `dstu_sync::cloud_storage::sync_lease::SYNC_TARGET_LEASE_FORMAT_VERSION` | const | 0/1 | `tests/sync_r11_lease.rs` |
| `dstu_sync::cloud_storage::sync_manager::BackupVersion` | struct | 0/1 | `tests/sync_r10_download.rs` |

### L21-backup-governance（18 个条目，prod 0 / test 65）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::data_governance::backup::delta_inventory::MANIFEST_LOGICAL_PATH` | const | 0/23 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_inventory.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::data_governance::backup::delta_inventory::build_inventory` | fn | 0/6 | `tests/sync_r12_delta_inventory.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::build_inventory_cross_checked` | fn | 0/5 | `tests/sync_r12_delta_inventory.rs`, `tests/sync_r12_delta_restore.rs` |
| `dstu_sync::data_governance::backup::BackupFile` | struct | 0/4 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_inventory.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::data_governance::backup::BackupManifest` | struct | 0/4 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_inventory.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::data_governance::backup::BackupManifest::new` | method | 0/4 | `tests/sync_r12_delta_gc.rs`, `tests/sync_r12_delta_inventory.rs`, `tests/sync_r12_delta_restore.rs` 等 4 个 |
| `dstu_sync::data_governance::backup::delta_inventory::diff` | fn | 0/4 | `tests/sync_r12_delta_inventory.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::validate_logical_path` | fn | 0/3 | `tests/sync_r12_delta_inventory.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::manifest_unchanged_ignoring_volatile` | fn | 0/2 | `tests/sync_r12_delta_inventory.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_with_password` | fn | 0/2 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::BackupManager` | struct | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::BackupManager::new` | method | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::VOLATILE_MANIFEST_FIELDS` | const | 0/1 | `tests/sync_r12_delta_inventory.rs` |
| `dstu_sync::data_governance::backup::zip_export::export_backup_to_zip` | fn | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip` | fn | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_resumable` | fn | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_with_progress` | fn | 0/1 | `tests/sync_r10_download.rs` |
| `dstu_sync::data_governance::backup::zip_export::ZipExportOptions` | struct | 0/1 | `tests/sync_r10_download.rs` |

### L24-chatanki（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor` | struct | 0/1 | `tests/tool_pack_integration_tests.rs` |

### L20-sync（28 个条目，prod 0 / test 144）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::data_governance::sync::SyncChangeWithData` | struct | 0/21 | `tests/sync_r10_chaos_clock.rs`, `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs` 等 7 个 |
| `dstu_sync::data_governance::sync::SyncManager::new` | method | 0/21 | `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs`, `tests/sync_r10_chaos_truncation.rs` 等 5 个 |
| `dstu_sync::data_governance::sync::ChangeOperation` ? | enum | 0/19 | `tests/sync_r10_chaos_clock.rs`, `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs` 等 7 个 |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictPolicy` | enum | 0/12 | `tests/sync_r10_chaos_clock.rs`, `tests/sync_r11_history.rs`, `tests/sync_r12_conflict_fast_path.rs` |
| `dstu_sync::data_governance::sync::SyncManager` | struct | 0/12 | `tests/sync_r10_chaos_clock.rs`, `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs` 等 9 个 |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes` | method | 0/11 | `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r10_chaos_mixed_e2ee.rs`, `tests/sync_r10_chaos_truncation.rs` 等 4 个 |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_with_conflict_guard` | method | 0/9 | `tests/sync_r10_chaos_clock.rs`, `tests/sync_r11_history.rs`, `tests/sync_r12_conflict_fast_path.rs` |
| `dstu_sync::data_governance::sync::history::rollback_batch` | fn | 0/6 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::SyncManager::with_encryption` | method | 0/4 | `tests/sync_r10_chaos_mixed_e2ee.rs` |
| `dstu_sync::data_governance::sync::tombstone::validate_tombstone_timestamp` | fn | 0/4 | `tests/sync_r10_chaos_clock.rs` |
| `dstu_sync::data_governance::sync::SyncChangesPayload` | struct | 0/3 | `tests/sync_r10_chaos_mixed_e2ee.rs`, `tests/sync_r12_record_path_names.rs` |
| `dstu_sync::data_governance::sync::SyncManager::get_pending_changes` | method | 0/3 | `tests/sync_r10_chaos_idempotent.rs`, `tests/sync_r13_migration_change_log_propagation.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict` | fn | 0/2 | `tests/sync_r11_history.rs`, `tests/sync_r12_conflict_fast_path.rs` |
| `dstu_sync::data_governance::sync::SyncManifest` | struct | 0/2 | `tests/sync_r12_record_path_names.rs` |
| `dstu_sync::data_governance::sync::SyncTransactionStatus` | enum | 0/2 | `tests/sync_r12_record_path_names.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_sync_snapshot_batches` | fn | 0/1 | `tests/sync_r11_history.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_rollback_sync_snapshot_batch` | fn | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::ApplyChangesResult` | struct | 0/1 | `tests/sync_r10_chaos_clock.rs` |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictAwareApplyResult` | struct | 0/1 | `tests/sync_r10_chaos_clock.rs` |
| `dstu_sync::data_governance::sync::DatabaseSyncState` | struct | 0/1 | `tests/sync_r12_record_path_names.rs` |
| `dstu_sync::data_governance::sync::history::DEFAULT_MAX_BATCHES` | const | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::new_batch_id` | fn | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::prune_batches_to_cap` | fn | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::REASON_CONFLICT_RESOLVE` | const | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::REASON_POLICY_OVERRIDE` | const | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::REASON_ROLLBACK_UNDO` | const | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::history::snapshot_record_with_data` | fn | 0/1 | `tests/sync_r11_history.rs` |
| `dstu_sync::data_governance::sync::SyncError` | enum | 0/1 | `tests/sync_r10_chaos_clock.rs` |

## glob 导入（模块级，不确定具体条目）

- 导入 L16-anki：`use deep_student_lib::cmd::anki_cards::*` @ `src/commands.rs:46`
- 导入 L16-anki：`use deep_student_lib::cmd::anki_connect::*` @ `src/commands.rs:47`
- 导入 L16-anki：`use deep_student_lib::cmd::enhanced_anki::*` @ `src/commands.rs:48`
- 导入 L19-mcp-browser：`use deep_student_lib::cmd::mcp::*` @ `src/commands.rs:49`
- 导入 L10-notes：`use deep_student_lib::cmd::notes::*` @ `src/commands.rs:50`
- 导入 L18-media-docs：`use deep_student_lib::cmd::ocr::*` @ `src/commands.rs:51`
- 导入 L18-media-docs：`use deep_student_lib::cmd::textbooks::*` @ `src/commands.rs:52`
- 导入 L02-llm-manager：`use deep_student_lib::cmd::translation::*` @ `src/commands.rs:53`
- 导入 L19-mcp-browser：`use deep_student_lib::cmd::web_search::*` @ `src/commands.rs:54`
- 导入 F2-shell：`use deep_student_lib::cmd::window_effects::*` @ `src/commands.rs:55`
