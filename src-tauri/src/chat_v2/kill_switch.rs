//! 全局 Agent Kill Switch（一键断电）
//!
//! 提供原子级「停掉一切 agent 活动」入口，作为后续远程指挥的安全底座。
//!
//! ## 行为
//! - `emergency_stop`：trip → 取消全部 active streams → pause 自动化调度 →
//!   取消进行中的 automation runs → 系统通知 + 事件广播
//! - `resume_agents`：仅复位 Kill Switch；自动化调度保持 pause，需用户再确认
//! - 准入闸：interactive send / headless turn / stream 注册 / automation 派发

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use super::automations::{
    cancel_active_automation_runs_for_emergency_stop, is_automation_scheduler_paused,
    pause_automation_scheduler, resume_automation_scheduler,
};
use super::state::ChatV2State;

/// 前端 / 错误消息共用的明确错误串（headless / send_message 准入失败）
pub const KILL_SWITCH_BLOCKED_MESSAGE: &str =
    "AgentKillSwitch tripped: all agent activity is stopped. Call chat_v2_resume_agents to resume.";

/// Kill Switch 状态变更事件（前端 AgentControlCenter 订阅）
pub const KILL_SWITCH_CHANGED_EVENT: &str = "chat_v2://kill_switch_changed";

/// 全局一键断电开关
#[derive(Debug, Default)]
pub struct AgentKillSwitch {
    tripped: AtomicBool,
    tripped_at_ms: Mutex<Option<u64>>,
    reason: Mutex<Option<String>>,
}

impl AgentKillSwitch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    /// Trip the switch. Returns `true` if this call newly tripped it.
    pub fn trip(&self, reason: impl Into<String>) -> bool {
        let was_clear = !self.tripped.swap(true, Ordering::SeqCst);
        let reason = reason.into();
        let now_ms = unix_now_ms();
        if let Ok(mut guard) = self.tripped_at_ms.lock() {
            if guard.is_none() || was_clear {
                *guard = Some(now_ms);
            }
        }
        if let Ok(mut guard) = self.reason.lock() {
            if was_clear || guard.is_none() {
                *guard = Some(reason);
            }
        }
        was_clear
    }

    /// Explicit user resume. Does **not** unpause automations.
    pub fn reset(&self) {
        self.tripped.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.tripped_at_ms.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.reason.lock() {
            *guard = None;
        }
    }

    pub fn ensure_allowed(&self) -> Result<(), String> {
        if self.is_tripped() {
            Err(KILL_SWITCH_BLOCKED_MESSAGE.to_string())
        } else {
            Ok(())
        }
    }

    pub fn status_snapshot(&self) -> KillSwitchStatus {
        let tripped = self.is_tripped();
        KillSwitchStatus {
            tripped,
            kill_switch_tripped: tripped,
            tripped_at_ms: self.tripped_at_ms.lock().ok().and_then(|guard| *guard),
            reason: self.reason.lock().ok().and_then(|guard| guard.clone()),
            automations_paused: is_automation_scheduler_paused(),
            cancelled_streams: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillSwitchStatus {
    pub tripped: bool,
    /// Explicit alias of `tripped` (serialized as `killSwitchTripped`) so
    /// frontend consumers can distinguish "kill switch tripped" from
    /// "automations paused" without relying on the legacy `tripped` name.
    pub kill_switch_tripped: bool,
    pub tripped_at_ms: Option<u64>,
    pub reason: Option<String>,
    pub automations_paused: bool,
    /// Only populated by `emergency_stop` (how many streams were cancelled).
    #[serde(skip_serializing_if = "is_zero")]
    pub cancelled_streams: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_kill_switch_changed(app_handle: &AppHandle, status: &KillSwitchStatus) {
    if let Err(error) = app_handle.emit(KILL_SWITCH_CHANGED_EVENT, status) {
        log::warn!(
            "[ChatV2::kill_switch] Failed to emit {}: {}",
            KILL_SWITCH_CHANGED_EVENT,
            error
        );
    }
}

fn send_emergency_notification(app_handle: &AppHandle, reason: &str) {
    // 用户全局「从不」系统通知档：紧急停止的结果在应用内（事件 + UI）已可见，
    // 尊重策略不再发 OS 通知。
    if crate::system_notification::notifications_disabled_for_app(app_handle) {
        log::info!(
            "[ChatV2::kill_switch] system notifications disabled by policy; skipped emergency notification"
        );
        return;
    }
    let body = if reason.trim().is_empty() {
        "All agent streams cancelled. Automations paused until you resume.".to_string()
    } else {
        format!(
            "All agent streams cancelled. Automations paused. Reason: {}",
            reason.trim()
        )
    };
    if let Err(error) = app_handle
        .notification()
        .builder()
        .title("Agent emergency stop")
        .body(body)
        .show()
    {
        log::warn!(
            "[ChatV2::kill_switch] Failed to show emergency notification: {}",
            error
        );
    }
}

/// 紧急停止：取消全部流、拒绝新活动、暂停自动化调度。
#[tauri::command]
pub async fn chat_v2_emergency_stop(
    reason: Option<String>,
    app_handle: AppHandle,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<KillSwitchStatus, String> {
    let reason = reason
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "user_emergency_stop".to_string());

    let newly_tripped = chat_v2_state.kill_switch.trip(reason.clone());
    pause_automation_scheduler();
    let cancelled_streams = chat_v2_state.cancel_all_streams();
    cancel_active_automation_runs_for_emergency_stop();

    // 🆕 取消语义贯通：脱管的 ChatAnki 后台制卡管线不持有 stream token，
    // 必须枚举活跃管线注册表逐一取消（非破坏性：保留已生成卡片）。
    let cancelled_chatanki_pipelines =
        super::tools::chatanki_executor::cancel_all_active_chatanki_pipelines(&reason);

    // 🆕 B2：挂起的工具审批全部以拒绝结果 drain（等待方立即解除阻塞，而非等超时）
    let rejected_approvals = app_handle
        .try_state::<Arc<super::approval_manager::ApprovalManager>>()
        .map(|manager| manager.reject_all_pending(&reason))
        .unwrap_or(0);

    // 🆕 B2：workspace 活跃 worker 状态落库为 Cancelled，防止重启 restore 复活
    let cancelled_workers = app_handle
        .try_state::<Arc<super::workspace::WorkspaceCoordinator>>()
        .map(|coordinator| {
            super::handlers::workspace_handlers::mark_all_workers_cancelled(
                coordinator.inner(),
                &chat_v2_state,
                &reason,
            )
        })
        .unwrap_or(0);

    if newly_tripped {
        send_emergency_notification(&app_handle, &reason);
    }

    let mut status = chat_v2_state.kill_switch.status_snapshot();
    status.cancelled_streams = cancelled_streams;
    emit_kill_switch_changed(&app_handle, &status);

    log::warn!(
        "[ChatV2::kill_switch] emergency_stop: newly_tripped={}, cancelled_streams={}, rejected_approvals={}, cancelled_workers={}, cancelled_chatanki_pipelines={}, reason={}",
        newly_tripped,
        cancelled_streams,
        rejected_approvals,
        cancelled_workers,
        cancelled_chatanki_pipelines,
        reason
    );

    Ok(status)
}

/// 显式恢复 Agent 准入。自动化调度保持 pause，需 `chat_v2_resume_automations`。
#[tauri::command]
pub async fn chat_v2_resume_agents(
    app_handle: AppHandle,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<KillSwitchStatus, String> {
    chat_v2_state.kill_switch.reset();
    // Intentionally keep automations paused until the user confirms separately.
    let status = chat_v2_state.kill_switch.status_snapshot();
    emit_kill_switch_changed(&app_handle, &status);
    log::info!(
        "[ChatV2::kill_switch] resume_agents: automations_paused={}",
        status.automations_paused
    );
    Ok(status)
}

/// 单独恢复自动化调度（Kill Switch 必须已复位）。
#[tauri::command]
pub async fn chat_v2_resume_automations(
    app_handle: AppHandle,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<KillSwitchStatus, String> {
    if chat_v2_state.kill_switch.is_tripped() {
        return Err(
            "Cannot resume automations while AgentKillSwitch is still tripped. Call chat_v2_resume_agents first."
                .to_string(),
        );
    }
    resume_automation_scheduler();
    let status = chat_v2_state.kill_switch.status_snapshot();
    emit_kill_switch_changed(&app_handle, &status);
    log::info!("[ChatV2::kill_switch] resume_automations");
    Ok(status)
}

#[tauri::command]
pub async fn chat_v2_kill_switch_status(
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<KillSwitchStatus, String> {
    Ok(chat_v2_state.kill_switch.status_snapshot())
}

/// Convenience for headless / other modules that already hold `ChatV2State`.
pub fn admit_or_block(state: &ChatV2State) -> Result<(), String> {
    state.kill_switch.ensure_allowed()
}

/// Error surfaced when the kill-switch gate cannot verify admission because
/// ChatV2State is not managed (degraded startup). Fail-closed by design.
pub const KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE: &str =
    "AgentKillSwitch gate: ChatV2State is unavailable, admission denied (fail-closed).";

/// Resolve ChatV2State from AppHandle and enforce the kill switch.
///
/// **Fail-closed**: when ChatV2State is not managed (degraded startup /
/// partially-initialized AppHandle), admission is DENIED instead of silently
/// bypassing the kill switch. Callers:
/// - automation scheduled dispatch gate (`automations.rs`)
/// - automation manual-run gate (`automations.rs`)
/// - headless turn admission (`headless.rs`) — which would fail immediately
///   afterwards anyway when resolving `ChatV2Database` from the same degraded
///   AppHandle, so failing closed here does not change effective behavior.
///
/// Interactive send paths are unaffected: they receive `State<Arc<ChatV2State>>`
/// via Tauri command injection and never go through this resolver.
pub fn admit_or_block_from_app(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<Arc<ChatV2State>>() else {
        log::error!(
            "[ChatV2::kill_switch] admit_or_block_from_app: ChatV2State not managed; \
             failing closed and denying admission (automation dispatch / headless turn blocked)"
        );
        return Err(KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE.to_string());
    };
    admit_or_block(state.inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::automations::{
        is_automation_scheduler_paused, pause_automation_scheduler, resume_automation_scheduler,
    };
    use crate::chat_v2::state::ChatV2State;

    #[test]
    fn trip_rejects_register_stream() {
        let state = ChatV2State::new();
        assert!(state.try_register_stream("sess_ks_1").is_ok());
        state.remove_stream("sess_ks_1");

        assert!(state.kill_switch.trip("unit_test"));
        assert!(
            state.try_register_stream("sess_ks_2").is_err(),
            "register_stream must be rejected after kill switch trip"
        );
        assert!(!state.has_active_stream("sess_ks_2"));
        assert!(state.kill_switch.ensure_allowed().is_err());
    }

    #[test]
    fn trip_blocks_headless_admission_with_explicit_error() {
        let state = ChatV2State::new();
        state.kill_switch.trip("headless_gate");
        let err = admit_or_block(&state).expect_err("headless must be blocked");
        assert!(
            err.contains("AgentKillSwitch"),
            "headless error must mention AgentKillSwitch, got: {}",
            err
        );
        assert_eq!(err, KILL_SWITCH_BLOCKED_MESSAGE);
    }

    #[test]
    fn trip_pauses_automation_dispatch_gate() {
        // Ensure clean start (other tests may have paused).
        resume_automation_scheduler();
        assert!(
            crate::chat_v2::automations::automation_dispatch_allowed(),
            "dispatch should be allowed before emergency pause"
        );

        let state = ChatV2State::new();
        state.kill_switch.trip("automation_gate");
        pause_automation_scheduler();

        assert!(
            !crate::chat_v2::automations::automation_dispatch_allowed(),
            "automation dispatch must skip while scheduler is paused"
        );
        assert!(is_automation_scheduler_paused());

        // resume_agents keeps automations paused
        state.kill_switch.reset();
        assert!(state.kill_switch.ensure_allowed().is_ok());
        assert!(
            !crate::chat_v2::automations::automation_dispatch_allowed(),
            "automations must stay paused after resume_agents"
        );

        resume_automation_scheduler();
        assert!(crate::chat_v2::automations::automation_dispatch_allowed());
    }

    #[test]
    fn cancel_all_streams_cancels_active_tokens() {
        let state = ChatV2State::new();
        let token_a = state.try_register_stream("sess_a").unwrap();
        let token_b = state.try_register_stream("sess_b").unwrap();
        let cancelled = state.cancel_all_streams();
        assert_eq!(cancelled, 2);
        assert!(token_a.is_cancelled());
        assert!(token_b.is_cancelled());
        assert_eq!(state.active_stream_count(), 0);
    }

    /// B2（一键断电）：emergency_stop 的 workspace 断电路径 —— trip + cancel_all_streams +
    /// mark_all_workers_cancelled 之后，活跃 worker 状态必须落库为 Cancelled。
    /// （完整 Tauri 命令需要 AppHandle；这里以真实 Coordinator/State 复现命令内的同一调用序列。）
    #[test]
    fn emergency_stop_path_marks_active_workers_cancelled() {
        use crate::chat_v2::handlers::workspace_handlers::mark_all_workers_cancelled;
        use crate::chat_v2::workspace::{AgentRole, AgentStatus, WorkspaceCoordinator};

        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let coordinator = WorkspaceCoordinator::new(temp_dir.path().to_path_buf());
        let workspace = coordinator
            .create_workspace("coord_sess", Some("ks-test".to_string()))
            .expect("create workspace");
        coordinator
            .register_agent(
                &workspace.id,
                "coord_sess",
                AgentRole::Coordinator,
                None,
                None,
            )
            .expect("register coordinator");
        coordinator
            .register_agent(&workspace.id, "worker_run", AgentRole::Worker, None, None)
            .expect("register running worker");
        coordinator
            .update_agent_status(&workspace.id, "worker_run", AgentStatus::Running)
            .expect("mark running");
        coordinator
            .register_agent(
                &workspace.id,
                "worker_queued",
                AgentRole::Worker,
                None,
                None,
            )
            .expect("register queued worker");
        coordinator
            .update_agent_status(&workspace.id, "worker_queued", AgentStatus::Queued)
            .expect("mark queued");

        // 与 chat_v2_emergency_stop 相同的调用序列
        let state = ChatV2State::new();
        let worker_token = state.try_register_stream("worker_run").expect("stream");
        state.kill_switch.trip("emergency_stop_test");
        let cancelled_streams = state.cancel_all_streams();
        assert_eq!(cancelled_streams, 1);
        assert!(worker_token.is_cancelled());

        let cancelled_workers =
            mark_all_workers_cancelled(&coordinator, &state, "emergency_stop_test");
        assert_eq!(
            cancelled_workers, 2,
            "running + queued workers must be cancelled"
        );

        let agents = coordinator
            .list_agents(&workspace.id)
            .expect("list agents after emergency stop");
        for worker in agents
            .iter()
            .filter(|a| matches!(a.role, AgentRole::Worker))
        {
            assert_eq!(
                worker.status,
                AgentStatus::Cancelled,
                "worker {} must be Cancelled after emergency stop",
                worker.session_id
            );
        }
        // coordinator 角色不受影响
        let coord = agents
            .iter()
            .find(|a| matches!(a.role, AgentRole::Coordinator))
            .expect("coordinator agent");
        assert_ne!(coord.status, AgentStatus::Cancelled);

        // 幂等：再次调用无新增取消
        assert_eq!(
            mark_all_workers_cancelled(&coordinator, &state, "emergency_stop_test"),
            0
        );

        state.kill_switch.reset();
    }

    #[test]
    fn status_snapshot_reports_trip_metadata() {
        let ks = AgentKillSwitch::new();
        assert!(!ks.status_snapshot().tripped);
        ks.trip("reason-x");
        let status = ks.status_snapshot();
        assert!(status.tripped);
        assert_eq!(
            status.kill_switch_tripped, status.tripped,
            "killSwitchTripped must mirror tripped"
        );
        assert_eq!(status.reason.as_deref(), Some("reason-x"));
        assert!(status.tripped_at_ms.is_some());
        ks.reset();
        let cleared = ks.status_snapshot();
        assert!(!cleared.tripped);
        assert!(!cleared.kill_switch_tripped);
        assert!(cleared.reason.is_none());
    }

    #[test]
    fn status_serializes_independent_pause_and_trip_fields() {
        let ks = AgentKillSwitch::new();
        ks.trip("serde-check");
        let json = serde_json::to_value(ks.status_snapshot()).expect("serialize status");
        assert_eq!(
            json.get("killSwitchTripped"),
            Some(&serde_json::json!(true))
        );
        assert!(
            json.get("automationsPaused").is_some(),
            "automationsPaused must be present as an independent field"
        );
        ks.reset();
    }
}
