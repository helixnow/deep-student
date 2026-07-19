#![allow(unexpected_cfgs)] // objc macros internally probe the cargo-clippy feature.

//! AppKit clip host for the browser child WKWebView.
//!
//! Wry appends child WebViews above the main React WKWebView. This wrapper
//! keeps that ordering but cuts holes for DOM surfaces that must sit above the
//! browser, while its custom hit test lets pointer input reach those surfaces.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use cocoa::appkit::{NSViewHeightSizable, NSViewWidthSizable};
use cocoa::base::{id, nil, BOOL, NO, YES};
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use tauri::Webview;

use super::PhysicalSurfaceOcclusion;

const CLIP_HOST_CLASS_NAME: &str = "DeepStudentBrowserSurfaceClipHost";
const NATIVE_CALLBACK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl LogicalRect {
    fn contains(self, point: NSPoint) -> bool {
        point.x >= self.x
            && point.x < self.x + self.width
            && point.y >= self.y
            && point.y < self.y + self.height
    }
}

/// The empty mask (`setMask:nil`) remains correct across host resizes. A
/// shaped mask, however, includes the host bounds and must be rebuilt when
/// those bounds change.
#[derive(Debug, Clone, PartialEq)]
enum MaskSignature {
    Clear,
    Shaped {
        bounds: LogicalRect,
        visual_occlusions: Vec<LogicalRect>,
    },
}

impl MaskSignature {
    fn from_bounds_and_occlusions(bounds: LogicalRect, visual_occlusions: &[LogicalRect]) -> Self {
        if visual_occlusions.is_empty() {
            Self::Clear
        } else {
            Self::Shaped {
                bounds,
                visual_occlusions: visual_occlusions.to_vec(),
            }
        }
    }
}

#[derive(Debug)]
struct ClipHostState {
    content_webview: usize,
    visual_occlusions: Vec<LogicalRect>,
    input_occlusions: Vec<LogicalRect>,
    mask_signature: Option<MaskSignature>,
}

fn clip_hosts() -> &'static Mutex<HashMap<usize, ClipHostState>> {
    static HOSTS: OnceLock<Mutex<HashMap<usize, ClipHostState>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clip_host_class() -> *const Class {
    static CLASS: OnceLock<usize> = OnceLock::new();
    *CLASS.get_or_init(|| unsafe {
        if let Some(existing) = Class::get(CLIP_HOST_CLASS_NAME) {
            return existing as *const Class as usize;
        }

        let superclass = class!(NSView);
        let mut declaration = ClassDecl::new(CLIP_HOST_CLASS_NAME, superclass)
            .expect("browser clip host class must be declared once");
        declaration.add_method(
            sel!(isFlipped),
            clip_host_is_flipped as extern "C" fn(&Object, Sel) -> BOOL,
        );
        declaration.add_method(
            sel!(isOpaque),
            clip_host_is_opaque as extern "C" fn(&Object, Sel) -> BOOL,
        );
        declaration.add_method(
            sel!(hitTest:),
            clip_host_hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id,
        );
        declaration.add_method(
            sel!(layout),
            clip_host_layout as extern "C" fn(&Object, Sel),
        );
        declaration.register() as *const Class as usize
    }) as *const Class
}

extern "C" fn clip_host_is_flipped(_this: &Object, _cmd: Sel) -> BOOL {
    YES
}

extern "C" fn clip_host_is_opaque(_this: &Object, _cmd: Sel) -> BOOL {
    NO
}

extern "C" fn clip_host_hit_test(this: &Object, _cmd: Sel, point: NSPoint) -> id {
    let host_id = this as *const Object as usize;
    let input_occluded = clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&host_id)
        .is_some_and(|state| {
            state
                .input_occlusions
                .iter()
                .any(|rect| rect.contains(point))
        });
    if input_occluded {
        return nil;
    }

    unsafe {
        let ns_view = Class::get("NSView").expect("NSView must be registered");
        let target: id = msg_send![super(this, ns_view), hitTest: point];
        if std::ptr::eq(target, this) {
            // The full-window host itself is transparent. Let the main React
            // WKWebView receive events anywhere the browser child has no view.
            nil
        } else {
            target
        }
    }
}

extern "C" fn clip_host_layout(this: &Object, _cmd: Sel) {
    unsafe {
        let ns_view = Class::get("NSView").expect("NSView must be registered");
        let _: () = msg_send![super(this, ns_view), layout];

        let host = this as *const Object as id;
        let visual_occlusions = clip_hosts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(host as usize))
            .map(|state| state.visual_occlusions.clone());
        if let Some(visual_occlusions) = visual_occlusions {
            // Autoresizing changes the host's bounds before the next React
            // measurement. Rebuild the shape path now so that resize cannot
            // leave the new area masked by an obsolete full-window path.
            let _ = apply_mask_if_needed(host, &visual_occlusions);
        }
    }
}

/// Attach a full-window, flipped NSView around the Wry child WKWebView.
pub fn install(webview: &Webview) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe { install_on_main_thread(platform_webview.inner() as id) };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("failed to schedule browser clip host installation: {error}"))?;
    receiver
        .recv_timeout(NATIVE_CALLBACK_TIMEOUT)
        .map_err(|error| format!("browser clip host installation timed out: {error}"))?
}

/// Apply visual and input rectangles from the main UI thread to the clip host.
pub fn set_occlusions(
    webview: &Webview,
    visual_occlusions: Vec<PhysicalSurfaceOcclusion>,
    input_occlusions: Vec<PhysicalSurfaceOcclusion>,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                set_occlusions_on_main_thread(
                    platform_webview.inner() as id,
                    &visual_occlusions,
                    &input_occlusions,
                )
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("failed to schedule browser clip update: {error}"))?;
    receiver
        .recv_timeout(NATIVE_CALLBACK_TIMEOUT)
        .map_err(|error| format!("browser clip update timed out: {error}"))?
}

/// Remove the wrapper before Wry closes the child WKWebView.
pub fn remove(webview: &Webview) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe { remove_on_main_thread(platform_webview.inner() as id) };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("failed to schedule browser clip host removal: {error}"))?;
    receiver
        .recv_timeout(NATIVE_CALLBACK_TIMEOUT)
        .map_err(|error| format!("browser clip host removal timed out: {error}"))?
}

unsafe fn install_on_main_thread(content: id) -> Result<(), String> {
    if content == nil {
        return Err("browser WKWebView handle was null".into());
    }
    if clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .any(|state| state.content_webview == content as usize)
    {
        return Ok(());
    }

    let parent: id = msg_send![content, superview];
    if parent == nil {
        return Err("browser WKWebView has no parent view".into());
    }
    let parent_bounds: NSRect = msg_send![parent, bounds];
    let prior_frame: NSRect = msg_send![content, frame];
    let host_class = clip_host_class();
    let allocated: id = msg_send![host_class, alloc];
    let host: id = msg_send![allocated, initWithFrame: parent_bounds];
    if host == nil {
        return Err("failed to allocate browser clip host".into());
    }

    let _: () = msg_send![host, setWantsLayer: YES];
    let _: () = msg_send![host, setClipsToBounds: YES];
    let _: () = msg_send![host, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
    let _: () = msg_send![content, removeFromSuperview];
    let _: () = msg_send![parent, addSubview: host];

    // Wry's previous parent is not flipped; the custom host is flipped so its
    // coordinates directly match CSS pixels and future Wry set_bounds calls.
    let frame = NSRect::new(
        NSPoint::new(
            prior_frame.origin.x - parent_bounds.origin.x,
            parent_bounds.size.height - prior_frame.origin.y - prior_frame.size.height,
        ),
        prior_frame.size,
    );
    let _: () = msg_send![content, setFrame: frame];
    let _: () = msg_send![host, addSubview: content];
    let _: () = msg_send![host, release];

    clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            host as usize,
            ClipHostState {
                content_webview: content as usize,
                visual_occlusions: Vec::new(),
                input_occlusions: Vec::new(),
                mask_signature: None,
            },
        );
    Ok(())
}

unsafe fn set_occlusions_on_main_thread(
    content: id,
    visual_occlusions: &[PhysicalSurfaceOcclusion],
    input_occlusions: &[PhysicalSurfaceOcclusion],
) -> Result<(), String> {
    let host = clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find_map(|(host, state)| (state.content_webview == content as usize).then_some(*host))
        .ok_or_else(|| "browser clip host was not installed".to_string())? as id;
    let parent: id = msg_send![host, superview];
    if parent == nil {
        return Err("browser clip host has no parent view".into());
    }
    let parent_bounds: NSRect = msg_send![parent, bounds];
    let _: () = msg_send![host, setFrame: parent_bounds];

    let ns_window: id = msg_send![host, window];
    if ns_window == nil {
        return Err("browser clip host has no NSWindow".into());
    }
    let scale: f64 = msg_send![ns_window, backingScaleFactor];
    if !scale.is_finite() || scale <= 0.0 {
        return Err("browser clip host has an invalid backing scale factor".into());
    }
    let to_logical_rects = |rectangles: &[PhysicalSurfaceOcclusion]| {
        rectangles
            .iter()
            .map(|rect| LogicalRect {
                x: f64::from(rect.x) / scale,
                y: f64::from(rect.y) / scale,
                width: f64::from(rect.width) / scale,
                height: f64::from(rect.height) / scale,
            })
            .collect::<Vec<_>>()
    };
    let logical_visual_occlusions = to_logical_rects(visual_occlusions);
    let logical_input_occlusions = to_logical_rects(input_occlusions);
    let mut hosts = clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(state) = hosts.get_mut(&(host as usize)) {
        state.visual_occlusions = logical_visual_occlusions.clone();
        state.input_occlusions = logical_input_occlusions;
    }
    drop(hosts);
    apply_mask_if_needed(host, &logical_visual_occlusions)?;
    Ok(())
}

unsafe fn remove_on_main_thread(content: id) -> Result<(), String> {
    let host = {
        let hosts = clip_hosts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hosts
            .iter()
            .find_map(|(host, state)| (state.content_webview == content as usize).then_some(*host))
    };
    let Some(host) = host else {
        return Ok(());
    };
    let host = host as id;
    let _: () = msg_send![content, removeFromSuperview];
    let _: () = msg_send![host, removeFromSuperview];
    clip_hosts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&(host as usize));
    Ok(())
}

unsafe fn apply_mask(host: id, occlusions: &[LogicalRect]) -> Result<(), String> {
    let host_layer: id = msg_send![host, layer];
    if host_layer == nil {
        return Err("browser clip host has no CALayer".into());
    }
    let _: () = msg_send![class!(CATransaction), begin];
    let _: () = msg_send![class!(CATransaction), setDisableActions: YES];

    if occlusions.is_empty() {
        let _: () = msg_send![host_layer, setMask: nil];
        let _: () = msg_send![class!(CATransaction), commit];
        return Ok(());
    }

    let bounds: NSRect = msg_send![host, bounds];
    let mask: id = msg_send![class!(CAShapeLayer), layer];
    let path = CGPathCreateMutable();
    if path.is_null() {
        let _: () = msg_send![class!(CATransaction), commit];
        return Err("failed to allocate browser clip path".into());
    }
    CGPathAddRect(path, std::ptr::null(), bounds);
    for rect in occlusions {
        CGPathAddRect(
            path,
            std::ptr::null(),
            NSRect::new(
                NSPoint::new(rect.x, rect.y),
                NSSize::new(rect.width, rect.height),
            ),
        );
    }

    let _: () = msg_send![mask, setFrame: bounds];
    let fill_rule = NSString::alloc(nil).init_str("evenOdd");
    let _: () = msg_send![mask, setFillRule: fill_rule];
    let _: () = msg_send![mask, setPath: path];
    let _: () = msg_send![fill_rule, release];
    CGPathRelease(path);
    let _: () = msg_send![host_layer, setMask: mask];
    let _: () = msg_send![class!(CATransaction), commit];
    Ok(())
}

/// Skip CALayer churn while a browser window moves under unchanged DOM
/// occlusions. The cache is recorded before applying because AppKit layout may
/// synchronously re-enter this code; a failed application clears that record
/// so the next update retries.
unsafe fn apply_mask_if_needed(host: id, visual_occlusions: &[LogicalRect]) -> Result<(), String> {
    let desired = if visual_occlusions.is_empty() {
        MaskSignature::Clear
    } else {
        let bounds: NSRect = msg_send![host, bounds];
        MaskSignature::from_bounds_and_occlusions(
            LogicalRect {
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.size.width,
                height: bounds.size.height,
            },
            visual_occlusions,
        )
    };
    let should_apply = {
        let mut hosts = clip_hosts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = hosts
            .get_mut(&(host as usize))
            .ok_or_else(|| "browser clip host was not installed".to_string())?;
        if state.mask_signature.as_ref() == Some(&desired) {
            false
        } else {
            state.mask_signature = Some(desired.clone());
            true
        }
    };
    if !should_apply {
        return Ok(());
    }

    if let Err(error) = apply_mask(host, visual_occlusions) {
        let mut hosts = clip_hosts()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = hosts.get_mut(&(host as usize)) {
            if state.mask_signature.as_ref() == Some(&desired) {
                state.mask_signature = None;
            }
        }
        return Err(error);
    }
    Ok(())
}

type CGPathRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPathCreateMutable() -> CGPathRef;
    fn CGPathAddRect(path: CGPathRef, transform: *const c_void, rect: NSRect);
    fn CGPathRelease(path: CGPathRef);
}

#[cfg(test)]
mod tests {
    use super::{LogicalRect, MaskSignature};

    const BOUNDS: LogicalRect = LogicalRect {
        x: 0.0,
        y: 0.0,
        width: 800.0,
        height: 600.0,
    };
    const RESIZED_BOUNDS: LogicalRect = LogicalRect {
        width: 1000.0,
        ..BOUNDS
    };
    const OCCLUSION: LogicalRect = LogicalRect {
        x: 10.0,
        y: 20.0,
        width: 30.0,
        height: 40.0,
    };

    #[test]
    fn clear_mask_signature_ignores_host_bounds() {
        assert_eq!(
            MaskSignature::from_bounds_and_occlusions(BOUNDS, &[]),
            MaskSignature::from_bounds_and_occlusions(RESIZED_BOUNDS, &[]),
        );
    }

    #[test]
    fn shaped_mask_signature_tracks_bounds_and_occlusions() {
        let initial = MaskSignature::from_bounds_and_occlusions(BOUNDS, &[OCCLUSION]);
        assert_ne!(
            initial,
            MaskSignature::from_bounds_and_occlusions(RESIZED_BOUNDS, &[OCCLUSION]),
        );
        assert_ne!(
            initial,
            MaskSignature::from_bounds_and_occlusions(
                BOUNDS,
                &[LogicalRect {
                    width: 31.0,
                    ..OCCLUSION
                }],
            ),
        );
    }
}
