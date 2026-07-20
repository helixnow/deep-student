//! Plugin event names (kebab-case) emitted to the frontend.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::types::PluginState;

pub const STATE_CHANGED: &str = "plugin-state-changed";
pub const QRCODE: &str = "plugin-qrcode";
pub const ACTIVITY: &str = "plugin-activity";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChangedPayload {
    pub plugin_id: String,
    pub state: PluginState,
    pub error: Option<String>,
    pub ts: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrcodePayload {
    pub plugin_id: String,
    pub png_base64: String,
    pub status: String,
    pub ts: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPayload {
    pub plugin_id: String,
    pub kind: String,
    pub summary: String,
    pub ts: i64,
}

pub fn emit_state(app: &AppHandle, plugin_id: &str, state: PluginState, error: Option<String>) {
    let payload = StateChangedPayload {
        plugin_id: plugin_id.to_string(),
        state,
        error,
        ts: chrono::Utc::now().timestamp_millis(),
    };
    if let Err(e) = app.emit(STATE_CHANGED, payload) {
        tracing::warn!("[plugins] emit state failed: {}", e);
    }
}

pub fn emit_qrcode(app: &AppHandle, plugin_id: &str, png_base64: String, status: &str) {
    let payload = QrcodePayload {
        plugin_id: plugin_id.to_string(),
        png_base64,
        status: status.to_string(),
        ts: chrono::Utc::now().timestamp_millis(),
    };
    if let Err(e) = app.emit(QRCODE, payload) {
        tracing::warn!("[plugins] emit qrcode failed: {}", e);
    }
}

pub fn emit_activity(app: &AppHandle, plugin_id: &str, kind: &str, summary: &str) {
    let payload = ActivityPayload {
        plugin_id: plugin_id.to_string(),
        kind: kind.to_string(),
        summary: summary.to_string(),
        ts: chrono::Utc::now().timestamp_millis(),
    };
    if let Err(e) = app.emit(ACTIVITY, payload) {
        tracing::warn!("[plugins] emit activity failed: {}", e);
    }
}
