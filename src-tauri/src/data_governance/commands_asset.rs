// ==================== 资产备份相关命令 ====================

use std::path::PathBuf;
use std::time::Instant;
use tauri::Manager;
use tracing::{error, info, warn};

use super::backup::{AssetBackupConfig, AssetType, AssetTypeStats, BackupManager};
use crate::backup_common::BACKUP_GLOBAL_LIMITER;

use super::commands_backup::{
    get_app_data_dir, get_active_data_dir, get_backup_dir, validate_backup_id,
    ensure_existing_path_within_backup_dir,
};
use super::commands_restore::RestoreResultResponse;

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

