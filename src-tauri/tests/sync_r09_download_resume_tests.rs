//! [R09-restore-ops][P2-2] 云端 ZIP 下载断点续传回归测试
//!
//! 背景（RESTORE-MATRIX-R07 缺口 P2-2）：`download_with_progress` 曾是整文件
//! 流式下载，中断后只能整包重下——ZIP **导入**有续传而**下载**没有，多 GB
//! 备份包在移动网络上是恢复闭环里最脆的一段。
//!
//! 本文件钉住 R09 引入的续传契约：
//!
//! 1. **断点保留**：支持续传的后端下载中断后，`.{version}.zip.part` 断点
//!    文件保留，最终产物不出现；
//! 2. **精确续传**：重试同一版本从断点字节继续，完成后整文件 SHA256 与
//!    上传时的 `version.checksum` 比对通过，断点文件被原子改名为最终产物；
//! 3. **禁止静默截断当成功**：断点损坏（字节被篡改）时校验失败→断点被
//!    丢弃并明确报错，绝不把损坏文件交给恢复链；
//! 4. **服务端不配合时诚实降级**：服务端忽略续传请求（重发全量）时从零
//!    重写，结果仍然正确；本地断点比云端对象还大时丢弃断点从零重下；
//! 5. **fail-closed 默认实现**：不支持续传的后端调用 `get_file_resumable`
//!    必须得到明确错误（锁定测试，防止未来有人把默认实现改成静默整包
//!    重下冒充续传）；不支持续传的后端走整文件下载路径，不留断点文件。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{
    CloudStorage, CloudSyncManager, DownloadProgressCallback, FileInfo,
    RESUMABLE_DOWNLOAD_UNSUPPORTED,
};
use deep_student_lib::models::AppError;
use tempfile::TempDir;

type CloudResult<T> = Result<T, AppError>;

/// 共享的内存对象池（模拟一个云端 root）。
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

/// 不支持续传的内存云存储：`get_file`/`put_file`/`get_file_resumable`
/// 全部走 trait 默认实现。
#[derive(Clone, Default)]
struct PlainMemoryStorage {
    pool: Arc<ObjectPool>,
}

#[async_trait]
impl CloudStorage for PlainMemoryStorage {
    fn provider_name(&self) -> &'static str {
        "memory-plain-r09"
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
}

/// 支持续传的内存云存储。
///
/// - `fail_after_bytes`：为 `Some(n)` 时，本次续传只写出 n 字节就返回网络
///   错误（模拟传输中断；一次性触发，之后恢复正常）；
/// - `ignore_resume`：为 true 时无视续传起点、从零重写（模拟不支持 Range
///   的服务端，对应 WebDAV 收到 200 的诚实降级形态）；
/// - `resume_requests`：记录每次调用请求的续传起点，供断言。
#[derive(Clone, Default)]
struct ResumableMemoryStorage {
    pool: Arc<ObjectPool>,
    fail_after_bytes: Arc<Mutex<Option<usize>>>,
    ignore_resume: Arc<Mutex<bool>>,
    resume_requests: Arc<Mutex<Vec<u64>>>,
}

#[async_trait]
impl CloudStorage for ResumableMemoryStorage {
    fn provider_name(&self) -> &'static str {
        "memory-resumable-r09"
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

    /// 按 trait 契约实现的内存版续传：从 `resume_from` 追加到 `dest`。
    async fn get_file_resumable(
        &self,
        key: &str,
        dest: &Path,
        resume_from: u64,
        progress: Option<DownloadProgressCallback>,
    ) -> CloudResult<u64> {
        self.resume_requests.lock().unwrap().push(resume_from);

        let data = self
            .pool
            .get(key)
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total = data.len() as u64;
        assert!(
            resume_from <= total,
            "编排层必须保证断点不大于云端对象（断点无效时应先丢弃）"
        );

        // 服务端忽略续传起点：诚实从零重写（对应 WebDAV 收到 200 的形态）。
        let actual_start = if *self.ignore_resume.lock().unwrap() {
            0
        } else {
            resume_from
        };
        let mut remaining = &data[actual_start as usize..];

        // 模拟传输中断：只写出前 n 字节就报网络错误（断点保持前缀完整）。
        let fail_after = self.fail_after_bytes.lock().unwrap().take();
        let interrupted = match fail_after {
            Some(n) if n < remaining.len() => {
                remaining = &remaining[..n];
                true
            }
            _ => false,
        };

        use std::io::Write;
        let mut file = if actual_start > 0 {
            let existing = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            assert_eq!(
                existing, actual_start,
                "断点文件必须恰好有 resume_from 字节"
            );
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
            cb(actual_start + remaining.len() as u64, total);
        }

        if interrupted {
            return Err(AppError::network(
                "模拟传输中断（断点保留，可重试续传）".to_string(),
            ));
        }
        Ok(actual_start)
    }
}

/// 造一个内容可辨识的假备份字节流（内容无需是合法 ZIP，
/// 下载路径只关心字节与 SHA256）。
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
        .upload(&zip_path, Some("r09-test".into()), None)
        .await
        .expect("上传测试备份应成功")
        .version
}

fn partial_path(dir: &Path, version_id: &str) -> std::path::PathBuf {
    dir.join(format!(".{version_id}.zip.part"))
}

#[tokio::test]
async fn interrupted_download_keeps_partial_then_resume_completes() {
    let storage = ResumableMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r09".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(64 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    let download_dir = TempDir::new().unwrap();

    // 第一次下载：在 10_000 字节处模拟中断。
    *storage.fail_after_bytes.lock().unwrap() = Some(10_000);
    let error = manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect_err("被中断的下载必须报错，不能静默截断当成功");
    assert!(
        error.to_string().contains("中断"),
        "unexpected error: {error}"
    );

    let part = partial_path(download_dir.path(), &version.id);
    let final_zip = download_dir.path().join(format!("{}.zip", version.id));
    assert!(part.is_file(), "中断后必须保留断点文件");
    assert_eq!(
        std::fs::metadata(&part).unwrap().len(),
        10_000,
        "断点文件必须是前缀完整的 10_000 字节"
    );
    assert!(!final_zip.exists(), "中断后不得出现最终产物");

    // 第二次下载：必须从断点续传并完成。
    let result = manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("续传下载应成功");
    let requests = storage.resume_requests.lock().unwrap().clone();
    assert_eq!(requests, vec![0, 10_000], "第二次调用必须从断点字节续传");
    assert!(!part.exists(), "完成后断点文件必须被改名移除");
    assert_eq!(result.local_path, final_zip.to_string_lossy().to_string());
    assert_eq!(
        std::fs::read(&final_zip).unwrap(),
        payload,
        "续传拼装出的最终产物必须与原始字节一致"
    );
}

#[tokio::test]
async fn corrupted_partial_is_discarded_with_explicit_checksum_error() {
    let storage = ResumableMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r09".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(32 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    // 预埋一个被篡改的断点：长度合法（< 对象大小）但字节错误。
    let download_dir = TempDir::new().unwrap();
    let part = partial_path(download_dir.path(), &version.id);
    std::fs::write(&part, vec![0xAA; 8 * 1024]).unwrap();

    let error = manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect_err("损坏断点续传完成后必须被 SHA256 校验拒绝");
    assert!(
        error.to_string().contains("SHA256 校验失败"),
        "unexpected error: {error}"
    );
    assert!(!part.exists(), "校验失败必须丢弃损坏断点，避免死循环");
    assert!(
        !download_dir
            .path()
            .join(format!("{}.zip", version.id))
            .exists(),
        "校验失败不得产出最终文件"
    );

    // 丢弃断点后重试：从零全新下载，成功。
    manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("丢弃损坏断点后的重试应成功");
    assert_eq!(
        std::fs::read(download_dir.path().join(format!("{}.zip", version.id))).unwrap(),
        payload
    );
}

#[tokio::test]
async fn server_ignoring_resume_restarts_from_zero_and_still_succeeds() {
    let storage = ResumableMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r09".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(16 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    // 预埋合法断点（真实前缀），但服务端不配合续传。
    let download_dir = TempDir::new().unwrap();
    let part = partial_path(download_dir.path(), &version.id);
    std::fs::write(&part, &payload[..4 * 1024]).unwrap();
    *storage.ignore_resume.lock().unwrap() = true;

    manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("服务端忽略续传时应从零重写并成功");
    assert_eq!(
        std::fs::read(download_dir.path().join(format!("{}.zip", version.id))).unwrap(),
        payload,
        "从零重写的结果必须正确，不能把全量响应错位追加到断点后面"
    );
}

#[tokio::test]
async fn oversized_partial_is_discarded_and_download_restarts_fresh() {
    let storage = ResumableMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r09".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(8 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    // 断点比云端对象还大：断点无效，必须丢弃后从零重下。
    let download_dir = TempDir::new().unwrap();
    let part = partial_path(download_dir.path(), &version.id);
    std::fs::write(&part, vec![0u8; 32 * 1024]).unwrap();

    manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("无效断点应被丢弃并全新下载成功");
    let requests = storage.resume_requests.lock().unwrap().clone();
    assert_eq!(requests, vec![0], "无效断点必须以 resume_from=0 全新下载");
    assert_eq!(
        std::fs::read(download_dir.path().join(format!("{}.zip", version.id))).unwrap(),
        payload
    );
}

#[tokio::test]
async fn non_resumable_provider_downloads_whole_file_without_partial() {
    let storage = PlainMemoryStorage::default();
    let manager = CloudSyncManager::new(Box::new(storage.clone()), "device-r09".to_string());
    let work = TempDir::new().unwrap();
    let payload = fake_backup_bytes(8 * 1024);
    let version = upload_fixture(&manager, &work, &payload).await;

    let download_dir = TempDir::new().unwrap();
    manager
        .download(Some(&version.id), download_dir.path())
        .await
        .expect("不支持续传的后端仍应能整文件下载");
    assert_eq!(
        std::fs::read(download_dir.path().join(format!("{}.zip", version.id))).unwrap(),
        payload
    );
    assert!(
        !partial_path(download_dir.path(), &version.id).exists(),
        "整文件下载路径不应留下断点文件"
    );
}

#[tokio::test]
async fn default_get_file_resumable_is_fail_closed() {
    // 锁定测试：trait 默认实现必须明确拒绝，绝不静默整包重下冒充续传。
    let storage = PlainMemoryStorage::default();
    storage
        .put("backups/whatever.zip", b"payload")
        .await
        .unwrap();

    let dir = TempDir::new().unwrap();
    let error = storage
        .get_file_resumable(
            "backups/whatever.zip",
            &dir.path().join("out.part"),
            0,
            None,
        )
        .await
        .expect_err("默认实现必须 fail-closed");
    assert_eq!(error.to_string(), RESUMABLE_DOWNLOAD_UNSUPPORTED);
    assert!(
        error.to_string().contains("不支持断点续传"),
        "错误文案必须点明不支持续传: {error}"
    );
    assert!(
        !dir.path().join("out.part").exists(),
        "fail-closed 路径不得写任何字节"
    );
}
