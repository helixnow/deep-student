//! iLink Bot HTTP client (WeChat ClawBot protocol).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::models::AppError;

pub const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
pub const CHANNEL_VERSION: &str = "1.0.0";
pub const DEFAULT_LONG_POLL_TIMEOUT_MS: u64 = 35_000;
pub const SESSION_EXPIRED: i64 = -14;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IlinkCredentials {
    pub token: String,
    pub base_url: String,
    pub account_id: String,
    pub user_id: String,
    #[serde(default)]
    pub get_updates_buf: String,
    /// peer_id -> context_token
    #[serde(default)]
    pub context_tokens: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QrcodeResponse {
    pub qrcode: String,
    pub qrcode_img_content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QrcodeStatusResponse {
    pub status: String,
    pub bot_token: Option<String>,
    pub ilink_bot_id: Option<String>,
    pub ilink_user_id: Option<String>,
    pub baseurl: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetUpdatesResponse {
    pub ret: Option<i64>,
    pub errcode: Option<i64>,
    pub errmsg: Option<String>,
    #[serde(default)]
    pub msgs: Vec<WeixinMessage>,
    pub get_updates_buf: Option<String>,
    pub longpolling_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WeixinMessage {
    pub seq: Option<u64>,
    pub message_id: Option<u64>,
    pub from_user_id: Option<String>,
    pub to_user_id: Option<String>,
    pub client_id: Option<String>,
    pub create_time_ms: Option<u64>,
    pub session_id: Option<String>,
    pub message_type: Option<i32>,
    pub message_state: Option<i32>,
    pub context_token: Option<String>,
    #[serde(default)]
    pub item_list: Vec<MessageItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MessageItem {
    #[serde(rename = "type")]
    pub item_type: Option<i32>,
    pub text_item: Option<TextItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TextItem {
    pub text: Option<String>,
}

pub fn random_wechat_uin() -> String {
    let uint32: u32 = rand::thread_rng().gen();
    B64.encode(uint32.to_string().as_bytes())
}

pub fn is_api_error(ret: Option<i64>, errcode: Option<i64>) -> bool {
    matches!(ret, Some(r) if r != 0) || matches!(errcode, Some(c) if c != 0)
}

pub fn is_session_expired(ret: Option<i64>, errcode: Option<i64>) -> bool {
    ret == Some(SESSION_EXPIRED) || errcode == Some(SESSION_EXPIRED)
}

pub fn extract_text(msg: &WeixinMessage) -> String {
    msg.item_list
        .iter()
        .filter_map(|item| item.text_item.as_ref().and_then(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Split long outbound text into chunks (<= limit runes approx by chars).
pub fn chunk_text(text: &str, limit: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    if limit == 0 || text.chars().count() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        if count >= limit {
            chunks.push(std::mem::take(&mut current));
            count = 0;
        }
        current.push(ch);
        count += 1;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[derive(Clone)]
pub struct IlinkClient {
    http: Client,
}

impl IlinkClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { http }
    }

    fn base(creds: &IlinkCredentials) -> String {
        let b = if creds.base_url.trim().is_empty() {
            DEFAULT_BASE_URL
        } else {
            creds.base_url.trim_end_matches('/')
        };
        b.to_string()
    }

    pub async fn get_bot_qrcode(&self) -> Result<QrcodeResponse, AppError> {
        let url = format!("{}/ilink/bot/get_bot_qrcode?bot_type=3", DEFAULT_BASE_URL);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::network(format!("get_bot_qrcode 失败: {}", e)))?;
        if !resp.status().is_success() {
            return Err(AppError::network(format!(
                "get_bot_qrcode HTTP {}",
                resp.status()
            )));
        }
        resp.json()
            .await
            .map_err(|e| AppError::validation(format!("解析二维码响应失败: {}", e)))
    }

    pub async fn get_qrcode_status(&self, qrcode: &str) -> Result<QrcodeStatusResponse, AppError> {
        let url = format!(
            "{}/ilink/bot/get_qrcode_status?qrcode={}",
            DEFAULT_BASE_URL,
            urlencoding::encode(qrcode)
        );
        let resp = self
            .http
            .get(&url)
            .header("iLink-App-ClientVersion", "1")
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .map_err(|e| AppError::network(format!("get_qrcode_status 失败: {}", e)))?;
        if !resp.status().is_success() {
            return Err(AppError::network(format!(
                "get_qrcode_status HTTP {}",
                resp.status()
            )));
        }
        resp.json()
            .await
            .map_err(|e| AppError::validation(format!("解析扫码状态失败: {}", e)))
    }

    fn auth_headers(token: &str) -> Result<reqwest::header::HeaderMap, AppError> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            reqwest::header::HeaderName::from_bytes(b"AuthorizationType")
                .map_err(|e| AppError::validation(format!("AuthorizationType 头无效: {}", e)))?,
            reqwest::header::HeaderValue::from_static("ilink_bot_token"),
        );
        let auth = format!("Bearer {}", token);
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&auth)
                .map_err(|e| AppError::validation(format!("Authorization 无效: {}", e)))?,
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("x-wechat-uin"),
            reqwest::header::HeaderValue::from_str(&random_wechat_uin())
                .map_err(|e| AppError::validation(format!("X-WECHAT-UIN 无效: {}", e)))?,
        );
        Ok(headers)
    }

    pub async fn get_updates(
        &self,
        creds: &IlinkCredentials,
        timeout_ms: u64,
    ) -> Result<GetUpdatesResponse, AppError> {
        let url = format!("{}/ilink/bot/getupdates", Self::base(creds));
        let body = json!({
            "get_updates_buf": creds.get_updates_buf,
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        let headers = Self::auth_headers(&creds.token)?;
        let timeout = Duration::from_millis(timeout_ms.saturating_add(5_000).max(40_000));
        match self
            .http
            .post(&url)
            .headers(headers)
            .timeout(timeout)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(AppError::network(format!(
                        "getupdates HTTP {}: {}",
                        status, text
                    )));
                }
                resp.json()
                    .await
                    .map_err(|e| AppError::validation(format!("解析 getupdates 失败: {}", e)))
            }
            Err(e) if e.is_timeout() || e.is_request() => {
                // Client-side long-poll timeout ⇒ empty success
                Ok(GetUpdatesResponse {
                    ret: Some(0),
                    errcode: None,
                    errmsg: None,
                    msgs: vec![],
                    get_updates_buf: Some(creds.get_updates_buf.clone()),
                    longpolling_timeout_ms: Some(timeout_ms),
                })
            }
            Err(e) => Err(AppError::network(format!("getupdates 失败: {}", e))),
        }
    }

    pub async fn send_text(
        &self,
        creds: &IlinkCredentials,
        to_user_id: &str,
        context_token: &str,
        text: &str,
    ) -> Result<Value, AppError> {
        let url = format!("{}/ilink/bot/sendmessage", Self::base(creds));
        let client_id = format!(
            "dstu-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let body = json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": client_id,
                "message_type": 2,
                "message_state": 2,
                "context_token": context_token,
                "item_list": [{
                    "type": 1,
                    "text_item": { "text": text }
                }]
            },
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        let headers = Self::auth_headers(&creds.token)?;
        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("sendmessage 失败: {}", e)))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::network(format!(
                "sendmessage HTTP {}: {}",
                status, text
            )));
        }
        let value: Value = resp
            .json()
            .await
            .map_err(|e| AppError::validation(format!("解析 sendmessage 失败: {}", e)))?;
        let ret = value.get("ret").and_then(|v| v.as_i64());
        let errcode = value.get("errcode").and_then(|v| v.as_i64());
        if is_session_expired(ret, errcode) {
            return Err(AppError::configuration("session expired (-14)"));
        }
        if is_api_error(ret, errcode) {
            return Err(AppError::network(format!(
                "sendmessage 业务错误: {}",
                value
            )));
        }
        Ok(value)
    }
}

impl Default for IlinkClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wechat_uin_is_base64_of_decimal() {
        let uin = random_wechat_uin();
        let decoded = B64.decode(&uin).expect("valid base64");
        let s = String::from_utf8(decoded).expect("utf8");
        s.parse::<u32>().expect("decimal u32");
    }

    #[test]
    fn chunk_text_splits() {
        let chunks = chunk_text("abcdefghij", 3);
        assert_eq!(chunks, vec!["abc", "def", "ghi", "j"]);
    }

    #[test]
    fn session_expired_detection() {
        assert!(is_session_expired(Some(-14), None));
        assert!(is_session_expired(None, Some(-14)));
        assert!(!is_session_expired(Some(0), None));
    }
}
