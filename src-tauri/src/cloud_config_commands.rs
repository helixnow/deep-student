//! Backend SSOT for credential-free cloud-storage configuration.
//!
//! Non-secret connection metadata is stored in the main settings database.
//! Secrets remain exclusively in `secure_store`. Public cleartext transports
//! are admitted only when the exact endpoint was loaded from a persisted
//! `allow_insecure` decision.

use serde::{Deserialize, Serialize};

use crate::cloud_storage::{
    CloudStorageConfig, FtpConfig, S3Config, StorageProvider, WebDavConfig,
};

pub const CLOUD_CONFIG_SSOT_SETTING_KEY: &str = "cloud_storage.config.safe_v1";

const MAX_ENDPOINT_CHARS: usize = 2_048;
const MAX_IDENTITY_CHARS: usize = 512;
const MAX_ROOT_CHARS: usize = 256;
const MAX_STORED_CONFIG_BYTES: usize = 16 * 1_024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeWebDavConfig {
    pub endpoint: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeS3Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default)]
    pub path_style: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeFtpConfig {
    pub host: String,
    #[serde(default = "default_ftp_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub use_tls: bool,
}

fn default_ftp_port() -> u16 {
    21
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Credential-free cloud configuration accepted from Settings.
///
/// `deny_unknown_fields` intentionally rejects every secret-shaped field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "lowercase", deny_unknown_fields)]
pub enum SafeCloudStorageConfig {
    Webdav {
        webdav: SafeWebDavConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        allow_insecure: bool,
    },
    S3 {
        s3: SafeS3Config,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        allow_insecure: bool,
    },
    Ftp {
        ftp: SafeFtpConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        allow_insecure: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfigSsotResponse {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<SafeCloudStorageConfig>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CloudConfigSsotError {
    #[error("cloud sync is not configured in the backend SSOT")]
    NotConfigured,
    #[error("invalid non-secret cloud configuration: {0}")]
    Invalid(String),
    #[error("cloud configuration storage failed: {0}")]
    Storage(String),
    #[error("cloud credentials are unavailable or incomplete: {0}")]
    CredentialsUnavailable(String),
}

fn bounded_text(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<String, CloudConfigSsotError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CloudConfigSsotError::Invalid(format!(
            "{field} must not be blank"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(CloudConfigSsotError::Invalid(format!(
            "{field} exceeds {max_chars} characters"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(CloudConfigSsotError::Invalid(format!(
            "{field} contains control characters"
        )));
    }
    Ok(value.to_string())
}

fn validated_http_endpoint(
    value: &str,
    field: &str,
) -> Result<(String, url::Url), CloudConfigSsotError> {
    let value = bounded_text(value, field, MAX_ENDPOINT_CHARS)?;
    let url = url::Url::parse(&value)
        .map_err(|_| CloudConfigSsotError::Invalid(format!("{field} must be a valid URL")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(CloudConfigSsotError::Invalid(format!(
            "{field} must use http or https and include a host"
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CloudConfigSsotError::Invalid(format!(
            "{field} must not embed credentials"
        )));
    }
    Ok((value, url))
}

fn validated_root(root: Option<String>) -> Result<Option<String>, CloudConfigSsotError> {
    let Some(root) = root else {
        return Ok(None);
    };
    let root = root.trim().trim_matches('/').trim();
    if root.is_empty() {
        return Ok(None);
    }
    if root.chars().count() > MAX_ROOT_CHARS
        || root.chars().any(char::is_control)
        || root.contains('\\')
        || root
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(CloudConfigSsotError::Invalid(
            "root must be a bounded relative cloud key without traversal".to_string(),
        ));
    }
    Ok(Some(root.to_string()))
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

impl SafeCloudStorageConfig {
    pub fn provider_name(&self) -> &'static str {
        match self {
            Self::Webdav { .. } => "webdav",
            Self::S3 { .. } => "s3",
            Self::Ftp { .. } => "ftp",
        }
    }

    pub fn root(&self) -> Option<&str> {
        match self {
            Self::Webdav { root, .. } | Self::S3 { root, .. } | Self::Ftp { root, .. } => {
                root.as_deref()
            }
        }
    }

    fn validate_and_normalize(self) -> Result<Self, CloudConfigSsotError> {
        match self {
            Self::Webdav {
                webdav,
                root,
                allow_insecure,
            } => {
                let (endpoint, parsed) =
                    validated_http_endpoint(&webdav.endpoint, "webdav.endpoint")?;
                let loopback = parsed.host_str().is_some_and(is_loopback_host);
                let insecure = parsed.scheme() == "http" && !loopback;
                if insecure && !allow_insecure {
                    return Err(CloudConfigSsotError::Invalid(
                        "public HTTP WebDAV requires persisted allowInsecure=true".to_string(),
                    ));
                }
                Ok(Self::Webdav {
                    webdav: SafeWebDavConfig {
                        endpoint,
                        username: bounded_text(
                            &webdav.username,
                            "webdav.username",
                            MAX_IDENTITY_CHARS,
                        )?,
                    },
                    root: validated_root(root)?,
                    allow_insecure: insecure && allow_insecure,
                })
            }
            Self::S3 {
                s3,
                root,
                allow_insecure: _,
            } => {
                let (endpoint, parsed) = validated_http_endpoint(&s3.endpoint, "s3.endpoint")?;
                if parsed.scheme() == "http" && !parsed.host_str().is_some_and(is_loopback_host) {
                    return Err(CloudConfigSsotError::Invalid(
                        "public S3 endpoints must use HTTPS".to_string(),
                    ));
                }
                Ok(Self::S3 {
                    s3: SafeS3Config {
                        endpoint,
                        bucket: bounded_text(&s3.bucket, "s3.bucket", MAX_IDENTITY_CHARS)?,
                        access_key_id: bounded_text(
                            &s3.access_key_id,
                            "s3.accessKeyId",
                            MAX_IDENTITY_CHARS,
                        )?,
                        region: s3
                            .region
                            .map(|region| bounded_text(&region, "s3.region", MAX_IDENTITY_CHARS))
                            .transpose()?,
                        path_style: s3.path_style,
                    },
                    root: validated_root(root)?,
                    allow_insecure: false,
                })
            }
            Self::Ftp {
                ftp,
                root,
                allow_insecure,
            } => {
                if ftp.port == 0 {
                    return Err(CloudConfigSsotError::Invalid(
                        "ftp.port must be between 1 and 65535".to_string(),
                    ));
                }
                let host = bounded_text(&ftp.host, "ftp.host", MAX_ENDPOINT_CHARS)?;
                if host.contains("://")
                    || host.contains('/')
                    || host.contains('@')
                    || host.contains(char::is_whitespace)
                {
                    return Err(CloudConfigSsotError::Invalid(
                        "ftp.host must be a hostname or IP address without scheme or credentials"
                            .to_string(),
                    ));
                }
                let insecure = !ftp.use_tls && !is_loopback_host(&host);
                if insecure && !allow_insecure {
                    return Err(CloudConfigSsotError::Invalid(
                        "public FTP without TLS requires persisted allowInsecure=true".to_string(),
                    ));
                }
                Ok(Self::Ftp {
                    ftp: SafeFtpConfig {
                        host,
                        port: ftp.port,
                        username: bounded_text(&ftp.username, "ftp.username", MAX_IDENTITY_CHARS)?,
                        use_tls: ftp.use_tls,
                    },
                    root: validated_root(root)?,
                    allow_insecure: insecure && allow_insecure,
                })
            }
        }
    }

    pub fn into_runtime_config(self) -> CloudStorageConfig {
        match self {
            Self::Webdav {
                webdav,
                root,
                allow_insecure,
            } => CloudStorageConfig {
                provider: StorageProvider::WebDav,
                webdav: Some(WebDavConfig {
                    endpoint: webdav.endpoint,
                    username: webdav.username,
                    password: String::new(),
                }),
                s3: None,
                ftp: None,
                root,
                encryption_password: None,
                insecure_transport_authorized: allow_insecure,
            },
            Self::S3 { s3, root, .. } => CloudStorageConfig {
                provider: StorageProvider::S3,
                webdav: None,
                s3: Some(S3Config {
                    endpoint: s3.endpoint,
                    bucket: s3.bucket,
                    access_key_id: s3.access_key_id,
                    secret_access_key: String::new(),
                    region: s3.region,
                    path_style: s3.path_style,
                }),
                ftp: None,
                root,
                encryption_password: None,
                insecure_transport_authorized: false,
            },
            Self::Ftp {
                ftp,
                root,
                allow_insecure,
            } => CloudStorageConfig {
                provider: StorageProvider::Ftp,
                webdav: None,
                s3: None,
                ftp: Some(FtpConfig {
                    host: ftp.host,
                    port: ftp.port,
                    username: ftp.username,
                    password: String::new(),
                    use_tls: ftp.use_tls,
                }),
                root,
                encryption_password: None,
                insecure_transport_authorized: allow_insecure,
            },
        }
    }
}

pub fn save_cloud_config_ssot(
    database: &crate::database::Database,
    config: SafeCloudStorageConfig,
) -> Result<SafeCloudStorageConfig, CloudConfigSsotError> {
    let config = config.validate_and_normalize()?;
    let encoded = serde_json::to_string(&config)
        .map_err(|_| CloudConfigSsotError::Invalid("configuration is not serializable".into()))?;
    if encoded.len() > MAX_STORED_CONFIG_BYTES {
        return Err(CloudConfigSsotError::Invalid(
            "serialized configuration is too large".to_string(),
        ));
    }
    database
        .save_setting(CLOUD_CONFIG_SSOT_SETTING_KEY, &encoded)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()))?;
    Ok(config)
}

pub fn load_cloud_config_ssot(
    database: &crate::database::Database,
) -> Result<SafeCloudStorageConfig, CloudConfigSsotError> {
    let encoded = database
        .get_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()))?
        .ok_or(CloudConfigSsotError::NotConfigured)?;
    if encoded.len() > MAX_STORED_CONFIG_BYTES {
        return Err(CloudConfigSsotError::Invalid(
            "stored configuration is too large".to_string(),
        ));
    }
    let config = serde_json::from_str::<SafeCloudStorageConfig>(&encoded)
        .map_err(|_| CloudConfigSsotError::Invalid("stored configuration is malformed".into()))?
        .validate_and_normalize()?;
    Ok(config)
}

pub fn load_hydrated_cloud_config_ssot(
    app: &tauri::AppHandle,
    database: &crate::database::Database,
) -> Result<CloudStorageConfig, CloudConfigSsotError> {
    let mut config = load_cloud_config_ssot(database)?.into_runtime_config();
    crate::secure_store::hydrate_cloud_config_credentials(app, &mut config);
    config
        .validate()
        .map_err(CloudConfigSsotError::CredentialsUnavailable)?;
    Ok(config)
}

#[tauri::command]
pub async fn cloud_config_ssot_save(
    state: tauri::State<'_, crate::commands::AppState>,
    config: SafeCloudStorageConfig,
) -> Result<CloudConfigSsotResponse, String> {
    let config =
        save_cloud_config_ssot(&state.database, config).map_err(|error| error.to_string())?;
    Ok(CloudConfigSsotResponse {
        configured: true,
        provider: Some(config.provider_name().to_string()),
        root: config.root().map(str::to_string),
        config: Some(config),
    })
}

#[tauri::command]
pub async fn cloud_config_ssot_get(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<CloudConfigSsotResponse, String> {
    match load_cloud_config_ssot(&state.database) {
        Ok(config) => Ok(CloudConfigSsotResponse {
            configured: true,
            provider: Some(config.provider_name().to_string()),
            root: config.root().map(str::to_string),
            config: Some(config),
        }),
        Err(CloudConfigSsotError::NotConfigured) => Ok(CloudConfigSsotResponse {
            configured: false,
            provider: None,
            root: None,
            config: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn cloud_config_ssot_clear(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<CloudConfigSsotResponse, String> {
    state
        .database
        .delete_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()).to_string())?;
    crate::secure_store::delete_cloud_credentials_for_app(&app)
        .map_err(|error| error.to_string())?;
    Ok(CloudConfigSsotResponse {
        configured: false,
        provider: None,
        root: None,
        config: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn webdav(endpoint: &str, allow_insecure: bool) -> SafeCloudStorageConfig {
        SafeCloudStorageConfig::Webdav {
            webdav: SafeWebDavConfig {
                endpoint: endpoint.to_string(),
                username: "student".to_string(),
            },
            root: Some("deep-student-sync".to_string()),
            allow_insecure,
        }
    }

    fn test_database() -> (tempfile::TempDir, crate::database::Database) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let database = crate::database::Database::new(&dir.path().join("settings.db"))
            .expect("open test database");
        database
            .get_conn_safe()
            .expect("connection")
            .execute_batch(
                "CREATE TABLE settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'general',
                    updated_at INTEGER NOT NULL DEFAULT 0
                );",
            )
            .expect("create settings table");
        (dir, database)
    }

    #[test]
    fn dto_rejects_secret_fields() {
        let encoded = r#"{
            "provider":"webdav",
            "webdav":{"endpoint":"https://dav.example.test","username":"u","password":"secret"}
        }"#;
        assert!(serde_json::from_str::<SafeCloudStorageConfig>(encoded).is_err());
    }

    #[test]
    fn public_http_requires_persisted_opt_in() {
        let (_dir, database) = test_database();
        let endpoint = "http://dav.security-contract.test";
        let denied = save_cloud_config_ssot(&database, webdav(endpoint, false))
            .expect_err("public HTTP must fail without explicit opt-in");
        assert!(matches!(denied, CloudConfigSsotError::Invalid(_)));

        let stored = save_cloud_config_ssot(&database, webdav(endpoint, true))
            .expect("explicit opt-in should persist");
        assert_eq!(stored, load_cloud_config_ssot(&database).unwrap());
        let mut runtime = stored.into_runtime_config();
        assert!(runtime.insecure_transport_authorized);
        runtime.webdav.as_mut().unwrap().password = "secret".to_string();
        assert!(
            runtime.validate().is_ok(),
            "the shared backend validator should honor only the persisted approval"
        );

        let mut unpersisted = webdav(endpoint, false).into_runtime_config();
        unpersisted.webdav.as_mut().unwrap().password = "secret".to_string();
        assert!(
            unpersisted.validate().is_err(),
            "loading an approved record must not globally authorize another runtime DTO"
        );
    }

    #[test]
    fn loopback_http_does_not_persist_risk_override() {
        let (_dir, database) = test_database();
        let stored = save_cloud_config_ssot(&database, webdav("http://127.42.0.1:8080/dav", true))
            .expect("loopback HTTP is allowed");
        let SafeCloudStorageConfig::Webdav { allow_insecure, .. } = stored else {
            unreachable!()
        };
        assert!(!allow_insecure);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn public_plaintext_ftp_requires_persisted_opt_in() {
        let (_dir, database) = test_database();
        let host = "ftp.security-contract.test";
        let config = SafeCloudStorageConfig::Ftp {
            ftp: SafeFtpConfig {
                host: host.to_string(),
                port: 21,
                username: "student".to_string(),
                use_tls: false,
            },
            root: None,
            allow_insecure: true,
        };

        let stored = save_cloud_config_ssot(&database, config).expect("persist FTP opt-in");
        let mut runtime = stored.into_runtime_config();
        assert!(runtime.insecure_transport_authorized);
        runtime.ftp.as_mut().unwrap().password = "secret".to_string();
        assert!(runtime.validate().is_ok());
    }
}
