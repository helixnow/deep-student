//! 百度文心 (ERNIE) 专用适配器
//!
//! ERNIE 系列 API 的参数格式：
//!
//! ## 参数格式
//! - `max_output_tokens`: 最大生成 token 数（ERNIE 标准参数名）
//! - `reasoning_effort`: 推理强度 ("low" | "medium" | "high")
//! - `penalty_score`: 重复惩罚参数，范围 [1.0, 2.0]
//!
//! ## 支持的推理模型
//! - ERNIE 5.0 Thinking 系列：`ernie-5.0-thinking-latest`, `ernie-5.0-thinking-preview`
//! - ERNIE X1 系列：`ernie-x1`, `ernie-x1.1`, `ernie-x1-turbo`
//!
//! ## 注意
//! - ERNIE 使用 `max_output_tokens` 而非 `max_tokens`（官方 API 规范）
//! - ERNIE 使用 `penalty_score` 而非 `repetition_penalty`
//! - ERNIE 不支持 `enable_thinking` 参数
//! - V2 API 响应使用 `reasoning_content` 字段（DeepSeek 兼容）
//!
//! 参考文档：https://cloud.baidu.com/doc/WENXINWORKSHOP/

use super::{get_trimmed_effort, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 百度文心 ERNIE 专用适配器
///
/// ERNIE 系列推理模型的参数处理：
/// - max_output_tokens: 最大生成 token（ERNIE 官方参数名）
/// - reasoning_effort: 推理强度 (low/medium/high)
/// - penalty_score: 重复惩罚 [1.0, 2.0]
pub struct ErnieAdapter;

impl ErnieAdapter {
    /// 检查是否是 ERNIE 推理模型
    ///
    /// 包括：
    /// - ERNIE 5.0 Thinking 系列
    /// - ERNIE X1/X1.1 系列（深度思考模型）
    fn is_thinking_model(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        // ERNIE 5.0 Thinking 系列
        model_lower.contains("ernie-5.0-thinking")
            || model_lower.contains("ernie-5-thinking")
            || model_lower.contains("ernie5-thinking")
            // ERNIE X1 系列（深度思考模型）
            || model_lower.contains("ernie-x1")
            || model_lower.contains("ernie_x1")
    }
}

impl RequestAdapter for ErnieAdapter {
    fn id(&self) -> &'static str {
        "ernie"
    }

    fn label(&self) -> &'static str {
        "百度文心"
    }

    fn description(&self) -> &'static str {
        "ERNIE 系列，支持 max_output_tokens/reasoning_effort/penalty_score 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        _enable_thinking: Option<bool>,
    ) -> bool {
        // ERNIE 使用 max_output_tokens 而非 max_tokens（官方 API 规范）
        // 范围 [2, 2048]，默认 1024
        if let Some(max_tokens) = body.remove("max_tokens") {
            body.insert("max_output_tokens".to_string(), max_tokens);
        }
        // 同时处理可能存在的 max_completion_tokens
        if let Some(max_completion) = body.remove("max_completion_tokens") {
            body.insert("max_output_tokens".to_string(), max_completion);
        }

        // 处理 reasoning_effort 参数
        // ERNIE 支持 "low" | "medium" | "high"
        if let Some(effort) = get_trimmed_effort(config) {
            let effort_lower = effort.to_lowercase();
            // 只处理有效值
            if matches!(effort_lower.as_str(), "low" | "medium" | "high") {
                body.insert("reasoning_effort".to_string(), json!(effort_lower));
            }
        }

        // ERNIE 不支持 enable_thinking 参数，确保移除
        body.remove("enable_thinking");
        body.remove("thinking");
        body.remove("thinking_budget");

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // ERNIE 推理模型可能需要移除采样参数
        Self::is_thinking_model(&config.model) || config.is_reasoning || config.supports_reasoning
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // ERNIE 推理模型可能使用 DeepSeek 风格的 reasoning_content
        if Self::is_thinking_model(&config.model)
            || config.supports_reasoning
            || config.is_reasoning
        {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // ERNIE 支持部分通用参数
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        // ERNIE 使用 penalty_score 而非 repetition_penalty
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("penalty_score".to_string(), json!(rep_penalty));
        }
        // reasoning_effort 已在 apply_reasoning_config 中处理
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_max_tokens_conversion() {
        let adapter = ErnieAdapter;
        let config = ApiConfig::default();
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(4096));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // max_tokens 应该被转换为 max_output_tokens（ERNIE 官方参数名）
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_output_tokens"), Some(&json!(4096)));
    }

    #[test]
    fn test_reasoning_effort() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_reasoning_effort_case_insensitive() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("HIGH".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该转换为小写
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_invalid_reasoning_effort_ignored() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("invalid".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 无效值应该被忽略
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_removes_enable_thinking() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("enable_thinking".to_string(), json!(true));
        body.insert("thinking".to_string(), json!({"type": "enabled"}));
        body.insert("thinking_budget".to_string(), json!(2048));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // ERNIE 不支持这些参数，应该被移除
        assert!(!body.contains_key("enable_thinking"));
        assert!(!body.contains_key("thinking"));
        assert!(!body.contains_key("thinking_budget"));
    }

    #[test]
    fn test_is_thinking_model() {
        assert!(ErnieAdapter::is_thinking_model("ernie-5.0-thinking-latest"));
        assert!(ErnieAdapter::is_thinking_model(
            "ernie-5.0-thinking-preview"
        ));
        assert!(ErnieAdapter::is_thinking_model("ERNIE-5.0-THINKING-LATEST"));
        assert!(!ErnieAdapter::is_thinking_model("ernie-5.0"));
        assert!(!ErnieAdapter::is_thinking_model("ernie-4.0"));
    }

    #[test]
    fn test_should_remove_sampling_params_for_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0-thinking-latest".to_string(),
            ..Default::default()
        };

        assert!(adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_keep_sampling_params_for_non_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_passback_policy_for_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0-thinking-latest".to_string(),
            ..Default::default()
        };

        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_penalty_score_conversion() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            repetition_penalty: Some(1.2),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        // ERNIE 使用 penalty_score
        assert_eq!(body.get("penalty_score"), Some(&json!(1.2)));
        assert!(!body.contains_key("repetition_penalty"));
    }
}
