use std::collections::HashMap;
use std::sync::Arc;

use std::sync::LazyLock;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use tauri::{Emitter, Window};

use super::config::McpFraming;
use super::global::create_stdio_transport;
use super::transport::Transport;
use super::types::McpError;

struct StdioTransportHandle {
    transport: Arc<dyn Transport + Send + Sync>,
    reader_task: JoinHandle<()>,
}

static STDIO_SESSIONS: LazyLock<Mutex<HashMap<String, StdioTransportHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn framing_from_str(value: Option<&str>) -> McpFraming {
    match value.map(|v| v.to_lowercase()).as_deref() {
        Some("jsonl") | Some("json_lines") | Some("json-lines") => McpFraming::JsonLines,
        _ => McpFraming::ContentLength,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn start_stdio_session(
    window: Window,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    framing: Option<String>,
    cwd: Option<String>,
) -> Result<String, McpError> {
    if command.trim().is_empty() {
        return Err(McpError::TransportError(
            "Stdio MCP 需要指定 command".into(),
        ));
    }
    use uuid::Uuid;

    let framing = framing_from_str(framing.as_deref());
    let mut normalized_args = Vec::new();
    for arg in args {
        if !arg.is_empty() {
            normalized_args.push(arg);
        }
    }

    let working_dir = cwd.map(std::path::PathBuf::from);

    let transport = create_stdio_transport(
        &command,
        &normalized_args,
        &framing,
        &env,
        working_dir.as_ref(),
    )
    .await?; // returns ProcessStdioTransport implementing Transport

    let transport = Arc::new(transport) as Arc<dyn Transport + Send + Sync>;
    let session_id = Uuid::new_v4().to_string();
    let event_prefix = format!("mcp-stdio-{}", session_id);
    let emitter = window.clone();
    let transport_clone = transport.clone();

    let session_id_for_reader = session_id.clone();
    let reader_task = tokio::spawn(async move {
        loop {
            let message = transport_clone.receive().await;
            match message {
                Ok(payload) => {
                    let _ = emitter.emit(
                        &format!("{}-message", event_prefix),
                        &serde_json::json!({ "message": payload }),
                    );
                }
                Err(err) => {
                    let _ = emitter.emit(
                        &format!("{}-error", event_prefix),
                        &serde_json::json!({ "error": err.to_string() }),
                    );
                    break;
                }
            }
        }
        // 自动清理会话，避免依赖前端必须调用 mcp_stdio_close
        if let Some(handle) = STDIO_SESSIONS.lock().await.remove(&session_id_for_reader) {
            let _ = handle.transport.close().await;
            log::info!("MCP stdio session {} auto-cleaned after reader exit", session_id_for_reader);
        }
        let _ = emitter.emit(&format!("{}-closed", event_prefix), &serde_json::json!({}));
    });

    STDIO_SESSIONS.lock().await.insert(
        session_id.clone(),
        StdioTransportHandle {
            transport,
            reader_task,
        },
    );

    Ok(session_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn send_stdio_message(session_id: &str, message: &str) -> Result<(), McpError> {
    if let Some(handle) = STDIO_SESSIONS.lock().await.get(session_id) {
        handle.transport.send(message).await
    } else {
        Err(McpError::TransportError(format!(
            "Unknown session: {}",
            session_id
        )))
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn close_stdio_session(session_id: &str) -> Result<(), McpError> {
    if let Some(handle) = STDIO_SESSIONS.lock().await.remove(session_id) {
        let _ = handle.transport.close().await;
        handle.reader_task.abort();
    }
    // 会话可能已被 reader_task 自动清理，静默返回 Ok
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn start_stdio_session(
    _window: Window,
    _command: String,
    _args: Vec<String>,
    _env: HashMap<String, String>,
    _framing: Option<String>,
    _cwd: Option<String>,
) -> Result<String, McpError> {
    Err(McpError::TransportError(
        "Stdio MCP transport is not supported on this platform".into(),
    ))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn send_stdio_message(_session_id: &str, _message: &str) -> Result<(), McpError> {
    Err(McpError::TransportError(
        "Stdio MCP transport is not supported on this platform".into(),
    ))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn close_stdio_session(_session_id: &str) -> Result<(), McpError> {
    Err(McpError::TransportError(
        "Stdio MCP transport is not supported on this platform".into(),
    ))
}
