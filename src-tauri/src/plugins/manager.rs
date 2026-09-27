//! Plugin manager: lifecycle, state machine, compile-time registry.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::background_tasks::BACKGROUND_TASKS;
use crate::commands::AppState;
use crate::database::Database;
use crate::models::AppError;

use super::events;
use super::ilink_bot::IlinkBotPlugin;
use super::types::{
    ChannelPlugin, PluginInfo, PluginRuntimeCtx, PluginState, PluginStatusSnapshot,
};

struct RunningHandle {
    cancel: CancellationToken,
    generation: u64,
}

pub struct PluginManager {
    plugins: HashMap<String, Arc<dyn ChannelPlugin>>,
    handles: RwLock<HashMap<String, RunningHandle>>,
    states: RwLock<HashMap<String, PluginState>>,
    errors: RwLock<HashMap<String, String>>,
    next_generation: AtomicU64,
    lifecycle: Mutex<()>,
    app: AppHandle,
}

impl PluginManager {
    pub fn new(app: AppHandle) -> Self {
        let mut plugins: HashMap<String, Arc<dyn ChannelPlugin>> = HashMap::new();
        let ilink = Arc::new(IlinkBotPlugin::new());
        plugins.insert(ilink.descriptor().id.to_string(), ilink);

        let mut states = HashMap::new();
        for id in plugins.keys() {
            states.insert(id.clone(), PluginState::Stopped);
        }

        Self {
            plugins,
            handles: RwLock::new(HashMap::new()),
            states: RwLock::new(states),
            errors: RwLock::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            app,
        }
    }

    fn plugin(&self, id: &str) -> Result<Arc<dyn ChannelPlugin>, AppError> {
        self.plugins
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::validation(format!("未知插件: {}", id)))
    }

    pub async fn set_state(&self, id: &str, state: PluginState, error: Option<String>) {
        {
            let mut states = self.states.write().await;
            let current = states.get(id).copied().unwrap_or(PluginState::Stopped);
            if !current.can_transition_to(state) && current != state {
                tracing::debug!(
                    "[plugins] unusual transition {:?} -> {:?} for {}",
                    current,
                    state,
                    id
                );
            }
            states.insert(id.to_string(), state);
        }
        {
            let mut errors = self.errors.write().await;
            if let Some(err) = error.clone() {
                errors.insert(id.to_string(), err);
            } else if matches!(
                state,
                PluginState::Running | PluginState::Stopped | PluginState::WaitingLogin
            ) {
                errors.remove(id);
            }
        }
        events::emit_state(&self.app, id, state, error);
    }

    pub async fn current_state(&self, id: &str) -> PluginState {
        self.states
            .read()
            .await
            .get(id)
            .copied()
            .unwrap_or(PluginState::Stopped)
    }

    async fn enabled_flag(database: &Database, plugin_id: &str) -> bool {
        let key = format!("plugin.{}.enabled", plugin_id.replace('-', ""));
        // Prefer canonical settings keys; ilink uses plugin.ilinkbot.enabled
        let alt = if plugin_id == "ilinkbot" {
            "plugin.ilinkbot.enabled".to_string()
        } else {
            key.clone()
        };
        database
            .get_setting(&alt)
            .ok()
            .flatten()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false)
    }

    pub async fn list(&self) -> Result<Vec<PluginInfo>, AppError> {
        let app_state = self.app.state::<AppState>();
        let database = &app_state.database;
        let mut out = Vec::new();
        for (id, plugin) in &self.plugins {
            let desc = plugin.descriptor();
            let state = self.current_state(id).await;
            let config = plugin.get_public_config(database).await.unwrap_or_default();
            let enabled = Self::enabled_flag(database, id).await;
            let configured = plugin.is_configured(&config);
            let bound = plugin.is_bound(database).await;
            let error = self.errors.read().await.get(id).cloned();
            out.push(PluginInfo {
                id: desc.id.to_string(),
                label: desc.label.to_string(),
                blurb: desc.blurb.to_string(),
                kind: desc.kind,
                state,
                enabled,
                configured,
                bound,
                error,
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    pub async fn get_status(&self, id: &str) -> Result<PluginStatusSnapshot, AppError> {
        let plugin = self.plugin(id)?;
        let app_state = self.app.state::<AppState>();
        let mut snap = plugin.status(&app_state.database).await;
        snap.state = self.current_state(id).await;
        if let Some(err) = self.errors.read().await.get(id) {
            snap.last_error = Some(err.clone());
        }
        Ok(snap)
    }

    pub async fn start(&self, id: &str) -> Result<PluginState, AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        if cfg!(any(target_os = "android", target_os = "ios")) {
            return Err(AppError::validation("插件仅支持桌面端"));
        }
        let plugin = self.plugin(id)?;
        let current = self.current_state(id).await;
        if matches!(
            current,
            PluginState::Running | PluginState::Starting | PluginState::WaitingLogin
        ) {
            return Ok(current);
        }

        // Stop any leftover handle first
        self.stop_internal(id).await;

        let cancel = CancellationToken::new();
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut handles = self.handles.write().await;
            handles.insert(
                id.to_string(),
                RunningHandle {
                    cancel: cancel.clone(),
                    generation,
                },
            );
        }

        self.set_state(id, PluginState::Starting, None).await;

        let app_state = self.app.state::<AppState>();
        let config = plugin
            .get_public_config(&app_state.database)
            .await
            .unwrap_or_default();
        let ctx =
            PluginRuntimeCtx::from_app_state(self.app.clone(), &app_state, cancel.clone(), config);

        let manager_app = self.app.clone();
        let plugin_id = id.to_string();
        let plugin_clone = plugin.clone();

        BACKGROUND_TASKS.spawn(async move {
            let result = plugin_clone.run(ctx).await;
            let manager = manager_app.state::<PluginManager>();
            let is_current = {
                let mut handles = manager.handles.write().await;
                if handles
                    .get(&plugin_id)
                    .is_some_and(|handle| handle.generation == generation)
                {
                    handles.remove(&plugin_id);
                    true
                } else {
                    false
                }
            };
            // A stopped run may finish after a new run has already started.
            // Its completion must not remove or overwrite the new run.
            if !is_current {
                return;
            }
            match result {
                Ok(()) => {
                    manager
                        .set_state(&plugin_id, PluginState::Stopped, None)
                        .await;
                }
                Err(e) => {
                    let msg = e.to_string();
                    manager
                        .set_state(&plugin_id, PluginState::Error, Some(msg))
                        .await;
                }
            }
        });

        Ok(PluginState::Starting)
    }

    async fn stop_internal(&self, id: &str) {
        let handle = {
            let mut handles = self.handles.write().await;
            handles.remove(id)
        };
        if let Some(h) = handle {
            self.set_state(id, PluginState::Stopping, None).await;
            h.cancel.cancel();
        }
    }

    pub async fn stop(&self, id: &str) -> Result<PluginState, AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        let _ = self.plugin(id)?;
        self.stop_internal(id).await;
        // Give run loop a moment; state will settle via task completion or force stopped
        let state = self.current_state(id).await;
        if matches!(
            state,
            PluginState::Stopping
                | PluginState::Starting
                | PluginState::WaitingLogin
                | PluginState::Running
        ) {
            self.set_state(id, PluginState::Stopped, None).await;
        }
        Ok(PluginState::Stopped)
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let _ = self.plugin(id)?;
        let app_state = self.app.state::<AppState>();
        let key = if id == "ilinkbot" {
            "plugin.ilinkbot.enabled"
        } else {
            return Err(AppError::validation("unsupported plugin"));
        };
        app_state
            .database
            .save_setting(key, if enabled { "true" } else { "false" })
            .map_err(|e| AppError::database(format!("保存 enabled 失败: {}", e)))?;
        if enabled {
            let _ = self.start(id).await?;
        } else {
            let _ = self.stop(id).await?;
        }
        Ok(())
    }

    pub async fn get_config(&self, id: &str) -> Result<serde_json::Value, AppError> {
        let plugin = self.plugin(id)?;
        let app_state = self.app.state::<AppState>();
        plugin.get_public_config(&app_state.database).await
    }

    pub async fn set_config(&self, id: &str, patch: serde_json::Value) -> Result<(), AppError> {
        let plugin = self.plugin(id)?;
        let app_state = self.app.state::<AppState>();
        plugin.set_config(&app_state.database, patch).await
    }

    pub async fn begin_login(&self, id: &str) -> Result<(), AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        if cfg!(any(target_os = "android", target_os = "ios")) {
            return Err(AppError::validation("插件仅支持桌面端"));
        }
        let plugin = self.plugin(id)?;
        if matches!(
            self.current_state(id).await,
            PluginState::Starting | PluginState::WaitingLogin | PluginState::Running
        ) {
            return Ok(());
        }
        // Ensure a cancel token exists for login loop
        let (cancel, generation) = {
            let mut handles = self.handles.write().await;
            if handles.contains_key(id) {
                // A lifecycle operation already owns the existing handle. A
                // second login request must not share its token or generation
                // with the first background login flow.
                return Ok(());
            } else {
                let c = CancellationToken::new();
                let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
                handles.insert(
                    id.to_string(),
                    RunningHandle {
                        cancel: c.clone(),
                        generation,
                    },
                );
                (c, generation)
            }
        };
        self.set_state(id, PluginState::WaitingLogin, None).await;
        let app_state = self.app.state::<AppState>();
        let config = plugin
            .get_public_config(&app_state.database)
            .await
            .unwrap_or_default();
        let ctx = PluginRuntimeCtx::from_app_state(self.app.clone(), &app_state, cancel, config);
        let manager_app = self.app.clone();
        let plugin_id = id.to_string();
        BACKGROUND_TASKS.spawn(async move {
            let manager = manager_app.state::<PluginManager>();
            let plugin = match manager.plugin(&plugin_id) {
                Ok(p) => p,
                Err(e) => {
                    manager
                        .set_state(&plugin_id, PluginState::Error, Some(e.to_string()))
                        .await;
                    return;
                }
            };
            match plugin.begin_login(ctx).await {
                Ok(()) => {
                    let is_current = {
                        let mut handles = manager.handles.write().await;
                        if handles
                            .get(&plugin_id)
                            .is_some_and(|handle| handle.generation == generation)
                        {
                            handles.remove(&plugin_id);
                            true
                        } else {
                            false
                        }
                    };
                    if !is_current {
                        return;
                    }
                    let app_state = manager_app.state::<AppState>();
                    // Cancellation and duplicate login flows return Ok(()) without
                    // persisted credentials. Only confirmed QR login activates polling.
                    if !plugin.is_bound(&app_state.database).await {
                        manager
                            .set_state(&plugin_id, PluginState::Stopped, None)
                            .await;
                        return;
                    }
                    // Scanning is the single activation action: bind, enable, then start polling.
                    if let Err(e) = app_state
                        .database
                        .save_setting("plugin.ilinkbot.enabled", "true")
                    {
                        manager
                            .set_state(
                                &plugin_id,
                                PluginState::Error,
                                Some(format!("保存启用状态失败: {}", e)),
                            )
                            .await;
                        return;
                    }
                    let _ = manager.start(&plugin_id).await;
                }
                Err(e) => {
                    let is_current = {
                        let mut handles = manager.handles.write().await;
                        if handles
                            .get(&plugin_id)
                            .is_some_and(|handle| handle.generation == generation)
                        {
                            handles.remove(&plugin_id);
                            true
                        } else {
                            false
                        }
                    };
                    if !is_current {
                        return;
                    }
                    manager
                        .set_state(&plugin_id, PluginState::Error, Some(e.to_string()))
                        .await;
                }
            }
        });
        Ok(())
    }

    pub async fn cancel_login(&self, id: &str) -> Result<(), AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        let plugin = self.plugin(id)?;
        plugin.cancel_login().await?;
        self.stop_internal(id).await;
        self.set_state(id, PluginState::Stopped, None).await;
        Ok(())
    }

    pub async fn logout(&self, id: &str) -> Result<(), AppError> {
        let _lifecycle = self.lifecycle.lock().await;
        let plugin = self.plugin(id)?;
        self.stop_internal(id).await;
        let state = self.current_state(id).await;
        if matches!(
            state,
            PluginState::Stopping
                | PluginState::Starting
                | PluginState::WaitingLogin
                | PluginState::Running
        ) {
            self.set_state(id, PluginState::Stopped, None).await;
        }
        let app_state = self.app.state::<AppState>();
        plugin.logout(&app_state.database).await?;
        app_state
            .database
            .save_setting("plugin.ilinkbot.enabled", "false")
            .map_err(|e| AppError::database(format!("重置启用状态失败: {}", e)))?;
        self.set_state(id, PluginState::Stopped, None).await;
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        let ids: Vec<String> = self.plugins.keys().cloned().collect();
        for id in ids {
            self.stop_internal(&id).await;
        }
    }

    /// Auto-start bound plugins after app setup.
    pub async fn bootstrap_enabled(&self) {
        if cfg!(any(target_os = "android", target_os = "ios")) {
            return;
        }
        let list = match self.list().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("[plugins] bootstrap list failed: {}", e);
                return;
            }
        };
        for info in list {
            if info.bound {
                let setting = self
                    .app
                    .state::<AppState>()
                    .database
                    .get_setting("plugin.ilinkbot.enabled")
                    .ok()
                    .flatten();
                if matches!(setting.as_deref(), Some("false" | "0")) {
                    continue;
                }
                // Migrate bindings created before the enabled setting existed,
                // while respecting an explicit user pause.
                if setting.is_none() {
                    let _ = self
                        .app
                        .state::<AppState>()
                        .database
                        .save_setting("plugin.ilinkbot.enabled", "true");
                }
                if let Err(e) = self.start(&info.id).await {
                    tracing::warn!("[plugins] auto-start {} failed: {}", info.id, e);
                }
            }
        }
    }
}
