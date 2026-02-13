//! MiniMax 专用适配器
//!
//! MiniMax API 有其特定的参数格式和限制：
//! - **不支持** `enable_thinking` 参数
//! - **支持** `reasoning_split` 参数控制思维链分离
//! - **支持** temperature、top_p 等采样参数（即使是推理模型）
//!
//! 参考文档：https://platform.minimax.io/docs/api-reference/text-post

use super::{PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// MiniMax 专用适配器
///
/// MiniMax M2 系列模型的特殊处理：
/// - 不发送 `enable_thinking`（API 不支持）
/// - 保留采样参数（temperature, top_p）
/// - 使用 `reasoning_split` 控制思维链分离
pub struct MiniMaxAdapter;

impl RequestAdapter for MiniMaxAdapter {
    fn id(&self) -> &'static str {
        "minimax"
    }

    fn label(&self) -> &'static str {
        "MiniMax"
    }

    fn description(&self) -> &'static str {
        "MiniMax 系列，支持 reasoning_split 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        _enable_thinking: Option<bool>,
    ) -> bool {
        // MiniMax 特性：
        // 1. 不发送 enable_thinking（API 不支持，必须移除！）
        // 2. 不移除 temperature/top_p（MiniMax 支持这些参数）
        // 3. 使用 reasoning_split 控制思维链分离

        // ⚠️ 关键：MiniMax API 不支持这些参数，必须移除
        body.remove("enable_thinking");
        body.remove("thinking_budget");
        body.remove("include_thoughts");
        body.remove("thinking");

        // reasoning_split 会在 apply_common_params 中处理

        true // 提前返回，阻止后续代码添加 enable_thinking
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // MiniMax 支持采样参数，不移除
        false
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // MiniMax 特定参数
        if let Some(reasoning_split) = config.reasoning_split {
            body.insert("reasoning_split".to_string(), json!(reasoning_split));
        }

        // 通用参数（MiniMax 也支持部分通用参数）
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("repetition_penalty".to_string(), json!(rep_penalty));
        }
        // MiniMax 不使用 effort/verbosity 参数
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // MiniMax M2 系列使用 reasoning_details 格式
        if config.is_reasoning {
            PassbackPolicy::ReasoningDetails
        } else {
            PassbackPolicy::NoPassback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_config() -> ApiConfig {
        ApiConfig {
            supports_reasoning: true,
            is_reasoning: true,
            thinking_enabled: true,
            reasoning_split: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn test_no_enable_thinking() {
        let adapter = MiniMaxAdapter;
        let config = create_test_config();
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // MiniMax 不应该添加 enable_thinking
        assert!(!body.contains_key("enable_thinking"));
    }

    #[test]
    fn test_keep_sampling_params() {
        let adapter = MiniMaxAdapter;
        let config = create_test_config();
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(1.0));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // MiniMax 应该保留 temperature 和 top_p
        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
    }

    #[test]
    fn test_reasoning_split() {
        let adapter = MiniMaxAdapter;
        let config = create_test_config();
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        assert_eq!(body.get("reasoning_split"), Some(&json!(true)));
    }
}
