//! DeepSeek 专用适配器
//!
//! DeepSeek API 的推理参数格式：
//!
//! ## DeepSeek 官方 API（api.deepseek.com）
//! - `thinking: { type: "enabled" | "disabled" }`
//!
//! ## SiliconFlow 平台（api.siliconflow.cn）
//! - `enable_thinking: true | false`
//! - `thinking_budget: number`
//!
//! - DeepSeek-R1/V3.2 系列是原生推理模型
//! - V3.1 使用函数调用时需禁用思维模式
//!
//! 参考文档：
//! - DeepSeek: https://api-docs.deepseek.com/
//! - SiliconFlow: https://docs.siliconflow.com/

use super::{resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// DeepSeek 专用适配器
///
/// DeepSeek 模型的参数处理：
/// - DeepSeek 官方 API: 使用 `thinking: { type: "enabled" }` 格式
/// - SiliconFlow 平台: 使用 `enable_thinking: true` 格式
/// - V3.1: 使用函数调用时需禁用 thinking 相关字段
pub struct DeepSeekAdapter;

impl DeepSeekAdapter {
    /// 检查是否是 DeepSeek V3.1（需要特殊处理工具调用）
    fn is_v31(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("deepseek-v3.1")
            || model_lower.contains("deepseek-ai/deepseek-v3.1")
            || model_lower.contains("pro/deepseek-ai/deepseek-v3.1")
    }

    /// 检查请求是否包含工具调用
    fn has_tools(body: &Map<String, Value>) -> bool {
        body.contains_key("tools") || body.contains_key("tool_choice")
    }

    /// 检查是否是 SiliconFlow 平台
    ///
    /// SiliconFlow 使用不同的参数格式：enable_thinking 而不是 thinking.type
    fn is_siliconflow(config: &ApiConfig) -> bool {
        // 通过 base_url 检测
        let base_url_lower = config.base_url.to_lowercase();
        if base_url_lower.contains("siliconflow") {
            return true;
        }
        // 通过 provider_type 检测
        if let Some(ref pt) = config.provider_type {
            if pt.to_lowercase() == "siliconflow" {
                return true;
            }
        }
        false
    }
}

impl RequestAdapter for DeepSeekAdapter {
    fn id(&self) -> &'static str {
        "deepseek"
    }

    fn label(&self) -> &'static str {
        "DeepSeek"
    }

    fn description(&self) -> &'static str {
        "DeepSeek 系列，支持 thinking.type 参数格式"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // DeepSeek V3.1 + 工具调用：禁用所有 thinking 相关字段
        if Self::is_v31(&config.model) && Self::has_tools(body) {
            // 移除可能已存在的 thinking 相关字段
            body.remove("enable_thinking");
            body.remove("thinking");
            body.remove("thinking_budget");
            body.remove("include_thoughts");
            return false;
        }

        // 检查是否需要启用推理模式
        if config.supports_reasoning {
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);

            // 根据平台选择不同的参数格式
            if Self::is_siliconflow(config) {
                // SiliconFlow 平台：使用 enable_thinking + thinking_budget 格式
                body.insert("enable_thinking".to_string(), json!(enable_thinking_value));

                // SiliconFlow 支持 thinking_budget 参数
                if let Some(budget) = config.thinking_budget {
                    let sanitized = budget.max(128).min(32768); // SiliconFlow 范围：128-32768
                    body.insert("thinking_budget".to_string(), json!(sanitized));
                }
            } else {
                // DeepSeek 官方 API：使用 thinking: { type: "enabled" | "disabled" } 格式
                let thinking_type = if enable_thinking_value {
                    "enabled"
                } else {
                    "disabled"
                };
                body.insert("thinking".to_string(), json!({ "type": thinking_type }));
            }
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // DeepSeek Thinking 模式不支持采样参数（设置无效但不报错）
        // 官方文档：temperature, top_p, presence_penalty, frequency_penalty 在 thinking 模式下无效
        config.supports_reasoning || config.is_reasoning || config.thinking_enabled
    }

    fn should_disable_thinking_for_tools(
        &self,
        config: &ApiConfig,
        body: &Map<String, Value>,
    ) -> bool {
        // DeepSeek V3.1 使用工具时需要禁用 thinking
        Self::is_v31(&config.model) && Self::has_tools(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_type_format_deepseek_official() {
        // DeepSeek 官方 API 应使用 thinking: { type: "enabled" } 格式
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-chat".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该使用 thinking.type 格式
        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        // 不应该有 enable_thinking 格式
        assert!(!body.contains_key("enable_thinking"));
    }

    #[test]
    fn test_siliconflow_enable_thinking_format() {
        // SiliconFlow 平台应使用 enable_thinking: true 格式
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-ai/DeepSeek-V3.2".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            thinking_budget: Some(4096),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该使用 enable_thinking 格式
        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("thinking_budget"), Some(&json!(4096)));
        // 不应该有 thinking.type 格式
        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_siliconflow_detection_by_provider_type() {
        // 通过 provider_type 检测 SiliconFlow
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-ai/DeepSeek-V3.2".to_string(),
            base_url: "https://some-proxy.example.com/v1".to_string(),
            provider_type: Some("siliconflow".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该使用 enable_thinking 格式
        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_v31_with_tools_disables_thinking() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-ai/deepseek-v3.1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("tools".to_string(), json!([]));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // V3.1 + 工具调用时不应该添加 thinking
        assert!(!body.contains_key("thinking"));
        assert!(!body.contains_key("enable_thinking"));
    }

    #[test]
    fn test_remove_sampling_params_for_thinking() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            is_reasoning: true,
            ..Default::default()
        };

        // DeepSeek Thinking 模式下采样参数无效，应移除
        assert!(adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_keep_sampling_params_for_non_thinking() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            is_reasoning: false,
            supports_reasoning: false,
            thinking_enabled: false,
            ..Default::default()
        };

        // 非 Thinking 模式保留采样参数
        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_thinking_budget_clamp() {
        // SiliconFlow thinking_budget 范围应在 128-32768 之间
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-ai/DeepSeek-V3.2".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            thinking_budget: Some(50), // 小于最小值
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该被限制到 128
        assert_eq!(body.get("thinking_budget"), Some(&json!(128)));
    }
}
