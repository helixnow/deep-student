//! [R12-v1-trust][FINDINGS-WRAP P2-1] 旧版（v1）加密标记升级前的既有备份试解。
//!
//! v1 标记没有密码校验子，升级到 v2 时会把本机密码固化为该 root 此后所有
//! 设备的校验基准。本文件从外部 crate 视角钉死升级臂的信任边界：
//!
//! 1. **空仓保持旧行为**：只有 v1 标记、没有任何备份时，第一台带密码上传的
//!    设备仍可认领该 root（一次性升级照常发生）；
//! 2. **有备份时必须先试解**：本机密码能完整解开既有 DSBK 备份才允许升级，
//!    升级保留首次写入者与首次写入时间；
//! 3. **试解不通过不升级**：错密码、下载失败、半包（对象被截断）、对象不是
//!    DSBK 密文——全部保持 v1 标记原样（无校验子），错误信息可操作，且持有
//!    正确密码的设备之后仍能完成升级。
//!
//! 全部使用内存 CloudStorage，独立于 Tauri runtime 与 docker。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{
    device_id_short_hash, CloudStorage, CloudSyncManager, EncryptionMarker, FileInfo,
};
use deep_student_lib::crypto::backup_crypto;
use deep_student_lib::models::AppError;
use tempfile::TempDir;

const ENCRYPTION_MARKER_KEY: &str = ".encryption-marker";
const ENCRYPTION_MARKER_VERSION_WITH_VERIFIER: u32 = 2;
const BACKUPS_PREFIX: &str = "backups/";

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// 内存 CloudStorage（Clone 共享同一底层状态，测试可直接窥视/篡改云端对象）
// ============================================================================

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl MemStorage {
    fn new() -> Self {
        Self::default()
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(key).cloned()
    }

    fn put_raw(&self, key: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(key.to_string(), data);
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

#[async_trait]
impl CloudStorage for MemStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r12-v1trust"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
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

/// 委托给底层 [`MemStorage`]，但对 `backups/` 前缀的读取返回网络错误——
/// 模拟「标记与 manifest 可读、备份对象本身暂时拉不下来」的故障形态。
#[derive(Clone)]
struct BackupReadOutage {
    inner: MemStorage,
}

#[async_trait]
impl CloudStorage for BackupReadOutage {
    fn provider_name(&self) -> &'static str {
        "memory-r12-v1trust-outage"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        self.inner.check_connection().await
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.inner.put(key, data).await
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        if key.starts_with(BACKUPS_PREFIX) {
            return Err(AppError::network(format!("模拟网络故障：无法读取 {key}")));
        }
        self.inner.get(key).await
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        self.inner.list(prefix).await
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.inner.delete(key).await
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        self.inner.stat(key).await
    }
}

// ============================================================================
// Fixture 辅助
// ============================================================================

fn manager_on(storage: &MemStorage, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(Box::new(storage.clone()), device_id.to_string())
}

/// 铸造旧版本应用留下的 v1 标记（无校验子）——走 bool 版策略入口，
/// 与历史行为逐字节一致。
async fn mint_v1_marker(storage: &MemStorage) -> EncryptionMarker {
    let legacy_writer = manager_on(storage, "device-legacy-writer");
    let legacy = legacy_writer.persist_encryption_marker().await.unwrap();
    assert_eq!(legacy.version, 1);
    assert!(legacy.key_verifier.is_none());
    legacy
}

/// 向云端上传一份用 `password` 加密的 DSBK 备份（真实走 upload 管线，
/// manifest 与 backups/ 对象都会就位），返回版本 ID。
async fn seed_encrypted_backup(storage: &MemStorage, password: &str, payload: &[u8]) -> String {
    let dir = TempDir::new().unwrap();
    let plain = dir.path().join("backup.zip");
    let sealed = dir.path().join("backup.zip.dsbk");
    std::fs::write(&plain, payload).unwrap();
    backup_crypto::encrypt_backup_file(&plain, &sealed, password).unwrap();

    let uploader = manager_on(storage, "device-seeder");
    let result = uploader
        .upload(&sealed, Some("1.0.0".into()), None)
        .await
        .expect("播种加密备份应成功");
    result.version.id
}

/// 直接读取云端标记原文（绕过管理器），断言其仍是 v1 且没有校验子字段。
fn assert_marker_still_v1_without_verifier(storage: &MemStorage) {
    let raw: serde_json::Value =
        serde_json::from_slice(&storage.object(ENCRYPTION_MARKER_KEY).unwrap()).unwrap();
    assert_eq!(raw["version"], 1, "标记必须保持 v1 未被改写");
    assert!(
        raw.get("keyVerifier").is_none(),
        "试解未通过时不得写入任何密码校验子"
    );
}

// ============================================================================
// 1. 空仓：只有 v1 标记、没有备份——保持旧行为，第一台带密码设备认领
// ============================================================================

#[tokio::test]
async fn r12_empty_root_v1_marker_still_upgrades_with_first_password() {
    let storage = MemStorage::new();
    let legacy = mint_v1_marker(&storage).await;
    assert!(
        storage.keys_with_prefix(BACKUPS_PREFIX).is_empty(),
        "前置条件：该 root 没有任何备份对象"
    );

    let device_a = manager_on(&storage, "device-a");
    let upgraded = device_a
        .verify_encryption_password_before_upload("first-pw-2026")
        .await
        .expect("空仓的 v1 标记应保持旧行为：允许第一台带密码设备一次性升级");
    assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    assert_eq!(
        upgraded.created_by_device,
        device_id_short_hash("device-legacy-writer"),
        "升级不得改写首次写入者"
    );
    assert_eq!(
        upgraded.created_at, legacy.created_at,
        "升级不得改写首次写入时间"
    );
    assert!(upgraded.key_verifier.is_some(), "升级后必须携带密码校验子");

    // 升级后：同密码放行、错密码被拦
    device_a
        .verify_encryption_password_before_upload("first-pw-2026")
        .await
        .expect("同密码应继续放行");
    let device_b = manager_on(&storage, "device-b");
    assert!(
        device_b
            .verify_encryption_password_before_upload("other-pw")
            .await
            .is_err(),
        "升级后错密码设备必须被拦截"
    );
}

// ============================================================================
// 2. 有备份 + 正确密码：试解通过 → 一次性升级，保留首写者与首写时间
// ============================================================================

#[tokio::test]
async fn r12_correct_password_upgrades_after_trial_decrypt_of_existing_backup() {
    let storage = MemStorage::new();
    let password = "team-pw-2026";
    let legacy = mint_v1_marker(&storage).await;
    seed_encrypted_backup(
        &storage,
        password,
        b"zip bytes protected by the team password",
    )
    .await;

    let device_a = manager_on(&storage, "device-a");
    let upgraded = device_a
        .verify_encryption_password_before_upload(password)
        .await
        .expect("密码能解开既有备份时应完成一次性升级");
    assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    assert_eq!(
        upgraded.created_by_device,
        device_id_short_hash("device-legacy-writer"),
        "升级不得改写首次写入者"
    );
    assert_eq!(
        upgraded.created_at, legacy.created_at,
        "升级不得改写首次写入时间"
    );
    assert!(upgraded.key_verifier.is_some());

    // 升级后：同密码继续放行、错密码被拦
    device_a
        .verify_encryption_password_before_upload(password)
        .await
        .expect("同密码应继续放行");
    let device_b = manager_on(&storage, "device-b");
    assert!(
        device_b
            .verify_encryption_password_before_upload("wrong-pw")
            .await
            .is_err(),
        "升级后错密码设备必须被拦截"
    );
}

// ============================================================================
// 3. 有备份 + 错密码：试解不通过 → 标记保持 v1、无校验子；正确密码仍可升级
// ============================================================================

#[tokio::test]
async fn r12_wrong_password_cannot_claim_root_with_existing_backups() {
    let storage = MemStorage::new();
    mint_v1_marker(&storage).await;
    let version_id =
        seed_encrypted_backup(&storage, "team-pw-2026", b"existing encrypted backup").await;

    let mistaken = manager_on(&storage, "device-mistaken");
    let error = mistaken
        .verify_encryption_password_before_upload("wrong-pw-2026")
        .await
        .expect_err("错密码不得通过既有备份的试解")
        .to_string();
    assert!(
        error.contains("试解") && error.contains("未通过"),
        "错误应指出试解未通过: {error}"
    );
    assert!(
        error.contains(&version_id),
        "错误应指出被试解的备份版本: {error}"
    );
    assert!(
        error.contains("核对加密密码"),
        "错误应给出可操作指引: {error}"
    );
    assert_marker_still_v1_without_verifier(&storage);

    // 持有正确密码的设备之后仍能完成升级（标记未被错密码占用）
    let rightful = manager_on(&storage, "device-rightful");
    let upgraded = rightful
        .verify_encryption_password_before_upload("team-pw-2026")
        .await
        .expect("正确密码设备必须仍能完成升级");
    assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    assert_eq!(
        upgraded.created_by_device,
        device_id_short_hash("device-legacy-writer")
    );

    // 此后错密码设备被校验子拦截
    assert!(
        mistaken
            .verify_encryption_password_before_upload("wrong-pw-2026")
            .await
            .is_err(),
        "升级后错密码设备必须被校验子拦截"
    );
}

// ============================================================================
// 4. 下载失败：备份对象读不到 → 不升级，标记保持 v1、无校验子
// ============================================================================

#[tokio::test]
async fn r12_backup_download_failure_keeps_v1_marker_untouched() {
    let storage = MemStorage::new();
    mint_v1_marker(&storage).await;
    seed_encrypted_backup(
        &storage,
        "team-pw-2026",
        b"backup unreachable during outage",
    )
    .await;

    let flaky = CloudSyncManager::new(
        Box::new(BackupReadOutage {
            inner: storage.clone(),
        }),
        "device-offline-ish".to_string(),
    );
    let error = flaky
        .verify_encryption_password_before_upload("team-pw-2026")
        .await
        .expect_err("备份对象读取失败时不得升级标记")
        .to_string();
    assert!(
        error.contains("下载最新备份") && error.contains("本次未改动加密标记"),
        "错误应指出下载失败且标记未动: {error}"
    );
    assert_marker_still_v1_without_verifier(&storage);

    // 故障恢复后（直连底层存储），同一密码可正常完成升级
    let recovered = manager_on(&storage, "device-recovered");
    let upgraded = recovered
        .verify_encryption_password_before_upload("team-pw-2026")
        .await
        .expect("故障恢复后正确密码应能完成升级");
    assert_eq!(upgraded.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
}

// ============================================================================
// 5. 半包：备份对象被截断 → 下载校验失败，不升级
// ============================================================================

#[tokio::test]
async fn r12_truncated_backup_object_blocks_upgrade() {
    let storage = MemStorage::new();
    mint_v1_marker(&storage).await;
    let version_id = seed_encrypted_backup(
        &storage,
        "team-pw-2026",
        b"payload that will be truncated in the cloud",
    )
    .await;

    // 截断云端对象（保留 DSBK 头，砍掉尾部字节）：SHA256 与 manifest 登记值
    // 不再一致，下载校验必须失败。
    let object_key = format!("{BACKUPS_PREFIX}{version_id}.zip");
    let mut bytes = storage.object(&object_key).unwrap();
    bytes.truncate(bytes.len() - 8);
    storage.put_raw(&object_key, bytes);

    let manager = manager_on(&storage, "device-a");
    let error = manager
        .verify_encryption_password_before_upload("team-pw-2026")
        .await
        .expect_err("被截断的备份对象不得通过试解")
        .to_string();
    assert!(
        error.contains("本次未改动加密标记"),
        "错误应说明标记未动: {error}"
    );
    assert_marker_still_v1_without_verifier(&storage);
}

// ============================================================================
// 6. 非 DSBK：既有备份是明文遗留对象 → 不升级
// ============================================================================

#[tokio::test]
async fn r12_plaintext_legacy_backup_blocks_upgrade() {
    let storage = MemStorage::new();
    mint_v1_marker(&storage).await;

    // 明文遗留备份（无 DSBK 头）真实走 upload 管线入云
    let dir = TempDir::new().unwrap();
    let plain_zip = dir.path().join("legacy-plain.zip");
    std::fs::write(&plain_zip, b"PK plain zip bytes without dsbk header").unwrap();
    let uploader = manager_on(&storage, "device-seeder");
    uploader
        .upload(&plain_zip, Some("0.9.0".into()), None)
        .await
        .expect("播种明文遗留备份应成功");

    // 标记声称该 root 已加密，但最新备份根本不是 DSBK 密文：矛盾状态下
    // 不得把任何密码固化进 v2 标记。
    let manager = manager_on(&storage, "device-a");
    let error = manager
        .verify_encryption_password_before_upload("any-pw-2026")
        .await
        .expect_err("非 DSBK 备份不得通过试解")
        .to_string();
    assert!(
        error.contains("试解") && error.contains("未通过"),
        "错误应指出试解未通过: {error}"
    );
    assert!(
        error.contains("人工检查"),
        "错误应给出人工检查指引: {error}"
    );
    assert_marker_still_v1_without_verifier(&storage);
}

// ============================================================================
// 7. v0.9.44 无 marker 仓：旧加密备份必须先试解，明文 ZIP 仍可开始 E2EE
// ============================================================================

#[tokio::test]
async fn r12_wrong_password_cannot_claim_markerless_v0944_encrypted_root() {
    let storage = MemStorage::new();
    let version_id = seed_encrypted_backup(
        &storage,
        "v0944-team-password",
        b"encrypted before marker support existed",
    )
    .await;
    assert!(
        storage.object(ENCRYPTION_MARKER_KEY).is_none(),
        "前置条件：v0.9.44 风格仓库有 DSBK 备份但没有 marker"
    );

    let mistaken = manager_on(&storage, "device-mistaken");
    let error = mistaken
        .verify_encryption_password_before_upload("mistyped-password")
        .await
        .expect_err("错密码不得抢占无 marker 的旧加密仓库")
        .to_string();
    assert!(
        error.contains("尚无加密标记") && error.contains("试解") && error.contains(&version_id),
        "错误必须说明 marker 缺失旧仓的试解失败: {error}"
    );
    assert!(
        storage.object(ENCRYPTION_MARKER_KEY).is_none(),
        "试解失败不得留下按错密码生成的 v2 marker"
    );

    let rightful = manager_on(&storage, "device-rightful");
    let marker = rightful
        .verify_encryption_password_before_upload("v0944-team-password")
        .await
        .expect("正确密码之后仍应能认领旧加密仓库");
    assert_eq!(marker.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    assert!(marker.key_verifier.is_some());
}

#[tokio::test]
async fn r12_markerless_plain_zip_can_start_new_encrypted_chain() {
    let storage = MemStorage::new();
    let dir = TempDir::new().unwrap();
    let plain_zip = dir.path().join("legacy-plain.zip");
    std::fs::write(&plain_zip, b"PK\x03\x04legacy plaintext zip payload").unwrap();
    manager_on(&storage, "device-legacy")
        .upload(&plain_zip, Some("0.9.44".into()), None)
        .await
        .expect("播种 v0.9.44 明文 ZIP");
    assert!(storage.object(ENCRYPTION_MARKER_KEY).is_none());

    let marker = manager_on(&storage, "device-upgraded")
        .verify_encryption_password_before_upload("new-e2ee-password")
        .await
        .expect("没有既有密码的明文 ZIP 不应阻断首次启用 E2EE");
    assert_eq!(marker.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER);
    assert!(marker.key_verifier.is_some());
}
