//! Chat V2 Goal 模式（P0）：跨轮次会话目标
//!
//! - [`runtime`]：续跑运行时——轮末挂钩发现目标仍 active 时，以 wake 语义
//!   自动起续跑轮，直到目标完成/暂停/阻塞/预算耗尽。
//! - [`steering`]：续跑轮的提示词渲染（系统指令语气）。
//!
//! ## 事件契约
//! - 通道：`chat_v2_session_{session_id}`
//! - payload：`{"eventType":"goal_updated","sessionId":"...","goal": GoalRecord | null}`
//!   （camelCase；`goal = null` 表示目标已删除/清空）
//! - payload 统一由 `events::build_goal_updated_payload` 构造（单一构造点，
//!   goal_handlers / goal_executor 同源）。

pub mod runtime;
pub mod steering;

use tauri::{Emitter, Window};

use super::repo::GoalRecord;

/// 广播目标状态更新。
///
/// `goal = None` 表示目标已删除/清空，前端应移除目标面板。
/// emit 失败只记日志不扩散——目标状态以 DB 为准，事件只是刷新提示。
pub(crate) fn emit_goal_updated(window: &Window, session_id: &str, goal: Option<&GoalRecord>) {
    let event_name = format!("chat_v2_session_{}", session_id);
    let payload = crate::chat_v2::events::build_goal_updated_payload(session_id, goal);
    if let Err(e) = window.emit(&event_name, &payload) {
        tracing::warn!(
            "[ChatV2::goal] Failed to emit goal_updated event: session={}, error={}",
            session_id,
            e
        );
    }
}

/// 渲染 `<active_goal>` 注入块所需的纯文本摘要。
///
/// 分工约定：数据方（本函数）只提供纯文本；XML 标签包裹与内容转义由
/// `prompt_builder` 的 `build_turn_volatile_blocks` 负责。
///
/// 格式：`目标：{objective}\n状态：{status}；已用 tokens：{used}[；预算：{budget}，剩余：{remaining}]`
pub(crate) fn format_active_goal_summary(goal: &GoalRecord) -> String {
    let mut text = format!(
        "目标：{}\n状态：{}；已用 tokens：{}",
        goal.objective, goal.status, goal.tokens_used
    );
    if let Some(budget) = goal.token_budget {
        let remaining = (budget - goal.tokens_used).max(0);
        text.push_str(&format!("；预算：{}，剩余：{}", budget, remaining));
    }
    text
}
