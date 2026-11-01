//! 仅发送给 LLM、不落库的瞬态消息识别（`chat_v2::pipeline::helpers` 按原路径重导出）

use crate::models::ChatMessage as LegacyChatMessage;
use serde_json::Value;

pub const TRANSIENT_SKILL_METADATA_KIND: &str = "skill_instruction";
pub const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND: &str = "request_context_anchor";

pub fn is_transient_skill_message(msg: &LegacyChatMessage) -> bool {
    msg.metadata.as_ref().is_some_and(|metadata| {
        metadata.get("kind").and_then(Value::as_str) == Some(TRANSIENT_SKILL_METADATA_KIND)
            && metadata
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    })
}

pub fn is_transient_llm_only_message(msg: &LegacyChatMessage) -> bool {
    is_transient_skill_message(msg)
        || msg.metadata.as_ref().is_some_and(|metadata| {
            metadata.get("kind").and_then(Value::as_str)
                == Some(TRANSIENT_REQUEST_ANCHOR_METADATA_KIND)
                && metadata
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
}
