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
    BackupJobContext, BackupJobKind, BackupJobManager, BackupJobManagerState, BackupJobParams,
    BackupJobPhase, BackupJobResultPayload, BackupJobStatus, BackupJobSummary, PersistedJob,
};
use crate::utils::text::safe_truncate_chars;

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
fn check_maintenance_mode(app: &tauri::AppHandle) -> Result<(), String> {
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
const SYNC_LOCK_TIMEOUT_SECS: u64 = 60;

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
fn try_save_audit_log(app: &tauri::AppHandle, log: AuditLog) {
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

// ==================== 响应类型定义 ====================

/// 维护模式状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MaintenanceStatusResponse {
    pub is_in_maintenance_mode: bool,
}

/// Schema 注册表响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SchemaRegistryResponse {
    pub global_version: u64,
    pub aggregated_at: String,
    pub databases: Vec<DatabaseStatusResponse>,
}

/// 数据库状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseStatusResponse {
    pub id: String,
    pub schema_version: u32,
    pub min_compatible_version: u32,
    pub max_compatible_version: u32,
    pub data_contract_version: String,
    pub migration_count: usize,
    pub checksum: String,
    pub updated_at: String,
}

/// 审计日志响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditLogResponse {
    pub id: String,
    pub timestamp: String,
    pub operation_type: String,
    pub target: String,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub error_message: Option<String>,
}

/// 审计日志分页响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditLogPagedResponse {
    /// 当前页的审计日志列表
    pub logs: Vec<AuditLogResponse>,
    /// 满足过滤条件的总记录数（不受 limit/offset 影响）
    pub total: u64,
}

impl From<AuditLog> for AuditLogResponse {
    fn from(log: AuditLog) -> Self {
        let operation_type = match &log.operation {
            super::audit::AuditOperation::Migration { .. } => "Migration",
            super::audit::AuditOperation::Backup { .. } => "Backup",
            super::audit::AuditOperation::Restore { .. } => "Restore",
            super::audit::AuditOperation::Sync { .. } => "Sync",
            super::audit::AuditOperation::Maintenance { .. } => "Maintenance",
        };

        let status = match &log.status {
            AuditStatus::Started => "Started",
            AuditStatus::Completed => "Completed",
            AuditStatus::Failed => "Failed",
            AuditStatus::Partial => "Partial",
        };

        Self {
            id: log.id,
            timestamp: log.timestamp.to_rfc3339(),
            operation_type: operation_type.to_string(),
            target: log.target,
            status: status.to_string(),
            duration_ms: log.duration_ms,
            error_message: log.error_message,
        }
    }
}

/// 迁移状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationStatusResponse {
    pub global_version: u64,
    pub all_healthy: bool,
    pub databases: Vec<MigrationDatabaseStatus>,
    /// 待执行迁移总数
    pub pending_migrations_total: usize,
    /// 是否有待执行迁移
    pub has_pending_migrations: bool,
    /// 最后的迁移错误（如果有）
    pub last_error: Option<String>,
}

/// 迁移数据库状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationDatabaseStatus {
    pub id: String,
    pub current_version: u32,
    /// 目标版本（最新可用迁移版本）
    pub target_version: u32,
    pub is_initialized: bool,
    pub last_migration_at: Option<String>,
    /// 待执行迁移数量
    pub pending_count: usize,
    /// 是否有待执行迁移
    pub has_pending: bool,
}

/// 健康检查响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct HealthCheckResponse {
    pub overall_healthy: bool,
    pub total_databases: usize,
    pub initialized_count: usize,
    pub uninitialized_count: usize,
    pub dependency_check_passed: bool,
    pub dependency_error: Option<String>,
    pub databases: Vec<DatabaseHealthStatus>,
    pub checked_at: String,
    /// 待执行迁移总数
    pub pending_migrations_count: usize,
    /// 是否有待执行迁移
    pub has_pending_migrations: bool,
    /// 审计写入是否健康
    pub audit_log_healthy: bool,
    /// 审计写入错误（如果有）
    pub audit_log_error: Option<String>,
    /// 审计写入错误时间（如果有）
    pub audit_log_error_at: Option<String>,
}

/// 数据库健康状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseHealthStatus {
    pub id: String,
    pub is_healthy: bool,
    pub dependencies_met: bool,
    pub schema_version: u32,
    /// 目标版本（最新可用迁移版本）
    pub target_version: u32,
    /// 待执行迁移数量
    pub pending_count: usize,
    pub issues: Vec<String>,
}

/// 数据库详情响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseDetailResponse {
    pub id: String,
    pub schema_version: u32,
    pub min_compatible_version: u32,
    pub max_compatible_version: u32,
    pub data_contract_version: String,
    pub checksum: String,
    pub updated_at: String,
    pub migration_history: Vec<MigrationRecordResponse>,
    pub dependencies: Vec<String>,
}

/// 迁移记录响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationRecordResponse {
    pub version: u32,
    pub name: String,
    pub checksum: String,
    pub applied_at: String,
    pub duration_ms: Option<u64>,
    pub success: bool,
}

// ==================== 备份相关命令 ====================

use std::path::PathBuf;
use std::time::Instant;
use tracing::{debug, error, info, warn};

use super::backup::{
    export_backup_to_zip, AssetBackupConfig, AssetBackupResult, AssetType, AssetTypeStats,
    BackupManager, BackupSelection, BackupTier, BackupVerifyResult, TieredAssetConfig,
    TieredBackupResult, ZipExportOptions,
};

/// 获取应用数据基础目录（Tauri app_data_dir）
///
/// 注意：此目录是基础目录，**不是**运行时数据库/资产的实际存储位置。
/// 运行时存储位置请使用 `get_active_data_dir`。
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))
}

/// 获取活动数据空间目录（运行时所有数据库和资产的实际存储位置）
///
/// 通过 DataSpaceManager 获取当前活动槽位（A/B 双数据空间）的路径。
/// 回退到 `base_dir/slots/slotA` 作为默认值。
///
/// **重要**：所有数据库路径解析、同步操作、资产扫描都必须基于此目录，
/// 禁止直接使用 `get_app_data_dir` 访问数据库文件。
fn get_active_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = get_app_data_dir(app)?;
    Ok(crate::data_space::get_data_space_manager()
        .map(|mgr| mgr.active_dir())
        .unwrap_or_else(|| base_dir.join("slots").join("slotA")))
}

/// 获取备份目录
fn get_backup_dir(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("backups")
}

/// 统一解析数据库文件路径
///
/// 根据 `DatabaseId` 和活动数据空间目录返回对应数据库文件的绝对路径。
/// 路径规则与 `MigrationCoordinator::get_database_path` 和
/// `BackupManager::get_database_path` 保持一致：
/// - Vfs: `<active_dir>/databases/vfs.db`
/// - ChatV2: `<active_dir>/chat_v2.db`
/// - Mistakes: `<active_dir>/mistakes.db`
/// - LlmUsage: `<active_dir>/llm_usage.db`
fn resolve_database_path(db_id: &DatabaseId, active_dir: &Path) -> PathBuf {
    match db_id {
        DatabaseId::Vfs => active_dir.join("databases").join("vfs.db"),
        DatabaseId::ChatV2 => active_dir.join("chat_v2.db"),
        DatabaseId::Mistakes => active_dir.join("mistakes.db"),
        DatabaseId::LlmUsage => active_dir.join("llm_usage.db"),
    }
}

/// 多库应用结果
struct ApplyToDbsResult {
    total_success: usize,
    total_skipped: usize,
    total_failed: usize,
}

/// 根据表名推断变更所属的数据库（用于 legacy 无 database_name 的变更）
///
/// 使用已知的表名→库映射，避免将非 chat_v2 的变更错误路由到 chat_v2。
/// 返回 None 表示表名未知，调用方应跳过该变更。
fn infer_database_from_table(table_name: &str) -> Option<&'static str> {
    // chat_v2 表（前缀 chat_v2_ 或已知表名）
    match table_name {
        // chat_v2 数据库
        t if t.starts_with("chat_v2_") => Some("chat_v2"),
        "workspace_index" | "sleep_block" | "subagent_task" => Some("chat_v2"),
        // "resources" 同时存在于 chat_v2 和 vfs，无法判定，跳过
        "resources" => {
            tracing::warn!(
                "[sync] 'resources' 表同时存在于 chat_v2 和 vfs，legacy 变更无法判定目标库，跳过"
            );
            None
        }
        // mistakes 主数据库
        "mistakes"
        | "chat_messages"
        | "temp_sessions"
        | "review_analyses"
        | "review_chat_messages"
        | "review_sessions"
        | "review_session_mistakes"
        | "settings"
        | "rag_configurations"
        | "document_tasks"
        | "anki_cards"
        | "custom_anki_templates"
        | "document_control_states"
        | "vectorized_data"
        | "rag_sub_libraries"
        | "search_logs"
        | "exam_sheet_sessions"
        | "migration_progress" => Some("mistakes"),
        // vfs 数据库
        "blobs"
        | "notes"
        | "notes_versions"
        | "files"
        | "exam_sheets"
        | "translations"
        | "essays"
        | "essay_sessions"
        | "folders"
        | "folder_items"
        | "path_cache"
        | "mindmaps"
        | "questions"
        | "question_history"
        | "question_bank_stats"
        | "review_plans"
        | "review_history"
        | "review_stats" => Some("vfs"),
        // llm_usage 数据库
        "llm_usage_logs" | "llm_usage_daily" => Some("llm_usage"),
        // __change_log 是系统表，不应被同步回放
        "__change_log" => None,
        // 未知表名
        _ => {
            tracing::debug!("[sync] 未知表名 '{}', 无法推断数据库", table_name);
            None
        }
    }
}

/// 将下载的变更按数据库路由并应用
///
/// 根据每条变更的 `database_name` 字段将变更路由到对应的数据库，
/// 确保多库同步时变更不会错误地应用到单一数据库。
/// 对于没有 `database_name` 的旧格式变更，通过表名推断目标数据库。
///
/// 返回聚合的应用结果，调用方可根据 `total_skipped` 向用户发出警告。
fn apply_downloaded_changes_to_databases(
    changes: &[SyncChangeWithData],
    active_dir: &std::path::Path,
) -> Result<ApplyToDbsResult, String> {
    use std::collections::HashMap;

    let mut agg = ApplyToDbsResult {
        total_success: 0,
        total_skipped: 0,
        total_failed: 0,
    };

    // 按数据库名称分组（legacy 变更按表名推断库）
    let mut grouped: HashMap<String, Vec<&SyncChangeWithData>> = HashMap::new();
    for change in changes {
        let db_name = match change.database_name.as_deref() {
            Some(name) => name.to_string(),
            None => {
                // Legacy 变更无 database_name，按表名推断目标库
                match infer_database_from_table(&change.table_name) {
                    Some(name) => name.to_string(),
                    None => {
                        warn!(
                            "[data_governance] Legacy 变更表名 '{}' 无法推断目标数据库，跳过 (record_id={})",
                            change.table_name, change.record_id
                        );
                        agg.total_skipped += 1;
                        continue;
                    }
                }
            }
        };
        grouped.entry(db_name).or_default().push(change);
    }

    for (db_name, db_changes) in &grouped {
        // 解析数据库 ID
        let db_id = DatabaseId::all_ordered()
            .into_iter()
            .find(|id| id.as_str() == db_name);

        let db_path = match db_id {
            Some(id) => resolve_database_path(&id, active_dir),
            None => {
                warn!(
                    "[data_governance] 未知数据库名称 '{}', 跳过 {} 条变更",
                    db_name,
                    db_changes.len()
                );
                agg.total_skipped += db_changes.len();
                continue;
            }
        };

        if !db_path.exists() {
            warn!(
                "[data_governance] 数据库文件不存在: {}, 跳过 {} 条变更",
                db_path.display(),
                db_changes.len()
            );
            agg.total_skipped += db_changes.len();
            continue;
        }

        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("打开数据库 {} 失败: {}", db_name, e))?;

        let owned_changes: Vec<SyncChangeWithData> = db_changes
            .iter()
            .map(|c| {
                let mut cloned = (*c).clone();
                cloned.suppress_change_log = Some(true);
                cloned
            })
            .collect();

        match SyncManager::apply_downloaded_changes(&conn, &owned_changes, None) {
            Ok(apply_result) => {
                agg.total_success += apply_result.success_count;
                agg.total_skipped += apply_result.skipped_count;
                agg.total_failed += apply_result.failure_count;
                info!(
                    "[data_governance] 数据库 {} 应用变更完成: success={}, failed={}, skipped={}",
                    db_name,
                    apply_result.success_count,
                    apply_result.failure_count,
                    apply_result.skipped_count
                );
            }
            Err(e) => {
                error!("[data_governance] 数据库 {} 应用变更失败: {}", db_name, e);
                return Err(format!(
                    "数据库 {} 应用下载变更失败: {}。请检查网络连接后重试同步",
                    db_name, e
                ));
            }
        }
    }

    Ok(agg)
}

/// 将路径中用户主目录替换为 "~/"，避免在面向用户的错误信息中泄露完整文件系统路径
fn sanitize_path_for_user(path: &Path) -> String {
    let path_str = path.to_string_lossy();
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        if path_str.starts_with(home_str.as_ref()) {
            return format!("~/{}", &path_str[home_str.len()..].trim_start_matches('/'));
        }
    }
    // 如果无法获取 home 目录，至少只保留最后两级路径
    let components: Vec<&str> = path_str.split('/').filter(|s| !s.is_empty()).collect();
    if components.len() > 2 {
        format!(".../{}", components[components.len() - 2..].join("/"))
    } else {
        path_str.to_string()
    }
}

/// 验证用户提供的路径（不再限制目录范围，允许任意路径）
fn validate_user_path(_path: &Path, _app_data_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn validate_backup_id(raw_backup_id: &str) -> Result<String, String> {
    let trimmed = raw_backup_id.trim();
    if trimmed.is_empty() {
        return Err("backup_id 不能为空".to_string());
    }

    let decoded = urlencoding::decode(trimmed)
        .map_err(|e| format!("backup_id 编码非法: {}", e))?
        .into_owned();

    if decoded != trimmed {
        return Err("backup_id 不允许包含 URL 编码".to_string());
    }

    if decoded.len() > 128 {
        return Err("backup_id 长度超限（最大 128）".to_string());
    }

    if decoded.contains('/')
        || decoded.contains('\\')
        || decoded.contains("..")
        || decoded.starts_with('.')
    {
        return Err("backup_id 包含非法路径片段".to_string());
    }

    if !decoded
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("backup_id 包含非法字符".to_string());
    }

    Ok(decoded)
}

fn ensure_existing_path_within_backup_dir(
    path: &std::path::Path,
    backup_dir: &std::path::Path,
) -> Result<(), String> {
    let canonical_backup_dir =
        std::fs::canonicalize(backup_dir).map_err(|e| format!("解析备份根目录失败: {}", e))?;
    let canonical_path =
        std::fs::canonicalize(path).map_err(|e| format!("解析备份路径失败: {}", e))?;

    if !canonical_path.starts_with(&canonical_backup_dir) {
        return Err(format!(
            "备份路径越界: {}。请确认路径在备份目录内，或前往「设置 > 数据治理」重新选择备份目录",
            sanitize_path_for_user(&canonical_path)
        ));
    }

    Ok(())
}

/// 获取全局备份互斥锁（取消友好）
///
/// 背景：备份/恢复/ZIP 导入导出都会读写同一套备份目录和数据库文件。
/// 若并发执行，容易导致：
/// - 备份目录写入覆盖（尤其是历史上秒级时间戳目录名）
/// - restore 与备份/导出并发，造成一致性风险或 Windows 文件锁问题
///
/// 这里统一使用 `backup_common::BACKUP_GLOBAL_LIMITER` 串行化所有相关任务。
async fn acquire_backup_global_permit(
    job_ctx: &BackupJobContext,
    waiting_message: &str,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    // 向前端暴露“正在等待”状态（不阻塞 UI）
    job_ctx.mark_running(
        BackupJobPhase::Queued,
        0.0,
        Some(waiting_message.to_string()),
        0,
        0,
    );

    let fut = BACKUP_GLOBAL_LIMITER.clone().acquire_owned();
    tokio::pin!(fut);

    loop {
        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消任务".to_string()));
            return None;
        }

        tokio::select! {
            permit = &mut fut => {
                return match permit {
                    Ok(p) => Some(p),
                    Err(e) => {
                        job_ctx.fail(format!("获取全局备份锁失败: {}", e));
                        None
                    }
                };
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
    }
}

/// 获取备份列表
///
/// 返回所有可用的备份文件列表。
///
/// ## 参数
/// - `app`: Tauri AppHandle
///
/// ## 返回
/// - `Vec<BackupInfoResponse>`: 备份列表
#[tauri::command]
pub async fn data_governance_get_backup_list(
    app: tauri::AppHandle,
) -> Result<Vec<BackupInfoResponse>, String> {
    debug!("[data_governance] 获取备份列表");

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    // 检查备份目录是否存在
    if !backup_dir.exists() {
        debug!("[data_governance] 备份目录不存在，返回空列表");
        return Ok(vec![]);
    }

    // 创建备份管理器
    let manager = BackupManager::new(backup_dir.clone());

    // 获取备份列表
    let manifests = manager.list_backups().map_err(|e| {
        error!("[data_governance] 获取备份列表失败: {}", e);
        format!("获取备份列表失败: {}", e)
    })?;

    // 转换为响应格式
    let backups: Vec<BackupInfoResponse> = manifests
        .iter()
        .map(|m| {
            let db_size: u64 = m.files.iter().map(|f| f.size).sum();
            let asset_size: u64 = m.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
            let size = db_size + asset_size;
            let databases: Vec<String> = m
                .files
                .iter()
                .filter_map(|f| f.database_id.clone())
                .collect();

            BackupInfoResponse {
                path: m.backup_id.clone(),
                created_at: m.created_at.clone(),
                size,
                backup_type: if m.is_incremental {
                    "incremental".to_string()
                } else {
                    "full".to_string()
                },
                databases,
            }
        })
        .collect();

    info!(
        "[data_governance] 备份列表获取成功: {} 个备份",
        backups.len()
    );

    Ok(backups)
}

/// 删除备份
///
/// 删除指定的备份文件。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要删除的备份 ID
///
/// ## 返回
/// - `bool`: 删除是否成功
#[tauri::command]
pub async fn data_governance_delete_backup(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<bool, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;
    info!("[data_governance] 删除备份: {}", validated_backup_id);

    // 全局互斥：避免与正在运行的备份/恢复/ZIP 导入导出并发
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("获取全局备份锁失败: {}", e))?;

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err("备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置".to_string());
    }

    let manager = BackupManager::new(backup_dir.clone());

    // 防止路径越界（即使 validate_backup_id 已过滤，也再做一次 canonicalize 校验）
    let target_dir = backup_dir.join(&validated_backup_id);
    if target_dir.exists() {
        ensure_existing_path_within_backup_dir(&target_dir, &backup_dir)?;
    }

    manager.delete_backup(&validated_backup_id).map_err(|e| {
        error!("[data_governance] 删除备份失败: {}", e);
        format!("删除备份失败: {}", e)
    })?;

    info!("[data_governance] 备份删除成功: {}", validated_backup_id);
    Ok(true)
}

/// 恢复前磁盘空间检查
///
/// 读取指定备份的大小，检查应用数据目录所在磁盘是否有足够可用空间执行恢复。
/// 所需空间 = 备份大小 × 2（解压 + 恢复预留）。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要恢复的备份 ID
///
/// ## 返回
/// - `DiskSpaceCheckResponse`: 磁盘空间检查结果
#[tauri::command]
pub async fn data_governance_check_disk_space_for_restore(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<DiskSpaceCheckResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;
    debug!(
        "[data_governance] 检查恢复磁盘空间: backup_id={}",
        validated_backup_id
    );

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err("备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置".to_string());
    }

    // 读取备份清单以获取备份大小
    let manager = BackupManager::new(backup_dir.clone());
    let manifests = manager.list_backups().map_err(|e| {
        error!("[data_governance] 获取备份列表失败: {}", e);
        format!("获取备份列表失败: {}", e)
    })?;

    let manifest = manifests
        .iter()
        .find(|m| m.backup_id == validated_backup_id)
        .ok_or_else(|| format!("未找到备份: {}", validated_backup_id))?;

    let db_size: u64 = manifest.files.iter().map(|f| f.size).sum();
    let asset_size: u64 = manifest.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
    let backup_size = db_size + asset_size;

    // 所需空间 = 备份大小 × 2（解压 + 恢复预留）
    let required_bytes = backup_size.saturating_mul(2);

    // 获取应用数据目录所在磁盘的可用空间
    let available_bytes =
        crate::backup_common::get_available_disk_space(&app_data_dir).map_err(|e| {
            error!("[data_governance] 获取可用磁盘空间失败: {}", e);
            format!("获取可用磁盘空间失败: {}", e)
        })?;

    let has_enough_space = available_bytes >= required_bytes;

    info!(
        "[data_governance] 磁盘空间检查: backup_size={}, required={}, available={}, enough={}",
        backup_size, required_bytes, available_bytes, has_enough_space
    );

    Ok(DiskSpaceCheckResponse {
        has_enough_space,
        available_bytes,
        required_bytes,
        backup_size,
    })
}

/// 验证备份
///
/// 验证备份文件的完整性。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要验证的备份 ID
///
/// ## 返回
/// - `BackupVerifyResponse`: 验证结果
#[tauri::command]
pub async fn data_governance_verify_backup(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupVerifyResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;
    info!("[data_governance] 验证备份: {}", validated_backup_id);

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err("备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置".to_string());
    }

    let manager = BackupManager::new(backup_dir.clone());

    // 全局互斥：避免与正在运行的备份/恢复/ZIP 导入导出并发
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("获取全局备份锁失败: {}", e))?;

    // 获取备份列表并查找指定的备份
    let manifests = manager
        .list_backups()
        .map_err(|e| format!("获取备份列表失败: {}", e))?;

    let manifest = manifests
        .iter()
        .find(|m| m.backup_id == validated_backup_id)
        .ok_or_else(|| format!("备份不存在: {}", validated_backup_id))?;

    let manifest_dir = backup_dir.join(&manifest.backup_id);
    ensure_existing_path_within_backup_dir(&manifest_dir, &backup_dir)?;

    // 验证备份（包含资产）
    let verify_result = manager.verify_with_assets(manifest);

    let (is_valid, checksum_match, errors) = match verify_result {
        Ok(result) => {
            let mut db_errors = result.database_errors;
            let checksum_match = db_errors.is_empty();
            for ae in result.asset_errors {
                db_errors.push(format!("资产校验失败 [{}]: {}", ae.path, ae.message));
            }
            (result.is_valid, checksum_match, db_errors)
        }
        Err(e) => {
            let error_msg = e.to_string();
            (false, false, vec![error_msg])
        }
    };

    // 构建每个数据库的验证状态
    let databases_verified: Vec<DatabaseVerifyStatus> = manifest
        .files
        .iter()
        .filter_map(|f| {
            f.database_id.as_ref().map(|db_id| DatabaseVerifyStatus {
                id: db_id.clone(),
                is_valid,
                error: if is_valid {
                    None
                } else {
                    Some("校验失败".to_string())
                },
            })
        })
        .collect();

    info!(
        "[data_governance] 备份验证完成: id={}, is_valid={}",
        backup_id, is_valid
    );

    Ok(BackupVerifyResponse {
        is_valid,
        checksum_match,
        databases_verified,
        errors,
    })
}

/// 自动验证最新备份的完整性
///
/// 找到最新的备份，执行完整性验证（PRAGMA integrity_check + SHA256 校验和），
/// 将验证结果写入审计日志，并返回验证结果。
///
/// ## 返回
/// - `AutoVerifyResponse`: 验证结果，包含备份 ID、验证状态和时间
#[tauri::command]
pub async fn data_governance_auto_verify_latest_backup(
    app: tauri::AppHandle,
) -> Result<AutoVerifyResponse, String> {
    info!("[data_governance] 自动验证最新备份完整性");

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err(
            "备份目录不存在，无法执行自动验证。请前往「设置 > 数据治理 > 备份」检查备份目录配置"
                .to_string(),
        );
    }

    let manager = BackupManager::new(backup_dir.clone());

    // 全局互斥：避免与正在运行的备份/恢复/ZIP 导入导出并发
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("获取全局备份锁失败: {}", e))?;

    // 获取备份列表并找到最新的备份
    let manifests = manager
        .list_backups()
        .map_err(|e| format!("获取备份列表失败: {}", e))?;

    if manifests.is_empty() {
        return Err("没有可用的备份，无法执行自动验证。请先创建一个备份".to_string());
    }

    // 按创建时间排序，取最新的
    let latest_manifest = manifests
        .iter()
        .max_by(|a, b| a.created_at.cmp(&b.created_at))
        .ok_or_else(|| "无法确定最新备份".to_string())?;

    let backup_id = latest_manifest.backup_id.clone();
    let verified_at = chrono::Utc::now().to_rfc3339();
    let start = std::time::Instant::now();

    info!("[data_governance] 自动验证备份: {}", backup_id);

    // 执行验证
    let verify_result = manager.verify_with_assets(latest_manifest);

    let duration_ms = start.elapsed().as_millis() as u64;

    let (is_valid, errors) = match verify_result {
        Ok(result) => {
            let mut all_errors = result.database_errors;
            for ae in result.asset_errors {
                all_errors.push(format!("资产校验失败 [{}]: {}", ae.path, ae.message));
            }
            (result.is_valid, all_errors)
        }
        Err(e) => (false, vec![e.to_string()]),
    };

    // 构建每个数据库的验证状态
    let databases_verified: Vec<DatabaseVerifyStatus> = latest_manifest
        .files
        .iter()
        .filter_map(|f| {
            f.database_id.as_ref().map(|db_id| DatabaseVerifyStatus {
                id: db_id.clone(),
                is_valid,
                error: if is_valid {
                    None
                } else {
                    Some("校验失败".to_string())
                },
            })
        })
        .collect();

    // 写入审计日志
    #[cfg(feature = "data_governance")]
    {
        let auto_verify_size: u64 = latest_manifest.files.iter().map(|f| f.size).sum::<u64>()
            + latest_manifest
                .assets
                .as_ref()
                .map(|a| a.total_size)
                .unwrap_or(0);
        let audit_log = AuditLog::new(
            AuditOperation::Backup {
                backup_type: super::audit::BackupType::Auto,
                file_count: latest_manifest.files.len(),
                total_size: auto_verify_size,
            },
            format!("auto_verify/{}", backup_id),
        )
        .with_details(serde_json::json!({
            "action": "auto_verify",
            "backup_id": backup_id,
            "is_valid": is_valid,
            "databases_verified": databases_verified.len(),
            "errors": errors,
            "duration_ms": duration_ms,
        }));

        let audit_log = if is_valid {
            audit_log.complete(duration_ms)
        } else {
            audit_log.fail(errors.join("; "))
        };

        try_save_audit_log(&app, audit_log);
    }

    info!(
        "[data_governance] 自动验证完成: backup_id={}, is_valid={}, duration={}ms",
        backup_id, is_valid, duration_ms
    );

    Ok(AutoVerifyResponse {
        backup_id,
        is_valid,
        verified_at,
        duration_ms,
        databases_verified,
        errors,
    })
}

/// 自动验证响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AutoVerifyResponse {
    /// 被验证的备份 ID
    pub backup_id: String,
    /// 是否通过验证
    pub is_valid: bool,
    /// 验证时间 (ISO 8601)
    pub verified_at: String,
    /// 验证耗时（毫秒）
    pub duration_ms: u64,
    /// 数据库验证状态
    pub databases_verified: Vec<DatabaseVerifyStatus>,
    /// 错误列表
    pub errors: Vec<String>,
}

/// 备份结果响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupResultResponse {
    pub success: bool,
    pub backup_path: String,
    pub backup_size: u64,
    pub duration_ms: u64,
    pub databases_backed_up: Vec<String>,
    /// 资产备份摘要（如果包含资产备份）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_backed_up: Option<AssetBackupSummary>,
}

/// 资产备份摘要
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetBackupSummary {
    /// 备份的文件总数
    pub total_files: usize,
    /// 备份的总大小（字节）
    pub total_size: u64,
    /// 按资产类型统计
    pub by_type: std::collections::HashMap<String, AssetTypeStats>,
}

/// 备份信息响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupInfoResponse {
    pub path: String,
    pub created_at: String,
    pub size: u64,
    pub backup_type: String,
    pub databases: Vec<String>,
}

/// 备份验证响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupVerifyResponse {
    pub is_valid: bool,
    pub checksum_match: bool,
    pub databases_verified: Vec<DatabaseVerifyStatus>,
    pub errors: Vec<String>,
}

/// 数据库验证状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseVerifyStatus {
    pub id: String,
    pub is_valid: bool,
    pub error: Option<String>,
}

/// 后台备份任务启动响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupJobStartResponse {
    /// 任务 ID，用于查询状态和取消
    pub job_id: String,
    /// 任务类型
    pub kind: String,
    /// 初始状态
    pub status: String,
    /// 提示消息
    pub message: String,
}

/// 磁盘空间检查响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskSpaceCheckResponse {
    /// 是否有足够空间
    pub has_enough_space: bool,
    /// 可用空间（字节）
    pub available_bytes: u64,
    /// 需要空间（字节，含安全余量）
    pub required_bytes: u64,
    /// 备份大小（字节）
    pub backup_size: u64,
}

// ==================== 后台备份任务命令 ====================

/// 异步后台备份（带进度事件）
///
/// 启动后台备份任务，立即返回任务 ID。备份进度通过 `backup-job-progress` 事件发送。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_type`: 备份类型，"full"（完整）或 "incremental"（增量）
/// - `base_version`: 增量备份的基础版本（仅增量备份需要）
/// - `include_assets`: 是否包含资产文件备份
/// - `asset_types`: 要备份的资产类型列表（可选，默认全部）
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
#[tauri::command]
pub async fn data_governance_run_backup(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    backup_type: Option<String>,
    base_version: Option<String>,
    include_assets: Option<bool>,
    asset_types: Option<Vec<String>>,
) -> Result<BackupJobStartResponse, String> {
    let backup_type = backup_type.unwrap_or_else(|| "full".to_string());
    let include_assets = include_assets.unwrap_or(false);
    info!(
        "[data_governance] 启动后台备份任务: type={}, include_assets={}",
        backup_type, include_assets
    );

    // 使用全局单例备份任务管理器
    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Export);
    let job_id = job_ctx.job_id.clone();

    #[cfg(feature = "data_governance")]
    {
        let audit_backup_type = if backup_type == "incremental" {
            super::audit::BackupType::Incremental
        } else {
            super::audit::BackupType::Full
        };
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: audit_backup_type,
                    file_count: 0,
                    total_size: 0,
                },
                format!("governance_backup/{}", backup_type),
            )
            .with_details(serde_json::json!({
                "job_id": job_id.clone(),
                "backup_type": backup_type.clone(),
                "base_version": base_version.clone(),
                "include_assets": include_assets,
                "asset_types": asset_types.clone(),
            })),
        );
    }

    // 在后台执行备份
    let app_clone = app.clone();
    let base_version_clone = base_version.clone();
    let asset_types_clone = asset_types.clone();

    tauri::async_runtime::spawn(async move {
        execute_backup_with_progress(
            app_clone,
            job_ctx,
            backup_type,
            base_version_clone,
            include_assets,
            asset_types_clone,
        )
        .await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "export".to_string(),
        status: "queued".to_string(),
        message: "备份任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

/// 执行备份（内部函数，带进度回调）
async fn execute_backup_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    backup_type: String,
    base_version: Option<String>,
    include_assets: bool,
    asset_types: Option<Vec<String>>,
) {
    use super::backup::{AssetBackupConfig, AssetType, BackupManager};
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 设置任务参数（用于持久化和恢复）
    job_ctx.set_params(BackupJobParams {
        backup_type: Some(backup_type.clone()),
        base_version: base_version.clone(),
        include_assets,
        asset_types: asset_types.clone(),
        ..Default::default()
    });

    // 初始化检查点
    job_ctx.init_checkpoint(4); // 4 个数据库

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            let msg = format!("获取应用数据目录失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("governance_backup/{}", job_ctx.job_id),
                    )
                    .fail(msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_id": job_ctx.job_id.clone(),
                        "subtype": "backup",
                    })),
                );
            }
            job_ctx.fail(msg);
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 确保备份目录存在
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    // 阶段 1: 准备中
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        5.0,
        Some("正在准备备份...".to_string()),
        0,
        4, // 总共 4 个数据库
    );

    // 检查取消
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 创建备份管理器
    let mut manager = BackupManager::new(backup_dir);
    manager.set_app_data_dir(app_data_dir.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // 设置逐数据库进度回调（页面级细粒度）
    {
        let job_ctx_clone = job_ctx.clone();
        manager.set_progress_callback(
            move |db_idx, total_dbs, db_name, pages_copied, pages_total| {
                // 整体进度：15% ~ 75%，按数据库+页面比例细分
                let db_fraction = if total_dbs > 0 {
                    db_idx as f32 / total_dbs as f32
                } else {
                    1.0
                };
                let page_fraction = if pages_total > 0 {
                    pages_copied as f32 / pages_total as f32
                } else {
                    0.0
                };
                let per_db = if total_dbs > 0 {
                    1.0 / total_dbs as f32
                } else {
                    1.0
                };
                let progress = 15.0 + (db_fraction + page_fraction * per_db) * 60.0;

                let msg = if pages_total > 0 {
                    format!(
                        "正在备份数据库: {} ({}/{}) - {:.0}%",
                        db_name,
                        db_idx + 1,
                        total_dbs,
                        page_fraction * 100.0
                    )
                } else {
                    format!("正在备份数据库: {} ({}/{})", db_name, db_idx + 1, total_dbs)
                };

                job_ctx_clone.mark_running(
                    BackupJobPhase::Compress,
                    progress,
                    Some(msg),
                    db_idx as u64,
                    total_dbs as u64,
                );
            },
        );
    }

    // 阶段 2: 执行 checkpoint
    job_ctx.mark_running(
        BackupJobPhase::Checkpoint,
        10.0,
        Some("正在执行数据库 checkpoint...".to_string()),
        0,
        4,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 根据备份类型执行备份
    let result = match backup_type.as_str() {
        "incremental" => {
            let base = match base_version {
                Some(v) => v,
                None => {
                    job_ctx.fail("增量备份需要指定 base_version 参数".to_string());
                    return;
                }
            };

            // 阶段 3: 复制数据库
            job_ctx.mark_running(
                BackupJobPhase::Compress,
                30.0,
                Some("正在执行增量备份...".to_string()),
                0,
                4,
            );

            manager.backup_incremental(&base)
        }
        _ => {
            if include_assets {
                // 构建资产备份配置
                let asset_config = if let Some(types) = asset_types {
                    let parsed_types: Vec<AssetType> = types
                        .iter()
                        .filter_map(|s| AssetType::from_str(s))
                        .collect();
                    if parsed_types.is_empty() {
                        AssetBackupConfig::default()
                    } else {
                        AssetBackupConfig {
                            asset_types: parsed_types,
                            ..Default::default()
                        }
                    }
                } else {
                    AssetBackupConfig::default()
                };

                // 阶段 3: 复制数据库和资产
                job_ctx.mark_running(
                    BackupJobPhase::Compress,
                    30.0,
                    Some("正在备份数据库和资产文件...".to_string()),
                    0,
                    4,
                );

                manager.backup_with_assets(Some(asset_config))
            } else {
                // 阶段 3: 复制数据库
                job_ctx.mark_running(
                    BackupJobPhase::Compress,
                    30.0,
                    Some("正在备份数据库...".to_string()),
                    0,
                    4,
                );

                manager.backup_full()
            }
        }
    };

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 阶段 4: 验证
    job_ctx.mark_running(
        BackupJobPhase::Verify,
        80.0,
        Some("正在验证备份...".to_string()),
        3,
        4,
    );

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(manifest) => {
            // 计算备份大小
            let db_size: u64 = manifest.files.iter().map(|f| f.size).sum();
            let asset_size: u64 = manifest.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
            let backup_size = db_size + asset_size;

            let databases_backed_up: Vec<String> = manifest
                .files
                .iter()
                .filter_map(|f| f.database_id.clone())
                .collect();

            info!(
                "[data_governance] 后台备份成功: id={}, files={}, size={}, duration={}ms",
                manifest.backup_id,
                manifest.files.len(),
                backup_size,
                duration_ms
            );

            #[cfg(feature = "data_governance")]
            {
                let audit_backup_type = if backup_type == "incremental" {
                    super::audit::BackupType::Incremental
                } else {
                    super::audit::BackupType::Full
                };
                let asset_files = manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0);
                let file_count = manifest.files.len() + asset_files;

                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: audit_backup_type,
                            file_count,
                            total_size: backup_size,
                        },
                        manifest.backup_id.clone(),
                    )
                    .complete(duration_ms)
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_type": backup_type.clone(),
                        "include_assets": include_assets,
                        "db_files": manifest.files.len(),
                        "asset_files": asset_files,
                        "db_size": db_size,
                        "asset_size": asset_size,
                    })),
                );
            }

            // 备份成功后自动验证完整性
            let auto_verify_result = manager.verify_with_assets(&manifest);
            let (verify_is_valid, verify_errors): (bool, Vec<String>) = match auto_verify_result {
                Ok(result) => {
                    let mut all_errors = result.database_errors;
                    for ae in result.asset_errors {
                        all_errors.push(format!("资产校验失败 [{}]: {}", ae.path, ae.message));
                    }
                    (result.is_valid, all_errors)
                }
                Err(e) => (false, vec![e.to_string()]),
            };

            if verify_is_valid {
                info!(
                    "[data_governance] 备份后自动验证通过: {}",
                    manifest.backup_id
                );
            } else {
                warn!(
                    "[data_governance] 备份后自动验证失败: {}, errors={:?}",
                    manifest.backup_id, verify_errors
                );
            }

            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Auto,
                            file_count: manifest.files.len(),
                            total_size: backup_size,
                        },
                        format!("post_backup_verify/{}", manifest.backup_id),
                    )
                    .with_details(serde_json::json!({
                        "action": "post_backup_auto_verify",
                        "backup_id": manifest.backup_id.clone(),
                        "is_valid": verify_is_valid,
                        "errors": verify_errors,
                    }))
                    .complete(start.elapsed().as_millis() as u64),
                );
            }

            // 构建结果 payload
            let verify_error = if verify_is_valid {
                None
            } else {
                Some("备份完成但校验失败，请在审计页查看详情并重新执行备份。".to_string())
            };

            let result_payload = BackupJobResultPayload {
                success: verify_is_valid,
                output_path: Some(manifest.backup_id.clone()),
                resolved_path: None,
                message: Some(format!(
                    "备份完成: {} 个数据库, {} 字节",
                    databases_backed_up.len(),
                    backup_size
                )),
                error: verify_error,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "databases_backed_up": databases_backed_up,
                    "backup_size": backup_size,
                    "db_files": manifest.files.len(),
                    "asset_files": manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0),
                    "auto_verify": {
                        "is_valid": verify_is_valid,
                        "errors": verify_errors,
                    },
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            };

            job_ctx.complete(
                Some(format!("备份完成: {}", manifest.backup_id)),
                databases_backed_up.len() as u64,
                databases_backed_up.len() as u64,
                result_payload,
            );
        }
        Err(e) => {
            error!("[data_governance] 后台备份失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                let audit_backup_type = if backup_type == "incremental" {
                    super::audit::BackupType::Incremental
                } else {
                    super::audit::BackupType::Full
                };
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: audit_backup_type,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("governance_backup/{}", backup_type),
                    )
                    .fail(e.to_string())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_type": backup_type.clone(),
                        "include_assets": include_assets,
                    })),
                );
            }
            job_ctx.fail(format!("备份失败: {}", e));
        }
    }
}

/// 取消备份任务
///
/// 请求取消指定的备份任务。任务会在下一个安全点停止。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `job_id`: 任务 ID
///
/// ## 返回
/// - `bool`: 是否成功请求取消
#[tauri::command]
pub async fn data_governance_cancel_backup(
    backup_job_state: State<'_, BackupJobManagerState>,
    job_id: String,
) -> Result<bool, String> {
    info!("[data_governance] 请求取消备份任务: {}", job_id);

    let job_manager = backup_job_state.get();
    let cancelled = job_manager.request_cancel(&job_id);

    if cancelled {
        info!("[data_governance] 备份任务取消请求已发送: {}", job_id);
    } else {
        warn!(
            "[data_governance] 备份任务取消请求失败（任务可能已完成或不存在）: {}",
            job_id
        );
    }

    Ok(cancelled)
}

/// 获取备份任务状态
///
/// 查询指定备份任务的当前状态。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `job_id`: 任务 ID
///
/// ## 返回
/// - `BackupJobSummary`: 任务摘要
#[tauri::command]
pub async fn data_governance_get_backup_job(
    backup_job_state: State<'_, BackupJobManagerState>,
    job_id: String,
) -> Result<Option<BackupJobSummary>, String> {
    let job_manager = backup_job_state.get();
    Ok(job_manager.get_job(&job_id))
}

/// 获取所有备份任务列表
///
/// 返回所有备份任务的摘要列表。
///
/// ## 参数
/// - `app`: Tauri AppHandle
///
/// ## 返回
/// - `Vec<BackupJobSummary>`: 任务列表
#[tauri::command]
pub async fn data_governance_list_backup_jobs(
    backup_job_state: State<'_, BackupJobManagerState>,
) -> Result<Vec<BackupJobSummary>, String> {
    let job_manager = backup_job_state.get();
    Ok(job_manager.list_jobs())
}

/// 获取可恢复的备份任务列表
///
/// 返回所有可以恢复的失败备份任务列表。
///
/// ## 参数
/// - `app`: Tauri AppHandle
///
/// ## 返回
/// - `Vec<PersistedJob>`: 可恢复的任务列表
#[tauri::command]
pub async fn data_governance_list_resumable_jobs(
    backup_job_state: State<'_, BackupJobManagerState>,
) -> Result<Vec<PersistedJob>, String> {
    let job_manager = backup_job_state.get();
    job_manager.list_resumable_jobs()
}

/// 恢复中断的备份任务
///
/// 根据任务类型采取不同的恢复策略：
/// - **导出（Export）**：由于备份操作是原子的，恢复 = 使用相同参数重新执行完整备份
/// - **导入（Import/ZIP）**：真正的断点续传，跳过已解压且大小匹配的文件
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `job_id`: 要恢复的任务 ID
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID（恢复任务使用原 ID）
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
///
/// ## 注意
/// - 只能恢复失败状态且有检查点的任务
/// - 成功恢复后，原持久化文件会在任务完成时删除
#[tauri::command]
pub async fn data_governance_resume_backup_job(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    job_id: String,
) -> Result<BackupJobStartResponse, String> {
    info!("[data_governance] 尝试恢复备份任务: job_id={}", job_id);

    let job_manager = backup_job_state.get();

    // 加载持久化的任务
    let persisted_jobs = job_manager.load_persisted_jobs()?;
    let persisted = persisted_jobs
        .into_iter()
        .find(|j| j.job_id == job_id)
        .ok_or_else(|| format!("未找到可恢复的任务: {}", job_id))?;

    // 检查任务是否可恢复
    if persisted.status != BackupJobStatus::Failed {
        return Err(format!(
            "任务状态为 {:?}，仅失败状态的任务可恢复。请等待任务完成或创建新任务",
            persisted.status
        ));
    }

    if persisted.checkpoint.is_none() {
        return Err("任务没有检查点信息，无法恢复。请创建新的备份任务重试".to_string());
    }

    // 恢复任务上下文
    let job_ctx = job_manager.restore_job_from_persisted(&persisted);
    let restored_job_id = job_ctx.job_id.clone();

    // 根据任务类型执行恢复
    match persisted.kind {
        BackupJobKind::Export => {
            // 解析参数
            let params: BackupJobParams =
                serde_json::from_value(persisted.params.clone()).unwrap_or_default();

            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                execute_backup_with_progress_resumable(
                    app_clone,
                    job_ctx,
                    params.backup_type.unwrap_or_else(|| "full".to_string()),
                    params.base_version,
                    params.include_assets,
                    params.asset_types,
                )
                .await;
            });

            Ok(BackupJobStartResponse {
                job_id: restored_job_id,
                kind: "export".to_string(),
                status: "queued".to_string(),
                message: "备份任务已恢复，将使用相同参数重新执行".to_string(),
            })
        }
        BackupJobKind::Import => {
            // 解析参数
            let params: BackupJobParams =
                serde_json::from_value(persisted.params.clone()).unwrap_or_default();

            let zip_path = params
                .zip_path
                .ok_or_else(|| "导入任务缺少 ZIP 路径参数".to_string())?;
            let zip_file_path = PathBuf::from(&zip_path);

            if !zip_file_path.exists() {
                return Err(format!(
                    "ZIP 文件不存在: {}。请确认文件路径正确，或重新选择文件",
                    sanitize_path_for_user(&zip_file_path)
                ));
            }

            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                execute_zip_import_with_progress_resumable(
                    app_clone,
                    job_ctx,
                    zip_file_path,
                    params.backup_id,
                )
                .await;
            });

            Ok(BackupJobStartResponse {
                job_id: restored_job_id,
                kind: "import".to_string(),
                status: "queued".to_string(),
                message: "导入任务已恢复，将从断点继续解压".to_string(),
            })
        }
    }
}

/// 清理所有已完成的持久化任务
///
/// 删除所有已完成或已取消的任务的持久化文件。
///
/// ## 参数
/// - `app`: Tauri AppHandle
///
/// ## 返回
/// - `usize`: 清理的任务数量
#[tauri::command]
pub async fn data_governance_cleanup_persisted_jobs(
    backup_job_state: State<'_, BackupJobManagerState>,
) -> Result<usize, String> {
    let job_manager = backup_job_state.get();
    job_manager.cleanup_finished_persisted_jobs()
}

// ==================== 分层备份命令 ====================

/// 异步分层备份（后台任务模式）
///
/// 启动后台分层备份任务，立即返回任务 ID。备份进度通过 `backup-job-progress` 事件发送。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `tiers`: 要备份的层级列表（可选，默认仅 Core）
/// - `include_databases`: 显式包含的数据库（可选）
/// - `exclude_databases`: 显式排除的数据库（可选）
/// - `include_assets`: 是否包含资产文件（可选，默认 false）
/// - `max_asset_size`: 最大资产文件大小（字节）（可选）
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
///
/// ## 进度阶段
/// - Scan (5%): 扫描数据库和资产
/// - Checkpoint (15%): WAL checkpoint
/// - Compress (15-80%): 按层级备份数据库（每个数据库更新一次进度）
/// - Assets (80-95%): 备份资产文件（如果包含）
/// - Verify (95-100%): 验证备份
#[tauri::command]
pub async fn data_governance_backup_tiered(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    tiers: Option<Vec<String>>,
    include_databases: Option<Vec<String>>,
    exclude_databases: Option<Vec<String>>,
    include_assets: Option<bool>,
    max_asset_size: Option<u64>,
    asset_types: Option<Vec<String>>,
) -> Result<BackupJobStartResponse, String> {
    info!(
        "[data_governance] 启动后台分层备份任务: tiers={:?}, include_assets={:?}, asset_types={:?}",
        tiers, include_assets, asset_types
    );

    // 使用全局单例备份任务管理器
    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Export);
    let job_id = job_ctx.job_id.clone();

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Full,
                    file_count: 0,
                    total_size: 0,
                },
                "governance_backup/tiered".to_string(),
            )
            .with_details(serde_json::json!({
                "job_id": job_id.clone(),
                "tiers": tiers.clone(),
                "include_databases": include_databases.clone(),
                "exclude_databases": exclude_databases.clone(),
                "include_assets": include_assets.unwrap_or(false),
                "max_asset_size": max_asset_size,
            })),
        );
    }

    // 在后台执行分层备份
    let app_clone = app.clone();
    let tiers_clone = tiers.clone();
    let include_databases_clone = include_databases.clone();
    let exclude_databases_clone = exclude_databases.clone();
    let asset_types_clone = asset_types.clone();

    tauri::async_runtime::spawn(async move {
        execute_tiered_backup_with_progress(
            app_clone,
            job_ctx,
            tiers_clone,
            include_databases_clone,
            exclude_databases_clone,
            include_assets.unwrap_or(false),
            max_asset_size,
            asset_types_clone,
        )
        .await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "export".to_string(),
        status: "queued".to_string(),
        message: "分层备份任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

/// 执行分层备份（内部函数，带进度回调）
async fn execute_tiered_backup_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    tiers: Option<Vec<String>>,
    include_databases: Option<Vec<String>>,
    exclude_databases: Option<Vec<String>>,
    include_assets: bool,
    max_asset_size: Option<u64>,
    asset_types: Option<Vec<String>>,
) {
    use super::backup::{BackupManager, BackupSelection, BackupTier, TieredAssetConfig};
    use super::schema_registry::DatabaseId;
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 确保备份目录存在
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    // 阶段 1: 扫描 (5%)
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        5.0,
        Some("正在扫描数据库和资产...".to_string()),
        0,
        0,
    );

    // 检查取消
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 解析层级参数
    let parsed_tiers: Vec<BackupTier> = tiers
        .unwrap_or_else(|| vec!["core".to_string()])
        .iter()
        .filter_map(|t| match t.to_lowercase().as_str() {
            "core" => Some(BackupTier::Core),
            "important" => Some(BackupTier::Important),
            "rebuildable" => Some(BackupTier::Rebuildable),
            "large_assets" | "largeassets" => Some(BackupTier::LargeAssets),
            _ => {
                warn!("[data_governance] 未知的备份层级: {}", t);
                None
            }
        })
        .collect();

    // 构建资产配置（支持 assetTypes 筛选）
    let asset_config = if include_assets {
        let mut config = TieredAssetConfig {
            max_file_size: max_asset_size.unwrap_or(100 * 1024 * 1024),
            ..Default::default()
        };
        // 如果前端传入了 asset_types，按类型过滤
        if let Some(types) = asset_types {
            let parsed_types: Vec<AssetType> = types
                .iter()
                .filter_map(|s| AssetType::from_str(s))
                .collect();
            if !parsed_types.is_empty() {
                config.asset_types = parsed_types;
            }
        }
        Some(config)
    } else {
        None
    };

    // 构建备份选择配置
    let selection = BackupSelection {
        tiers: parsed_tiers.clone(),
        include_databases: include_databases.unwrap_or_default(),
        exclude_databases: exclude_databases.unwrap_or_default(),
        include_assets,
        asset_config,
    };

    // 计算需要备份的数据库数量
    let db_ids: Vec<DatabaseId> = DatabaseId::all_ordered()
        .into_iter()
        .filter(|db_id| selection.should_backup_database(db_id))
        .collect();
    let total_databases = db_ids.len();

    // 阶段 2: Checkpoint (15%)
    job_ctx.mark_running(
        BackupJobPhase::Checkpoint,
        15.0,
        Some("正在执行数据库 checkpoint...".to_string()),
        0,
        total_databases as u64,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 创建备份管理器
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(app_data_dir.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // 阶段 3: 压缩/备份数据库 (15-80%)
    // 通过进度回调实时报告每个数据库的备份进度
    let db_progress_start = 15.0;
    let db_progress_end = if include_assets { 80.0 } else { 95.0 };
    let db_progress_range = db_progress_end - db_progress_start;

    {
        let job_ctx_clone = job_ctx.clone();
        manager.set_progress_callback(
            move |db_idx, total_dbs, db_name, pages_copied, pages_total| {
                // 检查取消
                if job_ctx_clone.is_cancelled() {
                    return;
                }
                let db_fraction = if total_dbs > 0 {
                    db_idx as f32 / total_dbs as f32
                } else {
                    1.0
                };
                let page_fraction = if pages_total > 0 {
                    pages_copied as f32 / pages_total as f32
                } else {
                    0.0
                };
                let per_db = if total_dbs > 0 {
                    1.0 / total_dbs as f32
                } else {
                    1.0
                };
                let progress =
                    db_progress_start + (db_fraction + page_fraction * per_db) * db_progress_range;

                let msg = if pages_total > 0 {
                    format!(
                        "正在备份数据库: {} ({}/{}) - {:.0}%",
                        db_name,
                        db_idx + 1,
                        total_dbs,
                        page_fraction * 100.0
                    )
                } else {
                    format!("正在备份数据库: {} ({}/{})", db_name, db_idx + 1, total_dbs)
                };

                job_ctx_clone.mark_running(
                    BackupJobPhase::Compress,
                    progress,
                    Some(msg),
                    db_idx as u64,
                    total_dbs as u64,
                );
            },
        );
    }

    // 执行实际的分层备份
    let result = match manager.backup_tiered(&selection) {
        Ok(r) => r,
        Err(e) => {
            error!("[data_governance] 分层备份失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        "governance_backup/tiered".to_string(),
                    )
                    .fail(e.to_string())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "include_assets": include_assets,
                        "tiers": parsed_tiers.iter().map(|t| format!("{:?}", t)).collect::<Vec<_>>(),
                    })),
                );
            }
            job_ctx.fail(format!("分层备份失败: {}", e));
            return;
        }
    };

    // 阶段 4: 资产备份 (80-95%) - 仅在包含资产时
    if include_assets {
        job_ctx.mark_running(
            BackupJobPhase::Compress,
            90.0,
            Some("正在备份资产文件...".to_string()),
            total_databases as u64,
            total_databases as u64,
        );

        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消备份".to_string()));
            return;
        }
    }

    // 阶段 5: 验证 (95-100%)
    job_ctx.mark_running(
        BackupJobPhase::Verify,
        95.0,
        Some("正在验证备份...".to_string()),
        total_databases as u64,
        total_databases as u64,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 构建结果统计
    let duration_ms = start.elapsed().as_millis() as u64;
    let total_size: u64 = result.manifest.files.iter().map(|f| f.size).sum();

    // 分层备份成功后自动验证完整性
    let auto_verify_result = manager.verify(&result.manifest);
    let verify_is_valid = auto_verify_result.is_ok();
    let verify_errors: Vec<String> = match &auto_verify_result {
        Ok(()) => vec![],
        Err(e) => vec![e.to_string()],
    };

    if verify_is_valid {
        info!(
            "[data_governance] 分层备份后自动验证通过: {}",
            result.manifest.backup_id
        );
    } else {
        warn!(
            "[data_governance] 分层备份后自动验证失败: {}, errors={:?}",
            result.manifest.backup_id, verify_errors
        );
    }

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Auto,
                    file_count: result.manifest.files.len(),
                    total_size,
                },
                format!("post_backup_verify/{}", result.manifest.backup_id),
            )
            .with_details(serde_json::json!({
                "action": "post_backup_auto_verify",
                "backup_id": result.manifest.backup_id.clone(),
                "is_valid": verify_is_valid,
                "errors": verify_errors,
            }))
            .complete(start.elapsed().as_millis() as u64),
        );
    }

    // 构建结果 payload
    let stats = serde_json::json!({
        "backup_id": result.manifest.backup_id,
        "backed_up_tiers": result.backed_up_tiers.iter().map(|t| format!("{:?}", t)).collect::<Vec<_>>(),
        "tier_file_counts": result.tier_file_counts,
        "tier_sizes": result.tier_sizes,
        "total_files": result.manifest.files.len(),
        "total_size": total_size,
        "skipped_files_count": result.skipped_files.len(),
        "auto_verify": {
            "is_valid": verify_is_valid,
            "errors": verify_errors,
        },
    });

    let verify_error = if verify_is_valid {
        None
    } else {
        Some("分层备份完成但校验失败，请在审计页查看详情并重新执行备份。".to_string())
    };

    let result_payload = BackupJobResultPayload {
        success: verify_is_valid,
        output_path: Some(
            backup_dir
                .join(&result.manifest.backup_id)
                .to_string_lossy()
                .to_string(),
        ),
        resolved_path: None,
        message: Some(format!(
            "分层备份完成，共 {} 个文件，大小 {} 字节",
            result.manifest.files.len(),
            total_size
        )),
        error: verify_error,
        duration_ms: Some(duration_ms),
        stats: Some(stats),
        requires_restart: false,
        checkpoint_path: None,
        resumable_job_id: None,
    };

    info!(
        "[data_governance] 分层备份成功: id={}, files={}, duration={}ms",
        result.manifest.backup_id,
        result.manifest.files.len(),
        duration_ms
    );

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Full,
                    file_count: result.manifest.files.len(),
                    total_size,
                },
                result.manifest.backup_id.clone(),
            )
            .complete(duration_ms)
            .with_details(serde_json::json!({
                "job_id": job_ctx.job_id.clone(),
                "include_assets": include_assets,
                "tiers": parsed_tiers.iter().map(|t| format!("{:?}", t)).collect::<Vec<_>>(),
                "tier_file_counts": result.tier_file_counts,
                "tier_sizes": result.tier_sizes,
                "skipped_files_count": result.skipped_files.len(),
            })),
        );
    }

    job_ctx.complete(
        Some(format!(
            "分层备份完成: {}，共 {} 个文件",
            result.manifest.backup_id,
            result.manifest.files.len()
        )),
        result.manifest.files.len() as u64,
        result.manifest.files.len() as u64,
        result_payload,
    );
}

// ==================== ZIP 导出命令 ====================

/// 一步完成「备份 + 导出 ZIP」（后台任务模式）
///
/// 默认行为：完整备份（数据库 + 资产）后直接导出到指定 ZIP 路径。
/// 若 `use_tiered=true`，则按分层参数执行备份后导出 ZIP。
#[tauri::command]
pub async fn data_governance_backup_and_export_zip(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    output_path: String,
    compression_level: Option<u32>,
    add_to_backup_list: Option<bool>,
    use_tiered: Option<bool>,
    tiers: Option<Vec<String>>,
    include_assets: Option<bool>,
    asset_types: Option<Vec<String>>,
) -> Result<BackupJobStartResponse, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let user_output = PathBuf::from(&output_path);
    validate_user_path(&user_output, &app_data_dir)?;

    let compression_level = compression_level.unwrap_or(6).min(9);
    let add_to_backup_list = add_to_backup_list.unwrap_or(true);
    let use_tiered = use_tiered.unwrap_or(false);

    info!(
        "[data_governance] 启动后台备份并导出 ZIP 任务: output_path={}, compression={}, add_to_backup_list={}, use_tiered={}",
        sanitize_path_for_user(&user_output),
        compression_level,
        add_to_backup_list,
        use_tiered
    );

    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Export);
    let job_id = job_ctx.job_id.clone();

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        execute_backup_and_export_zip_with_progress(
            app_clone,
            job_ctx,
            output_path,
            compression_level,
            add_to_backup_list,
            use_tiered,
            tiers,
            include_assets,
            asset_types,
        )
        .await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "export".to_string(),
        status: "queued".to_string(),
        message: "备份导出任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

async fn execute_backup_and_export_zip_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    output_path: String,
    compression_level: u32,
    add_to_backup_list: bool,
    use_tiered: bool,
    tiers: Option<Vec<String>>,
    include_assets: Option<bool>,
    asset_types: Option<Vec<String>>,
) {
    use super::backup::BackupTier;

    let start = Instant::now();

    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    job_ctx.set_params(BackupJobParams {
        backup_type: Some(if use_tiered {
            "tiered".to_string()
        } else {
            "full".to_string()
        }),
        include_assets: include_assets.unwrap_or(!use_tiered),
        asset_types: asset_types.clone(),
        output_path: Some(output_path.clone()),
        compression_level: Some(compression_level),
        include_checksums: true,
        ..Default::default()
    });

    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(app_data_dir);
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    job_ctx.mark_running(
        BackupJobPhase::Scan,
        2.0,
        Some("正在准备备份...".to_string()),
        0,
        1,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份导出".to_string()));
        return;
    }

    let backup_progress_start = 5.0;
    let backup_progress_end = 60.0;
    let backup_progress_range = backup_progress_end - backup_progress_start;
    {
        let job_ctx_clone = job_ctx.clone();
        manager.set_progress_callback(
            move |db_idx, total_dbs, db_name, pages_copied, pages_total| {
                let db_fraction = if total_dbs > 0 {
                    db_idx as f32 / total_dbs as f32
                } else {
                    1.0
                };
                let page_fraction = if pages_total > 0 {
                    pages_copied as f32 / pages_total as f32
                } else {
                    0.0
                };
                let per_db = if total_dbs > 0 {
                    1.0 / total_dbs as f32
                } else {
                    1.0
                };
                let progress = backup_progress_start
                    + (db_fraction + page_fraction * per_db) * backup_progress_range;
                let msg = if pages_total > 0 {
                    format!(
                        "正在备份数据库: {} ({}/{}) - {:.0}%",
                        db_name,
                        db_idx + 1,
                        total_dbs,
                        page_fraction * 100.0
                    )
                } else {
                    format!("正在备份数据库: {} ({}/{})", db_name, db_idx + 1, total_dbs)
                };

                job_ctx_clone.mark_running(
                    BackupJobPhase::Checkpoint,
                    progress,
                    Some(msg),
                    db_idx as u64,
                    total_dbs as u64,
                );
            },
        );
    }

    let include_assets = include_assets.unwrap_or(!use_tiered);

    let backup_result: Result<String, String> = if use_tiered {
        let parsed_tiers: Vec<BackupTier> = tiers
            .unwrap_or_else(|| vec!["core".to_string()])
            .into_iter()
            .filter_map(|tier| match tier.to_lowercase().as_str() {
                "core" => Some(BackupTier::Core),
                "important" => Some(BackupTier::Important),
                "rebuildable" => Some(BackupTier::Rebuildable),
                "large_assets" | "largeassets" => Some(BackupTier::LargeAssets),
                other => {
                    warn!("[data_governance] 未知分层备份层级: {}", other);
                    None
                }
            })
            .collect();

        if parsed_tiers.is_empty() {
            job_ctx.fail("分层备份至少需要一个有效层级".to_string());
            return;
        }

        let tiered_asset_config = if include_assets {
            let mut config = TieredAssetConfig::default();
            if let Some(types) = asset_types.clone() {
                let parsed_types: Vec<AssetType> = types
                    .iter()
                    .filter_map(|s| AssetType::from_str(s))
                    .collect();
                if !parsed_types.is_empty() {
                    config.asset_types = parsed_types;
                }
            }
            Some(config)
        } else {
            None
        };

        let selection = BackupSelection {
            tiers: parsed_tiers,
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets,
            asset_config: tiered_asset_config,
        };

        manager
            .backup_tiered(&selection)
            .map(|result| result.manifest.backup_id)
            .map_err(|e| format!("分层备份失败: {}", e))
    } else if include_assets {
        let asset_config = if let Some(types) = asset_types.clone() {
            let parsed_types: Vec<AssetType> = types
                .iter()
                .filter_map(|s| AssetType::from_str(s))
                .collect();
            if parsed_types.is_empty() {
                AssetBackupConfig::default()
            } else {
                AssetBackupConfig {
                    asset_types: parsed_types,
                    ..Default::default()
                }
            }
        } else {
            AssetBackupConfig::default()
        };

        manager
            .backup_with_assets(Some(asset_config))
            .map(|manifest| manifest.backup_id)
            .map_err(|e| format!("完整备份失败: {}", e))
    } else {
        manager
            .backup_full()
            .map(|manifest| manifest.backup_id)
            .map_err(|e| format!("备份失败: {}", e))
    };

    let backup_id = match backup_result {
        Ok(id) => id,
        Err(err) => {
            job_ctx.fail(err);
            return;
        }
    };

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份导出".to_string()));
        return;
    }

    let source_backup_dir = backup_dir.join(&backup_id);
    if let Err(e) = ensure_existing_path_within_backup_dir(&source_backup_dir, &backup_dir) {
        job_ctx.fail(format!("备份路径校验失败: {}", e));
        return;
    }

    job_ctx.mark_running(
        BackupJobPhase::Compress,
        62.0,
        Some("正在压缩 ZIP 文件...".to_string()),
        0,
        1,
    );

    let export_result = export_backup_to_zip(
        &source_backup_dir,
        &ZipExportOptions {
            output_path: Some(PathBuf::from(&output_path)),
            compression_level,
            include_checksums: true,
            ..Default::default()
        },
    );

    let export_result = match export_result {
        Ok(result) => result,
        Err(e) => {
            job_ctx.fail(format!("ZIP 导出失败: {}", e));
            return;
        }
    };

    job_ctx.mark_running(
        BackupJobPhase::Verify,
        96.0,
        Some("正在完成导出...".to_string()),
        1,
        1,
    );

    if !add_to_backup_list {
        if let Err(e) = manager.delete_backup(&backup_id) {
            warn!(
                "[data_governance] 备份已导出但清理中间目录失败: {} - {}",
                backup_id, e
            );
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let result_payload = BackupJobResultPayload {
        success: true,
        output_path: Some(export_result.zip_path.to_string_lossy().to_string()),
        resolved_path: None,
        message: Some(format!(
            "备份并导出完成: {} 个文件，{} 字节",
            export_result.file_count, export_result.compressed_size
        )),
        error: None,
        duration_ms: Some(duration_ms),
        stats: Some(serde_json::json!({
            "backup_id": backup_id,
            "zip_path": export_result.zip_path,
            "compression_level": compression_level,
            "compression_ratio": export_result.compression_ratio(),
            "add_to_backup_list": add_to_backup_list,
            "use_tiered": use_tiered,
            "include_assets": include_assets,
        })),
        requires_restart: false,
        checkpoint_path: None,
        resumable_job_id: None,
    };

    job_ctx.complete(
        Some("备份并导出 ZIP 完成".to_string()),
        1,
        1,
        result_payload,
    );
}

/// 异步导出备份为 ZIP 文件（后台任务模式）
///
/// 将备份目录异步压缩为 ZIP 文件，支持进度事件和取消操作。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 备份 ID（备份目录名）
/// - `output_path`: 输出 ZIP 文件路径（可选，默认自动生成）
/// - `compression_level`: 压缩级别 0-9（可选，默认 6）
/// - `include_checksums`: 是否包含校验和文件（可选，默认 true）
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID 的响应
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
#[tauri::command]
pub async fn data_governance_export_zip(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    backup_id: String,
    output_path: Option<String>,
    compression_level: Option<u32>,
    include_checksums: Option<bool>,
) -> Result<BackupJobStartResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;

    // P0-4: 对用户指定的 output_path 进行安全校验
    if let Some(ref p) = output_path {
        let app_data_dir = get_app_data_dir(&app)?;
        let user_output = std::path::PathBuf::from(p);
        validate_user_path(&user_output, &app_data_dir)?;
    }

    info!(
        "[data_governance] 启动后台 ZIP 导出任务: backup_id={}, output_path={:?}",
        validated_backup_id, output_path
    );

    // 使用全局单例备份任务管理器
    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Export);
    let job_id = job_ctx.job_id.clone();

    // 准备参数
    let compression_level = compression_level.unwrap_or(6).min(9);
    let include_checksums = include_checksums.unwrap_or(true);

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Full,
                    file_count: 0,
                    total_size: 0,
                },
                format!("zip_export/{}", validated_backup_id),
            )
            .with_details(serde_json::json!({
                "job_id": job_id.clone(),
                "backup_id": validated_backup_id.clone(),
                "compression_level": compression_level,
                "include_checksums": include_checksums,
                "output_path": output_path.clone(),
                "subtype": "zip_export",
            })),
        );
    }

    // 在后台执行 ZIP 导出
    tauri::async_runtime::spawn(async move {
        execute_zip_export_with_progress(
            app,
            job_ctx,
            validated_backup_id,
            output_path,
            compression_level,
            include_checksums,
        )
        .await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "export".to_string(),
        status: "queued".to_string(),
        message: "ZIP 导出任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

/// 执行 ZIP 导出（内部函数，带进度回调）
async fn execute_zip_export_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    backup_id: String,
    output_path: Option<String>,
    compression_level: u32,
    include_checksums: bool,
) {
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{BufReader, Read, Write};
    use std::time::Instant;
    use walkdir::WalkDir;
    use zip::write::FileOptions;
    use zip::CompressionMethod;
    use zip::ZipWriter;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 检查备份目录是否存在
    let source_backup_dir = backup_dir.join(&backup_id);
    if !source_backup_dir.exists() {
        let msg = format!("备份不存在: {}", backup_id);
        #[cfg(feature = "data_governance")]
        {
            try_save_audit_log(
                &app,
                AuditLog::new(
                    AuditOperation::Backup {
                        backup_type: super::audit::BackupType::Full,
                        file_count: 0,
                        total_size: 0,
                    },
                    format!("zip_export/{}", backup_id),
                )
                .fail(msg.clone())
                .with_details(serde_json::json!({
                    "job_id": job_ctx.job_id.clone(),
                    "backup_id": backup_id.clone(),
                    "subtype": "zip_export",
                })),
            );
        }
        job_ctx.fail(msg);
        return;
    }

    if let Err(e) = ensure_existing_path_within_backup_dir(&source_backup_dir, &backup_dir) {
        let msg = format!("备份路径校验失败: {}", e);
        #[cfg(feature = "data_governance")]
        {
            try_save_audit_log(
                &app,
                AuditLog::new(
                    AuditOperation::Backup {
                        backup_type: super::audit::BackupType::Full,
                        file_count: 0,
                        total_size: 0,
                    },
                    format!("zip_export/{}", backup_id),
                )
                .fail(msg.clone())
                .with_details(serde_json::json!({
                    "job_id": job_ctx.job_id.clone(),
                    "backup_id": backup_id.clone(),
                    "subtype": "zip_export",
                })),
            );
        }
        job_ctx.fail(msg);
        return;
    }

    // ========== 阶段 1: 扫描 (0-5%) ==========
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        0.0,
        Some("正在扫描备份目录...".to_string()),
        0,
        0,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
        return;
    }

    // 扫描目录，统计文件数量和总大小
    let mut files_to_compress: Vec<(PathBuf, String)> = Vec::new();
    let mut total_size: u64 = 0;

    for entry in WalkDir::new(&source_backup_dir)
        .into_iter()
        .filter_map(log_and_skip_entry_err)
    {
        let path = entry.path();
        let relative_path = match path.strip_prefix(&source_backup_dir) {
            Ok(p) => p,
            Err(_) => continue,
        };

        // 跳过空路径（根目录）
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let relative_path_str = relative_path.to_string_lossy().replace('\\', "/");

        if entry.file_type().is_file() {
            if let Ok(metadata) = entry.metadata() {
                total_size += metadata.len();
            }
            files_to_compress.push((path.to_path_buf(), relative_path_str));
        } else if entry.file_type().is_dir() {
            // 目录也需要记录，但不计入文件数
            files_to_compress.push((path.to_path_buf(), relative_path_str));
        }
    }

    let total_files = files_to_compress
        .iter()
        .filter(|(p, _)| p.is_file())
        .count();

    job_ctx.mark_running(
        BackupJobPhase::Scan,
        5.0,
        Some(format!(
            "扫描完成: {} 个文件, {} 字节",
            total_files, total_size
        )),
        0,
        total_files as u64,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
        return;
    }

    // ========== 阶段 2: 压缩 (5-90%) ==========
    // 确定输出路径
    let zip_path = match output_path {
        Some(path) => PathBuf::from(path),
        None => backup_dir.join(format!("{}.zip", backup_id)),
    };

    // 确保输出目录存在
    if let Some(parent) = zip_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            let msg = format!("创建输出目录失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_export/{}", backup_id),
                    )
                    .fail(msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_id": backup_id.clone(),
                        "subtype": "zip_export",
                        "zip_path": zip_path.to_string_lossy(),
                    })),
                );
            }
            job_ctx.fail(msg);
            return;
        }
    }

    // 创建 ZIP 文件
    let zip_file = match File::create(&zip_path) {
        Ok(f) => f,
        Err(e) => {
            let msg = format!("创建 ZIP 文件失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_export/{}", backup_id),
                    )
                    .fail(msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_id": backup_id.clone(),
                        "subtype": "zip_export",
                        "zip_path": zip_path.to_string_lossy(),
                    })),
                );
            }
            job_ctx.fail(msg);
            return;
        }
    };
    let mut zip_writer = ZipWriter::new(zip_file);

    // 配置压缩选项
    let compression_method = if compression_level == 0 {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };
    let file_options = FileOptions::default().compression_method(compression_method);

    let mut compressed_files: usize = 0;
    let mut checksums: Vec<(String, String)> = Vec::new();
    let mut skipped_files: Vec<String> = Vec::new();

    for (path, relative_path_str) in &files_to_compress {
        // 检查取消
        if job_ctx.is_cancelled() {
            // 清理未完成的 ZIP 文件
            drop(zip_writer);
            let _ = std::fs::remove_file(&zip_path);
            job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
            return;
        }

        if path.is_dir() {
            // 添加目录
            if let Err(e) = zip_writer.add_directory(relative_path_str, file_options) {
                warn!("[zip_export] 添加目录失败: {} - {}", relative_path_str, e);
            }
        } else if path.is_file() {
            // 添加文件
            let mut file = match File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    warn!("[zip_export] 打开文件失败: {:?} - {}", path, e);
                    skipped_files.push(format!("{}: {}", relative_path_str, e));
                    continue;
                }
            };

            // 计算校验和（如果需要）
            if include_checksums {
                if let Ok(checksum) = crate::backup_common::calculate_file_hash(path) {
                    checksums.push((relative_path_str.clone(), checksum));
                }
            }

            // 写入 ZIP
            if let Err(e) = zip_writer.start_file(relative_path_str, file_options) {
                warn!(
                    "[zip_export] 开始写入文件失败: {} - {}",
                    relative_path_str, e
                );
                skipped_files.push(format!("{}: {}", relative_path_str, e));
                continue;
            }

            if let Err(e) = std::io::copy(&mut file, &mut zip_writer) {
                warn!("[zip_export] 写入 ZIP 失败: {} - {}", relative_path_str, e);
                skipped_files.push(format!("{}: {}", relative_path_str, e));
                continue;
            }

            compressed_files += 1;

            // 更新进度 (5% - 90%)
            let progress = 5.0 + (compressed_files as f32 / total_files.max(1) as f32) * 85.0;
            job_ctx.mark_running(
                BackupJobPhase::Compress,
                progress,
                Some(format!(
                    "正在压缩: {}/{} ({:.1}%)",
                    compressed_files, total_files, progress
                )),
                compressed_files as u64,
                total_files as u64,
            );
        }
    }

    // 如果需要，添加校验和文件
    if include_checksums && !checksums.is_empty() {
        let checksums_content = checksums
            .iter()
            .map(|(path, hash)| format!("{}  {}", hash, path))
            .collect::<Vec<_>>()
            .join("\n");

        if let Err(e) = zip_writer.start_file("checksums.sha256", file_options) {
            warn!("[zip_export] 添加校验和文件失败: {}", e);
        } else if let Err(e) = zip_writer.write_all(checksums_content.as_bytes()) {
            warn!("[zip_export] 写入校验和文件失败: {}", e);
        }
    }

    // 完成 ZIP 文件
    if let Err(e) = zip_writer.finish() {
        let msg = format!("完成 ZIP 文件失败: {}", e);
        #[cfg(feature = "data_governance")]
        {
            try_save_audit_log(
                &app,
                AuditLog::new(
                    AuditOperation::Backup {
                        backup_type: super::audit::BackupType::Full,
                        file_count: 0,
                        total_size: 0,
                    },
                    format!("zip_export/{}", backup_id),
                )
                .fail(msg.clone())
                .with_details(serde_json::json!({
                    "job_id": job_ctx.job_id.clone(),
                    "backup_id": backup_id.clone(),
                    "subtype": "zip_export",
                    "zip_path": zip_path.to_string_lossy(),
                })),
            );
        }
        job_ctx.fail(msg);
        return;
    }

    if job_ctx.is_cancelled() {
        let _ = std::fs::remove_file(&zip_path);
        job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
        return;
    }

    // ========== 阶段 3: 验证 (90-95%) ==========
    job_ctx.mark_running(
        BackupJobPhase::Verify,
        90.0,
        Some("正在验证 ZIP 文件...".to_string()),
        compressed_files as u64,
        total_files as u64,
    );

    // 获取压缩后的大小
    let compressed_size = match std::fs::metadata(&zip_path) {
        Ok(m) => m.len(),
        Err(e) => {
            let msg = format!("获取 ZIP 文件大小失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_export/{}", backup_id),
                    )
                    .fail(msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_id": backup_id.clone(),
                        "subtype": "zip_export",
                        "zip_path": zip_path.to_string_lossy(),
                    })),
                );
            }
            job_ctx.fail(msg);
            return;
        }
    };

    // 计算 ZIP 文件的校验和
    let zip_checksum = match crate::backup_common::calculate_file_hash(&zip_path) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("计算 ZIP 校验和失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_export/{}", backup_id),
                    )
                    .fail(msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "backup_id": backup_id.clone(),
                        "subtype": "zip_export",
                        "zip_path": zip_path.to_string_lossy(),
                    })),
                );
            }
            job_ctx.fail(msg);
            return;
        }
    };

    job_ctx.mark_running(
        BackupJobPhase::Verify,
        95.0,
        Some("验证完成".to_string()),
        compressed_files as u64,
        total_files as u64,
    );

    // ========== 阶段 4: 清理 (95-100%) ==========
    job_ctx.mark_running(
        BackupJobPhase::Cleanup,
        98.0,
        Some("正在完成导出...".to_string()),
        compressed_files as u64,
        total_files as u64,
    );

    let duration_ms = start.elapsed().as_millis() as u64;
    let compression_ratio = if total_size > 0 {
        1.0 - (compressed_size as f64 / total_size as f64)
    } else {
        0.0
    };

    info!(
        "[data_governance] ZIP 导出成功: path={:?}, files={}, size={}->{}, ratio={:.1}%, duration={}ms",
        zip_path, compressed_files, total_size, compressed_size, compression_ratio * 100.0, duration_ms
    );

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Full,
                    file_count: compressed_files,
                    total_size: compressed_size,
                },
                format!("zip_export/{}", backup_id),
            )
            .complete(duration_ms)
            .with_details(serde_json::json!({
                "job_id": job_ctx.job_id.clone(),
                "backup_id": backup_id.clone(),
                "zip_path": zip_path.to_string_lossy(),
                "file_count": compressed_files,
                "total_size": total_size,
                "compressed_size": compressed_size,
                "compression_ratio": compression_ratio,
                "zip_checksum": zip_checksum,
                "subtype": "zip_export",
            })),
        );
    }

    // 构建结果 payload（如有跳过文件，标记 success=false 并附上错误详情）
    let has_skipped = !skipped_files.is_empty();
    if has_skipped {
        warn!(
            "[zip_export] 导出完成但有 {} 个文件被跳过: {:?}",
            skipped_files.len(),
            skipped_files
        );
    }
    let export_error = if has_skipped {
        Some(format!(
            "导出完成但 {} 个文件被跳过: {}",
            skipped_files.len(),
            skipped_files.join("; ")
        ))
    } else {
        None
    };

    let result_payload = BackupJobResultPayload {
        success: !has_skipped,
        output_path: Some(zip_path.to_string_lossy().to_string()),
        resolved_path: Some(zip_path.to_string_lossy().to_string()),
        message: Some(format!(
            "ZIP 导出完成: {} 个文件, 压缩率 {:.1}%{}",
            compressed_files,
            compression_ratio * 100.0,
            if has_skipped {
                format!("（{} 个文件被跳过）", skipped_files.len())
            } else {
                "".to_string()
            }
        )),
        error: export_error,
        duration_ms: Some(duration_ms),
        stats: Some(serde_json::json!({
            "file_count": compressed_files,
            "total_size": total_size,
            "compressed_size": compressed_size,
            "compression_ratio": compression_ratio,
            "zip_checksum": zip_checksum,
            "skipped_files": skipped_files,
        })),
        requires_restart: false,
        checkpoint_path: None,
        resumable_job_id: None,
    };

    job_ctx.complete(
        Some(format!("ZIP 导出完成: {}", zip_path.to_string_lossy())),
        compressed_files as u64,
        total_files as u64,
        result_payload,
    );
}

/// ZIP 导出结果响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct ZipExportResultResponse {
    /// 是否成功
    pub success: bool,
    /// ZIP 文件路径
    pub zip_path: String,
    /// 原始总大小（字节）
    pub total_size: u64,
    /// 压缩后大小（字节）
    pub compressed_size: u64,
    /// 压缩率（0.0-1.0）
    pub compression_ratio: f64,
    /// 文件数量
    pub file_count: usize,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// ZIP 文件的 SHA256 校验和
    pub zip_checksum: String,
}

/// 异步后台 ZIP 导入（带进度事件）
///
/// 启动后台 ZIP 导入任务，立即返回任务 ID。导入进度通过 `backup-job-progress` 事件发送。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `zip_path`: ZIP 文件路径
/// - `backup_id`: 解压后的备份 ID（可选，默认从文件名生成）
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID
///
/// ## 进度阶段
/// - Scan (0-5%): 验证 ZIP 文件
/// - Extract (5-80%): 解压文件（按文件数量更新进度）
/// - Verify (80-90%): 验证解压的文件
/// - Cleanup (90-100%): 清理临时文件
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
#[tauri::command]
pub async fn data_governance_import_zip(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    zip_path: String,
    backup_id: Option<String>,
) -> Result<BackupJobStartResponse, String> {
    let validated_backup_id = match backup_id {
        Some(id) => Some(validate_backup_id(&id)?),
        None => None,
    };

    // 安全验证：确保 zip_path 在安全范围内（非系统目录、非应用数据目录内部）
    let app_data_dir = get_app_data_dir(&app)?;
    let zip_file_path = PathBuf::from(&zip_path);
    validate_user_path(&zip_file_path, &app_data_dir)?;

    info!(
        "[data_governance] 启动后台 ZIP 导入任务: zip_path={}, backup_id={:?}",
        zip_path, validated_backup_id
    );

    if !zip_file_path.exists() {
        return Err(format!(
            "ZIP 文件不存在: {}。请确认文件路径正确，或重新选择文件",
            sanitize_path_for_user(&zip_file_path)
        ));
    }

    // 使用全局单例备份任务管理器
    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Import);
    let job_id = job_ctx.job_id.clone();

    #[cfg(feature = "data_governance")]
    {
        let target_id = validated_backup_id
            .clone()
            .unwrap_or_else(|| "auto".to_string());
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Backup {
                    backup_type: super::audit::BackupType::Full,
                    file_count: 0,
                    total_size: 0,
                },
                format!("zip_import/{}", target_id),
            )
            .with_details(serde_json::json!({
                "job_id": job_id.clone(),
                "zip_path": zip_path,
                "backup_id": validated_backup_id,
                "subtype": "zip_import",
            })),
        );
    }

    // 在后台执行导入
    tauri::async_runtime::spawn(async move {
        execute_zip_import_with_progress(app, job_ctx, zip_file_path, validated_backup_id).await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "import".to_string(),
        status: "queued".to_string(),
        message: "ZIP 导入任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

/// 执行 ZIP 导入（内部函数，带进度回调）
async fn execute_zip_import_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    zip_file_path: PathBuf,
    backup_id: Option<String>,
) {
    use super::backup::zip_export::{import_backup_from_zip_with_progress, ZipImportPhase};
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 设置任务参数（用于持久化和恢复）
    job_ctx.set_params(BackupJobParams {
        zip_path: Some(zip_file_path.to_string_lossy().to_string()),
        backup_id: backup_id.clone(),
        ..Default::default()
    });

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 确保备份目录存在
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    // 确定备份 ID
    let generated_backup_id = backup_id.unwrap_or_else(|| {
        use uuid::Uuid;
        let now = chrono::Utc::now();
        let timestamp = now.format("%Y%m%d_%H%M%S").to_string();
        let millis = now.timestamp_subsec_millis();
        let rand8 = &Uuid::new_v4().simple().to_string()[..8];
        format!("{}_{}_{:03}_imported", timestamp, rand8, millis)
    });

    let target_backup_id = match validate_backup_id(&generated_backup_id) {
        Ok(id) => id,
        Err(e) => {
            job_ctx.fail(format!("backup_id 非法: {}", e));
            return;
        }
    };

    let target_dir = backup_dir.join(&target_backup_id);

    // 确保目标目录不存在
    if target_dir.exists() {
        if let Err(e) = ensure_existing_path_within_backup_dir(&target_dir, &backup_dir) {
            job_ctx.fail(format!("备份路径校验失败: {}", e));
            return;
        }
        job_ctx.fail(format!("备份已存在: {}", target_backup_id));
        return;
    }

    // 初始化检查点
    job_ctx.init_checkpoint(0); // 文件数在扫描后确定

    // 阶段 1: 扫描
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        0.0,
        Some("正在验证 ZIP 文件...".to_string()),
        0,
        0,
    );

    // 检查取消
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消导入".to_string()));
        return;
    }

    // 使用带进度的导入函数
    let job_ctx_for_progress = job_ctx.clone();
    let job_ctx_for_cancel = job_ctx.clone();

    let result = import_backup_from_zip_with_progress(
        &zip_file_path,
        &target_dir,
        |progress| {
            // 将 ZipImportPhase 转换为 BackupJobPhase
            let phase = match progress.phase {
                ZipImportPhase::Scan => BackupJobPhase::Scan,
                ZipImportPhase::Extract => BackupJobPhase::Extract,
                ZipImportPhase::Verify => BackupJobPhase::Verify,
                ZipImportPhase::Completed => BackupJobPhase::Completed,
            };

            job_ctx_for_progress.mark_running(
                phase,
                progress.progress,
                Some(progress.message),
                progress.processed_files as u64,
                progress.total_files as u64,
            );
        },
        || job_ctx_for_cancel.is_cancelled(),
    );

    match result {
        Ok(file_count) => {
            let duration_ms = start.elapsed().as_millis() as u64;

            // 阶段 4: 清理（90% - 100%）
            job_ctx.mark_running(
                BackupJobPhase::Cleanup,
                95.0,
                Some("正在清理临时文件...".to_string()),
                file_count as u64,
                file_count as u64,
            );

            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count,
                            total_size: 0,
                        },
                        format!("zip_import/{}", target_backup_id),
                    )
                    .complete(duration_ms)
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "zip_path": zip_file_path.to_string_lossy(),
                        "backup_id": target_backup_id,
                        "backup_path": target_dir.to_string_lossy(),
                        "file_count": file_count,
                        "subtype": "zip_import",
                    })),
                );
            }

            // 完成
            let result_payload = BackupJobResultPayload {
                success: true,
                output_path: Some(target_dir.to_string_lossy().to_string()),
                resolved_path: None,
                message: Some(format!(
                    "ZIP 导入成功: {} 个文件, 备份 ID: {}",
                    file_count, target_backup_id
                )),
                error: None,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "file_count": file_count,
                    "backup_id": target_backup_id,
                    "backup_path": target_dir.to_string_lossy().to_string(),
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            };

            job_ctx.complete(
                Some(format!("ZIP 导入成功: {} 个文件", file_count)),
                file_count as u64,
                file_count as u64,
                result_payload,
            );

            info!(
                "[data_governance] ZIP 导入任务完成: backup_id={}, files={}, duration={}ms",
                target_backup_id, file_count, duration_ms
            );
        }
        Err(e) => {
            // 检查是否是用户取消
            let error_msg = e.to_string();
            if error_msg.contains("用户取消") {
                job_ctx.cancelled(Some("用户取消导入".to_string()));
            } else {
                error!("[data_governance] ZIP 导入任务失败: {}", e);
                job_ctx.fail(format!("ZIP 导入失败: {}", e));
            }

            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_import/{}", target_backup_id),
                    )
                    .fail(error_msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "zip_path": zip_file_path.to_string_lossy(),
                        "backup_id": target_backup_id,
                        "backup_path": target_dir.to_string_lossy(),
                        "subtype": "zip_import",
                    })),
                );
            }

            // 清理已创建的目录
            if target_dir.exists() {
                if let Err(cleanup_err) = std::fs::remove_dir_all(&target_dir) {
                    warn!(
                        "[data_governance] 清理失败的导入目录时出错: {}",
                        cleanup_err
                    );
                }
            }
        }
    }
}

// ==================== 恢复相关命令 ====================

/// 异步后台恢复（带进度事件）
///
/// 启动后台恢复任务，立即返回任务 ID。恢复进度通过 `backup-job-progress` 事件发送。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要恢复的备份 ID
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
///
/// ## 进度阶段
/// - Scan (5%): 验证备份清单
/// - Verify (5-15%): 验证备份文件校验和
/// - Replace (15-90%): 恢复数据库（每个数据库更新一次进度）
/// - Cleanup (90-100%): 清理和验证
#[tauri::command]
pub async fn data_governance_restore_backup(
    app: tauri::AppHandle,
    backup_job_state: State<'_, BackupJobManagerState>,
    backup_id: String,
    restore_assets: Option<bool>,
) -> Result<BackupJobStartResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;

    info!(
        "[data_governance] 启动后台恢复任务: backup_id={}",
        validated_backup_id
    );

    // 使用全局单例备份任务管理器
    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Import);
    let job_id = job_ctx.job_id.clone();

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Restore {
                    backup_path: validated_backup_id.clone(),
                },
                validated_backup_id.clone(),
            )
            .with_details(serde_json::json!({
                "job_id": job_id.clone(),
                "restore_assets": restore_assets,
            })),
        );
    }

    // 在后台执行恢复
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        execute_restore_with_progress(app_clone, job_ctx, validated_backup_id, restore_assets)
            .await;
    });

    Ok(BackupJobStartResponse {
        job_id,
        kind: "import".to_string(),
        status: "queued".to_string(),
        message: "恢复任务已启动，请通过 backup-job-progress 事件监听进度".to_string(),
    })
}

/// 执行恢复（内部函数，带细粒度进度回调）
///
/// 进度阶段设计（细粒度，每个数据库/资产文件独立上报）：
/// - Scan (0-5%): 验证备份清单、版本兼容性
/// - Verify (5-15%): 逐文件验证校验和 + 完整性检查
/// - Replace (15-80%): 逐数据库恢复（每完成一个数据库更新一次进度）
/// - Replace (80-92%): 逐文件恢复资产（带 per-file 进度）
/// - Cleanup (92-100%): 插槽切换标记、审计日志
async fn execute_restore_with_progress(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    backup_id: String,
    restore_assets: Option<bool>,
) {
    use super::backup::BackupManager;
    use super::backup::assets;
    use super::schema_registry::DatabaseId;
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 检查备份目录是否存在
    if !backup_dir.exists() {
        job_ctx.fail("备份目录不存在".to_string());
        return;
    }

    // ============ 阶段 1: Scan (0-5%) - 验证备份清单 ============
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        2.0,
        Some("正在验证备份清单...".to_string()),
        0,
        0,
    );

    // 检查取消（安全点）
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消恢复".to_string()));
        return;
    }

    // 创建备份管理器
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(app_data_dir.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // 获取备份列表
    let manifests = match manager.list_backups() {
        Ok(m) => m,
        Err(e) => {
            error!("[data_governance] 获取备份列表失败: {}", e);
            job_ctx.fail(format!("获取备份列表失败: {}", e));
            return;
        }
    };

    // 查找目标备份
    let manifest = match manifests.iter().find(|m| m.backup_id == backup_id) {
        Some(m) => m.clone(),
        None => {
            job_ctx.fail(format!("备份不存在: {}", backup_id));
            return;
        }
    };

    let manifest_dir = app_data_dir.join("backups").join(&manifest.backup_id);
    if let Err(e) =
        ensure_existing_path_within_backup_dir(&manifest_dir, &app_data_dir.join("backups"))
    {
        job_ctx.fail(format!("备份路径校验失败: {}", e));
        return;
    }

    // 版本兼容性检查
    if let Err(e) = manager.check_manifest_compatibility(&manifest) {
        job_ctx.fail(format!("备份版本不兼容: {}", e));
        return;
    }

    // 计算数据库文件列表和资产总数，用于精确的 total_items
    let database_files: Vec<_> = manifest
        .files
        .iter()
        .filter(|f| f.path.ends_with(".db") && f.database_id.is_some())
        .collect();
    let total_databases = database_files.len() as u64;
    let asset_file_count: u64 = manifest
        .assets
        .as_ref()
        .map(|a| a.total_files as u64)
        .unwrap_or(0);
    // total_items = databases + asset files（用于前端显示 "X / Y 项"）
    let total_items = total_databases + asset_file_count;

    job_ctx.mark_running(
        BackupJobPhase::Scan,
        5.0,
        Some(format!(
            "备份清单验证通过: {} 个数据库, {} 个资产文件",
            total_databases, asset_file_count
        )),
        0,
        total_items,
    );

    info!(
        "[data_governance] 备份清单验证通过: backup_id={}, databases={}, assets={}",
        backup_id, total_databases, asset_file_count
    );

    // ============ 阶段 2: Verify (5-15%) - 逐文件验证备份完整性 ============
    let backup_subdir = backup_dir.join(&manifest.backup_id);
    if !backup_subdir.exists() {
        job_ctx.fail(format!("备份目录不存在: {:?}", backup_subdir));
        return;
    }

    // 检查取消（安全点 - 恢复前最后一次安全检查）
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消恢复".to_string()));
        return;
    }

    // 逐文件验证校验和（细粒度进度：5% → 15%）
    let verify_total = manifest.files.len();
    for (idx, backup_file) in manifest.files.iter().enumerate() {
        // 验证阶段允许取消（尚未修改任何数据）
        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消恢复（验证阶段）".to_string()));
            return;
        }

        let verify_progress = 5.0 + (idx as f32 / verify_total.max(1) as f32) * 10.0;
        job_ctx.mark_running(
            BackupJobPhase::Verify,
            verify_progress,
            Some(format!("正在验证: {} ({}/{})", backup_file.path, idx + 1, verify_total)),
            0,
            total_items,
        );

        let file_path = backup_subdir.join(&backup_file.path);
        if !file_path.exists() {
            job_ctx.fail(format!("备份文件不存在: {}", backup_file.path));
            return;
        }

        // 验证 SHA256 校验和
        match super::backup::calculate_file_sha256(&file_path) {
            Ok(actual_sha256) => {
                if actual_sha256 != backup_file.sha256 {
                    job_ctx.fail(format!(
                        "备份文件校验和不匹配: {} (expected={}, actual={})",
                        backup_file.path, backup_file.sha256, actual_sha256
                    ));
                    return;
                }
            }
            Err(e) => {
                job_ctx.fail(format!("计算校验和失败 {}: {}", backup_file.path, e));
                return;
            }
        }

        // 对 .db 文件执行 PRAGMA integrity_check（与原 verify_internal 一致）
        if backup_file.path.ends_with(".db") {
            match rusqlite::Connection::open(&file_path) {
                Ok(conn) => {
                    match conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)) {
                        Ok(result) if result == "ok" => {
                            debug!("[data_governance] 备份数据库完整性验证通过: {}", backup_file.path);
                        }
                        Ok(result) => {
                            job_ctx.fail(format!(
                                "备份数据库完整性检查失败: {} ({})",
                                backup_file.path, result
                            ));
                            return;
                        }
                        Err(e) => {
                            job_ctx.fail(format!(
                                "备份数据库完整性检查执行失败: {} ({})",
                                backup_file.path, e
                            ));
                            return;
                        }
                    }
                }
                Err(e) => {
                    job_ctx.fail(format!(
                        "无法打开备份数据库文件: {} ({})",
                        backup_file.path, e
                    ));
                    return;
                }
            }
        }
    }

    info!("[data_governance] 备份文件完整性验证通过: {} 个文件", verify_total);

    // ============ 阶段 3: Replace (15-80%) - 逐数据库恢复 ============
    // 获取非活跃插槽目录：恢复写入非活跃插槽，避免 Windows OS error 32
    // （活跃插槽的数据库文件被连接池持有，Windows 上无法写入/删除）
    let (inactive_dir, inactive_slot) = match crate::data_space::get_data_space_manager() {
        Some(mgr) => {
            let slot = mgr.inactive_slot();
            let dir = mgr.slot_dir(slot);
            info!(
                "[data_governance] 恢复目标: 非活跃插槽 {} ({})",
                slot.name(),
                dir.display()
            );
            (dir, Some(slot))
        }
        None => {
            // 未启用双空间模式，回退到 slots/slotB
            let dir = app_data_dir.join("slots").join("slotB");
            warn!("[data_governance] DataSpaceManager 未初始化，回退到 slotB");
            (dir, None)
        }
    };

    // 磁盘空间预检查：备份大小 × 2 作为安全余量（Android 设备存储较紧张）
    {
        let db_size: u64 = manifest.files.iter().map(|f| f.size).sum();
        let asset_size: u64 = manifest.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
        let required = (db_size + asset_size).saturating_mul(2);
        match crate::backup_common::get_available_disk_space(&app_data_dir) {
            Ok(available) if available < required => {
                let msg = format!(
                    "磁盘空间不足：需要 {:.1} MB，仅剩 {:.1} MB。请清理存储空间后重试",
                    required as f64 / 1024.0 / 1024.0,
                    available as f64 / 1024.0 / 1024.0
                );
                error!("[data_governance] {}", msg);
                job_ctx.fail(msg);
                return;
            }
            Err(e) => {
                warn!("[data_governance] 磁盘空间检查失败（继续恢复）: {}", e);
            }
            _ => {}
        }
    }

    // 确保目标目录存在
    if let Err(e) = std::fs::create_dir_all(&inactive_dir) {
        job_ctx.fail(format!("创建恢复目标目录失败: {}", e));
        return;
    }

    // 逐数据库恢复（细粒度进度：15% → 80%）
    let mut databases_restored: Vec<String> = Vec::new();
    let mut restore_errors: Vec<String> = Vec::new();
    let db_progress_range = 65.0; // 15% → 80%

    for (idx, backup_file) in database_files.iter().enumerate() {
        let db_id_str = match backup_file.database_id.as_ref() {
            Some(id) => id,
            None => continue,
        };

        let db_id = match db_id_str.as_str() {
            "vfs" => DatabaseId::Vfs,
            "chat_v2" => DatabaseId::ChatV2,
            "mistakes" => DatabaseId::Mistakes,
            "llm_usage" => DatabaseId::LlmUsage,
            _ => {
                let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                error!("{}", msg);
                restore_errors.push(msg);
                continue;
            }
        };

        let db_progress = 15.0 + (idx as f32 / total_databases.max(1) as f32) * db_progress_range;
        job_ctx.mark_running(
            BackupJobPhase::Replace,
            db_progress,
            Some(format!(
                "正在恢复数据库: {} ({}/{})",
                db_id_str,
                idx + 1,
                total_databases
            )),
            idx as u64,
            total_items,
        );

        match manager.restore_single_database_to_dir(&db_id, &backup_subdir, &inactive_dir) {
            Ok(()) => {
                info!("[data_governance] 恢复数据库成功: {:?}", db_id);
                databases_restored.push(db_id_str.clone());
            }
            Err(e) => {
                error!("[data_governance] 恢复数据库失败: {:?}, 错误: {}", db_id, e);
                restore_errors.push(format!("{}: {}", db_id_str, e));
            }
        }
    }

    // 数据库恢复完成后的进度
    job_ctx.mark_running(
        BackupJobPhase::Replace,
        80.0,
        Some(format!(
            "数据库恢复完成: {}/{}",
            databases_restored.len(),
            total_databases
        )),
        total_databases,
        total_items,
    );

    // 检查数据库恢复错误
    if !restore_errors.is_empty() {
        let err_msg = format!("部分数据库恢复失败: {}", restore_errors.join("; "));
        error!("[data_governance] {}", err_msg);
        #[cfg(feature = "data_governance")]
        {
            try_save_audit_log(
                &app,
                AuditLog::new(
                    AuditOperation::Restore {
                        backup_path: backup_id.clone(),
                    },
                    backup_id.clone(),
                )
                .fail(err_msg.clone())
                .with_details(serde_json::json!({
                    "job_id": job_ctx.job_id.clone(),
                    "restore_assets": restore_assets,
                    "errors": restore_errors,
                })),
            );
        }
        job_ctx.fail(err_msg);
        return;
    }

    // ============ 阶段 3b: Replace/Assets (80-92%) - 恢复资产文件 ============
    let should_restore_assets = restore_assets.unwrap_or_else(|| {
        manifest
            .assets
            .as_ref()
            .map(|a| a.total_files > 0)
            .unwrap_or(false)
    });

    let mut restored_assets: usize = 0;

    if should_restore_assets {
        let asset_progress_base = 80.0_f32;
        let asset_progress_range = 12.0_f32; // 80% → 92%

        if let Some(asset_result) = &manifest.assets {
            info!(
                "[data_governance] 开始恢复资产文件: {} 个",
                asset_result.total_files
            );

            job_ctx.mark_running(
                BackupJobPhase::Replace,
                asset_progress_base,
                Some(format!(
                    "正在恢复资产文件: 0/{}",
                    asset_result.total_files
                )),
                total_databases,
                total_items,
            );

            match assets::restore_assets_with_progress(
                &backup_subdir,
                &inactive_dir,
                &asset_result.files,
                |restored, total_asset| {
                    if job_ctx.is_cancelled() {
                        return false;
                    }

                    let asset_pct = if total_asset > 0 {
                        restored as f32 / total_asset as f32
                    } else {
                        1.0
                    };
                    let progress = asset_progress_base + asset_pct * asset_progress_range;
                    job_ctx.mark_running(
                        BackupJobPhase::Replace,
                        progress,
                        Some(format!(
                            "正在恢复资产文件: {}/{}",
                            restored, total_asset
                        )),
                        total_databases + restored as u64,
                        total_items,
                    );

                    true
                },
            ) {
                Ok(count) => {
                    restored_assets = count;
                    info!("[data_governance] 资产恢复完成: {} 个文件", count);
                }
                Err(e) => {
                    if e.is_cancelled() {
                        job_ctx.cancelled(Some("用户取消恢复（资产阶段）".to_string()));
                        return;
                    }

                    // 资产恢复失败不阻塞数据库恢复结果，记录警告
                    error!("[data_governance] 资产恢复失败: {}", e);
                    restore_errors.push(format!("资产恢复: {}", e));
                }
            }
        } else {
            // manifest.assets 为 None 时，尝试直接扫描备份目录中的 assets/ 子目录
            let assets_subdir = backup_subdir.join("assets");
            if assets_subdir.exists() && assets_subdir.is_dir() {
                info!(
                    "[data_governance] manifest.assets 为空，尝试从 assets/ 目录直接恢复: {:?}",
                    assets_subdir
                );

                job_ctx.mark_running(
                    BackupJobPhase::Replace,
                    asset_progress_base,
                    Some("正在从目录恢复资产文件...".to_string()),
                    total_databases,
                    total_items,
                );

                match assets::restore_assets_from_dir_with_progress(
                    &assets_subdir,
                    &inactive_dir,
                    |restored, total_asset| {
                        if job_ctx.is_cancelled() {
                            return false;
                        }

                        let asset_pct = if total_asset > 0 {
                            restored as f32 / total_asset as f32
                        } else {
                            1.0
                        };
                        let progress = asset_progress_base + asset_pct * asset_progress_range;
                        job_ctx.mark_running(
                            BackupJobPhase::Replace,
                            progress,
                            Some(format!(
                                "正在恢复资产文件: {}/{}",
                                restored, total_asset
                            )),
                            total_databases + restored as u64,
                            total_items,
                        );

                        true
                    },
                ) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("[data_governance] 资产目录直接恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        if e.is_cancelled() {
                            job_ctx.cancelled(Some("用户取消恢复（资产阶段）".to_string()));
                            return;
                        }

                        error!("[data_governance] 资产目录直接恢复失败: {}", e);
                        restore_errors.push(format!("资产目录恢复: {}", e));
                    }
                }
            } else {
                warn!("[data_governance] 备份中无资产文件可恢复");
            }
        }
    }

    // 收集所有非致命警告（资产错误 + 插槽切换警告）
    let has_asset_errors = !restore_errors.is_empty();
    if has_asset_errors {
        warn!(
            "[data_governance] 资产恢复有部分错误（数据库已成功恢复）: {:?}",
            restore_errors
        );
    }

    // ============ 阶段 4: Cleanup (92-100%) - 插槽切换与审计 ============
    job_ctx.mark_running(
        BackupJobPhase::Cleanup,
        93.0,
        Some("正在标记插槽切换...".to_string()),
        total_items,
        total_items,
    );

    let duration_ms = start.elapsed().as_millis() as u64;
    let restore_target_path = inactive_dir.to_string_lossy().to_string();

    info!(
        "[data_governance] 恢复成功: id={}, databases={:?}, restored_assets={}, duration={}ms, target={}",
        backup_id, databases_restored, restored_assets, duration_ms, inactive_dir.display()
    );

    // 标记下次重启时切换到恢复目标插槽
    let switch_warning: Option<String> = if let Some(slot) = inactive_slot {
        if let Some(mgr) = crate::data_space::get_data_space_manager() {
            match mgr.mark_pending_switch(slot) {
                Ok(()) => {
                    info!("[data_governance] 已标记下次重启切换到 {}", slot.name());
                    None
                }
                Err(e) => {
                    let warn_msg = format!(
                        "恢复成功但标记插槽切换失败: {}。恢复的数据在 {} 中，请手动重启后重试",
                        e, inactive_dir.display()
                    );
                    error!("[data_governance] {}", warn_msg);
                    Some(warn_msg)
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // 合并所有警告信息（资产错误 + 插槽切换警告），确保前端能看到
    let combined_warnings: Vec<String> = {
        let mut warnings = restore_errors.clone();
        if let Some(ref sw) = switch_warning {
            warnings.push(sw.clone());
        }
        warnings
    };
    let error_for_result = if combined_warnings.is_empty() {
        None
    } else {
        Some(combined_warnings.join("; "))
    };

    job_ctx.mark_running(
        BackupJobPhase::Cleanup,
        97.0,
        Some("正在记录审计日志...".to_string()),
        total_items,
        total_items,
    );

    #[cfg(feature = "data_governance")]
    {
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Restore {
                    backup_path: backup_id.clone(),
                },
                backup_id.clone(),
            )
            .complete(duration_ms)
            .with_details(serde_json::json!({
                "job_id": job_ctx.job_id.clone(),
                "restore_assets": should_restore_assets,
                "restored_assets": restored_assets,
                "databases_restored": databases_restored.clone(),
                "asset_errors": restore_errors,
            })),
        );
    }

    // 完成任务（数据库恢复成功，但如果有资产错误则 success=false 以触发前端 warning）
    let result_success = !has_asset_errors;
    job_ctx.complete(
        Some(format!(
            "恢复完成，已恢复 {} 个数据库{}{}",
            databases_restored.len(),
            if should_restore_assets {
                format!("，资产文件 {} 个", restored_assets)
            } else {
                "".to_string()
            },
            if has_asset_errors {
                format!("（{} 个资产恢复失败）", restore_errors.len())
            } else {
                "".to_string()
            }
        )),
        total_items,
        total_items,
        BackupJobResultPayload {
            success: result_success,
            output_path: Some(restore_target_path.clone()),
            resolved_path: Some(restore_target_path.clone()),
            message: Some(if should_restore_assets {
                format!(
                    "已恢复数据库: {}；资产文件: {}",
                    databases_restored.join(", "),
                    restored_assets
                )
            } else {
                format!("已恢复数据库: {}", databases_restored.join(", "))
            }),
            error: error_for_result,
            duration_ms: Some(duration_ms),
            stats: Some(serde_json::json!({
                "backup_id": backup_id,
                "databases_restored": databases_restored,
                "database_count": databases_restored.len(),
                "restore_assets": should_restore_assets,
                "restored_assets": restored_assets,
                "restore_target": restore_target_path,
                "asset_errors": restore_errors,
            })),
            // 恢复完成后需要重启以切换到恢复的数据插槽
            requires_restart: true,
            checkpoint_path: None,
            resumable_job_id: None,
        },
    );
}

// ==================== 可恢复的执行函数 ====================

/// 执行可恢复的备份（支持从失败中重新开始）
///
/// 与 execute_backup_with_progress 类似，但会：
/// 1. 设置任务参数供持久化（用于失败后重新启动）
/// 2. 初始化检查点追踪
/// 3. 在处理每个数据库后更新检查点（用于进度记录）
///
/// 注意：由于 BackupManager 的备份方法是原子操作（一次性备份所有数据库），
/// 恢复实际上是使用相同参数重新执行完整备份，而非从中断点继续。
/// 检查点信息仅用于进度显示和日志追踪。
async fn execute_backup_with_progress_resumable(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    backup_type: String,
    base_version: Option<String>,
    include_assets: bool,
    asset_types: Option<Vec<String>>,
) {
    use super::backup::{AssetBackupConfig, AssetType, BackupManager};
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 设置任务参数（用于持久化和恢复）
    job_ctx.set_params(BackupJobParams {
        backup_type: Some(backup_type.clone()),
        base_version: base_version.clone(),
        include_assets,
        asset_types: asset_types.clone(),
        ..Default::default()
    });

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 确保备份目录存在
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    // 检查是否从失败任务恢复（备份操作是原子的，恢复 = 重新执行）
    let previous_items = job_ctx.get_processed_items();
    let is_retrying = !previous_items.is_empty();

    if is_retrying {
        info!("[data_governance] 从失败任务重新执行备份（原子操作，重新开始）");
    }

    // 阶段 1: 准备中
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        5.0,
        Some(if is_retrying {
            "重新执行备份，正在准备...".to_string()
        } else {
            "正在准备备份...".to_string()
        }),
        0,
        4, // 总共 4 个数据库
    );

    // 初始化检查点（始终重新初始化，因为备份是原子操作）
    job_ctx.init_checkpoint(4); // 4 个数据库

    // 检查取消
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 创建备份管理器
    let mut manager = BackupManager::new(backup_dir);
    manager.set_app_data_dir(app_data_dir.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // 阶段 2: 执行 checkpoint
    job_ctx.mark_running(
        BackupJobPhase::Checkpoint,
        10.0,
        Some("正在执行数据库 checkpoint...".to_string()),
        0,
        4,
    );

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 执行备份（原子操作：一次性备份所有数据库）
    let result = match backup_type.as_str() {
        "incremental" => {
            let base = match base_version {
                Some(v) => v,
                None => {
                    job_ctx.fail("增量备份需要指定 base_version 参数".to_string());
                    return;
                }
            };

            job_ctx.mark_running(
                BackupJobPhase::Compress,
                30.0,
                Some("正在执行增量备份...".to_string()),
                0,
                4,
            );

            manager.backup_incremental(&base)
        }
        _ => {
            if include_assets {
                let asset_config = if let Some(types) = asset_types {
                    let parsed_types: Vec<AssetType> = types
                        .iter()
                        .filter_map(|s| AssetType::from_str(s))
                        .collect();
                    if parsed_types.is_empty() {
                        AssetBackupConfig::default()
                    } else {
                        AssetBackupConfig {
                            asset_types: parsed_types,
                            ..Default::default()
                        }
                    }
                } else {
                    AssetBackupConfig::default()
                };

                job_ctx.mark_running(
                    BackupJobPhase::Compress,
                    30.0,
                    Some("正在备份数据库和资产文件...".to_string()),
                    0,
                    4,
                );

                manager.backup_with_assets(Some(asset_config))
            } else {
                job_ctx.mark_running(
                    BackupJobPhase::Compress,
                    30.0,
                    Some("正在备份数据库...".to_string()),
                    0,
                    4,
                );

                manager.backup_full()
            }
        }
    };

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消备份".to_string()));
        return;
    }

    // 阶段 4: 验证
    job_ctx.mark_running(
        BackupJobPhase::Verify,
        80.0,
        Some("正在验证备份...".to_string()),
        3,
        4,
    );

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(manifest) => {
            // 标记所有数据库为已处理
            for file in &manifest.files {
                if let Some(db_id) = &file.database_id {
                    job_ctx.update_checkpoint(db_id);
                }
            }

            let db_size: u64 = manifest.files.iter().map(|f| f.size).sum();
            let asset_size: u64 = manifest.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
            let backup_size = db_size + asset_size;

            let databases_backed_up: Vec<String> = manifest
                .files
                .iter()
                .filter_map(|f| f.database_id.clone())
                .collect();

            info!(
                "[data_governance] 后台备份成功: id={}, files={}, size={}, duration={}ms, retried={}",
                manifest.backup_id,
                manifest.files.len(),
                backup_size,
                duration_ms,
                is_retrying
            );

            let result_payload = BackupJobResultPayload {
                success: true,
                output_path: Some(manifest.backup_id.clone()),
                resolved_path: None,
                message: Some(format!(
                    "备份完成: {} 个数据库, {} 字节{}",
                    databases_backed_up.len(),
                    backup_size,
                    if is_retrying { " (重新执行)" } else { "" }
                )),
                error: None,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "databases_backed_up": databases_backed_up,
                    "backup_size": backup_size,
                    "db_files": manifest.files.len(),
                    "asset_files": manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0),
                    "retried_from_failure": is_retrying,
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            };

            job_ctx.complete(
                Some(format!("备份完成: {}", manifest.backup_id)),
                databases_backed_up.len() as u64,
                databases_backed_up.len() as u64,
                result_payload,
            );
        }
        Err(e) => {
            error!("[data_governance] 后台备份失败: {}", e);
            job_ctx.fail(format!("备份失败: {}", e));
        }
    }
}

/// 执行可恢复的 ZIP 导入（带断点续传支持）
///
/// 与 execute_zip_import_with_progress 类似，但会：
/// 1. 设置任务参数供持久化
/// 2. 初始化检查点
/// 3. 断点续传：跳过目标目录中已存在且大小匹配的文件
async fn execute_zip_import_with_progress_resumable(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    zip_file_path: PathBuf,
    backup_id: Option<String>,
) {
    use super::backup::zip_export::{import_backup_from_zip_resumable, ZipImportPhase};
    use std::time::Instant;

    let start = Instant::now();

    // 全局互斥：避免备份/恢复/ZIP 导入导出并发
    let _global_permit =
        match acquire_backup_global_permit(&job_ctx, "正在等待其他备份/恢复任务完成...").await
        {
            Some(p) => p,
            None => return,
        };

    // 设置任务参数（用于持久化和恢复）
    job_ctx.set_params(BackupJobParams {
        zip_path: Some(zip_file_path.to_string_lossy().to_string()),
        backup_id: backup_id.clone(),
        ..Default::default()
    });

    // 获取应用数据目录
    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            job_ctx.fail(format!("获取应用数据目录失败: {}", e));
            return;
        }
    };
    let backup_dir = get_backup_dir(&app_data_dir);

    // 确保备份目录存在
    if !backup_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            job_ctx.fail(format!("创建备份目录失败: {}", e));
            return;
        }
    }

    // 获取已处理的项目列表（用于断点续传）
    let processed_items = job_ctx.get_processed_items();
    let is_resuming = !processed_items.is_empty();

    if is_resuming {
        info!(
            "[data_governance] 从检查点恢复 ZIP 导入任务，已处理 {} 个文件",
            processed_items.len()
        );
    }

    // 确定备份 ID
    let generated_backup_id = backup_id.unwrap_or_else(|| {
        use uuid::Uuid;
        let now = chrono::Utc::now();
        let timestamp = now.format("%Y%m%d_%H%M%S").to_string();
        let millis = now.timestamp_subsec_millis();
        let rand8 = &Uuid::new_v4().simple().to_string()[..8];
        format!("{}_{}_{:03}_imported", timestamp, rand8, millis)
    });

    let target_backup_id = match validate_backup_id(&generated_backup_id) {
        Ok(id) => id,
        Err(e) => {
            job_ctx.fail(format!("backup_id 非法: {}", e));
            return;
        }
    };

    let target_dir = backup_dir.join(&target_backup_id);

    // 如果是恢复，目标目录可能已经存在（部分解压）
    if target_dir.exists() && !is_resuming {
        if let Err(e) = ensure_existing_path_within_backup_dir(&target_dir, &backup_dir) {
            job_ctx.fail(format!("备份路径校验失败: {}", e));
            return;
        }
        job_ctx.fail(format!("备份已存在: {}", target_backup_id));
        return;
    }

    // 阶段 1: 扫描
    job_ctx.mark_running(
        BackupJobPhase::Scan,
        0.0,
        Some(if is_resuming {
            "从检查点恢复，正在验证 ZIP 文件...".to_string()
        } else {
            "正在验证 ZIP 文件...".to_string()
        }),
        processed_items.len() as u64,
        0,
    );

    // 检查取消
    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消导入".to_string()));
        return;
    }

    // 使用带进度的导入函数
    let job_ctx_for_progress = job_ctx.clone();
    let job_ctx_for_cancel = job_ctx.clone();

    // 断点续传：使用 import_backup_from_zip_resumable，
    // 自动跳过目标目录中已存在且大小匹配的文件
    let result = import_backup_from_zip_resumable(
        &zip_file_path,
        &target_dir,
        |progress| {
            let phase = match progress.phase {
                ZipImportPhase::Scan => BackupJobPhase::Scan,
                ZipImportPhase::Extract => BackupJobPhase::Extract,
                ZipImportPhase::Verify => BackupJobPhase::Verify,
                ZipImportPhase::Completed => BackupJobPhase::Completed,
            };

            job_ctx_for_progress.mark_running(
                phase,
                progress.progress,
                Some(
                    if is_resuming && progress.phase == ZipImportPhase::Extract {
                        format!("(断点续传) {}", progress.message)
                    } else {
                        progress.message
                    },
                ),
                progress.processed_files as u64,
                progress.total_files as u64,
            );

            // 更新检查点
            if let Some(ref file_name) = progress.current_file {
                job_ctx_for_progress.update_checkpoint(file_name);
            }
        },
        || job_ctx_for_cancel.is_cancelled(),
    );

    match result {
        Ok(file_count) => {
            let duration_ms = start.elapsed().as_millis() as u64;

            // 阶段 4: 清理（90% - 100%）
            job_ctx.mark_running(
                BackupJobPhase::Cleanup,
                95.0,
                Some("正在清理临时文件...".to_string()),
                file_count as u64,
                file_count as u64,
            );

            // 完成
            let result_payload = BackupJobResultPayload {
                success: true,
                output_path: Some(target_backup_id.clone()),
                resolved_path: Some(target_dir.to_string_lossy().to_string()),
                message: Some(format!(
                    "ZIP 导入完成: {} 个文件, 耗时 {}ms{}",
                    file_count,
                    duration_ms,
                    if is_resuming {
                        " (从检查点恢复)"
                    } else {
                        ""
                    }
                )),
                error: None,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "backup_id": target_backup_id,
                    "file_count": file_count,
                    "zip_path": zip_file_path.to_string_lossy(),
                    "resumed_from_checkpoint": is_resuming,
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            };

            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count,
                            total_size: 0,
                        },
                        format!("zip_import/{}", target_backup_id),
                    )
                    .complete(duration_ms)
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "zip_path": zip_file_path.to_string_lossy(),
                        "backup_id": target_backup_id,
                        "backup_path": target_dir.to_string_lossy(),
                        "file_count": file_count,
                        "resumed_from_checkpoint": is_resuming,
                        "subtype": "zip_import_resumable",
                    })),
                );
            }

            job_ctx.complete(
                Some(format!("ZIP 导入完成: {}", target_backup_id)),
                file_count as u64,
                file_count as u64,
                result_payload,
            );
        }
        Err(e) => {
            let error_msg = e.to_string();
            if error_msg.contains("用户取消") || error_msg.contains("Interrupted") {
                job_ctx.cancelled(Some("用户取消导入".to_string()));
            } else {
                error!("[data_governance] ZIP 导入失败: {}", e);
                job_ctx.fail(format!("ZIP 导入失败: {}", e));
            }

            #[cfg(feature = "data_governance")]
            {
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Backup {
                            backup_type: super::audit::BackupType::Full,
                            file_count: 0,
                            total_size: 0,
                        },
                        format!("zip_import/{}", target_backup_id),
                    )
                    .fail(error_msg.clone())
                    .with_details(serde_json::json!({
                        "job_id": job_ctx.job_id.clone(),
                        "zip_path": zip_file_path.to_string_lossy(),
                        "backup_id": target_backup_id,
                        "backup_path": target_dir.to_string_lossy(),
                        "resumed_from_checkpoint": is_resuming,
                        "subtype": "zip_import_resumable",
                    })),
                );
            }
        }
    }
}

/// 恢复结果响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestoreResultResponse {
    /// 是否成功
    pub success: bool,
    /// 备份 ID
    pub backup_id: String,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 已恢复的数据库列表
    pub databases_restored: Vec<String>,
    /// 预恢复备份路径（用于回滚）
    pub pre_restore_backup_path: Option<String>,
    /// 错误信息（如果失败）
    pub error_message: Option<String>,
    /// 恢复的资产文件数量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_restored: Option<usize>,
}

// ==================== 资产备份相关命令 ====================

/// 扫描资产目录
///
/// 获取各资产类型的统计信息，用于备份前预览。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `asset_types`: 要扫描的资产类型（可选，为空表示全部）
///
/// ## 返回
/// - `AssetScanResponse`: 扫描结果
#[tauri::command]
pub async fn data_governance_scan_assets(
    app: tauri::AppHandle,
    asset_types: Option<Vec<String>>,
) -> Result<AssetScanResponse, String> {
    info!("[data_governance] 扫描资产目录");

    let active_dir = get_active_data_dir(&app)?;

    // 解析资产类型
    let types: Vec<AssetType> = asset_types
        .map(|ts| ts.iter().filter_map(|s| AssetType::from_str(s)).collect())
        .unwrap_or_default();

    // 扫描资产（使用活动数据空间目录，与 FileManager 运行时绑定的位置一致）
    let stats = super::backup::assets::scan_assets(&active_dir, &types).map_err(|e| {
        error!("[data_governance] 扫描资产失败: {}", e);
        format!("扫描资产失败: {}", e)
    })?;

    // 计算总计
    let total_files: usize = stats.values().map(|s| s.file_count).sum();
    let total_size: u64 = stats.values().map(|s| s.total_size).sum();

    info!(
        "[data_governance] 扫描完成: types={}, files={}, size={}",
        stats.len(),
        total_files,
        total_size
    );

    Ok(AssetScanResponse {
        by_type: stats,
        total_files,
        total_size,
    })
}

/// 资产扫描响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetScanResponse {
    /// 按资产类型统计
    pub by_type: std::collections::HashMap<String, AssetTypeStats>,
    /// 总文件数
    pub total_files: usize,
    /// 总大小（字节）
    pub total_size: u64,
}

/// 获取支持的资产类型
///
/// 返回系统支持的所有资产类型及其信息。
///
/// ## 返回
/// - `Vec<AssetTypeInfo>`: 资产类型列表
#[tauri::command]
pub fn data_governance_get_asset_types() -> Vec<AssetTypeInfo> {
    AssetType::all()
        .into_iter()
        .map(|t| AssetTypeInfo {
            id: t.as_str().to_string(),
            name: t.display_name().to_string(),
            relative_path: t.relative_path().to_string(),
            priority: t.priority(),
        })
        .collect()
}

/// 资产类型信息
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetTypeInfo {
    /// 资产类型 ID
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 相对路径
    pub relative_path: String,
    /// 优先级（0 为最高）
    pub priority: u8,
}

/// 执行包含资产的恢复
///
/// 从备份恢复数据库和资产文件。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要恢复的备份 ID
/// - `restore_assets`: 是否恢复资产文件
///
/// ## 返回
/// - `RestoreResultResponse`: 恢复结果
#[tauri::command]
pub async fn data_governance_restore_with_assets(
    app: tauri::AppHandle,
    backup_id: String,
    restore_assets: Option<bool>,
) -> Result<RestoreResultResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;
    let restore_assets = restore_assets.unwrap_or(false);
    info!(
        "[data_governance] 开始恢复备份（含资产）: id={}, restore_assets={}",
        validated_backup_id, restore_assets
    );

    let start = Instant::now();
    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err("备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置".to_string());
    }

    // 全局互斥：避免与正在运行的备份/恢复/ZIP 导入导出并发
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("获取全局备份锁失败: {}", e))?;

    // 创建备份管理器
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(app_data_dir.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // 获取备份清单
    let manifests = manager.list_backups().map_err(|e| {
        error!("[data_governance] 获取备份列表失败: {}", e);
        format!("获取备份列表失败: {}", e)
    })?;

    let manifest = manifests
        .iter()
        .find(|m| m.backup_id == validated_backup_id)
        .ok_or_else(|| format!("备份不存在: {}", validated_backup_id))?;

    let manifest_dir = backup_dir.join(&manifest.backup_id);
    ensure_existing_path_within_backup_dir(&manifest_dir, &backup_dir)?;

    // 恢复到非活跃插槽，避免 Windows OS error 32（活跃插槽文件被连接池持有）
    let (inactive_dir, inactive_slot) = match crate::data_space::get_data_space_manager() {
        Some(mgr) => {
            let slot = mgr.inactive_slot();
            let dir = mgr.slot_dir(slot);
            info!(
                "[data_governance] 恢复目标: 非活跃插槽 {} ({})",
                slot.name(),
                dir.display()
            );
            (dir, Some(slot))
        }
        None => {
            let dir = app_data_dir.join("slots").join("slotB");
            warn!("[data_governance] DataSpaceManager 未初始化，回退到 slotB");
            (dir, None)
        }
    };

    // 磁盘空间预检查
    {
        let db_size: u64 = manifest.files.iter().map(|f| f.size).sum();
        let asset_size: u64 = manifest.assets.as_ref().map(|a| a.total_size).unwrap_or(0);
        let required = (db_size + asset_size).saturating_mul(2);
        match crate::backup_common::get_available_disk_space(&app_data_dir) {
            Ok(available) if available < required => {
                return Err(format!(
                    "磁盘空间不足：需要 {:.1} MB，仅剩 {:.1} MB。请清理存储空间后重试",
                    required as f64 / 1024.0 / 1024.0,
                    available as f64 / 1024.0 / 1024.0
                ));
            }
            Err(e) => {
                warn!("[data_governance] 磁盘空间检查失败（继续恢复）: {}", e);
            }
            _ => {}
        }
    }

    // 执行恢复到非活跃插槽（不需要维护模式，不涉及活跃文件）
    let result = manager.restore_with_assets_to_dir(manifest, restore_assets, &inactive_dir);
    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(restored_assets) => {
            let databases_restored: Vec<String> = manifest
                .files
                .iter()
                .filter_map(|f| f.database_id.clone())
                .collect();

            info!(
                "[data_governance] 恢复成功: id={}, databases={:?}, assets={}, duration={}ms, target={}",
                validated_backup_id, databases_restored, restored_assets, duration_ms, inactive_dir.display()
            );

            // 标记下次重启时切换到恢复目标插槽
            if let Some(slot) = inactive_slot {
                if let Some(mgr) = crate::data_space::get_data_space_manager() {
                    if let Err(e) = mgr.mark_pending_switch(slot) {
                        error!("[data_governance] 标记插槽切换失败: {}，恢复的数据在 {} 中，需手动切换", e, inactive_dir.display());
                    } else {
                        info!("[data_governance] 已标记下次重启切换到 {}", slot.name());
                    }
                }
            }

            Ok(RestoreResultResponse {
                success: true,
                backup_id: backup_id.clone(),
                duration_ms,
                databases_restored,
                pre_restore_backup_path: Some(
                    inactive_dir.to_string_lossy().to_string(),
                ),
                error_message: None,
                assets_restored: if restore_assets {
                    Some(restored_assets)
                } else {
                    None
                },
            })
        }
        Err(e) => {
            error!("[data_governance] 恢复失败: {}", e);
            Err(format!(
                "恢复备份失败: {}。请前往「设置 > 数据治理」查看备份状态或重试",
                e
            ))
        }
    }
}

/// 验证备份完整性（含资产）
///
/// 验证备份文件和资产文件的完整性。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `backup_id`: 要验证的备份 ID
///
/// ## 返回
/// - `BackupVerifyWithAssetsResponse`: 验证结果
#[tauri::command]
pub async fn data_governance_verify_backup_with_assets(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupVerifyWithAssetsResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;
    info!(
        "[data_governance] 验证备份（含资产）: {}",
        validated_backup_id
    );

    let app_data_dir = get_app_data_dir(&app)?;
    let backup_dir = get_backup_dir(&app_data_dir);

    if !backup_dir.exists() {
        return Err("备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置".to_string());
    }

    let mut manager = BackupManager::new(backup_dir);
    manager.set_app_data_dir(app_data_dir.clone());

    // 全局互斥：避免与正在运行的备份/恢复/ZIP 导入导出并发
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("获取全局备份锁失败: {}", e))?;

    // 获取备份列表并查找指定的备份
    let manifests = manager
        .list_backups()
        .map_err(|e| format!("获取备份列表失败: {}", e))?;

    let manifest = manifests
        .iter()
        .find(|m| m.backup_id == validated_backup_id)
        .ok_or_else(|| format!("备份不存在: {}", validated_backup_id))?;

    let manifest_dir = app_data_dir.join("backups").join(&manifest.backup_id);
    ensure_existing_path_within_backup_dir(&manifest_dir, &app_data_dir.join("backups"))?;

    // 验证备份
    let verify_result = manager
        .verify_with_assets(manifest)
        .map_err(|e| format!("验证失败: {}", e))?;

    let has_assets = manifest.assets.is_some();
    let asset_file_count = manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0);

    info!(
        "[data_governance] 验证完成: id={}, is_valid={}, db_errors={}, asset_errors={}",
        validated_backup_id,
        verify_result.is_valid,
        verify_result.database_errors.len(),
        verify_result.asset_errors.len()
    );

    Ok(BackupVerifyWithAssetsResponse {
        is_valid: verify_result.is_valid,
        database_errors: verify_result.database_errors,
        asset_errors: verify_result
            .asset_errors
            .iter()
            .map(|e| AssetVerifyErrorResponse {
                path: e.path.clone(),
                error_type: e.error_type.clone(),
                message: e.message.clone(),
            })
            .collect(),
        has_assets,
        asset_file_count,
    })
}

/// 备份验证响应（含资产）
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupVerifyWithAssetsResponse {
    /// 是否全部有效
    pub is_valid: bool,
    /// 数据库验证错误
    pub database_errors: Vec<String>,
    /// 资产验证错误
    pub asset_errors: Vec<AssetVerifyErrorResponse>,
    /// 是否包含资产
    pub has_assets: bool,
    /// 资产文件数量
    pub asset_file_count: usize,
}

/// 资产验证错误响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetVerifyErrorResponse {
    /// 文件路径
    pub path: String,
    /// 错误类型
    pub error_type: String,
    /// 错误信息
    pub message: String,
}

// ==================== 同步相关命令 ====================

use super::sync::{
    ApplyChangesResult, ChangeLogEntry, ChangeLogStats, ConflictDetectionResult, DatabaseSyncState,
    MergeApplicationResult, MergeStrategy, PendingChanges, SyncChangeWithData, SyncDirection,
    SyncExecutionResult, SyncManager, SyncManifest,
};
use crate::cloud_storage::{create_storage, CloudStorage, CloudStorageConfig};
use std::collections::HashMap;

/// 获取同步状态
///
/// 返回当前设备的同步状态信息，包括待同步变更数量等。
///
/// ## 参数
/// - `app`: Tauri AppHandle
///
/// ## 返回
/// - `SyncStatusResponse`: 同步状态信息
#[tauri::command]
pub async fn data_governance_get_sync_status(
    app: tauri::AppHandle,
) -> Result<SyncStatusResponse, String> {
    debug!("[data_governance] 获取同步状态");

    // P0-6: 维护模式检查——禁止在备份/恢复/迁移期间访问数据库文件
    check_maintenance_mode(&app)?;

    let active_dir = get_active_data_dir(&app)?;

    let mut databases_status: Vec<DatabaseSyncStatusResponse> = Vec::new();
    let mut total_pending_changes = 0usize;
    let mut total_synced_changes = 0usize;

    // 遍历所有数据库获取同步状态
    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            // 打开数据库连接
            match rusqlite::Connection::open(&db_path) {
                Ok(conn) => {
                    // 检查 __change_log 表是否存在
                    let table_exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap_or(false);

                    if table_exists {
                        // 获取变更日志统计
                        match SyncManager::get_change_log_stats(&conn) {
                            Ok(stats) => {
                                total_pending_changes += stats.pending_count;
                                total_synced_changes += stats.synced_count;

                                // 获取上次同步时间：取 __change_log 中最新已同步记录的时间戳
                                let last_sync: Option<String> = conn
                                    .query_row(
                                        "SELECT MAX(changed_at) FROM __change_log WHERE sync_version > 0",
                                        [],
                                        |row| row.get(0),
                                    )
                                    .ok()
                                    .flatten();

                                databases_status.push(DatabaseSyncStatusResponse {
                                    id: db_id.as_str().to_string(),
                                    has_change_log: true,
                                    pending_changes: stats.pending_count,
                                    synced_changes: stats.synced_count,
                                    last_sync_at: last_sync,
                                });
                            }
                            Err(e) => {
                                debug!(
                                    "[data_governance] 获取数据库 {:?} 变更日志统计失败: {}",
                                    db_id, e
                                );
                                databases_status.push(DatabaseSyncStatusResponse {
                                    id: db_id.as_str().to_string(),
                                    has_change_log: true,
                                    pending_changes: 0,
                                    synced_changes: 0,
                                    last_sync_at: None,
                                });
                            }
                        }
                    } else {
                        databases_status.push(DatabaseSyncStatusResponse {
                            id: db_id.as_str().to_string(),
                            has_change_log: false,
                            pending_changes: 0,
                            synced_changes: 0,
                            last_sync_at: None,
                        });
                    }
                }
                Err(e) => {
                    debug!("[data_governance] 打开数据库 {:?} 失败: {}", db_id, e);
                }
            }
        }
    }

    let has_pending_changes = total_pending_changes > 0;

    info!(
        "[data_governance] 同步状态: pending={}, synced={}, databases={}",
        total_pending_changes,
        total_synced_changes,
        databases_status.len()
    );

    Ok(SyncStatusResponse {
        has_pending_changes,
        total_pending_changes,
        total_synced_changes,
        databases: databases_status,
        last_sync_at: None, // TODO: 从全局元数据获取
        device_id: get_device_id(&app),
    })
}

/// 获取设备 ID（持久化存储）
///
/// 设备 ID 会被持久化保存到应用数据目录下的 `device_id` 文件中。
/// 首次启动时生成新的 UUID 并保存，后续启动时从文件读取。
/// 使用 OnceLock 缓存已读取的设备 ID，避免重复读取文件。
fn get_device_id(app: &tauri::AppHandle) -> String {
    use std::sync::OnceLock;
    static DEVICE_ID: OnceLock<String> = OnceLock::new();

    DEVICE_ID
        .get_or_init(|| {
            // 尝试获取应用数据目录
            let app_data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    tracing::warn!("无法获取应用数据目录，使用临时设备 ID: {}", e);
                    return uuid::Uuid::new_v4().to_string();
                }
            };

            // 确保目录存在
            if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
                tracing::warn!("无法创建应用数据目录，使用临时设备 ID: {}", e);
                return uuid::Uuid::new_v4().to_string();
            }

            let device_id_path = app_data_dir.join("device_id");

            // 尝试读取现有设备 ID
            if let Ok(id) = std::fs::read_to_string(&device_id_path) {
                let id = id.trim();
                if !id.is_empty() {
                    tracing::info!("从文件加载设备 ID: {}", id);
                    return id.to_string();
                }
            }

            // 生成新设备 ID
            let new_id = uuid::Uuid::new_v4().to_string();
            tracing::info!("生成新设备 ID: {}", new_id);

            // 保存到文件
            if let Err(e) = std::fs::write(&device_id_path, &new_id) {
                tracing::warn!("无法保存设备 ID 到文件: {}", e);
            } else {
                tracing::info!("设备 ID 已保存到: {:?}", device_id_path);
            }

            new_id
        })
        .clone()
}

/// 同步状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncStatusResponse {
    /// 是否有待同步的变更
    pub has_pending_changes: bool,
    /// 待同步变更总数
    pub total_pending_changes: usize,
    /// 已同步变更总数
    pub total_synced_changes: usize,
    /// 各数据库的同步状态
    pub databases: Vec<DatabaseSyncStatusResponse>,
    /// 上次同步时间
    pub last_sync_at: Option<String>,
    /// 设备 ID
    pub device_id: String,
}

/// 数据库同步状态响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseSyncStatusResponse {
    /// 数据库 ID
    pub id: String,
    /// 是否有变更日志表
    pub has_change_log: bool,
    /// 待同步变更数量
    pub pending_changes: usize,
    /// 已同步变更数量
    pub synced_changes: usize,
    /// 上次同步时间
    pub last_sync_at: Option<String>,
}

/// 检测同步冲突
///
/// 比较本地和云端的数据状态，检测可能的冲突。
/// 注意：此命令需要云端清单作为输入，实际使用中应该从云端服务获取。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `cloud_manifest_json`: 云端同步清单的 JSON 字符串（可选，用于测试）
///
/// ## 返回
/// - `ConflictDetectionResponse`: 冲突检测结果
#[tauri::command]
pub async fn data_governance_detect_conflicts(
    app: tauri::AppHandle,
    cloud_manifest_json: Option<String>,
    cloud_config: Option<CloudStorageConfig>,
) -> Result<ConflictDetectionResponse, String> {
    info!("[data_governance] 开始检测同步冲突");

    // P0-6: 维护模式检查——禁止在备份/恢复/迁移期间访问数据库文件
    check_maintenance_mode(&app)?;

    let active_dir = get_active_data_dir(&app)?;

    // 构建本地同步清单
    let device_id = get_device_id(&app);
    let manager = SyncManager::new(device_id.clone());
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                // 获取数据库同步状态
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }
            }
        }
    }

    let local_manifest = manager.create_manifest(local_databases);

    // 云端清单来源优先级：
    // 1) 显式传入的 cloud_manifest_json（用于测试/调试）
    // 2) 传入 cloud_config 时，从云端下载清单
    let cloud_manifest: Option<SyncManifest> = if let Some(cloud_json) = cloud_manifest_json {
        Some(serde_json::from_str(&cloud_json).map_err(|e| format!("解析云端清单失败: {}", e))?)
    } else if let Some(cfg) = cloud_config {
        let storage = create_storage(&cfg)
            .await
            .map_err(|e| format!("创建云存储失败: {}", e))?;
        let cloud = manager
            .download_manifest(storage.as_ref())
            .await
            .map_err(|e| format!("从云端下载清单失败: {}", e))?;
        Some(cloud)
    } else {
        None
    };

    // 如果有云端清单，进行比较
    if let Some(cloud_manifest) = cloud_manifest {
        let detection_result = SyncManager::detect_conflicts(&local_manifest, &cloud_manifest)
            .map_err(|e| format!("冲突检测失败: {}", e))?;

        info!(
            "[data_governance] 冲突检测完成: has_conflicts={}, needs_migration={}, db_conflicts={}, record_conflicts={}",
            detection_result.has_conflicts,
            detection_result.needs_migration,
            detection_result.database_conflicts.len(),
            detection_result.record_conflicts.len()
        );

        Ok(ConflictDetectionResponse {
            has_conflicts: detection_result.has_conflicts,
            needs_migration: detection_result.needs_migration,
            database_conflicts: detection_result
                .database_conflicts
                .iter()
                .map(|c| DatabaseConflictResponse {
                    database_name: c.database_name.clone(),
                    conflict_type: format!("{:?}", c.conflict_type),
                    local_version: c.local_state.as_ref().map(|s| s.data_version),
                    cloud_version: c.cloud_state.as_ref().map(|s| s.data_version),
                    local_schema_version: c.local_state.as_ref().map(|s| s.schema_version),
                    cloud_schema_version: c.cloud_state.as_ref().map(|s| s.schema_version),
                })
                .collect(),
            record_conflict_count: detection_result.record_conflicts.len(),
            local_manifest_json: serde_json::to_string(&local_manifest).ok(),
            cloud_manifest_json: serde_json::to_string(&cloud_manifest).ok(),
        })
    } else {
        // 没有云端清单，只返回本地状态
        info!("[data_governance] 无云端清单，返回本地状态");

        Ok(ConflictDetectionResponse {
            has_conflicts: false,
            needs_migration: false,
            database_conflicts: vec![],
            record_conflict_count: 0,
            local_manifest_json: serde_json::to_string(&local_manifest).ok(),
            cloud_manifest_json: None,
        })
    }
}

/// 冲突检测响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConflictDetectionResponse {
    /// 是否有冲突
    pub has_conflicts: bool,
    /// 是否需要迁移
    pub needs_migration: bool,
    /// 数据库级冲突列表
    pub database_conflicts: Vec<DatabaseConflictResponse>,
    /// 记录级冲突数量
    pub record_conflict_count: usize,
    /// 本地清单 JSON（用于调试）
    pub local_manifest_json: Option<String>,
    /// 云端清单 JSON（用于后续冲突解决/调试）
    pub cloud_manifest_json: Option<String>,
}

/// 数据库冲突响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseConflictResponse {
    /// 数据库名称
    pub database_name: String,
    /// 冲突类型
    pub conflict_type: String,
    /// 本地数据版本
    pub local_version: Option<u64>,
    /// 云端数据版本
    pub cloud_version: Option<u64>,
    /// 本地 Schema 版本
    pub local_schema_version: Option<u32>,
    /// 云端 Schema 版本
    pub cloud_schema_version: Option<u32>,
}

/// 应用合并策略解决冲突
///
/// 根据指定的合并策略处理所有检测到的冲突。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `strategy`: 合并策略 ("keep_local", "use_cloud", "keep_latest")
/// - `cloud_manifest_json`: 云端同步清单的 JSON 字符串
///
/// ## 返回
/// - `SyncResultResponse`: 同步结果
#[tauri::command]
pub async fn data_governance_resolve_conflicts(
    app: tauri::AppHandle,
    strategy: String,
    cloud_manifest_json: String,
) -> Result<SyncResultResponse, String> {
    info!("[data_governance] 开始解决冲突，策略: {}", strategy);

    // P0-6: 维护模式检查——禁止在备份/恢复/迁移期间访问数据库文件
    check_maintenance_mode(&app)?;

    let start = Instant::now();

    // 解析合并策略
    let merge_strategy = match strategy.as_str() {
        "keep_local" => MergeStrategy::KeepLocal,
        "use_cloud" => MergeStrategy::UseCloud,
        "keep_latest" => MergeStrategy::KeepLatest,
        "manual" => MergeStrategy::Manual,
        _ => {
            return Err(format!(
                "未知的合并策略: {}。可选值: keep_local, use_cloud, keep_latest, manual",
                strategy
            ))
        }
    };

    // 解析云端清单
    let cloud_manifest: SyncManifest = serde_json::from_str(&cloud_manifest_json)
        .map_err(|e| format!("解析云端清单失败: {}", e))?;

    let active_dir = get_active_data_dir(&app)?;

    // 构建本地同步清单
    let device_id = get_device_id(&app);
    let manager = SyncManager::new(device_id.clone());
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }
            }
        }
    }

    let local_manifest = manager.create_manifest(local_databases);

    // 检测冲突
    let detection_result = SyncManager::detect_conflicts(&local_manifest, &cloud_manifest)
        .map_err(|e| format!("冲突检测失败: {}", e))?;

    // 如果没有冲突，直接返回成功
    if !detection_result.has_conflicts {
        let duration_ms = start.elapsed().as_millis() as u64;
        info!(
            "[data_governance] 无冲突，同步完成: duration={}ms",
            duration_ms
        );

        return Ok(SyncResultResponse {
            success: true,
            strategy: strategy.clone(),
            synced_databases: detection_result.database_conflicts.len(),
            resolved_conflicts: 0,
            pending_manual_conflicts: 0,
            records_to_push: vec![],
            records_to_pull: vec![],
            duration_ms,
            error_message: None,
        });
    }

    // 应用合并策略处理记录级冲突
    let merge_result =
        SyncManager::apply_merge_strategy(merge_strategy, &detection_result.record_conflicts)
            .map_err(|e| format!("应用合并策略失败: {}", e))?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "[data_governance] 冲突解决完成: kept_local={}, used_cloud={}, to_push={}, to_pull={}, duration={}ms",
        merge_result.kept_local,
        merge_result.used_cloud,
        merge_result.records_to_push.len(),
        merge_result.records_to_pull.len(),
        duration_ms
    );

    Ok(SyncResultResponse {
        success: merge_result.success,
        strategy,
        synced_databases: detection_result.database_conflicts.len(),
        resolved_conflicts: merge_result.kept_local + merge_result.used_cloud,
        pending_manual_conflicts: if merge_strategy == MergeStrategy::Manual {
            detection_result.record_conflicts.len()
        } else {
            0
        },
        records_to_push: merge_result.records_to_push,
        records_to_pull: merge_result.records_to_pull,
        duration_ms,
        error_message: if merge_result.errors.is_empty() {
            None
        } else {
            Some(merge_result.errors.join("; "))
        },
    })
}

/// 同步结果响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncResultResponse {
    /// 是否成功
    pub success: bool,
    /// 使用的合并策略
    pub strategy: String,
    /// 同步的数据库数量
    pub synced_databases: usize,
    /// 解决的冲突数量
    pub resolved_conflicts: usize,
    /// 待手动处理的冲突数量
    pub pending_manual_conflicts: usize,
    /// 需要推送到云端的记录 ID 列表
    pub records_to_push: Vec<String>,
    /// 需要从云端拉取的记录 ID 列表
    pub records_to_pull: Vec<String>,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 错误信息（如果有）
    pub error_message: Option<String>,
}

// ==================== 云存储同步执行命令 ====================

/// 执行同步
///
/// 使用云存储执行实际的同步操作。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `direction`: 同步方向 ("upload", "download", "bidirectional")
/// - `cloud_config`: 云存储配置（可选，如果未提供则使用默认配置或返回错误）
/// - `strategy`: 冲突合并策略 ("keep_local", "use_cloud", "keep_latest")，默认为 "keep_latest"
///
/// ## 返回
/// - `SyncExecutionResponse`: 同步执行结果
#[tauri::command]
pub async fn data_governance_run_sync(
    app: tauri::AppHandle,
    direction: String,
    cloud_config: Option<CloudStorageConfig>,
    strategy: Option<String>,
) -> Result<SyncExecutionResponse, String> {
    info!(
        "[data_governance] 开始执行同步: direction={}, strategy={:?}",
        direction, strategy
    );

    // P0-6: 维护模式检查——禁止在备份/恢复/迁移期间访问数据库文件
    check_maintenance_mode(&app)?;

    let start = Instant::now();

    // 解析同步方向
    let sync_direction = SyncDirection::from_str(&direction).ok_or_else(|| {
        format!(
            "无效的同步方向: {}。可选值: upload, download, bidirectional",
            direction
        )
    })?;

    // 解析合并策略
    let merge_strategy = match strategy.as_deref().unwrap_or("keep_latest") {
        "keep_local" => MergeStrategy::KeepLocal,
        "use_cloud" => MergeStrategy::UseCloud,
        "keep_latest" => MergeStrategy::KeepLatest,
        "manual" => MergeStrategy::Manual,
        s => {
            return Err(format!(
                "无效的合并策略: {}。可选值: keep_local, use_cloud, keep_latest, manual",
                s
            ))
        }
    };

    // 获取云存储配置
    let config = match cloud_config {
        Some(cfg) => cfg,
        None => {
            // TODO: 从应用配置或状态中获取默认云存储配置
            return Err("未提供云存储配置。请在调用前配置云存储。".to_string());
        }
    };

    // 获取设备 ID（用于审计与同步清单）
    let device_id = get_device_id(&app);

    #[cfg(feature = "data_governance")]
    {
        let audit_direction = match sync_direction {
            SyncDirection::Upload => super::audit::SyncDirection::Upload,
            SyncDirection::Download => super::audit::SyncDirection::Download,
            SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
        };

        // 注意：审计 details 不应包含敏感凭据
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Sync {
                    direction: audit_direction,
                    records_affected: 0,
                },
                format!("cloud_sync/{}", sync_direction.as_str()),
            )
            .with_details(serde_json::json!({
                "device_id": device_id.clone(),
                "direction": direction.clone(),
                "strategy": strategy.as_deref().unwrap_or("keep_latest"),
                "provider": format!("{:?}", config.provider),
                "root": config.root.clone(),
            })),
        );
    }

    // P1-4: 全局互斥（带超时）：避免与备份/恢复/ZIP 导入导出并发，降低一致性风险
    let _permit = tokio::time::timeout(
        std::time::Duration::from_secs(SYNC_LOCK_TIMEOUT_SECS),
        BACKUP_GLOBAL_LIMITER.clone().acquire_owned(),
    )
    .await
    .map_err(|_| {
        format!(
            "等待全局数据治理锁超时（{}秒），可能有其他数据治理操作正在执行，请稍后再试。",
            SYNC_LOCK_TIMEOUT_SECS
        )
    })?
    .map_err(|_| "获取全局数据治理锁失败".to_string())?;

    // 创建云存储实例
    let storage = create_storage(&config)
        .await
        .map_err(|e| format!("创建云存储失败: {}", e))?;

    let active_dir = get_active_data_dir(&app)?;

    // 创建同步管理器
    let manager = SyncManager::new(device_id.clone());

    // 构建本地同步清单（遍历所有治理数据库）
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }
            }
        }
    }

    let local_manifest = manager.create_manifest(local_databases);

    // 遍历所有数据库，收集待同步变更并用 enrich_changes_with_data 补全完整记录数据
    let mut all_enriched: Vec<SyncChangeWithData> = Vec::new();
    let mut all_change_ids: Vec<i64> = Vec::new();
    let mut db_found = false;

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        db_found = true;

        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("打开数据库 {} 失败: {}", db_id.as_str(), e))?;

        // 检查 __change_log 表是否存在
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !table_exists {
            continue;
        }

        let pending = SyncManager::get_pending_changes(&conn, None, None)
            .map_err(|e| format!("获取数据库 {} 待同步变更失败: {}", db_id.as_str(), e))?;

        if pending.has_changes() {
            // 使用 enrich_changes_with_data 补全完整记录数据（INSERT/UPDATE 包含真实行内容）
            let mut enriched = SyncManager::enrich_changes_with_data(&conn, &pending.entries, None)
                .map_err(|e| format!("补全数据库 {} 变更数据失败: {}", db_id.as_str(), e))?;

            // 为每条变更标注来源数据库名称，下载回放时按库路由
            for change in &mut enriched {
                change.database_name = Some(db_id.as_str().to_string());
            }

            all_change_ids.extend(pending.get_change_ids());
            all_enriched.extend(enriched);
        }
    }

    if !db_found {
        return Err("未找到可用的数据库。请先初始化数据库。".to_string());
    }

    // 构建带完整数据的 PendingChanges 用于上传
    let enriched_pending = PendingChanges::from_entries(
        all_enriched
            .iter()
            .map(|e| ChangeLogEntry {
                id: e.change_log_id.unwrap_or(0),
                table_name: e.table_name.clone(),
                record_id: e.record_id.clone(),
                operation: e.operation,
                changed_at: e.changed_at.clone(),
                sync_version: 0,
            })
            .collect(),
    );

    // 执行同步（异步操作），返回 (结果, 跳过数量)
    let result: Result<(SyncExecutionResult, usize), String> = match sync_direction {
        SyncDirection::Upload => {
            // 上传带完整数据的变更
            manager
                .upload_enriched_changes(storage.as_ref(), &all_enriched)
                .await
                .map_err(|e| format!("上传同步失败: {}", e))?;

            manager
                .upload_manifest(storage.as_ref(), &local_manifest)
                .await
                .map_err(|e| format!("上传清单失败: {}", e))?;

            // 标记变更为已同步（按数据库分别标记）
            for db_id in DatabaseId::all_ordered() {
                let db_path = resolve_database_path(&db_id, &active_dir);
                if !db_path.exists() {
                    continue;
                }
                let conn = rusqlite::Connection::open(&db_path)
                    .map_err(|e| format!("打开数据库失败: {}", e))?;
                let db_change_ids: Vec<i64> = all_enriched
                    .iter()
                    .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
                    .filter_map(|c| c.change_log_id)
                    .collect();
                if !db_change_ids.is_empty() {
                    SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                        .map_err(|e| format!("标记变更失败: {}", e))?;
                }
            }

            Ok((
                SyncExecutionResult {
                    success: true,
                    direction: SyncDirection::Upload,
                    changes_uploaded: all_enriched.len(),
                    changes_downloaded: 0,
                    conflicts_detected: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error_message: None,
                },
                0,
            ))
        }
        SyncDirection::Download => {
            let (exec_result, downloaded_changes) = manager
                .execute_download(storage.as_ref(), &local_manifest, merge_strategy)
                .await
                .map_err(|e| format!("下载同步失败: {}", e))?;

            // 下载的变更已包含完整数据，按来源数据库路由并应用
            let mut exec_result = exec_result;
            let mut total_skipped = 0usize;
            if !downloaded_changes.is_empty() {
                let apply_agg =
                    apply_downloaded_changes_to_databases(&downloaded_changes, &active_dir)?;
                total_skipped = apply_agg.total_skipped;
                if total_skipped > 0 {
                    warn!(
                        "[data_governance] 同步完成但有 {} 条变更被跳过（旧格式数据缺失），建议在源设备重新执行完整同步",
                        total_skipped
                    );
                    exec_result.error_message = Some(format!(
                        "同步已完成，但有 {} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。",
                        total_skipped
                    ));
                }
            }

            Ok((exec_result, total_skipped))
        }
        SyncDirection::Bidirectional => {
            // execute_bidirectional 只负责下载，上传由此处统一执行
            let (exec_result, change_ids, downloaded_changes) = manager
                .execute_bidirectional(
                    storage.as_ref(),
                    &enriched_pending,
                    &local_manifest,
                    merge_strategy,
                )
                .await
                .map_err(|e| format!("双向同步失败: {}", e))?;

            // 上传带完整数据的变更（唯一上传点，避免重复）
            if !all_enriched.is_empty() {
                manager
                    .upload_enriched_changes(storage.as_ref(), &all_enriched)
                    .await
                    .map_err(|e| format!("上传变更失败: {}", e))?;
            }
            manager
                .upload_manifest(storage.as_ref(), &local_manifest)
                .await
                .map_err(|e| format!("上传清单失败: {}", e))?;

            // 应用下载的变更（已包含完整数据，直接按库路由）
            let mut exec_result = exec_result;
            let mut total_skipped = 0usize;
            if !downloaded_changes.is_empty() {
                let apply_agg =
                    apply_downloaded_changes_to_databases(&downloaded_changes, &active_dir)?;
                total_skipped = apply_agg.total_skipped;
                if total_skipped > 0 {
                    warn!(
                        "[data_governance] 双向同步完成但有 {} 条变更被跳过（旧格式数据缺失）",
                        total_skipped
                    );
                    exec_result.error_message = Some(format!(
                        "同步已完成，但有 {} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。",
                        total_skipped
                    ));
                }
            }

            // 下载成功应用后再标记本地变更已同步，避免中断导致“标记成功但下载未落地”。
            for db_id in DatabaseId::all_ordered() {
                let db_path = resolve_database_path(&db_id, &active_dir);
                if !db_path.exists() {
                    continue;
                }
                let conn = rusqlite::Connection::open(&db_path)
                    .map_err(|e| format!("打开数据库失败: {}", e))?;
                let db_change_ids: Vec<i64> = all_enriched
                    .iter()
                    .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
                    .filter_map(|c| c.change_log_id)
                    .collect();
                if !db_change_ids.is_empty() {
                    SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                        .map_err(|e| format!("标记变更失败: {}", e))?;
                }
            }

            if !change_ids.is_empty() {
                tracing::debug!(
                    "[data_governance] 双向同步标记变更完成: {} 条",
                    change_ids.len()
                );
            }

            Ok((exec_result, total_skipped))
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok((exec_result, skipped)) => {
            info!(
                "[data_governance] 同步完成: direction={}, uploaded={}, downloaded={}, conflicts={}, skipped={}, duration={}ms",
                exec_result.direction.as_str(),
                exec_result.changes_uploaded,
                exec_result.changes_downloaded,
                exec_result.conflicts_detected,
                skipped,
                exec_result.duration_ms
            );

            #[cfg(feature = "data_governance")]
            {
                let audit_direction = match exec_result.direction {
                    SyncDirection::Upload => super::audit::SyncDirection::Upload,
                    SyncDirection::Download => super::audit::SyncDirection::Download,
                    SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
                };
                let records_affected =
                    exec_result.changes_uploaded + exec_result.changes_downloaded;
                let base_log = AuditLog::new(
                    AuditOperation::Sync {
                        direction: audit_direction,
                        records_affected,
                    },
                    format!("cloud_sync/{}", exec_result.direction.as_str()),
                )
                .with_details(serde_json::json!({
                    "device_id": device_id.clone(),
                    "direction": exec_result.direction.as_str(),
                    "strategy": strategy.clone().unwrap_or_else(|| "keep_latest".to_string()),
                    "changes_uploaded": exec_result.changes_uploaded,
                    "changes_downloaded": exec_result.changes_downloaded,
                    "conflicts_detected": exec_result.conflicts_detected,
                }));

                if exec_result.success {
                    try_save_audit_log(&app, base_log.complete(exec_result.duration_ms));
                } else {
                    try_save_audit_log(
                        &app,
                        base_log.fail(
                            exec_result
                                .error_message
                                .clone()
                                .unwrap_or_else(|| "sync failed".to_string()),
                        ),
                    );
                }
            }

            Ok(SyncExecutionResponse {
                success: exec_result.success,
                direction: exec_result.direction.as_str().to_string(),
                changes_uploaded: exec_result.changes_uploaded,
                changes_downloaded: exec_result.changes_downloaded,
                conflicts_detected: exec_result.conflicts_detected,
                duration_ms: exec_result.duration_ms,
                device_id,
                error_message: exec_result.error_message.clone(),
                skipped_changes: skipped,
            })
        }
        Err(e) => {
            error!("[data_governance] 同步失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                let audit_direction = match sync_direction {
                    SyncDirection::Upload => super::audit::SyncDirection::Upload,
                    SyncDirection::Download => super::audit::SyncDirection::Download,
                    SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
                };
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Sync {
                            direction: audit_direction,
                            records_affected: 0,
                        },
                        format!("cloud_sync/{}", sync_direction.as_str()),
                    )
                    .fail(e.to_string())
                    .with_details(serde_json::json!({
                        "device_id": device_id.clone(),
                        "direction": sync_direction.as_str(),
                        "strategy": strategy.clone().unwrap_or_else(|| "keep_latest".to_string()),
                    })),
                );
            }
            Ok(SyncExecutionResponse {
                success: false,
                direction: sync_direction.as_str().to_string(),
                changes_uploaded: 0,
                changes_downloaded: 0,
                conflicts_detected: 0,
                duration_ms,
                device_id,
                error_message: Some(e),
                skipped_changes: 0,
            })
        }
    }
}

/// 同步执行响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncExecutionResponse {
    /// 是否成功
    pub success: bool,
    /// 同步方向
    pub direction: String,
    /// 上传的变更数量
    pub changes_uploaded: usize,
    /// 下载的变更数量
    pub changes_downloaded: usize,
    /// 检测到的冲突数量
    pub conflicts_detected: usize,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
    /// 设备 ID
    pub device_id: String,
    /// 错误/警告信息（如果有）
    pub error_message: Option<String>,
    /// 被跳过的变更数量（如旧格式数据不完整）
    /// 前端可据此展示"部分完成"状态而非纯成功
    #[serde(default)]
    pub skipped_changes: usize,
}

/// 导出同步数据到本地文件
///
/// 将同步清单和变更数据导出为 JSON 文件，用于手动同步或调试。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `output_path`: 输出文件路径（可选，默认为应用数据目录下的 sync_export.json）
///
/// ## 返回
/// - `SyncExportResponse`: 导出结果
#[tauri::command]
pub async fn data_governance_export_sync_data(
    app: tauri::AppHandle,
    output_path: Option<String>,
) -> Result<SyncExportResponse, String> {
    info!("[data_governance] 导出同步数据");

    let active_dir = get_active_data_dir(&app)?;
    let app_data_dir = get_app_data_dir(&app)?;

    // 获取设备 ID
    let device_id = get_device_id(&app);

    // 创建同步管理器
    let manager = SyncManager::new(device_id.clone());

    // 构建本地同步清单（使用带完整数据的变更）
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();
    let mut all_enriched_changes: Vec<SyncChangeWithData> = Vec::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                // 获取数据库状态
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }

                // 获取待同步变更并补全完整数据
                if let Ok(pending) = SyncManager::get_pending_changes(&conn, None, None) {
                    if pending.has_changes() {
                        match SyncManager::enrich_changes_with_data(&conn, &pending.entries, None) {
                            Ok(mut enriched) => {
                                for change in &mut enriched {
                                    change.database_name = Some(db_id.as_str().to_string());
                                }
                                all_enriched_changes.extend(enriched);
                            }
                            Err(e) => {
                                warn!(
                                    "[data_governance] 补全数据库 {} 变更数据失败: {}",
                                    db_id.as_str(),
                                    e
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let manifest = manager.create_manifest(local_databases);

    // 构建导出数据（使用带完整数据的变更）
    let export_data = SyncExportData {
        manifest,
        pending_changes: all_enriched_changes.clone(),
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    // 序列化
    let json = serde_json::to_string_pretty(&export_data)
        .map_err(|e| format!("序列化导出数据失败: {}", e))?;

    // 确定输出路径
    let output = match output_path {
        Some(p) => {
            let user_path = std::path::PathBuf::from(&p);
            validate_user_path(&user_path, &app_data_dir)?;
            user_path
        }
        None => active_dir.join("sync_export.json"),
    };

    // 确保父目录存在
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    // 写入文件
    std::fs::write(&output, &json).map_err(|e| format!("写入文件失败: {}", e))?;

    info!(
        "[data_governance] 同步数据已导出: path={}, changes={}",
        output.display(),
        all_enriched_changes.len()
    );

    Ok(SyncExportResponse {
        success: true,
        output_path: output.to_string_lossy().to_string(),
        manifest_databases: export_data.manifest.databases.len(),
        pending_changes_count: all_enriched_changes.len(),
    })
}

/// 同步导出数据（v2：含完整记录数据）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncExportData {
    /// 同步清单
    pub manifest: SyncManifest,
    /// 待同步的变更（含完整记录数据，支持跨设备回放）
    pub pending_changes: Vec<SyncChangeWithData>,
    /// 导出时间
    pub exported_at: String,
}

/// 同步导出响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncExportResponse {
    /// 是否成功
    pub success: bool,
    /// 输出文件路径
    pub output_path: String,
    /// 清单中的数据库数量
    pub manifest_databases: usize,
    /// 待同步变更数量
    pub pending_changes_count: usize,
}

/// 从本地文件导入同步数据
///
/// 从 JSON 文件导入同步清单和变更数据，用于手动同步或恢复。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `input_path`: 输入文件路径
/// - `strategy`: 冲突合并策略
///
/// ## 返回
/// - `SyncImportResponse`: 导入结果
#[tauri::command]
pub async fn data_governance_import_sync_data(
    app: tauri::AppHandle,
    input_path: String,
    strategy: Option<String>,
) -> Result<SyncImportResponse, String> {
    info!("[data_governance] 导入同步数据: path={}", input_path);

    let app_data_dir = get_app_data_dir(&app)?;
    let active_dir = get_active_data_dir(&app)?;

    // 验证输入路径在安全范围内
    let input_file = std::path::PathBuf::from(&input_path);
    validate_user_path(&input_file, &app_data_dir)?;

    // 读取文件
    let json = std::fs::read_to_string(&input_path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 解析（v2 格式含完整数据）
    let import_data: SyncExportData =
        serde_json::from_str(&json).map_err(|e| format!("解析导入数据失败: {}", e))?;

    // 创建同步管理器
    let device_id = get_device_id(&app);
    let manager = SyncManager::new(device_id.clone());

    // 构建本地同步清单
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }
            }
        }
    }

    let local_manifest = manager.create_manifest(local_databases);

    // 检测冲突
    let detection = SyncManager::detect_conflicts(&local_manifest, &import_data.manifest)
        .map_err(|e| format!("冲突检测失败: {}", e))?;

    // 解析合并策略
    let merge_strategy = match strategy.as_deref().unwrap_or("keep_latest") {
        "keep_local" => MergeStrategy::KeepLocal,
        "use_cloud" => MergeStrategy::UseCloud,
        "keep_latest" => MergeStrategy::KeepLatest,
        "manual" => MergeStrategy::Manual,
        s => {
            return Err(format!(
                "无效的合并策略: {}。可选值: keep_local, use_cloud, keep_latest, manual",
                s
            ))
        }
    };

    // 如果有冲突且是手动模式
    if detection.has_conflicts && merge_strategy == MergeStrategy::Manual {
        return Ok(SyncImportResponse {
            success: false,
            imported_changes: 0,
            conflicts_detected: detection.total_conflicts(),
            needs_manual_resolution: true,
            error_message: Some(
                "存在冲突，需要手动解决。请前往「同步」面板选择合适的解决策略".to_string(),
            ),
        });
    }

    // 应用变更到本地数据库（v2 格式已含完整数据，按数据库路由）
    let mut total_applied = 0usize;
    let mut total_skipped = 0usize;
    let total_failed = 0usize;

    if !import_data.pending_changes.is_empty() {
        // 导入的变更已含完整记录数据，直接按数据库路由并应用
        match apply_downloaded_changes_to_databases(&import_data.pending_changes, &active_dir) {
            Ok(apply_agg) => {
                total_applied = apply_agg.total_success;
                total_skipped = apply_agg.total_skipped;
                info!(
                    "[data_governance] 导入变更应用完成: applied={}, skipped={}",
                    total_applied, total_skipped
                );
            }
            Err(e) => {
                error!("[data_governance] 应用导入变更失败: {}", e);
                return Err(format!(
                    "应用导入变更失败: {}。请检查导入文件完整性后重试",
                    e
                ));
            }
        }
    }

    info!(
        "[data_governance] 同步数据导入完成: applied={}, failed={}, conflicts={}",
        total_applied,
        total_failed,
        detection.total_conflicts()
    );

    let error_message = if total_failed > 0 {
        Some(format!("{}条变更应用失败", total_failed))
    } else if total_skipped > 0 {
        Some(format!(
            "导入已完成，但有 {} 条变更因数据不完整被跳过。建议在源设备重新导出完整同步数据。",
            total_skipped
        ))
    } else {
        None
    };

    Ok(SyncImportResponse {
        success: total_failed == 0,
        imported_changes: total_applied,
        conflicts_detected: detection.total_conflicts(),
        needs_manual_resolution: false,
        error_message,
    })
}

/// 同步导入响应
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncImportResponse {
    /// 是否成功
    pub success: bool,
    /// 导入的变更数量
    pub imported_changes: usize,
    /// 检测到的冲突数量
    pub conflicts_detected: usize,
    /// 是否需要手动解决冲突
    pub needs_manual_resolution: bool,
    /// 错误信息（如果有）
    pub error_message: Option<String>,
}

// ==================== 带进度回调的同步命令 ====================

use super::sync::{OptionalEmitter, SyncPhase, SyncProgress, SyncProgressEmitter};

/// 执行带进度回调的同步
///
/// 与 `data_governance_run_sync` 类似，但会通过事件通道发送进度更新。
/// 前端可以监听 `data-governance-sync-progress` 事件获取实时进度。
///
/// ## 参数
/// - `app`: Tauri AppHandle
/// - `direction`: 同步方向 ("upload", "download", "bidirectional")
/// - `cloud_config`: 云存储配置（可选，如果未提供则使用默认配置或返回错误）
/// - `strategy`: 冲突合并策略 ("keep_local", "use_cloud", "keep_latest")，默认为 "keep_latest"
///
/// ## 进度事件
/// 前端可以通过以下方式监听进度：
/// ```javascript
/// import { listen } from '@tauri-apps/api/event';
///
/// const unlisten = await listen('data-governance-sync-progress', (event) => {
///   const progress = event.payload;
///   console.log(`Phase: ${progress.phase}, Progress: ${progress.percent}%`);
/// });
/// ```
///
/// ## 返回
/// - `SyncExecutionResponse`: 同步执行结果
#[tauri::command]
pub async fn data_governance_run_sync_with_progress(
    app: tauri::AppHandle,
    direction: String,
    cloud_config: Option<CloudStorageConfig>,
    strategy: Option<String>,
) -> Result<SyncExecutionResponse, String> {
    info!(
        "[data_governance] 开始执行带进度的同步: direction={}, strategy={:?}",
        direction, strategy
    );

    // P0-6: 维护模式检查——禁止在备份/恢复/迁移期间访问数据库文件
    check_maintenance_mode(&app)?;

    let start = Instant::now();

    // 创建进度发射器
    let emitter = SyncProgressEmitter::new(app.clone());

    // 发送准备中状态
    emitter.emit_preparing().await;

    // 解析同步方向
    let sync_direction = match SyncDirection::from_str(&direction) {
        Some(d) => d,
        None => {
            let error_msg = format!(
                "无效的同步方向: {}。可选值: upload, download, bidirectional",
                direction
            );
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
    };

    // 解析合并策略
    let merge_strategy = match strategy.as_deref().unwrap_or("keep_latest") {
        "keep_local" => MergeStrategy::KeepLocal,
        "use_cloud" => MergeStrategy::UseCloud,
        "keep_latest" => MergeStrategy::KeepLatest,
        "manual" => MergeStrategy::Manual,
        s => {
            let error_msg = format!(
                "无效的合并策略: {}。可选值: keep_local, use_cloud, keep_latest, manual",
                s
            );
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
    };

    // 获取云存储配置
    let config = match cloud_config {
        Some(cfg) => cfg,
        None => {
            let error_msg = "未提供云存储配置。请在调用前配置云存储。".to_string();
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
    };

    // 获取设备 ID（用于审计与同步清单）
    let device_id = get_device_id(&app);

    #[cfg(feature = "data_governance")]
    {
        let audit_direction = match sync_direction {
            SyncDirection::Upload => super::audit::SyncDirection::Upload,
            SyncDirection::Download => super::audit::SyncDirection::Download,
            SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
        };

        // 注意：审计 details 不应包含敏感凭据
        try_save_audit_log(
            &app,
            AuditLog::new(
                AuditOperation::Sync {
                    direction: audit_direction,
                    records_affected: 0,
                },
                format!("cloud_sync/{}", sync_direction.as_str()),
            )
            .with_details(serde_json::json!({
                "device_id": device_id.clone(),
                "direction": direction.clone(),
                "strategy": strategy.as_deref().unwrap_or("keep_latest"),
                "provider": format!("{:?}", config.provider),
                "root": config.root.clone(),
                "with_progress": true,
            })),
        );
    }

    // P1-4: 全局互斥（带超时）：避免与备份/恢复/ZIP 导入导出并发，降低一致性风险
    let _permit = match tokio::time::timeout(
        std::time::Duration::from_secs(SYNC_LOCK_TIMEOUT_SECS),
        BACKUP_GLOBAL_LIMITER.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(p)) => p,
        Ok(Err(_)) => {
            let error_msg = "获取全局数据治理锁失败".to_string();
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
        Err(_) => {
            let error_msg = format!(
                "等待全局数据治理锁超时（{}秒），可能有其他数据治理操作正在执行，请稍后再试。",
                SYNC_LOCK_TIMEOUT_SECS
            );
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
    };

    // 发送检测变更状态
    emitter.emit_detecting_changes().await;

    // 创建云存储实例
    let storage = match create_storage(&config).await {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!("创建云存储失败: {}", e);
            emitter.emit_failed(&error_msg).await;
            return Err(error_msg);
        }
    };

    let active_dir = match get_active_data_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            emitter.emit_failed(&e).await;
            return Err(e);
        }
    };

    // 创建同步管理器（复用上方已获取的 device_id）
    let manager = SyncManager::new(device_id.clone());

    // 构建本地同步清单（遍历所有治理数据库）
    let mut local_databases: HashMap<String, DatabaseSyncState> = HashMap::new();

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);

        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                    local_databases.insert(db_id.as_str().to_string(), state);
                }
            }
        }
    }

    let local_manifest = manager.create_manifest(local_databases);

    // 遍历所有数据库，收集待同步变更并补全完整记录数据
    let mut all_enriched: Vec<SyncChangeWithData> = Vec::new();
    let mut db_found = false;

    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        db_found = true;

        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                let error_msg = format!("打开数据库 {} 失败: {}", db_id.as_str(), e);
                emitter.emit_failed(&error_msg).await;
                return Err(error_msg);
            }
        };

        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !table_exists {
            continue;
        }

        match SyncManager::get_pending_changes(&conn, None, None) {
            Ok(pending) if pending.has_changes() => {
                match SyncManager::enrich_changes_with_data(&conn, &pending.entries, None) {
                    Ok(mut enriched) => {
                        for change in &mut enriched {
                            change.database_name = Some(db_id.as_str().to_string());
                        }
                        all_enriched.extend(enriched);
                    }
                    Err(e) => {
                        let error_msg =
                            format!("补全数据库 {} 变更数据失败: {}", db_id.as_str(), e);
                        emitter.emit_failed(&error_msg).await;
                        return Err(error_msg);
                    }
                }
            }
            _ => {}
        }
    }

    if !db_found {
        let error_msg = "未找到可用的数据库。请先初始化数据库。".to_string();
        emitter.emit_failed(&error_msg).await;
        return Err(error_msg);
    }

    // 构建 PendingChanges 用于兼容 execute_upload 接口
    let pending = PendingChanges::from_entries(
        all_enriched
            .iter()
            .map(|e| ChangeLogEntry {
                id: e.change_log_id.unwrap_or(0),
                table_name: e.table_name.clone(),
                record_id: e.record_id.clone(),
                operation: e.operation,
                changed_at: e.changed_at.clone(),
                sync_version: 0,
            })
            .collect(),
    );

    // 使用 OptionalEmitter 包装
    let opt_emitter = OptionalEmitter::with_emitter(emitter.clone());

    // 执行同步（带进度回调）
    let result = match sync_direction {
        SyncDirection::Upload => {
            execute_upload_with_progress_v2(
                &manager,
                storage.as_ref(),
                &all_enriched,
                &pending,
                &local_manifest,
                &active_dir,
                &opt_emitter,
            )
            .await
        }
        SyncDirection::Download => {
            execute_download_with_progress_v2(
                &manager,
                storage.as_ref(),
                &local_manifest,
                merge_strategy,
                &active_dir,
                &opt_emitter,
            )
            .await
        }
        SyncDirection::Bidirectional => {
            execute_bidirectional_with_progress_v2(
                &manager,
                storage.as_ref(),
                &all_enriched,
                &pending,
                &local_manifest,
                merge_strategy,
                &active_dir,
                &opt_emitter,
            )
            .await
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok((exec_result, skipped)) => {
            // 发送完成状态
            emitter.emit_completed().await;

            info!(
                "[data_governance] 带进度同步完成: direction={}, uploaded={}, downloaded={}, conflicts={}, skipped={}, duration={}ms",
                exec_result.direction.as_str(),
                exec_result.changes_uploaded,
                exec_result.changes_downloaded,
                exec_result.conflicts_detected,
                skipped,
                exec_result.duration_ms
            );

            #[cfg(feature = "data_governance")]
            {
                let audit_direction = match exec_result.direction {
                    SyncDirection::Upload => super::audit::SyncDirection::Upload,
                    SyncDirection::Download => super::audit::SyncDirection::Download,
                    SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
                };
                let records_affected =
                    exec_result.changes_uploaded + exec_result.changes_downloaded;
                let base_log = AuditLog::new(
                    AuditOperation::Sync {
                        direction: audit_direction,
                        records_affected,
                    },
                    format!("cloud_sync/{}", exec_result.direction.as_str()),
                )
                .with_details(serde_json::json!({
                    "device_id": device_id.clone(),
                    "direction": exec_result.direction.as_str(),
                    "strategy": strategy.clone().unwrap_or_else(|| "keep_latest".to_string()),
                    "changes_uploaded": exec_result.changes_uploaded,
                    "changes_downloaded": exec_result.changes_downloaded,
                    "conflicts_detected": exec_result.conflicts_detected,
                    "skipped_changes": skipped,
                    "with_progress": true,
                }));

                if exec_result.success {
                    try_save_audit_log(&app, base_log.complete(exec_result.duration_ms));
                } else {
                    try_save_audit_log(
                        &app,
                        base_log.fail(
                            exec_result
                                .error_message
                                .clone()
                                .unwrap_or_else(|| "sync failed".to_string()),
                        ),
                    );
                }
            }

            Ok(SyncExecutionResponse {
                success: exec_result.success,
                direction: exec_result.direction.as_str().to_string(),
                changes_uploaded: exec_result.changes_uploaded,
                changes_downloaded: exec_result.changes_downloaded,
                conflicts_detected: exec_result.conflicts_detected,
                duration_ms: exec_result.duration_ms,
                device_id,
                error_message: exec_result.error_message.clone(),
                skipped_changes: skipped,
            })
        }
        Err(e) => {
            emitter.emit_failed(&e).await;
            error!("[data_governance] 带进度同步失败: {}", e);
            #[cfg(feature = "data_governance")]
            {
                let audit_direction = match sync_direction {
                    SyncDirection::Upload => super::audit::SyncDirection::Upload,
                    SyncDirection::Download => super::audit::SyncDirection::Download,
                    SyncDirection::Bidirectional => super::audit::SyncDirection::Bidirectional,
                };
                try_save_audit_log(
                    &app,
                    AuditLog::new(
                        AuditOperation::Sync {
                            direction: audit_direction,
                            records_affected: 0,
                        },
                        format!("cloud_sync/{}", sync_direction.as_str()),
                    )
                    .fail(e.to_string())
                    .with_details(serde_json::json!({
                        "device_id": device_id.clone(),
                        "direction": sync_direction.as_str(),
                        "strategy": strategy.clone().unwrap_or_else(|| "keep_latest".to_string()),
                        "with_progress": true,
                    })),
                );
            }
            Ok(SyncExecutionResponse {
                success: false,
                direction: sync_direction.as_str().to_string(),
                changes_uploaded: 0,
                changes_downloaded: 0,
                conflicts_detected: 0,
                duration_ms,
                device_id,
                error_message: Some(e),
                skipped_changes: 0,
            })
        }
    }
}

// ============================================================================
// 同步进度辅助函数（多库 + 完整数据载荷）
// ============================================================================

/// 执行上传同步（v2：带进度、多库、完整数据载荷）
async fn execute_upload_with_progress_v2(
    manager: &SyncManager,
    storage: &dyn CloudStorage,
    enriched: &[SyncChangeWithData],
    pending: &super::sync::PendingChanges,
    local_manifest: &SyncManifest,
    active_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let start = std::time::Instant::now();
    let total = enriched.len() as u64;

    if enriched.is_empty() {
        return Ok((
            SyncExecutionResult {
                success: true,
                direction: SyncDirection::Upload,
                changes_uploaded: 0,
                changes_downloaded: 0,
                conflicts_detected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                error_message: None,
            },
            0,
        ));
    }

    emitter.emit_uploading(0, total, None).await;

    // 上传带完整数据的变更
    manager
        .upload_enriched_changes(storage, enriched)
        .await
        .map_err(|e| format!("上传同步失败: {}", e))?;

    manager
        .upload_manifest(storage, local_manifest)
        .await
        .map_err(|e| format!("上传清单失败: {}", e))?;

    emitter.emit_uploading(total, total, None).await;

    // 按数据库标记变更为已同步
    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, active_dir);
        if !db_path.exists() {
            continue;
        }

        let db_change_ids: Vec<i64> = enriched
            .iter()
            .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
            .filter_map(|c| c.change_log_id)
            .collect();

        if !db_change_ids.is_empty() {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("打开数据库失败: {}", e))?;
            SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                .map_err(|e| format!("标记变更失败: {}", e))?;
        }
    }

    emitter.emit_applying(total, total, None).await;

    Ok((
        SyncExecutionResult {
            success: true,
            direction: SyncDirection::Upload,
            changes_uploaded: enriched.len(),
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            error_message: None,
        },
        0,
    ))
}

/// 执行下载同步（v2：带进度、多库路由）
async fn execute_download_with_progress_v2(
    manager: &SyncManager,
    storage: &dyn CloudStorage,
    local_manifest: &SyncManifest,
    merge_strategy: MergeStrategy,
    active_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let start = std::time::Instant::now();

    emitter.emit_downloading(0, 0, None).await;

    let (exec_result, downloaded_changes) = manager
        .execute_download(storage, local_manifest, merge_strategy)
        .await
        .map_err(|e| format!("下载同步失败: {}", e))?;

    let total = downloaded_changes.len() as u64;
    emitter.emit_downloading(total, total, None).await;

    // 下载的变更已含完整数据，按数据库路由并应用
    let mut exec_result = exec_result;
    let mut total_skipped = 0usize;
    if !downloaded_changes.is_empty() {
        let total_changes = downloaded_changes.len() as u64;
        emitter
            .emit_applying(0, total_changes, Some("应用变更".to_string()))
            .await;

        let apply_agg = apply_downloaded_changes_to_databases(&downloaded_changes, active_dir)?;
        total_skipped = apply_agg.total_skipped;
        if total_skipped > 0 {
            exec_result.error_message = Some(format!(
                "同步已完成，但有 {} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。",
                total_skipped
            ));
        }

        emitter
            .emit_applying(total_changes, total_changes, None)
            .await;
    }

    Ok((exec_result, total_skipped))
}

/// 执行双向同步（v2：带进度、多库、完整数据载荷）
async fn execute_bidirectional_with_progress_v2(
    manager: &SyncManager,
    storage: &dyn CloudStorage,
    enriched: &[SyncChangeWithData],
    pending: &super::sync::PendingChanges,
    local_manifest: &SyncManifest,
    merge_strategy: MergeStrategy,
    active_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let start = std::time::Instant::now();

    emitter.emit_downloading(0, 0, None).await;

    let (exec_result, change_ids, downloaded_changes) = manager
        .execute_bidirectional(storage, pending, local_manifest, merge_strategy)
        .await
        .map_err(|e| format!("双向同步失败: {}", e))?;

    // 上传带完整数据的变更（唯一上传点，execute_bidirectional 不再内部上传）
    if !enriched.is_empty() {
        let upload_total = enriched.len() as u64;
        emitter.emit_uploading(0, upload_total, None).await;

        manager
            .upload_enriched_changes(storage, enriched)
            .await
            .map_err(|e| format!("上传变更失败: {}", e))?;

        emitter
            .emit_uploading(upload_total, upload_total, None)
            .await;
    }
    manager
        .upload_manifest(storage, local_manifest)
        .await
        .map_err(|e| format!("上传清单失败: {}", e))?;

    // 应用下载的变更（已含完整数据，按库路由）
    let mut exec_result = exec_result;
    let mut total_skipped = 0usize;
    if !downloaded_changes.is_empty() {
        let total_changes = downloaded_changes.len() as u64;
        emitter
            .emit_applying(0, total_changes, Some("应用下载变更".to_string()))
            .await;

        let apply_agg = apply_downloaded_changes_to_databases(&downloaded_changes, active_dir)?;
        total_skipped = apply_agg.total_skipped;
        if total_skipped > 0 {
            exec_result.error_message = Some(format!(
                "同步已完成，但有 {} 条变更因数据不完整被跳过。建议在源设备重新执行完整同步以补全数据。",
                total_skipped
            ));
        }

        emitter
            .emit_applying(total_changes, total_changes, None)
            .await;
    }

    // 下载成功应用后再标记本地变更已同步，避免中断导致“标记成功但下载未落地”。
    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, active_dir);
        if !db_path.exists() {
            continue;
        }

        let db_change_ids: Vec<i64> = enriched
            .iter()
            .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
            .filter_map(|c| c.change_log_id)
            .collect();

        if !db_change_ids.is_empty() {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("打开数据库失败: {}", e))?;
            SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                .map_err(|e| format!("标记变更失败: {}", e))?;
        }
    }

    if !change_ids.is_empty() {
        tracing::debug!(
            "[data_governance] 双向同步标记变更完成: {} 条",
            change_ids.len()
        );
    }

    Ok((exec_result, total_skipped))
}

#[cfg(test)]
mod tests {
    use super::{refresh_schema_registry_from_dir, resolve_target_and_pending, validate_backup_id};
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
            super::infer_database_from_table("chat_v2_sessions"),
            Some("chat_v2")
        );
        assert_eq!(
            super::infer_database_from_table("chat_v2_messages"),
            Some("chat_v2")
        );
        assert_eq!(
            super::infer_database_from_table("chat_v2_blocks"),
            Some("chat_v2")
        );
    }

    #[test]
    fn test_infer_database_chat_v2_known_tables() {
        assert_eq!(
            super::infer_database_from_table("workspace_index"),
            Some("chat_v2")
        );
        assert_eq!(
            super::infer_database_from_table("sleep_block"),
            Some("chat_v2")
        );
        assert_eq!(
            super::infer_database_from_table("subagent_task"),
            Some("chat_v2")
        );
    }

    #[test]
    fn test_infer_database_resources_ambiguous_returns_none() {
        // resources 表同时存在于 chat_v2 和 vfs，legacy 变更无法判定，应跳过
        assert_eq!(super::infer_database_from_table("resources"), None);
    }

    #[test]
    fn test_infer_database_mistakes() {
        assert_eq!(
            super::infer_database_from_table("mistakes"),
            Some("mistakes")
        );
        assert_eq!(
            super::infer_database_from_table("anki_cards"),
            Some("mistakes")
        );
        assert_eq!(
            super::infer_database_from_table("document_tasks"),
            Some("mistakes")
        );
        assert_eq!(
            super::infer_database_from_table("settings"),
            Some("mistakes")
        );
        assert_eq!(
            super::infer_database_from_table("review_analyses"),
            Some("mistakes")
        );
        assert_eq!(
            super::infer_database_from_table("exam_sheet_sessions"),
            Some("mistakes")
        );
    }

    #[test]
    fn test_infer_database_vfs() {
        assert_eq!(super::infer_database_from_table("notes"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("files"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("folders"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("blobs"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("questions"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("mindmaps"), Some("vfs"));
        assert_eq!(super::infer_database_from_table("essays"), Some("vfs"));
    }

    #[test]
    fn test_infer_database_llm_usage() {
        assert_eq!(
            super::infer_database_from_table("llm_usage_logs"),
            Some("llm_usage")
        );
        assert_eq!(
            super::infer_database_from_table("llm_usage_daily"),
            Some("llm_usage")
        );
    }

    #[test]
    fn test_infer_database_unknown_returns_none() {
        assert_eq!(super::infer_database_from_table("unknown_table_xyz"), None);
        assert_eq!(super::infer_database_from_table("__change_log"), None);
    }

    #[test]
    fn test_infer_database_no_cross_routing() {
        // 确保 mistakes 表不会被路由到 chat_v2
        assert_ne!(
            super::infer_database_from_table("anki_cards"),
            Some("chat_v2")
        );
        // 确保 vfs 表不会被路由到 mistakes
        assert_ne!(super::infer_database_from_table("notes"), Some("mistakes"));
    }
}
