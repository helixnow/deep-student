//! 内置 Web Fetch 工具执行器
//!
//! 参考业界 @anthropic/mcp-fetch 实现，提供网页内容抓取能力。
//!
//! ## 工具
//! - `builtin-web_fetch` - 抓取 URL 内容并转换为 Markdown
//!
//! ## 设计说明（对齐 @anthropic/mcp-fetch）
//! - 使用 reqwest 进行 HTTP 请求
//! - 使用 html2text 将 HTML 转换为纯文本（便于 LLM 理解）
//! - 支持分页读取（start_index + max_length）
//! - 截断时提供明确的继续获取提示（与官方一致）
//! - 清理干扰元素（script/style/nav/footer/aside/header 等）

use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use encoding_rs::Encoding;
use futures_util::{pin_mut, Stream, StreamExt};
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CONTENT_DISPOSITION, USER_AGENT,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::artifact_root;
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, ProviderObjectRef, TaskObjectHandle,
    TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 常量（对齐 @anthropic/mcp-fetch）
// ============================================================================

/// 默认最大返回字符数（官方默认 5000）
const DEFAULT_MAX_LENGTH: usize = 5000;
/// 默认起始索引
const DEFAULT_START_INDEX: usize = 0;
/// 请求超时时间（秒，官方 30s）
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// 最大内容长度（防止 OOM，官方 lt=1000000）
const MAX_CONTENT_LENGTH: usize = 1024 * 1024; // 1MB
/// URL binary files are materialized rather than decoded into model-visible text.
const MAX_BINARY_LENGTH: u64 = 64 * 1024 * 1024;
/// 默认 User-Agent（模仿官方格式）
const DEFAULT_USER_AGENT: &str =
    "DeepStudent/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
/// 最大重定向跳数（SSRF 安全跟随）
const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BinaryKind {
    mime: &'static str,
    extension: &'static str,
}

fn normalized_mime(content_type: &str) -> &str {
    content_type.split(';').next().unwrap_or("").trim()
}

fn docx_magic_matches(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return false;
    };
    let has_content_types = archive.by_name("[Content_Types].xml").is_ok();
    has_content_types
        && (0..archive.len()).any(|index| {
            archive.by_index(index).ok().is_some_and(|entry| {
                entry.name().starts_with("word/") && !entry.name().ends_with('/')
            })
        })
}

fn sniff_binary_kind(bytes: &[u8]) -> Option<BinaryKind> {
    let kind = if bytes.starts_with(b"%PDF-") {
        BinaryKind {
            mime: "application/pdf",
            extension: "pdf",
        }
    } else if docx_magic_matches(bytes) {
        BinaryKind {
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            extension: "docx",
        }
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        BinaryKind {
            mime: "image/png",
            extension: "png",
        }
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        BinaryKind {
            mime: "image/jpeg",
            extension: "jpg",
        }
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        BinaryKind {
            mime: "image/gif",
            extension: "gif",
        }
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        BinaryKind {
            mime: "image/webp",
            extension: "webp",
        }
    } else if bytes.starts_with(b"ID3")
        || bytes.starts_with(b"\xff\xfb")
        || bytes.starts_with(b"\xff\xf3")
        || bytes.starts_with(b"\xff\xf2")
    {
        BinaryKind {
            mime: "audio/mpeg",
            extension: "mp3",
        }
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        BinaryKind {
            mime: "audio/wav",
            extension: "wav",
        }
    } else if bytes.starts_with(b"OggS") {
        BinaryKind {
            mime: "audio/ogg",
            extension: "ogg",
        }
    } else if bytes.starts_with(b"fLaC") {
        BinaryKind {
            mime: "audio/flac",
            extension: "flac",
        }
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        BinaryKind {
            mime: "video/webm",
            extension: "webm",
        }
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        BinaryKind {
            mime: "video/mp4",
            extension: "mp4",
        }
    } else {
        return None;
    };
    Some(kind)
}

fn binary_header_family_matches(header: &str, kind: BinaryKind) -> bool {
    let header = normalized_mime(header).to_ascii_lowercase();
    header.is_empty()
        || header == "unknown"
        || header == "application/octet-stream"
        || header == "binary/octet-stream"
        || header == kind.mime
        || (kind.extension == "docx" && header == "application/zip")
        || (header.starts_with("image/") && kind.mime.starts_with("image/"))
        || (header.starts_with("audio/") && kind.mime.starts_with("audio/"))
        || (header.starts_with("video/") && kind.mime.starts_with("video/"))
        || (kind.extension == "mp4"
            && (header.starts_with("audio/") || header.starts_with("video/")))
}

fn sanitize_download_name(raw: &str, kind: BinaryKind) -> String {
    let leaf = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let mut stem: String = Path::new(leaf)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if stem.is_empty() || stem == "." || stem == ".." {
        stem = "download".into();
    }
    format!("{stem}.{}", kind.extension)
}

fn filename_from_headers_or_url(
    headers: &HeaderMap,
    url: &reqwest::Url,
    kind: BinaryKind,
) -> String {
    let from_header = headers
        .get(CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value.split(';').find_map(|part| {
                let (key, value) = part.trim().split_once('=')?;
                key.eq_ignore_ascii_case("filename")
                    .then(|| value.trim_matches(['\'', '"']).to_string())
            })
        });
    let raw = from_header
        .or_else(|| {
            url.path_segments()
                .and_then(|mut parts| parts.next_back())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "download".into());
    sanitize_download_name(&raw, kind)
}

// ============================================================================
// 预编译正则表达式（性能优化）
// ============================================================================

static RE_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap());
/// 移除 style 标签
static RE_STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap());
/// 移除 HTML 注释
static RE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
/// 移除 nav 导航
static RE_NAV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<nav[^>]*>.*?</nav>").unwrap());
/// 移除 footer 页脚
static RE_FOOTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<footer[^>]*>.*?</footer>").unwrap());
/// 移除 header 页眉
static RE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<header[^>]*>.*?</header>").unwrap());
/// 移除 aside 侧边栏
static RE_ASIDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<aside[^>]*>.*?</aside>").unwrap());
/// 移除 noscript 标签
static RE_NOSCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<noscript[^>]*>.*?</noscript>").unwrap());
/// 移除 iframe 标签
static RE_IFRAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<iframe[^>]*>.*?</iframe>").unwrap());
/// 移除 svg 标签
static RE_SVG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<svg[^>]*>.*?</svg>").unwrap());
/// 移除 form 表单
static RE_FORM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<form[^>]*>.*?</form>").unwrap());
/// 移除 dialog 对话框
static RE_DIALOG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<dialog[^>]*>.*?</dialog>").unwrap());
/// 移除 template 模板
static RE_TEMPLATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<template[^>]*>.*?</template>").unwrap());
/// 移除 object 嵌入对象
static RE_OBJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<object[^>]*>.*?</object>").unwrap());
/// 移除 embed 嵌入元素
static RE_EMBED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<embed[^>]*(?:/>|>.*?</embed>)").unwrap());
/// 移除 applet 遗留元素
static RE_APPLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<applet[^>]*>.*?</applet>").unwrap());
/// 提取 <article> 内容
static RE_ARTICLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<article[^>]*>(.*?)</article>").unwrap());
/// 提取 <main> 内容
static RE_MAIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<main[^>]*>(.*?)</main>").unwrap());
/// 压缩多余空行（预编译，替代 clean_markdown 中的运行时编译）
static RE_MULTI_NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

async fn collect_download_stream_limited<S, B, E>(
    stream: S,
    max_bytes: u64,
    initial_capacity: usize,
) -> Result<Vec<u8>, String>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut output =
        Vec::with_capacity(initial_capacity.min(max_bytes.min(usize::MAX as u64) as usize));
    pin_mut!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read download body: {}", e))?;
        let chunk = chunk.as_ref();
        let projected = (output.len() as u64)
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "Download size overflow".to_string())?;
        if projected > max_bytes {
            return Err(format!(
                "Download exceeded size limit ({} bytes > {} bytes)",
                projected, max_bytes
            ));
        }
        output.extend_from_slice(chunk);
    }
    Ok(output)
}

// ============================================================================
// 模块级辅助函数
// ============================================================================

/// SSRF 防护：检查 IP 是否为内网地址
///
/// 阻止访问以下地址：
/// - localhost / 127.0.0.1 (loopback)
/// - 私有 IP (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
/// - 链路本地地址 (169.254.x.x)
/// - 云元数据端点 (169.254.169.254)
/// - IPv6 唯一本地地址 (fc00::/7)
/// - IPv6 链路本地地址 (fe80::/10)
/// - IPv6 Site-local (fec0::/10) - 已废弃但部分系统仍支持
/// - 6to4 地址 (2002::/16) - 封装 IPv4，检查封装的 IPv4
/// - IPv4 映射的 IPv6 地址中的私有地址
fn is_internal_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback() ||
            ipv4.is_private() ||
            ipv4.is_link_local() ||
            // 云元数据端点 (AWS/GCP/Azure)
            ipv4.octets() == [169, 254, 169, 254]
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() ||
            // 唯一本地地址 (fc00::/7) - 类似 IPv4 私有地址
            (ipv6.segments()[0] & 0xfe00) == 0xfc00 ||
            // 链路本地地址 (fe80::/10)
            (ipv6.segments()[0] & 0xffc0) == 0xfe80 ||
            // Site-local (fec0::/10) - 已废弃但部分系统仍支持
            (ipv6.segments()[0] & 0xffc0) == 0xfec0 ||
            // 6to4 (2002::/16) - 封装 IPv4，检查封装的 IPv4 是否私有
            (ipv6.segments()[0] == 0x2002 && {
                let embedded_v4 = Ipv4Addr::new(
                    (ipv6.segments()[1] >> 8) as u8,
                    (ipv6.segments()[1] & 0xff) as u8,
                    (ipv6.segments()[2] >> 8) as u8,
                    (ipv6.segments()[2] & 0xff) as u8,
                );
                embedded_v4.is_private() || embedded_v4.is_loopback() || embedded_v4.is_link_local() ||
                embedded_v4.octets() == [169, 254, 169, 254]
            }) ||
            // IPv4 映射地址 (::ffff:x.x.x.x) - 检查映射的 IPv4 是否为私有
            ipv6.to_ipv4_mapped().map(|v4| {
                v4.is_private() || v4.is_loopback() || v4.is_link_local() ||
                v4.octets() == [169, 254, 169, 254]
            }).unwrap_or(false)
        }
    }
}

fn validate_public_url_target(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Unsupported final URL scheme: {}", url.scheme()));
    }
    let host = url.host_str().ok_or("Final URL has no host")?;
    let port = url
        .port()
        .unwrap_or(if url.scheme() == "https" { 443 } else { 80 });
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Final URL DNS resolution failed for '{host}': {error}"))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| is_internal_ip(&addr.ip())) {
        return Err("Blocked: final URL resolves to an internal IP address".to_string());
    }
    Ok(())
}

/// 从 Content-Type header 解析 charset 标签
///
/// 解析如 "text/html; charset=gbk" 的字符串，返回 charset 标签。
fn detect_charset_from_content_type(content_type: &str) -> Option<&str> {
    let lower = content_type.to_ascii_lowercase();
    if let Some(pos) = lower.find("charset=") {
        let start = pos + 8; // len("charset=")
        let rest = &content_type[start..];
        // 处理带引号的值: charset="utf-8"
        let charset = if rest.starts_with('"') {
            rest[1..].split('"').next().unwrap_or("")
        } else {
            rest.split(|c: char| c == ';' || c.is_whitespace())
                .next()
                .unwrap_or("")
        };
        if !charset.is_empty() {
            Some(charset)
        } else {
            None
        }
    } else {
        None
    }
}

/// 从 HTML meta 标签检测 charset（扫描前 1024 字节）
///
/// 支持:
/// - `<meta charset="xxx">`
/// - `<meta http-equiv="Content-Type" content="text/html; charset=xxx">`
fn detect_charset_from_html_meta(bytes: &[u8]) -> Option<String> {
    let scan_len = bytes.len().min(1024);
    // 以 Latin-1 方式解读，因为我们只查找 ASCII 模式
    let preview: String = bytes[..scan_len].iter().map(|&b| b as char).collect();
    let lower = preview.to_ascii_lowercase();

    if let Some(pos) = lower.find("charset=") {
        let start = pos + 8;
        let rest = &preview[start..];
        let charset = if rest.starts_with('"') {
            rest[1..].split('"').next().unwrap_or("")
        } else if rest.starts_with('\'') {
            rest[1..].split('\'').next().unwrap_or("")
        } else {
            rest.split(|c: char| c == ';' || c == '"' || c == '\'' || c == '>' || c.is_whitespace())
                .next()
                .unwrap_or("")
        };
        if !charset.is_empty() {
            return Some(charset.to_string());
        }
    }

    None
}

/// 使用检测到的 charset 解码字节，UTF-8 回退
///
/// 检测顺序：Content-Type header → HTML meta 标签 → UTF-8 → UTF-8 lossy
fn decode_bytes_with_charset(bytes: &[u8], content_type: &str) -> (String, String) {
    // 第一步：从 Content-Type header 解析 charset
    if let Some(charset_label) = detect_charset_from_content_type(content_type) {
        if let Some(encoding) = Encoding::for_label(charset_label.as_bytes()) {
            if encoding != encoding_rs::UTF_8 {
                let (decoded, _, had_errors) = encoding.decode(bytes);
                if !had_errors {
                    return (decoded.into_owned(), encoding.name().to_string());
                }
            }
        }
    }

    // 第二步：从 HTML meta 标签检测 charset
    if let Some(charset_label) = detect_charset_from_html_meta(bytes) {
        if let Some(encoding) = Encoding::for_label(charset_label.as_bytes()) {
            if encoding != encoding_rs::UTF_8 {
                let (decoded, _, had_errors) = encoding.decode(bytes);
                if !had_errors {
                    return (decoded.into_owned(), encoding.name().to_string());
                }
            }
        }
    }

    // 第三步：尝试 UTF-8（有效时零拷贝）
    match String::from_utf8(bytes.to_vec()) {
        Ok(s) => (s, "UTF-8".to_string()),
        Err(_) => {
            // 第四步：回退到 UTF-8 lossy
            (
                String::from_utf8_lossy(bytes).into_owned(),
                "UTF-8 (lossy)".to_string(),
            )
        }
    }
}

/// 检查内容是否看起来像 HTML（基于响应体检测）
///
/// 检查前 256 字符是否包含 HTML 标记，用于 Content-Type 不准确时的回退检测。
fn looks_like_html(content: &str) -> bool {
    let trimmed = content.trim_start();
    let prefix: String = trimmed.chars().take(256).collect();
    let lower = prefix.to_ascii_lowercase();
    lower.starts_with("<!doctype html")
        || lower.starts_with("<html")
        || lower.contains("<head")
        || lower.contains("<body")
}

/// 尝试从 <article> 或 <main> 标签提取主内容
///
/// 如果找到，返回最大匹配元素的内部内容。
/// 通过移除侧边栏、广告等外围内容，显著提升内容质量。
fn try_extract_main_content(html: &str) -> Option<String> {
    let mut best: Option<String> = None;

    // 优先尝试 <article>（语义更明确）
    for cap in RE_ARTICLE.captures_iter(html) {
        if let Some(content) = cap.get(1) {
            let text = content.as_str();
            if best.as_ref().is_none_or(|b| text.len() > b.len()) {
                best = Some(text.to_string());
            }
        }
    }

    // 如果没有 <article>，尝试 <main>
    if best.is_none() {
        for cap in RE_MAIN.captures_iter(html) {
            if let Some(content) = cap.get(1) {
                let text = content.as_str();
                if best.as_ref().is_none_or(|b| text.len() > b.len()) {
                    best = Some(text.to_string());
                }
            }
        }
    }

    // 仅当提取内容足够长时使用（>200 字符阈值）
    best.filter(|b| b.len() > 200)
}

// ============================================================================
// 内置 Fetch 工具执行器
// ============================================================================

/// 内置 Web Fetch 工具执行器
///
/// 处理 `builtin-web_fetch` 工具，抓取网页内容并转换为 Markdown。
pub struct FetchExecutor {
    /// HTTP 客户端
    client: reqwest::Client,
}

impl FetchExecutor {
    /// 创建新的 Fetch 执行器
    ///
    /// # Panics
    /// 如果无法创建安全的 HTTP 客户端，将 panic（这是启动时的致命错误）
    pub fn new() -> Self {
        // 构建带默认 headers 的 HTTP 客户端
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static(
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ),
        );
        headers.insert(
            ACCEPT_LANGUAGE,
            HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
        );

        // SSRF 安全重定向：使用自定义策略，每一跳验证目标 IP
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .default_headers(headers)
            // Redirect and destination checks resolve every target locally.
            // A system proxy could resolve a different address and bypass that
            // SSRF boundary, so this executor intentionally uses direct HTTP.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                // 限制最大重定向次数
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.stop();
                }

                // 解析重定向目标的 host 和 port
                let url = attempt.url();
                let host = match url.host_str() {
                    Some(h) => h,
                    None => return attempt.stop(),
                };
                let port = url
                    .port()
                    .unwrap_or(if url.scheme() == "https" { 443 } else { 80 });

                // 同步 DNS 解析（与初始请求检查一致的模式）
                let addrs: Vec<_> = match (host, port).to_socket_addrs() {
                    Ok(iter) => iter.collect(),
                    Err(_) => return attempt.stop(),
                };

                if addrs.is_empty() {
                    return attempt.stop();
                }

                // 检查所有解析的 IP 是否为内网地址
                for addr in &addrs {
                    if is_internal_ip(&addr.ip()) {
                        return attempt.stop();
                    }
                }

                attempt.follow()
            }))
            .build()
            .expect("Failed to create HTTP client with security settings - this is a fatal error");

        Self { client }
    }

    /// 下载 HTTPS URL 的原始字节（SSRF 防护 + 大小上限），供 skill_install 等工具复用。
    pub(crate) async fn download_https_bytes(
        &self,
        url: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, String> {
        let parsed_url =
            reqwest::Url::parse(url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
        if parsed_url.scheme() != "https" {
            return Err(format!(
                "Only https:// URLs are supported for binary download, got: {}",
                parsed_url.scheme()
            ));
        }

        let host = parsed_url.host_str().ok_or("Invalid URL: no host")?;
        let port = parsed_url.port().unwrap_or(443);
        let addrs: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("DNS resolution failed for '{}': {}", host, e))?
            .collect();
        if addrs.is_empty() {
            return Err(format!(
                "DNS resolution returned no addresses for '{}'",
                host
            ));
        }
        for addr in &addrs {
            if is_internal_ip(&addr.ip()) {
                return Err("Blocked: URL resolves to internal IP address".to_string());
            }
        }

        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Failed to download URL '{}': {}", url, e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Download failed with HTTP {} for '{}'",
                response.status(),
                url
            ));
        }

        if let Some(len) = response.content_length() {
            if len > max_bytes {
                return Err(format!(
                    "Download too large ({} bytes > {} bytes)",
                    len, max_bytes
                ));
            }
        }

        let initial_capacity = response
            .content_length()
            .unwrap_or(0)
            .min(usize::MAX as u64) as usize;
        collect_download_stream_limited(response.bytes_stream(), max_bytes, initial_capacity).await
    }

    fn materialize_binary(
        &self,
        ctx: &ExecutionContext,
        original_url: &str,
        final_url: &reqwest::Url,
        headers: &HeaderMap,
        bytes: &[u8],
        kind: BinaryKind,
    ) -> Result<Value, String> {
        let app = ctx.window_ref().app_handle();
        let root = artifact_root(app, &ctx.session_id, true)?;
        let directory = root.path.join("web-fetch");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Failed to create web-fetch artifact directory: {error}"))?;
        let root_canon = root
            .path
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize session artifact root: {error}"))?;
        let directory_canon = directory.canonicalize().map_err(|error| {
            format!("Failed to canonicalize web-fetch artifact directory: {error}")
        })?;
        if !directory_canon.starts_with(&root_canon) {
            return Err("Web fetch artifact directory escapes session root".into());
        }

        let requested_name = filename_from_headers_or_url(headers, final_url, kind);
        let sha256 = hex::encode(Sha256::digest(bytes));
        let requested_path = Path::new(&requested_name);
        let stem = requested_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download");
        let display_name = format!("{}-{}.{}", stem, &sha256[..12], kind.extension);
        let target = directory_canon.join(&display_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&target).map_err(|read_error| {
                    format!("Failed to read existing web-fetch artifact: {read_error}")
                })?;
                if Sha256::digest(&existing).as_slice() != Sha256::digest(bytes).as_slice() {
                    return Err("Web fetch artifact hash collision".into());
                }
                let relative_path = format!("web-fetch/{display_name}");
                return self.binary_artifact_result(
                    original_url,
                    final_url,
                    requested_name,
                    relative_path,
                    display_name,
                    sha256,
                    bytes.len() as u64,
                    kind,
                );
            }
            Err(error) => return Err(format!("Failed to create web-fetch artifact: {error}")),
        };
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to write web-fetch artifact: {error}"))?;
        let relative_path = format!("web-fetch/{display_name}");
        self.binary_artifact_result(
            original_url,
            final_url,
            requested_name,
            relative_path,
            display_name,
            sha256,
            bytes.len() as u64,
            kind,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn binary_artifact_result(
        &self,
        original_url: &str,
        final_url: &reqwest::Url,
        original_name: String,
        relative_path: String,
        display_name: String,
        sha256: String,
        size_bytes: u64,
        kind: BinaryKind,
    ) -> Result<Value, String> {
        let mut handle = TaskObjectHandle::new(
            format!("web-fetch:{sha256}"),
            TaskObjectKind::File,
            display_name.clone(),
            ObjectProvenance {
                source: "url_download".into(),
                source_uri: Some(final_url.to_string()),
                server: final_url.host_str().map(str::to_string),
                tool: Some("web_fetch".into()),
                derived_from: vec![original_url.to_string()],
                observed_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        handle.media_type = Some(kind.mime.into());
        handle.size_bytes = Some(size_bytes);
        handle.sha256 = Some(sha256.clone());
        handle.locator = Some(ManagedLocator::new("artifacts", &relative_path)?);
        handle.provider_ref = Some(ProviderObjectRef {
            provider: "web".into(),
            external_id: final_url.to_string(),
            container_id: final_url.host_str().map(str::to_string),
            thread_id: None,
            version: None,
            etag: None,
        });
        handle.capabilities = ObjectCapabilities {
            readable: true,
            materializable: true,
            writable: false,
            shareable: false,
            sendable: true,
            deletable: true,
        };
        handle.validate()?;
        Ok(json!({
            "success": true,
            "kind": "external_file",
            "url": original_url,
            "finalUrl": final_url,
            "redirected": original_url != final_url.as_str(),
            "finalDomain": final_url.host_str(),
            "content": Value::Null,
            "contentType": kind.mime,
            "originalName": original_name,
            "rootId": "artifacts",
            "relativePath": relative_path,
            "locator": format!("runtime://artifacts/{relative_path}"),
            "sha256": sha256,
            "sizeBytes": size_bytes,
            "objectHandle": handle,
            "hasMore": false,
            "nextStartIndex": Value::Null,
        }))
    }

    /// 执行 fetch 操作
    async fn execute_fetch(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Fetch cancelled before start".to_string());
        }

        // 解析参数
        let url = call
            .arguments
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'url' parameter")?;

        // 钳制到 [1, MAX_CONTENT_LENGTH]，防止模型传 usize::MAX 触发整数回绕
        let max_length = (call
            .arguments
            .get("max_length")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_MAX_LENGTH as u64)
            .min(MAX_CONTENT_LENGTH as u64) as usize)
            .max(1);

        let start_index = call
            .arguments
            .get("start_index")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_START_INDEX as u64) as usize;

        let raw = call
            .arguments
            .get("raw")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        log::debug!(
            "[FetchExecutor] Fetching URL: {}, max_length={}, start_index={}, raw={}",
            url,
            max_length,
            start_index,
            raw
        );

        // 验证 URL
        let parsed_url =
            reqwest::Url::parse(url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

        // 只允许 http/https
        if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
            return Err(format!(
                "Only HTTP and HTTPS URLs are supported, got: {}",
                parsed_url.scheme()
            ));
        }

        // P0-02 安全修复：SSRF 防护 - 检查目标 IP 是否为内网地址
        let host = parsed_url.host_str().ok_or("Invalid URL: no host")?;
        let port = parsed_url
            .port()
            .unwrap_or(if parsed_url.scheme() == "https" {
                443
            } else {
                80
            });

        // DNS 解析 - 失败时阻止请求（防止 DNS 解析失败静默通过）
        let addrs: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("DNS resolution failed for '{}': {}", host, e))?
            .collect();

        if addrs.is_empty() {
            return Err(format!(
                "DNS resolution returned no addresses for '{}'",
                host
            ));
        }

        // 检查所有解析的 IP 是否为内网地址
        for addr in &addrs {
            if is_internal_ip(&addr.ip()) {
                return Err("Blocked: URL resolves to internal IP address".to_string());
            }
        }

        let start_time = Instant::now();

        // SSRF 防护：使用解析后的 IP 发送请求，防止 DNS 重绑定攻击
        // DNS 重绑定：攻击者控制的 DNS 第一次返回公网 IP（通过检查），
        // 第二次返回内网 IP（reqwest 重新解析时），从而绕过 SSRF 防护
        let resolved_addr = addrs
            .first()
            .ok_or("DNS resolution succeeded but returned no addresses")?;

        // 构建请求 URL
        // 对于 HTTPS，我们仍然使用原始 URL 发送请求，因为使用 IP 会导致 TLS 证书验证失败
        // 但在发送前已进行 DNS 和 IP 检查，可以防护大多数 SSRF 攻击
        // 注意：这仍然存在 DNS 重绑定风险，但可以保持证书验证正常
        let request_url = if parsed_url.scheme() == "https" {
            // HTTPS: 使用原始 URL，依赖前面的 DNS 检查
            url.to_string()
        } else {
            // HTTP: 使用 IP 地址（完全防止 DNS 重绑定）
            // IPv6 地址需要用方括号包裹
            let ip_str = match resolved_addr.ip() {
                IpAddr::V4(v4) => v4.to_string(),
                IpAddr::V6(v6) => format!("[{}]", v6),
            };
            format!(
                "{}://{}:{}{}{}",
                parsed_url.scheme(),
                ip_str,
                resolved_addr.port(),
                parsed_url.path(),
                parsed_url
                    .query()
                    .map(|q| format!("?{}", q))
                    .unwrap_or_default()
            )
        };

        // 🆕 取消检查：在发送请求前再次检查
        if ctx.is_cancelled() {
            return Err("Fetch cancelled before HTTP request".to_string());
        }

        // 发送 HTTP 请求
        // 对于 HTTP（使用 IP），需要设置原始 Host header
        // 对于 HTTPS（使用原始 URL），Host header 会自动设置
        let request_builder = self.client.get(&request_url);
        let request_builder = if parsed_url.scheme() == "http" {
            request_builder.header("Host", host)
        } else {
            request_builder
        };

        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        let response = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = request_builder.send() => {
                    result.map_err(|e| format!("Failed to fetch URL '{}': {}", url, e))?
                }
                _ = cancel_token.cancelled() => {
                    log::info!("[FetchExecutor] HTTP request cancelled for URL: {}", url);
                    return Err("Fetch cancelled during HTTP request".to_string());
                }
            }
        } else {
            request_builder
                .send()
                .await
                .map_err(|e| format!("Failed to fetch URL '{}': {}", url, e))?
        };

        let status = response.status();
        let response_url = response.url().clone();
        let final_url = if response_url.as_str() == request_url {
            parsed_url.clone()
        } else {
            response_url
        };
        validate_public_url_target(&final_url)?;
        let response_headers = response.headers().clone();

        let content_type = response_headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();

        if !status.is_success() {
            return Err(format!(
                "HTTP request failed with status {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            ));
        }

        // 🆕 取消检查：在读取响应前检查
        if ctx.is_cancelled() {
            return Err("Fetch cancelled before reading response".to_string());
        }

        if let Some(length) = response.content_length() {
            if length > MAX_BINARY_LENGTH {
                return Err(format!(
                    "Response too large: {length} bytes (max {MAX_BINARY_LENGTH} bytes)"
                ));
            }
        }

        // 读取响应内容（流式限制大小，避免 Content-Length 缺失时无界缓冲）
        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        let initial_capacity = response
            .content_length()
            .unwrap_or(0)
            .min(MAX_BINARY_LENGTH) as usize;
        let bytes = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = collect_download_stream_limited(response.bytes_stream(), MAX_BINARY_LENGTH, initial_capacity) => {
                    result?
                }
                _ = cancel_token.cancelled() => {
                    log::info!("[FetchExecutor] Response body read cancelled for URL: {}", url);
                    return Err("Fetch cancelled while reading response".to_string());
                }
            }
        } else {
            collect_download_stream_limited(
                response.bytes_stream(),
                MAX_BINARY_LENGTH,
                initial_capacity,
            )
            .await?
        };

        let sniffed_binary = sniff_binary_kind(&bytes);
        let declared_mime = normalized_mime(&content_type).to_ascii_lowercase();
        let declares_binary = declared_mime == "application/octet-stream"
            || declared_mime == "binary/octet-stream"
            || declared_mime == "application/pdf"
            || declared_mime
                == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            || declared_mime.starts_with("image/")
            || declared_mime.starts_with("audio/")
            || declared_mime.starts_with("video/");

        if let Some(mut kind) = sniffed_binary {
            if kind.extension == "mp4" && declared_mime.starts_with("audio/") {
                kind = BinaryKind {
                    mime: "audio/mp4",
                    extension: "m4a",
                };
            } else if kind.extension == "webm" && declared_mime.starts_with("audio/") {
                kind = BinaryKind {
                    mime: "audio/webm",
                    extension: "webm",
                };
            }
            if !binary_header_family_matches(&content_type, kind) {
                return Err(format!(
                    "Binary MIME/magic mismatch: header '{}' does not match detected '{}'",
                    content_type, kind.mime
                ));
            }
            return self.materialize_binary(ctx, url, &final_url, &response_headers, &bytes, kind);
        }
        if declares_binary {
            return Err(format!(
                "Unsupported or invalid binary response: declared MIME '{}' did not match a supported file signature",
                content_type
            ));
        }

        if bytes.len() > MAX_CONTENT_LENGTH {
            return Err(format!(
                "Response too large: {} bytes (max {} bytes)",
                bytes.len(),
                MAX_CONTENT_LENGTH
            ));
        }

        // 使用编码检测解码响应内容（支持 GBK/GB18030 等非 UTF-8 编码）
        let (raw_content, detected_charset) = decode_bytes_with_charset(&bytes, &content_type);
        log::debug!(
            "[FetchExecutor] Charset detected: {} for URL: {}",
            detected_charset,
            url
        );

        // 根据 content_type 和 raw 参数决定是否转换
        let is_html_by_header =
            content_type.contains("text/html") || content_type.contains("application/xhtml");

        let content = if raw {
            raw_content
        } else if is_html_by_header {
            // 明确的 HTML content type
            self.html_to_markdown(&raw_content)
        } else if content_type.contains("application/json") {
            // JSON 格式化
            self.format_json(&raw_content)
        } else if content_type.contains("text/plain") || content_type.contains("text/markdown") {
            // 纯文本 — 但检查是否实际上是 HTML（content-type 不准确的情况）
            if looks_like_html(&raw_content) {
                log::debug!(
                    "[FetchExecutor] Content-Type is '{}' but body looks like HTML, converting",
                    content_type
                );
                self.html_to_markdown(&raw_content)
            } else {
                raw_content
            }
        } else {
            // 未知类型 — 检查响应体是否为 HTML
            if looks_like_html(&raw_content) {
                self.html_to_markdown(&raw_content)
            } else {
                // 非 HTML 内容直接返回
                raw_content
            }
        };

        let total_length = content.chars().count();
        let duration_ms = start_time.elapsed().as_millis() as u64;

        // 应用分页（包含截断提示）
        let (paginated_content, has_more, _truncation_notice) =
            self.paginate_content(&content, start_index, max_length);
        let returned_length = paginated_content.chars().count();
        let next_start = if has_more {
            Some(start_index.saturating_add(max_length))
        } else {
            None
        };

        log::debug!(
            "[FetchExecutor] Fetch completed: url={}, total_len={}, returned_len={}, has_more={}, {}ms",
            url, total_length, returned_length, has_more, duration_ms
        );

        Ok(json!({
            "success": true,
            "url": url,
            "finalUrl": final_url,
            "redirected": url != final_url.as_str(),
            "finalDomain": final_url.host_str(),
            "content": paginated_content,
            "contentType": content_type,
            "totalLength": total_length,
            "startIndex": start_index,
            "returnedLength": returned_length,
            "hasMore": has_more,
            "nextStartIndex": next_start,
            "durationMs": duration_ms,
        }))
    }

    /// HTML 转纯文本
    ///
    /// 使用 html2text 库转换，先清理干扰元素以提高转换质量。
    /// 注：html2md 与 panic=abort 不兼容，改用 html2text。
    fn html_to_markdown(&self, html: &str) -> String {
        // 第一步：尝试提取主内容区域（article/main）
        let source = try_extract_main_content(html).unwrap_or_else(|| html.to_string());

        // 第二步：清理 HTML（移除干扰元素）
        let cleaned = self.clean_html(&source);

        // 第三步：html2text 转为纯文本，宽度 80 字符
        let text = match html2text::from_read(cleaned.as_bytes(), 80) {
            Ok(result) => result,
            Err(e) => {
                log::warn!("[FetchExecutor] HTML 转文本失败，回退清理后内容: {}", e);
                cleaned
            }
        };

        // 第四步：清理多余空行
        self.clean_markdown(&text)
    }

    /// 清理 HTML（移除干扰元素，对齐官方 readabilipy 的效果）
    ///
    /// 移除的元素：
    /// - script/style/noscript - 脚本和样式
    /// - nav/header/footer/aside - 页面结构元素
    /// - iframe/svg - 嵌入内容
    /// - form/dialog/template/object/embed/applet - 表单和嵌入元素
    /// - HTML 注释
    fn clean_html(&self, html: &str) -> String {
        // 使用预编译的正则表达式（性能优化）
        let result = RE_SCRIPT.replace_all(html, "");
        let result = RE_STYLE.replace_all(&result, "");
        let result = RE_NOSCRIPT.replace_all(&result, "");
        let result = RE_COMMENT.replace_all(&result, "");
        let result = RE_NAV.replace_all(&result, "");
        let result = RE_HEADER.replace_all(&result, "");
        let result = RE_FOOTER.replace_all(&result, "");
        let result = RE_ASIDE.replace_all(&result, "");
        let result = RE_IFRAME.replace_all(&result, "");
        let result = RE_SVG.replace_all(&result, "");
        let result = RE_FORM.replace_all(&result, "");
        let result = RE_DIALOG.replace_all(&result, "");
        let result = RE_TEMPLATE.replace_all(&result, "");
        let result = RE_OBJECT.replace_all(&result, "");
        let result = RE_EMBED.replace_all(&result, "");
        let result = RE_APPLET.replace_all(&result, "");

        result.to_string()
    }

    /// 清理 Markdown（移除多余空行）
    fn clean_markdown(&self, markdown: &str) -> String {
        RE_MULTI_NEWLINES.replace_all(markdown, "\n\n").to_string()
    }

    /// 格式化 JSON
    fn format_json(&self, json_str: &str) -> String {
        match serde_json::from_str::<Value>(json_str) {
            Ok(value) => {
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| json_str.to_string())
            }
            Err(_) => json_str.to_string(),
        }
    }

    /// 分页内容（对齐官方实现的截断提示）
    ///
    /// 当内容被截断时，在末尾添加明确的提示信息，告知 LLM 如何继续获取。
    /// 这与 @anthropic/mcp-fetch 的行为一致。
    fn paginate_content(
        &self,
        content: &str,
        start_index: usize,
        max_length: usize,
    ) -> (String, bool, Option<String>) {
        let chars: Vec<char> = content.chars().collect();
        let total = chars.len();

        // 超出范围
        if start_index >= total {
            return (
                "<error>No more content available.</error>".to_string(),
                false,
                None,
            );
        }

        // 🔒 saturating_add：release 下 `start_index + usize::MAX` 会回绕成
        // `start_index - 1`，导致 chars[start..end] 中 start > end 触发 slice panic。
        let end_index = start_index.saturating_add(max_length).min(total);
        let mut paginated: String = chars[start_index..end_index].iter().collect();
        let actual_length = paginated.chars().count();
        let remaining = total.saturating_sub(start_index.saturating_add(actual_length));
        let has_more = remaining > 0;

        // 官方行为：当内容被截断且还有剩余时，添加提示
        let truncation_notice = if has_more && actual_length == max_length {
            let next_start = start_index.saturating_add(actual_length);
            let notice = format!(
                "\n\n<truncated>Content truncated. Call the fetch tool with start_index={} to get more content. Remaining: {} characters.</truncated>",
                next_start, remaining
            );
            paginated.push_str(&notice);
            Some(notice)
        } else {
            None
        };

        (paginated, has_more, truncation_notice)
    }
}

impl Default for FetchExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for FetchExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(stripped, "web_fetch")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[FetchExecutor] Executing builtin tool: {} (full: {})",
            tool_name,
            call.name
        );

        // 发射工具调用开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "web_fetch" => self.execute_fetch(call, ctx).await,
            _ => Err(format!("Unknown fetch tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 发射工具调用结束事件
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[FetchExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                // 发射工具调用错误事件
                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                // SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[FetchExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // ★ 2026-02-09: 降为 Low，web fetch 本质是只读操作（读取网页），与 web_search 同级
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        // web_fetch 只读取网页内容，无副作用，可并行 + 自动重试
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "FetchExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_04_binary_magic_and_mime_contract() {
        let pdf = sniff_binary_kind(b"%PDF-1.7\n").expect("PDF magic");
        assert_eq!(pdf.mime, "application/pdf");
        assert!(binary_header_family_matches("application/pdf", pdf));
        assert!(binary_header_family_matches(
            "application/octet-stream",
            pdf
        ));
        assert!(!binary_header_family_matches("image/png", pdf));

        let png = sniff_binary_kind(b"\x89PNG\r\n\x1a\nrest").expect("PNG magic");
        assert_eq!(png.mime, "image/png");
        assert!(!binary_header_family_matches("application/pdf", png));
    }

    #[test]
    fn web_04_docx_requires_ooxml_structure() {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default();
            archive.start_file("[Content_Types].xml", options).unwrap();
            archive.write_all(b"<Types/>").unwrap();
            archive.start_file("word/document.xml", options).unwrap();
            archive.write_all(b"<document/>").unwrap();
            archive.finish().unwrap();
        }
        let docx = sniff_binary_kind(cursor.get_ref()).expect("DOCX structure");
        assert_eq!(docx.extension, "docx");
        assert!(binary_header_family_matches("application/zip", docx));
        assert!(sniff_binary_kind(b"PK\x03\x04not-a-complete-zip").is_none());
    }

    #[test]
    fn web_05_redirect_metadata_filename_is_safe_and_typed() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=../../quarterly.exe"),
        );
        let final_url = reqwest::Url::parse("https://cdn.example.test/files/fallback").unwrap();
        let pdf = BinaryKind {
            mime: "application/pdf",
            extension: "pdf",
        };
        assert_eq!(
            filename_from_headers_or_url(&headers, &final_url, pdf),
            "quarterly.pdf"
        );
    }

    #[tokio::test]
    async fn chunked_download_is_rejected_before_retaining_over_limit_body() {
        let chunks = futures_util::stream::iter(vec![
            Ok::<_, std::io::Error>(b"abc".to_vec()),
            Ok::<_, std::io::Error>(b"def".to_vec()),
            Ok::<_, std::io::Error>(b"never-read".to_vec()),
        ]);
        let error = collect_download_stream_limited(chunks, 5, 0)
            .await
            .expect_err("chunked response crossing the limit must fail");
        assert!(error.contains("6 bytes > 5 bytes"));

        let within_limit = futures_util::stream::iter(vec![
            Ok::<_, std::io::Error>(b"ab".to_vec()),
            Ok::<_, std::io::Error>(b"cde".to_vec()),
        ]);
        assert_eq!(
            collect_download_stream_limited(within_limit, 5, 5)
                .await
                .expect("body at exact limit"),
            b"abcde"
        );
    }

    #[test]
    fn test_can_handle() {
        let executor = FetchExecutor::new();

        assert!(executor.can_handle("builtin-web_fetch"));
        assert!(executor.can_handle("web_fetch"));

        assert!(!executor.can_handle("builtin-web_search"));
        assert!(!executor.can_handle("builtin-rag_search"));
    }

    #[test]
    fn test_strip_namespace() {
        assert_eq!(strip_tool_namespace("builtin-web_fetch"), "web_fetch");
        assert_eq!(strip_tool_namespace("web_fetch"), "web_fetch");
    }

    #[test]
    fn test_paginate_content() {
        let executor = FetchExecutor::new();

        let content = "Hello, World! This is a test.";

        // 从头开始（会有截断提示）
        let (result, has_more, truncation) = executor.paginate_content(content, 0, 5);
        assert!(result.starts_with("Hello"));
        assert!(has_more);
        assert!(truncation.is_some()); // 有截断提示

        // 从中间开始
        let (result, has_more, _) = executor.paginate_content(content, 7, 5);
        assert!(result.starts_with("World"));
        assert!(has_more);

        // 超出范围
        let (result, has_more, truncation) = executor.paginate_content(content, 100, 5);
        assert!(result.contains("No more content"));
        assert!(!has_more);
        assert!(truncation.is_none());

        // 获取全部（无截断）
        let (result, has_more, truncation) = executor.paginate_content(content, 0, 100);
        assert_eq!(result, content);
        assert!(!has_more);
        assert!(truncation.is_none());
    }

    /// SECURITY 回归（04 号报告 P2-1）：模型可控的 max_length=usize::MAX
    /// 曾在 release 下整数回绕触发 slice 越界 panic。
    #[test]
    fn test_paginate_content_huge_max_length_does_not_panic() {
        let executor = FetchExecutor::new();
        let content = "Hello, World!";

        let (result, has_more, truncation) = executor.paginate_content(content, 1, usize::MAX);
        assert_eq!(result, "ello, World!");
        assert!(!has_more);
        assert!(truncation.is_none());

        // start_index 也为极值时按「超出范围」处理
        let (result, has_more, _) = executor.paginate_content(content, usize::MAX, usize::MAX);
        assert!(result.contains("No more content"));
        assert!(!has_more);
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = FetchExecutor::new();
        // ★ 2026-02-09: 降为 Low
        assert_eq!(
            executor.sensitivity_level("builtin-web_fetch"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_clean_html() {
        let executor = FetchExecutor::new();

        let html = r#"
        <html>
        <head>
            <script>alert('test');</script>
            <style>.test { color: red; }</style>
        </head>
        <body>
            <nav>Navigation</nav>
            <p>Hello World</p>
            <footer>Footer</footer>
        </body>
        </html>
        "#;

        let cleaned = executor.clean_html(html);

        assert!(!cleaned.contains("<script>"));
        assert!(!cleaned.contains("<style>"));
        assert!(!cleaned.contains("<nav>"));
        assert!(!cleaned.contains("<footer>"));
        assert!(cleaned.contains("Hello World"));
    }

    #[test]
    fn test_is_internal_ip_ipv4() {
        use std::net::Ipv4Addr;

        // Loopback
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));

        // Private ranges
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));

        // Link-local
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));

        // Cloud metadata endpoint
        assert!(is_internal_ip(&IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));

        // Public IP should NOT be blocked
        assert!(!is_internal_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_internal_ip(&IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn test_is_internal_ip_ipv6() {
        use std::net::Ipv6Addr;

        // Loopback (::1)
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));

        // Unique local address (fc00::/7)
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0xfc00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0xfd00, 0, 0, 0, 0, 0, 0, 1
        ))));

        // Link-local (fe80::/10)
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));

        // Site-local (fec0::/10) - 已废弃但部分系统仍支持
        assert!(is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0xfec0, 0, 0, 0, 0, 0, 0, 1
        ))));

        // 6to4 with embedded private IPv4 (2002:c0a8:0101:: = 2002:192.168.1.1::)
        let ipv6_6to4_private = Ipv6Addr::new(0x2002, 0xc0a8, 0x0101, 0, 0, 0, 0, 1);
        assert!(is_internal_ip(&IpAddr::V6(ipv6_6to4_private)));

        // 6to4 with embedded loopback (2002:7f00:0001:: = 2002:127.0.0.1::)
        let ipv6_6to4_loopback = Ipv6Addr::new(0x2002, 0x7f00, 0x0001, 0, 0, 0, 0, 1);
        assert!(is_internal_ip(&IpAddr::V6(ipv6_6to4_loopback)));

        // 6to4 with embedded public IPv4 should NOT be blocked (2002:0808:0808:: = 2002:8.8.8.8::)
        let ipv6_6to4_public = Ipv6Addr::new(0x2002, 0x0808, 0x0808, 0, 0, 0, 0, 1);
        assert!(!is_internal_ip(&IpAddr::V6(ipv6_6to4_public)));

        // IPv4-mapped private address (::ffff:192.168.1.1)
        let ipv4_mapped_private = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101);
        assert!(is_internal_ip(&IpAddr::V6(ipv4_mapped_private)));

        // IPv4-mapped loopback (::ffff:127.0.0.1)
        let ipv4_mapped_loopback = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001);
        assert!(is_internal_ip(&IpAddr::V6(ipv4_mapped_loopback)));

        // Public IPv6 should NOT be blocked
        assert!(!is_internal_ip(&IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888
        ))));
    }

    #[test]
    fn test_detect_charset_from_content_type() {
        assert_eq!(
            detect_charset_from_content_type("text/html; charset=gbk"),
            Some("gbk")
        );
        assert_eq!(
            detect_charset_from_content_type("text/html; charset=\"UTF-8\""),
            Some("UTF-8")
        );
        assert_eq!(detect_charset_from_content_type("text/html"), None);
        assert_eq!(
            detect_charset_from_content_type("text/html; CHARSET=gb2312"),
            Some("gb2312")
        );
    }

    #[test]
    fn test_detect_charset_from_html_meta() {
        let html_meta1 = b"<html><head><meta charset=\"gbk\"></head>";
        assert_eq!(
            detect_charset_from_html_meta(html_meta1),
            Some("gbk".to_string())
        );

        let html_meta2 = b"<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=gb2312\"></head>";
        assert_eq!(
            detect_charset_from_html_meta(html_meta2),
            Some("gb2312".to_string())
        );

        let html_no_meta = b"<html><head><title>Test</title></head>";
        assert_eq!(detect_charset_from_html_meta(html_no_meta), None);
    }

    #[test]
    fn test_decode_bytes_with_charset_utf8() {
        let bytes = "Hello World".as_bytes();
        let (decoded, charset) = decode_bytes_with_charset(bytes, "text/html; charset=utf-8");
        assert_eq!(decoded, "Hello World");
        assert_eq!(charset, "UTF-8");
    }

    #[test]
    fn test_decode_bytes_with_charset_gbk() {
        // "你好" in GBK encoding
        let (encoded, _, _) = encoding_rs::GBK.encode("你好");
        let (decoded, charset) = decode_bytes_with_charset(&encoded, "text/html; charset=gbk");
        assert_eq!(decoded, "你好");
        assert_eq!(charset, "GBK");
    }

    #[test]
    fn test_looks_like_html() {
        assert!(looks_like_html("<!DOCTYPE html><html>..."));
        assert!(looks_like_html("  \n  <html lang=\"en\">..."));
        assert!(looks_like_html("  <HTML><HEAD>..."));
        assert!(looks_like_html("<head><title>Test</title></head><body>"));
        assert!(!looks_like_html("{\"key\": \"value\"}"));
        assert!(!looks_like_html("Hello, plain text"));
    }

    #[test]
    fn test_clean_html_extended_tags() {
        let executor = FetchExecutor::new();
        let html = r#"
        <html><body>
            <form action="/submit"><input type="text"></form>
            <dialog open>Dialog content</dialog>
            <template>Template content</template>
            <p>Main content here</p>
            <object data="flash.swf">Object content</object>
        </body></html>
        "#;
        let cleaned = executor.clean_html(html);
        assert!(!cleaned.contains("<form"));
        assert!(!cleaned.contains("<dialog"));
        assert!(!cleaned.contains("<template"));
        assert!(!cleaned.contains("<object"));
        assert!(cleaned.contains("Main content here"));
    }

    #[test]
    fn test_try_extract_main_content() {
        let html_with_article = r#"
        <html><body>
            <nav>Navigation</nav>
            <article>
                <h1>Article Title</h1>
                <p>This is the main article content that should be extracted.
                It needs to be long enough to pass the 200 character threshold
                for extraction to work properly. Adding more text here to ensure
                we exceed the minimum length requirement.</p>
            </article>
            <aside>Sidebar</aside>
        </body></html>
        "#;
        let extracted = try_extract_main_content(html_with_article);
        assert!(extracted.is_some());
        let content = extracted.unwrap();
        assert!(content.contains("Article Title"));
        assert!(!content.contains("Navigation"));
        assert!(!content.contains("Sidebar"));
    }

    #[test]
    fn test_try_extract_main_content_short() {
        // 内容太短时不应提取
        let html = r#"<html><body><article><p>Short</p></article></body></html>"#;
        assert!(try_extract_main_content(html).is_none());
    }

    #[test]
    fn test_clean_markdown_precompiled() {
        let executor = FetchExecutor::new();
        let input = "Line 1\n\n\n\n\nLine 2\n\n\nLine 3";
        let result = executor.clean_markdown(input);
        assert_eq!(result, "Line 1\n\nLine 2\n\nLine 3");
    }
}
