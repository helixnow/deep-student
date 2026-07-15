//! Mistral 专用适配器
//!
//! Mistral 系列模型的特殊参数处理（2026-07 现状）。
//!
//! ## 模型列表
//! - `mistral-large-latest` → Mistral Large 3 - 旗舰模型，标准 OpenAI 兼容
//! - `mistral-medium-latest` → Mistral Medium 3.5 - 支持 `reasoning_effort`
//! - `mistral-small-latest` → Mistral Small 4 - hybrid 推理，支持 `reasoning_effort`
//! - `codestral-*` - 代码专用模型
//! - `magistral-small/medium-latest` - 遗留推理模型线（已被 Medium 3.5 / Small 4 取代）
//!
//! ## 现行推理控制（Medium 3.5 / Small 4，研报 04 §3.3）
//! ```json
//! {
//!   "reasoning_effort": "none" | "low" | "medium" | "high"
//! }
//! ```
//! 开推理后 `message.content` / `delta.content` 会变成 ThinkChunk/TextChunk 块数组
//! （流解析兼容属 providers 层职责）。
//!
//! ## 遗留 Magistral 系列（prompt_mode）
//! 仅 legacy magistral 模型保留 `prompt_mode` 参数：
//! ```json
//! {
//!   "prompt_mode": "reasoning"  // 默认，启用推理系统提示
//!   // 或设置为 null 禁用推理
//! }
//! ```
//!
//! ## 注意事项
//! - `prompt_mode` 仅对 magistral 模型发送，不透传给现行 Medium/Small 线
//! - 保留 temperature/top_p 采样参数
//!
//! 参考文档：https://docs.mistral.ai/capabilities/reasoning

use super::{get_trimmed_effort, resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// Mistral 专用适配器
///
/// - Medium 3.5 / Small 4：透传 `reasoning_effort`（none/low/medium/high）
/// - 遗留 Magistral 系列：根据 enable_thinking 决定是否设置 `prompt_mode: "reasoning"`
/// - 其他模型：标准 OpenAI 兼容格式
pub struct MistralAdapter;

impl MistralAdapter {
    /// 检查是否是遗留 Magistral 系列（独立推理模型线，已被 Medium 3.5 / Small 4 取代）
    fn is_magistral(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("magistral")
    }

    /// Medium 3.5 / Small 4 系列支持 `reasoning_effort`（研报 04 §3.3）。
    /// `mistral-medium-latest` 现指向 Medium 3.5、`mistral-small-latest` 指向 Small 4，
    /// 版本化 ID 如 `mistral-medium-3-5` / `mistral-small-4` 同样命中。
    fn supports_reasoning_effort(model: &str) -> bool {
        if Self::is_magistral(model) {
            return false;
        }
        let model_lower = model.to_lowercase();
        model_lower.contains("mistral-medium") || model_lower.contains("mistral-small")
    }
}

impl RequestAdapter for MistralAdapter {
    fn id(&self) -> &'static str {
        "mistral"
    }

    fn label(&self) -> &'static str {
        "Mistral AI"
    }

    fn description(&self) -> &'static str {
        "Mistral 系列，Medium 3.5/Small 4 支持 reasoning_effort，Magistral 遗留 prompt_mode"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // 现行推理控制：Medium 3.5 / Small 4 的 reasoning_effort 透传
        if Self::supports_reasoning_effort(&config.model) {
            let requested_effort = if enable_thinking == Some(false) {
                Some("none")
            } else {
                get_trimmed_effort(config)
            };
            if let Some(effort) = requested_effort {
                // Mistral 取值 none / low / medium / high；归一化超集取值
                let normalized = match effort.to_lowercase().as_str() {
                    "none" => "none",
                    "minimal" | "low" => "low",
                    "medium" => "medium",
                    "high" | "xhigh" | "max" => "high",
                    _ => "low",
                };
                body.insert("reasoning_effort".to_string(), json!(normalized));
            }
        }

        // prompt_mode 仅遗留 Magistral 系列保留
        // 根据 enable_thinking 决定是否设置 prompt_mode
        if Self::is_magistral(&config.model) {
            let should_enable = resolve_enable_thinking(config, enable_thinking);
            if should_enable {
                // 启用推理模式（显式设置以确保行为一致）
                body.insert("prompt_mode".to_string(), json!("reasoning"));
            } else {
                // 显式禁用推理模式（API 默认是 "reasoning"，必须显式设置 null 才能禁用）
                body.insert("prompt_mode".to_string(), Value::Null);
            }
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // Mistral 支持 temperature/top_p，不移除采样参数
        false
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // Mistral 支持标准的采样参数
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("repetition_penalty".to_string(), json!(rep_penalty));
        }
        // Mistral 不使用 reasoning_split, verbosity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_magistral_prompt_mode() {
        let adapter = MistralAdapter;
        // 启用思考时设置 prompt_mode: "reasoning"
        let config = ApiConfig {
            model: "magistral-medium-latest".to_string(),
            enable_thinking: Some(true),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("prompt_mode"), Some(&json!("reasoning")));

        // 未启用思考（默认配置）时显式置 null 以禁用 API 默认的 reasoning
        let config_off = ApiConfig {
            model: "magistral-medium-latest".to_string(),
            ..Default::default()
        };
        let mut body_off = Map::new();
        adapter.apply_reasoning_config(&mut body_off, &config_off, None);
        assert_eq!(body_off.get("prompt_mode"), Some(&Value::Null));
    }

    #[test]
    fn test_magistral_with_prefix() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral/magistral-medium-latest".to_string(),
            enable_thinking: Some(true),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("prompt_mode"), Some(&json!("reasoning")));
    }

    #[test]
    fn test_magistral_no_reasoning_effort() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "magistral-medium-latest".to_string(),
            enable_thinking: Some(true),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 遗留 Magistral 走 prompt_mode，不发送 reasoning_effort
        assert!(!body.contains_key("reasoning_effort"));
        assert_eq!(body.get("prompt_mode"), Some(&json!("reasoning")));
    }

    #[test]
    fn test_medium_latest_reasoning_effort() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-medium-latest".to_string(),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Medium 3.5 透传 reasoning_effort，且不发送 prompt_mode
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
        assert!(!body.contains_key("prompt_mode"));
    }

    #[test]
    fn test_small_4_reasoning_effort() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-small-4".to_string(),
            reasoning_effort: Some("none".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Small 4 支持 none（关闭推理，content 保持纯字符串）
        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
    }

    #[test]
    fn test_runtime_disable_maps_effort_models_to_none() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-medium-latest".to_string(),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
    }

    #[test]
    fn test_versioned_medium_35_reasoning_effort() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-medium-3-5".to_string(),
            reasoning_effort: Some("medium".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("medium")));
    }

    #[test]
    fn test_effort_normalization_superset_values() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-medium-latest".to_string(),
            reasoning_effort: Some("xhigh".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Mistral 无 xhigh 档，归一化为 high
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_mistral_large_no_reasoning_params() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-large-latest".to_string(),
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Large 3 非推理模型：不添加 prompt_mode，也不透传 reasoning_effort
        assert!(!body.contains_key("prompt_mode"));
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_codestral_no_prompt_mode() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "codestral-latest".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Codestral 不添加 prompt_mode
        assert!(!body.contains_key("prompt_mode"));
    }

    #[test]
    fn test_mistral_keeps_sampling_params() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-large-latest".to_string(),
            is_reasoning: true,
            ..Default::default()
        };

        // Mistral 即使在推理模式也保留采样参数
        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_mistral_common_params() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-large-latest".to_string(),
            min_p: Some(0.1),
            top_k: Some(50),
            repetition_penalty: Some(1.1),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        // f32 经 serde_json 提升为 f64 带精度尾数，按相同方式构造期望值
        assert_eq!(body.get("min_p"), Some(&json!(0.1f32 as f64)));
        assert_eq!(body.get("top_k"), Some(&json!(50)));
        assert_eq!(body.get("repetition_penalty"), Some(&json!(1.1f32 as f64)));
    }
}
