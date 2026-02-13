//! 请求适配器模块
//!
//! 提供可扩展的子适配器系统，用于处理不同 LLM 供应商的请求参数差异。
//! 每个供应商可以有自己的适配器，处理特定的参数格式和限制。
//!
//! ## 架构
//! - `RequestAdapter` trait: 定义适配器接口
//! - `AdapterRegistry`: 注册表，通过 provider_type 查找适配器
//! - 具体适配器: 实现特定供应商的参数处理逻辑
//!
//! ## 使用方式
//! ```ignore
//! let adapter = get_adapter("minimax");
//! adapter.apply_reasoning_config(&mut body, &config, enable_thinking);
//! ```

mod anthropic;
mod deepseek;
mod doubao;
mod ernie;
mod gemini;
mod generic_openai;
mod grok;
mod minimax;
mod mistral;
mod moonshot;
mod qwen;
mod zhipu;

pub use anthropic::AnthropicAdapter;
pub use deepseek::DeepSeekAdapter;
pub use doubao::DoubaoAdapter;
pub use ernie::ErnieAdapter;
pub use gemini::GeminiAdapter;
pub use generic_openai::GenericOpenAIAdapter;
pub use grok::GrokAdapter;
pub use minimax::MiniMaxAdapter;
pub use mistral::MistralAdapter;
pub use moonshot::MoonshotAdapter;
pub use qwen::QwenAdapter;
pub use zhipu::ZhipuAdapter;

use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

/// 请求适配器 Trait
///
/// 定义了 LLM 请求体适配的标准接口。不同供应商可以实现此 trait
/// 来处理其特定的参数格式和限制。
/// 适配器元数据，用于前端显示
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdapterInfo {
    pub value: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

pub trait RequestAdapter: Send + Sync {
    /// 适配器标识符
    fn id(&self) -> &'static str;

    /// 适配器显示名称
    fn label(&self) -> &'static str {
        self.id()
    }

    /// 适配器描述
    fn description(&self) -> &'static str {
        "Generic request adapter"
    }

    /// 获取适配器元数据
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            value: self.id(),
            label: self.label(),
            description: self.description(),
        }
    }

    /// 应用推理相关配置到请求体
    ///
    /// # 参数
    /// - `body`: 请求体 JSON Map（会被就地修改）
    /// - `config`: API 配置
    /// - `enable_thinking`: 外部传入的 enable_thinking 覆盖值
    ///
    /// # 返回
    /// - `true` 表示提前返回，跳过后续通用参数处理
    /// - `false` 表示继续处理通用参数
    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool;

    /// 是否应该移除采样参数（temperature, top_p, logprobs）
    ///
    /// 某些推理模型（如 OpenAI o 系列）不支持这些参数
    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        config.is_reasoning || config.supports_reasoning
    }

    /// 使用工具调用时是否应该禁用 thinking
    ///
    /// 某些模型（如 DeepSeek V3.1）在使用函数调用时需要禁用思维模式
    fn should_disable_thinking_for_tools(
        &self,
        _config: &ApiConfig,
        _body: &Map<String, Value>,
    ) -> bool {
        false
    }

    /// 应用通用参数（min_p, top_k, repetition_penalty 等）
    ///
    /// 默认实现，子类可以覆盖以自定义行为
    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("repetition_penalty".to_string(), json!(rep_penalty));
        }
        if let Some(reasoning_split) = config.reasoning_split {
            body.insert("reasoning_split".to_string(), json!(reasoning_split));
        }
        if let Some(ref effort) = config.effort {
            body.insert("effort".to_string(), json!(effort));
        }
        if let Some(ref verbosity) = config.verbosity {
            body.insert("verbosity".to_string(), json!(verbosity));
        }
    }

    // ============ 第三阶段扩展接口 ============

    /// 获取思维链回传策略
    ///
    /// 不同供应商有不同的思维链回传格式：
    /// - `DeepSeekStyle`: reasoning_content 字段（DeepSeek, Qwen, Kimi）
    /// - `ReasoningDetails`: reasoning_details 数组（MiniMax）
    /// - `NoPassback`: 不回传思维链
    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        if config.is_reasoning || config.supports_reasoning {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }

    /// 格式化工具调用消息
    ///
    /// 某些供应商（如 Anthropic）对工具调用消息有特殊格式要求
    /// 例如 Anthropic 要求 thinking 块在 tool_use 块之前
    ///
    /// 默认实现返回 None，表示使用标准格式
    fn format_tool_call_message(
        &self,
        _tool_calls: &[Value],
        _thinking_content: Option<&str>,
    ) -> Option<Value> {
        None
    }

    /// 检查模型是否需要特殊的历史消息格式
    ///
    /// 某些模型（如 Anthropic with thinking）需要在历史消息中保留 thinking 块
    fn requires_thinking_in_history(&self, _config: &ApiConfig) -> bool {
        false
    }
}

/// 思维链回传策略
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassbackPolicy {
    /// DeepSeek 风格：reasoning_content 字段
    DeepSeekStyle,
    /// MiniMax 风格：reasoning_details 数组
    ReasoningDetails,
    /// 不回传思维链
    NoPassback,
}

/// 适配器注册表
///
/// 存储所有已注册的适配器，通过 provider_type 或 model_adapter 查找
static ADAPTER_REGISTRY: LazyLock<HashMap<&'static str, Box<dyn RequestAdapter>>> =
    LazyLock::new(|| {
        let mut m: HashMap<&'static str, Box<dyn RequestAdapter>> = HashMap::new();

        // 注册所有适配器
        // 通用 OpenAI 兼容（默认）
        m.insert("openai", Box::new(GenericOpenAIAdapter));
        m.insert("general", Box::new(GenericOpenAIAdapter));
        m.insert("siliconflow", Box::new(GenericOpenAIAdapter)); // SiliconFlow 使用通用适配器

        // 国产模型供应商（专用适配器）
        m.insert("minimax", Box::new(MiniMaxAdapter));
        m.insert("deepseek", Box::new(DeepSeekAdapter));
        m.insert("qwen", Box::new(QwenAdapter));
        m.insert("zhipu", Box::new(ZhipuAdapter));
        m.insert("doubao", Box::new(DoubaoAdapter));
        m.insert("moonshot", Box::new(MoonshotAdapter));
        m.insert("kimi", Box::new(MoonshotAdapter)); // kimi 别名
        m.insert("ernie", Box::new(ErnieAdapter));
        m.insert("baidu", Box::new(ErnieAdapter)); // baidu 别名

        // 海外供应商
        m.insert("anthropic", Box::new(AnthropicAdapter));
        m.insert("claude", Box::new(AnthropicAdapter));
        m.insert("google", Box::new(GeminiAdapter));
        m.insert("gemini", Box::new(GeminiAdapter));
        m.insert("xai", Box::new(GrokAdapter));
        m.insert("grok", Box::new(GrokAdapter));
        m.insert("mistral", Box::new(MistralAdapter));

        m
    });

/// 默认适配器（当找不到匹配时使用）
static DEFAULT_ADAPTER: LazyLock<Box<dyn RequestAdapter>> =
    LazyLock::new(|| Box::new(GenericOpenAIAdapter));

/// 聚合平台列表（这些平台托管多个供应商的模型，不应作为适配器选择依据）
const AGGREGATOR_PLATFORMS: &[&str] =
    &["siliconflow", "openrouter", "together", "fireworks", "groq"];

/// 检查是否是聚合平台
fn is_aggregator_platform(provider_type: &str) -> bool {
    AGGREGATOR_PLATFORMS.contains(&provider_type)
}

/// 获取适配器
///
/// # 查找顺序
/// 1. 如果 `provider_type` 不是聚合平台，尝试通过它查找
/// 2. 否则使用 `model_adapter` 查找（前端推断引擎预设的值）
/// 3. 都找不到则返回默认适配器
///
/// # 参数
/// - `provider_type`: 供应商类型（如 "minimax", "deepseek", "siliconflow"）
/// - `model_adapter`: 模型适配器类型（前端推断引擎预设，如 "minimax", "deepseek"）
///
/// # 注意
/// 聚合平台（siliconflow 等）托管多个供应商的模型，不应作为适配器选择依据。
/// 对于聚合平台，应使用前端推断引擎预设的 `model_adapter` 字段。
pub fn get_adapter(
    provider_type: Option<&str>,
    model_adapter: &str,
) -> &'static dyn RequestAdapter {
    // 优先使用 provider_type（但跳过聚合平台）
    if let Some(pt) = provider_type {
        let pt_lower = pt.to_lowercase();
        // 聚合平台不作为适配器选择依据，跳过
        if !is_aggregator_platform(&pt_lower) {
            if let Some(adapter) = ADAPTER_REGISTRY.get(pt_lower.as_str()) {
                return adapter.as_ref();
            }
        }
    }

    // 使用 model_adapter（前端推断引擎预设的值）
    let ma_lower = model_adapter.to_lowercase();
    ADAPTER_REGISTRY
        .get(ma_lower.as_str())
        .map(|a| a.as_ref())
        .unwrap_or(DEFAULT_ADAPTER.as_ref())
}

/// 获取所有已注册的适配器 ID
pub fn list_adapters() -> Vec<&'static str> {
    ADAPTER_REGISTRY.keys().copied().collect()
}

/// 获取所有已注册的适配器信息（用于前端显示）
///
/// 返回去重后按优先级排序的适配器列表
/// 注意：ADAPTER_REGISTRY 中有别名（如 kimi -> moonshot），需要按 id() 去重
pub fn list_adapter_infos() -> Vec<AdapterInfo> {
    use std::collections::HashSet;

    // 定义显示顺序（主 ID，不含别名）
    let order = [
        "general",
        "google",
        "anthropic",
        "mistral",
        "deepseek",
        "qwen",
        "zhipu",
        "doubao",
        "ernie",
        "moonshot",
        "grok",
        "minimax",
    ];

    let mut seen = HashSet::new();
    let mut infos: Vec<AdapterInfo> = ADAPTER_REGISTRY
        .values()
        .filter_map(|adapter| {
            let id = adapter.id();
            // 按 id 去重，只保留第一个
            if seen.insert(id) {
                Some(adapter.info())
            } else {
                None
            }
        })
        .collect();

    // 按定义的顺序排序
    infos.sort_by_key(|info| order.iter().position(|&k| k == info.value).unwrap_or(999));

    infos
}

/// 辅助函数：计算 enable_thinking 的最终值
///
/// 优先级：外部传入 > 配置中的 enable_thinking > thinking_enabled
pub fn resolve_enable_thinking(config: &ApiConfig, override_value: Option<bool>) -> bool {
    override_value
        .or(config.enable_thinking)
        .unwrap_or(config.thinking_enabled)
}

/// 辅助函数：获取 trimmed reasoning_effort
pub fn get_trimmed_effort(config: &ApiConfig) -> Option<&str> {
    config
        .reasoning_effort
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_adapter_by_provider_type() {
        let adapter = get_adapter(Some("minimax"), "openai");
        assert_eq!(adapter.id(), "minimax");
    }

    #[test]
    fn test_get_adapter_by_model_adapter() {
        let adapter = get_adapter(None, "anthropic");
        assert_eq!(adapter.id(), "anthropic");
    }

    #[test]
    fn test_get_adapter_fallback_to_default() {
        let adapter = get_adapter(None, "unknown");
        assert_eq!(adapter.id(), "openai");
    }

    #[test]
    fn test_list_adapters() {
        let adapters = list_adapters();
        assert!(adapters.contains(&"minimax"));
        assert!(adapters.contains(&"openai"));
        assert!(adapters.contains(&"anthropic"));
    }

    #[test]
    fn test_get_ernie_adapter() {
        let adapter = get_adapter(Some("ernie"), "openai");
        assert_eq!(adapter.id(), "ernie");
    }

    #[test]
    fn test_get_ernie_adapter_by_baidu_alias() {
        let adapter = get_adapter(Some("baidu"), "openai");
        assert_eq!(adapter.id(), "ernie");
    }
}
