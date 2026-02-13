//! 阿里通义千问 (Qwen) 专用适配器
//!
//! Qwen3 系列使用 DashScope API，支持以下推理参数：
//! - `enable_thinking`: 启用思维链
//! - `thinking_budget`: 思维 token 预算
//! - `reasoning_effort`: 推理强度 (high/medium/low)
//!
//! 注意：这些参数需要通过 `extra_body` 传递
//!
//! ## 参数限制
//! - **不支持 frequency_penalty**（官方 API 未提供）
//! - presence_penalty 仅 qwen1.5+ 支持
//!
//! ## 输出格式
//! ```json
//! {
//!   "reasoning_content": "思考过程...",
//!   "content": "最终答案..."
//! }
//! ```
//!
//! 参考文档：https://www.alibabacloud.com/help/en/model-studio/

use super::{get_trimmed_effort, resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 阿里通义千问专用适配器
///
/// Qwen3 模型的参数处理：
/// - enable_thinking: 启用思维链
/// - thinking_budget: 思维 token 预算
/// - reasoning_effort: 推理强度
pub struct QwenAdapter;

impl RequestAdapter for QwenAdapter {
    fn id(&self) -> &'static str {
        "qwen"
    }

    fn label(&self) -> &'static str {
        "通义千问"
    }

    fn description(&self) -> &'static str {
        "Qwen 系列，支持 enable_thinking/thinking_budget 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // Qwen 官方 API 不支持 frequency_penalty
        body.remove("frequency_penalty");

        if config.supports_reasoning {
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
            body.insert("enable_thinking".to_string(), json!(enable_thinking_value));

            if let Some(budget) = config.thinking_budget {
                let sanitized = budget.max(0);
                body.insert("thinking_budget".to_string(), json!(sanitized));
            }
        }

        if let Some(effort) = get_trimmed_effort(config) {
            if !effort.eq_ignore_ascii_case("none") && !effort.eq_ignore_ascii_case("unset") {
                body.insert("reasoning_effort".to_string(), json!(effort));
            }
        }

        false
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        if config.supports_reasoning || config.is_reasoning {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enable_thinking() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            thinking_budget: Some(2048),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("thinking_budget"), Some(&json!(2048)));
    }

    #[test]
    fn test_reasoning_effort() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_keep_temperature() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            is_reasoning: true,
            ..Default::default()
        };

        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_removes_frequency_penalty() {
        let adapter = QwenAdapter;
        let config = ApiConfig::default();
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(body.contains_key("presence_penalty"));
    }
}
