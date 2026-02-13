//! 云同步管理器
//!
//! 基于 ZIP 备份管线，提供云端版本管理、上传、下载功能

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

use super::traits::{CloudStorage, Result};
use crate::models::AppError;

/// 云端 Manifest 文件名
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_BACKUP_FILE: &str = "manifest.json.bak";
/// 备份文件目录
const BACKUPS_DIR: &str = "backups";
/// 默认保留版本数
const DEFAULT_MAX_VERSIONS: usize = 10;

/// 备份版本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupVersion {
    /// 版本 ID（时间戳格式：YYYYMMDD-HHMMSS）
    pub id: String,
    /// 创建时间
    pub timestamp: DateTime<Utc>,
    /// 文件大小（字节）
    pub size: u64,
    /// SHA256 校验和
    pub checksum: String,
    /// 来源设备 ID
    pub device_id: String,
    /// 应用版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// 备注
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 云端 Manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudManifest {
    /// Manifest 版本
    pub version: u32,
    /// 最新备份的版本 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// 所有备份版本列表（按时间倒序）
    pub versions: Vec<BackupVersion>,
    /// 最后更新时间
    pub updated_at: DateTime<Utc>,
}

impl Default for CloudManifest {
    fn default() -> Self {
        Self {
            version: 1,
            latest: None,
            versions: Vec::new(),
            updated_at: Utc::now(),
        }
    }
}

/// 同步状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// 是否已连接
    pub connected: bool,
    /// 云端版本数
    pub cloud_version_count: usize,
    /// 最新云端版本信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<BackupVersion>,
    /// 本地最后同步时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_time: Option<DateTime<Utc>>,
    /// 错误信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 上传结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// 上传的版本信息
    pub version: BackupVersion,
    /// 是否删除了旧版本
    pub pruned_versions: Vec<String>,
}

/// 下载结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    /// 下载的版本信息
    pub version: BackupVersion,
    /// 本地保存路径
    pub local_path: String,
}

/// 云同步管理器
pub struct CloudSyncManager {
    storage: Box<dyn CloudStorage>,
    device_id: String,
    max_versions: usize,
}

impl CloudSyncManager {
    /// 创建云同步管理器
    pub fn new(storage: Box<dyn CloudStorage>, device_id: String) -> Self {
        Self {
            storage,
            device_id,
            max_versions: DEFAULT_MAX_VERSIONS,
        }
    }

    /// 设置最大保留版本数
    pub fn with_max_versions(mut self, max: usize) -> Self {
        self.max_versions = max.max(1); // 至少保留 1 个版本
        self
    }

    /// 获取设备 ID
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 读取云端 Manifest
    pub async fn get_manifest(&self) -> Result<CloudManifest> {
        match self.storage.get(MANIFEST_FILE).await? {
            Some(data) => match serde_json::from_slice(&data) {
                Ok(manifest) => Ok(manifest),
                Err(e) => {
                    tracing::warn!("主 manifest 解析失败，尝试备份: {e}");
                    match self.storage.get(MANIFEST_BACKUP_FILE).await? {
                        Some(backup_data) => serde_json::from_slice(&backup_data)
                            .map_err(|e| AppError::internal(format!("manifest 及备份均损坏: {e}"))),
                        None => Err(AppError::internal(format!("manifest 损坏且无备份: {e}"))),
                    }
                }
            },
            None => Ok(CloudManifest::default()),
        }
    }

    /// 保存云端 Manifest（带备份）
    async fn save_manifest(&self, manifest: &CloudManifest) -> Result<()> {
        let data = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::internal(format!("序列化 manifest 失败: {e}")))?;

        if let Ok(Some(old_data)) = self.storage.get(MANIFEST_FILE).await {
            let _ = self.storage.put(MANIFEST_BACKUP_FILE, &old_data).await;
        }

        self.storage.put(MANIFEST_FILE, &data).await
    }

    /// 获取同步状态
    pub async fn get_status(&self) -> SyncStatus {
        match self.storage.check_connection().await {
            Ok(_) => match self.get_manifest().await {
                Ok(manifest) => {
                    let latest = manifest
                        .latest
                        .as_ref()
                        .and_then(|id| manifest.versions.iter().find(|v| &v.id == id).cloned());
                    SyncStatus {
                        connected: true,
                        cloud_version_count: manifest.versions.len(),
                        latest_version: latest,
                        last_sync_time: Some(manifest.updated_at),
                        error: None,
                    }
                }
                Err(e) => SyncStatus {
                    connected: true,
                    cloud_version_count: 0,
                    latest_version: None,
                    last_sync_time: None,
                    error: Some(format!("读取 manifest 失败: {e}")),
                },
            },
            Err(e) => SyncStatus {
                connected: false,
                cloud_version_count: 0,
                latest_version: None,
                last_sync_time: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// 列出云端所有版本
    pub async fn list_versions(&self) -> Result<Vec<BackupVersion>> {
        let manifest = self.get_manifest().await?;
        Ok(manifest.versions)
    }

    /// 上传备份文件（SOTA 流式上传）
    ///
    /// # Arguments
    /// * `zip_path` - 本地 ZIP 文件路径
    /// * `app_version` - 应用版本
    /// * `note` - 备注
    ///
    /// ## SOTA 特性
    /// - 流式读取：避免大文件占用过多内存
    /// - 进度反馈：实时上传进度
    /// - SHA256 校验：确保数据完整性
    pub async fn upload(
        &self,
        zip_path: &Path,
        app_version: Option<String>,
        note: Option<String>,
    ) -> Result<UploadResult> {
        self.upload_with_progress(zip_path, app_version, note, None)
            .await
    }

    /// 上传备份文件（带进度回调）
    ///
    /// # Arguments
    /// * `zip_path` - 本地 ZIP 文件路径
    /// * `app_version` - 应用版本
    /// * `note` - 备注
    /// * `progress` - 进度回调 (uploaded_bytes, total_bytes)
    pub async fn upload_with_progress(
        &self,
        zip_path: &Path,
        app_version: Option<String>,
        note: Option<String>,
        progress: Option<super::traits::UploadProgressCallback>,
    ) -> Result<UploadResult> {
        const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 提升到 10GB
        let metadata = std::fs::metadata(zip_path)
            .map_err(|e| AppError::internal(format!("读取文件元信息失败: {e}")))?;
        let file_size = metadata.len();

        if file_size > MAX_FILE_SIZE {
            return Err(AppError::validation(format!(
                "备份文件过大（{:.2} GB），最大支持 10 GB",
                file_size as f64 / 1024.0 / 1024.0 / 1024.0
            )));
        }

        tracing::info!(
            "开始上传备份文件: {} ({:.2} MB)",
            zip_path.display(),
            file_size as f64 / 1024.0 / 1024.0
        );

        // 生成版本 ID
        let now = Utc::now();
        let version_id = now.format("%Y%m%d-%H%M%S").to_string();
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);

        // 使用流式上传（自动计算 SHA256）
        let checksum = self
            .storage
            .put_file(&remote_key, zip_path, progress)
            .await?;

        tracing::info!(
            "上传完成: version={}, checksum={}",
            version_id,
            &checksum[..16]
        );

        // 创建版本信息
        let version = BackupVersion {
            id: version_id.clone(),
            timestamp: now,
            size: file_size,
            checksum,
            device_id: self.device_id.clone(),
            app_version,
            note,
        };

        // 更新 Manifest
        let mut manifest = self.get_manifest().await?;
        manifest.versions.insert(0, version.clone());
        manifest.latest = Some(version_id);
        manifest.updated_at = now;

        // 清理旧版本
        let pruned = self.prune_versions(&mut manifest).await?;

        // 保存 Manifest
        self.save_manifest(&manifest).await?;

        Ok(UploadResult {
            version,
            pruned_versions: pruned,
        })
    }

    /// 下载备份文件（SOTA 流式下载）
    ///
    /// # Arguments
    /// * `version_id` - 版本 ID（None 表示下载最新版本）
    /// * `local_dir` - 本地保存目录
    ///
    /// ## SOTA 特性
    /// - 流式写入：避免大文件占用过多内存
    /// - SHA256 校验：确保数据完整性
    pub async fn download(
        &self,
        version_id: Option<&str>,
        local_dir: &Path,
    ) -> Result<DownloadResult> {
        self.download_with_progress(version_id, local_dir, None)
            .await
    }

    /// 下载备份文件（带进度回调）
    ///
    /// # Arguments
    /// * `version_id` - 版本 ID（None 表示下载最新版本）
    /// * `local_dir` - 本地保存目录
    /// * `progress` - 进度回调 (downloaded_bytes, total_bytes)
    pub async fn download_with_progress(
        &self,
        version_id: Option<&str>,
        local_dir: &Path,
        progress: Option<super::traits::DownloadProgressCallback>,
    ) -> Result<DownloadResult> {
        let manifest = self.get_manifest().await?;

        // 确定要下载的版本
        let version = if let Some(id) = version_id {
            manifest.versions.iter().find(|v| v.id == id)
        } else {
            manifest
                .latest
                .as_ref()
                .and_then(|id| manifest.versions.iter().find(|v| &v.id == id))
        };

        let version = version
            .cloned()
            .ok_or_else(|| AppError::not_found("未找到指定版本"))?;

        tracing::info!(
            "开始下载备份文件: version={}, size={:.2} MB",
            version.id,
            version.size as f64 / 1024.0 / 1024.0
        );

        // 确保目录存在
        std::fs::create_dir_all(local_dir)
            .map_err(|e| AppError::internal(format!("创建目录失败: {e}")))?;

        let local_path = local_dir.join(format!("{}.zip", version.id));
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version.id);

        // 使用流式下载（自动校验 SHA256）
        let actual_checksum = self
            .storage
            .get_file(&remote_key, &local_path, Some(&version.checksum), progress)
            .await?;

        tracing::info!(
            "下载完成: version={}, checksum={}",
            version.id,
            &actual_checksum[..16]
        );

        Ok(DownloadResult {
            version,
            local_path: local_path.to_string_lossy().to_string(),
        })
    }

    /// 删除指定版本
    pub async fn delete_version(&self, version_id: &str) -> Result<()> {
        let mut manifest = self.get_manifest().await?;

        // 检查是否存在
        let idx = manifest
            .versions
            .iter()
            .position(|v| v.id == version_id)
            .ok_or_else(|| AppError::not_found("版本不存在"))?;

        // 删除云端文件
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);
        self.storage.delete(&remote_key).await?;

        // 更新 Manifest
        manifest.versions.remove(idx);
        if manifest.latest.as_deref() == Some(version_id) {
            manifest.latest = manifest.versions.first().map(|v| v.id.clone());
        }
        manifest.updated_at = Utc::now();

        self.save_manifest(&manifest).await
    }

    /// 清理旧版本，保留最近 N 个
    async fn prune_versions(&self, manifest: &mut CloudManifest) -> Result<Vec<String>> {
        let mut pruned = Vec::new();

        while manifest.versions.len() > self.max_versions {
            if let Some(old) = manifest.versions.pop() {
                let remote_key = format!("{}/{}.zip", BACKUPS_DIR, old.id);
                // 删除失败不影响整体流程
                if let Err(e) = self.storage.delete(&remote_key).await {
                    tracing::warn!("删除旧版本 {} 失败: {}", old.id, e);
                }
                pruned.push(old.id);
            }
        }

        Ok(pruned)
    }

    /// 计算 SHA256 校验和
    fn calculate_checksum(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
}

/// 获取或生成设备 ID
///
/// 优先级：
/// 1. 环境变量 DEVICE_ID
/// 2. data_local_dir/deep-student/.device_id 文件
/// 3. 如果上述都不可用，基于主机名 + 随机后缀生成稳定 ID
pub fn get_device_id() -> String {
    // 优先从环境变量获取
    if let Ok(id) = std::env::var("DEVICE_ID") {
        if !id.is_empty() {
            return id;
        }
    }

    // 获取可能的存储路径列表（按优先级）
    let possible_paths: Vec<std::path::PathBuf> =
        [dirs::data_local_dir(), dirs::config_dir(), dirs::home_dir()]
            .iter()
            .filter_map(|opt| opt.clone())
            .map(|dir| dir.join("deep-student").join(".device_id"))
            .collect();

    // 尝试从现有文件读取
    for path in &possible_paths {
        if path.exists() {
            if let Ok(id) = std::fs::read_to_string(path) {
                let id = id.trim();
                if !id.is_empty() {
                    return id.to_string();
                }
            }
        }
    }

    // 生成新的设备 ID（结合主机名以保证一定程度的稳定性）
    let hostname = std::env::var("COMPUTERNAME") // Windows
        .or_else(|_| std::env::var("HOSTNAME")) // Linux/Unix
        .or_else(|_| std::env::var("HOST")) // macOS
        .unwrap_or_else(|_| "device".to_string());
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let new_id = format!("{}-{}", hostname, short_uuid);

    // 尝试保存到第一个可用路径
    for path in &possible_paths {
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                if std::fs::write(path, &new_id).is_ok() {
                    tracing::info!("设备 ID 已保存到: {:?}", path);
                    break;
                }
            }
        }
    }

    new_id
}
