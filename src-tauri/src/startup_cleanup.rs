use crate::models::AppError;
use std::fs;
use std::path::{Path, PathBuf};

/// 启动时清理标记文件名（位于 base_app_data_dir 根目录）
pub const PURGE_MARKER_FILE: &str = ".purge_on_next_start";

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
pub fn purge_active_data_dir(active_app_data_dir: &Path) -> Result<String, AppError> {
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

    Ok(report)
}
