//! compaction 子模块测试共享的构造器。

use crate::chat_v2::context::PipelineContext;
use crate::chat_v2::types::{
    block_status, block_types, ChatMessage, MessageBlock, MessageRole, SendMessageRequest,
};
use crate::llm_manager::ApiConfig;

pub(super) fn make_config(ctx: u32, max_out: u32) -> ApiConfig {
    ApiConfig {
        id: "cfg_test".to_string(),
        name: "test".to_string(),
        model: "test-model".to_string(),
        context_window: Some(ctx),
        max_output_tokens: max_out,
        max_tokens_limit: Some(max_out),
        ..Default::default()
    }
}

pub(super) fn dummy_ctx() -> PipelineContext {
    PipelineContext::new(SendMessageRequest {
        session_id: "s1".to_string(),
        user_message_id: Some("um".to_string()),
        assistant_message_id: Some("am".to_string()),
        content: "hi".to_string(),
        options: None,
        user_context_refs: None,
        workspace_id: None,
        path_map: None,
    })
}

pub(super) fn make_msg(id: &str, role: MessageRole) -> ChatMessage {
    ChatMessage {
        id: id.to_string(),
        session_id: "s1".to_string(),
        role,
        block_ids: vec![],
        timestamp: chrono::Utc::now().timestamp_millis(),
        persistent_stable_id: None,
        parent_id: None,
        supersedes: None,
        meta: None,
        attachments: None,
        active_variant_id: None,
        variants: None,
        shared_context: None,
    }
}

pub(super) fn make_msg_with_timestamp(id: &str, role: MessageRole, ts: i64) -> ChatMessage {
    let mut m = make_msg(id, role);
    m.timestamp = ts;
    m
}

pub(super) fn make_text_block(id: &str, msg_id: &str, content: &str) -> MessageBlock {
    MessageBlock {
        id: id.to_string(),
        message_id: msg_id.to_string(),
        block_type: block_types::CONTENT.to_string(),
        status: block_status::SUCCESS.to_string(),
        content: Some(content.to_string()),
        tool_name: None,
        tool_input: None,
        tool_output: None,
        citations: None,
        error: None,
        started_at: None,
        ended_at: None,
        first_chunk_at: None,
        block_index: 0,
    }
}

pub(super) fn make_tool_block(
    id: &str,
    msg_id: &str,
    tool_name: &str,
    input_json: serde_json::Value,
    output_json: serde_json::Value,
) -> MessageBlock {
    MessageBlock {
        id: id.to_string(),
        message_id: msg_id.to_string(),
        block_type: block_types::MCP_TOOL.to_string(),
        status: block_status::SUCCESS.to_string(),
        content: None,
        tool_name: Some(tool_name.to_string()),
        tool_input: Some(input_json),
        tool_output: Some(output_json),
        citations: None,
        error: None,
        started_at: None,
        ended_at: None,
        first_chunk_at: None,
        block_index: 0,
    }
}
