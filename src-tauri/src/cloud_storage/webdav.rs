//! WebDAV 存储实现
//!
//! 基于 reqwest 的 WebDAV 客户端，支持坚果云、Nextcloud 等服务

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use super::config::WebDavConfig;
use super::traits::{
    CloudStorage, DownloadProgressCallback, FileInfo, Result, UploadProgressCallback,
};
use crate::backup_common::calculate_file_hash;
use crate::models::AppError;

/// WebDAV 存储实现
pub struct WebDavStorage {
    base_url: Url,
    username: String,
    password: String,
    root: String,
    http: Client,
}

impl WebDavStorage {
    /// 创建 WebDAV 存储实例
    pub fn new(config: WebDavConfig, root: String) -> Result<Self> {
        if config.endpoint.trim().is_empty() {
            return Err(AppError::validation("WebDAV endpoint 不能为空"));
        }

        let url = Url::parse(config.endpoint.trim())
            .map_err(|e| AppError::configuration(format!("无效的 WebDAV endpoint: {e}")))?;

        let is_local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if !is_local && url.scheme() != "https" {
            return Err(AppError::configuration(
                "WebDAV endpoint 必须使用 HTTPS 以保护 Basic Auth 凭据（仅 localhost 允许 HTTP）"
                    .to_string(),
            ));
        }

        let http = Client::builder()
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(30))
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .build()
            .map_err(|e| AppError::internal(format!("构建 HTTP 客户端失败: {e}")))?;

        Ok(Self {
            base_url: url,
            username: config.username,
            password: config.password,
            root: root.trim_matches('/').to_string(),
            http,
        })
    }

    /// 构建 Basic 认证头
    fn auth_header(&self) -> String {
        let raw = format!("{}:{}", self.username, self.password);
        format!("Basic {}", general_purpose::STANDARD.encode(raw))
    }

    /// 构建完整 URL
    fn build_url(&self, key: &str) -> Result<Url> {
        let mut url = self.base_url.clone();
        let mut path = url.path().trim_end_matches('/').to_string();
        if !path.ends_with('/') {
            path.push('/');
        }
        path.push_str(&self.root);
        if !path.ends_with('/') {
            path.push('/');
        }
        let key_part = key.trim_start_matches('/');
        path.push_str(key_part);
        url.set_path(&path);
        Ok(url)
    }

    fn mkcol_method() -> Result<Method> {
        Method::from_bytes(b"MKCOL")
            .map_err(|e| AppError::internal(format!("无效 WebDAV 方法 MKCOL: {e}")))
    }

    fn propfind_method() -> Result<Method> {
        Method::from_bytes(b"PROPFIND")
            .map_err(|e| AppError::internal(format!("无效 WebDAV 方法 PROPFIND: {e}")))
    }

    /// 发送 HTTP 请求（带重试）
    async fn request(
        &self,
        method: Method,
        key: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        let url = self.build_url(key)?;
        let max_retries = 3;
        let mut last_error = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = std::time::Duration::from_millis(500 * (1 << attempt));
                tokio::time::sleep(delay).await;
                tracing::debug!("WebDAV {} 重试 {}/{}", method, attempt + 1, max_retries);
            }

            let builder = self
                .http
                .request(method.clone(), url.clone())
                .header("Authorization", self.auth_header());

            let builder = if let Some(ref b) = body {
                builder.body(b.clone())
            } else {
                builder
            };

            match builder.send().await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    last_error = Some(e);
                    if attempt == max_retries - 1 {
                        break;
                    }
                }
            }
        }

        Err(AppError::network(format!(
            "WebDAV {} 请求失败（已重试 {} 次）: {}",
            method,
            max_retries,
            last_error.map(|e| e.to_string()).unwrap_or_default()
        )))
    }

    /// 确保目录存在（递归创建）
    async fn ensure_directory(&self, path: &str) -> Result<()> {
        let parts: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();

        let mut current = String::new();
        for part in parts {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(part);

            // MKCOL 创建目录
            let res = self
                .request(Self::mkcol_method()?, &format!("{}/", current), None)
                .await?;

            // 405 METHOD_NOT_ALLOWED 或 409 CONFLICT 表示目录已存在，可以忽略
            if !matches!(
                res.status(),
                StatusCode::OK
                    | StatusCode::CREATED
                    | StatusCode::METHOD_NOT_ALLOWED
                    | StatusCode::CONFLICT
            ) {
                // 不是致命错误，目录可能已存在
                tracing::debug!("WebDAV MKCOL {} 返回 {}", current, res.status());
            }
        }
        Ok(())
    }

    /// 解析 PROPFIND 响应获取文件列表（使用 roxmltree 安全解析，防止 XXE 注入）
    fn parse_propfind_response(&self, xml: &str, prefix: &str) -> Vec<FileInfo> {
        let doc = match roxmltree::Document::parse(xml) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("WebDAV PROPFIND XML 解析失败: {e}");
                return Vec::new();
            }
        };

        let dav_ns = "DAV:";
        let mut files = Vec::new();

        for response in doc
            .descendants()
            .filter(|n| n.has_tag_name((dav_ns, "response")))
        {
            let href = response
                .descendants()
                .find(|n| n.has_tag_name((dav_ns, "href")))
                .and_then(|n| n.text())
                .unwrap_or_default();

            if href.ends_with('/') {
                continue;
            }

            let key = self.extract_relative_key(href, prefix);
            if key.is_empty() {
                continue;
            }

            let size = response
                .descendants()
                .find(|n| n.has_tag_name((dav_ns, "getcontentlength")))
                .and_then(|n| n.text())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);

            let modified = response
                .descendants()
                .find(|n| n.has_tag_name((dav_ns, "getlastmodified")))
                .and_then(|n| n.text())
                .and_then(|s| {
                    DateTime::parse_from_rfc2822(s)
                        .map(|dt| dt.with_timezone(&Utc))
                        .ok()
                })
                .unwrap_or_else(|| DateTime::<Utc>::from(std::time::UNIX_EPOCH));

            files.push(FileInfo {
                key,
                size,
                last_modified: modified,
                etag: None,
            });
        }

        files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        files
    }

    fn extract_relative_key(&self, href: &str, prefix: &str) -> String {
        // URL 解码
        let decoded = urlencoding::decode(href).unwrap_or_else(|_| href.into());

        // 提取 root 之后的路径
        let root_path = format!("/{}/", self.root);
        if let Some(idx) = decoded.find(&root_path) {
            let relative = &decoded[idx + root_path.len()..];
            // 如果有 prefix，检查是否匹配
            if !prefix.is_empty() && relative.starts_with(prefix) {
                return relative.to_string();
            } else if prefix.is_empty() {
                return relative.to_string();
            }
        }
        String::new()
    }
}

#[async_trait]
impl CloudStorage for WebDavStorage {
    fn provider_name(&self) -> &'static str {
        "WebDAV"
    }

    async fn check_connection(&self) -> Result<()> {
        // 尝试 MKCOL 创建根目录
        let res = self.request(Self::mkcol_method()?, "", None).await?;

        if matches!(
            res.status(),
            StatusCode::OK
                | StatusCode::CREATED
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::CONFLICT
        ) {
            return Ok(());
        }

        // 回退：GET 根目录
        let res = self.request(Method::GET, "", None).await?;
        if res.status().is_success() || res.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(AppError::network(format!(
                "WebDAV 连接检测失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )))
        }
    }

    async fn put_file(
        &self,
        key: &str,
        local_path: &Path,
        progress: Option<UploadProgressCallback>,
    ) -> Result<String> {
        // 确保父目录存在
        if let Some(parent) = key.rfind('/') {
            let parent_path = &key[..parent];
            if !parent_path.is_empty() {
                self.ensure_directory(parent_path).await?;
            }
        }

        let metadata = std::fs::metadata(local_path)
            .map_err(|e| AppError::file_system(format!("读取文件元信息失败: {e}")))?;
        let file_size = metadata.len();
        let progress: Option<Arc<UploadProgressCallback>> = progress.map(Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(0, file_size);
        }

        let checksum = tokio::task::spawn_blocking({
            let path = local_path.to_path_buf();
            move || calculate_file_hash(&path)
        })
        .await
        .map_err(|e| AppError::internal(format!("计算校验和任务失败: {e}")))??;

        let file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| AppError::file_system(format!("打开文件失败: {e}")))?;

        let uploaded = Arc::new(AtomicU64::new(0));
        let progress_cb = progress.clone();
        let stream = ReaderStream::new(file).map(move |chunk| {
            if let Ok(ref bytes) = chunk {
                let new_total =
                    uploaded.fetch_add(bytes.len() as u64, Ordering::SeqCst) + bytes.len() as u64;
                if let Some(cb) = progress_cb.as_ref() {
                    cb(new_total, file_size);
                }
            }
            chunk
        });

        let url = self.build_url(key)?;
        let res = self
            .http
            .request(Method::PUT, url)
            .header("Authorization", self.auth_header())
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|e| AppError::network(format!("WebDAV 上传失败: {e}")))?;

        if res.status().is_success() {
            if let Some(cb) = progress.as_ref() {
                cb(file_size, file_size);
            }
            Ok(checksum)
        } else {
            Err(AppError::network(format!(
                "WebDAV 上传失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or("")
            )))
        }
    }

    async fn get_file(
        &self,
        key: &str,
        local_path: &Path,
        expected_checksum: Option<&str>,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<String> {
        let info = self
            .stat(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total_size = info.size;
        let progress: Option<Arc<DownloadProgressCallback>> = progress.map(Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(0, total_size);
        }

        let res = self.request(Method::GET, key, None).await?;

        if res.status() == StatusCode::NOT_FOUND {
            return Err(AppError::not_found("云端文件不存在"));
        }
        if !res.status().is_success() {
            return Err(AppError::network(format!(
                "WebDAV 下载失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )));
        }

        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        }
        let mut file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| AppError::file_system(format!("创建文件失败: {e}")))?;

        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
            file.write_all(&bytes)
                .await
                .map_err(|e| AppError::file_system(format!("写入文件失败: {e}")))?;
            hasher.update(&bytes);
            downloaded += bytes.len() as u64;
            if let Some(cb) = progress.as_ref() {
                cb(downloaded, total_size);
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::file_system(format!("刷新文件失败: {e}")))?;

        let checksum = format!("{:x}", hasher.finalize());
        if let Some(expected) = expected_checksum {
            if expected != checksum {
                return Err(AppError::validation(format!(
                    "校验失败：期望 {}, 实际 {}",
                    expected, checksum
                )));
            }
        }
        Ok(checksum)
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
        // 确保父目录存在
        if let Some(parent) = key.rfind('/') {
            let parent_path = &key[..parent];
            if !parent_path.is_empty() {
                self.ensure_directory(parent_path).await?;
            }
        }

        let res = self.request(Method::PUT, key, Some(data.to_vec())).await?;

        if res.status().is_success() {
            Ok(())
        } else {
            Err(AppError::network(format!(
                "WebDAV 上传失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )))
        }
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let res = self.request(Method::GET, key, None).await?;

        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(AppError::network(format!(
                "WebDAV 下载失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )));
        }

        let bytes = res
            .bytes()
            .await
            .map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        let path = if prefix.is_empty() {
            String::new()
        } else {
            prefix.trim_matches('/').to_string()
        };

        let url = self.build_url(&path)?;

        let res = self
            .http
            .request(Self::propfind_method()?, url)
            .header("Authorization", self.auth_header())
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>"#)
            .send()
            .await
            .map_err(|e| AppError::network(format!("WebDAV PROPFIND 请求失败: {e}")))?;

        if res.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !res.status().is_success() {
            return Err(AppError::network(format!(
                "WebDAV PROPFIND 失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )));
        }

        let xml = res
            .text()
            .await
            .map_err(|e| AppError::network(format!("读取 PROPFIND 响应失败: {e}")))?;

        Ok(self.parse_propfind_response(&xml, prefix))
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let res = self.request(Method::DELETE, key, None).await?;

        if res.status().is_success() || res.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(AppError::network(format!(
                "WebDAV 删除失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )))
        }
    }

    async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
        let url = self.build_url(key)?;

        let res = self
            .http
            .request(Self::propfind_method()?, url)
            .header("Authorization", self.auth_header())
            .header("Depth", "0")
            .header("Content-Type", "application/xml")
            .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>"#)
            .send()
            .await
            .map_err(|e| AppError::network(format!("WebDAV PROPFIND 请求失败: {e}")))?;

        if res.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(AppError::network(format!(
                "WebDAV PROPFIND 失败: {} {}",
                res.status(),
                res.status().canonical_reason().unwrap_or(""),
            )));
        }

        let xml = res
            .text()
            .await
            .map_err(|e| AppError::network(format!("读取 PROPFIND 响应失败: {e}")))?;

        let files = self.parse_propfind_response(&xml, "");
        Ok(files.into_iter().next())
    }
}
