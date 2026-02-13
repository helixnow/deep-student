use crate::utils::fetch::fetch_binary_with_cache;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
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
    /// Gemini 3 思维签名（工具调用必需）
    /// 在工具调用场景下，需要缓存此签名并在后续请求中回传
    ThoughtSignature(String),
    ToolCall(Value),
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
    /// 解析流式响应行，返回事件列表
    fn parse_stream(&self, line: &str) -> Vec<StreamEvent>;
}

pub struct OpenAIAdapter;

impl ProviderAdapter for OpenAIAdapter {
    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        _model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        // 确保 API key 被 trim，移除首尾空白字符
        let trimmed_key = api_key.trim();

        // 调试日志：打印 API key 掩码信息（仅显示前 4 字符 + ****，避免泄露密钥）
        let key_debug = if trimmed_key.is_empty() {
            "EMPTY".to_string()
        } else if trimmed_key.len() <= 4 {
            format!("{}**** (len={})", trimmed_key, trimmed_key.len())
        } else {
            format!(
                "{}**** (len={})",
                trimmed_key.chars().take(4).collect::<String>(),
                trimmed_key.len()
            )
        };
        println!(
            "🔑 [OpenAIAdapter] build_request: url={}, api_key={}",
            url, key_debug
        );

        Ok(ProviderRequest {
            url,
            headers: vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", trimmed_key),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: body.clone(),
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();

        if line.starts_with("data: ") {
            let data = &line[6..];
            if data.trim() == "[DONE]" {
                events.push(StreamEvent::Done);
                return events;
            }

            if let Ok(json_data) = serde_json::from_str::<Value>(data) {
                // OpenAI 走 choices[].delta 路径
                if let Some(choices) = json_data["choices"].as_array() {
                    for choice in choices {
                        if let Some(delta) = choice["delta"].as_object() {
                            // 内容块（使用 get 避免缺键 panic）
                            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                                events.push(StreamEvent::ContentChunk(content.to_string()));
                            }
                            // DeepSeek-R1 推理内容
                            if let Some(reasoning) =
                                delta.get("reasoning_content").and_then(|v| v.as_str())
                            {
                                events.push(StreamEvent::ReasoningChunk(reasoning.to_string()));
                            }
                            // 工具调用
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|v| v.as_array())
                            {
                                for tc in tool_calls {
                                    events.push(StreamEvent::ToolCall(tc.clone()));
                                }
                            }
                        }
                        // finish_reason
                        if let Some(_reason) = choice["finish_reason"].as_str() {
                            // OpenAI 在完成时不额外处理
                        }
                    }
                }
                // usage 信息
                if let Some(usage) = json_data["usage"].as_object() {
                    events.push(StreamEvent::Usage(Value::Object(usage.clone())));
                }
            }
        }

        events
    }
}

pub struct OpenAIResponsesAdapter;

impl OpenAIResponsesAdapter {
    /// 将 Chat Completions 兼容格式转换为 Responses API 请求格式。
    fn convert_to_responses_format(model: &str, body: &Value) -> Value {
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
                            Value::String(text) => {
                                if !text.trim().is_empty() {
                                    instructions.push(text.to_string());
                                }
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

                let mut parts: Vec<Value> = Vec::new();
                match message.get("content") {
                    Some(Value::String(text)) => {
                        if !text.trim().is_empty() {
                            parts.push(json!({ "type": "input_text", "text": text }));
                        }
                    }
                    Some(Value::Array(arr)) => {
                        for part in arr {
                            let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match ptype {
                                "text" => {
                                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                        if !text.is_empty() {
                                            parts.push(
                                                json!({ "type": "input_text", "text": text }),
                                            );
                                        }
                                    }
                                }
                                "image_url" => {
                                    if let Some(url) = part
                                        .get("image_url")
                                        .and_then(|v| v.get("url"))
                                        .and_then(|v| v.as_str())
                                    {
                                        parts.push(
                                            json!({ "type": "input_image", "image_url": url }),
                                        );
                                    }
                                }
                                _ => {
                                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                        if !text.is_empty() {
                                            parts.push(
                                                json!({ "type": "input_text", "text": text }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }

                if !parts.is_empty() {
                    input_blocks.push(json!({
                        "role": role,
                        "content": parts
                    }));
                }
            }
        }

        if input_blocks.is_empty() {
            input_blocks.push(json!({
                "role": "user",
                "content": [{"type": "input_text", "text": ""}]
            }));
        }

        let mut payload = json!({
            "model": model,
            "input": input_blocks,
            "stream": true,
        });

        if !instructions.is_empty() {
            payload["instructions"] = json!(instructions.join("\n\n"));
        }

        if let Some(reasoning) = body.get("reasoning") {
            let mut reasoning_cfg = reasoning.clone();
            if reasoning_cfg.get("summary").is_none() {
                reasoning_cfg["summary"] = json!("auto");
            }
            payload["reasoning"] = reasoning_cfg;
        } else {
            let lower = model.to_lowercase();
            if lower.contains("o1") || lower.contains("o3") || lower.contains("gpt-5") {
                payload["reasoning"] = json!({
                    "summary": "auto"
                });
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
            payload["response_format"] = response_format.clone();
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
}

impl ProviderAdapter for OpenAIResponsesAdapter {
    fn build_request(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        body: &Value,
    ) -> Result<ProviderRequest, ProviderError> {
        let url = format!("{}/responses", base_url.trim_end_matches('/'));
        let trimmed_key = api_key.trim();

        Ok(ProviderRequest {
            url,
            headers: vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", trimmed_key),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Self::convert_to_responses_format(model, body),
        })
    }

    fn parse_stream(&self, line: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        if !line.starts_with("data:") {
            return events;
        }

        let data = line["data:".len()..].trim_start();
        if data == "[DONE]" {
            events.push(StreamEvent::Done);
            return events;
        }

        let parsed = match serde_json::from_str::<Value>(data) {
            Ok(v) => v,
            Err(_) => return events,
        };

        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
                    if !delta.is_empty() {
                        events.push(StreamEvent::ContentChunk(delta.to_string()));
                    }
                }
            }
            "response.reasoning_text.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_text.done" => {
                let text = parsed
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .or_else(|| parsed.get("text").and_then(|v| v.as_str()));
                if let Some(reasoning) = text {
                    if !reasoning.is_empty() {
                        events.push(StreamEvent::ReasoningChunk(reasoning.to_string()));
                    }
                }
            }
            "response.completed" => {
                if let Some(response) = parsed.get("response") {
                    if let Some(reasoning) = Self::extract_reasoning_text(response) {
                        if !reasoning.is_empty() {
                            events.push(StreamEvent::ReasoningChunk(reasoning));
                        }
                    }
                }
                if let Some(usage) = parsed.get("response").and_then(|v| v.get("usage")) {
                    events.push(StreamEvent::Usage(usage.clone()));
                }
                events.push(StreamEvent::Done);
            }
            "response.failed" | "error" => {
                events.push(StreamEvent::Done);
            }
            _ => {}
        }

        events
    }
}

// Anthropic Claude 适配
pub struct AnthropicAdapter {
    pending_tool_calls: Arc<Mutex<HashMap<i32, PartialToolCall>>>,
}

#[derive(Debug, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    buffer: String,
    base_input: Option<Value>,
}

impl AnthropicAdapter {
    pub fn new() -> Self {
        Self {
            pending_tool_calls: Arc::new(Mutex::new(HashMap::new())),
        }
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

        // 提取 thinking 配置
        // 格式: { "type": "enabled", "budget_tokens": 10240 }
        let thinking = body.get("thinking").cloned();
        let has_thinking = thinking
            .as_ref()
            .and_then(|t| t.get("type"))
            .and_then(|t| t.as_str())
            == Some("enabled");

        // 当启用 extended thinking 时，Anthropic 要求 temperature 必须为 1 或不设置
        // 参考: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
        // Claude 4.5 Breaking Change: 不能同时使用 temperature 和 top_p
        // 参考: https://platform.claude.com/docs/en/about-claude/models/migrating-to-claude-4
        let raw_temperature = body
            .get("temperature")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32);
        let raw_top_p = body.get("top_p").and_then(|v| v.as_f64()).map(|v| v as f32);

        let (temperature, top_p) = if has_thinking {
            (None, None) // Extended thinking 不支持自定义采样参数
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
        let top_k = if has_thinking {
            None // Extended thinking 不支持自定义 top_k
        } else {
            body.get("top_k").and_then(|v| v.as_i64()).map(|v| v as i32)
        };

        let mut system_segments: Vec<String> = Vec::new();
        let mut messages: Vec<AnthropicMessage> = Vec::new();

        if let Some(items) = body.get("messages").and_then(|v| v.as_array()) {
            for item in items {
                let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
                match role {
                    "system" | "developer" => {
                        if let Some(texts) = extract_text_segments(item) {
                            system_segments.extend(texts);
                        }
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

        let system = if system_segments.is_empty() {
            None
        } else {
            Some(system_segments.join("\n\n"))
        };

        let tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(convert_tool_definition)
                    .collect::<Vec<_>>()
            })
            .filter(|v: &Vec<AnthropicTool>| !v.is_empty());

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

        let tool_choice = convert_tool_choice(body.get("tool_choice")).or_else(|| {
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

        let output_config = body
            .get("effort")
            .and_then(|v| v.as_str())
            .map(|effort| json!({ "effort": effort }));

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
            response_format,
            thinking,
            output_config,
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

        // 调试日志：打印 URL 和转换后的请求体
        println!("📤 [AnthropicAdapter] 请求 URL: {}", url);
        println!("📤 [AnthropicAdapter] 转换后的请求体:");
        println!("  - model: {}", request.model);
        println!("  - max_tokens: {}", request.max_tokens);
        println!("  - messages: {} 条", request.messages.len());
        println!(
            "  - tools: {:?} 个",
            request.tools.as_ref().map(|t| t.len())
        );
        println!("  - thinking: {:?}", request.thinking);
        println!("  - temperature: {:?}", request.temperature);
        println!("  - top_p: {:?}", request.top_p);
        println!("  - top_k: {:?}", request.top_k);
        if let Some(ref tools) = request.tools {
            for (i, tool) in tools.iter().take(3).enumerate() {
                println!("  - tool[{}].name: {}", i, tool.name);
            }
            if tools.len() > 3 {
                println!("  - ... 还有 {} 个工具", tools.len() - 3);
            }
        }
        // 打印完整 JSON 以便调试
        if let Ok(json_str) = serde_json::to_string_pretty(&body_value) {
            println!("📤 [AnthropicAdapter] 请求体大小: {} 字节", json_str.len());
            println!(
                "📤 [AnthropicAdapter] tool_choice: {:?}",
                request.tool_choice
            );
            println!("📤 [AnthropicAdapter] 完整请求体 JSON (前 3000 字符):");
            println!("{}", &json_str.chars().take(3000).collect::<String>());
        }
        // 验证 JSON 是否有效
        if let Err(e) = serde_json::to_string(&body_value) {
            println!("❌ [AnthropicAdapter] JSON 序列化失败: {}", e);
        }

        let mut beta_features: Vec<&'static str> = Vec::new();
        let has_tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if has_tools {
            // 官方工具调用仍需启用 tools-2024-04-04 beta 标识
            beta_features.push("tools-2024-04-04");
        }
        let has_thinking = body.get("thinking").is_some();
        if has_thinking {
            // Claude 扩展思维链目前要求 thinking-2024-07-31 beta 标识
            beta_features.push("thinking-2024-07-31");

            // Claude 4.x 支持交错思维（interleaved thinking）
            // 允许在工具调用场景中保持思维链的连续性
            // 参考文档：https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
            let is_claude_4 = model.contains("claude-4")
                || model.contains("claude-opus-4")
                || model.contains("claude-sonnet-4");
            if is_claude_4 && has_tools {
                beta_features.push("interleaved-thinking-2025-05-14");
            }
        }

        let has_effort = body.get("effort").is_some();
        if has_effort {
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

        if !line.starts_with("data:") {
            return events;
        }

        let payload = line.trim_start_matches("data:").trim();
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
                                println!(
                                    "🔍 [Provider] 解析到 thinking_delta: 长度={}, 内容预览={}",
                                    text.len(),
                                    &text.chars().take(50).collect::<String>()
                                );
                                events.push(StreamEvent::ReasoningChunk(text.to_string()));
                            }
                        } else {
                            println!("⚠️ [Provider] thinking_delta 类型但无 thinking 字段");
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
            "message_delta" => {
                if let Some(delta) = json_data.get("delta").and_then(|v| v.as_object()) {
                    if let Some(usage) = delta.get("usage") {
                        if let Some(usage_value) = build_usage_event(usage) {
                            events.push(StreamEvent::Usage(usage_value));
                        }
                    }
                    if let Some(stop_reason) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                        if stop_reason == "safety" {
                            events.push(StreamEvent::SafetyBlocked(json!({
                                "type": "content_blocked",
                                "reason": stop_reason
                            })));
                        }
                    }
                }
                if let Some(usage) = json_data.get("usage") {
                    if let Some(usage_value) = build_usage_event(usage) {
                        events.push(StreamEvent::Usage(usage_value));
                    }
                }
            }
            "message_stop" => {
                if let Ok(mut guard) = self.pending_tool_calls.lock() {
                    guard.clear();
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
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
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
    /// Anthropic Extended Thinking 内容块
    /// 用于在多轮对话中传递历史 thinking 内容
    /// 参考: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
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
}

fn extract_text_segments(message: &Value) -> Option<Vec<String>> {
    let content = message.get("content").cloned()?;
    match content {
        Value::String(s) => Some(vec![s]),
        Value::Array(parts) => {
            let mut out = Vec::new();
            for part in parts {
                if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        out.push(text.to_string());
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn convert_user_message(message: &Value) -> Option<AnthropicMessage> {
    let content = message.get("content").cloned()?;
    let mut blocks = Vec::new();
    match content {
        Value::String(s) => {
            if !s.is_empty() {
                blocks.push(AnthropicContentBlock::Text { text: s });
            }
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
            Value::String(text) => {
                if !text.is_empty() {
                    blocks.push(AnthropicContentBlock::Text { text: text.clone() });
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match part_type {
                        // 处理 thinking 块（Extended Thinking 多轮对话）
                        "thinking" => {
                            if let Some(thinking) = part.get("thinking").and_then(|v| v.as_str()) {
                                if !thinking.is_empty() {
                                    blocks.push(AnthropicContentBlock::Thinking {
                                        thinking: thinking.to_string(),
                                    });
                                }
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
            Value::String(text) => {
                if !text.is_empty() {
                    parts.push(AnthropicToolResultContent::Text { text: text.clone() });
                }
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
        is_error: message
            .get("is_error")
            .and_then(|v| v.as_bool())
            .map(|flag| if flag { true } else { false }),
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
/// 🔧 2026-01: 工具命名空间已统一为 'builtin-'，只需处理其他特殊字符（如 '.'）
fn sanitize_tool_name_for_anthropic(name: &str) -> String {
    name.replace('.', "-")
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
    Some(AnthropicTool {
        name,
        description,
        input_schema,
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
            if let Some(schema) = obj.get("json_schema") {
                Some(json!({ "type": "json_schema", "json_schema": schema }))
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

    Some(json!({
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
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
        json!({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens
        })
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
mod tests {
    use super::{OpenAIResponsesAdapter, ProviderAdapter, StreamEvent};
    use serde_json::json;

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
        assert_eq!(payload["response_format"]["type"], json!("json_object"));

        let input = payload["input"].as_array().expect("input should be array");
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], json!("user"));
        assert_eq!(input[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[0]["content"][1]["type"], json!("input_image"));
    }

    #[test]
    fn openai_responses_adapter_parses_stream_events() {
        let adapter = OpenAIResponsesAdapter;

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
    }

    #[test]
    fn openai_responses_adapter_extracts_reasoning_from_completed_event() {
        let adapter = OpenAIResponsesAdapter;
        let events = adapter.parse_stream(
            r#"data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"first"},{"type":"summary_text","text":"second"}]}],"usage":{"input_tokens":1}}}"#,
        );

        assert!(
            matches!(events.first(), Some(StreamEvent::ReasoningChunk(s)) if s.contains("first"))
        );
        assert!(matches!(events.get(1), Some(StreamEvent::Usage(_))));
        assert!(matches!(events.last(), Some(StreamEvent::Done)));
    }
}
