//! Xiaomi MiMo 专用适配器
//!
//! MiMo OpenAI-compatible API 使用 `thinking: {"type": "enabled" | "disabled"}`
//! 控制思维模式，并通过 `reasoning_content` 返回思维链。

use super::{resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

pub struct MimoAdapter;

impl MimoAdapter {
    fn supports_thinking(config: &ApiConfig) -> bool {
        let model = config.model.to_lowercase();
        !model.contains("tts") && (config.supports_reasoning || config.is_reasoning)
    }
}

impl RequestAdapter for MimoAdapter {
    fn id(&self) -> &'static str {
        "mimo"
    }

    fn label(&self) -> &'static str {
        "Xiaomi MiMo"
    }

    fn description(&self) -> &'static str {
        "MiMo 系列，支持 thinking.type 与 reasoning_content"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        body.remove("enable_thinking");
        body.remove("thinking_budget");
        body.remove("include_thoughts");
        body.remove("reasoning_effort");

        if Self::supports_thinking(config) {
            let thinking_enabled = resolve_enable_thinking(config, enable_thinking);
            let thinking_type = if thinking_enabled {
                "enabled"
            } else {
                "disabled"
            };
            body.insert("thinking".to_string(), json!({ "type": thinking_type }));
        } else {
            body.remove("thinking");
        }

        if let Some(choice) = body.get("tool_choice").and_then(|value| value.as_str()) {
            if choice != "auto" {
                body.insert("tool_choice".to_string(), json!("auto"));
            }
        }

        true
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        if Self::supports_thinking(config) {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }
}
