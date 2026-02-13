//! 通用 OpenAI 兼容适配器
//!
//! 处理标准 OpenAI API 兼容的请求参数。
//! 适用于 OpenAI 官方 API（GPT-5.2+）及兼容供应商。
//!
//! ## Chat Completions API 参数格式 (2026)
//! - `reasoning_effort`: none | minimal | low | medium | high | xhigh（**顶级参数**）
//! - `verbosity`: low | medium | high（**顶级参数**）
//! - temperature/top_p 仅在 `reasoning_effort="none"` 时支持，其他值会**报错**
//!
//! ## 注意：Chat Completions API vs Responses API
//! - Chat Completions API 使用顶级参数：`reasoning_effort`, `verbosity`
//! - Responses API 使用嵌套格式：`reasoning: { effort }`, `text: { verbosity }`
//! - 本适配器使用 Chat Completions API 格式
//!
//! 参考文档：https://platform.openai.com/docs/api-reference/chat

use super::{get_trimmed_effort, resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 通用 OpenAI 兼容适配器
///
/// 处理标准 OpenAI Chat Completions API 格式的推理参数：
/// - `reasoning_effort`: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"（顶级参数）
/// - `verbosity`: "low" | "medium" | "high"（顶级参数）
/// - `enable_thinking`: 启用思维链（兼容其他 OpenAI 兼容供应商）
/// - `thinking_budget`: 思维 token 预算
pub struct GenericOpenAIAdapter;

impl GenericOpenAIAdapter {
    /// 验证 reasoning_effort 值是否有效
    fn is_valid_effort(effort: &str) -> bool {
        matches!(
            effort.to_lowercase().as_str(),
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "unset"
        )
    }

    /// 检查是否需要移除采样参数
    ///
    /// GPT-5.2: temperature/top_p 仅在 reasoning_effort="none" 时支持
    ///
    /// ## 优先级规则
    /// 1. 如果显式设置了 `reasoning_effort`：
    ///    - `reasoning_effort="none"` → **保留**采样参数（用户明确想禁用推理）
    ///    - 其他值 → **移除**采样参数（推理模式不支持）
    /// 2. 如果没有设置 `reasoning_effort`：
    ///    - `is_reasoning || supports_reasoning` → **移除**采样参数
    fn should_remove_sampling_for_reasoning(config: &ApiConfig) -> bool {
        if let Some(ref effort) = config.reasoning_effort {
            let trimmed = effort.trim().to_lowercase();
            if !trimmed.is_empty() {
                // 用户显式设置了 reasoning_effort
                // "none" 或 "unset" 表示禁用推理，应保留采样参数
                if trimmed == "none" || trimmed == "unset" {
                    return false; // 保留采样参数
                }
                // 非法值不应触发移除采样参数
                if !Self::is_valid_effort(&trimmed) {
                    log::warn!(
                        "[GenericOpenAIAdapter] Invalid reasoning_effort: {}. Keeping sampling params.",
                        trimmed
                    );
                    return false;
                }
                // 其他有效值表示启用推理，应移除采样参数
                return true;
            }
        }
        // 没有显式设置 reasoning_effort 时，使用原有逻辑
        config.is_reasoning || config.supports_reasoning
    }
}

impl RequestAdapter for GenericOpenAIAdapter {
    fn id(&self) -> &'static str {
        "general"
    }

    fn label(&self) -> &'static str {
        "通用模型"
    }

    fn description(&self) -> &'static str {
        "适用于大多数 OpenAI 兼容 API（如 GPT、通义千问等）"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        let mut early_return = false;

        // Chat Completions API: temperature/top_p 仅在 reasoning_effort="none" 时支持
        // 其他 reasoning_effort 值会导致 API 报错（不是被忽略）
        if Self::should_remove_sampling_for_reasoning(config) {
            body.remove("temperature");
            body.remove("top_p");
            body.remove("logprobs");
        }

        // 处理 reasoning_effort（Chat Completions API 使用顶级参数）
        // 注意：reasoning_effort 和 enable_thinking 是互斥的
        // - OpenAI 官方 Chat Completions API 使用 reasoning_effort（顶级参数）
        // - 其他 OpenAI 兼容供应商使用 enable_thinking
        let has_reasoning_effort = get_trimmed_effort(config).is_some();

        if has_reasoning_effort {
            // OpenAI 官方 Chat Completions API 格式：使用顶级参数
            if let Some(effort) = get_trimmed_effort(config) {
                let normalized = effort.to_lowercase();
                if normalized == "none" || normalized == "unset" {
                    // "none" 或 "unset" 时不添加 reasoning_effort 参数
                    body.remove("reasoning_effort");
                    body.remove("reasoning"); // 清理可能存在的嵌套格式
                    early_return = true;
                } else if Self::is_valid_effort(effort) {
                    // Chat Completions API: 使用顶级 reasoning_effort 参数
                    body.insert("reasoning_effort".to_string(), json!(normalized));
                }
            }

            // Chat Completions API: verbosity 是顶级参数
            if let Some(ref verbosity) = config.verbosity {
                let v = verbosity.trim().to_lowercase();
                if !v.is_empty() && matches!(v.as_str(), "low" | "medium" | "high") {
                    body.insert("verbosity".to_string(), json!(v));
                }
            }
        } else if config.supports_reasoning {
            // OpenAI 兼容供应商格式（enable_thinking）
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
            body.insert("enable_thinking".to_string(), json!(enable_thinking_value));

            if let Some(budget) = config.thinking_budget {
                let sanitized = budget.max(0);
                body.insert("thinking_budget".to_string(), json!(sanitized));
            }

            if config.include_thoughts {
                body.insert("include_thoughts".to_string(), json!(true));
            }
        }

        early_return
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        Self::should_remove_sampling_for_reasoning(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_config(supports_reasoning: bool, is_reasoning: bool) -> ApiConfig {
        ApiConfig {
            supports_reasoning,
            is_reasoning,
            thinking_enabled: true,
            thinking_budget: Some(4096),
            include_thoughts: true,
            ..Default::default()
        }
    }

    #[test]
    fn test_apply_reasoning_config_with_reasoning() {
        let adapter = GenericOpenAIAdapter;
        let config = create_test_config(true, false);
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("enable_thinking"));
        assert!(body.contains_key("thinking_budget"));
        assert!(body.contains_key("include_thoughts"));
        // supports_reasoning 时移除 temperature
        assert!(!body.contains_key("temperature"));
    }

    #[test]
    fn test_remove_sampling_params_for_reasoning_model() {
        let adapter = GenericOpenAIAdapter;
        let config = create_test_config(false, true);
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("temperature"));
        assert!(!body.contains_key("top_p"));
    }

    #[test]
    fn test_xhigh_reasoning_effort() {
        // Chat Completions API: reasoning_effort 是顶级参数
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("xhigh".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该是顶级参数，不是嵌套的 reasoning.effort
        assert_eq!(body.get("reasoning_effort"), Some(&json!("xhigh")));
        assert!(!body.contains_key("reasoning"));
    }

    #[test]
    fn test_verbosity_parameter() {
        // Chat Completions API: verbosity 是顶级参数
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()), // 需要有 reasoning_effort 才会处理 verbosity
            verbosity: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该是顶级参数，不是嵌套的 text.verbosity
        assert_eq!(body.get("verbosity"), Some(&json!("high")));
        assert!(!body.contains_key("text"));
    }

    #[test]
    fn test_temperature_removed_when_reasoning_medium() {
        // reasoning_effort 非 "none" 时必须移除采样参数（避免 API 报错）
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("medium".to_string()),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // reasoning_effort 非 "none" 时移除采样参数
        assert!(!body.contains_key("temperature"));
        assert!(!body.contains_key("top_p"));
    }

    #[test]
    fn test_temperature_kept_when_reasoning_none() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("none".to_string()),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // reasoning_effort="none" 时保留 temperature
        assert!(body.contains_key("temperature"));
    }

    #[test]
    fn test_temperature_kept_when_reasoning_none_even_if_is_reasoning_true() {
        // 关键边界测试：reasoning_effort="none" 应该覆盖 is_reasoning=true
        // 用户显式设置 "none" 表示想禁用推理功能
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("none".to_string()),
            is_reasoning: true,       // 模型是推理模型
            supports_reasoning: true, // 支持推理
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // reasoning_effort="none" 优先级最高，应保留采样参数
        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
    }

    #[test]
    fn test_temperature_removed_when_reasoning_high_and_is_reasoning_true() {
        // 验证非 "none" 的 reasoning_effort 仍会移除采样参数
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // reasoning_effort="high" 应移除采样参数
        assert!(!body.contains_key("temperature"));
    }

    #[test]
    fn test_invalid_reasoning_effort_keeps_sampling_params() {
        // 非法 reasoning_effort 不应移除采样参数
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("foo".to_string()),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
        assert!(!body.contains_key("reasoning_effort"));
    }
}
