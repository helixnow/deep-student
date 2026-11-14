# 跨 lane 服务草稿索引

> 生成文件（`node scripts/electron-migration/services-draft.mjs`）。每个 lane 被其他 lane 生产代码引用最多的条目——
> 这些是关键路径服务：提供方应最先冻结其接口。

| 提供方 lane | 被引用条目 | 生产引用点 | 消费方 lane 数 | 生产引用最多的条目（引用点） |
|---|---|---|---|---|
| [F1-kernel](DRAFT-F1-kernel.md) | 39 | 878 | 18 | `executor::ToolSensitivity` (650)<br>`executor::ToolConcurrency` (93)<br>`extensions::qbank_state` (18)<br>`disposer::Disposer` (17)<br>`slot::SlotOccupied` (13) |
| [F2-shell](DRAFT-F2-shell.md) | 4 | 6 | 3 | `startup_gate::STARTUP_READY_WAIT` (2)<br>`startup_gate::wait_startup_ready` (2)<br>`apk_installer::ApkInstallerHandle` (1)<br>`deep_student_lib::load_mcp_config_from_db` (1) |
| [F3-storage](DRAFT-F3-storage.md) | 174 | 1137 | 25 | `database::Database` (363)<br>`schema_registry::DatabaseId` (58)<br>`DatabaseId::all_ordered` (52)<br>`audit::AuditOperation` (46)<br>`AuditLog::new` (35) |
| [F4-security](DRAFT-F4-security.md) | 352 | 7500 | 25 | `AppError::database` (1038)<br>`AppError::validation` (971)<br>`models::AppError` (786)<br>`AppError::file_system` (389)<br>`llm_config::ApiConfig` (296) |
| [L01-llm-providers](DRAFT-L01-llm-providers.md) | 54 | 177 | 9 | `providers::StreamEvent` (35)<br>`providers::ProviderAdapter` (25)<br>`types::OcrEngineType` (13)<br>`types::MultimodalInput` (10)<br>`types::OcrTaskType` (7) |
| [L02-llm-manager](DRAFT-L02-llm-manager.md) | 106 | 392 | 18 | `llm_manager::LLMManager` (175)<br>`types::GradingMode` (12)<br>`llm_manager::OcrModelConfig` (12)<br>`llm_manager::ImagePayload` (10)<br>`llm_manager::OcrRuntimeCandidate` (7) |
| [L03-chat-pipeline](DRAFT-L03-chat-pipeline.md) | 29 | 58 | 8 | `pipeline::ChatV2Pipeline` (22)<br>`helpers::MicrocompactAnchor` (7)<br>`context::citation_ledger_for_reply` (4)<br>`context::PipelineContext` (3)<br>`finalizer::DeclaredArtifact` (2) |
| [L04-chat-session](DRAFT-L04-chat-session.md) | 265 | 1851 | 17 | `executor::ExecutionContext` (530)<br>`error::ChatV2Error` (192)<br>`database::ChatV2Database` (107)<br>`executor::ToolExecutor` (80)<br>`error::ChatV2Result` (52) |
| [L05-agent-workspace](DRAFT-L05-agent-workspace.md) | 154 | 472 | 15 | `coordinator::WorkspaceCoordinator` (89)<br>`types::AgentStatus` (45)<br>`subagent_task::SubagentTaskStatus` (23)<br>`types::MessageType` (21)<br>`types::AgentRole` (20) |
| [L06-agent-orchestration](DRAFT-L06-agent-orchestration.md) | 95 | 110 | 8 | `self_inspect_executor::redact_sensitive_json` (9)<br>`todo_executor::TodoStatus` (4)<br>`attempt_completion::TOOL_NAME` (4)<br>`tool_names::TODO_INIT` (3)<br>`headless::HeadlessSessionTurn` (3) |
| [L07-agent-skills-ptc](DRAFT-L07-agent-skills-ptc.md) | 72 | 93 | 10 | `workbench_bridge::uncertain_apply_receipt` (8)<br>`workbench_bridge::acr_bridge_call` (5)<br>`skills_executor::SkillsExecutor` (3)<br>`mcp_settings_store::read_mcp_tools_list` (3)<br>`SkillsExecutor::is_load_skills_tool` (3) |
| [L10-notes](DRAFT-L10-notes.md) | 76 | 206 | 13 | `note_repo::VfsNoteRepo` (22)<br>`VfsNoteRepo::get_note` (22)<br>`VfsNoteRepo::get_note_content` (21)<br>`VfsNoteRepo::update_note` (20)<br>`VfsNoteRepo::create_note_in_folder` (10) |
| [L11-vfs-repos](DRAFT-L11-vfs-repos.md) | 560 | 2059 | 18 | `question_repo::QuestionType` (85)<br>`question_repo::Question` (54)<br>`embedding_repo::MODALITY_TEXT` (38)<br>`question_repo::QuestionImage` (38)<br>`question_repo::QuestionFilters` (34) |
| [L12-vfs-index](DRAFT-L12-vfs-index.md) | 77 | 311 | 12 | `lance_store::VfsLanceStore` (84)<br>`pdf_processing_service::PdfProcessingService` (31)<br>`pdf_processing_service::ProcessingStage` (14)<br>`VfsLanceStore::new` (13)<br>`retrieval_planner::ActiveGenerationModel` (12) |
| [L13-vfs-api](DRAFT-L13-vfs-api.md) | 181 | 4451 | 24 | `error::VfsResult` (1439)<br>`error::VfsError` (895)<br>`database::VfsDatabase` (826)<br>`types::VfsResourceType` (139)<br>`types::VfsNote` (87) |
| [L14-qbank](DRAFT-L14-qbank.md) | 55 | 73 | 5 | `QuestionAuthoringService::new` (6)<br>`LegacyReconcileService::new` (4)<br>`question_bank_service::QuestionBankService` (3)<br>`QuestionBankManagementService::new` (3)<br>`question_bank_service::BatchResult` (3) |
| [L15-review-analytics](DRAFT-L15-review-analytics.md) | 42 | 128 | 6 | `FsrsReviewService::new` (20)<br>`fsrs_review_service::FsrsAgentReviewStateSnapshot` (15)<br>`fsrs_review_service::FsrsAgentReviewMutationOutcome` (12)<br>`MasteryService::new` (11)<br>`ReviewPlanService::new` (9) |
| [L16-anki](DRAFT-L16-anki.md) | 35 | 51 | 2 | `anki_preference_memory::SessionObservation` (7)<br>`apkg_importer_service::MAX_APKG_ARCHIVE_BYTES` (4)<br>`anki_connect_service::check_anki_connect_availability` (3)<br>`DocumentProcessingService::new` (3)<br>`EnhancedAnkiService::new` (3) |
| [L17-memory-research](DRAFT-L17-memory-research.md) | 39 | 44 | 8 | `service::MemoryService` (3)<br>`memory_executor::MemoryToolExecutor` (2)<br>`learning_overview_executor::LearningOverviewExecutor` (2)<br>`academic_search_executor::AcademicSearchExecutor` (2)<br>`knowledge_executor::KnowledgeExecutor` (2) |
| [L18-media-docs](DRAFT-L18-media-docs.md) | 57 | 106 | 12 | `DocumentParser::new` (20)<br>`page_rasterizer::PageSlice` (8)<br>`document_parser::DocumentParser` (6)<br>`pdfium_utils::PDF_PAGE_SEPARATOR` (4)<br>`document_parser::is_plain_text_code_extension` (3) |
| [L19-mcp-browser](DRAFT-L19-mcp-browser.md) | 38 | 65 | 12 | `config::McpTransportConfig` (6)<br>`tools::ToolRegistry` (5)<br>`config::McpConfig` (5)<br>`client::Content` (4)<br>`config::McpFraming` (4) |
| [L20-sync](DRAFT-L20-sync.md) | 116 | 87 | 4 | `sync::MergeStrategy` (14)<br>`sync::SyncChangeWithData` (4)<br>`sync::ChangeOperation` (3)<br>`sync::SyncManager` (2)<br>`classification::SyncCategory` (2) |
| [L21-backup-governance](DRAFT-L21-backup-governance.md) | 81 | 222 | 8 | `commands_backup::open_sync_connection` (36)<br>`commands_backup::resolve_database_path` (33)<br>`cloud_credentials::hydrate_cloud_config` (21)<br>`commands_backup::get_active_data_dir` (20)<br>`commands::check_maintenance_mode` (11) |
| [L22-app-commands](DRAFT-L22-app-commands.md) | 5 | 321 | 14 | `commands::AppState` (310)<br>`commands::LearningActivity` (5)<br>`commands::DailyActivityDetails` (3)<br>`commands::get_default_model_adapter_options` (2)<br>`commands::ActiveDatabaseKind` (1) |
| [L23-sync-providers](DRAFT-L23-sync-providers.md) | 82 | 201 | 4 | `traits::CloudStorage` (104)<br>`config::CloudStorageConfig` (21)<br>`cloud_storage::is_cloud_rate_limited` (18)<br>`cloud_storage::create_storage` (10)<br>`cloud_storage::sync_e2ee_error` (7) |
| [L24-chatanki](DRAFT-L24-chatanki.md) | 39 | 10 | 4 | `fsrs_settings_executor::FsrsSettingsExecutor` (2)<br>`template_executor::TemplateDesignerExecutor` (2)<br>`chatanki_executor::ChatAnkiToolExecutor` (2)<br>`ChatAnkiToolExecutor::new` (1)<br>`chatanki_executor::install_agent_hooks` (1) |

引用记录 18368 条（不确定 2718 条），glob 模块导入 27 条。
