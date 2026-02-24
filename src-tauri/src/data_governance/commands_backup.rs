// ==================== 备份相关命令 ====================

use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{Manager, State};
use tracing::{debug, error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use super::backup::{
    export_backup_to_zip, AssetBackupConfig, AssetType, AssetTypeStats,
    BackupManager, BackupSelection, TieredAssetConfig, ZipExportOptions,
};
use super::schema_registry::DatabaseId;
use super::sync::{SyncChangeWithData, SyncManager};
use crate::backup_common::BACKUP_GLOBAL_LIMITER;
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobParams,
    BackupJobPhase, BackupJobResultPayload, BackupJobStatus, BackupJobSummary, PersistedJob,
};
use crate::utils::text::safe_truncate_chars;

#[cfg(feature = "data_governance")]
use super::commands::try_save_audit_log;
use super::commands_restore::{
    execute_backup_with_progress_resumable, execute_zip_import_with_progress_resumable,
};

/// 获取应用数据基础目录（Tauri app_data_dir）
///
/// 注意：此目录是基础目录，**不是**运行时数据库/资产的实际存储位置。
/// 运行时存储位置请使用 `get_active_data_dir`。
pub(super) fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
pub(super) fn get_active_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = get_app_data_dir(app)?;
    Ok(crate::data_space::get_data_space_manager()
        .map(|mgr| mgr.active_dir())
        .unwrap_or_else(|| base_dir.join("slots").join("slotA")))
}

/// 获取备份目录
pub(super) fn get_backup_dir(app_data_dir: &PathBuf) -> PathBuf {
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
pub(super) fn resolve_database_path(db_id: &DatabaseId, active_dir: &Path) -> PathBuf {
    match db_id {
        DatabaseId::Vfs => active_dir.join("databases").join("vfs.db"),
        DatabaseId::ChatV2 => active_dir.join("chat_v2.db"),
        DatabaseId::Mistakes => active_dir.join("mistakes.db"),
        DatabaseId::LlmUsage => active_dir.join("llm_usage.db"),
    }
}

/// 多库应用结果
pub(super) struct ApplyToDbsResult {
    pub(super) total_success: usize,
    pub(super) total_skipped: usize,
    pub(super) total_failed: usize,
}

/// 根据表名推断变更所属的数据库（用于 legacy 无 database_name 的变更）
///
/// 使用已知的表名→库映射，避免将非 chat_v2 的变更错误路由到 chat_v2。
/// 返回 None 表示表名未知，调用方应跳过该变更。
pub(super) fn infer_database_from_table(table_name: &str) -> Option<&'static str> {
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
pub(super) fn apply_downloaded_changes_to_databases(
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
pub(super) fn sanitize_path_for_user(path: &Path) -> String {
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
pub(super) fn validate_user_path(_path: &Path, _app_data_dir: &Path) -> Result<(), String> {
    Ok(())
}

pub(super) fn validate_backup_id(raw_backup_id: &str) -> Result<String, String> {
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

pub(super) fn ensure_existing_path_within_backup_dir(
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
pub(super) async fn acquire_backup_global_permit(
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

