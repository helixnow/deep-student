//! [R09-restore-ops][P2-2] WebDAV Range 断点续传下载行为契约测试。
//!
//! 用进程内假 WebDAV 服务器（原生 TCP + 手写 HTTP 响应）锁定
//! `WebDavStorage::get_file_resumable` 的三种服务端形态：
//!
//! 1. **206 精确续传**：服务端按 `Range: bytes=<o>-` 返回 206 +
//!    `Content-Range: bytes <o>-<end>/<total>` → 从断点追加，最终字节正确；
//! 2. **200 忽略 Range**：服务端重发全量 → 客户端必须截断本地断点从零重写
//!    （诚实重下），绝不把全量响应错位追加到断点后面；
//! 3. **206 错位**：服务端返回的 `Content-Range` 起点与请求不一致 →
//!    fail-closed 明确失败，本地断点保持原样，禁止静默错位追加。
//!
//! 另锁定：响应体字节数不足声明大小时（传输中断形态）必须报错且保留
//! 前缀完整的断点，禁止把截断当成功。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use deep_student_lib::cloud_storage::{
    create_storage, CloudStorage, CloudStorageConfig, StorageProvider, WebDavConfig,
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ROOT: &str = "sync-root";
const FILE_KEY: &str = "backups/r09-resume.zip";

/// 服务端行为形态。
#[derive(Clone, Copy, PartialEq)]
enum RangeMode {
    /// 按 Range 精确续传（206 + 正确 Content-Range）。
    Honor,
    /// 忽略 Range，永远返回 200 全量。
    Ignore,
    /// 返回 206 但 Content-Range 起点比请求多 1 字节（错位）。
    Misaligned,
    /// 按 Range 返回 206，但响应体在中途截断（声明大小 > 实际字节）。
    TruncateBody,
}

fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 239) as u8).collect()
}

/// 单文件 depth-0 PROPFIND 207 响应体。
fn propfind_stat_body(href: &str, size: usize) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{size}</d:getcontentlength><d:getlastmodified>Tue, 01 Jul 2025 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
    )
}

/// 进程内假 WebDAV 服务器：PROPFIND 返回单文件 stat，GET 按 `mode` 响应。
/// 返回 (监听地址, 收到的 GET Range 头记录)。
async fn spawn_fake_server(
    body: Vec<u8>,
    mode: RangeMode,
) -> (SocketAddr, Arc<std::sync::Mutex<Vec<Option<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake webdav server");
    let addr = listener.local_addr().expect("local addr");
    let get_ranges: Arc<std::sync::Mutex<Vec<Option<String>>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let ranges_clone = Arc::clone(&get_ranges);
    let served = Arc::new(AtomicUsize::new(0));

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let body = body.clone();
            let ranges = Arc::clone(&ranges_clone);
            let _served = Arc::clone(&served);
            tokio::spawn(async move {
                let mut buf: Vec<u8> = Vec::with_capacity(2048);
                let mut chunk = [0u8; 1024];
                let header_end = loop {
                    match socket.read(&mut chunk).await {
                        Ok(0) => return,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break pos + 4;
                            }
                            if buf.len() > 64 * 1024 {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                };
                let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let content_length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.trim()
                            .eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                let mut body_read = buf.len() - header_end;
                while body_read < content_length {
                    match socket.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(n) => body_read += n,
                        Err(_) => return,
                    }
                }

                let request_path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();

                if head.starts_with("PROPFIND ") {
                    let body = propfind_stat_body(&request_path, body.len());
                    let response = format!(
                        "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                    return;
                }

                if head.starts_with("GET ") {
                    let range_header = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.trim()
                            .eq_ignore_ascii_case("range")
                            .then(|| value.trim().to_string())
                    });
                    ranges.lock().unwrap().push(range_header.clone());

                    let requested_start = range_header.as_deref().and_then(|raw| {
                        raw.strip_prefix("bytes=")?
                            .split('-')
                            .next()?
                            .parse::<u64>()
                            .ok()
                    });
                    let total = body.len();

                    let (status_line, extra_headers, served_body): (String, String, Vec<u8>) =
                        match (mode, requested_start) {
                            (RangeMode::Ignore, _) | (_, None) => {
                                ("HTTP/1.1 200 OK".to_string(), String::new(), body.clone())
                            }
                            (RangeMode::Honor, Some(start)) => {
                                let start = start as usize;
                                (
                                    "HTTP/1.1 206 Partial Content".to_string(),
                                    format!(
                                        "Content-Range: bytes {}-{}/{}\r\n",
                                        start,
                                        total - 1,
                                        total
                                    ),
                                    body[start..].to_vec(),
                                )
                            }
                            (RangeMode::Misaligned, Some(start)) => {
                                let wrong_start = (start + 1) as usize;
                                (
                                    "HTTP/1.1 206 Partial Content".to_string(),
                                    format!(
                                        "Content-Range: bytes {}-{}/{}\r\n",
                                        wrong_start,
                                        total - 1,
                                        total
                                    ),
                                    body[wrong_start..].to_vec(),
                                )
                            }
                            (RangeMode::TruncateBody, Some(start)) => {
                                let start = start as usize;
                                let full = &body[start..];
                                // 声明完整长度，但只发一半字节后断开。
                                let half = full.len() / 2;
                                (
                                    "HTTP/1.1 206 Partial Content".to_string(),
                                    format!(
                                        "Content-Range: bytes {}-{}/{}\r\nX-Truncate-Declared: {}\r\n",
                                        start,
                                        total - 1,
                                        total,
                                        full.len()
                                    ),
                                    full[..half].to_vec(),
                                )
                            }
                        };

                    let declared_length =
                        if mode == RangeMode::TruncateBody && requested_start.is_some() {
                            // 声明比实际发送更多的字节：模拟中途断开的传输。
                            served_body.len() * 2
                        } else {
                            served_body.len()
                        };
                    let response_head = format!(
                        "{status_line}\r\n{extra_headers}Content-Type: application/octet-stream\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(response_head.as_bytes()).await;
                    let _ = socket.write_all(&served_body).await;
                    // 不足声明长度即断开连接（reqwest 流会得到错误或提前 EOF）。
                    let _ = socket.shutdown().await;
                    return;
                }

                let _ = socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let _ = socket.shutdown().await;
            });
        }
    });

    (addr, get_ranges)
}

fn webdav_config(addr: SocketAddr) -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: format!("http://{addr}/"),
            username: "student".to_string(),
            password: "correct-horse".to_string(),
        }),
        s3: None,
        ftp: None,
        root: Some(ROOT.to_string()),
        encryption_password: None,
        insecure_transport_authorized: false,
    }
}

async fn storage_for(addr: SocketAddr) -> Box<dyn CloudStorage> {
    create_storage(&webdav_config(addr))
        .await
        .expect("loopback HTTP WebDAV 配置应能创建存储实例")
}

#[tokio::test]
async fn webdav_advertises_resumable_download() {
    let (addr, _) = spawn_fake_server(payload(16), RangeMode::Honor).await;
    let storage = storage_for(addr).await;
    assert!(
        storage.supports_resumable_download(),
        "WebDAV 后端必须声明支持断点续传下载"
    );
}

#[tokio::test]
async fn range_206_resumes_exactly_from_offset() {
    let data = payload(20_000);
    let (addr, ranges) = spawn_fake_server(data.clone(), RangeMode::Honor).await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("resume.part");
    std::fs::write(&dest, &data[..7_000]).unwrap();

    let resumed_from = storage
        .get_file_resumable(FILE_KEY, &dest, 7_000, None)
        .await
        .expect("206 精确续传应成功");

    assert_eq!(resumed_from, 7_000, "应从请求的断点续传");
    assert_eq!(
        ranges.lock().unwrap().as_slice(),
        &[Some("bytes=7000-".to_string())],
        "断点 > 0 时必须携带 Range 头"
    );
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        data,
        "拼装结果必须逐字节正确"
    );
}

#[tokio::test]
async fn range_ignored_200_truncates_and_rewrites_from_zero() {
    let data = payload(12_000);
    let (addr, _) = spawn_fake_server(data.clone(), RangeMode::Ignore).await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("resume.part");
    // 预埋"错误内容"的断点：若客户端错位追加或保留旧断点，最终字节必然不对。
    std::fs::write(&dest, vec![0xEE; 5_000]).unwrap();

    let resumed_from = storage
        .get_file_resumable(FILE_KEY, &dest, 5_000, None)
        .await
        .expect("服务端忽略 Range 时应诚实从零重下并成功");

    assert_eq!(resumed_from, 0, "HTTP 200 表示服务端未续传，起点必须归零");
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        data,
        "从零重写后的内容必须是完整对象（旧断点被截断丢弃）"
    );
}

#[tokio::test]
async fn misaligned_content_range_fails_closed_and_keeps_partial() {
    let data = payload(10_000);
    let (addr, _) = spawn_fake_server(data.clone(), RangeMode::Misaligned).await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("resume.part");
    let partial = &data[..3_000];
    std::fs::write(&dest, partial).unwrap();

    let error = storage
        .get_file_resumable(FILE_KEY, &dest, 3_000, None)
        .await
        .expect_err("Content-Range 起点错位必须 fail-closed");

    assert!(
        error.to_string().contains("续传起点与请求不一致"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        partial,
        "错位响应不得写入任何字节，断点保持原样"
    );
}

#[tokio::test]
async fn truncated_body_is_an_error_and_partial_stays_prefix_complete() {
    let data = payload(40_000);
    let (addr, _) = spawn_fake_server(data.clone(), RangeMode::TruncateBody).await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("resume.part");
    std::fs::write(&dest, &data[..10_000]).unwrap();

    let error = storage
        .get_file_resumable(FILE_KEY, &dest, 10_000, None)
        .await
        .expect_err("响应体不足声明大小必须报错，禁止静默截断当成功");
    // reqwest 对 Content-Length 不足的流会报读取错误；即使个别栈把提前 EOF
    // 当正常流结束，字节数兜底检查也必须拦下（两种形态都算通过）。
    let message = error.to_string();
    assert!(
        message.contains("中断") || message.contains("读取响应体失败"),
        "unexpected error: {message}"
    );

    let on_disk = std::fs::read(&dest).unwrap();
    assert!(
        on_disk.len() >= 10_000 && on_disk.len() < data.len(),
        "断点应包含原有前缀且未被声称完成（len={}）",
        on_disk.len()
    );
    assert_eq!(
        &on_disk[..],
        &data[..on_disk.len()],
        "断点必须保持前缀完整（已写入的每个字节都正确）"
    );
}

#[tokio::test]
async fn fresh_download_with_zero_offset_sends_no_range_header() {
    let data = payload(6_000);
    let (addr, ranges) = spawn_fake_server(data.clone(), RangeMode::Honor).await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("fresh.part");

    let resumed_from = storage
        .get_file_resumable(FILE_KEY, &dest, 0, None)
        .await
        .expect("全新下载应成功");

    assert_eq!(resumed_from, 0);
    assert_eq!(
        ranges.lock().unwrap().as_slice(),
        &[None],
        "resume_from=0 不应携带 Range 头"
    );
    assert_eq!(std::fs::read(&dest).unwrap(), data);
}
