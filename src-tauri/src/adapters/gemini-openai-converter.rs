// gemini_adapter.rs
// 纯库模块：Google/Gemini API适配器，提供请求构建与流式解析能力

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;

use crate::utils::fetch::fetch_binary_with_cache;

// ==================== 公共错误类型 ====================

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("Invalid format: {0}")]
    InvalidFormat(String),

    #[error("Conversion failed: {0}")]
    ConversionFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),
}

// ==================== 公共返回类型 ====================

#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

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

// ==================== OpenAI 数据结构（最小子集） ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIRequest {
    pub model: String,
    pub messages: Vec<OpenAIMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<OpenAIStop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<OpenAITool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<OpenAIMessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<OpenAIToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 🔧 Gemini 3 思维签名：工具调用场景下必须在后续请求中回传
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenAIMessageContent {
    Text(String),
    Array(Vec<OpenAIContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OpenAIContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: OpenAIImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIImageUrl {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAITool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: OpenAIFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIFunction {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: OpenAIFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenAIStop {
    Single(String),
    Multiple(Vec<String>),
}

impl OpenAIStop {
    fn to_vec(&self) -> Vec<String> {
        match self {
            OpenAIStop::Single(value) => vec![value.clone()],
            OpenAIStop::Multiple(values) => values.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIResponse {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<OpenAIChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<OpenAIUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChoice {
    pub index: i32,
    pub message: OpenAIMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIUsage {
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub total_tokens: i32,
}

// ==================== Gemini 数据结构（最小子集） ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiRequest {
    pub contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_config: Option<GeminiGenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<GeminiTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_config: Option<GeminiToolConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiContent {
    pub role: String,
    pub parts: Vec<GeminiPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_data: Option<GeminiInlineData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_call: Option<GeminiFunctionCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_response: Option<GeminiFunctionResponse>,
    /// 🔧 Gemini 3 思维签名：工具调用场景下必须在后续请求中回传
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiInlineData {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionCall {
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionResponse {
    pub name: String,
    pub response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_config: Option<GeminiThinkingConfig>,
}

/// Gemini 思维链配置
///
/// ## Gemini 2.5 vs Gemini 3 配置差异（REST API 使用 camelCase）
/// - **Gemini 2.5**: 使用 `thinkingBudget`（token 数量）
///   - 2.5 Pro: 128-32768，不能禁用
///   - 2.5 Flash: 0-24576，可设为 0 禁用
///   - -1 表示动态分配（默认）
/// - **Gemini 3**: 使用 `thinkingLevel`（预设级别）
///   - 3 Pro: `"low"` | `"high"`（默认 high，不能禁用）
///   - 3 Flash: `"minimal"` | `"low"` | `"medium"` | `"high"`
///
/// 参考文档：https://ai.google.dev/gemini-api/docs/thinking
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiThinkingConfig {
    /// Gemini 2.5 使用：思维预算（token 数量）
    /// - 2.5 Pro: 128-32768 tokens，不能禁用
    /// - 2.5 Flash: 0-24576 tokens，可设为 0 禁用
    /// - -1 表示动态分配（推荐默认）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<i32>,

    /// Gemini 3 使用：思维级别
    /// - **Gemini 3 Pro**: `"low"` | `"high"`（不支持禁用）
    /// - **Gemini 3 Flash**: `"minimal"` | `"low"` | `"medium"` | `"high"`
    ///   - minimal: 近似禁用（复杂任务仍可能思考）
    ///   - low: 轻度思维，最小化延迟
    ///   - medium: 平衡模式
    ///   - high: 深度思维（默认）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,

    /// 是否在响应中包含思维摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_thoughts: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiTool {
    pub function_declarations: Vec<GeminiFunctionDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionDeclaration {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiToolConfig {
    pub function_calling_config: GeminiFunctionCallingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionCallingConfig {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_function_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiResponse {
    pub candidates: Vec<GeminiCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_metadata: Option<GeminiUsageMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_feedback: Option<GeminiPromptFeedback>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiCandidate {
    pub content: GeminiContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    pub index: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_ratings: Option<Vec<GeminiSafetyRating>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiUsageMetadata {
    pub prompt_token_count: i32,
    pub candidates_token_count: i32,
    pub total_token_count: i32,
    /// 思维 token 统计（Gemini 2.5/3 启用思维时返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thoughts_token_count: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSafetyRating {
    pub category: String,
    pub probability: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPromptFeedback {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_ratings: Option<Vec<GeminiSafetyRating>>,
}

// ==================== 核心转换函数 ====================

/// 构建Gemini请求（不发网络）
pub fn build_gemini_request(
    base_url: &str,
    api_key: &str,
    model: &str,
    openai_body: &Value,
) -> Result<ProviderRequest, AdapterError> {
    build_gemini_request_with_version(base_url, api_key, model, openai_body, None)
}

/// 构建Gemini请求，支持指定API版本
pub fn build_gemini_request_with_version(
    base_url: &str,
    api_key: &str,
    model: &str,
    openai_body: &Value,
    api_version: Option<&str>,
) -> Result<ProviderRequest, AdapterError> {
    // 反序列化OpenAI请求（兼容 max_total_tokens 等扩展字段）
    let mut normalized_body = openai_body.clone();
    let mut reasoning_effort = None;
    let mut google_thinking_config: Option<Value> = None;
    let mut injected_top_k: Option<i32> = None;

    if let Value::Object(map) = &mut normalized_body {
        if let Some(value) = map.get("max_total_tokens").cloned() {
            if !map.contains_key("max_tokens") {
                map.insert("max_tokens".to_string(), value.clone());
            }
            map.remove("max_total_tokens");
        }

        if let Some(value) = map.get("max_completion_tokens").cloned() {
            if !map.contains_key("max_tokens") {
                map.insert("max_tokens".to_string(), value.clone());
            }
            map.remove("max_completion_tokens");
        }

        if let Some(value) = map.get("reasoning_effort") {
            reasoning_effort = value.as_str().map(|s| s.to_string());
        }
        map.remove("reasoning_effort");

        if let Some(value) = map.get("google_thinking_config").cloned() {
            google_thinking_config = Some(value);
        }
        map.remove("google_thinking_config");

        // 🔧 修复：Gemini adapter 使用 thinkingConfig (camelCase) 键写入，
        // 需要同时读取此键作为 fallback，否则 includeThoughts 等值会丢失
        if google_thinking_config.is_none() {
            if let Some(value) = map.get("thinkingConfig").cloned() {
                google_thinking_config = Some(value);
            }
        }
        map.remove("thinkingConfig");
        // 同时清理 adapter 可能注入的 gemini_api_version
        map.remove("gemini_api_version");

        // 读取顶层扩展的 top_k（来自 LLMManager.apply_reasoning_config）
        if let Some(v) = map.get("top_k").and_then(|v| v.as_i64()) {
            // clamp 合理范围（最小为1）
            let clamped = v.clamp(1, 1_000_000);
            injected_top_k = Some(clamped as i32);
        }
    }

    let openai_req: OpenAIRequest = serde_json::from_value(normalized_body).map_err(|e| {
        AdapterError::SerializationError(format!("Failed to parse OpenAI request: {}", e))
    })?;

    // 转换为Gemini请求
    let mut gemini_req = convert_openai_to_gemini(&openai_req)?;
    // 记录是否包含 systemInstruction，以便版本选择与兼容降级
    let system_instruction_present = gemini_req.system_instruction.is_some();

    // 注入 top_k 到 generation_config（若存在）
    if let Some(top_k) = injected_top_k {
        let cfg = gemini_req
            .generation_config
            .get_or_insert(GeminiGenerationConfig {
                temperature: openai_req.temperature,
                top_p: openai_req.top_p,
                top_k: None,
                max_output_tokens: openai_req.max_tokens,
                stop_sequences: None,
                response_mime_type: None,
                response_schema: None,
                thinking_config: None,
            });
        cfg.top_k = Some(top_k);
    }

    // 应用思维链/推理配置
    let mut thinking_budget: Option<i32> = None;
    let mut thinking_level: Option<String> = None;
    let mut include_thoughts = None;

    // 检测是否是 Gemini 3 模型（使用 thinkingLevel 而非 thinkingBudget）
    let is_gemini_3 = model.to_lowercase().contains("gemini-3");

    if let Some(extra) = google_thinking_config.and_then(|v| v.as_object().cloned()) {
        // Gemini 3 优先使用 thinking_level（兼容 snake_case 和 camelCase）
        if let Some(level) = extra
            .get("thinking_level")
            .or_else(|| extra.get("thinkingLevel"))
            .and_then(|v| v.as_str())
        {
            thinking_level = Some(level.to_string());
        }
        // Gemini 2.5 使用 thinking_budget（兼容 snake_case 和 camelCase）
        if let Some(budget) = extra
            .get("thinking_budget")
            .or_else(|| extra.get("thinkingBudget"))
            .and_then(|v| v.as_i64())
        {
            let clamped = budget.clamp(-1, 2_147_483_647);
            thinking_budget = Some(clamped as i32);
        }
        // includeThoughts（兼容 snake_case 和 camelCase）
        if let Some(include) = extra
            .get("include_thoughts")
            .or_else(|| extra.get("includeThoughts"))
            .and_then(|v| v.as_bool())
        {
            include_thoughts = Some(include);
        }
    }

    // 检测是否是 Gemini 3 Flash（支持更多 thinkingLevel 值）
    let is_gemini_3_flash =
        model.to_lowercase().contains("gemini-3") && model.to_lowercase().contains("flash");

    if let Some(effort) = reasoning_effort.as_deref() {
        if is_gemini_3 {
            // Gemini 3: 将 reasoning_effort 映射到 thinkingLevel
            // - Gemini 3 Pro: 仅支持 "low", "high"
            // - Gemini 3 Flash: 支持 "minimal", "low", "medium", "high"
            let level = match effort.to_ascii_lowercase().as_str() {
                "minimal" | "none" | "unset" => {
                    if is_gemini_3_flash {
                        "minimal"
                    } else {
                        "low"
                    } // Pro 不支持 minimal
                }
                "low" => "low",
                "medium" => {
                    if is_gemini_3_flash {
                        "medium"
                    } else {
                        "high"
                    } // Pro 不支持 medium
                }
                "high" => "high",
                _ => "low", // 默认使用 low
            };
            thinking_level = Some(level.to_string());
        } else {
            // Gemini 2.5: 使用 thinkingBudget
            let budget = match effort.to_ascii_lowercase().as_str() {
                "minimal" => Some(256),
                "low" => Some(1024),
                "medium" => Some(8192),
                "high" => Some(24576),
                "none" | "unset" => Some(0),
                _ => None,
            };
            if let Some(b) = budget {
                let clamped = b.clamp(-1, 2_147_483_647);
                thinking_budget = Some(clamped);
            }
        }
    }

    if thinking_budget.is_some() || thinking_level.is_some() || include_thoughts.is_some() {
        let cfg = gemini_req
            .generation_config
            .get_or_insert(GeminiGenerationConfig {
                temperature: openai_req.temperature,
                top_p: openai_req.top_p,
                top_k: None,
                max_output_tokens: openai_req.max_tokens,
                stop_sequences: None,
                response_mime_type: None,
                response_schema: None,
                thinking_config: None,
            });

        cfg.thinking_config = Some(GeminiThinkingConfig {
            thinking_budget: if is_gemini_3 { None } else { thinking_budget },
            thinking_level: if is_gemini_3 { thinking_level } else { None },
            include_thoughts,
        });
    }

    // 构造URL和headers
    let is_stream = openai_req.stream.unwrap_or(false);
    let endpoint = if is_stream {
        "streamGenerateContent"
    } else {
        "generateContent"
    };

    let query = if is_stream {
        format!("alt=sse&key={}", api_key)
    } else {
        format!("key={}", api_key)
    };

    let mut resolved_version = api_version.map(|s| s.to_string());
    let thinking_config_present = gemini_req
        .generation_config
        .as_ref()
        .and_then(|cfg| cfg.thinking_config.as_ref())
        .is_some();

    // 若包含思维链配置、systemInstruction 或 Gemini 3 模型，则使用 v1beta
    // Gemini 3 模型仅在 v1beta 上可用，即使测试请求不含 thinkingConfig 也需要 v1beta
    let require_v1beta = thinking_config_present || system_instruction_present || is_gemini_3;

    if require_v1beta {
        match resolved_version.as_deref() {
            Some("v1beta") => {}
            Some("v1") => {
                resolved_version = Some("v1beta".to_string());
            }
            Some(_) => {}
            None => {
                resolved_version = Some("v1beta".to_string());
            }
        }
    }

    let mut base_root = base_url.trim_end_matches('/').to_string();
    let mut version_in_base: Option<String> = None;

    if let Some(pos) = base_root.rfind('/') {
        let last_segment = &base_root[pos + 1..];
        let is_version_segment = last_segment.starts_with('v')
            && last_segment
                .chars()
                .nth(1)
                .map(|ch| ch.is_ascii_digit())
                .unwrap_or(false);
        if is_version_segment {
            version_in_base = Some(last_segment.to_string());
            base_root = base_root[..pos].to_string();
        }
    }

    let final_version = resolved_version
        .as_deref()
        .or_else(|| version_in_base.as_deref())
        .unwrap_or("v1");

    let base_root_trimmed = base_root.trim_end_matches('/');
    let base_with_version = if base_root_trimmed.ends_with("://") || base_root_trimmed.is_empty() {
        format!("{}{}", base_root_trimmed, final_version)
    } else {
        format!("{}/{}", base_root_trimmed, final_version)
    };

    // 兼容降级：如果最终版本为 v1，但请求体包含 systemInstruction，则将其合并进 contents 并移除该字段
    if final_version == "v1" {
        if let Some(sys) = gemini_req.system_instruction.take() {
            // 合并所有文本 part
            let mut merged_texts: Vec<String> = Vec::new();
            for part in sys.parts.into_iter() {
                if let Some(t) = part.text {
                    if !t.trim().is_empty() {
                        merged_texts.push(t);
                    }
                }
            }
            if !merged_texts.is_empty() {
                let merged = merged_texts.join("\n\n");
                if let Some(first) = gemini_req.contents.first_mut() {
                    // 将系统指令文本插入到首条内容的最前面
                    first.parts.insert(
                        0,
                        GeminiPart {
                            text: Some(merged),
                            inline_data: None,
                            function_call: None,
                            function_response: None,
                            thought_signature: None,
                        },
                    );
                } else {
                    // 如无内容，创建一条用户内容承载系统指令
                    gemini_req.contents.push(GeminiContent {
                        role: "user".to_string(),
                        parts: vec![GeminiPart {
                            text: Some(merged),
                            inline_data: None,
                            function_call: None,
                            function_response: None,
                            thought_signature: None,
                        }],
                    });
                }
            }
        }
    }

    let url = format!(
        "{}/models/{}:{}?{}",
        base_with_version, model, endpoint, query
    );

    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("x-goog-api-key".to_string(), api_key.to_string()),
    ];

    // 序列化Gemini请求为JSON
    let body = serde_json::to_value(gemini_req).map_err(|e| {
        AdapterError::SerializationError(format!("Failed to serialize Gemini request: {}", e))
    })?;

    Ok(ProviderRequest { url, headers, body })
}

/// 解析单行SSE（流式）
pub fn parse_gemini_stream_line(
    line: &str,
    pending_tool_calls: &Arc<Mutex<HashMap<i64, (String, String)>>>,
) -> Vec<StreamEvent> {
    let mut events = Vec::new();

    // 检查是否是结束标记
    if line.trim() == "data: [DONE]" {
        events.push(StreamEvent::Done);
        if let Ok(mut state) = pending_tool_calls.lock() {
            state.clear();
        }
        return events;
    }

    // 检查是否以"data: "开头
    if !line.starts_with("data: ") {
        return events;
    }

    // 提取JSON部分
    let json_str = &line[6..]; // 跳过"data: "

    // 尝试解析JSON
    let json_value: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return events, // 忽略非JSON行
    };

    // 提取文本内容
    if let Some(candidates) = json_value.get("candidates").and_then(|c| c.as_array()) {
        if let Some(candidate) = candidates.first() {
            if let Some(content) = candidate.get("content") {
                if let Some(parts) = content.get("parts").and_then(|p| p.as_array()) {
                    // 受控调试：仅在 debug 构建中打印一次 part 的关键字段名，避免泄漏正文
                    if cfg!(debug_assertions) {
                        if let Some(first) = parts.first() {
                            if let Some(obj) = first.as_object() {
                                let keys: Vec<String> =
                                    obj.keys().take(12).map(|k| k.to_string()).collect();
                                println!("[Gemini][SSE][part_keys]={:?}", keys);
                            }
                        }
                    }
                    for (idx, part) in parts.iter().enumerate() {
                        let index = part
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(idx as i64);

                        let mut is_thought = match part.get("thought") {
                            Some(Value::Bool(b)) => *b,
                            Some(Value::String(s)) => !s.trim().is_empty(),
                            Some(Value::Object(obj)) => {
                                obj.get("value").and_then(|v| v.as_bool()).unwrap_or(true)
                            }
                            _ => false,
                        };
                        if !is_thought {
                            if let Some(metadata) = part.get("metadata") {
                                if metadata
                                    .get("type")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.eq_ignore_ascii_case("thought"))
                                    .unwrap_or(false)
                                {
                                    is_thought = true;
                                }
                                if metadata
                                    .get("isThought")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false)
                                {
                                    is_thought = true;
                                }
                            }
                        }
                        if !is_thought {
                            if let Some(kind) = part.get("kind").and_then(|v| v.as_str()) {
                                if kind.eq_ignore_ascii_case("thought") {
                                    is_thought = true;
                                }
                            }
                        }
                        if !is_thought {
                            if let Some(part_type) = part.get("type").and_then(|v| v.as_str()) {
                                if part_type.eq_ignore_ascii_case("thought") {
                                    is_thought = true;
                                }
                            }
                        }

                        if is_thought {
                            let extracted = extract_thought_texts(part);
                            if extracted.is_empty() {
                                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                    if !text.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(text.to_string()));
                                    }
                                }
                            } else {
                                for item in extracted {
                                    if !item.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(item));
                                    }
                                }
                            }
                        } else {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    events.push(StreamEvent::ContentChunk(text.to_string()));
                                }
                            }
                        }

                        if let Some(thoughts) = part.get("thoughts").and_then(|t| t.as_array()) {
                            for item in thoughts {
                                for chunk in extract_thought_texts(item) {
                                    if !chunk.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(chunk));
                                    }
                                }
                            }
                        }

                        // 提取 Gemini 3 thoughtSignature（工具调用必需）
                        if let Some(signature) =
                            part.get("thoughtSignature").and_then(|v| v.as_str())
                        {
                            if !signature.is_empty() {
                                events.push(StreamEvent::ThoughtSignature(signature.to_string()));
                            }
                        }

                        // 提取函数调用
                        if let Some(function_call) = part.get("functionCall") {
                            if let Some(name) = function_call.get("name").and_then(|n| n.as_str()) {
                                let args = function_call.get("args").cloned().unwrap_or(json!({}));
                                let args_str = serde_json::to_string(&args)
                                    .unwrap_or_else(|_| "{}".to_string());

                                let mut state = pending_tool_calls
                                    .lock()
                                    .expect("Gemini tool state poisoned");
                                let entry = state.entry(index).or_insert_with(|| {
                                    (format!("call-{}", Uuid::new_v4()), name.to_string())
                                });
                                let tool_call = json!({
                                    "id": entry.0,
                                    "type": "function",
                                    "function": {
                                        "name": entry.1,
                                        "arguments": args_str
                                    },
                                    "index": index
                                });

                                events.push(StreamEvent::ToolCall(tool_call));
                            }
                        }
                    }
                }
            }

            if let Some(thoughts) = candidate.get("thoughts").and_then(|v| v.as_array()) {
                for item in thoughts {
                    if let Some(text) = item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.get("content").and_then(|v| v.as_str()))
                        .or_else(|| item.as_str())
                    {
                        if !text.is_empty() {
                            events.push(StreamEvent::ReasoningChunk(text.to_string()));
                        }
                    }
                }
            }

            // 提取 candidate 级别的 thoughtSignature（Gemini 3）
            if let Some(signature) = candidate.get("thoughtSignature").and_then(|v| v.as_str()) {
                if !signature.is_empty() {
                    events.push(StreamEvent::ThoughtSignature(signature.to_string()));
                }
            }

            // 检查delta结构（某些流式响应可能使用）
            if let Some(delta) = candidate.get("delta") {
                if let Some(parts) = delta.get("parts").and_then(|p| p.as_array()) {
                    for (idx, part) in parts.iter().enumerate() {
                        let index = part
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(idx as i64);

                        let mut is_thought = part
                            .get("thought")
                            .and_then(|flag| flag.as_bool())
                            .unwrap_or(false);
                        if !is_thought {
                            if let Some(metadata) = part.get("metadata") {
                                if metadata
                                    .get("type")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.eq_ignore_ascii_case("thought"))
                                    .unwrap_or(false)
                                {
                                    is_thought = true;
                                }
                                if metadata
                                    .get("isThought")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false)
                                {
                                    is_thought = true;
                                }
                            }
                        }
                        if !is_thought {
                            if let Some(kind) = part.get("kind").and_then(|v| v.as_str()) {
                                if kind.eq_ignore_ascii_case("thought") {
                                    is_thought = true;
                                }
                            }
                        }
                        if !is_thought {
                            if let Some(part_type) = part.get("type").and_then(|v| v.as_str()) {
                                if part_type.eq_ignore_ascii_case("thought") {
                                    is_thought = true;
                                }
                            }
                        }

                        if is_thought {
                            let extracted = extract_thought_texts(part);
                            if extracted.is_empty() {
                                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                    if !text.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(text.to_string()));
                                    }
                                }
                            } else {
                                for item in extracted {
                                    if !item.is_empty() {
                                        events.push(StreamEvent::ReasoningChunk(item));
                                    }
                                }
                            }
                            continue;
                        }

                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                events.push(StreamEvent::ContentChunk(text.to_string()));
                            }
                        }
                        if let Some(thoughts) = part.get("thoughts").and_then(|t| t.as_array()) {
                            for item in thoughts {
                                let extracted = extract_thought_texts(item);
                                if extracted.is_empty() {
                                    if let Some(text) = item
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| item.get("content").and_then(|v| v.as_str()))
                                    {
                                        if !text.is_empty() {
                                            events.push(StreamEvent::ReasoningChunk(
                                                text.to_string(),
                                            ));
                                        }
                                    }
                                } else {
                                    for entry in extracted {
                                        if !entry.is_empty() {
                                            events.push(StreamEvent::ReasoningChunk(entry));
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(function_call) = part.get("functionCall") {
                            if let Some(name) = function_call.get("name").and_then(|n| n.as_str()) {
                                let args = function_call.get("args").cloned().unwrap_or(json!({}));
                                let args_str = serde_json::to_string(&args)
                                    .unwrap_or_else(|_| "{}".to_string());

                                let mut state = pending_tool_calls
                                    .lock()
                                    .expect("Gemini tool state poisoned");
                                let entry = state.entry(index).or_insert_with(|| {
                                    (format!("call-{}", Uuid::new_v4()), name.to_string())
                                });

                                let tool_call = json!({
                                    "id": entry.0,
                                    "type": "function",
                                    "function": {
                                        "name": entry.1,
                                        "arguments": args_str
                                    },
                                    "index": index
                                });

                                events.push(StreamEvent::ToolCall(tool_call));
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(thoughts) = json_value.get("thoughts").and_then(|v| v.as_array()) {
        for item in thoughts {
            if let Some(text) = item
                .get("text")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("content").and_then(|v| v.as_str()))
                .or_else(|| item.as_str())
            {
                if !text.is_empty() {
                    events.push(StreamEvent::ReasoningChunk(text.to_string()));
                }
            }
        }
    }

    // 提取用量信息（健壮性：确保字段完整性）
    if let Some(usage_metadata) = json_value.get("usageMetadata") {
        // 提供健壮的用量信息，缺失字段时使用零值
        let prompt_tokens = usage_metadata
            .get("promptTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(0);
        let completion_tokens = usage_metadata
            .get("candidatesTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(0);
        let total_tokens = usage_metadata
            .get("totalTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(prompt_tokens + completion_tokens);
        // P2 修复：解析 thoughtsTokenCount（Gemini 2.5/3 启用思维时返回）
        let thoughts_tokens = usage_metadata
            .get("thoughtsTokenCount")
            .and_then(|t| t.as_i64());

        let prompt_tokens = prompt_tokens as i32;
        let completion_tokens = completion_tokens as i32;
        let total_tokens = total_tokens as i32;

        let mut robust_usage = json!({
            "promptTokenCount": prompt_tokens,
            "candidatesTokenCount": completion_tokens,
            "totalTokenCount": total_tokens,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            // 保留原始数据以备需要
            "original": usage_metadata
        });

        // 添加思维 token 统计（如果存在）
        if let Some(thoughts) = thoughts_tokens {
            robust_usage["thoughtsTokenCount"] = json!(thoughts);
            robust_usage["reasoning_tokens"] = json!(thoughts);
        }

        events.push(StreamEvent::Usage(robust_usage));
    }

    // 检查安全阻断
    if let Some(prompt_feedback) = json_value.get("promptFeedback") {
        if let Some(block_reason) = prompt_feedback.get("blockReason") {
            let safety_info = json!({
                "type": "prompt_blocked",
                "reason": block_reason,
                "details": prompt_feedback
            });
            events.push(StreamEvent::SafetyBlocked(safety_info));
        }
    }

    // 检查候选项安全阻断
    if let Some(candidates) = json_value.get("candidates").and_then(|c| c.as_array()) {
        for candidate in candidates {
            if let Some(finish_reason) = candidate.get("finishReason").and_then(|f| f.as_str()) {
                if finish_reason == "SAFETY" {
                    let safety_info = json!({
                        "type": "content_blocked",
                        "reason": "SAFETY",
                        "safetyRatings": candidate.get("safetyRatings").cloned(),
                        "details": candidate
                    });
                    events.push(StreamEvent::SafetyBlocked(safety_info));
                }
            }
        }
    }

    if !events.is_empty() {
        if let StreamEvent::Done = events.last().unwrap() {
            if let Ok(mut state) = pending_tool_calls.lock() {
                state.clear();
            }
        }
    }

    events
}

/// 非流式响应转换（Gemini -> OpenAI）
fn extract_thought_texts(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match value {
        Value::String(s) => out.push(s.to_string()),
        Value::Object(obj) => {
            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                out.push(text.to_string());
            }
            if let Some(content) = obj.get("content") {
                out.extend(extract_thought_texts(content));
            }
            if let Some(parts) = obj.get("parts").and_then(|v| v.as_array()) {
                for part in parts {
                    out.extend(extract_thought_texts(part));
                }
            }
            if let Some(data) = obj.get("data") {
                out.extend(extract_thought_texts(data));
            }
        }
        Value::Array(arr) => {
            for item in arr {
                out.extend(extract_thought_texts(item));
            }
        }
        _ => {}
    }
    out
}

pub fn convert_gemini_nonstream_response_to_openai(
    gemini_json: &Value,
    model: &str,
) -> Result<Value, AdapterError> {
    // 首先检查安全阻断
    if let Some(prompt_feedback) = gemini_json.get("promptFeedback") {
        if let Some(block_reason) = prompt_feedback.get("blockReason") {
            let error_msg = format!("Request blocked due to safety reasons: {}", block_reason);
            return Err(AdapterError::InvalidFormat(error_msg));
        }
    }

    // 提取candidates
    let candidates = gemini_json
        .get("candidates")
        .and_then(|c| c.as_array())
        .ok_or_else(|| {
            AdapterError::InvalidFormat("Missing candidates in Gemini response".to_string())
        })?;

    if candidates.is_empty() {
        return Err(AdapterError::InvalidFormat(
            "Empty candidates array".to_string(),
        ));
    }

    let mut choices = Vec::new();

    for (index, candidate) in candidates.iter().enumerate() {
        let mut text_parts = Vec::new();
        let mut reasoning_parts = Vec::new();
        let mut tool_calls = Vec::new();

        // 提取内容
        if let Some(content) = candidate.get("content") {
            if let Some(parts) = content.get("parts").and_then(|p| p.as_array()) {
                for part in parts {
                    if cfg!(debug_assertions) {
                        if let Ok(debug_part) = serde_json::to_string(part) {
                            println!("[Gemini][convert_nonstream] part: {}", debug_part);
                        }
                    }
                    // 提取文本
                    let is_thought = part
                        .get("thought")
                        .and_then(|flag| flag.as_bool())
                        .unwrap_or(false);

                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        if is_thought {
                            reasoning_parts.push(text.to_string());
                        } else {
                            text_parts.push(text.to_string());
                        }
                    }

                    // 提取函数调用
                    if let Some(function_call) = part.get("functionCall") {
                        if let Some(name) = function_call.get("name").and_then(|n| n.as_str()) {
                            let args = function_call.get("args").cloned().unwrap_or(json!({}));
                            let args_str =
                                serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());

                            tool_calls.push(json!({
                                "id": format!("call-{}", Uuid::new_v4()),
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": args_str
                                }
                            }));
                        }
                    }
                }
            }
        }

        // 合并文本
        let mut main_text = text_parts.join("\n");
        let mut reasoning_texts = reasoning_parts;

        if reasoning_texts.is_empty() {
            let mut fallback_reasoning = Vec::new();
            if let Some(candidate_thoughts) = candidate.get("thoughts") {
                fallback_reasoning.extend(extract_thought_texts(candidate_thoughts));
            }
            if fallback_reasoning.is_empty() {
                if let Some(global_thoughts) = gemini_json.get("thoughts") {
                    fallback_reasoning.extend(extract_thought_texts(global_thoughts));
                }
            }
            reasoning_texts = fallback_reasoning;
        }

        for snippet in &reasoning_texts {
            let snippet_trim = snippet.trim();
            if snippet_trim.is_empty() {
                continue;
            }
            if main_text.contains(snippet_trim) {
                main_text = main_text.replacen(snippet_trim, "", 1);
            }
        }
        main_text = main_text.trim().to_string();
        let combined_reasoning = reasoning_texts
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        // 构造message
        let mut message = json!({
            "role": "assistant",
            "content": main_text
        });

        if !combined_reasoning.is_empty() {
            message["thinking_content"] = json!(combined_reasoning.clone());
        }

        // 添加tool_calls如果存在
        if !tool_calls.is_empty() {
            message["tool_calls"] = json!(tool_calls);
        }

        // 获取finish_reason
        let finish_reason = candidate
            .get("finishReason")
            .and_then(|f| f.as_str())
            .map(|s| s.to_string());

        let finish_reason_str = finish_reason
            .as_deref()
            .map(map_gemini_finish_reason)
            .unwrap_or("stop");

        let mut choice = json!({
            "index": index as i32,
            "message": message,
            "finish_reason": finish_reason_str
        });

        if !combined_reasoning.is_empty() {
            choice["message"] = message.clone();
        }

        choices.push(choice);
    }

    // 转换用量信息（健壮性：缺失字段时给出零值默认）
    let usage = if let Some(usage_metadata) = gemini_json.get("usageMetadata") {
        let prompt_tokens = usage_metadata
            .get("promptTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(0) as i32;
        let completion_tokens = usage_metadata
            .get("candidatesTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(0) as i32;
        let total_tokens = usage_metadata
            .get("totalTokenCount")
            .and_then(|t| t.as_i64())
            .unwrap_or(prompt_tokens as i64 + completion_tokens as i64)
            as i32;
        // P2 修复：解析 thoughtsTokenCount（Gemini 2.5/3 启用思维时返回）
        let thoughts_tokens = usage_metadata
            .get("thoughtsTokenCount")
            .and_then(|t| t.as_i64())
            .map(|t| t as i32);

        let mut usage_obj = json!({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens
        });

        // 添加思维 token 统计（如果存在）
        if let Some(thoughts) = thoughts_tokens {
            usage_obj["reasoning_tokens"] = json!(thoughts);
        }

        Some(usage_obj)
    } else {
        // 即使没有usageMetadata，也提供默认的零值用量信息
        Some(json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0
        }))
    };

    // 构造OpenAI响应
    let mut response = json!({
        "id": format!("chatcmpl-{}", Uuid::new_v4()),
        "object": "chat.completion",
        "created": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        "model": model,
        "choices": choices
    });

    if let Some(usage_value) = usage {
        response["usage"] = usage_value;
    }

    Ok(response)
}

// ==================== 内部辅助函数 ====================

fn convert_openai_to_gemini(openai_req: &OpenAIRequest) -> Result<GeminiRequest, AdapterError> {
    let mut contents = Vec::new();
    let mut system_instruction = None;

    // 处理消息
    for message in &openai_req.messages {
        match message.role.as_str() {
            "system" => {
                // 系统消息转为system_instruction
                if let Some(content) = &message.content {
                    let text = extract_text_from_openai_content(content);
                    if !text.is_empty() {
                        system_instruction = Some(GeminiContent {
                            role: "user".to_string(),
                            parts: vec![GeminiPart {
                                text: Some(text),
                                inline_data: None,
                                function_call: None,
                                function_response: None,
                                thought_signature: None,
                            }],
                        });
                    }
                }
            }
            "user" => {
                // 用户消息
                if let Some(content) = &message.content {
                    let parts = convert_openai_content_to_gemini_parts(content)?;
                    if !parts.is_empty() {
                        contents.push(GeminiContent {
                            role: "user".to_string(),
                            parts,
                        });
                    }
                }
            }
            "assistant" => {
                // 助手消息
                let mut parts = Vec::new();

                // 处理文本内容
                if let Some(content) = &message.content {
                    let text = extract_text_from_openai_content(content);
                    if !text.is_empty() {
                        parts.push(GeminiPart {
                            text: Some(text),
                            inline_data: None,
                            function_call: None,
                            function_response: None,
                            thought_signature: None,
                        });
                    }
                }

                // 处理工具调用
                // 🔧 Gemini 3：thoughtSignature 必须和 functionCall 在同一个 part 中
                // 流式响应中 [part_keys]=["functionCall", "thoughtSignature"] 表明它们是同一个 part
                if let Some(tool_calls) = &message.tool_calls {
                    let sig = message.thought_signature.clone();
                    for (i, tool_call) in tool_calls.iter().enumerate() {
                        if tool_call.tool_type == "function" {
                            let args: Value = serde_json::from_str(&tool_call.function.arguments)
                                .unwrap_or(json!({}));
                            parts.push(GeminiPart {
                                text: None,
                                inline_data: None,
                                function_call: Some(GeminiFunctionCall {
                                    name: tool_call.function.name.clone(),
                                    args,
                                }),
                                function_response: None,
                                // 第一个 functionCall part 携带 thoughtSignature
                                thought_signature: if i == 0 { sig.clone() } else { None },
                            });
                        }
                    }
                }

                if !parts.is_empty() {
                    contents.push(GeminiContent {
                        role: "model".to_string(),
                        parts,
                    });
                }
            }
            "function" | "tool" => {
                // 函数/工具响应
                // 🔧 修复：OpenAI tool 消息可能没有 name 字段，需要从 tool_call_id
                // 查找前面 assistant 消息的 tool_calls 来获取函数名
                let resolved_name = message.name.clone().or_else(|| {
                    if let Some(tool_call_id) = &message.tool_call_id {
                        // 从前面的消息中查找对应的 tool_call
                        for prev_msg in &openai_req.messages {
                            if prev_msg.role == "assistant" {
                                if let Some(tool_calls) = &prev_msg.tool_calls {
                                    for tc in tool_calls {
                                        if tc.id == *tool_call_id {
                                            return Some(tc.function.name.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                    None
                });

                if let Some(name) = resolved_name {
                    if let Some(content) = &message.content {
                        let response_text = extract_text_from_openai_content(content);
                        let response_value: Value = serde_json::from_str(&response_text)
                            .unwrap_or_else(|_| json!({"result": response_text}));

                        let new_part = GeminiPart {
                            text: None,
                            inline_data: None,
                            function_call: None,
                            function_response: Some(GeminiFunctionResponse {
                                name: name.clone(),
                                response: response_value,
                            }),
                            thought_signature: None,
                        };

                        // 🔧 Gemini 要求角色交替：多个 functionResponse 必须合并到同一个 user content 块
                        // 官方文档示例：并行工具调用的结果在一个 user 消息中包含多个 functionResponse parts
                        let should_merge = contents.last().map_or(false, |last: &GeminiContent| {
                            last.role == "user"
                                && last.parts.iter().all(|p| p.function_response.is_some())
                        });

                        if should_merge {
                            contents.last_mut().unwrap().parts.push(new_part);
                        } else {
                            contents.push(GeminiContent {
                                role: "user".to_string(),
                                parts: vec![new_part],
                            });
                        }
                    }
                }
            }
            _ => {
                // 忽略未知角色
            }
        }
    }

    // 🔧 防御性后处理：合并连续同角色 content，确保 Gemini 角色交替要求
    // Gemini API 要求 contents 中 user 和 model 角色严格交替
    // 如果 OpenAI 消息转换后产生连续同角色 turn（如两个连续 assistant/model），会触发 400 错误
    if contents.len() >= 2 {
        let mut merged_contents: Vec<GeminiContent> = Vec::with_capacity(contents.len());
        for content in contents.drain(..) {
            let should_merge = merged_contents
                .last()
                .map_or(false, |last| last.role == content.role);
            if should_merge {
                let last = merged_contents.last_mut().unwrap();
                let merged_count = content.parts.len();
                last.parts.extend(content.parts);
                log::warn!(
                    "[GeminiConverter] Merged consecutive '{}' turns ({} parts appended)",
                    last.role,
                    merged_count
                );
            } else {
                merged_contents.push(content);
            }
        }
        contents = merged_contents;
    }

    // 🔧 Gemini 3+ 防护：将没有 thoughtSignature 的 functionCall 降级为文本
    // 合成的 load_skills 等工具调用没有真实的 thoughtSignature，
    // Gemini 3+ 会拒绝此类请求（400: "Function call is missing a thought_signature"）。
    // 将它们及对应的 functionResponse 转换为等价的文本消息。
    {
        let mut i = 0;
        while i < contents.len() {
            let has_unprotected_fc = contents[i].role == "model"
                && contents[i]
                    .parts
                    .iter()
                    .any(|p| p.function_call.is_some() && p.thought_signature.is_none());

            if has_unprotected_fc {
                // 将 functionCall parts 转换为文本描述
                for part in &mut contents[i].parts {
                    if part.function_call.is_some() && part.thought_signature.is_none() {
                        if let Some(fc) = part.function_call.take() {
                            let args_str =
                                serde_json::to_string(&fc.args).unwrap_or_else(|_| "{}".into());
                            part.text =
                                Some(format!("[Tool call: {}({})]", fc.name, args_str));
                        }
                    }
                }

                // 将紧随其后的 user content 中的 functionResponse parts 也转换为文本
                if i + 1 < contents.len() && contents[i + 1].role == "user" {
                    for part in &mut contents[i + 1].parts {
                        if part.function_response.is_some() {
                            if let Some(fr) = part.function_response.take() {
                                let resp_str = serde_json::to_string(&fr.response)
                                    .unwrap_or_else(|_| "{}".into());
                                part.text = Some(format!(
                                    "[Tool result for {}: {}]",
                                    fr.name, resp_str
                                ));
                            }
                        }
                    }
                }

                log::warn!(
                    "[GeminiConverter] Converted functionCall without thoughtSignature to text at content index {}",
                    i
                );
            }
            i += 1;
        }
    }

    // 确保第一个 content 是 user 角色（Gemini 要求）
    if let Some(first) = contents.first() {
        if first.role == "model" {
            log::warn!(
                "[GeminiConverter] First content is 'model' role, inserting dummy user turn"
            );
            contents.insert(
                0,
                GeminiContent {
                    role: "user".to_string(),
                    parts: vec![GeminiPart {
                        text: Some(".".to_string()),
                        inline_data: None,
                        function_call: None,
                        function_response: None,
                        thought_signature: None,
                    }],
                },
            );
        }
    }

    // 确保至少有一个内容
    if contents.is_empty() && system_instruction.is_none() {
        return Err(AdapterError::InvalidFormat(
            "No valid content to convert".to_string(),
        ));
    }

    // 转换生成配置
    let stop_sequences = openai_req.stop.as_ref().map(|stop| stop.to_vec());

    let mut generation_config = GeminiGenerationConfig {
        temperature: openai_req.temperature,
        top_p: openai_req.top_p,
        top_k: None,
        max_output_tokens: openai_req.max_tokens,
        stop_sequences,
        response_mime_type: None,
        response_schema: None,
        thinking_config: None,
    };

    if let Some(format_value) = &openai_req.response_format {
        if let Some(format_obj) = format_value.as_object() {
            if let Some(format_type) = format_obj.get("type").and_then(|v| v.as_str()) {
                match format_type {
                    "json_object" => {
                        generation_config.response_mime_type = Some("application/json".to_string());
                    }
                    "json_schema" => {
                        generation_config.response_mime_type = Some("application/json".to_string());
                        if let Some(schema_holder) = format_obj.get("json_schema") {
                            if let Some(schema_value) = schema_holder.get("schema") {
                                generation_config.response_schema = Some(schema_value.clone());
                            } else {
                                generation_config.response_schema = Some(schema_holder.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let generation_config = if generation_config.temperature.is_some()
        || generation_config.top_p.is_some()
        || generation_config.top_k.is_some()
        || generation_config.max_output_tokens.is_some()
        || generation_config.stop_sequences.is_some()
        || generation_config.response_mime_type.is_some()
        || generation_config.response_schema.is_some()
    {
        Some(generation_config)
    } else {
        None
    };

    /// 递归修补 JSON Schema，确保符合 Gemini 原生 API 的严格要求：
    /// - `type: "array"` 时必须有 `items` 字段
    /// - 每个 `items` 必须包含 `type` 字段
    fn fix_schema_for_gemini(value: &mut Value) {
        match value {
            Value::Object(map) => {
                // 如果 type=array 但缺少 items，补充默认 items
                if map.get("type").and_then(|v| v.as_str()) == Some("array") {
                    if !map.contains_key("items") {
                        map.insert("items".to_string(), json!({"type": "string"}));
                    }
                }
                // 如果有 items 但 items 缺少 type，补充默认 type
                if let Some(items) = map.get_mut("items") {
                    if let Value::Object(items_map) = items {
                        if !items_map.contains_key("type") {
                            if items_map.contains_key("properties") {
                                items_map.insert("type".to_string(), json!("object"));
                            } else {
                                items_map.insert("type".to_string(), json!("string"));
                            }
                        }
                    }
                }
                // 递归处理所有子值
                for v in map.values_mut() {
                    fix_schema_for_gemini(v);
                }
            }
            Value::Array(arr) => {
                for v in arr.iter_mut() {
                    fix_schema_for_gemini(v);
                }
            }
            _ => {}
        }
    }

    // 转换工具
    let tools = if let Some(openai_tools) = &openai_req.tools {
        let mut function_declarations = Vec::new();
        for tool in openai_tools {
            if tool.tool_type == "function" {
                let mut params = tool.function.parameters.clone();
                // Gemini 原生 API 要求所有 schema 节点（包括 items）都必须有 type 字段
                fix_schema_for_gemini(&mut params);
                function_declarations.push(GeminiFunctionDeclaration {
                    name: tool.function.name.clone(),
                    description: tool.function.description.clone().unwrap_or_default(),
                    parameters: params,
                });
            }
        }
        if !function_declarations.is_empty() {
            Some(vec![GeminiTool {
                function_declarations,
            }])
        } else {
            None
        }
    } else {
        None
    };

    // 转换tool_choice到tool_config
    let tool_config = if let Some(tool_choice) = &openai_req.tool_choice {
        convert_tool_choice_to_tool_config(tool_choice)?
    } else {
        None
    };

    Ok(GeminiRequest {
        contents,
        system_instruction,
        generation_config,
        tools,
        tool_config,
    })
}

fn extract_text_from_openai_content(content: &OpenAIMessageContent) -> String {
    match content {
        OpenAIMessageContent::Text(text) => text.clone(),
        OpenAIMessageContent::Array(parts) => {
            let texts: Vec<String> = parts
                .iter()
                .filter_map(|part| match part {
                    OpenAIContentPart::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect();
            texts.join("\n")
        }
    }
}

fn convert_openai_content_to_gemini_parts(
    content: &OpenAIMessageContent,
) -> Result<Vec<GeminiPart>, AdapterError> {
    let mut parts = Vec::new();

    match content {
        OpenAIMessageContent::Text(text) => {
            if !text.is_empty() {
                parts.push(GeminiPart {
                    text: Some(text.clone()),
                    inline_data: None,
                    function_call: None,
                    function_response: None,
                    thought_signature: None,
                });
            }
        }
        OpenAIMessageContent::Array(content_parts) => {
            for part in content_parts {
                match part {
                    OpenAIContentPart::Text { text } => {
                        if !text.is_empty() {
                            parts.push(GeminiPart {
                                text: Some(text.clone()),
                                inline_data: None,
                                function_call: None,
                                function_response: None,
                                thought_signature: None,
                            });
                        }
                    }
                    OpenAIContentPart::ImageUrl { image_url } => {
                        if let Some(inline_data) = image_url_to_inline_data(image_url) {
                            parts.push(GeminiPart {
                                text: None,
                                inline_data: Some(inline_data),
                                function_call: None,
                                function_response: None,
                                thought_signature: None,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(parts)
}

fn image_url_to_inline_data(image_url: &OpenAIImageUrl) -> Option<GeminiInlineData> {
    if image_url.url.starts_with("data:") {
        let parts_split: Vec<&str> = image_url.url.splitn(2, ',').collect();
        if parts_split.len() == 2 {
            let header = parts_split[0];
            let data = parts_split[1];
            let mime_type = header
                .trim_start_matches("data:")
                .trim_end_matches(";base64")
                .to_string();
            return Some(GeminiInlineData {
                mime_type,
                data: data.to_string(),
            });
        }
    }

    if image_url.url.starts_with("http://") || image_url.url.starts_with("https://") {
        if let Some((bytes, mime_hint)) = fetch_binary_with_cache(&image_url.url) {
            let mime_type = mime_hint.unwrap_or_else(|| "application/octet-stream".to_string());
            let data = general_purpose::STANDARD.encode(bytes);
            return Some(GeminiInlineData { mime_type, data });
        }
    }

    None
}

fn map_gemini_finish_reason(reason: &str) -> &'static str {
    match reason {
        "STOP" | "STOP_REASON_UNSPECIFIED" | "FINISH_REASON_UNSPECIFIED" | "OTHER" => "stop",
        "MAX_TOKENS" => "length",
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => "content_filter",
        "MALFORMED_FUNCTION_CALL" | "TOOL_CALL_REQUIRED" => "tool_calls",
        _ => "stop",
    }
}

/// 转换OpenAI tool_choice到Gemini tool_config
fn convert_tool_choice_to_tool_config(
    tool_choice: &Value,
) -> Result<Option<GeminiToolConfig>, AdapterError> {
    // 处理字符串形式的tool_choice
    if let Some(choice_str) = tool_choice.as_str() {
        match choice_str {
            "auto" => {
                return Ok(Some(GeminiToolConfig {
                    function_calling_config: GeminiFunctionCallingConfig {
                        mode: "AUTO".to_string(),
                        allowed_function_names: None,
                    },
                }));
            }
            "none" => {
                return Ok(Some(GeminiToolConfig {
                    function_calling_config: GeminiFunctionCallingConfig {
                        mode: "NONE".to_string(),
                        allowed_function_names: None,
                    },
                }));
            }
            _ => {
                // 忽略未知的字符串值
                return Ok(None);
            }
        }
    }

    // 处理对象形式的tool_choice
    if let Some(choice_obj) = tool_choice.as_object() {
        if let Some(choice_type) = choice_obj.get("type").and_then(|t| t.as_str()) {
            if choice_type == "function" {
                if let Some(function_obj) = choice_obj.get("function").and_then(|f| f.as_object()) {
                    if let Some(function_name) = function_obj.get("name").and_then(|n| n.as_str()) {
                        return Ok(Some(GeminiToolConfig {
                            function_calling_config: GeminiFunctionCallingConfig {
                                mode: "ANY".to_string(),
                                allowed_function_names: Some(vec![function_name.to_string()]),
                            },
                        }));
                    }
                }
            }
        }

        // 处理直接指定函数名的情况（扩展支持）
        if let Some(function_name) = choice_obj.get("function").and_then(|f| f.as_str()) {
            return Ok(Some(GeminiToolConfig {
                function_calling_config: GeminiFunctionCallingConfig {
                    mode: "ANY".to_string(),
                    allowed_function_names: Some(vec![function_name.to_string()]),
                },
            }));
        }
    }

    // 默认情况：返回None（使用Gemini默认行为）
    Ok(None)
}

// ==================== 测试模块 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_gemini_request_nonstream() {
        let openai_body = json!({
            "model": "gpt-4",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What's in this image?"},
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
                    ]
                }
            ],
            "temperature": 0.7,
            "max_tokens": 100
        });

        let result = build_gemini_request(
            "https://generativelanguage.googleapis.com",
            "test-api-key",
            "gemini-pro-vision",
            &openai_body,
        );

        assert!(result.is_ok());
        let request = result.unwrap();

        // 验证URL
        assert!(request.url.contains(":generateContent?"));
        assert!(request.url.contains("key=test-api-key"));

        // 验证headers（Content-Type 和 x-goog-api-key）
        assert_eq!(request.headers.len(), 2);
        assert!(request.headers.iter().any(|(k, _)| k == "Content-Type"));
        assert!(request.headers.iter().any(|(k, _)| k == "x-goog-api-key"));

        // 验证body结构
        assert!(request.body.get("contents").is_some());
        let contents = request.body.get("contents").unwrap().as_array().unwrap();
        assert_eq!(contents.len(), 1);

        let parts = contents[0].get("parts").unwrap().as_array().unwrap();
        assert_eq!(parts.len(), 2); // text和image
        assert!(parts[0].get("text").is_some());
        assert!(parts[1].get("inlineData").is_some());
    }

    #[test]
    fn test_build_gemini_request_stream() {
        let openai_body = json!({
            "model": "gpt-4",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello"}
            ],
            "stream": true
        });

        let result = build_gemini_request(
            "https://generativelanguage.googleapis.com",
            "test-api-key",
            "gemini-pro",
            &openai_body,
        );

        assert!(result.is_ok());
        let request = result.unwrap();

        // 验证流式URL
        assert!(request.url.contains(":streamGenerateContent?"));

        // 验证system_instruction
        assert!(request.body.get("systemInstruction").is_some());
    }

    #[test]
    fn test_parse_gemini_stream_line_content() {
        let line = r#"data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}"#;
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);

        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ContentChunk(text) => assert_eq!(text, "Hello"),
            _ => panic!("Expected ContentChunk"),
        }
    }

    #[test]
    fn test_parse_gemini_stream_line_done() {
        let line = "data: [DONE]";
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], StreamEvent::Done));
    }

    #[test]
    fn test_parse_gemini_stream_line_function_call() {
        let line = r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"Tokyo"}}}]}}]}"#;
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);

        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ToolCall(value) => {
                assert_eq!(value.get("type").unwrap(), "function");
                assert_eq!(
                    value.get("function").unwrap().get("name").unwrap(),
                    "get_weather"
                );
            }
            _ => panic!("Expected ToolCall"),
        }
    }

    #[test]
    fn test_parse_gemini_stream_line_usage() {
        let line = r#"data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}"#;
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);

        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Usage(value) => {
                assert_eq!(value.get("promptTokenCount").unwrap(), 10);
                assert_eq!(value.get("candidatesTokenCount").unwrap(), 20);
            }
            _ => panic!("Expected Usage"),
        }
    }

    #[test]
    fn test_convert_gemini_nonstream_response() {
        let gemini_response = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "Hello"},
                        {"text": " world!"}
                    ]
                },
                "finishReason": "STOP",
                "index": 0
            }],
            "usageMetadata": {
                "promptTokenCount": 5,
                "candidatesTokenCount": 2,
                "totalTokenCount": 7
            }
        });

        let result = convert_gemini_nonstream_response_to_openai(&gemini_response, "gemini-pro");
        assert!(result.is_ok());

        let openai_response = result.unwrap();

        // 验证choices
        let choices = openai_response.get("choices").unwrap().as_array().unwrap();
        assert_eq!(choices.len(), 1);

        // 验证合并的文本
        let message = &choices[0].get("message").unwrap();
        let content = message.get("content").unwrap().as_str().unwrap();
        assert_eq!(content, "Hello\n world!");

        // 验证usage（健壮性测试）
        let usage = openai_response.get("usage").unwrap();
        assert_eq!(usage.get("prompt_tokens").unwrap(), 5);
        assert_eq!(usage.get("completion_tokens").unwrap(), 2);
        assert_eq!(usage.get("total_tokens").unwrap(), 7);
    }

    #[test]
    fn test_convert_with_tools() {
        let openai_body = json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "What's the weather?"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather information",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string"}
                        }
                    }
                }
            }]
        });

        let result = build_gemini_request(
            "https://generativelanguage.googleapis.com",
            "test-api-key",
            "gemini-pro",
            &openai_body,
        );

        assert!(result.is_ok());
        let request = result.unwrap();

        // 验证tools转换
        assert!(request.body.get("tools").is_some());
        let tools = request.body.get("tools").unwrap().as_array().unwrap();
        assert_eq!(tools.len(), 1);

        let declarations = tools[0]
            .get("functionDeclarations")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].get("name").unwrap(), "get_weather");
    }

    #[test]
    fn test_error_handling_invalid_json() {
        let invalid_body = json!({"invalid": "structure"});

        let result = build_gemini_request(
            "https://generativelanguage.googleapis.com",
            "test-api-key",
            "gemini-pro",
            &invalid_body,
        );

        assert!(result.is_err());
        match result.unwrap_err() {
            AdapterError::SerializationError(msg) => {
                assert!(msg.contains("Failed to parse OpenAI request"));
            }
            _ => panic!("Expected SerializationError"),
        }
    }

    #[test]
    fn test_parse_invalid_stream_line() {
        let line = "not a data line";
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);
        assert_eq!(events.len(), 0);

        let line = "data: not json";
        let state = Arc::new(Mutex::new(HashMap::new()));
        let events = parse_gemini_stream_line(line, &state);
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_usage_robustness() {
        // 测试缺失usageMetadata的情况
        let gemini_response_no_usage = json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": "Hello"}]
                },
                "index": 0
            }]
        });

        let result =
            convert_gemini_nonstream_response_to_openai(&gemini_response_no_usage, "gemini-pro");
        assert!(result.is_ok());

        let openai_response = result.unwrap();
        let usage = openai_response.get("usage").unwrap();
        assert_eq!(usage.get("prompt_tokens").unwrap(), 0);
        assert_eq!(usage.get("completion_tokens").unwrap(), 0);
        assert_eq!(usage.get("total_tokens").unwrap(), 0);

        // 测试部分缺失字段的情况
        let gemini_response_partial_usage = json!({
            "candidates": [{
                "content": {
                    "parts": [{"text": "Hello"}]
                },
                "index": 0
            }],
            "usageMetadata": {
                "promptTokenCount": 10
                // 缺失candidatesTokenCount和totalTokenCount
            }
        });

        let result2 = convert_gemini_nonstream_response_to_openai(
            &gemini_response_partial_usage,
            "gemini-pro",
        );
        assert!(result2.is_ok());

        let openai_response2 = result2.unwrap();
        let usage2 = openai_response2.get("usage").unwrap();
        assert_eq!(usage2.get("prompt_tokens").unwrap(), 10);
        assert_eq!(usage2.get("completion_tokens").unwrap(), 0);
        assert_eq!(usage2.get("total_tokens").unwrap(), 10);
    }

    #[test]
    fn test_tool_response_mapping() {
        // 测试工具响应消息的正确映射
        let openai_body = json!({
            "model": "gpt-4",
            "messages": [
                {"role": "user", "content": "What's the weather like?"},
                {"role": "assistant", "tool_calls": [
                    {
                        "id": "call_123",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{\"location\": \"Tokyo\"}"}
                    }
                ]},
                {"role": "tool", "tool_call_id": "call_123", "name": "get_weather", "content": "{\"temperature\": 25, \"condition\": \"sunny\"}"}
            ]
        });

        let result = build_gemini_request(
            "https://generativelanguage.googleapis.com",
            "test-api-key",
            "gemini-pro",
            &openai_body,
        );

        assert!(result.is_ok());
        let request = result.unwrap();
        let contents = request.body.get("contents").unwrap().as_array().unwrap();

        // 应该有3个content：user + assistant (functionCall) + user (functionResponse)
        assert_eq!(contents.len(), 3);

        // 验证第一个是用户消息
        assert_eq!(contents[0].get("role").unwrap(), "user");

        // 验证第二个是助手的函数调用
        assert_eq!(contents[1].get("role").unwrap(), "model");
        let parts1 = contents[1].get("parts").unwrap().as_array().unwrap();
        assert!(parts1[0].get("functionCall").is_some());

        // 验证第三个是工具响应，角色应该是"user"而不是"model"
        assert_eq!(contents[2].get("role").unwrap(), "user");
        let parts2 = contents[2].get("parts").unwrap().as_array().unwrap();
        assert!(parts2[0].get("functionResponse").is_some());

        // 验证functionResponse的内容
        let function_response = parts2[0].get("functionResponse").unwrap();
        assert_eq!(function_response.get("name").unwrap(), "get_weather");
        assert!(function_response.get("response").is_some());
    }

    #[test]
    fn test_multiple_content_parts() {
        let gemini_response = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "Part 1"},
                        {"text": "Part 2"},
                        {"functionCall": {"name": "func", "args": {"key": "value"}}}
                    ]
                },
                "index": 0
            }]
        });

        let result = convert_gemini_nonstream_response_to_openai(&gemini_response, "gemini-pro");
        assert!(result.is_ok());

        let openai_response = result.unwrap();
        let choices = openai_response.get("choices").unwrap().as_array().unwrap();
        let message = &choices[0].get("message").unwrap();

        // 验证文本合并
        let content = message.get("content").unwrap().as_str().unwrap();
        assert_eq!(content, "Part 1\nPart 2");

        // 验证tool_calls
        assert!(message.get("tool_calls").is_some());
        let tool_calls = message.get("tool_calls").unwrap().as_array().unwrap();
        assert_eq!(tool_calls.len(), 1);
    }

    #[test]
    fn test_topk_injection_from_openai_body() {
        // 顶层 top_k 扩展应注入到 generationConfig.topK
        let openai_body = json!({
            "model": "gemini-2.5-pro",
            "messages": [ {"role": "user", "content": "hi"} ],
            "top_k": 33
        });

        let req = build_gemini_request_with_version(
            "https://generativelanguage.googleapis.com",
            "k",
            "gemini-2.5-pro",
            &openai_body,
            Some("v1"),
        )
        .expect("req");

        let gen = req.body.get("generationConfig").unwrap();
        assert_eq!(gen.get("topK").and_then(|v| v.as_i64()), Some(33));
    }

    #[test]
    fn test_thinking_forces_v1beta_when_no_version_specified() {
        // 当启用 include_thoughts 且未指定版本时，应强制使用 v1beta
        let openai_body = json!({
            "model": "gemini-2.5-flash",
            "messages": [ {"role": "user", "content": "hi"} ],
            "google_thinking_config": {"include_thoughts": true}
        });

        let req = build_gemini_request_with_version(
            "https://generativelanguage.googleapis.com",
            "k",
            "gemini-2.5-flash",
            &openai_body,
            None,
        )
        .expect("req");

        assert!(req.url.contains("/v1beta/"));
    }
}

// ==================== Cargo.toml 最小依赖 ====================
/*
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "1.0"
uuid = { version = "1.6", features = ["v4"] }

[dev-dependencies]
# 测试时可选
*/
