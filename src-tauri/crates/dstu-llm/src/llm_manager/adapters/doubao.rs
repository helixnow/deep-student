//! 字节豆包 (Doubao) 专用适配器
//!
//! 豆包使用火山方舟 API，支持以下推理参数格式：
//! ```json
//! {
//!   "thinking": {
//!     "type": "enabled" | "disabled" | "auto"
//!   }
//! }
//! ```
//!
//! ## 支持 thinking 的模型
//! - doubao-1-5-thinking-pro-250415: 文本深度思考
//! - doubao-1-5-thinking-pro-m-250428: 多模态深度思考，支持 auto
//! - doubao-seed-1-6-thinking-*: Seed 1.6 深度思考系列，支持 auto
//! - doubao-seed-1-6-vision-*: Seed 1.6 视觉理解
//! - doubao-seed-1-6-flash-*: Seed 1.6 极速版
//!
//! ## thinking.type 有效值
//! - "enabled": 强制开启深度思考
//! - "disabled": 强制关闭深度思考
//! - "auto": 由模型自动决定（仅 Seed 1.6+ 和 m-250428 版本支持）
//!
//! ## 响应格式
//! 思考内容在 `reasoning_content` 字段返回（与 DeepSeek 相同）
//!
//! 参考文档：https://www.volcengine.com/docs/82379/1449737

use super::{resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 字节豆包专用适配器
///
/// 豆包模型的参数处理：
/// - thinking.type: enabled | disabled | auto
/// - 响应使用 reasoning_content 字段（DeepSeek 风格）
pub struct DoubaoAdapter;

impl DoubaoAdapter {
    /// 检查是否支持 auto 模式
    ///
    /// 支持 auto 的模型：
    /// - Seed 1.6+ 系列（包含 "seed"）
    /// - doubao-1-5-thinking-pro-m-250428 版本（多模态版）
    fn supports_auto_mode(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        // Seed 系列全部支持 auto
        if model_lower.contains("seed") {
            return true;
        }
        // 1.5 thinking pro 的 m 版本（multimodal）支持 auto
        if model_lower.contains("thinking-pro-m") || model_lower.contains("thinking-pro-m-") {
            return true;
        }
        false
    }

    /// 检查是否是 thinking 模型
    fn is_thinking_model(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("thinking") || model_lower.contains("seed")
    }
}

impl RequestAdapter for DoubaoAdapter {
    fn id(&self) -> &'static str {
        "doubao"
    }

    fn label(&self) -> &'static str {
        "字节豆包"
    }

    fn description(&self) -> &'static str {
        "豆包 Seed/Thinking 系列，支持 thinking.type (auto/enabled/disabled)"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // 检查是否是推理模型
        if !config.supports_reasoning && !config.is_reasoning {
            return false; // 非推理模型，不添加 thinking 参数
        }

        let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);

        // 确定 thinking.type 的值
        let thinking_type = if enable_thinking_value {
            // 检查是否支持 auto 模式
            if Self::supports_auto_mode(&config.model) {
                // 如果有 reasoning_effort 指定为 auto 或 medium，使用 auto
                if let Some(ref effort) = config.reasoning_effort {
                    let effort_lower = effort.to_lowercase();
                    if effort_lower == "auto" || effort_lower == "medium" {
                        "auto"
                    } else {
                        "enabled"
                    }
                } else {
                    // 默认使用 enabled，确保启用深度思考
                    "enabled"
                }
            } else {
                "enabled"
            }
        } else {
            "disabled"
        };

        // 构建 thinking 参数
        body.insert("thinking".to_string(), json!({ "type": thinking_type }));

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // 豆包 thinking 模型支持采样参数（与 DeepSeek 不同）
        // 官方文档未声明需要移除
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // 豆包使用 reasoning_content 字段返回思考内容（与 DeepSeek 相同）
        if config.is_reasoning
            || config.supports_reasoning
            || Self::is_thinking_model(&config.model)
        {
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
    fn test_thinking_type_enabled() {
        // doubao-1-5-thinking-pro 应使用 enabled
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "doubao-1-5-thinking-pro-250415".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
    }

    #[test]
    fn test_thinking_type_disabled() {
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: false,
            model: "doubao-1-5-thinking-pro-250415".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("disabled")));
    }

    #[test]
    fn test_seed_model_auto_mode() {
        // Seed 系列 + reasoning_effort=auto 应使用 auto
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("auto".to_string()),
            model: "doubao-seed-1-6-thinking-250715".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("auto")));
    }

    #[test]
    fn test_seed_model_medium_effort() {
        // Seed 系列 + reasoning_effort=medium 应使用 auto
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("medium".to_string()),
            model: "doubao-seed-1-6-vision-250715".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("auto")));
    }

    #[test]
    fn test_thinking_pro_m_supports_auto() {
        // doubao-1-5-thinking-pro-m-250428 (multimodal版) 支持 auto
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("auto".to_string()),
            model: "doubao-1-5-thinking-pro-m-250428".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("auto")));
    }

    #[test]
    fn test_thinking_pro_non_m_no_auto() {
        // doubao-1-5-thinking-pro-250415 (非 m 版) 不支持 auto，应使用 enabled
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("auto".to_string()),
            model: "doubao-1-5-thinking-pro-250415".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // 非 m 版本不支持 auto，应回退到 enabled
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
    }

    #[test]
    fn test_seed_model_default_enabled() {
        // Seed 模型没有指定 effort 时，默认使用 enabled
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: None,
            model: "doubao-seed-1-6-thinking-250715".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
    }

    #[test]
    fn test_keep_temperature() {
        // 豆包 thinking 模型保留采样参数
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            is_reasoning: true,
            ..Default::default()
        };

        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_passback_policy_deepseek_style() {
        // 豆包 thinking 模型使用 DeepSeek 风格的 reasoning_content
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            model: "doubao-seed-1-6-thinking-250715".to_string(),
            ..Default::default()
        };

        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_passback_policy_no_passback() {
        // 非 thinking 模型不回传思维链
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: false,
            is_reasoning: false,
            model: "doubao-1.5-pro-32k".to_string(), // 非 thinking 模型
            ..Default::default()
        };

        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::NoPassback
        );
    }

    #[test]
    fn test_non_reasoning_model_no_thinking() {
        // 非推理模型不添加 thinking 参数
        let adapter = DoubaoAdapter;
        let config = ApiConfig {
            supports_reasoning: false,
            is_reasoning: false,
            model: "doubao-1.5-pro-32k".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        let result = adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!result);
        assert!(!body.contains_key("thinking"));
    }
}
