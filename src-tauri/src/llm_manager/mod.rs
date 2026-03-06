pub mod adapters;
mod builtin_vendors;
mod exam_engine;
mod model2_pipeline;
pub(crate) mod parser;
mod rag_extension;

use crate::crypto::{CryptoService, EncryptedData};
use crate::database::Database;
use crate::file_manager::FileManager;
use crate::models::{AppError, ChatMessage, ExamCardBBox, ModelAssignments};
use crate::providers::{ProviderAdapter, ProviderError};
use crate::vendors::load_builtin_api_configs;
use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use log::{debug, error, info, warn};
use reqwest::{header::HeaderMap, Client, ClientBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, Listener, Window};
use tokio::sync::watch;
use tokio::sync::Mutex as TokioMutex;
// use chrono::Utc;
use regex::Regex;
use std::sync::LazyLock;
use tokio::sync::RwLock;
use tokio::time::{Duration, Instant};
use uuid::Uuid;

/// 增量 JSON 数组解析器 - 用于流式解析 LLM 输出的 JSON 数组
/// 当检测到完整的 JSON 对象时立即返回，无需等待整个数组完成
pub(crate) struct IncrementalJsonArrayParser {
    buffer: String,
    in_array: bool,
    brace_depth: i32,
    in_string: bool,
    escape_next: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(
        id: &str,
        label: &str,
        model: &str,
        supports_tools: bool,
        is_builtin: bool,
    ) -> ModelProfile {
        ModelProfile {
            id: id.to_string(),
            vendor_id: "builtin-deepseek".to_string(),
            label: label.to_string(),
            model: model.to_string(),
            supports_tools,
            is_builtin,
            ..ModelProfile::default()
        }
    }

    #[test]
    fn merge_builtin_profile_user_aware_preserves_user_modified_fields() {
        let mut profiles = vec![profile(
            "builtin-deepseek-reasoner",
            "My Custom Label",
            "deepseek-reasoner-custom",
            false,
            false,
        )];
        let builtin = profile(
            "builtin-deepseek-reasoner",
            "DeepSeek Reasoner (深度推理)",
            "deepseek-reasoner",
            true,
            true,
        );
        let previous_builtin = profile(
            "builtin-deepseek-reasoner",
            "DeepSeek Reasoner (旧标签)",
            "deepseek-reasoner",
            true,
            true,
        );

        LLMManager::merge_builtin_profile_user_aware(
            &mut profiles,
            builtin,
            Some(&previous_builtin),
        );

        assert_eq!(profiles.len(), 1);
        let merged = &profiles[0];
        assert_eq!(merged.label, "My Custom Label");
        assert_eq!(merged.model, "deepseek-reasoner-custom");
        assert!(!merged.supports_tools);
        assert!(merged.is_builtin);
    }

    #[test]
    fn merge_builtin_profile_user_aware_updates_untouched_fields_from_builtin() {
        let mut profiles = vec![profile(
            "builtin-deepseek-chat",
            "DeepSeek Chat (旧标签)",
            "deepseek-chat",
            true,
            false,
        )];
        let mut builtin = profile(
            "builtin-deepseek-chat",
            "DeepSeek Chat (新标签)",
            "deepseek-chat",
            true,
            true,
        );
        builtin.temperature = 0.2;

        let mut previous_builtin = profile(
            "builtin-deepseek-chat",
            "DeepSeek Chat (旧标签)",
            "deepseek-chat",
            true,
            true,
        );
        previous_builtin.temperature = 0.7;
        profiles[0].temperature = 0.7;

        LLMManager::merge_builtin_profile_user_aware(
            &mut profiles,
            builtin,
            Some(&previous_builtin),
        );

        assert_eq!(profiles.len(), 1);
        let merged = &profiles[0];
        assert_eq!(merged.label, "DeepSeek Chat (新标签)");
        assert!((merged.temperature - 0.2).abs() < f32::EPSILON);
        assert!(merged.is_builtin);
    }

    #[test]
    fn merge_builtin_profile_user_aware_adds_missing_builtin_profile() {
        let mut profiles = vec![];
        let builtin = profile(
            "builtin-deepseek-chat",
            "DeepSeek Chat (对话)",
            "deepseek-chat",
            true,
            true,
        );

        LLMManager::merge_builtin_profile_user_aware(&mut profiles, builtin, None);

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "builtin-deepseek-chat");
        assert!(profiles[0].is_builtin);
    }

    #[test]
    fn merge_builtin_profile_user_aware_without_snapshot_syncs_capability_fields() {
        let mut profiles = vec![profile(
            "builtin-deepseek-chat",
            "User Local Label",
            "deepseek-chat-custom",
            false,
            false,
        )];
        let builtin = profile(
            "builtin-deepseek-chat",
            "DeepSeek Chat (官方)",
            "deepseek-chat",
            true,
            true,
        );

        LLMManager::merge_builtin_profile_user_aware(&mut profiles, builtin, None);

        let merged = &profiles[0];
        // 用户偏好字段保持不变
        assert_eq!(merged.label, "User Local Label");
        assert_eq!(merged.model, "deepseek-chat-custom");
        // 能力字段从内置定义同步
        assert!(merged.supports_tools);
        assert!(merged.is_builtin);
    }

    #[test]
    fn convert_openai_tool_call_treats_empty_string_arguments_as_empty_object() {
        let tool_call = json!({
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "group_list",
                "arguments": ""
            }
        });

        let converted = LLMManager::convert_openai_tool_call(&tool_call)
            .expect("empty string args should be accepted as no-arg call");
        assert_eq!(converted.tool_name, "group_list");
        assert_eq!(converted.args_json, json!({}));
    }

    #[test]
    fn convert_openai_tool_call_treats_whitespace_arguments_as_empty_object() {
        let tool_call = json!({
            "id": "call_2",
            "type": "function",
            "function": {
                "name": "tag_list_all",
                "arguments": "   \n\t  "
            }
        });

        let converted = LLMManager::convert_openai_tool_call(&tool_call)
            .expect("whitespace args should be accepted as no-arg call");
        assert_eq!(converted.tool_name, "tag_list_all");
        assert_eq!(converted.args_json, json!({}));
    }
}

impl IncrementalJsonArrayParser {
    pub(crate) fn new() -> Self {
        Self {
            buffer: String::new(),
            in_array: false,
            brace_depth: 0,
            in_string: false,
            escape_next: false,
        }
    }

    /// 输入新的文本块，返回解析出的完整 JSON 对象列表
    pub(crate) fn feed(&mut self, chunk: &str) -> Option<Vec<Value>> {
        let mut results = Vec::new();

        for ch in chunk.chars() {
            // 处理转义字符
            if self.escape_next {
                self.escape_next = false;
                if self.brace_depth > 0 {
                    self.buffer.push(ch);
                }
                continue;
            }

            if ch == '\\' && self.in_string {
                self.escape_next = true;
                if self.brace_depth > 0 {
                    self.buffer.push(ch);
                }
                continue;
            }

            // 处理字符串边界
            if ch == '"' && !self.escape_next {
                self.in_string = !self.in_string;
                if self.brace_depth > 0 {
                    self.buffer.push(ch);
                }
                continue;
            }

            // 在字符串内部，直接添加字符
            if self.in_string {
                if self.brace_depth > 0 {
                    self.buffer.push(ch);
                }
                continue;
            }

            // 检测数组开始
            if ch == '[' && !self.in_array && self.brace_depth == 0 {
                self.in_array = true;
                continue;
            }

            // 检测数组结束
            if ch == ']' && self.in_array && self.brace_depth == 0 {
                self.in_array = false;
                continue;
            }

            // 检测对象开始
            if ch == '{' {
                if self.brace_depth == 0 {
                    self.buffer.clear();
                }
                self.brace_depth += 1;
                self.buffer.push(ch);
                continue;
            }

            // 检测对象结束
            if ch == '}' {
                self.brace_depth -= 1;
                self.buffer.push(ch);

                // 完成一个顶层对象
                if self.brace_depth == 0 && !self.buffer.is_empty() {
                    if let Ok(obj) = serde_json::from_str::<Value>(&self.buffer) {
                        results.push(obj);
                    }
                    self.buffer.clear();
                }
                continue;
            }

            // 其他字符
            if self.brace_depth > 0 {
                self.buffer.push(ch);
            }
        }

        if results.is_empty() {
            None
        } else {
            Some(results)
        }
    }

    /// 处理剩余缓冲区内容
    pub(crate) fn finalize(&mut self) -> Option<Vec<Value>> {
        if self.buffer.trim().is_empty() {
            return None;
        }

        // 尝试解析剩余内容
        if let Ok(obj) = serde_json::from_str::<Value>(&self.buffer) {
            self.buffer.clear();
            return Some(vec![obj]);
        }

        None
    }
}

type Result<T> = std::result::Result<T, AppError>;

const EXAM_SEGMENT_MAX_IMAGE_BYTES: usize = 1_500_000;
const EXAM_SEGMENT_MAX_DIMENSION: u32 = 1_600;
const EXAM_SEGMENT_MAX_PAGES: usize = 36;
const STREAM_MAX_CTX_TOKENS: usize = 200_000;
const USER_PREFERENCES_SETTING_KEY: &str = "chat.user_preferences_profile";
const USER_PREFERENCE_FIELD_MAX_LEN: usize = 800;
const BUILTIN_MODEL_PROFILES_SNAPSHOT_KEY: &str = "builtin_model_profiles_snapshot";
const HIDDEN_BUILTIN_MODEL_PROFILES_KEY: &str = "hidden_builtin_model_profile_ids";

static CONTROL_CHARS_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u{0000}-\u{001F}\u{007F}]").unwrap());

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct StoredUserPreferenceProfile {
    enabled: bool,
    background: String,
    goals: String,
    communication: String,
    notes: String,
}

impl Default for StoredUserPreferenceProfile {
    fn default() -> Self {
        Self {
            enabled: false,
            background: String::new(),
            goals: String::new(),
            communication: String::new(),
            notes: String::new(),
        }
    }
}

fn sanitize_user_preference_field(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let cleaned = CONTROL_CHARS_REGEX.replace_all(value, "");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut count = 0usize;
    let mut result = String::new();
    for ch in trimmed.chars() {
        if count >= USER_PREFERENCE_FIELD_MAX_LEN {
            break;
        }
        result.push(ch);
        count += 1;
    }
    result
}

fn build_user_preference_prompt_from_profile(
    profile: &StoredUserPreferenceProfile,
) -> Option<String> {
    if !profile.enabled {
        return None;
    }

    let background = sanitize_user_preference_field(&profile.background);
    let goals = sanitize_user_preference_field(&profile.goals);
    let communication = sanitize_user_preference_field(&profile.communication);
    let notes = sanitize_user_preference_field(&profile.notes);

    let mut lines: Vec<String> = Vec::new();
    if !background.is_empty() {
        lines.push(format!("- 学习背景 / Background: {}", background));
    }
    if !goals.is_empty() {
        lines.push(format!("- 学习目标 / Goals: {}", goals));
    }
    if !communication.is_empty() {
        lines.push(format!(
            "- 沟通偏好 / Communication Style: {}",
            communication
        ));
    }
    if !notes.is_empty() {
        lines.push(format!("- 补充说明 / Additional Notes: {}", notes));
    }

    if lines.is_empty() {
        return None;
    }

    Some(format!(
        "### 用户偏好（User Preferences）\n{}",
        lines.join("\n")
    ))
}

/// 前端 MCP 工具（通过桥接从前端SDK获取）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FrontendMcpTool {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    input_schema: Value,
}

/// MCP 工具缓存（前端来源）
#[derive(Debug, Clone)]
struct McpToolCache {
    tools: Vec<FrontendMcpTool>,
    cached_at: Instant,
    ttl: Duration,
}

impl McpToolCache {
    fn new(tools: Vec<FrontendMcpTool>, ttl: Duration) -> Self {
        Self {
            tools,
            cached_at: Instant::now(),
            ttl,
        }
    }
    fn is_expired(&self) -> bool {
        self.cached_at.elapsed() > self.ttl
    }
}

/// OCR 模型配置（用于多引擎支持）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelConfig {
    /// 模型配置 ID（对应 ApiConfig.id）
    pub config_id: String,
    /// 模型名称（如 deepseek-ai/DeepSeek-OCR）
    pub model: String,
    /// 引擎类型（deepseek_ocr, paddle_ocr_vl, generic_vlm）
    pub engine_type: String,
    /// 显示名称
    pub name: String,
    /// 是否免费
    #[serde(default)]
    pub is_free: bool,
    /// 是否启用（默认 true，向后兼容旧数据）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 优先级（数字越小越优先，默认 0）
    #[serde(default)]
    pub priority: u32,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub vendor_id: Option<String>,
    #[serde(default)]
    pub vendor_name: Option<String>,
    #[serde(default)]
    pub provider_type: Option<String>,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub is_multimodal: bool,
    pub is_reasoning: bool,
    pub is_embedding: bool,
    pub is_reranker: bool,
    pub enabled: bool,
    #[serde(default = "default_model_adapter")]
    pub model_adapter: String, // 新增：模型适配器类型
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32, // 新增：最大输出Token数
    #[serde(default = "default_temperature")]
    pub temperature: f32, // 新增：温度参数
    #[serde(default, alias = "supports_tools")]
    pub supports_tools: bool, // 新增：是否支持工具/函数调用
    #[serde(default = "default_gemini_api_version")]
    pub gemini_api_version: String, // 新增：Gemini API版本（v1或v1beta）
    #[serde(default)]
    pub is_builtin: bool,
    #[serde(default)]
    pub is_read_only: bool,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub thinking_enabled: bool,
    #[serde(default)]
    pub thinking_budget: Option<i32>,
    #[serde(default)]
    pub include_thoughts: bool,
    #[serde(default)]
    pub min_p: Option<f32>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub enable_thinking: Option<bool>,
    #[serde(default)]
    pub supports_reasoning: bool,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Top-P 核采样参数（运行时覆盖用）
    #[serde(default)]
    pub top_p_override: Option<f32>,
    /// 频率惩罚（运行时覆盖用）
    #[serde(default)]
    pub frequency_penalty_override: Option<f32>,
    /// 存在惩罚（运行时覆盖用）
    #[serde(default)]
    pub presence_penalty_override: Option<f32>,
    /// 重复惩罚（Qwen/豆包等模型使用）
    /// Qwen: >1.0 表示惩罚重复，1.0 表示不惩罚
    /// 豆包: >0 表示惩罚强度
    #[serde(default)]
    pub repetition_penalty: Option<f32>,
    /// MiniMax reasoning_split 参数
    /// true: 思维内容分离到 reasoning_details 字段（推荐）
    /// false: 思维内容嵌入在 content 字段中用 <think> 标签包裹
    #[serde(default)]
    pub reasoning_split: Option<bool>,
    /// Claude 4.5 Opus effort 参数 (high/medium/low)
    #[serde(default)]
    pub effort: Option<String>,
    /// OpenAI GPT-5.2 verbosity 参数 (low/medium/high)
    #[serde(default)]
    pub verbosity: Option<String>,
    /// 是否收藏（收藏的模型在列表中优先显示）
    #[serde(default)]
    pub is_favorite: bool,
    /// 供应商级别的 max_tokens 限制（API 最大允许值）
    #[serde(default)]
    pub max_tokens_limit: Option<u32>,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            vendor_id: None,
            vendor_name: None,
            provider_type: None,
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            is_multimodal: false,
            is_reasoning: false,
            is_embedding: false,
            is_reranker: false,
            enabled: false,
            model_adapter: default_model_adapter(),
            max_output_tokens: default_max_output_tokens(),
            temperature: default_temperature(),
            supports_tools: false,
            gemini_api_version: default_gemini_api_version(),
            is_builtin: false,
            is_read_only: false,
            reasoning_effort: None,
            thinking_enabled: false,
            thinking_budget: None,
            include_thoughts: false,
            min_p: None,
            top_k: None,
            enable_thinking: None,
            supports_reasoning: false,
            headers: None,
            top_p_override: None,
            frequency_penalty_override: None,
            presence_penalty_override: None,
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
            is_favorite: false,
            max_tokens_limit: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub rate_limit_per_minute: Option<u32>,
    #[serde(default)]
    pub default_timeout_ms: Option<u64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub is_builtin: bool,
    #[serde(default)]
    pub is_read_only: bool,
    #[serde(default)]
    pub sort_order: Option<i32>,
    /// 供应商级别的 max_tokens 限制（API 最大允许值）
    #[serde(default)]
    pub max_tokens_limit: Option<u32>,
    /// 供应商官网链接
    #[serde(default)]
    pub website_url: Option<String>,
}

impl Default for VendorConfig {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: "New Vendor".to_string(),
            provider_type: "openai".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            headers: HashMap::new(),
            rate_limit_per_minute: None,
            default_timeout_ms: None,
            notes: None,
            is_builtin: false,
            is_read_only: false,
            sort_order: None,
            max_tokens_limit: None,
            website_url: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub vendor_id: String,
    pub label: String,
    pub model: String,
    #[serde(default = "default_model_adapter")]
    pub model_adapter: String,
    #[serde(default)]
    pub is_multimodal: bool,
    #[serde(default)]
    pub is_reasoning: bool,
    #[serde(default)]
    pub is_embedding: bool,
    #[serde(default)]
    pub is_reranker: bool,
    #[serde(default)]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_reasoning: bool,
    #[serde(default = "default_profile_status")]
    pub status: String,
    #[serde(default = "default_profile_enabled")]
    pub enabled: bool,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub thinking_enabled: bool,
    #[serde(default)]
    pub thinking_budget: Option<i32>,
    #[serde(default)]
    pub include_thoughts: bool,
    #[serde(default)]
    pub enable_thinking: Option<bool>,
    #[serde(default)]
    pub min_p: Option<f32>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub gemini_api_version: Option<String>,
    #[serde(default)]
    pub is_builtin: bool,
    /// 重复惩罚（Qwen/豆包等模型使用）
    #[serde(default)]
    pub repetition_penalty: Option<f32>,
    /// MiniMax reasoning_split 参数
    #[serde(default)]
    pub reasoning_split: Option<bool>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub verbosity: Option<String>,
    /// 是否收藏（收藏的模型在列表中优先显示）
    #[serde(default)]
    pub is_favorite: bool,
    /// 模型级别的 max_tokens 限制（优先于供应商级别）
    #[serde(default)]
    pub max_tokens_limit: Option<u32>,
}

impl Default for ModelProfile {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            vendor_id: String::new(),
            label: "New Model".to_string(),
            model: String::new(),
            model_adapter: default_model_adapter(),
            is_multimodal: false,
            is_reasoning: false,
            is_embedding: false,
            is_reranker: false,
            supports_tools: false,
            supports_reasoning: false,
            status: default_profile_status(),
            enabled: default_profile_enabled(),
            max_output_tokens: default_max_output_tokens(),
            temperature: default_temperature(),
            reasoning_effort: None,
            thinking_enabled: false,
            thinking_budget: None,
            include_thoughts: false,
            enable_thinking: None,
            min_p: None,
            top_k: None,
            gemini_api_version: None,
            is_builtin: false,
            repetition_penalty: None,
            reasoning_split: None,
            effort: None,
            verbosity: None,
            is_favorite: false,
            max_tokens_limit: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedModelConfig {
    pub vendor: VendorConfig,
    pub profile: ModelProfile,
    pub runtime: ApiConfig,
}

// 默认值函数
fn default_model_adapter() -> String {
    "general".to_string()
}

fn default_max_output_tokens() -> u32 {
    8192
}

fn default_temperature() -> f32 {
    0.7
}

fn default_gemini_api_version() -> String {
    "v1".to_string()
}

fn default_profile_status() -> String {
    "enabled".to_string()
}

fn default_profile_enabled() -> bool {
    true
}

#[inline]
pub(crate) fn effective_max_tokens(max_output_tokens: u32, max_tokens_limit: Option<u32>) -> u32 {
    match max_tokens_limit {
        Some(limit) => max_output_tokens.min(limit),
        None => max_output_tokens,
    }
}

#[derive(Debug, Clone)]
pub struct ExamSegmentationCard {
    pub question_label: String,
    pub bbox: ExamCardBBox,
    pub ocr_text: Option<String>,
    pub tags: Vec<String>,
    pub extra_metadata: Option<Value>,
    pub card_id: String,
}

#[derive(Debug, Clone)]
pub struct ExamSegmentationPage {
    pub page_index: usize,
    pub cards: Vec<ExamSegmentationCard>,
}

#[derive(Debug, Clone)]
pub struct ExamSegmentationOutput {
    pub pages: Vec<ExamSegmentationPage>,
    pub raw: Option<Value>,
}

pub struct LLMManager {
    client: Client,
    db: Arc<Database>,
    file_manager: Arc<FileManager>,
    crypto_service: CryptoService,
    cancel_registry: Arc<TokioMutex<HashSet<String>>>,
    cancel_channels: Arc<TokioMutex<std::collections::HashMap<String, watch::Sender<bool>>>>,
    mcp_tool_cache: Arc<RwLock<Option<McpToolCache>>>,
    hooks_registry:
        Arc<TokioMutex<std::collections::HashMap<String, std::sync::Arc<dyn LLMStreamHooks>>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ImagePayload {
    pub mime: String,
    pub base64: String,
}

/// 🔧 P1修复：合并后的消息类型
/// 用于在消息序列化时合并连续的工具调用
enum MergedChatMessage {
    /// 普通消息（直接传递）
    Regular(ChatMessage),
    /// 合并的工具调用消息（多个 tool_calls）
    /// 🔧 Anthropic 最佳实践：必须保留 thinking_content
    /// "When using thinking enabled + tool calling, you must include thinking_blocks
    /// from the previous assistant response when sending tool results back."
    MergedToolCalls {
        tool_calls: Vec<crate::models::ToolCall>,
        content: String,
        /// 🔧 保留第一个工具调用对应的思维链（Anthropic 要求）
        thinking_content: Option<String>,
        /// 🔧 Gemini 3 思维签名：工具调用场景下必须在后续请求中回传
        thought_signature: Option<String>,
    },
}

// Optional streaming hooks for unified pipeline to observe and persist events
pub trait LLMStreamHooks: Send + Sync {
    fn on_content_chunk(&self, _text: &str) {}
    fn on_reasoning_chunk(&self, _text: &str) {}
    /// Gemini 3 思维签名回调（工具调用必需）
    /// 在工具调用场景下，需要缓存此签名并在后续请求中回传
    fn on_thought_signature(&self, _signature: &str) {}
    /// 🆕 2026-01-15: 工具调用参数开始累积时通知前端
    /// 在 LLM 开始生成工具调用参数时立即调用，让前端显示"正在准备工具调用"
    /// - tool_call_id: 工具调用 ID
    /// - tool_name: 工具名称
    fn on_tool_call_start(&self, _tool_call_id: &str, _tool_name: &str) {}
    /// 工具调用参数流式片段回调
    /// 在 LLM 逐 token 生成工具调用 arguments 时调用，用于前端实时预览
    fn on_tool_call_args_delta(&self, _tool_call_id: &str, _delta: &str) {}
    fn on_tool_call(&self, _msg: &ChatMessage) {}
    fn on_tool_result(&self, _msg: &ChatMessage) {}
    fn on_usage(&self, _usage: &serde_json::Value) {}
    fn on_complete(&self, _final_text: &str, _reasoning: Option<&str>) {}
}

impl LLMManager {
    fn merge_builtin_profile_user_aware(
        profiles: &mut Vec<ModelProfile>,
        builtin_profile: ModelProfile,
        previous_builtin_profile: Option<&ModelProfile>,
    ) {
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == builtin_profile.id) {
            // 无论如何都修复内置标记，避免旧数据将内置模型错误标记为非内置。
            existing.is_builtin = true;

            // 首次无基线快照时：能力字段从内置定义同步（用户极少手动修改），
            // 用户偏好字段（标签、模型ID、温度等）保持不变。
            let Some(previous_builtin) = previous_builtin_profile else {
                existing.is_multimodal = builtin_profile.is_multimodal;
                existing.is_reasoning = builtin_profile.is_reasoning;
                existing.is_embedding = builtin_profile.is_embedding;
                existing.is_reranker = builtin_profile.is_reranker;
                existing.supports_tools = builtin_profile.supports_tools;
                existing.supports_reasoning = builtin_profile.supports_reasoning;
                return;
            };

            macro_rules! update_if_untouched {
                ($field:ident) => {
                    if existing.$field == previous_builtin.$field {
                        existing.$field = builtin_profile.$field.clone();
                    }
                };
            }

            update_if_untouched!(vendor_id);
            update_if_untouched!(label);
            update_if_untouched!(model);
            update_if_untouched!(model_adapter);
            update_if_untouched!(is_multimodal);
            update_if_untouched!(is_reasoning);
            update_if_untouched!(is_embedding);
            update_if_untouched!(is_reranker);
            update_if_untouched!(supports_tools);
            update_if_untouched!(supports_reasoning);
            update_if_untouched!(status);
            update_if_untouched!(enabled);
            update_if_untouched!(max_output_tokens);
            update_if_untouched!(temperature);
            update_if_untouched!(reasoning_effort);
            update_if_untouched!(thinking_enabled);
            update_if_untouched!(thinking_budget);
            update_if_untouched!(include_thoughts);
            update_if_untouched!(enable_thinking);
            update_if_untouched!(min_p);
            update_if_untouched!(top_k);
            update_if_untouched!(gemini_api_version);
            update_if_untouched!(repetition_penalty);
            update_if_untouched!(reasoning_split);
            update_if_untouched!(effort);
            update_if_untouched!(verbosity);
            update_if_untouched!(is_favorite);
            update_if_untouched!(max_tokens_limit);
            return;
        }
        profiles.push(builtin_profile);
    }

    fn read_builtin_profile_snapshot_map(&self) -> HashMap<String, ModelProfile> {
        let raw = match self.db.get_setting(BUILTIN_MODEL_PROFILES_SNAPSHOT_KEY) {
            Ok(Some(raw)) => raw,
            _ => return HashMap::new(),
        };

        let parsed: Vec<ModelProfile> = match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                warn!("[VendorModel] 解析内置模型快照失败，回退为空快照: {}", err);
                return HashMap::new();
            }
        };

        parsed
            .into_iter()
            .map(|profile| (profile.id.clone(), profile))
            .collect()
    }

    fn save_builtin_profile_snapshot(&self, builtin_profiles: &[ModelProfile]) -> Result<()> {
        let json = serde_json::to_string(builtin_profiles)
            .map_err(|e| AppError::configuration(format!("序列化内置模型快照失败: {}", e)))?;
        self.db
            .save_setting(BUILTIN_MODEL_PROFILES_SNAPSHOT_KEY, &json)
            .map_err(|e| AppError::database(format!("保存内置模型快照失败: {}", e)))
    }

    fn read_hidden_builtin_model_profile_ids(&self) -> HashSet<String> {
        let raw = match self.db.get_setting(HIDDEN_BUILTIN_MODEL_PROFILES_KEY) {
            Ok(Some(raw)) => raw,
            _ => return HashSet::new(),
        };

        match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(ids) => ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect(),
            Err(err) => {
                warn!(
                    "[VendorModel] 解析隐藏内置模型列表失败，回退为空列表: {}",
                    err
                );
                HashSet::new()
            }
        }
    }

    fn save_hidden_builtin_model_profile_ids(&self, ids: &HashSet<String>) -> Result<()> {
        let mut sorted_ids: Vec<String> = ids
            .iter()
            .filter(|id| !id.trim().is_empty())
            .cloned()
            .collect();
        sorted_ids.sort();
        let json = serde_json::to_string(&sorted_ids)
            .map_err(|e| AppError::configuration(format!("序列化隐藏内置模型列表失败: {}", e)))?;
        self.db
            .save_setting(HIDDEN_BUILTIN_MODEL_PROFILES_KEY, &json)
            .map_err(|e| AppError::database(format!("保存隐藏内置模型列表失败: {}", e)))
    }

    pub fn new(db: Arc<Database>, file_manager: Arc<FileManager>) -> Result<Self> {
        let client = Self::create_http_client_with_fallback();

        let app_data_dir_path = file_manager.get_app_data_dir();
        let crypto_service = CryptoService::new(&app_data_dir_path.to_path_buf())
            .map_err(|e| AppError::configuration(format!("加密服务初始化失败: {e}")))?;

        Ok(Self {
            client,
            db,
            file_manager,
            crypto_service,
            cancel_registry: Arc::new(TokioMutex::new(HashSet::new())),
            cancel_channels: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
            mcp_tool_cache: Arc::new(RwLock::new(None)),
            hooks_registry: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
        })
    }

    // 对外暴露 HTTP 客户端，便于独立管线重用统一配置的客户端
    pub fn get_http_client(&self) -> Client {
        self.client.clone()
    }

    // 订阅指定流事件的取消通道（用于独立流式实现）
    pub async fn subscribe_cancel_stream(&self, stream_event: &str) -> watch::Receiver<bool> {
        self.register_cancel_channel(stream_event).await
    }

    // 清理指定流事件的取消通道（用于独立流式实现）
    pub async fn clear_cancel_stream(&self, stream_event: &str) {
        self.clear_cancel_channel(stream_event).await;
    }

    // 若取消在通道注册前已发生，提供一次性消费接口
    pub async fn consume_pending_cancel(&self, stream_event: &str) -> bool {
        self.take_cancellation_if_any(stream_event).await
    }

    fn log_request_body(&self, tag: &str, body: &serde_json::Value) {
        match serde_json::to_string_pretty(body) {
            Ok(pretty) => debug!("[{}] 请求体如下:\n{}", tag, pretty),
            Err(e) => warn!("[{}] 请求体序列化失败: {}", tag, e),
        }
    }

    pub fn user_preference_prompt(&self) -> Option<String> {
        let stored = match self.db.get_setting(USER_PREFERENCES_SETTING_KEY) {
            Ok(value) => value?,
            Err(err) => {
                warn!("[UserPreferences] 读取失败: {}", err);
                return None;
            }
        };

        let trimmed = stored.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut profile = match serde_json::from_str::<StoredUserPreferenceProfile>(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => StoredUserPreferenceProfile {
                enabled: true,
                notes: trimmed.to_string(),
                ..Default::default()
            },
        };

        if !trimmed.contains("\"enabled\"") {
            let has_any_content = !profile.background.trim().is_empty()
                || !profile.goals.trim().is_empty()
                || !profile.communication.trim().is_empty()
                || !profile.notes.trim().is_empty();
            if has_any_content {
                profile.enabled = true;
            }
        }

        // 允许空白字段，但 enabled 为 false 时直接跳过
        if !profile.enabled {
            return None;
        }

        build_user_preference_prompt_from_profile(&profile)
    }

    fn provider_error(context: &str, err: ProviderError) -> AppError {
        AppError::llm(format!("{}: {}", context, err))
    }

    /// 应用推理相关配置到请求体
    ///
    /// 使用子适配器系统处理不同供应商的参数差异：
    /// - 通过 `provider_type` 查找对应的子适配器
    /// - 子适配器处理特定供应商的参数格式
    /// - 最后应用通用参数
    ///
    /// ## 子适配器架构
    /// 详见 `adapters` 模块文档
    fn apply_reasoning_config(body: &mut Value, config: &ApiConfig, enable_thinking: Option<bool>) {
        let Value::Object(map) = body else {
            return;
        };

        // 获取适配器：优先使用 provider_type，回退到 model_adapter
        // 注意：适配器类型由前端推断引擎在配置时预设，后端直接使用
        let adapter = adapters::get_adapter(config.provider_type.as_deref(), &config.model_adapter);

        // 移除采样参数（如果适配器要求）
        if adapter.should_remove_sampling_params(config) {
            map.remove("temperature");
            map.remove("top_p");
            map.remove("logprobs");
        }

        // 应用推理配置
        let early_return = adapter.apply_reasoning_config(map, config, enable_thinking);

        if early_return {
            return;
        }

        // 应用通用参数
        adapter.apply_common_params(map, config);
    }

    // -------- Streaming Hooks (for unified pipeline) --------
    pub async fn register_stream_hooks(
        &self,
        stream_event: &str,
        hooks: std::sync::Arc<dyn LLMStreamHooks>,
    ) {
        let key = stream_event.to_string();
        debug!("[Hook] 注册 hook: key={}", key);
        self.hooks_registry.lock().await.insert(key, hooks);
        let count = self.hooks_registry.lock().await.len();
        debug!("[Hook] 注册后 registry 大小: {}", count);
    }

    pub async fn unregister_stream_hooks(&self, stream_event: &str) {
        let key = stream_event.to_string();
        debug!("[Hook] 注销 hook: key={}", key);
        self.hooks_registry.lock().await.remove(&key);
    }

    async fn get_hook(&self, stream_event: &str) -> Option<std::sync::Arc<dyn LLMStreamHooks>> {
        let registry = self.hooks_registry.lock().await;
        // 日志已简化：只在 debug 模式下输出
        registry.get(stream_event).cloned()
    }

    /// 🔧 P1修复：合并连续的工具调用消息
    ///
    /// OpenAI 协议期望：一个 assistant 消息包含 tool_calls 数组，然后跟着多个 tool 消息。
    /// 当前数据模型每个消息只有一个 tool_call，需要在序列化时合并。
    ///
    /// 🔧 Anthropic 最佳实践：必须保留 thinking_content
    /// "When using thinking enabled + tool calling, you must include thinking_blocks
    /// from the previous assistant response when sending tool results back."
    ///
    /// 输入：[assistant(tc1, thinking1), tool(tr1), assistant(tc2), tool(tr2), assistant(tc3, thinking2), tool(tr3)]
    /// 输出：[MergedToolCalls([tc1, tc2], thinking1), tool(tr1), tool(tr2), MergedToolCalls([tc3], thinking2), tool(tr3)]
    ///
    /// ## 🔧 多轮工具调用边界检测
    /// 当遇到新的 reasoning_content（非空）时，表示开始了新一轮的工具调用，
    /// 需要刷新当前的 pending 组并开始新组，以保持每轮工具调用的边界。
    /// 这确保了多轮工具调用的思维链都能被正确保留和回传。
    fn merge_consecutive_tool_calls(history: &[ChatMessage]) -> Vec<MergedChatMessage> {
        let mut result = Vec::new();
        let mut pending_tool_calls: Vec<crate::models::ToolCall> = Vec::new();
        let mut pending_tool_results: Vec<ChatMessage> = Vec::new();
        // 🔧 保留当前轮次的思维链
        let mut current_thinking_content: Option<String> = None;
        // 🔧 Gemini 3 思维签名：工具调用场景下必须回传
        let mut current_thought_signature: Option<String> = None;

        for msg in history {
            if msg.role == "assistant" && msg.tool_call.is_some() {
                if let Some(tc) = &msg.tool_call {
                    // 🔧 多轮边界检测：如果遇到新的 reasoning_content（非空），
                    // 且已经有待处理的工具调用，则先刷新当前组
                    let has_new_reasoning = msg
                        .thinking_content
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);

                    if has_new_reasoning && !pending_tool_calls.is_empty() {
                        // 刷新当前组（这是前一轮的工具调用）
                        result.push(MergedChatMessage::MergedToolCalls {
                            tool_calls: std::mem::take(&mut pending_tool_calls),
                            content: String::new(),
                            thinking_content: std::mem::take(&mut current_thinking_content),
                            thought_signature: std::mem::take(&mut current_thought_signature),
                        });
                        for tr in std::mem::take(&mut pending_tool_results) {
                            result.push(MergedChatMessage::Regular(tr));
                        }

                        debug!(
                            "[LLMManager] New reasoning round detected, flushed previous tool calls group"
                        );
                    }

                    // 收集工具调用
                    pending_tool_calls.push(tc.clone());

                    // 保留当前轮次的思维链（只保留第一个非空的）
                    if current_thinking_content.is_none() && has_new_reasoning {
                        current_thinking_content = msg.thinking_content.clone();
                    }
                    // 保留当前轮次的思维签名（只保留第一个非空的）
                    if current_thought_signature.is_none() {
                        current_thought_signature = msg.thought_signature.clone();
                    }
                }
            } else if msg.role == "tool" {
                // 收集工具结果
                pending_tool_results.push(msg.clone());
            } else {
                // 非工具消息，先刷新待处理的工具调用
                if !pending_tool_calls.is_empty() {
                    result.push(MergedChatMessage::MergedToolCalls {
                        tool_calls: std::mem::take(&mut pending_tool_calls),
                        content: String::new(),
                        thinking_content: std::mem::take(&mut current_thinking_content),
                        thought_signature: std::mem::take(&mut current_thought_signature),
                    });
                    for tr in std::mem::take(&mut pending_tool_results) {
                        result.push(MergedChatMessage::Regular(tr));
                    }
                }
                result.push(MergedChatMessage::Regular(msg.clone()));
            }
        }

        // 处理尾部的工具调用
        if !pending_tool_calls.is_empty() {
            result.push(MergedChatMessage::MergedToolCalls {
                tool_calls: pending_tool_calls,
                content: String::new(),
                thinking_content: current_thinking_content,
                thought_signature: current_thought_signature,
            });
            for tr in pending_tool_results {
                result.push(MergedChatMessage::Regular(tr));
            }
        }

        result
    }

    /// 🔧 合并连续同角色的用户消息（防御性措施）
    ///
    /// 部分 LLM API（如 Anthropic Claude 原生 API、文心一言）严格要求 user/assistant 交替。
    /// 当以下场景发生时，可能产生连续的 user 消息：
    /// 1. assistant 回复为空（被取消/失败）被 `load_chat_history` 跳过
    /// 2. 会话分支后用户继续发送新消息
    /// 3. 消息编辑等边界情况
    ///
    /// 此函数在 messages 数组构建完成后、发送请求前调用，
    /// 将连续的同角色 user 消息用 `\n\n` 合并为单条消息。
    /// 对 system / assistant / tool 消息不做合并（它们有各自的语义）。
    ///
    /// 注意：仅合并 content 为纯字符串的 user 消息。
    /// 对于 content 为数组（多模态）的情况，将数组元素追加到前一条。
    pub(crate) fn merge_consecutive_user_messages(messages: &mut Vec<serde_json::Value>) {
        if messages.len() < 2 {
            return;
        }

        let mut merged: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

        for msg in messages.drain(..) {
            let is_user = msg.get("role").and_then(|r| r.as_str()) == Some("user");

            if !is_user {
                merged.push(msg);
                continue;
            }

            // 检查前一条是否也是 user
            let prev_is_user = merged
                .last()
                .and_then(|m| m.get("role"))
                .and_then(|r| r.as_str())
                == Some("user");

            if !prev_is_user {
                merged.push(msg);
                continue;
            }

            // 需要合并：将当前 user 消息的 content 追加到前一条
            let prev = merged.last_mut().unwrap();
            let prev_content = prev.get("content").cloned();
            let curr_content = msg.get("content").cloned();

            match (prev_content, curr_content) {
                // 两条都是纯文本 → 用 \n\n 拼接
                (
                    Some(serde_json::Value::String(ref prev_text)),
                    Some(serde_json::Value::String(ref curr_text)),
                ) => {
                    let merged_text = format!("{}\n\n{}", prev_text, curr_text);
                    let combined_len = merged_text.len();
                    prev["content"] = serde_json::Value::String(merged_text);
                    log::warn!(
                        "[LLMManager] Merged 2 consecutive user messages (text+text, combined_len={})",
                        combined_len
                    );
                }
                // 前一条是数组（多模态），当前也是数组 → 追加元素
                (
                    Some(serde_json::Value::Array(ref _prev_arr)),
                    Some(serde_json::Value::Array(ref curr_arr)),
                ) => {
                    let curr_len = curr_arr.len();
                    if let Some(arr) = prev.get_mut("content").and_then(|c| c.as_array_mut()) {
                        arr.extend(curr_arr.clone());
                        log::warn!(
                            "[LLMManager] Merged 2 consecutive user messages (array+array, appended {} parts)",
                            curr_len
                        );
                    }
                }
                // 前一条是纯文本，当前是数组 → 转换前一条为数组后追加
                (
                    Some(serde_json::Value::String(prev_text)),
                    Some(serde_json::Value::Array(curr_arr)),
                ) => {
                    let mut new_content = vec![json!({"type": "text", "text": prev_text})];
                    let curr_len = curr_arr.len();
                    new_content.extend(curr_arr);
                    prev["content"] = serde_json::Value::Array(new_content);
                    log::warn!(
                        "[LLMManager] Merged 2 consecutive user messages (text+array, appended {} parts)",
                        curr_len
                    );
                }
                // 前一条是数组，当前是纯文本 → 追加 text 元素
                (
                    Some(serde_json::Value::Array(ref _prev_arr)),
                    Some(serde_json::Value::String(ref curr_text)),
                ) => {
                    if let Some(arr) = prev.get_mut("content").and_then(|c| c.as_array_mut()) {
                        arr.push(json!({"type": "text", "text": curr_text}));
                        log::warn!(
                            "[LLMManager] Merged 2 consecutive user messages (array+text, text_len={})",
                            curr_text.len()
                        );
                    }
                }
                // 其他情况（None 等）→ 不合并，直接追加
                _ => {
                    merged.push(msg);
                }
            }
        }

        *messages = merged;
    }

    /// 🔧 C2修复：合并序列化后的连续 assistant tool_calls 消息
    ///
    /// OpenAI API 要求同一轮的多个 tool_calls 在一个 assistant 消息中。
    /// 此函数在 JSON messages 数组上操作，将连续的 `{"role":"assistant","tool_calls":[...]}`
    /// 消息合并为一个，其 tool_calls 数组包含所有工具调用。
    ///
    /// 合并规则：
    /// - 仅合并连续的、都包含 tool_calls 的 assistant 消息
    /// - 中间不能有 tool/user 消息（那表示不同轮次）
    /// - 合并后保留第一个消息的 content
    pub(crate) fn merge_consecutive_assistant_tool_calls(messages: &mut Vec<serde_json::Value>) {
        if messages.len() < 2 {
            return;
        }

        let mut merged: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

        for msg in messages.drain(..) {
            let is_assistant_with_tools = msg.get("role").and_then(|r| r.as_str())
                == Some("assistant")
                && msg
                    .get("tool_calls")
                    .and_then(|tc| tc.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);

            if !is_assistant_with_tools {
                merged.push(msg);
                continue;
            }

            // 检查前一条是否也是 assistant with tool_calls
            let prev_is_assistant_with_tools = merged
                .last()
                .map(|m| {
                    m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                        && m.get("tool_calls")
                            .and_then(|tc| tc.as_array())
                            .map(|a| !a.is_empty())
                            .unwrap_or(false)
                })
                .unwrap_or(false);

            if !prev_is_assistant_with_tools {
                merged.push(msg);
                continue;
            }

            // 合并：将当前消息的 tool_calls 追加到前一条
            let prev = merged.last_mut().unwrap();
            if let Some(curr_tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                let curr_len = curr_tool_calls.len();
                if let Some(prev_arr) = prev.get_mut("tool_calls").and_then(|tc| tc.as_array_mut())
                {
                    prev_arr.extend(curr_tool_calls.clone());
                    log::debug!(
                        "[LLMManager] C2fix: Merged consecutive assistant tool_calls (+{} calls, total={})",
                        curr_len,
                        prev_arr.len()
                    );
                }
            }
        }

        *messages = merged;
    }

    /// 发送专用流式事件（根据工具类型和citations的source_type分类）
    fn emit_specialized_source_events(
        window: &Window,
        stream_event: &str,
        tc: &crate::models::ToolCall,
        tr: &crate::models::ToolResult,
        citations_value: &serde_json::Value,
    ) {
        if tr.ok && !citations_value.is_null() {
            if let serde_json::Value::Array(citations_array) = citations_value {
                if !citations_array.is_empty() {
                    match tc.tool_name.as_str() {
                        "web_search" => {
                            // 发送web_search专用流式事件
                            let web_search_event = json!({
                                "sources": citations_array,
                                "tool_name": "web_search",
                                "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                            });
                            if let Err(e) = window
                                .emit(&format!("{}_web_search", stream_event), &web_search_event)
                            {
                                error!("emit web_search event failed: {}", e);
                            }
                        }
                        "rag" => {
                            // 发送rag专用流式事件
                            let rag_event = json!({
                                "sources": citations_array,
                                "tool_name": "rag",
                                "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                            });
                            if let Err(e) =
                                window.emit(&format!("{}_rag_sources", stream_event), &rag_event)
                            {
                                error!("emit rag event failed: {}", e);
                            }
                        }
                        "memory" => {
                            // 发送memory专用流式事件
                            let memory_event = json!({
                                "sources": citations_array,
                                "tool_name": "memory",
                                "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                            });
                            if let Err(e) = window
                                .emit(&format!("{}_memory_sources", stream_event), &memory_event)
                            {
                                error!("emit memory event failed: {}", e);
                            }
                        }
                        _ => {
                            // 其他工具：根据citations中的source_type进行分类
                            let mut web_sources = Vec::new();
                            let mut rag_sources = Vec::new();
                            let mut memory_sources = Vec::new();

                            for citation in citations_array {
                                if let Some(source_type) =
                                    citation.get("source_type").and_then(|s| s.as_str())
                                {
                                    match source_type {
                                        "search" => web_sources.push(citation.clone()),
                                        "rag" => rag_sources.push(citation.clone()),
                                        "memory" => memory_sources.push(citation.clone()),
                                        _ => rag_sources.push(citation.clone()), // 默认归类到rag
                                    }
                                } else {
                                    rag_sources.push(citation.clone()); // 无source_type默认归类到rag
                                }
                            }

                            // 分别发送不同类型的事件
                            if !web_sources.is_empty() {
                                let web_search_event = json!({
                                    "sources": web_sources,
                                    "tool_name": tc.tool_name,
                                    "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                                });
                                if let Err(e) = window.emit(
                                    &format!("{}_web_search", stream_event),
                                    &web_search_event,
                                ) {
                                    error!("emit classified web_search event failed: {}", e);
                                }
                            }
                            if !rag_sources.is_empty() {
                                let rag_event = json!({
                                    "sources": rag_sources,
                                    "tool_name": tc.tool_name,
                                    "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                                });
                                if let Err(e) = window
                                    .emit(&format!("{}_rag_sources", stream_event), &rag_event)
                                {
                                    error!("emit classified rag event failed: {}", e);
                                }
                            }
                            if !memory_sources.is_empty() {
                                let memory_event = json!({
                                    "sources": memory_sources,
                                    "tool_name": tc.tool_name,
                                    "timestamp": chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
                                });
                                if let Err(e) = window.emit(
                                    &format!("{}_memory_sources", stream_event),
                                    &memory_event,
                                ) {
                                    error!("emit classified memory event failed: {}", e);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// 检测 Gemini 非流式响应中的安全阻断，并返回结构化错误消息（用于非流式路径回传给前端）
    pub(crate) fn extract_gemini_safety_error(resp: &serde_json::Value) -> Option<String> {
        // 1) promptFeedback.blockReason
        if let Some(obj) = resp.as_object() {
            if let Some(prompt_feedback) = obj.get("promptFeedback") {
                if let Some(block_reason) =
                    prompt_feedback.get("blockReason").and_then(|v| v.as_str())
                {
                    let info = serde_json::json!({
                        "type": "safety_error",
                        "reason": block_reason,
                        "details": prompt_feedback
                    });
                    return Some(format!("Gemini安全阻断: {}", info.to_string()));
                }
            }
        }
        // 2) candidates[*].finishReason == SAFETY
        if let Some(cands) = resp.get("candidates").and_then(|v| v.as_array()) {
            for cand in cands {
                if let Some(fr) = cand.get("finishReason").and_then(|v| v.as_str()) {
                    if fr == "SAFETY" {
                        let info = serde_json::json!({
                            "type": "safety_error",
                            "reason": fr,
                            "details": cand
                        });
                        return Some(format!("Gemini安全阻断: {}", info.to_string()));
                    }
                }
            }
        }
        None
    }

    /// Request cancellation for a given stream event name
    pub async fn request_cancel_stream(&self, stream_event: &str) {
        info!(
            "[LLM Manager] request_cancel_stream 开始处理: {}",
            stream_event
        );

        // Notify channel first (notification-style cancel)
        debug!("[LLM Manager] 检查 cancel_channels...");
        if let Some(sender) = self.cancel_channels.lock().await.get(stream_event).cloned() {
            debug!("[LLM Manager] 找到 cancel_channel，发送取消信号...");
            if sender.send(true).is_ok() {
                info!(
                    "[LLM Manager] 取消信号已成功发送到 channel: {}",
                    stream_event
                );
            } else {
                warn!(
                    "[LLM Manager] 取消信号发送失败（channel 已关闭）: {}",
                    stream_event
                );
            }
        } else {
            debug!(
                "[LLM Manager] 未找到对应的 cancel_channel: {}",
                stream_event
            );
        }

        // Fallback registry check (polling)
        debug!("[LLM Manager] 写入 cancel_registry 作为备用...");
        let mut guard = self.cancel_registry.lock().await;
        guard.insert(stream_event.to_string());
        debug!("[LLM Manager] 已将取消标记写入 registry: {}", stream_event);

        debug!("[LLM Manager] request_cancel_stream 完成");
    }

    async fn take_cancellation_if_any(&self, stream_event: &str) -> bool {
        let mut guard = self.cancel_registry.lock().await;
        if guard.remove(stream_event) {
            debug!(
                "[Cancel] Acknowledged and cleared cancel flag for stream: {}",
                stream_event
            );
            true
        } else {
            false
        }
    }

    async fn register_cancel_channel(&self, stream_event: &str) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        self.cancel_channels
            .lock()
            .await
            .insert(stream_event.to_string(), tx);
        rx
    }

    async fn clear_cancel_channel(&self, stream_event: &str) {
        self.cancel_channels.lock().await.remove(stream_event);
    }

    /// 取消所有以某个前缀匹配的流事件（用于题目集分割按 session 级别取消）
    pub async fn cancel_streams_by_prefix(&self, prefix: &str) {
        let keys: Vec<String> = self.cancel_channels.lock().await.keys().cloned().collect();
        for key in keys {
            if key.starts_with(prefix) {
                self.request_cancel_stream(&key).await;
            }
        }
        // 同时在 registry 中落取消标记，避免 race
        let guard = self.cancel_registry.lock().await;
        for key in guard.clone().iter() {
            if key.starts_with(prefix) {
                // 已存在则忽略；否则追加
            }
        }
    }

    /// 创建HTTP客户端，使用渐进式回退策略确保始终有合理的配置
    fn create_http_client_with_fallback() -> Client {
        // 创建默认请求头，显式禁用压缩，防止后端收到 gzip/deflate 数据导致乱码
        let mut headers = HeaderMap::new();
        headers.insert("Accept-Encoding", "identity".parse().unwrap());

        // 尝试1: 完整配置的客户端（推荐配置）
        let client_builder = ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(300)) // 全局超时300秒（流式请求需要更长时间）
            .connect_timeout(std::time::Duration::from_secs(30)) // 连接超时30秒
            .danger_accept_invalid_certs(false) // 保持SSL验证
            .default_headers(headers.clone());

        if let Ok(client) = client_builder.build() {
            info!("HTTP客户端创建成功: 完整配置（超时120s，连接15s，rustls TLS）");
            return client;
        }

        // 尝试2: 简化TLS配置的客户端
        let client_builder_2 = ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(30))
            .danger_accept_invalid_certs(false)
            .default_headers(headers.clone());

        if let Ok(client) = client_builder_2.build() {
            info!("HTTP客户端创建成功: 简化TLS配置（超时120s，连接15s，系统TLS）");
            return client;
        }

        // 尝试3: 仅超时配置的客户端
        if let Ok(client) = ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(300))
            .default_headers(headers.clone())
            .build()
        {
            info!("HTTP客户端创建成功: 仅超时配置（超时120s）");
            return client;
        }

        // 尝试4: 最小配置的客户端（保证基本超时）
        if let Ok(client) = ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(180)) // 最少180秒超时
            .default_headers(headers.clone())
            .build()
        {
            info!("HTTP客户端创建成功: 最小配置（超时60s）");
            return client;
        }

        // 最后回退: 默认客户端
        warn!("所有配置均失败，使用默认HTTP客户端（无超时配置）");
        warn!("这可能导致网络请求挂起，建议检查系统网络和TLS配置");
        Client::new()
    }

    /// 检测Base64编码图像的真实格式
    fn detect_image_format_from_base64(base64_data: &str) -> &'static str {
        // 解码Base64获取前几个字节来判断格式
        if let Ok(decoded) =
            general_purpose::STANDARD.decode(base64_data.get(..100).unwrap_or(base64_data))
        {
            Self::detect_image_format_from_bytes(&decoded)
        } else {
            "jpeg" // 默认格式
        }
    }
    /// 根据图像字节数据检测格式
    fn detect_image_format_from_bytes(image_data: &[u8]) -> &'static str {
        if image_data.len() < 4 {
            return "jpeg"; // 默认格式
        }

        // JPEG: FF D8 FF
        if image_data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            "jpeg"
        }
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        else if image_data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            "png"
        }
        // GIF: 47 49 46 38 (GIF8)
        else if image_data.starts_with(&[0x47, 0x49, 0x46, 0x38]) {
            "gif"
        }
        // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
        else if image_data.len() >= 12
            && image_data.starts_with(&[0x52, 0x49, 0x46, 0x46])
            && &image_data[8..12] == &[0x57, 0x45, 0x42, 0x50]
        {
            "webp"
        }
        // BMP: 42 4D (BM)
        else if image_data.starts_with(&[0x42, 0x4D]) {
            "bmp"
        } else {
            "jpeg" // 默认格式
        }
    }
    // P0修复：源抑制设置检查器

    /// 初始化供应商与模型条目结构，兼容旧版 api_configs
    pub async fn bootstrap_vendor_model_config(&self) -> Result<()> {
        let vendor_exists = self
            .db
            .get_setting("vendor_configs")
            .map_err(|e| AppError::database(format!("检测供应商配置失败: {}", e)))?
            .is_some();
        let profile_exists = self
            .db
            .get_setting("model_profiles")
            .map_err(|e| AppError::database(format!("检测模型条目失败: {}", e)))?
            .is_some();

        if vendor_exists && profile_exists {
            return Ok(());
        }

        let legacy_str = self
            .db
            .get_setting("api_configs")
            .map_err(|e| AppError::database(format!("获取旧版API配置失败: {}", e)))?
            .unwrap_or_else(|| "[]".to_string());

        let mut legacy_configs = if legacy_str.trim().is_empty() || legacy_str.trim() == "[]" {
            Vec::new()
        } else {
            match serde_json::from_str::<Vec<ApiConfig>>(&legacy_str) {
                Ok(mut configs) => {
                    for config in &mut configs {
                        config.api_key = self.decrypt_api_key_if_needed(&config.api_key)?;
                    }
                    configs
                }
                Err(_) => {
                    info!("检测到旧版API配置格式，正在迁移到供应商结构...");
                    self.migrate_api_configs_legacy(&legacy_str).await?
                }
            }
        };

        if legacy_configs.is_empty() {
            // 即使旧配置为空，也至少要初始化空数组，便于后续写入
            self.save_vendor_model_configs(&[], &[]).await?;
            return Ok(());
        }

        let (mut vendors, mut profiles) = self
            .flatten_api_configs_to_vendor_profiles(&legacy_configs)
            .await?;
        legacy_configs.clear();

        // 迁移时丢弃内置配置，由运行时动态注入
        vendors.retain(|v| !v.is_builtin);
        profiles.retain(|p| !p.is_builtin);

        self.save_vendor_model_configs(&vendors, &profiles).await?;
        Ok(())
    }

    pub async fn get_vendor_configs(&self) -> Result<Vec<VendorConfig>> {
        self.bootstrap_vendor_model_config().await?;
        let mut vendors = self.read_user_vendor_configs().await?;
        if let Ok((builtin_vendors, _)) = self.load_builtin_vendor_profiles() {
            for mut vendor in builtin_vendors {
                if let Some(existing) = vendors.iter_mut().find(|v| v.id == vendor.id) {
                    // 同步内置供应商的信息字段，保留用户自定义的 base_url/headers 等
                    existing.notes = vendor.notes.clone();
                    existing.name = vendor.name.clone();
                    existing.website_url = vendor.website_url.clone();
                    existing.is_builtin = true;
                    continue;
                }
                vendor.api_key = String::new();
                vendors.push(vendor);
            }
        }
        // 统一处理：内置供应商从安全存储读取真实 API key（与 vendor_configs_for_runtime 一致）
        // 前端可直接在 password input 中显示密码点，而非仅显示"已配置"占位符。
        for vendor in &mut vendors {
            let is_builtin_vendor = vendor.is_builtin || vendor.id.starts_with("builtin-");
            if !is_builtin_vendor {
                continue;
            }
            let is_invalid = vendor.api_key.is_empty()
                || vendor.api_key == "***"
                || vendor.api_key.chars().all(|c| c == '*');
            if is_invalid {
                let secret_key = format!("{}.api_key", vendor.id);
                if let Ok(Some(key)) = self.db.get_secret(&secret_key) {
                    if !key.is_empty() {
                        vendor.api_key = key;
                    }
                }
                // 兼容旧的 SiliconFlow 存储格式
                if vendor.id == "builtin-siliconflow" && vendor.api_key.is_empty() {
                    if let Ok(Some(sf_key)) = self.db.get_secret("siliconflow.api_key") {
                        if !sf_key.is_empty() {
                            vendor.api_key = sf_key;
                        }
                    }
                }
            }
            vendor.is_builtin = true;
        }
        Ok(vendors)
    }

    async fn read_user_vendor_configs(&self) -> Result<Vec<VendorConfig>> {
        let raw = self
            .db
            .get_setting("vendor_configs")
            .map_err(|e| AppError::database(format!("获取供应商配置失败: {}", e)))?
            .unwrap_or_else(|| "[]".to_string());

        let mut vendors: Vec<VendorConfig> = serde_json::from_str(&raw)
            .map_err(|e| AppError::configuration(format!("解析供应商配置失败: {}", e)))?;

        // 容错处理：解密失败时清空 API 密钥而不是让整个配置加载失败
        for vendor in &mut vendors {
            match self.decrypt_api_key_if_needed(&vendor.api_key) {
                Ok(decrypted) => {
                    // 迁移逻辑：如果是内置供应商且成功解密了 API key，迁移到安全存储
                    let is_builtin_vendor = vendor.is_builtin || vendor.id.starts_with("builtin-");
                    if is_builtin_vendor && !decrypted.is_empty() {
                        let secret_key = format!("{}.api_key", vendor.id);
                        if let Err(e) = self.db.save_secret(&secret_key, &decrypted) {
                            tracing::warn!(
                                "⚠️ 迁移内置供应商 {} 的 API 密钥到安全存储失败: {}",
                                vendor.id,
                                e
                            );
                        } else {
                            tracing::info!(
                                "✅ 已迁移内置供应商 {} 的 API 密钥到安全存储",
                                vendor.id
                            );
                        }
                        // 迁移后不再向上游返回明文（运行期会从安全存储读取）
                        vendor.api_key = String::new();
                        vendor.is_builtin = true;
                        continue;
                    }
                    vendor.api_key = decrypted;
                }
                Err(e) => {
                    // 记录警告但不中断加载
                    tracing::warn!(
                        "⚠️ 供应商 {} 的 API 密钥解密失败，将清空密钥: {}",
                        vendor.id,
                        e
                    );
                    // 清空密钥，用户需要重新配置
                    vendor.api_key = String::new();
                }
            }
        }
        Ok(vendors)
    }

    async fn vendor_configs_for_runtime(&self) -> Result<Vec<VendorConfig>> {
        let mut vendors = self.read_user_vendor_configs().await?;
        if let Ok((builtin_vendors, _)) = self.load_builtin_vendor_profiles() {
            for vendor in builtin_vendors {
                if vendors.iter().any(|v| v.id == vendor.id) {
                    continue;
                }
                vendors.push(vendor);
            }
        }

        // 内置供应商的 API key 统一通过安全存储管理（避免主密钥不稳定导致的解密问题）
        // 存储格式：{vendor_id}.api_key，如 "builtin-siliconflow.api_key"
        // 注意：使用 vendor.id.starts_with("builtin-") 判断，而不是 is_builtin 字段
        // 因为旧数据可能有 is_builtin=false 的内置供应商
        for vendor in &mut vendors {
            let is_builtin_vendor = vendor.is_builtin || vendor.id.starts_with("builtin-");
            if is_builtin_vendor {
                let is_invalid = vendor.api_key.is_empty()
                    || vendor.api_key == "***"
                    || vendor.api_key.chars().all(|c| c == '*');
                if is_invalid {
                    // 从安全存储读取 API key
                    let secret_key = format!("{}.api_key", vendor.id);
                    if let Ok(Some(key)) = self.db.get_secret(&secret_key) {
                        if !key.is_empty() {
                            vendor.api_key = key;
                        }
                    }
                    // 兼容旧的 SiliconFlow 存储格式
                    if vendor.id == "builtin-siliconflow" && vendor.api_key.is_empty() {
                        if let Ok(Some(sf_key)) = self.db.get_secret("siliconflow.api_key") {
                            if !sf_key.is_empty() {
                                vendor.api_key = sf_key;
                            }
                        }
                    }
                }
                // 确保 is_builtin 字段正确（修复旧数据）
                vendor.is_builtin = true;
            }
        }

        Ok(vendors)
    }

    pub async fn save_vendor_configs(&self, configs: &[VendorConfig]) -> Result<()> {
        // 读取现有配置，用于保留未更新的 API key
        let existing_vendors = self.read_user_vendor_configs().await.unwrap_or_default();
        let existing_map: std::collections::HashMap<String, String> = existing_vendors
            .into_iter()
            .map(|v| (v.id.clone(), v.api_key))
            .collect();

        let mut sanitized = Vec::new();
        for cfg in configs {
            let mut clone = cfg.clone();

            let trimmed = cfg.api_key.trim();
            // “保留旧值”占位符：*** 或全 *（但不包含空字符串）
            // 空字符串应视为用户明确清空（而不是保留）。
            let keep_placeholder =
                trimmed == "***" || (!trimmed.is_empty() && trimmed.chars().all(|c| c == '*'));
            // 内置供应商判断：兼容旧数据（is_builtin=false 但 id 以 builtin- 开头）
            let is_builtin_vendor = cfg.is_builtin || cfg.id.starts_with("builtin-");

            if is_builtin_vendor {
                // 内置供应商：API key 始终通过安全存储管理，vendor_configs 中不保存
                let secret_key = format!("{}.api_key", cfg.id);
                if keep_placeholder {
                    // no-op：保留安全存储中的值
                } else if trimmed.is_empty() {
                    // 用户明确清空：删除安全存储中的密钥
                    let _ = self.db.delete_secret(&secret_key);
                    // 兼容旧的 SiliconFlow 存储格式
                    if cfg.id == "builtin-siliconflow" {
                        let _ = self.db.delete_secret("siliconflow.api_key");
                    }
                } else {
                    self.db.save_secret(&secret_key, trimmed).map_err(|e| {
                        AppError::database(format!("保存内置供应商API密钥失败: {}", e))
                    })?;
                }
                clone.api_key = String::new();
                clone.is_builtin = true;
            } else {
                // 非内置供应商：API key 加密存储到 vendor_configs
                let effective_api_key = if keep_placeholder {
                    existing_map.get(&cfg.id).cloned().unwrap_or_default()
                } else {
                    trimmed.to_string()
                };
                clone.api_key = self.encrypt_api_key(&effective_api_key)?;
                clone.is_read_only = false;
            }
            sanitized.push(clone);
        }

        let json = serde_json::to_string(&sanitized)
            .map_err(|e| AppError::configuration(format!("序列化供应商配置失败: {}", e)))?;
        self.db
            .save_setting("vendor_configs", &json)
            .map_err(|e| AppError::database(format!("保存供应商配置失败: {}", e)))?;
        Ok(())
    }

    pub async fn get_model_profiles(&self) -> Result<Vec<ModelProfile>> {
        self.bootstrap_vendor_model_config().await?;
        let mut profiles = self.read_user_model_profiles().await?;
        let hidden_builtin_ids = self.read_hidden_builtin_model_profile_ids();
        if !hidden_builtin_ids.is_empty() {
            profiles.retain(|profile| !hidden_builtin_ids.contains(&profile.id));
        }

        // 一次性迁移：直接将内置模型的能力字段写入用户存储的 model_profiles。
        // 背景：早期版本在无快照时保守地保留了用户数据（含错误的 supports_tools=false），
        // 随后快照被"污染"为新内置值，导致后续合并永远跳过更新。
        // 必须直接修改 DB 中的 model_profiles，否则运行时路径（model_profiles_for_runtime）
        // 仍会读到旧值。
        const BUILTIN_CAPS_MIGRATION_KEY: &str = "builtin_caps_migration_v2";
        if self
            .db
            .get_setting(BUILTIN_CAPS_MIGRATION_KEY)
            .ok()
            .flatten()
            .is_none()
        {
            if let Ok((_, builtin_list)) = self.load_builtin_vendor_profiles() {
                let builtin_map: HashMap<String, &ModelProfile> =
                    builtin_list.iter().map(|p| (p.id.clone(), p)).collect();
                let mut patched = false;
                for profile in &mut profiles {
                    if let Some(builtin) = builtin_map.get(&profile.id) {
                        if profile.supports_tools != builtin.supports_tools
                            || profile.is_multimodal != builtin.is_multimodal
                            || profile.is_reasoning != builtin.is_reasoning
                            || profile.supports_reasoning != builtin.supports_reasoning
                        {
                            profile.is_multimodal = builtin.is_multimodal;
                            profile.is_reasoning = builtin.is_reasoning;
                            profile.is_embedding = builtin.is_embedding;
                            profile.is_reranker = builtin.is_reranker;
                            profile.supports_tools = builtin.supports_tools;
                            profile.supports_reasoning = builtin.supports_reasoning;
                            patched = true;
                            info!(
                                "[VendorModel] 迁移: {} 能力字段已从内置定义同步 (supports_tools={})",
                                profile.id, builtin.supports_tools
                            );
                        }
                    }
                }
                if patched {
                    if let Err(e) = self.save_model_profiles(&profiles).await {
                        warn!("[VendorModel] 迁移保存失败（不影响本次读取）: {}", e);
                    }
                }
            }
            // 同时清除快照，让后续 merge 基于干净状态重建
            let _ = self
                .db
                .save_setting(BUILTIN_MODEL_PROFILES_SNAPSHOT_KEY, "[]");
            let _ = self.db.save_setting(BUILTIN_CAPS_MIGRATION_KEY, "done");
            info!("[VendorModel] 能力字段迁移完成");
        }

        let snapshot_map = self.read_builtin_profile_snapshot_map();
        if let Ok((_, builtin_profiles)) = self.load_builtin_vendor_profiles() {
            for builtin_profile in &builtin_profiles {
                if hidden_builtin_ids.contains(&builtin_profile.id) {
                    continue;
                }
                Self::merge_builtin_profile_user_aware(
                    &mut profiles,
                    builtin_profile.clone(),
                    snapshot_map.get(&builtin_profile.id),
                );
            }
            if let Err(err) = self.save_builtin_profile_snapshot(&builtin_profiles) {
                warn!("[VendorModel] 保存内置模型快照失败（不影响读取）: {}", err);
            }
        }
        Ok(profiles)
    }

    async fn read_user_model_profiles(&self) -> Result<Vec<ModelProfile>> {
        let raw = self
            .db
            .get_setting("model_profiles")
            .map_err(|e| AppError::database(format!("获取模型条目失败: {}", e)))?
            .unwrap_or_else(|| "[]".to_string());

        let profiles: Vec<ModelProfile> = serde_json::from_str(&raw)
            .map_err(|e| AppError::configuration(format!("解析模型条目失败: {}", e)))?;
        Ok(profiles)
    }

    async fn model_profiles_for_runtime(&self) -> Result<Vec<ModelProfile>> {
        // 复用 get_model_profiles 以确保运行时路径也执行能力字段迁移和快照合并
        self.get_model_profiles().await
    }

    pub async fn save_model_profiles(&self, profiles: &[ModelProfile]) -> Result<()> {
        // ★ 2026-01-19 修复：保存所有模型（包括 is_builtin=true），以支持用户对内置模型的收藏等自定义设置
        // 加载时按“字段级用户优先”进行合并：用户改过的字段保持不变，未改字段可接收后续内置更新
        if let Ok((_, builtin_profiles)) = self.load_builtin_vendor_profiles() {
            let builtin_id_set: HashSet<String> =
                builtin_profiles.iter().map(|profile| profile.id.clone()).collect();
            let incoming_builtin_ids: HashSet<String> = profiles
                .iter()
                .map(|profile| profile.id.clone())
                .filter(|id| builtin_id_set.contains(id))
                .collect();

            if !incoming_builtin_ids.is_empty() {
                let hidden_builtin_ids: HashSet<String> = builtin_id_set
                    .difference(&incoming_builtin_ids)
                    .cloned()
                    .collect();
                self.save_hidden_builtin_model_profile_ids(&hidden_builtin_ids)?;
            }
        }

        let json = serde_json::to_string(profiles)
            .map_err(|e| AppError::configuration(format!("序列化模型条目失败: {}", e)))?;
        self.db
            .save_setting("model_profiles", &json)
            .map_err(|e| AppError::database(format!("保存模型条目失败: {}", e)))?;
        Ok(())
    }

    pub async fn save_vendor_model_configs(
        &self,
        vendors: &[VendorConfig],
        profiles: &[ModelProfile],
    ) -> Result<()> {
        self.save_vendor_configs(vendors).await?;
        self.save_model_profiles(profiles).await?;
        Ok(())
    }

    /// 向后兼容的 ApiConfig 列表（运行期已附带供应商信息）
    pub async fn get_api_configs(&self) -> Result<Vec<ApiConfig>> {
        self.bootstrap_vendor_model_config().await?;
        let vendors = self.vendor_configs_for_runtime().await?;
        let profiles = self.model_profiles_for_runtime().await?;
        let vendor_map: HashMap<String, VendorConfig> =
            vendors.into_iter().map(|v| (v.id.clone(), v)).collect();

        let mut resolved = Vec::new();
        for profile in profiles {
            if let Some(vendor) = vendor_map.get(&profile.vendor_id) {
                let merged = self.merge_vendor_profile(vendor, &profile)?;
                resolved.push(merged.runtime);
            } else {
                warn!("[VendorModel] 找不到模型条目关联的供应商: {}", profile.id);
            }
        }

        Ok(resolved)
    }

    fn merge_vendor_profile(
        &self,
        vendor: &VendorConfig,
        profile: &ModelProfile,
    ) -> Result<ResolvedModelConfig> {
        let api_key = if vendor.is_builtin {
            vendor.api_key.trim().to_string()
        } else {
            self.decrypt_api_key_if_needed(&vendor.api_key)?
                .trim()
                .to_string()
        };

        let has_api_key =
            !api_key.is_empty() && api_key != "***" && !api_key.chars().all(|c| c == '*');

        let runtime = ApiConfig {
            id: profile.id.clone(),
            name: profile.label.clone(),
            vendor_id: Some(vendor.id.clone()),
            vendor_name: Some(vendor.name.clone()),
            provider_type: Some(vendor.provider_type.clone()),
            api_key,
            base_url: vendor.base_url.clone(),
            model: profile.model.clone(),
            is_multimodal: profile.is_multimodal,
            is_reasoning: profile.is_reasoning,
            is_embedding: profile.is_embedding,
            is_reranker: profile.is_reranker,
            enabled: profile.enabled && profile.status.to_lowercase() != "disabled" && has_api_key,
            model_adapter: profile.model_adapter.clone(),
            max_output_tokens: profile.max_output_tokens,
            temperature: profile.temperature,
            supports_tools: profile.supports_tools,
            gemini_api_version: profile
                .gemini_api_version
                .clone()
                .unwrap_or_else(default_gemini_api_version),
            is_builtin: profile.is_builtin || vendor.is_builtin,
            is_read_only: vendor.is_read_only,
            reasoning_effort: profile.reasoning_effort.clone(),
            thinking_enabled: profile.thinking_enabled,
            thinking_budget: profile.thinking_budget,
            include_thoughts: profile.include_thoughts,
            min_p: profile.min_p,
            top_k: profile.top_k,
            enable_thinking: profile.enable_thinking,
            supports_reasoning: profile.supports_reasoning || profile.is_reasoning,
            headers: Some(vendor.headers.clone()),
            top_p_override: None,
            frequency_penalty_override: None,
            presence_penalty_override: None,
            repetition_penalty: profile.repetition_penalty,
            reasoning_split: profile.reasoning_split,
            effort: profile.effort.clone(),
            verbosity: profile.verbosity.clone(),
            is_favorite: profile.is_favorite,
            // 模型粒度自管理 max_tokens_limit，不从供应商继承
            max_tokens_limit: profile.max_tokens_limit,
        };

        Ok(ResolvedModelConfig {
            vendor: vendor.clone(),
            profile: profile.clone(),
            runtime,
        })
    }

    fn load_builtin_vendor_profiles(&self) -> Result<(Vec<VendorConfig>, Vec<ModelProfile>)> {
        let mut vendors = Vec::new();
        let mut profiles = Vec::new();

        // 1. 首先加载内置免费模型（如果有编译时环境变量）
        let builtin = match load_builtin_api_configs() {
            Ok(configs) => configs,
            Err(err) => {
                error!("[VendorModel] 加载内置模型配置失败: {}", err);
                Vec::new()
            }
        };
        for cfg in builtin {
            let is_siliconflow = cfg.base_url.to_lowercase().contains("siliconflow");
            let vendor_id = if is_siliconflow {
                "builtin-siliconflow".to_string()
            } else {
                format!("builtin-{}", cfg.id)
            };
            let vendor_name = if is_siliconflow {
                "SiliconFlow".to_string()
            } else {
                cfg.name.clone()
            };
            if !vendors.iter().any(|v: &VendorConfig| v.id == vendor_id) {
                vendors.push(VendorConfig {
                    id: vendor_id.clone(),
                    name: vendor_name,
                    provider_type: if is_siliconflow {
                        "siliconflow".to_string()
                    } else {
                        cfg.model_adapter.clone()
                    },
                    base_url: cfg.base_url.clone(),
                    api_key: cfg.api_key.clone(),
                    headers: cfg.headers.clone().unwrap_or_default(),
                    rate_limit_per_minute: None,
                    default_timeout_ms: None,
                    notes: None,
                    is_builtin: true,
                    is_read_only: true,
                    sort_order: None,
                    max_tokens_limit: cfg.max_tokens_limit,
                    website_url: None,
                });
            }
            profiles.push(ModelProfile {
                id: cfg.id.clone(),
                vendor_id: vendor_id.clone(),
                label: cfg.name.clone(),
                model: cfg.model.clone(),
                model_adapter: cfg.model_adapter.clone(),
                is_multimodal: cfg.is_multimodal,
                is_reasoning: cfg.is_reasoning,
                is_embedding: cfg.is_embedding,
                is_reranker: cfg.is_reranker,
                supports_tools: cfg.supports_tools,
                supports_reasoning: cfg.supports_reasoning || cfg.is_reasoning,
                status: if cfg.enabled {
                    "enabled".to_string()
                } else {
                    "disabled".to_string()
                },
                enabled: cfg.enabled,
                max_output_tokens: cfg.max_output_tokens,
                temperature: cfg.temperature,
                reasoning_effort: cfg.reasoning_effort.clone(),
                thinking_enabled: cfg.thinking_enabled,
                thinking_budget: cfg.thinking_budget,
                include_thoughts: cfg.include_thoughts,
                enable_thinking: cfg.enable_thinking,
                min_p: cfg.min_p,
                top_k: cfg.top_k,
                gemini_api_version: Some(cfg.gemini_api_version.clone()),
                is_builtin: true,
                is_favorite: cfg.is_favorite,
                max_tokens_limit: cfg.max_tokens_limit,
                repetition_penalty: cfg.repetition_penalty,
                reasoning_split: cfg.reasoning_split,
                effort: cfg.effort.clone(),
                verbosity: cfg.verbosity.clone(),
            });
        }

        // 2. 加载预置供应商模板（来自 builtin_vendors 模块）
        let existing_vendor_ids: Vec<String> = vendors.iter().map(|v| v.id.clone()).collect();
        let existing_profile_ids: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();

        let (new_vendors, new_profiles) =
            builtin_vendors::load_all_builtins(&existing_vendor_ids, &existing_profile_ids);

        vendors.extend(new_vendors);
        profiles.extend(new_profiles);

        Ok((vendors, profiles))
    }

    // 迁移旧版API配置到新结构（兼容读取）
    async fn migrate_api_configs_legacy(&self, old_config_str: &str) -> Result<Vec<ApiConfig>> {
        #[derive(serde::Deserialize)]
        struct OldApiConfigV2 {
            id: String,
            name: String,
            api_key: String,
            base_url: String,
            model: String,
            is_multimodal: bool,
            is_reasoning: bool,
            enabled: bool,
        }

        #[derive(serde::Deserialize)]
        struct OldApiConfigV1 {
            id: String,
            name: String,
            api_key: String,
            base_url: String,
            model: String,
            is_multimodal: bool,
            enabled: bool,
        }

        if let Ok(old_configs) = serde_json::from_str::<Vec<OldApiConfigV2>>(old_config_str) {
            return Ok(old_configs
                .into_iter()
                .map(|old| ApiConfig {
                    id: old.id,
                    name: old.name,
                    api_key: old.api_key,
                    base_url: old.base_url,
                    model: old.model,
                    is_multimodal: old.is_multimodal,
                    is_reasoning: old.is_reasoning,
                    is_embedding: false,
                    is_reranker: false,
                    enabled: old.enabled,
                    model_adapter: default_model_adapter(),
                    max_output_tokens: default_max_output_tokens(),
                    temperature: default_temperature(),
                    supports_tools: false,
                    gemini_api_version: default_gemini_api_version(),
                    min_p: None,
                    top_k: None,
                    enable_thinking: None,
                    is_builtin: false,
                    is_read_only: false,
                    reasoning_effort: None,
                    thinking_enabled: false,
                    thinking_budget: None,
                    include_thoughts: false,
                    supports_reasoning: old.is_reasoning,
                    vendor_id: None,
                    vendor_name: None,
                    provider_type: None,
                    headers: None,
                    top_p_override: None,
                    frequency_penalty_override: None,
                    presence_penalty_override: None,
                    repetition_penalty: None,
                    reasoning_split: None,
                    effort: None,
                    verbosity: None,
                    is_favorite: false,
                    max_tokens_limit: None,
                })
                .collect());
        }

        let old_configs: Vec<OldApiConfigV1> = serde_json::from_str(old_config_str)
            .map_err(|e| AppError::configuration(format!("解析旧版API配置失败: {}", e)))?;

        Ok(old_configs
            .into_iter()
            .map(|old| ApiConfig {
                id: old.id,
                name: old.name,
                api_key: old.api_key,
                base_url: old.base_url,
                model: old.model,
                is_multimodal: old.is_multimodal,
                is_reasoning: false,
                is_embedding: false,
                is_reranker: false,
                enabled: old.enabled,
                model_adapter: default_model_adapter(),
                max_output_tokens: default_max_output_tokens(),
                temperature: default_temperature(),
                supports_tools: false,
                gemini_api_version: default_gemini_api_version(),
                min_p: None,
                top_k: None,
                enable_thinking: None,
                is_builtin: false,
                is_read_only: false,
                reasoning_effort: None,
                thinking_enabled: false,
                thinking_budget: None,
                include_thoughts: false,
                supports_reasoning: false,
                vendor_id: None,
                vendor_name: None,
                provider_type: None,
                headers: None,
                top_p_override: None,
                frequency_penalty_override: None,
                presence_penalty_override: None,
                is_favorite: false,
                max_tokens_limit: None,
                repetition_penalty: None,
                reasoning_split: None,
                effort: None,
                verbosity: None,
            })
            .collect())
    }

    async fn flatten_api_configs_to_vendor_profiles(
        &self,
        configs: &[ApiConfig],
    ) -> Result<(Vec<VendorConfig>, Vec<ModelProfile>)> {
        let mut vendors_map: HashMap<String, VendorConfig> = HashMap::new();
        let mut profiles: Vec<ModelProfile> = Vec::new();

        for cfg in configs {
            let base_key = format!("{}::{}", cfg.base_url.trim(), cfg.api_key.trim());
            let key = cfg
                .vendor_id
                .clone()
                .unwrap_or_else(|| format!("auto::{}", base_key));
            let vendor_entry = vendors_map.entry(key.clone()).or_insert_with(|| {
                let provider_type = cfg
                    .provider_type
                    .clone()
                    .unwrap_or_else(|| cfg.model_adapter.clone());
                let vendor_id = cfg
                    .vendor_id
                    .clone()
                    .or_else(|| Some(format!("vendor-{}", Uuid::new_v4())))
                    .unwrap();
                VendorConfig {
                    id: vendor_id,
                    name: cfg
                        .vendor_name
                        .clone()
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| cfg.name.clone()),
                    provider_type,
                    base_url: cfg.base_url.clone(),
                    api_key: cfg.api_key.clone(),
                    headers: cfg.headers.clone().unwrap_or_default(),
                    rate_limit_per_minute: None,
                    default_timeout_ms: None,
                    notes: None,
                    is_builtin: cfg.is_builtin,
                    is_read_only: cfg.is_read_only,
                    sort_order: None,
                    max_tokens_limit: cfg.max_tokens_limit,
                    website_url: None,
                }
            });
            let vendor_id = vendor_entry.id.clone();

            profiles.push(ModelProfile {
                id: cfg.id.clone(),
                vendor_id,
                label: cfg.name.clone(),
                model: cfg.model.clone(),
                model_adapter: cfg.model_adapter.clone(),
                is_multimodal: cfg.is_multimodal,
                is_reasoning: cfg.is_reasoning,
                is_embedding: cfg.is_embedding,
                is_reranker: cfg.is_reranker,
                supports_tools: cfg.supports_tools,
                supports_reasoning: cfg.supports_reasoning || cfg.is_reasoning,
                status: if cfg.enabled {
                    "enabled".to_string()
                } else {
                    "disabled".to_string()
                },
                enabled: cfg.enabled,
                max_output_tokens: cfg.max_output_tokens,
                temperature: cfg.temperature,
                reasoning_effort: cfg.reasoning_effort.clone(),
                thinking_enabled: cfg.thinking_enabled,
                thinking_budget: cfg.thinking_budget,
                include_thoughts: cfg.include_thoughts,
                enable_thinking: cfg.enable_thinking,
                min_p: cfg.min_p,
                top_k: cfg.top_k,
                gemini_api_version: Some(cfg.gemini_api_version.clone()),
                is_builtin: cfg.is_builtin,
                is_favorite: cfg.is_favorite,
                max_tokens_limit: cfg.max_tokens_limit,
                repetition_penalty: cfg.repetition_penalty,
                reasoning_split: cfg.reasoning_split,
                effort: cfg.effort.clone(),
                verbosity: cfg.verbosity.clone(),
            });
        }

        Ok((vendors_map.into_values().collect(), profiles))
    }
    // 获取对话模型配置（公开方法）
    pub async fn get_model2_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let model2_id = assignments
            .model2_config_id
            .ok_or_else(|| AppError::configuration("对话模型未配置"))?;

        let configs = self.get_api_configs().await?;
        // 注意：已分配的模型即使 enabled=false 也允许使用
        // enabled 仅影响模型选择器中的显示，不阻止已分配模型的调用
        let config = configs
            .into_iter()
            .find(|c| c.id == model2_id && !c.is_embedding && !c.is_reranker)
            .ok_or_else(|| {
                AppError::configuration(
                    "找不到有效的对话模型配置（禁止使用嵌入/重排序模型作为对话模型）",
                )
            })?;

        Ok(config)
    }

    /// 获取记忆决策模型配置（公开方法）
    ///
    /// 回退链：memory_decision_model_config_id → model2_config_id
    pub async fn get_memory_decision_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let model_id = assignments
            .memory_decision_model_config_id
            .or(assignments.model2_config_id)
            .ok_or_else(|| AppError::configuration("没有配置可用的记忆决策模型"))?;

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|c| c.id == model_id && !c.is_embedding && !c.is_reranker)
            .ok_or_else(|| {
                AppError::configuration("找不到有效的记忆决策模型配置（禁止使用嵌入/重排序模型）")
            })?;

        Ok(config)
    }

    /// 获取标题/标签生成模型配置（公开方法）
    ///
    /// 回退链：chat_title_model_config_id → model2_config_id
    pub async fn get_chat_title_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let model_id = assignments
            .chat_title_model_config_id
            .or(assignments.model2_config_id)
            .ok_or_else(|| AppError::configuration("没有配置可用的标题/标签生成模型"))?;

        let configs = self.get_api_configs().await?;
        let config = configs
            .into_iter()
            .find(|c| c.id == model_id && !c.is_embedding && !c.is_reranker)
            .ok_or_else(|| {
                AppError::configuration(
                    "找不到有效的标题/标签生成模型配置（禁止使用嵌入/重排序模型）",
                )
            })?;

        Ok(config)
    }

    /// 获取 OCR 模型配置（公开方法，供多模态索引等通用 OCR 使用）
    ///
    /// 默认按 FreeText 策略返回：OCR-VLM（快速/便宜）优先于通用 VLM。
    /// 同类内部保持用户设置的 priority 顺序。
    /// 回退链：已启用的 OCR 引擎 → exam_sheet_ocr_model_config_id
    pub async fn get_ocr_model_config(&self) -> Result<ApiConfig> {
        use crate::ocr_adapters::OcrEngineType;

        let configs = self.get_api_configs().await?;
        let available = self.get_available_ocr_models().await;

        let mut enabled_models: Vec<&OcrModelConfig> =
            available.iter().filter(|m| m.enabled).collect();
        // FreeText 策略：专业 OCR 模型优先（快速/便宜），通用 VLM 兜底
        enabled_models.sort_by_key(|m| {
            let engine = OcrEngineType::from_str(&m.engine_type);
            (if engine.is_dedicated_ocr() { 0u8 } else { 1 }, m.priority)
        });

        // 尝试按优先级找到第一个有效的配置
        for ocr_config in &enabled_models {
            if let Some(config) = configs.iter().find(|c| c.id == ocr_config.config_id) {
                if config.is_multimodal {
                    debug!(
                        "[OCR] 使用引擎 {} 对应的模型配置: id={}, model={} (priority={})",
                        ocr_config.engine_type, config.id, config.model, ocr_config.priority
                    );
                    return Ok(config.clone());
                } else {
                    warn!(
                        "[OCR] 引擎 {} 对应的模型 {} 不支持多模态，跳过",
                        ocr_config.engine_type, config.model
                    );
                }
            } else {
                warn!(
                    "[OCR] 引擎 {} 对应的配置 ID {} 不存在，跳过",
                    ocr_config.engine_type, ocr_config.config_id
                );
            }
        }

        // 回退：使用 exam_sheet_ocr_model_config_id
        let assignments = self.get_model_assignments().await?;
        let model_id = assignments.exam_sheet_ocr_model_config_id.ok_or_else(|| {
            AppError::configuration("OCR 模型未配置，请在模型分配中添加 OCR 引擎")
        })?;

        let config = configs
            .into_iter()
            .find(|c| c.id == model_id)
            .ok_or_else(|| {
                AppError::configuration(format!("找不到 ID 为 {} 的模型配置", model_id))
            })?;

        if !config.is_multimodal {
            return Err(AppError::configuration(
                "当前配置的 OCR 模型未启用多模态能力，请选择支持图像输入的模型（如 DeepSeek-OCR）",
            ));
        }

        debug!(
            "[OCR] 使用配置的模型（回退）: id={}, model={}",
            config.id, config.model
        );

        Ok(config)
    }

    /// 按优先级获取所有已启用的 OCR 引擎配置列表（用于熔断重试）
    ///
    /// 根据 `task_type` 对引擎列表进行分流排序：
    /// - `FreeText`：OCR-VLM（快速专业模型）优先，通用 VLM 兜底
    /// - `Structured`：通用 VLM（GLM-4.6V 等）优先，OCR-VLM 兜底
    ///
    /// 同类引擎之间保持用户设置的 priority 顺序。
    pub async fn get_ocr_configs_by_priority(
        &self,
        task_type: crate::ocr_adapters::OcrTaskType,
    ) -> Result<Vec<(ApiConfig, crate::ocr_adapters::OcrEngineType)>> {
        use crate::ocr_adapters::{OcrAdapterFactory, OcrEngineType, OcrTaskType};

        let configs = self.get_api_configs().await?;
        let available = self.get_available_ocr_models().await;

        let mut enabled_models: Vec<&OcrModelConfig> =
            available.iter().filter(|m| m.enabled).collect();
        enabled_models.sort_by_key(|m| m.priority);

        let mut result = Vec::new();
        for ocr_config in &enabled_models {
            if let Some(config) = configs.iter().find(|c| c.id == ocr_config.config_id) {
                if !config.is_multimodal {
                    continue;
                }
                let engine = OcrEngineType::from_str(&ocr_config.engine_type);
                let effective_engine =
                    if OcrAdapterFactory::validate_model_for_engine(&config.model, engine) {
                        engine
                    } else {
                        OcrAdapterFactory::infer_engine_from_model(&config.model)
                    };
                result.push((config.clone(), effective_engine));
            }
        }

        if result.is_empty() {
            if let Ok(config) = self.get_ocr_model_config().await {
                let engine = OcrAdapterFactory::infer_engine_from_model(&config.model);
                result.push((config, engine));
            }
        }

        if result.is_empty() {
            return Err(AppError::configuration(
                "没有可用的 OCR 引擎配置，请在设置中添加 OCR 引擎",
            ));
        }

        // 按任务类型分流：stable partition 保持同类内部的 priority 顺序
        match task_type {
            OcrTaskType::FreeText => {
                // 专业 OCR 模型在前（快、便宜），通用 VLM 在后
                result.sort_by_key(|(_, engine)| if engine.is_dedicated_ocr() { 0 } else { 1 });
            }
            OcrTaskType::Structured => {
                // 通用 VLM 在前（GLM-4.6V 等，复杂布局理解能力强），专业 OCR 在后
                result.sort_by_key(|(_, engine)| if engine.is_dedicated_ocr() { 1 } else { 0 });
            }
        }

        debug!(
            "[OCR] 引擎优先级（{:?}）: {}",
            task_type,
            result
                .iter()
                .enumerate()
                .map(|(i, (c, e))| format!("#{} {}({})", i, e.display_name(), c.model))
                .collect::<Vec<_>>()
                .join(" → ")
        );

        Ok(result)
    }

    /// 获取所有已配置的 OCR 模型列表
    ///
    /// 包含自动迁移逻辑：
    /// 1. 将旧版本 PaddleOCR-VL 模型名称自动更新为 1.5 版本
    /// 2. 从旧 ocr.engine_type 单选迁移到新优先级列表
    pub async fn get_available_ocr_models(&self) -> Vec<OcrModelConfig> {
        if let Ok(Some(json)) = self.db.get_setting("ocr.available_models") {
            if let Ok(mut models) = serde_json::from_str::<Vec<OcrModelConfig>>(&json) {
                let mut needs_save = crate::cmd::ocr::migrate_paddle_ocr_models(&mut models);

                // GLM-4.1V → 4.6V 迁移：同时更新关联的 ApiConfig.model
                let glm_migrate_ids: Vec<String> = models
                    .iter()
                    .filter(|m| {
                        m.engine_type == "glm4v_ocr" && m.model.to_lowercase().contains("glm-4.1v")
                    })
                    .map(|m| m.config_id.clone())
                    .collect();

                if crate::cmd::ocr::migrate_glm_ocr_models(&mut models) {
                    needs_save = true;
                    // 同步更新 ApiConfig 中的 model 字段，确保实际 API 调用也使用新模型
                    if !glm_migrate_ids.is_empty() {
                        if let Ok(mut api_configs) = self.get_api_configs().await {
                            let mut api_changed = false;
                            for cfg in api_configs.iter_mut() {
                                if glm_migrate_ids.contains(&cfg.id)
                                    && cfg.model.to_lowercase().contains("glm-4.1v")
                                {
                                    info!(
                                        "[OCR] 同步更新 ApiConfig model: {} → zai-org/GLM-4.6V (id={})",
                                        cfg.model, cfg.id
                                    );
                                    cfg.model = "zai-org/GLM-4.6V".to_string();
                                    cfg.name = cfg
                                        .name
                                        .replace("GLM-4.1V", "GLM-4.6V")
                                        .replace("4.1V", "4.6V");
                                    api_changed = true;
                                }
                            }
                            if api_changed {
                                let _ = self.save_api_configurations(&api_configs).await;
                            }
                        }
                    }
                }

                // 迁移：如果所有 priority 都是 0 且存在旧 ocr.engine_type 设置，
                // 则根据旧单选设置调整优先级
                if models.len() > 1 && models.iter().all(|m| m.priority == 0) {
                    if let Ok(Some(old_engine)) = self.db.get_setting("ocr.engine_type") {
                        for (i, model) in models.iter_mut().enumerate() {
                            if model.engine_type == old_engine {
                                model.priority = 0; // 旧选中的排第一
                            } else {
                                model.priority = (i as u32) + 1;
                            }
                        }
                        // 重新按 priority 排序确保一致
                        models.sort_by_key(|m| m.priority);
                        // 重新编号
                        for (i, model) in models.iter_mut().enumerate() {
                            model.priority = i as u32;
                        }
                        needs_save = true;
                        info!(
                            "[OCR] 已从旧 ocr.engine_type='{}' 迁移到优先级列表",
                            old_engine
                        );
                    }
                }

                if needs_save {
                    if let Ok(updated_json) = serde_json::to_string(&models) {
                        let _ = self.db.save_setting("ocr.available_models", &updated_json);
                    }
                }
                return models;
            }
        }
        Vec::new()
    }

    /// 使用指定引擎测试 OCR
    ///
    /// 用于对比不同 OCR 引擎的速度和质量
    pub async fn test_ocr_with_engine(
        &self,
        image_path: String,
        engine_type: crate::ocr_adapters::OcrEngineType,
        config_id: Option<&str>,
    ) -> Result<(String, Vec<crate::ocr_adapters::OcrRegion>)> {
        use crate::ocr_adapters::{OcrAdapterFactory, OcrMode, OcrRegion};
        use crate::providers::ProviderAdapter;
        use serde_json::json;

        // 获取指定引擎的适配器
        let adapter = OcrAdapterFactory::create(engine_type);
        let engine_name = adapter.display_name();
        let ocr_mode = OcrMode::Grounding;

        // 优先通过 config_id 精确查找，回退到 engine_type 查找
        let config = if let Some(cid) = config_id {
            let configs = self.get_api_configs().await?;
            configs
                .into_iter()
                .find(|c| c.id == cid)
                .ok_or_else(|| AppError::configuration(format!("找不到配置 ID: {}", cid)))?
        } else {
            self.get_ocr_model_config_for_engine(engine_type).await?
        };

        debug!(
            "[OCR Test] 使用引擎 {} 测试，模型: {}",
            engine_name, config.model
        );

        // 准备图片数据
        let mime = Self::infer_image_mime(&image_path);
        let (data_url, _) = self
            .prepare_segmentation_image_data(&image_path, mime)
            .await?;

        // 构建请求
        let prompt_text = adapter.build_prompt(ocr_mode);
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": data_url, "detail": if adapter.requires_high_detail() { "high" } else { "low" } } },
                { "type": "text", "text": prompt_text }
            ]
        })];

        let max_tokens = effective_max_tokens(config.max_output_tokens, config.max_tokens_limit)
            .min(adapter.recommended_max_tokens(ocr_mode))
            .max(2048)
            .min(8000);

        // 构建基础请求体
        let mut request_body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": adapter.recommended_temperature(),
            "max_tokens": max_tokens,
            "stream": false,
        });

        if let Some(extra) = adapter.get_extra_request_params() {
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

        // 如果适配器推荐设置 repetition_penalty，则添加到请求中
        // 这对 PaddleOCR-VL 等模型很重要，可以避免重复输出问题
        if let Some(repetition_penalty) = adapter.recommended_repetition_penalty() {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("repetition_penalty".to_string(), json!(repetition_penalty));
            }
            debug!(
                "[OCR Test] 设置 repetition_penalty = {} (避免重复输出)",
                repetition_penalty
            );
        }

        // 选择适配器
        let provider_adapter: Box<dyn ProviderAdapter> = match config.model_adapter.as_str() {
            "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
            "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
            _ => Box::new(crate::providers::OpenAIAdapter),
        };

        let preq = provider_adapter
            .build_request(
                &config.base_url,
                &config.api_key,
                &config.model,
                &request_body,
            )
            .map_err(|e| AppError::llm(format!("{} 请求构建失败: {}", engine_name, e)))?;

        model2_pipeline::log_llm_request_audit(
            "OCR_ENGINE_TEST",
            &preq.url,
            &config.model,
            &request_body,
            None,
        );

        // 发送请求
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| AppError::network(format!("创建 HTTP 客户端失败: {}", e)))?;

        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in preq.headers.iter() {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }

        let response = client
            .post(&preq.url)
            .headers(header_map)
            .json(&preq.body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("{} 请求失败: {}", engine_name, e)))?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::llm(format!(
                "{} API 返回错误 ({}): {}",
                engine_name, status, error_text
            )));
        }

        let response_json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::llm(format!("解析 {} 响应失败: {}", engine_name, e)))?;

        // 提取响应文本
        let content = response_json
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 获取图片尺寸（用于坐标转换）
        let (image_width, image_height) =
            image::image_dimensions(&image_path).unwrap_or((1000, 1000));

        // 使用适配器解析响应
        let parse_result = adapter.parse_response(
            &content,
            image_width,
            image_height,
            0, // page_index
            &image_path,
            OcrMode::Grounding,
        );

        // 提取区域列表
        let regions = match parse_result {
            Ok(page_result) => page_result.regions,
            Err(_) => {
                // 解析失败，返回原始文本作为单个区域
                vec![OcrRegion {
                    label: "text".to_string(),
                    text: content.clone(),
                    bbox_normalized: None,
                    bbox_pixels: None,
                    confidence: None,
                    raw_output: Some(content.clone()),
                }]
            }
        };

        // 如果没有解析出区域，创建一个包含全部文本的默认区域
        let final_regions = if regions.is_empty() {
            vec![OcrRegion {
                label: "text".to_string(),
                text: content.clone(),
                bbox_normalized: None,
                bbox_pixels: None,
                confidence: None,
                raw_output: Some(content.clone()),
            }]
        } else {
            regions
        };

        // 合并所有区域的文本
        let full_text = final_regions
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        Ok((full_text, final_regions))
    }

    /// 获取指定引擎类型对应的模型配置
    async fn get_ocr_model_config_for_engine(
        &self,
        engine_type: crate::ocr_adapters::OcrEngineType,
    ) -> Result<ApiConfig> {
        let configs = self.get_api_configs().await?;

        // 尝试从 ocr.available_models 中查找对应引擎的配置 ID
        if let Ok(Some(available_models_json)) = self.db.get_setting("ocr.available_models") {
            if let Ok(available_models) =
                serde_json::from_str::<Vec<OcrModelConfig>>(&available_models_json)
            {
                if let Some(ocr_config) = available_models
                    .iter()
                    .find(|m| m.engine_type == engine_type.as_str())
                {
                    if let Some(config) = configs.iter().find(|c| c.id == ocr_config.config_id) {
                        return Ok(config.clone());
                    }
                }
            }
        }

        // 回退：尝试根据模型名称匹配
        let recommended_model = engine_type.recommended_model();
        if let Some(config) = configs
            .iter()
            .find(|c| c.model.contains(recommended_model) || recommended_model.contains(&c.model))
        {
            return Ok(config.clone());
        }

        // 最终回退：使用默认 OCR 模型配置
        self.get_ocr_model_config().await
    }

    /// OCR/题目集任务是否启用 VLM 推理（thinking）
    ///
    /// 默认关闭：OCR 和结构化任务不需要深度推理，关闭可显著降低延迟和成本。
    pub fn is_ocr_thinking_enabled(&self) -> bool {
        self.db
            .get_setting("ocr.enable_thinking")
            .ok()
            .flatten()
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false)
    }

    /// 获取当前配置的 OCR 引擎类型
    ///
    /// 默认按 FreeText 策略：OCR-VLM 引擎优先于通用 VLM。
    /// 回退到 `ocr.engine_type` 设置，最终默认 PaddleOCR-VL-1.5。
    pub async fn get_ocr_engine_type(&self) -> crate::ocr_adapters::OcrEngineType {
        use crate::ocr_adapters::OcrEngineType;

        let available = self.get_available_ocr_models().await;
        let mut enabled: Vec<&OcrModelConfig> = available.iter().filter(|m| m.enabled).collect();
        // FreeText 策略：专业 OCR 引擎优先
        enabled.sort_by_key(|m| {
            let engine = OcrEngineType::from_str(&m.engine_type);
            (if engine.is_dedicated_ocr() { 0u8 } else { 1 }, m.priority)
        });

        if let Some(first) = enabled.first() {
            return OcrEngineType::from_str(&first.engine_type);
        }

        // 回退到 legacy 设置
        let engine_str = self
            .db
            .get_setting("ocr.engine_type")
            .ok()
            .flatten()
            .unwrap_or_else(|| "paddle_ocr_vl".to_string());

        OcrEngineType::from_str(&engine_str)
    }

    /// 获取当前配置的 OCR 适配器
    ///
    /// 根据数据库配置返回对应的 OCR 适配器实例
    pub async fn get_ocr_adapter(&self) -> std::sync::Arc<dyn crate::ocr_adapters::OcrAdapter> {
        use crate::ocr_adapters::OcrAdapterFactory;

        let engine_type = self.get_ocr_engine_type().await;
        OcrAdapterFactory::create(engine_type)
    }

    /// S4/S7 fix: 获取 OCR 模型配置及其有效引擎类型
    ///
    /// 优先从 available_models 中查找匹配的引擎类型，
    /// 找不到时根据实际模型推断引擎类型，
    /// 确保 adapter/prompt/parser 三者始终与实际模型匹配。
    pub async fn get_ocr_config_with_effective_engine(
        &self,
    ) -> Result<(ApiConfig, crate::ocr_adapters::OcrEngineType)> {
        use crate::ocr_adapters::{OcrAdapterFactory, OcrEngineType};

        let config = self.get_ocr_model_config().await?;

        // 从 available_models 中查找该 config_id 对应的引擎类型
        let available = self.get_available_ocr_models().await;
        let effective_engine =
            if let Some(ocr_model) = available.iter().find(|m| m.config_id == config.id) {
                let declared = OcrEngineType::from_str(&ocr_model.engine_type);
                // 验证声明的引擎类型是否匹配实际模型
                if OcrAdapterFactory::validate_model_for_engine(&config.model, declared) {
                    declared
                } else {
                    OcrAdapterFactory::infer_engine_from_model(&config.model)
                }
            } else {
                // 回退配置，根据模型推断
                OcrAdapterFactory::infer_engine_from_model(&config.model)
            };

        debug!(
            "[OCR] effective engine={}, model={}",
            effective_engine.as_str(),
            config.model
        );

        Ok((config, effective_engine))
    }

    // 获取 Anki 制卡模型配置
    async fn get_anki_model_config(&self) -> Result<ApiConfig> {
        let assignments = self.get_model_assignments().await?;
        let anki_model_id = assignments
            .anki_card_model_config_id
            .ok_or_else(|| AppError::configuration("Anki制卡模型未配置"))?;

        let configs = self.get_api_configs().await?;
        // 注意：已分配的模型即使 enabled=false 也允许使用
        let config = configs
            .into_iter()
            .find(|c| c.id == anki_model_id)
            .ok_or_else(|| AppError::configuration("找不到有效的Anki制卡模型配置"))?;

        debug!(
            "找到 Anki 制卡模型配置: 模型={}, API地址={}",
            config.model, config.base_url
        );
        Ok(config)
    }

    /// 统一模型选择函数
    ///
    /// 参数：
    /// - task: 任务类型 ("default"|"review"|"chat_title"|"tag_generation")
    /// - override_id: 可选的覆盖模型ID
    /// - temperature: 可选的温度覆盖
    /// - top_p: 可选的 Top-P 覆盖
    /// - frequency_penalty: 可选的频率惩罚覆盖
    /// - presence_penalty: 可选的存在惩罚覆盖
    /// - max_output_tokens: 可选的最大输出 tokens 覆盖
    ///
    /// 返回：(ApiConfig, enable_cot)
    pub async fn select_model_for(
        &self,
        task: &str,
        override_id: Option<String>,
        temperature: Option<f32>,
        top_p: Option<f32>,
        frequency_penalty: Option<f32>,
        presence_penalty: Option<f32>,
        max_output_tokens: Option<u32>,
    ) -> Result<(ApiConfig, bool)> {
        // 如果有覆盖ID，使用覆盖配置
        // 注意：覆盖模型即使 enabled=false 也允许使用（用于历史消息重试等场景）
        if let Some(ref override_id) = override_id {
            let configs = self.get_api_configs().await?;
            let mut config = configs
                .into_iter()
                .find(|c| c.id == *override_id)
                .ok_or_else(|| {
                    AppError::configuration(format!("找不到可用的模型配置: {}", override_id))
                })?;

            // 应用参数覆盖
            if let Some(temp) = temperature {
                config.temperature = temp;
            }
            if let Some(max_tokens) = max_output_tokens {
                config.max_output_tokens = max_tokens;
            }
            config.top_p_override = top_p;
            config.frequency_penalty_override = frequency_penalty;
            config.presence_penalty_override = presence_penalty;

            let enable_cot = config.is_reasoning;
            return Ok((config, enable_cot));
        }

        // 根据任务类型选择模型
        let assignments = self.get_model_assignments().await?;
        let configs = self.get_api_configs().await?;

        let (model_id, enable_cot) = match task {
            "default" => {
                let model_id = assignments
                    .model2_config_id
                    .ok_or_else(|| AppError::configuration("对话模型未配置"))?;
                (model_id, true) // 默认启用CoT
            }
            "chat_title" | "tag_generation" => {
                let model_id = assignments
                    .chat_title_model_config_id
                    .or(assignments.model2_config_id)
                    .ok_or_else(|| AppError::configuration("没有配置可用的标题/标签生成模型"))?;
                (model_id, false)
            }
            "review" => {
                let model_id = assignments
                    .review_analysis_model_config_id
                    .ok_or_else(|| AppError::configuration("未配置回顾分析模型"))?;
                (model_id, true) // 回顾分析通常需要CoT
            }
            _ => {
                return Err(AppError::configuration(format!(
                    "不支持的任务类型: {}",
                    task
                )))
            }
        };

        // 注意：已分配的模型即使 enabled=false 也允许使用
        // enabled 仅影响模型选择器中的显示，不阻止已分配模型的调用
        let mut config = configs
            .into_iter()
            .find(|c| c.id == model_id)
            .ok_or_else(|| {
                AppError::configuration(format!("找不到可用的模型配置: {}", model_id))
            })?;

        // 应用参数覆盖
        if let Some(temp) = temperature {
            config.temperature = temp;
        }
        if let Some(max_tokens) = max_output_tokens {
            config.max_output_tokens = max_tokens;
        }
        config.top_p_override = top_p;
        config.frequency_penalty_override = frequency_penalty;
        config.presence_penalty_override = presence_penalty;

        // CoT策略：默认采用config.is_reasoning，但可以被任务特定逻辑覆盖
        let final_enable_cot = config.is_reasoning && enable_cot;

        Ok((config, final_enable_cot))
    }

    // 获取模型分配配置
    pub async fn get_model_assignments(&self) -> Result<ModelAssignments> {
        let assignments_str = self.db.get_setting("model_assignments")
            .map_err(|e| AppError::database(format!("获取模型分配配置失败: {}", e)))?
            .unwrap_or_else(|| r#"{"model2_config_id": null, "review_analysis_model_config_id": null, "anki_card_model_config_id": null, "qbank_ai_grading_model_config_id": null}"#.to_string());

        let assignments: ModelAssignments = serde_json::from_str(&assignments_str)
            .map_err(|e| AppError::configuration(format!("解析模型分配配置失败: {}", e)))?;

        Ok(assignments)
    }

    // 保存模型分配配置
    pub async fn save_model_assignments(&self, assignments: &ModelAssignments) -> Result<()> {
        let assignments_str = serde_json::to_string(assignments)
            .map_err(|e| AppError::configuration(format!("序列化模型分配配置失败: {}", e)))?;

        self.db
            .save_setting("model_assignments", &assignments_str)
            .map_err(|e| AppError::database(format!("保存模型分配配置失败: {}", e)))?;

        Ok(())
    }

    // 保存API配置（兼容旧调用，自动映射到供应商/模型）
    pub async fn save_api_configurations(&self, configs: &[ApiConfig]) -> Result<()> {
        self.bootstrap_vendor_model_config().await?;

        let mut plain_configs: Vec<ApiConfig> = configs
            .iter()
            .filter(|cfg| !cfg.is_builtin)
            .cloned()
            .collect();

        for cfg in &mut plain_configs {
            cfg.api_key = self.decrypt_api_key_if_needed(&cfg.api_key)?;
        }

        let (mut vendors, mut profiles) = self
            .flatten_api_configs_to_vendor_profiles(&plain_configs)
            .await?;

        vendors.retain(|v| !v.is_builtin);
        profiles.retain(|p| !p.is_builtin);

        self.save_vendor_model_configs(&vendors, &profiles).await
    }

    // 加密API密钥
    fn encrypt_api_key(&self, api_key: &str) -> Result<String> {
        // 如果已经是加密格式，直接返回
        if CryptoService::is_encrypted_format(api_key) {
            return Ok(api_key.to_string());
        }

        let encrypted_data = self
            .crypto_service
            .encrypt_api_key(api_key)
            .map_err(|e| AppError::configuration(format!("加密API密钥失败: {}", e)))?;

        serde_json::to_string(&encrypted_data)
            .map_err(|e| AppError::configuration(format!("序列化加密数据失败: {}", e)))
    }

    pub(crate) fn decrypt_api_key_if_needed(&self, api_key: &str) -> Result<String> {
        // 检查是否为加密格式
        if CryptoService::is_encrypted_format(api_key) {
            let encrypted_data: EncryptedData = serde_json::from_str(api_key)
                .map_err(|e| AppError::configuration(format!("解析加密数据失败: {}", e)))?;

            self.crypto_service
                .decrypt_api_key(&encrypted_data)
                .map_err(|e| AppError::configuration(format!("解密API密钥失败: {}", e)))
        } else {
            // 明文格式，迁移到加密格式（静默处理，避免日志噪音）
            Ok(api_key.to_string())
        }
    }

    /// 公开的 API Key 解密方法（供翻译模块等使用）
    pub fn decrypt_api_key(&self, api_key: &str) -> Result<String> {
        self.decrypt_api_key_if_needed(api_key)
    }
}
// ==================== Global singleton helper ====================
use std::sync::OnceLock;
// no extra traits needed for listen/unlisten

impl LLMManager {
    /// Get global singleton (constructed lazily with default Database & FileManager).
    /// This prevents multiple heavy clients and allows background jobs reuse.
    pub async fn global() -> anyhow::Result<Arc<LLMManager>> {
        static INSTANCE: OnceLock<Arc<LLMManager>> = OnceLock::new();

        if let Some(mgr) = INSTANCE.get() {
            return Ok(mgr.clone());
        }

        // 构造全局实例目前依赖较多组件，若未准备好直接返回错误
        Err(anyhow::anyhow!(
            "LLMManager::global is not yet implemented in this build"
        ))
    }

    /// 构建工具列表，包含本地工具和 MCP 工具
    async fn build_tools_with_mcp(&self, window: &Window) -> Value {
        // 本地工具定义（按开关动态广告）
        let mut tools_array = Vec::new();

        // 条件广告 web_search（仅由消息级选择控制）
        let selected_engines_list = self
            .db
            .get_setting("session.selected_search_engines")
            .ok()
            .flatten()
            .unwrap_or_default();
        let has_selected_engines = !selected_engines_list.trim().is_empty();

        // 调试信息：搜索引擎配置状态
        debug!(
            "[搜索引擎] 配置: {:?}, 工具可用: {}",
            selected_engines_list, has_selected_engines
        );

        if has_selected_engines {
            // 解析选中的搜索引擎列表
            let selected_engines: Vec<String> = selected_engines_list
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            // 构建 web_search 工具参数，动态注入引擎枚举约束
            let mut properties = json!({
                "query": { "type": "string", "description": "The web search query" },
                "top_k": { "type": "integer", "description": "Max results to return", "default": 5 },
                "site": { "type": "string", "description": "Optional site restriction (e.g., example.com)" },
                "time_range": { "type": "string", "description": "Optional time range: 1d|7d|30d" }
            });

            // 如果有多个引擎选中，添加engine参数的枚举约束
            if selected_engines.len() > 1 {
                properties["engine"] = json!({
                    "type": "string",
                    "enum": selected_engines,
                    "description": format!("Search engine to use. Available: {}", selected_engines.join(", "))
                });
            } else if selected_engines.len() == 1 {
                // 只有一个引擎时，不暴露engine参数，工具内部自动使用
                debug!(
                    "Single search engine selected: {}, engine parameter hidden",
                    selected_engines[0]
                );
            }

            tools_array.push(json!({
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "Search the INTERNET/WEB for current information, news, people, events, or any information not available in local knowledge base. Use this when users explicitly ask for web search or for real-time/current information.",
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": ["query"]
                    }
                }
            }));

            debug!(
                "[工具] web_search工具已成功添加到工具列表，选中引擎: {:?}",
                selected_engines
            );
        } else {
            debug!("[工具] web_search工具未添加：没有选中的搜索引擎");
        }

        // ===== MCP 工具广告（经由前端SDK桥接） =====
        let cache_ttl_ms: u64 = self
            .db
            .get_setting("mcp.performance.cache_ttl_ms")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300_000);
        let cache_ttl = Duration::from_millis(cache_ttl_ms);
        let namespace_prefix = self
            .db
            .get_setting("mcp.tools.namespace_prefix")
            .ok()
            .flatten()
            .unwrap_or_default();
        let advertise_all = self
            .db
            .get_setting("mcp.tools.advertise_all_tools")
            .ok()
            .flatten()
            .map(|v| v.to_lowercase())
            .map(|v| v != "0" && v != "false")
            .unwrap_or(false);
        let whitelist: Vec<String> = self
            .db
            .get_setting("mcp.tools.whitelist")
            .ok()
            .flatten()
            .map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| Vec::new());
        let blacklist: Vec<String> = self
            .db
            .get_setting("mcp.tools.blacklist")
            .ok()
            .flatten()
            .map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| Vec::new());
        let selected: Vec<String> = self
            .db
            .get_setting("session.selected_mcp_tools")
            .ok()
            .flatten()
            .map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| Vec::new());

        let mcp_tools = self.get_frontend_mcp_tools_cached(window, cache_ttl).await;
        let mut included_count = 0usize;
        for t in mcp_tools {
            let name = t.name.clone();
            // 选择/白黑名单策略
            let mut allowed = if !selected.is_empty() {
                selected.iter().any(|s| s == &name)
            } else if advertise_all {
                true
            } else if !whitelist.is_empty() {
                whitelist.iter().any(|s| s == &name)
            } else {
                // 默认不广告，除非被选择或白名单开启
                false
            };
            if !blacklist.is_empty() && blacklist.iter().any(|s| s == &name) {
                allowed = false;
            }
            if !allowed {
                continue;
            }

            let namespaced = if namespace_prefix.is_empty() {
                name
            } else {
                format!("{}{}", namespace_prefix, name)
            };

            tools_array.push(json!({
                "type": "function",
                "function": {
                    "name": namespaced,
                    "description": t.description.as_deref().unwrap_or(""),
                    "parameters": t.input_schema
                }
            }));
            included_count += 1;
        }
        debug!("[MCP] 已广告前端MCP工具 {} 个", included_count);

        debug!("[工具] 工具列表构建完成，总计 {} 个工具", tools_array.len());

        Value::Array(tools_array)
    }

    /// 获取 MCP 工具列表（使用 LLMManager 内部共享缓存）
    async fn get_frontend_mcp_tools_cached(
        &self,
        window: &Window,
        cache_ttl: Duration,
    ) -> Vec<FrontendMcpTool> {
        // 优先返回未过期缓存；若缓存为空则尝试强制刷新一次，避免"空缓存"导致长期不广告
        if let Some(cache) = self.mcp_tool_cache.read().await.as_ref() {
            if !cache.is_expired() {
                if !cache.tools.is_empty() {
                    return cache.tools.clone();
                }
                // 缓存未过期但为空：尝试刷新一次
            }
        }
        // 通过桥接请求工具
        let tools = match self
            .request_frontend_mcp_tools(window, Duration::from_millis(15_000))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!("MCP tools bridge failed: {}", e);
                vec![]
            }
        };
        let mut guard = self.mcp_tool_cache.write().await;
        *guard = Some(McpToolCache::new(tools.clone(), cache_ttl));
        tools
    }

    /// 公开：预热前端 MCP 工具清单缓存（供命令调用）
    pub async fn preheat_mcp_tools_public(&self, window: &Window) -> usize {
        let ttl_ms: u64 = self
            .db
            .get_setting("mcp.performance.cache_ttl_ms")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300_000);
        let tools = self
            .get_frontend_mcp_tools_cached(window, Duration::from_millis(ttl_ms))
            .await;
        tools.len()
    }

    async fn request_frontend_mcp_tools(
        &self,
        window: &Window,
        timeout: Duration,
    ) -> anyhow::Result<Vec<FrontendMcpTool>> {
        use tokio::sync::oneshot;
        use tokio::time::timeout as tokio_timeout;
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let event_name = format!("mcp-bridge-tools-response:{}", correlation_id);
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        let w = window.clone();
        let tx_guard = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let tx_guard_clone = tx_guard.clone();
        let id = w.listen(event_name.clone(), move |e| {
            // In Tauri v2, payload is provided as &str
            let payload_str = e.payload();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(payload_str) {
                if let Some(tx) = tx_guard_clone
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                {
                    let _ = tx.send(val);
                }
            }
        });
        // 发送请求
        window
            .emit(
                "mcp-bridge-tools-request",
                json!({"correlationId": correlation_id}),
            )
            .map_err(|e| anyhow::anyhow!("emit failed: {}", e))?;

        // 等待响应
        let waited = tokio_timeout(timeout, rx).await;
        // 清理监听器（不论成功失败）
        let _ = window.unlisten(id);
        let val = match waited {
            Err(_) => return Err(anyhow::anyhow!("timeout waiting tools response")),
            Ok(Err(_)) => return Err(anyhow::anyhow!("bridge channel closed")),
            Ok(Ok(v)) => v,
        };
        let arr = val.get("tools").cloned().unwrap_or(json!([]));
        let tools: Vec<FrontendMcpTool> =
            serde_json::from_value(arr).unwrap_or_else(|_| Vec::new());
        Ok(tools)
    }

    /// 清除 MCP 工具缓存（供外部调用）
    pub async fn clear_mcp_tool_cache(&self) {
        let mut cache_guard = self.mcp_tool_cache.write().await;
        *cache_guard = None;
        info!("MCP tool cache cleared");
    }

    /// 将 MCP 工具转换为 OpenAI 工具 schema
    fn frontend_mcp_tool_to_openai_schema(mcp_tool: &FrontendMcpTool) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": mcp_tool.name,
                "description": mcp_tool.description.as_deref().unwrap_or(""),
                "parameters": mcp_tool.input_schema
            }
        })
    }

    /// 将 OpenAI 格式的工具调用转换为内部 ToolCall 格式
    /// OpenAI 格式: {"id": "call_123", "type": "function", "function": {"name": "tool_name", "arguments": "{...}"}}
    /// 内部格式: ToolCall { id, tool_name, args_json }
    fn convert_openai_tool_call(
        tool_call_value: &Value,
    ) -> std::result::Result<crate::models::ToolCall, String> {
        // 尝试直接解析为内部格式（兼容旧格式）
        if let Ok(tc) = serde_json::from_value::<crate::models::ToolCall>(tool_call_value.clone()) {
            return Ok(tc);
        }

        // OpenAI 格式解析
        let id = tool_call_value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'id' field")?
            .to_string();

        let function = tool_call_value
            .get("function")
            .ok_or("Missing 'function' field")?;

        let tool_name = function
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'function.name' field")?
            .to_string();

        // 🔧 修复：某些 OpenAI 兼容 API 的 arguments 已是 JSON 对象而非字符串
        let arguments_value = function
            .get("arguments")
            .ok_or("Missing 'function.arguments' field")?;

        // 如果 arguments 已经是 JSON 对象/数组，直接使用
        if !arguments_value.is_string() {
            if arguments_value.is_object() || arguments_value.is_array() {
                log::debug!(
                    "[llm_manager] convert_openai_tool_call: arguments 已是 JSON 值 (tool={})",
                    tool_name
                );
                return Ok(crate::models::ToolCall {
                    id,
                    tool_name,
                    args_json: arguments_value.clone(),
                });
            }
            // null 或其他类型 → 空对象
            return Ok(crate::models::ToolCall {
                id,
                tool_name,
                args_json: Value::Object(serde_json::Map::new()),
            });
        }

        let arguments_str = arguments_value.as_str().unwrap_or("{}");

        // 兼容无参工具调用：部分模型会返回空字符串/空白字符串作为 arguments。
        // 这不是截断错误，应按空对象处理。
        if arguments_str.trim().is_empty() {
            return Ok(crate::models::ToolCall {
                id,
                tool_name,
                args_json: Value::Object(serde_json::Map::new()),
            });
        }

        // 解析 arguments 字符串为 JSON
        // 如果解析失败（常见于 LLM 输出被 max_tokens 截断），尝试修复截断的 JSON
        let args_json: Value = match serde_json::from_str(arguments_str) {
            Ok(v) => v,
            Err(e) => {
                // 检测是否为截断导致的 EOF 错误
                let err_msg = e.to_string();
                if err_msg.contains("EOF")
                    || err_msg.contains("unexpected end")
                    || err_msg.contains("trailing")
                {
                    log::warn!(
                        "[llm_manager] 工具调用 JSON 疑似被截断 (len={}), 尝试修复...",
                        arguments_str.len()
                    );
                    match Self::try_repair_truncated_json(arguments_str) {
                        Some(repaired) => {
                            log::info!(
                                "[llm_manager] 截断 JSON 修复成功: tool={}, original_len={}, repaired_len={}",
                                tool_name,
                                arguments_str.len(),
                                repaired.to_string().len()
                            );
                            repaired
                        }
                        None => {
                            return Err(format!(
                                "Failed to parse arguments JSON (truncated, repair failed): {}",
                                e
                            ));
                        }
                    }
                } else {
                    return Err(format!("Failed to parse arguments JSON: {}", e));
                }
            }
        };

        Ok(crate::models::ToolCall {
            id,
            tool_name,
            args_json,
        })
    }

    /// 尝试修复被截断的工具调用 JSON
    ///
    /// LLM 输出被 max_tokens 截断时，JSON 可能在任意位置中断。
    /// 策略：从截断位置开始回退，找到最后一个完整的键值对，然后补全缺失的括号。
    ///
    /// 支持修复的场景：
    /// - 对象/数组没有闭合（缺少 `}` 或 `]`）
    /// - 字符串值被截断（缺少 `"`）
    /// - 键值对写了一半（缺少 value）
    fn try_repair_truncated_json(truncated: &str) -> Option<Value> {
        let s = truncated.trim();
        if s.is_empty() {
            return None;
        }

        // 策略 1：直接补全括号
        // 扫描已有的 JSON，统计未闭合的 { 和 [ ，在末尾补上对应的 } 和 ]
        if let Some(repaired) = Self::repair_by_bracket_completion(s) {
            return Some(repaired);
        }

        // 策略 2：回退到最后一个完整的逗号/键值对边界，再补全括号
        // 从末尾向前找到最后一个 `,`、`}`、`]` 或完整的 `"key": value` 对
        if let Some(repaired) = Self::repair_by_truncation_rollback(s) {
            return Some(repaired);
        }

        log::warn!(
            "[llm_manager] 截断 JSON 修复失败，所有策略均未成功 (len={})",
            s.len()
        );
        None
    }

    /// 修复策略 1：补全缺失的括号
    fn repair_by_bracket_completion(s: &str) -> Option<Value> {
        // 扫描字符串，跟踪括号栈（忽略 JSON 字符串内部的括号）
        let mut stack: Vec<char> = Vec::new();
        let mut in_string = false;
        let mut escape_next = false;

        for ch in s.chars() {
            if escape_next {
                escape_next = false;
                continue;
            }
            if ch == '\\' && in_string {
                escape_next = true;
                continue;
            }
            if ch == '"' {
                in_string = !in_string;
                continue;
            }
            if in_string {
                continue;
            }
            match ch {
                '{' => stack.push('{'),
                '[' => stack.push('['),
                '}' => {
                    if stack.last() == Some(&'{') {
                        stack.pop();
                    }
                }
                ']' => {
                    if stack.last() == Some(&'[') {
                        stack.pop();
                    }
                }
                _ => {}
            }
        }

        if stack.is_empty() {
            // 括号已平衡，但可能有其他问题
            return serde_json::from_str(s).ok();
        }

        // 如果截断在字符串内部，先闭合字符串
        let mut repaired = s.to_string();
        if in_string {
            repaired.push('"');
        }

        // 处理末尾可能的不完整状态：
        // 去掉末尾的悬挂逗号、冒号、不完整的 key
        let trimmed = repaired.trim_end();
        let last_char = trimmed.chars().last().unwrap_or(' ');
        if last_char == ',' || last_char == ':' {
            repaired = trimmed[..trimmed.len() - 1].to_string();
        }

        // 补全缺失的括号（逆序闭合）
        for &bracket in stack.iter().rev() {
            match bracket {
                '{' => repaired.push('}'),
                '[' => repaired.push(']'),
                _ => {}
            }
        }

        match serde_json::from_str::<Value>(&repaired) {
            Ok(v) => {
                log::debug!(
                    "[llm_manager] 截断 JSON 修复成功（策略1：补全括号）, stack_depth={}",
                    stack.len()
                );
                Some(v)
            }
            Err(_) => None,
        }
    }

    /// 修复策略 2：回退到最后一个完整边界后补全
    fn repair_by_truncation_rollback(s: &str) -> Option<Value> {
        // 从末尾开始，逐步截断，直到找到一个可以通过补全括号修复的位置
        // 尝试几个常见的截断回退点
        let rollback_targets = [',', '}', ']', '\n'];

        for &target in &rollback_targets {
            if let Some(pos) = s.rfind(target) {
                let candidate = if target == ',' {
                    // 在逗号处截断：去掉逗号后的部分
                    &s[..pos]
                } else {
                    // 在 } ] 换行处截断：保留到该字符
                    &s[..=pos]
                };

                if let Some(repaired) = Self::repair_by_bracket_completion(candidate) {
                    log::debug!(
                        "[llm_manager] 截断 JSON 修复成功（策略2：回退到 '{}' pos={}）",
                        target,
                        pos
                    );
                    return Some(repaired);
                }
            }
        }

        None
    }

    fn coalesce_injection_texts(texts: &[String]) -> Option<String> {
        if texts.is_empty() {
            return None;
        }
        let per_item_max = 1600usize;
        let total_max = 20_000usize;
        let mut acc = String::new();
        for (idx, text) in texts.iter().enumerate() {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut chunk = trimmed.to_string();
            let original_len = chunk.chars().count();
            if original_len > per_item_max {
                chunk = chunk.chars().take(per_item_max).collect();
                debug!(
                    "  [{}] 注入段超限，截断 {} -> {} 字符",
                    idx,
                    original_len,
                    chunk.chars().count()
                );
            }
            if acc.chars().count() + chunk.chars().count() > total_max {
                debug!(
                    "  [{}] 注入总量已达上限，停止继续追加（当前 {} 字符）",
                    idx,
                    acc.chars().count()
                );
                break;
            }
            debug!(
                "  [{}] 收录注入段，长度 {} 字符",
                idx,
                chunk.chars().count()
            );
            acc.push_str(&chunk);
        }
        if acc.is_empty() {
            None
        } else {
            debug!("[Inject] 合并注入文本总长度: {} 字符", acc.chars().count());
            debug!(
                "[Inject] 注入预览: {}",
                &acc.chars().take(200).collect::<String>()
            );
            Some(acc)
        }
    }

    fn append_injection_to_system_message(messages: &mut Vec<Value>, inject_content: &str) {
        if inject_content.trim().is_empty() {
            warn!("[Inject] 注入内容为空，跳过");
            return;
        }
        if let Some(first_msg) = messages.get_mut(0) {
            if first_msg["role"] == "system" {
                let current_content = first_msg["content"].as_str().unwrap_or("");
                first_msg["content"] =
                    json!(format!("{}\n\n{}", current_content, inject_content.trim()));
                debug!("[Inject] 已将注入文本追加到现有系统消息");
                return;
            }
        }
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": inject_content.trim()
            }),
        );
        debug!("[Inject] 未找到系统消息，已创建新的系统消息承载注入内容");
    }

    /// 构建图谱检索结果的注入文本
    ///
    /// 支持两种数据格式：
    /// - 旧格式（RagSourceInfo）：`file_name`, `chunk_text`
    /// - 新格式（SourceInfo from Chat V2）：`title`, `snippet`
    fn build_prefetched_graph_injection(context: &HashMap<String, Value>) -> Option<String> {
        let prefetched = context
            .get("prefetched_graph_sources")
            .and_then(|v| v.as_array())?;
        if prefetched.is_empty() {
            return None;
        }
        let mut rows = Vec::new();
        for (idx, item) in prefetched.iter().enumerate() {
            // 兼容两种字段名格式：file_name/title, chunk_text/snippet
            let title = item
                .get("file_name")
                .or_else(|| item.get("title"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Graph Insight");
            let snippet = item
                .get("chunk_text")
                .or_else(|| item.get("snippet"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if snippet.trim().is_empty() {
                continue;
            }
            rows.push(format!("({}) {}\n{}", idx + 1, title, snippet));
            if rows.len() >= 5 {
                break;
            }
        }
        if rows.is_empty() {
            None
        } else {
            Some(format!("【个人图谱】\n{}\n\n", rows.join("\n\n")))
        }
    }

    /// P2-3: 调用 LLM 解析文档内容为题目
    pub async fn call_llm_for_question_parsing(&self, prompt: &str) -> Result<String> {
        // 默认使用模型二配置（第一模型已废弃）
        let api_config = self.get_model2_config().await?;

        // 解密 API Key
        let api_key = self.decrypt_api_key_if_needed(&api_config.api_key)?;

        // 获取模型 ID
        let model_id = api_config.model.clone();

        // 构建请求
        let messages = vec![
            json!({
                "role": "system",
                "content": "你是一个专业的题目解析助手。请准确识别文档中的题目，并按指定格式输出。"
            }),
            json!({
                "role": "user",
                "content": prompt
            }),
        ];

        let request_body = json!({
            "model": model_id,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 4096
        });

        // 发送请求
        let response = self
            .client
            .post(format!(
                "{}/chat/completions",
                api_config.base_url.trim_end_matches('/')
            ))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("LLM 请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::network(format!(
                "LLM 响应错误 {}: {}",
                status, error_text
            )));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::validation(format!("解析 LLM 响应失败: {}", e)))?;

        // 提取响应内容
        let content = response_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| AppError::validation("LLM 响应格式错误"))?;

        Ok(content.to_string())
    }

    /// 流式调用 LLM 解析题目，每解析出一道题目立即通过回调返回
    /// callback 返回 false 则中止流
    pub async fn call_llm_for_question_parsing_streaming<F>(
        &self,
        prompt: &str,
        model_config_id: Option<&str>,
        mut on_question: F,
    ) -> Result<Vec<Value>>
    where
        F: FnMut(Value) -> bool + Send,
    {
        let api_config = if let Some(config_id) = model_config_id {
            let configs = self.get_api_configs().await?;
            configs
                .into_iter()
                .find(|c| c.id == config_id)
                .ok_or_else(|| {
                    AppError::configuration(format!("找不到指定的模型配置: {}", config_id))
                })?
        } else {
            self.get_model2_config().await?
        };

        let api_key = self.decrypt_api_key_if_needed(&api_config.api_key)?;
        let model_id = api_config.model.clone();

        let messages = vec![
            json!({
                "role": "system",
                "content": "你是一个专业的题目解析助手。请准确识别文档中的题目，并按指定格式输出。"
            }),
            json!({
                "role": "user",
                "content": prompt
            }),
        ];

        let request_body = json!({
            "model": model_id,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 8192,
            "stream": true
        });

        let response = self
            .client
            .post(format!(
                "{}/chat/completions",
                api_config.base_url.trim_end_matches('/')
            ))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("LLM 流式请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::network(format!(
                "LLM 响应错误 {}: {}",
                status, error_text
            )));
        }

        // 流式解析
        let mut stream = response.bytes_stream();
        let mut sse_buffer = crate::utils::sse_buffer::SseLineBuffer::new();

        // 根据 provider_type 选择适配器
        let provider = api_config.provider_type.as_deref().unwrap_or("openai");
        let adapter: Box<dyn crate::providers::ProviderAdapter> =
            match provider.to_lowercase().as_str() {
                "google" | "gemini" => Box::new(crate::providers::GeminiAdapter::new()),
                "anthropic" | "claude" => Box::new(crate::providers::AnthropicAdapter::new()),
                _ => Box::new(crate::providers::OpenAIAdapter),
            };

        let mut full_content = String::new();
        let mut all_questions: Vec<Value> = Vec::new();
        let mut json_parser = IncrementalJsonArrayParser::new();
        let mut stream_ended = false;
        let mut aborted = false;

        while !stream_ended && !aborted {
            let next_item = stream.next().await;
            let Some(next) = next_item else { break };

            let chunk = match next {
                Ok(b) => b,
                Err(e) => return Err(AppError::llm(format!("读取流式响应失败: {}", e))),
            };

            let text = String::from_utf8_lossy(&chunk);
            let lines = sse_buffer.process_chunk(&text);

            for line in lines {
                if crate::utils::sse_buffer::SseLineBuffer::check_done_marker(&line) {
                    stream_ended = true;
                    break;
                }
                let events = adapter.parse_stream(&line);
                for ev in events {
                    match ev {
                        crate::providers::StreamEvent::ContentChunk(s) => {
                            full_content.push_str(&s);
                            // 增量解析 JSON 数组
                            if let Some(questions) = json_parser.feed(&s) {
                                for q in questions {
                                    if !on_question(q.clone()) {
                                        aborted = true;
                                        break;
                                    }
                                    all_questions.push(q);
                                }
                            }
                        }
                        crate::providers::StreamEvent::Done => {
                            stream_ended = true;
                            break;
                        }
                        _ => {}
                    }
                    if aborted {
                        break;
                    }
                }
                if stream_ended || aborted {
                    break;
                }
            }
        }

        // 处理剩余未解析的内容
        if !aborted {
            if let Some(questions) = json_parser.finalize() {
                for q in questions {
                    if on_question(q.clone()) {
                        all_questions.push(q);
                    }
                }
            }
        }

        Ok(all_questions)
    }

    pub async fn call_llm_for_question_parsing_with_model(
        &self,
        prompt: &str,
        model_config_id: Option<&str>,
    ) -> Result<String> {
        let api_config = if let Some(config_id) = model_config_id {
            let configs = self.get_api_configs().await?;
            configs
                .into_iter()
                .find(|c| c.id == config_id)
                .ok_or_else(|| {
                    AppError::configuration(format!("找不到指定的模型配置: {}", config_id))
                })?
        } else {
            self.get_model2_config().await?
        };

        let api_key = self.decrypt_api_key_if_needed(&api_config.api_key)?;
        let model_id = api_config.model.clone();

        let messages = vec![
            json!({
                "role": "system",
                "content": "你是一个专业的题目解析助手。请准确识别文档中的题目，并按指定格式输出。"
            }),
            json!({
                "role": "user",
                "content": prompt
            }),
        ];

        let request_body = json!({
            "model": model_id,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 4096
        });

        let response = self
            .client
            .post(format!(
                "{}/chat/completions",
                api_config.base_url.trim_end_matches('/')
            ))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("LLM 请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::network(format!(
                "LLM 响应错误 {}: {}",
                status, error_text
            )));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| AppError::validation(format!("解析 LLM 响应失败: {}", e)))?;

        let content = response_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| AppError::validation("LLM 响应格式错误"))?;

        Ok(content.to_string())
    }
}
