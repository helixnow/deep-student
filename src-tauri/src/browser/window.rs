//! Content `WebviewWindow` 创建 / 销毁 / boot 孤儿清理
//!
//! - label **固定** `browser-content`（一期单窗）
//! - profile：`{active}/browser-profiles/default/`
//! - Win/Linux：`data_directory`；macOS：`data_store_identifier`
//! - `on_navigation` → `policy::allow_navigation`
//! - `initialization_script` 占位，B1d 替换为真实桥

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tracing::{info, warn};
use url::Url;

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

/// 页面生命周期回调（由 BrowserService 注入，用于发事件 / 更新 session）
pub struct ContentWindowHooks {
    /// `PageLoadEvent::Finished` 时回调最终 URL
    pub on_page_finished: Arc<dyn Fn(String) + Send + Sync + 'static>,
    /// document.title 变更
    pub on_title_changed: Arc<dyn Fn(String) + Send + Sync + 'static>,
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
            Ok(()) => true,
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
            .on_document_title_changed(move |_window, title| {
                on_title(title);
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
