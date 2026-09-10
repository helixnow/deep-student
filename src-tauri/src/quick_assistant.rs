//! 快速学习小窗（quick-assistant）的原生窗口生命周期管理。
//!
//! 全部创建 / 显示 / 隐藏路径都收敛到本模块：
//! - 首次呼出时按需创建窗口，避免启动阶段同步创建第二个 WebView；
//! - 呼出时定位到鼠标所在显示器，并恢复上次的位置与尺寸；
//! - 隐藏时把焦点归还给用户之前正在使用的应用。
//!
//! 该功能仅存在于桌面端；移动端保留同名命令但均为 no-op，
//! 以便 invoke_handler 在所有平台统一注册。

use tauri::AppHandle;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
mod desktop {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

    pub const WINDOW_LABEL: &str = "quick-assistant";
    const SHOWN_EVENT: &str = "quick-assistant://shown";
    const ENABLED_KEY: &str = "quick_assistant.enabled";
    // v2：默认/最小尺寸整体缩小后换 key，让所有用户回到新的紧凑默认尺寸，
    // 而不是永远恢复旧版持久化下来的大窗口。
    // v3：尺寸改存逻辑像素。v2 存的是 inner_size() 物理值，在 2x 屏上还原
    // 时按物理值 set_size 会把窗口缩到一半（480×384 实机变 240×192），
    // 且低于 min_inner_size；换 key 同时丢弃已损坏的 v2 值。
    const BOUNDS_KEY: &str = "quick_assistant.window_bounds.v3";

    const DEFAULT_WIDTH: f64 = 480.0;
    const DEFAULT_HEIGHT: f64 = 384.0;
    const MIN_WIDTH: f64 = 400.0;
    const MIN_HEIGHT: f64 = 320.0;
    const MAX_WIDTH: f64 = 800.0;
    const MAX_HEIGHT: f64 = 720.0;

    /// 呼出小窗前主窗口是否处于聚焦状态；隐藏小窗时据此决定是否把焦点还给系统。
    static MAIN_WAS_FOCUSED: AtomicBool = AtomicBool::new(false);

    fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
        let state = app.try_state::<crate::commands::AppState>()?;
        state.database.get_setting(key).ok().flatten()
    }

    fn save_setting(app: &AppHandle, key: &str, value: &str) {
        if let Some(state) = app.try_state::<crate::commands::AppState>() {
            let _ = state.database.save_setting(key, value);
        }
    }

    pub fn is_enabled(app: &AppHandle) -> bool {
        get_setting(app, ENABLED_KEY).as_deref() != Some("false")
    }

    /// 确保小窗存在（不显示）。仅在用户首次呼出时创建。
    pub fn ensure_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            return Ok(window);
        }
        let window = tauri::WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("index.html?window=quick-assistant".into()),
        )
        .title("Deep Student - Quick Learning")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .max_inner_size(MAX_WIDTH, MAX_HEIGHT)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()?;
        // 跟随当前桌面空间弹出（Windows 不支持该 API，忽略失败）。
        let _ = window.set_visible_on_all_workspaces(true);
        // macOS：挂原生 NSVisualEffectView（HudWindow 材质）。WebView 的
        // backdrop-filter 只能采样页面内部，采不到窗口背后的桌面；只有原生
        // 材质能提供真正的桌面透视，小窗才与主窗（Sidebar 材质）同一质感。
        // 材质选 HudWindow 而非 Popover：后者只支持 withinWindow 混合，
        // 在 behindWindow 下不采样桌面（实机验证）。radius 与 CSS 的
        // --qa-radius 保持一致。
        #[cfg(target_os = "macos")]
        {
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            let native_window = window.clone();
            let _ = window.run_on_main_thread(move || {
                // state=Active：小窗常驻置顶，失焦（图钉模式）时材质不退化。
                if let Err(error) = apply_vibrancy(
                    &native_window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    Some(16.0),
                ) {
                    log::warn!("[QuickAssistant] 原生毛玻璃应用失败: {error}");
                }
            });
        }
        Ok(window)
    }

    pub(super) fn parse_bounds(raw: &str) -> Option<(i32, i32, u32, u32)> {
        let mut parts = raw.split(',').map(str::trim);
        let x = parts.next()?.parse().ok()?;
        let y = parts.next()?.parse().ok()?;
        let w = parts.next()?.parse().ok()?;
        let h = parts.next()?.parse().ok()?;
        if w == 0 || h == 0 {
            return None;
        }
        Some((x, y, w, h))
    }

    fn persist_bounds(app: &AppHandle, window: &WebviewWindow) {
        // 尺寸存逻辑像素（v3）：物理值在换屏/换缩放后按新 DPI 还原会把窗口缩小
        // 一半。位置保持物理坐标，跨屏还原仍然准确。
        if let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            let logical = size.to_logical::<f64>(scale);
            save_setting(
                app,
                BOUNDS_KEY,
                &format!(
                    "{},{},{},{}",
                    position.x,
                    position.y,
                    logical.width.clamp(MIN_WIDTH, MAX_WIDTH).round() as u32,
                    logical.height.clamp(MIN_HEIGHT, MAX_HEIGHT).round() as u32
                ),
            );
        }
    }

    /// 把窗口放到鼠标所在显示器：上次的 bounds 若仍落在该屏内则原样恢复，
    /// 否则在该屏水平居中、垂直偏上（视线更容易落到输入框）。
    fn position_on_cursor_monitor(app: &AppHandle, window: &WebviewWindow) {
        let cursor = app.cursor_position().ok();
        let monitor = cursor
            .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();

        let saved = get_setting(app, BOUNDS_KEY).and_then(|raw| parse_bounds(&raw));
        if let Some((x, y, w, h)) = saved {
            let center_x = x + (w as i32) / 2;
            let center_y = y + (h as i32) / 2;
            let inside = center_x >= monitor_pos.x
                && center_x < monitor_pos.x + monitor_size.width as i32
                && center_y >= monitor_pos.y
                && center_y < monitor_pos.y + monitor_size.height as i32;
            if inside {
                let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
                let _ = window.set_position(PhysicalPosition::new(x, y));
                return;
            }
            // 换了显示器：保留尺寸，仅重新定位。
            let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
        }

        if let Ok(size) = window.inner_size() {
            let x = monitor_pos.x + ((monitor_size.width as i32) - (size.width as i32)) / 2;
            let y = monitor_pos.y
                + (((monitor_size.height as f64) - (size.height as f64)) * 0.24).max(24.0) as i32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }

    pub fn show(app: &AppHandle) {
        let window = match ensure_window(app) {
            Ok(window) => window,
            Err(error) => {
                log::error!("[QuickAssistant] failed to create window: {error}");
                return;
            }
        };
        let main_focused = app
            .get_webview_window("main")
            .and_then(|main| main.is_focused().ok())
            .unwrap_or(false);
        MAIN_WAS_FOCUSED.store(main_focused, Ordering::Relaxed);

        #[cfg(windows)]
        let _ = window.unminimize();
        position_on_cursor_monitor(app, &window);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(SHOWN_EVENT, ());
    }

    pub fn hide(app: &AppHandle) {
        let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        persist_bounds(app, &window);

        #[cfg(windows)]
        {
            // 直接 hide 不会把焦点交还给上一个前台窗口；先最小化让系统完成
            // 焦点切换，再隐藏以免留在任务栏。
            let _ = window.minimize();
            let _ = window.hide();
        }

        #[cfg(not(windows))]
        {
            let _ = window.hide();
            #[cfg(target_os = "macos")]
            {
                // 呼出前主窗口既不聚焦也不可见时，说明用户在其他应用里工作；
                // 隐藏整个 App 让系统把焦点还给该应用。
                let main_visible = app
                    .get_webview_window("main")
                    .and_then(|main| main.is_visible().ok())
                    .unwrap_or(false);
                if !MAIN_WAS_FOCUSED.load(Ordering::Relaxed) && !main_visible {
                    let _ = app.hide();
                }
            }
        }
    }

    pub fn toggle(app: &AppHandle) {
        if !is_enabled(app) {
            return;
        }
        let visible = app
            .get_webview_window(WINDOW_LABEL)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        if visible {
            hide(app);
        } else {
            show(app);
        }
    }

    pub fn apply_enabled(app: &AppHandle, enabled: bool) {
        if !enabled {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                persist_bounds(app, &window);
                let _ = window.destroy();
            }
        }
    }
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
pub use desktop::toggle;

#[tauri::command]
pub fn quick_assistant_show(app: AppHandle) {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    desktop::show(&app);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let _ = app;
}

#[tauri::command]
pub fn quick_assistant_hide(app: AppHandle) {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    desktop::hide(&app);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let _ = app;
}

/// 设置开关联动：开启时保持懒创建，关闭时销毁窗口释放资源。
#[tauri::command]
pub fn quick_assistant_apply_enabled(app: AppHandle, enabled: bool) {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    desktop::apply_enabled(&app, enabled);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let _ = (app, enabled);
}

#[cfg(all(test, any(target_os = "macos", windows, target_os = "linux")))]
mod tests {
    use super::desktop::parse_bounds;

    #[test]
    fn parses_valid_bounds() {
        assert_eq!(parse_bounds("10,-20,520,420"), Some((10, -20, 520, 420)));
    }

    #[test]
    fn rejects_malformed_bounds() {
        assert_eq!(parse_bounds(""), None);
        assert_eq!(parse_bounds("10,20"), None);
        assert_eq!(parse_bounds("10,20,0,420"), None);
        assert_eq!(parse_bounds("a,b,c,d"), None);
    }
}
