//! 模型 API 配置（拆分前位于 `llm_manager::ApiConfig`，`llm_manager` 仍按原路径重导出）。
//!
//! 放在最底层 crate，是因为 `models`、`database` 等底层模块也持有它；
//! 字段、serde 属性与默认值与拆分前逐字一致，持久化与前端看到的 JSON 不变。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

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
    #[serde(default)]
    pub provider_scope: Option<String>,
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub api_protocol: Option<String>,
    #[serde(default)]
    pub supports_openai_responses: Option<bool>,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub is_multimodal: bool,
    pub is_reasoning: bool,
    pub is_embedding: bool,
    pub is_reranker: bool,
    #[serde(default)]
    pub is_image_generation: bool,
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
    /// GPT-5.6 Responses API reasoning.mode (standard/pro)
    #[serde(default)]
    pub reasoning_mode: Option<String>,
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
    /// 模型上下文窗口大小（tokens），用于前端/Chat V2 预算，不作为 API 参数发送
    #[serde(default, alias = "context_window")]
    pub context_window: Option<u32>,
    /// 2C 自定义请求体扩展（采纳 operit ModelParameter 逃生口思路）。
    ///
    /// 用户在设置 UI 上以 key-value 形式声明的额外字段，会被原样合并进
    /// 最终发送到 API 的请求体。用于塞进任何 LLM 方言 / 未来新出的参数，
    /// 而不需要硬编码到 `RequestAdapter`。
    ///
    /// 安全约束：合并发生在 `apply_common_params` 末尾，已存在的标准字段
    /// （model/messages/stream/temperature 等）**不会**被这里覆盖 ——
    /// 只有当 key 在 body 中尚不存在时才会插入。
    #[serde(default)]
    pub extra_body: Option<serde_json::Map<String, Value>>,
    /// 渠道并行思考强度（方案 D）：`get_adapter` 解析出的适配器 id。
    ///
    /// 只随 `get_api_configurations` 下发给前端做渠道查找（前端不再靠模型名猜渠道），
    /// 不参与反序列化与持久化——每次读取时由命令层重算，存量存储无需迁移。
    #[serde(default, skip_deserializing)]
    pub resolved_adapter_id: Option<String>,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            vendor_id: None,
            vendor_name: None,
            provider_type: None,
            provider_scope: None,
            auth_mode: None,
            api_protocol: None,
            supports_openai_responses: None,
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            is_multimodal: false,
            is_reasoning: false,
            is_embedding: false,
            is_reranker: false,
            is_image_generation: false,
            enabled: false,
            model_adapter: default_model_adapter(),
            max_output_tokens: default_max_output_tokens(),
            temperature: default_temperature(),
            supports_tools: false,
            gemini_api_version: default_gemini_api_version(),
            is_builtin: false,
            is_read_only: false,
            reasoning_effort: None,
            reasoning_mode: None,
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
            context_window: None,
            extra_body: None,
            resolved_adapter_id: None,
        }
    }
}

// 默认值函数
pub fn default_model_adapter() -> String {
    "general".to_string()
}

pub fn default_max_output_tokens() -> u32 {
    8192
}

pub fn default_temperature() -> f32 {
    0.7
}

pub fn default_gemini_api_version() -> String {
    "v1".to_string()
}
