//! [R07-filename-tests] 资产 key 的跨平台文件名边界回归测试（只测不改生产）。
//!
//! 资产 key 由 `scan_asset_tree` 直接拼接本地文件名生成（形如
//! `active/images/<原始文件名>`），生产代码目前：
//!
//! 1. **不转义 Windows 非法字符**（`:` `?` 等）——Linux/macOS 设备可以创建这类
//!    文件并上传，Windows 设备下载时 `std::fs::File::create` 会失败。该失败只
//!    进入 `AssetSyncOutcome::download_failures`（warn 级日志），`sync_asset_directories`
//!    仍返回 `Ok`——调用方若不检查 `has_failures()` 即为静默降级。
//! 2. **无大小写碰撞检测**——`Logo.png` 与 `logo.png` 是两个独立 key。在
//!    大小写敏感文件系统（Linux）上并存；在 Windows/macOS 默认的大小写不敏感
//!    文件系统上两个 key 映射同一本地文件，下载互相覆盖并在下一轮 scan 中被
//!    判为"本地被改"，造成冲突副本/乒乓上传。
//! 3. **无 Unicode 归一化**——NFC `café.png` 与 NFD `café.png`（e + U+0301）
//!    字节序列不同即为两个 key。macOS（HFS+/APFS 存 NFD）与 Linux/Windows
//!    （原样字节）混用时，同一视觉文件名会分裂为两个资产条目并重复下载。
//!
//! 本文件在 Linux 上可全量运行：
//! - 常规测试锁定当前真实行为（key 原样含非法字符/大小写变体/两种归一化形态），
//!   并验证"下载失败只进 download_failures 不报错"这一静默降级通道确实存在；
//! - 两个 `#[ignore]` 测试断言理想行为（碰撞检测、归一化统一），当前生产不满足
//!   会失败，故 ignore 并注明——修复生产后应移除 ignore 使其上岗。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{AssetDirsManifest, SyncDirection, SyncManager};
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

/// Linux 设备可以创建含 `:` 和 `?` 的资产文件名；生产对 key 不做任何 Windows
/// 兼容转义——key 原样携带非法字符进入云端清单，且在 Linux 间可完整 round-trip。
///
/// 这锁定了跨平台风险的**前半段事实**：一旦此清单被 Windows 设备消费，
/// `asset_local_path_from_key` 会拼出含 `:`/`?` 的路径，文件创建必然失败
/// （失败模式见下一个测试）。若未来生产改为转义/拒绝此类文件名，本测试应
/// 相应更新为断言新行为。
#[tokio::test]
async fn r07_windows_reserved_chars_flow_into_keys_unescaped_and_roundtrip_on_linux() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();

    // `:` 常见于时间戳命名（如 macOS 截图），`?` 见于从 URL 派生的文件名
    write_asset(&active_a, "images/screenshot 12:30:45.png", b"colon-bytes");
    write_asset(&active_a, "documents/page?query=1.pdf", b"question-bytes");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(
        out_a.uploaded, 2,
        "两个含非法字符的文件都应上传成功（Linux）"
    );
    assert!(!out_a.has_failures(), "{:?}", out_a.failure_summary());

    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&"active/images/screenshot 12:30:45.png".to_string()),
        "key 应原样携带 `:`（无转义/清洗），实际: {keys:?}"
    );
    assert!(
        keys.contains(&"active/documents/page?query=1.pdf".to_string()),
        "key 应原样携带 `?`（无转义/清洗），实际: {keys:?}"
    );

    // 第二台 Linux 设备可以完整下载——问题只会在 Windows 端爆发
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
        std::fs::read(active_b.path().join("images/screenshot 12:30:45.png")).unwrap(),
        b"colon-bytes"
    );
    assert_eq!(
        std::fs::read(active_b.path().join("documents/page?query=1.pdf")).unwrap(),
        b"question-bytes"
    );
}

/// 暴露静默降级通道：单个资产下载失败（Windows 上非法文件名的必然结局，这里
/// 用"内容对象缺失"在 Linux 上模拟同一失败路径）只会进入
/// `download_failures`，`sync_asset_directories` 仍返回 `Ok`。
///
/// 也就是说：Windows 设备遇到 `:`/`?` key 时不会中止同步、不会报错返回——
/// 只有主动检查 `AssetSyncOutcome::has_failures()` 的调用方才能发现文件缺失。
/// 本测试锁定该通道确实把失败暴露在 outcome 里（而不是彻底吞掉），这是当前
/// 唯一的可观测信号。
#[tokio::test]
async fn r07_single_asset_download_failure_is_soft_and_only_visible_in_outcome() {
    let storage = MemoryCloudStorage::default();
    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, "images/broken:on-windows.png", b"payload");

    let manager_a = SyncManager::new(unique_device("dev-a"));
    let out_a = sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;
    assert_eq!(out_a.uploaded, 1);

    // 删除内容对象，使下载端 get_file 失败（与 Windows 端 File::create 失败
    // 走同一个 per-file 容错分支）
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
        .expect("单文件下载失败不应使整体同步返回 Err（当前生产行为）");

    assert_eq!(out_b.downloaded, 0);
    assert_eq!(
        out_b.download_failures,
        vec!["active/images/broken:on-windows.png".to_string()],
        "失败必须可在 outcome 中定位到具体 key"
    );
    assert!(
        out_b.has_failures() && out_b.failure_summary().is_some(),
        "调用方唯一的发现渠道是 has_failures()/failure_summary()"
    );
    assert!(
        !active_b
            .path()
            .join("images/broken:on-windows.png")
            .exists(),
        "失败的资产不应留下半成品文件"
    );
}

// ============================================================================
// 2. 大小写碰撞
// ============================================================================

/// 仅大小写不同的文件名是两个独立 key：在大小写敏感文件系统（Linux）上双双
/// round-trip 并存。
///
/// 锁定事实：生产没有任何大小写碰撞检测/警告。在 Windows/macOS 默认的
/// 大小写不敏感卷上，这两个 key 会映射到**同一个本地文件**：下载端第二个 key
/// 覆盖第一个（触发 conflict-copy 分支），下一轮 scan 只会看到一个文件、
/// 其内容哈希与其中一个清单条目不符，从而产生持续的冲突副本/重复上传。
/// 理想行为见下方 `#[ignore]` 测试。
#[tokio::test]
async fn r07_case_only_variants_are_distinct_keys_and_coexist_on_case_sensitive_fs() {
    let storage = MemoryCloudStorage::default();

    // 设备 A / B 各自贡献一个大小写变体（不同内容）
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
    assert_eq!(out_b.uploaded, 1, "大小写变体不应被判为同一 key 而跳过上传");
    assert!(!out_b.has_failures(), "{:?}", out_b.failure_summary());

    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&"active/images/Logo.png".to_string()),
        "{keys:?}"
    );
    assert!(
        keys.contains(&"active/images/logo.png".to_string()),
        "{keys:?}"
    );

    // 第三台设备（Linux，大小写敏感）：两个文件都物化且内容各自正确
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
    assert_eq!(out_c.downloaded, 2);
    assert!(!out_c.has_failures());
    assert_eq!(
        std::fs::read(active_c.path().join("images/Logo.png")).unwrap(),
        b"UPPER-variant"
    );
    assert_eq!(
        std::fs::read(active_c.path().join("images/logo.png")).unwrap(),
        b"lower-variant"
    );
}

/// 【已知缺口，ignore 注明】理想行为：清单中出现仅大小写不同的 key 时，同步
/// 应在 outcome 中给出可观测信号（failure/警告），提示大小写不敏感文件系统上
/// 的设备将发生互相覆盖。
///
/// 当前生产**没有**任何碰撞检测：本测试今天会失败（outcome 完全干净），故
/// `#[ignore]`。为大小写碰撞补上检测后，请移除 ignore 使其上岗。
/// 运行方式：`cargo test --test sync_r07_filename_tests -- --ignored`
#[tokio::test]
#[ignore = "生产尚无大小写碰撞检测：大小写不敏感 FS 上两个 key 会静默互相覆盖（见同名非 ignore 测试的行为锁定）"]
async fn r07_case_insensitive_key_collision_should_surface_a_warning() {
    let storage = MemoryCloudStorage::default();

    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, "images/Logo.png", b"UPPER-variant");
    let manager_a = SyncManager::new(unique_device("dev-a"));
    sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    write_asset(&active_b, "images/logo.png", b"lower-variant");
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;

    assert!(
        out_b.has_failures(),
        "期望：检测到与云端 `active/images/Logo.png` 仅大小写不同的碰撞并在 outcome 中给出信号；\
         实际：当前生产完全静默（本断言失败即证明缺口仍在）"
    );
}

// ============================================================================
// 3. Unicode 归一化（NFC / NFD）
// ============================================================================

/// NFC `café.png` 与 NFD `café.png` 字节不同即为两个 key：生产不做归一化。
///
/// 场景：设备 A 的文件名为 NFD（macOS 文件系统惯例），设备 B 的同名文件为
/// NFC（Linux/Windows 惯例），内容完全相同。双向同步后：
/// - 云端清单分裂为两个条目（同一逻辑文件被记两次）；
/// - 设备 B 会把 NFD 变体当作"云端新文件"下载回来，本地出现两个视觉上
///   同名、内容相同的文件——用户可见的静默重复。
/// 理想行为见下方 `#[ignore]` 测试。
#[tokio::test]
async fn r07_nfc_and_nfd_filenames_split_into_duplicate_assets() {
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

    // 锁定当前行为：NFC 变体被当作新 key 上传，NFD 变体被当作缺失文件下载
    assert_eq!(out_b.uploaded, 1, "NFC 变体不应与 NFD key 匹配（无归一化）");
    assert_eq!(
        out_b.downloaded, 1,
        "NFD 变体对设备 B 而言是'云端新文件'，会被重复下载"
    );
    assert!(!out_b.has_failures(), "{:?}", out_b.failure_summary());

    // 设备 B 本地出现两个字节名不同、内容相同的"同名"文件
    assert_eq!(
        std::fs::read(active_b.path().join(nfc_name)).unwrap(),
        b"same-logical-content"
    );
    assert_eq!(
        std::fs::read(active_b.path().join(nfd_name)).unwrap(),
        b"same-logical-content"
    );

    // 云端清单也分裂为两个条目
    let keys = all_manifest_keys(&storage);
    assert!(
        keys.contains(&format!("active/{nfc_name}"))
            && keys.contains(&format!("active/{nfd_name}")),
        "同一逻辑文件在清单中分裂为 NFC/NFD 两个条目: {keys:?}"
    );
}

/// 【已知缺口，ignore 注明】理想行为：资产 key 在生成时做统一的 Unicode 归一化
/// （通常取 NFC），使 macOS（NFD 文件系统）与 Linux/Windows（NFC）设备对同一
/// 逻辑文件收敛到同一个 key，不产生重复条目与重复下载。
///
/// 当前生产不做归一化：本测试今天会失败（清单出现两个条目），故 `#[ignore]`。
/// 为 key 生成补上归一化（含对存量双条目清单的迁移/合并策略）后，请移除
/// ignore 使其上岗。
/// 运行方式：`cargo test --test sync_r07_filename_tests -- --ignored`
#[tokio::test]
#[ignore = "生产尚无 Unicode 归一化：NFC/NFD 同名文件会分裂为两个资产条目（见同名非 ignore 测试的行为锁定）"]
async fn r07_unicode_normalization_should_unify_nfc_nfd_keys() {
    let nfc_name = "images/caf\u{e9}.png";
    let nfd_name = "images/cafe\u{301}.png";

    let storage = MemoryCloudStorage::default();

    let active_a = TempDir::new().unwrap();
    let app_a = TempDir::new().unwrap();
    write_asset(&active_a, nfd_name, b"same-logical-content");
    let manager_a = SyncManager::new(unique_device("dev-a"));
    sync_bidirectional(&manager_a, &storage, &active_a, &app_a).await;

    let active_b = TempDir::new().unwrap();
    let app_b = TempDir::new().unwrap();
    write_asset(&active_b, nfc_name, b"same-logical-content");
    let manager_b = SyncManager::new(unique_device("dev-b"));
    let out_b = sync_bidirectional(&manager_b, &storage, &active_b, &app_b).await;

    assert_eq!(
        out_b.downloaded, 0,
        "期望：归一化后 NFC/NFD 是同一 key、内容相同 → 无需下载；实际：当前会重复下载 NFD 变体"
    );
    let keys = all_manifest_keys(&storage);
    let cafe_entries = keys
        .iter()
        .filter(|key| key.starts_with("active/images/caf"))
        .count();
    assert_eq!(
        cafe_entries, 1,
        "期望：同一逻辑文件在清单中只有一个归一化 key；实际: {keys:?}"
    );
}
