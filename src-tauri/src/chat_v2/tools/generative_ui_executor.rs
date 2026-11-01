//! Chat V2 — 生成式 UI 工具执行器
//!
//! LLM 调用 `render_generative_ui` 时，发射 `generative_ui` 块事件供前端
//! GenerativeUIRenderer 渲染结构化意图 JSON。
//!
//! `awaitAnswer=true` 时（仅允许含 choice/form 交互块）执行器渲染后挂起，
//! 直到用户在界面提交 / 跳过 / 改在输入框发消息，或生成被停止；交互规则、
//! 挂起注册表与工具输出形状见 `dstu_agent::chat_v2::tools::genui_interaction`。

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::genui_interaction::{
    build_await_outcome_output, build_pending_snapshot_output, build_rendered_output,
    check_genui_await_context, register_genui_await, validate_genui_intent_rules, GenUiAwaitSpec,
    GENUI_NEW_BLOCK_TYPES,
};
use super::types::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::hpias::{
    create_research_backend, extract_question_from_intent, intent_has_research_blocks,
    HpiasEventEmitter, HpiasResearchDeps, HpiasResearchSessionRequest,
};

const TOOL_NAME: &str = "render_generative_ui";
const MAX_GENERATIVE_UI_BLOCKS: usize = 32;
const MAX_GENERATIVE_UI_INTENT_CHARS: usize = 256_000;
/// 18 种原有内置块；与 [`GENUI_NEW_BLOCK_TYPES`]（choice / form / image）合计 21 种，
/// 与前端 `EXPECTED_BLOCK_TYPES` / `ALL_BLOCK_TYPES` 对齐。
const ALLOWED_GENERATIVE_UI_BLOCK_TYPES: &[&str] = &[
    "stat-card",
    "alert",
    "list",
    "progress",
    "action-bar",
    "text",
    "key-value-grid",
    "flashcard-preview",
    "review-calendar",
    "mistake-analysis",
    "mindmap-embed",
    "paper-digest",
    "research-plan",
    "research-report",
    "markdown",
    "chart",
    "steps",
    "table",
];

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

        if raw
            .as_str()
            .is_some_and(|text| text.len() > MAX_GENERATIVE_UI_INTENT_CHARS)
            || serde_json::to_string(&intent)
                .ok()
                .is_some_and(|encoded| encoded.len() > MAX_GENERATIVE_UI_INTENT_CHARS)
        {
            return Err(format!(
                "intent 超过 {} 字符上限",
                MAX_GENERATIVE_UI_INTENT_CHARS
            ));
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

        Self::validate_block_types(blocks)?;

        Ok(intent)
    }

    /// 块类型是否在 21 种内置白名单（18 种原有 + choice/form/image）。
    fn is_allowed_block_type(block_type: &str) -> bool {
        ALLOWED_GENERATIVE_UI_BLOCK_TYPES.contains(&block_type)
            || GENUI_NEW_BLOCK_TYPES.contains(&block_type)
    }

    /// 每块必须是对象，且 `type` 落在 21 种内置白名单。未知类型在入口拒绝。
    /// 交互块 / 图片 / 追问按钮的细则由 `validate_genui_intent_rules` 另行校验。
    fn validate_block_types(blocks: &[Value]) -> Result<(), String> {
        for (index, block) in blocks.iter().enumerate() {
            let Some(obj) = block.as_object() else {
                return Err(format!("intent.blocks[{index}] 必须是对象"));
            };
            let Some(block_type) = obj.get("type").and_then(Value::as_str) else {
                return Err(format!("intent.blocks[{index}].type 必须是字符串"));
            };
            if !Self::is_allowed_block_type(block_type) {
                return Err(format!("intent.blocks[{index}].type 不支持: {block_type}"));
            }
        }
        Ok(())
    }

    /// `awaitAnswer` 参数：缺省 / null → false；必须是布尔值。
    fn parse_await_answer(arguments: &Value) -> Result<bool, String> {
        match arguments.get("awaitAnswer") {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err("awaitAnswer 必须是布尔值".to_string()),
        }
    }

    fn block_count(intent: &Value) -> usize {
        intent
            .get("blocks")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
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

    fn sanitize_research_session_id(raw: &str) -> Option<String> {
        const MAX_RESEARCH_SESSION_ID_LENGTH: usize = 128;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_RESEARCH_SESSION_ID_LENGTH {
            return None;
        }
        let valid = trimmed.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_alphanumeric() || ((ch == '.' || ch == '_' || ch == '-') && index > 0)
        });
        valid.then(|| trimmed.to_string())
    }

    fn parse_research_session_id(arguments: &Value, intent: Option<&Value>) -> Option<String> {
        if let Some(id) = arguments
            .get("researchSessionId")
            .and_then(Value::as_str)
            .and_then(Self::sanitize_research_session_id)
        {
            return Some(id);
        }
        intent
            .and_then(|value| value.pointer("/meta/researchSessionId"))
            .and_then(Value::as_str)
            .and_then(Self::sanitize_research_session_id)
    }

    /// P3 产物模板：skeletonRef 是 skill id（目录名，小写字母+数字+连字符），
    /// 复用 research_session_id 的字符白名单做防御性消毒
    fn parse_skeleton_ref(arguments: &Value) -> Option<String> {
        arguments
            .get("skeletonRef")
            .and_then(Value::as_str)
            .and_then(Self::sanitize_research_session_id)
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

        const MAX_NOTE_EDIT_INPUT_BYTES: usize = 256 * 1024;
        const MAX_NOTE_EDIT_SECTION_LEN: usize = 1024;
        let field_len = |key: &str| -> usize {
            raw.get(key)
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0)
        };
        if field_len("section") > MAX_NOTE_EDIT_SECTION_LEN {
            return Err("noteEdit.section 过长".to_string());
        }
        let total_bytes = field_len("content")
            + field_len("search")
            + field_len("replace")
            + field_len("section");
        if total_bytes > MAX_NOTE_EDIT_INPUT_BYTES {
            return Err(format!(
                "noteEdit 内容超过 {} 字节",
                MAX_NOTE_EDIT_INPUT_BYTES
            ));
        }

        let mut sanitized = serde_json::Map::new();
        sanitized.insert(
            "operation".to_string(),
            Value::String(operation.to_string()),
        );
        for key in ["content", "search", "replace", "section"] {
            match raw.get(key) {
                Some(Value::String(value)) => {
                    sanitized.insert(key.to_string(), Value::String(value.clone()));
                }
                Some(_) => {
                    return Err(format!("noteEdit.{} 必须是字符串", key));
                }
                None => {}
            }
        }
        Ok(Some(Value::Object(sanitized)))
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

    /// start payload：`{ title?, toolCallId, awaitAnswer? }`。
    ///
    /// `toolCallId`（= LLM tool_call.id）供前端把 preparing 阶段的占位块与执行期
    /// 后端块对齐；`awaitAnswer: true` 仅在挂起等待作答时出现。
    fn emit_start(
        ctx: &ExecutionContext,
        title: Option<&str>,
        tool_call_id: &str,
        await_answer: bool,
    ) {
        let mut payload = json!({ "toolCallId": tool_call_id });
        if let Some(title) = title {
            payload["title"] = json!(title);
        }
        if await_answer {
            payload["awaitAnswer"] = json!(true);
        }
        ctx.emitter.emit_start_with_meta(
            event_types::GENERATIVE_UI,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(payload),
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

    fn emit_end(
        ctx: &ExecutionContext,
        intent: &Value,
        research_session_id: Option<&str>,
        skeleton_ref: Option<&str>,
        await_output: Option<&Value>,
    ) {
        let mut payload = json!({
            "intent": intent,
            "isStreaming": false,
        });
        // awaitAnswer：回显交互终态（answered / dismissed / cancelled）与已校验答案，
        // 前端 onEnd 写入 toolOutput 供回放只读显示。
        if let Some(output) = await_output {
            for key in ["interaction", "answer"] {
                if let Some(value) = output.get(key) {
                    payload[key] = value.clone();
                }
            }
        }
        if let Some(session_id) = research_session_id {
            payload["researchSessionId"] = json!(session_id);
        }
        // P3 产物模板：回显 skeletonRef——live 路径下前端块没有 toolInput
        // （tool_input 仅持久化到 DB，restore 才回读），onEnd 骨架校验靠此回显消歧
        if let Some(skeleton_ref) = skeleton_ref {
            payload["skeletonRef"] = json!(skeleton_ref);
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

    /// 参数 / 规则 / 上下文校验失败：emit start + error，落库失败结果并返回。
    fn reject(
        call: &ToolCall,
        ctx: &ExecutionContext,
        start: Instant,
        error: String,
    ) -> ToolResultInfo {
        Self::emit_start(ctx, None, &call.id, false);
        Self::emit_error(ctx, &error);
        let result = ToolResultInfo::failure(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            error,
            start.elapsed().as_millis() as u64,
        );
        let _ = ctx.save_tool_block(&result);
        result
    }

    /// awaitAnswer 挂起路径：登记等待 → 预存 pending 快照 → start/chunk →
    /// 无超时等待用户作答 → end（带 interaction/answer）。返回工具输出。
    ///
    /// `guard` 在整个等待期间存活；future 被取消（停止生成 / 注册表 cancel
    /// token）时随 future 一起 drop，注册表条目随之清理。一键断电
    /// （`cancel_all_genui_awaits`）drop Sender → `RecvError` → cancelled 输出。
    #[allow(clippy::too_many_arguments)]
    async fn run_await(
        call: &ToolCall,
        ctx: &ExecutionContext,
        start: Instant,
        spec: GenUiAwaitSpec,
        intent: &Value,
        content_str: &str,
        title: Option<&str>,
        research_session_id: Option<&str>,
        skeleton_ref: Option<&str>,
    ) -> Value {
        let tool_call_id = call.id.as_str();
        let block_count = Self::block_count(intent);

        // a) 先登记，确保 start 事件发出前前端提交即可命中
        let (guard, receiver) = register_genui_await(&ctx.session_id, tool_call_id, Arc::new(spec));

        // b) 预存 pending 快照：进程崩溃后回放见「会话中断，用户未作答」
        let snapshot = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            build_pending_snapshot_output(tool_call_id),
            start.elapsed().as_millis() as u64,
        );
        if let Err(error) = ctx.save_tool_block(&snapshot) {
            log::warn!(
                "[GenerativeUiExecutor] pending snapshot save failed (tool_call_id={}): {}",
                tool_call_id,
                error
            );
        }

        // c) 渲染界面（不发 end，块保持 running 直到作答）
        Self::emit_start(ctx, title, tool_call_id, true);
        Self::emit_chunk(ctx, content_str);

        // d) 无超时等待（看门狗已豁免；取消由注册表 cancel token 丢弃本 future）
        let outcome = receiver.await;
        drop(guard);

        // e) end 回显交互终态
        let output = build_await_outcome_output(tool_call_id, block_count, outcome);
        Self::emit_end(
            ctx,
            intent,
            research_session_id,
            skeleton_ref,
            Some(&output),
        );
        output
    }

    /// 显式启用 HPIAS 后端时 emit `session_started` 并启动 pipeline。
    /// 默认禁用态直接返回，让 Chat 只渲染 intent 中的静态研究块。
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
        let deps = HpiasResearchDeps {
            vfs_db: ctx.vfs_db.clone(),
            vfs_lance_store: ctx.vfs_lance_store.clone(),
            llm_manager: ctx.llm_manager.clone(),
        };
        let Some(backend) = create_research_backend(window.clone(), deps) else {
            return;
        };
        let emitter = HpiasEventEmitter::new(window);
        if let Err(error) = emitter.emit_session_started(session_id, question) {
            log::warn!(
                "[GenerativeUiExecutor] hpias_event session_started emit failed: {}",
                error
            );
        }
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
            Err(error) => return Ok(Self::reject(call, ctx, start, error)),
        };

        let await_answer = match Self::parse_await_answer(&call.arguments) {
            Ok(await_answer) => await_answer,
            Err(error) => return Ok(Self::reject(call, ctx, start, error)),
        };

        // 交互块 / 图片 / 追问按钮规则（Rust 为准）；await 时得到作答 spec
        let await_spec = match validate_genui_intent_rules(&intent, await_answer) {
            Ok(spec) => spec,
            Err(error) => return Ok(Self::reject(call, ctx, start, error)),
        };

        let note_edit = match Self::parse_note_edit(&call.arguments) {
            Ok(note_edit) => note_edit,
            Err(error) => return Ok(Self::reject(call, ctx, start, error)),
        };

        let research_session_id = Self::parse_research_session_id(&call.arguments, Some(&intent));

        if Self::intent_has_apply_note_edit(&intent) && note_edit.is_none() {
            let error = "intent 含 apply-note-edit 时必须提供 noteEdit 参数".to_string();
            return Ok(Self::reject(call, ctx, start, error));
        }

        // awaitAnswer 门禁：子代理 / 多变体 / 受限运行时 / DB 不可用 fail-closed
        if await_spec.is_some() {
            if let Err(error) = check_genui_await_context(ctx) {
                return Ok(Self::reject(call, ctx, start, error));
            }
        }

        let title = intent
            .get("meta")
            .and_then(|m| m.get("title"))
            .and_then(Value::as_str);
        let extracted_question = extract_question_from_intent(&intent);
        let hpias_question = title.or(extracted_question.as_deref());
        let skeleton_ref = Self::parse_skeleton_ref(&call.arguments);

        let content_str =
            serde_json::to_string(&intent).map_err(|e| format!("intent 序列化失败: {}", e))?;

        let mut output = match await_spec {
            Some(spec) => {
                Self::run_await(
                    call,
                    ctx,
                    start,
                    spec,
                    &intent,
                    &content_str,
                    title,
                    research_session_id.as_deref(),
                    skeleton_ref.as_deref(),
                )
                .await
            }
            None => {
                Self::emit_start(ctx, title, &call.id, false);
                Self::emit_chunk(ctx, &content_str);
                Self::emit_end(
                    ctx,
                    &intent,
                    research_session_id.as_deref(),
                    skeleton_ref.as_deref(),
                    None,
                );
                build_rendered_output(Self::block_count(&intent))
            }
        };

        if let Some(ref session_id) = research_session_id {
            if intent_has_research_blocks(&intent) {
                Self::emit_hpias_session_started_if_needed(
                    ctx,
                    session_id,
                    hpias_question,
                    &intent,
                );
            }
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        if let Some(ref session_id) = research_session_id {
            output["researchSessionId"] = json!(session_id);
        }

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
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
    fn block_type_mapping_for_render_generative_ui_is_generative_ui() {
        use crate::chat_v2::context::PipelineContext;
        use crate::chat_v2::types::block_types;

        for tool_name in ["render_generative_ui", "builtin-render_generative_ui"] {
            assert_eq!(
                PipelineContext::get_block_type_for_tool_static(tool_name),
                block_types::GENERATIVE_UI,
                "unexpected block type for {tool_name}"
            );
        }
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
    fn parse_intent_rejects_oversized_payload() {
        let huge = "x".repeat(256_001);
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": [{ "type": "text", "props": { "body": huge } }]
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("oversized");
        assert!(err.contains("256000") || err.contains("上限"));
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
    fn parse_intent_rejects_unknown_block_type() {
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": [{ "type": "unknown-widget", "props": {} }]
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("unknown type");
        assert!(err.contains("unknown-widget"));
        assert!(err.contains("type"));
    }

    #[test]
    fn parse_intent_rejects_missing_block_type() {
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": [{ "props": { "text": "hi" } }]
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("missing type");
        assert!(err.contains("type"));
    }

    #[test]
    fn parse_intent_rejects_non_object_block() {
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": ["text"]
            }
        });
        let err = GenerativeUiExecutor::parse_intent(&args).expect_err("non-object block");
        assert!(err.contains("对象"));
    }

    #[test]
    fn parse_intent_accepts_all_registered_block_types() {
        // 白名单 18 → 21：原有 18 种 + choice / form / image（不得重复登记）
        for new_type in GENUI_NEW_BLOCK_TYPES {
            assert!(
                !ALLOWED_GENERATIVE_UI_BLOCK_TYPES.contains(new_type),
                "{new_type} must only be registered once"
            );
        }
        let all_types: Vec<&str> = ALLOWED_GENERATIVE_UI_BLOCK_TYPES
            .iter()
            .chain(GENUI_NEW_BLOCK_TYPES.iter())
            .copied()
            .collect();
        assert_eq!(all_types.len(), 21);
        for block_type in ["choice", "form", "image"] {
            assert!(all_types.contains(&block_type), "missing {block_type}");
        }

        let blocks: Vec<Value> = all_types
            .iter()
            .map(|block_type| json!({ "type": block_type, "props": {} }))
            .collect();
        let args = json!({
            "intent": {
                "version": "1",
                "blocks": blocks
            }
        });
        let intent = GenerativeUiExecutor::parse_intent(&args).expect("all 21 types");
        assert_eq!(
            intent
                .get("blocks")
                .and_then(Value::as_array)
                .map(|a| a.len()),
            Some(21)
        );
    }

    #[test]
    fn parse_await_answer_defaults_false_and_requires_bool() {
        assert_eq!(
            GenerativeUiExecutor::parse_await_answer(&json!({})),
            Ok(false)
        );
        assert_eq!(
            GenerativeUiExecutor::parse_await_answer(&json!({ "awaitAnswer": null })),
            Ok(false)
        );
        assert_eq!(
            GenerativeUiExecutor::parse_await_answer(&json!({ "awaitAnswer": true })),
            Ok(true)
        );
        assert!(
            GenerativeUiExecutor::parse_await_answer(&json!({ "awaitAnswer": "yes" })).is_err()
        );
    }

    #[test]
    fn parse_research_session_id_accepts_non_empty_string() {
        let args = json!({ "researchSessionId": " hpias-s1 " });
        assert_eq!(
            GenerativeUiExecutor::parse_research_session_id(&args, None).as_deref(),
            Some("hpias-s1")
        );
    }

    #[test]
    fn parse_research_session_id_rejects_blank() {
        let args = json!({ "researchSessionId": "   " });
        assert!(GenerativeUiExecutor::parse_research_session_id(&args, None).is_none());
    }

    #[test]
    fn parse_research_session_id_rejects_unsafe_or_oversized() {
        let oversized = json!({ "researchSessionId": "x".repeat(129) });
        assert!(GenerativeUiExecutor::parse_research_session_id(&oversized, None).is_none());
        let traversal = json!({ "researchSessionId": "../evil" });
        assert!(GenerativeUiExecutor::parse_research_session_id(&traversal, None).is_none());
        let scheme = json!({ "researchSessionId": "javascript:alert(1)" });
        assert!(GenerativeUiExecutor::parse_research_session_id(&scheme, None).is_none());
    }

    #[test]
    fn parse_research_session_id_falls_back_to_intent_meta() {
        let intent = json!({
            "version": "1",
            "meta": { "researchSessionId": " meta-s1 " },
            "blocks": [{ "type": "research-plan", "props": { "title": "Plan", "steps": [] } }]
        });
        let args = json!({ "intent": intent });
        assert_eq!(
            GenerativeUiExecutor::parse_research_session_id(&args, Some(&intent)).as_deref(),
            Some("meta-s1")
        );
    }

    #[test]
    fn parse_research_session_id_prefers_top_level_over_meta() {
        let intent = json!({
            "meta": { "researchSessionId": "meta-s1" }
        });
        let args = json!({ "researchSessionId": "top-s1" });
        assert_eq!(
            GenerativeUiExecutor::parse_research_session_id(&args, Some(&intent)).as_deref(),
            Some("top-s1")
        );
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
    fn parse_skeleton_ref_accepts_valid_skill_id() {
        let args = json!({ "skeletonRef": "weekly-report" });
        assert_eq!(
            GenerativeUiExecutor::parse_skeleton_ref(&args).as_deref(),
            Some("weekly-report")
        );
    }

    #[test]
    fn parse_skeleton_ref_rejects_invalid_or_absent() {
        // 缺失
        assert!(GenerativeUiExecutor::parse_skeleton_ref(&json!({})).is_none());
        // 非字符串
        assert!(GenerativeUiExecutor::parse_skeleton_ref(&json!({ "skeletonRef": 42 })).is_none());
        // 非法字符（空格/斜杠）
        assert!(
            GenerativeUiExecutor::parse_skeleton_ref(&json!({ "skeletonRef": "bad id" })).is_none()
        );
        assert!(
            GenerativeUiExecutor::parse_skeleton_ref(&json!({ "skeletonRef": "../escape" }))
                .is_none()
        );
        // 超长
        let long = "a".repeat(200);
        assert!(
            GenerativeUiExecutor::parse_skeleton_ref(&json!({ "skeletonRef": long })).is_none()
        );
    }

    #[test]
    fn parse_note_edit_accepts_append_payload() {
        let args = json!({
            "noteEdit": { "operation": "append", "content": "## Summary" }
        });
        let note_edit = GenerativeUiExecutor::parse_note_edit(&args)
            .expect("parse")
            .expect("present");
        assert_eq!(
            note_edit.get("operation").and_then(Value::as_str),
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
    fn parse_note_edit_rejects_oversized_payload() {
        let huge = "x".repeat(256 * 1024 + 1);
        let args = json!({
            "noteEdit": { "operation": "append", "content": huge }
        });
        let error = GenerativeUiExecutor::parse_note_edit(&args).expect_err("size");
        // 限制值 256 * 1024 = 262144 字节
        assert!(error.contains("262144"));
    }

    #[test]
    fn parse_note_edit_strips_unknown_fields() {
        let args = json!({
            "noteEdit": {
                "operation": "append",
                "content": "## Summary",
                "className": "x",
                "isRegex": false
            }
        });
        let note_edit = GenerativeUiExecutor::parse_note_edit(&args)
            .expect("parse")
            .expect("present");
        let obj = note_edit.as_object().expect("object");
        assert_eq!(obj.get("operation").and_then(Value::as_str), Some("append"));
        assert_eq!(
            obj.get("content").and_then(Value::as_str),
            Some("## Summary")
        );
        assert!(!obj.contains_key("className"));
        assert!(!obj.contains_key("isRegex"));
    }

    #[test]
    fn parse_note_edit_rejects_non_string_fields() {
        let args = json!({
            "noteEdit": { "operation": "append", "content": ["not", "a", "string"] }
        });
        let error = GenerativeUiExecutor::parse_note_edit(&args).expect_err("type");
        assert!(error.contains("content"));
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
        assert_eq!(result.output, build_rendered_output(2));
        assert!(
            result
                .output
                .get("note")
                .and_then(Value::as_str)
                .is_some_and(|note| !note.is_empty()),
            "rendered output must carry the no-recap note"
        );
        assert!(result.output.get("interaction").is_none());
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

    // ========================================================================
    // awaitAnswer：挂起 → 作答 / 中止 / 取消 / 拒绝
    // ========================================================================

    use super::super::genui_interaction::{
        cancel_all_genui_awaits, dismiss_genui_await, is_yield_turn_result,
        list_pending_genui_awaits, submit_genui_answer, GenUiDismissReason, GenUiSubmitResult,
        GENUI_AWAIT_CONTEXT_REJECTED, GENUI_AWAIT_REQUIRES_INTERACTIVE,
        GENUI_INTERACTIVE_REQUIRES_AWAIT,
    };
    use crate::chat_v2::database::ChatV2Database;
    use crate::chat_v2::events::{BackendEvent, ExecutionEventSink, SessionEvent};
    use crate::chat_v2::repo::ChatV2Repo;
    use crate::chat_v2::tools::ToolExecutorRegistry;
    use crate::chat_v2::types::ChatSession;
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use tokio_util::sync::CancellationToken;

    /// 本模块 await 用例串行：`cancel_all_genui_awaits` 会清空进程级注册表。
    /// （dstu-agent 的 `lock_genui_registry_for_test` 是 `cfg(test)` 项，跨 crate 不可见。）
    static GENUI_AWAIT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[derive(Default)]
    struct RecordingSink {
        events: std::sync::Mutex<Vec<Value>>,
    }

    impl RecordingSink {
        fn generative_ui_events(&self) -> Vec<Value> {
            self.events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .filter(|event| event["type"] == event_types::GENERATIVE_UI)
                .cloned()
                .collect()
        }

        fn phase(&self, phase: &str) -> Option<Value> {
            self.generative_ui_events()
                .into_iter()
                .find(|event| event["phase"] == phase)
        }
    }

    impl ExecutionEventSink for RecordingSink {
        fn emit_block_event(&self, _channel: &str, event: &BackendEvent) {
            if let Ok(value) = serde_json::to_value(event) {
                self.events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(value);
            }
        }

        fn emit_session_event(&self, _channel: &str, _event: &SessionEvent) {}

        fn window(&self) -> Option<tauri::Window> {
            None
        }
    }

    struct AwaitHarness {
        _dir: tempfile::TempDir,
        ctx: ExecutionContext,
        sink: Arc<RecordingSink>,
        db: Arc<ChatV2Database>,
    }

    /// 带已迁移 ChatV2 DB（awaitAnswer 门禁 fail-closed 需要 DB）与录制 sink 的上下文。
    fn await_harness(session_id: &str, session_mode: &str, block_id: &str) -> AwaitHarness {
        let dir = tempfile::tempdir().expect("create ChatV2 test directory");
        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("apply ChatV2 migrations");
        let db = Arc::new(ChatV2Database::new(dir.path()).expect("open migrated ChatV2 database"));
        ChatV2Repo::create_session_v2(
            &db,
            &ChatSession::new(session_id.to_string(), session_mode.to_string()),
        )
        .expect("persist session");

        let sink = Arc::new(RecordingSink::default());
        let dyn_sink: Arc<dyn ExecutionEventSink> = sink.clone();
        let emitter = Arc::new(ChatV2EventEmitter::with_sink(
            dyn_sink,
            session_id.to_string(),
        ));
        let ctx = ExecutionContext::new(
            session_id.to_string(),
            format!("msg_{block_id}"),
            block_id.to_string(),
            emitter,
            Arc::new(ToolRegistry::new()),
            None,
        )
        .with_chat_v2_db(Some(db.clone()));
        AwaitHarness {
            _dir: dir,
            ctx,
            sink,
            db,
        }
    }

    fn choice_intent() -> Value {
        json!({
            "version": "1.1",
            "meta": { "title": "小测" },
            "blocks": [
                { "type": "text", "props": { "body": "回答下面的问题" } },
                {
                    "type": "choice",
                    "id": "q1",
                    "props": {
                        "question": "2+2=?",
                        "options": [
                            { "id": "a", "label": "4" },
                            { "id": "b", "label": "5" },
                            { "id": "c", "label": "22" }
                        ]
                    }
                }
            ]
        })
    }

    fn q1_answer(option_id: &str) -> Value {
        json!({ "q1": { "selected": [option_id] } })
    }

    fn await_call(call_id: &str) -> ToolCall {
        ToolCall::new(
            call_id.to_string(),
            "builtin-render_generative_ui".to_string(),
            json!({ "awaitAnswer": true, "intent": choice_intent() }),
        )
    }

    /// 轮询直到 (session, call) 出现在挂起列表。
    async fn wait_until_pending(session_id: &str, call_id: &str) {
        for _ in 0..400 {
            if list_pending_genui_awaits(session_id)
                .iter()
                .any(|id| id == call_id)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for pending generative UI await {call_id}");
    }

    fn stored_tool_output(db: &ChatV2Database, block_id: &str) -> Option<Value> {
        let conn = db.get_conn_safe().expect("chat v2 conn");
        let raw: Option<String> = conn
            .query_row(
                "SELECT tool_output_json FROM chat_v2_blocks WHERE id = ?1",
                rusqlite::params![block_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        raw.and_then(|text| serde_json::from_str(&text).ok())
    }

    #[tokio::test]
    async fn execute_non_await_start_carries_tool_call_id_and_rendered_note() {
        let harness = await_harness("sess_genui_rendered", "chat", "blk_genui_rendered");
        let call = ToolCall::new(
            "call_genui_rendered".to_string(),
            "render_generative_ui".to_string(),
            json!({
                "intent": {
                    "version": "1",
                    "meta": { "title": "Briefing" },
                    "blocks": [{ "type": "stat-card", "props": { "title": "Due", "value": 3 } }]
                }
            }),
        );

        let result = GenerativeUiExecutor::new()
            .execute(&call, &harness.ctx)
            .await
            .expect("execute returns ToolResultInfo");

        assert!(result.success, "unexpected error: {:?}", result.error);
        assert_eq!(result.output, build_rendered_output(1));
        let start = harness.sink.phase("start").expect("start event");
        assert_eq!(start["payload"]["toolCallId"], "call_genui_rendered");
        assert_eq!(start["payload"]["title"], "Briefing");
        assert!(start["payload"].get("awaitAnswer").is_none());
        let end = harness.sink.phase("end").expect("end event");
        assert!(end["result"].get("interaction").is_none());
    }

    #[tokio::test]
    async fn execute_await_answer_returns_answered_after_submit() {
        let _lock = GENUI_AWAIT_TEST_LOCK.lock().await;
        let session_id = "sess_genui_await_answered";
        let call_id = "call_genui_await_answered";
        let block_id = "blk_genui_await_answered";
        let harness = await_harness(session_id, "chat", block_id);
        let call = await_call(call_id);
        let executor = GenerativeUiExecutor::new();

        let (result, ()) = tokio::join!(executor.execute(&call, &harness.ctx), async {
            wait_until_pending(session_id, call_id).await;

            // 等待期间：start 已带 toolCallId/awaitAnswer，chunk 已发，end 未发
            let start = harness
                .sink
                .phase("start")
                .expect("start event while pending");
            assert_eq!(start["payload"]["toolCallId"], call_id);
            assert_eq!(start["payload"]["awaitAnswer"], true);
            assert_eq!(start["payload"]["title"], "小测");
            assert!(harness.sink.phase("chunk").is_some());
            assert!(harness.sink.phase("end").is_none());
            // 预存快照：崩溃回放见 pending / interrupted
            let snapshot = stored_tool_output(&harness.db, block_id).expect("pending snapshot");
            assert_eq!(snapshot["interaction"]["state"], "pending");
            assert_eq!(snapshot["reason"], "interrupted");

            // 非法答案不消费等待
            assert!(matches!(
                submit_genui_answer(session_id, call_id, "选了 9", &q1_answer("z")),
                GenUiSubmitResult::Invalid(_)
            ));
            assert_eq!(
                submit_genui_answer(session_id, call_id, "选了 4", &q1_answer("a")),
                GenUiSubmitResult::Accepted
            );
        });

        let result = result.expect("execute returns ToolResultInfo");
        assert!(result.success, "unexpected error: {:?}", result.error);
        let output = &result.output;
        assert_eq!(output["status"], "answered");
        assert_eq!(output["answered"], true);
        assert_eq!(output["blockCount"], 2);
        assert_eq!(output["interaction"]["state"], "answered");
        assert_eq!(output["interaction"]["toolCallId"], call_id);
        assert!(output["interaction"]["answeredAt"].is_i64());
        assert_eq!(output["answer"]["summary"], "选了 4");
        assert_eq!(output["answer"]["data"]["q1"]["selected"], json!(["a"]));
        assert_eq!(output["answer"]["trust"], "untrusted_user_input");
        assert!(!is_yield_turn_result(&call.name, output));

        let end = harness.sink.phase("end").expect("end event");
        assert_eq!(end["result"]["interaction"], output["interaction"]);
        assert_eq!(end["result"]["answer"], output["answer"]);
        assert_eq!(end["result"]["isStreaming"], false);
        assert!(end["result"]["intent"]["blocks"].is_array());

        assert!(list_pending_genui_awaits(session_id).is_empty());
        let stored = stored_tool_output(&harness.db, block_id).expect("final block");
        assert_eq!(stored["interaction"]["state"], "answered");
        // 重复提交 → expired
        assert_eq!(
            submit_genui_answer(session_id, call_id, "选了 4", &q1_answer("a")),
            GenUiSubmitResult::Expired
        );
    }

    #[tokio::test]
    async fn execute_await_dismissed_by_user_message_yields_turn() {
        let _lock = GENUI_AWAIT_TEST_LOCK.lock().await;
        let session_id = "sess_genui_await_user_message";
        let call_id = "call_genui_await_user_message";
        let harness = await_harness(session_id, "chat", "blk_genui_await_user_message");
        let call = await_call(call_id);
        let executor = GenerativeUiExecutor::new();

        let (result, ()) = tokio::join!(executor.execute(&call, &harness.ctx), async {
            wait_until_pending(session_id, call_id).await;
            assert_eq!(
                dismiss_genui_await(session_id, call_id, GenUiDismissReason::UserMessage),
                GenUiSubmitResult::Accepted
            );
        });

        let result = result.expect("execute returns ToolResultInfo");
        assert!(result.success);
        let output = &result.output;
        assert_eq!(output["status"], "not_answered");
        assert_eq!(output["yieldTurn"], true);
        assert_eq!(output["reason"], "user_replied_in_chat");
        assert_eq!(output["interaction"]["state"], "dismissed");
        assert_eq!(output["interaction"]["reason"], "user_message");
        assert!(output.get("answer").is_none());
        assert!(is_yield_turn_result(&call.name, output));

        let end = harness.sink.phase("end").expect("end event");
        assert_eq!(end["result"]["interaction"]["state"], "dismissed");
        assert!(end["result"].get("answer").is_none());
        assert!(list_pending_genui_awaits(session_id).is_empty());
    }

    #[tokio::test]
    async fn execute_await_skipped_does_not_yield_turn() {
        let _lock = GENUI_AWAIT_TEST_LOCK.lock().await;
        let session_id = "sess_genui_await_skipped";
        let call_id = "call_genui_await_skipped";
        let harness = await_harness(session_id, "chat", "blk_genui_await_skipped");
        let call = await_call(call_id);
        let executor = GenerativeUiExecutor::new();

        let (result, ()) = tokio::join!(executor.execute(&call, &harness.ctx), async {
            wait_until_pending(session_id, call_id).await;
            assert_eq!(
                dismiss_genui_await(session_id, call_id, GenUiDismissReason::Skipped),
                GenUiSubmitResult::Accepted
            );
        });

        let output = result.expect("execute returns ToolResultInfo").output;
        assert_eq!(output["reason"], "skipped_by_user");
        assert_eq!(output["interaction"]["reason"], "skipped");
        assert!(!is_yield_turn_result(&call.name, &output));
    }

    #[tokio::test]
    async fn execute_await_cancelled_via_registry_token_clears_pending() {
        let _lock = GENUI_AWAIT_TEST_LOCK.lock().await;
        let session_id = "sess_genui_await_cancel_token";
        let call_id = "call_genui_await_cancel_token";
        let harness = await_harness(session_id, "chat", "blk_genui_await_cancel_token");
        let token = CancellationToken::new();
        let ctx = harness.ctx.scoped_with_cancellation_token(token.clone());
        let call = await_call(call_id);
        let mut registry = ToolExecutorRegistry::new();
        registry.register(Arc::new(GenerativeUiExecutor::new()));

        let (result, ()) = tokio::join!(registry.execute(&call, &ctx), async {
            wait_until_pending(session_id, call_id).await;
            token.cancel();
        });

        let error = result.expect_err("cancelled tool returns registry error");
        assert!(
            error.contains("TOOL_CANCELLED"),
            "unexpected cancel error: {error}"
        );
        assert!(
            list_pending_genui_awaits(session_id).is_empty(),
            "guard must drop the pending entry when the future is cancelled"
        );
        assert_eq!(
            submit_genui_answer(session_id, call_id, "迟到", &q1_answer("a")),
            GenUiSubmitResult::Expired
        );
    }

    #[tokio::test]
    async fn execute_await_kill_switch_returns_cancelled_output() {
        let _lock = GENUI_AWAIT_TEST_LOCK.lock().await;
        let session_id = "sess_genui_await_kill_switch";
        let call_id = "call_genui_await_kill_switch";
        let harness = await_harness(session_id, "chat", "blk_genui_await_kill_switch");
        let call = await_call(call_id);
        let executor = GenerativeUiExecutor::new();

        let (result, ()) = tokio::join!(executor.execute(&call, &harness.ctx), async {
            wait_until_pending(session_id, call_id).await;
            assert!(cancel_all_genui_awaits() >= 1);
        });

        let output = result.expect("execute returns ToolResultInfo").output;
        assert_eq!(output["status"], "not_answered");
        assert_eq!(output["reason"], "stopped");
        assert_eq!(output["interaction"]["state"], "cancelled");
        assert_eq!(output["interaction"]["reason"], "stopped");
        let end = harness.sink.phase("end").expect("end event");
        assert_eq!(end["result"]["interaction"]["state"], "cancelled");
        assert!(list_pending_genui_awaits(session_id).is_empty());
    }

    async fn assert_await_rejected(
        harness: &AwaitHarness,
        ctx: &ExecutionContext,
        call: ToolCall,
        needle: &str,
    ) {
        let session_id = ctx.session_id.clone();
        let result = GenerativeUiExecutor::new()
            .execute(&call, ctx)
            .await
            .expect("execute returns ToolResultInfo");
        assert!(!result.success, "await must be rejected");
        let error = result.error.as_deref().unwrap_or("");
        assert!(error.contains(needle), "expected {needle:?} in {error:?}");
        assert!(list_pending_genui_awaits(&session_id).is_empty());
        assert!(
            harness.sink.phase("error").is_some(),
            "error event expected"
        );
        let start = harness.sink.phase("start").expect("start event");
        assert_eq!(start["payload"]["toolCallId"], call.id.as_str());
    }

    #[tokio::test]
    async fn execute_await_rejected_for_variant_context() {
        let harness = await_harness(
            "sess_genui_reject_variant",
            "chat",
            "blk_genui_reject_variant",
        );
        let ctx = harness
            .ctx
            .scoped_with_cancellation_token(CancellationToken::new())
            .with_variant_id(Some("var_1".to_string()));
        assert_await_rejected(
            &harness,
            &ctx,
            await_call("call_genui_reject_variant"),
            GENUI_AWAIT_CONTEXT_REJECTED,
        )
        .await;
    }

    #[tokio::test]
    async fn execute_await_rejected_for_subagent_session() {
        let harness = await_harness(
            "sess_genui_reject_subagent",
            "subagent",
            "blk_genui_reject_subagent",
        );
        assert_await_rejected(
            &harness,
            &harness.ctx,
            await_call("call_genui_reject_subagent"),
            GENUI_AWAIT_CONTEXT_REJECTED,
        )
        .await;
    }

    #[tokio::test]
    async fn execute_await_rejected_for_restricted_runtime() {
        let harness = await_harness(
            "sess_genui_reject_restricted",
            "chat",
            "blk_genui_reject_restricted",
        );
        let ctx = harness
            .ctx
            .scoped_with_cancellation_token(CancellationToken::new())
            .with_execution_allowed_tools(Some(vec!["render_generative_ui".to_string()]));
        assert_await_rejected(
            &harness,
            &ctx,
            await_call("call_genui_reject_restricted"),
            GENUI_AWAIT_CONTEXT_REJECTED,
        )
        .await;
    }

    #[tokio::test]
    async fn execute_await_rejected_without_db() {
        let result = GenerativeUiExecutor::new()
            .execute(
                &await_call("call_genui_reject_no_db"),
                &test_ctx("blk_genui_reject_no_db"),
            )
            .await
            .expect("execute returns ToolResultInfo");
        assert!(!result.success);
        assert!(result
            .error
            .as_deref()
            .unwrap_or("")
            .contains(GENUI_AWAIT_CONTEXT_REJECTED));
    }

    #[tokio::test]
    async fn execute_await_rejected_without_interactive_blocks() {
        let harness = await_harness(
            "sess_genui_reject_no_interactive",
            "chat",
            "blk_genui_reject_no_interactive",
        );
        let call = ToolCall::new(
            "call_genui_reject_no_interactive".to_string(),
            "render_generative_ui".to_string(),
            json!({
                "awaitAnswer": true,
                "intent": {
                    "version": "1",
                    "blocks": [{ "type": "text", "props": { "body": "hi" } }]
                }
            }),
        );
        assert_await_rejected(
            &harness,
            &harness.ctx,
            call,
            GENUI_AWAIT_REQUIRES_INTERACTIVE,
        )
        .await;
    }

    #[tokio::test]
    async fn execute_rejects_interactive_blocks_without_await() {
        let harness = await_harness(
            "sess_genui_reject_no_await",
            "chat",
            "blk_genui_reject_no_await",
        );
        let call = ToolCall::new(
            "call_genui_reject_no_await".to_string(),
            "render_generative_ui".to_string(),
            json!({ "intent": choice_intent() }),
        );
        assert_await_rejected(
            &harness,
            &harness.ctx,
            call,
            GENUI_INTERACTIVE_REQUIRES_AWAIT,
        )
        .await;
    }
}
