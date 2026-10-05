//! B 站链接 → 字幕：新建链接条目（不下载音视频），或给已有媒体挂上 B 站字幕
//!
//! 只走匿名网页接口，不带 Cookie / 登录态：
//! - `x/web-interface/view`：BV / av → 标题、UP 主、封面、分 P（cid、时长）
//! - `x/v2/dm/view?type=1&oid={cid}&pid={aid}`：字幕轨（UP 主字幕与 AI 字幕）。播放器接口
//!   `x/player/wbi/v2` 匿名时返回 `need_login_subtitle=true` 和空列表，所以不用它
//! - 字幕文件：B 站 CDN 上的 BCC JSON，交给 [`parse_subtitle`]
//!
//! 链接条目仍是 VFS File（`{标题}.bilibili`，MIME [`BILIBILI_LINK_MIME`]），内容为
//! [`BiliLinkDescriptor`]；字幕写进转写段（`source='import'`），检索 / 问答 / 讲义照常。
//! 同一视频同一分 P 再导入时复用原条目，只替换字幕。
//!
//! | 命令 | 说明 |
//! |---|---|
//! | `media_bilibili_probe(input, page?)` | 解析链接：标题 / 分 P / 字幕轨 / 默认轨 / 已有条目 |
//! | `media_bilibili_create(input, page?, lan?)` | 新建（或复用）链接条目并导入字幕 |
//! | `media_bilibili_import_subtitle(resourceId, input, page?, lan?)` | 给已有媒体导入 B 站字幕 |
//! | `media_bilibili_link_get(resourceId)` | 读链接条目的描述（内嵌播放器用） |

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, LOCATION, REFERER};
use reqwest::Url;
use rusqlite::params;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{State, Window};

use super::commands::{import_subtitle_bytes, load, TranscriptView};
use super::pipeline::{load_media_file, resolve_media_source, MediaFileInfo};
use super::subtitle::{parse_subtitle, MAX_SUBTITLE_BYTES};
use super::{MediaError, BILIBILI_LINK_EXTENSION, BILIBILI_LINK_MIME};
use crate::vfs::database::VfsDatabase;
use crate::vfs::pdf_processing_service::PdfProcessingService;
use crate::vfs::repos::media_transcript_repo::MediaTranscriptRepo;
use crate::vfs::repos::VfsAttachmentRepo;
use crate::vfs::types::{VfsAttachment, VfsUploadAttachmentParams};

type CmdResult<T> = Result<T, String>;

fn err(e: MediaError) -> String {
    e.to_payload_string()
}

const API_BASE: &str = "https://api.bilibili.com";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DESCRIPTOR_KIND: &str = "bilibili";
const DESCRIPTOR_VERSION: u32 = 1;
const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
/// 交给字幕解析器的文件名（`.json` → BCC）
const SUBTITLE_FILE_NAME: &str = "bilibili.json";
const MAX_FILE_STEM_CHARS: usize = 100;

pub const ERR_INVALID_LINK: &str = "bilibili-invalid-link";
pub const ERR_UNSUPPORTED_LINK: &str = "bilibili-unsupported-link";
pub const ERR_UNAVAILABLE: &str = "bilibili-video-unavailable";
pub const ERR_NO_SUBTITLE: &str = "bilibili-no-subtitle";
pub const ERR_REQUEST: &str = "bilibili-request-failed";

fn bili_err(code: &str, message: impl Into<String>) -> MediaError {
    MediaError::Bilibili {
        code: code.to_string(),
        message: message.into(),
    }
}

fn request_failed(e: reqwest::Error) -> MediaError {
    if e.is_timeout() {
        bili_err(ERR_REQUEST, "请求 B 站超时，请检查网络后重试")
    } else {
        bili_err(ERR_REQUEST, format!("请求 B 站失败：{}", e))
    }
}

fn blocked_error() -> MediaError {
    bili_err(ERR_REQUEST, "B 站暂时拦截了请求（风控），请过几分钟再试")
}

// ============================================================================
// 链接解析
// ============================================================================

static UNSUPPORTED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)bilibili\.com/(?:bangumi|cheese|audio)/|live\.bilibili\.com").unwrap()
});
static BV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^0-9A-Za-z])([Bb][Vv][0-9A-Za-z]{10})(?:[^0-9A-Za-z]|$)").unwrap()
});
static AV_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^0-9a-z])av(\d{1,19})(?:[^0-9]|$)").unwrap());
static SHORT_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:https?://)?(?:www\.)?(b23\.tv|bili2233\.cn)/([0-9A-Za-z]+)").unwrap()
});
static PAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?&]p=(\d{1,5})").unwrap());
static BVID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^BV[0-9A-Za-z]{10}$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BiliVideoId {
    Bv(String),
    Av(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BiliTarget {
    pub id: BiliVideoId,
    /// 链接里的 `?p=`（1 起）
    pub page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedLink {
    Video(BiliTarget),
    /// `b23.tv` / `bili2233.cn` 短链：跟一次跳转再解析
    Short(String),
}

/// 视频页地址、分享文案、短链或裸 BV / av 号
pub fn parse_link(input: &str) -> Result<ParsedLink, MediaError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(bili_err(ERR_INVALID_LINK, "请粘贴 B 站视频链接"));
    }
    if UNSUPPORTED_RE.is_match(text) {
        return Err(bili_err(
            ERR_UNSUPPORTED_LINK,
            "暂不支持番剧 / 影视、课堂、音频和直播链接，请粘贴普通视频的链接（含 BV 号）",
        ));
    }
    let page = PAGE_RE
        .captures(text)
        .and_then(|c| c[1].parse::<u32>().ok())
        .filter(|p| *p > 0);
    if let Some(c) = BV_RE.captures(text) {
        let raw = &c[1];
        return Ok(ParsedLink::Video(BiliTarget {
            id: BiliVideoId::Bv(format!("BV{}", &raw[2..])),
            page,
        }));
    }
    if let Some(aid) = AV_RE
        .captures(text)
        .and_then(|c| c[1].parse::<u64>().ok())
        .filter(|a| *a > 0)
    {
        return Ok(ParsedLink::Video(BiliTarget {
            id: BiliVideoId::Av(aid),
            page,
        }));
    }
    if let Some(c) = SHORT_LINK_RE.captures(text) {
        return Ok(ParsedLink::Short(format!(
            "https://{}/{}",
            c[1].to_ascii_lowercase(),
            &c[2]
        )));
    }
    Err(bili_err(
        ERR_INVALID_LINK,
        "没有认出 B 站视频链接：请粘贴视频页地址（含 BV 号）或 b23.tv 分享短链",
    ))
}

fn is_bvid(s: &str) -> bool {
    BVID_RE.is_match(s)
}

pub fn page_url(bvid: &str, page: u32) -> String {
    format!("https://www.bilibili.com/video/{}?p={}", bvid, page)
}

fn is_bilibili_host(host: &str) -> bool {
    const DOMAINS: &[&str] = &[
        "hdslb.com",
        "bilibili.com",
        "biliapi.net",
        "bilivideo.com",
        "bilivideo.cn",
    ];
    let host = host.to_ascii_lowercase();
    DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{}", d)))
}

/// `//host/x` 与 `http://` 统一成 https，且只接受 B 站自己的域名
fn normalize_bilibili_url(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let full = if raw.starts_with("//") {
        format!("https:{}", raw)
    } else {
        raw.to_string()
    };
    let mut url = Url::parse(&full).ok()?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    (url.scheme() == "https" && url.host_str().is_some_and(is_bilibili_host)).then_some(url)
}

// ============================================================================
// 接口数据
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliPage {
    pub page: u32,
    pub cid: u64,
    pub part: String,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideo {
    pub bvid: String,
    pub aid: u64,
    pub title: String,
    pub owner: Option<String>,
    pub cover: Option<String>,
    pub duration_ms: i64,
    pub pages: Vec<BiliPage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliSubtitleTrack {
    /// `zh-CN` / `en-US` / `ai-zh` …
    pub lan: String,
    /// 「中文（中国）」「中文（自动生成）」…
    pub lan_doc: String,
    /// B 站自动生成的 AI 字幕
    pub ai: bool,
    #[serde(skip)]
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct BiliLookup {
    pub video: BiliVideo,
    pub page: BiliPage,
    pub tracks: Vec<BiliSubtitleTrack>,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Deserialize)]
struct ViewData {
    bvid: String,
    aid: u64,
    #[serde(default)]
    cid: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    pic: String,
    #[serde(default)]
    duration: i64,
    #[serde(default)]
    owner: Option<ViewOwner>,
    #[serde(default)]
    pages: Option<Vec<ViewPage>>,
}

#[derive(Deserialize)]
struct ViewOwner {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct ViewPage {
    cid: u64,
    page: u32,
    #[serde(default)]
    part: String,
    #[serde(default)]
    duration: i64,
}

#[derive(Deserialize)]
struct DmViewData {
    #[serde(default)]
    subtitle: Option<DmSubtitle>,
}

#[derive(Deserialize)]
struct DmSubtitle {
    #[serde(default)]
    subtitles: Option<Vec<DmSubtitleItem>>,
}

#[derive(Deserialize)]
struct DmSubtitleItem {
    #[serde(default)]
    lan: String,
    #[serde(default)]
    lan_doc: String,
    #[serde(default)]
    subtitle_url: String,
    #[serde(default)]
    ai_type: i64,
}

/// 默认字幕轨：UP 主简体中文 > 其它中文 > AI 简体中文 > 其它 AI 中文 > 其它 UP 主字幕 > 其它 AI 字幕；
/// `preferred` 精确命中时优先
pub fn pick_track<'a>(
    tracks: &'a [BiliSubtitleTrack],
    preferred: Option<&str>,
) -> Option<&'a BiliSubtitleTrack> {
    if let Some(lan) = preferred.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(track) = tracks.iter().find(|t| t.lan == lan) {
            return Some(track);
        }
    }
    tracks.iter().min_by_key(|t| track_rank(t))
}

fn track_rank(track: &BiliSubtitleTrack) -> u8 {
    let lan = track.lan.to_ascii_lowercase();
    let base = lan.trim_start_matches("ai-");
    let hans = matches!(base, "zh" | "zh-cn" | "zh-hans" | "zh-sg");
    let chinese = base.starts_with("zh");
    match (track.ai, hans, chinese) {
        (false, true, _) => 0,
        (false, false, true) => 1,
        (true, true, _) => 2,
        (true, false, true) => 3,
        (false, false, false) => 4,
        (true, false, false) => 5,
    }
}

// ============================================================================
// 客户端
// ============================================================================

pub struct BiliClient {
    http: reqwest::Client,
    no_redirect: reqwest::Client,
    api_base: String,
    /// 字幕地址只认 B 站域名并升级为 https（测试指向本地 mock 时关闭）
    strict_hosts: bool,
}

impl BiliClient {
    pub fn new() -> Result<Self, MediaError> {
        Self::build(API_BASE, true, false)
    }

    #[cfg(test)]
    fn for_test(api_base: &str) -> Self {
        Self::build(api_base, false, true).expect("test client")
    }

    fn build(api_base: &str, strict_hosts: bool, no_proxy: bool) -> Result<Self, MediaError> {
        let make = |follow_redirects: bool| {
            let mut headers = HeaderMap::new();
            headers.insert(
                REFERER,
                HeaderValue::from_static("https://www.bilibili.com/"),
            );
            let mut builder = reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .default_headers(headers)
                .timeout(REQUEST_TIMEOUT);
            if !follow_redirects {
                builder = builder.redirect(reqwest::redirect::Policy::none());
            }
            if no_proxy {
                builder = builder.no_proxy();
            }
            builder
                .build()
                .map_err(|e| bili_err(ERR_REQUEST, format!("初始化网络客户端失败：{}", e)))
        };
        Ok(Self {
            http: make(true)?,
            no_redirect: make(false)?,
            api_base: api_base.trim_end_matches('/').to_string(),
            strict_hosts,
        })
    }

    pub async fn resolve(&self, input: &str) -> Result<BiliTarget, MediaError> {
        match parse_link(input)? {
            ParsedLink::Video(target) => Ok(target),
            ParsedLink::Short(url) => {
                let location = self.follow_short_link(&url).await?;
                match parse_link(&location) {
                    Ok(ParsedLink::Video(target)) => Ok(target),
                    _ => Err(bili_err(
                        ERR_INVALID_LINK,
                        "短链没有跳转到 B 站视频页，请改贴视频页地址",
                    )),
                }
            }
        }
    }

    async fn follow_short_link(&self, url: &str) -> Result<String, MediaError> {
        let resp = self
            .no_redirect
            .get(url)
            .send()
            .await
            .map_err(request_failed)?;
        resp.status()
            .is_redirection()
            .then(|| resp.headers().get(LOCATION))
            .flatten()
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| {
                bili_err(
                    ERR_INVALID_LINK,
                    "短链已失效或没有跳转到视频页，请改贴视频页地址",
                )
            })
    }

    async fn get_api<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Option<T>, MediaError> {
        let url = format!("{}{}", self.api_base, path);
        let resp = self
            .http
            .get(&url)
            .query(query)
            .send()
            .await
            .map_err(request_failed)?;
        let status = resp.status();
        if status.as_u16() == 412 {
            return Err(blocked_error());
        }
        if !status.is_success() {
            return Err(bili_err(
                ERR_REQUEST,
                format!("B 站接口返回 HTTP {}", status.as_u16()),
            ));
        }
        let body: ApiEnvelope<T> = resp
            .json()
            .await
            .map_err(|e| bili_err(ERR_REQUEST, format!("B 站接口返回的内容无法解析：{}", e)))?;
        match body.code {
            0 => Ok(body.data),
            -404 | -403 | 62002 | 62004 | 62005 | 62012 => Err(bili_err(
                ERR_UNAVAILABLE,
                format!(
                    "视频不存在或当前不可见（B 站返回 {}：{}）",
                    body.code, body.message
                ),
            )),
            -412 | -352 => Err(blocked_error()),
            code => Err(bili_err(
                ERR_REQUEST,
                format!("B 站接口返回错误 {}：{}", code, body.message),
            )),
        }
    }

    pub async fn video(&self, id: &BiliVideoId) -> Result<BiliVideo, MediaError> {
        let query = match id {
            BiliVideoId::Bv(bvid) => ("bvid", bvid.clone()),
            BiliVideoId::Av(aid) => ("aid", aid.to_string()),
        };
        let data: ViewData = self
            .get_api("/x/web-interface/view", &[query])
            .await?
            .ok_or_else(|| bili_err(ERR_UNAVAILABLE, "B 站没有返回这个视频的信息"))?;
        let mut pages: Vec<BiliPage> = data
            .pages
            .unwrap_or_default()
            .into_iter()
            .map(|p| BiliPage {
                page: p.page,
                cid: p.cid,
                part: p.part,
                duration_ms: p.duration.max(0) * 1000,
            })
            .collect();
        if pages.is_empty() && data.cid > 0 {
            pages.push(BiliPage {
                page: 1,
                cid: data.cid,
                part: data.title.clone(),
                duration_ms: data.duration.max(0) * 1000,
            });
        }
        Ok(BiliVideo {
            bvid: data.bvid,
            aid: data.aid,
            title: data.title,
            owner: data.owner.map(|o| o.name).filter(|n| !n.trim().is_empty()),
            cover: normalize_bilibili_url(&data.pic).map(String::from),
            duration_ms: data.duration.max(0) * 1000,
            pages,
        })
    }

    pub async fn subtitle_tracks(
        &self,
        aid: u64,
        cid: u64,
    ) -> Result<Vec<BiliSubtitleTrack>, MediaError> {
        let data: Option<DmViewData> = self
            .get_api(
                "/x/v2/dm/view",
                &[
                    ("type", "1".to_string()),
                    ("oid", cid.to_string()),
                    ("pid", aid.to_string()),
                ],
            )
            .await?;
        Ok(data
            .and_then(|d| d.subtitle)
            .and_then(|s| s.subtitles)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| !s.subtitle_url.trim().is_empty() && !s.lan.trim().is_empty())
            .map(|s| BiliSubtitleTrack {
                ai: s.lan.starts_with("ai-") || s.ai_type != 0,
                lan_doc: if s.lan_doc.trim().is_empty() {
                    s.lan.clone()
                } else {
                    s.lan_doc
                },
                lan: s.lan,
                url: s.subtitle_url,
            })
            .collect())
    }

    /// 链接 → 视频信息 + 选中的分 P（参数 page > 链接 `?p=` > 第 1 P）+ 该分 P 的字幕轨
    pub async fn lookup(&self, input: &str, page: Option<u32>) -> Result<BiliLookup, MediaError> {
        let target = self.resolve(input).await?;
        let video = self.video(&target.id).await?;
        let wanted = page.filter(|p| *p > 0).or(target.page).unwrap_or(1);
        let selected = video
            .pages
            .iter()
            .find(|p| p.page == wanted)
            .cloned()
            .ok_or_else(|| {
                bili_err(
                    ERR_UNAVAILABLE,
                    format!("这个视频没有第 {} P（共 {} P）", wanted, video.pages.len()),
                )
            })?;
        let tracks = self.subtitle_tracks(video.aid, selected.cid).await?;
        Ok(BiliLookup {
            video,
            page: selected,
            tracks,
        })
    }

    pub async fn subtitle_bytes(
        &self,
        lookup: &BiliLookup,
        lan: Option<&str>,
    ) -> Result<(BiliSubtitleTrack, Vec<u8>), MediaError> {
        let track = pick_track(&lookup.tracks, lan).cloned().ok_or_else(|| {
            let which = if lookup.video.pages.len() > 1 {
                format!("第 {} P", lookup.page.page)
            } else {
                "这个视频".to_string()
            };
            bili_err(
                ERR_NO_SUBTITLE,
                format!(
                    "{}没有可用字幕：UP 主没有上传字幕，B 站也没有生成 AI 字幕。可以把视频下载到本地后导入，用语音识别转写",
                    which
                ),
            )
        })?;
        let bytes = self.download_subtitle(&track).await?;
        Ok((track, bytes))
    }

    async fn download_subtitle(&self, track: &BiliSubtitleTrack) -> Result<Vec<u8>, MediaError> {
        let url = self.subtitle_url(&track.url)?;
        let mut resp = self.http.get(url).send().await.map_err(request_failed)?;
        if !resp.status().is_success() {
            return Err(bili_err(
                ERR_REQUEST,
                format!("下载字幕失败：HTTP {}", resp.status().as_u16()),
            ));
        }
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(request_failed)? {
            if (buf.len() + chunk.len()) as u64 > MAX_SUBTITLE_BYTES {
                return Err(bili_err(ERR_REQUEST, "字幕文件超过 20 MB，已放弃"));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(buf)
    }

    fn subtitle_url(&self, raw: &str) -> Result<Url, MediaError> {
        let parsed = if self.strict_hosts {
            normalize_bilibili_url(raw)
        } else {
            Url::parse(raw.trim()).ok()
        };
        parsed.ok_or_else(|| bili_err(ERR_REQUEST, "B 站返回的字幕地址无效"))
    }
}

// ============================================================================
// 链接条目
// ============================================================================

/// 链接条目的内容（VFS blob）。不含导入时间等易变字段
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliLinkDescriptor {
    pub kind: String,
    pub version: u32,
    pub bvid: String,
    pub aid: u64,
    pub cid: u64,
    pub page: u32,
    pub page_count: u32,
    pub title: String,
    #[serde(default)]
    pub part: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    pub duration_ms: i64,
    pub url: String,
}

impl BiliLinkDescriptor {
    pub fn from_lookup(lookup: &BiliLookup) -> Self {
        let video = &lookup.video;
        Self {
            kind: DESCRIPTOR_KIND.to_string(),
            version: DESCRIPTOR_VERSION,
            bvid: video.bvid.clone(),
            aid: video.aid,
            cid: lookup.page.cid,
            page: lookup.page.page,
            page_count: video.pages.len().max(1) as u32,
            title: video.title.clone(),
            part: lookup.page.part.clone(),
            owner: video.owner.clone(),
            cover: video.cover.clone(),
            duration_ms: if lookup.page.duration_ms > 0 {
                lookup.page.duration_ms
            } else {
                video.duration_ms
            },
            url: page_url(&video.bvid, lookup.page.page),
        }
    }

    /// `{标题}[ P{n} {分P标题}].bilibili`，去掉文件名非法字符
    pub fn file_name(&self) -> String {
        let title = self.title.trim();
        let part = self.part.trim();
        let stem = if self.page_count > 1 {
            if part.is_empty() || part == title {
                format!("{} P{}", title, self.page)
            } else {
                format!("{} P{} {}", title, self.page, part)
            }
        } else {
            title.to_string()
        };
        let replaced: String = stem
            .chars()
            .map(|c| {
                if c.is_control() || "/\\:*?\"<>|".contains(c) {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
        let truncated: String = collapsed.chars().take(MAX_FILE_STEM_CHARS).collect();
        let cleaned = truncated.trim().trim_end_matches('.').trim();
        let stem = if cleaned.is_empty() {
            self.bvid.as_str()
        } else {
            cleaned
        };
        format!("{}.{}", stem, BILIBILI_LINK_EXTENSION)
    }

    fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, MediaError> {
        let invalid = || MediaError::InvalidInput("不是有效的 B 站链接条目".into());
        let mut descriptor: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if descriptor.kind != DESCRIPTOR_KIND || !is_bvid(&descriptor.bvid) || descriptor.page == 0
        {
            return Err(invalid());
        }
        descriptor.cover = descriptor
            .cover
            .as_deref()
            .and_then(normalize_bilibili_url)
            .map(String::from);
        descriptor.url = page_url(&descriptor.bvid, descriptor.page);
        Ok(descriptor)
    }
}

/// 读链接条目的描述（内容很小，整读）
pub fn read_link_descriptor(
    vfs_db: &VfsDatabase,
    file_id: &str,
) -> Result<BiliLinkDescriptor, MediaError> {
    let source = resolve_media_source(vfs_db, file_id)?;
    if std::fs::metadata(&source.path)?.len() > MAX_DESCRIPTOR_BYTES {
        return Err(MediaError::InvalidInput("不是有效的 B 站链接条目".into()));
    }
    BiliLinkDescriptor::parse(&std::fs::read(&source.path)?)
}

/// 同一视频同一分 P 的未删除链接条目
pub fn find_link_item(
    vfs_db: &VfsDatabase,
    bvid: &str,
    page: u32,
) -> Result<Option<String>, MediaError> {
    let ids: Vec<String> = {
        let conn = vfs_db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id FROM files
             WHERE deleted_at IS NULL AND COALESCE(status, 'active') = 'active'
               AND lower(COALESCE(mime_type, '')) = ?1
             ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![BILIBILI_LINK_MIME], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(ids.into_iter().find(|id| {
        read_link_descriptor(vfs_db, id).is_ok_and(|d| d.bvid == bvid && d.page == page)
    }))
}

/// 新建（或复用同一视频同一分 P 的）链接条目并写入时长；新建时一并返回附件（用于资源库事件）
pub fn upsert_link_item(
    vfs_db: &VfsDatabase,
    descriptor: &BiliLinkDescriptor,
) -> Result<(MediaFileInfo, Option<VfsAttachment>), MediaError> {
    let (file_id, created) = match find_link_item(vfs_db, &descriptor.bvid, descriptor.page)? {
        Some(id) => (id, None),
        None => {
            let params = VfsUploadAttachmentParams {
                name: descriptor.file_name(),
                mime_type: BILIBILI_LINK_MIME.to_string(),
                base64_content: String::new(),
                attachment_type: None,
            };
            let result = VfsAttachmentRepo::upload_media_stream_with_folder(
                vfs_db,
                &params,
                &mut std::io::Cursor::new(descriptor.to_bytes()),
                None,
            )?;
            let id = result.source_id.clone();
            (id, result.is_new.then_some(result.attachment))
        }
    };
    let info = load_media_file(vfs_db, &file_id)?;
    if descriptor.duration_ms > 0 {
        let conn = vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::record_duration_with_conn(
            &conn,
            &info.file_id,
            descriptor.duration_ms,
        )?;
    }
    Ok((info, created))
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliProbeView {
    pub bvid: String,
    pub title: String,
    pub owner: Option<String>,
    pub cover: Option<String>,
    pub duration_ms: i64,
    pub pages: Vec<BiliPage>,
    /// 选中的分 P
    pub page: u32,
    pub tracks: Vec<BiliSubtitleTrack>,
    pub default_lan: Option<String>,
    pub url: String,
    /// 同一视频同一分 P 已有的链接条目（再导入复用它，只替换字幕）
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliCreateResult {
    pub file_id: String,
    pub name: String,
    pub created: bool,
    pub segments: usize,
    pub lan: String,
    pub lan_doc: String,
    pub ai: bool,
}

async fn blocking<T, F>(f: F) -> Result<T, MediaError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, MediaError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| MediaError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn media_bilibili_probe(
    input: String,
    page: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> CmdResult<BiliProbeView> {
    let client = BiliClient::new().map_err(err)?;
    let lookup = client.lookup(&input, page).await.map_err(err)?;
    let existing_id = {
        let db = Arc::clone(vfs_db.inner());
        let bvid = lookup.video.bvid.clone();
        let page = lookup.page.page;
        blocking(move || find_link_item(&db, &bvid, page))
            .await
            .map_err(err)?
    };
    let default_lan = pick_track(&lookup.tracks, None).map(|t| t.lan.clone());
    Ok(BiliProbeView {
        url: page_url(&lookup.video.bvid, lookup.page.page),
        bvid: lookup.video.bvid,
        title: lookup.video.title,
        owner: lookup.video.owner,
        cover: lookup.video.cover,
        duration_ms: lookup.video.duration_ms,
        pages: lookup.video.pages,
        page: lookup.page.page,
        tracks: lookup.tracks,
        default_lan,
        existing_id,
    })
}

#[tauri::command]
pub async fn media_bilibili_create(
    window: Window,
    input: String,
    page: Option<u32>,
    lan: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> CmdResult<BiliCreateResult> {
    let db = Arc::clone(vfs_db.inner());
    let service = Arc::clone(pdf_processing_service.inner());
    let client = BiliClient::new().map_err(err)?;
    let lookup = client.lookup(&input, page).await.map_err(err)?;
    let (track, bytes) = client
        .subtitle_bytes(&lookup, lan.as_deref())
        .await
        .map_err(err)?;
    // 字幕先解析通过再建条目，不留下没有字幕的空条目
    parse_subtitle(SUBTITLE_FILE_NAME, &bytes).map_err(err)?;
    let descriptor = BiliLinkDescriptor::from_lookup(&lookup);
    let (info, created) = {
        let db = Arc::clone(&db);
        blocking(move || upsert_link_item(&db, &descriptor))
            .await
            .map_err(err)?
    };
    let view = import_subtitle_bytes(&db, &service, &info, SUBTITLE_FILE_NAME.into(), bytes)
        .await
        .map_err(err)?;
    if let Some(attachment) = created.as_ref() {
        use crate::dstu::handler_utils::{attachment_to_dstu_node, emit_watch_event};
        let node = attachment_to_dstu_node(attachment);
        emit_watch_event(
            &window,
            crate::dstu::types::DstuWatchEvent::created(node.path.clone(), node),
        );
    }
    log::info!(
        "[media::bilibili] {} link item {} ({} p{}, {} cues, {})",
        if created.is_some() {
            "created"
        } else {
            "updated"
        },
        info.file_id,
        lookup.video.bvid,
        lookup.page.page,
        view.segments.len(),
        track.lan
    );
    Ok(BiliCreateResult {
        file_id: info.file_id,
        name: info.file_name,
        created: created.is_some(),
        segments: view.segments.len(),
        lan: track.lan,
        lan_doc: track.lan_doc,
        ai: track.ai,
    })
}

#[tauri::command]
pub async fn media_bilibili_import_subtitle(
    resource_id: String,
    input: String,
    page: Option<u32>,
    lan: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> CmdResult<TranscriptView> {
    let db = Arc::clone(vfs_db.inner());
    let service = Arc::clone(pdf_processing_service.inner());
    let info = load(&db, &resource_id).await.map_err(err)?;
    let client = BiliClient::new().map_err(err)?;
    let lookup = client.lookup(&input, page).await.map_err(err)?;
    if info.is_link_item() {
        let own = {
            let db = Arc::clone(&db);
            let id = info.file_id.clone();
            blocking(move || read_link_descriptor(&db, &id))
                .await
                .map_err(err)?
        };
        if own.bvid != lookup.video.bvid || own.page != lookup.page.page {
            return Err(err(bili_err(
                ERR_INVALID_LINK,
                "链接条目只能重新获取它自己的字幕；要导入别的视频，请用「B 站链接」新建条目",
            )));
        }
    }
    let (_, bytes) = client
        .subtitle_bytes(&lookup, lan.as_deref())
        .await
        .map_err(err)?;
    import_subtitle_bytes(&db, &service, &info, SUBTITLE_FILE_NAME.into(), bytes)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn media_bilibili_link_get(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> CmdResult<BiliLinkDescriptor> {
    let db = Arc::clone(vfs_db.inner());
    let info = load(&db, &resource_id).await.map_err(err)?;
    if !info.is_link_item() {
        return Err(err(MediaError::InvalidInput(format!(
            "不是 B 站链接条目: {}",
            info.file_name
        ))));
    }
    blocking(move || read_link_descriptor(&db, &info.file_id))
        .await
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::commands::{build_view, estimate_impl, import_subtitle_impl};
    use crate::vfs::database::setup_migrated_test_db;
    use mockito::{Matcher, Server};

    fn video(link: &str) -> BiliTarget {
        match parse_link(link).unwrap() {
            ParsedLink::Video(t) => t,
            other => panic!("expected video for {link}: {other:?}"),
        }
    }

    #[test]
    fn parses_links_share_text_and_bare_ids() {
        assert_eq!(
            video("https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&share_source=copy_web"),
            BiliTarget {
                id: BiliVideoId::Bv("BV1GJ411x7h7".into()),
                page: Some(3)
            }
        );
        assert_eq!(
            video("【官方 MV】Never Gonna Give You Up https://m.bilibili.com/video/BV1GJ411x7h7")
                .id,
            BiliVideoId::Bv("BV1GJ411x7h7".into())
        );
        assert_eq!(
            video("bv1GJ411x7h7").id,
            BiliVideoId::Bv("BV1GJ411x7h7".into())
        );
        assert_eq!(
            video("https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7&oid=1").id,
            BiliVideoId::Bv("BV1GJ411x7h7".into())
        );
        assert_eq!(
            video("https://www.bilibili.com/video/av170001?p=2"),
            BiliTarget {
                id: BiliVideoId::Av(170001),
                page: Some(2)
            }
        );
        assert_eq!(video("AV170001").id, BiliVideoId::Av(170001));
        assert_eq!(video("BV1GJ411x7h7?p=0").page, None);

        assert_eq!(
            parse_link("看这个 https://b23.tv/AbC123 ！").unwrap(),
            ParsedLink::Short("https://b23.tv/AbC123".into())
        );
        assert_eq!(
            parse_link("bili2233.cn/xyz9").unwrap(),
            ParsedLink::Short("https://bili2233.cn/xyz9".into())
        );

        for unsupported in [
            "https://www.bilibili.com/bangumi/play/ep12345",
            "https://www.bilibili.com/cheese/play/ss100",
            "https://live.bilibili.com/123",
        ] {
            assert_eq!(
                parse_link(unsupported).unwrap_err().code(),
                ERR_UNSUPPORTED_LINK
            );
        }
        for invalid in [
            "",
            "   ",
            "https://www.example.com/video/123",
            "java1234567890",
        ] {
            assert_eq!(
                parse_link(invalid).unwrap_err().code(),
                ERR_INVALID_LINK,
                "{invalid}"
            );
        }
        // 比 BV 号长的字母数字串不算
        assert_eq!(
            parse_link("xBV1GJ411x7h7").unwrap_err().code(),
            ERR_INVALID_LINK
        );
    }

    fn track(lan: &str, ai: bool) -> BiliSubtitleTrack {
        BiliSubtitleTrack {
            lan: lan.into(),
            lan_doc: lan.into(),
            ai,
            url: format!("//aisubtitle.hdslb.com/{lan}.json"),
        }
    }

    #[test]
    fn default_track_prefers_creator_chinese_then_ai_chinese() {
        let tracks = vec![
            track("en-US", false),
            track("ai-zh", true),
            track("zh-Hant", false),
            track("zh-CN", false),
        ];
        assert_eq!(pick_track(&tracks, None).unwrap().lan, "zh-CN");
        assert_eq!(pick_track(&tracks[..3], None).unwrap().lan, "zh-Hant");
        assert_eq!(pick_track(&tracks[..2], None).unwrap().lan, "ai-zh");
        assert_eq!(pick_track(&tracks[..1], None).unwrap().lan, "en-US");
        assert_eq!(pick_track(&tracks, Some("en-US")).unwrap().lan, "en-US");
        // 指定的轨不存在：退回默认
        assert_eq!(pick_track(&tracks, Some("ja")).unwrap().lan, "zh-CN");
        assert!(pick_track(&[], None).is_none());
        let ai_only = vec![track("ai-en", true), track("ai-zh", true)];
        assert_eq!(pick_track(&ai_only, None).unwrap().lan, "ai-zh");
    }

    fn descriptor(title: &str, page: u32, page_count: u32, part: &str) -> BiliLinkDescriptor {
        BiliLinkDescriptor {
            kind: DESCRIPTOR_KIND.into(),
            version: DESCRIPTOR_VERSION,
            bvid: "BV1GJ411x7h7".into(),
            aid: 80433022,
            cid: 137649199,
            page,
            page_count,
            title: title.into(),
            part: part.into(),
            owner: Some("UP".into()),
            cover: Some("http://i0.hdslb.com/bfs/archive/a.jpg".into()),
            duration_ms: 213_000,
            url: page_url("BV1GJ411x7h7", page),
        }
    }

    #[test]
    fn descriptor_file_name_and_validation() {
        assert_eq!(
            descriptor("线性代数 / 第1讲: 向量?", 1, 1, "").file_name(),
            "线性代数 第1讲 向量.bilibili"
        );
        assert_eq!(
            descriptor("合集", 2, 16, "02 矩阵乘法").file_name(),
            "合集 P2 02 矩阵乘法.bilibili"
        );
        assert_eq!(
            descriptor("合集", 3, 16, "合集").file_name(),
            "合集 P3.bilibili"
        );
        assert_eq!(
            descriptor("  ...", 1, 1, "").file_name(),
            "BV1GJ411x7h7.bilibili"
        );
        assert_eq!(
            descriptor(&"长".repeat(300), 1, 1, "")
                .file_name()
                .chars()
                .count(),
            MAX_FILE_STEM_CHARS + ".bilibili".len()
        );

        let original = descriptor("课", 1, 1, "");
        let parsed = BiliLinkDescriptor::parse(&original.to_bytes()).unwrap();
        assert_eq!(
            parsed.cover.as_deref(),
            Some("https://i0.hdslb.com/bfs/archive/a.jpg")
        );
        assert_eq!(
            parsed.url,
            "https://www.bilibili.com/video/BV1GJ411x7h7?p=1"
        );

        let mut evil = descriptor("课", 1, 1, "");
        evil.cover = Some("https://evil.example.com/a.jpg".into());
        assert_eq!(
            BiliLinkDescriptor::parse(&evil.to_bytes()).unwrap().cover,
            None
        );
        let mut bad = descriptor("课", 1, 1, "");
        bad.bvid = "BV1\"><script>".into();
        assert!(BiliLinkDescriptor::parse(&bad.to_bytes()).is_err());
        assert!(BiliLinkDescriptor::parse(b"{\"kind\":\"other\"}").is_err());
    }

    #[test]
    fn subtitle_urls_must_stay_on_bilibili_hosts() {
        let strict = BiliClient::new().unwrap();
        assert_eq!(
            strict
                .subtitle_url("//aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=1")
                .unwrap()
                .as_str(),
            "https://aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=1"
        );
        assert_eq!(
            strict
                .subtitle_url("http://i0.hdslb.com/bfs/subtitle/b.json")
                .unwrap()
                .scheme(),
            "https"
        );
        for bad in [
            "https://evil.example.com/a.json",
            "https://hdslb.com.evil.example/a.json",
            "file:///etc/passwd",
            "",
        ] {
            assert!(strict.subtitle_url(bad).is_err(), "{bad}");
        }
    }

    const BCC: &str = r#"{"type":"AIsubtitle","body":[{"from":0.5,"to":2.0,"content":"第一句"},{"from":2.5,"to":4.0,"content":"第二句"}]}"#;

    fn view_body() -> String {
        serde_json::json!({
            "code": 0,
            "message": "0",
            "data": {
                "bvid": "BV1xx411c7mD",
                "aid": 42,
                "cid": 1001,
                "title": "线性代数",
                "pic": "http://i1.hdslb.com/bfs/archive/cover.jpg",
                "duration": 600,
                "owner": { "name": "老师" },
                "pages": [
                    { "cid": 1001, "page": 1, "part": "01 向量", "duration": 300 },
                    { "cid": 1002, "page": 2, "part": "02 矩阵", "duration": 300 }
                ]
            }
        })
        .to_string()
    }

    #[tokio::test]
    async fn lookup_picks_page_tracks_and_downloads_bcc() {
        let mut server = Server::new_async().await;
        let view = server
            .mock("GET", "/x/web-interface/view")
            .match_query(Matcher::UrlEncoded("bvid".into(), "BV1xx411c7mD".into()))
            .match_header("referer", "https://www.bilibili.com/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(view_body())
            .expect(2)
            .create_async()
            .await;
        let dm = server
            .mock("GET", "/x/v2/dm/view")
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("type".into(), "1".into()),
                Matcher::UrlEncoded("oid".into(), "1002".into()),
                Matcher::UrlEncoded("pid".into(), "42".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                serde_json::json!({
                    "code": 0,
                    "data": { "subtitle": { "subtitles": [
                        { "lan": "ai-zh", "lan_doc": "中文（自动生成）", "subtitle_url": format!("{}/sub/ai.json", server.url()), "ai_type": 0 },
                        { "lan": "zh-CN", "lan_doc": "中文（中国）", "subtitle_url": format!("{}/sub/zh.json", server.url()) },
                        { "lan": "en-US", "lan_doc": "English", "subtitle_url": "" }
                    ] } }
                })
                .to_string(),
            )
            .create_async()
            .await;
        let sub = server
            .mock("GET", "/sub/zh.json")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(BCC)
            .create_async()
            .await;

        let client = BiliClient::for_test(&server.url());
        let lookup = client
            .lookup("https://www.bilibili.com/video/BV1xx411c7mD?p=2", None)
            .await
            .unwrap();
        assert_eq!(lookup.page.cid, 1002);
        assert_eq!(lookup.page.duration_ms, 300_000);
        assert_eq!(
            lookup.video.cover.as_deref(),
            Some("https://i1.hdslb.com/bfs/archive/cover.jpg")
        );
        assert_eq!(lookup.video.owner.as_deref(), Some("老师"));
        let lans: Vec<_> = lookup
            .tracks
            .iter()
            .map(|t| (t.lan.as_str(), t.ai))
            .collect();
        assert_eq!(lans, vec![("ai-zh", true), ("zh-CN", false)]);

        let (track, bytes) = client.subtitle_bytes(&lookup, None).await.unwrap();
        assert_eq!(track.lan, "zh-CN");
        let cues = parse_subtitle(SUBTITLE_FILE_NAME, &bytes).unwrap();
        assert_eq!(cues.len(), 2);

        let descriptor = BiliLinkDescriptor::from_lookup(&lookup);
        assert_eq!(descriptor.file_name(), "线性代数 P2 02 矩阵.bilibili");
        assert_eq!(descriptor.duration_ms, 300_000);
        assert_eq!(descriptor.page_count, 2);

        // 参数 page 优先于链接里的 ?p=；不存在的分 P 报错
        let e = client
            .lookup("https://www.bilibili.com/video/BV1xx411c7mD?p=2", Some(9))
            .await
            .unwrap_err();
        assert_eq!(e.code(), ERR_UNAVAILABLE);

        view.assert_async().await;
        dm.assert_async().await;
        sub.assert_async().await;
    }

    #[tokio::test]
    async fn api_errors_and_missing_subtitles_have_stable_codes() {
        let mut server = Server::new_async().await;
        server
            .mock("GET", "/x/web-interface/view")
            .match_query(Matcher::UrlEncoded("aid".into(), "404".into()))
            .with_status(200)
            .with_body(r#"{"code":-404,"message":"啥都木有","data":null}"#)
            .create_async()
            .await;
        server
            .mock("GET", "/x/web-interface/view")
            .match_query(Matcher::UrlEncoded("aid".into(), "412".into()))
            .with_status(412)
            .create_async()
            .await;
        server
            .mock("GET", "/x/web-interface/view")
            .match_query(Matcher::UrlEncoded("bvid".into(), "BV1xx411c7mD".into()))
            .with_status(200)
            .with_body(view_body())
            .create_async()
            .await;
        server
            .mock("GET", "/x/v2/dm/view")
            .match_query(Matcher::Any)
            .with_status(200)
            .with_body(r#"{"code":0,"data":{"subtitle":null}}"#)
            .create_async()
            .await;

        let client = BiliClient::for_test(&server.url());
        let e = client.lookup("av404", None).await.unwrap_err();
        assert_eq!(e.code(), ERR_UNAVAILABLE);
        assert!(e.to_string().contains("-404"), "{e}");
        let e = client.lookup("av412", None).await.unwrap_err();
        assert_eq!(e.code(), ERR_REQUEST);
        assert!(e.to_string().contains("风控"), "{e}");

        let lookup = client.lookup("BV1xx411c7mD", None).await.unwrap();
        assert!(lookup.tracks.is_empty());
        let e = client.subtitle_bytes(&lookup, None).await.unwrap_err();
        assert_eq!(e.code(), ERR_NO_SUBTITLE);
        assert!(e.to_string().starts_with("第 1 P"), "{e}");
    }

    #[tokio::test]
    async fn short_links_follow_one_redirect() {
        let mut server = Server::new_async().await;
        server
            .mock("GET", "/AbC123")
            .with_status(302)
            .with_header(
                "location",
                "https://www.bilibili.com/video/BV1GJ411x7h7?p=2&share_medium=android",
            )
            .create_async()
            .await;
        server
            .mock("GET", "/dead")
            .with_status(404)
            .create_async()
            .await;
        let client = BiliClient::for_test(&server.url());
        let location = client
            .follow_short_link(&format!("{}/AbC123", server.url()))
            .await
            .unwrap();
        assert_eq!(
            video(&location),
            BiliTarget {
                id: BiliVideoId::Bv("BV1GJ411x7h7".into()),
                page: Some(2)
            }
        );
        let e = client
            .follow_short_link(&format!("{}/dead", server.url()))
            .await
            .unwrap_err();
        assert_eq!(e.code(), ERR_INVALID_LINK);
    }

    /// 真实接口冒烟（默认忽略，需联网）：
    /// `cargo test --lib -- --ignored media::bilibili::tests::live_lookup_fetches_real_subtitles`
    #[tokio::test]
    #[ignore]
    async fn live_lookup_fetches_real_subtitles() {
        let client = BiliClient::new().unwrap();
        let lookup = client
            .lookup("https://www.bilibili.com/video/BV1GJ411x7h7", None)
            .await
            .unwrap();
        assert!(!lookup.tracks.is_empty(), "{:?}", lookup.tracks);
        let (track, bytes) = client.subtitle_bytes(&lookup, None).await.unwrap();
        let cues = parse_subtitle(SUBTITLE_FILE_NAME, &bytes).unwrap();
        assert!(!cues.is_empty());
        eprintln!(
            "{} 「{}」 {} P, tracks={:?}, picked={} ({}), cues={}, cover={:?}",
            lookup.video.bvid,
            lookup.video.title,
            lookup.video.pages.len(),
            lookup
                .tracks
                .iter()
                .map(|t| t.lan.as_str())
                .collect::<Vec<_>>(),
            track.lan,
            track.lan_doc,
            cues.len(),
            lookup.video.cover
        );
    }

    #[test]
    fn link_items_are_created_reused_and_never_decoded() {
        let (_tmp, db) = setup_migrated_test_db();
        let first = descriptor("线性代数", 1, 1, "");
        let (info, created) = upsert_link_item(&db, &first).unwrap();
        assert!(created.is_some());
        assert!(info.is_link_item());
        assert_eq!(info.mime_type, BILIBILI_LINK_MIME);
        assert_eq!(info.file_name, "线性代数.bilibili");
        assert_eq!(
            read_link_descriptor(&db, &info.file_id).unwrap().bvid,
            "BV1GJ411x7h7"
        );

        // 还没有字幕：估算 / 转写都不会去解码描述 JSON
        assert_eq!(
            estimate_impl(&db, &info).unwrap_err().code(),
            "media-link-only"
        );

        let n = import_subtitle_impl(&db, &info, SUBTITLE_FILE_NAME, BCC.as_bytes()).unwrap();
        assert_eq!(n, 2);
        let view = build_view(&db, &info, false, true).unwrap();
        assert_eq!(view.status, "completed");
        assert_eq!(view.media_type, "video");
        // 时长来自 B 站（213 s），不被最后一条字幕的结束时间覆盖
        assert_eq!(view.progress.duration_ms, Some(213_000));

        // 同一视频同一分 P（标题改了）再导入：复用原条目
        let renamed = descriptor("线性代数（重制）", 1, 1, "");
        let (again, created) = upsert_link_item(&db, &renamed).unwrap();
        assert!(created.is_none());
        assert_eq!(again.file_id, info.file_id);
        // 另一个分 P：新条目
        let (other, created) = upsert_link_item(&db, &descriptor("线性代数", 2, 2, "02")).unwrap();
        assert!(created.is_some());
        assert_ne!(other.file_id, info.file_id);

        let items = crate::media::library::list_media_library_with_conn(
            &db.get_conn_safe().unwrap(),
            &|_| false,
            None,
        )
        .unwrap();
        let listed = items.iter().find(|i| i.id == info.file_id).unwrap();
        assert!(listed.is_link);
        assert_eq!(listed.kind, "video");
        assert_eq!(listed.transcript.source.as_deref(), Some("import"));
    }
}
