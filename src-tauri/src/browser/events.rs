//! Browser 运行时事件（Rust → 前端）
//!
//! 事件名与 payload 对齐 `docs/dev/workbench-browser-design.md` / Rust API 设计稿。
//! 全部 payload 使用 camelCase。

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::warn;

/// Content 窗完成导航（含 back/forward/reload 后的地址变更）
pub const EVT_NAVIGATED: &str = "browser:navigated";
/// Content 窗关闭 / session 销毁
pub const EVT_CLOSED: &str = "browser:closed";
/// document.title 变更
pub const EVT_TITLE_CHANGED: &str = "browser:title-changed";
/// 控制权变更（User ↔ Agent；ACR R1-05）
pub const EVT_CONTROL_MODE_CHANGED: &str = "browser:control-mode-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigatedPayload {
    pub session_id: String,
    pub label: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedPayload {
    pub session_id: String,
    pub label: String,
    /// `user` | `service` | `boot_cleanup` | `destroyed`
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTitleChangedPayload {
    pub session_id: String,
    pub label: String,
    pub title: String,
    pub url: String,
    pub at: String,
}

/// 控制权变更事件载荷（ACR R1-05）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlModeChangedPayload {
    pub session_id: String,
    pub label: String,
    /// `user` | `agent`
    pub control_mode: String,
    /// `agent_claim` | `user_takeover` | `password_blocked`
    pub reason: String,
    pub at: String,
}

pub fn emit_navigated(app: &AppHandle, payload: &BrowserNavigatedPayload) {
    if let Err(e) = app.emit(EVT_NAVIGATED, payload) {
        warn!("[browser] emit {} failed: {}", EVT_NAVIGATED, e);
    }
}

pub fn emit_closed(app: &AppHandle, payload: &BrowserClosedPayload) {
    if let Err(e) = app.emit(EVT_CLOSED, payload) {
        warn!("[browser] emit {} failed: {}", EVT_CLOSED, e);
    }
}

pub fn emit_title_changed(app: &AppHandle, payload: &BrowserTitleChangedPayload) {
    if let Err(e) = app.emit(EVT_TITLE_CHANGED, payload) {
        warn!("[browser] emit {} failed: {}", EVT_TITLE_CHANGED, e);
    }
}

pub fn emit_control_mode_changed(app: &AppHandle, payload: &BrowserControlModeChangedPayload) {
    if let Err(e) = app.emit(EVT_CONTROL_MODE_CHANGED, payload) {
        warn!("[browser] emit {} failed: {}", EVT_CONTROL_MODE_CHANGED, e);
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}
