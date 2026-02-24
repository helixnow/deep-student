//! # 数据治理 Tauri 命令
//!
//! 定义数据治理系统暴露给前端的 Tauri 命令。
//!
//! ## 命令列表
//!
//! - `data_governance_get_schema_registry`: 获取 Schema 注册表
//! - `data_governance_get_audit_logs`: 获取审计日志
//! - `data_governance_get_migration_status`: 获取迁移状态
//! - `data_governance_run_health_check`: 运行健康检查
//! - `data_governance_run_backup`: 异步后台备份（带进度事件）
//! - `data_governance_backup_tiered`: 异步分层备份（带进度事件）
//! - `data_governance_backup_and_export_zip`: 一步完成备份并导出 ZIP
//! - `data_governance_export_zip`: 异步 ZIP 导出（带进度事件）
//! - `data_governance_import_zip`: 异步 ZIP 导入（带进度事件）
//! - `data_governance_restore_backup`: 异步备份恢复（带进度事件）
//! - `data_governance_cancel_backup`: 取消备份任务
//! - `data_governance_get_backup_job`: 获取备份任务状态
//! - `data_governance_list_backup_jobs`: 获取所有备份任务列表

use std::path::Path;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Manager, State};

#[cfg(feature = "data_governance")]
use super::audit::{AuditFilter, AuditLog, AuditOperation, AuditRepository, AuditStatus};
use super::migration::{get_migration_set, MigrationCoordinator};
use super::schema_registry::{DatabaseId, DatabaseStatus, SchemaRegistry};
use crate::backup_common::{log_and_skip_entry_err, BACKUP_GLOBAL_LIMITER};
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobParams,
    BackupJobPhase, BackupJobResultPayload, BackupJobStatus, BackupJobSummary, PersistedJob,
};
use crate::utils::text::safe_truncate_chars;
use super::commands_types::{
    MaintenanceStatusResponse, SchemaRegistryResponse, DatabaseStatusResponse,
    AuditLogResponse, AuditLogPagedResponse, MigrationStatusResponse,
    MigrationDatabaseStatus, HealthCheckResponse, DatabaseHealthStatus,
    DatabaseDetailResponse, MigrationRecordResponse,
};
use super::commands_backup::{get_app_data_dir, sanitize_path_for_user};

fn resolve_target_and_pending(
    id: &DatabaseId,
    current_version: u32,
    status: Option<&DatabaseStatus>,
) -> (u32, usize) {
    let migration_set = get_migration_set(id.as_str());
    let target_version = status
        .map(|s| s.max_compatible_version)
        .or_else(|| migration_set.map(|set| set.latest_version() as u32))
        .unwrap_or(0);
    let pending_count = migration_set
        .map(|set| set.pending(current_version as i32).count())
        .unwrap_or(0);
    (target_version, pending_count)
}

/// 持久化迁移错误文件名
const MIGRATION_ERROR_FILE: &str = ".last_migration_error";

/// 将真实的迁移错误持久化到文件
///
/// 迁移失败时由 lib.rs 调用，将实际的 SQL 错误信息写入文件，
/// 供后续 `get_migration_status` 和诊断报告读取。
pub fn persist_migration_error(app_data_dir: &Path, error: &str) {
    let error_file = app_data_dir.join(MIGRATION_ERROR_FILE);
    let payload = serde_json::json!({
        "error": error,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });
    if let Err(e) = std::fs::write(&error_file, payload.to_string()) {
        tracing::warn!(
            path = %error_file.display(),
            error = %e,
            "Failed to persist migration error to file"
        );
    }
}

/// 迁移成功时清除持久化的错误文件
pub fn clear_migration_error(app_data_dir: &Path) {
    let error_file = app_data_dir.join(MIGRATION_ERROR_FILE);
    if error_file.exists() {
        let _ = std::fs::remove_file(&error_file);
    }
}

/// 读取持久化的迁移错误
fn read_persisted_migration_error(app_data_dir: &Path) -> Option<(String, String)> {
    let error_file = app_data_dir.join(MIGRATION_ERROR_FILE);
    let content = std::fs::read_to_string(&error_file).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let error = parsed.get("error")?.as_str()?.to_string();
    let timestamp = parsed.get("timestamp")?.as_str()?.to_string();
    Some((error, timestamp))
}

fn get_live_app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        return Ok(state.file_manager.get_writable_app_data_dir());
    }

    get_app_data_dir(app)
}

/// 检查主数据库是否处于维护模式。
///
/// 当备份/恢复/数据迁移等数据治理操作正在进行时，
/// 同步命令不应访问数据库文件，否则会绕过维护模式造成数据不一致。
pub(super) fn check_maintenance_mode(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if state.database.is_in_maintenance_mode() {
            return Err("数据治理操作正在进行（维护模式），请稍后再试。".to_string());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditHealthSnapshot {
    pub is_healthy: bool,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

#[derive(Debug, Clone)]
struct AuditHealthError {
    message: String,
    occurred_at: String,
}

#[derive(Default)]
pub struct AuditHealthState {
    last_error: std::sync::Mutex<Option<AuditHealthError>>,
}

impl AuditHealthSnapshot {
    fn healthy() -> Self {
        Self {
            is_healthy: true,
            last_error: None,
            last_error_at: None,
        }
    }
}

impl AuditHealthState {
    pub fn record_success(&self) {
        let mut guard = self.last_error.lock().ok();
        if let Some(ref mut slot) = guard {
            **slot = None;
        }
    }

    pub fn record_failure(&self, message: impl Into<String>) {
        let mut guard = self.last_error.lock().ok();
        let Some(ref mut slot) = guard else {
            return;
        };
        **slot = Some(AuditHealthError {
            message: message.into(),
            occurred_at: chrono::Utc::now().to_rfc3339(),
        });
    }

    pub fn snapshot(&self) -> AuditHealthSnapshot {
        let guard = self.last_error.lock().ok();
        match guard.as_deref() {
            Some(Some(err)) => AuditHealthSnapshot {
                is_healthy: false,
                last_error: Some(err.message.clone()),
                last_error_at: Some(err.occurred_at.clone()),
            },
            _ => AuditHealthSnapshot::healthy(),
        }
    }
}

/// 同步命令获取全局锁的默认超时时间（60 秒）
pub(super) const SYNC_LOCK_TIMEOUT_SECS: u64 = 60;

fn refresh_schema_registry_from_dir(
    app_data_dir: &Path,
    registry_state: &Arc<RwLock<SchemaRegistry>>,
) -> Result<SchemaRegistry, String> {
    let latest_registry = super::init::get_current_schema_state(app_data_dir).map_err(|e| {
        tracing::error!(
            "[data_governance] 刷新 SchemaRegistry 失败 ({}): {}",
            app_data_dir.display(),
            e
        );
        format!(
            "刷新 SchemaRegistry 失败 ({}): {}",
            sanitize_path_for_user(app_data_dir),
            e
        )
    })?;

    let mut guard = registry_state
        .write()
        .map_err(|e| format!("写入 SchemaRegistry 状态失败: {}", e))?;
    *guard = latest_registry.clone();

    Ok(latest_registry)
}

fn refresh_schema_registry_from_live_state(
    app: &tauri::AppHandle,
    registry_state: &Arc<RwLock<SchemaRegistry>>,
) -> Result<SchemaRegistry, String> {
    let app_data_dir = get_live_app_data_dir(app)?;
    refresh_schema_registry_from_dir(&app_data_dir, registry_state)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SlotMigrationTestResponse {
    pub success: bool,
    pub report: String,
}

fn slot_c_test_dir(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.parent().unwrap_or(app_data_dir).join("slotC")
}

fn slot_d_test_dir(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.parent().unwrap_or(app_data_dir).join("slotD")
}

fn run_slot_c_empty_db_test(app_data_dir: &Path) -> SlotMigrationTestResponse {
    use std::fmt::Write;

    let slot_c_dir = slot_c_test_dir(app_data_dir);
    let mut report = String::new();
    let mut success = false;

    if slot_c_dir.exists() {
        let _ = std::fs::remove_dir_all(&slot_c_dir);
    }
    let _ = std::fs::create_dir_all(&slot_c_dir);

    let mut coordinator = MigrationCoordinator::new(slot_c_dir.clone()).with_audit_db(None);

    match coordinator.run_all() {
        Ok(migration_report) => {
            success = true;
            let _ = writeln!(
                report,
                "结果: 成功 ({}ms)",
                migration_report.total_duration_ms
            );
            for db_report in &migration_report.databases {
                let _ = writeln!(
                    report,
                    "  [{}] v{} -> v{}, 应用 {} 个迁移, {}ms",
                    db_report.id.as_str(),
                    db_report.from_version,
                    db_report.to_version,
                    db_report.applied_count,
                    db_report.duration_ms
                );
            }
        }
        Err(e) => {
            let _ = writeln!(report, "结果: 失败!");
            let _ = writeln!(report, "  ROOT CAUSE: {}", e);
        }
    }

    let _ = std::fs::remove_dir_all(&slot_c_dir);
    let _ = std::fs::create_dir_all(&slot_c_dir);

    SlotMigrationTestResponse { success, report }
}

fn run_slot_d_clone_db_test(app_data_dir: &Path) -> SlotMigrationTestResponse {
    use std::fmt::Write;

    let slot_d_dir = slot_d_test_dir(app_data_dir);
    let mut report = String::new();
    let mut success = false;

    if slot_d_dir.exists() {
        let _ = std::fs::remove_dir_all(&slot_d_dir);
    }
    let _ = std::fs::create_dir_all(&slot_d_dir);

    // 复制当前活跃插槽的数据库文件（只复制 .db 和 .db-wal，不复制大文件）
    let db_files: &[&str] = &[
        "chat_v2.db",
        "chat_v2.db-wal",
        "mistakes.db",
        "mistakes.db-wal",
        "llm_usage.db",
        "llm_usage.db-wal",
    ];
    let db_subdir_files: &[(&str, &str)] = &[("databases", "vfs.db"), ("databases", "vfs.db-wal")];

    let mut copy_errors: Vec<String> = Vec::new();

    for file_name in db_files {
        let src = app_data_dir.join(file_name);
        if src.exists() {
            let dst = slot_d_dir.join(file_name);
            if let Err(e) = std::fs::copy(&src, &dst) {
                copy_errors.push(format!("{}: {}", file_name, e));
            }
        }
    }

    for (subdir, file_name) in db_subdir_files {
        let src = app_data_dir.join(subdir).join(file_name);
        if src.exists() {
            let dst_dir = slot_d_dir.join(subdir);
            let _ = std::fs::create_dir_all(&dst_dir);
            let dst = dst_dir.join(file_name);
            if let Err(e) = std::fs::copy(&src, &dst) {
                copy_errors.push(format!("{}/{}: {}", subdir, file_name, e));
            }
        }
    }

    if !copy_errors.is_empty() {
        let _ = writeln!(report, "复制文件时出错: {}", copy_errors.join("; "));
    }

    let mut coordinator = MigrationCoordinator::new(slot_d_dir.clone()).with_audit_db(None);

    match coordinator.run_all() {
        Ok(migration_report) => {
            success = true;
            let _ = writeln!(
                report,
                "结果: 成功 ({}ms)",
                migration_report.total_duration_ms
            );
            for db_report in &migration_report.databases {
                if db_report.applied_count > 0 {
                    let _ = writeln!(
                        report,
                        "  [{}] v{} -> v{}, 应用 {} 个迁移, {}ms",
                        db_report.id.as_str(),
                        db_report.from_version,
                        db_report.to_version,
                        db_report.applied_count,
                        db_report.duration_ms
                    );
                } else {
                    let _ = writeln!(
                        report,
                        "  [{}] v{} (已是最新)",
                        db_report.id.as_str(),
                        db_report.to_version
                    );
                }
            }
        }
        Err(e) => {
            let _ = writeln!(report, "结果: 失败!");
            let _ = writeln!(report, "  ROOT CAUSE: {}", e);
        }
    }

    let _ = std::fs::remove_dir_all(&slot_d_dir);
    let _ = std::fs::create_dir_all(&slot_d_dir);

    SlotMigrationTestResponse { success, report }
}

#[cfg(feature = "data_governance")]
pub(super) fn try_save_audit_log(app: &tauri::AppHandle, log: AuditLog) {
    // 审计失败不应阻断主流程：这里只做 best-effort 记录，并写入 tracing warn。
    let audit_health = app.try_state::<Arc<AuditHealthState>>();
    let Some(audit_db) = app.try_state::<Arc<super::audit::AuditDatabase>>() else {
        if let Some(state) = audit_health {
            state.record_failure("审计数据库未初始化");
        }
        return;
    };

    let conn = match audit_db.get_conn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[data_governance] 获取审计数据库连接失败: {}", e);
            if let Some(state) = audit_health {
                state.record_failure(format!("获取审计数据库连接失败: {}", e));
            }
            return;
        }
    };

    if let Err(e) = AuditRepository::init(&conn) {
        tracing::warn!("[data_governance] 初始化审计表失败，跳过审计记录: {}", e);
        if let Some(state) = audit_health {
            state.record_failure(format!("初始化审计表失败: {}", e));
        }
        return;
    }

    if let Err(e) = AuditRepository::save(&conn, &log) {
        tracing::warn!("[data_governance] 写入审计日志失败: {}", e);
        if let Some(state) = audit_health {
            state.record_failure(format!("写入审计日志失败: {}", e));
        }
    } else if let Some(state) = audit_health {
        state.record_success();
    }
}

/// 查询当前是否处于维护模式
///
/// 前端应用启动时调用此命令，将后端维护模式状态同步到前端 store。
/// 用于处理应用在维护模式中崩溃后重启的场景。
#[tauri::command]
pub fn data_governance_get_maintenance_status(
    app: AppHandle,
) -> Result<MaintenanceStatusResponse, String> {
    let in_maintenance = if let Some(state) = app.try_state::<crate::commands::AppState>() {
        state.database.is_in_maintenance_mode()
    } else {
        false
    };

    Ok(MaintenanceStatusResponse {
        is_in_maintenance_mode: in_maintenance,
    })
}

/// 获取 Schema 注册表
///
/// 返回所有数据库的版本状态和迁移历史。
#[tauri::command]
pub fn data_governance_get_schema_registry(
    app: AppHandle,
    registry: State<'_, Arc<RwLock<SchemaRegistry>>>,
) -> Result<SchemaRegistryResponse, String> {
    let registry = refresh_schema_registry_from_live_state(&app, registry.inner())?;

    Ok(SchemaRegistryResponse {
        global_version: registry.global_version,
        aggregated_at: registry.aggregated_at.clone(),
        databases: registry
            .databases
            .iter()
            .map(|(id, status)| DatabaseStatusResponse {
                id: id.as_str().to_string(),
                schema_version: status.schema_version,
                min_compatible_version: status.min_compatible_version,
                max_compatible_version: status.max_compatible_version,
                data_contract_version: status.data_contract_version.clone(),
                migration_count: status.migration_history.len(),
                checksum: status.checksum.clone(),
                updated_at: status.updated_at.clone(),
            })
            .collect(),
    })
}

/// 获取审计日志
///
/// 支持按操作类型、时间范围、状态过滤，支持分页。
#[tauri::command]
pub fn data_governance_get_audit_logs(
    audit_db: State<'_, Arc<super::audit::AuditDatabase>>,
    operation_type: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<AuditLogPagedResponse, String> {
    // 从审计数据库获取连接
    let conn = audit_db
        .get_conn()
        .map_err(|e| format!("获取审计数据库连接失败: {}", e))?;

    let parsed_status = match status.as_deref() {
        Some("Started") => Some(AuditStatus::Started),
        Some("Completed") => Some(AuditStatus::Completed),
        Some("Failed") => Some(AuditStatus::Failed),
        Some("Partial") => Some(AuditStatus::Partial),
        Some(other) => {
            return Err(format!(
                "无效的状态过滤值: {}。可选值: Completed, Failed, Partial",
                other
            ))
        }
        None => None,
    };

    // 构建过滤器
    let filter = AuditFilter {
        operation_type,
        status: parsed_status,
        limit: Some(limit.unwrap_or(100)),
        offset,
        ..Default::default()
    };

    // 分页查询审计日志
    let result = AuditRepository::query_paged(&conn, filter)
        .map_err(|e| format!("查询审计日志失败: {}", e))?;

    Ok(AuditLogPagedResponse {
        logs: result
            .logs
            .into_iter()
            .map(AuditLogResponse::from)
            .collect(),
        total: result.total,
    })
}

/// 清理审计日志
///
/// 支持两种清理策略：
/// - `keep_recent`: 保留最近 N 条记录，删除其余（最少保留 100 条）
/// - `before_days`: 删除 N 天之前的记录（最少保留 7 天）
///
/// 两个参数互斥，优先使用 `keep_recent`。
/// 如果都未指定，默认清理 90 天之前的记录。
///
/// ## 安全机制
///
/// - 最小保留下限：`keep_recent` 不得低于 100 条，`before_days` 不得低于 7 天
/// - 需要 `confirmation_token` 参数，格式为 `AUDIT_CLEANUP_{unix_timestamp_secs}`，
///   且时间戳必须在当前时间 60 秒内，防止被恶意脚本静默调用
/// - 每次清理操作本身也会被记录到审计日志中
///
/// ## 返回
///
/// 被删除的记录数量
#[tauri::command]
pub fn data_governance_cleanup_audit_logs(
    app: tauri::AppHandle,
    audit_db: State<'_, Arc<super::audit::AuditDatabase>>,
    keep_recent: Option<usize>,
    before_days: Option<u64>,
    confirmation_token: String,
) -> Result<u64, String> {
    // ── 安全验证：确认令牌 ──
    const TOKEN_PREFIX: &str = "AUDIT_CLEANUP_";
    const TOKEN_VALIDITY_SECS: i64 = 60;

    if !confirmation_token.starts_with(TOKEN_PREFIX) {
        return Err("审计清理令牌格式无效，需要 AUDIT_CLEANUP_{unix_timestamp}".to_string());
    }
    let ts_str = &confirmation_token[TOKEN_PREFIX.len()..];
    let token_ts: i64 = ts_str
        .parse()
        .map_err(|_| "审计清理令牌中的时间戳无效".to_string())?;
    let now_ts = chrono::Utc::now().timestamp();
    let diff = (now_ts - token_ts).abs();
    if diff > TOKEN_VALIDITY_SECS {
        return Err(format!(
            "审计清理令牌已过期（差值 {}s，允许 {}s 内）",
            diff, TOKEN_VALIDITY_SECS
        ));
    }

    // ── 安全验证：最小保留下限 ──
    const MIN_KEEP_RECENT: usize = 100;
    const MIN_BEFORE_DAYS: u64 = 7;

    if let Some(keep) = keep_recent {
        if keep < MIN_KEEP_RECENT {
            return Err(format!(
                "keep_recent 不得低于 {}，当前值: {}",
                MIN_KEEP_RECENT, keep
            ));
        }
    }
    if let Some(days) = before_days {
        if days < MIN_BEFORE_DAYS {
            return Err(format!(
                "before_days 不得低于 {} 天，当前值: {}",
                MIN_BEFORE_DAYS, days
            ));
        }
    }

    let conn = audit_db
        .get_conn()
        .map_err(|e| format!("获取审计数据库连接失败: {}", e))?;

    // ── 清理前先记录审计日志 ──
    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Maintenance {
                    action: "cleanup_audit_logs".to_string(),
                },
                "cleanup_audit_logs_initiated".to_string(),
            )
            .with_details(serde_json::json!({
                "keep_recent": keep_recent,
                "before_days": before_days,
                "confirmation_token_ts": token_ts,
            }))
            .complete(0),
        );
    }

    // 默认保留 90 天
    const DEFAULT_MAX_AGE_DAYS: u32 = 90;

    let deleted = if let Some(keep) = keep_recent {
        AuditRepository::cleanup_keep_recent(&conn, keep).map_err(|e| {
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Maintenance {
                            action: "cleanup_audit_logs".to_string(),
                        },
                        "cleanup_audit_logs".to_string(),
                    )
                    .fail(e.to_string()),
                );
            }
            format!("清理审计日志失败: {}", e)
        })?
    } else {
        let days = before_days.unwrap_or(DEFAULT_MAX_AGE_DAYS as u64);
        AuditRepository::cleanup_old_entries(&conn, days as u32).map_err(|e| {
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Maintenance {
                            action: "cleanup_audit_logs".to_string(),
                        },
                        "cleanup_audit_logs".to_string(),
                    )
                    .fail(e.to_string()),
                );
            }
            format!("清理审计日志失败: {}", e)
        })?
    };

    tracing::info!(deleted = deleted, "审计日志清理完成");

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Maintenance {
                    action: "cleanup_audit_logs".to_string(),
                },
                "cleanup_audit_logs".to_string(),
            )
            .with_details(serde_json::json!({
                "deleted_count": deleted,
                "keep_recent": keep_recent,
                "before_days": before_days,
            }))
            .complete(0),
        );
    }

    Ok(deleted)
}

/// 获取迁移状态摘要
///
/// 返回各数据库的当前版本信息，包括待执行迁移数量。
#[tauri::command]
pub fn data_governance_get_migration_status(
    app_handle: AppHandle,
    registry: State<'_, Arc<RwLock<SchemaRegistry>>>,
) -> Result<MigrationStatusResponse, String> {
    use tracing::{debug, warn};

    let registry = refresh_schema_registry_from_live_state(&app_handle, registry.inner())?;

    let mut pending_total = 0;
    let mut last_error: Option<String> = None;

    let databases: Vec<_> = DatabaseId::all_ordered()
        .into_iter()
        .map(|id| {
            let status = registry.get_status(&id);
            let current_version = status.map(|s| s.schema_version).unwrap_or(0);
            let (target_version, pending_count) =
                resolve_target_and_pending(&id, current_version, status);
            pending_total += pending_count;

            // 检测迁移失败：数据库已初始化但有待执行迁移
            if pending_count > 0 && current_version > 0 {
                let msg = format!(
                    "{} 有 {} 个迁移未执行 (当前: v{}, 目标: v{})",
                    id.as_str(),
                    pending_count,
                    current_version,
                    target_version
                );
                warn!("⚠️ [MigrationStatus] {}", msg);
                if last_error.is_none() {
                    last_error = Some(msg);
                }
            }

            MigrationDatabaseStatus {
                id: id.as_str().to_string(),
                current_version,
                target_version,
                is_initialized: current_version > 0,
                last_migration_at: status.and_then(|s| {
                    if s.updated_at.is_empty() {
                        None
                    } else {
                        Some(s.updated_at.clone())
                    }
                }),
                pending_count,
                has_pending: pending_count > 0,
            }
        })
        .collect();

    let all_healthy = databases.iter().all(|d| d.is_initialized && !d.has_pending);

    // 优先使用持久化的真实迁移错误（来自实际 SQL 执行失败），
    // 而非仅靠版本号比较生成的"有N个迁移未执行"伪信息
    if pending_total > 0 {
        if let Ok(app_data_dir) = get_live_app_data_dir(&app_handle) {
            if let Some((real_error, _ts)) = read_persisted_migration_error(&app_data_dir) {
                last_error = Some(real_error);
            }
        }
    }

    debug!(
        "📊 [MigrationStatus] 全局版本={}, 健康={}, 待执行迁移总数={}",
        registry.global_version, all_healthy, pending_total
    );

    Ok(MigrationStatusResponse {
        global_version: registry.global_version,
        all_healthy,
        databases,
        pending_migrations_total: pending_total,
        has_pending_migrations: pending_total > 0,
        last_error,
    })
}

/// 运行健康检查
///
/// 检查所有数据库的完整性和依赖关系，包括待执行迁移检测。
#[tauri::command]
pub fn data_governance_run_health_check(
    app: AppHandle,
    registry: State<'_, Arc<RwLock<SchemaRegistry>>>,
) -> Result<HealthCheckResponse, String> {
    use tracing::{info, warn};

    info!("🔍 [HealthCheck] 开始运行健康检查...");
    let registry = refresh_schema_registry_from_live_state(&app, registry.inner())?;

    // 检查依赖关系
    let dependency_check = registry.check_dependencies();
    let dependency_ok = dependency_check.is_ok();
    let dependency_error = dependency_check.err().map(|e| e.to_string());

    if let Some(ref err) = dependency_error {
        warn!("⚠️ [HealthCheck] 依赖关系检查失败: {}", err);
    }

    // 统计各状态数据库数量
    let total_databases = DatabaseId::all_ordered().len();
    let initialized_count = registry
        .databases
        .values()
        .filter(|s| s.schema_version > 0)
        .count();
    let uninitialized_count = total_databases - initialized_count;

    info!(
        "📊 [HealthCheck] 数据库统计: 总数={}, 已初始化={}, 未初始化={}",
        total_databases, initialized_count, uninitialized_count
    );

    let mut pending_migrations_total = 0;

    // 构建每个数据库的健康状态
    let database_health: Vec<_> = DatabaseId::all_ordered()
        .into_iter()
        .map(|id| {
            let status = registry.get_status(&id);
            let schema_version = status.map(|s| s.schema_version).unwrap_or(0);
            let (target_version, pending_count) =
                resolve_target_and_pending(&id, schema_version, status);
            let is_initialized = schema_version > 0;
            pending_migrations_total += pending_count;

            // 检查依赖是否满足
            let dependencies_met = id.dependencies().iter().all(|dep| {
                registry
                    .get_status(dep)
                    .map(|s| s.schema_version > 0)
                    .unwrap_or(false)
            });

            // 收集所有问题
            let mut issues = Vec::new();
            if !is_initialized {
                issues.push("数据库未初始化".to_string());
            }
            if !dependencies_met {
                issues.push("依赖数据库未就绪".to_string());
            }
            if pending_count > 0 {
                issues.push(format!(
                    "有 {} 个迁移待执行 (当前: v{}, 目标: v{})",
                    pending_count, schema_version, target_version
                ));
            }

            // 健康状态：已初始化 + 无待执行迁移 + 依赖满足
            let is_healthy = is_initialized && pending_count == 0 && dependencies_met;

            // 输出每个数据库的详细状态
            if is_healthy {
                info!(
                    "  ✅ [HealthCheck] {}: v{}, 健康",
                    id.as_str(),
                    schema_version
                );
            } else {
                warn!(
                    "  ⚠️ [HealthCheck] {}: v{} -> v{}, 问题: {:?}",
                    id.as_str(),
                    schema_version,
                    target_version,
                    issues
                );
            }

            DatabaseHealthStatus {
                id: id.as_str().to_string(),
                is_healthy,
                dependencies_met,
                schema_version,
                target_version,
                pending_count,
                issues,
            }
        })
        .collect();

    // 整体健康：依赖通过 + 无未初始化数据库 + 无待执行迁移
    let overall_healthy =
        dependency_ok && uninitialized_count == 0 && pending_migrations_total == 0;

    if overall_healthy {
        info!("✅ [HealthCheck] 健康检查完成: 所有数据库状态正常");
    } else {
        warn!(
            "⚠️ [HealthCheck] 健康检查完成: 发现问题 (未初始化: {}, 依赖检查: {}, 待执行迁移: {})",
            uninitialized_count,
            if dependency_ok { "通过" } else { "失败" },
            pending_migrations_total
        );
    }

    let audit_snapshot = app
        .try_state::<Arc<AuditHealthState>>()
        .map(|state| state.snapshot())
        .unwrap_or_else(AuditHealthSnapshot::healthy);

    Ok(HealthCheckResponse {
        overall_healthy,
        total_databases,
        initialized_count,
        uninitialized_count,
        dependency_check_passed: dependency_ok,
        dependency_error,
        databases: database_health,
        checked_at: chrono::Utc::now().to_rfc3339(),
        pending_migrations_count: pending_migrations_total,
        has_pending_migrations: pending_migrations_total > 0,
        audit_log_healthy: audit_snapshot.is_healthy,
        audit_log_error: audit_snapshot.last_error,
        audit_log_error_at: audit_snapshot.last_error_at,
    })
}

/// 获取特定数据库的详细状态
#[tauri::command]
pub fn data_governance_get_database_status(
    app: AppHandle,
    registry: State<'_, Arc<RwLock<SchemaRegistry>>>,
    database_id: String,
) -> Result<Option<DatabaseDetailResponse>, String> {
    let registry = refresh_schema_registry_from_live_state(&app, registry.inner())?;

    let db_id = match database_id.as_str() {
        "vfs" => DatabaseId::Vfs,
        "chat_v2" => DatabaseId::ChatV2,
        "mistakes" => DatabaseId::Mistakes,
        "llm_usage" => DatabaseId::LlmUsage,
        _ => {
            return Err(format!(
                "未知的数据库 ID: {}。可选值: vfs, chat_v2, mistakes, llm_usage",
                database_id
            ))
        }
    };

    Ok(registry
        .get_status(&db_id)
        .map(|status| DatabaseDetailResponse {
            id: db_id.as_str().to_string(),
            schema_version: status.schema_version,
            min_compatible_version: status.min_compatible_version,
            max_compatible_version: status.max_compatible_version,
            data_contract_version: status.data_contract_version.clone(),
            checksum: status.checksum.clone(),
            updated_at: status.updated_at.clone(),
            migration_history: status
                .migration_history
                .iter()
                .map(|m| MigrationRecordResponse {
                    version: m.version,
                    name: m.name.clone(),
                    checksum: m.checksum.clone(),
                    applied_at: m.applied_at.clone(),
                    duration_ms: m.duration_ms,
                    success: m.success,
                })
                .collect(),
            dependencies: db_id
                .dependencies()
                .iter()
                .map(|d| d.as_str().to_string())
                .collect(),
        }))
}

/// 生成迁移诊断报告
///
/// 收集所有数据库的迁移状态、错误信息、迁移历史、磁盘空间等信息，
/// 返回格式化的纯文本报告，用于用户一键复制给开发者。
#[tauri::command]
pub fn data_governance_get_migration_diagnostic_report(
    app_handle: AppHandle,
    registry: State<'_, Arc<RwLock<SchemaRegistry>>>,
) -> Result<String, String> {
    use std::fmt::Write;

    let app_data_dir = get_live_app_data_dir(&app_handle)?;
    let registry = refresh_schema_registry_from_live_state(&app_handle, registry.inner())?;

    let mut report = String::with_capacity(4096);

    // --- 头部 ---
    let _ = writeln!(report, "=== Deep Student 迁移诊断报告 ===");
    let _ = writeln!(report, "时间: {}", chrono::Utc::now().to_rfc3339());
    let _ = writeln!(
        report,
        "平台: {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let _ = writeln!(report, "应用版本: {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(report);

    // --- 数据库状态 ---
    let _ = writeln!(report, "--- 数据库状态 ---");
    let mut error_messages: Vec<String> = Vec::new();

    for id in DatabaseId::all_ordered() {
        let status = registry.get_status(&id);
        let current_version = status.map(|s| s.schema_version).unwrap_or(0);
        let (target_version, pending_count) =
            resolve_target_and_pending(&id, current_version, status);

        let flag = if pending_count > 0 && current_version > 0 {
            error_messages.push(format!(
                "{}: 有 {} 个迁移未执行 (当前: v{}, 目标: v{})",
                id.as_str(),
                pending_count,
                current_version,
                target_version
            ));
            " ⚠️"
        } else {
            ""
        };

        let _ = writeln!(
            report,
            "[{}] 当前: v{}, 目标: v{}, 待执行: {}{}",
            id.as_str(),
            current_version,
            target_version,
            pending_count,
            flag
        );
    }
    let _ = writeln!(report);

    // --- 错误信息（实时诊断） ---
    let _ = writeln!(report, "--- 错误信息 ---");

    // 优先显示持久化的真实迁移错误（来自实际 SQL 执行失败）
    if let Some((real_error, error_ts)) = read_persisted_migration_error(&app_data_dir) {
        let _ = writeln!(report, "[{}] 真实迁移错误: {}", error_ts, real_error);
    }

    if error_messages.is_empty() && read_persisted_migration_error(&app_data_dir).is_none() {
        let _ = writeln!(report, "(无)");
    } else {
        for msg in &error_messages {
            let _ = writeln!(report, "{}", msg);
        }
    }
    let _ = writeln!(report);

    // --- 审计日志中的迁移失败记录 ---
    let _ = writeln!(report, "--- 最近迁移失败记录（审计日志） ---");
    {
        let audit_db_path = app_data_dir.join("databases").join("audit.db");
        if audit_db_path.exists() {
            match rusqlite::Connection::open(&audit_db_path) {
                Ok(conn) => {
                    // 直接查最近 5 条失败的迁移审计记录
                    let sql = "SELECT timestamp, target, error_message, details \
                               FROM __audit_log \
                               WHERE operation_type = 'migration' AND status = 'failed' \
                               ORDER BY timestamp DESC LIMIT 5";
                    match conn.prepare(sql) {
                        Ok(mut stmt) => {
                            let mut found = false;
                            if let Ok(rows) = stmt.query_map([], |row| {
                                Ok((
                                    row.get::<_, String>(0).unwrap_or_default(),
                                    row.get::<_, String>(1).unwrap_or_default(),
                                    row.get::<_, Option<String>>(2).unwrap_or(None),
                                    row.get::<_, Option<String>>(3).unwrap_or(None),
                                ))
                            }) {
                                for row in rows.flatten() {
                                    found = true;
                                    let (ts, target, err, details) = row;
                                    let _ = writeln!(report, "[{}] db={}", ts, target);
                                    if let Some(err) = err {
                                        let _ = writeln!(report, "  error: {}", err);
                                    }
                                    if let Some(details) = details {
                                        // 截取前 500 字符，避免过长
                                        let truncated = if details.chars().count() > 500 {
                                            format!(
                                                "{}...(truncated)",
                                                safe_truncate_chars(&details, 500)
                                            )
                                        } else {
                                            details
                                        };
                                        let _ = writeln!(report, "  details: {}", truncated);
                                    }
                                }
                            }
                            if !found {
                                let _ = writeln!(report, "(审计日志中无迁移失败记录)");
                            }
                        }
                        Err(e) => {
                            let _ = writeln!(report, "(查询审计日志失败: {})", e);
                        }
                    }
                }
                Err(e) => {
                    let _ = writeln!(report, "(无法打开审计数据库: {})", e);
                }
            }
        } else {
            let _ = writeln!(report, "(审计数据库不存在)");
        }
    }
    let _ = writeln!(report);

    // --- 测试插槽迁移复现（安全沙箱） ---
    // 使用测试插槽 C/D 在隔离环境中复现迁移错误，不影响生产数据
    let _ = writeln!(report, "--- 空库迁移测试 (Slot C) ---");
    {
        let result = run_slot_c_empty_db_test(&app_data_dir);
        let _ = write!(report, "{}", result.report);
    }
    let _ = writeln!(report);

    let _ = writeln!(report, "--- 当前库重试迁移测试 (Slot D) ---");
    let _ = writeln!(
        report,
        "(复制当前活跃插槽的数据库，重新执行迁移流程；若成功说明重启可恢复)"
    );
    {
        let result = run_slot_d_clone_db_test(&app_data_dir);
        let _ = write!(report, "{}", result.report);
    }
    let _ = writeln!(report);

    // --- 迁移历史 ---
    let _ = writeln!(report, "--- 迁移历史 ---");
    for id in DatabaseId::all_ordered() {
        let status = registry.get_status(&id);
        if let Some(status) = status {
            let history_str: String = status
                .migration_history
                .iter()
                .map(|m| format!("v{}({})", m.version, m.name))
                .collect::<Vec<_>>()
                .join(" ");
            let _ = writeln!(
                report,
                "[{}] {}",
                id.as_str(),
                if history_str.is_empty() {
                    "(无记录)".to_string()
                } else {
                    history_str
                }
            );
        } else {
            let _ = writeln!(report, "[{}] (数据库未初始化)", id.as_str());
        }
    }
    let _ = writeln!(report);

    // --- 磁盘空间 ---
    let _ = writeln!(report, "--- 磁盘空间 ---");
    let available = crate::backup_common::get_available_disk_space(&app_data_dir).unwrap_or(0);
    let mut total_db_size: u64 = 0;
    for db_id in DatabaseId::all_ordered() {
        let db_path = match db_id {
            DatabaseId::Vfs => app_data_dir.join("databases").join("vfs.db"),
            DatabaseId::ChatV2 => app_data_dir.join("chat_v2.db"),
            DatabaseId::Mistakes => app_data_dir.join("mistakes.db"),
            DatabaseId::LlmUsage => app_data_dir.join("llm_usage.db"),
        };
        if db_path.exists() {
            if let Ok(meta) = std::fs::metadata(&db_path) {
                total_db_size += meta.len();
            }
        }
    }
    let _ = writeln!(
        report,
        "可用: {}MB, 数据库总大小: {}MB",
        available / (1024 * 1024),
        total_db_size / (1024 * 1024)
    );
    let _ = writeln!(report);

    // --- 数据目录 ---
    let _ = writeln!(report, "--- 数据目录 ---");
    let _ = writeln!(report, "{}", app_data_dir.display());

    Ok(report)
}

/// 运行 Slot C 空库迁移测试（测试插槽，不影响当前数据）
#[tauri::command]
pub fn data_governance_run_slot_c_empty_db_test(
    app_handle: AppHandle,
) -> Result<SlotMigrationTestResponse, String> {
    let app_data_dir = get_live_app_data_dir(&app_handle)?;
    Ok(run_slot_c_empty_db_test(&app_data_dir))
}

/// 运行 Slot D 克隆库迁移测试（测试插槽，不影响当前数据）
#[tauri::command]
pub fn data_governance_run_slot_d_clone_db_test(
    app_handle: AppHandle,
) -> Result<SlotMigrationTestResponse, String> {
    let app_data_dir = get_live_app_data_dir(&app_handle)?;
    Ok(run_slot_d_clone_db_test(&app_data_dir))
}

#[cfg(test)]
mod tests {
    use super::{refresh_schema_registry_from_dir, resolve_target_and_pending};
    use crate::data_governance::commands_backup::{validate_backup_id, infer_database_from_table};
    use crate::data_governance::schema_registry::{DatabaseId, DatabaseStatus, SchemaRegistry};
    use std::sync::{Arc, RwLock};
    use tempfile::TempDir;

    fn create_refinery_history_with_version(db_path: &std::path::Path, version: i32) {
        let conn = rusqlite::Connection::open(db_path).unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO refinery_schema_history(version, name, applied_on, checksum)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                version,
                format!("V{}_test", version),
                "2026-02-07T00:00:00Z",
                "abc"
            ],
        )
        .unwrap();
    }

    #[test]
    fn resolve_target_and_pending_uses_migration_set_when_status_missing() {
        // Mistakes 迁移集：V20260130, V20260131, V20260201, V20260207, V20260208, V20260209
        // 从 V20260130 开始，pending = 5（后续 5 个迁移）
        let (target_version, pending_count) =
            resolve_target_and_pending(&DatabaseId::Mistakes, 20260130, None);

        let expected_latest = super::super::migration::MISTAKES_MIGRATIONS.latest_version() as u32;
        let expected_pending = super::super::migration::MISTAKES_MIGRATIONS
            .pending(20260130)
            .count();

        assert_eq!(target_version, expected_latest);
        assert_eq!(pending_count, expected_pending);
    }

    #[test]
    fn resolve_target_and_pending_returns_zero_when_latest_reached() {
        let latest = super::super::migration::MISTAKES_MIGRATIONS.latest_version() as u32;
        let (target_version, pending_count) =
            resolve_target_and_pending(&DatabaseId::Mistakes, latest, None);

        assert_eq!(target_version, latest);
        assert_eq!(pending_count, 0);
    }

    #[test]
    fn resolve_target_and_pending_prefers_status_target_version() {
        let status = DatabaseStatus {
            id: DatabaseId::Mistakes,
            schema_version: 20260130,
            min_compatible_version: 1,
            max_compatible_version: 20260299,
            data_contract_version: "1.0.0".to_string(),
            migration_history: Vec::new(),
            checksum: String::new(),
            updated_at: String::new(),
        };

        let (target_version, pending_count) =
            resolve_target_and_pending(&DatabaseId::Mistakes, 20260130, Some(&status));

        let expected_pending = super::super::migration::MISTAKES_MIGRATIONS
            .pending(20260130)
            .count();

        assert_eq!(target_version, 20260299);
        assert_eq!(pending_count, expected_pending);
    }

    #[test]
    fn validate_backup_id_allows_safe_id() {
        let result = validate_backup_id("backup-20260206_120000");
        assert_eq!(result.unwrap(), "backup-20260206_120000");
    }

    #[test]
    fn validate_backup_id_rejects_parent_traversal() {
        let result = validate_backup_id("../escape");
        assert!(result.is_err());
    }

    #[test]
    fn validate_backup_id_rejects_absolute_path() {
        let result = validate_backup_id("/tmp/escape");
        assert!(result.is_err());
    }

    #[test]
    fn validate_backup_id_rejects_encoded_bypass() {
        let result = validate_backup_id("%2e%2e%2fescape");
        assert!(result.is_err());
    }

    #[test]
    fn refresh_schema_registry_from_dir_swaps_latest_live_state() {
        let temp_dir = TempDir::new().unwrap();
        let app_data_dir = temp_dir.path();
        std::fs::create_dir_all(app_data_dir.join("databases")).unwrap();

        let vfs_db = app_data_dir.join("databases").join("vfs.db");
        create_refinery_history_with_version(&vfs_db, 1);

        let registry_state = Arc::new(RwLock::new(SchemaRegistry::default()));
        let first = refresh_schema_registry_from_dir(app_data_dir, &registry_state).unwrap();
        assert_eq!(
            first.get_status(&DatabaseId::Vfs).map(|s| s.schema_version),
            Some(1)
        );

        create_refinery_history_with_version(&vfs_db, 2);

        let second = refresh_schema_registry_from_dir(app_data_dir, &registry_state).unwrap();
        assert_eq!(
            second
                .get_status(&DatabaseId::Vfs)
                .map(|s| s.schema_version),
            Some(2)
        );

        let guard = registry_state.read().unwrap();
        assert_eq!(
            guard.get_status(&DatabaseId::Vfs).map(|s| s.schema_version),
            Some(2)
        );
    }

    #[test]
    fn refresh_schema_registry_from_dir_maps_poisoned_lock_error() {
        let temp_dir = TempDir::new().unwrap();
        let app_data_dir = temp_dir.path();
        std::fs::create_dir_all(app_data_dir.join("databases")).unwrap();

        let registry_state = Arc::new(RwLock::new(SchemaRegistry::default()));
        let poison_target = registry_state.clone();
        let _ = std::panic::catch_unwind(move || {
            let _guard = poison_target.write().unwrap();
            panic!("poison registry lock");
        });

        let err = refresh_schema_registry_from_dir(app_data_dir, &registry_state).unwrap_err();
        assert!(err.contains("写入 SchemaRegistry 状态失败"));
    }

    // ========================================================================
    // infer_database_from_table 测试
    // ========================================================================

    #[test]
    fn test_infer_database_chat_v2_prefix() {
        assert_eq!(
            infer_database_from_table("chat_v2_sessions"),
            Some("chat_v2")
        );
        assert_eq!(
            infer_database_from_table("chat_v2_messages"),
            Some("chat_v2")
        );
        assert_eq!(
            infer_database_from_table("chat_v2_blocks"),
            Some("chat_v2")
        );
    }

    #[test]
    fn test_infer_database_chat_v2_known_tables() {
        assert_eq!(
            infer_database_from_table("workspace_index"),
            Some("chat_v2")
        );
        assert_eq!(
            infer_database_from_table("sleep_block"),
            Some("chat_v2")
        );
        assert_eq!(
            infer_database_from_table("subagent_task"),
            Some("chat_v2")
        );
    }

    #[test]
    fn test_infer_database_resources_ambiguous_returns_none() {
        // resources 表同时存在于 chat_v2 和 vfs，legacy 变更无法判定，应跳过
        assert_eq!(infer_database_from_table("resources"), None);
    }

    #[test]
    fn test_infer_database_mistakes() {
        assert_eq!(
            infer_database_from_table("mistakes"),
            Some("mistakes")
        );
        assert_eq!(
            infer_database_from_table("anki_cards"),
            Some("mistakes")
        );
        assert_eq!(
            infer_database_from_table("document_tasks"),
            Some("mistakes")
        );
        assert_eq!(
            infer_database_from_table("settings"),
            Some("mistakes")
        );
        assert_eq!(
            infer_database_from_table("review_analyses"),
            Some("mistakes")
        );
        assert_eq!(
            infer_database_from_table("exam_sheet_sessions"),
            Some("mistakes")
        );
    }

    #[test]
    fn test_infer_database_vfs() {
        assert_eq!(infer_database_from_table("notes"), Some("vfs"));
        assert_eq!(infer_database_from_table("files"), Some("vfs"));
        assert_eq!(infer_database_from_table("folders"), Some("vfs"));
        assert_eq!(infer_database_from_table("blobs"), Some("vfs"));
        assert_eq!(infer_database_from_table("questions"), Some("vfs"));
        assert_eq!(infer_database_from_table("mindmaps"), Some("vfs"));
        assert_eq!(infer_database_from_table("essays"), Some("vfs"));
    }

    #[test]
    fn test_infer_database_llm_usage() {
        assert_eq!(
            infer_database_from_table("llm_usage_logs"),
            Some("llm_usage")
        );
        assert_eq!(
            infer_database_from_table("llm_usage_daily"),
            Some("llm_usage")
        );
    }

    #[test]
    fn test_infer_database_unknown_returns_none() {
        assert_eq!(infer_database_from_table("unknown_table_xyz"), None);
        assert_eq!(infer_database_from_table("__change_log"), None);
    }

    #[test]
    fn test_infer_database_no_cross_routing() {
        // 确保 mistakes 表不会被路由到 chat_v2
        assert_ne!(
            infer_database_from_table("anki_cards"),
            Some("chat_v2")
        );
        // 确保 vfs 表不会被路由到 mistakes
        assert_ne!(infer_database_from_table("notes"), Some("mistakes"));
    }
}
