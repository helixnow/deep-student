//! BrowserService — 一期单 session 运行时
//!
//! - 持 [`AppHandle`]；lazy 依赖 [`BrowserDatabase`]（首次 open 才 `ensure_open`）
//! - Content 窗 label 固定 [`BROWSER_CONTENT_LABEL`]
//! - 双闸：settings（`desktop.workbenchMode` 缺失默认开 + `desktop.workbenchBrowserEnabled` opt-in）
//!   + feature flag `ui.workbench_browser`
//!
//! B1d 接线：`window::bridge_init_script` / 后续 `BridgeClient` 方法挂本服务。
//! B1e 接线：commands 调本服务公开方法；setup 中 `manage(Arc<BrowserService>)` + `boot_cleanup`。

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use tauri::WindowEvent;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect};
use tracing::{debug, info, warn};
use url::Url;
use uuid::Uuid;

use crate::chat_v2::runtime_roots::artifact_root;
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, TaskObjectHandle, TaskObjectKind,
};
use crate::commands::AppState;
use crate::feature_flags::FeatureFlagManager;

use super::database::BrowserDatabase;
use super::error::{BrowserError, BrowserResult};
use super::events::{
    emit_closed, emit_content_user_input, emit_control_mode_changed, emit_navigated,
    emit_navigation_blocked, emit_title_changed, now_rfc3339, BrowserClosedPayload,
    BrowserContentUserInputPayload, BrowserControlModeChangedPayload, BrowserNavigatedPayload,
    BrowserNavigationBlockedPayload, BrowserTitleChangedPayload,
};
use super::policy::{self, NavigationDenyReason};
use super::repository::BrowserRepository;
use super::session::{BrowserSession, BrowserSessionState, HistoryEntry, OpenSessionOptions};
use super::types::{BrowserHistoryPush, BrowserSessionUpsert};
use super::window::{
    self, boot_cleanup_orphan_windows, ContentWindowHooks, ContentWindowOptions,
    NavigationPolicyHandle, BROWSER_CONTENT_LABEL, DEFAULT_HEIGHT, DEFAULT_PROFILE_ID,
    DEFAULT_WIDTH,
};

/// 用户设置：Workbench 父闸
pub const SETTING_WORKBENCH_MODE: &str = "desktop.workbenchMode";
/// 用户设置：Browser 子闸
pub const SETTING_BROWSER_ENABLED: &str = "desktop.workbenchBrowserEnabled";
/// 用户设置：网络模式（影响 http 是否放行非 loopback）
pub const SETTING_BROWSER_NETWORK_MODE: &str = "desktop.workbenchBrowserNetworkMode";
/// 硬闸 feature flag
pub const FLAG_UI_WORKBENCH_BROWSER: &str = "ui.workbench_browser";

const TRUSTED_CONTENT_INPUT_KINDS: &[&str] =
    &["pointerdown", "keydown", "compositionstart", "wheel"];
const MAX_SURFACE_OCCLUSIONS: usize = 64;
const MAX_DOWNLOAD_OBSERVATIONS: usize = 100;
const MAX_BROWSER_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BROWSER_TASK_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserDownloadState {
    Started,
    Processing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadObservation {
    pub id: String,
    pub browser_session_id: String,
    pub chat_session_id: String,
    pub url: String,
    pub filename: String,
    pub state: BrowserDownloadState,
    pub root_id: String,
    pub relative_path: String,
    pub locator: String,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub object_handle: Option<TaskObjectHandle>,
}

#[derive(Default)]
struct BrowserDownloadRuntime {
    observations: VecDeque<BrowserDownloadObservation>,
    by_path: HashMap<PathBuf, String>,
    task_completed_bytes: HashMap<String, u64>,
    task_reserved_bytes: HashMap<String, u64>,
}

struct TrustedContentInputCapability {
    session_id: String,
    nonce: [u8; 16],
}

#[derive(Debug, Clone)]
struct BlockedNavigation {
    url: String,
    reason: String,
}

#[derive(Debug, Clone, Copy)]
enum PendingNavigationKind {
    Push,
    Replace,
}

#[derive(Debug)]
struct PendingNavigation {
    id: u64,
    session_id: String,
    rollback: BrowserSession,
    kind: PendingNavigationKind,
    blocked: Mutex<Option<BlockedNavigation>>,
}

impl PendingNavigation {
    fn blocked(&self) -> Option<BlockedNavigation> {
        self.blocked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn mark_blocked(&self, url: String, reason: String) {
        let mut blocked = self
            .blocked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if blocked.is_none() {
            *blocked = Some(BlockedNavigation { url, reason });
        }
    }
}

#[derive(Default)]
struct NavigationRuntime {
    sequence: u64,
    pending: Option<Arc<PendingNavigation>>,
}

impl TrustedContentInputCapability {
    fn generate(session_id: String) -> Self {
        let mut nonce = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce);
        Self { session_id, nonce }
    }

    fn encoded_nonce(&self) -> String {
        hex::encode(self.nonce)
    }

    fn matches(&self, session_id: &str, encoded_nonce: &str) -> bool {
        if self.session_id != session_id {
            return false;
        }
        let mut candidate = [0_u8; 16];
        if hex::decode_to_slice(encoded_nonce, &mut candidate).is_err() {
            return false;
        }
        constant_time_eq(&self.nonce, &candidate)
    }
}

fn constant_time_eq(expected: &[u8; 16], candidate: &[u8; 16]) -> bool {
    expected
        .iter()
        .zip(candidate)
        .fold(0_u8, |difference, (left, right)| {
            difference | (*left ^ *right)
        })
        == 0
}

/// 内置浏览器运行时服务（一期全局 0..1 session）
pub struct BrowserService {
    app: AppHandle,
    /// Lazy：构造时可不打开；`open_session` 内 `ensure_open`
    db: Arc<BrowserDatabase>,
    session: Mutex<Option<BrowserSession>>,
    /// Acquired before `session` when both are needed.
    trusted_content_input: Mutex<Option<TrustedContentInputCapability>>,
    navigation_policy: NavigationPolicyHandle,
    navigation_runtime: Mutex<NavigationRuntime>,
    /// Last successfully applied surface update. Prevents async IPC responses
    /// from moving the native surface back to stale DOM coordinates.
    /// When both runtime locks are needed, acquire this before `session`.
    surface_sequence: Mutex<Option<u64>>,
    downloads: Mutex<BrowserDownloadRuntime>,
}

impl BrowserService {
    /// 使用已解析的 [`BrowserDatabase`]（通常尚未 `ensure_open`）
    pub fn new(app: AppHandle, db: Arc<BrowserDatabase>) -> Arc<Self> {
        Arc::new(Self {
            app,
            db,
            session: Mutex::new(None),
            trusted_content_input: Mutex::new(None),
            navigation_policy: NavigationPolicyHandle::new(),
            navigation_runtime: Mutex::new(NavigationRuntime::default()),
            surface_sequence: Mutex::new(None),
            downloads: Mutex::new(BrowserDownloadRuntime::default()),
        })
    }

    /// 从 DataSpace 解析 active_dir 并构造（不建库）
    pub fn from_data_space(app: AppHandle) -> BrowserResult<Arc<Self>> {
        let db = Arc::new(BrowserDatabase::from_data_space()?);
        Ok(Self::new(app, db))
    }

    pub fn app_handle(&self) -> &AppHandle {
        &self.app
    }

    pub fn database(&self) -> &Arc<BrowserDatabase> {
        &self.db
    }

    /// 启动清理：关掉残留 `browser-content` 孤儿窗（不触碰 DB）
    pub fn boot_cleanup(app: &AppHandle) {
        boot_cleanup_orphan_windows(app);
    }

    // ------------------------------------------------------------------
    // 双闸
    // ------------------------------------------------------------------

    /// settings 父闸+子闸 且 feature flag 硬闸均开启
    ///
    /// 父闸 `desktop.workbenchMode` 与前端 `interpretWorkbenchModeEnabled` /
    /// `resolveBrowserGates` 对齐：键缺失（或非法值）默认 enabled，仅显式
    /// `"false"` 关闭。子闸 `desktop.workbenchBrowserEnabled` 仍为 opt-in
    ///（缺失 → 关闭）。
    pub async fn assert_gates_open(&self) -> BrowserResult<()> {
        let app_state = self
            .app
            .try_state::<AppState>()
            .ok_or_else(|| BrowserError::Validation("AppState not available".into()))?;

        let workbench = app_state
            .database
            .get_setting(SETTING_WORKBENCH_MODE)
            .map_err(|e| BrowserError::Database(e.to_string()))?;
        let enabled = app_state
            .database
            .get_setting(SETTING_BROWSER_ENABLED)
            .map_err(|e| BrowserError::Database(e.to_string()))?;
        if let Err(message) = assert_settings_gates_open(workbench.as_deref(), enabled.as_deref()) {
            drop(app_state);
            return self.reject_closed_gate(message).await;
        }

        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let manager = FeatureFlagManager::new(app_version)
            .load_from_database(&app_state.database)
            .await
            .map_err(BrowserError::Validation)?;
        if !manager.is_feature_enabled(FLAG_UI_WORKBENCH_BROWSER) {
            drop(manager);
            drop(app_state);
            return self
                .reject_closed_gate("browser disabled: feature flag ui.workbench_browser is off")
                .await;
        }

        Ok(())
    }

    async fn reject_closed_gate(&self, message: &str) -> BrowserResult<()> {
        // Gate 关闭后不能留下仍可访问网络的 native content window。
        if let Some(win) = window::content_window(&self.app) {
            let _ = win.hide();
        }
        if let Err(error) = self.close_session_inner("gates_closed").await {
            warn!("[browser] gate-close cleanup failed: {}", error);
        }
        Err(BrowserError::Validation(message.to_string()))
    }

    /// 当前平台是否支持带结果回执的 Agent 浏览器桥。
    pub fn agent_automation_supported() -> bool {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }

    fn ensure_agent_automation_supported(&self) -> BrowserResult<()> {
        if Self::agent_automation_supported() {
            Ok(())
        } else {
            Err(BrowserError::Validation(
                "browser agent automation unsupported: result bridge is available on Windows and macOS only"
                    .into(),
            ))
        }
    }

    /// `desktop.workbenchBrowserNetworkMode == "full"` → 允许非 loopback http
    fn allow_insecure_http(&self) -> bool {
        let allow = match self.app.try_state::<AppState>() {
            Some(app_state) => match app_state.database.get_setting(SETTING_BROWSER_NETWORK_MODE) {
                Ok(Some(mode)) => mode.trim().eq_ignore_ascii_case("full"),
                _ => false,
            },
            None => false,
        };
        self.sync_network_mode_value(if allow { "full" } else { "local_whitelist" });
        allow
    }

    /// Keep the native navigation callback in sync with a persisted setting
    /// without rebuilding the content Webview.
    pub(crate) fn sync_network_mode_value(&self, mode: &str) {
        self.navigation_policy
            .set_agent_allow_insecure_http(mode.trim().eq_ignore_ascii_case("full"));
    }

    // ------------------------------------------------------------------
    // Session API
    // ------------------------------------------------------------------

    /// 打开（或复用）唯一 session，并确保 content 窗存在。
    pub async fn open_session(
        self: &Arc<Self>,
        options: OpenSessionOptions,
    ) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;

        let allow_http = self.allow_insecure_http();
        let from_agent = options.from_agent.unwrap_or(false);
        if from_agent {
            self.ensure_agent_automation_supported()?;
        }
        self.check_navigation_url(&options.url, allow_http, from_agent)?;

        // Lazy DB：双闸已过 → 首次建库迁移
        self.db.ensure_open()?;

        let reuse = options.reuse_existing.unwrap_or(true);
        if reuse {
            let existing_id = {
                let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
                guard.as_ref().filter(|s| s.alive).map(|s| s.id.clone())
            };
            if let Some(id) = existing_id {
                if window::content_window(&self.app).is_some() {
                    {
                        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(session) = guard.as_mut().filter(|session| session.id == id) {
                            update_reused_download_owner(
                                session,
                                from_agent,
                                options.chat_session_id.clone(),
                            );
                        }
                    }
                    if from_agent {
                        self.set_agent_control()?;
                    } else {
                        self.navigation_policy
                            .set_agent_private_network_guard(false);
                        if self.get_active_state().is_some_and(|state| {
                            state.control_mode == crate::browser::ControlMode::Agent
                        }) {
                            self.take_over_with_reason("user_navigation")?;
                        }
                    }
                    let state = self.navigate_inner(&id, &options.url, true).await?;
                    if Self::surface_host_mode() == window::SURFACE_HOST_DETACHED {
                        let _ = self.focus(&id).await;
                    }
                    return Ok(state);
                }
            }
        }

        // 若内存有死 session 或窗已丢，先清干净
        {
            let has_dead = {
                let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
                guard.as_ref().is_some()
            };
            if has_dead {
                let _ = self.close_session_inner("replaced").await;
            }
        }
        if window::content_window(&self.app).is_some() {
            let _ = window::destroy_content_window(&self.app);
        }

        let parsed = Url::parse(&options.url)
            .map_err(|e| BrowserError::Validation(format!("invalid URL: {e}")))?;

        let profile_dir = window::default_profile_dir(self.db.active_dir());
        let session_id = format!("bs_{}", Uuid::new_v4());
        let input_capability = TrustedContentInputCapability::generate(session_id.clone());
        let initialization_script =
            window::bridge_init_script_for_session(&session_id, &input_capability.encoded_nonce())
                .map_err(BrowserError::Validation)?;
        let width = options.width.unwrap_or(DEFAULT_WIDTH);
        let height = options.height.unwrap_or(DEFAULT_HEIGHT);
        let focused = options.focused.unwrap_or(true);
        let title = options
            .display_name
            .clone()
            .unwrap_or_else(|| "Browser".into());

        let session = BrowserSession::new(
            session_id.clone(),
            options.url.clone(),
            profile_dir.clone(),
            from_agent
                .then_some(options.chat_session_id.clone())
                .flatten(),
            options.display_name.clone(),
        );

        // 持久化 session 行（失败不阻断开窗，但记日志）
        if let Err(e) = BrowserRepository::upsert_session(
            &self.db,
            &BrowserSessionUpsert {
                id: session_id.clone(),
                profile_id: Some(DEFAULT_PROFILE_ID.into()),
                title: Some(title.clone()),
                current_url: Some(options.url.clone()),
                favicon_url: None,
                user_agent_override: None,
                // `push_history` appends at current + 1, so the first row starts at seq=0.
                history_index: Some(-1),
                is_active: Some(true),
                last_focused_at: Some(now_rfc3339()),
            },
        ) {
            warn!("[browser] upsert_session failed (non-fatal): {}", e);
        }
        if let Err(e) = BrowserRepository::push_history(
            &self.db,
            &session_id,
            &BrowserHistoryPush {
                url: options.url.clone(),
                title: None,
                transition: Some("typed".into()),
                typed: true,
            },
        ) {
            warn!("[browser] push_history failed (non-fatal): {}", e);
        }

        let hooks = self.make_window_hooks(session_id.clone());
        self.navigation_policy
            .set_agent_private_network_guard(from_agent);
        let _webview = window::get_or_create_content_window(
            &self.app,
            ContentWindowOptions {
                url: parsed,
                title: title.clone(),
                width,
                height,
                focused,
                profile_dir,
                navigation_policy: self.navigation_policy.clone(),
                initialization_script,
            },
            Some(hooks),
        )
        .map_err(BrowserError::Validation)?;

        *self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        {
            let mut input_guard = self
                .trusted_content_input
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let mut session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            *input_guard = Some(input_capability);
            *session_guard = Some(session.clone());
        }
        self.attach_destroy_listener(session_id.clone());

        let state = if from_agent {
            self.set_agent_control()?
        } else {
            session.snapshot()
        };
        emit_navigated(
            &self.app,
            &BrowserNavigatedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                url: state.url.clone(),
                title: state.title.clone(),
                can_go_back: state.can_go_back,
                can_go_forward: state.can_go_forward,
                loading: state.loading,
                at: now_rfc3339(),
            },
        );

        info!("[browser] open_session id={} url={}", state.id, state.url);
        Ok(state)
    }

    pub async fn close_session(&self) -> BrowserResult<()> {
        self.close_session_inner("service").await
    }

    async fn close_session_inner(&self, reason: &str) -> BrowserResult<()> {
        self.navigation_policy
            .set_agent_private_network_guard(false);
        *self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.navigation_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending = None;
        let session_id = {
            let mut input_guard = self
                .trusted_content_input
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let mut session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            *input_guard = None;
            session_guard.take().map(|mut session| {
                session.mark_closed();
                session.id
            })
        };
        let Some(session_id) = session_id else {
            // 仍尝试毁窗，避免孤儿
            return window::destroy_content_window(&self.app).map_err(BrowserError::Validation);
        };

        if self.db.is_open() {
            if let Err(e) = BrowserRepository::close_session(&self.db, &session_id) {
                warn!("[browser] close_session db: {}", e);
            }
        }

        let destroy_result =
            window::destroy_content_window(&self.app).map_err(BrowserError::Validation);

        emit_closed(
            &self.app,
            &BrowserClosedPayload {
                session_id,
                label: BROWSER_CONTENT_LABEL.into(),
                reason: reason.into(),
                at: now_rfc3339(),
            },
        );
        destroy_result
    }

    pub async fn navigate(
        &self,
        session_id: &str,
        url: &str,
        replace: bool,
    ) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
        self.navigation_policy
            .set_agent_private_network_guard(false);
        if self
            .get_active_state()
            .is_some_and(|state| state.control_mode == crate::browser::ControlMode::Agent)
        {
            self.take_over_with_reason("user_navigation")?;
        }
        let allow_http = self.allow_insecure_http();
        self.check_navigation_url(url, allow_http, false)?;
        self.navigate_inner(session_id, url, replace).await
    }

    /// Agent 导航：额外私网硬拦
    pub async fn navigate_from_agent(
        &self,
        session_id: &str,
        url: &str,
        replace: bool,
    ) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
        self.ensure_agent_automation_supported()?;
        let allow_http = self.allow_insecure_http();
        self.check_navigation_url(url, allow_http, true)?;
        self.set_agent_control()?;
        self.navigate_inner(session_id, url, replace).await
    }

    async fn navigate_inner(
        &self,
        session_id: &str,
        url: &str,
        replace: bool,
    ) -> BrowserResult<BrowserSessionState> {
        let parsed =
            Url::parse(url).map_err(|e| BrowserError::Validation(format!("invalid URL: {e}")))?;

        let win = window::content_window(&self.app)
            .ok_or_else(|| BrowserError::NotFound(format!("window {BROWSER_CONTENT_LABEL}")))?;
        self.cancel_pending_navigation(session_id);
        let rollback = {
            let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = guard
                .as_ref()
                .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
            if session.id != session_id {
                return Err(BrowserError::NotFound(format!(
                    "session {session_id} (active is {})",
                    session.id
                )));
            }
            session.clone()
        };
        let attempt = self.begin_navigation(
            rollback,
            if replace {
                PendingNavigationKind::Replace
            } else {
                PendingNavigationKind::Push
            },
        )?;
        if let Err(error) = win.navigate(parsed) {
            self.clear_navigation(attempt.id);
            return Err(BrowserError::Validation(format!(
                "navigate failed: {error}"
            )));
        }
        let state = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = self.require_session_mut(&mut guard, session_id)?;
            apply_pending_navigation(session, &attempt, url, replace).map_err(|blocked| {
                BrowserError::Validation(format!("navigation_blocked: {}", blocked.reason))
            })?
        };

        emit_navigated(
            &self.app,
            &BrowserNavigatedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                url: state.url.clone(),
                title: state.title.clone(),
                can_go_back: state.can_go_back,
                can_go_forward: state.can_go_forward,
                loading: state.loading,
                at: now_rfc3339(),
            },
        );
        Ok(state)
    }

    pub async fn back(&self, session_id: &str) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
        self.cancel_pending_navigation(session_id);
        let allow_http = self.allow_insecure_http();
        let win = window::content_window(&self.app)
            .ok_or_else(|| BrowserError::NotFound(format!("window {BROWSER_CONTENT_LABEL}")))?;
        let (url, state) = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = self.require_session_mut(&mut guard, session_id)?;
            if !session.can_go_back() {
                return Err(BrowserError::Validation("cannot go back".into()));
            }
            let target = session.history[session.history_index - 1].url.clone();
            self.check_navigation_url(
                &target,
                allow_http,
                session.control_mode == crate::browser::ControlMode::Agent,
            )?;
            let parsed = Url::parse(&target)
                .map_err(|e| BrowserError::Validation(format!("invalid URL: {e}")))?;
            win.navigate(parsed)
                .map_err(|e| BrowserError::Validation(format!("navigate failed: {e}")))?;
            let url = session.go_back().expect("can_go_back checked above");
            (url, session.snapshot())
        };
        self.persist_history_navigation(&url, &state)
    }

    pub async fn forward(&self, session_id: &str) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
        self.cancel_pending_navigation(session_id);
        let allow_http = self.allow_insecure_http();
        let win = window::content_window(&self.app)
            .ok_or_else(|| BrowserError::NotFound(format!("window {BROWSER_CONTENT_LABEL}")))?;
        let (url, state) = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = self.require_session_mut(&mut guard, session_id)?;
            if !session.can_go_forward() {
                return Err(BrowserError::Validation("cannot go forward".into()));
            }
            let target = session.history[session.history_index + 1].url.clone();
            self.check_navigation_url(
                &target,
                allow_http,
                session.control_mode == crate::browser::ControlMode::Agent,
            )?;
            let parsed = Url::parse(&target)
                .map_err(|e| BrowserError::Validation(format!("invalid URL: {e}")))?;
            win.navigate(parsed)
                .map_err(|e| BrowserError::Validation(format!("navigate failed: {e}")))?;
            let url = session.go_forward().expect("can_go_forward checked above");
            (url, session.snapshot())
        };
        self.persist_history_navigation(&url, &state)
    }

    /// WebView 接受历史导航且内存栈已更新后，持久化并发事件。
    fn persist_history_navigation(
        &self,
        url: &str,
        state: &BrowserSessionState,
    ) -> BrowserResult<BrowserSessionState> {
        if self.db.is_open() {
            let _ = BrowserRepository::upsert_session(
                &self.db,
                &BrowserSessionUpsert {
                    id: state.id.clone(),
                    profile_id: None,
                    title: Some(state.title.clone()),
                    current_url: Some(url.to_string()),
                    favicon_url: None,
                    user_agent_override: None,
                    history_index: Some(state.history_index as i64),
                    is_active: Some(true),
                    last_focused_at: None,
                },
            );
        }

        emit_navigated(
            &self.app,
            &BrowserNavigatedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                url: state.url.clone(),
                title: state.title.clone(),
                can_go_back: state.can_go_back,
                can_go_forward: state.can_go_forward,
                loading: state.loading,
                at: now_rfc3339(),
            },
        );
        Ok(state.clone())
    }

    pub async fn reload(&self, session_id: &str) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
        self.cancel_pending_navigation(session_id);
        let allow_http = self.allow_insecure_http();
        let win = window::content_window(&self.app)
            .ok_or_else(|| BrowserError::NotFound(format!("window {BROWSER_CONTENT_LABEL}")))?;
        let state = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = self.require_session_mut(&mut guard, session_id)?;
            self.check_navigation_url(
                &session.url,
                allow_http,
                session.control_mode == crate::browser::ControlMode::Agent,
            )?;
            win.reload()
                .map_err(|e| BrowserError::Validation(format!("reload failed: {e}")))?;
            session.loading = true;
            session.updated_at = chrono::Utc::now();
            session.snapshot()
        };

        emit_navigated(
            &self.app,
            &BrowserNavigatedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                url: state.url.clone(),
                title: state.title.clone(),
                can_go_back: state.can_go_back,
                can_go_forward: state.can_go_forward,
                loading: true,
                at: now_rfc3339(),
            },
        );
        Ok(state)
    }

    pub async fn focus(&self, session_id: &str) -> BrowserResult<()> {
        let _surface_guard = self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        require_live_surface_session(&session_guard, session_id)?;
        match Self::surface_host_mode() {
            window::SURFACE_HOST_DETACHED => {
                window::focus_content_window(&self.app).map_err(BrowserError::Validation)
            }
            window::SURFACE_HOST_EMBEDDED => Ok(()),
            _ => Err(BrowserError::Validation(
                "browser content focus unsupported on this platform".into(),
            )),
        }
    }

    /// Give an embedded browser child's native first responder back to the
    /// main React WebView so DOM modals and menus can receive keyboard input.
    pub fn release_surface_focus(&self, session_id: &str) -> BrowserResult<()> {
        let _surface_guard = self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        require_live_surface_session(&session_guard, session_id)?;

        if Self::surface_host_mode() == window::SURFACE_HOST_EMBEDDED {
            window::release_content_focus(&self.app).map_err(BrowserError::Validation)?;
        }
        Ok(())
    }

    pub fn surface_host_mode() -> &'static str {
        window::surface_host_mode()
    }

    /// Synchronize the native child Webview with a DOM placeholder rectangle.
    /// CSS viewport coordinates are converted against the main window's current
    /// physical inner size, then committed with one `Webview::set_bounds` call.
    #[allow(clippy::too_many_arguments)]
    pub fn set_surface_bounds(
        &self,
        session_id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        viewport_width: f64,
        viewport_height: f64,
        occlusions: Vec<SurfaceCssOcclusion>,
        input_occlusions: Vec<SurfaceCssOcclusion>,
        sequence: u64,
    ) -> BrowserResult<&'static str> {
        let mut last_sequence = self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        require_live_surface_session(&session_guard, session_id)?;

        if Self::surface_host_mode() == window::SURFACE_HOST_DETACHED {
            return Ok(window::SURFACE_HOST_DETACHED);
        }

        let main_window = self
            .app
            .get_window(window::MAIN_WINDOW_LABEL)
            .ok_or_else(|| {
                BrowserError::NotFound(format!("window {}", window::MAIN_WINDOW_LABEL))
            })?;
        let inner_size = main_window
            .inner_size()
            .map_err(|e| BrowserError::Validation(format!("main window size failed: {e}")))?;
        let bounds = physical_surface_bounds(
            SurfaceCssBounds {
                x,
                y,
                width,
                height,
                viewport_width,
                viewport_height,
            },
            inner_size,
        )?;
        let physical_occlusions =
            physical_surface_occlusions(&occlusions, viewport_width, viewport_height, inner_size)?;
        let physical_input_occlusions = physical_surface_occlusions(
            &input_occlusions,
            viewport_width,
            viewport_height,
            inner_size,
        )?;

        if last_sequence.is_some_and(|last| sequence <= last) {
            debug!(
                target: "browser.surface",
                session_id,
                sequence,
                last_sequence = ?*last_sequence,
                "ignored stale browser surface bounds"
            );
            return Ok(window::SURFACE_HOST_EMBEDDED);
        }

        debug!(
            target: "browser.surface",
            session_id,
            sequence,
            css_x = x,
            css_y = y,
            css_width = width,
            css_height = height,
            viewport_width,
            viewport_height,
            occlusion_count = physical_occlusions.len(),
            input_occlusion_count = physical_input_occlusions.len(),
            physical_bounds = ?bounds,
            "applying browser surface bounds"
        );
        window::set_content_bounds(&self.app, bounds).map_err(BrowserError::Validation)?;
        window::set_content_occlusions(&self.app, &physical_occlusions, &physical_input_occlusions)
            .map_err(BrowserError::Validation)?;
        *last_sequence = Some(sequence);
        Ok(window::SURFACE_HOST_EMBEDDED)
    }

    pub fn set_surface_visibility(
        &self,
        session_id: &str,
        visible: bool,
        focus: bool,
    ) -> BrowserResult<&'static str> {
        let _surface_guard = self
            .surface_sequence
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        require_live_surface_session(&session_guard, session_id)?;
        window::set_content_visibility(&self.app, visible, focus)
            .map_err(BrowserError::Validation)?;
        debug!(
            target: "browser.surface",
            session_id,
            visible,
            focus,
            host_mode = Self::surface_host_mode(),
            "updated browser surface visibility"
        );
        Ok(Self::surface_host_mode())
    }

    pub fn get_state(&self, session_id: &str) -> BrowserResult<BrowserSessionState> {
        let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let session = guard
            .as_ref()
            .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
        if session.id != session_id {
            return Err(BrowserError::NotFound(format!("session {session_id}")));
        }
        Ok(session.snapshot())
    }

    pub fn get_history(&self, session_id: &str) -> BrowserResult<Vec<HistoryEntry>> {
        let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let session = guard
            .as_ref()
            .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
        if session.id != session_id {
            return Err(BrowserError::NotFound(format!("session {session_id}")));
        }
        Ok(session.history.clone())
    }

    /// 当前活跃 session（若有）
    pub fn get_active_state(&self) -> Option<BrowserSessionState> {
        let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().filter(|s| s.alive).map(|s| s.snapshot())
    }

    /// 用户接管：打断 agent 控制态，并 emit `browser:control-mode-changed`
    ///
    /// ACR R1-05：打上 `user_takeover_at`，冷却期内 Agent 操作类工具被拒。
    pub fn take_over(&self) -> BrowserResult<BrowserSessionState> {
        self.take_over_with_reason("user_takeover")
    }

    /// 密码硬拒等场景强制交还用户（reason 区分事件来源）
    pub fn take_over_with_reason(&self, reason: &str) -> BrowserResult<BrowserSessionState> {
        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let session = guard
            .as_mut()
            .filter(|s| s.alive)
            .ok_or_else(|| BrowserError::NotFound("no active browser session".into()))?;
        let state = self.take_over_with_reason_locked(session, reason);
        drop(guard);
        self.emit_take_over(&state, reason);
        Ok(state)
    }

    /// A document-start listener calls this only for native trusted input. The
    /// capability lock and session lock stay held through the state transition,
    /// so a delayed command from an old document cannot affect a replacement
    /// `browser-content` Webview that reuses the fixed label.
    pub fn content_user_input(
        &self,
        session_id: &str,
        nonce: &str,
        kind: &str,
    ) -> BrowserResult<()> {
        if !TRUSTED_CONTENT_INPUT_KINDS.contains(&kind) {
            return Err(BrowserError::Validation(
                "trusted_content_input: unsupported input kind".into(),
            ));
        }

        let input_guard = self
            .trusted_content_input
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if !input_guard
            .as_ref()
            .is_some_and(|capability| capability.matches(session_id, nonce))
        {
            return Err(BrowserError::Validation(
                "trusted_content_input: invalid capability".into(),
            ));
        }

        let mut session_guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let session = session_guard
            .as_mut()
            .filter(|session| session.alive && session.id == session_id)
            .ok_or_else(|| {
                BrowserError::Validation("trusted_content_input: invalid capability".into())
            })?;
        let input_payload = BrowserContentUserInputPayload {
            session_id: session.id.clone(),
            label: session.label.clone(),
            kind: kind.to_string(),
            at: now_rfc3339(),
        };
        if session.control_mode == crate::browser::ControlMode::User {
            self.navigation_policy
                .set_agent_private_network_guard(false);
            drop(session_guard);
            drop(input_guard);
            emit_content_user_input(&self.app, &input_payload);
            return Ok(());
        }

        let state = self.take_over_with_reason_locked(session, "trusted_content_input");
        drop(session_guard);
        drop(input_guard);
        self.emit_take_over(&state, "trusted_content_input");
        emit_content_user_input(&self.app, &input_payload);
        info!(
            "[browser] trusted content input took control session={} kind={}",
            state.id, kind
        );
        Ok(())
    }

    fn take_over_with_reason_locked(
        &self,
        session: &mut BrowserSession,
        reason: &str,
    ) -> BrowserSessionState {
        debug_assert!(!reason.is_empty());
        self.navigation_policy
            .set_agent_private_network_guard(false);
        session.take_over();
        session.snapshot()
    }

    fn emit_take_over(&self, state: &BrowserSessionState, reason: &str) {
        emit_control_mode_changed(
            &self.app,
            &BrowserControlModeChangedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                control_mode: "user".into(),
                reason: reason.to_string(),
                at: now_rfc3339(),
            },
        );
    }

    /// Agent 工具开始操控时切到 Agent 控制态（清除接管闩锁）并 emit 事件
    pub fn set_agent_control(&self) -> BrowserResult<BrowserSessionState> {
        self.ensure_agent_automation_supported()?;
        self.allow_insecure_http();
        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let session = guard
            .as_mut()
            .filter(|s| s.alive)
            .ok_or_else(|| BrowserError::NotFound("no active browser session".into()))?;
        if session.is_blocked_by_user_takeover() {
            return Err(BrowserError::Validation(
                "user_takeover: user recently took control of the browser".into(),
            ));
        }
        self.navigation_policy.set_agent_private_network_guard(true);
        if session.control_mode == crate::browser::ControlMode::Agent {
            return Ok(session.snapshot());
        }
        session.set_control_mode(crate::browser::ControlMode::Agent);
        let state = session.snapshot();
        drop(guard);
        emit_control_mode_changed(
            &self.app,
            &BrowserControlModeChangedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                control_mode: "agent".into(),
                reason: "agent_claim".into(),
                at: now_rfc3339(),
            },
        );
        Ok(state)
    }

    /// ACR 4.0（A7）：消费「用户接管后 Agent 首次 claim」提示闩锁。
    /// 仅在 Agent 成功 claim 控制权后调用；返回 true 表示回执应提示
    /// 「已从用户手中接管控制」，供 LLM 转告用户。
    pub fn consume_takeover_notice(&self) -> bool {
        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut().filter(|s| s.alive) {
            Some(session) => session.consume_takeover_notice(),
            None => false,
        }
    }

    /// 若仍处于用户接管冷却期则返回 true（过期闩锁会被清除）
    pub fn is_blocked_by_user_takeover(&self) -> bool {
        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut().filter(|s| s.alive) {
            Some(session) => session.is_blocked_by_user_takeover(),
            None => false,
        }
    }

    /// Content 窗 label（固定）
    pub fn content_label() -> &'static str {
        BROWSER_CONTENT_LABEL
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    fn check_navigation_url(
        &self,
        url: &str,
        allow_insecure_http: bool,
        from_agent: bool,
    ) -> BrowserResult<()> {
        let effective_allow_insecure_http =
            effective_allow_insecure_http(allow_insecure_http, from_agent);
        policy::allow_navigation_with_options(url, effective_allow_insecure_http)
            .map_err(|e| BrowserError::Validation(format!("navigation_blocked: {e}")))?;
        if from_agent && policy::is_blocked_for_agent(url) {
            return Err(BrowserError::Validation(format!(
                "navigation_blocked: {}",
                NavigationDenyReason::AgentPrivateNetwork
            )));
        }
        if from_agent {
            self.check_agent_dns_target(url)?;
        }
        Ok(())
    }

    fn check_agent_dns_target(&self, raw_url: &str) -> BrowserResult<()> {
        let parsed = Url::parse(raw_url)
            .map_err(|e| BrowserError::Validation(format!("invalid URL: {e}")))?;
        self.navigation_policy
            .validate_agent_target_for_agent(&parsed)
            .map_err(|reason| BrowserError::Validation(format!("navigation_blocked: {reason}")))
    }

    fn require_session_mut<'a>(
        &self,
        guard: &'a mut Option<BrowserSession>,
        session_id: &str,
    ) -> BrowserResult<&'a mut BrowserSession> {
        let session = guard
            .as_mut()
            .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
        if session.id != session_id {
            return Err(BrowserError::NotFound(format!("session {session_id}")));
        }
        Ok(session)
    }

    fn begin_navigation(
        &self,
        rollback: BrowserSession,
        kind: PendingNavigationKind,
    ) -> BrowserResult<Arc<PendingNavigation>> {
        let mut runtime = self
            .navigation_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if runtime.pending.is_some() {
            return Err(BrowserError::Validation(
                "navigation already in progress".into(),
            ));
        }
        runtime.sequence = runtime.sequence.wrapping_add(1).max(1);
        let attempt = Arc::new(PendingNavigation {
            id: runtime.sequence,
            session_id: rollback.id.clone(),
            rollback,
            kind,
            blocked: Mutex::new(None),
        });
        runtime.pending = Some(attempt.clone());
        Ok(attempt)
    }

    fn pending_navigation(&self, session_id: &str) -> Option<Arc<PendingNavigation>> {
        self.navigation_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .as_ref()
            .filter(|pending| pending.session_id == session_id)
            .cloned()
    }

    fn clear_navigation(&self, id: u64) -> bool {
        let mut runtime = self
            .navigation_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if runtime
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            runtime.pending = None;
            return true;
        }
        false
    }

    fn cancel_pending_navigation(&self, session_id: &str) {
        let pending = self.pending_navigation(session_id);
        let Some(pending) = pending else {
            return;
        };
        if !self.clear_navigation(pending.id) {
            return;
        }
        let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(session) = guard
            .as_mut()
            .filter(|session| session.alive && session.id == session_id)
        {
            rollback_pending_navigation(session, &pending);
        }
    }

    fn make_window_hooks(self: &Arc<Self>, session_id: String) -> ContentWindowHooks {
        let weak: Weak<BrowserService> = Arc::downgrade(self);
        let weak_title = weak.clone();
        let weak_blocked = weak.clone();
        let weak_download_requested = weak.clone();
        let weak_download_finished = weak.clone();
        let download_browser_session_id = session_id.clone();
        ContentWindowHooks {
            on_page_finished: Arc::new(move |url| {
                if let Some(svc) = weak.upgrade() {
                    svc.on_page_finished(url);
                }
            }),
            on_title_changed: Arc::new(move |title, url| {
                if let Some(svc) = weak_title.upgrade() {
                    svc.on_title_changed(title, url);
                }
            }),
            on_navigation_blocked: Arc::new(move |url, reason| {
                if let Some(svc) = weak_blocked.upgrade() {
                    let session_id = session_id.clone();
                    let pending = svc.pending_navigation(&session_id);
                    if let Some(attempt) = pending.as_ref() {
                        attempt.mark_blocked(url.clone(), reason.clone());
                    }
                    // `Webview::navigate` may synchronously enter on_navigation while
                    // its caller holds the session mutex. Defer state convergence and
                    // event emission so the policy callback cannot deadlock the command.
                    tauri::async_runtime::spawn(async move {
                        svc.on_navigation_blocked(session_id, url, reason, pending);
                    });
                }
            }),
            on_download_requested: Arc::new(move |url, destination| {
                let Some(svc) = weak_download_requested.upgrade() else {
                    return false;
                };
                svc.on_download_requested(&download_browser_session_id, url, destination)
            }),
            on_download_finished: Arc::new(move |url, path, success| {
                if let Some(svc) = weak_download_finished.upgrade() {
                    svc.on_download_finished(url, path, success);
                }
            }),
        }
    }

    fn on_download_requested(
        &self,
        browser_session_id: &str,
        url: String,
        destination: &mut PathBuf,
    ) -> bool {
        let chat_session_id = {
            let session = self.session.lock().unwrap_or_else(|p| p.into_inner());
            download_owner_for_session(session.as_ref(), browser_session_id)
        };
        let chat_session_id = match chat_session_id {
            Ok(owner) => owner,
            Err(()) => return false,
        };
        let Some(chat_session_id) = chat_session_id else {
            // User-owned browser sessions retain normal platform download behavior.
            return true;
        };
        let root = match artifact_root(&self.app, &chat_session_id, true) {
            Ok(root) => root,
            Err(error) => {
                warn!("[browser] failed to resolve download artifact root: {error}");
                return false;
            }
        };
        let download_dir = root.path.join("browser-downloads");
        if let Err(error) = std::fs::create_dir_all(&download_dir) {
            warn!("[browser] failed to create download artifact directory: {error}");
            return false;
        }

        let original_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .map(sanitize_download_filename)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "download.bin".into());
        let id = format!("bd_{}", Uuid::new_v4());
        let filename = format!("{}-{}", &id[3..11], original_name);
        let relative_path = format!("browser-downloads/{filename}");
        let controlled_path = download_dir.join(&filename);

        let mut object_handle = TaskObjectHandle::new(
            format!("browser_download:{id}"),
            TaskObjectKind::File,
            filename.clone(),
            ObjectProvenance {
                source: "browser_download".into(),
                source_uri: Some(url.clone()),
                server: None,
                tool: Some("browser_downloads".into()),
                derived_from: Vec::new(),
                observed_at: now_rfc3339(),
            },
        );
        object_handle.locator = ManagedLocator::new("artifacts", relative_path.clone()).ok();
        object_handle.capabilities = ObjectCapabilities {
            readable: true,
            materializable: true,
            writable: false,
            shareable: false,
            sendable: false,
            deletable: true,
        };
        let observation = BrowserDownloadObservation {
            id: id.clone(),
            browser_session_id: browser_session_id.to_string(),
            chat_session_id: chat_session_id.clone(),
            url,
            filename,
            state: BrowserDownloadState::Started,
            root_id: "artifacts".into(),
            relative_path: relative_path.clone(),
            locator: format!("runtime://artifacts/{relative_path}"),
            sha256: None,
            size_bytes: None,
            error: None,
            started_at: now_rfc3339(),
            finished_at: None,
            object_handle: Some(object_handle),
        };
        let mut runtime = self.downloads.lock().unwrap_or_else(|p| p.into_inner());
        let completed = runtime
            .task_completed_bytes
            .get(&chat_session_id)
            .copied()
            .unwrap_or(0);
        let reserved = runtime
            .task_reserved_bytes
            .get(&chat_session_id)
            .copied()
            .unwrap_or(0);
        if !task_download_budget_available(completed, reserved) {
            warn!(
                "[browser] rejecting download because task budget is exhausted: {}",
                chat_session_id
            );
            return false;
        }
        runtime
            .task_reserved_bytes
            .insert(chat_session_id, reserved + MAX_BROWSER_DOWNLOAD_BYTES);
        *destination = controlled_path.clone();
        runtime.by_path.insert(controlled_path, id);
        runtime.observations.push_back(observation);
        while runtime.observations.len() > MAX_DOWNLOAD_OBSERVATIONS {
            let Some(index) = runtime.observations.iter().position(|item| {
                matches!(
                    item.state,
                    BrowserDownloadState::Completed | BrowserDownloadState::Failed
                )
            }) else {
                break;
            };
            if let Some(removed) = runtime.observations.remove(index) {
                runtime.by_path.retain(|_, id| id != &removed.id);
            }
        }
        true
    }

    fn on_download_finished(self: &Arc<Self>, url: String, path: Option<PathBuf>, success: bool) {
        let (id, controlled_path) = {
            let mut runtime = self.downloads.lock().unwrap_or_else(|p| p.into_inner());
            let id = path
                .as_ref()
                .and_then(|path| runtime.by_path.get(path).cloned())
                .or_else(|| {
                    runtime
                        .observations
                        .iter()
                        .rev()
                        .find(|item| {
                            item.url == url && matches!(item.state, BrowserDownloadState::Started)
                        })
                        .map(|item| item.id.clone())
                });
            if let Some(id) = id.as_deref() {
                if let Some(index) = runtime.observations.iter().position(|item| item.id == id) {
                    if success {
                        runtime.observations[index].state = BrowserDownloadState::Processing;
                    } else {
                        let chat_session_id = runtime.observations[index].chat_session_id.clone();
                        release_task_download_reservation(
                            &mut runtime.task_reserved_bytes,
                            &chat_session_id,
                        );
                        let item = &mut runtime.observations[index];
                        item.state = BrowserDownloadState::Failed;
                        item.error = Some("native download reported failure".into());
                        item.finished_at = Some(now_rfc3339());
                    }
                }
            }
            let controlled_path = path.clone().or_else(|| {
                id.as_deref().and_then(|id| {
                    runtime
                        .by_path
                        .iter()
                        .find(|(_, mapped_id)| mapped_id.as_str() == id)
                        .map(|(path, _)| path.clone())
                })
            });
            (id, controlled_path)
        };
        if !success {
            return;
        }
        let (Some(id), Some(path)) = (id, controlled_path) else {
            return;
        };

        let weak = Arc::downgrade(self);
        let fallback_id = id.clone();
        let fallback_path = path.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("browser-download-hash".into())
            .spawn(move || {
                let result = hash_download_file_bounded(&path, MAX_BROWSER_DOWNLOAD_BYTES);
                if let Some(service) = weak.upgrade() {
                    service.finish_download_hash(&id, &path, result);
                }
            })
        {
            warn!("[browser] download hash worker unavailable; hashing inline: {error}");
            let result = hash_download_file_bounded(&fallback_path, MAX_BROWSER_DOWNLOAD_BYTES);
            self.finish_download_hash(&fallback_id, &fallback_path, result);
        }
    }

    fn finish_download_hash(&self, id: &str, path: &Path, result: Result<(String, u64), String>) {
        let mut runtime = self.downloads.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(index) = runtime.observations.iter().position(|item| item.id == id) {
            let chat_session_id = runtime.observations[index].chat_session_id.clone();
            release_task_download_reservation(&mut runtime.task_reserved_bytes, &chat_session_id);
            match result {
                Ok((sha256, size_bytes)) => {
                    let completed = runtime
                        .task_completed_bytes
                        .entry(chat_session_id)
                        .or_insert(0);
                    *completed = completed.saturating_add(size_bytes);
                    let item = &mut runtime.observations[index];
                    item.state = BrowserDownloadState::Completed;
                    item.sha256 = Some(sha256);
                    item.size_bytes = Some(size_bytes);
                    if let Some(handle) = item.object_handle.as_mut() {
                        handle.sha256 = item.sha256.clone();
                        handle.size_bytes = Some(size_bytes);
                    }
                }
                Err(error) => {
                    if error == "download exceeds per-file byte limit" {
                        let _ = std::fs::remove_file(path);
                    }
                    let item = &mut runtime.observations[index];
                    item.state = BrowserDownloadState::Failed;
                    item.error = Some(error);
                }
            }
            runtime.observations[index].finished_at = Some(now_rfc3339());
        }
    }

    pub fn list_downloads(&self, browser_session_id: &str) -> Vec<BrowserDownloadObservation> {
        self.downloads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observations
            .iter()
            .filter(|item| item.browser_session_id == browser_session_id)
            .cloned()
            .collect()
    }

    pub fn list_task_downloads(&self, chat_session_id: &str) -> Vec<BrowserDownloadObservation> {
        self.downloads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observations
            .iter()
            .filter(|item| item.chat_session_id == chat_session_id)
            .cloned()
            .collect()
    }

    fn on_navigation_blocked(
        &self,
        session_id: String,
        url: String,
        reason: String,
        pending: Option<Arc<PendingNavigation>>,
    ) {
        if let Some(attempt) = pending.as_ref() {
            if !self.clear_navigation(attempt.id) {
                debug!(
                    target: "browser.navigation",
                    session_id,
                    url,
                    "ignored blocked navigation from superseded attempt"
                );
                return;
            }
        }
        let state = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_mut() {
                Some(session) if session.alive && session.id == session_id => {
                    if let Some(attempt) = pending.as_ref() {
                        rollback_pending_navigation(session, attempt);
                    } else {
                        session.mark_loaded(None);
                    }
                    Some(session.snapshot())
                }
                Some(_) => None,
                // Initial navigation can be evaluated before open_session publishes
                // its in-memory session. The captured ID still identifies this host.
                None => None,
            }
        };
        if state.is_none() && self.get_active_state().is_some() {
            debug!(
                target: "browser.navigation",
                session_id,
                url,
                "ignored blocked navigation from stale content host"
            );
            return;
        }

        emit_navigation_blocked(
            &self.app,
            &BrowserNavigationBlockedPayload {
                session_id,
                label: BROWSER_CONTENT_LABEL.into(),
                url,
                reason,
                current_url: state.as_ref().map(|state| state.url.clone()),
                title: state.as_ref().map(|state| state.title.clone()),
                can_go_back: state.as_ref().map(|state| state.can_go_back),
                can_go_forward: state.as_ref().map(|state| state.can_go_forward),
                history_index: state.as_ref().map(|state| state.history_index),
                at: now_rfc3339(),
            },
        );
    }

    fn on_page_finished(&self, url: String) {
        let pending = {
            let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .as_ref()
                .and_then(|session| self.pending_navigation(&session.id))
        };
        if let Some(attempt) = pending.as_ref() {
            if let Some(blocked) = attempt.blocked() {
                self.on_navigation_blocked(
                    attempt.session_id.clone(),
                    blocked.url,
                    blocked.reason,
                    pending,
                );
                return;
            }
            self.clear_navigation(attempt.id);
        }
        let (state, page_initiated_navigation) = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let Some(session) = guard.as_mut() else {
                return;
            };
            let page_initiated_navigation = !session.loading && session.url != url;
            if page_initiated_navigation {
                session.push_url(url.clone(), None);
                session.mark_loaded(None);
            } else {
                // Service 导航 / redirect：替换当前条目的最终 URL，不额外压栈。
                session.mark_loaded(Some(url.clone()));
            }
            (session.snapshot(), page_initiated_navigation)
        };

        if self.db.is_open() {
            let persist_result = if let Some(attempt) = pending.as_ref() {
                match attempt.kind {
                    PendingNavigationKind::Push => BrowserRepository::push_history(
                        &self.db,
                        &state.id,
                        &BrowserHistoryPush {
                            url: state.url.clone(),
                            title: Some(state.title.clone()),
                            transition: Some("link".into()),
                            typed: false,
                        },
                    )
                    .map(|_| ()),
                    PendingNavigationKind::Replace => BrowserRepository::update_current_history(
                        &self.db,
                        &state.id,
                        state.history_index as i64,
                        Some(&state.url),
                        Some(&state.title),
                    ),
                }
            } else if page_initiated_navigation {
                BrowserRepository::push_history(
                    &self.db,
                    &state.id,
                    &BrowserHistoryPush {
                        url: state.url.clone(),
                        title: None,
                        transition: Some("link".into()),
                        typed: false,
                    },
                )
                .map(|_| ())
            } else {
                BrowserRepository::update_current_history(
                    &self.db,
                    &state.id,
                    state.history_index as i64,
                    Some(&state.url),
                    None,
                )
            };
            if let Err(error) = persist_result {
                warn!("[browser] persist finished navigation failed: {}", error);
            }
        }
        emit_navigated(
            &self.app,
            &BrowserNavigatedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                url: state.url.clone(),
                title: state.title.clone(),
                can_go_back: state.can_go_back,
                can_go_forward: state.can_go_forward,
                loading: false,
                at: now_rfc3339(),
            },
        );
    }

    fn on_title_changed(&self, title: String, webview_url: Option<String>) {
        let (state, page_initiated_navigation) = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let Some(session) = guard.as_mut() else {
                return;
            };
            let page_navigation_url =
                webview_url.filter(|url| !session.loading && url.as_str() != session.url.as_str());
            let page_initiated_navigation = page_navigation_url.is_some();
            if let Some(url) = page_navigation_url {
                // Title changes can precede PageLoadEvent::Finished. Capture the
                // new URL now so the title is not written onto the previous row.
                session.push_url(url, None);
            }
            session.set_title(title);
            (session.snapshot(), page_initiated_navigation)
        };
        let navigation_pending = self.pending_navigation(&state.id).is_some();
        if self.db.is_open() && !navigation_pending {
            let persist_result = if page_initiated_navigation {
                BrowserRepository::push_history(
                    &self.db,
                    &state.id,
                    &BrowserHistoryPush {
                        url: state.url.clone(),
                        title: Some(state.title.clone()),
                        transition: Some("link".into()),
                        typed: false,
                    },
                )
                .map(|_| ())
            } else {
                BrowserRepository::update_current_history(
                    &self.db,
                    &state.id,
                    state.history_index as i64,
                    None,
                    Some(&state.title),
                )
            };
            if let Err(error) = persist_result {
                warn!("[browser] persist title failed: {}", error);
            }
        }
        if page_initiated_navigation {
            emit_navigated(
                &self.app,
                &BrowserNavigatedPayload {
                    session_id: state.id.clone(),
                    label: state.label.clone(),
                    url: state.url.clone(),
                    title: state.title.clone(),
                    can_go_back: state.can_go_back,
                    can_go_forward: state.can_go_forward,
                    loading: state.loading,
                    at: now_rfc3339(),
                },
            );
        }
        emit_title_changed(
            &self.app,
            &BrowserTitleChangedPayload {
                session_id: state.id.clone(),
                label: state.label.clone(),
                title: state.title.clone(),
                url: state.url.clone(),
                at: now_rfc3339(),
            },
        );
    }

    fn attach_destroy_listener(&self, session_id: String) {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = session_id;
        }

        #[cfg(target_os = "linux")]
        let Some(win) = self.app.get_webview_window(BROWSER_CONTENT_LABEL) else {
            return;
        };
        #[cfg(target_os = "linux")]
        {
            let app = self.app.clone();
            let navigation_policy = self.navigation_policy.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    navigation_policy.set_agent_private_network_guard(false);
                    // 用户点关 content 窗：清内存 session + 发 closed
                    // 通过 try_state 取服务，避免循环持有
                    if let Some(svc) = app.try_state::<Arc<BrowserService>>() {
                        let closed_id = {
                            let mut input_guard = svc
                                .trusted_content_input
                                .lock()
                                .unwrap_or_else(|p| p.into_inner());
                            let mut session_guard =
                                svc.session.lock().unwrap_or_else(|p| p.into_inner());
                            let should_close = session_guard
                                .as_ref()
                                .is_some_and(|session| session.id == session_id && session.alive);
                            if should_close {
                                *input_guard = None;
                                session_guard.take().map(|mut session| {
                                    session.mark_closed();
                                    session.id
                                })
                            } else {
                                None
                            }
                        };
                        if let Some(id) = closed_id {
                            if svc.db.is_open() {
                                let _ = BrowserRepository::close_session(&svc.db, &id);
                            }
                            emit_closed(
                                &app,
                                &BrowserClosedPayload {
                                    session_id: id,
                                    label: BROWSER_CONTENT_LABEL.into(),
                                    reason: "destroyed".into(),
                                    at: now_rfc3339(),
                                },
                            );
                        }
                    }
                }
            });
        }
    }
}

fn apply_pending_navigation(
    session: &mut BrowserSession,
    attempt: &PendingNavigation,
    url: &str,
    replace: bool,
) -> Result<BrowserSessionState, BlockedNavigation> {
    let blocked = attempt
        .blocked
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(blocked) = blocked.as_ref() {
        return Err(blocked.clone());
    }
    if replace {
        session.replace_url(url.to_string(), None);
    } else {
        session.push_url(url.to_string(), None);
    }
    Ok(session.snapshot())
}

fn rollback_pending_navigation(session: &mut BrowserSession, attempt: &PendingNavigation) {
    *session = attempt.rollback.clone();
    session.mark_loaded(None);
}

fn sanitize_download_filename(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .take(180)
        .collect();
    let trimmed = sanitized.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if trimmed.is_empty() {
        "download.bin".into()
    } else {
        trimmed.to_string()
    }
}

fn update_reused_download_owner(
    session: &mut BrowserSession,
    from_agent: bool,
    chat_session_id: Option<String>,
) {
    session.chat_session_id = from_agent.then_some(chat_session_id).flatten();
    session.updated_at = chrono::Utc::now();
}

fn download_owner_for_session(
    session: Option<&BrowserSession>,
    browser_session_id: &str,
) -> Result<Option<String>, ()> {
    let session = session
        .filter(|session| session.alive && session.id == browser_session_id)
        .ok_or(())?;
    if session.control_mode == crate::browser::ControlMode::Agent {
        session.chat_session_id.clone().map(Some).ok_or(())
    } else {
        Ok(None)
    }
}

fn task_download_budget_available(completed_bytes: u64, reserved_bytes: u64) -> bool {
    completed_bytes
        .saturating_add(reserved_bytes)
        .saturating_add(MAX_BROWSER_DOWNLOAD_BYTES)
        <= MAX_BROWSER_TASK_DOWNLOAD_BYTES
}

fn release_task_download_reservation(reservations: &mut HashMap<String, u64>, task_id: &str) {
    let Some(reserved) = reservations.get_mut(task_id) else {
        return;
    };
    *reserved = reserved.saturating_sub(MAX_BROWSER_DOWNLOAD_BYTES);
    if *reserved == 0 {
        reservations.remove(task_id);
    }
}

fn hash_download_file_bounded(path: &Path, max_bytes: u64) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|error| format!("open downloaded file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read downloaded file: {error}"))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max_bytes {
            return Err("download exceeds per-file byte limit".into());
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn require_live_surface_session<'a>(
    active: &'a Option<BrowserSession>,
    session_id: &str,
) -> BrowserResult<&'a BrowserSession> {
    active
        .as_ref()
        .filter(|session| session.alive && session.id == session_id)
        .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))
}

#[derive(Debug, Clone, Copy)]
struct SurfaceCssBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCssOcclusion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn physical_surface_bounds(
    css: SurfaceCssBounds,
    physical_viewport: PhysicalSize<u32>,
) -> BrowserResult<Rect> {
    for (name, value) in [
        ("x", css.x),
        ("y", css.y),
        ("width", css.width),
        ("height", css.height),
        ("viewportWidth", css.viewport_width),
        ("viewportHeight", css.viewport_height),
    ] {
        if !value.is_finite() {
            return Err(BrowserError::Validation(format!(
                "browser surface {name} must be finite"
            )));
        }
    }
    if css.width <= 0.0
        || css.height <= 0.0
        || css.viewport_width <= 0.0
        || css.viewport_height <= 0.0
    {
        return Err(BrowserError::Validation(
            "browser surface and viewport dimensions must be positive".into(),
        ));
    }
    if physical_viewport.width == 0 || physical_viewport.height == 0 {
        return Err(BrowserError::Validation(
            "main window has an empty physical viewport".into(),
        ));
    }

    let right_css = css.x + css.width;
    let bottom_css = css.y + css.height;
    if !right_css.is_finite() || !bottom_css.is_finite() {
        return Err(BrowserError::Validation(
            "browser surface rectangle overflowed".into(),
        ));
    }
    if right_css <= 0.0
        || css.x >= css.viewport_width
        || bottom_css <= 0.0
        || css.y >= css.viewport_height
    {
        return Err(BrowserError::Validation(
            "browser surface rectangle must intersect the viewport".into(),
        ));
    }

    // Preserve the complete child frame while the outer native window clips
    // the portion beyond its viewport. This keeps the webpage viewport and
    // content origin stable while an internal browser window is being moved.
    let scale_x = f64::from(physical_viewport.width) / css.viewport_width;
    let scale_y = f64::from(physical_viewport.height) / css.viewport_height;

    let left = (css.x * scale_x).floor();
    let top = (css.y * scale_y).floor();
    let right = (right_css * scale_x).ceil();
    let bottom = (bottom_css * scale_y).ceil();
    for (name, value) in [
        ("left", left),
        ("top", top),
        ("right", right),
        ("bottom", bottom),
    ] {
        if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
            return Err(BrowserError::Validation(format!(
                "browser surface physical {name} edge is outside the supported range"
            )));
        }
    }

    let left = left as i64;
    let top = top as i64;
    let right = right as i64;
    let bottom = bottom as i64;
    let physical_width = right - left;
    let physical_height = bottom - top;
    if physical_width <= 0 || physical_height <= 0 {
        return Err(BrowserError::Validation(
            "browser surface collapsed after physical scaling".into(),
        ));
    }
    if physical_width > i64::from(i32::MAX) || physical_height > i64::from(i32::MAX) {
        return Err(BrowserError::Validation(
            "browser surface physical dimensions are too large".into(),
        ));
    }

    let x = i32::try_from(left)
        .map_err(|_| BrowserError::Validation("browser surface x is too large".into()))?;
    let y = i32::try_from(top)
        .map_err(|_| BrowserError::Validation("browser surface y is too large".into()))?;
    let width = u32::try_from(physical_width)
        .map_err(|_| BrowserError::Validation("browser surface width is too large".into()))?;
    let height = u32::try_from(physical_height)
        .map_err(|_| BrowserError::Validation("browser surface height is too large".into()))?;

    Ok(Rect {
        position: PhysicalPosition::new(x, y).into(),
        size: PhysicalSize::new(width, height).into(),
    })
}

fn physical_surface_occlusions(
    occlusions: &[SurfaceCssOcclusion],
    viewport_width: f64,
    viewport_height: f64,
    physical_viewport: PhysicalSize<u32>,
) -> BrowserResult<Vec<Rect>> {
    if occlusions.len() > MAX_SURFACE_OCCLUSIONS {
        return Err(BrowserError::Validation(format!(
            "browser surface has too many occlusion rectangles (maximum {MAX_SURFACE_OCCLUSIONS})"
        )));
    }

    let mut result = Vec::with_capacity(occlusions.len());
    for (index, occlusion) in occlusions.iter().enumerate() {
        for (name, value) in [
            ("x", occlusion.x),
            ("y", occlusion.y),
            ("width", occlusion.width),
            ("height", occlusion.height),
        ] {
            if !value.is_finite() {
                return Err(BrowserError::Validation(format!(
                    "browser surface occlusion {index} {name} must be finite"
                )));
            }
        }
        if occlusion.width <= 0.0 || occlusion.height <= 0.0 {
            return Err(BrowserError::Validation(format!(
                "browser surface occlusion {index} dimensions must be positive"
            )));
        }

        let right = occlusion.x + occlusion.width;
        let bottom = occlusion.y + occlusion.height;
        if !right.is_finite() || !bottom.is_finite() {
            return Err(BrowserError::Validation(format!(
                "browser surface occlusion {index} overflowed"
            )));
        }

        let left = occlusion.x.max(0.0);
        let top = occlusion.y.max(0.0);
        let right = right.min(viewport_width);
        let bottom = bottom.min(viewport_height);
        if right <= left || bottom <= top {
            continue;
        }
        result.push(physical_surface_bounds(
            SurfaceCssBounds {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
                viewport_width,
                viewport_height,
            },
            physical_viewport,
        )?);
    }
    union_physical_surface_occlusions(result)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PhysicalOcclusionBounds {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl PhysicalOcclusionBounds {
    fn from_rect(rect: Rect) -> BrowserResult<Self> {
        let (position, size) = match (rect.position, rect.size) {
            (tauri::Position::Physical(position), tauri::Size::Physical(size)) => (position, size),
            _ => {
                return Err(BrowserError::Validation(
                    "browser surface occlusion must use physical coordinates".into(),
                ));
            }
        };
        let left = i64::from(position.x);
        let top = i64::from(position.y);
        let right = left + i64::from(size.width);
        let bottom = top + i64::from(size.height);
        if right <= left || bottom <= top {
            return Err(BrowserError::Validation(
                "browser surface occlusion collapsed after physical scaling".into(),
            ));
        }
        Ok(Self {
            left,
            top,
            right,
            bottom,
        })
    }

    fn into_rect(self) -> BrowserResult<Rect> {
        let x = i32::try_from(self.left).map_err(|_| {
            BrowserError::Validation("browser surface occlusion x is too large".into())
        })?;
        let y = i32::try_from(self.top).map_err(|_| {
            BrowserError::Validation("browser surface occlusion y is too large".into())
        })?;
        let width = u32::try_from(self.right - self.left).map_err(|_| {
            BrowserError::Validation("browser surface occlusion width is too large".into())
        })?;
        let height = u32::try_from(self.bottom - self.top).map_err(|_| {
            BrowserError::Validation("browser surface occlusion height is too large".into())
        })?;
        Ok(Rect {
            position: PhysicalPosition::new(x, y).into(),
            size: PhysicalSize::new(width, height).into(),
        })
    }
}

/// Rounding each CSS occluder outward can make otherwise disjoint bands
/// overlap by a physical pixel. macOS uses an even-odd shape mask, so merge
/// after rounding to preserve one solid hole through every overlap.
fn union_physical_surface_occlusions(rects: Vec<Rect>) -> BrowserResult<Vec<Rect>> {
    if rects.len() < 2 {
        return Ok(rects);
    }

    let rects = rects
        .into_iter()
        .map(PhysicalOcclusionBounds::from_rect)
        .collect::<BrowserResult<Vec<_>>>()?;
    let mut y_edges = rects
        .iter()
        .flat_map(|rect| [rect.top, rect.bottom])
        .collect::<Vec<_>>();
    y_edges.sort_unstable();
    y_edges.dedup();

    let mut rows = Vec::new();
    for edges in y_edges.windows(2) {
        let top = edges[0];
        let bottom = edges[1];
        if bottom <= top {
            continue;
        }
        let mut intervals = rects
            .iter()
            .filter(|rect| rect.top < bottom && rect.bottom > top)
            .map(|rect| (rect.left, rect.right))
            .collect::<Vec<_>>();
        intervals.sort_unstable();

        let mut merged = Vec::<(i64, i64)>::new();
        for (left, right) in intervals {
            if let Some(previous) = merged.last_mut() {
                if left <= previous.1 {
                    previous.1 = previous.1.max(right);
                    continue;
                }
            }
            merged.push((left, right));
        }
        rows.extend(
            merged
                .into_iter()
                .map(|(left, right)| PhysicalOcclusionBounds {
                    left,
                    top,
                    right,
                    bottom,
                }),
        );
    }

    let mut union = Vec::<PhysicalOcclusionBounds>::new();
    for row in rows {
        if let Some(previous) = union.last_mut() {
            if previous.left == row.left
                && previous.right == row.right
                && previous.bottom == row.top
            {
                previous.bottom = row.bottom;
                continue;
            }
        }
        union.push(row);
    }

    union
        .into_iter()
        .map(PhysicalOcclusionBounds::into_rect)
        .collect()
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// 父闸：与前端 `interpretWorkbenchModeEnabled` 一致——
/// 缺失 / 空 / 非法 → enabled；仅 trim 后精确 `"false"` 关闭。
fn is_workbench_mode_enabled(raw: Option<&str>) -> bool {
    !matches!(raw.map(str::trim), Some("false"))
}

/// 子闸：显式 opt-in（缺失 → false）。`unwrap_or(false)` 仅作用于子闸，
/// 不得套用到父闸 `desktop.workbenchMode`（父闸见 `is_workbench_mode_enabled`）。
fn is_browser_child_gate_enabled(raw: Option<&str>) -> bool {
    raw.map(is_truthy).unwrap_or(false)
}

/// settings 层双闸（不含 feature flag）。`assert_gates_open` 的设置语义真源。
///
/// 供跨语言一致性测试与调用方复用；与前端 `resolveBrowserGates` 设置半边对齐。
pub fn assert_settings_gates_open(
    workbench_raw: Option<&str>,
    browser_raw: Option<&str>,
) -> Result<(), &'static str> {
    if !is_workbench_mode_enabled(workbench_raw) {
        return Err("browser disabled: desktop.workbenchMode is off");
    }
    if !is_browser_child_gate_enabled(browser_raw) {
        return Err("browser disabled: desktop.workbenchBrowserEnabled is off");
    }
    Ok(())
}

fn effective_allow_insecure_http(network_mode_full: bool, agent_control: bool) -> bool {
    !agent_control || network_mode_full
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_parsing() {
        assert!(is_truthy("true"));
        assert!(is_truthy("TRUE"));
        assert!(is_truthy("1"));
        assert!(!is_truthy("false"));
        assert!(!is_truthy(""));
    }

    /// 对齐前端 `gates.ts` / `interpretWorkbenchModeEnabled`：
    /// 父闸键缺失 → 开；显式 false → 关；子闸仍需显式 true。
    #[test]
    fn assert_settings_gates_open_missing_workbench_defaults_enabled() {
        // 父闸缺失 + 子闸显式开 → settings 双闸开放（assert_gates_open 同语义）
        assert!(assert_settings_gates_open(None, Some("true")).is_ok());
        assert!(assert_settings_gates_open(Some(""), Some("true")).is_ok());
        assert!(assert_settings_gates_open(Some("  "), Some("true")).is_ok());
        // 非法值按前端默认 true
        assert!(assert_settings_gates_open(Some("1"), Some("true")).is_ok());
        assert!(assert_settings_gates_open(Some("FALSE"), Some("true")).is_ok());

        // 显式 false → 关（即使子闸开）
        let err = assert_settings_gates_open(Some("false"), Some("true")).unwrap_err();
        assert_eq!(err, "browser disabled: desktop.workbenchMode is off");
        assert!(assert_settings_gates_open(Some("  false  "), Some("true")).is_err());

        // 父闸开但子闸缺失/关 → 仍关（子闸 opt-in）
        let child_err = assert_settings_gates_open(None, None).unwrap_err();
        assert_eq!(
            child_err,
            "browser disabled: desktop.workbenchBrowserEnabled is off"
        );
        assert!(assert_settings_gates_open(Some("true"), Some("false")).is_err());
        assert!(assert_settings_gates_open(Some("true"), Some("true")).is_ok());
    }

    #[test]
    fn workbench_mode_enabled_only_explicit_false_closes() {
        assert!(is_workbench_mode_enabled(None));
        assert!(is_workbench_mode_enabled(Some("true")));
        assert!(!is_workbench_mode_enabled(Some("false")));
        assert!(is_browser_child_gate_enabled(Some("true")));
        assert!(!is_browser_child_gate_enabled(None));
        assert!(!is_browser_child_gate_enabled(Some("false")));
    }

    #[test]
    fn content_label_is_fixed() {
        assert_eq!(BrowserService::content_label(), "browser-content");
    }

    #[test]
    fn agent_automation_capability_matches_platform() {
        assert_eq!(
            BrowserService::agent_automation_supported(),
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    #[test]
    fn http_allowance_depends_on_control_mode() {
        assert!(effective_allow_insecure_http(false, false));
        assert!(effective_allow_insecure_http(true, false));
        assert!(!effective_allow_insecure_http(false, true));
        assert!(effective_allow_insecure_http(true, true));
    }

    fn assert_physical_rect(rect: Rect, position: (i32, i32), size: (u32, u32)) {
        match rect.position {
            tauri::Position::Physical(actual) => {
                assert_eq!((actual.x, actual.y), position);
            }
            other => panic!("expected physical position, got {other:?}"),
        }
        match rect.size {
            tauri::Size::Physical(actual) => {
                assert_eq!((actual.width, actual.height), size);
            }
            other => panic!("expected physical size, got {other:?}"),
        }
    }

    #[test]
    fn surface_bounds_scale_css_coordinates_to_physical_pixels() {
        let rect = physical_surface_bounds(
            SurfaceCssBounds {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 50.0,
                viewport_width: 500.0,
                viewport_height: 400.0,
            },
            PhysicalSize::new(1000, 800),
        )
        .unwrap();

        assert_physical_rect(rect, (20, 40), (200, 100));
    }

    #[test]
    fn surface_bounds_preserve_partially_overflowing_frames() {
        let viewport = PhysicalSize::new(1000, 800);
        let base = SurfaceCssBounds {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 50.0,
            viewport_width: 500.0,
            viewport_height: 400.0,
        };

        for (bounds, position, size) in [
            (SurfaceCssBounds { x: -25.0, ..base }, (-50, 40), (200, 100)),
            (SurfaceCssBounds { x: 450.0, ..base }, (900, 40), (200, 100)),
            (SurfaceCssBounds { y: -10.0, ..base }, (20, -20), (200, 100)),
            (SurfaceCssBounds { y: 375.0, ..base }, (20, 750), (200, 100)),
            (
                SurfaceCssBounds {
                    x: -25.0,
                    y: -10.0,
                    width: 600.0,
                    height: 500.0,
                    ..base
                },
                (-50, -20),
                (1200, 1000),
            ),
        ] {
            let rect = physical_surface_bounds(bounds, viewport).unwrap();
            assert_physical_rect(rect, position, size);
        }
    }

    #[test]
    fn surface_bounds_reject_non_finite_empty_and_offscreen_values() {
        let viewport = PhysicalSize::new(1000, 800);
        let valid = SurfaceCssBounds {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 50.0,
            viewport_width: 500.0,
            viewport_height: 400.0,
        };

        for bounds in [
            SurfaceCssBounds {
                x: f64::NAN,
                ..valid
            },
            SurfaceCssBounds {
                x: f64::MAX,
                width: f64::MAX,
                ..valid
            },
            SurfaceCssBounds {
                width: 0.0,
                ..valid
            },
            SurfaceCssBounds {
                x: -100.0,
                width: 100.0,
                ..valid
            },
            SurfaceCssBounds {
                x: -101.0,
                width: 100.0,
                ..valid
            },
            SurfaceCssBounds { x: 500.0, ..valid },
            SurfaceCssBounds {
                y: -50.0,
                height: 50.0,
                ..valid
            },
            SurfaceCssBounds {
                y: -51.0,
                height: 50.0,
                ..valid
            },
            SurfaceCssBounds { y: 400.0, ..valid },
        ] {
            assert!(physical_surface_bounds(bounds, viewport).is_err());
        }
    }

    #[test]
    fn surface_bounds_round_outward_with_nonuniform_scale() {
        let rect = physical_surface_bounds(
            SurfaceCssBounds {
                x: -0.2,
                y: -0.2,
                width: 100.4,
                height: 50.4,
                viewport_width: 400.0,
                viewport_height: 200.0,
            },
            PhysicalSize::new(1000, 300),
        )
        .unwrap();

        assert_physical_rect(rect, (-1, -1), (252, 77));
    }

    #[test]
    fn surface_bounds_reject_unrepresentable_physical_frames() {
        let scale_one = PhysicalSize::new(1000, 800);
        let base = SurfaceCssBounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            viewport_width: 1000.0,
            viewport_height: 800.0,
        };

        for (bounds, viewport) in [
            (
                SurfaceCssBounds {
                    x: f64::from(i32::MIN) - 1.0,
                    width: f64::from(i32::MAX) + 3.0,
                    ..base
                },
                scale_one,
            ),
            (
                SurfaceCssBounds {
                    x: 999.0,
                    width: f64::from(i32::MAX),
                    ..base
                },
                scale_one,
            ),
            (
                SurfaceCssBounds {
                    x: -1_073_741_824.0,
                    width: 2_147_483_648.0,
                    ..base
                },
                scale_one,
            ),
            (
                SurfaceCssBounds {
                    width: 1.0,
                    height: 1.0,
                    viewport_width: 1.0,
                    viewport_height: 1.0,
                    ..base
                },
                PhysicalSize::new(u32::MAX, 1),
            ),
        ] {
            assert!(physical_surface_bounds(bounds, viewport).is_err());
        }
    }

    #[test]
    fn surface_occlusions_clip_to_the_native_viewport() {
        let rects = physical_surface_occlusions(
            &[
                SurfaceCssOcclusion {
                    x: -20.0,
                    y: 375.0,
                    width: 50.0,
                    height: 100.0,
                },
                SurfaceCssOcclusion {
                    x: 600.0,
                    y: 20.0,
                    width: 50.0,
                    height: 50.0,
                },
            ],
            500.0,
            400.0,
            PhysicalSize::new(1000, 800),
        )
        .unwrap();

        assert_eq!(rects.len(), 1);
        assert_physical_rect(rects[0], (0, 750), (60, 50));
    }

    #[test]
    fn surface_occlusions_merge_after_physical_rounding() {
        let rects = physical_surface_occlusions(
            &[
                SurfaceCssOcclusion {
                    x: 0.1,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                },
                SurfaceCssOcclusion {
                    x: 10.1,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                },
            ],
            100.0,
            100.0,
            PhysicalSize::new(100, 100),
        )
        .unwrap();

        assert_eq!(rects.len(), 1);
        assert_physical_rect(rects[0], (0, 0), (21, 10));
    }

    #[test]
    fn surface_occlusions_reject_invalid_input_and_excessive_count() {
        let viewport = PhysicalSize::new(1000, 800);
        assert!(physical_surface_occlusions(
            &[SurfaceCssOcclusion {
                x: f64::NAN,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }],
            500.0,
            400.0,
            viewport,
        )
        .is_err());

        let repeated = SurfaceCssOcclusion {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(physical_surface_occlusions(
            &vec![repeated; MAX_SURFACE_OCCLUSIONS + 1],
            500.0,
            400.0,
            viewport,
        )
        .is_err());
    }

    #[test]
    fn surface_session_guard_rejects_stale_and_closed_sessions() {
        let mut active = BrowserSession::new(
            "bs_active".into(),
            "https://example.com/".into(),
            std::path::PathBuf::from("/tmp/browser"),
            None,
            None,
        );

        let slot = Some(active.clone());
        assert!(require_live_surface_session(&slot, "bs_active").is_ok());
        assert!(require_live_surface_session(&slot, "bs_stale").is_err());

        active.mark_closed();
        assert!(require_live_surface_session(&Some(active), "bs_active").is_err());
        assert!(require_live_surface_session(&None, "bs_active").is_err());
    }

    #[test]
    fn trusted_input_capability_is_session_bound_and_128_bit() {
        let capability = TrustedContentInputCapability::generate("bs_active".into());
        let encoded = capability.encoded_nonce();

        assert_eq!(encoded.len(), 32);
        assert_eq!(hex::decode(&encoded).unwrap().len(), 16);
        assert!(capability.matches("bs_active", &encoded));
        assert!(!capability.matches("bs_replaced", &encoded));
        assert!(!capability.matches("bs_active", "0000000000000000000000000000000g"));

        let mut wrong = encoded.into_bytes();
        wrong[0] = if wrong[0] == b'0' { b'1' } else { b'0' };
        assert!(!capability.matches("bs_active", std::str::from_utf8(&wrong).unwrap()));
    }

    #[test]
    fn trusted_input_kinds_exclude_script_chosen_values() {
        for kind in ["pointerdown", "keydown", "compositionstart", "wheel"] {
            assert!(TRUSTED_CONTENT_INPUT_KINDS.contains(&kind));
        }
        assert!(!TRUSTED_CONTENT_INPUT_KINDS.contains(&"click"));
        assert!(!TRUSTED_CONTENT_INPUT_KINDS.contains(&"agent_claim"));
    }

    #[test]
    fn direct_policy_rejection_never_commits_requested_url() {
        let mut session = BrowserSession::new(
            "bs_navigation".into(),
            "https://allowed.example/".into(),
            std::path::PathBuf::from("/tmp/browser"),
            None,
            None,
        );
        session.mark_loaded(None);
        let attempt = PendingNavigation {
            id: 1,
            session_id: session.id.clone(),
            rollback: session.clone(),
            kind: PendingNavigationKind::Push,
            blocked: Mutex::new(Some(BlockedNavigation {
                url: "http://blocked.example/".into(),
                reason: "blocked".into(),
            })),
        };

        assert!(
            apply_pending_navigation(&mut session, &attempt, "http://blocked.example/", false,)
                .is_err()
        );
        assert_eq!(session.url, "https://allowed.example/");
        assert_eq!(session.history.len(), 1);
    }

    #[test]
    fn blocked_redirect_restores_current_url_and_forward_history() {
        let mut session = BrowserSession::new(
            "bs_redirect".into(),
            "https://a.example/".into(),
            std::path::PathBuf::from("/tmp/browser"),
            None,
            None,
        );
        session.push_url("https://b.example/".into(), None);
        session.go_back();
        session.mark_loaded(None);
        let attempt = PendingNavigation {
            id: 2,
            session_id: session.id.clone(),
            rollback: session.clone(),
            kind: PendingNavigationKind::Push,
            blocked: Mutex::new(None),
        };

        apply_pending_navigation(&mut session, &attempt, "https://c.example/", false).unwrap();
        attempt.mark_blocked(
            "http://blocked-redirect.example/".into(),
            "blocked redirect".into(),
        );
        rollback_pending_navigation(&mut session, &attempt);

        assert_eq!(session.url, "https://a.example/");
        assert_eq!(session.history.len(), 2);
        assert!(session.can_go_forward());
        assert_eq!(session.history[1].url, "https://b.example/");
    }

    #[test]
    fn download_filename_sanitization_removes_path_control() {
        assert_eq!(
            sanitize_download_filename("../../report:final.xlsx"),
            "_.._report_final.xlsx"
        );
        assert_eq!(sanitize_download_filename("..."), "download.bin");
    }

    #[test]
    fn download_hash_reports_sha256_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("download.bin");
        std::fs::write(&path, b"browser-download").unwrap();
        let (sha256, size) = hash_download_file_bounded(&path, 1024).unwrap();
        assert_eq!(sha256, hex::encode(Sha256::digest(b"browser-download")));
        assert_eq!(size, 16);
    }

    #[test]
    fn reused_session_download_owner_tracks_current_caller() {
        let mut session = BrowserSession::new(
            "bs_reused".into(),
            "https://example.com".into(),
            PathBuf::from("/tmp/profile"),
            Some("chat-old".into()),
            None,
        );
        update_reused_download_owner(&mut session, true, Some("chat-new".into()));
        session.control_mode = crate::browser::ControlMode::Agent;
        assert_eq!(session.chat_session_id.as_deref(), Some("chat-new"));
        assert_eq!(
            download_owner_for_session(Some(&session), "bs_reused")
                .unwrap()
                .as_deref(),
            Some("chat-new")
        );
        assert!(download_owner_for_session(Some(&session), "bs_stale").is_err());
        session.chat_session_id = None;
        assert!(download_owner_for_session(Some(&session), "bs_reused").is_err());
        update_reused_download_owner(&mut session, false, Some("ignored".into()));
        session.control_mode = crate::browser::ControlMode::User;
        assert!(session.chat_session_id.is_none());
        assert_eq!(
            download_owner_for_session(Some(&session), "bs_reused").unwrap(),
            None
        );
    }

    #[test]
    fn download_budgets_reserve_pending_and_count_completed_bytes() {
        assert!(task_download_budget_available(
            0,
            3 * MAX_BROWSER_DOWNLOAD_BYTES
        ));
        assert!(!task_download_budget_available(
            0,
            4 * MAX_BROWSER_DOWNLOAD_BYTES
        ));
        assert!(!task_download_budget_available(
            MAX_BROWSER_TASK_DOWNLOAD_BYTES - MAX_BROWSER_DOWNLOAD_BYTES + 1,
            0
        ));

        let mut reservations =
            HashMap::from([("chat-a".to_string(), 2 * MAX_BROWSER_DOWNLOAD_BYTES)]);
        release_task_download_reservation(&mut reservations, "chat-a");
        assert_eq!(reservations["chat-a"], MAX_BROWSER_DOWNLOAD_BYTES);
        release_task_download_reservation(&mut reservations, "chat-a");
        assert!(!reservations.contains_key("chat-a"));
    }

    #[test]
    fn bounded_download_hash_rejects_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.bin");
        std::fs::write(&path, vec![0u8; 1025]).unwrap();
        assert_eq!(
            hash_download_file_bounded(&path, 1024).unwrap_err(),
            "download exceeds per-file byte limit"
        );
    }
}
