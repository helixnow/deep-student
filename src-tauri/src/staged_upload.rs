//! 分块暂存上传（staged upload）
//!
//! 大文件此前在 WebView 内 `readAsDataURL` → base64 → JSON IPC，一份 200MB 文件在
//! 渲染进程里同时存在 ArrayBuffer、base64 字符串、JSON 字符串等多份拷贝，手机上
//! 渲染进程 OOM（Android 上会连带杀掉整个应用）。
//!
//! 本模块把二进制传输改为「分块写入 Rust 侧临时文件」：
//! - `staged_upload_begin(name, totalSize)` 申请上传 ID，创建 `$APPCACHE/staged_uploads/<id>.part`；
//! - `staged_upload_append` 每次写入一个有界分块（桌面走 Tauri 原始二进制 IPC
//!   `InvokeBody::Raw`，Android 没有 custom-protocol 请求体，走 JSON + 分块 base64）；
//! - `staged_upload_from_path(path)` 已有文件路径（拖放 / 对话框 / content://）时
//!   由 Rust 直接流式复制进暂存区，WebView 不经手任何字节；
//! - 消费方（`vfs_upload_attachment` / `dstu_create`）用 `take_staged_upload(id)`
//!   取走完整暂存文件，读取后 `StagedFile` drop 即删除临时文件；
//! - `staged_upload_abort(id)` 取消；闲置超时与上次进程残留由 sweep 清理。
//!
//! 任一时刻 WebView 只持有一个分块（默认 4MB），Rust 侧也只在最终消费时读入一份。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Once};
use std::time::{Duration, Instant, SystemTime};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Window};

/// 单个暂存上传的硬上限（与附件 `MAX_FILE_BYTES` / `read_file_bytes` 上限对齐）
pub const STAGED_UPLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// 单个分块的硬上限（前端默认 4MB，这里留余量）
pub const STAGED_UPLOAD_MAX_CHUNK_BYTES: usize = 16 * 1024 * 1024;
/// 闲置超时：超过该时间未追加/未消费的暂存上传视为放弃（页面刷新、崩溃等）
const STAGED_UPLOAD_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
const STAGING_DIR_NAME: &str = "staged_uploads";
const PART_SUFFIX: &str = ".part";

const HEADER_UPLOAD_ID: &str = "x-upload-id";
const HEADER_UPLOAD_OFFSET: &str = "x-upload-offset";

struct Entry {
    path: PathBuf,
    name: String,
    total: u64,
    received: u64,
    last_touch: Instant,
}

type Registry = Mutex<HashMap<String, Arc<Mutex<Entry>>>>;

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Mutex::new(HashMap::new()));
static STARTUP_SWEEP: Once = Once::new();

fn registry() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Mutex<Entry>>>> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_entry(entry: &Mutex<Entry>) -> std::sync::MutexGuard<'_, Entry> {
    entry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn part_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{PART_SUFFIX}"))
}

fn format_mb(bytes: u64) -> String {
    format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
}

fn too_large_error(actual: u64, max: u64) -> String {
    format!(
        "File too large: max {}, got {}",
        format_mb(max),
        format_mb(actual)
    )
}

/// 完整的暂存文件；drop 时删除临时文件（消费成功或失败都不留残余）。
#[derive(Debug)]
pub struct StagedFile {
    path: PathBuf,
    name: String,
    size: u64,
}

impl StagedFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// 读入内存（带上限）。超限直接报错，不做任何分配。
    pub fn read_bounded(&self, max_bytes: u64) -> Result<Vec<u8>, String> {
        if self.size > max_bytes {
            return Err(too_large_error(self.size, max_bytes));
        }
        let file =
            File::open(&self.path).map_err(|e| format!("Failed to open staged upload: {}", e))?;
        let mut buffer = Vec::with_capacity(self.size as usize);
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read staged upload: {}", e))?;
        if buffer.len() as u64 > max_bytes {
            return Err(too_large_error(buffer.len() as u64, max_bytes));
        }
        if buffer.len() as u64 != self.size {
            return Err(format!(
                "Staged upload changed on disk: expected {} bytes, read {}",
                self.size,
                buffer.len()
            ));
        }
        Ok(buffer)
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "[StagedUpload] Failed to remove staged file {}: {}",
                    self.path.display(),
                    e
                );
            }
        }
    }
}

/// 清理：闲置超时的登记项 + 目录内未登记的残留文件。
///
/// `remove_all_orphans = true` 用于进程内首次调用（上次运行的残留一律删除）；
/// 之后只删除超过 TTL 的未登记文件，避免误删正在落盘、尚未登记的文件。
fn sweep(dir: &Path, remove_all_orphans: bool) {
    let now = Instant::now();
    let expired: Vec<(String, PathBuf)> = {
        let mut map = registry();
        let expired_ids: Vec<String> = map
            .iter()
            .filter(|(_, entry)| {
                // 正在写入的分块持有条目锁，try_lock 失败说明活跃，跳过
                entry
                    .try_lock()
                    .map(|e| now.duration_since(e.last_touch) > STAGED_UPLOAD_IDLE_TTL)
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        expired_ids
            .into_iter()
            .filter_map(|id| {
                map.remove(&id)
                    .map(|entry| (id, lock_entry(&entry).path.clone()))
            })
            .collect()
    };
    for (id, path) in expired {
        log::info!("[StagedUpload] Dropping idle staged upload {}", id);
        let _ = std::fs::remove_file(path);
    }

    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    let registered: std::collections::HashSet<PathBuf> = registry()
        .values()
        .map(|entry| lock_entry(entry).path.clone())
        .collect();
    for item in read_dir.flatten() {
        let path = item.path();
        if registered.contains(&path) {
            continue;
        }
        let stale = remove_all_orphans
            || item
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .map(|age| age > STAGED_UPLOAD_IDLE_TTL)
                .unwrap_or(false);
        if stale && path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn prepare_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    let mut first = false;
    STARTUP_SWEEP.call_once(|| first = true);
    sweep(dir, first);
    Ok(())
}

/// 申请一个分块上传（核心逻辑，目录显式传入便于测试）。
pub fn begin_in(dir: &Path, name: &str, total_size: u64, max_bytes: u64) -> Result<String, String> {
    let max_bytes = max_bytes.min(STAGED_UPLOAD_MAX_BYTES);
    if total_size > max_bytes {
        return Err(too_large_error(total_size, max_bytes));
    }
    prepare_dir(dir)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = part_path(dir, &id);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Failed to create staged upload file: {}", e))?;
    registry().insert(
        id.clone(),
        Arc::new(Mutex::new(Entry {
            path,
            name: name.to_string(),
            total: total_size,
            received: 0,
            last_touch: Instant::now(),
        })),
    );
    Ok(id)
}

/// 追加一个分块。`offset` 必须等于已接收字节数（拒绝乱序/重放/空洞）。
/// 写入失败视为不可恢复：放弃整个上传并删除临时文件。
pub fn append(upload_id: &str, offset: u64, chunk: &[u8]) -> Result<u64, String> {
    if chunk.len() > STAGED_UPLOAD_MAX_CHUNK_BYTES {
        return Err(format!(
            "Chunk too large: {} bytes (max {})",
            chunk.len(),
            STAGED_UPLOAD_MAX_CHUNK_BYTES
        ));
    }
    let entry = registry()
        .get(upload_id)
        .cloned()
        .ok_or_else(|| format!("Unknown or expired upload: {}", upload_id))?;
    let mut guard = lock_entry(&entry);
    if offset != guard.received {
        return Err(format!(
            "Unexpected chunk offset {} (expected {})",
            offset, guard.received
        ));
    }
    let next = guard.received + chunk.len() as u64;
    if next > guard.total {
        let total = guard.total;
        drop(guard);
        abort(upload_id);
        return Err(format!("Chunk exceeds declared size: {} > {}", next, total));
    }
    let write_result = OpenOptions::new()
        .append(true)
        .open(&guard.path)
        .and_then(|mut file| file.write_all(chunk));
    if let Err(e) = write_result {
        drop(guard);
        abort(upload_id);
        return Err(format!("Failed to write staged upload chunk: {}", e));
    }
    guard.received = next;
    guard.last_touch = Instant::now();
    Ok(next)
}

/// 取消上传并删除临时文件（幂等）。
pub fn abort(upload_id: &str) {
    let removed = registry().remove(upload_id);
    if let Some(entry) = removed {
        let path = lock_entry(&entry).path.clone();
        let _ = std::fs::remove_file(path);
    }
}

/// 取走一个已完整接收的暂存上传。未完整（字节数不足）时同样移除并报错。
pub fn take_staged_upload(upload_id: &str) -> Result<StagedFile, String> {
    let entry = registry()
        .remove(upload_id)
        .ok_or_else(|| format!("Unknown or expired upload: {}", upload_id))?;
    let guard = lock_entry(&entry);
    let staged = StagedFile {
        path: guard.path.clone(),
        name: guard.name.clone(),
        size: guard.received,
    };
    if guard.received != guard.total {
        // staged drop 时删除文件
        return Err(format!(
            "Upload incomplete: received {} of {} bytes",
            guard.received, guard.total
        ));
    }
    Ok(staged)
}

/// 从任意 Reader 流式写入暂存区（带上限），完成后登记为已完整的上传。
pub fn stage_from_reader(
    dir: &Path,
    name: &str,
    reader: &mut dyn Read,
    max_bytes: u64,
) -> Result<(String, u64), String> {
    let max_bytes = max_bytes.min(STAGED_UPLOAD_MAX_BYTES);
    prepare_dir(dir)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = part_path(dir, &id);
    let copy = (|| -> Result<u64, String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Failed to create staged upload file: {}", e))?;
        let mut limited = reader.take(max_bytes.saturating_add(1));
        let written = std::io::copy(&mut limited, &mut file)
            .map_err(|e| format!("Failed to copy file into staging area: {}", e))?;
        if written > max_bytes {
            return Err(too_large_error(written, max_bytes));
        }
        file.flush()
            .map_err(|e| format!("Failed to flush staged upload: {}", e))?;
        Ok(written)
    })();
    match copy {
        Ok(size) => {
            registry().insert(
                id.clone(),
                Arc::new(Mutex::new(Entry {
                    path,
                    name: name.to_string(),
                    total: size,
                    received: size,
                    last_touch: Instant::now(),
                })),
            );
            Ok((id, size))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(STAGING_DIR_NAME))
        .map_err(|e| format!("Failed to resolve app cache directory: {}", e))
}

/// 解析 append 请求：桌面为原始二进制（ID/offset 在请求头），Android 为 JSON
/// `{ uploadId, offset, data: <base64> }`。postMessage 回退时 Uint8Array 会被
/// 序列化为数字数组，同样兼容（受分块上限约束）。
fn parse_append_request(
    body: &InvokeBody,
    header_id: Option<&str>,
    header_offset: Option<&str>,
) -> Result<(String, u64, Vec<u8>), String> {
    let header_offset = header_offset
        .map(|v| {
            v.trim()
                .parse::<u64>()
                .map_err(|_| format!("Invalid {} header", HEADER_UPLOAD_OFFSET))
        })
        .transpose()?;
    match body {
        InvokeBody::Raw(bytes) => {
            let id = header_id.ok_or_else(|| format!("Missing {} header", HEADER_UPLOAD_ID))?;
            let offset =
                header_offset.ok_or_else(|| format!("Missing {} header", HEADER_UPLOAD_OFFSET))?;
            if bytes.len() > STAGED_UPLOAD_MAX_CHUNK_BYTES {
                return Err(format!("Chunk too large: {} bytes", bytes.len()));
            }
            Ok((id.to_string(), offset, bytes.clone()))
        }
        InvokeBody::Json(serde_json::Value::Object(map)) => {
            let id = map
                .get("uploadId")
                .and_then(|v| v.as_str())
                .or(header_id)
                .ok_or("Missing uploadId")?;
            let offset = map
                .get("offset")
                .and_then(|v| v.as_u64())
                .or(header_offset)
                .ok_or("Missing offset")?;
            let data = map
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or("Missing chunk data")?;
            if data.len() > STAGED_UPLOAD_MAX_CHUNK_BYTES.div_ceil(3) * 4 + 4 {
                return Err(format!("Chunk too large: {} base64 chars", data.len()));
            }
            let bytes = BASE64
                .decode(data)
                .map_err(|e| format!("Invalid chunk base64: {}", e))?;
            Ok((id.to_string(), offset, bytes))
        }
        InvokeBody::Json(serde_json::Value::Array(items)) => {
            let id = header_id.ok_or_else(|| format!("Missing {} header", HEADER_UPLOAD_ID))?;
            let offset =
                header_offset.ok_or_else(|| format!("Missing {} header", HEADER_UPLOAD_OFFSET))?;
            if items.len() > STAGED_UPLOAD_MAX_CHUNK_BYTES {
                return Err(format!("Chunk too large: {} bytes", items.len()));
            }
            let bytes = items
                .iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= u8::MAX as u64)
                        .map(|n| n as u8)
                        .ok_or("Invalid byte in chunk")
                })
                .collect::<Result<Vec<u8>, _>>()?;
            Ok((id.to_string(), offset, bytes))
        }
        _ => Err("Unsupported chunk payload".to_string()),
    }
}

#[tauri::command]
pub async fn staged_upload_begin(
    app: AppHandle,
    name: String,
    total_size: u64,
) -> Result<String, String> {
    let dir = staging_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        begin_in(&dir, &name, total_size, STAGED_UPLOAD_MAX_BYTES)
    })
    .await
    .map_err(|e| format!("Staged upload task failed: {}", e))?
}

#[tauri::command]
pub async fn staged_upload_append(request: Request<'_>) -> Result<u64, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let header_id = header(HEADER_UPLOAD_ID);
    let header_offset = header(HEADER_UPLOAD_OFFSET);
    let (id, offset, bytes) = parse_append_request(
        request.body(),
        header_id.as_deref(),
        header_offset.as_deref(),
    )?;
    tauri::async_runtime::spawn_blocking(move || append(&id, offset, &bytes))
        .await
        .map_err(|e| format!("Staged upload task failed: {}", e))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFromPath {
    pub upload_id: String,
    pub size: u64,
}

/// 已有文件路径（本地路径或 content:// 等虚拟 URI）时由 Rust 直接复制进暂存区。
#[tauri::command]
pub async fn staged_upload_from_path(
    window: Window,
    path: String,
) -> Result<StagedFromPath, String> {
    crate::commands::deny_hidden_local_path(&window, &path).map_err(|e| e.to_string())?;
    let dir = staging_dir(window.app_handle())?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = crate::unified_file_manager::extract_file_name(&path);
        let mut reader = crate::unified_file_manager::open_read_stream(&window, &path)
            .map_err(|e| e.to_string())?;
        let (upload_id, size) =
            stage_from_reader(&dir, &name, &mut reader, STAGED_UPLOAD_MAX_BYTES)?;
        Ok(StagedFromPath { upload_id, size })
    })
    .await
    .map_err(|e| format!("Staged upload task failed: {}", e))?
}

#[tauri::command]
pub async fn staged_upload_abort(upload_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || abort(&upload_id))
        .await
        .map_err(|e| format!("Staged upload task failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn chunks_assemble_in_order_and_take_cleans_up() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a.bin", 10, STAGED_UPLOAD_MAX_BYTES).unwrap();
        assert_eq!(append(&id, 0, b"hello").unwrap(), 5);
        assert_eq!(append(&id, 5, b"world").unwrap(), 10);
        let staged = take_staged_upload(&id).unwrap();
        assert_eq!(staged.name(), "a.bin");
        assert_eq!(staged.size(), 10);
        let path = staged.path().to_path_buf();
        assert_eq!(staged.read_bounded(100).unwrap(), b"helloworld");
        drop(staged);
        assert!(!path.exists(), "staged file must be deleted on drop");
        assert!(take_staged_upload(&id).is_err(), "take is single-use");
    }

    #[test]
    fn rejects_out_of_order_and_oversized_chunks() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a.bin", 4, STAGED_UPLOAD_MAX_BYTES).unwrap();
        assert!(append(&id, 2, b"ab").is_err(), "gap rejected");
        append(&id, 0, b"ab").unwrap();
        assert!(append(&id, 0, b"ab").is_err(), "replay rejected");
        // 超出声明大小：放弃整个上传并删除文件
        let path = part_path(dir.path(), &id);
        assert!(append(&id, 2, b"abc").is_err());
        assert!(!path.exists());
        assert!(append(&id, 2, b"ab").is_err(), "aborted upload is gone");
    }

    #[test]
    fn begin_enforces_size_limit() {
        let dir = tmp();
        assert!(begin_in(dir.path(), "big", 11, 10).is_err());
        assert!(begin_in(dir.path(), "big", STAGED_UPLOAD_MAX_BYTES + 1, u64::MAX).is_err());
        assert!(begin_in(dir.path(), "ok", 10, 10).is_ok());
    }

    #[test]
    fn incomplete_upload_cannot_be_taken_and_is_removed() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a", 8, STAGED_UPLOAD_MAX_BYTES).unwrap();
        append(&id, 0, b"1234").unwrap();
        let path = part_path(dir.path(), &id);
        assert!(take_staged_upload(&id).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn abort_removes_file_and_is_idempotent() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a", 8, STAGED_UPLOAD_MAX_BYTES).unwrap();
        append(&id, 0, b"1234").unwrap();
        let path = part_path(dir.path(), &id);
        assert!(path.exists());
        abort(&id);
        abort(&id);
        assert!(!path.exists());
        assert!(append(&id, 4, b"5678").is_err());
    }

    #[test]
    fn read_bounded_rejects_over_limit() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a", 4, STAGED_UPLOAD_MAX_BYTES).unwrap();
        append(&id, 0, b"abcd").unwrap();
        let staged = take_staged_upload(&id).unwrap();
        assert!(staged.read_bounded(3).is_err());
    }

    #[test]
    fn stage_from_reader_enforces_limit_and_cleans_up() {
        let dir = tmp();
        let mut ok_reader: &[u8] = b"0123456789";
        let (id, size) = stage_from_reader(dir.path(), "r.bin", &mut ok_reader, 10).unwrap();
        assert_eq!(size, 10);
        let staged = take_staged_upload(&id).unwrap();
        assert_eq!(staged.read_bounded(10).unwrap(), b"0123456789");
        drop(staged);

        let mut big_reader: &[u8] = b"0123456789A";
        assert!(stage_from_reader(dir.path(), "r.bin", &mut big_reader, 10).is_err());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert!(
            leftovers.is_empty(),
            "failed copy must not leave temp files"
        );
    }

    #[test]
    fn sweep_removes_orphans_but_keeps_registered() {
        let dir = tmp();
        let id = begin_in(dir.path(), "a", 4, STAGED_UPLOAD_MAX_BYTES).unwrap();
        let orphan = dir.path().join("orphan.part");
        std::fs::write(&orphan, b"x").unwrap();
        sweep(dir.path(), true);
        assert!(!orphan.exists());
        assert!(part_path(dir.path(), &id).exists());
        abort(&id);
    }

    #[test]
    fn parses_raw_json_and_array_payloads() {
        let raw = InvokeBody::Raw(vec![1, 2, 3]);
        let (id, off, bytes) = parse_append_request(&raw, Some("u1"), Some("7")).unwrap();
        assert_eq!(
            (id.as_str(), off, bytes.as_slice()),
            ("u1", 7, &[1u8, 2, 3][..])
        );
        assert!(parse_append_request(&raw, None, Some("0")).is_err());

        let json = InvokeBody::Json(serde_json::json!({
            "uploadId": "u2", "offset": 3, "data": BASE64.encode([9u8, 8, 7])
        }));
        let (id, off, bytes) = parse_append_request(&json, None, None).unwrap();
        assert_eq!(
            (id.as_str(), off, bytes.as_slice()),
            ("u2", 3, &[9u8, 8, 7][..])
        );

        let arr = InvokeBody::Json(serde_json::json!([4, 5, 255]));
        let (_, _, bytes) = parse_append_request(&arr, Some("u3"), Some("0")).unwrap();
        assert_eq!(bytes, vec![4, 5, 255]);
        let bad = InvokeBody::Json(serde_json::json!([256]));
        assert!(parse_append_request(&bad, Some("u3"), Some("0")).is_err());
    }
}
