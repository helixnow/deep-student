//! Chat V2 — 生成式 UI 工具执行器
//!
//! LLM 调用 `render_generative_ui` 时，发射 `generative_ui` 块事件供前端
//! GenerativeUIRenderer 渲染结构化意图 JSON。

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Instant;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::types::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::hpias::{
    create_research_backend, extract_question_from_intent, HpiasEventEmitter, HpiasResearchDeps,
    HpiasResearchSessionRequest,
};

const TOOL_NAME: &str = "render_generative_ui";
const MAX_GENERATIVE_UI_BLOCKS: usize = 32;

pub struct GenerativeUiExecutor;

impl GenerativeUiExecutor {
    pub fn new() -> Self {
        Self
    }

    fn parse_intent(arguments: &Value) -> Result<Value, String> {
        let raw = arguments.get("intent").ok_or_else(|| {
            "render_generative_ui 需要 intent 参数（JSON 对象或字符串）".to_string()
        })?;

        let intent = if let Some(text) = raw.as_str() {
            serde_json::from_str(text.trim()).map_err(|e| format!("intent 不是合法 JSON: {}", e))?
        } else {
            raw.clone()
        };

        if !intent.is_object() {
            return Err("intent 必须是 JSON 对象".to_string());
        }

        Self::validate_intent_version(&intent)?;
        // layout / span 为 v1.1 可选透传：未知 mode 不拒绝整份 intent
        let _ = Self::known_layout_mode(&intent);

        let blocks = intent
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| "intent.blocks 必须是数组".to_string())?;

        if blocks.is_empty() {
            return Err("intent.blocks 不能为空".to_string());
        }

        if blocks.len() > MAX_GENERATIVE_UI_BLOCKS {
            return Err(format!(
                "intent.blocks 超过上限 {}（收到 {}）",
                MAX_GENERATIVE_UI_BLOCKS,
                blocks.len()
            ));
        }

        Ok(intent)
    }

    /// Intent version 字面量：缺省视为 `"1"`；仅允许 `"1"` / `"1.1"`；拒绝 `"2"` 等未知值。
    fn validate_intent_version(intent: &Value) -> Result<(), String> {
        match intent.get("version") {
            None => Ok(()),
            Some(Value::String(v)) if v == "1" || v == "1.1" => Ok(()),
            Some(Value::String(v)) => Err(format!(
                "intent.version 不支持: {}（支持 \"1\" / \"1.1\"）",
                v
            )),
            Some(_) => Err("intent.version 必须是字符串 \"1\" 或 \"1.1\"".to_string()),
        }
    }

    /// 识别 `layout.mode` = stack | grid。未知 / 缺失 / 非对象返回 `None`，不报错。
    fn known_layout_mode(intent: &Value) -> Option<&'static str> {
        match intent.pointer("/layout/mode").and_then(Value::as_str) {
            Some("stack") => Some("stack"),
            Some("grid") => Some("grid"),
            _ => None,
        }
    }

    fn parse_research_session_id(arguments: &Value) -> Option<String> {
        arguments
            .get("researchSessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    fn parse_note_edit(arguments: &Value) -> Result<Option<Value>, String> {
        let Some(raw) = arguments.get("noteEdit") else {
            return Ok(None);
        };

        if !raw.is_object() {
            return Err("noteEdit 必须是 JSON 对象".to_string());
        }

        let operation = raw
            .get("operation")
            .and_then(Value::as_str)
            .ok_or_else(|| "noteEdit.operation 必填（append | replace | set）".to_string())?;

        if !matches!(operation, "append" | "replace" | "set") {
            return Err(format!("noteEdit.operation 无效: {}", operation));
        }

        if raw.get("isRegex").and_then(Value::as_bool) == Some(true) {
            return Err("noteEdit.isRegex 不被支持".to_string());
        }

        let mut sanitized = raw.clone();
        if let Some(obj) = sanitized.as_object_mut() {
            obj.remove("isRegex");
        }
        Ok(Some(sanitized))
    }

    fn intent_has_apply_note_edit(intent: &Value) -> bool {
        let Some(blocks) = intent.get("blocks").and_then(Value::as_array) else {
            return false;
        };

        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("action-bar") {
                continue;
            }
            let Some(actions) = block.pointer("/props/actions").and_then(Value::as_array) else {
                continue;
            };
            for action in actions {
                if action.get("id").and_then(Value::as_str) == Some("apply-note-edit") {
                    return true;
                }
            }
        }

        false
    }

    fn emit_start(ctx: &ExecutionContext, title: Option<&str>) {
        ctx.emitter.emit_start_with_meta(
            event_types::GENERATIVE_UI,
            &ctx.message_id,
            Some(&ctx.block_id),
            title.map(|t| json!({ "title": t })),
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn emit_chunk(ctx: &ExecutionContext, content: &str) {
        ctx.emitter.emit_chunk_with_meta(
            event_types::GENERATIVE_UI,
            &ctx.block_id,
            content,
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn emit_end(ctx: &ExecutionContext, intent: &Value, research_session_id: Option<&str>) {
        let mut payload = json!({
            "intent": intent,
            "isStreaming": false,
        });
        if let Some(session_id) = research_session_id {
            payload["researchSessionId"] = json!(session_id);
        }
        ctx.emitter.emit_end_with_meta(
            event_types::GENERATIVE_UI,
            &ctx.block_id,
            Some(payload),
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn emit_error(ctx: &ExecutionContext, error: &str) {
        ctx.emitter.emit_error_with_meta(
            event_types::GENERATIVE_UI,
            &ctx.block_id,
            error,
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    /// researchSessionId 存在时 emit `hpias_event` session_started，并 spawn pipeline orchestrator
    fn emit_hpias_session_started_if_needed(
        ctx: &ExecutionContext,
        session_id: &str,
        question: Option<&str>,
        intent: &Value,
    ) {
        let window = ctx
            .tauri_window
            .clone()
            .or_else(|| ctx.emitter.try_window());
        let Some(window) = window else {
            return;
        };
        let emitter = HpiasEventEmitter::new(window.clone());
        if let Err(error) = emitter.emit_session_started(session_id, question) {
            log::warn!(
                "[GenerativeUiExecutor] hpias_event session_started emit failed: {}",
                error
            );
        }
        let deps = HpiasResearchDeps {
            vfs_db: ctx.vfs_db.clone(),
            vfs_lance_store: ctx.vfs_lance_store.clone(),
            llm_manager: ctx.llm_manager.clone(),
        };
        let backend = create_research_backend(window, deps);
        backend.start_research_session(HpiasResearchSessionRequest {
            session_id,
            question,
            intent,
        });
    }
}

impl Default for GenerativeUiExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for GenerativeUiExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == TOOL_NAME
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        let intent = match Self::parse_intent(&call.arguments) {
            Ok(intent) => intent,
            Err(error) => {
                Self::emit_start(ctx, None);
                Self::emit_error(ctx, &error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error.clone(),
                    start.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let note_edit = match Self::parse_note_edit(&call.arguments) {
            Ok(note_edit) => note_edit,
            Err(error) => {
                Self::emit_start(ctx, None);
                Self::emit_error(ctx, &error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error.clone(),
                    start.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let research_session_id = Self::parse_research_session_id(&call.arguments);

        if Self::intent_has_apply_note_edit(&intent) && note_edit.is_none() {
            let error = "intent 含 apply-note-edit 时必须提供 noteEdit 参数".to_string();
            Self::emit_start(ctx, None);
            Self::emit_error(ctx, &error);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error.clone(),
                start.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let title = intent
            .get("meta")
            .and_then(|m| m.get("title"))
            .and_then(Value::as_str);
        let extracted_question = extract_question_from_intent(&intent);
        let hpias_question = title.or(extracted_question.as_deref());

        let content_str =
            serde_json::to_string(&intent).map_err(|e| format!("intent 序列化失败: {}", e))?;

        Self::emit_start(ctx, title);
        Self::emit_chunk(ctx, &content_str);
        Self::emit_end(ctx, &intent, research_session_id.as_deref());
        if let Some(ref session_id) = research_session_id {
            Self::emit_hpias_session_started_if_needed(ctx, session_id, hpias_question, &intent);
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        let mut output = json!({
            "status": "rendered",
            "blockCount": intent.get("blocks").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
        });
        if let Some(ref session_id) = research_session_id {
            output["researchSessionId"] = json!(session_id);
        }

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output.clone(),
            duration_ms,
        );

        let _ = ctx.save_tool_block(&result);

        Ok(result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "GenerativeUiExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::chat_v2::types::ToolCall;
    use crate::tools::ToolRegistry;
    use std::sync::Arc;

    fn test_ctx(block_id: &str) -> ExecutionContext {
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            "generative-ui-test-session".to_string(),
        ));
        ExecutionContext::new(
            "generative-ui-test-session".to_string(),
            "generative-ui-test-message".to_string(),
            block_id.to_string(),
            emitter,
            Arc::new(ToolRegistry::new()),
            None,
        )
        .with_tool_call_id("call-generative-ui")
    }

    #[test]
    fn parse_intent_accepts_object() {
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": [{ "type": "text", "props": { "text": "hi" } }]
            }
        });
        let intent = GenerativeUiExecutor::parse_intent(&args).expect("parse");
        assert_eq!(intent.get("version").and_then(Value::as_str), Some("1"));
    }

    #[test]
    fn parse_intent_accepts_version_1_1() {
        let args = json!({
            "intent": {
                "version": "1.1",
                "layout": { "mode": "grid", "columns": 2 },
                "blocks": [{ "type": "text", "props": { "text": "hi" }, "span": 2 }]
            }
        });
        let intent = GenerativeUiExecutor::parse_intent(&args).expect("parse v1.1");
        assert_eq!(intent.get("version").and_then(Value::as_str), Some("1.1"));
        assert_eq!(
            intent.pointer("/layout/mode").and_then(Value::as_str),
            Some("grid")
        );
        assert_eq!(
            intent.pointer("/blocks/0/span").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            GenerativeUiExecutor::known_layout_mode(&intent),
            Some("grid")
        );
    }

    #[test]
    fn parse_intent_defaults_missing_version_as_v1() {
        let args = json!({
            "intent": {
                "blocks": [{ "type": "text", "props": { "text": "hi" } }]
            }
        });
        let intent = GenerativeUiExecutor::parse_intent(&args).expect("missing version is v1");
        assert!(intent.get("version").is_none());
        assert!(GenerativeUiExecutor::validate_intent_version(&intent).is_ok());
    }

    #[test]
    fn parse_intent_ignores_unknown_layout() {
        let args = json!({
            "intent": {
                "version": "1.1",
                "layout": { "mode": "masonry", "columns": 4 },
                "blocks": [{ "type": "text", "props": { "text": "hi" } }]
            }
        });
        let intent =
            GenerativeUiExecutor::parse_intent(&args).expect("unknown layout must not fail");
        assert_eq!(intent.get("version").and_then(Value::as_str), Some("1.1"));
        assert!(GenerativeUiExecutor::known_layout_mode(&intent).is_none());
    }

    #[test]
    fn parse_intent_rejects_unknown_version() {
        let args = json!({
            "intent": {
                "version": "2",
                "blocks": [{ "type": "text", "props": { "text": "hi" } }]
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("unknown version");
        assert!(err.contains("version"));
        assert!(err.contains("2"));
    }

    #[test]
    fn validate_intent_version_rejects_version_2() {
        let intent = json!({
            "version": "2",
            "blocks": [{ "type": "text", "props": { "text": "hi" } }]
        });
        let err = GenerativeUiExecutor::validate_intent_version(&intent).expect_err("version 2");
        assert!(err.contains("version"));
    }

    #[test]
    fn parse_intent_accepts_json_string() {
        let args = json!({
            "intent": r#"{"version":"1","blocks":[{"type":"alert","props":{"message":"ok"}}]}"#
        });
        let intent = GenerativeUiExecutor::parse_intent(&args).expect("parse");
        assert!(intent.get("blocks").and_then(Value::as_array).is_some());
    }

    #[test]
    fn parse_intent_rejects_empty_blocks() {
        let args = json!({ "intent": { "version": "1", "blocks": [] } });
        assert!(GenerativeUiExecutor::parse_intent(&args).is_err());
    }

    #[test]
    fn parse_intent_rejects_too_many_blocks() {
        let blocks: Vec<Value> = (0..33)
            .map(|i| json!({ "type": "text", "props": { "text": format!("block-{i}") } }))
            .collect();
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": blocks
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("too many blocks");
        assert!(err.contains("32") || err.contains("上限"));
    }

    #[test]
    fn parse_intent_rejects_missing_intent() {
        let args = json!({ "other": true });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("missing intent");
        assert!(err.contains("intent"));
    }

    #[test]
    fn parse_research_session_id_accepts_non_empty_string() {
        let args = json!({ "researchSessionId": " hpias-s1 " });
        assert_eq!(
            GenerativeUiExecutor::parse_research_session_id(&args).as_deref(),
            Some("hpias-s1")
        );
    }

    #[test]
    fn parse_research_session_id_rejects_blank() {
        let args = json!({ "researchSessionId": "   " });
        assert!(GenerativeUiExecutor::parse_research_session_id(&args).is_none());
    }

    #[tokio::test]
    async fn execute_preserves_research_session_id_in_output() {
        let executor = GenerativeUiExecutor::new();
        let call = ToolCall::new(
            "call-generative-ui-research".to_string(),
            "render_generative_ui".to_string(),
            json!({
                "researchSessionId": "research-chat-1",
                "intent": {
                    "version": "1",
                    "blocks": [{ "type": "research-plan", "props": { "title": "Plan", "steps": [] } }]
                }
            }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-research"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(result.success);
        assert_eq!(
            result
                .output
                .get("researchSessionId")
                .and_then(Value::as_str),
            Some("research-chat-1")
        );
    }

    #[test]
    fn parse_note_edit_accepts_append_payload() {
        let args = json!({
            "noteEdit": { "operation": "append", "content": "## Summary" }
        });
        let note_edit = GenerativeUiExecutor::parse_note_edit(&args).expect("parse");
        assert!(note_edit.is_some());
        assert_eq!(
            note_edit
                .and_then(|v| v.get("operation"))
                .and_then(Value::as_str),
            Some("append")
        );
    }

    #[test]
    fn parse_note_edit_rejects_invalid_operation() {
        let args = json!({ "noteEdit": { "operation": "delete" } });
        assert!(GenerativeUiExecutor::parse_note_edit(&args).is_err());
    }

    #[test]
    fn parse_note_edit_rejects_regex_flag() {
        let args = json!({
            "noteEdit": { "operation": "replace", "search": "(a+)+$", "replace": "x", "isRegex": true }
        });
        let error = GenerativeUiExecutor::parse_note_edit(&args).expect_err("regex");
        assert!(error.contains("isRegex"));
    }

    #[test]
    fn intent_has_apply_note_edit_detects_action_bar_id() {
        let intent = json!({
            "version": "1",
            "blocks": [{
                "type": "action-bar",
                "props": { "actions": [{ "id": "apply-note-edit", "label": "Apply" }] }
            }]
        });
        assert!(GenerativeUiExecutor::intent_has_apply_note_edit(&intent));
    }

    #[tokio::test]
    async fn execute_preserves_note_edit_in_tool_arguments() {
        let executor = GenerativeUiExecutor::new();
        let note_edit = json!({ "operation": "set", "content": "# Title" });
        let intent = json!({
            "version": "1",
            "blocks": [
                { "type": "text", "props": { "body": "Preview" } },
                {
                    "type": "action-bar",
                    "props": {
                        "actions": [{ "id": "apply-note-edit", "label": "Apply", "riskLevel": "high" }]
                    }
                }
            ]
        });
        let call = ToolCall::new(
            "call-generative-ui-note-edit".to_string(),
            "render_generative_ui".to_string(),
            json!({ "intent": intent, "noteEdit": note_edit }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-note-edit"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(result.success);
        assert_eq!(
            result
                .input
                .get("noteEdit")
                .and_then(|v| v.get("operation"))
                .and_then(Value::as_str),
            Some("set")
        );
    }

    #[tokio::test]
    async fn execute_fails_when_apply_note_edit_without_note_edit_payload() {
        let executor = GenerativeUiExecutor::new();
        let intent = json!({
            "version": "1",
            "blocks": [{
                "type": "action-bar",
                "props": {
                    "actions": [{ "id": "apply-note-edit", "label": "Apply" }]
                }
            }]
        });
        let call = ToolCall::new(
            "call-generative-ui-note-edit-missing".to_string(),
            "render_generative_ui".to_string(),
            json!({ "intent": intent }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-note-edit-missing"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(!result.success);
        assert!(result.error.as_deref().unwrap_or("").contains("noteEdit"));
    }

    #[test]
    fn can_handle_namespaced_and_plain_tool_name() {
        let executor = GenerativeUiExecutor::new();
        assert!(executor.can_handle("render_generative_ui"));
        assert!(executor.can_handle("builtin-render_generative_ui"));
        assert!(!executor.can_handle("rag_search"));
    }

    #[tokio::test]
    async fn execute_success_returns_rendered_status_and_block_count() {
        let executor = GenerativeUiExecutor::new();
        let call = ToolCall::new(
            "call-generative-ui".to_string(),
            "builtin-render_generative_ui".to_string(),
            json!({
                "intent": {
                    "version": "1",
                    "meta": { "title": "Learning briefing" },
                    "blocks": [
                        { "type": "stat-card", "props": { "title": "Due", "value": 3 } },
                        { "type": "action-bar", "props": { "actions": [] } }
                    ]
                }
            }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(result.success, "expected success, got {:?}", result.error);
        assert_eq!(
            result.output.get("status").and_then(Value::as_str),
            Some("rendered")
        );
        assert_eq!(
            result.output.get("blockCount").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(result.tool_name, "builtin-render_generative_ui");
    }

    #[tokio::test]
    async fn execute_failure_on_empty_blocks_returns_error_result() {
        let executor = GenerativeUiExecutor::new();
        let call = ToolCall::new(
            "call-generative-ui-fail".to_string(),
            "render_generative_ui".to_string(),
            json!({ "intent": { "version": "1", "blocks": [] } }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-fail"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(!result.success);
        assert!(result.error.as_deref().unwrap_or("").contains("blocks"));
    }

    #[tokio::test]
    async fn execute_v1_1_grid_layout_returns_rendered() {
        let executor = GenerativeUiExecutor::new();
        let call = ToolCall::new(
            "call-generative-ui-v11".to_string(),
            "builtin-render_generative_ui".to_string(),
            json!({
                "intent": {
                    "version": "1.1",
                    "layout": { "mode": "grid", "columns": 2 },
                    "blocks": [
                        { "type": "stat-card", "props": { "title": "Due", "value": 3 }, "span": 2 }
                    ]
                }
            }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-v11"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(result.success, "expected success, got {:?}", result.error);
        assert_eq!(
            result.output.get("status").and_then(Value::as_str),
            Some("rendered")
        );
        assert_eq!(
            result.output.get("blockCount").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            result
                .input
                .pointer("/intent/layout/mode")
                .and_then(Value::as_str),
            Some("grid")
        );
    }

    #[tokio::test]
    async fn execute_rejects_version_2() {
        let executor = GenerativeUiExecutor::new();
        let call = ToolCall::new(
            "call-generative-ui-v2".to_string(),
            "render_generative_ui".to_string(),
            json!({
                "intent": {
                    "version": "2",
                    "blocks": [{ "type": "text", "props": { "text": "hi" } }]
                }
            }),
        );

        let result = executor
            .execute(&call, &test_ctx("block-generative-ui-v2"))
            .await
            .expect("execute returns ToolResultInfo");

        assert!(!result.success);
        assert!(result.error.as_deref().unwrap_or("").contains("version"));
    }
}
