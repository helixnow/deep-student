use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use super::bridge::{BrowserTransport, HUB};
use super::native::NativeTransport;
use super::*;

static GENERATION: AtomicU64 = AtomicU64::new(1);
static AUTH_EPOCH: AtomicU64 = AtomicU64::new(1);
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static SETTINGS: LazyLock<Mutex<Option<TransportSettings>>> = LazyLock::new(|| Mutex::new(None));
static TASKS: LazyLock<Mutex<std::collections::HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
const SETTINGS_KEY: &str = "media.bilibili.transport.v1";
static DIAGNOSTICS: LazyLock<Mutex<std::collections::VecDeque<RequestDiagnostic>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::new()));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDiagnostic {
    pub request_id: u64,
    pub attempt_id: String,
    pub route: Route,
    pub stage: RequestKind,
    pub host: String,
    pub elapsed_ms: u64,
    pub status: Option<u16>,
    pub error_code: Option<String>,
    pub bytes: usize,
}
pub fn diagnostics() -> Vec<RequestDiagnostic> {
    DIAGNOSTICS.lock().unwrap().iter().cloned().collect()
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSettings {
    pub mode: RouteMode,
    pub proxy_url: Option<String>,
    pub proxy_in_auto: bool,
}

pub fn next_request_id() -> u64 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}
pub fn invalidate_auth() {
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
}

pub fn settings(app: &AppHandle) -> TransportSettings {
    let mut cache = SETTINGS.lock().unwrap();
    cache
        .get_or_insert_with(|| {
            app.try_state::<crate::commands::AppState>()
                .and_then(|s| s.database.get_setting(SETTINGS_KEY).ok().flatten())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .clone()
}

pub fn update_settings(app: &AppHandle, value: TransportSettings) -> BiliResult<()> {
    if let Some(proxy) = value.proxy_url.as_deref().filter(|s| !s.is_empty()) {
        NativeTransport::new(None, Some(proxy))?;
    }
    if value.mode == RouteMode::Proxy && value.proxy_url.as_deref().is_none_or(str::is_empty) {
        return Err(BiliError::new("proxy-config", "请先配置可信代理地址"));
    }
    let state = app.state::<crate::commands::AppState>();
    state
        .database
        .save_setting(SETTINGS_KEY, &serde_json::to_string(&value).unwrap())
        .map_err(|_| BiliError::new("settings", "保存 B 站出口设置失败"))?;
    *SETTINGS.lock().unwrap() = Some(value);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn select_route(
    mode: RouteMode,
    bridge_ready: bool,
    parsing_only: bool,
    native_first: bool,
) -> BiliResult<Route> {
    match mode {
        RouteMode::Auto if native_first => Ok(Route::Native),
        RouteMode::Auto if bridge_ready => Ok(Route::BrowserBridge),
        RouteMode::Auto | RouteMode::Native => Ok(Route::Native),
        RouteMode::BrowserBridge if bridge_ready => Ok(Route::BrowserBridge),
        RouteMode::BrowserBridge => Err(BiliError::new(
            "bridge-offline",
            if parsing_only {
                "当前浏览器桥仅支持解析，不支持安全媒体读取"
            } else {
                "浏览器桥未就绪，请连接浏览器"
            },
        )),
        RouteMode::Proxy => Ok(Route::Proxy),
    }
}

#[derive(Clone)]
pub struct BiliAttempt {
    pub id: String,
    pub route: Route,
    pub generation: u64,
    pub auth_epoch: u64,
    pub bridge_generation: u64,
    pub connection: Option<String>,
    pub expected_mid: Option<u64>,
    pub expected_logged_in: bool,
    deadline: Option<Instant>,
    cancel: CancellationToken,
    app: Option<AppHandle>,
    transport: Arc<dyn BiliTransport>,
}

impl BiliAttempt {
    pub fn begin(app: &AppHandle, media: bool) -> BiliResult<Self> {
        Self::begin_with_settings(app, media, settings(app))
    }

    fn begin_with_settings(
        app: &AppHandle,
        media: bool,
        config: TransportSettings,
    ) -> BiliResult<Self> {
        let bridge = HUB.status();
        let bridge_ready = bridge.parsing && (!media || bridge.media) && bridge.state == "ready";
        let native_cookie = super::super::bilibili_auth::load_cookie(app);
        // App QR login must affect auto playback even while a separate browser is paired.
        let native_first = native_cookie.is_some();
        let route = select_route(
            config.mode,
            bridge_ready,
            media && bridge.parsing,
            native_first,
        )?;
        let connection = if route == Route::BrowserBridge {
            bridge.connection_id.clone()
        } else {
            None
        };
        let native_mid = native_cookie.as_deref().and_then(|cookie| {
            cookie
                .split(';')
                .find_map(|part| part.trim().strip_prefix("DedeUserID=")?.parse::<u64>().ok())
        });
        let bridge_account = bridge.account.clone();
        if config.mode == RouteMode::Auto
            && !native_first
            && media
            && bridge.parsing
            && !bridge.media
            && bridge_account
                .as_ref()
                .is_some_and(|a| a.logged_in && (a.mid != native_mid || native_cookie.is_none()))
        {
            return Err(BiliError::new(
                "route-account-mismatch",
                "浏览器桥不支持媒体读取，应用账号不同；请明确选择播放出口",
            ));
        }
        let transport: Arc<dyn BiliTransport> = match route {
            Route::BrowserBridge => Arc::new(BrowserTransport {
                connection: connection.clone().unwrap(),
                generation: bridge.generation,
            }),
            Route::Native => Arc::new(NativeTransport::new(native_cookie.clone(), None)?),
            Route::Proxy => Arc::new(NativeTransport::new(None, config.proxy_url.as_deref())?),
        };
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            route,
            generation: GENERATION.load(Ordering::SeqCst),
            auth_epoch: AUTH_EPOCH.load(Ordering::SeqCst),
            bridge_generation: bridge.generation,
            connection,
            expected_mid: if route == Route::BrowserBridge {
                bridge_account.as_ref().and_then(|a| a.mid)
            } else if route == Route::Native {
                native_mid
            } else {
                None
            },
            expected_logged_in: if route == Route::BrowserBridge {
                bridge_account.is_some_and(|a| a.logged_in)
            } else {
                route == Route::Native && native_cookie.is_some()
            },
            deadline: None,
            cancel: CancellationToken::new(),
            app: Some(app.clone()),
            transport,
        })
    }

    pub fn native(cookie: Option<String>) -> BiliResult<Self> {
        Ok(Self::from_transport(Arc::new(NativeTransport::new(
            cookie, None,
        )?)))
    }

    fn from_transport(transport: Arc<dyn BiliTransport>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            route: Route::Native,
            generation: GENERATION.load(Ordering::SeqCst),
            auth_epoch: AUTH_EPOCH.load(Ordering::SeqCst),
            bridge_generation: 0,
            connection: None,
            expected_mid: None,
            expected_logged_in: false,
            deadline: None,
            cancel: CancellationToken::new(),
            app: None,
            transport,
        }
    }

    #[cfg(test)]
    pub fn for_test(cookie: Option<String>) -> Self {
        Self::from_transport(Arc::new(NativeTransport::for_test(cookie)))
    }

    pub fn cache_scope(&self) -> String {
        format!(
            "{:?}:{}:{}:{}",
            self.route,
            self.generation,
            self.auth_epoch,
            if self.route == Route::BrowserBridge {
                self.bridge_generation
            } else {
                0
            }
        )
    }

    pub fn valid(&self) -> bool {
        self.generation == GENERATION.load(Ordering::SeqCst)
            && self.auth_epoch == AUTH_EPOCH.load(Ordering::SeqCst)
            && (self.route != Route::BrowserBridge
                || self.bridge_generation == HUB.status().generation)
    }

    pub fn ensure_active(&self) -> BiliResult<()> {
        if self.cancel.is_cancelled() {
            return Err(BiliError::new("cancelled", "任务已取消"));
        }
        if self.deadline.is_some_and(|d| d <= Instant::now()) {
            return Err(BiliError::new("timeout", "任务已超时"));
        }
        if !self.valid() {
            return Err(BiliError::new("identity-changed", "B 站账号或出口已变化"));
        }
        Ok(())
    }

    pub async fn wait_create<'a>(
        &self,
        lock: &'a tokio::sync::Mutex<()>,
    ) -> BiliResult<tokio::sync::MutexGuard<'a, ()>> {
        let deadline = self
            .deadline
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        tokio::select! {
            _ = self.cancel.cancelled() => Err(BiliError::new("cancelled", "任务已取消")),
            result = tokio::time::timeout_at(deadline.into(), lock.lock()) => result.map_err(|_| BiliError::new("timeout", "导入排队超时")),
        }
    }

    pub fn task(mut self, task_id: Option<&str>) -> (Self, TaskGuard) {
        self.deadline = Some(Instant::now() + Duration::from_secs(60));
        let id = task_id.unwrap_or(&self.id).to_owned();
        if let Some(old) = TASKS
            .lock()
            .unwrap()
            .insert(id.clone(), self.cancel.clone())
        {
            old.cancel();
        }
        (self, TaskGuard(id))
    }

    pub fn fallback(&self, app: &AppHandle) -> BiliResult<Self> {
        let config = settings(app);
        if config.mode != RouteMode::Auto {
            return Err(BiliError::new("fixed-route", "固定出口不会自动换路"));
        }
        let mut next = Self::begin(app, false)?;
        if next.route == self.route {
            let bridge = HUB.status();
            let mode = if self.route == Route::BrowserBridge {
                RouteMode::Native
            } else if self.route == Route::Native && bridge.state == "ready" && bridge.parsing {
                RouteMode::BrowserBridge
            } else if config.proxy_in_auto && config.proxy_url.is_some() {
                RouteMode::Proxy
            } else {
                return Err(BiliError::new(
                    "no-compatible-route",
                    "没有满足当前任务条件的其他出口",
                ));
            };
            next = Self::begin_with_settings(app, false, TransportSettings { mode, ..config })?;
        }
        if next.expected_logged_in != self.expected_logged_in
            || next.expected_mid != self.expected_mid
            || self.expected_logged_in && self.expected_mid.is_none()
        {
            return Err(BiliError::new(
                "route-account-mismatch",
                "其他出口的账号不同，请确认账号后手动重试",
            ));
        }
        next.deadline = self.deadline;
        next.cancel = self.cancel.clone();
        Ok(next)
    }

    pub async fn execute(&self, mut request: BiliRequest) -> BiliResult<BiliResponse> {
        if !self.valid() {
            return Err(BiliError::new(
                "identity-changed",
                "B 站账号或出口已变化，请重新开始任务",
            ));
        }
        request.id = next_request_id();
        request.attempt_id.clone_from(&self.id);
        if let Some(deadline) = self.deadline {
            request.deadline = request.deadline.min(deadline);
        }
        request.cancel = self.cancel.child_token();
        if let Some(app) = &self.app {
            super::super::bilibili_lifecycle::touch(app, self.route == Route::BrowserBridge).await;
        }
        let started = std::time::Instant::now();
        let host = request.url.host_str().unwrap_or_default().to_owned();
        let stage = request.kind;
        let id = request.id;
        let result = self.execute_redirects(request).await;
        let mut diagnostics = DIAGNOSTICS.lock().unwrap();
        if diagnostics.len() >= 32 {
            diagnostics.pop_front();
        }
        diagnostics.push_back(RequestDiagnostic {
            request_id: id,
            attempt_id: self.id.clone(),
            route: self.route,
            stage,
            host: host.clone(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            status: result.as_ref().ok().map(|r| r.status),
            error_code: result.as_ref().err().map(|e| e.code.clone()),
            bytes: result.as_ref().ok().map(|r| r.body.len()).unwrap_or(0),
        });
        drop(diagnostics);
        if let Err(error) = &result {
            log::warn!(
                "[bilibili_transport] request={} route={:?} stage={:?} host={} elapsed_ms={} code={}",
                id,
                self.route,
                stage,
                host,
                started.elapsed().as_millis(),
                error.code
            );
        }
        log::debug!(
            "[bilibili_transport] request={} route={:?} host={} elapsed_ms={} status={:?}",
            id,
            self.route,
            host,
            started.elapsed().as_millis(),
            result.as_ref().map(|v| v.status).ok()
        );
        if !self.valid() {
            return Err(BiliError::new(
                "identity-changed",
                "B 站账号或出口已变化，请重新开始任务",
            ));
        }
        result
    }

    async fn execute_redirects(&self, mut request: BiliRequest) -> BiliResult<BiliResponse> {
        let mut visited = std::collections::HashSet::new();
        for _ in 0..=5 {
            if !visited.insert(request.url.clone()) {
                return Err(BiliError::new("redirect-loop", "B 站请求发生循环跳转")
                    .context(&request, self.route));
            }
            let response = self.transport.execute(request.clone()).await?;
            if !(300..400).contains(&response.status)
                || request.kind == RequestKind::ShortLink
                || request.method == "POST"
            {
                return Ok(response);
            }
            let location = response.header("location").ok_or_else(|| {
                BiliError::new("invalid-redirect", "B 站跳转缺少地址").context(&request, self.route)
            })?;
            request.url = request.url.join(location).map_err(|_| {
                BiliError::new("invalid-redirect", "B 站跳转地址无效").context(&request, self.route)
            })?;
            // Each transport checks the next target before network IO; deadlines and credentials do not reset.
        }
        Err(BiliError::new("redirect-limit", "B 站请求跳转次数过多").context(&request, self.route))
    }

    pub async fn verify_identity(&self) -> BiliResult<()> {
        let Some(connection) = &self.connection else {
            return Ok(());
        };
        let response = self
            .execute(BiliRequest::get(
                RequestKind::Api,
                url::Url::parse("https://api.bilibili.com/x/web-interface/nav").unwrap(),
                API_LIMIT,
            ))
            .await?;
        let account = super::bridge_server::decode_account(&response)?;
        HUB.verify_account(connection, &account)
    }
}

pub struct TaskGuard(String);
impl Drop for TaskGuard {
    fn drop(&mut self) {
        TASKS.lock().unwrap().remove(&self.0);
    }
}

#[tauri::command]
pub async fn media_bilibili_cancel(task_id: String) {
    if let Some(token) = TASKS.lock().unwrap().remove(&task_id) {
        token.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_the_app_account_without_requiring_a_browser_on_every_platform() {
        for ready in [false, true] {
            for parsing_only in [false, true] {
                assert_eq!(
                    select_route(RouteMode::Auto, ready, parsing_only, true).unwrap(),
                    Route::Native
                );
            }
        }
    }

    #[test]
    fn native_guest_keeps_the_capable_bridge_preference() {
        assert_eq!(
            select_route(RouteMode::Auto, true, false, false).unwrap(),
            Route::BrowserBridge
        );
        assert_eq!(
            select_route(RouteMode::Auto, false, false, false).unwrap(),
            Route::Native
        );
    }

    #[test]
    fn native_preference_never_overrides_an_explicit_route() {
        for native_first in [false, true] {
            assert_eq!(
                select_route(RouteMode::BrowserBridge, true, false, native_first).unwrap(),
                Route::BrowserBridge
            );
            assert!(select_route(RouteMode::BrowserBridge, false, false, native_first).is_err());
            assert_eq!(
                select_route(RouteMode::Native, true, false, native_first).unwrap(),
                Route::Native
            );
            assert_eq!(
                select_route(RouteMode::Proxy, true, false, native_first).unwrap(),
                Route::Proxy
            );
        }
    }
}
