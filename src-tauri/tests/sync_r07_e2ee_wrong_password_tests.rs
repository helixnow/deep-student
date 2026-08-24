//! [R07-tests] 错密码不得污染同一云 root 的 ZIP / 文件级密文 — 极端回归测试
//!
//! ## 背景
//!
//! R06-e2ee-verifier 在云端 `.encryption-marker` 中登记了不可逆密码校验子：
//! ZIP 备份上传（`cloud_sync_upload` → `enforce_encryption_policy_before_upload_with_password`）
//! 在写入任何 `backups/` 对象前比对校验子，配错密码的设备立即失败。
//!
//! 文件级（记录级）同步走的是另一条防线：清单 payload 全部装入 DSBK 容器
//! （AES-256-GCM），错密码设备在 `download_*_manifest` 解密阶段 fail-closed，
//! 同步在写入任何对象之前中止（`sync_asset_directories` / `sync_vfs_blobs`
//! 的首个步骤都是下载并解密云端清单）。
//!
//! 本文件用内存云存储把两条防线推到极端：
//! - 大小写 / 首尾空白 / Unicode NFC vs NFD / 零宽字符等"近似密码"必须全部
//!   被拦截，且反复失败不得改写（污染）云端加密标记；
//! - 错密码设备被拦后，正确密码设备必须能继续正常上传（拦截无副作用）；
//! - 文件级同步（资产目录 / VFS blobs）配错密码时必须整体失败，云端对象集合
//!   必须逐字节保持不变——不得发布新清单、不得上传对象、不得覆盖既有密文。
//!
//! 与 `cloud_storage/sync_manager.rs` 内联单测的分工：内联测覆盖单次拦截与
//! 标记升级路径；本文件覆盖"拦截之后 root 是否保持零污染 + 正常设备能否恢复"
//! 的端到端不变量。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::{CloudStorage, CloudSyncManager, FileInfo};
use deep_student_lib::data_governance::sync::{SyncDirection, SyncManager};
use deep_student_lib::models::AppError;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// Fixture: 内存云存储（可随时做逐字节快照）
// ============================================================================

#[derive(Default)]
struct MemoryCloudStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
}

impl MemoryCloudStorage {
    /// 云端对象全集的逐字节快照：断言"零污染"的依据。
    fn byte_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .iter()
            .map(|(key, (data, _))| (key.clone(), data.clone()))
            .collect()
    }

    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }
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

fn zip_manager(storage: &Arc<MemoryCloudStorage>, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(
        Box::new(SharedStorage(Arc::clone(storage))),
        device_id.to_string(),
    )
}

// ============================================================================
// ZIP 路径：错密码拦截后 root 零污染 + 正确设备可恢复
// ============================================================================

/// 错密码设备被拦截后，云端不得出现任何 backups/ 对象、加密标记逐字节不变，
/// 且正确密码设备之后仍能正常通过策略并完成上传（拦截无残留副作用）。
#[tokio::test]
async fn r07_zip_wrong_password_rejection_leaves_root_clean_and_recoverable() {
    let storage = Arc::new(MemoryCloudStorage::default());

    // 设备 A 用正确密码登记带校验子的 v2 标记
    let device_a = zip_manager(&storage, "device-a");
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some("r07-correct-pw"))
        .await
        .expect("首次登记加密标记应成功");
    let snapshot_after_marker = storage.byte_snapshot();

    // 设备 B 配错密码，反复尝试三次：每次都必须被拦截
    let device_b = zip_manager(&storage, "device-b");
    for attempt in 0..3 {
        let error = device_b
            .enforce_encryption_policy_before_upload_with_password(Some("r07-wrong-pw"))
            .await
            .expect_err("错密码必须在上传前被拦截");
        assert!(
            error.to_string().contains("不一致"),
            "第 {attempt} 次拦截的错误应指出密码不一致: {error}"
        );
    }

    // 拦截不得留下任何痕迹：对象集合逐字节等于登记标记后的状态
    assert_eq!(
        storage.byte_snapshot(),
        snapshot_after_marker,
        "错密码拦截后云端对象集合必须逐字节不变（零污染）"
    );
    assert!(
        storage.keys_with_prefix("backups/").is_empty(),
        "不得出现任何备份对象"
    );

    // 正确密码设备随后必须能正常通过并完成上传
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some("r07-correct-pw"))
        .await
        .expect("正确密码在错密码拦截之后应继续放行");
    let dir = tempfile::tempdir().unwrap();
    let zip = dir.path().join("backup.dsbk");
    std::fs::write(&zip, b"DSBK pretend-encrypted payload r07").unwrap();
    let result = device_a
        .upload(&zip, Some("r07-test".into()), None)
        .await
        .expect("正确密码设备上传应成功");
    assert_eq!(result.version.device_id, "device-a");
    let backup_keys = storage.keys_with_prefix("backups/");
    assert_eq!(backup_keys.len(), 1, "云端应只有正确设备的一个备份对象");
}

/// "近似密码"全家桶：大小写差异、首尾空白、NFC vs NFD、零宽字符——
/// 密码校验按字节精确比较，任何近似形式都必须被拦截且不改写标记。
#[tokio::test]
async fn r07_zip_near_miss_password_variants_all_rejected() {
    let storage = Arc::new(MemoryCloudStorage::default());

    // 用 NFC 形式的 "café-R07-pw"（é = U+00E9）登记标记
    let correct = "caf\u{00E9}-R07-pw";
    let device_a = zip_manager(&storage, "device-a");
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some(correct))
        .await
        .expect("登记标记应成功");
    let snapshot = storage.byte_snapshot();

    let near_misses: &[(&str, String)] = &[
        // NFD 分解形式（e + U+0301 组合重音）：视觉相同、字节不同
        ("NFD 分解形式", format!("cafe\u{0301}-R07-pw")),
        // 大小写差异
        ("大小写差异", correct.to_lowercase()),
        // 首尾空白（用户复制粘贴常见事故）
        ("尾部空格", format!("{correct} ")),
        ("头部空格", format!(" {correct}")),
        // 零宽空格附着（不可见字符）
        ("零宽空格后缀", format!("{correct}\u{200B}")),
    ];

    let device_b = zip_manager(&storage, "device-b");
    for (label, candidate) in near_misses {
        assert_ne!(
            candidate, correct,
            "{label}: 测试用例本身必须与正确密码不同"
        );
        let error = device_b
            .enforce_encryption_policy_before_upload_with_password(Some(candidate))
            .await
            .expect_err("近似密码必须被拦截");
        assert!(
            error.to_string().contains("不一致"),
            "{label} 应报密码不一致: {error}"
        );
    }

    // 无密码（明文）设备也必须被拦截，且属于另一类错误
    let plaintext_error = device_b
        .enforce_encryption_policy_before_upload_with_password(None)
        .await
        .expect_err("加密 root 必须拒绝明文上传");
    assert!(
        plaintext_error.to_string().contains("加密"),
        "明文拒绝应提示需要加密密码: {plaintext_error}"
    );

    // 所有拦截之后：对象集合逐字节不变，正确密码仍然放行
    assert_eq!(
        storage.byte_snapshot(),
        snapshot,
        "全部近似密码拦截后云端必须零污染"
    );
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some(correct))
        .await
        .expect("正确密码（字节精确匹配）应始终放行");
}

// ============================================================================
// 文件级路径：错密码在清单解密阶段 fail-closed，root 零污染
// ============================================================================

/// 在 active 目录下创建 `images/<name>`，返回 (active_dir, app_data_dir) 两个租约。
fn asset_workspace(name: &str, content: &[u8]) -> (tempfile::TempDir, tempfile::TempDir) {
    let active = tempfile::tempdir().unwrap();
    let app_data = tempfile::tempdir().unwrap();
    let images = active.path().join("images");
    std::fs::create_dir_all(&images).unwrap();
    std::fs::write(images.join(name), content).unwrap();
    (active, app_data)
}

/// 错密码设备执行文件级资产同步：必须在解密云端清单时整体失败，
/// 不得发布新清单、不得上传本地文件、云端对象集合逐字节不变。
/// 上传（Bidirectional）与只下载（Download）两个方向都要 fail-closed。
#[tokio::test]
async fn r07_file_level_wrong_password_fails_closed_without_polluting_root() {
    let storage = Arc::new(MemoryCloudStorage::default());
    let cloud = SharedStorage(Arc::clone(&storage));

    // 设备 A（正确密码）先把一份资产同步上云：清单进 DSBK 容器
    let manager_a =
        SyncManager::with_encryption("device-a".to_string(), Some("r07-file-pw".to_string()));
    let (active_a, app_a) = asset_workspace("r07-e2ee-origin.bin", b"origin asset payload");
    let outcome_a = manager_a
        .sync_asset_directories(
            &cloud,
            active_a.path(),
            app_a.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect("正确密码设备的资产同步应成功");
    assert_eq!(outcome_a.uploaded, 1, "前提校验：应恰好上传一份资产");
    assert!(!outcome_a.has_failures(), "前提校验：首次同步不得有失败");
    let snapshot = storage.byte_snapshot();
    assert!(
        !snapshot.is_empty(),
        "前提校验：云端应已存在清单与对象（快照非空）"
    );

    // 设备 B 配错密码，本地还有一份"毒药"文件等着被误上传
    let manager_b =
        SyncManager::with_encryption("device-b".to_string(), Some("r07-file-wrong".to_string()));
    let (active_b, app_b) = asset_workspace("r07-e2ee-poison.bin", b"poison payload");

    for direction in [SyncDirection::Bidirectional, SyncDirection::Download] {
        let error = manager_b
            .sync_asset_directories(&cloud, active_b.path(), app_b.path(), direction)
            .await
            .expect_err("错密码设备的资产同步必须整体失败");
        let message = error.to_string();
        assert!(
            message.contains("解密") || message.contains("密码"),
            "错误应指向解密/密码问题: {message}"
        );
        assert_eq!(
            storage.byte_snapshot(),
            snapshot,
            "错密码同步失败后云端对象集合必须逐字节不变（零污染）"
        );
    }

    // 本地也不得出现悄悄下载的文件：images 里仍只有毒药文件自己
    let local_names: Vec<String> = std::fs::read_dir(active_b.path().join("images"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        local_names,
        vec!["r07-e2ee-poison.bin".to_string()],
        "fail-closed 的同步不得向本地写入任何云端文件"
    );

    // 未配置密码的设备（明文模式）读加密清单同样 fail-closed
    let manager_plain = SyncManager::new("device-c".to_string());
    let (active_c, app_c) = asset_workspace("r07-e2ee-plain.bin", b"plaintext device payload");
    let error = manager_plain
        .sync_asset_directories(
            &cloud,
            active_c.path(),
            app_c.path(),
            SyncDirection::Bidirectional,
        )
        .await
        .expect_err("未配密码的设备读加密 root 必须失败");
    assert!(
        error.to_string().contains("未配置加密密码"),
        "错误应提示设置密码: {error}"
    );
    assert_eq!(
        storage.byte_snapshot(),
        snapshot,
        "明文设备失败后同样零污染"
    );
}

/// VFS blobs 通道与资产通道同一防线：错密码解不开 blobs 清单，
/// 同步整体失败且云端逐字节不变。
#[tokio::test]
async fn r07_file_level_wrong_password_blobs_channel_fails_closed() {
    let storage = Arc::new(MemoryCloudStorage::default());
    let cloud = SharedStorage(Arc::clone(&storage));

    // 设备 A 上传一个内容寻址 blob（文件名 = hash stem）
    let manager_a =
        SyncManager::with_encryption("device-a".to_string(), Some("r07-blob-pw".to_string()));
    let blobs_a = tempfile::tempdir().unwrap();
    let shard = blobs_a.path().join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join("r07blobhash001.bin"), b"blob payload A").unwrap();
    let outcome_a = manager_a
        .sync_vfs_blobs(&cloud, blobs_a.path(), SyncDirection::Bidirectional)
        .await
        .expect("正确密码设备的 blob 同步应成功");
    assert_eq!(outcome_a.uploaded, 1, "前提校验：应恰好上传一个 blob");
    let snapshot = storage.byte_snapshot();

    // 设备 B 配错密码：清单解密失败，整体 fail-closed
    let manager_b =
        SyncManager::with_encryption("device-b".to_string(), Some("r07-blob-wrong".to_string()));
    let blobs_b = tempfile::tempdir().unwrap();
    let shard_b = blobs_b.path().join("cd");
    std::fs::create_dir_all(&shard_b).unwrap();
    std::fs::write(shard_b.join("r07blobhash002.bin"), b"blob payload B").unwrap();
    let error = manager_b
        .sync_vfs_blobs(&cloud, blobs_b.path(), SyncDirection::Bidirectional)
        .await
        .expect_err("错密码设备的 blob 同步必须整体失败");
    let message = error.to_string();
    assert!(
        message.contains("解密") || message.contains("密码"),
        "错误应指向解密/密码问题: {message}"
    );
    assert_eq!(
        storage.byte_snapshot(),
        snapshot,
        "错密码 blob 同步失败后云端必须逐字节不变"
    );
    assert!(
        !blobs_b.path().join("ab").exists(),
        "fail-closed 的 blob 同步不得向本地写入云端 blob"
    );
}
