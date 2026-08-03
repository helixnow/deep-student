//! Tauri commands for the plugin system.

use serde_json::Value;
use tauri::State;

use crate::models::AppError;

use super::manager::PluginManager;
use super::types::{PluginInfo, PluginState, PluginStatusSnapshot};

#[tauri::command]
pub async fn plugin_list(manager: State<'_, PluginManager>) -> Result<Vec<PluginInfo>, AppError> {
    manager.list().await
}

#[tauri::command]
pub async fn plugin_start(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginState, AppError> {
    manager.start(&id).await
}

#[tauri::command]
pub async fn plugin_stop(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginState, AppError> {
    manager.stop(&id).await
}

#[tauri::command]
pub async fn plugin_get_status(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginStatusSnapshot, AppError> {
    manager.get_status(&id).await
}

#[tauri::command]
pub async fn plugin_get_config(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<Value, AppError> {
    manager.get_config(&id).await
}

#[tauri::command]
pub async fn plugin_set_config(
    id: String,
    patch: Value,
    manager: State<'_, PluginManager>,
) -> Result<(), AppError> {
    manager.set_config(&id, patch).await
}

#[tauri::command]
pub async fn plugin_set_enabled(
    id: String,
    enabled: bool,
    manager: State<'_, PluginManager>,
) -> Result<(), AppError> {
    manager.set_enabled(&id, enabled).await
}

#[tauri::command]
pub async fn plugin_begin_login(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<(), AppError> {
    manager.begin_login(&id).await
}

#[tauri::command]
pub async fn plugin_cancel_login(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<(), AppError> {
    manager.cancel_login(&id).await
}

#[tauri::command]
pub async fn plugin_logout(id: String, manager: State<'_, PluginManager>) -> Result<(), AppError> {
    manager.logout(&id).await
}

#[tauri::command]
pub async fn plugin_unbind(id: String, manager: State<'_, PluginManager>) -> Result<(), AppError> {
    manager.logout(&id).await
}
