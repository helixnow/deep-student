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
use std::path::Path;

use super::SyncError;
use crate::cloud_storage::CloudStorage;

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
pub async fn download_blob_tombstones(
    storage: &dyn CloudStorage,
) -> Result<BlobTombstones, SyncError> {
    match storage
        .get(BLOB_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 blob tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => match serde_json::from_slice::<BlobTombstones>(&bytes) {
            Ok(v) => Ok(v),
            Err(e) => {
                tracing::warn!("[sync] blob tombstone 清单损坏，忽略并重建: {}", e);
                Ok(BlobTombstones::default())
            }
        },
        None => Ok(BlobTombstones::default()),
    }
}

pub async fn download_asset_tombstones(
    storage: &dyn CloudStorage,
) -> Result<AssetTombstones, SyncError> {
    match storage
        .get(ASSET_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 asset tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => match serde_json::from_slice::<AssetTombstones>(&bytes) {
            Ok(v) => Ok(v),
            Err(e) => {
                tracing::warn!("[sync] asset tombstone 清单损坏，忽略并重建: {}", e);
                Ok(AssetTombstones::default())
            }
        },
        None => Ok(AssetTombstones::default()),
    }
}

pub async fn download_workspace_tombstones(
    storage: &dyn CloudStorage,
) -> Result<WorkspaceTombstones, SyncError> {
    match storage
        .get(WS_TOMBSTONE_KEY)
        .await
        .map_err(|e| SyncError::Network(format!("获取 workspace tombstone 清单失败: {}", e)))?
    {
        Some(bytes) => match serde_json::from_slice::<WorkspaceTombstones>(&bytes) {
            Ok(v) => Ok(v),
            Err(e) => {
                tracing::warn!("[sync] workspace tombstone 清单损坏，忽略并重建: {}", e);
                Ok(WorkspaceTombstones::default())
            }
        },
        None => Ok(WorkspaceTombstones::default()),
    }
}

/// 上传 tombstone 清单（仅在有新增时调用）
pub async fn upload_blob_tombstones(
    storage: &dyn CloudStorage,
    mut manifest: BlobTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 blob tombstone 失败: {}", e)))?;
    storage
        .put(BLOB_TOMBSTONE_KEY, &bytes)
        .await
        .map_err(|e| SyncError::Network(format!("上传 blob tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_asset_tombstones(
    storage: &dyn CloudStorage,
    mut manifest: AssetTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 asset tombstone 失败: {}", e)))?;
    storage
        .put(ASSET_TOMBSTONE_KEY, &bytes)
        .await
        .map_err(|e| SyncError::Network(format!("上传 asset tombstone 失败: {}", e)))?;
    Ok(())
}

pub async fn upload_workspace_tombstones(
    storage: &dyn CloudStorage,
    mut manifest: WorkspaceTombstones,
) -> Result<(), SyncError> {
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 workspace tombstone 失败: {}", e)))?;
    storage
        .put(WS_TOMBSTONE_KEY, &bytes)
        .await
        .map_err(|e| SyncError::Network(format!("上传 workspace tombstone 失败: {}", e)))?;
    Ok(())
}

/// 将一批 tombstone 应用到云端清单 + 本地文件：
/// - 云端 blob 被删除（尽力删，失败只告警）
/// - 本地 blob 目录下对应文件一并删除
/// - 返回本次实际影响的 hash 列表
pub async fn apply_blob_tombstones(
    storage: &dyn CloudStorage,
    tombstones: &BlobTombstones,
    blobs_dir: &Path,
    blobs_cloud_prefix: &str,
) -> Result<Vec<String>, SyncError> {
    let mut affected = Vec::new();
    for (hash, entry) in &tombstones.entries {
        // 云端删除
        let rel = entry
            .relative_path
            .clone()
            .unwrap_or_else(|| guess_relative_path(hash));
        let key = format!("{}/{}", blobs_cloud_prefix, rel);
        if let Err(e) = storage.delete(&key).await {
            tracing::warn!("[sync] 删除云端 blob 失败（忽略）: {}: {}", key, e);
        }
        // 本地删除
        let local = blobs_dir.join(&rel);
        if local.exists() {
            let _ = std::fs::remove_file(&local);
        }
        affected.push(hash.clone());
    }
    Ok(affected)
}

/// 猜测 blob 相对路径（按 blob hash 前两位分桶，与 scan_blobs_dir 一致）
fn guess_relative_path(hash: &str) -> String {
    if hash.len() >= 2 {
        format!("{}/{}", &hash[..2], hash)
    } else {
        hash.to_string()
    }
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
    fn test_guess_relative_path() {
        assert_eq!(guess_relative_path("abcdef1234"), "ab/abcdef1234");
        assert_eq!(guess_relative_path("a"), "a");
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
