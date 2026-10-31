use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub const API_LIMIT: usize = 2 * 1024 * 1024;
pub const FRAME_LIMIT: usize = 64 * 1024;
pub const MEDIA_LIMIT: usize = 512 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    #[default]
    Native,
    BrowserBridge,
    Proxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RouteMode {
    #[default]
    Auto,
    Native,
    BrowserBridge,
    Proxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    ShortLink,
    Api,
    Subtitle,
    Media,
    Passport,
    Cover,
}

#[derive(Clone)]
pub struct BiliRequest {
    pub id: u64,
    pub attempt_id: String,
    pub kind: RequestKind,
    pub method: String,
    pub url: url::Url,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub max_bytes: usize,
    pub deadline: Instant,
    pub cancel: CancellationToken,
}

impl BiliRequest {
    pub fn get(kind: RequestKind, url: url::Url, max_bytes: usize) -> Self {
        Self {
            id: 0,
            attempt_id: String::new(),
            kind,
            method: "GET".into(),
            url,
            headers: BTreeMap::new(),
            body: Vec::new(),
            max_bytes,
            deadline: Instant::now() + REQUEST_TIMEOUT,
            cancel: CancellationToken::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct BiliResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub final_url: url::Url,
    // Passport consumes these only inside Rust. Never serialized to IPC or bridge messages.
    pub set_cookies: Vec<String>,
}

impl BiliResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct BiliError {
    pub code: String,
    pub message: String,
    pub stage: String,
    pub request_id: u64,
    pub attempt_id: String,
    pub route: Route,
    pub retryable: bool,
    pub http_status: Option<u16>,
    pub business_code: Option<i64>,
}

impl BiliError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: format!("bilibili-{code}"),
            message: message.into(),
            stage: "transport".into(),
            request_id: 0,
            attempt_id: String::new(),
            route: Route::Native,
            retryable: matches!(code, "timeout" | "network" | "bridge-offline"),
            http_status: None,
            business_code: None,
        }
    }

    pub fn context(mut self, request: &BiliRequest, route: Route) -> Self {
        self.request_id = request.id;
        self.attempt_id.clone_from(&request.attempt_id);
        self.stage = format!("{:?}", request.kind).to_ascii_lowercase();
        self.route = route;
        self
    }
}

pub type BiliResult<T> = Result<T, BiliError>;

#[async_trait::async_trait]
pub trait BiliTransport: Send + Sync {
    async fn execute(&self, request: BiliRequest) -> BiliResult<BiliResponse>;
}
