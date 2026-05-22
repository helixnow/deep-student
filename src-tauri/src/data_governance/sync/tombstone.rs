//! # Tombstone 清单
//!
//! 解决"一端删除，另一端不删"问题。
//!
//! 文件型同步（VFS blobs / 资产目录 / 工作区数据库）原本只做"本地有→上传、云端有→下载"，
//! 没有删除传播：A 删掉一张图，下次同步会从云端把图拉回 A。
//!
//! ## 实现思路（内容寻址不破坏，按需最小增量）
//!
//! 每种文件类型各维护一份"已删除清单"文件到云端：
//! - `data_governance/tombstones/blobs.json`：{ hash -> { deleted_at, device_id, size } }
//! - `data_governance/tombstones/assets.json`：{ key -> { deleted_at, device_id, size } }
//! - `data_governance/tombstones/workspaces.json`：{ ws_id -> { deleted_at, device_id } }
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

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::SyncError;
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

pub const BLOB_TOMBSTONE_KEY: &str = "data_governance/tombstones/blobs.json";
pub const ASSET_TOMBSTONE_KEY: &str = "data_governance/tombstones/assets.json";
pub const WS_TOMBSTONE_KEY: &str = "data_governance/tombstones/workspaces.json";

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

/// 从云端下载一份 tombstone 清单
///
/// 新增 `codec` 参数（P0-2）：负责上下行透明 encode/decode。传 `&PlainCodec` 即保留
/// 原明文行为；传 `&SyncManager` 则在有密码时走 DSBK 容器加解密。
pub async fn download_blob_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<BlobTombstones, SyncError> {
    match storage
        .get(BLOB_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 blob tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => {
            let decoded = match codec.decode(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("[sync] blob tombstone 解密失败，忽略并重建: {}", e);
                    return Ok(BlobTombstones::default());
                }
            };
            match serde_json::from_slice::<BlobTombstones>(&decoded) {
                Ok(v) => Ok(v),
                Err(e) => {
                    tracing::warn!("[sync] blob tombstone 清单损坏，忽略并重建: {}", e);
                    Ok(BlobTombstones::default())
                }
            }
        }
        None => Ok(BlobTombstones::default()),
    }
}

pub async fn download_asset_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<AssetTombstones, SyncError> {
    match storage
        .get(ASSET_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 asset tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => {
            let decoded = match codec.decode(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("[sync] asset tombstone 解密失败，忽略并重建: {}", e);
                    return Ok(AssetTombstones::default());
                }
            };
            match serde_json::from_slice::<AssetTombstones>(&decoded) {
                Ok(v) => Ok(v),
                Err(e) => {
                    tracing::warn!("[sync] asset tombstone 清单损坏，忽略并重建: {}", e);
                    Ok(AssetTombstones::default())
                }
            }
        }
        None => Ok(AssetTombstones::default()),
    }
}

pub async fn download_workspace_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
) -> Result<WorkspaceTombstones, SyncError> {
    match storage
        .get(WS_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 workspace tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => {
            let decoded = match codec.decode(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("[sync] workspace tombstone 解密失败，忽略并重建: {}", e);
                    return Ok(WorkspaceTombstones::default());
                }
            };
            match serde_json::from_slice::<WorkspaceTombstones>(&decoded) {
                Ok(v) => Ok(v),
                Err(e) => {
                    tracing::warn!("[sync] workspace tombstone 清单损坏，忽略并重建: {}", e);
                    Ok(WorkspaceTombstones::default())
                }
            }
        }
        None => Ok(WorkspaceTombstones::default()),
    }
}

/// 上传 tombstone 清单（仅在有新增时调用）
pub async fn upload_blob_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut manifest: BlobTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 blob tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    storage
        .put(BLOB_TOMBSTONE_KEY, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传 blob tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_asset_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut manifest: AssetTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 asset tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    storage
        .put(ASSET_TOMBSTONE_KEY, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传 asset tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_workspace_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    mut manifest: WorkspaceTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 workspace tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    storage
        .put(WS_TOMBSTONE_KEY, &payload)
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
) -> Result<Vec<String>, SyncError> {
    let mut affected = Vec::new();
    for (hash, entry) in &tombstones.entries {
        // 1) 本地文件：优先 relative_path，否则在分桶目录里按 stem 扫描（保留真实扩展名）
        let local_path: Option<PathBuf> = match entry.relative_path.as_deref() {
            Some(rel) => Some(blobs_dir.join(rel)),
            None => find_blob_by_hash(blobs_dir, hash),
        };
        if let Some(ref lp) = local_path {
            if lp.exists() {
                let _ = std::fs::remove_file(lp);
            }
        }

        // 2) 云端删除：只有拿到真实 relative_path（带扩展名）才删；否则跳过以免乱删
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
                tracing::warn!(
                    "[sync] tombstone {} 无 relative_path 且本地无此文件，跳过",
                    hash
                );
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
        match DateTime::parse_from_rfc3339(ts) {
            Ok(dt) => dt.with_timezone(&Utc) > cutoff,
            Err(_) => true, // 时间戳无法解析就保留，避免误删
        }
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
