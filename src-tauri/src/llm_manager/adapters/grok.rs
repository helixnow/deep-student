//! xAI Grok 专用适配器
//!
//! Grok 系列有特殊的参数限制：
//!
//! ## 重要限制
//! - `reasoning_effort` **仅 grok-3-mini 支持**
//! - Grok-4 **不支持** presencePenalty, frequencyPenalty, stop
//!
//! ## 模型
//! - grok-4-1-fast-reasoning: 工具调用优化，2M 上下文
//! - grok-3: 文本模型
//! - grok-3-mini: 唯一支持 reasoning_effort 的模型
//!
//! ## 推理参数格式
//! ```json
//! {
//!   "reasoning_effort": "low" | "high"  // 仅 grok-3-mini
//! }
//! ```
//!
//! 参考文档：https://docs.x.ai/

use super::{get_trimmed_effort, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// xAI Grok 专用适配器
///
/// Grok 模型的特殊处理：
/// - reasoning_effort 仅 grok-3-mini 支持
/// - Grok-4 不支持某些参数
pub struct GrokAdapter;

impl GrokAdapter {
    /// 检查是否是 Grok-3-Mini（唯一支持 reasoning_effort 的模型）
    fn is_grok3_mini(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("grok-3-mini") || model_lower.contains("grok3-mini")
    }

    /// 检查是否是 Grok-4 系列（不支持某些参数）
    fn is_grok4(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("grok-4") || model_lower.contains("grok4")
    }
}

impl RequestAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn label(&self) -> &'static str {
        "xAI Grok"
    }

    fn description(&self) -> &'static str {
        "Grok 系列，grok-3-mini 支持 reasoning_effort"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        _enable_thinking: Option<bool>,
    ) -> bool {
        // reasoning_effort 仅 grok-3-mini 支持
        if Self::is_grok3_mini(&config.model) {
            if let Some(effort) = get_trimmed_effort(config) {
                // Grok-3-Mini 只支持 low 和 high
                let normalized = match effort.to_lowercase().as_str() {
                    "high" | "xhigh" | "medium" => "high",
                    _ => "low",
                };
                body.insert("reasoning_effort".to_string(), json!(normalized));
            }
        }

        // Grok-4 不支持 presencePenalty, frequencyPenalty, stop
        if Self::is_grok4(&config.model) {
            body.remove("presence_penalty");
            body.remove("frequency_penalty");
            body.remove("presencePenalty");
            body.remove("frequencyPenalty");
            body.remove("stop");
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // Grok 支持 temperature/top_p
        false
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // Grok-4 不支持 repetition_penalty（通过 frequency/presence_penalty 实现）
        if !Self::is_grok4(&config.model) {
            if let Some(min_p) = config.min_p {
                body.insert("min_p".to_string(), json!(min_p));
            }
            if let Some(top_k) = config.top_k {
                body.insert("top_k".to_string(), json!(top_k));
            }
            if let Some(rep_penalty) = config.repetition_penalty {
                body.insert("repetition_penalty".to_string(), json!(rep_penalty));
            }
        }
        // Grok 不使用 reasoning_split, effort, verbosity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_grok3_mini_reasoning_effort() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "grok-3-mini".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_grok3_no_reasoning_effort() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "grok-3".to_string(), // 非 mini
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // grok-3 不支持 reasoning_effort
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_grok4_removes_unsupported_params() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            model: "grok-4-1-fast-reasoning".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("stop".to_string(), json!(["END"]));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Grok-4 不支持这些参数
        assert!(!body.contains_key("presence_penalty"));
        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("stop"));
    }
}
