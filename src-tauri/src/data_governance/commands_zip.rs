// ==================== ZIP 导出/导入命令 ====================

use std::path::PathBuf;
use tauri::{Manager, State};
use tracing::{debug, error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use std::time::Instant;
use super::backup::{
    export_backup_to_zip, AssetBackupConfig, AssetType, BackupManager, BackupSelection,
    TieredAssetConfig, ZipExportOptions,
};
use crate::backup_common::log_and_skip_entry_err;
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobParams,
    BackupJobPhase, BackupJobResultPayload, BackupJobStatus, BackupJobSummary,
};
use crate::utils::text::safe_truncate_chars;

#[cfg(feature = "data_governance")]
use super::commands::try_save_audit_log;
use super::commands_backup::{
    get_app_data_dir, get_backup_dir, validate_backup_id, validate_user_path,
    sanitize_path_for_user, ensure_existing_path_within_backup_dir, acquire_backup_global_permit,
    BackupJobStartResponse,
};

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
    use sha2::Digest;
    use std::fs::File;
    use std::io::Write;
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

