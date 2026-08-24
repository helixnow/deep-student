//! [R09-names] 资产文件名跨平台净化的全边界集成测试。
//!
//! 覆盖 `asset_filenames` 净化引擎接入 `sync_asset_directories*` 后的行为矩阵：
//!
//! 1. Windows 非法字符 `* ? " < > | :` → `_`（`\` 在 scan 阶段已被视为路径
//!    分隔符，见 `scan_asset_tree` 的 `replace('\\', "/")`，单元测试另行覆盖）；
//! 2. Windows 保留设备名 CON/PRN/AUX/NUL/COM1/LPT1（含带扩展名形式）；
//! 3. 尾部点/空格去除；
//! 4. 空名（全点名）确定性回退 `unnamed-<hash>`；
//! 5. 本地净化重名（`file.` vs `file`）确定性保留一方并报告；
//! 6. 本地大小写冲突确定性保留一方并报告；
//! 7. 净化前遗留云端 key：下载落地净化路径、无乒乓、用户可读名映射不丢；
//! 8. 遗留 key 在内容更新时迁移为净化 key（新发布的清单不再含旧名）；
//! 9. 云端净化重名且被遮蔽方更新时显式报告；
//! 10. 用户可读名（中文/空格/括号）端到端往返不变；
//! 11. `failure_summary` 携带 `[filename-conflict]` 稳定标记（前端 i18n 入口）。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    AssetDirsManifest, AssetFileEntry, AssetSyncOutcome, SyncDirection, SyncManager,
    FILENAME_CONFLICT_MARKER,
};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

// ============================================================================
// 内存云存储（与 sync_r07_filename_tests 同形）
// ============================================================================

#[derive(Clone, Default)]
struct MemoryCloudStorage {
    files: Arc<Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>>,
}

impl MemoryCloudStorage {
    fn keys(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }

    fn raw(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone())
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data, Utc::now()));
    }
}

#[async_trait]
impl CloudStorage for MemoryCloudStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r09"
    }

    async fn check_connection(&self) -> Result<(), AppError> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        self.put_raw(key, data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self.raw(key))
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

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn unique_device(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

async fn sync_bidirectional(
    manager: &SyncManager,
    storage: &MemoryCloudStorage,
    active: &TempDir,
    app_data: &TempDir,
) -> AssetSyncOutcome {
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

async fn sync_download(
    manager: &SyncManager,
    storage: &MemoryCloudStorage,
    active: &TempDir,
    app_data: &TempDir,
) -> AssetSyncOutcome {
    manager
        .sync_asset_directories(
            storage,
            active.path(),
            app_data.path(),
            SyncDirection::Download,
        )
        .await
        .expect("资产同步不应整体失败")
}

/// 所有已发布清单 entries key 的并集（明文模式下 payload 即 JSON）。
fn all_manifest_keys(storage: &MemoryCloudStorage) -> Vec<String> {
    let mut keys = std::collections::BTreeSet::new();
    for manifest in all_manifests(storage) {
        keys.extend(manifest.entries.keys().cloned());
    }
    keys.into_iter().collect()
}

fn all_manifests(storage: &MemoryCloudStorage) -> Vec<AssetDirsManifest> {
    storage
        .keys()
        .into_iter()
        .filter(|key| {
            key.starts_with("data_governance/file_manifests/assets/") && key.ends_with(".json")
        })
        .map(|key| {
            serde_json::from_slice(&storage.raw(&key).unwrap())
                .expect("明文模式下资产清单应为 JSON")
        })
        .collect()
}

/// 直接向云端种一份「净化前时代」的遗留清单（entries 使用原始未净化 key）。
fn seed_legacy_manifest(
    storage: &MemoryCloudStorage,
    device: &str,
    entries: &[(&str, &[u8], &str)], // (key, content, updated_at)
) {
    let mut manifest = AssetDirsManifest::default();
    for (key, content, updated_at) in entries {
        let sha = sha256_hex(content);
        let object_key = format!("data_governance/asset_objects/{sha}");
        storage.put_raw(&object_key, content.to_vec());
        manifest.entries.insert(
            (*key).to_string(),
            AssetFileEntry {
                sha256: sha,
                size: content.len() as u64,
                updated_at: (*updated_at).to_string(),
                object_key: Some(object_key),
                base_sha256: None,
                revision: 1,
                device_id: Some(device.to_string()),
                cipher_sha256: None,
                cipher_size: None,
            },
        );
        if *updated_at > manifest.updated_at.as_str() {
            manifest.updated_at = (*updated_at).to_string();
        }
    }
    storage.put_raw(
        &format!("data_governance/file_manifests/assets/{device}/1-seed.json"),
        serde_json::to_vec(&manifest).unwrap(),
    );
}

fn conflict_messages(outcome: &AssetSyncOutcome) -> Vec<&String> {
    outcome
        .upload_failures
        .iter()
        .chain(outcome.download_failures.iter())
        .filter(|message| message.contains(FILENAME_CONFLICT_MARKER))
        .collect()
}

// ============================================================================
// 1. Windows 非法字符全集
// ============================================================================

#[tokio::test]
async fn r09_illegal_chars_full_set_sanitize_and_roundtrip_without_pingpong() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    let cases = [
        ("images/st*r.png", "images/st_r.png"),
        ("images/qu?estion.png", "images/qu_estion.png"),
        ("images/quo\"te.png", "images/quo_te.png"),
        ("images/le<ss.png", "images/le_ss.png"),
        ("images/gre>ater.png", "images/gre_ater.png"),
        ("images/pi|pe.png", "images/pi_pe.png"),
        ("images/co:lon.png", "images/co_lon.png"),
    ];
    for (raw, _) in &cases {
        write_asset(&active_a, raw, raw.as_bytes());
    }

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, cases.len());
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let keys = all_manifest_keys(&storage);
    for (_, sanitized) in &cases {
        assert!(
            keys.contains(&format!("active/{sanitized}")),
            "期望净化 key active/{sanitized}，实际: {keys:?}"
        );
    }

    // 下载端全部落地净化路径
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, cases.len());
    for (raw, sanitized) in &cases {
        assert_eq!(
            std::fs::read(active_b.path().join(sanitized)).unwrap(),
            raw.as_bytes(),
            "净化路径 {sanitized} 应携带原内容"
        );
    }

    // 双端后续同步均稳定（幂等，无乒乓）
    for (manager, active, app) in [
        (&manager_a, &active_a, &app_a),
        (&manager_b, &active_b, &app_b),
    ] {
        let out = sync_bidirectional(manager, &storage, active, app).await;
        assert_eq!((out.uploaded, out.downloaded), (0, 0), "同步必须收敛");
        assert!(!out.has_failures(), "{:?}", out.failure_summary());
    }
}

// ============================================================================
// 2. Windows 保留设备名
// ============================================================================

#[tokio::test]
async fn r09_windows_reserved_names_get_stem_suffix_and_roundtrip() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    let cases = [
        ("documents/CON.txt", "documents/CON_.txt"),
        ("documents/com1.pdf", "documents/com1_.pdf"),
        ("documents/LPT1", "documents/LPT1_"),
        ("documents/NUL.tar.gz", "documents/NUL_.tar.gz"),
        ("documents/PRN", "documents/PRN_"),
        ("documents/AUX.json", "documents/AUX_.json"),
        // 非保留名不受影响
        ("documents/console.log", "documents/console.log"),
        ("documents/CONTRACT.pdf", "documents/CONTRACT.pdf"),
    ];
    for (raw, _) in &cases {
        write_asset(&active_a, raw, raw.as_bytes());
    }

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, cases.len());
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let keys = all_manifest_keys(&storage);
    for (_, sanitized) in &cases {
        assert!(
            keys.contains(&format!("active/{sanitized}")),
            "期望 key active/{sanitized}，实际: {keys:?}"
        );
    }

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, cases.len());
    for (raw, sanitized) in &cases {
        assert_eq!(
            std::fs::read(active_b.path().join(sanitized)).unwrap(),
            raw.as_bytes()
        );
    }
    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!((out_b2.uploaded, out_b2.downloaded), (0, 0));
    assert!(!out_b2.has_failures(), "{:?}", out_b2.failure_summary());
}

// ============================================================================
// 3. 尾部点/空格
// ============================================================================

#[tokio::test]
async fn r09_trailing_dots_and_spaces_are_stripped_and_roundtrip() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    write_asset(&active_a, "images/report.", b"trailing-dot");
    write_asset(&active_a, "images/draft ", b"trailing-space");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 2);
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let keys = all_manifest_keys(&storage);
    assert!(keys.contains(&"active/images/report".to_string()), "{keys:?}");
    assert!(keys.contains(&"active/images/draft".to_string()), "{keys:?}");

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, 2);
    assert_eq!(
        std::fs::read(active_b.path().join("images/report")).unwrap(),
        b"trailing-dot"
    );
    assert_eq!(
        std::fs::read(active_b.path().join("images/draft")).unwrap(),
        b"trailing-space"
    );
    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!((out_b2.uploaded, out_b2.downloaded), (0, 0));
}

// ============================================================================
// 4. 空名回退
// ============================================================================

#[tokio::test]
async fn r09_all_dot_name_falls_back_deterministically_and_roundtrips() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    write_asset(&active_a, "images/...", b"dots-only");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 1);
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let keys = all_manifest_keys(&storage);
    let fallback_key = keys
        .iter()
        .find(|key| key.starts_with("active/images/unnamed-"))
        .cloned()
        .unwrap_or_else(|| panic!("全点名应回退为 unnamed-<hash>，实际: {keys:?}"));

    // 下载端物化回退名并保持稳定
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, 1);
    let rel = fallback_key.strip_prefix("active/").unwrap();
    assert_eq!(std::fs::read(active_b.path().join(rel)).unwrap(), b"dots-only");

    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(
        (out_b2.uploaded, out_b2.downloaded),
        (0, 0),
        "回退名幂等：再次扫描必须命中同一 key"
    );

    // 上传端重复同步同样稳定（原名文件继续存在）
    let out_a2 = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!((out_a2.uploaded, out_a2.downloaded), (0, 0));
}

// ============================================================================
// 5. 本地净化重名
// ============================================================================

#[tokio::test]
async fn r09_local_files_colliding_after_sanitize_keep_one_deterministically() {
    let storage = MemoryCloudStorage::default();
    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();

    // `file` 与 `file.` 净化后同名；按原始路径字典序保留 `file`
    write_asset(&active, "images/file", b"winner-content");
    write_asset(&active, "images/file.", b"loser-content");

    let manager = SyncManager::new(unique_device("dev-a"));
    let out = sync_bidirectional(&manager, &storage, &active, &app).await;

    assert_eq!(out.uploaded, 1, "净化重名只允许一方上云");
    let conflicts = conflict_messages(&out);
    assert_eq!(conflicts.len(), 1, "另一方必须显式报告: {out:?}");
    assert!(
        conflicts[0].contains("file."),
        "冲突消息应指认被跳过的文件: {}",
        conflicts[0]
    );

    let keys = all_manifest_keys(&storage);
    assert_eq!(
        keys,
        vec!["active/images/file".to_string()],
        "云端只允许出现一个净化 key"
    );
    // 胜方按原始路径字典序确定（`file` < `file.`）
    let manifests = all_manifests(&storage);
    let entry = manifests
        .iter()
        .find_map(|manifest| manifest.entries.get("active/images/file"))
        .unwrap();
    assert_eq!(entry.sha256, sha256_hex(b"winner-content"));
}

// ============================================================================
// 6. 本地大小写冲突
// ============================================================================

#[tokio::test]
async fn r09_local_case_conflict_keeps_one_deterministically_and_reports() {
    let storage = MemoryCloudStorage::default();
    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();

    write_asset(&active, "images/Logo.png", b"UPPER");
    write_asset(&active, "images/logo.png", b"lower");

    let manager = SyncManager::new(unique_device("dev-a"));
    let out = sync_bidirectional(&manager, &storage, &active, &app).await;

    assert_eq!(out.uploaded, 1, "大小写冲突只允许一方上云");
    let conflicts = conflict_messages(&out);
    assert_eq!(conflicts.len(), 1, "{out:?}");

    let keys = all_manifest_keys(&storage);
    assert_eq!(
        keys,
        vec!["active/images/Logo.png".to_string()],
        "无云端在位者时按字典序保留最小 key"
    );
}

// ============================================================================
// 7 & 8. 净化前遗留云端 key：无乒乓 + 内容更新时迁移
// ============================================================================

#[tokio::test]
async fn r09_legacy_unsanitized_cloud_key_lands_sanitized_then_migrates_on_change() {
    let storage = MemoryCloudStorage::default();
    seed_legacy_manifest(
        &storage,
        "legacy-device",
        &[(
            "active/images/pic:1.png",
            b"legacy-content",
            "2020-01-01T00:00:00+00:00",
        )],
    );

    // —— 阶段 1：下载落地净化路径，用户可读名映射（云端原 key）不丢 ——
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, 1);
    assert!(!out_b.has_failures(), "{:?}", out_b.failure_summary());
    assert_eq!(
        std::fs::read(active_b.path().join("images/pic_1.png")).unwrap(),
        b"legacy-content",
        "遗留 key 必须落地到 Windows 可物化的净化路径"
    );

    // —— 阶段 2：内容未变时无乒乓（净化等价匹配，不重复上传/下载）——
    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(
        (out_b2.uploaded, out_b2.downloaded),
        (0, 0),
        "遗留 key 与本地净化文件必须视为同一文件"
    );
    assert!(!out_b2.has_failures(), "{:?}", out_b2.failure_summary());
    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&"active/images/pic:1.png".to_string()),
        "内容未变时不改名：云端保留用户原名映射: {keys:?}"
    );

    // —— 阶段 3：内容更新 → 清单改名迁移为净化 key ——
    std::fs::write(active_b.path().join("images/pic_1.png"), b"updated-content").unwrap();
    let out_b3 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b3.uploaded, 1);
    assert!(!out_b3.has_failures(), "{:?}", out_b3.failure_summary());

    // 新发布的清单：含净化 key、不含遗留 key
    let migrated = all_manifests(&storage)
        .into_iter()
        .find(|manifest| manifest.entries.contains_key("active/images/pic_1.png"))
        .expect("必须存在包含净化 key 的新清单");
    assert!(
        !migrated.entries.contains_key("active/images/pic:1.png"),
        "迁移后的清单不得再携带遗留 key"
    );
    assert_eq!(
        migrated.entries["active/images/pic_1.png"].sha256,
        sha256_hex(b"updated-content")
    );

    // —— 阶段 4：第三台设备只物化净化文件（新内容），无冲突噪音 ——
    let active_c = TempDir::new().unwrap();
    let app_c = TempDir::new().unwrap();
    let manager_c = SyncManager::new(unique_device("dev-c"));
    let out_c = sync_download(&manager_c, &storage, &active_c, &app_c).await;
    assert_eq!(out_c.downloaded, 1);
    assert!(
        !out_c.has_failures(),
        "迁移后残留在旧 append-only 清单中的旧条目不得制造假冲突: {:?}",
        out_c.failure_summary()
    );
    assert_eq!(
        std::fs::read(active_c.path().join("images/pic_1.png")).unwrap(),
        b"updated-content"
    );
    assert!(!active_c.path().join("images/pic:1.png").exists());
}

// ============================================================================
// 9. 云端净化重名且被遮蔽方更新
// ============================================================================

#[tokio::test]
async fn r09_shadowed_newer_divergent_cloud_key_is_reported_not_silently_dropped() {
    let storage = MemoryCloudStorage::default();
    // 已净化 key（旧）与遗留 key（新、内容不同）净化后重名：
    // 代表条目取已净化 key，较新的被遮蔽方必须显式报告。
    seed_legacy_manifest(
        &storage,
        "legacy-device",
        &[
            (
                "active/images/pic_1.png",
                b"canonical-content",
                "2020-01-01T00:00:00+00:00",
            ),
            (
                "active/images/pic:1.png",
                b"newer-divergent-content",
                "2024-06-01T00:00:00+00:00",
            ),
        ],
    );

    let active = TempDir::new().unwrap();
    let app = TempDir::new().unwrap();
    let manager = SyncManager::new(unique_device("dev-a"));
    let out = sync_download(&manager, &storage, &active, &app).await;

    assert_eq!(out.downloaded, 1, "只物化代表条目");
    assert_eq!(
        std::fs::read(active.path().join("images/pic_1.png")).unwrap(),
        b"canonical-content"
    );
    let conflicts = conflict_messages(&out);
    assert_eq!(
        conflicts.len(),
        1,
        "较新的被遮蔽条目必须显式报告: {out:?}"
    );
    assert!(
        conflicts[0].contains("pic:1.png"),
        "冲突消息应指认被遮蔽的 key: {}",
        conflicts[0]
    );
}

// ============================================================================
// 10. 用户可读名端到端往返
// ============================================================================

#[tokio::test]
async fn r09_user_readable_names_survive_roundtrip_unchanged() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    let readable = [
        "images/笔记 图片 (1).png",
        "images/深度-学习_v2.final.png",
        "documents/Lecture Notes 2024.pdf",
        "notes_assets/.hidden-config",
    ];
    for name in &readable {
        write_asset(&active_a, name, name.as_bytes());
    }

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, readable.len());
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    // 云端 key 与用户命名逐字节一致（映射不丢）
    let keys = all_manifest_keys(&storage);
    for name in &readable {
        assert!(
            keys.contains(&format!("active/{name}")),
            "常规可读名必须原样保留: {keys:?}"
        );
    }

    // 第二台设备落地后名字仍逐字节一致，且同步收敛
    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_download(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!(out_b.downloaded, readable.len());
    for name in &readable {
        assert_eq!(
            std::fs::read(active_b.path().join(name)).unwrap(),
            name.as_bytes()
        );
    }
    let out_b2 = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;
    assert_eq!((out_b2.uploaded, out_b2.downloaded), (0, 0));
    assert!(!out_b2.has_failures(), "{:?}", out_b2.failure_summary());
}

// ============================================================================
// 11. failure_summary 稳定标记（前端 i18n 入口）
// ============================================================================

#[tokio::test]
async fn r09_failure_summary_carries_conflict_marker_and_human_readable_hint() {
    let storage = MemoryCloudStorage::default();

    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, "images/Logo.png", b"UPPER");
    let manager_a = SyncManager::new(unique_device("dev-a"));
    sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    write_asset(&active_b, "images/logo.png", b"lower");
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;

    assert!(out_b.has_failures());
    let summary = out_b.failure_summary().unwrap();
    assert!(
        summary.contains(FILENAME_CONFLICT_MARKER),
        "summary 必须带稳定标记（前端据此映射 i18n）: {summary}"
    );
    assert!(
        summary.contains("大小写"),
        "summary 必须携带人话原因: {summary}"
    );
    // 本地文件未被覆盖
    assert_eq!(
        std::fs::read(active_b.path().join("images/logo.png")).unwrap(),
        b"lower"
    );
}
