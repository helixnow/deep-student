//! WebDAV 存储实现
//!
//! 基于 reqwest 的 WebDAV 客户端，支持坚果云、Nextcloud 等服务

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header::HeaderMap, Client, Method, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use super::config::WebDavConfig;
use super::traits::{
    ensure_declared_len_within_budget, ensure_memory_get_matches_declared_len, BoundedMemoryBody,
    CloudStorage, DownloadProgressCallback, FileInfo, ListOutcome, Result, UploadProgressCallback,
    MEMORY_GET_DEFAULT_BUDGET_BYTES, MEMORY_GET_STALL_SECS,
};
use crate::backup_common::calculate_file_hash;
use crate::models::AppError;

/// 单次重试等待的上限。
///
/// 部分服务器（或代理）会返回夸张的 Retry-After（如 21600 秒 = 6 小时），
/// 同步流程不能因此挂起数小时——封顶后按上限等待，重试次数本身有界。
const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

/// WebDAV 存储实现
pub struct WebDavStorage {
    base_url: Url,
    username: String,
    password: String,
    root: String,
    http: Client,
    /// 本会话内已确认存在（MKCOL 成功或已存在）的远程目录缓存。
    /// 避免每次 PUT 都对整条路径重发全链 MKCOL。
    created_dirs: Mutex<HashSet<String>>,
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
            created_dirs: Mutex::new(HashSet::new()),
        })
    }

    /// 判断状态码是否值得有界重试。
    ///
    /// - 423 Locked：其他客户端持有锁，稍后可能释放
    /// - 429 Too Many Requests：限流，退避后重试
    /// - 500/502/503/504：服务端/网关瞬时故障
    ///
    /// 其余 4xx（认证/路径/配额）与 501/505/507 是确定性失败，重试无意义。
    fn is_retryable_status(status: StatusCode) -> bool {
        matches!(status.as_u16(), 423 | 429 | 500 | 502 | 503 | 504)
    }

    /// 解析 Retry-After 头（秒数或 HTTP-date，RFC 9110 §10.2.3）。
    fn parse_retry_after(raw: &str) -> Option<Duration> {
        let raw = raw.trim();
        if let Ok(secs) = raw.parse::<u64>() {
            return Some(Duration::from_secs(secs));
        }
        let when = DateTime::parse_from_rfc2822(raw).ok()?;
        // 过去的时间点（负 delta）视为无效，交由指数退避兜底
        (when.with_timezone(&Utc) - Utc::now()).to_std().ok()
    }

    /// 从响应头提取封顶后的 Retry-After 等待时长。
    fn capped_retry_after(headers: &HeaderMap) -> Option<Duration> {
        let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
        Some(Self::parse_retry_after(raw)?.min(MAX_RETRY_WAIT))
    }

    /// 无 Retry-After 时的指数退避（同样受 MAX_RETRY_WAIT 封顶）。
    fn backoff_delay(attempt: u32) -> Duration {
        Duration::from_millis(500u64 << attempt).min(MAX_RETRY_WAIT)
    }

    /// 判断单目录 PROPFIND 的 response 数是否命中已知的服务端静默截断边界。
    ///
    /// WebDAV 没有通用分页协议，无法向服务器确认列表完整性，只能按已知
    /// 上限做 fail-closed 启发式：
    /// - 坚果云在 750 个 response 处截断（含集合自身则表现为 750 或 751）；
    /// - 个别网关在 1000 个 response 处截断（含集合自身则表现为 1000 或 1001）。
    ///
    /// 早期版本曾把所有"整百"（100/200/...）乃至"整千"（2000/3000/...）
    /// 的 response 数都当作截断信号，导致目录里恰好有 99/100（或 1999/2000）
    /// 个真实条目——加集合自身即 100/101（或 2000/2001）个 response——时
    /// 出现假阳性、整个同步被拒绝推进。未见真实服务在这些位置截断的案例
    /// （单次响应能返回 2000+ 个 response 恰说明服务端没有在 1000 处截断），
    /// 故收紧为仅 750/751 与 1000/1001 两档已知边界。
    ///
    /// `response_count` 是 multistatus 里 DAV:response 的总数，
    /// 通常包含被列举集合自身，即真实条目数 + 1。
    fn is_suspicious_response_count(response_count: usize) -> bool {
        matches!(response_count, 750 | 751 | 1000 | 1001)
    }

    /// 解析 `Content-Range: bytes <start>-<end>/<total>` 的起点字节。
    ///
    /// 无法解析（含 `bytes */<total>` 等形态）返回 `None`，由调用方 fail-closed。
    fn parse_content_range_start(raw: &str) -> Option<u64> {
        let rest = raw.trim().strip_prefix("bytes")?.trim_start();
        let (start, _) = rest.split_once('-')?;
        start.trim().parse::<u64>().ok()
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
        // [#57] base_url.path() 是百分号编码形式，而 path_segments_mut().push
        // 会把 '%' 再转义一次——端点路径含编码字符（中文/空格）时所有请求 URL
        // 被双重编码。先解码 base 片段，交由 push 统一做单次编码。
        let base_segments = url
            .path()
            .trim_matches('/')
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(Self::decode_path)
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
    ///
    /// 网络错误/超时按指数退避重试；423/429/500/502/503/504 也做有界重试，
    /// 并尊重 Retry-After 头（受 MAX_RETRY_WAIT 封顶）。重试耗尽后把最后一个
    /// 响应原样返回，由调用方按各自语义生成错误信息。
    async fn request_with_path(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        let url = self.build_path_url(path)?;
        let max_retries = 3;
        let mut last_error = None;
        let mut pending_delay: Option<Duration> = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = pending_delay
                    .take()
                    .unwrap_or_else(|| Self::backoff_delay(attempt));
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
                Ok(Ok(resp)) => {
                    if Self::is_retryable_status(resp.status()) && attempt < max_retries - 1 {
                        tracing::debug!(
                            "WebDAV {} {} 返回 {}，将重试",
                            method,
                            path,
                            resp.status()
                        );
                        pending_delay = Self::capped_retry_after(resp.headers());
                        last_error = Some(format!("HTTP {}", resp.status()));
                        continue;
                    }
                    // 最后一次尝试仍是可重试状态时也原样返回，
                    // 让调用方按自身语义（405/409 容忍等）处理。
                    return Ok(resp);
                }
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
    /// 返回 `Ok(None)` 表示目标不存在（404）；确定性客户端错误立即报错不重试；
    /// 网络层失败与超时按指数退避重试；423/429/500/502/503/504 有界重试并
    /// 尊重 Retry-After（受 MAX_RETRY_WAIT 封顶）。
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
        let mut pending_delay: Option<Duration> = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = pending_delay
                    .take()
                    .unwrap_or_else(|| Self::backoff_delay(attempt));
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
            if Self::is_retryable_status(res.status()) {
                pending_delay = Self::capped_retry_after(res.headers());
                last_error = Some(format!(
                    "HTTP {} {}",
                    res.status(),
                    res.status().canonical_reason().unwrap_or(""),
                ));
                continue;
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

    /// 确保目录存在（递归创建，带会话级缓存）
    ///
    /// 已确认存在的目录记入 `created_dirs`，后续调用直接跳过对应的 MKCOL，
    /// 避免每次 PUT 都对整条路径重发全链 MKCOL（坚果云等服务对请求频率敏感）。
    ///
    /// PUT 路径的调用方对 MKCOL 失败保持容忍（目录可能已存在，真缺目录时
    /// 后续 PUT 自会失败）；需要区分"目录尚不存在"与"目录建不出来"的调用方
    /// （如 `check_connection`）应使用 `ensure_directory_tracked`。
    async fn ensure_directory(&self, path: &str) -> Result<()> {
        self.ensure_directory_tracked(path).await.map(|_| ())
    }

    /// 同 `ensure_directory`，但额外返回"链路末端仍未被后续成功覆盖"的
    /// MKCOL 失败状态码（403 权限拒绝、507 配额耗尽、重试耗尽后仍持续的
    /// 5xx/423/429，以及整链 409）。
    ///
    /// 409 CONFLICT 在部分服务上表示"已存在"，但也可能表示"父目录缺失、
    /// 什么都没建成"——单看 MKCOL 无法区分，因此这里记录下来，交由调用方
    /// 结合后续 PROPFIND 探测结果判定（探测到目录存在则无害，探测 404 则
    /// 说明整链确实没建成）。任何一段 MKCOL 成功（200/201/405）都证明该层
    /// 已存在，此前记录的失败随即清空。
    async fn ensure_directory_tracked(&self, path: &str) -> Result<Option<StatusCode>> {
        let parts: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();

        let mut mkcol_failure: Option<StatusCode> = None;
        let mut current = String::new();
        for part in parts {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(part);

            if self
                .created_dirs
                .lock()
                .expect("created_dirs 锁中毒")
                .contains(&current)
            {
                continue;
            }

            // MKCOL 创建目录
            let res = self
                .request_with_path(Self::mkcol_method()?, &format!("{}/", current), None)
                .await?;

            // 405 METHOD_NOT_ALLOWED 表示目录已存在；409 CONFLICT 部分服务也用于
            // "已存在"，但同样可能表示父目录缺失，因此不进缓存，仅容忍。
            match res.status() {
                StatusCode::OK | StatusCode::CREATED | StatusCode::METHOD_NOT_ALLOWED => {
                    self.created_dirs
                        .lock()
                        .expect("created_dirs 锁中毒")
                        .insert(current.clone());
                    // 本层已确认存在：更浅层的 409/瞬时失败不再影响
                    // "同步根目录能否存在"的判定。
                    mkcol_failure = None;
                }
                StatusCode::CONFLICT => {
                    // 可能是"已存在"也可能是"父目录缺失"，不进缓存；
                    // 记录下来供调用方与 PROPFIND 404 联合判定整链失败。
                    mkcol_failure = Some(StatusCode::CONFLICT);
                }
                other if other.is_client_error() || other.is_server_error() => {
                    // 确定性失败（403/507，或 request_with_path 重试耗尽后仍
                    // 持续的 5xx）。这里不中断：目录可能已存在，由调用方决定
                    // 如何结合后续探测结果处理。
                    mkcol_failure = Some(other);
                    tracing::warn!("WebDAV MKCOL {} 失败: {}", current, other);
                }
                other => {
                    tracing::debug!("WebDAV MKCOL {} 返回 {}", current, other);
                }
            }
        }
        Ok(mkcol_failure)
    }

    /// `check_connection` 专用：同步根目录既不存在（探测 404）又建不成时的错误。
    ///
    /// 423/429 是瞬时状态（其他客户端持锁 / 服务端限流），重试耗尽只说明
    /// "现在不行"，不能误导成"目录无法创建"的确定性结论——那会让用户去
    /// 排查权限/路径配置而不是稍后重试。
    fn root_unavailable_error(mkcol_status: StatusCode) -> AppError {
        match mkcol_status {
            StatusCode::LOCKED => AppError::network(
                "WebDAV 同步目录不存在，且服务器暂时锁定资源（423 Locked）：\
                 可能有其他客户端正在操作，请稍后重试"
                    .to_string(),
            ),
            StatusCode::TOO_MANY_REQUESTS => AppError::network(
                "WebDAV 同步目录不存在，且服务器正在限流（429 Too Many Requests）：\
                 请稍后重试"
                    .to_string(),
            ),
            StatusCode::CONFLICT => AppError::network(
                "WebDAV 同步目录不存在且无法创建：MKCOL 全链返回 409 Conflict\
                 （父目录缺失或路径被占用），PROPFIND 返回 404"
                    .to_string(),
            ),
            other => AppError::network(format!(
                "WebDAV 同步目录不存在且无法创建：MKCOL 返回 {} {}，PROPFIND 返回 404",
                other,
                other.canonical_reason().unwrap_or("")
            )),
        }
    }

    /// 解析 PROPFIND 响应获取文件列表（使用 roxmltree 安全解析，防止 XXE 注入）
    fn parse_propfind_response(&self, xml: &str, prefix: &str) -> Result<Vec<FileInfo>> {
        let doc = roxmltree::Document::parse(xml)
            .map_err(|e| AppError::network(format!("WebDAV PROPFIND XML 解析失败: {e}")))?;

        let dav_ns = "DAV:";
        if !doc
            .descendants()
            .any(|node| node.has_tag_name((dav_ns, "response")))
        {
            return Err(AppError::network(
                "WebDAV PROPFIND 响应缺少 DAV:response，无法确认列表完整性".to_string(),
            ));
        }
        let mut files = Vec::new();

        for response in doc
            .descendants()
            .filter(|n| n.has_tag_name((dav_ns, "response")))
        {
            let href = response
                .descendants()
                .find(|n| n.has_tag_name((dav_ns, "href")))
                .and_then(|n| n.text())
                .filter(|href| !href.trim().is_empty())
                .ok_or_else(|| {
                    AppError::network("WebDAV PROPFIND 的 DAV:response 缺少有效 href".to_string())
                })?;

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
        Ok(files)
    }

    /// 对百分号编码的路径解码；解码失败（非法 UTF-8 等）时原样返回。
    fn decode_path(path: &str) -> String {
        urlencoding::decode(path)
            .map(|decoded| decoded.into_owned())
            .unwrap_or_else(|_| path.to_string())
    }

    fn extract_relative_key(&self, href: &str, prefix: &str) -> String {
        // [#57] href 与 base_url.path() 必须在同一编码空间里比较。
        // 旧实现先解码 href 再 Url::parse：绝对 URL 形式的 href 会被重新编码，
        // 而 base_url.path() 始终是百分号编码形式——端点路径含非 ASCII/空格时
        // （如坚果云中文同步文件夹 https://dav.jianguoyun.com/dav/我的坚果云/）
        // strip_prefix 永不命中，列举结果被静默清空：上传（PUT）正常、
        // 下载/双向同步看不到任何云端文件。
        // 修复：先提取原始路径（绝对 URL 取 path，相对 href 去掉 query/fragment），
        // 再把 href 路径与 base 路径统一解码成人类可读形式后比较。
        let raw_path = match Url::parse(href) {
            Ok(url) => url.path().to_string(),
            Err(_) => href.split(['?', '#']).next().unwrap_or(href).to_string(),
        };
        let href_path = Self::decode_path(&raw_path);

        let base_path_encoded = self.base_url.path().trim_end_matches('/');
        let base_path = Self::decode_path(base_path_encoded);
        let base_path = base_path.trim_end_matches('/');
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
    ) -> Result<(Vec<FileInfo>, Vec<String>, usize)> {
        let doc = roxmltree::Document::parse(xml)
            .map_err(|e| AppError::network(format!("WebDAV PROPFIND XML 解析失败: {e}")))?;

        let dav_ns = "DAV:";
        let response_count = doc
            .descendants()
            .filter(|node| node.has_tag_name((dav_ns, "response")))
            .count();
        if response_count == 0 {
            return Err(AppError::network(
                "WebDAV PROPFIND 响应缺少 DAV:response，无法确认列表完整性".to_string(),
            ));
        }
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
                .filter(|href| !href.trim().is_empty())
                .ok_or_else(|| {
                    AppError::network("WebDAV PROPFIND 的 DAV:response 缺少有效 href".to_string())
                })?;

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

        Ok((files, subdirs, response_count))
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
        // 先确保同步根目录存在，再做连接探测。记录 MKCOL 的确定性失败
        // （403 权限拒绝 / 507 配额耗尽 / 重试耗尽的持续 5xx），供 404 判定使用。
        let mkcol_failure = self.ensure_directory_tracked(&self.root).await?;

        // 探测用 PROPFIND Depth:0（WebDAV 核心方法，所有实现必须支持）。
        // 此前用 GET 根集合探测：Nextcloud/sabre-dav 对集合 GET 返回 501，
        // 会把完全健康的服务器误报为连接失败。
        // 207 Multi-Status（2xx）视为连接正常；404 仅在 MKCOL 链路末端成功
        // （或已缓存确认）时容忍（服务器可达、认证通过但目录尚不存在）——
        // 若 MKCOL 已实际失败（含整链 409）且目录确实不存在，说明同步根目录
        // 既不存在也创建不了，后续同步必然失败，不得报连接成功。
        let root_path = if self.root.is_empty() {
            String::new()
        } else {
            format!("{}/", self.root)
        };
        let url = self.build_path_url(&root_path)?;
        match self.propfind_with_retry(url, "0", "check_connection").await {
            Ok(Some(_)) => Ok(()),
            Ok(None) => match mkcol_failure {
                None => Ok(()),
                Some(status) => Err(Self::root_unavailable_error(status)),
            },
            Err(propfind_err) => {
                // 极少数残缺实现 PROPFIND 不可用时回退 GET：2xx 视为可达；
                // 404 与上面同一判定，仅在 MKCOL 未失败时视为可达。
                let res = self.request(Method::GET, "", None).await?;
                if res.status().is_success() {
                    Ok(())
                } else if res.status() == StatusCode::NOT_FOUND {
                    match mkcol_failure {
                        None => Ok(()),
                        Some(status) => Err(Self::root_unavailable_error(status)),
                    }
                } else {
                    Err(propfind_err)
                }
            }
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
        // 显式按尝试重建文件流重试：网络错误/超时/423/429/500/502/503/504
        // 可重试（尊重 Retry-After，封顶 MAX_RETRY_WAIT），其余状态立即失败。
        // PUT 是整文件覆盖写，重传天然幂等。
        let max_retries = 3;
        let mut last_error: Option<AppError> = None;
        let mut pending_delay: Option<Duration> = None;
        // 跨重试的进度高水位：重传从头读文件时不向 UI 上报回跳的进度
        let reported_max = Arc::new(AtomicU64::new(0));

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = pending_delay
                    .take()
                    .unwrap_or_else(|| Self::backoff_delay(attempt));
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
                    // HTTP 2xx 不等于对象完整落地。put_file 哈希来自本地文件。
                    self.verify_remote_object_size(key, file_size).await?;
                    return Ok(checksum);
                }
                Ok(res) => {
                    let err = AppError::network(format!(
                        "WebDAV 上传失败: {} {}",
                        res.status(),
                        res.status().canonical_reason().unwrap_or("")
                    ));
                    // 认证/路径/配额（4xx）与 501/507 等是确定性失败，重试无意义
                    if !Self::is_retryable_status(res.status()) {
                        return Err(err);
                    }
                    pending_delay = Self::capped_retry_after(res.headers());
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
        let temp_path = tempfile::Builder::new()
            .prefix(".download-")
            .tempfile_in(parent)
            .map_err(|e| AppError::file_system(format!("创建临时下载文件失败: {e}")))?
            .into_temp_path();

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
            file.sync_all()
                .await
                .map_err(|e| AppError::file_system(format!("同步文件失败: {e}")))?;
        }

        // [R10-providers][FINDINGS-R11 P2-2] 半包 fail-closed：响应流读到 EOF
        // 不等于下载完成。流提前结束（半包），或对象在 stat（PROPFIND）与 GET
        // 之间被并发替换成不同大小的错版本，都在此拒绝——无 expected_checksum
        // 的调用方（如 repo_check）没有第二道防线。与 S3/FTP/默认实现的 R10
        // 校验对齐；续传路径 get_file_resumable 已有同等的 written != total_size
        // 拒绝。temp_path 随错误返回自动删除，绝不把半包/错版本落盘冒充成功。
        if downloaded != total_size {
            return Err(AppError::network(format!(
                "WebDAV 下载不完整或对象已变更：声明 {total_size} 字节，实际收到 {downloaded} 字节，已拒绝保存（请重试）"
            )));
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
        temp_path
            .persist(local_path)
            .map_err(|e| AppError::file_system(format!("保存下载文件失败: {}", e.error)))?;
        Ok(checksum)
    }

    fn supports_resumable_download(&self) -> bool {
        true
    }

    /// [R09-restore-ops][P2-2] 基于 HTTP Range 的断点续传下载。
    ///
    /// 复用上传/导入续传的诚实语义：
    /// - 服务端按 206 + Content-Range 精确续传 → 追加写入；
    /// - 服务端忽略 Range 返回 200 → 截断 `dest` 从零重写（诚实重下，返回 0）；
    /// - 206 的 Content-Range 起点与请求不一致 → fail-closed，绝不错位追加；
    /// - 流中断 → 返回错误，`dest` 保持为前缀完整的断点文件。
    async fn get_file_resumable(
        &self,
        key: &str,
        dest: &Path,
        resume_from: u64,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<u64> {
        let info = self
            .stat(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total_size = info.size;
        if resume_from > total_size {
            return Err(AppError::validation(format!(
                "本地断点（{resume_from} 字节）大于云端对象（{total_size} 字节），断点无效，请删除断点文件后整包重新下载"
            )));
        }
        let progress: Option<Arc<DownloadProgressCallback>> = progress.map(Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(resume_from, total_size);
        }
        if resume_from == total_size {
            // 断点已是完整对象：无字节可取（Range 请求会得到 416），
            // 完整性由调用方的整文件 SHA256 校验兜底。
            return Ok(resume_from);
        }

        let url = self.build_url(key)?;
        let mut builder = self
            .http
            .request(Method::GET, url)
            .header("Authorization", self.auth_header());
        if resume_from > 0 {
            builder = builder.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        let res = tokio::time::timeout(std::time::Duration::from_secs(120), builder.send())
            .await
            .map_err(|_| AppError::network("WebDAV 续传下载等待响应头超时（120 秒）".to_string()))?
            .map_err(|e| AppError::network(format!("WebDAV 续传下载请求失败: {e}")))?;

        if res.status() == StatusCode::NOT_FOUND {
            return Err(AppError::not_found("云端文件不存在"));
        }
        let actual_start = match res.status() {
            StatusCode::PARTIAL_CONTENT => {
                // 校验服务端实际起点：错位续传比失败更危险（静默数据损坏）。
                let content_range = res
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .map(ToOwned::to_owned);
                let served_start = content_range
                    .as_deref()
                    .and_then(Self::parse_content_range_start);
                match served_start {
                    Some(start) if start == resume_from => resume_from,
                    _ => {
                        return Err(AppError::network(format!(
                            "WebDAV 服务端返回的续传起点与请求不一致（fail-closed，拒绝错位追加）：请求 bytes={resume_from}-，Content-Range={content_range:?}"
                        )));
                    }
                }
            }
            // 服务端不支持/忽略 Range：诚实从零重下，不冒充续传。
            StatusCode::OK => 0,
            status => {
                return Err(AppError::network(format!(
                    "WebDAV 续传下载失败: {} {}",
                    status,
                    status.canonical_reason().unwrap_or(""),
                )));
            }
        };

        if actual_start == 0 && resume_from > 0 {
            tracing::warn!(
                "WebDAV 服务端未按 Range 续传（HTTP 200），已丢弃本地断点从零重下: {}",
                key
            );
        }

        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        let mut file = if actual_start > 0 {
            let file = tokio::fs::OpenOptions::new()
                .append(true)
                .open(dest)
                .await
                .map_err(|e| AppError::file_system(format!("打开断点文件失败: {e}")))?;
            let existing = file
                .metadata()
                .await
                .map_err(|e| AppError::file_system(format!("读取断点文件元信息失败: {e}")))?
                .len();
            if existing != actual_start {
                return Err(AppError::file_system(format!(
                    "断点文件大小（{existing} 字节）与续传起点（{actual_start} 字节）不一致，拒绝错位追加"
                )));
            }
            file
        } else {
            tokio::fs::File::create(dest)
                .await
                .map_err(|e| AppError::file_system(format!("创建下载文件失败: {e}")))?
        };

        let mut written = actual_start;
        let mut stream = res.bytes_stream();
        loop {
            // 与 get_file 相同的逐块停滞保护：90 秒收不到任何数据视为死连接。
            // 中断时已写入的字节保持为前缀完整的断点，供下次续传。
            let next = tokio::time::timeout(std::time::Duration::from_secs(90), stream.next())
                .await
                .map_err(|_| {
                    AppError::network(
                        "WebDAV 续传下载停滞超过 90 秒，连接可能已断开（已写入的断点保留，可重试续传）"
                            .to_string(),
                    )
                })?;
            let Some(chunk) = next else {
                break;
            };
            let bytes = chunk.map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
            if written + bytes.len() as u64 > total_size {
                return Err(AppError::validation(format!(
                    "云端对象返回超过声明大小（{total_size} 字节）的数据，拒绝写入（对象可能已被并发修改）"
                )));
            }
            file.write_all(&bytes)
                .await
                .map_err(|e| AppError::file_system(format!("写入文件失败: {e}")))?;
            written += bytes.len() as u64;
            if let Some(cb) = progress.as_ref() {
                cb(written, total_size);
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::file_system(format!("刷新文件失败: {e}")))?;
        file.sync_all()
            .await
            .map_err(|e| AppError::file_system(format!("同步文件失败: {e}")))?;

        // 禁止静默截断当成功：字节数不足即失败，断点保留。
        if written != total_size {
            return Err(AppError::network(format!(
                "WebDAV 下载在 {written}/{total_size} 字节处中断（已写入的断点保留，可重试续传）"
            )));
        }
        Ok(actual_start)
    }

    fn supports_prefix_read(&self) -> bool {
        true
    }

    /// [R5-prove-cost] 基于 HTTP Range 的对象前缀读取（`bytes=0-{prefix_len-1}`）。
    ///
    /// 诚实语义：
    /// - 206 → 校验 `Content-Range` 起点必须为 0（错位 fail-closed，绝不把
    ///   中段字节冒充前缀）；
    /// - 200（服务端忽略 Range）→ 从响应流只取前 `prefix_len` 字节后停止消费
    ///   并丢弃连接，不整包读入内存；
    /// - 416（对象为空时对 Range 的合法应答）→ 诚实返回空前缀；
    /// - 404 → `Ok(None)`。
    async fn get_prefix(&self, key: &str, prefix_len: u64) -> Result<Option<Vec<u8>>> {
        if prefix_len == 0 {
            return Ok(Some(Vec::new()));
        }
        let url = self.build_url(key)?;
        let builder = self
            .http
            .request(Method::GET, url)
            .header("Authorization", self.auth_header())
            .header(
                reqwest::header::RANGE,
                format!("bytes=0-{}", prefix_len - 1),
            );
        let res = tokio::time::timeout(std::time::Duration::from_secs(120), builder.send())
            .await
            .map_err(|_| AppError::network("WebDAV 前缀读取等待响应头超时（120 秒）".to_string()))?
            .map_err(|e| AppError::network(format!("WebDAV 前缀读取请求失败: {e}")))?;

        match res.status() {
            StatusCode::NOT_FOUND => return Ok(None),
            StatusCode::RANGE_NOT_SATISFIABLE => return Ok(Some(Vec::new())),
            StatusCode::PARTIAL_CONTENT => {
                // 起点必须是 0：错位前缀比失败更危险（试解结论会失真）。
                let content_range = res
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let served_start = content_range
                    .as_deref()
                    .and_then(Self::parse_content_range_start);
                if served_start != Some(0) {
                    return Err(AppError::network(format!(
                        "WebDAV 服务端返回的前缀起点不是 0（fail-closed，拒绝错位字节）：\
                         请求 bytes=0-，Content-Range={content_range:?}"
                    )));
                }
            }
            // 服务端忽略 Range 返回整对象：下方只消费前 prefix_len 字节后丢弃连接。
            StatusCode::OK => {}
            status => {
                return Err(AppError::network(format!(
                    "WebDAV 前缀读取失败: {} {}",
                    status,
                    status.canonical_reason().unwrap_or("")
                )));
            }
        }

        // 有界缓冲：只收前 prefix_len 字节；预分配封顶 8 MiB，防御异常大的
        // prefix_len 造成一次性大分配（正常首块试解 ≈ 1 MiB + 60 B）。
        let mut prefix: Vec<u8> =
            Vec::with_capacity(usize::try_from(prefix_len.min(8 * 1024 * 1024)).unwrap_or(0));
        let mut stream = res.bytes_stream();
        while (prefix.len() as u64) < prefix_len {
            // 与 get_file 相同的逐块停滞保护：90 秒收不到任何数据视为死连接。
            let next = tokio::time::timeout(std::time::Duration::from_secs(90), stream.next())
                .await
                .map_err(|_| {
                    AppError::network("WebDAV 前缀读取停滞超过 90 秒，连接可能已断开".to_string())
                })?;
            let Some(chunk) = next else {
                break; // 对象比 prefix_len 短：诚实返回实际前缀
            };
            let bytes = chunk.map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
            let need = usize::try_from(prefix_len - prefix.len() as u64)
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            prefix.extend_from_slice(&bytes[..need]);
        }
        // 收满即返回；res/stream 随作用域丢弃，剩余响应体不再消费。
        Ok(Some(prefix))
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
        // [R4-get-budget] 无预算旧入口：仅兜底默认预算，防止彻底无界。
        // 控制对象请改走 get_bounded 并由调用方传入硬预算。
        self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES).await
    }

    async fn get_bounded(&self, key: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
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

        // get()/get_bounded 用于 manifest/变更文件等内存级对象：按块停滞超时，
        // 防止响应头通过后响应体半挂死。慢但有进展的分片不受总时长限制。
        let declared = res.content_length();
        // [R4-get-budget] 声明长度超预算：先拒，不读任何响应体字节。
        ensure_declared_len_within_budget("WebDAV", key, declared, max_bytes)?;
        let mut stream = res.bytes_stream();
        // [R4-get-budget] chunked/无 Content-Length 响应走有界缓冲：
        // 累计将越界的那一块立即断流，缓冲占用永不超过预算。
        let mut body = BoundedMemoryBody::new("WebDAV", key, max_bytes);
        loop {
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(MEMORY_GET_STALL_SECS),
                stream.next(),
            )
            .await
            .map_err(|_| {
                AppError::network("WebDAV 内存对象下载停滞超过 90 秒，连接可能已断开".to_string())
            })?;
            let Some(chunk) = next else {
                break;
            };
            let bytes = chunk.map_err(|e| AppError::network(format!("读取响应体失败: {e}")))?;
            body.push(&bytes)?;
        }
        ensure_memory_get_matches_declared_len("WebDAV", key, body.len(), declared)?;
        Ok(Some(body.into_bytes()))
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

            let (files, subdirs, response_count) =
                self.parse_propfind_entries(&xml, prefix, &dir)?;

            if Self::is_suspicious_response_count(response_count) {
                tracing::error!(
                    "[WebDAV] PROPFIND 返回 {} 个 response（疑似服务端分页上限），\
                     目录 '{}' 下可能有未列出的文件",
                    response_count,
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

        let files = self.parse_propfind_response(&xml, "")?;
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

    // ============================================================
    // 进程内假 WebDAV 服务器（基于 hyper，不依赖 Docker/外部账号）
    // ============================================================

    /// (状态码, 响应头, 响应体)
    type FakeResponse = (u16, Vec<(&'static str, String)>, String);
    /// (method, path, 全局请求序号) -> 响应
    type Responder = Arc<dyn Fn(&str, &str, usize) -> FakeResponse + Send + Sync>;
    type RequestLog = Arc<Mutex<Vec<(String, String)>>>;

    async fn spawn_fake_dav(responder: Responder) -> (String, RequestLog) {
        use std::sync::atomic::AtomicUsize;

        let log: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(AtomicUsize::new(0));
        let log_for_svc = log.clone();

        let make_svc = hyper::service::make_service_fn(move |_conn| {
            let responder = responder.clone();
            let log = log_for_svc.clone();
            let counter = counter.clone();
            async move {
                Ok::<_, std::convert::Infallible>(hyper::service::service_fn(move |req| {
                    let responder = responder.clone();
                    let log = log.clone();
                    let counter = counter.clone();
                    async move {
                        let method = req.method().as_str().to_string();
                        let path = req.uri().path().to_string();
                        let idx = counter.fetch_add(1, Ordering::SeqCst);
                        log.lock().unwrap().push((method.clone(), path.clone()));
                        let _ = hyper::body::to_bytes(req.into_body()).await;
                        let (status, headers, body) = responder(&method, &path, idx);
                        let mut builder = hyper::Response::builder().status(status);
                        for (name, value) in headers {
                            builder = builder.header(name, value);
                        }
                        Ok::<_, std::convert::Infallible>(
                            builder
                                .body(hyper::Body::from(body))
                                .expect("build fake response"),
                        )
                    }
                }))
            }
        });

        let server =
            hyper::Server::bind(&std::net::SocketAddr::from(([127, 0, 0, 1], 0))).serve(make_svc);
        let endpoint = format!("http://{}/", server.local_addr());
        tokio::spawn(server);
        (endpoint, log)
    }

    fn storage_for(endpoint: &str, root: &str) -> WebDavStorage {
        WebDavStorage::new(
            WebDavConfig {
                endpoint: endpoint.to_string(),
                username: "user".to_string(),
                password: "pass".to_string(),
            },
            root.to_string(),
        )
        .expect("create storage for fake server")
    }

    /// 构造 Depth:1 PROPFIND 的 multistatus 响应：集合自身 + entry_count 个文件。
    fn multistatus_xml(collection_href: &str, entry_count: usize) -> String {
        let mut xml = String::from(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">"#);
        xml.push_str(&format!(
            "<d:response><d:href>{collection_href}</d:href><d:propstat><d:prop>\
             <d:resourcetype><d:collection/></d:resourcetype></d:prop>\
             <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        ));
        for i in 0..entry_count {
            xml.push_str(&format!(
                "<d:response><d:href>{collection_href}file-{i}.txt</d:href>\
                 <d:propstat><d:prop><d:resourcetype/>\
                 <d:getcontentlength>10</d:getcontentlength>\
                 <d:getlastmodified>Fri, 01 Jan 2021 00:00:00 GMT</d:getlastmodified>\
                 </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            ));
        }
        xml.push_str("</d:multistatus>");
        xml
    }

    fn count_method(log: &RequestLog, method: &str) -> usize {
        log.lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }

    fn file_propfind_xml(href: &str, size: u64) -> String {
        format!(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">\
<d:response><d:href>{href}</d:href><d:propstat><d:prop>\
<d:resourcetype/><d:getcontentlength>{size}</d:getcontentlength>\
<d:getlastmodified>Fri, 01 Jan 2021 00:00:00 GMT</d:getlastmodified>\
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>\
</d:multistatus>"#
        )
    }

    // ---------- 重试与 Retry-After ----------

    #[test]
    fn retry_after_parsing_and_cap() {
        // 秒数格式
        assert_eq!(
            WebDavStorage::parse_retry_after("3"),
            Some(Duration::from_secs(3))
        );
        assert_eq!(WebDavStorage::parse_retry_after("garbage"), None);

        // 6 小时的 Retry-After 必须封顶，不能让同步挂起数小时
        let mut headers = HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "21600".parse().unwrap());
        assert_eq!(
            WebDavStorage::capped_retry_after(&headers),
            Some(MAX_RETRY_WAIT)
        );

        // HTTP-date 格式
        let future = (Utc::now() + chrono::Duration::seconds(10)).to_rfc2822();
        let parsed = WebDavStorage::parse_retry_after(&future).expect("parse http-date");
        assert!(parsed <= Duration::from_secs(10) && parsed >= Duration::from_secs(7));

        // 过去的时间点无效，交给指数退避兜底
        let past = (Utc::now() - chrono::Duration::seconds(60)).to_rfc2822();
        assert_eq!(WebDavStorage::parse_retry_after(&past), None);

        // 指数退避同样封顶
        assert_eq!(WebDavStorage::backoff_delay(30), MAX_RETRY_WAIT);
    }

    #[tokio::test]
    async fn retries_retryable_statuses_and_respects_retry_after() {
        for status in [423u16, 429, 500, 502, 503, 504] {
            let responder: Responder = Arc::new(move |_method, _path, idx| {
                if idx == 0 {
                    (
                        status,
                        vec![("Retry-After", "0".to_string())],
                        String::new(),
                    )
                } else {
                    (200, vec![], "payload".to_string())
                }
            });
            let (endpoint, log) = spawn_fake_dav(responder).await;
            let storage = storage_for(&endpoint, "sync");

            let data = storage
                .get("obj.bin")
                .await
                .unwrap_or_else(|e| panic!("status={status} 应重试后成功: {e}"));
            assert_eq!(data, Some(b"payload".to_vec()), "status={status}");
            assert_eq!(
                count_method(&log, "GET"),
                2,
                "status={status} 应恰好重试一次"
            );
        }
    }

    #[tokio::test]
    async fn does_not_retry_deterministic_client_errors() {
        let responder: Responder = Arc::new(|_m, _p, _i| (403, vec![], String::new()));
        let (endpoint, log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage.get("obj.bin").await.expect_err("403 必须立即失败");
        assert_eq!(count_method(&log, "GET"), 1, "确定性 4xx 不应重试");
    }

    #[tokio::test]
    async fn retry_is_bounded_when_server_keeps_failing() {
        let responder: Responder =
            Arc::new(|_m, _p, _i| (503, vec![("Retry-After", "0".to_string())], String::new()));
        let (endpoint, log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage
            .get("obj.bin")
            .await
            .expect_err("持续 503 重试耗尽后必须失败");
        assert_eq!(count_method(&log, "GET"), 3, "重试必须有界（3 次尝试）");
    }

    #[tokio::test]
    async fn put_file_retries_on_503_with_retry_after() {
        use std::sync::atomic::AtomicUsize;

        let put_hits = Arc::new(AtomicUsize::new(0));
        let put_hits_in_responder = put_hits.clone();
        let responder: Responder = Arc::new(move |method, path, _idx| match method {
            "MKCOL" => (405, vec![], String::new()),
            "PUT" => {
                if put_hits_in_responder.fetch_add(1, Ordering::SeqCst) == 0 {
                    (503, vec![("Retry-After", "0".to_string())], String::new())
                } else {
                    (201, vec![], String::new())
                }
            }
            "PROPFIND" => (207, vec![], file_propfind_xml(path, 17)),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        let dir = tempfile::tempdir().expect("tempdir");
        let local = dir.path().join("upload.bin");
        std::fs::write(&local, b"streaming payload").expect("write local file");

        storage
            .put_file("objects/upload.bin", &local, None)
            .await
            .expect("流式 PUT 应在 503 后重试成功");
        assert_eq!(put_hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn put_file_fails_when_propfind_size_mismatches() {
        use std::sync::atomic::AtomicUsize;

        let delete_hits = Arc::new(AtomicUsize::new(0));
        let delete_hits_in_responder = delete_hits.clone();
        let responder: Responder = Arc::new(move |method, path, _idx| match method {
            "MKCOL" => (405, vec![], String::new()),
            "PUT" => (201, vec![], String::new()),
            "PROPFIND" => (207, vec![], file_propfind_xml(path, 1)),
            "DELETE" => {
                delete_hits_in_responder.fetch_add(1, Ordering::SeqCst);
                (204, vec![], String::new())
            }
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        let dir = tempfile::tempdir().expect("tempdir");
        let local = dir.path().join("upload.bin");
        std::fs::write(&local, b"streaming payload").expect("write local file");

        let error = storage
            .put_file("objects/upload.bin", &local, None)
            .await
            .expect_err("远端短写必须 fail-closed");
        assert!(
            error.to_string().contains("云端对象上传后大小不一致"),
            "拒绝原因必须指向远端大小，实际: {error}"
        );
        assert!(
            delete_hits.load(Ordering::SeqCst) >= 1,
            "短包必须删除，不得留给后续调用方当成功对象"
        );
    }

    // ---------- check_connection：PROPFIND Depth:0 ----------

    #[tokio::test]
    async fn check_connection_survives_collection_get_501() {
        // Nextcloud/sabre-dav 对集合的 GET 返回 501 Not Implemented；
        // 探测必须走 PROPFIND Depth:0，不能被 GET 501 误报为连接失败。
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (405, vec![], String::new()),
            "PROPFIND" => (207, vec![], multistatus_xml("/sync/", 0)),
            "GET" => (501, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage
            .check_connection()
            .await
            .expect("集合 GET 501 的服务器不应被误报为连接失败");
        assert!(count_method(&log, "PROPFIND") >= 1, "探测应使用 PROPFIND");
        assert_eq!(count_method(&log, "GET"), 0, "PROPFIND 成功时不应回退 GET");
    }

    #[tokio::test]
    async fn check_connection_fails_when_mkcol_rejected_and_root_missing() {
        // MKCOL 确定性失败（403 权限拒绝 / 507 配额耗尽 / 重试耗尽的持续 5xx）
        // 且 PROPFIND 仍 404：同步根目录既不存在也创建不了，后续同步必然失败，
        // 不得报连接成功。
        for mkcol_status in [403u16, 507, 500] {
            let responder: Responder = Arc::new(move |method, _path, _idx| match method {
                // Retry-After: 0 让 500 的有界重试立即耗尽，避免测试等退避
                "MKCOL" => (
                    mkcol_status,
                    vec![("Retry-After", "0".to_string())],
                    String::new(),
                ),
                "PROPFIND" => (404, vec![], String::new()),
                _ => (500, vec![], String::new()),
            });
            let (endpoint, log) = spawn_fake_dav(responder).await;
            let storage = storage_for(&endpoint, "sync");

            let err = storage.check_connection().await.expect_err(&format!(
                "MKCOL {mkcol_status} + PROPFIND 404 不得报连接成功"
            ));
            assert!(
                err.to_string().contains("无法创建"),
                "mkcol_status={mkcol_status} 错误信息应说明目录无法创建: {err}"
            );
            assert!(count_method(&log, "MKCOL") >= 1);
            assert!(count_method(&log, "PROPFIND") >= 1);
        }
    }

    #[tokio::test]
    async fn check_connection_tolerates_404_when_mkcol_succeeds() {
        // MKCOL 正常（目录已建）而 PROPFIND 仍 404（个别服务的最终一致窗口）
        // 保持原有容忍语义：服务器可达、认证通过，视为连接正常。
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (201, vec![], String::new()),
            "PROPFIND" => (404, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage
            .check_connection()
            .await
            .expect("MKCOL 成功时 PROPFIND 404 仍应视为连接正常");
    }

    #[tokio::test]
    async fn check_connection_fails_when_mkcol_chain_conflicts_and_root_missing() {
        // 整链 MKCOL 都 409（父目录缺失、什么都没建成）且 PROPFIND 404：
        // 同步根目录既不存在也建不成，不得报连接成功。
        // 此前 409 被无条件容忍（部分服务用它表示"已存在"），导致该场景漏报。
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (409, vec![], String::new()),
            "PROPFIND" => (404, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync/nested");

        let err = storage
            .check_connection()
            .await
            .expect_err("整链 MKCOL 409 + PROPFIND 404 不得报连接成功");
        assert!(
            err.to_string().contains("409") && err.to_string().contains("无法创建"),
            "错误信息应说明 409 冲突导致目录无法创建: {err}"
        );
        assert_eq!(count_method(&log, "MKCOL"), 2, "两段路径各发一次 MKCOL");
    }

    #[tokio::test]
    async fn check_connection_tolerates_409_when_root_exists() {
        // 部分服务对已存在目录的 MKCOL 返回 409：只要 PROPFIND 证实目录
        // 存在，409 就无害，不得因此报失败（回归保护）。
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (409, vec![], String::new()),
            "PROPFIND" => (207, vec![], multistatus_xml("/sync/", 0)),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage
            .check_connection()
            .await
            .expect("MKCOL 409 但目录确实存在时应视为连接正常");
    }

    #[tokio::test]
    async fn check_connection_deeper_mkcol_success_clears_earlier_conflict() {
        // 浅层段 409（该服务用 409 表示已存在）、末段 201 建成：
        // 链路末端成功证明根目录存在，早前的 409 不应再触发失败，
        // 即使 PROPFIND 因最终一致窗口暂时 404。
        let responder: Responder = Arc::new(|method, path, _idx| match method {
            "MKCOL" if path == "/a/" => (409, vec![], String::new()),
            "MKCOL" => (201, vec![], String::new()),
            "PROPFIND" => (404, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "a/b");

        storage
            .check_connection()
            .await
            .expect("末段 MKCOL 成功后早前 409 不应导致探活失败");
    }

    #[tokio::test]
    async fn check_connection_reports_lock_and_rate_limit_instead_of_create_failure() {
        // MKCOL 重试耗尽后仍持续 423/429 且 PROPFIND 404：探活必须失败，
        // 但 423/429 是瞬时状态（锁定/限流），文案不得误导为
        // "目录无法创建"的确定性结论。
        for (status, keyword) in [(423u16, "锁定"), (429, "限流")] {
            let responder: Responder = Arc::new(move |method, _path, _idx| match method {
                // Retry-After: 0 让有界重试立即耗尽，避免测试等退避
                "MKCOL" => (
                    status,
                    vec![("Retry-After", "0".to_string())],
                    String::new(),
                ),
                "PROPFIND" => (404, vec![], String::new()),
                _ => (500, vec![], String::new()),
            });
            let (endpoint, _log) = spawn_fake_dav(responder).await;
            let storage = storage_for(&endpoint, "sync");

            let err = storage
                .check_connection()
                .await
                .expect_err(&format!("MKCOL {status} + PROPFIND 404 不得报连接成功"));
            let msg = err.to_string();
            assert!(
                msg.contains(keyword),
                "status={status} 错误信息应提示{keyword}: {msg}"
            );
            assert!(
                msg.contains("稍后重试"),
                "status={status} 错误信息应建议稍后重试: {msg}"
            );
            assert!(
                !msg.contains("无法创建"),
                "status={status} 不应误导为确定性的「无法创建目录」: {msg}"
            );
        }
    }

    #[tokio::test]
    async fn check_connection_get_fallback_404_fails_when_mkcol_rejected() {
        // PROPFIND 不可用（501）走 GET 回退时，GET 404 的容忍同样以
        // MKCOL 未确定性失败为前提，否则与主路径判定不一致。
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (403, vec![], String::new()),
            "PROPFIND" => (501, vec![], String::new()),
            "GET" => (404, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, _log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage
            .check_connection()
            .await
            .expect_err("MKCOL 403 + GET 回退 404 不得报连接成功");
    }

    // ---------- 目录缓存 ----------

    #[tokio::test]
    async fn directory_cache_skips_repeat_mkcol() {
        let responder: Responder = Arc::new(|method, _path, _idx| match method {
            "MKCOL" => (201, vec![], String::new()),
            "PUT" => (201, vec![], String::new()),
            _ => (500, vec![], String::new()),
        });
        let (endpoint, log) = spawn_fake_dav(responder).await;
        let storage = storage_for(&endpoint, "sync");

        storage.put("a/b/one.bin", b"1").await.expect("first put");
        assert_eq!(
            count_method(&log, "MKCOL"),
            3,
            "首次 PUT 建链：sync、sync/a、sync/a/b"
        );

        storage.put("a/b/two.bin", b"2").await.expect("second put");
        assert_eq!(
            count_method(&log, "MKCOL"),
            3,
            "同目录第二次 PUT 不应重发任何 MKCOL"
        );

        storage.put("a/c/three.bin", b"3").await.expect("third put");
        assert_eq!(
            count_method(&log, "MKCOL"),
            4,
            "新子目录只需补发缺失的一段 MKCOL"
        );
    }

    // ---------- 整百截断启发式 ----------

    #[test]
    fn suspicious_response_count_boundaries() {
        // 99/100/101 个真实条目（+ 集合自身 = 100/101/102 个 response）
        // 不再是截断信号——修复整百假阳性
        assert!(!WebDavStorage::is_suspicious_response_count(100));
        assert!(!WebDavStorage::is_suspicious_response_count(101));
        assert!(!WebDavStorage::is_suspicious_response_count(102));
        assert!(!WebDavStorage::is_suspicious_response_count(200));
        assert!(!WebDavStorage::is_suspicious_response_count(500));
        // 坚果云 750 响应边界仍然 fail-closed
        assert!(WebDavStorage::is_suspicious_response_count(750));
        assert!(WebDavStorage::is_suspicious_response_count(751));
        assert!(!WebDavStorage::is_suspicious_response_count(749));
        assert!(!WebDavStorage::is_suspicious_response_count(752));
        // 千级网关边界收紧为 1000/1001 单档（与 750/751 对称）
        assert!(WebDavStorage::is_suspicious_response_count(1000));
        assert!(WebDavStorage::is_suspicious_response_count(1001));
        assert!(!WebDavStorage::is_suspicious_response_count(999));
        assert!(!WebDavStorage::is_suspicious_response_count(1002));
        // 1999/2000 个真实条目（+ 集合自身 = 2000/2001 个 response）
        // 不再是截断信号——修复千倍数假阳性
        assert!(!WebDavStorage::is_suspicious_response_count(1999));
        assert!(!WebDavStorage::is_suspicious_response_count(2000));
        assert!(!WebDavStorage::is_suspicious_response_count(2001));
        assert!(!WebDavStorage::is_suspicious_response_count(3000));
        assert!(!WebDavStorage::is_suspicious_response_count(3001));
    }

    #[tokio::test]
    async fn list_outcome_truncation_matrix_via_fake_server() {
        // 需求矩阵：750 个条目 → truncated；99/100/101/1999/2000 → 不截断
        for (entries, expected_truncated) in [
            (99usize, false),
            (100, false),
            (101, false),
            (750, true),
            (1999, false),
            (2000, false),
        ] {
            let xml = multistatus_xml("/sync/", entries);
            let responder: Responder = Arc::new(move |method, _path, _idx| {
                assert_eq!(method, "PROPFIND", "列举只应使用 PROPFIND");
                (
                    207,
                    vec![("Content-Type", "application/xml; charset=utf-8".to_string())],
                    xml.clone(),
                )
            });
            let (endpoint, _log) = spawn_fake_dav(responder).await;
            let storage = storage_for(&endpoint, "sync");

            let outcome = storage.list_outcome("").await.expect("list_outcome");
            assert_eq!(outcome.files.len(), entries, "entries={entries}");
            assert_eq!(
                outcome.truncated, expected_truncated,
                "entries={entries} 的 truncated 判定错误"
            );
        }
    }

    /// [#57 回归] 坚果云中文同步文件夹：endpoint 路径含非 ASCII 字符时，
    /// `Url` 内部保存百分号编码形式，而服务器返回的 href 同样是编码形式。
    /// 两侧必须统一解码后比较，否则所有文件被静默丢弃——
    /// 上传正常、下载/双向同步永远列举到 0 个文件。
    #[test]
    fn extract_relative_key_decodes_non_ascii_endpoint_path() {
        let storage = WebDavStorage::new(
            WebDavConfig {
                endpoint: "https://dav.jianguoyun.com/dav/我的坚果云/".to_string(),
                username: "user".to_string(),
                password: "pass".to_string(),
            },
            "deep-student-sync".to_string(),
        )
        .expect("create storage");
        // Url 内部把中文路径存成百分号编码
        assert!(storage.base_url.path().contains('%'));

        // 服务器返回编码的路径形式 href（多数 WebDAV 服务的行为）
        assert_eq!(
            storage.extract_relative_key(
                "/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/data_governance/changes/device-a/000000000001-1723372800-nonce.json.zst",
                "data_governance/changes"
            ),
            "data_governance/changes/device-a/000000000001-1723372800-nonce.json.zst"
        );

        // 绝对 URL 形式 href（RFC 4918 同样允许）
        assert_eq!(
            storage.extract_relative_key(
                "https://dav.jianguoyun.com/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/manifests/device-a.json",
                ""
            ),
            "manifests/device-a.json"
        );

        // 服务器直接返回未编码 UTF-8 href（部分自建 WebDAV 的行为）
        assert_eq!(
            storage.extract_relative_key(
                "/dav/我的坚果云/deep-student-sync/backups/20260801.zip",
                "backups"
            ),
            "backups/20260801.zip"
        );

        // 根目录自身应归一化为空 key
        assert_eq!(
            storage.extract_relative_key(
                "/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/",
                ""
            ),
            ""
        );
    }

    /// [#57 回归] endpoint 路径含空格（编码为 %20）时同样不能丢文件，
    /// 且返回的 key 是解码后的形式，可直接交给 build_url 重新编码请求。
    #[test]
    fn extract_relative_key_decodes_space_in_endpoint_path() {
        let storage = WebDavStorage::new(
            WebDavConfig {
                endpoint: "http://localhost:8080/My%20Dav/".to_string(),
                username: "user".to_string(),
                password: "pass".to_string(),
            },
            "sync root".to_string(),
        )
        .expect("create storage");

        let key =
            storage.extract_relative_key("/My%20Dav/sync%20root/objects/a%20b.txt", "objects");
        assert_eq!(key, "objects/a b.txt");
        // 解码后的 key 经 build_url 逐段推入时会被重新百分号编码
        assert_eq!(
            storage.build_url(&key).unwrap().path(),
            "/My%20Dav/sync%20root/objects/a%20b.txt"
        );
    }

    /// [#57 回归] 端到端：解析坚果云风格（编码 href + Depth:1）的 PROPFIND
    /// multistatus，非 ASCII endpoint 路径下必须能发现子目录并提取文件 key。
    #[test]
    fn parse_propfind_entries_with_encoded_hrefs_lists_files_and_subdirs() {
        let storage = WebDavStorage::new(
            WebDavConfig {
                endpoint: "https://dav.jianguoyun.com/dav/我的坚果云/".to_string(),
                username: "user".to_string(),
                password: "pass".to_string(),
            },
            "deep-student-sync".to_string(),
        )
        .expect("create storage");

        let base = "/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync";
        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>{base}/data_governance/changes/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>{base}/data_governance/changes/device-a/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>{base}/data_governance/changes/instance.json</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>42</d:getcontentlength>
      <d:getlastmodified>Fri, 07 Aug 2026 08:00:00 GMT</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#
        );

        let (files, subdirs, response_count) = storage
            .parse_propfind_entries(&xml, "data_governance/changes", "data_governance/changes")
            .expect("parse entries");

        assert_eq!(response_count, 3);
        assert_eq!(
            subdirs,
            vec!["data_governance/changes/device-a".to_string()],
            "编码 href 下必须仍能发现待递归的子目录"
        );
        assert_eq!(files.len(), 1, "编码 href 下文件不能被静默丢弃");
        assert_eq!(files[0].key, "data_governance/changes/instance.json");
        assert_eq!(files[0].size, 42);
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
        assert!(
            source.contains("fn decode_path"),
            "WebDAV href/base comparison must decode percent-encoded paths"
        );
        assert!(
            source.contains("map(Self::decode_path)"),
            "WebDAV URL builder must decode base segments before a single encode"
        );
        assert!(
            source.contains("self.verify_remote_object_size(key, file_size)"),
            "WebDAV put_file must stat remote size after PUT; HTTP 2xx is not enough"
        );
        assert!(
            source.contains("ensure_memory_get_matches_declared_len(\"WebDAV\""),
            "WebDAV get() 必须按 Content-Length 拒绝半包，记录级/清单不得收下截断体"
        );
        assert!(
            source.contains("WebDAV 内存对象下载停滞超过 90 秒"),
            "WebDAV get() 必须按块停滞超时，不得只靠整段 300 秒总超时"
        );
        // [R4-get-budget] 预算三件套：声明预检、有界缓冲、旧入口兜底预算。
        assert!(
            source.contains("async fn get_bounded(&self, key: &str, max_bytes: u64)"),
            "WebDAV 必须实现带调用方硬预算的 get_bounded"
        );
        assert!(
            source.contains("ensure_declared_len_within_budget(\"WebDAV\""),
            "WebDAV get_bounded 必须在读响应体前按 Content-Length 预检预算"
        );
        assert!(
            source.contains("BoundedMemoryBody::new(\"WebDAV\""),
            "WebDAV get_bounded 必须用有界缓冲，无声明长度（chunked）也不得无界累积"
        );
        assert!(
            source.contains("self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)"),
            "WebDAV get() 旧入口必须走默认兜底预算，不得回到无界路径"
        );
    }
}
