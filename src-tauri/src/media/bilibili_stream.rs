//! `bilistream://` 协议：在应用自己的 `<video>` 里播放 B 站链接条目。
//!
//! 外链播放器（player.bilibili.com iframe）在应用 WebView 里常一直缓冲：第三方 Cookie 被拦、
//! 风控、UA 识别都不在我们控制之内，也拿不到进度 / 暂停 / 截帧。这里改为：
//! 1. `x/player/playurl`（html5 平台、`fnval=1`）取单文件 MP4 地址（登录后带会话 Cookie），
//!    只接受 B 站视频 CDN 域名，按条目缓存约 50 分钟（地址本身带过期时间）；
//! 2. 媒体元素的 Range 请求转发到 CDN（带 B 站 Referer），每次最多回
//!    [`STREAM_CHUNK_BYTES`]，播放器按 `Content-Range` 继续请求后续区间；
//! 3. CDN 返回 403 / 404 / 410（地址过期）时丢弃缓存重新取一次地址。
//!
//! URL 形如 `bilistream://localhost/{fileId}?qn=64&e=0`（Windows / Android 为 `http://bilistream.localhost/...`），
//! `fileId` 必须是 VFS 里的 B 站链接条目；转发目标只来自 B 站接口，不接受请求方给的地址。
//!
//! 清晰度：`qn` 是请求的清晰度（缺省 [`DEFAULT_QN`]），B 站会降到不高于它的可用档位；
//! 可选档位来自 playurl 的 `accept_quality`（html5 平台只列单文件 MP4 能给的档位，
//! 登录 / 大会员影响列表），再按 [`MP4_QUALITIES`] 白名单过滤掉需要 DASH 的高档位。
//! [`media_bilibili_stream_quality`] 把列表与实际清晰度交给前端；缓存按 `(条目, qn, 账号代次)` 区分。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_RANGE, CONTENT_TYPE, RANGE, REFERER};
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager};

use super::bilibili::{read_link_descriptor, BiliClient, BiliLinkDescriptor};
use super::MediaError;
use crate::vfs::database::VfsDatabase;

/// 单次响应的最大字节数（约 10 秒 1080P）
pub const STREAM_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const PLAY_SOURCE_TTL: Duration = Duration::from_secs(50 * 60);
const PLAY_CACHE_MAX_ENTRIES: usize = 32;
const CDN_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
/// B 站视频 CDN（含 PCDN / 海外）域名后缀
const CDN_HOST_SUFFIXES: &[&str] = &[
    ".bilivideo.com",
    ".bilivideo.cn",
    ".akamaized.net",
    ".szbdyd.com",
    ".hdslb.com",
];

/// 不带 `qn` 时请求的清晰度（1080P；拿不到时 B 站自动降档）
pub const DEFAULT_QN: u32 = 80;
/// fnval=1 单文件 MP4 能给到的清晰度：240P / 360P / 480P / 720P / 1080P。
/// 720P60（74）、1080P+（112）及以上只有 DASH 分轨，`<video>` 直接放不了，不列出。
pub const MP4_QUALITIES: &[u32] = &[6, 16, 32, 64, 80];

/// 一档清晰度（`qn` + B 站给的名称，如「高清 720P」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub qn: u32,
    pub label: String,
}

/// 一次 playurl 解析的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlayInfo {
    url: String,
    /// B 站实际给的清晰度（可能低于请求的 qn）
    quality: u32,
    /// 本条目可选的清晰度（高 → 低）
    options: Vec<QualityOption>,
}

#[derive(Debug, Clone)]
struct PlaySource {
    info: PlayInfo,
    resolved_at: Instant,
}

static PLAY_CACHE: LazyLock<Mutex<HashMap<String, PlaySource>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static CDN_CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.bilibili.com/"),
    );
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(headers)
        .timeout(CDN_TIMEOUT)
        .build()
        .ok()
});

// ============================================================================
// 纯函数（可单测）
// ============================================================================

/// 请求路径 → 条目 id（`/file_xxx`，可能被百分号编码）
fn parse_stream_path(path: &str) -> Option<String> {
    let first = path.trim_start_matches('/').split('/').next()?;
    let decoded = urlencoding::decode(first).ok()?.into_owned();
    let valid = (decoded.starts_with("file_") || decoded.starts_with("att_"))
        && decoded.len() <= 64
        && decoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then_some(decoded)
}

/// 地址查询串里的一个数字参数
fn query_u32(query: Option<&str>, name: &str) -> Option<u32> {
    query
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == name)
        .and_then(|(_, v)| v.parse::<u32>().ok())
}

/// 请求的清晰度；缺省 / 不在 MP4 白名单时用 [`DEFAULT_QN`]
fn normalize_qn(qn: Option<u32>) -> u32 {
    qn.filter(|q| MP4_QUALITIES.contains(q))
        .unwrap_or(DEFAULT_QN)
}

/// 播放地址的 `(qn, 账号代次)`：`?qn=64&e=1`。
/// 账号代次由前端在登录 / 退出后递增：同一个媒体地址始终对应同一个 CDN 文件（换文件会让
/// 播放中的 Range 请求读到另一份字节），登录后能拿到的清晰度变了，就换一个新地址重新取。
fn parse_stream_query(query: Option<&str>) -> (u32, u32) {
    (
        normalize_qn(query_u32(query, "qn")),
        query_u32(query, "e").unwrap_or(0),
    )
}

/// 播放地址缓存键：同一条目不同清晰度 / 不同账号代次的地址不同
fn cache_key(file_id: &str, qn: u32, epoch: u32) -> String {
    format!("{}@{}@{}", file_id, qn, epoch)
}

/// B 站没给名称时的兜底文案
fn fallback_quality_label(qn: u32) -> String {
    match qn {
        6 => "240P".into(),
        16 => "360P".into(),
        32 => "480P".into(),
        64 => "720P".into(),
        80 => "1080P".into(),
        other => format!("qn {}", other),
    }
}

/// `accept_quality` / `accept_description` → MP4 能播的清晰度（高 → 低，去重）；
/// 实际返回的 `quality` 总在列表里
fn mp4_quality_options(data: &PlayUrlData) -> Vec<QualityOption> {
    let mut options: Vec<QualityOption> = data
        .accept_quality
        .iter()
        .enumerate()
        .map(|(i, &qn)| (qn, data.accept_description.get(i)))
        .chain(data.quality.map(|q| (q, None)))
        .filter(|(qn, _)| MP4_QUALITIES.contains(qn))
        .map(|(qn, label)| QualityOption {
            qn,
            label: label
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| fallback_quality_label(qn)),
        })
        .collect();
    options.sort_by(|a, b| b.qn.cmp(&a.qn));
    options.dedup_by_key(|o| o.qn);
    options
}

fn parse_play_info(data: &PlayUrlData, requested_qn: u32) -> Result<PlayInfo, MediaError> {
    let url = pick_play_url(data)?;
    Ok(PlayInfo {
        url,
        quality: data.quality.unwrap_or(requested_qn),
        options: mp4_quality_options(data),
    })
}

/// `Range` 头 → 要向 CDN 请求的 `(start, end)`（含端点），每次最多 [`STREAM_CHUNK_BYTES`]。
/// 没有 Range 时从 0 开始；后缀形式（`bytes=-N`）与多段不支持，返回 None。
fn upstream_range(range: Option<&str>) -> Option<(u64, u64)> {
    let Some(range) = range else {
        return Some((0, STREAM_CHUNK_BYTES - 1));
    };
    let spec = range.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let max_end = start.checked_add(STREAM_CHUNK_BYTES - 1)?;
    let end = match end.trim() {
        "" => max_end,
        e => e.parse::<u64>().ok()?.min(max_end),
    };
    (end >= start).then_some((start, end))
}

fn is_cdn_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    CDN_HOST_SUFFIXES
        .iter()
        .any(|suffix| host.ends_with(suffix))
}

#[derive(Debug, Deserialize)]
struct PlayUrlData {
    #[serde(default)]
    durl: Vec<PlayUrlSegment>,
    #[serde(default)]
    quality: Option<u32>,
    #[serde(default)]
    accept_quality: Vec<u32>,
    #[serde(default)]
    accept_description: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PlayUrlSegment {
    url: String,
    #[serde(default)]
    backup_url: Option<Vec<String>>,
}

/// 只接受单文件 MP4；主地址不在 CDN 白名单时用备用地址（http 升级为 https）
fn pick_play_url(data: &PlayUrlData) -> Result<String, MediaError> {
    if data.durl.len() != 1 {
        return Err(MediaError::InvalidInput(format!(
            "B 站给出的是 {} 段的旧格式视频，无法在应用内直接播放",
            data.durl.len()
        )));
    }
    let segment = &data.durl[0];
    std::iter::once(&segment.url)
        .chain(segment.backup_url.iter().flatten())
        .map(|u| {
            if let Some(rest) = u.strip_prefix("http://") {
                format!("https://{}", rest)
            } else {
                u.clone()
            }
        })
        .find(|u| is_cdn_url(u))
        .ok_or_else(|| MediaError::InvalidInput("B 站返回的视频地址不在 B 站 CDN 上".into()))
}

// ============================================================================
// 取地址
// ============================================================================

pub(crate) async fn resolve_play_info(
    client: &BiliClient,
    descriptor: &BiliLinkDescriptor,
    qn: u32,
) -> Result<PlayInfo, MediaError> {
    let data: PlayUrlData = client
        .get_api(
            "/x/player/playurl",
            &[
                ("bvid", descriptor.bvid.clone()),
                ("cid", descriptor.cid.to_string()),
                ("qn", qn.to_string()),
                ("fnval", "1".into()),
                ("fnver", "0".into()),
                ("fourk", "0".into()),
                ("platform", "html5".into()),
                ("high_quality", "1".into()),
            ],
        )
        .await?
        .ok_or_else(|| MediaError::InvalidInput("B 站没有返回播放地址".into()))?;
    parse_play_info(&data, qn)
}

fn cached_source(key: &str) -> Option<PlayInfo> {
    let cache = PLAY_CACHE.lock().ok()?;
    cache
        .get(key)
        .filter(|s| s.resolved_at.elapsed() < PLAY_SOURCE_TTL)
        .map(|s| s.info.clone())
}

fn remember_source(key: &str, info: &PlayInfo) {
    if let Ok(mut cache) = PLAY_CACHE.lock() {
        cache.retain(|_, s| s.resolved_at.elapsed() < PLAY_SOURCE_TTL);
        if cache.len() >= PLAY_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(
            key.to_string(),
            PlaySource {
                info: info.clone(),
                resolved_at: Instant::now(),
            },
        );
    }
}

fn forget_source(key: &str) {
    if let Ok(mut cache) = PLAY_CACHE.lock() {
        cache.remove(key);
    }
}

async fn play_info_for(
    app: &AppHandle,
    file_id: &str,
    qn: u32,
    epoch: u32,
    fresh: bool,
) -> Result<PlayInfo, MediaError> {
    let key = cache_key(file_id, qn, epoch);
    if !fresh {
        if let Some(info) = cached_source(&key) {
            return Ok(info);
        }
    }
    let db: Arc<VfsDatabase> = Arc::clone(app.state::<Arc<VfsDatabase>>().inner());
    let id = file_id.to_string();
    let descriptor = tokio::task::spawn_blocking(move || read_link_descriptor(&db, &id))
        .await
        .map_err(|e| MediaError::Io(e.to_string()))??;
    let client = BiliClient::new()?.with_cookie(super::bilibili_auth::load_cookie(app));
    let info = resolve_play_info(&client, &descriptor, qn).await?;
    remember_source(&key, &info);
    Ok(info)
}

/// 前端清晰度菜单需要的信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamQualityView {
    /// 请求的清晰度（与 `bilistream://` 地址里的 qn 一致）
    pub requested: u32,
    /// B 站实际给的清晰度（降档时低于 requested）
    pub current: u32,
    /// 可选清晰度（高 → 低）
    pub options: Vec<QualityOption>,
}

/// 链接条目在应用内播放时的可选清晰度与实际清晰度。
/// 与 `bilistream://` 共用按 `(条目, qn, 账号代次)` 的地址缓存，播放器随后的请求不会再取一次地址。
#[tauri::command]
pub async fn media_bilibili_stream_quality(
    app: AppHandle,
    file_id: String,
    qn: Option<u32>,
    epoch: Option<u32>,
) -> Result<StreamQualityView, String> {
    let file_id = parse_stream_path(&file_id).ok_or_else(|| "无效的 B 站链接条目".to_string())?;
    let requested = normalize_qn(qn);
    let info = play_info_for(&app, &file_id, requested, epoch.unwrap_or(0), false)
        .await
        .map_err(|e| e.to_string())?;
    Ok(StreamQualityView {
        requested,
        current: info.quality,
        options: info.options,
    })
}

// ============================================================================
// 协议处理
// ============================================================================

fn response(
    request: &Request<Vec<u8>>,
    status: u16,
    headers: &[(&str, String)],
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let origin = crate::file_stream_protocol::cors_origin_for_request(request);
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header("Vary", "Origin")
        .header("Cache-Control", "no-store");
    for (name, value) in headers {
        builder = builder.header(*name, value.as_str());
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn text_error(request: &Request<Vec<u8>>, status: u16, message: &str) -> Response<Vec<u8>> {
    response(
        request,
        status,
        &[("Content-Type", "text/plain; charset=utf-8".into())],
        message.as_bytes().to_vec(),
    )
}

enum Upstream {
    Ok {
        status: u16,
        content_range: Option<String>,
        content_type: Option<String>,
        body: Vec<u8>,
    },
    /// 地址过期 / 被拒（应重新取地址）
    Stale(u16),
    Failed(String),
}

async fn fetch_range(url: &str, start: u64, end: u64) -> Upstream {
    let Some(client) = CDN_CLIENT.as_ref() else {
        return Upstream::Failed("网络客户端不可用".into());
    };
    let resp = match client
        .get(url)
        .header(RANGE, format!("bytes={}-{}", start, end))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => return Upstream::Failed(format!("连接 B 站视频服务器失败：{}", e)),
    };
    let status = resp.status().as_u16();
    if matches!(status, 403 | 404 | 410) {
        return Upstream::Stale(status);
    }
    if status != 200 && status != 206 {
        return Upstream::Failed(format!("B 站视频服务器返回 HTTP {}", status));
    }
    let content_range = resp
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match resp.bytes().await {
        // 有的节点忽略 Range 直接回 200 + 整个文件：只截取请求的这一段，按 206 回
        Ok(bytes) if status == 200 => {
            let total = bytes.len() as u64;
            if start >= total {
                return Upstream::Failed("请求的区间超出视频大小".into());
            }
            let last = end.min(total - 1);
            Upstream::Ok {
                status: 206,
                content_range: Some(format!("bytes {}-{}/{}", start, last, total)),
                content_type,
                body: bytes[start as usize..=last as usize].to_vec(),
            }
        }
        Ok(bytes) => Upstream::Ok {
            status,
            content_range,
            content_type,
            body: bytes.to_vec(),
        },
        Err(e) => Upstream::Failed(format!("读取 B 站视频数据失败：{}", e)),
    }
}

/// 协议入口（由 lib.rs 的异步协议注册调用）
pub async fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method().as_str().to_ascii_uppercase();
    if method == "OPTIONS" {
        return response(&request, 204, &[], Vec::new());
    }
    if method != "GET" && method != "HEAD" {
        return text_error(&request, 405, "Method Not Allowed");
    }
    let Some(file_id) = parse_stream_path(request.uri().path()) else {
        return text_error(&request, 400, "无效的 B 站播放地址");
    };
    let (qn, epoch) = parse_stream_query(request.uri().query());
    let range_header = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let Some((start, end)) = upstream_range(range_header.as_deref()) else {
        return text_error(&request, 416, "Range Not Satisfiable");
    };
    // HEAD 只需要总大小：取 1 字节
    let end = if method == "HEAD" { start } else { end };

    let mut fresh = false;
    for _ in 0..2 {
        let url = match play_info_for(app, &file_id, qn, epoch, fresh).await {
            Ok(info) => info.url,
            Err(e) => {
                log::warn!("[media::bilibili_stream] {} resolve failed: {}", file_id, e);
                return text_error(&request, 502, &e.to_string());
            }
        };
        match fetch_range(&url, start, end).await {
            Upstream::Ok {
                status,
                content_range,
                content_type,
                body,
            } => {
                let mut headers = vec![
                    ("Accept-Ranges", "bytes".to_string()),
                    (
                        "Content-Type",
                        content_type
                            .filter(|t| t.starts_with("video/") || t.starts_with("audio/"))
                            .unwrap_or_else(|| "video/mp4".into()),
                    ),
                ];
                if let Some(range) = content_range {
                    headers.push(("Content-Range", range));
                }
                headers.push(("Content-Length", body.len().to_string()));
                let body = if method == "HEAD" { Vec::new() } else { body };
                return response(&request, status, &headers, body);
            }
            Upstream::Stale(status) if !fresh => {
                log::info!(
                    "[media::bilibili_stream] {} CDN {} → refresh play url",
                    file_id,
                    status
                );
                forget_source(&cache_key(&file_id, qn, epoch));
                fresh = true;
            }
            Upstream::Stale(status) => {
                return text_error(
                    &request,
                    502,
                    &format!("B 站视频服务器拒绝了请求（HTTP {}）", status),
                );
            }
            Upstream::Failed(message) => {
                log::warn!("[media::bilibili_stream] {}: {}", file_id, message);
                return text_error(&request, 502, &message);
            }
        }
    }
    text_error(&request, 502, "B 站视频暂时无法播放")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_path_accepts_vfs_file_ids_only() {
        assert_eq!(
            parse_stream_path("/file_AbC-12_x").as_deref(),
            Some("file_AbC-12_x")
        );
        assert_eq!(
            parse_stream_path("/file_a%5Fb").as_deref(),
            Some("file_a_b")
        );
        assert_eq!(
            parse_stream_path("/att_x/anything").as_deref(),
            Some("att_x")
        );
        assert!(parse_stream_path("/../etc/passwd").is_none());
        assert!(parse_stream_path("/https%3A%2F%2Fevil.com").is_none());
        assert!(parse_stream_path("/res_abc").is_none());
        assert!(parse_stream_path("/").is_none());
    }

    #[test]
    fn upstream_range_is_clamped_to_one_chunk() {
        let chunk = STREAM_CHUNK_BYTES;
        assert_eq!(upstream_range(None), Some((0, chunk - 1)));
        assert_eq!(upstream_range(Some("bytes=0-")), Some((0, chunk - 1)));
        assert_eq!(upstream_range(Some("bytes=100-199")), Some((100, 199)));
        assert_eq!(
            upstream_range(Some("bytes=10-999999999")),
            Some((10, 10 + chunk - 1))
        );
        assert_eq!(upstream_range(Some("bytes=-500")), None);
        assert_eq!(upstream_range(Some("bytes=0-1,5-6")), None);
        assert_eq!(upstream_range(Some("bytes=9-3")), None);
        assert_eq!(upstream_range(Some("items=0-1")), None);
    }

    #[test]
    fn only_https_bilibili_cdn_urls_are_proxied() {
        assert!(is_cdn_url(
            "https://cn-bj-cc-03-01.bilivideo.com/upgcxcode/1.mp4?e=1"
        ));
        assert!(is_cdn_url(
            "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/v.mp4"
        ));
        assert!(is_cdn_url("https://upos-hz-mirrorakam.akamaized.net/a.mp4"));
        assert!(!is_cdn_url("http://cn-bj-cc-03-01.bilivideo.com/a.mp4"));
        assert!(!is_cdn_url("https://evil.com/bilivideo.com.mp4"));
        assert!(!is_cdn_url("https://bilivideo.com.evil.com/a.mp4"));
        assert!(!is_cdn_url("not a url"));
    }

    #[test]
    fn picks_single_mp4_and_falls_back_to_backup_url() {
        let data: PlayUrlData = serde_json::from_str(
            r#"{"durl":[{"url":"https://evil.example.com/a.mp4","backup_url":["http://cn-x.bilivideo.com/b.mp4"]}]}"#,
        )
        .unwrap();
        assert_eq!(
            pick_play_url(&data).unwrap(),
            "https://cn-x.bilivideo.com/b.mp4"
        );

        let multi: PlayUrlData = serde_json::from_str(
            r#"{"durl":[{"url":"https://a.bilivideo.com/1"},{"url":"https://a.bilivideo.com/2"}]}"#,
        )
        .unwrap();
        assert!(pick_play_url(&multi).is_err());
        let none: PlayUrlData = serde_json::from_str(r#"{"durl":[]}"#).unwrap();
        assert!(pick_play_url(&none).is_err());
    }

    #[tokio::test]
    async fn resolves_play_url_through_the_api_with_cookie() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/x/player/playurl")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("bvid".into(), "BV1Ss4y1W7KB".into()),
                mockito::Matcher::UrlEncoded("cid".into(), "995381097".into()),
                mockito::Matcher::UrlEncoded("platform".into(), "html5".into()),
            ]))
            .match_header("cookie", "SESSDATA=s")
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"code":0,"message":"0","data":{"format":"mp4","durl":[{"url":"https://cn-bj.bilivideo.com/v.mp4?e=1","size":10}]}}"#,
            )
            .create_async()
            .await;
        let client = BiliClient::for_test(&server.url()).with_cookie(Some("SESSDATA=s".into()));
        let descriptor: BiliLinkDescriptor = serde_json::from_value(serde_json::json!({
            "kind": "bilibili", "version": 1, "bvid": "BV1Ss4y1W7KB", "aid": 1, "cid": 995381097u64,
            "page": 1, "pageCount": 1, "title": "t", "durationMs": 1000, "url": "https://www.bilibili.com/video/BV1Ss4y1W7KB"
        }))
        .unwrap();
        let info = resolve_play_info(&client, &descriptor, DEFAULT_QN)
            .await
            .unwrap();
        assert_eq!(info.url, "https://cn-bj.bilivideo.com/v.mp4?e=1");
        // 老响应没有清晰度字段：按请求的 qn 记
        assert_eq!(info.quality, DEFAULT_QN);
    }

    fn descriptor() -> BiliLinkDescriptor {
        serde_json::from_value(serde_json::json!({
            "kind": "bilibili", "version": 1, "bvid": "BV1Ss4y1W7KB", "aid": 1, "cid": 995381097u64,
            "page": 1, "pageCount": 1, "title": "t", "durationMs": 1000, "url": "https://www.bilibili.com/video/BV1Ss4y1W7KB"
        }))
        .unwrap()
    }

    #[test]
    fn stream_qn_comes_from_query_and_falls_back_to_default() {
        assert_eq!(parse_stream_query(None), (DEFAULT_QN, 0));
        assert_eq!(parse_stream_query(Some("")), (DEFAULT_QN, 0));
        assert_eq!(parse_stream_query(Some("qn=64")), (64, 0));
        assert_eq!(parse_stream_query(Some("t=1&qn=16&e=3")), (16, 3));
        // DASH 才有的档位、非法值都回到默认
        assert_eq!(parse_stream_query(Some("qn=112")).0, DEFAULT_QN);
        assert_eq!(parse_stream_query(Some("qn=120")).0, DEFAULT_QN);
        assert_eq!(parse_stream_query(Some("qn=abc&e=x")), (DEFAULT_QN, 0));
        assert_eq!(parse_stream_query(Some("xqn=64")).0, DEFAULT_QN);
        assert_eq!(normalize_qn(Some(32)), 32);
        assert_eq!(normalize_qn(Some(116)), DEFAULT_QN);
        assert_eq!(normalize_qn(None), DEFAULT_QN);
    }

    #[test]
    fn cache_key_separates_qualities() {
        assert_ne!(cache_key("file_a", 80, 0), cache_key("file_a", 64, 0));
        assert_ne!(cache_key("file_a", 64, 0), cache_key("file_b", 64, 0));
        // 登录 / 退出后（账号代次 +1）不复用游客取到的地址
        assert_ne!(cache_key("file_a", 80, 0), cache_key("file_a", 80, 1));
        let info = PlayInfo {
            url: "https://a.bilivideo.com/720.mp4".into(),
            quality: 64,
            options: vec![],
        };
        remember_source(&cache_key("file_cache_test", 64, 0), &info);
        assert_eq!(
            cached_source(&cache_key("file_cache_test", 64, 0)),
            Some(info)
        );
        assert_eq!(cached_source(&cache_key("file_cache_test", 80, 0)), None);
        forget_source(&cache_key("file_cache_test", 64, 0));
        assert_eq!(cached_source(&cache_key("file_cache_test", 64, 0)), None);
    }

    #[test]
    fn quality_options_keep_only_mp4_levels_from_accept_quality() {
        // 登录大会员：accept_quality 带 4K / 1080P+ / 720P60，单文件 MP4 给不了，过滤掉
        let data: PlayUrlData = serde_json::from_str(
            r#"{"quality":80,"accept_quality":[120,116,112,80,74,64,32,16],
                "accept_description":["超清 4K","高清 1080P60","高清 1080P+","高清 1080P","高清 720P60","高清 720P","清晰 480P","流畅 360P"],
                "durl":[{"url":"https://a.bilivideo.com/1080.mp4"}]}"#,
        )
        .unwrap();
        let info = parse_play_info(&data, 80).unwrap();
        assert_eq!(info.quality, 80);
        assert_eq!(
            info.options,
            vec![
                QualityOption {
                    qn: 80,
                    label: "高清 1080P".into()
                },
                QualityOption {
                    qn: 64,
                    label: "高清 720P".into()
                },
                QualityOption {
                    qn: 32,
                    label: "清晰 480P".into()
                },
                QualityOption {
                    qn: 16,
                    label: "流畅 360P".into()
                },
            ]
        );

        // 游客（实测 html5 平台的形状）：只有 720P / 360P
        let guest: PlayUrlData = serde_json::from_str(
            r#"{"quality":64,"format":"mp4720","accept_quality":[64,16],"accept_description":["高清 720P","流畅 360P"],
                "durl":[{"url":"https://a.bilivideo.com/720.mp4"}]}"#,
        )
        .unwrap();
        let qns: Vec<u32> = mp4_quality_options(&guest).iter().map(|o| o.qn).collect();
        assert_eq!(qns, vec![64, 16]);

        // 描述缺失 / 长度对不上时用兜底名称；实际返回的清晰度总在列表里
        let sparse: PlayUrlData = serde_json::from_str(
            r#"{"quality":32,"accept_quality":[64,16],"accept_description":["高清 720P"],"durl":[]}"#,
        )
        .unwrap();
        assert_eq!(
            mp4_quality_options(&sparse),
            vec![
                QualityOption {
                    qn: 64,
                    label: "高清 720P".into()
                },
                QualityOption {
                    qn: 32,
                    label: "480P".into()
                },
                QualityOption {
                    qn: 16,
                    label: "360P".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn requests_selected_qn_and_reports_downgraded_quality() {
        let mut server = mockito::Server::new_async().await;
        // 请求 1080P，但游客只能拿到 720P：B 站降档，quality 给实际值
        let _m = server
            .mock("GET", "/x/player/playurl")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("qn".into(), "80".into()),
                mockito::Matcher::UrlEncoded("fnval".into(), "1".into()),
            ]))
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"code":0,"message":"0","data":{"quality":64,"format":"mp4720","accept_quality":[64,16],
                    "accept_description":["高清 720P","流畅 360P"],
                    "durl":[{"url":"https://cn-bj.bilivideo.com/720.mp4?e=1"}]}}"#,
            )
            .create_async()
            .await;
        let _low = server
            .mock("GET", "/x/player/playurl")
            .match_query(mockito::Matcher::UrlEncoded("qn".into(), "16".into()))
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"code":0,"message":"0","data":{"quality":16,"format":"mp4","accept_quality":[64,16],
                    "accept_description":["高清 720P","流畅 360P"],
                    "durl":[{"url":"https://cn-bj.bilivideo.com/360.mp4?e=1"}]}}"#,
            )
            .create_async()
            .await;
        let client = BiliClient::for_test(&server.url());
        let high = resolve_play_info(&client, &descriptor(), 80).await.unwrap();
        assert_eq!(high.quality, 64);
        assert_eq!(high.url, "https://cn-bj.bilivideo.com/720.mp4?e=1");
        assert_eq!(
            high.options.iter().map(|o| o.qn).collect::<Vec<_>>(),
            vec![64, 16]
        );
        let low = resolve_play_info(&client, &descriptor(), 16).await.unwrap();
        assert_eq!(low.quality, 16);
        assert_eq!(low.url, "https://cn-bj.bilivideo.com/360.mp4?e=1");
    }
}
