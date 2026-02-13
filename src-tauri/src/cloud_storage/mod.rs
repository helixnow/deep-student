//! 云存储模块
//!
//! 提供统一的云存储访问层，支持 WebDAV 和 S3 兼容存储。
//!
//! ## 支持的存储后端
//! - **WebDAV**: 坚果云、Nextcloud、自建 WebDAV 等
//! - **S3**: AWS S3、Cloudflare R2、阿里云 OSS、MinIO 等
//!
//! ## 使用示例
//! ```rust,ignore
//! use cloud_storage::{create_storage, CloudStorageConfig, StorageProvider};
//!
//! let config = CloudStorageConfig {
//!     provider: StorageProvider::S3,
//!     s3: Some(S3Config { ... }),
//!     ..Default::default()
//! };
//!
//! let storage = create_storage(&config).await?;
//! storage.put("backups/data.zip", &data).await?;
//! ```

mod config;
#[cfg(feature = "cloud_storage_s3")]
mod s3;
mod sync_manager;
mod traits;
mod webdav;

pub use config::{CloudStorageConfig, S3Config, StorageProvider, WebDavConfig};
pub use sync_manager::{
    get_device_id, BackupVersion, CloudManifest, CloudSyncManager, DownloadResult, SyncStatus,
    UploadResult,
};
pub use traits::{CloudStorage, FileInfo, Result};

use crate::models::AppError;
#[cfg(feature = "cloud_storage_s3")]
use s3::S3Storage;
use webdav::WebDavStorage;

/// 根据配置创建存储实例
///
/// # Arguments
/// * `config` - 云存储配置
///
/// # Returns
/// 实现了 CloudStorage trait 的存储实例
pub async fn create_storage(config: &CloudStorageConfig) -> Result<Box<dyn CloudStorage>> {
    // 验证配置
    config.validate().map_err(|e| AppError::validation(e))?;

    let root = config.root();

    match config.provider {
        StorageProvider::WebDav => {
            let webdav_config = config
                .webdav
                .clone()
                .ok_or_else(|| AppError::validation("缺少 WebDAV 配置"))?;
            let storage = WebDavStorage::new(webdav_config, root)?;
            Ok(Box::new(storage))
        }
        #[cfg(feature = "cloud_storage_s3")]
        StorageProvider::S3 => {
            let s3_config = config
                .s3
                .clone()
                .ok_or_else(|| AppError::validation("缺少 S3 配置"))?;
            let storage = S3Storage::new(s3_config, root).await?;
            Ok(Box::new(storage))
        }
        #[cfg(not(feature = "cloud_storage_s3"))]
        StorageProvider::S3 => Err(AppError::configuration(
            "S3 存储支持未启用，请在编译时启用 cloud_storage_s3 feature".to_string(),
        )),
    }
}

// ============== Tauri Commands ==============

/// 检查云存储连接
#[tauri::command]
pub async fn cloud_storage_check_connection(config: CloudStorageConfig) -> Result<bool> {
    let storage = create_storage(&config).await?;
    storage.check_connection().await?;
    Ok(true)
}

/// 上传文件到云存储
#[tauri::command]
pub async fn cloud_storage_put(
    config: CloudStorageConfig,
    key: String,
    data: Vec<u8>,
) -> Result<()> {
    let storage = create_storage(&config).await?;
    storage.put(&key, &data).await
}

/// 从云存储下载文件
#[tauri::command]
pub async fn cloud_storage_get(config: CloudStorageConfig, key: String) -> Result<Option<Vec<u8>>> {
    let storage = create_storage(&config).await?;
    storage.get(&key).await
}

/// 列出云存储中的文件
#[tauri::command]
pub async fn cloud_storage_list(
    config: CloudStorageConfig,
    prefix: String,
) -> Result<Vec<FileInfo>> {
    let storage = create_storage(&config).await?;
    storage.list(&prefix).await
}

/// 删除云存储中的文件
#[tauri::command]
pub async fn cloud_storage_delete(config: CloudStorageConfig, key: String) -> Result<()> {
    let storage = create_storage(&config).await?;
    storage.delete(&key).await
}

/// 获取文件信息
#[tauri::command]
pub async fn cloud_storage_stat(
    config: CloudStorageConfig,
    key: String,
) -> Result<Option<FileInfo>> {
    let storage = create_storage(&config).await?;
    storage.stat(&key).await
}

/// 检查文件是否存在
#[tauri::command]
pub async fn cloud_storage_exists(config: CloudStorageConfig, key: String) -> Result<bool> {
    let storage = create_storage(&config).await?;
    storage.exists(&key).await
}

// ============== Sync Manager Commands ==============

/// 获取同步状态
#[tauri::command]
pub async fn cloud_sync_get_status(config: CloudStorageConfig) -> Result<SyncStatus> {
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    Ok(manager.get_status().await)
}

/// 列出云端所有备份版本
#[tauri::command]
pub async fn cloud_sync_list_versions(config: CloudStorageConfig) -> Result<Vec<BackupVersion>> {
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager.list_versions().await
}

/// 上传备份到云端
#[tauri::command]
pub async fn cloud_sync_upload(
    config: CloudStorageConfig,
    zip_path: String,
    app_version: Option<String>,
    note: Option<String>,
) -> Result<UploadResult> {
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager
        .upload(std::path::Path::new(&zip_path), app_version, note)
        .await
}

/// 从云端下载备份
#[tauri::command]
pub async fn cloud_sync_download(
    config: CloudStorageConfig,
    version_id: Option<String>,
    local_dir: String,
) -> Result<DownloadResult> {
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager
        .download(version_id.as_deref(), std::path::Path::new(&local_dir))
        .await
}

/// 删除云端备份版本
#[tauri::command]
pub async fn cloud_sync_delete_version(
    config: CloudStorageConfig,
    version_id: String,
) -> Result<()> {
    let storage = create_storage(&config).await?;
    let manager = CloudSyncManager::new(storage, get_device_id());
    manager.delete_version(&version_id).await
}

/// 获取设备 ID
#[tauri::command]
pub fn cloud_sync_get_device_id() -> String {
    get_device_id()
}

/// 检查 S3 feature 是否启用
#[tauri::command]
pub fn cloud_storage_is_s3_enabled() -> bool {
    cfg!(feature = "cloud_storage_s3")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_validation() {
        let config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.com".into(),
                username: "user".into(),
                password: "pass".into(),
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_provider_display() {
        assert_eq!(format!("{}", StorageProvider::WebDav), "WebDAV");
        assert_eq!(format!("{}", StorageProvider::S3), "S3");
    }
}
