//! 生成式 UI 交互作答 Tauri 命令
//!
//! 桥接前端 `InteractionSubmitBar` / `genuiInteractionApi` 到
//! [`crate::chat_v2::tools::genui_interaction`] 的挂起注册表：
//!
//! - `chat_v2_genui_submit_answer`：提交答案（Rust 按 spec 校验，只消费一次）；
//! - `chat_v2_genui_dismiss_answer`：中止等待（`user_message` → yieldTurn / `skipped`）；
//! - `chat_v2_genui_list_pending_answers`：刷新/重挂载后查询本会话仍可作答的 tool_call_id。
//!
//! 返回约定：`Ok(GenUiAck { status: "accepted" | "expired" })`；答案不合法 →
//! `Err("GENUI_ANSWER_INVALID: …")`（契约，前端按前缀识别并允许重提）；
//! 参数不合法（session_id / tool_call_id / reason）→ 统一 `ChatV2Error::InvalidInput`
//! 的 `{"code":"INVALID_INPUT",...}` JSON 字符串。

use serde::Serialize;

use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::tools::genui_interaction::{
    dismiss_genui_await, list_pending_genui_awaits, submit_genui_answer, GenUiDismissReason,
    GenUiSubmitResult,
};

/// 答案不合法时错误字符串的前缀（契约）。
pub const GENUI_ANSWER_INVALID_PREFIX: &str = "GENUI_ANSWER_INVALID";
/// tool_call_id 最大长度（字符）。
pub const GENUI_TOOL_CALL_ID_MAX_CHARS: usize = 128;

/// 命令确认载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenUiAck {
    /// `"accepted"` | `"expired"`
    pub status: String,
}

impl GenUiAck {
    fn accepted() -> Self {
        Self {
            status: "accepted".to_string(),
        }
    }

    fn expired() -> Self {
        Self {
            status: "expired".to_string(),
        }
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if !session_id.starts_with("sess_") || session_id.len() <= "sess_".len() {
        return Err(
            ChatV2Error::InvalidInput("session_id must start with 'sess_'".to_string()).into(),
        );
    }
    Ok(())
}

fn validate_tool_call_id(tool_call_id: &str) -> Result<(), String> {
    if tool_call_id.trim().is_empty() {
        return Err(ChatV2Error::InvalidInput("tool_call_id must not be empty".to_string()).into());
    }
    if tool_call_id.chars().count() > GENUI_TOOL_CALL_ID_MAX_CHARS {
        return Err(ChatV2Error::InvalidInput(format!(
            "tool_call_id exceeds {GENUI_TOOL_CALL_ID_MAX_CHARS} characters"
        ))
        .into());
    }
    Ok(())
}

fn ack_from_result(result: GenUiSubmitResult) -> Result<GenUiAck, String> {
    match result {
        GenUiSubmitResult::Accepted => Ok(GenUiAck::accepted()),
        GenUiSubmitResult::Expired => Ok(GenUiAck::expired()),
        GenUiSubmitResult::Invalid(reason) => {
            Err(format!("{GENUI_ANSWER_INVALID_PREFIX}: {reason}"))
        }
    }
}

/// 同步实现（命令薄包装，便于单测）。
pub fn genui_submit_answer_impl(
    session_id: &str,
    tool_call_id: &str,
    summary: &str,
    data: &serde_json::Value,
) -> Result<GenUiAck, String> {
    validate_session_id(session_id)?;
    validate_tool_call_id(tool_call_id)?;
    let result = submit_genui_answer(session_id, tool_call_id, summary, data);
    match &result {
        GenUiSubmitResult::Accepted => log::info!(
            "[ChatV2::genui] answer accepted: session={}, tool_call_id={}",
            session_id,
            tool_call_id
        ),
        GenUiSubmitResult::Expired => log::info!(
            "[ChatV2::genui] answer expired (no pending await): session={}, tool_call_id={}",
            session_id,
            tool_call_id
        ),
        GenUiSubmitResult::Invalid(reason) => log::warn!(
            "[ChatV2::genui] answer rejected: session={}, tool_call_id={}, reason={}",
            session_id,
            tool_call_id,
            reason
        ),
    }
    ack_from_result(result)
}

/// 同步实现（命令薄包装，便于单测）。
pub fn genui_dismiss_answer_impl(
    session_id: &str,
    tool_call_id: &str,
    reason: &str,
) -> Result<GenUiAck, String> {
    validate_session_id(session_id)?;
    validate_tool_call_id(tool_call_id)?;
    let Some(reason) = GenUiDismissReason::parse(reason) else {
        return Err(ChatV2Error::InvalidInput(format!(
            "Invalid genui dismiss reason '{reason}'. Allowed: [\"user_message\", \"skipped\"]"
        ))
        .into());
    };
    let result = dismiss_genui_await(session_id, tool_call_id, reason);
    log::info!(
        "[ChatV2::genui] dismiss: session={}, tool_call_id={}, reason={}, result={:?}",
        session_id,
        tool_call_id,
        reason.as_str(),
        result
    );
    ack_from_result(result)
}

/// 同步实现（命令薄包装，便于单测）。
pub fn genui_list_pending_answers_impl(session_id: &str) -> Result<Vec<String>, String> {
    validate_session_id(session_id)?;
    Ok(list_pending_genui_awaits(session_id))
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 提交生成式 UI 交互答案。
///
/// 前端：`invoke('chat_v2_genui_submit_answer', { sessionId, toolCallId, summary, data })`。
#[tauri::command]
pub async fn chat_v2_genui_submit_answer(
    session_id: String,
    tool_call_id: String,
    summary: String,
    data: serde_json::Value,
) -> Result<GenUiAck, String> {
    genui_submit_answer_impl(&session_id, &tool_call_id, &summary, &data)
}

/// 中止生成式 UI 等待（`reason`: `"user_message"` | `"skipped"`）。
///
/// 前端：`invoke('chat_v2_genui_dismiss_answer', { sessionId, toolCallId, reason })`。
#[tauri::command]
pub async fn chat_v2_genui_dismiss_answer(
    session_id: String,
    tool_call_id: String,
    reason: String,
) -> Result<GenUiAck, String> {
    genui_dismiss_answer_impl(&session_id, &tool_call_id, &reason)
}

/// 列出本会话仍在等待作答的 tool_call_id。
///
/// 前端：`invoke('chat_v2_genui_list_pending_answers', { sessionId })`。
#[tauri::command]
pub async fn chat_v2_genui_list_pending_answers(session_id: String) -> Result<Vec<String>, String> {
    genui_list_pending_answers_impl(&session_id)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::tools::genui_interaction::{
        lock_genui_registry_for_test, register_genui_await, validate_genui_intent_rules,
        GenUiAwaitOutcome,
    };
    use serde_json::json;
    use std::sync::Arc;

    fn spec() -> Arc<crate::chat_v2::tools::genui_interaction::GenUiAwaitSpec> {
        let intent = json!({
            "blocks": [
                { "type": "choice", "id": "q1", "props": {
                    "question": "选一个",
                    "options": [ { "id": "a", "label": "A" }, { "id": "b", "label": "B" } ]
                } }
            ]
        });
        Arc::new(
            validate_genui_intent_rules(&intent, true)
                .expect("valid")
                .expect("spec"),
        )
    }

    #[test]
    fn ack_serializes_camel_case_status() {
        assert_eq!(
            serde_json::to_value(GenUiAck::accepted()).unwrap(),
            json!({ "status": "accepted" })
        );
        assert_eq!(
            serde_json::to_value(GenUiAck::expired()).unwrap(),
            json!({ "status": "expired" })
        );
    }

    #[test]
    fn rejects_malformed_ids_and_reason() {
        let data = json!({});
        let err = genui_submit_answer_impl("bad", "call_1", "s", &data).unwrap_err();
        assert!(err.contains("INVALID_INPUT"));
        let err = genui_submit_answer_impl("sess_", "call_1", "s", &data).unwrap_err();
        assert!(err.contains("INVALID_INPUT"));
        let err = genui_submit_answer_impl("sess_x", "  ", "s", &data).unwrap_err();
        assert!(err.contains("INVALID_INPUT"));
        let long_id = "c".repeat(GENUI_TOOL_CALL_ID_MAX_CHARS + 1);
        let err = genui_submit_answer_impl("sess_x", &long_id, "s", &data).unwrap_err();
        assert!(err.contains("INVALID_INPUT"));
        let err = genui_dismiss_answer_impl("sess_x", "call_1", "stopped").unwrap_err();
        assert!(err.contains("INVALID_INPUT"));
        assert!(genui_list_pending_answers_impl("nope").is_err());
    }

    #[test]
    fn submit_flow_accepted_invalid_expired() {
        let _lock = lock_genui_registry_for_test();
        let (_guard, mut rx) = register_genui_await("sess_cmd_a", "call_1", spec());
        assert_eq!(
            genui_list_pending_answers_impl("sess_cmd_a").unwrap(),
            vec!["call_1".to_string()]
        );

        let err = genui_submit_answer_impl(
            "sess_cmd_a",
            "call_1",
            "s",
            &json!({ "q1": { "selected": ["zzz"] } }),
        )
        .unwrap_err();
        assert!(err.starts_with("GENUI_ANSWER_INVALID: "), "{err}");
        assert!(rx.try_recv().is_err());

        let ack = genui_submit_answer_impl(
            "sess_cmd_a",
            "call_1",
            "选了 A",
            &json!({ "q1": { "selected": ["a"] } }),
        )
        .unwrap();
        assert_eq!(ack.status, "accepted");
        assert!(matches!(rx.try_recv(), Ok(GenUiAwaitOutcome::Answered(_))));

        let ack = genui_submit_answer_impl(
            "sess_cmd_a",
            "call_1",
            "选了 A",
            &json!({ "q1": { "selected": ["a"] } }),
        )
        .unwrap();
        assert_eq!(ack.status, "expired");
        assert!(genui_list_pending_answers_impl("sess_cmd_a")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn dismiss_flow() {
        let _lock = lock_genui_registry_for_test();
        let (_guard, mut rx) = register_genui_await("sess_cmd_b", "call_1", spec());
        let ack = genui_dismiss_answer_impl("sess_cmd_b", "call_1", "user_message").unwrap();
        assert_eq!(ack.status, "accepted");
        assert_eq!(
            rx.try_recv().ok(),
            Some(GenUiAwaitOutcome::Dismissed(
                GenUiDismissReason::UserMessage
            ))
        );
        let ack = genui_dismiss_answer_impl("sess_cmd_b", "call_1", "skipped").unwrap();
        assert_eq!(ack.status, "expired");
    }
}
