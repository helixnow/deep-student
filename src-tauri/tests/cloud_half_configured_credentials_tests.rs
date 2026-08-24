//! 半配置凭据（config 在、secure credential 不在）fail-closed 契约测试。
//!
//! 生产链路：所有云同步/连接命令（`cloud_storage_check_connection`、
//! `cloud_sync_upload/download`、data_governance 同步命令等）统一先经
//! `secure_store::hydrate_cloud_config` 从安全存储补全凭据，再调
//! `create_storage`。当安全存储中**没有**对应凭据时，`apply_cloud_credentials`
//! 会把 secret 字段填成空字符串——因此「配置存在但凭据缺失」的运行时形态
//! 就是「endpoint/username 就绪、password/secret 为空」的 config。
//!
//! 本文件锁定：这种半配置状态下，配置校验与存储创建必须失败（返回可操作
//! 错误），连接检查/同步绝不能报健康；并且 fail-closed 必须发生在任何网络
//! I/O 之前（即使远端愿意接受匿名请求）。
//!
//! 仅新增测试，不修改生产代码。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use deep_student_lib::cloud_storage::{
    create_storage, CloudStorageConfig, FtpConfig, S3Config, StorageProvider, WebDavConfig,
};
use tokio::net::TcpListener;

/// 模拟 hydrate 后的半配置 WebDAV config：endpoint/username 来自持久化配置，
/// password 因安全存储无凭据而被补成空串。
fn half_configured_webdav(endpoint: String) -> CloudStorageConfig {
    CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint,
            username: "student".to_string(),
            password: String::new(),
        }),
        s3: None,
        ftp: None,
        root: Some("deep-student-sync".to_string()),
        encryption_password: None,
        insecure_transport_authorized: false,
    }
}

/// 起一个来者不拒的假远端（接受任何 TCP 连接），只用于计数：
/// 证明 fail-closed 发生在网络 I/O 之前。
async fn spawn_connection_counter() -> (std::net::SocketAddr, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind counter listener");
    let addr = listener.local_addr().expect("local addr");
    let connections = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&connections);
    tokio::spawn(async move {
        loop {
            let Ok((_socket, _)) = listener.accept().await else {
                break;
            };
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });
    (addr, connections)
}

#[tokio::test]
async fn webdav_missing_password_fails_closed_before_any_network_io() {
    let (addr, connections) = spawn_connection_counter().await;
    let config = half_configured_webdav(format!("http://{addr}/"));

    // 1) 配置校验必须失败，且错误信息可操作（指向密码缺失）。
    let validation = config.validate();
    let message = validation
        .expect_err("空密码的 WebDAV 配置必须校验失败")
        .to_string();
    assert!(
        message.contains("密码"),
        "校验错误必须指向密码问题，便于用户重新录入凭据，实际: {message}"
    );

    // 2) create_storage 是所有连接检查/同步命令的公共入口，必须同样失败。
    let created = create_storage(&config).await;
    assert!(
        created.is_err(),
        "半配置凭据不得创建存储实例（连接检查/同步不得报健康）"
    );

    // 3) fail-closed 必须发生在任何网络 I/O 之前：即使远端来者不拒，
    //    也不允许带着空凭据去碰远端。
    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "凭据缺失时不得发起任何网络连接"
    );
}

#[tokio::test]
async fn webdav_whitespace_password_is_still_missing_credential() {
    // 安全存储 hydration 对全空白凭据同样按缺失处理（filter !trim().is_empty()），
    // 校验端也必须拒绝全空白密码，两端口径一致。
    let mut config = half_configured_webdav("https://dav.example.test/dav/".to_string());
    config.webdav.as_mut().unwrap().password = "   ".to_string();
    assert!(
        config.validate().is_err(),
        "全空白密码等同缺失凭据，必须校验失败"
    );
    assert!(create_storage(&config).await.is_err());
}

#[tokio::test]
async fn s3_missing_secret_key_fails_closed() {
    let config = CloudStorageConfig {
        provider: StorageProvider::S3,
        webdav: None,
        s3: Some(S3Config {
            endpoint: "https://s3.example.test".to_string(),
            bucket: "coursework".to_string(),
            access_key_id: "public-id".to_string(),
            // hydration 未找到凭据 → secret 为空
            secret_access_key: String::new(),
            region: Some("us-east-1".to_string()),
            path_style: false,
        }),
        ftp: None,
        root: None,
        encryption_password: None,
        insecure_transport_authorized: false,
    };
    let message = config
        .validate()
        .expect_err("空 Secret Access Key 的 S3 配置必须校验失败")
        .to_string();
    assert!(
        message.contains("Secret Access Key"),
        "校验错误必须指向缺失的 Secret Access Key，实际: {message}"
    );
    assert!(
        create_storage(&config).await.is_err(),
        "半配置 S3 凭据不得创建存储实例"
    );
}

#[cfg(not(target_os = "android"))]
#[tokio::test]
async fn ftp_missing_password_fails_closed() {
    let config = CloudStorageConfig {
        provider: StorageProvider::Ftp,
        webdav: None,
        s3: None,
        ftp: Some(FtpConfig {
            host: "ftp.example.test".to_string(),
            port: 21,
            username: "student".to_string(),
            password: String::new(),
            use_tls: true,
        }),
        root: None,
        encryption_password: None,
        insecure_transport_authorized: false,
    };
    let message = config
        .validate()
        .expect_err("空密码的 FTP 配置必须校验失败")
        .to_string();
    assert!(
        message.contains("密码"),
        "校验错误必须指向密码问题，实际: {message}"
    );
    assert!(
        create_storage(&config).await.is_err(),
        "半配置 FTP 凭据不得创建存储实例"
    );
}

/// 反向对照：同一份 WebDAV 配置补上非空密码后应能通过校验并创建实例，
/// 证明上面各用例失败的唯一原因就是凭据缺失，而不是配置其他字段问题。
#[tokio::test]
async fn webdav_with_full_credentials_passes_validation() {
    let mut config = half_configured_webdav("http://127.0.0.1:9/".to_string());
    config.webdav.as_mut().unwrap().password = "correct-horse".to_string();
    config
        .validate()
        .expect("补全凭据后的 loopback WebDAV 配置应通过校验");
    // create_storage 只构建客户端不发请求，应成功。
    create_storage(&config)
        .await
        .expect("补全凭据后应能创建存储实例");
}
