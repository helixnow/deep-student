// ==================== 同步相关命令 ====================

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{Manager, Window};
use tracing::{debug, error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use super::schema_registry::DatabaseId;
use super::sync::{
    ChangeLogEntry, DatabaseSyncState, MergeStrategy, PendingChanges, SyncChangeWithData,
    SyncDirection, SyncExecutionResult, SyncManager, SyncManifest,
};
use crate::backup_common::BACKUP_GLOBAL_LIMITER;
use crate::cloud_storage::{create_storage, CloudStorage, CloudStorageConfig};

use super::commands::{check_maintenance_mode, try_save_audit_log, SYNC_LOCK_TIMEOUT_SECS};
use super::commands_backup::{
    apply_downloaded_changes_to_databases, build_id_column_map, get_active_data_dir,
    get_app_data_dir, resolve_database_path, validate_backup_id, validate_user_path,
    ApplyToDbsResult,
};

/// 便捷函数：获取各表主键列名映射（questions → exam_id 等）
fn id_column_map() -> HashMap<String, String> {
    build_id_column_map()
}

fn rollback_marked_sync_versions(
    active_dir: &std::path::Path,
    marked_by_db: &HashMap<String, Vec<i64>>,
) {
    for (db_name, change_ids) in marked_by_db {
        if change_ids.is_empty() {
            continue;
        }
        let db_id = DatabaseId::all_ordered()
            .into_iter()
            .find(|id| id.as_str() == db_name.as_str());
        let Some(db_id) = db_id else { continue };
        let db_path = resolve_database_path(&db_id, active_dir);
        let Ok(conn) = rusqlite::Connection::open(&db_path) else {
            tracing::warn!(
                "[data_governance] 回滚 sync_version 失败：无法打开数据库 {}",
                db_name
            );
            continue;
        };
        let placeholders = std::iter::repeat("?")
            .take(change_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE __change_log SET sync_version = 0 WHERE id IN ({})",
            placeholders
        );
        if let Err(e) = conn.execute(&sql, rusqlite::params_from_iter(change_ids.iter())) {
            tracing::warn!(
                "[data_governance] 回滚 sync_version 失败（{}，{} 条）: {}",
                db_name,
                change_ids.len(),
                e
            );
        }
    }
}

fn append_warning_message(base: &mut Option<String>, msg: String) {
    let existing = base.take().unwrap_or_default();
    *base = Some(if existing.is_empty() {
        msg
    } else {
        format!("{}；{}", existing, msg)
    });
}

/// 同步结束后归档各数据库的 `__change_log`
///
/// 删除 `sync_version > 0` 且早于 `keep_days` 天前的所有记录。**不会**删除
/// 未同步（sync_version = 0）或刚刚同步的条目——保留它们是为了方便回溯
/// "谁在什么时间把 X 改成了 Y" 这种近期诊断。
///
/// 调用时机：每次同步（上传/下载/双向）成功收尾之后。
/// 失败是非致命的，只会 warn 到日志；因为该表无限增长只是性能问题，不影响正确性。
fn archive_synced_change_logs(active_dir: &std::path::Path, keep_days: i64) {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(keep_days)).to_rfc3339();
    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, active_dir);
        if !db_path.exists() {
            continue;
        }
        match rusqlite::Connection::open(&db_path) {
            Ok(conn) => match SyncManager::cleanup_synced_changes(&conn, &cutoff) {
                Ok(n) if n > 0 => {
                    tracing::info!(
                        "[data_governance] 已归档 {} 条 {} 日前的已同步变更日志（{}）",
                        n,
                        keep_days,
                        db_id.as_str()
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        "[data_governance] 归档 __change_log 失败（{}，非致命）: {}",
                        db_id.as_str(),
                        e
                    );
                }
            },
            Err(e) => {
                tracing::warn!(
                    "[data_governance] 归档时无法打开数据库 {}: {}（跳过）",
                    db_id.as_str(),
                    e
                );
            }
        }
    }
}

/// 消费 VFS 的 `__blob_deletion_queue`，把待删除传播到云端
///
/// 在每次同步进入文件级阶段之前调用。对每条 pending：
/// 1. 调 `mark_blob_deleted` 写云端 tombstone 清单
/// 2. 成功后从本地队列删除
/// 3. 失败（如网络问题）则 `retry_count += 1`，达到阈值后放弃（保留记录供排查）
///
/// 返回成功推送的条数。
async fn drain_blob_deletion_queue(
    active_dir: &std::path::Path,
    manager: &SyncManager,
    storage: &dyn crate::cloud_storage::CloudStorage,
) -> usize {
    const MAX_RETRIES: i64 = 5;

    let vfs_path = active_dir.join("databases").join("vfs.db");
    if !vfs_path.exists() {
        return 0;
    }

    let conn = match rusqlite::Connection::open(&vfs_path) {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "[data_governance] 打开 vfs.db 失败（跳过 blob 删除队列）: {}",
                e
            );
            return 0;
        }
    };

    // 检查表存在（老数据库可能还没迁移）
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__blob_deletion_queue')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return 0;
    }

    let rows: Vec<(String, Option<String>, Option<i64>, i64)> = {
        let mut stmt = match conn.prepare(
            "SELECT hash, relative_path, size, retry_count
             FROM __blob_deletion_queue
             WHERE retry_count < ?1
             ORDER BY deleted_at ASC
             LIMIT 500",
        ) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let mapped = match stmt.query_map(rusqlite::params![MAX_RETRIES], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        }) {
            Ok(iter) => iter.filter_map(|x| x.ok()).collect::<Vec<_>>(),
            Err(_) => return 0,
        };
        mapped
    };

    if rows.is_empty() {
        return 0;
    }

    let mut success = 0usize;
    for (hash, rel, size, _retry) in rows {
        let size_u64 = size.and_then(|s| if s >= 0 { Some(s as u64) } else { None });
        match manager
            .mark_blob_deleted(storage, &hash, rel.clone(), size_u64)
            .await
        {
            Ok(_) => {
                let _ = conn.execute(
                    "DELETE FROM __blob_deletion_queue WHERE hash = ?1",
                    rusqlite::params![&hash],
                );
                success += 1;
            }
            Err(e) => {
                warn!(
                    "[data_governance] 传播 blob 删除失败（将重试）: hash={}, err={}",
                    hash, e
                );
                let _ = conn.execute(
                    "UPDATE __blob_deletion_queue SET retry_count = retry_count + 1 WHERE hash = ?1",
                    rusqlite::params![&hash],
                );
            }
        }
    }

    if success > 0 {
        info!("[data_governance] blob 删除队列已传播 {} 条到云端", success);
    }
    success
}

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
/// 获取设备 ID（统一与 cloud_storage::get_device_id 的实现）
///
/// **历史遗留**：早期此模块和 `cloud_storage::sync_manager` 各维护一套 device_id，
/// 位于不同目录。现统一到 `cloud_storage::get_device_id`（遵循 DEVICE_ID env → data_local_dir →
/// config_dir → home_dir 优先级），并兼容读取旧文件 `app_data_dir/device_id` 做一次性迁移。
fn get_device_id(app: &tauri::AppHandle) -> String {
    use std::sync::OnceLock;
    static DEVICE_ID: OnceLock<String> = OnceLock::new();

    DEVICE_ID
        .get_or_init(|| {
            // 1) 优先兼容读取旧位置 `app_data_dir/device_id`（一次性迁移）
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let legacy_path = app_data_dir.join("device_id");
                if legacy_path.exists() {
                    if let Ok(id) = std::fs::read_to_string(&legacy_path) {
                        let id = id.trim().to_string();
                        if !id.is_empty() {
                            // 使用旧值，并设到环境变量作为统一来源（本进程内）
                            std::env::set_var("DEVICE_ID", &id);
                            tracing::info!(
                                "[data_governance] 迁移旧 device_id (app_data_dir) → 统一: {}",
                                id
                            );
                            return id;
                        }
                    }
                }
            }

            // 2) 委托给 cloud_storage 的权威实现
            let id = crate::cloud_storage::get_device_id();
            tracing::info!("[data_governance] 使用统一 device_id: {}", id);
            id
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
        // [P0-2] 下载清单需要解密能力：用带密码的 manager 覆盖
        let crypto_manager =
            SyncManager::with_encryption(device_id.clone(), cfg.encryption_password.clone());
        let cloud = crypto_manager
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
    let app_data_dir = get_app_data_dir(&app)?;

    // 创建同步管理器
    // [P0-2] 透传加密密码，让所有上传/下载走 DSBK 容器
    let manager =
        SyncManager::with_encryption(device_id.clone(), config.encryption_password.clone());

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
            let mut enriched = SyncManager::enrich_changes_with_data(
                &conn,
                &pending.entries,
                Some(&id_column_map()),
            )
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
            manager
                .upload_enriched_changes(storage.as_ref(), &all_enriched, None)
                .await
                .map_err(|e| format!("上传同步失败: {}", e))?;

            // 先标记变更为已同步（若后续 manifest 上传失败会回滚）
            let mut marked_by_db: HashMap<String, Vec<i64>> = HashMap::new();
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
                    marked_by_db.insert(db_id.as_str().to_string(), db_change_ids);
                }
            }

            // 标记完成后重建 manifest 再上传（确保 data_version 反映最新状态）
            let upload_manifest = {
                let mut dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
                for db_id in DatabaseId::all_ordered() {
                    let db_path = resolve_database_path(&db_id, &active_dir);
                    if db_path.exists() {
                        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                            if let Ok(state) =
                                SyncManager::get_database_sync_state(&conn, db_id.as_str())
                            {
                                dbs.insert(db_id.as_str().to_string(), state);
                            }
                        }
                    }
                }
                manager.create_manifest(dbs)
            };
            if let Err(e) = manager
                .upload_manifest(storage.as_ref(), &upload_manifest)
                .await
            {
                rollback_marked_sync_versions(&active_dir, &marked_by_db);
                return Err(format!("上传清单失败: {}", e));
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
                let apply_agg = apply_downloaded_changes_to_databases(
                    &downloaded_changes,
                    &active_dir,
                    merge_strategy,
                )?;
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

            // [P0 Fix] 先应用下载的变更，再上传本地变更。
            // 这确保上传时不会推送已被下载覆盖的过时数据。
            let mut exec_result = exec_result;
            let mut total_skipped = 0usize;
            let mut applied_keys = std::collections::HashSet::new();
            if !downloaded_changes.is_empty() {
                let apply_agg = apply_downloaded_changes_to_databases(
                    &downloaded_changes,
                    &active_dir,
                    merge_strategy,
                )?;
                total_skipped = apply_agg.total_skipped;
                applied_keys = apply_agg.applied_keys;
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

            // [P0 Fix] 从待上传列表中剔除已被下载覆盖的记录
            let filtered_enriched: Vec<&SyncChangeWithData> = if applied_keys.is_empty() {
                all_enriched.iter().collect()
            } else {
                let before = all_enriched.len();
                let filtered: Vec<_> = all_enriched
                    .iter()
                    .filter(|e| {
                        !applied_keys.contains(&(e.table_name.clone(), e.record_id.clone()))
                    })
                    .collect();
                let removed = before - filtered.len();
                if removed > 0 {
                    tracing::info!(
                        "[data_governance] 双向同步: 已从上传列表中剔除 {} 条被下载覆盖的记录",
                        removed
                    );
                }
                filtered
            };

            // [批判性修复] 修正 changes_uploaded 为实际上传数量，确保审计日志和前端显示准确
            exec_result.changes_uploaded = filtered_enriched.len();

            // 上传过滤后的变更（唯一上传点，避免重复）
            if !filtered_enriched.is_empty() {
                let refs_vec: Vec<SyncChangeWithData> =
                    filtered_enriched.iter().map(|e| (*e).clone()).collect();
                manager
                    .upload_enriched_changes(storage.as_ref(), &refs_vec, None)
                    .await
                    .map_err(|e| format!("上传变更失败: {}", e))?;
            }

            // 下载成功应用后再标记本地变更已同步；若 manifest 上传失败会回滚这些标记。
            let mut marked_by_db: HashMap<String, Vec<i64>> = HashMap::new();
            for db_id in DatabaseId::all_ordered() {
                let db_path = resolve_database_path(&db_id, &active_dir);
                if !db_path.exists() {
                    continue;
                }
                let conn = rusqlite::Connection::open(&db_path)
                    .map_err(|e| format!("打开数据库失败: {}", e))?;
                let db_change_ids: Vec<i64> = filtered_enriched
                    .iter()
                    .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
                    .filter_map(|c| c.change_log_id)
                    .collect();
                if !db_change_ids.is_empty() {
                    SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                        .map_err(|e| format!("标记变更失败: {}", e))?;
                    marked_by_db.insert(db_id.as_str().to_string(), db_change_ids);
                }
            }

            if !change_ids.is_empty() {
                tracing::debug!(
                    "[data_governance] 双向同步标记变更完成: {} 条",
                    change_ids.len()
                );
            }

            // 标记完成后重建 manifest 再上传
            let refreshed_manifest = {
                let mut dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
                for db_id in DatabaseId::all_ordered() {
                    let db_path = resolve_database_path(&db_id, &active_dir);
                    if db_path.exists() {
                        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                            if let Ok(state) =
                                SyncManager::get_database_sync_state(&conn, db_id.as_str())
                            {
                                dbs.insert(db_id.as_str().to_string(), state);
                            }
                        }
                    }
                }
                manager.create_manifest(dbs)
            };
            if let Err(e) = manager
                .upload_manifest(storage.as_ref(), &refreshed_manifest)
                .await
            {
                rollback_marked_sync_versions(&active_dir, &marked_by_db);
                return Err(format!("上传刷新清单失败: {}", e));
            }

            Ok((exec_result, total_skipped))
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok((mut exec_result, skipped)) => {
            // 与带进度链路保持一致：在普通同步中也执行文件级同步
            let blobs_dir = active_dir.join("vfs_blobs");
            let should_enforce_file_sync = matches!(
                exec_result.direction,
                SyncDirection::Upload | SyncDirection::Bidirectional
            );
            let mut file_sync_failed = false;
            if let Err(e) = manager
                .sync_workspace_databases(storage.as_ref(), &active_dir)
                .await
            {
                warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
            }
            // 先消费本地 blob 删除队列（把 VFS 物理删除的 blob 上报成 tombstone）
            drain_blob_deletion_queue(&active_dir, &manager, storage.as_ref()).await;
            match manager
                .sync_vfs_blobs_with_tombstones(storage.as_ref(), &blobs_dir)
                .await
            {
                Ok(outcome) => {
                    if outcome.has_failures() {
                        if let Some(msg) = outcome.failure_summary() {
                            warn!("[data_governance] VFS blob 部分失败: {}", msg);
                            append_warning_message(&mut exec_result.error_message, msg);
                        }
                        file_sync_failed = true;
                    }
                }
                Err(e) => {
                    error!("[data_governance] VFS blob 同步出错: {}", e);
                    append_warning_message(
                        &mut exec_result.error_message,
                        format!("附件同步失败: {}", e),
                    );
                    file_sync_failed = true;
                }
            }
            match manager
                .sync_asset_directories_with_tombstones(
                    storage.as_ref(),
                    &active_dir,
                    &app_data_dir,
                )
                .await
            {
                Ok(outcome) => {
                    if outcome.has_failures() {
                        if let Some(msg) = outcome.failure_summary() {
                            warn!("[data_governance] 资产目录部分失败: {}", msg);
                            append_warning_message(&mut exec_result.error_message, msg);
                        }
                        file_sync_failed = true;
                    }
                }
                Err(e) => {
                    error!("[data_governance] 资产目录同步出错: {}", e);
                    append_warning_message(
                        &mut exec_result.error_message,
                        format!("资产目录同步失败: {}", e),
                    );
                    file_sync_failed = true;
                }
            }
            if should_enforce_file_sync && file_sync_failed {
                exec_result.success = false;
            }
            if should_enforce_file_sync {
                if let Err(e) = manager.prune_old_changes(storage.as_ref(), 30).await {
                    warn!("[data_governance] 云端变更文件清理失败（非致命）: {}", e);
                }
                // 同步完成后，归档本地各数据库 __change_log 里的历史记录
                // （仅 sync_version > 0 且超过 30 天的记录），防止表无限增长
                archive_synced_change_logs(&active_dir, 30);
            }

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

fn cleanup_temp_sync_file(path: Option<&PathBuf>, context: &str) {
    if let Some(temp_path) = path {
        if let Err(err) = std::fs::remove_file(&temp_path) {
            warn!(
                "[data_governance] {}: 清理临时文件失败 ({}): {}",
                context,
                temp_path.display(),
                err
            );
        }
    }
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
    window: Window,
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
                        match SyncManager::enrich_changes_with_data(
                            &conn,
                            &pending.entries,
                            Some(&id_column_map()),
                        ) {
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

    // 确定输出路径（虚拟 URI 先导出到本地临时文件，再复制到目标 URI）
    let mut target_virtual_uri: Option<String> = None;
    let output = match output_path {
        Some(p) if crate::unified_file_manager::is_virtual_uri(&p) => {
            let temp_dir = app_data_dir.join("temp_sync_export");
            std::fs::create_dir_all(&temp_dir)
                .map_err(|e| format!("创建同步临时导出目录失败: {}", e))?;
            target_virtual_uri = Some(p);
            temp_dir.join(format!("sync_export_{}.json", uuid::Uuid::new_v4()))
        }
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

    // 写入文件（本地）
    std::fs::write(&output, &json).map_err(|e| format!("写入文件失败: {}", e))?;

    let mut final_output_path = output.to_string_lossy().to_string();
    if let Some(target_uri) = target_virtual_uri {
        let staged = output.to_string_lossy().to_string();
        if let Err(err) = crate::unified_file_manager::copy_file(&window, &staged, &target_uri) {
            cleanup_temp_sync_file(Some(&output), "sync_export");
            return Err(format!("写入目标 URI 失败: {}", err));
        }
        cleanup_temp_sync_file(Some(&output), "sync_export");
        final_output_path = target_uri;
    }

    info!(
        "[data_governance] 同步数据已导出: path={}, changes={}",
        final_output_path,
        all_enriched_changes.len()
    );

    Ok(SyncExportResponse {
        success: true,
        output_path: final_output_path,
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
    window: Window,
    input_path: String,
    strategy: Option<String>,
) -> Result<SyncImportResponse, String> {
    info!("[data_governance] 导入同步数据: path={}", input_path);

    let app_data_dir = get_app_data_dir(&app)?;
    let active_dir = get_active_data_dir(&app)?;

    let (input_file_path, cleanup_path) =
        if crate::unified_file_manager::is_virtual_uri(&input_path) {
            let temp_dir = app_data_dir.join("temp_sync_import");
            let materialized =
                crate::unified_file_manager::ensure_local_path(&window, &input_path, &temp_dir)
                    .map_err(|e| format!("无法读取导入文件: {}", e))?;
            let (path, cleanup) = materialized.into_owned();
            (path.clone(), cleanup.or(Some(path)))
        } else {
            let input_file = std::path::PathBuf::from(&input_path);
            validate_user_path(&input_file, &app_data_dir)?;
            (input_file, None)
        };

    // 读取文件
    let json =
        std::fs::read_to_string(&input_file_path).map_err(|e| format!("读取文件失败: {}", e));
    let json = match json {
        Ok(v) => v,
        Err(e) => {
            cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
            return Err(e);
        }
    };

    // 解析（v2 格式含完整数据）
    let import_data: SyncExportData = match serde_json::from_str(&json) {
        Ok(data) => data,
        Err(err) => {
            cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
            return Err(format!("解析导入数据失败: {}", err));
        }
    };

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
    let detection = match SyncManager::detect_conflicts(&local_manifest, &import_data.manifest) {
        Ok(d) => d,
        Err(err) => {
            cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
            return Err(format!("冲突检测失败: {}", err));
        }
    };

    // 解析合并策略
    let merge_strategy = match strategy.as_deref().unwrap_or("keep_latest") {
        "keep_local" => MergeStrategy::KeepLocal,
        "use_cloud" => MergeStrategy::UseCloud,
        "keep_latest" => MergeStrategy::KeepLatest,
        "manual" => MergeStrategy::Manual,
        s => {
            cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
            return Err(format!(
                "无效的合并策略: {}。可选值: keep_local, use_cloud, keep_latest, manual",
                s
            ));
        }
    };

    // 如果有冲突且是手动模式
    if detection.has_conflicts && merge_strategy == MergeStrategy::Manual {
        let response = SyncImportResponse {
            success: false,
            imported_changes: 0,
            conflicts_detected: detection.total_conflicts(),
            needs_manual_resolution: true,
            error_message: Some(
                "存在冲突，需要手动解决。请前往「同步」面板选择合适的解决策略".to_string(),
            ),
        };
        cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
        return Ok(response);
    }

    // 应用变更到本地数据库（v2 格式已含完整数据，按数据库路由）
    let mut total_applied = 0usize;
    let mut total_skipped = 0usize;
    let mut total_failed = 0usize;

    if !import_data.pending_changes.is_empty() {
        // 导入的变更已含完整记录数据，直接按数据库路由并应用
        match apply_downloaded_changes_to_databases(
            &import_data.pending_changes,
            &active_dir,
            merge_strategy,
        ) {
            Ok(apply_agg) => {
                total_applied = apply_agg.total_success;
                total_skipped = apply_agg.total_skipped;
                total_failed = apply_agg.total_failed;
                info!(
                    "[data_governance] 导入变更应用完成: applied={}, failed={}, skipped={}",
                    total_applied, total_failed, total_skipped
                );
            }
            Err(e) => {
                error!("[data_governance] 应用导入变更失败: {}", e);
                cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
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

    let response = SyncImportResponse {
        success: total_failed == 0,
        imported_changes: total_applied,
        conflicts_detected: detection.total_conflicts(),
        needs_manual_resolution: false,
        error_message,
    };
    cleanup_temp_sync_file(cleanup_path.as_ref(), "sync_import");
    Ok(response)
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
    let app_data_dir = get_app_data_dir(&app).unwrap_or_else(|_| active_dir.clone());

    // 创建同步管理器（复用上方已获取的 device_id）
    // [P0-2] 透传加密密码
    let manager =
        SyncManager::with_encryption(device_id.clone(), config.encryption_password.clone());

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
    let all_db_ids: Vec<_> = DatabaseId::all_ordered();
    let total_dbs = all_db_ids.len() as u64;

    for (db_index, db_id) in all_db_ids.iter().enumerate() {
        let db_path = resolve_database_path(db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        db_found = true;

        // 每处理一个 DB 就推送一次 detecting_changes 进度，消除大批量富化时的静默窗口
        emitter
            .emit(SyncProgress {
                phase: SyncPhase::DetectingChanges,
                percent: 5.0,
                current: db_index as u64 + 1,
                total: total_dbs,
                current_item: Some(db_id.as_str().to_string()),
                speed_bytes_per_sec: None,
                eta_seconds: None,
                error: None,
            })
            .await;

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
                match SyncManager::enrich_changes_with_data(
                    &conn,
                    &pending.entries,
                    Some(&id_column_map()),
                ) {
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
                &app_data_dir,
                &opt_emitter.clone(),
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
                &app_data_dir,
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
                &app_data_dir,
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
    _pending: &super::sync::PendingChanges,
    local_manifest: &SyncManifest,
    active_dir: &std::path::Path,
    app_data_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let start = std::time::Instant::now();
    let total = enriched.len() as u64;

    if enriched.is_empty() {
        // 兜底：即使当前无 pending，也尝试刷新云端 manifest，修复“上次仅变更上传成功”的可见性缺口
        manager
            .upload_manifest(storage, local_manifest)
            .await
            .map_err(|e| format!("上传清单失败: {}", e))?;
    } else {
        emitter.emit_uploading(0, total, None).await;

        // 分批上传变更（每批 1000 条），避免一次性构造/压缩/传输数十万条记录
        // 带来的内存尖峰 + 重试代价过大。批次边界的进度按批次数换算成 10%~50% 占比。
        //
        // upload_enriched_changes 内部使用当前秒级时间戳构造 key，由于每批间隔极短，
        // 对同一秒内的多批次要加"批次序号"保证 key 唯一——这里通过 sleep 100ms 简化，
        // 若未来升级为流式上传可去除 sleep，改为在 key 里附加 batch index。
        const BATCH_SIZE: usize = 1000;
        let batches: Vec<&[SyncChangeWithData]> = enriched.chunks(BATCH_SIZE).collect();
        let batch_count = batches.len();

        for (batch_idx, batch) in batches.iter().enumerate() {
            let batch_progress_base =
                10.0_f32 + (batch_idx as f32 / batch_count.max(1) as f32) * 40.0;
            let batch_progress_span = 40.0_f32 / batch_count.max(1) as f32;

            let emitter_cb = emitter.clone();
            let last_emit_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let byte_progress_cb: Box<dyn Fn(u64, u64) + Send + Sync> =
                Box::new(move |done, total_bytes| {
                    let is_final = total_bytes > 0 && done >= total_bytes;
                    if !is_final {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let last = last_emit_ms.load(std::sync::atomic::Ordering::Relaxed);
                        if now_ms.saturating_sub(last) < 100 {
                            return;
                        }
                        last_emit_ms.store(now_ms, std::sync::atomic::Ordering::Relaxed);
                    }
                    let inner_pct = if total_bytes > 0 {
                        done as f32 / total_bytes as f32
                    } else {
                        0.0
                    };
                    let pct = batch_progress_base + inner_pct * batch_progress_span;
                    emitter_cb.emit_force_sync(SyncProgress {
                        phase: SyncPhase::Uploading,
                        percent: pct,
                        current: done,
                        total: total_bytes,
                        current_item: Some(format!("上传批次 {}/{}", batch_idx + 1, batch_count)),
                        speed_bytes_per_sec: None,
                        eta_seconds: None,
                        error: None,
                    });
                });

            manager
                .upload_enriched_changes(storage, batch, Some(byte_progress_cb))
                .await
                .map_err(|e| {
                    format!(
                        "上传同步失败（批次 {}/{}）: {}",
                        batch_idx + 1,
                        batch_count,
                        e
                    )
                })?;

            // 批次间让权给事件循环；key 冲突由 build_change_key 内的 UUID nonce 防护
            tokio::task::yield_now().await;
        }

        emitter.emit_uploading(total, total, None).await;

        // 先标记变更为已同步（若后续 manifest 上传失败会执行回滚）
        let mut marked_by_db: HashMap<String, Vec<i64>> = HashMap::new();
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
                marked_by_db.insert(db_id.as_str().to_string(), db_change_ids);
            }
        }

        // 标记完成后重建 manifest 再上传（确保 data_version 反映最新状态）
        {
            let mut refreshed_dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
            for db_id in DatabaseId::all_ordered() {
                let db_path = resolve_database_path(&db_id, active_dir);
                if db_path.exists() {
                    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                        if let Ok(state) =
                            SyncManager::get_database_sync_state(&conn, db_id.as_str())
                        {
                            refreshed_dbs.insert(db_id.as_str().to_string(), state);
                        }
                    }
                }
            }
            let refreshed_manifest = manager.create_manifest(refreshed_dbs);
            if let Err(e) = manager.upload_manifest(storage, &refreshed_manifest).await {
                rollback_marked_sync_versions(active_dir, &marked_by_db);
                return Err(format!("上传清单失败: {}", e));
            }
        }
    }

    emitter.emit_applying(total, total, None).await;

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = active_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    drain_blob_deletion_queue(active_dir, manager, storage).await;

    let mut blob_warning: Option<String> = None;
    match manager
        .sync_vfs_blobs_with_tombstones(storage, &blobs_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                blob_warning = outcome.failure_summary();
                tracing::warn!("[data_governance] VFS blob 部分失败: {:?}", blob_warning);
            }
        }
        Err(e) => {
            blob_warning = Some(format!("附件同步失败: {}", e));
            tracing::error!("[data_governance] VFS blob 同步出错: {}", e);
        }
    }
    let mut upload_warning = blob_warning;
    let mut file_sync_failed = upload_warning.is_some();

    match manager
        .sync_asset_directories_with_tombstones(storage, active_dir, app_data_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                if let Some(msg) = outcome.failure_summary() {
                    tracing::warn!("[data_governance] 资产目录部分失败: {}", msg);
                    append_warning_message(&mut upload_warning, msg);
                }
                file_sync_failed = true;
            }
        }
        Err(e) => {
            tracing::error!("[data_governance] 资产目录同步出错: {}", e);
            append_warning_message(&mut upload_warning, format!("资产目录同步失败: {}", e));
            file_sync_failed = true;
        }
    }

    // 清理云端超过 30 天的旧变更文件（非致命）
    if let Err(e) = manager.prune_old_changes(storage, 30).await {
        tracing::warn!("[data_governance] 云端变更文件清理失败（非致命）: {}", e);
    }
    // 归档本地 __change_log 里超过 30 天的已同步记录（非致命）
    archive_synced_change_logs(active_dir, 30);

    Ok((
        SyncExecutionResult {
            success: !file_sync_failed,
            direction: SyncDirection::Upload,
            changes_uploaded: enriched.len(),
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            error_message: upload_warning,
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
    app_data_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let _start = std::time::Instant::now();

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

        let apply_agg =
            apply_downloaded_changes_to_databases(&downloaded_changes, active_dir, merge_strategy)?;
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

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = active_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    drain_blob_deletion_queue(active_dir, manager, storage).await;

    match manager
        .sync_vfs_blobs_with_tombstones(storage, &blobs_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                let blob_msg = outcome.failure_summary().unwrap_or_default();
                tracing::warn!("[data_governance] VFS blob 部分失败: {}", blob_msg);
                append_warning_message(&mut exec_result.error_message, blob_msg);
            }
        }
        Err(e) => {
            tracing::error!("[data_governance] VFS blob 同步出错: {}", e);
            append_warning_message(
                &mut exec_result.error_message,
                format!("附件同步失败: {}", e),
            );
        }
    }

    match manager
        .sync_asset_directories_with_tombstones(storage, active_dir, app_data_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                if let Some(msg) = outcome.failure_summary() {
                    tracing::warn!("[data_governance] 资产目录部分失败: {}", msg);
                    append_warning_message(&mut exec_result.error_message, msg);
                }
            }
        }
        Err(e) => {
            tracing::error!("[data_governance] 资产目录同步出错: {}", e);
            append_warning_message(
                &mut exec_result.error_message,
                format!("资产目录同步失败: {}", e),
            );
        }
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
    app_data_dir: &std::path::Path,
    emitter: &OptionalEmitter,
) -> Result<(SyncExecutionResult, usize), String> {
    let _start = std::time::Instant::now();

    // 先执行下载同步（不先发射 downloading 事件，避免在无内容时发操导致百分比倒退）
    let (exec_result, change_ids, downloaded_changes) = manager
        .execute_bidirectional(storage, pending, local_manifest, merge_strategy)
        .await
        .map_err(|e| format!("双向同步失败: {}", e))?;

    // 有下载内容时才发射 downloading 事件
    if !downloaded_changes.is_empty() {
        let dl_total = downloaded_changes.len() as u64;
        emitter.emit_downloading(dl_total, dl_total, None).await;
    }

    // [P0 Fix] 先应用下载的变更，再上传本地变更。
    // 这确保上传时不会推送已被下载覆盖的过时数据。
    let mut exec_result = exec_result;
    let mut total_skipped = 0usize;
    let mut applied_keys = std::collections::HashSet::new();
    if !downloaded_changes.is_empty() {
        let total_changes = downloaded_changes.len() as u64;
        emitter
            .emit_applying(0, total_changes, Some("应用下载变更".to_string()))
            .await;

        let apply_agg =
            apply_downloaded_changes_to_databases(&downloaded_changes, active_dir, merge_strategy)?;
        total_skipped = apply_agg.total_skipped;
        applied_keys = apply_agg.applied_keys;
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

    // [P0 Fix] 从待上传列表中剔除已被下载覆盖的记录，避免上传过时的本地快照。
    // 仅当下载的变更实际被应用（策略判定为云端优先）时才剔除；
    // 策略判定为本地优先的记录仍会保留在上传列表中。
    let filtered_enriched: Vec<&SyncChangeWithData> = if applied_keys.is_empty() {
        enriched.iter().collect()
    } else {
        let before = enriched.len();
        let filtered: Vec<_> = enriched
            .iter()
            .filter(|e| !applied_keys.contains(&(e.table_name.clone(), e.record_id.clone())))
            .collect();
        let removed = before - filtered.len();
        if removed > 0 {
            tracing::info!(
                "[data_governance] 双向同步: 已从上传列表中剔除 {} 条被下载覆盖的记录",
                removed
            );
        }
        filtered
    };

    // [批判性修复] 修正 changes_uploaded 为实际上传数量，确保审计日志和前端显示准确
    exec_result.changes_uploaded = filtered_enriched.len();

    // 上传过滤后的变更（唯一上传点，execute_bidirectional 不再内部上传）
    if !filtered_enriched.is_empty() {
        let upload_total = filtered_enriched.len() as u64;
        emitter.emit_uploading(0, upload_total, None).await;

        // 字节级进度回调——通过流式 PUT 实时上报已传输字节数（节流 100ms）
        let emitter_cb = emitter.clone();
        let last_emit_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let byte_progress_cb: Box<dyn Fn(u64, u64) + Send + Sync> =
            Box::new(move |done, total_bytes| {
                let is_final = total_bytes > 0 && done >= total_bytes;
                if !is_final {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let last = last_emit_ms.load(std::sync::atomic::Ordering::Relaxed);
                    if now_ms.saturating_sub(last) < 100 {
                        return;
                    }
                    last_emit_ms.store(now_ms, std::sync::atomic::Ordering::Relaxed);
                }
                let pct = if total_bytes > 0 {
                    10.0_f32 + (done as f32 / total_bytes as f32) * 40.0
                } else {
                    10.0
                };
                emitter_cb.emit_force_sync(SyncProgress {
                    phase: SyncPhase::Uploading,
                    percent: pct,
                    current: done,
                    total: total_bytes,
                    current_item: None,
                    speed_bytes_per_sec: None,
                    eta_seconds: None,
                    error: None,
                });
            });

        // 收集引用为 owned slice 以满足 upload_enriched_changes 签名
        let refs_vec: Vec<SyncChangeWithData> =
            filtered_enriched.iter().map(|e| (*e).clone()).collect();
        manager
            .upload_enriched_changes(storage, &refs_vec, Some(byte_progress_cb))
            .await
            .map_err(|e| format!("上传变更失败: {}", e))?;

        emitter
            .emit_uploading(upload_total, upload_total, None)
            .await;
    }

    // 下载成功应用后再标记本地变更已同步；若 manifest 上传失败会回滚这些标记。
    // 注意：仅标记实际上传的变更（filtered_enriched），被剔除的记录不标记，
    // 以确保下次同步时它们能被重新评估。
    let mut marked_by_db: HashMap<String, Vec<i64>> = HashMap::new();
    for db_id in DatabaseId::all_ordered() {
        let db_path = resolve_database_path(&db_id, active_dir);
        if !db_path.exists() {
            continue;
        }

        let db_change_ids: Vec<i64> = filtered_enriched
            .iter()
            .filter(|c| c.database_name.as_deref() == Some(db_id.as_str()))
            .filter_map(|c| c.change_log_id)
            .collect();

        if !db_change_ids.is_empty() {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("打开数据库失败: {}", e))?;
            SyncManager::mark_synced_with_timestamp(&conn, &db_change_ids)
                .map_err(|e| format!("标记变更失败: {}", e))?;
            marked_by_db.insert(db_id.as_str().to_string(), db_change_ids);
        }
    }

    if !change_ids.is_empty() {
        tracing::debug!(
            "[data_governance] 双向同步标记变更完成: {} 条",
            change_ids.len()
        );
    }

    // 重建 manifest 反映下载应用 + 标记后的最新状态，再上传
    {
        let mut refreshed_databases: HashMap<String, DatabaseSyncState> = HashMap::new();
        for db_id in DatabaseId::all_ordered() {
            let db_path = resolve_database_path(&db_id, active_dir);
            if db_path.exists() {
                if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                        refreshed_databases.insert(db_id.as_str().to_string(), state);
                    }
                }
            }
        }
        let refreshed_manifest = manager.create_manifest(refreshed_databases);
        if let Err(e) = manager.upload_manifest(storage, &refreshed_manifest).await {
            rollback_marked_sync_versions(active_dir, &marked_by_db);
            return Err(format!("上传刷新清单失败: {}", e));
        }
    }

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = active_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    drain_blob_deletion_queue(active_dir, manager, storage).await;

    let mut file_sync_failed = false;
    match manager
        .sync_vfs_blobs_with_tombstones(storage, &blobs_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                let blob_msg = outcome.failure_summary().unwrap_or_default();
                tracing::warn!("[data_governance] VFS blob 部分失败: {}", blob_msg);
                append_warning_message(&mut exec_result.error_message, blob_msg);
                file_sync_failed = true;
            }
        }
        Err(e) => {
            tracing::error!("[data_governance] VFS blob 同步出错: {}", e);
            append_warning_message(
                &mut exec_result.error_message,
                format!("附件同步失败: {}", e),
            );
            file_sync_failed = true;
        }
    }

    match manager
        .sync_asset_directories_with_tombstones(storage, active_dir, app_data_dir)
        .await
    {
        Ok(outcome) => {
            if outcome.has_failures() {
                if let Some(msg) = outcome.failure_summary() {
                    tracing::warn!("[data_governance] 资产目录部分失败: {}", msg);
                    append_warning_message(&mut exec_result.error_message, msg);
                }
                file_sync_failed = true;
            }
        }
        Err(e) => {
            tracing::error!("[data_governance] 资产目录同步出错: {}", e);
            append_warning_message(
                &mut exec_result.error_message,
                format!("资产目录同步失败: {}", e),
            );
            file_sync_failed = true;
        }
    }

    if file_sync_failed {
        exec_result.success = false;
    }

    // 清理云端超过 30 天的旧变更文件
    if let Err(e) = manager.prune_old_changes(storage, 30).await {
        tracing::warn!("[data_governance] 云端变更文件清理失败（非致命）: {}", e);
    }
    // 归档本地 __change_log 里超过 30 天的已同步记录（非致命）
    archive_synced_change_logs(active_dir, 30);

    Ok((exec_result, total_skipped))
}

// ==================== Tombstone API ====================

/// 标记一个 blob 已被本地删除。
///
/// 后续同步时 `sync_vfs_blobs_with_tombstones` 会把这条删除记录传播到云端和其他设备。
/// 调用场景：VFS 的 `blobs` 表里一条记录被物理删除（引用计数归零）时。
///
/// ## 参数
/// - `hash`: blob 的内容哈希（SHA-256）
/// - `relative_path`: 相对于 `vfs_blobs/` 的路径，如 `"ab/abc123.pdf"`
/// - `size`: blob 大小（字节），可选
/// - `cloud_config`: 云存储配置
#[tauri::command]
pub async fn data_governance_mark_blob_deleted(
    app: tauri::AppHandle,
    hash: String,
    relative_path: Option<String>,
    size: Option<u64>,
    cloud_config: CloudStorageConfig,
) -> Result<(), String> {
    let storage = create_storage(&cloud_config)
        .await
        .map_err(|e| format!("创建云存储失败: {}", e))?;

    let device_id = get_device_id(&app);
    // [P0-2] 透传加密密码，确保 tombstone 清单也走 DSBK
    let manager = SyncManager::with_encryption(device_id, cloud_config.encryption_password.clone());

    manager
        .mark_blob_deleted(storage.as_ref(), &hash, relative_path, size)
        .await
        .map_err(|e| format!("标记 blob 删除失败: {}", e))
}

/// 标记一个资产文件已被本地删除。
///
/// ## 参数
/// - `key`: 资产在 assets 云端路径里的 key，形如 `"active/images/foo.png"`
///          或 `"app_data/pdf_ocr_sessions/xxx.json"`
/// - `size`: 文件大小（字节），可选
/// - `cloud_config`: 云存储配置
#[tauri::command]
pub async fn data_governance_mark_asset_deleted(
    app: tauri::AppHandle,
    key: String,
    size: Option<u64>,
    cloud_config: CloudStorageConfig,
) -> Result<(), String> {
    let storage = create_storage(&cloud_config)
        .await
        .map_err(|e| format!("创建云存储失败: {}", e))?;

    let device_id = get_device_id(&app);
    // [P0-2] 透传加密密码
    let manager = SyncManager::with_encryption(device_id, cloud_config.encryption_password.clone());

    manager
        .mark_asset_deleted(storage.as_ref(), &key, size)
        .await
        .map_err(|e| format!("标记资产删除失败: {}", e))
}

// ==================== __sync_conflicts 查询与解决 ====================

use crate::data_governance::schema_registry::DatabaseId as _DatabaseId;

/// 单条记录级冲突
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecordConflictRow {
    pub id: i64,
    pub database_name: String,
    pub table_name: String,
    pub record_id: String,
    pub side: String, // "local" | "cloud"
    pub data_json: String,
    pub winning_device_id: Option<String>,
    pub losing_device_id: Option<String>,
    pub detected_at: String,
    pub resolved_at: Option<String>,
    pub resolution: Option<String>,
}

/// 列出未解决的记录级冲突（跨所有数据库聚合）
///
/// 从每个业务数据库的 `__sync_conflicts` 表读取 `resolved_at IS NULL` 的行，
/// 打上 `database_name` 标签后返回。前端用这个列表展示"待解决冲突"。
#[tauri::command]
pub async fn data_governance_list_record_conflicts(
    app: tauri::AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<RecordConflictRow>, String> {
    let active_dir = get_active_data_dir(&app)?;
    let limit = limit.unwrap_or(200).min(2000) as i64;
    let offset = offset.unwrap_or(0) as i64;

    let mut out: Vec<RecordConflictRow> = Vec::new();
    for db_id in _DatabaseId::all_ordered() {
        let db_path =
            crate::data_governance::commands_backup::resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // 冲突表可能不存在（从未发生过冲突）
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_conflicts')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            continue;
        }

        let mut stmt = conn
            .prepare(
                "SELECT id, table_name, record_id, side, data_json, winning_device_id,
                        losing_device_id, detected_at, resolved_at, resolution
                 FROM __sync_conflicts
                 WHERE resolved_at IS NULL
                 ORDER BY detected_at DESC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| format!("准备冲突查询失败: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![limit, offset], |row| {
                Ok(RecordConflictRow {
                    id: row.get(0)?,
                    database_name: db_id.as_str().to_string(),
                    table_name: row.get(1)?,
                    record_id: row.get(2)?,
                    side: row.get(3)?,
                    data_json: row.get(4)?,
                    winning_device_id: row.get(5)?,
                    losing_device_id: row.get(6)?,
                    detected_at: row.get(7)?,
                    resolved_at: row.get(8)?,
                    resolution: row.get(9)?,
                })
            })
            .map_err(|e| format!("执行冲突查询失败: {}", e))?;

        for r in rows.flatten() {
            out.push(r);
        }
    }
    Ok(out)
}

/// 统计每个数据库的待解决冲突数
#[tauri::command]
pub async fn data_governance_count_record_conflicts(
    app: tauri::AppHandle,
) -> Result<HashMap<String, u64>, String> {
    let active_dir = get_active_data_dir(&app)?;
    let mut out: HashMap<String, u64> = HashMap::new();

    for db_id in _DatabaseId::all_ordered() {
        let db_path =
            crate::data_governance::commands_backup::resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_conflicts')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            continue;
        }
        // 按 record_id 去重：一次冲突保存 2 条（local + cloud），用户关心的是"有多少条记录有冲突"
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT record_id || '|' || table_name)
                 FROM __sync_conflicts WHERE resolved_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            out.insert(db_id.as_str().to_string(), count as u64);
        }
    }
    Ok(out)
}

/// 解决一条冲突：按用户选择把某一端的数据写回业务表，并把冲突表里相关条目标记为已解决
///
/// ## 参数
/// - `database_name`: 数据库标识（`chat_v2` / `vfs` / `mistakes` / `llm_usage`）
/// - `table_name`: 业务表名
/// - `record_id`: 记录主键
/// - `resolution`: `"keep_local"` | `"keep_cloud"` | `"merged"`
/// - `merged_data_json`: 当 resolution = "merged" 时，用户手动合并后的完整行 JSON
#[tauri::command]
pub async fn data_governance_resolve_record_conflict(
    app: tauri::AppHandle,
    database_name: String,
    table_name: String,
    record_id: String,
    resolution: String,
    merged_data_json: Option<String>,
) -> Result<(), String> {
    let active_dir = get_active_data_dir(&app)?;

    // 找对应数据库
    let db_id = _DatabaseId::all_ordered()
        .into_iter()
        .find(|id| id.as_str() == database_name)
        .ok_or_else(|| format!("未知数据库: {}", database_name))?;
    let db_path =
        crate::data_governance::commands_backup::resolve_database_path(&db_id, &active_dir);

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("打开数据库 {} 失败: {}", database_name, e))?;

    // 取出冲突记录的 local/cloud 两端数据
    let get_side_data = |side: &str| -> Result<Option<String>, String> {
        let r: Result<String, _> = conn.query_row(
            "SELECT data_json FROM __sync_conflicts
             WHERE table_name = ?1 AND record_id = ?2 AND side = ?3 AND resolved_at IS NULL
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![&table_name, &record_id, side],
            |r| r.get(0),
        );
        match r {
            Ok(s) => Ok(Some(s)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("读取冲突数据失败: {}", e)),
        }
    };

    let target_json =
        match resolution.as_str() {
            "keep_local" => get_side_data("local")?
                .ok_or_else(|| "找不到该冲突的 local side 数据".to_string())?,
            "keep_cloud" => get_side_data("cloud")?
                .ok_or_else(|| "找不到该冲突的 cloud side 数据".to_string())?,
            "merged" => merged_data_json
                .ok_or_else(|| "resolution='merged' 时必须提供 merged_data_json".to_string())?,
            other => return Err(format!("未知 resolution: {}", other)),
        };

    let data: serde_json::Value =
        serde_json::from_str(&target_json).map_err(|e| format!("解析合并后数据失败: {}", e))?;

    // 通过同步链路回写：构造一条 suppress=true 的 Update change 走 force 路径
    let now = chrono::Utc::now().to_rfc3339();
    let change = SyncChangeWithData {
        table_name: table_name.clone(),
        record_id: record_id.clone(),
        operation: crate::data_governance::sync::ChangeOperation::Update,
        data: Some(data),
        changed_at: now.clone(),
        change_log_id: None,
        database_name: Some(database_name.clone()),
        // 冲突手动解决后**要走 change_log**，让其他设备能看到此次决策
        suppress_change_log: Some(false),
    };

    // 用普通 apply（策略已由用户表达完成，不需要再走 conflict_guard）
    SyncManager::apply_downloaded_changes(&conn, &[change], None)
        .map_err(|e| format!("写回冲突解决失败: {}", e))?;

    // 标记该冲突的 local/cloud 两条记录都已解决
    conn.execute(
        "UPDATE __sync_conflicts
         SET resolved_at = ?1, resolution = ?2
         WHERE table_name = ?3 AND record_id = ?4 AND resolved_at IS NULL",
        rusqlite::params![&now, &resolution, &table_name, &record_id],
    )
    .map_err(|e| format!("更新冲突状态失败: {}", e))?;

    Ok(())
}

/// 清理历史已解决的冲突记录（older than N 天）
#[tauri::command]
pub async fn data_governance_purge_resolved_conflicts(
    app: tauri::AppHandle,
    older_than_days: Option<u32>,
) -> Result<u64, String> {
    let active_dir = get_active_data_dir(&app)?;
    let cutoff_days = older_than_days.unwrap_or(30) as i64;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(cutoff_days)).to_rfc3339();

    let mut total: u64 = 0;
    for db_id in _DatabaseId::all_ordered() {
        let db_path =
            crate::data_governance::commands_backup::resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_conflicts')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            continue;
        }
        let n = conn
            .execute(
                "DELETE FROM __sync_conflicts WHERE resolved_at IS NOT NULL AND resolved_at < ?1",
                rusqlite::params![&cutoff],
            )
            .unwrap_or(0);
        total += n as u64;
    }
    Ok(total)
}

// ==================== 同步断层检测 ====================

/// 检测云端变更是否存在 prune 断层（本设备上次同步的 version 已超出云端保留范围）
///
/// ## 返回
/// - `has_gap`: 是否存在断层
/// - `since_version`: 本地最大 data_version
/// - `min_available_version`: 云端当前可用的最小变更版本；None 表示云端空
#[derive(Debug, Clone, serde::Serialize)]
pub struct PruneGapResponse {
    pub has_gap: bool,
    pub since_version: u64,
    pub min_available_version: Option<u64>,
}

#[tauri::command]
pub async fn data_governance_detect_prune_gap(
    app: tauri::AppHandle,
    cloud_config: CloudStorageConfig,
) -> Result<PruneGapResponse, String> {
    use crate::cloud_storage::create_storage;

    check_maintenance_mode(&app)?;

    let active_dir = get_active_data_dir(&app)?;

    // 本地最大 data_version
    let mut since_version: u64 = 0;
    for db_id in _DatabaseId::all_ordered() {
        let db_path =
            crate::data_governance::commands_backup::resolve_database_path(&db_id, &active_dir);
        if !db_path.exists() {
            continue;
        }
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                if state.data_version > since_version {
                    since_version = state.data_version;
                }
            }
        }
    }

    // 查询云端最小可用 version
    let storage = create_storage(&cloud_config)
        .await
        .map_err(|e| format!("创建云存储失败: {}", e))?;
    let min_available = SyncManager::get_min_available_change_version(storage.as_ref())
        .await
        .map_err(|e| format!("查询云端变更版本失败: {}", e))?;

    let has_gap = SyncManager::has_prune_gap(since_version, min_available);

    Ok(PruneGapResponse {
        has_gap,
        since_version,
        min_available_version: min_available,
    })
}
