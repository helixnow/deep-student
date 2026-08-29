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

/// Android 构建拒绝 FTP/FTPS 时的稳定 IPC 错误码。
pub const FTP_UNSUPPORTED_ON_ANDROID_CODE: &str = "E_FTP_UNSUPPORTED_ON_ANDROID";

/// Stable message for every backend path that rejects FTP on Android.
///
/// Shared by `cloud_storage::create_storage` and `CloudStorageConfig::validate`
/// for consistent diagnostics. Frontend dispatch uses the stable code above,
/// never this message.
pub const FTP_UNSUPPORTED_ON_ANDROID_MESSAGE: &str =
    "FTP/FTPS storage is not available on Android.";

/// 当前构建未编入 S3 后端时的稳定 IPC 错误码。
pub const S3_UNSUPPORTED_IN_BUILD_CODE: &str = "E_S3_UNSUPPORTED_IN_BUILD";

/// Stable, user-actionable message for every backend path that rejects S3 on
/// builds compiled without the `cloud_storage_s3` feature (Android
/// `android-release` / `mobile-slim` profiles).
///
/// [R09-android / RESTORE-MATRIX P3-2] The old message told end users to
/// "enable the cloud_storage_s3 feature at compile time" — actionable only
/// for compiler operators. Shared across
/// `cloud_storage::create_storage`, `CloudStorageConfig::validate` and the
/// SSOT save/load paths for consistent diagnostics; frontend dispatch uses
/// `S3_UNSUPPORTED_IN_BUILD_CODE`.
pub const S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE: &str =
    "当前安装包不支持 S3 兼容存储，请改用 WebDAV。";

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudConfigInvalid {
    message: String,
    code: Option<&'static str>,
}

impl CloudConfigInvalid {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    fn platform(code: &'static str, message: &'static str) -> Self {
        Self {
            message: message.to_string(),
            code: Some(code),
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        self.code
    }
}

impl std::fmt::Display for CloudConfigInvalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CloudConfigSsotError {
    #[error("cloud sync is not configured in the backend SSOT")]
    NotConfigured,
    #[error("invalid non-secret cloud configuration: {0}")]
    Invalid(CloudConfigInvalid),
    #[error("cloud configuration storage failed: {0}")]
    Storage(String),
    #[error("cloud credentials are unavailable or incomplete: {0}")]
    CredentialsUnavailable(String),
}

impl CloudConfigSsotError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(CloudConfigInvalid::new(message))
    }

    /// 稳定 IPC 错误码。平台能力错误使用产品约定的 `E_*` code；
    /// 其余 SSOT 错误也提供机器码，避免命令退回纯字符串。
    pub fn stable_code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "E_CLOUD_CONFIG_NOT_CONFIGURED",
            Self::Invalid(error) => error.code().unwrap_or("E_CLOUD_CONFIG_INVALID"),
            Self::Storage(_) => "E_CLOUD_CONFIG_STORAGE",
            Self::CredentialsUnavailable(_) => "E_CLOUD_CREDENTIALS_UNAVAILABLE",
        }
    }

    fn into_command_error(self) -> crate::error_details::CommandError {
        crate::error_details::CommandError::new(self.stable_code(), self.to_string())
    }

    /// FTP can never work on this platform, so neither saving nor loading such
    /// a record is allowed. Carried as `Invalid` (so existing consumers such
    /// as the data-governance tool map it to `CLOUD_CONFIG_INVALID`) with a
    /// message identical to the `create_storage` rejection for diagnostics.
    fn ftp_unsupported_on_platform() -> Self {
        Self::Invalid(CloudConfigInvalid::platform(
            FTP_UNSUPPORTED_ON_ANDROID_CODE,
            FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
        ))
    }

    /// S3 can never work on a build compiled without `cloud_storage_s3`, so
    /// neither saving nor loading such a record is allowed (same zombie-config
    /// reasoning as FTP-on-Android). Message identical to the
    /// `create_storage` / `validate` rejection for diagnostics.
    fn s3_unsupported_in_build() -> Self {
        Self::Invalid(CloudConfigInvalid::platform(
            S3_UNSUPPORTED_IN_BUILD_CODE,
            S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
        ))
    }
}

fn bounded_text(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<String, CloudConfigSsotError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CloudConfigSsotError::invalid(format!(
            "{field} must not be blank"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(CloudConfigSsotError::invalid(format!(
            "{field} exceeds {max_chars} characters"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(CloudConfigSsotError::invalid(format!(
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
        .map_err(|_| CloudConfigSsotError::invalid(format!("{field} must be a valid URL")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(CloudConfigSsotError::invalid(format!(
            "{field} must use http or https and include a host"
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CloudConfigSsotError::invalid(format!(
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
        return Err(CloudConfigSsotError::invalid(
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
        self.validate_and_normalize_with_capabilities(
            crate::cloud_storage::PlatformStorageCapabilities::current(),
        )
    }

    /// 同 `validate_and_normalize`，但显式注入后端能力（测试钩子）：
    /// 宿主机测试可按 Android / mobile-slim 能力矩阵验证保存与加载路径
    /// 对不可用 provider 的 fail-closed 行为。
    fn validate_and_normalize_with_capabilities(
        self,
        capabilities: crate::cloud_storage::PlatformStorageCapabilities,
    ) -> Result<Self, CloudConfigSsotError> {
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
                    return Err(CloudConfigSsotError::invalid(
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
                // Mirror FTP-on-Android: a build without the S3 backend must
                // fail at save AND at load instead of persisting a
                // configuration that can never create storage.
                if !capabilities.s3_supported {
                    return Err(CloudConfigSsotError::s3_unsupported_in_build());
                }
                let (endpoint, parsed) = validated_http_endpoint(&s3.endpoint, "s3.endpoint")?;
                if parsed.scheme() == "http" && !parsed.host_str().is_some_and(is_loopback_host) {
                    return Err(CloudConfigSsotError::invalid(
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
                // Mirror `create_storage`: Android has no FTP backend, so an
                // FTP record must fail at save AND at load instead of
                // persisting a configuration that can never validate.
                if !capabilities.ftp_supported {
                    return Err(CloudConfigSsotError::ftp_unsupported_on_platform());
                }
                if ftp.port == 0 {
                    return Err(CloudConfigSsotError::invalid(
                        "ftp.port must be between 1 and 65535".to_string(),
                    ));
                }
                let host = bounded_text(&ftp.host, "ftp.host", MAX_ENDPOINT_CHARS)?;
                if host.contains("://")
                    || host.contains('/')
                    || host.contains('@')
                    || host.contains(char::is_whitespace)
                {
                    return Err(CloudConfigSsotError::invalid(
                        "ftp.host must be a hostname or IP address without scheme or credentials"
                            .to_string(),
                    ));
                }
                let insecure = !ftp.use_tls && !is_loopback_host(&host);
                if insecure && !allow_insecure {
                    return Err(CloudConfigSsotError::invalid(
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
    save_cloud_config_ssot_with_capabilities(
        database,
        config,
        crate::cloud_storage::PlatformStorageCapabilities::current(),
    )
}

/// 同 [`save_cloud_config_ssot`]，显式注入后端能力（测试钩子，行为等价）。
pub fn save_cloud_config_ssot_with_capabilities(
    database: &crate::database::Database,
    config: SafeCloudStorageConfig,
    capabilities: crate::cloud_storage::PlatformStorageCapabilities,
) -> Result<SafeCloudStorageConfig, CloudConfigSsotError> {
    let config = config.validate_and_normalize_with_capabilities(capabilities)?;
    let encoded = serde_json::to_string(&config)
        .map_err(|_| CloudConfigSsotError::invalid("configuration is not serializable"))?;
    if encoded.len() > MAX_STORED_CONFIG_BYTES {
        return Err(CloudConfigSsotError::invalid(
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
    load_cloud_config_ssot_with_capabilities(
        database,
        crate::cloud_storage::PlatformStorageCapabilities::current(),
    )
}

/// 同 [`load_cloud_config_ssot`]，显式注入后端能力（测试钩子，行为等价）。
pub fn load_cloud_config_ssot_with_capabilities(
    database: &crate::database::Database,
    capabilities: crate::cloud_storage::PlatformStorageCapabilities,
) -> Result<SafeCloudStorageConfig, CloudConfigSsotError> {
    let encoded = database
        .get_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()))?
        .ok_or(CloudConfigSsotError::NotConfigured)?;
    if encoded.len() > MAX_STORED_CONFIG_BYTES {
        return Err(CloudConfigSsotError::invalid(
            "stored configuration is too large".to_string(),
        ));
    }
    let config = serde_json::from_str::<SafeCloudStorageConfig>(&encoded)
        .map_err(|_| CloudConfigSsotError::invalid("stored configuration is malformed"))?
        .validate_and_normalize_with_capabilities(capabilities)?;
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
        .map_err(|error| CloudConfigSsotError::CredentialsUnavailable(error.to_string()))?;
    Ok(config)
}

#[tauri::command]
pub async fn cloud_config_ssot_save(
    state: tauri::State<'_, crate::commands::AppState>,
    config: SafeCloudStorageConfig,
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
    let config = save_cloud_config_ssot(&state.database, config)
        .map_err(CloudConfigSsotError::into_command_error)?;
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
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
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
        Err(error) => Err(error.into_command_error()),
    }
}

// ============================================================================
// [Wave2-D R2] 草稿测试 / 事务化发布（draft → test → publish 状态机后端面）
// ============================================================================
//
// 消费 agent 3 在 `secure_store.rs` 落地的 staged-generation 凭据 API
// （`SecureStore` 方法）：
// - `cloud_credentials_active_generation()`：只读；pointer key 缺失 = 0。
// - `write_staged_cloud_credentials(update, preexisting)`：合并写 staged 槽
//   （active 与 pointer 不变），返回 staged generation（= active + 1），
//   即后续 commit / abort 的 `expected_generation` 句柄。
// - `commit_staged_cloud_credentials(expected)`：staged → active 原子提升，
//   幂等可重放；成功后 active generation == expected。
// - `abort_staged_cloud_credentials(expected)`：按句柄丢弃 staged，幂等。
// - `delete_cloud_credentials_transactional()`：三记录快照+删除，内部失败
//   自恢复；不导出恢复句柄，故 clear 的跨库恢复用本文件自持的凭据快照。

/// 草稿连接测试失败（网络/认证/服务器侧）的稳定 IPC 错误码。
pub const CLOUD_CONNECTION_CHECK_FAILED_CODE: &str = "E_CLOUD_CONNECTION_CHECK_FAILED";

/// 与 secure_store 私有 `get_secure_store` 等价的实例构造（该 fn 私有且
/// secure_store.rs 本轮禁改，构造路径 `new_with_dir` / `new` 均为 pub）。
fn cloud_secure_store(app: &tauri::AppHandle) -> crate::secure_store::SecureStore {
    use tauri::Manager as _;
    let config = crate::secure_store::SecureStoreConfig::default();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        return crate::secure_store::SecureStore::new_with_dir(config, app_data_dir);
    }
    crate::secure_store::SecureStore::new(config)
}

/// [`SecureStoreError`](crate::secure_store::SecureStoreError) 的稳定 code 映射。
///
/// `SecureStoreError::stable_code` / `to_command_error` 是 secure_store 的私有
/// 方法且本轮禁改该文件，故在命令面复刻同一张 code 表（前端契约不变）。
fn secure_store_stable_code(error: &crate::secure_store::SecureStoreError) -> &'static str {
    use crate::secure_store::SecureStoreError;
    match error {
        SecureStoreError::KeychainUnavailable(_) | SecureStoreError::PlatformUnsupported(_) => {
            "SECURE_STORE_UNAVAILABLE"
        }
        SecureStoreError::KeyNotFound(_) => "SECURE_STORE_KEY_NOT_FOUND",
        SecureStoreError::AccessDenied(_) => "SECURE_STORE_ACCESS_DENIED",
        SecureStoreError::SerializationError(_) => "SECURE_STORE_DATA_INVALID",
        SecureStoreError::EncryptionError(_) => "SECURE_STORE_CRYPTO_ERROR",
        SecureStoreError::CloudEncryptionPasswordTooShort(_) => {
            crate::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE
        }
        // [Wave2-R5] 新设弱口令是用户输入问题，不是密钥库故障：缺这一臂会
        // 落进 `SECURE_STORE_INTERNAL`，前端据此误报「系统安全存储需要处理」。
        SecureStoreError::CloudEncryptionPasswordTooWeak(_) => {
            crate::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE
        }
        SecureStoreError::CloudCredentialGenerationConflict(_) => {
            crate::secure_store::CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE
        }
        _ => "SECURE_STORE_INTERNAL",
    }
}

fn secure_store_command_error(
    error: crate::secure_store::SecureStoreError,
    operation: &'static str,
) -> crate::error_details::CommandError {
    crate::error_details::CommandError::new(secure_store_stable_code(&error), error.to_string())
        .with_data(serde_json::json!({ "operation": operation }))
}

/// 云存储层 [`AppError`](crate::models::AppError) → `CommandError`。
///
/// 平台能力错误（`create_storage` / `validate` 注入的
/// `details.code`，如 [`FTP_UNSUPPORTED_ON_ANDROID_CODE`] /
/// [`S3_UNSUPPORTED_IN_BUILD_CODE`]）沿用其稳定 code；其余用调用方给的兜底码。
fn cloud_app_error_to_command_error(
    error: crate::models::AppError,
    fallback_code: &'static str,
) -> crate::error_details::CommandError {
    let code = error
        .details
        .as_ref()
        .and_then(|details| details.get("code"))
        .and_then(|code| code.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_code.to_string());
    crate::error_details::CommandError::new(code, error.message)
}

/// 新设短口令 fail-closed 门（复用 secure_store 的既有准入规则与稳定 code）。
///
/// `encryption_password_is_preexisting = true`（存量口令：换机重输 / legacy
/// 迁移）放行任意非空长度，与 `update_cloud_credentials_with_policy` 一致。
fn reject_short_new_encryption_password(
    credentials: &crate::secure_store::CloudStorageCredentials,
    encryption_password_is_preexisting: bool,
) -> Result<(), crate::error_details::CommandError> {
    if !encryption_password_is_preexisting
        && crate::secure_store::cloud_encryption_password_too_short(
            credentials.encryption_password.as_deref(),
        )
    {
        return Err(crate::error_details::CommandError::new(
            crate::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
            crate::secure_store::cloud_encryption_password_too_short_message(),
        ));
    }
    Ok(())
}

/// 把请求携带的草稿凭据直接填入 runtime 配置。
///
/// 与 `hydrate_cloud_config` 相反：**绝不**触碰安全存储（不读不写），secret
/// 只来自本次 IPC 载荷。空/空白字段保持空串，交给
/// `CloudStorageConfig::validate` fail-closed。
fn apply_draft_credentials(
    config: &mut CloudStorageConfig,
    credentials: &crate::secure_store::CloudStorageCredentials,
) {
    fn nonempty(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|value| !value.is_empty())
    }
    if let Some(webdav) = config.webdav.as_mut() {
        if let Some(password) = nonempty(credentials.webdav_password.as_deref()) {
            webdav.password = password.to_string();
        }
    }
    if let Some(s3) = config.s3.as_mut() {
        if let Some(secret) = nonempty(credentials.s3_secret_access_key.as_deref()) {
            s3.secret_access_key = secret.to_string();
        }
    }
    if let Some(ftp) = config.ftp.as_mut() {
        if let Some(password) = nonempty(credentials.ftp_password.as_deref()) {
            ftp.password = password.to_string();
        }
    }
    config.encryption_password =
        nonempty(credentials.encryption_password.as_deref()).map(str::to_string);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfigDraftTestResponse {
    pub ok: bool,
    /// 当前 active 凭据 generation。本命令只读，绝不 bump。
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfigPublishResponse {
    pub ok: bool,
    /// 提交成功后的新 active generation。
    pub generation: u64,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub config: SafeCloudStorageConfig,
}

/// 草稿连接测试：用**请求里的凭据**直接试连，零持久化副作用。
///
/// 与 `cloud_storage_check_connection`（cloud_storage/mod.rs，入口即
/// `hydrate_cloud_config`，只能测「已发布」的配置）不同，本命令：
/// - 不读安全存储、不写 SSOT、不写任何 secret、不 bump generation；
/// - 非敏感字段走与保存完全相同的 `validate_and_normalize`（平台能力码一致）；
/// - 新设短口令 fail-closed（`E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT`），
///   `encryptionPasswordIsPreexisting: true` 的存量口令放行。
///
/// 成功返回 `{ ok: true, generation }`，generation 为当前 active 值（未变），
/// 供前端在随后的 `cloud_config_publish` 前检测并发变更。
#[tauri::command]
pub async fn cloud_config_test_connection_draft(
    app: tauri::AppHandle,
    config: SafeCloudStorageConfig,
    credentials: crate::secure_store::CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudConfigDraftTestResponse, crate::error_details::CommandError> {
    reject_short_new_encryption_password(
        &credentials,
        encryption_password_is_preexisting.unwrap_or(false),
    )?;

    // 与 save 同一套非敏感校验/规范化：平台能力（Android FTP / 无 S3 构建）
    // 在此以既有稳定码拒绝，公网明文运输沿用 allowInsecure 准入。
    let config = config
        .validate_and_normalize()
        .map_err(CloudConfigSsotError::into_command_error)?;

    let mut runtime = config.into_runtime_config();
    apply_draft_credentials(&mut runtime, &credentials);
    runtime.validate().map_err(|error| match error.code() {
        Some(code) => crate::error_details::CommandError::new(code, error.to_string()),
        // 规范化已通过，剩余失败面基本是「草稿缺少必需凭据」。
        None => crate::error_details::CommandError::new(
            "E_CLOUD_CREDENTIALS_UNAVAILABLE",
            error.to_string(),
        ),
    })?;

    let storage = crate::cloud_storage::create_storage(&runtime)
        .await
        .map_err(|error| cloud_app_error_to_command_error(error, "E_CLOUD_CONFIG_INVALID"))?;
    storage.check_connection().await.map_err(|error| {
        cloud_app_error_to_command_error(error, CLOUD_CONNECTION_CHECK_FAILED_CODE)
    })?;

    // 只读探测 active generation（pointer key 缺失 = 0）。不写任何 secret。
    let generation = cloud_secure_store(&app)
        .cloud_credentials_active_generation()
        .map_err(|error| {
            secure_store_command_error(error, "cloud_credentials_active_generation")
        })?;

    Ok(CloudConfigDraftTestResponse {
        ok: true,
        generation,
    })
}

/// 事务化发布：staged 凭据 + SSOT 两段写，任一失败回到旧 generation/旧 SSOT。
///
/// 算法（所有失败路径都保持旧 active generation 不变）：
/// 1. 短口令门（同草稿测试，先于任何写入）；
/// 2. snapshot 当前 SSOT 原始记录（raw 字节，NotConfigured 当 None——用 raw
///    而非 parsed load，保证旧记录即使已不再通过当前校验也能按原样恢复）；
/// 3. 非敏感配置 `validate_and_normalize` 预检（失败则连 staged 都不写）；
/// 4. `write_staged_cloud_credentials`（active 不变），拿 expected generation；
/// 5. `save_cloud_config_ssot`；失败 → `abort_staged_cloud_credentials`，
///    返回错（旧 SSOT 未变）；
/// 6. `commit_staged_cloud_credentials(expected)`；失败 → 把 SSOT 恢复为
///    snapshot（有则 save 旧值，无则 delete setting），再 abort staged，返回错。
///
/// `cloud_config_ssot_save` 保持原行为（迁移/内部旧入口）；前端新状态机改用
/// 草稿测试 + 本命令。
#[tauri::command]
pub async fn cloud_config_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    config: SafeCloudStorageConfig,
    credentials: crate::secure_store::CloudStorageCredentials,
    encryption_password_is_preexisting: Option<bool>,
) -> Result<CloudConfigPublishResponse, crate::error_details::CommandError> {
    reject_short_new_encryption_password(
        &credentials,
        encryption_password_is_preexisting.unwrap_or(false),
    )?;

    // (a) raw SSOT snapshot；读失败即中止（什么都没写）。
    let ssot_snapshot = state
        .database
        .get_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()).into_command_error())?;

    // 非敏感预检：无效草稿绝不进入 staged 写。
    let config = config
        .validate_and_normalize()
        .map_err(CloudConfigSsotError::into_command_error)?;

    // [R6 I3 护栏] 合并后凭据必须含当前 provider 的 secret。否则（草稿空 +
    // active 也空）staged 合并结果无任何 secret，commit 会删除 active 记录却
    // 仍把 generation pointer 推到 N+1——发布出「SSOT 已配置 + generation
    // 指向空凭据记录」的杂交视图。判定镜像 `apply_nonempty_update` 的
    // trim-非空合并语义：update 非空生效，否则落回 active 现值。
    let store = cloud_secure_store(&app);
    let active_credentials = store
        .get_cloud_credentials()
        .map_err(|error| secure_store_command_error(error, "get_cloud_credentials"))?
        .unwrap_or_default();
    let nonempty = |value: Option<&str>| value.map(str::trim).is_some_and(|v| !v.is_empty());
    let provider_secret_present = match &config {
        SafeCloudStorageConfig::Webdav { .. } => {
            nonempty(credentials.webdav_password.as_deref())
                || nonempty(active_credentials.webdav_password.as_deref())
        }
        SafeCloudStorageConfig::S3 { .. } => {
            nonempty(credentials.s3_secret_access_key.as_deref())
                || nonempty(active_credentials.s3_secret_access_key.as_deref())
        }
        SafeCloudStorageConfig::Ftp { .. } => {
            nonempty(credentials.ftp_password.as_deref())
                || nonempty(active_credentials.ftp_password.as_deref())
        }
    };
    if !provider_secret_present {
        return Err(CloudConfigSsotError::CredentialsUnavailable(format!(
            "发布被拒绝：{} 凭据在草稿与已发布记录中均为空，发布后的 generation 将指向空凭据",
            config.provider_name()
        ))
        .into_command_error());
    }

    // (b) 凭据进 staged 槽；active 记录与 generation pointer 不变。返回的
    // staged generation（= active + 1）即 commit/abort 的 expected 句柄，
    // 也是提交成功后的新 active generation。
    let staged_generation = store
        .write_staged_cloud_credentials(
            &credentials,
            encryption_password_is_preexisting.unwrap_or(false),
        )
        .map_err(|error| secure_store_command_error(error, "write_staged_cloud_credentials"))?;

    // (c)/(d) 发布非敏感 SSOT；失败则丢弃 staged，旧 SSOT 未被触碰。
    let config = match save_cloud_config_ssot(&state.database, config) {
        Ok(config) => config,
        Err(error) => {
            if let Err(abort_error) = store.abort_staged_cloud_credentials(staged_generation) {
                tracing::warn!(
                    "发布失败后丢弃 staged 凭据失败（active 未受影响）: {}",
                    abort_error
                );
            }
            return Err(error.into_command_error());
        }
    };

    // (e)/(f) staged → active 原子提升；失败则恢复 SSOT snapshot 再丢弃 staged。
    if let Err(error) = store.commit_staged_cloud_credentials(staged_generation) {
        let restored = match &ssot_snapshot {
            Some(encoded) => state
                .database
                .save_setting(CLOUD_CONFIG_SSOT_SETTING_KEY, encoded),
            None => state
                .database
                .delete_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
                .map(|_| ()),
        };
        if let Err(restore_error) = &restored {
            tracing::warn!(
                "提交凭据失败且 SSOT 恢复失败（凭据仍为旧 generation）: {}",
                restore_error
            );
        }
        if let Err(abort_error) = store.abort_staged_cloud_credentials(staged_generation) {
            tracing::warn!("提交失败后丢弃 staged 凭据失败: {}", abort_error);
        }
        return Err(crate::error_details::CommandError::new(
            secure_store_stable_code(&error),
            error.to_string(),
        )
        .with_data(serde_json::json!({
            "operation": "commit_staged_cloud_credentials",
            "ssotRestored": restored.is_ok(),
        })));
    }
    let generation = staged_generation;

    Ok(CloudConfigPublishResponse {
        ok: true,
        generation,
        provider: config.provider_name().to_string(),
        root: config.root().map(str::to_string),
        config,
    })
}

/// 清除云配置：先事务性删除凭据，再删非敏感 SSOT 记录。
///
/// [Wave2-D R2] 顺序与旧实现相反（旧：先删 SSOT、后删凭据，第二步失败留下
/// 「SSOT 已空、凭据残留」的孤儿 secret）。新顺序保证任何失败路径都不会留下
/// 无 SSOT 配对的凭据：
/// 1. 先读一次 SSOT（fail-early：设置库连读都失败时，两条记录都不动），并
///    快照当前凭据记录（`delete_cloud_credentials_transactional` 的内部快照
///    只覆盖它自己失败时的自恢复，不导出恢复句柄，跨库恢复须自持副本）；
/// 2. `delete_cloud_credentials_transactional` 删除凭据（active + staged +
///    generation pointer，内部失败自恢复并上抛）；
/// 3. 删 SSOT；若失败，用步骤 1 的凭据快照 best-effort 恢复 active 记录
///    （generation pointer 无 pub 恢复口，重置为缺失 = 0 = legacy 语义，读
///    路径不受影响；恢复结果在 `data.credentialsRestored` 里如实上报）。
///
/// 错误通道从 `String` 收敛为 [`crate::error_details::CommandError`]（稳定
/// code）。成功返回形状不变（空 `CloudConfigSsotResponse`），前端 `clearConfig`
/// 对 rejection 只做泛化 catch，兼容。
#[tauri::command]
pub async fn cloud_config_ssot_clear(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<CloudConfigSsotResponse, crate::error_details::CommandError> {
    // Fail-early snapshot read: if the settings layer cannot even be read we
    // must not start deleting credentials we could never pair with an SSOT
    // delete afterwards.
    let _ssot_snapshot = state
        .database
        .get_setting(CLOUD_CONFIG_SSOT_SETTING_KEY)
        .map_err(|error| CloudConfigSsotError::Storage(error.to_string()).into_command_error())?;

    let store = cloud_secure_store(&app);
    // 凭据快照仅驻留本调用栈，用于步骤 3 失败时的 best-effort 恢复。
    let credentials_snapshot = store
        .get_cloud_credentials()
        .map_err(|error| secure_store_command_error(error, "cloud_config_ssot_clear"))?;

    // Step 1: delete secrets first (transactional: snapshots then deletes
    // active + staged + generation pointer, self-restoring on its own failure).
    store
        .delete_cloud_credentials_transactional()
        .map_err(|error| {
            secure_store_command_error(error, "delete_cloud_credentials_transactional")
        })?;

    // Step 2: delete the non-secret SSOT record; on failure restore the
    // credential record so the old state survives intact.
    if let Err(error) = state.database.delete_setting(CLOUD_CONFIG_SSOT_SETTING_KEY) {
        let restored = match &credentials_snapshot {
            Some(snapshot) => store.save_cloud_credentials(snapshot),
            None => Ok(()),
        };
        if let Err(restore_error) = &restored {
            tracing::warn!(
                "清除云配置失败且凭据恢复失败（凭据已删、SSOT 残留）: {}",
                restore_error
            );
        }
        return Err(crate::error_details::CommandError::new(
            "E_CLOUD_CONFIG_STORAGE",
            CloudConfigSsotError::Storage(error.to_string()).to_string(),
        )
        .with_data(serde_json::json!({
            "operation": "cloud_config_ssot_clear",
            "credentialsRestored": restored.is_ok(),
        })));
    }

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

    fn ftp(host: &str, use_tls: bool, allow_insecure: bool) -> SafeCloudStorageConfig {
        SafeCloudStorageConfig::Ftp {
            ftp: SafeFtpConfig {
                host: host.to_string(),
                port: 21,
                username: "student".to_string(),
                use_tls,
            },
            root: None,
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
        let config = ftp("ftp.security-contract.test", false, true);

        let stored = save_cloud_config_ssot(&database, config).expect("persist FTP opt-in");
        let mut runtime = stored.into_runtime_config();
        assert!(runtime.insecure_transport_authorized);
        runtime.ftp.as_mut().unwrap().password = "secret".to_string();
        assert!(runtime.validate().is_ok());
    }

    #[test]
    fn ftp_platform_error_has_stable_code_and_shared_diagnostic() {
        assert_eq!(
            FTP_UNSUPPORTED_ON_ANDROID_MESSAGE, "FTP/FTPS storage is not available on Android.",
            "shared diagnostic must remain user-readable; dispatch uses code",
        );
        let error = CloudConfigSsotError::ftp_unsupported_on_platform();
        assert!(matches!(&error, CloudConfigSsotError::Invalid(_)));
        assert_eq!(error.stable_code(), FTP_UNSUPPORTED_ON_ANDROID_CODE);
        assert!(
            error
                .to_string()
                .contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE),
            "the IPC string must contain the mappable create_storage message"
        );

        let envelope = error.into_command_error();
        assert_eq!(envelope.code, FTP_UNSUPPORTED_ON_ANDROID_CODE);
        assert!(
            envelope
                .message
                .contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE),
            "message remains diagnostic, but frontend dispatches only by code"
        );
    }

    #[test]
    fn s3_platform_error_has_stable_code_independent_of_message() {
        let error = CloudConfigSsotError::s3_unsupported_in_build();
        assert_eq!(error.stable_code(), S3_UNSUPPORTED_IN_BUILD_CODE);
        let envelope = error.into_command_error();
        assert_eq!(envelope.code, S3_UNSUPPORTED_IN_BUILD_CODE);
        assert!(envelope
            .message
            .contains(S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE));
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_rejects_ftp_on_save_and_persists_nothing() {
        let (_dir, database) = test_database();
        let denied = save_cloud_config_ssot(&database, ftp("ftp.example.test", true, false))
            .expect_err("FTP must not be persistable on Android");
        assert_eq!(denied, CloudConfigSsotError::ftp_unsupported_on_platform());
        assert!(denied
            .to_string()
            .contains(FTP_UNSUPPORTED_ON_ANDROID_MESSAGE));
        assert!(
            matches!(
                load_cloud_config_ssot(&database),
                Err(CloudConfigSsotError::NotConfigured)
            ),
            "a rejected save must leave the SSOT empty"
        );
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_rejects_stored_ftp_record_on_load() {
        let (_dir, database) = test_database();
        let encoded = r#"{
            "provider":"ftp",
            "ftp":{"host":"ftp.example.test","port":21,"username":"student","useTls":true}
        }"#;
        database
            .save_setting(CLOUD_CONFIG_SSOT_SETTING_KEY, encoded)
            .expect("seed a desktop-written FTP record");
        assert_eq!(
            load_cloud_config_ssot(&database)
                .expect_err("desktop-written FTP records must fail closed on Android"),
            CloudConfigSsotError::ftp_unsupported_on_platform(),
        );
    }
}
