//! [R10-download] 下载完整性与无密码导入入口的增量回归（R09-restore-ops 之上）
//!
//! 本文件钉住三组契约（复审结论见 FIX-QUEUE R10-download 节）：
//!
//! 1. **S3/FTP 半包不得当成功**：`CloudStorage::get_file`（含 trait 默认实现，
//!    S3/FTP 的流式实现同规则）在响应流读到 EOF 后必须核对实际字节数与云端
//!    声明大小，不一致（半包、或对象在 stat 与 get 之间被并发替换）即失败，
//!    即使调用方没有传 `expected_checksum` 也绝不落盘冒充成功——
//!    `cloud_storage/repo_check.rs` 的巡检下载正是以 `expected=None` 调用的
//!    （原引用的 `get_file_decoded` 系死代码，已按 FINDINGS-R11 P2-1 删除），
//!    后端级字节数校验是这类调用方唯一的防线；
//! 2. **WebDAV 续传路径的 SHA256 拒绝**：断点损坏（R09 已测）之外，云端对象
//!    被**同大小**换包时续传拼装的产物必须被整文件 SHA256 校验拒绝、断点
//!    丢弃、不产出最终文件；
//! 3. **无密码导入所有入口早失败**：四个公开导入函数对加密全保真 ZIP 在
//!    缺密码时必须于触碰目标目录之前失败（入口枚举锁定，防止未来新增入口
//!    绕过 `precheck_sealed_payload_password`）。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{
    CloudStorage, CloudSyncManager, DownloadProgressCallback, FileInfo,
};
use deep_student_lib::models::AppError;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

type CloudResult<T> = Result<T, AppError>;

/// 共享内存对象池（模拟一个云端 root）。
#[derive(Default)]
struct ObjectPool {
    files: Mutex<BTreeMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>,
}

impl ObjectPool {
    fn put(&self, key: &str, data: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
    }

    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone())
    }

    fn list(&self, prefix: &str) -> Vec<FileInfo> {
        let mut files: Vec<FileInfo> = self
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
        files
    }

    fn stat(&self, key: &str) -> Option<FileInfo> {
        self.files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, modified)| FileInfo {
                key: key.to_string(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            })
    }

    fn delete(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }
}

/// 会送出半包的内存云存储（模拟 S3/FTP 流提前 EOF）：`stat` 如实报告完整
/// 大小，但对 `.zip` 对象的 `get` 只送出前 `truncate_zip_to` 字节。
/// `get_file` 走 trait 默认实现——被测对象正是默认实现的字节数校验。
#[derive(Clone, Default)]
struct TruncatingStorage {
    pool: Arc<ObjectPool>,
    /// `Some(n)` 时，`.zip` 对象的 `get` 只返回前 n 字节（不足则全量）。
    truncate_zip_to: Arc<Mutex<Option<usize>>>,
    /// `n > 0` 时，`.zip` 对象的 `get` 额外追加 n 个字节（模拟对象在
    /// stat 与 get 之间被换成更大的版本）。
    grow_zip_by: Arc<Mutex<usize>>,
}

#[async_trait]
impl CloudStorage for TruncatingStorage {
    fn provider_name(&self) -> &'static str {
        "memory-truncating-r10"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.pool.put(key, data);
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        let Some(data) = self.pool.get(key) else {
            return Ok(None);
        };
        // 只干扰备份对象本身：manifest 等 JSON 保持完整，聚焦下载路径。
        if key.ends_with(".zip") {
            if let Some(limit) = *self.truncate_zip_to.lock().unwrap() {
                return Ok(Some(data[..limit.min(data.len())].to_vec()));
            }
            let grow = *self.grow_zip_by.lock().unwrap();
            if grow > 0 {
                let mut inflated = data;
                inflated.extend(std::iter::repeat(0u8).take(grow));
                return Ok(Some(inflated));
            }
        }
        Ok(Some(data))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        Ok(self.pool.list(prefix))
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.pool.delete(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.pool.stat(key))
    }
}

/// 支持续传的内存云存储（契约同 R09 测试）：用于验证"对象被同大小换包"
/// 时编排层的整文件 SHA256 拒绝。
#[derive(Clone, Default)]
struct ResumableMemoryStorage {
    pool: Arc<ObjectPool>,
}

#[async_trait]
impl CloudStorage for ResumableMemoryStorage {
    fn provider_name(&self) -> &'static str {
        "memory-resumable-r10"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.pool.put(key, data);
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.pool.get(key))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        Ok(self.pool.list(prefix))
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.pool.delete(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.pool.stat(key))
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
        let data = self
            .pool
            .get(key)
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total = data.len() as u64;
        assert!(resume_from <= total, "编排层必须先丢弃无效断点");

        use std::io::Write;
        let mut file = if resume_from > 0 {
            std::fs::OpenOptions::new()
                .append(true)
                .open(dest)
                .map_err(|e| AppError::file_system(e.to_string()))?
        } else {
            std::fs::File::create(dest).map_err(|e| AppError::file_system(e.to_string()))?
        };
        let remaining = &data[resume_from as usize..];
        file.write_all(remaining)
            .map_err(|e| AppError::file_system(e.to_string()))?;
        file.flush()
            .map_err(|e| AppError::file_system(e.to_string()))?;
        if let Some(cb) = progress.as_ref() {
            cb(total, total);
        }
        Ok(resume_from)
    }
}

fn fake_backup_bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

async fn upload_fixture(
    manager: &CloudSyncManager,
    dir: &TempDir,
    bytes: &[u8],
) -> deep_student_lib::cloud_storage::BackupVersion {
    let zip_path = dir.path().join("source.zip");
    std::fs::write(&zip_path, bytes).unwrap();
    manager
        .upload(&zip_path, Some("r10-test".into()), None)
        .await
        .expect("上传测试备份应成功")
        .version
}

// ============================================================================
// 1. S3/FTP 半包不得当成功（trait 默认 get_file 的字节数校验）
// ============================================================================

/// 无 `expected_checksum` 的半包下载必须失败——这是 `repo_check.rs` 巡检
/// 下载（`expected=None`）能依赖的唯一后端级防线。
#[tokio::test]
async fn get_file_without_checksum_rejects_half_package() {
    let storage = TruncatingStorage::default();
    let payload = fake_backup_bytes(32 * 1024);
    storage.put("backups/half.zip", &payload).await.unwrap();
    *storage.truncate_zip_to.lock().unwrap() = Some(10_000);

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("half.zip");
    let error = storage
        .get_file("backups/half.zip", &dest, None, None)
        .await
        .expect_err("半包必须失败，即使没有 expected_checksum");
    assert!(
        error.to_string().contains("下载不完整"),
        "unexpected error: {error}"
    );
    assert!(!dest.exists(), "半包不得留下最终产物");
}

/// 字节数一致时下载成功，返回的 SHA256 与内容一致（防止校验修成误伤）。
#[tokio::test]
async fn get_file_with_consistent_size_succeeds() {
    let storage = TruncatingStorage::default();
    let payload = fake_backup_bytes(16 * 1024);
    storage.put("backups/full.zip", &payload).await.unwrap();

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("full.zip");
    let checksum = storage
        .get_file("backups/full.zip", &dest, None, None)
        .await
        .expect("完整下载应成功");
    assert_eq!(checksum, format!("{:x}", Sha256::digest(&payload)));
    assert_eq!(std::fs::read(&dest).unwrap(), payload);
}

/// 对象在 stat 与 get 之间被换成**更大**的版本：收到的字节多于声明大小，
/// 同样必须拒绝（错版本比半包更隐蔽——文件"看起来完整"）。
#[tokio::test]
async fn get_file_rejects_object_replaced_with_larger_version() {
    let storage = TruncatingStorage::default();
    let payload = fake_backup_bytes(8 * 1024);
    storage.put("backups/swap.zip", &payload).await.unwrap();
    *storage.grow_zip_by.lock().unwrap() = 4 * 1024;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("swap.zip");
    let error = storage
        .get_file("backups/swap.zip", &dest, None, None)
        .await
        .expect_err("get 字节数多于 stat 声明必须拒绝");
    assert!(
        error.to_string().contains("已变更") || error.to_string().contains("下载不完整"),
        "unexpected error: {error}"
    );
    assert!(!dest.exists());
}

// ============================================================================
// 2. 整文件下载路径（S3/FTP 形态的编排层）：半包不产出最终文件
// ============================================================================

#[tokio::test]
async fn whole_file_download_path_fails_closed_on_half_package() {
    let storage = TruncatingStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r10".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(64 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    // 上传完成后才开启截断：manifest 读写不受影响，只有备份对象半包。
    *storage.truncate_zip_to.lock().unwrap() = Some(20_000);

    let download_dir = TempDir::new().unwrap();
    let error = manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect_err("半包必须让整个下载失败");
    assert!(
        error.to_string().contains("下载不完整"),
        "unexpected error: {error}"
    );
    let final_zip = download_dir.path().join(format!("{}.zip", version.id));
    assert!(!final_zip.exists(), "半包不得产出最终备份文件");

    // 云端恢复正常后重试成功，字节逐位一致。
    *storage.truncate_zip_to.lock().unwrap() = None;
    manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("恢复正常后的重试应成功");
    assert_eq!(std::fs::read(&final_zip).unwrap(), payload);
}

// ============================================================================
// 3. 续传路径（WebDAV 形态的编排层）：对象被同大小换包 → SHA256 拒绝
// ============================================================================

#[tokio::test]
async fn resumable_download_rejects_same_size_object_swap_via_sha256() {
    let storage = ResumableMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r10".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(32 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    // 预埋真实前缀断点，然后把云端对象换成**同大小**的不同内容：
    // 续传的字节数核对无法发现（大小一致），必须由整文件 SHA256 兜底拒绝。
    let download_dir = TempDir::new().unwrap();
    let part = download_dir
        .path()
        .join(format!(".{}.zip.part", version.id));
    std::fs::write(&part, &payload[..8 * 1024]).unwrap();
    let swapped: Vec<u8> = payload.iter().map(|b| b ^ 0xFF).collect();
    assert_eq!(swapped.len(), payload.len());
    storage
        .put(&format!("backups/{}.zip", version.id), &swapped)
        .await
        .unwrap();

    let error = manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect_err("同大小换包拼装出的产物必须被 SHA256 拒绝");
    assert!(
        error.to_string().contains("SHA256 校验失败"),
        "unexpected error: {error}"
    );
    assert!(!part.exists(), "校验失败必须丢弃断点，避免死循环");
    assert!(
        !download_dir
            .path()
            .join(format!("{}.zip", version.id))
            .exists(),
        "校验失败不得产出最终文件"
    );
}

// ============================================================================
// 4. 无密码导入所有入口早失败（入口枚举锁定）
// ============================================================================

#[cfg(feature = "data_governance")]
mod import_password_gate {
    use std::path::PathBuf;

    use deep_student_lib::data_governance::backup::{
        export_backup_to_zip,
        zip_export::{
            import_backup_from_zip, import_backup_from_zip_resumable,
            import_backup_from_zip_with_password, import_backup_from_zip_with_progress,
        },
        BackupManager, ZipExportOptions,
    };
    use rusqlite::Connection;
    use tempfile::TempDir;

    const PASSWORD: &str = "r10-download-passphrase";

    /// 在 `base/slots/slotA` 布局下造一个可整槽恢复的真实备份，
    /// 并加密全保真导出为 ZIP。
    fn build_encrypted_zip() -> (TempDir, PathBuf) {
        let root = TempDir::new().unwrap();
        let slot = root.path().join("slots").join("slotA");
        std::fs::create_dir_all(slot.join("databases")).unwrap();
        for path in [
            slot.join("databases").join("vfs.db"),
            slot.join("chat_v2.db"),
            slot.join("mistakes.db"),
            slot.join("llm_usage.db"),
        ] {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE r10_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO r10_marker(value) VALUES ('r10-download');",
            )
            .unwrap();
        }

        let backup_dir = root.path().join("recovery").join("backups");
        let mut manager = BackupManager::new(backup_dir.clone());
        manager.set_app_data_dir(slot);
        manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
        let manifest = manager.backup_with_assets(None).expect("备份应成功");

        let zip_path = root.path().join("r10-encrypted.zip");
        export_backup_to_zip(
            &backup_dir.join(&manifest.backup_id),
            &ZipExportOptions {
                output_path: Some(zip_path.clone()),
                encryption_password: Some(PASSWORD.to_string()),
                include_checksums: true,
                ..Default::default()
            },
        )
        .expect("加密全保真导出应成功");
        (root, zip_path)
    }

    fn assert_early_password_failure(
        entry: &str,
        result: Result<usize, impl std::fmt::Display>,
        target: &std::path::Path,
    ) {
        let error = match result {
            Ok(_) => panic!("{entry}: 无密码导入加密全保真 ZIP 必须失败"),
            Err(error) => error.to_string(),
        };
        assert!(
            error.contains("备份密码"),
            "{entry}: 拒绝文案必须提示提供备份密码，实际: {error}"
        );
        assert!(
            !target.exists(),
            "{entry}: 早失败必须发生在触碰目标目录之前"
        );
    }

    /// 四个公开导入入口逐一枚举：任何一个缺密码都必须在解压前失败。
    /// 命令层（`data_governance_import_zip` / 任务恢复续传）全部经由这四个
    /// 函数进入，锁死它们即锁死所有入口。
    #[test]
    fn every_import_entry_fails_early_without_password() {
        let (_root, zip_path) = build_encrypted_zip();
        let import_root = TempDir::new().unwrap();

        let target = import_root.path().join("t1");
        assert_early_password_failure(
            "import_backup_from_zip",
            import_backup_from_zip(&zip_path, &target),
            &target,
        );

        let target = import_root.path().join("t2");
        assert_early_password_failure(
            "import_backup_from_zip_with_password(None)",
            import_backup_from_zip_with_password(&zip_path, &target, None),
            &target,
        );

        let target = import_root.path().join("t3");
        assert_early_password_failure(
            "import_backup_from_zip_with_progress",
            import_backup_from_zip_with_progress(&zip_path, &target, |_| {}, || false, None),
            &target,
        );

        let target = import_root.path().join("t4");
        assert_early_password_failure(
            "import_backup_from_zip_resumable",
            import_backup_from_zip_resumable(&zip_path, &target, |_| {}, || false, None),
            &target,
        );

        // 对照：携带正确密码时同一 ZIP 可正常导入（防止预检修成一刀切拒绝）。
        let target = import_root.path().join("ok");
        let file_count = import_backup_from_zip_with_password(&zip_path, &target, Some(PASSWORD))
            .expect("正确密码导入应成功");
        assert!(file_count > 0);
        assert!(target.join("manifest.json").is_file());
    }
}
