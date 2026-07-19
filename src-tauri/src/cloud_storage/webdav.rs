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
    CloudStorage, DownloadProgressCallback, FileInfo, ListOutcome, Result, UploadProgressCallback,
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

        let http = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // 死连接保护：reqwest 0.11 没有 read_timeout，依靠 TCP keepalive
            // 检测对端消失；流式读写的逐块停滞保护见 get_file/put_file。
            .tcp_keepalive(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
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

    /// 将相对 key 组合成 WebDAV 根目录下的远程路径
    fn remote_path(&self, key: &str) -> String {
        Self::join_paths(&self.root, key)
    }

    /// 拼接两个路径片段，去掉首尾斜杠，避免重复分隔符
    fn join_paths(base: &str, child: &str) -> String {
        let base = base.trim_matches('/');
        let preserve_trailing_slash = child.ends_with('/') && !child.trim_matches('/').is_empty();
        let child = child.trim_matches('/');

        match (base.is_empty(), child.is_empty()) {
            (true, true) => String::new(),
            (true, false) => {
                if preserve_trailing_slash {
                    format!("{child}/")
                } else {
                    child.to_string()
                }
            }
            (false, true) => base.to_string(),
            (false, false) => {
                if preserve_trailing_slash {
                    format!("{base}/{child}/")
                } else {
                    format!("{base}/{child}")
                }
            }
        }
    }

    /// 构建完整 URL
    fn build_path_url(&self, path: &str) -> Result<Url> {
        let mut url = self.base_url.clone();
        let base_segments = url
            .path()
            .trim_matches('/')
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let remote_segments = path
            .trim_matches('/')
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let preserve_trailing_slash = path.ends_with('/') && !remote_segments.is_empty();

        url.set_path("");
        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                AppError::configuration("WebDAV endpoint 不能作为层级路径处理".to_string())
            })?;
            for segment in base_segments.iter().chain(remote_segments.iter()) {
                segments.push(segment);
            }
            if preserve_trailing_slash {
                segments.push("");
            }
        }
        Ok(url)
    }

    /// 构建完整 URL
    fn build_url(&self, key: &str) -> Result<Url> {
        self.build_path_url(&self.remote_path(key))
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
    async fn request_with_path(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        let url = self.build_path_url(path)?;
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

            // send() 覆盖"连接 + 发送内存体 + 等响应头"，不覆盖流式响应体下载，
            // 因此对 get_file 的大文件流式下载无影响（其逐块停滞保护在 get_file 内）。
            // 防止服务器收下 TCP 连接后无限沉默导致 send() 永久挂起。
            match tokio::time::timeout(std::time::Duration::from_secs(120), builder.send()).await {
                Ok(Ok(resp)) => return Ok(resp),
                Ok(Err(e)) => {
                    last_error = Some(e.to_string());
                    if attempt == max_retries - 1 {
                        break;
                    }
                }
                Err(_) => {
                    last_error = Some("等待响应头超时（120 秒）".to_string());
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
            last_error.unwrap_or_default()
        )))
    }

    /// 发送 PROPFIND 请求（带 120s 响应头超时、60s 响应体超时、网络错误重试）。
    ///
    /// 返回 `Ok(None)` 表示目标不存在（404）；非 2xx/404 状态码立即报错不重试
    /// （客户端错误重试无意义）；网络层失败与超时按指数退避重试。
    /// 此前 list_outcome/stat 的 PROPFIND 直接裸调 `self.http.send()`，
    /// 无任何超时——服务器收下连接后沉默会让整个同步流程永久挂起。
    async fn propfind_with_retry(
        &self,
        url: Url,
        depth: &str,
        context: &str,
    ) -> Result<Option<String>> {
        const PROPFIND_BODY: &str = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>"#;
        let max_retries = 3;
        let mut last_error: Option<String> = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = Duration::from_millis(500 * (1 << attempt));
                tokio::time::sleep(delay).await;
                tracing::debug!(
                    "WebDAV PROPFIND {} 重试 {}/{}",
                    context,
                    attempt + 1,
                    max_retries
                );
            }

            let send_result = tokio::time::timeout(
                Duration::from_secs(120),
                self.http
                    .request(Self::propfind_method()?, url.clone())
                    .header("Authorization", self.auth_header())
                    .header("Depth", depth)
                    .header("Content-Type", "application/xml")
                    .body(PROPFIND_BODY)
                    .send(),
            )
            .await;

            let res = match send_result {
                Ok(Ok(res)) => res,
                Ok(Err(e)) => {
                    last_error = Some(e.to_string());
                    continue;
                }
                Err(_) => {
                    last_error = Some("等待响应头超时（120 秒）".to_string());
                    continue;
                }
            };

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

            // PROPFIND 响应是有限大小的 XML，60 秒读不完视为连接停滞。
            match tokio::time::timeout(Duration::from_secs(60), res.text()).await {
                Ok(Ok(xml)) => return Ok(Some(xml)),
                Ok(Err(e)) => {
                    last_error = Some(format!("读取 PROPFIND 响应失败: {e}"));
                }
                Err(_) => {
                    last_error = Some("读取 PROPFIND 响应超时（60 秒）".to_string());
                }
            }
        }

        Err(AppError::network(format!(
            "WebDAV PROPFIND {} 失败（已重试 {} 次）: {}",
            context,
            max_retries,
            last_error.unwrap_or_default()
        )))
    }

    async fn request(
        &self,
        method: Method,
        key: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        self.request_with_path(method, &self.remote_path(key), body)
            .await
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
                .request_with_path(Self::mkcol_method()?, &format!("{}/", current), None)
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

            let is_collection = response
                .descendants()
                .any(|n| n.has_tag_name((dav_ns, "collection")));

            if is_collection || href.ends_with('/') {
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

        files.sort_by_key(|b| std::cmp::Reverse(b.last_modified));
        files
    }

    fn extract_relative_key(&self, href: &str, prefix: &str) -> String {
        // URL 解码
        let decoded = urlencoding::decode(href).unwrap_or_else(|_| href.into());
        let href_path = Url::parse(&decoded)
            .map(|url| url.path().to_string())
            .unwrap_or_else(|_| decoded.to_string());

        let base_path = self.base_url.path().trim_end_matches('/');
        let root = self.root.trim_matches('/');
        let root_path = match (base_path.is_empty(), root.is_empty()) {
            (true, true) => String::new(),
            (true, false) => format!("/{root}"),
            (false, true) => base_path.to_string(),
            (false, false) => format!("{base_path}/{root}"),
        };

        let relative = if root_path.is_empty() {
            href_path.trim_start_matches('/').to_string()
        } else if href_path == root_path || href_path == format!("{root_path}/") {
            String::new()
        } else {
            let prefix_with_slash = format!("{root_path}/");
            href_path
                .strip_prefix(&prefix_with_slash)
                .map(ToOwned::to_owned)
                .unwrap_or_default()
        };

        if relative.is_empty() {
            return String::new();
        }

        // 如果有 prefix，检查是否匹配
        if !prefix.is_empty() {
            let prefix = prefix.trim_matches('/');
            if relative == prefix || relative.starts_with(&format!("{prefix}/")) {
                return relative;
            }
        } else {
            return relative;
        }
        String::new()
    }

    /// 解析 PROPFIND 响应，同时返回文件列表和子目录列表。
    ///
    /// RFC 4918 推荐使用 Depth:1 + 客户端迭代递归替代 Depth:infinity，
    /// 避免依赖服务器对 infinity 的支持（坚果云等可能不支持）。
    fn parse_propfind_entries(
        &self,
        xml: &str,
        prefix: &str,
        request_dir: &str,
    ) -> (Vec<FileInfo>, Vec<String>) {
        let doc = match roxmltree::Document::parse(xml) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("WebDAV PROPFIND XML 解析失败: {e}");
                return (Vec::new(), Vec::new());
            }
        };

        let dav_ns = "DAV:";
        let mut files = Vec::new();
        let mut subdirs = Vec::new();
        let request_dir_normalized = request_dir.trim_matches('/');
        let prefix_normalized = prefix.trim_matches('/');

        for response in doc
            .descendants()
            .filter(|n| n.has_tag_name((dav_ns, "response")))
        {
            let href = response
                .descendants()
                .find(|n| n.has_tag_name((dav_ns, "href")))
                .and_then(|n| n.text())
                .unwrap_or_default();

            let is_collection = response
                .descendants()
                .any(|n| n.has_tag_name((dav_ns, "collection")));

            if is_collection || href.ends_with('/') {
                // 目录项：提取相对路径（不做 prefix 过滤）
                let key = self.extract_relative_key(href, "");
                let dir_path = key.trim_matches('/');
                // 跳过请求目录自身和空路径
                if dir_path == request_dir_normalized || dir_path.is_empty() {
                    continue;
                }
                // 只包含 prefix 下的子目录
                if !prefix_normalized.is_empty() && !dir_path.starts_with(prefix_normalized) {
                    continue;
                }
                subdirs.push(dir_path.to_string());
            } else {
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
        }

        (files, subdirs)
    }
}

#[async_trait]
impl CloudStorage for WebDavStorage {
    fn provider_name(&self) -> &'static str {
        "WebDAV"
    }

    fn instance_binding_hint(&self) -> String {
        format!(
            "webdav|endpoint={}|user={}|root={}",
            self.base_url.as_str().trim_end_matches('/'),
            self.username,
            self.root
        )
    }

    async fn check_connection(&self) -> Result<()> {
        // 先确保同步根目录存在，再做连接探测
        self.ensure_directory(&self.root).await?;

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
        self.ensure_directory(&self.root).await?;
        // 确保父目录存在
        if let Some(parent) = key.rfind('/') {
            let parent_path = &key[..parent];
            if !parent_path.is_empty() {
                self.ensure_directory(&self.remote_path(parent_path))
                    .await?;
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

        let url = self.build_url(key)?;
        // 流式上传的 send() 覆盖整个请求体传输：用按体积放缩的超时做停滞保护
        // （下限 64KB/s + 120 秒余量），避免固定超时杀死慢速大文件上传。
        let upload_timeout = std::time::Duration::from_secs(120 + file_size / (64 * 1024))
            .max(std::time::Duration::from_secs(300));

        // 流式 PUT 无法复用 request_with_path 的重试（body 不可克隆），这里
        // 显式按尝试重建文件流重试：网络错误/超时/5xx 可重试，4xx 立即失败。
        // PUT 是整文件覆盖写，重传天然幂等。
        let max_retries = 3;
        let mut last_error: Option<AppError> = None;
        // 跨重试的进度高水位：重传从头读文件时不向 UI 上报回跳的进度
        let reported_max = Arc::new(AtomicU64::new(0));

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = std::time::Duration::from_millis(500 * (1 << attempt));
                tokio::time::sleep(delay).await;
                tracing::debug!("WebDAV PUT {} 重试 {}/{}", key, attempt + 1, max_retries);
            }

            let file = tokio::fs::File::open(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("打开文件失败: {e}")))?;

            let uploaded = Arc::new(AtomicU64::new(0));
            let progress_cb = progress.clone();
            let reported = reported_max.clone();
            let stream = ReaderStream::new(file).map(move |chunk| {
                if let Ok(ref bytes) = chunk {
                    let new_total = uploaded.fetch_add(bytes.len() as u64, Ordering::SeqCst)
                        + bytes.len() as u64;
                    let prev_max = reported.fetch_max(new_total, Ordering::SeqCst);
                    if new_total > prev_max {
                        if let Some(cb) = progress_cb.as_ref() {
                            cb(new_total, file_size);
                        }
                    }
                }
                chunk
            });

            let send_result = self
                .http
                .request(Method::PUT, url.clone())
                .header("Authorization", self.auth_header())
                .timeout(upload_timeout)
                .body(reqwest::Body::wrap_stream(stream))
                .send()
                .await;

            match send_result {
                Ok(res) if res.status().is_success() => {
                    if let Some(cb) = progress.as_ref() {
                        cb(file_size, file_size);
                    }
                    return Ok(checksum);
                }
                Ok(res) => {
                    let err = AppError::network(format!(
                        "WebDAV 上传失败: {} {}",
                        res.status(),
                        res.status().canonical_reason().unwrap_or("")
                    ));
                    // 4xx 是确定性失败（认证/路径/配额等），重试无意义
                    if !res.status().is_server_error() {
                        return Err(err);
                    }
                    last_error = Some(err);
                }
                Err(e) => {
                    last_error = Some(AppError::network(format!("WebDAV 上传失败: {e}")));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            AppError::network(format!("WebDAV 上传失败（已重试 {max_retries} 次）"))
        }))
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

        let parent = local_path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        let _temp_file = tempfile::Builder::new()
            .prefix(".download-")
            .tempfile_in(parent)
            .map_err(|e| AppError::file_system(format!("创建临时下载文件失败: {e}")))?;
        let temp_path = _temp_file.path().to_path_buf();

        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        {
            let mut file = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("创建文件失败: {e}")))?;

            let mut stream = res.bytes_stream();
            loop {
                // 逐块停滞超时：单块 90 秒收不到任何数据视为死连接。
                // 不限制总传输时长，慢但有进展的大文件下载不受影响。
                let next = tokio::time::timeout(std::time::Duration::from_secs(90), stream.next())
                    .await
                    .map_err(|_| {
                        AppError::network("WebDAV 下载停滞超过 90 秒，连接可能已断开".to_string())
                    })?;
                let Some(chunk) = next else {
                    break;
                };
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
        }

        let checksum = format!("{:x}", hasher.finalize());
        if let Some(expected) = expected_checksum {
            if expected != checksum {
                return Err(AppError::validation(format!(
                    "校验失败：期望 {}, 实际 {}",
                    expected, checksum
                )));
            }
        }
        tokio::fs::rename(&temp_path, local_path)
            .await
            .map_err(|e| AppError::file_system(format!("保存下载文件失败: {e}")))?;
        Ok(checksum)
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
        self.ensure_directory(&self.root).await?;
        // 确保父目录存在
        if let Some(parent) = key.rfind('/') {
            let parent_path = &key[..parent];
            if !parent_path.is_empty() {
                self.ensure_directory(&self.remote_path(parent_path))
                    .await?;
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

        // get() 用于 manifest/变更文件等内存级对象：读体加总超时，
        // 防止 request() 的响应头超时通过后、响应体传输中途停滞导致永久挂起。
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(300), res.bytes())
            .await
            .map_err(|_| AppError::network("读取响应体超时（300 秒）".to_string()))?
            .map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        Ok(self.list_outcome(prefix).await?.files)
    }

    async fn list_outcome(&self, prefix: &str) -> Result<ListOutcome> {
        let start_path = if prefix.is_empty() {
            String::new()
        } else {
            prefix.trim_matches('/').to_string()
        };

        let mut all_files = Vec::new();
        let mut dirs_to_visit = vec![start_path];
        // 坚果云单次 PROPFIND 上限 750 条目
        const JIANGUOYUN_PROPFIND_LIMIT: usize = 750;
        const MAX_DIRS: usize = 200;
        let mut visited = 0usize;
        let mut truncated = false;

        while let Some(dir) = dirs_to_visit.pop() {
            visited += 1;
            if visited > MAX_DIRS {
                tracing::warn!("[WebDAV] 递归列举已访问 {MAX_DIRS} 个目录，停止遍历以防异常");
                truncated = true;
                break;
            }

            // RFC 4918: PROPFIND 对集合的 Request-URI 应以 `/` 结尾，
            // 否则某些服务器返回 301 重定向，而 reqwest 默认不对非 GET 方法跟随重定向。
            let dir_with_slash = if dir.is_empty() || dir.ends_with('/') {
                dir.clone()
            } else {
                format!("{}/", dir)
            };
            let url = self.build_url(&dir_with_slash)?;

            let Some(xml) = self.propfind_with_retry(url, "1", &dir_with_slash).await? else {
                // 404：目录不存在，跳过
                continue;
            };

            let (files, subdirs) = self.parse_propfind_entries(&xml, prefix, &dir);

            let entry_count = files.len() + subdirs.len();
            if entry_count >= JIANGUOYUN_PROPFIND_LIMIT - 1 {
                tracing::error!(
                    "[WebDAV] PROPFIND 返回 {} 条目（达到坚果云 {} 上限），\
                     目录 '{}' 下可能有未列出的文件。",
                    entry_count,
                    JIANGUOYUN_PROPFIND_LIMIT,
                    dir
                );
                truncated = true;
            }

            all_files.extend(files);
            dirs_to_visit.extend(subdirs);
        }

        all_files.sort_by_key(|b| std::cmp::Reverse(b.last_modified));
        Ok(ListOutcome {
            files: all_files,
            truncated,
        })
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

        let Some(xml) = self.propfind_with_retry(url, "0", key).await? else {
            return Ok(None);
        };

        let files = self.parse_propfind_response(&xml, "");
        Ok(files.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_storage() -> WebDavStorage {
        WebDavStorage::new(
            WebDavConfig {
                endpoint: "http://localhost:8080/".to_string(),
                username: "webdav".to_string(),
                password: "webdav123".to_string(),
            },
            "deep-student-sync-contract/webdav/uuid".to_string(),
        )
        .expect("create test storage")
    }

    fn test_storage_with_root(root: &str) -> WebDavStorage {
        WebDavStorage::new(
            WebDavConfig {
                endpoint: "http://localhost:8080/dav/".to_string(),
                username: "webdav".to_string(),
                password: "webdav123".to_string(),
            },
            root.to_string(),
        )
        .expect("create test storage")
    }

    #[test]
    fn build_url_adds_root_once() {
        let storage = test_storage();
        let url = storage
            .build_url("objects/basic/hello.txt")
            .expect("build url");
        assert_eq!(
            url.as_str(),
            "http://localhost:8080/deep-student-sync-contract/webdav/uuid/objects/basic/hello.txt"
        );
    }

    #[test]
    fn build_path_url_uses_raw_server_path() {
        let storage = test_storage();
        let url = storage
            .build_path_url("deep-student-sync-contract/webdav/uuid/")
            .expect("build raw path url");
        assert_eq!(
            url.as_str(),
            "http://localhost:8080/deep-student-sync-contract/webdav/uuid/"
        );
    }

    #[test]
    fn remote_path_joins_once() {
        let storage = test_storage();
        assert_eq!(
            storage.remote_path("objects/basic/hello.txt"),
            "deep-student-sync-contract/webdav/uuid/objects/basic/hello.txt"
        );
        assert_eq!(
            storage.remote_path("objects/"),
            "deep-student-sync-contract/webdav/uuid/objects/"
        );
        assert_eq!(
            storage.build_url("objects/").unwrap().path(),
            "/deep-student-sync-contract/webdav/uuid/objects/"
        );
    }

    #[test]
    fn extract_relative_key_handles_empty_root() {
        let storage = test_storage_with_root("");

        assert_eq!(
            storage.extract_relative_key("/dav/data_governance/manifest.json", ""),
            "data_governance/manifest.json"
        );
        assert_eq!(
            storage.extract_relative_key(
                "http://localhost:8080/dav/data_governance/changes/device/1.json.zst",
                "data_governance/changes"
            ),
            "data_governance/changes/device/1.json.zst"
        );
        assert_eq!(storage.extract_relative_key("/dav/", ""), "");
    }

    #[test]
    fn extract_relative_key_handles_root_slash_normalization() {
        let storage = test_storage_with_root("/");

        assert_eq!(
            storage.extract_relative_key("/dav/backups/one.zip", "backups"),
            "backups/one.zip"
        );
        assert_eq!(storage.root, "");
    }

    #[test]
    fn webdav_contract_source_guards() {
        let source = include_str!("webdav.rs");

        assert!(
            source.contains("<d:resourcetype/>"),
            "WebDAV PROPFIND must request resourcetype for reliable directory detection"
        );
        assert!(
            source.contains("async fn list_outcome"),
            "WebDAV list must expose truncation state"
        );
        assert!(
            source.contains("truncated = true"),
            "WebDAV list must mark server/client traversal limits as truncated"
        );
        assert!(
            source.contains("is_collection || href.ends_with('/')"),
            "Directory detection must use resourcetype with href suffix only as fallback"
        );
    }
}
