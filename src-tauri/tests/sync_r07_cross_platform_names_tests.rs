//! [R07-tests] 跨平台文件名 — 资产同步的极端文件名回归测试
//!
//! ## 覆盖点
//!
//! 1. **Windows 非法字符 / 保留设备名 / 尾点尾空格**（在 Unix 上完全合法）：
//!    同步管线必须原样透传这些名字——键、清单条目、下载落盘文件名都不得被
//!    静默改写（mangling 会破坏内容寻址与 LWW 键的一致性）。Windows 端的
//!    落盘兼容属于展示/落盘层的职责，不属于同步键空间。
//! 2. **大小写仅异**：`R07-Case.md` 与 `r07-case.md` 必须是两个独立条目，
//!    互不覆盖（大小写不敏感文件系统上的合并属于本地文件系统问题，
//!    清单键空间必须保持区分）。
//! 3. **Unicode NFC vs NFD**：视觉相同、字节不同的名字必须保持为两个键，
//!    同步不得做任何隐式规范化（macOS HFS+/APFS 会产生 NFD 名，隐式转换
//!    会导致两台设备互相"纠正"对方、清单永不收敛）。
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
use deep_student_lib::data_governance::sync::{SyncDirection, SyncManager};
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
// 1. Windows 非法名在 Unix 键空间中的原样透传
// ============================================================================

/// Windows 非法字符（`< > : " | ? *`）、保留设备名（AUX）、尾点/尾空格
/// 在 Unix 设备之间必须逐字节往返：上传设备 A → 下载设备 B，
/// 文件名与内容都不得被静默改写。
///
/// 注意：这些名字在 Windows 落盘时确实会失败——那是**下载失败**
/// （`download_failures` 逐文件降级），而不是名字被悄悄改写。
/// 本测试只在 Unix 语义下运行（Windows 上文件根本创建不出来）。
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

    // 设备 B（空工作区）下载：名字与内容逐字节一致
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
        .map(|(name, _)| name.to_string())
        .collect();
    assert_eq!(
        image_names(&active_b),
        expected,
        "文件名必须逐字节往返，不得被静默改写"
    );
    for (name, content) in hostile_names {
        assert_eq!(
            image_bytes(&active_b, name),
            content.to_vec(),
            "{name:?} 内容必须一致"
        );
    }
}

// ============================================================================
// 2. 大小写仅异的名字是独立条目
// ============================================================================

/// `R07x-Case.md` 与 `r07x-case.md`（内容不同）必须保持为两个清单键、
/// 两个云端对象，下载端两个文件各自拿到正确内容。
/// （大小写不敏感文件系统上二者会在**本地落盘**时相互覆盖——那是
/// 文件系统语义；同步键空间绝不能提前合并它们。）
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
    assert_eq!(outcome.uploaded, 2, "两个大小写变体都应作为独立条目上传");

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
    assert_eq!(outcome.downloaded, 2);

    assert_eq!(image_bytes(&active_b, "R07x-Case.md"), b"UPPER variant");
    assert_eq!(image_bytes(&active_b, "r07x-case.md"), b"lower variant");
}

// ============================================================================
// 3. NFC vs NFD：不做隐式 Unicode 规范化
// ============================================================================

/// NFC（`é` = U+00E9）与 NFD（`e` + U+0301）视觉相同、字节不同：
/// 必须保持为两个独立键并逐字节往返，同步不得隐式规范化。
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
    assert_eq!(
        outcome.uploaded, 2,
        "NFC 与 NFD 必须是两个独立条目（不得隐式规范化合并）"
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
        .expect("下载 NFC/NFD 变体应成功");
    assert_eq!(outcome.downloaded, 2);

    let names = image_names(&active_b);
    assert!(
        names.contains(nfc_name),
        "NFC 名必须逐字节保留，实际: {names:?}"
    );
    assert!(
        names.contains(nfd_name),
        "NFD 名必须逐字节保留，实际: {names:?}"
    );
    assert_eq!(image_bytes(&active_b, nfc_name), b"NFC payload");
    assert_eq!(image_bytes(&active_b, nfd_name), b"NFD payload");
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
            error.to_string().contains("拒绝非法资产键"),
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
