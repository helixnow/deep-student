//! [R12-record-path-names] 记录级变更/清单路径收敛为短哈希。
//!
//! 新写入不再把完整 `device_id` 编进
//! `data_governance/changes/<id>/…`、`v4/shards/<id>/…` 或
//! `data_governance/manifests/<id>.json`。payload / 清单 JSON 仍写完整设备 ID。
//!
//! 读取必须同时认旧明文目录与新短哈希目录，否则会：
//! - 把本机新清单并进「其他设备」；
//! - 把同一设备的新旧分片当成两台设备，seq 缺口 fail-closed。
//!
//! 文件级 `file_manifests/` 与快照路径见同目录 `sync/mod.rs` 单测
//! `file_and_snapshot_keys_are_neutral_ids`。

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{device_id_short_hash, CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    ChangeOperation, DatabaseSyncState, SyncChangeWithData, SyncChangesPayload, SyncManager,
    SyncManifest, SyncTransactionStatus,
};
use deep_student_lib::models::AppError;
use serde_json::json;

type CloudResult<T> = Result<T, AppError>;

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemStorage {
    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(key.to_string(), data);
    }
}

#[async_trait]
impl CloudStorage for MemStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r12-record-path-names"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.put_raw(key, data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(key).cloned())
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
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

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.files.lock().unwrap().get(key).map(|value| FileInfo {
            key: key.to_string(),
            size: value.len() as u64,
            last_modified: Utc::now(),
            etag: None,
        }))
    }
}

fn unique_device(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

fn change(record_id: &str, content: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Insert,
        data: Some(json!({
            "id": record_id,
            "content": content,
            "updated_at": "2026-08-25T00:00:00Z",
        })),
        changed_at: "2026-08-25T00:00:00Z".to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

fn hashed_change_prefix(device_id: &str) -> String {
    format!(
        "data_governance/changes/{}/",
        device_id_short_hash(device_id)
    )
}

fn hashed_manifest_key(device_id: &str) -> String {
    format!(
        "data_governance/manifests/{}.json",
        device_id_short_hash(device_id)
    )
}

fn legacy_manifest_key(device_id: &str) -> String {
    format!("data_governance/manifests/{device_id}.json")
}

fn sample_manifest(device_id: &str, data_version: u64, published_max_seq: u64) -> SyncManifest {
    let mut databases = HashMap::new();
    databases.insert(
        "vfs".to_string(),
        DatabaseSyncState {
            schema_version: 1,
            data_version,
            checksum: "abc".to_string(),
            last_updated_at: None,
        },
    );
    SyncManifest {
        sync_transaction_id: format!("tx-{device_id}"),
        databases,
        status: SyncTransactionStatus::Complete,
        created_at: "2026-08-25T00:00:00Z".to_string(),
        device_id: device_id.to_string(),
        format_version: 4,
        published_max_seq,
        cursors: HashMap::new(),
        superseded_by: None,
        snapshot_seen: HashMap::new(),
    }
}

fn plant_v3_change(
    storage: &MemStorage,
    path_device: &str,
    payload_device: &str,
    seq: u64,
    content: &str,
) {
    let key = format!(
        "data_governance/changes/{}/{:012}-{}-{}.json.zst",
        path_device,
        seq,
        Utc::now().timestamp(),
        uuid::Uuid::new_v4()
    );
    let payload = SyncChangesPayload {
        total_count: 1,
        changes: vec![change(&format!("r{seq}"), content)],
        device_id: payload_device.to_string(),
        format_version: 3,
        source_seq: seq,
        source_device_id: payload_device.to_string(),
        operation_id: None,
    };
    let json = serde_json::to_vec(&payload).unwrap();
    let compressed = zstd::stream::encode_all(std::io::Cursor::new(json), 0).unwrap();
    storage.put_raw(&key, compressed);
}

#[tokio::test]
async fn new_upload_uses_hashed_change_and_manifest_names() {
    let storage = MemStorage::default();
    let device = unique_device("r12-rec-src");
    let manager = SyncManager::new(device.clone());

    manager
        .upload_enriched_changes(&storage, &[change("n1", "hashed-write")], None)
        .await
        .expect("upload changes");
    manager
        .upload_manifest(&storage, &sample_manifest(&device, 3, 0))
        .await
        .expect("upload manifest");

    let hashed_changes = storage.keys_with_prefix(&hashed_change_prefix(&device));
    assert_eq!(hashed_changes.len(), 1, "{hashed_changes:?}");
    assert!(
        !hashed_changes[0].contains(&device),
        "新变更路径不得含明文 device_id: {}",
        hashed_changes[0]
    );

    let raw_changes = storage.keys_with_prefix(&format!("data_governance/changes/{device}/"));
    assert!(
        raw_changes.is_empty(),
        "不得再写旧明文变更目录: {raw_changes:?}"
    );

    assert!(
        storage
            .get(&hashed_manifest_key(&device))
            .await
            .unwrap()
            .is_some(),
        "新清单应写短哈希文件名"
    );
    assert!(
        storage
            .get(&legacy_manifest_key(&device))
            .await
            .unwrap()
            .is_none(),
        "新上传不得留下旧明文清单名"
    );
}

#[tokio::test]
async fn new_client_reads_legacy_raw_change_and_manifest() {
    let storage = MemStorage::default();
    let peer = unique_device("r12-rec-legacy-peer");
    plant_v3_change(&storage, &peer, &peer, 1, "legacy-raw");
    storage.put_raw(
        &legacy_manifest_key(&peer),
        serde_json::to_vec(&sample_manifest(&peer, 9, 1)).unwrap(),
    );

    let local = SyncManager::new(unique_device("r12-rec-legacy-local"));
    let downloaded = local
        .download_changes(&storage, 0, None)
        .await
        .expect("new client must read old raw-path changes");
    assert_eq!(downloaded.changes.len(), 1);
    assert_eq!(
        downloaded.changes[0].data.as_ref().unwrap()["content"],
        json!("legacy-raw")
    );

    let merged = local
        .download_manifest(&storage)
        .await
        .expect("new client must merge old raw-name manifest");
    assert_eq!(merged.databases["vfs"].data_version, 9);
}

#[tokio::test]
async fn download_skips_own_hashed_change_and_manifest() {
    let storage = MemStorage::default();
    let device = unique_device("r12-rec-self");
    let manager = SyncManager::new(device.clone());
    manager
        .upload_enriched_changes(&storage, &[change("self-1", "own")], None)
        .await
        .unwrap();
    manager
        .upload_manifest(&storage, &sample_manifest(&device, 4, 0))
        .await
        .unwrap();

    let own_download = manager
        .download_changes(&storage, 0, None)
        .await
        .expect("own hashed shards must be skipped, not consumed as foreign");
    assert!(
        own_download.changes.is_empty(),
        "本机不得把自己的新短哈希分片当别人的: {:?}",
        own_download.changes
    );

    let own_manifest = manager
        .download_manifest(&storage)
        .await
        .expect("own hashed manifest must not merge as another device");
    assert!(
        own_manifest.databases.is_empty(),
        "本机短哈希清单不得并进其他设备: {:?}",
        own_manifest.databases
    );

    let peer = SyncManager::new(unique_device("r12-rec-peer"));
    let peer_download = peer.download_changes(&storage, 0, None).await.unwrap();
    assert_eq!(peer_download.changes.len(), 1);
    let peer_manifest = peer.download_manifest(&storage).await.unwrap();
    assert_eq!(peer_manifest.databases["vfs"].data_version, 4);
}

#[tokio::test]
async fn upload_manifest_migrates_legacy_raw_name() {
    let storage = MemStorage::default();
    let device = unique_device("r12-rec-migrate");
    storage.put_raw(
        &legacy_manifest_key(&device),
        serde_json::to_vec(&sample_manifest(&device, 2, 0)).unwrap(),
    );

    let manager = SyncManager::new(device.clone());
    manager
        .upload_manifest(&storage, &sample_manifest(&device, 5, 0))
        .await
        .unwrap();

    assert!(storage
        .get(&hashed_manifest_key(&device))
        .await
        .unwrap()
        .is_some());
    assert!(
        storage
            .get(&legacy_manifest_key(&device))
            .await
            .unwrap()
            .is_none(),
        "写入短哈希清单后应删除旧明文名"
    );
}

#[tokio::test]
async fn mixed_raw_and_hashed_shards_are_one_device_stream() {
    let storage = MemStorage::default();
    let peer = unique_device("r12-rec-mixed");
    plant_v3_change(&storage, &peer, &peer, 1, "raw-seq1");

    let uploader = SyncManager::new(peer.clone());
    uploader
        .upload_enriched_changes(&storage, &[change("r2", "hashed-seq2")], None)
        .await
        .expect("seq2 should continue after raw seq1");

    let hashed = storage.keys_with_prefix(&hashed_change_prefix(&peer));
    assert_eq!(hashed.len(), 1, "新分片应写短哈希目录: {hashed:?}");
    let raw = storage.keys_with_prefix(&format!("data_governance/changes/{peer}/"));
    assert_eq!(raw.len(), 1, "旧明文 seq1 仍在: {raw:?}");

    let local = SyncManager::new(unique_device("r12-rec-mixed-dst"));
    let downloaded = local
        .download_changes(&storage, 0, None)
        .await
        .expect("raw+hashed prefixes of one device must be one seq stream");
    assert_eq!(downloaded.changes.len(), 2, "{:?}", downloaded.changes);
    let contents: Vec<_> = downloaded
        .changes
        .iter()
        .map(|c| {
            c.data.as_ref().unwrap()["content"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert!(contents.contains(&"raw-seq1".to_string()));
    assert!(contents.contains(&"hashed-seq2".to_string()));
}

#[tokio::test]
async fn hashed_payload_device_id_still_full_and_readable() {
    let storage = MemStorage::default();
    let device = unique_device("r12-rec-payload");
    let manager = SyncManager::new(device.clone());
    manager
        .upload_enriched_changes(&storage, &[change("p1", "inside")], None)
        .await
        .unwrap();

    let keys = storage.keys_with_prefix(&hashed_change_prefix(&device));
    let bytes = storage.get(&keys[0]).await.unwrap().unwrap();
    let decoded = zstd::stream::decode_all(std::io::Cursor::new(bytes)).unwrap();
    let payload: SyncChangesPayload = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(payload.source_device_id, device);
    assert_eq!(payload.device_id, device);
}

struct CorruptManifestPut {
    inner: MemStorage,
}

#[async_trait]
impl CloudStorage for CorruptManifestPut {
    fn provider_name(&self) -> &'static str {
        "memory-corrupt-record-manifest"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        if key.contains("data_governance/manifests/") && key.ends_with(".json") {
            CloudStorage::put(&self.inner, key, b"corrupted-record-manifest").await
        } else {
            CloudStorage::put(&self.inner, key, data).await
        }
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        CloudStorage::get(&self.inner, key).await
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        CloudStorage::list(&self.inner, prefix).await
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        CloudStorage::delete(&self.inner, key).await
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        CloudStorage::stat(&self.inner, key).await
    }
}

#[tokio::test]
async fn upload_manifest_fails_when_reread_mismatches() {
    let storage = CorruptManifestPut {
        inner: MemStorage::default(),
    };
    let device = unique_device("r12-rec-reread");
    let error = SyncManager::new(device.clone())
        .upload_manifest(&storage, &sample_manifest(&device, 1, 0))
        .await
        .expect_err("清单回读不一致必须 fail-closed");
    assert!(
        error
            .to_string()
            .contains("记录级设备清单 上传后回读不一致"),
        "拒绝原因必须指向清单回读，实际: {error}"
    );
    assert!(
        storage
            .inner
            .get(&hashed_manifest_key(&device))
            .await
            .unwrap()
            .is_some(),
        "损坏的最终对象可保留供对照，但不得报成功"
    );
}
