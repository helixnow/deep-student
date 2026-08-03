//! 阿里通义千问 (Qwen) 专用适配器
//!
//! Qwen3 系列使用 DashScope API，支持以下推理参数：
//! - `enable_thinking`: 启用思维链
//! - `thinking_budget`: 思维 token 预算
//! - `reasoning_effort`: 推理强度 (high/medium/low)
//! - `preserve_thinking`: Qwen3.6/3.7 保留多轮思考上下文
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

impl QwenAdapter {
    fn is_forced_thinking_model(model: &str) -> bool {
        let model = model.to_lowercase();
        if model.contains("qwq") {
            return true;
        }
        if model.contains("qwen3.7-max-preview")
            || model.contains("qwen3-7-max-preview")
            || model.contains("qwen3.7-max-2026-05-17")
            || model.contains("qwen3-7-max-2026-05-17")
            || model.contains("qwen3.7-max-20260517")
            || model.contains("qwen3-7-max-20260517")
        {
            return true;
        }
        model.contains("qwen3")
            && model
                .split(['-', '_', '/'])
                .any(|token| token == "thinking")
    }

    fn is_siliconflow(config: &ApiConfig) -> bool {
        config
            .provider_type
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case("siliconflow"))
            .unwrap_or(false)
            || config.base_url.contains("siliconflow.cn")
            || config.base_url.contains("siliconflow.com")
    }

    fn is_dashscope(config: &ApiConfig) -> bool {
        config
            .provider_type
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case("qwen"))
            .unwrap_or(false)
            || config.base_url.contains("dashscope.aliyuncs.com")
            || config.base_url.contains("dashscope-intl.aliyuncs.com")
            || config.base_url.contains(".maas.aliyuncs.com")
    }

    fn clamp_siliconflow_thinking_budget(budget: i32) -> i32 {
        budget.clamp(128, 32768)
    }

    fn supports_preserve_thinking(model: &str) -> bool {
        let normalized = model.trim().to_lowercase();
        normalized.contains("qwen3.6") || normalized.contains("qwen3.7")
    }
}

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
        let is_siliconflow = Self::is_siliconflow(config);
        let is_dashscope = Self::is_dashscope(config);

        if is_dashscope {
            body.remove("frequency_penalty");
        }

        let forced_thinking = Self::is_forced_thinking_model(&config.model);
        if config.supports_reasoning || forced_thinking {
            let enable_thinking_value =
                forced_thinking || resolve_enable_thinking(config, enable_thinking);
            body.insert("enable_thinking".to_string(), json!(enable_thinking_value));

            if is_dashscope && Self::supports_preserve_thinking(&config.model) {
                body.insert(
                    "preserve_thinking".to_string(),
                    json!(enable_thinking_value && config.include_thoughts),
                );
            }

            if let Some(budget) = config.thinking_budget {
                let sanitized = if is_siliconflow {
                    Self::clamp_siliconflow_thinking_budget(budget)
                } else {
                    budget.max(0)
                };
                if sanitized > 0 {
                    body.insert("thinking_budget".to_string(), json!(sanitized));
                }
            }
        }

        if is_dashscope || is_siliconflow {
            // Official Qwen-compatible dialects use enable_thinking +
            // thinking_budget. reasoning_effort is not a documented request
            // field and strict gateways may reject it.
            body.remove("reasoning_effort");
        } else if let Some(effort) = get_trimmed_effort(config) {
            if !effort.eq_ignore_ascii_case("none") && !effort.eq_ignore_ascii_case("unset") {
                body.insert("reasoning_effort".to_string(), json!(effort.to_lowercase()));
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
    fn test_forced_thinking_models_ignore_disable_override() {
        for model in [
            "qwen3.7-max-preview",
            "qwen3.7-max-2026-05-17",
            "Qwen/Qwen3-235B-A22B-Thinking-2507",
            "Qwen/Qwen3-VL-235B-A22B-Thinking",
        ] {
            let config = ApiConfig {
                model: model.to_string(),
                supports_reasoning: true,
                enable_thinking: Some(false),
                ..Default::default()
            };
            let mut body = Map::new();

            QwenAdapter.apply_reasoning_config(&mut body, &config, Some(false));

            assert_eq!(
                body.get("enable_thinking"),
                Some(&json!(true)),
                "model={model}"
            );
        }
    }

    #[test]
    fn test_hybrid_qwen_models_remain_disableable() {
        for model in [
            "qwen3.7-plus",
            "qwen3.7-max-2026-06-08",
            "qwen-plus",
            "qwen-turbo",
        ] {
            let config = ApiConfig {
                model: model.to_string(),
                supports_reasoning: true,
                enable_thinking: Some(false),
                ..Default::default()
            };
            let mut body = Map::new();

            QwenAdapter.apply_reasoning_config(&mut body, &config, Some(false));

            assert_eq!(
                body.get("enable_thinking"),
                Some(&json!(false)),
                "model={model}"
            );
        }
    }

    #[test]
    fn test_qwen37_preserves_thinking_history_on_dashscope() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            model: "qwen3.7-plus".to_string(),
            supports_reasoning: true,
            thinking_enabled: true,
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("preserve_thinking"), Some(&json!(true)));
    }

    #[test]
    fn test_preserve_thinking_is_scoped_to_supported_dashscope_models() {
        let adapter = QwenAdapter;
        for config in [
            ApiConfig {
                provider_type: Some("qwen".to_string()),
                model: "qwen3.5-plus".to_string(),
                supports_reasoning: true,
                include_thoughts: true,
                ..Default::default()
            },
            ApiConfig {
                provider_type: Some("siliconflow".to_string()),
                model: "Qwen/Qwen3.7-Plus".to_string(),
                supports_reasoning: true,
                include_thoughts: true,
                ..Default::default()
            },
        ] {
            let mut body = Map::new();
            adapter.apply_reasoning_config(&mut body, &config, None);
            assert!(!body.contains_key("preserve_thinking"));
        }
    }

    #[test]
    fn test_dashscope_does_not_send_unsupported_reasoning_effort() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            reasoning_effort: Some("high".to_string()),
            supports_reasoning: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_workspace_maas_uses_official_qwen_reasoning_dialect() {
        for base_url in [
            "https://workspace-id.cn-beijing.maas.aliyuncs.com/v1",
            "https://workspace-id.ap-southeast-1.maas.aliyuncs.com/v1",
        ] {
            let config = ApiConfig {
                base_url: base_url.to_string(),
                reasoning_effort: Some("high".to_string()),
                supports_reasoning: true,
                thinking_budget: Some(8192),
                ..Default::default()
            };
            let mut body = Map::new();
            body.insert("frequency_penalty".to_string(), json!(0.5));

            QwenAdapter.apply_reasoning_config(&mut body, &config, Some(true));

            assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
            assert_eq!(body.get("thinking_budget"), Some(&json!(8192)));
            assert!(
                !body.contains_key("reasoning_effort"),
                "base_url={base_url}"
            );
            assert!(
                !body.contains_key("frequency_penalty"),
                "base_url={base_url}"
            );
        }
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
        let config = ApiConfig {
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(body.contains_key("presence_penalty"));
    }

    #[test]
    fn test_siliconflow_keeps_frequency_penalty() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            provider_type: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("frequency_penalty"), Some(&json!(0.5)));
    }

    #[test]
    fn test_siliconflow_clamps_thinking_budget() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            provider_type: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            supports_reasoning: true,
            thinking_enabled: true,
            thinking_budget: Some(64),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("thinking_budget").cloned(), Some(json!(128)));
    }
}
