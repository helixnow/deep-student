//! R09-android：Android 换机（device switch）闭环集成测试。
//!
//! 覆盖 RESTORE-MATRIX-R07 场景 7（Android 仅 WebDAV）的完整换机链路与
//! 平台能力门禁：
//!
//! 1. **Android 拒 FTP**：`create_storage` 与配置 SSOT 的保存/加载路径都必须
//!    用与前端映射约定字节一致的常量显式拒绝（fail-closed，无僵尸配置）。
//! 2. **mobile-slim / android-release 无 S3**：feature 清单不含
//!    `cloud_storage_s3`，且拒绝文案面向终端用户（P3-2 修复锚定），不再
//!    指导用户"在编译时启用 feature"。
//! 3. **仅 WebDAV 的换机闭环**：设备 A 加密整包上传 → 设备 B 下载 →
//!    无密码导入必须失败 → 带密码解封 → 写入非活动 B 槽 → 重启应用
//!    pending 切换 → 两段式解除恢复维护租约。
//! 4. **重启切换语义 guard**：恢复租约目标未激活时新进程必须拒绝启动。
//! 5. **device_id 落到 app_data_dir 与恢复后 rotate**：子进程探针验证身份
//!    持久化在 `<app_data_dir>/.device_id` 且轮换后新身份跨"重启"稳定。
//!
//! 平台能力经 `PlatformStorageCapabilities` 显式注入（R09 测试钩子）：
//! 生产入口以 `cfg!` 取当前编译目标能力，宿主机测试按 Android 能力矩阵
//! 驱动同一套拒绝逻辑——被测代码就是真实生产分支，不是并行的假实现。
//! 唯一无法在宿主机覆盖的是 `#[cfg(target_os = "android")]` 编译期兜底
//! 分支本身（见文件尾的常量一致性锚定）。

#![cfg(feature = "data_governance")]

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use deep_student_lib::cloud_config_commands::{
    load_cloud_config_ssot_with_capabilities, save_cloud_config_ssot_with_capabilities,
    CloudConfigSsotError, SafeCloudStorageConfig, SafeFtpConfig, SafeS3Config,
    CLOUD_CONFIG_SSOT_SETTING_KEY, FTP_UNSUPPORTED_ON_ANDROID_CODE,
    FTP_UNSUPPORTED_ON_ANDROID_MESSAGE, S3_UNSUPPORTED_IN_BUILD_CODE,
    S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
};
use deep_student_lib::cloud_storage::{
    create_storage, create_storage_with_capabilities, CloudStorageConfig, CloudSyncManager,
    FtpConfig, PlatformStorageCapabilities, S3Config, StorageProvider, WebDavConfig,
};
use deep_student_lib::data_governance::backup::{
    export_backup_to_zip,
    zip_export::{import_backup_from_zip, import_backup_from_zip_with_password},
    BackupManager, BackupManifest, ZipExportOptions,
};
use deep_student_lib::data_space::{DataSpaceManager, Slot};
use rusqlite::Connection;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ENCRYPTION_PASSWORD: &str = "android-switch-passphrase";
const OLD_PHONE_MARKER: &str = "r09-old-phone-data";
const NEW_PHONE_MARKER: &str = "r09-new-phone-initial-data";

// ============================================================================
// 进程内假 WebDAV 服务器（内存对象存储 + 手写 HTTP/1.1）
// ============================================================================

/// 内存 WebDAV 状态：`files` 键形如 `sync-root/backups/x.zip`（无首斜杠）。
#[derive(Default)]
struct FakeDavState {
    files: BTreeMap<String, Vec<u8>>,
    collections: BTreeSet<String>,
}

#[derive(Clone)]
struct FakeDavServer {
    addr: SocketAddr,
    state: Arc<Mutex<FakeDavState>>,
}

/// 从 TCP 流增量读取 HTTP 请求的小型缓冲读取器。
struct HttpConn {
    socket: tokio::net::TcpStream,
    buf: Vec<u8>,
    pos: usize,
}

impl HttpConn {
    async fn fill(&mut self) -> std::io::Result<usize> {
        let mut chunk = [0u8; 8192];
        let n = self.socket.read(&mut chunk).await?;
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(n)
    }

    /// 读到 `\r\n` 为止（不含终止符）。
    async fn read_line(&mut self) -> std::io::Result<String> {
        loop {
            if let Some(offset) = self.buf[self.pos..]
                .windows(2)
                .position(|window| window == b"\r\n")
            {
                let line =
                    String::from_utf8_lossy(&self.buf[self.pos..self.pos + offset]).to_string();
                self.pos += offset + 2;
                return Ok(line);
            }
            if self.fill().await? == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection closed mid-line",
                ));
            }
        }
    }

    async fn read_exact_bytes(&mut self, n: usize) -> std::io::Result<Vec<u8>> {
        while self.buf.len() - self.pos < n {
            if self.fill().await? == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection closed mid-body",
                ));
            }
        }
        let bytes = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(bytes)
    }
}

fn rfc2822_epoch() -> &'static str {
    "Tue, 01 Jul 2025 12:00:00 GMT"
}

fn dav_file_response(path: &str, size: usize) -> String {
    format!(
        "<d:response><d:href>/{path}</d:href><d:propstat><d:prop>\
         <d:resourcetype/>\
         <d:getcontentlength>{size}</d:getcontentlength>\
         <d:getlastmodified>{}</d:getlastmodified>\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
        rfc2822_epoch()
    )
}

fn dav_collection_response(path: &str) -> String {
    format!(
        "<d:response><d:href>/{path}/</d:href><d:propstat><d:prop>\
         <d:resourcetype><d:collection/></d:resourcetype>\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    )
}

fn multistatus(inner: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">{inner}</d:multistatus>"#
    )
}

impl FakeDavServer {
    async fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake webdav server");
        let addr = listener.local_addr().expect("local addr");
        let state: Arc<Mutex<FakeDavState>> = Arc::default();
        let served_state = Arc::clone(&state);

        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let state = Arc::clone(&served_state);
                tokio::spawn(async move {
                    let mut conn = HttpConn {
                        socket,
                        buf: Vec::with_capacity(16 * 1024),
                        pos: 0,
                    };
                    // Connection: close 语义：每连接处理一个请求。
                    if let Err(error) = Self::serve_one(&mut conn, &state).await {
                        // 客户端提前断开是正常路径（reqwest 超时/重试）。
                        let _ = error;
                    }
                    let _ = conn.socket.shutdown().await;
                });
            }
        });

        Self { addr, state }
    }

    fn keys_snapshot(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("fake dav state lock")
            .files
            .keys()
            .cloned()
            .collect()
    }

    async fn serve_one(
        conn: &mut HttpConn,
        state: &Arc<Mutex<FakeDavState>>,
    ) -> std::io::Result<()> {
        let request_line = conn.read_line().await?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let raw_target = parts.next().unwrap_or_default().to_string();

        let mut headers: Vec<(String, String)> = Vec::new();
        loop {
            let line = conn.read_line().await?;
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
            }
        }
        let header = |name: &str| -> Option<String> {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };

        // 生产 WebDAV 客户端必须始终带 Basic 认证头。
        if header("authorization").is_none_or(|value| !value.starts_with("Basic ")) {
            return Self::respond(conn, 401, "Unauthorized", &[], b"").await;
        }

        // 读取请求体（Content-Length 或流式 chunked——put_file 走 chunked）。
        let body: Vec<u8> = if header("transfer-encoding")
            .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
        {
            let mut assembled = Vec::new();
            loop {
                let size_line = conn.read_line().await?;
                let size = usize::from_str_radix(size_line.trim(), 16).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk size")
                })?;
                if size == 0 {
                    // 终止块后的空行（可能带 trailer，这里只消费空行）
                    let _ = conn.read_line().await?;
                    break;
                }
                assembled.extend_from_slice(&conn.read_exact_bytes(size).await?);
                let _ = conn.read_exact_bytes(2).await?; // 块尾 CRLF
            }
            assembled
        } else {
            let length = header("content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            conn.read_exact_bytes(length).await?
        };

        // 目标路径归一化：去 query、去首尾斜杠（键均为 ASCII 安全字符，无需解码）。
        let path = raw_target
            .split('?')
            .next()
            .unwrap_or_default()
            .trim_matches('/')
            .to_string();
        let depth = header("depth").unwrap_or_else(|| "1".to_string());

        // 同步计算响应（锁绝不跨 await 持有，tokio::spawn 要求 future: Send），
        // 随后统一发送。
        let (status, reason, is_xml, response_body): (u16, &'static str, bool, Vec<u8>) = {
            let mut guard = state.lock().expect("state lock");
            match method.as_str() {
                "MKCOL" => {
                    if guard.collections.contains(&path) {
                        (405, "Method Not Allowed", false, Vec::new())
                    } else {
                        guard.collections.insert(path);
                        (201, "Created", false, Vec::new())
                    }
                }
                "PUT" => {
                    guard.files.insert(path, body);
                    (201, "Created", false, Vec::new())
                }
                "GET" => match guard.files.get(&path) {
                    Some(data) => (200, "OK", false, data.clone()),
                    None => (404, "Not Found", false, Vec::new()),
                },
                "DELETE" => {
                    let existed =
                        guard.files.remove(&path).is_some() || guard.collections.remove(&path);
                    if existed {
                        (204, "No Content", false, Vec::new())
                    } else {
                        (404, "Not Found", false, Vec::new())
                    }
                }
                "PROPFIND" => {
                    let child_prefix = format!("{path}/");
                    if let Some(data) = guard.files.get(&path) {
                        let xml = multistatus(&dav_file_response(&path, data.len()));
                        (207, "Multi-Status", true, xml.into_bytes())
                    } else if guard.collections.contains(&path)
                        || guard.files.keys().any(|key| key.starts_with(&child_prefix))
                    {
                        let mut inner = dav_collection_response(&path);
                        if depth != "0" {
                            let mut sub_collections: BTreeSet<String> = BTreeSet::new();
                            for (key, data) in guard.files.iter() {
                                let Some(relative) = key.strip_prefix(&child_prefix) else {
                                    continue;
                                };
                                match relative.split_once('/') {
                                    None => inner.push_str(&dav_file_response(key, data.len())),
                                    Some((first_segment, _)) => {
                                        sub_collections.insert(format!("{path}/{first_segment}"));
                                    }
                                }
                            }
                            for collection in guard.collections.iter() {
                                if let Some(relative) = collection.strip_prefix(&child_prefix) {
                                    if !relative.is_empty() && !relative.contains('/') {
                                        sub_collections.insert(collection.clone());
                                    }
                                }
                            }
                            for sub in sub_collections {
                                inner.push_str(&dav_collection_response(&sub));
                            }
                        }
                        (207, "Multi-Status", true, multistatus(&inner).into_bytes())
                    } else {
                        (404, "Not Found", false, Vec::new())
                    }
                }
                _ => (405, "Method Not Allowed", false, Vec::new()),
            }
        };
        let extra_headers: &[(&str, &str)] = if is_xml {
            &[("Content-Type", "application/xml; charset=utf-8")]
        } else {
            &[]
        };
        Self::respond(conn, status, reason, extra_headers, &response_body).await
    }

    async fn respond(
        conn: &mut HttpConn,
        status: u16,
        reason: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
    ) -> std::io::Result<()> {
        let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
        for (name, value) in extra_headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ));
        conn.socket.write_all(head.as_bytes()).await?;
        conn.socket.write_all(body).await?;
        conn.socket.flush().await
    }
}

// ============================================================================
// 公共 helper
// ============================================================================

fn webdav_runtime_config(addr: SocketAddr, root: &str) -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: format!("http://{addr}/"),
            username: "student".to_string(),
            password: "correct-horse".to_string(),
        }),
        s3: None,
        ftp: None,
        root: Some(root.to_string()),
        encryption_password: None,
        insecure_transport_authorized: false,
    }
}

fn valid_ftp_runtime_config() -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::Ftp,
        ftp: Some(FtpConfig {
            host: "ftp.example.test".into(),
            port: 21,
            username: "student".into(),
            password: "pass".into(),
            use_tls: true,
        }),
        ..Default::default()
    }
}

fn valid_s3_runtime_config() -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::S3,
        s3: Some(S3Config {
            endpoint: "https://s3.example.test".into(),
            bucket: "bucket".into(),
            access_key_id: "AKID".into(),
            secret_access_key: "SECRET".into(),
            region: None,
            path_style: false,
        }),
        ..Default::default()
    }
}

/// Android 发行版（android-release / mobile-slim）的能力矩阵。
fn android_capabilities() -> PlatformStorageCapabilities {
    PlatformStorageCapabilities::android_release()
}

/// 带 settings 表的测试设置数据库（配置 SSOT 的存储层）。
fn test_settings_database() -> (TempDir, deep_student_lib::database::Database) {
    let dir = TempDir::new().expect("tempdir");
    let database = deep_student_lib::database::Database::new(&dir.path().join("settings.db"))
        .expect("open test database");
    database
        .get_conn_safe()
        .expect("connection")
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                updated_at INTEGER NOT NULL DEFAULT 0
            );",
        )
        .expect("create settings table");
    (dir, database)
}

/// 在指定槽目录内创建四个核心数据库（含标记数据）。
/// `slot_dir.parent()` 为 `slots` 时 BackupManager 不依赖全局 DataSpaceManager。
fn seed_slot_databases(slot_dir: &Path, marker: &str) {
    std::fs::create_dir_all(slot_dir.join("databases")).expect("create slot layout");
    let databases = [
        slot_dir.join("databases").join("vfs.db"),
        slot_dir.join("chat_v2.db"),
        slot_dir.join("mistakes.db"),
        slot_dir.join("llm_usage.db"),
    ];
    for path in &databases {
        let conn = Connection::open(path).expect("open sqlite db");
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS roundtrip_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
             DELETE FROM roundtrip_marker;
             INSERT INTO roundtrip_marker(value) VALUES ('{marker}');"
        ))
        .expect("seed marker data");
    }
}

fn read_marker(db_path: &Path) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT value FROM roundtrip_marker LIMIT 1", [], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

// ============================================================================
// 1. Android 拒 FTP：create_storage + 配置 SSOT 保存/加载
// ============================================================================

/// Android 能力下，运行时校验与 `create_storage` 都必须以同一稳定 code
/// 拒绝 FTP（RESTORE-MATRIX 场景 7 的显式拒绝要求）。
#[tokio::test]
async fn android_create_storage_rejects_ftp_with_mappable_message() {
    let config = valid_ftp_runtime_config();

    let validation_error = config
        .validate_with_capabilities(android_capabilities())
        .expect_err("Android 能力下 FTP 校验必须失败");
    assert_eq!(
        validation_error.code(),
        Some(FTP_UNSUPPORTED_ON_ANDROID_CODE)
    );
    assert_eq!(
        validation_error.to_string(),
        FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
        "展示文案仍可读；程序分派只依赖稳定 code"
    );

    let error = create_storage_with_capabilities(&config, android_capabilities())
        .await
        .err()
        .expect("Android 能力下 create_storage 必须拒绝 FTP");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("code"))
            .and_then(|code| code.as_str()),
        Some(FTP_UNSUPPORTED_ON_ANDROID_CODE),
        "create_storage AppError 必须携带机器码"
    );
    let error = error.to_string();
    assert!(
        error.contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE),
        "create_storage 的拒绝仍应携带可读诊断，实际: {error}"
    );

    // 对照组：桌面能力（当前宿主构建）下同一份配置可以通过校验。
    assert!(
        config
            .validate_with_capabilities(PlatformStorageCapabilities {
                ftp_supported: true,
                s3_supported: true,
            })
            .is_ok(),
        "桌面能力下 FTPS 配置应通过校验（证明拒绝确实来自平台能力开关）"
    );
}

/// Android 能力下配置 SSOT 必须在保存与加载两条路径都拒绝 FTP：
/// 保存被拒后不得留下任何记录；桌面端写入的 FTP 记录在 Android 加载时
/// fail-closed（不产生"保存成功但永远连不上"的僵尸配置）。
#[test]
fn android_ssot_rejects_ftp_on_save_and_load() {
    let (_guard, database) = test_settings_database();
    let ftp_config = SafeCloudStorageConfig::Ftp {
        ftp: SafeFtpConfig {
            host: "ftp.example.test".to_string(),
            port: 21,
            username: "student".to_string(),
            use_tls: true,
        },
        root: None,
        allow_insecure: false,
    };

    let denied =
        save_cloud_config_ssot_with_capabilities(&database, ftp_config, android_capabilities())
            .expect_err("Android 能力下 FTP 不得持久化");
    assert!(matches!(&denied, CloudConfigSsotError::Invalid(_)));
    assert_eq!(denied.stable_code(), FTP_UNSUPPORTED_ON_ANDROID_CODE);
    assert!(
        matches!(
            load_cloud_config_ssot_with_capabilities(&database, android_capabilities()),
            Err(CloudConfigSsotError::NotConfigured)
        ),
        "被拒的保存必须让 SSOT 保持空态"
    );

    // 桌面端写入的 FTP 记录（合法 JSON 直写存储层）在 Android 加载时必须拒绝。
    database
        .save_setting(
            CLOUD_CONFIG_SSOT_SETTING_KEY,
            r#"{"provider":"ftp","ftp":{"host":"ftp.example.test","port":21,"username":"student","useTls":true}}"#,
        )
        .expect("seed desktop-written ftp record");
    let load_error = load_cloud_config_ssot_with_capabilities(&database, android_capabilities())
        .expect_err("桌面写入的 FTP 记录在 Android 上必须 fail-closed");
    assert!(matches!(&load_error, CloudConfigSsotError::Invalid(_)));
    assert_eq!(load_error.stable_code(), FTP_UNSUPPORTED_ON_ANDROID_CODE);
}

// ============================================================================
// 2. mobile-slim / android-release 无 S3 + 用户级错误文案（P3-2）
// ============================================================================

/// 无 S3 后端的构建（Android 发行版）必须以面向终端用户的文案拒绝 S3：
/// 校验、create_storage、SSOT 保存/加载四条路径同一常量；文案不得再
/// 指导用户"启用编译 feature"。
#[tokio::test]
async fn build_without_s3_rejects_s3_with_user_facing_message() {
    // P3-2 修复锚定：文案面向用户（给出可操作替代），不面向编译者。
    assert!(
        S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE.contains("WebDAV"),
        "拒绝文案必须给出用户可操作的替代方案（WebDAV）"
    );
    for compiler_facing in ["feature", "编译"] {
        assert!(
            !S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE.contains(compiler_facing),
            "拒绝文案不得面向编译者（不应包含 {compiler_facing:?}）: \
             {S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE}"
        );
    }

    let config = valid_s3_runtime_config();
    let validation_error = config
        .validate_with_capabilities(android_capabilities())
        .expect_err("无 S3 构建必须拒绝 S3 配置");
    assert_eq!(validation_error.code(), Some(S3_UNSUPPORTED_IN_BUILD_CODE));
    assert_eq!(
        validation_error.to_string(),
        S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
    );
    let error = create_storage_with_capabilities(&config, android_capabilities())
        .await
        .err()
        .expect("无 S3 构建 create_storage 必须拒绝 S3");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("code"))
            .and_then(|code| code.as_str()),
        Some(S3_UNSUPPORTED_IN_BUILD_CODE),
        "create_storage AppError 必须携带机器码"
    );
    let error = error.to_string();
    assert!(
        error.contains(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE),
        "create_storage 的拒绝必须携带用户级常量，实际: {error}"
    );

    // SSOT：保存与加载都必须 fail-closed（对齐 FTP-on-Android 的僵尸配置防护）。
    let (_guard, database) = test_settings_database();
    let s3_safe_config = SafeCloudStorageConfig::S3 {
        s3: SafeS3Config {
            endpoint: "https://s3.example.test".to_string(),
            bucket: "bucket".to_string(),
            access_key_id: "AKID".to_string(),
            region: None,
            path_style: false,
        },
        root: None,
        allow_insecure: false,
    };
    let denied = save_cloud_config_ssot_with_capabilities(
        &database,
        s3_safe_config.clone(),
        android_capabilities(),
    )
    .expect_err("无 S3 构建的 SSOT 不得持久化 S3 配置");
    assert!(matches!(&denied, CloudConfigSsotError::Invalid(_)));
    assert_eq!(denied.stable_code(), S3_UNSUPPORTED_IN_BUILD_CODE);

    // 桌面端（有 S3 的构建）写入的记录在无 S3 构建上加载必须拒绝。
    let stored = save_cloud_config_ssot_with_capabilities(
        &database,
        s3_safe_config,
        PlatformStorageCapabilities {
            ftp_supported: true,
            s3_supported: true,
        },
    )
    .expect("桌面能力下保存 S3 配置应成功");
    assert_eq!(stored.provider_name(), "s3");
    let load_error = load_cloud_config_ssot_with_capabilities(&database, android_capabilities())
        .expect_err("桌面写入的 S3 记录在无 S3 构建上必须 fail-closed");
    assert!(matches!(&load_error, CloudConfigSsotError::Invalid(_)));
    assert_eq!(load_error.stable_code(), S3_UNSUPPORTED_IN_BUILD_CODE);
}

/// feature 清单锚定：`mobile-slim` 与 `android-release` 都不得包含
/// `cloud_storage_s3`（否则上面的能力矩阵与文档全部失真），而 default
/// 必须包含（证明该差异真实存在，而非 feature 已被全局移除）。
#[test]
fn mobile_feature_profiles_exclude_s3_backend() {
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("read Cargo.toml");

    let feature_array = |name: &str| -> String {
        let start = manifest
            .find(&format!("\n{name} = ["))
            .unwrap_or_else(|| panic!("Cargo.toml 缺少 feature 定义: {name}"));
        let rest = &manifest[start..];
        let end = rest.find(']').expect("feature 数组必须闭合");
        rest[..end].to_string()
    };

    for profile in ["mobile-slim", "android-release"] {
        let features = feature_array(profile);
        assert!(
            !features.contains("cloud_storage_s3"),
            "{profile} 不得编入 S3 后端，实际: {features}"
        );
        assert!(
            !features.contains("\"ftp\""),
            "{profile} 不得出现独立 FTP feature（FTP 由 target_os 编译期排除）"
        );
    }
    assert!(
        feature_array("default").contains("cloud_storage_s3"),
        "default（桌面）应包含 cloud_storage_s3，否则平台差异断言失去意义"
    );
}

/// 编译期兜底分支与运行时能力开关的文案一致性锚定：
/// `create_storage` 在 `#[cfg]` 兜底分支使用的常量必须与
/// `PlatformStorageCapabilities::current()` 驱动的运行时拒绝一致。
/// （真实 Android 目标上 `current().ftp_supported == false` 由
/// `cfg!(not(target_os = "android"))` 单行表达式保证，无法在宿主机执行，
/// 这是本文件唯一未被真机覆盖的缺口。）
#[test]
fn platform_capability_constants_stay_mappable() {
    assert_eq!(
        FTP_UNSUPPORTED_ON_ANDROID_MESSAGE, "FTP/FTPS storage is not available on Android.",
        "展示文案保留为可读诊断；前端不再匹配该字符串"
    );
    assert_eq!(
        FTP_UNSUPPORTED_ON_ANDROID_CODE,
        "E_FTP_UNSUPPORTED_ON_ANDROID"
    );
    assert_eq!(S3_UNSUPPORTED_IN_BUILD_CODE, "E_S3_UNSUPPORTED_IN_BUILD");
    let current = PlatformStorageCapabilities::current();
    assert_eq!(current.ftp_supported, cfg!(not(target_os = "android")));
    assert_eq!(current.s3_supported, cfg!(feature = "cloud_storage_s3"));
    let android = PlatformStorageCapabilities::android_release();
    assert!(!android.ftp_supported && !android.s3_supported);
}

// ============================================================================
// 3. 仅 WebDAV 的换机闭环（设备 A → 云 → 设备 B → 非活动槽 → 重启切换）
// ============================================================================

/// 老手机（设备 A）：产出完整备份并加密导出 ZIP，返回
/// （目录守卫，备份根目录，清单，加密 ZIP 路径）。
fn build_encrypted_backup_on_device_a() -> (TempDir, PathBuf, BackupManifest, PathBuf) {
    let device_a_root = TempDir::new().expect("device A root");
    let slot = device_a_root.path().join("slots").join("slotA");
    seed_slot_databases(&slot, OLD_PHONE_MARKER);

    let backup_dir = device_a_root.path().join("recovery").join("backups");
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(slot);
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    let manifest = manager
        .backup_with_assets(None)
        .expect("设备 A backup_with_assets 应成功");
    manifest
        .validate_for_slot_restore()
        .expect("换机前提：设备 A 的本地备份必须可整槽恢复");

    let zip_path = device_a_root.path().join("device-switch.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            include_checksums: true,
            ..Default::default()
        },
    )
    .expect("设备 A 加密全保真导出应成功");
    (device_a_root, backup_dir, manifest, zip_path)
}

/// 核心闭环：加密整包经 WebDAV 上云 → Android 新机下载 → 密码门禁 →
/// 解封导入 → 恢复写入非活动 B 槽（活动槽不动）→ 重启应用切换 →
/// 两段式解除恢复维护租约 → 再次重启平稳。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn webdav_only_device_switch_closed_loop() {
    let server = FakeDavServer::spawn().await;
    let cloud_root = "deep-student-sync";

    // ---------- 设备 A：备份 + 加密导出 + 上传 ----------
    let (_device_a_guard, _backup_dir, manifest, zip_path) = build_encrypted_backup_on_device_a();
    let zip_bytes = std::fs::read(&zip_path).expect("read encrypted zip");

    let storage_a = create_storage(&webdav_runtime_config(server.addr, cloud_root))
        .await
        .expect("loopback HTTP WebDAV 应可创建存储（Android 唯一可用后端）");
    storage_a
        .check_connection()
        .await
        .expect("WebDAV 连接探测应成功");
    let sync_a = CloudSyncManager::new(storage_a, "android-old-phone".to_string());
    sync_a
        .enforce_encryption_policy_before_upload_with_password(Some(ENCRYPTION_PASSWORD))
        .await
        .expect("设备 A 首传应登记带校验子的加密标记");
    let uploaded = sync_a
        .upload(
            &zip_path,
            Some(env!("CARGO_PKG_VERSION").to_string()),
            Some("android device switch".to_string()),
        )
        .await
        .expect("设备 A 加密整包上传应成功");
    assert!(
        server
            .keys_snapshot()
            .iter()
            .any(|key| key.contains(".encryption-marker")),
        "云端 root 必须留下加密标记，云端对象: {:?}",
        server.keys_snapshot()
    );

    // 加密标记生效后：未配密码的设备必须被拒明文上传；错密码设备必须
    // 在写入任何 backups/ 对象之前失败。
    let storage_plain = create_storage(&webdav_runtime_config(server.addr, cloud_root))
        .await
        .expect("create plaintext-device storage");
    let sync_plain = CloudSyncManager::new(storage_plain, "android-plaintext".to_string());
    let plain_error = sync_plain
        .enforce_encryption_policy_before_upload_with_password(None)
        .await
        .expect_err("已声明加密的 root 必须拒绝明文上传")
        .to_string();
    assert!(
        plain_error.contains("加密"),
        "明文拒绝应提示加密要求，实际: {plain_error}"
    );
    let objects_before = server.keys_snapshot();
    let wrong_error = sync_plain
        .enforce_encryption_policy_before_upload_with_password(Some("wrong-password"))
        .await
        .expect_err("错密码设备必须在上传前被拦截")
        .to_string();
    assert!(
        wrong_error.contains("不一致"),
        "错密码拒绝应指出密码不一致，实际: {wrong_error}"
    );
    assert_eq!(
        server.keys_snapshot(),
        objects_before,
        "被拒绝的上传不得改动云端任何对象"
    );

    // ---------- 设备 B（Android 新手机）：初始化 A/B 槽 + 下载 ----------
    let device_b_guard = TempDir::new().expect("device B root");
    let app_data_dir = device_b_guard.path().join("appdata");
    std::fs::create_dir_all(&app_data_dir).expect("create app data dir");
    let dsm = DataSpaceManager::new(app_data_dir.clone());
    dsm.ensure_layout().expect("初始化 A/B 槽布局");
    dsm.initialize_on_start().expect("首次启动应成功");
    assert_eq!(dsm.active_slot(), Slot::A, "新设备初始活动槽应为 slotA");
    seed_slot_databases(&dsm.slot_dir(Slot::A), NEW_PHONE_MARKER);

    let storage_b = create_storage(&webdav_runtime_config(server.addr, cloud_root))
        .await
        .expect("create device B storage");
    let sync_b = CloudSyncManager::new(storage_b, "android-new-phone".to_string());
    let versions = sync_b.list_versions().await.expect("列出云端版本");
    assert_eq!(versions.len(), 1, "云端应恰有一个版本");
    assert_eq!(versions[0].id, uploaded.version.id);
    assert_eq!(versions[0].device_id, "android-old-phone");

    let downloads_dir = device_b_guard.path().join("downloads");
    let downloaded = sync_b
        .download(None, &downloads_dir)
        .await
        .expect("设备 B 下载最新版本应成功（含 SHA256 校验）");
    let downloaded_path = PathBuf::from(&downloaded.local_path);
    assert_eq!(
        std::fs::read(&downloaded_path).expect("read downloaded zip"),
        zip_bytes,
        "下载的加密 ZIP 必须与设备 A 上传的逐字节一致"
    );

    // ---------- 密码门禁：加密 ZIP 恢复必须带密码 ----------
    let backups_dir = device_b_guard.path().join("imported-backups");
    std::fs::create_dir_all(&backups_dir).expect("create imported backups dir");
    let imported_dir = backups_dir.join(&manifest.backup_id);

    let missing_password_error = import_backup_from_zip(&downloaded_path, &imported_dir)
        .expect_err("无密码导入加密换机包必须失败")
        .to_string();
    assert!(
        missing_password_error.contains("备份密码"),
        "无密码拒绝必须提示提供备份密码，实际: {missing_password_error}"
    );
    let wrong_password_error =
        import_backup_from_zip_with_password(&downloaded_path, &imported_dir, Some("wrong-pass"))
            .expect_err("错密码导入必须失败")
            .to_string();
    assert!(
        wrong_password_error.contains("备份密码错误") || wrong_password_error.contains("解封"),
        "错密码拒绝必须可操作，实际: {wrong_password_error}"
    );
    // 残留半成品（若有）不得通过整槽恢复门禁。
    if let Ok(leftover) = BackupManifest::load_from_file(&imported_dir.join("manifest.json")) {
        leftover
            .validate_for_slot_restore()
            .expect_err("错密码残留的外层密封清单不得通过整槽恢复验证");
    }

    import_backup_from_zip_with_password(
        &downloaded_path,
        &imported_dir,
        Some(ENCRYPTION_PASSWORD),
    )
    .expect("正确密码导入加密换机包应成功");
    let imported_manifest = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("解封后的原始清单可解析");
    imported_manifest
        .validate_for_slot_restore()
        .expect("解封后的清单必须可整槽恢复");

    // ---------- 恢复写入非活动 B 槽；活动槽在切换前必须原封不动 ----------
    let inactive = dsm.inactive_slot();
    assert_eq!(inactive, Slot::B);
    dsm.clear_slot_for_restore(Slot::B)
        .expect("恢复前清空非活动槽");
    assert!(
        dsm.clear_slot_for_restore(Slot::A).is_err(),
        "活跃插槽绝不允许被恢复流程清空"
    );

    let mut restore_manager = BackupManager::new(backups_dir.clone());
    restore_manager.set_app_data_dir(dsm.slot_dir(Slot::B));
    restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    restore_manager
        .restore_with_assets(&imported_manifest, false)
        .expect("换机恢复写入非活动 B 槽必须成功");
    assert_eq!(
        read_marker(&dsm.slot_dir(Slot::B).join("chat_v2.db")).as_deref(),
        Some(OLD_PHONE_MARKER),
        "B 槽应持有老手机数据"
    );
    assert_eq!(
        read_marker(&dsm.slot_dir(Slot::A).join("chat_v2.db")).as_deref(),
        Some(NEW_PHONE_MARKER),
        "切换前活动 A 槽必须原封不动"
    );

    // ---------- 登记切槽租约 → 重启应用 pending → 两段式解除 ----------
    dsm.mark_restore_cutover_pending(Slot::B, &imported_manifest.backup_id)
        .expect("登记恢复切槽租约");
    dsm.complete_restore_cutover(&dsm.slot_dir(Slot::B))
        .expect_err("激活尚未发生时禁止解除维护租约");

    // 模拟 app.restart()：新实例走 initialize_on_start。
    let restarted = DataSpaceManager::new(app_data_dir.clone());
    restarted
        .initialize_on_start()
        .expect("重启应用 pending 切换");
    assert_eq!(restarted.active_slot(), Slot::B, "重启后活动槽必须切换到 B");
    assert_eq!(
        read_marker(&restarted.active_dir().join("chat_v2.db")).as_deref(),
        Some(OLD_PHONE_MARKER),
        "重启后活动槽必须是恢复出的老手机数据"
    );

    let lease = restarted
        .restore_cutover_pending()
        .expect("读取租约")
        .expect("激活提交前租约必须仍然存在");
    assert!(!lease.activation_committed, "激活尚未提交");
    restarted
        .complete_restore_cutover(&restarted.active_dir())
        .expect_err("activation 未提交前解除租约必须被拒（两段式第一段）");
    restarted
        .mark_restore_activation_committed(&restarted.active_dir(), &imported_manifest.backup_id)
        .expect("提交恢复激活");
    assert!(
        restarted
            .complete_restore_cutover(&restarted.active_dir())
            .expect("已提交后解除租约应成功"),
        "解除租约应返回 true"
    );
    assert!(
        restarted
            .restore_cutover_pending()
            .expect("read lease")
            .is_none(),
        "租约解除后必须清空"
    );

    // ---------- 再次重启必须平稳（无 pending、无租约） ----------
    let second_restart = DataSpaceManager::new(app_data_dir);
    second_restart
        .initialize_on_start()
        .expect("换机完成后的重启必须平稳");
    assert_eq!(second_restart.active_slot(), Slot::B);
}

// ============================================================================
// 4. 重启切换语义 guard：租约目标未激活必须拒启
// ============================================================================

/// 恢复维护租约仍在、但 pending 切换因目标槽损毁未能应用时，
/// `initialize_on_start` 必须拒绝在不确定的数据槽上启动（fail-closed），
/// 且不得清掉租约。
#[test]
fn restart_guard_refuses_boot_when_lease_target_not_activated() {
    let guard = TempDir::new().expect("device root");
    let app_data_dir = guard.path().join("appdata");
    std::fs::create_dir_all(&app_data_dir).expect("create app data dir");
    let dsm = DataSpaceManager::new(app_data_dir.clone());
    dsm.ensure_layout().expect("初始化槽布局");
    dsm.initialize_on_start().expect("首次启动");
    seed_slot_databases(&dsm.slot_dir(Slot::A), NEW_PHONE_MARKER);
    seed_slot_databases(&dsm.slot_dir(Slot::B), OLD_PHONE_MARKER);

    dsm.mark_restore_cutover_pending(Slot::B, "backup-guard-test")
        .expect("登记切槽租约");

    // 模拟重启前 B 槽被损毁清空：pending 校验失败 → 活动槽保持 A。
    std::fs::remove_dir_all(dsm.slot_dir(Slot::B)).expect("wipe slot B");
    std::fs::create_dir_all(dsm.slot_dir(Slot::B)).expect("recreate empty slot B");

    let restarted = DataSpaceManager::new(app_data_dir);
    let boot_error = restarted
        .initialize_on_start()
        .expect_err("租约目标未激活时必须拒绝启动")
        .to_string();
    assert!(
        boot_error.contains("租约") || boot_error.contains("拒绝"),
        "拒启错误应说明恢复租约目标未激活，实际: {boot_error}"
    );
    let lease = restarted
        .restore_cutover_pending()
        .expect("read lease")
        .expect("拒启后租约必须原样保留（供修复/重试）");
    assert_eq!(lease.target_slot, "slotB");
    assert_eq!(lease.backup_id, "backup-guard-test");
}

// ============================================================================
// 5. device_id 落到 app_data_dir + 恢复后 rotate（子进程探针）
// ============================================================================

const PROBE_DATA_DIR_ENV: &str = "R09_DEVICE_ID_PROBE_DATA_DIR";
const PROBE_ROTATE_ENV: &str = "R09_DEVICE_ID_PROBE_ROTATE";

/// 子进程探针：绑定数据目录后输出 device_id；`R09_DEVICE_ID_PROBE_ROTATE=1`
/// 时额外执行恢复后的身份轮换并输出轮换前后身份。
/// 正常测试运行（无环境变量）时直接通过。
#[test]
fn r09_device_id_probe_subprocess() {
    let Ok(data_dir) = std::env::var(PROBE_DATA_DIR_ENV) else {
        return;
    };
    deep_student_lib::data_space::init_data_space_manager(data_dir.into())
        .expect("探针子进程应能初始化数据空间管理器");
    let initial = deep_student_lib::cloud_storage::get_device_id();
    println!("R09_PROBE_INITIAL={initial}");
    if std::env::var(PROBE_ROTATE_ENV).as_deref() == Ok("1") {
        let (old_id, new_id) = deep_student_lib::cloud_storage::rotate_device_id_after_restore()
            .expect("恢复后轮换设备 ID 应成功");
        println!("R09_PROBE_OLD={old_id}");
        println!("R09_PROBE_NEW={new_id}");
        println!(
            "R09_PROBE_AFTER={}",
            deep_student_lib::cloud_storage::get_device_id()
        );
    }
}

struct ProbeOutput {
    initial: String,
    old: Option<String>,
    new: Option<String>,
    after: Option<String>,
}

fn run_device_id_probe(data_dir: &Path, isolated_home: &Path, rotate: bool) -> ProbeOutput {
    let exe = std::env::current_exe().expect("当前测试二进制路径可获取");
    let mut command = std::process::Command::new(exe);
    command
        .args(["r09_device_id_probe_subprocess", "--exact", "--nocapture"])
        .env(PROBE_DATA_DIR_ENV, data_dir)
        .env_remove("DEVICE_ID")
        .env("HOME", isolated_home)
        .env("XDG_DATA_HOME", isolated_home.join("xdg-data"))
        .env("XDG_CONFIG_HOME", isolated_home.join("xdg-config"));
    if rotate {
        command.env(PROBE_ROTATE_ENV, "1");
    } else {
        command.env_remove(PROBE_ROTATE_ENV);
    }
    let output = command.output().expect("探针子进程应能启动");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        output.status.success(),
        "探针子进程应成功退出。stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let field = |prefix: &str| -> Option<String> {
        stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix))
            .map(str::to_string)
    };
    ProbeOutput {
        initial: field("R09_PROBE_INITIAL=")
            .unwrap_or_else(|| panic!("探针未输出初始 device_id。stdout:\n{stdout}")),
        old: field("R09_PROBE_OLD="),
        new: field("R09_PROBE_NEW="),
        after: field("R09_PROBE_AFTER="),
    }
}

/// 换机恢复完成后的身份契约：device_id 持久化在 `<app_data_dir>/.device_id`；
/// 恢复后轮换出与旧身份不同的新身份、立即生效并落盘；"重启"（新进程）
/// 读回的是轮换后的新身份——旧设备目录从此只被"追赶"，不再被写入。
#[test]
fn device_id_lives_in_app_data_dir_and_rotates_after_restore() {
    let home_guard = TempDir::new().expect("isolated home");
    let data_dir_guard = TempDir::new().expect("app data dir");
    let (home, data_dir) = (home_guard.path(), data_dir_guard.path());

    // 第一次启动：生成并落盘初始身份。
    let first_boot = run_device_id_probe(data_dir, home, false);
    let device_id_file = data_dir.join(".device_id");
    assert!(
        device_id_file.is_file(),
        "device_id 必须持久化在 app_data_dir 下的 .device_id"
    );
    assert_eq!(
        std::fs::read_to_string(&device_id_file)
            .expect("read .device_id")
            .trim(),
        first_boot.initial,
        "落盘身份必须与运行时身份一致"
    );

    // 恢复完成 → 轮换身份（同一进程内验证 old/new/生效值）。
    let rotation = run_device_id_probe(data_dir, home, true);
    assert_eq!(
        rotation.initial, first_boot.initial,
        "轮换前读到的必须还是初始身份（证明身份来自磁盘而非进程随机）"
    );
    let old_id = rotation.old.expect("探针应输出轮换前身份");
    let new_id = rotation.new.expect("探针应输出轮换后身份");
    assert_eq!(old_id, first_boot.initial, "轮换必须从当前持久化身份出发");
    assert_ne!(
        new_id, old_id,
        "恢复后必须轮换出新身份，否则回声过滤会吞掉旧设备在备份点之后的变更"
    );
    assert_eq!(
        rotation.after.as_deref(),
        Some(new_id.as_str()),
        "轮换后同进程内 get_device_id 必须立即返回新身份"
    );
    assert_eq!(
        std::fs::read_to_string(&device_id_file)
            .expect("read .device_id after rotation")
            .trim(),
        new_id,
        "新身份必须落盘覆盖主路径"
    );

    // "重启"（新进程）：读回轮换后的新身份，不得漂移回旧身份。
    let after_restart = run_device_id_probe(data_dir, home, false);
    assert_eq!(
        after_restart.initial, new_id,
        "重启后必须读回轮换后的身份（身份稳定性）"
    );
}
