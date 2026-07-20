use crate::models::AppError;
use std::fs;
use std::path::{Path, PathBuf};

/// 启动时清理标记文件名（位于 base_app_data_dir 根目录）
pub const PURGE_MARKER_FILE: &str = ".purge_on_next_start";

pub struct PurgeReport {
    pub details: String,
    pub had_errors: bool,
}

pub fn purge_marker_path(base_app_data_dir: &Path) -> PathBuf {
    base_app_data_dir.join(PURGE_MARKER_FILE)
}

/// 写入清理标记（幂等）
pub fn write_purge_marker(base_app_data_dir: &Path) -> Result<(), AppError> {
    let marker = purge_marker_path(base_app_data_dir);
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建标记父目录失败: {}", e)))?;
    }
    fs::write(&marker, b"1")
        .map_err(|e| AppError::file_system(format!("写入清理标记失败: {}", e)))?;
    Ok(())
}

/// 是否存在清理标记
pub fn should_purge_on_start(base_app_data_dir: &Path) -> bool {
    purge_marker_path(base_app_data_dir).exists()
}

/// 清除清理标记
pub fn clear_purge_marker(base_app_data_dir: &Path) -> Result<(), AppError> {
    let marker = purge_marker_path(base_app_data_dir);
    if marker.exists() {
        fs::remove_file(&marker)
            .map_err(|e| AppError::file_system(format!("删除清理标记失败: {}", e)))?;
    }
    Ok(())
}

/// 在应用启动早期执行清理：删除 active_app_data_dir 下除 backups 与 temp_restore 之外的所有内容
pub fn purge_active_data_dir(active_app_data_dir: &Path) -> Result<PurgeReport, AppError> {
    let mut deleted_entries = Vec::new();
    let mut errors = Vec::new();

    let keep_names = ["backups", "temp_restore", "migration_core_backups"]; // 保留目录

    let entries = fs::read_dir(active_app_data_dir).map_err(|e| {
        AppError::file_system(format!(
            "读取活动数据目录失败: {} - {}",
            active_app_data_dir.display(),
            e
        ))
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if keep_names.contains(&name.as_str()) {
            continue;
        }

        if path.is_dir() {
            match fs::remove_dir_all(&path) {
                Ok(()) => deleted_entries.push(format!("目录: {}", path.display())),
                Err(e) => errors.push(format!("删除目录失败: {} - {}", path.display(), e)),
            }
        } else {
            match fs::remove_file(&path) {
                Ok(()) => deleted_entries.push(format!("文件: {}", path.display())),
                Err(e) => errors.push(format!("删除文件失败: {} - {}", path.display(), e)),
            }
        }
    }

    let mut report = String::new();
    if deleted_entries.is_empty() && errors.is_empty() {
        report.push_str("没有找到需要删除的文件\n");
    } else {
        if !deleted_entries.is_empty() {
            report.push_str(&format!("✅ 删除 {} 项:\n", deleted_entries.len()));
            for e in &deleted_entries {
                report.push_str(&format!("  - {}\n", e));
            }
        }
        if !errors.is_empty() {
            report.push_str(&format!("❌ {} 项删除失败:\n", errors.len()));
            for e in &errors {
                report.push_str(&format!("  - {}\n", e));
            }
        }
    }

    Ok(PurgeReport {
        details: report,
        had_errors: !errors.is_empty(),
    })
}

/// 启动早期执行真正的本机数据清理。
///
/// - 活跃槽保留用户明确约定的备份目录；
/// - 非活跃槽、测试槽和恢复 trash 全量删除，避免隐私数据可被切回；
/// - 重置同步消费游标，使空白本地库下次可以重新消费完整云端历史；
/// - 必须在任何业务数据库连接打开前调用。
pub fn purge_all_local_data(
    base_app_data_dir: &Path,
    active_app_data_dir: &Path,
) -> Result<PurgeReport, AppError> {
    let mut report = purge_active_data_dir(active_app_data_dir)?;
    let slots_dir = base_app_data_dir.join("slots");
    let active_canonical = active_app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| active_app_data_dir.to_path_buf());
    let mut extra_deleted = Vec::new();
    let mut extra_errors = Vec::new();

    for slot_name in ["slotA", "slotB", "slotC", "slotD"] {
        let slot_path = slots_dir.join(slot_name);
        let slot_canonical = slot_path
            .canonicalize()
            .unwrap_or_else(|_| slot_path.clone());
        if slot_canonical == active_canonical {
            continue;
        }
        if slot_path.exists() {
            if let Err(e) = fs::remove_dir_all(&slot_path) {
                extra_errors.push(format!(
                    "删除非活跃/测试槽失败: {} - {}",
                    slot_path.display(),
                    e
                ));
                continue;
            }
            extra_deleted.push(format!("数据槽: {}", slot_path.display()));
        }
        if let Err(e) = fs::create_dir_all(&slot_path) {
            extra_errors.push(format!("重建数据槽失败: {} - {}", slot_path.display(), e));
        }
    }

    if slots_dir.exists() {
        match fs::read_dir(&slots_dir) {
            Ok(entries) => {
                for entry_result in entries {
                    let entry = match entry_result {
                        Ok(entry) => entry,
                        Err(e) => {
                            extra_errors.push(format!(
                                "枚举数据槽清理项失败: {} - {}",
                                slots_dir.display(),
                                e
                            ));
                            continue;
                        }
                    };
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !(name.starts_with("slotA.trash-") || name.starts_with("slotB.trash-")) {
                        continue;
                    }
                    let path = entry.path();
                    let result = if path.is_dir() {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    };
                    match result {
                        Ok(()) => extra_deleted.push(format!("恢复残留: {}", path.display())),
                        Err(e) => extra_errors.push(format!(
                            "删除恢复残留失败: {} - {}",
                            path.display(),
                            e
                        )),
                    }
                }
            }
            Err(e) => extra_errors.push(format!(
                "读取数据槽目录失败: {} - {}",
                slots_dir.display(),
                e
            )),
        }
    }

    #[cfg(feature = "data_governance")]
    if let Err(e) =
        crate::data_governance::sync::state::SyncStateStore::reset_default_after_local_purge()
    {
        extra_errors.push(format!("重置同步消费基线失败: {}", e));
    }

    if !extra_deleted.is_empty() {
        report
            .details
            .push_str(&format!("✅ 额外清理 {} 项:\n", extra_deleted.len()));
        for item in extra_deleted {
            report.details.push_str(&format!("  - {}\n", item));
        }
    }
    if !extra_errors.is_empty() {
        report
            .details
            .push_str(&format!("❌ 额外清理 {} 项失败:\n", extra_errors.len()));
        for item in &extra_errors {
            report.details.push_str(&format!("  - {}\n", item));
        }
        report.had_errors = true;
    }

    Ok(report)
}
