// Deep Student library entry
// 提供 run() 供 bin 目标调用，以解决编译错误。
// 后续可在此处逐步引入 invoke_handler! 和实际命令函数列表。

// 声明所有子模块，以便在 crate 内可见
pub mod adapters;
pub mod anki_connect_service;
pub mod apkg_exporter_service;
pub mod backup_job_manager;
pub mod batch_operations;
pub mod cmd;
pub mod commands;
pub mod config_recovery;
pub mod crash_logger;
pub mod crypto;
pub mod database;
pub mod database_optimizations;
pub mod debug_commands;
pub mod debug_logger;

pub mod cloud_storage;
pub mod anr_watchdog; // ANR 看门狗（Android 主线程卡顿检测）
pub mod deepseek_ocr_parser;
pub mod document_parser;
pub mod document_processing_service;
pub mod enhanced_anki_service;
pub mod error_details;
pub mod error_recovery;
pub mod exam_sheet_service;
pub mod feature_flags;
pub mod file_manager;
pub mod injection_budget;
pub mod json_validator;
pub mod ocr_adapters; // OCR 适配器模块（支持多种 OCR 引擎）
pub mod ocr_circuit_breaker; // OCR 熔断器（三态：Closed/Open/HalfOpen）
pub mod pdf_ocr_service;
pub mod pdf_protocol;
pub mod pdfium_utils; // Pdfium 公共工具（库加载 + 文本提取）
pub mod question_bank_service;
pub mod question_export_service;
pub mod cross_page_merger;
pub mod figure_extractor;
pub mod llm_structurer;
pub mod page_rasterizer;
pub mod question_import_service;
pub mod vlm_grounding_service;
pub mod secure_store;
pub mod backup_common;
pub mod backup_config;
pub mod data_space;
pub mod lance_vector_store;
pub mod llm_manager;
#[cfg(feature = "mcp")]
pub mod mcp;
pub mod metrics_server;
pub mod models;
pub mod notes_exporter;
pub mod notes_manager;
pub mod package_manager;
pub mod persistent_message_queue;
pub mod providers;
pub mod reasoning_policy; // 思维链回传策略模块（文档 29 第 7 节）
pub mod services;
pub mod session_manager;
pub mod startup_cleanup;
pub mod streaming_anki_service;
pub mod textbooks_db;
pub mod tools;
pub mod vendors;
pub mod chat_v2; // Chat V2 - 新版聊天后端模块（基于 Block 架构）
pub mod dstu;
pub mod vfs; // VFS 虚拟文件系统（统一资源存储） // DSTU 访达协议层（VFS 的文件系统语义接口）
pub mod memory; // Memory-as-VFS 记忆系统（复用 VFS 基础设施）
pub mod unified_file_manager;
pub mod utils;
pub mod vector_store;
pub mod workflow_error_handler;
pub mod essay_grading;
pub mod qbank_grading;
pub mod test_utils;
pub mod translation;
pub mod tts; // 可选的系统 TTS（Web Speech API 回退方案）
pub mod llm_usage; // LLM 使用量统计模块（独立 llm_usage.db）
pub mod multimodal; // 多模态知识库模块（基于 Qwen3-VL-Embedding/Reranker）
pub mod question_sync_service;
pub mod review_plan_service; // 复习计划服务（与错题系统集成）
pub mod spaced_repetition; // SM-2 间隔重复算法 // 题目集同步冲突策略服务

// 数据治理模块（条件编译，需启用 data_governance feature）
#[cfg(feature = "data_governance")]
pub mod data_governance;

// Add required imports for AppState initialization
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
// Tokio is already in dependencies and used across the codebase
use tokio::sync::{Mutex, RwLock};
// Register Tauri plugins for dialog, opener and http
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog;
use tauri_plugin_fs;
use tauri_plugin_http;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener;
// Sentry for Rust (后端)
use sentry::ClientInitGuard;
use tracing::{debug, error, info, warn};

// 全局 AppHandle，用于在任意位置发送 Tauri 事件
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_global_app_handle(app_handle: AppHandle) {
    let _ = GLOBAL_APP_HANDLE.set(app_handle);
}

pub fn get_global_app_handle() -> Option<&'static AppHandle> {
    GLOBAL_APP_HANDLE.get()
}
// tracing 日志初始化由 tauri-plugin-log 统一管理

/// 启动 Tauri 应用。
///
/// 目前仅做最小实现，后续可补充 `invoke_handler!` 以注册命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 统一使用 tauri-plugin-log 初始化日志系统，避免与 tracing_subscriber/全局 logger 冲突

    // 初始化 Sentry（若有环境变量 SENTRY_DSN）
    let _sentry_guard: Option<ClientInitGuard> = {
        let dsn = std::env::var("SENTRY_DSN").ok();
        dsn.map(|dsn| {
            let guard = sentry::init((
                dsn,
                sentry::ClientOptions {
                    release: Some(env!("CARGO_PKG_VERSION").into()),
                    ..Default::default()
                },
            ));
            tracing::info!("sentry initialized");
            guard
        })
    };

    // 构建 Tauri 应用
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init());

    // 桌面端专用：自动更新 + 进程管理（仅 macOS/Windows/Linux）
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // 🔧 MCP 调试插件（通过 mcp-debug feature 启用）
    // 使用 hypothesi/mcp-server-tauri 桥接插件
    // 允许 AI 代理（如 Cursor）通过 MCP 协议与应用交互
    // 功能：截图、DOM 快照、IPC 监控、输入模拟、控制台日志流、JS 执行
    // 文档：https://hypothesi.github.io/mcp-server-tauri
    // 启用方式：cargo run --features mcp-debug
    #[cfg(feature = "mcp-debug")]
    {
        use tauri_plugin_mcp_bridge;
        use tracing::info;

        info!("🔧 [MCP Debug] mcp-debug feature enabled, initializing tauri-plugin-mcp-bridge");

        // hypothesi 的桥接插件使用 WebSocket 通信（默认端口 9223）
        // MCP 服务器会自动连接到这个端口
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());

        info!("🔧 [MCP Debug] tauri-plugin-mcp-bridge initialized successfully");
    }

    // 🆕 数据治理命令（2026-01-30）
    // 条件编译：仅在启用 data_governance feature 时注册
    // 功能：Schema 注册表查询、审计日志、迁移状态、健康检查、备份管理
    // 注意：直接在 invoke_handler 中注册，不使用插件方式（避免权限配置复杂性）
    #[cfg(feature = "data_governance")]
    {
        use tracing::info;
        info!("🔧 [DataGovernance] 数据治理命令将在 invoke_handler 中注册");
    }

    builder
        // 统一日志插件：落盘到各平台推荐目录；开发期也输出到 Stdout/Webview
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                // 写入各平台推荐日志目录（记录所有级别）
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("deep-student".to_string()),
                }))
                // 开发期输出到终端（过滤掉 TRACE 和 DEBUG）
                .target(Target::new(TargetKind::Stdout))
                // 开发期输出到浏览器控制台（过滤掉 TRACE 和 DEBUG）
                .target(Target::new(TargetKind::Webview))
                // 设置全局日志级别为 INFO，屏蔽掉 DEBUG 和 TRACE
                .level(log::LevelFilter::Info)
                // 特别屏蔽一些第三方库的日志
                .level_for("lance", log::LevelFilter::Warn)
                .level_for("lance_encoding", log::LevelFilter::Warn)
                .level_for("lance_io", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("h2", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                // 我们自己的模块保持 INFO 级别
                .level_for("deep_student_lib", log::LevelFilter::Info)
                .build(),
        )
        //.manage(init_app_state())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 设置全局 AppHandle，用于在任意位置发送事件
            set_global_app_handle(app_handle.clone());

            // 运行最早阶段的容错：即使系统路径解析失败，也要能够初始化崩溃日志目录，避免静默闪退
            let base_app_data_dir = app_handle
                .path()
                .app_data_dir()
                .unwrap_or_else(|e| {
                    // 回退到临时目录（记录具体错误原因）
                    let fallback = std::env::temp_dir().join("deep-student");
                    warn!(
                        "[startup] 获取应用数据目录失败: {}，使用临时目录: {}",
                        e,
                        fallback.display()
                    );
                    let _ = std::fs::create_dir_all(&fallback);
                    fallback
                });

            // 初始化崩溃日志（即使后续仍有致命错误，也能落盘）
            crate::crash_logger::init_crash_logging(base_app_data_dir.clone());

            // 启动 ANR 看门狗（所有平台，检测后端线程阻塞）
            crate::anr_watchdog::start_anr_watchdog();

            // 定期发送心跳以驱动 ANR 检测
            tauri::async_runtime::spawn(async {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
                loop {
                    interval.tick().await;
                    crate::anr_watchdog::heartbeat();
                }
            });

            if let Err(e) = std::fs::create_dir_all(&base_app_data_dir) {
                error!(
                    "[startup] 创建应用数据目录失败（将继续以降级模式运行）: {}",
                    e
                );
            }

            // Windows WebView2 稳定性：禁用 GPU 合成以规避部分 Win10 设备崩溃
            // SAFETY: std::env::set_var 在此处于应用启动的单线程初始化阶段调用，
            // 尚未创建任何工作线程，因此不存在多线程环境变量竞争的未定义行为风险。
            #[cfg(target_os = "windows")]
            {
                std::env::set_var(
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    "--disable-gpu --disable-gpu-compositing --disable-features=CalculateNativeWinOcclusion",
                );
            }
            // 始终开启 Rust backtrace，便于 crash 日志定位
            // SAFETY: 同上，单线程启动阶段调用
            std::env::set_var("RUST_BACKTRACE", "1");

            // 默认压降第三方过度详细的日志（可用 RUST_LOG 覆盖）
            if std::env::var("RUST_LOG").is_err() {
                // info 级别，且降低 lance/lancedb 噪声
                // SAFETY: 同上，单线程启动阶段调用
                std::env::set_var("RUST_LOG", "info,lance=warn,lancedb=warn,tracing=warn");
            }

            // 初始化数据空间管理器（A/B 双数据空间）并应用 pending 切换
            crate::data_space::init_data_space_manager(base_app_data_dir.clone());
            let data_space = crate::data_space::get_data_space_manager()
                .expect("DataSpaceManager not initialized");
            let active_app_data_dir = data_space.active_dir();
            if let Err(e) = std::fs::create_dir_all(&active_app_data_dir) {
                error!(
                    "[startup] 创建活动数据目录失败（将继续以降级模式运行）: {}",
                    e
                );
            }

            // 移动端兜底：将 TMP/TEMP 等变量设置到活动数据目录的 tmp/ 下，避免 Lance/Arrow 产生跨挂载点临时文件
            // SAFETY: std::env::set_var 在此处于应用启动的单线程初始化阶段调用，
            // 尚未创建 tokio/rayon 等工作线程，因此不存在多线程竞争。
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                let mobile_tmp = active_app_data_dir.join("tmp");
                let _ = std::fs::create_dir_all(&mobile_tmp);
                std::env::set_var("TMPDIR", &mobile_tmp);
                std::env::set_var("TEMP", &mobile_tmp);
                std::env::set_var("TMP", &mobile_tmp);
                std::env::set_var("ARROW_TMP_DIR", &mobile_tmp);
                std::env::set_var("LANCEDB_TMPDIR", &mobile_tmp);
            }

            // 在任何数据库初始化之前，执行启动阶段清理（若存在清理标记）
            if crate::startup_cleanup::should_purge_on_start(&base_app_data_dir) {
                match crate::startup_cleanup::purge_active_data_dir(&active_app_data_dir) {
                    Ok(report) => {
                        info!("启动阶段已执行数据清理:\n{}", report);
                        if let Err(e) = crate::startup_cleanup::clear_purge_marker(&base_app_data_dir) {
                            warn!("清除清理标记失败: {}", e);
                        }
                    }
                    Err(e) => {
                        error!("启动阶段数据清理失败: {}", e);
                        // 即使清理失败也继续启动，避免应用卡死
                    }
                }
            }

            let queue_db_path = active_app_data_dir.join("message_queue.db");

            // 初始化全局调试日志记录器
            crate::debug_logger::init_global_logger(base_app_data_dir.clone());

            // 初始化持久化消息队列（失败不致命，记录错误并继续启动）
            match crate::persistent_message_queue::init_persistent_message_queue(queue_db_path) {
                Ok(_) => {
                    info!("持久化消息队列初始化成功");
                }
                Err(e) => {
                    warn!(
                        "持久化消息队列初始化失败（将以降级模式继续运行）: {}",
                        e
                    );
                }
            }

            // 启动内置 Prometheus 指标服务
            crate::metrics_server::ensure_metrics_server(&app_handle);

            // 🆕 数据治理系统初始化（2026-01-30）
            // 条件编译：仅在启用 data_governance feature 时执行
            // 功能：迁移协调、审计日志、Schema 聚合
            #[cfg(feature = "data_governance")]
            let mut data_governance_init_failed = false;
            #[cfg(feature = "data_governance")]
            {
                use tracing::{info, warn};

                info!("🔧 [DataGovernance] 开始初始化数据治理系统...");

                // 审计健康状态（用于前端识别审计失真）
                let audit_health_state = std::sync::Arc::new(
                    crate::data_governance::commands::AuditHealthState::default(),
                );
                app.manage(audit_health_state);

                match crate::data_governance::initialize_with_report(&active_app_data_dir) {
                    Ok(result) => {
                        let report = &result.report;

                        if report.is_fully_successful() {
                            info!(
                                "✅ [DataGovernance] 初始化完成: 全局版本={}, 迁移数={}, 耗时={}ms",
                                result.registry.global_version,
                                report.migrations_applied,
                                report.total_duration_ms
                            );

                            // 迁移成功：清除之前可能持久化的错误文件
                            crate::data_governance::commands::clear_migration_error(&active_app_data_dir);

                            // 🆕 发送迁移成功事件到前端
                            let empty_warnings: Vec<String> = Vec::new();
                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": true,
                                "global_version": result.registry.global_version,
                                "migrations_applied": report.migrations_applied,
                                "duration_ms": report.total_duration_ms,
                                "warnings": empty_warnings
                            }));
                        } else {
                            // 有警告但仍可继续
                            warn!(
                                "⚠️ [DataGovernance] 初始化完成但有警告: 迁移数={}, 警告={:?}",
                                report.migrations_applied,
                                report.warnings
                            );

                            // 🆕 发送迁移警告事件到前端
                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": true,
                                "global_version": result.registry.global_version,
                                "migrations_applied": report.migrations_applied,
                                "duration_ms": report.total_duration_ms,
                                "warnings": report.warnings,
                                "has_warnings": true
                            }));
                        }

                        // 将 SchemaRegistry 注册到可变共享 State（供后续实时刷新）
                        let registry_arc =
                            std::sync::Arc::new(std::sync::RwLock::new(result.registry));
                        app.manage(registry_arc);
                        info!("✅ [DataGovernance] SchemaRegistry 已注册为 Tauri State");

                        // 将审计数据库注册到 Tauri State（供审计日志查询）
                        if let Some(audit_db) = result.audit_db {
                            let audit_db_arc = std::sync::Arc::new(audit_db);
                            app.manage(audit_db_arc);
                            info!("✅ [DataGovernance] AuditDatabase 已注册为 Tauri State");
                        } else {
                            // 即使审计数据库初始化失败，也创建一个默认的
                            warn!("⚠️ [DataGovernance] 审计数据库未初始化，创建默认实例...");
                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                // 初始化表结构
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                                info!("✅ [DataGovernance] 默认 AuditDatabase 已注册为 Tauri State");
                            } else if let Some(audit_health) = app.try_state::<std::sync::Arc<crate::data_governance::commands::AuditHealthState>>() {
                                audit_health.record_failure("审计数据库初始化失败，默认实例创建失败");
                            }
                        }
                    }
                    Err(e) => {
                        let error_msg = e.to_string();

                        let is_recovered = matches!(
                            &e,
                            crate::data_governance::DataGovernanceError::Migration(
                                crate::data_governance::migration::MigrationError::RecoveredFromBackup { .. }
                            )
                        );

                        if is_recovered {
                            warn!(
                                "⚠️ [DataGovernance] 迁移失败已自动恢复到迁移前状态，以旧版 schema 启动: {}",
                                error_msg
                            );

                            crate::data_governance::commands::persist_migration_error(&active_app_data_dir, &error_msg);

                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": false,
                                "recovered": true,
                                "error": error_msg,
                                "message": "数据库升级失败，已自动恢复到升级前状态。部分新功能可能不可用，建议更新应用。"
                            }));

                            let coordinator = crate::data_governance::MigrationCoordinator::new(active_app_data_dir.clone());
                            match coordinator.aggregate_schema_registry() {
                                Ok(registry) => {
                                    info!(
                                        "✅ [DataGovernance] 恢复后 Schema 聚合完成: 全局版本={}",
                                        registry.global_version
                                    );
                                    let registry_arc =
                                        std::sync::Arc::new(std::sync::RwLock::new(registry));
                                    app.manage(registry_arc);
                                }
                                Err(agg_err) => {
                                    warn!(
                                        "⚠️ [DataGovernance] 恢复后 Schema 聚合失败，使用空 Registry: {}",
                                        agg_err
                                    );
                                    let empty_registry = crate::data_governance::schema_registry::SchemaRegistry::default();
                                    let registry_arc =
                                        std::sync::Arc::new(std::sync::RwLock::new(empty_registry));
                                    app.manage(registry_arc);
                                }
                            }

                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                            }
                            // data_governance_init_failed 保持 false：应用正常启动，不进入维护模式
                        } else {
                            warn!("⚠️ [DataGovernance] 初始化失败（将以降级模式继续运行）: {}", error_msg);
                            warn!(
                                error = %e,
                                "数据治理系统初始化失败，应用将以降级模式继续运行"
                            );
                            data_governance_init_failed = true;

                            crate::data_governance::commands::persist_migration_error(&active_app_data_dir, &error_msg);

                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": false,
                                "error": error_msg,
                                "degraded_mode": true
                            }));

                            let empty_registry = crate::data_governance::schema_registry::SchemaRegistry::default();
                            let registry_arc =
                                std::sync::Arc::new(std::sync::RwLock::new(empty_registry));
                            app.manage(registry_arc);
                            warn!("⚠️ [DataGovernance] 已注册空的 SchemaRegistry（降级模式）");

                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                                info!("✅ [DataGovernance] 默认 AuditDatabase 已注册为 Tauri State");
                            } else if let Some(audit_health) = app.try_state::<std::sync::Arc<crate::data_governance::commands::AuditHealthState>>() {
                                audit_health.record_failure("审计数据库初始化失败，默认实例创建失败");
                            }
                        }
                    }
                }
            }

            // 构建并注册全局 AppState（使用当前活动的数据空间目录）
            let state = build_app_state(active_app_data_dir.clone(), app_handle.clone());
            app.manage(state);


            // 数据治理初始化失败时进入维护模式，阻断写入路径
            #[cfg(feature = "data_governance")]
            {
                if data_governance_init_failed {
                    let app_state: tauri::State<crate::commands::AppState> = app.state();
                    if let Err(e) = app_state.database.enter_maintenance_mode() {
                        tracing::warn!(error = %e, "数据治理初始化失败后进入维护模式失败");
                    } else {
                        tracing::warn!("⚠️ [DataGovernance] 初始化失败后已进入维护模式");
                    }
                }
            }

            // 在 Tokio 运行时中启动消息处理器并注册处理器
            // Retrieve the application state and clone the database from it
            let app_state: tauri::State<crate::commands::AppState> = app.state();
            let database = app_state.inner().database.clone();
            // 兼容命令注入：部分命令直接请求 `State<Arc<Database>>`（例如 schedule_memory_internalization）
            // 需要显式将 `Arc<Database>` 注入到 Tauri 状态中，否则会提示 `.manage()` 缺失
            app.manage(database.clone());

            // 🆕 注册 BackupJobManagerState 为 Tauri State（单例模式）
            // 所有备份相关命令都应通过 State 注入获取管理器实例
            #[cfg(feature = "data_governance")]
            {
                use tracing::info;
                use crate::backup_job_manager::BackupJobManagerState;

                let backup_job_manager_state = BackupJobManagerState::new(app_handle.clone());

                // 检查是否有可恢复的备份任务
                if let Ok(resumable) = backup_job_manager_state.inner().list_resumable_jobs() {
                    if !resumable.is_empty() {
                        info!(
                            "🔄 [Backup] 发现 {} 个可恢复的备份任务",
                            resumable.len()
                        );
                        // 发送事件通知前端有可恢复的任务
                        let _ = app_handle.emit("backup-jobs-resumable", &resumable);
                    }
                }
                // 清理已完成任务的持久化文件
                let _ = backup_job_manager_state.inner().cleanup_finished_persisted_jobs();

                // 注册为 Tauri State
                app.manage(backup_job_manager_state);
                info!("✅ [Backup] BackupJobManagerState 已注册为 Tauri State（单例模式）");
            }

            // 初始化 Chat V2（使用统一初始化函数）
            match crate::chat_v2::init_chat_v2(&active_app_data_dir) {
                Ok(chat_v2_db) => {
                    info!("✅ Chat V2 统一初始化完成: {}", chat_v2_db.db_path().display());
                    let chat_v2_db_arc = std::sync::Arc::new(chat_v2_db);
                    app.manage(chat_v2_db_arc.clone());

                    // 🆕 先初始化 ApprovalManager（用于敏感工具审批，文档 29 P1-3）
                    // 必须在 Pipeline 之前创建，以便 Pipeline 关联
                    let approval_manager = std::sync::Arc::new(crate::chat_v2::approval_manager::ApprovalManager::new());
                    app.manage(approval_manager.clone());
                    info!("✅ Chat V2 ApprovalManager 初始化成功");

                    // 🔧 P0 修复：先初始化 WorkspaceCoordinator，再传入 Pipeline
                    // 这样 Pipeline 才能注册 WorkspaceToolExecutor 和 SubagentExecutor
                    let workspaces_dir = active_app_data_dir.join("workspaces");
                    std::fs::create_dir_all(&workspaces_dir).ok();
                    let workspace_coordinator = std::sync::Arc::new(
                        crate::chat_v2::workspace::WorkspaceCoordinator::new(workspaces_dir)
                            .with_chat_v2_db(chat_v2_db_arc.clone()) // 关联主数据库以同步 workspace_index
                            .with_app_handle(app_handle.clone()) // 关联 AppHandle 以发射事件到前端
                    );
                    app.manage(workspace_coordinator.clone());
                    info!("✅ Chat V2 WorkspaceCoordinator 初始化成功");

                    let vfs_db_arc_opt = app_state.inner().vfs_db.clone();

                    // 初始化 Chat V2 Pipeline（用于消息处理流水线）
                    // 传入主数据库，让工具调用可以读取用户配置
                    // 传入 NotesManager，让 Canvas 工具可以操作笔记
                    // 🆕 传入 vfs_db，用于统一资源库（检索结果存储等）
                    // 🆕 使用 with_approval_manager 关联审批管理器（文档 29 P1-3）
                    // 🆕 使用 with_workspace_coordinator 关联工作区协调器（文档 30）
                    let chat_v2_pipeline = std::sync::Arc::new(
                        crate::chat_v2::pipeline::ChatV2Pipeline::new(
                            chat_v2_db_arc.clone(),
                            Some(database.clone()), // 主数据库，用于工具读取用户配置
                            Some(app_state.inner().anki_database.clone()), // Anki 数据库，用于制卡进度查询
                            vfs_db_arc_opt.clone(), // VFS 统一资源库
                            app_state.inner().llm_manager.clone(),
                            std::sync::Arc::new(crate::tools::ToolRegistry::new_with(vec![
                                std::sync::Arc::new(crate::tools::WebSearchTool) as std::sync::Arc<dyn crate::tools::Tool>,
                            ])),
                            Some(app_state.inner().notes_manager.clone()), // NotesManager
                        )
                        .with_approval_manager(approval_manager) // 🆕 关联审批管理器
                        .with_workspace_coordinator(workspace_coordinator) // 🆕 关联工作区协调器
                        .with_pdf_processing_service(app_state.inner().pdf_processing_service.clone()) // 🆕 论文保存触发 Pipeline
                    );
                    app.manage(chat_v2_pipeline);
                    info!("✅ Chat V2 Pipeline 初始化成功（已启用敏感工具审批、工作区协作）");
                }
                Err(e) => {
                    error!("⚠️ Chat V2 数据库初始化失败（将以降级模式继续运行）: {}", e);
                    // 不阻止应用启动，但 Chat V2 功能将不可用
                }
            }

            // 初始化 LLM Usage 统计数据库
            match crate::llm_usage::LlmUsageDatabase::new(&active_app_data_dir) {
                Ok(llm_usage_db) => {
                    info!("✅ LLM Usage 数据库初始化完成: {}", llm_usage_db.db_path().display());
                    let llm_usage_db_arc = std::sync::Arc::new(llm_usage_db);
                    app.manage(llm_usage_db_arc.clone());

                    let collector = std::sync::Arc::new(crate::llm_usage::UsageCollector::new(llm_usage_db_arc));
                    app.manage(collector);
                    info!("✅ LLM Usage Collector 初始化成功");
                }
                Err(e) => {
                    error!("⚠️ LLM Usage 数据库初始化失败（统计功能将不可用）: {}", e);
                }
            }

            // 初始化 MCP 客户端（已熔断后端模式；仅当 mcp.mode=backend 时才初始化）
            #[cfg(feature = "mcp")]
            {
                let database_for_mcp = database.clone();
                let app_handle_for_mcp = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mode = database_for_mcp.get_setting("mcp.mode").ok().flatten().unwrap_or_else(|| "frontend".to_string());
                    if mode == "backend" {
                        if let Err(e) = init_mcp_client(database_for_mcp, Some(app_handle_for_mcp)).await {
                            error!("❌ MCP 客户端初始化失败: {}", e);
                        } else {
                            info!("✅ MCP 客户端初始化成功");
                        }
                    } else {
                        info!("🔧 [MCP] 后端MCP已禁用(mode={}),使用前端SDK", mode);
                    }
                });
            }


            // 启动后异步触发一次 Lance 聊天表的轻量优化（压缩合并+清理近期旧版本+索引优化）
            {
                let database_for_maint = database.clone();
                tauri::async_runtime::spawn(async move {
                    // 避免与首屏渲染争用资源，延迟一小段时间再执行后台优化
                    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                    if let Ok(store) = crate::lance_vector_store::LanceVectorStore::new(database_for_maint.clone()) {
                        let _ = store.optimize_chat_tables(Some(7), None, false).await; // 默认清理 >7 天版本
                    }
                });
            }

            // ★ 断点续导：启动时恢复中断的导入会话
            {
                let llm_mgr = app_state.inner().llm_manager.clone();
                let file_mgr = app_state.inner().file_manager.clone();
                let vfs_db_opt = app_state.inner().vfs_db.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(vfs_db) = vfs_db_opt {
                        let import_service = crate::question_import_service::QuestionImportService::new(llm_mgr, file_mgr);
                        match import_service.recover_importing_sessions(&vfs_db).await {
                            Ok(resumable) if !resumable.is_empty() => {
                                info!("[QuestionImport] {} 个可恢复的导入会话待用户操作", resumable.len());
                            }
                            Ok(_) => {}
                            Err(e) => {
                                warn!("[QuestionImport] 启动恢复检查失败: {}", e);
                            }
                        }
                    }
                });
            }

            // 自动备份定时调度器
            {
                let database_for_backup = database.clone();
                let database_manager_for_backup = app_state.inner().database_manager.clone();
                let file_manager_for_backup = app_state.inner().file_manager.clone();
                tauri::async_runtime::spawn(async move {
                    crate::backup_config::start_auto_backup_scheduler(
                        database_for_backup,
                        database_manager_for_backup,
                        file_manager_for_backup,
                    ).await;
                });
            }

            let database_for_queue = database.clone();

            let llm_for_queue = app_state.inner().llm_manager.clone();
            let app_handle_for_handlers = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::persistent_message_queue::start_message_processor().await {
                    error!("❌ 启动持久化消息队列处理器失败: {}", e);
                    return;
                }

                // 为注册处理器与恢复任务分别克隆数据库引用，避免 move 后再使用
                let db_for_handlers = database_for_queue.clone();
                if let Err(e) = crate::persistent_message_queue::register_message_handlers(
                    db_for_handlers,
                    llm_for_queue,
                    Some(app_handle_for_handlers),
                )
                .await
                {
                    error!("❌ 注册消息队列处理器失败: {}", e);
                }
            });

            // macOS 窗口圆角设置
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    // 设置 macOS 特定的窗口属性
                    #[allow(unused_unsafe)]
                    #[allow(unexpected_cfgs)] // objc::msg_send! 宏内部使用 cfg(feature = "cargo-clippy")
                    unsafe {
                        use cocoa::base::{id, YES, NO};
                        use cocoa::appkit::{NSWindowStyleMask, NSWindowTitleVisibility};
                        use objc::{msg_send, sel, sel_impl};

                        if let Ok(ns_window_raw) = window.ns_window() {
                            let ns_window = ns_window_raw as id;

                            // 使用虚拟标题栏：全尺寸内容视图，隐藏原生标题栏但保留红绿灯按钮
                            let _: () = msg_send![ns_window, setStyleMask:
                                NSWindowStyleMask::NSTitledWindowMask
                                | NSWindowStyleMask::NSClosableWindowMask
                                | NSWindowStyleMask::NSMiniaturizableWindowMask
                                | NSWindowStyleMask::NSResizableWindowMask
                                | NSWindowStyleMask::NSFullSizeContentViewWindowMask
                            ];

                            // 使用透明标题栏
                            let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];
                            let _: () = msg_send![ns_window, setTitleVisibility: NSWindowTitleVisibility::NSWindowTitleHidden];

                            // 仅允许标注的区域拖拽：关闭整窗背景拖拽，避免任意区域拖动窗口
                            let _: () = msg_send![ns_window, setMovableByWindowBackground: NO];
                        } else {
                            warn!("获取 macOS NSWindow 失败，跳过窗口样式设置");
                        }
                    }
                }
            }

            Ok(())
        })
        // Provide ChatV2State for Chat V2 stream management (Arc wrapped for spawn usage)
        .manage(std::sync::Arc::new(crate::chat_v2::ChatV2State::new()))
        // NOTE: ChatV2Pipeline is now initialized in setup() closure after AppState is available
        .invoke_handler(tauri::generate_handler![
            // =================================================
            // commands.rs
            // =================================================
            crate::pdfium_utils::test_pdfium_status,
            crate::commands::get_app_version,
            crate::commands::get_app_data_dir,
            crate::commands::process_pdf_ocr,
            crate::commands::init_pdf_ocr_session, // 🎯
            crate::commands::upload_pdf_ocr_page, // 🎯
            crate::commands::cancel_pdf_ocr_session,
            crate::commands::pause_pdf_ocr_session,
            crate::commands::resume_pdf_ocr_session,
            crate::commands::skip_pdf_ocr_page,
            // 🚀 后端驱动的 PDF OCR（高性能）
            crate::commands::start_pdf_ocr_backend,
            crate::commands::get_pdf_ocr_temp_dir,
            crate::commands::save_pdf_to_temp,
            crate::commands::list_exam_sheet_sessions,
            crate::commands::get_exam_sheet_session_detail,
            crate::commands::update_exam_sheet_cards,
            crate::commands::rename_exam_sheet_session,
            crate::commands::inspect_pdf_text_for_qbank,
            crate::commands::import_question_bank,
            crate::commands::import_question_bank_stream,
            // 断点续导
            crate::commands::resume_question_import,
            crate::commands::list_importing_sessions,
            // 题目集原始图片管理
            crate::commands::qbank_get_source_images,
            crate::commands::qbank_crop_source_image,
            crate::commands::qbank_remove_question_image,
            // CSV 导入导出命令
            crate::commands::import_questions_csv,
            crate::commands::export_questions_csv,
            crate::commands::get_csv_preview,
            crate::commands::get_csv_exportable_fields,
            crate::commands::pin_images,
            crate::commands::unpin_images,

            crate::commands::get_enhanced_statistics,

            // 通用设置保存/读取命令
            crate::commands::save_setting,
            crate::commands::get_setting,
            crate::commands::delete_setting,
            crate::commands::get_settings_by_prefix,
            crate::commands::delete_settings_by_prefix,
            crate::commands::get_security_status,
            crate::commands::get_cn_whitelist_config,
            crate::commands::detect_tool_conflicts,
            crate::commands::get_tools_namespace_config,
            crate::commands::get_provider_strategies_config,
            crate::commands::save_provider_strategies_config,
            crate::commands::get_feature_flags,
            crate::commands::update_feature_flag,
            crate::commands::is_feature_enabled,
            crate::commands::get_injection_budget_config,
            crate::commands::simulate_budget_allocation,
            crate::commands::test_search_engine,
            crate::commands::get_image_as_base64,
            crate::commands::get_api_configurations,
            crate::commands::save_api_configurations,
            crate::commands::get_model_assignments,
            crate::commands::save_model_assignments,
            crate::commands::get_vendor_configs,
            crate::commands::save_vendor_configs,
            crate::commands::get_model_profiles,
            crate::commands::save_model_profiles,
            crate::commands::test_api_connection,

            crate::commands::get_model_adapter_options,
            crate::commands::save_model_adapter_options,
            crate::commands::reset_model_adapter_options,
            crate::commands::estimate_tokens,
            // OCR 引擎配置命令
            crate::commands::get_ocr_engines,
            crate::commands::get_ocr_engine_type,
            crate::commands::set_ocr_engine_type,
            crate::commands::infer_ocr_engine_from_model,
            crate::commands::validate_ocr_model,
            crate::commands::get_ocr_prompt_template,
            crate::commands::get_available_ocr_models,
            crate::commands::save_available_ocr_models,
            crate::commands::test_ocr_engine,
            crate::commands::update_ocr_engine_priority,
            crate::commands::add_ocr_engine,
            crate::commands::remove_ocr_engine,
            // Lance 向量表优化命令
            crate::commands::optimize_chat_embeddings_table,
            crate::commands::create_performance_indexes,
            crate::commands::analyze_query_performance,

            crate::commands::clear_message_embeddings,
            crate::commands::generate_anki_cards_from_document,
            crate::commands::generate_anki_cards_from_document_file,
            crate::commands::generate_anki_cards_from_document_base64,
            crate::commands::call_llm_for_boundary, // CardForge 2.0 - LLM 定界
            crate::commands::check_anki_connect_status,
            crate::commands::get_anki_deck_names,
            crate::commands::get_anki_model_names,
            crate::commands::create_anki_deck,
            crate::commands::save_anki_cards,
            crate::commands::add_cards_to_anki_connect,
            crate::commands::import_anki_package,
            crate::commands::export_cards_as_apkg,
            crate::commands::export_cards_as_apkg_with_template,
            crate::cmd::anki_connect::export_multi_template_apkg,
            // 🔧 P0-30 修复：注册批量导出命令
            crate::commands::batch_export_cards,
            crate::commands::save_json_file,
            crate::commands::start_enhanced_document_processing,
            crate::commands::pause_document_processing,
            crate::commands::resume_document_processing,
            crate::commands::get_document_processing_state,
            crate::commands::get_document_task_counts,
            crate::commands::trigger_task_processing,
            crate::commands::get_document_tasks,
            crate::commands::get_task_cards,
            crate::commands::update_anki_card,
            crate::commands::delete_anki_card,
            crate::commands::delete_document_task,
            crate::commands::delete_document_session,
            crate::commands::export_apkg_for_selection,
            crate::commands::get_document_cards,
            crate::commands::list_anki_library_cards,
            crate::commands::export_anki_cards,
            crate::cmd::enhanced_anki::recover_stuck_document_tasks,
            crate::cmd::enhanced_anki::list_document_sessions,
            crate::cmd::enhanced_anki::get_anki_stats,
            // 状态恢复相关命令
            crate::commands::get_recent_document_tasks,
            crate::commands::get_all_recent_cards,
            crate::commands::get_pending_memory_candidates,
            crate::commands::dismiss_pending_memory_candidates,
            crate::commands::mark_pending_memory_candidates_saved,
            crate::commands::parse_document_from_path,
            crate::commands::parse_document_from_base64,
            // Translation Commands
            crate::translation::translate_text_stream,
            crate::commands::ocr_extract_text,
            // Essay Grading Commands
            crate::essay_grading::essay_grading_stream,
            crate::essay_grading::essay_grading_create_session,
            crate::essay_grading::essay_grading_get_session,
            crate::essay_grading::essay_grading_update_session,
            crate::essay_grading::essay_grading_delete_session,
            crate::essay_grading::essay_grading_list_sessions,
            crate::essay_grading::essay_grading_toggle_favorite,
            crate::essay_grading::essay_grading_get_rounds,
            crate::essay_grading::essay_grading_get_round,
            crate::essay_grading::essay_grading_get_latest_round_number,
            crate::essay_grading::essay_grading_get_modes,
            crate::essay_grading::essay_grading_get_mode,
            crate::essay_grading::essay_grading_get_models,
            // 自定义批阅模式 CRUD
            crate::essay_grading::essay_grading_create_custom_mode,
            crate::essay_grading::essay_grading_update_custom_mode,
            crate::essay_grading::essay_grading_delete_custom_mode,
            crate::essay_grading::essay_grading_list_custom_modes,
            crate::essay_grading::essay_grading_save_builtin_override,
            crate::essay_grading::essay_grading_reset_builtin_mode,
            crate::essay_grading::essay_grading_has_builtin_override,
            // Qbank AI Grading Commands
            crate::qbank_grading::qbank_ai_grade,
            crate::qbank_grading::qbank_cancel_grading,
            // TTS Commands (optional fallback for Web Speech API)
            crate::tts::tts_check_available,
            crate::tts::tts_speak,
            crate::tts::tts_stop,
            crate::commands::read_file_text,
            crate::commands::get_file_size,
            crate::commands::hash_file,
            crate::commands::read_file_bytes,
            crate::commands::copy_file,
            crate::commands::save_text_to_file,
            crate::commands::get_all_custom_templates,
            crate::commands::get_custom_template_by_id,
            crate::commands::create_custom_template,
            crate::commands::update_custom_template,
            crate::commands::delete_custom_template,
            crate::commands::export_template,
            crate::commands::import_template,
            crate::commands::import_custom_templates_bulk,
            crate::commands::import_builtin_templates,
            crate::commands::set_default_template,
            crate::commands::get_default_template_id,
            crate::commands::save_test_log,
            crate::commands::get_test_logs,
            crate::commands::open_log_file,
            crate::commands::open_logs_folder,
            crate::commands::report_frontend_log,
            crate::commands::save_template_debug_data,
            crate::commands::export_unified_backup_data,
            // 备份配置
            crate::backup_config::get_backup_config,
            crate::backup_config::set_backup_config,
            crate::backup_config::pick_backup_directory,
            crate::backup_config::clear_backup_directory,
            crate::backup_config::get_default_backup_directory,
            // Cloud storage (unified WebDAV + S3 interface)
            crate::cloud_storage::cloud_storage_check_connection,
            crate::cloud_storage::cloud_storage_put,
            crate::cloud_storage::cloud_storage_get,
            crate::cloud_storage::cloud_storage_list,
            crate::cloud_storage::cloud_storage_delete,
            crate::cloud_storage::cloud_storage_stat,
            crate::cloud_storage::cloud_storage_exists,
            // Cloud sync manager (ZIP backup upload/download/versioning)
            crate::cloud_storage::cloud_sync_get_status,
            crate::cloud_storage::cloud_sync_list_versions,
            crate::cloud_storage::cloud_sync_upload,
            crate::cloud_storage::cloud_sync_download,
            crate::cloud_storage::cloud_sync_delete_version,
            crate::cloud_storage::cloud_sync_get_device_id,
            crate::cloud_storage::cloud_storage_is_s3_enabled,
            // Secure storage (cross-platform credential storage)
            crate::secure_store::secure_save_cloud_credentials,
            crate::secure_store::secure_get_cloud_credentials,
            crate::secure_store::secure_delete_cloud_credentials,
            crate::secure_store::secure_store_is_available,
            // AnkiConnect compatibility
            crate::commands::anki_get_deck_names,
            // =================================================
            // config_recovery.rs
            // =================================================
            crate::config_recovery::restore_default_api_configs,
            crate::config_recovery::check_api_config_status,
            // =================================================
            // debug_logger.rs
            // =================================================
            crate::debug_logger::write_debug_logs,
            // =================================================
            // debug_commands.rs - 调试专用直接数据库访问
            crate::debug_commands::debug_get_database_stats,
            crate::debug_commands::log_debug_message,
            crate::debug_commands::debug_vfs_migration_status,
            crate::debug_commands::debug_vfs_textbook_pages,
            // =================================================
            // Vector Index Management
            // =================================================
            crate::commands::optimize_lance_database,
            crate::commands::cancel_stream,
            // MCP 相关命令
            crate::commands::get_mcp_status,
            crate::commands::get_mcp_tools,
            crate::commands::test_mcp_connection,
            crate::commands::test_mcp_websocket,
            crate::commands::test_mcp_sse,
            crate::commands::test_mcp_http,
            crate::commands::mcp_stdio_start,
            crate::commands::mcp_stdio_send,
            crate::commands::mcp_stdio_close,
            crate::commands::save_mcp_config,
            crate::commands::reload_mcp_client,
            crate::commands::get_mcp_config,
            crate::commands::import_mcp_config,
            crate::commands::export_mcp_config,
            crate::commands::test_all_search_engines

            // =============== Notes (isolated) ===============
            ,crate::commands::notes_list,
            crate::commands::notes_list_meta,
            crate::commands::notes_create,
            crate::commands::notes_update,
            crate::commands::notes_set_favorite,
            crate::commands::notes_delete,
            crate::commands::notes_get,
            crate::commands::notes_save_asset
            ,crate::commands::notes_list_assets
            ,crate::commands::notes_delete_asset
            ,crate::commands::notes_resolve_asset_path
            ,crate::commands::notes_restore
            ,crate::commands::notes_assets_index_scan
            ,crate::commands::notes_assets_scan_orphans
            ,crate::commands::notes_assets_bulk_delete
            ,crate::commands::notes_list_advanced
            ,crate::commands::notes_get_subject_rag_config
            ,crate::commands::notes_update_subject_rag_config
            ,crate::commands::notes_set_pref
            ,crate::commands::notes_get_pref
            ,crate::commands::notes_export
            ,crate::commands::notes_export_single
            ,crate::commands::notes_import
            ,crate::commands::notes_db_stats
            ,crate::commands::notes_db_vacuum
            ,crate::commands::notes_list_tags
            ,crate::commands::notes_search
            ,crate::commands::notes_mentions_search
            ,crate::commands::rag_rebuild_fts_index
            ,crate::commands::notes_rag_rebuild_fts_index
            ,crate::commands::notes_hard_delete
            ,crate::commands::notes_empty_trash
            ,crate::commands::notes_list_deleted
            // Canvas AI 工具命令（智能笔记）
            ,crate::commands::canvas_note_read
            ,crate::commands::canvas_note_append
            ,crate::commands::canvas_note_replace
            ,crate::commands::canvas_note_set
            // DataSpace (A/B) commands
            ,crate::data_space::get_data_space_info
            ,crate::data_space::mark_data_space_pending_switch_to_inactive
            // Test Slot (C/D) commands - 用于前端全自动备份测试
            ,crate::data_space::get_test_slot_info
            ,crate::data_space::clear_test_slots
            ,crate::data_space::get_slot_directory
            ,crate::data_space::restart_app
            // Backup Test Commands - 前端全自动备份流程测试
            // Package Manager commands
            ,crate::commands::check_package_manager
            ,crate::commands::auto_install_package_manager
            ,crate::commands::check_all_package_managers
            // Test database management commands
            ,crate::commands::switch_to_test_database
            ,crate::commands::reset_test_database
            ,crate::commands::switch_to_production_database
            ,crate::commands::get_database_info
            ,crate::commands::seed_test_database
            ,crate::commands::check_test_dependencies
            ,crate::commands::set_test_run_id
            ,crate::commands::write_test_report
            // P0-27: WebView 设置备份/恢复命令
            ,crate::commands::save_webview_settings
            ,crate::commands::load_webview_settings
            // =================================================
            // Chat V2 - 新版聊天后端命令
            // =================================================
            ,crate::chat_v2::handlers::send_message::chat_v2_send_message
            ,crate::chat_v2::handlers::send_message::chat_v2_cancel_stream
            ,crate::chat_v2::handlers::send_message::chat_v2_retry_message
            ,crate::chat_v2::handlers::send_message::chat_v2_edit_and_resend
            ,crate::chat_v2::handlers::send_message::chat_v2_continue_message
            ,crate::chat_v2::handlers::load_session::chat_v2_load_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_create_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_get_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_update_session_settings
            ,crate::chat_v2::handlers::manage_session::chat_v2_archive_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_save_session
            ,crate::chat_v2::handlers::block_actions::chat_v2_delete_message
            ,crate::chat_v2::handlers::block_actions::chat_v2_copy_block_content
            ,crate::chat_v2::handlers::block_actions::chat_v2_update_block_content
            ,crate::chat_v2::handlers::block_actions::chat_v2_update_block_tool_output
            ,crate::chat_v2::handlers::block_actions::chat_v2_get_anki_cards_from_block_by_document_id
            ,crate::chat_v2::handlers::block_actions::chat_v2_upsert_streaming_block
            ,crate::chat_v2::handlers::block_actions::chat_v2_anki_cards_result
            ,crate::chat_v2::handlers::manage_session::chat_v2_list_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_list_agent_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_count_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_delete_session
            // P1-3: 清空回收站（一次性删除所有已删除会话）
            ,crate::chat_v2::handlers::manage_session::chat_v2_empty_deleted_sessions
            // P1-23: 会话软删除与恢复
            ,crate::chat_v2::handlers::manage_session::chat_v2_soft_delete_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_restore_session
            // 会话分支
            ,crate::chat_v2::handlers::manage_session::chat_v2_branch_session
            // 会话分组命令
            ,crate::chat_v2::handlers::group_handlers::chat_v2_create_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_update_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_delete_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_get_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_list_groups
            ,crate::chat_v2::handlers::group_handlers::chat_v2_reorder_groups
            ,crate::chat_v2::handlers::group_handlers::chat_v2_move_session_to_group
            ,crate::chat_v2::handlers::ocr::chat_v2_perform_ocr
            // 变体管理命令
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_switch_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_delete_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_retry_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_retry_variants
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_cancel_variant
            // 工具审批命令（敏感工具用户确认）
            ,crate::chat_v2::handlers::approval_handlers::chat_v2_tool_approval_respond
            ,crate::chat_v2::handlers::approval_handlers::chat_v2_tool_approval_cancel
            // 🆕 用户提问命令（轻量级问答交互）
            ,crate::chat_v2::handlers::ask_user_handlers::chat_v2_ask_user_respond
            // Canvas 工具前端回调命令（完全前端模式）
            ,crate::chat_v2::handlers::canvas_handlers::chat_v2_canvas_edit_result
            // 数据迁移命令（旧版 chat_messages 迁移到 Chat V2）
            ,crate::chat_v2::handlers::migration::chat_v2_check_migration_status
            ,crate::chat_v2::handlers::migration::chat_v2_migrate_legacy_chat
            ,crate::chat_v2::handlers::migration::chat_v2_rollback_migration
            // 工作区命令（Agent 协作系统）
            ,crate::chat_v2::handlers::workspace_handlers::workspace_create
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get
            ,crate::chat_v2::handlers::workspace_handlers::workspace_close
            ,crate::chat_v2::handlers::workspace_handlers::workspace_delete
            ,crate::chat_v2::handlers::workspace_handlers::workspace_create_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_agents
            ,crate::chat_v2::handlers::workspace_handlers::workspace_send_message
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_messages
            ,crate::chat_v2::handlers::workspace_handlers::workspace_set_context
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get_context
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_documents
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get_document
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_all
            ,crate::chat_v2::handlers::workspace_handlers::workspace_run_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_cancel_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_manual_wake
            ,crate::chat_v2::handlers::workspace_handlers::workspace_cancel_sleep
            ,crate::chat_v2::handlers::workspace_handlers::workspace_restore_executions
            // ⚠️ DEPRECATED 资源库命令 — 前端已迁移到 VFS (vfs_* 命令)，零引用。
            // 保留注册以兼容旧版前端，计划在下一次大版本中移除。参见 P1-#9。
            ,crate::chat_v2::handlers::resource_handlers::resource_create_or_reuse
            ,crate::chat_v2::handlers::resource_handlers::resource_get
            ,crate::chat_v2::handlers::resource_handlers::resource_get_latest
            ,crate::chat_v2::handlers::resource_handlers::resource_exists
            ,crate::chat_v2::handlers::resource_handlers::resource_increment_ref
            ,crate::chat_v2::handlers::resource_handlers::resource_decrement_ref
            ,crate::chat_v2::handlers::resource_handlers::resource_get_versions_by_source
            // 🆕 Skills 文件系统命令
            ,crate::chat_v2::skills::skill_list_directories
            ,crate::chat_v2::skills::skill_read_file
            ,crate::chat_v2::skills::skill_create
            ,crate::chat_v2::skills::skill_update
            ,crate::chat_v2::skills::skill_delete
            // =================================================
            // VFS 虚拟文件系统命令
            // =================================================
            // 🆕 资源操作（已启用 - 替代独立 resources.db）
            ,crate::vfs::handlers::vfs_create_or_reuse
            ,crate::vfs::handlers::vfs_get_resource
            ,crate::vfs::handlers::vfs_resource_exists
            ,crate::vfs::handlers::vfs_increment_ref
            ,crate::vfs::handlers::vfs_decrement_ref
            // 笔记操作
            ,crate::vfs::handlers::vfs_create_note
            ,crate::vfs::handlers::vfs_update_note
            ,crate::vfs::handlers::vfs_get_note
            ,crate::vfs::handlers::vfs_get_note_content
            ,crate::vfs::handlers::vfs_list_notes
            ,crate::vfs::handlers::vfs_delete_note
            // 列表操作（供 Learning Hub 调用）
            ,crate::vfs::handlers::vfs_list_textbooks
            ,crate::vfs::handlers::vfs_list_exam_sheets
            ,crate::vfs::handlers::vfs_list_translations
            ,crate::vfs::handlers::vfs_list_essays
            ,crate::vfs::handlers::vfs_search_all
            // 路径缓存操作（文档 24 Prompt 3）
            ,crate::vfs::handlers::vfs_get_resource_path
            ,crate::vfs::handlers::vfs_update_path_cache
            // 引用模式命令（Prompt 2）
            ,crate::vfs::ref_handlers::vfs_get_resource_refs
            ,crate::vfs::ref_handlers::vfs_resolve_resource_refs
            ,crate::vfs::ref_handlers::vfs_get_resource_ref_count
            // 附件操作命令
            ,crate::vfs::handlers::vfs_upload_attachment
            ,crate::vfs::handlers::vfs_get_attachment_content
            ,crate::vfs::handlers::vfs_get_attachment
            ,crate::vfs::handlers::vfs_delete_attachment
            ,crate::vfs::handlers::vfs_get_attachment_config
            ,crate::vfs::handlers::vfs_set_attachment_root_folder
            ,crate::vfs::handlers::vfs_create_attachment_root_folder
            ,crate::vfs::handlers::vfs_get_or_create_attachment_root_folder
            // 统一文件操作命令（files 表）
            ,crate::vfs::handlers::vfs_upload_file
            ,crate::vfs::handlers::vfs_download_paper
            ,crate::vfs::handlers::vfs_get_file
            ,crate::vfs::handlers::vfs_list_files
            ,crate::vfs::handlers::vfs_delete_file
            ,crate::vfs::handlers::vfs_get_file_content
            // Blob 操作命令（整卷识别多模态改造 - 2025-12-09）
            ,crate::vfs::handlers::vfs_get_blob_base64
            // PDF 页面图片获取（支持 RAG 引用渲染 - 2026-01）
            ,crate::vfs::handlers::vfs_get_pdf_page_image
            // PDF 预处理流水线命令（2026-02）
            ,crate::vfs::handlers::vfs_get_pdf_processing_status
            ,crate::vfs::handlers::vfs_cancel_pdf_processing
            ,crate::vfs::handlers::vfs_retry_pdf_processing
            ,crate::vfs::handlers::vfs_start_pdf_processing
            ,crate::vfs::handlers::vfs_get_batch_pdf_processing_status
            ,crate::vfs::handlers::vfs_list_pending_pdf_processing
            // 媒体缓存管理命令
            ,crate::vfs::handlers::vfs_get_media_cache_stats
            ,crate::vfs::handlers::vfs_clear_media_cache
            // 整卷图片迁移命令（文档25）
            // VFS 统一知识管理命令
            ,crate::vfs::handlers::vfs_search
            ,crate::vfs::handlers::vfs_reindex_resource
            ,crate::vfs::handlers::vfs_get_index_status
            ,crate::vfs::handlers::vfs_toggle_index_disabled
            ,crate::vfs::handlers::vfs_get_embedding_stats
            ,crate::vfs::handlers::vfs_list_dimensions
            ,crate::vfs::handlers::vfs_assign_dimension_model
            ,crate::vfs::handlers::vfs_create_dimension
            ,crate::vfs::handlers::vfs_delete_dimension
            ,crate::vfs::handlers::vfs_get_preset_dimensions
            ,crate::vfs::handlers::vfs_get_dimension_range
            ,crate::vfs::handlers::vfs_set_default_embedding_dimension
            ,crate::vfs::handlers::vfs_get_default_embedding_dimension
            ,crate::vfs::handlers::vfs_clear_default_embedding_dimension
            ,crate::vfs::handlers::vfs_get_pending_resources
            ,crate::vfs::handlers::vfs_batch_index_pending
            ,crate::vfs::handlers::vfs_set_indexing_config
            ,crate::vfs::handlers::vfs_get_indexing_config
            ,crate::vfs::handlers::vfs_get_all_index_status
            // VFS 数据透视命令（OCR 查看/清除、文本块查看）
            ,crate::vfs::handlers::vfs_get_resource_ocr_info
            ,crate::vfs::handlers::vfs_clear_resource_ocr
            ,crate::vfs::handlers::vfs_get_resource_text_chunks
            // VFS RAG 向量检索命令
            ,crate::vfs::handlers::vfs_rag_search
            ,crate::vfs::handlers::vfs_get_lance_stats
            ,crate::vfs::handlers::vfs_optimize_lance
            // VFS 多模态统一管理命令（2026-01）
            ,crate::vfs::handlers::vfs_multimodal_index
            ,crate::vfs::handlers::vfs_multimodal_search
            ,crate::vfs::handlers::vfs_multimodal_stats
            ,crate::vfs::handlers::vfs_multimodal_delete
            ,crate::vfs::handlers::vfs_multimodal_index_resource
            // 知识导图操作
            ,crate::vfs::handlers::vfs_create_mindmap
            ,crate::vfs::handlers::vfs_get_mindmap
            ,crate::vfs::handlers::vfs_get_mindmap_content
            ,crate::vfs::handlers::vfs_get_mindmap_versions
            ,crate::vfs::handlers::vfs_get_mindmap_version_content
            ,crate::vfs::handlers::vfs_get_mindmap_version
            ,crate::vfs::handlers::vfs_update_mindmap
            ,crate::vfs::handlers::vfs_delete_mindmap
            ,crate::vfs::handlers::vfs_list_mindmaps
            ,crate::vfs::handlers::vfs_set_mindmap_favorite
            // 索引诊断命令
            ,crate::vfs::handlers::vfs_debug_index_status
            ,crate::vfs::handlers::vfs_reset_disabled_to_pending
            ,crate::vfs::handlers::vfs_reset_indexed_without_embeddings
            ,crate::vfs::handlers::vfs_reset_all_index_state
            ,crate::vfs::handlers::vfs_diagnose_lance_schema
            // =================================================
            // LLM Usage 统计命令
            // =================================================
            ,crate::llm_usage::handlers::llm_usage_get_trends
            ,crate::llm_usage::handlers::llm_usage_by_model
            ,crate::llm_usage::handlers::llm_usage_by_caller
            ,crate::llm_usage::handlers::llm_usage_summary
            ,crate::llm_usage::handlers::llm_usage_recent
            ,crate::llm_usage::handlers::llm_usage_daily
            ,crate::llm_usage::handlers::llm_usage_cleanup
            // =================================================
            // DSTU 访达协议层命令
            // =================================================
            ,crate::dstu::handlers::dstu_list
            ,crate::dstu::handlers::dstu_get
            ,crate::dstu::handlers::dstu_create
            ,crate::dstu::handlers::dstu_update
            ,crate::dstu::handlers::dstu_delete
            ,crate::dstu::handlers::dstu_restore
            ,crate::dstu::handlers::dstu_purge
            ,crate::dstu::handlers::dstu_set_favorite
            ,crate::dstu::handlers::dstu_list_deleted
            ,crate::dstu::handlers::dstu_purge_all
            ,crate::dstu::handlers::dstu_move
            ,crate::dstu::handlers::dstu_rename
            ,crate::dstu::handlers::dstu_copy
            ,crate::dstu::handlers::dstu_search
            ,crate::dstu::handlers::dstu_get_content
            ,crate::dstu::handlers::dstu_set_metadata
            ,crate::dstu::handlers::dstu_watch
            ,crate::dstu::handlers::dstu_unwatch
            // 批量操作命令
            ,crate::dstu::handlers::dstu_delete_many
            ,crate::dstu::handlers::dstu_restore_many
            ,crate::dstu::handlers::dstu_move_many
            // 文件夹内搜索
            ,crate::dstu::handlers::dstu_search_in_folder
            // 整卷识别多模态内容获取（文档 25 实现）
            ,crate::dstu::handlers::dstu_get_exam_content
            // =================================================
            // 契约 E: 真实路径架构命令（文档 28 Prompt 5）
            // =================================================
            // E1: 路径解析
            ,crate::dstu::handlers::dstu_parse_path
            ,crate::dstu::handlers::dstu_build_path
            // E2: 资源定位
            ,crate::dstu::handlers::dstu_get_resource_location
            ,crate::dstu::handlers::dstu_get_resource_by_path
            // E3: 移动操作
            ,crate::dstu::handlers::dstu_move_to_folder
            ,crate::dstu::handlers::dstu_batch_move
            // E4: 路径缓存
            ,crate::dstu::handlers::dstu_refresh_path_cache
            ,crate::dstu::handlers::dstu_get_path_by_id
            // E5: Subject 迁移命令
            // =================================================
            // DSTU 文件夹命令（文档 23 Prompt 3）
            // =================================================
            // D1: 文件夹管理
            ,crate::dstu::folder_handlers::dstu_folder_create
            ,crate::dstu::folder_handlers::dstu_folder_get
            ,crate::dstu::folder_handlers::dstu_folder_rename
            ,crate::dstu::folder_handlers::dstu_folder_delete
            ,crate::dstu::folder_handlers::dstu_folder_move
            ,crate::dstu::folder_handlers::dstu_folder_set_expanded
            // D2: 内容管理
            ,crate::dstu::folder_handlers::dstu_folder_add_item
            ,crate::dstu::folder_handlers::dstu_folder_remove_item
            ,crate::dstu::folder_handlers::dstu_folder_move_item
            // D3: 查询
            ,crate::dstu::folder_handlers::dstu_folder_list
            ,crate::dstu::folder_handlers::dstu_folder_get_tree
            ,crate::dstu::folder_handlers::dstu_folder_get_items
            // D4: 上下文注入专用（文档 23 Prompt 4）
            ,crate::dstu::folder_handlers::dstu_folder_get_all_resources
            // D5: 排序
            ,crate::dstu::folder_handlers::dstu_folder_reorder
            ,crate::dstu::folder_handlers::dstu_folder_reorder_items
            // D6: 面包屑导航
            ,crate::dstu::folder_handlers::dstu_folder_get_breadcrumbs
            // =================================================
            // DSTU 回收站命令
            // =================================================
            ,crate::dstu::trash_handlers::dstu_soft_delete
            ,crate::dstu::trash_handlers::dstu_trash_restore
            ,crate::dstu::trash_handlers::dstu_list_trash
            ,crate::dstu::trash_handlers::dstu_empty_trash
            ,crate::dstu::trash_handlers::dstu_permanently_delete
            // =================================================
            // 教材库命令
            // =================================================
            ,crate::cmd::textbooks::textbooks_add
            ,crate::cmd::textbooks::textbooks_update_bookmarks
            // =================================================
            // 智能题目集命令（Question Bank V2）
            // =================================================
            ,crate::commands::qbank_list_questions
            ,crate::commands::qbank_search_questions      // FTS5 全文搜索
            ,crate::commands::qbank_rebuild_fts_index     // FTS5 索引重建
            ,crate::commands::qbank_get_question
            ,crate::commands::qbank_get_question_by_card_id
            ,crate::commands::qbank_create_question
            ,crate::commands::qbank_batch_create_questions
            ,crate::commands::qbank_update_question
            ,crate::commands::qbank_batch_update_questions
            ,crate::commands::qbank_delete_question
            ,crate::commands::qbank_batch_delete_questions
            ,crate::commands::qbank_submit_answer
            ,crate::commands::qbank_toggle_favorite
            ,crate::commands::qbank_get_stats
            ,crate::commands::qbank_refresh_stats
            ,crate::commands::qbank_get_history
            ,crate::commands::qbank_get_submissions
            ,crate::commands::qbank_reset_progress
            ,crate::commands::qbank_reset_questions_progress
            // =================================================
            // 时间维度统计命令（2026-01 新增）
            // =================================================
            ,crate::commands::qbank_get_learning_trend
            ,crate::commands::qbank_get_activity_heatmap
            ,crate::commands::qbank_get_knowledge_stats
            ,crate::commands::qbank_get_knowledge_stats_with_comparison
            // =================================================
            // 练习模式扩展命令（2026-01 新增）
            // =================================================
            ,crate::commands::qbank_start_timed_practice
            ,crate::commands::qbank_generate_mock_exam
            ,crate::commands::qbank_submit_mock_exam
            ,crate::commands::qbank_get_daily_practice
            ,crate::commands::qbank_generate_paper
            ,crate::commands::qbank_get_check_in_calendar
            // =================================================
            // 学习热力图命令
            // =================================================
            ,crate::commands::get_learning_heatmap
            // =================================================
            // Memory-as-VFS 记忆系统命令
            // =================================================
            ,crate::memory::handlers::memory_get_config
            ,crate::memory::handlers::memory_set_root_folder
            ,crate::memory::handlers::memory_set_privacy_mode
            ,crate::memory::handlers::memory_create_root_folder
            ,crate::memory::handlers::memory_get_or_create_root_folder
            ,crate::memory::handlers::memory_search
            ,crate::memory::handlers::memory_read
            ,crate::memory::handlers::memory_write
            ,crate::memory::handlers::memory_list
            ,crate::memory::handlers::memory_get_tree
            // ★ 新增命令（2026-01 修复）
            ,crate::memory::handlers::memory_update_by_id
            ,crate::memory::handlers::memory_delete
            ,crate::memory::handlers::memory_write_smart
            ,crate::memory::handlers::memory_set_auto_create_subfolders
            ,crate::memory::handlers::memory_set_default_category
            ,crate::memory::handlers::memory_export_all
            // =================================================
            // 复习计划与间隔重复系统（SM-2 算法）
            // =================================================
            ,crate::review_plan_service::review_plan_create
            ,crate::review_plan_service::review_plan_process
            ,crate::review_plan_service::review_plan_get_due
            ,crate::review_plan_service::review_plan_get_due_with_filter
            ,crate::review_plan_service::review_plan_get_stats
            ,crate::review_plan_service::review_plan_refresh_stats
            ,crate::review_plan_service::review_plan_get_by_question
            ,crate::review_plan_service::review_plan_get
            ,crate::review_plan_service::review_plan_suspend
            ,crate::review_plan_service::review_plan_resume
            ,crate::review_plan_service::review_plan_delete
            ,crate::review_plan_service::review_plan_get_history
            ,crate::review_plan_service::review_plan_batch_create
            ,crate::review_plan_service::review_plan_create_for_exam
            ,crate::review_plan_service::review_plan_list_by_exam
            ,crate::review_plan_service::review_plan_get_or_create
            ,crate::review_plan_service::review_plan_get_calendar_data
            // =================================================
            // 题目集同步冲突策略
            // =================================================
            ,crate::question_sync_service::qbank_sync_check
            ,crate::question_sync_service::qbank_get_sync_conflicts
            ,crate::question_sync_service::qbank_resolve_sync_conflict
            ,crate::question_sync_service::qbank_batch_resolve_conflicts
            ,crate::question_sync_service::qbank_set_sync_enabled
            ,crate::question_sync_service::qbank_update_sync_config
            // =================================================
            // 数据治理系统命令（2026-01-30）
            // 注意：data_governance 已在 default features 中启用
            // =================================================
            ,crate::data_governance::commands::data_governance_get_maintenance_status
            ,crate::data_governance::commands::data_governance_get_schema_registry
            ,crate::data_governance::commands::data_governance_get_migration_status
            ,crate::data_governance::commands::data_governance_get_database_status
            ,crate::data_governance::commands::data_governance_run_health_check
            ,crate::data_governance::commands::data_governance_get_audit_logs
            ,crate::data_governance::commands::data_governance_cleanup_audit_logs
            // 备份命令
            ,crate::data_governance::commands_backup::data_governance_run_backup
            ,crate::data_governance::commands_backup::data_governance_cancel_backup
            ,crate::data_governance::commands_backup::data_governance_get_backup_job
            ,crate::data_governance::commands_backup::data_governance_list_backup_jobs
            ,crate::data_governance::commands_backup::data_governance_get_backup_list
            ,crate::data_governance::commands_backup::data_governance_delete_backup
            ,crate::data_governance::commands_backup::data_governance_check_disk_space_for_restore
            ,crate::data_governance::commands_backup::data_governance_verify_backup
            ,crate::data_governance::commands_backup::data_governance_auto_verify_latest_backup
            ,crate::data_governance::commands_backup::data_governance_backup_tiered
            // ZIP 导出/导入命令
            ,crate::data_governance::commands_zip::data_governance_backup_and_export_zip
            ,crate::data_governance::commands_zip::data_governance_export_zip
            ,crate::data_governance::commands_zip::data_governance_import_zip
            // 恢复命令
            ,crate::data_governance::commands_restore::data_governance_restore_backup
            // 同步命令
            ,crate::data_governance::commands_sync::data_governance_get_sync_status
            ,crate::data_governance::commands_sync::data_governance_detect_conflicts
            ,crate::data_governance::commands_sync::data_governance_resolve_conflicts
            ,crate::data_governance::commands_sync::data_governance_run_sync
            ,crate::data_governance::commands_sync::data_governance_run_sync_with_progress
            ,crate::data_governance::commands_sync::data_governance_export_sync_data
            ,crate::data_governance::commands_sync::data_governance_import_sync_data
            // 任务恢复命令（断点续传支持）
            ,crate::data_governance::commands_backup::data_governance_resume_backup_job
            ,crate::data_governance::commands_backup::data_governance_list_resumable_jobs
            ,crate::data_governance::commands_backup::data_governance_cleanup_persisted_jobs
            // 资产管理命令
            ,crate::data_governance::commands_asset::data_governance_scan_assets
            ,crate::data_governance::commands_asset::data_governance_get_asset_types
            ,crate::data_governance::commands_asset::data_governance_restore_with_assets
            ,crate::data_governance::commands_asset::data_governance_verify_backup_with_assets
            ,crate::data_governance::commands::data_governance_get_migration_diagnostic_report
            ,crate::data_governance::commands::data_governance_run_slot_c_empty_db_test
            ,crate::data_governance::commands::data_governance_run_slot_d_clone_db_test
        ])
        // 注册 pdfstream:// 自定义协议，用于 PDF 流式加载（支持 HTTP Range Request）
        .register_uri_scheme_protocol("pdfstream", |ctx, request| {
            let allowed_dirs = crate::pdf_protocol::resolve_allowed_dirs(ctx.app_handle());
            match crate::pdf_protocol::handle_asset_protocol(&request, &allowed_dirs) {
                Ok(response) => response,
                Err(e) => {
                    error!("pdfstream:// 协议处理失败: {}", e);
                    tauri::http::Response::builder()
                        .status(500)
                        .header("Access-Control-Allow-Origin", "tauri://localhost")
                        .body(b"Internal Server Error".to_vec())
                        .unwrap_or_else(|_| {
                            tauri::http::Response::builder()
                                .status(500)
                                .header("Access-Control-Allow-Origin", "tauri://localhost")
                                .body(b"Internal Server Error".to_vec())
                                .unwrap_or_else(|_| {
                                    tauri::http::Response::new(b"Internal Server Error".to_vec())
                                })
                        })
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Tauri application");
}

// Helper to build the global application state
fn build_app_state(
    app_data_dir: std::path::PathBuf,
    app_handle: tauri::AppHandle,
) -> crate::commands::AppState {
    // === Core helpers ===
    let file_manager = Arc::new(
        crate::file_manager::FileManager::new(app_data_dir.clone())
            .expect("Failed to initialise FileManager"),
    );

    let db_path = file_manager.get_database_path();
    let database =
        Arc::new(crate::database::Database::new(&db_path).expect("Failed to initialise Database"));

    let database_manager = Arc::new(
        crate::database::DatabaseManager::new(&db_path)
            .expect("Failed to initialise DatabaseManager"),
    );

    // Notes/Anki: use primary database managed by data governance
    let notes_database = database.clone();
    let anki_database = database.clone();

    // ★ VFS 统一存储：核心服务依赖，初始化失败时 fail-fast，避免半初始化状态
    let vfs_db = Arc::new(
        crate::vfs::VfsDatabase::new(&app_data_dir)
            .unwrap_or_else(|e| panic!("Failed to initialise VFS Database: {}", e)),
    );
    app_handle.manage(vfs_db.clone());

    // ★ VfsLanceStore：非核心，可降级
    match crate::vfs::VfsLanceStore::new(vfs_db.clone()) {
        Ok(store) => {
            app_handle.manage(std::sync::Arc::new(store));
        }
        Err(e) => {
            log::error!("[AppState] VfsLanceStore init failed, degrading: {}", e);
        }
    }

    let llm_manager = Arc::new(
        crate::llm_manager::LLMManager::new(database.clone(), file_manager.clone())
            .expect("Failed to initialise LLMManager"),
    );
    app_handle.manage(llm_manager.clone());
    let exam_sheet_service = Arc::new(
        crate::exam_sheet_service::ExamSheetService::new(
            database.clone(),
            file_manager.clone(),
            vfs_db.clone(),
        )
        .expect("Failed to initialise ExamSheetService"),
    );
    let pdf_ocr_service = Arc::new(crate::pdf_ocr_service::PdfOcrService::new(
        file_manager.clone(),
        llm_manager.clone(),
    ));

    let crypto_service = Arc::new(
        crate::crypto::CryptoService::new(&app_data_dir)
            .expect("Failed to initialise CryptoService"),
    );

    let temp_sessions = Arc::new(Mutex::new(HashMap::new()));
    let pdf_ocr_cancellations = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::watch::Sender<bool>,
    >::new()));
    let pdf_ocr_pauses = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::watch::Sender<bool>,
    >::new()));
    let pdf_ocr_skip_pages = Arc::new(Mutex::new(HashMap::<
        String,
        std::collections::HashSet<usize>,
    >::new()));

    let notes_manager = Arc::new(
        crate::notes_manager::NotesManager::new_with_vfs(
            notes_database.clone(),
            vfs_db.clone(),
        )
        .expect("Failed to init NotesManager"),
    );

    // ★ backup_job_manager 已移至 Tauri State（BackupJobManagerState）单例模式

    // essay_grading_db 已移除，作文批改现在使用 VFS 统一存储

    // 初始化自定义批阅模式管理器（JSON 存储）
    let custom_mode_manager = crate::essay_grading::custom_modes::CustomModeManager::new(
        &file_manager.get_writable_app_data_dir(),
    );

    let question_bank_service = Some(Arc::new(
        crate::question_bank_service::QuestionBankService::new(vfs_db.clone()),
    ));

    // ★ PDF 预处理流水线服务（2026-02）
    let pdf_processing_service = Some(Arc::new(crate::vfs::PdfProcessingService::new(
        vfs_db.clone(),
        database.clone(),
        llm_manager.clone(),
        file_manager.clone(),
    )));
    // 注册 PdfProcessingService 到 Tauri 状态（供 vfs_get_pdf_processing_status 等命令使用）
    if let Some(ref pps) = pdf_processing_service {
        app_handle.manage(pps.clone());

        match pps.recover_stuck_tasks() {
            Ok(count) if count > 0 => {
                tracing::info!("[AppSetup] Recovered {} stuck media processing tasks", count);
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("[AppSetup] Failed to recover stuck tasks: {}", e);
            }
        }
    }

    // ★ 启动时恢复卡在 indexing 状态的索引记录（vfs_index_units + resources）
    match crate::vfs::VfsFullIndexingService::recover_stuck_indexing(&vfs_db) {
        Ok(count) if count > 0 => {
            tracing::info!("[AppSetup] Recovered {} stuck indexing records", count);
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("[AppSetup] Failed to recover stuck indexing records: {}", e);
        }
    }

    // 🔧 Phase 1: 启动时恢复卡住的 Anki 制卡任务
    match anki_database.recover_stuck_document_tasks() {
        Ok(count) if count > 0 => {
            tracing::info!("[AppSetup] Recovered {} stuck Anki document tasks", count);
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("[AppSetup] Failed to recover stuck Anki tasks: {}", e);
        }
    }

    // 设置 AppHandle 到 PdfProcessingService（供事件推送使用）
    if let Some(ref pps) = pdf_processing_service {
        let pdf_service_for_handle = pps.clone();
        let app_handle_clone = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            pdf_service_for_handle
                .set_app_handle(app_handle_clone)
                .await;
        });
    }

    crate::commands::AppState {
        database,
        database_manager,
        anki_database,
        notes_database,

        vfs_db: Some(vfs_db),
        custom_mode_manager: Some(custom_mode_manager),
        notes_manager,
        file_manager,
        exam_sheet_service,
        pdf_ocr_service,
        pdf_processing_service,
        temp_sessions,
        llm_manager,
        crypto_service,
        pdf_ocr_cancellations,
        pdf_ocr_pauses,
        pdf_ocr_sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())), // 🎯 Initialize sessions map
        pdf_ocr_skip_pages,
        app_handle,
        active_database: RwLock::new(crate::commands::ActiveDatabaseKind::Production),
        question_bank_service,
    }
}

/// 初始化 MCP 客户端
#[cfg(feature = "mcp")]
async fn init_mcp_client(
    database: Arc<crate::database::Database>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 从数据库读取 MCP 配置
    let mcp_config = load_mcp_config_from_db(&database).await?;

    // 移除全局启用开关：初始化不再受限于 mcp.enabled

    debug!("🔧 [MCP] Initializing MCP client with config: transport={:?}, performance={{ timeout_ms: {}, rate_limit: {}, cache_max_size: {}, cache_ttl_ms: {} }}",
        mcp_config.transport,
        mcp_config.performance.timeout_ms,
        mcp_config.performance.rate_limit_per_second,
        mcp_config.performance.cache_max_size,
        mcp_config.performance.cache_ttl_ms
    );

    // 使用全局初始化函数
    match crate::mcp::initialize_global_mcp_client(mcp_config).await {
        Ok(()) => {
            info!("🔧 [MCP] Global MCP client initialized successfully");
            // 注册 tools/list_changed 事件以清空工具缓存
            if let Some(client) = crate::mcp::get_global_mcp_client().await {
                let app_handle_for_event = app_handle.clone();
                client.on_event(move |event| {
                    if let crate::mcp::McpEvent::ToolsChanged = event {
                        log::info!("🔧 [MCP] tools/list_changed received → clearing LLMManager MCP tool cache");
                        if let Some(handle) = &app_handle_for_event {
                            let _ = handle.emit("mcp_tools_changed", &serde_json::json!({"ts": chrono::Utc::now().to_rfc3339()}));
                        }
                    }
                }).await;
            }
            Ok(())
        }
        Err(e) => {
            error!("🔧 [MCP] Failed to initialize MCP client: {}", e);
            // 不要因为 MCP 初始化失败而阻止应用启动
            Ok(())
        }
    }
}

/// 从数据库加载 MCP 配置
#[cfg(feature = "mcp")]
pub async fn load_mcp_config_from_db(
    database: &Arc<crate::database::Database>,
) -> Result<crate::mcp::McpConfig, Box<dyn std::error::Error + Send + Sync>> {
    let mut config = crate::mcp::McpConfig::default();

    // 读取多工具配置列表
    if let Ok(Some(tools_json)) = database.get_setting("mcp.tools.list") {
        // 解析工具列表JSON
        if let Ok(tools_list) = serde_json::from_str::<Vec<serde_json::Value>>(&tools_json) {
            // 如果有工具列表，使用第一个工具作为主要连接（兼容现有单一客户端架构）
            if let Some(first_tool) = tools_list.first() {
                if let Some(transport_type) =
                    first_tool.get("transportType").and_then(|v| v.as_str())
                {
                    match transport_type {
                        "stdio" => {
                            let command = first_tool
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or("mcp-server")
                                .to_string();

                            let args: Vec<String> = match first_tool.get("args") {
                                Some(serde_json::Value::Array(items)) => items
                                    .iter()
                                    .filter_map(|value| {
                                        value.as_str().map(|s| s.trim().to_string())
                                    })
                                    .filter(|s| !s.is_empty())
                                    .collect(),
                                Some(serde_json::Value::String(s)) => s
                                    .split(',')
                                    .map(|segment| segment.trim().to_string())
                                    .filter(|segment| !segment.is_empty())
                                    .collect(),
                                _ => Vec::new(),
                            };

                            // 解析环境变量
                            let mut env = std::collections::HashMap::new();
                            if let Some(env_obj) = first_tool.get("env").and_then(|v| v.as_object())
                            {
                                for (key, value) in env_obj {
                                    if let Some(value_str) = value.as_str() {
                                        env.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            let framing = match first_tool
                                .get("framing")
                                .or_else(|| first_tool.get("framingMode"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_lowercase())
                            {
                                Some(mode)
                                    if mode == "content_length" || mode == "content-length" =>
                                {
                                    crate::mcp::McpFraming::ContentLength
                                }
                                _ => crate::mcp::McpFraming::JsonLines,
                            };

                            let working_dir = first_tool
                                .get("cwd")
                                .or_else(|| first_tool.get("workingDir"))
                                .and_then(|v| v.as_str())
                                .map(std::path::PathBuf::from);

                            config.transport = crate::mcp::McpTransportConfig::Stdio {
                                command,
                                args,
                                port: None,
                                working_dir,
                                framing,
                                env,
                            };
                        }
                        "websocket" => {
                            let url = first_tool
                                .get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ws://localhost:8080")
                                .to_string();

                            // 解析环境变量
                            let mut env = std::collections::HashMap::new();
                            if let Some(env_obj) = first_tool.get("env").and_then(|v| v.as_object())
                            {
                                for (key, value) in env_obj {
                                    if let Some(value_str) = value.as_str() {
                                        env.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport =
                                crate::mcp::McpTransportConfig::WebSocket { url, env };
                        }
                        "sse" => {
                            // 尝试多个位置查找端点URL
                            let endpoint = first_tool
                                .get("endpoint")
                                .or_else(|| first_tool.get("url"))
                                .or_else(|| {
                                    // 查找mcpServers中的URL
                                    first_tool
                                        .get("mcpServers")
                                        .and_then(|servers| servers.as_object())
                                        .and_then(|servers| {
                                            servers
                                                .values()
                                                .next()
                                                .and_then(|server| server.get("url"))
                                        })
                                })
                                .or_else(|| {
                                    first_tool.get("fetch").and_then(|fetch| fetch.get("url"))
                                })
                                .and_then(|v| v.as_str())
                                .unwrap_or("http://localhost:8080/sse")
                                .to_string();

                            debug!("🔧 [MCP] Found SSE endpoint: {}", endpoint);

                            let api_key = first_tool
                                .get("apiKey")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            // 解析额外HTTP头
                            let mut headers = std::collections::HashMap::new();
                            if let Some(headers_obj) =
                                first_tool.get("headers").and_then(|v| v.as_object())
                            {
                                for (key, value) in headers_obj {
                                    if let Some(value_str) = value.as_str() {
                                        headers.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport = crate::mcp::McpTransportConfig::SSE {
                                endpoint,
                                api_key,
                                oauth: None,
                                headers,
                            };
                        }
                        "streamable_http" => {
                            // 尝试多个位置查找URL
                            let url = first_tool
                                .get("url")
                                .or_else(|| first_tool.get("endpoint"))
                                .or_else(|| {
                                    // 查找mcpServers中的URL
                                    first_tool
                                        .get("mcpServers")
                                        .and_then(|servers| servers.as_object())
                                        .and_then(|servers| {
                                            // 获取第一个服务器的URL
                                            servers
                                                .values()
                                                .next()
                                                .and_then(|server| server.get("url"))
                                        })
                                })
                                .or_else(|| {
                                    // 查找fetch配置中的URL
                                    first_tool.get("fetch").and_then(|fetch| fetch.get("url"))
                                })
                                .and_then(|v| v.as_str())
                                .unwrap_or("http://localhost:8080/mcp")
                                .to_string();

                            debug!("🔧 [MCP] Found streamable_http URL: {}", url);

                            let api_key = first_tool
                                .get("apiKey")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            // 解析额外HTTP头
                            let mut headers = std::collections::HashMap::new();
                            if let Some(headers_obj) =
                                first_tool.get("headers").and_then(|v| v.as_object())
                            {
                                for (key, value) in headers_obj {
                                    if let Some(value_str) = value.as_str() {
                                        headers.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport = crate::mcp::McpTransportConfig::StreamableHttp {
                                url,
                                api_key,
                                oauth: None,
                                headers,
                            };
                        }
                        _ => {
                            warn!(
                                "🔧 [MCP] Unknown transport type in tool config: {}, using default",
                                transport_type
                            );
                        }
                    }
                }
            }
        }
    } else {
        // 如果没有新的工具列表，回退到旧的单一配置方式（向后兼容）
        if let Ok(Some(transport_type)) = database.get_setting("mcp.transport.type") {
            match transport_type.as_str() {
                "stdio" => {
                    let command = database
                        .get_setting("mcp.transport.command")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "mcp-server".to_string());

                    let args_str = database
                        .get_setting("mcp.transport.args")
                        .ok()
                        .flatten()
                        .unwrap_or_default();

                    let args: Vec<String> = if args_str.is_empty() {
                        vec![]
                    } else {
                        args_str.split(',').map(|s| s.trim().to_string()).collect()
                    };

                    let framing = database
                        .get_setting("mcp.transport.framing")
                        .ok()
                        .flatten()
                        .map(|s| match s.as_str() {
                            "content_length" => crate::mcp::McpFraming::ContentLength,
                            _ => crate::mcp::McpFraming::JsonLines,
                        })
                        .unwrap_or_default();

                    config.transport = crate::mcp::McpTransportConfig::Stdio {
                        command,
                        args,
                        port: None,
                        working_dir: None,
                        framing,
                        env: std::collections::HashMap::new(),
                    };
                }
                "websocket" => {
                    let url = database
                        .get_setting("mcp.transport.url")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "ws://localhost:8080".to_string());

                    config.transport = crate::mcp::McpTransportConfig::WebSocket {
                        url,
                        env: std::collections::HashMap::new(),
                    };
                }
                _ => {
                    warn!(
                        "🔧 [MCP] Unknown transport type: {}, using default",
                        transport_type
                    );
                }
            }
        }
    }

    // 读取工具配置
    if let Ok(Some(cache_ttl_str)) = database.get_setting("mcp.tools.cache_ttl_ms") {
        if let Ok(cache_ttl_ms) = cache_ttl_str.parse::<u64>() {
            config.tools.cache_ttl_ms = cache_ttl_ms;
        }
    }

    if let Ok(Some(advertise_all_str)) = database.get_setting("mcp.tools.advertise_all_tools") {
        config.tools.advertise_all_tools =
            advertise_all_str.to_lowercase() != "0" && advertise_all_str.to_lowercase() != "false";
    }

    if let Ok(Some(whitelist_str)) = database.get_setting("mcp.tools.whitelist") {
        if !whitelist_str.is_empty() {
            config.tools.whitelist = whitelist_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect();
        }
    }

    if let Ok(Some(blacklist_str)) = database.get_setting("mcp.tools.blacklist") {
        if !blacklist_str.is_empty() {
            config.tools.blacklist = blacklist_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect();
        }
    }

    // 读取性能配置
    if let Ok(Some(timeout_str)) = database.get_setting("mcp.performance.timeout_ms") {
        if let Ok(timeout_ms) = timeout_str.parse::<u64>() {
            config.performance.timeout_ms = timeout_ms;
        }
    }

    if let Ok(Some(rate_limit_str)) = database.get_setting("mcp.performance.rate_limit_per_second")
    {
        if let Ok(rate_limit) = rate_limit_str.parse::<usize>() {
            config.performance.rate_limit_per_second = rate_limit;
        }
    }
    // 新增：资源缓存大小
    if let Ok(Some(cache_max_size_str)) = database.get_setting("mcp.performance.cache_max_size") {
        if let Ok(cache_max_size) = cache_max_size_str.parse::<usize>() {
            config.performance.cache_max_size = cache_max_size;
        }
    }
    // 新增：资源缓存TTL
    if let Ok(Some(cache_ttl_ms_str)) = database.get_setting("mcp.performance.cache_ttl_ms") {
        if let Ok(cache_ttl_ms) = cache_ttl_ms_str.parse::<u64>() {
            config.performance.cache_ttl_ms = cache_ttl_ms;
        }
    }

    Ok(config)
}
