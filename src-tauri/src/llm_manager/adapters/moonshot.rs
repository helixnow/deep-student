//! 月之暗面 Kimi 专用适配器
//!
//! Kimi K2/K2.5 系列有特殊的参数要求：
//!
//! ## K2.5 多模态模型（2026-01新增）
//! - **原生多模态**：支持图片、视频输入
//! - **thinking 参数**：`{"type": "enabled"}` 或 `{"type": "disabled"}`
//! - **固定参数**：temperature=1.0, top_p=0.95, n=1, penalties=0.0
//! - **max_tokens 默认 32768**
//! - **tool_choice 限制**：thinking 模式下只能是 "auto" 或 "none"
//!
//! ## K2 Thinking 模型特殊要求
//! - **temperature 必须为 1.0**（非 0.6-0.8）
//! - **max_tokens 最小 16000**，推荐 32000
//! - 必须保留历史 reasoning_content
//!
//! ## 模型列表
//! - kimi-k2.5: 多模态旗舰（图片+视频）
//! - kimi-k2-0905-preview: Agentic Coding
//! - kimi-k2-thinking: 多步工具推理
//! - kimi-k2-turbo-preview: 60-100 tokens/s
//!
//! ## 输出格式
//! ```json
//! {
//!   "reasoning_content": "思考过程...",
//!   "content": "最终答案..."
//! }
//! ```
//!
//! 参考文档：https://platform.moonshot.cn/docs/

use super::{PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 月之暗面 Kimi 专用适配器
///
/// Kimi K2/K2.5 系列的特殊处理：
/// - K2.5: thinking 参数格式、固定参数、多模态支持
/// - K2 Thinking: 强制 temperature = 1.0, max_tokens >= 16000
pub struct MoonshotAdapter;

impl MoonshotAdapter {
    /// 检查是否是 K2.5 模型
    fn is_k25_model(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("kimi-k2.5")
            || model_lower.contains("kimi-k2-5")
            || model_lower.contains("k2.5")
    }

    /// 检查是否是 Thinking 模型（K2 Thinking 或 K2.5）
    fn is_thinking_model(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("thinking")
            || model_lower.contains("k2-thinking")
            || Self::is_k25_model(model) // K2.5 默认是 thinking 模型
    }

    /// Thinking 模型的最小 max_tokens
    const MIN_MAX_TOKENS_FOR_THINKING: u32 = 16000;

    /// Thinking 模型的推荐 max_tokens
    const RECOMMENDED_MAX_TOKENS: u32 = 32000;

    /// K2.5 的默认 max_tokens
    const K25_DEFAULT_MAX_TOKENS: u32 = 32768;
}

impl RequestAdapter for MoonshotAdapter {
    fn id(&self) -> &'static str {
        "moonshot"
    }

    fn label(&self) -> &'static str {
        "Kimi/Moonshot"
    }

    fn description(&self) -> &'static str {
        "Kimi K2/K2.5 系列，K2.5 支持多模态和 thinking 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        let is_k25 = Self::is_k25_model(&config.model);
        let is_thinking = Self::is_thinking_model(&config.model);

        if is_k25 {
            // ========== K2.5 专用处理 ==========
            // K2.5 使用 thinking 参数格式: {"type": "enabled"} 或 {"type": "disabled"}
            let thinking_enabled = enable_thinking.unwrap_or(true); // K2.5 默认启用 thinking
            let thinking_type = if thinking_enabled {
                "enabled"
            } else {
                "disabled"
            };
            body.insert("thinking".to_string(), json!({"type": thinking_type}));

            // K2.5 固定参数处理（官方文档：这些参数"cannot be modified"）
            // 最安全的做法是移除这些参数，让 API 使用内部默认值
            // 官方默认值：temperature=1.0, top_p=0.95, n=1, penalties=0.0
            body.remove("temperature");
            body.remove("top_p");
            body.remove("n");
            body.remove("presence_penalty");
            body.remove("frequency_penalty");

            // K2.5 max_tokens 默认 32768（官方文档：Default to be 32k aka 32768）
            // 只有用户未指定时才设置，用户指定的值会被使用
            let current_max_tokens =
                body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if current_max_tokens == 0 {
                body.insert(
                    "max_tokens".to_string(),
                    json!(Self::K25_DEFAULT_MAX_TOKENS),
                );
            }

            // K2.5 thinking 模式下 tool_choice 只能是 "auto" 或 "none"
            // 官方文档："tool_choice can only be set to 'auto' or 'none', any other value will result in an error"
            if thinking_enabled {
                if let Some(tool_choice) = body.get("tool_choice") {
                    let choice_str = tool_choice.as_str().unwrap_or("");
                    if choice_str != "auto" && choice_str != "none" {
                        // 强制改为 auto（官方默认值）
                        body.insert("tool_choice".to_string(), json!("auto"));
                    }
                }
            }

            return true; // K2.5 已完成所有处理，跳过通用逻辑
        }

        if is_thinking {
            // ========== K2 Thinking 处理（向后兼容）==========
            // Thinking 模型强制 temperature = 1.0
            body.insert("temperature".to_string(), json!(1.0));

            // 确保 max_tokens 足够大
            let current_max_tokens =
                body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            if current_max_tokens < Self::MIN_MAX_TOKENS_FOR_THINKING {
                body.insert(
                    "max_tokens".to_string(),
                    json!(Self::RECOMMENDED_MAX_TOKENS),
                );
            }
        }

        // K2 Thinking 不使用 enable_thinking 参数
        // 思维链通过 reasoning_content 字段自动返回

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // K2.5 已在 apply_reasoning_config 中处理固定参数
        // K2 Thinking 需要特殊处理 temperature，不移除
        if Self::is_k25_model(&config.model) {
            return true; // K2.5 跳过默认移除逻辑（已在上面处理）
        }
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // Kimi 使用 reasoning_content 字段（DeepSeek 风格）
        if Self::is_thinking_model(&config.model) || config.is_reasoning {
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
    fn test_thinking_model_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Thinking 模型强制 temperature = 1.0
        assert_eq!(body.get("temperature"), Some(&json!(1.0)));
    }

    #[test]
    fn test_thinking_model_min_max_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(4096)); // 太小

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该被提升到推荐值
        assert_eq!(body.get("max_tokens"), Some(&json!(32000)));
    }

    #[test]
    fn test_non_thinking_model_keeps_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-turbo-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非 Thinking 模型保持原有 temperature
        assert_eq!(body.get("temperature"), Some(&json!(0.7)));
    }

    // ========== K2.5 测试用例 ==========

    #[test]
    fn test_k25_thinking_param_format() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 应使用 thinking 参数格式
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_k25_thinking_disabled() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        // K2.5 禁用 thinking
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_k25_fixed_params() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.8));
        body.insert("n".to_string(), json!(2));
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("frequency_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // K2.5 不能修改这些参数，应全部移除让 API 使用默认值
        // 官方文档："This parameter cannot be modified for the kimi-k2.5 model"
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("n").is_none());
        assert!(body.get("presence_penalty").is_none());
        assert!(body.get("frequency_penalty").is_none());
    }

    #[test]
    fn test_k25_default_max_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // K2.5 默认 max_tokens = 32768
        assert_eq!(body.get("max_tokens"), Some(&json!(32768)));
    }

    #[test]
    fn test_k25_tool_choice_constraint() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("tool_choice".to_string(), json!("required")); // 不支持

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 thinking 模式下 tool_choice 应被强制为 auto
        assert_eq!(body.get("tool_choice"), Some(&json!("auto")));
    }

    #[test]
    fn test_k25_model_detection() {
        // 各种 K2.5 模型名称格式
        assert!(MoonshotAdapter::is_k25_model("kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_model("kimi-k2-5"));
        assert!(MoonshotAdapter::is_k25_model("Pro/moonshot/kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_model("moonshot/K2.5-preview"));

        // 非 K2.5 模型
        assert!(!MoonshotAdapter::is_k25_model("kimi-k2"));
        assert!(!MoonshotAdapter::is_k25_model("kimi-k2-thinking"));
        assert!(!MoonshotAdapter::is_k25_model("moonshot-v1-128k"));
    }

    #[test]
    fn test_k25_passback_policy() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };

        // K2.5 应使用 DeepSeekStyle 回传策略
        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::DeepSeekStyle
        );
    }
}
