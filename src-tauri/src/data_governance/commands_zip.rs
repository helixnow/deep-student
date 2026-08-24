// ==================== ZIP 导出/导入命令 ====================

use std::path::PathBuf;
use tauri::State;
use tracing::{error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use super::backup::{
    export_backup_to_zip, AssetBackupConfig, AssetType, BackupManager, BackupSelection,
    TieredAssetConfig, ZipExportOptions,
};
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobParams, BackupJobPhase,
    BackupJobResultPayload,
};
use std::time::Instant;

#[cfg(feature = "data_governance")]
use super::commands::try_save_audit_log;
use super::commands_backup::{
    acquire_backup_global_permit, ensure_existing_path_within_backup_dir, get_app_data_dir,
    get_backup_dir, sanitize_path_for_user, validate_backup_id, validate_user_path,
    BackupJobStartResponse,
};

/// 将本地临时 ZIP 文件复制到虚拟 URI 目标（Android content:// 等），完成后清理临时文件。
fn copy_temp_zip_to_virtual_uri(
    window: &tauri::Window,
    local_path: &str,
    virtual_uri: &str,
) -> Result<(), String> {
    let local = std::path::Path::new(local_path);
    if !local.exists() {
        return Err(format!(
            "临时 ZIP 文件不存在，无法写入目标 URI: {}",
            local_path
        ));
    }

    info!(
        "[data_governance] 正在将 ZIP 复制到虚拟 URI: {} -> {}",
        local_path, virtual_uri
    );
    let bytes = match crate::unified_file_manager::copy_file(window, local_path, virtual_uri) {
        Ok(bytes) => bytes,
        Err(e) => {
            error!(
                "[data_governance] 复制 ZIP 到虚拟 URI 失败: {} -> {} ({})",
                local_path, virtual_uri, e
            );
            if let Err(cleanup_error) = std::fs::remove_file(local_path) {
                warn!(
                    "[data_governance] 复制失败后清理临时 ZIP 失败: {} ({})",
                    local_path, cleanup_error
                );
            }
            return Err(format!("复制 ZIP 到目标 URI 失败，临时导出已清理: {}", e));
        }
    };
    info!(
        "[data_governance] ZIP 已成功复制到虚拟 URI ({} 字节): {}",
        bytes, virtual_uri
    );
    // 清理本地临时文件
    if let Err(e) = std::fs::remove_file(local_path) {
        warn!(
            "[data_governance] 清理临时 ZIP 文件失败: {} ({})",
            local_path, e
        );
    }
    Ok(())
}

/// 解析 ZIP 导出/导入所用的备份密码。
///
/// 优先级：调用方显式传入的非空密码 >（开关打开时）安全存储里的已存密码。
/// 空串视为未配置，不发明密码；未配置则返回 `None`，保持便携 ZIP / 无密码导入。
pub fn resolve_zip_encryption_password(
    explicit_password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
    stored_password: Option<String>,
) -> Option<String> {
    if let Some(password) = explicit_password.filter(|password| !password.trim().is_empty()) {
        return Some(password);
    }
    if use_stored_cloud_encryption_password.unwrap_or(false) {
        return stored_password.filter(|password| !password.trim().is_empty());
    }
    None
}

/// 从安全存储读取已存云端 E2EE 密码。空串 / 读取失败视为未配置。
fn stored_cloud_encryption_password(app: &tauri::AppHandle) -> Option<String> {
    let mut config = crate::cloud_storage::CloudStorageConfig::default();
    crate::secure_store::hydrate_cloud_config(app, &mut config);
    config
        .encryption_password
        .filter(|password| !password.trim().is_empty())
}

fn resolve_zip_encryption_password_from_store(
    app: &tauri::AppHandle,
    explicit_password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
) -> Option<String> {
    let needs_stored = use_stored_cloud_encryption_password.unwrap_or(false)
        && explicit_password
            .as_deref()
            .map(|password| password.trim().is_empty())
            .unwrap_or(true);
    let stored_password = if needs_stored {
        stored_cloud_encryption_password(app)
    } else {
        None
    };
    resolve_zip_encryption_password(
        explicit_password,
        use_stored_cloud_encryption_password,
        stored_password,
    )
}

/// 一步完成「备份 + 导出 ZIP」（后台任务模式）
///
/// 默认行为：完整备份（数据库 + 资产）后直接导出到指定 ZIP 路径。
/// 若 `use_tiered=true`，则按分层参数执行备份后导出 ZIP。
///
/// `encryption_password`：可选备份密码。提供后执行加密全保真导出——
/// 敏感数据（crypto/ 密钥、审计库等）密封进密码加密载荷，导入时输入
/// 同一密码即可解封为可整槽恢复的完整快照（跨设备换机闭环）。
/// 不提供密码时导出未加密便携 ZIP：不含密钥材料，导入后仅为部分归档，
/// **不能整槽恢复**（结果 stats 中的 `recovery_kind` 会如实标注）。
#[tauri::command]
pub async fn data_governance_backup_and_export_zip(
    app: tauri::AppHandle,
    window: tauri::Window,
    backup_job_state: State<'_, BackupJobManagerState>,
    output_path: String,
    compression_level: Option<u32>,
    add_to_backup_list: Option<bool>,
    use_tiered: Option<bool>,
    tiers: Option<Vec<String>>,
    include_assets: Option<bool>,
    asset_types: Option<Vec<String>>,
    encryption_password: Option<String>,
) -> Result<BackupJobStartResponse, String> {
    let app_data_dir = get_app_data_dir(&app)?;

    // Android content:// 等虚拟 URI：先导出到本地临时文件，完成后再复制到目标 URI
    let (local_output_path, target_virtual_uri) =
        if crate::unified_file_manager::is_virtual_uri(&output_path) {
            let temp_dir = app_data_dir.join("temp_zip_export");
            std::fs::create_dir_all(&temp_dir)
                .map_err(|e| format!("创建 ZIP 临时导出目录失败: {}", e))?;
            let temp_path = temp_dir.join(format!("backup_export_{}.zip", uuid::Uuid::new_v4()));
            (
                temp_path.to_string_lossy().to_string(),
                Some(output_path.clone()),
            )
        } else {
            let user_output = PathBuf::from(&output_path);
            validate_user_path(&user_output, &app_data_dir)?;
            (output_path.clone(), None)
        };

    let compression_level = compression_level.unwrap_or(6).min(9);
    let add_to_backup_list = add_to_backup_list.unwrap_or(true);
    let use_tiered = use_tiered.unwrap_or(false);

    info!(
        "[data_governance] 启动后台备份并导出 ZIP 任务: output_path={}, virtual_target={:?}, compression={}, add_to_backup_list={}, use_tiered={}",
        sanitize_path_for_user(&PathBuf::from(&local_output_path)),
        target_virtual_uri.is_some(),
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
            Some(window),
            job_ctx,
            local_output_path.clone(),
            target_virtual_uri,
            compression_level,
            add_to_backup_list,
            use_tiered,
            tiers,
            include_assets,
            asset_types,
            encryption_password,
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

#[allow(clippy::too_many_arguments)]
async fn execute_backup_and_export_zip_with_progress(
    app: tauri::AppHandle,
    window: Option<tauri::Window>,
    job_ctx: BackupJobContext,
    output_path: String,
    target_virtual_uri: Option<String>,
    compression_level: u32,
    add_to_backup_list: bool,
    use_tiered: bool,
    tiers: Option<Vec<String>>,
    include_assets: Option<bool>,
    asset_types: Option<Vec<String>>,
    encryption_password: Option<String>,
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
        } else if include_assets.unwrap_or(!use_tiered) {
            "full".to_string()
        } else {
            "database_only".to_string()
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
    // BackupManager resolves slot databases through DataSpaceManager, while
    // crypto material and audit.db live under the application data root.
    manager.set_app_data_dir(app_data_dir.clone());
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

    let snapshot_barrier = match super::commands_backup::BackupSnapshotBarrier::enter(&app) {
        Ok(barrier) => barrier,
        Err(error) => {
            job_ctx.fail(format!("无法建立一致备份快照: {}", error));
            return;
        }
    };

    let backup_result: Result<super::backup::BackupManifest, String> = if use_tiered {
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
            .map(|result| result.manifest)
            .map_err(|e| format!("分层备份失败: {}", e))
    } else if include_assets {
        let mut asset_config = if let Some(types) = asset_types.clone() {
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
        if asset_types.is_none() {
            asset_config.max_file_size = u64::MAX;
            asset_config.max_total_size = u64::MAX;
        }

        manager
            .backup_with_assets(Some(asset_config))
            .map_err(|e| format!("完整备份失败: {}", e))
    } else {
        manager
            .backup_full()
            .map_err(|e| format!("备份失败: {}", e))
    };
    if let Err(error) = snapshot_barrier.release() {
        job_ctx.fail(error);
        return;
    }

    let backup_manifest = match backup_result {
        Ok(manifest) => manifest,
        Err(err) => {
            job_ctx.fail(err);
            return;
        }
    };
    let backup_id = backup_manifest.backup_id.clone();

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

    let encrypted_export = encryption_password.is_some();
    let export_result = export_backup_to_zip(
        &source_backup_dir,
        &ZipExportOptions {
            output_path: Some(PathBuf::from(&output_path)),
            compression_level,
            include_checksums: true,
            encryption_password,
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

    // 诚实分类导出产物：只有加密全保真 ZIP（且源备份本身可整槽恢复）才是
    // disaster_recovery；未加密便携 ZIP / 分层（含默认 core）产物一律是
    // partial_archive，导入后不能整槽恢复。
    let (recovery_kind, zip_restorable) =
        if encrypted_export && backup_manifest.validate_for_slot_restore().is_ok() {
            ("disaster_recovery", true)
        } else {
            ("partial_archive", false)
        };

    let final_output_path = if let Some(virtual_uri) = target_virtual_uri {
        job_ctx.mark_running(
            BackupJobPhase::Cleanup,
            98.0,
            Some("正在将 ZIP 写入所选文件位置...".to_string()),
            1,
            1,
        );
        let Some(window) = window.as_ref() else {
            job_ctx.fail("虚拟 URI 导出缺少窗口上下文".to_string());
            return;
        };
        if let Err(e) = copy_temp_zip_to_virtual_uri(window, &output_path, &virtual_uri) {
            job_ctx.fail(e);
            return;
        }
        virtual_uri
    } else {
        export_result.zip_path.to_string_lossy().to_string()
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
        output_path: Some(final_output_path.clone()),
        resolved_path: None,
        message: Some(format!(
            "备份并导出完成: {} 个文件，{} 字节{}",
            export_result.file_count,
            export_result.compressed_size,
            if zip_restorable {
                "（加密全保真 ZIP：导入时输入备份密码后可整槽恢复）"
            } else {
                "（便携归档：不含密钥等敏感数据，导入后不能整槽恢复）"
            }
        )),
        error: None,
        duration_ms: Some(duration_ms),
        stats: Some(serde_json::json!({
            "backup_id": backup_id,
            "zip_path": final_output_path,
            "compression_level": compression_level,
            "compression_ratio": export_result.compression_ratio(),
            "add_to_backup_list": add_to_backup_list,
            "use_tiered": use_tiered,
            "include_assets": include_assets,
            "encrypted": encrypted_export,
            "recovery_kind": recovery_kind,
            "restorable": zip_restorable,
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
/// - `encryption_password`: 可选备份密码。非空时导出加密全保真 ZIP
/// - `use_stored_cloud_encryption_password`: 未显式传密码时，是否从安全存储
///   读取已存云端 E2EE 密码。显式非空密码优先；未配置则保持便携 ZIP。
///   密码不写入日志 / Debug / job params。
///
/// ## 返回
/// - `BackupJobStartResponse`: 包含任务 ID 的响应
///
/// ## 事件
/// - `backup-job-progress`: 进度更新事件
#[tauri::command]
pub async fn data_governance_export_zip(
    app: tauri::AppHandle,
    window: tauri::Window,
    backup_job_state: State<'_, BackupJobManagerState>,
    backup_id: String,
    output_path: Option<String>,
    compression_level: Option<u32>,
    include_checksums: Option<bool>,
    encryption_password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
) -> Result<BackupJobStartResponse, String> {
    let validated_backup_id = validate_backup_id(&backup_id)?;

    // Android content:// 等虚拟 URI：先导出到本地临时文件，完成后再复制到目标 URI
    let (local_output_path, target_virtual_uri) = match &output_path {
        Some(p) if crate::unified_file_manager::is_virtual_uri(p) => {
            let app_data_dir = get_app_data_dir(&app)?;
            let temp_dir = app_data_dir.join("temp_zip_export");
            std::fs::create_dir_all(&temp_dir)
                .map_err(|e| format!("创建 ZIP 临时导出目录失败: {}", e))?;
            let temp_path = temp_dir.join(format!("zip_export_{}.zip", uuid::Uuid::new_v4()));
            (
                Some(temp_path.to_string_lossy().to_string()),
                Some(p.clone()),
            )
        }
        Some(p) => {
            let app_data_dir = get_app_data_dir(&app)?;
            let user_output = std::path::PathBuf::from(p);
            validate_user_path(&user_output, &app_data_dir)?;
            (Some(p.clone()), None)
        }
        None => (None, None),
    };

    info!(
        "[data_governance] 启动后台 ZIP 导出任务: backup_id={}, output_path={:?}, virtual_target={:?}, use_stored_cloud_encryption_password={}",
        validated_backup_id,
        local_output_path,
        target_virtual_uri.is_some(),
        use_stored_cloud_encryption_password.unwrap_or(false)
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
                "output_path": local_output_path.clone(),
                "subtype": "zip_export",
            })),
        );
    }

    // 在后台执行 ZIP 导出。虚拟 URI 的最终复制属于任务提交阶段，只有复制成功
    // 才允许发出唯一 Completed 终态。
    tauri::async_runtime::spawn(async move {
        execute_zip_export_with_progress(
            app,
            Some(window),
            job_ctx,
            validated_backup_id,
            local_output_path,
            target_virtual_uri,
            compression_level,
            include_checksums,
            encryption_password,
            use_stored_cloud_encryption_password,
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
#[allow(clippy::too_many_arguments)]
async fn execute_zip_export_with_progress(
    app: tauri::AppHandle,
    window: Option<tauri::Window>,
    job_ctx: BackupJobContext,
    backup_id: String,
    output_path: Option<String>,
    target_virtual_uri: Option<String>,
    compression_level: u32,
    include_checksums: bool,
    encryption_password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
) {
    use std::fs::File;
    use std::io::Write;
    use std::time::Instant;
    use walkdir::WalkDir;
    use zip::write::FileOptions;
    use zip::CompressionMethod;
    use zip::ZipWriter;

    let encryption_password = resolve_zip_encryption_password_from_store(
        &app,
        encryption_password,
        use_stored_cloud_encryption_password,
    );

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

    // ========== 加密全保真导出：整体委托给库导出器 ==========
    // 密封敏感数据 + 外层打包 + 自检在 export_backup_to_zip 内一体完成，
    // 与手工逐文件路径共用同一套导入安全策略。
    if let Some(password) = encryption_password {
        job_ctx.mark_running(
            BackupJobPhase::Compress,
            10.0,
            Some("正在密封敏感数据并生成加密全保真 ZIP...".to_string()),
            0,
            1,
        );

        let zip_path = match &output_path {
            Some(path) => PathBuf::from(path),
            None => backup_dir.join(format!("{}.zip", backup_id)),
        };
        if let Some(parent) = zip_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                job_ctx.fail(format!("创建输出目录失败: {}", e));
                return;
            }
        }

        let manifest_for_classification =
            super::backup::BackupManifest::load_from_file(&source_backup_dir.join("manifest.json"));

        let export_result = export_backup_to_zip(
            &source_backup_dir,
            &ZipExportOptions {
                output_path: Some(zip_path.clone()),
                compression_level,
                include_checksums,
                encryption_password: Some(password),
                ..Default::default()
            },
        );
        let export_result = match export_result {
            Ok(result) => result,
            Err(e) => {
                let msg = format!("加密 ZIP 导出失败: {}", e);
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
                            "encrypted": true,
                        })),
                    );
                }
                job_ctx.fail(msg);
                return;
            }
        };

        let final_output_path = if let Some(virtual_uri) = target_virtual_uri {
            let Some(window) = window.as_ref() else {
                job_ctx.fail("虚拟 URI 导出缺少窗口上下文".to_string());
                return;
            };
            let local_path = export_result.zip_path.to_string_lossy().to_string();
            if let Err(e) = copy_temp_zip_to_virtual_uri(window, &local_path, &virtual_uri) {
                job_ctx.fail(e);
                return;
            }
            virtual_uri
        } else {
            export_result.zip_path.to_string_lossy().to_string()
        };

        // 加密全保真 ZIP 只有在源备份本身可整槽恢复时才是 disaster_recovery。
        let zip_restorable = manifest_for_classification
            .as_ref()
            .map(|manifest| manifest.validate_for_slot_restore().is_ok())
            .unwrap_or(false);
        let recovery_kind = if zip_restorable {
            "disaster_recovery"
        } else {
            "partial_archive"
        };

        let duration_ms = start.elapsed().as_millis() as u64;
        #[cfg(feature = "data_governance")]
        {
            try_save_audit_log(
                &app,
                AuditLog::new(
                    AuditOperation::Backup {
                        backup_type: super::audit::BackupType::Full,
                        file_count: export_result.file_count,
                        total_size: export_result.compressed_size,
                    },
                    format!("zip_export/{}", backup_id),
                )
                .complete(duration_ms)
                .with_details(serde_json::json!({
                    "job_id": job_ctx.job_id.clone(),
                    "backup_id": backup_id.clone(),
                    "zip_path": final_output_path.clone(),
                    "subtype": "zip_export",
                    "encrypted": true,
                    "recovery_kind": recovery_kind,
                })),
            );
        }

        job_ctx.complete(
            Some(format!("加密全保真 ZIP 导出完成: {}", final_output_path)),
            export_result.file_count as u64,
            export_result.file_count as u64,
            BackupJobResultPayload {
                success: true,
                output_path: Some(final_output_path.clone()),
                resolved_path: Some(final_output_path),
                message: Some(if zip_restorable {
                    "加密全保真 ZIP 导出完成：导入时输入备份密码后可整槽恢复".to_string()
                } else {
                    "加密 ZIP 导出完成：源备份不是完整快照，导入后仍为部分归档".to_string()
                }),
                error: None,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "file_count": export_result.file_count,
                    "total_size": export_result.total_size,
                    "compressed_size": export_result.compressed_size,
                    "compression_ratio": export_result.compression_ratio(),
                    "zip_checksum": export_result.zip_checksum,
                    "encrypted": true,
                    "recovery_kind": recovery_kind,
                    "restorable": zip_restorable,
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            },
        );
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
    let mut total_files: usize = 0;

    for entry in WalkDir::new(&source_backup_dir)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || entry
                    .path()
                    .strip_prefix(&source_backup_dir)
                    .is_ok_and(|path| {
                        !super::backup::zip_export::is_portable_excluded_relative_path(path)
                    })
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                job_ctx.fail(format!("扫描备份目录失败: {}", error));
                return;
            }
        };
        let path = entry.path();
        let relative_path = match path.strip_prefix(&source_backup_dir) {
            Ok(p) => p,
            Err(_) => continue,
        };

        // 跳过空路径（根目录）
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        if super::backup::zip_export::is_portable_excluded_relative_path(relative_path) {
            continue;
        }

        let relative_path_str = relative_path.to_string_lossy().replace('\\', "/");
        if relative_path_str.eq_ignore_ascii_case("checksums.sha256") {
            continue;
        }

        if entry.file_type().is_symlink() {
            job_ctx.fail(format!(
                "备份目录包含符号链接，拒绝导出: {}",
                path.display()
            ));
            return;
        } else if entry.file_type().is_file() {
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    job_ctx.fail(format!(
                        "读取导出文件元数据失败 {}: {}",
                        path.display(),
                        error
                    ));
                    return;
                }
            };
            total_size = match total_size.checked_add(metadata.len()) {
                Some(size) => size,
                None => {
                    job_ctx.fail("ZIP 导出源总大小溢出".to_string());
                    return;
                }
            };
            total_files = match total_files.checked_add(1) {
                Some(count) => count,
                None => {
                    job_ctx.fail("ZIP 导出源文件计数溢出".to_string());
                    return;
                }
            };
            files_to_compress.push((path.to_path_buf(), relative_path_str));
        } else if entry.file_type().is_dir() {
            // 目录也需要记录，但不计入文件数
            files_to_compress.push((path.to_path_buf(), relative_path_str));
        } else {
            job_ctx.fail(format!(
                "备份目录包含非常规条目，拒绝导出: {}",
                path.display()
            ));
            return;
        }
    }

    let portable_manifest =
        match super::backup::zip_export::portable_manifest_bytes(&source_backup_dir) {
            Ok(bytes) => bytes,
            Err(error) => {
                job_ctx.fail(format!("生成便携备份清单失败: {}", error));
                return;
            }
        };
    if let Err(error) = super::backup::zip_export::preflight_export_source(
        &source_backup_dir,
        portable_manifest.len() as u64,
        include_checksums,
    ) {
        job_ctx.fail(format!("ZIP 导出源超出导入安全策略: {}", error));
        return;
    }

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

    if let Err(e) =
        super::backup::zip_export::ensure_zip_output_outside_source(&source_backup_dir, &zip_path)
    {
        job_ctx.fail(format!("ZIP 输出路径不安全: {}", e));
        return;
    }

    // 同目录临时文件完成后再持久化，失败或取消不会破坏已有目标 ZIP。
    let output_parent = zip_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let temp_output = match tempfile::NamedTempFile::new_in(output_parent) {
        Ok(file) => file,
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
    let zip_file = match temp_output.reopen() {
        Ok(file) => file,
        Err(e) => {
            job_ctx.fail(format!("打开 ZIP 临时文件失败: {}", e));
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
            drop(zip_writer);
            job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
            return;
        }

        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped_files.push(format!("{}: {}", relative_path_str, error));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            skipped_files.push(format!("{}: 导出期间变为符号链接", relative_path_str));
            continue;
        }

        if metadata.is_dir() {
            // 添加目录
            if let Err(e) = zip_writer.add_directory(relative_path_str, file_options) {
                warn!("[zip_export] 添加目录失败: {} - {}", relative_path_str, e);
                skipped_files.push(format!("{}: {}", relative_path_str, e));
            }
        } else if metadata.is_file() {
            let is_manifest = relative_path_str == "manifest.json";

            // 计算校验和（如果需要）
            if include_checksums {
                let checksum = if is_manifest {
                    Ok(crate::backup_common::calculate_bytes_hash(
                        &portable_manifest,
                    ))
                } else {
                    crate::backup_common::calculate_file_hash(path)
                };
                match checksum {
                    Ok(checksum) => checksums.push((relative_path_str.clone(), checksum)),
                    Err(error) => {
                        skipped_files.push(format!("{}: {}", relative_path_str, error));
                        continue;
                    }
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

            let write_result = if is_manifest {
                zip_writer
                    .write_all(&portable_manifest)
                    .map(|_| portable_manifest.len() as u64)
            } else {
                match File::open(path) {
                    Ok(mut file) => match file.metadata() {
                        Ok(opened) if opened.is_file() && opened.len() == metadata.len() => {
                            std::io::copy(&mut file, &mut zip_writer)
                        }
                        Ok(_) => Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "导出文件在打开期间发生变化",
                        )),
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            };
            let expected_write_size = if is_manifest {
                portable_manifest.len() as u64
            } else {
                metadata.len()
            };
            match write_result {
                Ok(written) if written == expected_write_size => {}
                Ok(written) => {
                    skipped_files.push(format!(
                        "{}: 写入大小不一致 expected={}, actual={}",
                        relative_path_str, expected_write_size, written
                    ));
                    continue;
                }
                Err(e) => {
                    warn!("[zip_export] 写入 ZIP 失败: {} - {}", relative_path_str, e);
                    skipped_files.push(format!("{}: {}", relative_path_str, e));
                    continue;
                }
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
        } else {
            skipped_files.push(format!("{}: 非常规文件类型", relative_path_str));
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
            skipped_files.push(format!("checksums.sha256: {}", e));
        } else if let Err(e) = zip_writer.write_all(checksums_content.as_bytes()) {
            warn!("[zip_export] 写入校验和文件失败: {}", e);
            skipped_files.push(format!("checksums.sha256: {}", e));
        }
    }

    // 完成 ZIP 文件
    let finished_file = match zip_writer.finish() {
        Ok(file) => file,
        Err(e) => {
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
    };
    if let Err(e) = finished_file.sync_all() {
        let msg = format!("同步 ZIP 临时文件失败: {}", e);
        job_ctx.fail(msg);
        return;
    }
    drop(finished_file);

    if !skipped_files.is_empty() {
        job_ctx.fail(format!(
            "ZIP 导出失败，{} 个文件未完整写入: {}",
            skipped_files.len(),
            skipped_files.join("; ")
        ));
        return;
    }

    if let Err(error) = super::backup::zip_export::validate_archive_path(temp_output.path()) {
        job_ctx.fail(format!("ZIP 导出自检失败，未发布输出: {}", error));
        return;
    }

    if job_ctx.is_cancelled() {
        job_ctx.cancelled(Some("用户取消 ZIP 导出".to_string()));
        return;
    }

    if let Err(e) = temp_output.persist(&zip_path) {
        let msg = format!("提交 ZIP 文件失败: {}", e.error);
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

    let final_output_path = if let Some(virtual_uri) = target_virtual_uri {
        let Some(window) = window.as_ref() else {
            job_ctx.fail("虚拟 URI 导出缺少窗口上下文".to_string());
            return;
        };
        let local_path = zip_path.to_string_lossy().to_string();
        if let Err(e) = copy_temp_zip_to_virtual_uri(window, &local_path, &virtual_uri) {
            job_ctx.fail(e);
            return;
        }
        virtual_uri
    } else {
        zip_path.to_string_lossy().to_string()
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let compression_ratio = if total_size > 0 {
        1.0 - (compressed_size as f64 / total_size as f64)
    } else {
        0.0
    };

    info!(
        "[data_governance] ZIP 导出成功: path={}, files={}, size={}->{}, ratio={:.1}%, duration={}ms",
        final_output_path, compressed_files, total_size, compressed_size, compression_ratio * 100.0, duration_ms
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
                "zip_path": final_output_path.clone(),
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
        output_path: Some(final_output_path.clone()),
        resolved_path: Some(final_output_path.clone()),
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
        Some(format!("ZIP 导出完成: {}", final_output_path)),
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
/// - `password`: 可选备份密码。非空时解封加密全保真 ZIP
/// - `use_stored_cloud_encryption_password`: 未显式传密码时，是否从安全存储
///   读取已存云端 E2EE 密码。显式非空密码优先；未配置则保持无密码导入。
///   密码不写入日志 / Debug / job params。
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
    window: tauri::Window,
    backup_job_state: State<'_, BackupJobManagerState>,
    zip_path: String,
    backup_id: Option<String>,
    password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
) -> Result<BackupJobStartResponse, String> {
    let validated_backup_id = match backup_id {
        Some(id) => Some(validate_backup_id(&id)?),
        None => None,
    };

    let app_data_dir = get_app_data_dir(&app)?;

    // Android content:// 等虚拟 URI 需要先物化到本地临时文件（ZIP 需要随机访问）
    let (zip_file_path, temp_cleanup_path) =
        if crate::unified_file_manager::is_virtual_uri(&zip_path) {
            let temp_dir = app_data_dir.join("temp_zip_import");
            match crate::unified_file_manager::ensure_local_path(&window, &zip_path, &temp_dir) {
                Ok(materialized) => {
                    let (path, cleanup) = materialized.into_owned();
                    (path.clone(), cleanup.or(Some(path)))
                }
                Err(e) => {
                    return Err(format!("无法读取 ZIP 文件: {}", e));
                }
            }
        } else {
            let path = PathBuf::from(&zip_path);
            validate_user_path(&path, &app_data_dir)?;
            if !path.exists() {
                return Err(format!(
                    "ZIP 文件不存在: {}。请确认文件路径正确，或重新选择文件",
                    sanitize_path_for_user(&path)
                ));
            }
            (path, None)
        };

    info!(
        "[data_governance] 启动后台 ZIP 导入任务: zip_path={}, backup_id={:?}, use_stored_cloud_encryption_password={}",
        zip_file_path.display(),
        validated_backup_id,
        use_stored_cloud_encryption_password.unwrap_or(false)
    );

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
        execute_zip_import_with_progress(
            app,
            job_ctx,
            zip_file_path,
            validated_backup_id,
            password,
            use_stored_cloud_encryption_password,
        )
        .await;
        // 清理从 content:// 物化的临时 ZIP 文件
        if let Some(temp_path) = temp_cleanup_path {
            if let Err(e) = std::fs::remove_file(&temp_path) {
                tracing::warn!(
                    "[data_governance] 临时 ZIP 文件清理失败: {} ({})",
                    temp_path.display(),
                    e
                );
            } else {
                tracing::info!(
                    "[data_governance] 已清理临时 ZIP 文件: {}",
                    temp_path.display()
                );
            }
        }
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
    password: Option<String>,
    use_stored_cloud_encryption_password: Option<bool>,
) {
    use super::backup::zip_export::{import_backup_from_zip_with_progress, ZipImportPhase};
    use std::time::Instant;

    let password = resolve_zip_encryption_password_from_store(
        &app,
        password,
        use_stored_cloud_encryption_password,
    );

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
        password.as_deref(),
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

            // 诚实分类导入产物：能否整槽恢复以导入清单的
            // validate_for_slot_restore 为准（与恢复门禁同一判定）。
            let imported_restorable =
                super::backup::BackupManifest::load_from_file(&target_dir.join("manifest.json"))
                    .map(|manifest| manifest.validate_for_slot_restore().is_ok())
                    .unwrap_or(false);
            let recovery_kind = if imported_restorable {
                "disaster_recovery"
            } else {
                "partial_archive"
            };

            // 完成
            let result_payload = BackupJobResultPayload {
                success: true,
                output_path: Some(target_dir.to_string_lossy().to_string()),
                resolved_path: None,
                message: Some(format!(
                    "ZIP 导入成功: {} 个文件, 备份 ID: {}{}",
                    file_count,
                    target_backup_id,
                    if imported_restorable {
                        "（完整快照，可整槽恢复）"
                    } else {
                        "（部分归档，不能整槽恢复）"
                    }
                )),
                error: None,
                duration_ms: Some(duration_ms),
                stats: Some(serde_json::json!({
                    "file_count": file_count,
                    "backup_id": target_backup_id,
                    "backup_path": target_dir.to_string_lossy().to_string(),
                    "recovery_kind": recovery_kind,
                    "restorable": imported_restorable,
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

/// 执行可恢复的 ZIP 导入（带断点续传支持）
///
/// 与 execute_zip_import_with_progress 类似，但会：
/// 1. 设置任务参数供持久化
/// 2. 初始化检查点
/// 3. 断点续传：跳过目标目录中已存在且大小匹配的文件
///
/// `password`：备份密码。加密全保真 ZIP 的续传必须由用户在恢复任务时
/// 重新提供（密码从不持久化到任务检查点）；缺失时导入器会在改动目标
/// 目录之前明确失败，目标保持可续传。未加密 ZIP 传 `None`。
///
/// 失败时**不**清理目标目录：外层半成品正是下次续传的起点；加密包解封
/// 中断留下的敏感明文半成品由导入器自身负责清理。
pub(super) async fn execute_zip_import_with_progress_resumable(
    app: tauri::AppHandle,
    job_ctx: BackupJobContext,
    zip_file_path: PathBuf,
    backup_id: Option<String>,
    password: Option<String>,
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

    // 设置任务参数（用于持久化和恢复）。注意：备份密码绝不写入持久化参数。
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
    // 自动跳过目标目录中已存在且大小匹配的文件；
    // 加密全保真 ZIP 的续传携带用户重新提供的备份密码。
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
        password.as_deref(),
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

#[cfg(test)]
mod resolve_zip_encryption_password_tests {
    use super::resolve_zip_encryption_password;

    #[test]
    fn unconfigured_stays_portable() {
        assert_eq!(
            resolve_zip_encryption_password(None, Some(true), None),
            None
        );
        assert_eq!(
            resolve_zip_encryption_password(Some(String::new()), Some(true), Some(String::new())),
            None
        );
        assert_eq!(
            resolve_zip_encryption_password(Some("   ".into()), Some(true), Some(" \t".into())),
            None
        );
        assert_eq!(
            resolve_zip_encryption_password(None, None, Some("stored-passphrase".into())),
            None
        );
        assert_eq!(
            resolve_zip_encryption_password(None, Some(false), Some("stored-passphrase".into())),
            None
        );
    }

    #[test]
    fn stored_password_used_when_flag_on() {
        assert_eq!(
            resolve_zip_encryption_password(None, Some(true), Some("stored-passphrase".into())),
            Some("stored-passphrase".into())
        );
    }

    #[test]
    fn explicit_password_overrides_stored() {
        assert_eq!(
            resolve_zip_encryption_password(
                Some("explicit-passphrase".into()),
                Some(true),
                Some("stored-passphrase".into())
            ),
            Some("explicit-passphrase".into())
        );
    }

    #[test]
    fn empty_explicit_falls_back_to_stored() {
        assert_eq!(
            resolve_zip_encryption_password(
                Some("   ".into()),
                Some(true),
                Some("stored-passphrase".into())
            ),
            Some("stored-passphrase".into())
        );
    }
}
