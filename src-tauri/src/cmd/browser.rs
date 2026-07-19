//! Workbench 内置浏览器 Tauri commands（B1e）
//!
//! 导航类委托 [`BrowserService`]；snapshot / click / type / scroll 转注入桥。
//! Bridge 未就绪时返回清晰错误码（`BRIDGE_NOT_READY`），不 panic。

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{State, Webview};

use crate::browser::service::SurfaceCssOcclusion;
use crate::browser::{
    bridge_client, BridgeError, BrowserError, BrowserService, BrowserSessionState, HistoryEntry,
    OpenSessionOptions, BROWSER_CONTENT_LABEL,
};

type CmdResult<T> = Result<T, String>;

fn map_err(e: BrowserError) -> String {
    // 结构化前缀便于前端 / Agent 分支；正文保留 Display
    match &e {
        BrowserError::NotFound(msg) => format!("NOT_FOUND: {msg}"),
        BrowserError::Validation(msg) if msg.starts_with("navigation_blocked") => {
            format!("NAVIGATION_BLOCKED: {msg}")
        }
        BrowserError::Validation(msg) if msg.contains("disabled") => {
            format!("GATES_CLOSED: {msg}")
        }
        BrowserError::Validation(msg) if msg.contains("agent automation unsupported") => {
            format!("BRIDGE_UNSUPPORTED: {msg}")
        }
        BrowserError::Validation(msg) if msg.starts_with("user_takeover") => {
            format!("USER_TAKEOVER: {msg}")
        }
        BrowserError::NotOpen => "DB_NOT_OPEN: database not open (call open_session first)".into(),
        other => other.to_string(),
    }
}

fn map_bridge_err(e: BridgeError) -> String {
    match e {
        BridgeError::Unsupported(msg) => format!("BRIDGE_UNSUPPORTED: {msg}"),
        BridgeError::WebviewNotFound(label) => {
            format!("BRIDGE_NOT_READY: webview '{label}' not found")
        }
        BridgeError::Bridge {
            code,
            message,
            details,
        } => {
            if code == "NOT_READY" || code == "PASSWORD_FIELD" {
                format!("BRIDGE_{code}: {message}")
            } else if let Some(d) = details {
                format!("BRIDGE_{code}: {message} ({d})")
            } else {
                format!("BRIDGE_{code}: {message}")
            }
        }
        BridgeError::Timeout(d) => format!("BRIDGE_TIMEOUT: after {d:?}"),
        other => format!("BRIDGE_ERROR: {other}"),
    }
}

fn bridge_for(service: &BrowserService) -> crate::browser::BridgeClient {
    bridge_client(service.app_handle().clone())
}

fn ensure_bridge_supported() -> CmdResult<()> {
    if BrowserService::agent_automation_supported() {
        Ok(())
    } else {
        Err(
            "BRIDGE_UNSUPPORTED: browser automation result bridge is available on Windows and macOS only"
                .into(),
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateResult {
    #[serde(flatten)]
    pub state: BrowserSessionState,
    pub history: Vec<HistoryEntry>,
    pub agent_automation_supported: bool,
}

fn state_result(
    service: &BrowserService,
    state: BrowserSessionState,
) -> CmdResult<BrowserStateResult> {
    let history = service.get_history(&state.id).map_err(map_err)?;
    Ok(BrowserStateResult {
        state,
        history,
        agent_automation_supported: BrowserService::agent_automation_supported(),
    })
}

// ---------------------------------------------------------------------------
// Session / navigation
// ---------------------------------------------------------------------------

/// 打开（或复用）唯一 browser session，并创建 `browser-content` 窗。
///
/// **不会**在 setup 阶段建库；首次成功开闸后由 Service lazy `ensure_open`。
/// 参数扁平 camelCase，与前端 `invoke(cmd, { url, ... })` 对齐。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_open_session(
    service: State<'_, Arc<BrowserService>>,
    url: String,
    displayName: Option<String>,
    chatSessionId: Option<String>,
    reuseExisting: Option<bool>,
    fromAgent: Option<bool>,
) -> CmdResult<BrowserStateResult> {
    let options = OpenSessionOptions {
        url,
        display_name: displayName,
        chat_session_id: chatSessionId,
        width: None,
        height: None,
        focused: Some(true),
        reuse_existing: reuseExisting.or(Some(true)),
        from_agent: fromAgent.or(Some(false)),
    };
    let state = service.open_session(options).await.map_err(map_err)?;
    state_result(service.inner(), state)
}

/// `fromAgent=true` 时额外跑私网硬拦。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_navigate(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    url: String,
    replace: Option<bool>,
    fromAgent: Option<bool>,
) -> CmdResult<BrowserStateResult> {
    let replace = replace.unwrap_or(false);
    let state = if fromAgent.unwrap_or(false) {
        service
            .navigate_from_agent(&sessionId, &url, replace)
            .await
            .map_err(map_err)
    } else {
        service
            .navigate(&sessionId, &url, replace)
            .await
            .map_err(map_err)
    }?;
    state_result(service.inner(), state)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_back(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
) -> CmdResult<BrowserStateResult> {
    let state = service.back(&sessionId).await.map_err(map_err)?;
    state_result(service.inner(), state)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_forward(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
) -> CmdResult<BrowserStateResult> {
    let state = service.forward(&sessionId).await.map_err(map_err)?;
    state_result(service.inner(), state)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_reload(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    #[allow(unused_variables)] hard: Option<bool>,
) -> CmdResult<BrowserStateResult> {
    // hard reload：平台 WebView API 一期统一走 reload；hard 预留
    let state = service.reload(&sessionId).await.map_err(map_err)?;
    state_result(service.inner(), state)
}

/// `sessionId` 省略时返回当前活跃 session（若有）
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_get_state(
    service: State<'_, Arc<BrowserService>>,
    sessionId: Option<String>,
) -> CmdResult<Option<BrowserStateResult>> {
    service.assert_gates_open().await.map_err(map_err)?;
    match sessionId {
        Some(id) => {
            let state = service.get_state(&id).map_err(map_err)?;
            state_result(service.inner(), state).map(Some)
        }
        None => service
            .get_active_state()
            .map(|state| state_result(service.inner(), state))
            .transpose(),
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_close(
    service: State<'_, Arc<BrowserService>>,
    sessionId: Option<String>,
) -> CmdResult<()> {
    if let Some(id) = sessionId.as_deref() {
        // 校验 id 匹配（若有活跃 session）
        if let Some(active) = service.get_active_state() {
            if active.id != id {
                return Err(format!("NOT_FOUND: session {id}"));
            }
        }
    }
    service.close_session().await.map_err(map_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_focus(
    service: State<'_, Arc<BrowserService>>,
    sessionId: Option<String>,
) -> CmdResult<()> {
    service.assert_gates_open().await.map_err(map_err)?;
    let id = match sessionId {
        Some(id) => id,
        None => service
            .get_active_state()
            .map(|s| s.id)
            .ok_or_else(|| "NOT_FOUND: no active browser session".to_string())?,
    };
    service.focus(&id).await.map_err(map_err)
}

/// Return keyboard focus from the native browser child to the main React WebView.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_release_surface_focus(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
) -> CmdResult<()> {
    service.assert_gates_open().await.map_err(map_err)?;
    service.release_surface_focus(&sessionId).map_err(map_err)
}

/// Position the native browser surface over its DOM placeholder.
/// `sequence` is monotonic per session; stale async updates are ignored.
#[tauri::command]
#[allow(non_snake_case, clippy::too_many_arguments)]
pub async fn browser_set_surface_bounds(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewportWidth: f64,
    viewportHeight: f64,
    occlusions: Option<Vec<SurfaceCssOcclusion>>,
    inputOcclusions: Option<Vec<SurfaceCssOcclusion>>,
    sequence: u64,
) -> CmdResult<String> {
    service.assert_gates_open().await.map_err(map_err)?;
    service
        .set_surface_bounds(
            &sessionId,
            x,
            y,
            width,
            height,
            viewportWidth,
            viewportHeight,
            occlusions.unwrap_or_default(),
            inputOcclusions.unwrap_or_default(),
            sequence,
        )
        .map(str::to_string)
        .map_err(map_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_set_surface_visibility(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    visible: bool,
    focus: Option<bool>,
) -> CmdResult<String> {
    service.assert_gates_open().await.map_err(map_err)?;
    service
        .set_surface_visibility(&sessionId, visible, focus.unwrap_or(false))
        .map(str::to_string)
        .map_err(map_err)
}

#[tauri::command]
pub fn browser_get_surface_host_mode() -> CmdResult<String> {
    Ok(BrowserService::surface_host_mode().to_string())
}

/// Private command for the document-start trusted-input listener. `webview` is
/// injected by Tauri and cannot be supplied by page JavaScript.
#[tauri::command]
#[allow(non_snake_case)]
pub fn browser_content_user_input(
    webview: Webview,
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    nonce: String,
    kind: String,
) -> CmdResult<()> {
    if webview.label() != BROWSER_CONTENT_LABEL {
        return Err("FORBIDDEN: trusted browser input requires browser-content Webview".into());
    }
    service
        .content_user_input(&sessionId, &nonce, &kind)
        .map_err(map_err)
}

/// 用户接管：打断 agent 控制态（design §2）
#[tauri::command]
pub async fn browser_take_over(
    service: State<'_, Arc<BrowserService>>,
) -> CmdResult<BrowserStateResult> {
    service.assert_gates_open().await.map_err(map_err)?;
    let state = service.take_over().map_err(map_err)?;
    state_result(service.inner(), state)
}

// ---------------------------------------------------------------------------
// Bridge ops（B1d）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotResult {
    pub session_id: String,
    pub url: String,
    pub title: String,
    pub snapshot: String,
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_snapshot(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    maxChars: Option<u32>,
) -> CmdResult<BrowserSnapshotResult> {
    service.assert_gates_open().await.map_err(map_err)?;
    ensure_bridge_supported()?;
    let state = service.get_state(&sessionId).map_err(map_err)?;
    let mut opts = serde_json::json!({ "interactiveOnly": true });
    if let Some(max) = maxChars {
        opts["maxChars"] = Value::from(max);
    }
    let value = bridge_for(service.inner())
        .snapshot_opts(opts)
        .await
        .map_err(map_bridge_err)?;
    let snapshot = value
        .get("text")
        .or_else(|| value.get("snapshot"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| value.to_string());
    Ok(BrowserSnapshotResult {
        session_id: state.id,
        url: state.url,
        title: state.title,
        snapshot,
    })
}

/// `ref` 为 snapshot 节点引用；坐标点击不对模型开放。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_click(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    r#ref: String,
) -> CmdResult<Value> {
    service.assert_gates_open().await.map_err(map_err)?;
    ensure_bridge_supported()?;
    let _ = service.get_state(&sessionId).map_err(map_err)?;
    bridge_for(service.inner())
        .click(&r#ref)
        .await
        .map_err(map_bridge_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_type(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    r#ref: String,
    text: String,
    submit: Option<bool>,
) -> CmdResult<Value> {
    service.assert_gates_open().await.map_err(map_err)?;
    ensure_bridge_supported()?;
    let _ = service.get_state(&sessionId).map_err(map_err)?;
    // 密码硬拒由 bridge 返回 BRIDGE_PASSWORD_FIELD；此处透传
    let _ = submit; // submit 由桥 opts 扩展；一期 type_text 默认 clear
    bridge_for(service.inner())
        .type_text(&r#ref, &text)
        .await
        .map_err(map_bridge_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_scroll(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    direction: Option<String>,
    amount: Option<i32>,
    r#ref: Option<String>,
) -> CmdResult<Value> {
    service.assert_gates_open().await.map_err(map_err)?;
    ensure_bridge_supported()?;
    let _ = service.get_state(&sessionId).map_err(map_err)?;
    let opts = serde_json::json!({
        "direction": direction,
        "amount": amount,
        "ref": r#ref,
    });
    bridge_for(service.inner())
        .scroll(opts)
        .await
        .map_err(map_bridge_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::ControlMode;
    use chrono::Utc;

    fn sample_state() -> BrowserSessionState {
        BrowserSessionState {
            id: "bs_test".into(),
            label: "browser-content".into(),
            title: "Example".into(),
            url: "https://example.com/".into(),
            can_go_back: false,
            can_go_forward: false,
            loading: false,
            alive: true,
            control_mode: ControlMode::User,
            history_index: 0,
            history_len: 1,
            chat_session_id: None,
            profile_path: "/tmp/browser".into(),
            created_at: "2026-07-11T00:00:00Z".into(),
            updated_at: "2026-07-11T00:00:00Z".into(),
        }
    }

    #[test]
    fn state_result_exposes_history_and_platform_capability() {
        let result = BrowserStateResult {
            state: sample_state(),
            history: vec![HistoryEntry {
                url: "https://example.com/".into(),
                title: "Example".into(),
                visited_at: Utc::now(),
            }],
            agent_automation_supported: BrowserService::agent_automation_supported(),
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["id"], "bs_test");
        assert_eq!(json["history"][0]["url"], "https://example.com/");
        assert_eq!(
            json["agentAutomationSupported"],
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    #[test]
    fn unsupported_agent_service_error_has_bridge_code() {
        let mapped = map_err(BrowserError::Validation(
            "browser agent automation unsupported: test".into(),
        ));
        assert!(mapped.starts_with("BRIDGE_UNSUPPORTED:"));
    }

    #[test]
    fn user_takeover_service_error_has_control_code() {
        let mapped = map_err(BrowserError::Validation(
            "user_takeover: user recently took control".into(),
        ));
        assert!(mapped.starts_with("USER_TAKEOVER:"));
    }
}
