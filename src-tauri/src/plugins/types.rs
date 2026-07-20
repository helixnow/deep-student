//! Shared plugin types and ChannelPlugin trait.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::database::Database;
use crate::llm_manager::LLMManager;
use crate::models::AppError;

pub type PluginId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    #[default]
    Stopped,
    Starting,
    WaitingLogin,
    Running,
    Stopping,
    Error,
}

impl PluginState {
    pub fn can_transition_to(self, next: PluginState) -> bool {
        use PluginState::*;
        matches!(
            (self, next),
            (Stopped, Starting)
                | (Starting, WaitingLogin)
                | (Starting, Running)
                | (Starting, Error)
                | (Starting, Stopping)
                | (WaitingLogin, Running)
                | (WaitingLogin, Stopping)
                | (WaitingLogin, Stopped)
                | (WaitingLogin, Error)
                | (WaitingLogin, Starting)
                | (Running, Stopping)
                | (Running, Error)
                | (Running, WaitingLogin)
                | (Stopping, Stopped)
                | (Stopping, Error)
                | (Error, Starting)
                | (Error, Stopping)
                | (Error, Stopped)
                | (Stopped, Stopped)
                | (Stopping, Stopping)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub kind: PluginKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub label: String,
    pub blurb: String,
    pub kind: PluginKind,
    pub state: PluginState,
    pub enabled: bool,
    pub configured: bool,
    pub bound: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusSnapshot {
    pub state: PluginState,
    pub enabled: bool,
    pub configured: bool,
    pub bound: bool,
    pub login_status: Option<String>,
    pub account_id: Option<String>,
    pub user_id: Option<String>,
    pub last_error: Option<String>,
    pub last_activity: Option<String>,
    pub qrcode_png_base64: Option<String>,
    pub qrcode_status: Option<String>,
}

#[derive(Clone)]
pub struct PluginRuntimeCtx {
    pub app: AppHandle,
    pub database: Arc<Database>,
    pub llm: Arc<LLMManager>,
    pub cancel: CancellationToken,
    pub config: Value,
}

impl PluginRuntimeCtx {
    pub fn from_app_state(
        app: AppHandle,
        state: &AppState,
        cancel: CancellationToken,
        config: Value,
    ) -> Self {
        Self {
            app,
            database: state.database.clone(),
            llm: state.llm_manager.clone(),
            cancel,
            config,
        }
    }
}

#[async_trait]
pub trait ChannelPlugin: Send + Sync {
    fn descriptor(&self) -> &PluginDescriptor;

    fn is_configured(&self, config: &Value) -> bool;

    async fn is_bound(&self, database: &Database) -> bool;

    async fn run(&self, ctx: PluginRuntimeCtx) -> Result<(), AppError>;

    async fn status(&self, database: &Database) -> PluginStatusSnapshot;

    async fn get_public_config(&self, database: &Database) -> Result<Value, AppError>;

    async fn set_config(&self, database: &Database, patch: Value) -> Result<(), AppError>;

    /// Optional: start QR login without full run loop.
    async fn begin_login(&self, ctx: PluginRuntimeCtx) -> Result<(), AppError> {
        let _ = ctx;
        Err(AppError::validation("该插件不支持扫码登录"))
    }

    async fn cancel_login(&self) -> Result<(), AppError> {
        Ok(())
    }

    async fn logout(&self, database: &Database) -> Result<(), AppError> {
        let _ = database;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_state_defaults_to_stopped() {
        assert_eq!(PluginState::default(), PluginState::Stopped);
    }
}
