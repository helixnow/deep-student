//! [R11-check] 云端仓库巡检集成测试（restic `check` 档，只读不修）
//!
//! 钉死 `cloud_storage::repo_check::run_repo_check` 的核心契约：
//!
//! 1. **好库全绿**：manifest 引用对象齐全、SHA256 一致、（加密库）DSBK 头
//!    可解、无孤儿 → `RepoCheckStatus::Ok`；
//! 2. **缺对象**：manifest 引用的对象被删 → `MissingObject`，指明版本 ID；
//! 3. **坏密文**：加密库中对象被改动/明文混布 → `ChecksumMismatch` +
//!    `UndecodableDsbkHeader` / `PlaintextInEncryptedRepo`；
//! 4. **孤儿对象**：`backups/` 下未被引用的对象被报出，且巡检**只读**——
//!    绝不代删任何云端对象；
//! 5. **截断诚实性**：任一云端列表被截断时，结论必须是 `Incomplete`，
//!    **绝不**给出「全绿」；且 manifests 列表截断时跳过孤儿判定（防误报）。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::repo_check::{
    run_repo_check, RepoCheckProblemKind, RepoCheckStatus,
};
use deep_student_lib::cloud_storage::{
    CloudStorage, CloudSyncManager, DownloadProgressCallback, FileInfo, ListOutcome,
};
use deep_student_lib::models::AppError;

type CloudResult<T> = Result<T, AppError>;

// ==================== 测试用内存云存储 ====================

#[derive(Default)]
struct MemoryStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
}

impl MemoryStorage {
    fn insert_raw(&self, key: &str, data: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
    }

    fn remove_raw(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }

    fn keys(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }

    /// 云端全量快照（key → bytes），用于断言巡检只读。
    fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .iter()
            .map(|(key, (data, _))| (key.clone(), data.clone()))
            .collect()
    }
}

/// 本地 newtype：孤儿规则（E0117）不允许测试 crate 为 `Arc<本地类型>` 实现
/// 外部 trait，与其他 sync 测试文件的 `SharedStorage` 先例一致。
#[derive(Clone)]
struct SharedStorage(Arc<MemoryStorage>);

fn shared(storage: &Arc<MemoryStorage>) -> SharedStorage {
    SharedStorage(Arc::clone(storage))
}

#[async_trait]
impl CloudStorage for SharedStorage {
    fn provider_name(&self) -> &'static str {
        "memory"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.0.insert_raw(key, data);
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
        self.0.remove_raw(key);
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

/// 包装存储：list 结果永远标记为截断（模拟千级对象分页 / 服务端截断）。
struct TruncatingStorage(SharedStorage);

#[async_trait]
impl CloudStorage for TruncatingStorage {
    fn provider_name(&self) -> &'static str {
        "memory-truncating"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.0.put(key, data).await
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        self.0.get(key).await
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        self.0.list(prefix).await
    }

    async fn list_outcome(&self, prefix: &str) -> CloudResult<ListOutcome> {
        Ok(ListOutcome {
            files: self.0.list(prefix).await?,
            truncated: true,
        })
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.0.delete(key).await
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        self.0.stat(key).await
    }
}

/// 声明支持续传、但前几次 `get_file_resumable` 会在写出前缀后失败。
/// 用于钉死巡检对 WebDAV/S3 大对象走断点重试，而不是一次失败就 Incomplete。
struct FlakyResumableStorage {
    inner: SharedStorage,
    prefix_bytes: usize,
    remaining_failures: Mutex<u32>,
    resume_starts: Mutex<Vec<u64>>,
}

impl FlakyResumableStorage {
    fn new(inner: SharedStorage, prefix_bytes: usize, failures: u32) -> Self {
        Self {
            inner,
            prefix_bytes,
            remaining_failures: Mutex::new(failures),
            resume_starts: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl CloudStorage for FlakyResumableStorage {
    fn provider_name(&self) -> &'static str {
        "memory-flaky-resume"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.inner.put(key, data).await
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
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

    fn supports_resumable_download(&self) -> bool {
        true
    }

    async fn get_file_resumable(
        &self,
        key: &str,
        dest: &Path,
        resume_from: u64,
        progress: Option<DownloadProgressCallback>,
    ) -> CloudResult<u64> {
        self.resume_starts.lock().unwrap().push(resume_from);

        let data = self
            .inner
            .get(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total = data.len() as u64;
        if resume_from > total {
            return Err(AppError::validation(format!(
                "本地断点（{resume_from} 字节）大于云端对象（{total} 字节）"
            )));
        }

        let mut remaining = &data[resume_from as usize..];
        let mut remaining_failures = self.remaining_failures.lock().unwrap();
        let interrupted = if *remaining_failures > 0 {
            *remaining_failures -= 1;
            if self.prefix_bytes < remaining.len() {
                remaining = &remaining[..self.prefix_bytes];
                true
            } else {
                false
            }
        } else {
            false
        };
        drop(remaining_failures);

        use std::io::Write;
        let mut file = if resume_from > 0 {
            let existing = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            if existing != resume_from {
                return Err(AppError::file_system(format!(
                    "断点文件大小（{existing} 字节）与续传起点（{resume_from} 字节）不一致"
                )));
            }
            std::fs::OpenOptions::new()
                .append(true)
                .open(dest)
                .map_err(|e| AppError::file_system(e.to_string()))?
        } else {
            std::fs::File::create(dest).map_err(|e| AppError::file_system(e.to_string()))?
        };
        file.write_all(remaining)
            .map_err(|e| AppError::file_system(e.to_string()))?;
        file.flush()
            .map_err(|e| AppError::file_system(e.to_string()))?;
        if let Some(cb) = progress.as_ref() {
            cb(resume_from + remaining.len() as u64, total);
        }

        if interrupted {
            return Err(AppError::network(
                "模拟巡检下载中断（断点保留，可重试续传）".to_string(),
            ));
        }
        Ok(resume_from)
    }
}

// ==================== 辅助 ====================

fn manager_on(storage: &Arc<MemoryStorage>, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(Box::new(shared(storage)), device_id.to_string())
}

/// 上传一份指定内容的备份，返回版本 ID。
async fn upload_bytes(manager: &CloudSyncManager, contents: &[u8]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup.zip");
    std::fs::write(&path, contents).unwrap();
    manager
        .upload(&path, Some("1.0.0".into()), None)
        .await
        .expect("上传应成功")
        .version
        .id
}

/// 构造 DSBK v2 密文对象 fixture：**真实 `encrypt_backup_file` 产物**。
///
/// [R12-repocheck-fix / FINDINGS-R11 P1-1] 此前这里手写 48 字节偏移的假头，
/// 与实现里复制错的偏移互相印证，掩盖了「真实 44 字节头被误报不可解」的
/// P1 缺陷。fixture 必须以写入路径的真实产物为准，禁止再手搓容器布局。
fn real_dsbk_v2(payload_len: usize) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("plain.bin");
    let output = dir.path().join("cipher.dsbk");
    let plaintext: Vec<u8> = (0..payload_len).map(|i| (i % 251) as u8).collect();
    std::fs::write(&input, &plaintext).unwrap();
    deep_student_lib::crypto::backup_crypto::encrypt_backup_file(&input, &output, "repo-check-pw")
        .expect("真实加密产物生成应成功");
    std::fs::read(&output).unwrap()
}

fn kinds(
    report: &deep_student_lib::cloud_storage::repo_check::RepoCheckReport,
) -> Vec<RepoCheckProblemKind> {
    report.problems.iter().map(|p| p.kind).collect()
}

// ==================== 1. 好库全绿 ====================

#[tokio::test]
async fn healthy_plaintext_repo_reports_all_green() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 plain zip payload one").await;
    upload_bytes(&manager, b"PK\x03\x04 plain zip payload two").await;

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::Ok, "{:?}", report.problems);
    assert!(report.problems.is_empty());
    assert!(!report.listing_truncated);
    assert!(!report.encryption_marker_present);
    assert_eq!(report.versions_referenced, 2);
    assert_eq!(report.objects_checked, 2);
    assert_eq!(report.orphan_objects, 0);
    assert!(report.bytes_verified > 0);
}

#[tokio::test]
async fn healthy_encrypted_repo_reports_all_green() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    manager.persist_encryption_marker().await.unwrap();
    upload_bytes(&manager, &real_dsbk_v2(1024)).await;

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::Ok, "{:?}", report.problems);
    assert!(
        !kinds(&report).contains(&RepoCheckProblemKind::UndecodableDsbkHeader),
        "真实 encrypt_backup_file 产物绝不允许被误报「头不可解」（FINDINGS-R11 P1-1）: {:?}",
        report.problems
    );
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert!(report.encryption_marker_present);
    assert_eq!(report.versions_referenced, 1);
    assert_eq!(report.objects_checked, 1);
}

// ==================== 2. 缺对象 ====================

#[tokio::test]
async fn missing_object_is_reported_with_version_id() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    let keep = upload_bytes(&manager, b"PK\x03\x04 healthy").await;
    let lost = upload_bytes(&manager, b"PK\x03\x04 will vanish").await;

    // 模拟对象在云端丢失（provider 误删 / 手工误删），manifest 仍引用它。
    storage.remove_raw(&format!("backups/{lost}.zip"));

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::ProblemsFound);
    let missing: Vec<_> = report
        .problems
        .iter()
        .filter(|p| p.kind == RepoCheckProblemKind::MissingObject)
        .collect();
    assert_eq!(missing.len(), 1, "{:?}", report.problems);
    assert_eq!(missing[0].version_id.as_deref(), Some(lost.as_str()));
    assert_eq!(
        missing[0].object_key.as_deref(),
        Some(format!("backups/{lost}.zip").as_str())
    );
    // 未受影响的版本仍被完整校验
    assert_eq!(report.objects_checked, 1);
    assert!(report
        .problems
        .iter()
        .all(|p| p.version_id.as_deref() != Some(keep.as_str())));
}

// ==================== 3. 坏密文 ====================

#[tokio::test]
async fn corrupted_ciphertext_reports_checksum_and_header_problems() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    manager.persist_encryption_marker().await.unwrap();
    let version = upload_bytes(&manager, &real_dsbk_v2(1024)).await;

    // 对象被改动：仍带 DSBK 魔数但版本字节未知、且总长被截断 → 头不可解，
    // 同时 SHA256 必然与 manifest 登记值不符。
    storage.insert_raw(&format!("backups/{version}.zip"), b"DSBK\x09 corrupted");

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::ProblemsFound);
    let kinds = kinds(&report);
    assert!(
        kinds.contains(&RepoCheckProblemKind::ChecksumMismatch),
        "坏密文必须报 SHA256 不匹配: {:?}",
        report.problems
    );
    assert!(
        kinds.contains(&RepoCheckProblemKind::UndecodableDsbkHeader),
        "坏密文必须报 DSBK 头不可解: {:?}",
        report.problems
    );
}

#[tokio::test]
async fn plaintext_object_in_encrypted_repo_is_reported() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    manager.persist_encryption_marker().await.unwrap();
    let version = upload_bytes(&manager, &real_dsbk_v2(512)).await;

    // 加密仓库中的对象被替换成明文 ZIP（明文混布 / 加密被静默降级的痕迹）。
    storage.insert_raw(
        &format!("backups/{version}.zip"),
        b"PK\x03\x04 plaintext leaked into encrypted repo",
    );

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::ProblemsFound);
    assert!(
        kinds(&report).contains(&RepoCheckProblemKind::PlaintextInEncryptedRepo),
        "{:?}",
        report.problems
    );
}

// ==================== 4. 孤儿对象（且巡检只读） ====================

#[tokio::test]
async fn orphan_object_is_reported_and_check_stays_read_only() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 referenced").await;

    // 未被任何 manifest 引用的孤儿对象 + manifests/ 下的 tmp 残留
    storage.insert_raw(
        "backups/20990101-000000-000-zzzzzz-orphan01.zip",
        b"orphaned bytes",
    );
    storage.insert_raw(
        "manifests/device-a.json.deadbeef.tmp",
        b"{\"leftover\":true}",
    );

    let before = storage.snapshot();
    let report = run_repo_check(&shared(&storage)).await.unwrap();
    let after = storage.snapshot();

    assert_eq!(report.status, RepoCheckStatus::ProblemsFound);
    assert_eq!(report.orphan_objects, 1);
    let kinds = kinds(&report);
    assert!(
        kinds.contains(&RepoCheckProblemKind::OrphanObject),
        "{:?}",
        report.problems
    );
    assert!(
        kinds.contains(&RepoCheckProblemKind::TempLeftover),
        "{:?}",
        report.problems
    );
    let orphan = report
        .problems
        .iter()
        .find(|p| p.kind == RepoCheckProblemKind::OrphanObject)
        .unwrap();
    assert_eq!(
        orphan.object_key.as_deref(),
        Some("backups/20990101-000000-000-zzzzzz-orphan01.zip")
    );

    // 只读契约：巡检前后云端内容逐字节一致（孤儿与残留都还在，未被代删）。
    assert_eq!(before, after, "巡检必须只读，不得修改/删除任何云端对象");
}

#[tokio::test]
async fn corrupt_manifest_is_reported_without_aborting_check() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 healthy").await;
    storage.insert_raw("manifests/rogue-device.json", b"not-json at all");

    let report = run_repo_check(&shared(&storage)).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::ProblemsFound);
    assert!(
        kinds(&report).contains(&RepoCheckProblemKind::CorruptManifest),
        "{:?}",
        report.problems
    );
    // 损坏 manifest 不中断其余对象的核查
    assert_eq!(report.objects_checked, 1);
}

// ==================== 5. 截断时拒绝「全绿」 ====================

#[tokio::test]
async fn truncated_listing_never_reports_all_green() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 healthy payload").await;

    // 仓库本身完全健康，但列表被截断：结论必须是 Incomplete，绝不 Ok。
    let truncating = TruncatingStorage(shared(&storage));
    let report = run_repo_check(&truncating).await.unwrap();

    assert_ne!(
        report.status,
        RepoCheckStatus::Ok,
        "列表截断时绝不允许给出全绿结论"
    );
    assert_eq!(report.status, RepoCheckStatus::Incomplete);
    assert!(report.listing_truncated);
    // 健康对象照常校验（不完整 ≠ 什么都不做）
    assert_eq!(report.objects_checked, 1);
    assert!(
        report.problems.is_empty(),
        "健康仓库 + 截断列表不应虚报实体问题: {:?}",
        report.problems
    );
}

#[tokio::test]
async fn truncated_manifests_listing_suppresses_orphan_false_positives() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 healthy payload").await;
    // 真孤儿存在，但 manifests 列表被截断——「未被引用」可能只是引用它的
    // manifest 没被列出来，必须跳过孤儿判定（宁可少报也不误报）。
    storage.insert_raw("backups/20990101-000000-000-zzzzzz-orphan01.zip", b"bytes");

    let truncating = TruncatingStorage(shared(&storage));
    let report = run_repo_check(&truncating).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::Incomplete);
    assert_eq!(report.orphan_objects, 0, "截断时不得断言孤儿");
    assert!(
        !kinds(&report).contains(&RepoCheckProblemKind::OrphanObject),
        "{:?}",
        report.problems
    );
}

// ==================== 6. 巡检大对象断点续传 ====================

#[tokio::test]
async fn resumable_provider_retries_from_partial_and_reports_green() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 resumable repo-check payload").await;

    let flaky = FlakyResumableStorage::new(shared(&storage), 8, 1);
    let report = run_repo_check(&flaky).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::Ok, "{:?}", report.problems);
    assert_eq!(report.objects_checked, 1);
    let starts = flaky.resume_starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 2, "第一次失败后必须按断点再试: {starts:?}");
    assert_eq!(starts[0], 0);
    assert_eq!(starts[1], 8, "第二次必须从已写入的 8 字节前缀继续");
}

#[tokio::test]
async fn exhausted_resumable_retries_stay_incomplete() {
    let storage = Arc::new(MemoryStorage::default());
    let manager = manager_on(&storage, "device-a");
    upload_bytes(&manager, b"PK\x03\x04 never finishes").await;

    // 超过 REPO_CHECK_DOWNLOAD_ATTEMPTS=3：三次都写出前缀后失败。
    let flaky = FlakyResumableStorage::new(shared(&storage), 4, 10);
    let report = run_repo_check(&flaky).await.unwrap();

    assert_eq!(report.status, RepoCheckStatus::Incomplete);
    assert!(
        kinds(&report).contains(&RepoCheckProblemKind::ObjectReadFailed),
        "{:?}",
        report.problems
    );
    assert_ne!(report.status, RepoCheckStatus::Ok);
    let starts = flaky.resume_starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 3, "用尽重试次数后必须停: {starts:?}");
    assert_eq!(starts, vec![0, 4, 8]);
}
