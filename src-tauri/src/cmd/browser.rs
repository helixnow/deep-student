//! Workbench 内置浏览器 Tauri commands（B1e）
//!
//! 导航类委托 [`BrowserService`]；snapshot / click / type / scroll 转注入桥。
//! Bridge 未就绪时返回清晰错误码（`BRIDGE_NOT_READY`），不 panic。

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::browser::{
    bridge_client, BridgeError, BrowserError, BrowserService, BrowserSessionState,
    OpenSessionOptions,
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
) -> CmdResult<BrowserSessionState> {
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
    service.open_session(options).await.map_err(map_err)
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
) -> CmdResult<BrowserSessionState> {
    let replace = replace.unwrap_or(false);
    if fromAgent.unwrap_or(false) {
        service
            .navigate_from_agent(&sessionId, &url, replace)
            .await
            .map_err(map_err)
    } else {
        service
            .navigate(&sessionId, &url, replace)
            .await
            .map_err(map_err)
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_back(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
) -> CmdResult<BrowserSessionState> {
    service.back(&sessionId).await.map_err(map_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_forward(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
) -> CmdResult<BrowserSessionState> {
    service.forward(&sessionId).await.map_err(map_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_reload(
    service: State<'_, Arc<BrowserService>>,
    sessionId: String,
    #[allow(unused_variables)] hard: Option<bool>,
) -> CmdResult<BrowserSessionState> {
    // hard reload：平台 WebView API 一期统一走 reload；hard 预留
    service.reload(&sessionId).await.map_err(map_err)
}

/// `sessionId` 省略时返回当前活跃 session（若有）
#[tauri::command]
#[allow(non_snake_case)]
pub async fn browser_get_state(
    service: State<'_, Arc<BrowserService>>,
    sessionId: Option<String>,
) -> CmdResult<Option<BrowserSessionState>> {
    match sessionId {
        Some(id) => service.get_state(&id).map(Some).map_err(map_err),
        None => Ok(service.get_active_state()),
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
    let id = match sessionId {
        Some(id) => id,
        None => service
            .get_active_state()
            .map(|s| s.id)
            .ok_or_else(|| "NOT_FOUND: no active browser session".to_string())?,
    };
    service.focus(&id).await.map_err(map_err)
}

/// 用户接管：打断 agent 控制态（design §2）
#[tauri::command]
pub async fn browser_take_over(
    service: State<'_, Arc<BrowserService>>,
) -> CmdResult<BrowserSessionState> {
    service.take_over().map_err(map_err)
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
