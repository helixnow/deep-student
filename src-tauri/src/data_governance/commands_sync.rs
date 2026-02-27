// ==================== 同步相关命令 ====================

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;
use tauri::Manager;
use tracing::{debug, error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use super::schema_registry::DatabaseId;
use super::sync::{
    ChangeLogEntry, DatabaseSyncState, MergeStrategy, PendingChanges, SyncChangeWithData, SyncDirection,
    SyncExecutionResult, SyncManager, SyncManifest,
};
use crate::backup_common::BACKUP_GLOBAL_LIMITER;
use crate::cloud_storage::{create_storage, CloudStorage, CloudStorageConfig};

use super::commands::{check_maintenance_mode, try_save_audit_log, SYNC_LOCK_TIMEOUT_SECS};
use super::commands_backup::{
    get_app_data_dir, get_active_data_dir, resolve_database_path,
    validate_user_path, apply_downloaded_changes_to_databases, validate_backup_id,
    ApplyToDbsResult, build_id_column_map,
};

/// 便捷函数：获取各表主键列名映射（questions → exam_id 等）
fn id_column_map() -> HashMap<String, String> {
    build_id_column_map()
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
            let mut enriched = SyncManager::enrich_changes_with_data(&conn, &pending.entries, Some(&id_column_map()))
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

            // 先标记变更为已同步
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

            // 标记完成后重建 manifest 再上传（确保 data_version 反映最新状态）
            let upload_manifest = {
                let mut dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
                for db_id in DatabaseId::all_ordered() {
                    let db_path = resolve_database_path(&db_id, &active_dir);
                    if db_path.exists() {
                        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                            if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                                dbs.insert(db_id.as_str().to_string(), state);
                            }
                        }
                    }
                }
                manager.create_manifest(dbs)
            };
            manager
                .upload_manifest(storage.as_ref(), &upload_manifest)
                .await
                .map_err(|e| format!("上传清单失败: {}", e))?;

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
                    .upload_enriched_changes(storage.as_ref(), &all_enriched, None)
                    .await
                    .map_err(|e| format!("上传变更失败: {}", e))?;
            }

            // 先应用下载的变更，标记后再重建 manifest 上传
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

            // 标记完成后重建 manifest 再上传
            let refreshed_manifest = {
                let mut dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
                for db_id in DatabaseId::all_ordered() {
                    let db_path = resolve_database_path(&db_id, &active_dir);
                    if db_path.exists() {
                        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                            if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                                dbs.insert(db_id.as_str().to_string(), state);
                            }
                        }
                    }
                }
                manager.create_manifest(dbs)
            };
            manager
                .upload_manifest(storage.as_ref(), &refreshed_manifest)
                .await
                .map_err(|e| format!("上传刷新清单失败: {}", e))?;

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
                        match SyncManager::enrich_changes_with_data(&conn, &pending.entries, Some(&id_column_map())) {
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
    let app_data_dir = get_app_data_dir(&app).unwrap_or_else(|_| active_dir.clone());

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
                match SyncManager::enrich_changes_with_data(&conn, &pending.entries, Some(&id_column_map())) {
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

    // 上传带完整数据的变更（带字节级进度回调，节流 100ms）
    {
        let emitter_cb = emitter.clone();
        let last_emit_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let byte_progress_cb: Box<dyn Fn(u64, u64) + Send + Sync> = Box::new(move |done, total_bytes| {
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
        manager
            .upload_enriched_changes(storage, enriched, Some(byte_progress_cb))
            .await
            .map_err(|e| format!("上传同步失败: {}", e))?
    }

    emitter.emit_uploading(total, total, None).await;

    // 先标记变更为已同步
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

    // 标记完成后重建 manifest 再上传（确保 data_version 反映最新状态）
    {
        let mut refreshed_dbs: HashMap<String, DatabaseSyncState> = HashMap::new();
        for db_id in DatabaseId::all_ordered() {
            let db_path = resolve_database_path(&db_id, active_dir);
            if db_path.exists() {
                if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    if let Ok(state) = SyncManager::get_database_sync_state(&conn, db_id.as_str()) {
                        refreshed_dbs.insert(db_id.as_str().to_string(), state);
                    }
                }
            }
        }
        let refreshed_manifest = manager.create_manifest(refreshed_dbs);
        manager
            .upload_manifest(storage, &refreshed_manifest)
            .await
            .map_err(|e| format!("上传清单失败: {}", e))?;
    }

    emitter.emit_applying(total, total, None).await;

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = app_data_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    if let Err(e) = manager.sync_vfs_blobs(storage, &blobs_dir).await {
        tracing::warn!("[data_governance] VFS blob 同步失败（非致命）: {}", e);
    }

    // 清理云端超过 30 天的旧变更文件（非致命）
    if let Err(e) = manager.prune_old_changes(storage, 30).await {
        tracing::warn!("[data_governance] 云端变更文件清理失败（非致命）: {}", e);
    }

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

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = app_data_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    if let Err(e) = manager.sync_vfs_blobs(storage, &blobs_dir).await {
        tracing::warn!("[data_governance] VFS blob 同步失败（非致命）: {}", e);
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

    // 上传带完整数据的变更（唯一上传点，execute_bidirectional 不再内部上传）
    if !enriched.is_empty() {
        let upload_total = enriched.len() as u64;
        emitter.emit_uploading(0, upload_total, None).await;

        // 字节级进度回调——通过流式 PUT 实时上报已传输字节数（节流 100ms）
        let emitter_cb = emitter.clone();
        let last_emit_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let byte_progress_cb: Box<dyn Fn(u64, u64) + Send + Sync> = Box::new(move |done, total_bytes| {
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

        manager
            .upload_enriched_changes(storage, enriched, Some(byte_progress_cb))
            .await
            .map_err(|e| format!("上传变更失败: {}", e))?;

        emitter
            .emit_uploading(upload_total, upload_total, None)
            .await;
    }

    // 先应用下载的变更，标记完成后再重建 manifest 上传（确保清单反映最终状态）
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
        manager
            .upload_manifest(storage, &refreshed_manifest)
            .await
            .map_err(|e| format!("上传刷新清单失败: {}", e))?;
    }

    // 文件级云同步：工作区数据库（ws_*.db）+ VFS blobs
    let blobs_dir = app_data_dir.join("vfs_blobs");
    if let Err(e) = manager.sync_workspace_databases(storage, active_dir).await {
        tracing::warn!("[data_governance] 工作区数据库同步失败（非致命）: {}", e);
    }
    if let Err(e) = manager.sync_vfs_blobs(storage, &blobs_dir).await {
        tracing::warn!("[data_governance] VFS blob 同步失败（非致命）: {}", e);
    }

    // 清理云端超过 30 天的旧变更文件
    if let Err(e) = manager.prune_old_changes(storage, 30).await {
        tracing::warn!("[data_governance] 云端变更文件清理失败（非致命）: {}", e);
    }

    Ok((exec_result, total_skipped))
}

