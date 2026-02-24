//! 备份配置模块
//!
//! 提供备份设置的存储和读取功能，支持：
//! - 自定义备份目录
//! - 自动备份开关和间隔
//! - 最大备份数限制
//! - 精简备份模式

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::data_governance::backup::{BackupManager, BackupSelection, BackupTier};
use crate::data_governance::backup::zip_export::{export_backup_to_zip, ZipExportOptions};
use crate::backup_common::log_and_skip_entry_err;
use crate::database::{Database, DatabaseManager};
use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

/// 备份配置存储键
const BACKUP_CONFIG_KEY: &str = "backup.config";

/// 备份配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    /// 自定义备份目录（None 表示使用默认目录）
    #[serde(default)]
    pub backup_directory: Option<String>,

    /// 是否启用自动备份
    #[serde(default)]
    pub auto_backup_enabled: bool,

    /// 自动备份间隔（小时），默认 24 小时
    #[serde(default = "default_interval_hours")]
    pub auto_backup_interval_hours: u32,

    /// 最大备份文件数量（None 表示无限制）
    #[serde(default)]
    pub max_backup_count: Option<u32>,

    /// 精简备份模式：仅备份数据库和设置，跳过图片、知识库等大文件
    #[serde(default)]
    pub slim_backup: bool,
    /// 分级备份：按层级选择备份范围（为空则全量备份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_tiers: Option<Vec<BackupTier>>,
}

fn default_interval_hours() -> u32 {
    24
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            backup_directory: None,
            auto_backup_enabled: false,
            auto_backup_interval_hours: default_interval_hours(),
            max_backup_count: Some(5), // 默认保留 5 个备份
            slim_backup: false,
            backup_tiers: None,
        }
    }
}

impl BackupConfig {
    /// 从数据库加载备份配置
    pub fn load(database: &Database) -> Result<Self> {
        match database.get_setting(BACKUP_CONFIG_KEY)? {
            Some(json_str) => {
                let config: BackupConfig = serde_json::from_str(&json_str)
                    .map_err(|e| AppError::internal(format!("解析备份配置失败: {}", e)))?;
                Ok(config)
            }
            None => Ok(Self::default()),
        }
    }

    /// 保存备份配置到数据库
    pub fn save(&self, database: &Database) -> Result<()> {
        let json_str = serde_json::to_string(self)
            .map_err(|e| AppError::internal(format!("序列化备份配置失败: {}", e)))?;
        database.save_setting(BACKUP_CONFIG_KEY, &json_str)?;
        Ok(())
    }

    /// 获取有效的备份目录
    /// 如果设置了自定义目录且存在，返回自定义目录；否则返回 None（使用默认目录）
    pub fn effective_backup_directory(&self) -> Option<&str> {
        self.backup_directory.as_ref().and_then(|dir| {
            let path = std::path::Path::new(dir);
            if path.exists() && path.is_dir() {
                Some(dir.as_str())
            } else {
                None
            }
        })
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

use crate::commands::AppState;
use tauri::State;

/// 获取备份配置
#[tauri::command]
pub async fn get_backup_config(state: State<'_, AppState>) -> Result<BackupConfig> {
    BackupConfig::load(&state.database)
}

/// 保存备份配置
#[tauri::command]
pub async fn set_backup_config(config: BackupConfig, state: State<'_, AppState>) -> Result<()> {
    config.save(&state.database)?;
    tracing::info!(
        "[AutoBackup] 配置已更新: auto={}, interval={}h, max={:?}, slim={}, tiers={}",
        config.auto_backup_enabled,
        config.auto_backup_interval_hours,
        config.max_backup_count,
        config.slim_backup,
        config.backup_tiers.as_ref().map_or(0, |tiers| tiers.len())
    );
    Ok(())
}

/// 选择备份目录
#[tauri::command]
pub async fn pick_backup_directory(
    state: State<'_, AppState>,
    #[allow(unused_variables)] window: tauri::Window,
) -> Result<Option<String>> {
    // blocking_pick_folder 在移动端不可用
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Err(anyhow::anyhow!("移动端不支持选择备份目录").into());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;

        let file_path = window
            .dialog()
            .file()
            .set_title("选择备份目录")
            .blocking_pick_folder();

        match file_path {
            Some(path) => {
                let path_str = path.to_string();
                // 更新配置
                let mut config = BackupConfig::load(&state.database)?;
                config.backup_directory = Some(path_str.clone());
                config.save(&state.database)?;
                tracing::info!("[AutoBackup] 备份目录已设置: {}", path_str);
                Ok(Some(path_str))
            }
            None => Ok(None),
        }
    }
}

/// 清除自定义备份目录（恢复使用默认目录）
#[tauri::command]
pub async fn clear_backup_directory(state: State<'_, AppState>) -> Result<()> {
    let mut config = BackupConfig::load(&state.database)?;
    config.backup_directory = None;
    config.save(&state.database)?;
    tracing::info!("[AutoBackup] 备份目录已清除，将使用默认目录");
    Ok(())
}

/// 获取默认备份目录路径（用于 UI 显示）
#[tauri::command]
pub async fn get_default_backup_directory(state: State<'_, AppState>) -> Result<String> {
    let root = state.file_manager.get_writable_app_data_dir();
    let backups_dir = root.join("backups");
    Ok(backups_dir.to_string_lossy().to_string())
}

// ============================================================================
// 自动备份调度器
// ============================================================================

use crate::file_manager::FileManager;
use chrono::{DateTime, Utc};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::time::{sleep, Duration};

/// 上次自动备份时间存储键
const LAST_AUTO_BACKUP_KEY: &str = "backup.last_auto_backup_time";

/// 防止自动备份重入的标志
static AUTO_BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);

/// 自动备份调度器 - 在应用启动时调用
/// 定期检查是否需要执行自动备份
pub async fn start_auto_backup_scheduler(
    database: Arc<Database>,
    database_manager: Arc<DatabaseManager>,
    file_manager: Arc<FileManager>,
) {
    tracing::info!("[AutoBackup] 自动备份调度器已启动");

    // 首次延迟 2 分钟，避免与应用启动争用资源
    sleep(Duration::from_secs(120)).await;

    loop {
        // 防止重入：原子地将 false→true，只有成功的线程才能继续
        if AUTO_BACKUP_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            tracing::debug!("[AutoBackup] 上一次备份仍在运行，跳过本次检查");
        } else {
            // 检查并执行自动备份；无论结果如何都重置标志
            let result = check_and_perform_auto_backup(
                database.clone(),
                database_manager.clone(),
                file_manager.clone(),
            )
            .await;
            AUTO_BACKUP_RUNNING.store(false, Ordering::SeqCst);
            if let Err(e) = result {
                tracing::warn!("[AutoBackup] 自动备份检查失败: {}", e);
            }
        }

        // 每小时检查一次
        sleep(Duration::from_secs(3600)).await;
    }
}

async fn check_and_perform_auto_backup(
    database: Arc<Database>,
    _database_manager: Arc<DatabaseManager>,
    file_manager: Arc<FileManager>,
) -> Result<()> {
    let config = BackupConfig::load(&database)?;

    if !config.auto_backup_enabled {
        return Ok(());
    }

    let last_backup_time = get_last_auto_backup_time(&database)?;
    let now = Utc::now();

    let should_backup = match last_backup_time {
        Some(last_time) => {
            let elapsed_hours = (now - last_time).num_hours();
            elapsed_hours >= config.auto_backup_interval_hours as i64
        }
        None => true,
    };

    if !should_backup {
        return Ok(());
    }

    tracing::info!("[AutoBackup] 开始执行自动备份...");

    let root = file_manager.get_writable_app_data_dir();
    let backups_dir = get_effective_backup_dir(&config, &root)?;

    let _permit = crate::backup_common::BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AppError::internal("备份信号量已关闭".to_string()))?;

    let manager = BackupManager::with_config(
        backups_dir.clone(),
        crate::data_governance::backup::BackupConfig {
            app_data_dir: root.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            progress_callback: None,
        },
    );

    let manifest = if let Some(tiers) = &config.backup_tiers {
        let selection = BackupSelection {
            tiers: tiers.clone(),
            ..Default::default()
        };
        manager
            .backup_tiered(&selection)
            .map_err(|e| AppError::internal(format!("分级备份失败: {}", e)))?
            .manifest
    } else if config.slim_backup {
        let selection = BackupSelection {
            tiers: vec![BackupTier::Core],
            ..Default::default()
        };
        manager
            .backup_tiered(&selection)
            .map_err(|e| AppError::internal(format!("精简备份失败: {}", e)))?
            .manifest
    } else {
        manager
            .backup_full()
            .map_err(|e| AppError::internal(format!("完整备份失败: {}", e)))?
    };

    let backup_id = &manifest.backup_id;
    let backup_subdir = backups_dir.join(backup_id);
    let zip_name = format!("auto-backup-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
    let zip_options = ZipExportOptions {
        output_path: Some(backups_dir.join(&zip_name)),
        ..Default::default()
    };
    export_backup_to_zip(&backup_subdir, &zip_options)
        .map_err(|e| AppError::internal(format!("ZIP 导出失败: {}", e)))?;

    let _ = std::fs::remove_dir_all(&backup_subdir);

    tracing::info!("[AutoBackup] 自动备份完成: {}", zip_name);
    save_last_auto_backup_time(&database, now)?;

    if let Some(max_count) = config.max_backup_count {
        cleanup_old_backups(&backups_dir, max_count)?;
    }

    Ok(())
}

/// 获取有效的备份目录
pub(crate) fn get_effective_backup_dir(config: &BackupConfig, root: &PathBuf) -> Result<PathBuf> {
    match &config.backup_directory {
        Some(custom_dir) => {
            let path = PathBuf::from(custom_dir);
            if path.exists() && path.is_dir() {
                Ok(path)
            } else {
                // 自定义目录不存在，回退到默认目录
                tracing::warn!(
                    "[AutoBackup] 自定义备份目录不存在: {}，使用默认目录",
                    custom_dir
                );
                Ok(root.join("backups"))
            }
        }
        None => Ok(root.join("backups")),
    }
}

/// 清理旧的自动备份，只保留指定数量
pub(crate) fn cleanup_old_backups(backups_dir: &PathBuf, max_count: u32) -> Result<()> {
    let mut auto_backups: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();

    // 收集所有自动备份文件
    if let Ok(entries) = std::fs::read_dir(backups_dir) {
        for entry in entries.filter_map(log_and_skip_entry_err) {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                // 只处理自动备份文件
                if name.starts_with("auto-backup-") && name.ends_with(".zip") {
                    if let Ok(metadata) = std::fs::metadata(&path) {
                        if let Ok(modified) = metadata.modified() {
                            auto_backups.push((path, modified));
                        }
                    }
                }
            }
        }
    }

    // 按时间排序（最新的在前）
    auto_backups.sort_by(|a, b| b.1.cmp(&a.1));

    // 删除多余的备份
    for (path, _) in auto_backups.iter().skip(max_count as usize) {
        tracing::info!("[AutoBackup] 删除旧备份: {}", path.display());
        if let Err(e) = std::fs::remove_file(path) {
            tracing::warn!("[AutoBackup] 删除旧备份失败 {}: {}", path.display(), e);
        }
    }

    Ok(())
}
/// 获取上次自动备份时间
fn get_last_auto_backup_time(database: &Database) -> Result<Option<DateTime<Utc>>> {
    match database.get_setting(LAST_AUTO_BACKUP_KEY)? {
        Some(time_str) => match DateTime::parse_from_rfc3339(&time_str) {
            Ok(dt) => Ok(Some(dt.with_timezone(&Utc))),
            Err(e) => {
                tracing::warn!("[AutoBackup] 解析上次备份时间失败: {}", e);
                Ok(None)
            }
        },
        None => Ok(None),
    }
}

/// 保存上次自动备份时间
fn save_last_auto_backup_time(database: &Database, time: DateTime<Utc>) -> Result<()> {
    database.save_setting(LAST_AUTO_BACKUP_KEY, &time.to_rfc3339())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use tempfile::TempDir;

    // ================================================================
    // BackupConfig::default 测试
    // ================================================================

    #[test]
    fn test_backup_config_default_values() {
        let config = BackupConfig::default();
        assert!(
            config.backup_directory.is_none(),
            "默认不应设置自定义备份目录"
        );
        assert!(!config.auto_backup_enabled, "默认不应启用自动备份");
        assert_eq!(
            config.auto_backup_interval_hours, 24,
            "默认备份间隔应为24小时"
        );
        assert_eq!(config.max_backup_count, Some(5), "默认最大备份数应为5");
        assert!(!config.slim_backup, "默认不应启用精简备份");
        assert!(config.backup_tiers.is_none(), "默认不应设置分级备份");
    }

    // ================================================================
    // BackupConfig serialize/deserialize 往返测试
    // ================================================================

    #[test]
    fn test_backup_config_serialization_roundtrip() {
        let config = BackupConfig {
            backup_directory: Some("/custom/path".to_string()),
            auto_backup_enabled: true,
            auto_backup_interval_hours: 12,
            max_backup_count: Some(10),
            slim_backup: true,
            backup_tiers: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: BackupConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.backup_directory, config.backup_directory);
        assert_eq!(parsed.auto_backup_enabled, config.auto_backup_enabled);
        assert_eq!(
            parsed.auto_backup_interval_hours,
            config.auto_backup_interval_hours
        );
        assert_eq!(parsed.max_backup_count, config.max_backup_count);
        assert_eq!(parsed.slim_backup, config.slim_backup);
    }

    #[test]
    fn test_backup_config_deserialize_with_defaults() {
        // 模拟旧版本配置（缺少新增字段），验证 serde(default) 生效
        let json = r#"{"autoBackupEnabled": false, "autoBackupIntervalHours": 48}"#;
        let parsed: BackupConfig = serde_json::from_str(json).unwrap();

        assert!(!parsed.auto_backup_enabled);
        assert_eq!(parsed.auto_backup_interval_hours, 48);
        // 缺少的字段应该使用默认值
        assert!(parsed.backup_directory.is_none());
        assert_eq!(parsed.max_backup_count, None); // serde(default) for Option => None
        assert!(!parsed.slim_backup);
        assert!(parsed.backup_tiers.is_none());
    }

    #[test]
    fn test_backup_config_camel_case_serialization() {
        let config = BackupConfig::default();
        let json = serde_json::to_string(&config).unwrap();

        // 验证使用 camelCase 序列化
        assert!(
            json.contains("autoBackupEnabled"),
            "应使用 camelCase 键名: {}",
            json
        );
        assert!(
            json.contains("autoBackupIntervalHours"),
            "应使用 camelCase 键名: {}",
            json
        );
        assert!(
            json.contains("maxBackupCount"),
            "应使用 camelCase 键名: {}",
            json
        );
    }

    // ================================================================
    // AUTO_BACKUP_RUNNING 原子操作测试
    // ================================================================

    #[test]
    fn test_auto_backup_running_compare_exchange() {
        // 确保初始状态为 false（测试可能并行运行，所以先重置）
        AUTO_BACKUP_RUNNING.store(false, Ordering::SeqCst);

        // 第一次 compare_exchange: false → true 应该成功
        let result =
            AUTO_BACKUP_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(result.is_ok(), "首次设置应该成功");
        assert_eq!(
            AUTO_BACKUP_RUNNING.load(Ordering::SeqCst),
            true,
            "标志应为 true"
        );

        // 第二次 compare_exchange: false → true 应该失败（当前是 true）
        let result2 =
            AUTO_BACKUP_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(result2.is_err(), "重入应该被阻止");

        // 重置标志
        AUTO_BACKUP_RUNNING.store(false, Ordering::SeqCst);

        // 重置后应该再次成功
        let result3 =
            AUTO_BACKUP_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(result3.is_ok(), "重置后应该能再次获取");

        // 清理
        AUTO_BACKUP_RUNNING.store(false, Ordering::SeqCst);
    }

    // ================================================================
    // get_effective_backup_dir 测试
    // ================================================================

    #[test]
    fn test_get_effective_backup_dir_no_custom() {
        let config = BackupConfig::default(); // backup_directory = None
        let root = PathBuf::from("/tmp/test_root");

        let result = get_effective_backup_dir(&config, &root).unwrap();
        assert_eq!(result, root.join("backups"), "无自定义目录时应返回默认路径");
    }

    #[test]
    fn test_get_effective_backup_dir_custom_exists() {
        let custom_dir = TempDir::new().unwrap();
        let config = BackupConfig {
            backup_directory: Some(custom_dir.path().to_string_lossy().to_string()),
            ..BackupConfig::default()
        };
        let root = PathBuf::from("/tmp/test_root");

        let result = get_effective_backup_dir(&config, &root).unwrap();
        assert_eq!(
            result,
            custom_dir.path(),
            "自定义目录存在时应使用自定义目录"
        );
    }

    #[test]
    fn test_get_effective_backup_dir_custom_not_exists() {
        let config = BackupConfig {
            backup_directory: Some("/tmp/__nonexistent_custom_backup_dir_12345__".to_string()),
            ..BackupConfig::default()
        };
        let root = PathBuf::from("/tmp/test_root");

        let result = get_effective_backup_dir(&config, &root).unwrap();
        assert_eq!(
            result,
            root.join("backups"),
            "自定义目录不存在时应回退到默认路径"
        );
    }

    // ================================================================
    // cleanup_old_backups 测试
    // ================================================================

    #[test]
    fn test_cleanup_old_backups_removes_oldest() {
        let dir = TempDir::new().unwrap();
        let backup_dir = dir.path().to_path_buf();

        // 创建 5 个模拟的自动备份文件
        // 通过 sleep 确保不同的修改时间
        for i in 0..5 {
            let name = format!("auto-backup-2026-01-0{}.zip", i + 1);
            let path = backup_dir.join(&name);
            std::fs::write(&path, format!("backup content {}", i)).unwrap();
            // 短暂等待确保文件修改时间不同
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // max_count = 2，应删除 3 个最旧的
        cleanup_old_backups(&backup_dir, 2).unwrap();

        let remaining: Vec<_> = std::fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("auto-backup-") && n.ends_with(".zip"))
                    .unwrap_or(false)
            })
            .collect();

        assert_eq!(
            remaining.len(),
            2,
            "应该保留 2 个备份，实际剩余: {}",
            remaining.len()
        );
    }

    #[test]
    fn test_cleanup_old_backups_no_op_when_under_limit() {
        let dir = TempDir::new().unwrap();
        let backup_dir = dir.path().to_path_buf();

        // 只创建 2 个文件，max_count = 5
        for i in 0..2 {
            let name = format!("auto-backup-2026-02-0{}.zip", i + 1);
            std::fs::write(backup_dir.join(&name), "content").unwrap();
        }

        cleanup_old_backups(&backup_dir, 5).unwrap();

        let remaining: Vec<_> = std::fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();

        assert_eq!(remaining.len(), 2, "未超过限制时不应删除任何文件");
    }

    #[test]
    fn test_cleanup_old_backups_ignores_non_auto_backups() {
        let dir = TempDir::new().unwrap();
        let backup_dir = dir.path().to_path_buf();

        // 创建自动备份和手动备份
        std::fs::write(backup_dir.join("auto-backup-001.zip"), "auto1").unwrap();
        std::fs::write(backup_dir.join("auto-backup-002.zip"), "auto2").unwrap();
        std::fs::write(backup_dir.join("manual-backup-001.zip"), "manual").unwrap();
        std::fs::write(backup_dir.join("some-other-file.txt"), "other").unwrap();

        cleanup_old_backups(&backup_dir, 1).unwrap();

        // 手动备份和其他文件不应受影响
        assert!(
            backup_dir.join("manual-backup-001.zip").exists(),
            "手动备份不应被清理"
        );
        assert!(
            backup_dir.join("some-other-file.txt").exists(),
            "非备份文件不应被清理"
        );
    }

    // ================================================================
    // log_and_skip_entry_err 测试（已统一到 backup_common）
    // ================================================================

    #[test]
    fn test_log_and_skip_entry_err_ok() {
        let result: std::result::Result<&str, String> = Ok("value");
        assert_eq!(log_and_skip_entry_err(result), Some("value"));
    }

    #[test]
    fn test_log_and_skip_entry_err_err() {
        let result: std::result::Result<i32, String> = Err("fail".to_string());
        assert_eq!(log_and_skip_entry_err(result), None);
    }

    // ================================================================
    // effective_backup_directory 测试
    // ================================================================

    #[test]
    fn test_effective_backup_directory_none() {
        let config = BackupConfig::default();
        assert!(
            config.effective_backup_directory().is_none(),
            "无自定义目录时应返回 None"
        );
    }

    #[test]
    fn test_effective_backup_directory_existing() {
        let dir = TempDir::new().unwrap();
        let config = BackupConfig {
            backup_directory: Some(dir.path().to_string_lossy().to_string()),
            ..BackupConfig::default()
        };
        assert!(
            config.effective_backup_directory().is_some(),
            "存在的目录应返回 Some"
        );
    }

    #[test]
    fn test_effective_backup_directory_nonexistent() {
        let config = BackupConfig {
            backup_directory: Some("/tmp/__nonexistent_dir_99999__".to_string()),
            ..BackupConfig::default()
        };
        assert!(
            config.effective_backup_directory().is_none(),
            "不存在的目录应返回 None"
        );
    }
}
