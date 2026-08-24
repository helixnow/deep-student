//! 云同步管理器
//!
//! 基于 ZIP 备份管线，提供云端版本管理、上传、下载功能

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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
/// 云端加密标记对象（相对云 root 的路径）。
///
/// 一旦某个云 root 出现过端到端加密（DSBK）备份，就写入此标记；此后未配置
/// `encryption_password` 的设备会被拒绝向同一 root 上传明文备份，避免同一
/// 恢复链上明文/密文混布。
const ENCRYPTION_MARKER_FILE: &str = ".encryption-marker";
/// [R06-e2ee-verifier] 携带密码校验子的加密标记版本。
/// `<= 1` 的旧标记没有校验子，允许一次性升级；`>= 2` 却缺校验子按损坏处理（fail-closed）。
const ENCRYPTION_MARKER_VERSION_WITH_VERIFIER: u32 = 2;

pub(crate) fn normalize_device_id(device_id: &str) -> String {
    let trimmed = device_id.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 128
        && !matches!(trimmed, "." | "..")
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return trimmed.to_string();
    }

    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    format!("device-{}", hex::encode(hasher.finalize()))
}

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

/// 云端加密标记
///
/// 该对象存在即表示对应云 root 出现过端到端加密备份：
/// - 明文上传判定只看「对象是否存在」（内容损坏时按存在处理，fail-closed）；
/// - [R06-e2ee-verifier] 加密上传前还要比对 `key_verifier` 中的不可逆密码
///   校验子，防止配错密码的设备向同一 root 写入另一套无法互解的密文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMarker {
    /// 标记格式版本
    pub version: u32,
    /// 首次写入标记的设备 ID
    pub created_by_device: String,
    /// 首次写入时间
    pub created_at: DateTime<Utc>,
    /// [R06] 密码校验子（不可逆；旧标记无此字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_verifier: Option<crate::crypto::backup_crypto::PasswordVerifier>,
}

/// 云端加密标记的三态读取结果（内部使用）。
///
/// 与对外的 `read_encryption_marker` 不同，这里把「内容损坏」与「合法旧标记」
/// 区分开：密码校验路径对损坏标记必须 fail-closed，而不能把它当成可升级的旧标记。
enum EncryptionMarkerState {
    /// 云端不存在标记
    Absent,
    /// 标记存在且可解析
    Present(EncryptionMarker),
    /// 标记对象存在但内容无法解析
    Corrupted,
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
    /// [R10-verifier] 本机「该云端目录曾经加密」记忆（第二道明文上传门禁）。
    /// `None` = 本机数据目录不可用（如未初始化的测试环境），退化为仅云端标记判定。
    encryption_memory: Option<crate::crypto::backup_crypto::EncryptedRootMemory>,
}

/// [R10-verifier] 默认记忆文件：`<app_data_dir>/.cloud-encrypted-roots.json`
/// （与 `.device_id` 同根）。
fn default_encryption_root_memory() -> Option<crate::crypto::backup_crypto::EncryptedRootMemory> {
    crate::data_space::get_data_space_manager().map(|manager| {
        crate::crypto::backup_crypto::EncryptedRootMemory::at(
            manager.base_dir().join(".cloud-encrypted-roots.json"),
        )
    })
}

impl CloudSyncManager {
    /// 创建云同步管理器
    pub fn new(storage: Box<dyn CloudStorage>, device_id: String) -> Self {
        Self {
            storage,
            device_id: normalize_device_id(&device_id),
            max_versions: DEFAULT_MAX_VERSIONS,
            encryption_memory: default_encryption_root_memory(),
        }
    }

    /// 设置最大保留版本数
    pub fn with_max_versions(mut self, max: usize) -> Self {
        self.max_versions = max.max(1); // 至少保留 1 个版本
        self
    }

    /// [R10-verifier] 注入本机加密目录记忆存储（测试钩子；生产走 [`Self::new`] 默认路径）。
    pub fn with_encryption_root_memory(
        mut self,
        memory: crate::crypto::backup_crypto::EncryptedRootMemory,
    ) -> Self {
        self.encryption_memory = Some(memory);
        self
    }

    /// [R10-verifier] 本机登记「该云端目录曾经加密」（幂等，失败只警告不阻断：
    /// 记忆是第二道防线，云端标记仍是第一道门禁）。
    fn remember_encrypted_root(&self) {
        if let Some(memory) = &self.encryption_memory {
            let fingerprint = crate::crypto::backup_crypto::EncryptedRootMemory::fingerprint(
                &self.storage.instance_binding_hint(),
            );
            if let Err(error) = memory.remember(&fingerprint) {
                tracing::warn!("登记本机加密目录记忆失败（不阻断本次操作）: {error}");
            }
        }
    }

    /// [R10-verifier] 本机是否记得该云端目录曾经加密。
    fn encrypted_root_remembered_locally(&self) -> bool {
        self.encryption_memory.as_ref().is_some_and(|memory| {
            memory.was_encrypted(
                &crate::crypto::backup_crypto::EncryptedRootMemory::fingerprint(
                    &self.storage.instance_binding_hint(),
                ),
            )
        })
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
        for version in target.versions.drain(..).chain(incoming.versions) {
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

    fn validate_version_id(id: &str) -> Result<()> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(AppError::validation(format!(
                "云端备份版本 ID 非法: {id:?}"
            )));
        }
        Ok(())
    }

    fn validate_manifest(key: &str, manifest: &CloudManifest) -> Result<()> {
        const MAX_MANIFEST_VERSIONS: usize = 10_000;
        if manifest.versions.len() > MAX_MANIFEST_VERSIONS {
            return Err(AppError::validation(format!(
                "manifest {key} 版本数量异常: {}",
                manifest.versions.len()
            )));
        }

        let mut seen = HashSet::with_capacity(manifest.versions.len());
        for version in &manifest.versions {
            Self::validate_version_id(&version.id)?;
            if !seen.insert(version.id.as_str()) {
                return Err(AppError::validation(format!(
                    "manifest {key} 包含重复版本 ID: {}",
                    version.id
                )));
            }
            if version.checksum.len() != 64
                || !version
                    .checksum
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(AppError::validation(format!(
                    "manifest {key} 的版本 {} 校验和非法",
                    version.id
                )));
            }
        }

        match manifest.latest.as_deref() {
            Some(latest) if !seen.contains(latest) => Err(AppError::validation(format!(
                "manifest {key} 的 latest 未指向有效版本: {latest}"
            ))),
            None if !manifest.versions.is_empty() => Err(AppError::validation(format!(
                "manifest {key} 含版本但缺少 latest"
            ))),
            _ => Ok(()),
        }
    }

    async fn read_manifest_key(&self, key: &str) -> Result<Option<CloudManifest>> {
        match self.storage.get(key).await? {
            Some(data) => {
                let manifest: CloudManifest = serde_json::from_slice(&data)
                    .map_err(|e| AppError::internal(format!("manifest {key} 损坏: {e}")))?;
                Self::validate_manifest(key, &manifest)?;
                Ok(Some(manifest))
            }
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
            match self.read_manifest_key(&file.key).await? {
                Some(manifest) => {
                    Self::merge_manifest(&mut merged, manifest);
                    found = true;
                }
                None => {}
            }
        }

        match self.read_manifest_key(MANIFEST_FILE).await {
            Ok(Some(legacy)) => {
                Self::merge_manifest(&mut merged, legacy);
                found = true;
            }
            Ok(None) => {}
            Err(primary_error) => {
                tracing::warn!("主 manifest 解析失败，尝试备份: {primary_error}");
                let backup = self.read_manifest_key(MANIFEST_BACKUP_FILE).await?;
                let Some(backup) = backup else {
                    return Err(primary_error);
                };
                Self::merge_manifest(&mut merged, backup);
                found = true;
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
        self.save_manifest_at_key(&self.device_manifest_key(), manifest)
            .await
    }

    async fn save_manifest_at_key(&self, key: &str, manifest: &CloudManifest) -> Result<()> {
        Self::validate_manifest(key, manifest)?;
        let data = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::internal(format!("序列化 manifest 失败: {e}")))?;

        let temp_key = format!("{key}.{}.tmp", Uuid::new_v4());

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

        self.storage.put(key, &data).await?;
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

    /// 读取云端加密标记的三态结果（内部）。
    async fn read_encryption_marker_state(&self) -> Result<EncryptionMarkerState> {
        match self.storage.get(ENCRYPTION_MARKER_FILE).await? {
            Some(data) => match serde_json::from_slice::<EncryptionMarker>(&data) {
                Ok(marker) => Ok(EncryptionMarkerState::Present(marker)),
                Err(error) => {
                    tracing::warn!(
                        "云端加密标记 {} 内容无法解析，按存在处理: {}",
                        ENCRYPTION_MARKER_FILE,
                        error
                    );
                    Ok(EncryptionMarkerState::Corrupted)
                }
            },
            None => Ok(EncryptionMarkerState::Absent),
        }
    }

    /// 读取云端加密标记。
    ///
    /// 标记对象存在但内容损坏时按「存在」处理（fail-closed）：宁可多拦一次
    /// 明文上传，也不能让被破坏的标记悄悄放行明文。
    pub async fn read_encryption_marker(&self) -> Result<Option<EncryptionMarker>> {
        Ok(match self.read_encryption_marker_state().await? {
            EncryptionMarkerState::Absent => None,
            EncryptionMarkerState::Present(marker) => Some(marker),
            EncryptionMarkerState::Corrupted => Some(EncryptionMarker {
                version: 0,
                created_by_device: "unknown".to_string(),
                created_at: Utc::now(),
                key_verifier: None,
            }),
        })
    }

    /// 序列化并覆盖写入云端加密标记。
    async fn write_encryption_marker(&self, marker: &EncryptionMarker) -> Result<()> {
        let data = serde_json::to_vec_pretty(marker)
            .map_err(|e| AppError::internal(format!("序列化加密标记失败: {e}")))?;
        self.storage.put(ENCRYPTION_MARKER_FILE, &data).await
    }

    /// 幂等写入云端加密标记：已存在则保持原样（保留首次写入者与时间）。
    ///
    /// 仅供**拿不到加密密码原文**的调用方使用（如记录级同步的 bool 策略入口），
    /// 新建的标记不含密码校验子；ZIP 上传路径改走
    /// [`Self::verify_encryption_password_before_upload`]，无标记时会直接登记
    /// 带校验子的标记，旧标记则被一次性升级。
    pub async fn persist_encryption_marker(&self) -> Result<EncryptionMarker> {
        if let Some(existing) = self.read_encryption_marker().await? {
            return Ok(existing);
        }
        let marker = EncryptionMarker {
            version: 1,
            created_by_device: self.device_id.clone(),
            created_at: Utc::now(),
            key_verifier: None,
        };
        self.write_encryption_marker(&marker).await?;
        Ok(marker)
    }

    /// [R06-e2ee-verifier] 加密上传前校验（或登记）云端加密标记的密码校验子。
    ///
    /// 语义（全部发生在写入任何 `backups/` 对象之前）：
    /// - 无标记：用本机密码生成不可逆校验子，登记 v2 标记后放行；
    /// - 有校验子：复算比对——不一致立即失败（错密码设备不得向同一 root
    ///   写入另一套无法互解的密文）；无法校验（未知 KDF / 字段损坏）fail-closed；
    /// - 旧标记（`version <= 1`，无校验子）：[R12-v1-trust] 先用本机密码
    ///   试解该 root 的既有备份（空仓则跳过），通过后才做**一次性升级**，
    ///   保留首次写入者与时间；升级后错密码设备即可被拦截；
    /// - `version >= 2` 却缺校验子、或标记内容损坏：按损坏处理，fail-closed。
    pub async fn verify_encryption_password_before_upload(
        &self,
        password: &str,
    ) -> Result<EncryptionMarker> {
        let marker = match self.read_encryption_marker_state().await? {
            EncryptionMarkerState::Absent => {
                let verifier = crate::crypto::backup_crypto::create_password_verifier(password)
                    .map_err(|e| AppError::internal(format!("生成加密标记校验子失败: {e}")))?;
                let marker = EncryptionMarker {
                    version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
                    created_by_device: self.device_id.clone(),
                    created_at: Utc::now(),
                    key_verifier: Some(verifier),
                };
                self.write_encryption_marker(&marker).await?;
                return Ok(marker);
            }
            EncryptionMarkerState::Corrupted => {
                return Err(AppError::configuration(super::sync_e2ee_error(
                    super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                    "云端加密标记（.encryption-marker）内容已损坏，无法确认加密密码与既有备份\
                     一致，已在上传前中止（fail-closed）。请人工检查该云端目录后重试。",
                )));
            }
            EncryptionMarkerState::Present(marker) => marker,
        };

        match &marker.key_verifier {
            Some(verifier) => {
                match crate::crypto::backup_crypto::check_password_verifier(password, verifier) {
                    Ok(true) => Ok(marker),
                    Ok(false) => Err(AppError::configuration(super::sync_e2ee_error(
                        super::SYNC_E2EE_WRONG_PASSWORD_CODE,
                        "加密密码与该云端目录既有加密备份使用的密码不一致，已在上传前中止，\
                         未写入任何备份对象。请核对加密密码后重试，或改用新的云端目录。",
                    ))),
                    Err(error) => Err(AppError::configuration(super::sync_e2ee_error(
                        super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                        format!(
                            "无法校验云端加密标记的密码校验子（fail-closed，已在上传前中止）：{error}。\
                             该标记可能由更新版本的应用写入，请先升级本机应用。"
                        ),
                    ))),
                }
            }
            // 旧版标记（R06 之前）没有校验子：以当前密码一次性升级。
            // [R12-v1-trust] 升级前先用本机密码试解该 root 的既有备份：只有
            // 确实能解开既有密文的密码才有资格被固化进 v2 标记，成为此后所有
            // 设备的校验基准；试解不通过则保持 v1 标记原样。空仓（只有标记、
            // 没有任何备份）保持旧行为——第一台带密码上传的设备认领该 root。
            // 升级后配错密码的设备即可在上传前被拦截。
            None if marker.version <= 1 => {
                self.prove_password_against_existing_backups(password)
                    .await?;
                let verifier = crate::crypto::backup_crypto::create_password_verifier(password)
                    .map_err(|e| AppError::internal(format!("生成加密标记校验子失败: {e}")))?;
                let upgraded = EncryptionMarker {
                    version: ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
                    created_by_device: marker.created_by_device,
                    created_at: marker.created_at,
                    key_verifier: Some(verifier),
                };
                tracing::warn!(
                    "云端加密标记为旧版（无密码校验子），已用本机加密密码一次性升级到 v{}",
                    ENCRYPTION_MARKER_VERSION_WITH_VERIFIER
                );
                self.write_encryption_marker(&upgraded).await?;
                Ok(upgraded)
            }
            // version >= 2 却缺校验子：不是合法旧标记，视为被篡改/损坏，fail-closed。
            None => Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_MARKER_CORRUPTED_CODE,
                format!(
                    "云端加密标记版本为 {} 却缺少密码校验子，疑似损坏或被篡改，已在上传前中止\
                     （fail-closed）。请人工检查该云端目录后重试。",
                    marker.version
                ),
            ))),
        }
    }

    /// [R12-v1-trust] 升级旧版（v1）加密标记前，用本机密码对该 root 的既有
    /// 备份做一次试解密。
    ///
    /// v1 标记没有校验子，无法直接比对密码；但只要该 root 已有备份，「密码
    /// 与既有密文一致」就是可以当场验证的事实——先下载一份（取 manifest 的
    /// 最新版本）并用现有 DSBK 解密管线完整试解，通过后才允许把本机密码固化
    /// 进 v2 标记。任何一步失败（备份列表读不到、下载失败/半包、对象不是
    /// DSBK 密文、解密失败）都返回错误、保持 v1 标记原样（fail-closed），
    /// 持有正确密码的设备之后仍可完成升级。
    ///
    /// 空仓（只有 v1 标记、没有任何备份）没有可试解的对象：保持旧行为，
    /// 允许第一台带密码上传的设备认领该 root。
    async fn prove_password_against_existing_backups(&self, password: &str) -> Result<()> {
        let manifest = self.get_manifest().await.map_err(|error| {
            AppError::configuration(format!(
                "升级云端加密标记前需确认本机密码能解开既有备份，但读取云端备份列表失败：\
                 {error}。本次未改动加密标记，请稍后重试。"
            ))
        })?;

        let Some(version) = manifest
            .latest
            .as_ref()
            .and_then(|id| manifest.versions.iter().find(|v| &v.id == id))
            .or_else(|| manifest.versions.first())
        else {
            return Ok(());
        };

        let temp = tempfile::tempdir()
            .map_err(|e| AppError::file_system(format!("创建试解密临时目录失败: {e}")))?;
        let downloaded = self
            .download_with_progress(Some(&version.id), temp.path(), None)
            .await
            .map_err(|error| {
                AppError::configuration(format!(
                    "升级云端加密标记前需确认本机密码能解开既有备份，但下载最新备份 {} 失败：\
                     {error}。本次未改动加密标记，请稍后重试。",
                    version.id
                ))
            })?;

        // 完整试解到临时文件（spawn_blocking：Argon2 派生 + 全量解密是 CPU/IO
        // 密集操作）；输出只用于验证，随 TempDir 一并清理。
        let encrypted_path = std::path::PathBuf::from(&downloaded.local_path);
        let plaintext_path = temp.path().join(".trial-decrypt.tmp");
        let password_owned = password.to_string();
        let trial = tokio::task::spawn_blocking(move || {
            crate::crypto::backup_crypto::decrypt_backup_file(
                &encrypted_path,
                &plaintext_path,
                &password_owned,
            )
        })
        .await
        .map_err(|e| AppError::internal(format!("试解密任务执行失败: {e}")))?;

        trial.map_err(|error| {
            AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_WRONG_PASSWORD_CODE,
                format!(
                    "云端加密标记为旧版（无密码校验子），升级前用本机密码试解最新备份 {} 未通过：\
                     {error}。本次未改动加密标记，也未写入任何备份对象。请核对加密密码后重试；\
                     若确认密码无误，说明该备份由其他密码加密或已损坏，请人工检查该云端目录。",
                    version.id
                ),
            ))
        })?;

        Ok(())
    }

    /// 明文上传前置检查：该云 root 出现过加密备份（存在标记）时拒绝。
    ///
    /// [R10-verifier] 云端标记缺失时还要过本机记忆这道门：本机曾确认该目录
    /// 加密而云端标记现已消失（被删/丢失）的，同样拒绝明文上传（fail-closed），
    /// 不默许把明文混进曾经加密的恢复链。
    pub async fn ensure_plaintext_upload_allowed(&self) -> Result<()> {
        if self.read_encryption_marker().await?.is_some() {
            self.remember_encrypted_root();
            return Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
                "该云端目录已存在端到端加密备份，为避免明文/密文混布，已拒绝未加密上传。\
                 请在云存储配置里填写相同的加密密码后重试。",
            )));
        }
        if self.encrypted_root_remembered_locally() {
            return Err(AppError::configuration(super::sync_e2ee_error(
                super::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
                "本机记录显示该云端目录曾启用端到端加密，但云端的加密标记现已缺失（可能被删除）。\
                 为避免向同一目录混入未加密备份，已拒绝本次上传。请在云存储配置里填写原加密密码\
                 后重试；若确认要改用未加密备份，请换一个新的云端目录。",
            )));
        }
        Ok(())
    }

    /// 上传前的端到端加密一致性策略（bool 版，供拿不到密码原文的调用方使用）：
    /// - 本次上传加密：先幂等写入云端加密标记（失败则整个上传失败），
    ///   保证标记先于任何密文对象可见；
    /// - 本次上传明文：若该 root 已有加密标记则直接拒绝。
    ///
    /// 注意：本入口**不校验**密码一致性；能拿到密码原文的路径（如 ZIP 上传）
    /// 应改用 [`Self::enforce_encryption_policy_before_upload_with_password`]。
    pub async fn enforce_encryption_policy_before_upload(
        &self,
        encryption_enabled: bool,
    ) -> Result<()> {
        if encryption_enabled {
            self.persist_encryption_marker().await?;
            self.remember_encrypted_root();
            Ok(())
        } else {
            self.ensure_plaintext_upload_allowed().await
        }
    }

    /// [R06-e2ee-verifier] 上传前的端到端加密一致性策略（带密码校验）：
    /// - 有密码：校验 / 登记云端加密标记的不可逆密码校验子——配错密码的设备
    ///   在写入任何 `backups/` 对象之前即失败；
    /// - 无密码：若该 root 已有加密标记则直接拒绝明文上传。
    pub async fn enforce_encryption_policy_before_upload_with_password(
        &self,
        encryption_password: Option<&str>,
    ) -> Result<()> {
        match encryption_password {
            Some(password) => {
                self.verify_encryption_password_before_upload(password)
                    .await?;
                self.remember_encrypted_root();
                Ok(())
            }
            None => self.ensure_plaintext_upload_allowed().await,
        }
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
        Self::validate_version_id(&version_id)?;
        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);

        // 使用流式上传（自动计算 SHA256）
        let checksum = self
            .storage
            .put_file(&remote_key, zip_path, progress)
            .await?;
        if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            let _ = self.storage.delete(&remote_key).await;
            return Err(AppError::internal(
                "云存储 provider 返回了非法 SHA256，已拒绝发布版本".to_string(),
            ));
        }

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
        let mut manifest = match self.get_device_manifest().await {
            Ok(manifest) => manifest,
            Err(error) => {
                if let Err(cleanup_error) = self.storage.delete(&remote_key).await {
                    tracing::warn!(
                        "读取设备 manifest 失败后清理未引用对象 {} 失败: {}",
                        remote_key,
                        cleanup_error
                    );
                }
                return Err(error);
            }
        };
        manifest.versions.insert(0, version.clone());
        manifest.latest = Some(version_id);
        manifest.updated_at = now;

        // 先发布不再引用旧对象的 manifest，再做对象 GC。反过来执行会在 manifest
        // 发布失败或进程崩溃时留下“可见但已不可下载”的恢复点。
        let pruned = self.prune_versions(&mut manifest);
        if let Err(error) = self.save_manifest(&manifest).await {
            // 新对象尚未被任何已发布 manifest 引用，尽力回滚，避免长期孤儿。
            if let Err(cleanup_error) = self.storage.delete(&remote_key).await {
                tracing::warn!(
                    "manifest 发布失败后清理未引用对象 {} 失败: {}",
                    remote_key,
                    cleanup_error
                );
            }
            return Err(error);
        }
        for old in &pruned {
            let key = format!("{}/{}.zip", BACKUPS_DIR, old.id);
            if let Err(error) = self.storage.delete(&key).await {
                // manifest 已经安全发布；此时失败只会留下不可见孤儿，不会破坏恢复点。
                tracing::warn!("清理已裁剪云端对象 {} 失败: {}", old.id, error);
            }
        }

        Ok(UploadResult {
            version,
            pruned_versions: pruned.into_iter().map(|old| old.id).collect(),
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
        if let Some(version_id) = version_id {
            Self::validate_version_id(version_id)?;
        }
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
        Self::validate_version_id(&version.id)?;

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

        if self.storage.supports_resumable_download() {
            // [R09-restore-ops][P2-2] 断点续传下载：中断后保留 `.part` 断点文件，
            // 重试同一版本时从断点继续，多 GB 备份不再整包重下。
            // 完整性由完成后的整文件 SHA256 兜底（version.checksum 在上传时
            // 由流式哈希产生），断点错位/对象被改动都会在此被拒绝。
            let partial_path = Self::partial_download_path(local_dir, &version.id);
            let resume_from = match std::fs::symlink_metadata(&partial_path) {
                Ok(metadata)
                    if !metadata.file_type().is_symlink()
                        && metadata.is_file()
                        && metadata.len() > 0
                        && metadata.len() <= version.size =>
                {
                    tracing::info!(
                        "发现可续传断点: {:?}（{}/{} 字节）",
                        partial_path,
                        metadata.len(),
                        version.size
                    );
                    metadata.len()
                }
                Ok(_) => {
                    // 断点比云端对象还大 / 不是普通文件：断点无效，丢弃重下。
                    let _ = std::fs::remove_file(&partial_path);
                    0
                }
                Err(_) => 0,
            };

            // 失败时不清理断点文件：它正是下次续传的起点（与 ZIP 导入续传
            // 「失败不清理目标目录」同一模式）。
            self.storage
                .get_file_resumable(&remote_key, &partial_path, resume_from, progress)
                .await?;

            let actual_checksum = Self::hash_file_sha256(&partial_path).await?;
            if actual_checksum != version.checksum {
                // 断点文件与云端对象校验不符（断点损坏或对象被改动）：
                // 丢弃断点并明确失败，绝不把损坏文件交给恢复链。
                let _ = std::fs::remove_file(&partial_path);
                return Err(AppError::validation(format!(
                    "下载完成但 SHA256 校验失败（期望 {}，实际 {}）。断点文件已丢弃，请重试整包下载",
                    &version.checksum[..16.min(version.checksum.len())],
                    &actual_checksum[..16]
                )));
            }
            std::fs::rename(&partial_path, &local_path)
                .map_err(|e| AppError::file_system(format!("保存下载文件失败: {e}")))?;

            tracing::info!(
                "下载完成（断点续传路径, resume_from={}）: version={}, checksum={}",
                resume_from,
                version.id,
                &actual_checksum[..16]
            );
        } else {
            // 后端不支持断点续传：整文件下载（中断后只能整包重下，诚实且
            // 由 get_file 内部的 SHA256 校验兜底，绝不静默截断当成功）。
            let actual_checksum = self
                .storage
                .get_file(&remote_key, &local_path, Some(&version.checksum), progress)
                .await?;

            tracing::info!(
                "下载完成: version={}, checksum={}",
                version.id,
                &actual_checksum[..16]
            );
        }

        Ok(DownloadResult {
            version,
            local_path: local_path.to_string_lossy().to_string(),
        })
    }

    /// [R09-restore-ops][P2-2] 某个版本的断点下载文件路径。
    ///
    /// 以 `.` 开头、`.part` 结尾，与最终产物 `<id>.zip` 明确区分；版本 ID
    /// 已通过 `validate_version_id` 白名单校验，可安全拼入文件名。
    fn partial_download_path(local_dir: &Path, version_id: &str) -> std::path::PathBuf {
        local_dir.join(format!(".{version_id}.zip.part"))
    }

    /// 分块计算文件 SHA256（spawn_blocking，避免多 GB 文件哈希阻塞异步执行器）。
    async fn hash_file_sha256(path: &Path) -> Result<String> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<String> {
            use std::io::Read;
            let mut file = std::fs::File::open(&path)
                .map_err(|e| AppError::file_system(format!("打开下载文件做校验失败: {e}")))?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|e| AppError::file_system(format!("读取下载文件做校验失败: {e}")))?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| AppError::internal(format!("SHA256 校验任务失败: {e}")))?
    }

    /// 删除指定版本
    pub async fn delete_version(&self, version_id: &str) -> Result<()> {
        Self::validate_version_id(version_id)?;
        let mut manifest = self.get_device_manifest().await?;

        // 检查是否存在
        let idx = manifest
            .versions
            .iter()
            .position(|v| v.id == version_id)
            .ok_or_else(|| AppError::not_found("版本不存在"))?;

        // 先发布逻辑删除，再做对象 GC。这样发布失败时恢复点仍完整可用；对象删除
        // 失败时最多留下不可见孤儿，不会让 manifest 引用一个不存在的文件。
        manifest.versions.remove(idx);
        if manifest.latest.as_deref() == Some(version_id) {
            manifest.latest = manifest.versions.first().map(|v| v.id.clone());
        }
        manifest.updated_at = Utc::now();
        self.save_manifest(&manifest).await?;

        let remote_key = format!("{}/{}.zip", BACKUPS_DIR, version_id);
        if let Err(error) = self.storage.delete(&remote_key).await {
            tracing::warn!(
                "版本 {} 已从 manifest 移除，但对象 GC 失败，将保留为不可见孤儿: {}",
                version_id,
                error
            );
        }
        Ok(())
    }

    /// 清理旧版本，保留最近 N 个
    fn prune_versions(&self, manifest: &mut CloudManifest) -> Vec<BackupVersion> {
        let mut pruned = Vec::new();

        while manifest.versions.len() > self.max_versions {
            if let Some(old) = manifest.versions.pop() {
                pruned.push(old);
            }
        }

        pruned
    }

    /// 计算 SHA256 校验和
    fn calculate_checksum(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
}

/// 主路径文件名：`<app_data_dir>/.device_id`（与数据槽 `slots/` 同根）
const DEVICE_ID_FILE_NAME: &str = ".device_id";
/// 历史遗留：data_governance 早期把设备 ID 写在 `<app_data_dir>/device_id`
const LEGACY_ROOT_DEVICE_ID_FILE_NAME: &str = "device_id";

/// 设备 ID 主路径：Tauri 应用数据目录（与数据槽同根）。
///
/// 数据空间管理器在启动早期初始化；若尚未初始化（如纯单元测试进程），
/// 返回 None，调用方必须显式处理"无法持久化"这一事实。
fn primary_device_id_path() -> Option<std::path::PathBuf> {
    crate::data_space::get_data_space_manager()
        .map(|manager| manager.base_dir().join(DEVICE_ID_FILE_NAME))
}

/// 旧候选路径（只读迁移来源，按历史优先级排列）。
///
/// 包含旧 app 根文件 `device_id` 与早期写入的全局目录副本。这些路径不再
/// 作为新 ID 的写入目标，仅用于一次性迁移与轮换后的副本同步。
fn legacy_device_id_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(manager) = crate::data_space::get_data_space_manager() {
        paths.push(manager.base_dir().join(LEGACY_ROOT_DEVICE_ID_FILE_NAME));
    }
    for dir in [dirs::data_local_dir(), dirs::config_dir(), dirs::home_dir()]
        .into_iter()
        .flatten()
    {
        paths.push(dir.join("deep-student").join(DEVICE_ID_FILE_NAME));
    }
    paths
}

fn read_device_id_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(normalize_device_id(trimmed))
    }
}

/// 原子写入设备 ID（临时文件 + fsync + rename），避免半写文件产生残缺身份。
fn write_device_id_atomic(path: &Path, id: &str) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "device id path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(id.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn device_hostname() -> String {
    std::env::var("COMPUTERNAME") // Windows
        .or_else(|_| std::env::var("HOSTNAME")) // Linux/Unix
        .or_else(|_| std::env::var("HOST")) // macOS
        .unwrap_or_else(|_| "device".to_string())
}

#[derive(Debug)]
struct DeviceIdResolution {
    id: String,
    /// id 是否落在磁盘上（读自主路径/旧路径，或新生成后成功写入主路径）。
    persisted: bool,
}

/// 解析（或生成）设备 ID 的核心逻辑，路径全部注入以便测试。
///
/// 顺序：主路径 → 旧路径（命中即一次性迁移到主路径）→ 生成新 ID 并只写主路径。
/// 生成后写入失败时如实返回 `persisted: false`，不假装成功。
fn resolve_or_create_device_id(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
) -> DeviceIdResolution {
    if let Some(primary) = primary {
        if let Some(id) = read_device_id_file(primary) {
            return DeviceIdResolution {
                id,
                persisted: true,
            };
        }
    }

    for path in legacy {
        let Some(id) = read_device_id_file(path) else {
            continue;
        };
        // 一次性迁移到主路径。迁移失败不阻塞返回：旧路径仍可读，
        // 下次调用会重试迁移，身份本身不受影响。
        if let Some(primary) = primary {
            match write_device_id_atomic(primary, &id) {
                Ok(()) => tracing::info!(
                    "设备 ID 已从旧路径 {} 迁移到主路径 {}",
                    path.display(),
                    primary.display()
                ),
                Err(error) => tracing::warn!(
                    "设备 ID 迁移到主路径 {} 失败（旧路径仍可用，稍后重试）: {}",
                    primary.display(),
                    error
                ),
            }
        }
        return DeviceIdResolution {
            id,
            persisted: true,
        };
    }

    // 生成新的设备 ID（结合主机名以保证一定程度的可读性），只写主路径。
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let new_id = normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid));
    let persisted = match primary {
        Some(primary) => match write_device_id_atomic(primary, &new_id) {
            Ok(()) => {
                tracing::info!("新设备 ID 已保存到主路径: {}", primary.display());
                true
            }
            Err(error) => {
                tracing::error!(
                    "新设备 ID 写入主路径 {} 失败，无法持久化: {}",
                    primary.display(),
                    error
                );
                false
            }
        },
        None => {
            tracing::error!("应用数据目录尚未初始化，设备 ID 无法持久化");
            false
        }
    };
    DeviceIdResolution {
        id: new_id,
        persisted,
    }
}

/// 持久化失败时的进程级兜底身份。
///
/// 主路径不可写时不能"每次调用都生成新 ID 还假装成功"：那会让同一进程
/// 的上传以无数个一次性设备身份散落在云端。这里退化为进程内稳定的临时
/// 身份，并用 error 级日志显式暴露持久化失败。
static UNPERSISTED_DEVICE_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 获取或生成设备 ID
///
/// 优先级：
/// 1. 环境变量 DEVICE_ID
/// 2. 主路径 `<app_data_dir>/.device_id`（与数据槽同根）
/// 3. 旧路径一次性迁移：`<app_data_dir>/device_id`、
///    data_local_dir/config_dir/home_dir 下的 `deep-student/.device_id`
/// 4. 生成新 ID 并写入主路径；写入失败则退化为进程内稳定的临时 ID（记录 error 日志）
pub fn get_device_id() -> String {
    // 优先从环境变量获取
    if let Ok(id) = std::env::var("DEVICE_ID") {
        if !id.is_empty() {
            return normalize_device_id(&id);
        }
    }

    // 一旦进入过"持久化失败"状态，本进程内保持同一临时身份，避免身份漂移。
    if let Some(id) = UNPERSISTED_DEVICE_ID.get() {
        return id.clone();
    }

    let primary = primary_device_id_path();
    let resolution = resolve_or_create_device_id(primary.as_deref(), &legacy_device_id_paths());
    if resolution.persisted {
        resolution.id
    } else {
        UNPERSISTED_DEVICE_ID
            .get_or_init(|| {
                tracing::error!(
                    "设备 ID 持久化失败，本进程内使用临时设备 ID {}（重启后会变化，云端会出现新设备目录）",
                    resolution.id
                );
                resolution.id.clone()
            })
            .clone()
    }
}

/// 恢复备份后轮换设备 ID。
///
/// restore 会把本机数据回退到过去时间点；继续沿用旧 device_id 会触发
/// data_governance 的回声过滤，使旧身份在备份点之后上传过的变更永远不被本机重新消费。
/// 轮换后本机以“新设备”身份重新追赶旧设备目录。
pub fn generate_device_id_after_restore() -> String {
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid))
}

/// 把新身份写到主路径与仍存在的旧副本，路径注入以便测试。
///
/// - 主路径写入失败 → 直接返回错误，不假装成功。
/// - 旧副本仅在文件已存在时更新（防止降级/旧代码读到已被轮换掉的旧身份），
///   主路径已写成功时旧副本失败只降级为 warn。
/// - 主路径不可用（数据目录未初始化）时，退化为写第一个可写的旧路径。
fn persist_device_id_to_paths(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
    new_id: &str,
) -> std::io::Result<()> {
    if new_id.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "new device id must not be empty",
        ));
    }

    let mut primary_written = false;
    if let Some(primary) = primary {
        write_device_id_atomic(primary, new_id)?;
        primary_written = true;
    }

    let mut wrote_any = primary_written;
    for path in legacy {
        if !path.exists() {
            continue;
        }
        match write_device_id_atomic(path, new_id) {
            Ok(()) => wrote_any = true,
            Err(error) => {
                if primary_written {
                    tracing::warn!(
                        "更新旧设备 ID 副本 {} 失败（主路径已更新，读取仍以主路径为准）: {}",
                        path.display(),
                        error
                    );
                } else {
                    return Err(error);
                }
            }
        }
    }

    if !wrote_any {
        for path in legacy {
            if write_device_id_atomic(path, new_id).is_ok() {
                wrote_any = true;
                break;
            }
        }
    }
    if !wrote_any {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no writable device id location",
        ));
    }
    Ok(())
}

/// Persist a pre-generated restore identity. Supplying the identity from the
/// restore journal makes retries idempotent after a crash or partial I/O error.
pub fn persist_device_id_after_restore(new_id: &str) -> std::io::Result<()> {
    let primary = primary_device_id_path();
    persist_device_id_to_paths(primary.as_deref(), &legacy_device_id_paths(), new_id)?;
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

#[cfg(test)]
mod device_id_tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn primary_path_takes_precedence_over_legacy() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&primary, "primary-id");
        write(&legacy, "legacy-id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(resolution.id, "primary-id");
        assert!(resolution.persisted);
    }

    #[test]
    fn legacy_id_is_migrated_to_primary_once() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&legacy, "old-device");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy.clone()]);
        assert_eq!(resolution.id, "old-device");
        assert!(resolution.persisted);
        // 迁移后主路径持有同一身份；此后即使旧文件被改动也不再影响读取。
        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "old-device"
        );
        write(&legacy, "tampered");
        let second = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(second.id, "old-device");
    }

    #[test]
    fn legacy_candidates_are_consulted_in_priority_order() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let app_root_legacy = temp.path().join("device_id");
        let global_legacy = temp.path().join("deep-student").join(".device_id");
        write(&app_root_legacy, "app-root-id");
        write(&global_legacy, "global-id");

        let resolution =
            resolve_or_create_device_id(Some(&primary), &[app_root_legacy, global_legacy]);
        assert_eq!(resolution.id, "app-root-id");
    }

    #[test]
    fn generated_id_is_persisted_to_primary_and_stable_afterwards() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");

        let first = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(first.persisted, "新生成的 ID 必须成功写入主路径");
        assert!(!first.id.is_empty());
        assert_eq!(std::fs::read_to_string(&primary).unwrap().trim(), first.id);

        let second = resolve_or_create_device_id(Some(&primary), &[]);
        assert_eq!(second.id, first.id, "再次解析必须读回同一身份");
    }

    #[test]
    fn persist_failure_is_reported_instead_of_faked() {
        let temp = tempfile::tempdir().unwrap();
        // 用一个普通文件占住"父目录"位置，使 create_dir_all 必然失败。
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(
            !resolution.persisted,
            "主路径不可写时必须如实报告未持久化，而不是假装成功"
        );

        // 主路径完全缺失（数据目录未初始化）同样不能宣称已持久化。
        let resolution = resolve_or_create_device_id(None, &[]);
        assert!(!resolution.persisted);
    }

    #[test]
    fn persist_writes_primary_and_refreshes_existing_legacy_copies() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let stale_legacy = temp.path().join("device_id");
        let absent_legacy = temp.path().join("deep-student").join(".device_id");
        write(&stale_legacy, "old-identity");

        persist_device_id_to_paths(
            Some(&primary),
            &[stale_legacy.clone(), absent_legacy.clone()],
            "rotated-identity",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "rotated-identity"
        );
        // 已存在的旧副本必须同步更新，否则旧读取逻辑会复活轮换前的身份。
        assert_eq!(
            std::fs::read_to_string(&stale_legacy).unwrap().trim(),
            "rotated-identity"
        );
        // 不存在的旧路径不应被无谓创建。
        assert!(!absent_legacy.exists());
    }

    #[test]
    fn persist_fails_when_primary_is_unwritable() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");
        let legacy: Vec<PathBuf> = vec![temp.path().join("device_id")];

        let error =
            persist_device_id_to_paths(Some(&primary), &legacy, "new-identity").unwrap_err();
        assert!(!legacy[0].exists(), "主路径失败时不应留下部分写入");
        let _ = error;
    }

    #[test]
    fn persist_falls_back_to_legacy_when_primary_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("deep-student").join(".device_id");

        persist_device_id_to_paths(None, &[legacy.clone()], "fallback-identity").unwrap();
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap().trim(),
            "fallback-identity"
        );
    }

    #[test]
    fn persist_rejects_empty_identity() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        assert!(persist_device_id_to_paths(Some(&primary), &[], "  ").is_err());
    }

    #[test]
    fn read_device_id_file_normalizes_and_rejects_blank() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".device_id");

        write(&path, "  spaced-id \n");
        assert_eq!(read_device_id_file(&path).unwrap(), "spaced-id");

        write(&path, "   \n");
        assert_eq!(read_device_id_file(&path), None);

        // 非法字符会被 normalize 成稳定哈希，而不是原样进入云端路径。
        write(&path, "../evil");
        let normalized = read_device_id_file(&path).unwrap();
        assert!(normalized.starts_with("device-"));
    }
}

#[cfg(test)]
mod tests {
    use super::super::traits::FileInfo;
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryStorage {
        files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    }

    #[async_trait]
    impl CloudStorage for Arc<MemoryStorage> {
        fn provider_name(&self) -> &'static str {
            "memory"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data.to_vec(), Utc::now()));
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, _)| data.clone()))
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            let mut files: Vec<FileInfo> = self
                .files
                .lock()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.starts_with(prefix))
                .map(|(key, (data, modified))| FileInfo {
                    key: key.clone(),
                    size: data.len() as u64,
                    last_modified: *modified,
                    etag: None,
                })
                .collect();
            files.sort_by(|left, right| right.last_modified.cmp(&left.last_modified));
            Ok(files)
        }

        async fn delete(&self, key: &str) -> Result<()> {
            self.files.lock().unwrap().remove(key);
            Ok(())
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, modified)| FileInfo {
                    key: key.to_string(),
                    size: data.len() as u64,
                    last_modified: *modified,
                    etag: None,
                }))
        }
    }

    fn manager_on(storage: &Arc<MemoryStorage>, device_id: &str) -> CloudSyncManager {
        CloudSyncManager::new(Box::new(Arc::clone(storage)), device_id.to_string())
    }

    #[tokio::test]
    async fn plaintext_upload_allowed_without_marker() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");

        assert!(manager.read_encryption_marker().await.unwrap().is_none());
        manager
            .enforce_encryption_policy_before_upload(false)
            .await
            .expect("无标记时明文上传应放行");
    }

    #[tokio::test]
    async fn plaintext_upload_rejected_when_marker_present() {
        let storage = Arc::new(MemoryStorage::default());

        // 另一台设备曾经加密上传，在该 root 留下标记
        let other_device = manager_on(&storage, "device-a");
        other_device.persist_encryption_marker().await.unwrap();

        // 本机未配置 encryption_password：cloud_sync_upload 会先执行策略检查，
        // 检查失败即 upload 失败（不会有任何对象被写入 backups/）。
        let manager = manager_on(&storage, "device-b");
        let error = manager
            .enforce_encryption_policy_before_upload(false)
            .await
            .expect_err("有加密标记且无密码时必须拒绝明文上传");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE),
            "明文上传拒绝必须带稳定 code: {error}"
        );
        assert!(
            error.to_string().contains("加密"),
            "错误应提示需要加密密码: {error}"
        );
        assert!(
            !storage
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "被拒绝的明文上传不应产生任何备份对象"
        );
        // 标记本身保持不变
        let marker = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(marker.created_by_device, "device-a");
    }

    #[tokio::test]
    async fn encrypted_upload_succeeds_and_keeps_marker() {
        let storage = Arc::new(MemoryStorage::default());
        let manager = manager_on(&storage, "device-a");

        // 配置了密码：首次上传登记带校验子的 v2 标记后放行
        manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw-2026"))
            .await
            .expect("有密码时上传前策略应放行");
        let first = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(first.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert_eq!(first.created_by_device, "device-a");
        assert!(
            first.key_verifier.is_some(),
            "新登记的标记必须携带密码校验子"
        );

        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("backup.dsbk");
        std::fs::write(&zip, b"DSBK pretend-encrypted payload").unwrap();
        let result = manager
            .upload(&zip, Some("1.0.0".into()), None)
            .await
            .expect("加密上传应成功");
        assert_eq!(result.version.device_id, "device-a");

        // 同密码再次加密上传：标记保持（不被覆盖，首次写入者信息与校验子不变）
        manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw-2026"))
            .await
            .unwrap();
        let second = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.created_by_device, first.created_by_device);
        assert_eq!(second.key_verifier, first.key_verifier);
    }

    /// [R06] 核心场景：配错密码的设备必须在上传前失败，且不向 backups/ 写入任何对象。
    #[tokio::test]
    async fn wrong_password_upload_rejected_before_any_backup_write() {
        let storage = Arc::new(MemoryStorage::default());

        // 设备 A 用正确密码登记了带校验子的标记
        let device_a = manager_on(&storage, "device-a");
        device_a
            .enforce_encryption_policy_before_upload_with_password(Some("correct-pw"))
            .await
            .unwrap();
        let original = device_a.read_encryption_marker().await.unwrap().unwrap();

        // 设备 B 配了错误密码：cloud_sync_upload 会先执行本策略，失败即整个上传失败
        let device_b = manager_on(&storage, "device-b");
        let error = device_b
            .enforce_encryption_policy_before_upload_with_password(Some("wrong-pw"))
            .await
            .expect_err("错误密码必须在上传前被拦截");
        assert!(
            error.to_string().contains("不一致"),
            "错误信息应指出密码不一致: {error}"
        );

        // 不得向 backups/ 写入任何对象，标记也不得被改写
        assert!(
            !storage
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(BACKUPS_DIR)),
            "被拦截的错密码上传不应产生任何备份对象"
        );
        let after = device_b.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(after.created_by_device, original.created_by_device);
        assert_eq!(after.key_verifier, original.key_verifier);
    }

    /// [R06] 兼容性：旧版无校验子标记（version 1）被第一个带密码上传的设备
    /// 一次性升级；升级保留首次写入者与时间，升级后错密码设备即被拦截。
    #[tokio::test]
    async fn legacy_marker_without_verifier_is_upgraded_once() {
        let storage = Arc::new(MemoryStorage::default());

        // 旧版本应用留下的 v1 标记（无校验子）
        let legacy_writer = manager_on(&storage, "device-legacy");
        let legacy = legacy_writer.persist_encryption_marker().await.unwrap();
        assert_eq!(legacy.version, 1);
        assert!(legacy.key_verifier.is_none());

        // 升级后的应用带密码上传：一次性升级标记
        let device_a = manager_on(&storage, "device-a");
        let upgraded = device_a
            .verify_encryption_password_before_upload("team-pw")
            .await
            .expect("旧标记应被一次性升级而不是拒绝");
        assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
        assert_eq!(
            upgraded.created_by_device, "device-legacy",
            "升级不得改写首次写入者"
        );
        assert_eq!(
            upgraded.created_at, legacy.created_at,
            "升级不得改写首次写入时间"
        );
        assert!(upgraded.key_verifier.is_some());

        // 升级后：同密码放行、错密码被拦
        device_a
            .verify_encryption_password_before_upload("team-pw")
            .await
            .expect("同密码应继续放行");
        let device_b = manager_on(&storage, "device-b");
        assert!(
            device_b
                .verify_encryption_password_before_upload("other-pw")
                .await
                .is_err(),
            "升级后错密码设备必须被拦截"
        );
    }

    /// [R06] 标记内容损坏时加密上传也 fail-closed（无法确认密码一致性）。
    #[tokio::test]
    async fn corrupted_marker_blocks_encrypted_upload() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (b"not-json".to_vec(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .enforce_encryption_policy_before_upload_with_password(Some("pw"))
            .await
            .expect_err("损坏标记必须拦截加密上传（fail-closed）");
        assert!(error.to_string().contains("损坏"), "{error}");

        // fail-closed 路径不得改写（掩盖）损坏的标记内容
        let raw = storage
            .files
            .lock()
            .unwrap()
            .get(ENCRYPTION_MARKER_FILE)
            .unwrap()
            .0
            .clone();
        assert_eq!(raw, b"not-json".to_vec());
    }

    /// [R06] 未知 KDF（可能来自更新版本应用）不能被当作旧标记升级覆盖，必须 fail-closed。
    #[tokio::test]
    async fn unknown_verifier_kdf_fails_closed() {
        let storage = Arc::new(MemoryStorage::default());
        let marker_json = serde_json::json!({
            "version": ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
            "createdByDevice": "device-future",
            "createdAt": Utc::now(),
            "keyVerifier": {
                "kdf": "quantum-kdf-9000",
                "mCost": 65536,
                "tCost": 3,
                "pCost": 4,
                "salt": "00112233445566778899aabbccddeeff",
                "digest": "00".repeat(32),
            }
        });
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (serde_json::to_vec(&marker_json).unwrap(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("pw")
            .await
            .expect_err("未知 KDF 必须 fail-closed");
        assert!(error.to_string().contains("无法校验"), "{error}");

        // 标记不得被覆盖（否则会破坏未来版本设备的校验依据）
        let after = manager.read_encryption_marker().await.unwrap().unwrap();
        assert_eq!(after.created_by_device, "device-future");
    }

    /// [R06] version >= 2 却缺校验子：不是合法旧标记，按损坏处理，不得走升级路径。
    #[tokio::test]
    async fn v2_marker_missing_verifier_fails_closed() {
        let storage = Arc::new(MemoryStorage::default());
        let marker_json = serde_json::json!({
            "version": ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
            "createdByDevice": "device-x",
            "createdAt": Utc::now(),
        });
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (serde_json::to_vec(&marker_json).unwrap(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        let error = manager
            .verify_encryption_password_before_upload("pw")
            .await
            .expect_err("v2 缺校验子必须 fail-closed 而不是被静默升级");
        assert!(
            error
                .to_string()
                .contains(crate::cloud_storage::SYNC_E2EE_MARKER_CORRUPTED_CODE),
            "v2 缺校验子必须带稳定 code: {error}"
        );
        assert!(error.to_string().contains("缺少密码校验子"), "{error}");
    }

    #[tokio::test]
    async fn corrupted_marker_still_blocks_plaintext_upload() {
        let storage = Arc::new(MemoryStorage::default());
        storage.files.lock().unwrap().insert(
            ENCRYPTION_MARKER_FILE.to_string(),
            (b"not-json".to_vec(), Utc::now()),
        );

        let manager = manager_on(&storage, "device-a");
        assert!(
            manager.ensure_plaintext_upload_allowed().await.is_err(),
            "标记损坏时必须 fail-closed，拒绝明文上传"
        );
    }
}
