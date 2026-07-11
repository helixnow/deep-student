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
const MANIFESTS_DIR: &str = "manifests";
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

    fn device_manifest_key(&self) -> String {
        format!("{}/{}.json", MANIFESTS_DIR, self.device_id)
    }

    fn merge_manifest(target: &mut CloudManifest, incoming: CloudManifest) {
        let mut by_id = std::collections::BTreeMap::new();
        for version in target
            .versions
            .drain(..)
            .chain(incoming.versions.into_iter())
        {
            by_id.insert(version.id.clone(), version);
        }
        target.versions = by_id.into_values().collect();
        target
            .versions
            .sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
        target.latest = target.versions.first().map(|v| v.id.clone());
        if incoming.updated_at > target.updated_at {
            target.updated_at = incoming.updated_at;
        }
    }

    async fn read_manifest_key(&self, key: &str) -> Result<Option<CloudManifest>> {
        match self.storage.get(key).await? {
            Some(data) => serde_json::from_slice(&data)
                .map(Some)
                .map_err(|e| AppError::internal(format!("manifest {key} 损坏: {e}"))),
            None => Ok(None),
        }
    }

    /// 读取云端 Manifest（合并 per-device manifest，兼容旧 manifest.json）
    pub async fn get_manifest(&self) -> Result<CloudManifest> {
        let mut merged = CloudManifest::default();
        let mut found = false;

        let list = self
            .storage
            .list_outcome(&format!("{MANIFESTS_DIR}/"))
            .await?;
        if list.truncated {
            return Err(AppError::internal(
                "云端备份 manifest 列表被截断，无法安全合并版本列表".to_string(),
            ));
        }
        for file in list.files {
            if !file.key.ends_with(".json") {
                continue;
            }
            match self.read_manifest_key(&file.key).await {
                Ok(Some(manifest)) => {
                    Self::merge_manifest(&mut merged, manifest);
                    found = true;
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("跳过损坏的设备 manifest {}: {}", file.key, e),
            }
        }

        match self.read_manifest_key(MANIFEST_FILE).await {
            Ok(Some(legacy)) => {
                Self::merge_manifest(&mut merged, legacy);
                found = true;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("主 manifest 解析失败，尝试备份: {e}");
                if let Some(backup) = self.read_manifest_key(MANIFEST_BACKUP_FILE).await? {
                    Self::merge_manifest(&mut merged, backup);
                    found = true;
                }
            }
        }

        if found {
            Ok(merged)
        } else {
            Ok(CloudManifest::default())
        }
    }

    async fn get_device_manifest(&self) -> Result<CloudManifest> {
        if let Some(manifest) = self.read_manifest_key(&self.device_manifest_key()).await? {
            Ok(manifest)
        } else {
            Ok(CloudManifest::default())
        }
    }

    /// 保存本设备 Manifest（per-device，避免多设备 RMW 覆盖）
    async fn save_manifest(&self, manifest: &CloudManifest) -> Result<()> {
        let data = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::internal(format!("序列化 manifest 失败: {e}")))?;

        let key = self.device_manifest_key();
        let temp_key = format!(
            "{}/{}.{}.tmp",
            MANIFESTS_DIR,
            self.device_id,
            chrono::Utc::now().timestamp_millis()
        );

        self.storage.put(&temp_key, &data).await?;

        let verify = self.storage.get(&temp_key).await?;
        match verify {
            Some(ref read_back) if read_back == &data => {}
            _ => {
                let _ = self.storage.delete(&temp_key).await;
                return Err(AppError::internal(
                    "manifest 临时文件验证失败：写入内容与读回不一致".to_string(),
                ));
            }
        }

        self.storage.put(&key, &data).await?;
        let _ = self.storage.delete(&temp_key).await;

        Ok(())
    }

    /// 获取同步状态
    pub async fn get_status(&self) -> SyncStatus {
        match self.storage.check_connection().await {
            Ok(_) => match self.get_manifest().await {
                Ok(manifest) => {
                    let device_last_sync = self
                        .read_manifest_key(&self.device_manifest_key())
                        .await
                        .ok()
                        .flatten()
                        .map(|m| m.updated_at);
                    let latest = manifest
                        .latest
                        .as_ref()
                        .and_then(|id| manifest.versions.iter().find(|v| &v.id == id).cloned());
                    SyncStatus {
                        connected: true,
                        cloud_version_count: manifest.versions.len(),
                        latest_version: latest,
                        last_sync_time: device_last_sync,
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

        // 生成版本 ID（毫秒 + 设备短 ID + 随机 nonce，避免同秒并发冲突）
        let now = Utc::now();
        let device_short = self
            .device_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(6)
            .collect::<String>();
        let nonce = Uuid::new_v4()
            .to_string()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>();
        let version_id = format!(
            "{}-{}-{}",
            now.format("%Y%m%d-%H%M%S-%3f"),
            device_short,
            nonce
        );
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
        let mut manifest = self.get_device_manifest().await?;
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
        let mut manifest = self.get_device_manifest().await?;

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

/// 恢复备份后轮换设备 ID。
///
/// restore 会把本机数据回退到过去时间点；继续沿用旧 device_id 会触发
/// data_governance 的回声过滤，使旧身份在备份点之后上传过的变更永远不被本机重新消费。
/// 轮换后本机以“新设备”身份重新追赶旧设备目录。
pub fn generate_device_id_after_restore() -> String {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "device".to_string());
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    format!("{}-{}", hostname, short_uuid)
}

/// Persist a pre-generated restore identity. Supplying the identity from the
/// restore journal makes retries idempotent after a crash or partial I/O error.
pub fn persist_device_id_after_restore(new_id: &str) -> std::io::Result<()> {
    use std::io::Write;

    if new_id.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "new device id must not be empty",
        ));
    }

    let possible_paths: Vec<std::path::PathBuf> =
        [dirs::data_local_dir(), dirs::config_dir(), dirs::home_dir()]
            .iter()
            .filter_map(|opt| opt.clone())
            .map(|dir| dir.join("deep-student").join(".device_id"))
            .collect();

    let mut wrote_any = false;
    for path in &possible_paths {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if path.exists() || !wrote_any {
            let parent = path.parent().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "device id path has no parent",
                )
            })?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(new_id.as_bytes())?;
            temporary.as_file().sync_all()?;
            temporary.persist(path).map_err(|error| error.error)?;
            wrote_any = true;
        }
    }
    if !wrote_any {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no writable device id location",
        ));
    }
    std::env::set_var("DEVICE_ID", new_id);
    Ok(())
}

pub fn rotate_device_id_after_restore() -> std::io::Result<(String, String)> {
    let old_id = get_device_id();
    let new_id = generate_device_id_after_restore();
    persist_device_id_after_restore(&new_id)?;
    tracing::info!("设备 ID 已在恢复后轮换: old={}, new={}", old_id, new_id);
    Ok((old_id, new_id))
}
