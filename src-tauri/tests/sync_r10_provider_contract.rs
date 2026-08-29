//! [R10-providers][FINDINGS-R11 P2-2] WebDAV 非续传 `get_file` 字节数核对契约测试。
//!
//! 背景：S3 / FTP / 默认实现的 `get_file` 自 R10-download 起均在 EOF 后校验
//! `downloaded == total_size`，WebDAV 非续传路径是四条 provider 下载路径中
//! 唯一没有该核对的（FINDINGS-R11 §2 P2-2）。本文件用进程内假 WebDAV 服务器
//! （原生 TCP + 手写 HTTP 响应，与 `webdav_download_resume_tests.rs` 同型）
//! 钉死修复后的 fail-closed 语义：
//!
//! 1. **换小包**：PROPFIND 声明 N 字节，GET 返回**传输层完整**的 M<N 字节响应
//!    （Content-Length 与响应体一致）——这是「对象在 stat 与 GET 之间被并发
//!    替换」形态，传输层不会报错，只有字节数核对能拦下 → 必须 `Err` 且不落盘；
//! 2. **换大包**：同上但 M>N → 必须 `Err` 且不落盘；
//! 3. **截断流**：GET 声明 Content-Length=N 但只送一半后断开（传输中断形态）
//!    → 必须 `Err`（传输层报错或字节数核对拦截皆可），绝不把半包当成功；
//! 4. **一致对照**：声明与实收一致 → 成功，落盘内容与 SHA256 逐字节正确。
//!
//! 全部用例以 `expected_checksum = None` 调用——该形态没有校验和第二道防线
//! （真实调用方：`repo_check.rs` 巡检下载），字节数核对是唯一防线。

use std::net::SocketAddr;
use std::sync::Arc;

use deep_student_lib::cloud_storage::{
    create_storage, CloudStorage, CloudStorageConfig, StorageProvider, WebDavConfig,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ROOT: &str = "sync-root";
const FILE_KEY: &str = "backups/r10-provider-contract.zip";

fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// 单文件 depth-0 PROPFIND 207 响应体。
fn propfind_stat_body(href: &str, size: usize) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{size}</d:getcontentlength><d:getlastmodified>Tue, 01 Jul 2025 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
    )
}

/// 服务端形态：
/// - `stat_size`：PROPFIND 声明的对象大小（可与 GET 实际响应不一致，
///   模拟对象在 stat 与 GET 之间被替换）；
/// - `get_body`：GET 实际发送的字节；
/// - `declared_content_length`：GET 响应头声明的 Content-Length
///   （大于 `get_body.len()` 时发完即断开，模拟传输中断）。
struct ServerShape {
    stat_size: usize,
    get_body: Vec<u8>,
    declared_content_length: usize,
}

/// 进程内假 WebDAV 服务器：PROPFIND 按 `stat_size` 报大小，GET 按形态响应。
async fn spawn_fake_server(shape: ServerShape) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake webdav server");
    let addr = listener.local_addr().expect("local addr");
    let shape = Arc::new(shape);

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let shape = Arc::clone(&shape);
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
                    let body = propfind_stat_body(&request_path, shape.stat_size);
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
                    let response_head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        shape.declared_content_length
                    );
                    let _ = socket.write_all(response_head.as_bytes()).await;
                    let _ = socket.write_all(&shape.get_body).await;
                    // 不足声明长度即断开连接（模拟传输中断）。
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

    addr
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

/// 断言失败后本地不残留任何产物：目标路径不存在，且目录里没有 `.download-*`
/// 临时半成品（temp_path 必须随错误返回被清理）。
fn assert_nothing_persisted(dir: &TempDir, dest: &std::path::Path) {
    assert!(!dest.exists(), "失败下载不得在目标路径落盘");
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        leftovers.is_empty(),
        "失败下载不得残留临时文件：{leftovers:?}"
    );
}

/// 形态 1：对象在 stat 与 GET 之间被换成**小包**。GET 响应传输层完整
/// （Content-Length 与响应体一致），只有 `downloaded == total_size` 核对
/// 能拦下——这是 FINDINGS-R11 P2-2 指出的、传输层不会报错的错版本形态。
#[tokio::test]
async fn swapped_smaller_object_between_stat_and_get_fails_closed() {
    let addr = spawn_fake_server(ServerShape {
        stat_size: 20_000,
        get_body: payload(8_000),
        declared_content_length: 8_000,
    })
    .await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("swapped-smaller.bin");

    let error = storage
        .get_file(FILE_KEY, &dest, None, None)
        .await
        .expect_err("声明 20000 字节实收 8000 字节必须 fail-closed，绝不当成功");

    let message = error.to_string();
    assert!(
        message.contains("下载不完整或对象已变更")
            && message.contains("20000")
            && message.contains("8000"),
        "错误必须指明声明与实收字节数，unexpected: {message}"
    );
    assert_nothing_persisted(&dir, &dest);
}

/// 形态 2：对象被换成**大包**（实收多于声明）。同样必须拒绝——
/// 收到的是错版本对象，不是 stat 时看到的那一个。
#[tokio::test]
async fn swapped_larger_object_between_stat_and_get_fails_closed() {
    let addr = spawn_fake_server(ServerShape {
        stat_size: 4_000,
        get_body: payload(9_000),
        declared_content_length: 9_000,
    })
    .await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("swapped-larger.bin");

    let error = storage
        .get_file(FILE_KEY, &dest, None, None)
        .await
        .expect_err("实收超过声明大小必须 fail-closed，绝不当成功");

    assert!(
        error.to_string().contains("下载不完整或对象已变更"),
        "unexpected error: {error}"
    );
    assert_nothing_persisted(&dir, &dest);
}

/// 形态 3：截断流——GET 声明 Content-Length 与 stat 一致，但只送一半字节
/// 后断开。reqwest/hyper 通常在读流时报错；即使个别栈把提前 EOF 当正常
/// 流结束，EOF 后的字节数核对也必须拦下。两种拦截形态都算通过，
/// 唯一不许的是把半包 persist 成成功。
#[tokio::test]
async fn truncated_stream_is_an_error_not_a_success() {
    let data = payload(30_000);
    let addr = spawn_fake_server(ServerShape {
        stat_size: data.len(),
        get_body: data[..15_000].to_vec(),
        declared_content_length: data.len(),
    })
    .await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("truncated.bin");

    let error = storage
        .get_file(FILE_KEY, &dest, None, None)
        .await
        .expect_err("半包必须失败，绝不当成功");

    let message = error.to_string();
    assert!(
        message.contains("读取响应体失败") || message.contains("下载不完整"),
        "unexpected error: {message}"
    );
    assert_nothing_persisted(&dir, &dest);
}

/// 形态 4（对照）：声明与实收一致时下载成功，落盘内容与返回的 SHA256
/// 逐字节正确——字节数核对不得误伤正常下载。
#[tokio::test]
async fn consistent_download_succeeds_with_correct_bytes_and_checksum() {
    let data = payload(12_345);
    let addr = spawn_fake_server(ServerShape {
        stat_size: data.len(),
        get_body: data.clone(),
        declared_content_length: data.len(),
    })
    .await;
    let storage = storage_for(addr).await;

    let dir = TempDir::new().unwrap();
    let dest = dir.path().join("consistent.bin");

    let checksum = storage
        .get_file(FILE_KEY, &dest, None, None)
        .await
        .expect("声明与实收一致的下载应成功");

    assert_eq!(
        std::fs::read(&dest).unwrap(),
        data,
        "落盘内容必须逐字节正确"
    );
    let expected = format!("{:x}", Sha256::digest(&data));
    assert_eq!(checksum, expected, "返回的 SHA256 必须与内容一致");
}
