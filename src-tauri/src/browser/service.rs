//! BrowserService — 一期单 session 运行时
//!
//! - 持 [`AppHandle`]；lazy 依赖 [`BrowserDatabase`]（首次 open 才 `ensure_open`）
//! - Content 窗 label 固定 [`BROWSER_CONTENT_LABEL`]
//! - 双闸：settings（`desktop.workbenchMode` + `desktop.workbenchBrowserEnabled`）
//!   + feature flag `ui.workbench_browser`
//!
//! B1d 接线：`window::bridge_init_script` / 后续 `BridgeClient` 方法挂本服务。
//! B1e 接线：commands 调本服务公开方法；setup 中 `manage(Arc<BrowserService>)` + `boot_cleanup`。

use std::sync::{Arc, Mutex, Weak};

use tauri::{AppHandle, Manager, WindowEvent};
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

use crate::commands::AppState;
use crate::feature_flags::FeatureFlagManager;

use super::database::BrowserDatabase;
use super::error::{BrowserError, BrowserResult};
use super::events::{
    emit_closed, emit_control_mode_changed, emit_navigated, emit_title_changed, now_rfc3339,
    BrowserClosedPayload, BrowserControlModeChangedPayload, BrowserNavigatedPayload,
    BrowserTitleChangedPayload,
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

/// 内置浏览器运行时服务（一期全局 0..1 session）
pub struct BrowserService {
    app: AppHandle,
    /// Lazy：构造时可不打开；`open_session` 内 `ensure_open`
    db: Arc<BrowserDatabase>,
    session: Mutex<Option<BrowserSession>>,
    navigation_policy: NavigationPolicyHandle,
}

impl BrowserService {
    /// 使用已解析的 [`BrowserDatabase`]（通常尚未 `ensure_open`）
    pub fn new(app: AppHandle, db: Arc<BrowserDatabase>) -> Arc<Self> {
        Arc::new(Self {
            app,
            db,
            session: Mutex::new(None),
            navigation_policy: NavigationPolicyHandle::new(),
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
    pub async fn assert_gates_open(&self) -> BrowserResult<()> {
        let app_state = self
            .app
            .try_state::<AppState>()
            .ok_or_else(|| BrowserError::Validation("AppState not available".into()))?;

        let workbench = app_state
            .database
            .get_setting(SETTING_WORKBENCH_MODE)
            .map_err(|e| BrowserError::Database(e.to_string()))?
            .unwrap_or_else(|| "false".into());
        if !is_truthy(&workbench) {
            drop(app_state);
            return self
                .reject_closed_gate("browser disabled: desktop.workbenchMode is off")
                .await;
        }

        let enabled = app_state
            .database
            .get_setting(SETTING_BROWSER_ENABLED)
            .map_err(|e| BrowserError::Database(e.to_string()))?
            .unwrap_or_else(|| "false".into());
        if !is_truthy(&enabled) {
            drop(app_state);
            return self
                .reject_closed_gate("browser disabled: desktop.workbenchBrowserEnabled is off")
                .await;
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
        cfg!(target_os = "windows")
    }

    fn ensure_agent_automation_supported(&self) -> BrowserResult<()> {
        if Self::agent_automation_supported() {
            Ok(())
        } else {
            Err(BrowserError::Validation(
                "browser agent automation unsupported: result bridge is available on Windows only"
                    .into(),
            ))
        }
    }

    /// `desktop.workbenchBrowserNetworkMode == "full"` → 允许非 loopback http
    fn allow_insecure_http(&self) -> bool {
        let Some(app_state) = self.app.try_state::<AppState>() else {
            return false;
        };
        match app_state.database.get_setting(SETTING_BROWSER_NETWORK_MODE) {
            Ok(Some(mode)) => mode.trim().eq_ignore_ascii_case("full"),
            _ => false,
        }
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
                    let _ = window::focus_content_window(&self.app);
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
            options.chat_session_id.clone(),
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

        let hooks = self.make_window_hooks();
        self.navigation_policy
            .set_agent_private_network_guard(from_agent);
        let win = window::get_or_create_content_window(
            &self.app,
            ContentWindowOptions {
                url: parsed,
                title: title.clone(),
                width,
                height,
                focused,
                profile_dir,
                allow_insecure_http: allow_http,
                navigation_policy: self.navigation_policy.clone(),
                initialization_script: window::bridge_init_script(),
            },
            Some(hooks),
        )
        .map_err(BrowserError::Validation)?;

        self.attach_destroy_listener(&win, session_id.clone());

        {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            *guard = Some(session.clone());
        }

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
        let session_id = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let Some(mut session) = guard.take() else {
                // 仍尝试毁窗，避免孤儿
                return window::destroy_content_window(&self.app).map_err(BrowserError::Validation);
            };
            session.mark_closed();
            session.id
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
        let state = {
            let mut guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = guard
                .as_mut()
                .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
            if session.id != session_id {
                return Err(BrowserError::NotFound(format!(
                    "session {session_id} (active is {})",
                    session.id
                )));
            }
            // Do not commit history until the WebView accepts the navigation call.
            win.navigate(parsed)
                .map_err(|e| BrowserError::Validation(format!("navigate failed: {e}")))?;
            if replace {
                session.replace_url(url.to_string(), None);
            } else {
                session.push_url(url.to_string(), None);
            }
            session.snapshot()
        };

        if self.db.is_open() {
            let persist_result = if replace {
                BrowserRepository::update_current_history(
                    &self.db,
                    session_id,
                    state.history_index as i64,
                    Some(url),
                    None,
                )
            } else {
                // Push against the previously persisted index before mirroring the new state.
                BrowserRepository::push_history(
                    &self.db,
                    session_id,
                    &BrowserHistoryPush {
                        url: url.to_string(),
                        title: None,
                        transition: Some("link".into()),
                        typed: false,
                    },
                )
                .map(|_| ())
            };
            if let Err(error) = persist_result {
                warn!("[browser] persist navigation failed: {}", error);
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
                loading: state.loading,
                at: now_rfc3339(),
            },
        );
        Ok(state)
    }

    pub async fn back(&self, session_id: &str) -> BrowserResult<BrowserSessionState> {
        self.assert_gates_open().await?;
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
        {
            let guard = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = guard
                .as_ref()
                .ok_or_else(|| BrowserError::NotFound(format!("session {session_id}")))?;
            if session.id != session_id {
                return Err(BrowserError::NotFound(format!("session {session_id}")));
            }
        }
        window::focus_content_window(&self.app).map_err(BrowserError::Validation)
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
        self.navigation_policy
            .set_agent_private_network_guard(false);
        session.take_over();
        let state = session.snapshot();
        drop(guard);
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
        Ok(state)
    }

    /// Agent 工具开始操控时切到 Agent 控制态（清除接管闩锁）并 emit 事件
    pub fn set_agent_control(&self) -> BrowserResult<BrowserSessionState> {
        self.ensure_agent_automation_supported()?;
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
        policy::allow_navigation_with_options(url, allow_insecure_http)
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

    fn make_window_hooks(self: &Arc<Self>) -> ContentWindowHooks {
        let weak: Weak<BrowserService> = Arc::downgrade(self);
        let weak_title = weak.clone();
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
        }
    }

    fn on_page_finished(&self, url: String) {
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
            let persist_result = if page_initiated_navigation {
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
        if self.db.is_open() {
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

    fn attach_destroy_listener(&self, win: &tauri::WebviewWindow, session_id: String) {
        let app = self.app.clone();
        let navigation_policy = self.navigation_policy.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::Destroyed = event {
                navigation_policy.set_agent_private_network_guard(false);
                // 用户点关 content 窗：清内存 session + 发 closed
                // 通过 try_state 取服务，避免循环持有
                if let Some(svc) = app.try_state::<Arc<BrowserService>>() {
                    let mut guard = svc.session.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(session) = guard.as_mut() {
                        if session.id == session_id && session.alive {
                            session.mark_closed();
                            let id = session.id.clone();
                            *guard = None;
                            drop(guard);
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
            }
        });
    }
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
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

    #[test]
    fn content_label_is_fixed() {
        assert_eq!(BrowserService::content_label(), "browser-content");
    }

    #[test]
    fn agent_automation_capability_matches_platform() {
        assert_eq!(
            BrowserService::agent_automation_supported(),
            cfg!(target_os = "windows")
        );
    }
}
