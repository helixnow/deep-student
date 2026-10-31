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
//! - `data_governance/tombstones/blobs/{短哈希}.json`（旧 `{device_id}.json` 仍可读）
//! - `data_governance/tombstones/assets/{短哈希}.json`
//! - `data_governance/tombstones/workspaces/{短哈希}.json`
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
//! 在权威 replace/delete-set 快照上线前，tombstone 不按时间清理，避免长期离线设备复活数据。
//! 旧 90 天参数仅为调用兼容保留，不再构成实际删除窗口。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::state::SyncStateStore;
use super::{parse_flexible_timestamp_public, SyncError};
use crate::cloud_storage::{device_id_short_hash, CloudStorage};

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
pub const TOMBSTONE_EVENTS_PREFIX: &str = "data_governance/tombstone-events";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TombstoneEvent {
    #[serde(default = "tombstone_event_format_version")]
    pub format_version: u32,
    pub device_id: String,
    pub seq: u64,
    pub operation_id: String,
    pub kind: String,
    pub object_id: String,
    pub deleted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    /// 事件语义字段的 SHA-256（不包含本字段），用于 PUT 后回读校验。
    #[serde(default)]
    pub payload_hash: String,
}

fn tombstone_event_format_version() -> u32 {
    4
}

/// 兼容旧调用方的 tombstone 保留期参数；当前安全策略不会按时间裁剪。
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

/// 新 tombstone 路径用短哈希，避免把完整 device_id 写进对象 key。
fn tombstone_device_path_id(device_id: &str) -> String {
    device_id_short_hash(device_id)
}

fn event_operation_id(kind: &str, device_id: &str, object_id: &str, deleted_at: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [kind, device_id, object_id, deleted_at] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn event_payload_hash(event: &TombstoneEvent) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(event.format_version.to_be_bytes());
    hasher.update(event.seq.to_be_bytes());
    for value in [
        event.device_id.as_str(),
        event.operation_id.as_str(),
        event.kind.as_str(),
        event.object_id.as_str(),
        event.deleted_at.as_str(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    match event.size {
        Some(size) => {
            hasher.update([1]);
            hasher.update(size.to_be_bytes());
        }
        None => hasher.update([0]),
    }
    match event.relative_path.as_deref() {
        Some(path) => {
            hasher.update([1]);
            hasher.update((path.len() as u64).to_be_bytes());
            hasher.update(path.as_bytes());
        }
        None => hasher.update([0]),
    }
    hex::encode(hasher.finalize())
}

fn event_device_prefix(kind: &str, device_id: &str) -> String {
    format!(
        "{}/{}/{}/",
        TOMBSTONE_EVENTS_PREFIX,
        kind,
        tombstone_device_path_id(device_id)
    )
}

fn event_device_legacy_prefix(kind: &str, device_id: &str) -> String {
    format!(
        "{}/{}/{}/",
        TOMBSTONE_EVENTS_PREFIX,
        kind,
        device_component(device_id)
    )
}

fn event_key(event: &TombstoneEvent) -> String {
    format!(
        "{}{:020}-{}.json",
        event_device_prefix(&event.kind, &event.device_id),
        event.seq,
        event.operation_id
    )
}

fn event_legacy_key(event: &TombstoneEvent) -> String {
    format!(
        "{}{:020}-{}.json",
        event_device_legacy_prefix(&event.kind, &event.device_id),
        event.seq,
        event.operation_id
    )
}

fn event_key_matches(event: &TombstoneEvent, key: &str) -> bool {
    key == event_key(event) || key == event_legacy_key(event)
}

fn event_seq_from_key(key: &str) -> Option<u64> {
    key.rsplit('/')
        .next()?
        .split_once('-')?
        .0
        .parse::<u64>()
        .ok()
}

fn event_operation_from_key(key: &str) -> Option<String> {
    key.rsplit('/')
        .next()?
        .strip_suffix(".json")?
        .split_once('-')
        .map(|(_, operation_id)| operation_id.to_string())
        .filter(|operation_id| !operation_id.is_empty())
}

async fn remote_instance_id(storage: &dyn CloudStorage) -> Result<String, SyncError> {
    use sha2::{Digest, Sha256};
    // Tombstone API 也被独立测试/调用，不能要求调用方先创建 instance.json。
    // 使用不含凭据的 provider/root 绑定指纹隔离本地序号；云端 max(seq) 仍是最终防线。
    let hint = storage.instance_binding_hint();
    Ok(format!(
        "tombstone:{}",
        hex::encode(&Sha256::digest(hint.as_bytes())[..16])
    ))
}

async fn list_event_keys(
    storage: &dyn CloudStorage,
    prefix: &str,
) -> Result<Vec<String>, SyncError> {
    let list = storage
        .list_outcome(prefix)
        .await
        .map_err(|e| SyncError::Network(format!("列举不可变 tombstone 事件失败: {}", e)))?;
    if list.truncated {
        return Err(SyncError::Network(
            "不可变 tombstone 事件列表被截断，拒绝推进水位".to_string(),
        ));
    }
    Ok(list
        .files
        .into_iter()
        .map(|file| file.key)
        .filter(|key| key.ends_with(".json"))
        .collect())
}

async fn put_event_verified(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    event: &TombstoneEvent,
) -> Result<(), SyncError> {
    let key = event_key(event);
    let verify = |bytes: &[u8]| -> Result<bool, SyncError> {
        let decoded = codec.decode(bytes)?;
        Ok(serde_json::from_slice::<TombstoneEvent>(&decoded)
            .map(|existing| {
                !existing.payload_hash.is_empty()
                    && event_payload_hash(&existing) == existing.payload_hash
                    && existing == *event
            })
            .unwrap_or(false))
    };
    if let Some(existing) = storage
        .get(&key)
        .await
        .map_err(|e| SyncError::Network(format!("回读不可变 tombstone 事件失败: {}", e)))?
    {
        if verify(&existing)? {
            return Ok(());
        }
        return Err(SyncError::Network(format!(
            "不可变 tombstone 事件 key 冲突且内容不同: {}",
            key
        )));
    }

    let json = serde_json::to_vec(event)
        .map_err(|e| SyncError::Database(format!("序列化 tombstone 事件失败: {}", e)))?;
    let payload = codec.encode(&json)?;
    storage
        .put(&key, &payload)
        .await
        .map_err(|e| SyncError::Network(format!("上传不可变 tombstone 事件失败: {}", e)))?;
    let written = storage
        .get(&key)
        .await
        .map_err(|e| SyncError::Network(format!("上传后回验 tombstone 事件失败: {}", e)))?
        .ok_or_else(|| SyncError::Network(format!("上传后 tombstone 事件不存在: {}", key)))?;
    if !verify(&written)? {
        return Err(SyncError::Network(format!(
            "上传后 tombstone 事件内容回验失败: {}",
            key
        )));
    }
    Ok(())
}

async fn publish_events(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    kind: &str,
    entries: Vec<(String, String, Option<u64>, Option<String>)>,
) -> Result<(), SyncError> {
    let instance_id = remote_instance_id(storage).await?;
    let state = SyncStateStore::open_default()?;
    let hashed_prefix = event_device_prefix(kind, device_id);
    let mut cloud_keys = list_event_keys(storage, &hashed_prefix).await?;
    let legacy_prefix = event_device_legacy_prefix(kind, device_id);
    if legacy_prefix != hashed_prefix {
        cloud_keys.extend(list_event_keys(storage, &legacy_prefix).await?);
    }
    let mut cloud_max = cloud_keys
        .iter()
        .filter_map(|key| event_seq_from_key(key))
        .max()
        .unwrap_or(0);
    let mut operation_seqs = HashMap::new();
    for key in cloud_keys {
        let (Some(seq), Some(operation_id)) =
            (event_seq_from_key(&key), event_operation_from_key(&key))
        else {
            continue;
        };
        if operation_seqs
            .insert(operation_id.clone(), seq)
            .is_some_and(|old| old != seq)
        {
            return Err(SyncError::Network(format!(
                "同一 tombstone operation_id 对应多个序号: {}",
                operation_id
            )));
        }
    }
    for (object_id, deleted_at, size, relative_path) in entries {
        let operation_id = event_operation_id(kind, device_id, &object_id, &deleted_at);
        let cloud_existing_seq = operation_seqs.get(&operation_id).copied();
        let seq = state.reserve_tombstone_event_seq_with_existing(
            &instance_id,
            device_id,
            kind,
            &operation_id,
            cloud_max,
            cloud_existing_seq,
        )?;
        let mut event = TombstoneEvent {
            format_version: tombstone_event_format_version(),
            device_id: device_id.to_string(),
            seq,
            operation_id,
            kind: kind.to_string(),
            object_id,
            deleted_at,
            size,
            relative_path,
            payload_hash: String::new(),
        };
        event.payload_hash = event_payload_hash(&event);
        put_event_verified(storage, codec, &event).await?;
        cloud_max = cloud_max.max(seq);
        operation_seqs.insert(event.operation_id.clone(), seq);
    }
    Ok(())
}

async fn download_events(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    kind: &str,
) -> Result<Vec<TombstoneEvent>, SyncError> {
    let prefix = format!("{}/{}/", TOMBSTONE_EVENTS_PREFIX, kind);
    let mut events = Vec::new();
    for key in list_event_keys(storage, &prefix).await? {
        let bytes = storage
            .get(&key)
            .await
            .map_err(|e| SyncError::Network(format!("读取 tombstone 事件失败 {}: {}", key, e)))?
            .ok_or_else(|| SyncError::Network(format!("已列举的 tombstone 事件消失: {}", key)))?;
        let decoded = codec.decode(&bytes)?;
        let event: TombstoneEvent = serde_json::from_slice(&decoded)
            .map_err(|e| SyncError::Database(format!("解析 tombstone 事件失败 {}: {}", key, e)))?;
        let expected_operation_id = event_operation_id(
            &event.kind,
            &event.device_id,
            &event.object_id,
            &event.deleted_at,
        );
        if event.format_version != tombstone_event_format_version()
            || event.kind != kind
            || event.operation_id != expected_operation_id
            || !event_key_matches(&event, &key)
            || event.payload_hash.is_empty()
            || event_payload_hash(&event) != event.payload_hash
        {
            return Err(SyncError::Database(format!(
                "tombstone 事件路径与内容不一致: {}",
                key
            )));
        }
        events.push(event);
    }
    events.sort_by(|a, b| {
        a.device_id
            .cmp(&b.device_id)
            .then_with(|| a.seq.cmp(&b.seq))
            .then_with(|| a.operation_id.cmp(&b.operation_id))
    });
    Ok(events)
}

async fn download_events_after<F>(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    kind: &str,
    watermark_for: &mut F,
) -> Result<(Vec<TombstoneEvent>, Vec<TombstoneWatermarkAdvance>), SyncError>
where
    F: FnMut(&str) -> Result<u64, SyncError>,
{
    let mut grouped: std::collections::BTreeMap<String, Vec<TombstoneEvent>> =
        std::collections::BTreeMap::new();
    for event in download_events(storage, codec, kind).await? {
        grouped
            .entry(event.device_id.clone())
            .or_default()
            .push(event);
    }

    let mut selected = Vec::new();
    let mut advances = Vec::new();
    for (device_id, events) in grouped {
        let source = format!("event:{}", device_id);
        let watermark = watermark_for(&source)?;
        let mut expected = watermark.saturating_add(1);
        let mut max_seq = watermark;
        let mut bad_entry_seen = false;
        for event in events.into_iter().filter(|event| event.seq > watermark) {
            if event.seq != expected {
                return Err(SyncError::Network(format!(
                    "不可变 tombstone 事件断层：设备 {} 期望 seq={}，实际 seq={}",
                    device_id, expected, event.seq
                )));
            }
            expected = expected.saturating_add(1);
            // [R04] 坏/超前 deleted_at 的事件：跳过该条，且 seq 水位停在它之前
            // （包括其后的正常事件也不推进），保证时钟追上后能重新拉取应用；
            // 正常事件本轮照常消费，重复消费是幂等的。
            if !tombstone_deleted_at_usable(
                &event.deleted_at,
                &format!("{}/{}", kind, event.object_id),
            ) {
                bad_entry_seen = true;
                continue;
            }
            if !bad_entry_seen {
                max_seq = event.seq;
            }
            selected.push(event);
        }
        if max_seq > watermark {
            advances.push(TombstoneWatermarkAdvance {
                source_device_id: source,
                last_applied_offset: max_seq,
            });
        }
    }
    Ok((selected, advances))
}

pub fn blob_device_tombstone_key(device_id: &str) -> String {
    format!(
        "{}{}.json",
        BLOB_TOMBSTONE_PREFIX,
        tombstone_device_path_id(device_id)
    )
}

fn blob_device_tombstone_legacy_key(device_id: &str) -> String {
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
        tombstone_device_path_id(device_id)
    )
}

fn asset_device_tombstone_legacy_key(device_id: &str) -> String {
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
        tombstone_device_path_id(device_id)
    )
}

fn workspace_device_tombstone_legacy_key(device_id: &str) -> String {
    format!(
        "{}{}.json",
        WS_TOMBSTONE_PREFIX,
        device_component(device_id)
    )
}

async fn get_device_tombstone_bytes(
    storage: &dyn CloudStorage,
    hashed_key: &str,
    legacy_key: &str,
    label: &str,
) -> Result<Option<Vec<u8>>, SyncError> {
    if let Some(bytes) = storage
        .get(hashed_key)
        .await
        .map_err(|e| SyncError::Network(format!("获取本机 {label} tombstone 清单失败: {}", e)))?
    {
        return Ok(Some(bytes));
    }
    if legacy_key != hashed_key {
        return storage.get(legacy_key).await.map_err(|e| {
            SyncError::Network(format!("获取本机 {label} tombstone 清单失败: {}", e))
        });
    }
    Ok(None)
}

/// 每设备 tombstone 清单 PUT 后 GET 回读。`put` 成功不等于对象完整落地；
/// 短写会把错误删除集当已发布。不复用 `SyncManager::put_bytes_and_reread`，
/// 以免把该 helper 抬成 pub 并拉宽模块边界。
async fn put_tombstone_manifest_and_reread(
    storage: &dyn CloudStorage,
    key: &str,
    payload: &[u8],
    context: &str,
) -> Result<(), SyncError> {
    storage
        .put(key, payload)
        .await
        .map_err(|e| SyncError::Network(format!("{context} 上传失败: {e}")))?;
    match storage.get(key).await {
        Ok(Some(read_back)) if read_back == payload => Ok(()),
        Ok(Some(_)) => Err(SyncError::Network(format!(
            "{context} 上传后回读不一致，已停止并不得报成功"
        ))),
        Ok(None) => Err(SyncError::Network(format!(
            "{context} 上传后对象不存在，已停止并不得报成功"
        ))),
        Err(e) => Err(SyncError::Network(format!("{context} 上传后回读失败: {e}"))),
    }
}

async fn delete_legacy_device_tombstone(
    storage: &dyn CloudStorage,
    hashed_key: &str,
    legacy_key: &str,
) {
    if hashed_key == legacy_key {
        return;
    }
    match storage.stat(legacy_key).await {
        Ok(Some(_)) => {
            if let Err(error) = storage.delete(legacy_key).await {
                tracing::warn!(
                    "[sync] 迁移 tombstone 后删除旧对象 {} 失败（新清单已发布）: {}",
                    legacy_key,
                    error
                );
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                "[sync] 迁移 tombstone 时探测旧对象 {} 失败: {}",
                legacy_key,
                error
            );
        }
    }
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

/// 文件层 tombstone 也必须遵守与行级 LWW 相同的未来时钟漂移上限。
///
/// 旧实现直接用远端 wall-clock 与本地 mtime 比较；一台快时钟设备可以让删除
/// 在其他设备上长期压过真实发生得更晚的重建。无法证明因果关系时 fail-close，
/// 且调用方不得推进 watermark。
pub fn validate_tombstone_timestamp(timestamp: &str, label: &str) -> Result<(), SyncError> {
    let parsed = parse_flexible_timestamp_public(timestamp).ok_or_else(|| {
        SyncError::Database(format!("{} tombstone 时间戳无效: {}", label, timestamp))
    })?;
    let drift_ms = parsed.timestamp_millis() - Utc::now().timestamp_millis();
    if drift_ms > super::hlc::MAX_DRIFT_MS {
        return Err(SyncError::ClockDriftSuspected {
            table: format!("{}_tombstone", label),
            record_id: timestamp.to_string(),
            drift_ms,
        });
    }
    Ok(())
}

/// [R04 anti-DoS] 判断单条 tombstone 的 `deleted_at` 是否可消费。
///
/// 旧行为是把 `validate_tombstone_timestamp` 的错误直接 `?` 冒泡：一台坏时钟
/// 设备发布的一条无效/超前 tombstone 会让整轮文件同步永久失败（拒绝服务）。
/// 现在改为：坏条目跳过并记录 warning，其余条目照常处理。
///
/// 调用方必须保证被跳过的条目不推进水位（不计入 `max_offset` / 事件 seq 推进），
/// 这样超前时间戳在本地时钟追上后会被重新拉取并正常应用，删除意图不丢失。
fn tombstone_deleted_at_usable(deleted_at: &str, label: &str) -> bool {
    match validate_tombstone_timestamp(deleted_at, label) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(
                "[sync] 跳过坏/超前 deleted_at 的 tombstone（该条不推进水位）: {} deleted_at={} 原因: {}",
                label,
                deleted_at,
                error
            );
            false
        }
    }
}

/// [P2 fail-close] 解密失败必须硬错误，与设备清单/变更文件路径口径一致。
/// fail-open 的两类危害：
/// - 消费路径把"解不开"当"无 tombstone"，删除静默不传播；
/// - `mark_*` 写入路径拿到空清单后整体覆盖云端，丢失该设备全部历史 tombstone。
///
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
    serde_json::from_slice::<T>(&decoded)
        .map(Some)
        .map_err(|e| {
            SyncError::Database(format!(
                "{} tombstone 清单损坏，已停止同步且未推进水位: {}",
                label, e
            ))
        })
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

fn tombstone_path_stem(prefix: &str, key: &str) -> String {
    key.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(".json"))
        .filter(|rest| !rest.trim().is_empty())
        .unwrap_or("unknown-device")
        .to_string()
}

/// 路径段是否指向该设备：兼容旧明文（含净化）与新短哈希。
fn tombstone_path_id_matches_device(path_id: &str, device_id: &str) -> bool {
    !path_id.is_empty()
        && (path_id == device_component(device_id)
            || path_id == tombstone_device_path_id(device_id))
}

/// 水位必须按内容里的完整 `device_id` 记账。
///
/// 新对象文件名是短哈希，不能把 stem 当设备 ID，否则升级后游标对不上、
/// 会整份重放或漏推。路径与内容不一致、或一份清单混多台设备，fail-closed。
fn source_device_from_tombstone_entries<'a>(
    key: &str,
    prefix: &str,
    device_ids: impl IntoIterator<Item = &'a str>,
) -> Result<String, SyncError> {
    let path_id = tombstone_path_stem(prefix, key);
    let mut seen_entry = false;
    let mut unique: Vec<&'a str> = Vec::new();
    for raw in device_ids {
        seen_entry = true;
        let id = raw.trim();
        if id.is_empty() {
            continue;
        }
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    match unique.as_slice() {
        [] if !seen_entry => Ok(path_id),
        [] => Err(SyncError::Database(format!(
            "tombstone 清单缺少 device_id，已停止同步且未推进水位: {}",
            key
        ))),
        [device_id] => {
            if !tombstone_path_id_matches_device(&path_id, device_id) {
                return Err(SyncError::Database(format!(
                    "tombstone 清单路径与内容 device_id 不一致: {}",
                    key
                )));
            }
            Ok((*device_id).to_string())
        }
        _ => Err(SyncError::Database(format!(
            "tombstone 清单混有多台设备的 device_id，已停止同步且未推进水位: {}",
            key
        ))),
    }
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
        // [R04] 坏/超前 deleted_at：跳过该条且不推进水位，避免单条坏时钟
        // DoS 整轮文件同步；超前条目在时钟追上后会重新进入本函数并正常计入。
        if !tombstone_deleted_at_usable(&entry.deleted_at, &format!("blob/{}", hash)) {
            continue;
        }
        let offset = tombstone_offset_from_deleted_at(&entry.deleted_at);
        max_offset = max_offset.max(offset);
        // Timestamps are not a safe cursor: two deletes can share one millisecond,
        // and wall clocks can move backwards. Tombstones are retained and their
        // application is idempotent, so replay the complete per-device set.
        filtered.entries.insert(hash, entry);
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
        // [R04] 与 blob 对称：坏/超前 deleted_at 跳过且不推进水位。
        if !tombstone_deleted_at_usable(&entry.deleted_at, &format!("asset/{}", key)) {
            continue;
        }
        let offset = tombstone_offset_from_deleted_at(&entry.deleted_at);
        max_offset = max_offset.max(offset);
        filtered.entries.insert(key, entry);
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
        max_offset = max_offset.max(offset);
        filtered.entries.insert(ws_id, entry);
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
            if let Some(manifest) = decode_tombstone_file::<BlobTombstones>(codec, &bytes, "blob")?
            {
                merge_blob_tombstones(&mut merged, manifest);
            }
        }
    }
    for event in download_events(storage, codec, "blobs").await? {
        merge_blob_tombstones(
            &mut merged,
            BlobTombstones {
                entries: [(
                    event.object_id,
                    BlobTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                        size: event.size,
                        relative_path: event.relative_path,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
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
            if let Some(manifest) = decode_tombstone_file::<BlobTombstones>(codec, &bytes, "blob")?
            {
                let source = source_device_from_tombstone_entries(
                    &key,
                    BLOB_TOMBSTONE_PREFIX,
                    manifest
                        .entries
                        .values()
                        .map(|entry| entry.device_id.as_str()),
                )?;
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

    let (events, event_advances) =
        download_events_after(storage, codec, "blobs", &mut watermark_for).await?;
    advances.extend(event_advances);
    for event in events {
        merge_blob_tombstones(
            &mut merged,
            BlobTombstones {
                entries: [(
                    event.object_id,
                    BlobTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                        size: event.size,
                        relative_path: event.relative_path,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
    }

    Ok((merged, advances))
}

pub async fn download_blob_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<BlobTombstones, SyncError> {
    let hashed = blob_device_tombstone_key(device_id);
    let legacy = blob_device_tombstone_legacy_key(device_id);
    match get_device_tombstone_bytes(storage, &hashed, &legacy, "blob").await? {
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
    for event in download_events(storage, codec, "assets").await? {
        merge_asset_tombstones(
            &mut merged,
            AssetTombstones {
                entries: [(
                    event.object_id,
                    AssetTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                        size: event.size,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
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
                let source = source_device_from_tombstone_entries(
                    &key,
                    ASSET_TOMBSTONE_PREFIX,
                    manifest
                        .entries
                        .values()
                        .map(|entry| entry.device_id.as_str()),
                )?;
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

    let (events, event_advances) =
        download_events_after(storage, codec, "assets", &mut watermark_for).await?;
    advances.extend(event_advances);
    for event in events {
        merge_asset_tombstones(
            &mut merged,
            AssetTombstones {
                entries: [(
                    event.object_id,
                    AssetTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                        size: event.size,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
    }

    Ok((merged, advances))
}

pub async fn download_asset_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<AssetTombstones, SyncError> {
    let hashed = asset_device_tombstone_key(device_id);
    let legacy = asset_device_tombstone_legacy_key(device_id);
    match get_device_tombstone_bytes(storage, &hashed, &legacy, "asset").await? {
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
    for event in download_events(storage, codec, "workspaces").await? {
        merge_workspace_tombstones(
            &mut merged,
            WorkspaceTombstones {
                entries: [(
                    event.object_id,
                    WorkspaceTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
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
                let source = source_device_from_tombstone_entries(
                    &key,
                    WS_TOMBSTONE_PREFIX,
                    manifest
                        .entries
                        .values()
                        .map(|entry| entry.device_id.as_str()),
                )?;
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

    let (events, event_advances) =
        download_events_after(storage, codec, "workspaces", &mut watermark_for).await?;
    advances.extend(event_advances);
    for event in events {
        merge_workspace_tombstones(
            &mut merged,
            WorkspaceTombstones {
                entries: [(
                    event.object_id,
                    WorkspaceTombstoneEntry {
                        deleted_at: event.deleted_at,
                        device_id: event.device_id,
                    },
                )]
                .into_iter()
                .collect(),
                updated_at: String::new(),
            },
        );
    }

    Ok((merged, advances))
}

pub async fn download_workspace_tombstones_for_device(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
) -> Result<WorkspaceTombstones, SyncError> {
    let hashed = workspace_device_tombstone_key(device_id);
    let legacy = workspace_device_tombstone_legacy_key(device_id);
    match get_device_tombstone_bytes(storage, &hashed, &legacy, "workspace").await? {
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
    publish_events(
        storage,
        codec,
        device_id,
        "blobs",
        manifest
            .entries
            .iter()
            .map(|(object_id, entry)| {
                (
                    object_id.clone(),
                    entry.deleted_at.clone(),
                    entry.size,
                    entry.relative_path.clone(),
                )
            })
            .collect(),
    )
    .await?;
    // v3 兼容双写：旧客户端继续读取每设备清单；v4 客户端以不可变事件为准并双读。
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 blob tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = blob_device_tombstone_key(device_id);
    put_tombstone_manifest_and_reread(storage, &key, &payload, "blob tombstone 清单").await?;
    delete_legacy_device_tombstone(storage, &key, &blob_device_tombstone_legacy_key(device_id))
        .await;
    Ok(())
}

pub async fn upload_asset_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    mut manifest: AssetTombstones,
) -> Result<(), SyncError> {
    publish_events(
        storage,
        codec,
        device_id,
        "assets",
        manifest
            .entries
            .iter()
            .map(|(object_id, entry)| {
                (
                    object_id.clone(),
                    entry.deleted_at.clone(),
                    entry.size,
                    None,
                )
            })
            .collect(),
    )
    .await?;
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 asset tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = asset_device_tombstone_key(device_id);
    put_tombstone_manifest_and_reread(storage, &key, &payload, "asset tombstone 清单").await?;
    delete_legacy_device_tombstone(storage, &key, &asset_device_tombstone_legacy_key(device_id))
        .await;
    Ok(())
}

pub async fn upload_workspace_tombstones(
    storage: &dyn CloudStorage,
    codec: &dyn PayloadCodec,
    device_id: &str,
    mut manifest: WorkspaceTombstones,
) -> Result<(), SyncError> {
    publish_events(
        storage,
        codec,
        device_id,
        "workspaces",
        manifest
            .entries
            .iter()
            .map(|(object_id, entry)| (object_id.clone(), entry.deleted_at.clone(), None, None))
            .collect(),
    )
    .await?;
    manifest.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| SyncError::Database(format!("序列化 workspace tombstone 失败: {}", e)))?;
    let payload = codec.encode(&bytes)?;
    let key = workspace_device_tombstone_key(device_id);
    put_tombstone_manifest_and_reread(storage, &key, &payload, "workspace tombstone 清单").await?;
    delete_legacy_device_tombstone(
        storage,
        &key,
        &workspace_device_tombstone_legacy_key(device_id),
    )
    .await;
    Ok(())
}

/// 将一批 tombstone 应用到云端清单 + 本地文件：
/// - 云端 blob 被删除；任何 I/O 失败都中止本轮，调用方不得推进 tombstone 水位
/// - [R04] 单条坏/超前 `deleted_at` 不再 `?` 冒泡中止整批，而是跳过该条并记录
///   warning；被跳过的条目不进入返回的 hash 列表，调用方也不得为其推进水位
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
    // 先验证整批并构建删除计划；HashMap 顺序不稳定，不能在遇到后置非法项前
    // 已经删除部分有效文件。
    let mut deletion_plan = Vec::with_capacity(tombstones.entries.len());
    for (hash, entry) in &tombstones.entries {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(SyncError::Database(format!(
                "拒绝非法 blob tombstone hash: {hash:?}"
            )));
        }
        // [R04] 坏/超前 deleted_at：只跳过该条并记录，不中止整批——一台坏时钟
        // 设备不得 DoS 整轮文件同步。被跳过条目不进入 affected，水位由下载侧
        // 保证不推进，时钟追上后会重新应用。
        if !tombstone_deleted_at_usable(&entry.deleted_at, &format!("blob/{}", hash)) {
            continue;
        }
        // 1) 本地文件：优先 relative_path，否则在分桶目录里按 stem 扫描（保留真实扩展名）
        let local_path: Option<PathBuf> = match entry.relative_path.as_deref() {
            Some(rel) => Some(validate_blob_relative_path(blobs_dir, hash, rel)?),
            None => find_blob_by_hash(blobs_dir, hash),
        };
        deletion_plan.push((hash, entry, local_path));
    }

    for (hash, entry, local_path) in deletion_plan {
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
                std::fs::remove_file(lp)?;
            }
        }

        // 2) 云端删除：只有拿到真实 relative_path（带扩展名）才删；否则跳过以免乱删
        if !delete_cloud {
            affected.push(hash.clone());
            continue;
        }

        if let Some(rel) = entry.relative_path.as_deref() {
            let key = format!("{}/{}", blobs_cloud_prefix, rel);
            storage
                .delete(&key)
                .await
                .map_err(|e| SyncError::Network(format!("删除云端 blob 失败 {}: {}", key, e)))?;
        } else {
            // 如果本地扫描到了路径，用本地相对路径删云端
            if let Some(lp) = local_path {
                if let Ok(rel) = lp.strip_prefix(blobs_dir) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    let key = format!("{}/{}", blobs_cloud_prefix, rel_str);
                    storage.delete(&key).await.map_err(|e| {
                        SyncError::Network(format!("删除云端 blob 失败 {}: {}", key, e))
                    })?;
                } else {
                    tracing::warn!(
                        "[sync] tombstone {} 无 relative_path 且本地未找到，跳过云端删除",
                        hash
                    );
                }
            } else {
                // [orphan 修复] 无 relative_path 且本地无文件：尽力在云端按 hash 前缀桶
                // 定位真实 key 后删除，避免删除型 tombstone 只标记不落地、云端 blob 永久残留。
                match find_cloud_blob_key_by_hash(storage, blobs_cloud_prefix, hash).await? {
                    Some(key) => {
                        storage.delete(&key).await.map_err(|e| {
                            SyncError::Network(format!("删除云端 blob 失败 {}: {}", key, e))
                        })?;
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

fn validate_blob_relative_path(
    blobs_dir: &Path,
    hash: &str,
    relative_path: &str,
) -> Result<PathBuf, SyncError> {
    let path = Path::new(relative_path);
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 2
        || components
            .iter()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(SyncError::Database(format!(
            "拒绝不安全的 blob tombstone 相对路径: {relative_path:?}"
        )));
    }

    let bucket = components[0].as_os_str();
    let file_name = components[1].as_os_str();
    let file_path = Path::new(file_name);
    if bucket != std::ffi::OsStr::new(&hash[..2])
        || file_path.file_stem().and_then(|stem| stem.to_str()) != Some(hash)
    {
        return Err(SyncError::Database(format!(
            "blob tombstone 路径与内容 hash 不匹配: {relative_path:?}"
        )));
    }

    let bucket_path = blobs_dir.join(bucket);
    if std::fs::symlink_metadata(&bucket_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(SyncError::Database(format!(
            "blob tombstone 目标桶不能是符号链接: {}",
            bucket_path.display()
        )));
    }
    let target = bucket_path.join(file_name);
    if std::fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(SyncError::Database(format!(
            "blob tombstone 目标不能是符号链接: {}",
            target.display()
        )));
    }
    Ok(target)
}

/// 按 hash 在 blobs_dir 下扫描：blob 命名约定是 `<hash>.<ext>`，
/// 放在以 hash 前两位命名的子目录里（`scan_blobs_dir` 的反向操作）。
fn find_blob_by_hash(blobs_dir: &Path, hash: &str) -> Option<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let bucket = blobs_dir.join(&hash[..2]);
    let bucket_metadata = std::fs::symlink_metadata(&bucket).ok()?;
    if bucket_metadata.file_type().is_symlink() || !bucket_metadata.is_dir() {
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
/// 时返回错误，阻止调用方推进 tombstone 水位。
async fn find_cloud_blob_key_by_hash(
    storage: &dyn CloudStorage,
    blobs_cloud_prefix: &str,
    hash: &str,
) -> Result<Option<String>, SyncError> {
    if hash.len() < 2 {
        return Ok(None);
    }
    let bucket = format!(
        "{}/{}",
        blobs_cloud_prefix.trim_end_matches('/'),
        &hash[..2]
    );
    let outcome = storage
        .list_outcome(&bucket)
        .await
        .map_err(|e| SyncError::Network(format!("列举云端 blob 桶失败 {}: {}", bucket, e)))?;
    if outcome.truncated {
        return Err(SyncError::Network(format!(
            "云端 blob 桶列表被截断，拒绝确认 tombstone: {}",
            bucket
        )));
    }
    Ok(outcome.files.into_iter().map(|f| f.key).find(|key| {
        std::path::Path::new(key)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| stem == hash)
            .unwrap_or(false)
    }))
}

/// 清理过期的 tombstone（按 deleted_at 与保留天数比较）
pub fn prune_tombstones<T>(
    entries: &mut HashMap<String, T>,
    retention_days: u64,
    extract_deleted_at: impl Fn(&T) -> &str,
) -> usize {
    let _ = (entries, retention_days, extract_deleted_at);
    // No finite retention window can be correct for an arbitrarily long-offline
    // device unless an authoritative replace snapshot exists. Keep tombstones
    // until that protocol is implemented and verified.
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_tombstones_retains_expired_without_authoritative_snapshot() {
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
        assert_eq!(removed, 0);
        assert!(map.contains_key("fresh"));
        assert!(
            map.contains_key("old"),
            "离线设备可能仍需该删除记录；权威 replace snapshot 上线前不得裁剪"
        );
    }

    #[test]
    fn watermark_never_filters_same_millisecond_or_clock_rewind_tombstones() {
        let same_millis = "2026-05-01T00:00:00.123Z";
        let older = "2026-04-30T23:59:59.000Z";
        let watermark = tombstone_offset_from_deleted_at(same_millis);

        let mut blobs = BlobTombstones::default();
        for (key, deleted_at) in [("same", same_millis), ("rewind", older)] {
            blobs.entries.insert(
                key.to_string(),
                BlobTombstoneEntry {
                    deleted_at: deleted_at.to_string(),
                    device_id: "device-a".to_string(),
                    size: None,
                    relative_path: None,
                },
            );
        }
        let (blobs, _) = filter_blob_tombstones_after(blobs, watermark);
        assert_eq!(blobs.entries.len(), 2);

        let mut assets = AssetTombstones::default();
        assets.entries.insert(
            "same".to_string(),
            AssetTombstoneEntry {
                deleted_at: same_millis.to_string(),
                device_id: "device-a".to_string(),
                size: None,
            },
        );
        let (assets, _) = filter_asset_tombstones_after(assets, watermark);
        assert!(assets.entries.contains_key("same"));

        let mut workspaces = WorkspaceTombstones::default();
        workspaces.entries.insert(
            "rewind".to_string(),
            WorkspaceTombstoneEntry {
                deleted_at: older.to_string(),
                device_id: "device-a".to_string(),
            },
        );
        let (workspaces, _) = filter_workspace_tombstones_after(workspaces, watermark);
        assert!(workspaces.entries.contains_key("rewind"));
    }

    #[test]
    fn malformed_tombstone_manifest_fails_closed() {
        let error = decode_tombstone_file::<BlobTombstones>(
            &PlainCodec,
            br#"{"entries":{"broken":]}}"#,
            "blob",
        )
        .expect_err("malformed tombstone JSON must stop sync");

        assert!(error.to_string().contains("未推进水位"));
    }

    #[test]
    fn test_find_blob_by_hash() {
        use tempfile::TempDir;
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        // find_blob_by_hash 只接受 64 位 hex hash（内容寻址约定）
        let hash = "ab".repeat(32);
        let missing = "cd".repeat(32);
        std::fs::create_dir_all(dir.join("ab")).unwrap();
        std::fs::write(dir.join("ab").join(format!("{}.pdf", hash)), b"x").unwrap();
        let found = find_blob_by_hash(dir, &hash);
        assert!(found.is_some());
        assert_eq!(
            found.unwrap().file_name().unwrap().to_string_lossy(),
            format!("{}.pdf", hash)
        );
        // 不存在
        assert!(find_blob_by_hash(dir, &missing).is_none());
        // 短 hash（非 64 位 hex 直接拒绝）
        assert!(find_blob_by_hash(dir, "a").is_none());
        assert!(find_blob_by_hash(dir, "abhash123").is_none());
        let non_hex = format!("zz{}", "c".repeat(62));
        assert!(find_blob_by_hash(dir, &non_hex).is_none());
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

    #[test]
    fn immutable_event_identity_and_key_are_stable() {
        let operation_id = event_operation_id(
            "assets",
            "device-a",
            "active/images/a.png",
            "2026-07-20T00:00:00Z",
        );
        assert_eq!(operation_id.len(), 64);
        assert_eq!(
            operation_id,
            event_operation_id(
                "assets",
                "device-a",
                "active/images/a.png",
                "2026-07-20T00:00:00Z"
            )
        );
        let mut event = TombstoneEvent {
            format_version: 4,
            device_id: "device-a".to_string(),
            seq: 1,
            operation_id,
            kind: "assets".to_string(),
            object_id: "active/images/a.png".to_string(),
            deleted_at: "2026-07-20T00:00:00Z".to_string(),
            size: Some(3),
            relative_path: None,
            payload_hash: String::new(),
        };
        event.payload_hash = event_payload_hash(&event);
        let key = event_key(&event);
        let hashed = tombstone_device_path_id("device-a");
        assert!(
            key.starts_with(&format!(
                "data_governance/tombstone-events/assets/{hashed}/"
            )),
            "新 tombstone 事件路径应使用短哈希: {key}"
        );
        assert!(
            !key.contains("device-a"),
            "新事件路径不得暴露明文 device_id: {key}"
        );
        assert_eq!(event_seq_from_key(&key), Some(1));
        assert_eq!(
            serde_json::from_slice::<TombstoneEvent>(&serde_json::to_vec(&event).unwrap()).unwrap(),
            event
        );
    }

    use crate::cloud_storage::{FileInfo, Result as StorageResult};

    #[derive(Default)]
    struct MemoryStorage {
        files: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
    }

    #[async_trait::async_trait]
    impl CloudStorage for MemoryStorage {
        fn provider_name(&self) -> &'static str {
            "memory-test"
        }
        async fn check_connection(&self) -> StorageResult<()> {
            Ok(())
        }
        async fn put(&self, key: &str, data: &[u8]) -> StorageResult<()> {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), data.to_vec());
            Ok(())
        }
        async fn get(&self, key: &str) -> StorageResult<Option<Vec<u8>>> {
            Ok(self.files.lock().unwrap().get(key).cloned())
        }
        async fn list(&self, prefix: &str) -> StorageResult<Vec<FileInfo>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.starts_with(prefix))
                .map(|(key, value)| FileInfo {
                    key: key.clone(),
                    size: value.len() as u64,
                    last_modified: Utc::now(),
                    etag: None,
                })
                .collect())
        }
        async fn delete(&self, key: &str) -> StorageResult<()> {
            self.files.lock().unwrap().remove(key);
            Ok(())
        }
        async fn stat(&self, key: &str) -> StorageResult<Option<FileInfo>> {
            Ok(self.files.lock().unwrap().get(key).map(|value| FileInfo {
                key: key.to_string(),
                size: value.len() as u64,
                last_modified: Utc::now(),
                etag: None,
            }))
        }
    }

    /// 只污染每设备 tombstone 清单 PUT；不可变事件路径保持完整，避免事件回验先拦住。
    struct CorruptTombstoneManifestPut {
        inner: MemoryStorage,
        persist: bool,
    }

    #[async_trait::async_trait]
    impl CloudStorage for CorruptTombstoneManifestPut {
        fn provider_name(&self) -> &'static str {
            "memory-corrupt-tombstone-manifest"
        }
        async fn check_connection(&self) -> StorageResult<()> {
            Ok(())
        }
        async fn put(&self, key: &str, data: &[u8]) -> StorageResult<()> {
            if key.starts_with("data_governance/tombstones/") {
                if !self.persist {
                    return Ok(());
                }
                return CloudStorage::put(&self.inner, key, b"corrupted-tombstone-manifest").await;
            }
            CloudStorage::put(&self.inner, key, data).await
        }
        async fn get(&self, key: &str) -> StorageResult<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }
        async fn list(&self, prefix: &str) -> StorageResult<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }
        async fn delete(&self, key: &str) -> StorageResult<()> {
            CloudStorage::delete(&self.inner, key).await
        }
        async fn stat(&self, key: &str) -> StorageResult<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    fn sample_blob_tombstones(device_id: &str) -> BlobTombstones {
        let mut manifest = BlobTombstones::default();
        manifest.entries.insert(
            "aa".repeat(32),
            BlobTombstoneEntry {
                deleted_at: "2026-08-01T00:00:00Z".to_string(),
                device_id: device_id.to_string(),
                size: None,
                relative_path: None,
            },
        );
        manifest
    }

    #[test]
    fn per_device_tombstone_manifests_reread_after_put() {
        let source = include_str!("tombstone.rs");
        assert!(
            source.contains("put_tombstone_manifest_and_reread"),
            "每设备 tombstone 清单必须 GET 回读，不得只认 put 成功"
        );
        assert!(
            source.contains("blob tombstone 清单"),
            "upload_blob_tombstones 必须走回读闸"
        );
        assert!(
            source.contains("asset tombstone 清单"),
            "upload_asset_tombstones 必须走回读闸"
        );
        assert!(
            source.contains("workspace tombstone 清单"),
            "upload_workspace_tombstones 必须走回读闸"
        );
    }

    #[tokio::test]
    async fn upload_blob_tombstones_fails_when_reread_mismatches() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = CorruptTombstoneManifestPut {
            inner: MemoryStorage::default(),
            persist: true,
        };
        let device = "r12-tomb-reread-mismatch-device";
        let legacy = blob_device_tombstone_legacy_key(device);
        storage
            .inner
            .put(&legacy, b"{\"entries\":{},\"updated_at\":\"legacy\"}")
            .await
            .unwrap();

        let error = upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device,
            sample_blob_tombstones(device),
        )
        .await
        .expect_err("每设备 tombstone 清单回读不一致必须 fail-closed");
        assert!(
            error
                .to_string()
                .contains("blob tombstone 清单 上传后回读不一致"),
            "拒绝原因必须指向清单回读，实际: {error}"
        );
        assert!(
            storage
                .inner
                .get(&blob_device_tombstone_key(device))
                .await
                .unwrap()
                .is_some(),
            "损坏的最终对象可保留供对照，但不得报成功"
        );
        assert!(
            storage.inner.get(&legacy).await.unwrap().is_some(),
            "回读失败不得删除旧明文清单"
        );
    }

    #[tokio::test]
    async fn upload_blob_tombstones_fails_when_missing_after_put() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = CorruptTombstoneManifestPut {
            inner: MemoryStorage::default(),
            persist: false,
        };
        let device = "r12-tomb-reread-missing-device";
        let error = upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device,
            sample_blob_tombstones(device),
        )
        .await
        .expect_err("每设备 tombstone 清单上传后缺失必须 fail-closed");
        assert!(
            error
                .to_string()
                .contains("blob tombstone 清单 上传后对象不存在"),
            "拒绝原因必须指向清单缺失，实际: {error}"
        );
        assert!(
            storage
                .inner
                .get(&blob_device_tombstone_key(device))
                .await
                .unwrap()
                .is_none(),
            "假装成功却未落地的对象不得被当成已发布"
        );
    }

    #[test]
    fn bad_or_future_deleted_at_is_skipped_and_never_advances_watermark() {
        let valid = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let future = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let valid_offset = tombstone_offset_from_deleted_at(&valid);
        let future_offset = tombstone_offset_from_deleted_at(&future);
        assert!(future_offset > valid_offset);

        let mut blobs = BlobTombstones::default();
        for (hash, deleted_at) in [
            ("good", valid.as_str()),
            ("future", future.as_str()),
            ("garbage", "not-a-timestamp"),
        ] {
            blobs.entries.insert(
                hash.to_string(),
                BlobTombstoneEntry {
                    deleted_at: deleted_at.to_string(),
                    device_id: "device-a".to_string(),
                    size: None,
                    relative_path: None,
                },
            );
        }
        let (filtered, max_offset) = filter_blob_tombstones_after(blobs, 0);
        assert_eq!(filtered.entries.len(), 1, "坏/超前条目必须被剔除");
        assert!(filtered.entries.contains_key("good"));
        assert_eq!(
            max_offset, valid_offset,
            "水位只能由有效条目推进，超前时钟不得拉高水位"
        );

        let mut assets = AssetTombstones::default();
        for (key, deleted_at) in [
            ("active/images/good.png", valid.as_str()),
            ("active/images/future.png", future.as_str()),
            ("active/images/garbage.png", "not-a-timestamp"),
        ] {
            assets.entries.insert(
                key.to_string(),
                AssetTombstoneEntry {
                    deleted_at: deleted_at.to_string(),
                    device_id: "device-a".to_string(),
                    size: None,
                },
            );
        }
        let (filtered, max_offset) = filter_asset_tombstones_after(assets, 0);
        assert_eq!(filtered.entries.len(), 1, "asset 路径与 blob 对称");
        assert!(filtered.entries.contains_key("active/images/good.png"));
        assert_eq!(max_offset, valid_offset);
    }

    #[tokio::test]
    async fn apply_blob_tombstones_skips_bad_clock_entries_without_failing_batch() {
        use tempfile::TempDir;
        let tmp = TempDir::new().unwrap();
        let blobs_dir = tmp.path();
        let good_hash = "aa".repeat(32);
        let future_hash = "bb".repeat(32);
        let garbage_hash = "cc".repeat(32);
        std::fs::create_dir_all(blobs_dir.join("aa")).unwrap();
        std::fs::create_dir_all(blobs_dir.join("bb")).unwrap();
        let good_file = blobs_dir.join("aa").join(format!("{}.png", good_hash));
        let future_file = blobs_dir.join("bb").join(format!("{}.png", future_hash));
        std::fs::write(&good_file, b"good").unwrap();
        std::fs::write(&future_file, b"future").unwrap();

        let mut tombstones = BlobTombstones::default();
        tombstones.entries.insert(
            good_hash.clone(),
            BlobTombstoneEntry {
                // 在漂移上限（60s）内、且晚于文件 mtime：正常应用
                deleted_at: (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: Some(format!("aa/{}.png", good_hash)),
            },
        );
        tombstones.entries.insert(
            future_hash.clone(),
            BlobTombstoneEntry {
                deleted_at: (Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: Some(format!("bb/{}.png", future_hash)),
            },
        );
        tombstones.entries.insert(
            garbage_hash,
            BlobTombstoneEntry {
                deleted_at: "not-a-timestamp".to_string(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );

        let storage = MemoryStorage::default();
        let affected = apply_blob_tombstones(&storage, &tombstones, blobs_dir, "blobs", true)
            .await
            .expect("单条坏时钟 tombstone 不得中止整批（DoS）");
        assert_eq!(affected, vec![good_hash], "只有有效条目被应用");
        assert!(!good_file.exists(), "有效 tombstone 照常删除本地文件");
        assert!(
            future_file.exists(),
            "超前时钟条目必须被跳过，不删除本地文件"
        );
    }

    #[tokio::test]
    async fn event_watermark_stops_before_bad_clock_event() {
        let storage = MemoryStorage::default();
        let device = "device-a";
        let make_event = |seq: u64, object_id: &str, deleted_at: &str| {
            let mut event = TombstoneEvent {
                format_version: tombstone_event_format_version(),
                device_id: device.to_string(),
                seq,
                operation_id: event_operation_id("blobs", device, object_id, deleted_at),
                kind: "blobs".to_string(),
                object_id: object_id.to_string(),
                deleted_at: deleted_at.to_string(),
                size: None,
                relative_path: None,
                payload_hash: String::new(),
            };
            event.payload_hash = event_payload_hash(&event);
            event
        };
        let past = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let future = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let later_past = (Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
        for event in [
            make_event(1, "h1", &past),
            make_event(2, "h2", &future),
            make_event(3, "h3", &later_past),
        ] {
            storage
                .put(&event_key(&event), &serde_json::to_vec(&event).unwrap())
                .await
                .unwrap();
        }

        let mut watermark_for = |_: &str| -> Result<u64, SyncError> { Ok(0) };
        let (selected, advances) =
            download_events_after(&storage, &PlainCodec, "blobs", &mut watermark_for)
                .await
                .expect("坏时钟事件不得让事件下载整体失败");
        let seqs: Vec<u64> = selected.iter().map(|event| event.seq).collect();
        assert_eq!(seqs, vec![1, 3], "坏时钟事件被跳过，其余照常消费");
        assert_eq!(advances.len(), 1);
        assert_eq!(advances[0].source_device_id, "event:device-a");
        assert_eq!(
            advances[0].last_applied_offset, 1,
            "seq 水位必须停在坏事件之前，时钟追上后可重新拉取"
        );
    }

    #[tokio::test]
    async fn download_blob_tombstones_after_excludes_bad_entries_from_merge_and_watermark() {
        let storage = MemoryStorage::default();
        let past = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let future = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();

        let mut manifest = BlobTombstones::default();
        manifest.entries.insert(
            "good".to_string(),
            BlobTombstoneEntry {
                deleted_at: past.clone(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        manifest.entries.insert(
            "future".to_string(),
            BlobTombstoneEntry {
                deleted_at: future.clone(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        storage
            .put(
                &blob_device_tombstone_key("device-a"),
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();

        let (merged, advances) = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("单条坏时钟条目不得让 tombstone 下载整体失败");
        assert!(merged.entries.contains_key("good"));
        assert!(
            !merged.entries.contains_key("future"),
            "超前条目必须在下载侧剔除，避免调用方逐条校验时 ? 冒泡 DoS"
        );
        let advance = advances
            .iter()
            .find(|advance| advance.source_device_id == "device-a")
            .expect("有效条目照常推进设备水位");
        assert_eq!(
            advance.last_applied_offset,
            tombstone_offset_from_deleted_at(&past),
            "水位不得被超前条目拉高"
        );
        assert!(
            !advances
                .iter()
                .any(|advance| advance.source_device_id == tombstone_device_path_id("device-a")),
            "短哈希文件名不得当成水位设备 ID"
        );
    }

    #[test]
    fn tombstone_watermark_source_uses_content_device_id() {
        let hashed_key = blob_device_tombstone_key("device-a");
        let legacy_key = blob_device_tombstone_legacy_key("device-a");
        assert_eq!(
            source_device_from_tombstone_entries(&hashed_key, BLOB_TOMBSTONE_PREFIX, ["device-a"])
                .expect("短哈希路径应还原完整 device_id"),
            "device-a"
        );
        assert_eq!(
            source_device_from_tombstone_entries(&legacy_key, BLOB_TOMBSTONE_PREFIX, ["device-a"])
                .expect("旧明文路径仍按完整 device_id 记账"),
            "device-a"
        );
        assert!(source_device_from_tombstone_entries(
            &hashed_key,
            BLOB_TOMBSTONE_PREFIX,
            ["device-b"]
        )
        .is_err());
        assert!(source_device_from_tombstone_entries(
            &hashed_key,
            BLOB_TOMBSTONE_PREFIX,
            ["device-a", "device-b"]
        )
        .is_err());
        assert!(
            source_device_from_tombstone_entries(&hashed_key, BLOB_TOMBSTONE_PREFIX, [""]).is_err()
        );
    }

    #[tokio::test]
    async fn download_blob_tombstones_after_reads_legacy_raw_name_as_same_device() {
        let storage = MemoryStorage::default();
        let past = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let mut manifest = BlobTombstones::default();
        manifest.entries.insert(
            "legacy-good".to_string(),
            BlobTombstoneEntry {
                deleted_at: past.clone(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        storage
            .put(
                &blob_device_tombstone_legacy_key("device-a"),
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();

        let (_, advances) = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("旧明文 tombstone 名必须仍计入同一设备水位");
        assert_eq!(advances.len(), 1);
        assert_eq!(advances[0].source_device_id, "device-a");
        assert_eq!(
            advances[0].last_applied_offset,
            tombstone_offset_from_deleted_at(&past)
        );
    }

    #[tokio::test]
    async fn download_blob_tombstones_after_rejects_path_content_mismatch() {
        let storage = MemoryStorage::default();
        let past = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let mut manifest = BlobTombstones::default();
        manifest.entries.insert(
            "spoof".to_string(),
            BlobTombstoneEntry {
                deleted_at: past,
                device_id: "device-b".to_string(),
                size: None,
                relative_path: None,
            },
        );
        storage
            .put(
                &blob_device_tombstone_key("device-a"),
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();

        let err = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect_err("路径短哈希与内容 device_id 不一致必须 fail-closed");
        let message = err.to_string();
        assert!(message.contains("路径与内容"), "实际错误: {message}");
    }

    #[test]
    fn tombstone_device_keys_use_short_hash_not_raw_id() {
        let hashed = tombstone_device_path_id("device-a");
        assert_eq!(hashed.len(), 16);
        assert_ne!(hashed, "device-a");
        assert_eq!(
            blob_device_tombstone_key("device-a"),
            format!("data_governance/tombstones/blobs/{hashed}.json")
        );
        assert_eq!(
            blob_device_tombstone_legacy_key("device-a"),
            "data_governance/tombstones/blobs/device-a.json"
        );
        assert!(event_key_matches(
            &TombstoneEvent {
                format_version: 4,
                device_id: "device-a".to_string(),
                seq: 1,
                operation_id: "op".to_string(),
                kind: "blobs".to_string(),
                object_id: "h".to_string(),
                deleted_at: "2026-01-01T00:00:00Z".to_string(),
                size: None,
                relative_path: None,
                payload_hash: String::new(),
            },
            &format!(
                "data_governance/tombstone-events/blobs/device-a/00000000000000000001-op.json"
            )
        ));
    }

    #[tokio::test]
    async fn download_own_blob_tombstone_reads_legacy_raw_name() {
        let storage = MemoryStorage::default();
        let mut manifest = BlobTombstones::default();
        manifest.entries.insert(
            "legacy-hash".to_string(),
            BlobTombstoneEntry {
                deleted_at: "2026-08-01T00:00:00Z".to_string(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        storage
            .put(
                &blob_device_tombstone_legacy_key("device-a"),
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();

        let loaded = download_blob_tombstones_for_device(&storage, &PlainCodec, "device-a")
            .await
            .expect("旧明文 tombstone 名必须仍可读");
        assert!(loaded.entries.contains_key("legacy-hash"));
    }

    #[tokio::test]
    async fn upload_blob_tombstone_migrates_legacy_raw_name() {
        let storage = MemoryStorage::default();
        let mut old = BlobTombstones::default();
        old.entries.insert(
            "old".to_string(),
            BlobTombstoneEntry {
                deleted_at: "2026-08-01T00:00:00Z".to_string(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        storage
            .put(
                &blob_device_tombstone_legacy_key("device-a"),
                &serde_json::to_vec(&old).unwrap(),
            )
            .await
            .unwrap();

        let mut next = BlobTombstones::default();
        next.entries.insert(
            "new".to_string(),
            BlobTombstoneEntry {
                deleted_at: "2026-08-02T00:00:00Z".to_string(),
                device_id: "device-a".to_string(),
                size: None,
                relative_path: None,
            },
        );
        let hashed = blob_device_tombstone_key("device-a");
        storage
            .put(&hashed, &serde_json::to_vec(&next).unwrap())
            .await
            .unwrap();
        delete_legacy_device_tombstone(
            &storage,
            &hashed,
            &blob_device_tombstone_legacy_key("device-a"),
        )
        .await;

        assert!(storage.get(&hashed).await.unwrap().is_some());
        assert!(
            storage
                .get(&blob_device_tombstone_legacy_key("device-a"))
                .await
                .unwrap()
                .is_none(),
            "写入短哈希清单后应删除旧明文名"
        );
    }

    #[tokio::test]
    async fn publish_events_continues_seq_from_legacy_raw_prefix() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = MemoryStorage::default();
        let device = "r12-tomb-seq-continue-device".to_string();
        let operation_id = event_operation_id("blobs", &device, "old-obj", "2026-08-01T00:00:00Z");
        let mut existing = TombstoneEvent {
            format_version: 4,
            device_id: device.clone(),
            seq: 1,
            operation_id: operation_id.clone(),
            kind: "blobs".to_string(),
            object_id: "old-obj".to_string(),
            deleted_at: "2026-08-01T00:00:00Z".to_string(),
            size: None,
            relative_path: None,
            payload_hash: String::new(),
        };
        existing.payload_hash = event_payload_hash(&existing);
        storage
            .put(
                &event_legacy_key(&existing),
                &serde_json::to_vec(&existing).unwrap(),
            )
            .await
            .unwrap();

        publish_events(
            &storage,
            &PlainCodec,
            &device,
            "blobs",
            vec![(
                "new-obj".to_string(),
                "2026-08-02T00:00:00Z".to_string(),
                None,
                None,
            )],
        )
        .await
        .expect("旧明文事件前缀必须计入 cloud max seq");

        let hashed_keys = storage
            .list(&event_device_prefix("blobs", &device))
            .await
            .unwrap();
        assert_eq!(hashed_keys.len(), 1, "{hashed_keys:?}");
        assert_eq!(event_seq_from_key(&hashed_keys[0].key), Some(2));

        let downloaded = download_events(&storage, &PlainCodec, "blobs")
            .await
            .expect("新旧事件路径必须作为同一设备流被接受");
        assert_eq!(downloaded.len(), 2);
        assert_eq!(downloaded[0].seq, 1);
        assert_eq!(downloaded[1].seq, 2);
    }

    // ------------------------------------------------------------------
    // R7 双写交错：upload_* 是「不可变事件（v4）→ 每设备清单（v3）」的双写。
    // 事件已落、清单未落的撕裂窗口内发生第二次调用（同设备重试 / 追加 /
    // 另一设备完整双写 / 冲突改写）时，必须满足：
    // - 同 operation_id 绝不产生第二个事件或新 seq（幂等重绑）；
    // - 每设备事件流保持无断层连续，追加条目 seq 单调 +1；
    // - 撕裂窗口内删除意图已对 v4 消费方可见（事件权威）；
    // - 同 key 不同内容的改写 fail-closed，云端保留原始事件。
    // ------------------------------------------------------------------

    use crate::models::{AppError, AppErrorType};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// 撕裂双写注入：开关打开时每设备清单 PUT 直接失败，事件路径不受影响。
    /// 模拟双写第一步（不可变事件）已落、第二步（v3 清单）未落的窗口。
    struct TornManifestPut {
        inner: MemoryStorage,
        fail_manifest_puts: AtomicBool,
    }

    impl TornManifestPut {
        fn failing() -> Self {
            Self {
                inner: MemoryStorage::default(),
                fail_manifest_puts: AtomicBool::new(true),
            }
        }

        fn heal(&self) {
            self.fail_manifest_puts.store(false, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl CloudStorage for TornManifestPut {
        fn provider_name(&self) -> &'static str {
            "memory-torn-tombstone-manifest"
        }
        async fn check_connection(&self) -> StorageResult<()> {
            Ok(())
        }
        async fn put(&self, key: &str, data: &[u8]) -> StorageResult<()> {
            if key.starts_with("data_governance/tombstones/")
                && self.fail_manifest_puts.load(Ordering::SeqCst)
            {
                return Err(AppError::new(
                    AppErrorType::Network,
                    "注入：每设备 tombstone 清单 PUT 失败（撕裂双写窗口）",
                ));
            }
            CloudStorage::put(&self.inner, key, data).await
        }
        async fn get(&self, key: &str) -> StorageResult<Option<Vec<u8>>> {
            CloudStorage::get(&self.inner, key).await
        }
        async fn list(&self, prefix: &str) -> StorageResult<Vec<FileInfo>> {
            CloudStorage::list(&self.inner, prefix).await
        }
        async fn delete(&self, key: &str) -> StorageResult<()> {
            CloudStorage::delete(&self.inner, key).await
        }
        async fn stat(&self, key: &str) -> StorageResult<Option<FileInfo>> {
            CloudStorage::stat(&self.inner, key).await
        }
    }

    #[tokio::test]
    async fn torn_blob_dual_write_retry_converges_without_duplicate_event() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = TornManifestPut::failing();
        let device = "r7-tomb-torn-retry-device";
        let hash = "aa".repeat(32);

        // 第一次调用：事件落地后清单 PUT 失败 → 整体 fail-closed。
        let error = upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device,
            sample_blob_tombstones(device),
        )
        .await
        .expect_err("清单 PUT 失败必须让 upload 整体报错");
        assert!(
            error.to_string().contains("blob tombstone 清单 上传失败"),
            "拒绝原因必须指向清单上传，实际: {error}"
        );

        // 撕裂态：恰有一条事件、无清单。
        let event_keys = storage
            .inner
            .list(&event_device_prefix("blobs", device))
            .await
            .unwrap();
        assert_eq!(event_keys.len(), 1, "撕裂窗口内事件恰一条: {event_keys:?}");
        assert_eq!(event_seq_from_key(&event_keys[0].key), Some(1));
        assert!(
            storage
                .inner
                .get(&blob_device_tombstone_key(device))
                .await
                .unwrap()
                .is_none(),
            "清单不得在撕裂窗口内出现"
        );

        // 撕裂窗口内 v4 双读消费方已能看到删除意图（事件权威，删除不丢）。
        let merged = download_blob_tombstones(&storage, &PlainCodec)
            .await
            .expect("撕裂态不得让 v4 双读失败");
        assert!(
            merged.entries.contains_key(&hash),
            "事件已落即删除意图可见，清单缺失不得掩盖"
        );

        // 第二次调用（重试交错）：同 operation_id 幂等重绑，无第二个事件。
        storage.heal();
        upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device,
            sample_blob_tombstones(device),
        )
        .await
        .expect("清单恢复可写后重试必须收敛");

        let event_keys = storage
            .inner
            .list(&event_device_prefix("blobs", device))
            .await
            .unwrap();
        assert_eq!(
            event_keys.len(),
            1,
            "同 operation_id 重试不得产生第二个事件: {event_keys:?}"
        );
        assert_eq!(event_seq_from_key(&event_keys[0].key), Some(1));
        assert!(
            storage
                .inner
                .get(&blob_device_tombstone_key(device))
                .await
                .unwrap()
                .is_some(),
            "重试后清单必须落地"
        );

        let (merged, advances) = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("收敛后的事件流必须无断层可消费");
        assert_eq!(merged.entries.len(), 1, "同一删除只出现一次");
        assert!(
            advances.iter().any(|advance| {
                advance.source_device_id == format!("event:{device}")
                    && advance.last_applied_offset == 1
            }),
            "事件水位推进到 seq=1: {advances:?}"
        );
    }

    #[tokio::test]
    async fn interleaved_blob_dual_writes_extend_stream_without_gap_or_duplicate() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = TornManifestPut::failing();
        let device = "r7-tomb-interleave-extend-device";
        let first_hash = "aa".repeat(32);
        let second_hash = "bb".repeat(32);

        // 第一次调用 {X}：事件 seq=1 已落，清单失败（撕裂）。
        upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device,
            sample_blob_tombstones(device),
        )
        .await
        .expect_err("撕裂注入下第一次调用必须报错");

        // 撕裂窗口内本地又发生一次删除；第二次调用携带 RMW 合并后的 {X, Y}。
        storage.heal();
        let mut merged_manifest = sample_blob_tombstones(device);
        merged_manifest.entries.insert(
            second_hash.clone(),
            BlobTombstoneEntry {
                deleted_at: "2026-08-02T00:00:00Z".to_string(),
                device_id: device.to_string(),
                size: None,
                relative_path: None,
            },
        );
        upload_blob_tombstones(&storage, &PlainCodec, device, merged_manifest)
            .await
            .expect("交错追加的第二次调用必须成功");

        // X 保持 seq=1（幂等重绑），Y 顺延 seq=2；流无断层、无重复。
        let events = download_events(&storage.inner, &PlainCodec, "blobs")
            .await
            .expect("交错后事件流必须可完整下载");
        assert_eq!(events.len(), 2, "恰两条事件: {events:?}");
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[0].object_id, first_hash);
        assert_eq!(events[1].seq, 2);
        assert_eq!(events[1].object_id, second_hash);

        let (merged, advances) = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("交错后的双读必须无断层");
        assert!(merged.entries.contains_key(&first_hash));
        assert!(merged.entries.contains_key(&second_hash));
        assert!(
            advances.iter().any(|advance| {
                advance.source_device_id == format!("event:{device}")
                    && advance.last_applied_offset == 2
            }),
            "事件水位推进到 seq=2: {advances:?}"
        );
    }

    #[tokio::test]
    async fn cross_device_dual_write_interleaving_keeps_streams_independent() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = TornManifestPut::failing();
        let device_a = "r7-tomb-cross-device-a";
        let device_b = "r7-tomb-cross-device-b";

        // A 撕裂：事件已落、清单未落。
        upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device_a,
            sample_blob_tombstones(device_a),
        )
        .await
        .expect_err("A 的撕裂调用必须报错");

        // B 的完整双写落在 A 的撕裂窗口内。
        storage.heal();
        let mut manifest_b = BlobTombstones::default();
        manifest_b.entries.insert(
            "bb".repeat(32),
            BlobTombstoneEntry {
                deleted_at: "2026-08-02T00:00:00Z".to_string(),
                device_id: device_b.to_string(),
                size: None,
                relative_path: None,
            },
        );
        upload_blob_tombstones(&storage, &PlainCodec, device_b, manifest_b)
            .await
            .expect("B 的完整双写不受 A 撕裂影响");

        // A 重试收敛。
        upload_blob_tombstones(
            &storage,
            &PlainCodec,
            device_a,
            sample_blob_tombstones(device_a),
        )
        .await
        .expect("A 重试必须收敛");

        // 两台设备各自恰一条事件、seq 均为 1（每设备独立流，互不扰动）。
        for device in [device_a, device_b] {
            let keys = storage
                .inner
                .list(&event_device_prefix("blobs", device))
                .await
                .unwrap();
            assert_eq!(keys.len(), 1, "设备 {device} 事件恰一条: {keys:?}");
            assert_eq!(event_seq_from_key(&keys[0].key), Some(1));
        }

        let (merged, advances) = download_blob_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("跨设备交错后的双读必须无断层");
        assert!(merged.entries.contains_key(&"aa".repeat(32)));
        assert!(merged.entries.contains_key(&"bb".repeat(32)));
        for device in [device_a, device_b] {
            assert!(
                advances.iter().any(|advance| {
                    advance.source_device_id == format!("event:{device}")
                        && advance.last_applied_offset == 1
                }),
                "设备 {device} 事件水位独立推进到 1: {advances:?}"
            );
        }
    }

    #[tokio::test]
    async fn torn_asset_dual_write_retry_converges_without_duplicate_event() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = TornManifestPut::failing();
        let device = "r7-tomb-torn-asset-device";
        let object = "active/images/r7-torn.png";
        let mut manifest = AssetTombstones::default();
        manifest.entries.insert(
            object.to_string(),
            AssetTombstoneEntry {
                deleted_at: "2026-08-01T00:00:00Z".to_string(),
                device_id: device.to_string(),
                size: Some(3),
            },
        );

        let error = upload_asset_tombstones(&storage, &PlainCodec, device, manifest.clone())
            .await
            .expect_err("asset 清单 PUT 失败必须让 upload 整体报错");
        assert!(
            error.to_string().contains("asset tombstone 清单 上传失败"),
            "拒绝原因必须指向 asset 清单上传，实际: {error}"
        );
        assert!(
            storage
                .inner
                .get(&asset_device_tombstone_key(device))
                .await
                .unwrap()
                .is_none(),
            "asset 清单不得在撕裂窗口内出现"
        );

        storage.heal();
        upload_asset_tombstones(&storage, &PlainCodec, device, manifest)
            .await
            .expect("asset 重试必须收敛");

        let keys = storage
            .inner
            .list(&event_device_prefix("assets", device))
            .await
            .unwrap();
        assert_eq!(keys.len(), 1, "asset 事件不得因重试而重复: {keys:?}");
        assert_eq!(event_seq_from_key(&keys[0].key), Some(1));

        let (merged, advances) = download_asset_tombstones_after(&storage, &PlainCodec, |_| Ok(0))
            .await
            .expect("asset 收敛后的双读必须无断层");
        assert_eq!(merged.entries.len(), 1);
        assert_eq!(merged.entries[object].size, Some(3));
        assert!(
            advances.iter().any(|advance| {
                advance.source_device_id == format!("event:{device}")
                    && advance.last_applied_offset == 1
            }),
            "asset 事件水位推进到 seq=1: {advances:?}"
        );
    }

    #[tokio::test]
    async fn conflicting_same_operation_rewrite_fails_closed_and_keeps_original_event() {
        let _db_guard = super::super::state::test_write_lock().lock().await;
        let storage = MemoryStorage::default();
        let device = "r7-tomb-conflicting-rewrite-device";
        let hash = "cc".repeat(32);
        let deleted_at = "2026-08-03T00:00:00Z";

        let mut original = BlobTombstones::default();
        original.entries.insert(
            hash.clone(),
            BlobTombstoneEntry {
                deleted_at: deleted_at.to_string(),
                device_id: device.to_string(),
                size: None,
                relative_path: None,
            },
        );
        upload_blob_tombstones(&storage, &PlainCodec, device, original)
            .await
            .expect("第一次双写必须成功");
        let manifest_bytes_after_first = storage
            .get(&blob_device_tombstone_key(device))
            .await
            .unwrap()
            .expect("第一次双写后清单必须存在");

        // 交错的第二次调用改写同一 operation（同 object_id + deleted_at，
        // 但 size 不同）→ 同 key 内容不同，必须 fail-closed。
        let mut conflicting = BlobTombstones::default();
        conflicting.entries.insert(
            hash.clone(),
            BlobTombstoneEntry {
                deleted_at: deleted_at.to_string(),
                device_id: device.to_string(),
                size: Some(7),
                relative_path: None,
            },
        );
        let error = upload_blob_tombstones(&storage, &PlainCodec, device, conflicting)
            .await
            .expect_err("同 operation 的冲突改写必须被拒绝");
        assert!(
            error.to_string().contains("冲突且内容不同"),
            "拒绝原因必须指向不可变事件冲突，实际: {error}"
        );

        // 云端保留原始事件与原始清单（第二次调用在清单写入前已中止）。
        let events = download_events(&storage, &PlainCodec, "blobs")
            .await
            .expect("冲突被拒后事件流仍完整");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].size, None, "原始事件不得被改写");
        assert_eq!(
            storage
                .get(&blob_device_tombstone_key(device))
                .await
                .unwrap()
                .expect("原始清单必须仍在"),
            manifest_bytes_after_first,
            "冲突改写不得触碰既有清单"
        );
    }
}
