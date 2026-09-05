//! Goal 续跑运行时
//!
//! 轮末挂钩（send/wake 的 spawn 闭包）与 goal_resume handler 共用入口
//! [`spawn_goal_continuation_if_idle`]：本轮结束、会话锁（StreamGuard）已
//! 释放后，若目标仍 active 则以 wake 语义自动起续跑轮，循环自持直到目标
//! 完成 / 暂停 / 阻塞 / 预算耗尽 / 会话被占用。
//!
//! 续跑轮本身**不经过** send/wake 的 spawn 闭包（直接调
//! `run_send_message_pipeline`），因此轮末挂钩不会对续跑轮递归触发；
//! 是否继续由本循环每轮重新读目标后决策。

use std::sync::Arc;

use tauri::{AppHandle, Manager, Window};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::pipeline::ChatV2Pipeline;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::types::{ChatMessage, SendMessageRequest, SendOptions};

/// 单个目标的最大自动续跑轮数（防止无限空转；超出后置 `budget_limited`）。
const MAX_GOAL_CONTINUATIONS: i64 = 20;

/// 轮末挂钩到续跑决策之间的静默窗口：等前端 stream_complete 的 32ms 静默
/// 期与本轮 DB 写入落定后再读目标做决策。
const CONTINUATION_DELAY_MS: u64 = 150;

/// fire-and-forget 入口：本轮结束后若目标仍 active，自动续跑。
///
/// 契约：Agent A 的 resume handler 经
/// `crate::chat_v2::goal::runtime::spawn_goal_continuation_if_idle` 调用。
/// 会话忙（已有活跃流）或 kill switch 生效时静默放弃，不改目标状态。
pub fn spawn_goal_continuation_if_idle(app: AppHandle, session_id: String) {
    crate::background_tasks::spawn(async move {
        run_continuation_loop(app, session_id).await;
    });
}

/// 交互轮以非 Ok 收场时结算目标（send/wake 轮末挂钩调用）：
/// 仅当目标仍 `active` 时翻转状态并广播——
/// - 用户取消 → `paused`（明确的停止语义，等待用户恢复）；
/// - 其他错误 → `blocked`。
///
/// 目标不存在 / 已非 active（如本轮内已被置 waiting_user/complete）时不动作。
pub(crate) fn settle_active_goal_on_turn_end(
    window: &Window,
    session_id: &str,
    new_status: &'static str,
) {
    let Some(db) = window
        .app_handle()
        .try_state::<Arc<ChatV2Database>>()
        .map(|state| state.inner().clone())
    else {
        return;
    };
    let conn = match db.get_conn() {
        Ok(conn) => conn,
        Err(e) => {
            tracing::warn!(
                "[ChatV2::goal] settle_active_goal_on_turn_end: get_conn failed (session={}): {}",
                session_id,
                e
            );
            return;
        }
    };
    let goal = match ChatV2Repo::goal_get_with_conn(&conn, session_id) {
        Ok(Some(goal)) => goal,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(
                "[ChatV2::goal] settle_active_goal_on_turn_end: load goal failed (session={}): {}",
                session_id,
                e
            );
            return;
        }
    };
    if goal.status != "active" {
        return;
    }
    update_goal_status_and_emit(&conn, window, session_id, &goal.goal_id, new_status);
}

/// 续跑主循环：每轮重新读目标并决策，Ok 续跑、Cancelled 暂停、其他错误阻塞。
async fn run_continuation_loop(app: AppHandle, session_id: String) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(CONTINUATION_DELAY_MS)).await;

        // —— 解析托管状态（任一缺失说明 Chat V2 降级运行，放弃续跑）——
        let Some(db) = app
            .try_state::<Arc<ChatV2Database>>()
            .map(|state| state.inner().clone())
        else {
            tracing::debug!(
                "[ChatV2::goal] ChatV2Database unavailable; stop continuation: session={}",
                session_id
            );
            return;
        };
        let Some(chat_v2_state) = app
            .try_state::<Arc<ChatV2State>>()
            .map(|state| state.inner().clone())
        else {
            tracing::debug!(
                "[ChatV2::goal] ChatV2State unavailable; stop continuation: session={}",
                session_id
            );
            return;
        };
        let Some(pipeline) = app
            .try_state::<Arc<ChatV2Pipeline>>()
            .map(|state| state.inner().clone())
        else {
            tracing::debug!(
                "[ChatV2::goal] ChatV2Pipeline unavailable; stop continuation: session={}",
                session_id
            );
            return;
        };
        // 管线事件通道强依赖具体 Window（同 headless 的评估）；无窗口时放弃。
        let Some(window) = resolve_emit_window(&app) else {
            tracing::warn!(
                "[ChatV2::goal] no window available; stop continuation: session={}",
                session_id
            );
            return;
        };

        // —— 读目标并决策（每轮重新读，用户可能已改/删目标）——
        let goal = {
            let conn = match db.get_conn() {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!(
                        "[ChatV2::goal] get_conn failed; stop continuation: session={}, error={}",
                        session_id,
                        e
                    );
                    return;
                }
            };
            match ChatV2Repo::goal_get_with_conn(&conn, &session_id) {
                Ok(goal) => goal,
                Err(e) => {
                    tracing::warn!(
                        "[ChatV2::goal] load goal failed; stop continuation: session={}, error={}",
                        session_id,
                        e
                    );
                    return;
                }
            }
        };
        let Some(goal) = goal else {
            tracing::debug!(
                "[ChatV2::goal] no goal; stop continuation: session={}",
                session_id
            );
            return;
        };
        if goal.status != "active" {
            tracing::debug!(
                "[ChatV2::goal] goal not active (status={}); stop continuation: session={}",
                goal.status,
                session_id
            );
            return;
        }

        // —— 预算护栏 ——
        if goal.continuation_count >= MAX_GOAL_CONTINUATIONS {
            tracing::warn!(
                "[ChatV2::goal] continuation count exhausted (count={}); goal → budget_limited: session={}",
                goal.continuation_count,
                session_id
            );
            let conn = match db.get_conn() {
                Ok(conn) => conn,
                Err(_) => return,
            };
            update_goal_status_and_emit(
                &conn,
                &window,
                &session_id,
                &goal.goal_id,
                "budget_limited",
            );
            return;
        }
        if let Some(budget) = goal.token_budget {
            if goal.tokens_used >= budget {
                tracing::warn!(
                    "[ChatV2::goal] token budget exhausted (used={} >= budget={}); goal → budget_limited: session={}",
                    goal.tokens_used,
                    budget,
                    session_id
                );
                let conn = match db.get_conn() {
                    Ok(conn) => conn,
                    Err(_) => return,
                };
                update_goal_status_and_emit(
                    &conn,
                    &window,
                    &session_id,
                    &goal.goal_id,
                    "budget_limited",
                );
                return;
            }
        }

        // —— 构造 wake 式请求（content 不落用户消息库，只落 assistant 消息）——
        // schema_tool_ids 显式注入 goal 三件套（tool_loop 会自动追加
        // attempt_completion）：保证续跑轮无需先 load_skills 即可标记
        // complete / blocked / waiting_user。
        let steering = super::steering::continuation_steering(&goal);
        let request = SendMessageRequest {
            session_id: session_id.clone(),
            content: steering,
            options: Some(SendOptions {
                skip_user_message_save: Some(true),
                schema_tool_ids: Some(vec![
                    "goal_create".to_string(),
                    "goal_update".to_string(),
                    "goal_get".to_string(),
                ]),
                ..Default::default()
            }),
            user_message_id: None,
            assistant_message_id: Some(ChatMessage::generate_id()),
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };

        // —— 原子注册流：会话忙 / kill switch 生效 → 放弃本次续跑（不改目标
        //    状态；下个交互轮末挂钩或 resume 会再次尝试）——
        let registration = match chat_v2_state.try_register_stream_owned(&session_id) {
            Ok(registration) => registration,
            Err(()) => {
                tracing::debug!(
                    "[ChatV2::goal] session busy or kill switch tripped; skip continuation: session={}",
                    session_id
                );
                return;
            }
        };
        let cancel_token = registration.token().clone();

        // 续跑计数 +1（带 expected goal_id 乐观并发）。计数失败只告警不阻断：
        // 计数是预算护栏而非精确账目。get_conn 失败则必须显式按 generation
        // 清理已注册的流再返回（StreamRegistration 本身无 Drop 清理语义）。
        {
            let conn = match db.get_conn() {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!(
                        "[ChatV2::goal] get_conn for continuation increment failed (session={}): {}",
                        session_id,
                        e
                    );
                    chat_v2_state
                        .remove_stream_if_generation(&session_id, registration.generation());
                    return;
                }
            };
            if let Err(e) =
                ChatV2Repo::goal_increment_continuation_with_conn(&conn, &session_id, &goal.goal_id)
            {
                tracing::warn!(
                    "[ChatV2::goal] increment continuation failed (session={}, goal={}): {}; continuing anyway",
                    session_id,
                    goal.goal_id,
                    e
                );
            }
        }

        let result = crate::chat_v2::handlers::send_message::run_send_message_pipeline(
            pipeline,
            chat_v2_state.clone(),
            window.clone(),
            request,
            cancel_token,
        )
        .await;
        // StreamGuard 随 run_send_message_pipeline 返回 drop，会话锁已释放，
        // 下一轮循环的 try_register_stream_owned 才是合法再注册时机。

        match result {
            Ok(_) => {
                tracing::debug!(
                    "[ChatV2::goal] continuation turn completed: session={}",
                    session_id
                );
                continue;
            }
            Err(ChatV2Error::Cancelled) => {
                tracing::debug!(
                    "[ChatV2::goal] continuation cancelled; goal → paused: session={}",
                    session_id
                );
                let conn = match db.get_conn() {
                    Ok(conn) => conn,
                    Err(_) => return,
                };
                update_goal_status_and_emit(&conn, &window, &session_id, &goal.goal_id, "paused");
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "[ChatV2::goal] continuation turn failed; goal → blocked: session={}, error={}",
                    session_id,
                    e
                );
                let conn = match db.get_conn() {
                    Ok(conn) => conn,
                    Err(_) => return,
                };
                update_goal_status_and_emit(&conn, &window, &session_id, &goal.goal_id, "blocked");
                return;
            }
        }
    }
}

/// 目标状态迁移 + 广播（乐观并发：带 expected goal_id）。
///
/// `Ok(None)`（目标不存在或已被替换）时静默放弃——用户已换目标，不广播。
fn update_goal_status_and_emit(
    conn: &rusqlite::Connection,
    window: &Window,
    session_id: &str,
    expected_goal_id: &str,
    new_status: &'static str,
) {
    match ChatV2Repo::goal_update_status_with_conn(conn, session_id, expected_goal_id, new_status) {
        Ok(Some(updated)) => {
            super::emit_goal_updated(window, session_id, Some(&updated));
        }
        Ok(None) => {
            tracing::debug!(
                "[ChatV2::goal] status update skipped (goal changed concurrently): session={}, expected_goal={}, new_status={}",
                session_id,
                expected_goal_id,
                new_status
            );
        }
        Err(e) => {
            tracing::warn!(
                "[ChatV2::goal] status update failed: session={}, goal={}, new_status={}, error={}",
                session_id,
                expected_goal_id,
                new_status,
                e
            );
        }
    }
}

/// 获取用于事件发射的 Window：优先 main，其次任意存活窗口。
/// （与 headless::resolve_emit_window 同模式；该函数为 headless 私有，这里就近复制。）
fn resolve_emit_window(app: &AppHandle) -> Option<Window> {
    let webviews = app.webview_windows();
    if let Some(main) = webviews.get("main") {
        return Some(main.as_ref().window());
    }
    webviews.values().next().map(|w| w.as_ref().window())
}
