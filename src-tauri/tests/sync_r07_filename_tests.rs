//! [R07-filename-tests → R09-names 改写] 资产 key 跨平台文件名回归测试。
//!
//! R07 版本只锁定当时的缺陷行为（key 原样携带非法字符/大小写变体/NFC-NFD
//! 分裂），并留下两个 `#[ignore]` 的理想行为断言。R09-names 落地净化引擎
//! （`data_governance/sync/asset_filenames.rs`）后，本文件改为锁定新行为：
//!
//! 1. **Windows 非法字符**使用 rclone 风格安全码点编码——云端 key 三平台可
//!    物化，并可由 decoder 无损还原；
//! 2. **大小写冲突**不再静默互相覆盖：与云端既有 key 仅大小写不同的新文件
//!    拒绝上传并在 outcome 报告（原 `#[ignore]` 测试转正）；
//! 3. **Unicode 归一化安全**：NFC/NFD 生成两个互不碰撞的 NFC 安全 key，
//!    两者都可还原原始字节。
//!
//! 更全面的边界矩阵（保留名/尾部点空格/空名回退/遗留 key 迁移等）见
//! `sync_r09_filenames.rs`。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    asset_filenames, AssetDirsManifest, SyncDirection, SyncManager, FILENAME_CONFLICT_MARKER,
};
use deep_student_lib::models::AppError;
use tempfile::TempDir;

// ============================================================================
// 内存云存储（与 sync_r05_regression_tests 同形：可克隆句柄共享底层对象）
// ============================================================================

#[derive(Clone, Default)]
struct MemoryCloudStorage {
    files: Arc<Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>>,
}

impl MemoryCloudStorage {
    fn keys(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }

    fn remove(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }

    fn raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone())
    }
}

#[async_trait]
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r07"
    }

    async fn check_connection(&self) -> Result<(), AppError> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone()))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>, AppError> {
        Ok(self
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
            .collect())
    }

    async fn delete(&self, key: &str) -> Result<(), AppError> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> Result<Option<FileInfo>, AppError> {
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

// ============================================================================
// 辅助
// ============================================================================

fn write_asset(active_dir: &TempDir, relative: &str, content: &[u8]) {
    let path = active_dir.path().join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

async fn sync_bidirectional(
    manager: &SyncManager,
    storage: &MemoryCloudStorage,
    active: &TempDir,
    app_data: &TempDir,
) -> deep_student_lib::data_governance::sync::AssetSyncOutcome {
    manager
        .sync_asset_directories(
            storage,
            active.path(),
            app_data.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect("资产同步不应整体失败")
}

/// 读取云端全部资产清单（明文模式下 payload 即 JSON）并合并出 key 集合。
///
/// 生产的合并逻辑（revision/LWW）对本文件无关紧要：这里只关心 key 是否存在，
/// 因此把所有已发布清单的 entries key 取并集即可。
fn all_manifest_keys(storage: &MemoryCloudStorage) -> Vec<String> {
    let mut keys = std::collections::BTreeSet::new();
    for cloud_key in storage.keys() {
        if !cloud_key.starts_with("data_governance/file_manifests/assets/")
            || !cloud_key.ends_with(".json")
        {
            continue;
        }
        let bytes = storage.raw(&cloud_key).unwrap();
        let manifest: AssetDirsManifest =
            serde_json::from_slice(&bytes).expect("明文模式下资产清单应为 JSON");
        keys.extend(manifest.entries.keys().cloned());
    }
    keys.into_iter().collect()
}

fn unique_device(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

// ============================================================================
// 1. Windows 非法字符 `:` `?`
// ============================================================================

/// [R11-names2 后] Linux 设备创建的含 `:`/`?` 文件名在 key 生成时可逆编码：
/// 云端 key 三平台可物化，第二台设备下载落地安全编码名，且后续同步稳定
/// （无乒乓上传/重复下载）。
#[tokio::test]
async fn r07_windows_reserved_chars_are_sanitized_in_keys_and_roundtrip() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    // `:` 常见于时间戳命名（如 macOS 截图），`?` 见于从 URL 派生的文件名
    write_asset(&active_a, "images/screenshot 12:30:45.png", b"colon-bytes");
    write_asset(&active_a, "documents/page?query=1.pdf", b"question-bytes");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 2, "两个文件都应净化后上传成功");
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let screenshot =
        asset_filenames::encode_segment("screenshot 12:30:45.png").expect("文件名可编码");
    let question = asset_filenames::encode_segment("page?query=1.pdf").expect("文件名可编码");
    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&format!("active/images/{screenshot}")),
        "key 中 `:` 应使用可逆安全码点，实际: {keys:?}"
    );
    assert!(
        keys.contains(&format!("active/documents/{question}")),
        "key 中 `?` 应使用可逆安全码点，实际: {keys:?}"
    );
    assert_eq!(
        asset_filenames::decode_segment(&screenshot).unwrap(),
        "screenshot 12:30:45.png"
    );
    assert_eq!(
        asset_filenames::decode_segment(&question).unwrap(),
        "page?query=1.pdf"
    );

    // 第二台设备下载：落地净化后的文件名（Windows 上同样可行）
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = manager_b
        .sync_asset_directories(
            &storage,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .unwrap();
    assert_eq!(out_b.downloaded, 2);
    assert!(!out_b.has_failures());
    assert_eq!(
        std::fs::read(active_b.path().join("images").join(&screenshot)).unwrap(),
        b"colon-bytes"
    );
    assert_eq!(
        std::fs::read(active_b.path().join("documents").join(&question)).unwrap(),
        b"question-bytes"
    );

    // 设备 B 再做双向同步：净化幂等 → 不产生新 key/乒乓
    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(
        (out_b2.uploaded, out_b2.downloaded),
        (0, 0),
        "编码名再次扫描必须命中同一 key"
    );
    assert!(!out_b2.has_failures(), "{:?}", out_b2.failure_summary());

    // 设备 A（原始带 `:` 文件仍在本地）再同步：可逆 key 匹配 → 同样稳定
    let out_a2 = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(
        (out_a2.uploaded, out_a2.downloaded),
        (0, 0),
        "上传方本地原名文件与云端可逆 key 必须视为同一文件"
    );
    assert!(!out_a2.has_failures(), "{:?}", out_a2.failure_summary());
}

/// 单个资产下载失败（这里用"内容对象缺失"模拟）仍只进入
/// `download_failures`，`sync_asset_directories` 返回 `Ok`——软失败通道保持
/// R07 的可观测语义，key 现在是可逆编码形态。
#[tokio::test]
async fn r07_single_asset_download_failure_is_soft_and_only_visible_in_outcome() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, "images/broken:on-windows.png", b"payload");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 1);

    // 删除内容对象，使下载端 get_file 失败（per-file 容错分支）
    let object_key = storage
        .keys()
        .into_iter()
        .find(|key| key.starts_with("data_governance/asset_objects/"))
        .expect("上传后应存在内容寻址对象");
    storage.remove(&object_key);

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = manager_b
        .sync_asset_directories(
            &storage,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .expect("单文件下载失败不应使整体同步返回 Err");

    assert_eq!(out_b.downloaded, 0);
    let broken = asset_filenames::encode_segment("broken:on-windows.png").unwrap();
    assert_eq!(
        out_b.download_failures,
        vec![format!("active/images/{broken}")],
        "失败必须可在 outcome 中定位到具体可逆 key"
    );
    assert!(
        out_b.has_failures() && out_b.failure_summary().is_some(),
        "调用方唯一的发现渠道是 has_failures()/failure_summary()"
    );
    assert!(
        !active_b.path().join("images").join(&broken).exists(),
        "失败的资产不应留下半成品文件"
    );
}

// ============================================================================
// 2. 大小写碰撞
// ============================================================================

/// [R09-names 后] 与云端既有 key 仅大小写不同的新文件拒绝上传，outcome 给出
/// 带 `[filename-conflict]` 标记的可观测信号；云端清单不出现第二个变体，第三
/// 台设备只物化一个文件——大小写不敏感文件系统上不再互相覆盖/乒乓。
///
/// （原 R07 `#[ignore]` 理想行为测试转正。）
#[tokio::test]
async fn r07_case_insensitive_key_collision_surfaces_a_warning_and_blocks_upload() {
    let storage = MemoryCloudStorage::default();

    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, "images/Logo.png", b"UPPER-variant");
    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 1);

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    write_asset(&active_b, "images/logo.png", b"lower-variant");
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;

    assert_eq!(out_b.uploaded, 0, "大小写冲突的新文件必须拒绝上传");
    assert!(out_b.has_failures(), "冲突必须在 outcome 中给出可观测信号");
    assert!(
        out_b
            .upload_failures
            .iter()
            .chain(out_b.download_failures.iter())
            .any(|message| message.contains(FILENAME_CONFLICT_MARKER)),
        "冲突消息必须带稳定标记供前端映射 i18n: {:?}",
        (&out_b.upload_failures, &out_b.download_failures)
    );
    assert!(
        out_b
            .failure_summary()
            .is_some_and(|summary| summary.contains(FILENAME_CONFLICT_MARKER)),
        "failure_summary 必须携带冲突详情（前端唯一入口）"
    );
    // 设备 B 的本地文件保持原样（未被云端变体覆盖）
    assert_eq!(
        std::fs::read(active_b.path().join("images/logo.png")).unwrap(),
        b"lower-variant"
    );

    // 云端清单只有一个变体
    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&"active/images/Logo.png".to_string()),
        "{keys:?}"
    );
    assert!(
        !keys.contains(&"active/images/logo.png".to_string()),
        "冲突变体不得进入云端清单: {keys:?}"
    );

    // 第三台设备只物化一个文件
    let active_c = TempDir::new().unwrap();
    let app_c = TempDir::new().unwrap();
    let manager_c = SyncManager::new(unique_device("dev-c"));
    let out_c = manager_c
        .sync_asset_directories(
            &storage,
            active_c.path(),
            app_c.path(),
            SyncDirection::Download,
        )
        .await
        .unwrap();
    assert_eq!(out_c.downloaded, 1);
    assert_eq!(
        std::fs::read(active_c.path().join("images/Logo.png")).unwrap(),
        b"UPPER-variant"
    );
    assert!(!active_c.path().join("images/logo.png").exists());
}

// ============================================================================
// 3. Unicode 归一化（NFC / NFD）
// ============================================================================

/// [R11-names2 后] NFC 与 NFD 都生成 NFC 安全 key，但逐字节可逆且互不碰撞。
#[tokio::test]
async fn r07_unicode_normalization_forms_are_distinct_and_reversible() {
    // 同一视觉名字 "café.png" 的两种编码（在源码里用转义写死，防编辑器归一化）
    let nfc_name = "images/caf\u{e9}.png"; // é = U+00E9
    let nfd_name = "images/cafe\u{301}.png"; // e + U+0301 组合重音
    assert_ne!(nfc_name, nfd_name, "两种归一化形态字节必须不同");

    let storage = MemoryCloudStorage::default();

    // 设备 A（模拟 macOS）：NFD 文件名
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, nfd_name, b"same-logical-content");
    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 1);

    // 设备 B（模拟 Linux/Windows）：NFC 文件名，内容相同
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    write_asset(&active_b, nfc_name, b"same-logical-content");
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;

    assert_eq!((out_b.uploaded, out_b.downloaded), (1, 1));
    assert!(!out_b.has_failures(), "{:?}", out_b.failure_summary());

    let encoded_nfc = asset_filenames::encode_segment("caf\u{e9}.png").unwrap();
    let encoded_nfd = asset_filenames::encode_segment("cafe\u{301}.png").unwrap();
    assert_ne!(encoded_nfc, encoded_nfd);
    assert_eq!(
        asset_filenames::decode_segment(&encoded_nfc).unwrap(),
        "caf\u{e9}.png"
    );
    assert_eq!(
        asset_filenames::decode_segment(&encoded_nfd).unwrap(),
        "cafe\u{301}.png"
    );

    // NFC 原文件保留，NFD 云端条目以安全编码名下载。
    assert!(active_b.path().join(nfc_name).exists());
    assert!(
        active_b.path().join("images").join(&encoded_nfd).exists(),
        "NFD 变体必须以 NFC 安全编码名独立物化"
    );

    // 云端清单同时保留两个无损 key。
    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&format!("active/images/{encoded_nfc}"))
            && keys.contains(&format!("active/images/{encoded_nfd}")),
        "NFC/NFD key 都必须存在: {keys:?}"
    );
}
