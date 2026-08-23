//! WebDAV 列举截断（truncation）行为契约测试。
//!
//! 背景：WebDAV 没有通用分页协议，生产端 `WebDavStorage::list_outcome` 通过
//! PROPFIND 的 `DAV:response` 条目数命中「疑似服务端分页边界」的启发式来
//! fail-closed（标记 `ListOutcome::truncated = true`，由上层拒绝在不完整
//! 远端视图上推进同步）。
//!
//! 本文件用**进程内假 WebDAV 服务器**（原生 TCP + 手写 HTTP 207 响应）锁定：
//! - 750 个文件（坚果云单页上限形态，751 个 response）→ 必须判定 truncated；
//! - 101 个文件（102 个 response，不在任何已知截断边界）→ 不得判定 truncated；
//! - 100 个文件（101 个 response）→ 不得判定 truncated。早期启发式把所有
//!   整百 response 数当作截断信号，「恰好 100 个文件」被误报为截断（假阳性）；
//!   R02-webdav 已把启发式收紧到已知边界（坚果云 750/751、千级网关），
//!   该用例的 `#[ignore]` 已随修复取消。
//! - 千级网关边界在 R05 进一步收窄为 1000/1001 单档（与 750/751 对称）：
//!   2000 个文件（2001 个 response）等千的整数倍不再视为截断信号——
//!   单次响应能越过 1000 就说明服务端并未在千级截断。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use deep_student_lib::cloud_storage::{
    create_storage, CloudStorage, CloudStorageConfig, StorageProvider, WebDavConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ROOT: &str = "sync-root";

/// 构造一个 depth-1 PROPFIND 207 Multi-Status 响应体：
/// 第一个 response 是目录自身（collection），随后是 `file_count` 个普通文件。
fn propfind_multistatus_body(file_count: usize) -> String {
    let mut body = String::with_capacity(512 + file_count * 400);
    body.push_str(r#"<?xml version="1.0" encoding="utf-8"?>"#);
    body.push_str(r#"<d:multistatus xmlns:d="DAV:">"#);
    // 目录自身
    body.push_str(&format!(
        "<d:response><d:href>/{ROOT}/</d:href><d:propstat><d:prop>\
         <d:resourcetype><d:collection/></d:resourcetype>\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    ));
    for index in 0..file_count {
        body.push_str(&format!(
            "<d:response><d:href>/{ROOT}/file-{index:04}.bin</d:href><d:propstat><d:prop>\
             <d:resourcetype/>\
             <d:getcontentlength>16</d:getcontentlength>\
             <d:getlastmodified>Tue, 01 Jul 2025 12:00:00 GMT</d:getlastmodified>\
             </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        ));
    }
    body.push_str("</d:multistatus>");
    body
}

/// 进程内假 WebDAV 服务器：对任意 PROPFIND 返回固定的 207 列举响应。
///
/// 返回 (监听地址, 已服务的 PROPFIND 计数)。服务器随测试进程退出销毁。
async fn spawn_fake_webdav_server(file_count: usize) -> (SocketAddr, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake webdav server");
    let addr = listener.local_addr().expect("local addr");
    let served = Arc::new(AtomicUsize::new(0));
    let served_clone = Arc::clone(&served);
    let body = propfind_multistatus_body(file_count);

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let body = body.clone();
            let served = Arc::clone(&served_clone);
            tokio::spawn(async move {
                // 读完请求头 + Content-Length 声明的请求体
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

                let is_propfind = head.starts_with("PROPFIND ");
                let response = if is_propfind {
                    served.fetch_add(1, Ordering::SeqCst);
                    format!(
                        "HTTP/1.1 207 Multi-Status\r\n\
                         Content-Type: application/xml; charset=utf-8\r\n\
                         Content-Length: {}\r\n\
                         Connection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else {
                    // list_outcome 只应发 PROPFIND；其他方法一律 404
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                };
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });

    (addr, served)
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

async fn list_outcome_for_file_count(
    file_count: usize,
) -> deep_student_lib::cloud_storage::ListOutcome {
    let (addr, served) = spawn_fake_webdav_server(file_count).await;
    let storage: Box<dyn CloudStorage> = create_storage(&webdav_config(addr))
        .await
        .expect("loopback HTTP WebDAV 配置应能创建存储实例");
    let outcome = storage
        .list_outcome("")
        .await
        .expect("list_outcome 应成功返回");
    assert!(
        served.load(Ordering::SeqCst) >= 1,
        "list_outcome 应至少发出一次 PROPFIND"
    );
    outcome
}

/// 坚果云形态：单目录 750 个文件（751 个 DAV:response，命中 750/751 响应边界）
/// 必须 fail-closed 标记 truncated，防止在被服务端静默截断的列表上推进同步。
#[tokio::test]
async fn list_with_750_files_is_marked_truncated() {
    let outcome = list_outcome_for_file_count(750).await;
    assert_eq!(outcome.files.len(), 750, "应解析出全部 750 个文件条目");
    assert!(
        outcome.truncated,
        "750 个文件（751 个 response）命中坚果云分页边界，必须标记 truncated"
    );
}

/// 101 个文件（102 个 DAV:response）不在任何整百/750 边界上，
/// 不得误报 truncated，否则健康的小型目录会被拒绝同步。
#[tokio::test]
async fn list_with_101_files_is_not_truncated() {
    let outcome = list_outcome_for_file_count(101).await;
    assert_eq!(outcome.files.len(), 101, "应解析出全部 101 个文件条目");
    assert!(
        !outcome.truncated,
        "101 个文件不命中任何分页边界，不得误报 truncated"
    );
}

/// 恰好 100 个文件（101 个 DAV:response）是完整列表，不应判定 truncated。
///
/// 历史假阳性：旧启发式 `response_count >= 100 && (response_count - 1) % 100 == 0`
/// 把「100 个文件 + 目录自身 = 101 个 response」误判为分页截断，
/// 导致恰好 100 个文件的健康目录被永久拒绝同步。R02-webdav 已将启发式
/// 收紧到已知边界（750/751 与千级），本用例锁定修复不回归。
#[tokio::test]
async fn list_with_exactly_100_files_should_not_be_truncated() {
    let outcome = list_outcome_for_file_count(100).await;
    assert_eq!(outcome.files.len(), 100, "应解析出全部 100 个文件条目");
    assert!(
        !outcome.truncated,
        "恰好 100 个文件是完整列表，不应被启发式误判为 truncated"
    );
}

/// 小目录（远低于任何边界）绝不应被标记 truncated——启发式的健康基线。
#[tokio::test]
async fn list_with_small_directory_is_not_truncated() {
    let outcome = list_outcome_for_file_count(7).await;
    assert_eq!(outcome.files.len(), 7);
    assert!(!outcome.truncated, "7 个文件的目录不得标记 truncated");
}

/// 千级网关形态：单目录 1000 个文件（1001 个 DAV:response，命中千级
/// 响应边界 1000/1001 单档）必须 fail-closed 标记 truncated——与 750 边界
/// 同理，防止在被网关静默截断的千级列表上推进同步。
#[tokio::test]
async fn list_with_1000_files_is_marked_truncated() {
    let outcome = list_outcome_for_file_count(1000).await;
    assert_eq!(outcome.files.len(), 1000, "应解析出全部 1000 个文件条目");
    assert!(
        outcome.truncated,
        "1000 个文件（1001 个 response）命中千级网关边界，必须标记 truncated"
    );
}

/// 千级边界的下侧形态：999 个文件（恰好 1000 个 DAV:response）同样命中
/// 1000/1001 边界，无法与「网关恰好在 1000 个 response 处截断」区分，
/// 必须 fail-closed 标记 truncated。
#[tokio::test]
async fn list_with_999_files_is_marked_truncated() {
    let outcome = list_outcome_for_file_count(999).await;
    assert_eq!(outcome.files.len(), 999, "应解析出全部 999 个文件条目");
    assert!(
        outcome.truncated,
        "999 个文件（1000 个 response）命中千级网关边界，必须标记 truncated"
    );
}

/// 千级边界的上侧对照：1001 个文件（1002 个 DAV:response）已越过
/// 1000/1001 边界，说明服务端并未在千级截断，不得误报 truncated，
/// 否则略超一千个文件的健康目录会被永久拒绝同步。
#[tokio::test]
async fn list_with_1001_files_is_not_truncated() {
    let outcome = list_outcome_for_file_count(1001).await;
    assert_eq!(outcome.files.len(), 1001, "应解析出全部 1001 个文件条目");
    assert!(
        !outcome.truncated,
        "1001 个文件（1002 个 response）不在千级边界上，不得误报 truncated"
    );
}

/// 千级收窄验证：2000 个文件（2001 个 DAV:response）是千的整数倍附近，
/// 但已明显越过 1000/1001 单档边界——服务端能一次返回两千个 response
/// 就说明并未在千级截断。旧启发式把所有千的整数倍都当截断信号，会把
/// 恰好两千个文件的健康目录误报为 truncated；收窄后不得误报。
#[tokio::test]
async fn list_with_2000_files_is_not_truncated() {
    let outcome = list_outcome_for_file_count(2000).await;
    assert_eq!(outcome.files.len(), 2000, "应解析出全部 2000 个文件条目");
    assert!(
        !outcome.truncated,
        "2000 个文件（2001 个 response）已越过千级单档边界，不得误报 truncated"
    );
}
