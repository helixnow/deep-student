//! R07-android：换机 / 恢复后重启语义契约测试。
//!
//! 锁定的产品事实：
//! - `mobile-slim` / `android-release` 构建不含 S3（`cloud_storage_s3` feature
//!   不在其 feature 列表中，S3 请求走既有"未启用"fail-closed 路径）；
//! - Android 上 FTP 后端**编译期移除**（`cloud_storage/mod.rs` 的
//!   `#[cfg(not(target_os = "android"))] mod ftp`），运行时校验、`create_storage`
//!   与 SSOT 存取三条路径都必须携带同一稳定错误码拒绝 FTP；
//! - 换机（旧手机 → 新手机）在移动端事实上只有 WebDAV 一条传输路径：
//!   上传备份 → 新设备发现版本 → 下载 → 字节一致；
//! - 恢复走 A/B 双槽：恢复内容写入**非活动槽**，仅登记切槽租约；数据槽切换
//!   只发生在**重启**（新进程 `initialize_on_start`）之后，租约在激活提交前
//!   拒绝解除（fail-closed）；
//! - `device_id` 必须持久化在 app 数据目录根（`<app_data_dir>/.device_id`），
//!   跨"重启"（新进程）稳定；恢复后必须 rotate 为新身份并同样落盘。
//!
//! ## 已知覆盖缺口（无法在本集成测试内闭合，如实记录）
//!
//! 1. **真机 `app.restart()` 不可测**：Tauri 的 `restart_app` 命令
//!    （`data_space::restart_app`）会调用 `AppHandle::restart()` 结束当前进程，
//!    集成测试无法在无真实 App/WebView 的环境执行。本文件用两种替代物覆盖
//!    重启语义：(a) 对同一 base_dir 构造新的 `DataSpaceManager` 并调用
//!    `initialize_on_start()`（等价于新进程的启动切槽路径）；(b) 设备身份用
//!    **子进程探针**（每个子进程 = 一次 App 启动）验证跨进程持久与轮换。
//! 2. **`finalize_restore_activation` 是 `pub(crate)` 且仅由启动序列调用**：
//!    "重启后提交激活（同步游标重置 + device_id 轮换 + 租约解除）"的完整
//!    编排无法从 tests/ 直接驱动。本文件退而测试其可公开访问的组成件：
//!    槽位/租约 API（`mark_restore_cutover_pending` /
//!    `mark_restore_activation_committed` / `complete_restore_cutover`）与
//!    `cloud_storage` 的身份轮换函数族。
//! 3. **Android 目标门控测试仅在 Android 交叉测试运行时执行**：
//!    `#[cfg(target_os = "android")]` 的用例在桌面 CI 中不编译不运行；
//!    宿主侧以"桌面接受完整 FTP 配置"锁定平台门是两端唯一分歧点，
//!    并以稳定 code 契约锁定前端本地化分派。
//! 4. **假 WebDAV 服务器代替真实服务**（坚果云/Nextcloud）：进程内 TCP 服务
//!    实现 MKCOL/PUT(含 chunked)/GET/DELETE/PROPFIND 子集，覆盖客户端协议
//!    行为，但不覆盖真实服务的配额/限速/分页形态（后者由
//!    `sync_provider_contract_tests` 的 docker 契约测试负责）。
//!
//! 仅新增测试，不修改生产代码。

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use deep_student_lib::cloud_config_commands::{
    FTP_UNSUPPORTED_ON_ANDROID_CODE, FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
    S3_UNSUPPORTED_IN_BUILD_CODE, S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
};
use deep_student_lib::cloud_storage::{
    create_storage, CloudStorageConfig, CloudSyncManager, StorageProvider, WebDavConfig,
};
use deep_student_lib::data_space::{DataSpaceManager, Slot};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

// ============================================================================
// 第一部分：Android 拒 FTP / mobile-slim 无 S3（cfg / feature 门）
// ============================================================================

/// 前端只按稳定 code 本地化；message 是可变诊断文本。
#[test]
fn platform_rejection_codes_are_stable_contract() {
    assert_eq!(
        FTP_UNSUPPORTED_ON_ANDROID_CODE,
        "E_FTP_UNSUPPORTED_ON_ANDROID"
    );
    assert_eq!(S3_UNSUPPORTED_IN_BUILD_CODE, "E_S3_UNSUPPORTED_IN_BUILD");
    assert_eq!(
        FTP_UNSUPPORTED_ON_ANDROID_MESSAGE, "FTP/FTPS storage is not available on Android.",
        "message 仍应面向用户，但不再参与前端分派"
    );
}

/// 完整合规的 FTP 配置（TLS、非空凭据、纯主机名）。
fn complete_ftp_config() -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::Ftp,
        ftp: Some(deep_student_lib::cloud_storage::FtpConfig {
            host: "ftp.example.com".into(),
            port: 21,
            username: "student".into(),
            password: "secret".into(),
            use_tls: true,
        }),
        ..Default::default()
    }
}

/// 桌面端必须**接受**同一份完整 FTP 配置：这样 Android 分支的拒绝只能来自
/// 平台门控（`target_os = "android"`），而不是配置本身的歧义。若本用例失败，
/// Android 的拒绝测试就失去了"唯一分歧点"的对照意义。
#[cfg(not(target_os = "android"))]
#[test]
fn desktop_accepts_complete_ftp_config_so_android_gate_is_the_only_difference() {
    let config = complete_ftp_config();
    assert!(
        config.validate().is_ok(),
        "完整 FTP 配置在桌面端必须通过校验，Android 拒绝才可归因于平台门控"
    );
}

/// 从 Cargo.toml 抽取指定 feature 的依赖数组文本（跨行安全）。
fn feature_array(cargo_toml: &str, feature: &str) -> String {
    let needle = format!("\n{feature} = [");
    let start = cargo_toml
        .find(&needle)
        .unwrap_or_else(|| panic!("Cargo.toml 中找不到 feature 定义: {feature}"));
    let rest = &cargo_toml[start + needle.len()..];
    let end = rest
        .find(']')
        .unwrap_or_else(|| panic!("feature {feature} 的数组未闭合"));
    rest[..end].to_string()
}

/// 产品事实"mobile-slim 无 S3"的构建配置 SSOT 锁定：移动端两个 profile 的
/// feature 列表都不得引入 `cloud_storage_s3`（aws-sdk 依赖树），同时必须保留
/// 恢复链路所需的核心能力（sqlite + data_governance）。
#[test]
fn mobile_profiles_exclude_s3_and_keep_recovery_core() {
    let cargo_toml_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let cargo_toml = std::fs::read_to_string(&cargo_toml_path).expect("读取 src-tauri/Cargo.toml");

    for profile in ["mobile-slim", "android-release"] {
        let deps = feature_array(&cargo_toml, profile);
        assert!(
            !deps.contains("cloud_storage_s3"),
            "{profile} 不得引入 cloud_storage_s3（移动端无 S3，云 API 走既有\"未启用\"路径），\
             实际列表: {deps}"
        );
        assert!(
            deps.contains("sqlite") && deps.contains("data_governance"),
            "{profile} 必须保留 sqlite + data_governance（恢复/迁移核心），实际列表: {deps}"
        );
    }
}

/// S3 feature 关闭的构建（mobile-slim / android-release 形态）中，S3 请求必须
/// fail-closed 且能力探测命令如实报告未启用。默认桌面构建启用了该 feature，
/// 本用例仅在 `--no-default-features --features mobile-slim` 之类的构建下执行。
#[cfg(not(feature = "cloud_storage_s3"))]
#[tokio::test]
async fn s3_disabled_build_fails_closed_like_mobile_slim() {
    assert!(
        !deep_student_lib::cloud_storage::cloud_storage_is_s3_enabled(),
        "S3 未编译时能力探测必须返回 false"
    );
    let config = CloudStorageConfig {
        provider: StorageProvider::S3,
        s3: Some(deep_student_lib::cloud_storage::S3Config {
            endpoint: "https://s3.example.com".into(),
            bucket: "bucket".into(),
            access_key_id: "AK".into(),
            secret_access_key: "SK".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let error = create_storage(&config)
        .await
        .expect_err("S3 未编译的构建必须拒绝创建 S3 存储");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("code"))
            .and_then(|code| code.as_str()),
        Some(S3_UNSUPPORTED_IN_BUILD_CODE)
    );
    assert!(
        error
            .to_string()
            .contains(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE),
        "诊断必须面向用户并给出 WebDAV 替代，不暴露编译 feature: {error}"
    );
}

/// 换机唯一可用传输路径（WebDAV）必须可以离线构造：`create_storage` 对合法
/// WebDAV 配置不做网络 I/O，Android 与桌面同样成立。
#[tokio::test]
async fn webdav_transfer_path_constructible_without_network() {
    let config = CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: "https://dav.example.com/dav/".into(),
            username: "student".into(),
            password: "secret".into(),
        }),
        ..Default::default()
    };
    let storage = create_storage(&config)
        .await
        .expect("合法 WebDAV 配置必须能构造存储实例（换机唯一路径不得被误拦）");
    assert_eq!(storage.provider_name(), "WebDAV");
}

// ============================================================================
// Android 目标门控用例（仅在 Android 交叉测试运行时编译执行，见模块文档缺口 3）
// ============================================================================

#[cfg(target_os = "android")]
mod android_only {
    use super::*;
    use deep_student_lib::cloud_config_commands::{
        load_cloud_config_ssot, save_cloud_config_ssot, CloudConfigSsotError,
        SafeCloudStorageConfig, SafeFtpConfig, SafeWebDavConfig, CLOUD_CONFIG_SSOT_SETTING_KEY,
    };
    use deep_student_lib::database::Database;

    fn settings_database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let database = Database::new(&dir.path().join("settings.db")).expect("open test database");
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

    /// Android 运行时校验必须以与 `create_storage` 相同的稳定 code 拒绝
    /// **配置完整**的 FTP（拒绝原因是平台，不是配置缺项）。
    #[test]
    fn android_validate_rejects_complete_ftp_config() {
        let error = complete_ftp_config()
            .validate()
            .expect_err("Android 必须拒绝 FTP");
        assert_eq!(error.code(), Some(FTP_UNSUPPORTED_ON_ANDROID_CODE));
        assert_eq!(error.to_string(), FTP_UNSUPPORTED_ON_ANDROID_MESSAGE);
    }

    /// `create_storage` 是所有云命令的公共入口：Android 上 FTP 必须在任何
    /// 网络 I/O 之前 fail-closed。
    #[tokio::test]
    async fn android_create_storage_rejects_ftp_before_any_network_io() {
        let error = create_storage(&complete_ftp_config())
            .await
            .expect_err("Android 无 FTP 后端，创建必须失败");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("code"))
                .and_then(|code| code.as_str()),
            Some(FTP_UNSUPPORTED_ON_ANDROID_CODE),
            "错误必须携带前端稳定 code，实际: {error}"
        );
    }

    /// SSOT 拒存：Android 上保存 FTP 记录必须失败且什么都不落库；
    /// 桌面写入后同步过来的 FTP 记录在加载时也必须 fail-closed。
    #[test]
    fn android_ssot_refuses_to_persist_or_load_ftp_records() {
        let (_dir, database) = settings_database();

        let denied = save_cloud_config_ssot(
            &database,
            SafeCloudStorageConfig::Ftp {
                ftp: SafeFtpConfig {
                    host: "ftp.example.test".into(),
                    port: 21,
                    username: "student".into(),
                    use_tls: true,
                },
                root: None,
                allow_insecure: false,
            },
        )
        .expect_err("Android 上 FTP 记录不得持久化");
        assert_eq!(denied.stable_code(), FTP_UNSUPPORTED_ON_ANDROID_CODE);
        assert!(denied
            .to_string()
            .contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE));
        assert!(
            matches!(
                load_cloud_config_ssot(&database),
                Err(CloudConfigSsotError::NotConfigured)
            ),
            "被拒绝的保存必须让 SSOT 保持空"
        );

        // 桌面写入的 FTP 记录（如经备份/同步落到本机）加载时同样 fail-closed。
        database
            .save_setting(
                CLOUD_CONFIG_SSOT_SETTING_KEY,
                r#"{"provider":"ftp","ftp":{"host":"ftp.example.test","port":21,"username":"student","useTls":true}}"#,
            )
            .expect("seed desktop-written FTP record");
        let load_denied = load_cloud_config_ssot(&database)
            .expect_err("桌面写入的 FTP 记录在 Android 上必须拒绝加载");
        assert_eq!(load_denied.stable_code(), FTP_UNSUPPORTED_ON_ANDROID_CODE);
        assert!(load_denied
            .to_string()
            .contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE));
    }

    /// Android 上 WebDAV 仍是可保存、可加载、可进入运行时校验的换机路径。
    #[test]
    fn android_ssot_keeps_webdav_available() {
        let (_dir, database) = settings_database();
        let stored = save_cloud_config_ssot(
            &database,
            SafeCloudStorageConfig::Webdav {
                webdav: SafeWebDavConfig {
                    endpoint: "https://dav.example.com/dav/".into(),
                    username: "student".into(),
                },
                root: Some("deep-student-sync".into()),
                allow_insecure: false,
            },
        )
        .expect("Android 上 WebDAV 记录必须可持久化");
        let mut runtime = load_cloud_config_ssot(&database)
            .expect("保存后的 WebDAV 记录必须可加载")
            .into_runtime_config();
        assert!(matches!(runtime.provider, StorageProvider::WebDav));
        // 补上安全存储中的密码后，运行时校验必须通过。
        runtime.webdav.as_mut().expect("webdav 配置").password = "secret".into();
        assert!(runtime.validate().is_ok());
        let _ = stored;
    }
}

// ============================================================================
// 第二部分：仅 WebDAV 的换机同步（旧机上传 → 新机发现 + 下载，字节一致）
// ============================================================================

/// 进程内假 WebDAV 服务器共享状态。
#[derive(Default)]
struct FakeDavStore {
    /// key: 去掉首尾 '/' 的 URL 路径 → 对象内容
    objects: HashMap<String, Vec<u8>>,
    /// MKCOL 创建过的目录（同样是去斜杠路径）
    dirs: HashSet<String>,
}

impl FakeDavStore {
    fn is_dir(&self, path: &str) -> bool {
        if self.dirs.contains(path) {
            return true;
        }
        let prefix = format!("{path}/");
        self.objects.keys().any(|key| key.starts_with(&prefix))
    }

    /// 列出 `dir` 的直接子项：(文件名相对键, 大小) 与直接子目录集合。
    fn direct_children(&self, dir: &str) -> (Vec<(String, usize)>, HashSet<String>) {
        let prefix = format!("{dir}/");
        let mut files = Vec::new();
        let mut subdirs = HashSet::new();
        for (key, data) in &self.objects {
            if let Some(rest) = key.strip_prefix(&prefix) {
                match rest.split_once('/') {
                    None => files.push((key.clone(), data.len())),
                    Some((first, _)) => {
                        subdirs.insert(format!("{dir}/{first}"));
                    }
                }
            }
        }
        for created in &self.dirs {
            if let Some(rest) = created.strip_prefix(&prefix) {
                if !rest.is_empty() && !rest.contains('/') {
                    subdirs.insert(created.clone());
                }
            }
        }
        (files, subdirs)
    }
}

const DAV_LAST_MODIFIED: &str = "Mon, 24 Aug 2026 00:00:00 GMT";

fn dav_file_response(path: &str, size: usize) -> String {
    format!(
        "<d:response><d:href>/{path}</d:href><d:propstat><d:prop>\
         <d:resourcetype/>\
         <d:getcontentlength>{size}</d:getcontentlength>\
         <d:getlastmodified>{DAV_LAST_MODIFIED}</d:getlastmodified>\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    )
}

fn dav_dir_response(path: &str) -> String {
    format!(
        "<d:response><d:href>/{path}/</d:href><d:propstat><d:prop>\
         <d:resourcetype><d:collection/></d:resourcetype>\
         </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    )
}

fn dav_multistatus(inner: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">{inner}</d:multistatus>"#
    )
}

/// 处理一条 HTTP 请求（每连接一请求，响应后 Connection: close）。
async fn handle_dav_connection(
    stream: tokio::net::TcpStream,
    store: Arc<Mutex<FakeDavStore>>,
) -> Option<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await.ok()? == 0 {
        return None;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let raw_path = parts.next()?.to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.ok()?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    // 读取请求体：支持 Content-Length 与 chunked（reqwest 流式 PUT 用 chunked）。
    let mut body: Vec<u8> = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).await.ok()?;
            let size =
                usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("").trim(), 16)
                    .ok()?;
            if size == 0 {
                // 终止块后的空行（无 trailer）
                let mut terminator = String::new();
                reader.read_line(&mut terminator).await.ok()?;
                break;
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk).await.ok()?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf).await.ok()?;
        }
    } else if let Some(length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut buf = vec![0u8; length];
        reader.read_exact(&mut buf).await.ok()?;
        body = buf;
    }

    let path = raw_path.split('?').next().unwrap_or("").to_string();
    let key = path.trim_matches('/').to_string();
    let depth = headers.get("depth").cloned().unwrap_or_else(|| "1".into());

    let (status, response_body): (&str, Vec<u8>) = {
        let mut store = store.lock().expect("fake dav store lock");
        match method.as_str() {
            "MKCOL" => {
                store.dirs.insert(key.clone());
                ("201 Created", Vec::new())
            }
            "PUT" => {
                store.objects.insert(key.clone(), body);
                ("201 Created", Vec::new())
            }
            "GET" => match store.objects.get(&key) {
                Some(data) => ("200 OK", data.clone()),
                None => ("404 Not Found", Vec::new()),
            },
            "DELETE" => {
                if store.objects.remove(&key).is_some() || store.dirs.remove(&key) {
                    ("204 No Content", Vec::new())
                } else {
                    ("404 Not Found", Vec::new())
                }
            }
            "PROPFIND" => {
                if let Some(data) = store.objects.get(&key) {
                    let xml = dav_multistatus(&dav_file_response(&key, data.len()));
                    ("207 Multi-Status", xml.into_bytes())
                } else if store.is_dir(&key) {
                    let mut inner = dav_dir_response(&key);
                    if depth != "0" {
                        let (files, subdirs) = store.direct_children(&key);
                        for (file_key, size) in files {
                            inner.push_str(&dav_file_response(&file_key, size));
                        }
                        for subdir in subdirs {
                            inner.push_str(&dav_dir_response(&subdir));
                        }
                    }
                    ("207 Multi-Status", dav_multistatus(&inner).into_bytes())
                } else {
                    ("404 Not Found", Vec::new())
                }
            }
            _ => ("405 Method Not Allowed", Vec::new()),
        }
    };

    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n",
        response_body.len()
    );
    write_half.write_all(head.as_bytes()).await.ok()?;
    write_half.write_all(&response_body).await.ok()?;
    write_half.flush().await.ok()?;
    Some(())
}

/// 启动进程内假 WebDAV 服务器，返回监听地址与对象仓库句柄。
async fn spawn_fake_webdav_server() -> (SocketAddr, Arc<Mutex<FakeDavStore>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake webdav listener");
    let addr = listener.local_addr().expect("fake webdav local addr");
    let store: Arc<Mutex<FakeDavStore>> = Arc::default();
    let shared = Arc::clone(&store);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let per_conn = Arc::clone(&shared);
            tokio::spawn(async move {
                let _ = handle_dav_connection(stream, per_conn).await;
            });
        }
    });
    (addr, store)
}

fn webdav_config(addr: SocketAddr, root: &str) -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: format!("http://{addr}/"),
            username: "student".into(),
            password: "secret".into(),
        }),
        root: Some(root.into()),
        ..Default::default()
    }
}

/// 换机主链路（仅 WebDAV）：旧手机上传备份 → 新手机（不同 device_id）通过
/// 同一 WebDAV root 发现版本、下载并得到字节一致的备份文件。
/// 走真实 `WebDavStorage` 协议栈（MKCOL/流式 PUT/PROPFIND/GET），
/// 而不是 mock trait，锁定移动端唯一传输路径端到端可用。
#[tokio::test]
async fn webdav_only_device_switch_upload_download_roundtrip() {
    let (addr, _store) = spawn_fake_webdav_server().await;
    let root = "phone-move";
    let payload: Vec<u8> = (0u32..4096).flat_map(|value| value.to_le_bytes()).collect();

    // 旧手机：上传备份 ZIP（内容真实性不影响传输语义）。
    let zip = tempfile::NamedTempFile::new().expect("temp zip");
    std::fs::write(zip.path(), &payload).expect("write zip payload");

    let old_storage = create_storage(&webdav_config(addr, root))
        .await
        .expect("old phone storage");
    let old_manager = CloudSyncManager::new(old_storage, "old-phone".to_string());
    let uploaded = old_manager
        .upload(zip.path(), Some("9.9.9".into()), Some("换机备份".into()))
        .await
        .expect("旧手机上传必须成功");
    assert_eq!(uploaded.version.device_id, "old-phone");
    assert_eq!(uploaded.version.size, payload.len() as u64);

    // 新手机：不同 device_id，同一 WebDAV root。
    let new_storage = create_storage(&webdav_config(addr, root))
        .await
        .expect("new phone storage");
    let new_manager = CloudSyncManager::new(new_storage, "new-phone".to_string());

    let versions = new_manager
        .list_versions()
        .await
        .expect("新手机必须能列出云端版本");
    assert_eq!(
        versions.len(),
        1,
        "新手机应恰好看到旧手机上传的一个版本，实际: {versions:?}"
    );
    assert_eq!(versions[0].id, uploaded.version.id);
    assert_eq!(versions[0].device_id, "old-phone");

    let download_dir = tempfile::tempdir().expect("download dir");
    let downloaded = new_manager
        .download(None, download_dir.path())
        .await
        .expect("新手机下载最新版本必须成功");
    assert_eq!(downloaded.version.id, uploaded.version.id);
    let downloaded_bytes = std::fs::read(&downloaded.local_path).expect("读取下载的备份文件");
    assert_eq!(
        downloaded_bytes, payload,
        "换机下载内容必须与旧手机上传字节一致（SHA256 校验链路生效）"
    );
}

// ============================================================================
// 第三部分：恢复写入非活动槽 → 重启切换语义（A/B 槽 + 切槽租约）
// ============================================================================

fn write_slot_payload(dir: &Path, content: &[u8]) {
    std::fs::create_dir_all(dir).expect("create slot dir");
    std::fs::write(dir.join("mistakes.db"), content).expect("write slot payload");
}

/// 核心重启语义：恢复内容只写非活动槽并登记租约；当前进程内活动槽**不变**；
/// "重启"（新进程 = 对同一 base_dir 的新 `DataSpaceManager::initialize_on_start`）
/// 才应用切换；租约在激活提交前拒绝解除，提交后一次性解除且后续重启稳定。
#[test]
fn restore_writes_inactive_slot_and_switch_happens_only_after_restart() {
    let base = tempfile::tempdir().expect("base dir");
    let backup_id = "backup-20260824-000000";

    // —— App 会话 1：完成恢复写入与登记 ——
    let mgr = DataSpaceManager::new(base.path().to_path_buf());
    mgr.initialize_on_start().expect("首次启动初始化");
    assert_eq!(mgr.active_slot(), Slot::A, "初始活动槽应为 A");
    assert_eq!(mgr.inactive_slot(), Slot::B);
    write_slot_payload(&mgr.active_dir(), b"current-device-data");

    // guard：恢复绝不允许清空活动槽（活动槽数据库被连接池持有）。
    let clear_active = mgr
        .clear_slot_for_restore(Slot::A)
        .expect_err("清空活动槽必须被拒绝");
    assert_eq!(clear_active.kind(), std::io::ErrorKind::PermissionDenied);

    // 恢复写入非活动槽（内容来自 WebDAV 下载的备份，见第二部分）。
    mgr.clear_slot_for_restore(Slot::B).expect("清空非活动槽");
    write_slot_payload(&mgr.inactive_dir(), b"restored-from-webdav-backup");
    mgr.mark_restore_cutover_pending(Slot::B, backup_id)
        .expect("登记恢复切槽租约");

    // 重启前：活动槽保持 A，租约未提交。
    assert_eq!(
        mgr.active_slot(),
        Slot::A,
        "登记切槽后、重启前，当前进程必须仍运行在旧槽上"
    );
    let lease = mgr
        .restore_cutover_pending()
        .expect("读取租约")
        .expect("租约必须已持久化");
    assert_eq!(lease.target_slot, "slotB");
    assert_eq!(lease.backup_id, backup_id);
    assert!(!lease.activation_committed);

    // 重启前解除租约必须 fail-closed（目标槽尚未激活）。
    assert!(
        mgr.complete_restore_cutover(&mgr.slot_dir(Slot::B))
            .is_err(),
        "恢复槽未激活时解除租约必须被拒绝"
    );

    // —— App 会话 2（重启）：pending 切换生效 ——
    let restarted = DataSpaceManager::new(base.path().to_path_buf());
    restarted.initialize_on_start().expect("重启初始化");
    assert_eq!(
        restarted.active_slot(),
        Slot::B,
        "重启后必须切换到恢复写入的非活动槽"
    );
    let active_payload =
        std::fs::read(restarted.active_dir().join("mistakes.db")).expect("读取激活槽数据");
    assert_eq!(active_payload, b"restored-from-webdav-backup");

    // 租约跨重启幸存，激活提交前依旧拒绝解除。
    let lease = restarted
        .restore_cutover_pending()
        .expect("读取租约")
        .expect("租约必须跨重启幸存");
    assert!(!lease.activation_committed);
    let premature = restarted
        .complete_restore_cutover(&restarted.active_dir())
        .expect_err("激活提交前解除租约必须被拒绝");
    assert_eq!(premature.kind(), std::io::ErrorKind::PermissionDenied);

    // 启动序列完成迁移/校验/身份轮换后提交激活，随后解除租约。
    restarted
        .mark_restore_activation_committed(&restarted.active_dir(), backup_id)
        .expect("提交激活");
    assert!(restarted
        .complete_restore_cutover(&restarted.active_dir())
        .expect("解除租约"));
    assert!(restarted
        .restore_cutover_pending()
        .expect("读取租约")
        .is_none());

    // —— App 会话 3：切换结果稳定，无残留租约 ——
    let again = DataSpaceManager::new(base.path().to_path_buf());
    again.initialize_on_start().expect("再次重启初始化");
    assert_eq!(again.active_slot(), Slot::B, "再次重启必须稳定在恢复槽");
    assert!(again.restore_cutover_pending().expect("读取租约").is_none());
}

/// fail-closed：租约目标与实际激活槽不一致时（如登记后又被改写 pending），
/// 启动必须拒绝在不确定的数据槽上继续，绝不静默选一个槽运行。
#[test]
fn startup_fails_closed_when_lease_target_is_not_active() {
    let base = tempfile::tempdir().expect("base dir");
    let mgr = DataSpaceManager::new(base.path().to_path_buf());
    mgr.initialize_on_start().expect("初始化");
    write_slot_payload(&mgr.slot_dir(Slot::A), b"slot-a-data");
    write_slot_payload(&mgr.slot_dir(Slot::B), b"slot-b-restored");

    mgr.mark_restore_cutover_pending(Slot::B, "backup-x")
        .expect("登记切槽租约");
    // 对抗性改写：pending 被重新指回 A（例如另一条切槽命令误触发），
    // 租约仍指向 B —— 重启后 active=A 与租约目标矛盾。
    mgr.mark_pending_switch(Slot::A).expect("改写 pending");

    let restarted = DataSpaceManager::new(base.path().to_path_buf());
    let error = restarted
        .initialize_on_start()
        .expect_err("租约目标未激活时启动必须失败");
    assert!(
        error.to_string().contains("恢复维护租约"),
        "错误必须指向租约矛盾，实际: {error}"
    );
}

/// 切槽登记的输入 guard：空目标槽与空 backup_id 都必须被拒绝，
/// 防止把用户切到没有数据的槽或留下无法对账的租约。
#[test]
fn restore_cutover_registration_guards_reject_invalid_input() {
    let base = tempfile::tempdir().expect("base dir");
    let mgr = DataSpaceManager::new(base.path().to_path_buf());
    mgr.initialize_on_start().expect("初始化");

    // 非活动槽为空：拒绝登记（数据未写入就切换会让用户"开机丢数据"）。
    assert!(
        mgr.mark_restore_cutover_pending(Slot::B, "backup-x")
            .is_err(),
        "空目标槽必须拒绝登记切槽"
    );

    // 槽有数据但 backup_id 为空白：同样拒绝。
    write_slot_payload(&mgr.slot_dir(Slot::B), b"restored");
    let error = mgr
        .mark_restore_cutover_pending(Slot::B, "   ")
        .expect_err("空白 backup_id 必须被拒绝");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);

    // 已有租约时，不同 backup 的再次登记必须冲突（AlreadyExists）。
    mgr.mark_restore_cutover_pending(Slot::B, "backup-x")
        .expect("首次登记");
    let conflict = mgr
        .mark_restore_cutover_pending(Slot::B, "backup-y")
        .expect_err("不同 backup 的并发登记必须冲突");
    assert_eq!(conflict.kind(), std::io::ErrorKind::AlreadyExists);
    // 相同参数的重复登记幂等（崩溃重试安全）。
    mgr.mark_restore_cutover_pending(Slot::B, "backup-x")
        .expect("相同租约重复登记应幂等");
}

// ============================================================================
// 第四部分：device_id 落 app_data_dir + 恢复后 rotate（子进程 = 一次 App 启动）
// ============================================================================

const PROBE_DATA_DIR_ENV: &str = "SYNC_R07_PROBE_DATA_DIR";
const PROBE_MODE_ENV: &str = "SYNC_R07_PROBE_MODE";

/// 子进程探针：每个子进程模拟一次 App 启动（绑定全局 DataSpaceManager 后
/// 走 `get_device_id` / `rotate_device_id_after_restore` 的生产路径）。
/// 正常测试运行（无环境变量）时直接通过。
#[test]
fn sync_r07_device_id_probe() {
    let Ok(data_dir) = std::env::var(PROBE_DATA_DIR_ENV) else {
        return;
    };
    let mode = std::env::var(PROBE_MODE_ENV).unwrap_or_else(|_| "get".into());
    deep_student_lib::data_space::init_data_space_manager(data_dir.into())
        .expect("探针子进程应能初始化数据空间管理器");
    match mode.as_str() {
        "get" => {
            println!(
                "PROBE_DEVICE_ID={}",
                deep_student_lib::cloud_storage::get_device_id()
            );
        }
        "rotate" => {
            let (old_id, new_id) =
                deep_student_lib::cloud_storage::rotate_device_id_after_restore()
                    .expect("恢复后轮换设备 ID 应成功");
            println!("PROBE_OLD={old_id}");
            println!("PROBE_NEW={new_id}");
            // 轮换后同一进程内立即读取必须已是新身份。
            println!(
                "PROBE_AFTER={}",
                deep_student_lib::cloud_storage::get_device_id()
            );
        }
        other => panic!("未知探针模式: {other}"),
    }
}

/// 拉起一次"App 启动"（子进程探针），返回其 stdout。
/// 隔离点与 device_identity_tests 相同：清 DEVICE_ID 环境变量、
/// HOME/XDG 指向隔离目录，防止宿主机的旧身份副本泄漏进测试。
fn run_probe(data_dir: &Path, isolated_home: &Path, mode: &str) -> String {
    let exe = std::env::current_exe().expect("当前测试二进制路径可获取");
    let output = std::process::Command::new(exe)
        .args(["sync_r07_device_id_probe", "--exact", "--nocapture"])
        .env(PROBE_DATA_DIR_ENV, data_dir)
        .env(PROBE_MODE_ENV, mode)
        .env_remove("DEVICE_ID")
        .env("HOME", isolated_home)
        .env("XDG_DATA_HOME", isolated_home.join("xdg-data"))
        .env("XDG_CONFIG_HOME", isolated_home.join("xdg-config"))
        .output()
        .expect("探针子进程应能启动");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        output.status.success(),
        "探针子进程应成功退出。stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
}

fn probe_value(stdout: &str, prefix: &str) -> String {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix))
        .unwrap_or_else(|| panic!("探针输出缺少 {prefix}。stdout:\n{stdout}"))
        .to_string()
}

/// device_id 的重启 + 恢复契约：
/// 1. 身份持久化在 `<app_data_dir>/.device_id`，跨"重启"（新进程）稳定；
/// 2. 恢复后 rotate 产出**不同**的新身份并落到同一主路径；
/// 3. rotate 之后的每次"重启"读回的都是新身份（旧身份不复活，
///    云端回声过滤不会把旧设备目录的历史误判为本机变更）。
#[test]
fn device_id_persists_in_app_data_dir_and_rotates_after_restore() {
    let home = tempfile::tempdir().expect("isolated home");
    let data = tempfile::tempdir().expect("app data dir");
    let device_id_file = data.path().join(".device_id");

    // 启动 1：生成并持久化身份。
    let first = probe_value(
        &run_probe(data.path(), home.path(), "get"),
        "PROBE_DEVICE_ID=",
    );
    assert!(!first.trim().is_empty(), "device_id 不得为空");
    assert!(
        device_id_file.is_file(),
        "device_id 必须落盘在 app 数据目录根的 .device_id"
    );
    assert_eq!(
        std::fs::read_to_string(&device_id_file)
            .expect("读取 .device_id")
            .trim(),
        first,
        "落盘身份必须与运行时返回值一致"
    );

    // 启动 2（重启）：身份稳定不漂移。
    let second = probe_value(
        &run_probe(data.path(), home.path(), "get"),
        "PROBE_DEVICE_ID=",
    );
    assert_eq!(first, second, "重启后必须读回同一 device_id");

    // 启动 3（恢复激活会话）：rotate 必须换新身份并立即生效。
    let rotate_stdout = run_probe(data.path(), home.path(), "rotate");
    let old_id = probe_value(&rotate_stdout, "PROBE_OLD=");
    let new_id = probe_value(&rotate_stdout, "PROBE_NEW=");
    let after = probe_value(&rotate_stdout, "PROBE_AFTER=");
    assert_eq!(old_id, first, "rotate 报告的旧身份必须是恢复前的持久身份");
    assert_ne!(
        new_id, old_id,
        "恢复后必须轮换出新身份，否则回声过滤会丢弃旧身份在备份点之后的云端变更"
    );
    assert_eq!(after, new_id, "轮换后同进程内读取必须立即返回新身份");
    assert_eq!(
        std::fs::read_to_string(&device_id_file)
            .expect("读取 .device_id")
            .trim(),
        new_id,
        "新身份必须覆盖主路径 .device_id"
    );

    // 启动 4（rotate 后重启）：新身份持久，旧身份不复活。
    let post_restart = probe_value(
        &run_probe(data.path(), home.path(), "get"),
        "PROBE_DEVICE_ID=",
    );
    assert_eq!(post_restart, new_id, "轮换后的重启必须读回新身份");
}
