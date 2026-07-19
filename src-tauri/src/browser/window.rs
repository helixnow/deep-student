//! Browser content Webview 创建 / 销毁 / boot 孤儿清理
//!
//! - label **固定** `browser-content`（一期单窗）
//! - macOS / Windows：作为 `main` 的 child Webview
//! - Linux：保留独立 `WebviewWindow` fallback
//! - profile：`{active}/browser-profiles/default/`
//! - Win/Linux：`data_directory`；macOS：`data_store_identifier`
//! - `on_navigation` → `policy::allow_navigation`
//! - `initialization_script` 占位，B1d 替换为真实桥

use std::fs;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::DownloadEvent;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::webview::PageLoadEvent;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::webview::WebviewBuilder;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::WebviewUrl;
#[cfg(target_os = "linux")]
use tauri::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, Rect, Webview};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::{PhysicalPosition, PhysicalSize};
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tracing::info;
use tracing::warn;
use url::{Host, Url};

use super::policy;

#[cfg(target_os = "macos")]
mod macos_surface_clip;

/// A physical rectangle that the embedded browser must yield to a DOM surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalSurfaceOcclusion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 一期固定 content 窗 label（不进 windowStore）
pub const BROWSER_CONTENT_LABEL: &str = "browser-content";
pub const MAIN_WINDOW_LABEL: &str = "main";
pub const SURFACE_HOST_EMBEDDED: &str = "embedded";
pub const SURFACE_HOST_DETACHED: &str = "detached";
pub const SURFACE_HOST_UNSUPPORTED: &str = "unsupported";
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
const MOBILE_UNSUPPORTED: &str = "browser content host unsupported on mobile";

/// Profile 相对 active slot 的目录名
pub const PROFILE_ROOT: &str = "browser-profiles";
pub const DEFAULT_PROFILE_ID: &str = "default";

/// B1d 注入桥占位；真实脚本由 bridge 模块替换
pub const BRIDGE_INIT_SCRIPT_PLACEHOLDER: &str = "/* ds-browser-bridge */";

/// macOS WKWebView 隔离用固定 16-byte store id（`deep-student.browser.default`）
pub const DEFAULT_DATA_STORE_ID: [u8; 16] = [
    0x64, 0x73, 0x2d, 0x62, 0x72, 0x6f, 0x77, 0x73, // ds-brows
    0x65, 0x72, 0x2d, 0x64, 0x65, 0x66, 0x61, 0x75, // er-defau
];

/// WKWebView omits Safari product tokens from its default UA. Some desktop
/// sites (notably Baidu) treat that UA as an obsolete embedded client and
/// redirect HTTPS back to HTTP, which can loop with WebKit's HSTS upgrade.
#[cfg(target_os = "macos")]
const MACOS_DESKTOP_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

pub const DEFAULT_WIDTH: f64 = 960.0;
pub const DEFAULT_HEIGHT: f64 = 720.0;
const AGENT_DNS_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const NATIVE_WEBVIEW_READY_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeWebviewReadyError {
    TimedOut,
    Disconnected,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn wait_for_native_webview_ready(
    receiver: mpsc::Receiver<()>,
    timeout: Duration,
) -> Result<(), NativeWebviewReadyError> {
    match receiver.recv_timeout(timeout) {
        Ok(()) => Ok(()),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(NativeWebviewReadyError::TimedOut),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(NativeWebviewReadyError::Disconnected),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn confirm_native_webview_created(webview: &Webview) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |_| {
            let _ = sender.send(());
        })
        .map_err(|error| {
            format!("failed to schedule native browser-content creation acknowledgement: {error}")
        })?;

    match wait_for_native_webview_ready(receiver, NATIVE_WEBVIEW_READY_TIMEOUT) {
        Ok(()) => Ok(()),
        Err(NativeWebviewReadyError::TimedOut) => Err(format!(
            "native browser-content webview creation acknowledgement timed out after {} ms",
            NATIVE_WEBVIEW_READY_TIMEOUT.as_millis()
        )),
        Err(NativeWebviewReadyError::Disconnected) => {
            Err("native browser-content webview disappeared before creation acknowledgement".into())
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn cleanup_failed_embedded_webview(webview: &Webview) {
    if let Err(error) = webview.close() {
        warn!("[browser] failed to clean up unacknowledged content host: {error}");
    }
}

#[derive(Debug)]
struct DnsResolutionRequest {
    host: String,
    port: u16,
    response: SyncSender<Result<Vec<IpAddr>, String>>,
}

#[derive(Debug)]
struct BoundedDnsResolver {
    sender: SyncSender<DnsResolutionRequest>,
    busy: Arc<AtomicBool>,
}

impl BoundedDnsResolver {
    fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<DnsResolutionRequest>(1);
        let busy = Arc::new(AtomicBool::new(false));
        let worker_busy = busy.clone();
        std::thread::Builder::new()
            .name("browser-agent-dns".into())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let result = (request.host.as_str(), request.port)
                        .to_socket_addrs()
                        .map(|addresses| addresses.map(|address| address.ip()).collect())
                        .map_err(|error| format!("DNS resolution failed: {error}"));
                    worker_busy.store(false, Ordering::Release);
                    let _ = request.response.send(result);
                }
            })
            .expect("failed to spawn browser DNS resolver");
        Self { sender, busy }
    }

    fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "DNS resolver is busy".to_string())?;

        let (response, receiver) = mpsc::sync_channel(1);
        if let Err(error) = self.sender.try_send(DnsResolutionRequest {
            host: host.to_owned(),
            port,
            response,
        }) {
            self.busy.store(false, Ordering::Release);
            return Err(format!("DNS resolver unavailable: {error}"));
        }

        receiver
            .recv_timeout(AGENT_DNS_TIMEOUT)
            .map_err(|_| "DNS resolution timed out".to_string())?
    }
}

#[derive(Debug)]
struct NavigationPolicyState {
    agent_private_network_guard: AtomicBool,
    agent_allow_insecure_http: AtomicBool,
    resolver: BoundedDnsResolver,
}

/// Shared navigation policy state for the lifetime of the native content window.
///
/// The browser service toggles the guard with the control mode. Keeping it in an
/// `Arc` means redirects and page-initiated navigations observe the latest mode,
/// including when an existing user-created window is later claimed by an agent.
#[derive(Debug, Clone)]
pub struct NavigationPolicyHandle {
    state: Arc<NavigationPolicyState>,
}

impl Default for NavigationPolicyHandle {
    fn default() -> Self {
        Self {
            state: Arc::new(NavigationPolicyState {
                agent_private_network_guard: AtomicBool::new(false),
                agent_allow_insecure_http: AtomicBool::new(false),
                resolver: BoundedDnsResolver::new(),
            }),
        }
    }
}

impl NavigationPolicyHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_agent_private_network_guard(&self, enabled: bool) {
        self.state
            .agent_private_network_guard
            .store(enabled, Ordering::Release);
    }

    pub fn agent_private_network_guard_enabled(&self) -> bool {
        self.state
            .agent_private_network_guard
            .load(Ordering::Acquire)
    }

    pub fn set_agent_allow_insecure_http(&self, enabled: bool) {
        self.state
            .agent_allow_insecure_http
            .store(enabled, Ordering::Release);
    }

    pub fn agent_allow_insecure_http_enabled(&self) -> bool {
        self.state.agent_allow_insecure_http.load(Ordering::Acquire)
    }

    pub(crate) fn validate_agent_target(&self, url: &Url) -> Result<(), String> {
        if !self.agent_private_network_guard_enabled() {
            return Ok(());
        }

        self.validate_agent_target_for_agent(url)
    }

    /// Unconditional preflight used before the service transitions into Agent
    /// control. Redirect callbacks use `validate_agent_target`, which first reads
    /// the shared guard.
    pub(crate) fn validate_agent_target_for_agent(&self, url: &Url) -> Result<(), String> {
        if policy::is_blocked_for_agent(url.as_str()) {
            return Err("private/internal address literal is blocked for agent navigation".into());
        }

        let host = match url.host() {
            Some(Host::Ipv4(ip)) => {
                return ensure_resolved_addresses_are_public([IpAddr::V4(ip)]);
            }
            Some(Host::Ipv6(ip)) => {
                return ensure_resolved_addresses_are_public([IpAddr::V6(ip)]);
            }
            Some(Host::Domain(host)) => host,
            None => return Err("missing host for agent navigation".into()),
        };
        let port = url
            .port_or_known_default()
            .ok_or_else(|| "missing port for agent navigation".to_string())?;

        let resolved = self.state.resolver.resolve(host, port)?;
        ensure_resolved_addresses_are_public(resolved)
    }
}

fn ensure_resolved_addresses_are_public(
    addresses: impl IntoIterator<Item = IpAddr>,
) -> Result<(), String> {
    let mut found = false;
    for address in addresses {
        found = true;
        if policy::is_internal_ip(&address) {
            return Err(format!(
                "DNS resolved to private/internal address {address}"
            ));
        }
    }
    if found {
        Ok(())
    } else {
        Err("DNS resolution returned no addresses".into())
    }
}

/// 页面生命周期回调（由 BrowserService 注入，用于发事件 / 更新 session）
pub struct ContentWindowHooks {
    /// `PageLoadEvent::Finished` 时回调最终 URL
    pub on_page_finished: Arc<dyn Fn(String) + Send + Sync + 'static>,
    /// document.title 变更，同时携带 WebView 当前 URL 以识别 SPA/页面发起导航。
    pub on_title_changed: Arc<dyn Fn(String, Option<String>) + Send + Sync + 'static>,
    /// 顶层导航被策略拒绝，同时携带目标 URL 与拒绝原因。
    pub on_navigation_blocked: Arc<dyn Fn(String, String) + Send + Sync + 'static>,
    /// Native download lifecycle. Agent-owned sessions redirect requested
    /// downloads into their session artifact root; user-only sessions keep the
    /// platform default destination.
    pub on_download_requested: Arc<dyn Fn(String, &mut PathBuf) -> bool + Send + Sync + 'static>,
    pub on_download_finished: Arc<dyn Fn(String, Option<PathBuf>, bool) + Send + Sync + 'static>,
}

#[derive(Debug, Clone)]
pub struct ContentWindowOptions {
    pub url: Url,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub focused: bool,
    pub profile_dir: PathBuf,
    /// Agent 控制态下对每次顶层导航（含 redirect）执行 DNS 私网检查。
    pub navigation_policy: NavigationPolicyHandle,
    /// 初始化脚本；默认占位，B1d 可注入完整桥
    pub initialization_script: String,
}

impl Default for ContentWindowOptions {
    fn default() -> Self {
        Self {
            url: Url::parse("https://example.com").expect("static url"),
            title: "Browser".into(),
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            focused: true,
            profile_dir: PathBuf::new(),
            navigation_policy: NavigationPolicyHandle::new(),
            initialization_script: bridge_init_script(),
        }
    }
}

/// `{active_dir}/browser-profiles/default`
pub fn default_profile_dir(active_dir: &Path) -> PathBuf {
    active_dir.join(PROFILE_ROOT).join(DEFAULT_PROFILE_ID)
}

pub fn ensure_profile_dir(profile_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(profile_dir)
}

pub fn surface_host_mode() -> &'static str {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        SURFACE_HOST_EMBEDDED
    } else if cfg!(target_os = "linux") {
        SURFACE_HOST_DETACHED
    } else {
        SURFACE_HOST_UNSUPPORTED
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn navigation_allowed(
    url: &Url,
    navigation_policy: &NavigationPolicyHandle,
    on_navigation_blocked: Option<&Arc<dyn Fn(String, String) + Send + Sync + 'static>>,
) -> bool {
    let raw = url.as_str();
    let agent_guard = navigation_policy.agent_private_network_guard_enabled();
    let effective_allow_insecure_http =
        !agent_guard || navigation_policy.agent_allow_insecure_http_enabled();
    let denial_reason =
        match policy::allow_navigation_with_options(raw, effective_allow_insecure_http) {
            Ok(()) => match navigation_policy.validate_agent_target(url) {
                Ok(()) => return true,
                Err(reason) => reason,
            },
            Err(reason) => reason.to_string(),
        };

    warn!(
        "[browser] on_navigation blocked {} ({})",
        raw, denial_reason
    );
    if let Some(callback) = on_navigation_blocked {
        callback(raw.to_string(), denial_reason);
    }
    false
}

/// 若已存在同 label Webview 则返回现有句柄，否则按平台创建。
pub fn get_or_create_content_window(
    app: &AppHandle,
    options: ContentWindowOptions,
    hooks: Option<ContentWindowHooks>,
) -> Result<Webview, String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        get_or_create_content_window_desktop(app, options, hooks)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, options, hooks);
        Err(MOBILE_UNSUPPORTED.into())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn get_or_create_content_window_desktop(
    app: &AppHandle,
    options: ContentWindowOptions,
    hooks: Option<ContentWindowHooks>,
) -> Result<Webview, String> {
    if let Some(existing) = app.get_webview(BROWSER_CONTENT_LABEL) {
        return Ok(existing);
    }

    ensure_profile_dir(&options.profile_dir).map_err(|e| {
        format!(
            "failed to create browser profile dir {}: {}",
            options.profile_dir.display(),
            e
        )
    })?;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let webview = {
        let navigation_policy = options.navigation_policy.clone();
        let on_navigation_blocked = hooks
            .as_ref()
            .map(|hooks| hooks.on_navigation_blocked.clone());
        let mut builder = WebviewBuilder::new(
            BROWSER_CONTENT_LABEL,
            WebviewUrl::External(options.url.clone()),
        )
        .focused(false)
        .initialization_script(options.initialization_script.clone())
        .on_navigation(move |url| {
            navigation_allowed(url, &navigation_policy, on_navigation_blocked.as_ref())
        });

        if let Some(hooks) = hooks {
            let on_finished = hooks.on_page_finished.clone();
            let on_title = hooks.on_title_changed.clone();
            let on_download_requested = hooks.on_download_requested.clone();
            let on_download_finished = hooks.on_download_finished.clone();
            builder = builder
                .on_page_load(move |_webview, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        on_finished(payload.url().as_str().to_string());
                    }
                })
                .on_document_title_changed(move |webview, title| {
                    let url = webview.url().ok().map(|value| value.as_str().to_string());
                    on_title(title, url);
                })
                .on_download(move |_webview, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        on_download_requested(url.as_str().to_string(), destination)
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        on_download_finished(url.as_str().to_string(), path, success);
                        true
                    }
                    _ => true,
                });
        }

        #[cfg(target_os = "windows")]
        {
            builder = builder.data_directory(options.profile_dir.clone());
        }
        #[cfg(target_os = "macos")]
        {
            builder = builder
                .data_store_identifier(DEFAULT_DATA_STORE_ID)
                .user_agent(MACOS_DESKTOP_SAFARI_USER_AGENT);
        }

        let main_window = app
            .get_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| format!("parent window {MAIN_WINDOW_LABEL} not found"))?;
        let webview = main_window
            .add_child(
                builder,
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1, 1),
            )
            .map_err(|e| format!("failed to create embedded browser-content webview: {e}"))?;
        if let Err(error) = webview.hide() {
            cleanup_failed_embedded_webview(&webview);
            return Err(format!(
                "failed to initialize embedded browser-content webview visibility: {error}"
            ));
        }
        if let Err(error) = confirm_native_webview_created(&webview) {
            cleanup_failed_embedded_webview(&webview);
            return Err(format!(
                "failed to create embedded browser-content webview: {error}"
            ));
        }
        #[cfg(target_os = "macos")]
        if let Err(error) = macos_surface_clip::install(&webview) {
            cleanup_failed_embedded_webview(&webview);
            return Err(format!(
                "failed to install browser-content native occlusion host: {error}"
            ));
        }
        webview
    };

    #[cfg(target_os = "linux")]
    let webview = {
        let navigation_policy = options.navigation_policy.clone();
        let on_navigation_blocked = hooks
            .as_ref()
            .map(|hooks| hooks.on_navigation_blocked.clone());
        let mut builder = WebviewWindowBuilder::new(
            app,
            BROWSER_CONTENT_LABEL,
            WebviewUrl::External(options.url.clone()),
        )
        .title(options.title.clone())
        .inner_size(options.width, options.height)
        .resizable(true)
        .focused(options.focused)
        .visible(true)
        .initialization_script(options.initialization_script.clone())
        .on_navigation(move |url| {
            navigation_allowed(url, &navigation_policy, on_navigation_blocked.as_ref())
        });

        if let Some(hooks) = hooks {
            let on_finished = hooks.on_page_finished.clone();
            let on_title = hooks.on_title_changed.clone();
            let on_download_requested = hooks.on_download_requested.clone();
            let on_download_finished = hooks.on_download_finished.clone();
            builder = builder
                .on_page_load(move |_window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        on_finished(payload.url().as_str().to_string());
                    }
                })
                .on_document_title_changed(move |window, title| {
                    let url = window.url().ok().map(|value| value.as_str().to_string());
                    on_title(title, url);
                })
                .on_download(move |_webview, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        on_download_requested(url.as_str().to_string(), destination)
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        on_download_finished(url.as_str().to_string(), path, success);
                        true
                    }
                    _ => true,
                });
        }
        builder = builder.data_directory(options.profile_dir.clone());
        let window = builder
            .build()
            .map_err(|e| format!("failed to create detached browser-content window: {e}"))?;
        window.as_ref().clone()
    };

    info!(
        "[browser] created {} content host label={} url={} profile={}",
        surface_host_mode(),
        BROWSER_CONTENT_LABEL,
        options.url,
        options.profile_dir.display()
    );

    Ok(webview)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn destroy_content_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(window) = app.get_webview_window(BROWSER_CONTENT_LABEL) {
        window
            .close()
            .map_err(|e| format!("failed to close browser-content: {e}"))?;
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(webview) = app.get_webview(BROWSER_CONTENT_LABEL) {
        #[cfg(target_os = "macos")]
        if let Err(error) = macos_surface_clip::remove(&webview) {
            warn!("[browser] failed to remove native occlusion host: {error}");
        }
        webview
            .close()
            .map_err(|e| format!("failed to close browser-content: {e}"))?;
    }
    info!("[browser] destroyed content host {}", BROWSER_CONTENT_LABEL);
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn destroy_content_window(_app: &AppHandle) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.into())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn focus_content_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let result = app
        .get_webview_window(BROWSER_CONTENT_LABEL)
        .ok_or_else(|| "browser-content window not found".to_string())?
        .set_focus();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let result = app
        .get_webview(BROWSER_CONTENT_LABEL)
        .ok_or_else(|| "browser-content webview not found".to_string())?
        .set_focus();
    result.map_err(|e| format!("failed to focus browser-content: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn focus_content_window(_app: &AppHandle) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.into())
}

/// Return native keyboard focus from the embedded browser child to the main
/// React WebView. Detached hosts and non-macOS embedded hosts do not need a
/// first-responder handoff, so this is intentionally a successful no-op there.
pub fn release_content_focus(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let main_webview = app
            .get_webview(MAIN_WINDOW_LABEL)
            .ok_or_else(|| format!("main React webview {MAIN_WINDOW_LABEL} not found"))?;
        main_webview
            .set_focus()
            .map_err(|error| format!("failed to focus main React webview: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

pub fn content_window(app: &AppHandle) -> Option<Webview> {
    app.get_webview(BROWSER_CONTENT_LABEL)
}

/// Embedded host only: apply physical position and size atomically.
/// Detached Linux keeps its native window bounds and treats this as a no-op.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn set_content_bounds(app: &AppHandle, bounds: Rect) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let webview =
            content_window(app).ok_or_else(|| "browser-content webview not found".to_string())?;
        webview
            .set_bounds(bounds)
            .map_err(|e| format!("failed to set browser-content bounds: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (app, bounds);
    }
    Ok(())
}

/// Preserve the browser frame while yielding selected regions to DOM surfaces.
/// Visual holes control what React paints above the browser; input holes may be
/// wider when a menu needs its normal outside-click dismissal behavior.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn set_content_occlusions(
    app: &AppHandle,
    occlusions: &[Rect],
    input_occlusions: &[Rect],
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let webview =
            content_window(app).ok_or_else(|| "browser-content webview not found".to_string())?;
        let to_physical_occlusions =
            |rectangles: &[Rect]| -> Result<Vec<PhysicalSurfaceOcclusion>, String> {
                let mut converted = Vec::with_capacity(rectangles.len());
                for rect in rectangles {
                    let (position, size) = match (rect.position, rect.size) {
                        (tauri::Position::Physical(position), tauri::Size::Physical(size)) => {
                            (position, size)
                        }
                        _ => {
                            return Err(
                                "browser-content occlusion must use physical coordinates".into()
                            );
                        }
                    };
                    converted.push(PhysicalSurfaceOcclusion {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    });
                }
                Ok(converted)
            };
        let physical_occlusions = to_physical_occlusions(occlusions)?;
        let physical_input_occlusions = to_physical_occlusions(input_occlusions)?;
        macos_surface_clip::set_occlusions(
            &webview,
            physical_occlusions,
            physical_input_occlusions,
        )?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, occlusions, input_occlusions);
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn set_content_bounds(_app: &AppHandle, _bounds: Rect) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.into())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn set_content_visibility(app: &AppHandle, visible: bool, focus: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let window = app
            .get_webview_window(BROWSER_CONTENT_LABEL)
            .ok_or_else(|| "browser-content window not found".to_string())?;
        if visible {
            window
                .show()
                .map_err(|e| format!("failed to show browser-content: {e}"))?;
            if focus {
                window
                    .set_focus()
                    .map_err(|e| format!("failed to focus browser-content: {e}"))?;
            }
        } else {
            window
                .hide()
                .map_err(|e| format!("failed to hide browser-content: {e}"))?;
        }
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let webview =
            content_window(app).ok_or_else(|| "browser-content webview not found".to_string())?;
        if visible {
            webview
                .show()
                .map_err(|e| format!("failed to show browser-content: {e}"))?;
            if focus {
                webview
                    .set_focus()
                    .map_err(|e| format!("failed to focus browser-content: {e}"))?;
            }
        } else {
            webview
                .hide()
                .map_err(|e| format!("failed to hide browser-content: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn set_content_visibility(
    _app: &AppHandle,
    _visible: bool,
    _focus: bool,
) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.into())
}

/// 启动时扫掉孤儿 `browser-content`（无内存 session 时仍可能残留）。
pub fn boot_cleanup_orphan_windows(app: &AppHandle) {
    if app.get_webview(BROWSER_CONTENT_LABEL).is_some() {
        warn!(
            "[browser] boot_cleanup: closing orphan content host '{}'",
            BROWSER_CONTENT_LABEL
        );
        if let Err(e) = destroy_content_window(app) {
            warn!("[browser] boot_cleanup close failed: {}", e);
        }
    }
}

/// Content 窗 `initialization_script`：真实桥（B1d），失败时仍可回退占位注释。
pub fn bridge_init_script() -> String {
    let script = crate::browser::bridge::INIT_SCRIPT;
    if script.trim().is_empty() {
        BRIDGE_INIT_SCRIPT_PLACEHOLDER.to_string()
    } else {
        script.to_string()
    }
}

pub fn bridge_init_script_for_session(session_id: &str, nonce: &str) -> Result<String, String> {
    crate::browser::bridge::init_script_for_session(session_id, nonce)
        .map_err(|error| format!("failed to bind browser input capability: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn native_webview_ready_wait_accepts_acknowledgement() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(()).unwrap();

        assert_eq!(
            wait_for_native_webview_ready(receiver, Duration::ZERO),
            Ok(())
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn native_webview_ready_wait_distinguishes_disconnect_and_timeout() {
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        assert_eq!(
            wait_for_native_webview_ready(receiver, Duration::ZERO),
            Err(NativeWebviewReadyError::Disconnected)
        );

        let (_sender, receiver) = mpsc::sync_channel(1);
        assert_eq!(
            wait_for_native_webview_ready(receiver, Duration::ZERO),
            Err(NativeWebviewReadyError::TimedOut)
        );
    }

    #[test]
    fn navigation_policy_handle_is_shared_across_clones() {
        let policy = NavigationPolicyHandle::new();
        let clone = policy.clone();

        assert!(!clone.agent_private_network_guard_enabled());
        assert!(!clone.agent_allow_insecure_http_enabled());
        policy.set_agent_private_network_guard(true);
        policy.set_agent_allow_insecure_http(true);
        assert!(clone.agent_private_network_guard_enabled());
        assert!(clone.agent_allow_insecure_http_enabled());
        clone.set_agent_private_network_guard(false);
        clone.set_agent_allow_insecure_http(false);
        assert!(!policy.agent_private_network_guard_enabled());
        assert!(!policy.agent_allow_insecure_http_enabled());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_browser_user_agent_advertises_desktop_safari() {
        assert!(MACOS_DESKTOP_SAFARI_USER_AGENT.contains("AppleWebKit/605.1.15"));
        assert!(MACOS_DESKTOP_SAFARI_USER_AGENT.contains("Version/26.0"));
        assert!(MACOS_DESKTOP_SAFARI_USER_AGENT.contains("Safari/605.1.15"));
    }

    #[test]
    fn resolved_agent_targets_reject_any_internal_address() {
        assert!(
            ensure_resolved_addresses_are_public([IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))]).is_ok()
        );
        assert!(ensure_resolved_addresses_are_public([
            IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
        ])
        .is_err());
        assert!(ensure_resolved_addresses_are_public([IpAddr::V6(Ipv6Addr::LOCALHOST)]).is_err());
        assert!(ensure_resolved_addresses_are_public(std::iter::empty()).is_err());
    }

    #[test]
    fn agent_guard_blocks_literals_but_user_mode_keeps_local_navigation() {
        let policy = NavigationPolicyHandle::new();
        let local = Url::parse("https://127.0.0.1/").unwrap();

        assert!(policy.validate_agent_target(&local).is_ok());
        assert!(policy.validate_agent_target_for_agent(&local).is_err());
        policy.set_agent_private_network_guard(true);
        assert!(policy.validate_agent_target(&local).is_err());
        assert!(policy
            .validate_agent_target(&Url::parse("https://1.1.1.1/").unwrap())
            .is_ok());
    }

    #[test]
    fn public_http_policy_tracks_live_control_mode() {
        let policy = NavigationPolicyHandle::new();
        let public_http = Url::parse("http://1.1.1.1/").unwrap();

        // User control permits ordinary HTTP even when networkMode is not full.
        assert!(navigation_allowed(&public_http, &policy, None));

        // Agent control still requires full network mode for public HTTP.
        policy.set_agent_private_network_guard(true);
        assert!(!navigation_allowed(&public_http, &policy, None));
        policy.set_agent_allow_insecure_http(true);
        assert!(navigation_allowed(&public_http, &policy, None));

        // Tightening the live setting affects the existing policy handle.
        policy.set_agent_allow_insecure_http(false);
        assert!(!navigation_allowed(&public_http, &policy, None));

        // Full network mode never weakens the Agent private-network guard.
        policy.set_agent_allow_insecure_http(true);
        let private_http = Url::parse("http://127.0.0.1/").unwrap();
        assert!(!navigation_allowed(&private_http, &policy, None));
    }

    #[test]
    fn blocked_navigation_reports_url_and_reason() {
        let policy = NavigationPolicyHandle::new();
        policy.set_agent_private_network_guard(true);
        let reports = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = reports.clone();
        let callback: Arc<dyn Fn(String, String) + Send + Sync> = Arc::new(move |url, reason| {
            captured.lock().unwrap().push((url, reason));
        });

        let blocked = Url::parse("http://1.1.1.1/path").unwrap();
        assert!(!navigation_allowed(&blocked, &policy, Some(&callback)));
        assert_eq!(
            reports.lock().unwrap().as_slice(),
            &[(
                "http://1.1.1.1/path".to_string(),
                "http navigation is limited to loopback hosts".to_string(),
            )]
        );
    }
}
