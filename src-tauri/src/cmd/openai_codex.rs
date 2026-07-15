use crate::llm_manager::LLMManager;
use crate::openai_codex::{CodexAuthStatus, CodexUsageSnapshot};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

fn command_error(error: impl std::fmt::Display) -> String {
    log::warn!("[OpenAI Codex OAuth] command failed: {}", error);
    "OpenAI Codex authentication request failed".to_string()
}

#[tauri::command]
pub async fn openai_codex_auth_status(
    manager: State<'_, Arc<LLMManager>>,
) -> Result<CodexAuthStatus, String> {
    Ok(manager.openai_codex_auth().status().await)
}

#[tauri::command]
pub async fn openai_codex_login_start(
    manager: State<'_, Arc<LLMManager>>,
    flow: String,
) -> Result<Value, String> {
    let auth = manager.openai_codex_auth();
    match flow.as_str() {
        "browser" => serde_json::to_value(auth.start_browser_login().await.map_err(command_error)?)
            .map_err(command_error),
        "device_code" | "device" => {
            serde_json::to_value(auth.start_device_login().await.map_err(command_error)?)
                .map_err(command_error)
        }
        _ => Err("Unsupported OpenAI Codex login flow".to_string()),
    }
}

#[tauri::command]
pub async fn openai_codex_login_cancel(
    manager: State<'_, Arc<LLMManager>>,
    attempt_id: String,
) -> Result<(), String> {
    manager
        .openai_codex_auth()
        .cancel_login(&attempt_id)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn openai_codex_logout(manager: State<'_, Arc<LLMManager>>) -> Result<(), String> {
    manager
        .openai_codex_auth()
        .logout()
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn openai_codex_usage(
    manager: State<'_, Arc<LLMManager>>,
) -> Result<CodexUsageSnapshot, String> {
    manager
        .openai_codex_auth()
        .usage_snapshot()
        .await
        .map_err(command_error)
}
