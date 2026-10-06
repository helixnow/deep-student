//! B 站扫码登录（可选）：登录后 B 站接口请求带上会话 Cookie。
//!
//! - 二维码：`passport.bilibili.com/x/passport-login/web/qrcode/generate` 给出扫码地址与
//!   `qrcode_key`，本地渲染成 PNG；前端每 2 秒调用一次 poll，直到成功 / 过期。
//! - 会话：poll 成功的响应 `Set-Cookie` 里拿 `SESSDATA` 等，整串存进安全存储
//!   （加密文件，键 [`SESSION_SECRET_KEY`] 属于 `internal.oauth.` 敏感前缀，不进设置、
//!   不进备份快照），只随 `api.bilibili.com` 的请求发出，视频 / 字幕 CDN 不带。
//! - 状态：`x/web-interface/nav` 校验会话；B 站回 -101（会话失效）时删掉本地会话。
//! - 退出：尽力调用 `login/exit/v2` 让服务端会话失效，然后删除本地会话。
//!
//! | 命令 | 说明 |
//! |---|---|
//! | `media_bilibili_auth_status()` | 当前账号（未登录 / 昵称 / 头像 / 大会员） |
//! | `media_bilibili_login_qr_start()` | 生成登录二维码（PNG data URL + key） |
//! | `media_bilibili_login_qr_poll(qrcodeKey)` | 查询扫码状态；成功时保存会话 |
//! | `media_bilibili_logout()` | 退出登录 |

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, SET_COOKIE};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::secure_store::{SecureStore, SecureStoreConfig};

/// 安全存储里的会话键（`internal.oauth.` 前缀：后端专用、严禁落入明文设置）
pub const SESSION_SECRET_KEY: &str = "internal.oauth.bilibili.session";

const PASSPORT_BASE: &str = "https://passport.bilibili.com";
const API_BASE: &str = "https://api.bilibili.com";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// B 站二维码有效期约 180 秒
const QR_TTL_SECS: u32 = 180;
/// 会话里需要保留的 Cookie（其余如 `sid` 只是跟踪用，丢弃）
const SESSION_COOKIE_NAMES: &[&str] = &["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    cookie: String,
    #[serde(default)]
    mid: Option<u64>,
    #[serde(default)]
    uname: Option<String>,
    #[serde(default)]
    face: Option<String>,
    #[serde(default)]
    vip: bool,
    /// 保存时刻（Unix 毫秒）
    saved_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BiliAccountStatus {
    pub logged_in: bool,
    pub mid: Option<u64>,
    pub uname: Option<String>,
    /// 头像（https，B 站图床；前端须用 referrerPolicy=no-referrer 加载）
    pub face: Option<String>,
    pub vip: bool,
    /// 本次是否连上 B 站校验过；离线时为 false，显示的是登录时记下的资料
    pub verified: bool,
    /// 本地有会话但 B 站已判定失效（已删除本地会话）
    pub expired: bool,
}

impl BiliAccountStatus {
    fn logged_out(expired: bool) -> Self {
        Self {
            logged_in: false,
            mid: None,
            uname: None,
            face: None,
            vip: false,
            verified: true,
            expired,
        }
    }

    fn from_session(session: &StoredSession, verified: bool) -> Self {
        Self {
            logged_in: true,
            mid: session.mid,
            uname: session.uname.clone(),
            face: session.face.clone(),
            vip: session.vip,
            verified,
            expired: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliLoginQr {
    pub qrcode_key: String,
    /// `data:image/png;base64,...`
    pub qr_png: String,
    pub expires_in_secs: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliLoginPoll {
    /// waiting | scanned | expired | success
    pub state: &'static str,
    pub status: Option<BiliAccountStatus>,
}

// ============================================================================
// 会话存取
// ============================================================================

fn secure_store(app: &AppHandle) -> SecureStore {
    let config = SecureStoreConfig::default();
    match app.path().app_data_dir() {
        Ok(dir) => SecureStore::new_with_dir(config, dir),
        Err(_) => SecureStore::new(config),
    }
}

fn load_session(app: &AppHandle) -> Option<StoredSession> {
    let raw = secure_store(app).get_secret(SESSION_SECRET_KEY).ok()??;
    serde_json::from_str::<StoredSession>(&raw)
        .ok()
        .filter(|s| cookie_has_session(&s.cookie))
}

fn save_session(app: &AppHandle, session: &StoredSession) -> Result<(), String> {
    let raw = serde_json::to_string(session).map_err(|e| e.to_string())?;
    secure_store(app)
        .save_secret(SESSION_SECRET_KEY, &raw)
        .map_err(|e| format!("保存 B 站登录状态失败：{}", e))
}

fn delete_session(app: &AppHandle) {
    if let Err(e) = secure_store(app).delete_secret(SESSION_SECRET_KEY) {
        log::warn!("[media::bilibili_auth] delete session failed: {}", e);
    }
}

/// 登录会话的 Cookie 串；未登录返回 None（调用方保持匿名请求）
pub fn load_cookie(app: &AppHandle) -> Option<String> {
    load_session(app).map(|s| s.cookie)
}

// ============================================================================
// 纯函数（可单测）
// ============================================================================

fn cookie_has_session(cookie: &str) -> bool {
    cookie_value(cookie, "SESSDATA").is_some_and(|v| !v.is_empty())
}

fn cookie_value<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
    cookie.split(';').find_map(|pair| {
        let (k, v) = pair.trim().split_once('=')?;
        (k.trim() == name).then_some(v.trim())
    })
}

/// 从 `Set-Cookie` 头里取会话 Cookie，拼成请求用的 `a=1; b=2`；没有 SESSDATA 返回 None
fn session_cookie_from_set_cookie<'a>(
    headers: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for header in headers {
        let Some(first) = header.split(';').next() else {
            continue;
        };
        let Some((name, value)) = first.trim().split_once('=') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if value.is_empty() || !SESSION_COOKIE_NAMES.contains(&name) {
            continue;
        }
        pairs.retain(|(n, _)| n != name);
        pairs.push((name.to_string(), value.to_string()));
    }
    let cookie = pairs
        .iter()
        .map(|(n, v)| format!("{}={}", n, v))
        .collect::<Vec<_>>()
        .join("; ");
    cookie_has_session(&cookie).then_some(cookie)
}

/// 兜底：poll 成功时 `data.url` 的查询串里也带着同样的会话字段
fn session_cookie_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let cookie = SESSION_COOKIE_NAMES
        .iter()
        .filter_map(|name| {
            parsed
                .query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| format!("{}={}", name, v))
        })
        .filter(|pair| !pair.ends_with('='))
        .collect::<Vec<_>>()
        .join("; ");
    cookie_has_session(&cookie).then_some(cookie)
}

fn is_valid_qrcode_key(key: &str) -> bool {
    (16..=64).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphanumeric())
}

fn poll_state(code: i64) -> Option<&'static str> {
    match code {
        0 => Some("success"),
        86101 => Some("waiting"),
        86090 => Some("scanned"),
        86038 => Some("expired"),
        _ => None,
    }
}

/// B 站头像只认 https 的 B 站图床
fn sanitize_face(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let ok_host = host == "hdslb.com" || host.ends_with(".hdslb.com");
    if !ok_host {
        return None;
    }
    let mut url = url;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    (url.scheme() == "https").then(|| url.to_string())
}

// ============================================================================
// 网络
// ============================================================================

struct AuthClient {
    http: reqwest::Client,
    passport_base: String,
    api_base: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Deserialize)]
struct QrGenerateData {
    url: String,
    qrcode_key: String,
}

#[derive(Deserialize)]
struct QrPollData {
    code: i64,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NavData {
    #[serde(default)]
    is_login: bool,
    #[serde(default)]
    mid: Option<u64>,
    #[serde(default)]
    uname: Option<String>,
    #[serde(default)]
    face: Option<String>,
    #[serde(default)]
    vip_status: i64,
}

enum NavResult {
    LoggedIn(NavData),
    /// 会话已失效（-101）
    Expired,
}

impl AuthClient {
    fn new() -> Result<Self, String> {
        Self::build(PASSPORT_BASE, API_BASE, false)
    }

    #[cfg(test)]
    fn for_test(base: &str) -> Self {
        Self::build(base, base, true).expect("test client")
    }

    fn build(passport_base: &str, api_base: &str, no_proxy: bool) -> Result<Self, String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            REFERER,
            HeaderValue::from_static("https://www.bilibili.com/"),
        );
        let mut builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .timeout(REQUEST_TIMEOUT);
        if no_proxy {
            builder = builder.no_proxy();
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|e| format!("初始化网络客户端失败：{}", e))?,
            passport_base: passport_base.trim_end_matches('/').to_string(),
            api_base: api_base.trim_end_matches('/').to_string(),
        })
    }

    async fn qr_generate(&self) -> Result<QrGenerateData, String> {
        let url = format!(
            "{}/x/passport-login/web/qrcode/generate?source=main-fe-header",
            self.passport_base
        );
        let body: Envelope<QrGenerateData> = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("连接 B 站失败：{}", e))?
            .json()
            .await
            .map_err(|e| format!("B 站返回的内容无法解析：{}", e))?;
        match (body.code, body.data) {
            (0, Some(data)) if is_valid_qrcode_key(&data.qrcode_key) => Ok(data),
            (code, _) => Err(format!("获取登录二维码失败（{}：{}）", code, body.message)),
        }
    }

    /// 返回 (状态, 成功时的会话 Cookie)
    async fn qr_poll(&self, key: &str) -> Result<(&'static str, Option<String>), String> {
        let url = format!("{}/x/passport-login/web/qrcode/poll", self.passport_base);
        let resp = self
            .http
            .get(url)
            .query(&[("qrcode_key", key)])
            .send()
            .await
            .map_err(|e| format!("连接 B 站失败：{}", e))?;
        let set_cookies: Vec<String> = resp
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        let body: Envelope<QrPollData> = resp
            .json()
            .await
            .map_err(|e| format!("B 站返回的内容无法解析：{}", e))?;
        let data = match (body.code, body.data) {
            (0, Some(data)) => data,
            (code, _) => return Err(format!("查询扫码状态失败（{}：{}）", code, body.message)),
        };
        let state = poll_state(data.code)
            .ok_or_else(|| format!("B 站返回了未知的扫码状态 {}", data.code))?;
        if state != "success" {
            return Ok((state, None));
        }
        let cookie = session_cookie_from_set_cookie(set_cookies.iter().map(String::as_str))
            .or_else(|| session_cookie_from_url(&data.url))
            .ok_or_else(|| "B 站确认了登录，但没有返回会话信息，请重试".to_string())?;
        Ok((state, Some(cookie)))
    }

    async fn nav(&self, cookie: &str) -> Result<NavResult, String> {
        let url = format!("{}/x/web-interface/nav", self.api_base);
        let body: Envelope<NavData> = self
            .http
            .get(url)
            .header(COOKIE, cookie)
            .send()
            .await
            .map_err(|e| format!("连接 B 站失败：{}", e))?
            .json()
            .await
            .map_err(|e| format!("B 站返回的内容无法解析：{}", e))?;
        match body.code {
            0 => {
                let data = body.data.unwrap_or_default();
                if data.is_login {
                    Ok(NavResult::LoggedIn(data))
                } else {
                    Ok(NavResult::Expired)
                }
            }
            -101 => Ok(NavResult::Expired),
            code => Err(format!("查询 B 站账号失败（{}：{}）", code, body.message)),
        }
    }

    async fn exit(&self, cookie: &str) {
        let Some(csrf) = cookie_value(cookie, "bili_jct") else {
            return;
        };
        let url = format!("{}/login/exit/v2", self.passport_base);
        let result = self
            .http
            .post(url)
            .header(COOKIE, cookie)
            .form(&[("biliCSRF", csrf)])
            .send()
            .await;
        if let Err(e) = result {
            log::info!("[media::bilibili_auth] server logout skipped: {}", e);
        }
    }
}

fn session_with_profile(cookie: String, nav: Option<NavData>, now_ms: i64) -> StoredSession {
    let nav = nav.unwrap_or_default();
    let mid = nav
        .mid
        .or_else(|| cookie_value(&cookie, "DedeUserID").and_then(|v| v.parse::<u64>().ok()));
    StoredSession {
        mid,
        uname: nav.uname.filter(|u| !u.trim().is_empty()),
        face: nav.face.as_deref().and_then(sanitize_face),
        vip: nav.vip_status == 1,
        cookie,
        saved_at: now_ms,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ============================================================================
// 命令
// ============================================================================

#[tauri::command]
pub async fn media_bilibili_auth_status(app: AppHandle) -> CmdResult<BiliAccountStatus> {
    let Some(session) = load_session(&app) else {
        return Ok(BiliAccountStatus::logged_out(false));
    };
    let client = AuthClient::new()?;
    match client.nav(&session.cookie).await {
        Ok(NavResult::LoggedIn(nav)) => {
            let refreshed =
                session_with_profile(session.cookie.clone(), Some(nav), session.saved_at);
            if refreshed != session {
                let _ = save_session(&app, &refreshed);
            }
            Ok(BiliAccountStatus::from_session(&refreshed, true))
        }
        Ok(NavResult::Expired) => {
            delete_session(&app);
            Ok(BiliAccountStatus::logged_out(true))
        }
        // 离线 / 接口异常：不删会话，按登录时记下的资料显示
        Err(e) => {
            log::info!("[media::bilibili_auth] status not verified: {}", e);
            Ok(BiliAccountStatus::from_session(&session, false))
        }
    }
}

#[tauri::command]
pub async fn media_bilibili_login_qr_start() -> CmdResult<BiliLoginQr> {
    let client = AuthClient::new()?;
    let data = client.qr_generate().await?;
    let png =
        crate::plugins::ilink_bot::qr::qrcode_png_base64(&data.url).map_err(|e| e.to_string())?;
    Ok(BiliLoginQr {
        qrcode_key: data.qrcode_key,
        qr_png: format!("data:image/png;base64,{}", png),
        expires_in_secs: QR_TTL_SECS,
    })
}

#[tauri::command]
pub async fn media_bilibili_login_qr_poll(
    app: AppHandle,
    qrcode_key: String,
) -> CmdResult<BiliLoginPoll> {
    if !is_valid_qrcode_key(&qrcode_key) {
        return Err("登录二维码无效，请刷新后重新扫码".into());
    }
    let client = AuthClient::new()?;
    let (state, cookie) = client.qr_poll(&qrcode_key).await?;
    let Some(cookie) = cookie else {
        return Ok(BiliLoginPoll {
            state,
            status: None,
        });
    };
    let nav = match client.nav(&cookie).await {
        Ok(NavResult::LoggedIn(nav)) => Some(nav),
        _ => None,
    };
    let session = session_with_profile(cookie, nav, now_ms());
    save_session(&app, &session)?;
    log::info!("[media::bilibili_auth] logged in (mid {:?})", session.mid);
    Ok(BiliLoginPoll {
        state,
        status: Some(BiliAccountStatus::from_session(&session, true)),
    })
}

#[tauri::command]
pub async fn media_bilibili_logout(app: AppHandle) -> CmdResult<()> {
    if let Some(session) = load_session(&app) {
        if let Ok(client) = AuthClient::new() {
            client.exit(&session.cookie).await;
        }
    }
    delete_session(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_session_cookies_from_set_cookie() {
        let headers = [
            "SESSDATA=abc%2C123; Path=/; Domain=bilibili.com; Expires=Sat, 04 Apr 2027 00:00:00 GMT; HttpOnly; Secure",
            "bili_jct=csrf123; Path=/; Domain=bilibili.com",
            "DedeUserID=42; Path=/",
            "DedeUserID__ckMd5=deadbeef; Path=/",
            "sid=tracking; Path=/",
        ];
        let cookie = session_cookie_from_set_cookie(headers).unwrap();
        assert_eq!(
            cookie,
            "SESSDATA=abc%2C123; bili_jct=csrf123; DedeUserID=42; DedeUserID__ckMd5=deadbeef"
        );
        assert_eq!(cookie_value(&cookie, "bili_jct"), Some("csrf123"));
        assert!(
            session_cookie_from_set_cookie(["bili_jct=x; Path=/", "SESSDATA=; Path=/"]).is_none()
        );
    }

    #[test]
    fn falls_back_to_session_fields_in_the_success_url() {
        let url = "https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=42&DedeUserID__ckMd5=dd&Expires=1&SESSDATA=s%2C1&bili_jct=j&gourl=x";
        let cookie = session_cookie_from_url(url).unwrap();
        assert!(cookie.starts_with("SESSDATA=s,1; bili_jct=j; DedeUserID=42"));
        assert!(session_cookie_from_url("https://example.com/?a=1").is_none());
    }

    #[test]
    fn validates_qrcode_key_and_maps_poll_codes() {
        assert!(is_valid_qrcode_key("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_qrcode_key("../../etc"));
        assert!(!is_valid_qrcode_key("short"));
        assert_eq!(poll_state(86101), Some("waiting"));
        assert_eq!(poll_state(86090), Some("scanned"));
        assert_eq!(poll_state(86038), Some("expired"));
        assert_eq!(poll_state(0), Some("success"));
        assert_eq!(poll_state(1), None);
    }

    #[test]
    fn face_only_from_bilibili_image_host_over_https() {
        assert_eq!(
            sanitize_face("http://i0.hdslb.com/bfs/face/a.jpg").as_deref(),
            Some("https://i0.hdslb.com/bfs/face/a.jpg")
        );
        assert!(sanitize_face("https://evil.example.com/a.jpg").is_none());
        assert!(sanitize_face("javascript:alert(1)").is_none());
    }

    #[test]
    fn session_profile_falls_back_to_cookie_mid() {
        let session = session_with_profile("SESSDATA=s; DedeUserID=99".into(), None, 1);
        assert_eq!(session.mid, Some(99));
        assert!(session.uname.is_none());
        assert!(!session.vip);
    }

    #[tokio::test]
    async fn poll_success_extracts_cookie_and_nav_marks_expired_on_101() {
        let mut server = mockito::Server::new_async().await;
        let key = "0123456789abcdef0123456789abcdef";
        let _poll = server
            .mock("GET", "/x/passport-login/web/qrcode/poll")
            .match_query(mockito::Matcher::UrlEncoded("qrcode_key".into(), key.into()))
            .with_header("content-type", "application/json")
            .with_header("set-cookie", "SESSDATA=sess; Path=/; HttpOnly")
            .with_header("set-cookie", "bili_jct=jct; Path=/")
            .with_body(r#"{"code":0,"message":"0","data":{"url":"","refresh_token":"r","timestamp":1,"code":0,"message":""}}"#)
            .create_async()
            .await;
        let _nav = server
            .mock("GET", "/x/web-interface/nav")
            .with_header("content-type", "application/json")
            .with_body(r#"{"code":-101,"message":"账号未登录","data":{"isLogin":false}}"#)
            .create_async()
            .await;
        let client = AuthClient::for_test(&server.url());
        let (state, cookie) = client.qr_poll(key).await.unwrap();
        assert_eq!(state, "success");
        assert_eq!(cookie.as_deref(), Some("SESSDATA=sess; bili_jct=jct"));
        assert!(matches!(
            client.nav("SESSDATA=sess").await.unwrap(),
            NavResult::Expired
        ));
    }

    #[tokio::test]
    async fn poll_waiting_returns_no_cookie() {
        let mut server = mockito::Server::new_async().await;
        let _poll = server
            .mock("GET", "/x/passport-login/web/qrcode/poll")
            .match_query(mockito::Matcher::Any)
            .with_header("content-type", "application/json")
            .with_body(r#"{"code":0,"message":"0","data":{"url":"","code":86090,"message":"二维码已扫码未确认"}}"#)
            .create_async()
            .await;
        let client = AuthClient::for_test(&server.url());
        let (state, cookie) = client
            .qr_poll("0123456789abcdef0123456789abcdef")
            .await
            .unwrap();
        assert_eq!(state, "scanned");
        assert!(cookie.is_none());
    }
}
