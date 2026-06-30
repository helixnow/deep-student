//! # Tombstone 清单
//!
//! 解决"一端删除，另一端不删"问题。
//!
//! 文件型同步（VFS blobs / 资产目录 / 工作区数据库）原本只做"本地有→上传、云端有→下载"，
//! 没有删除传播：A 删掉一张图，下次同步会从云端把图拉回 A。
//!
//! ## 实现思路（内容寻址不破坏，按需最小增量）
//!
//! 每种文件类型按设备维护"已删除清单"文件到云端：
//! - `data_governance/tombstones/blobs/{device_id}.json`
//! - `data_governance/tombstones/assets/{device_id}.json`
//! - `data_governance/tombstones/workspaces/{device_id}.json`
//!
//! 旧版共享文件 `data_governance/tombstones/{blobs,assets,workspaces}.json`
//! 仍会只读合并，保证升级前已写入的删除不会丢。
//!
//! 每轮同步：
//! 1. 下载三份 tombstones 清单并合并
//! 2. 本地删除后显式调用 `mark_blob_deleted / mark_asset_deleted / mark_workspace_deleted`
//!    添加新记录
//! 3. 同步上传/下载文件之前：先按 tombstones 剔除云端清单里已被"删除标记"的条目，
//!    同时把本地对应文件删除
//!
//! 保留期：tombstone 默认保留 90 天，期满由 `prune_tombstones()` 清理。
//! 90 天窗口覆盖"设备长期离线→上线"仍能感知删除。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{parse_flexible_timestamp_public, SyncError};
use crate::cloud_storage::CloudStorage;

/// Payload 编解码能力（P0-2 修复引入）
///
/// Tombstone 模块里的上传/下载函数原先直通明文字节。现在让这几个函数
/// 接受一个实现了 `PayloadCodec` 的对象（目前由 `SyncManager` 实现），
/// 使得 tombstone 清单也能透明享受 E2EE。
///
/// 这样避免了让 tombstone 模块直接依赖 `SyncManager`，保留模块边界。
///
/// 要求 `Send + Sync`：`SyncManager` 里的方法都是异步，codec trait object
/// 会跨 `.await` 存活；Tauri 命令调度需要 `Future: Send`，所以 trait object
/// 也必须 `Send + Sync`。
pub trait PayloadCodec: Send + Sync {
    /// 把明文 JSON 字节编码为上传格式（若未启用加密则原样返回）
    fn encode(&self, plaintext: &[u8]) -> Result<Vec<u8>, SyncError>;
    /// 把下载字节解码为明文（自动识别 DSBK 魔数；未加密数据原样返回）
    fn decode(&self, data: &[u8]) -> Result<Vec<u8>, SyncError>;
}

/// 提供一个永不加密的实现，用于单元测试与向后兼容场景。
pub struct PlainCodec;
impl PayloadCodec for PlainCodec {
    fn encode(&self, plaintext: &[u8]) -> Result<Vec<u8>, SyncError> {
        Ok(plaintext.to_vec())
    }
    fn decode(&self, data: &[u8]) -> Result<Vec<u8>, SyncError> {
        Ok(data.to_vec())
    }
}

pub const LEGACY_BLOB_TOMBSTONE_KEY: &str = "data_governance/tombstones/blobs.json";
pub const LEGACY_ASSET_TOMBSTONE_KEY: &str = "data_governance/tombstones/assets.json";
pub const LEGACY_WS_TOMBSTONE_KEY: &str = "data_governance/tombstones/workspaces.json";

pub const BLOB_TOMBSTONE_PREFIX: &str = "data_governance/tombstones/blobs/";
pub const ASSET_TOMBSTONE_PREFIX: &str = "data_governance/tombstones/assets/";
pub const WS_TOMBSTONE_PREFIX: &str = "data_governance/tombstones/workspaces/";

/// tombstone 保留天数（默认 90 天）
pub const DEFAULT_TOMBSTONE_RETENTION_DAYS: u64 = 90;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobTombstoneEntry {
    pub deleted_at: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BlobTombstones {
    #[serde(default)]
    pub entries: HashMap<String, BlobTombstoneEntry>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetTombstoneEntry {
    pub deleted_at: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetTombstones {
    #[serde(default)]
    pub entries: HashMap<String, AssetTombstoneEntry>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTombstoneEntry {
    pub deleted_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceTombstones {
    #[serde(default)]
    pub entries: HashMap<String, WorkspaceTombstoneEntry>,
    #[serde(default)]
    pub updated_at: String,
}

fn device_component(device_id: &str) -> String {
    let cleaned = device_id
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "unknown-device".to_string()
    } else {
        cleaned
    }
}

pub fn blob_device_tombstone_key(device_id: &str) -> String {
    format!(
        "{}{}.json",
        BLOB_TOMBSTONE_PREFIX,
        device_component(device_id)
    )
}

pub fn asset_device_tombstone_key(device_id: &str) -> String {
    format!(
        "{}{}.json",
        ASSET_TOMBSTONE_PREFIX,
        device_component(device_id)
    )
}

pub fn workspace_device_tombstone_key(device_id: &str) -> String {
    format!(
        "{}{}.json",
        WS_TOMBSTONE_PREFIX,
        device_component(device_id)
    )
}

fn deleted_at_is_newer(candidate: &str, current: &str) -> bool {
    match (
        parse_flexible_timestamp_public(candidate),
        parse_flexible_timestamp_public(current),
    ) {
        (Some(a), Some(b)) => a > b,
        _ => candidate > current,
    }
}

fn merge_updated_at(current: &mut String, candidate: &str) {
    if current.is_empty() || deleted_at_is_newer(candidate, current) {
        *current = candidate.to_string();
    }
}

fn merge_blob_tombstones(dst: &mut BlobTombstones, src: BlobTombstones) {
    merge_updated_at(&mut dst.updated_at, &src.updated_at);
    for (hash, entry) in src.entries {
        let should_replace = dst
            .entries
            .get(&hash)
            .map(|existing| deleted_at_is_newer(&entry.deleted_at, &existing.deleted_at))
            .unwrap_or(true);
        if should_replace {
            dst.entries.insert(hash, entry);
        }
    }
}

fn merge_asset_tombstones(dst: &mut AssetTombstones, src: AssetTombstones) {
    merge_updated_at(&mut dst.updated_at, &src.updated_at);
    for (key, entry) in src.entries {
        let should_replace = dst
            .entries
            .get(&key)
            .map(|existing| deleted_at_is_newer(&entry.deleted_at, &existing.deleted_at))
            .unwrap_or(true);
        if should_replace {
            dst.entries.insert(key, entry);
        }
    }
}

fn merge_workspace_tombstones(dst: &mut WorkspaceTombstones, src: WorkspaceTombstones) {
    merge_updated_at(&mut dst.updated_at, &src.updated_at);
    for (ws_id, entry) in src.entries {
        let should_replace = dst
            .entries
            .get(&ws_id)
            .map(|existing| deleted_at_is_newer(&entry.deleted_at, &existing.deleted_at))
            .unwrap_or(true);
        if should_replace {
            dst.entries.insert(ws_id, entry);
        }
    }
}

pub fn path_modified_after(path: &Path, timestamp: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let modified: chrono::DateTime<Utc> = modified.into();
    parse_flexible_timestamp_public(timestamp)
        .map(|ts| modified > ts)
        .unwrap_or(false)
}

/// [P2 fail-close] 解密失败必须硬错误，与设备清单/变更文件路径口径一致。
/// fail-open 的两类危害：
/// - 消费路径把"解不开"当"无 tombstone"，删除静默不传播；
/// - `mark_*` 写入路径拿到空清单后整体覆盖云端，丢失该设备全部历史 tombstone。
///
/// JSON 损坏（非密码问题）仍保留 warn + 跳过。
fn decode_tombstone_file<T: serde::de::DeserializeOwned>(
    codec: &dyn PayloadCodec,
    bytes: &[u8],
    label: &str,
) -> Result<Option<T>, SyncError> {
    let decoded = codec.decode(bytes).map_err(|e| {
        SyncError::Database(format!(
            "{} tombstone 清单无法解密，已停止同步（请检查加密密码）: {}",
            label, e
        ))
    })?;
    match serde_json::from_slice::<T>(&decoded) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            tracing::warn!("[sync] {} tombstone 清单损坏，忽略: {}", label, e);
            Ok(None)
        }
    }
}

async fn list_tombstone_keys(
    storage: &dyn CloudStorage,
    prefix: &str,
    label: &str,
) -> Result<Vec<String>, SyncError> {
    let outcome = storage
        .list_outcome(prefix)
        .await
        .map_err(|e| SyncError::Network(format!("列举 {} tombstone 失败: {}", label, e)))?;
    if outcome.truncated {
        return Err(SyncError::Network(format!(
            "{} tombstone 列表被截断，拒绝推进同步",
            label
        )));
    }
    Ok(outcome
        .files
        .into_iter()
        .map(|f| f.key)
        .filter(|key| key.starts_with(prefix) && key.ends_with(".json"))
        .collect())
}

#[derive(Debug, Clone)]
pub struct TombstoneWatermarkAdvance {
    pub source_device_id: String,
    pub last_applied_offset: u64,
}

fn source_device_from_tombstone_key(prefix: &str, key: &str) -> String {
    key.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(".json"))
        .filter(|rest| !rest.trim().is_empty())
        .unwrap_or("unknown-device")
        .to_string()
}

fn tombstone_offset_from_deleted_at(deleted_at: &str) -> u64 {
    parse_flexible_timestamp_public(deleted_at)
        .map(|dt| dt.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}

fn filter_blob_tombstones_after(manifest: BlobTombstones, watermark: u64) -> (BlobTombstones, u64) {
    let mut filtered = BlobTombstones {
        entries: HashMap::new(),
        updated_at: manifest.updated_at,
    };
    let mut max_offset = watermark;
    for (hash, entry) in manifest.entries {
        let offset = tombstone_offset_from_deleted_at(&entry.deleted_at);
        if offset > watermark {
            max_offset = max_offset.max(offset);
            filtered.entries.insert(hash, entry);
        }
    }
    (filtered, max_offset)
}

fn filter_asset_tombstones_after(
    manifest: AssetTombstones,
    watermark: u64,
) -> (AssetTombstones, u64) {
    let mut filtered = AssetTombstones {
        entries: HashMap::new(),
        updated_at: manifest.updated_at,
    };
    let mut max_offset = watermark;
    for (key, entry) in manifest.entries {
        let offset = tombstone_offset_from_deleted_at(&entry.deleted_at);
        if offset > watermark {
            max_offset = max_offset.max(offset);
            filtered.entries.insert(key, entry);
        }
    }
    (filtered, max_offset)
}

fn filter_workspace_tombstones_after(
    manifest: WorkspaceTombstones,
    watermark: u64,
) -> (WorkspaceTombstones, u64) {
    let mut filtered = WorkspaceTombstones {
        entries: HashMap::new(),
        updated_at: manifest.updated_at,
    };
    let mut max_offset = watermark;
    for (ws_id, entry) in manifest.entries {
        let offset = tombstone_offset_from_deleted_at(&entry.deleted_at);
        if offset > watermark {
            max_offset = max_offset.max(offset);
            filtered.entries.insert(ws_id, entry);
        }
    }
    (filtered, max_offset)
}

/// 从云端下载一份 tombstone 清单
///
/// 新增 `codec` 参数（P0-2）：负责上下行透明 encode/decode。传 `&PlainCodec` 即保留
/// 原明文行为；传 `&SyncManager` 则在有密码时走 DSBK 容器加解密。
pub async fn download_blob_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<BlobTombstones, SyncError> {
    let mut merged = BlobTombstones::default();
    if let Some(bytes) = storage
        .get(LEGACY_BLOB_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 legacy blob tombstone 清单失败: {}", e)))?
    {
        if let Some(manifest) =
            decode_tombstone_file::<BlobTombstones>(codec, &bytes, "legacy blob")?
        {
            merge_blob_tombstones(&mut merged, manifest);
        }
    }

    for key in list_tombstone_keys(storage, BLOB_TOMBSTONE_PREFIX, "blob").await? {
        if let Some(bytes) = storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("获取 blob tombstone {} 失败: {}", key, e)))?
        {
            if let Some(manifest) = decode_tombstone_file::<BlobTombstones>(codec, &bytes, "blob")? {
                merge_blob_tombstones(&mut merged, manifest);
            }
        }
    }
    Ok(merged)
}

pub async fn download_blob_tombstones_after<F>(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut watermark_for: F,
) -> Result<(BlobTombstones, Vec<TombstoneWatermarkAdvance>), SyncError>
where
    F: FnMut(&str) -> Result<u64, SyncError>,
{
    let mut merged = BlobTombstones::default();
    let mut advances = Vec::new();

    if let Some(bytes) = storage
        .get(LEGACY_BLOB_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 legacy blob tombstone 清单失败: {}", e)))?
    {
        if let Some(manifest) =
            decode_tombstone_file::<BlobTombstones>(codec, &bytes, "legacy blob")?
        {
            let source = "legacy".to_string();
            let watermark = watermark_for(&source)?;
            let (filtered, max_offset) = filter_blob_tombstones_after(manifest, watermark);
            if max_offset > watermark {
                advances.push(TombstoneWatermarkAdvance {
                    source_device_id: source,
                    last_applied_offset: max_offset,
                });
            }
            merge_blob_tombstones(&mut merged, filtered);
        }
    }

    for key in list_tombstone_keys(storage, BLOB_TOMBSTONE_PREFIX, "blob").await? {
        if let Some(bytes) = storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("获取 blob tombstone {} 失败: {}", key, e)))?
        {
            if let Some(manifest) = decode_tombstone_file::<BlobTombstones>(codec, &bytes, "blob")? {
                let source = source_device_from_tombstone_key(BLOB_TOMBSTONE_PREFIX, &key);
                let watermark = watermark_for(&source)?;
                let (filtered, max_offset) = filter_blob_tombstones_after(manifest, watermark);
                if max_offset > watermark {
                    advances.push(TombstoneWatermarkAdvance {
                        source_device_id: source,
                        last_applied_offset: max_offset,
                    });
                }
                merge_blob_tombstones(&mut merged, filtered);
            }
        }
    }

    Ok((merged, advances))
}

pub async fn download_blob_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<BlobTombstones, SyncError> {
    let key = blob_device_tombstone_key(device_id);
    match storage
        .get(&key)
        .await
        .map_err(|e| SyncError::Network(format!("获取本机 blob tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => Ok(
            decode_tombstone_file::<BlobTombstones>(codec, &bytes, "local blob")?
                .unwrap_or_default(),
        ),
        None => Ok(BlobTombstones::default()),
    }
}

pub async fn download_asset_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<AssetTombstones, SyncError> {
    let mut merged = AssetTombstones::default();
    if let Some(bytes) = storage
        .get(LEGACY_ASSET_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 legacy asset tombstone 清单失败: {}", e)))?
    {
        if let Some(manifest) =
            decode_tombstone_file::<AssetTombstones>(codec, &bytes, "legacy asset")?
        {
            merge_asset_tombstones(&mut merged, manifest);
        }
    }

    for key in list_tombstone_keys(storage, ASSET_TOMBSTONE_PREFIX, "asset").await? {
        if let Some(bytes) = storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("获取 asset tombstone {} 失败: {}", key, e)))?
        {
            if let Some(manifest) =
                decode_tombstone_file::<AssetTombstones>(codec, &bytes, "asset")?
            {
                merge_asset_tombstones(&mut merged, manifest);
            }
        }
    }
    Ok(merged)
}

pub async fn download_asset_tombstones_after<F>(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut watermark_for: F,
) -> Result<(AssetTombstones, Vec<TombstoneWatermarkAdvance>), SyncError>
where
    F: FnMut(&str) -> Result<u64, SyncError>,
{
    let mut merged = AssetTombstones::default();
    let mut advances = Vec::new();

    if let Some(bytes) = storage
        .get(LEGACY_ASSET_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 legacy asset tombstone 清单失败: {}", e)))?
    {
        if let Some(manifest) =
            decode_tombstone_file::<AssetTombstones>(codec, &bytes, "legacy asset")?
        {
            let source = "legacy".to_string();
            let watermark = watermark_for(&source)?;
            let (filtered, max_offset) = filter_asset_tombstones_after(manifest, watermark);
            if max_offset > watermark {
                advances.push(TombstoneWatermarkAdvance {
                    source_device_id: source,
                    last_applied_offset: max_offset,
                });
            }
            merge_asset_tombstones(&mut merged, filtered);
        }
    }

    for key in list_tombstone_keys(storage, ASSET_TOMBSTONE_PREFIX, "asset").await? {
        if let Some(bytes) = storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("获取 asset tombstone {} 失败: {}", key, e)))?
        {
            if let Some(manifest) =
                decode_tombstone_file::<AssetTombstones>(codec, &bytes, "asset")?
            {
                let source = source_device_from_tombstone_key(ASSET_TOMBSTONE_PREFIX, &key);
                let watermark = watermark_for(&source)?;
                let (filtered, max_offset) = filter_asset_tombstones_after(manifest, watermark);
                if max_offset > watermark {
                    advances.push(TombstoneWatermarkAdvance {
                        source_device_id: source,
                        last_applied_offset: max_offset,
                    });
                }
                merge_asset_tombstones(&mut merged, filtered);
            }
        }
    }

    Ok((merged, advances))
}

pub async fn download_asset_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<AssetTombstones, SyncError> {
    let key = asset_device_tombstone_key(device_id);
    match storage
        .get(&key)
        .await
        .map_err(|e| SyncError::Network(format!("获取本机 asset tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => Ok(
            decode_tombstone_file::<AssetTombstones>(codec, &bytes, "local asset")?
                .unwrap_or_default(),
        ),
        None => Ok(AssetTombstones::default()),
    }
}

pub async fn download_workspace_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<WorkspaceTombstones, SyncError> {
    let mut merged = WorkspaceTombstones::default();
    if let Some(bytes) = storage.get(LEGACY_WS_TOMBSTONE_KEY).await.map_err(|e| {
        SyncError::Network(format!("获取 legacy workspace tombstone 清单失败: {}", e))
    })? {
        if let Some(manifest) =
            decode_tombstone_file::<WorkspaceTombstones>(codec, &bytes, "legacy workspace")?
        {
            merge_workspace_tombstones(&mut merged, manifest);
        }
    }

    for key in list_tombstone_keys(storage, WS_TOMBSTONE_PREFIX, "workspace").await? {
        if let Some(bytes) = storage.get(&key).await.map_err(|e| {
            SyncError::Network(format!("获取 workspace tombstone {} 失败: {}", key, e))
        })? {
            if let Some(manifest) =
                decode_tombstone_file::<WorkspaceTombstones>(codec, &bytes, "workspace")?
            {
                merge_workspace_tombstones(&mut merged, manifest);
            }
        }
    }
    Ok(merged)
}

pub async fn download_workspace_tombstones_after<F>(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut watermark_for: F,
) -> Result<(WorkspaceTombstones, Vec<TombstoneWatermarkAdvance>), SyncError>
where
    F: FnMut(&str) -> Result<u64, SyncError>,
{
    let mut merged = WorkspaceTombstones::default();
    let mut advances = Vec::new();

    if let Some(bytes) = storage.get(LEGACY_WS_TOMBSTONE_KEY).await.map_err(|e| {
        SyncError::Network(format!("获取 legacy workspace tombstone 清单失败: {}", e))
    })? {
        if let Some(manifest) =
            decode_tombstone_file::<WorkspaceTombstones>(codec, &bytes, "legacy workspace")?
        {
            let source = "legacy".to_string();
            let watermark = watermark_for(&source)?;
            let (filtered, max_offset) = filter_workspace_tombstones_after(manifest, watermark);
            if max_offset > watermark {
                advances.push(TombstoneWatermarkAdvance {
                    source_device_id: source,
                    last_applied_offset: max_offset,
                });
            }
            merge_workspace_tombstones(&mut merged, filtered);
        }
    }

    for key in list_tombstone_keys(storage, WS_TOMBSTONE_PREFIX, "workspace").await? {
        if let Some(bytes) = storage.get(&key).await.map_err(|e| {
            SyncError::Network(format!("获取 workspace tombstone {} 失败: {}", key, e))
        })? {
            if let Some(manifest) =
                decode_tombstone_file::<WorkspaceTombstones>(codec, &bytes, "workspace")?
            {
                let source = source_device_from_tombstone_key(WS_TOMBSTONE_PREFIX, &key);
                let watermark = watermark_for(&source)?;
                let (filtered, max_offset) = filter_workspace_tombstones_after(manifest, watermark);
                if max_offset > watermark {
                    advances.push(TombstoneWatermarkAdvance {
                        source_device_id: source,
                        last_applied_offset: max_offset,
                    });
                }
                merge_workspace_tombstones(&mut merged, filtered);
            }
        }
    }

    Ok((merged, advances))
}

pub async fn download_workspace_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<WorkspaceTombstones, SyncError> {
    let key = workspace_device_tombstone_key(device_id);
    match storage
        .get(&key)
        .await
        .map_err(|e| SyncError::Network(format!("获取本机 workspace tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => {
            Ok(
                decode_tombstone_file::<WorkspaceTombstones>(codec, &bytes, "local workspace")?
                    .unwrap_or_default(),
            )
        }
        None => Ok(WorkspaceTombstones::default()),
    }
}

/// 上传 tombstone 清单（仅在有新增时调用）
pub async fn upload_blob_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    mut manifest: BlobTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 blob tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = blob_device_tombstone_key(device_id);
    storage
        .put(&key, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传 blob tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_asset_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    mut manifest: AssetTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 asset tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = asset_device_tombstone_key(device_id);
    storage
        .put(&key, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传 asset tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_workspace_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    mut manifest: WorkspaceTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 workspace tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = workspace_device_tombstone_key(device_id);
    storage
        .put(&key, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传 workspace tombstone 失败: {}", e)))?;
    Ok(())
}

/// 将一批 tombstone 应用到云端清单 + 本地文件：
/// - 云端 blob 被删除（尽力删，失败只告警）
/// - 本地 blob 目录下对应文件一并删除
///   - 优先用 `relative_path`（由上传端在 tombstone 元数据里提供）
///   - 如果没有，尝试 `scan_blobs_dir` 风格的本地扫描（按 hash 前缀分桶查找）
/// - 返回本次实际影响的 hash 列表
pub async fn apply_blob_tombstones(
    storage: &dyn CloudStorage,
    tombstones: &BlobTombstones,
    blobs_dir: &Path,
    blobs_cloud_prefix: &str,
    delete_cloud: bool,
) -> Result<Vec<String>, SyncError> {
    let mut affected = Vec::new();
    for (hash, entry) in &tombstones.entries {
        // 1) 本地文件：优先 relative_path，否则在分桶目录里按 stem 扫描（保留真实扩展名）
        let local_path: Option<PathBuf> = match entry.relative_path.as_deref() {
            Some(rel) => Some(blobs_dir.join(rel)),
            None => find_blob_by_hash(blobs_dir, hash),
        };
        if local_path
            .as_ref()
            .is_some_and(|lp| path_modified_after(lp, &entry.deleted_at))
        {
            tracing::info!(
                "[sync] 跳过过期 blob tombstone，本地文件更新: {} deleted_at={}",
                hash,
                entry.deleted_at
            );
            continue;
        }
        if let Some(ref lp) = local_path {
            if lp.exists() {
                let _ = std::fs::remove_file(lp);
            }
        }

        // 2) 云端删除：只有拿到真实 relative_path（带扩展名）才删；否则跳过以免乱删
        if !delete_cloud {
            affected.push(hash.clone());
            continue;
        }

        if let Some(rel) = entry.relative_path.as_deref() {
            let key = format!("{}/{}", blobs_cloud_prefix, rel);
            if let Err(e) = storage.delete(&key).await {
                tracing::warn!("[sync] 删除云端 blob 失败（忽略）: {}: {}", key, e);
            }
        } else {
            // 如果本地扫描到了路径，用本地相对路径删云端
            if let Some(lp) = local_path {
                if let Ok(rel) = lp.strip_prefix(blobs_dir) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    let key = format!("{}/{}", blobs_cloud_prefix, rel_str);
                    if let Err(e) = storage.delete(&key).await {
                        tracing::warn!("[sync] 删除云端 blob 失败（忽略）: {}: {}", key, e);
                    }
                } else {
                    tracing::warn!(
                        "[sync] tombstone {} 无 relative_path 且本地未找到，跳过云端删除",
                        hash
                    );
                }
            } else {
                // [orphan 修复] 无 relative_path 且本地无文件：尽力在云端按 hash 前缀桶
                // 定位真实 key 后删除，避免删除型 tombstone 只标记不落地、云端 blob 永久残留。
                match find_cloud_blob_key_by_hash(storage, blobs_cloud_prefix, hash).await {
                    Some(key) => {
                        if let Err(e) = storage.delete(&key).await {
                            tracing::warn!("[sync] 删除云端 blob 失败（忽略）: {}: {}", key, e);
                        }
                    }
                    None => {
                        tracing::warn!(
                            "[sync] tombstone {} 无 relative_path 且云端未找到匹配对象，跳过云端删除",
                            hash
                        );
                    }
                }
            }
        }

        affected.push(hash.clone());
    }
    Ok(affected)
}

/// 按 hash 在 blobs_dir 下扫描：blob 命名约定是 `<hash>.<ext>`，
/// 放在以 hash 前两位命名的子目录里（`scan_blobs_dir` 的反向操作）。
fn find_blob_by_hash(blobs_dir: &Path, hash: &str) -> Option<PathBuf> {
    if hash.len() < 2 {
        return None;
    }
    let bucket = blobs_dir.join(&hash[..2]);
    if !bucket.exists() {
        return None;
    }
    let entries = std::fs::read_dir(&bucket).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if stem == hash {
                return Some(path);
            }
        }
    }
    None
}

/// 在云端按 hash 定位真实 blob key（`{prefix}/{ab}/{hash}.{ext}`）。
///
/// 仅在 tombstone 缺 `relative_path`（旧格式）且本地无该文件时使用：列举
/// `{prefix}/{hash[..2]}/` 前缀，返回 stem 与 hash 相等的对象 key。列表被截断
/// 时返回 None（宁可漏删也不误删）。
async fn find_cloud_blob_key_by_hash(
    storage: &dyn CloudStorage,
    blobs_cloud_prefix: &str,
    hash: &str,
) -> Option<String> {
    if hash.len() < 2 {
        return None;
    }
    let bucket = format!("{}/{}", blobs_cloud_prefix.trim_end_matches('/'), &hash[..2]);
    let outcome = storage.list_outcome(&bucket).await.ok()?;
    if outcome.truncated {
        return None;
    }
    outcome.files.into_iter().map(|f| f.key).find(|key| {
        std::path::Path::new(key)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| stem == hash)
            .unwrap_or(false)
    })
}

/// 清理过期的 tombstone（按 deleted_at 与保留天数比较）
pub fn prune_tombstones<T>(
    entries: &mut HashMap<String, T>,
    retention_days: u64,
    extract_deleted_at: impl Fn(&T) -> &str,
) -> usize {
    let cutoff = Utc::now() - chrono::Duration::days(retention_days as i64);
    let before = entries.len();
    entries.retain(|_, v| {
        let ts = extract_deleted_at(v);
        parse_flexible_timestamp_public(ts)
            .map(|dt| dt > cutoff)
            .unwrap_or(true) // 时间戳无法解析就保留，避免误删
    });
    before.saturating_sub(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_tombstones_removes_expired() {
        let mut map: HashMap<String, BlobTombstoneEntry> = HashMap::new();
        let old_ts = (Utc::now() - chrono::Duration::days(120)).to_rfc3339();
        let fresh_ts = Utc::now().to_rfc3339();
        map.insert(
            "old".into(),
            BlobTombstoneEntry {
                deleted_at: old_ts,
                device_id: "d1".into(),
                size: None,
                relative_path: None,
            },
        );
        map.insert(
            "fresh".into(),
            BlobTombstoneEntry {
                deleted_at: fresh_ts,
                device_id: "d1".into(),
                size: None,
                relative_path: None,
            },
        );
        let removed = prune_tombstones(&mut map, 90, |e| &e.deleted_at);
        assert_eq!(removed, 1);
        assert!(map.contains_key("fresh"));
        assert!(!map.contains_key("old"));
    }

    #[test]
    fn test_find_blob_by_hash() {
        use tempfile::TempDir;
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("ab")).unwrap();
        std::fs::write(dir.join("ab").join("abhash123.pdf"), b"x").unwrap();
        let found = find_blob_by_hash(dir, "abhash123");
        assert!(found.is_some());
        assert_eq!(
            found.unwrap().file_name().unwrap().to_string_lossy(),
            "abhash123.pdf"
        );
        // 不存在
        assert!(find_blob_by_hash(dir, "ghostghost").is_none());
        // 短 hash
        assert!(find_blob_by_hash(dir, "a").is_none());
    }

    #[test]
    fn test_blob_tombstones_roundtrip() {
        let mut t = BlobTombstones::default();
        t.entries.insert(
            "hash1".into(),
            BlobTombstoneEntry {
                deleted_at: "2026-05-01T00:00:00Z".into(),
                device_id: "dev1".into(),
                size: Some(1024),
                relative_path: Some("ha/hash1".into()),
            },
        );
        let json = serde_json::to_string(&t).unwrap();
        let back: BlobTombstones = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries["hash1"].device_id, "dev1");
    }
}
