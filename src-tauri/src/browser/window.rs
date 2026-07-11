//! Content `WebviewWindow` 创建 / 销毁 / boot 孤儿清理
//!
//! - label **固定** `browser-content`（一期单窗）
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

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tracing::{info, warn};
use url::{Host, Url};

use super::policy;

/// 一期固定 content 窗 label（不进 windowStore）
pub const BROWSER_CONTENT_LABEL: &str = "browser-content";

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

pub const DEFAULT_WIDTH: f64 = 960.0;
pub const DEFAULT_HEIGHT: f64 = 720.0;
const AGENT_DNS_TIMEOUT: Duration = Duration::from_secs(2);

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
}

#[derive(Debug, Clone)]
pub struct ContentWindowOptions {
    pub url: Url,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub focused: bool,
    pub profile_dir: PathBuf,
    /// 透传给 `allow_navigation`（默认 false = http 仅 loopback）
    pub allow_insecure_http: bool,
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
            allow_insecure_http: false,
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

/// 若已存在同 label 窗则返回现有句柄，否则按 options 新建。
pub fn get_or_create_content_window(
    app: &AppHandle,
    options: ContentWindowOptions,
    hooks: Option<ContentWindowHooks>,
) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(BROWSER_CONTENT_LABEL) {
        return Ok(existing);
    }

    ensure_profile_dir(&options.profile_dir).map_err(|e| {
        format!(
            "failed to create browser profile dir {}: {}",
            options.profile_dir.display(),
            e
        )
    })?;

    let allow_insecure_http = options.allow_insecure_http;
    let navigation_policy = options.navigation_policy.clone();
    let init_script = options.initialization_script.clone();

    let mut builder = WebviewWindowBuilder::new(
        app,
        BROWSER_CONTENT_LABEL,
        WebviewUrl::External(options.url.clone()),
    )
    .title(options.title)
    .inner_size(options.width, options.height)
    .resizable(true)
    .focused(options.focused)
    .visible(true)
    .initialization_script(init_script)
    .on_navigation(move |url| {
        let raw = url.as_str();
        match policy::allow_navigation_with_options(raw, allow_insecure_http) {
            Ok(()) => match navigation_policy.validate_agent_target(url) {
                Ok(()) => true,
                Err(reason) => {
                    warn!(
                        "[browser] on_navigation blocked agent target {} ({})",
                        raw, reason
                    );
                    false
                }
            },
            Err(reason) => {
                warn!("[browser] on_navigation blocked {} ({})", raw, reason);
                false
            }
        }
    });

    if let Some(hooks) = hooks {
        let on_finished = hooks.on_page_finished.clone();
        let on_title = hooks.on_title_changed.clone();
        builder = builder
            .on_page_load(move |_window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    on_finished(payload.url().as_str().to_string());
                }
            })
            .on_document_title_changed(move |window, title| {
                let url = window.url().ok().map(|value| value.as_str().to_string());
                on_title(title, url);
            });
    }

    // Profile 隔离：Win/Linux 用 data_directory；macOS 用 data_store_identifier
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.data_directory(options.profile_dir.clone());
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(DEFAULT_DATA_STORE_ID);
        let _ = &options.profile_dir;
    }

    let window = builder
        .build()
        .map_err(|e| format!("failed to create browser-content window: {e}"))?;

    info!(
        "[browser] created content window label={} url={} profile={}",
        BROWSER_CONTENT_LABEL,
        options.url,
        options.profile_dir.display()
    );

    Ok(window)
}

pub fn destroy_content_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(BROWSER_CONTENT_LABEL) {
        win.close()
            .map_err(|e| format!("failed to close browser-content: {e}"))?;
        info!(
            "[browser] destroyed content window {}",
            BROWSER_CONTENT_LABEL
        );
    }
    Ok(())
}

pub fn focus_content_window(app: &AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(BROWSER_CONTENT_LABEL)
        .ok_or_else(|| "browser-content window not found".to_string())?;
    win.set_focus()
        .map_err(|e| format!("failed to focus browser-content: {e}"))?;
    Ok(())
}

pub fn content_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BROWSER_CONTENT_LABEL)
}

/// 启动时扫掉孤儿 `browser-content`（无内存 session 时仍可能残留）
pub fn boot_cleanup_orphan_windows(app: &AppHandle) {
    let windows = app.webview_windows();
    for (label, win) in windows {
        if label == BROWSER_CONTENT_LABEL {
            warn!("[browser] boot_cleanup: closing orphan window '{}'", label);
            if let Err(e) = win.close() {
                warn!("[browser] boot_cleanup close failed: {}", e);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn navigation_policy_handle_is_shared_across_clones() {
        let policy = NavigationPolicyHandle::new();
        let clone = policy.clone();

        assert!(!clone.agent_private_network_guard_enabled());
        policy.set_agent_private_network_guard(true);
        assert!(clone.agent_private_network_guard_enabled());
        clone.set_agent_private_network_guard(false);
        assert!(!policy.agent_private_network_guard_enabled());
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
}
