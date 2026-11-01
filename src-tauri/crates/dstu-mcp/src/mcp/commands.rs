//! MCP OAuth Tauri 命令
#![cfg(not(target_os = "android"))]

use super::auth::{get_auth_manager, StartOAuthOutcome, StartOAuthParams};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct McpOAuthStatus {
    pub server_id: String,
    pub authorized: bool,
}

/// 启动 MCP OAuth 2.1 桌面授权流（阻塞至完成 / 超时 / 取消）
#[tauri::command]
pub async fn start_mcp_oauth(
    app: AppHandle,
    server_id: String,
    resource_url: String,
    client_id: Option<String>,
    client_secret: Option<String>,
    scopes: Option<Vec<String>>,
) -> Result<StartOAuthOutcome, String> {
    let manager = get_auth_manager();
    if let Ok(dir) = app.path().app_data_dir() {
        manager.attach_secure_store_dir(dir).await;
    }

    manager
        .start_oauth(StartOAuthParams {
            server_id,
            resource_url,
            client_id,
            client_secret,
            scopes: scopes.unwrap_or_default(),
            open_browser: true,
            timeout: None,
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_mcp_oauth(server_id: String) -> Result<(), String> {
    get_auth_manager().cancel_oauth(&server_id).await;
    Ok(())
}

#[tauri::command]
pub async fn revoke_mcp_oauth(app: AppHandle, server_id: String) -> Result<(), String> {
    let manager = get_auth_manager();
    if let Ok(dir) = app.path().app_data_dir() {
        manager.attach_secure_store_dir(dir).await;
    }
    manager
        .revoke_token(&server_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mcp_oauth_status(
    app: AppHandle,
    server_id: String,
    resource_url: String,
) -> Result<McpOAuthStatus, String> {
    let manager = get_auth_manager();
    if let Ok(dir) = app.path().app_data_dir() {
        manager.attach_secure_store_dir(dir).await;
    }
    let authorized = manager
        .has_oauth_session_for_resource(&server_id, &resource_url)
        .await;
    Ok(McpOAuthStatus {
        server_id,
        authorized,
    })
}

/// 供前端连接路径注入 Bearer（不返回 refresh_token）
#[tauri::command]
pub async fn get_mcp_oauth_access_token(
    app: AppHandle,
    server_id: String,
    resource_url: String,
) -> Result<Option<String>, String> {
    let manager = get_auth_manager();
    if let Ok(dir) = app.path().app_data_dir() {
        manager.attach_secure_store_dir(dir).await;
    }
    match manager
        .get_bearer_token_for_resource(&server_id, &resource_url)
        .await
    {
        Ok(token) => Ok(Some(token)),
        Err(_) => Ok(None),
    }
}
