// ==================== 恢复相关命令 ====================

use std::path::PathBuf;
use tauri::{Manager, State};
use tracing::{debug, error, info, warn};

#[cfg(feature = "data_governance")]
use super::audit::{AuditLog, AuditOperation};
use super::schema_registry::DatabaseId;
use crate::backup_common::BACKUP_GLOBAL_LIMITER;
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobParams,
    BackupJobPhase, BackupJobResultPayload, BackupJobStatus, BackupJobSummary,
};

#[cfg(feature = "data_governance")]
use super::commands::try_save_audit_log;
use super::commands_backup::{
    get_app_data_dir, get_backup_dir, validate_backup_id,
    ensure_existing_path_within_backup_dir, acquire_backup_global_permit,
    BackupJobStartResponse,
};

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

    // ============ 阶段 3a: 恢复加密密钥（跨设备恢复支持） ============
    match manager.restore_crypto_keys(&backup_subdir) {
        Ok(count) => {
            if count > 0 {
                info!(
                    "[data_governance] 加密密钥恢复完成: {} 个文件（API 密钥可跨设备解密）",
                    count
                );
            }
        }
        Err(e) => {
            // 加密密钥恢复失败不阻塞整体恢复，用户可手动重新配置 API 密钥
            warn!(
                "[data_governance] 加密密钥恢复失败（API 密钥可能需要重新配置）: {}",
                e
            );
        }
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
pub(super) async fn execute_backup_with_progress_resumable(
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
pub(super) async fn execute_zip_import_with_progress_resumable(
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

