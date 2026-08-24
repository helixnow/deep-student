//! [R07-tests] 跨平台文件名 — 资产同步的极端文件名回归测试
//!
//! ## 覆盖点
//!
//! 1. **Windows 非法字符 / 保留设备名 / 尾点尾空格**使用 rclone 风格可逆
//!    映射，云 key 与落盘名跨平台安全，decoder 可逐字节还原原名。
//! 2. **大小写仅异**在大小写不敏感平台会互相覆盖，因此确定性保留一方并报告。
//! 3. **Unicode NFC vs NFD**保持两个可逆 key；NFD 用 NFC 安全的 UTF-8 hex
//!    形态承载，不再靠有损规范化合并。
//! 4. **恶意清单键 fail-closed**：路径穿越（`..`）、绝对路径、未知根别名
//!    必须让整次同步失败且本地不落任何文件。
//!
//! 文件名刻意与 R07-asset-names 分支错开（本文件全部带 `r07x-` 前缀），
//! 两组测试互补不冲突。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{
    asset_filenames, SyncDirection, SyncManager, FILENAME_CONFLICT_MARKER,
};
use deep_student_lib::models::AppError;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// Fixture
// ============================================================================

#[derive(Default)]
struct MemoryCloudStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
}

/// 本地 newtype：孤儿规则不允许测试 crate 为 `Arc<本地类型>` 实现外部 trait。
#[derive(Clone)]
struct SharedStorage(Arc<MemoryCloudStorage>);

#[async_trait]
impl CloudStorage for SharedStorage {
    fn provider_name(&self) -> &'static str {
        "memory"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.0
            .files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone()))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        let mut files: Vec<FileInfo> = self
            .0
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

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.0.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self
            .0
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

/// 空的 (active_dir, app_data_dir) 工作区。
fn empty_workspace() -> (tempfile::TempDir, tempfile::TempDir) {
    (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
}

fn write_image(active: &tempfile::TempDir, name: &str, content: &[u8]) {
    let images = active.path().join("images");
    std::fs::create_dir_all(&images).unwrap();
    std::fs::write(images.join(name), content).unwrap();
}

fn image_names(active: &tempfile::TempDir) -> BTreeSet<String> {
    let images = active.path().join("images");
    if !images.exists() {
        return BTreeSet::new();
    }
    std::fs::read_dir(images)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

fn image_bytes(active: &tempfile::TempDir, name: &str) -> Vec<u8> {
    std::fs::read(active.path().join("images").join(name)).unwrap()
}

// ============================================================================
// 1. Windows 非法名可逆映射为跨平台安全名称
// ============================================================================

/// 原始名只在 Unix fixture 上创建；第二台设备看到安全编码名，decoder 仍可还原。
#[cfg(unix)]
#[tokio::test]
async fn r07_windows_hostile_names_roundtrip_bytewise_on_unix() {
    let cloud = SharedStorage(Arc::new(MemoryCloudStorage::default()));
    let manager_a = SyncManager::new("device-a".to_string());
    let (active_a, app_a) = empty_workspace();

    let hostile_names: &[(&str, &[u8])] = &[
        // Windows 非法字符集合（Unix 合法）
        ("r07x q<uo>te\"pipe|ast*erisk?.png", b"win-illegal-chars"),
        // 冒号（Windows 驱动器分隔符 / ADS 分隔符）
        ("r07x colon:name.md", b"win-colon"),
        // 保留设备名 + 扩展名（Windows 上同样非法）
        ("AUX.r07x.txt", b"win-reserved-device"),
        // 尾点与尾空格（Windows API 会静默剥离）
        ("r07x-trailing-dot.", b"win-trailing-dot"),
        ("r07x-trailing-space ", b"win-trailing-space"),
    ];
    for (name, content) in hostile_names {
        write_image(&active_a, name, content);
    }

    let outcome = manager_a
        .sync_asset_directories(
            &cloud,
            active_a.path(),
            app_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect("上传敌意文件名应成功");
    assert_eq!(outcome.uploaded, hostile_names.len(), "全部文件都应上传");
    assert!(!outcome.has_failures(), "上传不得有失败: {outcome:?}");

    // 设备 B 下载：落盘名是跨平台安全编码，且可逆恢复原始名。
    let manager_b = SyncManager::new("device-b".to_string());
    let (active_b, app_b) = empty_workspace();
    let outcome = manager_b
        .sync_asset_directories(
            &cloud,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .expect("下载敌意文件名应成功");
    assert_eq!(outcome.downloaded, hostile_names.len());
    assert!(!outcome.has_failures(), "下载不得有失败: {outcome:?}");

    let expected: BTreeSet<String> = hostile_names
        .iter()
        .map(|(name, _)| asset_filenames::encode_segment(name).unwrap())
        .collect();
    assert_eq!(
        image_names(&active_b),
        expected,
        "下载端必须只出现跨平台安全编码名"
    );
    for (name, content) in hostile_names {
        let encoded = asset_filenames::encode_segment(name).unwrap();
        assert_eq!(asset_filenames::decode_segment(&encoded).unwrap(), *name);
        assert_eq!(
            image_bytes(&active_b, &encoded),
            content.to_vec(),
            "{name:?} 的编码文件内容必须一致"
        );
    }
}

// ============================================================================
// 2. 大小写仅异的名字确定性冲突
// ============================================================================

/// `R07x-Case.md` 与 `r07x-case.md`（内容不同）只能上传字典序胜方，败方可观测。
#[cfg(unix)]
#[tokio::test]
async fn r07_case_only_different_names_stay_distinct_entries() {
    let cloud = SharedStorage(Arc::new(MemoryCloudStorage::default()));
    let manager_a = SyncManager::new("device-a".to_string());
    let (active_a, app_a) = empty_workspace();
    write_image(&active_a, "R07x-Case.md", b"UPPER variant");
    write_image(&active_a, "r07x-case.md", b"lower variant");

    let outcome = manager_a
        .sync_asset_directories(
            &cloud,
            active_a.path(),
            app_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect("上传大小写仅异文件应成功");
    assert_eq!(outcome.uploaded, 1, "大小写冲突只能上传一个变体");
    assert!(
        outcome
            .upload_failures
            .iter()
            .any(|failure| failure.contains(FILENAME_CONFLICT_MARKER)),
        "败方必须进入可观测冲突通道: {outcome:?}"
    );

    let manager_b = SyncManager::new("device-b".to_string());
    let (active_b, app_b) = empty_workspace();
    let outcome = manager_b
        .sync_asset_directories(
            &cloud,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .expect("下载大小写仅异文件应成功");
    assert_eq!(outcome.downloaded, 1);

    assert_eq!(image_bytes(&active_b, "R07x-Case.md"), b"UPPER variant");
    assert!(!active_b.path().join("images/r07x-case.md").exists());
}

// ============================================================================
// 3. NFC vs NFD：可逆且编码结果均为 NFC
// ============================================================================

/// NFC 原样安全，NFD 进入带标记 hex 模式；两者不碰撞且都能还原。
#[cfg(unix)]
#[tokio::test]
async fn r07_nfc_and_nfd_names_stay_distinct_without_normalization() {
    // "protégé"：NFC 用预组合字符，NFD 用基字符 + 组合重音
    let nfc_name = "r07x-prot\u{00E9}g\u{00E9}.txt";
    let nfd_name = "r07x-prote\u{0301}ge\u{0301}.txt";
    assert_ne!(nfc_name, nfd_name, "两种规范化形式必须字节不同");
    assert_ne!(
        nfc_name.as_bytes(),
        nfd_name.as_bytes(),
        "前提校验：字节序列不同"
    );

    let cloud = SharedStorage(Arc::new(MemoryCloudStorage::default()));
    let manager_a = SyncManager::new("device-a".to_string());
    let (active_a, app_a) = empty_workspace();
    write_image(&active_a, nfc_name, b"NFC payload");
    write_image(&active_a, nfd_name, b"NFD payload");

    let outcome = manager_a
        .sync_asset_directories(
            &cloud,
            active_a.path(),
            app_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect("上传 NFC/NFD 变体应成功");
    assert_eq!(outcome.uploaded, 2, "NFC 与 NFD 必须是两个独立、可逆的条目");

    let manager_b = SyncManager::new("device-b".to_string());
    let (active_b, app_b) = empty_workspace();
    let outcome = manager_b
        .sync_asset_directories(
            &cloud,
            active_b.path(),
            app_b.path(),
            SyncDirection::Download,
        )
        .await
        .expect("下载 NFC/NFD 变体应成功");
    assert_eq!(outcome.downloaded, 2);

    let encoded_nfc = asset_filenames::encode_segment(nfc_name).unwrap();
    let encoded_nfd = asset_filenames::encode_segment(nfd_name).unwrap();
    assert_ne!(encoded_nfc, encoded_nfd);
    assert_eq!(
        asset_filenames::decode_segment(&encoded_nfc).unwrap(),
        nfc_name
    );
    assert_eq!(
        asset_filenames::decode_segment(&encoded_nfd).unwrap(),
        nfd_name
    );
    let names = image_names(&active_b);
    assert!(
        names.contains(&encoded_nfc),
        "NFC 安全名必须存在，实际: {names:?}"
    );
    assert!(
        names.contains(&encoded_nfd),
        "NFD 可逆安全名必须存在，实际: {names:?}"
    );
    assert_eq!(image_bytes(&active_b, &encoded_nfc), b"NFC payload");
    assert_eq!(image_bytes(&active_b, &encoded_nfd), b"NFD payload");
}

// ============================================================================
// 4. 恶意清单键 fail-closed
// ============================================================================

/// 构造包含指定键的（明文）旧版资产清单与对应对象。
async fn seed_manifest_with_key(storage: &SharedStorage, key: &str) {
    // sha256("r07-malicious-payload") 占位：64 个十六进制字符即可通过形状校验
    let sha256 = "a".repeat(64);
    let object_key = format!("data_governance/asset_objects/{sha256}");
    let manifest = serde_json::json!({
        "entries": {
            key: {
                "sha256": sha256,
                "size": 4u64,
                "updated_at": "2026-08-24T00:00:00Z",
                "object_key": object_key,
                "revision": 1u64,
            }
        },
        "updated_at": "2026-08-24T00:00:00Z",
    });
    storage
        .put(
            "data_governance/assets_manifest.json",
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .await
        .unwrap();
    storage.put(&object_key, b"evil").await.unwrap();
}

/// 云端清单里的路径穿越 / 绝对路径 / 未知根别名键：
/// 整次同步必须失败（不逐文件降级），且本地不落任何文件。
#[tokio::test]
async fn r07_malicious_manifest_keys_fail_closed_and_write_nothing() {
    let malicious_keys = [
        // top 目录是 ".."：越出 active 根
        "active/../r07x-escape.txt",
        // 相对段里带 ".."：写入任意上级目录
        "active/images/../../../r07x-escape.txt",
        // 相对段是绝对路径
        "active/images//etc/r07x-absolute.txt",
        // 未知根别名
        "r07x_evil_root/images/x.txt",
    ];

    for key in malicious_keys {
        let cloud = SharedStorage(Arc::new(MemoryCloudStorage::default()));
        seed_manifest_with_key(&cloud, key).await;

        let manager = SyncManager::new("device-victim".to_string());
        let (active, app_data) = empty_workspace();
        let error = manager
            .sync_asset_directories(
                &cloud,
                active.path(),
                app_data.path(),
                SyncDirection::Download,
            )
            .await
            .expect_err("恶意清单键必须让整次同步失败");
        assert!(
            error.to_string().contains("拒绝非法"),
            "键 {key:?} 的错误应指出非法资产键: {error}"
        );

        assert!(
            image_names(&active).is_empty(),
            "键 {key:?}: fail-closed 后本地不得出现任何文件"
        );
        // 越界目标（tempdir 之外）自然无法全查，但 active 根本身必须干净
        let active_entries: Vec<_> = std::fs::read_dir(active.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "images")
            .collect();
        assert!(
            active_entries.is_empty(),
            "键 {key:?}: active 根下不得出现越界写入的文件，实际 {active_entries:?}"
        );
    }
}
