//! 窗口视觉效果命令
//!
//! macOS 原生窗口毛玻璃（NSVisualEffectView vibrancy），
//! 用于「侧边栏半透明」设置的桌面透视效果。

use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

#[cfg(target_os = "macos")]
const TITLEBAR_SIDEBAR_VIEW_IDENTIFIER: &str = "com.deepstudent.titlebar-sidebar-material";
#[cfg(target_os = "macos")]
const TITLEBAR_SIDEBAR_CLASS_NAME: &str = "DeepStudentTitlebarSidebarMaterialView";

#[cfg(target_os = "macos")]
extern "C" fn titlebar_sidebar_material_is_opaque(
    _this: &objc::runtime::Object,
    _cmd: objc::runtime::Sel,
) -> cocoa::base::BOOL {
    cocoa::base::NO
}

#[cfg(target_os = "macos")]
extern "C" fn titlebar_sidebar_material_hit_test(
    _this: &objc::runtime::Object,
    _cmd: objc::runtime::Sel,
    _point: cocoa::foundation::NSPoint,
) -> cocoa::base::id {
    cocoa::base::nil
}

#[cfg(target_os = "macos")]
fn titlebar_sidebar_material_class() -> *const objc::runtime::Class {
    use std::sync::OnceLock;

    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, sel, sel_impl};

    static CLASS: OnceLock<usize> = OnceLock::new();
    *CLASS.get_or_init(|| unsafe {
        if let Some(existing) = Class::get(TITLEBAR_SIDEBAR_CLASS_NAME) {
            return existing as *const Class as usize;
        }

        let superclass = class!(NSVisualEffectView);
        let mut declaration = ClassDecl::new(TITLEBAR_SIDEBAR_CLASS_NAME, superclass)
            .expect("titlebar sidebar material class must be declared once");
        declaration.add_method(
            sel!(isOpaque),
            titlebar_sidebar_material_is_opaque as extern "C" fn(&Object, Sel) -> cocoa::base::BOOL,
        );
        declaration.add_method(
            sel!(hitTest:),
            titlebar_sidebar_material_hit_test
                as extern "C" fn(&Object, Sel, cocoa::foundation::NSPoint) -> cocoa::base::id,
        );
        declaration.register() as *const Class as usize
    }) as *const objc::runtime::Class
}

#[cfg(target_os = "macos")]
unsafe fn find_identified_subview(
    container: cocoa::base::id,
    identifier: cocoa::base::id,
) -> cocoa::base::id {
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};

    let subviews: cocoa::base::id = msg_send![container, subviews];
    if subviews == nil {
        return nil;
    }

    let count: usize = msg_send![subviews, count];
    for index in 0..count {
        let view: cocoa::base::id = msg_send![subviews, objectAtIndex: index];
        let view_identifier: cocoa::base::id = msg_send![view, identifier];
        if view_identifier != nil {
            let matches: bool = msg_send![view_identifier, isEqualToString: identifier];
            if matches {
                return view;
            }
        }
    }

    nil
}

#[cfg(target_os = "macos")]
unsafe fn sync_titlebar_sidebar_material_impl(
    ns_window: cocoa::base::id,
    enabled: bool,
    width: f64,
) -> std::result::Result<(), String> {
    use cocoa::appkit::{
        NSView, NSViewHeightSizable, NSViewMaxXMargin, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowButton,
        NSWindowOrderingMode,
    };
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
    use objc::{msg_send, sel, sel_impl};

    let close_button = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
    if close_button == nil {
        return Err("找不到 macOS 标题栏关闭按钮".into());
    }

    let titlebar_container = {
        let first_superview = NSView::superview(close_button);
        if first_superview == nil {
            return Err("关闭按钮缺少 superview".into());
        }
        let second_superview = NSView::superview(first_superview);
        if second_superview == nil {
            return Err("标题栏容器 superview 缺失".into());
        }
        second_superview
    };

    let identifier: id = NSString::alloc(nil).init_str(TITLEBAR_SIDEBAR_VIEW_IDENTIFIER);
    let existing = find_identified_subview(titlebar_container, identifier);
    if existing != nil {
        let _: () = msg_send![existing, removeFromSuperview];
    }

    if !enabled || width <= 0.0 {
        let _: () = msg_send![identifier, release];
        return Ok(());
    }

    let bounds: NSRect = msg_send![titlebar_container, bounds];
    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width.min(bounds.size.width), bounds.size.height),
    );

    let material_class = titlebar_sidebar_material_class();
    let allocated: id = msg_send![material_class, alloc];
    let view: id = NSVisualEffectView::initWithFrame_(allocated, frame);
    if view == nil {
        let _: () = msg_send![identifier, release];
        return Err("创建 NSVisualEffectView 失败".into());
    }

    let _: () = msg_send![view, setIdentifier: identifier];
    let _: () = msg_send![view, setAutoresizingMask: NSViewHeightSizable | NSViewMaxXMargin];
    let _: () = msg_send![view, setWantsLayer: true];
    let _: () = msg_send![view, setHidden: false];
    view.setMaterial_(NSVisualEffectMaterial::Sidebar);
    view.setBlendingMode_(NSVisualEffectBlendingMode::BehindWindow);
    view.setState_(NSVisualEffectState::FollowsWindowActiveState);

    let _: () = msg_send![
        titlebar_container,
        addSubview: view
        positioned: NSWindowOrderingMode::NSWindowBelow
        relativeTo: nil
    ];
    let _: () = msg_send![view, release];
    let _: () = msg_send![identifier, release];

    Ok(())
}

/// 切换 macOS 原生窗口 vibrancy（侧边栏半透明毛玻璃）。
///
/// 返回 `true` 表示原生 vibrancy 已生效（仅 macOS）；其他平台返回 `false`，
/// 前端应退回纯 CSS 半透明方案。
#[tauri::command]
pub async fn set_sidebar_vibrancy(window: tauri::WebviewWindow, enabled: bool) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::mpsc;
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

        // NSVisualEffectView 只能在主线程操作；命令跑在异步运行时，需调度回主线程
        let (tx, rx) = mpsc::channel::<std::result::Result<bool, String>>();
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let result = if enabled {
                    // Sidebar 材质 + state=None（FollowsWindowActiveState）：
                    // 与系统原生侧边栏一致，窗口失焦时自动退化为不透明底色
                    apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, None, None)
                        .map(|_| true)
                        .map_err(|e| e.to_string())
                } else {
                    clear_vibrancy(&win)
                        .map(|_| false)
                        .map_err(|e| e.to_string())
                };
                let _ = tx.send(result);
            })
            .map_err(|e| AppError::internal(format!("调度主线程失败: {e}")))?;

        rx.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| AppError::internal(format!("等待 vibrancy 结果失败: {e}")))?
            .map_err(AppError::internal)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled);
        Ok(false)
    }
}

#[tauri::command]
pub async fn sync_titlebar_sidebar_material(
    window: tauri::WebviewWindow,
    enabled: bool,
    width: f64,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let result = if let Ok(ns_window_raw) = win.ns_window() {
                    unsafe {
                        sync_titlebar_sidebar_material_impl(
                            ns_window_raw as cocoa::base::id,
                            enabled,
                            width,
                        )
                    }
                } else {
                    Err("获取 NSWindow 失败".into())
                };
                let _ = tx.send(result);
            })
            .map_err(|e| AppError::internal(format!("调度主线程失败: {e}")))?;

        rx.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| AppError::internal(format!("等待标题栏材质同步结果失败: {e}")))?
            .map_err(AppError::internal)?;

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled, width);
        Ok(())
    }
}
