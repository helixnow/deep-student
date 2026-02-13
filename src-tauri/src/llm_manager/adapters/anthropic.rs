//! Anthropic/Claude 专用适配器
//!
//! Anthropic 使用独特的 extended thinking 格式：
//! - `thinking` 对象包含 `type: "enabled"` 和 `budget_tokens`
//! - budget_tokens 必须 >= 1024，且必须 < max_tokens
//!
//! ## Extended Thinking 采样参数限制（重要！）
//! 根据官方文档 (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking):
//! - **temperature**: Extended thinking 模式下**必须移除**，否则 API 报错
//! - **top_k**: Extended thinking 模式下**必须移除**，否则 API 报错
//! - **top_p**: 可选，但必须在 **0.95-1.0** 范围内
//!
//! ## Claude 4.5 Breaking Change (2026)
//! - **temperature 和 top_p 不能同时使用**（非 thinking 模式）
//! - 优先使用 temperature，忽略 top_p
//! - **不支持 frequency_penalty 和 presence_penalty**
//!
//! ## 支持 Extended Thinking 的模型
//! - Claude Opus 4.5, 4.1, 4
//! - Claude Sonnet 4.5, 4, 3.7
//! - Claude Haiku 4.5
//! - **注意：Claude 3.5 不支持 Extended Thinking**
//!
//! 参考文档：https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking

use super::{resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// Anthropic/Claude 专用适配器
///
/// 处理 Claude 的 extended thinking 格式
///
/// ## Extended Thinking 参数限制
/// - temperature: 必须移除（不兼容）
/// - top_k: 必须移除（不兼容）
/// - top_p: 可选，范围 0.95-1.0
///
/// ## Claude 4.5 非 thinking 模式参数限制
/// - temperature 和 top_p 互斥，只能使用其中之一
/// - 不支持 frequency_penalty 和 presence_penalty
pub struct AnthropicAdapter;

/// budget_tokens 的上限（官方建议超过 32k 使用 batch processing）
const MAX_BUDGET_TOKENS: i32 = 32768;

/// budget_tokens 的下限
const MIN_BUDGET_TOKENS: i32 = 1024;

/// 默认 budget_tokens
const DEFAULT_BUDGET_TOKENS: i32 = 10240;

impl AnthropicAdapter {
    /// 检查是否是 Claude 4.5 系列（有 temperature/top_p 互斥限制）
    fn is_claude_45(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("claude-4.5")
            || model_lower.contains("claude-sonnet-4.5")
            || model_lower.contains("claude-haiku-4.5")
            || model_lower.contains("claude-opus-4.5") // 添加 Opus 4.5
            || model_lower.contains("claude-4-5")
            || model_lower.contains("sonnet-4-5")
            || model_lower.contains("haiku-4-5")
            || model_lower.contains("opus-4-5") // 添加 Opus 4.5 变体
    }

    /// 检查模型是否支持 Extended Thinking
    ///
    /// 支持的模型（2025-2026）：
    /// - Claude Opus 4.5, 4.1, 4
    /// - Claude Sonnet 4.5, 4, 3.7
    /// - Claude Haiku 4.5
    /// - **注意：Claude 3.5 不支持**
    fn supports_extended_thinking(model: &str) -> bool {
        let model_lower = model.to_lowercase();

        // Claude 4.x 系列
        model_lower.contains("claude-opus-4")
            || model_lower.contains("claude-sonnet-4")
            || model_lower.contains("claude-haiku-4")
            || model_lower.contains("opus-4")
            || model_lower.contains("sonnet-4")
            || model_lower.contains("haiku-4")
            // Claude 3.7 Sonnet（已弃用但仍支持）
            || model_lower.contains("claude-3-7-sonnet")
            || model_lower.contains("claude-3.7-sonnet")
    }

    /// 限制 top_p 到 Extended Thinking 允许的范围 (0.95-1.0)
    fn clamp_top_p_for_thinking(top_p: f64) -> f64 {
        if top_p < 0.95 {
            0.95
        } else if top_p > 1.0 {
            1.0
        } else {
            top_p
        }
    }

    /// 验证并限制 budget_tokens
    ///
    /// 规则：
    /// - 最小值：1024
    /// - 最大值：32768（官方建议超过此值使用 batch processing）
    /// - 必须小于 max_tokens（如果提供）
    fn validate_budget_tokens(budget: Option<i32>, max_tokens: Option<i32>) -> i32 {
        let budget = budget.filter(|&b| b > 0).unwrap_or(DEFAULT_BUDGET_TOKENS);

        // 应用上下限
        let mut validated = budget.max(MIN_BUDGET_TOKENS).min(MAX_BUDGET_TOKENS);

        // 确保 budget_tokens < max_tokens
        if let Some(max) = max_tokens {
            if max <= 1 {
                // max_tokens 太小，无法满足 budget_tokens < max_tokens 约束
                validated = 1;
                log::warn!(
                    "[AnthropicAdapter] max_tokens ({}) too small; forcing budget_tokens to {}",
                    max,
                    validated
                );
                return validated;
            }

            if max <= MIN_BUDGET_TOKENS {
                // 无法满足 >=1024 且 < max_tokens 的约束，优先保证 < max_tokens
                validated = (max - 1).max(1);
                log::warn!(
                    "[AnthropicAdapter] max_tokens ({}) <= MIN_BUDGET_TOKENS; using budget_tokens {} below minimum",
                    max, validated
                );
                return validated;
            }

            if validated >= max {
                // budget_tokens 必须小于 max_tokens
                validated = (max - 1).max(MIN_BUDGET_TOKENS);
                log::warn!(
                    "[AnthropicAdapter] budget_tokens ({}) >= max_tokens ({}), clamped to {}",
                    budget,
                    max,
                    validated
                );
            }
        }

        validated
    }
}

impl RequestAdapter for AnthropicAdapter {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn label(&self) -> &'static str {
        "Anthropic Claude"
    }

    fn description(&self) -> &'static str {
        "Claude 系列，支持 extended thinking 扩展思维"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // Claude 不支持 frequency_penalty 和 presence_penalty
        body.remove("frequency_penalty");
        body.remove("presence_penalty");

        let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);

        if enable_thinking_value {
            // ========== Extended Thinking 模式采样参数限制 ==========
            // 根据官方文档：
            // - temperature: 必须移除（不兼容）
            // - top_k: 必须移除（不兼容）
            // - top_p: 可选，但必须在 0.95-1.0 范围内

            // 移除 temperature（Extended thinking 不兼容）
            if body.contains_key("temperature") {
                body.remove("temperature");
                log::debug!(
                    "[AnthropicAdapter] Extended Thinking: removed temperature (not compatible)"
                );
            }

            // 移除 top_k（Extended thinking 不兼容）
            if body.contains_key("top_k") {
                body.remove("top_k");
                log::debug!("[AnthropicAdapter] Extended Thinking: removed top_k (not compatible)");
            }

            // 限制 top_p 到 0.95-1.0 范围
            if let Some(top_p) = body.get("top_p").and_then(|v| v.as_f64()) {
                if top_p < 0.95 || top_p > 1.0 {
                    let clamped = Self::clamp_top_p_for_thinking(top_p);
                    body.insert("top_p".to_string(), json!(clamped));
                    log::debug!(
                        "[AnthropicAdapter] Extended Thinking: clamped top_p from {} to {} (allowed: 0.95-1.0)",
                        top_p, clamped
                    );
                }
            }

            // 验证模型是否支持 Extended Thinking
            if !Self::supports_extended_thinking(&config.model) {
                log::warn!(
                    "[AnthropicAdapter] ⚠️ Model {} may not support Extended Thinking. \
                     Supported models: Claude Opus 4.x, Sonnet 4.x/3.7, Haiku 4.5",
                    config.model
                );
            }

            // 从请求体获取 max_tokens（用于验证 budget_tokens < max_tokens）
            let max_tokens = body
                .get("max_tokens")
                .or_else(|| body.get("max_completion_tokens"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            // 验证并限制 budget_tokens
            // 规则：
            // - 最小值：1024
            // - 最大值：32768（官方建议超过此值使用 batch processing）
            // - 必须小于 max_tokens
            let budget_tokens = Self::validate_budget_tokens(config.thinking_budget, max_tokens);

            let thinking = json!({
                "type": "enabled",
                "budget_tokens": budget_tokens as u32
            });
            body.insert("thinking".to_string(), thinking);
        } else {
            // ========== 非 Extended Thinking 模式 ==========
            // Claude 4.5: temperature 和 top_p 互斥，优先使用 temperature
            if Self::is_claude_45(&config.model) {
                let has_temperature = body.contains_key("temperature");
                let has_top_p = body.contains_key("top_p");

                if has_temperature && has_top_p {
                    body.remove("top_p");
                    log::debug!("[AnthropicAdapter] Claude 4.5: removed top_p (mutually exclusive with temperature)");
                }
            }
        }

        false
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // Anthropic 支持采样参数
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // Anthropic 使用 DeepSeek 风格的思维链回传
        if config.thinking_enabled {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }

    fn format_tool_call_message(
        &self,
        tool_calls: &[Value],
        thinking_content: Option<&str>,
    ) -> Option<Value> {
        // Anthropic 要求：thinking 块必须在 tool_use 块之前
        let mut content_blocks = Vec::new();

        // 先添加 thinking 块
        if let Some(thinking) = thinking_content {
            if !thinking.is_empty() {
                content_blocks.push(json!({
                    "type": "thinking",
                    "thinking": thinking
                }));
            }
        }

        // 再添加 tool_use 块
        for tool_call in tool_calls {
            if let Some(tc) = tool_call.as_object() {
                let tool_use = json!({
                    "type": "tool_use",
                    "id": tc.get("id").cloned().unwrap_or(json!("")),
                    "name": tc.get("function").and_then(|f| f.get("name")).cloned().unwrap_or(json!("")),
                    "input": tc.get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(json!({}))
                });
                content_blocks.push(tool_use);
            }
        }

        if content_blocks.is_empty() {
            None
        } else {
            Some(json!(content_blocks))
        }
    }

    fn requires_thinking_in_history(&self, config: &ApiConfig) -> bool {
        // Anthropic 最佳实践：使用 thinking + tool calling 时
        // 必须在发送工具结果时保留之前的 thinking_blocks
        config.thinking_enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extended_thinking_format() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(8192),
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(8192)));
    }

    #[test]
    fn test_minimum_budget_tokens() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(100), // 低于 1024
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // 应该被提升到 1024
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(1024)));
    }

    #[test]
    fn test_default_budget_tokens() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: None,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // 默认 10240
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(10240)));
    }

    // ========== Extended Thinking 采样参数限制测试 ==========

    #[test]
    fn test_extended_thinking_removes_temperature() {
        // Extended Thinking 模式必须移除 temperature
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // temperature 必须被移除
        assert!(!body.contains_key("temperature"));
        // thinking 应该存在
        assert!(body.contains_key("thinking"));
    }

    #[test]
    fn test_extended_thinking_removes_top_k() {
        // Extended Thinking 模式必须移除 top_k
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_k".to_string(), json!(40));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_k 必须被移除
        assert!(!body.contains_key("top_k"));
    }

    #[test]
    fn test_extended_thinking_clamps_top_p() {
        // Extended Thinking 模式下 top_p 必须在 0.95-1.0 范围
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.8)); // 低于 0.95

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_p 应该被限制到 0.95
        assert_eq!(body.get("top_p"), Some(&json!(0.95)));
    }

    #[test]
    fn test_extended_thinking_keeps_valid_top_p() {
        // Extended Thinking 模式下，有效范围内的 top_p 应该保留
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.97)); // 在有效范围内

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_p 应该保持不变
        assert_eq!(body.get("top_p"), Some(&json!(0.97)));
    }

    #[test]
    fn test_supports_extended_thinking_check() {
        // Claude 4.x 支持 Extended Thinking
        assert!(AnthropicAdapter::supports_extended_thinking(
            "claude-sonnet-4"
        ));
        assert!(AnthropicAdapter::supports_extended_thinking(
            "claude-opus-4-5"
        ));
        assert!(AnthropicAdapter::supports_extended_thinking(
            "claude-haiku-4-5"
        ));
        assert!(AnthropicAdapter::supports_extended_thinking(
            "claude-3-7-sonnet"
        ));

        // Claude 3.5 不支持 Extended Thinking
        assert!(!AnthropicAdapter::supports_extended_thinking(
            "claude-3-5-sonnet"
        ));
        assert!(!AnthropicAdapter::supports_extended_thinking(
            "claude-3-opus"
        ));
    }

    #[test]
    fn test_is_claude_45_includes_opus() {
        // Claude Opus 4.5 应该被正确识别
        assert!(AnthropicAdapter::is_claude_45("claude-opus-4.5"));
        assert!(AnthropicAdapter::is_claude_45("claude-opus-4-5"));
        assert!(AnthropicAdapter::is_claude_45("opus-4-5-20251101"));

        // 其他 4.5 模型
        assert!(AnthropicAdapter::is_claude_45("claude-sonnet-4.5"));
        assert!(AnthropicAdapter::is_claude_45("claude-haiku-4.5"));

        // 非 4.5 模型
        assert!(!AnthropicAdapter::is_claude_45("claude-sonnet-4"));
        assert!(!AnthropicAdapter::is_claude_45("claude-opus-4"));
        assert!(!AnthropicAdapter::is_claude_45("claude-3-5-sonnet"));
    }

    #[test]
    fn test_budget_tokens_upper_limit() {
        // budget_tokens 应该被限制到 32768
        let validated = AnthropicAdapter::validate_budget_tokens(Some(50000), None);
        assert_eq!(validated, 32768);
    }

    #[test]
    fn test_budget_tokens_lower_limit() {
        // budget_tokens 应该被提升到 1024
        let validated = AnthropicAdapter::validate_budget_tokens(Some(500), None);
        assert_eq!(validated, 1024);
    }

    #[test]
    fn test_budget_tokens_less_than_max_tokens() {
        // budget_tokens 必须小于 max_tokens
        let validated = AnthropicAdapter::validate_budget_tokens(Some(10000), Some(8000));
        // 10000 >= 8000，应该被限制到 max_tokens - 1 = 7999
        assert_eq!(validated, 7999);
    }

    #[test]
    fn test_budget_tokens_valid_range() {
        // 有效范围内的 budget_tokens 应该保持不变
        let validated = AnthropicAdapter::validate_budget_tokens(Some(8192), Some(16000));
        assert_eq!(validated, 8192);
    }

    #[test]
    fn test_budget_tokens_with_body_max_tokens() {
        // 测试从请求体获取 max_tokens 的场景
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(20000), // 大于 max_tokens
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(16000)); // max_tokens = 16000

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // budget_tokens 应该被限制到 15999 (max_tokens - 1)
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(15999)));
    }

    #[test]
    fn test_budget_tokens_when_max_tokens_too_small() {
        // max_tokens 太小时，预算应降级到 max_tokens - 1
        let validated = AnthropicAdapter::validate_budget_tokens(Some(5000), Some(512));
        assert_eq!(validated, 511);
    }

    #[test]
    fn test_budget_tokens_when_max_tokens_is_one() {
        // max_tokens <= 1 时无法满足约束，使用最小可用值
        let validated = AnthropicAdapter::validate_budget_tokens(Some(5000), Some(1));
        assert_eq!(validated, 1);
    }

    // ========== 非 Extended Thinking 模式测试 ==========

    #[test]
    fn test_claude_45_temperature_top_p_mutual_exclusion() {
        // 非 thinking 模式下，Claude 4.5 的 temperature 和 top_p 互斥
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false, // 非 thinking 模式
            model: "claude-sonnet-4-5-20250929".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("temperature"));
        assert!(!body.contains_key("top_p"));
    }

    #[test]
    fn test_claude_45_removes_penalty_params() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            model: "claude-4.5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("presence_penalty"));
    }

    #[test]
    fn test_older_claude_keeps_top_p_with_temperature() {
        // 非 thinking 模式，非 4.5 模型，保留两个参数
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-3-5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
    }

    #[test]
    fn test_claude_45_keeps_top_p_when_no_temperature() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-4.5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("top_p"));
        assert!(!body.contains_key("temperature"));
    }

    #[test]
    fn test_older_claude_also_removes_penalty_params() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            model: "claude-3-5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("presence_penalty"));
    }
}
