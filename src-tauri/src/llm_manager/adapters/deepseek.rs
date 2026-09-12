//! DeepSeek 专用适配器
//!
//! DeepSeek API 的推理参数格式：
//!
//! ## DeepSeek 官方 API（api.deepseek.com）
//! - `thinking: { type: "enabled" | "disabled" }`
//! - DeepSeek V4 / V4.1: `reasoning_effort: "low" | "high" | "max"`
//!
//! ## SiliconFlow 平台（api.siliconflow.cn）
//! - `enable_thinking: true | false`
//! - DeepSeek V3.2: `thinking_budget: number`
//! - DeepSeek V4: `reasoning_effort: "high" | "max"` if SiliconFlow exposes that V4 dialect
//!
//! - DeepSeek-R1/V3.2/V4 系列是原生推理模型
//! - V3.1 使用函数调用时需禁用思维模式
//!
//! 参考文档：
//! - DeepSeek: https://api-docs.deepseek.com/
//! - SiliconFlow: https://docs.siliconflow.com/

use super::{get_trimmed_effort, resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use crate::models::AppError;
use serde_json::{json, Map, Value};

/// DeepSeek 专用适配器
///
/// DeepSeek 模型的参数处理：
/// - DeepSeek 官方 API: 使用 `thinking: { type: "enabled" }` 格式
/// - SiliconFlow 平台: 使用 `enable_thinking: true`，V3.2 映射 `thinking_budget`，V4 映射 high/max effort
/// - V3.1: 使用函数调用时需禁用 thinking 相关字段
pub struct DeepSeekAdapter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeepSeekModelVersion {
    V31,
    V32,
    V4,
    LegacyAlias,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeepSeekHostProtocol {
    Official,
    SiliconFlow,
    OtherHosted,
}

impl DeepSeekAdapter {
    fn classify_model(model: &str) -> DeepSeekModelVersion {
        let model_lower = model.to_lowercase();

        if model_lower.contains("deepseek-v3.1")
            || model_lower.contains("deepseek-ai/deepseek-v3.1")
            || model_lower.contains("pro/deepseek-ai/deepseek-v3.1")
        {
            return DeepSeekModelVersion::V31;
        }

        if model_lower.contains("deepseek-v3.2") {
            return DeepSeekModelVersion::V32;
        }

        if model_lower.contains("deepseek-v4") || model_lower.contains("deepseek-flash") {
            return DeepSeekModelVersion::V4;
        }

        if matches!(model_lower.as_str(), "deepseek-chat" | "deepseek-reasoner") {
            return DeepSeekModelVersion::LegacyAlias;
        }

        DeepSeekModelVersion::Unknown
    }

    /// 检查是否是 DeepSeek V3.1（需要特殊处理工具调用）
    fn is_v31(model: &str) -> bool {
        Self::classify_model(model) == DeepSeekModelVersion::V31
    }

    /// 检查请求是否包含工具调用
    fn has_tools(body: &Map<String, Value>) -> bool {
        body.contains_key("tools") || body.contains_key("tool_choice")
    }

    /// 检查是否是 SiliconFlow 平台
    ///
    /// SiliconFlow 使用不同的参数格式：enable_thinking 而不是 thinking.type
    fn host_protocol(config: &ApiConfig) -> DeepSeekHostProtocol {
        // 通过 base_url 检测
        let base_url_lower = config.base_url.to_lowercase();
        if base_url_lower.contains("siliconflow") {
            return DeepSeekHostProtocol::SiliconFlow;
        }
        // 通过 provider_type 检测
        if let Some(ref pt) = config.provider_type {
            if pt.to_lowercase() == "siliconflow" {
                return DeepSeekHostProtocol::SiliconFlow;
            }
        }

        if crate::llm_manager::is_official_deepseek_config(config) {
            return DeepSeekHostProtocol::Official;
        }

        DeepSeekHostProtocol::OtherHosted
    }

    fn is_v4_effort_capable(version: DeepSeekModelVersion) -> bool {
        matches!(
            version,
            DeepSeekModelVersion::V4 | DeepSeekModelVersion::LegacyAlias
        )
    }

    fn is_v4_thinking_sampling_limited(version: DeepSeekModelVersion) -> bool {
        matches!(
            version,
            DeepSeekModelVersion::V4 | DeepSeekModelVersion::LegacyAlias
        )
    }

    fn resolve_deepseek_thinking(
        config: &ApiConfig,
        version: DeepSeekModelVersion,
        override_value: Option<bool>,
    ) -> bool {
        if let Some(value) = override_value {
            return value;
        }
        if let Some(value) = config.enable_thinking {
            return value;
        }

        // Official V4 model ids default to enabled; aliases still follow saved config.
        if version == DeepSeekModelVersion::V4 {
            return true;
        }
        if config.supports_reasoning && Self::is_v4_effort_capable(version) {
            return true;
        }

        resolve_enable_thinking(config, None)
    }

    fn normalize_v4_reasoning_effort(effort: &str) -> Option<&'static str> {
        match effort.trim().to_lowercase().as_str() {
            "none" | "unset" => None,
            // 官方映射表：minimal/low → low，medium/high → high
            "minimal" | "low" => Some("low"),
            "medium" | "high" | "xhigh" => Some("high"),
            "max" | "ultra" => Some("max"),
            _ => None,
        }
    }

    fn v32_budget_from_effort(effort: &str) -> Option<i32> {
        match effort.trim().to_lowercase().as_str() {
            "low" => Some(2048),
            "medium" => Some(8192),
            "high" => Some(16384),
            "xhigh" | "max" => Some(32768),
            _ => None,
        }
    }

    fn resolve_siliconflow_thinking_budget(
        config: &ApiConfig,
        version: DeepSeekModelVersion,
    ) -> Option<i32> {
        if matches!(
            version,
            DeepSeekModelVersion::V31 | DeepSeekModelVersion::V32
        ) {
            if let Some(mapped) = get_trimmed_effort(config).and_then(Self::v32_budget_from_effort)
            {
                return Some(mapped);
            }
        }
        config.thinking_budget
    }

    fn should_apply_reasoning_effort(
        config: &ApiConfig,
        version: DeepSeekModelVersion,
        host: DeepSeekHostProtocol,
        enable_thinking_value: bool,
    ) -> Option<&'static str> {
        if !enable_thinking_value || !Self::is_v4_effort_capable(version) {
            return None;
        }

        get_trimmed_effort(config).and_then(|effort| {
            // Hosted deployments retain their existing xhigh dialect.
            if host != DeepSeekHostProtocol::Official && effort.eq_ignore_ascii_case("xhigh") {
                Some("max")
            } else {
                Self::normalize_v4_reasoning_effort(effort)
            }
        })
    }
}

pub(crate) fn is_official_deepseek_v4(config: &ApiConfig) -> bool {
    DeepSeekAdapter::host_protocol(config) == DeepSeekHostProtocol::Official
        && DeepSeekAdapter::is_v4_effort_capable(DeepSeekAdapter::classify_model(&config.model))
}

pub(crate) fn uses_deepseek_v41_image_tokens(config: &ApiConfig) -> bool {
    DeepSeekAdapter::host_protocol(config) == DeepSeekHostProtocol::Official
        && matches!(
            config.model.trim().to_ascii_lowercase().as_str(),
            "deepseek-flash" | "deepseek-v4-flash-vision-exp"
        )
}

/// Official V4/V4.1 sampling follows the resolved request mode, not `is_reasoning`.
fn apply_official_sampling(body: &mut Map<String, Value>, thinking: bool) {
    body.remove("presence_penalty");
    body.remove("frequency_penalty");
    if thinking {
        body.remove("temperature");
        if let Some(top_p) = body.get("top_p").and_then(Value::as_f64) {
            body.insert("top_p".to_string(), json!(top_p.clamp(0.95, 1.0)));
        }
    } else {
        // Non-thinking top_p is fixed at 1.0 by the provider.
        body.remove("top_p");
    }
}

/// Apply the official output cap and sampling dialect after generic reasoning assembly.
/// Explicit caller budgets win; 8K/64K/128K are defaults, never minimums.
pub(crate) fn apply_official_deepseek_generation_params(
    body: &mut Value,
    config: &ApiConfig,
) -> bool {
    if !is_official_deepseek_v4(config) {
        return false;
    }
    let Some(map) = body.as_object_mut() else {
        return false;
    };
    let thinking = map
        .get("thinking")
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
        != Some("disabled");
    let default_tokens = if !thinking {
        8_192
    } else if map.get("reasoning_effort").and_then(Value::as_str) == Some("max") {
        131_072
    } else {
        65_536
    };
    let requested = if config.max_output_tokens > 0 {
        config.max_output_tokens
    } else {
        default_tokens
    };
    let limit = config
        .max_tokens_limit
        .filter(|limit| *limit > 0)
        .unwrap_or(393_216);
    map.insert(
        "max_tokens".to_string(),
        json!(requested.min(limit).min(393_216)),
    );
    map.remove("max_completion_tokens");
    map.insert("temperature".to_string(), json!(config.temperature));
    if let Some(top_p) = config.top_p_override {
        map.insert("top_p".to_string(), json!(top_p));
    }
    apply_official_sampling(map, thinking);
    true
}

impl RequestAdapter for DeepSeekAdapter {
    fn id(&self) -> &'static str {
        "deepseek"
    }

    fn label(&self) -> &'static str {
        "DeepSeek"
    }

    fn description(&self) -> &'static str {
        "DeepSeek 系列，支持 version-aware thinking/reasoning 参数格式"
    }

    fn validate_reasoning_config(&self, config: &ApiConfig) -> Result<(), AppError> {
        let version = Self::classify_model(&config.model);
        if !Self::is_v4_effort_capable(version)
            || Self::host_protocol(config) != DeepSeekHostProtocol::Official
        {
            return Ok(());
        }
        // 思考关闭时推理强度无意义：不拦截存量脏配置，只保证「启用思考且显式给出
        // 未知强度」在网络 I/O 前失败，而不是静默丢弃（对齐 DSH）。
        if !Self::resolve_deepseek_thinking(config, version, None) {
            return Ok(());
        }
        let Some(effort) = get_trimmed_effort(config) else {
            return Ok(());
        };
        if matches!(
            effort.to_ascii_lowercase().as_str(),
            "none" | "unset" | "off"
        ) {
            return Ok(());
        }
        if Self::normalize_v4_reasoning_effort(effort).is_none() {
            return Err(AppError::validation(format!(
                "UNSUPPORTED_REASONING_EFFORT: 模型 {} 不支持推理强度 \"{}\"（支持 low/medium/high/xhigh/max）",
                config.model, effort
            )));
        }
        Ok(())
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        let version = Self::classify_model(&config.model);
        let host = Self::host_protocol(config);

        // DeepSeek V3.1 + 工具调用：禁用所有 thinking 相关字段
        if version == DeepSeekModelVersion::V31 && Self::has_tools(body) {
            // 移除可能已存在的 thinking 相关字段
            body.remove("enable_thinking");
            body.remove("thinking");
            body.remove("thinking_budget");
            body.remove("include_thoughts");
            body.remove("reasoning_effort");
            return false;
        }

        let deepseek_reasoning_capable = config.supports_reasoning
            || matches!(
                version,
                DeepSeekModelVersion::V31 | DeepSeekModelVersion::V32 | DeepSeekModelVersion::V4
            );

        // 检查是否需要启用推理模式
        if deepseek_reasoning_capable {
            let enable_thinking_value =
                Self::resolve_deepseek_thinking(config, version, enable_thinking);

            // 根据平台选择不同的参数格式
            if host == DeepSeekHostProtocol::SiliconFlow {
                // SiliconFlow 平台：V3.2 使用 thinking_budget；未来 V4 使用 high/max effort。
                body.insert("enable_thinking".to_string(), json!(enable_thinking_value));
                body.remove("thinking");

                if Self::is_v4_effort_capable(version) {
                    body.remove("thinking_budget");
                    if let Some(effort) = Self::should_apply_reasoning_effort(
                        config,
                        version,
                        host,
                        enable_thinking_value,
                    ) {
                        body.insert("reasoning_effort".to_string(), json!(effort));
                    } else {
                        body.remove("reasoning_effort");
                    }
                } else {
                    body.remove("reasoning_effort");
                    if let Some(budget) = Self::resolve_siliconflow_thinking_budget(config, version)
                    {
                        let sanitized = budget.max(128).min(32768); // SiliconFlow 范围：128-32768
                        body.insert("thinking_budget".to_string(), json!(sanitized));
                    }
                }
            } else {
                // DeepSeek 官方 API：使用 thinking: { type: "enabled" | "disabled" } 格式
                let thinking_type = if enable_thinking_value {
                    "enabled"
                } else {
                    "disabled"
                };
                body.insert("thinking".to_string(), json!({ "type": thinking_type }));
                body.remove("enable_thinking");
                body.remove("thinking_budget");

                if let Some(effort) = Self::should_apply_reasoning_effort(
                    config,
                    version,
                    host,
                    enable_thinking_value,
                ) {
                    body.insert("reasoning_effort".to_string(), json!(effort));
                } else {
                    body.remove("reasoning_effort");
                }
            }
        }

        if is_official_deepseek_v4(config) {
            let thinking = Self::resolve_deepseek_thinking(config, version, enable_thinking);
            apply_official_sampling(body, thinking);
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // DeepSeek V4 Thinking 模式不支持采样参数（设置无效但不报错）。
        // V4 模型规则跟随 DeepSeek 官方；host 只决定 payload 字段格式。
        let version = Self::classify_model(&config.model);
        let thinking_enabled = Self::resolve_deepseek_thinking(config, version, None);

        // Official V4 keeps top_p/logprobs; apply_reasoning_config removes only
        // parameters ignored by the actual request mode.
        !is_official_deepseek_v4(config)
            && thinking_enabled
            && Self::is_v4_thinking_sampling_limited(version)
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
    fn test_official_v4_reasoning_effort_medium_maps_to_high() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("medium".to_string()),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
        assert!(!body.contains_key("enable_thinking"));
    }

    #[test]
    fn test_official_v4_reasoning_effort_xhigh_maps_to_high() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("xhigh".to_string()),
            model: "deepseek-v4-flash".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_official_v4_reasoning_effort_low_stays_low() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("low".to_string()),
            model: "deepseek-flash".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("low")));
    }

    #[test]
    fn test_official_v4_reasoning_effort_ultra_maps_to_max() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("ultra".to_string()),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("max")));
    }

    #[test]
    fn test_v4_output_cap_respects_explicit_budgets_and_official_endpoint() {
        let official = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        for (requested, expected) in [
            (1024, 1024),
            (256_000, 256_000),
            (500_000, 393_216),
            (0, 131_072),
        ] {
            let config = ApiConfig {
                max_output_tokens: requested,
                ..official.clone()
            };
            let mut body = json!({"thinking": {"type": "enabled"}, "reasoning_effort": "max"});
            assert!(apply_official_deepseek_generation_params(
                &mut body, &config
            ));
            assert_eq!(body["max_tokens"], json!(expected));
            assert!(body.get("max_completion_tokens").is_none());
        }

        let third_party = ApiConfig {
            model: "deepseek-ai/DeepSeek-V4-Pro".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            ..official.clone()
        };
        assert!(!apply_official_deepseek_generation_params(
            &mut json!({}),
            &third_party
        ));
        let proxy = ApiConfig {
            provider_type: Some("deepseek".into()),
            base_url: "https://proxy.example/v1".into(),
            ..official
        };
        assert!(!is_official_deepseek_v4(&proxy));
    }

    #[test]
    fn test_v41_flash_uses_v4_thinking_and_sampling_rules() {
        // 2026-09-10 起官方主推 deepseek-flash（V4.1）：默认开启思考，
        // reasoning_effort 走 V4 high/max 方言，思考模式下移除采样参数
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("high".to_string()),
            model: "deepseek-flash".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_official_v4_rejects_unsupported_reasoning_effort_before_io() {
        let adapter = DeepSeekAdapter;
        let mut config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("ultra-mega".to_string()),
            model: "deepseek-flash".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let error = adapter
            .validate_reasoning_config(&config)
            .expect_err("unknown effort must fail fast");
        assert!(
            error.to_string().contains("UNSUPPORTED_REASONING_EFFORT"),
            "unexpected error: {error}"
        );

        for effort in ["low", "medium", "high", "xhigh", "max", "none", "unset"] {
            config.reasoning_effort = Some(effort.to_string());
            adapter
                .validate_reasoning_config(&config)
                .unwrap_or_else(|error| panic!("{effort} must pass: {error}"));
        }

        // 第三方主机沿用宽松行为，不拦截自定义方言
        config.reasoning_effort = Some("ultra-mega".to_string());
        config.base_url = "https://proxy.example.com/v1".to_string();
        adapter
            .validate_reasoning_config(&config)
            .expect("non-official hosts stay permissive");
    }

    #[test]
    fn test_official_v4_validation_skips_disabled_thinking() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            enable_thinking: Some(false),
            reasoning_effort: Some("ultra-mega".to_string()),
            model: "deepseek-flash".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        adapter
            .validate_reasoning_config(&config)
            .expect("disabled thinking makes effort irrelevant");
    }

    #[test]
    fn test_legacy_alias_supports_v4_reasoning_effort() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("high".to_string()),
            model: "deepseek-reasoner".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
        assert!(body.contains_key("thinking"));
    }

    #[test]
    fn test_official_v4_reasoning_none_still_removes_sampling_params() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("none".to_string()),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };

        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_official_v4_disable_thinking_uses_thinking_type_disabled() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            enable_thinking: Some(false),
            reasoning_effort: Some("max".to_string()),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("disabled")));
        assert!(!body.contains_key("reasoning_effort"));
        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_official_v4_disable_thinking_even_when_legacy_config_lacks_capability_flag() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: false,
            thinking_enabled: false,
            enable_thinking: Some(false),
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("disabled")));
    }

    #[test]
    fn test_siliconflow_v4_shaped_id_keeps_siliconflow_format() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("max".to_string()),
            model: "deepseek-ai/DeepSeek-V4-Pro".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            thinking_budget: Some(50000),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("reasoning_effort"), Some(&json!("max")));
        assert!(!body.contains_key("thinking_budget"));
        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_siliconflow_v32_depth_presets_map_to_budget() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            reasoning_effort: Some("low".to_string()),
            model: "deepseek-ai/DeepSeek-V3.2".to_string(),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("thinking_budget"), Some(&json!(2048)));
        assert!(!body.contains_key("reasoning_effort"));
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
    fn test_remove_sampling_params_for_v4_thinking() {
        let adapter = DeepSeekAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            model: "deepseek-v4-pro".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            ..Default::default()
        };

        // Official DeepSeek V4 keeps the supported sampling dialect; the
        // provider-specific adapter removes only parameters that are invalid
        // for the resolved request mode.
        assert!(!adapter.should_remove_sampling_params(&config));
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
