//! 云存储配置结构
//!
//! 支持 WebDAV 和 S3 兼容存储的统一配置

use serde::{Deserialize, Serialize};

/// 存储提供商类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageProvider {
    /// WebDAV 存储（如坚果云、Nextcloud、自建 WebDAV）
    WebDav,
    /// S3 兼容存储（AWS S3、Cloudflare R2、阿里云 OSS、MinIO 等）
    S3,
}

impl Default for StorageProvider {
    fn default() -> Self {
        StorageProvider::WebDav
    }
}

impl std::fmt::Display for StorageProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageProvider::WebDav => write!(f, "WebDAV"),
            StorageProvider::S3 => write!(f, "S3"),
        }
    }
}

/// WebDAV 配置
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    /// WebDAV 服务器地址（如 https://dav.jianguoyun.com/dav/）
    pub endpoint: String,
    /// 用户名
    pub username: String,
    /// 密码或应用专用密码
    pub password: String,
}

impl std::fmt::Debug for WebDavConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfig")
            .field("endpoint", &self.endpoint)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

/// S3 兼容存储配置
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    /// S3 endpoint URL
    /// - AWS S3: https://s3.{region}.amazonaws.com
    /// - Cloudflare R2: https://{account_id}.r2.cloudflarestorage.com
    /// - 阿里云 OSS: https://oss-{region}.aliyuncs.com
    /// - MinIO: http://localhost:9000
    pub endpoint: String,
    /// 存储桶名称
    pub bucket: String,
    /// Access Key ID
    pub access_key_id: String,
    /// Secret Access Key
    pub secret_access_key: String,
    /// 区域（可选，某些 S3 兼容服务不需要）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// 是否使用 path-style 地址（MinIO、某些 S3 兼容服务需要）
    /// 默认 false 使用 virtual-hosted-style
    #[serde(default)]
    pub path_style: bool,
}

impl std::fmt::Debug for S3Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field(
                "access_key_id",
                &format!("{}...", self.access_key_id.get(..4).unwrap_or("?")),
            )
            .field("secret_access_key", &"[REDACTED]")
            .field("region", &self.region)
            .field("path_style", &self.path_style)
            .finish()
    }
}

/// 统一的云存储配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageConfig {
    /// 存储提供商类型
    #[serde(default)]
    pub provider: StorageProvider,
    /// WebDAV 配置（当 provider 为 WebDav 时使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav: Option<WebDavConfig>,
    /// S3 配置（当 provider 为 S3 时使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<S3Config>,
    /// 根目录路径（所有操作都在此目录下）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

impl CloudStorageConfig {
    /// 获取根目录路径，默认为 "deep-student-sync"
    pub fn root(&self) -> String {
        self.root
            .as_deref()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or("deep-student-sync")
            .trim_matches('/')
            .to_string()
    }

    /// 验证配置是否完整
    pub fn validate(&self) -> Result<(), String> {
        match self.provider {
            StorageProvider::WebDav => {
                let config = self.webdav.as_ref().ok_or("缺少 WebDAV 配置")?;
                if config.endpoint.trim().is_empty() {
                    return Err("WebDAV endpoint 不能为空".into());
                }
                if config.username.trim().is_empty() {
                    return Err("WebDAV 用户名不能为空".into());
                }
                let endpoint_lower = config.endpoint.trim().to_lowercase();
                let is_local = endpoint_lower.contains("://localhost")
                    || endpoint_lower.contains("://127.0.0.1")
                    || endpoint_lower.contains("://[::1]");
                if !is_local && !endpoint_lower.starts_with("https://") {
                    return Err(
                        "WebDAV endpoint 必须使用 HTTPS（仅 localhost 允许 HTTP）".into(),
                    );
                }
                Ok(())
            }
            StorageProvider::S3 => {
                let config = self.s3.as_ref().ok_or("缺少 S3 配置")?;
                if config.endpoint.trim().is_empty() {
                    return Err("S3 endpoint 不能为空".into());
                }
                if config.bucket.trim().is_empty() {
                    return Err("S3 bucket 不能为空".into());
                }
                if config.access_key_id.trim().is_empty() {
                    return Err("S3 Access Key ID 不能为空".into());
                }
                if config.secret_access_key.trim().is_empty() {
                    return Err("S3 Secret Access Key 不能为空".into());
                }
                let endpoint_lower = config.endpoint.trim().to_lowercase();
                let is_local = endpoint_lower.contains("://localhost")
                    || endpoint_lower.contains("://127.0.0.1")
                    || endpoint_lower.contains("://[::1]");
                if !is_local && !endpoint_lower.starts_with("https://") {
                    return Err(
                        "S3 endpoint 必须使用 HTTPS（仅 localhost 允许 HTTP）".into(),
                    );
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_validation() {
        // WebDAV 配置验证
        let mut config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "https://dav.example.com".into(),
                username: "user".into(),
                password: "pass".into(),
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok());

        // 缺少 endpoint
        config.webdav.as_mut().unwrap().endpoint = "".into();
        assert!(config.validate().is_err());

        // S3 配置验证
        let config = CloudStorageConfig {
            provider: StorageProvider::S3,
            s3: Some(S3Config {
                endpoint: "https://s3.amazonaws.com".into(),
                bucket: "my-bucket".into(),
                access_key_id: "AKID".into(),
                secret_access_key: "SECRET".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_https_enforcement_webdav() {
        let config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "http://dav.example.com".into(),
                username: "user".into(),
                password: "pass".into(),
            }),
            ..Default::default()
        };
        assert!(config.validate().is_err(), "HTTP WebDAV should be rejected");

        let config = CloudStorageConfig {
            provider: StorageProvider::WebDav,
            webdav: Some(WebDavConfig {
                endpoint: "http://localhost:8080/dav".into(),
                username: "user".into(),
                password: "pass".into(),
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok(), "localhost HTTP should be allowed");
    }

    #[test]
    fn test_https_enforcement_s3() {
        let config = CloudStorageConfig {
            provider: StorageProvider::S3,
            s3: Some(S3Config {
                endpoint: "http://s3.example.com".into(),
                bucket: "b".into(),
                access_key_id: "AK".into(),
                secret_access_key: "SK".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(config.validate().is_err(), "HTTP S3 should be rejected");

        let config = CloudStorageConfig {
            provider: StorageProvider::S3,
            s3: Some(S3Config {
                endpoint: "http://localhost:9000".into(),
                bucket: "b".into(),
                access_key_id: "AK".into(),
                secret_access_key: "SK".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(config.validate().is_ok(), "localhost HTTP S3 should be allowed");
    }

    #[test]
    fn test_debug_redaction() {
        let webdav = WebDavConfig {
            endpoint: "https://dav.example.com".into(),
            username: "user".into(),
            password: "super-secret".into(),
        };
        let debug = format!("{:?}", webdav);
        assert!(!debug.contains("super-secret"), "password should be redacted in Debug");
        assert!(debug.contains("[REDACTED]"));

        let s3 = S3Config {
            endpoint: "https://s3.example.com".into(),
            bucket: "b".into(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            ..Default::default()
        };
        let debug = format!("{:?}", s3);
        assert!(!debug.contains("wJalrXUtnFEMI"), "secret_access_key should be redacted");
        assert!(debug.contains("[REDACTED]"));
        assert!(debug.contains("AKIA"), "access_key_id prefix should be visible");
    }

    #[test]
    fn test_default_root() {
        let config = CloudStorageConfig::default();
        assert_eq!(config.root(), "deep-student-sync");

        let config = CloudStorageConfig {
            root: Some("  /custom/path/  ".into()),
            ..Default::default()
        };
        assert_eq!(config.root(), "custom/path");
    }
}
