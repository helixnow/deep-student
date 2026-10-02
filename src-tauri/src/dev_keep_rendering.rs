//! 开发版 UI 自动化：窗口在后台 / 被遮挡时也保持网页渲染与脚本运行。
//!
//! 仅在 macOS + debug 构建 + `VITE_DS_UI_BRIDGE=1`（UI 调试桥）时生效，正式版不受影响。
//! - WKWebView 默认按窗口遮挡挂起渲染、暂停动画、最终冻结 JS（截图停在入场动画首帧、
//!   调试桥 eval 超时）：关闭其遮挡检测（私有 SPI，先 respondsToSelector 探测）；
//! - macOS App Nap 会节流后台应用：持有一个 user-initiated 活动（允许系统空闲睡眠）。

/// debug 构建且开启 UI 调试桥（`VITE_DS_UI_BRIDGE=1`）
pub fn ui_automation_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("VITE_DS_UI_BRIDGE").as_deref() == Ok("1")
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub fn keep_rendering_when_occluded(window: &tauri::WebviewWindow) {
    if !ui_automation_enabled() {
        return;
    }

    let scheduled = window.with_webview(|webview| {
        #[allow(unexpected_cfgs)]
        unsafe {
            use cocoa::base::{id, NO};
            use objc::{msg_send, sel, sel_impl};
            let wk = webview.inner() as id;
            let selector = sel!(_setWindowOcclusionDetectionEnabled:);
            let responds: bool = msg_send![wk, respondsToSelector: selector];
            if responds {
                let _: () = msg_send![wk, _setWindowOcclusionDetectionEnabled: NO];
                log::info!("[dev] WKWebView 遮挡检测已关闭（后台也保持渲染，便于 UI 自动化）");
            } else {
                log::warn!("[dev] WKWebView 不支持关闭遮挡检测，后台时可能停止渲染");
            }

            // 窗口切到别的桌面空间时页面变 hidden：WebKit 逐步加码节流定时器并最终抑制
            // WebContent 进程，调试桥连 WebSocket 消息都不再处理（eval 超时）。
            let configuration: id = msg_send![wk, configuration];
            let preferences: id = msg_send![configuration, preferences];
            let mut disabled: Vec<&str> = Vec::new();
            if msg_send![preferences, respondsToSelector: sel!(_setHiddenPageDOMTimerThrottlingEnabled:)] {
                let _: () = msg_send![preferences, _setHiddenPageDOMTimerThrottlingEnabled: NO];
                disabled.push("hiddenPageDOMTimerThrottling");
            }
            if msg_send![preferences, respondsToSelector: sel!(_setHiddenPageDOMTimerThrottlingAutoIncreases:)] {
                let _: () = msg_send![preferences, _setHiddenPageDOMTimerThrottlingAutoIncreases: NO];
                disabled.push("hiddenPageDOMTimerThrottlingAutoIncreases");
            }
            if msg_send![preferences, respondsToSelector: sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)] {
                let _: () = msg_send![preferences, _setPageVisibilityBasedProcessSuppressionEnabled: NO];
                disabled.push("pageVisibilityBasedProcessSuppression");
            }
            log::info!("[dev] 隐藏页面节流已关闭: {:?}", disabled);
        }
    });
    if let Err(error) = scheduled {
        log::warn!("[dev] 无法访问 WKWebView: {}", error);
    }

    #[allow(unexpected_cfgs)]
    unsafe {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSString;
        use objc::{class, msg_send, sel, sel_impl};
        // NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
        const OPTIONS: u64 = 0x00EF_FFFF | 0xFF_0000_0000;
        let process_info: id = msg_send![class!(NSProcessInfo), processInfo];
        let reason = NSString::alloc(nil).init_str("Deep Student dev UI automation");
        let activity: id = msg_send![process_info, beginActivityWithOptions: OPTIONS reason: reason];
        // 活动对象需在进程生命周期内保持：retain 一次且永不 release
        let _: id = msg_send![activity, retain];
        log::info!("[dev] 已禁用 App Nap（开发版 UI 自动化）");
    }
}

#[cfg(not(all(target_os = "macos", debug_assertions)))]
pub fn keep_rendering_when_occluded(_window: &tauri::WebviewWindow) {}
