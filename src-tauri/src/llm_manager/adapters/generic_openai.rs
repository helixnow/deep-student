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
//! - OpenAI Chat Completions 使用顶级参数：`reasoning_effort`, `verbosity`
//! - OpenRouter Chat Completions 使用嵌套格式：`reasoning: { effort }`
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
/// - 供应商侧的 enabled/disabled/adaptive/max 会归一到标准 effort
/// - toggle-only 配置会归一为 medium/none，避免向反代发送供应商原生字段
pub struct GenericOpenAIAdapter;

impl GenericOpenAIAdapter {
    fn is_openrouter(config: &ApiConfig) -> bool {
        config
            .provider_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("openrouter"))
            || config
                .provider_scope
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("openrouter"))
            || reqwest::Url::parse(config.base_url.trim())
                .ok()
                .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
                .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
    }

    fn is_siliconflow(config: &ApiConfig) -> bool {
        config
            .provider_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("siliconflow"))
            || config
                .provider_scope
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("siliconflow"))
            || config.base_url.to_lowercase().contains("siliconflow.cn")
            || config.base_url.to_lowercase().contains("siliconflow.com")
    }

    fn siliconflow_budget_from_effort(effort: &str) -> Option<i32> {
        match effort.trim().to_lowercase().as_str() {
            "minimal" | "low" => Some(2048),
            "medium" => Some(8192),
            "high" => Some(16384),
            "xhigh" | "max" => Some(32768),
            _ => None,
        }
    }

    fn requested_effort(config: &ApiConfig) -> Option<&str> {
        get_trimmed_effort(config).or_else(|| {
            config
                .effort
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
    }

    fn normalize_standard_effort(effort: &str) -> Option<&'static str> {
        match effort.trim().to_lowercase().as_str() {
            "none" | "disabled" | "off" | "false" => Some("none"),
            "minimal" => Some("minimal"),
            "low" => Some("low"),
            "medium" | "enabled" | "adaptive" | "auto" | "on" | "true" => Some("medium"),
            "high" => Some("high"),
            "xhigh" | "max" => Some("xhigh"),
            _ => None,
        }
    }

    fn effort_from_budget(budget: i32) -> &'static str {
        match budget {
            i32::MIN..=-1 => "medium",
            0 => "none",
            1..=2048 => "low",
            2049..=8192 => "medium",
            8193..=16384 => "high",
            _ => "xhigh",
        }
    }

    fn insert_reasoning_effort(
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        effort: &'static str,
    ) {
        if Self::is_openrouter(config) {
            body.remove("reasoning_effort");
            if let Some(reasoning) = body.get_mut("reasoning").and_then(Value::as_object_mut) {
                // OpenRouter accepts effort or max_tokens, but not both.
                reasoning.remove("max_tokens");
                reasoning.remove("enabled");
                reasoning.insert("effort".to_string(), json!(effort));
            } else {
                body.insert("reasoning".to_string(), json!({ "effort": effort }));
            }
        } else {
            body.insert("reasoning_effort".to_string(), json!(effort));
            body.remove("reasoning");
        }
    }

    /// 验证 reasoning_effort 值是否有效
    fn is_valid_effort(effort: &str) -> bool {
        matches!(
            effort.to_lowercase().as_str(),
            "none"
                | "disabled"
                | "off"
                | "false"
                | "minimal"
                | "low"
                | "medium"
                | "enabled"
                | "adaptive"
                | "auto"
                | "on"
                | "true"
                | "high"
                | "xhigh"
                | "max"
                | "unset"
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
        if let Some(effort) = Self::requested_effort(config) {
            let trimmed = effort.trim().to_lowercase();
            if !trimmed.is_empty() {
                // 用户显式设置了 reasoning_effort
                // "none" 或 "unset" 表示禁用推理，应保留采样参数
                if trimmed == "unset" || Self::normalize_standard_effort(&trimmed) == Some("none") {
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
        // 只有开关而没有显式 effort 时，以最终开关状态决定是否移除采样参数。
        if !(config.is_reasoning || config.supports_reasoning)
            || !resolve_enable_thinking(config, None)
        {
            return false;
        }

        config
            .thinking_budget
            .map(Self::effort_from_budget)
            .is_none_or(|effort| effort != "none")
    }
}

impl RequestAdapter for GenericOpenAIAdapter {
    fn id(&self) -> &'static str {
        "general"
    }

    fn label(&self) -> &'static str {
        "OpenAI Compatible"
    }

    fn description(&self) -> &'static str {
        "适用于大多数 OpenAI 兼容模型参数格式；具体请求协议由 OpenAI 协议决定"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        let mut early_return = false;

        if Self::is_siliconflow(config) && (config.supports_reasoning || config.is_reasoning) {
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
            body.insert("enable_thinking".to_string(), json!(enable_thinking_value));
            body.remove("reasoning_effort");
            body.remove("reasoning");
            body.remove("thinking");

            if enable_thinking_value {
                let budget = config.thinking_budget.or_else(|| {
                    get_trimmed_effort(config).and_then(Self::siliconflow_budget_from_effort)
                });
                if let Some(budget) = budget {
                    body.insert(
                        "thinking_budget".to_string(),
                        json!(budget.clamp(128, 32768)),
                    );
                } else {
                    body.remove("thinking_budget");
                }
            } else {
                body.remove("thinking_budget");
            }

            return false;
        }

        // Chat Completions API: temperature/top_p 仅在 reasoning_effort="none" 时支持
        // 其他 reasoning_effort 值会导致 API 报错（不是被忽略）
        if Self::should_remove_sampling_for_reasoning(config) {
            body.remove("temperature");
            body.remove("top_p");
            body.remove("logprobs");
        }

        // 处理标准推理强度。OpenRouter Chat 使用 reasoning.effort；
        // OpenAI 与 one-api/sub2api/CPA 等兼容宿主使用顶级 reasoning_effort。
        // 供应商原生开关只在对应官方适配器中发送。
        let requested_effort = Self::requested_effort(config);
        let has_reasoning_effort = requested_effort.is_some();

        // Generic/OpenAI-compatible hosts must not receive model-vendor native fields.
        body.remove("enable_thinking");
        body.remove("thinking_budget");
        body.remove("include_thoughts");
        body.remove("thinking");
        body.remove("output_config");

        if has_reasoning_effort {
            // OpenAI 官方 Chat Completions API 格式：使用顶级参数
            if let Some(effort) = requested_effort {
                let requested = effort.to_lowercase();
                if requested == "unset" {
                    // unset 表示沿用服务端默认，不发送强度字段。
                    body.remove("reasoning_effort");
                    body.remove("reasoning");
                    early_return = true;
                } else if let Some(normalized) = Self::normalize_standard_effort(effort) {
                    if normalized == "none" {
                        // 显式关闭语义必须透传 none；Responses 适配器会保留嵌套格式。
                        Self::insert_reasoning_effort(body, config, "none");
                        early_return = true;
                    } else {
                        Self::insert_reasoning_effort(body, config, normalized);
                    }
                } else {
                    body.remove("reasoning_effort");
                    body.remove("reasoning");
                    log::warn!(
                        "[GenericOpenAIAdapter] Invalid reasoning_effort: {}. Omitting it.",
                        requested
                    );
                }
            }

            // Chat Completions API: verbosity 是顶级参数
            if let Some(ref verbosity) = config.verbosity {
                let v = verbosity.trim().to_lowercase();
                if !v.is_empty() && matches!(v.as_str(), "low" | "medium" | "high") {
                    body.insert("verbosity".to_string(), json!(v));
                }
            }
        } else if config.supports_reasoning || config.is_reasoning {
            // 只有开关/预算的供应商配置统一映射到 OpenAI 标准 effort。
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
            let normalized = if enable_thinking_value {
                config
                    .thinking_budget
                    .map(Self::effort_from_budget)
                    .unwrap_or("medium")
            } else {
                "none"
            };
            Self::insert_reasoning_effort(body, config, normalized);
        }

        early_return
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        !Self::is_siliconflow(config) && Self::should_remove_sampling_for_reasoning(config)
    }

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
        if let Some(ref verbosity) = config.verbosity {
            let normalized = verbosity.trim().to_lowercase();
            if matches!(normalized.as_str(), "low" | "medium" | "high") {
                body.insert("verbosity".to_string(), json!(normalized));
            }
        }
        body.remove("effort");
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

        assert_eq!(body.get("reasoning_effort"), Some(&json!("medium")));
        assert!(!body.contains_key("enable_thinking"));
        assert!(!body.contains_key("thinking_budget"));
        assert!(!body.contains_key("include_thoughts"));
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
    fn test_provider_aliases_normalize_to_standard_effort() {
        let adapter = GenericOpenAIAdapter;

        for (input, expected) in [
            ("disabled", "none"),
            ("enabled", "medium"),
            ("adaptive", "medium"),
            ("auto", "medium"),
            ("max", "xhigh"),
        ] {
            let config = ApiConfig {
                reasoning_effort: Some(input.to_string()),
                ..Default::default()
            };
            let mut body = Map::new();
            adapter.apply_reasoning_config(&mut body, &config, None);
            assert_eq!(
                body.get("reasoning_effort"),
                Some(&json!(expected)),
                "input={input}"
            );
        }
    }

    #[test]
    fn test_toggle_and_budget_only_use_standard_effort() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            thinking_budget: Some(20000),
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("enable_thinking".to_string(), json!(true));
        body.insert("thinking_budget".to_string(), json!(20000));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("xhigh")));
        assert!(!body.contains_key("enable_thinking"));
        assert!(!body.contains_key("thinking_budget"));
        assert!(!body.contains_key("include_thoughts"));
    }

    #[test]
    fn test_openrouter_chat_uses_nested_reasoning_effort_and_preserves_options() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            provider_type: Some("custom".to_string()),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("reasoning_effort".to_string(), json!("low"));
        body.insert(
            "reasoning".to_string(),
            json!({ "max_tokens": 4096, "enabled": false, "exclude": true }),
        );

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body["reasoning"]["effort"], json!("high"));
        assert_eq!(body["reasoning"]["exclude"], json!(true));
        assert!(body["reasoning"].get("max_tokens").is_none());
        assert!(body["reasoning"].get("enabled").is_none());
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_openrouter_chat_none_keeps_sampling_and_uses_nested_reasoning() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            provider_scope: Some("openrouter".to_string()),
            base_url: "https://proxy.example.com/v1".to_string(),
            reasoning_effort: Some("none".to_string()),
            supports_reasoning: true,
            is_reasoning: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body["reasoning"]["effort"], json!("none"));
        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_openrouter_lookalike_host_keeps_generic_top_level_dialect() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            provider_type: Some("custom".to_string()),
            base_url: "https://openrouter.ai.evil.example/v1".to_string(),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body["reasoning_effort"], json!("high"));
        assert!(!body.contains_key("reasoning"));
    }

    #[test]
    fn test_gemini_dynamic_and_zero_budgets_keep_distinct_semantics() {
        let adapter = GenericOpenAIAdapter;

        for (budget, expected_effort, removes_sampling) in
            [(-1, "medium", true), (0, "none", false)]
        {
            let config = ApiConfig {
                supports_reasoning: true,
                thinking_enabled: true,
                thinking_budget: Some(budget),
                ..Default::default()
            };
            let mut body = Map::new();
            body.insert("temperature".to_string(), json!(0.7));

            assert_eq!(
                adapter.should_remove_sampling_params(&config),
                removes_sampling,
                "budget={budget}"
            );
            adapter.apply_reasoning_config(&mut body, &config, None);

            assert_eq!(
                body.get("reasoning_effort"),
                Some(&json!(expected_effort)),
                "budget={budget}"
            );
            assert_eq!(
                body.contains_key("temperature"),
                !removes_sampling,
                "budget={budget}"
            );
        }
    }

    #[test]
    fn test_legacy_anthropic_effort_is_normalized_without_leaking_effort() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            effort: Some("max".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);
        adapter.apply_common_params(&mut body, &config);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("xhigh")));
        assert!(!body.contains_key("effort"));
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

        // reasoning_effort="none" 时保留 temperature，并显式透传关闭语义
        assert!(body.contains_key("temperature"));
        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
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
    fn test_toggle_off_keeps_sampling_and_sends_standard_none() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            enable_thinking: Some(false),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        assert!(!adapter.should_remove_sampling_params(&config));
        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
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

    #[test]
    fn test_siliconflow_glm_depth_uses_budget_dialect() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            provider_type: Some("siliconflow".to_string()),
            provider_scope: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            model: "THUDM/GLM-5.2".to_string(),
            model_adapter: "zhipu".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            thinking_enabled: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("reasoning_effort".to_string(), json!("high"));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("thinking_budget"), Some(&json!(16384)));
        assert!(!body.contains_key("reasoning_effort"));
        assert!(body.contains_key("temperature"));
    }

    #[test]
    fn test_siliconflow_off_clears_stale_depth() {
        let adapter = GenericOpenAIAdapter;
        let config = ApiConfig {
            provider_type: Some("siliconflow".to_string()),
            model: "THUDM/GLM-5.2".to_string(),
            supports_reasoning: true,
            enable_thinking: Some(false),
            reasoning_effort: Some("high".to_string()),
            thinking_budget: Some(16384),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        assert_eq!(body.get("enable_thinking"), Some(&json!(false)));
        assert!(!body.contains_key("thinking_budget"));
        assert!(!body.contains_key("reasoning_effort"));
    }
}
