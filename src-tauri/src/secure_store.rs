//! 安全存储模块 - 跨平台凭据安全存储
//!
//! 存储实现（`SecureStore`、云存储凭据 API、根种子平台保护）在 dstu-security 的
//! `secure_store` 模块，这里按原路径重导出；Tauri 命令与依赖云存储配置 /
//! `AppState` 的 hydrate 逻辑留在 app。

pub use dstu_security::secure_store::*;

use tauri::Manager;
use tracing::warn;

// ==================== Tauri 命令 ====================

use crate::error_details::CommandError;

/// 全局安全存储实例
fn get_secure_store(app: Option<&tauri::AppHandle>) -> SecureStore {
    let config = SecureStoreConfig::default();
    if let Some(app) = app {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            return SecureStore::new_with_dir(config, app_data_dir);
        }
    }
    SecureStore::new(config)
}

/// 保存云存储凭据到安全存储。
///
/// `encryption_password_is_preexisting`：前端在「重输存量口令」入口（换机/
/// 重装恢复、legacy 云配置迁移）置 true，跳过新设口令的最小长度与
/// [Wave2-R5] 弱口令准入；缺省/false 保持新设口令 fail-closed。
#[tauri::command]
pub fn secure_save_cloud_credentials(
    app: tauri::AppHandle,
    credentials: CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .update_cloud_credentials_with_policy(
            &credentials,
            encryption_password_is_preexisting.unwrap_or(false),
        )
        .map_err(|e| e.to_command_error("save_cloud_credentials"))
}

/// 获取云存储凭据存在状态；绝不向 WebView 返回 secret 值。
#[tauri::command]
pub fn secure_get_cloud_credentials(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .cloud_credential_status()
        .map_err(|e| e.to_command_error("get_cloud_credentials"))
}

pub(crate) fn delete_cloud_credentials_for_app(
    app: &tauri::AppHandle,
) -> Result<(), SecureStoreError> {
    get_secure_store(Some(app)).delete_cloud_credentials()
}

/// 删除云存储凭据
#[tauri::command]
pub fn secure_delete_cloud_credentials(app: tauri::AppHandle) -> Result<(), CommandError> {
    delete_cloud_credentials_for_app(&app)
        .map_err(|e| e.to_command_error("delete_cloud_credentials"))
}

/// 显式停用端到端加密：仅从安全存储删除加密密码，传输凭据不受影响。
#[tauri::command]
pub fn secure_clear_cloud_encryption_password(
    app: tauri::AppHandle,
) -> Result<CloudStorageCredentialStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .clear_cloud_encryption_password()
        .map_err(|e| e.to_command_error("clear_cloud_encryption_password"))
}

/// 检查安全存储是否可用
#[tauri::command]
pub fn secure_store_is_available(app: tauri::AppHandle) -> bool {
    let store = get_secure_store(Some(&app));
    store.is_available()
}

/// 查询「系统钥匙串保护」状态（只读文件系统，不触碰密钥库）
#[tauri::command]
pub fn secure_store_get_keystore_protection(
    app: tauri::AppHandle,
) -> Result<KeystoreProtectionStatus, CommandError> {
    let store = get_secure_store(Some(&app));
    store
        .keystore_protection_status()
        .map_err(|e| e.to_command_error("get_keystore_protection"))
}

/// 开启/关闭「系统钥匙串保护」并立即执行种子迁移。
/// 迁移涉及密钥库读写，可能阻塞在系统授权弹窗上，故用 async 让出主线程。
#[tauri::command]
pub async fn secure_store_set_keystore_protection(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<KeystoreProtectionStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = get_secure_store(Some(&app));
        store
            .set_keystore_protection(enabled)
            .map_err(|e| e.to_command_error("set_keystore_protection"))?;
        store
            .keystore_protection_status()
            .map_err(|e| e.to_command_error("get_keystore_protection"))
    })
    .await
    .map_err(|e| CommandError::new("SECURE_STORE_INTERNAL", format!("任务执行失败: {}", e)))?
}

// ==================== 凭据后端自取（hydrate） ====================

/// 用安全存储中的凭据重建 `CloudStorageConfig` 的敏感字段。
///
/// [P0-3A] 前端的常规调用路径（同步、冲突检测、状态查询等）不再携带明文
/// 凭据——密码字段传空串，由各 Tauri 命令在入口处调用本函数从安全存储补全。
/// 这样明文凭据只在用户首次录入时经过一次 IPC，之后不再往返于前端。
///
/// 安全存储是 secret 的唯一事实源：即使调用方构造了非空 secret，也会先被
/// 丢弃，再用安全存储中的值覆盖。读取失败或尚未保存凭据时保留空值，使后续
/// `CloudStorageConfig::validate` fail-closed，而不是接受 IPC 注入的 secret。
fn apply_cloud_credentials(
    config: &mut crate::cloud_storage::CloudStorageConfig,
    credentials: Option<&CloudStorageCredentials>,
) {
    if let Some(webdav) = config.webdav.as_mut() {
        webdav.password = credentials
            .and_then(|value| value.webdav_password.as_deref())
            .filter(|password| !password.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    if let Some(s3) = config.s3.as_mut() {
        s3.secret_access_key = credentials
            .and_then(|value| value.s3_secret_access_key.as_deref())
            .filter(|secret| !secret.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    if let Some(ftp) = config.ftp.as_mut() {
        ftp.password = credentials
            .and_then(|value| value.ftp_password.as_deref())
            .filter(|password| !password.trim().is_empty())
            .unwrap_or_default()
            .to_string();
    }
    config.encryption_password = credentials
        .and_then(|value| value.encryption_password.as_ref())
        .filter(|p| !p.trim().is_empty())
        .cloned();
}

fn replace_with_persisted_cloud_config(
    config: &mut crate::cloud_storage::CloudStorageConfig,
    persisted: Option<crate::cloud_config_commands::SafeCloudStorageConfig>,
) {
    *config = persisted
        .map(crate::cloud_config_commands::SafeCloudStorageConfig::into_runtime_config)
        .unwrap_or_default();
}

pub(crate) fn hydrate_cloud_config_credentials(
    app: &tauri::AppHandle,
    config: &mut crate::cloud_storage::CloudStorageConfig,
) {
    let store = get_secure_store(Some(app));
    let credentials = match store.get_cloud_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            warn!(
                "读取云存储凭据失败（清空 IPC secret 并 fail-closed）: {}",
                error
            );
            None
        }
    };
    apply_cloud_credentials(config, credentials.as_ref());
}

pub fn hydrate_cloud_config(
    app: &tauri::AppHandle,
    config: &mut crate::cloud_storage::CloudStorageConfig,
) {
    // Non-secret runtime metadata is never trusted from IPC. Rebuild it from
    // the active database SSOT so the backend record is the sole authority and
    // the non-serializable insecure-transport capability can only originate
    // from a validated persisted allow_insecure decision.
    let persisted = app
        .try_state::<crate::commands::AppState>()
        .and_then(|state| {
            match crate::cloud_config_commands::load_cloud_config_ssot(&state.database) {
                Ok(config) => Some(config),
                Err(crate::cloud_config_commands::CloudConfigSsotError::NotConfigured) => None,
                Err(error) => {
                    warn!(
                        "读取后端云配置 SSOT 失败（清空 IPC 配置并 fail-closed）: {}",
                        error
                    );
                    None
                }
            }
        });
    replace_with_persisted_cloud_config(config, persisted);
    hydrate_cloud_config_credentials(app, config);
}

#[cfg(test)]
mod cloud_hydration_tests {
    use super::*;
    use crate::cloud_config_commands::{SafeCloudStorageConfig, SafeWebDavConfig};
    use crate::cloud_storage::{
        CloudStorageConfig, FtpConfig, S3Config, StorageProvider, WebDavConfig,
    };

    #[test]
    fn backend_hydration_fills_only_secret_fields() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: String::new(),
            }),
            s3: Some(S3Config {
                endpoint: "https://s3.example.test".to_string(),
                bucket: "coursework".to_string(),
                access_key_id: "public-id".to_string(),
                secret_access_key: String::new(),
                region: None,
                path_style: false,
            }),
            ftp: Some(FtpConfig {
                host: "ftp.example.test".to_string(),
                port: 21,
                username: "student".to_string(),
                password: String::new(),
                use_tls: true,
            }),
            root: Some("coursework".to_string()),
            encryption_password: None,
            insecure_transport_authorized: false,
        };
        let credentials = CloudStorageCredentials {
            webdav_password: Some("webdav-secret".to_string()),
            s3_secret_access_key: Some("s3-secret".to_string()),
            ftp_password: Some("ftp-secret".to_string()),
            encryption_password: Some("encryption-secret".to_string()),
        };

        apply_cloud_credentials(&mut config, Some(&credentials));

        assert_eq!(config.webdav.unwrap().password, "webdav-secret");
        assert_eq!(config.s3.unwrap().secret_access_key, "s3-secret");
        assert_eq!(config.ftp.unwrap().password, "ftp-secret");
        assert_eq!(
            config.encryption_password.as_deref(),
            Some("encryption-secret")
        );
        assert_eq!(config.root.as_deref(), Some("coursework"));
    }

    #[test]
    fn hydration_rejects_ipc_secret_in_favor_of_secure_store() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: "new-secret".to_string(),
            }),
            ..Default::default()
        };
        let credentials = CloudStorageCredentials {
            webdav_password: Some("stored-secret".to_string()),
            s3_secret_access_key: None,
            ftp_password: None,
            encryption_password: None,
        };

        apply_cloud_credentials(&mut config, Some(&credentials));

        assert_eq!(config.webdav.unwrap().password, "stored-secret");
    }

    #[test]
    fn hydration_clears_ipc_secrets_when_secure_store_is_empty() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.test".to_string(),
                username: "student".to_string(),
                password: "ipc-secret".to_string(),
            }),
            encryption_password: Some("ipc-encryption-secret".to_string()),
            ..Default::default()
        };

        apply_cloud_credentials(&mut config, None);

        assert_eq!(config.webdav.unwrap().password, "");
        assert!(config.encryption_password.is_none());
    }

    #[test]
    fn persisted_nonsecret_config_replaces_the_complete_ipc_shape() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "http://attacker.example.test".to_string(),
                username: "attacker".to_string(),
                password: "ipc-secret".to_string(),
            }),
            root: Some("attacker-root".to_string()),
            ..Default::default()
        };
        let persisted = SafeCloudStorageConfig::Webdav {
            webdav: SafeWebDavConfig {
                endpoint: "https://persisted.example.test".to_string(),
                username: "persisted-user".to_string(),
            },
            root: Some("persisted-root".to_string()),
            allow_insecure: false,
        };

        replace_with_persisted_cloud_config(&mut config, Some(persisted));

        let webdav = config.webdav.as_ref().expect("persisted WebDAV config");
        assert_eq!(webdav.endpoint, "https://persisted.example.test");
        assert_eq!(webdav.username, "persisted-user");
        assert_eq!(webdav.password, "");
        assert_eq!(config.root.as_deref(), Some("persisted-root"));
        assert!(!config.insecure_transport_authorized);
    }

    #[test]
    fn missing_backend_ssot_discards_the_complete_ipc_shape() {
        let mut config = CloudStorageConfig {
            provider: StorageProvider::Ftp,
            ftp: Some(FtpConfig {
                host: "ftp.example.test".to_string(),
                port: 21,
                username: "attacker".to_string(),
                password: "ipc-secret".to_string(),
                use_tls: false,
            }),
            ..Default::default()
        };

        replace_with_persisted_cloud_config(&mut config, None);

        assert!(config.webdav.is_none());
        assert!(config.s3.is_none());
        assert!(config.ftp.is_none());
        assert!(!config.insecure_transport_authorized);
    }
}
