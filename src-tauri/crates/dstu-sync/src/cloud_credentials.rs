//! 云存储凭据后端自取（hydrate）。
//!
//! 拆分前位于 app 的 `secure_store` 模块（`hydrate_cloud_config` /
//! `hydrate_cloud_config_credentials` 及其私有辅助函数），app 的 `secure_store`
//! 按原路径重导出这里的公开项；函数体与测试不变。
//!
//! 拆分前 `hydrate_cloud_config` 直接 `app.try_state::<AppState>()` 取主设置库
//! （`AppState.database`）。`AppState` 属于 app，这里改为 [`SettingsDatabaseProvider`]
//! 槽位（`dstu-kernel` 的 [`Slot`]，单提供方），由 app 在
//! `extensions::register_extensions()` 中注册“`try_state::<AppState>()` 后取
//! `database`”的实现；全部注册时的可观察行为与拆分前一致（未注册时等价于
//! `AppState` 尚未 manage：丢弃 IPC 配置并 fail-closed）。

use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};
use tauri::Manager;
use tracing::warn;

use crate::database::Database;
use crate::secure_store::{CloudStorageCredentials, SecureStore, SecureStoreConfig};

// ==================== 主设置库取用（app 注册） ====================

/// 主设置库（拆分前的 `AppState.database`）取用。
pub trait SettingsDatabaseProvider: Send + Sync {
    /// 与拆分前 `app.try_state::<AppState>()` 后取 `state.database` 等价；
    /// `AppState` 尚未注册时返回 `None`。
    fn settings_database(&self, app: &tauri::AppHandle) -> Option<Arc<Database>>;
}

static SETTINGS_DATABASE: Slot<dyn SettingsDatabaseProvider> = Slot::new();

/// 注册主设置库取用实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_settings_database_provider(
    provider: Arc<dyn SettingsDatabaseProvider>,
) -> Result<Disposer, SlotOccupied> {
    SETTINGS_DATABASE.provide(provider)
}

fn settings_database(app: &tauri::AppHandle) -> Option<Arc<Database>> {
    SETTINGS_DATABASE
        .get()
        .and_then(|provider| provider.settings_database(app))
}

/// 全局安全存储实例
pub fn get_secure_store(app: Option<&tauri::AppHandle>) -> SecureStore {
    let config = SecureStoreConfig::default();
    if let Some(app) = app {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            return SecureStore::new_with_dir(config, app_data_dir);
        }
    }
    SecureStore::new(config)
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

pub fn hydrate_cloud_config_credentials(
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
    let persisted = settings_database(app).and_then(|database| {
        match crate::cloud_config_commands::load_cloud_config_ssot(&database) {
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
