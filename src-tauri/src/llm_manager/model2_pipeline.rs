//! 模型二管线（核心解析/对话）
//!
//! 从 llm_manager.rs 拆分的流式和非流式对话管线

use crate::models::{AppError, ChatMessage, StandardModel2Output, StreamChunk};
use crate::providers::ProviderAdapter;
use crate::reasoning_policy::{
    get_passback_policy, requires_reasoning_passback, ReasoningPassbackPolicy,
};
use crate::utils::chat_timing;
use futures_util::StreamExt;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{Emitter, Window};
use url::Url;
use uuid::Uuid;

use super::{
    adapters::get_adapter, parser, ApiConfig, ImagePayload, LLMManager, MergedChatMessage, Result,
};

#[inline]
fn is_qwen_config(config: &ApiConfig) -> bool {
    config
        .provider_type
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("qwen"))
        .unwrap_or(false)
        || config.model_adapter.eq_ignore_ascii_case("qwen")
}

#[inline]
fn remove_thinking_fields_for_tool_compat(body: &mut Value) {
    if let Some(map) = body.as_object_mut() {
        map.remove("enable_thinking");
        map.remove("include_thoughts");
        map.remove("thinking_budget");
        map.remove("thinking");
    }
}

/// 计算有效的 max_tokens，应用供应商级别的限制
/// DeepSeek 等供应商有 max_tokens 上限（如 8192），超出会返回 400 错误
#[inline]
fn effective_max_tokens(max_output_tokens: u32, max_tokens_limit: Option<u32>) -> u32 {
    match max_tokens_limit {
        Some(limit) => max_output_tokens.min(limit),
        None => max_output_tokens,
    }
}

/// 统一使用 debug_log_service 的 standard 级别脱敏（准确的 base64 大小计算）
pub(crate) fn sanitize_request_body_for_audit(body: &serde_json::Value) -> serde_json::Value {
    let mut sanitized = crate::debug_log_service::sanitize_for_level(
        body,
        crate::debug_log_service::DebugFilterLevel::Standard,
    );
    redact_user_profile_blocks_in_value(&mut sanitized);
    sanitized
}

fn redact_user_profile_blocks_in_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            *s = redact_user_profile_blocks_in_text(s);
        }
        serde_json::Value::Array(items) => {
            for v in items {
                redact_user_profile_blocks_in_value(v);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map {
                redact_user_profile_blocks_in_value(v);
            }
        }
        _ => {}
    }
}

fn redact_user_profile_blocks_in_text(text: &str) -> String {
    const START: &str = "<user_profile>";
    const END: &str = "</user_profile>";
    if !text.contains(START) {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(start_idx) = rest.find(START) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start_idx]);
        let after_start = &rest[start_idx + START.len()..];
        if let Some(end_rel) = after_start.find(END) {
            out.push_str("<user_profile>[REDACTED]</user_profile>");
            rest = &after_start[end_rel + END.len()..];
        } else {
            out.push_str("[REDACTED:user_profile]");
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::llm_manager::ApiConfig;

    #[test]
    fn test_redact_user_profile_blocks_in_text() {
        let input = "A<user_profile>\nsecret\n</user_profile>B";
        let redacted = redact_user_profile_blocks_in_text(input);
        assert!(redacted.contains("<user_profile>[REDACTED]</user_profile>"));
        assert!(!redacted.contains("secret"));
    }

    #[test]
    fn test_sanitize_request_body_for_audit_redacts_user_profile() {
        let body = json!({
            "messages": [
                {
                    "role": "system",
                    "content": "prefix <user_profile>very sensitive</user_profile> suffix"
                }
            ]
        });
        let sanitized = sanitize_request_body_for_audit(&body);
        let content = sanitized["messages"][0]["content"]
            .as_str()
            .unwrap_or_default();
        assert!(content.contains("[REDACTED]"));
        assert!(!content.contains("very sensitive"));
    }

    #[test]
    fn test_should_use_openai_responses_for_o4_reasoning_models() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            model: "o4-mini".to_string(),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        };

        assert!(should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_should_not_use_openai_responses_for_non_general_adapter() {
        let config = ApiConfig {
            model_adapter: "qwen".to_string(),
            model: "o4-mini".to_string(),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        };

        assert!(!should_use_openai_responses_for_config(&config));
    }
}

fn should_use_openai_responses_for_config(config: &ApiConfig) -> bool {
    if config.model_adapter != "general" {
        return false;
    }
    if !(config.is_reasoning || config.supports_reasoning) {
        return false;
    }
    let lower = config.model.to_lowercase();
    lower.contains("o1")
        || lower.contains("o3")
        || lower.contains("o4")
        || lower.contains("gpt-5")
}

/// 输出审计日志（info 级别）+ 可选文件持久化（用于无 window 的非流式路径）
pub(crate) fn log_llm_request_audit(
    tag: &str,
    url: &str,
    model: &str,
    body: &serde_json::Value,
    persist_config: Option<&DebugPersistConfig>,
) {
    let sanitized = sanitize_request_body_for_audit(body);
    match serde_json::to_string_pretty(&sanitized) {
        Ok(pretty) => info!(
            "[LLM_AUDIT:{}] model={} url={}\n{}",
            tag, model, url, pretty
        ),
        Err(e) => warn!(
            "[LLM_AUDIT:{}] model={} url={} (序列化失败: {})",
            tag, model, url, e
        ),
    }

    if let Some(c) = persist_config {
        crate::debug_log_service::write_debug_log_entry(&c.log_dir, tag, model, url, "", body);
    }
}

/// 调试日志持久化配置（由调用方从 DB 设置构造）
///
/// 存在即表示已启用，不需要额外 enabled 字段。
pub(crate) struct DebugPersistConfig {
    pub log_dir: std::path::PathBuf,
}

/// ★ 审计日志 + 前端推送 + 可选文件持久化
///
/// 1. 输出 info 级别审计日志（始终 standard 级别）
/// 2. 如果 stream_event 以 `chat_v2_event_` 开头，推送给前端
/// 3. 如果 persist_config 存在（Some），将完整请求体写入 JSON 文件
pub(crate) fn log_and_emit_llm_request(
    tag: &str,
    window: &tauri::Window,
    stream_event: &str,
    message_id: Option<&str>,
    model: &str,
    url: &str,
    body: &serde_json::Value,
    persist_config: Option<&DebugPersistConfig>,
) {
    let sanitized = sanitize_request_body_for_audit(body);

    // 1. 审计日志（始终 standard 级别，避免泄漏 base64）
    match serde_json::to_string_pretty(&sanitized) {
        Ok(pretty) => info!(
            "[LLM_AUDIT:{}] model={} url={}\n{}",
            tag, model, url, pretty
        ),
        Err(e) => warn!(
            "[LLM_AUDIT:{}] model={} url={} (序列化失败: {})",
            tag, model, url, e
        ),
    }

    // 2. 文件持久化（完整未脱敏请求体）
    let log_file_path = persist_config
        .and_then(|c| {
            crate::debug_log_service::write_debug_log_entry(
                &c.log_dir,
                tag,
                model,
                url,
                stream_event,
                body,
            )
        })
        .map(|p| p.to_string_lossy().to_string());

    // 3. 推送给前端（仅 Chat V2 流）
    let prefix = "chat_v2_event_";
    if !stream_event.starts_with(prefix) {
        return;
    }

    let payload = json!({
        "streamEvent": stream_event,
        "messageId": message_id,
        "model": model,
        "url": url,
        "requestBody": sanitized,
        "logFilePath": log_file_path,
    });

    if let Err(e) = window.emit("chat_v2_llm_request_body", &payload) {
        warn!("[LLM_AUDIT] Failed to emit llm_request_body event: {}", e);
    }
}

impl LLMManager {
    /// 从 DB 读取 debug 持久化配置
    fn build_debug_persist_config(&self) -> Option<DebugPersistConfig> {
        let enabled = self
            .db
            .get_setting("debug.persist_logs")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false);
        if !enabled {
            return None;
        }
        Some(DebugPersistConfig {
            log_dir: crate::debug_log_service::ensure_debug_log_dir(
                self.file_manager.get_app_data_dir(),
            ),
        })
    }

    // 统一AI接口层 - 模型二（核心解析/对话）- 流式版本
    pub async fn call_unified_model_2_stream(
        &self,
        context: &HashMap<String, Value>,
        chat_history: &[ChatMessage],
        subject: &str,
        enable_chain_of_thought: bool,
        enable_thinking: bool,
        task_context: Option<&str>,
        window: Window,
        stream_event: &str,
        message_id: Option<&str>,
        _trace_id: Option<&str>,
        disable_tools: bool,
        _max_input_tokens_override: Option<usize>,
        model_override_id: Option<String>,
        temp_override: Option<f32>,
        system_prompt_override: Option<String>,
        top_p_override: Option<f32>,
        frequency_penalty_override: Option<f32>,
        presence_penalty_override: Option<f32>,
        max_output_tokens_override: Option<u32>,
    ) -> Result<StandardModel2Output> {
        info!(
            "调用统一模型二接口(流式): 科目={}, 思维链={}, override_model={:?}",
            subject, enable_chain_of_thought, model_override_id
        );

        // 记录开始时间和统计信息
        let _start_instant = std::time::Instant::now();
        let mut request_bytes = 0usize;
        let _response_bytes = 0usize;
        let _chunk_count = 0usize;

        // 获取模型配置（支持 override），根据任务上下文路由
        let task_key = match task_context {
            Some(tc) if tc.contains("review") => "review",
            Some(tc) if tc == "tag_generation" => "tag_generation",
            _ => "default",
        };
        let (config, _cot_by_model) = self
            .select_model_for(
                task_key,
                model_override_id.clone(),
                temp_override,
                top_p_override,
                frequency_penalty_override,
                presence_penalty_override,
                max_output_tokens_override,
            )
            .await?;

        // P1修复：图片上下文严格控制 - 图片由消息级字段提供，禁用会话级回退
        let images_used_source = "per_message_only".to_string();
        debug!("[LLM] 图片上下文策略: 仅消息级，禁用会话级回退");
        let images_base64: Option<Vec<String>> = None; // 会话级图片回退禁用

        // 记录一次 API 调用上下文（模型与图片使用情况）（简化：仅控制台输出以避免 Send 约束）
        debug!(
            "[model2_stream] model={} provider={} adapter={} multi={} reasoning={} temp={} cot={} images={{source:{},count:{}}}",
            config.model, config.name, config.model_adapter, config.is_multimodal, config.is_reasoning, config.temperature,
            enable_chain_of_thought, images_used_source, images_base64.as_ref().map(|v| v.len()).unwrap_or(0)
        );

        // 移除上下文预算裁剪：按照用户建议，完整保留历史，由前端展示token估算并由用户决定
        let chat_history = chat_history.to_vec();

        let mut messages = vec![];
        let mut pre_call_injection_texts: Vec<String> = Vec::new();
        if let Some(graph_inject) = Self::build_prefetched_graph_injection(context) {
            debug!(
                "[GraphInject] 已构建图谱召回注入内容，长度 {} 字符",
                graph_inject.chars().count()
            );
            pre_call_injection_texts.push(graph_inject);
        }

        // 注意：Canvas 笔记上下文已通过 prompt_builder 统一注入到 system_prompt_override 中
        // 不再在此处单独注入 canvas_note_context

        // 🔧 P2重构：移除旧版回退路径，所有注入统一由 prompt_builder 管理
        // Chat V2 Pipeline 始终传入 prompt_builder 生成的 XML 格式 system_prompt
        // 如果没有传入，使用科目默认 prompt（仅用于非 Chat V2 的旧版调用）
        let system_content =
            system_prompt_override.unwrap_or_else(|| self.get_subject_prompt(subject, "model2"));

        // 禁止在此拼接 RAG/Memory 文本，由工具闭环负责

        // 不再拼接 latest_user_query 等伪 system 注入

        // 🔧 P3修复：统一使用 system role，不再区分推理/非推理模型
        // 所有内容由 prompt_builder 统一管理，直接放入 system message
        messages.push(json!({ "role": "system", "content": system_content }));

        // 🔧 P1修复：预处理消息，合并连续的工具调用
        // OpenAI 协议期望：一个 assistant 消息包含 tool_calls 数组，然后跟着多个 tool 消息
        // 当前数据模型每个消息只有一个 tool_call，需要在序列化时合并
        let merged_history = Self::merge_consecutive_tool_calls(&chat_history);

        // 添加聊天历史（逐条处理用户图片与工具调用消息的标准化）
        for (_index, merged_msg) in merged_history.iter().enumerate() {
            match merged_msg {
                // 🔧 P1修复：处理合并的工具调用消息
                // 🔧 Anthropic 最佳实践：必须保留 thinking_content
                MergedChatMessage::MergedToolCalls {
                    tool_calls,
                    content,
                    thinking_content,
                    thought_signature,
                } => {
                    // 生成 tool_calls 数组
                    let tool_calls_arr: Vec<_> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.tool_name,
                                    "arguments": tc.args_json.to_string()
                                }
                            })
                        })
                        .collect();

                    // 🔧 辅助闭包：将 thought_signature 注入到 assistant 消息中
                    // Gemini 3 要求在包含 functionCall 的 model content 中回传 thoughtSignature
                    let inject_thought_signature = |msg: &mut Value| {
                        if let Some(ref sig) = thought_signature {
                            msg["thought_signature"] = json!(sig);
                        }
                    };

                    // 🔧 使用适配器系统处理工具调用消息格式
                    let has_thinking = thinking_content
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);
                    let adapter =
                        get_adapter(config.provider_type.as_deref(), &config.model_adapter);

                    // 尝试使用适配器的自定义格式
                    let tool_calls_json: Vec<Value> = tool_calls_arr.clone();
                    if has_thinking {
                        if let Some(formatted_content) = adapter
                            .format_tool_call_message(&tool_calls_json, thinking_content.as_deref())
                        {
                            let mut msg = json!({
                                "role": "assistant",
                                "content": formatted_content
                            });
                            inject_thought_signature(&mut msg);
                            messages.push(msg);

                            debug!(
                                "[LLMManager] Adapter {} format: {} tool_calls with thinking block (len={})",
                                adapter.id(),
                                tool_calls.len(),
                                thinking_content.as_ref().map(|s| s.len()).unwrap_or(0)
                            );
                        } else if requires_reasoning_passback(&config) {
                            // 其他推理模型（DeepSeek 等）：使用 reasoning_content 字段
                            let policy = get_passback_policy(&config);
                            let mut assistant_msg = json!({
                                "role": "assistant",
                                "content": content,
                                "tool_calls": tool_calls_arr
                            });

                            if let Some(ref thinking) = thinking_content {
                                match policy {
                                    ReasoningPassbackPolicy::DeepSeekStyle => {
                                        assistant_msg["reasoning_content"] = json!(thinking);
                                    }
                                    ReasoningPassbackPolicy::ReasoningDetails => {
                                        assistant_msg["reasoning_details"] = json!([{
                                            "type": "thinking",
                                            "text": thinking
                                        }]);
                                    }
                                    ReasoningPassbackPolicy::NoPassback => {}
                                }
                            }

                            inject_thought_signature(&mut assistant_msg);
                            messages.push(assistant_msg);

                            debug!(
                                "[LLMManager] Reasoning model: {} tool_calls with thinking (policy={:?})",
                                tool_calls.len(),
                                policy
                            );
                        } else {
                            // 无思维链或不需要回传（适配器未提供自定义格式）
                            let mut msg = json!({
                                "role": "assistant",
                                "content": content,
                                "tool_calls": tool_calls_arr
                            });
                            inject_thought_signature(&mut msg);
                            messages.push(msg);

                            debug!(
                                "[LLMManager] Merged {} tool_calls into single assistant message (no custom format)",
                                tool_calls.len()
                            );
                        }
                    } else {
                        // 无思维链
                        let mut msg = json!({
                            "role": "assistant",
                            "content": content,
                            "tool_calls": tool_calls_arr
                        });
                        inject_thought_signature(&mut msg);
                        messages.push(msg);

                        debug!(
                            "[LLMManager] Merged {} tool_calls into single assistant message",
                            tool_calls.len()
                        );
                    }
                }

                MergedChatMessage::Regular(msg) => {
                    // 处理用户消息
                    if msg.role == "user" {
                        // ★ 文档25：优先检查 multimodal_content（图文交替模式）
                        if config.is_multimodal
                            && msg
                                .multimodal_content
                                .as_ref()
                                .map(|v| !v.is_empty())
                                .unwrap_or(false)
                        {
                            // 使用 multimodal_content 构建交替的 content 数组
                            // ★ P0 架构改造：移除发送时压缩，图片已在预处理阶段压缩完成
                            // 注意：vision_quality 参数不再使用，保留代码以便调试
                            let _vq = context
                                .get("vision_quality")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");

                            let empty_multimodal: Vec<crate::models::MultimodalContentPart> =
                                Vec::new();
                            let content: Vec<serde_json::Value> = msg.multimodal_content.as_ref().unwrap_or(&empty_multimodal)
                                .iter()
                                .map(|part| {
                                    use crate::models::MultimodalContentPart;
                                    match part {
                                        MultimodalContentPart::Text { text } => {
                                            json!({
                                                "type": "text",
                                                "text": text
                                            })
                                        }
                                        MultimodalContentPart::ImageUrl { media_type, base64 } => {
                                            // ★ P0 架构改造：直接使用预处理后的图片，不再实时压缩
                                            // 预处理阶段（pdf_processing_service.rs）已经完成压缩
                                            json!({
                                                "type": "image_url",
                                                "image_url": { "url": format!("data:{};base64,{}", media_type, base64) }
                                            })
                                        }
                                    }
                                })
                                .collect();

                            info!(
                                "[LLMManager] Using multimodal_content mode with {} parts (interleaved text/image)",
                                content.len()
                            );

                            messages.push(json!({
                                "role": msg.role,
                                "content": content
                            }));
                        } else {
                            // 传统模式：使用 content + image_base64
                            let mut message_content = msg.content.clone();

                            // 如果有文档附件，将其内容添加到消息中
                            if let Some(doc_attachments) = &msg.doc_attachments {
                                if !doc_attachments.is_empty() {
                                    message_content.push_str("\n\n--- 附件内容 ---");
                                    for doc in doc_attachments {
                                        message_content
                                            .push_str(&format!("\n\n【文档: {}】", doc.name));
                                        if let Some(text_content) = &doc.text_content {
                                            message_content
                                                .push_str(&format!("\n{}", text_content));
                                        }
                                    }
                                }
                            }

                            // 🎯 改造：每条用户消息携带各自的图片
                            if config.is_multimodal
                                && msg
                                    .image_base64
                                    .as_ref()
                                    .map(|v| !v.is_empty())
                                    .unwrap_or(false)
                            {
                                let mut content = vec![json!({
                                    "type": "text",
                                    "text": message_content
                                })];

                                if let Some(images) = &msg.image_base64 {
                                    // ★ P0 架构改造：移除发送时压缩，图片已在预处理阶段压缩完成
                                    for image_base64 in images {
                                        // 直接使用预处理后的图片，不再实时压缩
                                        let image_format =
                                            Self::detect_image_format_from_base64(image_base64);
                                        content.push(json!({
                                            "type": "image_url",
                                            "image_url": { "url": format!("data:image/{};base64,{}", image_format, image_base64) }
                                        }));
                                    }
                                }

                                messages.push(json!({
                                    "role": msg.role,
                                    "content": content
                                }));
                            } else {
                                messages.push(json!({
                                    "role": msg.role,
                                    "content": message_content
                                }));
                            }
                        }
                    } else if msg.role == "assistant" {
                        // 普通 assistant 消息（没有工具调用）
                        // 🔧 使用适配器系统处理历史消息格式
                        let has_thinking = msg
                            .thinking_content
                            .as_ref()
                            .map(|s| !s.is_empty())
                            .unwrap_or(false);
                        let adapter =
                            get_adapter(config.provider_type.as_deref(), &config.model_adapter);

                        if has_thinking && adapter.requires_thinking_in_history(&config) {
                            // 适配器要求在历史消息中保留 thinking 块
                            // 使用适配器的自定义格式（如 Anthropic）
                            let empty_tool_calls: Vec<Value> = vec![];
                            if let Some(formatted_content) = adapter.format_tool_call_message(
                                &empty_tool_calls,
                                msg.thinking_content.as_deref(),
                            ) {
                                // 适配器提供了自定义格式，添加 text 块
                                let mut content_blocks: Vec<Value> =
                                    if let Some(arr) = formatted_content.as_array() {
                                        arr.clone()
                                    } else {
                                        vec![formatted_content]
                                    };
                                if !msg.content.is_empty() {
                                    content_blocks.push(json!({
                                        "type": "text",
                                        "text": msg.content
                                    }));
                                }
                                messages.push(json!({
                                    "role": "assistant",
                                    "content": content_blocks
                                }));
                            } else {
                                // 适配器未提供自定义格式，使用通用格式
                                let mut content_blocks = Vec::new();
                                if let Some(ref thinking) = msg.thinking_content {
                                    content_blocks.push(json!({
                                        "type": "thinking",
                                        "thinking": thinking
                                    }));
                                }
                                if !msg.content.is_empty() {
                                    content_blocks.push(json!({
                                        "type": "text",
                                        "text": msg.content
                                    }));
                                }
                                messages.push(json!({
                                    "role": "assistant",
                                    "content": content_blocks
                                }));
                            }
                        } else if has_thinking && requires_reasoning_passback(&config) {
                            // 🔧 思维链回传策略（文档 29 第 7 节）
                            // 使用统一的 reasoning_policy 模块判断是否需要回传
                            let policy = get_passback_policy(&config);
                            let mut assistant_msg = json!({
                                "role": "assistant",
                                "content": msg.content
                            });
                            if let Some(ref thinking) = msg.thinking_content {
                                match policy {
                                    ReasoningPassbackPolicy::DeepSeekStyle => {
                                        // DeepSeek/xAI/Perplexity 等使用 reasoning_content 字符串
                                        assistant_msg["reasoning_content"] = json!(thinking);
                                    }
                                    ReasoningPassbackPolicy::ReasoningDetails => {
                                        // Gemini 3/OpenAI o1 等使用 reasoning_details 数组
                                        // 对于 Gemini 3，需要包含 thoughtSignature（工具调用必需）
                                        let mut detail = json!({
                                            "type": "thinking",
                                            "text": thinking
                                        });
                                        // 如果存在 thought_signature，添加到 detail 中
                                        if let Some(ref signature) = msg.thought_signature {
                                            detail["signature"] = json!(signature);
                                        }
                                        assistant_msg["reasoning_details"] = json!([detail]);
                                    }
                                    ReasoningPassbackPolicy::NoPassback => {
                                        // 不应该到达这里，但保持安全
                                    }
                                }
                            }
                            messages.push(assistant_msg);
                        } else {
                            // 其他模型：只传递 content（thinking 不需要在历史中传递）
                            messages.push(json!({
                                "role": "assistant",
                                "content": msg.content
                            }));
                        }
                    } else if msg.role == "tool" {
                        // 标准化：工具结果消息必须包含 tool_call_id 以关联到上一条assistant的tool_calls
                        if let Some(tr) = &msg.tool_result {
                            messages.push(json!({
                                "role": "tool",
                                "tool_call_id": tr.call_id,
                                // 按OpenAI规范，content为字符串（通常为JSON字符串）
                                "content": msg.content
                            }));
                        } else {
                            // 避免发送不合法的tool消息（缺少tool_call_id），降级为assistant文本以保证不报错
                            messages.push(json!({
                                "role": "assistant",
                                "content": msg.content
                            }));
                        }
                    }
                }
            }
        }

        // 🔧 防御性合并：连续 user 消息合并，避免部分 API（Anthropic/ERNIE）报错
        Self::merge_consecutive_user_messages(&mut messages);

        // 近似输入token统计（用于用量/事件）
        let _approx_tokens_in = {
            let mut s = 0usize;
            // 使用 system_content 估算系统提示的 token 数量
            s += crate::utils::token_budget::estimate_tokens(&system_content);
            if !context.is_empty() {
                for (k, v) in context {
                    let _ = k;
                    s += crate::utils::token_budget::estimate_tokens(&v.to_string());
                }
            }
            for m in &chat_history {
                s += crate::utils::token_budget::estimate_tokens(&m.content);
            }
            s
        };

        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": true
        });
        let has_tool_result_messages = request_body["messages"]
            .as_array()
            .map(|items| {
                items.iter().any(|item| {
                    item.get("role")
                        .and_then(|role| role.as_str())
                        .map(|role| role == "tool")
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        // 🆕 应用推理配置，优先使用传入的enable_thinking参数
        Self::apply_reasoning_config(&mut request_body, &config, Some(enable_thinking));

        // 检查是否启用工具（全局 + 模型能力）
        let mut tools_enabled = self
            .db
            .get_setting("tools.enabled")
            .ok()
            .flatten()
            .map(|v| v.to_lowercase())
            .map(|v| v != "0" && v != "false")
            .unwrap_or(true); // 默认启用
        if disable_tools {
            tools_enabled = false;
        }

        // 🆕 检查 context 中是否有自定义工具（用于 Pipeline 注入 Canvas 等工具）
        // 即使 disable_tools = true，也允许通过 context 注入工具 schema
        // 这样 Pipeline 可以接管工具执行，但 LLM 仍然知道有哪些工具可用
        let custom_tools = context
            .get("custom_tools")
            .and_then(|v| v.as_array())
            .cloned();
        let has_custom_tools = custom_tools
            .as_ref()
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);

        // 🔍 调试日志：检查 custom_tools 在 LLM 调用时的状态
        debug!(
            "[LLM] custom_tools check: has_custom_tools={}, count={}, disable_tools={}, tools_enabled={}, supports_tools={}",
            has_custom_tools,
            custom_tools.as_ref().map(|arr| arr.len()).unwrap_or(0),
            disable_tools,
            tools_enabled,
            config.supports_tools
        );
        debug!(
            "[LLM] custom_tools check: has_custom_tools={}, count={}, disable_tools={}, tools_enabled={}, supports_tools={}",
            has_custom_tools,
            custom_tools.as_ref().map(|arr| arr.len()).unwrap_or(0),
            disable_tools,
            tools_enabled,
            config.supports_tools
        );

        if has_custom_tools && config.supports_tools {
            // 使用自定义工具（Pipeline 接管执行，但需要 LLM 知道工具 schema）
            let tools = Value::Array(custom_tools.unwrap_or_default());
            debug!(
                "[LLM] 使用 context 注入的自定义工具，数量: {}",
                tools.as_array().map(|a| a.len()).unwrap_or(0)
            );
            request_body["tools"] = tools;
            if !(is_qwen_config(&config) && has_tool_result_messages) {
                request_body["tool_choice"] = json!("auto");
            } else if let Some(map) = request_body.as_object_mut() {
                map.remove("tool_choice");
                debug!(
                    "[LLM] Qwen tool-result follow-up request: removed tool_choice per official Function Calling guidance"
                );
            }
        } else if !disable_tools && tools_enabled && config.supports_tools {
            // 构建工具列表，包含本地工具和 MCP 工具
            let tools = self.build_tools_with_mcp(&window).await;

            // 只有在工具列表非空时才设置 tools 和 tool_choice
            if tools.as_array().map(|arr| !arr.is_empty()).unwrap_or(false) {
                request_body["tools"] = tools;
                if !(is_qwen_config(&config) && has_tool_result_messages) {
                    request_body["tool_choice"] = json!("auto");
                } else if let Some(map) = request_body.as_object_mut() {
                    map.remove("tool_choice");
                    debug!(
                        "[LLM] Qwen tool-result follow-up request: removed tool_choice per official Function Calling guidance"
                    );
                }
            } else {
                warn!("[LLM] 工具列表为空，跳过 tool_choice 设置");
            }
        } else {
            if !config.supports_tools {
                debug!("跳过工具注入：模型不支持函数调用 (supports_tools=false)");
                // 为不支持工具的模型主动调用RAG/智能记忆工具并注入上下文（notes assistant禁用此回退）
                // 工具调用禁用不应影响文本降级注入；仅在显式的受限阶段才跳过
                // 统一管线已在上游控制：notes/summary/summary_request 才阻断
                {
                    info!("[Fallback] 模型不支持工具调用，启动降级注入模式");
                    let mut inject_texts = Vec::new();

                    let mut reuse_prefetched_web_search = false;
                    if let Some(prefetched) = context
                        .get("prefetched_web_search_sources")
                        .and_then(|v| v.as_array())
                    {
                        // 兼容两种格式：
                        // - RagSourceInfo: document_id, file_name, chunk_text
                        // - SourceInfo (Chat V2): title, url, snippet
                        let mut rows = Vec::new();
                        for (idx, item) in prefetched.iter().enumerate() {
                            // 尝试获取标题：file_name 或 title
                            let title = item
                                .get("file_name")
                                .or_else(|| item.get("title"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("搜索结果");
                            // 尝试获取内容：chunk_text 或 snippet
                            let content = item
                                .get("chunk_text")
                                .or_else(|| item.get("snippet"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            // 尝试获取 URL：document_id 或 url
                            let url = item
                                .get("document_id")
                                .or_else(|| item.get("url"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");

                            if !content.trim().is_empty() {
                                if !url.is_empty() {
                                    rows.push(format!(
                                        "[外部搜索 {}] {}\n{}\nURL: {}",
                                        idx + 1,
                                        title,
                                        content,
                                        url
                                    ));
                                } else {
                                    rows.push(format!(
                                        "[外部搜索 {}] {}\n{}",
                                        idx + 1,
                                        title,
                                        content
                                    ));
                                }
                            }
                            if rows.len() >= 5 {
                                break;
                            }
                        }
                        if !rows.is_empty() {
                            reuse_prefetched_web_search = true;
                            debug!(
                                "[Fallback] 复用预取的 web_search 结果，共 {} 条",
                                rows.len()
                            );
                            let joined = format!("【外部搜索结果】\n{}\n\n", rows.join("\n\n"));
                            inject_texts.push(joined);
                        }
                    }

                    let mcp_client = None;
                    // 🔧 P1-36: 优先读取统一管线注入的 memory_enabled
                    let memory_enabled_from_context =
                        context.get("memory_enabled").and_then(|v| v.as_bool());
                    let tool_ctx = crate::tools::ToolContext {
                        db: Some(&self.db),
                        mcp_client,
                        supports_tools: false, // 专门为降级注入场景
                        window: Some(&window),
                        stream_event: Some(stream_event),
                        stage: Some("fallback"),
                        memory_enabled: memory_enabled_from_context,
                        llm_manager: None, // fallback 场景不需要重排器
                    };

                    if let Some(last_user_msg) =
                        chat_history.iter().filter(|m| m.role == "user").last()
                    {
                        let memory_enabled_effective = memory_enabled_from_context.unwrap_or(true);
                        if memory_enabled_effective {
                            let _ = window.emit(
                                &format!("{}_memory_sources", stream_event),
                                &serde_json::json!({"stage":"disabled"}),
                            );
                        }

                        let rag_enabled = context
                            .get("rag_enabled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        let _rag_library_ids: Option<Vec<String>> = context
                            .get("rag_library_ids")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect::<Vec<String>>()
                            })
                            .filter(|v| !v.is_empty());
                        let _rag_note_subjects: Option<Vec<String>> = context
                            .get("rag_note_subjects")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect::<Vec<String>>()
                            })
                            .filter(|v| !v.is_empty());
                        if rag_enabled {
                            // Legacy RAG removed; VFS RAG is used via builtin:rag_search tool
                            debug!(
                                "[Fallback] Legacy RAG removed, skipping knowledge base injection"
                            );
                        } else {
                            debug!("[Fallback] RAG 已关闭，跳过知识库注入");
                        }
                        let web_search_enabled = context
                            .get("web_search_enabled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        // 调用 WebSearch 工具生成注入文本
                        if !reuse_prefetched_web_search && web_search_enabled {
                            let web_registry =
                                crate::tools::ToolRegistry::new_with(vec![std::sync::Arc::new(
                                    crate::tools::WebSearchTool,
                                )]);
                            let web_args = json!({
                                "query": last_user_msg.content,
                                "top_k": 3
                            });
                            debug!(
                                "[Fallback] 准备调用 web_search 工具，查询: {}",
                                &last_user_msg.content
                            );
                            let (_ok, _data, _err, _usage, _citations, web_inject_text) =
                                web_registry
                                    .call_tool("web_search", &web_args, &tool_ctx)
                                    .await;
                            debug!("[Fallback] web_search 调用完成，ok={}, citations数量={}, inject_text长度={}",
                                _ok,
                                _citations.as_ref().map(|c| c.len()).unwrap_or(0),
                                web_inject_text.as_ref().map(|t| t.len()).unwrap_or(0)
                            );
                            if let Some(ref err) = _err {
                                warn!("[Fallback] web_search 返回错误: {}", err);
                            }
                            if let Some(text) = web_inject_text {
                                debug!(
                                    "[Fallback] 将 web_search 注入文本加入队列，长度: {} 字符",
                                    text.len()
                                );
                                inject_texts.push(text);
                            } else {
                                warn!("[Fallback] web_search 返回的 inject_text 为 None！");
                            }
                        } else if !web_search_enabled {
                            debug!("[Fallback] web_search 已关闭，跳过外部搜索注入");
                        }
                    }

                    if !inject_texts.is_empty() {
                        debug!(
                            "[Fallback] 收集注入文本，共 {} 段，稍后统一注入系统提示",
                            inject_texts.len()
                        );
                        pre_call_injection_texts.extend(inject_texts);
                    } else {
                        warn!("[Fallback] inject_texts 队列为空，没有任何内容可注入！");
                    }
                } // end disable_tools guard
            }
        }

        if let Some(inject_content) = Self::coalesce_injection_texts(&pre_call_injection_texts) {
            Self::append_injection_to_system_message(&mut messages, &inject_content);
        }

        // 注入阶段可能修改 messages，此处确保请求体携带最新副本
        request_body["messages"] = serde_json::Value::Array(messages.clone());

        // 计算请求体大小
        request_bytes = serde_json::to_string(&request_body)
            .unwrap_or_default()
            .len();

        // 简化：不再在此处估算输入token

        // 根据模型适配器类型和是否为推理模型设置不同的参数
        if cfg!(debug_assertions) {
            // debug removed: adapter type & reasoning flag
        }

        if config.is_reasoning {
            // 使用配置化的 max_tokens_limit 限制 max_completion_tokens
            let max_tokens = match config.max_tokens_limit {
                Some(limit) => config.max_output_tokens.min(limit),
                None => config.max_output_tokens,
            };
            match config.model_adapter.as_str() {
                _ => {
                    request_body["max_completion_tokens"] = json!(max_tokens);
                }
            }
        } else {
            // 非推理模型走通用参数
            // 使用配置化的 max_tokens_limit 限制 max_tokens
            let max_tokens = match config.max_tokens_limit {
                Some(limit) => config.max_output_tokens.min(limit),
                None => config.max_output_tokens,
            };
            request_body["max_tokens"] = json!(max_tokens);
            request_body["temperature"] = json!(config.temperature);
            // 关键：如果模型是非推理模型，即使前端请求了思维链，
            // 也不要向API发送特定于思维链的参数，除非该模型明确支持。
            // 对于通用模型，通常不需要为"思维链"传递特殊参数，模型会自然地按指令回复。
            // 如果 enable_chain_of_thought 对非推理模型意味着不同的处理（例如，更详细的回复），
            // 这里的逻辑可能需要调整，但通常是Prompt工程的一部分，而不是API参数。
            if enable_chain_of_thought {
                warn!(
                    "前端为非推理模型 {} 请求了思维链。通常这由Prompt控制，而非特定API参数。",
                    config.model
                );
            }
        }
        // 🆕 检测合成的 load_skills 工具交互是否出现在请求消息中
        {
            let synthetic_count = messages
                .iter()
                .filter(|m| {
                    // 检测 assistant 消息中包含 load_skills tool_call
                    if let Some(tool_calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
                        tool_calls.iter().any(|tc| {
                            tc.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|n| n.as_str())
                                .map_or(false, |name| name == "load_skills")
                        })
                    } else if m.get("role").and_then(|r| r.as_str()) == Some("tool") {
                        // 检测 tool 消息中包含 skill_loaded 标记
                        m.get("content")
                            .and_then(|c| c.as_str())
                            .map_or(false, |c| c.contains("<skill_loaded"))
                    } else {
                        false
                    }
                })
                .count();
            if synthetic_count > 0 {
                info!(
                    "[LLM_AUDIT] 请求体包含 {} 条合成 load_skills 工具消息（总消息数: {}）",
                    synthetic_count,
                    messages.len()
                );
            }
        }

        // 输出完整请求体用于调试（隐藏图片内容保护隐私）
        let debug_body = {
            let mut debug = request_body.clone();
            if let Some(messages) = debug["messages"].as_array_mut() {
                for message in messages {
                    if let Some(content) = message["content"].as_array_mut() {
                        for part in content {
                            if part["type"] == "image_url" {
                                part["image_url"]["url"] = json!("data:image/jpeg;base64,[hidden]");
                            }
                        }
                    }
                }
            }
            debug
        };
        debug!("[LLM_REVIEW_DEBUG] ==> 完整请求体开始 <==");
        debug!(
            "{}",
            serde_json::to_string_pretty(&debug_body).unwrap_or_default()
        );
        debug!("[LLM_REVIEW_DEBUG] ==> 完整请求体结束 <==");

        // 记录请求体大小与起始时间（简化）
        let request_json_str = serde_json::to_string(&request_body).unwrap_or_default();
        let request_bytes = request_json_str.len();
        let start_instant = std::time::Instant::now();

        // Provider 适配：构建请求
        let adapter: Box<dyn ProviderAdapter> = if self.should_use_openai_responses(&config) {
            Box::new(crate::providers::OpenAIResponsesAdapter)
        } else {
            match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            }
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("对话请求构建失败", e))?;

        // ★ 使用 preq.body（适配器转换后的实际请求体）而非 request_body（转换前），
        // 确保 Anthropic/Gemini 等非 OpenAI 提供商的预览与实际发送内容一致
        let debug_persist = self.build_debug_persist_config();
        log_and_emit_llm_request(
            "CHAT_STREAM",
            &window,
            stream_event,
            message_id,
            &config.model,
            &preq.url,
            &preq.body,
            debug_persist.as_ref(),
        );

        // 发出开始事件
        let request_id = Uuid::new_v4().to_string();
        if let Err(e) = window.emit(
            &format!("{}_start", stream_event),
            &json!({
                "id": request_id,
                "model": config.model,
                "request_bytes": request_bytes
            }),
        ) {
            warn!("发送开始事件失败: {}", e);
        }

        // ERR-01 修复：HTTP 错误码区分处理与指数退避重试
        const MAX_RETRIES: u32 = 3;
        const INITIAL_BACKOFF_MS: u64 = 1000;
        let mut retry_count = 0u32;
        let mut backoff_ms = INITIAL_BACKOFF_MS;

        let response = loop {
            // 每次重试都需要重新构建 request_builder（因为 send() 会消耗它）
            let mut request_builder = self.client
                .post(&preq.url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                // Connection 头由 reqwest 自动管理：HTTP/1.1 使用 keep-alive，HTTP/2 使用多路复用
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            for (k, v) in &preq.headers {
                request_builder = request_builder.header(k.clone(), v.clone());
            }
            if let Ok(parsed_url) = Url::parse(&config.base_url) {
                if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                    && parsed_url.host_str().is_some()
                {
                    let origin_val = format!(
                        "{}://{}",
                        parsed_url.scheme(),
                        parsed_url.host_str().unwrap_or_default()
                    );
                    let referer_val = format!(
                        "{}://{}/",
                        parsed_url.scheme(),
                        parsed_url.host_str().unwrap_or_default()
                    );
                    request_builder = request_builder
                        .header("Origin", origin_val)
                        .header("Referer", referer_val);
                }
            }

            let resp = request_builder
                .json(&preq.body)
                .send()
                .await
                .map_err(|e| AppError::network(format!("模型二API请求失败: {}", e)))?;

            if resp.status().is_success() {
                break resp;
            }

            let status = resp.status();
            let status_code = status.as_u16();

            match status_code {
                // 429 Rate Limit：使用指数退避重试
                429 => {
                    // 尝试解析 Retry-After 头
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());

                    let wait_ms = retry_after.map(|s| s * 1000).unwrap_or(backoff_ms);

                    if retry_count < MAX_RETRIES {
                        retry_count += 1;
                        warn!(
                            "[模型二API] 遇到速率限制(429)，等待 {}ms 后重试 ({}/{})",
                            wait_ms, retry_count, MAX_RETRIES
                        );
                        tokio::time::sleep(tokio::time::Duration::from_millis(wait_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(30000); // 指数退避，最大30秒
                        continue;
                    } else {
                        let error_text = resp.text().await.unwrap_or_default();
                        let error_msg = format!(
                            "模型二API请求失败: 速率限制(429)，已重试{}次仍失败 - {}",
                            MAX_RETRIES, error_text
                        );
                        error!("{}", error_msg);
                        return Err(AppError::llm(error_msg));
                    }
                }
                // 401/403 认证错误：直接返回明确错误
                401 | 403 => {
                    let error_text = resp.text().await.unwrap_or_default();
                    let error_msg = format!(
                        "模型二API认证失败: API Key 无效或已过期 (HTTP {}) - {}",
                        status_code, error_text
                    );
                    error!("{}", error_msg);
                    return Err(AppError::configuration(error_msg));
                }
                // 5xx 服务端错误：可重试
                500..=599 => {
                    if retry_count < MAX_RETRIES {
                        retry_count += 1;
                        warn!(
                            "[模型二API] 服务端错误({})，等待 {}ms 后重试 ({}/{})",
                            status_code, backoff_ms, retry_count, MAX_RETRIES
                        );
                        tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(30000);
                        continue;
                    } else {
                        let error_text = resp.text().await.unwrap_or_default();
                        let error_msg = format!(
                            "模型二API服务端错误: HTTP {} - 已重试{}次仍失败 - {}",
                            status_code, MAX_RETRIES, error_text
                        );
                        error!("{}", error_msg);
                        return Err(AppError::llm(error_msg));
                    }
                }
                // 其他错误：直接返回
                _ => {
                    let error_text = resp.text().await.unwrap_or_default();
                    let error_msg =
                        format!("模型二API请求失败: HTTP {} - {}", status_code, error_text);
                    error!("模型二API请求失败: {}", error_msg);
                    return Err(AppError::llm(error_msg));
                }
            }
        };

        let mut stream = response.bytes_stream();
        let mut full_content = String::new();
        let mut reasoning_content = String::new(); // 收集思维链内容
        let mut chunk_counter = 0;
        // 已有 request_id
        let mut response_bytes: usize = 0;
        // 捕获工具调用集合
        let mut captured_tool_calls: Vec<crate::models::ToolCall> = Vec::new();
        // 捕获 API 返回的 usage 信息（用于准确记录 token 使用量）
        let mut captured_usage: Option<serde_json::Value> = None;

        // 工具调用聚合状态 - 用于处理流式分块的工具调用
        let mut pending_tool_calls: std::collections::HashMap<i32, (String, String, String)> =
            std::collections::HashMap::new(); // index -> (id, name, accumulated_args)

        let mut stream_ended = false;
        // 初始化SSE行缓冲器
        let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();
        // Proactively clear any stale cancel flags from previous runs for this stream_event
        // This avoids immediately cancelling a brand-new stream due to a leftover registry flag
        let _ = self.take_cancellation_if_any(stream_event).await;

        // Register cancel channel for this stream_event
        let cancel_rx = self.register_cancel_channel(stream_event).await;

        debug!(
            "{}[流式请求] 开始处理，请求ID: {}, 事件名: {}",
            chat_timing::format_elapsed_prefix(stream_event),
            request_id,
            stream_event
        );

        // 降噪与隐私：不打印完整请求内容，仅输出关键信息
        debug!(
            "{}请求 -> (经适配器) base={} | model={} | stream=true",
            chat_timing::format_elapsed_prefix(stream_event),
            config.base_url,
            config.model
        );
        // P1修复：生命周期对齐 - 发送start和id事件
        if let Err(e) = window.emit(
            &format!("{}_start", stream_event),
            &json!({
                "id": stream_event,
                "model": config.model,
                "request_bytes": request_bytes
            }),
        ) {
            warn!("发送开始事件失败: {}", e);
        }

        if let Err(e) = window.emit(
            &format!("{}_id", stream_event),
            &json!({
                "request_id": stream_event,
                "stream_event": stream_event,
                "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
            }),
        ) {
            warn!("发送ID事件失败: {}", e);
        }
        // 用量日志：开始（使用 FileManager 的 app_data_dir）
        {
            let dir = self.file_manager.get_app_data_dir().to_path_buf();
            let logger = crate::debug_logger::DebugLogger::new(dir);
            let _ = logger
                .log_llm_usage(
                    "start",
                    &config.name,
                    &config.model,
                    &config.model_adapter,
                    request_bytes,
                    0,
                    0,
                    0,
                    None,
                    None,
                )
                .await;
        }
        let mut was_cancelled = false;
        while let Some(chunk_result) = stream.next().await {
            // Hard cancel check (best-effort): proactively drain registry then check channel
            let registry_cancelled = self.take_cancellation_if_any(stream_event).await;
            let cancel_flag = *cancel_rx.borrow();

            if registry_cancelled {
                debug!("[Stream Loop] 检测到 registry 取消标记: {}", stream_event);
            }
            if cancel_flag {
                debug!("[Stream Loop] 检测到 cancel_channel 信号: {}", stream_event);
            }

            if cancel_flag || registry_cancelled {
                info!(
                    "{}[Cancel] 流循环检测到取消信号，准备中断: {} (registry={}, channel={})",
                    chat_timing::format_elapsed_prefix(stream_event),
                    stream_event,
                    registry_cancelled,
                    cancel_flag
                );
                // P1修复：生命周期对齐 - 发送cancelled事件
                if let Err(e) = window.emit(
                    &format!("{}_cancelled", stream_event),
                    &json!({
                        "id": request_id,
                        "reason": "user_cancelled",
                        "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                    }),
                ) {
                    warn!("发送取消事件失败: {}", e);
                } else {
                    debug!("[Cancel] 已发送 {}_cancelled 事件", stream_event);
                }
                was_cancelled = true;
                debug!("[Cancel] 流循环已中断，退出 while 循环");
                break;
            }
            match chunk_result {
                Ok(chunk) => {
                    response_bytes += chunk.len();
                    let chunk_str = String::from_utf8_lossy(&chunk);

                    // 使用SSE缓冲器处理chunk，获取完整的行
                    let complete_lines = sse_buffer.process_chunk(&chunk_str);
                    for line in complete_lines {
                        // 使用适配器解析流事件（包括[DONE]标记）
                        let events = adapter.parse_stream(&line);

                        // 检查是否是结束标记（保留为后备机制）
                        if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
                            debug!(
                                "{}检测到SSE结束标记: [DONE]",
                                chat_timing::format_elapsed_prefix(stream_event)
                            );
                            if events.is_empty() {
                                // 如果适配器没有生成Done事件，我们手动添加一个
                                debug!(
                                    "{}适配器未生成Done事件，手动添加",
                                    chat_timing::format_elapsed_prefix(stream_event)
                                );
                                stream_ended = true;
                                break;
                            }
                        }
                        for event in events {
                            match event {
                                crate::providers::StreamEvent::ContentChunk(content) => {
                                    full_content.push_str(&content);
                                    chunk_counter += 1;

                                    let stream_chunk = StreamChunk {
                                        content: content.clone(),
                                        is_complete: false,
                                        chunk_id: format!("{}_chunk_{}", request_id, chunk_counter),
                                    };

                                    // 🔧 修复：当 hook 存在时由 hook 负责发送事件（正确的 BackendEvent 格式）
                                    // 否则直接 emit StreamChunk（兼容旧调用方）
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_content_chunk(&content);
                                    } else if let Err(e) = window.emit(stream_event, &stream_chunk)
                                    {
                                        warn!("发送内容块失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::ReasoningChunk(reasoning) => {
                                    reasoning_content.push_str(&reasoning);

                                    let reasoning_chunk = StreamChunk {
                                        content: reasoning.clone(),
                                        is_complete: false,
                                        chunk_id: format!(
                                            "{}_reasoning_chunk_{}",
                                            request_id, chunk_counter
                                        ),
                                    };

                                    // 🔧 修复：当 hook 存在时由 hook 负责发送事件
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_reasoning_chunk(&reasoning);
                                    } else if let Err(e) = window.emit(
                                        &format!("{}_reasoning", stream_event),
                                        &reasoning_chunk,
                                    ) {
                                        warn!("发送思维链块失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::ThoughtSignature(signature) => {
                                    // Gemini 3 思维签名：工具调用场景下需要缓存并回传
                                    debug!(
                                        "[ThoughtSignature] 收到 Gemini 3 思维签名: 长度={}",
                                        signature.len()
                                    );
                                    // 通过 hook 传递签名给调用方缓存
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_thought_signature(&signature);
                                    }
                                }
                                crate::providers::StreamEvent::ToolCall(tool_call_value) => {
                                    // 聚合分块的工具调用（不再发送原始分块事件）
                                    if let Some(index) = tool_call_value
                                        .get("index")
                                        .and_then(|v| v.as_i64())
                                        .map(|v| v as i32)
                                    {
                                        if let Some(id) =
                                            tool_call_value.get("id").and_then(|v| v.as_str())
                                        {
                                            // 这是一个新的工具调用的开始（有完整的id）
                                            let name = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("name"))
                                                .and_then(|n| n.as_str())
                                                .unwrap_or("unknown");
                                            // 🔧 修复：某些 OpenAI 兼容 API 返回 arguments 为 JSON 对象而非字符串
                                            // 此时 as_str() 返回 None，导致参数被静默丢弃为 ""
                                            let args = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .map(|a| {
                                                    if let Some(s) = a.as_str() {
                                                        s.to_string()
                                                    } else if a.is_null() {
                                                        String::new()
                                                    } else {
                                                        // arguments 是 JSON 对象/数组，序列化为字符串
                                                        warn!("[llm_manager] 工具调用 arguments 不是字符串而是 JSON 值 (tool={}), 自动序列化", name);
                                                        serde_json::to_string(a).unwrap_or_default()
                                                    }
                                                })
                                                .unwrap_or_default();

                                            pending_tool_calls.insert(
                                                index,
                                                (id.to_string(), name.to_string(), args),
                                            );
                                            // 🆕 2026-01-15: 工具调用参数开始累积时通知前端
                                            // 让前端立即显示"正在准备工具调用"状态
                                            if let Some(h) = self.get_hook(stream_event).await {
                                                h.on_tool_call_start(id, name);
                                            }
                                            // 简化日志：工具调用开始时输出一次
                                            print!("🔧");
                                            use std::io::Write;
                                            let _ = std::io::stdout().flush();
                                        } else if let Some((id, name, mut accumulated_args)) =
                                            pending_tool_calls.get(&index).cloned()
                                        {
                                            // 这是工具调用的后续块（没有id，只有arguments片段）
                                            // 🔧 修复：同样处理 arguments 为 JSON 对象的情况
                                            let args_fragment_opt = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .and_then(|a| {
                                                    if let Some(s) = a.as_str() {
                                                        Some(s.to_string())
                                                    } else if a.is_null() {
                                                        None
                                                    } else {
                                                        Some(
                                                            serde_json::to_string(a)
                                                                .unwrap_or_default(),
                                                        )
                                                    }
                                                });
                                            if let Some(args_fragment) = args_fragment_opt {
                                                accumulated_args.push_str(&args_fragment);
                                                pending_tool_calls.insert(
                                                    index,
                                                    (id.clone(), name, accumulated_args.clone()),
                                                );
                                                // 🆕 转发 args delta 给前端实时预览
                                                if let Some(h) = self.get_hook(stream_event).await {
                                                    h.on_tool_call_args_delta(&id, &args_fragment);
                                                }
                                                // 简化日志：每 200 字符输出一个 / 代表累积
                                                if accumulated_args.len() % 200
                                                    < args_fragment.len()
                                                {
                                                    print!("/");
                                                    use std::io::Write;
                                                    let _ = std::io::stdout().flush();
                                                }
                                            }
                                        }
                                    }
                                }
                                crate::providers::StreamEvent::Usage(usage_value) => {
                                    // 存储 usage 数据以便最终记录到数据库
                                    captured_usage = Some(usage_value.clone());
                                    // emit usage 事件
                                    if let Err(e) = window
                                        .emit(&format!("{}_usage", stream_event), &usage_value)
                                    {
                                        error!("发送用量事件失败: {}", e);
                                    }
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_usage(&usage_value);
                                    }
                                }
                                crate::providers::StreamEvent::SafetyBlocked(safety_info) => {
                                    // emit safety_blocked 事件
                                    if let Err(e) = window.emit(
                                        &format!("{}_safety_blocked", stream_event),
                                        &safety_info,
                                    ) {
                                        error!("发送安全阻断事件失败: {}", e);
                                    }
                                    // 同时发送通用错误事件
                                    let error_event = json!({
                                        "type": "safety_error",
                                        "message": "Request blocked due to safety policies",
                                        "details": safety_info
                                    });
                                    if let Err(e) = window
                                        .emit(&format!("{}_error", stream_event), &error_event)
                                    {
                                        error!("发送安全错误事件失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::Done => {
                                    stream_ended = true;

                                    // 完成待聚合的工具调用（只在有工具调用时输出简洁日志）
                                    if !pending_tool_calls.is_empty() {
                                        debug!("工具调用序列结束");
                                    }
                                    for (_index, (id, name, accumulated_args)) in
                                        pending_tool_calls.iter()
                                    {
                                        let complete_tool_call = serde_json::json!({
                                            "id": id,
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": accumulated_args
                                            }
                                        });

                                        match Self::convert_openai_tool_call(&complete_tool_call) {
                                            Ok(tc) => {
                                                captured_tool_calls.push(tc);
                                            }
                                            Err(e) => {
                                                warn!("[llm_manager] 工具调用解析失败: {}, args_len={}", e, accumulated_args.len());
                                                // 构造带截断错误标记的 ToolCall，让 pipeline 层反馈给 LLM 重试
                                                captured_tool_calls.push(crate::models::ToolCall {
                                                    id: id.clone(),
                                                    tool_name: name.clone(),
                                                    args_json: json!({
                                                        "_truncation_error": true,
                                                        "_error_message": format!(
                                                            "工具调用参数 JSON 被截断（已生成 {} 字符但未完成）。原因：模型输出 token 达到上限。",
                                                            accumulated_args.len()
                                                        ),
                                                        "_args_len": accumulated_args.len(),
                                                    }),
                                                });
                                            }
                                        }
                                    }
                                    // 输出一条简洁的工具调用总结
                                    if !captured_tool_calls.is_empty() {
                                        let names: Vec<_> = captured_tool_calls
                                            .iter()
                                            .map(|tc| tc.tool_name.as_str())
                                            .collect();
                                        debug!("工具调用聚合完成: {:?}", names);
                                    }
                                    pending_tool_calls.clear();

                                    break;
                                }
                            }
                        }

                        if stream_ended {
                            break;
                        }
                    }
                }
                Err(e) => {
                    error!(
                        "{}流读取错误: {}",
                        chat_timing::format_elapsed_prefix(stream_event),
                        e
                    );
                    debug!(
                        "{}已处理块数: {}, 主内容长度: {}, 思维链长度: {}",
                        chat_timing::format_elapsed_prefix(stream_event),
                        chunk_counter,
                        full_content.len(),
                        reasoning_content.len()
                    );

                    // 如果已经有内容，不把这当作完全失败
                    if !full_content.is_empty() || !reasoning_content.is_empty() {
                        warn!(
                            "{}部分内容已接收，标记为部分成功",
                            chat_timing::format_elapsed_prefix(stream_event)
                        );
                        break;
                    } else {
                        error!(
                            "{}没有接收到任何内容，这是完全失败",
                            chat_timing::format_elapsed_prefix(stream_event)
                        );
                        // 发送作用域错误事件
                        let error_event = format!("{}_error", stream_event);
                        let error_payload = json!({
                            "error": format!("流式请求失败: {}", e),
                            "stream_event": stream_event,
                            "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                        });
                        if let Err(emit_err) = window.emit(&error_event, &error_payload) {
                            error!("发送作用域错误事件失败: {}", emit_err);
                        }
                        // 同时发送兼容性全局错误事件
                        if let Err(emit_err) = window.emit("stream_error", &error_payload) {
                            error!("发送全局错误事件失败: {}", emit_err);
                        }
                        return Err(AppError::network(format!("流式请求失败: {}", e)));
                    }
                }
            }

            // 如果流已结束，退出循环
            if stream_ended {
                break;
            }
        }

        // 处理SSE缓冲器中剩余的不完整行（P1修复：STREAM-3）
        if let Some(remaining_line) = sse_buffer.flush() {
            if !remaining_line.trim().is_empty() {
                debug!(
                    "{}处理SSE缓冲器中的剩余数据: {} 字符",
                    chat_timing::format_elapsed_prefix(stream_event),
                    remaining_line.len()
                );
                // 使用适配器解析剩余的行
                let events = adapter.parse_stream(&remaining_line);
                for event in events {
                    match event {
                        crate::providers::StreamEvent::ContentChunk(content) => {
                            full_content.push_str(&content);
                            chunk_counter += 1;

                            let stream_chunk = StreamChunk {
                                content: content.clone(),
                                is_complete: false,
                                chunk_id: format!("{}_chunk_{}", request_id, chunk_counter),
                            };

                            if let Some(h) = self.get_hook(stream_event).await {
                                h.on_content_chunk(&content);
                            } else if let Err(e) = window.emit(stream_event, &stream_chunk) {
                                warn!("发送剩余内容块失败: {}", e);
                            }
                        }
                        crate::providers::StreamEvent::ReasoningChunk(reasoning) => {
                            reasoning_content.push_str(&reasoning);

                            let reasoning_chunk = StreamChunk {
                                content: reasoning.clone(),
                                is_complete: false,
                                chunk_id: format!(
                                    "{}_reasoning_chunk_{}",
                                    request_id, chunk_counter
                                ),
                            };

                            if let Some(h) = self.get_hook(stream_event).await {
                                h.on_reasoning_chunk(&reasoning);
                            } else if let Err(e) = window
                                .emit(&format!("{}_reasoning", stream_event), &reasoning_chunk)
                            {
                                warn!("发送剩余思维链块失败: {}", e);
                            }
                        }
                        _ => { /* 忽略其他事件类型（Done/ToolCall/Usage等已在主循环处理） */
                        }
                    }
                }
            }
        }

        // 运行时互斥修正：某些模型使用函数调用时需要关闭 thinking 字段。
        // 这里统一覆盖 custom_tools 和普通工具注入两条路径，避免适配逻辑漏跑。
        if request_body.get("tools").is_some() {
            let adapter = get_adapter(config.provider_type.as_deref(), &config.model_adapter);
            if let Some(body_map) = request_body.as_object() {
                if adapter.should_disable_thinking_for_tools(&config, body_map) {
                    remove_thinking_fields_for_tool_compat(&mut request_body);
                    debug!(
                        "[LLMManager] Adapter {} disabled thinking for tool calls",
                        adapter.id()
                    );
                }
            }
        }

        // 🔧 P0修复：Gemini 原生 SSE 不发送 `data: [DONE]`，流直接结束。
        // 如果 pending_tool_calls 中仍有未处理的工具调用，在此执行与 Done 处理器相同的 finalize 逻辑。
        if !pending_tool_calls.is_empty() {
            info!(
                "[llm_manager] Finalizing {} pending tool calls after stream end (no Done event received)",
                pending_tool_calls.len()
            );
            for (_index, (id, name, accumulated_args)) in pending_tool_calls.iter() {
                let complete_tool_call = serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": accumulated_args
                    }
                });

                match Self::convert_openai_tool_call(&complete_tool_call) {
                    Ok(tc) => {
                        captured_tool_calls.push(tc);
                    }
                    Err(e) => {
                        warn!(
                            "[llm_manager] 工具调用解析失败(fallback): {}, args_len={}",
                            e,
                            accumulated_args.len()
                        );
                        captured_tool_calls.push(crate::models::ToolCall {
                            id: id.clone(),
                            tool_name: name.clone(),
                            args_json: json!({
                                "_truncation_error": true,
                                "_error_message": format!(
                                    "工具调用参数 JSON 被截断（已生成 {} 字符但未完成）。原因：模型输出 token 达到上限。",
                                    accumulated_args.len()
                                ),
                                "_args_len": accumulated_args.len(),
                            }),
                        });
                    }
                }
            }
            if !captured_tool_calls.is_empty() {
                let names: Vec<_> = captured_tool_calls
                    .iter()
                    .map(|tc| tc.tool_name.as_str())
                    .collect();
                info!(
                    "[llm_manager] Fallback tool call finalize completed: {:?}",
                    names
                );
            }
            pending_tool_calls.clear();
        }

        // Clear cancel channel for this stream
        self.clear_cancel_channel(stream_event).await;

        // 输出最终收集统计（脱敏）
        use sha2::{Digest, Sha256};
        let mut h1 = Sha256::new();
        h1.update(full_content.as_bytes());
        let mut h2 = Sha256::new();
        h2.update(reasoning_content.as_bytes());
        let full_hash = format!("{:x}", h1.finalize());
        let reasoning_hash = format!("{:x}", h2.finalize());
        debug!(
            "{}流式响应完成统计（脱敏）:",
            chat_timing::format_elapsed_prefix(stream_event)
        );
        debug!(
            "  - 主内容长度: {} 字符, hash: {}",
            full_content.len(),
            &full_hash[..8.min(full_hash.len())]
        );
        debug!(
            "  - 思维链长度: {} 字符, hash: {}",
            reasoning_content.len(),
            &reasoning_hash[..8.min(reasoning_hash.len())]
        );

        // 🔧 [REFACTOR] 旧的工具调用执行逻辑已移除
        // 工具调用现在由 Chat V2 Pipeline 统一处理（src-tauri/src/chat_v2/pipeline.rs）
        // 此处只负责流式响应的收集，工具调用通过 LLMStreamHooks 回调给上层

        // 🔧 [CRITICAL] 将收集到的工具调用通过 hooks 回调给上层（Pipeline）
        if !captured_tool_calls.is_empty() {
            info!(
                "[llm_manager] Notifying hooks of {} tool calls",
                captured_tool_calls.len()
            );
            for tc in &captured_tool_calls {
                if let Some(h) = self.get_hook(stream_event).await {
                    let chat_msg = ChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        timestamp: chrono::Utc::now(),
                        thinking_content: None,
                        thought_signature: None,
                        rag_sources: None,
                        memory_sources: None,
                        graph_sources: None,
                        web_search_sources: None,
                        image_paths: None,
                        image_base64: None,
                        doc_attachments: None,
                        multimodal_content: None,
                        tool_call: Some(tc.clone()),
                        tool_result: None,
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    h.on_tool_call(&chat_msg);
                }
            }
        }

        if !was_cancelled {
            // 发送最终完成信号到主内容流
            let final_chunk = StreamChunk {
                content: full_content.clone(), // 发送完整内容而不是空字符串
                is_complete: true,
                chunk_id: format!("{}_final_chunk_{}", request_id, chunk_counter + 1),
            };

            // 🎯 统一回顾分析完成日志
            if stream_event.contains("review_analysis_stream")
                || stream_event.contains("review_chat_stream")
            {
                debug!("[统一回顾-后端发送-主内容完成] 事件名: {}", stream_event);
                debug!(
                    "   - 时间戳: {}",
                    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f")
                );
                debug!("   - chunk_id: {}", final_chunk.chunk_id);
                debug!("   - 完整内容长度: {} 字符", final_chunk.content.len());
                debug!("   - is_complete: {}", final_chunk.is_complete);
                debug!("   - 总块数: {}", chunk_counter + 1);
            }

            // 🔧 修复：当 hook 存在时由 hook 负责发送完成事件，跳过直接 emit
            if let Some(h) = self.get_hook(stream_event).await {
                // hook 存在，调用 on_complete 处理完成逻辑
                h.on_complete(
                    &full_content,
                    if reasoning_content.is_empty() {
                        None
                    } else {
                        Some(&reasoning_content)
                    },
                );
                debug!("通过 hook 处理完成信号，内容长度: {}", full_content.len());
            } else if let Err(e) = window.emit(stream_event, &final_chunk) {
                error!("发送最终主内容完成信号失败: {}", e);
            } else {
                debug!("发送主内容完成信号成功，内容长度: {}", full_content.len());
            }
        }
        // 如果有思维链内容，也发送思维链完成信号
        if !was_cancelled && enable_chain_of_thought && !reasoning_content.is_empty() {
            let reasoning_final_chunk = StreamChunk {
                content: reasoning_content.clone(), // 也发送完整的思维链内容
                is_complete: true,
                chunk_id: format!("{}_reasoning_final_chunk_{}", request_id, chunk_counter + 1),
            };

            debug!(
                "[思维链总结] 准备发送最终思维链: 总长度={}, 内容预览={}",
                reasoning_content.len(),
                &reasoning_content.chars().take(100).collect::<String>()
            );

            if let Err(e) = window.emit(
                &format!("{}_reasoning", stream_event),
                &reasoning_final_chunk,
            ) {
                error!("发送思维链完成信号失败: {}", e);
            } else {
                debug!(
                    "发送思维链完成信号成功，内容长度: {}, 事件名: {}_reasoning",
                    reasoning_content.len(),
                    stream_event
                );
            }
        } else if !was_cancelled && enable_chain_of_thought && reasoning_content.is_empty() {
            warn!("[思维链总结] 启用了思维链但 reasoning_content 为空!");
        }

        // 如果启用了思维链，尝试提取思维链详情（文档 29 第 7 节）
        let chain_of_thought_details = if enable_chain_of_thought {
            let needs_passback = requires_reasoning_passback(&config);
            if needs_passback {
                // 推理模型自动包含思维链
                let reference = if !reasoning_content.is_empty() {
                    parser::extract_reasoning_sections(&reasoning_content)
                } else {
                    parser::extract_reasoning_sections(&full_content)
                };
                let policy = get_passback_policy(&config);
                Some(json!({
                    "full_response": full_content,
                    "reasoning_content": if reasoning_content.is_empty() { Value::Null } else { json!(reasoning_content) },
                    "enabled": true,
                    "is_reasoning_model": true,
                    "model_adapter": config.model_adapter,
                    "parsed_sections": reference,
                    "passback_policy": match policy {
                        ReasoningPassbackPolicy::DeepSeekStyle => "deepseek_style",
                        ReasoningPassbackPolicy::ReasoningDetails => "reasoning_details",
                        ReasoningPassbackPolicy::NoPassback => "no_passback",
                    }
                }))
            } else {
                Some(json!({
                    "full_response": full_content,
                    "enabled": true,
                    "is_reasoning_model": false,
                    "model_adapter": config.model_adapter
                }))
            }
        } else {
            None
        };

        // 用量日志：结束（脱敏写入，使用 FileManager）
        {
            let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&full_content);
            let dur = start_instant.elapsed().as_millis();
            let dir = self.file_manager.get_app_data_dir().to_path_buf();
            let logger = crate::debug_logger::DebugLogger::new(dir);

            // 从 API 返回的 usage 数据中提取实际 token 数量
            let (actual_prompt_tokens, actual_completion_tokens, reasoning_tokens) =
                Self::extract_usage_tokens(
                    &captured_usage,
                    approx_tokens_out,
                    (request_bytes / 4).max(1),
                );

            let _ = logger
                .log_llm_usage(
                    "end",
                    &config.name,
                    &config.model,
                    &config.model_adapter,
                    request_bytes,
                    response_bytes,
                    actual_prompt_tokens as usize,
                    actual_completion_tokens as usize,
                    Some(dur),
                    None,
                )
                .await;

            crate::llm_usage::record_llm_usage(
                crate::llm_usage::CallerType::ChatV2,
                &config.model,
                actual_prompt_tokens,
                actual_completion_tokens,
                reasoning_tokens,
                None,
                Some(stream_event.to_string()),
                Some(dur as u64),
                !was_cancelled,
                if was_cancelled {
                    Some("cancelled".to_string())
                } else {
                    None
                },
            );
        }

        Ok(StandardModel2Output {
            assistant_message: if was_cancelled {
                String::new()
            } else {
                full_content
            },
            raw_response: Some("stream_response".to_string()),
            chain_of_thought_details,
            cancelled: was_cancelled,
        })
    }
    // 🎯 新增：通用流式接口，支持自定义模型配置（用于总结请求等特殊场景）
    pub async fn call_unified_model_stream_with_config(
        &self,
        config: &ApiConfig,
        context: &HashMap<String, Value>,
        chat_history: &[ChatMessage],
        subject: &str,
        enable_chain_of_thought: bool,
        image_paths: Option<Vec<String>>,
        task_context: Option<&str>,
        window: Window,
        stream_event: &str,
        _max_input_tokens_override: Option<usize>,
    ) -> Result<StandardModel2Output> {
        info!(
            "调用通用流式接口: 模型={}, 科目={}, 思维链={}, 图片数量={}",
            config.model,
            subject,
            enable_chain_of_thought,
            image_paths.as_ref().map(|p| p.len()).unwrap_or(0)
        );

        // 已移除 Google/Gemini 特殊适配器路由，统一走标准流式实现

        // 图片改为消息级来源
        let images_used_source = "per_message".to_string();
        let images_base64: Option<Vec<String>> = None;

        // 移除上下文预算裁剪：按照用户建议，完整保留历史，由前端展示token估算并由用户决定
        let chat_history = chat_history.to_vec();

        debug!(
            "[model2_stream_with_config] model={} provider={} adapter={} multi={} reasoning={} temp={} cot={} images={{source:{},count:{}}}",
            config.model, config.name, config.model_adapter, config.is_multimodal, config.is_reasoning, config.temperature,
            enable_chain_of_thought, images_used_source, images_base64.as_ref().map(|v| v.len()).unwrap_or(0)
        );

        let mut messages = vec![];

        // 文档31清理：科目配置系统已废弃，使用通用提示词
        let subject_prompt = format!("请基于{}科目的特点进行分析。\n\n", subject);

        // 构建系统提示词（使用与call_unified_model_2_stream相同的逻辑）
        if !context.is_empty() {
            let mut system_content = subject_prompt.clone();

            if let Some(task_ctx) = task_context {
                system_content.push_str(&format!("【任务背景】\n{}\n\n", task_ctx));
            }

            for (key, value) in context {
                match key.as_str() {
                    "ocr_text" => system_content.push_str(&format!(
                        "【题目内容】\n{}\n\n",
                        value.as_str().unwrap_or("")
                    )),
                    "user_question" => system_content.push_str(&format!(
                        "【学生问题】\n{}\n\n",
                        value.as_str().unwrap_or("")
                    )),
                    "tags" => {
                        if let Some(tags_array) = value.as_array() {
                            let tags: Vec<String> = tags_array
                                .iter()
                                .filter_map(|v| v.as_str())
                                .map(|s| s.to_string())
                                .collect();
                            if !tags.is_empty() {
                                system_content
                                    .push_str(&format!("【相关标签】\n{}\n\n", tags.join(", ")));
                            }
                        }
                    }
                    "mistake_type" => system_content.push_str(&format!(
                        "【题目类型】\n{}\n\n",
                        value.as_str().unwrap_or("")
                    )),
                    _ => {}
                }
            }

            if !config.is_reasoning {
                messages.push(json!({
                    "role": "system",
                    "content": system_content
                }));
            }

            // 如果是多模态模型且提供了图片，添加图片到第一条用户消息
            if config.is_multimodal && images_base64.is_some() && chat_history.is_empty() {
                let mut content = vec![json!({
                    "type": "text",
                    "text": "请基于上述信息和图片，提供详细的解答。"
                })];

                if let Some(images) = &images_base64 {
                    for image_base64 in images {
                        let image_format = Self::detect_image_format_from_base64(image_base64);
                        debug!("检测到图像格式: {}", image_format);
                        content.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:image/{};base64,{}", image_format, image_base64)
                            }
                        }));
                    }
                }

                messages.push(json!({
                    "role": "user",
                    "content": content
                }));
            } else if chat_history.is_empty() {
                // 纯文本模型或没有提供图片
                messages.push(json!({
                    "role": "user",
                    "content": "请基于上述信息，提供详细的解答。"
                }));
            }
        }

        // 添加聊天历史（包含工具调用消息的标准化）
        for (index, msg) in chat_history.iter().enumerate() {
            // 处理用户消息
            if msg.role == "user" {
                let mut message_content = msg.content.clone();
                if config.is_reasoning && index == 0 {
                    // 推理模型：首条用户消息合并科目提示（简化处理）
                    message_content = format!("{}\n\n{}", subject_prompt, message_content);
                }

                // 如果有文档附件，将其内容添加到消息中
                if let Some(doc_attachments) = &msg.doc_attachments {
                    if !doc_attachments.is_empty() {
                        message_content.push_str("\n\n--- 附件内容 ---");
                        for doc in doc_attachments {
                            message_content.push_str(&format!("\n\n【文档: {}】", doc.name));
                            if let Some(text_content) = &doc.text_content {
                                message_content.push_str(&format!("\n{}", text_content));
                            }
                        }
                    }
                }

                // 🎯 改造：如果是多模态模型且该条消息有图片，为该条消息附图
                if config.is_multimodal
                    && msg
                        .image_base64
                        .as_ref()
                        .map(|v| !v.is_empty())
                        .unwrap_or(false)
                {
                    let mut content = vec![json!({
                        "type": "text",
                        "text": message_content
                    })];

                    if let Some(images) = &msg.image_base64 {
                        for image_base64 in images {
                            let image_format = Self::detect_image_format_from_base64(image_base64);
                            content.push(json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:image/{};base64,{}", image_format, image_base64) }
                            }));
                        }
                    }

                    messages.push(json!({
                        "role": msg.role,
                        "content": content
                    }));
                } else {
                    messages.push(json!({
                        "role": msg.role,
                        "content": message_content
                    }));
                }
            } else if msg.role == "assistant" {
                // 如果assistant消息中存在工具调用，则以tool_calls标准结构发出
                if let Some(tc) = &msg.tool_call {
                    let tool_call_obj = json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.tool_name,
                            "arguments": tc.args_json.to_string()
                        }
                    });
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content,
                        "tool_calls": [tool_call_obj]
                    }));
                } else {
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content
                    }));
                }
            } else if msg.role == "tool" {
                // 工具结果消息必须包含 tool_call_id
                if let Some(tr) = &msg.tool_result {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tr.call_id,
                        "content": msg.content
                    }));
                } else {
                    // 降级兜底，避免产生不被API接受的tool消息
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content
                    }));
                }
            }
        }

        // 🔧 防御性合并：连续 assistant tool_calls（极端情况下可能出现）
        // 注意：history.rs 输出的是交叉模式 assistant→tool→assistant→tool，
        // 所以此函数在正常流程中是 no-op，仅作为防御性保护。
        Self::merge_consecutive_assistant_tool_calls(&mut messages);
        // 🔧 防御性合并：连续 user 消息合并
        Self::merge_consecutive_user_messages(&mut messages);

        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": true
        });

        Self::apply_reasoning_config(&mut request_body, &config, None);

        // 检查是否启用工具（全局 + 模型能力）
        let tools_enabled = self
            .db
            .get_setting("tools.enabled")
            .ok()
            .flatten()
            .map(|v| v.to_lowercase())
            .map(|v| v != "0" && v != "false")
            .unwrap_or(true); // 默认启用

        if tools_enabled && config.supports_tools {
            // 构建工具列表，包含本地工具和 MCP 工具
            let tools = self.build_tools_with_mcp(&window).await;

            // 只有在工具列表非空时才设置 tools 和 tool_choice
            if tools.as_array().map(|arr| !arr.is_empty()).unwrap_or(false) {
                request_body["tools"] = tools;
                request_body["tool_choice"] = json!("auto");
            } else {
                warn!("[LLM] 工具列表为空，跳过 tool_choice 设置");
            }
        } else {
            if !config.supports_tools {
                debug!("跳过工具注入：模型不支持函数调用 (supports_tools=false)");
                // 为不支持工具的模型主动调用RAG/智能记忆工具并注入上下文
                let inject_texts: Vec<String> = Vec::new();

                if let Some(_last_user_msg) =
                    chat_history.iter().filter(|m| m.role == "user").last()
                {
                    let memory_enabled_effective = context
                        .get("memory_enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    if memory_enabled_effective {
                        let _ = window.emit(
                            &format!("{}_memory_sources", stream_event),
                            &serde_json::json!({"stage":"disabled"}),
                        );
                    }

                    let rag_enabled = context
                        .get("rag_enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let _rag_library_ids: Option<Vec<String>> = context
                        .get("rag_library_ids")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect::<Vec<String>>()
                        })
                        .filter(|v| !v.is_empty());
                    let _rag_note_subjects: Option<Vec<String>> = context
                        .get("rag_note_subjects")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect::<Vec<String>>()
                        })
                        .filter(|v| !v.is_empty());
                    if rag_enabled {
                        // Legacy RAG removed; VFS RAG is used via builtin:rag_search tool
                        debug!("[Fallback] Legacy RAG removed, skipping knowledge base injection");
                    } else {
                        debug!("[Fallback] RAG 已关闭，跳过知识库注入");
                    }
                }

                // 如果有注入文本，添加到系统提示（统一长度门控）
                if !inject_texts.is_empty() {
                    // 单项与总量限额
                    let per_item_max = 1600usize; // 每段最多1600字符
                    let total_max = 20000usize; // 总注入最多20000字符
                    let mut acc = String::new();
                    for mut s in inject_texts {
                        if s.chars().count() > per_item_max {
                            s = s.chars().take(per_item_max).collect();
                        }
                        if acc.chars().count() + s.chars().count() > total_max {
                            break;
                        }
                        acc.push_str(&s);
                    }
                    let inject_content = acc;
                    // 将注入文本安全地合并到"模型实际可见"的消息：
                    // - 非推理模型：系统消息可见 → 追加到 system
                    // - 推理模型：系统消息最终合并到首条 user → 直接在首条 user 前面拼接
                    if !config.is_reasoning {
                        // 追加/创建 system
                        if let Some(first_msg) = messages.get_mut(0) {
                            if first_msg["role"] == "system" {
                                let current_content = first_msg["content"].as_str().unwrap_or("");
                                first_msg["content"] =
                                    json!(format!("{}\n\n{}", current_content, inject_content));
                            } else {
                                messages.insert(
                                    0,
                                    json!({ "role": "system", "content": inject_content }),
                                );
                            }
                        } else {
                            messages.push(json!({ "role": "system", "content": inject_content }));
                        }
                    } else {
                        // 推理模型：合并到首条用户消息开头
                        if let Some(first_msg) = messages.get_mut(0) {
                            if first_msg["role"] == "user" {
                                let cur = first_msg["content"].as_str().unwrap_or("");
                                first_msg["content"] =
                                    json!(format!("{}\n\n{}", inject_content, cur));
                            } else {
                                // 若首条不是 user，则创建一条新的 user 消息承载
                                messages.insert(
                                    0,
                                    json!({ "role": "user", "content": format!("{}", inject_content) })
                                );
                            }
                        } else {
                            messages.push(
                                json!({ "role": "user", "content": format!("{}", inject_content) }),
                            );
                        }
                    }
                }
            }
        }

        // 降级注入可能调整 messages，确保请求体使用最新消息集合
        request_body["messages"] = serde_json::Value::Array(messages.clone());

        // 根据模型适配器添加特定参数（应用供应商级别的 max_tokens 限制）
        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit);
        request_body["max_tokens"] = json!(max_tokens);
        request_body["temperature"] = json!(config.temperature);

        // 记录请求体大小与起始时间
        let request_json_str = serde_json::to_string(&request_body).unwrap_or_default();
        let request_bytes = request_json_str.len();
        let start_instant = std::time::Instant::now();

        // 输出完整请求体用于调试
        debug!("[LLM_CONTINUE_DEBUG] ==> 完整请求体开始 <==");
        debug!(
            "{}",
            serde_json::to_string_pretty(&request_body).unwrap_or_default()
        );
        debug!("[LLM_CONTINUE_DEBUG] ==> 完整请求体结束 <==");

        debug!("发送请求到: {}", config.base_url);
        // 使用 ProviderAdapter 统一构建请求（避免覆盖分支硬编码/chat/completions）
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("续写请求构建失败", e))?;

        // ★ 同主路径：使用适配器转换后的实际请求体
        let debug_persist = self.build_debug_persist_config();
        log_and_emit_llm_request(
            "CONTINUE_STREAM",
            &window,
            stream_event,
            None,
            &config.model,
            &preq.url,
            &preq.body,
            debug_persist.as_ref(),
        );

        let mut request_builder = self.client
            .post(&preq.url)
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            // config is a parameter here
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        // 进入前先清空一次可能残留的取消标志，避免新请求被立即终止
        let _ = self.consume_pending_cancel(stream_event).await;

        // 注册取消通道（通知式中断）
        let cancel_rx = self.register_cancel_channel(stream_event).await;

        // 发出开始事件
        let request_id = Uuid::new_v4().to_string();
        if let Err(e) = window.emit(
            &format!("{}_start", stream_event),
            &json!({
                "id": request_id,
                "model": config.model,
                "request_bytes": request_bytes
            }),
        ) {
            warn!("发送开始事件失败: {}", e);
        }

        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let status_code = status.as_u16();
            let status_text = status.canonical_reason().unwrap_or("Unknown");
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!(
                "通用流式接口请求失败: HTTP {} {} - {}",
                status_code, status_text, error_text
            );

            error!("{}", error_msg);

            let error_payload = json!({
                "type": "http_error",
                "error": error_msg,
                "status": status_code,
                "stream_event": stream_event,
                "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
            });

            if let Err(e) = window.emit(&format!("{}_error", stream_event), &error_payload) {
                warn!("发送HTTP错误事件失败: {}", e);
            }

            let duration_ms = start_instant.elapsed().as_millis();
            if let Err(e) = window.emit(
                &format!("{}_end", stream_event),
                &json!({
                    "reason": "error",
                    "stats": {
                        "chunk_count": 0,
                        "request_bytes": request_bytes,
                        "response_bytes": error_text.len(),
                        "duration_ms": duration_ms,
                        "approx_tokens_in": 0,
                        "approx_tokens_out": 0,
                        "retry_count": 0
                    }
                }),
            ) {
                warn!("发送错误结束事件失败: {}", e);
            }

            self.clear_cancel_channel(stream_event).await;
            return Err(AppError::llm(error_msg));
        }

        // 流式处理响应（使用与call_unified_model_2_stream相同的逻辑）
        let mut stream = response.bytes_stream();
        let mut full_content = String::new();
        let mut reasoning_content = String::new();
        let mut chunk_counter = 0;
        let mut response_bytes: usize = 0;
        let mut was_cancelled = false;
        let mut captured_tool_calls: Vec<crate::models::ToolCall> = Vec::new();
        // 捕获 API 返回的 usage 信息（用于准确记录 token 使用量）
        let mut captured_usage: Option<serde_json::Value> = None;

        // 工具调用聚合状态 - 用于处理流式分块的工具调用
        let mut pending_tool_calls: std::collections::HashMap<i32, (String, String, String)> =
            std::collections::HashMap::new(); // index -> (id, name, accumulated_args)
        let mut stream_ended = false;
        // 初始化SSE行缓冲器
        let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();

        while let Some(chunk_result) = stream.next().await {
            // 先主动清理一次注册表中的取消标志，再检查通道中的通知
            let registry_cancelled = self.consume_pending_cancel(stream_event).await;
            if *cancel_rx.borrow() || registry_cancelled {
                info!(
                    "[Cancel] Breaking stream loop for {} (custom config)",
                    stream_event
                );
                // P1修复：生命周期对齐 - 发送cancelled事件
                if let Err(e) = window.emit(
                    &format!("{}_cancelled", stream_event),
                    &json!({
                        "id": request_id,
                        "reason": "user_cancelled",
                        "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                    }),
                ) {
                    warn!("发送取消事件失败: {}", e);
                }
                was_cancelled = true;
                break;
            }
            match chunk_result {
                Ok(chunk) => {
                    response_bytes += chunk.len();
                    let chunk_str = String::from_utf8_lossy(&chunk);

                    // 使用SSE缓冲器处理chunk，获取完整的行
                    let complete_lines = sse_buffer.process_chunk(&chunk_str);
                    for line in complete_lines {
                        // 使用适配器解析流事件（包括[DONE]标记）
                        let events = adapter.parse_stream(&line);

                        // 检查是否是结束标记（保留为后备机制）
                        if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
                            debug!("检测到SSE结束标记: [DONE]");
                            if events.is_empty() {
                                // 如果适配器没有生成Done事件，我们手动添加一个
                                debug!("适配器未生成Done事件，手动添加");
                                stream_ended = true;
                                break;
                            }
                        }
                        for event in events {
                            match event {
                                crate::providers::StreamEvent::ContentChunk(content) => {
                                    full_content.push_str(&content);
                                    chunk_counter += 1;

                                    let stream_chunk = StreamChunk {
                                        content: content.clone(),
                                        is_complete: false,
                                        chunk_id: format!("{}_chunk_{}", request_id, chunk_counter),
                                    };

                                    if let Err(e) = window.emit(stream_event, &stream_chunk) {
                                        error!("发送内容块失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::ReasoningChunk(reasoning) => {
                                    reasoning_content.push_str(&reasoning);

                                    let reasoning_chunk = StreamChunk {
                                        content: reasoning.clone(),
                                        is_complete: false,
                                        chunk_id: format!(
                                            "{}_reasoning_chunk_{}",
                                            request_id, chunk_counter
                                        ),
                                    };

                                    if let Err(e) = window.emit(
                                        &format!("{}_reasoning", stream_event),
                                        &reasoning_chunk,
                                    ) {
                                        warn!("发送思维链块失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::ThoughtSignature(_signature) => {
                                    // Gemini 3 思维签名（此函数不使用 hook，直接忽略）
                                    // 签名在工具调用场景下需要缓存，但此函数用于 v2 pipeline
                                }
                                crate::providers::StreamEvent::ToolCall(tool_call_value) => {
                                    // 聚合分块的工具调用（不再发送原始分块事件）
                                    if let Some(index) = tool_call_value
                                        .get("index")
                                        .and_then(|v| v.as_i64())
                                        .map(|v| v as i32)
                                    {
                                        if let Some(id) =
                                            tool_call_value.get("id").and_then(|v| v.as_str())
                                        {
                                            // 这是一个新的工具调用的开始（有完整的id）
                                            let name = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("name"))
                                                .and_then(|n| n.as_str())
                                                .unwrap_or("unknown");
                                            // 🔧 修复：某些 OpenAI 兼容 API 返回 arguments 为 JSON 对象而非字符串
                                            let args = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .map(|a| {
                                                    if let Some(s) = a.as_str() {
                                                        s.to_string()
                                                    } else if a.is_null() {
                                                        String::new()
                                                    } else {
                                                        warn!("[llm_manager] 工具调用 arguments 不是字符串而是 JSON 值 (tool={}), 自动序列化", name);
                                                        serde_json::to_string(a).unwrap_or_default()
                                                    }
                                                })
                                                .unwrap_or_default();

                                            pending_tool_calls.insert(
                                                index,
                                                (id.to_string(), name.to_string(), args),
                                            );
                                            // 简化日志：工具调用开始时输出一次
                                            print!("🔧");
                                            use std::io::Write;
                                            let _ = std::io::stdout().flush();
                                        } else if let Some((id, name, mut accumulated_args)) =
                                            pending_tool_calls.get(&index).cloned()
                                        {
                                            // 这是工具调用的后续块（没有id，只有arguments片段）
                                            // 🔧 修复：同样处理 arguments 为 JSON 对象的情况
                                            let args_fragment_opt = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .and_then(|a| {
                                                    if let Some(s) = a.as_str() {
                                                        Some(s.to_string())
                                                    } else if a.is_null() {
                                                        None
                                                    } else {
                                                        Some(
                                                            serde_json::to_string(a)
                                                                .unwrap_or_default(),
                                                        )
                                                    }
                                                });
                                            if let Some(args_fragment) = args_fragment_opt {
                                                accumulated_args.push_str(&args_fragment);
                                                pending_tool_calls.insert(
                                                    index,
                                                    (id, name, accumulated_args.clone()),
                                                );
                                                // 简化日志：每 200 字符输出一个 / 代表累积
                                                if accumulated_args.len() % 200
                                                    < args_fragment.len()
                                                {
                                                    print!("/");
                                                    use std::io::Write;
                                                    let _ = std::io::stdout().flush();
                                                }
                                            }
                                        }
                                    }
                                }
                                crate::providers::StreamEvent::Usage(usage_value) => {
                                    // 存储 usage 数据
                                    captured_usage = Some(usage_value.clone());
                                    if let Err(e) = window
                                        .emit(&format!("{}_usage", stream_event), &usage_value)
                                    {
                                        error!("发送用量事件失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::SafetyBlocked(safety_info) => {
                                    // emit safety_blocked 事件
                                    if let Err(e) = window.emit(
                                        &format!("{}_safety_blocked", stream_event),
                                        &safety_info,
                                    ) {
                                        error!("发送安全阻断事件失败: {}", e);
                                    }
                                    // 同时发送通用错误事件
                                    let error_event = json!({
                                        "type": "safety_error",
                                        "message": "Request blocked due to safety policies",
                                        "details": safety_info
                                    });
                                    if let Err(e) = window
                                        .emit(&format!("{}_error", stream_event), &error_event)
                                    {
                                        error!("发送安全错误事件失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::Done => {
                                    stream_ended = true;

                                    // 完成待聚合的工具调用（只在有工具调用时输出简洁日志）
                                    if !pending_tool_calls.is_empty() {
                                        debug!("工具调用序列结束");
                                    }
                                    for (_index, (id, name, accumulated_args)) in
                                        pending_tool_calls.iter()
                                    {
                                        let complete_tool_call = serde_json::json!({
                                            "id": id,
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": accumulated_args
                                            }
                                        });

                                        match Self::convert_openai_tool_call(&complete_tool_call) {
                                            Ok(tc) => {
                                                captured_tool_calls.push(tc);
                                            }
                                            Err(e) => {
                                                warn!("[llm_manager] 工具调用解析失败: {}, args_len={}", e, accumulated_args.len());
                                                // 构造带截断错误标记的 ToolCall，让 pipeline 层反馈给 LLM 重试
                                                captured_tool_calls.push(crate::models::ToolCall {
                                                    id: id.clone(),
                                                    tool_name: name.clone(),
                                                    args_json: json!({
                                                        "_truncation_error": true,
                                                        "_error_message": format!(
                                                            "工具调用参数 JSON 被截断（已生成 {} 字符但未完成）。原因：模型输出 token 达到上限。",
                                                            accumulated_args.len()
                                                        ),
                                                        "_args_len": accumulated_args.len(),
                                                    }),
                                                });
                                            }
                                        }
                                    }
                                    // 输出一条简洁的工具调用总结
                                    if !captured_tool_calls.is_empty() {
                                        let names: Vec<_> = captured_tool_calls
                                            .iter()
                                            .map(|tc| tc.tool_name.as_str())
                                            .collect();
                                        debug!("工具调用聚合完成: {:?}", names);
                                    }
                                    pending_tool_calls.clear();

                                    break;
                                }
                            }
                        }

                        if stream_ended {
                            break;
                        }
                    }
                }
                Err(e) => {
                    error!("流式响应错误: {}", e);
                    break;
                }
            }
        }

        // 处理SSE缓冲器中剩余的不完整行（P1修复：STREAM-3）
        if let Some(remaining_line) = sse_buffer.flush() {
            if !remaining_line.trim().is_empty() {
                debug!("处理SSE缓冲器中的剩余数据: {} 字符", remaining_line.len());
                // 使用适配器解析剩余的行
                let events = adapter.parse_stream(&remaining_line);
                for event in events {
                    match event {
                        crate::providers::StreamEvent::ContentChunk(content) => {
                            full_content.push_str(&content);
                            chunk_counter += 1;

                            let stream_chunk = StreamChunk {
                                content: content.clone(),
                                is_complete: false,
                                chunk_id: format!("{}_chunk_{}", request_id, chunk_counter),
                            };

                            if let Err(e) = window.emit(stream_event, &stream_chunk) {
                                error!("发送剩余内容块失败: {}", e);
                            }
                        }
                        crate::providers::StreamEvent::ReasoningChunk(reasoning) => {
                            reasoning_content.push_str(&reasoning);

                            let reasoning_chunk = StreamChunk {
                                content: reasoning.clone(),
                                is_complete: false,
                                chunk_id: format!(
                                    "{}_reasoning_chunk_{}",
                                    request_id, chunk_counter
                                ),
                            };

                            if let Err(e) = window
                                .emit(&format!("{}_reasoning", stream_event), &reasoning_chunk)
                            {
                                warn!("发送剩余思维链块失败: {}", e);
                            }
                        }
                        _ => { /* 忽略其他事件类型（Done/ToolCall/Usage等已在主循环处理） */
                        }
                    }
                }
            }
        }

        // 清理取消通道
        self.clear_cancel_channel(stream_event).await;

        // 🔧 [REFACTOR] 旧的工具调用执行逻辑已移除
        // 工具调用现在由 Chat V2 Pipeline 统一处理（src-tauri/src/chat_v2/pipeline.rs）
        // 此函数只负责流式响应的收集，工具调用通过 LLMStreamHooks 回调给上层

        if was_cancelled {
            // P1修复：生命周期对齐 - 发送专门的cancelled事件，同时保持end事件
            if let Err(e) = window.emit(
                &format!("{}_cancelled", stream_event),
                &json!({
                    "id": request_id,
                    "reason": "user_cancelled",
                    "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                }),
            ) {
                warn!("发送取消事件失败: {}", e);
            }

            // 取消：仍发送 end 事件用于兼容性
            let duration_ms = start_instant.elapsed().as_millis();
            if let Err(e) = window.emit(
                &format!("{}_end", stream_event),
                &json!({
                    "reason": "cancelled",
                    "stats": {
                        "chunk_count": chunk_counter,
                        "request_bytes": request_bytes,
                        "response_bytes": response_bytes,
                        "duration_ms": duration_ms,
                        "approx_tokens_in": 0,
                        "approx_tokens_out": 0,
                        "retry_count": 0
                    }
                }),
            ) {
                warn!("发送结束事件失败: {}", e);
            }
        } else {
            // 成功：发送完成块与 end(success)
            let final_chunk = StreamChunk {
                content: full_content.clone(),
                is_complete: true,
                chunk_id: format!("final_chunk_{}", chunk_counter),
            };
            if let Err(e) = window.emit(stream_event, &final_chunk) {
                error!("发送最终完成信号失败: {}", e);
            }
            // 如果有思维链内容，也发送思维链完成信号
            if enable_chain_of_thought && !reasoning_content.is_empty() {
                let reasoning_final_chunk = StreamChunk {
                    content: reasoning_content.clone(),
                    is_complete: true,
                    chunk_id: format!("reasoning_final_chunk_{}", chunk_counter + 1),
                };
                if let Err(e) = window.emit(
                    &format!("{}_reasoning", stream_event),
                    &reasoning_final_chunk,
                ) {
                    error!("发送思维链完成信号失败: {}", e);
                }
            }
            // end(success) 事件在统一统计段发送
        }

        // 结束事件（附带统计信息）
        let duration_ms = start_instant.elapsed().as_millis();
        let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&full_content);
        if let Err(e) = window.emit(
            &format!("{}_end", stream_event),
            &json!({
                "reason": "success",
                "stats": {
                    "chunk_count": chunk_counter,
                    "request_bytes": request_bytes,
                    "response_bytes": response_bytes,
                    "duration_ms": duration_ms,
                    "approx_tokens_in": 0,
                    "approx_tokens_out": approx_tokens_out,
                    "retry_count": 0
                }
            }),
        ) {
            warn!("发送结束事件失败: {}", e);
        }

        // 用量日志：结束（脱敏写入，使用 FileManager）
        {
            let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&full_content);
            let dur = start_instant.elapsed().as_millis();
            let dir = self.file_manager.get_app_data_dir().to_path_buf();
            let logger = crate::debug_logger::DebugLogger::new(dir);

            // 从 API 返回的 usage 数据中提取实际 token 数量
            let (actual_prompt_tokens, actual_completion_tokens, reasoning_tokens) =
                Self::extract_usage_tokens(
                    &captured_usage,
                    approx_tokens_out,
                    (request_bytes / 4).max(1),
                );

            let _ = logger
                .log_llm_usage(
                    "end",
                    &config.name,
                    &config.model,
                    &config.model_adapter,
                    request_bytes,
                    response_bytes,
                    actual_prompt_tokens as usize,
                    actual_completion_tokens as usize,
                    Some(dur),
                    None,
                )
                .await;

            crate::llm_usage::record_llm_usage(
                crate::llm_usage::CallerType::ChatV2,
                &config.model,
                actual_prompt_tokens,
                actual_completion_tokens,
                reasoning_tokens,
                None,
                Some(stream_event.to_string()),
                Some(dur as u64),
                !was_cancelled,
                if was_cancelled {
                    Some("cancelled".to_string())
                } else {
                    None
                },
            );
        }

        // 构建思维链详情
        let chain_of_thought_details = if enable_chain_of_thought {
            if config.is_reasoning {
                Some(json!({
                    "full_response": full_content,
                    "reasoning_content": if reasoning_content.is_empty() { Value::Null } else { json!(reasoning_content) },
                    "enabled": true,
                    "is_reasoning_model": true,
                    "model_adapter": config.model_adapter
                }))
            } else {
                None
            }
        } else {
            None
        };

        Ok(StandardModel2Output {
            assistant_message: if was_cancelled {
                String::new()
            } else {
                full_content
            },
            raw_response: Some("stream_response".to_string()),
            chain_of_thought_details,
            cancelled: was_cancelled,
        })
    }
    // 统一AI接口层 - 模型二（核心解析/对话）- 非流式版本（保持向后兼容）
    pub async fn call_unified_model_2(
        &self,
        context: &HashMap<String, Value>,
        chat_history: &[ChatMessage],
        subject: &str,
        enable_chain_of_thought: bool,
        image_paths: Option<Vec<String>>,
        task_context: Option<&str>,
        max_input_tokens_override: Option<usize>,
    ) -> Result<StandardModel2Output> {
        info!(
            "调用统一模型二接口: 科目={}, 思维链={}, 图片数量={}",
            subject,
            enable_chain_of_thought,
            image_paths.as_ref().map(|p| p.len()).unwrap_or(0)
        );

        let _max_input_tokens_override = max_input_tokens_override;

        // 获取模型配置
        // Model Router: choose model by task_context when possible
        let (config, _enable_cot) = {
            let task = match task_context {
                Some(tc) if tc.contains("planner") => "review",
                // 🚀 修复：添加tag_generation的路由支持
                Some(tc) if tc == "tag_generation" || tc.contains("tag") => "tag_generation",
                _ => "default",
            };
            self.select_model_for(task, None, None, None, None, None, None)
                .await
                .unwrap_or((self.get_model2_config().await?, true))
        };

        // 处理图片（如果模型支持多模态且提供了图片）
        // 移除会话级图片回退，不再从 image_paths 读取
        let images_base64: Option<Vec<String>> = None;

        let mut messages = vec![];

        // 获取科目专用的Prompt
        let mut subject_prompt = self.get_subject_prompt(subject, "model2");

        // 添加任务上下文
        if let Some(context_str) = task_context {
            subject_prompt = format!("{}\n\n任务上下文: {}", subject_prompt, context_str);
        }

        // 构建系统消息，包含研究/题目信息与可选研究片段
        let system_content = format!(
            "{}\n\n题目信息:\nOCR文本: {}\n标签: {:?}\n题目类型: {}\n用户原问题: {}",
            subject_prompt,
            context
                .get("ocr_text")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            context
                .get("tags")
                .and_then(|v| v.as_array())
                .unwrap_or(&vec![]),
            context
                .get("mistake_type")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            context
                .get("user_question")
                .and_then(|v| v.as_str())
                .unwrap_or("")
        );

        // 禁止 RAG 文本拼接

        // 不注入 latest_user_query 到 system

        // 对于推理模型，系统消息需要合并到用户消息中
        if config.is_reasoning {
            // 推理模型不支持系统消息，需要将系统提示合并到用户消息中
            let combined_content = format!("{}", system_content);

            if config.is_multimodal && images_base64.is_some() && chat_history.is_empty() {
                let mut content = vec![json!({
                    "type": "text",
                    "text": combined_content
                })];

                if let Some(images) = &images_base64 {
                    for image_base64 in images {
                        let image_format = Self::detect_image_format_from_base64(image_base64);
                        debug!("检测到图像格式: {}", image_format);
                        content.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:image/{};base64,{}", image_format, image_base64)
                            }
                        }));
                    }
                }

                messages.push(json!({
                    "role": "user",
                    "content": content
                }));
            } else if chat_history.is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": combined_content
                }));
            }
        } else {
            // 非推理模型使用标准的系统消息
            messages.push(json!({
                "role": "system",
                "content": system_content
            }));
            // 后续严禁再注入"伪 system 文本"或提示
        }

        // 添加聊天历史（包含每条 user 的 image_base64 多模态 parts 构建）
        // 🔧 C3修复：补充 tool_call/tool_result 处理（之前完全丢弃工具调用信息）
        for msg in chat_history {
            if msg.role == "user" {
                if config.is_multimodal
                    && msg
                        .image_base64
                        .as_ref()
                        .map(|v| !v.is_empty())
                        .unwrap_or(false)
                {
                    let mut parts = vec![json!({"type":"text","text": msg.content})];
                    if let Some(images) = &msg.image_base64 {
                        for image_base64 in images {
                            let image_format = Self::detect_image_format_from_base64(image_base64);
                            parts.push(json!({
                                "type": "image_url",
                                "image_url": {"url": format!("data:image/{};base64,{}", image_format, image_base64)}
                            }));
                        }
                    }
                    messages.push(json!({"role":"user","content": parts}));
                } else {
                    messages.push(json!({"role": "user", "content": msg.content}));
                }
            } else if msg.role == "assistant" {
                if let Some(tc) = &msg.tool_call {
                    let tool_call_obj = json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.tool_name,
                            "arguments": tc.args_json.to_string()
                        }
                    });
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content,
                        "tool_calls": [tool_call_obj]
                    }));
                } else {
                    messages.push(json!({"role": "assistant", "content": msg.content}));
                }
            } else if msg.role == "tool" {
                if let Some(tr) = &msg.tool_result {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tr.call_id,
                        "content": msg.content
                    }));
                } else {
                    // 降级兜底
                    messages.push(json!({"role": "assistant", "content": msg.content}));
                }
            } else {
                messages.push(json!({"role": msg.role, "content": msg.content}));
            }
        }

        // 🔧 防御性合并：连续 assistant tool_calls（正常流程中是 no-op）
        Self::merge_consecutive_assistant_tool_calls(&mut messages);
        // 🔧 防御性合并：连续 user 消息合并
        Self::merge_consecutive_user_messages(&mut messages);

        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": false  // 非流式版本
        });

        Self::apply_reasoning_config(&mut request_body, &config, None);

        // 根据模型适配器类型设置不同的参数
        if cfg!(debug_assertions) {
            // debug removed
        }

        // 应用供应商级别的 max_tokens 限制
        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit);
        if config.is_reasoning {
            request_body["max_completion_tokens"] = json!(max_tokens);
            debug!("应用推理模型参数: max_completion_tokens={}", max_tokens);
        } else {
            request_body["max_tokens"] = json!(max_tokens);
            request_body["temperature"] = json!(config.temperature);
        }

        // 使用 ProviderAdapter 构建请求，确保 Gemini 模型走转换后的URL/Headers/Body
        let adapter: Box<dyn ProviderAdapter> = if self.should_use_openai_responses(&config) {
            Box::new(crate::providers::OpenAIResponsesAdapter)
        } else {
            match config.model_adapter.as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            }
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("聊天请求构建失败", e))?;

        let debug_persist = self.build_debug_persist_config();
        log_llm_request_audit(
            "CHAT_V2_STREAM",
            &preq.url,
            &config.model,
            &request_body,
            debug_persist.as_ref(),
        );

        let mut request_builder = self.client
            .post(&preq.url)
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("模型二API请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!("模型二API请求失败: {} - {}", status, error_text);
            // 非流式版本没有 stream_event/window 上下文，这里仅返回错误
            error!("模型二API请求失败(非流式): {}", error_msg);
            return Err(AppError::llm(error_msg));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取模型二响应失败: {}", e)))?;
        let response_bytes = response_text.len();
        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| AppError::llm(format!("解析模型二响应失败: {}", e)))?;

        // Gemini 非流式响应统一转换为 OpenAI 形状
        let openai_like_json = if config.model_adapter == "google" {
            // 非流式：先检测安全阻断
            if let Some(safety_msg) = Self::extract_gemini_safety_error(&response_json) {
                return Err(AppError::llm(safety_msg));
            }
            match crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&response_json, &config.model) {
                Ok(v) => v,
                Err(e) => return Err(AppError::llm(format!("Gemini响应转换失败: {}", e))),
            }
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else if self.should_use_openai_responses(&config) {
            let mut text_segments: Vec<String> = Vec::new();
            if let Some(output) = response_json.get("output").and_then(|v| v.as_array()) {
                for item in output {
                    if let Some(content_arr) = item.get("content").and_then(|v| v.as_array()) {
                        for entry in content_arr {
                            let entry_type =
                                entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if matches!(entry_type, "output_text" | "text") {
                                if let Some(text) = entry.get("text").and_then(|v| v.as_str()) {
                                    if !text.is_empty() {
                                        text_segments.push(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if text_segments.is_empty() {
                if let Some(output_text) = response_json.get("output_text").and_then(|v| v.as_str())
                {
                    if !output_text.is_empty() {
                        text_segments.push(output_text.to_string());
                    }
                }
            }
            json!({
                "choices": [{
                    "message": {
                        "content": text_segments.join("")
                    }
                }],
                "usage": response_json.get("usage").cloned()
            })
        } else {
            response_json.clone()
        };

        let content = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("无法解析模型二API响应"))?;

        // 如果启用了思维链，尝试提取思维链详情
        let chain_of_thought_details = if enable_chain_of_thought {
            // 这里可以根据响应内容解析思维链步骤
            // 暂时将完整响应作为思维链详情
            Some(json!({
                "full_response": content,
                "enabled": true,
                "is_reasoning_model": config.is_reasoning,
                "model_adapter": config.model_adapter
            }))
        } else {
            None
        };

        // 用量日志：结束（简化控制台输出）
        let approx_tokens_out = crate::utils::token_budget::estimate_tokens(content);
        debug!(
            "[model2_non_stream] bytes_out={}, approx_tokens_out={}",
            response_bytes, approx_tokens_out
        );

        Ok(StandardModel2Output {
            assistant_message: content.to_string(),
            raw_response: Some(openai_like_json.to_string()),
            chain_of_thought_details,
            cancelled: false,
        })
    }
    pub async fn generate_chat_metadata(
        &self,
        _subject: &str, // subject 已废弃
        user_question: &str,
        conversation_preview: Option<&str>,
        attachment_names: &[String],
    ) -> Result<crate::models::ChatMetadata> {
        let normalized_question = user_question.trim();
        let preview = conversation_preview.unwrap_or("").trim();

        let mut prompt_body = format!(
            "首轮用户输入：\n{}",
            if normalized_question.is_empty() {
                "(无文本，仅附件或其他输入)"
            } else {
                normalized_question
            }
        );

        if !preview.is_empty() {
            prompt_body.push_str("\n\n补充上下文：\n");
            prompt_body.push_str(preview);
        }

        let attachment_list: Vec<String> = attachment_names
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .map(|name| name.to_string())
            .collect();
        if !attachment_list.is_empty() {
            prompt_body.push_str("\n\n附件列表：\n");
            for name in &attachment_list {
                prompt_body.push_str("- ");
                prompt_body.push_str(name);
                prompt_body.push('\n');
            }
        }

        let system_prompt =
            "你是一名对聊天会话生成结构化元数据的助理。只输出JSON，不要额外文字。\n\n".to_string()
                + "请输出一个JSON对象，包含以下字段：\n"
                + "- title: 简洁的中文标题（<=20字），概括聊天主题；\n"
                + "- summary: 1-2句中文概要，若信息不足可省略；\n"
                + "- tags: 中文标签数组（<=3个，若无合适标签则为空数组）；\n"
                + "- attributes: 可选对象，记录额外键值对，例如{\"intent\":\"规划\"}。";

        let (config, _) = self
            .select_model_for("chat_title", None, Some(0.1), None, None, None, None)
            .await?;
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        let request_body = json!({
            "model": config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt_body}
            ],
            "temperature": config.temperature.max(0.1),
            "stream": false
        });

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(
                config.base_url.trim_end_matches('/'),
                &api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("生成聊天元数据请求构建失败", e))?;

        log_llm_request_audit(
            "METADATA",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let mut request_builder = self.client.post(&preq.url);
        for (key, value) in preq.headers.iter() {
            request_builder = request_builder.header(key, value);
        }

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("聊天元数据生成请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "聊天元数据生成失败: {} - {}",
                status, error_body
            )));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取聊天元数据响应失败: {}", e)))?;
        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| AppError::llm(format!("解析聊天元数据响应失败: {}", e)))?;

        let openai_like_json = if config.model_adapter == "google" {
            if let Some(safety_msg) = Self::extract_gemini_safety_error(&response_json) {
                return Err(AppError::llm(safety_msg));
            }
            match crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&response_json, &config.model) {
                Ok(v) => v,
                Err(e) => return Err(AppError::llm(format!("Gemini响应转换失败: {}", e))),
            }
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else {
            response_json.clone()
        };

        let content = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("聊天元数据模型返回内容为空"))?;

        fn extract_json_block(raw: &str) -> Option<String> {
            let trimmed = raw.trim();
            let cleaned = if trimmed.starts_with("```") {
                trimmed
                    .trim_start_matches("```json")
                    .trim_start_matches("```JSON")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim()
                    .to_string()
            } else {
                trimmed.to_string()
            };

            if serde_json::from_str::<Value>(&cleaned).is_ok() {
                return Some(cleaned);
            }

            if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
                if end > start {
                    let candidate = &cleaned[start..=end];
                    if serde_json::from_str::<Value>(candidate).is_ok() {
                        return Some(candidate.to_string());
                    }
                }
            }

            None
        }

        let json_block = extract_json_block(content)
            .ok_or_else(|| AppError::llm("未能从聊天元数据响应中提取JSON"))?;

        let metadata_value: Value = serde_json::from_str(&json_block)
            .map_err(|e| AppError::llm(format!("解析聊天元数据JSON失败: {}", e)))?;

        let mut title = metadata_value
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| normalized_question.chars().take(20).collect());
        if title.is_empty() {
            title = normalized_question.chars().take(20).collect();
        }

        let summary = metadata_value
            .get("summary")
            .and_then(|v| v.as_str())
            .map(|s| {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .flatten();

        let tags: Vec<String> = metadata_value
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .take(3)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_else(Vec::new);

        let attributes = metadata_value.get("attributes").and_then(|v| {
            if v.is_object() {
                Some(v.clone())
            } else {
                None
            }
        });

        Ok(crate::models::ChatMetadata {
            title,
            summary,
            tags,
            attributes,
            note: None,
        })
    }

    pub async fn test_connection(&self, api_key: &str, base_url: &str) -> Result<bool> {
        self.test_connection_with_model(api_key, base_url, None)
            .await
    }

    // 测试API连接 - 可以指定具体模型
    pub async fn test_connection_with_model(
        &self,
        api_key: &str,
        base_url: &str,
        model_name: Option<&str>,
    ) -> Result<bool> {
        info!("测试API连接: {} (密钥长度: {})", base_url, api_key.len());

        // 确保base_url格式正确
        let normalized_url = if base_url.ends_with('/') {
            base_url.trim_end_matches('/').to_string()
        } else {
            base_url.to_string()
        };

        // 如果指定了模型名称，检查模型类型并使用适当的测试方法
        if let Some(model) = model_name {
            let lower_model = model.to_lowercase();

            // 嵌入模型测试
            if lower_model.contains("embedding")
                || lower_model.contains("bge-")
                || lower_model.contains("embed")
            {
                return self
                    .test_embedding_model(api_key, &normalized_url, model)
                    .await;
            }

            // 重排序模型测试
            if lower_model.contains("rerank") || lower_model.contains("reranker") {
                return self
                    .test_reranker_model(api_key, &normalized_url, model)
                    .await;
            }

            // 对话模型测试（默认）
            return self
                .test_chat_model(api_key, &normalized_url, Some(model))
                .await;
        }

        // 未指定模型时，使用通用测试
        self.test_chat_model(api_key, &normalized_url, None).await
    }

    // 测试嵌入模型
    async fn test_embedding_model(
        &self,
        api_key: &str,
        base_url: &str,
        model: &str,
    ) -> Result<bool> {
        info!("测试嵌入模型: {}", model);

        let request_body = json!({
            "model": model,
            "input": ["测试嵌入连接"],
            "encoding_format": "float"
        });

        let timeout_duration = std::time::Duration::from_secs(15);
        let request_future = self
            .client
            .post(&format!("{}/embeddings", base_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header(
                "Accept",
                "text/event-stream, application/json, text/plain, */*",
            )
            .header("Accept-Encoding", "identity")
            .json(&request_body)
            .send();

        match tokio::time::timeout(timeout_duration, request_future).await {
            Ok(Ok(response)) => {
                let status = response.status();
                debug!("嵌入模型测试响应状态: {} (模型: {})", status, model);

                if status.is_success() {
                    info!("嵌入模型测试成功！模型: {}", model);
                    Ok(true)
                } else {
                    let error_text = response.text().await.unwrap_or_default();
                    warn!("嵌入模型测试失败: {} - {}", status, error_text);
                    Ok(false)
                }
            }
            Ok(Err(e)) => {
                error!("嵌入模型测试请求错误: {}", e);
                Err(AppError::network(format!("嵌入模型测试失败: {}", e)))
            }
            Err(_) => {
                warn!("嵌入模型测试超时");
                Err(AppError::network("嵌入模型测试超时"))
            }
        }
    }

    // 测试重排序模型
    async fn test_reranker_model(
        &self,
        api_key: &str,
        base_url: &str,
        model: &str,
    ) -> Result<bool> {
        info!("测试重排序模型: {}", model);

        let request_body = json!({
            "model": model,
            "query": "测试查询",
            "documents": ["测试文档1", "测试文档2"],
            "top_k": 2,
            "return_documents": true
        });

        let timeout_duration = std::time::Duration::from_secs(15);
        let request_future = self
            .client
            .post(&format!("{}/rerank", base_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .header(
                "Accept",
                "text/event-stream, application/json, text/plain, */*",
            )
            .header("Accept-Encoding", "identity")
            .json(&request_body)
            .send();

        match tokio::time::timeout(timeout_duration, request_future).await {
            Ok(Ok(response)) => {
                let status = response.status();
                debug!("重排序模型测试响应状态: {} (模型: {})", status, model);

                if status.is_success() {
                    info!("重排序模型测试成功！模型: {}", model);
                    Ok(true)
                } else {
                    let error_text = response.text().await.unwrap_or_default();
                    warn!("重排序模型测试失败: {} - {}", status, error_text);
                    Ok(false)
                }
            }
            Ok(Err(e)) => {
                error!("重排序模型测试请求错误: {}", e);
                Err(AppError::network(format!("重排序模型测试失败: {}", e)))
            }
            Err(_) => {
                warn!("重排序模型测试超时");
                Err(AppError::network("重排序模型测试超时"))
            }
        }
    }
    // 测试对话模型
    async fn test_chat_model(
        &self,
        api_key: &str,
        base_url: &str,
        model_name: Option<&str>,
    ) -> Result<bool> {
        // 如果指定了模型名称，优先使用指定的模型
        let test_models = if let Some(specified_model) = model_name {
            vec![specified_model.to_string()]
        } else {
            // 使用通用的测试模型名称，不同API提供商可能支持不同的模型
            vec![
                "gpt-3.5-turbo".to_string(),                 // OpenAI
                "Qwen/Qwen2-7B-Instruct".to_string(),        // SiliconFlow
                "meta-llama/Llama-2-7b-chat-hf".to_string(), // 其他
            ]
        };

        // 尝试不同的模型进行测试
        for model in test_models {
            let request_body = json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": "Hi"
                    }
                ],
                "max_tokens": 5,
                "temperature": 0.1
            });

            debug!("尝试模型: {}", model);

            // 使用 ProviderAdapter 构建请求（支持 Gemini 中转）
            let lower_base = base_url.to_lowercase();
            let lower_model = model.to_lowercase();
            let adapter: Box<dyn ProviderAdapter> =
                if lower_model.contains("claude") || lower_model.contains("anthropic") {
                    Box::new(crate::providers::AnthropicAdapter::new())
                } else if lower_model.contains("gemini")
                    || lower_base.contains("generativelanguage.googleapis.com")
                {
                    Box::new(crate::providers::GeminiAdapter::new())
                } else {
                    Box::new(crate::providers::OpenAIAdapter)
                };
            let preq = adapter
                .build_request(base_url, api_key, &model, &request_body)
                .map_err(|e| Self::provider_error("API 连通性测试请求构建失败", e))?;

            log_llm_request_audit("TEST_CHAT", &preq.url, &model, &request_body, None);

            let mut request_builder = self.client
                .post(&preq.url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");

            // 添加adapter返回的headers（包括Authorization）
            for (k, v) in preq.headers {
                request_builder = request_builder.header(k, v);
            }

            if let Ok(parsed_url) = Url::parse(base_url) {
                if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                    && parsed_url.host_str().is_some()
                {
                    let origin_val = format!(
                        "{}://{}",
                        parsed_url.scheme(),
                        parsed_url.host_str().unwrap_or_default()
                    );
                    let referer_val = format!(
                        "{}://{}/",
                        parsed_url.scheme(),
                        parsed_url.host_str().unwrap_or_default()
                    );
                    request_builder = request_builder
                        .header("Origin", origin_val)
                        .header("Referer", referer_val);
                }
            }

            // 使用tokio的timeout包装整个请求
            let timeout_duration = std::time::Duration::from_secs(15);
            let request_future = request_builder.json(&preq.body).send();

            // 使用tokio::time::timeout
            match tokio::time::timeout(timeout_duration, request_future).await {
                Ok(Ok(response)) => {
                    let status = response.status();
                    debug!("API连接测试响应状态: {} (模型: {})", status, model);

                    if status.is_success() {
                        // 解析一次，若为 Gemini 则转换为 OpenAI 形状再检查 content
                        match response.json::<serde_json::Value>().await {
                            Ok(resp_json) => {
                                let is_google = lower_model.contains("gemini")
                                    || lower_base.contains("generativelanguage.googleapis.com");
                                let openai_like = if is_google {
                                    crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&resp_json, &model).unwrap_or(resp_json)
                                } else {
                                    resp_json
                                };
                                let _ = openai_like["choices"][0]["message"]["content"]
                                    .as_str()
                                    .unwrap_or("");
                                info!("API连接测试成功！使用模型: {}", model);
                                return Ok(true);
                            }
                            Err(e) => {
                                warn!("API连接测试解析失败: {}", e);
                                return Ok(false);
                            }
                        }
                    } else if status == 400 {
                        // 400错误可能是模型不支持，尝试下一个
                        let error_text = response.text().await.unwrap_or_default();
                        warn!("模型 {} 不支持，错误: {}", model, error_text);
                        debug!("请求URL: {}", preq.url);
                        debug!(
                            "请求体: {}",
                            serde_json::to_string_pretty(&preq.body).unwrap_or_default()
                        );
                        // 如果是用户指定的模型，直接返回失败并提供详细错误
                        if model_name.is_some() {
                            return Err(AppError::validation(format!(
                                "API请求失败 (状态码: 400):\n请求URL: {}\n错误响应: {}\n可能原因: 模型不支持或参数错误",
                                preq.url, error_text
                            )));
                        }
                        continue;
                    } else if status == 401 {
                        // 401是认证错误，不需要尝试其他模型
                        let error_text = response.text().await.unwrap_or_default();
                        error!("API密钥认证失败: {}", status);
                        debug!("请求URL: {}", preq.url);
                        debug!("认证错误详情: {}", error_text);
                        return Err(AppError::validation(format!(
                            "API认证失败 (状态码: 401):\n请求URL: {}\n错误响应: {}\n请检查API密钥是否正确",
                            preq.url, error_text
                        )));
                    } else {
                        // 其他错误
                        let error_text = response.text().await.unwrap_or_default();
                        error!("API请求失败: {} - {}", status, error_text);
                        debug!("请求URL: {}", preq.url);
                        debug!(
                            "请求体: {}",
                            serde_json::to_string_pretty(&preq.body).unwrap_or_default()
                        );
                        // 如果是用户指定的模型，直接返回失败并提供详细错误
                        if model_name.is_some() {
                            return Err(AppError::validation(format!(
                                "API请求失败 (状态码: {}):\n请求URL: {}\n错误响应: {}",
                                status, preq.url, error_text
                            )));
                        }
                        continue;
                    }
                }
                Ok(Err(e)) => {
                    error!("API连接测试请求错误 (模型: {}): {}", model, e);
                    // 如果是连接错误，不需要尝试其他模型
                    if e.to_string().contains("handshake") || e.to_string().contains("connect") {
                        return Err(AppError::network(format!("连接失败: {}", e)));
                    }
                    // 如果是用户指定的模型，直接返回失败
                    if model_name.is_some() {
                        return Err(AppError::network(format!("请求失败: {}", e)));
                    }
                    continue;
                }
                Err(_) => {
                    warn!("API连接测试超时 (模型: {})", model);
                    // 如果是用户指定的模型，直接返回失败
                    if model_name.is_some() {
                        return Err(AppError::network("请求超时"));
                    }
                    continue;
                }
            }
        }

        warn!("所有测试模型都失败了");
        Ok(false)
    }

    // === 无系统提示的简化模型二调用 ===
    /// 直接使用用户提供的 prompt，不附加任何系统提示，适用于严格格式输出的任务（如批量分支选择 / 精确标签映射）。
    pub async fn call_model2_raw_prompt(
        &self,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
    ) -> Result<StandardModel2Output> {
        let config = self.get_model2_config().await?;
        self.call_raw_prompt_with_config(config, user_prompt, image_payloads)
            .await
    }

    /// 使用记忆决策模型调用（回退链：memory_decision_model → model2）
    pub async fn call_memory_decision_raw_prompt(
        &self,
        user_prompt: &str,
    ) -> Result<StandardModel2Output> {
        let config = self.get_memory_decision_model_config().await?;
        self.call_raw_prompt_with_config(config, user_prompt, None)
            .await
    }

    /// 使用标题/标签生成模型调用（回退链：chat_title_model → model2）
    pub async fn call_chat_title_raw_prompt(
        &self,
        user_prompt: &str,
    ) -> Result<StandardModel2Output> {
        let config = self.get_chat_title_model_config().await?;
        self.call_raw_prompt_with_config(config, user_prompt, None)
            .await
    }

    /// 内部方法：使用显式传入的 ApiConfig 执行 raw prompt 调用
    async fn call_raw_prompt_with_config(
        &self,
        config: ApiConfig,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
    ) -> Result<StandardModel2Output> {
        // 构造最简消息，仅包含用户指令
        let mut content_parts = vec![json!({
            "type": "text",
            "text": user_prompt
        })];

        let requested_image_count = image_payloads.as_ref().map(|v| v.len()).unwrap_or(0);
        let mut attached_payloads: Vec<ImagePayload> = Vec::new();

        if let Some(images) = image_payloads {
            if config.is_multimodal {
                for payload in images {
                    content_parts.push(json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!(
                                "data:{};base64,{}",
                                payload.mime.as_str(),
                                payload.base64.as_str()
                            )
                        }
                    }));
                    attached_payloads.push(payload);
                }
            } else if !images.is_empty() {
                warn!(
                    "当前模型({})未标记为多模态，忽略 {} 张图片",
                    config.model,
                    images.len()
                );
            }
        }

        let messages = vec![json!({
            "role": "user",
            "content": content_parts
        })];

        // 3. 组装请求体
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
            "temperature": config.temperature
        });

        // `max_total_tokens` 作为兼容字段保留给 Gemini 适配器；同时针对不同模型类型传递官方推荐的上限参数。
        // 应用供应商级别的 max_tokens 限制
        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit);
        request_body["max_total_tokens"] = json!(max_tokens);
        if config.is_reasoning {
            request_body["max_completion_tokens"] = json!(max_tokens);
        } else {
            request_body["max_tokens"] = json!(max_tokens);
        }

        Self::apply_reasoning_config(&mut request_body, &config, None);

        // 如果是 OpenAI GPT 模型，启用 JSON strict 模式
        if config.model.starts_with("gpt-") {
            request_body["response_format"] = json!({"type": "json_object"});
        }

        debug!(
            "[RAW_PROMPT] 发送简化请求到: {} (经适配器) | 请求图片数: {} | 实际附加: {} | prompt字符数: {}",
            config.base_url,
            requested_image_count,
            attached_payloads.len(),
            user_prompt.chars().count()
        );
        for (idx, payload) in attached_payloads.iter().enumerate().take(3) {
            debug!(
                "[RAW_PROMPT_DEBUG] image[{}]: mime={}, base64_length={}",
                idx,
                payload.mime.as_str(),
                payload.base64.len()
            );
        }

        // 4. 通过 ProviderAdapter 构造 HTTP 请求
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("RAW prompt 请求构建失败", e))?;

        log_llm_request_audit(
            "RAW_PROMPT",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let mut request_builder = self.client
            .post(&preq.url)
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        // 设置 Origin/Referer 头（与其它调用保持一致）
        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        // 5. 发送请求
        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("RAW_PROMPT API请求失败: {}", e)))?;

        // 6. 检查响应状态
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "RAW_PROMPT API请求失败: {} - {}",
                status, error_text
            )));
        }

        // 7. 解析响应
        let response_json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析RAW_PROMPT响应失败: {}", e)))?;

        // Gemini 非流式响应统一转换为 OpenAI 形状
        let openai_like_json = if config.model_adapter == "google" {
            if let Some(safety_msg) = Self::extract_gemini_safety_error(&response_json) {
                return Err(AppError::llm(safety_msg));
            }
            match crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&response_json, &config.model) {
                Ok(v) => v,
                Err(e) => return Err(AppError::llm(format!("Gemini响应转换失败: {}", e))),
            }
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else {
            response_json.clone()
        };

        let assistant_message = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(StandardModel2Output {
            assistant_message,
            raw_response: Some(openai_like_json.to_string()),
            chain_of_thought_details: None,
            cancelled: false,
        })
    }

    /// 使用 OCR 模型调用，适用于多模态索引的 OCR 任务
    pub async fn call_ocr_model_raw_prompt(
        &self,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
    ) -> Result<StandardModel2Output> {
        // 1. 获取 OCR 模型配置及其有效引擎，确保适配器与实际模型一致
        let (config, effective_engine) = self.get_ocr_config_with_effective_engine().await?;
        let ocr_adapter = crate::ocr_adapters::OcrAdapterFactory::create(effective_engine);
        let ocr_mode = crate::ocr_adapters::OcrMode::FreeOcr;
        let prompt_text = ocr_adapter.build_custom_prompt(user_prompt, ocr_mode);

        // 2. 构造消息（⚠️ DeepSeek-OCR 要求：图片在前、文本在后）
        let mut content_parts: Vec<serde_json::Value> = Vec::new();

        let requested_image_count = image_payloads.as_ref().map(|v| v.len()).unwrap_or(0);
        let mut attached_payloads: Vec<ImagePayload> = Vec::new();

        // 先添加图片（必须在文本之前）
        if let Some(images) = image_payloads {
            if config.is_multimodal {
                for payload in images {
                    content_parts.push(json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!(
                                "data:{};base64,{}",
                                payload.mime.as_str(),
                                payload.base64.as_str()
                            ),
                            "detail": if ocr_adapter.requires_high_detail() { "high" } else { "low" }
                        }
                    }));
                    attached_payloads.push(payload);
                }
            } else if !images.is_empty() {
                warn!(
                    "OCR模型({})未标记为多模态，忽略 {} 张图片",
                    config.model,
                    images.len()
                );
            }
        }

        // 再添加文本 prompt
        content_parts.push(json!({
            "type": "text",
            "text": prompt_text
        }));

        let messages = vec![json!({
            "role": "user",
            "content": content_parts
        })];

        // 3. 组装请求体
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
            "temperature": ocr_adapter.recommended_temperature()  // OCR 任务使用确定性输出
        });

        // OCR 任务：先应用供应商限制，再应用 OCR 专用的 [2048, 8000] 范围
        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
            .min(ocr_adapter.recommended_max_tokens(ocr_mode))
            .max(2048)
            .min(8000);
        request_body["max_tokens"] = json!(max_tokens);

        if let Some(extra) = ocr_adapter.get_extra_request_params() {
            if let Some(obj) = request_body.as_object_mut() {
                if let Some(extra_obj) = extra.as_object() {
                    for (k, v) in extra_obj {
                        obj.insert(k.to_string(), v.clone());
                    }
                } else {
                    obj.insert("extra_params".to_string(), extra);
                }
            }
        }

        if let Some(repetition_penalty) = ocr_adapter.recommended_repetition_penalty() {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("repetition_penalty".to_string(), json!(repetition_penalty));
            }
        }

        // GLM-4.5+ 支持 thinking 参数；OCR 任务默认关闭以降低延迟
        if crate::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static(
            &config.model,
        ) {
            let enable = self.is_ocr_thinking_enabled();
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert(
                    "thinking".to_string(),
                    json!({ "type": if enable { "enabled" } else { "disabled" } }),
                );
            }
        }

        debug!(
            "[OCR_MODEL_RAW_PROMPT] 发送请求到: {} | 模型: {} | 请求图片数: {} | 实际附加: {} | prompt字符数: {}",
            config.base_url,
            config.model,
            requested_image_count,
            attached_payloads.len(),
            user_prompt.chars().count()
        );

        // 4. 通过 ProviderAdapter 构造 HTTP 请求
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("OCR RAW prompt 请求构建失败", e))?;

        log_llm_request_audit(
            "OCR_RAW",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let mut request_builder = self
            .client
            .post(&preq.url)
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity");

        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        // 5. 发送请求
        let response = request_builder
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("OCR_MODEL API请求失败: {}", e)))?;

        // 6. 检查响应状态
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "OCR_MODEL API请求失败: {} - {}",
                status, error_text
            )));
        }

        // 7. 解析响应
        let response_json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析OCR_MODEL响应失败: {}", e)))?;

        // Gemini 非流式响应统一转换为 OpenAI 形状
        let openai_like_json = if config.model_adapter == "google" {
            if let Some(safety_msg) = Self::extract_gemini_safety_error(&response_json) {
                return Err(AppError::llm(safety_msg));
            }
            match crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&response_json, &config.model) {
                Ok(v) => v,
                Err(e) => return Err(AppError::llm(format!("Gemini响应转换失败: {}", e))),
            }
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else {
            response_json.clone()
        };

        let assistant_message = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(StandardModel2Output {
            assistant_message,
            raw_response: Some(openai_like_json.to_string()),
            chain_of_thought_details: None,
            cancelled: false,
        })
    }

    /// 单张图片转 Markdown 文本（复用 DeepSeek-OCR 配置）
    /// 翻译场景使用 Free OCR 模式，无需输出坐标（题目集识别使用 grounding 模式）
    ///
    /// ⚠️ DEPRECATED: 所有调用者已迁移到 `call_ocr_free_text_with_fallback`（带 fallback + 超时 + 熔断）。
    /// 本方法保留仅供兼容，新代码请勿使用。
    #[allow(dead_code)]
    pub async fn convert_image_to_markdown(&self, image_path: &str) -> Result<String> {
        let config = self.get_exam_segmentation_model_config().await?;
        let api_key = self.decrypt_api_key_if_needed(&config.api_key)?;

        let mime = Self::infer_image_mime(image_path);
        let (data_url, _) = self
            .prepare_segmentation_image_data(image_path, mime)
            .await?;

        let prompt_text = "Free OCR.";
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url, "detail": "high" } },
                { "type": "text", "text": prompt_text }
            ]
        })];

        // OCR 任务：先应用供应商限制，再应用 OCR 专用的 [2048, 8000] 范围
        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
            .max(2048)
            .min(8000);
        let request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": max_tokens,
            "stream": false,
        });

        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = adapter
            .build_request(&config.base_url, &api_key, &config.model, &request_body)
            .map_err(|e| Self::provider_error("OCR请求构建失败", e))?;

        log_llm_request_audit(
            "OCR_PAGES",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        let response = self
            .client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::llm(format!("OCR请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "OCR API返回错误 {}: {}",
                status, error_text
            )));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取OCR响应失败: {}", e)))?;

        let response_json: Value = serde_json::from_str(&response_text).map_err(|e| {
            AppError::llm(format!(
                "解析OCR响应JSON失败: {}, 原始内容: {}",
                e, response_text
            ))
        })?;

        response_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("OCR模型返回内容为空"))
            .map(|s| s.to_string())
    }

    /// 从 API 返回的 usage 数据中提取实际 token 数量
    ///
    /// 支持多种格式：
    /// - OpenAI: prompt_tokens, completion_tokens
    /// - Anthropic: input_tokens, output_tokens
    /// - Gemini: promptTokenCount, candidatesTokenCount, thoughtsTokenCount
    ///
    /// 如果 API 没有返回 usage 数据，则使用估算值作为 fallback
    fn extract_usage_tokens(
        usage: &Option<serde_json::Value>,
        fallback_completion_tokens: usize,
        fallback_prompt_tokens: usize,
    ) -> (u32, u32, Option<u32>) {
        if let Some(usage_value) = usage {
            // 提取 prompt_tokens（输入）
            // 如果 API 返回 0 或未返回，尝试从 total_tokens - completion_tokens 推算
            let raw_prompt = usage_value
                .get("prompt_tokens")
                .or_else(|| usage_value.get("input_tokens"))
                .or_else(|| usage_value.get("promptTokenCount"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;

            // 提取 completion_tokens（输出）
            let completion_tokens = usage_value
                .get("completion_tokens")
                .or_else(|| usage_value.get("output_tokens"))
                .or_else(|| usage_value.get("candidatesTokenCount"))
                .and_then(|v| v.as_u64())
                .unwrap_or(fallback_completion_tokens as u64)
                as u32;

            // 如果 prompt_tokens 为 0 但有 total_tokens，尝试推算
            let prompt_tokens = if raw_prompt == 0 {
                let total = usage_value
                    .get("total_tokens")
                    .or_else(|| usage_value.get("totalTokenCount"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                if total > completion_tokens {
                    total - completion_tokens
                } else {
                    fallback_prompt_tokens as u32
                }
            } else {
                raw_prompt
            };

            // 提取 reasoning_tokens（思维链，可选）
            let reasoning_tokens = usage_value
                .get("reasoning_tokens")
                .or_else(|| usage_value.get("thoughtsTokenCount"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);

            debug!(
                "[LLM Usage] 从 API 提取: prompt={}, completion={}, reasoning={:?}",
                prompt_tokens, completion_tokens, reasoning_tokens
            );

            (prompt_tokens, completion_tokens, reasoning_tokens)
        } else {
            // 没有 API usage 数据，使用估算值
            let estimated_prompt = fallback_prompt_tokens as u32;
            debug!(
                "[LLM Usage] API 未返回 usage，使用估算值: prompt={}, completion={}",
                estimated_prompt, fallback_completion_tokens
            );
            (estimated_prompt, fallback_completion_tokens as u32, None)
        }
    }
}
// 获取通用Prompt模板（subject 已废弃）
impl LLMManager {
    pub fn get_subject_prompt(&self, _subject: &str, task_type: &str) -> String {
        // subject 已废弃，直接使用通用提示词
        self.get_fallback_prompt(task_type)
    }

    // 通用提示词
    fn get_fallback_prompt(&self, task_type: &str) -> String {
        match task_type {
            "ocr" | "classification" => {
                "你是一个题目分析专家。请识别图片中的题目文字内容，并分析题目类型和相关知识点标签。\n\n【重要】OCR文本提取要求：\n1. 提取纯文本内容，不要使用LaTeX格式\n2. 数学公式用普通文字描述\n3. 保持文本简洁易读\n4. 避免使用特殊LaTeX命令\n\n请以JSON格式返回结果：{{\"ocr_text\": \"题目文字\", \"tags\": [\"标签1\", \"标签2\"], \"mistake_type\": \"题目类型\"}}".to_string()
            }
            "model2" | "analysis" => {
                "你是一个教学专家。请仔细分析这道错题，提供详细的解题思路和知识点讲解。\n\n【重要】公式格式要求（KaTeX 兼容）:\n1. 行内公式使用 $...$；块级公式使用 $$...$$，分隔符必须成对闭合。\n2. 分数一律使用 \\frac{{分子}}{{分母}}；禁止使用 \\over/\\atop/\\choose。\n3. 根号必须写成 \\sqrt{{...}}，不要省略花括号。\n4. 上下标多字符需加花括号。\n5. 中文/非 ASCII 文本置于 \\text{{...}}。\n6. 仅使用 KaTeX 支持的命令。".to_string()
            }
            "review" => {
                "你是一个学习分析专家。请分析这些错题的共同问题和改进建议。".to_string()
            }
            "consolidated_review" => {
                "你是一个学习分析专家。请对提供的错题进行综合复习分析，包括知识点总结、常见错误模式识别和学习建议。".to_string()
            }
            "chat" => {
                "基于这道题目，请回答学生的问题。\n\n【重要】公式格式要求（KaTeX 兼容）:\n1. 行内 $...$、块级 $$...$$；确保成对闭合。\n2. 分数用 \\frac{{分子}}{{分母}}；禁止 \\over/\\atop/\\choose。\n3. \\sqrt{{...}} 不得省略花括号。\n4. 中文文本放 \\text{{...}}。\n5. 仅用 KaTeX 支持指令。".to_string()
            }
            "anki_generation" => {
                "请根据以下学习内容，生成适合制作Anki卡片的问题和答案对。每张卡片应测试一个单一的概念。请以JSON数组格式返回结果，每个对象必须包含 \"front\" (字符串), \"back\" (字符串), \"tags\" (字符串数组) 三个字段。".to_string()
            }
            _ => {
                "请根据提供的题目信息，详细解答问题。".to_string()
            }
        }
    }

    /// 生成 Anki 卡片 - 核心功能
    pub async fn generate_anki_cards_from_document(
        &self,
        document_content: &str,
        subject_name: &str,
        options: Option<&crate::models::AnkiGenerationOptions>,
    ) -> Result<Vec<crate::models::AnkiCard>> {
        info!(
            "开始生成 Anki 卡片: 科目={}, 文档长度={}",
            subject_name,
            document_content.len()
        );

        // 1. 获取 Anki 制卡模型配置
        let config = self.get_anki_model_config().await?;

        // 2. 获取科目特定的 Anki 制卡 Prompt
        let subject_prompt = self.get_subject_prompt(subject_name, "anki_generation");

        // 3. 构建最终的AI指令
        let final_prompt = format!("{}\n\n文档内容：\n{}", subject_prompt, document_content);

        // 4. 准备AI模型请求（应用供应商级别的 max_tokens 限制）
        let max_tokens = options
            .as_ref()
            .and_then(|opt| opt.max_tokens)
            .map(|v| effective_max_tokens(v, config.max_tokens_limit))
            .unwrap_or_else(|| {
                effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
            });
        let temperature = options
            .as_ref()
            .and_then(|opt| opt.temperature)
            .unwrap_or(0.3);

        let mut request_body = json!({
            "model": config.model,
            "messages": [
                {
                    "role": "user",
                    "content": final_prompt
                }
            ],
            "max_tokens": max_tokens,
            "temperature": temperature
        });

        Self::apply_reasoning_config(&mut request_body, &config, None);

        // 如果支持JSON模式，添加response_format
        if config.model.starts_with("gpt-") {
            request_body["response_format"] = json!({"type": "json_object"});
        }

        debug!("发送 Anki 制卡请求到: {} (经适配器)", config.base_url);

        // 5. 通过 ProviderAdapter 发送HTTP请求（支持 Gemini 中转）
        let adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };
        let preq = adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| Self::provider_error("Anki 制卡请求构建失败", e))?;

        log_llm_request_audit(
            "ANKI_CARD",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let mut request_builder = self.client
            .post(&preq.url)
            .header("Accept", "text/event-stream, application/json, text/plain, */*")
            .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        for (k, v) in preq.headers {
            request_builder = request_builder.header(k, v);
        }

        if let Ok(parsed_url) = Url::parse(&config.base_url) {
            if (parsed_url.scheme() == "http" || parsed_url.scheme() == "https")
                && parsed_url.host_str().is_some()
            {
                let origin_val = format!(
                    "{}://{}",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                let referer_val = format!(
                    "{}://{}/",
                    parsed_url.scheme(),
                    parsed_url.host_str().unwrap_or_default()
                );
                request_builder = request_builder
                    .header("Origin", origin_val)
                    .header("Referer", referer_val);
            }
        }

        let response = request_builder.json(&preq.body).send().await.map_err(|e| {
            let error_msg = if e.to_string().contains("timed out") {
                format!("Anki制卡API请求超时: {}", e)
            } else if e.to_string().contains("connect") {
                format!("无法连接到 Anki 制卡 API 服务器: {}", e)
            } else {
                format!("Anki制卡API请求失败: {}", e)
            };
            AppError::network(error_msg)
        })?;

        // 6. 处理HTTP响应
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "Anki制卡API请求失败: {} - {}",
                status, error_text
            )));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析 Anki 制卡响应失败: {}", e)))?;

        // Gemini 非流式响应统一转换为 OpenAI 形状
        let openai_like_json = if config.model_adapter == "google" {
            // 非流式：先检测安全阻断
            if let Some(safety_msg) = Self::extract_gemini_safety_error(&response_json) {
                return Err(AppError::llm(safety_msg));
            }
            match crate::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai(&response_json, &config.model) {
                Ok(v) => v,
                Err(e) => return Err(AppError::llm(format!("Gemini响应转换失败: {}", e))),
            }
        } else if matches!(config.model_adapter.as_str(), "anthropic" | "claude") {
            crate::providers::convert_anthropic_response_to_openai(&response_json, &config.model)
                .ok_or_else(|| AppError::llm("解析Anthropic响应失败".to_string()))?
        } else {
            response_json.clone()
        };

        // 7. 提取AI生成的内容
        let content_str = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::llm("无法解析 Anki 制卡 API 响应"))?;

        // 隐私保护：仅记录响应长度，不打印原始内容
        debug!("Anki 制卡响应长度: {} 字符", content_str.len());

        // 8. 清理和解析AI返回的JSON数据
        let cleaned_content = self.clean_anki_json_response(content_str)?;
        debug!("清理后的JSON长度: {} 字符", cleaned_content.len());

        // 9. 反序列化为AnkiCard向量（带容错处理）
        let cards: Vec<crate::models::AnkiCard> =
            self.parse_anki_cards_with_fallback(&cleaned_content, content_str)?;

        info!("成功生成 {} 张ANKI卡片", cards.len());
        Ok(cards)
    }

    /// 清理AI返回的ANKI卡片JSON响应
    fn clean_anki_json_response(&self, content: &str) -> Result<String> {
        let mut cleaned = content.trim().to_string();

        // 移除markdown代码块
        cleaned = regex::Regex::new(r"```(?:json)?\s*")
            .unwrap()
            .replace_all(&cleaned, "")
            .to_string();
        cleaned = regex::Regex::new(r"```\s*$")
            .unwrap()
            .replace_all(&cleaned, "")
            .to_string();

        // 移除常见前缀
        let prefixes = [
            "以下是生成的Anki卡片：",
            "Anki卡片：",
            "JSON结果：",
            "卡片数据：",
            "Here are the Anki cards:",
            "Cards:",
            "JSON:",
            "Result:",
        ];

        for prefix in &prefixes {
            if cleaned.starts_with(prefix) {
                cleaned = cleaned
                    .strip_prefix(prefix)
                    .unwrap_or(&cleaned)
                    .trim()
                    .to_string();
                break;
            }
        }

        // 确保是有效的JSON数组格式
        if !cleaned.starts_with('[') {
            // 尝试找到第一个'['
            if let Some(start) = cleaned.find('[') {
                cleaned = cleaned[start..].to_string();
            } else {
                return Err(AppError::llm("无法找到JSON数组开始标记"));
            }
        }

        if !cleaned.ends_with(']') {
            // 尝试找到最后一个']'
            if let Some(end) = cleaned.rfind(']') {
                cleaned = cleaned[..=end].to_string();
            } else {
                return Err(AppError::llm("无法找到JSON数组结束标记"));
            }
        }

        Ok(cleaned)
    }

    /// 解析ANKI卡片JSON，带容错处理（自动补充缺失的images字段和兼容question字段）
    fn parse_anki_cards_with_fallback(
        &self,
        json_str: &str,
        original_content: &str,
    ) -> Result<Vec<crate::models::AnkiCard>> {
        // 尝试将JSON字符串解析为通用的Value数组
        let mut card_values: Vec<Value> = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(e) => {
                // 如果连基本JSON都解析不了，直接返回错误
                return Err(AppError::llm(format!(
                    "解析ANKI卡片JSON失败: {} - 原始内容: {}",
                    e, original_content
                )));
            }
        };

        // 遍历每个卡片对象，进行字段兼容性处理
        for card_value in &mut card_values {
            if let Some(obj) = card_value.as_object_mut() {
                // 兼容 "question" 字段 -> "front"
                if obj.contains_key("question") && !obj.contains_key("front") {
                    if let Some(question_val) = obj.remove("question") {
                        obj.insert("front".to_string(), question_val);
                    }
                }
                // 自动补充缺失的 "images" 字段
                if !obj.contains_key("images") {
                    obj.insert("images".to_string(), json!([]));
                }
            }
        }

        // 将处理过的Value转换回JSON字符串
        let processed_json_str = match serde_json::to_string(&card_values) {
            Ok(s) => s,
            Err(e) => return Err(AppError::llm(format!("重新序列化卡片数据失败: {}", e))),
        };

        // 使用处理过的JSON字符串进行最终的反序列化
        match serde_json::from_str::<Vec<crate::models::AnkiCard>>(&processed_json_str) {
            Ok(cards) => Ok(cards),
            Err(e) => {
                // 如果仍然失败，说明有其他结构问题
                Err(AppError::llm(format!(
                    "最终解析ANKI卡片失败: {} - 处理后JSON: {}",
                    e, processed_json_str
                )))
            }
        }
    }

    fn should_use_openai_responses(&self, config: &ApiConfig) -> bool {
        should_use_openai_responses_for_config(config)
    }
}
