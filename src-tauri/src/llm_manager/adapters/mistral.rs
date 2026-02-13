//! Mistral 专用适配器
//!
//! Mistral 系列模型的特殊参数处理。
//!
//! ## 模型列表
//! - `mistral-large-latest` - 旗舰模型，标准 OpenAI 兼容
//! - `codestral-latest` - 代码专用模型
//! - `magistral-small-latest` - 轻量推理模型
//! - `magistral-medium-latest` - 标准推理模型
//!
//! ## Magistral 系列（推理模型）
//! Magistral 系列使用特殊的 `prompt_mode` 参数：
//! ```json
//! {
//!   "prompt_mode": "reasoning"  // 默认，启用推理系统提示
//!   // 或设置为 null 禁用推理
//! }
//! ```
//!
//! ## 注意事项
//! - `prompt_mode: "reasoning"` 是 Magistral 的默认行为
//! - 可通过 `enable_thinking: false` 禁用推理模式（不设置 prompt_mode）
//! - 其他 Mistral 模型使用标准 OpenAI 兼容格式
//! - 保留 temperature/top_p 采样参数
//!
//! 参考文档：https://docs.mistral.ai/

use super::{resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// Mistral 专用适配器
///
/// 处理 Mistral 系列模型的特殊参数：
/// - Magistral 系列：根据 enable_thinking 决定是否设置 `prompt_mode: "reasoning"`
/// - 其他模型：标准 OpenAI 兼容格式
pub struct MistralAdapter;

impl MistralAdapter {
    /// 检查是否是 Magistral 系列（推理模型）
    ///
    /// Magistral 系列模型名称包含 "magistral"
    fn is_magistral(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("magistral")
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
        "Mistral 系列，Magistral 支持 prompt_mode: reasoning"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // prompt_mode 仅 Magistral 系列支持
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
        // Mistral 不使用 reasoning_split, effort, verbosity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_magistral_prompt_mode() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "magistral-medium-latest".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("prompt_mode"), Some(&json!("reasoning")));
    }

    #[test]
    fn test_magistral_with_prefix() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral/magistral-medium-latest".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("prompt_mode"), Some(&json!("reasoning")));
    }

    #[test]
    fn test_mistral_large_no_prompt_mode() {
        let adapter = MistralAdapter;
        let config = ApiConfig {
            model: "mistral-large-latest".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非 Magistral 模型不添加 prompt_mode
        assert!(!body.contains_key("prompt_mode"));
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

        assert_eq!(body.get("min_p"), Some(&json!(0.1)));
        assert_eq!(body.get("top_k"), Some(&json!(50)));
        assert_eq!(body.get("repetition_penalty"), Some(&json!(1.1)));
    }
}
