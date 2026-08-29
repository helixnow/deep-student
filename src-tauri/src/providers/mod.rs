use crate::llm_manager::adapters::{
    claude_generation, map_budget_tokens_to_effort, ClaudeGeneration,
};
use crate::utils::fetch::fetch_binary_with_cache;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

#[derive(Debug)]
pub enum ProviderError {
    BuildFailed(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::BuildFailed(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    ContentChunk(String),
    ReasoningChunk(String),
    /// OpenAI Responses reasoning output item. Stateless tool continuations must
    /// replay this item so encrypted reasoning context is not lost.
    ResponseReasoningItem(Value),
    /// Gemini 3 思维签名（工具调用必需）
    /// 在工具调用场景下，需要缓存此签名并在后续请求中回传
    ThoughtSignature(String),
    ToolCall(Value),
    /// 🆕 2026-08: 服务端联网搜索状态（OpenAI Responses `web_search` 工具）。
    /// 载荷：`{"id","stage":"in_progress"|"searching"|"completed",
    /// "sources":[{"title","url","snippet"}]}`。sources 仅在 completed 阶段携带。
    WebSearchCall(Value),
    Usage(Value),
    SafetyBlocked(Value),
    Done,
}

#[allow(unused_variables)]
pub trait ProviderAdapter: Send + Sync {
    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError>;
    /// Whether a streaming response is successful only after a protocol-level
    /// terminal event. OpenAI Responses must not treat transport EOF as success.
    fn requires_explicit_stream_completion(&self) -> bool {
        false
    }
    /// 解析流式响应行，返回事件列表
    fn parse_stream(&self, line: &str) -> Vec<StreamEvent>;
    /// Resolve protocol state when the transport reaches EOF. Stateful
    /// adapters can use this to accept a provider that sent a terminal choice
    /// but omitted its protocol sentinel without truncating trailing chunks.
    fn finish_stream(&self) -> Vec<StreamEvent> {
        Vec::new()
    }
}

pub struct OpenAIAdapter {
    /// Chat Completions marks the final choice before the optional usage-only
    /// chunk. Remember that marker, but do not terminate consumers until
    /// `[DONE]` or transport EOF.
    saw_finish_reason: std::sync::atomic::AtomicBool,
}

impl Default for OpenAIAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAIAdapter {
    pub fn new() -> Self {
        Self {
            saw_finish_reason: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

fn openai_endpoint_url(base_url: &str, endpoint: &str) -> String {
    let tail_start = base_url.find(['?', '#']).unwrap_or(base_url.len());
    let (base_path, tail) = base_url.split_at(tail_start);
    let base_path = base_path.trim_end_matches('/');
    let endpoint = endpoint.trim_matches('/');
    let suffix = format!("/{endpoint}");

    let lowercase_path = base_path.to_ascii_lowercase();
    let lowercase_suffix = suffix.to_ascii_lowercase();
    let resolved_path = if lowercase_path.ends_with(&lowercase_suffix) {
        base_path.to_string()
    } else if let Some(existing_suffix) = ["/chat/completions", "/responses"]
        .into_iter()
        .find(|candidate| lowercase_path.ends_with(candidate))
    {
        format!(
            "{}{suffix}",
            &base_path[..base_path.len() - existing_suffix.len()]
        )
    } else {
        format!("{base_path}{suffix}")
    };

    format!("{resolved_path}{tail}")
}

fn sse_data_payload(block: &str) -> Option<String> {
    crate::utils::sse_buffer::extract_stream_data_payload(block)
}

fn is_official_openai_api_endpoint(base_url: &str) -> bool {
    url::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "api.openai.com")
}

impl ProviderAdapter for OpenAIAdapter {
    fn requires_explicit_stream_completion(&self) -> bool {
        true
    }

    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        _model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        let url = openai_endpoint_url(base_url, "chat/completions");
        // 确保 API key 被 trim，移除首尾空白字符
        let trimmed_key = api_key.trim();
        let mut sanitized_body = sanitize_openai_request_body(body);
        self.saw_finish_reason
            .store(false, std::sync::atomic::Ordering::Release);

        // 流式请求补 stream_options.include_usage=true：OpenAI Chat Completions
        // 默认不在流中返回 usage，缓存命中（prompt_tokens_details.cached_tokens）
        // 因此不可见。该扩展只对已确认支持它的 OpenAI 官方端点自动启用；
        // 未知兼容网关默认不注入，避免严格网关因未知字段返回 400。
        // 调用方已显式设置 stream_options 时尊重原值。
        if let Some(obj) = sanitized_body.as_object_mut() {
            let is_stream = obj.get("stream").and_then(Value::as_bool).unwrap_or(false);
            if is_stream
                && is_official_openai_api_endpoint(base_url)
                && !obj.contains_key("stream_options")
            {
                obj.insert(
                    "stream_options".to_string(),
                    json!({ "include_usage": true }),
                );
            }
        }

        let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        if !trimmed_key.is_empty() {
            headers.insert(
                0,
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", trimmed_key),
                ),
            );
        }

        Ok(ProviderRequest {
            url,
            headers,
            body: sanitized_body,
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();

        // 🔧 SSE 规范允许 "data:" 后不带空格（部分供应商/中转站省略空格），
        // 与 OpenAIResponsesAdapter/AnthropicAdapter 的宽容解析保持一致，
        // 否则这些流的所有数据行会被静默丢弃（表现为"健康连接但无任何输出"）
        if let Some(data) = sse_data_payload(line) {
            if data.trim() == "[DONE]" {
                self.saw_finish_reason
                    .store(false, std::sync::atomic::Ordering::Release);
                events.push(StreamEvent::Done);
                return events;
            }

            if let Ok(json_data) = serde_json::from_str::<Value>(&data) {
                // 流中错误注入：OpenRouter 等聚合网关会以 {"error":{...}} 数据行
                // 报告中途错误（研报 09 §1），必须上报而非静默忽略
                if let Some(error) = json_data.get("error") {
                    if !error.is_null() {
                        log::error!("[OpenAIAdapter] Stream error event: {}", error);
                        events.push(StreamEvent::SafetyBlocked(json!({
                            "type": "provider_error",
                            "reason": "stream_error",
                            "details": error.clone()
                        })));
                        self.saw_finish_reason
                            .store(false, std::sync::atomic::Ordering::Release);
                        events.push(StreamEvent::Done);
                        return events;
                    }
                }

                let mut choices_finished = false;

                // OpenAI 走 choices[].delta 路径
                if let Some(choices) = json_data["choices"].as_array() {
                    choices_finished = openai_choices_finished(choices);
                    for choice in choices {
                        if let Some(delta) = choice["delta"].as_object() {
                            // 内容块（使用 get 避免缺键 panic）
                            match delta.get("content") {
                                Some(Value::String(content)) => {
                                    events.push(StreamEvent::ContentChunk(content.to_string()));
                                }
                                // Mistral 推理模式：delta.content 会在字符串与
                                // ThinkChunk/TextChunk 块数组之间变形（研报 04 要点 4）
                                Some(Value::Array(parts)) => {
                                    push_openai_content_part_events(&mut events, parts);
                                }
                                _ => {}
                            }
                            // 推理内容：兼容多种字段形态（研报 09 要点 4）
                            // (b) reasoning_content：DeepSeek/SiliconFlow/Fireworks 等
                            let mut reasoning_seen = false;
                            if let Some(reasoning) =
                                delta.get("reasoning_content").and_then(|v| v.as_str())
                            {
                                events.push(StreamEvent::ReasoningChunk(reasoning.to_string()));
                                reasoning_seen = true;
                            }
                            // (c) reasoning 字符串：Together/Groq(parsed)/Cerebras/阶跃
                            if !reasoning_seen {
                                if let Some(reasoning) =
                                    delta.get("reasoning").and_then(|v| v.as_str())
                                {
                                    if !reasoning.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(
                                            reasoning.to_string(),
                                        ));
                                        reasoning_seen = true;
                                    }
                                }
                            }
                            // (a) reasoning_details 数组：OpenRouter（取 text/summary 文本；
                            // reasoning.encrypted 无明文可展示，跳过）
                            if !reasoning_seen {
                                if let Some(details) =
                                    delta.get("reasoning_details").and_then(|v| v.as_array())
                                {
                                    for detail in details {
                                        let text =
                                            detail.get("text").and_then(|v| v.as_str()).or_else(
                                                || detail.get("summary").and_then(|v| v.as_str()),
                                            );
                                        if let Some(text) = text {
                                            if !text.is_empty() {
                                                events.push(StreamEvent::ReasoningChunk(
                                                    text.to_string(),
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                            // 工具调用
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|v| v.as_array())
                            {
                                for tc in tool_calls {
                                    if is_meaningful_openai_tool_delta(tc) {
                                        events.push(StreamEvent::ToolCall(tc.clone()));
                                    }
                                }
                            }
                        }
                    }
                }
                // usage 信息
                if let Some(usage) = json_data["usage"].as_object() {
                    events.push(StreamEvent::Usage(Value::Object(usage.clone())));
                }
                // `finish_reason` only completes choices. OpenAI may still send
                // `choices: []` with usage before `[DONE]`, so emitting Done here
                // would make the requested usage unreachable. Gateways that omit
                // `[DONE]` are accepted by finish_stream() when transport EOF arrives.
                if choices_finished {
                    self.saw_finish_reason
                        .store(true, std::sync::atomic::Ordering::Release);
                }
            }
        }

        events
    }

    fn finish_stream(&self) -> Vec<StreamEvent> {
        if self
            .saw_finish_reason
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            vec![StreamEvent::Done]
        } else {
            Vec::new()
        }
    }
}

fn openai_choices_finished(choices: &[Value]) -> bool {
    let has_finish_reason = |choice: &Value| {
        choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.trim().is_empty())
    };

    match choices {
        [] => false,
        [choice] => has_finish_reason(choice),
        // With multiple choices in one chunk, one choice can finish before the
        // others. Do not terminate consumers until every included choice is done.
        _ => choices.iter().all(has_finish_reason),
    }
}

/// 处理 delta.content 为块数组的形态（Mistral ThinkChunk/TextChunk，研报 04 要点 4）：
/// type:"text" 块拼接为正文，thinking/think 类块作为 reasoning 内容发送。
fn push_openai_content_part_events(events: &mut Vec<StreamEvent>, parts: &[Value]) {
    for part in parts {
        // 极简形态：数组元素直接是字符串
        if let Some(text) = part.as_str() {
            if !text.is_empty() {
                events.push(StreamEvent::ContentChunk(text.to_string()));
            }
            continue;
        }

        let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("text");
        match part_type {
            "thinking" | "think" | "reasoning" => {
                // ThinkChunk 的 thinking 字段是 TextChunk 列表（也可能是字符串）
                match part.get("thinking").or_else(|| part.get("text")) {
                    Some(Value::String(text)) if !text.is_empty() => {
                        events.push(StreamEvent::ReasoningChunk(text.to_string()));
                    }
                    Some(Value::Array(chunks)) => {
                        for chunk in chunks {
                            let text = chunk
                                .as_str()
                                .or_else(|| chunk.get("text").and_then(|v| v.as_str()));
                            if let Some(text) = text {
                                if !text.is_empty() {
                                    events.push(StreamEvent::ReasoningChunk(text.to_string()));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {
                // text/output_text 及未知类型：有 text 字段就当正文
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        events.push(StreamEvent::ContentChunk(text.to_string()));
                    }
                }
            }
        }
    }
}

/// Normalize OpenAI-compatible non-streaming responses whose message content is
/// emitted as Mistral ThinkChunk/TextChunk arrays.
pub(crate) fn normalize_openai_nonstream_response(response: &Value) -> Value {
    let mut normalized = response.clone();
    let Some(message) = normalized
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .and_then(|choices| choices.first_mut())
        .and_then(|choice| choice.get_mut("message"))
        .and_then(Value::as_object_mut)
    else {
        return normalized;
    };
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return normalized;
    };

    let mut text_segments = Vec::new();
    let mut reasoning_segments = Vec::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            if !text.is_empty() {
                text_segments.push(text.to_string());
            }
            continue;
        }
        let part_type = part.get("type").and_then(Value::as_str).unwrap_or("text");
        let target = if matches!(part_type, "thinking" | "think" | "reasoning") {
            &mut reasoning_segments
        } else {
            &mut text_segments
        };
        match part.get("thinking").or_else(|| part.get("text")) {
            Some(Value::String(text)) if !text.is_empty() => target.push(text.clone()),
            Some(Value::Array(chunks)) => {
                target.extend(chunks.iter().filter_map(|chunk| {
                    chunk
                        .as_str()
                        .or_else(|| chunk.get("text").and_then(Value::as_str))
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                }));
            }
            _ => {}
        }
    }
    message.insert("content".to_string(), json!(text_segments.join("")));
    if !reasoning_segments.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            json!(reasoning_segments.join("")),
        );
    }
    normalized
}

fn is_meaningful_openai_tool_delta(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };

    let has_index = obj.get("index").and_then(|v| v.as_i64()).is_some();
    let has_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_name = obj
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_arguments = obj
        .get("function")
        .and_then(|f| f.get("arguments"))
        .map(|arguments| {
            arguments
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(!arguments.is_null())
        })
        .unwrap_or(false);

    has_index && (has_id || has_name || has_arguments)
}

fn normalize_openai_function_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 工具是否声明了空白名称（扁平 `name` 或嵌套 `function.name`）。
///
/// OpenAI 兼容网关（如 cliproxyapi，issue #53）会以 HTTP 400 拒绝空工具名：
/// `Invalid 'tools[0].name': empty string`。这类残缺工具必须在请求发出前
/// 整体丢弃。未声明任何名称字段的内置工具（如 `{"type":"web_search"}`）不受影响。
fn tool_declares_blank_name(tool: &Value) -> bool {
    let flat_name_blank = tool
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| name.trim().is_empty());
    let nested_name_blank = tool
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .is_some_and(|name| name.trim().is_empty());
    flat_name_blank || nested_name_blank
}

fn sanitize_openai_tools_array(tools: &[Value]) -> Vec<Value> {
    let mut seen_names = HashSet::new();
    let mut sanitized = Vec::new();

    for tool in tools {
        // 空名工具（扁平或嵌套）直接丢弃：非 function 工具的透传和
        // function 工具的 clone 否则都会把空 `name` 原样送上线路
        if tool_declares_blank_name(tool) {
            continue;
        }

        // 非 function 类型的工具（内置工具/服务端工具，如 web_search、openrouter:web_search）
        // 原样透传，不做名称/参数归一化
        let tool_type = tool
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("function");
        if tool_type != "function" {
            sanitized.push(tool.clone());
            continue;
        }

        let Some(function) = tool.get("function").and_then(|value| value.as_object()) else {
            continue;
        };

        let Some(name) = function
            .get("name")
            .and_then(|value| value.as_str())
            .and_then(normalize_openai_function_name)
        else {
            continue;
        };

        if !seen_names.insert(name.clone()) {
            continue;
        }

        let mut sanitized_tool = tool.clone();
        if let Some(obj) = sanitized_tool.as_object_mut() {
            let function_value = obj
                .entry("function".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(function_obj) = function_value.as_object_mut() {
                function_obj.insert("name".to_string(), json!(name));
                let normalized_parameters = match function_obj.remove("parameters") {
                    Some(Value::Object(map)) => {
                        let mut value = Value::Object(map);
                        if let Some(obj) = value.as_object_mut() {
                            obj.entry("type".to_string())
                                .or_insert_with(|| json!("object"));
                            obj.entry("properties".to_string())
                                .or_insert_with(|| json!({}));
                        }
                        value
                    }
                    _ => json!({"type": "object", "properties": {}}),
                };
                function_obj.insert("parameters".to_string(), normalized_parameters);
            }
        }

        sanitized.push(sanitized_tool);
    }

    sanitized
}

fn sanitize_openai_tool_choice(
    choice: &Value,
    valid_tool_names: &HashSet<String>,
) -> Option<Value> {
    if let Some(choice_str) = choice.as_str() {
        return match choice_str {
            "auto" | "none" | "required" => Some(json!(choice_str)),
            _ => None,
        };
    }

    let obj = choice.as_object()?;
    let choice_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(choice_type, "function" | "tool") {
        return None;
    }

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| {
            obj.get("function")
                .and_then(|function| function.get("name"))
                .and_then(|v| v.as_str())
        })
        .and_then(normalize_openai_function_name)?;

    if !valid_tool_names.contains(&name) {
        return None;
    }

    // Chat Completions 协议要求嵌套形状 {"type":"function","function":{"name":...}}；
    // Responses 路径由 convert_tool_call_to_response_tool_choice 再转成扁平形状
    Some(json!({
        "type": "function",
        "function": { "name": name },
    }))
}

fn sanitize_openai_request_body(body: &Value) -> Value {
    let mut sanitized = body.clone();
    let mut valid_tool_names = HashSet::new();

    if let Some(obj) = sanitized.as_object_mut() {
        if let Some(tools) = obj.get("tools").and_then(|value| value.as_array()) {
            let cleaned_tools = sanitize_openai_tools_array(tools);
            valid_tool_names = cleaned_tools
                .iter()
                .filter_map(|tool| {
                    tool.get("function")
                        .and_then(|value| value.get("name"))
                        .and_then(|value| value.as_str())
                        .map(|name| name.to_string())
                })
                .collect();

            if cleaned_tools.is_empty() {
                obj.remove("tools");
                obj.remove("tool_choice");
            } else {
                obj.insert("tools".to_string(), Value::Array(cleaned_tools));
            }
        }

        if let Some(tool_choice) = obj.get("tool_choice").cloned() {
            let Some(cleaned_tool_choice) =
                sanitize_openai_tool_choice(&tool_choice, &valid_tool_names)
            else {
                obj.remove("tool_choice");
                return sanitized;
            };
            obj.insert("tool_choice".to_string(), cleaned_tool_choice);
        }
    }

    sanitized
}

pub struct OpenAIResponsesAdapter {
    /// Whether any output-text delta has been received for this response.
    saw_content_delta: std::sync::atomic::AtomicBool,
    /// Whether user-visible output text has already been emitted by any fallback path.
    emitted_content: std::sync::atomic::AtomicBool,
    /// 是否已收到过 reasoning 增量（`.delta` 事件）。
    /// `.done` 事件携带的是全量文本，仅在未收到任何增量时才作为兜底推送，
    /// 否则思维链会被重复推送（研报 01 §1.4）。
    saw_reasoning_delta: std::sync::atomic::AtomicBool,
    /// 是否已推送过任何 reasoning 内容（增量或 .done 兜底）。
    /// `response.completed` 中的 extract_reasoning_text 仅在此前完全没有
    /// reasoning 输出时才兜底推送一次。
    emitted_reasoning: std::sync::atomic::AtomicBool,
    /// Whether a complete reasoning output item has already been emitted.
    saw_reasoning_item: std::sync::atomic::AtomicBool,
    /// Tool calls can be repeated by `response.function_call_arguments.done`,
    /// `response.output_item.done`, and the terminal response fallback.
    emitted_tool_call_ids: Mutex<HashSet<String>>,
    /// Server-side web search calls can be reported by `response.web_search_call.*`
    /// events, `response.output_item.done`, and the terminal response fallback.
    /// Deduplicate by item/call id so the UI renders a single search block.
    emitted_web_search_ids: Mutex<HashSet<String>>,
    /// Ids of web_search_call items already emitted at `completed` stage with
    /// sources. A source-less completed event may be upgraded by the terminal
    /// response fallback that extracts annotations from the final message.
    emitted_web_search_with_sources_ids: Mutex<HashSet<String>>,
    /// In-flight function_call items announced by `response.output_item.added`,
    /// keyed by item id. `response.function_call_arguments.delta` events only
    /// carry `item_id`, so name/call_id/output_index and the accumulated
    /// argument buffer must be tracked here (对齐 Codex SSE 桥，P2-14)。
    pending_function_calls: Mutex<HashMap<String, PendingResponseFunctionCall>>,
    /// Ids of reasoning items already emitted (streaming `output_item.done` or
    /// terminal fallback). Per-id dedup lets a response carry multiple
    /// reasoning items (one per function_call round) without double emission.
    emitted_reasoning_item_ids: Mutex<HashSet<String>>,
}

/// Streaming state for one Responses `function_call` output item.
#[derive(Debug, Clone, Default)]
struct PendingResponseFunctionCall {
    call_id: String,
    name: String,
    output_index: i64,
    arguments: String,
}

impl Default for OpenAIResponsesAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAIResponsesAdapter {
    fn preserves_provider_reasoning_extensions(base_url: &str) -> bool {
        let Some(host) = url::Url::parse(base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_lowercase))
        else {
            return false;
        };
        host == "dashscope.aliyuncs.com"
            || host == "dashscope-intl.aliyuncs.com"
            || host.ends_with(".maas.aliyuncs.com")
            || host == "qianfan.baidubce.com"
            || host.ends_with(".volces.com")
            || host == "api.deepseek.com"
    }

    /// GPT-5.6 起提供显式 `prompt_cache_breakpoint`。只解析完整的 GPT 型号段，
    /// 避免 `not-gpt-6` 或部署别名中偶然出现的子串被当成模型能力。
    pub(crate) fn model_supports_prompt_cache_breakpoint(model: &str) -> bool {
        let lower = model.trim().to_ascii_lowercase();
        let model_segment = lower.rsplit('/').next().unwrap_or_default();
        let Some(rest) = model_segment.strip_prefix("gpt-") else {
            return false;
        };
        let major_digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let Ok(major) = major_digits.parse::<u32>() else {
            return false;
        };
        let after_major = &rest[major_digits.len()..];
        if major > 5 {
            return after_major.is_empty()
                || after_major.starts_with('-')
                || after_major.starts_with('_')
                || after_major
                    .strip_prefix('.')
                    .and_then(|minor| minor.chars().next())
                    .is_some_and(|digit| digit.is_ascii_digit());
        }
        if major != 5 {
            return false;
        }
        let Some(minor_part) = after_major.strip_prefix('.') else {
            return false;
        };
        let minor_digits: String = minor_part
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let suffix = &minor_part[minor_digits.len()..];
        minor_digits.parse::<u32>().is_ok_and(|minor| minor >= 6)
            && (suffix.is_empty() || suffix.starts_with('-') || suffix.starts_with('_'))
    }

    fn endpoint_supports_prompt_cache_breakpoint(base_url: &str) -> bool {
        is_official_openai_api_endpoint(base_url)
    }

    pub fn new() -> Self {
        Self {
            saw_content_delta: std::sync::atomic::AtomicBool::new(false),
            emitted_content: std::sync::atomic::AtomicBool::new(false),
            saw_reasoning_delta: std::sync::atomic::AtomicBool::new(false),
            emitted_reasoning: std::sync::atomic::AtomicBool::new(false),
            saw_reasoning_item: std::sync::atomic::AtomicBool::new(false),
            emitted_tool_call_ids: Mutex::new(HashSet::new()),
            emitted_web_search_ids: Mutex::new(HashSet::new()),
            emitted_web_search_with_sources_ids: Mutex::new(HashSet::new()),
            pending_function_calls: Mutex::new(HashMap::new()),
            emitted_reasoning_item_ids: Mutex::new(HashSet::new()),
        }
    }

    fn is_reasoning_item(item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("reasoning")
    }

    /// Emit one reasoning item at most once. Items carrying an `id` are deduped
    /// per id（一次响应可含多个 reasoning item，各自只发一次）；id 缺失的 item
    /// 由 `allow_unidentified` 控制（终态兜底仅在整个流未发过任何 reasoning
    /// item 时才允许，避免与流式 `output_item.done` 重复）。
    fn try_emit_reasoning_item(
        &self,
        item: &Value,
        allow_unidentified: bool,
        events: &mut Vec<StreamEvent>,
    ) -> bool {
        if !Self::is_reasoning_item(item) {
            return false;
        }
        match item.get("id").and_then(Value::as_str) {
            Some(id) => {
                let is_new = self
                    .emitted_reasoning_item_ids
                    .lock()
                    .map(|mut emitted| emitted.insert(id.to_string()))
                    .unwrap_or(true);
                if !is_new {
                    return false;
                }
            }
            None => {
                if !allow_unidentified {
                    return false;
                }
            }
        }
        self.saw_reasoning_item
            .store(true, std::sync::atomic::Ordering::Relaxed);
        events.push(StreamEvent::ResponseReasoningItem(item.clone()));
        true
    }

    fn emit_reasoning_items_from_response(&self, response: &Value, events: &mut Vec<StreamEvent>) {
        let allow_unidentified = !self
            .saw_reasoning_item
            .load(std::sync::atomic::Ordering::Relaxed);
        if let Some(output) = response.get("output").and_then(|v| v.as_array()) {
            for item in output {
                self.try_emit_reasoning_item(item, allow_unidentified, events);
            }
        }
    }

    /// 终态兜底：按 `response.output` 的原始顺序**交错**发射 reasoning item 与
    /// function_call，保持「reasoning 紧邻其后继 function_call」的相邻语义。
    /// 禁止两遍扫描（先全量 reasoning 再全量 tool_call）——那会让下游无法按
    /// 相邻关系把每个 reasoning item 配对到正确的 function_call。
    fn emit_reasoning_and_tool_calls_from_response(
        &self,
        response: &Value,
        events: &mut Vec<StreamEvent>,
    ) {
        let allow_unidentified = !self
            .saw_reasoning_item
            .load(std::sync::atomic::Ordering::Relaxed);
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            for (index, item) in output.iter().enumerate() {
                self.try_emit_reasoning_item(item, allow_unidentified, events);
                self.emit_response_tool_call(item, index as i64, events);
            }
        }
    }

    fn push_message_parts(parts: &mut Vec<Value>, role: &str, content: &Value) {
        match content {
            Value::String(text) if !text.trim().is_empty() => {
                if role == "assistant" {
                    parts.push(json!({ "type": "output_text", "text": text }));
                } else {
                    parts.push(json!({ "type": "input_text", "text": text }));
                }
            }
            Value::Array(arr) => {
                for part in arr {
                    let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ptype {
                        "input_text" if role != "assistant" => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    parts.push(json!({ "type": "input_text", "text": text }));
                                }
                            }
                        }
                        "text" | "output_text" => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    if role == "assistant" {
                                        parts.push(json!({ "type": "output_text", "text": text }));
                                    } else {
                                        parts.push(json!({ "type": "input_text", "text": text }));
                                    }
                                }
                            }
                        }
                        "image_url" | "input_image" if role != "assistant" => {
                            let image_url = if ptype == "input_image" {
                                part.get("image_url").and_then(|v| v.as_str())
                            } else {
                                part.get("image_url")
                                    .and_then(|v| v.get("url"))
                                    .and_then(|v| v.as_str())
                            };

                            if let Some(image_url) = image_url {
                                let image_part = if let Some(detail) = part.get("detail").cloned() {
                                    json!({
                                        "type": "input_image",
                                        "image_url": image_url,
                                        "detail": detail
                                    })
                                } else {
                                    json!({
                                        "type": "input_image",
                                        "image_url": image_url
                                    })
                                };
                                parts.push(image_part);
                            }
                        }
                        "refusal" if role == "assistant" => {
                            if let Some(refusal) = part.get("refusal").and_then(|v| v.as_str()) {
                                if !refusal.is_empty() {
                                    parts.push(json!({ "type": "refusal", "refusal": refusal }));
                                }
                            }
                        }
                        _ => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    if role == "assistant" {
                                        parts.push(json!({ "type": "output_text", "text": text }));
                                    } else {
                                        parts.push(json!({ "type": "input_text", "text": text }));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn assistant_tool_call_items(message: &Value) -> Vec<Value> {
        let mut items = Vec::new();
        if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
            for tool_call in tool_calls {
                let id = tool_call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("call_unknown");
                let name = tool_call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown_function");
                let arguments = tool_call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}");
                items.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": arguments,
                }));
            }
        }
        items
    }

    fn tool_result_item(message: &Value) -> Option<Value> {
        let call_id = message.get("tool_call_id").and_then(|v| v.as_str())?;
        let output = match message.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };

        Some(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }))
    }

    fn convert_tool_call_to_response_tool_choice(value: &Value) -> Option<Value> {
        if let Some(choice) = value.as_str() {
            return match choice {
                "auto" | "none" | "required" => Some(json!(choice)),
                _ => None,
            };
        }

        let Some(obj) = value.as_object() else {
            return None;
        };

        let choice_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(choice_type, "function" | "tool") {
            let name = obj.get("name").and_then(|v| v.as_str()).or_else(|| {
                obj.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
            })?;
            return Some(json!({
                "type": "function",
                "name": name,
            }));
        }

        None
    }

    /// Chat Completions 嵌套工具定义 {"type":"function","function":{...}} 转换为
    /// Responses 扁平格式 {"type":"function","name","description","parameters","strict"}。
    /// 非 function 类型（内置工具等）与已是扁平格式的定义原样透传（研报 01 要点 6）。
    fn convert_tool_definition_to_responses(tool: &Value) -> Value {
        let tool_type = tool
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("function");
        if tool_type != "function" {
            return tool.clone();
        }

        let Some(function) = tool.get("function").and_then(|v| v.as_object()) else {
            // 无嵌套 function 对象：可能已经是扁平格式，原样透传
            return tool.clone();
        };

        let mut flat = Map::new();
        flat.insert("type".to_string(), json!("function"));
        for key in ["name", "description", "parameters"] {
            if let Some(value) = function.get(key) {
                flat.insert(key.to_string(), value.clone());
            }
        }
        // strict 语义差异：CC 缺省为非 strict，而 Responses 缺省会尝试服务端自动
        // strict 化。为保持与调用方 CC 请求一致的语义，缺省时显式传 false；
        // 显式指定时原样透传（研报 01 要点 6）
        flat.insert(
            "strict".to_string(),
            function.get("strict").cloned().unwrap_or(json!(false)),
        );
        Value::Object(flat)
    }

    /// CC 的 response_format:{type:"json_schema",json_schema:{name,schema,strict}}
    /// 需扁平化为 Responses 的 text.format:{type:"json_schema",name,schema,strict}；
    /// json_object / text 等其他取值原样兼容（研报 01 要点 7）。
    fn convert_response_format_to_text_format(response_format: &Value) -> Value {
        let format_type = response_format
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if format_type == "json_schema" {
            if let Some(nested) = response_format
                .get("json_schema")
                .and_then(|v| v.as_object())
            {
                let mut flat = Map::new();
                flat.insert("type".to_string(), json!("json_schema"));
                for (key, value) in nested {
                    if key != "type" {
                        flat.insert(key.clone(), value.clone());
                    }
                }
                return Value::Object(flat);
            }
        }
        response_format.clone()
    }

    fn convert_response_tool_call(item: &Value, output_index: i64) -> Option<Value> {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type != "function_call" {
            return None;
        }

        let name = item.get("name").and_then(|v| v.as_str())?;
        let arguments = item
            .get("arguments")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("input").and_then(|v| v.as_str()))
            .unwrap_or("{}");
        let id = item
            .get("call_id")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("id").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("resp_call_{}", uuid::Uuid::new_v4()));

        Some(json!({
            "index": output_index,
            "id": id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": arguments,
            }
        }))
    }

    fn emit_response_tool_call(
        &self,
        item: &Value,
        output_index: i64,
        events: &mut Vec<StreamEvent>,
    ) {
        let Some(tool_call) = Self::convert_response_tool_call(item, output_index) else {
            return;
        };
        let Some(call_id) = tool_call.get("id").and_then(Value::as_str) else {
            return;
        };
        let is_new = self
            .emitted_tool_call_ids
            .lock()
            .map(|mut emitted| emitted.insert(call_id.to_string()))
            .unwrap_or(true);
        if is_new {
            events.push(StreamEvent::ToolCall(tool_call));
        }
    }

    /// `response.output_item.added`（function_call）：登记进行中的工具调用，
    /// 并向上游发射「开始」分块（带 id/name、空 arguments）。上游管线以
    /// 「有 id = 新调用开始」语义聚合分块（对齐 Codex SSE 桥，P2-14）。
    fn begin_streaming_function_call(
        &self,
        item: &Value,
        output_index: i64,
        events: &mut Vec<StreamEvent>,
    ) {
        let Some(item_id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or(item_id)
            .to_string();
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let initial_arguments = item
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let is_new = self
            .pending_function_calls
            .lock()
            .map(|mut pending| {
                pending
                    .insert(
                        item_id.to_string(),
                        PendingResponseFunctionCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            output_index,
                            arguments: initial_arguments.clone(),
                        },
                    )
                    .is_none()
            })
            .unwrap_or(true);
        // 终态已发射（arguments.done / output_item.done 先到）或重复 added：不再发开始分块
        let already_terminal = self
            .emitted_tool_call_ids
            .lock()
            .map(|emitted| emitted.contains(&call_id))
            .unwrap_or(false);
        if is_new && !already_terminal && !name.is_empty() {
            events.push(StreamEvent::ToolCall(json!({
                "index": output_index,
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": initial_arguments,
                }
            })));
        }
    }

    /// `response.function_call_arguments.delta`：累积参数并发射 id-less 参数分块
    /// （上游按 index 追加，驱动前端实时预览；对齐 Codex SSE 桥，P2-14）。
    fn append_function_call_arguments_delta(&self, parsed: &Value, events: &mut Vec<StreamEvent>) {
        let Some(delta) = parsed
            .get("delta")
            .and_then(Value::as_str)
            .filter(|delta| !delta.is_empty())
        else {
            return;
        };
        let Some(item_id) = parsed
            .get("item_id")
            .or_else(|| parsed.get("call_id"))
            .and_then(Value::as_str)
        else {
            return;
        };

        let output_index = {
            let Ok(mut pending) = self.pending_function_calls.lock() else {
                return;
            };
            let Some(entry) = pending.get_mut(item_id) else {
                // 未见 added：无 name/call_id 可用，只缓冲等 arguments.done 兜底
                pending.insert(
                    item_id.to_string(),
                    PendingResponseFunctionCall {
                        arguments: delta.to_string(),
                        output_index: parsed
                            .get("output_index")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        ..Default::default()
                    },
                );
                return;
            };
            entry.arguments.push_str(delta);
            parsed
                .get("output_index")
                .and_then(Value::as_i64)
                .unwrap_or(entry.output_index)
        };
        events.push(StreamEvent::ToolCall(json!({
            "index": output_index,
            "type": "function",
            "function": { "arguments": delta }
        })));
    }

    /// 取走（并移除）item 对应的进行中工具调用状态。
    fn take_pending_function_call(&self, item_id: &str) -> Option<PendingResponseFunctionCall> {
        self.pending_function_calls
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(item_id))
    }

    /// 从 web_search_call item / 事件载荷中提取来源列表。
    /// 兼容两种返回形态：
    /// - item 自带 `search_results: [{url,title,text|snippet}]`
    /// - 随 assistant message 返回的 `annotations: [{type:"url_citation",url,title}]`
    fn extract_web_search_sources(item: &Value) -> Vec<Value> {
        let mut sources: Vec<Value> = Vec::new();
        let results = item
            .get("search_results")
            .or_else(|| item.get("web_search_sources"))
            .and_then(Value::as_array);
        if let Some(results) = results {
            for result in results {
                let url = result
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if url.is_empty() {
                    continue;
                }
                let title = result
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let snippet = result
                    .get("text")
                    .or_else(|| result.get("snippet"))
                    .or_else(|| result.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                sources.push(json!({
                    "title": title,
                    "url": url,
                    "snippet": snippet,
                }));
            }
        }
        if let Some(content) = item.get("content").and_then(Value::as_array) {
            for part in content {
                if let Some(annotations) = part.get("annotations").and_then(Value::as_array) {
                    for annotation in annotations {
                        let annotation_type =
                            annotation.get("type").and_then(Value::as_str).unwrap_or("");
                        if annotation_type != "url_citation" {
                            continue;
                        }
                        let url = annotation
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if url.is_empty() {
                            continue;
                        }
                        let title = annotation
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let snippet = annotation
                            .get("title")
                            .or_else(|| annotation.get("snippet"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if sources
                            .iter()
                            .any(|existing| existing.get("url") == Some(&json!(url)))
                        {
                            continue;
                        }
                        sources.push(json!({
                            "title": title,
                            "url": url,
                            "snippet": snippet,
                        }));
                    }
                }
            }
        }
        sources
    }

    /// 把事件里的 web_search_call item 规整为可原样回传下一轮 `input` 的完整形态。
    /// DeepSeek Responses 无状态：服务端靠回传的 web_search_call item 恢复搜索结果，
    /// 因此完整 item 必须随流事件上抛、挂到 assistant 消息 meta（P2-13）。
    /// 合成聚合载荷（如终端 annotations 兜底的 `resp_web_search`）没有 status/type，
    /// 不可回传，返回 None。
    fn full_web_search_item_for_replay(item: &Value) -> Option<Value> {
        match item.get("type").and_then(Value::as_str) {
            Some("web_search_call") => Some(item.clone()),
            Some(_) => None,
            None => {
                let looks_like_item = item.get("id").and_then(Value::as_str).is_some()
                    && item.get("status").is_some();
                if looks_like_item {
                    // 事件名已保证条目类型；补上 type 使 item 可直接作为 input 回传
                    let mut full = item.clone();
                    full["type"] = json!("web_search_call");
                    Some(full)
                } else {
                    None
                }
            }
        }
    }

    /// 组装 web_search_call 载荷并去重发射。
    fn emit_web_search_item(&self, item: &Value, stage: &str, events: &mut Vec<StreamEvent>) {
        let id = item
            .get("id")
            .or_else(|| item.get("call_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let sources = item
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| Self::extract_web_search_sources(item));
        let has_sources = !sources.is_empty();

        if stage == "completed" {
            let already_emitted = match self.emitted_web_search_ids.lock() {
                Ok(mut seen) => !seen.insert(id.clone()),
                Err(_) => false,
            };
            // 终端响应兜底可能携带流式事件缺失的来源：已发射过「带来源」的
            // completed 才整体跳过；无来源的 completed 允许被终端兜底升级。
            if already_emitted && self.emitted_web_search_with_sources(id.as_str()) {
                return;
            }
            if has_sources {
                self.mark_web_search_with_sources(id.as_str());
            }
        } else {
            let _ = self
                .emitted_web_search_ids
                .lock()
                .map(|mut seen| seen.insert(id.clone()));
        }

        let mut payload = json!({
            "id": id,
            "stage": stage,
        });
        if stage == "completed" {
            payload["sources"] = json!(sources);
        }
        // 完整 item 随载荷上抛，供上游挂到 assistant 消息 meta 并在下一轮
        // 原样回传 input（DeepSeek Responses 无状态恢复搜索结果，P2-13）
        if let Some(full_item) = Self::full_web_search_item_for_replay(item) {
            payload["item"] = full_item;
        }
        events.push(StreamEvent::WebSearchCall(payload));
    }

    fn emitted_web_search_with_sources(&self, id: &str) -> bool {
        self.emitted_web_search_with_sources_ids
            .lock()
            .map(|set| set.contains(id))
            .unwrap_or(false)
    }

    fn mark_web_search_with_sources(&self, id: &str) {
        let _ = self
            .emitted_web_search_with_sources_ids
            .lock()
            .map(|mut set| set.insert(id.to_string()));
    }

    /// 终端响应兜底：从 `response.output` 提取 web_search_call 条目
    /// （含 search_results），并收集消息 annotations 中缺失的来源。
    fn emit_web_search_from_response(&self, response: &Value, events: &mut Vec<StreamEvent>) {
        let mut fallback_sources: Vec<Value> = Vec::new();
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            for item in output {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                if item_type == "web_search_call" {
                    let stage = item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    self.emit_web_search_item(item, stage, events);
                    fallback_sources.extend(Self::extract_web_search_sources(item));
                }
            }
        }
        // 部分实现把搜索结果只放在 message 的 annotations 里：若 output 中
        // 没有任何带 search_results 的 web_search_call 条目，则从 annotations
        // 兜底汇总为一个 completed 载荷。
        if fallback_sources.is_empty() {
            if let Some(output) = response.get("output").and_then(Value::as_array) {
                for item in output {
                    if item.get("type").and_then(Value::as_str) == Some("message") {
                        fallback_sources.extend(Self::extract_web_search_sources(item));
                    }
                }
            }
            if !fallback_sources.is_empty() {
                self.emit_web_search_item(
                    &json!({ "id": "resp_web_search", "sources": fallback_sources }),
                    "completed",
                    events,
                );
            }
        }
    }

    /// 将 Chat Completions 兼容格式转换为 Responses API 请求格式。
    fn convert_to_responses_format(model: &str, body: &Value) -> Value {
        Self::convert_to_responses_format_for_endpoint(model, body, "")
    }

    fn convert_to_responses_format_for_endpoint(
        model: &str,
        body: &Value,
        base_url: &str,
    ) -> Value {
        let body = sanitize_openai_request_body(body);
        let mut input_blocks: Vec<Value> = Vec::new();
        let mut instructions: Vec<String> = Vec::new();

        if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
            for message in messages {
                let role = message
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("user");

                if role == "system" {
                    if let Some(content) = message.get("content") {
                        match content {
                            Value::String(text) if !text.trim().is_empty() => {
                                instructions.push(text.to_string());
                            }
                            Value::Array(parts) => {
                                for part in parts {
                                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                        if !text.trim().is_empty() {
                                            instructions.push(text.to_string());
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    continue;
                }

                if role == "tool" {
                    if let Some(item) = Self::tool_result_item(message) {
                        input_blocks.push(item);
                    }
                    continue;
                }

                // Internal provider state attached by the Chat V2 tool loop.
                // Replay it before the assistant function call, matching the
                // order returned by the Responses API.
                if role == "assistant" {
                    if let Some(item) = message.get("response_reasoning_item") {
                        if Self::is_reasoning_item(item) {
                            input_blocks.push(item.clone());
                        }
                    }
                    // 服务端 web_search_call：完整 item 原样回传（DeepSeek Responses
                    // 无状态，服务端靠该 item 恢复搜索结果；顺序对齐响应 output：
                    // reasoning → web_search_call → message，P2-13）
                    if let Some(items) = message
                        .get("response_web_search_items")
                        .and_then(Value::as_array)
                    {
                        for item in items {
                            if item.get("type").and_then(Value::as_str) == Some("web_search_call") {
                                input_blocks.push(item.clone());
                            }
                        }
                    }
                }

                let mut parts: Vec<Value> = Vec::new();
                if let Some(content) = message.get("content") {
                    Self::push_message_parts(&mut parts, role, content);
                }

                if !parts.is_empty() {
                    input_blocks.push(json!({
                        "role": role,
                        "content": parts
                    }));
                }

                if role == "assistant" {
                    for item in Self::assistant_tool_call_items(message) {
                        input_blocks.push(item);
                    }
                }
            }
        }

        if input_blocks.is_empty() {
            input_blocks.push(json!({
                "role": "user",
                "content": [{"type": "input_text", "text": ""}]
            }));
        }

        // GPT-5.6+ 是「断点处精确匹配」缓存：顶层 instructions 打不了
        // prompt_cache_breakpoint，稳定指令改放 input 首位的 developer
        // input_text 并显式打断点（ROUND-02 P2-12）。其他模型（含 DeepSeek
        // Responses，官方无该字段且靠自动前缀缓存）保持顶层 instructions 不变。
        let instructions_as_developer_breakpoint = !instructions.is_empty()
            && Self::model_supports_prompt_cache_breakpoint(model)
            && Self::endpoint_supports_prompt_cache_breakpoint(base_url);
        if instructions_as_developer_breakpoint {
            input_blocks.insert(
                0,
                json!({
                    "role": "developer",
                    "content": [{
                        "type": "input_text",
                        "text": instructions.join("\n\n"),
                        "prompt_cache_breakpoint": { "mode": "explicit" }
                    }]
                }),
            );
        }

        // 尊重调用方 body 中的 stream 值：非流式路径（标题生成/OCR 等）显式传
        // stream:false 时必须透传，否则收到 SSE 流导致 JSON 解析失败；缺省仍为 true
        let stream_enabled = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(true);
        let mut payload = json!({
            "model": model,
            "input": input_blocks,
            "stream": stream_enabled,
        });

        // Responses 服务端默认 store:true（保存 30 天）。桌面应用以隐私为先，
        // 调用方未显式指定时默认关闭服务端留存（研报 01 要点 10）
        payload["store"] = body.get("store").cloned().unwrap_or(json!(false));

        if !instructions.is_empty() && !instructions_as_developer_breakpoint {
            payload["instructions"] = json!(instructions.join("\n\n"));
        }

        if let Some(reasoning) = body.get("reasoning") {
            let mut reasoning_cfg = reasoning.clone();
            if reasoning_cfg.get("effort").is_none() {
                if let Some(effort) = body.get("reasoning_effort") {
                    reasoning_cfg["effort"] = effort.clone();
                }
            }
            if reasoning_cfg.get("summary").is_none() {
                reasoning_cfg["summary"] = json!("auto");
            }
            payload["reasoning"] = reasoning_cfg;
        } else {
            let lower = model.to_lowercase();
            if lower.contains("o1")
                || lower.contains("o3")
                || lower.contains("gpt-5")
                || body.get("reasoning_effort").is_some()
            {
                let mut reasoning_cfg = json!({
                    "summary": "auto"
                });
                if let Some(effort) = body.get("reasoning_effort") {
                    reasoning_cfg["effort"] = effort.clone();
                }
                payload["reasoning"] = reasoning_cfg;
            }
        }

        if let Some(include) = body.get("include") {
            payload["include"] = include.clone();
        } else {
            let lower = model.to_lowercase();
            if lower.contains("gpt-5")
                || lower.contains("codex")
                || lower.starts_with("o1")
                || lower.starts_with("o3")
                || lower.starts_with("o4")
            {
                payload["include"] = json!(["reasoning.encrypted_content"]);
            }
        }

        if let Some(max_tokens) = body
            .get("max_completion_tokens")
            .or_else(|| body.get("max_total_tokens"))
            .or_else(|| body.get("max_tokens"))
        {
            payload["max_output_tokens"] = max_tokens.clone();
        }

        if let Some(temperature) = body.get("temperature") {
            payload["temperature"] = temperature.clone();
        }

        if let Some(response_format) = body.get("response_format") {
            payload["text"] = json!({
                "format": Self::convert_response_format_to_text_format(response_format)
            });
        }

        if let Some(verbosity) = body.get("verbosity") {
            let text_cfg = payload
                .get("text")
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let mut merged = serde_json::Map::from_iter(text_cfg);
            merged.insert("verbosity".to_string(), verbosity.clone());
            payload["text"] = Value::Object(merged);
        }

        if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
            if !tools.is_empty() {
                let converted: Vec<Value> = tools
                    .iter()
                    .map(Self::convert_tool_definition_to_responses)
                    .collect();
                payload["tools"] = Value::Array(converted);
            }
        }

        if let Some(tool_choice) = body
            .get("tool_choice")
            .and_then(Self::convert_tool_call_to_response_tool_choice)
        {
            payload["tool_choice"] = tool_choice;
        }

        if let Some(parallel_tool_calls) = body.get("parallel_tool_calls") {
            payload["parallel_tool_calls"] = parallel_tool_calls.clone();
        }

        // Some native provider endpoints expose a Responses-compatible API while
        // retaining their thinking extension. Unknown gateways and api.openai.com
        // must not receive these non-standard top-level fields.
        if Self::preserves_provider_reasoning_extensions(base_url) {
            for key in ["thinking", "enable_thinking", "thinking_budget"] {
                if let Some(value) = body.get(key) {
                    payload[key] = value.clone();
                }
            }
        }

        payload
    }

    fn extract_reasoning_text(response: &Value) -> Option<String> {
        let mut reasoning_segments: Vec<String> = Vec::new();

        if let Some(output) = response.get("output").and_then(|v| v.as_array()) {
            for item in output {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                if item_type == "reasoning" {
                    if let Some(summary_arr) = item.get("summary").and_then(|v| v.as_array()) {
                        for entry in summary_arr {
                            if let Some(text) = entry.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    reasoning_segments.push(text.to_string());
                                }
                            }
                        }
                    }
                }

                if let Some(content_arr) = item.get("content").and_then(|v| v.as_array()) {
                    for entry in content_arr {
                        let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if entry_type.contains("reasoning") {
                            if let Some(text) = entry.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    reasoning_segments.push(text.to_string());
                                }
                            }
                        }
                    }
                } else if item_type.contains("reasoning") {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            reasoning_segments.push(text.to_string());
                        }
                    }
                }
            }
        }

        if reasoning_segments.is_empty() {
            None
        } else {
            Some(reasoning_segments.join("\n\n"))
        }
    }

    fn collect_output_text(content: &Value, segments: &mut Vec<String>) {
        match content {
            Value::String(text) if !text.is_empty() => segments.push(text.clone()),
            Value::Array(parts) => {
                for part in parts {
                    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
                    if matches!(part_type, "output_text" | "text" | "") {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                segments.push(text.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn extract_output_text(response: &Value) -> Option<String> {
        let mut segments = Vec::new();
        if let Some(output) = response.get("output") {
            match output {
                Value::String(text) if !text.is_empty() => segments.push(text.clone()),
                Value::Array(items) => {
                    for item in items {
                        if let Some(content) = item.get("content") {
                            Self::collect_output_text(content, &mut segments);
                        } else if matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("output_text" | "text")
                        ) {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    segments.push(text.to_string());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        if segments.is_empty() {
            if let Some(content) = response.get("content") {
                Self::collect_output_text(content, &mut segments);
            }
        }
        if segments.is_empty() {
            if let Some(output_text) = response.get("output_text").and_then(Value::as_str) {
                if !output_text.is_empty() {
                    segments.push(output_text.to_string());
                }
            }
        }

        if segments.is_empty() {
            None
        } else {
            Some(segments.join(""))
        }
    }
}

impl ProviderAdapter for OpenAIResponsesAdapter {
    fn requires_explicit_stream_completion(&self) -> bool {
        true
    }

    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        let url = openai_endpoint_url(base_url, "responses");
        let trimmed_key = api_key.trim();

        let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        if !trimmed_key.is_empty() {
            headers.insert(
                0,
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", trimmed_key),
                ),
            );
        }

        Ok(ProviderRequest {
            url,
            headers,
            body: Self::convert_to_responses_format_for_endpoint(model, body, base_url),
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        let mut event_name: Option<&str> = None;
        for raw_line in line.lines() {
            let raw_line = raw_line.trim_end_matches('\r');
            if let Some(name) = raw_line.strip_prefix("event:") {
                event_name = Some(name.trim());
            }
        }
        let Some(data) = sse_data_payload(line) else {
            return events;
        };
        if data == "[DONE]" {
            events.push(StreamEvent::Done);
            return events;
        }

        let mut parsed = match serde_json::from_str::<Value>(&data) {
            Ok(v) => v,
            Err(_) => return events,
        };
        if parsed.get("type").is_none() {
            if let (Some(name), Some(object)) = (event_name, parsed.as_object_mut()) {
                object.insert("type".to_string(), Value::String(name.to_string()));
            }
        }

        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if event_type.is_empty() {
            if let Some(error) = parsed.get("error").filter(|error| !error.is_null()) {
                log::error!("[OpenAIResponsesAdapter] Untyped stream error: {}", error);
                events.push(StreamEvent::SafetyBlocked(json!({
                    "type": "provider_error",
                    "reason": "stream_error",
                    "details": error.clone()
                })));
                return events;
            }
        }

        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
                    if !delta.is_empty() {
                        self.saw_content_delta
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        self.emitted_content
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        events.push(StreamEvent::ContentChunk(delta.to_string()));
                    }
                }
            }
            "response.output_text.done"
                if !self
                    .saw_content_delta
                    .load(std::sync::atomic::Ordering::Relaxed)
                => {
                    let text = parsed
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| parsed.get("delta").and_then(Value::as_str));
                    if let Some(text) = text.filter(|text| !text.is_empty()) {
                        self.emitted_content
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        events.push(StreamEvent::ContentChunk(text.to_string()));
                    }
                }
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                let text = parsed
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .or_else(|| parsed.get("text").and_then(|v| v.as_str()));
                if let Some(reasoning) = text {
                    if !reasoning.is_empty() {
                        self.saw_reasoning_delta
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        self.emitted_reasoning
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        events.push(StreamEvent::ReasoningChunk(reasoning.to_string()));
                    }
                }
            }
            "response.reasoning_text.done" | "response.reasoning_summary_text.done"
                // .done 事件的 text 是全量文本：仅在此前未收到任何 .delta 增量时
                // 才兜底推送一次，避免思维链重复（研报 01 §1.4）
                if !self
                    .saw_reasoning_delta
                    .load(std::sync::atomic::Ordering::Relaxed)
                => {
                    let text = parsed
                        .get("text")
                        .and_then(|v| v.as_str())
                        .or_else(|| parsed.get("delta").and_then(|v| v.as_str()));
                    if let Some(reasoning) = text {
                        if !reasoning.is_empty() {
                            self.emitted_reasoning
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                            events.push(StreamEvent::ReasoningChunk(reasoning.to_string()));
                        }
                    }
                }
            // 部分实现（DeepSeek Responses 等）在 added 时就给出 function_call 的
            // id/name，参数走 arguments.delta 增量；web_search_call 也可能只经由
            // output_item.added 通告进行中状态（对齐 Codex SSE 桥，P2-14）
            "response.output_item.added" => {
                if let Some(item) = parsed.get("item") {
                    let output_index = parsed
                        .get("output_index")
                        .and_then(Value::as_i64)
                        .or_else(|| item.get("index").and_then(Value::as_i64))
                        .unwrap_or(0);
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        self.begin_streaming_function_call(item, output_index, &mut events);
                    }
                    if item.get("type").and_then(Value::as_str) == Some("web_search_call") {
                        let stage = item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("in_progress");
                        self.emit_web_search_item(item, stage, &mut events);
                    }
                }
            }
            "response.output_item.done" => {
                if let Some(item) = parsed.get("item") {
                    // 流式路径按响应顺序逐个发射；id 去重防止服务端重发或
                    // 终态兜底再次发射同一 item
                    self.try_emit_reasoning_item(item, true, &mut events);
                    let output_index = parsed
                        .get("output_index")
                        .and_then(Value::as_i64)
                        .or_else(|| item.get("index").and_then(Value::as_i64))
                        .unwrap_or(0);
                    // added + arguments.delta 流式路径：done item 缺失 arguments 时
                    // 以累积缓冲兜底（终态仍走 emit_response_tool_call 去重）
                    let pending = item
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(|item_id| self.take_pending_function_call(item_id));
                    let has_item_arguments = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .map(|arguments| !arguments.is_empty())
                        .unwrap_or(false);
                    if item.get("type").and_then(Value::as_str) == Some("function_call")
                        && !has_item_arguments
                    {
                        if let Some(pending) = pending
                            .as_ref()
                            .filter(|pending| !pending.arguments.is_empty())
                        {
                            let mut enriched = item.clone();
                            enriched["arguments"] = json!(pending.arguments);
                            self.emit_response_tool_call(&enriched, output_index, &mut events);
                        } else {
                            self.emit_response_tool_call(item, output_index, &mut events);
                        }
                    } else {
                        self.emit_response_tool_call(item, output_index, &mut events);
                    }
                    if item.get("type").and_then(Value::as_str) == Some("web_search_call") {
                        // 以 item 自身状态为准：output_item.done 时搜索可能仍在进行
                        let stage = item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("completed");
                        self.emit_web_search_item(item, stage, &mut events);
                    }
                }
            }
            // 服务端联网搜索状态事件（DeepSeek Responses web_search 工具）。
            // 官方事件无 stage 字段：缺省阶段必须按事件名区分，
            // in_progress 不得误标为 searching（研报 ROUND-01-responses-adapter 要点 4）
            "response.web_search_call.in_progress" | "response.web_search_call.searching" => {
                let default_stage = if event_type.ends_with(".in_progress") {
                    "in_progress"
                } else {
                    "searching"
                };
                let stage = parsed
                    .get("stage")
                    .and_then(Value::as_str)
                    .unwrap_or(default_stage);
                let id = parsed
                    .get("call_id")
                    .or_else(|| parsed.get("item_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                events.push(StreamEvent::WebSearchCall(json!({
                    "id": id,
                    "stage": stage,
                })));
            }
            "response.web_search_call.completed" => {
                let item = parsed.get("item").unwrap_or(&parsed);
                self.emit_web_search_item(item, "completed", &mut events);
            }
            "response.function_call_arguments.delta" | "response.function_call.arguments.delta" => {
                self.append_function_call_arguments_delta(&parsed, &mut events);
            }
            "response.function_call_arguments.done" | "response.function_call.arguments.done" => {
                // 事件本身可能只带 item_id + arguments：name/call_id/index 从
                // output_item.added 登记的进行中状态兜底（对齐 Codex SSE 桥）
                let pending = parsed
                    .get("item_id")
                    .and_then(Value::as_str)
                    .and_then(|item_id| self.take_pending_function_call(item_id));
                let name = parsed
                    .get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        pending
                            .as_ref()
                            .map(|pending| pending.name.as_str())
                            .filter(|name| !name.is_empty())
                    });
                let arguments = parsed
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        pending
                            .as_ref()
                            .map(|pending| pending.arguments.as_str())
                            .filter(|arguments| !arguments.is_empty())
                    });
                let call_id = parsed
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        pending
                            .as_ref()
                            .map(|pending| pending.call_id.as_str())
                            .filter(|call_id| !call_id.is_empty())
                    })
                    .or_else(|| parsed.get("item_id").and_then(|v| v.as_str()));
                if let (Some(name), Some(call_id)) = (name, call_id) {
                    let item = json!({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments.unwrap_or("{}")
                    });
                    let output_index = parsed
                        .get("output_index")
                        .and_then(Value::as_i64)
                        .or_else(|| pending.as_ref().map(|pending| pending.output_index))
                        .unwrap_or(0);
                    self.emit_response_tool_call(&item, output_index, &mut events);
                }
            }
            "response.completed" | "response.done" => {
                let response = parsed.get("response").unwrap_or(&parsed);
                if !self
                    .emitted_content
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    if let Some(content) = Self::extract_output_text(response) {
                        self.emitted_content
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        events.push(StreamEvent::ContentChunk(content));
                    }
                }
                // 仅在整个流中没有收到任何 reasoning 内容（.delta 增量或 .done 兜底）
                // 时，才从最终 response.output 中兜底提取一次，避免重复推送
                if !self
                    .emitted_reasoning
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    if let Some(reasoning) = Self::extract_reasoning_text(response) {
                        if !reasoning.is_empty() {
                            self.emitted_reasoning
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                            events.push(StreamEvent::ReasoningChunk(reasoning));
                        }
                    }
                }
                if let Some(usage) = response.get("usage") {
                    events.push(StreamEvent::Usage(usage.clone()));
                }
                // Keep the complete encrypted reasoning items available for stateless tool
                // continuation, emitted after user-visible reasoning/usage. Reasoning items
                // and function_calls interleave in output order so downstream consumers can
                // pair each reasoning item with its adjacent function_call.
                self.emit_reasoning_and_tool_calls_from_response(response, &mut events);
                self.emit_web_search_from_response(response, &mut events);
                events.push(StreamEvent::Done);
            }
            "response.incomplete" | "response.cancelled" | "response.canceled" => {
                if let Some(response) = parsed.get("response") {
                    // An incomplete response can still contain useful output. Preserve it
                    // before reporting the terminal failure, but never turn that failure
                    // into `Done`: callers must not persist a partial answer as success.
                    if !self
                        .emitted_content
                        .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        if let Some(content) = Self::extract_output_text(response) {
                            self.emitted_content
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                            events.push(StreamEvent::ContentChunk(content));
                        }
                    }
                    self.emit_reasoning_items_from_response(response, &mut events);
                    self.emit_web_search_from_response(response, &mut events);
                    if let Some(usage) = response.get("usage") {
                        events.push(StreamEvent::Usage(usage.clone()));
                    }
                }
                let details = parsed
                    .get("response")
                    .and_then(|response| response.get("incomplete_details"))
                    .cloned()
                    .unwrap_or_else(|| parsed.clone());
                events.push(StreamEvent::SafetyBlocked(json!({
                    "type": "provider_error",
                    "reason": event_type,
                    "details": details
                })));
            }
            "response.failed" | "error" => {
                // 🔧 之前直接吞掉错误只发 Done，供应商返回的失败原因（配额不足/参数错误等）
                // 完全丢失，前端只看到一条空响应。至少把错误详情记入日志便于诊断，
                // 并以 SafetyBlocked 通道向上游传递错误负载（emit {stream}_error 事件）。
                let error_detail = parsed
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .or_else(|| parsed.get("error"))
                    .cloned()
                    .unwrap_or_else(|| parsed.clone());
                log::error!(
                    "[OpenAIResponsesAdapter] Stream failed event: {}",
                    error_detail
                );
                if let Some(usage) = parsed.get("response").and_then(|r| r.get("usage")) {
                    events.push(StreamEvent::Usage(usage.clone()));
                }
                events.push(StreamEvent::SafetyBlocked(json!({
                    "type": "provider_error",
                    "reason": event_type,
                    "details": error_detail
                })));
            }
            _ => {}
        }

        events
    }
}

// Anthropic Claude 适配
pub struct AnthropicAdapter {
    pending_tool_calls: Arc<Mutex<HashMap<i32, PartialToolCall>>>,
    /// thinking 块的 signature_delta 累积缓冲（按 content block index）
    /// content_block_stop 时以 StreamEvent::ThoughtSignature 上抛
    pending_signatures: Arc<Mutex<HashMap<i32, String>>>,
    /// message_start 中的完整 usage 对象（message_delta 的 usage 通常只有 output_tokens，
    /// 需要字段级合并后再上报，否则 input_tokens 与
    /// cache_read_input_tokens / cache_creation_input_tokens 会被终态覆盖丢失）
    usage_from_start: Arc<Mutex<Option<Value>>>,
}

#[derive(Debug, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    buffer: String,
    base_input: Option<Value>,
}

impl Default for AnthropicAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicAdapter {
    pub fn new() -> Self {
        Self {
            pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
            pending_signatures: Arc::new(Mutex::new(HashMap::new())),
            usage_from_start: Arc::new(Mutex::new(None)),
        }
    }

    /// 构建 usage 事件，与 message_start 缓存的 usage 做字段级合并。
    ///
    /// Anthropic 流式协议中 message_start 携带 input_tokens 与
    /// cache_read_input_tokens / cache_creation_input_tokens，而 message_delta
    /// 的终态 usage 通常只有 output_tokens。若直接以终态覆盖，缓存命中信息全部丢失。
    /// 合并规则：本次 usage 中缺失或为 0 的字段，以 message_start 的非零值回填。
    fn build_merged_usage_event(&self, usage: &Value) -> Option<Value> {
        const MERGE_FIELDS: [&str; 3] = [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ];

        let start_usage = self
            .usage_from_start
            .lock()
            .ok()
            .and_then(|guard| guard.clone());

        if let (Value::Object(mut merged), Some(start)) = (usage.clone(), start_usage) {
            for field in MERGE_FIELDS {
                let current = merged.get(field).and_then(|v| v.as_i64()).unwrap_or(0);
                if current == 0 {
                    if let Some(start_value) = start.get(field).and_then(|v| v.as_i64()) {
                        if start_value != 0 {
                            merged.insert(field.to_string(), json!(start_value));
                        }
                    }
                }
            }
            return build_usage_event(&Value::Object(merged));
        }
        build_usage_event(usage)
    }

    fn convert_openai_to_anthropic(&self, model: &str, body: &Value) -> AnthropicRequest {
        let stream = body
            .get("stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .or_else(|| body.get("max_total_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(1024) as i32;

        // thinking 请求形态按代际分叉（研报 02 §3.1）：
        // - 旧代际 manual: { "type": "enabled", "budget_tokens": 10240 }
        // - 新代际 adaptive: { "type": "adaptive"[, "display"] } + output_config.effort
        //   （Opus 4.7/4.8、Sonnet 5、Fable 5 上传 enabled 会直接 400）
        let generation = claude_generation(model);
        let is_adaptive_generation = generation == ClaudeGeneration::Adaptive;

        let mut thinking = body.get("thinking").cloned();
        // 安全网：上游若仍以旧 manual 形态注入 thinking（绕过 RequestAdapter 的调用方），
        // 对新代际改写为 adaptive，并把 budget_tokens 近似映射为 effort
        let mut derived_effort: Option<String> = None;
        if is_adaptive_generation {
            if let Some(t) = thinking.as_mut() {
                if t.get("type").and_then(|v| v.as_str()) == Some("enabled") {
                    if let Some(budget) = t.get("budget_tokens").and_then(|v| v.as_i64()) {
                        derived_effort =
                            Some(map_budget_tokens_to_effort(budget as i32).to_string());
                    }
                    *t = json!({ "type": "adaptive" });
                }
            }
        }
        let has_thinking = matches!(
            thinking
                .as_ref()
                .and_then(|t| t.get("type"))
                .and_then(|t| t.as_str()),
            Some("enabled") | Some("adaptive")
        );

        // 当启用 extended thinking 时，Anthropic 要求 temperature 必须为 1 或不设置
        // 参考: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
        // Claude 4.5 Breaking Change: 不能同时使用 temperature 和 top_p
        // 参考: https://platform.claude.com/docs/en/about-claude/models/migrating-to-claude-4
        let raw_temperature = body
            .get("temperature")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32);
        let raw_top_p = body.get("top_p").and_then(|v| v.as_f64()).map(|v| v as f32);

        // 新代际（Fable 5 / Opus 4.7/4.8 / Sonnet 5）对非默认 temperature/top_p/top_k
        // 一律 400（研报 02 要点 4，与 thinking 开关无关）→ 无条件剥离
        let (temperature, top_p) = if has_thinking || is_adaptive_generation {
            (None, None) // Extended thinking / 新代际不支持自定义采样参数
        } else {
            // Claude 4.5+ 不能同时使用 temperature 和 top_p，优先使用 temperature
            match (raw_temperature, raw_top_p) {
                (Some(t), Some(_)) => (Some(t), None), // 优先 temperature，忽略 top_p
                (Some(t), None) => (Some(t), None),
                (None, Some(p)) => (None, Some(p)),
                (None, None) => (None, None),
            }
        };
        // Top-K 采样参数（仅考虑最可能的 K 个 token）
        // 参考: https://docs.anthropic.com/en/api/messages
        let top_k = if has_thinking || is_adaptive_generation {
            None // Extended thinking / 新代际不支持自定义 top_k
        } else {
            body.get("top_k").and_then(|v| v.as_i64()).map(|v| v as i32)
        };

        let mut system_blocks: Vec<Value> = Vec::new();
        let mut messages: Vec<AnthropicMessage> = Vec::new();

        if let Some(items) = body.get("messages").and_then(|v| v.as_array()) {
            for item in items {
                let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
                match role {
                    "system" | "developer" => {
                        // 保留调用方块级 cache_control 标记（如 model2_pipeline 在
                        // 稳定段尾打的 ephemeral），不要剥掉（ROUND-02 P2-11）
                        system_blocks.extend(extract_system_text_blocks(item));
                    }
                    "user" => {
                        if let Some(content) = convert_user_message(item) {
                            // Anthropic 不允许连续的同角色消息，需要合并
                            if let Some(last) = messages.last_mut() {
                                if last.role == "user" {
                                    // 合并文本内容到上一个 user 消息
                                    // 某些代理服务不支持多个 text 块，所以将文本合并为单个块
                                    merge_text_content(&mut last.content, content.content);
                                    continue;
                                }
                            }
                            messages.push(content);
                        }
                    }
                    "assistant" => {
                        if let Some(content) = convert_assistant_message(item) {
                            // Anthropic 不允许连续的同角色消息，需要合并
                            if let Some(last) = messages.last_mut() {
                                if last.role == "assistant" {
                                    // 合并文本内容到上一个 assistant 消息
                                    merge_text_content(&mut last.content, content.content);
                                    continue;
                                }
                            }
                            messages.push(content);
                        }
                    }
                    "tool" | "function" => {
                        if let Some(content) = convert_tool_result_message(item) {
                            messages.push(content);
                        }
                    }
                    _ => {}
                }
            }
        }

        // system 尾保险断点（ROUND-02 P2-11）：顶层 automatic cache_control 保留，
        // 另在 system 稳定段末尾补一个显式 ephemeral。调用方已有块级标记时视为
        // 稳定段尾由上游指定，原样保留、不再追加。
        let has_block_level_marker = system_blocks
            .iter()
            .any(|block| block.get("cache_control").is_some());
        if !has_block_level_marker {
            if let Some(last) = system_blocks.last_mut() {
                last["cache_control"] = json!({ "type": "ephemeral" });
            }
        }

        let mut tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|items| {
                let mut converted = items
                    .iter()
                    .filter_map(convert_tool_definition)
                    .collect::<Vec<_>>();
                // tools 尾保险断点（ROUND-02 P2-11）：tools 序列化在 system 之前，
                // 单独打点可在 system 变化时仍命中工具定义前缀。调用方已透传
                // 块级 marker（convert_tool_definition 保留，ROUND-05 P2）时
                // 视为断点位置由上游指定，不再追加。
                let has_marker = converted.iter().any(|tool| tool.cache_control.is_some());
                if !has_marker {
                    if let Some(last) = converted.last_mut() {
                        last.cache_control = Some(json!({ "type": "ephemeral" }));
                    }
                }
                converted
            })
            .filter(|v: &Vec<AnthropicTool>| !v.is_empty());

        // 四槽预算守卫（ROUND-05 P2）：顶层 automatic 占 1 槽，块级断点
        // （tools + system）合计超出剩余 3 槽时从最靠前的 marker 开始剥除。
        enforce_anthropic_cache_breakpoint_budget(tools.as_mut(), &mut system_blocks);

        let system = if system_blocks.is_empty() {
            None
        } else {
            Some(Value::Array(system_blocks))
        };

        let stop_sequences = body.get("stop").and_then(|stop| match stop {
            Value::String(s) if !s.is_empty() => Some(vec![s.clone()]),
            Value::Array(items) => {
                let sequences: Vec<String> = items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect();
                if sequences.is_empty() {
                    None
                } else {
                    Some(sequences)
                }
            }
            _ => None,
        });

        let mut tool_choice = convert_tool_choice(body.get("tool_choice")).or_else(|| {
            if body.get("tool_choice").is_none()
                && tools.as_ref().map(|t| !t.is_empty()).unwrap_or(false)
            {
                Some(json!({"type": "auto"}))
            } else {
                None
            }
        });

        let response_format = body
            .get("response_format")
            .and_then(convert_response_format_for_anthropic);

        // output_config.effort：优先用 body 中的 effort，其次是从旧 manual thinking
        // budget_tokens 派生的近似值（仅新代际安全网路径会产生 derived_effort）
        let mut output_config = body
            .get("effort")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or(derived_effort)
            .map(|effort| json!({ "effort": effort }));

        if let Some(format) = response_format.clone() {
            match &mut output_config {
                Some(Value::Object(map)) => {
                    map.insert("format".to_string(), format);
                }
                _ => {
                    output_config = Some(json!({ "format": format }));
                }
            }
        }

        if has_thinking && tools.as_ref().map(|t| !t.is_empty()).unwrap_or(false) {
            if let Some(choice) = &tool_choice {
                let choice_type = choice.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if !matches!(choice_type, "auto" | "none") {
                    tool_choice = Some(json!({ "type": "auto" }));
                }
            }
        }

        AnthropicRequest {
            model: model.to_string(),
            max_tokens,
            messages,
            system,
            tools,
            tool_choice,
            temperature,
            top_p,
            top_k,
            stop_sequences,
            stream: if stream { Some(true) } else { None },
            response_format: None,
            thinking,
            output_config,
            cache_control: Some(CacheControl {
                cache_type: "ephemeral".to_string(),
            }),
        }
    }
}

impl ProviderAdapter for AnthropicAdapter {
    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        let trimmed = base_url.trim_end_matches('/');
        let url = if trimmed.ends_with("/v1/messages") {
            trimmed.to_string()
        } else if trimmed.ends_with("/messages") {
            trimmed.to_string()
        } else if trimmed.ends_with("/v1") {
            format!("{}/messages", trimmed)
        } else {
            format!("{}/v1/messages", trimmed)
        };

        let request = self.convert_openai_to_anthropic(model, body);

        let body_value = serde_json::to_value(&request)
            .map_err(|e| ProviderError::BuildFailed(format!("构建 Anthropic 请求体失败: {}", e)))?;

        // beta 头清理（研报 02）：prompt caching / tool use / extended thinking 均已 GA，
        // 不再发送 prompt-caching-2024-07-31 / tools-2024-04-04 / thinking-2024-07-31
        // （官方端点对未知 beta 值可能 400）
        let mut beta_features: Vec<&'static str> = Vec::new();
        let has_tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        let generation = claude_generation(model);
        let manual_thinking_enabled = body
            .get("thinking")
            .and_then(|t| t.get("type"))
            .and_then(|v| v.as_str())
            == Some("enabled");
        // interleaved thinking：adaptive 一代自动启用无需 beta 头（研报 02 §3.3）；
        // 仅对旧代际 Claude 4.x 的 manual thinking + 工具场景保留
        if manual_thinking_enabled && has_tools && generation == ClaudeGeneration::Manual {
            let is_claude_4 = model.contains("claude-4")
                || model.contains("claude-opus-4")
                || model.contains("claude-sonnet-4");
            if is_claude_4 {
                beta_features.push("interleaved-thinking-2025-05-14");
            }
        }

        // effort 参数：新代际随 adaptive thinking GA 无需 beta 头；
        // 旧代际（Opus 4.5 时期的 effort 通道）仍保留原 beta 标识
        let has_effort = body.get("effort").is_some();
        if has_effort && generation != ClaudeGeneration::Adaptive {
            beta_features.push("effort-2025-11-24");
        }

        let mut headers = vec![
            ("x-api-key".to_string(), api_key.to_string()),
            ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ];

        if !beta_features.is_empty() {
            headers.push(("anthropic-beta".to_string(), beta_features.join(",")));
        }

        Ok(ProviderRequest {
            url,
            headers,
            body: body_value,
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();

        let Some(payload) = sse_data_payload(line) else {
            return events;
        };
        let payload = payload.trim();
        if payload.is_empty() {
            return events;
        }
        if payload == "[DONE]" {
            events.push(StreamEvent::Done);
            return events;
        }

        let Ok(json_data) = serde_json::from_str::<Value>(payload) else {
            return events;
        };

        let event_type = json_data.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "content_block_delta" => {
                if let Some(delta) = json_data.get("delta") {
                    if delta.get("type").and_then(|v| v.as_str()) == Some("thinking_delta") {
                        if let Some(text) = delta.get("thinking").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                events.push(StreamEvent::ReasoningChunk(text.to_string()));
                            }
                        }
                    } else if delta.get("type").and_then(|v| v.as_str()) == Some("signature_delta")
                    {
                        // thinking 块加密签名，在 content_block_stop 前送达；
                        // display:"omitted" 时思考块只有 signature_delta 没有 thinking_delta。
                        // 按 index 累积，content_block_stop 时整体上抛
                        let index =
                            json_data.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                        if let Some(fragment) = delta.get("signature").and_then(|v| v.as_str()) {
                            if let Ok(mut guard) = self.pending_signatures.lock() {
                                guard.entry(index).or_default().push_str(fragment);
                            }
                        }
                    } else if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            events.push(StreamEvent::ContentChunk(text.to_string()));
                        }
                    } else if delta.get("type").and_then(|v| v.as_str()) == Some("input_json_delta")
                    {
                        let index =
                            json_data.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                        if let Some(fragment) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            if let Ok(mut guard) = self.pending_tool_calls.lock() {
                                if let Some(existing) = guard.get_mut(&index) {
                                    existing.buffer.push_str(fragment);
                                }
                            }
                        }
                    }
                }
            }
            "content_block_start" => {
                if let Some(content_block) =
                    json_data.get("content_block").and_then(|v| v.as_object())
                {
                    if content_block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let index =
                            json_data.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                        let id = content_block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let name = content_block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let base_input = content_block.get("input").cloned();
                        if let Ok(mut guard) = self.pending_tool_calls.lock() {
                            guard.insert(
                                index,
                                PartialToolCall {
                                    id,
                                    name,
                                    buffer: String::new(),
                                    base_input,
                                },
                            );
                        }
                    }
                }
            }
            "content_block_stop" => {
                let index = json_data.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                // thinking 块结束：上抛累积的加密签名（复用 Gemini 的 thought_signature 管道，
                // 上层缓存后在当前工具循环轮内回传）
                if let Ok(mut guard) = self.pending_signatures.lock() {
                    if let Some(signature) = guard.remove(&index) {
                        if !signature.is_empty() {
                            events.push(StreamEvent::ThoughtSignature(signature));
                        }
                    }
                }
                if let Ok(mut guard) = self.pending_tool_calls.lock() {
                    if let Some(tool_call) = guard.remove(&index) {
                        let args_value = tool_call
                            .buffer
                            .trim()
                            .is_empty()
                            .then(|| tool_call.base_input.clone())
                            .flatten()
                            .or_else(|| serde_json::from_str::<Value>(&tool_call.buffer).ok())
                            .unwrap_or_else(|| Value::Object(Map::new()));

                        let args_str =
                            serde_json::to_string(&args_value).unwrap_or_else(|_| "{}".to_string());
                        // 还原工具名称中的特殊字符
                        let restored_name = restore_tool_name_from_anthropic(&tool_call.name);
                        let tool_call_value = json!({
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": restored_name,
                                "arguments": args_str
                            },
                            "index": index
                        });
                        events.push(StreamEvent::ToolCall(tool_call_value));
                    }
                }
            }
            "message_start" => {
                // message_start 含初始 usage（input_tokens 与 cache_read/cache_creation）；
                // message_delta 的 usage 通常只有 output_tokens，缓存完整对象供后续
                // 字段级合并（研报 02 §2.2）
                if let Some(usage) = json_data.get("message").and_then(|m| m.get("usage")) {
                    if let Ok(mut guard) = self.usage_from_start.lock() {
                        *guard = Some(usage.clone());
                    }
                    if let Some(usage_value) = build_usage_event(usage) {
                        events.push(StreamEvent::Usage(usage_value));
                    }
                }
            }
            "message_delta" => {
                if let Some(delta) = json_data.get("delta").and_then(|v| v.as_object()) {
                    if let Some(usage) = delta.get("usage") {
                        if let Some(usage_value) = self.build_merged_usage_event(usage) {
                            events.push(StreamEvent::Usage(usage_value));
                        }
                    }
                    if let Some(stop_reason) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                        match stop_reason {
                            // Fable 5：安全分类器拒绝返回 HTTP 200 + stop_reason:"refusal"
                            // （含 stop_details.category），需向用户提示（研报 02 要点 5）
                            "safety" | "refusal" => {
                                let mut payload = json!({
                                    "type": "content_blocked",
                                    "reason": stop_reason
                                });
                                if let Some(details) = delta.get("stop_details") {
                                    payload["stop_details"] = details.clone();
                                }
                                events.push(StreamEvent::SafetyBlocked(payload));
                            }
                            // Claude 4.5+：输入+输出超过上下文窗口时生成到上限后停止，
                            // 转成可见的结束原因（研报 02 §1.3）
                            "model_context_window_exceeded" => {
                                events.push(StreamEvent::SafetyBlocked(json!({
                                    "type": "provider_error",
                                    "reason": stop_reason,
                                    "details": {
                                        "message": "输出因达到模型上下文窗口上限而被截断 (model_context_window_exceeded)"
                                    }
                                })));
                            }
                            _ => {}
                        }
                    }
                }
                if let Some(usage) = json_data.get("usage") {
                    if let Some(usage_value) = self.build_merged_usage_event(usage) {
                        events.push(StreamEvent::Usage(usage_value));
                    }
                }
            }
            "error" => {
                // SSE error 事件（过载/内部错误等）：必须上报而非静默吞掉，
                // 否则表现为"半截回复无任何提示"（研报 02 §2.2 第 5 条）
                let error_detail = json_data
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| json_data.clone());
                log::error!("[AnthropicAdapter] Stream error event: {}", error_detail);
                events.push(StreamEvent::SafetyBlocked(json!({
                    "type": "provider_error",
                    "reason": "stream_error",
                    "details": error_detail
                })));
                events.push(StreamEvent::Done);
            }
            "message_stop" => {
                if let Ok(mut guard) = self.pending_tool_calls.lock() {
                    guard.clear();
                }
                if let Ok(mut guard) = self.pending_signatures.lock() {
                    guard.clear();
                }
                if let Ok(mut guard) = self.usage_from_start.lock() {
                    *guard = None;
                }
                events.push(StreamEvent::Done);
            }
            _ => {}
        }

        events
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: i32,
    messages: Vec<AnthropicMessage>,
    /// system 提示：text block 数组形态，尾块可携带显式 cache_control 断点
    /// （字符串形态无法打块级断点，ROUND-02 P2-11）
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<AnthropicTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    /// Top-K 采样参数（仅考虑最可能的 K 个 token）
    /// 参考: https://docs.anthropic.com/en/api/messages
    #[serde(skip_serializing_if = "Option::is_none")]
    top_k: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<Value>,
    /// Extended thinking 配置
    /// 参考: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Value>,
    /// Claude 4.5 Opus effort 参数 (output_config.effort)
    /// 参考: https://platform.claude.com/docs/en/build-with-claude/effort
    #[serde(skip_serializing_if = "Option::is_none")]
    output_config: Option<Value>,
    /// Anthropic Prompt Caching — automatic mode (top-level)
    /// 启用后系统自动管理缓存断点，命中后缓存读取成本降低 90%
    /// 参考: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<CacheControl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicMessage {
    role: String,
    content: Vec<AnthropicContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { source: AnthropicImageSource },
    /// Anthropic Extended/Adaptive Thinking 内容块
    /// 用于在多轮对话中传递历史 thinking 内容
    /// 工具调用场景下必须带 signature 原样回传（否则 400），
    /// 新代际 display:"omitted" 时 thinking 为空串、只有 signature
    /// 参考: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        /// 加密签名（signature_delta 累积所得）；为空时不序列化以兼容旧数据
        #[serde(default, skip_serializing_if = "String::is_empty")]
        signature: String,
    },
    /// 安全触发时替代明文思考的加密块，多轮回传时不可过滤（否则 400）
    #[serde(rename = "redacted_thinking")]
    RedactedThinking { data: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Vec<AnthropicToolResultContent>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Prompt Caching — cache_control 标记
/// Anthropic 和 OpenAI 使用相同的 `{"type": "ephemeral"}` 格式
/// 参考:
///   - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
///   - https://platform.openai.com/docs/guides/prompt-caching
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheControl {
    #[serde(rename = "type")]
    cache_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicImageSource {
    #[serde(rename = "type")]
    source_type: String,
    #[serde(rename = "media_type")]
    media_type: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicToolResultContent {
    #[serde(rename = "text")]
    Text { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicTool {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    input_schema: Value,
    /// 显式 prompt caching 断点（tools 尾保险断点，ROUND-02 P2-11）
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<Value>,
}

/// Anthropic Prompt Caching 硬上限：一个请求最多 4 个 cache_control 断点。
/// 参考: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_CACHE_BREAKPOINT_BUDGET: usize = 4;

/// 四槽预算守卫（ROUND-05 P2）：顶层 automatic cache_control 恒注入、占 1 槽，
/// 块级断点（tools + system；消息块转换不承接 cache_control，无第三来源）
/// 合计不得超过剩余 3 槽。超载时按 prompt 序（tools 序列化在 system 之前）
/// 从最靠前的 marker 开始剥除——越靠后的断点覆盖的稳定前缀越长、
/// 命中价值越高，优先保留尾部标记。
fn enforce_anthropic_cache_breakpoint_budget(
    mut tools: Option<&mut Vec<AnthropicTool>>,
    system_blocks: &mut [Value],
) {
    let block_budget = ANTHROPIC_CACHE_BREAKPOINT_BUDGET - 1; // automatic 占 1 槽

    let tool_marker_count = tools.as_deref().map_or(0, |tools| {
        tools
            .iter()
            .filter(|tool| tool.cache_control.is_some())
            .count()
    });
    let system_marker_count = system_blocks
        .iter()
        .filter(|block| block.get("cache_control").is_some())
        .count();
    let mut overflow = (tool_marker_count + system_marker_count).saturating_sub(block_budget);
    if overflow == 0 {
        return;
    }

    if let Some(tools) = tools.as_deref_mut() {
        for tool in tools.iter_mut() {
            if overflow == 0 {
                break;
            }
            if tool.cache_control.take().is_some() {
                overflow -= 1;
            }
        }
    }
    for block in system_blocks.iter_mut() {
        if overflow == 0 {
            break;
        }
        if let Some(map) = block.as_object_mut() {
            if map.remove("cache_control").is_some() {
                overflow -= 1;
            }
        }
    }
}

/// 把 system/developer 消息内容规整为 Anthropic system block 数组，
/// 保留调用方已打的块级 cache_control 标记（不要剥掉，ROUND-02 P2-11）。
fn extract_system_text_blocks(message: &Value) -> Vec<Value> {
    let Some(content) = message.get("content") else {
        return Vec::new();
    };
    match content {
        Value::String(s) => vec![json!({ "type": "text", "text": s })],
        Value::Array(parts) => {
            let mut out = Vec::new();
            for part in parts {
                if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        let mut block = json!({ "type": "text", "text": text });
                        if let Some(cache_control) = part.get("cache_control") {
                            block["cache_control"] = cache_control.clone();
                        }
                        out.push(block);
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

fn convert_user_message(message: &Value) -> Option<AnthropicMessage> {
    let content = message.get("content").cloned()?;
    let mut blocks = Vec::new();
    match content {
        Value::String(s) if !s.is_empty() => {
            blocks.push(AnthropicContentBlock::Text { text: s });
        }
        Value::Array(parts) => {
            for part in parts {
                match part.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                blocks.push(AnthropicContentBlock::Text {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    Some("image_url") => {
                        if let Some(url_obj) = part.get("image_url").and_then(|v| v.as_object()) {
                            if let Some(url) = url_obj.get("url").and_then(|v| v.as_str()) {
                                if let Some((media_type, data)) = create_base64_payload(url) {
                                    blocks.push(AnthropicContentBlock::Image {
                                        source: AnthropicImageSource {
                                            source_type: "base64".to_string(),
                                            media_type,
                                            data,
                                        },
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    if blocks.is_empty() {
        None
    } else {
        Some(AnthropicMessage {
            role: "user".to_string(),
            content: blocks,
        })
    }
}

fn convert_assistant_message(message: &Value) -> Option<AnthropicMessage> {
    let mut blocks = Vec::new();

    if let Some(content_value) = message.get("content") {
        match content_value {
            Value::String(text) if !text.is_empty() => {
                blocks.push(AnthropicContentBlock::Text { text: text.clone() });
            }
            Value::Array(parts) => {
                for part in parts {
                    let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match part_type {
                        // 处理 thinking 块（Extended/Adaptive Thinking 多轮对话）
                        // 必须带 signature 原样回传；新代际 display:"omitted" 时
                        // thinking 为空串但有 signature，同样不能丢弃（研报 02 §3.2）
                        "thinking" => {
                            let thinking = part
                                .get("thinking")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let signature = part
                                .get("signature")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            if !thinking.is_empty() || !signature.is_empty() {
                                blocks.push(AnthropicContentBlock::Thinking {
                                    thinking: thinking.to_string(),
                                    signature: signature.to_string(),
                                });
                            }
                        }
                        // redacted_thinking 块必须原样回传，过滤会触发 400
                        // `thinking blocks ... cannot be modified`（研报 02 坑 3）
                        "redacted_thinking" => {
                            if let Some(data) = part.get("data").and_then(|v| v.as_str()) {
                                blocks.push(AnthropicContentBlock::RedactedThinking {
                                    data: data.to_string(),
                                });
                            }
                        }
                        // 处理 text 块
                        "text" => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    blocks.push(AnthropicContentBlock::Text {
                                        text: text.to_string(),
                                    });
                                }
                            }
                        }
                        "tool_use" => {
                            let id = part
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("tool_call_{}", Uuid::new_v4()));
                            let name = part
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input = part
                                .get("input")
                                .cloned()
                                .unwrap_or_else(|| Value::Object(Map::new()));
                            blocks.push(AnthropicContentBlock::ToolUse { id, name, input });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for tool_call in tool_calls {
            if let Some(function) = tool_call.get("function") {
                let name = function
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let id = tool_call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("tool_call_{}", Uuid::new_v4()));
                let arguments_raw = function
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}");
                let parsed_args = serde_json::from_str::<Value>(arguments_raw)
                    .unwrap_or_else(|_| Value::Object(Map::new()));
                blocks.push(AnthropicContentBlock::ToolUse {
                    id,
                    name,
                    input: parsed_args,
                });
            }
        }
    }

    // 消息级 thought_signature（流解析捕获后经 thought_signature 管道注入）：
    // 附加到 thinking 块回传。若消息只有 tool_use 而没有 thinking 块
    // （新代际 display:"omitted" 思考文本为空被上游丢弃），需补一个
    // 空文本 + signature 的 thinking 块且置于 tool_use 之前，否则 400
    if let Some(signature) = message
        .get("thought_signature")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let mut attached = false;
        for block in blocks.iter_mut() {
            if let AnthropicContentBlock::Thinking {
                signature: block_signature,
                ..
            } = block
            {
                if block_signature.is_empty() {
                    *block_signature = signature.to_string();
                }
                attached = true;
                break;
            }
        }
        if !attached {
            let has_tool_use = blocks
                .iter()
                .any(|b| matches!(b, AnthropicContentBlock::ToolUse { .. }));
            if has_tool_use {
                blocks.insert(
                    0,
                    AnthropicContentBlock::Thinking {
                        thinking: String::new(),
                        signature: signature.to_string(),
                    },
                );
            }
        }
    }

    if blocks.is_empty() {
        None
    } else {
        Some(AnthropicMessage {
            role: "assistant".to_string(),
            content: blocks,
        })
    }
}

fn convert_tool_result_message(message: &Value) -> Option<AnthropicMessage> {
    let tool_use_id = message
        .get("tool_call_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if tool_use_id.is_empty() {
        return None;
    }

    let mut parts: Vec<AnthropicToolResultContent> = Vec::new();
    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) if !text.is_empty() => {
                parts.push(AnthropicToolResultContent::Text { text: text.clone() });
            }
            Value::Array(items) => {
                for item in items {
                    if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                parts.push(AnthropicToolResultContent::Text {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let block = AnthropicContentBlock::ToolResult {
        tool_use_id,
        content: if parts.is_empty() { None } else { Some(parts) },
        is_error: message.get("is_error").and_then(|v| v.as_bool()),
    };

    Some(AnthropicMessage {
        role: "user".to_string(),
        content: vec![block],
    })
}

/// 合并文本内容块
/// 将新的内容块合并到现有内容列表中
/// 对于多个 text 块，合并为单个 text 块（某些代理服务不支持多个 text 块）
fn merge_text_content(
    existing: &mut Vec<AnthropicContentBlock>,
    new_content: Vec<AnthropicContentBlock>,
) {
    for block in new_content {
        match block {
            AnthropicContentBlock::Text { text } => {
                // 尝试找到现有的 text 块并合并
                let mut merged = false;
                for existing_block in existing.iter_mut() {
                    if let AnthropicContentBlock::Text {
                        text: ref mut existing_text,
                    } = existing_block
                    {
                        existing_text.push_str("\n\n");
                        existing_text.push_str(&text);
                        merged = true;
                        break;
                    }
                }
                if !merged {
                    existing.push(AnthropicContentBlock::Text { text });
                }
            }
            // 其他类型的块直接添加
            other => existing.push(other),
        }
    }
}

/// 将工具名称转换为 Anthropic 兼容格式
/// Anthropic 工具名称只允许字母、数字、下划线和连字符
/// 🔧 2026-02: MCP 工具名可能含 `:` 等特殊字符，统一替换为 `_`
fn sanitize_tool_name_for_anthropic(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 将 Anthropic 返回的工具名称还原为原始格式
/// 🔧 2026-01: 工具命名空间已统一为 'builtin-'，无需还原
pub fn restore_tool_name_from_anthropic(name: &str) -> String {
    name.to_string()
}

fn convert_tool_definition(value: &Value) -> Option<AnthropicTool> {
    if value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("function")
        != "function"
    {
        return None;
    }
    let function = value.get("function")?;
    let raw_name = function.get("name")?.as_str()?;
    // 将冒号等特殊字符转换为占位符
    let name = sanitize_tool_name_for_anthropic(raw_name);
    let description = function
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Anthropic 要求 input_schema 必须有 "type": "object"
    // 参考: https://docs.anthropic.com/en/api/messages
    let mut input_schema = function
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    // 确保 input_schema 有 type 字段
    if input_schema.get("type").is_none() {
        if let Value::Object(ref mut map) = input_schema {
            map.insert("type".to_string(), json!("object"));
        }
    }
    // ROUND-05 P2：透传调用方在 OpenAI 形状 tools[] 条目上打的块级缓存标记。
    // 此前恒 None，调用方 marker 被静默丢弃，convert_openai_to_anthropic 的
    // has_marker 检查是永假死分支，尾部保险断点无条件追加。
    let cache_control = value.get("cache_control").cloned();
    Some(AnthropicTool {
        name,
        description,
        input_schema,
        cache_control,
    })
}

fn convert_tool_choice(choice: Option<&Value>) -> Option<Value> {
    let Some(choice_value) = choice else {
        return None;
    };

    if let Some(s) = choice_value.as_str() {
        return match s {
            "auto" => Some(json!({"type": "auto"})),
            "none" => Some(json!({"type": "none"})),
            "any" => Some(json!({"type": "any"})),
            "tool" => None,
            _ => None,
        };
    }

    if let Some(obj) = choice_value.as_object() {
        if let Some(choice_type) = obj.get("type").and_then(|v| v.as_str()) {
            match choice_type {
                "auto" => return Some(json!({"type": "auto"})),
                "none" => return Some(json!({"type": "none"})),
                "any" => return Some(json!({"type": "any"})),
                "function" | "tool" => {
                    let name = obj
                        .get("name")
                        .and_then(|v| v.as_str())
                        .or_else(|| {
                            obj.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|v| v.as_str())
                        })
                        .map(|s| s.to_string());
                    if let Some(name) = name {
                        return Some(json!({"type": "tool", "name": name }));
                    }
                }
                _ => {}
            }
        }

        if let Some(function_name) = obj.get("function").and_then(|f| f.as_str()) {
            return Some(json!({"type": "tool", "name": function_name }));
        }
    }

    None
}

fn create_base64_payload(url: &str) -> Option<(String, String)> {
    if url.starts_with("data:") {
        let parts: Vec<&str> = url.splitn(2, ',').collect();
        if parts.len() != 2 {
            return None;
        }
        let header = parts[0];
        let data = parts[1].to_string();
        let media_type = header
            .trim_start_matches("data:")
            .trim_end_matches(";base64")
            .to_string();
        return Some((media_type, data));
    }

    if url.starts_with("http://") || url.starts_with("https://") {
        if let Some((bytes, mime_hint)) = fetch_binary_with_cache(url) {
            let mime = mime_hint.unwrap_or_else(|| "application/octet-stream".to_string());
            let data = general_purpose::STANDARD.encode(bytes);
            return Some((mime, data));
        }
    }

    None
}

fn convert_response_format_for_anthropic(value: &Value) -> Option<Value> {
    let obj = match value {
        Value::Object(map) => map,
        _ => return Some(value.clone()),
    };

    let format_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match format_type {
        "json_object" => Some(json!({ "type": "json" })),
        "json_schema" => {
            // GA 形态（研报 02 §3.5）：output_config.format = {type:"json_schema", schema:{...}}
            // OpenAI CC 的 response_format.json_schema 是 {name, schema, strict} 包装，
            // 需要提取内层 schema；字段名必须是 schema 而非 json_schema
            if let Some(wrapper) = obj.get("json_schema") {
                let schema = wrapper.get("schema").cloned().unwrap_or_else(|| {
                    // 已经是裸 schema（无 OpenAI 包装）时直接使用
                    wrapper.clone()
                });
                Some(json!({ "type": "json_schema", "schema": schema }))
            } else {
                Some(json!({ "type": "json" }))
            }
        }
        _ => Some(value.clone()),
    }
}

fn build_usage_event(usage: &Value) -> Option<Value> {
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or((input_tokens + output_tokens) as i64) as i32;
    // 缓存命中 token（业界最佳实践 LiteLLM 对齐）
    // cache_creation_input_tokens 是 Anthropic 计费元数据，不计入缓存命中
    // 使用 max() 防中转站重复返回多种格式
    let anthropic_cache_hit = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let openai_cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    // OpenAI/DeepSeek Responses API: input_tokens_details.cached_tokens
    let responses_cached = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let deepseek_cached = usage
        .get("prompt_cache_hit_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let gemini_cached = usage
        .get("cached_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let cached_tokens = [
        anthropic_cache_hit,
        openai_cached,
        responses_cached,
        deepseek_cached,
        gemini_cached,
    ]
    .into_iter()
    .flatten()
    .max();

    // 缓存写入 token（计费元数据，不计入命中；观测用）
    // Anthropic cache_creation_input_tokens / Responses input_tokens_details.cache_write_tokens
    let cache_write_tokens = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let responses_cache_write = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cache_write_tokens"))
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let gateway_cache_write = usage
        .get("cache_write_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0);
    let cache_write_tokens = [
        cache_write_tokens,
        responses_cache_write,
        gateway_cache_write,
    ]
    .into_iter()
    .flatten()
    .max();

    // reasoning token：顶层 / OpenAI CC completion_tokens_details / Responses output_tokens_details
    let reasoning_tokens = usage
        .get("reasoning_tokens")
        .or_else(|| {
            usage
                .get("completion_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
        })
        .or_else(|| {
            usage
                .get("output_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
        })
        .and_then(|v| v.as_i64());

    Some(json!({
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "cached_tokens": cached_tokens.map(|v| json!(v)).unwrap_or(Value::Null),
        "cache_write_tokens": cache_write_tokens.map(|v| json!(v)).unwrap_or(Value::Null),
        "reasoning_tokens": reasoning_tokens.map(|v| json!(v)).unwrap_or(Value::Null),
        "total_tokens_openai": total_tokens,
        "original": usage
    }))
}

pub fn convert_anthropic_response_to_openai(response: &Value, model: &str) -> Option<Value> {
    if response.get("type").and_then(|v| v.as_str()) != Some("message") {
        return None;
    }

    let content = response.get("content").and_then(|v| v.as_array())?;
    let mut text_segments: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    for (idx, block) in content.iter().enumerate() {
        match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "text" => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        text_segments.push(text.to_string());
                    }
                }
            }
            "tool_use" => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("tool_call_{}", Uuid::new_v4()));
                let raw_name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                // 还原工具名称中的特殊字符
                let name = restore_tool_name_from_anthropic(raw_name);
                let input_value = block
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let args_str =
                    serde_json::to_string(&input_value).unwrap_or_else(|_| "{}".to_string());
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args_str
                    },
                    "index": idx
                }));
            }
            _ => {}
        }
    }

    let mut message = json!({
        "role": "assistant",
        "content": text_segments.join("")
    });

    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }

    let stop_reason = response.get("stop_reason").and_then(|v| v.as_str());
    let finish_reason = match stop_reason {
        Some("tool_use") => "tool_calls",
        Some("max_tokens") => "length",
        Some("end_turn") => "stop",
        Some(reason) => reason,
        None => "stop",
    };

    let usage_source = response
        .get("usage")
        .or_else(|| response.get("usage_metadata"));
    let usage_value = usage_source.map(|usage| {
        let prompt_tokens = usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        let completion_tokens = usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        let total_tokens = usage
            .get("total_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or((prompt_tokens + completion_tokens) as i64)
            as i32;
        let mut usage_obj = json!({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens
        });
        // 非流式响应透传缓存字段，供 parse_api_usage / extract_usage_tokens 观测
        // cache_read_input_tokens = 缓存命中；cache_creation_input_tokens = 缓存写入
        if let Some(cache_read) = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_i64())
        {
            usage_obj["cache_read_input_tokens"] = json!(cache_read);
        }
        if let Some(cache_creation) = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_i64())
        {
            usage_obj["cache_creation_input_tokens"] = json!(cache_creation);
        }
        usage_obj
    });

    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let id = response
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("anthropic-msg-{}", Uuid::new_v4()));

    let mut result = json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason
            }
        ]
    });

    if let Some(usage) = usage_value {
        result["usage"] = usage;
    }

    Some(result)
}

// Google Gemini 适配（中转层）：对外保持 OpenAI 兼容，内部完成 OpenAI<->Gemini 转换
pub struct GeminiAdapter {
    pending_tool_calls: Arc<Mutex<HashMap<i64, (String, String)>>>,
}

impl Default for GeminiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiAdapter {
    pub fn new() -> Self {
        Self {
            pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl ProviderAdapter for GeminiAdapter {
    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        // 从model参数中提取API版本信息（如果以版本前缀开头）
        // 格式: "v1beta:gemini-pro" 或 "v1:gemini-pro"，如果没有前缀则使用v1
        let (mut api_version, actual_model) = if model.contains(':') {
            let parts: Vec<&str> = model.splitn(2, ':').collect();
            if parts.len() == 2 && (parts[0] == "v1" || parts[0] == "v1beta") {
                (Some(parts[0]), parts[1])
            } else {
                (None, model)
            }
        } else {
            (None, model)
        };

        // 新增：若请求体显式带有 gemini_api_version，则优先采用
        // 该字段由 LLMManager::apply_reasoning_config 在 model_adapter=google|gemini 时写入
        if api_version.is_none() {
            if let Some(ver) = body.get("gemini_api_version").and_then(|v| v.as_str()) {
                if ver == "v1" || ver == "v1beta" {
                    api_version = Some(ver);
                }
            }
        }

        // 通过转换器构建真正的 Gemini 请求（URL、Header、Body）
        let preq = crate::adapters::gemini_openai_converter::build_gemini_request_with_version(
            base_url,
            api_key,
            actual_model,
            body,
            api_version,
        )
        .map_err(|e| ProviderError::BuildFailed(format!("Gemini 请求构建失败: {}", e)))?;

        // 映射为 providers 层的 ProviderRequest（字段一致）
        Ok(ProviderRequest {
            url: preq.url,
            headers: preq.headers,
            body: preq.body,
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        // 使用转换器的流式解析，然后映射到 providers 层的 StreamEvent
        let events = crate::adapters::gemini_openai_converter::parse_gemini_stream_line(
            line,
            &self.pending_tool_calls,
        );
        let mut out = Vec::new();
        for e in events {
            match e {
                crate::adapters::gemini_openai_converter::StreamEvent::ContentChunk(s) => {
                    out.push(StreamEvent::ContentChunk(s))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::ReasoningChunk(s) => {
                    out.push(StreamEvent::ReasoningChunk(s))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::ThoughtSignature(s) => {
                    out.push(StreamEvent::ThoughtSignature(s))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::ToolCall(v) => {
                    out.push(StreamEvent::ToolCall(v))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::Usage(v) => {
                    out.push(StreamEvent::Usage(v))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::SafetyBlocked(v) => {
                    out.push(StreamEvent::SafetyBlocked(v))
                }
                crate::adapters::gemini_openai_converter::StreamEvent::Done => {
                    out.push(StreamEvent::Done)
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod wave2_a_anthropic_budget_tests;
#[cfg(test)]
mod wave2_a_prefix_snapshot_tests;

#[cfg(test)]
mod tests {
    use super::{
        build_usage_event, convert_anthropic_response_to_openai, is_meaningful_openai_tool_delta,
        sanitize_openai_request_body, AnthropicAdapter, OpenAIAdapter, OpenAIResponsesAdapter,
        ProviderAdapter, StreamEvent,
    };
    use serde_json::{json, Value};

    #[test]
    fn stream_completion_requirement_matches_adapter_protocols() {
        // OpenAI Responses 与 Chat Completions 均有协议级终止事件
        // （response.completed / [DONE]+finish_reason），传输层 EOF 不算成功；
        // Anthropic 由 message_stop 驱动 Done，不要求显式完成标记
        assert!(OpenAIResponsesAdapter::new().requires_explicit_stream_completion());
        assert!(OpenAIAdapter::new().requires_explicit_stream_completion());
        assert!(!AnthropicAdapter::new().requires_explicit_stream_completion());
    }

    #[test]
    fn openai_tool_delta_filter_skips_empty_fragments() {
        assert!(!is_meaningful_openai_tool_delta(&json!({
            "index": 0,
            "id": "",
            "function": {}
        })));

        assert!(!is_meaningful_openai_tool_delta(&json!({
            "id": "",
            "function": { "name": "", "arguments": null }
        })));
    }

    #[test]
    fn openai_adapter_parse_stream_keeps_argument_deltas_and_skips_empty_tool_fragments() {
        let adapter = OpenAIAdapter::new();

        let skipped = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{}}]}}]}"#,
        );
        assert!(skipped.is_empty());

        let kept = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}"#,
        );
        assert!(matches!(kept.first(), Some(StreamEvent::ToolCall(v)) if v["index"] == json!(0)));
    }

    #[test]
    fn openai_adapter_parse_stream_preserves_empty_reasoning_content() {
        let adapter = OpenAIAdapter::new();

        let events =
            adapter.parse_stream(r#"data: {"choices":[{"delta":{"reasoning_content":""}}]}"#);

        assert!(
            matches!(events.first(), Some(StreamEvent::ReasoningChunk(reasoning)) if reasoning.is_empty())
        );
    }

    #[test]
    fn openai_adapter_parse_stream_accepts_data_prefix_without_space() {
        // SSE 规范允许 "data:" 后不带空格，部分供应商/中转站省略空格
        let adapter = OpenAIAdapter::new();

        let events = adapter.parse_stream(r#"data:{"choices":[{"delta":{"content":"hi"}}]}"#);
        assert!(matches!(events.first(), Some(StreamEvent::ContentChunk(c)) if c == "hi"));

        let done = adapter.parse_stream("data:[DONE]");
        assert!(matches!(done.first(), Some(StreamEvent::Done)));
    }

    #[test]
    fn openai_adapter_parse_stream_accepts_bare_ndjson() {
        let events =
            OpenAIAdapter::new().parse_stream(r#"{"choices":[{"delta":{"content":"ndjson"}}]}"#);

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(content)) if content == "ndjson"
        ));
    }

    #[test]
    fn openai_adapter_emits_usage_before_done_for_official_chunk_sequence() {
        let adapter = OpenAIAdapter::new();
        let mut events = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"content":"tail","reasoning_content":"thought","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, StreamEvent::Done)),
            "finish_reason completes the choice, not the stream"
        );
        events.extend(adapter.parse_stream(
            r#"data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}"#,
        ));
        events.extend(adapter.parse_stream("data: [DONE]"));

        assert_eq!(events.len(), 5);
        assert!(matches!(&events[0], StreamEvent::ContentChunk(content) if content == "tail"));
        assert!(
            matches!(&events[1], StreamEvent::ReasoningChunk(reasoning) if reasoning == "thought")
        );
        assert!(matches!(&events[2], StreamEvent::ToolCall(tool) if tool["id"] == json!("call_1")));
        assert!(
            matches!(&events[3], StreamEvent::Usage(usage) if usage["total_tokens"] == json!(5))
        );
        assert!(matches!(&events[4], StreamEvent::Done));
    }

    #[test]
    fn openai_adapter_bare_ndjson_finish_reason_completes_at_eof() {
        let adapter = OpenAIAdapter::new();
        let events = adapter.parse_stream(
            r#"{"choices":[{"index":0,"delta":{"content":"ndjson tail"},"finish_reason":"stop"}]}"#,
        );

        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], StreamEvent::ContentChunk(content) if content == "ndjson tail")
        );
        assert!(matches!(
            adapter.finish_stream().first(),
            Some(StreamEvent::Done)
        ));
        assert!(
            adapter.finish_stream().is_empty(),
            "EOF completion state must be consumed exactly once"
        );
    }

    #[test]
    fn openai_adapter_finish_reason_ignores_empty_and_partial_multi_choice_completion() {
        for finish_reason in [Value::Null, json!(""), json!("   ")] {
            let chunk = json!({
                "choices": [{
                    "index": 0,
                    "delta": { "content": "tail" },
                    "finish_reason": finish_reason
                }]
            });
            let events = OpenAIAdapter::new().parse_stream(&format!("data: {chunk}"));
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, StreamEvent::Done)),
                "null or empty finish_reason must not finish the stream"
            );
        }

        let partially_finished = OpenAIAdapter::new().parse_stream(
            r#"data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":"stop"},{"index":1,"delta":{"content":"second"},"finish_reason":null}]}"#,
        );
        assert!(
            !partially_finished
                .iter()
                .any(|event| matches!(event, StreamEvent::Done)),
            "one finished choice must not terminate other choices in the same chunk"
        );

        let adapter = OpenAIAdapter::new();
        let all_finished = adapter.parse_stream(
            r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"length"}]}"#,
        );
        assert!(!all_finished
            .iter()
            .any(|event| matches!(event, StreamEvent::Done)));
        assert!(matches!(
            adapter.finish_stream().first(),
            Some(StreamEvent::Done)
        ));
    }

    /// ROUND-05 P1：choice 完成（finish_reason）≠ 流完成。finish_reason 之后
    /// 官方序列仍会推送 usage-only 块（include_usage 请求来的缓存命中数据），
    /// 部分网关还会补发内容块；事件序必须完整保序，Done 只由 [DONE] 触发，
    /// 且 [DONE] 消费完成状态后 EOF 不再补发 Done。
    #[test]
    fn openai_adapter_choice_completion_keeps_event_sequence_until_done_marker() {
        let adapter = OpenAIAdapter::new();
        let mut events = adapter.parse_stream(
            r#"data: {"choices":[{"index":0,"delta":{"content":"early"},"finish_reason":"stop"}]}"#,
        );
        // finish_reason 之后仍可能有后续内容块（宽松网关行为）
        events.extend(
            adapter.parse_stream(r#"data: {"choices":[{"index":0,"delta":{"content":" late"}}]}"#),
        );
        // 官方 include_usage 序列：[DONE] 前的 usage-only 块（choices 为空）
        events.extend(adapter.parse_stream(
            r#"data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":8}}}"#,
        ));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, StreamEvent::Done)),
            "choice completion must not be treated as stream completion"
        );
        events.extend(adapter.parse_stream("data: [DONE]"));

        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0], StreamEvent::ContentChunk(content) if content == "early"));
        assert!(matches!(&events[1], StreamEvent::ContentChunk(content) if content == " late"));
        assert!(matches!(
            &events[2],
            StreamEvent::Usage(usage)
                if usage["total_tokens"] == json!(18)
                    && usage["prompt_tokens_details"]["cached_tokens"] == json!(8)
        ));
        assert!(matches!(&events[3], StreamEvent::Done));
        // [DONE] 已清空完成状态，EOF 收口不得重复发 Done
        assert!(adapter.finish_stream().is_empty());
    }

    #[test]
    fn openai_adapter_parse_stream_handles_content_block_arrays() {
        // Mistral 推理模式：delta.content 为 ThinkChunk/TextChunk 块数组（研报 04 要点 4）
        let adapter = OpenAIAdapter::new();

        let events = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"let me think"}]},{"type":"text","text":"the answer"}]}}]}"#,
        );

        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], StreamEvent::ReasoningChunk(s) if s == "let me think"),
            "thinking 块应作为 reasoning 发送"
        );
        assert!(
            matches!(&events[1], StreamEvent::ContentChunk(s) if s == "the answer"),
            "text 块应拼接为正文"
        );

        // ThinkChunk 的 thinking 字段为字符串的形态也要兼容
        let string_thinking = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":"raw thought"}]}}]}"#,
        );
        assert!(
            matches!(string_thinking.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "raw thought")
        );
    }

    #[test]
    fn openai_adapter_parse_stream_handles_reasoning_field_variants() {
        let adapter = OpenAIAdapter::new();

        // (c) delta.reasoning 字符串：Together/Groq(parsed)/Cerebras/阶跃
        let reasoning =
            adapter.parse_stream(r#"data: {"choices":[{"delta":{"reasoning":"thinking hard"}}]}"#);
        assert!(
            matches!(reasoning.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "thinking hard")
        );

        // (a) delta.reasoning_details 数组：OpenRouter（取 text 内容）
        let details = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"detail text","format":"anthropic-claude-v1"},{"type":"reasoning.encrypted","data":"opaque","format":"anthropic-claude-v1"}]}}]}"#,
        );
        assert_eq!(details.len(), 1, "encrypted 块无明文，只取 text 内容");
        assert!(
            matches!(details.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "detail text")
        );

        // reasoning_content 与 reasoning 同时出现时不重复推送
        let both = adapter.parse_stream(
            r#"data: {"choices":[{"delta":{"reasoning_content":"same text","reasoning":"same text"}}]}"#,
        );
        assert_eq!(both.len(), 1);
        assert!(matches!(both.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "same text"));
    }

    #[test]
    fn openai_adapter_parse_stream_reports_injected_error_objects() {
        // OpenRouter 等平台会在流中注入 {"error":{...}}（研报 09 §1），不能静默忽略
        let adapter = OpenAIAdapter::new();

        let events = adapter
            .parse_stream(r#"data: {"error":{"code":402,"message":"Insufficient credits"}}"#);

        assert!(matches!(
            events.first(),
            Some(StreamEvent::SafetyBlocked(v))
                if v["type"] == json!("provider_error")
                    && v["details"]["message"] == json!("Insufficient credits")
        ));
        assert!(matches!(events.last(), Some(StreamEvent::Done)));
    }

    #[test]
    fn openai_adapter_build_request_keeps_nested_tool_choice_shape() {
        // CC 协议要求 tool_choice 指定函数时保持嵌套形状（r2 报告 P1-15）
        let adapter = OpenAIAdapter::new();
        let body = json!({
            "model": "gpt-4o-mini",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "lookup_weather" }
            }
        });

        let request = adapter
            .build_request(
                "https://api.openai.com/v1",
                "test-key",
                "gpt-4o-mini",
                &body,
            )
            .expect("request should build");

        assert_eq!(request.body["tool_choice"]["type"], json!("function"));
        assert_eq!(
            request.body["tool_choice"]["function"]["name"],
            json!("lookup_weather")
        );
        assert!(request.body["tool_choice"].get("name").is_none());
    }

    #[test]
    fn openai_adapters_do_not_duplicate_complete_endpoint_paths() {
        let chat = OpenAIAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/chat/completions/",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("chat request should build");
        assert_eq!(chat.url, "https://proxy.example.com/v1/chat/completions");

        let responses = OpenAIResponsesAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/responses/",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("responses request should build");
        assert_eq!(responses.url, "https://proxy.example.com/v1/responses");

        let responses_from_root = OpenAIResponsesAdapter::new()
            .build_request(
                "https://proxy.example.com/v1",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("responses request should build");
        assert_eq!(
            responses_from_root.url,
            "https://proxy.example.com/v1/responses"
        );
    }

    #[test]
    fn openai_adapters_insert_endpoint_before_query_and_fragment() {
        let chat = OpenAIAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/?token=signed#tenant-a",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("chat request should build");
        assert_eq!(
            chat.url,
            "https://proxy.example.com/v1/chat/completions?token=signed#tenant-a"
        );

        let responses = OpenAIResponsesAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/responses/?token=signed#tenant-a",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("responses request should build");
        assert_eq!(
            responses.url,
            "https://proxy.example.com/v1/responses?token=signed#tenant-a"
        );
    }

    #[test]
    fn openai_adapters_replace_cross_protocol_endpoints_and_preserve_url_tail() {
        let chat = OpenAIAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/responses/?token=signed#tenant-a",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("chat request should build");
        assert_eq!(
            chat.url,
            "https://proxy.example.com/v1/chat/completions?token=signed#tenant-a"
        );

        let responses = OpenAIResponsesAdapter::new()
            .build_request(
                "https://proxy.example.com/v1/chat/completions/?token=signed#tenant-a",
                "test-key",
                "gpt-test",
                &json!({"messages": []}),
            )
            .expect("responses request should build");
        assert_eq!(
            responses.url,
            "https://proxy.example.com/v1/responses?token=signed#tenant-a"
        );
    }

    #[test]
    fn sanitize_openai_request_body_passes_through_non_function_tools() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                { "type": "web_search" },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ]
        });

        let sanitized = sanitize_openai_request_body(&body);
        let tools = sanitized["tools"]
            .as_array()
            .expect("tools should be array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0], json!({ "type": "web_search" }));
        assert_eq!(tools[1]["function"]["name"], json!("lookup_weather"));
    }

    #[test]
    fn openai_responses_adapter_converts_messages_and_reasoning() {
        let body = json!({
            "messages": [
                { "role": "system", "content": "You are helpful." },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "hi" },
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,abc" } }
                    ]
                }
            ],
            "max_tokens": 256,
            "temperature": 0.2,
            "response_format": { "type": "json_object" }
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);

        assert_eq!(payload["stream"], json!(true));
        assert_eq!(payload["instructions"], json!("You are helpful."));
        assert_eq!(payload["reasoning"]["summary"], json!("auto"));
        assert_eq!(payload["max_output_tokens"], json!(256));
        assert_eq!(payload["temperature"], json!(0.2));
        assert_eq!(payload["text"]["format"]["type"], json!("json_object"));

        let input = payload["input"].as_array().expect("input should be array");
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], json!("user"));
        assert_eq!(input[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[0]["content"][1]["type"], json!("input_image"));
    }

    #[test]
    fn openai_responses_adapter_maps_reasoning_effort_and_verbosity() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "reasoning_effort": "high",
            "verbosity": "low"
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5", &body);

        assert_eq!(payload["reasoning"]["effort"], json!("high"));
        assert_eq!(payload["reasoning"]["summary"], json!("auto"));
        assert_eq!(payload["text"]["verbosity"], json!("low"));
    }

    #[test]
    fn openai_responses_adapter_maps_runtime_off_to_reasoning_none() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "reasoning_effort": "none"
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5", &body);

        assert_eq!(payload["reasoning"]["effort"], json!("none"));
        assert_eq!(payload["reasoning"]["summary"], json!("auto"));
    }

    #[test]
    fn openai_responses_adapter_preserves_known_provider_thinking_extensions() {
        for (model, base_url, extension) in [
            (
                "qwen3.7-plus",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                json!({ "enable_thinking": true, "thinking_budget": 8192 }),
            ),
            (
                "doubao-seed-1-6-thinking",
                "https://ark.cn-beijing.volces.com/api/v3",
                json!({ "thinking": { "type": "enabled" } }),
            ),
            (
                "ernie-5.0-thinking",
                "https://qianfan.baidubce.com/v2",
                json!({ "thinking": { "type": "enabled" } }),
            ),
        ] {
            let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
            body.as_object_mut().expect("body should be object").extend(
                extension
                    .as_object()
                    .expect("extension should be object")
                    .clone(),
            );

            let payload = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
                model, &body, base_url,
            );
            for key in ["thinking", "enable_thinking", "thinking_budget"] {
                assert_eq!(
                    payload.get(key),
                    extension.get(key),
                    "model={model}, key={key}"
                );
            }
        }
    }

    #[test]
    fn openai_responses_adapter_drops_provider_thinking_extensions_for_openai() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
            "enable_thinking": true,
            "thinking_budget": 8192
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let deployment_alias_payload =
            OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
                "ep-openai-alias",
                &body,
                "https://api.openai.com/v1",
            );

        for key in ["thinking", "enable_thinking", "thinking_budget"] {
            assert!(!payload.as_object().unwrap().contains_key(key));
            assert!(!deployment_alias_payload
                .as_object()
                .unwrap()
                .contains_key(key));
        }
    }

    #[test]
    fn openai_responses_adapter_preserves_extensions_for_provider_deployment_alias() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled" },
            "thinking_budget": 8192
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "ep-20260714-abcd",
            &body,
            "https://ark.cn-beijing.volces.com/api/v3",
        );

        assert_eq!(payload["thinking"]["type"], json!("enabled"));
        assert_eq!(payload["thinking_budget"], json!(8192));
    }

    #[test]
    fn openai_responses_adapter_preserves_extensions_for_dashscope_intl() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "enable_thinking": true,
            "thinking_budget": 8192
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "deployment-alias",
            &body,
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        );

        assert_eq!(payload["enable_thinking"], json!(true));
        assert_eq!(payload["thinking_budget"], json!(8192));
    }

    #[test]
    fn openai_responses_adapter_preserves_extensions_for_qwen_workspace_maas() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "enable_thinking": true,
            "thinking_budget": 8192
        });

        for base_url in [
            "https://workspace-id.cn-beijing.maas.aliyuncs.com/v1",
            "https://workspace-id.ap-southeast-1.maas.aliyuncs.com/v1",
        ] {
            let payload = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
                "deployment-alias",
                &body,
                base_url,
            );

            assert_eq!(payload["enable_thinking"], json!(true));
            assert_eq!(payload["thinking_budget"], json!(8192));
        }
    }

    #[test]
    fn openai_responses_adapter_drops_extensions_for_openrouter_qwen() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "enable_thinking": true,
            "thinking_budget": 8192
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "qwen/qwen3.7-plus",
            &body,
            "https://openrouter.ai/api/v1",
        );

        assert!(!payload.as_object().unwrap().contains_key("enable_thinking"));
        assert!(!payload.as_object().unwrap().contains_key("thinking_budget"));
    }

    #[test]
    fn openai_responses_adapter_respects_stream_and_store_from_body() {
        // 显式 stream:false 必须透传（非流式路径依赖 JSON 响应）；
        // store 显式指定时原样透传
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": false,
            "store": true
        });
        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        assert_eq!(payload["stream"], json!(false));
        assert_eq!(payload["store"], json!(true));

        // 缺省：stream 仍为 true；store 默认 false（桌面应用隐私，研报 01 要点 10）
        let default_body = json!({
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let default_payload =
            OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &default_body);
        assert_eq!(default_payload["stream"], json!(true));
        assert_eq!(default_payload["store"], json!(false));
    }

    #[test]
    fn openai_responses_adapter_flattens_json_schema_response_format() {
        // CC 的 response_format:{type:"json_schema",json_schema:{...}} 需扁平化为
        // Responses 的 text.format:{type:"json_schema",name,schema,strict}（研报 01 要点 7）
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "weather",
                    "schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "strict": true
                }
            }
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let format = &payload["text"]["format"];
        assert_eq!(format["type"], json!("json_schema"));
        assert_eq!(format["name"], json!("weather"));
        assert_eq!(format["schema"]["type"], json!("object"));
        assert_eq!(format["strict"], json!(true));
        assert!(format.get("json_schema").is_none());

        // json_object 保持兼容，原样透传
        let json_object_body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "response_format": { "type": "json_object" }
        });
        let json_object_payload =
            OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &json_object_body);
        assert_eq!(
            json_object_payload["text"]["format"]["type"],
            json!("json_object")
        );
    }

    #[test]
    fn openai_responses_adapter_converts_tools_and_tool_choice() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "lookup_weather" }
            },
            "parallel_tool_calls": false
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        // Responses 要求扁平工具定义 {"type":"function","name",...}（研报 01 要点 6）
        assert_eq!(payload["tools"][0]["type"], json!("function"));
        assert_eq!(payload["tools"][0]["name"], json!("lookup_weather"));
        assert_eq!(payload["tools"][0]["description"], json!("lookup"));
        assert_eq!(payload["tools"][0]["parameters"]["type"], json!("object"));
        // CC 缺省非 strict：转换时显式传 false，避免服务端自动 strict 化改变语义
        assert_eq!(payload["tools"][0]["strict"], json!(false));
        assert!(payload["tools"][0].get("function").is_none());
        assert_eq!(payload["tool_choice"]["type"], json!("function"));
        assert_eq!(payload["tool_choice"]["name"], json!("lookup_weather"));
        assert_eq!(payload["parallel_tool_calls"], json!(false));
    }

    #[test]
    fn openai_responses_adapter_passes_through_strict_and_non_function_tools() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} },
                        "strict": true
                    }
                },
                { "type": "web_search" }
            ]
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let tools = payload["tools"].as_array().expect("tools should be array");
        assert_eq!(tools.len(), 2);
        // 显式 strict 原样透传
        assert_eq!(tools[0]["strict"], json!(true));
        // 非 function 类型的内置工具原样透传
        assert_eq!(tools[1], json!({ "type": "web_search" }));
    }

    #[test]
    fn sanitize_openai_request_body_filters_blank_and_duplicate_tool_names() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "  ",
                        "description": "blank",
                        "parameters": { "type": "object", "properties": {} }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "first",
                        "parameters": { "type": "object", "properties": {} }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "duplicate",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "lookup_weather" }
            }
        });

        let sanitized = sanitize_openai_request_body(&body);
        let tools = sanitized["tools"]
            .as_array()
            .expect("tools should be array");

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], json!("lookup_weather"));
        // CC 协议的 tool_choice 指定函数时必须保持嵌套形状（r2 报告 P1-15）
        assert_eq!(sanitized["tool_choice"]["type"], json!("function"));
        assert_eq!(
            sanitized["tool_choice"]["function"]["name"],
            json!("lookup_weather")
        );
        assert!(sanitized["tool_choice"].get("name").is_none());
    }

    #[test]
    fn sanitize_openai_request_body_drops_tools_with_blank_flat_names() {
        // issue #53：cliproxyapi 以 HTTP 400 拒绝空工具名
        // （Invalid 'tools[0].name': empty string），扁平 name 与
        // function.name 都必须在发送前校验
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                // 非 function 工具带空扁平 name：此前会被原样透传
                { "type": "web_search_preview", "name": "" },
                // function 工具带空扁平 name（嵌套 name 合法）：
                // 此前 clone 会把空 name 字段原样送上线路
                {
                    "type": "function",
                    "name": "   ",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                },
                // 未声明名称的内置工具：合法，保留
                { "type": "web_search" },
                // 合法 function 工具：保留
                {
                    "type": "function",
                    "function": {
                        "name": "rag_search",
                        "description": "search notes",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ]
        });

        let sanitized = sanitize_openai_request_body(&body);
        let tools = sanitized["tools"]
            .as_array()
            .expect("tools should be array");

        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0], json!({ "type": "web_search" }));
        assert_eq!(tools[1]["function"]["name"], json!("rag_search"));
        // 任何幸存工具都不得携带空名称字段
        for tool in tools {
            let flat_blank = tool
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.trim().is_empty());
            let nested_blank = tool
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .is_some_and(|name| name.trim().is_empty());
            assert!(
                !flat_blank && !nested_blank,
                "blank tool name leaked: {tool}"
            );
        }
    }

    #[test]
    fn sanitize_openai_request_body_drops_all_blank_tools_and_clears_tools_field() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                { "type": "custom_gateway_tool", "name": "  " }
            ],
            "tool_choice": "auto"
        });

        let sanitized = sanitize_openai_request_body(&body);
        assert!(sanitized.get("tools").is_none());
        assert!(sanitized.get("tool_choice").is_none());
    }

    #[test]
    fn sanitize_openai_request_body_normalizes_missing_or_null_parameters() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "parameters": null
                    }
                }
            ]
        });

        let sanitized = sanitize_openai_request_body(&body);
        assert_eq!(
            sanitized["tools"][0]["function"]["parameters"]["type"],
            json!("object")
        );
        assert_eq!(
            sanitized["tools"][0]["function"]["parameters"]["properties"],
            json!({})
        );
    }

    #[test]
    fn sanitize_openai_request_body_drops_invalid_tool_choice_when_tool_missing() {
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "   " }
            }
        });

        let sanitized = sanitize_openai_request_body(&body);
        assert!(sanitized.get("tool_choice").is_none());
    }

    #[test]
    fn openai_adapter_build_request_sanitizes_invalid_tools() {
        let adapter = OpenAIAdapter::new();
        let body = json!({
            "model": "gpt-4o-mini",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "",
                        "description": "blank",
                        "parameters": { "type": "object", "properties": {} }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "" }
            }
        });

        let request = adapter
            .build_request(
                "https://api.openai.com/v1",
                "test-key",
                "gpt-4o-mini",
                &body,
            )
            .expect("request should build");

        let tools = request.body["tools"]
            .as_array()
            .expect("tools should be present");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], json!("lookup_weather"));
        assert!(request.body.get("tool_choice").is_none());
    }

    #[test]
    fn openai_responses_adapter_build_request_sanitizes_invalid_tools() {
        let adapter = OpenAIResponsesAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "   ",
                        "description": "blank",
                        "parameters": { "type": "object", "properties": {} }
                    }
                },
                // issue #53：空扁平 name 的非 function 工具必须在发送前丢弃
                { "type": "web_search_preview", "name": "" },
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_weather",
                        "description": "lookup",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": { "name": "   " }
            }
        });

        let request = adapter
            .build_request("https://api.openai.com/v1", "test-key", "gpt-5", &body)
            .expect("request should build");

        let tools = request.body["tools"]
            .as_array()
            .expect("tools should be present");
        assert_eq!(tools.len(), 1);
        // Responses 请求体中工具已是扁平格式
        assert_eq!(tools[0]["name"], json!("lookup_weather"));
        assert!(request.body.get("tool_choice").is_none());
    }

    #[test]
    fn openai_responses_adapter_parses_stream_events() {
        let adapter = OpenAIResponsesAdapter::new();

        let content =
            adapter.parse_stream(r#"data: {"type":"response.output_text.delta","delta":"hello"}"#);
        assert!(matches!(content.first(), Some(StreamEvent::ContentChunk(s)) if s == "hello"));

        let reasoning = adapter.parse_stream(
            r#"data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#,
        );
        assert!(
            matches!(reasoning.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "thinking")
        );

        let completed = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":1}}}"#,
        );
        assert!(matches!(completed.first(), Some(StreamEvent::Usage(_))));
        assert!(matches!(completed.last(), Some(StreamEvent::Done)));

        let tool_item = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","call_id":"call_1","name":"lookup_weather","arguments":"{\"city\":\"Paris\"}"}}"#,
        );
        assert!(matches!(tool_item.first(), Some(StreamEvent::ToolCall(v))
                if v["index"] == json!(2)
                    && v["function"]["name"] == json!("lookup_weather")));
    }

    #[test]
    fn openai_responses_adapter_accepts_bare_ndjson() {
        let events = OpenAIResponsesAdapter::new()
            .parse_stream(r#"{"type":"response.output_text.delta","delta":"ndjson"}"#);

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(content)) if content == "ndjson"
        ));
    }

    #[test]
    fn openai_responses_adapter_parses_event_and_data_sse_blocks() {
        let adapter = OpenAIResponsesAdapter::new();
        let events =
            adapter.parse_stream("event: response.output_text.delta\ndata: {\"delta\":\"framed\"}");

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "framed"
        ));
    }

    #[test]
    fn openai_responses_adapter_parses_buffered_event_only_type() {
        let adapter = OpenAIResponsesAdapter::new();
        let mut buffer = crate::utils::sse_buffer::SseEventBuffer::new();
        assert!(buffer
            .process_bytes(b"event: response.output_text.delta\nda")
            .is_empty());
        let blocks = buffer.process_bytes(b"ta: {\"delta\":\"buffered\"}\n");
        assert_eq!(blocks.len(), 1);

        let events = adapter.parse_stream(&blocks[0]);
        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "buffered"
        ));
    }

    #[test]
    fn openai_chat_adapter_accepts_event_and_data_sse_blocks() {
        let events = OpenAIAdapter::new().parse_stream(
            "event: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"framed\"}}]}",
        );

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "framed"
        ));
    }

    #[test]
    fn openai_responses_adapter_falls_back_to_terminal_tool_calls_without_duplicates() {
        let adapter = OpenAIResponsesAdapter::new();
        let first = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"first_tool","arguments":"{}"}}"#,
        );
        assert!(matches!(
            first.first(),
            Some(StreamEvent::ToolCall(value))
                if value["index"] == json!(0) && value["id"] == json!("call_1")
        ));

        let terminal = adapter.parse_stream(
            r#"data: {"type":"response.done","response":{"output":[{"type":"function_call","call_id":"call_1","name":"first_tool","arguments":"{}"},{"type":"function_call","call_id":"call_2","name":"second_tool","arguments":"{\"value\":2}"}]}}"#,
        );
        let tool_calls: Vec<_> = terminal
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ToolCall(value) => Some(value),
                _ => None,
            })
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["index"], json!(1));
        assert_eq!(tool_calls[0]["id"], json!("call_2"));
        assert!(matches!(terminal.last(), Some(StreamEvent::Done)));
    }

    /// P2-14 夹具：output_item.added 开始分块 + arguments.delta 增量 +
    /// arguments.done 终态（name/call_id 从 added 登记的状态兜底），
    /// output_item.done 与终端响应不得重复发射（保留 done 去重）。
    #[test]
    fn openai_responses_adapter_streams_added_and_argument_deltas() {
        let adapter = OpenAIResponsesAdapter::new();

        // added：发开始分块（有 id/name，arguments 为空）
        let added = adapter.parse_stream(
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":""}}"#,
        );
        assert_eq!(added.len(), 1);
        assert!(matches!(
            added.first(),
            Some(StreamEvent::ToolCall(value))
                if value["index"] == json!(0)
                    && value["id"] == json!("call_1")
                    && value["function"]["name"] == json!("lookup_weather")
                    && value["function"]["arguments"] == json!("")
        ));

        // delta：发 id-less 参数分块（上游按 index 追加、驱动前端预览）
        let first_delta = adapter.parse_stream(
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\"city\":"}"#,
        );
        assert!(matches!(
            first_delta.first(),
            Some(StreamEvent::ToolCall(value))
                if value["index"] == json!(0)
                    && value.get("id").is_none()
                    && value["function"]["arguments"] == json!("{\"city\":")
        ));
        let second_delta = adapter.parse_stream(
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\"Paris\"}"}"#,
        );
        assert!(matches!(
            second_delta.first(),
            Some(StreamEvent::ToolCall(value))
                if value.get("id").is_none()
                    && value["function"]["arguments"] == json!("\"Paris\"}")
        ));

        // arguments.done 只带 item_id：name/call_id 从 added 登记的状态兜底
        let done = adapter.parse_stream(
            r#"data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":0,"arguments":"{\"city\":\"Paris\"}"}"#,
        );
        assert_eq!(done.len(), 1);
        assert!(matches!(
            done.first(),
            Some(StreamEvent::ToolCall(value))
                if value["id"] == json!("call_1")
                    && value["function"]["name"] == json!("lookup_weather")
                    && value["function"]["arguments"] == json!("{\"city\":\"Paris\"}")
        ));

        // output_item.done 与终端响应：同一 call_id 不再重复发射
        let item_done = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":"{\"city\":\"Paris\"}"}}"#,
        );
        assert!(item_done.is_empty());
        let terminal = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","name":"lookup_weather","arguments":"{\"city\":\"Paris\"}"}]}}"#,
        );
        assert!(!terminal
            .iter()
            .any(|event| matches!(event, StreamEvent::ToolCall(_))));
        assert!(matches!(terminal.last(), Some(StreamEvent::Done)));
    }

    /// P2-14 夹具：done item 缺 arguments 时，以 added + delta 累积缓冲兜底。
    #[test]
    fn openai_responses_adapter_output_item_done_uses_accumulated_argument_deltas() {
        let adapter = OpenAIResponsesAdapter::new();
        adapter.parse_stream(
            r#"data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_9","call_id":"call_9","name":"lookup","arguments":""}}"#,
        );
        adapter.parse_stream(
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_9","output_index":2,"delta":"{\"q\":\"rust\"}"}"#,
        );

        let done = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_9","call_id":"call_9","name":"lookup"}}"#,
        );
        assert!(matches!(
            done.first(),
            Some(StreamEvent::ToolCall(value))
                if value["id"] == json!("call_9")
                    && value["function"]["arguments"] == json!("{\"q\":\"rust\"}")
        ));
    }

    #[test]
    fn openai_responses_adapter_emits_server_side_web_search_progress_events() {
        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.searching","call_id":"ws_1"}"#,
        );
        assert!(matches!(
            events.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_1") && payload["stage"] == json!("searching")
                    && payload.get("sources").is_none()
        ));

        let completed = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.completed","item":{"id":"ws_1","status":"completed","search_results":[{"url":"https://example.com/a","title":"Alpha"},{"url":"https://example.com/b","title":"Beta","text":"beta snippet"}]}}"#,
        );
        assert!(matches!(
            completed.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_1")
                    && payload["stage"] == json!("completed")
                    && payload["sources"][0]["title"] == json!("Alpha")
                    && payload["sources"][1]["snippet"] == json!("beta snippet")
        ));
    }

    /// 官方事件无 stage 字段：in_progress 事件不得误标为 searching
    /// （研报 ROUND-01-responses-adapter 要点 4）。
    #[test]
    fn openai_responses_adapter_web_search_in_progress_stage_is_not_searching() {
        let adapter = OpenAIResponsesAdapter::new();
        let in_progress = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.in_progress","call_id":"ws_ip"}"#,
        );
        assert!(matches!(
            in_progress.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_ip") && payload["stage"] == json!("in_progress")
        ));

        let searching = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.searching","call_id":"ws_ip"}"#,
        );
        assert!(matches!(
            searching.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["stage"] == json!("searching")
        ));

        // output_item.added 通告的 web_search_call 以 item 状态为准，缺省 in_progress
        let added = adapter.parse_stream(
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"ws_add","status":"in_progress"}}"#,
        );
        assert!(matches!(
            added.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_add") && payload["stage"] == json!("in_progress")
        ));
    }

    /// P2-13 夹具：completed 事件载荷携带完整 web_search_call item（补全 type），
    /// 供上游挂到 assistant meta 后原样回传下一轮 input；
    /// 终端 annotations 兜底的合成载荷不得携带 item。
    #[test]
    fn openai_responses_adapter_attaches_full_web_search_item_for_replay() {
        let adapter = OpenAIResponsesAdapter::new();
        let completed = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.completed","item":{"id":"ws_full","status":"completed","action":{"type":"search","query":"rust"},"search_results":[{"url":"https://example.com/r","title":"R"}]}}"#,
        );
        let payload = match completed.first() {
            Some(StreamEvent::WebSearchCall(payload)) => payload,
            other => panic!("expected WebSearchCall, got {:?}", other),
        };
        assert_eq!(payload["item"]["type"], json!("web_search_call"));
        assert_eq!(payload["item"]["id"], json!("ws_full"));
        assert_eq!(payload["item"]["status"], json!("completed"));
        assert_eq!(payload["item"]["action"]["query"], json!("rust"));
        assert_eq!(
            payload["item"]["search_results"][0]["url"],
            json!("https://example.com/r")
        );

        // output_item.done 已带 type 的 item 原样透传
        let done_adapter = OpenAIResponsesAdapter::new();
        let done = done_adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":1,"item":{"type":"web_search_call","id":"ws_typed","status":"completed","search_results":[{"url":"https://example.com/t","title":"T"}]}}"#,
        );
        assert!(matches!(
            done.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["item"]["type"] == json!("web_search_call")
                    && payload["item"]["id"] == json!("ws_typed")
        ));

        // 终端 annotations 兜底（合成聚合，无真实 item）：不携带 item
        let fallback_adapter = OpenAIResponsesAdapter::new();
        let terminal = fallback_adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/a","title":"A"}]}]}]}}"#,
        );
        let synthetic = terminal
            .iter()
            .find_map(|event| match event {
                StreamEvent::WebSearchCall(payload) => Some(payload),
                _ => None,
            })
            .expect("annotations fallback should emit a completed payload");
        assert!(synthetic.get("item").is_none());
    }

    /// P2-13 夹具：assistant 历史消息携带 `response_web_search_items` 时，
    /// convert 必须把完整 item 原样放回 input（顺序在 assistant message 之前），
    /// 非 web_search_call 类型跳过。
    #[test]
    fn openai_responses_adapter_replays_web_search_items_from_assistant_meta() {
        let web_search_item = json!({
            "type": "web_search_call",
            "id": "ws_hist",
            "status": "completed",
            "action": { "type": "search", "query": "rust" },
            "search_results": [{ "url": "https://example.com/r", "title": "R" }]
        });
        let body = json!({
            "messages": [
                { "role": "user", "content": "search something" },
                {
                    "role": "assistant",
                    "content": "Here is what I found.",
                    "response_web_search_items": [
                        web_search_item.clone(),
                        { "type": "message", "id": "not_a_search" }
                    ]
                },
                { "role": "user", "content": "follow up" }
            ]
        });

        let payload =
            OpenAIResponsesAdapter::convert_to_responses_format("deepseek-v4-flash", &body);
        let input = payload["input"].as_array().expect("input should be array");

        let replay_index = input
            .iter()
            .position(|item| item["type"] == json!("web_search_call"))
            .expect("web_search_call item should be replayed");
        // 原样回传：与写入 meta 的完整 item 逐字节一致
        assert_eq!(input[replay_index], web_search_item);
        // 顺序：位于 assistant message 之前
        let assistant_index = input
            .iter()
            .position(|item| item["role"] == json!("assistant"))
            .expect("assistant message should be present");
        assert!(replay_index < assistant_index);
        // 非 web_search_call 类型不得混入
        assert!(!input.iter().any(|item| item["id"] == json!("not_a_search")));
    }

    #[test]
    fn openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated() {
        let body = json!({
            "messages": [
                { "role": "system", "content": "You are helpful." },
                { "role": "user", "content": "hi" }
            ]
        });

        let official = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "gpt-5.6",
            &body,
            "https://api.openai.com/v1",
        );
        assert_eq!(
            official,
            json!({
                "model": "gpt-5.6",
                "input": [
                    {
                        "role": "developer",
                        "content": [{
                            "type": "input_text",
                            "text": "You are helpful.",
                            "prompt_cache_breakpoint": { "mode": "explicit" }
                        }]
                    },
                    {
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "hi" }]
                    }
                ],
                "stream": true,
                "store": false,
                "reasoning": { "summary": "auto" },
                "include": ["reasoning.encrypted_content"]
            })
        );

        let third_party_same_model =
            OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
                "gpt-5.6",
                &body,
                "https://gateway.example/v1",
            );
        assert_eq!(
            third_party_same_model,
            json!({
                "model": "gpt-5.6",
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "hi" }]
                }],
                "stream": true,
                "store": false,
                "instructions": "You are helpful.",
                "reasoning": { "summary": "auto" },
                "include": ["reasoning.encrypted_content"]
            })
        );

        let accidental_name = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "deployment-not-gpt-6-preview",
            &body,
            "https://api.openai.com/v1",
        );
        assert_eq!(
            accidental_name,
            json!({
                "model": "deployment-not-gpt-6-preview",
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "hi" }]
                }],
                "stream": true,
                "store": false,
                "instructions": "You are helpful."
            })
        );
    }

    /// ROUND-05 P0 补强：官方端点带 query/fragment 变体仍命中断点门控；
    /// 遗留无端点包装 convert_to_responses_format 恒不注入（防止未来有人
    /// 把生产调用误接回无端点包装）。
    #[test]
    fn openai_responses_prompt_cache_breakpoint_gate_covers_endpoint_variants() {
        let body = json!({
            "messages": [
                { "role": "system", "content": "You are helpful." },
                { "role": "user", "content": "hi" }
            ]
        });

        let official_variant = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
            "gpt-5.6",
            &body,
            "https://api.openai.com/v1/?token=x#frag",
        );
        assert_eq!(
            official_variant["input"][0]["content"][0]["prompt_cache_breakpoint"],
            json!({ "mode": "explicit" })
        );

        // 无端点包装：门控恒 false → 永不注入，system 回落顶层 instructions
        let endpointless = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.6", &body);
        assert_eq!(endpointless["instructions"], json!("You are helpful."));
        let no_breakpoint = endpointless["input"]
            .as_array()
            .expect("input array")
            .iter()
            .all(|item| {
                item["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .all(|block| block.get("prompt_cache_breakpoint").is_none())
                    })
                    .unwrap_or(true)
            });
        assert!(no_breakpoint);
    }

    #[test]
    fn model_supports_prompt_cache_breakpoint_parses_gpt_versions() {
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-5.6"));
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-5.6-sol"));
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("GPT-5.7"));
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-5.10"));
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-6"));
        assert!(OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("openai/gpt-6.1"));

        assert!(!OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-5"));
        assert!(!OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-5.5"));
        assert!(!OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("gpt-4o"));
        assert!(
            !OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint(
                "deployment-not-gpt-6-preview"
            )
        );
        assert!(!OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("not-gpt-5.6"));
        assert!(
            !OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("deepseek-v4-flash")
        );
        assert!(!OpenAIResponsesAdapter::model_supports_prompt_cache_breakpoint("qwen3.7-plus"));
    }

    #[test]
    fn openai_responses_adapter_extracts_web_search_from_output_item_done() {
        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":1,"item":{"type":"web_search_call","id":"ws_2","status":"completed","search_results":[{"url":"https://example.com/2","title":"Second"}]}}"#,
        );
        assert!(matches!(
            events.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_2")
                    && payload["stage"] == json!("completed")
                    && payload["sources"][0]["url"] == json!("https://example.com/2")
        ));
    }

    #[test]
    fn openai_responses_adapter_terminal_fallback_extracts_annotations_without_duplicating() {
        let adapter = OpenAIResponsesAdapter::new();

        // 流式阶段：completed 事件已带 search_results
        let streamed = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.completed","item":{"id":"ws_3","status":"completed","search_results":[{"url":"https://example.com/1","title":"One"}]}}"#,
        );
        assert_eq!(
            streamed
                .iter()
                .filter(|event| matches!(event, StreamEvent::WebSearchCall(_)))
                .count(),
            1
        );

        // 终端响应：同一 id 不再重复发射（seen with sources）
        let terminal = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"web_search_call","id":"ws_3","status":"completed","search_results":[{"url":"https://example.com/1","title":"One"}]},{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/1","title":"One"}]}]}]}}"#,
        );
        assert!(!terminal
            .iter()
            .any(|event| matches!(event, StreamEvent::WebSearchCall(_))));
        assert!(matches!(terminal.last(), Some(StreamEvent::Done)));

        // 流式阶段无来源（仅 annotations 形态）：终端兜底补发来源
        let only_annotations = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"id":"r2","output":[{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/9","title":"Nine"}]}]}]}}"#,
        );
        assert!(matches!(
            only_annotations.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["stage"] == json!("completed")
                    && payload["sources"][0]["url"] == json!("https://example.com/9")
        ));
    }

    #[test]
    fn deepseek_official_host_preserves_thinking_extensions() {
        assert!(
            OpenAIResponsesAdapter::preserves_provider_reasoning_extensions(
                "https://api.deepseek.com/v1"
            )
        );
        assert!(
            !OpenAIResponsesAdapter::preserves_provider_reasoning_extensions(
                "https://siliconflow.cn/v1"
            )
        );
        assert!(
            !OpenAIResponsesAdapter::preserves_provider_reasoning_extensions(
                "https://api.openai.com/v1"
            )
        );
    }

    #[test]
    fn openai_responses_adapter_accepts_deepseek_web_search_sources_shape() {
        let adapter = OpenAIResponsesAdapter::new();
        // DeepSeek 可能的 `web_search_sources` 字段形态与 `status` 非 completed 的
        // output_item.done（阶段应以 item 自身状态为准）
        let events = adapter.parse_stream(
            r#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_ds","status":"in_progress","web_search_sources":[{"url":"https://example.com/ds","title":"DeepSeek Source"}]}}"#,
        );
        assert!(matches!(
            events.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["id"] == json!("ws_ds")
                    && payload["stage"] == json!("in_progress")
                    && payload.get("sources").is_none()
        ));

        // completed 时同样识别 web_search_sources 形态
        let completed = adapter.parse_stream(
            r#"data: {"type":"response.web_search_call.completed","item":{"id":"ws_ds","status":"completed","web_search_sources":[{"url":"https://example.com/ds","title":"DeepSeek Source","text":"desc"}]}}"#,
        );
        assert!(matches!(
            completed.first(),
            Some(StreamEvent::WebSearchCall(payload))
                if payload["stage"] == json!("completed")
                    && payload["sources"][0]["title"] == json!("DeepSeek Source")
                    && payload["sources"][0]["snippet"] == json!("desc")
        ));
    }

    #[test]
    fn openai_responses_adapter_reports_untyped_error_objects() {
        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter
            .parse_stream(r#"data: {"error":{"code":402,"message":"Insufficient credits"}}"#);

        assert!(matches!(
            events.first(),
            Some(StreamEvent::SafetyBlocked(value))
                if value["reason"] == json!("stream_error")
                    && value["details"]["message"] == json!("Insufficient credits")
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, StreamEvent::Done)));
    }

    #[test]
    fn openai_responses_adapter_preserves_incomplete_output_without_marking_done() {
        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter.parse_stream(
            r#"data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial answer"}]}],"usage":{"output_tokens":128}}}"#,
        );

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "partial answer"
        ));
        assert!(events.iter().any(
            |event| matches!(event, StreamEvent::Usage(usage) if usage["output_tokens"] == json!(128))
        ));
        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::SafetyBlocked(value)
                if value["reason"] == json!("response.incomplete")
                    && value["details"]["reason"] == json!("max_output_tokens")
        )));
        assert!(!events
            .iter()
            .any(|event| matches!(event, StreamEvent::Done)));
    }

    #[test]
    fn openai_responses_adapter_uses_output_text_fallbacks_without_duplication() {
        let done_only = OpenAIResponsesAdapter::new();
        let done_events = done_only
            .parse_stream(r#"data: {"type":"response.output_text.done","text":"complete text"}"#);
        assert!(matches!(
            done_events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "complete text"
        ));
        let completed_after_done = done_only.parse_stream(
            r#"data: {"type":"response.completed","response":{"output_text":"complete text"}}"#,
        );
        assert!(!completed_after_done
            .iter()
            .any(|event| matches!(event, StreamEvent::ContentChunk(_))));

        let delta_first = OpenAIResponsesAdapter::new();
        let delta_events = delta_first
            .parse_stream(r#"data: {"type":"response.output_text.delta","delta":"streamed"}"#);
        assert!(matches!(
            delta_events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "streamed"
        ));
        assert!(delta_first
            .parse_stream(r#"data: {"type":"response.output_text.done","text":"streamed"}"#)
            .is_empty());
        let completed_after_delta = delta_first.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"streamed"}]}]}}"#,
        );
        assert!(!completed_after_delta
            .iter()
            .any(|event| matches!(event, StreamEvent::ContentChunk(_))));

        let completed_only = OpenAIResponsesAdapter::new();
        let completed_events = completed_only.parse_stream(
            r#"data: {"type":"response.completed","response":{"output_text":"duplicate convenience value","output":[{"type":"message","content":[{"type":"output_text","text":"first"},{"type":"output_text","text":" second"}]}]}}"#,
        );
        let content: Vec<_> = completed_events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ContentChunk(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(content, vec!["first second"]);
        assert!(matches!(completed_events.last(), Some(StreamEvent::Done)));
    }

    #[test]
    fn openai_responses_adapter_extracts_reasoning_from_completed_event() {
        // 流中未出现任何 reasoning 事件时，response.completed 兜底提取一次
        let adapter = OpenAIResponsesAdapter::new();
        let events = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"first"},{"type":"summary_text","text":"second"}]}],"usage":{"input_tokens":1}}}"#,
        );

        assert!(
            matches!(events.first(), Some(StreamEvent::ReasoningChunk(s)) if s.contains("first"))
        );
        assert!(matches!(events.get(1), Some(StreamEvent::Usage(_))));
        assert!(matches!(events.last(), Some(StreamEvent::Done)));

        let duplicate_terminal = adapter.parse_stream(
            r#"data: {"type":"response.done","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"first"},{"type":"summary_text","text":"second"}]}]}}"#,
        );
        assert!(!duplicate_terminal
            .iter()
            .any(|event| matches!(event, StreamEvent::ReasoningChunk(_))));
    }

    #[test]
    fn openai_responses_adapter_does_not_duplicate_reasoning_after_deltas() {
        // 收到 .delta 增量后，.done（全量文本）与 response.completed 均不得重复推送
        let adapter = OpenAIResponsesAdapter::new();

        let delta_events = adapter.parse_stream(
            r#"data: {"type":"response.reasoning_summary_text.delta","delta":"step one"}"#,
        );
        assert!(
            matches!(delta_events.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "step one")
        );

        let done_events = adapter.parse_stream(
            r#"data: {"type":"response.reasoning_summary_text.done","text":"step one and two"}"#,
        );
        assert!(done_events.is_empty(), ".done 全量文本不应重复推送");

        let completed_events = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"step one and two"}]}],"usage":{"input_tokens":1}}}"#,
        );
        assert!(
            !completed_events
                .iter()
                .any(|e| matches!(e, StreamEvent::ReasoningChunk(_))),
            "response.completed 不应再次提取 reasoning"
        );
        assert!(matches!(
            completed_events.first(),
            Some(StreamEvent::Usage(_))
        ));
        assert!(matches!(completed_events.last(), Some(StreamEvent::Done)));
    }

    #[test]
    fn openai_responses_adapter_uses_done_event_as_fallback_without_deltas() {
        // 未收到任何 .delta 时，.done 作为兜底推送一次；completed 不再重复
        let adapter = OpenAIResponsesAdapter::new();

        let done_events = adapter.parse_stream(
            r#"data: {"type":"response.reasoning_text.done","text":"full reasoning"}"#,
        );
        assert!(
            matches!(done_events.first(), Some(StreamEvent::ReasoningChunk(s)) if s == "full reasoning")
        );

        let completed_events = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"full reasoning"}]}],"usage":{"input_tokens":1}}}"#,
        );
        assert!(
            !completed_events
                .iter()
                .any(|e| matches!(e, StreamEvent::ReasoningChunk(_))),
            ".done 兜底后 response.completed 不应再次提取 reasoning"
        );
    }

    #[test]
    fn anthropic_uses_output_config_format_for_structured_output() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "response_format": { "type": "json_object" }
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-4-5", &body);
        assert!(request.response_format.is_none());
        assert_eq!(
            request
                .output_config
                .as_ref()
                .and_then(|v| v.get("format"))
                .and_then(|v| v.get("type")),
            Some(&json!("json"))
        );
    }

    #[test]
    fn anthropic_thinking_with_tools_forces_auto_tool_choice() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "tools": [{
                "type": "function",
                "function": {
                    "name": "lookup_weather",
                    "description": "lookup",
                    "parameters": { "type": "object", "properties": {} }
                }
            }],
            "tool_choice": { "type": "function", "function": { "name": "lookup_weather" } }
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-4-5", &body);
        assert_eq!(request.tool_choice, Some(json!({ "type": "auto" })));
    }

    #[test]
    fn anthropic_preserves_inline_tool_use_blocks_from_assistant_content() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "need a tool" },
                    {
                        "type": "tool_use",
                        "id": "toolu_123",
                        "name": "lookup_weather",
                        "input": { "city": "Paris" }
                    },
                    { "type": "text", "text": "Calling tool now." }
                ]
            }]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-4-5", &body);
        let request_json = serde_json::to_value(request).expect("request should serialize");
        let content = request_json["messages"][0]["content"]
            .as_array()
            .expect("assistant content should be an array");

        assert!(content.iter().any(|block| {
            block["type"] == json!("tool_use")
                && block["id"] == json!("toolu_123")
                && block["name"] == json!("lookup_weather")
                && block["input"]["city"] == json!("Paris")
        }));
    }

    /// P2-11：保留顶层 automatic cache_control，同时在 tools 尾与 system 尾
    /// 各补一个显式 ephemeral 保险断点（不拆 auto、不改成纯 4 断点方案）。
    #[test]
    fn anthropic_adds_tools_and_system_tail_cache_breakpoints() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [
                { "role": "system", "content": "stable instructions" },
                { "role": "user", "content": "hi" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
                },
                {
                    "type": "function",
                    "function": { "name": "beta_tool", "parameters": { "type": "object" } }
                }
            ]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");

        // 顶层 automatic cache_control 保留
        assert_eq!(
            request_json["cache_control"],
            json!({ "type": "ephemeral" })
        );

        // system 为 block 数组，尾块带显式断点
        let system = request_json["system"]
            .as_array()
            .expect("system should be block array");
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["type"], json!("text"));
        assert_eq!(system[0]["text"], json!("stable instructions"));
        assert_eq!(system[0]["cache_control"], json!({ "type": "ephemeral" }));

        // tools 尾块带显式断点；非尾块不打点
        let tools = request_json["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"], json!({ "type": "ephemeral" }));
    }

    /// P2-11：调用方已打的块级 cache_control（稳定段尾标记）必须原样保留，
    /// 不得剥掉，也不再追加多余断点。
    #[test]
    fn anthropic_preserves_caller_block_level_system_cache_control() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": "stable prefix",
                            "cache_control": { "type": "ephemeral" }
                        },
                        { "type": "text", "text": "volatile suffix" }
                    ]
                },
                { "role": "user", "content": "hi" }
            ]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");
        let system = request_json["system"]
            .as_array()
            .expect("system should be block array");
        assert_eq!(system.len(), 2);
        // 稳定段尾标记原样保留
        assert_eq!(system[0]["cache_control"], json!({ "type": "ephemeral" }));
        // 已有块级标记时不再追加尾部断点（易变段不该被缓存锚定）
        assert!(system[1].get("cache_control").is_none());
    }

    /// ROUND-05 P2：convert_tool_definition 透传调用方 tools[].cache_control，
    /// has_marker 分支从死分支变为可达——调用方已打 marker 时原样保留、
    /// 不再无条件追加尾部保险断点。
    #[test]
    fn anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [
                {
                    "type": "function",
                    "cache_control": { "type": "ephemeral" },
                    "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
                },
                {
                    "type": "function",
                    "function": { "name": "beta_tool", "parameters": { "type": "object" } }
                }
            ]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");
        let tools = request_json["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        // 调用方 marker 原样透传（此前被静默丢弃）
        assert_eq!(tools[0]["cache_control"], json!({ "type": "ephemeral" }));
        // has_marker 命中 → 不再追加尾部保险断点（易变工具不该被缓存锚定）
        assert!(tools[1].get("cache_control").is_none());
    }

    /// ROUND-05 P2：四槽满载（顶层 automatic 1 + tools 尾 1 + system 块级 2）
    /// 恰好用满预算，不触发剥除，全部保留。
    #[test]
    fn anthropic_cache_breakpoint_budget_keeps_full_four_slots() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": "stable prefix",
                            "cache_control": { "type": "ephemeral" }
                        },
                        {
                            "type": "text",
                            "text": "stable tail",
                            "cache_control": { "type": "ephemeral" }
                        }
                    ]
                },
                { "role": "user", "content": "hi" }
            ],
            "tools": [{
                "type": "function",
                "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
            }]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");

        // automatic 顶层槽保留
        assert_eq!(
            request_json["cache_control"],
            json!({ "type": "ephemeral" })
        );
        // tools 尾保险断点（调用方无 marker → 自动打点）保留
        let tools = request_json["tools"].as_array().expect("tools array");
        assert_eq!(tools[0]["cache_control"], json!({ "type": "ephemeral" }));
        // system 两个块级 marker 均保留（块级合计 3 = 预算上限 4 - automatic 1）
        let system = request_json["system"].as_array().expect("system array");
        assert_eq!(system[0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(system[1]["cache_control"], json!({ "type": "ephemeral" }));
    }

    /// ROUND-05 P2：超载（automatic 1 + 块级 5 = 6 > 4）时按 prompt 序
    /// （tools 先于 system、靠前块先剥）从最靠前的 marker 开始剥除；
    /// 覆盖前缀最长、命中价值最高的尾部 marker 最后保留。
    #[test]
    fn anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": "s1",
                            "cache_control": { "type": "ephemeral" }
                        },
                        {
                            "type": "text",
                            "text": "s2",
                            "cache_control": { "type": "ephemeral" }
                        },
                        {
                            "type": "text",
                            "text": "s3",
                            "cache_control": { "type": "ephemeral" }
                        }
                    ]
                },
                { "role": "user", "content": "hi" }
            ],
            "tools": [
                {
                    "type": "function",
                    "cache_control": { "type": "ephemeral" },
                    "function": { "name": "alpha_tool", "parameters": { "type": "object" } }
                },
                {
                    "type": "function",
                    "cache_control": { "type": "ephemeral" },
                    "function": { "name": "beta_tool", "parameters": { "type": "object" } }
                }
            ]
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");

        // automatic 顶层槽不参与剥除
        assert_eq!(
            request_json["cache_control"],
            json!({ "type": "ephemeral" })
        );
        // 块级 5 个 marker 超出 3 槽预算，剥除最靠前的 2 个（两个 tools marker）
        let tools = request_json["tools"].as_array().expect("tools array");
        assert!(tools[0].get("cache_control").is_none());
        assert!(tools[1].get("cache_control").is_none());
        // system 三个 marker 全部保留（恰好用满剩余 3 槽）
        let system = request_json["system"].as_array().expect("system array");
        assert_eq!(system[0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(system[1]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(system[2]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn openai_responses_adapter_encodes_tool_history() {
        let body = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "Calling tool",
                    "response_reasoning_item": {
                        "type": "reasoning",
                        "id": "reasoning_1",
                        "encrypted_content": "encrypted-state"
                    },
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "lookup_weather",
                            "arguments": "{\"city\":\"Paris\"}"
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "Sunny"
                }
            ]
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let input = payload["input"].as_array().expect("input should be array");
        let reasoning_index = input
            .iter()
            .position(|item| item["type"] == json!("reasoning"))
            .expect("reasoning item should be preserved");
        let function_call_index = input
            .iter()
            .position(|item| item["type"] == json!("function_call"))
            .expect("function call should be preserved");
        assert!(reasoning_index < function_call_index);
        assert_eq!(
            input[reasoning_index]["encrypted_content"],
            "encrypted-state"
        );
        assert!(input
            .iter()
            .any(|item| item["type"] == json!("function_call")));
        assert!(input
            .iter()
            .any(|item| item["type"] == json!("function_call_output")));
    }

    /// 回归：终态兜底（流式期间未逐条发射 item 时）必须按 response.output
    /// 原始顺序交错发射 reasoning item 与 function_call，保持相邻配对语义——
    /// 禁止先全量 reasoning 再全量 tool_call 的两遍扫描。
    #[test]
    fn openai_responses_completed_fallback_interleaves_reasoning_and_tool_calls() {
        let adapter = OpenAIResponsesAdapter::new();
        let payload = json!({
            "type": "response.completed",
            "response": {
                "output": [
                    { "type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1" },
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "tool_a", "arguments": "{}" },
                    { "type": "reasoning", "id": "rs_2", "encrypted_content": "enc-2" },
                    { "type": "function_call", "id": "fc_2", "call_id": "call_2", "name": "tool_b", "arguments": "{}" }
                ]
            }
        });

        let events = adapter.parse_stream(&format!("data: {payload}"));
        let sequence: Vec<String> = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ResponseReasoningItem(item) => {
                    Some(format!("reasoning:{}", item["id"].as_str().unwrap_or("")))
                }
                StreamEvent::ToolCall(tool) => {
                    Some(format!("tool:{}", tool["id"].as_str().unwrap_or("")))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            sequence,
            vec![
                "reasoning:rs_1",
                "tool:call_1",
                "reasoning:rs_2",
                "tool:call_2"
            ],
            "reasoning item 必须紧邻其 function_call 交错发射"
        );
    }

    /// 回归：流式 output_item.done 已发射的 reasoning item 在终态兜底中按 id
    /// 去重不重发；未流出过的新 item（rs_2）仍要补发（旧实现的单布尔守卫会
    /// 把整个兜底跳过，丢失第二个 item）。
    #[test]
    fn openai_responses_completed_dedupes_streamed_reasoning_items_by_id() {
        let adapter = OpenAIResponsesAdapter::new();

        let streamed = adapter.parse_stream(&format!(
            "data: {}",
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": { "type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1" }
            })
        ));
        assert_eq!(
            streamed
                .iter()
                .filter(|e| matches!(e, StreamEvent::ResponseReasoningItem(_)))
                .count(),
            1
        );

        let completed = adapter.parse_stream(&format!(
            "data: {}",
            json!({
                "type": "response.completed",
                "response": {
                    "output": [
                        { "type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1" },
                        { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "tool_a", "arguments": "{}" },
                        { "type": "reasoning", "id": "rs_2", "encrypted_content": "enc-2" }
                    ]
                }
            })
        ));
        let reasoning_ids: Vec<&str> = completed
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ResponseReasoningItem(item) => item["id"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(
            reasoning_ids,
            vec!["rs_2"],
            "已流出的 rs_1 不重发，未流出的 rs_2 仍需补发"
        );
    }

    /// 回归：无工具纯文本轮 —— 上一 assistant 消息携带的 reasoning item
    /// 在下一轮 Responses input 中回传，且位于该 assistant 正文之前。
    #[test]
    fn openai_responses_adapter_replays_reasoning_item_before_plain_assistant_message() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "hi" },
                {
                    "role": "assistant",
                    "content": "Hello there!",
                    "response_reasoning_item": {
                        "type": "reasoning",
                        "id": "rs_final",
                        "encrypted_content": "enc-final"
                    }
                },
                { "role": "user", "content": "and again" }
            ]
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let input = payload["input"].as_array().expect("input should be array");
        let reasoning_index = input
            .iter()
            .position(|item| item["type"] == json!("reasoning"))
            .expect("plain assistant turn should replay its reasoning item");
        assert_eq!(input[reasoning_index]["encrypted_content"], "enc-final");
        let assistant_index = input
            .iter()
            .position(|item| {
                item["role"] == json!("assistant")
                    && item["content"][0]["text"] == json!("Hello there!")
            })
            .expect("assistant message should be preserved");
        assert!(
            reasoning_index < assistant_index,
            "reasoning item 必须回放在 assistant 正文之前（对齐响应 output 顺序）"
        );
    }

    #[test]
    fn openai_responses_adapter_encodes_assistant_history_as_output_text() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "knock knock" },
                { "role": "assistant", "content": "Who's there?" },
                { "role": "user", "content": "Orange" }
            ]
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let input = payload["input"].as_array().expect("input should be array");

        assert_eq!(input[1]["role"], json!("assistant"));
        assert_eq!(input[1]["content"][0]["type"], json!("output_text"));
        assert_eq!(input[1]["content"][0]["text"], json!("Who's there?"));
    }

    #[test]
    fn openai_responses_adapter_preserves_assistant_output_parts() {
        let body = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "First answer" },
                        { "type": "refusal", "refusal": "Can't help with that." }
                    ]
                }
            ]
        });

        let payload = OpenAIResponsesAdapter::convert_to_responses_format("gpt-5.2", &body);
        let input = payload["input"].as_array().expect("input should be array");

        assert_eq!(input[0]["role"], json!("assistant"));
        assert_eq!(input[0]["content"][0]["type"], json!("output_text"));
        assert_eq!(input[0]["content"][0]["text"], json!("First answer"));
        assert_eq!(input[0]["content"][1]["type"], json!("refusal"));
        assert_eq!(
            input[0]["content"][1]["refusal"],
            json!("Can't help with that.")
        );
    }

    #[test]
    fn anthropic_build_usage_event_collects_cached_tokens() {
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_creation_input_tokens": 20,
            "cache_read_input_tokens": 30
        });

        let event = build_usage_event(&usage).expect("usage event");
        assert_eq!(event["cached_tokens"], json!(30));
    }

    // ========== Anthropic 2026-07 修复回归测试 ==========

    #[test]
    fn anthropic_new_generation_strips_sampling_params_unconditionally() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "temperature": 0.7,
            "top_p": 0.9,
            "top_k": 40
        });

        // 新代际（未开 thinking）也必须剥离 temperature/top_p/top_k（研报 02 要点 4）
        let request = adapter.convert_openai_to_anthropic("claude-opus-4-8", &body);
        assert!(request.temperature.is_none());
        assert!(request.top_p.is_none());
        assert!(request.top_k.is_none());

        // 旧代际保持现有互斥逻辑（优先 temperature、保留 top_k）
        let legacy = adapter.convert_openai_to_anthropic("claude-sonnet-4-5", &body);
        assert_eq!(legacy.temperature, Some(0.7));
        assert!(legacy.top_p.is_none());
        assert_eq!(legacy.top_k, Some(40));
    }

    #[test]
    fn anthropic_new_generation_rewrites_enabled_thinking_to_adaptive() {
        // 安全网：新代际收到旧 manual 形态时改写为 adaptive（enabled 会直接 400），
        // budget_tokens 近似映射为 output_config.effort
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled", "budget_tokens": 10240 }
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let thinking = request.thinking.as_ref().expect("thinking should exist");
        assert_eq!(thinking.get("type"), Some(&json!("adaptive")));
        assert!(thinking.get("budget_tokens").is_none());
        assert_eq!(
            request.output_config.as_ref().and_then(|c| c.get("effort")),
            Some(&json!("medium"))
        );
    }

    #[test]
    fn anthropic_old_generation_keeps_enabled_thinking_passthrough() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled", "budget_tokens": 2048 }
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-4-5", &body);
        let thinking = request.thinking.as_ref().expect("thinking should exist");
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(2048)));
    }

    #[test]
    fn anthropic_parse_stream_accumulates_signature_delta() {
        let adapter = AnthropicAdapter::new();

        let start = adapter.parse_stream(
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        );
        assert!(start.is_empty());

        // signature_delta 可能分片送达，需按 index 累积
        let sig1 = adapter.parse_stream(
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCg"}}"#,
        );
        assert!(sig1.is_empty());
        let sig2 = adapter.parse_stream(
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"XYZ123"}}"#,
        );
        assert!(sig2.is_empty());

        let stop = adapter.parse_stream(r#"data: {"type":"content_block_stop","index":0}"#);
        assert!(matches!(
            stop.first(),
            Some(StreamEvent::ThoughtSignature(sig)) if sig == "EqQBCgXYZ123"
        ));
    }

    #[test]
    fn anthropic_parse_stream_accepts_event_and_data_sse_blocks() {
        let adapter = AnthropicAdapter::new();
        let events = adapter.parse_stream(
            r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"framed"}}"#,
        );

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(text)) if text == "framed"
        ));
    }

    #[test]
    fn anthropic_parse_stream_accepts_bare_ndjson() {
        let events = AnthropicAdapter::new().parse_stream(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ndjson"}}"#,
        );

        assert!(matches!(
            events.first(),
            Some(StreamEvent::ContentChunk(content)) if content == "ndjson"
        ));
    }

    #[test]
    fn anthropic_parse_stream_merges_input_tokens_from_message_start() {
        let adapter = AnthropicAdapter::new();

        let start_events = adapter.parse_stream(
            r#"data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":123,"output_tokens":0}}}"#,
        );
        assert!(matches!(
            start_events.first(),
            Some(StreamEvent::Usage(u)) if u["input_tokens"] == json!(123)
        ));

        // message_delta 的 usage 通常只有 output_tokens，input 应从 message_start 合并
        let delta_events = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
        );
        assert!(matches!(
            delta_events.first(),
            Some(StreamEvent::Usage(u))
                if u["input_tokens"] == json!(123) && u["output_tokens"] == json!(42)
        ));
    }

    #[test]
    fn anthropic_parse_stream_merges_cache_fields_from_message_start() {
        // P0 观测修复：message_start 携带 cache_read/cache_creation，message_delta
        // 终态通常只有 output_tokens，字段级合并后缓存命中不能丢
        let adapter = AnthropicAdapter::new();

        let start_events = adapter.parse_stream(
            r#"data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":50,"output_tokens":0}}}"#,
        );
        assert!(matches!(
            start_events.first(),
            Some(StreamEvent::Usage(u))
                if u["cached_tokens"] == json!(900) && u["cache_write_tokens"] == json!(50)
        ));

        let delta_events = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
        );
        assert!(matches!(
            delta_events.first(),
            Some(StreamEvent::Usage(u))
                if u["input_tokens"] == json!(10)
                    && u["output_tokens"] == json!(42)
                    && u["cached_tokens"] == json!(900)
                    && u["cache_write_tokens"] == json!(50)
        ));

        // message_stop 后缓存清空，不能泄漏到下一条消息
        let _ = adapter.parse_stream(r#"data: {"type":"message_stop"}"#);
        let next_events = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
        );
        assert!(matches!(
            next_events.first(),
            Some(StreamEvent::Usage(u))
                if u["output_tokens"] == json!(7) && u["cached_tokens"] == Value::Null
        ));
    }

    #[test]
    fn anthropic_merged_usage_prefers_terminal_nonzero_fields() {
        // 终态 usage 若自带非零 cache 字段，不应被 message_start 的旧值覆盖
        let adapter = AnthropicAdapter::new();

        let _ = adapter.parse_stream(
            r#"data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":900}}}"#,
        );
        let delta_events = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42,"cache_read_input_tokens":1200}}"#,
        );
        assert!(matches!(
            delta_events.first(),
            Some(StreamEvent::Usage(u))
                if u["cached_tokens"] == json!(1200) && u["input_tokens"] == json!(10)
        ));
    }

    #[test]
    fn build_usage_event_reads_responses_details() {
        // OpenAI/DeepSeek Responses usage 夹具：input_tokens_details.cached_tokens /
        // cache_write_tokens 与 output_tokens_details.reasoning_tokens 必须抬到顶层
        let usage = json!({
            "input_tokens": 1200,
            "output_tokens": 300,
            "total_tokens": 1500,
            "input_tokens_details": { "cached_tokens": 1024, "cache_write_tokens": 128 },
            "output_tokens_details": { "reasoning_tokens": 90 }
        });

        let event = build_usage_event(&usage).expect("usage event");
        assert_eq!(event["input_tokens"], json!(1200));
        assert_eq!(event["output_tokens"], json!(300));
        assert_eq!(event["cached_tokens"], json!(1024));
        assert_eq!(event["cache_write_tokens"], json!(128));
        assert_eq!(event["reasoning_tokens"], json!(90));
    }

    #[test]
    fn build_usage_event_preserves_observed_zero_cache_values() {
        let event = build_usage_event(&json!({
            "input_tokens": 10,
            "output_tokens": 5,
            "input_tokens_details": {
                "cached_tokens": 0,
                "cache_write_tokens": 0
            }
        }))
        .expect("usage event");
        assert_eq!(event["cached_tokens"], json!(0));
        assert_eq!(event["cache_write_tokens"], json!(0));

        let unmeasured =
            build_usage_event(&json!({"input_tokens": 10, "output_tokens": 5})).unwrap();
        assert!(unmeasured["cached_tokens"].is_null());
        assert!(unmeasured["cache_write_tokens"].is_null());
    }

    #[test]
    fn convert_anthropic_response_passes_cache_fields() {
        // 非流式 Anthropic 响应转 OpenAI 形态时透传缓存字段
        let response = json!({
            "type": "message",
            "id": "msg_1",
            "content": [{ "type": "text", "text": "hi" }],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 20,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 50
            }
        });

        let converted =
            convert_anthropic_response_to_openai(&response, "claude-test").expect("converted");
        let usage = &converted["usage"];
        assert_eq!(usage["prompt_tokens"], json!(10));
        assert_eq!(usage["completion_tokens"], json!(20));
        assert_eq!(usage["cache_read_input_tokens"], json!(900));
        assert_eq!(usage["cache_creation_input_tokens"], json!(50));
    }

    #[test]
    fn openai_adapter_gates_stream_options_include_usage_by_endpoint() {
        let adapter = OpenAIAdapter::new();
        let body = json!({
            "model": "gpt-4o-mini",
            "stream": true,
            "messages": [{ "role": "user", "content": "hi" }]
        });

        let request = adapter
            .build_request("https://api.openai.com/v1", "key", "gpt-4o-mini", &body)
            .expect("request should build");
        assert_eq!(request.body["stream_options"]["include_usage"], json!(true));

        // 未知兼容端点默认不注入扩展字段，避免严格网关因 unknown field 失败。
        for base_url in [
            "https://gateway.example/v1",
            "https://api.openai.com.evil.example/v1",
        ] {
            let request = adapter
                .build_request(base_url, "key", "gpt-4o-mini", &body)
                .expect("request should build");
            assert!(
                request.body.get("stream_options").is_none(),
                "base_url={base_url}"
            );
        }

        // 非流式请求不加
        let body = json!({
            "model": "gpt-4o-mini",
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let request = adapter
            .build_request("https://api.openai.com/v1", "key", "gpt-4o-mini", &body)
            .expect("request should build");
        assert!(request.body.get("stream_options").is_none());

        // 调用方显式设置时尊重原值
        let body = json!({
            "model": "gpt-4o-mini",
            "stream": true,
            "stream_options": { "include_usage": false },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let request = adapter
            .build_request("https://api.openai.com/v1", "key", "gpt-4o-mini", &body)
            .expect("request should build");
        assert_eq!(
            request.body["stream_options"]["include_usage"],
            json!(false)
        );
    }

    /// ROUND-05 P1：stream_options 注入门控钉死为官方 host（api.openai.com）——
    /// 带路径/query/fragment/大小写的官方变体仍注入；子域、连字符伪装、
    /// 后缀伪装、无 scheme 解析失败一律 fail-safe 不注入。
    #[test]
    fn openai_adapter_stream_options_gate_pins_official_host_variants() {
        let adapter = OpenAIAdapter::new();
        let body = json!({
            "model": "gpt-4o-mini",
            "stream": true,
            "messages": [{ "role": "user", "content": "hi" }]
        });

        for base_url in [
            "https://api.openai.com",
            "https://api.openai.com/v1/",
            "https://API.OPENAI.COM/v1",
            "https://api.openai.com/v1?token=x#frag",
        ] {
            let request = adapter
                .build_request(base_url, "key", "gpt-4o-mini", &body)
                .expect("request should build");
            assert_eq!(
                request.body["stream_options"]["include_usage"],
                json!(true),
                "official variant must inject: base_url={base_url}"
            );
        }

        for base_url in [
            "https://mirror.api.openai.com/v1",
            "https://api-openai.com/v1",
            "https://api.openai.com.evil.example/v1",
            "api.openai.com/v1",
            "",
        ] {
            let request = adapter
                .build_request(base_url, "key", "gpt-4o-mini", &body)
                .expect("request should build");
            assert!(
                request.body.get("stream_options").is_none(),
                "non-official endpoint must not inject: base_url={base_url}"
            );
        }
    }

    #[test]
    fn anthropic_parse_stream_surfaces_error_event() {
        let adapter = AnthropicAdapter::new();
        let events = adapter.parse_stream(
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        );
        assert!(matches!(
            events.first(),
            Some(StreamEvent::SafetyBlocked(v)) if v["type"] == json!("provider_error")
        ));
        assert!(matches!(events.last(), Some(StreamEvent::Done)));
    }

    #[test]
    fn anthropic_parse_stream_maps_new_stop_reasons() {
        let adapter = AnthropicAdapter::new();

        // Fable 5 refusal：HTTP 200 + stop_details（研报 02 要点 5）
        let refusal = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}}}"#,
        );
        assert!(matches!(
            refusal.first(),
            Some(StreamEvent::SafetyBlocked(v))
                if v["type"] == json!("content_blocked")
                    && v["reason"] == json!("refusal")
                    && v["stop_details"]["category"] == json!("cyber")
        ));

        let exceeded = adapter.parse_stream(
            r#"data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"}}"#,
        );
        assert!(matches!(
            exceeded.first(),
            Some(StreamEvent::SafetyBlocked(v))
                if v["type"] == json!("provider_error")
                    && v["reason"] == json!("model_context_window_exceeded")
        ));
    }

    #[test]
    fn anthropic_assistant_thinking_blocks_keep_signature_and_redacted() {
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "reasoned", "signature": "sig_full" },
                    { "type": "thinking", "thinking": "", "signature": "sig_omitted" },
                    { "type": "redacted_thinking", "data": "opaque_payload" },
                    { "type": "text", "text": "answer" }
                ]
            }]
        });

        let request = adapter.convert_openai_to_anthropic("claude-fable-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");
        let content = request_json["messages"][0]["content"]
            .as_array()
            .expect("assistant content array");

        assert_eq!(content[0]["type"], json!("thinking"));
        assert_eq!(content[0]["thinking"], json!("reasoned"));
        assert_eq!(content[0]["signature"], json!("sig_full"));
        // 新代际 display:"omitted"：空文本但有 signature 的块不能丢弃
        assert_eq!(content[1]["thinking"], json!(""));
        assert_eq!(content[1]["signature"], json!("sig_omitted"));
        // redacted_thinking 必须原样回传
        assert_eq!(content[2]["type"], json!("redacted_thinking"));
        assert_eq!(content[2]["data"], json!("opaque_payload"));
    }

    #[test]
    fn anthropic_message_level_thought_signature_attaches_to_thinking_block() {
        let adapter = AnthropicAdapter::new();

        // 情形 1：已有 thinking 块（无签名）→ 签名附加到该块
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "let me call a tool" },
                    { "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} }
                ],
                "thought_signature": "sig_round_1"
            }]
        });
        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let request_json = serde_json::to_value(request).expect("serialize");
        let content = request_json["messages"][0]["content"]
            .as_array()
            .expect("content array");
        assert_eq!(content[0]["type"], json!("thinking"));
        assert_eq!(content[0]["signature"], json!("sig_round_1"));

        // 情形 2：只有 tool_use（omitted 空思考被上游丢弃）→
        // 补空文本 + signature 的 thinking 块且置于 tool_use 之前
        let body2 = json!({
            "messages": [{
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "toolu_2",
                    "type": "function",
                    "function": { "name": "lookup", "arguments": "{}" }
                }],
                "thought_signature": "sig_round_2"
            }]
        });
        let request2 = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body2);
        let request_json2 = serde_json::to_value(request2).expect("serialize");
        let content2 = request_json2["messages"][0]["content"]
            .as_array()
            .expect("content array");
        assert_eq!(content2[0]["type"], json!("thinking"));
        assert_eq!(content2[0]["thinking"], json!(""));
        assert_eq!(content2[0]["signature"], json!("sig_round_2"));
        assert_eq!(content2[1]["type"], json!("tool_use"));
    }

    #[test]
    fn anthropic_beta_headers_cleaned_up() {
        let adapter = AnthropicAdapter::new();

        // 旧代际 manual thinking + tools：仅保留 interleaved thinking beta 头
        let legacy_body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "enabled", "budget_tokens": 2048 },
            "tools": [{ "type": "function", "function": { "name": "lookup", "parameters": {} } }]
        });
        let legacy_request = adapter
            .build_request(
                "https://api.anthropic.com",
                "key",
                "claude-sonnet-4-5",
                &legacy_body,
            )
            .expect("build legacy request");
        let beta = legacy_request
            .headers
            .iter()
            .find(|(k, _)| k == "anthropic-beta")
            .map(|(_, v)| v.clone());
        assert_eq!(beta.as_deref(), Some("interleaved-thinking-2025-05-14"));

        // 新代际 adaptive：GA 后无需任何 beta 头（interleaved 自动启用）
        let adaptive_body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "thinking": { "type": "adaptive" },
            "effort": "high",
            "tools": [{ "type": "function", "function": { "name": "lookup", "parameters": {} } }]
        });
        let adaptive_request = adapter
            .build_request(
                "https://api.anthropic.com",
                "key",
                "claude-opus-4-8",
                &adaptive_body,
            )
            .expect("build adaptive request");
        assert!(!adaptive_request
            .headers
            .iter()
            .any(|(k, _)| k == "anthropic-beta"));

        // 已 GA 的过时 beta 头绝不出现
        for (_, value) in legacy_request.headers.iter() {
            assert!(!value.contains("thinking-2024-07-31"));
            assert!(!value.contains("tools-2024-04-04"));
            assert!(!value.contains("prompt-caching-2024-07-31"));
        }
    }

    #[test]
    fn anthropic_json_schema_output_uses_ga_schema_field() {
        // GA 形态（研报 02 §3.5）：output_config.format = {type:"json_schema", schema:{...}}
        let adapter = AnthropicAdapter::new();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "answer",
                    "schema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    },
                    "strict": true
                }
            }
        });

        let request = adapter.convert_openai_to_anthropic("claude-sonnet-5", &body);
        let format = request
            .output_config
            .as_ref()
            .and_then(|c| c.get("format"))
            .expect("output_config.format");
        assert_eq!(format["type"], json!("json_schema"));
        assert_eq!(format["schema"]["type"], json!("object"));
        assert!(format.get("json_schema").is_none());
    }
}
