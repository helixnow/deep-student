//! Super 会话 Tauri 命令（app 以 `crate::chat_v2::super_session::commands::*` 注册）。

use std::sync::Arc;

use tauri::{AppHandle, Manager, State, Window};

use super::inbox::{deliver_inbox, DeliverInboxRequest, DeliverOutcome};
use super::state::{
    self, main_db_from_app, read_settings, write_settings, SuperSessionSettings, SuperSessionState,
};
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::pipeline::ChatV2Pipeline;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::workspace::WorkspaceCoordinator;

/// 当前状态（启用时顺带幂等 ensure）。
#[tauri::command]
pub async fn super_session_get_state(app: AppHandle) -> Result<SuperSessionState, String> {
    Ok(state::get_state(&app))
}

/// 开关：开启 ensure + 发 super_session_changed；关闭取消活跃 Worker、隐藏会话 + 发事件。
#[tauri::command]
pub async fn super_session_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<SuperSessionState, String> {
    state::set_enabled(&app, enabled)
}

/// 确保活跃 Super 会话存在（仅在已启用时；未启用返回 enabled=false 的状态）。
#[tauri::command]
pub async fn super_session_ensure(app: AppHandle) -> Result<SuperSessionState, String> {
    if !state::is_enabled(&app) {
        return Ok(state::disabled_state());
    }
    let result = state::ensure(&app)?;
    state::emit_changed(&app, true, result.session_id.as_deref());
    Ok(result)
}

#[tauri::command]
pub async fn super_session_get_settings(app: AppHandle) -> Result<SuperSessionSettings, String> {
    let main_db = main_db_from_app(&app).ok_or_else(|| "主数据库未初始化".to_string())?;
    Ok(read_settings(&main_db))
}

#[tauri::command]
pub async fn super_session_set_settings(
    app: AppHandle,
    settings: SuperSessionSettings,
) -> Result<(), String> {
    let main_db = main_db_from_app(&app).ok_or_else(|| "主数据库未初始化".to_string())?;
    write_settings(&main_db, &settings)
}

/// 把 Super 工作区收件箱投递为一条持久化 user 消息并开启流式回合。
#[tauri::command]
pub async fn chat_v2_super_deliver_inbox(
    request: DeliverInboxRequest,
    window: Window,
    db: State<'_, Arc<ChatV2Database>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    coordinator: State<'_, Arc<WorkspaceCoordinator>>,
) -> Result<DeliverOutcome, String> {
    log::info!(
        "[SuperSession] chat_v2_super_deliver_inbox: session_id={}, force={}",
        request.session_id,
        request.force
    );
    let main_db = main_db_from_app(window.app_handle());
    deliver_inbox(
        &window,
        db.inner(),
        chat_v2_state.inner(),
        pipeline.inner(),
        coordinator.inner().as_ref(),
        main_db.as_deref(),
        request,
    )
}
