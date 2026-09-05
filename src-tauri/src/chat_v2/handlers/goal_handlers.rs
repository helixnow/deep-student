//! Goal 模式 Tauri 命令处理器（P0）
//!
//! 提供会话级持久目标的用户侧 IPC 入口：
//! - `chat_v2_goal_get`: 读取当前目标（只读，无目标返回 null）
//! - `chat_v2_goal_pause`: 暂停目标（active / waiting_user → paused）
//! - `chat_v2_goal_resume`: 恢复目标（paused / blocked / budget_limited /
//!   usage_limited → active），并触发一轮续跑（若空闲）
//! - `chat_v2_goal_edit`: 编辑目标描述与 token 预算（不改 status）
//! - `chat_v2_goal_clear`: 清除目标
//!
//! ## 权限划分
//! 本模块是用户/系统侧入口；模型侧只能经 `goal_update` 工具设
//! complete / blocked / waiting_user（见 tools/goal_executor.rs）。
//!
//! ## 事件
//! 状态变更后向 `chat_v2_session_{session_id}` 通道发射 `goal_updated`
//! （payload 由 `events::build_goal_updated_payload` 构造；goal=null 表示
//! 已清除）。仅在记录实际发生变化时发射（无操作返回现状不发射）。

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State, Window};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::events::build_goal_updated_payload;
use crate::chat_v2::handlers::ensure_session_writable;
use crate::chat_v2::repo::{ChatV2Repo, GoalRecord};

// ============================================================================
// 事件发射
// ============================================================================

/// 向会话级通道发射 goal_updated 事件（emit 失败仅告警，不影响命令结果）
fn emit_goal_updated(window: &Window, session_id: &str, goal: Option<&GoalRecord>) {
    let channel = format!("chat_v2_session_{}", session_id);
    let payload = build_goal_updated_payload(session_id, goal);
    if let Err(e) = window.emit(&channel, &payload) {
        log::warn!(
            "[ChatV2::GoalHandler] Failed to emit goal_updated event: {}",
            e
        );
    }
}

// ============================================================================
// 命令
// ============================================================================

/// 读取会话目标（只读；无目标返回 None）。
///
/// 只读入口不加 `ensure_session_writable` 写守卫（与 chat_v2_get_session
/// 等读命令一致）：子代理会话读取目标返回 null 而非报错。
#[tauri::command]
pub async fn chat_v2_goal_get(
    db: State<'_, Arc<ChatV2Database>>,
    session_id: String,
) -> Result<Option<GoalRecord>, String> {
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::goal_get_with_conn(&conn, &session_id).map_err(String::from)
}

/// 暂停目标：active / waiting_user → paused；其余状态原样返回。
#[tauri::command]
pub async fn chat_v2_goal_pause(
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
    session_id: String,
) -> Result<GoalRecord, String> {
    ensure_session_writable(&db, &session_id).map_err(String::from)?;
    let conn = db.get_conn_safe().map_err(String::from)?;
    let goal = ChatV2Repo::goal_get_with_conn(&conn, &session_id)
        .map_err(String::from)?
        .ok_or_else(|| {
            String::from(ChatV2Error::Validation(
                "cannot pause goal because this session has no goal".to_string(),
            ))
        })?;

    if !matches!(goal.status.as_str(), "active" | "waiting_user") {
        return Ok(goal);
    }

    let updated =
        ChatV2Repo::goal_update_status_with_conn(&conn, &session_id, &goal.goal_id, "paused")
            .map_err(String::from)?
            .ok_or_else(|| {
                String::from(ChatV2Error::Validation(
                    "goal was modified concurrently; please retry".to_string(),
                ))
            })?;

    log::info!(
        "[ChatV2::GoalHandler] Goal paused: session={}, goal_id={}",
        session_id,
        updated.goal_id
    );
    emit_goal_updated(&window, &session_id, Some(&updated));
    Ok(updated)
}

/// 恢复目标：paused / blocked / budget_limited / usage_limited → active，
/// 然后触发一轮续跑（goal 运行时内部做空闲/预算检查）。其余状态原样返回。
#[tauri::command]
pub async fn chat_v2_goal_resume(
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
    app: AppHandle,
    session_id: String,
) -> Result<GoalRecord, String> {
    ensure_session_writable(&db, &session_id).map_err(String::from)?;
    let goal = {
        let conn = db.get_conn_safe().map_err(String::from)?;
        let goal = ChatV2Repo::goal_get_with_conn(&conn, &session_id)
            .map_err(String::from)?
            .ok_or_else(|| {
                String::from(ChatV2Error::Validation(
                    "cannot resume goal because this session has no goal".to_string(),
                ))
            })?;

        if !matches!(
            goal.status.as_str(),
            "paused" | "blocked" | "budget_limited" | "usage_limited"
        ) {
            return Ok(goal);
        }

        ChatV2Repo::goal_update_status_with_conn(&conn, &session_id, &goal.goal_id, "active")
            .map_err(String::from)?
            .ok_or_else(|| {
                String::from(ChatV2Error::Validation(
                    "goal was modified concurrently; please retry".to_string(),
                ))
            })?
        // 连接在此作用域结束时归还连接池，再触发续跑
    };

    log::info!(
        "[ChatV2::GoalHandler] Goal resumed: session={}, goal_id={}",
        session_id,
        goal.goal_id
    );
    emit_goal_updated(&window, &session_id, Some(&goal));
    crate::chat_v2::goal::runtime::spawn_goal_continuation_if_idle(app, session_id);
    Ok(goal)
}

/// 编辑目标描述与 token 预算（不改 status）。
///
/// complete 目标不可编辑（先 clear 再重建）；其余状态均可编辑。
#[tauri::command]
pub async fn chat_v2_goal_edit(
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
    session_id: String,
    objective: String,
    token_budget: Option<i64>,
) -> Result<GoalRecord, String> {
    ensure_session_writable(&db, &session_id).map_err(String::from)?;

    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return Err(String::from(ChatV2Error::Validation(
            "objective 不能为空".to_string(),
        )));
    }
    if let Some(budget) = token_budget {
        if budget <= 0 {
            return Err(String::from(ChatV2Error::Validation(
                "token_budget 必须是正整数".to_string(),
            )));
        }
    }

    let conn = db.get_conn_safe().map_err(String::from)?;
    let existing = ChatV2Repo::goal_get_with_conn(&conn, &session_id)
        .map_err(String::from)?
        .ok_or_else(|| {
            String::from(ChatV2Error::Validation(
                "cannot edit goal because this session has no goal".to_string(),
            ))
        })?;
    if existing.status == "complete" {
        return Err(String::from(ChatV2Error::Validation(
            "cannot edit a completed goal; clear it first and create a new one".to_string(),
        )));
    }

    let updated =
        ChatV2Repo::goal_update_objective_with_conn(&conn, &session_id, &objective, token_budget)
            .map_err(String::from)?
            .ok_or_else(|| {
                String::from(ChatV2Error::Validation(
                    "goal was modified concurrently; please retry".to_string(),
                ))
            })?;

    log::info!(
        "[ChatV2::GoalHandler] Goal edited: session={}, goal_id={}",
        session_id,
        updated.goal_id
    );
    emit_goal_updated(&window, &session_id, Some(&updated));
    Ok(updated)
}

/// 清除会话目标（不存在时静默成功）；发射 goal=null 的 goal_updated。
#[tauri::command]
pub async fn chat_v2_goal_clear(
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
    session_id: String,
) -> Result<(), String> {
    ensure_session_writable(&db, &session_id).map_err(String::from)?;
    let conn = db.get_conn_safe().map_err(String::from)?;
    ChatV2Repo::goal_delete_with_conn(&conn, &session_id).map_err(String::from)?;

    log::info!("[ChatV2::GoalHandler] Goal cleared: session={}", session_id);
    emit_goal_updated(&window, &session_id, None);
    Ok(())
}
