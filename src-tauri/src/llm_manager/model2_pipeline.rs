//! 模型二管线（核心解析/对话）
//!
//! 从 llm_manager.rs 拆分的流式和非流式对话管线

use crate::models::{AppError, ChatMessage, StandardModel2Output, StreamChunk};
use crate::openai_codex::{
    build_codex_request_headers, codex_sse_to_responses_json, prepare_codex_responses_body,
    CodexRequestAuth,
};
use crate::providers::{ProviderAdapter, ProviderRequest};
use crate::reasoning_policy::{
    get_passback_policy, requires_reasoning_passback, should_passback_plain_assistant_reasoning,
    ReasoningPassbackPolicy,
};
use crate::utils::chat_timing;
use futures_util::StreamExt;
use log::{debug, error, info, warn};
use rand::Rng;
use reqwest::header::{
    HeaderName, HeaderValue, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{Emitter, Manager, Window};
use url::Url;
use uuid::Uuid;

use super::{
    build_provider_adapter, is_official_deepseek_config, normalize_nonstream_response_to_openai,
    parser, request_adapter_for_config, routing, should_use_openai_responses_for_config, ApiConfig,
    ImagePayload, LLMManager, MergedChatMessage, Result, AUTH_MODE_OPENAI_CODEX_OAUTH,
};

/// 流式请求的单请求超时上限（秒）
///
/// 🔧 F2 修复：reqwest 0.11 的 `ClientBuilder::timeout(300s)` 覆盖「连接 + 整个响应体下载」，
/// 流式响应总时长超过 300s 会被 reqwest 在半途强制掐断（早于 Pipeline 层的任何超时）。
/// 流式请求改为按请求覆盖到 2 小时（与 chat_v2 Pipeline 的绝对上限对齐），
/// 真正的「挂起」防护由 Pipeline 层空闲超时（600s 无数据）负责。
/// 非流式调用不受影响，仍走客户端默认 300s。
const STREAMING_REQUEST_TIMEOUT_SECS: u64 = 7_200;

/// 流式响应空闲超时（秒）：连接保持但持续无数据到达时主动结束流。
///
/// 🔧 P1-3 修复：此前取消信号只在 `stream.next()` 返回 chunk 后才被检查，
/// 服务端停滞（上游挂起/代理黑洞）时 next() 一直阻塞，用户取消无效且请求
/// 可挂起至 STREAMING_REQUEST_TIMEOUT_SECS（2 小时）。现在流循环用 select
/// 同时等待「数据 / 取消信号 / 轮询计时」，并以本常量作为空闲上限
/// （与 chat_v2 Pipeline 层的 600s 空闲超时对齐，覆盖其余旧调用方）。
const STREAMING_IDLE_TIMEOUT_SECS: u64 = 600;
const CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES: usize = 256 * 1024;
const CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Default)]
struct RequestBudgetTrim {
    removed_messages: usize,
    tokens_before: usize,
    tokens_after: usize,
}

fn effective_request_input_limit(
    config: &ApiConfig,
    override_limit: Option<usize>,
) -> Option<usize> {
    let window = config.context_window.unwrap_or(32_768);
    let requested = if config.max_output_tokens > 0 {
        config.max_output_tokens
    } else {
        8_192
    };
    let max_output = config
        .max_tokens_limit
        .filter(|limit| *limit > 0)
        .map(|limit| requested.min(limit))
        .unwrap_or(requested);
    let provider_limit = Some(window.saturating_sub(max_output) as usize);
    match (override_limit, provider_limit) {
        (Some(override_limit), Some(provider_limit)) => Some(override_limit.min(provider_limit)),
        (Some(limit), None) | (None, Some(limit)) => Some(limit),
        (None, None) => None,
    }
}

fn request_message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn is_pinned_request_message(message: &Value) -> bool {
    if message.get("role").and_then(Value::as_str) == Some("system") {
        return true;
    }
    let text = request_message_text(message);
    text.contains("<compacted_context>")
        || text.contains("<skill_instructions")
        || text.contains("<request_context>")
}

fn removable_request_turns(messages: &[Value]) -> Vec<(usize, usize)> {
    let starts: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            (message.get("role").and_then(Value::as_str) == Some("user")).then_some(index)
        })
        .collect();
    starts
        .iter()
        .enumerate()
        .filter_map(|(position, start)| {
            if is_pinned_request_message(&messages[*start]) {
                return None;
            }
            Some((
                *start,
                starts.get(position + 1).copied().unwrap_or(messages.len()),
            ))
        })
        .collect()
}

fn redact_image_payloads_for_budget(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            if text.trim_start().starts_with("data:image/") {
                *text = "[image payload]".to_string();
                1
            } else {
                0
            }
        }
        Value::Array(items) => items.iter_mut().map(redact_image_payloads_for_budget).sum(),
        Value::Object(object) => {
            let has_inline_image = object
                .get("media_type")
                .or_else(|| object.get("mime_type"))
                .or_else(|| object.get("mimeType"))
                .and_then(Value::as_str)
                .is_some_and(|mime| mime.starts_with("image/"));
            let mut images = 0;
            if has_inline_image {
                if let Some(Value::String(data)) = object.get_mut("data") {
                    if !data.is_empty() {
                        *data = "[image payload]".to_string();
                        images += 1;
                    }
                }
            }
            images
                + object
                    .values_mut()
                    .map(redact_image_payloads_for_budget)
                    .sum::<usize>()
        }
        _ => 0,
    }
}

fn enforce_request_input_budget(
    request_body: &mut Value,
    max_input_tokens: Option<usize>,
) -> Result<RequestBudgetTrim> {
    let Some(max_input_tokens) = max_input_tokens else {
        return Ok(RequestBudgetTrim::default());
    };
    if max_input_tokens == 0 {
        return Err(AppError::llm(
            "model context window leaves no usable input budget",
        ));
    }
    let estimate = |body: &Value| {
        let mut text_only = body.clone();
        let image_count = redact_image_payloads_for_budget(&mut text_only);
        let serialized = text_only.to_string();
        let heuristic = crate::utils::token_budget::estimate_tokens(&serialized);
        let text_floor = serialized.len() / 4;
        // 无统一分辨率元数据时按每张 8K token 做保守预留；关键是不能把
        // Base64 字节逐字符当文本 token，否则普通图片会被虚高数十倍。
        heuristic.max(text_floor) + image_count * 8_192
    };
    let tokens_before = estimate(request_body);
    let mut stats = RequestBudgetTrim {
        tokens_before,
        tokens_after: tokens_before,
        ..Default::default()
    };
    while stats.tokens_after > max_input_tokens {
        let ranges = request_body
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| removable_request_turns(messages))
            .unwrap_or_default();
        if ranges.len() <= 2 {
            break;
        }
        let (start, end) = ranges[0];
        let Some(messages) = request_body
            .get_mut("messages")
            .and_then(Value::as_array_mut)
        else {
            break;
        };
        stats.removed_messages += end.saturating_sub(start);
        messages.drain(start..end);
        stats.tokens_after = estimate(request_body);
    }
    if stats.tokens_after > max_input_tokens {
        return Err(AppError::llm(format!(
            "context budget exceeded after safe trimming: estimated_input_tokens={} limit={} removed_messages={}; reduce the current attachment/tool payload or choose a larger-context model",
            stats.tokens_after, max_input_tokens, stats.removed_messages
        )));
    }
    Ok(stats)
}

fn chat_messages_require_multimodal(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| {
        message
            .image_paths
            .as_ref()
            .is_some_and(|images| !images.is_empty())
            || message
                .image_base64
                .as_ref()
                .is_some_and(|images| !images.is_empty())
            || message.multimodal_content.as_ref().is_some_and(|parts| {
                parts.iter().any(|part| {
                    matches!(part, crate::models::MultimodalContentPart::ImageUrl { .. })
                })
            })
    })
}

async fn await_visual_observation_or_cancel<T, F>(
    cancellation_token: tokio_util::sync::CancellationToken,
    future: F,
) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => Err(AppError::llm("visual observation cancelled")),
        result = future => result,
    }
}

fn ensure_model_accepts_message_modalities(
    config: &ApiConfig,
    messages: &[ChatMessage],
) -> Result<()> {
    if chat_messages_require_multimodal(messages) && !config.is_multimodal {
        return Err(AppError::configuration(format!(
            "当前请求包含图片，但模型配置 {} 不支持多模态输入",
            config.id
        )));
    }
    Ok(())
}

fn provider_stream_failure_message(
    value: &Value,
    requires_explicit_completion: bool,
    is_codex: bool,
) -> String {
    let terminal_reason = value.get("reason").and_then(Value::as_str);
    let detail_reason = value
        .pointer("/details/reason")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/details/code").and_then(Value::as_str));
    let prefix = if is_codex {
        "OpenAI Codex 回复未完整结束"
    } else if requires_explicit_completion {
        "OpenAI Responses 回复未完整结束"
    } else {
        "模型回复未完整结束"
    };

    match detail_reason.or(terminal_reason) {
        Some("max_output_tokens" | "max_tokens") => {
            format!("{prefix}（达到模型输出上限）；已保留已生成内容，可重试或发送“继续”")
        }
        Some("response.cancelled" | "response.canceled" | "cancelled" | "canceled") => {
            format!("{prefix}（上游取消）；已保留已生成内容，可重试")
        }
        Some("content_filter" | "safety") => {
            format!("{prefix}（内容安全策略中止）；已保留已生成内容")
        }
        Some(reason) if reason.starts_with("response.incomplete") => {
            format!("{prefix}；已保留已生成内容，可重试或发送“继续”")
        }
        _ => format!("{prefix}；已保留已生成内容，可重试"),
    }
}

#[derive(Clone, Copy)]
enum ResponsesStreamInterruption {
    IdleTimeout,
    ReadError,
    MissingTerminal,
}

fn responses_stream_interruption_message(
    interruption: ResponsesStreamInterruption,
    is_codex: bool,
) -> String {
    let provider = if is_codex {
        "OpenAI Codex"
    } else {
        "LLM provider"
    };
    match interruption {
        ResponsesStreamInterruption::IdleTimeout => {
            format!("{provider} 回复流长时间无数据，已保留已生成内容，可重试")
        }
        ResponsesStreamInterruption::ReadError => {
            format!("{provider} 回复流读取中断；已保留已生成内容，可重试")
        }
        ResponsesStreamInterruption::MissingTerminal => {
            format!("{provider} 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试")
        }
    }
}

fn validate_stream_termination(
    require_terminal_success: bool,
    terminal_success: bool,
    terminal_failure: Option<&str>,
    is_codex: bool,
) -> Result<()> {
    if let Some(failure) = terminal_failure {
        return Err(AppError::llm(failure));
    }
    if require_terminal_success && !terminal_success {
        return Err(AppError::llm(responses_stream_interruption_message(
            ResponsesStreamInterruption::MissingTerminal,
            is_codex,
        )));
    }
    Ok(())
}

fn process_sse_stream_input(
    buffer: &mut crate::utils::sse_buffer::SseEventBuffer,
    chunk: Option<&[u8]>,
) -> Vec<String> {
    match chunk {
        Some(chunk) => buffer.process_bytes(chunk),
        None => buffer.flush(),
    }
}

#[inline]
fn is_qwen_config(config: &ApiConfig) -> bool {
    config
        .provider_type
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("qwen"))
        .unwrap_or(false)
        || config.model_adapter.eq_ignore_ascii_case("qwen")
}

/// 是否为 function 类型的 web_search 工具定义（本地执行路径，前端注入的
/// `{"type":"function","function":{"name":"web_search",...}}` 或扁平格式）。
#[inline]
fn is_web_search_function_tool(tool: &Value) -> bool {
    let name = tool
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| tool.get("name").and_then(Value::as_str))
        .unwrap_or_default();
    name.trim().trim_start_matches("builtin-") == "web_search"
}

/// DeepSeek 官方 + Responses 协议下启用服务端联网搜索：
/// - 协议必须是 openai_responses（`{"type":"web_search"}` 仅 Responses 支持）
/// - 必须是官方 DeepSeek 端点（模型级门控已在上游保证 v4-flash 系列）
/// - 模型支持工具
/// - 会话未显式关闭 web 搜索（chat_v2 的 `web_search_enabled` 开关）
///
/// 启用后本地 function 版 web_search 会被替换为服务端原生工具，避免双重搜索。
#[inline]
fn server_side_web_search_enabled(
    config: &ApiConfig,
    llm_context: &HashMap<String, Value>,
) -> bool {
    if !config.supports_tools || !should_use_openai_responses_for_config(config) {
        return false;
    }
    if !is_official_deepseek_config(config) {
        return false;
    }
    if llm_context
        .get("web_search_enabled")
        .and_then(|v| v.as_bool())
        == Some(false)
    {
        return false;
    }
    true
}

/// 向请求 tools 数组注入服务端 web_search 原生工具，并移除本地 function 版本。
#[inline]
fn apply_server_side_web_search_tool(tools: &mut Vec<Value>) {
    tools.retain(|tool| !is_web_search_function_tool(tool));
    if !tools
        .iter()
        .any(|tool| tool.get("type").and_then(Value::as_str) == Some("web_search"))
    {
        tools.push(json!({ "type": "web_search" }));
    }
}

/// 把服务端 web_search 载荷转换为前端检索块格式的编号来源列表
/// （与 builtin_retrieval_executor::execute_web 的 emit_end 载荷对齐）。
#[inline]
fn numbered_web_search_sources(payload: &Value) -> Value {
    let sources = payload
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let numbered: Vec<Value> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            json!({
                "index": index + 1,
                "citationTag": format!("[搜索-{}]", index + 1),
                "typeIndex": index + 1,
                "title": source.get("title").cloned().unwrap_or(Value::Null),
                "url": source.get("url").cloned().unwrap_or(Value::Null),
                "snippet": source.get("snippet").cloned().unwrap_or(Value::Null),
                "source_type": "web_search",
            })
        })
        .collect();
    Value::Array(numbered)
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
/// 某些供应商会为请求层 max_tokens 设置上限，超出会返回 400 错误
#[inline]
fn effective_max_tokens(max_output_tokens: u32, max_tokens_limit: Option<u32>) -> u32 {
    let requested = if max_output_tokens > 0 {
        max_output_tokens
    } else {
        8_192
    };
    match max_tokens_limit {
        Some(limit) if limit > 0 => requested.min(limit),
        None | Some(_) => requested,
    }
}

fn is_mimo_config(config: &ApiConfig) -> bool {
    config
        .provider_scope
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("mimo"))
        .unwrap_or(false)
        || config
            .provider_type
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("mimo"))
            .unwrap_or(false)
        || config.model_adapter.eq_ignore_ascii_case("mimo")
        || config.base_url.to_lowercase().contains("xiaomimimo.com")
        || config.model.to_lowercase().starts_with("mimo-v")
}

fn is_mistral_config(config: &ApiConfig) -> bool {
    let model = config.model.to_lowercase();
    let model_slug = model.rsplit('/').next().unwrap_or(&model);
    config
        .provider_scope
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("mistral"))
        || config
            .provider_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("mistral"))
        || config.model_adapter.eq_ignore_ascii_case("mistral")
        || config.base_url.to_lowercase().contains("mistral.ai")
        || model_slug.starts_with("mistral-")
        || model_slug.starts_with("magistral-")
}

fn apply_generation_token_limit(body: &mut Value, config: &ApiConfig, max_tokens: u32) {
    if is_mimo_config(config) {
        body["max_completion_tokens"] = json!(max_tokens);
        if let Some(map) = body.as_object_mut() {
            map.remove("max_tokens");
        }
    } else if is_mistral_config(config) {
        // Mistral Chat Completions（含 Medium 3.5 / Small 4 reasoning）仍使用
        // max_tokens；不能因 is_reasoning=true 套用 OpenAI 的 completion 字段。
        body["max_tokens"] = json!(max_tokens);
        if let Some(map) = body.as_object_mut() {
            map.remove("max_completion_tokens");
        }
    } else if config.is_reasoning {
        body["max_completion_tokens"] = json!(max_tokens);
    } else {
        body["max_tokens"] = json!(max_tokens);
        if let Some(map) = body.as_object_mut() {
            map.remove("max_completion_tokens");
        }
    }
}

fn apply_max_tokens_or_mimo_completion_limit(
    body: &mut Value,
    config: &ApiConfig,
    max_tokens: u32,
) {
    if is_mimo_config(config) {
        body["max_completion_tokens"] = json!(max_tokens);
        if let Some(map) = body.as_object_mut() {
            map.remove("max_tokens");
        }
    } else {
        body["max_tokens"] = json!(max_tokens);
        if let Some(map) = body.as_object_mut() {
            map.remove("max_completion_tokens");
        }
    }
}

fn apply_generation_params(body: &mut Value, config: &ApiConfig) {
    let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit);
    apply_generation_token_limit(body, config, max_tokens);

    if !config.is_reasoning || is_mimo_config(config) {
        body["temperature"] = json!(config.temperature);
        if let Some(top_p) = config.top_p_override {
            body["top_p"] = json!(top_p);
        }
        if let Some(frequency_penalty) = config.frequency_penalty_override {
            body["frequency_penalty"] = json!(frequency_penalty);
        }
        if let Some(presence_penalty) = config.presence_penalty_override {
            body["presence_penalty"] = json!(presence_penalty);
        }
    }
}

fn attach_reasoning_passback_payload(
    assistant_msg: &mut Value,
    config: &ApiConfig,
    thinking: &str,
) {
    match get_passback_policy(config) {
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

fn is_mimo_endpoint(model: &str, base_url: &str) -> bool {
    model.to_lowercase().starts_with("mimo-v") || base_url.to_lowercase().contains("xiaomimimo.com")
}

fn build_test_chat_request_body(model: &str, base_url: &str) -> Value {
    if is_mimo_endpoint(model, base_url) {
        json!({
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "Hi"
                }
            ],
            "max_completion_tokens": 32,
            "temperature": 1.0,
            "thinking": {
                "type": "disabled"
            }
        })
    } else {
        json!({
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "Hi"
                }
            ],
            "max_tokens": 5,
            "temperature": 0.1
        })
    }
}

/// 统一使用 debug_log_service 的 standard 级别脱敏（准确的 base64 大小计算）
pub(crate) fn sanitize_request_body_for_audit(body: &serde_json::Value) -> serde_json::Value {
    let mut sanitized = crate::debug_log_service::sanitize_for_level(
        body,
        crate::debug_log_service::DebugFilterLevel::Standard,
    );
    redact_provider_state_and_data_urls(&mut sanitized);
    redact_user_profile_blocks_in_value(&mut sanitized);
    redact_skill_instruction_blocks_in_value(&mut sanitized);
    sanitized
}

fn redact_provider_state_and_data_urls(value: &mut serde_json::Value) {
    match value {
        Value::String(text) if text.starts_with("data:") && text.contains(";base64,") => {
            let base64_len = text
                .find(',')
                .map(|index| text.len() - index - 1)
                .unwrap_or(0);
            *text = format!(
                "[base64 data: ~{}KB, {} chars]",
                base64_len * 3 / 4 / 1024,
                base64_len
            );
        }
        Value::Array(items) => {
            for item in items {
                redact_provider_state_and_data_urls(item);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if matches!(key.as_str(), "encrypted_content" | "encryptedContent") {
                    *item = Value::String("[REDACTED]".to_string());
                } else {
                    redact_provider_state_and_data_urls(item);
                }
            }
        }
        _ => {}
    }
}

/// 🔒 URL 脱敏：Gemini 等供应商把 API key 放在 query 参数（?key=AIza...），
/// 审计日志/调试落盘/前端事件/错误消息里的 URL 必须先脱敏，否则每次请求都泄漏密钥。
pub(crate) fn sanitize_url_for_log(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let sanitized_query = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) => {
                let kl = k.to_ascii_lowercase();
                let is_sensitive = matches!(
                    kl.as_str(),
                    "key" | "api_key" | "apikey" | "api-key" | "token" | "access_token" | "secret"
                );
                if is_sensitive {
                    format!("{}=[REDACTED]", k)
                } else {
                    pair.to_string()
                }
            }
            None => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{}?{}", base, sanitized_query)
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

fn redact_skill_instruction_blocks_in_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            *s = redact_skill_instruction_blocks_in_text(s);
        }
        serde_json::Value::Array(items) => {
            for v in items {
                redact_skill_instruction_blocks_in_value(v);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map {
                redact_skill_instruction_blocks_in_value(v);
            }
        }
        _ => {}
    }
}

fn redact_skill_instruction_blocks_in_text(text: &str) -> String {
    const START_PREFIX: &str = "<skill_instructions";
    const TAG_END: &str = ">";
    const END: &str = "</skill_instructions>";
    if !text.contains(START_PREFIX) {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(start_idx) = rest.find(START_PREFIX) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start_idx]);

        let after_start = &rest[start_idx..];
        let Some(start_tag_end_rel) = after_start.find(TAG_END) else {
            out.push_str("[REDACTED:skill_instructions]");
            break;
        };
        let start_tag = &after_start[..start_tag_end_rel + TAG_END.len()];
        let after_tag = &after_start[start_tag_end_rel + TAG_END.len()..];

        if let Some(end_rel) = after_tag.find(END) {
            out.push_str(start_tag);
            out.push_str("[REDACTED]");
            out.push_str(END);
            rest = &after_tag[end_rel + END.len()..];
        } else {
            out.push_str("[REDACTED:skill_instructions]");
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_manager::ApiConfig;
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response};
    use serde_json::json;
    use std::convert::Infallible;

    struct DropNotice(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for DropNotice {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    fn message_with_modal_fields(
        image_paths: Option<Vec<String>>,
        image_base64: Option<Vec<String>>,
        multimodal_content: Option<Vec<crate::models::MultimodalContentPart>>,
    ) -> ChatMessage {
        serde_json::from_value(json!({
            "role": "user",
            "content": "question",
            "timestamp": chrono::Utc::now(),
            "image_paths": image_paths,
            "image_base64": image_base64,
            "multimodal_content": multimodal_content,
        }))
        .expect("valid chat message")
    }

    #[test]
    fn modality_detection_covers_all_supported_image_fields() {
        let text = message_with_modal_fields(None, None, None);
        assert!(!chat_messages_require_multimodal(&[text]));

        let path = message_with_modal_fields(Some(vec!["image.png".to_string()]), None, None);
        assert!(chat_messages_require_multimodal(&[path]));

        let base64 = message_with_modal_fields(None, Some(vec!["bytes".to_string()]), None);
        assert!(chat_messages_require_multimodal(&[base64]));

        let interleaved = message_with_modal_fields(
            None,
            None,
            Some(vec![crate::models::MultimodalContentPart::image(
                "image/png",
                "bytes",
            )]),
        );
        assert!(chat_messages_require_multimodal(&[interleaved]));
    }

    #[tokio::test]
    async fn visual_observation_cancellation_drops_the_provider_future() {
        let cancellation = tokio_util::sync::CancellationToken::new();
        let cancellation_for_task = cancellation.clone();
        let (drop_tx, drop_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            await_visual_observation_or_cancel(cancellation_for_task, async move {
                let _drop_notice = DropNotice(Some(drop_tx));
                std::future::pending::<Result<()>>().await
            })
            .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        let error = task.await.unwrap().expect_err("cancellation must win");
        assert!(error.message.contains("cancelled"));
        tokio::time::timeout(std::time::Duration::from_millis(100), drop_rx)
            .await
            .expect("provider future must be dropped")
            .expect("drop signal sender must complete");
    }

    #[test]
    fn test_redact_user_profile_blocks_in_text() {
        let input = "A<user_profile>\nsecret\n</user_profile>B";
        let redacted = redact_user_profile_blocks_in_text(input);
        assert!(redacted.contains("<user_profile>[REDACTED]</user_profile>"));
        assert!(!redacted.contains("secret"));
    }

    #[test]
    fn chat_v2_run_scope_recovers_session_and_generation() {
        let event = format!(
            "chat_v2_event_sess_123_var_variant_456_run_deadbeef{}73",
            crate::llm_manager::CHAT_V2_STREAM_GENERATION_MARKER
        );
        assert_eq!(
            chat_v2_session_scope_and_generation(&event),
            Some(("sess_123", Some(73)))
        );
        assert_eq!(
            chat_v2_session_scope_and_generation("chat_v2_event_legacy_session"),
            Some(("legacy_session", None))
        );
        assert!(chat_v2_session_scope_and_generation("other_event").is_none());
    }

    #[test]
    fn test_sanitize_url_for_log_redacts_query_keys() {
        // Gemini 风格：key 在 query
        let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse&key=AIzaSySECRET123";
        let sanitized = sanitize_url_for_log(url);
        assert!(!sanitized.contains("AIzaSySECRET123"));
        assert!(sanitized.contains("key=[REDACTED]"));
        assert!(sanitized.contains("alt=sse"));

        // 无 query 的 URL 原样返回
        let plain = "https://api.openai.com/v1/chat/completions";
        assert_eq!(sanitize_url_for_log(plain), plain);

        // 大小写与变体参数名
        let mixed = "https://x.example/api?API_KEY=abc&access_token=tok&foo=bar";
        let s = sanitize_url_for_log(mixed);
        assert!(!s.contains("API_KEY=abc"));
        assert!(!s.contains("access_token=tok"));
        assert!(s.contains("API_KEY=[REDACTED]"));
        assert!(s.contains("access_token=[REDACTED]"));
        assert!(s.contains("foo=bar"));
    }

    #[test]
    fn responses_eof_without_trailing_newline_keeps_terminal_events() {
        use crate::providers::{OpenAIResponsesAdapter, StreamEvent};

        let mut buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        let terminal = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{",
            "\"output\":[",
            "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"opaque\",\"summary\":[]},",
            "{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}",
            "],\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}"
        );

        assert!(process_sse_stream_input(&mut buffer, Some(terminal.as_bytes())).is_empty());
        let blocks = process_sse_stream_input(&mut buffer, None);
        assert_eq!(blocks.len(), 1);

        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter.parse_stream(&blocks[0]);
        assert!(events
            .iter()
            .any(|event| matches!(event, StreamEvent::ResponseReasoningItem(item) if item["id"] == json!("rs_1"))));
        assert!(events
            .iter()
            .any(|event| matches!(event, StreamEvent::ToolCall(call) if call["function"]["name"] == json!("lookup"))));
        assert!(events.iter().any(
            |event| matches!(event, StreamEvent::Usage(usage) if usage["input_tokens"] == json!(1))
        ));
        assert!(matches!(events.last(), Some(StreamEvent::Done)));
    }

    #[test]
    fn codex_stream_requires_an_explicit_terminal_success() {
        let error = validate_stream_termination(true, false, None, true)
            .expect_err("Codex EOF without a terminal event must fail");
        assert!(error.to_string().contains("OpenAI Codex"));
        assert!(error.to_string().contains("未收到完整结束标记"));

        validate_stream_termination(true, true, None, true)
            .expect("an explicit terminal success should pass");
    }

    #[test]
    fn openai_responses_api_key_stream_requires_an_explicit_terminal_success() {
        let error = validate_stream_termination(true, false, None, false)
            .expect_err("Responses EOF without a terminal event must fail");
        assert!(error.to_string().contains("OpenAI Responses"));
        assert!(!error.to_string().contains("OpenAI Codex"));
    }

    #[test]
    fn provider_incomplete_reason_takes_precedence_over_terminal_success() {
        let message = provider_stream_failure_message(
            &json!({
                "type": "provider_error",
                "reason": "response.incomplete",
                "details": { "reason": "max_output_tokens" }
            }),
            true,
            true,
        );
        assert!(message.contains("输出上限"));
        assert!(message.contains("继续"));

        let error = validate_stream_termination(true, true, Some(&message), true)
            .expect_err("a provider failure must not be hidden by Done");
        assert!(error.to_string().contains("输出上限"));
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
    fn test_sanitize_request_body_for_audit_redacts_skill_instructions() {
        let body = json!({
            "messages": [
                {
                    "role": "user",
                    "content": "prefix <skill_instructions id=\"secret-skill\">private skill text</skill_instructions> suffix"
                }
            ]
        });
        let sanitized = sanitize_request_body_for_audit(&body);
        let content = sanitized["messages"][0]["content"]
            .as_str()
            .unwrap_or_default();
        assert!(content
            .contains("<skill_instructions id=\"secret-skill\">[REDACTED]</skill_instructions>"));
        assert!(!content.contains("private skill text"));
    }

    #[test]
    fn audit_sanitizer_redacts_responses_images_and_encrypted_reasoning() {
        let body = json!({
            "input": [{
                "role": "user",
                "content": [{"type": "input_image", "image_url": "data:image/png;base64,c2VjcmV0"}]
            }],
            "include": ["reasoning.encrypted_content"],
            "encrypted_content": "provider-secret-state"
        });

        let sanitized = sanitize_request_body_for_audit(&body).to_string();
        assert!(!sanitized.contains("c2VjcmV0"));
        assert!(!sanitized.contains("provider-secret-state"));
        assert!(sanitized.contains("base64 data"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn test_should_use_openai_responses_for_declared_openai_compatible_responses_support() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            model: "gpt-4o-mini".to_string(),
            supports_openai_responses: Some(true),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(should_use_openai_responses_for_config(&config));
        assert!(build_provider_adapter(&config).requires_explicit_stream_completion());
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

    #[test]
    fn test_explicit_openai_responses_protocol_overrides_legacy_heuristics() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            api_protocol: Some("openai_responses".to_string()),
            model: "gpt-4o-mini".to_string(),
            provider_type: Some("openai".to_string()),
            base_url: "https://api.openai.com/v1".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(should_use_openai_responses_for_config(&config));
        assert!(build_provider_adapter(&config).requires_explicit_stream_completion());
    }

    #[test]
    fn codex_oauth_transport_requires_explicit_auth_mode() {
        let mut config = ApiConfig {
            provider_type: Some("openai_codex".to_string()),
            auth_mode: Some(AUTH_MODE_OPENAI_CODEX_OAUTH.to_string()),
            api_protocol: Some("openai_responses".to_string()),
            base_url: "https://chatgpt.com/backend-api/codex".to_string(),
            model: "gpt-5.4".to_string(),
            ..Default::default()
        };

        assert!(LLMManager::is_openai_codex_oauth(&config));
        assert!(should_use_openai_responses_for_config(&config));

        config.auth_mode = None;
        assert!(!LLMManager::is_openai_codex_oauth(&config));
    }

    #[test]
    fn configured_headers_reach_prepared_request_without_overriding_transport_headers() {
        let mut configured = HashMap::new();
        configured.insert("X-Proxy-Group".to_string(), "codex-pool".to_string());
        configured.insert("authorization".to_string(), "Bearer wrong".to_string());
        configured.insert("CONTENT-TYPE".to_string(), "text/plain".to_string());
        configured.insert("bad header".to_string(), "ignored".to_string());

        let mut prepared = PreparedProviderRequest::from_provider(ProviderRequest {
            url: "https://proxy.example.com/v1/responses".to_string(),
            headers: vec![
                (
                    "Authorization".to_string(),
                    "Bearer adapter-key".to_string(),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: json!({}),
        });
        merge_configured_provider_headers(&mut prepared, Some(&configured));

        let header = |name: &str| {
            prepared
                .headers
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(header("x-proxy-group"), Some("codex-pool"));
        assert_eq!(header("authorization"), Some("Bearer adapter-key"));
        assert_eq!(header("content-type"), Some("application/json"));
        assert!(header("bad header").is_none());
    }

    #[tokio::test]
    async fn codex_transport_bridges_sse_and_maps_usage_limit_404() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(|_| async {
                Ok::<_, Infallible>(service_fn(|request: Request<Body>| async move {
                    let response = match request.uri().path() {
                        "/sse" => Response::builder()
                            .status(200)
                            .header("content-type", "text/event-stream; charset=utf-8")
                            .body(Body::from(concat!(
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\",\"output\":[],\"usage\":{\"total_tokens\":7}}}\n\n",
                            )))
                            .unwrap(),
                        "/limit" => Response::builder()
                            .status(404)
                            .header("content-type", "application/json")
                            .body(Body::from(
                                r#"{"error":{"code":"usage_limit_reached","message":"quota exhausted"}}"#,
                            ))
                            .unwrap(),
                        "/oversized" => Response::builder()
                            .status(400)
                            .body(Body::from("123456789"))
                            .unwrap(),
                        _ => Response::builder()
                            .status(404)
                            .body(Body::from(r#"{"error":{"code":"not_found"}}"#))
                            .unwrap(),
                    };
                    Ok::<_, Infallible>(response)
                }))
            }));
        let server_task = tokio::spawn(server);
        let client = reqwest::Client::new();

        let response = client
            .get(format!("http://{address}/sse"))
            .send()
            .await
            .unwrap();
        let bridged = bridge_codex_nonstream_response(response).await.unwrap();
        assert_eq!(
            bridged.headers()[CONTENT_TYPE],
            "application/json; charset=utf-8"
        );
        let bridged: Value = bridged.json().await.unwrap();
        assert_eq!(bridged["id"], "resp_fixture");
        assert_eq!(bridged["output"][0]["content"][0]["text"], "fixture");
        assert_eq!(bridged["usage"]["total_tokens"], 7);

        let response = client
            .get(format!("http://{address}/limit"))
            .send()
            .await
            .unwrap();
        let mapped = normalize_codex_error_response(response).await.unwrap();
        assert_eq!(mapped.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
        let mapped_body = mapped.text().await.unwrap();
        assert!(mapped_body.contains("usage_limit_reached"));
        assert!(!mapped_body.contains("quota exhausted"));

        let response = client
            .get(format!("http://{address}/missing"))
            .send()
            .await
            .unwrap();
        let untouched = normalize_codex_error_response(response).await.unwrap();
        assert_eq!(untouched.status(), reqwest::StatusCode::NOT_FOUND);

        let response = client
            .get(format!("http://{address}/oversized"))
            .send()
            .await
            .unwrap();
        assert!(read_codex_response_body_limited(response, 8, "测试响应")
            .await
            .is_err());
        server_task.abort();
    }

    #[test]
    fn test_explicit_openai_responses_protocol_is_downgraded_for_third_party_openai_compatible_endpoint(
    ) {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            api_protocol: Some("openai_responses".to_string()),
            provider_type: Some("openai".to_string()),
            base_url: "https://api.qsl.fan/v1".to_string(),
            model: "deepseek-v4-pro".to_string(),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        };

        assert!(!should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_explicit_chat_completions_protocol_blocks_responses_for_reasoning_models() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            api_protocol: Some("openai_chat_completions".to_string()),
            model: "o4-mini".to_string(),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        };

        assert!(!should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_official_openai_defaults_to_responses_without_explicit_protocol() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            provider_type: Some("openai".to_string()),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_official_deepseek_v4_flash_defaults_to_responses() {
        for model in ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"] {
            let config = ApiConfig {
                model_adapter: "deepseek".to_string(),
                provider_type: Some("deepseek".to_string()),
                base_url: "https://api.deepseek.com/v1".to_string(),
                model: model.to_string(),
                supports_reasoning: true,
                is_reasoning: true,
                ..Default::default()
            };

            assert!(
                should_use_openai_responses_for_config(&config),
                "model={model} should default to Responses"
            );
            assert!(build_provider_adapter(&config).requires_explicit_stream_completion());
        }
    }

    #[test]
    fn test_official_deepseek_v4_pro_and_v3_stay_on_chat_completions_even_with_explicit_responses()
    {
        for model in ["deepseek-v4-pro", "deepseek-v3.2", "deepseek-v3.1"] {
            let config = ApiConfig {
                model_adapter: "deepseek".to_string(),
                provider_type: Some("deepseek".to_string()),
                api_protocol: Some("openai_responses".to_string()),
                base_url: "https://api.deepseek.com/v1".to_string(),
                model: model.to_string(),
                supports_reasoning: true,
                is_reasoning: true,
                ..Default::default()
            };

            assert!(
                !should_use_openai_responses_for_config(&config),
                "model={model} must stay on chat completions"
            );
            // 传输端点必须落在 /chat/completions（而不是 /responses）
            let request = build_provider_adapter(&config)
                .build_request(
                    &config.base_url,
                    "test-key",
                    &config.model,
                    &json!({"messages": []}),
                )
                .expect("request should build");
            assert!(
                request.url.contains("/chat/completions"),
                "model={model} request url: {}",
                request.url
            );
        }
    }

    #[test]
    fn test_third_party_deepseek_v4_flash_hosting_keeps_registry_default() {
        // SiliconFlow 等第三方托管的 deepseek-v4-flash 无 Responses 端点，
        // 即使模型名可支持也不应切到 Responses。
        let config = ApiConfig {
            model_adapter: "deepseek".to_string(),
            provider_type: Some("siliconflow".to_string()),
            provider_scope: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            model: "deepseek-ai/DeepSeek-V4-Flash".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            ..Default::default()
        };

        assert!(!should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn server_side_web_search_injection_only_for_official_deepseek_responses() {
        let base = ApiConfig {
            model_adapter: "deepseek".to_string(),
            provider_type: Some("deepseek".to_string()),
            base_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-v4-flash".to_string(),
            supports_tools: true,
            supports_reasoning: true,
            is_reasoning: true,
            ..Default::default()
        };
        let enabled_context: HashMap<String, Value> = HashMap::new();

        assert!(server_side_web_search_enabled(&base, &enabled_context));

        // 会话显式关闭 web 搜索 → 不注入
        let mut disabled_context = enabled_context.clone();
        disabled_context.insert("web_search_enabled".to_string(), json!(false));
        assert!(!server_side_web_search_enabled(&base, &disabled_context));

        // chat completions 协议 → 不注入
        let mut chat_config = base.clone();
        chat_config.api_protocol = Some("openai_chat_completions".to_string());
        assert!(!server_side_web_search_enabled(
            &chat_config,
            &enabled_context
        ));

        // 非官方托管（SiliconFlow）→ 不注入
        let mut third_party = base.clone();
        third_party.provider_type = Some("siliconflow".to_string());
        third_party.provider_scope = Some("siliconflow".to_string());
        third_party.base_url = "https://api.siliconflow.cn/v1".to_string();
        assert!(!server_side_web_search_enabled(
            &third_party,
            &enabled_context
        ));

        // 模型不支持工具 → 不注入
        let mut no_tools = base.clone();
        no_tools.supports_tools = false;
        assert!(!server_side_web_search_enabled(&no_tools, &enabled_context));
    }

    #[test]
    fn server_side_web_search_tool_replaces_local_function_tool() {
        let mut tools = vec![
            json!({ "type": "function", "function": { "name": "web_search", "parameters": {} } }),
            json!({ "type": "function", "function": { "name": "builtin-web_search", "parameters": {} } }),
            json!({ "type": "function", "function": { "name": "rag_search", "parameters": {} } }),
        ];
        apply_server_side_web_search_tool(&mut tools);

        let types: Vec<&str> = tools
            .iter()
            .map(|tool| tool["type"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(types, vec!["function", "web_search"]);
        assert_eq!(tools[1], json!({ "type": "web_search" }));
        assert_eq!(tools[0]["function"]["name"], json!("rag_search"));

        // 幂等：已有原生工具时不重复追加
        apply_server_side_web_search_tool(&mut tools);
        assert_eq!(
            tools
                .iter()
                .filter(|tool| tool.get("type").and_then(Value::as_str) == Some("web_search"))
                .count(),
            1
        );
    }

    #[test]
    fn numbered_web_search_sources_aligns_with_retrieval_block_schema() {
        let payload = json!({
            "id": "ws_1",
            "stage": "completed",
            "sources": [
                { "title": "Alpha", "url": "https://a.example.com", "snippet": "snippet A" },
                { "title": "Beta", "url": "https://b.example.com" }
            ]
        });
        let numbered = numbered_web_search_sources(&payload);
        assert_eq!(numbered[0]["index"], json!(1));
        assert_eq!(numbered[0]["citationTag"], json!("[搜索-1]"));
        assert_eq!(numbered[0]["typeIndex"], json!(1));
        assert_eq!(numbered[0]["source_type"], json!("web_search"));
        assert_eq!(numbered[0]["url"], json!("https://a.example.com"));
        assert_eq!(numbered[1]["index"], json!(2));
        assert_eq!(numbered[1]["citationTag"], json!("[搜索-2]"));
    }

    #[test]
    fn test_third_party_declared_responses_support_defaults_to_responses_without_explicit_protocol()
    {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            provider_type: Some("custom".to_string()),
            base_url: "https://proxy.example.com/v1".to_string(),
            supports_openai_responses: Some(true),
            model: "gpt-4o-mini".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_generic_third_party_gpt4_stays_on_chat_completions_without_explicit_protocol() {
        let config = ApiConfig {
            model_adapter: "general".to_string(),
            provider_type: Some("custom".to_string()),
            base_url: "https://proxy.example.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(!should_use_openai_responses_for_config(&config));
    }

    #[test]
    fn test_deepseek_tool_passback_preserves_empty_reasoning_content() {
        let config = ApiConfig {
            provider_type: Some("deepseek".to_string()),
            model_adapter: "deepseek".to_string(),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            ..Default::default()
        };
        let mut assistant_msg = json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_empty_reasoning",
                "type": "function",
                "function": {
                    "name": "builtin_test",
                    "arguments": "{}"
                }
            }]
        });

        attach_reasoning_passback_payload(&mut assistant_msg, &config, "");

        assert_eq!(assistant_msg.get("reasoning_content"), Some(&json!("")));
    }

    #[test]
    fn test_runtime_reasoning_overrides_replace_saved_profile_depth() {
        let mut config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            thinking_budget: Some(8192),
            ..Default::default()
        };

        apply_runtime_reasoning_overrides(
            &mut config,
            Some(true),
            Some("max".to_string()),
            Some(32768),
        );

        assert_eq!(config.reasoning_effort.as_deref(), Some("max"));
        assert_eq!(config.thinking_budget, Some(32768));
        assert_eq!(config.enable_thinking, Some(true));
    }

    #[test]
    fn test_runtime_reasoning_disable_clears_saved_and_stale_depth() {
        let mut config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            thinking_budget: Some(8192),
            ..Default::default()
        };

        apply_runtime_reasoning_overrides(
            &mut config,
            Some(false),
            Some("max".to_string()),
            Some(32768),
        );

        assert_eq!(config.enable_thinking, Some(false));
        assert_eq!(config.reasoning_effort, None);
        assert_eq!(config.thinking_budget, None);
    }

    #[test]
    fn test_runtime_reasoning_disable_uses_none_for_openai_protocols() {
        for (provider_type, api_protocol) in [
            ("custom", "openai_chat_completions"),
            ("azure", "openai_responses"),
        ] {
            let mut config = ApiConfig {
                provider_type: Some(provider_type.to_string()),
                api_protocol: Some(api_protocol.to_string()),
                model_adapter: "general".to_string(),
                model: "gpt-5.5".to_string(),
                supports_reasoning: true,
                is_reasoning: true,
                reasoning_effort: Some("high".to_string()),
                thinking_budget: Some(8192),
                ..Default::default()
            };

            apply_runtime_reasoning_overrides(&mut config, Some(false), None, None);

            assert_eq!(config.enable_thinking, Some(false));
            assert_eq!(config.reasoning_effort.as_deref(), Some("none"));
            assert_eq!(config.thinking_budget, None);

            let mut body = json!({"temperature": 0.7, "top_p": 0.9});
            LLMManager::apply_reasoning_config(&mut body, &config, Some(false));
            assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
            assert!(body.get("enable_thinking").is_none());
        }
    }

    #[test]
    fn test_runtime_reasoning_disable_is_ignored_for_forced_openai_models() {
        for (provider_type, model) in [
            ("openai_codex", "gpt-5.5"),
            ("openai", "gpt-5-pro"),
            ("custom", "gpt-5"),
            ("custom", "gpt-oss-120b"),
        ] {
            let mut config = ApiConfig {
                provider_type: Some(provider_type.to_string()),
                api_protocol: Some("openai_responses".to_string()),
                model: model.to_string(),
                reasoning_effort: Some("high".to_string()),
                thinking_budget: Some(8192),
                ..Default::default()
            };

            apply_runtime_reasoning_overrides(&mut config, Some(false), None, None);

            assert_eq!(config.enable_thinking, Some(true), "model={model}");
            assert_eq!(
                config.reasoning_effort.as_deref(),
                Some("high"),
                "model={model}"
            );
            assert_eq!(config.thinking_budget, Some(8192), "model={model}");
        }
    }

    #[test]
    fn test_runtime_reasoning_disable_is_not_forced_by_non_openai_pro_suffix() {
        for (provider_type, api_protocol, model) in [
            ("deepseek", None, "deepseek-v4-pro"),
            ("mimo", Some("openai_chat_completions"), "mimo-v2.5-pro"),
        ] {
            let mut config = ApiConfig {
                provider_type: Some(provider_type.to_string()),
                api_protocol: api_protocol.map(str::to_string),
                model: model.to_string(),
                reasoning_effort: Some("high".to_string()),
                thinking_budget: Some(8192),
                ..Default::default()
            };

            apply_runtime_reasoning_overrides(&mut config, Some(false), None, None);

            assert_eq!(config.enable_thinking, Some(false), "model={model}");
            assert_eq!(config.reasoning_effort, None, "model={model}");
            assert_eq!(config.thinking_budget, None, "model={model}");
        }
    }

    #[test]
    fn mimo_reasoning_generation_params_use_completion_tokens_and_sampling() {
        let config = ApiConfig {
            model: "mimo-v2.5-pro".to_string(),
            provider_type: Some("mimo".to_string()),
            provider_scope: Some("mimo".to_string()),
            model_adapter: "mimo".to_string(),
            is_reasoning: true,
            supports_reasoning: true,
            max_output_tokens: 131_072,
            temperature: 1.0,
            top_p_override: Some(0.95),
            ..Default::default()
        };
        let mut body = json!({
            "model": config.model,
            "messages": [],
            "stream": true
        });

        apply_generation_params(&mut body, &config);

        assert_eq!(body.get("max_completion_tokens"), Some(&json!(131_072)));
        assert!(!body.as_object().unwrap().contains_key("max_tokens"));
        assert_eq!(body.get("temperature"), Some(&json!(1.0)));
        let top_p = body.get("top_p").and_then(|value| value.as_f64()).unwrap();
        assert!((top_p - 0.95).abs() < 0.000_001);
    }

    #[test]
    fn non_mimo_reasoning_generation_params_preserve_adapter_max_tokens() {
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            provider_type: Some("moonshot".to_string()),
            provider_scope: Some("moonshot".to_string()),
            model_adapter: "moonshot".to_string(),
            is_reasoning: true,
            max_output_tokens: 4096,
            ..Default::default()
        };
        let mut body = json!({
            "model": config.model,
            "messages": [],
            "max_tokens": 32_000
        });

        apply_generation_params(&mut body, &config);

        assert_eq!(body.get("max_completion_tokens"), Some(&json!(4096)));
        assert_eq!(body.get("max_tokens"), Some(&json!(32_000)));
    }

    #[test]
    fn legacy_max_token_paths_switch_to_completion_tokens_for_mimo_only() {
        let config = ApiConfig {
            model: "mimo-v2.5".to_string(),
            provider_type: Some("mimo".to_string()),
            provider_scope: Some("mimo".to_string()),
            model_adapter: "mimo".to_string(),
            ..Default::default()
        };
        let mut body = json!({
            "model": config.model,
            "messages": [],
            "max_tokens": 8000
        });

        apply_max_tokens_or_mimo_completion_limit(&mut body, &config, 4096);

        assert_eq!(body.get("max_completion_tokens"), Some(&json!(4096)));
        assert!(!body.as_object().unwrap().contains_key("max_tokens"));
    }

    #[test]
    fn mimo_connection_test_body_uses_chat_completions_token_field() {
        let body = build_test_chat_request_body("mimo-v2.5-pro", "https://api.xiaomimimo.com/v1");

        assert_eq!(body.get("max_completion_tokens"), Some(&json!(32)));
        assert!(!body.as_object().unwrap().contains_key("max_tokens"));
        assert_eq!(body.pointer("/thinking/type"), Some(&json!("disabled")));
    }
}

fn apply_runtime_reasoning_overrides(
    config: &mut ApiConfig,
    enable_thinking_override: Option<bool>,
    reasoning_effort_override: Option<String>,
    thinking_budget_override: Option<i32>,
) {
    if enable_thinking_override == Some(false) {
        // Runtime off must win over both profile defaults and stale UI depth values.
        // Sending `disabled` together with a positive effort/budget is ambiguous and
        // several compatible gateways choose the depth field, silently re-enabling reasoning.
        let provider_type = config.provider_type.as_deref().unwrap_or_default();
        let provider_scope = config.provider_scope.as_deref().unwrap_or_default();
        let protocol = config.api_protocol.as_deref().unwrap_or_default();
        let has_explicit_openai_protocol =
            matches!(protocol, "openai_chat_completions" | "openai_responses");
        let is_codex = provider_type.eq_ignore_ascii_case("openai_codex")
            || provider_scope.eq_ignore_ascii_case("openai_codex");
        let model = config.model.to_lowercase();
        let is_openai_o_family = ["o1", "o3", "o4"].iter().any(|family| {
            model == *family
                || model.starts_with(&format!("{family}-"))
                || model.ends_with(&format!("/{family}"))
                || model.contains(&format!("/{family}-"))
        });
        let is_openai_reasoning_model = (model.contains("gpt-5") && !model.contains("gpt-5-chat"))
            || model.contains("codex")
            || model.contains("gpt-oss")
            || is_openai_o_family;
        // Legacy profiles may not persist api_protocol. An empty protocol is only
        // treated as OpenAI-compatible when the provider/model identifies that
        // contract; an arbitrary `-pro` model must not become forced reasoning.
        let is_openai_protocol = has_explicit_openai_protocol
            || (protocol.is_empty() && (is_codex || is_openai_reasoning_model));
        let modern_gpt5_supports_none = [
            "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5", "gpt-5.6",
        ]
        .iter()
        .any(|prefix| model.contains(prefix))
            && !model.contains("-pro")
            && !model.contains("codex")
            && !model.contains("-chat");
        let initial_gpt5 = (model == "gpt-5"
            || model.ends_with("/gpt-5")
            || model.contains("gpt-5-mini")
            || model.contains("gpt-5-nano"))
            && !model.contains("gpt-5.");
        let forced_openai_reasoning = (is_codex || is_openai_reasoning_model)
            && (is_codex
                || model.contains("codex")
                || model.contains("-pro")
                || model.contains("gpt-oss")
                || initial_gpt5
                || is_openai_o_family);

        if is_openai_protocol && forced_openai_reasoning {
            config.enable_thinking = Some(true);
            return;
        }

        config.enable_thinking = Some(false);
        config.reasoning_effort = if is_openai_protocol && modern_gpt5_supports_none {
            Some("none".to_string())
        } else {
            None
        };
        config.thinking_budget = None;
        return;
    }
    if let Some(enable) = enable_thinking_override {
        config.enable_thinking = Some(enable);
    }
    if let Some(effort) = reasoning_effort_override {
        config.reasoning_effort = Some(effort);
    }
    if let Some(budget) = thinking_budget_override {
        config.thinking_budget = Some(budget);
    }
}

/// 输出 debug 级审计日志 + 可选文件持久化（用于无 window 的非流式路径）
pub(crate) fn log_llm_request_audit(
    tag: &str,
    url: &str,
    model: &str,
    body: &serde_json::Value,
    persist_config: Option<&DebugPersistConfig>,
) {
    let sanitized = sanitize_request_body_for_audit(body);
    // 🔒 URL 含 query 密钥（如 Gemini ?key=...）时脱敏后再进日志/落盘
    let url = sanitize_url_for_log(url);
    match serde_json::to_string_pretty(&sanitized) {
        Ok(pretty) => debug!(
            "[LLM_AUDIT:{}] model={} url={}\n{}",
            tag, model, url, pretty
        ),
        Err(e) => warn!(
            "[LLM_AUDIT:{}] model={} url={} (序列化失败: {})",
            tag, model, url, e
        ),
    }

    if let Some(c) = persist_config {
        crate::debug_log_service::write_debug_log_entry(
            &c.log_dir, tag, model, &url, "", &sanitized,
        );
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
/// 1. 输出 debug 级别审计日志（始终 standard 级别）
/// 2. 如果 stream_event 以 `chat_v2_event_` 开头，推送给前端
/// 3. 如果 persist_config 存在（Some），将脱敏请求体写入 JSON 文件
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
    // 🔒 URL 含 query 密钥（如 Gemini ?key=...）时脱敏后再进日志/落盘/前端事件
    let url = sanitize_url_for_log(url);

    // 1. 审计日志（始终 standard 级别，避免泄漏 base64）
    match serde_json::to_string_pretty(&sanitized) {
        Ok(pretty) => debug!(
            "[LLM_AUDIT:{}] model={} url={}\n{}",
            tag, model, url, pretty
        ),
        Err(e) => warn!(
            "[LLM_AUDIT:{}] model={} url={} (序列化失败: {})",
            tag, model, url, e
        ),
    }

    // 2. 文件持久化（脱敏请求体，避免 transient skill instructions 落盘）
    let log_file_path = persist_config
        .and_then(|c| {
            crate::debug_log_service::write_debug_log_entry(
                &c.log_dir,
                tag,
                model,
                &url,
                stream_event,
                &sanitized,
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

/// 🔧 CR-R2-01 修复：`call_raw_prompt_with_config` 的可选项，让
/// compaction / summary 等 Markdown 场景能关掉 GPT 的 `response_format: json_object` 强制。
#[derive(Debug, Clone, Copy)]
pub(crate) struct RawPromptOptions {
    /// gpt-* 模型是否强制 JSON 模式（默认 true，保持旧有 model2 / title 调用的语义）
    pub force_json: bool,
}

impl Default for RawPromptOptions {
    fn default() -> Self {
        Self { force_json: true }
    }
}

struct CodexPreparedAuth {
    auth: CodexRequestAuth,
    session_id: String,
}

pub(crate) struct PreparedProviderRequest {
    pub(crate) url: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Value,
    codex: Option<CodexPreparedAuth>,
}

impl PreparedProviderRequest {
    fn from_provider(request: ProviderRequest) -> Self {
        Self {
            url: request.url,
            headers: request.headers,
            body: request.body,
            codex: None,
        }
    }

    pub(crate) fn is_codex(&self) -> bool {
        self.codex.is_some()
    }
}

fn append_provider_header_if_absent(
    headers: &mut Vec<(String, String)>,
    name: &str,
    value: &str,
    source: &str,
    warn_on_conflict: bool,
) {
    let Ok(parsed_name) = HeaderName::from_bytes(name.as_bytes()) else {
        warn!(
            "[LLM Headers] Ignoring invalid {} header name: {}",
            source, name
        );
        return;
    };
    if HeaderValue::from_str(value).is_err() {
        warn!(
            "[LLM Headers] Ignoring invalid value for {} header: {}",
            source,
            parsed_name.as_str()
        );
        return;
    }

    if headers
        .iter()
        .any(|(existing, _)| existing.eq_ignore_ascii_case(parsed_name.as_str()))
    {
        if warn_on_conflict {
            warn!(
                "[LLM Headers] Ignoring configured {} because the provider transport owns it",
                parsed_name.as_str()
            );
        }
        return;
    }

    headers.push((parsed_name.as_str().to_string(), value.to_string()));
}

fn merge_configured_provider_headers(
    request: &mut PreparedProviderRequest,
    configured_headers: Option<&HashMap<String, String>>,
) {
    let Some(configured_headers) = configured_headers else {
        return;
    };
    for (name, value) in configured_headers {
        // Adapter/OAuth transport headers win case-insensitively. Custom headers
        // are additive, so X-* routing metadata works without replacing auth or MIME.
        append_provider_header_if_absent(
            &mut request.headers,
            name,
            value,
            "vendor-configured",
            true,
        );
    }
}

fn chat_v2_session_scope_and_generation(stream_event: &str) -> Option<(&str, Option<u64>)> {
    let raw_scope = stream_event.strip_prefix("chat_v2_event_")?;
    let (scope_without_generation, stream_generation) =
        match raw_scope.rsplit_once(super::CHAT_V2_STREAM_GENERATION_MARKER) {
            Some((scope, raw_generation)) => {
                let generation = raw_generation.parse::<u64>().ok()?;
                (scope, Some(generation))
            }
            None => (raw_scope, None),
        };
    let session_id = scope_without_generation
        .rsplit_once("_var_")
        .map(|(session, _)| session)
        .unwrap_or(scope_without_generation);
    Some((session_id, stream_generation))
}

fn rebuild_codex_response(
    status: reqwest::StatusCode,
    version: reqwest::Version,
    mut headers: reqwest::header::HeaderMap,
    body: String,
    force_json_content_type: bool,
) -> Result<reqwest::Response> {
    headers.remove(CONTENT_LENGTH);
    headers.remove(CONTENT_ENCODING);
    headers.remove(TRANSFER_ENCODING);
    if force_json_content_type {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }

    let mut builder = hyper::Response::builder().status(status).version(version);
    let response_headers = builder
        .headers_mut()
        .ok_or_else(|| AppError::llm("无法重建 OpenAI Codex 响应头"))?;
    *response_headers = headers;
    let response = builder
        .body(body)
        .map_err(|_| AppError::llm("无法重建 OpenAI Codex 响应"))?;
    Ok(reqwest::Response::from(response))
}

fn is_codex_usage_limit_body(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("usage_limit_reached")
        || lower.contains("usage_not_included")
        || lower.contains("rate_limit_exceeded")
        || lower.contains("usage limit")
}

fn sanitize_codex_error_code(value: &str) -> Option<String> {
    let code: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .take(64)
        .collect();
    (!code.is_empty()).then_some(code)
}

fn codex_error_code(body: &str, status: reqwest::StatusCode) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .or_else(|| value.get("code").and_then(Value::as_str))
                .or_else(|| value.pointer("/detail/code").and_then(Value::as_str))
        })
        .and_then(sanitize_codex_error_code)
        .or_else(|| {
            let lower = body.to_ascii_lowercase();
            [
                "usage_limit_reached",
                "usage_not_included",
                "rate_limit_exceeded",
            ]
            .into_iter()
            .find(|code| lower.contains(code))
            .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| format!("http_{}", status.as_u16()))
}

async fn read_codex_response_body_limited(
    response: reqwest::Response,
    limit: usize,
    context: &'static str,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(AppError::llm(format!("OpenAI Codex {context}超过大小限制")));
    }

    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(limit);
    let mut body = Vec::with_capacity(capacity);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            warn!(
                "[OpenAI Codex OAuth] failed to read {context}: {}",
                error.without_url()
            );
            AppError::llm(format!("读取 OpenAI Codex {context}失败"))
        })?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(AppError::llm(format!("OpenAI Codex {context}超过大小限制")));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn normalize_codex_error_response(response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let body = read_codex_response_body_limited(
        response,
        CODEX_ERROR_RESPONSE_BODY_LIMIT_BYTES,
        "错误响应",
    )
    .await?;
    let body = String::from_utf8_lossy(&body);
    let code = codex_error_code(&body, status);
    let mapped_status =
        if status == reqwest::StatusCode::NOT_FOUND && is_codex_usage_limit_body(&body) {
            reqwest::StatusCode::TOO_MANY_REQUESTS
        } else {
            status
        };
    let safe_body = json!({
        "error": {
            "code": code,
            "message": "OpenAI Codex request failed"
        }
    })
    .to_string();
    rebuild_codex_response(mapped_status, version, headers, safe_body, true)
}

async fn bridge_codex_nonstream_response(response: reqwest::Response) -> Result<reqwest::Response> {
    let is_event_stream = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    if !response.status().is_success() || !is_event_stream {
        return Ok(response);
    }

    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let sse = read_codex_response_body_limited(
        response,
        CODEX_NONSTREAM_SSE_BODY_LIMIT_BYTES,
        "SSE 响应",
    )
    .await?;
    let sse =
        String::from_utf8(sse).map_err(|_| AppError::llm("OpenAI Codex SSE 响应不是有效 UTF-8"))?;
    let canonical = codex_sse_to_responses_json(&sse).map_err(|error| {
        warn!("[OpenAI Codex OAuth] failed to bridge SSE response: {error}");
        AppError::llm("OpenAI Codex 响应流不完整或格式无效")
    })?;
    let body = serde_json::to_string(&canonical)
        .map_err(|_| AppError::llm("无法序列化 OpenAI Codex 响应"))?;
    rebuild_codex_response(status, version, headers, body, true)
}

impl LLMManager {
    fn is_openai_codex_oauth(config: &ApiConfig) -> bool {
        config.auth_mode.as_deref() == Some(AUTH_MODE_OPENAI_CODEX_OAUTH)
    }

    fn codex_error(context: &str, error: impl std::fmt::Display) -> AppError {
        warn!("[OpenAI Codex OAuth] {}: {}", context, error);
        AppError::configuration(format!(
            "OpenAI Codex 登录状态不可用（{}），请在模型设置中重新登录",
            context
        ))
    }

    fn install_codex_headers(
        request: &mut PreparedProviderRequest,
        auth: &CodexRequestAuth,
        session_id: &str,
    ) -> Result<()> {
        let prior_headers = std::mem::take(&mut request.headers);
        let headers = build_codex_request_headers(auth, session_id)
            .map_err(|error| Self::codex_error("构建请求头", error))?;
        request.headers = headers
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
                    .map_err(|_| Self::codex_error("编码请求头", "invalid header value"))
            })
            .collect::<Result<Vec<_>>>()?;
        for (name, value) in prior_headers {
            // OAuth-generated headers retain precedence. Additive custom headers
            // survive both the initial installation and a later 401 refresh.
            append_provider_header_if_absent(
                &mut request.headers,
                &name,
                &value,
                "pre-existing",
                false,
            );
        }
        Ok(())
    }

    pub(crate) async fn prepare_provider_request(
        &self,
        adapter: &dyn ProviderAdapter,
        config: &ApiConfig,
        request_body: &Value,
        api_key_override: Option<&str>,
        session_id: Option<&str>,
        build_error_context: &str,
    ) -> Result<PreparedProviderRequest> {
        let api_key = api_key_override.unwrap_or(config.api_key.as_str());
        let provider_request = adapter
            .build_request(&config.base_url, api_key, &config.model, request_body)
            .map_err(|error| Self::provider_error(build_error_context, error))?;
        let mut prepared = PreparedProviderRequest::from_provider(provider_request);
        merge_configured_provider_headers(&mut prepared, config.headers.as_ref());

        if !Self::is_openai_codex_oauth(config) {
            return Ok(prepared);
        }
        if !should_use_openai_responses_for_config(config) {
            return Err(AppError::configuration(
                "OpenAI Codex OAuth 仅支持 OpenAI Responses 协议",
            ));
        }

        let auth = self
            .openai_codex_auth
            .request_auth(false)
            .await
            .map_err(|error| Self::codex_error("获取访问凭据", error))?;
        let session_id = session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        prepared.url = self.openai_codex_auth.responses_endpoint().to_string();
        prepared.body = prepare_codex_responses_body(&prepared.body)
            .map_err(|error| Self::codex_error("准备 Responses 请求", error))?;
        if let Some(body) = prepared.body.as_object_mut() {
            body.entry("prompt_cache_key".to_string())
                .or_insert_with(|| Value::String(session_id.clone()));
        }
        Self::install_codex_headers(&mut prepared, &auth, &session_id)?;
        prepared.codex = Some(CodexPreparedAuth { auth, session_id });
        Ok(prepared)
    }

    async fn refresh_codex_request_after_unauthorized(
        &self,
        request: &mut PreparedProviderRequest,
    ) -> Result<()> {
        let (generation, session_id) = request
            .codex
            .as_ref()
            .map(|codex| (codex.auth.generation(), codex.session_id.clone()))
            .ok_or_else(|| AppError::configuration("OpenAI Codex 请求缺少 OAuth 上下文"))?;
        let auth = self
            .openai_codex_auth
            .refresh_after_unauthorized(generation)
            .await
            .map_err(|error| Self::codex_error("刷新访问凭据", error))?;
        Self::install_codex_headers(request, &auth, &session_id)?;
        request.codex = Some(CodexPreparedAuth { auth, session_id });
        Ok(())
    }

    pub(crate) async fn send_codex_request_with_single_refresh(
        &self,
        request: &mut PreparedProviderRequest,
        timeout: Option<std::time::Duration>,
    ) -> Result<reqwest::Response> {
        let response = self
            .send_codex_stream_request_with_single_refresh(request, timeout)
            .await?;
        bridge_codex_nonstream_response(response).await
    }

    pub(crate) async fn send_codex_stream_request_with_single_refresh(
        &self,
        request: &mut PreparedProviderRequest,
        timeout: Option<std::time::Duration>,
    ) -> Result<reqwest::Response> {
        debug_assert!(request.is_codex());
        let mut refreshed = false;
        loop {
            let mut builder = self.client.post(&request.url);
            if let Some(timeout) = timeout {
                builder = builder.timeout(timeout);
            }
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            let response = builder.json(&request.body).send().await.map_err(|error| {
                AppError::network(format!("OpenAI Codex 请求失败: {}", error.without_url()))
            })?;
            let response = normalize_codex_error_response(response).await?;

            match response.status().as_u16() {
                401 if !refreshed => {
                    self.refresh_codex_request_after_unauthorized(request)
                        .await?;
                    refreshed = true;
                }
                401 => {
                    let rejected_generation = request
                        .codex
                        .as_ref()
                        .map(|codex| codex.auth.generation())
                        .ok_or_else(|| {
                            AppError::configuration("OpenAI Codex 请求缺少 OAuth 上下文")
                        })?;
                    self.openai_codex_auth
                        .mark_reauthentication_required(rejected_generation)
                        .await;
                    return Err(AppError::configuration(
                        "OpenAI Codex 授权已失效，请在模型设置中重新登录",
                    ));
                }
                403 => return Err(AppError::configuration("OpenAI Codex 账号无权执行此请求")),
                _ => return Ok(response),
            }
        }
    }

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
        let log_root = crate::get_global_app_handle()
            .and_then(|app| app.path().app_log_dir().ok())
            .unwrap_or_else(|| self.file_manager.get_app_data_dir().join("logs"));
        Some(DebugPersistConfig {
            log_dir: crate::debug_log_service::ensure_debug_log_dir(&log_root),
        })
    }

    /// 向前端发送内层 HTTP 重试进度（model2_pipeline 级别的重试）
    ///
    /// 内层重试原来完全静默，前端在等待期间看不到任何状态变化。
    /// 这里复用 `stream_reconnect` 事件通道让前端显示 "reconnect...(N/max)"。
    fn emit_inner_retry_progress(
        window: &Window,
        stream_event: &str,
        message_id: Option<&str>,
        retry_attempt: u32,
        retry_max: u32,
    ) {
        let Some(mid) = message_id else {
            return;
        };

        let Some((session_id, stream_generation)) =
            chat_v2_session_scope_and_generation(stream_event)
        else {
            return;
        };

        let session_channel = format!("chat_v2_session_{}", session_id);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut payload = json!({
            "sessionId": session_id,
            "eventType": "stream_reconnect",
            "messageId": mid,
            "retryAttempt": retry_attempt,
            "retryMax": retry_max,
            "timestamp": now_ms,
        });
        if let Some(generation) = stream_generation {
            payload["streamGeneration"] = json!(generation);
        }
        let _ = window.emit(&session_channel, &payload);
    }

    fn compute_retry_delay(min_delay_ms: u64, max_delay_ms: u64) -> u64 {
        if max_delay_ms <= min_delay_ms {
            return min_delay_ms;
        }
        rand::thread_rng().gen_range(min_delay_ms..=max_delay_ms)
    }

    /// 可取消等待：睡眠期间每 500ms 轮询取消 registry，被取消时返回 true。
    ///
    /// 🔧 P1-3 修复：429/5xx 重试等待期间此前完全不响应取消信号。
    async fn sleep_checking_cancel(&self, stream_event: &str, wait_ms: u64) -> bool {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        loop {
            if self.take_cancellation_if_any(stream_event).await {
                return true;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let remaining = (deadline - now).as_millis() as u64;
            tokio::time::sleep(std::time::Duration::from_millis(remaining.min(500))).await;
        }
    }

    // 统一AI接口层 - 模型二（核心解析/对话）- 流式版本
    //
    // 🆕 Failover 包装层（routing.rs）：模型选择后按策略驱动
    // 「主模型 → 同 provider key 轮换（含冷却）→ fallback 模型」的尝试序列。
    // 流式出口属于对话主链路：用户显式选择的模型（model_override_id）是严格的，
    // 仅当用户开启 auto_degrade_chat 才允许模型级降级；key 轮换不受此限制。
    #[allow(clippy::too_many_arguments)]
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
        max_input_tokens_override: Option<usize>,
        model_override_id: Option<String>,
        temp_override: Option<f32>,
        system_prompt_override: Option<String>,
        top_p_override: Option<f32>,
        frequency_penalty_override: Option<f32>,
        presence_penalty_override: Option<f32>,
        max_output_tokens_override: Option<u32>,
        reasoning_effort_override: Option<String>,
        thinking_budget_override: Option<i32>,
    ) -> Result<StandardModel2Output> {
        info!(
            "调用统一模型二接口(流式): 科目={}, 思维链={}, override_model={:?}",
            subject, enable_chain_of_thought, model_override_id
        );

        // 获取模型配置（支持 override），根据任务上下文路由
        let task_key = match task_context {
            Some(tc) if tc.contains("review") => "review",
            Some(tc) if tc == "tag_generation" => "tag_generation",
            _ => "default",
        };
        let (primary_config, _cot_by_model) = self
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

        // 能力约束来自本次输入，而不是主模型自身能力：纯文本请求可以降级到
        // 文本模型；只有实际携带图片等多模态内容时才强制多模态候选。
        let required_is_multimodal = Some(chat_messages_require_multimodal(chat_history));

        let run = routing::FailoverRun {
            task: task_key.to_string(),
            scenario: routing::FailoverScenario::ChatMain,
            user_pinned: model_override_id.is_some(),
            window: Some(window.clone()),
            // 建立阶段的 429/5xx 退避重试由本函数内部循环完成
            attempts_handle_429_internally: true,
            required_is_multimodal,
            param_overrides: routing::ParamOverrides {
                temperature: temp_override,
                top_p: top_p_override,
                frequency_penalty: frequency_penalty_override,
                presence_penalty: presence_penalty_override,
                max_output_tokens: max_output_tokens_override,
            },
        };
        let result = self
            .run_with_failover(run, primary_config, |mut cfg, establish_retries| {
                // fallback 模型需应用与主模型相同的运行期推理覆盖
                apply_runtime_reasoning_overrides(
                    &mut cfg,
                    Some(enable_thinking),
                    reasoning_effort_override.clone(),
                    thinking_budget_override,
                );
                self.call_unified_model_2_stream_with_config(
                    cfg,
                    establish_retries,
                    context,
                    chat_history,
                    subject,
                    enable_chain_of_thought,
                    enable_thinking,
                    task_context,
                    window.clone(),
                    stream_event,
                    message_id,
                    _trace_id,
                    disable_tools,
                    max_input_tokens_override,
                    system_prompt_override.clone(),
                )
            })
            .await;
        // 单次尝试可能在建连或状态码处理阶段提前返回；统一清理可避免取消
        // sender/registry 在最终失败后滞留。
        self.clear_cancel_artifacts(stream_event).await;
        result
    }

    /// 流式统一出口的单次尝试：用已解析的 config 完成「建立 + 流式读取」。
    ///
    /// 🆕 Failover：模型选择/参数覆盖上移到 `call_unified_model_2_stream` 包装层。
    /// `establish_max_retries` 控制建立阶段（429/5xx）的内部重试次数——
    /// 存在 fallback 候选时收紧为 1，尽快让位给 key 轮换/模型切换；
    /// 流一旦建立，后续中断不做续传（错误不打 establish 标记，不触发 failover）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call_unified_model_2_stream_with_config(
        &self,
        resolved_config: ApiConfig,
        establish_max_retries: u32,
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
        max_input_tokens_override: Option<usize>,
        system_prompt_override: Option<String>,
    ) -> Result<StandardModel2Output> {
        debug!(
            "[model2_stream] 单次尝试: model={}, establish_max_retries={}",
            resolved_config.model, establish_max_retries
        );

        // 记录开始时间和统计信息
        let _start_instant = std::time::Instant::now();
        let mut request_bytes = 0usize;
        let _response_bytes = 0usize;
        let _chunk_count = 0usize;

        let config = resolved_config;
        ensure_model_accepts_message_modalities(&config, chat_history)?;

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
        // 使用 content array 格式以支持 OpenAI/DeepSeek prompt caching
        messages.push(json!({
            "role": "system",
            "content": [
                {"type": "text", "text": system_content, "cache_control": {"type": "ephemeral"}}
            ]
        }));

        // 🔧 P1修复：预处理消息，合并连续的工具调用
        // OpenAI 协议期望：一个 assistant 消息包含 tool_calls 数组，然后跟着多个 tool 消息
        // 当前数据模型每个消息只有一个 tool_call，需要在序列化时合并
        let merged_history = Self::merge_consecutive_tool_calls(&chat_history);

        // 添加聊天历史（逐条处理用户图片与工具调用消息的标准化）
        for merged_msg in merged_history.iter() {
            match merged_msg {
                // 🔧 P1修复：处理合并的工具调用消息
                // 🔧 Anthropic 最佳实践：必须保留 thinking_content
                MergedChatMessage::MergedToolCalls {
                    tool_calls,
                    content,
                    thinking_content,
                    thought_signature,
                    response_reasoning_item,
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

                    // Provider-owned continuation state must travel with the assistant tool call.
                    let inject_provider_state = |msg: &mut Value| {
                        if let Some(ref sig) = thought_signature {
                            msg["thought_signature"] = json!(sig);
                        }
                        if let Some(item) = response_reasoning_item {
                            msg["response_reasoning_item"] = item.clone();
                        }
                    };

                    // 🔧 使用适配器系统处理工具调用消息格式
                    let has_thinking_payload = thinking_content.is_some();
                    let has_non_empty_thinking = thinking_content
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);
                    let adapter = request_adapter_for_config(&config);

                    // 尝试使用适配器的自定义格式
                    let tool_calls_json: Vec<Value> = tool_calls_arr.clone();
                    if has_non_empty_thinking {
                        if let Some(formatted_content) = adapter
                            .format_tool_call_message(&tool_calls_json, thinking_content.as_deref())
                        {
                            let mut msg = json!({
                                "role": "assistant",
                                "content": formatted_content
                            });
                            inject_provider_state(&mut msg);
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
                                attach_reasoning_passback_payload(
                                    &mut assistant_msg,
                                    &config,
                                    thinking,
                                );
                            }

                            inject_provider_state(&mut assistant_msg);
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
                            inject_provider_state(&mut msg);
                            messages.push(msg);

                            debug!(
                                "[LLMManager] Merged {} tool_calls into single assistant message (no custom format)",
                                tool_calls.len()
                            );
                        }
                    } else if has_thinking_payload && requires_reasoning_passback(&config) {
                        let policy = get_passback_policy(&config);
                        let mut assistant_msg = json!({
                            "role": "assistant",
                            "content": content,
                            "tool_calls": tool_calls_arr
                        });

                        if let Some(ref thinking) = thinking_content {
                            attach_reasoning_passback_payload(
                                &mut assistant_msg,
                                &config,
                                thinking,
                            );
                        }

                        inject_provider_state(&mut assistant_msg);
                        messages.push(assistant_msg);

                        debug!(
                            "[LLMManager] Reasoning model: {} tool_calls with empty/present thinking payload (policy={:?})",
                            tool_calls.len(),
                            policy
                        );
                    } else {
                        // 无思维链
                        let mut msg = json!({
                            "role": "assistant",
                            "content": content,
                            "tool_calls": tool_calls_arr
                        });
                        inject_provider_state(&mut msg);
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
                        let adapter = request_adapter_for_config(&config);

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
                        } else if has_thinking && should_passback_plain_assistant_reasoning(&config)
                        {
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

        // 瞬态技能指令必须保持独立 user message，不能与当前用户输入合并。
        let has_transient_skill_messages = chat_history
            .iter()
            .any(crate::chat_v2::pipeline::is_transient_skill_message);
        if !has_transient_skill_messages {
            // 🔧 防御性合并：连续 user 消息合并，避免部分 API（Anthropic/ERNIE）报错
            Self::merge_consecutive_user_messages(&mut messages);
        }

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
            let mut tools = custom_tools.unwrap_or_default();
            // 🆕 DeepSeek 官方 + Responses：替换本地 web_search 为服务端原生工具
            if server_side_web_search_enabled(&config, context) {
                apply_server_side_web_search_tool(&mut tools);
                debug!("[LLM] 注入服务端 web_search 工具（DeepSeek Responses）");
            }
            let tools = Value::Array(tools);
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
            let mut tools = self.build_tools_with_mcp(&window).await;
            // 🆕 DeepSeek 官方 + Responses：替换本地 web_search 为服务端原生工具
            if server_side_web_search_enabled(&config, context) {
                if let Some(tools_array) = tools.as_array_mut() {
                    apply_server_side_web_search_tool(tools_array);
                    debug!("[LLM] 注入服务端 web_search 工具（DeepSeek Responses, legacy 路径）");
                }
            }

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

                    if let Some(last_user_msg) = chat_history.iter().rfind(|m| m.role == "user") {
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

        // 🔧 Prompt-cache 分叉点定位（G7）：CHAT_V2_CACHE_DEBUG=1 时记录
        // messages 指纹。相邻两次请求若指纹相同则前缀未变（应高命中）；
        // 指纹不同则按消息条数/长度逐段 diff 定位"第一个分叉点"——分叉点
        // 之前是缓存命中区，之后全部 miss（下游测量法 §三.2）。
        if std::env::var("CHAT_V2_CACHE_DEBUG")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            use sha2::{Digest, Sha256};
            if let Some(messages_json) = request_body.get("messages") {
                let mut hasher = Sha256::new();
                if let Ok(serialized) = serde_json::to_string(messages_json) {
                    hasher.update(serialized.as_bytes());
                    debug!(
                        "[PromptCache] request fingerprint: model={}, messages={}, sha256={}",
                        config.model,
                        messages.len(),
                        format!("{:x}", hasher.finalize())
                    );
                }
            }
        }

        // 简化：不再在此处估算输入token

        apply_generation_params(&mut request_body, &config);
        let input_limit = effective_request_input_limit(&config, max_input_tokens_override);
        let budget_trim = enforce_request_input_budget(&mut request_body, input_limit)?;
        if budget_trim.removed_messages > 0 {
            warn!(
                "[model2_stream] final input guard removed {} message(s): {} -> {} tokens (limit={:?})",
                budget_trim.removed_messages,
                budget_trim.tokens_before,
                budget_trim.tokens_after,
                input_limit
            );
            let _ = window.emit(
                "chat_v2_context_budget_trimmed",
                json!({
                    "messageId": message_id,
                    "removedMessages": budget_trim.removed_messages,
                    "tokensBefore": budget_trim.tokens_before,
                    "tokensAfter": budget_trim.tokens_after,
                    "limit": input_limit,
                }),
            );
        }
        if !config.is_reasoning && enable_chain_of_thought {
            warn!(
                "前端为非推理模型 {} 请求了思维链。通常这由Prompt控制，而非特定API参数。",
                config.model
            );
        }
        // 审计：瞬态技能消息数量 + 真实 load_skills 调用数量
        {
            let transient_skill_count = chat_history
                .iter()
                .filter(|m| crate::chat_v2::pipeline::is_transient_skill_message(m))
                .count();
            let real_load_skills_call_count = messages
                .iter()
                .filter(|m| {
                    m.get("tool_calls")
                        .and_then(|v| v.as_array())
                        .is_some_and(|tool_calls| {
                            tool_calls.iter().any(|tc| {
                                tc.get("function")
                                    .and_then(|f| f.get("name"))
                                    .and_then(|n| n.as_str())
                                    == Some("load_skills")
                            })
                        })
                })
                .count();
            if transient_skill_count > 0 || real_load_skills_call_count > 0 {
                info!(
                    "[LLM_AUDIT] 请求体包含 {} 条瞬态技能消息，{} 次真实 load_skills 调用（总消息数: {}）",
                    transient_skill_count,
                    real_load_skills_call_count,
                    messages.len()
                );
            }
        }

        // 输出脱敏请求体用于调试（隐藏图片与 transient skill instructions）
        let debug_body = sanitize_request_body_for_audit(&request_body);
        debug!("[LLM_REVIEW_DEBUG] ==> 脱敏请求体开始 <==");
        debug!(
            "{}",
            serde_json::to_string_pretty(&debug_body).unwrap_or_default()
        );
        debug!("[LLM_REVIEW_DEBUG] ==> 脱敏请求体结束 <==");

        // 记录请求体大小与起始时间（简化）
        let request_json_str = serde_json::to_string(&request_body).unwrap_or_default();
        let request_bytes = request_json_str.len();
        let start_instant = std::time::Instant::now();

        let request_id = Uuid::new_v4().to_string();
        // 在建连前注册取消通道；若取消发生在注册前，registry 会在这里接住。
        let cancel_rx = self.register_cancel_channel(stream_event).await;
        if self.take_cancellation_if_any(stream_event).await {
            self.clear_cancel_channel(stream_event).await;
            return Err(AppError::llm("请求已被用户取消"));
        }
        let codex_session_id = chat_v2_session_scope_and_generation(stream_event)
            .map(|(session_id, _)| session_id)
            .or(message_id)
            .unwrap_or(request_id.as_str());

        // 工具与 thinking 互斥必须在 provider request 构建前处理；发送后再改
        // request_body 不会影响线上请求。
        if request_body.get("tools").is_some() {
            let request_adapter = request_adapter_for_config(&config);
            if request_body.as_object().is_some_and(|body| {
                request_adapter.should_disable_thinking_for_tools(&config, body)
            }) {
                remove_thinking_fields_for_tool_compat(&mut request_body);
                debug!(
                    "[LLMManager] Adapter {} disabled thinking for tool calls",
                    request_adapter.id()
                );
            }
        }

        // Provider 适配：构建请求
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);
        // The actual adapter is authoritative. This covers OpenAI API keys and
        // compatible gateways explicitly configured for the Responses protocol,
        // not only the Codex OAuth transport.
        let require_terminal_success = adapter.requires_explicit_stream_completion();
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                None,
                Some(codex_session_id),
                "对话请求构建失败",
            )
            .await?;
        let is_codex = preq.is_codex();

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
        // 🆕 Failover：重试上限由包装层传入（无 fallback 候选时保持旧值 5，
        // 有候选时收紧为 1，尽快让位给 key 轮换/模型切换）
        let max_retries = establish_max_retries;
        const MIN_RETRY_DELAY_MS: u64 = 4000;
        const MAX_RETRY_DELAY_MS: u64 = 5000;
        let mut retry_count = 0u32;
        let mut codex_unauthorized_refreshed = false;

        let response = loop {
            // 每次重试都需要重新构建 request_builder（因为 send() 会消耗它）
            let mut request_builder = self
                .client
                .post(&preq.url)
                // 🔧 F2 修复：流式请求覆盖客户端默认 300s 总超时（见 STREAMING_REQUEST_TIMEOUT_SECS 注释）
                .timeout(std::time::Duration::from_secs(
                    STREAMING_REQUEST_TIMEOUT_SECS,
                ));
            if !preq.is_codex() {
                request_builder = request_builder
                    .header("Accept", "text/event-stream, application/json, text/plain, */*")
                    .header("Accept-Encoding", "identity")
                    .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            }
            for (k, v) in &preq.headers {
                request_builder = request_builder.header(k.clone(), v.clone());
            }
            if !preq.is_codex() {
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
            }

            let mut establish_cancel_rx = cancel_rx.clone();
            let send_result = tokio::select! {
                response = request_builder.json(&preq.body).send() => response,
                changed = establish_cancel_rx.changed() => {
                    if changed.is_ok() && *establish_cancel_rx.borrow() {
                        let _ = window.emit(
                            &format!("{}_cancelled", stream_event),
                            &json!({
                                "id": request_id,
                                "reason": "user_cancelled_during_connect"
                            }),
                        );
                        self.clear_cancel_channel(stream_event).await;
                        return Err(AppError::llm("请求已被用户取消"));
                    }
                    continue;
                }
            };
            let resp = match send_result {
                Ok(response) => response,
                Err(error) if retry_count < max_retries => {
                    retry_count += 1;
                    let wait_ms = Self::compute_retry_delay(MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
                    warn!(
                        "[模型二API] 建连失败，等待 {}ms 后重试 ({}/{}): {}",
                        wait_ms,
                        retry_count,
                        max_retries,
                        error.without_url()
                    );
                    Self::emit_inner_retry_progress(
                        &window,
                        stream_event,
                        message_id,
                        retry_count,
                        max_retries,
                    );
                    if self.sleep_checking_cancel(stream_event, wait_ms).await {
                        return Err(AppError::llm("请求已被用户取消"));
                    }
                    continue;
                }
                Err(error) => {
                    return Err(routing::tag_establish_failure(
                        AppError::network(format!("模型二API请求失败: {}", error.without_url())),
                        None,
                    ));
                }
            };
            let resp = if preq.is_codex() {
                normalize_codex_error_response(resp).await?
            } else {
                resp
            };

            if resp.status().is_success() {
                break resp;
            }

            let status = resp.status();
            let status_code = status.as_u16();

            match status_code {
                401 if preq.is_codex() && !codex_unauthorized_refreshed => {
                    self.refresh_codex_request_after_unauthorized(&mut preq)
                        .await?;
                    codex_unauthorized_refreshed = true;
                    continue;
                }
                401 if preq.is_codex() => {
                    let rejected_generation = preq
                        .codex
                        .as_ref()
                        .map(|codex| codex.auth.generation())
                        .ok_or_else(|| {
                            AppError::configuration("OpenAI Codex 请求缺少 OAuth 上下文")
                        })?;
                    self.openai_codex_auth
                        .mark_reauthentication_required(rejected_generation)
                        .await;
                    return Err(AppError::configuration(
                        "OpenAI Codex 授权已失效，请在模型设置中重新登录",
                    ));
                }
                403 if preq.is_codex() => {
                    return Err(AppError::configuration("OpenAI Codex 账号无权执行此请求"));
                }
                // 429 Rate Limit：使用指数退避重试
                429 => {
                    // 尝试解析 Retry-After 头
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());

                    // 🔧 Retry-After clamp 到 120s：防止异常服务端返回超大值导致管线长时间 sleep
                    let wait_ms = retry_after.map(|s| s.min(120) * 1000).unwrap_or_else(|| {
                        Self::compute_retry_delay(MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS)
                    });

                    if retry_count < max_retries {
                        retry_count += 1;
                        warn!(
                            "[模型二API] 遇到速率限制(429)，等待 {}ms 后重试 ({}/{})",
                            wait_ms, retry_count, max_retries
                        );
                        Self::emit_inner_retry_progress(
                            &window,
                            stream_event,
                            message_id,
                            retry_count,
                            max_retries,
                        );
                        if self.sleep_checking_cancel(stream_event, wait_ms).await {
                            info!("[模型二API] 429 重试等待期间收到取消信号，中止请求");
                            return Err(AppError::llm("请求已被用户取消"));
                        }
                        continue;
                    } else {
                        let error_text = resp.text().await.unwrap_or_default();
                        let error_msg = format!(
                            "模型二API请求失败: 速率限制(429)，已重试{}次仍失败 - {}",
                            max_retries, error_text
                        );
                        error!("{}", error_msg);
                        // 🆕 打标：429 → key 进冷却并轮换，耗尽后按策略切换 fallback 模型
                        return Err(routing::tag_establish_failure(
                            AppError::llm(error_msg),
                            Some(429),
                        ));
                    }
                }
                // 401 明确表示凭据无效；仅在此情况下轮换 key。
                401 => {
                    let error_text = resp.text().await.unwrap_or_default();
                    let error_msg = format!(
                        "模型二API认证失败: API Key 无效或已过期 (HTTP 401) - {}",
                        error_text
                    );
                    error!("{}", error_msg);
                    // 🆕 打标：鉴权失败只允许同 provider 内换 key，不允许换模型
                    return Err(routing::tag_establish_failure(
                        AppError::configuration(error_msg),
                        Some(status_code),
                    ));
                }
                // 403 通常是模型/组织/地区/策略权限，不能默认归因于 key 失效。
                403 => {
                    let error_text = resp.text().await.unwrap_or_default();
                    let error_msg = format!("模型二API访问被拒绝 (HTTP 403) - {}", error_text);
                    error!("{}", error_msg);
                    return Err(routing::tag_establish_failure(
                        AppError::llm(error_msg),
                        Some(status_code),
                    ));
                }
                // 5xx 服务端错误：可重试
                500..=599 => {
                    if retry_count < max_retries {
                        retry_count += 1;
                        let wait_ms =
                            Self::compute_retry_delay(MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
                        warn!(
                            "[模型二API] 服务端错误({})，等待 {}ms 后重试 ({}/{})",
                            status_code, wait_ms, retry_count, max_retries
                        );
                        Self::emit_inner_retry_progress(
                            &window,
                            stream_event,
                            message_id,
                            retry_count,
                            max_retries,
                        );
                        if self.sleep_checking_cancel(stream_event, wait_ms).await {
                            info!("[模型二API] 5xx 重试等待期间收到取消信号，中止请求");
                            return Err(AppError::llm("请求已被用户取消"));
                        }
                        continue;
                    } else {
                        let error_text = resp.text().await.unwrap_or_default();
                        let error_msg = format!(
                            "模型二API服务端错误: HTTP {} - 已重试{}次仍失败 - {}",
                            status_code, max_retries, error_text
                        );
                        error!("{}", error_msg);
                        // 🆕 打标：5xx → 可重试瞬态错误，允许 key 轮换与模型降级
                        return Err(routing::tag_establish_failure(
                            AppError::llm(error_msg),
                            Some(status_code),
                        ));
                    }
                }
                // 其他错误：直接返回
                _ => {
                    let error_text = resp.text().await.unwrap_or_default();
                    let error_msg =
                        format!("模型二API请求失败: HTTP {} - {}", status_code, error_text);
                    error!("模型二API请求失败: {}", error_msg);
                    // 🆕 打标：400/404 等参数类错误 → 不可重试，立即失败
                    return Err(routing::tag_establish_failure(
                        AppError::llm(error_msg),
                        Some(status_code),
                    ));
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
        let mut terminal_success = false;
        let mut terminal_failure: Option<String> = None;
        // 按完整 SSE 事件缓冲，保留 event: + data: 关联并安全处理跨 chunk UTF-8。
        let mut sse_buffer = crate::utils::sse_buffer::SseEventBuffer::new();
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
        // start 已在 HTTP 建连前发送；此处仅补发稳定的 request id。
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
        // 用量日志：开始（复用全局记录器，由周期任务可靠刷盘）
        if let Some(logger) = crate::debug_logger::get_global_logger() {
            logger
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
        // 🔧 P1-3 修复：select 同时等待「数据 / 取消信号 / 轮询计时」，
        // 流停滞时取消可即时生效，空闲超过 STREAMING_IDLE_TIMEOUT_SECS 主动结束流
        let idle_timeout = std::time::Duration::from_secs(STREAMING_IDLE_TIMEOUT_SECS);
        let mut last_activity = tokio::time::Instant::now();
        let mut cancel_rx_wait = cancel_rx.clone();
        // sender 被清理后 changed() 立即返回 Err，用标志关闭该分支避免 busy loop
        let mut cancel_channel_open = true;
        loop {
            enum StreamWait<T> {
                Chunk(T),
                Ended,
                CancelSignal,
                Tick,
            }
            let waited = tokio::select! {
                biased;
                changed = cancel_rx_wait.changed(), if cancel_channel_open => {
                    match changed {
                        Ok(()) => {
                            if *cancel_rx_wait.borrow() {
                                StreamWait::CancelSignal
                            } else {
                                StreamWait::Tick
                            }
                        }
                        Err(_) => {
                            cancel_channel_open = false;
                            StreamWait::Tick
                        }
                    }
                }
                item = stream.next() => match item {
                    Some(r) => StreamWait::Chunk(r),
                    None => StreamWait::Ended,
                },
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => StreamWait::Tick,
            };

            let (maybe_chunk, upstream_ended) = match waited {
                // Route EOF through the same event dispatch as ordinary chunks.
                // The empty chunk only supplies the already-inferred stream item type;
                // buffered bytes are drained with `flush` in the Ok branch below.
                StreamWait::Ended => (Some(Ok(Default::default())), true),
                StreamWait::Chunk(r) => {
                    last_activity = tokio::time::Instant::now();
                    (Some(r), false)
                }
                StreamWait::CancelSignal => (None, false),
                StreamWait::Tick => {
                    if last_activity.elapsed() >= idle_timeout {
                        warn!(
                            "{}[Stream Loop] 空闲超时（{}s 无数据），主动结束流: {}",
                            chat_timing::format_elapsed_prefix(stream_event),
                            STREAMING_IDLE_TIMEOUT_SECS,
                            stream_event
                        );
                        terminal_failure = Some(responses_stream_interruption_message(
                            ResponsesStreamInterruption::IdleTimeout,
                            is_codex,
                        ));
                        break;
                    }
                    (None, false)
                }
            };

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
            // 非数据轮次（取消信号已在上方处理 / Tick 未超时）继续等待
            let Some(chunk_result) = maybe_chunk else {
                continue;
            };
            match chunk_result {
                Ok(chunk) => {
                    let complete_blocks = if upstream_ended {
                        process_sse_stream_input(&mut sse_buffer, None)
                    } else {
                        response_bytes += chunk.len();
                        process_sse_stream_input(&mut sse_buffer, Some(chunk.as_ref()))
                    };
                    for line in complete_blocks {
                        // 使用适配器解析流事件（包括[DONE]标记）
                        let events = adapter.parse_stream(&line);

                        // 检查是否是结束标记（保留为后备机制）
                        if crate::utils::sse_buffer::SseEventBuffer::check_done_marker(&line) {
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
                                terminal_success = true;
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
                                crate::providers::StreamEvent::ResponseReasoningItem(item) => {
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_response_reasoning_item(&item);
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
                                        let maybe_id = tool_call_value
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .map(|v| v.trim())
                                            .filter(|v| !v.is_empty());
                                        let maybe_name = tool_call_value
                                            .get("function")
                                            .and_then(|f| f.get("name"))
                                            .and_then(|n| n.as_str())
                                            .map(|v| v.trim())
                                            .filter(|v| !v.is_empty());
                                        if let Some(id) = maybe_id {
                                            // 这是一个新的工具调用的开始（有完整的id）
                                            let name = maybe_name.unwrap_or("unknown");
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
                                        } else if let Some((id, mut name, mut accumulated_args)) =
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
                                                if name == "unknown" {
                                                    if let Some(better_name) = maybe_name {
                                                        name = better_name.to_string();
                                                    }
                                                }
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
                                        } else if let Some(name) = maybe_name {
                                            let args = tool_call_value
                                                .get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .map(|a| {
                                                    if let Some(s) = a.as_str() {
                                                        s.to_string()
                                                    } else if a.is_null() {
                                                        String::new()
                                                    } else {
                                                        serde_json::to_string(a).unwrap_or_default()
                                                    }
                                                })
                                                .unwrap_or_default();
                                            let synthetic_id = format!("stream_call_{}", index);
                                            pending_tool_calls.insert(
                                                index,
                                                (synthetic_id.clone(), name.to_string(), args),
                                            );
                                            if let Some(h) = self.get_hook(stream_event).await {
                                                h.on_tool_call_start(&synthetic_id, name);
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
                                crate::providers::StreamEvent::WebSearchCall(payload) => {
                                    // 🆕 服务端联网搜索（DeepSeek Responses web_search 工具）：
                                    // - 转发给 hook（chat_v2 适配器 → web_search 块事件 + 来源收集）
                                    // - 同时发射 legacy 兼容事件 {stream_event}_web_search
                                    if let Some(h) = self.get_hook(stream_event).await {
                                        h.on_web_search(&payload);
                                    }
                                    let stage = payload
                                        .get("stage")
                                        .and_then(Value::as_str)
                                        .unwrap_or("completed");
                                    let search_payload = json!({
                                        "sources": numbered_web_search_sources(&payload),
                                        "stage": stage,
                                        "tool_name": "web_search",
                                    });
                                    if let Err(e) = window.emit(
                                        &format!("{}_web_search", stream_event),
                                        &search_payload,
                                    ) {
                                        warn!("发送服务端 web_search 事件失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::SafetyBlocked(safety_info) => {
                                    terminal_failure = Some(provider_stream_failure_message(
                                        &safety_info,
                                        require_terminal_success,
                                        is_codex,
                                    ));
                                    stream_ended = true;
                                    // emit safety_blocked 事件
                                    if let Err(e) = window.emit(
                                        &format!("{}_safety_blocked", stream_event),
                                        &safety_info,
                                    ) {
                                        error!("发送安全阻断事件失败: {}", e);
                                    }
                                    // 同时发送通用错误事件
                                    // 🔧 区分供应商错误（provider_error）与安全阻断，避免
                                    // 把配额不足/参数错误等误报为"安全策略阻断"
                                    let is_provider_error =
                                        safety_info.get("type").and_then(|v| v.as_str())
                                            == Some("provider_error");
                                    let error_event = if is_provider_error {
                                        json!({
                                            "type": "provider_error",
                                            "message": "LLM provider reported a stream failure",
                                            "details": safety_info
                                        })
                                    } else {
                                        json!({
                                            "type": "safety_error",
                                            "message": "Request blocked due to safety policies",
                                            "details": safety_info
                                        })
                                    };
                                    if let Err(e) = window
                                        .emit(&format!("{}_error", stream_event), &error_event)
                                    {
                                        error!("发送安全错误事件失败: {}", e);
                                    }
                                }
                                crate::providers::StreamEvent::Done => {
                                    terminal_success = true;
                                    stream_ended = true;

                                    // 完成待聚合的工具调用（只在有工具调用时输出简洁日志）
                                    if !pending_tool_calls.is_empty() {
                                        debug!("工具调用序列结束");
                                    }
                                    for (_index, (id, name, accumulated_args)) in
                                        pending_tool_calls.iter()
                                    {
                                        if name.trim().is_empty() || name == "unknown" {
                                            warn!(
                                                "[llm_manager] 跳过 malformed tool call finalize: id='{}', name='{}', args_len={}",
                                                id,
                                                name,
                                                accumulated_args.len()
                                            );
                                            continue;
                                        }
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
                    // 🔒 without_url：reqwest 错误 Display 含完整 URL（Gemini 等 query 带 key）
                    let e = e.without_url();
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

                    // 已有内容时保留正文，但 Codex 不能把传输中断静默记为成功。
                    if !full_content.is_empty() || !reasoning_content.is_empty() {
                        warn!(
                            "{}部分内容已接收，标记为可恢复的中断",
                            chat_timing::format_elapsed_prefix(stream_event)
                        );
                        // F15：流中途出错但已有部分内容时，过去静默按“部分成功”截断。
                        // 这里额外发出截断警示事件，供前端标记“回复被截断”（前端展示由代理6实现）。
                        let truncated_event = format!("{}_truncated", stream_event);
                        let truncated_payload = json!({
                            "reason": "stream_read_error",
                            "error": e.to_string(),
                            "content_len": full_content.len(),
                            "reasoning_len": reasoning_content.len(),
                            "chunk_count": chunk_counter,
                            "stream_event": stream_event,
                            "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                        });
                        if let Err(emit_err) = window.emit(&truncated_event, &truncated_payload) {
                            warn!("发送截断警示事件失败: {}", emit_err);
                        }
                        terminal_failure = Some(responses_stream_interruption_message(
                            ResponsesStreamInterruption::ReadError,
                            is_codex,
                        ));
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

            if upstream_ended
                && require_terminal_success
                && !terminal_success
                && terminal_failure.is_none()
            {
                terminal_failure = Some(responses_stream_interruption_message(
                    ResponsesStreamInterruption::MissingTerminal,
                    is_codex,
                ));
            }

            // 如果流已结束，退出循环
            if stream_ended || upstream_ended {
                break;
            }
        }

        if !was_cancelled {
            if let Err(error) = validate_stream_termination(
                require_terminal_success,
                terminal_success,
                terminal_failure.as_deref(),
                is_codex,
            ) {
                self.clear_cancel_channel(stream_event).await;
                pending_tool_calls.clear();
                return Err(error);
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
                if name.trim().is_empty() || name == "unknown" {
                    warn!(
                        "[llm_manager] 跳过 malformed tool call fallback finalize: id='{}', name='{}', args_len={}",
                        id,
                        name,
                        accumulated_args.len()
                    );
                    continue;
                }
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

        // 用量日志：结束（脱敏写入全局记录器）
        {
            let approx_tokens_out = crate::utils::token_budget::estimate_tokens(&full_content);
            let dur = start_instant.elapsed().as_millis();

            // 从 API 返回的 usage 数据中提取实际 token 数量
            let (actual_prompt_tokens, actual_completion_tokens, reasoning_tokens, cached_tokens) =
                Self::extract_usage_tokens(
                    &captured_usage,
                    approx_tokens_out,
                    (request_bytes / 4).max(1),
                );

            if let Some(logger) = crate::debug_logger::get_global_logger() {
                logger
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
            }

            // 🔧 修复 Token 双重计费：单变体 Chat V2（task_context="chat_v2"）的用量
            // 由 chat_v2/pipeline/tool_loop.rs 在每轮结束后统一记录到 llm_usage_logs
            // （带真实 session_id、模型显示名和失败记录），此处不再重复写入。
            // 多变体（"chat_v2_variant"）没有 pipeline 层记录，仍依赖此处。
            if task_context != Some("chat_v2") {
                crate::llm_usage::record_llm_usage(
                    crate::llm_usage::CallerType::ChatV2,
                    &config.model,
                    actual_prompt_tokens,
                    actual_completion_tokens,
                    reasoning_tokens,
                    cached_tokens,
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
        // 获取模型配置
        // Model Router: choose model by task_context when possible
        let task = match task_context {
            Some(tc) if tc.contains("planner") => "review",
            // 🚀 修复：添加tag_generation的路由支持
            Some(tc) if tc == "tag_generation" || tc.contains("tag") => "tag_generation",
            _ => "default",
        };
        let (config, _enable_cot) = self
            .select_model_for(task, None, None, None, None, None, None)
            .await
            .unwrap_or((self.get_model2_config().await?, true));

        // 🆕 Failover 包装层（routing.rs）：非流式出口属于后台/工具型任务，
        // 允许 key 轮换与模型降级（无 window 上下文，仅日志通知）
        let run = routing::FailoverRun {
            task: task.to_string(),
            scenario: routing::FailoverScenario::BackgroundTask,
            user_pinned: false,
            window: None,
            attempts_handle_429_internally: false,
            required_is_multimodal: (chat_messages_require_multimodal(chat_history)
                || image_paths
                    .as_ref()
                    .is_some_and(|images| !images.is_empty()))
            .then_some(true),
            param_overrides: routing::ParamOverrides::default(),
        };
        let image_paths_ref = &image_paths;
        self.run_with_failover(run, config, |cfg, _establish_retries| {
            self.call_unified_model_2_with_config(
                cfg,
                context,
                chat_history,
                subject,
                enable_chain_of_thought,
                image_paths_ref.clone(),
                task_context,
                max_input_tokens_override,
            )
        })
        .await
    }

    /// 非流式统一出口的单次尝试（Failover 由 `call_unified_model_2` 包装层驱动）
    #[allow(clippy::too_many_arguments)]
    async fn call_unified_model_2_with_config(
        &self,
        config: ApiConfig,
        context: &HashMap<String, Value>,
        chat_history: &[ChatMessage],
        subject: &str,
        enable_chain_of_thought: bool,
        image_paths: Option<Vec<String>>,
        task_context: Option<&str>,
        max_input_tokens_override: Option<usize>,
    ) -> Result<StandardModel2Output> {
        ensure_model_accepts_message_modalities(&config, chat_history)?;
        info!(
            "调用统一模型二接口: 科目={}, 思维链={}, 图片数量={}, model={}",
            subject,
            enable_chain_of_thought,
            image_paths.as_ref().map(|p| p.len()).unwrap_or(0),
            config.model
        );

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
            let combined_content = system_content.to_string();

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

        // 添加聊天历史（优先保留图文交替的 multimodal_content）
        // 🔧 C3修复：补充 tool_call/tool_result 处理（之前完全丢弃工具调用信息）
        for msg in chat_history {
            if msg.role == "user" {
                if config.is_multimodal
                    && msg
                        .multimodal_content
                        .as_ref()
                        .is_some_and(|parts| !parts.is_empty())
                {
                    let parts = msg.multimodal_content.as_ref().expect("checked above");
                    let content = parts
                        .iter()
                        .map(|part| match part {
                            crate::models::MultimodalContentPart::Text { text } => {
                                json!({"type": "text", "text": text})
                            }
                            crate::models::MultimodalContentPart::ImageUrl {
                                media_type,
                                base64,
                            } => json!({
                                "type": "image_url",
                                "image_url": {"url": format!("data:{};base64,{}", media_type, base64)}
                            }),
                        })
                        .collect::<Vec<_>>();
                    messages.push(json!({"role": "user", "content": content}));
                } else if config.is_multimodal
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
        if !chat_history
            .iter()
            .any(crate::chat_v2::pipeline::is_transient_skill_message)
        {
            // 🔧 防御性合并：连续 user 消息合并
            Self::merge_consecutive_user_messages(&mut messages);
        }

        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": false  // 非流式版本
        });

        Self::apply_reasoning_config(&mut request_body, &config, None);

        apply_generation_params(&mut request_body, &config);
        let input_limit = effective_request_input_limit(&config, max_input_tokens_override);
        let budget_trim = enforce_request_input_budget(&mut request_body, input_limit)?;
        if budget_trim.removed_messages > 0 {
            warn!(
                "[model2_non_stream] final input guard removed {} message(s): {} -> {} tokens (limit={:?})",
                budget_trim.removed_messages,
                budget_trim.tokens_before,
                budget_trim.tokens_after,
                input_limit
            );
        }

        // 使用 ProviderAdapter 构建请求，确保 Gemini 模型走转换后的URL/Headers/Body
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                None,
                None,
                "聊天请求构建失败",
            )
            .await?;

        let debug_persist = self.build_debug_persist_config();
        log_llm_request_audit(
            "CHAT_V2_STREAM",
            &preq.url,
            &config.model,
            &request_body,
            debug_persist.as_ref(),
        );

        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self.client
                .post(&preq.url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            for (k, v) in &preq.headers {
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

            request_builder
                .json(&preq.body)
                .send()
                .await
                // 🆕 建立阶段网络层失败：打标供 Failover 分类
                .map_err(|e| {
                    routing::tag_establish_failure(
                        AppError::network(format!("模型二API请求失败: {}", e.without_url())),
                        None,
                    )
                })?
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            let error_msg = format!("模型二API请求失败: {} - {}", status, error_text);
            // 非流式版本没有 stream_event/window 上下文，这里仅返回错误
            error!("模型二API请求失败(非流式): {}", error_msg);
            // 🆕 打标 HTTP 状态码：429/5xx 可轮换重试，401/403 仅换 key，400 直接失败
            return Err(routing::tag_establish_failure(
                AppError::llm(error_msg),
                Some(status.as_u16()),
            ));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取模型二响应失败: {}", e)))?;
        let response_bytes = response_text.len();
        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| AppError::llm(format!("解析模型二响应失败: {}", e)))?;

        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)?;

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

        // 🆕 Failover 包装层（routing.rs）：标题/标签生成是典型后台任务，
        // 允许 key 轮换与模型降级（chat_title 用途可在策略中配独立 fallback 链）
        let run = routing::FailoverRun {
            task: "chat_title".to_string(),
            scenario: routing::FailoverScenario::BackgroundTask,
            user_pinned: false,
            window: None,
            attempts_handle_429_internally: false,
            required_is_multimodal: None,
            param_overrides: routing::ParamOverrides {
                temperature: Some(0.1),
                ..Default::default()
            },
        };
        let metadata_value = self
            .run_with_failover(run, config, |cfg, _establish_retries| {
                self.generate_chat_metadata_attempt(cfg, &system_prompt, &prompt_body)
            })
            .await?;

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
            .and_then(|s| {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });

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

    /// 聊天元数据（标题/标签）生成的单次尝试（Failover 由 `generate_chat_metadata` 驱动）
    async fn generate_chat_metadata_attempt(
        &self,
        config: ApiConfig,
        system_prompt: &str,
        prompt_body: &str,
    ) -> Result<Value> {
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

        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);

        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                Some(&api_key),
                None,
                "生成聊天元数据请求构建失败",
            )
            .await?;

        log_llm_request_audit(
            "METADATA",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self.client.post(&preq.url);
            for (key, value) in &preq.headers {
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

            request_builder
                .json(&preq.body)
                .send()
                .await
                // 🆕 建立阶段网络层失败：打标供 Failover 分类
                .map_err(|e| {
                    routing::tag_establish_failure(
                        AppError::network(format!("聊天元数据生成请求失败: {}", e.without_url())),
                        None,
                    )
                })?
        };

        if !response.status().is_success() {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_default();
            // 🆕 打标 HTTP 状态码供 Failover 分类
            return Err(routing::tag_establish_failure(
                AppError::llm(format!("聊天元数据生成失败: {} - {}", status, error_body)),
                Some(status.as_u16()),
            ));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| AppError::llm(format!("读取聊天元数据响应失败: {}", e)))?;
        let response_json: Value = serde_json::from_str(&response_text)
            .map_err(|e| AppError::llm(format!("解析聊天元数据响应失败: {}", e)))?;

        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)?;

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

        serde_json::from_str(&json_block)
            .map_err(|e| AppError::llm(format!("解析聊天元数据JSON失败: {}", e)))
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
            .post(format!("{}/embeddings", base_url))
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
            .post(format!("{}/rerank", base_url))
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
            let request_body = build_test_chat_request_body(&model, base_url);

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
                        // 🔒 URL 可能含 query 密钥（Gemini ?key=...），日志与用户可见错误均需脱敏
                        let safe_url = sanitize_url_for_log(&preq.url);
                        let error_text = response.text().await.unwrap_or_default();
                        warn!("模型 {} 不支持，错误: {}", model, error_text);
                        debug!("请求URL: {}", safe_url);
                        debug!(
                            "请求体: {}",
                            serde_json::to_string_pretty(&preq.body).unwrap_or_default()
                        );
                        // 如果是用户指定的模型，直接返回失败并提供详细错误
                        if model_name.is_some() {
                            return Err(AppError::validation(format!(
                                "API请求失败 (状态码: 400):\n请求URL: {}\n错误响应: {}\n可能原因: 模型不支持或参数错误",
                                safe_url, error_text
                            )));
                        }
                        continue;
                    } else if status == 401 {
                        // 401是认证错误，不需要尝试其他模型
                        let safe_url = sanitize_url_for_log(&preq.url);
                        let error_text = response.text().await.unwrap_or_default();
                        error!("API密钥认证失败: {}", status);
                        debug!("请求URL: {}", safe_url);
                        debug!("认证错误详情: {}", error_text);
                        return Err(AppError::validation(format!(
                            "API认证失败 (状态码: 401):\n请求URL: {}\n错误响应: {}\n请检查API密钥是否正确",
                            safe_url, error_text
                        )));
                    } else {
                        // 其他错误
                        let safe_url = sanitize_url_for_log(&preq.url);
                        let error_text = response.text().await.unwrap_or_default();
                        error!("API请求失败: {} - {}", status, error_text);
                        debug!("请求URL: {}", safe_url);
                        debug!(
                            "请求体: {}",
                            serde_json::to_string_pretty(&preq.body).unwrap_or_default()
                        );
                        // 如果是用户指定的模型，直接返回失败并提供详细错误
                        if model_name.is_some() {
                            return Err(AppError::validation(format!(
                                "API请求失败 (状态码: {}):\n请求URL: {}\n错误响应: {}",
                                status, safe_url, error_text
                            )));
                        }
                        continue;
                    }
                }
                Ok(Err(e)) => {
                    // 🔒 without_url：错误 Display 可能含带 key 的 URL（Gemini）
                    let cause = e.to_string();
                    let e = e.without_url();
                    error!("API连接测试请求错误 (模型: {}): {}", model, e);
                    // 如果是连接错误，不需要尝试其他模型
                    if cause.contains("handshake") || cause.contains("connect") {
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
        caller_type: crate::llm_usage::CallerType,
    ) -> Result<StandardModel2Output> {
        let config = self.get_model2_config().await?;
        self.call_raw_prompt_with_config(
            config,
            user_prompt,
            image_payloads,
            caller_type,
            "utility",
        )
        .await
    }

    /// 🆕 P1: 使用指定 config_id（或显示名称）对应的 ApiConfig 发起 raw prompt 调用
    ///
    /// 用于 compaction：和主对话同模型生成摘要，保持语言/风格一致。
    /// 回退链：匹配 config_id → 匹配 model 显示名 → Model2 默认配置。
    ///
    /// 🔧 CR-R2-01 修复：compaction 需要 Markdown 输出，禁用 JSON 强制模式，
    /// 否则 gpt-* 模型会把 Markdown 摘要编成 JSON，破坏锚定链。
    pub async fn call_with_config_id_raw_prompt(
        &self,
        config_id: &str,
        user_prompt: &str,
    ) -> Result<StandardModel2Output> {
        let configs = self.get_api_configs().await?;
        let resolved = configs
            .iter()
            .find(|c| c.id == config_id)
            .or_else(|| configs.iter().find(|c| c.model == config_id))
            .cloned();

        let config = match resolved {
            Some(c) => c,
            None => {
                warn!(
                    "[compaction] config_id/model '{}' 未找到，回退到 Model2 默认配置",
                    config_id
                );
                self.get_model2_config().await?
            }
        };

        // 🔧 CR-R2-01：force_json=false，让 gpt-* 模型按 Markdown 输出
        self.call_raw_prompt_with_config_opts(
            config,
            user_prompt,
            None,
            RawPromptOptions { force_json: false },
            crate::llm_usage::CallerType::ChatV2,
            "compaction",
        )
        .await
    }

    /// Execute an image-aware raw prompt against one exact, enabled multimodal chat config.
    ///
    /// Unlike background utility routing this method intentionally does not fail over to a
    /// different model. ChatV2 uses it to create a visual observation for a frozen text-model
    /// turn; silently changing the observer after the turn starts would invalidate the persisted
    /// capability snapshot.
    pub async fn call_raw_prompt_with_config_id_and_images(
        &self,
        config_id: &str,
        user_prompt: &str,
        image_payloads: Vec<ImagePayload>,
        caller_type: crate::llm_usage::CallerType,
    ) -> Result<StandardModel2Output> {
        self.call_raw_prompt_with_config_id_and_images_inner(
            config_id,
            user_prompt,
            image_payloads,
            caller_type,
        )
        .await
    }

    /// Cancellation-aware Chat compiler entrypoint. The exact provider request is owned by this
    /// future, so dropping it or cancelling the token also drops the in-flight HTTP future.
    pub(crate) async fn call_raw_prompt_with_config_id_and_images_cancellable(
        &self,
        config_id: &str,
        user_prompt: &str,
        image_payloads: Vec<ImagePayload>,
        caller_type: crate::llm_usage::CallerType,
        cancellation_token: tokio_util::sync::CancellationToken,
    ) -> Result<StandardModel2Output> {
        await_visual_observation_or_cancel(
            cancellation_token,
            self.call_raw_prompt_with_config_id_and_images_inner(
                config_id,
                user_prompt,
                image_payloads,
                caller_type,
            ),
        )
        .await
    }

    async fn call_raw_prompt_with_config_id_and_images_inner(
        &self,
        config_id: &str,
        user_prompt: &str,
        image_payloads: Vec<ImagePayload>,
        caller_type: crate::llm_usage::CallerType,
    ) -> Result<StandardModel2Output> {
        if image_payloads.is_empty() {
            return Err(AppError::configuration(
                "多模态 raw prompt 至少需要一张图片",
            ));
        }

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|c| c.id == config_id || c.model == config_id)
            .ok_or_else(|| {
                AppError::configuration(format!("找不到指定的多模态模型配置: {}", config_id))
            })?;

        if !config.enabled {
            return Err(AppError::configuration(format!(
                "指定的多模态模型已禁用: {}",
                config_id
            )));
        }
        if !config.is_multimodal
            || config.is_embedding
            || config.is_reranker
            || config.is_image_generation
        {
            return Err(AppError::configuration(format!(
                "指定配置不是可用于视觉理解的多模态语言模型: {}",
                config_id
            )));
        }

        self.call_raw_prompt_attempt(
            config,
            user_prompt,
            Some(image_payloads),
            RawPromptOptions { force_json: false },
            caller_type,
        )
        .await
    }

    /// 使用记忆决策模型调用（回退链：memory_decision_model → model2）
    pub async fn call_memory_decision_raw_prompt(
        &self,
        user_prompt: &str,
    ) -> Result<StandardModel2Output> {
        let config = self.get_memory_decision_model_config().await?;
        self.call_raw_prompt_with_config(
            config,
            user_prompt,
            None,
            crate::llm_usage::CallerType::Memory,
            "memory_decision",
        )
        .await
    }

    /// 使用标题/标签生成模型调用（回退链：chat_title_model → model2）
    pub async fn call_chat_title_raw_prompt(
        &self,
        user_prompt: &str,
    ) -> Result<StandardModel2Output> {
        let config = self.get_chat_title_model_config().await?;
        self.call_raw_prompt_with_config(
            config,
            user_prompt,
            None,
            crate::llm_usage::CallerType::ChatV2,
            "chat_title",
        )
        .await
    }

    /// 内部方法：使用显式传入的 ApiConfig 执行 raw prompt 调用
    async fn call_raw_prompt_with_config(
        &self,
        config: ApiConfig,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
        caller_type: crate::llm_usage::CallerType,
        task: &str,
    ) -> Result<StandardModel2Output> {
        // 旧入口保留默认行为：GPT 启用 JSON 严格模式
        self.call_raw_prompt_with_config_opts(
            config,
            user_prompt,
            image_payloads,
            RawPromptOptions { force_json: true },
            caller_type,
            task,
        )
        .await
    }

    /// 带选项的 raw prompt 调用。`force_json=false` 供 compaction 等需要 Markdown
    /// 输出的调用方使用（CR-R2-01 修复）。
    ///
    /// 🆕 Failover 包装层（routing.rs）：raw prompt 出口均为后台/工具型任务
    /// （标题、压缩、记忆决策、utility），允许 key 轮换与模型降级。
    async fn call_raw_prompt_with_config_opts(
        &self,
        config: ApiConfig,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
        opts: RawPromptOptions,
        caller_type: crate::llm_usage::CallerType,
        task: &str,
    ) -> Result<StandardModel2Output> {
        let run = routing::FailoverRun {
            task: task.to_string(),
            scenario: routing::FailoverScenario::BackgroundTask,
            user_pinned: false,
            window: None,
            attempts_handle_429_internally: false,
            required_is_multimodal: image_payloads
                .as_ref()
                .is_some_and(|images| !images.is_empty())
                .then_some(true),
            param_overrides: routing::ParamOverrides::default(),
        };
        let image_payloads_ref = &image_payloads;
        self.run_with_failover(run, config, |cfg, _establish_retries| {
            self.call_raw_prompt_attempt(
                cfg,
                user_prompt,
                image_payloads_ref.clone(),
                opts,
                caller_type.clone(),
            )
        })
        .await
    }

    /// raw prompt 的单次尝试（Failover 由 `call_raw_prompt_with_config_opts` 驱动）
    async fn call_raw_prompt_attempt(
        &self,
        config: ApiConfig,
        user_prompt: &str,
        image_payloads: Option<Vec<ImagePayload>>,
        opts: RawPromptOptions,
        caller_type: crate::llm_usage::CallerType,
    ) -> Result<StandardModel2Output> {
        if image_payloads
            .as_ref()
            .is_some_and(|images| !images.is_empty())
            && !config.is_multimodal
        {
            return Err(AppError::configuration(format!(
                "当前请求包含图片，但模型配置 {} 不支持多模态输入",
                config.id
            )));
        }

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

        Self::apply_reasoning_config(&mut request_body, &config, None);
        apply_generation_params(&mut request_body, &config);
        if let Some(max_tokens) = request_body
            .get("max_completion_tokens")
            .or_else(|| request_body.get("max_tokens"))
            .cloned()
        {
            request_body["max_total_tokens"] = max_tokens;
        }

        // 如果是 OpenAI GPT 模型 且调用方允许（compaction 等 Markdown 场景会关掉）
        if opts.force_json && config.model.starts_with("gpt-") {
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
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                None,
                None,
                "RAW prompt 请求构建失败",
            )
            .await?;

        log_llm_request_audit(
            "RAW_PROMPT",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        // 5. 发送请求
        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self.client
                .post(&preq.url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            for (k, v) in &preq.headers {
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

            request_builder
                .json(&preq.body)
                .send()
                .await
                // 🆕 建立阶段网络层失败：打标供 Failover 分类
                .map_err(|e| {
                    routing::tag_establish_failure(
                        AppError::network(format!("RAW_PROMPT API请求失败: {}", e.without_url())),
                        None,
                    )
                })?
        };

        // 6. 检查响应状态
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            // 🆕 打标 HTTP 状态码供 Failover 分类
            return Err(routing::tag_establish_failure(
                AppError::llm(format!(
                    "RAW_PROMPT API请求失败: {} - {}",
                    status, error_text
                )),
                Some(status.as_u16()),
            ));
        }

        // 7. 解析响应
        let response_json: serde_json::Value = response.json().await.map_err(|e| {
            let err_msg = format!("解析RAW_PROMPT响应失败: {}", e);
            crate::llm_usage::record_llm_usage(
                caller_type.clone(),
                &config.model,
                0,
                0,
                None,
                None,
                None,
                None,
                false,
                Some(err_msg.clone()),
            );
            AppError::llm(err_msg)
        })?;

        // All non-streaming protocols converge on the OpenAI chat-shaped response used below.
        // This also converts canonical Responses JSON produced by the Codex SSE bridge.
        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)
            .inspect_err(|error| {
                crate::llm_usage::record_llm_usage(
                    caller_type.clone(),
                    &config.model,
                    0,
                    0,
                    None,
                    None,
                    None,
                    None,
                    false,
                    Some(error.to_string()),
                );
            })?;

        let assistant_message = openai_like_json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        // 记录成功的 LLM 使用量
        let usage = openai_like_json.get("usage");
        let (actual_prompt_tokens, actual_completion_tokens, reasoning_tokens, cached_tokens) =
            Self::extract_usage_tokens(
                &usage.cloned(),
                crate::utils::token_budget::estimate_tokens(&assistant_message),
                (user_prompt.len() / 4).max(1),
            );
        crate::llm_usage::record_llm_usage(
            caller_type,
            &config.model,
            actual_prompt_tokens,
            actual_completion_tokens,
            reasoning_tokens,
            cached_tokens,
            None,
            None,
            true,
            None,
        );

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
        apply_max_tokens_or_mimo_completion_limit(&mut request_body, &config, max_tokens);

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
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                None,
                None,
                "OCR RAW prompt 请求构建失败",
            )
            .await?;

        log_llm_request_audit(
            "OCR_RAW",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        // 5. 发送请求
        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self
                .client
                .post(&preq.url)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity");
            for (k, v) in &preq.headers {
                request_builder = request_builder.header(k, v);
            }
            request_builder.json(&preq.body).send().await.map_err(|e| {
                AppError::network(format!("OCR_MODEL API请求失败: {}", e.without_url()))
            })?
        };

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

        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)?;

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
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": 0.0,
            "stream": false,
        });
        apply_max_tokens_or_mimo_completion_limit(&mut request_body, &config, max_tokens);

        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);

        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                Some(&api_key),
                None,
                "OCR请求构建失败",
            )
            .await?;

        log_llm_request_audit(
            "OCR_PAGES",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut header_map = reqwest::header::HeaderMap::new();
            for (k, v) in &preq.headers {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, val);
                }
            }

            self.client
                .post(&preq.url)
                .headers(header_map)
                .json(&preq.body)
                .send()
                .await
                .map_err(|e| AppError::llm(format!("OCR请求失败: {}", e.without_url())))?
        };

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

        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)?;
        openai_like_json["choices"][0]["message"]["content"]
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
    ) -> (u32, u32, Option<u32>, Option<u32>) {
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

            // 提取 cached_tokens（缓存命中，按供应商格式取 max 防中转站重复）
            let anthropic_cache_hit = usage_value
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let openai_cached = usage_value
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let deepseek_cached = usage_value
                .get("prompt_cache_hit_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let gemini_cached = usage_value
                .get("cached_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let cached_tokens = if anthropic_cache_hit > 0
                || openai_cached > 0
                || deepseek_cached > 0
                || gemini_cached > 0
            {
                Some(
                    anthropic_cache_hit
                        .max(openai_cached)
                        .max(deepseek_cached)
                        .max(gemini_cached),
                )
            } else {
                None
            };

            debug!(
                "[LLM Usage] 从 API 提取: prompt={}, completion={}, reasoning={:?}, cached={:?}",
                prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens
            );

            (
                prompt_tokens,
                completion_tokens,
                reasoning_tokens,
                cached_tokens,
            )
        } else {
            // 没有 API usage 数据，使用估算值
            let estimated_prompt = fallback_prompt_tokens as u32;
            debug!(
                "[LLM Usage] API 未返回 usage，使用估算值: prompt={}, completion={}",
                estimated_prompt, fallback_completion_tokens
            );
            (
                estimated_prompt,
                fallback_completion_tokens as u32,
                None,
                None,
            )
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
                "请根据以下学习内容，生成适合制作Anki卡片的问题和答案对。每张卡片应测试一个单一的概念。卡片内容（front/back/tags）的语言必须与学习材料一致：英文材料生成英文卡片，中文材料生成中文卡片，不要翻译。请以JSON数组格式返回结果，每个对象必须包含 \"front\" (字符串), \"back\" (字符串), \"tags\" (字符串数组) 三个字段。".to_string()
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
            "temperature": temperature
        });

        apply_max_tokens_or_mimo_completion_limit(&mut request_body, &config, max_tokens);
        Self::apply_reasoning_config(&mut request_body, &config, None);

        // 如果支持JSON模式，添加response_format
        if config.model.starts_with("gpt-") {
            request_body["response_format"] = json!({"type": "json_object"});
        }

        debug!("发送 Anki 制卡请求到: {} (经适配器)", config.base_url);

        // 5. 通过 ProviderAdapter 发送HTTP请求（支持 Gemini 中转）
        let adapter: Box<dyn ProviderAdapter> = build_provider_adapter(&config);
        let mut preq = self
            .prepare_provider_request(
                adapter.as_ref(),
                &config,
                &request_body,
                None,
                None,
                "Anki 制卡请求构建失败",
            )
            .await?;

        log_llm_request_audit(
            "ANKI_CARD",
            &preq.url,
            &config.model,
            &request_body,
            self.build_debug_persist_config().as_ref(),
        );

        let response = if preq.is_codex() {
            self.send_codex_request_with_single_refresh(&mut preq, None)
                .await?
        } else {
            let mut request_builder = self.client
                .post(&preq.url)
                .header("Accept", "text/event-stream, application/json, text/plain, */*")
                .header("Accept-Encoding", "identity")  // 禁用压缩，避免二进制响应
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
            for (k, v) in &preq.headers {
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

            request_builder.json(&preq.body).send().await.map_err(|e| {
                let cause = e.to_string();
                let e = e.without_url();
                let error_msg = if cause.contains("timed out") {
                    format!("Anki制卡API请求超时: {}", e)
                } else if cause.contains("connect") {
                    format!("无法连接到 Anki 制卡 API 服务器: {}", e)
                } else {
                    format!("Anki制卡API请求失败: {}", e)
                };
                AppError::network(error_msg)
            })?
        };

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

        let openai_like_json = normalize_nonstream_response_to_openai(&config, &response_json)?;

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
