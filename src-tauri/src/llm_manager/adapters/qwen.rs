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
            || config.base_url.contains("qianwenaiapi.com")
    }

    fn clamp_siliconflow_thinking_budget(budget: i32) -> i32 {
        budget.clamp(128, 32768)
    }

    fn supports_preserve_thinking(model: &str) -> bool {
        let normalized = model.trim().to_lowercase();
        normalized.contains("qwen3.6") || normalized.contains("qwen3.7")
    }

    /// Qwen3.8 系（max/flash/27b/omni，2026-10 千问AI平台官方文档）：
    /// 支持顶层 `reasoning_effort` 档位（low/medium/xhigh，默认 xhigh）。
    /// 仅匹配 `qwen3.8` 前缀；`Qwen3-8B` 等开源 8B 型号不受影响。
    fn is_qwen38_effort_model(model: &str) -> bool {
        model
            .trim()
            .to_lowercase()
            .rsplit('/')
            .next()
            .is_some_and(|seg| seg.starts_with("qwen3.8"))
    }

    fn is_qwen38_omni_model(model: &str) -> bool {
        let model = model.trim().to_lowercase();
        model.contains("qwen3.8") && model.contains("omni")
    }

    /// Qwen3.8 effort 归一：官方直接档位 low/medium/xhigh（默认 xhigh），
    /// 兼容取值 minimal→low、high/max→xhigh。
    /// None 表示未配置/关闭（关闭走 enable_thinking=false；omni 走 effort:"none"）。
    fn normalize_qwen38_effort(effort: Option<&str>, is_omni: bool) -> Option<&'static str> {
        match effort.map(str::trim).map(str::to_lowercase).as_deref() {
            None | Some("") | Some("unset") => None,
            Some("none") if is_omni => Some("none"),
            Some("none") => None,
            Some("minimal") | Some("low") => Some("low"),
            Some("medium") => Some("medium"),
            Some("high") | Some("xhigh") | Some("max") | Some("ultra") => Some("xhigh"),
            Some(_) => None,
        }
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
        let is_qwen38 = Self::is_qwen38_effort_model(&config.model);
        let is_qwen38_omni = is_qwen38 && Self::is_qwen38_omni_model(&config.model);
        let mut qwen38_effort = if is_qwen38 {
            Self::normalize_qwen38_effort(get_trimmed_effort(config), is_qwen38_omni)
        } else {
            None
        };
        if config.supports_reasoning || forced_thinking {
            let enable_thinking_value =
                forced_thinking || resolve_enable_thinking(config, enable_thinking);
            body.insert("enable_thinking".to_string(), json!(enable_thinking_value));

            // omni 关闭思考只能通过 effort:"none"（enable_thinking 不生效）。
            if is_qwen38 && is_qwen38_omni && !enable_thinking_value {
                qwen38_effort = Some("none");
            }

            if is_dashscope && Self::supports_preserve_thinking(&config.model) {
                body.insert(
                    "preserve_thinking".to_string(),
                    json!(enable_thinking_value && config.include_thoughts),
                );
            }

            // Qwen3.8 系：reasoning_effort 是主路径；thinking_budget 与 effort 互斥
            //（同发报错），仅在未配置 effort 时作为兜底发送。
            if let Some(budget) = config.thinking_budget.filter(|_| qwen38_effort.is_none()) {
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
            // field for pre-3.8 models and strict gateways may reject it.
            // （Qwen3.8 系的官方档位 effort 在下方重新注入。）
            body.remove("reasoning_effort");
        } else if let Some(effort) = get_trimmed_effort(config) {
            if !effort.eq_ignore_ascii_case("none") && !effort.eq_ignore_ascii_case("unset") {
                body.insert("reasoning_effort".to_string(), json!(effort.to_lowercase()));
            }
        }

        if is_qwen38 {
            if let Some(effort) = qwen38_effort {
                body.insert("reasoning_effort".to_string(), json!(effort));
                body.remove("thinking_budget");
            } else if is_qwen38_omni {
                // omni 未配置 effort 且未显式关闭：文档默认 xhigh。
                body.insert("reasoning_effort".to_string(), json!("xhigh"));
                body.remove("thinking_budget");
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

    #[test]
    fn test_qwen38_effort_primary_and_budget_fallback() {
        // 2026-10 千问AI平台官方文档：Qwen3.8 系走顶层 reasoning_effort 档位；
        // effort 与 thinking_budget 互斥，budget 仅在未配置 effort 时兜底。
        let adapter = QwenAdapter;
        let config = ApiConfig {
            model: "qwen3.8-max".to_string(),
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("high".to_string()),
            thinking_budget: Some(16384),
            ..Default::default()
        };
        let mut body = Map::new();
        adapter.apply_reasoning_config(&mut body, &config, None);
        assert_eq!(body.get("enable_thinking"), Some(&json!(true)));
        assert_eq!(body.get("reasoning_effort"), Some(&json!("xhigh")));
        assert!(!body.contains_key("thinking_budget"));
    }

    #[test]
    fn test_qwen38_budget_fallback_without_effort() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            model: "qwen3.8-max".to_string(),
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            thinking_budget: Some(16384),
            ..Default::default()
        };
        let mut body = Map::new();
        adapter.apply_reasoning_config(&mut body, &config, None);
        assert_eq!(body.get("thinking_budget"), Some(&json!(16384)));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_qwen38_omni_none_disables_via_effort() {
        let adapter = QwenAdapter;
        let config = ApiConfig {
            model: "qwen3.8-omni-flash".to_string(),
            provider_type: Some("qwen".to_string()),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("none".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();
        adapter.apply_reasoning_config(&mut body, &config, None);
        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
        assert!(!body.contains_key("thinking_budget"));
    }

    #[test]
    fn test_qwen38_vendor_prefix_and_legacy_qwen3_8b_untouched() {
        let adapter = QwenAdapter;
        // vendor 前缀形态识别
        let config = ApiConfig {
            model: "Qwen/qwen3.8-flash".to_string(),
            provider_type: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("medium".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();
        adapter.apply_reasoning_config(&mut body, &config, None);
        assert_eq!(body.get("reasoning_effort"), Some(&json!("medium")));

        // Qwen3-8B（开源 8B）不属于 3.8 系：仍删除 effort、走 budget 方言
        let config2 = ApiConfig {
            model: "Qwen/Qwen3-8B".to_string(),
            provider_type: Some("siliconflow".to_string()),
            base_url: "https://api.siliconflow.cn/v1".to_string(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("high".to_string()),
            thinking_budget: Some(4096),
            ..Default::default()
        };
        let mut body2 = Map::new();
        adapter.apply_reasoning_config(&mut body2, &config2, None);
        assert!(!body2.contains_key("reasoning_effort"));
        assert_eq!(body2.get("thinking_budget"), Some(&json!(4096)));
    }

}
